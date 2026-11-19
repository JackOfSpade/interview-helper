// Pure view-model helpers for the practice-call window. They live in a plain
// .js module so the screen modules only export components (react-refresh).

export const MISSING_PRELOAD = Object.freeze({ phase: 'error', error: { code: 'preload-missing', message: 'The call window could not reach the app. Close it and start the call again from the hub.' } });

// The replay state shown when the saved call cannot be read; a fresh object each time.
export const replayLoadFailed = () => ({ audioUrl: null, durationMs: 0, transcript: [], chapters: [], feedback: null, analysis: { status: 'failed', error: 'The replay could not be loaded.' } });

export function mergeState(current, patch) {
  if (!patch || typeof patch !== 'object') return current;
  return { ...(current || {}), ...patch };
}

export function mergeEvent(current, event) {
  if (!event || typeof event !== 'object') return current;
  const next = { ...(current || {}) };
  if (event.phase) next.phase = event.phase;
  if (event.kind === 'chat' && event.message) next.chat = [...(Array.isArray(current?.chat) ? current.chat : []), event.message];
  if (event.kind === 'caption' && event.caption) next.captions = [...(Array.isArray(current?.captions) ? current.captions : []), event.caption].slice(-6);
  if (event.kind === 'timing' && event.elapsedMs != null) next.elapsedMs = event.elapsedMs;
  // Panel events from the service: a late colleague appears, and the speaker changes with playback.
  if (event.type === 'participant-joined' && event.id) {
    const known = Array.isArray(current?.participants) ? current.participants : [];
    if (!known.some(item => item?.id === event.id)) next.participants = [...known, { id: event.id, name: event.name || '', role: '', focus: '', status: 'joined' }];
  }
  if (event.type === 'speaker' && event.speakerId) next.speakingId = event.speakerId;
  if (event.kind === 'typing') next.typing = !!event.typing;
  return next;
}

// Sizes mirror docs/interview-practice-call-build.md ("models/"): Smart Turn v3
// and the wav2vec2 tone model. Shown before anything is downloaded.
export const MODEL_SIZES = Object.freeze([
  { name: 'Turn-taking model (Smart Turn v3)', size: '32 MB' },
  { name: 'Voice tone model (wav2vec2)', size: '610 MB download' },
]);

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const megabytes = value / (1024 * 1024);
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

export function downloadPercent(download) {
  const received = Number(download?.receivedBytes) || 0;
  const total = Number(download?.totalBytes) || 0;
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)));
}

// Post-call processing steps, in the order the service reports them.
export const ANALYSIS_STAGES = Object.freeze([
  { key: 'recording', label: 'Saving the recording' },
  { key: 'transcribing', label: 'Transcribing your answers' },
  { key: 'metrics', label: 'Measuring pace, pauses and tone' },
  { key: 'review', label: 'Writing the feedback' },
  { key: 'saving', label: 'Saving to your call history' },
]);

// An unknown or missing stage reads as the first step, never as a finished one.
export function analysisStageIndex(stage) {
  const index = ANALYSIS_STAGES.findIndex(item => item.key === stage);
  return index < 0 ? 0 : index;
}

export const levelPercent = level => {
  const value = Number(level);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100)));
};

export function humanizeKey(key) {
  return String(key).replace(/Ms$/u, '').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[-_]+/gu, ' ').toLowerCase();
}

// The delivery section is written by the post-call review and cites the
// measured metrics; the shape is open, so render whatever fields are present.
export function describeDeliveryValue(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) {
    return value.map(item => (item && typeof item === 'object'
      ? describeDeliveryValue(item.label ?? item.text ?? item.value ?? item)
      : String(item))).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    const cited = value.cited ?? value.metric ?? value.value ?? value.summary;
    if (cited != null && typeof cited !== 'object') return String(cited);
    return Object.entries(value).map(([key, item]) => `${humanizeKey(key)}: ${describeDeliveryValue(item)}`).filter(item => !item.endsWith(': ')).join('; ');
  }
  return String(value);
}

// The setup steps in the order the service runs them, as the candidate reads them.
export const SETUP_STEPS = Object.freeze([
  { step: 'account', label: 'Checking your voice account' },
  { step: 'voices', label: 'Choosing the interviewer voices' },
  { step: 'plan', label: 'Planning the interview', hint: 'the longest step, about a minute' },
  { step: 'voice', label: "Warming up the interviewer's voice" },
  { step: 'audio', label: 'Turning on your microphone' },
  { step: 'sessions', label: 'Bringing the interviewer in' },
]);

/** Each setup step as done, active or pending, from the step the service says is running. */
export function setupProgress(setup) {
  // 'ready' comes after the last step: everything is done and the call waits for the candidate.
  const at = setup?.step === 'ready' ? SETUP_STEPS.length : SETUP_STEPS.findIndex(item => item.step === setup?.step);
  const attempt = Number(setup?.attempt) || 1;
  return SETUP_STEPS.map((item, index) => ({
    ...item,
    status: at < 0 ? 'pending' : index < at ? 'done' : index === at ? 'active' : 'pending',
    // A plan the checks rejected is written again; say so instead of looking stuck.
    note: index === at && item.step === 'plan' && attempt > 1 ? `attempt ${attempt}` : '',
  }));
}

export const elapsedLabel = ms => {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

/** The call window's title, in every phase. It never names this app. */
export const CALL_WINDOW_TITLE = 'Virtual Call';

/**
 * What the missed-call screen says. `missed` is how the ring ended ('declined' or 'unanswered'),
 * or 'expired' once the caller has stopped waiting for the call to be returned.
 */
export function missedCallView(missed, firstName) {
  const who = firstName || 'They';
  if (missed === 'expired') return { label: 'Missed call', detail: `${who} ${firstName ? 'is' : 'are'} no longer available.`, canCallBack: false };
  if (missed === 'declined') return { label: 'Call declined', detail: `${who} tried to reach you.`, canCallBack: true };
  return { label: 'Missed call', detail: `${who} tried to reach you.`, canCallBack: true };
}
