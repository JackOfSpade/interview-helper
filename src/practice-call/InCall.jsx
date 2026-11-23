import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Captions, CaptionsOff, ListChecks, LoaderCircle, MessageSquare, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff, WandSparkles, X } from 'lucide-react';
import ChatPanel, { CHAT_MAX_LENGTH, TYPING_REFRESH_MS } from './ChatPanel.jsx';
import Avatar from './Avatar.jsx';
import SharedScreen from './SharedScreen.jsx';
import CodingPad from './CodingPad.jsx';
import { logEvent } from './callEventLog.js';
import { padEdit, padTypingMs, typingPace } from './padTyping.js';
import MoreOptions from './MoreOptions.jsx';
import { DEFAULT_PAD_LANGUAGE, padLanguageName } from './padLanguages.js';
import { clampScreen } from './screenMarkup.js';
import { firstNameOf, participantsOf } from './persona.js';
import { playJoinChime, playLeaveChime } from './ringtone.js';
import { formatTime } from './replayModel.js';
import { selfPulse } from './callModel.js';
import { shouldTogglePause } from './pauseKey.js';
import { PANEL_DEFAULT_WIDTH, PANEL_KEY_STEP, PANEL_MIN_WIDTH, STAGE_MIN_WIDTH, clampPanelWidth, readPanelWidth, savePanelWidth, startDrag } from './panelSize.js';

// Meeting-style controls: a round neutral button, red when the device is off,
// light blue when a view (captions, a side panel) is switched on.
const roundClass = tone => `grid h-10 w-10 place-items-center rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8] ${
  tone === 'off' ? 'bg-[#ea4335] text-white hover:bg-[#ec5345]'
    : tone === 'active' ? 'bg-[#8ab4f8] text-[#202124] hover:bg-[#93bbf9]'
      : 'bg-[#3c4043] text-[#e8eaed] hover:bg-[#4a4e51]'}`;
const flatClass = active => `grid h-10 w-10 place-items-center rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#8ab4f8] ${active ? 'bg-[#8ab4f8]/20 text-[#8ab4f8]' : 'text-[#e8eaed] hover:bg-white/10'}`;

