// What the practice call window records for bug reports: buttons pressed, uncaught errors, rejected
// promises and console warnings and errors (src/utils/eventLog.js), forwarded to the main process,
// which adds them to the call's debug log and keeps the last few hundred for a report.
//
// Controls here can carry private text (a transcript turn, a chapter title, a chat message), so a
// pressed control is named only by an accessible label from the fixed set below or a fixed button text.
import { controlName, installEventCapture, logEvent, onEventLine } from '../utils/eventLog.js';

// Labels that are built from call content are reduced to what was done.
const LABEL_PATTERNS = [
  [/^Seek to /u, 'Seek to a moment'],
  [/^Current chapter:/u, 'Show chapters'],
];
const KNOWN_NAMES = new Set([
  'Agree and download', 'Starting…', "I'm ready", 'Answer call', 'Decline call', 'Close', 'Call back', 'End call',
  'Mute microphone', 'Unmute microphone', 'Turn off camera', 'Turn on camera', 'Captions', 'Hang up', 'Notes', 'Chat',
  'Close notes', 'Close chat', 'Suggest a reply', 'Send chat message', 'Get feedback', 'Skip feedback',
  'Open Microphone settings', 'Close window', 'Play recording', 'Pause recording', 'Delete recording',
  'Confirm delete recording', 'Delete', 'Keep recording', 'Ready', 'New message',
]);

export function callControlName(control) {
  const label = String(control?.getAttribute?.('aria-label') || '').replace(/\s+/gu, ' ').trim();
  for (const [pattern, name] of LABEL_PATTERNS) if (pattern.test(label)) return name;
  const name = label || controlName(control);
  return KNOWN_NAMES.has(name) ? name : '(a control)';
}

/** Starts recording in the call window and forwards each line through `api.logEvent`. Returns a stop function. */
export function installCallEventCapture(api, target = typeof window === 'undefined' ? null : window) {
  if (!target || typeof api?.logEvent !== 'function') return () => {};
  const send = (line) => {
    try { const result = api.logEvent(line); if (typeof result?.catch === 'function') result.catch(() => {}); } catch { /* the window keeps working */ }
  };
  const stopForwarding = onEventLine(send);
  const stopCapture = installEventCapture(target, { nameControl: callControlName });
  // A recording that fails to load or decode raises `error` on the <audio> element, which does not bubble.
  const onMediaError = (event) => {
    const media = event?.target;
    if (!media || typeof media.tagName !== 'string' || !/^(?:AUDIO|VIDEO)$/u.test(media.tagName)) return;
    logEvent('ERROR media:', media.tagName.toLowerCase(), `code ${media.error?.code ?? '?'}`, media.error?.message || '', `networkState ${media.networkState ?? '?'}`, `readyState ${media.readyState ?? '?'}`);
  };
  target.addEventListener?.('error', onMediaError, true);
  return () => { target.removeEventListener?.('error', onMediaError, true); stopCapture(); stopForwarding(); };
}

export { logEvent };
