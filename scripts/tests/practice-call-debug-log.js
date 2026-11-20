import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCallDebugLog, sanitizeForDebug } from '../../electron/practiceCall/callDebugLog.js';
import { createCallStore } from '../../electron/practiceCall/callStore.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call debug log: ${name}`, run });
const DIR = path.resolve('/virtual/call-1');

test('lines are queued in order, carry wall time and call-clock ms, and flush writes them all', async () => {
  const appended = [];
  let clock = 1000;
  const log = createCallDebugLog({ dir: DIR, now: () => clock, fs: { appendFile: async (file, text, options) => { appended.push({ file, text, options }); } } });
  log.log('a', { n: 1 });
  clock = 1500;
  log.startCallClock();
  clock = 1700;
  log.log('b', { n: 2 });
  log.log('c');
  await log.flush();
  const lines = appended.flatMap(item => item.text.trim().split('\n')).map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.event), ['a', 'b', 'c']);
  assert.deepEqual(lines.map(line => line.ms), [null, 200, 200]);
  assert.equal(lines[1].up, 700);
  assert.equal(lines[0].t, new Date(1000).toISOString());
  assert.equal(appended[0].file, path.join(DIR, 'debug.jsonl'));
  assert.equal(appended[0].options.mode, 0o600);
  assert.equal('data' in lines[2], false);
});

test('a failing filesystem never throws or rejects', async () => {
  const log = createCallDebugLog({ dir: DIR, fs: { appendFile: async () => { throw new Error('disk full'); } } });
  log.log('a', { n: 1 });
  log.log('b', { circular: (() => { const loop = {}; loop.self = loop; return loop; })() });
  await log.flush();
  await log.close();
  assert(log.stats().failures >= 1);
  log.log('after close');
  await log.flush();
});

test('a log with no folder or no appendFile does nothing', async () => {
  for (const options of [{ fs: { appendFile: async () => { throw new Error('never'); } } }, { dir: DIR, fs: {} }, { dir: 'relative', fs: { appendFile: async () => {} } }]) {
    const log = createCallDebugLog(options);
    assert.equal(log.enabled, false);
    log.log('a');
    await log.flush();
  }
});

test('strings are capped, audio and secrets are dropped, and paths outside the call folder are hidden', () => {
  const long = 'x'.repeat(5000);
  const clean = sanitizeForDebug({
    text: long, key: 'sk-1', apiKey: 'sk-2', authorization: 'Bearer z', pcm: Buffer.alloc(10), nested: { audio: [1, 2], keep: 1 },
    inside: `${DIR}/call.json`, outside: '/Users/someone/secret.txt', said: 'see /Users/someone/x.txt now', tag: '<listen/> and </chat>',
  }, DIR);
  assert(clean.text.length < 2100 && clean.text.includes('more characters'));
  for (const name of ['key', 'apiKey', 'authorization', 'pcm']) assert.equal(name in clean, false, name);
  assert.deepEqual(clean.nested, { keep: 1 });
  assert.equal(clean.inside, 'call.json');
  assert.equal(clean.outside, '[path]');
  assert.equal(clean.said, 'see [path] now');
  assert.equal(clean.tag, '<listen/> and </chat>');
  assert.equal(sanitizeForDebug(new Uint8Array(4)), '[binary 4 bytes]');
  assert.equal(sanitizeForDebug({ firstTokenMs: 5 }).firstTokenMs, 5, 'timing fields that mention tokens stay');
});

test('the log writes a private file in a real folder', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-debug-log-'));
  const log = createCallDebugLog({ fs: nodeFs, dir: tmp });
  log.log('one', { a: 1 });
  log.log('two', { b: 2 });
  await log.close();
  const text = await readFile(path.join(tmp, 'debug.jsonl'), 'utf8');
  assert.deepEqual(text.trim().split('\n').map(line => JSON.parse(line).event), ['one', 'two']);
  assert.equal((await stat(path.join(tmp, 'debug.jsonl'))).mode & 0o077, 0);
});

async function seedCalls(count, { withDebug = true } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-debug-retention-'));
  const rootDir = path.join(tmp, 'practice-calls');
  const store = createCallStore({ rootDir });
  for (let at = 0; at < count; at += 1) {
    const id = `call-${at}`;
    await store.writeRecord(id, { nodeId: 'n', startedAt: Date.now() - 1_000_000 + at * 1000 });
    await store.writeAnalysis(id, { status: 'ready' });
    await writeFile(path.join(rootDir, id, 'call.m4a'), 'audio');
    if (withDebug) await writeFile(path.join(rootDir, id, 'debug.jsonl'), '{}\n');
  }
  return { store, rootDir };
}

