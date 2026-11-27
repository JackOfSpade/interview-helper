// One-time copy of interview data out of the Infinite Canvas data folder.
//
// Interview Helper used to keep its data in Infinite Canvas's folder. The first
// start of the standalone app copies that data into its own folder and never
// looks at the old one again. The old folder is only read: nothing in it is
// changed or removed, so Infinite Canvas is unaffected and the copy can be
// repeated by deleting the marker file.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomicWrite.js';

export const MIGRATION_MARKER = '.copied-from-infinite-canvas.json';
// Everything the interview features read or write, by its name in the data folder.
export const MIGRATED_ENTRIES = Object.freeze([
  'interview-helper-sessions.json',
  'interview-helper-artifacts',
  'interview-helper-prepared-briefs',
  'interview-helper-answer-banks',
  'interview-helper-answer-bindings',
  'interview-helper-qa',
  'interview-helper-career-conversions',
  'practice-calls',
  'practice-models',
  'practice-voice-pool.json',
  'practice-question-history.json',
  // Career snapshots compiled before the split; read-only here (electron/ipc/careerText.js).
  path.join('career-snapshot-store', 'career-snapshots'),
]);

async function exists(target) { try { await fs.promises.lstat(target); return true; } catch { return false; } }

/**
 * Counts of the General questions used to be kept per interview. Move each
 * General question's count into the one shared `general` entry (the largest
 * count any interview recorded) and leave the other counts where they are.
 */
export async function migrateQuestionCounts({ dataRoot }) {
  const historyFile = path.join(dataRoot, 'practice-question-history.json');
  const generalFile = path.join(dataRoot, 'interview-helper-qa', 'foundation.json');
  let history; let general;
  try { history = JSON.parse(await fs.promises.readFile(historyFile, 'utf8')); general = JSON.parse(await fs.promises.readFile(generalFile, 'utf8')); } catch { return false; }
  const jobs = history?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs) || jobs.general) return false;
  const generalIds = new Set((Array.isArray(general?.cards) ? general.cards : []).map(card => card?.id).filter(id => typeof id === 'string'));
  const shared = {};
  for (const entry of Object.values(jobs)) {
    const counts = entry?.counts;
    if (!counts || typeof counts !== 'object') continue;
    for (const [id, value] of Object.entries(counts)) {
      if (!generalIds.has(id)) continue;
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) shared[id] = Math.max(shared[id] || 0, n);
      delete counts[id];
    }
  }
  if (!Object.keys(shared).length) return false;
  jobs.general = { counts: shared, updatedAt: Date.now() };
  await atomicWriteFile(historyFile, JSON.stringify({ version: 1, jobs }));
  return true;
}

/**
 * Copies the interview data once. Returns `{ copied: [...names], skipped }`.
 * An entry that already exists in the new folder is never overwritten. The marker that
 * ends the copy is left unwritten while an entry failed to copy.
 */
export async function migrateInterviewDataFromCanvas({ legacyRoot, dataRoot, logger = null } = {}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new TypeError('Interview data migration needs the data folder.');
  const marker = path.join(dataRoot, MIGRATION_MARKER);
  if (await exists(marker)) return { copied: [], skipped: true };
  const copied = [];
  let failed = 0;
  const legacy = typeof legacyRoot === 'string' && path.isAbsolute(legacyRoot) && path.resolve(legacyRoot) !== path.resolve(dataRoot) && await exists(legacyRoot) ? legacyRoot : null;
  if (legacy) {
    for (const name of MIGRATED_ENTRIES) {
      const from = path.join(legacy, name);
      const to = path.join(dataRoot, name);
      if (!await exists(from) || await exists(to)) continue;
      try {
        await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        // A clone where the disk supports it, so the large practice models take no extra space.
        await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE });
        copied.push(name);
      } catch (error) {
        failed += 1;
        // A half-copied entry would look finished next time; remove it so the copy is tried again.
        await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {});
        logger?.warn?.(`[InterviewApp] could not copy ${name} from the Infinite Canvas folder: ${error?.code || error?.message || error}`);
      }
    }
    try { await migrateQuestionCounts({ dataRoot }); } catch (error) { logger?.warn?.(`[InterviewApp] practice counts not converted: ${error?.message || error}`); }
  }
  // The marker is written only when every entry was copied, so a failed copy is tried again on the next start.
  if (!failed) await atomicWriteFile(marker, JSON.stringify({ version: 1, at: new Date().toISOString(), from: legacy, copied }));
  return { copied, skipped: false };
}
