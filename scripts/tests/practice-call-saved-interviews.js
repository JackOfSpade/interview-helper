import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSavedInterviewStore, isSavedInterviewId, summarizeSavedInterview, SAVED_BYTES, SAVED_PER_JOB, SAVED_TOTAL,
} from '../../electron/practiceCall/savedInterviews.js';

// Synthetic data only: every name and sentence below is invented for the tests.

const cases = [];
const test = (name, run) => cases.push({ name: `practice call saved interviews: ${name}`, run });

const PLAN = Object.freeze({
  interviewKind: 'A first technical round.',
  lead: { voice: 'V1', role: 'Hiring Manager' },
  panel: [{ voice: 'V2', role: 'Staff Engineer' }],
  questions: [{ number: 1, askedBy: 'V1', minutes: 8 }, { number: 0, text: 'Anything for us?', askedBy: 'V2', minutes: 4.4 }],
  problems: [{ ref: 'p1', question: 1, parts: [{ title: 'Queue', content: 'Design it.' }] }],
});
const entryFor = (key, extra = {}) => ({
  key, nodeId: 'node-1', company: 'Acme', role: 'Engineer', steering: '',
  planned: { plan: PLAN, ms: 9000 },
  drawnVoices: [{ key: 'V1', name: 'Nora Lead', voiceId: 'lib-1', persona: { name: 'Nora Lead' } }, { key: 'V2', name: 'Ben Second', voiceId: 'lib-2', persona: { name: 'Ben Second' } }],
  joinDraws: [{ joins: 'late', joinDelayMs: 57000 }], questions: [{ number: 1, id: 'q1', question: 'Tell me about a launch.', answer: 'I led one.' }],
  ...extra,
});
/** A store on its own folder with a clock the test moves. */
async function storeAt(options = {}) {
  const rootDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'saved-interviews-')), 'practice-interviews');
  let at = 1_700_000_000_000;
  let seq = 0;
  const store = createSavedInterviewStore({ rootDir, now: () => at, random: () => ((seq += 1) % 97) / 97, ...options });
  return { store, rootDir, tick: (ms = 1000) => { at += ms; } };
}

test('the caps follow the measured sizes: a few per job, a few dozen in all, a byte budget for photos', () => {
  assert.equal(SAVED_PER_JOB, 5);
  assert.equal(SAVED_TOTAL, 40);
  assert.equal(SAVED_BYTES, 100 * 1024 * 1024);
});

test('an interview is saved with its visuals, read back whole, listed per job and moved to the front when held again', async () => {
  const { store, rootDir, tick } = await storeAt();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const id = await store.save(entryFor('posting:a'), [
    { id: 'p1.1', file: 'p1.1.svg', data: svg, kind: 'diagram', mime: 'image/svg+xml', description: 'A queue.' },
    { id: 'p1.2', file: '../escape.jpg', data: Buffer.from('x'), kind: 'picture' },
  ]);
  assert.equal(isSavedInterviewId(id), true);
  tick();
  const other = await store.save(entryFor('posting:b'));
  const read = await store.read(id);
  assert.equal(read.planned.plan.lead.role, 'Hiring Manager');
  assert.deepEqual(read.visuals.map(visual => [visual.id, visual.data.toString()]), [['p1.1', svg.toString()]], 'a file name outside the folder is never written');
  assert.deepEqual((await readdir(path.join(rootDir, id, 'visuals'))), ['p1.1.svg']);
  const [listed] = await store.list('posting:a');
  assert.deepEqual(listed, summarizeSavedInterview(read));
  assert.deepEqual({ lead: listed.lead, panel: listed.panel, questionCount: listed.questionCount, problemCount: listed.problemCount, minutes: listed.minutes, timesUsed: listed.timesUsed },
    { lead: { name: 'Nora Lead', role: 'Hiring Manager' }, panel: [{ name: 'Ben Second', role: 'Staff Engineer' }], questionCount: 2, problemCount: 1, minutes: 12, timesUsed: 1 });
  assert.equal('planned' in listed, false, 'the list never carries the plan');
  assert.deepEqual((await store.list('posting:b')).map(item => item.id), [other]);
  tick();
  assert.equal(await store.touch(id), true);
  assert.equal((await store.read(id)).timesUsed, 2);
  // A retake may keep candidate voices drawn again; nothing else in the entry changes.
  const before = await store.read(id);
  const voices = { female: { voiceId: 'f1', name: 'Fay' }, male: { voiceId: 'm2', name: 'Max' } };
  assert.equal(await store.touch(id, { candidateVoiceIds: voices, planned: 'never written' }), true);
  const after = await store.read(id);
  assert.deepEqual(after.candidateVoiceIds, voices);
  assert.deepEqual(after.planned, before.planned, 'only the candidate voices may change');
  assert.equal(after.timesUsed, 3);
  assert.equal(await store.touch('iv-nothere-000000'), false);
  assert.equal(await store.read('iv-nothere-000000'), null);
  await assert.rejects(() => store.read('../x'), /saved interview id/u);
  assert.deepEqual(await store.list(''), []);
});

