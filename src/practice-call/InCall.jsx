import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Captions, CaptionsOff, ListChecks, MessageSquare, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff, X } from 'lucide-react';
import ChatPanel from './ChatPanel.jsx';
import Avatar from './Avatar.jsx';
import SharedScreen from './SharedScreen.jsx';
import CodingPad from './CodingPad.jsx';
import { clampScreen } from './screenMarkup.js';
import { firstNameOf, participantsOf, roleLine } from './persona.js';
import { playJoinChime, playLeaveChime } from './ringtone.js';
import { formatTime } from './replayModel.js';
import { shouldTogglePause } from './pauseKey.js';

// Meeting-style controls: a round neutral button, red when the device is off,
// light blue when a view (captions, a side panel) is switched on.
const roundClass = tone => `grid h-10 w-10 place-items-center rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8] ${
  tone === 'off' ? 'bg-[#ea4335] text-white hover:bg-[#ec5345]'
    : tone === 'active' ? 'bg-[#8ab4f8] text-[#202124] hover:bg-[#93bbf9]'
      : 'bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4e51]'}`;
const flatClass = active => `grid h-10 w-10 place-items-center rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#8ab4f8] ${active ? 'bg-[#8ab4f8]/20 text-[#8ab4f8]' : 'text-[#e8eaed] hover:bg-white/10'}`;

const TOAST_MS = 4000;
// How long a tile that just left takes to fade out before it is removed (matches .pc-leave).
const LEAVE_MS = 300;

function SpeakingBadge({ small = false }) {
  return <span aria-hidden="true" className={`pc-bars absolute flex items-center justify-center gap-[3px] rounded-full bg-[#1a73e8] ${small ? 'right-2 top-2 h-5 w-5' : 'right-3 top-3 h-7 w-7'}`}><i /><i /><i /></span>;
}

// Tile grid per head count. Classes are literal strings so Tailwind keeps them.
// 4 is a 2 by 2 block; 5 is three over two on a six-column grid so the bottom
// pair sits centred; 3 wraps 2+1 only while a side panel narrows the area.
function tileLayout(count, panelOpen) {
  const none = () => '';
  if (count <= 1) return { grid: 'grid-cols-1 grid-rows-1', tile: none, avatar: 'h-28 w-28 text-4xl' };
  if (count === 2) return { grid: 'grid-cols-2 grid-rows-1', tile: none, avatar: 'h-20 w-20 text-3xl' };
  if (count === 3) {
    return panelOpen
      ? { grid: 'grid-cols-2 grid-rows-2', tile: index => (index === 2 ? 'col-span-2' : ''), avatar: 'h-16 w-16 text-2xl' }
      : { grid: 'grid-cols-3 grid-rows-1', tile: none, avatar: 'h-16 w-16 text-2xl' };
  }
  if (count === 4) return { grid: 'grid-cols-2 grid-rows-2', tile: none, avatar: panelOpen ? 'h-12 w-12 text-lg' : 'h-14 w-14 text-xl' };
  const avatar = panelOpen ? 'h-12 w-12 text-lg' : 'h-14 w-14 text-xl';
  if (count === 5) {
    const spans = ['col-span-2', 'col-span-2', 'col-span-2', 'col-span-2 col-start-2', 'col-span-2 col-start-4'];
    return { grid: 'grid-cols-6 grid-rows-2', tile: index => spans[index] || '', avatar };
  }
  return { grid: 'grid-cols-3 grid-rows-2', tile: none, avatar };
}

