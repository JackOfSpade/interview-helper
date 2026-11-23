// A short memory of what happened in the main window, for bug reports.
//
// Holds the lines of this run: buttons pressed, uncaught errors, rejected
// promises and console warnings and errors. It lives in memory only and is
// read when the person makes a bug report.

const MAX_LINES = 20_000;
const lines = [];
const listeners = new Set();
let dropped = 0;

function describe(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export function logEvent(kind, ...details) {
  const text = details.map(describe).join(' ').replace(/\s+/gu, ' ').trim();
  const line = `[${new Date().toISOString()}] ${kind}${text ? ` ${text}` : ''}`;
  lines.push(line);
  if (lines.length > MAX_LINES) { lines.shift(); dropped += 1; }
  for (const listener of listeners) { try { listener(line); } catch { /* a listener cannot break recording */ } }
}

/** Calls `listener(line)` for every later line (the practice call window forwards them). Returns a function that stops it. */
export function onEventLine(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const eventLogSnapshot = () => ({ events: [...lines], eventsDropped: dropped });
export function resetEventLogForTest() { lines.length = 0; dropped = 0; listeners.clear(); }

/** What a pressed control is called: its accessible name, else its visible text. */
export function controlName(element) {
  const name = element?.getAttribute?.('aria-label') || element?.textContent || element?.getAttribute?.('title') || '';
  const text = String(name).replace(/\s+/gu, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * Starts recording in this window. Returns a function that stops it. `nameControl(control)` names a
 * pressed control instead of the default.
 */
export function installEventCapture(target = window, { nameControl = null } = {}) {
  if (!target || target.__interviewEventCapture) return () => {};
  const onError = event => logEvent('ERROR', event?.error || event?.message || 'error');
  const onRejection = event => logEvent('ERROR unhandled rejection:', event?.reason ?? 'unknown');
  const onClick = (event) => {
    const control = event?.target?.closest?.('button, a, [role="button"], [role="tab"], summary');
    if (!control) return;
    let name;
    try { name = typeof nameControl === 'function' ? nameControl(control) : controlName(control); } catch { name = '(a control)'; }
    logEvent('click', `"${name}"`);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('click', onClick, true);
  const original = { error: target.console?.error, warn: target.console?.warn };
  for (const level of ['error', 'warn']) {
    if (typeof original[level] !== 'function') continue;
    target.console[level] = (...args) => {
      try { logEvent(level === 'error' ? 'ERROR console:' : 'WARN console:', ...args); } catch { /* recording cannot break logging */ }
      original[level].apply(target.console, args);
    };
  }
  target.__interviewEventCapture = true;
  logEvent('window opened');
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('click', onClick, true);
    for (const level of ['error', 'warn']) if (original[level]) target.console[level] = original[level];
    target.__interviewEventCapture = false;
  };
}

/** Status and error messages currently on screen, outside the given element. */
export function screenMessages(doc = document, exclude = null) {
  const seen = new Set();
  for (const element of doc.querySelectorAll('[role="alert"], [role="status"]')) {
    if (exclude?.contains?.(element) || element.closest?.('[hidden]')) continue;
    const text = String(element.textContent || '').replace(/\s+/gu, ' ').trim();
    if (text) seen.add(`${element.getAttribute('role')}: ${text}`);
    if (seen.size >= 30) break;
  }
  return [...seen];
}
