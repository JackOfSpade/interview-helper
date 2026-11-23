import nodeFs from 'node:fs/promises';
import path from 'node:path';

// How many past calls asked each prepared question or technical topic. Counts are filed per
// posting (or per interview, for one with no posting yet), and under `general` for the General questions. It only steers which questions the
// interviewer favours next time, so it is small, forgiving and never allowed to stop a call.
const MAX_JOBS = 200;
// What each topic's earlier exercises and the planner's own questions were, so the next call can pick a different one
// (seen 2026-11-23, call-mwtb4q1v-9xcsen: a topic came round again and nothing stopped the same problem being written).
// Newest last; one line each, kept short because they go back into prompts.
const MAX_NOTES_PER_ID = 5;
const MAX_OWN_NOTES = 8;
const NOTE_CHARS = 300;
const MAX_NOTE_IDS = 60;

/** One line, whitespace collapsed, cut at a word end when it is too long. Empty when there is nothing. */
export function noteText(value) {
  const line = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (line.length <= NOTE_CHARS) return line;
  const cut = line.slice(0, NOTE_CHARS + 1);
  const space = cut.lastIndexOf(' ');
  // A cut that lands inside a surrogate pair drops the lone half.
  return (space > NOTE_CHARS / 2 ? cut.slice(0, space) : cut.slice(0, NOTE_CHARS)).replace(/[\uD800-\uDBFF]$/u, '').trim();
}
const sameNote = (a, b) => a.toLowerCase() === b.toLowerCase();

/** A note list read from a file: malformed entries dropped, same limits as when written. */
function cleanNotes(value, limit) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    const raw = typeof item === 'string' ? item : item?.text;
    const text = typeof raw === 'string' ? noteText(raw) : '';
    if (!text) continue;
    const at = Number.isFinite(Number(item?.at)) ? Number(item.at) : 0;
    const found = out.findIndex(entry => sameNote(entry.text, text));
    if (found >= 0) out.splice(found, 1);
    out.push({ text, at });
  }
  return out.slice(-limit);
}
function cleanAsked(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, list] of Object.entries(value)) {
    if (!id) continue;
    const notes = cleanNotes(list, MAX_NOTES_PER_ID);
    if (notes.length) out[id] = notes;
  }
  return out;
}
/** Adds one note as the newest: an identical one (case and whitespace aside) is refreshed and moves last. */
function addNote(list, raw, at, limit) {
  const text = noteText(raw);
  if (!text) return list;
  const next = list.filter(entry => !sameNote(entry.text, text));
  next.push({ text, at });
  return next.slice(-limit);
}

function cleanCounts(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, count] of Object.entries(value)) {
    const n = Number(count);
    if (id && Number.isInteger(n) && n > 0) out[id] = n;
  }
  return out;
}

