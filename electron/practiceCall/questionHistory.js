import nodeFs from 'node:fs/promises';
import path from 'node:path';

// How many past calls asked each prepared question or technical topic. Counts are filed per
// posting (or per interview, for one with no posting yet), and under `general` for the General questions. It only steers which questions the
// interviewer favours next time, so it is small, forgiving and never allowed to stop a call.
const MAX_JOBS = 200;

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
  // File shape: { version: 1, jobs: { [nodeId]: { counts: { [questionId]: n }, updatedAt } } }.
  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const jobs = {};
      const source = parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object' && !Array.isArray(parsed.jobs) ? parsed.jobs : {};
      for (const [nodeId, entry] of Object.entries(source)) {
        if (!nodeId || !entry || typeof entry !== 'object') continue;
        jobs[nodeId] = { counts: cleanCounts(entry.counts), updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0 };
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
    /** Gives `toKey` the counts of `fromKey` when `toKey` has none yet (an interview's set became its posting's set). */
    adopt(fromKey, toKey) {
      if (typeof fromKey !== 'string' || !fromKey || typeof toKey !== 'string' || !toKey || fromKey === toKey) return Promise.resolve(false);
      const run = queue.then(async () => {
        const jobs = await load();
        if (jobs[toKey] || !jobs[fromKey] || !Object.keys(jobs[fromKey].counts).length) return false;
        jobs[toKey] = { counts: { ...jobs[fromKey].counts }, updatedAt: Date.now() };
        await save(jobs);
        return true;
      });
      queue = run.catch(() => {});
      return run;
    },
    record(nodeId, questionIds) {
      if (typeof nodeId !== 'string' || !nodeId) return Promise.resolve();
      const ids = [...new Set((Array.isArray(questionIds) ? questionIds : []).filter(id => typeof id === 'string' && id))];
      if (!ids.length) return Promise.resolve();
      const run = queue.then(() => write(nodeId, ids));
      queue = run.catch(() => {});
      return run;
    },
  });
  async function write(nodeId, ids) {
    const jobs = await load();
    const counts = { ...(jobs[nodeId]?.counts || {}) };
    for (const id of ids) counts[id] = (counts[id] || 0) + 1;
    // Date.now() ties are broken by insertion order below, so a quick burst still drops the oldest.
    const stamp = Math.max(Date.now(), ...Object.values(jobs).map(job => job.updatedAt + 1));
    delete jobs[nodeId];
    jobs[nodeId] = { counts, updatedAt: stamp };
    const keep = Object.entries(jobs).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_JOBS);
    await save(Object.fromEntries(keep));
  }
}

export default createQuestionHistory;
