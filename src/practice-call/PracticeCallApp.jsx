import React, { useEffect, useState } from 'react';
import ConsentScreen from './ConsentScreen.jsx';
import DownloadingScreen from './DownloadingScreen.jsx';
import PrecheckScreen from './PrecheckScreen.jsx';
import IncomingCall from './IncomingCall.jsx';
import MissedCall from './MissedCall.jsx';
import OutgoingCall from './OutgoingCall.jsx';
import ConnectingScreen from './ConnectingScreen.jsx';
import InCall from './InCall.jsx';
import EndedScreen from './EndedScreen.jsx';
import Replay from './Replay.jsx';
import ErrorScreen from './ErrorScreen.jsx';
import { MISSING_PRELOAD, CALL_WINDOW_TITLE, mergeEvent, mergeState, replayLoadFailed } from './callModel.js';
import { installCallEventCapture, logEvent } from './callEventLog.js';

function readApi() {
  return typeof window === 'undefined' ? null : window.practiceCallAPI || null;
}

// A replay window is opened with ?replay=1; it shows the past call whatever the service phase says.
const isReplayWindow = () => {
  try { return typeof window !== 'undefined' && new URLSearchParams(window.location?.search || '').get('replay') === '1'; } catch { return false; }
};

// A window without the preload has no main process to talk to; that is known
// before the first render, so it is the initial state instead of an effect write.
const initialState = () => (typeof readApi()?.getState === 'function' ? null : MISSING_PRELOAD);

