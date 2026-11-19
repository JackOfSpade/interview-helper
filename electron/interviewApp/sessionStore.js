// Saved interviews of the standalone Interview Helper app.
//
// One interview here is what one Interview Helper node was on the canvas: the
// same `interviewHelper*` fields, under the same id, so the Q&A, practice
// history and prepared brief stored per id keep lining up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INTERVIEW_SESSIONS_VERSION = 1;
const MAX_SESSIONS = 200;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/u;
const DATA_KEY = /^(?:interviewHelper[A-Za-z]{1,60}|practiceSteering)$/u;

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => (typeof value === 'string' && value.length <= limit ? value : '');

/** Only the Interview Helper's own fields; canvas-only state (lock, drag cue) is dropped. */
export function interviewSessionData(data) {
  const result = {};
  if (!isRecord(data)) return result;
  for (const [key, value] of Object.entries(data)) {
    if (!DATA_KEY.test(key) || value === undefined || typeof value === 'function') continue;
    result[key] = value;
  }
  return result;
}

function normalizeSession(value) {
  if (!isRecord(value) || !SESSION_ID.test(value.id || '')) return null;
  return {
    id: value.id,
    title: text(value.title, 200).trim(),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
    data: interviewSessionData(value.data),
  };
}

export function normalizeInterviewSessionsState(value) {
  const seen = new Set();
  const sessions = [];
  for (const item of Array.isArray(value?.sessions) ? value.sessions : []) {
    const session = normalizeSession(item);
    if (!session || seen.has(session.id) || sessions.length >= MAX_SESSIONS) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  const folder = text(value?.appliedJobsFolder, 4096);
  return {
    version: INTERVIEW_SESSIONS_VERSION,
    sessions,
    selectedId: seen.has(value?.selectedId) ? value.selectedId : (sessions[0]?.id || null),
    appliedJobsFolder: folder && path.isAbsolute(folder) ? folder : null,
  };
}

export function createInterviewSessionStore({ filePath } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('Interview sessions need an absolute file path.');
  let cached = null;
  let queue = Promise.resolve();
  const serialized = task => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };

  async function read() {
    let raw;
    try { raw = await fs.promises.readFile(filePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return normalizeInterviewSessionsState(null); throw error; }
    // An unreadable file must not be silently replaced by an empty list on the next save.
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('The saved interviews file is damaged and was left untouched.'); }
    return normalizeInterviewSessionsState(parsed);
  }

  return Object.freeze({
    // Resolves once every save asked for so far is on disk; quitting waits for it.
    flush: () => queue.then(() => undefined),
    load: () => serialized(async () => { cached ||= await read(); return structuredClone(cached); }),
    save: state => serialized(async () => {
      const next = normalizeInterviewSessionsState(state);
      const body = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error('The saved interviews are too large to store.');
      // Make sure an existing file was readable before it is ever replaced.
      cached ||= await read();
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.promises.writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
        await fs.promises.rename(temporary, filePath);
      } catch (error) {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      cached = next;
      return structuredClone(next);
    }),
  });
}


// ------------------------------------------------------- a saved state file --

const STATE_FILE_KIND = 'interview-helper-state';
const STATE_FILE_VERSION = 1;

/**
 * The text of a state file the person saves: the interview list as it is stored, in a
 * wrapper that says what the file is. It holds the list only. Career text, Q&A, briefs and
 * recordings stay in the app's data folder and are found again by each interview's id.
 */
export function encodeInterviewStateFile(state, now = Date.now()) {
  return `${JSON.stringify({ kind: STATE_FILE_KIND, version: STATE_FILE_VERSION, savedAt: new Date(now).toISOString(), state: normalizeInterviewSessionsState(state) }, null, 2)}\n`;
}

/** The state in a saved file. Anything that is not a state file saved by this app is refused. */
export function decodeInterviewStateFile(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error('That file is too large to be a saved Interview Helper state.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('That file is not a saved Interview Helper state.'); }
  if (!isRecord(parsed) || parsed.kind !== STATE_FILE_KIND || !isRecord(parsed.state) || !Array.isArray(parsed.state.sessions)) throw new Error('That file is not a saved Interview Helper state.');
  if (parsed.version !== STATE_FILE_VERSION) throw new Error('That file was saved by a newer version of Interview Helper.');
  return normalizeInterviewSessionsState(parsed.state);
}

/**
 * Asks the window to send its newest state now and waits for it, so closing the window or
 * quitting the app never drops a change that had not been written yet. Resolves true when
 * the window answered, false when it could not (already gone, still loading, or too slow).
 */
export function saveWindowStateNow({ win, ipcMain, timeoutMs = 2000 }) {
  let contents;
  try {
    contents = win && !win.isDestroyed() ? win.webContents : null;
    if (!contents || contents.isDestroyed() || contents.isLoading()) return Promise.resolve(false);
  } catch { return Promise.resolve(false); }
  return new Promise((resolve) => {
    let timer = null;
    const done = (answered) => { clearTimeout(timer); ipcMain.removeListener(STATE_SAVED_NOW_CHANNEL, onAnswer); resolve(answered); };
    const onAnswer = (event) => { if (event?.sender === contents) done(true); };
    timer = setTimeout(() => done(false), timeoutMs);
    ipcMain.on(STATE_SAVED_NOW_CHANNEL, onAnswer);
    try { contents.send(STATE_SAVE_NOW_CHANNEL); } catch { done(false); }
  });
}
export const STATE_SAVE_NOW_CHANNEL = 'interview-app:save-state-now';
export const STATE_SAVED_NOW_CHANNEL = 'interview-app:state-saved-now';
