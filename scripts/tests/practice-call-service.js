import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCallStore } from '../../electron/practiceCall/callStore.js';
import { createSavedInterviewStore } from '../../electron/practiceCall/savedInterviews.js';
import { createVoicePoolStore, drawVoice } from '../../electron/practiceCall/eleven/voiceLibrary.js';
import { createPracticeCallService, clampedEndOfCutSegment, draftTimingOf, generatedRunFor, stampInjectedLines, technicalTopicQuestion, MAIN_REPLY_MODELS, DEFAULT_MAIN_REPLY_MODEL } from '../../electron/practiceCall/callService.js';
import { DEFAULT_CALL_THRESHOLDS } from '../../electron/interviewPracticeCallEngine.js';
import { createPanelVoiceFactory } from '../../electron/practiceCall/eleven/panelVoice.js';
import { createReplayHandler } from '../../electron/practiceCall/replayProtocol.js';
import { capCareerDocumentText, loadCareerDocumentText } from '../../electron/practiceCall/careerDocumentText.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call service: ${name}`, run });
const ARGS = Object.freeze({
  nodeId: 'node-1', briefRecordId: 'b'.repeat(64), snapshotId: 'snapshot-1',
  canonicalJobUrl: 'https://example.com/jobs/1', bundleArtifactId: 'bundle-1', bundleArtifactDigest: 'd'.repeat(64),
});
const BRIEF = Object.freeze({
  version: 1, inputs: {
    careerSnapshotId: ARGS.snapshotId, jobUrlSha256: '4e5625e0ef4c1d4c7a1d0f1d3f8b9b1e7d1c9a2b3c4d5e6f7a8b9c0d1e2f3a4b',
    applicationArtifactId: ARGS.bundleArtifactId, applicationArtifactDigest: ARGS.bundleArtifactDigest,
  }, role: { title: 'Engineer', company: 'Acme' },
});
const CARD = Object.freeze({ id: 'q1', question: 'Tell me about a launch.', answer: 'I led one.' });

function fakeFs() {
  const written = [];
  return {
    written,
    async mkdir() {}, async chmod() {},
    async writeFile(file, data) { written.push({ op: 'write', file, data }); },
    async unlink(file) { written.push({ op: 'unlink', file }); },
    async lstat() { return { isFile: () => true, isSymbolicLink: () => false }; },
    async open() { return { stat: async () => ({ isFile: () => true }), readFile: async () => '{}', close: async () => {} }; },
  };
}

function memoryHistory(initial = {}) {
  const jobs = { ...initial };
  const recorded = [];
  return {
    jobs, recorded,
    async counts(nodeId) { return { ...(jobs[nodeId] || {}) }; },
    async record(nodeId, ids) { recorded.push({ nodeId, ids: [...ids] }); jobs[nodeId] = { ...(jobs[nodeId] || {}) }; for (const id of ids) jobs[nodeId][id] = (jobs[nodeId][id] || 0) + 1; },
  };
}

/** A valid plan for a solo call led by the first drawn voice, with `change` merged over it. */
function soloPlan(voices, change = {}) {
  return {
    interviewKind: 'A short screening conversation.',
    lead: { voice: voices[0].key, role: 'Hiring Manager', temperament: 'neutral', stability: 0.3, room: 0.5, manner: 'Even and direct.', interrupting: 'Lets people finish and rarely cuts in.' },
    panel: [],
    questions: [{ number: 1, askedBy: voices[0].key, minutes: 10, probes: [] }],
    problems: [],
    ...change,
  };
}
/** The planner stand-in: every call is recorded and answered with a solo plan unless a test supplies its own. */
function fakePlanner(make = voices => soloPlan(voices)) {
  const calls = [];
  const planCall = async input => {
    calls.push(input);
    return { plan: make(input.voices, input), attempts: [], ms: 7 };
  };
  planCall.calls = calls;
  return planCall;
}

function makeDeps(overrides = {}) {
  const events = [];
  const tmp = overrides.tmp;
  const store = createCallStore({ rootDir: path.join(tmp, 'practice-calls'), ...(overrides.storeFs ? { fs: overrides.storeFs } : {}) });
  const engineEvents = [];
  let engineListener;
  const sessions = { opener: { start: async () => {} }, main: { start: async () => {} }, classifier: { start: async () => {} } };
  const deps = {
    store, userDataPath: tmp, fs: fakeFs(),
    newId: () => 'call-1',
    clock: { now: () => 1000, setTimeout: () => 1, clearTimeout: () => {} },
    // Most suites test what follows the ring, so setup rings at once; the Ready gate has its own test.
    readyGate: false,
    validateArgs: () => {},
    loadBrief: async () => ({ ...BRIEF, inputs: { ...BRIEF.inputs, jobUrlSha256: (await import('node:crypto')).createHash('sha256').update(ARGS.canonicalJobUrl).digest('hex') } }),
    loadCards: async () => [CARD],
    loadCandidateName: async () => '',
    loadApplication: async () => ({ resume: 'Synthetic resume text.', coverLetter: 'Synthetic cover letter text.' }),
    orderCards: cards => cards,
    registryStatus: async () => ({ order: [] }),
    // In memory: no test touches the real question history file.
    questionHistory: memoryHistory(),
    modelStore: () => ({
      status: () => ({ smartTurn: overrides.modelReady ? 'ready' : 'missing', tone: overrides.modelReady ? 'ready' : 'missing' }),
      ensure: async name => { events.push(`ensure:${name}`); },
      pathOf: name => path.join(tmp, 'practice-models', `${name}.onnx`),
    }),
    readKey: async () => 'key-should-never-be-logged',
    fetch: async () => ({ ok: true, json: async () => ({ tier: 'paid' }) }),
    catalog: {
      listConversationalVoices: async () => [{ voiceId: 'v1', name: 'Ada Lovelace' }],
      pickPersonaVoice: () => ({ voiceId: 'v1', name: 'Ada Lovelace' }),
    },
    // No network and no growth: the draw is a no-op that hands back the account's voice.
    voiceLibrary: {
      createVoicePoolStore: () => ({ load: async () => ({ version: 1, lastUsed: {} }), save: async () => {} }),
      drawVoice: async () => ({ voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 }),
    },
    // Only the warm-up stream carries audio, so every start warms up and rings.
    voiceFactory: () => ({
      open: options => {
        const stream = {
          sampleRate: 24000, onAudio(listener) { stream.audioListener = listener; }, onWords() {},
          sendText() {}, cancel() {},
          finish: async () => { if (options?.utteranceId === 'warm-up') stream.audioListener?.(new Uint8Array(1024)); },
        };
        return stream;
      },
    }),
    helperFactory: ({ onEvent }) => {
      const helper = {
        start: async options => {
          events.push(`start:${path.basename(options.recordingPath)}`);
          if (overrides.helperError) setTimeout(() => onEvent({ type: 'error', message: 'audio helper failed' }), 0);
        },
        play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {},
        stop: async () => { events.push('stop'); onEvent({ type: 'recording', state: 'closed' }); },
      };
      return helper;
    },
    callSound: () => ({ process: buffer => buffer, reset() {} }),
    callRoom: seed => ({ seed, rt60Ms: 300 }),
    callCodec: () => ({ process: buffer => buffer, flush: () => Buffer.alloc(0), reset() {} }),
    trackFactory: () => ({ started() {}, ended() {}, addUtterance() {}, finalize: async () => { events.push('finalize'); } }),
    earFactory: () => ({ noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] }),
    sessionsFactory: () => ({ start: async () => {} }),
    planCall: fakePlanner(),
    prompts: { buildOpenerInstructions: () => 'opener', buildInterviewerInstructions: () => 'interviewer' },
    restartSession: async () => sessions,
    usageLimit: () => (overrides.usage ? { resumeAt: 1 } : null),
    engineFactory: options => {
      engineListener = options.onEvent;
      return {
        start() { engineEvents.push('start'); options.onEvent({ type: 'phase', phase: 'listening' }); },
        hangUp() { engineEvents.push('hangup'); },
        helperEvent(event) { engineEvents.push(event.type); },
        state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000 }),
        typed() {},
      };
    },
    mixdown: async ({ outPath }) => { events.push(`mix:${path.basename(outPath)}`); return { durationMs: 4000 }; },
    afconvert: async () => { events.push('afconvert'); },
    analyze: async () => ({ status: 'ready', chapters: [], feedback: { summary: 'ok' } }),
    ...overrides.deps,
  };
  return { deps, events, engineEvents, engine: () => engineListener };
}

test('setup ends at Ready: nothing rings until the candidate says so, and then only after a short delay', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-ready-'));
  const { deps } = makeDeps({ tmp, modelReady: true });
  const timers = [];
  const service = createPracticeCallService({ ...deps, readyGate: undefined, random: () => 0.5, clock: { now: () => 1000, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} } });
  let state = await service.start(ARGS);
  assert.equal(state.phase, 'precheck');
  assert.deepEqual(state.setup, { step: 'ready', attempt: 1 });
  assert.equal((await service.answer()).phase, 'precheck', 'there is no call to answer yet');
  state = service.ready();
  assert.deepEqual(state.setup, { step: 'ready', attempt: 1, calling: true });
  const rings = timers.filter(timer => timer.ms === 5000);
  assert.equal(rings.length, 1, 'the ring is 3 to 7 seconds away');
  service.ready();
  assert.equal(timers.filter(timer => timer.ms === 5000).length, 1, 'a second press changes nothing');
  rings[0].fn();
  assert.equal(service.getState().phase, 'ringing');
  assert.equal(service.getState().setup, null);
});

test('a question asked but never answered is not recorded as practised', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-unanswered-'));
  const history = { recorded: [], counts: async () => ({}), record: async (nodeId, ids) => { history.recorded.push({ nodeId, ids }); } };
  const engineFactory = options => ({
    start() { options.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, helperEvent() {}, typed() {},
    state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000, askedQuestions: [1, 2], answeredQuestions: [2] }),
  });
  const { deps } = makeDeps({ tmp, modelReady: true });
  const service = createPracticeCallService({ ...deps, questionHistory: history, engineFactory, loadCards: async () => PLAN_CARDS, planCall: fakePlanner(voices => ({ ...soloPlan(voices), questions: [{ number: 1 }, { number: 2 }] })) });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.askedQuestions, [1, 2]);
  assert.deepEqual(record.answeredQuestions, [2]);
  assert.equal(history.recorded.length, 1);
  assert.equal(history.recorded[0].ids.length, 1, 'only the answered question is counted');
});

test('consent, download, usage warning, ringing and answer', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-consent-'));
  const { deps, events } = makeDeps({ tmp, usage: true });
  const service = createPracticeCallService(deps);
  const states = [];
  service.onState(state => states.push(state));
  let state = await service.start(ARGS);
  assert.equal(state.phase, 'consent');
  state = await service.agreeModelDownload();
  assert.equal(state.phase, 'ringing');
  assert.equal(state.usageWarning !== null, true);
  assert.deepEqual(events.filter(item => item.startsWith('ensure:')), ['ensure:smartTurn', 'ensure:tone']);
  assert.equal(state.persona.role.length > 0, true);
  assert.equal(JSON.stringify(state).includes('key-should-never-be-logged'), false);
  state = await service.answer();
  assert.equal(state.phase, 'in-call');
  assert.equal(service.getPreparedCards()[0].question, CARD.question);
  assert.equal(states.some(item => item.phase === 'downloading'), true);
});

test('hang-up finalises in order and deletes WAVs only with audio', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-finish-'));
  const finished = [];
  const spyFs = new Proxy(nodeFs, {
    get(target, property) {
      if (property === 'writeFile') return async (file, data, options) => { if (!path.basename(file).startsWith('.')) finished.push(`write:${path.basename(file)}`); return target.writeFile(file, data, options); };
      if (property === 'rename') return async (from, to) => { finished.push(`write:${path.basename(to)}`); return target.rename(from, to); };
      if (property === 'unlink') return async file => { finished.push(`unlink:${path.basename(file)}`); return target.unlink(file); };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { deps, events } = makeDeps({
    tmp, modelReady: true, storeFs: spyFs,
    deps: { afconvert: async args => { await nodeFs.writeFile(args.at(-1), 'm4a'); finished.push('afconvert'); } },
  });
  deps.fs = spyFs;
  deps.analyze = async () => { finished.push('analyze'); return { status: 'ready', chapters: [], feedback: null }; };
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await nodeFs.writeFile(path.join(callDir, 'interviewer.wav'), 'interviewer');
  const state = await service.hangUp();
  assert.equal(state.phase, 'replay');
  assert.deepEqual(finished.filter(op => op.startsWith('write:') || op === 'afconvert' || op === 'analyze'),
    // The interview is kept for holding again when the call is answered, before anything of the hang-up.
    ['write:interview.json', 'write:call.json', 'afconvert', 'write:call.json', 'analyze', 'write:analysis.json']);
  const analysisAt = finished.indexOf('write:analysis.json');
  assert.equal(finished.indexOf('unlink:candidate.wav') > analysisAt, true);
  assert.equal(finished.indexOf('unlink:interviewer.wav') > analysisAt, true);
  assert.equal(finished.includes('unlink:call.m4a'), false);
  assert.equal(events.includes('finalize'), true);
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.voiceId, 'v1');
  assert.equal(record.transcript[0].text, 'hello');
});

test('leaving without feedback saves the recording and spends nothing on analysis', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-no-feedback-'));
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { afconvert: async args => { await nodeFs.writeFile(args.at(-1), 'm4a'); } } });
  let analysed = 0;
  let transcribed = 0;
  deps.analyze = async () => { analysed += 1; return { status: 'ready', chapters: [], feedback: null }; };
  deps.transcribe = async () => { transcribed += 1; return { words: [] }; };
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await nodeFs.writeFile(path.join(callDir, 'interviewer.wav'), 'interviewer');
  const state = await service.hangUp({ feedback: false });
  assert.equal(state.phase, 'replay');
  assert.equal(state.feedbackRequested, false);
  assert.equal(analysed + transcribed, 0, 'no analysis or transcription runs');
  assert.equal(await deps.store.readAnalysis('call-1'), null, 'no analysis is stored');
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.feedbackSkipped, true);
  assert.equal(record.transcript[0].text, 'hello');
  assert.equal((await service.getReplay('call-1')).feedback, null);
});

test('closing the window mid-call saves the recording and spends nothing on analysis', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-window-closed-'));
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { afconvert: async args => { await nodeFs.writeFile(args.at(-1), 'm4a'); } } });
  let analysed = 0;
  let transcribed = 0;
  deps.analyze = async () => { analysed += 1; return { status: 'ready', chapters: [], feedback: null }; };
  deps.transcribe = async () => { transcribed += 1; return { words: [] }; };
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await nodeFs.writeFile(path.join(callDir, 'interviewer.wav'), 'interviewer');
  const state = await service.abandon();
  assert.equal(state.phase, 'replay');
  assert.equal(analysed + transcribed, 0, 'no analysis or transcription runs for a closed window');
  assert.equal(await deps.store.readAnalysis('call-1'), null, 'no analysis is stored');
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.reason, 'window-closed');
  assert.equal(record.feedbackSkipped, true);
});

test('hang-up from every phase is safe', async () => {
  for (const [phase, setup] of [
    ['ringing', async service => service.start(ARGS)],
    ['in-call', async service => { await service.start(ARGS); return service.answer(); }],
    ['ended', async service => { await service.start(ARGS); return service.hangUp(); }],
  ]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-phase-'));
    const service = createPracticeCallService(makeDeps({ tmp, modelReady: true }).deps);
    await setup(service);
    const state = await service.hangUp();
    assert.equal(['replay', 'error'].includes(state.phase), true, phase);
  }
});

/** A service whose timers a test fires by hand: `timers` lists every live timeout with its delay. */
async function timedCall(overrides = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-missed-'));
  const harness = makeDeps({ tmp, modelReady: true });
  const timers = [];
  let now = 1000;
  let id = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { id += 1; timers.push({ id, fn, ms }); return id; },
    clearTimeout: handle => { const at = timers.findIndex(timer => timer.id === handle); if (at >= 0) timers.splice(at, 1); },
  };
  const engineOptions = [];
  const engineFactory = harness.deps.engineFactory;
  const service = createPracticeCallService({
    ...harness.deps, clock, random: () => 0.5,
    engineFactory: options => { engineOptions.push(options); return engineFactory(options); },
    ...overrides,
  });
  const fire = ms => { const at = timers.findIndex(timer => timer.ms === ms); assert(at >= 0, `no ${ms} ms timer among ${timers.map(timer => timer.ms)}`); timers.splice(at, 1)[0].fn(); };
  return { ...harness, service, timers, fire, engineOptions, advance: ms => { now += ms; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('a ring nobody answers becomes a missed call after 10 s, and calling back opens the call with that context', async () => {
  const live = await timedCall();
  assert.equal((await live.service.start(ARGS)).phase, 'ringing');
  live.fire(10000);
  let state = live.service.getState();
  assert.equal(state.phase, 'missed');
  assert.equal(state.missed, 'unanswered');
  assert.equal(live.events.includes('stop'), false, 'nothing is torn down: the microphone and sessions wait for the call back');
  assert.equal((await live.service.answer()).phase, 'missed', 'a missed call cannot be answered, only returned');
  live.advance(120000);
  assert.equal(live.service.callBack().phase, 'calling');
  assert.equal(live.timers.some(timer => timer.ms === 10 * 60 * 1000), false, 'the wait for a call back stops once it is returned');
  live.fire(3500); // half-way through the 2 to 5 s the interviewer takes to pick up
  await settle();
  state = live.service.getState();
  assert.equal(state.phase, 'in-call');
  assert.deepEqual(live.engineOptions[0].callback, { how: 'unanswered', agoMs: 120000 }, 'the interviewer is told the ring was missed and how long ago');
  assert.equal((await live.service.hangUp()).phase, 'replay');
  assert.equal((await live.deps.store.readRecord('call-1')).returnedCall, 'unanswered', 'the saved call says it was a returned call');
});

test('declining keeps the call; the outgoing ring can be cancelled; a plain answer carries no call-back note', async () => {
  const live = await timedCall();
  await live.service.start(ARGS);
  assert.equal(live.service.callBack().phase, 'ringing', 'there is nothing to call back while it still rings');
  let state = live.service.decline();
  assert.equal(state.phase, 'missed');
  assert.equal(state.missed, 'declined');
  assert.equal(live.timers.some(timer => timer.ms === 10000), false, 'the ring timeout is cancelled with the ring');
  assert.equal(live.service.decline().phase, 'missed', 'a second decline changes nothing');
  assert.equal(live.service.callBack().phase, 'calling');
  assert.equal(live.service.cancelCallBack().phase, 'missed', 'hanging up before they pick up goes back to the missed call');
  assert.equal(live.timers.some(timer => timer.ms === 3500), false, 'nobody picks up a cancelled call');
  assert.equal(live.timers.filter(timer => timer.ms === 10 * 60 * 1000).length, 1, 'and the caller waits again');
  live.service.callBack();
  live.fire(3500);
  await settle();
  assert.equal(live.service.getState().phase, 'in-call');
  assert.equal(live.engineOptions[0].callback.how, 'declined');
  await live.service.hangUp();

  const plain = await timedCall();
  await plain.service.start(ARGS);
  assert.equal((await plain.service.answer()).phase, 'in-call');
  assert.equal('callback' in plain.engineOptions[0], false);
  assert.equal(plain.timers.some(timer => timer.ms === 10000), false, 'answering stops the ring timeout');
  await plain.service.hangUp();
  assert.equal('returnedCall' in (await plain.deps.store.readRecord('call-1')), false);
});

test('a missed call nobody returns in ten minutes lets everything go and can no longer be returned', async () => {
  const live = await timedCall();
  await live.service.start(ARGS);
  live.service.decline();
  live.fire(10 * 60 * 1000);
  assert.equal((await live.service.start(ARGS)).error?.code, 'already-running', 'no new call starts while the old one is still being let go');
  await settle();
  const state = live.service.getState();
  assert.equal(state.phase, 'missed', 'the window keeps showing the missed call');
  assert.equal(state.missed, 'expired');
  assert.equal(live.events.includes('stop'), true, 'the microphone is released');
  assert.equal(live.service.callBack().phase, 'missed', 'the interviewer is gone');
  assert.equal(await live.deps.store.readRecord('call-1'), null, 'a call that never happened leaves no record');
  // Nothing is running any more, so a new call can start.
  assert.equal((await live.service.start(ARGS)).phase, 'ringing');
  assert.equal(live.service.getState().missed, null);
  await live.service.hangUp();
});

test('closing the window on a missed call abandons it quietly', async () => {
  const live = await timedCall();
  await live.service.start(ARGS);
  live.service.decline();
  assert.equal((await live.service.abandon()).phase, 'replay');
  assert.equal(live.timers.length, 0, 'no timer outlives the call');
  assert.equal(await live.deps.store.readRecord('call-1'), null);
});

test('an interviewer whose replies fail twice drops out like a lost connection: the call screen stays and the record says why', async () => {
  const live = await liveCall();
  await live.service.start(ARGS);
  await live.service.answer();
  live.engine()({ type: 'ended', reason: 'session-error' });
  await settle();
  const state = live.service.getState();
  assert.equal(state.phase, 'in-call', 'the candidate is not thrown onto the ended screen');
  assert.equal(state.interviewerLeft, true);
  assert.equal(state.connectionLost, true);
  assert.equal((await live.service.hangUp()).phase, 'replay');
  assert.equal((await live.deps.store.readRecord('call-1')).reason, 'session-error', 'the review still treats it as a technical ending');
  // A normal goodbye is not a lost connection, and a new call starts clean.
  const next = await liveCall();
  await next.service.start(ARGS);
  await next.service.answer();
  next.engine()({ type: 'ended', reason: 'interviewer' });
  await settle();
  assert.equal(next.service.getState().connectionLost, false);
  await next.service.hangUp();
});

test('leaving asks about feedback after the call is saved, and each answer does what it says', async () => {
  const analysed = [];
  const yes = await liveCall({ deps: { analyze: async () => { analysed.push('yes'); return { status: 'ready', chapters: [], feedback: { summary: 'ok' } }; } } });
  await yes.service.start(ARGS);
  await yes.service.answer();
  const leaving = yes.service.hangUp({ feedback: 'ask' });
  await settle();
  let state = yes.service.getState();
  assert.equal(state.phase, 'ended');
  assert.equal(state.feedbackChoice, 'pending');
  assert.equal((await yes.deps.store.readRecord('call-1')).feedbackSkipped, true, 'until the candidate answers, the saved call is one left without feedback');
  assert.deepEqual(analysed, [], 'nothing is spent before the answer');
  state = await yes.service.chooseFeedback(true);
  assert.equal((await leaving).phase, 'replay');
  assert.equal(state.phase, 'replay');
  assert.equal(state.feedbackChoice, null);
  assert.deepEqual(analysed, ['yes']);
  assert.equal('feedbackSkipped' in (await yes.deps.store.readRecord('call-1')), false);
  assert.equal((await yes.deps.store.readAnalysis('call-1')).status, 'ready');

  const no = await liveCall({ deps: { analyze: async () => { analysed.push('no'); return { status: 'ready', chapters: [] }; } } });
  await no.service.start(ARGS);
  await no.service.answer();
  no.service.hangUp({ feedback: 'ask' });
  await settle();
  state = await no.service.chooseFeedback(false);
  assert.equal(state.phase, 'replay');
  assert.equal(state.feedbackRequested, false);
  assert.equal(analysed.includes('no'), false, 'skipping spends nothing on transcription or the review');
  assert.equal((await no.deps.store.readRecord('call-1')).feedbackSkipped, true);
  assert.equal(await no.deps.store.readAnalysis('call-1'), null);

  // Closing the window, or quitting, while the question is open is a "no".
  for (const close of [service => service.abandon(), service => service.hangUp({ feedback: false })]) {
    const closed = await liveCall({ deps: { analyze: async () => { analysed.push('closed'); return { status: 'ready', chapters: [] }; } } });
    await closed.service.start(ARGS);
    await closed.service.answer();
    const task = closed.service.hangUp({ feedback: 'ask' });
    await settle();
    assert.equal(closed.service.getState().feedbackChoice, 'pending');
    await close(closed.service);
    assert.equal((await task).phase, 'replay');
    assert.equal((await closed.deps.store.readRecord('call-1')).feedbackSkipped, true);
  }
  assert.equal(analysed.includes('closed'), false);

  // A call in which the candidate said nothing has nothing to review, so nothing is asked.
  const silent = await liveCall({ deps: { engineFactory: options => ({ start() { options.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, helperEvent() {}, state: () => ({ transcript: [], elapsedMs: 100 }), typed() {} }) } });
  await silent.service.start(ARGS);
  await silent.service.answer();
  assert.equal((await silent.service.hangUp({ feedback: 'ask' })).phase, 'replay');
});

test('engine ended and helper error end the call', async () => {
  const endedTmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-ended-'));
  const ended = makeDeps({ tmp: endedTmp, modelReady: true });
  const endedService = createPracticeCallService(ended.deps);
  await endedService.start(ARGS);
  await endedService.answer();
  ended.engine()({ type: 'ended', reason: 'interviewer' });
  await new Promise(resolve => setTimeout(resolve, 20));
  // The interviewer ending the call does not end it for the candidate; the interviewers leave one by one a moment later.
  assert.equal(endedService.getState().phase, 'in-call');
  assert.equal(endedService.getState().interviewerLeft, false, 'nobody has left yet');
  assert.equal((await endedService.hangUp()).phase, 'replay');
  assert.equal((await ended.deps.store.readRecord('call-1')).reason, 'interviewer');
  ended.engine()({ type: 'ended', reason: 'timeout' });
  const errorTmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-helper-error-'));
  const failed = makeDeps({ tmp: errorTmp, modelReady: true, helperError: true });
  const errorService = createPracticeCallService(failed.deps);
  await errorService.start(ARGS);
  await errorService.answer();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(['ended', 'analyzing', 'replay'].includes(errorService.getState().phase), true);
  const record = await failed.deps.store.readRecord('call-1');
  assert.equal(record.reason, 'helper-error');
});

test('replay protocol serves ranges, rejects unknowns and symlinks', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-protocol-'));
  const store = createCallStore({ rootDir: path.join(tmp, 'practice-calls') });
  await store.ensure('call-a');
  const audio = path.join(tmp, 'practice-calls', 'call-a', 'call.m4a');
  await writeFile(audio, Buffer.from('0123456789'));
  await store.writeRecord('call-a', { callId: 'call-a', nodeId: 'node-1', startedAt: 1, durationMs: 10, persona: {} });
  const handler = createReplayHandler({ store });
  const full = await handler(new Request('practice-call://call-a/call.m4a'));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mp4');
  assert.equal(Buffer.from(await full.arrayBuffer()).toString(), '0123456789');
  const ranged = await handler(new Request('practice-call://call-a/call.m4a', { headers: { range: 'bytes=2-5' } }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), '2345');
  assert.equal((await handler(new Request('practice-call://unknown/call.m4a'))).status, 404);
  assert.equal((await handler(new Request('practice-call://call-a/../call.json'))).status, 404);
  await symlink(audio, path.join(tmp, 'practice-calls', 'call-a', 'link.wav'));
  const record = await store.readRecord('call-a');
  assert.equal(record.callId, 'call-a');
  assert.equal((await readFile(audio, 'utf8')), '0123456789');
  const deleted = await store.deleteRecording('call-a');
  assert.deepEqual(deleted.deleted.includes('candidate.wav'), false);
  assert.equal((await store.readRecord('call-a')).callId, 'call-a');
});

test('steering reaches both instruction builders and the saved record', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-steering-'));
  const validated = [];
  const built = [];
  const prompts = {
    buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
    buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
  };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { prompts, validateArgs: args => validated.push(args) } });
  const service = createPracticeCallService(deps);
  const focus = 'Final round: ask my salary expectations.';
  const state = await service.start({ ...ARGS, steering: `  ${focus}  ` });
  assert.equal(state.phase, 'ringing');
  assert.deepEqual([...new Set(built.map(item => item.kind))].sort(), ['main', 'opener'], 'both sessions are built');
  assert.equal(built.length > 0, true);
  for (const item of built) assert.equal(item.options.steering, focus, `${item.kind}: the trimmed steering is passed through`);
  assert.deepEqual(validated, [ARGS], 'the strict validator sees exactly the six keys');
  await service.answer();
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.steering, focus, 'the saved record keeps the trimmed steering');
});

test('a start without steering validates with exactly the six keys and records no steering', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-no-steering-'));
  const validated = [];
  const built = [];
  const prompts = {
    buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
    buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
  };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { prompts, validateArgs: args => validated.push(args) } });
  const service = createPracticeCallService(deps);
  const state = await service.start({ ...ARGS });
  assert.equal(state.phase, 'ringing');
  assert.equal(validated.length, 1);
  assert.deepEqual(Object.keys(validated[0]).sort(), Object.keys(ARGS).sort());
  assert.equal('steering' in validated[0], false);
  assert.equal(built.length > 0, true);
  for (const item of built) assert.equal(item.options.steering, '');
  await service.answer();
  await service.hangUp();
  assert.equal((await deps.store.readRecord('call-1')).steering, null);
});

test('steering that is too long or not a string is invalid-request before the strict validator runs', async () => {
  for (const [label, steering] of [['1001 chars', 'x'.repeat(1001)], ['number', 42], ['object', { text: 'hi' }], ['array', ['hi']]]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-steering-bad-'));
    const validated = [];
    const { deps } = makeDeps({ tmp, modelReady: true, deps: { validateArgs: args => validated.push(args) } });
    const service = createPracticeCallService(deps);
    const state = await service.start({ ...ARGS, steering });
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'invalid-request', label);
    assert.deepEqual(validated, [], `${label}: the strict six-key validator is never reached`);
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-steering-max-'));
  const service = createPracticeCallService(makeDeps({ tmp, modelReady: true }).deps);
  const state = await service.start({ ...ARGS, steering: `  ${'x'.repeat(1000)}  ` });
  assert.equal(state.phase, 'ringing', 'the 1000-character limit applies to the trimmed text');
});

test('setPaused forwards to the engine, publishes from the engine event, saves pausedMs and clears on hang-up', async () => {
  let now = 1000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const forwarded = [];
  const emitted = {};
  const { service, deps } = await liveCall({ deps: {
    clock,
    engineFactory: options => ({
      start() { emitted.fn = options.onEvent; options.onEvent({ type: 'phase', phase: 'listening' }); },
      hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }),
      setPaused(value) { forwarded.push(value); },
    }),
  } });
  const engine = () => emitted.fn;
  assert.equal(service.getState().paused, false);
  service.setPaused(true);
  assert.deepEqual(forwarded, [], 'no call yet');
  await service.start(ARGS);
  await service.answer();
  service.setPaused(true);
  assert.deepEqual(forwarded, [true]);
  assert.equal(service.getState().paused, false, 'the engine event is the source of truth');
  now += 2000;
  engine()({ type: 'paused', paused: true });
  assert.equal(service.getState().paused, true);
  now += 5000;
  engine()({ type: 'paused', paused: false });
  assert.equal(service.getState().paused, false);
  engine()({ type: 'paused', paused: true });
  now += 3000;
  await service.hangUp();
  assert.equal(service.getState().paused, false);
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.pausedMs, 8000);
});

test('setPaused is ignored once the interviewer has ended the call', async () => {
  const forwarded = [];
  const emitted = {};
  const { service } = await liveCall({ deps: {
    engineFactory: options => ({
      start() { emitted.fn = options.onEvent; options.onEvent({ type: 'phase', phase: 'listening' }); },
      hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }),
      setPaused(value) { forwarded.push(value); },
    }),
  } });
  const engine = () => emitted.fn;
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'paused', paused: true });
  engine()({ type: 'ended', reason: 'interviewer' });
  assert.equal(service.getState().paused, false, 'the interviewer ending the call clears the pause');
  service.setPaused(true);
  assert.deepEqual(forwarded, []);
  await service.hangUp();
});

test('the call timer freezes while paused and does not jump afterwards', async () => {
  let now = 1000;
  let tick = null;
  const clock = { now: () => now, setTimeout: fn => { tick = fn; return 1; }, clearTimeout: () => {} };
  const { service, engine } = await liveCall({ deps: { clock } });
  await service.start(ARGS);
  await service.answer();
  now += 10000;
  tick();
  assert.equal(service.getState().elapsedMs, 10000);
  engine()({ type: 'paused', paused: true });
  now += 30000;
  tick();
  assert.equal(service.getState().elapsedMs, 10000);
  engine()({ type: 'paused', paused: false });
  assert.equal(service.getState().elapsedMs, 10000, 'no jump on resume');
  now += 2000;
  tick();
  assert.equal(service.getState().elapsedMs, 12000);
});

/** A finished call whose review failed, with both raw tracks written, and a service able to run the review again. */
async function failedReviewCall({ withCallText = true } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-retry-'));
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { afconvert: async args => { await nodeFs.writeFile(args.at(-1), 'm4a'); } } });
  const analyses = [];
  let next = () => ({ status: 'failed', error: 'feedback: overall.summary must be a string of at most 1500 characters.', retry: { role: { title: 'Engineer', company: 'Acme' }, pool: { 1: { question: 'Tell me about a launch.' } } } });
  deps.fs = nodeFs;
  deps.analyze = async input => { analyses.push(input); return next(input); };
  if (withCallText) deps.callText = async () => ({});
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await nodeFs.writeFile(path.join(callDir, 'interviewer.wav'), 'interviewer');
  await service.hangUp();
  return { tmp, deps, service, callDir, analyses, setNext: fn => { next = fn; } };
}
const exists = async file => nodeFs.lstat(file).then(() => true, () => false);

test('a failed review keeps the raw tracks for a retry, and the leftover tidy leaves them alone', async () => {
  const { service, callDir, deps } = await failedReviewCall();
  assert.equal((await deps.store.readAnalysis('call-1')).status, 'failed');
  assert.equal(await exists(path.join(callDir, 'candidate.wav')) && await exists(path.join(callDir, 'interviewer.wav')), true, 'both tracks are kept');
  await service.tidyLeftoverAudio();
  assert.equal(await exists(path.join(callDir, 'candidate.wav')), true, 'the tidy keeps the tracks of a recent call with a failed review');
  const replay = await service.getReplay('call-1');
  assert.equal(replay.analysis.status, 'failed');
});

test('retryAnalysis runs the review again from the saved record, shows progress, files the result, and deletes the raw tracks once it is stored', async () => {
  const { service, callDir, deps, analyses, setNext } = await failedReviewCall();
  const seen = [];
  service.onReplayUpdated(replay => seen.push(replay?.analysis?.status));
  setNext(input => { input.deps.onStage?.('review'); input.deps.onEvent?.('begin', { transcriptEntries: 1 }); return { status: 'ready', chapters: [], feedback: { summary: 'fixed', callId: null } }; });
  const result = await service.retryAnalysis('call-1');
  assert.deepEqual(result, { status: 'ready' });
  const input = analyses.at(-1);
  assert.equal(input.callDir, callDir);
  assert.equal(input.callRecord.callId, 'call-1', 'the saved record is reviewed');
  assert.deepEqual(input.retry, { role: { title: 'Engineer', company: 'Acme' }, pool: { 1: { question: 'Tell me about a launch.' } } }, 'the plan comes from what the failed review kept');
  assert.equal(typeof input.deps.transcribe, 'function', 'the tracks are there, so the answers are transcribed again');
  assert.equal(input.deps.callText, deps.callText);
  assert.equal(seen.includes('analyzing'), true, 'the replay reports the review running');
  const stored = await deps.store.readAnalysis('call-1');
  assert.equal(stored.status, 'ready');
  assert.equal((await service.getReplay('call-1')).analysis.status, 'ready');
  assert.equal(await exists(path.join(callDir, 'candidate.wav')) || await exists(path.join(callDir, 'interviewer.wav')), false, 'the tracks go once the review is stored');
  assert.equal(await exists(path.join(callDir, 'call.m4a')), true);
  const log = (await nodeFs.readFile(path.join(callDir, 'debug.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const at = log.findIndex(line => line.event === 'analysis-retry');
  assert.ok(at >= 0 && log.slice(at).some(line => line.event === 'analysis-begin') && log.slice(at).some(line => line.event === 'analysis-retry-done'), 'the retry is logged like the first run');
  assert.deepEqual((await service.retryAnalysis('call-1')).error, 'Only a failed review can be run again.');
});

test('retryAnalysis without the raw tracks reviews without transcription, and a failing run stays retryable', async () => {
  const { service, callDir, deps, analyses, setNext } = await failedReviewCall();
  await nodeFs.unlink(path.join(callDir, 'candidate.wav'));
  setNext(() => ({ status: 'failed', error: 'feedback: still wrong', retry: { role: {}, pool: {} } }));
  const failed = await service.retryAnalysis('call-1');
  assert.deepEqual(failed, { status: 'failed', error: 'feedback: still wrong' });
  const input = analyses.at(-1);
  assert.equal(input.deps.transcribe, undefined);
  assert.equal(input.deps.audioAvailable, false);
  assert.equal((await deps.store.readAnalysis('call-1')).error, 'feedback: still wrong');
  assert.equal(await exists(path.join(callDir, 'interviewer.wav')), true, 'a failed retry deletes nothing');
  const replay = await service.getReplay('call-1');
  assert.equal(replay.analysis.status, 'failed');
  assert.equal(replay.analysis.error, 'feedback: still wrong');
  setNext(() => { throw new Error('boom'); });
  assert.equal((await service.retryAnalysis('call-1')).status, 'failed', 'a thrown analysis is a failed review, not a thrown retry');
  setNext(() => ({ status: 'ready', chapters: [], feedback: { summary: 'ok' } }));
  assert.equal((await service.retryAnalysis('call-1')).status, 'ready');
});

test('retryAnalysis is refused by a service built without the review AI, and for a call that is not there', async () => {
  const bare = await failedReviewCall({ withCallText: false });
  assert.deepEqual(await bare.service.retryAnalysis('call-1'), { error: 'The feedback review is not available.' });
  assert.equal(bare.analyses.length, 1, 'only the first run analysed');
  const { service } = await failedReviewCall();
  assert.equal((await service.retryAnalysis('call-nope')).error, 'This call can no longer be reviewed.');
});

export default cases;

// --- guards against the real modules the service now imports on demand -----

const startOf = async overrides => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-real-'));
  const built = makeDeps({ tmp, modelReady: true, ...overrides });
  return { tmp, ...built, service: createPracticeCallService(built.deps) };
};

test('every DEFAULTS factory resolves to a function of the real modules', async () => {
  const { DEFAULTS, MODULES } = await import('../../electron/practiceCall/callService.js');
  const names = Object.keys(DEFAULTS);
  assert.equal(names.length >= 18, true);
  for (const name of names) {
    assert.equal(typeof DEFAULTS[name], 'function', `${name} is a lazy factory`);
    const value = await DEFAULTS[name]();
    assert.equal(typeof value, 'function', `${name} resolves to a function`);
  }
  for (const name of ['voiceFactory', 'subscriptionTier', 'rateForTier', 'transcribeVerbatim', 'earFactory', 'analyze']) {
    assert.equal(names.includes(name), true, `${name} is a default`);
  }
  const prompts = await MODULES.prompts();
  assert.equal(typeof prompts.buildInterviewerInstructions, 'function');
  const catalog = await MODULES.catalog();
  assert.equal(typeof catalog.pickPersonaVoice, 'function');
});

test('the tier comes from the dialogue voice module and sets the voice rate', async () => {
  const seen = {};
  const tempo = [];
  const { service } = await startOf({ deps: {
    fetch: async () => { throw new Error('the service must not fetch the subscription itself'); },
    subscriptionTier: async options => { seen.tierOptions = options; return 'paid'; },
    rateForTier: tier => { seen.rated = tier; return 44100; },
    voiceFactory: options => {
      seen.voice = options;
      // The unsaved library voice answers its warm-up line, so the call can ring.
      return {
        open: () => ({
          onAudio(listener) { seen.warmAudio = listener; }, onWords() {}, sendText() {}, cancel() {},
          finish: async () => { seen.warmAudio?.(new Uint8Array(1024)); },
        }),
      };
    },
    trackFactory: options => { seen.track = options; tempo.push('track'); return { started() {}, ended() {}, addUtterance() {}, finalize: async () => {} }; },
    catalog: {
      listConversationalVoices: async () => [{ voiceId: 'v1', name: 'Ada Lovelace' }],
      pickPersonaVoice: options => ({ voiceId: 'v1', name: 'Ada Lovelace', temperament: options.temperament }),
    },
  } });
  await service.start(ARGS);
  assert.equal(seen.tierOptions.key, 'key-should-never-be-logged');
  assert.equal(seen.voice.tier, 'paid');
  assert.equal(seen.rated, 'paid');
  assert.deepEqual(seen.track, { sampleRate: 44100 });
});

test('the ElevenLabs key is read without a promisified execFile', async () => {
  const calls = [];
  const { service } = await startOf({ deps: { readKey: (...args) => { calls.push(args); return 'key-1'; } } });
  await service.start(ARGS);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], []);
});

test('the lead\'s temperament comes from the plan unless the request or the brief fixes one', async () => {
  const sessionsOf = () => {
    const starts = [];
    let made = 0;
    const factory = () => {
      const kind = ['opener', 'main', 'classifier'][made++];
      return { start: async ({ instructions }) => { starts.push({ kind, instructions }); return { reply: 'READY' }; } };
    };
    return { starts, factory };
  };
  const character = { traits: 'Dominant, Firm', descriptive: '', about: 'Brash and openly confident.' };
  const run = async ({ planned, loadBrief } = {}) => {
    const seen = {};
    const { starts, factory } = sessionsOf();
    const built = await startOf({ modelReady: true, deps: {
      random: () => 0,
      sessionsFactory: factory,
      planCall: fakePlanner(voices => soloPlan(voices, { lead: { ...soloPlan(voices).lead, temperament: planned } })),
      prompts: {
        buildInterviewerInstructions: ({ persona }) => `main:${persona.temperament}:${persona.voice?.character?.traits}`,
        buildOpenerInstructions: ({ persona }) => `opener:${persona.temperament}`,
      },
      catalog: {
        listConversationalVoices: async () => [{ voiceId: 'v1', name: 'Ada Lovelace' }],
        pickPersonaVoice: options => {
          if (seen.temperament === undefined) seen.temperament = options.temperament; // the lead's pick is the first one
          return { voiceId: 'v1', name: 'Ada Lovelace', gender: 'male', age: 'middle_aged', accent: 'american', character, temperament: null };
        },
      },
    } });
    if (loadBrief) built.deps.loadBrief = loadBrief(built.deps.loadBrief);
    const service = createPracticeCallService(built.deps);
    const state = await service.start(ARGS);
    return { seen, starts, state, built };
  };
  const chosen = await run({ planned: 'tough' });
  assert.equal(chosen.seen.temperament, null, 'no temperament is imposed on the voice pick');
  assert.equal(chosen.starts.find(item => item.kind === 'main').instructions, 'main:tough:Dominant, Firm');
  assert.equal(chosen.starts.find(item => item.kind === 'opener').instructions, 'opener:tough');
  assert.equal(chosen.state.persona.role, 'Hiring Manager');
  assert.equal(chosen.state.persona.team, '', 'a brief with no team names none');
  assert.equal(chosen.built.deps.planCall.calls[0].voices[0].description.includes('Dominant, Firm'), true, 'the planner is told how the voice sounds');

  const warm = await run({ planned: 'warm' });
  assert.equal(warm.starts.find(item => item.kind === 'opener').instructions, 'opener:warm');

  const asked = await run({
    planned: 'warm',
    loadBrief: brief => async args => {
      const loaded = await brief(args);
      return { ...loaded, role: { ...loaded.role, team: 'Platform' }, practice: { temperament: 'tough' } };
    },
  });
  assert.equal(asked.seen.temperament, 'tough');
  assert.equal(asked.starts.find(item => item.kind === 'main').instructions, 'main:tough:Dominant, Firm', 'a fixed temperament wins over the plan');
  assert.equal(asked.starts.find(item => item.kind === 'opener').instructions, 'opener:tough');
  assert.equal(asked.state.persona.team, 'Platform');
});

test('analysis gets the Claude text call and a Scribe transcribe closure', async () => {
  const seen = {};
  const callText = async () => ({ ok: true });
  const transcribeVerbatim = async options => { seen.transcribe = options; return { text: 'verbatim words', words: [] }; };
  const { tmp, service } = await startOf({ deps: {
    callText, transcribeVerbatim,
    analyze: async input => {
      seen.input = input;
      const text = await input.deps.transcribe({ path: path.join(tmp, 'practice-calls', 'call-1', 'candidate.wav') });
      return { analysis: { status: 'ready', chapters: [], transcriptText: text.text }, feedback: { summary: 'ok' } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.equal(seen.input.deps.callText, callText);
  assert.equal(typeof seen.input.deps.transcribe, 'function');
  assert.equal(seen.input.callDir, path.join(tmp, 'practice-calls', 'call-1'));
  assert.equal(seen.transcribe.path, path.join(tmp, 'practice-calls', 'call-1', 'candidate.wav'));
  assert.equal(seen.transcribe.key, 'key-should-never-be-logged');
  const replay = await service.getReplay('call-1');
  assert.equal(replay.feedback.callId, 'call-1');
});

test('feedback is saved through the practice registry after the call', async () => {
  for (const alreadyArmed of [false, true]) {
    const log = [];
    let arms = 0;
    const registry = {
      arm: async request => {
        arms += 1;
        log.push(`arm:${request.nodeId}:${request.company}:${request.role}:${request.questionCount}`);
        if (alreadyArmed && arms === 1) throw Object.assign(new Error('already armed'), { code: 'already_armed' });
        return 'session-1';
      },
      cancel: nodeId => { log.push(`cancel:${nodeId}`); },
      finish: (code, feedback) => { log.push(`finish:${code}:${feedback.callId}`); return { status: 'accepted' }; },
    };
    const feedbackErrors = [];
    const { service } = await startOf({ deps: {
      registry,
      analyze: async () => ({ status: 'ready', chapters: [], feedback: { summary: 'solid', callId: null } }),
    } });
    service.onEvent(event => { if (event.kind === 'feedback-error') feedbackErrors.push(event); });
    await service.start(ARGS);
    await service.answer();
    const state = await service.hangUp();
    assert.equal(state.phase, 'replay');
    assert.equal(log.includes('arm:node-1:Acme:Engineer:1'), true);
    // The call is the only thing that arms a session, so one found armed is a leftover from a call
    // whose feedback was never stored: it is closed and this call's feedback is saved.
    assert.equal(log.includes('cancel:node-1'), alreadyArmed);
    assert.equal(log.filter(item => item.startsWith('arm:')).length, alreadyArmed ? 2 : 1);
    assert.equal(log.includes('finish:session-1:call-1'), true);
    assert.equal(feedbackErrors.length, 0);
  }
});

test('the ear gets the smart-turn and tone model paths plus the candidate recording', async () => {
  const seen = { names: [] };
  const { tmp, service } = await startOf({ deps: {
    modelStore: () => ({
      status: () => ({ smartTurn: 'ready', tone: 'ready' }),
      ensure: async () => {},
      pathOf: name => { seen.names.push(name); return path.join(tmp, 'practice-models', `${name}.onnx`); },
    }),
    earFactory: options => {
      seen.ear = options;
      return { noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] };
    },
  } });
  await service.start(ARGS);
  assert.deepEqual(seen.names, ['smartTurn', 'tone']);
  assert.equal(seen.ear.smartTurnPath, path.join(tmp, 'practice-models', 'smartTurn.onnx'));
  assert.equal(seen.ear.tonePath, path.join(tmp, 'practice-models', 'tone.onnx'));
  assert.equal(seen.ear.candidatePath, path.join(tmp, 'practice-calls', 'call-1', 'candidate.wav'));
  assert.equal(typeof seen.ear.onToneSample, 'function');
});

test('the ear gets an inference factory that names the built worker entry', async () => {
  const seen = { options: [], factories: [] };
  const worker = { endOfTurn: async () => 0.5, tone: async () => null, close() {} };
  const earFactory = options => {
    seen.factories.push(options.inference);
    return { noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] };
  };
  const inference = async options => { seen.options.push(options); return worker; };
  const built = path.join('dist-electron', 'inferenceWorkerThread.js');
  const models = { smartTurnPath: '/models/smart-turn.onnx', tonePath: '/models/tone.onnx' };

  const first = await startOf({ modelReady: true, deps: { inference, inferenceWorkerPath: built, earFactory } });
  await first.service.start(ARGS);
  assert.equal(typeof seen.factories[0], 'function');
  assert.equal(await seen.factories[0]({ ...models }), worker);
  assert.deepEqual(seen.options[0], { ...models, workerPath: built });

  const second = await startOf({ modelReady: true, deps: { inference, earFactory } });
  await second.service.start(ARGS);
  await seen.factories[1]({ ...models });
  assert.equal(seen.options[1].workerPath, undefined, 'without the option the source-tree default applies');
});

test('model download reports progress before ringing', async () => {
  const ensured = [];
  const { tmp, service } = await startOf({ modelReady: false, deps: {
    modelStore: () => ({
      status: () => ({ smartTurn: 'missing', tone: 'missing' }),
      ensure: async (name, { onProgress }) => { ensured.push(name); onProgress?.({ receivedBytes: 10, totalBytes: 100 }); },
      pathOf: name => path.join(tmp, 'practice-models', `${name}.onnx`),
    }),
  } });
  const states = [];
  service.onState(state => states.push(state));
  let state = await service.start(ARGS);
  assert.equal(state.phase, 'consent');
  state = await service.agreeModelDownload();
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(ensured, ['smartTurn', 'tone']);
  assert.equal(states.some(item => item.phase === 'downloading' && item.modelDownload?.receivedBytes === 10), true);
});

test('hang-up from precheck and connecting is safe', async () => {
  let releaseKey;
  const precheck = await startOf({ deps: { readKey: () => new Promise(resolve => { releaseKey = () => resolve('key-1'); }) } });
  const pending = precheck.service.start(ARGS);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(precheck.service.getState().phase, 'precheck');
  assert.equal((await precheck.service.hangUp()).phase, 'replay');
  releaseKey();
  await pending.catch(() => {});
  const connecting = await startOf({ deps: {
    engineFactory: options => ({ start() { options.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }),
  } });
  await connecting.service.start(ARGS);
  const answering = connecting.service.answer();
  assert.equal(connecting.service.getState().phase, 'connecting');
  assert.equal((await connecting.service.hangUp()).phase, 'replay');
  await answering.catch(() => {});
});

test('a symlinked recording is never served', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-symlink-'));
  const store = createCallStore({ rootDir: path.join(tmp, 'practice-calls') });
  await store.ensure('call-b');
  const secret = path.join(tmp, 'secret.m4a');
  await writeFile(secret, 'secret-bytes');
  await symlink(secret, path.join(tmp, 'practice-calls', 'call-b', 'call.m4a'));
  const handler = createReplayHandler({ store });
  const response = await handler(new Request('practice-call://call-b/call.m4a'));
  assert.equal(response.status, 404);
  assert.notEqual(await response.text(), 'secret-bytes');
});

test('R1 mirror playback forwards to the helper and fills the real interviewer track', async () => {
  const { createInterviewerTrack } = await import('../../electron/practiceCall/audio/trackWriter.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r1-'));
  const seen = { plays: [] };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    trackFactory: options => { seen.options = options; seen.track = createInterviewerTrack(options); return seen.track; },
    helperFactory: () => ({
      start: async () => ({ ok: true }), play: (id, rate) => { seen.plays.push([id, rate]); return { ok: true }; },
      pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {},
    }),
    engineFactory: options => { seen.audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  assert.equal(seen.audio.play('u1', 24000).ok, true);
  seen.audio.pushAudio('u1', Buffer.alloc(4800), 24000);
  seen.audio.endUtterance('u1');
  seen.audio.helperEvent({ type: 'playback', utteranceId: 'u1', state: 'started', atMs: 1300, positionMs: 0 });
  seen.audio.helperEvent({ type: 'playback', utteranceId: 'u1', state: 'finished', atMs: 1500, positionMs: 100 });
  assert.deepEqual(seen.plays, [['u1', 24000]]);
  assert.deepEqual(seen.options, { sampleRate: 44100 });
  const segments = seen.track.segments('u1');
  assert.equal(segments.length >= 1, true);
  assert.deepEqual(segments.at(-1), { wallStartMs: 1300, audioStartMs: 0, audioEndMs: 100 });
});

test('R1b the mirror applies no treatment of its own: audio reaches the helper as given', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-sound-'));
  const seen = { pushed: [] };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    callSound: () => { throw new Error('the mirror must not build a processor'); },
    helperFactory: () => ({
      start: async () => ({ ok: true }), play() {}, pushAudio: (id, pcm) => { seen.pushed.push(Buffer.from(pcm)); },
      endUtterance() {}, cancel() {}, mute() {}, stop: async () => {},
    }),
    engineFactory: options => { seen.audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const input = Buffer.alloc(4800);
  for (let at = 0; at < input.length; at += 2) input.writeInt16LE(Math.round(8000 * Math.sin(at / 20)), at);
  seen.audio.play('u1', 24000);
  seen.audio.pushAudio('u1', input, 24000);
  assert.deepEqual(seen.pushed[0], input);
});

test('R2 helper playback events keyed by utteranceId drive the track with helper timing', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r2-'));
  const calls = [];
  const track = {
    addUtterance: () => calls.push(['add']), started: (id, atMs) => calls.push(['started', id, atMs]),
    paused: (id, positionMs, atMs) => calls.push(['paused', id, positionMs, atMs]), resumed: (id, atMs) => calls.push(['resumed', id, atMs]),
    ended: (id, positionMs, atMs) => calls.push(['ended', id, positionMs, atMs]), finalize: async () => {},
  };
  let helperEvent;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    trackFactory: () => track,
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {} };
    },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'started', atMs: 700, positionMs: 0 });
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'paused', atMs: 900, positionMs: 25 });
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'resumed', atMs: 1200 });
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'finished', atMs: 1500, positionMs: 60 });
  helperEvent({ type: 'playback', state: 'started', atMs: 1, positionMs: 0 });
  assert.deepEqual(calls, [
    ['started', 'u1', 700], ['paused', 'u1', 25, 900], ['resumed', 'u1', 1200], ['ended', 'u1', 60, 1500],
  ]);
});

test('R3 failing the engine stops helper, ear and sessions, then a fresh start works', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r3-'));
  const stopped = [];
  let ids = 0;
  let engineAttempts = 0;
  const ear = { noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [], settle: async () => {}, close: () => stopped.push('ear') };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    newId: () => `call-${++ids}`,
    trackFactory: () => ({ started() {}, ended() {}, addUtterance() {}, finalize: async () => {} }),
    earFactory: () => ear,
    sessionsFactory: () => ({ start: async () => {}, close: () => stopped.push('session') }),
    helperFactory: () => ({ start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { stopped.push('helper'); } }),
    engineFactory: () => {
      engineAttempts += 1;
      if (engineAttempts === 1) return { start() { throw new Error('engine broke'); }, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
      return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
    },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  assert.equal((await service.answer()).phase, 'error');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped.includes('helper'), true);
  assert.equal(stopped.includes('ear'), true);
  assert.equal(stopped.includes('session'), true);
  const again = await service.start(ARGS);
  assert.equal(again.phase, 'ringing');
  assert.equal((await service.answer()).phase, 'in-call');
});

test('R4 a refused helper start fails the call with the helper code', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r4-'));
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    helperFactory: () => ({ start: async () => ({ ok: false, code: 'mic-denied' }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {} }),
  } });
  const state = await createPracticeCallService(deps).start(ARGS);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'mic-denied');
});

test('R5 two concurrent starts create one call and one already-running result', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r5-'));
  let briefs = 0;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    loadBrief: async (...args) => { briefs += 1; await new Promise(resolve => setTimeout(resolve, 5)); return makeDeps({ tmp }).deps.loadBrief(...args); },
  } });
  const service = createPracticeCallService(deps);
  const [first, second] = await Promise.all([service.start(ARGS), service.start(ARGS)]);
  assert.equal(briefs, 1);
  assert.equal([first.phase, second.phase].filter(phase => phase === 'ringing').length, 1);
  const blocked = [first, second].find(state => state.phase === 'error');
  assert.equal(blocked.error.code, 'already-running');
  assert.equal(service.getState().callId, 'call-1');
  assert.equal([first, second].filter(state => state.callId === 'call-1').length >= 1, true);
});

test('R7 finishCall keeps its own call snapshot across the analysis wait', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r7-'));
  let releaseAnalysis;
  let ids = 0;
  const gate = new Promise(resolve => { releaseAnalysis = resolve; });
  let analysed = 0;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    newId: () => `call-${++ids}`,
    analyze: async () => { analysed += 1; await gate; return { status: 'ready', chapters: [], feedback: { summary: 'first' } }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const finishing = service.hangUp();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.getState().callId, 'call-1');
  assert.equal(service.getState().phase, 'analyzing');
  const blocked = await service.start(ARGS);
  assert.equal(blocked.error.code, 'already-running');
  releaseAnalysis();
  const state = await finishing;
  assert.equal(state.phase, 'replay');
  assert.equal(analysed, 1);
  const replay = await service.getReplay('call-1');
  assert.equal(replay.feedback.summary, 'first');
  const next = await service.start(ARGS);
  assert.equal(next.callId, 'call-2');
  assert.equal((await service.getReplay('call-1')).callId, 'call-1');
});

test('R8 a pre-call abort deletes the directory and never analyses', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r8-'));
  let releaseKey;
  let analysed = 0;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    readKey: () => new Promise(resolve => { releaseKey = () => resolve('key-1'); }),
    analyze: async () => { analysed += 1; return { status: 'ready', chapters: [], feedback: null }; },
  } });
  const service = createPracticeCallService(deps);
  const pending = service.start(ARGS);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.getState().phase, 'precheck');
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  assert.equal((await nodeFs.lstat(callDir)).isDirectory(), true);
  assert.equal((await service.hangUp()).phase, 'replay');
  await assert.rejects(nodeFs.lstat(callDir), error => error.code === 'ENOENT');
  releaseKey();
  await pending.catch(() => {});
  assert.equal(analysed, 0);
  assert.equal(await deps.store.readRecord('call-1'), null);
});

test('R9 a live call refuses to delete its recording', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r9-'));
  const { deps } = makeDeps({ tmp, modelReady: true });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await service.answer();
  assert.equal(await service.deleteRecording('call-1'), null);
  assert.equal((await nodeFs.readFile(path.join(callDir, 'candidate.wav'), 'utf8')), 'candidate');
  await service.hangUp();
  const deleted = await service.deleteRecording('call-1');
  assert.equal(deleted.deleted.includes('candidate.wav'), true);
  await assert.rejects(nodeFs.lstat(path.join(callDir, 'candidate.wav')), error => error.code === 'ENOENT');
});

test('R13 records are written to a 0600 sibling temp file and renamed', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r13-'));
  const root = path.join(tmp, 'practice-calls');
  const log = [];
  const spyFs = new Proxy(nodeFs, {
    get(target, property) {
      if (property === 'writeFile') return async (file, data, options) => { log.push({ op: 'write', file, mode: options?.mode }); return target.writeFile(file, data, options); };
      if (property === 'rename') return async (from, to) => { log.push({ op: 'rename', from, to }); return target.rename(from, to); };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createCallStore({ rootDir: root, fs: spyFs });
  await store.writeRecord('call-1', { callId: 'call-1', nodeId: 'node-1', startedAt: 1, durationMs: 5 });
  const callDir = path.join(root, 'call-1');
  const write = log.find(entry => entry.op === 'write');
  const rename = log.find(entry => entry.op === 'rename');
  assert.equal(path.dirname(write.file), callDir);
  assert.equal(path.basename(write.file).startsWith('.call.json'), true);
  assert.equal(write.mode, 0o600);
  assert.equal(rename.from, write.file);
  assert.equal(rename.to, path.join(callDir, 'call.json'));
  assert.equal((await store.readRecord('call-1')).callId, 'call-1');
  const other = path.join(tmp, 'elsewhere');
  await nodeFs.mkdir(other);
  await nodeFs.rm(callDir, { recursive: true });
  await nodeFs.symlink(other, callDir);
  await assert.rejects(store.remove('call-1'), error => error.code === 'SYMLINK');
  assert.deepEqual(await nodeFs.readdir(other), []);
});

test('R10 window start reuses a live call window and replaces a replay window', async () => {
  const { createPracticeCallController } = await import('../../electron/practiceCall/callWindow.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r10-'));
  const windows = [];
  class FakeWindow {
    constructor(options) {
      this.options = options; this.destroyed = false; this.handlers = {};
      this.webContents = { send() {}, mainFrame: {} };
      windows.push(this);
    }
    once(name, fn) { this.handlers[name] = fn; }
    on(name, fn) { this.handlers[name] = fn; }
    isDestroyed() { return this.destroyed; }
    show() {} focus() {} loadURL(url) { this.url = url; } loadFile(file, options) { this.file = file; this.search = options.search; }
    close() { if (this.destroyed) return; this.destroyed = true; this.handlers.closed?.(); }
  }
  const ipc = new Map();
  const ipcMain = { handle: (channel, fn) => ipc.set(channel, fn), removeHandler: channel => ipc.delete(channel) };
  const invoke = (channel, args) => ipc.get(channel)({}, args);
  const abandons = [];
  let starts = 0;
  const service = {
    onState() {}, onEvent() {}, onReplayUpdated() {},
    getState: () => ({ phase: 'ringing', callId: 'call-1' }),
    start: async () => { starts += 1; return { phase: 'ringing', callId: 'call-1' }; },
    abandon: async () => { abandons.push(1); return { phase: 'replay' }; },
  };
  createPracticeCallController({
    BrowserWindow: FakeWindow, ipcMain, isAuthorizedOwner: () => true, userDataPath: tmp,
    store: { readRecord: async callId => ({ callId, nodeId: 'n1' }) }, service,
  });
  const first = await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(first.phase, 'ringing');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].search, 'view=practice-call&callId=call-1');
  const blocked = await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(blocked.error.code, 'already-running');
  assert.equal(starts, 1);
  assert.equal(windows.length, 1);
  const refused = await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-1' });
  assert.equal(refused.success, false, 'a replay never takes over a live call window');
  assert.equal(windows.length, 1);
  windows[0].close();
  assert.equal(abandons.length, 1, 'closing the live call window abandons the call');
  await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-1' });
  assert.equal(windows.length, 2);
  await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(windows[1].destroyed, true, 'the replay window is closed first');
  assert.equal(windows.length, 3);
  assert.equal(windows[2].search, 'view=practice-call&callId=call-1');
  windows[2].close();
  assert.equal(abandons.length, 2, 'closing a live call window abandons the call');
});

test('R11 elapsedMs ticks from the clock and level follows helper rms', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r11-'));
  const base = Date.now();
  let now = base;
  const timers = new Map();
  let timerId = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
  let helperEvent;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    clock,
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {} };
    },
    engineFactory: options => ({
      start() { options.onEvent({ type: 'phase', phase: 'in-call' }); },
      hangUp() {},
      state: () => ({ transcript: [], elapsedMs: 0 }),
    }),
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  now = base + 1500;
  runTimers();
  const elapsed = service.getState().elapsedMs;
  assert.equal(elapsed >= 1490 && elapsed <= 1500, true, `elapsedMs was ${elapsed}`);
  helperEvent({ type: 'level', rms: 0.35 });
  assert.equal(service.getState().level, 0.35);
  helperEvent({ type: 'level', rms: 4 });
  assert.equal(service.getState().level, 1);
});

test('R12 finish waits for ear.settle before snapshotting tone samples and closes the ear', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r12-'));
  const seen = { settle: [], closed: 0, samples: [] };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    earFactory: options => ({
      noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }),
      settle: async timeoutMs => {
        seen.settle.push(timeoutMs);
        await new Promise(resolve => setTimeout(resolve, 10));
        const sample = { atMs: 1, endMs: 2, arousal: 0.5, dominance: 0.5, valence: 0.5 };
        seen.samples.push(sample);
        options.onToneSample(sample);
      },
      toneSamples: () => seen.samples.slice(),
      close: () => { seen.closed += 1; },
    }),
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.deepEqual(seen.settle, [2000]);
  assert.equal(seen.closed, 1);
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.toneSamples.length, 1);
  assert.equal(record.toneSamples[0].atMs, 1);
  assert.equal(record.toneNotes, undefined);
});

// --- the interviewer voice draw: the shared library only, warm-up and the pool file ---

// Kept only to prove that no account voice is ever drawn or picked.
const ACCOUNT_VOICES = Object.freeze([
  { voiceId: 'v1', voiceName: 'Ada - calm', gender: 'female', age: 'young', accent: 'british', useCases: ['conversational'], category: 'premade', description: '' },
  { voiceId: 'v2', voiceName: 'Bo - warm', gender: 'male', age: 'middle aged', accent: 'american', useCases: ['conversational'], category: 'premade', description: '' },
]);
const DRAWN_LIBRARY_VOICE = Object.freeze({
  voiceId: 'lib-1', voiceName: 'Nora - crisp', gender: 'female', age: 'middle aged', accent: 'american',
  useCases: ['conversational'], category: 'professional', description: 'A crisp, confident voice.',
  descriptive: 'confident', language: 'en', rate: null,
});
const SECOND_LIBRARY_VOICE = Object.freeze({
  voiceId: 'lib-2', voiceName: 'Miles - dry', gender: 'male', age: 'young', accent: 'irish',
  useCases: ['conversational'], category: 'professional', description: 'A dry, even voice.',
  descriptive: 'dry', language: 'en', rate: null,
});
const poolFilePath = tmp => path.join(tmp, 'practice-voice-pool.json');
// One raw /v1/shared-voices row, for the test that runs the real draw against a fake fetch.
const SHARED_LIBRARY_ROW = Object.freeze({
  voice_id: 'lib-1', public_owner_id: 'owner-1', name: 'Nora', category: 'high_quality',
  labels: { use_case: 'conversational', gender: 'female', accent: 'american', age: 'middle_aged', language: 'en' },
  sharing: { rate: 1 },
});
const realPoolStore = { createVoicePoolStore: options => createVoicePoolStore(options) };

/** The catalog fake records what every pick saw and every account-voice listing. */
function recordingCatalog(voices) {
  const picks = [];
  const listings = [];
  return {
    picks,
    listings,
    listConversationalVoices: async () => { listings.push(voices); return voices; },
    pickPersonaVoice: options => {
      picks.push(options);
      return { voiceId: options.voices[0].voiceId, name: 'Ada Lovelace' };
    },
  };
}

/** A voice factory whose streams are observable: they carry audio, an error, or silence. */
function voiceHarness({ audio = false, fail = false, onSend } = {}) {
  const factories = [];
  const make = options => {
    const opened = [];
    const factory = {
      options, opened,
      open: openOptions => {
        const stream = {
          utteranceId: openOptions?.utteranceId, sent: [], finished: 0, cancelled: 0,
          onAudio(listener) { stream.audioListener = listener; },
          onWords() {},
          onError(listener) { stream.errorListener = listener; },
          sendText(text) { stream.sent.push(text); onSend?.(stream); },
          async finish() {
            stream.finished += 1;
            if (fail) { stream.errorListener?.(new Error('warm-up stream failed')); throw new Error('warm-up stream failed'); }
            if (audio) stream.audioListener?.(new Uint8Array(1024));
          },
          cancel() { stream.cancelled += 1; },
        };
        opened.push(stream);
        return stream;
      },
    };
    factories.push(factory);
    return factory;
  };
  return { factories, make };
}

test('the draw gets the newest pool stamp and the service random, never the account voices', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-draw-'));
  await writeFile(poolFilePath(tmp), JSON.stringify({ version: 1, lastUsed: { 'lib-1': 500, 'lib-2': 900 } }));
  const draws = [];
  const random = () => 0.25;
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random,
    voiceLibrary: { ...realPoolStore, drawVoice: async options => { draws.push(options); return { voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 2 }; } },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  assert.equal(draws.length, 5, 'the lead and four more voices for the planner');
  assert.equal('accountVoices' in draws[0], false, 'the draw is never handed the account voices');
  assert.deepEqual(draws[0].excludeVoiceIds, ['lib-2'], 'the newest pool stamp is the avoided voice');
  assert.equal(draws[0].random, random);
  assert.equal(draws[0].key, 'key-should-never-be-logged');
  assert.equal(draws[0].fetch, deps.fetch);
  assert.deepEqual(catalog.listings, [], 'the account voice list is never read');
  assert.equal(catalog.picks.every(pick => pick.voices.length === 1 && pick.voices[0].voiceId === 'lib-1'), true, 'only drawn library voices are picked from');
  await service.answer();
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.voiceId, 'lib-1', 'the persona is built from the drawn voice');
  assert.equal(record.persona.voiceSource, 'library');
});

test('a library draw opens one discarded warm-up line before the call rings', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-warmup-'));
  const ref = {};
  const phasesAtSend = [];
  const trackUtterances = [];
  const harness = voiceHarness({ audio: true, onSend: () => phasesAtSend.push(ref.service.getState().phase) });
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random: () => 0,
    voiceFactory: harness.make,
    trackFactory: () => ({ started() {}, ended() {}, addUtterance(utterance) { trackUtterances.push(utterance); }, finalize: async () => {} }),
    voiceLibrary: { ...realPoolStore, drawVoice: async () => ({ voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 4 }) },
  } });
  ref.service = createPracticeCallService(deps);
  const state = await ref.service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  // The plan chose the stability before anything was warmed, so one factory serves both the warm-up and the call.
  assert.equal(harness.factories.length, 1, 'only the chosen voice is made');
  assert.equal(harness.factories[0].options.voiceId, 'lib-1');
  const opened = harness.factories[0].opened;
  assert.deepEqual(opened.map(stream => stream.utteranceId), ['warm-up'], 'exactly one warm-up stream');
  assert.deepEqual(opened[0].sent, ['Hi.']);
  assert.deepEqual(phasesAtSend, ['precheck'], 'the warm-up happens before the call rings');
  assert.equal(opened[0].finished, 1);
  assert.deepEqual(trackUtterances, [], 'the warm-up audio never reaches the track');
  await ref.service.answer();
  await ref.service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.voiceSource, 'library');
  assert.equal(record.persona.voiceId, 'lib-1');
});

test('the real pool file keeps only version and lastUsed across two starts', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-pool-file-'));
  const filePath = poolFilePath(tmp);
  const draws = [];
  const voiceLibrary = {
    ...realPoolStore,
    drawVoice: async options => {
      draws.push(options);
      return { voice: draws.length === 1 ? DRAWN_LIBRARY_VOICE : SECOND_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 };
    },
  };
  const readPool = async () => JSON.parse(await readFile(filePath, 'utf8'));
  const depsFor = extra => makeDeps({ tmp, modelReady: true, deps: { voiceLibrary, catalog: recordingCatalog(ACCOUNT_VOICES), random: () => 0, ...extra } });

  // The real store over a real file: the point is what the precheck save leaves on disk.
  await createPracticeCallService(depsFor({}).deps).start(ARGS);
  const afterFirst = await readPool();
  assert.deepEqual(Object.keys(afterFirst).sort(), ['lastUsed', 'version'], 'nothing else survives the save');
  assert.equal(afterFirst.version, 1);
  assert.equal(afterFirst.lastUsed['lib-1'], 1000);

  // A second start on a later clock avoids the first start's voice and adds its own stamp.
  await createPracticeCallService(depsFor({
    clock: { now: () => 2000, setTimeout: () => 1, clearTimeout: () => {} },
    newId: () => 'call-2',
  }).deps).start(ARGS);
  const afterSecond = await readPool();
  assert.deepEqual(draws[1].excludeVoiceIds, ['lib-1'], 'the second draw avoids the first start voice');
  assert.deepEqual(Object.keys(afterSecond).sort(), ['lastUsed', 'version']);
  assert.equal(afterSecond.lastUsed['lib-1'], 1000);
  assert.equal(afterSecond.lastUsed['lib-2'], 2000);
});

test('a warm-up that errors or stays silent ends the call before anything is created', async () => {
  for (const [label, streamOptions] of [['errors', { fail: true }], ['no audio', { audio: false }]]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-warmup-fail-'));
    const harness = voiceHarness(streamOptions);
    const catalog = recordingCatalog(ACCOUNT_VOICES);
    const created = { helpers: 0, tracks: 0, sessions: 0 };
    const { deps } = makeDeps({ tmp, modelReady: true, deps: {
      catalog, random: () => 0,
      voiceFactory: harness.make,
      helperFactory: () => { created.helpers += 1; throw new Error('no helper after a failed warm-up'); },
      trackFactory: () => { created.tracks += 1; throw new Error('no track after a failed warm-up'); },
      sessionsFactory: () => { created.sessions += 1; throw new Error('no sessions after a failed warm-up'); },
      voiceLibrary: { ...realPoolStore, drawVoice: async () => ({ voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 }) },
    } });
    const service = createPracticeCallService(deps);
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'voice-warmup-failed', label);
    assert.equal(state.error.message, 'The interviewer voice did not respond. Try starting the call again.', label);
    assert.equal(harness.factories.length, 1, `${label}: only the drawn voice is opened`);
    assert.equal(harness.factories[0].options.voiceId, 'lib-1', label);
    assert.deepEqual(harness.factories[0].opened.map(stream => stream.utteranceId), ['warm-up'], label);
    assert.deepEqual(created, { helpers: 0, tracks: 0, sessions: 0 }, `${label}: nothing is created`);
    assert.deepEqual(catalog.listings, [], `${label}: the account voice list is never read`);
    const stamped = await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false);
    assert.equal(stamped, false, `${label}: no lastUsed stamp is saved`);
  }
});

test('a draw failure ends the call before anything is created', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-draw-error-'));
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const created = { helpers: 0, tracks: 0, sessions: 0 };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random: () => 0,
    helperFactory: () => { created.helpers += 1; throw new Error('no helper after a failed draw'); },
    trackFactory: () => { created.tracks += 1; throw new Error('no track after a failed draw'); },
    sessionsFactory: () => { created.sessions += 1; throw new Error('no sessions after a failed draw'); },
    voiceLibrary: { ...realPoolStore, drawVoice: async () => { throw new Error('voice library unreachable'); } },
  } });
  const service = createPracticeCallService(deps);
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'voice-library-unavailable');
  assert.equal(state.error.message, 'Could not load an interviewer voice from the ElevenLabs voice library. Check your internet connection and try again.');
  assert.deepEqual(created, { helpers: 0, tracks: 0, sessions: 0 }, 'nothing is created');
  assert.deepEqual(catalog.listings, [], 'the account voice list is never read');
  assert.deepEqual(catalog.picks, [], 'no voice is picked');
  const stamped = await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false);
  assert.equal(stamped, false, 'no lastUsed stamp is saved');
});

test('a missing, throwing or unusable draw is voice-library-unavailable', async () => {
  for (const [label, voiceLibrary] of [
    ['missing', { ...realPoolStore }],
    ['throwing', { ...realPoolStore, drawVoice: async () => { throw new Error('voice library unreachable'); } }],
    ['unusable', { ...realPoolStore, drawVoice: async () => ({ voice: { voiceName: 'No id' }, source: 'library', libraryTotal: 3427, attempts: 1 }) }],
  ]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-draw-fail-'));
    const catalog = recordingCatalog(ACCOUNT_VOICES);
    const { deps } = makeDeps({ tmp, modelReady: true, deps: { catalog, random: () => 0, voiceLibrary } });
    const service = createPracticeCallService(deps);
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'voice-library-unavailable', label);
    assert.equal(state.error.message,
      'Could not load an interviewer voice from the ElevenLabs voice library. Check your internet connection and try again.', label);
    assert.deepEqual(catalog.listings, [], `${label}: the account voice list is never read`);
    const stamped = await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false);
    assert.equal(stamped, false, `${label}: no lastUsed stamp is saved`);
  }
});

test('closing the window during a call asks how to leave before it closes', async () => {
  const { createPracticeCallController } = await import('../../electron/practiceCall/callWindow.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-close-ask-'));
  const sent = [];
  let made = null;
  class FakeWindow {
    constructor() { this.destroyed = false; this.handlers = {}; this.webContents = { send: channel => sent.push(channel), mainFrame: {} }; made = this; }
    once(name, fn) { this.handlers[name] = fn; }
    on(name, fn) { this.handlers[name] = fn; }
    isDestroyed() { return this.destroyed; }
    show() {} focus() {} loadFile() {}
    // Electron semantics: 'close' may veto, 'closed' follows only when it did not.
    close() {
      if (this.destroyed) return;
      let vetoed = false;
      this.handlers.close?.({ preventDefault() { vetoed = true; } });
      if (vetoed) return;
      this.destroyed = true; this.handlers.closed?.();
    }
  }
  const ipc = new Map();
  const ipcMain = { handle: (channel, fn) => ipc.set(channel, fn), removeHandler: channel => ipc.delete(channel) };
  let phase = 'in-call';
  const abandons = [];
  const hangUps = [];
  const service = {
    onState() {}, onEvent() {}, onReplayUpdated() {},
    getState: () => ({ phase, callId: 'call-1' }),
    start: async () => ({ phase: 'ringing', callId: 'call-1' }),
    hangUp: async options => { hangUps.push(options); phase = 'replay'; return { phase }; },
    abandon: async () => { abandons.push(1); return { phase: 'replay' }; },
  };
  createPracticeCallController({
    BrowserWindow: FakeWindow, ipcMain, isAuthorizedOwner: () => true, userDataPath: tmp,
    store: { readRecord: async callId => ({ callId, nodeId: 'n1' }) }, service,
  });
  await ipc.get('practice-call:start')({}, { nodeId: 'n1' });
  made.close();
  assert.equal(made.destroyed, false, 'the first close ends the call and keeps the window for the feedback question');
  assert.deepEqual(hangUps, [{ feedback: 'ask' }], 'closing the window mid-call is the red button');
  assert.equal(sent.includes('practice-call-window:leave-requested'), false, 'no dialog is asked for');
  assert.equal(abandons.length, 0);
  made.close();
  assert.equal(made.destroyed, true, 'closing it again goes through');
  assert.equal(abandons.length, 1, 'and counts as no feedback');
});

test('a full start never sends POST or DELETE to the voices API', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-no-write-'));
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET' });
    if (new URL(String(url)).pathname === '/v1/shared-voices') return { ok: true, status: 200, json: async () => ({ voices: [SHARED_LIBRARY_ROW], total_count: 3427 }) };
    return { ok: true, status: 200, json: async () => ({ tier: 'paid' }) };
  };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    fetch: fetchImpl, catalog: recordingCatalog(ACCOUNT_VOICES), random: () => 0,
    // The real draw against a recording fetch: every request it makes is a read.
    voiceLibrary: { ...realPoolStore, drawVoice: options => drawVoice(options) },
  } });
  const service = createPracticeCallService(deps);
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  assert.equal(requests.some(request => new URL(request.url).pathname === '/v1/shared-voices'), true, 'the draw read the shared library');
  assert.deepEqual(requests.filter(request => request.method !== 'GET'), []);
  assert.deepEqual(requests.filter(request => new URL(request.url).pathname.startsWith('/v1/voices')), []);
});

test('an unreadable pool and a failing save never block the call', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-pool-fail-'));
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(String(reason && reason.message));
  const draws = [];
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random: () => 0,
    voiceLibrary: {
      createVoicePoolStore: () => ({ load: async () => { throw new Error('unreadable pool file'); }, save: async () => { throw new Error('disk full'); } }),
      drawVoice: async options => {
        draws.push(options);
        return { voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 };
      },
    },
  } });
  const service = createPracticeCallService(deps);
  process.on('unhandledRejection', onUnhandled);
  let state;
  try {
    state = await service.start(ARGS);
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(draws[0].excludeVoiceIds, [], 'an unreadable pool excludes nothing');
  assert.equal(catalog.picks[0].voices[0].voiceId, 'lib-1');
  assert.deepEqual(catalog.listings, []);
  assert.deepEqual(unhandled, []);
});



// --- review fixes: warm sessions, history, ear data, clock, speaking, notices, replay entry ---

const flush = () => new Promise(resolve => setTimeout(resolve, 5));
async function liveCall(overrides = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-fix-'));
  const harness = makeDeps({ tmp, modelReady: true, ...overrides });
  const service = createPracticeCallService(harness.deps);
  return { tmp, service, ...harness };
}

test('a finished call closes its warm Claude sessions', async () => {
  const closed = [];
  const make = name => ({ start: async () => {}, close: async () => { closed.push(name); } });
  const names = ['opener', 'main', 'classifier'];
  let next = 0;
  const { service } = await liveCall({ deps: { sessionsFactory: () => make(names[next++]) } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  await flush();
  assert.deepEqual(closed.sort(), ['classifier', 'main', 'opener']);
});

test('the interviewer is given the candidate name from the career snapshot, and a missing name never stops the call', async () => {
  const run = async loadCandidateName => {
    const seen = [];
    const asked = [];
    const warned = [];
    let restart;
    const { service } = await liveCall({ deps: {
      sessionsFactory: () => ({ start: async () => {}, close() {} }),
      engineFactory: options => {
        restart = options.restartSession;
        return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
      },
      loadCandidateName: async args => { asked.push(args); return loadCandidateName(args); },
      logger: { warn: message => warned.push(message) },
      prompts: {
        buildOpenerInstructions: () => 'OPENER\nReply only READY now.',
        buildInterviewerInstructions: options => { seen.push(options.candidateName); return 'MAIN\nReply only READY now.'; },
      },
    } });
    const state = await service.start(ARGS);
    await service.answer();
    const before = seen.length;
    await restart('main', { transcriptText: 'Candidate: hi' });
    assert.equal(seen.length > before, true, 'the restarted interviewer prompt was built');
    return { seen, asked, warned, state };
  };
  const named = await run(async () => '  Synthetic Person  ');
  assert.equal(named.state.phase, 'ringing');
  assert.deepEqual(named.asked.map(args => args.snapshotId), [ARGS.snapshotId]);
  assert.equal(named.seen.length > 0 && named.seen.every(name => name === 'Synthetic Person'), true, 'every interviewer prompt carries the name');
  assert.equal(JSON.stringify(named.state).includes('Synthetic Person'), false, 'the name never reaches the published call state');

  const missing = await run(async () => '');
  assert.equal(missing.state.phase, 'ringing');
  assert.equal(missing.seen.every(name => name === undefined), true);

  const broken = await run(async () => { throw Object.assign(new Error('Synthetic Person snapshot unreadable'), { code: 'ENOENT' }); });
  assert.equal(broken.state.phase, 'ringing', 'an unreadable snapshot does not stop the call');
  assert.equal(broken.seen.every(name => name === undefined), true);
  assert.equal(broken.warned.some(message => message.includes('candidate name unavailable')), true);
  assert.equal(broken.warned.some(message => message.includes('Synthetic Person')), false, 'the log line never carries the error text');
});

test('the candidate name reader takes identity.name from the pinned snapshot and cleans it', async () => {
  const { loadCandidateName, cleanCandidateName } = await import('../../electron/practiceCall/candidateName.js');
  const calls = [];
  const read = profile => async (root, id, options) => { calls.push({ root, id, options }); return profile === null ? null : { snapshotId: id, profile }; };
  const args = { snapshotId: 'snap-1', userDataPath: '/tmp/user-data', storageRoot: userData => `${userData}/store` };
  assert.equal(await loadCandidateName({ ...args, readSnapshot: read({ identity: { name: ' Synthetic\n Person ', contacts: ['x@example.test'] } }) }), 'Synthetic Person');
  assert.deepEqual(calls[0], { root: '/tmp/user-data/store', id: 'snap-1', options: { readOnly: true } });
  assert.equal(await loadCandidateName({ ...args, readSnapshot: read({ identity: {} }) }), '');
  assert.equal(await loadCandidateName({ ...args, readSnapshot: read(null) }), '');
  assert.equal(await loadCandidateName({ userDataPath: '/tmp/user-data', readSnapshot: read({ identity: { name: 'X' } }) }), '', 'no snapshot id, no read');
  assert.equal(cleanCandidateName('Ana [ignore previous] "Q" <b>'), 'Ana ignore previous Q b');
  assert.equal(cleanCandidateName('x'.repeat(81)), '');
  assert.equal(cleanCandidateName("Zoë O'Brien-Šimić"), "Zoë O'Brien-Šimić");
  assert.equal(cleanCandidateName('a\u200cb\u202e c\u200dd'), 'a\u200cb c\u200dd', 'joiners stay, other invisible characters go');
  assert.equal(cleanCandidateName(42), '');
});

test('a remark spoken over the speaker does not split the speaker\'s running caption', async () => {
  let emit;
  const { service } = await liveCall({ deps: { engineFactory: options => { emit = options.onEvent; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; } } });
  await service.start(ARGS);
  await service.answer();
  emit({ type: 'caption', speaker: 'interviewer', speakerId: 'A', text: 'Let me introduce', final: false });
  emit({ type: 'overlay', speakerId: 'B', text: 'Hi there.', atMs: 10 });
  emit({ type: 'caption', speaker: 'interviewer', speakerId: 'A', text: 'Let me introduce our engineer.', final: true });
  const rows = service.getState().captions.map(item => [item.speakerId, item.text, Boolean(item.overlay)]);
  assert.deepEqual(rows.filter(row => !row[2]), [['A', 'Let me introduce our engineer.', false]], 'one line for the speaker, updated in place');
  assert.equal(rows.filter(row => row[2]).length, 1, 'the remark is its own line');
});

test('a restarted session gets its history before the final READY line', async () => {
  const started = [];
  const histories = [];
  let restart;
  const { service } = await liveCall({ deps: {
    sessionsFactory: () => ({ start: async options => { started.push(options.instructions); }, close() {} }),
    prompts: {
      buildOpenerInstructions: options => { histories.push(['opener', options.history]); return `OPENER\nReply only READY now.`; },
      buildInterviewerInstructions: options => { histories.push(['main', options.history]); return `MAIN\nReply only READY now.`; },
    },
    engineFactory: options => {
      restart = options.restartSession;
      return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  started.length = 0;
  histories.length = 0;
  await restart('main', { transcriptText: 'Candidate: hi' });
  await restart('opener', { transcriptText: 'Candidate: hi' });
  assert.deepEqual(histories, [['main', 'Candidate: hi'], ['opener', 'Candidate: hi']]);
  await restart('classifier', { transcriptText: 'Candidate: hi' });
  const classifier = started.at(-1);
  assert.equal(classifier.trimEnd().endsWith('Reply only READY now.'), true);
  assert.equal(classifier.indexOf('Candidate: hi') < classifier.lastIndexOf('Reply only READY'), true);
  await restart('main');
  assert.equal(started.at(-1), 'MAIN\nReply only READY now.');
});

test('the record holds tone samples, candidate prosody and the voice baseline, and noteSpeech gets a word count', async () => {
  const noted = [];
  let helperEvent;
  const prosody = [{ startMs: 1, endMs: 2, speechMs: 1, wordsPerMinute: 120 }];
  const baseline = { wordsPerMinute: 130 };
  const { service, deps } = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
    earFactory: options => ({
      noteSpeech: async span => { noted.push(span); options.onToneSample({ atMs: 5, endMs: 9, arousal: 0.1, dominance: 0.2, valence: 0.3 }); },
      settle: async () => {}, prosodyTurns: () => prosody, baselineSnapshot: () => baseline, close() {},
    }),
  } });
  await service.start(ARGS);
  await service.answer();
  helperEvent({ type: 'transcript', final: true, startMs: 100, endMs: 900, text: ' one two  three ' });
  await flush();
  await service.hangUp();
  assert.deepEqual(noted, [{ startMs: 100, endMs: 900, wordCount: 3 }]);
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.toneSamples.map(item => item.atMs), [5]);
  assert.deepEqual(record.candidateProsody, prosody);
  assert.deepEqual(record.voiceBaseline, baseline);
});

test('the call clock starts at answer and the record keeps the recording lead', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const finalized = [];
  const { service, deps } = await liveCall({ deps: {
    clock,
    trackFactory: () => ({ started() {}, ended() {}, addUtterance() {}, finalize: async (file, options) => { finalized.push(options.durationMs); } }),
    // The tracks cannot be cut here (there are no files), so the mix keeps its 4 s lead.
    mixdown: async () => ({ durationMs: 9000 }),
  } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.startedAt, 14000);
  assert.equal(record.durationMs, 9000, 'the replay length is the length of the recording the times sit on');
  assert.equal(record.recordingLeadMs, 4000);
  assert.deepEqual(finalized, [9000], 'the interviewer track covers the helper timeline');
  assert.equal(record.timings.precheckMs, 0);
});

test('the interviewer playing lights the speaking marker and candidate voice activity cannot overwrite it', async () => {
  let helperEvent;
  const { service, engine } = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'phase', phase: 'playing' });
  assert.equal(service.getState().speaking, 'interviewer');
  helperEvent({ type: 'vad', speaking: true });
  helperEvent({ type: 'vad', speaking: false });
  assert.equal(service.getState().speaking, 'interviewer');
  engine()({ type: 'phase', phase: 'listening' });
  assert.equal(service.getState().speaking, null);
  helperEvent({ type: 'vad', speaking: true });
  assert.equal(service.getState().speaking, 'candidate');
  engine()({ type: 'phase', phase: 'committed' });
  assert.equal(service.getState().speaking, 'candidate');
});

test('a helper running without the microphone is shown on the call; one with the microphone is not', async () => {
  let helperEvent;
  const { service } = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.equal(service.getState().microphoneUnavailable, false);
  helperEvent({ type: 'status', state: 'ready', inject: true, microphone: false });
  assert.equal(service.getState().microphoneUnavailable, true, 'macOS refused the microphone');
  helperEvent({ type: 'status', state: 'ready', inject: true });
  assert.equal(service.getState().microphoneUnavailable, false);
});

test('a microphone that stops working mid-call keeps the call going, and Reconnect asks the helper to try it again', async () => {
  let helperEvent;
  let reconnects = 0;
  const { service } = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, reconnectMicrophone: () => { reconnects += 1; return true; }, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.equal(service.reconnectMicrophone().microphoneReconnecting, false, 'nothing to reconnect while the microphone works');
  assert.equal(reconnects, 0);
  helperEvent({ type: 'status', state: 'microphone', available: false });
  let state = service.getState();
  assert.equal(state.phase, 'in-call', 'the call goes on');
  assert.equal(state.error, null);
  assert.equal(state.microphoneUnavailable, true);
  assert.equal(state.microphoneFailed, true);
  assert.equal(service.reconnectMicrophone().microphoneReconnecting, true);
  assert.equal(service.reconnectMicrophone().microphoneReconnecting, true, 'a second press while trying is ignored');
  assert.equal(reconnects, 1);
  helperEvent({ type: 'status', state: 'microphone', available: false });
  state = service.getState();
  assert.equal(state.microphoneReconnecting, false, 'a failed reconnect frees the button');
  assert.equal(state.microphoneUnavailable, true);
  service.reconnectMicrophone();
  helperEvent({ type: 'status', state: 'microphone', available: true });
  state = service.getState();
  assert.equal(state.phase, 'in-call');
  assert.equal(state.microphoneUnavailable, false);
  assert.equal(state.microphoneFailed, false);
  assert.equal(state.microphoneReconnecting, false);
  assert.equal(reconnects, 2);
  // Access still refused when Reconnect is pressed: the notice keeps pointing at the settings.
  helperEvent({ type: 'status', state: 'microphone', available: false, reason: 'denied' });
  assert.equal(service.getState().microphoneFailed, false);
  assert.equal(service.getState().microphoneUnavailable, true);
  // Only a new call can use the microphone: the window says to rejoin and Reconnect does nothing more.
  service.reconnectMicrophone();
  helperEvent({ type: 'status', state: 'microphone', available: false, reason: 'rejoin' });
  assert.equal(service.getState().microphoneNeedsRejoin, true);
  assert.equal(service.getState().microphoneFailed, false);
  const pressed = reconnects;
  assert.equal(service.reconnectMicrophone().microphoneReconnecting, false);
  assert.equal(reconnects, pressed);
});

test('the candidate tile lights for their microphone and for a line in their AI voice, even over the interviewer', async () => {
  let helperEvent;
  const { service, engine } = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.equal(service.getState().candidateSpeaking, false);
  helperEvent({ type: 'vad', speaking: true });
  assert.equal(service.getState().candidateSpeaking, true, 'speaking into the microphone');
  helperEvent({ type: 'vad', speaking: false });
  assert.equal(service.getState().candidateSpeaking, false);
  helperEvent({ type: 'inject', utteranceId: 'u1', state: 'started', positionMs: 0, atMs: 1 });
  assert.equal(service.getState().candidateSpeaking, true, 'the AI voice speaking for the candidate');
  engine()({ type: 'phase', phase: 'playing' });
  assert.equal(service.getState().speaking, 'interviewer');
  assert.equal(service.getState().candidateSpeaking, true, 'talking over the interviewer still lights the candidate');
  helperEvent({ type: 'inject', utteranceId: 'u1', state: 'position', positionMs: 50, atMs: 51 });
  assert.equal(service.getState().candidateSpeaking, true);
  helperEvent({ type: 'inject', utteranceId: 'u1', state: 'finished', positionMs: 900, atMs: 901 });
  assert.equal(service.getState().candidateSpeaking, false);
  helperEvent({ type: 'inject', utteranceId: 'u2', state: 'started', positionMs: 0, atMs: 950 });
  helperEvent({ type: 'inject', utteranceId: 'u2', state: 'cancelled', positionMs: 10, atMs: 960 });
  assert.equal(service.getState().candidateSpeaking, false, 'a cut-off line ends the highlight');
});

test('engine voice errors show a notice that clears when the next reply plays', async () => {
  const { service, engine } = await liveCall();
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'error', code: 'voice-failed' });
  assert.equal(service.getState().notice.code, 'voice-failed');
  assert.equal(service.getState().notice.message.length > 0, true);
  engine()({ type: 'phase', phase: 'playing' });
  assert.equal(service.getState().notice, null);
});

test('the playback mirror opens no segment at call time zero', async () => {
  const started = [];
  let audio;
  const { service } = await liveCall({ deps: {
    trackFactory: () => ({ started: (id, atMs) => started.push([id, atMs]), ended() {}, addUtterance() {}, finalize: async () => {} }),
    engineFactory: options => { audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  await service.start(ARGS);
  await service.answer();
  audio.play('u1', 24000);
  assert.deepEqual(started, []);
});

test('a call with no real candidate turn skips transcription and review', async () => {
  let transcribed = 0;
  let analysed = 0;
  const { service, deps } = await liveCall({ deps: {
    transcribe: async () => { transcribed += 1; return {}; },
    analyze: async () => { analysed += 1; return { status: 'ready', feedback: { summary: 'x' } }; },
    engineFactory: () => ({
      start() {}, hangUp() {},
      state: () => ({ transcript: [
        { speaker: 'interviewer', text: 'Hi', startMs: 0, endMs: 1 },
        { speaker: 'candidate', text: 'mm-hm', acknowledgement: true, startMs: 1, endMs: 2 },
      ], elapsedMs: 100 }),
    }),
  } });
  await service.start(ARGS);
  await service.answer();
  const state = await service.hangUp();
  assert.equal(state.phase, 'replay');
  assert.equal(transcribed, 0);
  assert.equal(analysed, 0);
  const analysis = await deps.store.readAnalysis('call-1');
  assert.equal(analysis.status, 'ready');
  assert.equal(analysis.tooShort, true);
  assert.equal(analysis.feedback, undefined);
  assert.equal((await service.getReplay('call-1')).analysis.tooShort, true);
});

test('a rejected practice registry result raises feedback-error', async () => {
  const errors = [];
  const registry = { arm: async () => 'session-1', cancel() {}, finish: async () => ({ status: 'rejected', note: 'bad' }) };
  const { service } = await liveCall({ deps: { registry } });
  service.onEvent(event => { if (event.kind === 'feedback-error') errors.push(event); });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.equal(errors.length, 1);
});

test('a helper error before the call is answered ends in an error state, a decline ends quietly', async () => {
  const errored = await liveCall({ helperError: true });
  const states = [];
  errored.service.onState(state => states.push(state));
  await errored.service.start(ARGS);
  await new Promise(resolve => setTimeout(resolve, 30));
  const state = errored.service.getState();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.message.length > 0, true);
  assert.equal(await errored.deps.store.readRecord('call-1'), null);
  const quiet = await liveCall();
  await quiet.service.start(ARGS);
  assert.equal((await quiet.service.hangUp()).phase, 'replay');
});

test('a running caption hypothesis replaces the one before it', async () => {
  const { service, engine } = await liveCall();
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Tell', final: false });
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Tell me', final: false });
  assert.deepEqual(service.getState().captions, [{ speaker: 'interviewer', text: 'Tell me', final: false }]);
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Tell me more.', final: true });
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Next', final: false });
  assert.deepEqual(service.getState().captions.map(item => item.text), ['Tell me more.', 'Next']);
});

test('model download progress is cumulative over both models and names the current one', async () => {
  const seen = [];
  const { tmp, service } = await startOf({ modelReady: false, deps: {
    modelStore: () => ({
      status: () => ({ smartTurn: 'missing', tone: 'missing', sizes: { smartTurn: 30, tone: 70 } }),
      ensure: async (name, { onProgress }) => {
        const size = name === 'smartTurn' ? 30 : 70;
        onProgress?.({ receivedBytes: size / 2, totalBytes: size });
        onProgress?.({ receivedBytes: size, totalBytes: size });
      },
      pathOf: name => path.join(tmp, 'practice-models', `${name}.onnx`),
    }),
  } });
  service.onState(state => { if (state.phase === 'downloading' && state.modelDownload) seen.push(state.modelDownload); });
  await service.start(ARGS);
  await service.agreeModelDownload();
  const bars = seen.map(item => [item.name, item.receivedBytes, item.totalBytes]);
  assert.deepEqual(bars.at(-1), ['tone', 100, 100]);
  assert.equal(bars.some(item => item[0] === 'tone' && item[1] === 30 && item[2] === 100), true, 'the bar does not drop to zero');
  assert.equal(bars.some(item => item[0] === 'smartTurn' && item[1] === 15), true);
  for (let i = 1; i < bars.length; i += 1) assert.equal(bars[i][1] >= bars[i - 1][1], true);
});

test('model download bar keeps one total across both models when the store reports no sizes', async () => {
  const seen = [];
  const { tmp, service } = await startOf({ modelReady: false, deps: {
    modelStore: () => ({
      status: () => ({ smartTurn: 'missing', tone: 'missing' }),
      ensure: async (name, { onProgress }) => { onProgress?.({ receivedBytes: 5, totalBytes: 10 }); },
      pathOf: name => path.join(tmp, 'practice-models', `${name}.onnx`),
    }),
  } });
  service.onState(state => { if (state.phase === 'downloading' && state.modelDownload) seen.push(state.modelDownload); });
  await service.start(ARGS);
  await service.agreeModelDownload();
  const totals = new Set(seen.map(item => item.totalBytes).filter(total => total > 0));
  assert.equal(totals.size, 1, 'the total does not change when the second model begins');
  assert.equal([...totals][0] > 600 * 1000 * 1000, true, 'the total is both model sizes');
});

test('a voice line cut off by the interviewer is cut short in the chat too, and a message it never reached is marked unsaid', async () => {
  const flags = [];
  const { service, engine } = await liveCall({ deps: {
    engineFactory: options => {
      engine.listener = options.onEvent;
      return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }), typed: (text, options) => { flags.push({ ...options }); } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  service.sendChat('It worries me a little. But if the flow drop were purely a bad sensor, I would expect the temperature to stay put.');
  service.sendChat('And one more thing.');
  service.sendChat('Kept whole.');
  engine.listener({ type: 'candidate-voice', state: 'cut', heardChars: 60, messages: [
    { chatId: flags[0].chatId, heard: "It worries me a little. But if the flow drop were purely a bad sensor, I'd expect the temperature," },
    { chatId: flags[1].chatId, heard: '' },
  ] });
  const chat = service.getState().chat;
  assert.equal(chat[0].text, "It worries me a little. But if the flow drop were purely a bad sensor, I'd expect the temperature —");
  assert.equal(chat[0].cutOff, true);
  assert.equal(chat[1].text, 'And one more thing.');
  assert.equal(chat[1].unsaid, true);
  assert.equal(chat[2].text, 'Kept whole.');
  assert.equal(chat[2].cutOff, undefined);
});

test('chat is accepted without an answer while the interviewer is leaving, and ignored once they have left', async () => {
  const flags = [];
  const typed = [];
  const clock = manualClock();
  const { service, engine } = await liveCall({ deps: {
    random: () => 0,
    clock,
    engineFactory: options => {
      engine.listener = options.onEvent;
      return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }), typed: (text, options) => { typed.push(text); flags.push({ ...options }); } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  service.sendChat('before');
  // A sent suggestion is marked, so it never counts as practice; anything else is the candidate's own.
  service.sendChat('suggested', { generated: true, extra: 'ignored' });
  assert.deepEqual(flags.map(flag => flag.generated), [false, true]);
  assert.deepEqual(flags.map(flag => flag.chatId), service.getState().chat.map(item => item.id), 'each message carries its chat entry id');
  assert.equal(new Set(flags.map(flag => flag.chatId)).size, 2);
  typed.splice(1);
  engine.listener({ type: 'ended', reason: 'interviewer' });
  // They are still on the line for 1 s: a real call lets you type, and nobody answers.
  let state = service.sendChat('during');
  assert.deepEqual(state.chat.map(item => item.text), ['before', 'suggested', 'during']);
  assert.deepEqual(typed, ['before'], 'the interviewer sessions never get it');
  const [leave] = clock.pending().filter(timer => timer.ms === 1000 && timer.fn?.name !== 'tick');
  clock.setNow(clock.now() + 1000);
  clock.fire(leave);
  state = service.sendChat('after');
  assert.deepEqual(state.chat.map(item => item.text), ['before', 'suggested', 'during']);
  assert.deepEqual(typed, ['before']);
});

test('showReplay enters the replay phase for a call and is refused while a call is live', async () => {
  const idle = await liveCall();
  const state = idle.service.showReplay('call-9');
  assert.equal(state.phase, 'replay');
  assert.equal(state.callId, 'call-9');
  assert.equal(idle.service.getState().callId, 'call-9');
  const live = await liveCall();
  await live.service.start(ARGS);
  await live.service.answer();
  const refused = live.service.showReplay('call-9');
  assert.equal(refused.phase, 'in-call');
  assert.equal(live.service.getState().callId, 'call-1');
});

// The packaged app is one bundle: the bundler follows `import('literal')` and leaves
// `import(variable)` as a runtime read of a source file the app does not ship. That made
// every practice call fail to start in the built app while all tests passed from source.
test('every dynamic import in the call code names its module literally', async () => {
  const fsSync = await import('node:fs');
  const pathModule = await import('node:path');
  const roots = ['electron/practiceCall', 'electron/interviewPracticeCallEngine.js', 'electron/interviewPracticeTransport.js', 'electron/interviewPracticeAudio.js'];
  const files = [];
  const walk = target => {
    if (fsSync.statSync(target).isDirectory()) { for (const name of fsSync.readdirSync(target)) walk(pathModule.join(target, name)); return; }
    if (target.endsWith('.js')) files.push(target);
  };
  for (const root of roots) walk(root);
  assert.ok(files.length > 20, 'the call code was found');
  const offenders = [];
  for (const file of files) {
    const source = fsSync.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bimport\(\s*([^)\s][^)]*)\)/gu)) {
      const specifier = match[1].trim();
      if (!/^(['"])[^'"`$]+\1$/u.test(specifier)) offenders.push(`${file}: import(${specifier})`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Seen in the first run of the built app: the audio helper failed a second after starting,
// the teardown closed the sessions that were still starting, their start was rejected with
// CANCELLED, and the window showed "CANCELLED" instead of the microphone message.
test('a helper error during session start keeps its own message, not the cancelled start', async () => {
  let fireHelperError = () => {};
  const rejectors = [];
  const errored = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      fireHelperError = () => onEvent({ type: 'error', code: 'capture-failed' });
      return { start: async () => ({ ok: true }), stop: async () => {}, play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {} };
    },
    sessionsFactory: () => ({
      // The helper fails while the sessions are still starting.
      start: () => new Promise((resolve, reject) => { rejectors.push(reject); if (rejectors.length === 1) setTimeout(fireHelperError, 0); }),
      close: async () => { for (const reject of rejectors) reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' })); },
    }),
  } });
  // The hub shows whatever start returns, so that value must not carry the cancelled start either.
  const returned = await errored.service.start(ARGS);
  assert.notEqual(returned.error?.code, 'precheck-failed');
  assert.doesNotMatch(String(returned.error?.message ?? ''), /CANCELLED/u);
  await new Promise(resolve => setTimeout(resolve, 30));
  const state = errored.service.getState();
  assert.equal(state.phase, 'error');
  assert.notEqual(state.error.code, 'precheck-failed');
  assert.doesNotMatch(state.error.message, /CANCELLED/u);
});

// Seen in the first call made in the built app: the replay's first line sat at 0:28 and the
// audio ran 25 s longer than the call length shown, because the recording starts during setup.
test('the saved call is on the call clock: the lead is cut from both tracks and every time moves back by it', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const trims = [];
  const { service, deps } = await liveCall({ deps: {
    clock,
    trimStart: async request => { trims.push({ files: request.paths.map(file => path.basename(file)), startMs: request.startMs }); },
    earFactory: () => ({
      noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [],
      prosodyTurns: () => [{ startMs: 6000, endMs: 8000, pauses: [{ startMs: 6500, endMs: 7000 }], wordsPerMinute: 150 }],
      baselineSnapshot: () => null, close() {},
    }),
    engineFactory: () => ({
      start() {}, hangUp() {},
      state: () => ({ elapsedMs: 5000, transcript: [
        { speaker: 'interviewer', text: 'Hello.', startMs: 4500, endMs: 5500 },
        { speaker: 'candidate', text: 'Hi.', startMs: 6000, endMs: 8000 },
        { speaker: 'candidate', channel: 'chat', text: 'typed', startMs: 3000, endMs: 3000 },
      ] }),
    }),
  } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(trims, [{ files: ['candidate.wav', 'interviewer.wav'], startMs: 4000 }]);
  assert.equal(record.recordingLeadMs, 0, 'the saved recording has no lead left');
  assert.equal(record.timings.setupLeadMs, 4000);
  assert.deepEqual(record.transcript.map(turn => [turn.startMs, turn.endMs]), [[500, 1500], [2000, 4000], [0, 0]], 'times count from the answer and never go below zero');
  assert.deepEqual(record.candidateProsody[0].pauses, [{ startMs: 2500, endMs: 3000 }]);
  assert.equal(record.candidateProsody[0].wordsPerMinute, 150, 'only time fields move');
});

test('the record holds the voiced turns and their tone on the call clock, beside the microphone ones, and hands the engine an ear with the voiced calls', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  let engineEar = null;
  const { service, deps } = await liveCall({ deps: {
    clock,
    trimStart: async () => {},
    earFactory: options => ({
      noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }),
      prepareVoiced() {}, voicedNote: async () => null,
      toneSamples: () => [],
      prosodyTurns: () => [
        { startMs: 6000, endMs: 8000, wordsPerMinute: 150 },
        { startMs: 9000, endMs: 12000, wordCount: 8, wordsPerMinute: 140, voiced: true },
      ],
      baselineSnapshot: () => ({ wordsPerMinute: 150 }), voicedBaselineSnapshot: () => ({ wordsPerMinute: 140 }),
      settle: async () => { options.onToneSample({ atMs: 9000, endMs: 12000, arousal: 0.5, dominance: 0.5, valence: 0.5, voiced: true }); },
      close() {},
    }),
    engineFactory: request => {
      engineEar = request.ear;
      return { start() {}, hangUp() {}, state: () => ({ elapsedMs: 8000, transcript: [
        { speaker: 'candidate', text: 'Hi.', startMs: 6000, endMs: 8000 },
        { speaker: 'candidate', channel: 'chat', voiced: true, text: 'Spoken for me.', startMs: 9000, endMs: 12000 },
      ] }) };
    },
  } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  assert.equal(typeof engineEar?.prepareVoiced, 'function', 'the engine\'s ear has prepareVoiced');
  assert.equal(typeof engineEar?.voicedNote, 'function', 'the engine\'s ear has voicedNote');
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.candidateProsody.map(turn => [turn.startMs, turn.endMs, turn.voiced === true]), [[2000, 4000, false], [5000, 8000, true]], 'voiced turns sit on the same clock as the transcript');
  assert.deepEqual(record.transcript.map(turn => [turn.startMs, turn.endMs]), [[2000, 4000], [5000, 8000]]);
  assert.deepEqual(record.toneSamples.map(sample => [sample.atMs, sample.endMs, sample.voiced]), [[5000, 8000, true]]);
  assert.deepEqual(record.voicedBaseline, { wordsPerMinute: 140 });
  assert.deepEqual(record.voiceBaseline, { wordsPerMinute: 150 });
});

// Seen in the first call made in the built app: a question was asked but never answered, so its
// score was empty. The review accepted that, but storing the same feedback validated it again
// and refused it, and the session the call had armed stayed armed and blocked later calls.
test('feedback that passed validation once passes again, and a refused save never leaves the session armed', async () => {
  const { validatePracticeFeedback } = await import('../../electron/ipc/interviewQaPractice.js');
  const once = validatePracticeFeedback({
    overall: { score: 6, summary: 'Ended early.' },
    planned: [{ question: 'Walk me through a project.', asked: true }, { question: 'Why us?', asked: false }],
    moments: [{ kind: 'small-talk', prompt: 'How is your day?' }],
    priorities: ['Answer the follow-up.'],
  });
  assert.equal(once.planned[0].score, null);
  assert.deepEqual(validatePracticeFeedback(once), once);

  const log = [];
  const registry = {
    arm: async () => { log.push('arm'); return 'session-1'; },
    cancel: nodeId => { log.push(`cancel:${nodeId}`); },
    finish: () => { log.push('finish'); return { status: 'rejected', note: 'not accepted' }; },
  };
  const errors = [];
  const { service } = await startOf({ deps: { registry, analyze: async () => ({ status: 'ready', chapters: [], feedback: { summary: 'solid', callId: null } }) } });
  service.onEvent(event => { if (event.kind === 'feedback-error') errors.push(event); });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.deepEqual(log, ['arm', 'finish', 'cancel:node-1']);
  assert.equal(errors.length, 1);
});

// Seen in the built app: the helper's recording clock starts when capture starts, about 2.5 s
// after the helper is launched, so a lead counted from the launch cut 2.5 s too much.
test('the recording lead is read off the helper clock, not counted from the helper launch', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  let helperEvent;
  const trims = [];
  const { service } = await liveCall({ deps: {
    clock,
    trimStart: async request => { trims.push(request.startMs); },
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
  } });
  await service.start(ARGS);
  // Capture began 2.5 s after the launch: at clock 13500 the helper says 1000 ms have been recorded.
  now = 13500;
  helperEvent({ type: 'level', rms: 0, atMs: 1000 });
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  assert.deepEqual(trims, [1500], 'the answer falls 1.5 s into the recording, not 4 s');
});

// --- panel calls: a lead plus up to two colleagues ------------------------------

const PANEL_VOICES = Object.freeze({
  'lib-1': 'Nora Lead', 'lib-2': 'Ben Specialist', 'lib-3': 'Cara Second', 'lib-4': 'Dana Third', 'lib-5': 'Eli Fourth',
});
const panelVoice = voiceId => ({ ...DRAWN_LIBRARY_VOICE, voiceId, voiceName: PANEL_VOICES[voiceId] });

/** A pending interviewer departure (1.0 to 3.0 s), told apart from the call's 1 s elapsed tick. */
const isDeparture = timer => timer.ms >= 1000 && timer.ms <= 3000 && timer.fn?.name !== 'tick';

/** A clock whose timers only run when a test fires them. */
function manualClock() {
  const timers = [];
  let at = 1000;
  return {
    timers, setNow(value) { at = value; },
    now: () => at,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    fire(timer) { if (!timer.cleared && !timer.fired) { timer.fired = true; timer.fn(); } },
    pending: () => timers.filter(timer => !timer.cleared && !timer.fired),
    lateTimers: () => timers.filter(timer => timer.ms >= 40000 && timer.ms <= 210000),
  };
}

/**
 * Everything a panel start needs: distinct drawn voices, a planner stand-in that seats `cast` (entries name a
 * drawn voice key such as 'V2'), a recording prompt module and a recording engine. `plan` replaces the whole plan.
 */
function panelHarness({ cast = [{ voice: 'V2', role: 'Senior Engineer', focus: 'system design' }], plan, random = () => 0.1, late = false, drawFails = [], silent = [], deps = {}, voices = ['lib-1', 'lib-2', 'lib-3'] } = {}) {
  const draws = [];
  const built = [];
  const starts = [];
  const engineOptions = [];
  const engineCalls = [];
  const factoryOptions = [];
  const clock = manualClock();
  const harness = voiceHarness({ audio: true });
  const make = options => {
    const factory = harness.make(options);
    if (silent.includes(options.voiceId)) {
      const open = factory.open;
      factory.open = openOptions => { const stream = open(openOptions); stream.finish = async () => {}; return stream; };
    }
    return factory;
  };
  const planner = fakePlanner(drawn => (plan ? plan(drawn) : soloPlan(drawn, {
    // The planner decides who joins late; `late: true` has every colleague say so, 51 s in (0.85 minutes).
    panel: cast.filter(member => drawn.some(voice => voice.key === member.voice)).map(member => ({ joins: late ? 'late' : 'start', joinMinutes: late ? 0.85 : 0, stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Rarely cuts in.', ...member })),
  })));
  let made = 0;
  const overrides = {
    clock, random, planCall: planner,
    prompts: {
      buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
      buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
    },
    voiceLibrary: {
      ...realPoolStore,
      drawVoice: async options => {
        draws.push(options);
        if (drawFails.includes(draws.length)) throw new Error('library unreachable');
        return { voice: panelVoice(voices[Math.min(draws.length - 1, voices.length - 1)]), source: 'library', libraryTotal: 3427, attempts: 1 };
      },
    },
    catalog: { pickPersonaVoice: options => ({ voiceId: options.voices[0].voiceId, name: PANEL_VOICES[options.voices[0].voiceId] }) },
    voiceFactory: options => { factoryOptions.push(options); return make(options); },
    sessionsFactory: () => {
      const kind = ['opener', 'main', 'classifier'][made++ % 3];
      return { start: async ({ instructions }) => { starts.push({ kind, instructions }); return { reply: 'READY' }; } };
    },
    panelVoiceFactory: options => ({ panelOf: options, open() { throw new Error('not opened here'); } }),
    engineFactory: options => {
      engineOptions.push(options);
      return {
        start() {}, hangUp() { engineCalls.push('hangup'); }, helperEvent() {}, typed() {},
        participantJoined: id => engineCalls.push(`joined:${id}`),
        state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000 }),
      };
    },
    ...deps,
  };
  return { overrides, clock, draws, built, starts, engineOptions, engineCalls, factoryOptions, planner };
}

const panelStart = async (setup, extra = {}) => {
  const started = await startOf({ modelReady: true, deps: setup.overrides, ...extra });
  const state = await started.service.start(ARGS);
  return { ...started, state };
};

test('panel: five distinct voices are drawn, each avoiding the others and the newest voice, and the planner is offered all of them', async () => {
  const setup = panelHarness({ voices: ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-5'] });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-panel-draw-'));
  await writeFile(poolFilePath(tmp), JSON.stringify({ version: 1, lastUsed: { 'lib-9': 900 } }));
  const built = makeDeps({ tmp, modelReady: true, deps: setup.overrides });
  const service = createPracticeCallService(built.deps);
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  assert.equal(setup.draws.length, 5, 'the lead and four more');
  assert.deepEqual(setup.draws[0].excludeVoiceIds, ['lib-9']);
  assert.deepEqual(setup.draws[1].excludeVoiceIds.sort(), ['lib-1', 'lib-9']);
  assert.deepEqual(setup.draws[2].excludeVoiceIds.sort(), ['lib-1', 'lib-2', 'lib-9']);
  assert.deepEqual(setup.draws[4].excludeVoiceIds.sort(), ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-9']);
  assert.equal(setup.planner.calls.length, 1, 'planned once');
  assert.deepEqual(setup.planner.calls[0].voices.map(voice => voice.key), ['V1', 'V2', 'V3', 'V4', 'V5']);
  // The planner writes each person's name, so a voice comes with no name: only a letter to start looking at.
  for (const voice of setup.planner.calls[0].voices) {
    assert.deepEqual(Object.keys(voice).sort(), ['accent', 'age', 'description', 'gender', 'key', 'nameStart'], 'no voice id and no name reaches the planner');
    assert.match(voice.nameStart, /^[A-Z]$/u);
  }
  assert.ok(Array.isArray(setup.planner.calls[0].recentNames), 'the planner is told the people of recent calls');
  // Nothing is made for a voice the plan did not choose: the lead and the one colleague only.
  assert.deepEqual(setup.factoryOptions.map(item => item.voiceId), ['lib-1', 'lib-2']);
});

test('panel: the plan\'s colleagues settle with ids, names, roles and manner, and every session is built once from them', async () => {
  const setup = panelHarness({ late: true });
  const { state } = await panelStart(setup);
  assert.equal(state.phase, 'ringing');
  const mains = setup.built.filter(item => item.kind === 'main');
  assert.equal(setup.starts.filter(item => item.kind === 'main').length, 1, 'the main session starts once');
  assert.equal(mains.length, 1);
  assert.equal('colleagues' in mains[0].options, false, 'nobody is asked to cast');
  assert.deepEqual(mains[0].options.panel.map(item => [item.id, item.name, item.role, item.focus, item.joins]), [['B', 'Ben Specialist', 'Senior Engineer', 'system design', 'late']]);
  const opener = setup.built.find(item => item.kind === 'opener');
  assert.deepEqual(opener.options.panel, mains[0].options.panel);
  const callPlan = mains[0].options.callPlan;
  assert.equal(callPlan.interviewKind, 'A short screening conversation.');
  assert.equal('lead' in callPlan || 'panel' in callPlan, false, 'the plan names its people, not a lead and a panel');
  assert.deepEqual(callPlan.people.map(item => [item.id, item.name, item.role, item.focus, item.manner]),
    [['A', 'Nora Lead', 'Hiring Manager', '', 'Even and direct.'], ['B', 'Ben Specialist', 'Senior Engineer', 'system design', 'Plain.']]);
  assert.equal(callPlan.people[0].temperament, 'neutral');
  assert.equal(Boolean(callPlan.people[0].voice), true);
  assert.deepEqual(callPlan.people[1].joins === 'late' || callPlan.people[1].joins === 'start', true);
  assert.equal(Boolean(callPlan.people[1].voice), true);
  assert.deepEqual(callPlan.people.map(item => item.interrupting), ['Lets people finish and rarely cuts in.', 'Rarely cuts in.'], 'how each person interrupts reaches the prompts');
  assert.equal(mains[0].options.persona.interrupting, 'Lets people finish and rarely cuts in.');
  assert.deepEqual(mains[0].options.panel.map(item => item.interrupting), ['Rarely cuts in.']);
  assert.deepEqual(callPlan.questions, [{ number: 1, askedBy: 'A', minutes: 10, probes: [] }]);
  assert.deepEqual(callPlan.problems, []);
  assert.deepEqual(mains[0].options.picked, [1]);
  assert.equal(state.persona.name, 'Nora Lead');
  assert.equal(state.persona.role, 'Hiring Manager', 'the role is known before the call rings');
  assert.deepEqual(state.participants.map(item => [item.id, item.status]), [['A', 'joined']], 'a late colleague is not shown yet');
});

test('panel: a colleague the plan has there from the start joins at the call start, whatever the random draws', async () => {
  const setup = panelHarness({ random: () => 0.1, cast: [{ voice: 'V2', role: 'Engineer', focus: '' }] });
  const { state } = await panelStart(setup);
  assert.deepEqual(setup.built.find(item => item.kind === 'main').options.panel.map(item => item.joins), ['start']);
  assert.deepEqual(state.participants.map(item => item.id), ['A', 'B'], 'a colleague who starts with the call is shown at once');
});

test('panel: a plan with colleagues builds the panel voice and tells the engine who is present', async () => {
  const setup = panelHarness({ random: () => 0.9, cast: [{ voice: 'V2', role: 'Engineer', focus: 'api' }, { voice: 'V3', role: 'Director', focus: '' }] });
  const { service } = await panelStart(setup);
  await service.answer();
  const options = setup.engineOptions[0];
  assert.deepEqual(Object.keys(options.voice.panelOf.factories), ['A', 'B', 'C']);
  assert.equal(options.voice.panelOf.leadId, 'A');
  assert.equal(options.voice.panelOf.factories.B.options.voiceId, 'lib-2');
  assert.equal(options.voice.panelOf.factories.C.options.voiceId, 'lib-3');
  assert.deepEqual(options.panel, { leadId: 'A', speakers: [
    { id: 'A', name: 'Nora Lead', role: 'Hiring Manager', present: true, joined: true }, { id: 'B', name: 'Ben Specialist', role: 'Engineer', present: true, joined: true }, { id: 'C', name: 'Cara Second', role: 'Director', present: true, joined: true },
  ] });
  await service.hangUp();
});

test('panel: a plan with no colleagues keeps the call solo', async () => {
  const setup = panelHarness({ cast: [] });
  const { service, state } = await panelStart(setup);
  assert.equal(state.phase, 'ringing');
  await service.answer();
  const options = setup.engineOptions[0];
  assert.equal('panel' in options, false, 'the engine gets no panel');
  assert.deepEqual(Object.keys(options.voice.panelOf.factories), ['A'], 'a panel voice with the lead alone');
  assert.equal(options.voice.panelOf.leadId, 'A');
  assert.deepEqual(service.getState().participants.map(item => item.id), ['A']);
  assert.equal(setup.clock.lateTimers().length, 0, 'no join timer');
  const main = setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.panel, []);
  assert.deepEqual(main.options.callPlan.people.map(item => item.id), ['A']);
  assert.deepEqual(setup.factoryOptions.map(item => item.voiceId), ['lib-1'], 'only the lead is made');
  await service.hangUp();
});

test('panel: the lead may be any drawn voice, and only the chosen voices are made and warmed', async () => {
  const setup = panelHarness({
    voices: ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-5'], random: () => 0.9,
    plan: drawn => soloPlan(drawn, {
      lead: { voice: 'V3', role: 'Engineering Manager', temperament: 'warm', stability: 0.4, room: 0.2, manner: 'Unhurried.', interrupting: 'Lets people finish and rarely cuts in.' },
      panel: [{ voice: 'V1', role: 'Recruiter', focus: 'logistics', stability: 0.3, room: 0.6, manner: 'Brisk.', interrupting: 'Lets people finish and rarely cuts in.' }, { voice: 'V5', role: 'Designer', focus: 'ux', stability: 0.5, room: 0.3, manner: 'Curious.', interrupting: 'Lets people finish and rarely cuts in.' }],
      questions: [{ number: 1, askedBy: 'V3', minutes: 8, probes: [] }],
    }),
  });
  const { service, state } = await panelStart(setup);
  assert.equal(state.persona.name, 'Cara Second', 'the planned lead is the third drawn voice');
  assert.deepEqual(state.participants.map(item => [item.id, item.name]), [['A', 'Cara Second'], ['B', 'Nora Lead'], ['C', 'Eli Fourth']], 'colleagues take ids in plan order');
  assert.deepEqual(setup.factoryOptions.map(item => [item.voiceId, item.stability]), [['lib-3', 0.4], ['lib-1', 0.3], ['lib-5', 0.5]]);
  const warmed = voiceId => setup.factoryOptions.some(item => item.voiceId === voiceId);
  assert.equal(warmed('lib-2') || warmed('lib-4'), false, 'a drawn voice the plan did not use is never made or warmed');
  await service.answer();
  assert.deepEqual(Object.keys(setup.engineOptions[0].voice.panelOf.factories), ['A', 'B', 'C']);
  assert.equal(setup.engineOptions[0].voice.panelOf.factories.A.options.voiceId, 'lib-3');
  await service.hangUp();
});

test('panel: a failed extra draw, a repeated voice or a silent warm-up only means fewer colleagues', async () => {
  const failed = panelHarness({ drawFails: [2] });
  await panelStart(failed);
  assert.deepEqual(failed.planner.calls[0].voices.map(voice => voice.key), ['V1', 'V2'], 'the voice that could not be drawn is simply not offered');
  assert.deepEqual(failed.built.find(item => item.kind === 'main').options.panel.map(item => [item.id, item.name]), [['B', 'Cara Second']],
    'the colleague who remains takes the first colleague id');

  // A chosen colleague whose voice does not answer is left off the call instead of speaking in the lead's voice.
  const silent = panelHarness({ silent: ['lib-2'] });
  const quiet = await panelStart(silent);
  assert.equal(silent.built.find(item => item.kind === 'main').options.panel.length, 1, 'the first build seats the planned colleague');
  assert.equal(quiet.state.phase, 'ringing');
  assert.deepEqual(silent.built.findLast(item => item.kind === 'opener').options.panel, [], 'a chosen voice that does not warm up is dropped');
  assert.equal(quiet.state.participants.length, 1);

  const repeated = panelHarness();
  repeated.overrides.voiceLibrary.drawVoice = async () => ({ voice: panelVoice('lib-1'), source: 'library', libraryTotal: 1, attempts: 1 });
  const solo = await panelStart(repeated);
  assert.equal(solo.state.phase, 'ringing');
  assert.deepEqual(repeated.planner.calls[0].voices.map(voice => voice.key), ['V1'], 'the lead voice drawn again is not offered a second time');
});

test('panel: a failed lead draw still fails the call', async () => {
  const setup = panelHarness({ drawFails: [1] });
  const { state } = await panelStart(setup);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'voice-library-unavailable');
});

test('panel: the late-join cap is a quarter of the length the planner chose, not of what the question budgets add up to', async () => {
  const member = { voice: 'V2', role: 'Senior Engineer', focus: 'register work', joins: 'late', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Rarely cuts in.' };
  const own = key => ({ number: 0, text: 'What do you assume an attacker can do?', askedBy: key, minutes: 1, probes: [] });
  const delayFor = async (joinMinutes, callMinutes, questionMinutes) => {
    const setup = panelHarness({ plan: drawn => soloPlan(drawn, { callMinutes, panel: [{ ...member, joinMinutes }], questions: [own(drawn[0].key), { number: 1, askedBy: 'V2', minutes: questionMinutes, probes: [] }] }) });
    const started = await panelStart(setup);
    await started.service.answer();
    const timers = setup.clock.pending().filter(timer => timer.ms >= 10000 && timer.ms <= 600000).map(timer => timer.ms);
    await started.service.hangUp({ feedback: false });
    return timers;
  };
  // Ten budgeted minutes on a thirty minute call: a seven minute join is within a quarter of thirty (7:30), not cut to 2:30.
  assert.deepEqual(await delayFor(7, 30, 9), [420000]);
  // Budgets that run past the length: the cap follows the length (a quarter of 4 minutes is one).
  assert.deepEqual(await delayFor(3, 4, 6), [60000]);
});

test('panel: a fixed temperament still wins over the plan and the plan\'s colleagues are still seated', async () => {
  const setup = panelHarness({ plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, temperament: 'warm' },
    panel: [{ voice: 'V2', role: 'Senior Engineer', focus: 'system design', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
  }) });
  const loadBrief = async args => {
    const loaded = await makeDeps({ tmp: '/unused' }).deps.loadBrief(args);
    return { ...loaded, practice: { temperament: 'tough' } };
  };
  const { state } = await panelStart(setup, { deps: { ...setup.overrides, loadBrief } });
  assert.equal(state.phase, 'ringing');
  assert.equal(state.persona.name, 'Nora Lead');
  const opener = setup.built.find(item => item.kind === 'opener');
  assert.equal(opener.options.persona.temperament, 'tough');
  assert.equal(opener.options.callPlan.people[0].temperament, 'tough', 'the plan the interviewer reads says the same');
  assert.equal(opener.options.panel.length, 1, 'the colleagues were seated although the temperament was fixed');
});

test('a temperament the request or the brief gives is passed through as written, whatever the word', async () => {
  for (const written of ['Dry and unhurried.', 'Tough', 'tough']) {
    const setup = panelHarness({ plan: drawn => soloPlan(drawn, { lead: { ...soloPlan(drawn).lead, temperament: 'warm' } }) });
    const loadBrief = async args => ({ ...(await makeDeps({ tmp: '/unused' }).deps.loadBrief(args)), practice: { temperament: `  ${written} ` } });
    await panelStart(setup, { deps: { ...setup.overrides, loadBrief } });
    const opener = setup.built.find(item => item.kind === 'opener');
    assert.equal(opener.options.persona.temperament, written, 'trimmed, with its case and wording kept');
  }
  const blank = panelHarness({ plan: drawn => soloPlan(drawn, { lead: { ...soloPlan(drawn).lead, temperament: 'warm' } }) });
  const loadBlank = async args => ({ ...(await makeDeps({ tmp: '/unused' }).deps.loadBrief(args)), practice: { temperament: '   ' } });
  await panelStart(blank, { deps: { ...blank.overrides, loadBrief: loadBlank } });
  assert.equal(blank.built.find(item => item.kind === 'opener').options.persona.temperament, 'warm', 'a blank one leaves the planner\'s text');
});

test('panel: whoever asks the plan\'s first question is on the call from the start, and lateness is capped at a quarter of the planned minutes', async () => {
  const member = { voice: 'V2', role: 'Senior Engineer', focus: 'register work', joins: 'late', joinMinutes: 2, stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Rarely cuts in.' };
  const own = key => ({ number: 0, text: 'What do you assume an attacker can do?', askedBy: key, minutes: 1, probes: [] });
  const lateTimers = setup => setup.clock.pending().filter(timer => timer.ms >= 10000 && timer.ms <= 600000);
  // The plan has the colleague late; the one who opens the questions is there anyway (call-mwsvsqmu: the owner of the
  // only exercise of a five-minute screen joined at 2:52).
  const first = panelHarness({ plan: drawn => soloPlan(drawn, { panel: [member], questions: [{ number: 1, askedBy: 'V2', minutes: 4, probes: [] }, own(drawn[0].key)] }) });
  const started = await panelStart(first);
  await started.service.answer();
  assert.equal(lateTimers(first).length, 0, 'no join timer for the colleague who asks first');
  assert.deepEqual(started.service.getState().participants.map(item => item.id), ['A', 'B']);
  await started.service.hangUp({ feedback: false });
  // The lead asks first: the colleague is late as the plan says, but never past a quarter of the five planned minutes (75 s).
  const delays = [];
  for (const joinMinutes of [9, 1.2, 0.1]) {
    const short = panelHarness({ plan: drawn => soloPlan(drawn, { panel: [{ ...member, joinMinutes }], questions: [own(drawn[0].key), { number: 1, askedBy: 'V2', minutes: 4, probes: [] }] }) });
    const late = await panelStart(short);
    await late.service.answer();
    assert.deepEqual(late.service.getState().participants.map(item => item.id), ['A']);
    delays.push(lateTimers(short).map(timer => timer.ms));
    await late.service.hangUp({ feedback: false });
  }
  assert.deepEqual(delays, [[75000], [72000], [30000]], 'a later time than a quarter is cut to it, a sensible one kept, and an instant one is at least 30 s in');
});

test('panel: the planner decides who joins late and when, each colleague on their own', async () => {
  const cast = [
    { voice: 'V2', role: 'Senior Engineer', focus: 'api', joins: 'late', joinMinutes: 2.5 },
    { voice: 'V3', role: 'Director', focus: 'hiring', joins: 'start', joinMinutes: 0 },
    { voice: 'V4', role: 'Analyst', focus: 'data', joins: 'late', joinMinutes: 4 },
  ];
  // Every draw says "late" and sits mid-window, as the old dice would have: only the plan's own words count now.
  const setup = panelHarness({ cast, voices: ['lib-1', 'lib-2', 'lib-3', 'lib-4'], random: () => 0.1, plan: drawn => soloPlan(drawn, {
    callMinutes: 40, wrapUpMinutes: 6,
    panel: cast.map(member => ({ stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Rarely cuts in.', ...member })),
    questions: [{ number: 1, askedBy: drawn[0].key, minutes: 20, probes: [] }, { number: 0, text: 'What would you build first here?', askedBy: 'V2', minutes: 10, probes: [] }],
  }) });
  const built = await panelStart(setup);
  assert.equal(built.state.phase, 'ringing');
  const main = setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.panel.map(item => [item.id, item.joins]), [['B', 'late'], ['C', 'start'], ['D', 'late']]);
  assert.equal(built.state.participants.map(item => item.id).join(''), 'AC', 'only the colleague who is there from the start is shown');
  await built.service.answer();
  assert.deepEqual(setup.clock.pending().filter(timer => timer.ms >= 100000 && timer.ms <= 600000).map(timer => timer.ms), [150000, 240000], 'the minutes the plan gave, each colleague\'s own');
  assert.deepEqual(built.service.getState().participants.map(item => item.id), ['A', 'C']);
  await built.service.hangUp({ feedback: false });
});

test('panel: a colleague the plan gives no join choice (a stand-in plan, or one kept from before) is there from the start', async () => {
  const setup = panelHarness({ random: () => 0.1, plan: drawn => soloPlan(drawn, { panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Rarely cuts in.' }] }) });
  const built = await panelStart(setup);
  assert.deepEqual(setup.built.find(item => item.kind === 'main').options.panel.map(item => item.joins), ['start']);
  assert.deepEqual(built.state.participants.map(item => item.id), ['A', 'B']);
});

test('panel: a late colleague joins when the timer fires, once, and the record keeps the time', async () => {
  const setup = panelHarness({ late: true });
  const { service, deps } = await panelStart(setup);
  const events = [];
  service.onEvent(event => events.push(event));
  const states = [];
  service.onState(item => states.push(item));
  await service.answer();
  const late = setup.clock.lateTimers();
  assert.equal(late.length, 1, 'one timer for the one late colleague');
  assert.equal(late[0].ms >= 40000 && late[0].ms <= 210000, true);
  assert.equal(late[0].ms, 51000, 'the 0.85 minutes the plan says, inside a quarter of the planned ten minutes (150 s)');
  assert.deepEqual(service.getState().participants.map(item => item.id), ['A']);
  setup.clock.setNow(1000 + 51000);
  setup.clock.fire(late[0]);
  setup.clock.fire(late[0]);
  assert.deepEqual(service.getState().participants.map(item => [item.id, item.name, item.role, item.focus, item.status]), [
    ['A', 'Nora Lead', 'Hiring Manager', '', 'joined'], ['B', 'Ben Specialist', 'Senior Engineer', 'system design', 'joined'],
  ]);
  assert.deepEqual(events.filter(event => event.type === 'participant-joined'), [{ type: 'participant-joined', id: 'B', name: 'Ben Specialist', kind: 'participant-joined' }]);
  assert.deepEqual(setup.engineCalls, ['joined:B']);
  assert.equal(states.some(item => item.participants.length === 2), true, 'the join is published');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.panel, [{ id: 'B', name: 'Ben Specialist', role: 'Senior Engineer', focus: 'system design', interrupting: 'Rarely cuts in.', joins: 'late', joinedAtMs: 51000, voiceId: 'lib-2', room: { seed: 'lib-2', rt60Ms: 300 }, roomAmount: 0.4, stability: 0.3 }]);
  assert.equal(record.persona.name, 'Nora Lead');
});

test('panel: a colleague who never joined has a null join time and every way a call ends clears the timers', async () => {
  for (const [label, end] of [
    ['hang up', service => service.hangUp()],
    ['abandon', service => service.abandon()],
    ['interviewer leaves', async (service, built, setup) => { setup.engineOptions[0].onEvent({ type: 'ended', reason: 'interviewer' }); }],
  ]) {
    const setup = panelHarness({ late: true });
    const built = await panelStart(setup);
    await built.service.answer();
    const timers = setup.clock.lateTimers();
    assert.equal(setup.clock.pending().filter(timer => timers.includes(timer)).length, 1, label);
    await end(built.service, built, setup);
    assert.equal(timers.every(timer => timer.cleared), true, `${label}: the join timer is cleared`);
    setup.clock.fire(timers[0]);
    assert.equal(built.service.getState().participants.some(item => item.id === 'B'), false, `${label}: a cleared timer joins nobody`);
    if (label === 'hang up') {
      const record = await built.deps.store.readRecord('call-1');
      assert.equal(record.panel[0].joinedAtMs, null);
    }
  }
});

test('panel: a pause holds a late colleague\'s wait on the call clock, and the resume waits only for what is left', async () => {
  const setup = panelHarness({ late: true });
  const built = await panelStart(setup);
  await built.service.answer();
  const engine = setup.engineOptions[0].onEvent;
  const [first] = setup.clock.lateTimers();
  assert.equal(first.ms, 51000);
  setup.clock.setNow(1000 + 20000);
  engine({ type: 'paused', paused: true });
  assert.equal(first.cleared, true, 'the pause stops the wait');
  // However long the pause, nobody joins during it, even from a timer a clock failed to clear.
  setup.clock.setNow(1000 + 20000 + 300000);
  first.cleared = false;
  setup.clock.fire(first);
  assert.deepEqual(built.service.getState().participants.map(item => item.id), ['A'], 'nobody joins a paused call');
  assert.equal(setup.clock.pending().filter(timer => timer !== first && timer.ms === 31000).length, 0, 'no wait is armed while paused');
  engine({ type: 'paused', paused: false });
  const resumed = setup.clock.pending().filter(timer => timer.ms === 31000);
  assert.equal(resumed.length, 1, 'the resume waits for the 31 s left of the 51 s');
  // A second resume event, or a pause state set to what it already is, arms nothing more.
  engine({ type: 'paused', paused: false });
  assert.equal(setup.clock.pending().filter(timer => timer.ms === 31000).length, 1);
  setup.clock.setNow(setup.clock.now() + 31000);
  setup.clock.fire(resumed[0]);
  assert.deepEqual(built.service.getState().participants.map(item => item.id), ['A', 'B'], 'the colleague joins 57 s into the call as its clock counts it');
  assert.deepEqual(setup.engineCalls, ['joined:B']);
});

test('with a candidate voice each sent message waits on it until its line starts playing or is given up on', async () => {
  const typed = [];
  const setup = panelHarness({ random: () => 0.1, deps: {
    candidateVoices: true,
    candidateVoice: () => ({ open() { throw new Error('not opened here'); } }),
  } });
  setup.overrides.engineFactory = options => {
    setup.engineOptions.push(options);
    return { start() {}, hangUp() {}, helperEvent() {}, typed: (text, flags) => { typed.push(flags); return true; }, participantJoined() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
  };
  const built = await panelStart(setup);
  await built.service.answer();
  assert(setup.engineOptions[0].candidateVoice, 'the engine has the candidate voice');
  const engine = setup.engineOptions[0].onEvent;
  let state = built.service.sendChat('First.', { generated: true });
  assert.equal(state.chat.at(-1).voice, 'waiting', 'the returned state already shows the message waiting');
  built.service.sendChat('Second.');
  built.service.sendChat('Third.');
  const [a, b, c] = typed.map(flag => flag.chatId);
  engine({ type: 'candidate-voice', state: 'speaking', chars: 6 });
  assert.equal(built.service.getState().chat.find(item => item.id === a).voice, 'waiting', 'the voice being written is not the line being heard');
  engine({ type: 'candidate-voice', state: 'started', chatIds: [a] });
  state = built.service.getState();
  assert.deepEqual(state.chat.filter(item => item.from === 'candidate').map(item => item.voice), ['playing', 'waiting', 'waiting']);
  engine({ type: 'error', code: 'candidate-voice-failed', chatIds: [b] });
  state = built.service.getState();
  assert.equal(state.chat.find(item => item.id === b).voice, 'failed');
  assert.equal(state.notice?.code, 'candidate-voice-failed', 'the failure is still shown');
  // A message cut before it was ever heard (a pause on the injected path) is given up on too.
  engine({ type: 'candidate-voice', state: 'cut', heardChars: 0, injected: true, messages: [{ chatId: c, heard: '' }] });
  assert.deepEqual(built.service.getState().chat.find(item => item.id === c), { ...built.service.getState().chat.find(item => item.id === c), unsaid: true, voice: 'failed' });
  // The interviewer ending the call lets go of anything still waiting.
  built.service.sendChat('Fourth.');
  assert.equal(built.service.getState().chat.at(-1).voice, 'waiting');
  engine({ type: 'ended', reason: 'interviewer' });
  assert.equal(built.service.getState().chat.at(-1).voice, 'failed');
});

test('the candidate\'s own voice is warmed during setup, so its first line is not the slow one', async () => {
  const setup = panelHarness({ random: () => 0.1, voices: ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-5'], deps: {
    candidateVoices: true, candidateVoiceGender: () => 'female',
    candidateVoice: () => ({ open() { throw new Error('not opened here'); } }),
  } });
  const started = await panelStart(setup);
  const beforeAnswer = setup.factoryOptions.map(item => item.voiceId);
  await started.service.answer();
  const engine = setup.engineOptions[0];
  assert(engine.candidateVoice, 'the call has a candidate voice');
  // The voices made for the candidate on answering are the candidate's own; each was already opened during setup.
  const madeOnAnswer = setup.factoryOptions.slice(beforeAnswer.length).map(item => item.voiceId);
  assert(madeOnAnswer.length >= 1, 'the candidate voice is made on answering');
  assert(madeOnAnswer.some(id => beforeAnswer.includes(id)), `the candidate voice was warmed before the call: setup ${JSON.stringify(beforeAnswer)}, answer ${JSON.stringify(madeOnAnswer)}`);
});

test('the candidate\'s voice is the one the planner picked among those offered', async () => {
  let offered;
  const setup = panelHarness({ random: () => 0.1, deps: { candidateVoices: true, candidateVoiceGender: () => 'male', candidateVoice: () => ({ open() { throw new Error('not opened here'); } }) } });
  const draw = setup.overrides.voiceLibrary.drawVoice;
  let drawn = 0;
  setup.overrides.voiceLibrary.drawVoice = async options => (options.gender
    ? { voice: { voiceId: `cand-${options.gender}-${drawn += 1}`, voiceName: `Voice ${drawn}`, gender: options.gender, age: 'young', accent: 'canadian', description: `sounds like ${drawn}` } } : draw(options));
  const planner = setup.overrides.planCall;
  setup.overrides.planCall = async inputs => {
    offered = inputs.candidateVoices;
    const made = await planner(inputs);
    return { ...made, plan: { ...made.plan, candidateVoice: { male: 'M2' } } };
  };
  await panelStart(setup);
  assert.deepEqual(offered.map(item => item.key), ['F1', 'F2', 'F3', 'M1', 'M2', 'M3']);
  assert.match(offered[4].description, /sounds like 5/u);
  assert(setup.factoryOptions.some(item => item.voiceId === 'cand-male-5'), 'the picked male voice is the one warmed');
  assert(!setup.factoryOptions.some(item => item.voiceId === 'cand-male-4'), 'the first drawn is not used');
});

test('a wand line sent during a pause is made and held when the voice can hold it, and stops waiting once ready', async () => {
  const typed = [];
  let holds = true;
  const setup = panelHarness({ random: () => 0.1, deps: {
    candidateVoices: true,
    candidateVoice: () => ({ open() { throw new Error('not opened here'); } }),
  } });
  setup.overrides.engineFactory = options => {
    setup.engineOptions.push(options);
    return { start() {}, hangUp() {}, helperEvent() {}, setPaused() {}, canHoldVoice: () => holds, typed: (text, flags) => { typed.push({ text, ...flags }); return true; }, participantJoined() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
  };
  const built = await panelStart(setup);
  await built.service.answer();
  const engine = setup.engineOptions[0].onEvent;
  built.service.setPaused(true);
  engine({ type: 'paused', paused: true });
  let state = built.service.sendChat('Typed by hand.');
  assert.equal(state.chat.length, 0, 'a typed message is still refused while paused');
  state = built.service.sendChat('From the wand.', { generated: true });
  assert.equal(state.chat.at(-1).voice, 'waiting');
  assert.deepEqual(typed.map(item => item.text), ['From the wand.']);
  engine({ type: 'candidate-voice', state: 'ready', injected: true, held: true, chatIds: [typed[0].chatId] });
  assert.equal(built.service.getState().chat.at(-1).voice, 'ready', 'ready while paused: the wand stops spinning');
  engine({ type: 'candidate-voice', state: 'started', injected: true, chatIds: [typed[0].chatId] });
  assert.equal(built.service.getState().chat.at(-1).voice, 'playing');
  // A voice that cannot hold a line refuses it during a pause; the window keeps it for the resume.
  holds = false;
  state = built.service.sendChat('Another.', { generated: true });
  assert.equal(state.chat.length, 1);
  assert.equal(state.paused, true);
});

test('the call is named after the position, as a meeting invite is, never after an interviewer\'s job title', async () => {
  const setup = panelHarness({ random: () => 0.1 });
  const built = await panelStart(setup);
  const state = built.service.getState();
  assert.equal(state.meetingTitle, 'Interview: Engineer · Acme');
  assert.notEqual(state.meetingTitle, state.persona.role);
});

test('each time an interviewer starts speaking the window is told, with the reaction time to give way after', async () => {
  const setup = panelHarness({ random: () => 0.1 });
  const built = await panelStart(setup);
  await built.service.answer();
  const engine = setup.engineOptions[0].onEvent;
  assert.equal(built.service.getState().floor, null);
  engine({ type: 'floor', speakerId: 'A', yieldMs: 420 });
  assert.deepEqual(built.service.getState().floor, { n: 1, yieldMs: 420, speakerId: 'A' });
  engine({ type: 'floor', speakerId: 'B', yieldMs: 800 });
  assert.deepEqual(built.service.getState().floor, { n: 2, yieldMs: 800, speakerId: 'B' }, 'a count, so a second start right after is seen');
});

test('without a candidate voice a sent message never waits on one', async () => {
  const setup = panelHarness({ random: () => 0.1 });
  const built = await panelStart(setup);
  await built.service.answer();
  const state = built.service.sendChat('Plain typed line.');
  assert.equal('voice' in state.chat.at(-1), false);
});

// --- holding the same interview again ----------------------------------------

const OTHER_CARD = Object.freeze({ id: 'q0', question: 'Why this team?', answer: 'Because of the work.' });
const waitFor = async (check, label) => {
  for (let i = 0; i < 100; i += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`timed out waiting: ${label}`);
};
/** A panel service that keeps its interviews in `saved`; `extra` replaces deps (cards, posting key, random); the colleague joins late unless `late` is false. */
async function savedPanel(saved, { random = () => 0.1, late = true, extra = {} } = {}) {
  const setup = panelHarness({ random, late, deps: { savedInterviews: saved, ...extra } });
  const started = await startOf({ modelReady: true, deps: setup.overrides });
  return { setup, ...started };
}

test('saved interviews: a kept candidate voice that was taken out is drawn again on a repeat, the other one kept', async () => {
  const rootDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'practice-saved-')), 'practice-interviews');
  const saved = createSavedInterviewStore({ rootDir });
  const voiceDeps = { candidateVoices: true, candidateVoice: () => ({ open() { throw new Error('not opened here'); } }) };
  const first = await savedPanel(saved, { extra: voiceDeps });
  await first.service.start(ARGS);
  await first.service.answer();
  await waitFor(async () => (await first.service.listSaved('node-1')).length === 1, 'the interview is kept');
  await first.service.hangUp();
  const [kept] = await first.service.listSaved('node-1');
  // The male voice turned out to be a female one and is taken out of the kept interview by hand.
  const file = path.join(rootDir, kept.id, 'interview.json');
  const entry = JSON.parse(await readFile(file, 'utf8'));
  assert(entry.candidateVoiceIds?.female && entry.candidateVoiceIds?.male, 'both candidate voices were kept');
  const female = entry.candidateVoiceIds.female;
  delete entry.candidateVoiceIds.male;
  await writeFile(file, JSON.stringify(entry));

  const again = await savedPanel(saved, { extra: voiceDeps });
  again.setup.overrides.voiceLibrary.listBuiltInVoices = async () => ({ voiceIds: ['premade-1'], names: ['brian - deep, resonant and comforting'] });
  const state = await again.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.notEqual(state.phase, 'error', JSON.stringify(state.error));
  assert.deepEqual(again.setup.draws.map(item => item.gender), ['male'], 'only the missing voice is drawn');
  assert(again.setup.draws[0].excludeVoiceIds.includes(female.voiceId), 'never the female voice again');
  assert(again.setup.draws[0].excludeVoiceIds.includes('premade-1'), 'never a built-in voice, as on a new call');
  assert.deepEqual(again.setup.draws[0].excludeNames, ['brian - deep, resonant and comforting']);
  await again.service.answer();
  await waitFor(async () => JSON.parse(await readFile(file, 'utf8')).timesUsed === 2, 'the retake is counted');
  const keptAgain = JSON.parse(await readFile(file, 'utf8')).candidateVoiceIds;
  assert.deepEqual(keptAgain.female, female, 'the kept voice stays as it was');
  assert(keptAgain.male?.voiceId, 'the voice drawn again is kept with the interview');
  await again.service.hangUp();

  // The next retake holds both: nothing is drawn.
  const third = await savedPanel(saved, { extra: voiceDeps });
  await third.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.deepEqual(third.setup.draws, [], 'the kept voices are used as they are');
  await third.service.hangUp();

  // Neither kept (both were taken out, or neither drew): both are drawn again.
  const latest = JSON.parse(await readFile(file, 'utf8'));
  latest.candidateVoiceIds = null;
  await writeFile(file, JSON.stringify(latest));
  const bare = await savedPanel(saved, { extra: voiceDeps });
  await bare.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.deepEqual(bare.setup.draws.map(item => item.gender), ['female', 'male']);
  await bare.service.hangUp();
});

test('saved interviews: an answered call is kept, and a repeat for the same job holds it again with nothing drawn or planned', async () => {
  const saved = createSavedInterviewStore({ rootDir: path.join(await mkdtemp(path.join(os.tmpdir(), 'practice-saved-')), 'practice-interviews') });
  const first = await savedPanel(saved);
  assert.deepEqual(await first.service.listSaved('node-1'), [], 'nothing is kept before a call is answered');
  await first.service.start(ARGS);
  const persona = first.service.getState().persona.name;
  await first.service.answer();
  assert.equal(first.setup.clock.lateTimers()[0].ms, 51000);
  await waitFor(async () => (await first.service.listSaved('node-1')).length === 1, 'the interview is kept');
  await first.service.hangUp();
  const [kept] = await first.service.listSaved('node-1');
  assert.equal(kept.lead.name, 'Nora Lead');
  assert.deepEqual(kept.panel.map(item => item.name), ['Ben Specialist']);
  assert.equal(kept.questionCount, 1);
  assert.equal(kept.company, 'Acme');
  assert.equal(kept.timesUsed, 1);

  // A new plan that would have the colleague there from the start, and a reordered pool: the repeat still matches the first.
  const again = await savedPanel(saved, { random: () => 0.9, late: false, extra: { loadCards: async () => [OTHER_CARD, CARD] } });
  const state = await again.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.notEqual(state.phase, 'error', JSON.stringify(state.error));
  assert.equal(again.setup.draws.length, 0, 'no voice is drawn');
  assert.equal(again.setup.planner.calls.length, 0, 'nothing is planned');
  assert.equal(again.service.getState().persona.name, persona, 'the same lead');
  const main = again.setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.callPlan.questions.map(question => question.number), [2], 'the question is found again by id in the reordered pool');
  assert.deepEqual(main.options.plan.map(item => item.id), ['q0', 'q1'], 'number 2 is that question in today\'s pool');
  await again.service.answer();
  const late = again.setup.clock.lateTimers();
  assert.equal(late.length, 1, 'the colleague joins late again');
  assert.equal(late[0].ms, 51000, 'at the same moment as the first time');
  await waitFor(async () => (await again.service.listSaved('node-1'))[0]?.timesUsed === 2, 'the repeat is counted');
  await again.service.hangUp();
  const record = await again.deps.store.readRecord('call-1');
  assert.equal(record.repeatOf, kept.id);
  assert.deepEqual(record.pickedQuestions, [2]);
  assert.equal((await again.service.listSaved('node-1')).length, 1, 'a repeat is not kept a second time');

  // A card removed since: the question comes back with the answer it had.
  const removed = await savedPanel(saved, { extra: { loadCards: async () => [OTHER_CARD] } });
  await removed.service.start({ ...ARGS, repeatInterviewId: kept.id });
  const mainRemoved = removed.setup.built.find(item => item.kind === 'main');
  assert.deepEqual(mainRemoved.options.callPlan.questions.map(question => question.number), [2]);
  assert.deepEqual(mainRemoved.options.plan.map(item => [item.id, item.question]), [['q0', 'Why this team?'], ['q1', 'Tell me about a launch.']], 'the removed card joins the pool as it was');
  await removed.service.hangUp();

  // A card reworded since: the plan was written for the old wording, so that is the one asked.
  const reworded = await savedPanel(saved, { extra: { loadCards: async () => [{ ...CARD, question: 'Walk me through a release.' }] } });
  await reworded.service.start({ ...ARGS, repeatInterviewId: kept.id });
  const mainReworded = reworded.setup.built.find(item => item.kind === 'main');
  assert.deepEqual(mainReworded.options.callPlan.questions.map(question => question.number), [2]);
  assert.deepEqual(mainReworded.options.plan.map(item => item.question), ['Walk me through a release.', 'Tell me about a launch.'], 'the question is asked as it was planned');
  await reworded.service.hangUp();
});

test('saved interviews: a repeat brings back the screens\' diagrams and pictures as they were, without making new ones', async () => {
  const saved = createSavedInterviewStore({ rootDir: path.join(await mkdtemp(path.join(os.tmpdir(), 'practice-saved-')), 'practice-interviews') });
  const made = [];
  const visualDeps = {
    visualPickText: async () => ({}),
    visuals: async ({ parts }) => { made.push(parts.map(part => part.id)); return new Map([[parts[0].id, { kind: 'diagram', mime: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', description: 'Two queues side by side.', lead: 'Here is the layout.' }]]); },
  };
  const withProblem = drawn => soloPlan(drawn, {
    questions: [{ number: 1, askedBy: drawn[0].key, minutes: 10, probes: [] }],
    problems: [{ ref: 'p1', question: 1, language: '', parts: [{ title: 'Queues', content: 'How would you split this?', visual: { kind: 'diagram', search: '', shows: 'two queues' } }], solution: 'Split.', edgeCases: [], hints: [] }],
  });
  const firstSetup = panelHarness({ plan: withProblem, deps: { savedInterviews: saved, ...visualDeps } });
  const first = await startOf({ modelReady: true, deps: firstSetup.overrides });
  await first.service.start(ARGS);
  await first.service.answer();
  await waitFor(async () => (await first.service.listSaved('node-1')).length === 1, 'kept');
  await first.service.hangUp();
  const [kept] = await first.service.listSaved('node-1');
  assert.equal((await saved.read(kept.id)).visuals.length, 1, 'the diagram is kept with the interview');
  const againSetup = panelHarness({ plan: withProblem, deps: { savedInterviews: saved, ...visualDeps } });
  const again = await startOf({ modelReady: true, deps: againSetup.overrides });
  await again.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.equal(made.length, 1, 'nothing is drawn or searched for the repeat');
  const part = againSetup.built.find(item => item.kind === 'main').options.callPlan.problems[0].parts[0];
  assert.equal(part.content, 'Here is the layout.\n\nHow would you split this?', 'the lead sits above the screen once, as the first time');
  assert.deepEqual(part.visual, { kind: 'diagram', description: 'Two queues side by side.' });
  await again.service.hangUp();
});

test('saved interviews: one of another job, or a bad id, is refused before anything is drawn; forgetting one is per job', async () => {
  const saved = createSavedInterviewStore({ rootDir: path.join(await mkdtemp(path.join(os.tmpdir(), 'practice-saved-')), 'practice-interviews') });
  const first = await savedPanel(saved);
  await first.service.start(ARGS);
  await first.service.answer();
  await waitFor(async () => (await first.service.listSaved('node-1')).length === 1, 'kept');
  await first.service.hangUp();
  const [kept] = await first.service.listSaved('node-1');
  const other = await savedPanel(saved, { extra: { storeKey: async () => 'posting:other-job' } });
  assert.deepEqual(await other.service.listSaved('node-1'), [], 'another job lists none of them');
  const refused = await other.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.equal(refused.phase, 'error');
  assert.equal(refused.error.code, 'saved-interview-unavailable');
  assert.equal(other.setup.draws.length, 0);
  assert.equal(await other.service.removeSaved('node-1', kept.id), false, 'another job cannot forget it');
  const bad = await savedPanel(saved);
  const invalid = await bad.service.start({ ...ARGS, repeatInterviewId: '../call-1' });
  assert.equal(invalid.phase, 'error');
  assert.equal(invalid.error.code, 'invalid-request');
  assert.equal(await first.service.removeSaved('node-1', kept.id), true);
  assert.deepEqual(await first.service.listSaved('node-1'), []);
});

test('panel: a late timer that fires after the interviewers left does not add anyone', async () => {
  const setup = panelHarness({ late: true });
  const built = await panelStart(setup);
  await built.service.answer();
  const [timer] = setup.clock.lateTimers();
  setup.engineOptions[0].onEvent({ type: 'ended', reason: 'interviewer' });
  // A clock that ignores clearTimeout must still not bring a colleague into an empty room.
  timer.cleared = false;
  setup.clock.fire(timer);
  assert.deepEqual(setup.engineCalls.filter(call => call.startsWith('joined')), []);
  assert.deepEqual(built.service.getState().participants.map(item => [item.id, item.status]), [['A', 'joined']], 'the lead is still leaving');
  const leaving = setup.clock.pending().find(isDeparture);
  setup.clock.setNow(setup.clock.now() + 3000);
  setup.clock.fire(leaving);
  assert.deepEqual(built.service.getState().participants.map(item => [item.id, item.status]), [['A', 'left']]);
});

test('panel: speaker events set speakingId, which clears when the interviewer stops playing', async () => {
  const setup = panelHarness({ random: () => 0.9 });
  const built = await panelStart(setup);
  await built.service.answer();
  const engine = setup.engineOptions[0].onEvent;
  engine({ type: 'phase', phase: 'playing' });
  engine({ type: 'speaker', speakerId: 'A' });
  assert.equal(built.service.getState().speakingId, 'A');
  engine({ type: 'speaker', speakerId: 'B' });
  assert.equal(built.service.getState().speakingId, 'B');
  engine({ type: 'phase', phase: 'listening' });
  assert.equal(built.service.getState().speakingId, null);
  engine({ type: 'speaker', speakerId: 'B' });
  engine({ type: 'ended', reason: 'interviewer' });
  assert.equal(built.service.getState().speakingId, null);
  for (const timer of setup.clock.pending().filter(isDeparture)) setup.clock.fire(timer);
  assert.equal(built.service.getState().participants.every(item => item.status === 'left'), true, 'every participant leaves after the interviewers');
});

test('panel: a caption keeps the speaker id the engine gives it', async () => {
  const setup = panelHarness({ random: () => 0.9 });
  const built = await panelStart(setup);
  await built.service.answer();
  setup.engineOptions[0].onEvent({ type: 'caption', speaker: 'interviewer', speakerId: 'B', text: 'Hello', final: true });
  assert.equal(built.service.getState().captions.at(-1).speakerId, 'B');
});

test('solo: a default call is unchanged and records an empty panel', async () => {
  const built = await startOf({ modelReady: true });
  const state = await built.service.start(ARGS);
  assert.deepEqual(state.participants.map(item => [item.id, item.name, item.status]), [['A', 'Ada Lovelace', 'joined']]);
  assert.equal(state.speakingId, null);
  await built.service.answer();
  await built.service.hangUp();
  const record = await built.deps.store.readRecord('call-1');
  assert.deepEqual(record.panel, []);
  assert.equal(record.persona.voiceId, 'v1');
});

// Measured 2026-11-19 (25 turns of a real call): Haiku at low effort leaked content in about 5 of 25
// reactions, Sonnet at low effort in 0 of 25, at about +0.1 s to the first word. The classifier: 2026-11-20, every
// setting 100% right, Haiku low fastest (p95 770 ms against 2.58 s on Opus low).
test('the acknowledgement session runs on Sonnet at low effort, the reply on Opus and the classifier on Haiku, also after a restart', async () => {
  const made = [];
  let restart;
  const { service } = await liveCall({ deps: {
    sessionsFactory: config => { made.push(config); return { start: async () => ({ reply: 'READY' }), close() {} }; },
    engineFactory: options => { restart = options.restartSession; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.deepEqual(made, [{ model: 'sonnet', effort: 'low' }, { model: 'opus', effort: 'low' }, { model: 'haiku', effort: 'low' }]);
  await restart('opener', {});
  await restart('main', {});
  assert.deepEqual(made.slice(3), [{ model: 'sonnet', effort: 'low' }, { model: 'opus', effort: 'low' }]);
});

test('the cut-in watcher is created only when the app passes watcher: true, on Sonnet at low effort, and the engine gets it', async () => {
  const run = async extra => {
    const made = [];
    const started = [];
    let engineOptions;
    const { service } = await liveCall({ deps: {
      ...extra,
      sessionsFactory: config => { made.push(config); return { start: async options => { started.push(options.instructions); return { reply: 'READY' }; }, close() {} }; },
      prompts: {
        buildOpenerInstructions: () => 'OPENER\nReply only READY now.', buildInterviewerInstructions: () => 'MAIN\nReply only READY now.',
        buildWatcherInstructions: options => `WATCHER${options.history ? ` HISTORY ${options.history}` : ''}\nReply only READY now.`,
      },
      engineFactory: options => { engineOptions = options; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
    } });
    await service.start(ARGS);
    await service.answer();
    return { made, started, engineOptions };
  };
  const off = await run({});
  assert.equal(off.made.length, 3, 'no watcher in the unit suites by default');
  assert.equal('watcher' in off.engineOptions.sessions, false);
  const on = await run({ watcher: true });
  assert.deepEqual(on.made, [{ model: 'sonnet', effort: 'low' }, { model: 'opus', effort: 'low' }, { model: 'haiku', effort: 'low' }, { model: 'sonnet', effort: 'low' }]);
  assert.equal(typeof on.engineOptions.sessions.watcher.start, 'function');
  assert.equal(on.started.includes('WATCHER\nReply only READY now.'), true, 'it starts from its own instructions');
});

test('the watcher restarts like the classifier: its own instructions, the history before the READY line, and the new session is returned', async () => {
  const started = [];
  let restart;
  const { service } = await liveCall({ deps: {
    watcher: true,
    sessionsFactory: () => ({ start: async options => { started.push(options.instructions); }, close() {} }),
    prompts: {
      buildOpenerInstructions: () => 'OPENER\nReply only READY now.', buildInterviewerInstructions: () => 'MAIN\nReply only READY now.',
      buildWatcherInstructions: options => `WATCHER${options.history ? ` HISTORY ${options.history}` : ''}\nReply only READY now.`,
    },
    engineFactory: options => { restart = options.restartSession; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  await service.start(ARGS);
  await service.answer();
  const next = await restart('watcher', { transcriptText: 'Candidate: hi' });
  assert.equal(typeof next.start, 'function', 'the new session itself');
  assert.equal(started.at(-1), 'WATCHER HISTORY Candidate: hi\nReply only READY now.');
  await restart('watcher');
  assert.equal(started.at(-1), 'WATCHER\nReply only READY now.');
});

// Measured 2026-11-19: Opus starts its reply about 2.5 s later than Sonnet but was judged better blind; the reply's
// model is one choice and the default stays Opus.
test('mainModel picks the reply\'s model; the default and anything unknown is Opus', async () => {
  assert.equal(DEFAULT_MAIN_REPLY_MODEL, 'opus');
  for (const [mainModel, want] of [[undefined, 'opus'], ['sonnet', 'sonnet'], ['nonsense', 'opus']]) {
    const made = [];
    const { service } = await liveCall({ deps: {
      ...(mainModel ? { mainModel } : {}),
      sessionsFactory: config => { made.push(config); return { start: async () => ({ reply: 'READY' }), close() {} }; },
      engineFactory: () => ({ start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }),
    } });
    await service.start(ARGS);
    await service.answer();
    assert.deepEqual(made[1], { model: want, effort: 'low' }, String(mainModel));
    assert.deepEqual(MAIN_REPLY_MODELS[want], { model: want, effort: 'low' });
  }
});

// Found 2026-11-19: the raw tracks (60 to 150 MB each for a 30-minute call) stayed for ever when a review failed or
// the app quit during a call or its review, and nothing read them again.
test('leftover raw audio of earlier calls is deleted once a recording exists or nothing can open the call, and rescued into call.m4a otherwise', async () => {
  const tmp = syncFs.mkdtempSync(path.join(os.tmpdir(), 'practice-tidy-'));
  const root = path.join(tmp, 'practice-calls');
  const store = createCallStore({ rootDir: root });
  const put = (id, files) => { syncFs.mkdirSync(path.join(root, id), { recursive: true }); for (const [name, body] of Object.entries(files)) syncFs.writeFileSync(path.join(root, id, name), body); };
  const names = id => syncFs.readdirSync(path.join(root, id)).sort();
  const record = JSON.stringify({ nodeId: 'n', startedAt: 1 });
  put('call-done', { 'call.json': record, 'analysis.json': '{}', 'call.m4a': 'aac', 'candidate.wav': 'pcm', 'interviewer.wav': 'pcm', 'debug.jsonl': '{}' });
  put('call-crashed', { 'candidate.wav': 'pcm', 'interviewer.wav': 'pcm', 'debug.jsonl': '{}' }); // quit mid-call: no record
  put('call-unencoded', { 'call.json': record, 'candidate.wav': 'pcm', 'interviewer.wav': 'pcm' }); // quit during the review
  put('call-mixed', { 'call.json': record, 'call.wav': 'mix' }); // quit between the mix and the encode
  put('call-half', { 'call.json': record, 'candidate.wav': 'pcm' }); // only one track: nothing to mix
  put('call-broken', { 'call.json': record, 'candidate.wav': 'pcm', 'interviewer.wav': 'pcm' });
  const mixed = [];
  const mixdown = async ({ outPath }) => { mixed.push(path.basename(path.dirname(outPath))); syncFs.writeFileSync(outPath, 'mix'); return { durationMs: 1000 }; };
  const afconvert = async args => {
    const out = args.at(-1);
    if (out.includes('call-broken')) throw new Error('afconvert failed');
    syncFs.writeFileSync(out, 'aac');
  };
  const service = createPracticeCallService({ store, userDataPath: tmp, mixdown, afconvert, logger: { warn() {}, info() {} } });
  const { tidied } = await service.tidyLeftoverAudio();
  assert.deepEqual(names('call-done'), ['analysis.json', 'call.json', 'call.m4a', 'debug.jsonl'], 'the record, review, recording and log stay');
  assert.deepEqual(names('call-crashed'), ['debug.jsonl'], 'nothing in the app can open it: only its log is left, to age out with the others');
  assert.deepEqual(names('call-unencoded'), ['call.json', 'call.m4a'], 'mixed and encoded first, then the raw files go');
  assert.deepEqual(names('call-mixed'), ['call.json', 'call.m4a'], 'encoded from the mix that was already there');
  assert.deepEqual(names('call-half'), ['call.json', 'candidate.wav'], 'half a call is left alone');
  assert.deepEqual(names('call-broken'), ['call.json', 'call.wav', 'candidate.wav', 'interviewer.wav'], 'the encode failed: the only copy of the audio stays');
  assert.deepEqual(mixed.sort(), ['call-broken', 'call-unencoded']);
  assert.deepEqual(tidied.map(item => [item.callId, item.rescued]).sort(), [['call-crashed', false], ['call-done', false], ['call-mixed', true], ['call-unencoded', true]]);
});

test('only the newest 10 calls keep their recording: older ones keep record and review, say why, and get no rescue', async () => {
  const tmp = syncFs.mkdtempSync(path.join(os.tmpdir(), 'practice-keep-'));
  const root = path.join(tmp, 'practice-calls');
  const store = createCallStore({ rootDir: root });
  const put = (id, startedAt, files) => {
    syncFs.mkdirSync(path.join(root, id), { recursive: true });
    syncFs.writeFileSync(path.join(root, id, 'call.json'), JSON.stringify({ nodeId: 'n', startedAt, transcript: [] }));
    for (const [name, body] of Object.entries(files)) syncFs.writeFileSync(path.join(root, id, name), body);
  };
  for (let index = 1; index <= 12; index += 1) put(`call-${String(index).padStart(2, '0')}`, index * 1000, { 'call.m4a': 'aac', 'analysis.json': '{"status":"ready"}' });
  put('call-00', 500, { 'candidate.wav': 'pcm', 'interviewer.wav': 'pcm' }); // oldest of all, quit during its review
  const encoded = [];
  const service = createPracticeCallService({ store, userDataPath: tmp, logger: { warn() {}, info() {} },
    mixdown: async ({ outPath }) => { syncFs.writeFileSync(outPath, 'mix'); return { durationMs: 1 }; },
    afconvert: async args => { encoded.push(args.at(-1)); syncFs.writeFileSync(args.at(-1), 'aac'); } });
  const { pruned, tidied } = await service.tidyLeftoverAudio();
  assert.deepEqual(encoded, [], 'a call that will not keep a recording is not rescued first');
  assert.deepEqual(tidied.map(item => [item.callId, item.rescued]), [['call-00', false]]);
  assert.deepEqual(syncFs.readdirSync(path.join(root, 'call-00')).sort(), ['call.json']);
  assert.deepEqual(pruned.map(item => item.callId).sort(), ['call-01', 'call-02']);
  for (const id of ['call-01', 'call-02']) {
    assert.deepEqual(syncFs.readdirSync(path.join(root, id)).sort(), ['analysis.json', 'call.json'], 'record and review stay');
    assert.equal(JSON.parse(syncFs.readFileSync(path.join(root, id, 'call.json'), 'utf8')).recordingPruned, true);
  }
  for (let index = 3; index <= 12; index += 1) assert(syncFs.existsSync(path.join(root, `call-${String(index).padStart(2, '0')}`, 'call.m4a')), 'the newest ten keep theirs');
  const replay = await service.getReplay('call-01');
  assert.equal(replay.audioUrl, null);
  assert.equal(replay.recordingPruned, true);
  assert.equal(replay.recordingsKept, 10);
  assert.equal((await service.getReplay('call-12')).recordingPruned, undefined);
  assert.deepEqual((await service.tidyLeftoverAudio()).pruned, [], 'nothing more to do the second time');
});

test('tidying leftover audio never touches the call that is protected', async () => {
  const tmp = syncFs.mkdtempSync(path.join(os.tmpdir(), 'practice-tidy-'));
  const root = path.join(tmp, 'practice-calls');
  const store = createCallStore({ rootDir: root });
  syncFs.mkdirSync(path.join(root, 'call-live'), { recursive: true });
  syncFs.writeFileSync(path.join(root, 'call-live', 'candidate.wav'), 'pcm');
  assert.deepEqual((await store.leftoverAudio({ protect: 'call-live' })), []);
  assert.deepEqual((await store.leftoverAudio()).map(item => [item.callId, item.hasRecord, item.hasRecording, item.raw.map(entry => entry.name)]), [['call-live', false, false, ['candidate.wav']]]);
  assert.deepEqual(await store.deleteRawAudio('call-live', ['candidate.wav', 'call.json']), { deleted: ['candidate.wav'] }, 'only raw audio names are ever deleted');
});

// Seen in the built app: the lead and her colleague were both called Cohen.
// The app keeps no list of names (owner's request, 2026-11-23: the same few first names came up call after call).
// The planner writes each person's name to fit the voice; a voice is drawn without one.
test('panel: every person carries the name the plan wrote; a drawn voice has none of its own', async () => {
  const setup = panelHarness({ plan: voices => ({ ...soloPlan(voices), lead: { ...soloPlan(voices).lead, name: 'Ingrid Solberg' },
    panel: [{ voice: 'V2', name: '  Tevita   Fonua ', role: 'Engineer', focus: 'x', stability: 0.3, room: 0.2, manner: '', interrupting: 'Rarely.' },
      { voice: 'V3', role: 'Designer', focus: 'y', stability: 0.3, room: 0.2, manner: '', interrupting: 'Rarely.' }] }) });
  // As the real catalog now does: a voice with no name (the third one as on an interview kept from before).
  setup.overrides.catalog = { pickPersonaVoice: options => ({ voiceId: options.voices[0].voiceId, name: options.voices[0].voiceId === 'lib-3' ? 'Kept Before' : '' }) };
  const started = await panelStart(setup);
  assert.equal(setup.planner.calls[0].voices.some(voice => 'name' in voice), false, 'no name reaches the planner with a voice');
  const state = started?.state ?? started;
  assert.equal(state.persona.name, 'Ingrid Solberg');
  assert.equal(state.persona.initials, 'IS');
  // The second colleague's plan has no name (an interview kept from before): the name its voice was drawn with stands.
  assert.deepEqual(setup.built.find(item => item.kind === 'main').options.panel.map(item => item.name), ['Tevita Fonua', 'Kept Before']);
});

test('panel: the planner is told the people of the newest calls, newest first and each once; a colleague the plan leaves nameless fails the start', async () => {
  const setup = panelHarness();
  const started = await startOf({ modelReady: true, deps: setup.overrides });
  const known = typeof started.deps.store.knownCallIds === 'function';
  if (known) {
    await started.deps.store.writeRecord('call-aaaa0001-abc', { persona: { name: 'Dev Rivera' }, panel: [{ name: 'Omar Cohen' }] });
    await started.deps.store.writeRecord('call-aaaa0002-abc', { persona: { name: ' Mei  Tanaka ' }, panel: [{ name: 'dev rivera' }, { name: '' }] });
  }
  await started.service.start(ARGS);
  const recent = setup.planner.calls[0].recentNames;
  if (known) assert.deepEqual(recent, ['Mei Tanaka', 'dev rivera', 'Omar Cohen']);
  else assert.deepEqual(recent, []);
  await started.service.hangUp();

  const nameless = panelHarness({ cast: [{ voice: 'V2', role: 'Engineer', focus: 'x' }] });
  nameless.overrides.catalog = { pickPersonaVoice: options => ({ voiceId: options.voices[0].voiceId, name: options.voices[0].voiceId === 'lib-1' ? 'Nora Lead' : '' }) };
  const { state } = await panelStart(nameless);
  assert.equal(state.phase, 'error', 'nobody joins a call without a name');
});

// A latent fault found in review: the engine adopts whatever restartSession returns as the new
// session. It was handed the whole sessions map, so the turn after any restart had nothing to call.
test('restartSession returns the new session itself, the one the engine will then use', async () => {
  let restart;
  const made = [];
  const { service } = await liveCall({ deps: {
    sessionsFactory: () => { const session = { start: async () => ({ reply: 'READY' }), turn: async () => ({ text: 'ok' }), close() {} }; made.push(session); return session; },
    engineFactory: options => { restart = options.restartSession; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  await service.start(ARGS);
  await service.answer();
  for (const kind of ['main', 'opener', 'classifier']) {
    const next = await restart(kind, { transcriptText: 'Candidate: hi' });
    assert.equal(next, made.at(-1), `${kind}: the returned value is the session just started`);
    assert.equal(typeof next.turn, 'function');
  }
});

// A chosen colleague whose voice will not warm up is left off the call. The lead's session was started
// with them in the cast and would hand over to someone who cannot speak, so a fresh one replaces it.
test('panel: when a chosen colleague cannot speak, a fresh lead starts from the cast as it now is and their questions pass to the lead', async () => {
  const setup = panelHarness({ silent: ['lib-2'], plan: drawn => soloPlan(drawn, {
    panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
    questions: [{ number: 1, askedBy: 'V1', minutes: 5, probes: [] }, { number: 2, askedBy: 'V2', minutes: 5, probes: ['a vague number'] }],
  }) });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const { state, service, deps } = await panelStart(setup);
  assert.equal(state.phase, 'ringing');
  const mains = setup.built.filter(item => item.kind === 'main');
  assert.equal(setup.starts.length, 5, 'the three sessions, then a fresh lead and a fresh acknowledgement session');
  assert.deepEqual(mains[0].options.callPlan.questions.map(item => [item.number, item.askedBy]), [[1, 'A'], [2, 'B']], 'the first lead session was given the colleague');
  assert.deepEqual(mains.at(-1).options.panel, [], 'the replacement is built with nobody else on the call');
  assert.deepEqual(mains.at(-1).options.callPlan.people.map(item => item.id), ['A']);
  assert.deepEqual(mains.at(-1).options.callPlan.questions.map(item => [item.number, item.askedBy]), [[1, 'A'], [2, 'A']], 'their question is the lead\'s now');
  assert.equal('colleagues' in mains.at(-1).options, false);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.panel, []);
  const dropped = record.setup.voices.find(voice => voice.key === 'V2');
  assert.deepEqual([dropped.used, dropped.dropped, dropped.id], [false, true, null], 'the record says the drawn voice was not used');
});

test('panel: a replacement session that fails to start is closed and does not stay running', async () => {
  const setup = panelHarness({ silent: ['lib-2'], plan: drawn => soloPlan(drawn, {
    panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
    questions: [{ number: 1, askedBy: 'V1', minutes: 5, probes: [] }, { number: 2, askedBy: 'V2', minutes: 5, probes: ['a vague number'] }],
  }) });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const sessions = [];
  setup.overrides.sessionsFactory = () => {
    const at = sessions.length;
    const session = { closed: 0, start: async () => { if (at === 4) throw new Error('replacement failed to start'); return { reply: 'READY' }; }, close() { session.closed += 1; } };
    sessions.push(session);
    return session;
  };
  const { state } = await panelStart(setup);
  assert.notEqual(state.phase, 'ringing');
  assert.equal(sessions.length, 5, 'the three sessions, a fresh lead and the replacement that failed');
  assert.equal(sessions[4].closed, 1, 'the replacement that failed to start was closed');
});

test('closing the warm sessions calls only the first of close, cancel and stop that a session has', async () => {
  const calls = [];
  const { service } = await liveCall({ deps: {
    sessionsFactory: () => ({ start: async () => ({ reply: 'READY' }), close() { calls.push('close'); }, cancel() { calls.push('cancel'); }, stop() { calls.push('stop'); } }),
  } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.equal(calls.length > 0, true);
  assert.equal(calls.every(name => name === 'close'), true, `only close is called, got ${calls.join(',')}`);
});

// Quitting the app (or asking again) while a call is already being saved must wait for that save.
test('hanging up again while the call is being finished waits for the same finish', async () => {
  let releaseMix;
  const { service, deps } = await liveCall({ deps: { mixdown: () => new Promise(resolve => { releaseMix = () => resolve({ durationMs: 4000 }); }) } });
  await service.start(ARGS);
  await service.answer();
  const first = service.hangUp({ feedback: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  let secondDone = false;
  const second = service.hangUp({ feedback: false }).then(state => { secondDone = true; return state; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(secondDone, false, 'the second call is still waiting on the first');
  releaseMix();
  assert.equal((await first).phase, 'replay');
  assert.equal((await second).phase, 'replay');
  assert.ok(await deps.store.readRecord('call-1'));
});

// The owner's rule (2026-11-17): no built-in ElevenLabs voice is ever an interviewer. The pool is
// the shared library, but four built-in voices are also published there under the same names.
test('every voice draw skips the built-in voices by id and by name, for the lead and for colleagues', async () => {
  const setup = panelHarness();
  setup.overrides.voiceLibrary.listBuiltInVoices = async () => ({ voiceIds: ['premade-1'], names: ['brian - deep, resonant and comforting'] });
  await panelStart(setup);
  assert.ok(setup.draws.length >= 2, 'the lead and at least one colleague were drawn');
  for (const draw of setup.draws) {
    assert.ok(draw.excludeVoiceIds.includes('premade-1'));
    assert.deepEqual(draw.excludeNames, ['brian - deep, resonant and comforting']);
  }

  // The list being unreadable does not cost the call its voice.
  const offline = panelHarness();
  offline.overrides.voiceLibrary.listBuiltInVoices = async () => { throw new Error('offline'); };
  const { state } = await panelStart(offline);
  assert.equal(state.phase, 'ringing');
});

test('stability: the plan\'s numbers reach the lead\'s and each colleague\'s voice and the record', async () => {
  const setup = panelHarness({ random: () => 0.9, plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, stability: 0.45 },
    panel: [{ voice: 'V2', role: 'Senior Engineer', focus: 'api', stability: 0.55, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
  }) });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.equal(factories.A.options.stability, 0.45, 'the lead');
  assert.equal(factories.A.options.voiceId, 'lib-1');
  assert.equal(factories.B.options.stability, 0.55, 'the colleague');
  assert.equal(factories.B.options.voiceId, 'lib-2');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.stability, 0.45);
  assert.equal(record.persona.stabilityFrom, 'plan');
  assert.equal(record.panel[0].stability, 0.55);
});

test('stability: a lead or colleague with no usable number falls back to the default, and a fixed temperament still takes the plan\'s number', async () => {
  const setup = panelHarness({ random: () => 0.9, plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, stability: null },
    panel: [{ voice: 'V2', role: 'Engineer', focus: '', stability: Number.NaN, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
  }) });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.equal(factories.A.options.stability, 0.3);
  assert.equal(factories.B.options.stability, 0.3);
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.stabilityFrom, 'fallback');
  assert.equal(record.panel[0].stability, 0.3);

  const harness = voiceHarness({ audio: true });
  const loadBrief = async args => {
    const loaded = await makeDeps({ tmp: '/unused' }).deps.loadBrief(args);
    return { ...loaded, practice: { temperament: 'tough' } };
  };
  const fixed = await startOf({ deps: {
    loadBrief, voiceFactory: harness.make,
    planCall: fakePlanner(voices => soloPlan(voices, { lead: { ...soloPlan(voices).lead, stability: 0.5 } })),
  } });
  await fixed.service.start({ ...ARGS });
  assert.equal(harness.factories.at(-1).options.stability, 0.5);
  await fixed.service.answer();
  await fixed.service.hangUp();
  const kept = (await fixed.deps.store.readRecord('call-1')).persona;
  assert.deepEqual([kept.stabilityFrom, kept.temperament, kept.temperamentFrom], ['plan', 'tough', 'request']);
});

// --- the lead's own role, the picked questions and the question history ----------

/** A prompt module that records every build. */
function recordingPrompts() {
  const built = [];
  return {
    built,
    prompts: {
      buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
      buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
    },
  };
}
const PLAN_CARDS = [
  { id: 'q1', question: 'Tell me about a launch.', answer: 'I led one.' },
  { id: 'q2', question: 'Describe a conflict.', answer: 'We talked.' },
  { id: 'q3', question: 'Why this team?', answer: 'The mission.' },
];
const askedEngine = asked => options => ({
  start() { options.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, helperEvent() {}, typed() {},
  state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000, ...(asked === undefined ? {} : { askedQuestions: asked }) }),
});

test('role: the lead\'s own role and the picked questions come from the plan on every path, never random', async () => {
  const fixedTemperament = async args => ({ ...(await makeDeps({ tmp: '/unused' }).deps.loadBrief(args)), practice: { temperament: 'tough' } });
  for (const [label, extra] of [['planned temperament', {}], ['fixed temperament', { loadBrief: fixedTemperament }]]) {
    const harness = recordingPrompts();
    const planner = fakePlanner(voices => soloPlan(voices, {
      lead: { ...soloPlan(voices).lead, role: 'Staff Engineer' },
      questions: [{ number: 2, askedBy: voices[0].key, minutes: 6, probes: [] }, { number: 1, askedBy: voices[0].key, minutes: 4, probes: [] }],
    }));
    const { service, deps } = await startOf({ deps: { prompts: harness.prompts, planCall: planner, loadCards: async () => PLAN_CARDS, ...extra } });
    const states = [];
    service.onState(item => states.push(item));
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'ringing', label);
    assert.equal(state.persona.role, 'Staff Engineer', label);
    assert.equal(state.participants[0].role, 'Staff Engineer', label);
    assert.deepEqual(planner.calls[0].pool.map(item => [item.number, item.question, item.timesAsked]), [
      [1, 'Tell me about a launch.', 0], [2, 'Describe a conflict.', 0], [3, 'Why this team?', 0],
    ], `${label}: the planner is given the whole prepared pool by number`);
    assert.equal(harness.built.length, 2, `${label}: each prompt is built once`);
    for (const item of harness.built) {
      assert.equal(item.options.persona.role, 'Staff Engineer', `${label}: ${item.kind} knows the role at its first build`);
      assert.deepEqual(item.options.picked, [2, 1], label);
    }
    assert.equal(states.filter(item => item.phase === 'ringing').every(item => item.persona.role === 'Staff Engineer'), true, `${label}: never rings with an empty role`);
    await service.answer();
    await service.hangUp({ feedback: false });
    const record = await deps.store.readRecord('call-1');
    assert.equal(record.persona.role, 'Staff Engineer', label);
    assert.deepEqual(record.pickedQuestions, [2, 1], label);
    assert.equal((await service.getReplay('call-1')).persona.role, 'Staff Engineer', label);
  }
});

test('role: the settled role, picked questions and plan reach restart prompts, the acknowledgement session included', async () => {
  const setup = panelHarness({ plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, role: 'Engineering Director' },
    panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
    questions: [{ number: 3, askedBy: 'V1', minutes: 6, probes: ['the missing result'] }, { number: 1, askedBy: 'V2', minutes: 4, probes: [] }],
    problems: [{ ref: 'p1', question: 1, language: 'javascript', parts: [{ title: 'Task', content: 'Reverse a list.' }], solution: 'return list.reverse();', edgeCases: ['empty list'], hints: ['think about order'] }],
  }) });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  let restart;
  const inner = setup.overrides.engineFactory;
  setup.overrides.engineFactory = options => { restart = options.restartSession; return inner(options); };
  const { service } = await panelStart(setup);
  await service.answer();
  await restart('main', { transcriptText: 'earlier talk' });
  const again = setup.built.filter(item => item.kind === 'main').at(-1);
  assert.equal(again.options.persona.role, 'Engineering Director');
  assert.deepEqual(again.options.picked, [3, 1]);
  assert.equal(again.options.history, 'earlier talk');
  assert.equal(again.options.callPlan.interviewKind, 'A short screening conversation.');
  assert.deepEqual(again.options.callPlan.questions.map(item => [item.number, item.askedBy, item.probes]), [[3, 'A', ['the missing result']], [1, 'B', []]]);
  assert.deepEqual(again.options.callPlan.problems.map(item => [item.ref, item.solution, item.hints]), [['p1', 'return list.reverse();', ['think about order']]], 'the private problem notes ride along');
  await restart('opener', { transcriptText: 'earlier talk' });
  const opener = setup.built.filter(item => item.kind === 'opener').at(-1);
  assert.deepEqual(opener.options.picked, [3, 1]);
  assert.equal(opener.options.callPlan.people[1].name, 'Ben Specialist');
});

test('pad: the pad names a language only when a prepared problem requires it', async () => {
  const labelFor = async (language, written) => {
    const setup = panelHarness({ plan: drawn => soloPlan(drawn, {
      problems: [{ ref: 'p1', question: 1, language, parts: [{ title: 'Task', content: 'Reverse a list.' }], solution: 'Reverse it.', edgeCases: [], hints: [] }],
    }) });
    setup.overrides.loadCards = async () => PLAN_CARDS;
    const { service } = await panelStart(setup);
    await service.answer();
    setup.engineOptions[0].onEvent({ type: 'pad', open: true, lang: written, atMs: 100 });
    const lang = service.getState().pad.lang;
    await service.hangUp();
    return lang;
  };
  assert.equal(await labelFor('', 'python'), '', 'any language is fine, so the pad names none');
  assert.equal(await labelFor('javascript', 'JavaScript'), 'javascript', 'a required language is shown');
  assert.equal(await labelFor('javascript', 'python'), 'javascript', 'a label naming another language shows the one the problem requires');
  assert.equal(await labelFor('JavaScript', 'JS'), 'JavaScript', 'a short name stands for the required language, shown by its own name');
  assert.equal(await labelFor('C++', 'cpp'), 'C++');
  assert.equal(await labelFor('', 'Java'), '');
  assert.equal(await labelFor('', ''), '');
});

test('pad: a label is matched to the plan\'s language names without any table of nicknames', async () => {
  const labelAmong = async (languages, written) => {
    const setup = panelHarness({ plan: drawn => soloPlan(drawn, {
      problems: languages.map((language, at) => ({ ref: `p${at + 1}`, question: 1, language, parts: [{ title: `Task ${at}`, content: 'Reverse a list.' }], solution: 'Reverse it.', edgeCases: [], hints: [] })),
    }) });
    const { service } = await panelStart(setup);
    await service.answer();
    setup.engineOptions[0].onEvent({ type: 'pad', open: true, lang: written, atMs: 100 });
    const lang = service.getState().pad.lang;
    await service.hangUp();
    return lang;
  };
  // Two languages are required, so a label has to name one: the same name (case, spaces and dots aside) does.
  assert.equal(await labelAmong(['JavaScript', 'Python'], 'javascript'), 'JavaScript');
  assert.equal(await labelAmong(['JavaScript', 'Python'], ' Java Script '), 'JavaScript');
  assert.equal(await labelAmong(['Node.js', 'Python'], 'nodejs'), 'Node.js');
  // A nickname is not known to the app: it names nothing here, and with two required languages the pad shows none.
  assert.equal(await labelAmong(['JavaScript', 'Python'], 'JS'), '');
  assert.equal(await labelAmong(['C++', 'Python'], 'cpp'), '');
  assert.equal(await labelAmong(['Go', 'Python'], 'golang'), '');
  assert.equal(await labelAmong(['Python', 'Rust'], 'py'), '');
  // One required language still stands for whatever label names no other, as before.
  assert.equal(await labelAmong(['JavaScript'], 'JS'), 'JavaScript');
});

test('pad: an exercise that leaves the language open offers none and takes no pick; offered languages are whatever the plan wrote', async () => {
  const setup = panelHarness({ plan: drawn => soloPlan(drawn, {
    problems: [{ ref: 'p1', question: 1, language: '', parts: [{ title: 'Task', content: 'Reverse a list.' }], solution: 'Reverse it.', edgeCases: [], hints: [] }],
  }) });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const { service, deps } = await panelStart(setup);
  await service.answer();
  setup.engineOptions[0].onEvent({ type: 'pad', open: true, lang: '', atMs: 100 });
  assert.deepEqual([service.getState().pad.options, service.getState().pad.choice], [[], ''], 'nothing is offered and nothing is picked');
  assert.equal(service.setPadLanguage('Go').pad.choice, '', 'no list of its own to pick from');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal('chosen' in record.pad, false);
  assert.equal(record.pad.lang, '');
  // Names no list could hold are offered as the plan wrote them, and the pad starts on the first.
  const obscure = panelHarness({ plan: drawn => soloPlan(drawn, {
    problems: [{ ref: 'p1', question: 1, language: '', languages: ['Eiffel', 'Ada 2012', ' eiffel ', 7], parts: [{ title: 'Task', content: 'Reverse a list.' }], solution: 'Reverse it.', edgeCases: [], hints: [] }],
  }) });
  obscure.overrides.loadCards = async () => PLAN_CARDS;
  const second = await panelStart(obscure);
  await second.service.answer();
  obscure.engineOptions[0].onEvent({ type: 'pad', open: true, lang: '', atMs: 100 });
  assert.deepEqual([second.service.getState().pad.options, second.service.getState().pad.choice], [['Eiffel', 'Ada 2012'], 'Eiffel'], 'as written, each once, starting on the first');
  assert.equal(second.service.setPadLanguage('ada 2012').pad.choice, 'Ada 2012', 'by its offered name');
  assert.equal(second.service.setPadLanguage('Python').pad.choice, 'Ada 2012', 'only an offered language');
  await second.service.hangUp();
  assert.equal((await second.deps.store.readRecord('call-1')).pad.chosen, 'Ada 2012');
});

test('pad: an exercise that allows several languages offers only those, and takes a pick only among them', async () => {
  const problem = (ref, question, extra) => ({ ref, question, language: '', parts: [{ title: `Task ${ref}`, content: `Do ${ref}.` }], solution: 'Do it.', edgeCases: [], hints: [], ...extra });
  const setup = panelHarness({ plan: drawn => soloPlan(drawn, { problems: [problem('p1', 1, { languages: ['C', 'C++'] }), problem('p2', 1, {})] }) });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const emit = setup.engineOptions[0].onEvent;
  emit({ type: 'pad', open: true, lang: 'C', atMs: 100 });
  assert.deepEqual([service.getState().pad.lang, service.getState().pad.options], ['', []], 'two problems and none shown yet: no label, nothing offered');
  assert.equal(service.setPadLanguage('Python').pad.choice, '', 'nothing offered, nothing picked');
  emit({ type: 'screen', title: 'Task p1', content: 'Do p1.', speakerId: 'A', atMs: 200 });
  assert.deepEqual(service.getState().pad.options, ['C', 'C++'], 'the problem on screen allows two');
  assert.equal(service.getState().pad.choice, 'C', 'the pad starts on the first offered');
  assert.equal(service.setPadLanguage('Python').pad.choice, 'C', 'only an offered language');
  assert.equal(service.setPadLanguage('c++').pad.choice, 'C++');
  emit({ type: 'screen-stop', atMs: 300 });
  assert.deepEqual(service.getState().pad.options, ['C', 'C++'], 'the pad outlives its screen');
  // A part shown with a picture's lead line above it (the prepared text, not the plan's) still names its problem.
  emit({ type: 'screen', title: 'Task p2', content: 'Do p2.', speakerId: 'A', atMs: 320 });
  assert.deepEqual(service.getState().pad.options, []);
  setup.engineOptions[0].prepared.p1.parts[0].content = 'Look at the diagram.\n\nDo p1.';
  emit({ type: 'screen', title: 'Task p1', content: 'Look at the diagram.\n\nDo p1.', speakerId: 'A', atMs: 340 });
  assert.deepEqual(service.getState().pad.options, ['C', 'C++'], 'matched by the text as shown');
  emit({ type: 'screen', title: 'Task p2', content: 'Do p2.', speakerId: 'A', atMs: 400 });
  assert.deepEqual([service.getState().pad.options, service.getState().pad.choice], [[], ''], 'an open exercise offers none and has no pick');
  // A screen the interviewer wrote while the pad is open is taken as part of the same exercise: the limit stays.
  emit({ type: 'screen', title: 'Task p1', content: 'Do p1.', speakerId: 'A', atMs: 500 });
  emit({ type: 'screen', title: 'Follow-up', content: 'Now make it reentrant.', speakerId: 'A', atMs: 520 });
  assert.deepEqual([service.getState().pad.options, service.getState().pad.choice], [['C', 'C++'], 'C++'], 'a follow-up screen keeps the limit, and the candidate\'s own pick comes back with it');
  // Opening the open pad again with a screen of the interviewer's own starts a new exercise, whichever tag came first.
  emit({ type: 'pad', open: true, lang: '', atMs: 522 });
  assert.deepEqual(service.getState().pad.options, [], 'reopened for the interviewer\'s own screen');
  emit({ type: 'screen', title: 'Task p1', content: 'Do p1.', speakerId: 'A', atMs: 524 });
  emit({ type: 'pad', open: true, lang: '', atMs: 526 });
  assert.deepEqual(service.getState().pad.options, ['C', 'C++'], 'reopened on the prepared exercise: still limited');
  emit({ type: 'screen', title: 'Own exercise', content: 'Parse a date.', speakerId: 'A', atMs: 528 });
  assert.deepEqual(service.getState().pad.options, [], 'the screen right after a reopen is the new exercise');
  // Moving on to another planned question ends the exercise too: a screen of their own after it is not a follow-up.
  emit({ type: 'screen', title: 'Task p1', content: 'Do p1.', speakerId: 'A', atMs: 530 });
  setup.clock.setNow(setup.clock.now() + 5000);
  emit({ type: 'screen-stop', atMs: 532 });
  emit({ type: 'question-asked', kind: 'question-asked', number: 3 });
  assert.deepEqual(service.getState().pad.options, [], 'another planned question was asked');
  emit({ type: 'screen', title: 'A sketch', content: 'Draw the flow.', speakerId: 'A', atMs: 534 });
  assert.deepEqual(service.getState().pad.options, []);
  emit({ type: 'screen', title: 'Task p1', content: 'Do p1.', speakerId: 'A', atMs: 536 });
  emit({ type: 'screen', title: 'Follow-up', content: 'Now make it reentrant.', speakerId: 'A', atMs: 538 });
  assert.deepEqual(service.getState().pad.options, ['C', 'C++']);
  // Closing the pad ends the exercise: a pad opened for a screen of the interviewer's own offers none.
  emit({ type: 'pad', open: false, atMs: 540 });
  emit({ type: 'screen', title: 'Something else', content: 'Sketch a parser.', speakerId: 'A', atMs: 560 });
  emit({ type: 'pad', open: true, lang: '', atMs: 580 });
  assert.deepEqual(service.getState().pad.options, [], 'a new exercise of the interviewer\'s own is not limited');
  // And a prepared exercise that is still on screen when the pad is reopened limits it again.
  emit({ type: 'pad', open: false, atMs: 600 });
  emit({ type: 'screen', title: 'Task p1', content: 'Do p1.', speakerId: 'A', atMs: 620 });
  emit({ type: 'pad', open: true, lang: '', atMs: 640 });
  assert.deepEqual(service.getState().pad.options, ['C', 'C++']);
  // An exercise of the interviewer's own names no language, and the record no longer carries the earlier pick.
  emit({ type: 'pad', open: false, atMs: 660 });
  emit({ type: 'screen', title: 'Last one', content: 'Sketch a cache.', speakerId: 'A', atMs: 680 });
  emit({ type: 'pad', open: true, lang: '', atMs: 700 });
  assert.deepEqual([service.getState().pad.options, service.getState().pad.choice], [[], '']);
  emit({ type: 'screen', title: 'Task p1', content: 'Do p1.', speakerId: 'A', atMs: 720 });
  assert.equal(service.getState().pad.choice, 'C++', 'the candidate\'s own pick, not the first offered');
  await service.hangUp();
  assert.equal((await deps.store.readRecord('call-1')).pad.chosen, 'C++');
});

test('history: timesAsked reaches the prompt options and a failing read never stops the call', async () => {
  const history = memoryHistory({ 'node-1': { q1: 2, q3: 1 } });
  const harness = recordingPrompts();
  const { service } = await startOf({ deps: { prompts: harness.prompts, loadCards: async () => PLAN_CARDS, questionHistory: history } });
  await service.start(ARGS);
  assert.deepEqual(harness.built.find(item => item.kind === 'main').options.plan.map(item => item.timesAsked), [2, 0, 1]);

  const warnings = [];
  const broken = { counts: async () => { throw new Error('disk gone'); }, record: async () => { throw new Error('disk gone'); } };
  const second = recordingPrompts();
  const failing = await startOf({ deps: { prompts: second.prompts, loadCards: async () => PLAN_CARDS, questionHistory: broken, logger: { warn: message => warnings.push(message) } } });
  const state = await failing.service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(second.built.find(item => item.kind === 'main').options.plan.map(item => item.timesAsked), [0, 0, 0]);
  assert.equal(warnings.some(text => text.includes('question history unavailable')), true);
  await failing.service.answer();
  const ended = await failing.service.hangUp({ feedback: false });
  assert.equal(ended.phase, 'replay', 'a history write failure does not fail the hang-up');
});

test('history: asked questions are recorded at hang-up with or without feedback, and not for an unanswered call', async () => {
  for (const feedback of [true, false]) {
    const history = memoryHistory();
    const { service, deps } = await startOf({ deps: { loadCards: async () => PLAN_CARDS, questionHistory: history, engineFactory: askedEngine([3, 1]) } });
    await service.start(ARGS);
    await service.answer();
    await service.hangUp({ feedback });
    assert.deepEqual(history.recorded, [{ nodeId: 'node-1', ids: ['q3', 'q1'] }], `feedback ${feedback}`);
    const record = await deps.store.readRecord('call-1');
    assert.deepEqual(record.askedQuestions, [3, 1]);
    assert.deepEqual(record.askedQuestionIds, ['q3', 'q1']);
  }
  // An engine that does not report the list yet reads as nothing asked, and records nothing.
  const quiet = memoryHistory();
  const old = await startOf({ deps: { loadCards: async () => PLAN_CARDS, questionHistory: quiet, engineFactory: askedEngine(undefined) } });
  await old.service.start(ARGS);
  await old.service.answer();
  await old.service.hangUp({ feedback: false });
  assert.deepEqual(quiet.recorded, []);
  assert.deepEqual((await old.deps.store.readRecord('call-1')).askedQuestions, []);

  const never = memoryHistory();
  const declined = await startOf({ deps: { loadCards: async () => PLAN_CARDS, questionHistory: never, engineFactory: askedEngine([1]) } });
  await declined.service.start(ARGS);
  await declined.service.hangUp();
  assert.deepEqual(never.recorded, [], 'a call that was never answered records nothing');
});

test('question history store: counts, atomic save, tolerant load and a bound of 200 jobs', async () => {
  const { createQuestionHistory } = await import('../../electron/practiceCall/questionHistory.js');
  const files = new Map();
  const modes = [];
  const memFs = {
    async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    async mkdir() {},
    async writeFile(file, data, options) { modes.push({ file, mode: options?.mode }); files.set(file, data); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const file = '/mem/history.json';
  const history = createQuestionHistory({ filePath: file, fs: memFs });
  assert.deepEqual(await history.counts('job-a'), {}, 'a missing file reads as empty');
  await history.record('job-a', ['q1', 'q2', 'q1']);
  await history.record('job-a', ['q1']);
  assert.deepEqual(await history.counts('job-a'), { q1: 2, q2: 1 }, 'one per distinct id per call');
  assert.deepEqual(await history.counts('job-b'), {});
  assert.equal(modes.every(item => item.mode === 0o600 && item.file !== file), true, 'written to a temp file with mode 0600, then renamed');
  assert.deepEqual([...files.keys()], [file], 'no temp file is left behind');
  files.set(file, '{not json');
  assert.deepEqual(await history.counts('job-a'), {}, 'a malformed file reads as empty');
  files.set(file, JSON.stringify({ version: 1, jobs: { 'job-a': { counts: { q1: 'x', q2: 3, q3: -1 }, updatedAt: 1 } } }));
  assert.deepEqual(await history.counts('job-a'), { q2: 3 }, 'bad counts are dropped');
  files.delete(file);
  for (let at = 0; at < 205; at += 1) await history.record(`job-${at}`, ['q1']);
  assert.equal(Object.keys(JSON.parse(files.get(file)).jobs).length, 200);
  assert.deepEqual(await history.counts('job-0'), {}, 'the least recently updated job was dropped');
  assert.deepEqual(await history.counts('job-204'), { q1: 1 });
  await history.record('job-5', ['q9']);
  assert.deepEqual(await history.counts('job-5'), { q1: 1, q9: 1 }, 'an update keeps its job as the most recent one');
});

test('question history store: notes round trip with their caps, a 300-character cut, duplicate refresh, adopt and tolerant load', async () => {
  const { createQuestionHistory } = await import('../../electron/practiceCall/questionHistory.js');
  const files = new Map();
  const memFs = {
    async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    async mkdir() {},
    async writeFile(file, data) { files.set(file, data); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const file = '/mem/notes.json';
  const history = createQuestionHistory({ filePath: file, fs: memFs });
  // An old file (counts only) reads, with no notes.
  files.set(file, JSON.stringify({ version: 1, jobs: { old: { counts: { q1: 2 }, updatedAt: 5 } } }));
  assert.deepEqual(await history.notes('old'), { asked: {}, own: [] });
  assert.deepEqual(await history.counts('old'), { q1: 2 });
  await history.record('old', ['q1']);
  assert.deepEqual(await history.counts('old'), { q1: 3 }, 'two arguments work as before');
  // Round trip, oldest first; a note never makes counts report its id.
  await history.record('job', [], { asked: { t1: 'First   exercise' }, own: 'An own question' });
  assert.deepEqual(await history.counts('job'), {}, 'notes add no count');
  assert.deepEqual(await history.notes('job'), { asked: { t1: ['First exercise'] }, own: ['An own question'] });
  await history.record('job', ['t1'], { asked: { t1: 'Second' } });
  assert.deepEqual([await history.counts('job'), (await history.notes('job')).asked.t1], [{ t1: 1 }, ['First exercise', 'Second']]);
  // A repeat (case and spacing aside) is stored once and becomes the newest.
  await history.record('job', [], { asked: { t1: 'first EXERCISE' }, own: 'an  own question' });
  assert.deepEqual(await history.notes('job'), { asked: { t1: ['Second', 'first EXERCISE'] }, own: ['an own question'] });
  // Caps: five per id, eight own questions.
  for (let at = 0; at < 7; at += 1) await history.record('job', [], { asked: { t1: `ex ${at}` }, own: `own ${at}` });
  const capped = await history.notes('job');
  assert.deepEqual(capped.asked.t1, ['ex 2', 'ex 3', 'ex 4', 'ex 5', 'ex 6']);
  assert.deepEqual(capped.own, ['an own question', 'own 0', 'own 1', 'own 2', 'own 3', 'own 4', 'own 5', 'own 6']);
  for (let at = 7; at < 11; at += 1) await history.record('job', [], { own: `own ${at}` });
  assert.equal((await history.notes('job')).own.length, 8);
  assert.equal((await history.notes('job')).own[0], 'own 3');
  // One line of at most 300 characters, cut at a word end.
  await history.record('long', [], { own: `${'word '.repeat(100)}\n${'x'.repeat(50)}` });
  const [cut] = (await history.notes('long')).own;
  assert.equal(cut.length <= 300 && !cut.includes('\n') && cut.endsWith('word'), true);
  // Adopt copies the notes with the counts.
  await history.record('from', ['q1'], { asked: { t1: 'kept' }, own: 'mine' });
  assert.equal(await history.adopt('from', 'to'), true);
  assert.deepEqual(await history.notes('to'), { asked: { t1: ['kept'] }, own: ['mine'] });
  // Notes alone are carried too (a call that asked only the planner's own question leaves no count).
  await history.record('bare', [], { own: 'only mine' });
  assert.equal(await history.adopt('bare', 'bare-to'), true);
  assert.deepEqual(await history.notes('bare-to'), { asked: {}, own: ['only mine'] });
  // A cut never leaves half of a surrogate pair.
  await history.record('pair', [], { own: `${'a'.repeat(299)}\u{1F600}` });
  assert.equal((await history.notes('pair')).own[0], 'a'.repeat(299));
  // Malformed notes are dropped without failing the load.
  files.set(file, JSON.stringify({ version: 1, jobs: { bad: { counts: { q1: 1 }, asked: { t1: 'text', t2: [{ text: 4 }, { at: 1 }, null, { text: 'ok', at: 'x' }], '': ['no id'] }, own: 'nope', updatedAt: 1 }, bad2: { counts: {}, asked: [1], own: [7, { text: '' }, { text: 'fine' }], updatedAt: 2 } } }));
  assert.deepEqual(await history.notes('bad'), { asked: { t2: ['ok'] }, own: [] });
  assert.deepEqual(await history.notes('bad2'), { asked: {}, own: ['fine'] });
  assert.deepEqual(await history.counts('bad'), { q1: 1 });
});

// The shared screen and the coding pad: published state, forwarding to the engine, and the saved record.
function padEngine(log, state = { transcript: [], elapsedMs: 5000 }) {
  const box = {};
  box.factory = options => {
    box.emit = options.onEvent;
    return {
      start() {}, hangUp() {}, typed() {}, state: () => state,
      setPadText: text => log.push(['setPadText', text]),
    };
  };
  return box;
}

test('the shared screen and the pad appear in the published state with the presenter name', async () => {
  const log = [];
  const box = padEngine(log);
  const { service } = await liveCall({ deps: { engineFactory: box.factory } });
  await service.start(ARGS);
  await service.answer();
  const first = service.getState();
  assert.equal(first.screen, null);
  assert.deepEqual(first.pad, { open: false, lang: '', text: '', choice: '', options: [] });
  box.emit({ type: 'screen', title: 'Two sum', content: 'Find a pair.', speakerId: 'A', atMs: 1000 });
  const shown = service.getState().screen;
  assert.deepEqual({ title: shown.title, content: shown.content, speakerId: shown.speakerId }, { title: 'Two sum', content: 'Find a pair.', speakerId: 'A' });
  assert.equal(typeof shown.presenterName, 'string');
  assert.ok(shown.presenterName.length > 0, 'the lead is named');
  box.emit({ type: 'pad', open: true, lang: 'python', atMs: 1100 });
  assert.deepEqual(service.getState().pad, { open: true, lang: 'python', text: '', choice: '', options: [] });
  box.emit({ type: 'screen-stop', atMs: 2000 });
  assert.equal(service.getState().screen, null);
  box.emit({ type: 'pad', open: false, atMs: 2100 });
  assert.equal(service.getState().pad.open, false);
});

test('updatePad stores and forwards text without publishing, and is ignored when closed, absent or after the interviewer left', async () => {
  const log = [];
  const box = padEngine(log);
  const { service } = await liveCall({ deps: { engineFactory: box.factory } });
  assert.doesNotThrow(() => service.updatePad('nobody'), 'ignored with no call');
  await service.start(ARGS);
  await service.answer();
  service.updatePad('closed pad');
  assert.deepEqual(log, [], 'a closed pad forwards nothing');
  box.emit({ type: 'pad', open: true, lang: 'js' });
  let published = 0;
  service.onState(() => { published += 1; });
  service.updatePad('x = 1');
  assert.equal(published, 0, 'typing never publishes to listeners');
  assert.equal(service.getState().pad.text, 'x = 1');
  service.updatePad('y'.repeat(30000));
  assert.equal(service.getState().pad.text.length, 20000);
  service.updatePad('x = 2');
  assert.deepEqual(log.slice(-1), [['setPadText', 'x = 2']]);
  assert.equal(service.submitPad, undefined, 'there is no Ready: the interviewer watches the pad');
  const before = log.length;
  box.emit({ type: 'ended', reason: 'interviewer' });
  service.updatePad('late');
  assert.equal(log.length, before, 'nothing after the interviewer left');
});

test('the record holds screens and pad snapshots on the call clock, closed at replacement, stop and hang-up', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const log = [];
  const box = padEngine(log, { transcript: [{ speaker: 'candidate', text: 'Hi.', startMs: 6000, endMs: 8000 }], elapsedMs: 5000 });
  const { service, deps } = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: box.factory } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  box.emit({ type: 'screen', title: 'One', content: 'First part.', speakerId: 'A', atMs: 5000 });
  box.emit({ type: 'pad', open: true, lang: 'python', atMs: 5100 });
  box.emit({ type: 'screen', title: 'Two', content: 'Second part.', speakerId: 'A', atMs: 7000 });
  service.updatePad('def f(): pass');
  service.sendChat('done');
  service.sendChat('again');
  service.updatePad('def f(): return 1');
  box.emit({ type: 'pad-sent', atMs: 9000, text: 'def f(' }); // older than the pad is now
  box.emit({ type: 'pad', open: false, atMs: 9500 });
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.timings.setupLeadMs, 4000);
  assert.deepEqual(record.screens.map(item => [item.title, item.atMs, item.endMs]), [['One', 1000, 3000], ['Two', 3000, 5000]], 'shifted by the trimmed lead; the last closes at hang-up');
  assert.equal(record.screens[0].speakerId, 'A');
  assert.equal(record.pad.lang, 'python');
  assert.deepEqual(record.pad.snapshots.map(item => item.text), ['', 'def f(): pass', 'def f(): return 1', 'def f(): return 1'], 'the pad as it opened (empty), one snapshot per change, then the close');
  assert.equal(record.pad.snapshots[0].atMs, 1100, 'the opening is marked when the pad came up, on the call clock');
  assert.deepEqual(record.pad.snapshots.map(item => item.closed === true), [false, false, false, true], 'only the last entry marks the pad going away');
  assert.equal(record.pad.snapshots.at(-1).atMs, 5500, 'at the moment the interviewer closed it');
  assert.ok(record.pad.snapshots.every(item => Number.isFinite(item.atMs) && item.atMs >= 0));
  const replay = await service.getReplay('call-1');
  assert.deepEqual(replay.screens, record.screens);
  assert.deepEqual(replay.pad, record.pad);
});

// A share takes a few seconds to come up: the clock below fires timers on demand.
function timerClock(start = 10000) {
  const c = { t: start, timers: [] };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const h = { fn, at: c.t + ms, live: true }; c.timers.push(h); return h; };
  c.clearTimeout = h => { if (h) h.live = false; };
  c.advance = ms => {
    c.t += ms;
    for (const h of c.timers.filter(x => x.live && x.at <= c.t)) { h.live = false; h.fn(); }
  };
  return c;
}
async function delayedCall() {
  const clock = timerClock();
  const box = padEngine([]);
  const live = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: box.factory } });
  await live.service.start(ARGS);
  await live.service.answer();
  return { ...live, clock, box };
}

test('a delayed share is pending, then shown after the delay with the record time of its appearance', async () => {
  const { service, deps, clock, box } = await delayedCall();
  box.emit({ type: 'screen', title: 'One', content: 'First.', speakerId: 'A', delayMs: 3000 });
  let s = service.getState();
  assert.equal(s.screen, null);
  assert.equal(s.sharing.speakerId, 'A');
  assert.equal(s.sharing.title, null);
  assert.ok(s.sharing.presenterName.length > 0);
  clock.advance(2900);
  assert.equal(service.getState().screen, null);
  clock.advance(200);
  s = service.getState();
  assert.equal(s.sharing, null);
  assert.equal(s.screen.title, 'One');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.screens.length, 1);
  assert.ok(record.screens[0].atMs >= 3000 && record.screens[0].atMs <= 3200, 'at the appearance, not the tag');
});

test('a newer screen replaces a pending one and keeps the old content visible until it arrives', async () => {
  const { service, clock, box } = await delayedCall();
  box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 1000 });
  clock.advance(1000);
  box.emit({ type: 'screen', title: 'Two', content: 'b', speakerId: 'A', delayMs: 2000 });
  assert.equal(service.getState().screen.title, 'One');
  assert.ok(service.getState().sharing);
  clock.advance(1000);
  box.emit({ type: 'screen', title: 'Three', content: 'c', speakerId: 'A', delayMs: 2000 });
  clock.advance(1500);
  assert.equal(service.getState().screen.title, 'One', 'the replaced pending share never appears');
  clock.advance(600);
  assert.equal(service.getState().screen.title, 'Three');
  assert.equal(service.getState().sharing, null);
});

test('screen-stop, the interviewer leaving and hang-up cancel a pending share', async () => {
  const stopped = await delayedCall();
  stopped.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 2000 });
  stopped.box.emit({ type: 'screen-stop' });
  assert.equal(stopped.service.getState().sharing, null);
  stopped.clock.advance(5000);
  assert.equal(stopped.service.getState().screen, null);

  const left = await delayedCall();
  left.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 2000 });
  left.box.emit({ type: 'ended', reason: 'interviewer' });
  assert.equal(left.service.getState().sharing, null);
  left.clock.advance(5000);
  assert.equal(left.service.getState().screen, null);

  const hung = await delayedCall();
  hung.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 2000 });
  await hung.service.hangUp();
  hung.clock.advance(5000);
  assert.equal(hung.service.getState().screen, null);
});

test('an exercise on given code opens the pad with it, once, marked as given and told to the engine as not the candidate\'s work', async () => {
  const seeded = [];
  const clock = timerClock();
  const box = padEngine([]);
  const factory = options => ({ ...box.factory(options), seedPadText: value => seeded.push(value) });
  const starter = 'MAX     CSECT\n* TODO: compare';
  const planner = fakePlanner();
  const live = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: factory, planCall: async inputs => {
    const made = await planner(inputs);
    const number = made.plan.questions.find(question => question.number > 0).number;
    return { ...made, plan: { ...made.plan, problems: [{ ref: 'p1', question: number, language: 'HLASM', parts: [{ title: 'Finish it', content: 'Finish the routine.' }], starter, solution: 'S', edgeCases: [], hints: [] }] } };
  } } });
  await live.service.start(ARGS);
  await live.service.answer();
  box.emit({ type: 'pad', open: true, lang: 'HLASM' });
  box.emit({ type: 'screen', title: 'Finish it', content: 'Finish the routine.', speakerId: 'A', delayMs: 3000 });
  clock.advance(3000);
  assert.equal(live.service.getState().pad.text, starter);
  assert.equal(live.service.getState().pad.seed.text, starter);
  assert.deepEqual(seeded, [starter]);
  live.service.updatePad(`${starter}\n CR 3,4`);
  box.emit({ type: 'pad', open: false });
  box.emit({ type: 'pad', open: true });
  assert.equal(live.service.getState().pad.text, `${starter}\n CR 3,4`, 'opening it again keeps the work');
  await live.service.hangUp();
  const { pad } = await live.deps.store.readRecord('call-1');
  assert.equal(pad.snapshots.find(item => item.starter)?.text, starter);
  assert.equal(pad.snapshots.filter(item => item.starter).length, 1);
});

test('each exercise has its own pad: another problem turns it over, going back brings the work back (call-mwvfxv2u)', async () => {
  const seeded = [];
  const box = padEngine([]);
  const clock = timerClock();
  const planner = fakePlanner();
  const problem = (ref, question, extra = {}) => ({ ref, question, language: '', parts: [{ title: ref, content: `${ref} part 1` }, { title: `${ref} b`, content: `${ref} part 2` }], solution: 'S', edgeCases: [], hints: [], ...extra });
  const live = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: options => ({ ...box.factory(options), seedPadText: value => seeded.push(value) }), planCall: async inputs => {
    const made = await planner(inputs);
    const number = made.plan.questions.find(question => question.number > 0).number;
    return { ...made, plan: { ...made.plan, problems: [problem('p1', number), problem('p2', 0), problem('p3', 0, { starter: 'given()' })] } };
  } } });
  await live.service.start(ARGS);
  await live.service.answer();
  const { service } = live;
  const pad = () => service.getState().pad;
  const show = (title, content, delayMs = 0) => box.emit({ type: 'screen', title, content, speakerId: 'A', delayMs });
  show('p2', 'p2 part 1');
  box.emit({ type: 'pad', open: true });
  service.updatePad('first()', pad().sheet || 0);
  clock.advance(60000);
  show('p2 b', 'p2 part 2');
  box.emit({ type: 'pad', open: true });
  assert.equal(pad().text, 'first()', 'another part of the same problem keeps the work');
  clock.advance(60000);
  show('Corrected', 'a corrected screen of the same exercise');
  assert.equal(pad().text, 'first()', 'a screen without the pad opened again keeps it');
  clock.advance(60000);
  show('p1', 'p1 part 1');
  box.emit({ type: 'pad', open: true });
  assert.equal(pad().text, '');
  assert.equal(pad().seed.text, '', 'the window is told to clear it');
  service.updatePad('first() late', 0);
  assert.equal(pad().text, '', 'keys sent before the window knew are the last exercise\'s');
  service.updatePad('second()', pad().sheet);
  clock.advance(60000);
  show('p2', 'p2 part 1');
  assert.equal(pad().text, 'first()', 'going back brings the work back');
  clock.advance(60000);
  box.emit({ type: 'pad', open: false });
  show('p3', 'p3 part 1', 3000);
  box.emit({ type: 'pad', open: true });
  clock.advance(3000);
  assert.equal(pad().text, 'given()');
  service.updatePad('given() third()', pad().sheet);
  clock.advance(60000);
  show('Mine', 'an exercise of the interviewer\'s own');
  box.emit({ type: 'pad', open: true });
  assert.equal(pad().text, '');
  service.updatePad('own()', pad().sheet);
  box.emit({ type: 'screen-stop' });
  box.emit({ type: 'pad', open: false });
  box.emit({ type: 'pad', open: true });
  assert.equal(pad().text, 'own()', 'opened again with nothing new asked or shown');
  box.emit({ type: 'question-asked', number: 99 });
  box.emit({ type: 'pad', open: false });
  box.emit({ type: 'pad', open: true });
  assert.equal(pad().text, '', 'a pad-only exercise after another question was asked');
  await service.hangUp();
  const { pad: record } = await live.deps.store.readRecord('call-1');
  const turned = record.snapshots.filter(item => item.sheet).map(item => [item.sheet, item.text, item.starter === true]);
  assert.deepEqual(turned, [[2, '', false], [1, 'first()', false], [3, 'given()', true], [4, '', false], [5, '', false]]);
  for (const text of ['first()', 'second()', 'given() third()', 'own()']) assert.ok(record.snapshots.some(item => item.text === text), text);
});

test('a pad taken back for a share coming up is recorded when it really appears (call-mwu3jble)', async () => {
  const { service, deps, clock, box } = await delayedCall();
  clock.advance(1000);
  box.emit({ type: 'pad', open: true, lang: 'HLASM', atMs: 1000 });
  box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 5000, atMs: 1000 });
  assert.equal(service.getState().pad.open, false);
  clock.advance(5000);
  assert.equal(service.getState().pad.open, true);
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.pad.snapshots[0].atMs, record.screens[0].atMs, 'the pad and the problem come up together in the replay');
});

test('a pad open waits for a pending share and is immediate otherwise', async () => {
  const waits = await delayedCall();
  waits.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 3000 });
  waits.box.emit({ type: 'pad', open: true, lang: 'python' });
  assert.equal(waits.service.getState().pad.open, false);
  waits.clock.advance(3000);
  assert.equal(waits.service.getState().pad.open, true);
  assert.equal(waits.service.getState().pad.lang, 'python');
  assert.ok(waits.service.getState().screen);

  const free = await delayedCall();
  free.box.emit({ type: 'pad', open: true, lang: 'js' });
  assert.equal(free.service.getState().pad.open, true);

  const cancelled = await delayedCall();
  cancelled.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 3000 });
  cancelled.box.emit({ type: 'pad', open: true, lang: 'js' });
  cancelled.box.emit({ type: 'screen-stop' });
  assert.equal(cancelled.service.getState().pad.open, true, 'a cancelled share releases the held pad');
});

test('screen-stop closes the open screen entry and a call without screens saves empty lists', async () => {
  const box = padEngine([]);
  const { service, deps } = await liveCall({ deps: { engineFactory: box.factory } });
  await service.start(ARGS);
  await service.answer();
  box.emit({ type: 'screen', title: 'A', content: 'a', speakerId: 'A', atMs: 100 });
  box.emit({ type: 'screen-stop', atMs: 400 });
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.screens.map(item => [item.atMs, item.endMs]), [[100, 400]]);
  const quiet = await liveCall({ deps: { engineFactory: padEngine([]).factory } });
  await quiet.service.start(ARGS);
  await quiet.service.answer();
  await quiet.service.hangUp();
  const empty = await quiet.deps.store.readRecord('call-1');
  assert.deepEqual(empty.screens, []);
  assert.deepEqual(empty.pad, { lang: '', snapshots: [] });
});

test('the review receives the record with screens and pad', async () => {
  const box = padEngine([], { transcript: [{ speaker: 'candidate', text: 'Hi.', startMs: 1, endMs: 2 }], elapsedMs: 5000 });
  let seen = null;
  const { service } = await liveCall({ deps: {
    engineFactory: box.factory,
    analyze: async input => { seen = input.callRecord; return { status: 'ready', chapters: [], feedback: { summary: 'ok' } }; },
  } });
  await service.start(ARGS);
  await service.answer();
  box.emit({ type: 'screen', title: 'T', content: 'c', speakerId: 'A', atMs: 10 });
  await service.hangUp();
  assert.equal(seen.screens.length, 1);
  assert.deepEqual(seen.pad, { lang: '', snapshots: [] });
});

test('overlay: an overlaid remark rings its interviewer, captions it once, and clears after its estimated length', async () => {
  const setup = panelHarness({ random: () => 0.9 });
  const built = await panelStart(setup);
  await built.service.answer();
  const engine = setup.engineOptions[0].onEvent;
  engine({ type: 'phase', phase: 'playing' });
  engine({ type: 'speaker', speakerId: 'A' });
  engine({ type: 'overlay', speakerId: 'B', text: 'Hi Jack.', atMs: 1200 });
  let state = built.service.getState();
  assert.equal(state.speakingId, 'A', 'the main speaker keeps the ring');
  assert.equal(state.overSpeakingId, 'B');
  assert.deepEqual(state.captions.filter(item => item.overlay).map(item => [item.speakerId, item.text]), [['B', 'Hi Jack.']]);
  // The engine's own caption for the same remark does not add a second row.
  engine({ type: 'caption', speaker: 'interviewer', speakerId: 'B', text: 'Hi Jack.', final: true });
  assert.equal(built.service.getState().captions.filter(item => item.text === 'Hi Jack.').length, 1);
  const timer = setup.clock.pending().find(item => item.ms === 700);
  assert.ok(timer, 'two words last 700 ms');
  setup.clock.fire(timer);
  assert.equal(built.service.getState().overSpeakingId, null);
  engine({ type: 'overlay', speakerId: 'C', text: 'one two three four five six seven eight', atMs: 5000 });
  assert.ok(setup.clock.pending().some(item => item.ms === 2800));
  engine({ type: 'phase', phase: 'listening' });
  assert.equal(built.service.getState().overSpeakingId, null, 'the remark ends with the speaking state');
});

test('overlay: the transcript entry reaches the record with speakerId and overlay, shifted like other entries', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const log = [];
  const transcript = [
    { speaker: 'interviewer', speakerId: 'A', text: 'Let me introduce Sam.', startMs: 6000, endMs: 9000 },
    { speaker: 'interviewer', speakerId: 'B', text: 'Hi Jack.', startMs: 7000, endMs: 7700, overlay: true },
  ];
  const box = padEngine(log, { transcript, elapsedMs: 5000 });
  const { service, deps } = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: box.factory } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  const entry = record.transcript.find(item => item.overlay);
  assert.deepEqual([entry.speakerId, entry.text, entry.startMs, entry.endMs], ['B', 'Hi Jack.', 3000, 3700]);
  const replay = await service.getReplay('call-1');
  assert.equal(replay.transcript.find(item => item.overlay)?.speakerId, 'B');
});

test('while paused sendChat does nothing, updatePad still works, and chat is accepted after the engine reports resumed', async () => {
  const log = [];
  const box = padEngine(log);
  const typedLog = [];
  const factory = options => { const e = box.factory(options); e.typed = text => typedLog.push(text); return e; };
  const { service } = await liveCall({ deps: { engineFactory: factory } });
  await service.start(ARGS);
  await service.answer();
  box.emit({ type: 'pad', open: true, lang: 'js' });
  box.emit({ type: 'paused', paused: true });
  assert.equal(service.getState().paused, true);
  const before = service.getState().chat.length;
  const state = service.sendChat('held back');
  assert.equal(state.chat.length, before, 'the chat list does not gain the message');
  assert.deepEqual(typedLog, []);
  service.updatePad('draft code');
  assert.deepEqual(log, [['setPadText', 'draft code']]);
  box.emit({ type: 'paused', paused: false });
  service.sendChat('now sent');
  assert.deepEqual(typedLog, ['now sent']);
});

// Per-interviewer room: the fake processor stamps every sample byte with the room's tag, so the audio
// shows which room treated it.
const roomDeps = extra => ({
  callRoom: seed => ({ seed, tag: seed.charCodeAt(seed.length - 1) }),
  callSound: ({ room }) => ({ process: buffer => Buffer.alloc(buffer.length, room.tag), reset() {} }),
  ...extra,
});
const heardFrom = (factory, utteranceId) => {
  const stream = factory.open({ utteranceId });
  let heard = null;
  stream.onAudio(chunk => { heard = chunk; });
  stream.audioListener(Buffer.from([1, 0, 2, 0, 3]));
  return heard;
};

test('the lead and a colleague are treated in different rooms from their voice ids, and the record keeps both rooms', async () => {
  const cast = [{ voice: 'V2', role: 'Senior Engineer', focus: 'api', stability: 0.55 }];
  const setup = panelHarness({ random: () => 0.9, cast, deps: roomDeps() });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  const lead = heardFrom(factories.A, 'u1');
  const colleague = heardFrom(factories.B, 'u2');
  assert.equal(lead.length, 5, 'odd byte counts keep their length');
  assert.deepEqual([...lead], Array(5).fill('1'.charCodeAt(0)), 'lib-1 room');
  assert.deepEqual([...colleague], Array(5).fill('2'.charCodeAt(0)), 'lib-2 room');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.room.seed, 'lib-1');
  assert.equal(record.panel[0].room.seed, 'lib-2');
  assert.notDeepEqual(record.persona.room, record.panel[0].room);
});

test('the warm-up line is never treated', async () => {
  const setup = panelHarness({ random: () => 0.9, cast: [], deps: roomDeps() });
  const { service } = await panelStart(setup);
  await service.answer();
  const lead = setup.engineOptions[0].voice;
  const heard = heardFrom(lead.panelOf ? lead.panelOf.factories.A : lead, 'warm-up');
  assert.deepEqual([...heard], [1, 0, 2, 0, 3]);
});

test('a throwing room processor leaves the audio untouched and warns once', async () => {
  const warnings = [];
  const cast = [{ voice: 'V2', role: 'Engineer', focus: '', stability: 0.5 }];
  const setup = panelHarness({ random: () => 0.9, cast, deps: roomDeps({
    callSound: () => ({ process: () => { throw new Error('processor broke'); }, reset() {} }),
    logger: { warn: message => warnings.push(message), info() {}, error() {} },
  }) });
  const { service } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.deepEqual([...heardFrom(factories.A, 'u1')], [1, 0, 2, 0, 3]);
  assert.deepEqual([...heardFrom(factories.B, 'u2')], [1, 0, 2, 0, 3]);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
});

// Chosen room amounts: the plan's numbers reach roomFor, the treated audio and the record.
const amountRooms = extra => ({
  callRoom: (seed, amount) => ({ seed, amount, tag: seed.charCodeAt(seed.length - 1) }),
  callSound: ({ room }) => ({ process: buffer => Buffer.alloc(buffer.length, room.tag), reset() {} }),
  ...extra,
});

test('the lead and a colleague amounts reach roomFor, the treated audio and the record', async () => {
  const setup = panelHarness({ random: () => 0.9, deps: amountRooms(), plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, room: 0.2 },
    panel: [{ voice: 'V2', role: 'Engineer', focus: '', stability: 0.5, room: 0.8, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
  }) });
  const calls = [];
  const roomFor = setup.overrides.callRoom;
  setup.overrides.callRoom = (seed, amount) => { calls.push([seed, amount ?? null]); return roomFor(seed, amount); };
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.equal(heardFrom(factories.A, 'u1').length, 5);
  heardFrom(factories.B, 'u2');
  assert.equal(calls.some(([seed, amount]) => seed === 'lib-1' && amount === 0.2), true);
  assert.equal(calls.some(([seed, amount]) => seed === 'lib-2' && amount === 0.8), true);
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.roomAmount, 0.2);
  assert.equal(record.persona.room.amount, 0.2);
  assert.equal(record.panel[0].roomAmount, 0.8);
  assert.equal(record.panel[0].room.amount, 0.8);
});

test('without a usable amount the room is the seed-only one and no amount is recorded', async () => {
  const setup = panelHarness({ random: () => 0.9, deps: amountRooms(), plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, room: null },
    panel: [{ voice: 'V2', role: 'Engineer', focus: '', stability: 0.5, room: Number.NaN, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
  }) });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.room.amount, null);
  assert.equal('roomAmount' in record.persona, false);
  assert.equal('roomAmount' in record.panel[0], false);
});

// The call codec: a fake that tags every chunk and holds a tail until flush.
const codecHarness = extra => {
  const made = [];
  const pushed = [];
  const tracked = [];
  const cancelled = [];
  const warnings = [];
  const deps = {
    callCodec: ({ sampleRate, onError }) => {
      const codec = { sampleRate, onError, processed: [], flushed: 0, process(buffer) { codec.processed.push(buffer.length); return Buffer.alloc(buffer.length, 7); }, flush() { codec.flushed += 1; return Buffer.alloc(2, 9); }, reset() {} };
      made.push(codec);
      return codec;
    },
    helperFactory: () => ({
      start: async () => ({ ok: true }), play() {}, pushAudio: (id, pcm) => { pushed.push([id, Buffer.from(pcm)]); },
      endUtterance() {}, cancel: id => { cancelled.push(id); }, mute() {}, stop: async () => {},
    }),
    trackFactory: () => ({ started() {}, ended() {}, addUtterance: (id, pcm) => { tracked.push([id, Buffer.from(pcm)]); }, finalize: async () => {} }),
    logger: { warn: message => warnings.push(message), info() {}, error() {} },
    ...extra,
  };
  return { made, pushed, tracked, cancelled, warnings, deps };
};
const mirrorOf = async harness => {
  const seen = {};
  const { deps } = makeDeps({ tmp: await mkdtemp(path.join(os.tmpdir(), 'practice-call-codec-')), modelReady: true, deps: {
    ...harness.deps,
    engineFactory: options => { seen.audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  return seen.audio;
};

test('the codec processes every interviewer chunk once and its tail reaches the helper and the track at the end', async () => {
  const harness = codecHarness();
  const audio = await mirrorOf(harness);
  audio.play('u1', 24000);
  audio.pushAudio('u1', Buffer.alloc(6), 24000);
  audio.pushAudio('u1', Buffer.alloc(4), 24000);
  audio.endUtterance('u1');
  assert.equal(harness.made.length, 1);
  assert.equal(harness.made[0].sampleRate, 24000);
  assert.deepEqual(harness.made[0].processed, [6, 4]);
  assert.equal(harness.made[0].flushed, 1);
  assert.deepEqual(harness.pushed.map(([, pcm]) => [...pcm].join('')), ['777777', '7777', '99']);
  assert.equal(harness.tracked.at(-1)[1].length, 12);
  assert.deepEqual([...harness.tracked.at(-1)[1].subarray(10)], [9, 9]);
});

test('a cancelled line still flushes the codec tail before it is cut off', async () => {
  const harness = codecHarness();
  const audio = await mirrorOf(harness);
  audio.play('u1', 24000);
  audio.pushAudio('u1', Buffer.alloc(6), 24000);
  audio.cancel('u1');
  assert.equal(harness.made[0].flushed, 1);
  assert.deepEqual(harness.pushed.map(([, pcm]) => pcm.length), [6, 2]);
  assert.deepEqual(harness.cancelled, ['u1']);
});

test('a throwing codec leaves the audio untouched and logs once', async () => {
  const harness = codecHarness({ callCodec: () => ({ process: () => { throw new Error('codec broke'); }, flush: () => Buffer.alloc(0), reset() {} }) });
  const audio = await mirrorOf(harness);
  const input = Buffer.from([1, 0, 2, 0]);
  audio.play('u1', 24000);
  audio.pushAudio('u1', input, 24000);
  audio.pushAudio('u1', input, 24000);
  audio.play('u2', 24000);
  audio.pushAudio('u2', input, 24000);
  assert.deepEqual(harness.pushed.map(([, pcm]) => [...pcm]), [[1, 0, 2, 0], [1, 0, 2, 0], [1, 0, 2, 0]]);
  assert.equal(harness.warnings.filter(message => message.includes('codec')).length, 1);
});

test('the warm-up line bypasses both the room and the codec', async () => {
  const harness = codecHarness();
  const setup = panelHarness({ random: () => 0.9, cast: [], deps: { ...amountRooms(), ...harness.deps } });
  const { service } = await panelStart(setup);
  await service.answer();
  const heard = heardFrom(setup.engineOptions[0].voice.panelOf.factories.A, 'warm-up');
  assert.deepEqual([...heard], [1, 0, 2, 0, 3]);
  assert.equal(harness.made.length, 0);
});

test('a solo call hands the engine a panel voice, so the share silence has a gap, with the lead alone and no panel option', async () => {
  const setup = panelHarness({ cast: [], deps: { panelVoiceFactory: createPanelVoiceFactory } });
  const { service } = await panelStart(setup);
  await service.answer();
  const options = setup.engineOptions[0];
  assert.equal('panel' in options, false, 'the engine is told of no panel');
  const stream = options.voice.open({ utteranceId: 'solo-1' });
  assert.equal(typeof stream.gap, 'function', 'the share setup can be real silence');
  assert.equal(stream.setSpeaker('B'), false, 'no other speaker exists to switch to');
  assert.equal(stream.overlay({ speakerId: 'B', text: 'yes', afterChars: 0 }), false, 'no remark can be played');
  assert.deepEqual(service.getState().participants.map(item => item.id), ['A']);
  await service.hangUp();
});

// --- the planning step: inputs, the text call, failure, the saved setup and the prepared screens ---

const flushAll = () => new Promise(resolve => setTimeout(resolve, 10));

test('plan: the planner gets the sealed brief, the pool by number, the drawn voices, the focus note, the name and a signal', async () => {
  const setup = panelHarness({ cast: [] });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  setup.overrides.loadCandidateName = async () => 'Synthetic Person';
  setup.overrides.questionHistory = memoryHistory({ 'node-1': { q2: 3 } });
  setup.overrides.logger = { warn() {}, info() {} };
  setup.overrides.callText = async () => ({});
  const { state } = await panelStart(setup, { deps: setup.overrides });
  assert.equal(state.phase, 'ringing');
  assert.equal(setup.planner.calls.length, 1);
  const input = setup.planner.calls[0];
  assert.deepEqual(input.brief, { company: 'Acme', role: 'Engineer', location: '', roleSummary: '', roleThemes: [], companyFacts: [], recentContext: [] });
  assert.deepEqual(input.pool.map(item => [item.number, item.timesAsked]), [[1, 0], [2, 3], [3, 0]]);
  assert.equal(input.pool.some(item => 'answer' in item), false, 'the planner never sees prepared answers');
  assert.deepEqual(input.application, { resume: 'Synthetic resume text.', coverLetter: 'Synthetic cover letter text.' });
  assert.equal('targetMinutes' in input, false, 'the planner chooses the call length itself: none is handed to it');
  assert.equal(input.steering, '');
  assert.equal(input.candidateName, 'Synthetic Person');
  assert.equal(typeof input.callText, 'function');
  assert.equal(input.signal.aborted, false);
  assert.equal(input.logger, setup.overrides.logger);
  assert.deepEqual(input.voices.map(voice => voice.key), ['V1', 'V2', 'V3']);
});

test('plan: the focus note reaches the planner, and the planner is asked once before any session exists', async () => {
  const order = [];
  const setup = panelHarness({ cast: [] });
  const inner = setup.overrides.planCall;
  setup.overrides.planCall = async input => { order.push('plan'); return inner(input); };
  setup.overrides.sessionsFactory = () => { order.push('session'); return { start: async () => ({ reply: 'READY' }) }; };
  const { state } = await panelStart(setup, { deps: setup.overrides });
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(order, ['plan', 'session', 'session', 'session']);
  const built = makeDeps({ tmp: await mkdtemp(path.join(os.tmpdir(), 'practice-call-plan-steer-')), modelReady: true, deps: { planCall: fakePlanner() } });
  await createPracticeCallService(built.deps).start({ ...ARGS, steering: '  Ask about pay.  ' });
  assert.equal(built.deps.planCall.calls[0].steering, 'Ask about pay.');
});

test('plan: without planText the planner calls the service text call with the planning task and stage; planText wins when given', async () => {
  const seen = [];
  const viaCallText = fakePlanner();
  const planner = async input => {
    await input.callText({ prompt: 'P', schema: { type: 'object' }, signal: 'S' });
    return viaCallText(input);
  };
  const callText = async request => { seen.push(['callText', request]); return {}; };
  const first = await startOf({ deps: { planCall: planner, callText } });
  await first.service.start(ARGS);
  assert.deepEqual(seen, [['callText', { prompt: 'P', schema: { type: 'object' }, signal: 'S', task: 'practice-plan', claudeStage: 'practice-call-plan' }]]);

  seen.length = 0;
  const planText = async request => { seen.push(['planText', request]); return {}; };
  const second = await startOf({ deps: { planCall: planner, callText, planText } });
  await second.service.start(ARGS);
  assert.deepEqual(seen, [['planText', { prompt: 'P', schema: { type: 'object' }, signal: 'S' }]]);
});

test('plan: a failed plan ends in an error state, starts no session, warms nothing and cleans the call folder up', async () => {
  const created = { sessions: 0, helpers: 0, tracks: 0 };
  const warnings = [];
  const harness = voiceHarness({ audio: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-plan-fail-'));
  const planCall = async () => { throw Object.assign(new Error('could not plan after 3 attempts'), { code: 'plan-failed', attempts: [{ problems: ['a question number is not in the pool'] }, { problems: ['the minutes are too long'] }] }); };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    planCall, voiceFactory: harness.make,
    sessionsFactory: () => { created.sessions += 1; throw new Error('no sessions without a plan'); },
    helperFactory: () => { created.helpers += 1; throw new Error('no helper without a plan'); },
    trackFactory: () => { created.tracks += 1; throw new Error('no track without a plan'); },
    logger: { warn: message => warnings.push(message), info: message => warnings.push(message) },
  } });
  const service = createPracticeCallService(deps);
  const states = [];
  service.onState(item => states.push(item));
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'plan-failed');
  assert.equal(state.error.message, 'The interview could not be planned. Try starting the call again.');
  assert.equal(state.notice, null, 'the planning notice is cleared');
  assert.deepEqual(created, { sessions: 0, helpers: 0, tracks: 0 });
  assert.equal(harness.factories.length, 0, 'no voice is made or warmed');
  assert.equal(states.some(item => item.phase === 'ringing'), false, 'nothing rings');
  assert.equal(warnings.some(line => line.includes('plan-failed') && line.includes('could not plan after 3 attempts')), true, 'the cause is logged');
  assert.equal(warnings.some(line => line.includes('a question number is not in the pool')), true, 'so are the problems of each attempt');
  assert.equal(await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false), false, 'no lastUsed stamp is saved');
  await flushAll();
  assert.equal(await deps.store.readRecord('call-1'), null, 'no record is left behind');
  assert.equal((await nodeFs.readdir(path.join(tmp, 'practice-calls'))).includes('call-1'), false, 'the call folder is gone');
  // The service is free for a new start afterwards (it fails again here only because the planner still does).
  assert.equal((await service.start(ARGS)).error.code, 'plan-failed');
});

test('plan: a plan that names a voice that was not drawn, or a planner that returns nothing, fails the call the same way', async () => {
  for (const [label, planCall] of [
    ['unknown lead', async ({ voices }) => ({ plan: soloPlan(voices, { lead: { ...soloPlan(voices).lead, voice: 'V9' } }), attempts: [], ms: 1 })],
    ['unknown colleague', async ({ voices }) => ({ plan: soloPlan(voices, { panel: [{ voice: 'V9', role: 'Engineer', focus: '', stability: 0.3, room: 0.4, manner: '', interrupting: 'Lets people finish and rarely cuts in.' }] }), attempts: [], ms: 1 }), ],
    ['nothing', async () => ({})],
  ]) {
    let sessions = 0;
    const { service } = await startOf({ deps: { planCall, sessionsFactory: () => { sessions += 1; return { start: async () => {} }; } } });
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'plan-failed', label);
    assert.equal(sessions, 0, label);
  }
});

test('setup: each step is published in order, with the planner attempt, and cleared once the call rings', async () => {
  let service;
  const planCall = async input => {
    input.onAttempt?.(1);
    input.onAttempt?.(2);
    return { plan: soloPlan(input.voices), attempts: [], ms: 1 };
  };
  const built = await startOf({ deps: { planCall } });
  service = built.service;
  const seen = [];
  service.onState(item => {
    if (item.phase !== 'precheck' || !item.setup) return;
    const key = `${item.setup.step}:${item.setup.attempt}`;
    if (seen[seen.length - 1] !== key) seen.push(key);
  });
  const state = await service.start(ARGS);
  assert.deepEqual(seen, ['account:1', 'voices:1', 'plan:1', 'plan:2', 'voice:1', 'audio:1', 'screens:1', 'sessions:1']);
  assert.equal(state.phase, 'ringing');
  assert.equal(state.setup, null);
});

test('plan: the setup phase shows a planning notice that is gone once the call rings', async () => {
  const notices = [];
  let service;
  const planCall = async input => {
    notices.push(service.getState().notice);
    return { plan: soloPlan(input.voices), attempts: [], ms: 1 };
  };
  const built = await startOf({ deps: { planCall } });
  service = built.service;
  const phases = [];
  service.onState(item => phases.push([item.phase, item.notice?.message ?? null]));
  const state = await service.start(ARGS);
  assert.deepEqual(notices, [{ code: 'planning', message: 'Planning the interview' }]);
  assert.equal(phases.some(([phase, message]) => phase === 'precheck' && message === 'Planning the interview'), true);
  assert.equal(state.phase, 'ringing');
  assert.equal(state.notice, null);
});

test('plan: hanging up while the plan is being made aborts it and neither fails nor starts anything', async () => {
  let signal;
  let sessions = 0;
  let release;
  const planCall = input => new Promise((resolve, reject) => {
    signal = input.signal;
    release = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    input.signal.addEventListener('abort', release);
  });
  const { service } = await startOf({ deps: { planCall, sessionsFactory: () => { sessions += 1; return { start: async () => {} }; } } });
  const starting = service.start(ARGS);
  await flushAll();
  assert.equal(service.getState().notice.message, 'Planning the interview');
  const ended = await service.hangUp();
  assert.equal(signal.aborted, true, 'the planning call is told to stop');
  assert.equal(ended.error, null, 'a hang-up during planning is not an error');
  const final = await starting;
  assert.notEqual(final.error?.code, 'plan-failed');
  assert.equal(sessions, 0);
});

test('plan: the setup is saved with the record and logged as it happens', async () => {
  const lines = [];
  const attempts = [{ problems: ['a probe is too long'] }, { problems: ['the minutes are too long'] }];
  const planCall = async ({ voices }) => ({
    plan: soloPlan(voices, {
      panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
      problems: [{ ref: 'p1', question: 1, language: 'javascript', parts: [{ title: 'Task', content: 'Sum a list.' }], solution: 'return 1;', edgeCases: [], hints: [] }],
    }),
    attempts, ms: 4321,
  });
  const setup = panelHarness({ random: () => 0.9, deps: { planCall, logger: { warn: line => lines.push(['warn', line]), info: line => lines.push(['info', line]) } } });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.setup.plan.interviewKind, 'A short screening conversation.');
  assert.deepEqual(record.setup.planAttempts, [['a probe is too long'], ['the minutes are too long']]);
  assert.equal(record.setup.planMs, 4321);
  assert.deepEqual(record.setup.voices.map(voice => [voice.key, voice.name, voice.voiceId, voice.used, voice.id]), [
    ['V1', 'Nora Lead', 'lib-1', true, 'A'], ['V2', 'Ben Specialist', 'lib-2', true, 'B'], ['V3', 'Cara Second', 'lib-3', false, null],
  ]);
  assert.equal(JSON.stringify(record.setup).includes('key-should-never-be-logged'), false);
  const info = lines.filter(([level]) => level === 'info').map(([, line]) => line);
  assert.equal(info.some(line => line.includes('voices drawn') && line.includes('nameStart') && line.includes('V3')), true, 'the drawn voices are logged');
  const planned = info.find(line => line.includes('plan {'));
  assert.ok(planned, 'the plan summary is logged');
  assert.equal(planned.includes('"ms":4321') && planned.includes('"failedAttempts":2') && planned.includes('"problems":["p1"]'), true);
});

test('plan: the log falls back to warn when the logger has no info', async () => {
  const lines = [];
  const setup = panelHarness({ cast: [], deps: { logger: { warn: line => lines.push(line) } } });
  await panelStart(setup);
  assert.equal(lines.some(line => line.includes('voices drawn')) && lines.some(line => line.includes('plan {')), true);
});

/** The options the main and opener prompts were built with, for a plan stand-in that carries `change` over a solo plan. */
async function promptOptionsFor(change, extra = {}) {
  const lines = [];
  const setup = panelHarness({ cast: [], deps: { logger: { warn() {}, info: line => lines.push(line) }, ...extra }, plan: drawn => soloPlan(drawn, change) });
  const { service } = await panelStart(setup);
  await service.hangUp({ feedback: false }).catch(() => {});
  return { main: setup.built.find(item => item.kind === 'main').options, opener: setup.built.find(item => item.kind === 'opener').options, lines };
}

test('length: the interviewer prompts get the length the planner chose and when it starts the wrap-up', async () => {
  // Owner's decision, 2026-11-23: no fixed 25 to 30 minutes; the planner decides how long this interview would run.
  const { main, opener, lines } = await promptOptionsFor({ callMinutes: 40, wrapUpMinutes: 6, questions: [{ number: 1, askedBy: 'V1', minutes: 30, probes: [] }] });
  for (const options of [main, opener]) assert.deepEqual([options.targetMinutes, options.wrapUpMinutes], [[33, 40], 6]);
  const note = lines.find(line => line.includes('plan {'));
  assert.equal(note.includes('"callMinutes":40') && note.includes('"wrapUpMinutes":6'), true, 'the debug log shows both');
  const short = await promptOptionsFor({ callMinutes: 10, wrapUpMinutes: 2, questions: [{ number: 1, askedBy: 'V1', minutes: 8, probes: [] }] });
  assert.deepEqual([short.main.targetMinutes, short.main.wrapUpMinutes], [[8, 10], 2]);
  // A stand-in plan with no length (one kept from before has none either) is as long as its question budgets.
  const bare = await promptOptionsFor({});
  assert.deepEqual(bare.main.targetMinutes, [8, 10]);
  assert.equal('wrapUpMinutes' in bare.main, false, 'no wrap-up time is made up: the prompts scale it from the length');
  // A length handed to the service (the unit suites) still wins for the prompts; the wrap-up is the plan's.
  const fixed = await promptOptionsFor({ callMinutes: 40, wrapUpMinutes: 6 }, { targetMinutes: [12, 14] });
  assert.deepEqual([fixed.main.targetMinutes, fixed.main.wrapUpMinutes], [[12, 14], 6]);
  // A plan with neither a length nor question budgets gives the prompts no range at all: a null would print as 0:00,
  // while left out the prompt builder uses its own default.
  const none = await promptOptionsFor({ questions: [] });
  for (const options of [none.main, none.opener]) assert.equal('targetMinutes' in options, false);
});

test('temperament: the lead\'s own words reach the prompts as written, and a fixed one still wins', async () => {
  const words = 'Courteous but exacting; waits out a thin answer before moving on.';
  const planned = await promptOptionsFor({ lead: { ...soloPlan([{ key: 'V1' }]).lead, temperament: ` ${words} ` } });
  assert.equal(planned.main.persona.temperament, words);
  assert.equal(planned.main.callPlan.people[0].temperament, words);
  assert.equal(planned.opener.persona.temperament, words);
  // An interview kept from before holds one of the old single words, and it is passed on as that word.
  const old = await promptOptionsFor({ lead: { ...soloPlan([{ key: 'V1' }]).lead, temperament: 'warm' } });
  assert.equal(old.main.persona.temperament, 'warm');
});

test('late joins: an interview kept from before the planner chose (saved draws, no choice in its plan) replays its draws, and a kept new one its plan', async () => {
  const rootDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'practice-saved-')), 'practice-interviews');
  const saved = createSavedInterviewStore({ rootDir });
  const first = await savedPanel(saved, { random: () => 0.9 });
  await first.service.start(ARGS);
  await first.service.answer();
  await waitFor(async () => (await first.service.listSaved('node-1')).length === 1, 'the interview is kept');
  await first.service.hangUp();
  const [kept] = await first.service.listSaved('node-1');
  const file = path.join(rootDir, kept.id, 'interview.json');
  const entry = JSON.parse(await nodeFs.readFile(file, 'utf8'));
  assert.deepEqual(entry.joinDraws, [{ joins: 'late', joinDelayMs: 51000 }], 'the draws are kept with the interview');
  assert.deepEqual([entry.targetMinutes, entry.planned.plan.callMinutes, entry.planned.plan.wrapUpMinutes], [[8, 10], undefined, undefined], 'a stand-in plan has no length of its own');
  // The same interview as an earlier version kept it: the old temperament word, no join choice, the draws and the 25 to 30 range.
  delete entry.planned.plan.panel[0].joins; delete entry.planned.plan.panel[0].joinMinutes;
  entry.planned.plan.lead.temperament = 'tough';
  entry.joinDraws = [{ joins: 'late', joinDelayMs: 57000 }];
  entry.targetMinutes = [25, 30];
  await nodeFs.writeFile(file, JSON.stringify(entry));
  const again = await savedPanel(saved, { random: () => 0.9, late: false });
  const state = await again.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.notEqual(state.phase, 'error', JSON.stringify(state.error));
  const main = again.setup.built.find(item => item.kind === 'main').options;
  assert.deepEqual(main.panel.map(item => item.joins), ['late'], 'the saved draw stands');
  assert.deepEqual([main.targetMinutes, 'wrapUpMinutes' in main, main.persona.temperament], [[25, 30], false, 'tough']);
  await again.service.answer();
  assert.deepEqual(again.setup.clock.lateTimers().map(timer => timer.ms), [57000], 'at the moment it was drawn for');
  await again.service.hangUp({ feedback: false });
  // The plan carries the choice too, so a kept interview with no draws of its own still has its colleague late.
  const newer = JSON.parse(await nodeFs.readFile(file, 'utf8'));
  Object.assign(newer.planned.plan.panel[0], { joins: 'late', joinMinutes: 1 });
  delete newer.joinDraws;
  await nodeFs.writeFile(file, JSON.stringify(newer));
  const plain = await savedPanel(saved, { random: () => 0.9, late: false });
  await plain.service.start({ ...ARGS, repeatInterviewId: kept.id });
  await plain.service.answer();
  assert.equal(plain.setup.clock.pending().filter(timer => timer.ms === 60000).length, 1, 'the plan\'s minute');
  await plain.service.hangUp({ feedback: false });
});

test('late joins: a kept late draw with no usable delay and a plan with no minute joins at the earliest time, never at NaN', async () => {
  const rootDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'practice-saved-')), 'practice-interviews');
  const saved = createSavedInterviewStore({ rootDir });
  const first = await savedPanel(saved, { random: () => 0.9 });
  await first.service.start(ARGS);
  await first.service.answer();
  await waitFor(async () => (await first.service.listSaved('node-1')).length === 1, 'the interview is kept');
  await first.service.hangUp();
  const [kept] = await first.service.listSaved('node-1');
  const file = path.join(rootDir, kept.id, 'interview.json');
  const entry = JSON.parse(await nodeFs.readFile(file, 'utf8'));
  delete entry.planned.plan.panel[0].joins; delete entry.planned.plan.panel[0].joinMinutes;
  entry.joinDraws = [{ joins: 'late' }];
  await nodeFs.writeFile(file, JSON.stringify(entry));
  const again = await savedPanel(saved, { random: () => 0.9, late: false });
  const state = await again.service.start({ ...ARGS, repeatInterviewId: kept.id });
  assert.notEqual(state.phase, 'error', JSON.stringify(state.error));
  await again.service.answer();
  const delays = again.setup.clock.pending().filter(timer => timer.ms >= 10000 && timer.ms <= 600000).map(timer => timer.ms);
  assert.equal(delays.length, 1);
  assert.equal(Number.isFinite(delays[0]) && delays[0] >= 0, true, `a real delay, not ${delays[0]}`);
  assert.deepEqual(again.service.getState().participants.map(item => item.id), ['A'], 'the colleague is still to join');
  await again.service.hangUp({ feedback: false });
});

test('plan: the engine gets the prepared problems by reference, and none when the plan has none', async () => {
  const withProblems = panelHarness({ cast: [], plan: drawn => soloPlan(drawn, {
    problems: [
      { ref: 'p1', question: 1, language: 'python', parts: [{ title: 'Task', content: 'Add two numbers.' }, { title: 'Example', content: 'add(1, 2) returns 3.' }], solution: 'return a + b', edgeCases: ['negative'], hints: ['look at the signature'] },
    ],
  }) });
  const first = await panelStart(withProblems);
  await first.service.answer();
  assert.deepEqual(withProblems.engineOptions[0].prepared, { p1: { question: 1, parts: [{ title: 'Task', content: 'Add two numbers.' }, { title: 'Example', content: 'add(1, 2) returns 3.' }] } }, 'only what the screen shows, never the solution');
  const main = withProblems.built.find(item => item.kind === 'main');
  assert.equal(main.options.callPlan.problems[0].solution, 'return a + b', 'the solution goes to the interviewer prompt only');

  const without = panelHarness({ cast: [] });
  const second = await panelStart(without);
  await second.service.answer();
  assert.deepEqual(without.engineOptions[0].prepared, {});
});

test('visuals: the diagram for a screen part is drawn during setup, saved for the replay, described to the interviewer and shown with its screen', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200"><rect x="10" y="10" width="300" height="40" fill="#cde"/><text x="20" y="38" font-size="16">Egress 00:00</text></svg>';
  const asked = [];
  const setup = panelHarness({ cast: [], plan: drawn => soloPlan(drawn, {
    problems: [{ ref: 'p1', question: 1, language: '', parts: [
      { title: 'EVA timeline', content: 'Egress 00:00, task A 00:00-01:10.', visual: { kind: 'diagram', shows: 'the tasks on a time axis, so the overlap is visible' } },
      { title: 'Follow-up', content: 'What if task A runs late?' },
    ], solution: 'It fits.', edgeCases: [], hints: [] }],
  }), deps: { diagramText: async request => { asked.push(request); return { svg, description: 'A timeline bar from egress to the end of task A.' }; } } });
  const started = await panelStart(setup);
  assert.equal(asked.length, 1, 'one diagram, drawn before the call rings');
  assert(asked[0].prompt.includes('Egress 00:00, task A 00:00-01:10.') && asked[0].schema);
  const main = setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.callPlan.problems[0].parts[0].visual, { kind: 'diagram', description: 'A timeline bar from egress to the end of task A.' }, 'the interviewer is told what the screen shows');
  assert.equal(main.options.callPlan.problems[0].parts[1].visual, undefined, 'a part without a visual has none');
  await started.service.answer();
  const engine = setup.engineOptions[0];
  assert.deepEqual(engine.prepared.p1.parts[0].visual, { id: 'p1.1', kind: 'diagram' });
  const callId = started.service.getState().callId;
  const file = await started.deps.store.visualPath(callId, 'p1.1.svg');
  const saved = started.deps.fs.written.find(item => item.op === 'write' && item.file === file);
  assert(saved && String(saved.data) === svg, 'saved in the call folder, where the replay protocol reads it');
  engine.onEvent({ type: 'screen', title: 'EVA timeline', content: 'Egress 00:00, task A 00:00-01:10.', speakerId: 'A', delayMs: 0, atMs: 1000, visualId: 'p1.1' });
  const shown = started.service.getState().screen.visual;
  assert.deepEqual(shown, { id: 'p1.1', kind: 'diagram', description: 'A timeline bar from egress to the end of task A.', url: `practice-call://${callId}/visuals/p1.1.svg` });
  engine.onEvent({ type: 'screen', title: 'Odd', content: 'x', speakerId: 'A', delayMs: 0, atMs: 2000, visualId: 'p9.9' });
  assert.equal(started.service.getState().screen.visual, undefined, 'an unknown visual is never shown');
});

test('visuals: a setup\'s diagram is drawn once and stays on screen for every part that shares it, with the setup text above each question', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200"><rect x="10" y="10" width="300" height="40" fill="#cde"/></svg>';
  const asked = [];
  const setup = panelHarness({ cast: [], plan: drawn => soloPlan(drawn, {
    // As the planner hands it on (validatePlan): the setup written into each part, its visual made on part 1.
    problems: [{ ref: 'p1', question: 1, language: '', parts: [
      { title: 'Matrix', content: 'A FODO cell, L = 2 m.\n\nGive the cell matrix.', visual: { kind: 'diagram', shows: 'the cell layout' } },
      { title: 'Stability', content: 'A FODO cell, L = 2 m.\n\nFor which f is it stable?', visualFrom: 1 },
    ], solution: 'cos mu = 1 - L^2/(8 f^2).', edgeCases: [], hints: [] }],
  }), deps: { diagramText: async request => { asked.push(request); return { svg, description: 'A FODO cell.' }; } } });
  const started = await panelStart(setup);
  assert.equal(asked.length, 1, 'drawn once for both parts');
  const main = setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.callPlan.problems[0].parts.map(part => part.visual?.description), ['A FODO cell.', 'A FODO cell.'], 'the interviewer knows the diagram stays up');
  await started.service.answer();
  const engine = setup.engineOptions[0];
  assert.deepEqual(engine.prepared.p1.parts.map(part => part.visual), [{ id: 'p1.1', kind: 'diagram' }, { id: 'p1.1', kind: 'diagram' }]);
  assert.deepEqual(engine.prepared.p1.parts.map(part => part.content), ['A FODO cell, L = 2 m.\n\nGive the cell matrix.', 'A FODO cell, L = 2 m.\n\nFor which f is it stable?']);
});

test('visuals: a chosen picture\'s lead sentence goes above its screen text, so the question reads as written around it', async () => {
  const fetch = async url => (url.includes('api.php')
    ? { ok: true, json: async () => ({ query: { pages: [{ index: 1, title: 'File:Moon.jpg', imageinfo: [{ thumburl: 'https://upload.example/moon.jpg', thumbwidth: 1024, thumbheight: 683, descriptionurl: 'https://commons.example/File:Moon.jpg', extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: 'NASA' } } }] }] } }) }
    : { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([9, 9]).buffer });
  const setup = panelHarness({ cast: [], plan: drawn => soloPlan(drawn, {
    problems: [{ ref: 'p1', question: 1, language: '', parts: [{ title: 'Moon base', content: 'Could you live here for a year?', visual: { kind: 'picture', search: 'lunar surface', shows: 'how desolate it is' } }], solution: 'Open.', edgeCases: [], hints: [] }],
  }), deps: { fetch, visualPickText: async () => ({ choice: 1, description: 'A grey plain.', lead: 'The photo above is the lunar south pole.' }) } });
  const started = await panelStart(setup);
  await started.service.answer();
  assert.equal(setup.engineOptions[0].prepared.p1.parts[0].content, 'The photo above is the lunar south pole.\n\nCould you live here for a year?');
  const main = setup.built.find(item => item.kind === 'main');
  assert(main.options.callPlan.problems[0].parts[0].content.startsWith('The photo above is the lunar south pole.'), 'the interviewer sees the screen as shown');
});

test('visuals: without the drawing and picking calls nothing is searched or drawn and the screens keep their text', async () => {
  const setup = panelHarness({ cast: [], plan: drawn => soloPlan(drawn, {
    problems: [{ ref: 'p1', question: 1, language: '', parts: [{ title: 'Moon base', content: 'Could you live here for a year?', visual: { kind: 'picture', search: 'lunar surface', shows: 'how desolate it is' } }], solution: 'Open.', edgeCases: [], hints: [] }],
  }) });
  const started = await panelStart(setup);
  await started.service.answer();
  assert.deepEqual(setup.engineOptions[0].prepared.p1.parts[0], { title: 'Moon base', content: 'Could you live here for a year?' });
});

test('plan: the interviewer sessions reply a bare READY, and anything they return is not read as a setup', async () => {
  const replies = ['READY', 'READY tough {"role":"Somebody Else","questions":[3]}', undefined];
  for (const reply of replies) {
    const harness = recordingPrompts();
    const { service, deps } = await startOf({ deps: { prompts: harness.prompts, loadCards: async () => PLAN_CARDS, sessionsFactory: () => ({ start: async () => (reply === undefined ? undefined : { reply }), close() {} }) } });
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'ringing');
    assert.equal(state.persona.role, 'Hiring Manager', 'the plan, not a reply, decides the role');
    assert.equal(harness.built.length, 2, 'no second build after a reply');
    await service.answer();
    await service.hangUp({ feedback: false });
    assert.deepEqual((await deps.store.readRecord('call-1')).pickedQuestions, [1]);
  }
});

// --- the unprepared question, the application and the prepared answers ---

const UNPREPARED_TEXT = 'Tell me about a time a plan changed under you, and what you did next.';
const unpreparedPlan = drawn => soloPlan(drawn, {
  panel: [{ voice: 'V2', role: 'Senior Engineer', focus: 'system design', stability: 0.3, room: 0.4, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }],
  questions: [
    { number: 1, askedBy: 'V1', minutes: 8, probes: [] },
    { number: 0, text: UNPREPARED_TEXT, askedBy: 'V2', minutes: 5, probes: ['the part of the resume that matches'] },
    { number: 2, askedBy: 'V1', minutes: 6, probes: [] },
  ],
});

test('unprepared question: number 0 keeps its text, never counts as asked or picked, and is saved for the review', async () => {
  const setup = panelHarness({ plan: unpreparedPlan });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const history = memoryHistory();
  setup.overrides.questionHistory = history;
  const inner = setup.overrides.engineFactory;
  setup.overrides.engineFactory = options => {
    const engine = inner(options);
    return { ...engine, state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000, askedQuestions: [1, 0, 2] }) };
  };
  const { service, deps } = await panelStart(setup);
  const main = setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.picked, [1, 2], 'only pool numbers are picked');
  assert.deepEqual(main.options.callPlan.questions.map(item => [item.number, item.askedBy, item.text]), [[1, 'A', undefined], [0, 'B', UNPREPARED_TEXT], [2, 'A', undefined]]);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.askedQuestions, [1, 2]);
  assert.deepEqual(history.recorded.map(item => item.ids), [['q1', 'q2']], 'the unprepared question never enters the rotation history');
  assert.deepEqual(record.unpreparedQuestion, { text: UNPREPARED_TEXT, askedBy: 'B' });
  assert.equal(record.setup.plan.questions.find(item => item.number === 0).text, UNPREPARED_TEXT);
});

test('unprepared question: a colleague who drops out hands their unprepared question to the lead', async () => {
  const setup = panelHarness({ plan: unpreparedPlan, random: () => 0.9, silent: ['lib-2'] });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const { deps, service } = await panelStart(setup);
  const mains = setup.built.filter(item => item.kind === 'main');
  assert.deepEqual(mains.at(-1).options.callPlan.questions.map(item => [item.number, item.askedBy]), [[1, 'A'], [0, 'A'], [2, 'A']]);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.deepEqual((await deps.store.readRecord('call-1')).unpreparedQuestion, { text: UNPREPARED_TEXT, askedBy: 'A' });
});

test('application: both prompt builders and the planner get it, and none of them gets a prepared answer', async () => {
  const setup = panelHarness({});
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const seen = [];
  setup.overrides.loadApplication = async args => { seen.push(args); return { resume: 'Synthetic resume text.', coverLetter: '' }; };
  const { deps, service } = await panelStart(setup);
  assert.equal(seen[0].artifactId, ARGS.bundleArtifactId);
  assert.equal(seen[0].userDataPath, deps.userDataPath);
  assert.deepEqual(setup.planner.calls[0].application, { resume: 'Synthetic resume text.', coverLetter: '' });
  for (const item of setup.built) {
    assert.deepEqual(item.options.application, { resume: 'Synthetic resume text.', coverLetter: '' }, `${item.kind} gets the application`);
    assert.equal(item.options.plan.some(card => 'answer' in card), false, `${item.kind} gets the pool without answers`);
    assert.deepEqual(item.options.plan.map(card => card.number), [1, 2, 3]);
  }
  assert.equal(JSON.stringify([setup.planner.calls[0].pool, setup.built.map(item => item.options.plan)]).includes('I led one.'), false);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.equal(JSON.stringify(record).includes('Synthetic resume text.'), false, 'the application text is not saved in the call record');
});

test('application: a failing or empty load reads as two empty strings and never stops the call, with no contents logged', async () => {
  for (const [label, load] of [['throws', async () => { throw new Error('private body: Synthetic resume text.'); }], ['null', async () => null]]) {
    const setup = panelHarness({});
    setup.overrides.loadCards = async () => PLAN_CARDS;
    const warnings = [];
    setup.overrides.logger = { warn: message => warnings.push(String(message)), info() {} };
    setup.overrides.loadApplication = load;
    const { state } = await panelStart(setup);
    assert.equal(state.phase, 'ringing', label);
    assert.deepEqual(setup.planner.calls[0].application, { resume: '', coverLetter: '' }, label);
    assert.equal(warnings.some(line => line.includes('application text unavailable')), true, label);
    assert.equal(warnings.some(line => line.includes('Synthetic resume text.')), false, `${label}: contents are never logged`);
  }
});

test('real prompt: a planner-shaped plan with colleagues reaches the real interviewer prompt by name', async () => {
  const prompts = await import('../../electron/interviewPracticeCallPrompt.js');
  const setup = panelHarness({ plan: unpreparedPlan, random: () => 0.9 });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  await panelStart(setup);
  const main = setup.built.find(item => item.kind === 'main');
  const text = prompts.buildInterviewerInstructions(main.options);
  assert.equal(typeof text, 'string');
  assert.equal(text.includes('Ben Specialist'), true, 'the colleague is named in the prompt');
  assert.equal(text.includes('Nora Lead'), true, 'the lead is named in the prompt');
  assert.equal(text.includes(UNPREPARED_TEXT), true, 'the unprepared question text reaches the prompt');
  assert.equal(text.includes('I led one.'), false, 'no prepared answer reaches the prompt');
});

test('application: with no resume and no cover letter the career documents fill the resume slot, flagged, and are not saved', async () => {
  const setup = panelHarness({});
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const seen = [];
  setup.overrides.loadApplication = async () => ({ resume: '', coverLetter: ' ' });
  setup.overrides.loadCareerDocuments = async args => { seen.push(args); return '===== FILE: a.pdf.txt =====\nSynthetic career text.'; };
  const { deps, service } = await panelStart(setup);
  assert.equal(seen[0].snapshotId, ARGS.snapshotId);
  assert.equal(seen[0].userDataPath, deps.userDataPath);
  const expected = { resume: '===== FILE: a.pdf.txt =====\nSynthetic career text.', coverLetter: '', source: 'career-documents' };
  assert.deepEqual(setup.planner.calls[0].application, expected);
  for (const item of setup.built) assert.deepEqual(item.options.application, expected);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.equal(JSON.stringify(await deps.store.readRecord('call-1')).includes('Synthetic career text.'), false);
});

test('application: career documents are not read when an application exists, and a failing read never stops the call', async () => {
  const unused = panelHarness({});
  unused.overrides.loadCards = async () => PLAN_CARDS;
  let reads = 0;
  unused.overrides.loadApplication = async () => ({ resume: 'Synthetic resume text.', coverLetter: '' });
  unused.overrides.loadCareerDocuments = async () => { reads += 1; return 'x'; };
  await panelStart(unused);
  assert.equal(reads, 0);
  for (const load of [async () => { throw new Error('private body: Synthetic career text.'); }, async () => '  ']) {
    const setup = panelHarness({});
    setup.overrides.loadCards = async () => PLAN_CARDS;
    const warnings = [];
    setup.overrides.logger = { warn: message => warnings.push(String(message)), info() {} };
    setup.overrides.loadApplication = async () => ({ resume: '', coverLetter: '' });
    setup.overrides.loadCareerDocuments = load;
    const { state } = await panelStart(setup);
    assert.equal(state.phase, 'ringing');
    assert.deepEqual(setup.planner.calls[0].application, { resume: '', coverLetter: '' });
    assert.equal(warnings.some(line => line.includes('Synthetic career text.')), false);
  }
});

const CAREER_SNAPSHOT = { sources: [{ name: 'a.pdf.txt', text: 'Alpha text.' }, { name: 'b.txt', text: 'Beta text.' }] };

test('career document text: reads the pinned snapshot read-only and returns every file', async () => {
  const calls = [];
  const text = await loadCareerDocumentText({
    snapshotId: 's1', userDataPath: '/data',
    storageRoot: root => `${root}/store`, readSnapshot: async (...args) => { calls.push(args); return CAREER_SNAPSHOT; },
    toText: value => value.sources.map(s => `===== FILE: ${s.name} =====\n${s.text}`).join('\n\n'),
  });
  assert.equal(text, '===== FILE: a.pdf.txt =====\nAlpha text.\n\n===== FILE: b.txt =====\nBeta text.');
  assert.deepEqual(calls, [['/data/store', 's1', { readOnly: true }]]);
});

test('career document text: missing arguments or snapshot read as empty', async () => {
  assert.equal(await loadCareerDocumentText({}), '');
  assert.equal(await loadCareerDocumentText({ snapshotId: 's', userDataPath: '/d', storageRoot: r => r, readSnapshot: async () => null }), '');
});

test('career document text: the cap keeps every file represented and a short file leaves room to the others', () => {
  const long = 'x'.repeat(500);
  const input = `===== FILE: a =====\n${long}\n\n===== FILE: b =====\nshort\n\n===== FILE: c =====\n${long}`;
  const out = capCareerDocumentText(input, 200);
  assert(out.length <= 200 + 4);
  for (const name of ['a', 'b', 'c']) assert(out.includes(`===== FILE: ${name} =====`) || out.includes(`FILE: ${name}`), name);
  assert(out.includes('short'));
  assert.equal(capCareerDocumentText('abc', 200), 'abc');
  assert.equal(capCareerDocumentText('y'.repeat(300), 100).length, 100);
});

// --- General questions are counted across jobs; technical topics join the pool -----

const SCOPED_CARDS = [
  { id: 'g1', scope: 'foundation', question: 'Tell me about yourself.', answer: 'I build things.' },
  { id: 'q1', scope: 'company', question: 'Why this team?', answer: 'The mission.' },
];
const TOPICS = [{ id: 'topic-aaaaaaaaaaaa', text: 'SQL query tuning', author: 'generated' }, { id: 'topic-bbbbbbbbbbbb', text: 'Kubernetes basics', author: 'user' }];

test('history: General questions count under the general key, the others under the posting store key', async () => {
  const history = memoryHistory({ general: { g1: 4 }, 'posting:abc': { q1: 2, g1: 9 }, 'node-1': { q1: 7 } });
  const harness = recordingPrompts();
  const keys = [];
  const { service, deps } = await startOf({ deps: {
    prompts: harness.prompts, loadCards: async () => SCOPED_CARDS, questionHistory: history, engineFactory: askedEngine([1, 2]),
    storeKey: async ({ nodeId }) => { keys.push(nodeId); return 'posting:abc'; },
  } });
  await service.start(ARGS);
  assert.deepEqual(keys, ['node-1']);
  assert.deepEqual(harness.built.find(item => item.kind === 'main').options.plan.map(item => [item.id, item.timesAsked]), [['g1', 4], ['q1', 2]], 'General reads the shared bucket and company cards read the posting bucket');
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.deepEqual(history.recorded, [{ nodeId: 'general', ids: ['g1'] }, { nodeId: 'posting:abc', ids: ['q1'] }], 'asked General questions are recorded under general, the rest under the posting key');
  assert(deps);
});

test('history: without a store key the interview id is the counts key, and a failing store key does not stop the call', async () => {
  const history = memoryHistory({ 'node-1': { q1: 7 } });
  const harness = recordingPrompts();
  const { service } = await startOf({ deps: { prompts: harness.prompts, loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => '' } });
  await service.start(ARGS);
  assert.deepEqual(harness.built.find(item => item.kind === 'main').options.plan.map(item => item.timesAsked), [0, 7]);
  const broken = recordingPrompts();
  const failing = await startOf({ deps: { prompts: broken.prompts, loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => { throw new Error('alias file unreadable'); } } });
  assert.equal((await failing.service.start(ARGS)).phase, 'ringing');
  assert.deepEqual(broken.built.find(item => item.kind === 'main').options.plan.map(item => item.timesAsked), [0, 7]);
});

test('topics: technical topics join the pool as instruction entries after the cards, with their own counts', async () => {
  const history = memoryHistory({ 'posting:abc': { 'topic-aaaaaaaaaaaa': 3 } });
  const harness = recordingPrompts();
  const planner = fakePlanner();
  const { service } = await startOf({ deps: {
    prompts: harness.prompts, planCall: planner, loadCards: async () => SCOPED_CARDS, questionHistory: history,
    storeKey: async () => 'posting:abc', loadTopics: async ({ nodeId }) => { assert.equal(nodeId, 'node-1'); return TOPICS; },
  } });
  await service.start(ARGS);
  const plan = harness.built.find(item => item.kind === 'main').options.plan;
  assert.deepEqual(plan.map(item => item.id), ['g1', 'q1', 'topic-aaaaaaaaaaaa', 'topic-bbbbbbbbbbbb']);
  assert.equal(plan[2].question, technicalTopicQuestion('SQL query tuning'));
  assert(plan[2].question.startsWith('[Technical topic, not a fixed question] SQL query tuning.'));
  assert.deepEqual([plan[2].timesAsked, plan[3].timesAsked], [3, 0]);
  assert(!plan.some(item => typeof item.answer === 'string' && item.answer), 'a topic carries no prepared answer');
  assert.deepEqual(planner.calls[0].pool.map(item => item.number), [1, 2, 3, 4], 'the planner sees the topics as numbered pool items');
  assert(planner.calls[0].pool[2].question.includes('Technical topic'));
});

test('topics: a topic asked on a call is counted under the posting key, and an unreadable topic list leaves the cards', async () => {
  const history = memoryHistory();
  const { service } = await startOf({ deps: {
    loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => 'posting:abc',
    loadTopics: async () => TOPICS, engineFactory: askedEngine([3]),
  } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.deepEqual(history.recorded, [{ nodeId: 'posting:abc', ids: ['topic-aaaaaaaaaaaa'] }]);
  const warnings = [];
  const harness = recordingPrompts();
  const failing = await startOf({ deps: { prompts: harness.prompts, loadCards: async () => SCOPED_CARDS, questionHistory: memoryHistory(), loadTopics: async () => { throw new Error('store unreadable'); }, logger: { warn: message => warnings.push(message) } } });
  assert.equal((await failing.service.start(ARGS)).phase, 'ringing');
  assert.deepEqual(harness.built.find(item => item.kind === 'main').options.plan.map(item => item.id), ['g1', 'q1']);
  assert(warnings.some(text => text.includes('technical topics unavailable')));
});

/** A history that keeps notes the way the real store does: asked per id, own questions, both oldest first. */
function notedHistory(initial = {}, seed = { asked: {}, own: [] }) {
  const base = memoryHistory(initial);
  const count = base.record;
  const held = { asked: { ...seed.asked }, own: [...seed.own] };
  const written = [];
  return Object.assign(base, {
    written,
    async notes() { return { asked: { ...held.asked }, own: [...held.own] }; },
    async record(nodeId, ids, extra) {
      await count(nodeId, ids);
      if (extra) { written.push({ nodeId, ids: [...ids], extra }); for (const [id, text] of Object.entries(extra.asked || {})) held.asked[id] = [...(held.asked[id] || []), text]; if (extra.own) held.own.push(extra.own); }
    },
  });
}
const topicEngine = (asked, askedTexts, answered) => options => ({
  start() { options.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, helperEvent() {}, typed() {},
  state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000, askedQuestions: asked, askedTexts, ...(answered ? { answeredQuestions: answered } : {}) }),
});
const TOPIC_PROBLEM = { ref: 'p1', question: 3, language: '', parts: [{ title: 'Balanced Delimiters', content: 'Write a function that checks\n whether a string has balanced delimiters.' }, { title: 'Nesting', content: 'Now allow quotes.' }], solution: 'Use a stack.', edgeCases: [], hints: [] };

test('notes: a topic asked and answered is noted by its prepared problem, the own question when asked, a fixed question never', async () => {
  const history = notedHistory();
  const planner = fakePlanner(voices => soloPlan(voices, {
    questions: [{ number: 2, askedBy: voices[0].key, minutes: 3, probes: [] }, { number: 3, askedBy: voices[0].key, minutes: 5, probes: [] }, { number: 0, text: 'How do you size a team?', askedBy: voices[0].key, minutes: 2, probes: [] }],
    problems: [TOPIC_PROBLEM, { ref: 'p2', question: 0, language: '', parts: [{ title: 'Sizing', content: 'Plan it.' }], solution: 'x', edgeCases: [], hints: [] }],
  }));
  const { service } = await startOf({ deps: { planCall: planner, loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS, engineFactory: topicEngine([2, 3, 4], { 0: 'So, how do you size a team?', 3: 'Let me put up a problem.' }, [2, 3]) } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.deepEqual(history.recorded, [{ nodeId: 'posting:abc', ids: ['q1', 'topic-aaaaaaaaaaaa'] }]);
  assert.deepEqual(history.written[0].extra, {
    asked: { 'topic-aaaaaaaaaaaa': 'Balanced Delimiters / Nesting: Write a function that checks whether a string has balanced delimiters.' },
    own: 'How do you size a team? (Sizing)',
  }, 'topic 4 was asked but not answered, q1 is fixed: neither is noted');
});

test('notes: a long exercise note ends at a sentence end past half the limit, else it is left for the word-end cut; the history write is logged (call-mwttebvu)', async () => {
  const sentence = 'Write a function that merges two sorted lists into one sorted list.';
  const long = `${sentence} ${sentence} ${sentence} ${sentence} Then explain the cost of each step in detail, and (2) say what changes when the lists are very large.`;
  const noEnd = 'word '.repeat(80).trim();
  const run = async (content, debug) => {
    const history = notedHistory();
    const planner = fakePlanner(voices => soloPlan(voices, {
      questions: [{ number: 3, askedBy: voices[0].key, minutes: 5, probes: [] }],
      problems: [{ ...TOPIC_PROBLEM, parts: [{ title: 'Merge', content }] }],
    }));
    const made = await startOf({ deps: { ...(debug ? { debugFs: nodeFs } : {}), planCall: planner, loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS, engineFactory: topicEngine([3], {}, [3]) } });
    await made.service.start(ARGS);
    await made.service.answer();
    await made.service.hangUp({ feedback: false });
    return { history, tmp: made.tmp };
  };
  const cut = (await run(long)).history.written[0].extra.asked['topic-aaaaaaaaaaaa'];
  assert.ok(cut.length <= 300 && cut.endsWith('.') && !cut.endsWith('(2)'), `ends at a sentence: ${cut}`);
  assert.ok(cut.length > 150);
  const words = (await run(noEnd)).history.written[0].extra.asked['topic-aaaaaaaaaaaa'];
  assert.ok(words.length > 300, 'no sentence end past half: the note is passed whole for the history\'s word-end cut');
});

test('the debug log records what the hang-up counted and noted in the practice history, and the error when the write fails (call-mwttebvu)', async () => {
  const logOf = async tmp => (await readFile(path.join(tmp, 'practice-calls', 'call-1', 'debug.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(line => line.event === 'question-history');
  const planner = () => fakePlanner(voices => soloPlan(voices, { questions: [{ number: 3, askedBy: voices[0].key, minutes: 5, probes: [] }], problems: [TOPIC_PROBLEM] }));
  const deps = history => ({ debugFs: nodeFs, planCall: planner(), loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS, logger: { warn() {} }, engineFactory: topicEngine([3], {}, [3]) });
  const ok = await startOf({ deps: deps(notedHistory()) });
  await ok.service.start(ARGS);
  await ok.service.answer();
  await ok.service.hangUp({ feedback: false });
  const [entry] = await logOf(ok.tmp);
  assert.deepEqual(entry.data.counted, ['topic-aaaaaaaaaaaa']);
  assert.equal(entry.data.noted.asked['topic-aaaaaaaaaaaa'].startsWith('Balanced Delimiters / Nesting: Write a function'), true, 'the note text is in the log');
  const broken = notedHistory();
  broken.record = async () => { throw new Error('disk gone'); };
  const bad = await startOf({ deps: deps(broken) });
  await bad.service.start(ARGS);
  await bad.service.answer();
  await bad.service.hangUp({ feedback: false });
  assert.deepEqual((await logOf(bad.tmp)).map(line => line.data), [{ error: 'disk gone' }]);
});

test('notes: a topic with no problem is noted by what the interviewer said, an unanswered one or one with no words by nothing, a repeat once', async () => {
  const history = notedHistory();
  const { service } = await startOf({ deps: { loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS, engineFactory: topicEngine([3, 4], { 3: 'Good. Which index would you add for a slow join? And why that one?' }, [3, 4]) } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.deepEqual(history.written[0].extra, { asked: { 'topic-aaaaaaaaaaaa': 'Which index would you add for a slow join? And why that one?' }, own: '' }, 'question sentences only; topic 4 has neither a problem nor words, so no placeholder');
  const none = notedHistory();
  const idle = await startOf({ deps: { loadCards: async () => SCOPED_CARDS, questionHistory: none, storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS, engineFactory: topicEngine([3], { 3: 'Tell me about indexes?' }, []) } });
  await idle.service.start(ARGS);
  await idle.service.answer();
  await idle.service.hangUp({ feedback: false });
  assert.deepEqual([none.recorded, none.written], [[], []], 'asked but unanswered: nothing counted, nothing noted');
});

test('notes: the next start gives the planner and the interviewer what earlier calls asked, and a history without notes still works', async () => {
  const history = notedHistory({}, { asked: { 'topic-aaaaaaaaaaaa': ['Tune a join', 'Explain an index'] }, own: ['Size a team', 'Plan a launch'] });
  const harness = recordingPrompts();
  const planner = fakePlanner();
  const { service } = await startOf({ deps: { prompts: harness.prompts, planCall: planner, loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS } });
  await service.start(ARGS);
  assert.deepEqual(planner.calls[0].pool.map(item => item.notes), [undefined, undefined, ['Tune a join', 'Explain an index'], undefined], 'only a topic with notes carries them');
  assert.deepEqual(planner.calls[0].earlierOwnQuestions, ['Size a team', 'Plan a launch']);
  assert.equal(harness.built.find(item => item.kind === 'main').options.plan.some(item => item.notes), false, 'the interviewer is not shown the notes of a topic this call does not ask');
  // The interviewer sees them only for a picked topic it must still make up a question for: with a prepared problem it
  // would be told to differ from the very exercise it was handed.
  const mainPlanOf = async change => {
    const built = recordingPrompts();
    const made = await startOf({ deps: { prompts: built.prompts, planCall: fakePlanner(voices => soloPlan(voices, change(voices))), loadCards: async () => SCOPED_CARDS, questionHistory: history, storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS } });
    await made.service.start(ARGS);
    return built.built.find(item => item.kind === 'main').options.plan;
  };
  const spokenTopic = await mainPlanOf(voices => ({ questions: [{ number: 3, askedBy: voices[0].key, minutes: 10, probes: [] }] }));
  assert.deepEqual(spokenTopic.map(item => item.notes), [undefined, undefined, ['Tune a join', 'Explain an index'], undefined]);
  const preparedTopic = await mainPlanOf(voices => ({
    questions: [{ number: 3, askedBy: voices[0].key, minutes: 10, probes: [] }],
    problems: [{ ref: 'p1', question: 3, language: '', parts: [{ title: 'Slow join', content: 'Find why this join is slow.' }], solution: 'An index.', edgeCases: [], hints: [] }],
  }));
  assert.equal(preparedTopic.some(item => item.notes), false);
  const plain = fakePlanner();
  const old = await startOf({ deps: { planCall: plain, loadCards: async () => SCOPED_CARDS, questionHistory: memoryHistory(), storeKey: async () => 'posting:abc', loadTopics: async () => TOPICS } });
  assert.equal((await old.service.start(ARGS)).phase, 'ringing');
  assert.deepEqual(plain.calls[0].earlierOwnQuestions, []);
  assert.equal(plain.calls[0].pool.some(item => item.notes), false);
});

test('the call writes a debug log: phases, setup steps, engine events, session messages, hang-up and notes', async () => {
  const sent = [];
  const { tmp, service, engine } = await liveCall({ deps: {
    debugFs: nodeFs,
    sessionsFactory: () => ({ start: async () => {}, turn: async message => { sent.push(message); return 'ok'; } }),
  } });
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'timing', firstTokenMs: 410, key: 'sk-secret', pcm: new Uint8Array(8), path: '/etc/passwd' });
  engine()({ type: 'opener', text: 'Right.', spoken: true, words: 1, ms: 700, outcome: 'spoken' });
  service.sendChat('typed line');
  await service.hangUp({ feedback: false });
  const file = path.join(tmp, 'practice-calls', 'call-1', 'debug.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const named = name => lines.filter(line => line.event === name);
  assert.equal(named('start').length, 1);
  assert(named('phase').some(line => line.data.phase === 'in-call'));
  assert(named('setup-step').length > 0 && named('setup-timing').some(line => line.data.name === 'plan'));
  assert(named('note').some(line => line.data.message.startsWith('voices drawn')));
  const timing = named('engine').find(line => line.data.type === 'timing').data;
  assert.equal(timing.firstTokenMs, 410);
  assert(!('key' in timing) && !('pcm' in timing), 'secrets and audio are left out');
  assert.equal(timing.path, '/etc/passwd');
  assert.equal(named('engine').find(line => line.data.type === 'opener').data.outcome, 'spoken');
  assert(named('user').some(line => line.data.action === 'chat' && line.data.text === 'typed line'));
  assert(named('finish').some(line => line.data.reason === 'candidate'));
  assert.equal(named('record-saved').length, 1);
  assert(lines.every(line => typeof line.t === 'string' && 'ms' in line));
  assert(lines.some(line => typeof line.ms === 'number'), 'the call clock runs once answered');
  assert.equal((await nodeFs.stat(file)).mode & 0o077, 0);
  assert(!JSON.stringify(lines).includes('key-should-never-be-logged'));
});

test('the helper\'s injection capability reaches the engine, inject commands pass through untouched, and inject events are logged without text or audio', async () => {
  const sent = [];
  const engineSaw = [];
  let fire = () => {};
  let audioSeen = null;
  const { tmp, service } = await liveCall({ deps: {
    debugFs: nodeFs,
    helperFactory: ({ onEvent }) => {
      fire = onEvent;
      return {
        start: async () => ({ ok: true }), stop: async () => { onEvent({ type: 'recording', state: 'closed' }); },
        play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {},
        canInject: () => true,
        inject: (...args) => { sent.push(['inject', ...args]); return true; },
        injectAudio: (...args) => { sent.push(['injectAudio', args[0], args[1].length]); return true; },
        injectEnd: (...args) => { sent.push(['injectEnd', ...args]); return true; },
        injectCancel: (...args) => { sent.push(['injectCancel', ...args]); return true; },
      };
    },
    engineFactory: options => {
      audioSeen = options.audio;
      return { start() {}, hangUp() {}, helperEvent: event => engineSaw.push(event), state: () => ({ transcript: [], elapsedMs: 0 }), typed() {} };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.equal(audioSeen.canInject(), true);
  audioSeen.inject('line1', 24000);
  audioSeen.injectAudio('line1', Buffer.alloc(8));
  audioSeen.injectEnd('line1');
  audioSeen.injectCancel('line1', 60);
  assert.deepEqual(sent, [['inject', 'line1', 24000], ['injectAudio', 'line1', 8], ['injectEnd', 'line1'], ['injectCancel', 'line1', 60]]);
  fire({ type: 'inject', utteranceId: 'line1', state: 'started', positionMs: 0, atMs: 1200 });
  fire({ type: 'inject', utteranceId: 'line1', state: 'position', positionMs: 50, atMs: 1250 });
  fire({ type: 'inject', utteranceId: 'line1', state: 'finished', positionMs: 3000, atMs: 4200 });
  assert.deepEqual(engineSaw.filter(event => event.type === 'inject').map(event => event.state), ['started', 'position', 'finished']);
  await service.hangUp({ feedback: false });
  const lines = (await readFile(path.join(tmp, 'practice-calls', 'call-1', 'debug.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const injects = lines.filter(line => line.event === 'inject');
  assert.deepEqual(injects.map(line => line.data.state), ['started', 'finished'], 'the 50 ms positions are not logged');
  assert.deepEqual(Object.keys(injects[0].data).sort(), ['atMs', 'positionMs', 'state', 'utteranceId']);
});

test('a helper without injection reports no capability to the engine, and the inject calls do nothing', async () => {
  let audioSeen = null;
  const { service } = await liveCall({ deps: {
    engineFactory: options => { audioSeen = options.audio; return { start() {}, hangUp() {}, helperEvent() {}, state: () => ({ transcript: [], elapsedMs: 0 }), typed() {} }; },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.equal(audioSeen.canInject(), false);
  assert.equal(audioSeen.inject('line1', 24000), undefined);
});

test('a call that failed in setup keeps its debug log and nothing else', async () => {
  const { tmp, service } = await liveCall({ deps: { debugFs: nodeFs, planCall: async () => { throw new Error('planner exploded'); } } });
  assert.equal((await service.start(ARGS)).phase, 'error');
  await flush();
  await new Promise(resolve => setTimeout(resolve, 50));
  const dir = path.join(tmp, 'practice-calls', 'call-1');
  assert.deepEqual(await nodeFs.readdir(dir), ['debug.jsonl']);
  const text = await readFile(path.join(dir, 'debug.jsonl'), 'utf8');
  assert(text.includes('planner exploded') && text.includes('"code":"plan-failed"'));
});

test('a service with no appendFile writes no debug log and still removes an abandoned folder', async () => {
  const { tmp, service } = await liveCall({ deps: { planCall: async () => { throw new Error('planner exploded'); } } });
  await service.start(ARGS);
  await flush();
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(nodeFs.stat(path.join(tmp, 'practice-calls', 'call-1')));
});

// --- staggered departures, the record's thresholds and pause spans, the voice description ---

const THREE_VOICES = ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-5'];
const TWO_COLLEAGUES = [{ voice: 'V2', role: 'Senior Engineer', focus: 'system design' }, { voice: 'V3', role: 'Director', focus: '' }];
/** A started three-interviewer call (A, B, C all there from the start) whose random draws a test queues. */
async function threeInterviewers({ draws = [], deps = {} } = {}) {
  const queue = [];
  const setup = panelHarness({ random: () => (queue.length ? queue.shift() : 0.9), voices: THREE_VOICES, cast: TWO_COLLEAGUES, deps });
  const typed = [];
  const makeEngine = setup.overrides.engineFactory;
  setup.overrides.engineFactory = options => { const engine = makeEngine(options); engine.typed = text => typed.push(text); return engine; };
  const built = await panelStart(setup);
  await built.service.answer();
  queue.push(...draws);
  const departures = () => setup.clock.pending().filter(isDeparture);
  return { setup, built, service: built.service, typed, queue, departures, ended: reason => setup.engineOptions[0].onEvent({ type: 'ended', reason }) };
}
const statuses = service => service.getState().participants.map(item => `${item.id}:${item.status}`);

test('departures: each interviewer leaves on their own random delay of 1.0 to 3.0 s after the farewell, the notice only after the last', async () => {
  const call = await threeInterviewers({ draws: [0.5, 0, 0.99] });
  const { setup, service } = call;
  const start = setup.clock.now();
  const events = [];
  service.onEvent?.(event => events.push(event));
  call.ended('interviewer');
  assert.deepEqual(call.departures().map(timer => timer.ms), [2000, 1000, 3000], 'A, B and C each drew their own delay, in steps of 0.1 s');
  assert.deepEqual(statuses(service), ['A:joined', 'B:joined', 'C:joined']);
  assert.equal(service.getState().interviewerLeft, false);
  const [a, b, c] = call.departures();
  setup.clock.setNow(start + 1000);
  setup.clock.fire(b);
  assert.deepEqual(statuses(service), ['A:joined', 'B:left', 'C:joined'], 'the shortest delay leaves first');
  assert.equal(service.getState().interviewerLeft, false);
  setup.clock.setNow(start + 2000);
  setup.clock.fire(a);
  assert.deepEqual(statuses(service), ['A:left', 'B:left', 'C:joined']);
  assert.equal(service.getState().interviewerLeft, false, 'no notice while someone is still on the call');
  setup.clock.setNow(start + 3000);
  setup.clock.fire(c);
  assert.deepEqual(statuses(service), ['A:left', 'B:left', 'C:left']);
  assert.equal(service.getState().interviewerLeft, true, 'the notice follows the last departure');
  assert.equal(service.getState().connectionLost, false);
  assert.deepEqual(events.filter(event => event.type === 'participant-left').map(event => [event.id, event.atMs]), [['B', 1000], ['A', 2000], ['C', 3000]]);
  assert.equal((await service.hangUp()).phase, 'replay');
  const record = await call.built.deps.store.readRecord('call-1');
  assert.equal(record.reason, 'interviewer');
  assert.equal(record.persona.leftAtMs, 2000);
  assert.deepEqual(record.panel.map(entry => [entry.id, entry.leftAtMs]), [['B', 1000], ['C', 3000]]);
  assert.equal(record.interviewerLeftAtMs, 3000, 'the last departure');
});

test('departures: the delay is 1.0 to 3.0 s in steps of 0.1 s whatever the draw', async () => {
  const delays = [];
  for (const value of [0, 0.049, 0.05, 0.5, 0.95, 0.9999, 1, Number.NaN]) {
    let draw = 0.9;
    const setup = panelHarness({ random: () => draw, cast: [] });
    const built = await panelStart(setup);
    await built.service.answer();
    draw = value;
    setup.engineOptions[0].onEvent({ type: 'ended', reason: 'interviewer' });
    delays.push(setup.clock.pending().filter(isDeparture).map(timer => timer.ms)[0]);
    await built.service.hangUp();
  }
  assert.deepEqual(delays, [1000, 1100, 1100, 2000, 2900, 3000, 3000, 1000]);
});

test('departures: while they leave nothing reaches a session, the chat takes a line without an answer, and the pad and pause are closed', async () => {
  const call = await threeInterviewers({ draws: [0, 0, 0] });
  call.ended('interviewer');
  const before = call.setup.engineCalls.length;
  const state = call.service.sendChat('thanks, bye');
  assert.deepEqual(state.chat.map(item => [item.from, item.text]), [['candidate', 'thanks, bye']]);
  assert.deepEqual(call.typed, [], 'the engine (and so every session) is never sent it');
  call.service.setPaused(true);
  assert.equal(call.service.getState().paused, false);
  assert.equal(call.setup.engineCalls.length, before, 'no engine call of any kind');
  await call.service.hangUp();
});

test('departures: a hang-up during the stagger finishes the call normally and cancels the pending departures', async () => {
  const call = await threeInterviewers({ draws: [0, 0.5, 0.99] });
  const start = call.setup.clock.now();
  call.ended('interviewer');
  const [a] = call.departures();
  call.setup.clock.setNow(start + 1000);
  call.setup.clock.fire(a);
  assert.equal(call.service.getState().interviewerLeft, false);
  const pending = call.departures();
  assert.equal(pending.length, 2);
  const state = await call.service.hangUp();
  assert.equal(state.phase, 'replay');
  assert.equal(call.departures().length, 0, 'no departure timer outlives the call');
  assert.equal(call.setup.clock.pending().length, 0, 'no timer of any kind is left');
  // A clock that ignores clearTimeout still changes nothing.
  for (const timer of pending) { timer.cleared = false; call.setup.clock.fire(timer); }
  assert.equal(call.service.getState().interviewerLeft, false);
  const record = await call.built.deps.store.readRecord('call-1');
  assert.equal(record.reason, 'interviewer', 'the interviewer ended it, so the candidate is not faulted');
  assert.equal(record.persona.leftAtMs, 1000);
  assert.equal(record.panel.every(entry => entry.leftAtMs === undefined), true, 'those still on the call have no departure');
  assert.equal(record.interviewerLeftAtMs, undefined);
});

test('departures: closing the window during the stagger clears the departures too', async () => {
  const call = await threeInterviewers({ draws: [0, 0, 0] });
  call.ended('interviewer');
  assert.equal(call.departures().length, 3);
  await call.service.abandon();
  assert.equal(call.departures().length, 0);
  assert.equal(call.setup.clock.pending().length, 0);
});

test('departures: a lost connection drops everyone at once, with no timers', async () => {
  const call = await threeInterviewers({ draws: [0.5, 0.5, 0.5] });
  const start = call.setup.clock.now();
  call.setup.clock.setNow(start + 7000);
  call.ended('session-error');
  assert.equal(call.departures().length, 0, 'nobody waits');
  assert.deepEqual(statuses(call.service), ['A:left', 'B:left', 'C:left']);
  const state = call.service.getState();
  assert.equal(state.interviewerLeft, true);
  assert.equal(state.connectionLost, true);
  await call.service.hangUp();
  const record = await call.built.deps.store.readRecord('call-1');
  assert.equal(record.reason, 'session-error');
  assert.equal(record.interviewerLeftAtMs, 7000);
  assert.deepEqual([record.persona.leftAtMs, ...record.panel.map(entry => entry.leftAtMs)], [7000, 7000, 7000]);
});

test('departures: a colleague who had not joined yet is not on the call to leave', async () => {
  const setup = panelHarness({ late: true });
  const built = await panelStart(setup);
  await built.service.answer();
  setup.engineOptions[0].onEvent({ type: 'ended', reason: 'interviewer' });
  assert.equal(setup.clock.pending().filter(isDeparture).length, 1, 'only the lead');
  await built.service.hangUp();
});

test('the record carries the engine thresholds, merged with the ones the service was given', async () => {
  const plain = await startOf({ modelReady: true });
  await plain.service.start(ARGS);
  await plain.service.answer();
  await plain.service.hangUp();
  assert.deepEqual((await plain.deps.store.readRecord('call-1')).thresholds, DEFAULT_CALL_THRESHOLDS);
  const tuned = await startOf({ modelReady: true, deps: { thresholds: { commitMs: 999 } } });
  await tuned.service.start(ARGS);
  await tuned.service.answer();
  await tuned.service.hangUp();
  assert.deepEqual((await tuned.deps.store.readRecord('call-1')).thresholds, { ...DEFAULT_CALL_THRESHOLDS, commitMs: 999 });
});

test('pause spans are recorded on the recording timeline, an open one closes at hang-up, and the replay carries them with pausedMs and activeMs', async () => {
  const setup = panelHarness({ cast: [] });
  const built = await panelStart(setup);
  await built.service.answer();
  const start = setup.clock.now();
  const emit = setup.engineOptions[0].onEvent;
  setup.clock.setNow(start + 5000);
  emit({ type: 'paused', paused: true });
  setup.clock.setNow(start + 6000);
  emit({ type: 'paused', paused: false });
  setup.clock.setNow(start + 8000);
  emit({ type: 'paused', paused: true });
  setup.clock.setNow(start + 8500);
  await built.service.hangUp();
  const record = await built.deps.store.readRecord('call-1');
  const lead = record.recordingLeadMs;
  assert.deepEqual(record.pauseSpans, [{ startMs: 5000 + lead, endMs: 6000 + lead }, { startMs: 8000 + lead, endMs: 8500 + lead }]);
  assert.equal(record.pausedMs, 1500);
  const replay = await built.service.getReplay('call-1');
  assert.deepEqual(replay.pauseSpans, record.pauseSpans);
  assert.equal(replay.pausedMs, 1500);
  assert.equal(replay.activeMs, replay.durationMs - 1500);
  assert.equal(replay.durationMs, record.durationMs);
  const listed = await built.deps.store.list(record.nodeId);
  assert.equal(listed.find(item => item.callId === 'call-1')?.pausedMs, 1500);
});

test('the replay says the call was typed only when its review did, and says nothing otherwise', async () => {
  const built = await startOf({ modelReady: true });
  await built.service.start(ARGS);
  await built.service.answer();
  await built.service.hangUp();
  assert.equal((await built.service.getReplay('call-1')).analysis.metrics, undefined);
  await built.deps.store.writeAnalysis('call-1', { callId: 'call-1', status: 'ready', metrics: { typedOnly: true } });
  assert.deepEqual((await built.service.getReplay('call-1')).analysis.metrics, { typedOnly: true });
});

test('a call with no pause has empty pause spans and an active length equal to its length', async () => {
  const built = await startOf({ modelReady: true });
  await built.service.start(ARGS);
  await built.service.answer();
  await built.service.hangUp();
  const replay = await built.service.getReplay('call-1');
  assert.deepEqual(replay.pauseSpans, []);
  assert.equal(replay.pausedMs, 0);
  assert.equal(replay.activeMs, replay.durationMs);
});

test('the voice description sent to the planner has no repeats and is cut at a word under 300 characters', async () => {
  const long = 'Professional American male voice for AI assistants, virtual assistants, customer support, business tools, SaaS apps, productivity workflows, chatbots, onboarding, help desks, explainer content, photo narration, audiobooks, documentaries and many other uses that go on and on for a very long while indeed';
  const run = async (character, description) => {
    const setup = panelHarness({ cast: [] });
    const drawVoice = setup.overrides.voiceLibrary.drawVoice;
    setup.overrides.voiceLibrary = { ...setup.overrides.voiceLibrary, drawVoice: async options => { const drawn = await drawVoice(options); return { ...drawn, voice: { ...drawn.voice, description } }; } };
    setup.overrides.catalog = { pickPersonaVoice: options => ({ voiceId: options.voices[0].voiceId, name: PANEL_VOICES[options.voices[0].voiceId], character }) };
    await panelStart(setup);
    return setup.planner.calls[0].voices[0].description;
  };
  const text = await run({ role: 'Professional AI Assistant', mood: 'casual', copy: `${long.slice(0, 120)}` }, long);
  assert.equal(text.length <= 300, true);
  assert.equal(text.startsWith('Professional AI Assistant. casual. Professional American male voice'), true);
  assert.equal(text.split('Professional American male voice').length, 2, 'the cut-off copy is dropped, the long text kept once');
  assert.equal(text.endsWith('…'), true);
  assert.equal(long.includes(text.slice(text.indexOf('. casual. ') + 10, -1)), true, 'it ends on a whole word of the source');
  assert.equal(/\s…$/u.test(text), false);
  // A short one is kept whole with one full stop, duplicates dropped.
  assert.equal(await run({ a: 'Warm', b: 'warm', c: 'Calm and even' }, 'Calm and even.'), 'Warm. Calm and even.');
});

test('draftAnswer: off without draftText, refused before the call is answered, and writes from the call context once in it', async () => {
  const transcript = [{ speaker: 'interviewer', text: 'Why this role?' }];
  const engineFactory = () => ({ start() {}, hangUp() {}, typed() {}, state: () => ({ transcript, elapsedMs: 0 }) });
  const off = await liveCall({ deps: { engineFactory } });
  await off.service.start(ARGS);
  await off.service.answer();
  assert.deepEqual(await off.service.draftAnswer(), { error: 'Suggestions are not available.' });
  await off.service.hangUp({ feedback: false });

  const seen = [];
  const reads = { career: 0, listing: 0 };
  const { service } = await liveCall({ deps: {
    engineFactory,
    draftText: async () => 'unused',
    loadCareerDocuments: async args => { reads.career += 1; assert.equal(args.snapshotId, ARGS.snapshotId); return 'Career text line.'; },
    loadListing: async args => { reads.listing += 1; assert.equal(args.artifactId, ARGS.bundleArtifactId); return 'Listing text line.'; },
    draftAnswer: async request => { seen.push(request); return 'Because it fits.'; },
  } });
  await service.start(ARGS);
  assert.deepEqual(await service.draftAnswer(), { error: 'No one is waiting for an answer.' }, 'nothing before the call is answered');
  await service.answer();
  assert.deepEqual(await service.draftAnswer(), { text: 'Because it fits.' });
  assert.deepEqual(await service.draftAnswer(), { text: 'Because it fits.' });
  assert.deepEqual(reads, { career: 1, listing: 1 }, 'career text and listing are read once per call');
  const [request] = seen;
  assert.equal(request.careerText, 'Career text line.');
  assert.equal(request.listingText, 'Listing text line.');
  assert.equal(request.application.resume, 'Synthetic resume text.');
  assert.deepEqual(request.transcript, transcript);
  assert.equal(request.brief.company, 'Acme');
  assert.equal(request.timing.elapsedMs, 0);
  assert.equal(request.timing.questionMinutes, undefined, 'no question has been asked yet, so no minutes are made up');
  assert.equal(request.screen, null, 'nothing has been shared, so no screen goes with the suggestion');
  assert.equal(typeof request.callText, 'function');
  assert(request.signal instanceof AbortSignal);
  assert(request.pool.some(card => card.question === CARD.question && card.answer));
  assert.equal(service.getState().chat.length, 0, 'nothing is sent to the chat');
  await service.hangUp({ feedback: false });
  assert.deepEqual(await service.draftAnswer(), { error: 'No one is waiting for an answer.' });
});

test('draftAnswer: with the coding pad open the wand works the exercise as steps, when the app passes that call in', async () => {
  let emit;
  const engineFactory = options => { emit = options.onEvent; return { start() {}, hangUp() {}, typed() {}, setPadText() {}, state: () => ({ transcript: [{ speaker: 'interviewer', text: 'Write it in the pad.' }], elapsedMs: 0 }) }; };
  const seen = [];
  const { service } = await liveCall({ deps: {
    engineFactory, draftText: async () => 'unused', draftWorkText: async () => 'unused',
    loadCareerDocuments: async () => 'c', loadListing: async () => 'l',
    draftAnswer: async () => 'Just talking.',
    draftWork: async request => { seen.push(request); return [{ say: 'First the signature.', code: 'def f():\n', order: 'during', together: true }, { say: 'Now the body.', code: 'def f():\n    pass\n', order: 'after', together: false }, { say: 'Done.', code: null, together: false }]; },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.deepEqual(await service.draftAnswer(), { text: 'Just talking.' }, 'no pad: a spoken reply');
  emit({ type: 'pad', open: true, lang: 'python', atMs: 1000 });
  assert.deepEqual(await service.draftAnswer(), { steps: [{ say: 'First the signature.', code: 'def f():\n', order: 'during', together: true }, { say: 'Now the body.', code: 'def f():\n    pass\n', order: 'after', together: false }, { say: 'Done.', code: null, order: 'before', together: false }] }, 'each step keeps when its line is said: before, during or after its typing');
  assert.equal(seen[0].pad.open, true);
  assert.equal(typeof seen[0].callText, 'function');
  await service.hangUp({ feedback: false });
});

test('draftAnswer: pausing neither refuses a suggestion nor stops one being written', async () => {
  const engineFactory = () => ({ start() {}, hangUp() {}, setPaused() {}, state: () => ({ transcript: [], elapsedMs: 0 }) });
  let release;
  let aborted = false;
  const { service } = await liveCall({ deps: {
    engineFactory, draftText: async () => '', loadCareerDocuments: async () => 'c', loadListing: async () => 'l',
    draftAnswer: async ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true; });
      await new Promise(resolve => { release = resolve; });
      return 'Written anyway.';
    },
  } });
  await service.start(ARGS);
  await service.answer();
  const during = service.draftAnswer();
  await flush();
  service.setPaused(true);
  release();
  assert.deepEqual(await during, { text: 'Written anyway.' }, 'a pause after it started does not stop it');
  assert.equal(aborted, false);
  const whilePaused = service.draftAnswer();
  await flush();
  release();
  assert.deepEqual(await whilePaused, { text: 'Written anyway.' }, 'a suggestion can be asked for while paused');
  await service.hangUp({ feedback: false });
});

test('muted: the wand writes nothing, a line is not sent, a suggestion being written is dropped, and the call says so', async () => {
  const muted = [];
  const typedLines = [];
  const engineFactory = () => ({ start() {}, hangUp() {}, setMuted(value) { muted.push(value); }, typed(text) { typedLines.push(text); return true; }, state: () => ({ transcript: [], elapsedMs: 0 }) });
  let release;
  let aborted = false;
  let drafts = 0;
  let helperEvent;
  const { service } = await liveCall({ deps: {
    engineFactory, draftText: async () => '', loadCareerDocuments: async () => 'c', loadListing: async () => 'l',
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
    draftAnswer: async ({ signal }) => {
      drafts += 1;
      signal.addEventListener('abort', () => { aborted = true; release?.(); });
      await new Promise(resolve => { release = resolve; });
      if (signal.aborted) throw new Error('aborted');
      return 'Written.';
    },
  } });
  await service.start(ARGS);
  await service.answer();
  helperEvent({ type: 'muted-speech', atMs: 10 });
  assert.equal(service.getState().mutedHint, null, 'talking with the mic on is no hint');
  // Muted while a suggestion is being written: it is aborted and never spoken.
  const during = service.draftAnswer();
  await flush();
  service.setMuted(true);
  assert.deepEqual(muted, [true], 'the engine hears of the mute and cuts what it is saying');
  assert.equal(aborted, true, 'nothing more is spent on it');
  assert.deepEqual(await during, { muted: true });
  // Pressed while muted: nothing is written at all.
  assert.deepEqual(await service.draftAnswer(), { muted: true });
  assert.equal(drafts, 1, 'no suggestion is written while muted');
  assert.deepEqual(service.getState().mutedHint, { id: 1, reason: 'wand' });
  const chatBefore = service.getState().chat.length;
  const refused = service.sendChat('Hello?');
  assert.equal(refused.muted, true);
  assert.equal(service.getState().chat.length, chatBefore, 'a line sent while muted is not posted');
  assert.deepEqual(typedLines, [], 'nor heard');
  assert.deepEqual(service.getState().mutedHint, { id: 2, reason: 'chat' });
  helperEvent({ type: 'muted-speech', atMs: 20 });
  assert.deepEqual(service.getState().mutedHint, { id: 3, reason: 'speech' }, 'talking into the muted mic');
  service.setMuted(false);
  assert.deepEqual(muted, [true, false]);
  assert.equal(service.getState().mutedHint, null);
  service.sendChat('Hello?');
  assert.deepEqual(typedLines, ['Hello?'], 'after unmuting it goes out as ever');
  service.setMuted(true);
  await service.draftAnswer();
  assert.deepEqual(service.getState().mutedHint, { id: 4, reason: 'wand' }, 'a hint after an unmute gets a new id, so the window shows it');
  await service.hangUp({ feedback: false });
});

test('draftAnswer: one at a time, a failure reads as a retryable error, and hanging up aborts the one in flight', async () => {
  const engineFactory = () => ({ start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) });
  let release;
  let aborted = null;
  let fail = false;
  const { service } = await liveCall({ deps: {
    engineFactory, draftText: async () => '', loadCareerDocuments: async () => 'c', loadListing: async () => { throw new Error('gone'); },
    logger: { warn() {} },
    draftAnswer: async ({ signal }) => {
      if (fail) throw new Error('model down');
      signal.addEventListener('abort', () => { aborted = true; release?.(); });
      await new Promise(resolve => { release = resolve; });
      if (signal.aborted) throw new Error('aborted');
      return 'late';
    },
  } });
  await service.start(ARGS);
  await service.answer();
  fail = true;
  assert.deepEqual(await service.draftAnswer(), { error: 'Could not suggest a reply. Try again.' });
  fail = false;
  const first = service.draftAnswer();
  await flush();
  assert.deepEqual(await service.draftAnswer(), { error: 'A suggestion is already being written.' });
  await service.hangUp({ feedback: false });
  assert.equal(aborted, true, 'hanging up aborts the call in flight');
  assert.deepEqual(await first, { error: 'The call has ended.' });
});

test('a line the AI voice spoke through the microphone is stamped voiced and generated on the transcript, without overwriting what is set', () => {
  const spans = [
    { startMs: 10000, endMs: 20000, generated: true, whole: true, text: 'Plan two words.' },
    { startMs: 40000, endMs: 50000, generated: false, whole: true, text: 'typed by hand' },
    { startMs: 60000, endMs: 70000, generated: true, whole: false, text: 'cut line and the unplayed rest', heardText: 'cut line' },
  ];
  const transcript = [
    { speaker: 'interviewer', text: 'Question.', startMs: 0, endMs: 9000 },
    { speaker: 'candidate', text: 'Plan plan two words words.', startMs: 10500, endMs: 19500 },
    { speaker: 'candidate', text: 'my own words', startMs: 30000, endMs: 35000 },
    { speaker: 'candidate', text: 'hand line', startMs: 40500, endMs: 49000 },
    { speaker: 'candidate', text: 'cut', startMs: 61000, endMs: 66000, voiced: true },
    { speaker: 'candidate', text: 'straddles', startMs: 19000, endMs: 30000 },
  ];
  const stamped = stampInjectedLines(transcript, spans);
  assert.deepEqual(stamped[1], { ...transcript[1], voiced: true, generated: true, sentText: 'Plan two words.', lineSpans: [{ startMs: 10000, endMs: 20000 }] });
  assert.equal(stamped[0], transcript[0]);
  assert.equal(stamped[2], transcript[2], 'live speech is untouched');
  assert.equal(stamped[3], transcript[3], 'a line that was not generated is not stamped');
  assert.deepEqual(stamped[4], { ...transcript[4], generated: true, sentText: 'cut line', lineSpans: [{ startMs: 60000, endMs: 70000 }] }, 'a cut line is stamped with the part that was heard as its sent text, and voiced stays as it was');
  assert.equal(stamped[5], transcript[5], 'an entry mostly outside the span is not the line');
  assert.equal(stampInjectedLines(transcript, []), transcript);
  // Two entries inside one span: the sent text belongs to neither.
  const split = stampInjectedLines([
    { speaker: 'candidate', text: 'a', startMs: 10000, endMs: 14000 }, { speaker: 'candidate', text: 'b', startMs: 15000, endMs: 19000 },
  ], [spans[0]]);
  assert.equal(split.every(entry => entry.generated === true && entry.sentText === undefined), true);
});

test('one recognised entry that joins several AI-voice lines (a worked exercise with typing between them) is stamped, with their texts joined', () => {
  // Call of 2026-11-22: seven lines of 9 to 21 s became one 116 s entry; none covered half of it, so it went unstamped.
  const spans = [
    { startMs: 10000, endMs: 25000, generated: true, whole: true, text: 'First I restate it.' },
    { startMs: 30000, endMs: 45000, generated: true, whole: true, text: 'Then the graph.' },
    { startMs: 60000, endMs: 75000, generated: true, whole: true, text: 'Done.' },
  ];
  const entry = { speaker: 'candidate', text: 'first I restate it then the graph done', startMs: 10200, endMs: 74800 };
  const [stamped] = stampInjectedLines([entry], spans);
  assert.deepEqual(stamped, { ...entry, voiced: true, generated: true, sentText: 'First I restate it. Then the graph. Done.', lineSpans: spans.map(({ startMs, endMs }) => ({ startMs, endMs })) });
  const [mostlyLive] = stampInjectedLines([{ speaker: 'candidate', text: 'x', startMs: 0, endMs: 100000 }], spans);
  assert.equal(mostlyLive.generated, undefined, 'lines covering less than half of a long entry do not make it generated');
});

test('an entry made of whole AI-voice lines and one cut last line carries them joined, ending with the part that was heard', () => {
  const lines = [
    { startMs: 10000, endMs: 20000, generated: true, whole: true, text: 'First line. ' },
    { startMs: 22000, endMs: 32000, generated: true, whole: true, text: 'Second line.' },
  ];
  const entry = { speaker: 'candidate', text: 'recogniser words', startMs: 10200, endMs: 52000 };
  const cut = { startMs: 34000, endMs: 50000, generated: true, whole: false, text: 'Third line and the unplayed rest.', heardText: ' Third ' };
  const [stamped] = stampInjectedLines([entry], [...lines, cut]);
  assert.equal(stamped.sentText, 'First line. Second line. Third');
  assert.equal(stamped.generated, true);
  const [unheard] = stampInjectedLines([entry], [...lines, { ...cut, heardText: undefined }]);
  assert.equal(unheard.sentText, undefined, 'a cut line with nothing reported heard leaves the entry unstamped');
  assert.equal(unheard.generated, true);
  const [early] = stampInjectedLines([{ ...entry, endMs: 50000 }], [{ ...cut, startMs: 10000, endMs: 20000, text: 'x', heardText: 'x' }, { ...lines[1], startMs: 22000 }, { ...lines[0], startMs: 34000, endMs: 50000 }]);
  assert.equal(early.sentText, undefined, 'a cut line that is not the last one is not joined');
  const [whole] = stampInjectedLines([{ ...entry, endMs: 33000 }], lines);
  assert.equal(whole.sentText, 'First line. Second line.', 'whole lines join as before');
  // The cut line is shared with another entry: not this entry's alone, so nothing is stamped.
  const shared = stampInjectedLines([entry, { speaker: 'candidate', text: 'more', startMs: 40000, endMs: 49000 }], [...lines, cut]);
  assert.equal(shared[0].sentText, undefined);
});

test('draftTimingOf gives the active time, the planned length and the minutes of the question last asked, each only when known', () => {
  const self = { settledPlan: { questions: [{ number: 3, minutes: 1.5 }, { number: 1, minutes: 2 }, { number: 0, minutes: 1.5 }] } };
  assert.deepEqual(draftTimingOf(self, { elapsedMs: 283000, askedQuestions: [1, 3] }), { elapsedMs: 283000, plannedMs: 300000, questionMinutes: 1.5 });
  assert.deepEqual(draftTimingOf(self, { elapsedMs: 5000, askedQuestions: [] }), { elapsedMs: 5000, plannedMs: 300000 });
  assert.deepEqual(draftTimingOf(self, { askedQuestions: [9] }), { plannedMs: 300000 }, 'a question the plan does not hold has no minutes');
  assert.deepEqual(draftTimingOf({}, {}), {});
});

test('draftTimingOf reads the planned length the interviewer reads: the planner\'s call length when it has one, else the budgets', () => {
  const questions = [{ number: 1, minutes: 20 }, { number: 2, minutes: 17.5 }]; // budgets may reach 1.25 times the length
  assert.equal(draftTimingOf({ settledPlan: { callMinutes: 30, questions } }, {}).plannedMs, 30 * 60000, 'not 37:30 for a call that wraps up at 30:00');
  assert.equal(draftTimingOf({ settledPlan: { callMinutes: 30, questions: [{ number: 1, minutes: 5 }] } }, {}).plannedMs, 30 * 60000, 'and not the short sum of a few budgets');
  for (const callMinutes of [undefined, 0, -3, 'x', null]) {
    assert.equal(draftTimingOf({ settledPlan: { callMinutes, questions } }, {}).plannedMs, 37.5 * 60000, `a plan with length ${callMinutes} adds the budgets up`);
  }
});

test('draftTimingOf gives the planner\'s own question its minutes while it is the one in progress, and none when the state cannot tell', () => {
  const self = { settledPlan: { questions: [{ number: 0, minutes: 1 }, { number: 1, minutes: 4 }, { number: 2, minutes: 3 }] } };
  const own = { 0: 'What do you assume an attacker can do?' };
  // Nothing from the plan asked yet and the own question said: it is the question in progress, not the one before it.
  assert.equal(draftTimingOf(self, { askedQuestions: [], askedTexts: own }).questionMinutes, 1);
  // Before anything is said, no question is in progress.
  assert.equal('questionMinutes' in draftTimingOf(self, { askedQuestions: [], askedTexts: {} }), false);
  // Both asked: the engine keeps no order between the own question and the plan's, so no minutes rather than the wrong ones.
  assert.equal('questionMinutes' in draftTimingOf(self, { askedQuestions: [1], askedTexts: { ...own, 1: 'Tell me about a bug.' } }), false);
  // The own question was never asked: the last plan question's minutes stand, as before.
  assert.equal(draftTimingOf(self, { askedQuestions: [1, 2], askedTexts: { 1: 'x', 2: 'y' } }).questionMinutes, 3);
  // A plan with no question of its own and no state about it behaves as before.
  assert.equal(draftTimingOf({ settledPlan: { questions: [{ number: 1, minutes: 4 }] } }, { askedQuestions: [1] }).questionMinutes, 4);
});

test('the engine\'s spoken line is matched back to the sent messages it was joined from', () => {
  const fresh = () => [{ text: 'one', generated: false }, { text: 'two', generated: true }, { text: 'three', generated: true }];
  assert.equal(generatedRunFor(fresh(), 'two three'), true);
  assert.equal(generatedRunFor(fresh(), 'one'), false);
  assert.equal(generatedRunFor(fresh(), 'one two'), false, 'one typed message in the run makes it not generated');
  assert.equal(generatedRunFor(fresh(), 'nothing sent'), null);
  // The same words sent twice, typed then suggested: each spoken line takes its own message, newest first, once.
  const twice = [{ text: 'Yes, absolutely.', generated: false }, { text: 'Yes, absolutely.', generated: true }];
  assert.equal(generatedRunFor(twice, 'Yes, absolutely.'), true);
  assert.equal(generatedRunFor(twice, 'Yes, absolutely.'), false);
  assert.equal(generatedRunFor(twice, 'Yes, absolutely.'), null, 'a used message is not matched again');
});

// Seen 2026-11-23 (call-mwt3ga4p-jo97ab): the recogniser kept one segment open for 7.5 s past the cut of a line in the
// candidate's AI voice, and the record showed the candidate talking through the interviewer's reply.
const CUT_LINE = Object.freeze({ startMs: 1569300, endMs: 1577300, whole: false, generated: true, text: 'Checking the second example with n of two, the first one counts to one and outputs zero, the second one reaches zero and stops.', heardText: 'Checking the second example with n of two, the first one counts to one and outputs zero, the second one' });
test('a segment of a cut line that ran on past the cut is clamped only when it holds no word beyond the sent text', () => {
  const segment = (text, startMs = 1576140, endMs = 1584780) => ({ type: 'transcript', final: true, segmentId: 's1', text, startMs, endMs });
  const spans = [CUT_LINE];
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches'), spans), 1577800, 'the last words of the line, 7 s past the cut');
  assert.equal(clampedEndOfCutSegment(segment('The 2nd one reach'), spans), null, 'a form the sent text does not hold is not provably the voice');
  assert.equal(clampedEndOfCutSegment(segment('second one reaches zero and stops', 1576140, 1577350), spans), null, 'already inside the margin: nothing to clamp');
  assert.equal(clampedEndOfCutSegment(segment('Counts to 1 and outputs 0 the second one rea'), spans), 1577800, 'digits for number words and a trailing partial word');
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches and then I would add a guard'), spans), null, 'the candidate carried on: left as it is');
  assert.equal(clampedEndOfCutSegment(segment('Stops and reaches the second one'), spans), null, 'the words out of order are not the line');
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches'), [{ ...CUT_LINE, whole: true }]), null, 'a whole line is never clamped');
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches', 1578000, 1584780), spans), null, 'a segment that starts after the cut is not part of the line');
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches'), [CUT_LINE, { startMs: 1580000, endMs: 1581000, whole: true, text: 'Next.' }]), null, 'a later line inside the segment');
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches'), [{ ...CUT_LINE, text: undefined }]), null, 'a line with no known text');
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches', 1568000, 1584780), spans), null, 'a segment that began before the line did holds the candidate\'s own speech');
  assert.equal(clampedEndOfCutSegment(segment('The second one reaches'), [CUT_LINE, { startMs: 1560000, endMs: 1576500, whole: true, text: 'Earlier.' }]), null, 'an earlier line reaching into the segment');
});

test('the service hands the engine, the answer timings and the tone notes the clamped end of a cut line\'s segment', async () => {
  let helperEvent;
  let options;
  const heard = [];
  const noted = [];
  const { service } = await liveCall({ deps: {
    candidateVoices: true,
    candidateVoice: () => ({ open() { return { sendText() {}, finish: async () => {}, cancel() {} }; } }),
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
    earFactory: () => ({ noteSpeech: item => { noted.push(item); }, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] }),
    engineFactory: opts => {
      options = opts;
      return { start() { opts.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, helperEvent: event => heard.push(event), typed() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  const text = 'Checking the second example, the first one counts to one and the second one reaches zero.';
  service.sendChat(text, { generated: true });
  options.candidateVoice.open({ utteranceId: 'u1', text });
  helperEvent({ type: 'inject', utteranceId: 'u1', state: 'started', positionMs: 0, atMs: 1000 });
  helperEvent({ type: 'inject', utteranceId: 'u1', state: 'cancelled', positionMs: 8000, atMs: 9000 });
  helperEvent({ type: 'transcript', final: true, segmentId: 'a', text: 'The first one counts to one', startMs: 2000, endMs: 15000 });
  helperEvent({ type: 'transcript', final: true, segmentId: 'b', text: 'The first one counts to one and then I add more', startMs: 2000, endMs: 15000 });
  const finals = heard.filter(event => event.type === 'transcript');
  assert.deepEqual(finals.map(event => event.endMs), [9500, 15000], 'only the segment with no word of its own is clamped');
  assert.deepEqual(noted.map(item => item.endMs), [9500, 15000], 'the tone notes read the same ends');
});