export function createQuestionHistory({ filePath, fs = nodeFs } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('Question history requires a file path.');
  // File shape: { version: 1, jobs: { [nodeId]: { counts: { [questionId]: n }, asked?: { [questionId]: [{ text, at }] }, own?: [{ text, at }], updatedAt } } }.
  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const jobs = {};
      const source = parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object' && !Array.isArray(parsed.jobs) ? parsed.jobs : {};
      for (const [nodeId, entry] of Object.entries(source)) {
        if (!nodeId || !entry || typeof entry !== 'object') continue;
        jobs[nodeId] = { counts: cleanCounts(entry.counts), asked: cleanAsked(entry.asked), own: cleanNotes(entry.own, MAX_OWN_NOTES), updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0 };
      }
      return jobs;
    } catch (error) {
      // Only a missing or malformed file reads as empty. Any other read failure is passed on, so a
      // file that is briefly unreadable is never replaced by one holding a single job.
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return {};
      throw error;
    }
  }
  let writes = 0;
  // One read-modify-write at a time, so two calls ending together both keep their counts.
  let queue = Promise.resolve();
  async function save(jobs) {
    // Atomic: a crash mid-write leaves the old file, never half of a new one.
    writes += 1;
    const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.${writes}.tmp`;
    await fs.mkdir?.(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, jobs }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, filePath);
    } catch (error) {
      try { await fs.rm?.(tmp, { force: true }); } catch { /* nothing to clean up */ }
      throw error;
    }
  }
  return Object.freeze({
    async counts(nodeId) {
      if (typeof nodeId !== 'string' || !nodeId) return {};
      return { ...((await load())[nodeId]?.counts || {}) };
    },
    /** What earlier calls asked: `asked` per question id and `own` (the planner's own questions), oldest first. */
    async notes(nodeId) {
      const job = typeof nodeId === 'string' && nodeId ? (await load())[nodeId] : null;
      return {
        asked: Object.fromEntries(Object.entries(job?.asked || {}).map(([id, list]) => [id, list.map(entry => entry.text)])),
        own: (job?.own || []).map(entry => entry.text),
      };
    },
    /** Gives `toKey` the counts of `fromKey` when `toKey` has none yet (an interview's set became its posting's set). */
    adopt(fromKey, toKey) {
      if (typeof fromKey !== 'string' || !fromKey || typeof toKey !== 'string' || !toKey || fromKey === toKey) return Promise.resolve(false);
      const run = queue.then(async () => {
        const jobs = await load();
        const from = jobs[fromKey];
        // Notes alone are worth carrying: a call that asked only the planner's own question leaves no count.
        if (jobs[toKey] || !from || !(Object.keys(from.counts).length || Object.keys(from.asked || {}).length || (from.own || []).length)) return false;
        jobs[toKey] = { counts: { ...jobs[fromKey].counts }, asked: structuredClone(jobs[fromKey].asked || {}), own: structuredClone(jobs[fromKey].own || []), updatedAt: Date.now() };
        await save(jobs);
        return true;
      });
      queue = run.catch(() => {});
      return run;
    },
    /**
     * Counts one more call for each id. `notes` (optional) is what the call asked, written in the same read-modify-write:
     * `{ asked: { [id]: text }, own: text }`. A note never adds a count; it is kept even when `questionIds` is empty
     * (an own question asked but not answered still must not be asked again).
     */
    record(nodeId, questionIds, notes) {
      if (typeof nodeId !== 'string' || !nodeId) return Promise.resolve();
      const ids = [...new Set((Array.isArray(questionIds) ? questionIds : []).filter(id => typeof id === 'string' && id))];
      const asked = Object.entries(notes?.asked && typeof notes.asked === 'object' ? notes.asked : {}).filter(([id, text]) => id && noteText(text)).slice(0, MAX_NOTE_IDS);
      const own = noteText(notes?.own);
      if (!ids.length && !asked.length && !own) return Promise.resolve();
      const run = queue.then(() => write(nodeId, ids, { asked, own }));
      queue = run.catch(() => {});
      return run;
    },
  });
  async function write(nodeId, ids, notes) {
    const jobs = await load();
    const counts = { ...(jobs[nodeId]?.counts || {}) };
    for (const id of ids) counts[id] = (counts[id] || 0) + 1;
    const at = Date.now();
    const askedNotes = { ...(jobs[nodeId]?.asked || {}) };
    for (const [id, text] of notes.asked) askedNotes[id] = addNote(askedNotes[id] || [], text, at, MAX_NOTES_PER_ID);
    const own = notes.own ? addNote(jobs[nodeId]?.own || [], notes.own, at, MAX_OWN_NOTES) : (jobs[nodeId]?.own || []);
    // Date.now() ties are broken by insertion order below, so a quick burst still drops the oldest.
    const stamp = Math.max(Date.now(), ...Object.values(jobs).map(job => job.updatedAt + 1));
    delete jobs[nodeId];
    jobs[nodeId] = { counts, asked: askedNotes, own, updatedAt: stamp };
    const keep = Object.entries(jobs).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_JOBS);
    await save(Object.fromEntries(keep));
  }
}

export default createQuestionHistory;