const TOAST_MS = 4000;
// The longest the wand waits for its line to start playing (the voice gives up on a line long before this).
const VOICE_WAIT_MAX_MS = 60000;
// The wand working an exercise: how often it looks at the call, and the longest it waits on one line (paused time not counted).
const WORK_POLL_MS = 150;
const WORK_STEP_MAX_MS = 120000;
const AFTER_TYPING_SETTLE_MS = 1500; // between the last key of a piece typed in silence and the line that explains it
// How long a tile that just left takes to fade out before it is removed (matches .pc-leave).
const LEAVE_MS = 300;
// The candidate's last pick of pad language, kept for the next exercise and the next call.
const PAD_LANGUAGE_KEY = 'practiceCall.padLanguage';

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
  // The chat and notes panel share one width, dragged from its left edge and kept for later calls.
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const panelWidthRef = useRef(panelWidth);
  useEffect(() => { panelWidthRef.current = panelWidth; }, [panelWidth]);
  const rowRef = useRef(null);
  const rowWidth = () => rowRef.current?.getBoundingClientRect?.().width;
  const dragPanel = event => {
    const from = panelWidthRef.current;
    let last = from;
    startDrag(event, { axis: 'x', onMove: dx => { last = clampPanelWidth(from - dx, rowWidth()); setPanelWidth(last); }, onEnd: () => savePanelWidth(last) });
  };
  const panelKey = event => {
    const step = event.shiftKey ? PANEL_KEY_STEP * 4 : PANEL_KEY_STEP;
    const next = event.key === 'ArrowLeft' ? panelWidthRef.current + step
      : event.key === 'ArrowRight' ? panelWidthRef.current - step
        : event.key === 'Home' ? PANEL_DEFAULT_WIDTH : null;
    if (next == null) return;
    event.preventDefault();
    const width = clampPanelWidth(next, rowWidth());
    setPanelWidth(width);
    savePanelWidth(width);
  };
  const resetPanel = () => { setPanelWidth(PANEL_DEFAULT_WIDTH); savePanelWidth(PANEL_DEFAULT_WIDTH); };
  const [chatDraft, setChatDraft] = useState('');
  const sendChat = typeof api?.sendChat === 'function' ? text => api.sendChat(text) : undefined;
  // The wand (testing aid): a reply to the latest question is written and spoken in the candidate's
  // voice at once, without going through the chat box. It is sent marked generated, so it is heard
  // but never counts as practice. While it is written the candidate counts as typing, so the
  // interviewer waits; a reply that is ready while the call is paused is spoken on resume.
  // The spinner runs until the reply is ready to be heard: through the writing and the making of its voice (its chat
  // entry's `voice` leaves 'waiting' once the voice has it). During a pause the line is made and held, so the spinner
  // stops while still paused and the line plays the moment the call resumes.
  const canSuggest = typeof api?.draftAnswer === 'function' && typeof api?.sendChat === 'function';
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState('');
  // The sent reply the wand still waits to hear: null (none), { id: null } (held for a pause or being sent) or { id }.
  const [voiceWait, setVoiceWait] = useState(null);
  const heldReplyRef = useRef('');
  // The chat as last seen, so a reply can tell its own new entry from those already there.
  const chatRef = useRef(state?.chat);
  useEffect(() => { chatRef.current = state?.chat; });
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; });
  const reportTyping = value => { try { apiRef.current?.setTyping?.(!!value); } catch { /* bridge gone */ } };
  useEffect(() => {
    if (!suggesting) return undefined;
    reportTyping(true);
    const timer = setInterval(() => reportTyping(true), TYPING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [suggesting]);
  useEffect(() => {
    if (!suggestError) return undefined;
    const timer = setTimeout(() => setSuggestError(''), TOAST_MS);
    return () => clearTimeout(timer);
  }, [suggestError]);
  const deliverReply = async text => {
    setVoiceWait({ id: null });
    const known = new Set((Array.isArray(chatRef.current) ? chatRef.current : []).map(item => item?.id).filter(Boolean));
    let result;
    try { result = await apiRef.current.sendChat(text, { generated: true }); } catch { result = null; }
    if (!mountedRef.current) return;
    // The entry this reply made (a new one); without a voice (or once it failed) there is nothing to wait for.
    const chat = Array.isArray(result?.chat) ? result.chat : [];
    const entry = [...chat].reverse().find(item => item?.from === 'candidate' && typeof item.id === 'string' && !known.has(item.id));
    // Refused for a pause (a call whose voice cannot hold a line): the reply waits for the resume.
    if (result?.paused && !entry) { heldReplyRef.current = text; return null; }
    if (result?.muted && !entry) { setVoiceWait(null); return null; } // muted: refused, nothing is said
    setVoiceWait(entry && entry.voice === 'waiting' ? { id: entry.id } : null);
    return entry ? entry.id : null;
  };
  // The wand working an exercise in the pad: each step's line is said and its code typed into the pad at a person's
  // pace, through the pad's own edits, so the interviewers see it exactly as typing. Each step chose when its line is
  // said (`order`): before the typing, during it (the two start together and the keys are paced to the line), or
  // after it (typed in silence, then explained). A step never starts before the last one's line and typing both
  // ended, so the words are always about the piece being typed, just typed or about to be. When an
  // interviewer starts speaking it gives way exactly as a spoken answer does: a voice line is cut by the engine, and
  // typing stops after the same reaction time (the service's `floor`, from the engine), at the end of the word being
  // typed. Whatever is in the pad stays; the wand pressed again answers and carries on from there. Pressing it while it
  // works ends this run and starts a fresh one from where things stand.
  const typerRef = useRef(null);
  const workRef = useRef(null);
  const [working, setWorking] = useState(false);
  const liveRef = useRef(state);
  useEffect(() => { liveRef.current = state; });
  const floorCount = () => Number(liveRef.current?.floor?.n) || 0;
  // An interviewer started speaking since this run began: noted once, with the moment the candidate gives way.
  const floorTaken = run => {
    if (run.yieldAt === null && floorCount() > run.floorN) run.yieldAt = Date.now() + (Number(liveRef.current?.floor?.yieldMs) || 600);
    return run.yieldAt !== null;
  };
  const gaveWay = run => floorTaken(run) && Date.now() >= run.yieldAt;
  const waitUntil = (check, run, limitMs = WORK_STEP_MAX_MS) => new Promise(resolve => {
    let waited = 0;
    const tick = () => {
      if (!mountedRef.current || run.stop || gaveWay(run)) { resolve(false); return; }
      if (check()) { resolve(true); return; }
      if (!liveRef.current?.paused) waited += WORK_POLL_MS; // a pause holds the clock
      if (waited >= limitMs) { resolve(false); return; }
      setTimeout(tick, WORK_POLL_MS);
    };
    tick();
  });
  const runWork = async steps => {
    const run = { stop: false, floorN: floorCount(), yieldAt: null };
    let finished;
    run.done = new Promise(resolve => { finished = resolve; });
    workRef.current = run;
    setWorking(true);
    const entryOf = id => (liveRef.current?.chat || []).find(item => item?.id === id);
    // The run is written to the call's debug log (full content stays in the draft-answer event), so a step's words and
    // its typing can be compared by their timings: the lines are short, well under the bridge's per-line cap.
    const total = steps.length;
    let index = 0;
    let why = 'all steps done';
    // The pad as the earlier steps left it (the service's copy can lag a second behind the keys).
    let padNow = liveRef.current?.pad?.text ?? '';
    const note = (...parts) => logEvent('work', ...parts);
    const typeStep = (code, cutLine = () => false, pace = 1) => {
      if (!liveRef.current?.pad?.open || !typerRef.current) return Promise.resolve(false);
      const began = Date.now();
      note(`step ${index + 1}/${total} type start`);
      // An interviewer who starts speaking is given way to mid-piece, at the end of the word being typed; a line cut
      // off under it stops the hands with it (talking and typing give way together).
      return typerRef.current.typeTo(code, {
        stopped: () => run.stop || !mountedRef.current || !liveRef.current?.pad?.open || cutLine(),
        paused: () => !!liveRef.current?.paused,
        yielding: () => gaveWay(run),
        pace,
      }).then(done => { if (done) padNow = code; note(`step ${index + 1}/${total} type end after ${Date.now() - began}ms`, done ? 'completed' : 'not completed'); return done; });
    };
    note(`run begin ${total} steps`);
    try {
      for (; index < total; index += 1) {
        const step = steps[index];
        const label = `step ${index + 1}/${total}`;
        if (run.stop || !mountedRef.current || floorTaken(run)) { why = `${label} not started: ${run.stop ? 'run replaced or stopped' : !mountedRef.current ? 'call screen closed' : 'an interviewer took the floor'}`; break; }
        const hasCode = step.code !== null && step.code !== undefined;
        const edit = hasCode ? padEdit(padNow, step.code) : null;
        // When the line is said against the typing; it only means something with both a line and code.
        const order = hasCode && step.say ? (['before', 'during', 'after'].includes(step.order) ? step.order : step.together ? 'during' : 'before') : 'before';
        const typeEstimate = hasCode ? padTypingMs(padNow, step.code) : 0;
        const pace = order === 'during' ? typingPace(step.say, typeEstimate) : 1;
        note(`${label} begin`, `explain=${order}`, `say ${step.say.length} chars`, hasCode ? `code +${edit.insert.length}/-${edit.remove} chars, estimated typing ${typeEstimate}ms${order === 'during' ? `, paced x${pace.toFixed(2)} to the line` : ''}` : 'no code');
        let typing = null;
        let typedFirst = false;
        if (order === 'after') {
          // Written in silence first; the line that looks back at it is said only once the piece is in the pad.
          // As before a line, an interviewer already speaking is left to finish.
          await waitUntil(() => liveRef.current?.speaking !== 'interviewer', run, 30000);
          if (run.stop || floorTaken(run)) { why = `${label} typing not started: ${run.stop ? 'run replaced or stopped' : 'an interviewer took the floor'}`; break; }
          if (!(await typeStep(step.code))) { why = `${label} typing stopped before it finished`; break; }
          typedFirst = true;
          // A beat to look the piece over, as a person does before speaking about it. It also lets the pad settle: a
          // line that starts the instant the last key lands reads to the interviewers as said while still typing.
          const settledAt = Date.now() + AFTER_TYPING_SETTLE_MS;
          await waitUntil(() => Date.now() >= settledAt, run, AFTER_TYPING_SETTLE_MS * 4);
          if (run.stop || floorTaken(run)) { why = `${label} line not sent: ${run.stop ? 'run replaced or stopped' : 'an interviewer took the floor'}`; break; }
        }
        if (step.say) {
          // A person lets the interviewer finish before going on (one already speaking as the run began).
          await waitUntil(() => liveRef.current?.speaking !== 'interviewer', run, 30000);
          if (run.stop || floorTaken(run)) { why = `${label} line not sent: ${run.stop ? 'run replaced or stopped' : 'an interviewer took the floor'}`; break; }
          const lineAt = Date.now();
          const id = await deliverReply(step.say);
          if (!id) { why = `${label} line not sent: ${!mountedRef.current ? 'call screen closed' : 'refused (paused, muted or no chat entry)'}`; break; }
          const cutLine = () => { const entry = entryOf(id); return !!entry && (entry.cutOff || entry.unsaid || entry.voice === 'failed'); };
          let typingAt = 0;
          let typeMs = 0;
          if (order === 'during') {
            // Typing while talking: the hands start once the voice does (or at once, on a call without a voice).
            const started = await waitUntil(() => { const entry = entryOf(id); return !!entry && (!entry.voice || ['playing', 'heard'].includes(entry.voice) || cutLine()); }, run);
            if (!started || cutLine()) { why = `${label} voice did not start: ${cutLine() ? `line cut or failed (voice ${entryOf(id)?.voice ?? '?'})` : 'gave way, stopped or timed out'}`; break; }
            typingAt = Date.now();
            typing = typeStep(step.code, cutLine, pace).then(done => { typeMs = Date.now() - typingAt; return done; });
          }
          const heard = await waitUntil(() => { const entry = entryOf(id); return !!entry && (!entry.voice || entry.voice === 'heard' || cutLine()); }, run);
          const heardAt = Date.now();
          const entry = entryOf(id);
          // Cut off or lost: the interviewer has the floor. A call without a voice has the line as typed, at once.
          const lineOk = heard && entry && !cutLine() && (!entry.voice || entry.voice === 'heard');
          note(`${label} line heard after ${heardAt - lineAt}ms`, lineOk ? 'completed' : `not completed (voice ${entry?.voice ?? '?'}${entry?.cutOff ? ', cut off' : ''}${entry?.unsaid ? ', unsaid' : ''})`);
          if (typing) {
            const typed = await typing;
            // How far apart the two ended, both measured from when the hands and the voice started together.
            const lineMs = heardAt - typingAt;
            if (typed && lineOk && Math.abs(typeMs - lineMs) > 3000) note(`${label} ${typeMs > lineMs ? 'typing outlasted the line' : 'line outlasted the typing'} by ${Math.abs(typeMs - lineMs)}ms`, `(typing ${typeMs}ms, line ${lineMs}ms)`);
            if (!typed) { why = `${label} typing stopped before it finished`; break; }
          }
          if (!lineOk) { why = `${label} line not completed: ${!heard ? 'gave way, stopped or timed out' : `voice ${entry?.voice ?? 'lost'}${entry?.cutOff ? ', cut off' : ''}${entry?.unsaid ? ', unsaid' : ''}`}`; break; }
        }
        if (hasCode && !typing && !typedFirst) {
          if (gaveWay(run)) { why = `${label} typing not started: an interviewer took the floor`; break; }
          if (!(await typeStep(step.code))) { why = `${label} typing stopped before it finished`; break; }
        }
      }
    } finally {
      note(`run end: ${why}`);
      if (workRef.current === run) workRef.current = null;
      if (mountedRef.current) setWorking(false);
      finished();
    }
  };
  const stopWork = () => { if (workRef.current) workRef.current.stop = true; };
  useEffect(() => () => stopWork(), []);
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
  // Muting stops a wand working the pad as well: nothing more is said or typed until it is pressed again.
  // A wand line held for a pause is dropped too: after unmuting the wand is pressed again.
  useEffect(() => {
    if (!muted) return;
    if (workRef.current) workRef.current.stop = true;
    heldReplyRef.current = '';
  }, [muted]);
  // "You're muted", as a meeting app shows it: the candidate talked into the muted mic, or pressed the wand or sent a
  // line while muted. Each hint shows for a few seconds; a new one restarts it.
  const hint = muted ? state?.mutedHint : null;
  const [expiredHintId, setExpiredHintId] = useState(null);
  const hintId = hint?.id ?? null;
  useEffect(() => {
    if (hintId === null) return undefined;
    const timer = setTimeout(() => setExpiredHintId(hintId), TOAST_MS);
    return () => clearTimeout(timer);
  }, [hintId]);
  const shownHint = hint && hint.id !== expiredHintId ? hint : null;
  // The candidate's voice going out (their microphone or their AI voice): a steady ring, with a
  // glow that grows and shrinks with the sound itself rather than on a timer.
  const selfSpeaking = !!state?.candidateSpeaking;
  const pulse = selfSpeaking ? selfPulse(state?.level) : 0;
  const glow = spread => (selfSpeaking ? `0 0 0 ${Math.round(spread * pulse)}px rgba(138,180,248,${(0.12 + 0.2 * pulse).toFixed(2)})` : undefined);
  const paused = !!state?.paused;
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
    if (paused || !heldReplyRef.current) return;
    const text = heldReplyRef.current;
    heldReplyRef.current = '';
    deliverReply(text);
  }, [paused]);
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
  const wandBusy = suggesting || voiceWait !== null || working;
  // The spinner shows only while something is being made (the answer, or a line's voice); while the wand types or
  // waits for a line to finish it is the wand, lit, and pressing it starts afresh from where things stand.
  const spinning = suggesting || voiceWait !== null;
  // The wand's line is ready (its voice is made), was given up on, or nobody is left to hear it: the spinner stops.
  const waitingId = voiceWait?.id ?? null;
  const waitingEntry = waitingId ? (Array.isArray(state?.chat) ? state.chat : []).find(item => item?.id === waitingId) : null;
  const voiceSettled = voiceWait !== null && (interviewerLeft || state?.phase !== 'in-call' || (waitingEntry && waitingEntry.voice !== 'waiting'));
  // Adjusted while rendering, as the leaving tiles are below: the next render already shows the wand back.
  if (voiceSettled) setVoiceWait(null);
  // A safety net: a line that never reports back does not leave the wand spinning (a pause holds the clock).
  useEffect(() => {
    if (voiceWait === null || paused) return undefined;
    const timer = setTimeout(() => setVoiceWait(null), VOICE_WAIT_MAX_MS);
    return () => clearTimeout(timer);
  }, [voiceWait, paused]);
  const suggestReply = async () => {
    if (!canSuggest || spinning || interviewerLeft) return;
    // Muted: nothing is written or spoken; the call answers with "You're muted" and the wand is pressed again after unmuting.
    if (muted) { try { await api.draftAnswer(); } catch { /* bridge gone */ } return; }
    // Pressed while it works: this run ends where it is (the pad keeps what was typed) and a fresh one starts from there.
    const previous = workRef.current;
    if (previous) { previous.stop = true; await previous.done; }
    if (!mountedRef.current) return;
    setSuggesting(true);
    setSuggestError('');
    let result;
    try { result = await api.draftAnswer(); } catch { result = null; }
    const text = typeof result?.text === 'string' ? result.text.trim().slice(0, CHAT_MAX_LENGTH) : '';
    if (!mountedRef.current) return;
    setSuggesting(false);
    reportTyping(false);
    if (result?.muted) return; // muted while it was being written: dropped, never spoken
    const steps = Array.isArray(result?.steps) ? result.steps.filter(step => step && (typeof step.say === 'string' || typeof step.code === 'string')) : [];
    if (steps.length) { await runWork(steps.map(step => ({ say: String(step.say || '').trim().slice(0, CHAT_MAX_LENGTH), code: typeof step.code === 'string' ? step.code : null, order: step.order, together: step.together === true }))); return; }
    if (!text) { setSuggestError(typeof result?.error === 'string' && result.error ? result.error : 'Could not suggest a reply. Try again.'); return; }
    // Sent even while paused: the voice makes the line now and holds it for the resume (a call that cannot hold it
    // refuses, and the window keeps the text until the resume instead).
    await deliverReply(text);
  };
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
  const screen = state?.screen && typeof state.screen === 'object' ? { ...clampScreen(state.screen), speakerId: state.screen.speakerId, presenterName: state.screen.presenterName, visual: state.screen.visual ?? null } : null;
  const pad = state?.pad && typeof state.pad === 'object' ? state.pad : null;
  const padOpen = pad?.open === true;
  // The exercise leaves the language open: the candidate picks it in the pad (the last pick is remembered here, per
  // viewer), and the wand writes in it.
  const canChooseLanguage = typeof api?.setPadLanguage === 'function';
  const chooseLanguage = name => {
    if (!padLanguageName(name)) return;
    try { window.localStorage.setItem(PAD_LANGUAGE_KEY, name); } catch { /* storage unavailable */ }
    api.setPadLanguage(name)?.catch?.(() => {});
  };
  const needsLanguage = padOpen && canChooseLanguage && !pad?.lang && !pad?.choice && !interviewerLeft;
  useEffect(() => {
    if (!needsLanguage) return;
    let saved = '';
    try { saved = window.localStorage.getItem(PAD_LANGUAGE_KEY) || ''; } catch { /* storage unavailable */ }
    api.setPadLanguage(padLanguageName(saved) || DEFAULT_PAD_LANGUAGE)?.catch?.(() => {});
  }, [needsLanguage, api]);
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
    <div ref={rowRef} className="flex min-h-0 flex-1 gap-4 px-4 pt-4">
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
                {!cameraOn && <p data-chip="you" data-self-speaking={selfSpeaking ? 'true' : 'false'} aria-hidden="true" className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#3c4043] pl-1 text-xs font-medium text-white outline outline-2 -outline-offset-2 transition-[outline-color] duration-200 ${selfSpeaking ? 'outline-[#8ab4f8]' : 'outline-transparent'} ${tightBar && !muted ? 'pr-1' : 'pr-3'}`}>
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-[#00796b] text-[9px] transition-[box-shadow] duration-100 ease-out" style={{ boxShadow: glow(5) }}>You</span>{muted ? <MicOff size={12} /> : tightBar ? null : 'You'}
                </p>}
              </div>
              <div data-stage="true" className={`flex min-h-0 min-w-0 flex-1 flex-col gap-3 ${sidePanelOpen ? 'xl:flex-row' : 'md:flex-row'}`}>
                {screen && <SharedScreen key="screen" title={screen.title} content={screen.content} visual={screen.visual} className="min-h-0 min-w-0 flex-1 basis-0" />}
                {padOpen && <CodingPad key="pad" lang={pad.lang || ''} choice={pad.choice || ''} onChooseLanguage={canChooseLanguage ? chooseLanguage : undefined} initialText={pad.text || ''} disabled={interviewerLeft} typerRef={typerRef}
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
          <section aria-label="Your camera" data-camera={cameraOn ? 'on' : 'off'} data-self={alone && !presenting ? 'full' : 'corner'} data-self-speaking={selfSpeaking ? 'true' : 'false'}
            className={`absolute z-10 grid place-items-center ${presenting ? (cameraOn ? 'bottom-2 right-2 aspect-video w-32' : 'hidden') : alone ? 'pc-expand inset-0' : 'bottom-3 right-3 aspect-video w-[22%] min-w-36 max-w-60'} overflow-hidden rounded-xl bg-[#4a4e51] shadow-[0_2px_10px_rgba(0,0,0,0.45)] outline outline-[3px] -outline-offset-[3px] transition-[outline-color] duration-200 ${selfSpeaking ? 'outline-[#8ab4f8]' : 'outline-transparent'}`}>
            {cameraOn && <video ref={videoRef} autoPlay playsInline muted aria-label="Local camera preview" className="h-full w-full -scale-x-100 object-cover" />}
            {!cameraOn && <div className={`grid place-items-center rounded-full bg-[#00796b] font-medium text-white transition-[box-shadow] duration-100 ease-out ${alone && !presenting ? 'h-28 w-28 text-3xl' : 'h-12 w-12 text-base'}`} style={{ boxShadow: glow(alone && !presenting ? 22 : 12) }} aria-hidden="true">You</div>}
            {cameraOn && selfSpeaking && <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-xl transition-[box-shadow] duration-100 ease-out" style={{ boxShadow: `inset 0 0 ${Math.round(6 + 18 * pulse)}px rgba(138,180,248,${(0.25 + 0.35 * pulse).toFixed(2)})` }} />}
            {!cameraOn && <span className="sr-only">Camera off</span>}
            {muted && <span aria-hidden="true" className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-[#202124]/70 text-white"><MicOff size={13} /></span>}
            <p className={`absolute font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] ${alone && !presenting ? 'bottom-3 left-4 text-sm' : 'bottom-1.5 left-2 text-xs'}`}>You{selfSpeaking && <span className="sr-only"> speaking</span>}</p>
          </section>
        </div>
        {notice && <p role="alert" data-testid="call-notice" className="pc-fade rounded-lg bg-[#3c4043] px-3 py-2 text-xs text-[#fdd663]">{notice}</p>}
        {cameraError && <p role="alert" className="pc-fade rounded-lg bg-[#3c4043] px-3 py-2 text-xs text-[#fdd663]">{cameraError}</p>}
        {suggestError && <p role="alert" data-testid="suggest-error" className="pc-fade rounded-lg bg-[#3c4043] px-3 py-2 text-xs text-[#fdd663]">{suggestError}</p>}
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
      {(chatOpen || cardsOpen) && <div data-side-panel="true" className="pc-panel relative shrink-0" style={{ width: panelWidth, minWidth: PANEL_MIN_WIDTH, maxWidth: `calc(100% - ${STAGE_MIN_WIDTH}px)` }}>
        {/* The edge in the gap between the call and the panel drags the panel wider or narrower. */}
        <div role="separator" aria-orientation="vertical" aria-label="Resize side panel" aria-valuenow={panelWidth} tabIndex={0} title="Drag to resize"
          onPointerDown={dragPanel} onKeyDown={panelKey} onDoubleClick={resetPanel}
          className="group absolute -left-4 top-0 z-10 flex h-full w-4 cursor-col-resize touch-none items-center justify-center outline-none">
          <span aria-hidden="true" className="h-10 w-1 rounded-full bg-white/20 transition-colors group-hover:bg-[#8ab4f8] group-focus-visible:bg-[#8ab4f8] group-active:bg-[#8ab4f8]" />
        </div>
        {chatOpen && <ChatPanel chat={chat} draft={chatDraft} onDraftChange={setChatDraft} disabled={interviewerLeft} paused={paused} onSend={sendChat} onTyping={api?.setTyping} interviewerName={panelCall ? '' : firstNameOf(participants[0])} onClose={() => setPanel(null)} />}
        {cardsOpen && <section aria-label="Notes" className="flex h-full flex-col rounded-2xl bg-white text-[#202124]">
          <header className="flex items-center justify-between px-5 pb-2 pt-4">
            <h2 className="text-lg font-normal">Notes</h2>
            <button type="button" aria-label="Close notes" onClick={() => setPanel(null)} className="grid h-9 w-9 place-items-center rounded-full text-[#5f6368] hover:bg-black/5"><X size={18} aria-hidden="true" /></button>
          </header>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-4">
            {cards.length === 0 && <p className="text-sm text-[#5f6368]">No notes for this interview.</p>}
            {cards.map(card => <article key={card.id || card.question} className="border-b border-[#e8eaed] pb-3 last:border-0"><p className="text-sm font-medium">{card.question}</p><p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug text-[#3c4043]">{card.answer}</p></article>)}
          </div>
        </section>}
      </div>}
    </div>
    {/* No microphone (macOS refused it, or it stopped working): the call goes on, the interviewer cannot hear the candidate,
        so the call says so the way a meeting app would and offers to reconnect. */}
    {state?.microphoneUnavailable && <div role="alert" data-mic-unavailable={state.microphoneNeedsRejoin ? 'rejoin' : state.microphoneFailed ? 'failed' : 'denied'} className="mx-auto mb-1 flex max-w-[640px] shrink-0 items-center gap-3 rounded-lg bg-[#3c4043] px-4 py-2 text-[13px] text-[#e8eaed]">
      <MicOff size={16} aria-hidden="true" className="shrink-0 text-[#f28b82]" />
      <span className="min-w-0 flex-1">{state.microphoneNeedsRejoin
        ? "Your microphone can't be used in this call, so no one can hear you. Leave and rejoin to be heard. You can still type in the chat."
        : state.microphoneFailed
          ? "Your microphone stopped working, so no one can hear you. Check it's connected, then reconnect. You can still type in the chat."
          : "Your microphone isn't available, so no one can hear you. Allow microphone access in System Settings, then reconnect."}</span>
      {!state.microphoneFailed && !state.microphoneNeedsRejoin && typeof api?.openMicrophoneSettings === 'function' && <button type="button" onClick={() => { api.openMicrophoneSettings(); }} className="shrink-0 rounded-md px-2 py-1 font-medium text-[#8ab4f8] hover:bg-white/10">Open settings</button>}
      {!state.microphoneNeedsRejoin && typeof api?.reconnectMicrophone === 'function' && <button type="button" data-mic-reconnect="true" disabled={!!state.microphoneReconnecting} onClick={() => { api.reconnectMicrophone(); }} className="shrink-0 rounded-md px-2 py-1 font-medium text-[#8ab4f8] hover:bg-white/10 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent">{state.microphoneReconnecting ? 'Reconnecting…' : 'Reconnect'}</button>}
    </div>}
    {shownHint && <p key={shownHint.id} role="status" data-muted-hint={shownHint.reason} className="pc-rise pointer-events-none fixed bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-[#3c4043] px-4 py-2 text-[13px] text-[#e8eaed] shadow-lg">
      {shownHint.reason === 'speech' ? 'Are you talking? Your mic is off. Unmute to speak.' : "You're muted. Unmute to be heard."}
    </p>}
    <footer className="grid h-20 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6">
      <p className="flex min-w-0 items-center gap-3 text-sm font-medium text-[#e8eaed]">
        <span role="timer" aria-label="Call timer" className="tabular-nums">{formatTime(state?.elapsedMs)}</span>
        <span aria-hidden="true" className="h-4 w-px bg-white/40" />
        <span className="truncate">{state?.meetingTitle || 'Interview'}</span>
      </p>
      <div className="flex items-center gap-3">
        <button type="button" className={roundClass(muted ? 'off' : 'idle')} aria-pressed={muted} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { if (typeof api?.setMuted === 'function') api.setMuted(!muted); }}>{muted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}</button>
        {canSuggest && <button type="button" className={`${roundClass(wandBusy ? 'active' : 'idle')} disabled:cursor-not-allowed`} aria-label="Suggest a reply" title="Suggest a reply and say it" aria-busy={spinning}
          disabled={spinning || interviewerLeft} onClick={suggestReply}>{spinning ? <LoaderCircle size={20} className="animate-spin" aria-hidden="true" data-testid="suggest-loading" /> : <WandSparkles size={20} aria-hidden="true" />}</button>}
        <button type="button" className={roundClass(cameraOn ? 'idle' : 'off')} aria-pressed={cameraOn} aria-label={cameraOn ? 'Turn off camera' : 'Turn on camera'} onClick={toggleCamera}>{cameraOn ? <Video size={20} aria-hidden="true" /> : <VideoOff size={20} aria-hidden="true" />}</button>
        <button type="button" className={roundClass(captionsOn ? 'active' : 'idle')} aria-pressed={captionsOn} aria-label="Captions" onClick={() => setCaptionsOn(value => !value)}>{captionsOn ? <Captions size={20} aria-hidden="true" /> : <CaptionsOff size={20} aria-hidden="true" />}</button>
        <button type="button" className="grid h-10 w-14 place-items-center rounded-full bg-[#ea4335] text-white transition-colors duration-150 hover:bg-[#ec5345] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8]" aria-label="Hang up" onClick={leave}><PhoneOff size={20} aria-hidden="true" /></button>
      </div>
      <div className="flex items-center justify-end gap-1">
        <button type="button" className={flatClass(cardsOpen)} aria-pressed={cardsOpen} aria-label="Notes" onClick={toggleCards}><ListChecks size={20} aria-hidden="true" /></button>
        <button type="button" className={`relative ${flatClass(chatOpen)}`} aria-pressed={chatOpen} aria-label="Chat" onClick={() => setPanel(value => (value === 'chat' ? null : 'chat'))}><MessageSquare size={20} aria-hidden="true" />{unreadChat && <span data-testid="chat-unread" role="status" aria-label="New message" className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-[#ea4335] ring-2 ring-[#202124]" />}</button>
        <MoreOptions api={api} buttonClass={flatClass} />
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
