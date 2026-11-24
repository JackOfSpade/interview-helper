import fsPromises from 'node:fs/promises';
import path from 'node:path';

/**
 * Interviews kept so the same one can be held again without planning it anew:
 * `<userData>/practice-interviews/<id>/interview.json` plus its `visuals/` files.
 *
 * What is kept is the setup a call was made from (the drawn voices, the plan with its length, who joins late and
 * the lead's temperament in the planner's own words, the colleagues' join draws as they came out so a retake
 * replays them, the questions it picked and the pictures and diagrams on its screens). An interview kept
 * before the planner chose the length, the late joins or the temperament lacks those fields and still loads. Measured on
 * the calls on disk (2026-11-21) the JSON is 4 to 25 KB; the visuals are what can make one big
 * (an SVG is a few KB, a photo up to 5 MB, at most 4 per interview). So a few are kept per job
 * and company, a few dozen in all, under a byte budget that only photo-heavy interviews reach;
 * the least recently used goes first.
 */
export const SAVED_PER_JOB = 5;
export const SAVED_TOTAL = 40;
export const SAVED_BYTES = 100 * 1024 * 1024;
export const SAVED_VERSION = 1;

const ID_RE = /^iv-[a-z0-9]{4,16}-[a-z0-9]{4,12}$/u;
const VISUAL_FILE_RE = /^[A-Za-z0-9._-]{1,80}\.(?:svg|png|jpg|webp)$/u;
const FILE = 'interview.json';

export const isSavedInterviewId = value => typeof value === 'string' && ID_RE.test(value);

