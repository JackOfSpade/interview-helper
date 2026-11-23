// What the practice call window records for bug reports: buttons pressed (by their label), uncaught
// errors, rejected promises and console warnings and errors (src/utils/eventLog.js), forwarded to the
// main process, which adds them to the call's debug log and keeps them for a report.
import { installEventCapture, logEvent, onEventLine } from '../utils/eventLog.js';

/** Starts recording in the call window and forwards each line through `api.logEvent`. Returns a stop function. */
export function installCallEventCapture(api, target = typeof window === 'undefined' ? null : window) {
  if (!target || typeof api?.logEvent !== 'function') return () => {};
  const send = (line) => {
    try { const result = api.logEvent(line); if (typeof result?.catch === 'function') result.catch(() => {}); } catch { /* the window keeps working */ }
  };
  const stopForwarding = onEventLine(send);
  const stopCapture = installEventCapture(target);
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