export default function PracticeCallApp() {
  const [state, setState] = useState(initialState);
  const [replay, setReplay] = useState(null);
  const [busy, setBusy] = useState(false);

  // Clicks, errors and console warnings of this window go to the call's debug log and bug reports.
  useEffect(() => installCallEventCapture(readApi()), []);

  useEffect(() => {
    const api = readApi();
    if (typeof api?.getState !== 'function') return undefined;
    let live = true;
    const apply = value => { if (live && value && typeof value === 'object') setState(previous => mergeState(previous, value)); };
    const offState = typeof api.onState === 'function' ? api.onState(apply) : null;
    const offEvent = typeof api.onEvent === 'function' ? api.onEvent(event => { if (live) setState(previous => mergeEvent(previous, event)); }) : null;
    try {
      const initial = api.getState();
      if (initial && typeof initial.then === 'function') initial.then(apply).catch(() => { if (live) setState(previous => mergeState(previous, MISSING_PRELOAD)); });
      else apply(initial);
    } catch { Promise.resolve().then(() => { if (live) setState(previous => mergeState(previous, MISSING_PRELOAD)); }); }
    return () => {
      live = false;
      if (typeof offState === 'function') offState();
      if (typeof offEvent === 'function') offEvent();
    };
  }, []);

  const phase = isReplayWindow() && state && state.phase !== 'error' ? 'replay' : state?.phase;
  useEffect(() => { if (phase) logEvent('screen', phase); }, [phase]);
  // The window is titled like a call, never like this app.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const before = document.title;
    document.title = CALL_WINDOW_TITLE;
    return () => { document.title = before; };
  }, []);
  useEffect(() => {
    if (phase !== 'replay') return undefined;
    const api = readApi();
    if (typeof api?.getReplay !== 'function') return undefined;
    let live = true;
    const failed = (error) => { logEvent('ERROR replay could not be loaded:', error?.message || error || 'unknown'); if (live) setReplay(replayLoadFailed()); };
    // Loads can overlap (the service says the replay changed while one is out): only the newest answer counts.
    let latest = 0;
    const load = () => {
      const request = latest += 1;
      try {
        Promise.resolve(api.getReplay()).then(value => { if (live && request === latest && value && typeof value === 'object') setReplay(value); })
          .catch(error => { if (request === latest) failed(error); });
      } catch (error) { failed(error); }
    };
    load();
    const off = typeof api.onReplayUpdated === 'function' ? api.onReplayUpdated(load) : null;
    return () => { live = false; if (typeof off === 'function') off(); };
  }, [phase]);

  const invoke = (name, ...args) => {
    const api = readApi();
    const fn = api?.[name];
    if (typeof fn !== 'function') return undefined;
    try {
      const result = fn(...args);
      // Most callers are click handlers that drop the promise. Marking it
      // handled here keeps a failed IPC call from surfacing as an unhandled
      // rejection; a caller that awaits the result still sees the failure.
      if (typeof result?.catch === 'function') result.catch(() => {});
      return result;
    } catch { return undefined; }
  };
  const agree = async () => {
    setBusy(true);
    try { await invoke('agreeModelDownload'); } catch { /* the state subscription reports failures */ } finally { setBusy(false); }
  };

  if (!state) {
    return <main role="status" aria-live="polite" aria-label="Loading call" className="grid min-h-screen place-items-center bg-[#202124] text-[11px] text-violet-100">Loading…</main>;
  }
  // Keyed by stage of the session so each hand-over (call, processing, feedback) fades in.
  const stageKey = phase === 'ended' || phase === 'analyzing' ? 'processing' : phase;
  const renderPhase = () => {
    switch (phase) {
      case 'consent': return <ConsentScreen onAgree={agree} busy={busy} sizes={state.modelDownload?.sizes} />;
      case 'downloading': return <DownloadingScreen download={state.modelDownload} />;
      case 'precheck': return <PrecheckScreen level={state.level} usageWarning={state.usageWarning} persona={state.persona} setup={state.setup} microphoneUnavailable={!!state.microphoneUnavailable}
        onReady={() => invoke('ready')} onCancel={() => invoke('close')} onOpenMicrophoneSettings={() => invoke('openMicrophoneSettings')} />;
      case 'ringing': return <IncomingCall persona={state.persona} onAnswer={() => invoke('answer')} onDecline={() => invoke('decline')} />;
      case 'missed': return <MissedCall persona={state.persona} missed={state.missed} onCallBack={() => invoke('callBack')} onClose={() => invoke('close')} />;
      case 'calling': return <OutgoingCall persona={state.persona} onCancel={() => invoke('cancelCallBack')} />;
      case 'connecting': return <ConnectingScreen persona={state.persona} />;
      case 'in-call': return <InCall state={state} api={{
        setMuted: value => invoke('setMuted', value),
        leave: () => invoke('leave'),
        getPreparedCards: () => invoke('getPreparedCards'),
        sendChat: (text, options) => invoke('sendChat', text, options),
        setTyping: value => invoke('setTyping', value),
        setPaused: value => invoke('setPaused', value),
        updatePad: (text, sheet) => invoke('updatePad', text, sheet),
        // Without it the pad shows no Language dropdown (missing from this list in the call of 2026-11-22).
        ...(typeof readApi()?.setPadLanguage === 'function' ? { setPadLanguage: name => invoke('setPadLanguage', name) } : {}),
        openMicrophoneSettings: () => invoke('openMicrophoneSettings'),
        ...(typeof readApi()?.reconnectMicrophone === 'function' ? { reconnectMicrophone: () => invoke('reconnectMicrophone') } : {}),
        ...(typeof readApi()?.getVoice === 'function' ? { getVoice: () => invoke('getVoice'), setVoice: gender => invoke('setVoice', gender) } : {}),
        // Testing aid: the button shows only when the bridge has the call.
        ...(typeof readApi()?.draftAnswer === 'function' ? { draftAnswer: () => invoke('draftAnswer') } : {}),
      }} />;
      case 'ended':
      case 'analyzing': return <EndedScreen state={state} onChooseFeedback={wants => invoke('chooseFeedback', wants)} />;
      case 'replay': return <Replay replay={replay} api={{ deleteRecording: () => invoke('deleteRecording'), ...(typeof readApi()?.retryAnalysis === 'function' ? { retryAnalysis: () => invoke('retryAnalysis') } : {}) }} />;
      case 'error': return <ErrorScreen error={state.error} onClose={() => invoke('close')} onOpenMicrophoneSettings={() => invoke('openMicrophoneSettings')} />;
      default: return <ErrorScreen error={state.error || { code: 'unknown-phase', message: 'Something went wrong with this window. Close it and start the call again.' }} onClose={() => invoke('close')} />;
    }
  };
  return <div key={stageKey} className="pc-fade">{renderPhase()}</div>;
}

export { PracticeCallApp };
