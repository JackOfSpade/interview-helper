import fsPromises from 'node:fs/promises';
import path from 'node:path';

const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const AUDIO_FILES = Object.freeze(['call.m4a', 'candidate.wav', 'interviewer.wav']);
const DEBUG_FILE = 'debug.jsonl';
// Recorded during the call (the two tracks) and made after it (the mix), before call.m4a is encoded from the mix.
const RAW_AUDIO_FILES = Object.freeze(['candidate.wav', 'interviewer.wav', 'call.wav']);
export const DEBUG_LOGS_KEPT = 10;
// Only this many calls keep their recording (the owner's call, 2026-11-19); older ones keep the record and review.
export const RECORDINGS_KEPT = 10;

function storeError(code, message) {
  const error = new Error(`Practice call store: ${message}`);
  error.code = code;
  return error;
}

function checkId(value) {
  if (typeof value !== 'string' || !CALL_ID_RE.test(value)) throw storeError('INVALID_CALL_ID', 'invalid call id');
  return value;
}

const VISUAL_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,40}\.(?:jpg|png|webp|svg)$/u;

async function lstatOrNull(fs, target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonFile(fs, file) {
  const handle = await fs.open(file, 'r');
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw storeError('NOT_A_FILE', 'expected a regular file');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function readJsonIfPresent(fs, file) {
  const entry = await lstatOrNull(fs, file);
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile()) return null;
  try {
    return await readJsonFile(fs, file);
  } catch {
    return null;
  }
}

async function assertRealDirectory(fs, target) {
  const entry = await lstatOrNull(fs, target);
  if (!entry) return null;
  if (entry.isSymbolicLink()) throw storeError('SYMLINK', 'symbolic links are not followed');
  if (!entry.isDirectory()) throw storeError('NOT_A_DIRECTORY', 'expected a directory');
  return entry;
}

/**
 * `<userData>/practice-calls/<callId>/` (0700) holding call.json, the two WAV
 * tracks, call.m4a and analysis.json. Paths are derived only from validated
 * call ids; every filesystem hop refuses symbolic links.
 */
export function createCallStore({ rootDir, fs = fsPromises } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new TypeError('Practice call store requires an absolute root directory.');
  if (!fs || typeof fs.lstat !== 'function' || typeof fs.mkdir !== 'function') throw new TypeError('Practice call store requires a filesystem.');

  async function ensureRoot() {
    try {
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await assertRealDirectory(fs, rootDir);
    await fs.chmod(rootDir, 0o700);
  }

  async function ensure(callId) {
    const id = checkId(callId);
    await ensureRoot();
    const dir = path.join(rootDir, id);
    const existing = await assertRealDirectory(fs, dir);
    if (!existing) await fs.mkdir(dir, { mode: 0o700 });
    await fs.chmod(dir, 0o700);
    return dir;
  }

  async function dirOf(callId) {
    const id = checkId(callId);
    const dir = path.join(rootDir, id);
    return (await assertRealDirectory(fs, dir)) ? dir : null;
  }

  async function fileOf(callId, name) {
    const dir = await dirOf(callId);
    return dir ? path.join(dir, name) : null;
  }

  let tempSeq = 0;
  async function writeJson(callId, name, value) {
    checkId(callId);
    const dir = await ensure(callId);
    const file = path.join(dir, name);
    const entry = await lstatOrNull(fs, file);
    if (entry?.isSymbolicLink()) throw storeError('SYMLINK', 'symbolic links are not followed');
    // R13: a sibling temp file renamed into place never leaves a half-written record.
    tempSeq += 1;
    const temp = path.join(dir, `.${name}.${process.pid}.${tempSeq}.tmp`);
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, file);
    } catch (error) {
      try { await fs.unlink(temp); } catch { /* temp never existed */ }
      throw error;
    }
    return file;
  }

  /**
   * R8: an abandoned call never reached 'in-call', so its record, tracks and temp files are removed.
   * Its debug log stays (the folder with it), so a failed setup can still be diagnosed; the log is
   * pruned with the others once newer calls push it out of the newest ten.
   */
  async function remove(callId) {
    const dir = await dirOf(callId);
    if (!dir) return { removed: false };
    const kept = await lstatOrNull(fs, path.join(dir, DEBUG_FILE));
    if (!kept || !kept.isFile() || kept.isSymbolicLink()) {
      await fs.rm(dir, { recursive: true, force: true });
      return { removed: true };
    }
    for (const name of await fs.readdir(dir)) {
      if (name !== DEBUG_FILE) await fs.rm(path.join(dir, name), { recursive: true, force: true });
    }
    return { removed: true, keptDebugLog: true };
  }

  /**
   * Deletes debug.jsonl of every call folder except the newest `keep` by start time (a folder with no
   * call.json is ordered by its own change time) and `protect`. Nothing else is ever touched; an
   * emptied folder (a failed setup that kept only its log) is removed.
   */
  async function pruneDebugLogs({ keep = DEBUG_LOGS_KEPT, protect = null } = {}) {
    const calls = [];
    for (const callId of await api.knownCallIds()) {
      const dir = path.join(rootDir, callId);
      const record = await readJson(callId, 'call.json');
      let at = typeof record?.startedAt === 'number' ? record.startedAt : null;
      if (at === null) { const entry = await lstatOrNull(fs, dir); at = entry?.mtimeMs ?? 0; }
      calls.push({ callId, dir, at });
    }
    calls.sort((left, right) => right.at - left.at);
    const deleted = [];
    for (const item of calls.slice(Math.max(0, keep))) {
      if (item.callId === protect) continue;
      const file = path.join(item.dir, DEBUG_FILE);
      const entry = await lstatOrNull(fs, file);
      if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
      try { await fs.unlink(file); deleted.push(item.callId); } catch { /* left for the next prune */ }
      try {
        if (!(await fs.readdir(item.dir)).length) await fs.rmdir(item.dir);
      } catch { /* a folder with other files stays */ }
    }
    return { deleted };
  }

  /**
   * Raw audio a finished call no longer needs, by call folder (all but `protect`): the two tracks recorded during
   * the call and the uncompressed mix. They are the only copy of the audio until call.m4a exists, so each entry says
   * whether the folder has a record and a finished recording; the caller decides what to keep.
   */
  async function leftoverAudio({ protect = null } = {}) {
    const found = [];
    for (const callId of await api.knownCallIds()) {
      if (callId === protect) continue;
      const dir = path.join(rootDir, callId);
      const raw = [];
      for (const name of RAW_AUDIO_FILES) {
        const entry = await lstatOrNull(fs, path.join(dir, name));
        if (entry?.isFile() && !entry.isSymbolicLink()) raw.push({ name, bytes: entry.size || 0 });
      }
      if (!raw.length) continue;
      found.push({ callId, dir, raw, hasRecord: (await readJson(callId, 'call.json')) !== null, hasRecording: await api.hasAudio(callId) });
    }
    return found;
  }

  /** Deletes the named raw audio files of one call; anything else in the folder is never touched. */
  async function deleteRawAudio(callId, names) {
    const dir = await dirOf(callId);
    if (!dir) return { deleted: [] };
    const deleted = [];
    for (const name of names) {
      if (!RAW_AUDIO_FILES.includes(name)) continue;
      const file = path.join(dir, name);
      const entry = await lstatOrNull(fs, file);
      if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
      try { await fs.unlink(file); deleted.push(name); } catch { /* left for the next tidy */ }
    }
    return { deleted };
  }

  /** Call ids with a record, newest first by start time. */
  async function recordedCallsNewestFirst() {
    const calls = [];
    for (const callId of await api.knownCallIds()) {
      const record = await readJson(callId, 'call.json');
      if (record) calls.push({ callId, at: typeof record.startedAt === 'number' ? record.startedAt : 0 });
    }
    return calls.sort((left, right) => right.at - left.at).map(item => item.callId);
  }

  /**
   * Deletes the audio (deleteRecording) of every recorded call except the newest `keep` by start time and `protect`,
   * and marks its record `recordingPruned`, so its replay can say why there is nothing to play. The record, the review
   * and the debug log stay.
   */
  async function pruneRecordings({ keep = RECORDINGS_KEPT, protect = null } = {}) {
    const pruned = [];
    for (const callId of (await recordedCallsNewestFirst()).slice(Math.max(0, keep))) {
      if (callId === protect) continue;
      const { deleted } = await api.deleteRecording(callId);
      if (!deleted.length) continue;
      const record = await readJson(callId, 'call.json');
      if (record && record.recordingPruned !== true) await writeJson(callId, 'call.json', { ...record, recordingPruned: true });
      pruned.push({ callId, deleted });
    }
    return { pruned };
  }

  /** Count and size of the debug logs on disk, for the data-folder listing. */
  async function debugLogStats() {
    let count = 0;
    let bytes = 0;
    for (const callId of await api.knownCallIds()) {
      const entry = await lstatOrNull(fs, path.join(rootDir, callId, DEBUG_FILE));
      if (entry?.isFile() && !entry.isSymbolicLink()) { count += 1; bytes += entry.size || 0; }
    }
    return { count, bytes };
  }

  /**
   * For bug reports: every call with a debug log that started at or after `since` (the newest one
   * when none did), newest first, each with its folder, the whole log, the record's states and
   * counts, the transcript and the review's status.
   */
  async function recentDiagnostics({ since = null, limit = Infinity } = {}) {
    const calls = [];
    for (const callId of await api.knownCallIds()) {
      const file = path.join(rootDir, callId, DEBUG_FILE);
      const entry = await lstatOrNull(fs, file);
      if (!entry?.isFile() || entry.isSymbolicLink()) continue;
      const record = await readJson(callId, 'call.json');
      const at = typeof record?.startedAt === 'number' ? record.startedAt : (entry.mtimeMs ?? 0);
      calls.push({ callId, file, bytes: entry.size || 0, changedAt: entry.mtimeMs ?? null, at, record });
    }
    calls.sort((left, right) => right.at - left.at);
    const inRun = Number.isFinite(since) ? calls.filter(item => item.at >= since) : calls;
    const chosen = (inRun.length ? inRun : calls.slice(0, 1)).slice(0, Math.max(0, limit));
    const out = [];
    for (const item of chosen) {
      let text = '';
      try { text = await fs.readFile(item.file, 'utf8'); } catch { text = null; }
      const record = item.record;
      const analysis = record ? await readJson(item.callId, 'analysis.json') : null;
      out.push({
        callId: item.callId,
        dir: path.join(rootDir, item.callId),
        startedAt: typeof record?.startedAt === 'number' ? record.startedAt : null,
        changedAt: item.changedAt,
        bytes: item.bytes,
        text,
        transcript: Array.isArray(record?.transcript) ? record.transcript : [],
        record: record ? {
          durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
          pausedMs: typeof record.pausedMs === 'number' ? record.pausedMs : null,
          reason: typeof record.reason === 'string' ? record.reason : null,
          endedBy: typeof record.endedBy === 'string' ? record.endedBy : null,
          returnedCall: typeof record.returnedCall === 'string' ? record.returnedCall : null,
          transcriptEntries: Array.isArray(record.transcript) ? record.transcript.length : 0,
          candidateTurns: Array.isArray(record.transcript) ? record.transcript.filter(turn => turn?.speaker === 'candidate').length : 0,
          interviewers: (record.persona ? 1 : 0) + (Array.isArray(record.panel) ? record.panel.length : 0),
          answeredQuestions: Array.isArray(record.answeredQuestions) ? record.answeredQuestions.length : 0,
          setupAttempts: Array.isArray(record.setup?.attempts) ? record.setup.attempts.length : null,
          timings: record.timings && typeof record.timings === 'object'
            ? Object.fromEntries(Object.entries(record.timings).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))
            : null,
          pickedQuestions: Array.isArray(record.pickedQuestions) ? record.pickedQuestions.length : 0,
          askedQuestions: Array.isArray(record.askedQuestions) ? record.askedQuestions.length : 0,
          // Who asked the unprepared question (it is outside the picked/asked counts); the bug report notes it.
          unpreparedQuestion: record.unpreparedQuestion && typeof record.unpreparedQuestion === 'object'
            ? { askedBy: typeof record.unpreparedQuestion.askedBy === 'string' ? record.unpreparedQuestion.askedBy : null }
            : null,
          feedbackSkipped: record.feedbackSkipped === true,
          recordingPruned: record.recordingPruned === true,
        } : null,
        analysis: analysis ? {
          status: typeof analysis.status === 'string' ? analysis.status : null,
          tooShort: analysis.tooShort === true,
          error: typeof analysis.error === 'string' ? analysis.error : null,
          metricsError: typeof analysis.metricsError === 'string' ? analysis.metricsError : null,
          chapters: Array.isArray(analysis.chapters) ? analysis.chapters.length : 0,
          hasFeedback: !!analysis.feedback,
        } : null,
        hasAudio: await api.hasAudio(item.callId),
      });
    }
    return out;
  }

  async function readJson(callId, name) {
    const file = await fileOf(callId, name);
    return file ? readJsonIfPresent(fs, file) : null;
  }

  function summarize(callId, record, analysis) {
    return {
      callId,
      startedAt: typeof record?.startedAt === 'number' ? record.startedAt : null,
      durationMs: typeof record?.durationMs === 'number' ? record.durationMs : 0,
      ...(typeof record?.pausedMs === 'number' && record.pausedMs > 0 ? { pausedMs: record.pausedMs } : {}),
      persona: record?.persona ? { name: record.persona.name, role: record.persona.role } : null,
      hasAudio: false,
      analysisStatus: analysis?.status === 'ready' || analysis?.status === 'failed' ? analysis.status : 'missing',
    };
  }

  const api = Object.freeze({
    rootDir,
    pruneDebugLogs,
    debugLogStats,
    recentDiagnostics,
    leftoverAudio,
    deleteRawAudio,
    pruneRecordings,
    recordedCallsNewestFirst,
    ensure,
    remove,
    callDir: dirOf,
    async readRecord(callId) {
      return readJson(callId, 'call.json');
    },
    async writeRecord(callId, record) {
      return writeJson(callId, 'call.json', record);
    },
    async readAnalysis(callId) {
      return readJson(callId, 'analysis.json');
    },
    async writeAnalysis(callId, analysis) {
      return writeJson(callId, 'analysis.json', analysis);
    },
    async audioPath(callId) {
      return fileOf(callId, 'call.m4a');
    },
    /** A picture or diagram made for one of the call's shared screens: only a plain file name in its visuals folder. */
    async visualPath(callId, name) {
      if (typeof name !== 'string' || !VISUAL_NAME.test(name) || name.includes('..')) return null;
      const dir = await dirOf(callId);
      return dir ? path.join(dir, 'visuals', name) : null;
    },
    async hasAudio(callId) {
      const file = await fileOf(callId, 'call.m4a');
      const entry = file ? await lstatOrNull(fs, file) : null;
      return !!entry && entry.isFile() && !entry.isSymbolicLink();
    },
    async hasCall(callId) {
      return (await readJson(callId, 'call.json')) !== null;
    },
    async knownCallIds() {
      await ensureRoot();
      const entries = await fs.readdir(rootDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && CALL_ID_RE.test(entry.name))
        .map(entry => entry.name);
    },
    async list(nodeId) {
      if (typeof nodeId !== 'string' || !nodeId) return [];
      const calls = [];
      for (const callId of await this.knownCallIds()) {
        const record = await readJson(callId, 'call.json');
        if (!record || record.nodeId !== nodeId) continue;
        const analysis = await readJson(callId, 'analysis.json');
        const item = summarize(callId, record, analysis);
        item.hasAudio = await this.hasAudio(callId);
        calls.push(item);
      }
      calls.sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0));
      return calls;
    },
    /** Audio only: the transcript, analysis and call record always stay. */
    async deleteRecording(callId) {
      const dir = await dirOf(callId);
      if (!dir) return { deleted: [] };
      const deleted = [];
      for (const name of AUDIO_FILES) {
        const file = path.join(dir, name);
        const entry = await lstatOrNull(fs, file);
        if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
        await fs.unlink(file);
        deleted.push(name);
      }
      return { deleted };
    },
  });
  return api;
}

export const PRACTICE_CALL_AUDIO_FILES = AUDIO_FILES;
export const isPracticeCallId = value => typeof value === 'string' && CALL_ID_RE.test(value);