test('retention keeps the newest ten debug logs and never touches call.json, analysis.json or recordings', async () => {
  const { store, rootDir } = await seedCalls(14);
  const result = await store.pruneDebugLogs();
  assert.deepEqual(result.deleted.sort(), ['call-0', 'call-1', 'call-2', 'call-3']);
  for (let at = 0; at < 14; at += 1) {
    const names = await readdir(path.join(rootDir, `call-${at}`));
    assert(names.includes('call.json') && names.includes('analysis.json') && names.includes('call.m4a'), `call-${at} keeps its record`);
    assert.equal(names.includes('debug.jsonl'), at >= 4, `call-${at} debug log`);
  }
  assert.deepEqual((await store.pruneDebugLogs()).deleted, [], 'a second run changes nothing');
});

test('deleting a recording leaves the call record, analysis and debug log', async () => {
  const { store, rootDir } = await seedCalls(2);
  await store.deleteRecording('call-1');
  assert.deepEqual((await readdir(path.join(rootDir, 'call-1'))).sort(), ['analysis.json', 'call.json', 'debug.jsonl']);
});

test('prune protects the running call and orders a folder without a record by its change time', async () => {
  const { store, rootDir } = await seedCalls(9);
  await mkdir(path.join(rootDir, 'running'), { mode: 0o700 });
  await writeFile(path.join(rootDir, 'running', 'debug.jsonl'), '{}\n');
  await mkdir(path.join(rootDir, 'failed'), { mode: 0o700 });
  await writeFile(path.join(rootDir, 'failed', 'debug.jsonl'), '{}\n');
  const old = new Date(1000);
  await utimes(path.join(rootDir, 'failed'), old, old);
  const result = await store.pruneDebugLogs({ protect: 'running' });
  assert.deepEqual(result.deleted, ['failed']);
  await assert.rejects(stat(path.join(rootDir, 'failed')), 'a folder that held only a log is removed with it');
  assert((await readdir(path.join(rootDir, 'running'))).includes('debug.jsonl'));
});

test('removing an abandoned call clears everything but its debug log, and everything when there is none', async () => {
  const { store, rootDir } = await seedCalls(1);
  assert.deepEqual(await store.remove('call-0'), { removed: true, keptDebugLog: true });
  assert.deepEqual(await readdir(path.join(rootDir, 'call-0')), ['debug.jsonl']);
  const plain = await seedCalls(1, { withDebug: false });
  assert.deepEqual(await plain.store.remove('call-0'), { removed: true });
  await assert.rejects(stat(path.join(plain.rootDir, 'call-0')));
});

test('debug log counts and sizes are available for the data folder listing', async () => {
  const { store } = await seedCalls(3);
  assert.deepEqual(await store.debugLogStats(), { count: 3, bytes: 9 });
});

test('recentDiagnostics returns the newest calls with a debug log: the log text and the record as states and counts only', async () => {
  const { store, rootDir } = await seedCalls(5);
  await store.writeRecord('call-4', {
    nodeId: 'n', startedAt: Date.now(), durationMs: 61_000, reason: 'candidate', persona: { name: 'Private Name' }, panel: [{ name: 'Other' }],
    transcript: [{ speaker: 'interviewer', text: 'SECRET QUESTION' }, { speaker: 'candidate', text: 'SECRET ANSWER' }],
    pickedQuestions: [1, 2], askedQuestions: [1], answeredQuestions: [1], steering: 'SECRET STEERING', feedbackSkipped: true,
    timings: { setupLeadMs: 1200, answers: [1, 2], label: 'x' },
  });
  await store.writeAnalysis('call-4', { status: 'failed', error: 'feedback.planned has no entry for card 1 ("SECRET QUESTION")', chapters: [], feedback: null });
  await writeFile(path.join(rootDir, 'call-4', 'debug.jsonl'), '{"event":"phase"}\n{"event":"warn"}\n');
  const calls = await store.recentDiagnostics({ limit: 2 });
  assert.deepEqual(calls.map(call => call.callId), ['call-4', 'call-3'], 'newest first, limited');
  const [newest] = calls;
  assert.equal(newest.text, '{"event":"phase"}\n{"event":"warn"}\n');
  assert.equal(newest.hasAudio, true);
  assert.deepEqual(newest.record, {
    durationMs: 61_000, pausedMs: null, reason: 'candidate', endedBy: null, returnedCall: null, transcriptEntries: 2, candidateTurns: 1, interviewers: 2,
    answeredQuestions: 1, setupAttempts: null, timings: { setupLeadMs: 1200 }, pickedQuestions: 2, askedQuestions: 1, feedbackSkipped: true, recordingPruned: false,
  });
  assert.equal(newest.analysis.status, 'failed');
  assert.equal(newest.analysis.hasFeedback, false);
  assert.doesNotMatch(JSON.stringify(newest.record), /SECRET|Private Name/u, 'no transcript, persona or steering text');
  // A long log is read from its end, starting at a whole line.
  await writeFile(path.join(rootDir, 'call-4', 'debug.jsonl'), `${'{"event":"old"}\n'.repeat(100)}{"event":"last"}\n`);
  const [cut] = await store.recentDiagnostics({ limit: 1, maxBytes: 40 });
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.text.trim().split('\n').map(line => JSON.parse(line).event), ['old', 'last']);
});

export default cases;