async function lstatOrNull(fs, target) {
  try { return await fs.lstat(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/** The short view a list shows: who interviews, what it covers, when it was held. Never the plan itself. */
export function summarizeSavedInterview(entry) {
  const plan = entry?.planned?.plan ?? {};
  const byKey = new Map((entry?.drawnVoices || []).map(voice => [voice.key, voice]));
  const lead = byKey.get(plan.lead?.voice);
  const nameOf = person => String(person?.name ?? '').replace(/\s+/gu, ' ').trim();
  const questions = Array.isArray(plan.questions) ? plan.questions : [];
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    timesUsed: entry.timesUsed,
    company: entry.company || '',
    role: entry.role || '',
    interviewKind: String(plan.interviewKind || ''),
    // The plan names each person; an interview kept from before it did has the names on its voices.
    lead: { name: nameOf(plan.lead) || lead?.name || '', role: String(plan.lead?.role || '') },
    panel: (Array.isArray(plan.panel) ? plan.panel : []).map(member => ({ name: nameOf(member) || byKey.get(member.voice)?.name || '', role: String(member.role || '') })),
    questionCount: questions.length,
    problemCount: Array.isArray(plan.problems) ? plan.problems.length : 0,
    // The length the planner chose for the call; an interview kept from before it did has the question budgets' sum.
    minutes: Number(plan.callMinutes) > 0 ? Math.round(Number(plan.callMinutes)) : Math.round(questions.reduce((sum, question) => sum + (Number(question.minutes) || 0), 0)),
    steering: entry.steering || '',
  };
}

export function createSavedInterviewStore({ rootDir, fs = fsPromises, now = () => Date.now(), random = Math.random, perJob = SAVED_PER_JOB, total = SAVED_TOTAL, maxBytes = SAVED_BYTES } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new TypeError('Saved interviews need an absolute root directory.');

  const dirOf = id => {
    if (!isSavedInterviewId(id)) throw new TypeError('Not a saved interview id.');
    return path.join(rootDir, id);
  };
  let tempSeq = 0;
  async function writeJson(dir, value) {
    tempSeq += 1;
    const temp = path.join(dir, `.${FILE}.${process.pid}.${tempSeq}.tmp`);
    try {
      await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await fs.rename(temp, path.join(dir, FILE));
    } catch (error) {
      try { await fs.unlink(temp); } catch { /* never written */ }
      throw error;
    }
  }
  async function readEntry(id) {
    const dir = dirOf(id);
    const stat = await lstatOrNull(fs, dir);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null;
    try {
      const entry = JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8'));
      return entry && entry.version === SAVED_VERSION && entry.id === id ? entry : null;
    } catch { return null; }
  }
  async function all() {
    let names = [];
    try { names = await fs.readdir(rootDir); } catch { return []; }
    const read = await Promise.all(names.filter(isSavedInterviewId).map(readEntry));
    return read.filter(Boolean);
  }
  const lastUsed = entry => Number(entry.lastUsedAt) || Number(entry.createdAt) || 0;

  async function remove(id) {
    await fs.rm(dirOf(id), { recursive: true, force: true });
  }

  /** Least recently used first out: past SAVED_PER_JOB for one job, past SAVED_TOTAL or SAVED_BYTES in all. `keep` is never removed. */
  async function prune(keep) {
    const entries = (await all()).sort((a, b) => lastUsed(b) - lastUsed(a));
    const gone = new Set();
    const perKey = new Map();
    for (const entry of entries) {
      const count = (perKey.get(entry.key) || 0) + 1;
      perKey.set(entry.key, count);
      if (count > perJob && entry.id !== keep) gone.add(entry.id);
    }
    let kept = entries.filter(entry => !gone.has(entry.id));
    while (kept.length > total) {
      const victim = [...kept].reverse().find(entry => entry.id !== keep);
      if (!victim) break;
      gone.add(victim.id);
      kept = kept.filter(entry => entry.id !== victim.id);
    }
    let bytes = kept.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
    while (bytes > maxBytes) {
      const victim = [...kept].reverse().find(entry => entry.id !== keep);
      if (!victim) break;
      gone.add(victim.id);
      bytes -= Number(victim.bytes) || 0;
      kept = kept.filter(entry => entry.id !== victim.id);
    }
    for (const id of gone) { try { await remove(id); } catch { /* left for the next prune */ } }
    return [...gone];
  }

  return Object.freeze({
    rootDir,
    /** Every saved interview of one job and company, most recently used first, as list views. */
    async list(key) {
      if (typeof key !== 'string' || !key) return [];
      return (await all()).filter(entry => entry.key === key).sort((a, b) => lastUsed(b) - lastUsed(a)).map(summarizeSavedInterview);
    },
    /** The whole saved interview with its visuals' bytes, or null. */
    async read(id) {
      const entry = await readEntry(id);
      if (!entry) return null;
      const visuals = [];
      for (const visual of Array.isArray(entry.visuals) ? entry.visuals : []) {
        if (!VISUAL_FILE_RE.test(String(visual?.file ?? ''))) continue;
        try { visuals.push({ ...visual, data: await fs.readFile(path.join(dirOf(id), 'visuals', visual.file)) }); } catch { /* a lost file leaves that screen's text alone */ }
      }
      return { ...entry, visuals };
    },
    /**
     * Keeps a new interview. `entry` is the JSON part; `visuals` are { file, data, ...meta }. Returns the id,
     * after pruning the others (never the new one).
     */
    async save(entry, visuals = []) {
      const id = `iv-${Math.floor(now()).toString(36)}-${Math.floor(random() * 36 ** 8).toString(36).padStart(6, '0')}`;
      const dir = dirOf(id);
      try {
        await fs.mkdir(path.join(dir, 'visuals'), { recursive: true, mode: 0o700 });
        const kept = [];
        let bytes = 0;
        for (const visual of visuals) {
          const { data, ...meta } = visual || {};
          if (!VISUAL_FILE_RE.test(String(meta.file ?? '')) || !data?.length) continue;
          await fs.writeFile(path.join(dir, 'visuals', meta.file), data, { mode: 0o600 });
          bytes += data.length;
          kept.push(meta);
        }
        const at = now();
        const record = { ...entry, version: SAVED_VERSION, id, createdAt: at, lastUsedAt: at, timesUsed: 1, visuals: kept };
        record.bytes = bytes + Buffer.byteLength(JSON.stringify(record));
        await writeJson(dir, record);
      } catch (error) {
        // A folder without its interview.json is never listed or pruned: a failed save takes its files with it.
        try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* nothing more to do */ }
        throw error;
      }
      await prune(id);
      return id;
    },
    /**
     * The interview was held again: it moves to the front of the queue. `changes` may carry new
     * `candidateVoiceIds` (a candidate voice drawn again because the kept one was missing); nothing else changes.
     */
    async touch(id, changes = {}) {
      const entry = await readEntry(id);
      if (!entry) return false;
      const voices = changes?.candidateVoiceIds;
      const next = { ...entry, lastUsedAt: now(), timesUsed: (Number(entry.timesUsed) || 0) + 1,
        ...(voices && typeof voices === 'object' && !Array.isArray(voices) ? { candidateVoiceIds: voices } : {}) };
      if (next.candidateVoiceIds !== entry.candidateVoiceIds && Number.isFinite(Number(entry.bytes))) {
        next.bytes = Number(entry.bytes) + Buffer.byteLength(JSON.stringify(next.candidateVoiceIds ?? null)) - Buffer.byteLength(JSON.stringify(entry.candidateVoiceIds ?? null));
      }
      await writeJson(dirOf(id), next);
      return true;
    },
    remove,
    prune,
  });
}
