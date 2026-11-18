import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATED_ENTRIES, MIGRATION_MARKER, migrateInterviewDataFromCanvas, migrateQuestionCounts } from '../../electron/interviewApp/migrateFromCanvas.js';

async function withRoots(fn) {
  const base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-migrate-')));
  const legacyRoot = path.join(base, 'infinite-canvas'); const dataRoot = path.join(base, 'Interview Helper', 'interview-data');
  await fs.promises.mkdir(dataRoot, { recursive: true });
  try { return await fn({ base, legacyRoot, dataRoot }); } finally { await fs.promises.rm(base, { recursive: true, force: true }); }
}
const write = async (file, text) => { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, text); };
const snapshotTree = async root => {
  const out = [];
  const walk = async directory => { for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name); const stat = await fs.promises.stat(full);
    out.push([path.relative(root, full), entry.isDirectory() ? 'dir' : await fs.promises.readFile(full, 'utf8'), stat.mtimeMs]);
    if (entry.isDirectory()) await walk(full);
  } };
  await walk(root); return JSON.stringify(out.sort());
};

export default [
  { name: 'interview migrate: copies the listed entries once, writes the marker and never modifies the legacy folder', async run() {
    await withRoots(async ({ legacyRoot, dataRoot }) => {
      await write(path.join(legacyRoot, 'interview-helper-sessions.json'), '{"sessions":[]}');
      await write(path.join(legacyRoot, 'interview-helper-qa', 'foundation.json'), '{"cards":[]}');
      await write(path.join(legacyRoot, 'career-snapshot-store', 'career-snapshots', `${'a'.repeat(64)}.json`), '{}');
      await write(path.join(legacyRoot, 'canvas-only.json'), 'not copied');
      await write(path.join(legacyRoot, 'jobs', 'board.json'), 'not copied either');
      const before = await snapshotTree(legacyRoot);
      const result = await migrateInterviewDataFromCanvas({ legacyRoot, dataRoot });
      assert.deepEqual(result, { copied: ['interview-helper-sessions.json', 'interview-helper-qa', path.join('career-snapshot-store', 'career-snapshots')], skipped: false });
      assert.equal(await fs.promises.readFile(path.join(dataRoot, 'interview-helper-sessions.json'), 'utf8'), '{"sessions":[]}');
      assert((await fs.promises.stat(path.join(dataRoot, 'interview-helper-qa', 'foundation.json'))).isFile());
      assert(fs.existsSync(path.join(dataRoot, 'career-snapshot-store', 'career-snapshots', `${'a'.repeat(64)}.json`)));
      assert(!fs.existsSync(path.join(dataRoot, 'canvas-only.json')) && !fs.existsSync(path.join(dataRoot, 'jobs')), 'only the listed entries are copied');
      const marker = JSON.parse(await fs.promises.readFile(path.join(dataRoot, MIGRATION_MARKER), 'utf8'));
      assert.deepEqual([marker.version, marker.from, marker.copied.length], [1, legacyRoot, 3]);
      assert.equal(await snapshotTree(legacyRoot), before, 'the legacy folder is unchanged');
      assert(MIGRATED_ENTRIES.includes('practice-calls') && MIGRATED_ENTRIES.includes('interview-helper-answer-banks'));
    });
  } },
  { name: 'interview migrate: an existing entry is never overwritten and a second run is skipped', async run() {
    await withRoots(async ({ legacyRoot, dataRoot }) => {
      await write(path.join(legacyRoot, 'interview-helper-sessions.json'), 'legacy');
      await write(path.join(legacyRoot, 'practice-voice-pool.json'), 'legacy voices');
      await write(path.join(dataRoot, 'interview-helper-sessions.json'), 'new data');
      const first = await migrateInterviewDataFromCanvas({ legacyRoot, dataRoot });
      assert.deepEqual(first.copied, ['practice-voice-pool.json']);
      assert.equal(await fs.promises.readFile(path.join(dataRoot, 'interview-helper-sessions.json'), 'utf8'), 'new data', 'an existing entry stays');
      await write(path.join(legacyRoot, 'practice-models', 'm.bin'), 'later');
      const second = await migrateInterviewDataFromCanvas({ legacyRoot, dataRoot });
      assert.deepEqual(second, { copied: [], skipped: true });
      assert(!fs.existsSync(path.join(dataRoot, 'practice-models')), 'the marker makes later runs do nothing');
    });
  } },
  { name: 'interview migrate: a missing legacy folder still writes the marker', async run() {
    await withRoots(async ({ legacyRoot, dataRoot }) => {
      const result = await migrateInterviewDataFromCanvas({ legacyRoot, dataRoot });
      assert.deepEqual(result, { copied: [], skipped: false });
      const marker = JSON.parse(await fs.promises.readFile(path.join(dataRoot, MIGRATION_MARKER), 'utf8'));
      assert.deepEqual([marker.from, marker.copied], [null, []]);
      assert.equal((await migrateInterviewDataFromCanvas({ legacyRoot, dataRoot })).skipped, true);
      await assert.rejects(migrateInterviewDataFromCanvas({ legacyRoot, dataRoot: 'relative' }), TypeError);
    });
  } },
  { name: 'interview migrate: General question counts move into the shared general entry (largest count) and other ids stay', async run() {
    await withRoots(async ({ dataRoot }) => {
      const history = path.join(dataRoot, 'practice-question-history.json');
      await write(path.join(dataRoot, 'interview-helper-qa', 'foundation.json'), JSON.stringify({ cards: [{ id: 'g1' }, { id: 'g2' }] }));
      await write(history, JSON.stringify({ version: 1, jobs: {
        'node-a': { counts: { g1: 2, g2: 1, c1: 4 }, updatedAt: 1 },
        'node-b': { counts: { g1: 5, c2: 1 }, updatedAt: 2 },
      } }));
      assert.equal(await migrateQuestionCounts({ dataRoot }), true);
      const saved = JSON.parse(await fs.promises.readFile(history, 'utf8'));
      assert.deepEqual(saved.jobs.general.counts, { g1: 5, g2: 1 });
      assert.deepEqual(saved.jobs['node-a'].counts, { c1: 4 });
      assert.deepEqual(saved.jobs['node-b'].counts, { c2: 1 });
      assert.equal(await migrateQuestionCounts({ dataRoot }), false, 'a second conversion changes nothing');
      assert.equal(await migrateQuestionCounts({ dataRoot: path.join(dataRoot, 'missing') }), false, 'missing files are not an error');
    });
  } },
  { name: 'interview migrate: the copy converts counts as part of the migration', async run() {
    await withRoots(async ({ legacyRoot, dataRoot }) => {
      await write(path.join(legacyRoot, 'interview-helper-qa', 'foundation.json'), JSON.stringify({ cards: [{ id: 'g1' }] }));
      await write(path.join(legacyRoot, 'practice-question-history.json'), JSON.stringify({ version: 1, jobs: { n: { counts: { g1: 3 } } } }));
      const legacyBefore = await fs.promises.readFile(path.join(legacyRoot, 'practice-question-history.json'), 'utf8');
      await migrateInterviewDataFromCanvas({ legacyRoot, dataRoot });
      const copied = JSON.parse(await fs.promises.readFile(path.join(dataRoot, 'practice-question-history.json'), 'utf8'));
      assert.deepEqual(copied.jobs.general.counts, { g1: 3 });
      assert.equal(await fs.promises.readFile(path.join(legacyRoot, 'practice-question-history.json'), 'utf8'), legacyBefore, 'the legacy history file is untouched (the copy is converted)');
    });
  } },
];