export default function InCall({ state, api }) {
  const [captionsOn, setCaptionsOn] = useState(false);
  // One side panel at a time, as in a meeting window: 'chat', 'cards' or none.
  const [panel, setPanel] = useState(null);
  const [chatDraft, setChatDraft] = useState('');
  const [cards, setCards] = useState([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const stopCamera = useCallback(() => {
    try { streamRef.current?.getTracks?.().forEach(track => track.stop?.()); } catch { /* tracks already ended */ }
    streamRef.current = null;
    if (videoRef.current) { try { videoRef.current.srcObject = null; } catch { /* element detached */ } }
  }, []);
  // A camera permission prompt can outlast this screen (the call ends while it
  // is open) or a second click; a stream that arrives then must be released.
  const mountedRef = useRef(true);
  const cameraRequestRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; cameraRequestRef.current += 1; stopCamera(); };
  }, [stopCamera]);
  // The <video> only exists while the camera is on, so attach the stream once
  // the element mounts rather than before the re-render.
  useEffect(() => {
    if (!cameraOn || !streamRef.current || !videoRef.current) return;
    try { videoRef.current.srcObject = streamRef.current; } catch { /* element detached */ }
  }, [cameraOn]);

  const toggleCamera = async () => {
    if (cameraOn) { stopCamera(); setCameraOn(false); return; }
    const getUserMedia = typeof navigator !== 'undefined' ? navigator.mediaDevices?.getUserMedia : null;
    if (typeof getUserMedia !== 'function') { setCameraError('Camera is unavailable in this window.'); return; }
    const request = cameraRequestRef.current + 1;
    cameraRequestRef.current = request;
    const current = () => mountedRef.current && cameraRequestRef.current === request;
    try {
      // Video only: the call microphone never goes through getUserMedia.
      const stream = await getUserMedia.call(navigator.mediaDevices, { video: true });
      if (!current()) {
        try { stream?.getTracks?.().forEach(track => track.stop?.()); } catch { /* tracks already ended */ }
        return;
      }
      stopCamera();
      streamRef.current = stream;
      setCameraOn(true); setCameraError(null);
    } catch { if (current()) setCameraError('Camera permission was denied. The call continues without video.'); }
  };
  const toggleCards = async () => {
    if (panel === 'cards') { setPanel(null); return; }
    setPanel('cards');
    if (typeof api?.getPreparedCards !== 'function') return;
    try { const result = await api.getPreparedCards(); setCards(Array.isArray(result) ? result : []); } catch { setCards([]); }
  };
  // The red button ends the call at once, as in any call app. Whether to write feedback is asked on the screen after it.
  const leave = () => {
    stopCamera();
    if (typeof api?.leave === 'function') api.leave();
  };
  const participants = participantsOf(state);
  const panelCall = participants.length > 1;
  // Someone who appears after the call began gets the rise animation, a toast and a chime.
  const [seenIds, setSeenIds] = useState(() => participants.map(item => item.id));
  const [freshIds, setFreshIds] = useState([]);
  const [joinToast, setJoinToast] = useState(null);
  const newcomers = participants.filter(item => !seenIds.includes(item.id));
  if (newcomers.length) {
    setSeenIds([...seenIds, ...newcomers.map(item => item.id)]);
    setFreshIds([...freshIds, ...newcomers.map(item => item.id)]);
    setJoinToast({ key: newcomers[0].id, name: newcomers[0].name || 'Someone' });
  }
  useEffect(() => {
    if (!joinToast) return undefined;
    playJoinChime(typeof window === 'undefined' ? null : window);
    const timer = setTimeout(() => setJoinToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [joinToast]);
  const muted = !!state?.muted;
  const paused = !!state?.paused;
  // The key listener is installed once; this ref lets it see the current pause state and bridge.
  const pauseRef = useRef({ paused, setPaused: api?.setPaused });
  useEffect(() => { pauseRef.current = { paused, setPaused: api?.setPaused }; });
  useEffect(() => {
    const onKeyDown = event => {
      const decision = shouldTogglePause(event);
      if (decision.preventDefault) event.preventDefault();
      if (!decision.toggle) return;
      const { paused: now, setPaused } = pauseRef.current;
      if (typeof setPaused === 'function') setPaused(!now);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const captions = Array.isArray(state?.captions) ? state.captions : [];
  const interviewerLeft = !!state?.interviewerLeft;
  // The other side dropped out instead of saying goodbye.
  const connectionLost = interviewerLeft && !!state?.connectionLost;
  const chatOpen = panel === 'chat';
  // The service names who is speaking; without it the lead's tile follows the plain speaking flag.
  // A panel call names who is speaking. A solo call never does (speakingId stays null), so its one tile follows the plain flag.
  // A colleague heard over the speaker rings at the same time as the main speaker.
  const isSpeaking = (item, index) => !interviewerLeft && ((typeof state?.overSpeakingId === 'string' && item.id === state.overSpeakingId) || (panelCall || typeof state?.speakingId === 'string' ? item.id === state?.speakingId : index === 0 && state?.speaking === 'interviewer'));
  const leadName = participants[0]?.name || 'Interviewer';
  // Someone who left is taken off the stage: their tile fades out for LEAVE_MS, then is gone.
  const isGone = item => interviewerLeft || item.status === 'left';
  const goneKey = participants.filter(isGone).map(item => item.id).join('\u0000');
  const [knownGoneKey, setKnownGoneKey] = useState(goneKey);
  const [leavingIds, setLeavingIds] = useState([]);
  if (knownGoneKey !== goneKey) {
    const before = knownGoneKey ? knownGoneKey.split('\u0000') : [];
    const fresh = goneKey ? goneKey.split('\u0000').filter(id => !before.includes(id)) : [];
    setKnownGoneKey(goneKey);
    setLeavingIds(fresh.length ? [...leavingIds, ...fresh] : leavingIds.filter(id => goneKey.split('\u0000').includes(id)));
  }
  // One soft chime each time someone leaves (a dropped line takes everyone at once: one chime).
  useEffect(() => {
    if (leavingIds.length) playLeaveChime(typeof window === 'undefined' ? null : window);
  }, [leavingIds]);
  useEffect(() => {
    if (!leavingIds.length) return undefined;
    const timer = setTimeout(() => setLeavingIds([]), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leavingIds]);
  const shown = participants.filter(item => !isGone(item) || leavingIds.includes(item.id));
  // Nobody left to look at: the candidate's own tile takes the whole stage.
  const alone = participants.length > 0 && participants.every(isGone);
  const captionLabel = caption => {
    if (caption.speaker === 'candidate') return 'You';
    const who = caption.speakerId ? participants.find(item => item.id === caption.speakerId) : null;
    return firstNameOf(who) || (panelCall ? '' : firstNameOf(participants[0])) || 'Interviewer';
  };
  const sidePanelOpen = panel !== null;
  const layout = tileLayout(shown.length, sidePanelOpen);
  // Interviewer messages that arrive while the panel is closed leave a dot on the chat button.
  const chat = Array.isArray(state?.chat) ? state.chat : [];
  const [seenChat, setSeenChat] = useState(0);
  if (chatOpen && seenChat !== chat.length) setSeenChat(chat.length);
  const unreadChat = !chatOpen && chat.slice(seenChat).some(message => message?.from !== 'candidate');
  const notice = state?.notice?.message || null;
  // The AI decides what to present; the window only shows what the service reports.
  const screen = state?.screen && typeof state.screen === 'object' ? { ...clampScreen(state.screen), speakerId: state.screen.speakerId, presenterName: state.screen.presenterName } : null;
  const pad = state?.pad && typeof state.pad === 'object' ? state.pad : null;
  const padOpen = pad?.open === true;
  // While the interviewer is still setting a share up on their side, nothing shows here, as on a
  // real call: the layout changes only when the content arrives. state.sharing is not displayed.
  const presenting = !!screen || padOpen;
  const presenterIndex = screen ? Math.max(0, participants.findIndex(item => item.id === screen.speakerId)) : -1;
  const presenterName = screen ? (screen.presenterName || participants[presenterIndex]?.name || leadName) : '';
  // With the chat panel open and four or more interviewers the bar runs out of room (seen in the
  // built app: five named chips left one letter of "… is presenting"). The chips then show the
  // picture only, with the name on hover, so the line that says who is presenting stays readable.
  const tightBar = sidePanelOpen && shown.length >= 4;
  const renderTile = (item, index, compact) => {
    const gone = isGone(item);
    const speaking = !gone && isSpeaking(item, index);
    const position = shown.indexOf(item);
    const name = item.name || 'Interviewer';
    const presentingNow = index === presenterIndex;
    // While something is shared, the question and the code are what the candidate needs to see.
    // The interviewers have no video, so each shrinks to a chip in the bar above the stage:
    // picture, first name, and the blue ring when they speak.
    if (compact) {
      return <section key={item.id || index} aria-label={name} title={name} data-speaking={speaking ? 'true' : 'false'} data-presenting={presentingNow ? 'true' : undefined} data-chip="true" data-chip-tight={tightBar ? 'true' : undefined}
        className={`${gone ? 'pc-leave ' : freshIds.includes(item.id) ? 'pc-rise ' : ''}flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#3c4043] pl-1 outline outline-2 -outline-offset-2 transition-[outline-color] duration-200 ${tightBar ? 'pr-1' : 'pr-3'} ${speaking ? 'outline-[#8ab4f8]' : 'outline-transparent'}`}>
        <Avatar person={item} className="h-6 w-6 shrink-0 text-[11px]" />
        <p className={tightBar ? 'sr-only' : 'text-xs font-medium text-white'}>{firstNameOf(item) || name}{speaking && <span className="sr-only"> speaking</span>}</p>
      </section>;
    }
    // In the grid the candidate's own picture floats over the bottom right corner, so with three
    // or more tiles the last tile carries its name at the top instead of under that picture.
    const labelTop = !compact && shown.length >= 3 && position === shown.length - 1;
    return <section key={item.id || index} aria-label={name} data-speaking={speaking ? 'true' : 'false'} data-presenting={presentingNow ? 'true' : undefined}
      className={`${gone ? 'pc-leave ' : freshIds.includes(item.id) ? 'pc-rise ' : ''}relative grid min-h-0 place-items-center overflow-hidden rounded-xl bg-[#3c4043] outline outline-[3px] -outline-offset-[3px] transition-[outline-color] duration-200 ${compact ? 'min-w-0 flex-1 basis-0 md:max-h-32' : layout.tile(position)} ${speaking ? 'outline-[#8ab4f8]' : 'outline-transparent'}`}>
      <Avatar person={item} className={`${compact ? 'h-10 w-10 text-sm' : layout.avatar} transition-[box-shadow,opacity] duration-300 ${speaking ? 'shadow-[0_0_0_10px_rgba(138,180,248,0.18)]' : ''}`} />
      {speaking && <SpeakingBadge small={compact} />}
      <p data-label-top={labelTop ? 'true' : undefined} className={`absolute truncate font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] ${compact ? 'bottom-1.5 left-2 right-2 text-xs' : labelTop ? 'left-4 right-14 top-3 text-sm' : 'bottom-3 left-4 right-4 text-sm'}`}>{name}{speaking && <span className="sr-only"> speaking</span>}{item.role && !compact && <span className="block truncate text-xs font-normal text-[#e8eaed]/80">{item.role}</span>}</p>
    </section>;
  };
  const cardsOpen = panel === 'cards';
  return <main className="flex h-screen flex-col bg-[#202124] text-[#e8eaed]" aria-label="Call in progress">
    <div className="flex min-h-0 flex-1 gap-4 px-4 pt-4">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="relative min-h-0 flex-1">
          {presenting
            ? <div data-layout="presenting" className="flex h-full min-h-0 flex-col gap-2">
              {/* Google Meet was the starting point (a bar that names the presenter, content on the
                  main stage). This window has one purpose, so it goes further: no tile strip, the
                  people on the call sit in the same bar, and the question and the code share the
                  whole width side by side. */}
              <div className="flex h-9 shrink-0 items-center gap-2">
                {screen
                  ? <p data-presenting-banner="true" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[#3c4043] px-3 text-sm text-[#e8eaed]">
                    <MonitorUp size={14} className="shrink-0" aria-hidden="true" /><span className="truncate">{`${presenterName} is presenting`}</span>
                  </p>
                  : <span className="min-w-0 flex-1" />}
                <div data-strip="true" data-tiles={shown.length} className="flex shrink-0 items-center gap-1.5">
                  {participants.map((item, index) => (shown.includes(item) ? renderTile(item, index, true) : null))}
                </div>
                {!cameraOn && <p data-chip="you" aria-hidden="true" className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#3c4043] pl-1 text-xs font-medium text-white ${tightBar && !muted ? 'pr-1' : 'pr-3'}`}>
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-[#00796b] text-[9px]">You</span>{muted ? <MicOff size={12} /> : tightBar ? null : 'You'}
                </p>}
              </div>
              <div data-stage="true" className={`flex min-h-0 min-w-0 flex-1 flex-col gap-3 ${sidePanelOpen ? 'xl:flex-row' : 'md:flex-row'}`}>
                {screen && <SharedScreen key="screen" title={screen.title} content={screen.content} className="min-h-0 min-w-0 flex-1 basis-0" />}
                {padOpen && <CodingPad key="pad" lang={pad.lang || ''} initialText={pad.text || ''} disabled={interviewerLeft}
                  onChange={api?.updatePad} className="min-h-0 min-w-0 flex-1 basis-0" />}
              </div>
            </div>
            : <div data-layout="grid" data-tiles={shown.length} className={`grid h-full gap-3 ${layout.grid}`}>
              {participants.map((item, index) => (shown.includes(item) ? renderTile(item, index, false) : null))}
            </div>}
          {interviewerLeft && <p role="status" aria-label={panelCall ? 'Everyone left' : `${leadName} left`} className="pc-rise absolute bottom-16 left-4 z-20 rounded-lg bg-[#202124]/90 px-4 py-2.5 text-sm text-white shadow-lg">{connectionLost
            ? (panelCall ? "Everyone else lost their connection. You're the only one here." : `${leadName} lost their connection. You're the only one here.`)
            : (panelCall ? "Everyone left the call. You're the only one here." : `${leadName} left the call. You're the only one here.`)}</p>}
          {joinToast && <p key={joinToast.key} role="status" aria-label="Participant joined" data-testid="join-toast" className="pc-rise absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-[#202124]/90 px-4 py-2 text-sm text-white shadow-lg">{joinToast.name} joined</p>}
          <section aria-label="Your camera" data-camera={cameraOn ? 'on' : 'off'} data-self={alone && !presenting ? 'full' : 'corner'}
            className={`absolute z-10 grid place-items-center ${presenting ? (cameraOn ? 'bottom-2 right-2 aspect-video w-32' : 'hidden') : alone ? 'pc-expand inset-0' : 'bottom-3 right-3 aspect-video w-[22%] min-w-36 max-w-60'} overflow-hidden rounded-xl bg-[#4a4e51] shadow-[0_2px_10px_rgba(0,0,0,0.45)]`}>
            {cameraOn && <video ref={videoRef} autoPlay playsInline muted aria-label="Local camera preview" className="h-full w-full -scale-x-100 object-cover" />}
            {!cameraOn && <div className={`grid place-items-center rounded-full bg-[#00796b] font-medium text-white ${alone && !presenting ? 'h-28 w-28 text-3xl' : 'h-12 w-12 text-base'}`} aria-hidden="true">You</div>}
            {!cameraOn && <span className="sr-only">Camera off</span>}
            {muted && <span aria-hidden="true" className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-[#202124]/70 text-white"><MicOff size={13} /></span>}
            <p className={`absolute font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] ${alone && !presenting ? 'bottom-3 left-4 text-sm' : 'bottom-1.5 left-2 text-xs'}`}>You</p>
          </section>
        </div>
        {notice && <p role="alert" data-testid="call-notice" className="pc-fade rounded-lg bg-[#3c4043] px-3 py-2 text-xs text-[#fdd663]">{notice}</p>}
        {cameraError && <p role="alert" className="pc-fade rounded-lg bg-[#3c4043] px-3 py-2 text-xs text-[#fdd663]">{cameraError}</p>}
        {/* A reversed column keeps the scroll position at the newest caption without any script:
            the list sits in one child, so the reading order stays oldest to newest. */}
        {captionsOn && <section aria-label="Live captions" data-follow="newest" className="pc-rise flex max-h-28 flex-col-reverse overflow-y-auto px-2 text-[15px] leading-snug text-white">
          <div className="space-y-1.5">
            {captions.length === 0 && <p className="text-[#9aa0a6]">Captions appear as the call goes on.</p>}
            {captions.map((caption, index) => (Array.isArray(caption.segments) && caption.segments.length > 1
              // Two interviewers spoke in this reply: each part carries its own name.
              ? <p key={`${caption.atMs ?? index}-${index}`}>{caption.segments.map((segment, at) => <span key={at} data-caption-speaker={segment.speakerId}><span className="mr-2 text-xs font-medium text-[#9aa0a6]">{captionLabel({ speaker: caption.speaker, speakerId: segment.speakerId })}:</span> {segment.text}{' '}</span>)}</p>
              : <p key={`${caption.atMs ?? index}-${index}`} data-caption-overlay={caption.overlay ? 'true' : undefined}><span className="mr-2 text-xs font-medium text-[#9aa0a6]">{captionLabel(caption)}:</span> {caption.text}</p>))}
          </div>
        </section>}
      </div>
      {chatOpen && <div className="pc-panel w-[340px] shrink-0"><ChatPanel chat={chat} draft={chatDraft} onDraftChange={setChatDraft} disabled={interviewerLeft} paused={paused} onSend={api?.sendChat} onTyping={api?.setTyping} onSuggest={typeof api?.draftAnswer === 'function' ? api.draftAnswer : undefined} interviewerName={panelCall ? '' : firstNameOf(participants[0])} onClose={() => setPanel(null)} /></div>}
      {cardsOpen && <section aria-label="Notes" className="pc-panel flex w-[340px] shrink-0 flex-col rounded-2xl bg-white text-[#202124]">
        <header className="flex items-center justify-between px-5 pb-2 pt-4">
          <h2 className="text-lg font-normal">Notes</h2>
          <button type="button" aria-label="Close notes" onClick={() => setPanel(null)} className="grid h-9 w-9 place-items-center rounded-full text-[#5f6368] hover:bg-black/5"><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-4">
          {cards.length === 0 && <p className="text-sm text-[#5f6368]">No notes for this interview.</p>}
          {cards.map(card => <article key={card.id || card.question} className="border-b border-[#e8eaed] pb-3 last:border-0"><p className="text-sm font-medium">{card.question}</p><p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug text-[#3c4043]">{card.answer}</p></article>)}
        </div>
      </section>}
    </div>
    <footer className="grid h-20 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6">
      <p className="flex min-w-0 items-center gap-3 text-sm font-medium text-[#e8eaed]">
        <span role="timer" aria-label="Call timer" className="tabular-nums">{formatTime(state?.elapsedMs)}</span>
        <span aria-hidden="true" className="h-4 w-px bg-white/40" />
        <span className="truncate">{roleLine(state?.persona) || state?.persona?.name || 'Interview'}</span>
      </p>
      <div className="flex items-center gap-3">
        <button type="button" className={roundClass(muted ? 'off' : 'idle')} aria-pressed={muted} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { if (typeof api?.setMuted === 'function') api.setMuted(!muted); }}>{muted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}</button>
        <button type="button" className={roundClass(cameraOn ? 'idle' : 'off')} aria-pressed={cameraOn} aria-label={cameraOn ? 'Turn off camera' : 'Turn on camera'} onClick={toggleCamera}>{cameraOn ? <Video size={20} aria-hidden="true" /> : <VideoOff size={20} aria-hidden="true" />}</button>
        <button type="button" className={roundClass(captionsOn ? 'active' : 'idle')} aria-pressed={captionsOn} aria-label="Captions" onClick={() => setCaptionsOn(value => !value)}>{captionsOn ? <Captions size={20} aria-hidden="true" /> : <CaptionsOff size={20} aria-hidden="true" />}</button>
        <button type="button" className="grid h-10 w-14 place-items-center rounded-full bg-[#ea4335] text-white transition-colors duration-150 hover:bg-[#ec5345] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8]" aria-label="Hang up" onClick={leave}><PhoneOff size={20} aria-hidden="true" /></button>
      </div>
      <div className="flex items-center justify-end gap-1">
        <button type="button" className={flatClass(cardsOpen)} aria-pressed={cardsOpen} aria-label="Notes" onClick={toggleCards}><ListChecks size={20} aria-hidden="true" /></button>
        <button type="button" className={`relative ${flatClass(chatOpen)}`} aria-pressed={chatOpen} aria-label="Chat" onClick={() => setPanel(value => (value === 'chat' ? null : 'chat'))}><MessageSquare size={20} aria-hidden="true" />{unreadChat && <span data-testid="chat-unread" role="status" aria-label="New message" className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-[#ea4335] ring-2 ring-[#202124]" />}</button>
      </div>
    </footer>
    {/* The pause notice floats over the middle of the window: it takes no room in the layout and lets clicks through. */}
    {paused && <p role="status" data-paused="true" className="pc-fade pointer-events-none fixed inset-0 z-20 grid select-none place-items-center text-center">
      <span className="[text-shadow:0_2px_12px_rgba(0,0,0,0.75)]">
        <span className="block text-5xl font-semibold tracking-[0.2em] text-white/45">PAUSED</span>
        <span className="mt-2 block text-sm font-medium text-white/60">Press P to resume (⌘P while typing)</span>
      </span>
    </p>}
  </main>;
}