test('past the per-job cap the least recently held of that job goes; another job is untouched', async () => {
  const { store, tick } = await storeAt({ perJob: 2 });
  const a1 = await store.save(entryFor('posting:a')); tick();
  const a2 = await store.save(entryFor('posting:a')); tick();
  const b1 = await store.save(entryFor('posting:b')); tick();
  await store.touch(a1); tick();
  const a3 = await store.save(entryFor('posting:a'));
  assert.deepEqual((await store.list('posting:a')).map(item => item.id).sort(), [a1, a3].sort(), 'a2 was the least recently held');
  assert.deepEqual((await store.list('posting:b')).map(item => item.id), [b1]);
  assert.equal(await store.read(a2), null);
});

test('past the total cap or the byte budget the least recently held goes, never the one just saved', async () => {
  const counted = await storeAt({ total: 2 });
  const first = await counted.store.save(entryFor('posting:a')); counted.tick();
  await counted.store.save(entryFor('posting:b')); counted.tick();
  const third = await counted.store.save(entryFor('posting:c'));
  assert.equal(await counted.store.read(first), null);
  assert.notEqual(await counted.store.read(third), null);
  const sized = await storeAt({ maxBytes: 300 * 1024 });
  const photo = size => [{ id: 'p1.1', file: 'p1.1.jpg', data: Buffer.alloc(size, 1), kind: 'picture', mime: 'image/jpeg' }];
  const small = await sized.store.save(entryFor('posting:a')); sized.tick();
  const big1 = await sized.store.save(entryFor('posting:b'), photo(200 * 1024)); sized.tick();
  const big2 = await sized.store.save(entryFor('posting:c'), photo(200 * 1024));
  assert.equal(await sized.store.read(small), null, 'the oldest goes first, even a small one');
  assert.equal(await sized.store.read(big1), null);
  assert.notEqual(await sized.store.read(big2), null, 'the new one stays even alone over the budget');
  const huge = await sized.store.save(entryFor('posting:d'), photo(400 * 1024));
  assert.notEqual(await sized.store.read(huge), null);
});

test('a save that fails part way leaves no folder behind', async () => {
  const rootDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'saved-interviews-')), 'practice-interviews');
  const failing = { ...(await import('node:fs/promises')) };
  let writes = 0;
  failing.writeFile = async (file, data, options) => { writes += 1; if (writes === 2) { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; } return (await import('node:fs/promises')).writeFile(file, data, options); };
  const store = createSavedInterviewStore({ rootDir, fs: failing });
  const photo = file => ({ id: file, file: `${file}.jpg`, data: Buffer.alloc(1024, 1), kind: 'picture', mime: 'image/jpeg' });
  await assert.rejects(() => store.save(entryFor('posting:a'), [photo('p1.1'), photo('p1.2')]), /disk full/u);
  assert.deepEqual(await readdir(rootDir), [], 'the photo already written went with the folder');
});

test('a folder that is not a saved interview, or a record of another version, is ignored', async () => {
  const { store, rootDir } = await storeAt();
  const id = await store.save(entryFor('posting:a'));
  await mkdir(path.join(rootDir, 'not-an-interview'), { recursive: true });
  await mkdir(path.join(rootDir, 'iv-oldone-000000'), { recursive: true });
  await writeFile(path.join(rootDir, 'iv-oldone-000000', 'interview.json'), JSON.stringify({ version: 0, id: 'iv-oldone-000000', key: 'posting:a' }));
  assert.deepEqual((await store.list('posting:a')).map(item => item.id), [id]);
});

export default cases;
