import path from 'node:path';

export const DEBUG_LOG_FILE = 'debug.jsonl';
const STRING_CAP = 2000;
const MAX_DEPTH = 6;
const MAX_ITEMS = 60;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Keys whose value is never written: audio samples and secrets.
const SKIP_KEY = /^(?:pcm|audio|samples|chunk|buffer|data64|base64|bytes)$|^(?:api)?key$|apikey|secret|authorization|password|^(?:access|auth|bearer)?token$/iu;
const PATH_IN_TEXT = /(^|[\s"'(=:,[])(\/[^\s"'()<>,]+\/[^\s"'()<>,]*)/gu;

/**
 * Turns a value into plain JSON-safe data: strings capped, audio and secrets left out, paths outside
 * the call folder replaced. Never throws.
 */
export function sanitizeForDebug(value, dir = '', depth = 0) {
  try {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string') return sanitizeString(value, dir);
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (value instanceof Error) return { error: sanitizeString(value.message || String(value), dir), code: value.code ?? undefined };
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
    if (depth >= MAX_DEPTH) return '[deep]';
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map(item => sanitizeForDebug(item, dir, depth + 1));
      if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more]`);
      return items;
    }
    const out = {};
    let count = 0;
    for (const [name, item] of Object.entries(value)) {
      if (SKIP_KEY.test(name)) continue;
      if (count >= MAX_ITEMS) { out['…'] = 'more keys'; break; }
      const clean = sanitizeForDebug(item, dir, depth + 1);
      if (clean !== undefined) { out[name] = clean; count += 1; }
    }
    return out;
  } catch {
    return '[unreadable]';
  }
}

function sanitizeString(text, dir) {
  let result = text.replace(PATH_IN_TEXT, (match, lead, file) => {
    if (dir && (file === dir || file.startsWith(`${dir}/`))) return `${lead}${path.relative(dir, file) || '.'}`;
    return match; // links and other paths are kept whole: only secrets are masked in diagnostics
  });
  if (result.length > STRING_CAP) result = `${result.slice(0, STRING_CAP)}…[${result.length - STRING_CAP} more characters]`;
  return result;
}

/**
 * Best-effort per-call debug log: one JSON line per event appended to `<call folder>/debug.jsonl`
 * (0600). Writes are queued and ordered; a failing filesystem is counted, never thrown, and nothing
 * here waits for the caller. A log with no folder or no appendFile does nothing.
 */
export function createCallDebugLog({ fs, dir, now = () => Date.now() } = {}) {
  const enabled = typeof dir === 'string' && path.isAbsolute(dir) && typeof fs?.appendFile === 'function';
  const file = enabled ? path.join(dir, DEBUG_LOG_FILE) : null;
  const createdAt = now();
  let callStartAt = null;
  let queue = [];
  let draining = null;
  let written = 0;
  let failures = 0;
  let closed = false;

  async function drain() {
    while (queue.length) {
      const batch = queue.join('');
      queue = [];
      if (written + batch.length > MAX_FILE_BYTES) { failures += 1; continue; }
      try {
        await fs.appendFile(file, batch, { mode: 0o600 });
        written += batch.length;
      } catch { failures += 1; }
    }
  }

  function schedule() {
    if (draining) return;
    draining = Promise.resolve().then(drain).catch(() => {}).finally(() => { draining = null; if (queue.length) schedule(); });
  }

  return Object.freeze({
    enabled,
    file,
    /** The call is answered: `ms` on later lines counts from here. */
    startCallClock(at = now()) { callStartAt = at; },
    /** One line. `fields` is cleaned before it is written. */
    log(event, fields) {
      if (!enabled || closed) return;
      try {
        const at = now();
        const line = { t: new Date(at).toISOString(), up: Math.max(0, Math.round(at - createdAt)), ms: callStartAt === null ? null : Math.round(at - callStartAt), event };
        if (fields !== undefined) line.data = sanitizeForDebug(fields, dir);
        let text = JSON.stringify(line);
        if (text.length > STRING_CAP * 8) text = JSON.stringify({ ...line, data: '[too large]' });
        queue.push(`${text}\n`);
        schedule();
      } catch { /* a log line never costs the call */ }
    },
    /** Resolves once everything logged so far is on disk (or has failed). Never rejects. */
    async flush() {
      try {
        while (draining || queue.length) {
          if (!draining) schedule();
          await draining;
        }
      } catch { /* best effort */ }
    },
    /** Flushes, then ignores later lines, so a removed folder is never recreated. */
    async close() {
      await this.flush();
      closed = true;
    },
    stats() { return { written, failures }; },
  });
}
