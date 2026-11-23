import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectedMarker, createPracticeCallEngine, DEFAULT_CALL_THRESHOLDS, JOIN_PAUSE_MS, joinPauseMs } from '../../electron/interviewPracticeCallEngine.js';
import { createReplyStreamParser, formatTurnMessage } from '../../electron/interviewPracticeCallPrompt.js';

// Synthetic data only: every name, sentence and word below is invented for the tests.

export function fakeClock() {
  let time = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { seq += 1; timers.set(seq, { fn, due: time + Math.max(0, ms), seq }); return seq; },
    clearTimeout(handle) { timers.delete(handle); },
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, item]) => item.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[1].seq - b[1].seq)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = Math.max(time, next[1].due);
        next[1].fn();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

export async function flush() { for (let step = 0; step < 25; step += 1) await Promise.resolve(); }

const cancelError = () => Object.assign(new Error('CANCELLED'), { name: 'AbortError', code: 'CANCELLED' });

function fakeSession(kind) {
  const session = { kind, calls: [], closed: false };
  session.close = () => { session.closed = true; };
  session.turn = (message, { signal, onDelta } = {}) => new Promise((resolve, reject) => {
    const call = { message, signal, onDelta, resolve, reject, settled: false };
    session.calls.push(call);
    signal?.addEventListener('abort', () => { if (!call.settled) { call.settled = true; reject(cancelError()); } });
  });
  session.answer = (text, { chunks = [text], index = session.calls.length - 1 } = {}) => {
    const call = session.calls[index];
    for (const chunk of chunks) call.onDelta?.(chunk);
    const parser = createReplyStreamParser();
    const sentences = [...chunks.flatMap(chunk => parser.push(chunk).sentences)];
    const last = parser.end();
    sentences.push(...last.sentences);
    call.settled = true;
    call.resolve({ text, control: last.control, endCall: last.endCall, sentences });
  };
  session.fail = (index = session.calls.length - 1) => { const call = session.calls[index]; call.settled = true; call.reject(new Error('boom')); };
  return session;
}

export const HELPER_OFFSET = 5000;

const bare = entry => { const rest = { ...entry }; delete rest.startMs; delete rest.endMs; return rest; };

export function makeRig({ autoOpener = false, thresholds, restartFails = false, ear = null, panel, speakerVoice = false, overlayVoice = speakerVoice, gapVoice = true, createParser, formatTurn, prepared, callback, candidateVoice, inject = false, random, watcher = false, formatWatch, parseWatch } = {}) {
  const clock = fakeClock();
  const events = [];
  const ops = [];
  const sessions = { opener: fakeSession('opener'), main: fakeSession('main'), classifier: fakeSession('classifier') };
  if (watcher) sessions.watcher = fakeSession('watcher');
  // A test that does not care about the acknowledgement lets the opener answer at once with nothing to say (dropped).
  if (autoOpener) {
    const turn = sessions.opener.turn;
    sessions.opener.turn = (message, options) => {
      const run = turn(message, options);
      const index = sessions.opener.calls.length - 1;
      queueMicrotask(() => { if (!sessions.opener.calls[index].settled) sessions.opener.answer('', { index }); });
      return run;
    };
  }
  const streams = [];
  const opens = [];
  const restarts = [];
  const audio = {
    play: (id, rate) => ops.push({ op: 'play', id, rate }),
    pushAudio: (id, buffer) => ops.push({ op: 'push', id, size: buffer.length }),
    endUtterance: id => ops.push({ op: 'end', id }),
    cancel: id => ops.push({ op: 'cancel', id }),
    pause: id => ops.push({ op: 'pause', id }),
    resume: id => ops.push({ op: 'resume', id }),
    mute: muted => ops.push({ op: 'mute', muted }),
    // The helper can mix a line into the microphone signal (status ready with inject:true) only when the test says so.
    canInject: () => inject === true,
    inject: (id, rate) => { ops.push({ op: 'inject', id, rate }); },
    injectAudio: (id, buffer) => { ops.push({ op: 'injectAudio', id, size: buffer.length }); },
    injectEnd: id => { ops.push({ op: 'injectEnd', id }); },
    injectCancel: (id, fadeMs) => { ops.push({ op: 'injectCancel', id, fadeMs }); },
  };
  const voice = {
    open(options) {
      const { utteranceId, signal } = options;
      opens.push(options);
      if (rig.failOpen) throw new Error('voice unavailable');
      const stream = { utteranceId, signal, texts: [], log: [], finished: false, cancelled: false, sampleRate: 24000 };
      stream.sendText = text => { stream.texts.push(text); stream.log.push({ text }); };
      // Records how many texts had been sent when the engine asked the voice to speak now.
      stream.flushes = [];
      stream.flush = () => { stream.flushes.push(stream.texts.length); return true; };
      if (speakerVoice) {
        // A panel voice stream: setSpeaker and onSpeaker exist, and the log keeps their order against the texts.
        stream.setSpeaker = (id, options) => { stream.log.push(options ? { speaker: id, options } : { speaker: id }); return true; };
        stream.onSpeaker = callback => { stream.speakerCb = callback; };
      }
      if (overlayVoice) {
        // A remark spoken over the current speaker: the request is logged in order with the texts; onOverlay reports its start.
        stream.overlays = [];
        stream.overlay = request => { stream.overlays.push(request); stream.log.push({ overlay: request }); return true; };
        stream.onOverlay = callback => { stream.overlayCb = callback; };
      }
      if (gapVoice) stream.gap = ms => { stream.log.push({ gap: ms }); return true; };
      stream.finish = () => { stream.finished = true; return Promise.resolve(); };
      stream.cancel = () => { stream.cancelled = true; };
      stream.onAudio = callback => { stream.audioCb = callback; };
      stream.onWords = callback => { stream.wordsCb = callback; };
      stream.audio = size => stream.audioCb(Buffer.alloc(size));
      stream.words = list => stream.wordsCb(list);
      streams.push(stream);
      return stream;
    },
  };
  let counter = 0;
  const restartSession = async (kind, info) => {
    restarts.push({ kind, ...info });
    if (rig.gate) await rig.gate.promise; // a test can hold a restart in flight
    if (restartFails) throw new Error('no restart');
    const fresh = fakeSession(kind);
    sessions[kind] = fresh;
    return fresh;
  };
  const engine = createPracticeCallEngine({
    clock, sessions: { ...sessions }, restartSession, audio, voice, ear, thresholds: { speculateMs: 600, joinGapMinLeadMs: Infinity, joinFlushLeadMs: Infinity, ...thresholds }, ...(panel ? { panel } : {}), ...(createParser ? { createParser } : {}), ...(formatTurn ? { formatTurn } : {}), ...(prepared ? { prepared } : {}), // the rig pins the 600 ms speculation point its timings assume, and leaves out the join pause and holds no first-sentence flush (both tested on their own); defaults are tested separately
    onEvent: event => events.push(event), newId: () => `utt${++counter}`,
    ...(callback ? { callback } : {}),
    ...(candidateVoice ? { candidateVoice } : {}),
    ...(random ? { random } : {}),
    ...(formatWatch ? { formatWatch } : {}), ...(parseWatch ? { parseWatch } : {}),
  });
  // The helper's clock is not the engine clock: helper atMs = clock ms - HELPER_OFFSET. Callers pass clock times.
  const helper = {
    vad: speaking => engine.helperEvent({ type: 'vad', speaking, atMs: clock.now() - HELPER_OFFSET }),
    transcript: (text, segmentId, startMs = clock.now(), final = false, endMs = clock.now()) =>
      engine.helperEvent({ type: 'transcript', text, segmentId, final, startMs: startMs - HELPER_OFFSET, endMs: endMs - HELPER_OFFSET }),
    playback: (utteranceId, state, positionMs = 0) =>
      engine.helperEvent({ type: 'playback', utteranceId, state, positionMs, atMs: clock.now() - HELPER_OFFSET }),
    inject: (utteranceId, state, positionMs = 0) =>
      engine.helperEvent({ type: 'inject', utteranceId, state, positionMs, atMs: clock.now() - HELPER_OFFSET }),
    level: () => engine.helperEvent({ type: 'level', rms: 0.1, atMs: clock.now() - HELPER_OFFSET }),
  };
  const rig = { clock, events, ops, opens, sessions, streams, restarts, engine, h: helper, live: sessions, failOpen: false, gate: null };
  rig.hold = () => {
    let release;
    rig.gate = { promise: new Promise(resolve => { release = resolve; }) };
    return () => { rig.gate = null; release(); };
  };
  rig.of = type => events.filter(event => event.type === type);
  rig.opsOf = op => ops.filter(item => item.op === op);
  return rig;
}

/** Answer the greeting and play it to the end; leaves the engine listening. */
export async function greet(rig, text = 'Hello, welcome to the call.') {
  rig.engine.start({ greeting: true });
  await flush();
  rig.h.level();
  rig.sessions.main.answer(text);
  rig.streams[0].audio(3200);
  await flush();
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
}

/** The candidate says `text`, then goes quiet. */
export async function speak(rig, text, segmentId) {
  rig.h.vad(true);
  rig.h.transcript(text, segmentId, rig.clock.now(), false, rig.clock.now() + 300);
  await rig.clock.advance(300);
  rig.h.vad(false);
}

const words = (...list) => list.map((word, index) => ({ word, startMs: index * 300, endMs: index * 300 + 280 }));

/** Candidate speaks and the turn is speculated (t = 600 ms after the last word). */
async function speculate(rig, text = 'I built a scheduler', segmentId = 'a') {
  await speak(rig, text, segmentId);
  await rig.clock.advance(600);
}

const suite = [];
const test = (name, run) => suite.push({ name: `interview practice engine: ${name}`, run });

test('exports the default thresholds and does no direct timing or I/O', () => {
  assert.deepEqual({ ...DEFAULT_CALL_THRESHOLDS }, {
    speculateMs: 500, commitMs: 1200, interruptWords: 2, interruptMs: 700, silencePromptMs: 20000, typingExpireMs: 6000, padIdleMs: 12000, padProgressMs: 25000, padTypingMs: 2500, turnTimeoutMs: 20000, classifierTimeoutMs: 2500,
    voiceGateMs: 1200,
    smartTurnHoldBelow: 0.5, smartTurnTimeoutMs: 300, holdSpeculateMs: 1500, holdCommitMs: 2500,
    smartTurnSureAbove: 0.85, unsureCommitMs: 1800, quietRelookMs: 3000, quietRelookMinGapMs: 1000, listenCheckInMs: 10000,
    floorBidAfterMs: 250, resumeDelayMs: 250, maxResumePauseMs: 1200, maxPausedMs: 2500, voiceNoteTimeoutMs: 150, openerDeadlineMs: 1500,
    joinFlushLeadMs: 900, joinGapMinLeadMs: 900,
    cutInFirstMs: 12000, cutInEveryMs: 10000, cutInMinLeftMs: 2500, candidateVoiceStartMs: 15000, cutInYieldMs: 2500, watchEveryMs: 2500, watchTimeoutMs: 2500, cutInHoldMs: 1500, cutInStaleWords: 12, cutInStaleMs: 5000, cutInStaleHardWords: 30, watchVetoBackoffMs: 10000, watchVetoWords: 40, cutInSentenceMaxMs: 5000, injectFinalWaitMs: 1200, voicedNoteWaitMs: 300,
    candidateYieldMinMs: 300, candidateYieldMaxMs: 900, candidateYieldFadeMs: 60, reactionGuard: 3,
  });
  assert(Object.isFrozen(DEFAULT_CALL_THRESHOLDS));
  const source = fs.readFileSync(new URL('../../electron/interviewPracticeCallEngine.js', import.meta.url), 'utf8');
  assert(!/Date\.now|performance\.now|console\./.test(source));
  assert(!/(^|[^.\w])setTimeout\(/.test(source), 'only clock.setTimeout may be used');
  assert(!/from 'node:/.test(source) && !/require\(/.test(source));
});

test('start sends only the connect message to main and speaks its reply without an opener', async () => {
  const rig = makeRig();
  assert.equal(rig.engine.state().phase, 'connecting');
  rig.engine.start({ greeting: true });
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.equal(rig.sessions.main.calls[0].message, '[elapsed 00:00] [call connected]');
  assert.equal(rig.sessions.opener.calls.length, 0);
  rig.sessions.main.answer('Hello, welcome.');
  rig.streams[0].audio(640);
  await flush();
  assert.deepEqual(rig.ops.map(item => item.op), ['play', 'push', 'end']);
  assert.equal(rig.engine.state().phase, 'committed');
  rig.h.playback('utt1', 'started');
  assert.equal(rig.engine.state().phase, 'playing');
  assert.deepEqual(rig.engine.state().transcript.map(bare), [{ speaker: 'interviewer', text: 'Hello, welcome.' }]);
});

test('a returned call tells the interviewer the first ring was missed, inside the connect marker', async () => {
  assert.equal(connectedMarker(null), '[call connected]');
  assert.equal(connectedMarker({ how: 'nonsense', agoMs: 5 }), '[call connected]', 'an unknown reason is a plain call');
  assert.equal(connectedMarker({ how: 'unanswered', agoMs: 20_000 }), '[call connected: the candidate is calling you back. You called them and it rang out with no answer a moment ago.]');
  assert.equal(connectedMarker({ how: 'declined', agoMs: 60_000 }), '[call connected: the candidate is calling you back. You called them and they declined the call about 1 minute ago.]');
  assert.equal(connectedMarker({ how: 'unanswered', agoMs: 190_000 }).includes('about 3 minutes ago'), true);
  const rig = makeRig({ callback: { how: 'unanswered', agoMs: 190_000 } });
  rig.engine.start();
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.equal(rig.sessions.main.calls[0].message, '[elapsed 00:00] [call connected: the candidate is calling you back. You called them and it rang out with no answer about 3 minutes ago.]');
  assert.equal(rig.sessions.opener.calls.length, 0, 'the greeting still needs no opener');
});

test('speculation runs the opener first, then the main reply, and only plays at the commit threshold', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation: this test is about commit timing
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(599);
  assert.equal(rig.sessions.opener.calls.length, 0, 'nothing is sent before speculateMs');
  await rig.clock.advance(1);
  assert.equal(rig.sessions.opener.calls.length, 1);
  assert.equal(rig.sessions.main.calls.length, 1, 'the main reply waits for the acknowledgement');
  assert.equal(rig.sessions.opener.calls[0].message, "[elapsed 00:00] [You last said: 'Hello, welcome to the call.'] Candidate: 'I built a scheduler'");
  assert.equal(rig.streams.length, 2, 'one voice stream per reply');
  assert.equal(rig.engine.state().phase, 'speculating');
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Right, got it.']);
  assert.equal(rig.sessions.main.calls.length, 2, 'the main reply starts once the acknowledgement is known');
  assert.equal(rig.sessions.main.calls[1].message, "[elapsed 00:00] Candidate: 'I built a scheduler' [You have already started your reply out loud with: 'Right, got it.' Carry on from there.]");
  rig.sessions.main.answer('Tell me about the design. What was hard?', { chunks: ['Tell me about ', 'the design. What was hard?'] });
  rig.streams[1].audio(1000);
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Right, got it.', 'Tell me about the design.', 'What was hard?']);
  assert(rig.streams[1].finished);
  await rig.clock.advance(599);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'audio is buffered until commit');
  assert.equal(rig.engine.state().phase, 'speculating');
  await rig.clock.advance(1);
  const after = rig.ops.filter(item => item.id === 'utt2').map(item => item.op);
  assert.deepEqual(after, ['play', 'push', 'end']);
  assert.equal(rig.opsOf('play').pop().rate, 24000);
  assert.equal(rig.engine.state().phase, 'committed');
});

test('candidate speech before speculation only cancels the timers', async () => {
  const rig = makeRig();
  await greet(rig);
  await speak(rig, 'well', 'a');
  await rig.clock.advance(300);
  rig.h.vad(true);
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 0);
  assert.equal(rig.clock.pending(), 1, 'speculation, commit and silence timers are cleared; only the look at a long live answer is waiting');
});

test('candidate speech after speculation aborts both sessions and the voice and the next turn carries the note', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  await speculate(rig);
  const opener = rig.sessions.opener.calls[0];
  const main = rig.sessions.main.calls[1];
  rig.streams[1].audio(500);
  rig.h.vad(true);
  await flush();
  assert(opener.signal.aborted && main.signal.aborted);
  assert(rig.streams[1].cancelled && rig.streams[1].signal.aborted);
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(5000);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'buffered audio is dropped');
  rig.h.transcript('and I tested it', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const expectedText = "Candidate: 'I built a scheduler and I tested it'";
  const openerMessage = rig.sessions.opener.calls[1].message;
  const mainMessage = rig.sessions.main.calls[2].message;
  assert.match(openerMessage, /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] \[You last said: 'Hello, welcome to the call\.'\] Candidate: 'I built a scheduler and I tested it'$/);
  assert.match(mainMessage, /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] Candidate: 'I built a scheduler and I tested it'$/); // the acknowledgement was dropped: no marker
  assert(openerMessage.endsWith(expectedText));
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'a discarded turn leaves no transcript entry');
});

test('listen from the opener discards the reply with no playback and no not-spoken note', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1, 'a listen from the opener never starts the main reply');
  assert.deepEqual(rig.of('opener').map(item => item.outcome), ['listen']);
  assert(rig.streams[1].cancelled);
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(1300);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the commit timer must not start a second speculation');
  rig.h.vad(true);
  rig.h.transcript('so the rest was', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[1].message;
  assert(!message.includes('not spoken'));
  // The candidate resumed at once: still one thought, so the first words join the next.
  assert(message.endsWith("Candidate: 'I built a scheduler so the rest was'"), message);
});

test('a final that revises the answer after an unfinished verdict gets it looked at again, once', async () => {
  // Found live on 2026-11-21: the turn end was looked at while the recogniser still had "be surpris"; the final came a
  // moment later and, with the candidate done, nothing looked again until the hang-up.
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('it can adapt rather than be surpris', 'a', start, false, start + 300);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 1);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  rig.h.transcript('It can adapt rather than be surprised.', 'a', start, true, start + 300);
  await rig.clock.advance(0); // the look is armed on the clock, due now
  assert.equal(rig.of('relook').length, 1);
  assert.equal(rig.sessions.opener.calls.length, 2, 'the revised answer is looked at again at once');
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'It can adapt rather than be surprised.'"), rig.sessions.opener.calls[1].message);
  // A second unfinished verdict on the same words is not looked at again for the revision; only the quiet look
  // (3 s after the vad end) comes, once.
  rig.sessions.opener.answer('<listen/>');
  await flush();
  rig.h.transcript('It can adapt rather than be surprised.', 'a', start, true, start + 300);
  await rig.clock.advance(1500);
  assert.equal(rig.sessions.opener.calls.length, 2);
  await rig.clock.advance(3500);
  assert.equal(rig.of('relook').length, 1);
  assert.equal(rig.of('quiet-relook').length, 1);
  assert.equal(rig.sessions.opener.calls.length, 3);
});

test('a final that arrived while the look was being made is looked at as soon as the look says unfinished', async () => {
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('and then we shipped', 'a', start, false, start + 300);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  rig.h.transcript('And then we shipped it.', 'a', start, true, start + 300);
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 1, 'a final during a look does not start another look by itself');
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(0);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'And then we shipped it.'"));
});

test('an unchanged final after an unfinished verdict, or a live look that listened, starts no new look', async () => {
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('I built a scheduler', 'a', start, false, start + 300);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  rig.h.transcript('I built a scheduler', 'a', start, true, start + 300);
  await rig.clock.advance(100);
  rig.h.transcript('I built a Scheduler.', 'a', start, true, start + 300); // punctuation and capitals only: the same words
  await rig.clock.advance(1500); // short of the quiet look (3 s from the vad end)
  assert.equal(rig.sessions.opener.calls.length, 1);
  assert.equal(rig.of('relook').length, 0);
  // The candidate speaking again is the ordinary path, not a re-look.
  rig.h.vad(true);
  rig.h.transcript('in Go', 'b', rig.clock.now(), true, rig.clock.now() + 200);
  await flush();
  assert.equal(rig.of('relook').length, 0, 'never while the candidate is speaking');
  assert.equal(rig.sessions.opener.calls.length, 1);
  // Nor at the pause after: a final that lands then is new speech, and the turn end takes its usual time.
  await rig.clock.advance(200);
  rig.h.vad(false);
  rig.h.transcript('in Go and Rust', 'b', rig.clock.now() - 200, true, rig.clock.now());
  await rig.clock.advance(300);
  assert.equal(rig.of('relook').length, 0);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the speculation point (600 ms) has not come yet');
  await rig.clock.advance(400);
  assert.equal(rig.sessions.opener.calls.length, 2);
});

test('a volatile result that a newer one covers is replaced, so no sentence reaches the interviewer twice', async () => {
  // Found live on 2026-11-21: results for the same speech were keyed by slightly different starts and both were kept.
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('First prevention', 'p1', start + 40, false, start + 900);
  rig.h.transcript('First, prevention.', 'p2', start, true, start + 1000);
  rig.h.transcript('During the pilot I would', 'q1', start + 1100, false, start + 1800);
  rig.h.transcript('During the pilot I would run blanks', 'q2', start + 1080, false, start + 2400);
  rig.h.transcript('During the pilot, I would run blanks.', 'q3', start + 1060, true, start + 2400);
  // The next sentence's volatile result touches the last one's end but is its own speech: it stays.
  rig.h.transcript('Second', 'r1', start + 2400, false, start + 2700);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[0].message;
  assert(message.endsWith("Candidate: 'First, prevention. During the pilot, I would run blanks. Second'"), message);
});

test('a volatile result that starts inside a final is replaced by it, its tail with it', async () => {
  // The next result for the speech past the final carries those words; keeping the volatile kept every sentence twice.
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('I built a scheduler so the rest was', 'v', start + 30, false, start + 2000);
  rig.h.transcript('I built a scheduler.', 'f', start, true, start + 1200);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[0].message, /Candidate: 'I built a scheduler\.'$/);
});

test('a final replaces a volatile result that runs wider than it, so the sentence is stored once', async () => {
  // Found live again on 2026-11-21: the real volatile range ran past its final, so the 90% cover test kept both copies.
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript("My day's going well thanks", 'v', start + 54000, false, start + 56000);
  rig.h.transcript("My day's going well, thanks.", 'f', start + 54480, true, start + 55920);
  // A volatile for the next sentence begins at the final's end: it stays.
  rig.h.transcript('And you', 'n', start + 55920, false, start + 56300);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[0].message;
  assert(message.endsWith("Candidate: 'My day's going well, thanks. And you'"), message);
});

test('a final replaces a guess of the same words that started well before it and runs past a shorter final', async () => {
  // Found in call-mwqscir3-3yraup: "My day is going well." was kept beside its final "My day's going well.".
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('My day is going well', 'v', start + 63000, false, start + 67400);
  rig.h.transcript("My day's going well.", 'f', start + 66060, true, start + 67320);
  rig.h.transcript('Thanks for asking.', 'g', start + 67320, true, start + 68200);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[0].message;
  assert(message.endsWith("Candidate: 'My day's going well. Thanks for asking.'"), message);
});

test('a final keeps a guess for the sentence before it that only touches its start', async () => {
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('I moved to Bristol last year', 'p', start + 50000, false, start + 54500);
  rig.h.transcript('It has been great.', 'f', start + 54480, true, start + 55900);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[0].message;
  assert(message.endsWith("Candidate: 'I moved to Bristol last year It has been great.'"), message);
});

test('realistic non-nesting volatile and final ranges leave each sentence once, in the opener message and the transcript', async () => {
  const rig = makeRig();
  await greet(rig);
  const start = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('A bit nervous in the good way', 'v1', start + 100, false, start + 3000);
  rig.h.transcript('A bit nervous in the good way because I have been looking forward', 'v2', start + 90, false, start + 4300);
  rig.h.transcript('A bit nervous in the good way, because I have been looking forward to this.', 'f1', start + 400, true, start + 4000);
  rig.h.transcript('Thanks for having me', 'v3', start + 4350, false, start + 5200);
  rig.h.transcript('Thanks for having me.', 'f2', start + 4340, true, start + 5100);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[0].message;
  assert(message.endsWith("Candidate: 'A bit nervous in the good way, because I have been looking forward to this. Thanks for having me.'"), message);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Tell me more.');
  rig.streams.at(-1).audio(3200);
  await rig.clock.advance(1200);
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'candidate');
  assert.equal(entry.text, 'A bit nervous in the good way, because I have been looking forward to this. Thanks for having me.');
});

test('the opener message lists the last four spoken reactions with their speaker; none before the first', async () => {
  const rig = makeRig();
  await greet(rig);
  const reactions = ['Right.', 'Mm-hm, okay.', 'Gotcha, fine.', 'Sure, yes.', 'No worries.'];
  for (const reaction of reactions) await answerTurn(rig, 'Go on.', reaction);
  const messages = rig.sessions.opener.calls.map(call => call.message);
  assert(!messages[0].includes('recent reactions'), messages[0]);
  assert(messages[1].includes("[Your recent reactions, do not reuse their words: Interviewer: 'Right.']"), messages[1]);
  assert(messages[5 - 1].includes("Interviewer: 'Right.' Interviewer: 'Mm-hm, okay.' Interviewer: 'Gotcha, fine.' Interviewer: 'Sure, yes.'"), messages[4]);
  assert.equal(rig.of('opener').at(-1).outcome, 'spoken');
  assert(!rig.sessions.main.calls.at(-1).message.includes('recent reactions'), 'only the opener message carries the list');
});

test('an opener that thanks right after one that did, or starts like a recent one, is dropped without a re-roll', async () => {
  const rig = makeRig();
  await greet(rig);
  await answerTurn(rig, 'Go on.', 'Okay, thank you.');
  await answerTurn(rig, 'Go on.', 'Sure, thanks for that.');
  await answerTurn(rig, 'Go on.', 'Ah, lovely.');
  await answerTurn(rig, 'Go on.', 'Okay, got it.');
  await answerTurn(rig, 'Go on.', 'Okay, got it again.'); // same first two words as a recent one
  await answerTurn(rig, 'Go on.', 'Yeah, fine.');
  assert.deepEqual(rig.of('opener').map(event => [event.outcome, event.text]), [
    ['spoken', 'Okay, thank you.'], ['dropped', 'Sure, thanks for that.'], ['dropped', 'Ah, lovely.'], ['spoken', 'Okay, got it.'], ['dropped', 'Okay, got it again.'], ['spoken', 'Yeah, fine.'],
  ]);
  assert.equal(rig.sessions.opener.calls.length, 6, 'no re-roll');
});

test('an opener that reuses a longer word of a recent reaction, in any ending, is dropped; short sounds stay free', async () => {
  const rig = makeRig();
  await greet(rig);
  await answerTurn(rig, 'Go on.', 'Okay, all followed.');
  await answerTurn(rig, 'Go on.', 'Right, I follow you.'); // follow / followed
  await answerTurn(rig, 'Go on.', 'Mm-hm, okay.'); // okay is a short sound
  await answerTurn(rig, 'Go on.', 'Sure, happy to.');
  await answerTurn(rig, 'Go on.', 'Glad, happy to.');
  assert.deepEqual(rig.of('opener').map(event => [event.outcome, event.text]), [
    ['spoken', 'Okay, all followed.'], ['dropped', 'Right, I follow you.'], ['spoken', 'Mm-hm, okay.'], ['spoken', 'Sure, happy to.'], ['dropped', 'Glad, happy to.'],
  ]);
});

test('an opener may reuse "right": it is a listening sound, not a word to vary (call of 2026-11-22: 5.6 s of silence)', async () => {
  const rig = makeRig();
  await greet(rig);
  await answerTurn(rig, 'Go on.', 'Right, I followed all of that.');
  await answerTurn(rig, 'Go on.', 'Okay, got it.');
  await answerTurn(rig, 'Go on.', 'Right, that landed fine.');
  assert.deepEqual(rig.of('opener').map(event => event.outcome), ['spoken', 'spoken', 'spoken']);
});

test('an opener whose later sentence repeats a recent reaction is cut there, and what came before is still said', async () => {
  // Call of 2026-11-22: "Right. That's followed." was dropped whole after "Yep, followed.", leaving 3.1 s of silence.
  const rig = makeRig();
  await greet(rig);
  await answerTurn(rig, 'Go on.', 'Yep, followed.');
  const stream = await answerTurn(rig, 'Go on.', 'Right. That\'s followed.');
  await answerTurn(rig, 'Go on.', 'All followed. Right.');
  assert.deepEqual(rig.of('opener').map(event => [event.outcome, event.text, event.cutFrom]), [
    ['spoken', 'Yep, followed.', undefined], ['spoken', 'Right.', 'Right. That\'s followed.'], ['dropped', 'All followed. Right.', undefined],
  ]);
  assert(stream.texts.join(' ').startsWith('Right.') && !stream.texts.join(' ').includes('followed'), stream.texts.join(' | '));
  assert(rig.sessions.main.calls.at(-2).message.includes("started your reply out loud with: 'Right.'"), 'the main reply carries on from what was said');
});

test('listen from main after a finished line: the opener reaction is not spoken, nothing plays, the line stays unconsumed', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  assert.equal(rig.sessions.main.calls.length, 1, 'the main reply waits for the opener');
  rig.sessions.opener.answer('Mm, okay.');
  await flush();
  rig.sessions.main.answer('<listen/>');
  await flush();
  rig.streams[1].audio(400);
  await flush();
  assert(rig.streams[1].cancelled, 'the reaction that had not started playing is dropped');
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer']);

  const quiet = makeRig();
  await greet(quiet);
  await speculate(quiet);
  quiet.sessions.opener.answer('<listen/>');
  await flush();
  assert.equal(quiet.engine.state().phase, 'listening');
  assert.equal(quiet.opsOf('play').filter(item => item.id === 'utt2').length, 0);
});

test('pass to a finished line: kept as its own entry at once, never joined to later speech, even soon after', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'okay', 'a');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => [entry.speaker, entry.text]), [['interviewer', 'Hello, welcome to the call.'], ['candidate', 'okay']]);
  assert.equal(rig.sessions.main.calls.length, 2);
  assert(rig.sessions.main.calls[1].signal.aborted);
  await rig.clock.advance(1500);
  await speak(rig, 'now the real answer', 'b');
  await rig.clock.advance(600);
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'now the real answer'"), rig.sessions.opener.calls[1].message);
  assert(!rig.sessions.opener.calls[1].message.includes('okay'));
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Go on.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.text), ['Hello, welcome to the call.', 'okay', 'now the real answer', 'Right. Go on.']);
});

test('pass to a finished line: a bare voice blip afterwards does not resend it', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'thanks', 'a');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  const calls = rig.sessions.opener.calls.length;
  rig.h.vad(true);
  await rig.clock.advance(150);
  rig.h.vad(false);
  await rig.clock.advance(3000);
  assert.equal(rig.sessions.opener.calls.length, calls, 'no new turn from a blip');
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['thanks']);
});

test('listen to a finished line: nothing is kept; the words join the next speech after 6 s, however long the pause', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'I built a scheduler', 'a');
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'not in the transcript yet');
  await rig.clock.advance(6000);
  await speak(rig, 'and then I tested it', 'b');
  await rig.clock.advance(600);
  assert(rig.sessions.opener.calls.at(-1).message.endsWith("Candidate: 'I built a scheduler and then I tested it'"), rig.sessions.opener.calls.at(-1).message);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'one thought, not two entries');
});

test('pass to a finished line: a typed message right after does not carry the line again', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'okay', 'a');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  rig.engine.typed('here is the code');
  await flush();
  rig.sessions.opener.answer('Okay.');
  await flush();
  const message = rig.sessions.main.calls.at(-1).message;
  assert(!message.includes('okay'), message);
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['okay']);
});

test('opener pass with a real main reply: the reply is spoken, nothing is discarded, the line is kept once', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'Going well, thanks for asking.', 'a');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  await flush();
  assert.equal(rig.of('discarded').length, 0, 'the opener pass does not discard');
  rig.sessions.main.answer('Good to hear. Tell me about your last role.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.equal(rig.of('discarded').length, 0);
  assert(rig.engine.state().transcript.some(entry => entry.speaker === 'interviewer' && /last role/.test(entry.text)), 'the reply is in the transcript');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the reply is played');
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['Going well, thanks for asking.']);
});

test('opener pass or a spoken acknowledgement, then the main pass: nothing plays, one discarded pass, the line kept once', async () => {
  for (const openerFirst of [true, false]) {
    const rig = makeRig();
    await greet(rig);
    await speculate(rig, 'okay', 'a');
    // The main reply starts only after the opener, so its pass can only come second.
    rig.sessions.opener.answer(openerFirst ? '<pass/>' : 'Mm-hm.');
    await flush();
    rig.sessions.main.answer('<pass/>');
    await flush();
    assert.equal(rig.engine.state().phase, 'listening', `openerFirst=${openerFirst}`);
    assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
    assert.equal(rig.of('discarded').length, 1, JSON.stringify(rig.of('discarded')));
    assert.equal(rig.of('discarded')[0].reason, 'pass');
    assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['okay']);
  }
});

test('opener pass releases the main turn once, with no acknowledgement marker, and cancels nothing', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'Going well, thanks.', 'a');
  assert.equal(rig.sessions.main.calls.length, 1, 'main waits for the opener');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'main starts once');
  assert(!rig.sessions.main.calls.at(-1).signal.aborted, 'main is not cancelled');
  assert.equal(rig.sessions.main.calls.at(-1).message, "[elapsed 00:00] Candidate: 'Going well, thanks.'", 'nothing was said, so no marker');
  assert.deepEqual(rig.of('opener').map(item => [item.outcome, item.spoken]), [['pass', false]]);
});

test('a typed message answered with pass ends silent with the typed entry kept', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('thanks');
  await flush();
  rig.sessions.opener.answer('<pass/>');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => [entry.channel, entry.text]), [['chat', 'thanks']]);
});

const chatEntries = rig => rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => [entry.channel, entry.text]);

test('typed okay, spoken acknowledgement not yet committed, then main pass: nothing is spoken, the entry is kept once, discarded pass', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('okay');
  await flush();
  rig.sessions.opener.answer('Mm-hm.');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'nothing played');
  assert.deepEqual(chatEntries(rig), [['chat', 'okay']], 'kept once, on the chat channel');
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').length, 1, 'no reaction in the transcript');
  assert(rig.of('discarded').some(item => item.reason === 'pass'), JSON.stringify(rig.of('discarded')));
});

test('typed okay, opener pass first: the same silent, kept-once result', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('okay');
  await flush();
  rig.sessions.opener.answer('<pass/>');
  await flush();
  await flush();
  assert.equal(rig.engine.state().phase, 'speculating', 'the opener pass alone decides nothing');
  rig.sessions.main.answer('<pass/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(chatEntries(rig), [['chat', 'okay']]);
  assert(rig.of('discarded').some(item => item.reason === 'pass'));
});

test('typed okay with main pass after the opener reaction was already committed: the reaction finishes, the entry is kept once', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('okay');
  await flush();
  rig.sessions.opener.answer('Okay.');
  await flush();
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the reaction is playing');
  rig.sessions.main.answer('<pass/>');
  await flush();
  assert.deepEqual(chatEntries(rig), [['chat', 'okay']]);
});

test('typed listen is treated as pass: nothing spoken, entry kept, never resent', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('let me think');
  await flush();
  rig.sessions.opener.answer('<listen/>');
  await flush();
  rig.sessions.main.answer('<listen/>');
  await flush();
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(chatEntries(rig), [['chat', 'let me think']], 'kept, not joined to later words');
  assert(rig.of('discarded').some(item => item.reason === 'pass'), 'reported as pass');
  rig.engine.typed('here is the answer');
  await flush();
  rig.sessions.opener.answer('Okay.');
  await flush();
  assert(!rig.sessions.main.calls.at(-1).message.includes('let me think'), 'the passed line is not resent');
  assert.deepEqual(chatEntries(rig), [['chat', 'let me think']].concat([]), 'the new message is not committed until answered');
});

test('a typed pass restarts the silence check and the next message does not carry the line again', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('thanks');
  await flush();
  rig.sessions.opener.answer('<pass/>');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  await flush();
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(19000);
  assert.equal(rig.sessions.main.calls.length, calls, 'the wait restarted from the pass');
  await rig.clock.advance(1100);
  assert(rig.sessions.main.calls.length > calls, 'the silence check came after the wait');
  assert.match(rig.sessions.main.calls.at(-1).message, /candidate silent/);
});

test('a normal typed answer is still replied to out loud', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('I would shard by tenant because writes are skewed');
  await flush();
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Why tenant and not region?');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  assert(rig.engine.state().transcript.some(entry => entry.speaker === 'interviewer' && /region/.test(entry.text)));
  assert.equal(rig.of('discarded').filter(item => item.reason === 'pass').length, 0);
});

test('a pass to a finished line keeps the interviewer wait and restarts the silence check from now', async () => {
  const options = [];
  const rig = makeRig({ createParser: patienceParser, formatTurn: option => { options.push(option); return '[turn]'; } });
  await greet(rig);
  await deliver(rig, 'Go ahead.<wait s="30"/>');
  await speak(rig, 'okay', 'k');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('<pass/>');
  await flush();
  rig.sessions.main.answer('<pass/>', { chunks: ['<pass/>'] });
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(rig.engine.state().transcript.slice(-1).map(entry => entry.text), ['okay']);
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(29000);
  assert.equal(rig.sessions.main.calls.length, calls, 'the 30 s wait still holds');
  await rig.clock.advance(1100);
  assert.equal(rig.sessions.main.calls.length, calls + 1, 'then the silence check');
});

test('a pass reply alone (no reaction) to a finished line leaves the next message free of the old line', async () => {
  const options = [];
  const rig = makeRig({ formatTurn: option => { options.push(option); return '[turn]'; } });
  await greet(rig);
  await speculate(rig, 'okay', 'a');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  await flush();
  await rig.clock.advance(5000);
  await speculate(rig, 'now the real answer', 'b');
  const last = options.at(-1);
  assert.equal(last.candidateText, 'now the real answer');
});

test('a reaction already playing finishes when the main reply is listen; the line is in the transcript once', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Mm.');
  await flush();
  rig.streams[1].audio(400);
  await flush();
  await rig.clock.advance(700);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  rig.sessions.main.answer('<listen/>');
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer', 'candidate', 'interviewer']);
  assert.equal(rig.engine.state().phase, 'listening');
});

test('pass from main after a finished line: the opener reaction is discarded with reason pass, the line is kept, nothing plays', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Mm, okay.');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  rig.streams[1].audio(400);
  await flush();
  assert(rig.streams[1].cancelled);
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer', 'candidate']);
  assert(rig.of('discarded').some(item => item.reason === 'pass'), JSON.stringify(rig.of('discarded')));
});

const REPLY_WORDS = words('Right,', 'got', 'it.', 'Tell', 'me', 'about', 'the', 'design.', 'What', 'was', 'hard?');

/** A reply (utt2) is playing: three sentences, words 300 ms apart (word i ends at i*300+280). */
async function toPlaying(rig, { opener = 'Right, got it.', main = 'Tell me about the design. What was hard?', wordList = REPLY_WORDS } = {}) {
  await speculate(rig);
  rig.sessions.opener.answer(opener);
  await flush();
  await flush();
  rig.sessions.main.answer(main);
  rig.streams[1].words(wordList);
  rig.streams[1].audio(1000);
  await rig.clock.advance(600);
  rig.h.playback('utt2', 'started');
  await flush();
  return rig.streams[1];
}

/** The candidate talks over the reply for `text` and stops after 200 ms. */
async function shortOverlap(rig, text = 'right', segmentId = 'o1') {
  rig.h.vad(true);
  rig.h.transcript(text, segmentId, rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await flush();
}

const cancelsOf = (rig, id) => rig.opsOf('cancel').filter(item => item.id === id).length;

test('a candidate answer that starts talking over the reply with more words than allowed stops it at once and notes what was heard', async () => {
  const rig = makeRig();
  await greet(rig);
  const stream = await toPlaying(rig);
  assert.equal(rig.engine.state().phase, 'playing');
  rig.h.playback('utt2', 'position', 650);
  rig.h.vad(true);
  rig.h.transcript('wait what do', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert(stream.cancelled && rig.sessions.main.calls[1].signal.aborted);
  assert.equal(rig.engine.state().phase, 'listening');
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: 'Right, got it.' }]);
  const interviewer = rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop();
  assert.deepEqual(bare(interviewer), { speaker: 'interviewer', text: 'Right, got it.', interrupted: true, heardText: 'Right, got it.' });
  rig.h.transcript('wait what do you mean', 'o1', rig.clock.now());
  await rig.clock.advance(100);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[1].message;
  assert.match(message, /\[You were interrupted after saying: 'Right, got it\.'\. The rest was not heard\.\] Candidate: 'wait what do you mean'$/);
  assert(!message.includes('I built a scheduler'), 'the earlier answer is not repeated');
});

test('speech talking over the reply for longer than the limit stops it once a transcript word was counted', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('um', 'o1', rig.clock.now()); // F9: the duration rule needs at least one counted word
  await rig.clock.advance(700);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'exactly the limit is not more than the limit');
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.sessions.classifier.calls.length, 0);
  assert.equal(rig.engine.state().phase, 'listening');
});

test('a short overlap goes to the classifier and an acknowledgement verdict keeps playing and rides on the next turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'right');
  assert.equal(rig.sessions.classifier.calls.length, 1);
  const asked = rig.sessions.classifier.calls[0].message;
  assert(asked.includes("Interviewer sentence being spoken: 'Right, got it.'"));
  assert(asked.includes("Candidate's words: 'right'"));
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'nothing stops while the classifier thinks');
  rig.sessions.classifier.answer('Acknowledgement');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().phase, 'playing');
  assert.deepEqual(rig.of('acknowledgement'), [{ type: 'acknowledgement', text: 'right' }]);
  assert(rig.engine.state().transcript.some(entry => entry.acknowledgement === true && entry.text === 'right'));
  await rig.clock.advance(500);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  await speak(rig, 'okay next topic', 'c');
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message, /\[Candidate acknowledgements while you spoke: "right"\] Candidate: 'okay next topic'( \[You have already started your reply out loud with: '[^']*' Carry on from there\.\])?$/);
  rig.sessions.opener.answer('Mm-hm, okay.');
  await flush();
  assert.match(rig.sessions.main.calls[2].message, /\[Candidate acknowledgements while you spoke: "right"\] Candidate: 'okay next topic'( \[You have already started your reply out loud with: '[^']*' Carry on from there\.\])?$/);
});

test('an interruption verdict stops at the next word boundary, and past the last word stops now', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'right');
  rig.h.playback('utt2', 'position', 100); // F11: the live position is estimated from the last position event
  rig.sessions.classifier.answer('interruption.');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the word in progress ends at 280 ms');
  await rig.clock.advance(179);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  rig.h.playback('utt2', 'cancelled', 280);
  await flush();
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop().heardText, 'Right,');
  await rig.clock.advance(700);
  assert.match(rig.sessions.opener.calls[1].message, /\[You were interrupted after saying: 'Right,'\. The rest was not heard\.\] Candidate: 'right'$/);

  const late = makeRig();
  await greet(late);
  await toPlaying(late);
  late.h.playback('utt2', 'position', 5000);
  await shortOverlap(late, 'right');
  late.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(late, 'utt2'), 1, 'already past every word: cancel now');
});

test('classifier timeout means acknowledgement and a late verdict is ignored', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'right');
  const call = rig.sessions.classifier.calls[0];
  await rig.clock.advance(2499);
  assert.equal(rig.of('acknowledgement').length, 0);
  await rig.clock.advance(1);
  assert.equal(rig.of('acknowledgement').length, 1);
  assert(call.signal.aborted);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().phase, 'playing');
  call.resolve({ text: 'interruption' });
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.of('acknowledgement').length, 1);
});

test('an overlap with no transcript words is ignored', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(3000);
  assert.equal(rig.sessions.classifier.calls.length, 0);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().phase, 'playing');
});

test('race: the classifier answers interruption after playback already finished, so it is an ordinary turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'sorry?');
  await rig.clock.advance(100);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'nothing left to stop');
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'sorry?'"));
});

test('race: playback finishing while the candidate is still talking turns the overlap into a normal turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('hold on', 'o1', rig.clock.now());
  await rig.clock.advance(100);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  await rig.clock.advance(100);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'hold on'"));
  assert.equal(rig.sessions.classifier.calls.length, 0);
});

test('silence prompt fires after the limit, restarts after each interviewer utterance, and typing pauses it', async () => {
  const rig = makeRig();
  await greet(rig);
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1);
  // Nothing was said, so no acknowledgement is spoken before a silence check-in.
  assert.equal(rig.sessions.opener.calls.length, 0);
  assert.equal(rig.sessions.main.calls[1].message, '[elapsed 00:20] [candidate silent 20s, check 1 of 3]');
  rig.sessions.main.answer('Still with me?');
  rig.streams[1].audio(500);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'a silence turn commits without waiting');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 2);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 3, 'the timer restarts after each interviewer utterance, 20 s later with the default patience');
  assert.match(rig.sessions.main.calls[2].message, /\[candidate silent 40s, check 2 of 3\]/, 'the real cumulative silence is reported');

  const quiet = makeRig();
  await greet(quiet);
  quiet.engine.typing(true);
  await quiet.clock.advance(5000);
  quiet.engine.typing(true); // a refresh keeps it alive
  await quiet.clock.advance(5000);
  assert.equal(quiet.sessions.main.calls.length, 1, 'typing pauses the silence prompt');
  quiet.engine.typing(false);
  await quiet.clock.advance(19999);
  assert.equal(quiet.sessions.main.calls.length, 1);
  await quiet.clock.advance(1);
  assert.equal(quiet.sessions.main.calls.length, 2);
});

test('pause blocks every check-in and the silence ending, however long the clock runs', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(true);
  await rig.clock.advance(10 * 60 * 1000);
  assert.equal(rig.sessions.main.calls.length, 1, 'no check-in while paused');
  assert.equal(rig.of('ended').length, 0);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.clock.pending(), 0, 'no silence timer is left armed');
});

test('pause also holds the silence ending after the checks were already used', async () => {
  const rig = makeRig();
  await greet(rig);
  for (let check = 1; check <= 3; check += 1) {
    await rig.clock.advance(check === 3 ? 30000 : 20000); // the gaps widen: 20 s, 20 s, 30 s
    rig.sessions.main.answer('Still there?');
    rig.streams[check].audio(300);
    await flush();
    rig.h.playback(`utt${check + 1}`, 'started');
    rig.h.playback(`utt${check + 1}`, 'finished', 500);
    await flush();
    if (check === 3) break;
  }
  rig.engine.setPaused(true);
  await rig.clock.advance(5 * 60 * 1000);
  assert.equal(rig.of('ended').length, 0, 'the line does not drop while paused');
  rig.engine.setPaused(false);
  await rig.clock.advance(60 * 1000);
  assert.equal(rig.of('ended').length, 1);
  assert.equal(rig.of('ended')[0].cause, 'silence');
});

test('elapsed time in the next turn message excludes paused time, the helper timeline is not shifted', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  await rig.clock.advance(5000);
  rig.engine.setPaused(true);
  assert.equal(rig.engine.state().elapsedMs, 5000, 'elapsed so far');
  await rig.clock.advance(120000);
  assert.equal(rig.engine.state().elapsedMs, 5000, 'elapsed stands still while paused');
  assert.equal(rig.engine.state().pausedMs, 120000);
  rig.engine.setPaused(false); // only the shortcut resumes
  rig.engine.typed('here is my answer');
  await flush();
  assert.equal(rig.engine.state().paused, false);
  assert.match(rig.sessions.main.calls[1].message, /^\[elapsed 00:05\]/);
  assert.equal(rig.engine.state().pausedMs, 120000);
  assert.equal(rig.engine.state().elapsedMs, 5000 + 0, 'still the unpaused elapsed time right after the turn');
});

test('resume re-arms the silence wait from zero with the same patience and keeps the check count', async () => {
  const rig = makeRig();
  await greet(rig);
  await rig.clock.advance(20000);
  assert.equal(rig.sessions.main.calls.length, 2, 'check 1 sent');
  rig.sessions.main.answer('Still with me?');
  rig.streams[1].audio(300);
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 500);
  await flush();
  await rig.clock.advance(15000); // part of the second wait is used up
  rig.engine.setPaused(true);
  await rig.clock.advance(60000);
  rig.engine.setPaused(false);
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 2, 'the wait restarted from zero');
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 3);
  assert.match(rig.sessions.main.calls[2].message, /check 2 of 3/, 'the count of checks already made is kept');
});

test('only the shortcut resumes: speech and chat neither resume nor start a turn', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  rig.engine.setPaused(true);
  await speak(rig, 'I would start with a queue', 'a');
  await rig.clock.advance(5000);
  assert.equal(rig.engine.state().paused, true, 'speech does not resume');
  assert.equal(rig.sessions.opener.calls.length, 0, 'speech during a pause speculates nothing');
  assert.equal(rig.sessions.main.calls.length, 1, 'and starts no turn');
  assert.equal(rig.engine.typed('typed during the pause'), false, 'chat is refused');
  rig.engine.setPadText('const a = 1;');
  rig.engine.typing(true);
  rig.engine.typing(false);
  await flush();
  assert.equal(rig.engine.state().paused, true, 'pad text and typing signals resume nothing');
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').length, 0, 'nothing from the pause is kept as a turn');
  rig.engine.setPaused(false);
  assert.equal(rig.engine.state().paused, false);
  assert.equal(rig.engine.typed('typed after resuming'), true);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.match(rig.sessions.main.calls[1].message, /typed after resuming/);
});

test('speech from a pause never reaches the first turn after resume, even when its words arrive late', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(true);
  rig.h.vad(true);
  rig.h.transcript('secret pause words', 'p1', rig.clock.now(), false, rig.clock.now() + 300);
  await rig.clock.advance(300);
  rig.engine.setPaused(false);
  rig.h.transcript('secret pause words continued', 'p1', rig.clock.now() - 300, true, rig.clock.now());
  rig.h.vad(false);
  await rig.clock.advance(2000);
  assert.equal(rig.sessions.opener.calls.length, 0, 'no turn starts from pause speech');
  await speak(rig, 'a fresh answer', 'b');
  await rig.clock.advance(600);
  const sent = [...rig.sessions.opener.calls, ...rig.sessions.main.calls].map(call => call.message).join('\n');
  assert.match(sent, /a fresh answer/);
  assert(!sent.includes('secret pause words'), sent);
});

test('typed is refused while paused and works after the shortcut resumes', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  rig.engine.setPaused(true);
  assert.equal(rig.engine.typed('hello'), false);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  rig.engine.setPaused(false);
  assert.equal(rig.engine.typed('after'), true);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'a typed message is a normal turn after resume');
  assert(!/hello/.test(rig.sessions.main.calls[1].message), 'the refused message is not delivered later');
});

test('an interruption attempt during a pause does not cut the reply that is finishing', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.setPaused(true);
  rig.h.vad(true);
  rig.h.transcript('wait what do you mean', 'o1', rig.clock.now());
  await rig.clock.advance(1000);
  rig.h.vad(false);
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the reply is not cut');
  assert.equal(rig.sessions.classifier.calls.length, 0, 'the classifier is not asked');
  assert.equal(rig.engine.state().phase, 'playing');
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  await rig.clock.advance(5000);
  assert.equal(rig.sessions.main.calls.length, 2, 'still no new turn while paused');
});

test('a reply paused by an overlap plays on when the call pauses mid-overlap', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'pause' }) });
  const rig = makeRig({ ear });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'right');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  rig.engine.setPaused(true);
  assert.equal(rig.opsOf('resume').filter(item => item.id === 'utt2').length, 1, 'the reply resumes and finishes');
  rig.h.vad(false);
  await flush();
  assert.equal(rig.sessions.classifier.calls.length, 0);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
});

test('a reply already being spoken when the pause starts still finishes', async () => {
  const rig = makeRig();
  rig.engine.start({ greeting: true });
  await flush();
  rig.h.level();
  rig.sessions.main.answer('Welcome to the interview.');
  rig.streams[0].audio(3200);
  await flush();
  rig.h.playback('utt1', 'started');
  rig.engine.setPaused(true);
  await rig.clock.advance(1000);
  assert.equal(rig.opsOf('cancel').length, 0, 'the pause does not cancel playback');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(5 * 60 * 1000);
  assert.equal(rig.sessions.main.calls.length, 1, 'and no check-in follows while paused');
});

test('pausing twice or resuming when not paused does nothing, and the event fires on change only', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(false);
  assert.equal(rig.of('paused').length, 0);
  assert.equal(rig.engine.state().paused, false);
  rig.engine.setPaused(true);
  await rig.clock.advance(1000);
  rig.engine.setPaused(true);
  assert.equal(rig.of('paused').length, 1);
  assert.deepEqual(rig.of('paused')[0], { type: 'paused', paused: true });
  assert.equal(rig.engine.state().paused, true);
  rig.engine.setPaused(false);
  rig.engine.setPaused(false);
  assert.equal(rig.of('paused').length, 2);
  assert.deepEqual(rig.of('paused')[1], { type: 'paused', paused: false });
  assert.equal(rig.engine.state().pausedMs, 1000);
});

test('candidate speech cancels the silence prompt', async () => {
  const rig = makeRig();
  await greet(rig);
  await rig.clock.advance(9000);
  rig.h.vad(true);
  await rig.clock.advance(5000);
  assert.equal(rig.sessions.main.calls.length, 1);
});

test('typing while a turn is pending is reported in that message', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  await speak(rig, 'let me write that down', 'a');
  rig.engine.typing(true);
  await rig.clock.advance(600);
  assert.equal(rig.sessions.main.calls[1].message,
    "[elapsed 00:00] [candidate is typing in chat] Candidate: 'let me write that down'");
});

test('a typed turn while listening is sent at once and committed as soon as audio is ready', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my code');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1, 'a typed turn also waits for its acknowledgement');
  assert.equal(rig.sessions.opener.calls[0].message,
    "[elapsed 00:00] [You last said: 'Hello, welcome to the call.'] Candidate (typed in chat): 'Here is my code'");
  rig.sessions.opener.answer('Okay, yeah, I see.');
  await flush();
  assert.equal(rig.sessions.main.calls[1].message,
    `[elapsed 00:00] Candidate (typed in chat): 'Here is my code' ${MARK('Okay, yeah, I see.')}`);
  rig.sessions.main.answer('Walk me through it.');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'no speculation delay');
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker + (entry.channel ? `:${entry.channel}` : '')),
    ['interviewer', 'candidate:chat', 'interviewer']);
  assert.equal(rig.engine.state().transcript[1].text, 'Here is my code');
});

test('typing more than the word limit over the reply interrupts with the heard-text note', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.typed('wait what is that');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the reply runs on to the next word boundary');
  await rig.clock.advance(300);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the typed turn waits for the cancelled event');
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  assert.match(rig.sessions.opener.calls[1].message,
    /\[You were interrupted after saying: 'Right, got it\.'\. The rest was not heard\.\] Candidate \(typed in chat\): 'wait what is that'$/);
});

test('a short typed message over the reply never goes to the classifier: it stops the reply and becomes one typed turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.engine.typed('ok sure');
  await flush();
  assert.equal(rig.sessions.classifier.calls.length, 0, 'typed text is never judged as an acknowledgement');
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'stops at the next word boundary, not before');
  await rig.clock.advance(280);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  rig.h.playback('utt2', 'cancelled', 280);
  await flush();
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate (typed in chat): 'ok sure'"));
  assert(!rig.engine.state().transcript.some(entry => entry.acknowledgement), 'no acknowledgement entry');
});

test('chat blocks are parsed out of the spoken stream, posted when playback reaches them and recorded, never sent to the voice', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Sure.');
  await flush();
  await flush();
  rig.sessions.main.answer('x', { chunks: ['Here is the problem. <ch', 'at>Write a function ', 'that adds two numbers.</ch', 'at> Take a look.'] });
  rig.streams[1].audio(400);
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Sure.', 'Here is the problem.', 'Take a look.']);
  assert.equal(rig.of('chat').length, 0, 'nothing is posted before the reply commits');
  await rig.clock.advance(600);
  assert.equal(rig.of('chat').length, 0, 'nor when it commits: playback has not reached it');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
  assert.deepEqual(rig.of('chat'), [{ type: 'chat', from: 'interviewer', text: 'Write a function that adds two numbers.' }]);
  assert(rig.engine.state().transcript.some(entry => entry.speaker === 'interviewer' && entry.channel === 'chat'
    && entry.text === 'Write a function that adds two numbers.'));

  const dropped = makeRig();
  await greet(dropped);
  await speculate(dropped);
  dropped.sessions.opener.answer('Sure.');
  await flush();
  dropped.sessions.main.answer('x', { chunks: ['Look. <chat>Hidden text.</chat> Go.'] });
  await flush();
  dropped.h.vad(true);
  await dropped.clock.advance(3000);
  assert.equal(dropped.of('chat').length, 0, 'a discarded reply drops its chat posts');
});

test('chat transcript entries carry helper-timeline timing for replay and chapters', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Sure.');
  await flush();
  await flush();
  rig.sessions.main.answer('x', { chunks: ['Look. <chat>Open the file.</chat> Go.'] });
  rig.streams[1].audio(400);
  await flush();
  await rig.clock.advance(600); // the reply commits
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900); // the chat is delivered when playback gets there
  await flush();
  const chatClock = rig.clock.now();
  const posted = rig.engine.state().transcript.find(entry => entry.speaker === 'interviewer' && entry.channel === 'chat');
  assert(posted, 'the interviewer chat entry reached the transcript');
  assert.equal(posted.text, 'Open the file.');
  assert(Number.isFinite(posted.startMs) && Number.isFinite(posted.endMs), `chat entry carries timing: ${JSON.stringify(posted)}`);
  assert.equal(posted.startMs, posted.endMs);
  assert.equal(posted.startMs, chatClock - HELPER_OFFSET, 'helper ms = clock ms - offset');

  const typedRig = makeRig();
  await greet(typedRig);
  const typedClock = typedRig.clock.now();
  typedRig.engine.typed('Here is my code');
  await flush();
  typedRig.sessions.opener.answer('Okay.');
  await flush();
  typedRig.sessions.main.answer('Walk me through it.');
  typedRig.streams[1].audio(300);
  await flush();
  const typed = typedRig.engine.state().transcript.find(entry => entry.speaker === 'candidate' && entry.channel === 'chat');
  assert(typed, 'the typed entry reached the transcript');
  assert.equal(typed.text, 'Here is my code');
  assert(Number.isFinite(typed.startMs) && Number.isFinite(typed.endMs), `typed entry carries timing: ${JSON.stringify(typed)}`);
  assert.equal(typed.startMs, typed.endMs);
  assert.equal(typed.startMs, typedClock - HELPER_OFFSET, 'helper ms = clock ms - offset');

  // With no helper event yet the offset is unknown, so the elapsed call time stands in.
  // Nothing on this rig reports a helper time, so the engine never learns the offset.
  const fresh = makeRig();
  fresh.engine.start();
  await flush();
  await fresh.clock.advance(450); // no helper event has arrived, so the offset is still unknown
  const elapsedClock = fresh.clock.now();
  fresh.engine.typed('I am a developer');
  await flush();
  fresh.sessions.opener.answer('Sure.');
  await flush();
  fresh.sessions.main.answer('Go on.');
  fresh.streams.at(-1).audio(300);
  await flush();
  const fallback = fresh.engine.state().transcript.find(entry => entry.speaker === 'candidate' && entry.channel === 'chat');
  assert(fallback, 'the typed entry reached the transcript with no offset known');
  assert.equal(fallback.text, 'I am a developer');
  assert(Number.isFinite(fallback.startMs) && Number.isFinite(fallback.endMs), `fallback entry carries timing: ${JSON.stringify(fallback)}`);
  assert.equal(fallback.startMs, elapsedClock, 'no offset yet: elapsed call ms');
  assert.equal(fallback.endMs, fallback.startMs);
});

test('end-call ends the call only after the final reply has finished playing', async () => {
  const rig = makeRig();
  await greet(rig);
  const stream = await toPlaying(rig, { main: 'Thanks for your time. Goodbye.<end-call/>' });
  assert.deepEqual(stream.texts, ['Right, got it.', 'Thanks for your time.', 'Goodbye.']);
  assert.equal(rig.engine.state().phase, 'playing');
  assert.equal(rig.of('ended').length, 0);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  assert.equal(rig.engine.state().phase, 'ended');
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'interviewer' }]);
  assert.equal(rig.clock.pending(), 0, 'all timers cleared');
  rig.engine.typed('anything');
  rig.h.vad(true);
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 1, 'later input is ignored');
});

test('hangUp ends at once from playing, speculating and listening', async () => {
  const playing = makeRig();
  await greet(playing);
  await toPlaying(playing);
  playing.engine.hangUp();
  assert.equal(cancelsOf(playing, 'utt2'), 1);
  assert(playing.sessions.main.calls[1].signal.aborted && playing.streams[1].cancelled);
  assert.deepEqual(playing.of('ended'), [{ type: 'ended', reason: 'candidate' }]);
  assert.equal(playing.clock.pending(), 0);

  const speculating = makeRig();
  await greet(speculating);
  await speculate(speculating);
  speculating.engine.hangUp();
  assert(speculating.sessions.opener.calls[0].signal.aborted && speculating.streams[1].cancelled);
  assert.equal(speculating.engine.state().phase, 'ended');
  assert.equal(speculating.clock.pending(), 0);
  speculating.engine.hangUp();
  assert.equal(speculating.of('ended').length, 1, 'ending twice reports once');

  const listening = makeRig();
  await greet(listening);
  listening.engine.hangUp();
  assert.equal(listening.engine.state().phase, 'ended');
  assert.equal(listening.clock.pending(), 0);
});

test('a helper error ends the call with the audio-error reason and the code', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.helperEvent({ type: 'error', code: 'capture-failed' });
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'audio-error', code: 'capture-failed' }]);
  assert.equal(rig.clock.pending(), 0);
});

test('a session failure during speculation restarts from the transcript, re-sends once and recovers', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  const message = rig.sessions.main.calls[1].message;
  rig.sessions.main.fail();
  await flush();
  assert.deepEqual(rig.restarts, [{ kind: 'main', transcriptText: "Interviewer: 'Hello, welcome to the call.'" }]);
  assert.deepEqual(rig.of('session-restart'), [{ type: 'session-restart', kind: 'main' }]);
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.equal(rig.sessions.main.calls[0].message, message, 'the same turn is re-sent');
  rig.sessions.main.answer('Why that design?');
  rig.streams[1].audio(300);
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  assert.equal(rig.of('ended').length, 0);
  assert.deepEqual(rig.streams[1].texts, ['Right.', 'Why that design?']);
});

test('a second failure in the same turn ends the call with a session error', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  await speculate(rig);
  rig.sessions.main.fail();
  await flush();
  rig.sessions.main.fail();
  await flush();
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'session-error' }]);
  assert.equal(rig.clock.pending(), 0);

  const noRestart = makeRig({ restartFails: true, autoOpener: true });
  await greet(noRestart);
  await speculate(noRestart);
  noRestart.sessions.main.fail();
  await flush();
  assert.equal(noRestart.of('ended')[0].reason, 'session-error');
});

test('a cancel is not a failure, and a stale failure after the candidate resumed is dropped', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.main.fail();
  rig.h.vad(true);
  await flush();
  assert.equal(rig.restarts.length, 0);
  assert.equal(rig.of('ended').length, 0);
  assert.equal(rig.engine.state().phase, 'listening');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.ops.filter(item => item.id === 'utt2').length, 0, 'stale voice audio is dropped');
});

test('an opener failure is retried once and then the reply is main only, with no marker', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  const message = rig.sessions.opener.calls[0].message;
  rig.sessions.opener.fail();
  await flush();
  assert.equal(rig.restarts[0].kind, 'opener');
  assert.equal(rig.sessions.opener.calls[0].message, message);
  rig.sessions.opener.fail();
  await flush();
  rig.sessions.main.answer('Tell me more. Why?');
  rig.streams[1].audio(300);
  await rig.clock.advance(600);
  assert.deepEqual(rig.streams[1].texts, ['Tell me more.', 'Why?']);
  assert.equal(rig.of('ended').length, 0);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
});

test('the opener deadline: an acknowledgement not known 1500 ms into the turn is aborted, none is spoken, and the main message has no marker', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1499);
  assert.equal(rig.sessions.main.calls.length, 1, 'still waiting for the acknowledgement');
  await rig.clock.advance(1);
  assert(rig.sessions.opener.calls[0].signal.aborted, 'the slow opener is aborted');
  assert.equal(rig.sessions.main.calls.length, 2, 'the main reply starts at the deadline');
  assert.equal(rig.sessions.main.calls[1].message, "[elapsed 00:00] Candidate: 'I built a scheduler'");
  rig.sessions.main.answer('Here is a question. Next?');
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Here is a question.', 'Next?']);
  const [report] = rig.of('opener');
  assert.deepEqual([report.outcome, report.spoken, report.text, report.words], ['timeout', false, '', 0]);
  assert.equal(report.ms, 1500);
});

test('timing events carry the helper-timeline measurements including last word to first sound', async () => {
  const rig = makeRig();
  await greet(rig);
  const greeting = rig.of('timing')[0];
  assert.equal(greeting.lastWordAt, null);
  assert.equal(greeting.lastWordToFirstSoundMs, null);
  await speak(rig, 'I built a scheduler', 'a');
  const last = rig.clock.now();
  await rig.clock.advance(600);
  await rig.clock.advance(100);
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  await rig.clock.advance(150);
  rig.sessions.main.answer('Why this design?');
  rig.streams[1].audio(800);
  await rig.clock.advance(350);
  await rig.clock.advance(50);
  rig.h.playback('utt2', 'started');
  const timing = rig.of('timing')[1];
  assert.deepEqual(timing, {
    type: 'timing', lastWordAt: last, speculatedAt: last + 600, openerFirstDeltaMs: 100, mainFirstSentenceMs: 250,
    firstAudioAt: last + 850, playbackStartedAt: last + 1250, lastWordToFirstSoundMs: 1250,
    voiceCharsSent: 'Right, got it.'.length + 'Why this design?'.length,
  });
  assert.equal(rig.engine.state().elapsedMs, rig.clock.now());
});

test('race: resuming one millisecond before commit discards the reply; resuming at commit is an overlap', async () => {
  const before = makeRig();
  await greet(before);
  await speculate(before);
  before.sessions.opener.answer('Right.');
  await flush();
  before.sessions.main.answer('Why?');
  before.streams[1].audio(300);
  await before.clock.advance(599);
  before.h.vad(true);
  await before.clock.advance(5);
  assert.equal(before.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert(before.sessions.main.calls[1].signal.aborted);

  const at = makeRig();
  await greet(at);
  await speculate(at);
  at.sessions.opener.answer('Right.');
  await flush();
  at.sessions.main.answer('Why?');
  at.streams[1].audio(300);
  await at.clock.advance(600);
  assert.equal(at.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the commit timer fired first');
  at.h.vad(true);
  at.h.transcript('um', 'o1', at.clock.now());
  await flush();
  assert(!at.sessions.main.calls[1].signal.aborted, 'speech at commit is an overlap, not a discard');
  assert.equal(cancelsOf(at, 'utt2'), 0);
  await at.clock.advance(701);
  assert.equal(cancelsOf(at, 'utt2'), 1, 'the overlap then stops it by duration');
});

const MARK = text => `[You have already started your reply out loud with: '${text}' Carry on from there.]`;
const typedMessage = text => `Candidate (typed in chat): '${text}'`;

test('F12/G1: delayed helper delivery only adds to the offset, and a stray transcript never latches it', async () => {
  const delayed = makeRig();
  await greet(delayed);
  delayed.h.vad(true);
  delayed.h.transcript('I built a scheduler', 'a', 0, false, 0);
  await delayed.clock.advance(300);
  // The vad end was really at clock 100 but arrives 200 ms late: the engine must not trust the older offset.
  delayed.engine.helperEvent({ type: 'vad', speaking: false, atMs: delayed.clock.now() - 200 - HELPER_OFFSET });
  await delayed.clock.advance(599);
  assert.equal(delayed.sessions.opener.calls.length, 0, 'speculation waits a full speculateMs after the latest-offset end');
  await delayed.clock.advance(1);
  assert.equal(delayed.sessions.opener.calls.length, 1);

  const stray = makeRig();
  stray.engine.start({ greeting: true });
  await flush();
  stray.engine.helperEvent({ type: 'transcript', text: 'stray', segmentId: 's0', final: true, startMs: -6000, endMs: -2000 });
  stray.h.level();
  stray.sessions.main.answer('Hello there.');
  stray.streams[0].audio(3200);
  await flush();
  stray.h.playback('utt1', 'started');
  stray.h.playback('utt1', 'finished', 1500);
  await flush();
  await speak(stray, 'I built a scheduler', 'a');
  await stray.clock.advance(599);
  assert.equal(stray.sessions.opener.calls.length, 0, 'the offset comes from the level event, not the transcript end');
  await stray.clock.advance(1);
  assert.equal(stray.sessions.opener.calls.length, 1);
});

test('F1: a typed message before the earlier typed reply commits is merged, in order, into one typed turn', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('first message here');
  await flush();
  rig.engine.typed('second one');
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[0].signal.aborted, 'the first typed reply was discarded');
  assert.match(rig.sessions.opener.calls[1].message,
    /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] \[You last said: 'Hello, welcome to the call\.'\] Candidate \(typed in chat\): 'first message here\nsecond one'$/);
  rig.sessions.opener.answer('Okay.');
  await flush();
  assert.equal(rig.sessions.main.calls[1].message.split('Candidate (typed in chat): ')[1].replace(/ \[You have already started your reply out loud with: .*$/, ''), "'first message here\nsecond one'", 'the first typed turn never started its main reply');
  rig.sessions.main.answer('Walk me through it.');
  rig.streams[2].audio(300);
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => `${entry.speaker}:${entry.channel ?? '-'}:${entry.text}`), [
    'interviewer:-:Hello, welcome to the call.', 'candidate:chat:first message here', 'candidate:chat:second one',
    'interviewer:-:Okay. Walk me through it.',
  ]);
  rig.h.playback('utt3', 'started');
  rig.h.playback('utt3', 'finished', 900);
  await flush();
  rig.engine.typed('after the reply');
  await flush();
  assert(rig.sessions.opener.calls[2].message.endsWith(typedMessage('after the reply')), 'pending typed texts were cleared at commit');
});

test('F5: typed while a cancel is pending queues into ONE typed turn and never starts a parallel reply', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.typed('wait what is that');
  rig.engine.typed('and one more thing');
  await rig.clock.advance(300);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.streams.length, 2, 'no parallel reply while the cancel is pending');
  assert.equal(rig.sessions.opener.calls.length, 1);
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  assert.equal(rig.streams.length, 3, 'exactly one typed reply started');
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[1].message.endsWith(typedMessage('wait what is that\nand one more thing')));
  assert.equal(rig.sessions.main.calls.length, 3);
});

test('F6: a typed reply that commits while the candidate is speaking starts an overlap at commit', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.h.vad(true);
  rig.engine.typed('Here is my code');
  await flush();
  rig.sessions.opener.answer('Okay.');
  await flush();
  rig.sessions.main.answer('Walk me through it.');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'typed replies commit at once');
  rig.h.transcript('um', 'o1', rig.clock.now());
  await rig.clock.advance(700);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'the overlap that began at commit stops it by duration');
  assert.equal(rig.engine.state().phase, 'listening');
});

test('F7: more words at commit than at speculation discard the reply and re-speculate at once', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  rig.h.transcript('I built a scheduler and tested it', 'a', 0, true, 300);
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'the stale reply is not played');
  assert(rig.sessions.main.calls[1].signal.aborted);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert.match(rig.sessions.opener.calls[1].message, /\[Your previous reply was not spoken: the candidate was still talking\.\].*Candidate: 'I built a scheduler and tested it'$/);
  rig.sessions.opener.answer('Good.');
  await flush();
  rig.sessions.main.answer('What next?');
  rig.streams[2].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt3').length, 1, 'no new speculation delay');
  rig.h.playback('utt3', 'started');
  assert.equal(rig.of('timing').pop().respeculated, 1);
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text),
    ['I built a scheduler and tested it']);
});

test('F3/G3: main failing after forwarded sentences and a chat finishes truncated, no re-send, and the next turn carries a cut-off note', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush();
  rig.sessions.main.calls[1].onDelta('Here is the problem. <chat>Write a sum.</chat> Next sen');
  rig.streams[1].audio(300);
  rig.sessions.main.fail();
  await flush();
  assert.deepEqual(rig.restarts.map(item => item.kind), ['main']);
  assert.equal(rig.sessions.main.calls.length, 0, 'the turn is not re-sent on the fresh session');
  assert.deepEqual(rig.streams[1].texts, ['Right.', 'Here is the problem.']);
  assert.equal(rig.of('ended').length, 0);
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the spoken part plays');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
  assert.deepEqual(rig.of('chat'), [{ type: 'chat', from: 'interviewer', text: 'Write a sum.' }], 'the chat is posted once');
  assert.equal(rig.engine.state().phase, 'listening');
  await speak(rig, 'okay then', 'b');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Okay.');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1, 'the next turn uses the restarted session');
  assert(rig.sessions.main.calls[0].message.startsWith(
    "[Your previous reply was cut off by a connection problem after: 'Here is the problem.'.] [elapsed "));
  rig.sessions.main.answer('Fine.');
  rig.streams[2].audio(300);
  await rig.clock.advance(600);
  rig.h.playback('utt3', 'started');
  rig.h.playback('utt3', 'finished', 900);
  await flush();
  await speak(rig, 'one more', 'c');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Okay.');
  await flush();
  assert(rig.sessions.main.calls[1].message.startsWith('[elapsed '), 'the note rides on one message only');
});

test('F3: chats are de-duplicated per reply by exact text', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Sure.');
  await flush();
  rig.sessions.main.answer('x', { chunks: ['Look. <chat>Same text.</chat> <chat>Same text.</chat> <chat>Other.</chat>'] });
  rig.streams[1].audio(300);
  await rig.clock.advance(600);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
  assert.deepEqual(rig.of('chat').map(event => event.text), ['Same text.', 'Other.']);
});

test('F4/G2: a voice stream that finishes without audio means the reply was not spoken', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation: finish() is not deferred
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Goodbye.<end-call/>');
  await flush();
  assert.deepEqual(rig.of('error'), [{ type: 'error', code: 'voice-failed' }]);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.of('ended').length, 0, 'end-call is not honoured for an unspoken reply');
  await rig.clock.advance(2000);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'no interviewer entry for it');
  await speak(rig, 'hello again', 'b');
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message, /\[Your previous reply was not spoken: the candidate was still talking\.\]/);

  const quiet = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(quiet);
  await speculate(quiet);
  quiet.sessions.opener.answer('Right.');
  await flush();
  quiet.sessions.main.answer('Goodbye.');
  await flush();
  assert.equal(quiet.of('error').length, 1);
  const before = quiet.sessions.main.calls.length;
  await quiet.clock.advance(20000);
  assert.equal(quiet.sessions.main.calls.length, before + 1, 'silence is armed again');

  const failing = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(failing);
  await speculate(failing);
  failing.streams[1].finish = () => Promise.reject(new Error('voice dropped'));
  failing.sessions.opener.answer('Right.');
  await flush();
  failing.sessions.main.answer('Why?');
  await flush();
  assert.deepEqual(failing.of('error'), [{ type: 'error', code: 'voice-failed' }]);
  assert.equal(failing.engine.state().phase, 'listening');
  assert.equal(failing.opsOf('play').filter(item => item.id === 'utt2').length, 0);

  const chatOnly = makeRig();
  await greet(chatOnly);
  await speculate(chatOnly);
  chatOnly.sessions.opener.answer('');
  await flush();
  chatOnly.sessions.main.answer('<chat>Just a note.</chat>');
  await flush();
  await chatOnly.clock.advance(600);
  assert.equal(chatOnly.of('error').length, 0, 'a reply with no spoken parts keeps the silent path');
  assert.deepEqual(chatOnly.of('chat').map(event => event.text), ['Just a note.']);
});

test('G2: voice.open throwing reports an error, returns to listening and keeps the call alive', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.failOpen = true;
  await speculate(rig);
  assert.deepEqual(rig.of('error'), [{ type: 'error', code: 'voice-open-failed' }]);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.sessions.opener.calls.length, 0);
  await rig.clock.advance(10000);
  assert.equal(rig.of('error').length >= 1, true);
  assert.equal(rig.of('ended').length, 0);
});

test('F2: a restart that finishes after the reply was discarded is still adopted; one that finishes after the call ended is closed', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  await speculate(rig);
  const release = rig.hold();
  const original = rig.sessions.main;
  rig.sessions.main.fail();
  await flush();
  rig.h.vad(true);
  await flush();
  release();
  await flush();
  assert.notEqual(rig.sessions.main, original);
  rig.h.transcript('and more', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.equal(rig.sessions.main.calls.length, 1, 'the next turn goes to the adopted session');
  assert.equal(original.calls.length, 2, 'the failed session is not used again');

  const ended = makeRig({ autoOpener: true });
  await greet(ended);
  await speculate(ended);
  const free = ended.hold();
  ended.sessions.main.fail();
  await flush();
  ended.engine.hangUp();
  free();
  await flush();
  assert.equal(ended.sessions.main.closed, true, 'a session created during an ended call is closed');
  assert.equal(ended.of('ended').length, 1);
});

test('F10: typed() clears the typing state so the message and the silence prompt are not suppressed', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  rig.engine.typing(true);
  rig.engine.typed('hello there friend');
  await flush();
  assert.equal(rig.sessions.main.calls[1].message,
    `[elapsed 00:00] ${typedMessage('hello there friend')}`);
  rig.sessions.main.answer('Go on.');
  rig.streams[1].audio(300);
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 600);
  await rig.clock.advance(20000);
  assert.equal(rig.sessions.main.calls.length, 3, 'the silence prompt is armed again');
});

test('F11: the word boundary is computed from the live playback position, capped at the utterance length', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await shortOverlap(rig, 'right'); // 200 ms pass: the live position is about 300, inside the second word
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(279);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the second word ends at 580, so 280 ms from the live position');
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1);

  const capped = makeRig();
  await greet(capped);
  await toPlaying(capped);
  capped.h.playback('utt2', 'position', 3270);
  await shortOverlap(capped, 'right');
  capped.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(capped, 'utt2'), 1, 'past the utterance length the stop is immediate');
});

test('F8: overlap words may start up to 250 ms before the VAD onset, and a late transcript is awaited for 600 ms', async () => {
  const early = makeRig();
  await greet(early);
  await toPlaying(early);
  early.h.vad(true);
  early.h.transcript('wait what do', 'o1', early.clock.now() - 200);
  await flush();
  assert.equal(cancelsOf(early, 'utt2'), 1, 'words that began just before the VAD onset count');

  const late = makeRig();
  await greet(late);
  await toPlaying(late);
  const t0 = late.clock.now();
  late.h.vad(true);
  await late.clock.advance(200);
  late.h.vad(false);
  await late.clock.advance(300);
  assert.equal(late.sessions.classifier.calls.length, 0);
  late.h.transcript('right', 'o1', t0);
  await flush();
  assert.equal(late.sessions.classifier.calls.length, 1, 'a segment within the wait applies the normal rules');

  const tooLate = makeRig();
  await greet(tooLate);
  await toPlaying(tooLate);
  const t1 = tooLate.clock.now();
  tooLate.h.vad(true);
  await tooLate.clock.advance(200);
  tooLate.h.vad(false);
  await tooLate.clock.advance(601);
  tooLate.h.transcript('right', 'o1', t1);
  await flush();
  assert.equal(tooLate.sessions.classifier.calls.length, 0, 'after 600 ms the overlap is ignored');
  assert.equal(cancelsOf(tooLate, 'utt2'), 0);

  const many = makeRig();
  await greet(many);
  await toPlaying(many);
  const t2 = many.clock.now();
  many.h.vad(true);
  await many.clock.advance(200);
  many.h.vad(false);
  await many.clock.advance(300);
  many.h.transcript('hold on please', 'o1', t2);
  await flush();
  assert.equal(cancelsOf(many, 'utt2'), 1, 'more than the word limit stops at once');
  assert.equal(many.sessions.classifier.calls.length, 0);
});

test('F9: the duration rule waits for a transcript word; echo residue with no words never stops playback', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  await rig.clock.advance(701);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'duration alone, with no words, does not stop');
  rig.h.transcript('um', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'the first word stops it while the overlap is still speaking');

  const ending = makeRig();
  await greet(ending);
  await toPlaying(ending);
  const t0 = ending.clock.now();
  ending.h.vad(true);
  await ending.clock.advance(800);
  ending.h.vad(false);
  await ending.clock.advance(100);
  assert.equal(cancelsOf(ending, 'utt2'), 0);
  ending.h.transcript('um', 'o1', t0);
  await flush();
  assert.equal(cancelsOf(ending, 'utt2'), 1, 'a word found at the overlap end after a long overlap stops it');

  const echo = makeRig();
  await greet(echo);
  await toPlaying(echo);
  echo.h.vad(true);
  await echo.clock.advance(800);
  echo.h.vad(false);
  await echo.clock.advance(3000);
  assert.equal(cancelsOf(echo, 'utt2'), 0);
  assert.equal(echo.sessions.classifier.calls.length, 0);
  assert.equal(echo.engine.state().phase, 'playing');
});

test('F13: a playback that never starts, or never finishes, is reported and finished as heard-up-to-position', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(600);
  assert.equal(rig.engine.state().phase, 'committed');
  await rig.clock.advance(2999);
  assert.equal(rig.of('error').length, 0);
  await rig.clock.advance(1);
  assert.deepEqual(rig.of('error'), [{ type: 'error', code: 'playback-stalled' }]);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: '' }]);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer', 'candidate']);

  const unfinished = makeRig();
  await greet(unfinished);
  await toPlaying(unfinished);
  unfinished.h.playback('utt2', 'position', 650);
  await unfinished.clock.advance(5629);
  assert.equal(unfinished.of('error').length, 0, 'remaining audio (2630 ms) plus 3000 ms');
  await unfinished.clock.advance(1);
  assert.deepEqual(unfinished.of('error'), [{ type: 'error', code: 'playback-stalled' }]);
  assert.equal(cancelsOf(unfinished, 'utt2'), 1);
  assert.equal(unfinished.engine.state().phase, 'listening');
  assert.deepEqual(bare(unfinished.engine.state().transcript.pop()),
    { speaker: 'interviewer', text: 'Right, got', interrupted: true, heardText: 'Right, got' });
});

test('F14: the opener restarts at most once, an empty heard text leaves no entry, and finished while cancelling is fully heard', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.fail();
  await flush();
  rig.sessions.opener.fail();
  await flush();
  assert.equal(rig.restarts.filter(item => item.kind === 'opener').length, 1, 'one restart at most');

  const empty = makeRig();
  await greet(empty);
  await toPlaying(empty);
  empty.h.vad(true);
  empty.h.transcript('wait what do', 'o1', empty.clock.now());
  await flush();
  empty.h.playback('utt2', 'cancelled', 0);
  await flush();
  assert.deepEqual(empty.of('interrupted'), [{ type: 'interrupted', heardText: '' }]);
  assert.deepEqual(empty.engine.state().transcript.map(entry => entry.text), ['Hello, welcome to the call.', 'I built a scheduler']);
  empty.h.transcript('wait what do you mean', 'o1', empty.clock.now());
  await empty.clock.advance(100);
  empty.h.vad(false);
  await empty.clock.advance(600);
  assert(empty.sessions.opener.calls[1].message.includes("[You last said: 'Hello, welcome to the call.']"));

  const whole = makeRig();
  await greet(whole);
  await toPlaying(whole);
  whole.h.playback('utt2', 'position', 650);
  whole.h.vad(true);
  whole.h.transcript('wait what do', 'o1', whole.clock.now());
  await flush();
  assert.equal(cancelsOf(whole, 'utt2'), 1);
  whole.h.playback('utt2', 'finished', 3300);
  await flush();
  assert.equal(whole.of('interrupted').length, 0, 'it was not interrupted');
  const spoken = 'Right, got it. Tell me about the design. What was hard?';
  assert.deepEqual(bare(whole.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop()),
    { speaker: 'interviewer', text: spoken });
  whole.h.transcript('wait what do you mean', 'o1', whole.clock.now());
  await whole.clock.advance(100);
  whole.h.vad(false);
  await whole.clock.advance(600);
  assert.match(whole.sessions.opener.calls[1].message,
    /^\[elapsed \d\d:\d\d\] \[You last said: 'Right, got it\. Tell me about the design\. What was hard\?'\] \[Your recent reactions, do not reuse their words: Interviewer: 'Right, got it\.'\] Candidate: 'wait what do you mean'$/);
});

test('G5: the cancel fallback timer resolves a stop when the helper never reports cancelled', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.typed('wait what is that');
  await flush();
  await rig.clock.advance(230 + 499);
  assert.equal(rig.of('interrupted').length, 0);
  assert.equal(rig.sessions.opener.calls.length, 1);
  await rig.clock.advance(1);
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: 'Right, got' }]);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[1].message.endsWith(typedMessage('wait what is that')));
});

test('G5: a helper-initiated cancelled trims the reply to what was heard and the next turn carries the note', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.h.playback('utt2', 'cancelled', 650);
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the engine did not ask for it');
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: 'Right, got' }]);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(bare(rig.engine.state().transcript.pop()),
    { speaker: 'interviewer', text: 'Right, got', interrupted: true, heardText: 'Right, got' });
  await speak(rig, 'sorry what', 's1');
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message,
    /\[You were interrupted after saying: 'Right, got'\. The rest was not heard\.\] Candidate: 'sorry what'$/);
});

test('G5: hangUp from committed-not-started, cancelling, classifier in flight and restart in flight', async () => {
  const committed = makeRig();
  await greet(committed);
  await speculate(committed);
  committed.sessions.opener.answer('Right.');
  await flush();
  committed.sessions.main.answer('Why?');
  committed.streams[1].audio(300);
  await committed.clock.advance(600);
  assert.equal(committed.engine.state().phase, 'committed');
  committed.engine.hangUp();
  assert.equal(cancelsOf(committed, 'utt2'), 1);
  assert.deepEqual(committed.of('ended'), [{ type: 'ended', reason: 'candidate' }]);
  assert.equal(committed.clock.pending(), 0);

  const stopping = makeRig();
  await greet(stopping);
  await toPlaying(stopping);
  stopping.engine.typed('wait what is that');
  await flush();
  stopping.engine.hangUp();
  stopping.h.playback('utt2', 'cancelled', 650);
  await stopping.clock.advance(5000);
  assert.equal(stopping.of('ended').length, 1);
  assert.equal(stopping.sessions.opener.calls.length, 1, 'the queued typed turn never starts');
  assert.equal(stopping.clock.pending(), 0);

  const asking = makeRig();
  await greet(asking);
  await toPlaying(asking);
  await shortOverlap(asking, 'right');
  const call = asking.sessions.classifier.calls[0];
  assert(!call.signal.aborted);
  asking.engine.hangUp();
  assert(call.signal.aborted, 'the classifier request is aborted');
  assert.equal(asking.clock.pending(), 0);
  call.resolve({ text: 'interruption' });
  await flush();
  assert.equal(cancelsOf(asking, 'utt2'), 1, 'only the hang-up cancelled it');

  const restarting = makeRig();
  await greet(restarting);
  await speculate(restarting);
  const release = restarting.hold();
  restarting.sessions.main.fail();
  await flush();
  restarting.engine.hangUp();
  release();
  await flush();
  assert.equal(restarting.of('ended').length, 1);
  assert.equal(restarting.clock.pending(), 0);
});

test('G5: a helper error while speculating or playing ends the call and stops everything', async () => {
  const speculating = makeRig();
  await greet(speculating);
  await speculate(speculating);
  speculating.engine.helperEvent({ type: 'error', code: 'device-lost' });
  assert.deepEqual(speculating.of('ended'), [{ type: 'ended', reason: 'audio-error', code: 'device-lost' }]);
  assert(speculating.sessions.opener.calls[0].signal.aborted && speculating.streams[1].cancelled);
  assert.equal(speculating.clock.pending(), 0);

  const playing = makeRig();
  await greet(playing);
  await toPlaying(playing);
  playing.engine.helperEvent({ type: 'error', code: 'device-lost' });
  assert.equal(cancelsOf(playing, 'utt2'), 1);
  assert.equal(playing.of('ended')[0].reason, 'audio-error');
  assert.equal(playing.clock.pending(), 0);
});

test('G6: the silence prompt re-arms after a blip, after an acknowledgement and after listen to a silence prompt', async () => {
  const blip = makeRig();
  await greet(blip);
  blip.h.vad(true);
  await blip.clock.advance(100);
  blip.h.vad(false);
  await blip.clock.advance(1200 + 19999);
  assert.equal(blip.sessions.main.calls.length, 1);
  await blip.clock.advance(1);
  assert.equal(blip.sessions.main.calls.length, 2, 'a vad blip with no words still ends in a silence prompt');

  const acked = makeRig();
  await greet(acked);
  await toPlaying(acked);
  await shortOverlap(acked, 'right');
  acked.sessions.classifier.answer('acknowledgement');
  await flush();
  acked.h.playback('utt2', 'finished', 3300);
  await flush();
  await acked.clock.advance(19999);
  assert.equal(acked.sessions.main.calls.length, 2);
  await acked.clock.advance(1);
  assert.equal(acked.sessions.main.calls.length, 3);

  const listened = makeRig();
  await greet(listened);
  await listened.clock.advance(20000);
  assert.equal(listened.sessions.main.calls.length, 2);
  listened.sessions.main.answer('<listen/>');
  await flush();
  assert.equal(listened.engine.state().phase, 'listening');
  await listened.clock.advance(19999);
  assert.equal(listened.sessions.main.calls.length, 2);
  await listened.clock.advance(1);
  assert.equal(listened.sessions.main.calls.length, 3, 'listen to a silence prompt arms the next one');
});

test('G6: resuming one millisecond before commit returns to listening and the next message notes it was not spoken', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await rig.clock.advance(599);
  rig.h.vad(true);
  await rig.clock.advance(5);
  assert.equal(rig.engine.state().phase, 'listening');
  rig.h.transcript('and tested it', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message,
    /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] \[You last said: 'Hello, welcome to the call\.'\] \[Your recent reactions, do not reuse their words: Interviewer: 'Right\.'\] Candidate: 'I built a scheduler and tested it'$/);
});

const lengthOf = list => list.reduce((sum, text) => sum + text.length, 0);

test('voice gate: a spoken turn sends no text before voiceGateMs, then flushes in order and only then finishes', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig); // 600 ms of silence: the voice is opened, nothing is sent
  assert.equal(rig.streams.length, 2, 'voice.open still happens at speculation');
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  await flush();
  rig.sessions.main.answer('Tell me about the design. What was hard?', { chunks: ['Tell me about ', 'the design. What was hard?'] });
  rig.streams[1].audio(1000);
  await flush();
  assert.deepEqual(rig.streams[1].texts, [], 'text is queued, not sent');
  assert.equal(rig.streams[1].finished, false, 'finish waits for the flush');
  await rig.clock.advance(599); // 1199 ms of silence
  assert.deepEqual(rig.streams[1].texts, []);
  assert.equal(rig.streams[1].finished, false);
  await rig.clock.advance(1); // 1200 ms: the gate opens
  const sent = ['Right, got it.', 'Tell me about the design.', 'What was hard?'];
  assert.deepEqual(rig.streams[1].texts, sent, 'flushed in order');
  assert.equal(rig.streams[1].finished, true, 'finish only after the flush');
  rig.h.playback('utt2', 'started');
  assert.equal(rig.of('timing').pop().voiceCharsSent, lengthOf(sent));
});

test('voice gate: text produced after the gate is sent directly, and the gate honours a custom voiceGateMs', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 900 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Mm.');
  await flush();
  await flush();
  assert.deepEqual(rig.streams[1].texts, []);
  await rig.clock.advance(299);
  assert.deepEqual(rig.streams[1].texts, []);
  await rig.clock.advance(1);
  assert.deepEqual(rig.streams[1].texts, ['Mm.']);
  rig.sessions.main.answer('Why that design?');
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Mm.', 'Why that design?'], 'sent at once once the gate is open');
  assert.equal(rig.streams[1].finished, true);
});

test('voice gate: resuming between speculation and the gate sends zero characters and reports a resumed discard', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  rig.sessions.main.answer('Why that design?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(300); // 900 ms of silence, before the gate
  rig.h.vad(true);
  await flush();
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 0, reason: 'resumed' }]);
  await rig.clock.advance(5000);
  assert.deepEqual(rig.streams[1].texts, [], 'the queue died with the reply');
  assert.equal(rig.streams[1].cancelled, true);
  assert.equal(rig.of('discarded').length, 1);
});

test('voice gate: resuming after the gate but before commit reports the characters already sent', async () => {
  const rig = makeRig({ thresholds: { commitMs: 2000 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush();
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(600); // 1200 ms: the gate opened, commit is still 800 ms away
  assert.deepEqual(rig.streams[1].texts, ['Right.', 'Why?']);
  await rig.clock.advance(300);
  rig.h.vad(true);
  await flush();
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 'Right.'.length + 'Why?'.length, reason: 'resumed' }]);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
});

test('voice gate: a listen verdict before the gate discards with zero characters sent', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await flush();
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 0, reason: 'listen' }]);
  await rig.clock.advance(3000);
  assert.deepEqual(rig.streams[1].texts, []);
  assert.equal(rig.of('discarded').length, 1);
});

test('voice gate: an F7 re-speculation reports a respeculated discard and the new reply sends at once', async () => {
  const rig = makeRig({ thresholds: { commitMs: 2000 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush();
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(600); // gate open, 'Right.' and 'Why?' sent
  rig.h.transcript('I built a scheduler and tested it', 'a', 0, true, 300);
  await rig.clock.advance(800); // commit finds more words than at speculation
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 'Right.'.length + 'Why?'.length, reason: 'respeculated' }]);
  assert.equal(rig.streams.length, 3);
  rig.sessions.opener.answer('Good.');
  await flush();
  await flush();
  assert.deepEqual(rig.streams[2].texts, ['Good.'], 'the new reply starts with the gate open');
});

test('voice gate: typed, silence and greeting turns send immediately', async () => {
  const greeting = makeRig();
  greeting.engine.start({ greeting: true });
  await flush();
  greeting.sessions.main.answer('Hello, welcome.');
  await flush();
  assert.deepEqual(greeting.streams[0].texts, ['Hello, welcome.']);
  assert.equal(greeting.streams[0].finished, true);

  const typed = makeRig();
  await greet(typed);
  typed.engine.typed('Here is my code');
  await flush();
  typed.sessions.opener.answer('Okay.');
  await flush();
  assert.deepEqual(typed.streams[1].texts, ['Okay.']);
  typed.sessions.main.answer('Walk me through it.');
  await flush();
  assert.deepEqual(typed.streams[1].texts, ['Okay.', 'Walk me through it.']);
  assert.equal(typed.streams[1].finished, true);

  const silent = makeRig();
  await greet(silent);
  await silent.clock.advance(20000);
  silent.sessions.main.answer('Still with me?');
  await flush();
  assert.deepEqual(silent.streams[1].texts, ['Still with me?']);
  assert.equal(silent.of('discarded').length, 0);
});

// ---- panel calls --------------------------------------------------------------
// John is marked as already known to the candidate, so remarks by him are heard where they are written; the
// "overlay: a colleague nobody has named yet" tests below use a panel without that mark.
const PANEL = () => ({ leadId: 'A', speakers: [
  { id: 'A', name: 'Priya', present: true }, { id: 'B', name: 'John', present: true, introduced: true }, { id: 'C', name: 'Mei', present: false },
] });
const panelRig = options => makeRig({ panel: PANEL(), speakerVoice: true, ...options });
const spoken = (id, base, ...list) => list.map((word, index) => ({ word, speakerId: id, startMs: base + index * 300, endMs: base + index * 300 + 280 }));
const HELLO_WORDS = [...spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'), ...spoken('B', 1200, 'And', 'I', 'am', 'John.')];

/** Greeting whose reply switches from the lead to a colleague; the voice reports both speakers. */
async function panelGreeting(rig, reply = 'Hello, I am Priya. <speaker id="B"/>And I am John.') {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(reply);
  rig.streams[0].audio(3200);
  rig.streams[0].words(HELLO_WORDS);
  rig.streams[0].speakerCb({ speakerId: 'A', startMs: 0 });
  rig.streams[0].speakerCb({ speakerId: 'B', startMs: 1200 });
  await flush();
}

/** The candidate speaks, both sessions answer and the reply (one audio chunk) plays to the end. */
async function answerTurn(rig, mainText, openerText = 'Right.') {
  await speak(rig, 'I built a scheduler', `t${rig.streams.length}`);
  await rig.clock.advance(1200);
  rig.sessions.opener.answer(openerText);
  await flush();
  rig.sessions.main.answer(mainText);
  const stream = rig.streams[rig.streams.length - 1];
  stream.audio(3200);
  await rig.clock.advance(1200);
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  return stream;
}

test('panel: a speaker tag switches the voice between the same sentences, with segments, speaker ids and speaker events', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  assert.deepEqual(rig.opens, [{ utteranceId: 'utt1', signal: rig.streams[0].signal, speakerId: 'A' }]);
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hello, I am Priya.' }, { speaker: 'B' }, { text: 'And I am John.' }], 'setSpeaker sits between the texts');
  rig.h.playback('utt1', 'started');
  assert.deepEqual(rig.of('speaker'), [{ type: 'speaker', speakerId: 'A' }], 'the first segment is shown at playback start');
  rig.h.playback('utt1', 'position', 1000);
  assert.equal(rig.of('speaker').length, 1, 'no event before the second segment reaches the playback position');
  rig.h.playback('utt1', 'position', 1250);
  assert.deepEqual(rig.of('speaker').map(event => event.speakerId), ['A', 'B']);
  rig.h.playback('utt1', 'position', 1400);
  assert.equal(rig.of('speaker').length, 2, 'the same speaker is not announced twice');
  const captions = rig.of('caption');
  assert.equal(captions[captions.length - 1].speakerId, 'B', 'the caption names the speaker of the newest text');
  rig.h.playback('utt1', 'finished', 2400);
  await flush();
  const entry = rig.engine.state().transcript[0];
  assert.deepEqual(bare(entry), {
    speaker: 'interviewer', text: 'Hello, I am Priya. And I am John.', speakerId: 'A',
    segments: [{ speakerId: 'A', text: 'Hello, I am Priya.' }, { speakerId: 'B', text: 'And I am John.' }],
  });
  assert.equal(rig.of('caption').pop().final, true);
  assert.equal(rig.of('caption').pop().speakerId, 'B');
});

test('panel: a reply from one interviewer has a speaker id but no segments', async () => {
  const rig = panelRig();
  await panelGreeting(rig, 'Hello there.');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript[0]), { speaker: 'interviewer', text: 'Hello there.', speakerId: 'A' });
});

test('panel: a tag for an id that was never cast drops what follows it, from the voice and the transcript', async () => {
  const rig = panelRig();
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('Hi. <speaker id="Y"/>Hello there. <speaker id="Z"/>Still me.');
  rig.streams[0].audio(640);
  await flush();
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hi.' }], 'nothing is spoken in the name of an id that is not on the call');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript[0]), { speaker: 'interviewer', text: 'Hi.', speakerId: 'A' });
});

test('panel: a cut-in switch passes { cutIn: true } to setSpeaker, directly and through the queue; ordinary switches pass nothing', async () => {
  const rig = panelRig({ createParser: tagParser });
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('<speaker id="A"/>One. <speaker id="B" cut/>Two. <speaker id="A"/>Three.');
  await flush();
  assert.deepEqual(rig.streams[0].log, [
    { text: 'One.' }, { speaker: 'B', options: { cutIn: true } }, { text: 'Two.' }, { speaker: 'A' }, { text: 'Three.' }]);
});

test('panel: a queued cut-in switch keeps its flag', async () => {
  const rig = panelRig({ autoOpener: true, createParser: tagParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Fine. <speaker id="B" cut/>Why?');
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[1].log, [{ text: 'Fine.' }, { speaker: 'B', options: { cutIn: true } }, { text: 'Why?' }]);
});

test('panel: a voice whose setSpeaker ignores a second argument still works with a cut-in', async () => {
  const rig = panelRig({ createParser: tagParser });
  rig.engine.start();
  await flush();
  const stream = rig.streams[0];
  const seen = [];
  stream.setSpeaker = id => { seen.push(id); return true; };
  rig.sessions.main.answer('<speaker id="A"/>One. <speaker id="B" cut/>Two.');
  await flush();
  assert.deepEqual(seen, ['B']);
  assert.deepEqual(stream.texts, ['One.', 'Two.']);
});

test('panel: a repeated tag for the speaker already talking does not call setSpeaker', async () => {
  const rig = panelRig();
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('<speaker id="A"/>One. <speaker id="B"/>Two. <speaker id="B"/>Three.');
  await flush();
  assert.deepEqual(rig.streams[0].log, [{ text: 'One.' }, { speaker: 'B' }, { text: 'Two.' }, { text: 'Three.' }]);
});

test('panel: with a gated voice the speaker switch is queued in order with the texts', async () => {
  const rig = panelRig({ autoOpener: true });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Fine. <speaker id="B"/>Why?');
  await flush();
  assert.deepEqual(rig.streams[1].log, [], 'nothing reaches the voice before the gate opens');
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[1].log, [{ text: 'Fine.' }, { speaker: 'B' }, { text: 'Why?' }]);
});

test('panel: participantJoined adds one marker to the next opener and main messages only, and never starts a turn', async () => {
  const rig = panelRig();
  await greet(rig);
  const before = rig.sessions.main.calls.length;
  rig.engine.participantJoined('C');
  rig.engine.participantJoined('C');
  rig.engine.participantJoined('Z');
  await rig.clock.advance(5000);
  assert.equal(rig.sessions.main.calls.length, before, 'joining alone sends nothing to the model');
  assert.equal(rig.of('phase').pop().phase, 'listening', 'joining does not start a turn');
  await answerTurn(rig, 'Welcome Mei. Question?');
  const marker = '[Mei has joined the call and is listening. They have not been introduced yet.]';
  assert.equal(rig.sessions.opener.calls[0].message.split(marker).length, 2, 'once in the opener message');
  const main = rig.sessions.main.calls[1].message;
  assert.equal(main.split(marker).length, 2, 'once in the main message');
  assert(main.indexOf(marker) < main.indexOf("Candidate: '"), 'before the candidate line');
  await answerTurn(rig, 'Next one.');
  assert(!rig.sessions.main.calls[2].message.includes('has joined'), 'the next message carries no marker');
  assert(!rig.sessions.opener.calls[1].message.includes('has joined'));
});

test('panel: a colleague who joined can then speak, and the marker survives a reply that was never committed', async () => {
  const rig = panelRig();
  await greet(rig);
  rig.engine.participantJoined('C');
  await speak(rig, 'I built', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Mm-hm.');
  await flush();
  assert(rig.sessions.main.calls[1].message.includes('Mei has joined'));
  rig.h.vad(true); // the candidate resumed: the speculative reply is dropped before it was committed
  rig.h.transcript('I built a scheduler', 'a', rig.clock.now());
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(1200);
  rig.sessions.opener.answer('Right.');
  await flush();
  assert(rig.sessions.main.calls[2].message.includes('Mei has joined'), 'still announced: the earlier message was never spoken');
  rig.sessions.main.answer('Mei, over to you. <speaker id="C"/>Thanks.');
  const stream = rig.streams[rig.streams.length - 1];
  stream.audio(640);
  await rig.clock.advance(1300);
  assert.deepEqual(stream.log.filter(item => item.speaker), [{ speaker: 'C' }], 'Mei may speak now');
});

test('panel: the floor carries to the next reply and opens its voice stream', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 2400);
  await flush();
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  assert.equal(rig.opens[1].speakerId, 'B', 'John spoke last, so he holds the floor');
  assert.equal(rig.opens[0].speakerId, 'A');
});

test('panel: an interruption during the second speaker keeps the first segment whole and trims the second', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 1800);
  rig.engine.typed('wait');
  rig.h.playback('utt1', 'cancelled', 1800);
  await flush();
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'interviewer');
  assert.deepEqual(bare(entry), {
    speaker: 'interviewer', text: 'Hello, I am Priya. And I', speakerId: 'A', interrupted: true, heardText: 'Hello, I am Priya. And I',
    segments: [{ speakerId: 'A', text: 'Hello, I am Priya.' }, { speakerId: 'B', text: 'And I' }],
  });
  rig.sessions.main.answer('Sure.');
  assert.equal(rig.opens[1].speakerId, 'B', 'the floor is the last speaker who was heard');
});

test('panel: an interruption inside the first segment leaves one segment and the lead on the floor', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 400);
  rig.engine.typed('wait');
  await rig.clock.advance(180); // the word in progress ends at 580 ms, where the stop lands
  rig.h.playback('utt1', 'cancelled', 600);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript.find(item => item.speaker === 'interviewer')), {
    speaker: 'interviewer', text: 'Hello, I', speakerId: 'A', interrupted: true, heardText: 'Hello, I',
  });
});

test('solo: no panel option sends the old messages, opens the voice without speakerId and adds no fields or events', async () => {
  const rig = makeRig({ speakerVoice: true });
  rig.engine.participantJoined?.('C');
  rig.engine.start();
  await flush();
  assert.equal(rig.sessions.main.calls[0].message, '[elapsed 00:00] [call connected]');
  rig.sessions.main.answer('Hello. <speaker id="B"/>Hi again.');
  rig.streams[0].audio(640);
  rig.streams[0].words(spoken('A', 0, 'Hello.', 'Hi', 'again.'));
  await flush();
  assert.deepEqual(rig.opens, [{ utteranceId: 'utt1', signal: rig.streams[0].signal }], 'exactly today\'s open arguments');
  assert.equal('speakerId' in rig.opens[0], false);
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hello.' }], 'text written for someone not on the call is not spoken');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(bare), [{ speaker: 'interviewer', text: 'Hello.' }]);
  assert.deepEqual(rig.of('speaker'), []);
  assert(rig.of('caption').every(event => !('speakerId' in event)));
  await answerTurn(rig, 'Next.');
  assert(!rig.sessions.main.calls[1].message.includes('joined'));
  assert.equal('speakerId' in rig.opens[1], false);
});

// Heard in the first live calls: the one-word acknowledgement was silent until the reply's first
// sentence arrived, because the voice service waits for about 40 characters before it speaks.
test('the acknowledgement is flushed to the voice at once, and free-form delivery tags never reach captions or the transcript', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my answer');
  await flush();
  rig.sessions.opener.answer('[thoughtful] Mm.');
  await flush();
  await flush();
  const stream = rig.streams[1];
  assert.deepEqual(stream.texts, ['[thoughtful] Mm.'], 'the tag goes to the voice');
  assert.deepEqual(stream.flushes, [1], 'asked to speak as soon as the acknowledgement was sent');
  rig.sessions.main.answer('[Warm, faint amusement] That is a LOT of devices. [curious] How did you test it?');
  stream.audio(500);
  await flush();
  // The reply's first piece is flushed (it may be under what the service waits for); later sentences are not.
  assert.deepEqual(stream.flushes, [1, 2], 'the reply itself is not flushed sentence by sentence');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
  const captions = rig.of('caption').filter(item => item.speaker === 'interviewer').map(item => item.text);
  assert.equal(captions.at(-1), 'Mm. That is a LOT of devices. How did you test it?');
  const said = rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').at(-1);
  assert.equal(said.text, 'Mm. That is a LOT of devices. How did you test it?');
});

// Heard 2026-11-19 in rendered clips: a reply started the instant the acknowledgement ended sounded rushed, and a
// sentence split at a comma to start sooner changed tone mid-sentence. Sentences are never split; the reply waits a
// natural pause after the acknowledgement when it is ready early, and its first sentence is flushed only when the
// acknowledgement is about to run out, so an early sentence waits for the next one and the two are voiced together.
const JOIN = { joinGapMinLeadMs: 900, joinFlushLeadMs: 900 };
const ACK_LINE = 'Mm-hm, okay, I follow you on that.';
/** A typed turn whose acknowledgement is voiced as `ackMs` of audio, its last word ending `tailMs` before the end, and playing. */
async function joinTurn(rig, { ack = ACK_LINE, ackMs = 2800, tailMs = 150, playedMs = 0 } = {}) {
  rig.engine.typed('Here is my answer');
  await flush();
  rig.sessions.opener.answer(ack);
  await flush();
  await flush();
  const stream = rig.streams.at(-1);
  stream.audio(Math.round((ackMs / 1000) * 24000) * 2);
  const list = ack.split(' ');
  const end = ackMs - tailMs;
  stream.words(list.map((word, index) => ({ word, startMs: (index * end) / list.length, endMs: ((index + 1) * end) / list.length })));
  await flush();
  rig.h.playback(stream.utteranceId, 'started');
  await flush();
  if (playedMs) await rig.clock.advance(playedMs);
  return stream;
}

test('join: a reply ready while the acknowledgement still plays follows a natural pause, and its first sentence waits to be voiced with the next', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  const stream = await joinTurn(rig);
  const call = rig.sessions.main.calls.at(-1);
  call.onDelta('Good to hear. ');
  await flush();
  // A full stop pauses 450 ms; 150 ms of it is already the near-silence after the last word.
  assert.deepEqual(stream.log, [{ text: ACK_LINE }, { gap: 300 }, { text: 'Good to hear.' }]);
  assert.deepEqual(stream.flushes, [1], 'the first sentence is not forced out while the acknowledgement has time to play');
  call.onDelta('What did you build first? ');
  await flush();
  await rig.clock.advance(2800 + 300 - 900 - 1);
  assert.deepEqual(stream.flushes, [1]);
  await rig.clock.advance(1);
  assert.deepEqual(stream.flushes, [1, 3], '900 ms before the acknowledgement and the pause end, what has arrived is voiced');
  assert.deepEqual(rig.of('join'), [{ type: 'join', utteranceId: stream.utteranceId, remainingMs: 2800, pauseMs: 300, flushInMs: 2200, gated: false }], 'each join is reported for the debug log');
  rig.sessions.main.answer('Good to hear. What did you build first?', { chunks: [] }); // the reply ends; its text has all streamed
  await flush();
  assert.equal(stream.finished, true);
  const said = rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').at(-1);
  assert.equal(said.text, `${ACK_LINE} Good to hear. What did you build first?`, 'captions and the transcript are unchanged');
});

test('join: a reply written in full before its flush is due is finished at once, which voices all of it together', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  const stream = await joinTurn(rig);
  rig.sessions.main.answer('Good to hear. What did you build first?');
  await flush();
  assert.equal(stream.finished, true);
  await rig.clock.advance(5000);
  assert.deepEqual(stream.flushes, [1], 'no stray flush after the finish');
});

test('join: a reply that arrives as the acknowledgement is ending gets no added pause and is voiced at once', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  const stream = await joinTurn(rig, { ackMs: 1500, playedMs: 700 });
  rig.sessions.main.answer('Good to hear. What did you build first?');
  await flush();
  assert.deepEqual(stream.log, [{ text: ACK_LINE }, { text: 'Good to hear.' }, { text: 'What did you build first?' }], '800 ms left: a new voice segment would not connect in time');
  assert.deepEqual(stream.flushes, [1, 2]);
});

test('join: the pause follows how the acknowledgement ended, and a longer tail already in the audio counts toward it', async () => {
  const question = makeRig({ thresholds: JOIN });
  await greet(question);
  const asked = await joinTurn(question, { ack: 'Yeah, good question, right?', tailMs: 100 });
  question.sessions.main.answer('It was mine.');
  await flush();
  assert.deepEqual(asked.log.filter(item => item.gap !== undefined), [{ gap: 450 }], '550 ms after a question, 100 ms already there');
  const long = makeRig({ thresholds: JOIN });
  await greet(long);
  const tail = await joinTurn(long, { tailMs: 600 });
  long.sessions.main.answer('It was mine.');
  await flush();
  assert.deepEqual(tail.log.filter(item => item.gap !== undefined), [], 'the voice already left more than a full stop\'s pause');
});

test('join: with nothing spoken ahead of it, the reply\'s first sentence is voiced at once and nothing is added', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  rig.engine.typed('Here is my answer');
  await flush();
  rig.sessions.opener.answer('');
  await flush();
  await flush();
  const stream = rig.streams.at(-1);
  rig.sessions.main.answer('Good to hear. What did you build first?');
  await flush();
  assert.deepEqual(stream.log, [{ text: 'Good to hear.' }, { text: 'What did you build first?' }]);
  assert.deepEqual(stream.flushes, [1]);
});

test('join: behind the voice gate the whole acknowledgement is still ahead, so the pause and the flush wait in the queue in order', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  await speculate(rig, 'I built the hub');
  rig.sessions.opener.answer(ACK_LINE);
  await flush();
  rig.sessions.main.answer('Tell me more about it.');
  await flush();
  const stream = rig.streams.at(-1);
  assert.deepEqual(stream.log, [], 'held behind the gate');
  await rig.clock.advance(700);
  // Nothing voiced yet, so the tail is the 150 ms estimate: 450 - 150.
  assert.deepEqual(stream.log, [{ text: ACK_LINE }, { gap: 300 }, { text: 'Tell me more about it.' }]);
  assert.deepEqual(stream.flushes, [], 'not forced out the moment the gate opens: the acknowledgement only starts now');
  assert.equal(stream.finished, true, 'the whole reply was written, so finishing it voices everything');
  assert.deepEqual(rig.of('join').map(item => [item.remainingMs, item.pauseMs, item.flushInMs, item.gated]), [[7 * 390, 300, null, true]], 'nothing voiced yet: 7 words at 390 ms');
});

test('join: behind the voice gate, a reply still being written has its first sentence flushed in time once the gate opens', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  await speculate(rig, 'I built the hub');
  rig.sessions.opener.answer(ACK_LINE);
  await flush();
  const call = rig.sessions.main.calls.at(-1);
  call.onDelta('Tell me more about it. ');
  await flush();
  const stream = rig.streams.at(-1);
  await rig.clock.advance(600); // the gate opens 1200 ms after the last word, 600 ms after speculation
  assert.deepEqual(stream.log, [{ text: ACK_LINE }, { gap: 300 }, { text: 'Tell me more about it.' }]);
  assert.deepEqual(stream.flushes, []);
  // The 7 words are estimated at 390 ms, then the 300 ms pause, less the 900 ms lead.
  await rig.clock.advance(7 * 390 + 300 - 900 - 1);
  assert.deepEqual(stream.flushes, []);
  await rig.clock.advance(1);
  assert.deepEqual(stream.flushes, [2]);
});

test('join: a voice that reports no words is not counted twice: the acknowledgement is its audio or its word estimate, whichever is longer', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  rig.engine.typed('Here is my answer');
  await flush();
  const twelve = 'Okay, yeah, I follow you, and thanks for walking me through it.';
  rig.sessions.opener.answer(twelve);
  await flush();
  await flush();
  const stream = rig.streams.at(-1);
  stream.audio(Math.round(4.5 * 24000) * 2); // 4.5 s received, no words reported
  rig.h.playback(stream.utteranceId, 'started');
  await flush();
  rig.sessions.main.answer('Good to hear.');
  await flush();
  assert.deepEqual(rig.of('join').map(item => item.remainingMs), [12 * 390], 'not 4.5 s plus the estimate');
});

test('join: a pending first-sentence flush is dropped when a pause ends that segment, and when the reply is abandoned', async () => {
  const paused = makeRig({ thresholds: JOIN });
  await greet(paused);
  const stream = await joinTurn(paused);
  paused.sessions.main.answer('Good to hear. <pause s="1"/> What did you build first?');
  await flush();
  await paused.clock.advance(5000);
  assert.deepEqual(stream.flushes, [1], 'the pause closed the segment, which voices it; no stray flush later');
  const dropped = makeRig({ thresholds: JOIN });
  await greet(dropped);
  const first = await joinTurn(dropped);
  dropped.sessions.main.answer('Good to hear.');
  await flush();
  dropped.engine.typed('Sorry, one more thing');
  await flush();
  await dropped.clock.advance(5000);
  assert.deepEqual(first.flushes, [1], 'nothing flushes the abandoned reply');
});

test('join: overlay anchors stay right after the join pause and after the first sentence\'s dropped mood tag', async () => {
  const gapped = panelRig({ createParser: patienceParser, thresholds: JOIN });
  await greet(gapped);
  await speak(gapped, 'I built a scheduler', 'jg');
  await gapped.clock.advance(600);
  gapped.sessions.opener.answer('Got it ok.'); // 3 words: about 1170 ms ahead, so a pause
  await flush();
  gapped.sessions.main.answer('Tell me.<over id="B" after="7">Hmm.</over>', { chunks: ['Tell me.<over id="B" after="7">Hmm.</over>'] });
  await flush();
  await gapped.clock.advance(700);
  const voice = gapped.streams.at(-1);
  assert(voice.log.some(item => item.gap === 300), JSON.stringify(voice.log));
  assert.deepEqual(voice.overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 7 }], 'after "Tell me." in the new segment, which starts with it');
  const tagged = panelRig({ createParser: patienceParser, thresholds: JOIN });
  await greet(tagged);
  await speak(tagged, 'I built a scheduler', 'jt');
  await tagged.clock.advance(600);
  tagged.sessions.opener.answer('Right.'); // 1 word: too little ahead for a pause
  await flush();
  tagged.sessions.main.answer('[curious] Tell me.<over id="B" after="16">Hmm.</over>', { chunks: ['[curious] Tell me.<over id="B" after="16">Hmm.</over>'] });
  await flush();
  await tagged.clock.advance(700);
  const sent = tagged.streams.at(-1);
  assert.deepEqual(sent.texts, ['Right.', 'Tell me.']);
  assert.deepEqual(sent.overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 6 + 7 }], '"Right." and "Tell me." as sent, not the dropped tag');
});

test('join: right after an acknowledgement in the same voice, the reply\'s first sentence loses its mood tag; later ones keep theirs', async () => {
  const rig = makeRig({ thresholds: JOIN });
  await greet(rig);
  const stream = await joinTurn(rig);
  rig.sessions.main.answer('[even, moving on] Let us switch to games. [curious] What are you playing lately?');
  await flush();
  assert.deepEqual(stream.texts, [ACK_LINE, 'Let us switch to games.', '[curious] What are you playing lately?']);
  const none = makeRig({ thresholds: JOIN });
  await greet(none);
  none.engine.typed('Here is my answer');
  await flush();
  none.sessions.opener.answer('');
  await flush();
  await flush();
  none.sessions.main.answer('[even] Let us switch to games.');
  await flush();
  assert.deepEqual(none.streams.at(-1).texts, ['[even] Let us switch to games.'], 'with nothing said ahead of it, the tag stays');
});

test('join: anchors stay right when the dropped mood tag comes with the pause, or was written as a piece of its own', async () => {
  const both = panelRig({ createParser: patienceParser, thresholds: JOIN });
  await greet(both);
  await speak(both, 'I built a scheduler', 'jb');
  await both.clock.advance(600);
  both.sessions.opener.answer('Got it ok.');
  await flush();
  both.sessions.main.answer('[curious] Tell me.<over id="B" after="16">Hmm.</over>', { chunks: ['[curious] Tell me.<over id="B" after="16">Hmm.</over>'] });
  await flush();
  await both.clock.advance(700);
  const gapped = both.streams.at(-1);
  assert.deepEqual(gapped.texts, ['Got it ok.', 'Tell me.']);
  assert.deepEqual(gapped.overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 7 }], 'in the new segment, after "Tell me."');
  const held = panelRig({ createParser: patienceParser, thresholds: JOIN });
  await greet(held);
  await speak(held, 'I built a scheduler', 'jh');
  await held.clock.advance(600);
  held.sessions.opener.answer('Right.');
  await flush();
  held.sessions.main.answer('[curious]<wait s="10"/>Tell me.<over id="B" after="16">Hmm.</over>', { chunks: ['[curious]<wait s="10"/>Tell me.<over id="B" after="16">Hmm.</over>'] });
  await flush();
  await held.clock.advance(700);
  const merged = held.streams.at(-1);
  assert.deepEqual(merged.texts, ['Right.', 'Tell me.'], 'the tag written on its own is held, merged and then dropped');
  assert.deepEqual(merged.overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 6 + 7 }]);
});

test('join: a speaker switch ends the segment that held the first sentence, so its pending flush never touches the colleague', async () => {
  const rig = panelRig({ thresholds: JOIN });
  await greet(rig);
  rig.engine.participantJoined?.('B');
  const stream = await joinTurn(rig);
  const call = rig.sessions.main.calls.at(-1);
  call.onDelta('Good to hear. ');
  await flush();
  call.onDelta('<speaker id="B"/>Hi, I am John, I lead the platform team here. ');
  await flush();
  await rig.clock.advance(5000);
  assert(stream.log.some(item => item.speaker === 'B'), JSON.stringify(stream.log));
  assert.deepEqual(stream.flushes, [1], 'nothing forces out the colleague\'s half-written line');
});

test('pause: an overlay in the sentence after a held pause is anchored from the start of that sentence', async () => {
  const rig = panelRig({ thresholds: JOIN });
  await greet(rig);
  rig.engine.participantJoined?.('B');
  rig.engine.typed('Here is my answer');
  await flush();
  rig.sessions.opener.answer('');
  await flush();
  await flush();
  rig.sessions.main.answer('Hi. <pause s="1"/>Tell me<over id="B">Hmm.</over> more.');
  await flush();
  const stream = rig.streams.at(-1);
  assert(stream.log.some(item => item.gap === 1000), JSON.stringify(stream.log));
  assert.deepEqual(stream.overlays.map(item => item.afterChars), ['Tellme'.length], 'after "Tell me", not clamped to the segment start');
});

test('joinPauseMs: a full stop pauses longer than a comma; tags, quotes and an ellipsis are read right', () => {
  assert.equal(joinPauseMs('Mm-hm, okay.'), JOIN_PAUSE_MS['.']);
  assert.equal(joinPauseMs('Right, good question?'), JOIN_PAUSE_MS['?']);
  assert.equal(joinPauseMs('Okay, so,'), JOIN_PAUSE_MS[',']);
  assert.equal(joinPauseMs('Well...'), JOIN_PAUSE_MS['…']);
  assert.equal(joinPauseMs('"Okay, sure." [warm]'), JOIN_PAUSE_MS['.']);
  assert.equal(joinPauseMs('Okay'), JOIN_PAUSE_MS.other);
  assert(JOIN_PAUSE_MS['.'] > JOIN_PAUSE_MS[','] && JOIN_PAUSE_MS['?'] >= JOIN_PAUSE_MS['.']);
});

// Heard in a live call: the acknowledgement came back as "Oh, totally understandable. Got it." and
// the reply then said the same thing again.
const TOO_LONG = 'Okay, yeah, I follow you, and thanks for walking me through it, really.'; // 13 words

test('an acknowledgement is spoken as written however long it is, and the marker carries its exact words without the tag', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('A little nervous, honestly');
  await flush();
  rig.sessions.opener.answer(`[warmly] ${TOO_LONG}`);
  await flush();
  await flush();
  assert.deepEqual(rig.streams[1].texts, [`[warmly] ${TOO_LONG}`], 'no word cap, and a tag does not count as a word');
  assert.deepEqual(rig.streams[1].flushes, [1]);
  assert.equal(rig.sessions.main.calls[1].message, `[elapsed 00:00] Candidate (typed in chat): 'A little nervous, honestly' ${MARK(TOO_LONG)}`);
  assert.deepEqual(rig.of('opener').map(item => [item.outcome, item.spoken, item.words]), [['spoken', true, 13]]);
});

test('a bare delivery tag is not an acknowledgement and nothing is sent to the voice for it', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my answer');
  await flush();
  rig.sessions.opener.answer('[warmly]');
  await flush();
  await flush();
  assert.deepEqual(rig.streams[1].texts, []);
  assert.deepEqual(rig.streams[1].flushes, []);
});

// On a spoken turn the acknowledgement waits behind the voice gate. It is flushed when the gate
// opens only if nothing else is waiting with it.
test('behind the voice gate, the acknowledgement is flushed when the gate opens unless the reply is already queued', async () => {
  const alone = makeRig();
  await greet(alone);
  await speculate(alone, 'I built the hub');
  alone.sessions.opener.answer('Right.');
  await flush();
  const first = alone.streams[1];
  assert.deepEqual(first.texts, [], 'held behind the gate');
  assert.deepEqual(first.flushes, []);
  await alone.clock.advance(700);
  assert.deepEqual(first.texts, ['Right.']);
  assert.deepEqual(first.flushes, [1], 'flushed as the gate opens');

  const together = makeRig();
  await greet(together);
  await speculate(together, 'I built the hub');
  together.sessions.opener.answer('Right.');
  await flush();
  together.sessions.main.answer('Tell me more about it.');
  await flush();
  await together.clock.advance(700);
  const second = together.streams[1];
  assert.deepEqual(second.texts, ['Right.', 'Tell me more about it.']);
  assert.deepEqual(second.flushes, [2], 'the acknowledgement is not forced on its own: the reply\'s first piece asks for both');
});

// ---- shared screen and coding pad --------------------------------------------
// A stub parser: tokens [[screen:Title|Content]], [[stop]], [[pad-open:lang]], [[pad-close]], [[spk:B]] become items in order,
// everything else is split into sentences, so these tests do not depend on the real parser.
function screenParser() {
  const run = text => {
    const items = [];
    for (const piece of text.split(/(\[\[[^\]]*\]\])/).filter(Boolean)) {
      const token = piece.match(/^\[\[([a-z-]+)(?::([^\]]*))?\]\]$/);
      if (!token) { for (const sentence of piece.match(/[^.!?]+[.!?]/g) ?? []) items.push({ sentence: sentence.trim() }); continue; }
      const [, kind, arg = ''] = token;
      if (kind === 'screen') {
        // An optional last part '#4' is the delay in seconds.
        const [title, ...rest] = arg.split('|');
        const last = rest.length > 1 ? rest[rest.length - 1].match(/^#(.+)$/) : null;
        if (last) rest.pop();
        items.push({ screen: { title, content: rest.join('|'), delaySeconds: last ? Number(last[1]) : null } });
      }
      else if (kind === 'stop') items.push({ screenStop: true });
      else if (kind === 'pad-open') items.push({ pad: { open: true, lang: arg } });
      else if (kind === 'pad-close') items.push({ pad: { open: false } });
      else if (kind === 'spk') items.push({ speaker: arg });
      else if (kind === 'pause') items.push({ pause: Number(arg) });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

async function deliver(rig, text) {
  await speak(rig, 'I built a scheduler', `s${rig.streams.length}`);
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer(text);
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
}

test('screen and pad items are applied only when the reply is delivered, in order, with events and state', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  assert.deepEqual(rig.engine.state().screen, null);
  assert.deepEqual(rig.engine.state().pad, { open: false, lang: '' });
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Look at my screen.[[screen:Sum|Add two numbers.]] Write it in the pad.[[pad-open:python]]');
  rig.streams[1].audio(1000);
  await flush();
  assert.equal(rig.of('screen').length, 0, 'nothing before the commit');
  assert.equal(rig.engine.state().screen, null);
  await rig.clock.advance(700);
  assert.equal(rig.of('screen').length, 0, 'committed but not yet playing: still nothing');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500); // no word timings: everything is delivered when the reply finishes
  await flush();
  assert.deepEqual(rig.of('screen').map(event => ({ type: event.type, title: event.title, content: event.content, speakerId: event.speakerId })), [{ type: 'screen', title: 'Sum', content: 'Add two numbers.', speakerId: 'A' }]);
  assert(Number.isFinite(rig.of('screen')[0].atMs));
  assert.deepEqual(rig.of('pad').map(event => ({ type: event.type, open: event.open, lang: event.lang })), [{ type: 'pad', open: true, lang: 'python' }]);
  assert.deepEqual(rig.engine.state().screen, { title: 'Sum', content: 'Add two numbers.', speakerId: 'A' });
  assert.deepEqual(rig.engine.state().pad, { open: true, lang: 'python' });
  assert(!rig.streams[1].texts.join(' ').includes('Add two'), 'screen content is never spoken');
  await deliver(rig, 'Next part.[[screen:Part two|Now sort them.]][[pad-open:]]');
  assert.deepEqual(rig.engine.state().screen, { title: 'Part two', content: 'Now sort them.', speakerId: 'A' }, 'replaces what was shown');
  assert.deepEqual(rig.engine.state().pad, { open: true, lang: 'python' }, 'reopening keeps the label');
  await deliver(rig, 'Done.[[stop]][[pad-close]]');
  assert.equal(rig.engine.state().screen, null);
  assert.deepEqual(rig.engine.state().pad, { open: false, lang: 'python' });
  assert.equal(rig.of('screen-stop').length, 1);
  assert.equal(rig.of('pad').length, 3);
});

test('screen delayMs: first share clamps 2000..20000 (default 6000), a replacement 0..3000 (default 400), a stop resets', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  const delays = () => rig.of('screen').map(event => event.delayMs);
  await deliver(rig, 'A.[[screen:T|c]]');
  await deliver(rig, 'B.[[stop]]');
  await deliver(rig, 'C.[[screen:T|c|#4]]');
  await deliver(rig, 'D.[[stop]]');
  await deliver(rig, 'E.[[screen:T|c|#0.2]]');
  await deliver(rig, 'F.[[stop]]');
  await deliver(rig, 'G.[[screen:T|c|#60]]');
  assert.deepEqual(delays(), [6000, 4000, 2000, 20000]);
  await deliver(rig, 'H.[[screen:T2|c]]');
  await deliver(rig, 'I.[[screen:T3|c|#1]]');
  await deliver(rig, 'J.[[screen:T4|c|#9]]');
  assert.deepEqual(delays().slice(4), [400, 1000, 3000]);
  await deliver(rig, 'K.[[stop]]');
  await deliver(rig, 'L.[[screen:T5|c]]');
  assert.equal(delays()[7], 6000, 'after a stop the next share is a first share');
});

test('a discarded speculative reply never shows or hides the screen', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Look.[[screen:Hidden|Nope.]][[pad-open:go]]');
  await flush();
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  assert.deepEqual(rig.of('screen'), []);
  assert.deepEqual(rig.of('pad'), []);
  assert.equal(rig.engine.state().screen, null);
});

test('panel: the screen records the interviewer speaking at that point of the reply', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[spk:B]][[screen:Task|Do it.]]');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.of('screen')[0].speakerId, 'B');
  assert.equal(rig.engine.state().screen.speakerId, 'B');
  const lead = panelRig({ createParser: screenParser });
  await panelGreeting(lead, '[[screen:Task|Do it.]]Hello.[[spk:B]]Hi.');
  lead.h.playback('utt1', 'started');
  lead.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(lead.of('screen')[0].speakerId, 'A');
  const absent = panelRig({ createParser: screenParser });
  await panelGreeting(absent, '[[spk:Z]][[screen:Task|Do it.]]Hello.');
  absent.h.playback('utt1', 'started');
  absent.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(absent.of('screen'), [], 'a screen written inside the segment of an id never cast is dropped');
});

test('a cut-off reply keeps only the screen and pad whose position playback had reached', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Look.[[screen:Keep|Stay.]] Then more.[[stop]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.', 'Then', 'more.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'position', 700); // 'Right.' and 'Look.' have been heard
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  assert.deepEqual(rig.engine.state().screen, { title: 'Keep', content: 'Stay.', speakerId: 'A' });
  assert.deepEqual(rig.of('screen-stop'), [], 'the stop tag came after words that were never heard');
});

test('screen title and content are capped', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, `Look.[[screen:${'t'.repeat(300)}|${'c'.repeat(9000)}]]`);
  const shown = rig.engine.state().screen;
  assert.equal(shown.title.length, 120);
  assert.equal(shown.content.length, 6000);
});

test('pad text rides with the next turn only when it changed since the main session last received it', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  rig.engine.setPadText('x = PADCODE_ONE');
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  assert(!rig.sessions.opener.calls[0].message.includes('PADCODE_ONE'), 'the opener never carries the pad');
  rig.sessions.opener.answer('Right.');
  await flush();
  const first = rig.sessions.main.calls[1].message;
  assert(first.includes('PADCODE_ONE'), 'changed pad text is attached');
  rig.sessions.main.answer('Okay.');
  rig.streams[1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  await speak(rig, 'and then', 'b');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Mm.');
  await flush();
  assert(!rig.sessions.main.calls[2].message.includes('PADCODE_ONE'), 'unchanged pad text is not repeated');
  rig.sessions.main.answer('Fine.');
  rig.streams[2].audio(1000);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt3', 'started');
  rig.h.playback('utt3', 'finished', 1500);
  await flush();
  rig.engine.setPadText('x = PADCODE_TWO');
  rig.engine.typed('done');
  await flush();
  rig.sessions.opener.answer('Okay.');
  await flush();
  assert(rig.sessions.main.calls[3].message.includes('PADCODE_TWO'), 'a typed turn carries the changed pad');
});

test('a discarded turn does not mark the pad as received', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  rig.engine.setPadText('PADCODE_KEEP');
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  rig.h.vad(false);
  await rig.clock.advance(2500);
  const last = rig.sessions.main.calls[rig.sessions.main.calls.length - 1].message;
  assert(last.includes('PADCODE_KEEP'), 'the retried turn still carries the pad');
});

// The pad idle message: the interviewer watches the pad, so one look is sent after the candidate stops typing in it.
const PAD_IDLE = DEFAULT_CALL_THRESHOLDS.padIdleMs;
function padRig(extra = {}) {
  const options = [];
  const rig = makeRig({ createParser: screenParser, formatTurn: option => { options.push(option); return `[turn pad=${option.padText ?? '-'} idle=${option.padProgress?.idleMs ?? '-'} silence=${option.silenceCheck ?? '-'}]`; }, ...extra });
  rig.options = options;
  return rig;
}
const idleTurns = rig => rig.options.filter(option => option.padProgress !== undefined);

test('pad idle: a pad edit followed by quiet sends one message with the text and the idle time, with no opener', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_IDLE');
  await rig.clock.advance(PAD_IDLE - 1);
  assert.equal(rig.sessions.main.calls.length, 1, 'nothing before the idle time');
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.equal(rig.sessions.opener.calls.length, 0, 'nothing is acknowledged first');
  assert.equal(rig.sessions.classifier.calls.length, 0);
  const turns = idleTurns(rig);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].padText, 'PADCODE_IDLE');
  assert.equal(turns[0].padProgress.idleMs, PAD_IDLE);
  assert.equal(turns[0].padProgress.typing, false);
  assert.equal(turns[0].silenceCheck, undefined, 'it is not a silence check');
  assert.equal(turns[0].silenceMs ?? null, null);
  rig.sessions.main.answer('Take your time.');
  rig.streams[1].audio(500);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'it commits without waiting');
});

test('pad idle: each edit restarts the idle time, and an unchanged text is not an edit', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 100000 } });
  await greet(rig);
  rig.engine.setPadText('a');
  await rig.clock.advance(PAD_IDLE - 1000);
  rig.engine.setPadText('ab');
  await rig.clock.advance(PAD_IDLE - 1000);
  rig.engine.setPadText('ab'); // same text: the timer is not restarted
  await rig.clock.advance(1000);
  assert.equal(idleTurns(rig).length, 1);
  assert.equal(idleTurns(rig)[0].padText, 'ab');
  assert.equal(idleTurns(rig)[0].padProgress.idleMs, PAD_IDLE);
});

test('pad idle: the pad text going out with a spoken turn before the idle time means no idle message follows', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_SPOKEN');
  await rig.clock.advance(5000);
  await speak(rig, 'here is my approach', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Good.');
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  const spoken = rig.options.filter(option => option.padText === 'PADCODE_SPOKEN');
  assert(spoken.length >= 1, 'the spoken turn carries the pad text');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0, 'no idle message');
});

test('pad idle: a typed chat turn before the idle time carries the pad and no idle message follows', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_CHAT');
  await rig.clock.advance(3000);
  rig.engine.typed('done');
  await flush();
  rig.sessions.opener.answer('Ok.');
  await flush();
  assert.equal(rig.options.filter(option => option.padText === 'PADCODE_CHAT').length, 1);
  rig.sessions.main.answer('Fine.');
  rig.streams[1].audio(500);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await flush();
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0);
});

test('pad idle: after a listen reply there is no second idle message, silence checks proceed, and a new edit allows a new one', async () => {
  const rig = padRig({ createParser: patienceParser });
  await greet(rig);
  rig.engine.setPadText('PADCODE_ONE');
  await rig.clock.advance(PAD_IDLE);
  assert.equal(idleTurns(rig).length, 1);
  rig.sessions.main.answer('<listen/>', { chunks: ['<listen/>'] });
  await flush();
  await rig.clock.advance(PAD_IDLE * 3);
  assert.equal(idleTurns(rig).length, 1, 'no second idle message without new edits');
  const checks = rig.options.filter(option => option.silenceCheck !== undefined);
  assert.equal(checks.length, 1, 'the silence wait started from zero after the idle message');
  assert.equal(checks[0].silenceCheck, 1, 'the idle message did not count toward the three');
  rig.sessions.main.answer('<listen/>', { chunks: ['<listen/>'] });
  await flush();
  rig.engine.setPadText('PADCODE_TWO');
  await rig.clock.advance(PAD_IDLE);
  assert.equal(idleTurns(rig).length, 2, 'a new burst allows a new idle message');
});

test('pad idle: the silence wait starts from zero after the idle message, with the reply wait', async () => {
  const rig = padRig({ createParser: patienceParser });
  await greet(rig);
  rig.engine.setPadText('PADCODE_WAIT');
  await rig.clock.advance(PAD_IDLE);
  rig.sessions.main.answer('<listen/><wait s="60"/>', { chunks: ['<listen/><wait s="60"/>'] });
  await flush();
  await rig.clock.advance(59000);
  assert.equal(rig.options.filter(option => option.silenceCheck !== undefined).length, 0);
  await rig.clock.advance(1000);
  assert.equal(rig.options.filter(option => option.silenceCheck !== undefined).length, 1);
});

test('pad idle: while the interviewer is speaking it waits, then goes out when the reply is over', async () => {
  const rig = padRig();
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Let me explain a long thing.');
  rig.streams[1].audio(24000 * 2 * 40); // 40 s of audio, so the playback watchdog stays quiet
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.engine.setPadText('PADCODE_SPEAKING');
  await rig.clock.advance(PAD_IDLE + 3000);
  assert.equal(idleTurns(rig).length, 0, 'not sent while the interviewer is speaking');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.equal(idleTurns(rig).length, 1, 'sent once the reply is over, the idle time having passed');
  assert.equal(idleTurns(rig)[0].padText, 'PADCODE_SPEAKING');
  assert(idleTurns(rig)[0].padProgress.idleMs >= PAD_IDLE + 3000);
});

test('pad idle: typing in the pad holds it until the typing signal lapses', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_TYPING');
  rig.engine.typing(true);
  await rig.clock.advance(PAD_IDLE - 1000);
  rig.engine.typing(true); // refreshed: still typing
  await rig.clock.advance(2000);
  assert.equal(idleTurns(rig).length, 0, 'held while typing is signalled');
  rig.engine.typing(false);
  assert.equal(idleTurns(rig).length, 1, 'sent as soon as typing stops, the idle time having passed');
});

test('pad idle: a pause during the idle wait stops it, and resuming restarts the wait from zero', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_PAUSE');
  await rig.clock.advance(5000);
  rig.engine.setPaused(true);
  await rig.clock.advance(PAD_IDLE * 3);
  assert.equal(idleTurns(rig).length, 0);
  assert.equal(rig.clock.pending(), 0, 'no timer is left armed during the pause');
  rig.engine.setPadText('PADCODE_PAUSE_MORE'); // an edit during a pause opens no new wait
  await rig.clock.advance(PAD_IDLE * 3);
  assert.equal(idleTurns(rig).length, 0);
  rig.engine.setPaused(false);
  await rig.clock.advance(PAD_IDLE - 1);
  assert.equal(idleTurns(rig).length, 0);
  await rig.clock.advance(1);
  assert.equal(idleTurns(rig).length, 1);
  assert.equal(idleTurns(rig)[0].padText, 'PADCODE_PAUSE_MORE');
});

test('pad idle: an edit made only during a pause opens no burst', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPaused(true);
  rig.engine.setPadText('PADCODE_ONLY_PAUSED');
  rig.engine.setPaused(false);
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0);
});

test('pad idle: hanging up during the idle wait sends nothing and leaves no timer', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_HANGUP');
  await rig.clock.advance(5000);
  rig.engine.hangUp();
  assert.equal(rig.clock.pending(), 0);
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0);
  assert.equal(rig.sessions.main.calls.length, 1);
  rig.engine.setPadText('late edit');
  assert.equal(rig.clock.pending(), 0, 'a pad edit after the call ended arms nothing');
});

test('pad idle: an unchanged-since-received or emptied pad sends nothing', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('x');
  rig.engine.setPadText('');
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0, 'an empty pad has nothing to show');
});

// Pad progress: periodic looks while the pad keeps changing.
// Still typing as a line ends, and work left unfinished when an interviewer spoke over the typing (call of 2026-11-22:
// the interviewer asked about half-typed code at once, the typing stopped and nobody went back to it).
async function openPad(rig) {
  await deliver(rig, 'Write it in the pad.[[pad-open:python]]');
  await rig.clock.advance(PAD_IDLE * 3); // anything the greeting left behind has run
}
const spokenTurns = rig => rig.options.filter(option => option.padProgress === undefined && typeof option.candidateText === 'string' && option.candidateText);

test('pad typing: a line said while the pad is still changing is marked, and gets no quick reaction first', async () => {
  const rig = padRig();
  await greet(rig);
  await openPad(rig);
  const openers = rig.sessions.opener.calls.length;
  rig.engine.setPadText('def total(items):');
  await speak(rig, 'and now I add the loop', 'typing');
  await rig.clock.advance(600);
  const turn = spokenTurns(rig).at(-1);
  assert.equal(turn.padTyping, true, JSON.stringify(turn));
  assert.equal(turn.padHalted, undefined);
  await rig.clock.advance(1200);
  assert.equal(rig.sessions.opener.calls.length, openers, 'no opener while the candidate is typing');
});

test('pad typing: a pad left alone for longer than padTypingMs is not typing, and the opener runs as usual', async () => {
  const rig = padRig();
  await greet(rig);
  await openPad(rig);
  rig.engine.setPadText('def total(items):');
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.padTypingMs);
  const openers = rig.sessions.opener.calls.length;
  await speak(rig, 'I think that is it', 'done');
  await rig.clock.advance(600);
  const turn = spokenTurns(rig).at(-1);
  assert.equal(turn.padTyping, undefined);
  assert.equal(turn.padHalted, undefined);
  await rig.clock.advance(1200);
  assert.equal(rig.sessions.opener.calls.length, openers + 1);
});

test('pad halted: an interviewer speaking over the typing leaves a note on the next turns until the pad changes', async () => {
  const rig = padRig();
  await greet(rig);
  await openPad(rig);
  rig.engine.setPadText('-- portable version:\n-- SELECT');
  await speak(rig, 'I will add that as a comment', 'c1');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Why row number and not rank?');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  let id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started'); // the pad changed under 2.5 s ago: the candidate stops typing to listen
  rig.h.playback(id, 'finished', 1500);
  await flush();
  await rig.clock.advance(PAD_IDLE * 2);
  await speak(rig, 'rank would keep ties, so two rows could come back for one database', 'c2');
  await rig.clock.advance(1800);
  let turn = spokenTurns(rig).at(-1);
  assert.equal(turn.padHalted, true, JSON.stringify(turn));
  assert.equal(turn.padTyping, undefined);
  rig.sessions.opener.answer('Mm-hm.');
  await flush();
  rig.sessions.main.answer('Fair enough.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  rig.engine.setPadText('-- portable version:\n-- SELECT db_name'); // back at it
  await rig.clock.advance(PAD_IDLE * 2);
  await speak(rig, 'so that is the portable one finished as well', 'c3');
  await rig.clock.advance(1800);
  turn = spokenTurns(rig).at(-1);
  assert.equal(turn.padHalted, undefined, 'the candidate went back to the pad');
});

test('pad halted: the note goes with the reply that stopped the typing and the next two only', async () => {
  const rig = padRig();
  await greet(rig);
  await openPad(rig);
  rig.engine.setPadText('SELECT');
  await speak(rig, 'I will write the query now', 'h0');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Quick one first.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback(`utt${rig.streams.length}`, 'started');
  rig.h.playback(`utt${rig.streams.length}`, 'finished', 1500);
  await flush();
  const halted = [];
  for (let i = 1; i <= 4; i += 1) {
    await rig.clock.advance(PAD_IDLE * 2);
    await speak(rig, `this is my answer number ${i} to your question`, `h${i}`);
    await rig.clock.advance(1800);
    halted.push(spokenTurns(rig).at(-1).padHalted === true);
    rig.sessions.opener.answer('Mm-hm.');
    await flush();
    rig.sessions.main.answer('Next question then.');
    rig.streams.at(-1).audio(1000);
    await flush();
    await rig.clock.advance(700);
    rig.h.playback(`utt${rig.streams.length}`, 'started');
    rig.h.playback(`utt${rig.streams.length}`, 'finished', 1500);
    await flush();
  }
  assert.deepEqual(halted, [true, true, true, false]);
});

const PAD_PROGRESS = DEFAULT_CALL_THRESHOLDS.padProgressMs;
const listenReply = async rig => { rig.sessions.main.answer('<listen/>', { chunks: ['<listen/>'] }); await flush(); };

test('pad progress: steady typing for 80 s gives messages at about 25, 50 and 75 s, each marked as still typing', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  const times = [];
  for (let t = 0; t < 80000; t += 2000) {
    rig.engine.setPadText(`PADCODE_STEADY_${t}`);
    await rig.clock.advance(2000);
    if (idleTurns(rig).length > times.length) { times.push(t + 2000); await listenReply(rig); }
  }
  assert.deepEqual(times, [26000, 52000, 78000]);
  assert(idleTurns(rig).every(option => option.padProgress.typing === true));
  assert(idleTurns(rig).every(option => option.candidateText === '' && option.silenceCheck === undefined));
});

test('pad progress: writing in the pad holds the silence checks by itself, with no typing signal', async () => {
  const rig = padRig({});
  await greet(rig);
  // Four minutes of steady edits and only silent replies: no silence check may fire and the call stays up.
  for (let t = 0; t < 240000; t += 3000) {
    rig.engine.setPadText(`PADCODE_HOLD_${t}`);
    await rig.clock.advance(3000);
    if (idleTurns(rig).length && rig.engine.state().phase !== 'ended') await listenReply(rig).catch(() => {});
  }
  assert.equal(rig.options.filter(option => option.silenceCheck !== undefined).length, 0, 'no silence check while the candidate writes');
  assert.notEqual(rig.engine.state().phase, 'ended');
});

test('pad progress: typing for 10 s then stopping gives one message 12 s after the last edit, and none after', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  for (let t = 0; t < 10000; t += 2000) { rig.engine.setPadText(`PADCODE_STOP_${t}`); await rig.clock.advance(2000); }
  await rig.clock.advance(PAD_IDLE - 2000 - 1); // 12 s after the last edit minus 1 ms
  assert.equal(idleTurns(rig).length, 0);
  await rig.clock.advance(1);
  assert.equal(idleTurns(rig).length, 1);
  assert.deepEqual(idleTurns(rig)[0].padProgress, { typing: false, idleMs: PAD_IDLE });
  await listenReply(rig);
  await rig.clock.advance(PAD_PROGRESS * 4);
  assert.equal(idleTurns(rig).length, 1, 'nothing changed since the interviewer last had it');
});

test('pad progress: a listen reply leaves no trace, no check is counted, and the next silence check is number 1', async () => {
  const rig = padRig({ createParser: patienceParser });
  await greet(rig);
  for (let i = 0; i < 4; i += 1) {
    rig.engine.setPadText(`PADCODE_QUIET_${i}`);
    await rig.clock.advance(PAD_IDLE);
    assert.equal(idleTurns(rig).length, i + 1);
    await listenReply(rig);
  }
  assert.equal(rig.opsOf('play').filter(item => item.id !== 'utt1').length, 0, 'nothing was spoken');
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.silencePromptMs);
  const checks = rig.options.filter(option => option.silenceCheck !== undefined);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].silenceCheck, 1);
});

test('pad progress: a spoken turn carrying the pad restarts the 25 s clock', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  for (let t = 0; t < 20000; t += 2000) { rig.engine.setPadText(`PADCODE_CLOCK_0_${t}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 0, 'typing steadily for 20 s: not yet');
  rig.engine.typed('quick question');
  await flush();
  rig.sessions.opener.answer('Sure.');
  await flush();
  rig.sessions.main.answer('Go on.');
  rig.streams[1].audio(500);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await flush();
  const carried = rig.options.filter(option => option.padText === 'PADCODE_CLOCK_0_18000' && option.padProgress === undefined);
  assert.equal(carried.length >= 1, true);
  for (let t = 0; t < 20000; t += 2000) { rig.engine.setPadText(`PADCODE_CLOCK_${t + 1}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 0, 'about 20 s after the turn: not yet');
  for (let t = 0; t < 6000; t += 2000) { rig.engine.setPadText(`PADCODE_CLOCK_B${t}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 1, 'about 25 s after the turn');
});

test('pad progress: held while the interviewer speaks, typing does not cut the comment, and at most one goes out afterwards', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Let me explain a long thing.');
  rig.streams[1].audio(24000 * 2 * 100);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  for (let t = 0; t < 70000; t += 2000) { rig.engine.setPadText(`PADCODE_HELD_${t}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 0, 'nothing while the interviewer is speaking');
  assert.equal(rig.opsOf('cancel').length, 0, 'typing did not cut the interviewer off');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.equal(idleTurns(rig).length, 1, 'one message when the comment is over, not a burst');
  await listenReply(rig);
  assert.equal(idleTurns(rig).length, 1);
});

test('pad progress: held while the candidate speaks and while a reply is being made', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  rig.engine.setPadText('PADCODE_VOICE');
  rig.h.vad(true);
  await rig.clock.advance(PAD_PROGRESS * 2);
  assert.equal(idleTurns(rig).length, 0, 'the candidate is speaking');
  rig.h.vad(false);
  rig.h.vad(true); // leave the voice state as speaking until a transcript completes the turn
  rig.h.vad(false);
  await rig.clock.advance(100);
  rig.h.transcript('here is my idea', 'a');
  await flush();
  await rig.clock.advance(2000);
  assert(rig.sessions.main.calls.length >= 2, 'a turn is being made');
  const before = idleTurns(rig).length;
  rig.engine.setPadText('PADCODE_VOICE_2');
  await rig.clock.advance(PAD_PROGRESS * 2);
  assert.equal(idleTurns(rig).length, before, 'not while a reply is being generated');
});

test('pad progress: a spoken reply to a progress message is delivered like any other', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  rig.engine.setPadText('PADCODE_COMMENT');
  await rig.clock.advance(PAD_IDLE);
  rig.sessions.main.answer('Why a hash map there?');
  rig.streams[1].audio(500);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  rig.engine.setPadText('PADCODE_COMMENT_MORE'); // typing while it speaks
  assert.equal(rig.opsOf('cancel').length, 0);
});

test('pad progress: hanging up clears the timers', async () => {
  const rig = padRig();
  await greet(rig);
  for (let t = 0; t < 10000; t += 2000) { rig.engine.setPadText(`PADCODE_END_${t}`); await rig.clock.advance(2000); }
  rig.engine.hangUp();
  assert.equal(rig.clock.pending(), 0);
  await rig.clock.advance(PAD_PROGRESS * 3);
  assert.equal(idleTurns(rig).length, 0);
});

test('the Ready button is gone from the engine', () => {
  const rig = makeRig();
  assert.equal(rig.engine.submitPad, undefined);
});

test('pad activity: typing in the pad holds back silence check-ins', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  rig.engine.typing(true);
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.silencePromptMs - 1000);
  assert.equal(rig.sessions.main.calls.length, calls);
});

test('setPadText caps the text and the engine ignores pad calls after the call ended', async () => {
  const rig = makeRig({ autoOpener: true, createParser: screenParser });
  await greet(rig);
  rig.engine.setPadText('q'.repeat(30000));
  rig.engine.typed('done');
  await flush();
  const message = rig.sessions.main.calls[1].message;
  assert(!message.includes('q'.repeat(7000)), 'the message cuts the pad');
  rig.engine.hangUp();
  const calls = rig.sessions.main.calls.length;
  rig.engine.typed('late chat');
  rig.engine.setPadText('late');
  await flush();
  assert.equal(rig.sessions.main.calls.length, calls);
});

test('panel: the acknowledgement is spoken in the floor holder\'s voice and the main message carries its exact words', async () => {
  const rig = panelRig({ thresholds: { voiceGateMs: 600 } });
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 2400);
  await flush();
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  assert.equal(rig.opens[1].speakerId, 'B', 'John spoke last, so he holds the floor');
  assert.equal(rig.sessions.main.calls.length, 1, 'main waits for the acknowledgement');
  rig.sessions.opener.answer('Mm-hm, okay, I follow.');
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Mm-hm, okay, I follow.'], 'sent to the stream opened for the floor holder');
  // The note names the voice: untagged text carries on in it, and only the note can tell the session that a colleague
  // (not the lead) held the floor. Without it a lead's whole farewell came out in the colleague's voice.
  assert(rig.sessions.main.calls[1].message.includes("[You have already started your reply out loud with: 'Mm-hm, okay, I follow.' These words were said in John's voice (id B), and what you write with no speaker tag stays in that voice. Carry on from there.]"), rig.sessions.main.calls[1].message);
  assert(rig.sessions.opener.calls.at(-1).message.includes('[This reaction is spoken by John'), rig.sessions.opener.calls.at(-1).message);
  assert(rig.sessions.opener.calls.at(-1).message.includes("[Last said by the interviewers: Priya: 'Hello, I am Priya.' John: 'And I am John.']"), 'a reply two people spoke in is quoted by speaker, never as one person\'s words');
  assert(!rig.sessions.opener.calls.at(-1).message.includes('[You last said:'));
});

test('a warm reaction is dropped right after another, or for the same warm word, but not for a different one said a while back', async () => {
  const rig = makeRig();
  await greet(rig);
  await answerTurn(rig, 'Go on.', 'Ah, lovely to meet you.');
  await answerTurn(rig, 'Go on.', 'Mm-hm.');
  await answerTurn(rig, 'Go on.', 'Okay, sure.');
  await answerTurn(rig, 'Go on.', 'Right, thanks for that.'); // heard 2026-11-23: dropped for the "lovely" three reactions back, 3.9 s of silence
  await answerTurn(rig, 'Go on.', 'Yeah, thank you.'); // right after a thanks
  await answerTurn(rig, 'Go on.', 'No worries.');
  await answerTurn(rig, 'Go on.', 'Oh, thanks.'); // the same warm word again within the last few
  assert.deepEqual(rig.of('opener').map(event => event.outcome), ['spoken', 'spoken', 'spoken', 'spoken', 'dropped', 'spoken', 'dropped']);
});

test('a candidate who resumes while the acknowledgement is pending discards the turn: no main call, no report, a late answer changes nothing', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  const opener = rig.sessions.opener.calls[0];
  rig.h.vad(true);
  await flush();
  assert(opener.signal.aborted);
  assert.equal(rig.sessions.main.calls.length, 1, 'main never started');
  opener.resolve({ text: 'Right, yeah, okay.', control: undefined, sentences: [] }); // a late answer from the aborted session
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.deepEqual(rig.of('opener'), [], 'an abandoned turn reports nothing');
  assert.deepEqual(rig.streams[1].texts, []);
  await rig.clock.advance(1600); // the abandoned turn's deadline must not fire either
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.deepEqual(rig.of('opener'), []);
});

test('an opener that fails twice is reported as error and the main reply starts without a marker', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.fail();
  await flush();
  rig.sessions.opener.fail();
  await flush();
  assert.deepEqual(rig.of('opener').map(item => [item.outcome, item.spoken, item.text]), [['error', false, '']]);
  assert.equal(rig.sessions.main.calls[1].message, "[elapsed 00:00] Candidate: 'I built a scheduler'");
});

test('the acknowledgement is reported once per turn, with its words, count and time from the start of the turn', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig);
  await rig.clock.advance(420);
  rig.sessions.opener.answer('Okay, yeah, I follow you.');
  await flush();
  rig.sessions.main.answer('Tell me more about it.');
  await flush();
  assert.deepEqual(rig.of('opener'), [{ type: 'opener', text: 'Okay, yeah, I follow you.', spoken: true, words: 5, ms: 420, outcome: 'spoken' }]);
});

// The owner's call, 2026-11-19: the acknowledgement chooses its own length (at most 12 words); nothing tells it how long.
test('the acknowledgement is never told a length, and a bare "Mm-hm." is spoken as written', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is a long answer about the hub I built and how I tested it');
  await flush();
  assert(!/Say about|words this time/.test(rig.sessions.opener.calls.at(-1).message), rig.sessions.opener.calls.at(-1).message);
  rig.sessions.opener.answer('Mm-hm.');
  await flush();
  await flush();
  assert.deepEqual(rig.streams.at(-1).texts, ['Mm-hm.']);
  assert.deepEqual(rig.of('opener').map(item => [item.outcome, item.words]), [['spoken', 1]]);
});

test('a spoken acknowledgement is flushed to the voice the moment it is known, before the main reply starts', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Mm-hm, okay, got it.');
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Mm-hm, okay, got it.']);
  assert.deepEqual(rig.streams[1].flushes, [1], 'asked to speak now, ahead of the reply');
  assert.equal(rig.sessions.main.calls.length, 2);
});

export default suite;

/** A fake ear: every dependency is optional, every call is recorded, and the answers are per-test. */
function makeEar({ endOfTurn = () => 0.8, floorBid = () => ({ decision: 'continue', reason: 'test' }), voiceNote = () => null } = {}) {
  const calls = { endOfTurn: [], floorBid: [], voiceNote: [] };
  return {
    calls,
    endOfTurn: async atMs => { calls.endOfTurn.push(atMs); return endOfTurn(atMs); },
    floorBid: async args => { calls.floorBid.push(args); return floorBid(args); },
    voiceNote: async args => { calls.voiceNote.push(args); return voiceNote(args); },
  };
}

test('smart turn hold pushes speculation and commit out from the vad end and flags the opener only', async () => {
  const ear = makeEar({ endOfTurn: () => 0.2 });
  const rig = makeRig({ ear });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  await flush(); // the ear answers in a microtask, well inside smartTurnTimeoutMs
  await rig.clock.advance(300); // 300 ms after the vad end
  await flush();
  assert.deepEqual(rig.of('turn-model').map(event => [event.probability, event.held]), [[0.2, true]]);
  await rig.clock.advance(300); // 600 ms after the vad end: the normal speculation point
  assert.equal(rig.sessions.opener.calls.length, 0, 'held speculation moved to holdSpeculateMs');
  await rig.clock.advance(900); // 1500 ms
  assert.equal(rig.sessions.opener.calls.length, 1);
  const opener = rig.sessions.opener.calls[0].message;
  assert(opener.includes('[audio: sounds unfinished]'), opener);
  assert(opener.indexOf('[audio: sounds unfinished]') < opener.indexOf('Candidate:'), 'the hint follows the elapsed tag');
  assert(!rig.sessions.main.calls[0].message.includes('[audio: sounds unfinished]'), 'the main message gets no audio hint');
  rig.sessions.opener.answer('Okay.');
  await flush();
  await flush(); // the opener sentence reaches the voice before the main's first delta
  rig.sessions.main.answer('Tell me more.');
  rig.streams[1].audio(1000); // the held reply only has audio once its text reaches the voice
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'nothing plays at the held speculation');
  await rig.clock.advance(1000); // 2500 ms
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'commit at holdCommitMs');
});

test('smart turn high probability, timeout, null or error keep the normal timers', async () => {
  const answers = [() => 0.8, () => new Promise(() => {}), () => null, () => { throw new Error('ear down'); }];
  for (const endOfTurn of answers) {
    const rig = makeRig({ ear: makeEar({ endOfTurn }) });
    await greet(rig);
    await speak(rig, 'I built a scheduler');
    await rig.clock.advance(600);
    assert.equal(rig.sessions.opener.calls.length, 1, 'speculation stays at speculateMs');
    assert(!rig.sessions.opener.calls[0].message.includes('[audio: sounds unfinished]'));
    const held = rig.of('turn-model').map(event => event.held);
    assert.deepEqual(held, [false]);
  }
});

test('smart turn answering after speculation already ran leaves the fast path alone', async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const rig = makeRig({ ear: makeEar({ endOfTurn: () => late }) });
  await greet(rig);
  await speak(rig, 'I wrote the migration');
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 1, 'speculation ran on the normal timer');
  release(0.1);
  await flush();
  assert.deepEqual(rig.of('turn-model').map(event => event.held), [false]);
  assert(!rig.sessions.opener.calls[0].message.includes('[audio: sounds unfinished]'));
});

test('smart turn answering after the candidate resumed is ignored', async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const rig = makeRig({ ear: makeEar({ endOfTurn: () => late }) });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  rig.h.vad(true); // the candidate resumed before the ear answered
  await flush();
  release(0.1);
  await flush();
  assert.deepEqual(rig.of('turn-model').map(event => event.held), [false]);
  assert(!rig.engine.state().transcript.some(entry => String(entry.text ?? '').includes('[audio:')));
});

/** Speculate after `prob` from the ear, answer the look, and report the ms after the vad end at which the reply first plays. */
async function commitPointFor(prob) {
  const rig = makeRig({ ear: makeEar({ endOfTurn: () => prob }) });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  await flush();
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Okay.');
  await flush();
  await flush();
  rig.sessions.main.answer('Tell me more.');
  rig.streams[1].audio(1000);
  await flush();
  for (let at = 600; at <= 3000; at += 100) {
    if (rig.opsOf('play').some(item => item.id === 'utt2')) return { rig, at };
    await rig.clock.advance(100);
  }
  return { rig, at: null };
}

test('an unsure smart turn finish keeps the normal look but commits at unsureCommitMs; a sure one at commitMs', async () => {
  const unsure = await commitPointFor(0.7);
  assert.deepEqual(unsure.rig.of('turn-model').map(event => [event.probability, event.held, event.unsure === true]), [[0.7, false, true]]);
  assert.equal(unsure.rig.sessions.opener.calls.length, 1, 'looked at on the normal schedule');
  assert(!unsure.rig.sessions.opener.calls[0].message.includes('[audio: sounds unfinished]'), 'an unsure finish is not a hold');
  assert(unsure.at >= 1800 && unsure.at <= 1900, `unsure commit at ${unsure.at} ms`);
  const sure = await commitPointFor(0.9);
  assert.deepEqual(sure.rig.of('turn-model').map(event => [event.probability, event.held, event.unsure === true]), [[0.9, false, false]]);
  assert(sure.at >= 1200 && sure.at <= 1300, `sure commit at ${sure.at} ms`);
});

test('a candidate who resumes inside the unsure wait drops the look as ever', async () => {
  const rig = makeRig({ ear: makeEar({ endOfTurn: () => 0.7 }) });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  await flush();
  await rig.clock.advance(1400); // past the normal commit point, short of the unsure one
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  rig.h.vad(true);
  await flush();
  assert(rig.of('discarded').some(event => event.reason === 'resumed'));
});

test('after an unfinished verdict the answer is looked at once more when the candidate stays quiet 3 s', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig); // 600 ms after the vad end
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(2300); // 2900 ms
  assert.equal(rig.sessions.opener.calls.length, 1);
  await rig.clock.advance(100); // 3000 ms
  assert.deepEqual(rig.of('quiet-relook').map(event => [event.quietMs, event.words]), [[3000, 4]]);
  assert.equal(rig.sessions.opener.calls.length, 2);
  const note = '[The candidate has been quiet for 3s since these words. You already waited once.]';
  const opener = rig.sessions.opener.calls[1].message;
  assert(opener.includes(note), opener);
  assert(opener.endsWith("Candidate: 'I built a scheduler'"), opener);
  rig.sessions.opener.answer('Okay.');
  await flush();
  await flush();
  assert(rig.sessions.main.calls.at(-1).message.includes(note), 'the main reply knows it waited too');
  rig.sessions.main.answer('Tell me more.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(0);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === `utt${rig.streams.length}`).length, 1, 'the quiet look commits as soon as it has audio');
});

test('the quiet look never comes when the candidate goes on, and comes again only for a new quiet stretch', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(1000);
  rig.h.vad(true); // the candidate goes on before the quiet look, and keeps talking past when it was due
  rig.h.transcript('and then I tested it', 'b', rig.clock.now(), false, rig.clock.now() + 2500);
  await rig.clock.advance(2500); // 4100 ms after the first vad end: the first stretch's look would have been due at 3000
  assert.equal(rig.of('quiet-relook').length, 0, "the first stretch's look was cancelled by the speech");
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.equal(rig.of('quiet-relook').length, 0);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(!rig.sessions.opener.calls[1].message.includes('quiet for'), 'an ordinary turn end, no quiet note');
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(2400); // 3 s after the new vad end
  assert.equal(rig.of('quiet-relook').length, 1, 'the new quiet stretch gets its own look');
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(5000);
  assert.equal(rig.of('quiet-relook').length, 1, 'once per quiet stretch');
  assert.equal(rig.sessions.opener.calls.length, 3);
  // After a quiet look that was used, speech starts a new stretch, and its own quiet look comes.
  await speak(rig, 'and then I wrote the runbook', 'c');
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 4);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(2400);
  assert.equal(rig.of('quiet-relook').length, 2, 'a used quiet look is reset by new speech');
});

test('when the quiet look listens too, the first silence check comes 10 s after the vad end', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(2400); // 3000 ms: the quiet look
  assert.equal(rig.sessions.opener.calls.length, 2);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  const before = rig.sessions.main.calls.length;
  await rig.clock.advance(6900); // 9900 ms
  assert.equal(rig.sessions.main.calls.length, before);
  await rig.clock.advance(100); // 10000 ms
  assert.equal(rig.sessions.main.calls.length, before + 1);
  assert.match(rig.sessions.main.calls.at(-1).message, /\[candidate silent 10s, check 1 of 3\]$/);
});

test('a single unfinished verdict keeps the normal silence check; a wait the interviewer set beats the early one', async () => {
  // With the quiet look switched off, one unfinished verdict waits for the normal 20 s check, as before.
  const single = makeRig({ thresholds: { quietRelookMs: 0 } });
  await greet(single);
  await speculate(single);
  single.sessions.opener.answer('<listen/>');
  await flush();
  const calls = single.sessions.main.calls.length;
  await single.clock.advance(15000);
  assert.equal(single.sessions.opener.calls.length, 1, 'no quiet look');
  assert.equal(single.sessions.main.calls.length, calls, 'no early check-in');
  await single.clock.advance(5000);
  assert.equal(single.sessions.main.calls.length, calls + 1, 'the normal silence check');

  const rig = makeRig({ createParser: patienceParser });
  await greet(rig);
  await deliver(rig, 'Take your time.<wait s="30"/>');
  await speak(rig, 'so the first step is', 'w');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(2400);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  const before = rig.sessions.main.calls.length;
  await rig.clock.advance(15000);
  assert.equal(rig.sessions.main.calls.length, before, 'no check-in at 10 s: the interviewer said it would wait 30 s');
});

test('smart turn bands at their edges: 0.49 holds, 0.5 and 0.84 are unsure, 0.85 is sure', async () => {
  const expected = { 0.49: [true, false], 0.5: [false, true], 0.84: [false, true], 0.85: [false, false] };
  for (const [prob, [held, unsure]] of Object.entries(expected)) {
    const rig = makeRig({ ear: makeEar({ endOfTurn: () => Number(prob) }) });
    await greet(rig);
    await speak(rig, 'I built a scheduler');
    await flush();
    await rig.clock.advance(300);
    assert.deepEqual(rig.of('turn-model').map(event => [event.held, event.unsure === true]), [[held, unsure]], `p = ${prob}`);
  }
  const edge = await commitPointFor(0.5);
  assert(edge.at >= 1800 && edge.at <= 1900, `p = 0.5 commits at ${edge.at} ms`);
});

test('a late unfinished verdict gets its quiet look at least quietRelookMinGapMs after it', async () => {
  const rig = makeRig({ thresholds: { quietRelookMs: 1500 } }); // due 1.5 s after the vad end, but the verdict comes at 1 s
  await greet(rig);
  await speculate(rig); // 600 ms after the vad end
  await rig.clock.advance(400);
  rig.sessions.opener.answer('<listen/>'); // 1000 ms
  await flush();
  await rig.clock.advance(600); // 1600 ms: past quietRelookMs, inside the gap
  assert.equal(rig.of('quiet-relook').length, 0);
  await rig.clock.advance(400); // 2000 ms: a second after the verdict
  assert.equal(rig.of('quiet-relook').length, 1);
  assert.equal(rig.of('quiet-relook')[0].quietMs, 2000);
});

test('a typed message after an unfinished verdict cancels the quiet look', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(1000);
  rig.engine.typed('Here is my answer');
  await flush();
  await rig.clock.advance(5000);
  assert.equal(rig.of('quiet-relook').length, 0);
  assert(!rig.sessions.opener.calls.some(call => call.message.includes('quiet for')), 'no stale quiet note on any look');
});

test('typing across the quiet-look point holds it off; it comes once the typing lapses', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(1400); // 2000 ms
  rig.engine.typing(true);
  await rig.clock.advance(2000); // 4000 ms: due, but the candidate is typing
  assert.equal(rig.of('quiet-relook').length, 0);
  await rig.clock.advance(4000); // 8000 ms: typing lapsed (6 s), the look is armed a gap later
  assert.equal(rig.of('quiet-relook').length, 0);
  await rig.clock.advance(1000); // 9000 ms
  assert.equal(rig.of('quiet-relook').length, 1, 'the held-off look is not lost');
});

test('a pause clears the early check-in: resuming waits the normal silence again', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(2400); // the quiet look
  rig.sessions.opener.answer('<listen/>');
  await flush();
  const before = rig.sessions.main.calls.length;
  rig.engine.setPaused(true);
  await rig.clock.advance(30000);
  rig.engine.setPaused(false);
  await flush();
  await rig.clock.advance(1000);
  assert.equal(rig.sessions.main.calls.length, before, 'no check-in the moment the call resumes');
  await rig.clock.advance(19100);
  assert.equal(rig.sessions.main.calls.length, before + 1, 'the normal 20 s check after the resume');
});

test('a quiet look that replies arms no early check-in', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await rig.clock.advance(2400);
  rig.sessions.opener.answer('Okay.');
  await flush();
  await flush();
  rig.sessions.main.answer('Tell me more about it.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(0);
  await flush();
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  const before = rig.sessions.main.calls.length;
  await rig.clock.advance(15000);
  assert.equal(rig.sessions.main.calls.length, before, 'no 10 s check-in after a reply');
  await rig.clock.advance(5100);
  assert.equal(rig.sessions.main.calls.length, before + 1, 'the normal 20 s check');
});

test('a voice note from the ear decorates the main message only', async () => {
  const ear = makeEar({ voiceNote: () => 'sounded tired and hesitant' });
  const rig = makeRig({ ear });
  await greet(rig);
  await speculate(rig, 'I built a scheduler');
  rig.sessions.opener.answer('Right.');
  await flush();
  assert.equal(ear.calls.voiceNote.length, 1);
  const { startMs, endMs } = ear.calls.voiceNote[0];
  assert(endMs >= startMs);
  const main = rig.sessions.main.calls.at(-1).message;
  assert(main.includes('[voice: sounded tired and hesitant]'), main);
  assert(!rig.sessions.opener.calls[0].message.includes('[voice:'));
  assert(main.indexOf('[voice:') > main.indexOf('[elapsed '), 'the note follows the elapsed tag');
});

test('a voice note that is too slow is dropped and the main still runs', async () => {
  const rig = makeRig({ ear: makeEar({ voiceNote: () => new Promise(() => {}) }) });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  await rig.clock.advance(600);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1, 'the main reply waits for the acknowledgement');
  await rig.clock.advance(200); // the note's 150 ms are over
  rig.sessions.opener.answer('Right.');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'the slow note does not hold it back');
  assert(!rig.sessions.main.calls[1].message.includes('[voice:'));
});

test('the main reply waits for the acknowledgement and the voice note at once, not one after the other', async () => {
  let note;
  const ear = makeEar({ voiceNote: () => new Promise(resolve => { note = resolve; }) });
  const rig = makeRig({ ear, thresholds: { voiceNoteTimeoutMs: 400 } });
  await greet(rig);
  await speculate(rig, 'I built a scheduler');
  rig.sessions.opener.answer('Right, yeah.');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1, 'the note is still awaited');
  await rig.clock.advance(399);
  assert.equal(rig.sessions.main.calls.length, 1);
  note('sounded tired');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  const main = rig.sessions.main.calls[1].message;
  assert(main.includes('[voice: sounded tired]') && main.includes(MARK('Right, yeah.')), main);

  const both = makeRig({ ear: makeEar({ voiceNote: () => new Promise(resolve => setTimeout(() => resolve('x'), 0)) }) });
  await greet(both);
  await speculate(both, 'I built a scheduler');
  await both.clock.advance(150); // the note timed out while the opener was the one still working
  assert.equal(both.sessions.main.calls.length, 1);
  both.sessions.opener.answer('Okay.');
  await flush();
  assert.equal(both.sessions.main.calls.length, 2, 'the note had already settled: only the acknowledgement was awaited');
});

/** The candidate talks over the reply and the floor bid answers at floorBidAfterMs while still speaking. */
async function floorBidOverlap(rig, text = 'ok', segmentId = 'o1') {
  rig.h.vad(true);
  rig.h.transcript(text, segmentId, rig.clock.now());
  await rig.clock.advance(250);
  await flush();
  await rig.clock.advance(100); // the boundary pause lands while the overlap is still open
  await flush();
}

test('pause-then-decide: an acknowledgement pauses at the word boundary and resumes after resumeDelayMs', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'pause', reason: 'short sound' }) });
  const rig = makeRig({ ear });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'right');
  assert.equal(ear.calls.floorBid.length, 1);
  assert.equal(ear.calls.floorBid[0].wordCount, 1);
  assert(ear.calls.floorBid[0].overlapMs >= 250);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(200); // the word in progress ends 180 ms after the bid
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  assert.equal(rig.engine.state().phase, 'playing', 'the phase stays playing while paused');
  rig.h.vad(false);
  await flush();
  assert.equal(rig.sessions.classifier.calls.length, 1);
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.acknowledgement).length, 1);
  await rig.clock.advance(250); // resumeDelayMs
  assert.equal(rig.opsOf('resume').filter(item => item.id === 'utt2').length, 1);
});

test('pause-then-decide: an interruption classifier answer while paused cancels', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').length, 1);
  rig.h.vad(false);
  await flush();
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: a clear interruption while paused cancels from the paused position', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').length, 1);
  rig.h.transcript('wait what is this', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: an acknowledgement after a long pause cancels and tells main where it stopped', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }), thresholds: { maxResumePauseMs: 100, resumeDelayMs: 50 } });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(260); // the boundary pause landed in the advance above: past maxResumePauseMs, still inside interruptMs
  rig.h.vad(false);
  await flush();
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  rig.h.playback('utt2', 'cancelled', 300);
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  const message = rig.sessions.main.calls.at(-1).message;
  assert(message.includes("[You paused because the candidate made a short sound; it was only an acknowledgement. Continue naturally from where you stopped after: 'ok']"), message);
  assert(!message.includes('Candidate:'), message);
  assert(!message.includes('[audio: sounds unfinished]'));
});

test('pause-then-decide: no decision after maxPausedMs counts as an interruption', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }), thresholds: { maxPausedMs: 100 } });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').length, 1);
  await rig.clock.advance(150); // past maxPausedMs
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: continue keeps playing until the existing duration rule stops the reply', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'continue' }) });
  const rig = makeRig({ ear });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'ok');
  assert.equal(ear.calls.floorBid.length, 1);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'nothing stops at the floor bid');
  assert.equal(rig.opsOf('pause').length, 0);
  await rig.clock.advance(500); // past interruptMs with a word counted
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: continue keeps a short acknowledgement playing and stores it', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'continue' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('right', 'o1', rig.clock.now());
  await rig.clock.advance(250);
  await flush();
  rig.h.vad(false);
  await flush();
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.opsOf('pause').length, 0);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.acknowledgement).length, 1);
});

test('pause-then-decide: a floor bid answering after the overlap ended still applies', async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const rig = makeRig({ ear: makeEar({ floorBid: () => late }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('right', 'o1', rig.clock.now());
  await rig.clock.advance(250);
  rig.h.vad(false); // the overlap ends before the ear answers
  await flush();
  release({ decision: 'continue' });
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.sessions.classifier.calls.length, 1, 'the ended overlap is classified by the late decision');
});

test('pause-then-decide: a classifier answer after maxPausedMs cannot resume the cancelled reply', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }), thresholds: { maxPausedMs: 100 } });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  rig.h.vad(false);
  await flush();
  await rig.clock.advance(150); // maxPausedMs fires first
  rig.h.playback('utt2', 'cancelled', 500);
  await flush();
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  await rig.clock.advance(300);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.opsOf('resume').length, 0);
});

test('bracketed audio tags reach the voice but never captions, transcript or heard text', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('[sighs] Right, got it.');
  await flush();
  await flush();
  rig.sessions.main.answer('[laughs] Tell me about the design. What was hard?');
  rig.streams[1].words(REPLY_WORDS);
  rig.streams[1].audio(1000);
  await rig.clock.advance(1200);
  await flush();
  const spoken = rig.streams[1].texts.join(' ');
  assert(spoken.includes('[sighs]') || spoken.includes('[laughs]'), spoken);
  const interviewerCaptions = rig.of('caption').filter(event => event.speaker === 'interviewer').map(event => event.text);
  assert.equal(interviewerCaptions.filter(text => /\[[a-z][a-z -]{0,30}\]/.test(text)).length, 0);
  const stored = rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').map(entry => entry.text);
  assert.equal(stored.filter(text => /\[[a-z][a-z -]{0,30}\]/.test(text)).length, 0);
});

test('every spoken entry carries integer helper-timeline start and end: candidate by words, interviewer by playback', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  const t0 = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('I built a scheduler', 'a', t0, false, t0 + 900);
  await rig.clock.advance(900);
  rig.h.vad(false);
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  await flush();
  rig.sessions.main.answer('Tell me about the design. What was hard?');
  rig.streams[1].audio(1000);
  await rig.clock.advance(600);
  rig.h.playback('utt2', 'started');
  const startedAt = rig.clock.now();
  await rig.clock.advance(1500);
  rig.h.playback('utt2', 'finished', 3300);
  await flush();
  const entries = rig.engine.state().transcript;
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert(Number.isInteger(entry.startMs) && Number.isInteger(entry.endMs) && entry.endMs >= entry.startMs, JSON.stringify(entry));
  }
  assert.deepEqual([entries[1].startMs, entries[1].endMs], [t0 - HELPER_OFFSET, t0 + 900 - HELPER_OFFSET], 'first word start to last word end');
  assert.deepEqual([entries[2].startMs, entries[2].endMs], [startedAt - HELPER_OFFSET, startedAt + 1500 - HELPER_OFFSET], 'playback start to playback end');
});

test('an interrupted interviewer entry ends at the cut point and an acknowledgement entry spans the words', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  const startedAt = rig.clock.now();
  await shortOverlap(rig, 'right');
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  const ack = rig.engine.state().transcript.find(entry => entry.acknowledgement);
  assert(Number.isInteger(ack.startMs) && Number.isInteger(ack.endMs) && ack.endMs >= ack.startMs, JSON.stringify(ack));
  assert.equal(ack.startMs, startedAt - HELPER_OFFSET);
  const stoppingRig = makeRig();
  await greet(stoppingRig);
  await toPlaying(stoppingRig);
  stoppingRig.h.playback('utt2', 'position', 650);
  await stoppingRig.clock.advance(650);
  stoppingRig.h.playback('utt2', 'cancelled', 1300);
  await flush();
  const cut = stoppingRig.engine.state().transcript.pop();
  assert.equal(cut.endMs - cut.startMs, 650, 'the entry ends where playback was cut');
});

test('a wordless noise that paused the reply resumes it after maxPausedMs instead of cutting it for good', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  rig.h.vad(true); // no transcript word: a cough or a bump
  await rig.clock.advance(400);
  rig.h.vad(false);
  await rig.clock.advance(200); // the boundary pause lands
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  await rig.clock.advance(2600); // past maxPausedMs
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the reply is not cut');
  assert.equal(rig.opsOf('resume').filter(item => item.id === 'utt2').length, 1);
  rig.h.playback('utt2', 'finished', 3300);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
});

test('a paused reply cut by maxPausedMs for a long noise re-arms the silence prompt', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  rig.h.vad(true);
  await rig.clock.advance(1000); // longer than interruptMs, still no words
  rig.h.vad(false);
  await rig.clock.advance(3500); // past maxPausedMs
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'a long noise is still treated as an interruption');
  rig.h.playback('utt2', 'cancelled', 300);
  await flush();
  const before = rig.sessions.main.calls.length;
  await rig.clock.advance(20000);
  assert(rig.sessions.main.calls.slice(before).some(call => /candidate silent 20s/.test(call.message)), 'the call does not go quiet for good');
});

test('listen from opener or main on a typed turn counts as pass: kept once, nothing spoken', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('3 years at Acme, mostly Go');
  await flush();
  rig.sessions.opener.answer('<listen/>');
  await flush();
  await flush();
  assert.equal(rig.of('discarded').length, 0, 'a typed-line listen from the opener is only "no reaction"');
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert(rig.of('discarded').every(item => item.reason === 'pass'), JSON.stringify(rig.of('discarded')));
  assert.equal(rig.of('discarded').length, 1);
  const entries = rig.engine.state().transcript;
  assert.equal(entries.filter(entry => entry.channel === 'chat' && entry.text === '3 years at Acme, mostly Go').length, 1, 'the typed line is in the transcript once');
});

test('typing expires six seconds after the last refresh and re-arms the silence prompt', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typing(true);
  await rig.clock.advance(5000);
  rig.engine.typing(true);
  await rig.clock.advance(5999);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1); // 6 s after the last refresh
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 2, 'the silence prompt returns once typing lapsed');
  assert(!/candidate is typing/.test(rig.sessions.main.calls[1].message));
});

test('spoken words not yet answered are kept when a typed message arrives, ahead of the typed turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'I built a scheduler', 'a'); // speculating: opener running, not committed
  rig.engine.typed('here is the link');
  await flush();
  const entries = rig.engine.state().transcript;
  assert.equal(entries.length, 1, 'nothing committed yet');
  rig.sessions.opener.answer('Okay.');
  await flush();
  const last = rig.sessions.main.calls[rig.sessions.main.calls.length - 1];
  assert(last.message.includes("Candidate: 'I built a scheduler'"), last.message);
  assert(last.message.includes("Candidate (typed in chat): 'here is the link'"), last.message);
  assert(last.message.indexOf("Candidate: 'I built") < last.message.indexOf('Candidate (typed'));
  rig.sessions.main.answer('Thanks.');
  rig.streams[rig.streams.length - 1].audio(300);
  await flush();
  const turn = rig.engine.state().transcript.slice(1, 3);
  assert.deepEqual(turn.map(entry => [entry.speaker, entry.channel, entry.text]), [
    ['candidate', undefined, 'I built a scheduler'],
    ['candidate', 'chat', 'here is the link'],
  ]);
  assert(Number.isInteger(turn[0].startMs) && turn[0].endMs >= turn[0].startMs);
});

test('typed text over a committed spoken reply does not re-send the words that reply already answered', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.engine.typed('wait what is that');
  await rig.clock.advance(300);
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  const message = rig.sessions.opener.calls[1].message;
  assert(!message.includes("Candidate: 'I built a scheduler'"), message);
});

test('a main restart after a cut-off reply carries the candidate answer the reply was for', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig, 'I built a scheduler', 'a');
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush();
  rig.sessions.main.calls[1].onDelta('Tell me more. ');
  await flush();
  rig.sessions.main.fail();
  await flush();
  assert.equal(rig.restarts.length, 1);
  assert.equal(rig.restarts[0].kind, 'main');
  assert(rig.restarts[0].transcriptText.includes("Candidate: 'I built a scheduler'"), rig.restarts[0].transcriptText);
});

test('a main turn that produces nothing for 20 s is restarted and resent once, then ends the call', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  rig.engine.typed('Here is my code');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  await rig.clock.advance(19999);
  assert.equal(rig.restarts.length, 0);
  await rig.clock.advance(1);
  assert(rig.restarts.some(item => item.kind === 'main'));
  assert.equal(rig.sessions.main.calls.length, 1, 'the fresh session got the resent turn');
  assert.match(rig.sessions.main.calls[0].message, /Candidate \(typed in chat\): 'Here is my code'/);
  await rig.clock.advance(20000);
  assert.deepEqual(rig.of('ended').map(event => event.reason), ['session-error']);
});

test('a turn that keeps streaming is not timed out, and one that stalls mid-stream is cut off after 20 s', async () => {
  const rig = makeRig({ autoOpener: true });
  await greet(rig);
  rig.engine.typed('Here is my code');
  await flush();
  const stalled = rig.sessions.main.calls[1];
  stalled.onDelta('Sure. ');
  for (let step = 0; step < 6; step += 1) {
    await rig.clock.advance(10000);
    rig.sessions.main.calls[1].onDelta('And more. ');
  }
  assert.equal(rig.restarts.length, 0, 'every delta restarts the deadline');
  await rig.clock.advance(19999);
  assert.equal(rig.restarts.length, 0);
  await rig.clock.advance(1);
  assert(rig.restarts.some(item => item.kind === 'main'), 'the stalled main is restarted like any cut-off main');
  assert(stalled.signal.aborted);
});

test('a typed message sent during the last word of a reply is answered when the reply finishes on its own', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 3100); // inside the last word, which ends at 3280
  rig.engine.typed('one more thing');
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 1, 'the stop waits for the word boundary');
  rig.h.playback('utt2', 'finished', 3280);
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 2, 'the typed turn starts without another message');
  assert(rig.sessions.opener.calls[1].message.endsWith(typedMessage('one more thing')));
});

test('a typed message sent while an overlap has paused the reply is answered when that overlap stops the reply', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  rig.h.vad(true);
  await rig.clock.advance(600); // the boundary pause lands
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  rig.engine.typed('wait a second');
  await flush();
  rig.h.transcript('wait what do you mean', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  rig.h.playback('utt2', 'cancelled', 280);
  await flush();
  assert(rig.sessions.opener.calls.some(call => call.message.includes(typedMessage('wait a second'))), 'the queued typed text is answered');
});

test('repeated wordless noise does not reset the silence count, but a spoken word does', async () => {
  const rig = makeRig();
  await greet(rig);
  const finishPrompt = async () => {
    rig.sessions.main.answer('Still there?');
    rig.streams[rig.streams.length - 1].audio(300);
    await flush();
    const id = `utt${rig.streams.length}`;
    rig.h.playback(id, 'started');
    rig.h.playback(id, 'finished', 600);
    await flush();
  };
  const lastSilence = () => rig.sessions.main.calls[rig.sessions.main.calls.length - 1].message.match(/candidate silent (\d+)s/)?.[1];
  await rig.clock.advance(20000);
  assert.equal(lastSilence(), '20');
  await finishPrompt();
  rig.h.vad(true); // a cough
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(32000);
  assert.equal(lastSilence(), '40', 'the cough did not start the count over');
});

test('silence prompts back off, report the real cumulative silence, and reset when the candidate speaks', async () => {
  const rig = makeRig();
  await greet(rig);
  const silentRuns = [];
  const finishPrompt = async () => {
    rig.sessions.main.answer('Still there?');
    rig.streams[rig.streams.length - 1].audio(300);
    await flush();
    const id = `utt${rig.streams.length}`;
    rig.h.playback(id, 'started');
    rig.h.playback(id, 'finished', 600);
    await flush();
  };
  for (const wait of [20000, 20000, 30000]) {
    await rig.clock.advance(wait - 1);
    const before = rig.sessions.main.calls.length;
    await rig.clock.advance(1);
    assert.equal(rig.sessions.main.calls.length, before + 1, `prompt after ${wait} ms`);
    silentRuns.push(rig.sessions.main.calls[rig.sessions.main.calls.length - 1].message.match(/candidate silent (\d+)s/)?.[1]);
    await finishPrompt();
  }
  assert.deepEqual(silentRuns, ['20', '40', '70']);
  rig.h.vad(true);
  rig.h.transcript('here', 'r1');
  rig.h.vad(false);
  await rig.clock.advance(1200);
  rig.sessions.opener.answer('Good.');
  await flush();
  rig.sessions.main.answer('Great.');
  rig.streams[rig.streams.length - 1].audio(300);
  await rig.clock.advance(1200);
  const replyId = `utt${rig.streams.length}`;
  rig.h.playback(replyId, 'started');
  rig.h.playback(replyId, 'finished', 600);
  await flush();
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(20000);
  assert(rig.sessions.main.calls.length > calls, 'after the candidate spoke, the first prompt is back to 20 s');
});

// ---- asked marker ------------------------------------------------------------
// A stub parser that turns <asked n="N"/> into { asked: N } items, so these tests do not depend on the real parser.
export function askedParser() {
  const real = createReplyStreamParser();
  const pending = [];
  const strip = text => text.replace(/<asked n="([^"]*)"\/>/g, (_, n) => { pending.push(Number(n)); return ''; });
  const merge = snapshot => {
    const items = [...pending.splice(0).map(asked => ({ asked })), ...(snapshot.items ?? snapshot.sentences.map(sentence => ({ sentence })))];
    return { ...snapshot, items };
  };
  return { push: text => merge(real.push(strip(text))), end: () => merge(real.end()) };
}

async function askedReply(rig, text) {
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer(text);
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
}

test('asked marker: counted when the reply is delivered, once per number, in first-asked order', async () => {
  const rig = makeRig({ createParser: askedParser });
  await greet(rig);
  assert.deepEqual(rig.engine.state().askedQuestions, []);
  await askedReply(rig, '<asked n="3"/>Tell me about a scheduler you built.');
  assert.deepEqual(rig.engine.state().askedQuestions, [3]);
  assert.deepEqual(rig.of('question-asked').map(event => event.number), [3]);
  assert.equal(rig.of('question-asked')[0].kind, 'question-asked');
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  await askedReply(rig, '<asked n="1"/>Next one. <asked n="3"/>And again. <asked n="0"/><asked n="2.5"/><asked n="7"/>Last.');
  assert.deepEqual(rig.engine.state().askedQuestions, [3, 1, 7], 'repeats and non-positive or fractional numbers are ignored');
  assert.deepEqual(rig.of('question-asked').map(event => event.number), [3, 1, 7]);
});

test('answered: a question is practised only once a real answer follows it', async () => {
  const rig = makeRig({ createParser: askedParser });
  await greet(rig);
  await askedReply(rig, '<asked n="3"/>Tell me about a scheduler you built.');
  let id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  assert.deepEqual(rig.engine.state().answeredQuestions, [], 'asked, not answered yet');
  // Four words back ("I built a scheduler") are not an answer.
  await askedReply(rig, 'Sure, take your time.');
  id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  assert.deepEqual(rig.engine.state().askedQuestions, [3]);
  assert.deepEqual(rig.engine.state().answeredQuestions, [], 'a short line is not an answer');
  await speak(rig, 'it ran nightly jobs for the whole district and I wrote the retry logic and the alerting myself', 'long');
  assert.deepEqual(rig.engine.state().answeredQuestions, [3], 'a real answer counts, even before the next reply');
});

test('asked marker: a speculative reply discarded because the candidate kept talking counts nothing', async () => {
  const rig = makeRig({ createParser: askedParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('<asked n="4"/>Why a scheduler?');
  await flush();
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  assert.deepEqual(rig.engine.state().askedQuestions, [], 'not committed, not counted');
  assert.deepEqual(rig.of('question-asked'), []);
});

test('asked marker: engine reports an empty list when nothing was asked, and ids B to E are not special', async () => {
  const rig = makeRig({ createParser: askedParser });
  await greet(rig);
  assert.deepEqual(rig.engine.state().askedQuestions, []);
  const source = fs.readFileSync(new URL('../../electron/interviewPracticeCallEngine.js', import.meta.url), 'utf8');
  assert(!/['"]C['"]/.test(source), 'no hard-coded colleague ids in the engine');
});


// ---- pause patience (<wait>) and overlays (<over>) --------------------------------
// A stub parser for the new tags, so these tests do not depend on the real parser: <wait s="N"/>, <over id="X">text</over>,
// <speaker id="X"/>; everything between the tags is one sentence piece.
function tagParser() {
  const run = text => {
    const items = [];
    for (const part of text.split(/(<wait s="\d+"\/>|<over id="[A-Z]">[^<]*<\/over>|<speaker id="[A-Z]"(?: cut)?\/>)/)) {
      const wait = part.match(/^<wait s="(\d+)"\/>$/);
      const over = part.match(/^<over id="([A-Z])">([^<]*)<\/over>$/);
      const spk = part.match(/^<speaker id="([A-Z])"(?: cut)?\/>$/);
      if (wait) items.push({ wait: Number(wait[1]) });
      else if (over) items.push({ over: { speakerId: over[1], text: over[2] } });
      else if (spk) items.push(part.includes('cut') ? { speaker: spk[1], cutIn: true } : { speaker: spk[1] });
      else if (part.trim()) items.push({ sentence: part.trim() });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

async function playOut(rig) {
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
}

/** Advance to just before and then to a check-in; returns the cumulative silence it reports. */
async function checkInAt(rig, seconds, label) {
  const before = rig.sessions.main.calls.length;
  await rig.clock.advance(seconds * 1000 - 1);
  assert.equal(rig.sessions.main.calls.length, before, `${label}: not before ${seconds} s`);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, before + 1, `${label}: check-in after ${seconds} s`);
  return Number(rig.sessions.main.calls[before].message.match(/candidate silent (\d+)s/)?.[1]);
}

async function answerCheckIn(rig, text) {
  rig.sessions.main.answer(text);
  rig.streams[rig.streams.length - 1].audio(300);
  await flush();
  await playOut(rig);
}

test('wait tag: the last delivered reply sets the first check-in, then gaps of clamp(W,12,30) and clamp(1.5W,20,45)', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await deliver(rig, '<wait s="10"/>Take your time with it.<wait s="90"/>');
  assert.equal(await checkInAt(rig, 90, 'first'), 90, 'the last wait of the reply counts');
  await answerCheckIn(rig, 'Still there?');
  assert.equal(await checkInAt(rig, 30, 'second'), 120, 'gap2 = clamp(90, 12, 30)');
  await answerCheckIn(rig, 'Can you hear me?');
  assert.equal(await checkInAt(rig, 45, 'third'), 165, 'gap3 = clamp(135, 20, 45)');
});

test('wait tag: a short wait gives short gaps, bounds are 6..300 s, and no tag means the 20/40/70 default', async () => {
  const short = makeRig({ createParser: tagParser });
  await greet(short);
  await deliver(short, 'Hi.<wait s="2"/>');
  assert.equal(await checkInAt(short, 6, 'clamped up'), 6);
  await answerCheckIn(short, 'Hello?');
  assert.equal(await checkInAt(short, 12, 'gap2 floor'), 18);
  await answerCheckIn(short, 'Can you hear me?');
  assert.equal(await checkInAt(short, 20, 'gap3 floor'), 38);

  const long = makeRig({ createParser: tagParser });
  await greet(long);
  await deliver(long, 'Solve it.<wait s="900"/>');
  assert.equal(await checkInAt(long, 300, 'clamped down'), 300);

  const plain = makeRig({ createParser: tagParser });
  await greet(plain);
  await deliver(plain, 'Tell me more.');
  assert.equal(await checkInAt(plain, 20, 'first'), 20);
  await answerCheckIn(plain, 'Still there?');
  assert.equal(await checkInAt(plain, 20, 'second'), 40);
  await answerCheckIn(plain, 'Hello?');
  assert.equal(await checkInAt(plain, 30, 'third'), 70);
});

test('wait tag: a check-in reply that carries its own wait sets the gap to the next check-in', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await deliver(rig, 'Go ahead.<wait s="40"/>');
  assert.equal(await checkInAt(rig, 40, 'first'), 40);
  await answerCheckIn(rig, 'Need a minute?<wait s="100"/>');
  assert.equal(await checkInAt(rig, 100, 'own wait'), 140);
  await answerCheckIn(rig, 'Still here?');
  assert.equal(await checkInAt(rig, 45, 'back to the schedule: gap3 = clamp(60, 20, 45)'), 185);
});

test('wait tag: a reply that is never delivered counts for nothing, and the candidate speaking resets it', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Why a scheduler?<wait s="200"/>');
  await flush();
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  await deliver(rig, 'Okay.');
  assert.equal(await checkInAt(rig, 20, 'default'), 20, 'the discarded wait left no trace');
});

test('wait tag: typing in the chat still holds the check-ins', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await deliver(rig, 'Write it out.<wait s="30"/>');
  rig.engine.typing(true);
  await rig.clock.advance(5000);
  rig.engine.typing(true);
  await rig.clock.advance(30000);
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(1000);
  assert.equal(rig.sessions.main.calls.length, calls, 'no check-in while typing');
});

const overGreeting = async (rig, text) => {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(text);
  rig.streams[0].audio(3200);
  await flush();
};

test('overlay: a remark by a colleague is sent to the voice at the tag point and emitted, recorded and captioned when it plays', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'I am Priya,<over id="B">Hi Jack.</over> and I lead the team.');
  const stream = rig.streams[0];
  assert.deepEqual(stream.texts, ['I am Priya,', 'and I lead the team.'], 'the lead sentence is not split by the remark');
  assert.deepEqual(stream.overlays, [{ speakerId: 'B', text: 'Hi Jack.', afterChars: 'I am Priya,'.replace(/\s/g, '').length }]);
  assert.deepEqual(stream.log.map(item => Object.keys(item)[0]), ['text', 'overlay', 'text'], 'the overlay request sits between the texts');
  stream.overlayCb({ speakerId: 'B', text: 'Hi Jack.', offsetMs: 900 });
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 500);
  await flush();
  assert.deepEqual(rig.of('overlay'), [], 'not before playback reaches it');
  rig.h.playback('utt1', 'position', 1000);
  await flush();
  const [event] = rig.of('overlay');
  assert.deepEqual({ type: event.type, speakerId: event.speakerId, text: event.text }, { type: 'overlay', speakerId: 'B', text: 'Hi Jack.' });
  assert(Number.isFinite(event.atMs));
  const entry = rig.engine.state().transcript.find(item => item.overlay);
  assert.deepEqual({ speaker: entry.speaker, speakerId: entry.speakerId, text: entry.text, overlay: entry.overlay }, { speaker: 'interviewer', speakerId: 'B', text: 'Hi Jack.', overlay: true });
  assert(rig.of('caption').some(item => item.speakerId === 'B' && item.text === 'Hi Jack.'));
  assert.equal(rig.engine.state().transcript.find(item => !item.overlay && item.speaker === 'interviewer').text, 'I am Priya, and I lead the team.');
  rig.h.playback('utt1', 'position', 1100);
  await flush();
  assert.equal(rig.of('overlay').length, 1, 'once');
});

test('overlay: a finished utterance shows an overlay whose position event never arrived', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'Welcome.<over id="B">Hi.</over> Glad to have you.');
  rig.streams[0].overlayCb({ speakerId: 'B', text: 'Hi.', offsetMs: 400 });
  await playOut(rig);
  assert.equal(rig.of('overlay').length, 1);
});

test('overlay: an uncast id, the current speaker or a missing id produce nothing, and a reply may carry several remarks', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'One.<over id="Z">Hi.</over> Two.<over id="A">Self.</over> Three.<over id="B">First.</over><over id="B">Second.</over> Four.');
  assert.deepEqual(rig.streams[0].overlays.map(item => item.text), ['First.', 'Second.'], 'every valid remark, in order');
  const solo = makeRig({ createParser: tagParser });
  await overGreeting(solo, 'Welcome.<over id="B">Hi.</over> Go on.');
  assert.deepEqual(solo.streams[0].texts, ['Welcome.', 'Go on.'], 'a call with no panel ignores the tag, never speaking it');
});

test('overlay: several colleagues speak over the lead at once, each captioned with its own words and shown in start order', async () => {
  const panel = { leadId: 'A', speakers: [{ id: 'A', name: 'Priya', present: true }, { id: 'B', name: 'John', present: true }, { id: 'C', name: 'Mei', present: true }] };
  const rig = makeRig({ panel, speakerVoice: true, createParser: tagParser });
  await overGreeting(rig, 'With me are John and Mei,<over id="B">[warmly] Hi Jack.</over><over id="C">Hello!</over> who lead the team.');
  const stream = rig.streams[0];
  assert.deepEqual(stream.overlays.map(item => [item.speakerId, item.text]), [['B', '[warmly] Hi Jack.'], ['C', 'Hello!']], 'both go to the voice at the same point');
  assert.equal(stream.overlays[0].afterChars, stream.overlays[1].afterChars);
  // The voice may report them out of order; captions come from each remark's own words.
  stream.overlayCb({ speakerId: 'C', text: 'Hello!', offsetMs: 950 });
  stream.overlayCb({ speakerId: 'B', text: '[warmly] Hi Jack.', offsetMs: 900 });
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 1000);
  await flush();
  assert.deepEqual(rig.of('overlay').map(event => [event.speakerId, event.text]), [['B', 'Hi Jack.'], ['C', 'Hello!']]);
  assert.deepEqual(rig.engine.state().transcript.filter(item => item.overlay).map(item => [item.speakerId, item.text]), [['B', 'Hi Jack.'], ['C', 'Hello!']]);
});

const UNMET = () => ({ leadId: 'A', speakers: [{ id: 'A', name: 'Priya', present: true }, { id: 'B', name: 'Kofi Okafor', present: true }] });
const nonBlank = text => text.replace(/\s/g, '').length;

test('overlay: a colleague nobody has named yet is heard only once the lead names them, at the end of that sentence', async () => {
  // The real parser, which reports the remark after the sentences around it and splits the text into sentences.
  const rig = makeRig({ panel: UNMET(), speakerVoice: true });
  await overGreeting(rig, 'Hi Jack, I am Priya, the manager here.<over id="B">Hey Jack.</over> With me is Kofi, one of our engineers. Today is a short coding exercise.');
  const stream = rig.streams[0];
  assert.deepEqual(stream.overlays, [{ speakerId: 'B', text: 'Hey Jack.', afterChars: nonBlank('Hi Jack, I am Priya, the manager here.With me is Kofi, one of our engineers.') }], 'held until the sentence that names him has been said');
  assert.deepEqual(stream.texts, ['Hi Jack, I am Priya, the manager here.', 'With me is Kofi, one of our engineers.', 'Today is a short coding exercise.']);
});

test('overlay: a hello written before the name inside the naming sentence moves to its end; one written after the name stays', async () => {
  const early = makeRig({ panel: UNMET(), speakerVoice: true, createParser: tagParser });
  await overGreeting(early, 'Hi Jack.<over id="B">Hey!</over> That is Kofi, our engineer.');
  // The tag sits at the start of the sentence that names Kofi: the parser reports it after that sentence, before the name.
  assert.deepEqual(early.streams[0].overlays.map(item => item.afterChars), [nonBlank('Hi Jack.That is Kofi, our engineer.')]);
  const late = makeRig({ panel: UNMET(), speakerVoice: true, createParser: tagParser });
  await overGreeting(late, 'Hi Jack, with me is Kofi,<over id="B">Hey Jack.</over> our engineer.');
  assert.deepEqual(late.streams[0].overlays.map(item => item.afterChars), [nonBlank('Hi Jack, with me is Kofi,')], 'once named, the remark is heard where it was written');
});

test('overlay: a colleague never named in the reply says nothing over it, and a known one is heard where written', async () => {
  const rig = makeRig({ panel: UNMET(), speakerVoice: true, createParser: tagParser });
  await overGreeting(rig, 'Hi Jack, I am Priya.<over id="B">Hey Jack.</over> How is your day going?');
  assert.deepEqual(rig.streams[0].overlays, [], 'nobody has said who he is');
  await playOut(rig);
  assert(!rig.engine.state().transcript.some(item => item.overlay));
  const known = makeRig({ panel: { leadId: 'A', speakers: [{ id: 'A', name: 'Priya', present: true }, { id: 'B', name: 'Kofi', present: true, introduced: true }] }, speakerVoice: true, createParser: tagParser });
  await overGreeting(known, 'Hi Jack, I am Priya.<over id="B">Hey Jack.</over> How is your day going?');
  assert.equal(known.streams[0].overlays.length, 1);
});

test('overlay: a voice without overlay support speaks the main text untouched and emits nothing', async () => {
  const rig = panelRig({ createParser: tagParser, overlayVoice: false });
  await overGreeting(rig, 'Welcome.<over id="B">Hi.</over> Go on.');
  assert.deepEqual(rig.streams[0].texts, ['Welcome.', 'Go on.']);
  await playOut(rig);
  assert.deepEqual(rig.of('overlay'), []);
  assert(!rig.engine.state().transcript.some(item => item.overlay));
});

test('overlay: a reply that is cancelled before it plays produces nothing', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'Welcome.<over id="B">Hi.</over> Go on.');
  rig.engine.hangUp();
  rig.streams[0].overlayCb?.({ speakerId: 'B', text: 'Hi.', offsetMs: 0 });
  rig.h.playback('utt1', 'position', 500);
  await flush();
  assert.deepEqual(rig.of('overlay'), []);
  assert(!rig.engine.state().transcript.some(item => item.overlay));
});

test('cut-in: a sentence that ends in a dash before a speaker switch is spoken, captioned and attributed like any other', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'So the main thing we look for is\u2014<speaker id="B"/>Sorry, one quick thing.<speaker id="A"/>As I was saying, the main thing is ownership.');
  assert.deepEqual(rig.streams[0].log, [
    { text: 'So the main thing we look for is\u2014' }, { speaker: 'B' }, { text: 'Sorry, one quick thing.' }, { speaker: 'A' },
    { text: 'As I was saying, the main thing is ownership.' },
  ]);
  const entry = rig.engine.state().transcript[0];
  assert.deepEqual(entry.segments.map(item => item.speakerId), ['A', 'B', 'A']);
  assert.equal(entry.segments[0].text, 'So the main thing we look for is\u2014');
});

// ---- silence bound, late waits, overlay unit and captions ---------------------------
// Stub parser: <wait s="N"/>, <listen/> (no items), <over id="X" after="N" spoken="...">text</over>, plain text as one sentence.
function patienceParser() {
  const run = text => {
    const items = [];
    for (const part of text.split(/(<wait s="\d+"\/>|<listen\/>|<pass\/>|<over [^>]*>[^<]*<\/over>)/)) {
      const wait = part.match(/^<wait s="(\d+)"\/>$/);
      const over = part.match(/^<over id="([A-Z])"(?: after="(\d+)")?(?: spoken="([^"]*)")?>([^<]*)<\/over>$/);
      if (wait) items.push({ wait: Number(wait[1]) });
      else if (over) items.push({ over: { speakerId: over[1], text: over[4], ...(over[2] !== undefined ? { afterChars: Number(over[2]) } : {}), ...(over[3] !== undefined ? { spoken: over[3] } : {}) } });
      else if (part.trim() && part !== '<listen/>' && part !== '<pass/>') items.push({ sentence: part.trim() });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

test('wait tag: a wait that arrives after the reply was committed still counts', async () => {
  const rig = makeRig({ createParser: patienceParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'late');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  const call = rig.sessions.main.calls[rig.sessions.main.calls.length - 1];
  call.onDelta('Tell me more.');
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  call.onDelta('<wait s="50"/>'); // written last, after the first audio
  rig.sessions.main.answer('', { chunks: [] });
  await flush();
  await playOut(rig);
  assert.equal(await checkInAt(rig, 50, 'first'), 50);
});

test('silence: a check-in answered with listen still counts, its wait sets the next gap, and the engine ends the call after check 3', async () => {
  const options = [];
  const rig = makeRig({ createParser: patienceParser, formatTurn: option => { options.push(option); return `[candidate silent ${Math.round((option.silenceMs ?? 0) / 1000)}s]`; } });
  await greet(rig);
  await deliver(rig, 'Go ahead.<wait s="30"/>');
  assert.equal(await checkInAt(rig, 30, 'first'), 30);
  rig.sessions.main.answer('<listen/><wait s="100"/>', { chunks: ['<listen/><wait s="100"/>'] });
  await flush();
  assert.equal(await checkInAt(rig, 100, 'listen reply wait'), 130);
  await answerCheckIn(rig, 'Still there?');
  assert.deepEqual(options.filter(item => item.silenceMs !== null && item.silenceMs !== undefined).map(item => item.silenceCheck), [1, 2]);
  assert.equal(await checkInAt(rig, 45, 'third'), 175);
  assert.equal(options.filter(item => item.silenceCheck === 3).length, 1);
  await answerCheckIn(rig, 'Hello?');
  assert.deepEqual(rig.of('ended'), []);
  await rig.clock.advance(120000);
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'interviewer', cause: 'silence' }]);
  assert.equal(rig.engine.state().phase, 'ended');
  assert.equal(rig.sessions.main.calls.length, 5, 'no fourth check-in message');
});

// A reply that asked nothing (<wait s="N" statement/>): after N s of quiet the interviewer picks the conversation up once,
// uncounted, and only then do the check-ins start. Call of 2026-11-22: the panel sat 18.5 s after answering a question.
test('statement: a quiet stretch after a line that asked nothing brings one uncounted carry-on, then the usual check-ins', async () => {
  const rig = makeRig();
  await greet(rig);
  await deliver(rig, 'We run blameless post-mortems.<wait s="5" statement/>');
  const entry = rig.engine.state().transcript.filter(item => item.speaker === 'interviewer').at(-1);
  assert.equal(entry.statement, true, 'the transcript marks the line');
  assert.equal(await checkInAt(rig, 5, 'carry-on'), 5);
  const carry = rig.sessions.main.calls.at(-1).message;
  assert(carry.includes('after your last line, which asked them nothing') && !carry.includes('check 1'), carry);
  await answerCheckIn(rig, 'Did that answer what you were after?');
  assert.equal(rig.engine.state().transcript.filter(item => item.speaker === 'interviewer').at(-1).statement, undefined);
  await checkInAt(rig, 20, 'first check');
  assert(rig.sessions.main.calls.at(-1).message.includes('check 1 of 3'), rig.sessions.main.calls.at(-1).message);
});

test('statement: only one carry-on in a row; a second statement into the quiet is followed by a real check-in', async () => {
  const rig = makeRig();
  await greet(rig);
  await deliver(rig, 'That is how on-call works here.<wait s="1" statement/>');
  assert.equal(await checkInAt(rig, 3, 'carry-on, clamped up to 3 s'), 3);
  await answerCheckIn(rig, 'Happy to say more about it.<wait s="4" statement/>');
  await checkInAt(rig, 4, 'second quiet stretch');
  assert(rig.sessions.main.calls.at(-1).message.includes('check 1 of 3'), rig.sessions.main.calls.at(-1).message);
});

test('statement: the candidate speaking makes the next statement get its carry-on again; a plain wait is still at least 6 s', async () => {
  const rig = makeRig();
  await greet(rig);
  await deliver(rig, 'Fair enough.<wait s="4" statement/>');
  await checkInAt(rig, 4, 'carry-on');
  await answerCheckIn(rig, 'Anything else on that?');
  await deliver(rig, 'Good, that is our setup.<wait s="4" statement/>');
  await checkInAt(rig, 4, 'carry-on again after the candidate spoke');
  assert(rig.sessions.main.calls.at(-1).message.includes('which asked them nothing'));
  await answerCheckIn(rig, 'Over to you.');
  await deliver(rig, 'Tell me more.<wait s="3"/>');
  await checkInAt(rig, 6, 'plain wait keeps its floor');
});

test('silence: the candidate speaking resets the check count', async () => {
  const options = [];
  const rig = makeRig({ createParser: patienceParser, formatTurn: option => { options.push(option); return `[candidate silent ${Math.round((option.silenceMs ?? 0) / 1000)}s]`; } });
  await greet(rig);
  await deliver(rig, 'Go ahead.');
  await checkInAt(rig, 20, 'first');
  await answerCheckIn(rig, 'Still there?');
  await deliver(rig, 'Fine.');
  await checkInAt(rig, 20, 'after reset');
  assert.equal(options[options.length - 1].silenceCheck, 1);
});

test('overlay: the position adds the acknowledgement already sent on the segment, in non-whitespace characters', async () => {
  const rig = panelRig({ createParser: patienceParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'ov');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Got it ok.'); // 8 non-whitespace characters
  await flush(); // the acknowledgement is sent before the main text arrives
  rig.sessions.main.answer('Tell me.<over id="B" after="7">Hmm.</over>', { chunks: ['Tell me.<over id="B" after="7">Hmm.</over>'] });
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[rig.streams.length - 1].overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 15 }]);
});

test('overlay: without afterChars the engine counts non-whitespace characters sent, acknowledgement included', async () => {
  const rig = panelRig({ createParser: patienceParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'ov2');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Got it ok.');
  await flush();
  await flush();
  rig.sessions.main.answer('Tell me.<over id="B">Hmm.</over>', { chunks: ['Tell me.<over id="B">Hmm.</over>'] });
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[rig.streams.length - 1].overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 15 }]);
});

test('overlay: captions and transcript show the spoken field, else the text without delivery tags; the voice gets the text', async () => {
  const withSpoken = panelRig({ createParser: patienceParser });
  await overGreeting(withSpoken, 'Hello there.<over id="B" after="3" spoken="Nice one.">[laughs] Nice one.</over>');
  const stream = withSpoken.streams[0];
  assert.equal(stream.overlays[0].text, '[laughs] Nice one.');
  stream.overlayCb({ speakerId: 'B', text: '[laughs] Nice one.', offsetMs: 100 });
  withSpoken.h.playback('utt1', 'started');
  withSpoken.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(withSpoken.of('overlay')[0].text, 'Nice one.');
  assert.equal(withSpoken.engine.state().transcript.find(item => item.overlay).text, 'Nice one.');

  const plain = panelRig({ createParser: patienceParser });
  await overGreeting(plain, 'Hello there.<over id="B" after="3">[softly] Right.</over>');
  plain.streams[0].overlayCb({ speakerId: 'B', text: '[softly] Right.', offsetMs: 100 });
  plain.h.playback('utt1', 'started');
  plain.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(plain.of('overlay')[0].text, 'Right.');
  assert.equal(plain.of('caption').find(item => item.overlay).text, 'Right.');
});

// ---- controls take effect when playback reaches their position ------------------
// Word timings: 300 ms per word, so word i ends at i * 300 + 280. Texts below are written so that the words match the sentences.
async function openReply(rig, text, wordList = null, audioSamples = 3200) {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(text);
  rig.streams[0].audio(audioSamples);
  if (wordList) rig.streams[0].words(wordList);
  await flush();
}
const eventTypes = rig => rig.events.filter(event => ['screen', 'screen-stop', 'pad'].includes(event.type)).map(event => (event.type === 'pad' ? `pad-${event.open ? 'open' : 'close'}` : event.type));

test('controls: a screen tag after two sentences is delivered once they have been heard, with that moment as atMs', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two. Three four.[[screen:Sum|Add.]] Five six.', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  assert.equal(rig.of('screen').length, 0, 'not at commit');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 500);
  rig.h.playback('utt1', 'position', 1000); // 'four.' ends at 1180
  assert.equal(rig.of('screen').length, 0, 'not at playback start nor before the second sentence has been heard');
  assert.equal(rig.engine.state().screen, null);
  await rig.clock.advance(300);
  assert.equal(rig.of('screen').length, 0, 'no position event has reached the end of the last word before the tag');
  rig.h.playback('utt1', 'position', 1200); // 'four.' ends at 1180
  assert.equal(rig.of('screen').length, 1, 'delivered when a position event reaches the end of the last word');
  assert.equal(rig.of('screen')[0].atMs, rig.clock.now() - HELPER_OFFSET, 'the event carries the moment it was heard');
  assert.equal(rig.engine.state().screen.title, 'Sum');
  rig.h.playback('utt1', 'position', 1500);
  assert.equal(rig.of('screen').length, 1, 'once');
});

test('controls: a delivery tag the voice times as several words adds no letters to what was heard', async () => {
  // call-mwq2lkdo-jz4w5m: "[slightly amused]" came back as two timed words, and their letters made the share start a phrase early.
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, '[slightly amused] One two. Three four.[[screen:Sum|Add.]] Five six.', words('[slightly', 'amused]', 'One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 1500); // 'Three' has ended (1480), 'four.' has not (1780)
  assert.equal(rig.of('screen').length, 0, 'the tag letters do not count as heard words');
  rig.h.playback('utt1', 'position', 1800);
  assert.equal(rig.of('screen').length, 1, 'shown once the last word before the tag has been heard');
});

test('controls: a tag before any text takes effect at playback start, not before', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, '[[screen:Sum|Add.]][[pad-open:go]]One two.', words('One', 'two.'));
  assert.deepEqual(eventTypes(rig), []);
  rig.h.playback('utt1', 'started');
  assert.deepEqual(eventTypes(rig), ['screen', 'pad-open'], 'both sit at the very start');
});

test('controls: a pad opened later in the same reply goes up with the screen it belongs to (call of 2026-11-22: 13 s apart)', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two.[[screen:Sum|Add.]] Three four. Five six.[[pad-open:go]]', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 700); // 'two.' has been heard, 'six.' has not
  assert.deepEqual(eventTypes(rig), ['screen', 'pad-open'], 'the pad comes with the problem');
  assert.equal(rig.of('pad')[0].lang, 'go');
  rig.h.playback('utt1', 'position', 5000);
  rig.h.playback('utt1', 'finished', 5000);
  await flush();
  assert.deepEqual(eventTypes(rig), ['screen', 'pad-open'], 'and not again at its own place');
});

test('controls: a pad after a stop or another screen keeps its own place', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two.[[screen:Sum|Add.]] Three four.[[stop]] Five six.[[pad-open:go]]', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 700);
  assert.deepEqual(eventTypes(rig), ['screen']);
  rig.h.playback('utt1', 'position', 5000);
  assert.deepEqual(eventTypes(rig), ['screen', 'screen-stop', 'pad-open']);
});

test('controls: without word timings a tag is placed in proportion to its characters, and a tag at the end waits for the finish', async () => {
  const rig = makeRig({ createParser: screenParser });
  // 17 of 25 characters precede the screen tag; 48000 bytes at 24 kHz is 1000 ms of audio, so it falls at 680 ms.
  await openReply(rig, 'One two. Three four.[[screen:Sum|Add.]] Five six.[[stop]]', null, 48000);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 500);
  assert.deepEqual(eventTypes(rig), []);
  rig.h.playback('utt1', 'position', 700);
  assert.deepEqual(eventTypes(rig), ['screen']);
  rig.h.playback('utt1', 'position', 990);
  assert.deepEqual(eventTypes(rig), ['screen'], 'the end tag sits at the very end of the audio');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(eventTypes(rig), ['screen', 'screen-stop']);
});

test('controls: a tag whose position is never confirmed is delivered at finish', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two.[[pad-open:go]]');
  rig.h.playback('utt1', 'started');
  assert.deepEqual(eventTypes(rig), []);
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(eventTypes(rig), ['pad-open']);
});

test('controls: late word timings release a waiting control', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two.[[screen:Sum|Add.]] Three four.', null, 480000);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 900);
  assert.deepEqual(eventTypes(rig), []);
  rig.streams[0].words(words('One', 'two.', 'Three', 'four.'));
  assert.deepEqual(eventTypes(rig), ['screen']);
});

test('controls: an interruption before the position means the tag never takes effect', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two. Three four.[[screen:Hidden|No.]] Five six.', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 600);
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  rig.h.playback('utt1', 'cancelled', 650);
  rig.h.playback('utt1', 'position', 5000);
  await flush();
  assert.deepEqual(eventTypes(rig), []);
  assert.equal(rig.engine.state().screen, null);
});

test('controls: several controls arrive in order, each when its own position is reached', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, '[[pad-open:go]]One two.[[screen:T|c]] Three four.[[stop]] Five six.[[pad-close]]', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  rig.h.playback('utt1', 'started');
  assert.deepEqual(eventTypes(rig), ['pad-open']);
  rig.h.playback('utt1', 'position', 600);
  assert.deepEqual(eventTypes(rig), ['pad-open', 'screen']);
  rig.h.playback('utt1', 'position', 1200);
  assert.deepEqual(eventTypes(rig), ['pad-open', 'screen', 'screen-stop'], 'nothing holds the controls behind a screen');
  rig.h.playback('utt1', 'finished', 1800);
  await flush();
  assert.deepEqual(eventTypes(rig), ['pad-open', 'screen', 'screen-stop', 'pad-close']);
});

test('controls: a reply with no audio delivers its controls at finish', async () => {
  const rig = makeRig({ createParser: screenParser });
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('[[screen:Sum|Add.]][[pad-open:go]]');
  await flush();
  assert.deepEqual(eventTypes(rig), ['screen', 'pad-open']);
});

test('controls: the acknowledgement spoken first shifts the position of the main reply\'s tags', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush(); // the acknowledgement is spoken before the main reply starts to arrive
  rig.sessions.main.answer('One two.[[screen:Sum|Add.]] Three.');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'One', 'two.', 'Three.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'position', 600); // 'Right.' and 'One' heard
  assert.deepEqual(eventTypes(rig), [], 'the tag follows "two.", which has not been heard');
  rig.h.playback('utt2', 'position', 900);
  assert.deepEqual(eventTypes(rig), ['screen']);
});

test('controls: a switch to a colleague already on the call emits no participant event', async () => {
  const rig = panelRig({ createParser: tagParser });
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer('Hello, I am Priya. <speaker id="B"/>And I am John.<over id="A">Mm.</over>');
  rig.streams[0].audio(3200);
  rig.streams[0].words(HELLO_WORDS);
  await flush();
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 1100);
  rig.h.playback('utt1', 'position', 2000);
  assert.deepEqual(rig.events.filter(event => /^participant/.test(event.type)), [], 'the engine never announces a participant itself');
});

// ---- a colleague who has not joined: the lead is told who is here, and nothing is said in an absent colleague's name ----
// Stub parser: <speaker id/>, <over id>, [[screen:T|C]], [[pad-open:lang]], [[chat:text]] become items in order; the rest is sentences.
function richParser() {
  const run = text => {
    const items = [];
    for (const part of text.split(/(<over id="[A-Z]">[^<]*<\/over>|<speaker id="[A-Z]"\/>|\[\[[^\]]*\]\])/)) {
      const over = part.match(/^<over id="([A-Z])">([^<]*)<\/over>$/);
      const spk = part.match(/^<speaker id="([A-Z])"\/>$/);
      const token = part.match(/^\[\[([a-z-]+):([^\]]*)\]\]$/);
      if (over) items.push({ over: { speakerId: over[1], text: over[2] } });
      else if (spk) items.push({ speaker: spk[1] });
      else if (token) {
        if (token[1] === 'screen') { const [title, content] = token[2].split('|'); items.push({ screen: { title, content, delaySeconds: null } }); }
        else if (token[1] === 'pad-open') items.push({ pad: { open: true, lang: token[2] } });
        else if (token[1] === 'chat') items.push({ chat: token[2] });
      } else if (part.trim()) for (const sentence of part.match(/[^.!?]+[.!?]/g) ?? []) items.push({ sentence: sentence.trim() });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

function absentRig(extra = {}) {
  const options = [];
  const rig = panelRig({ createParser: richParser, formatTurn: option => { options.push(option); return `[turn ${JSON.stringify(option.candidateText ?? '')}]`; }, ...extra });
  rig.options = options;
  return rig;
}
const MEI_ABSENT = { here: ['Priya', 'John'], notJoined: ['Mei'] };

/** Start the call and let the lead's first reply arrive; `wordList` are the voice's word timings. */
async function absentStart(rig, reply, wordList = []) {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(reply);
  rig.streams[0].audio(3200);
  if (wordList.length) rig.streams[0].words(wordList);
  await flush();
}

test('presence: the connect message names who is on the call and who has not joined; with nobody missing it is unchanged', async () => {
  const rig = absentRig();
  rig.engine.start();
  await flush();
  assert.equal(rig.sessions.main.calls[0].message, '[elapsed 00:00] [call connected] [On the call: Priya, John. Not joined yet: Mei.]');
  const everyone = makeRig({ panel: { leadId: 'A', speakers: [{ id: 'A', name: 'Priya', present: true }, { id: 'B', name: 'John', present: true }] }, speakerVoice: true });
  everyone.engine.start();
  await flush();
  assert.equal(everyone.sessions.main.calls[0].message, '[elapsed 00:00] [call connected]');
});

test('presence: candidate turns, check-ins and pad progress carry it, and it changes once the colleague joins', async () => {
  const rig = absentRig();
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT, 'a spoken turn');
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Okay.');
  rig.streams[1].audio(500);
  await rig.clock.advance(700);
  await playOut(rig);
  rig.engine.typed('typed words');
  await flush();
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT, 'a typed turn');
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT);
  rig.sessions.opener.answer('Mm.');
  await flush();
  rig.sessions.main.answer('Go on.');
  rig.streams[2].audio(500);
  await rig.clock.advance(700);
  await playOut(rig);
  const before = rig.options.length;
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.silencePromptMs + 100);
  assert.equal(rig.options.length, before + 1);
  assert(rig.options.at(-1).silenceCheck !== undefined, 'a check-in');
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT);
  rig.sessions.main.answer('Still there?');
  rig.streams[3].audio(500);
  await flush();
  await playOut(rig);
  rig.engine.setPadText('x = 1');
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.padIdleMs + 100);
  assert(rig.options.at(-1).padProgress !== undefined, 'pad progress');
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT);
  rig.sessions.main.answer('Take your time.');
  rig.streams[4].audio(500);
  await flush();
  await playOut(rig);
  rig.engine.participantJoined('C');
  rig.engine.typed('after the join');
  await flush();
  const last = rig.options.at(-1);
  assert.deepEqual(last.joined, ['Mei'], 'the existing note about the arrival still appears');
  assert.equal(last.presence, undefined, 'nobody is missing any more');
});

test('absent colleague: their sentences reach no voice, caption or transcript; the lead\'s words before and after still play', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei. Meera asks first. <speaker id="A"/>Over to me.',
    [...spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'), ...spoken('A', 1200, 'Over', 'to', 'me.')]);
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hello, I am Priya.' }, { text: 'Over to me.' }], 'no sentence of hers and no voice switch at all');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 2400);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript[0]), { speaker: 'interviewer', text: 'Hello, I am Priya. Over to me.', speakerId: 'A' });
  assert(!rig.of('caption').some(event => /Mei|Meera/.test(event.text)));
  assert.deepEqual(rig.of('speaker').map(event => event.speakerId), ['A']);
});

test('absent colleague: one follow-up turn starts after playback, with the note, no acknowledgement and no silence check', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  assert.equal(rig.sessions.main.calls.length, 1, 'not while the reply is still playing');
  rig.h.playback('utt1', 'started');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'the follow-up turn');
  const turn = rig.options.at(-1);
  assert.deepEqual(turn.absentHandover, ['Mei']);
  assert.deepEqual(turn.presence, MEI_ABSENT);
  assert.equal(turn.silenceCheck, undefined, 'not a silence check');
  assert.equal(turn.padProgress, undefined);
  assert.deepEqual(turn.acknowledgements, []);
  assert.equal(rig.sessions.opener.calls.length, 0, 'nothing is acknowledged before it');
  rig.sessions.main.answer('Sorry, Mei is not here yet. Let me carry on.');
  rig.streams[1].audio(800);
  await flush();
  await playOut(rig);
  assert.equal(rig.sessions.main.calls.length, 2, 'sent once, however the follow-up ends');
  assert.equal(rig.options.filter(option => option.absentHandover).length, 1);
});

test('absent colleague: a reply with nothing spoken starts the follow-up at once', async () => {
  const rig = absentRig();
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('<speaker id="C"/>Mei speaking.');
  await flush();
  assert.deepEqual(rig.streams[0].texts, []);
  assert.equal(rig.of('caption').length, 0);
  assert.equal(rig.engine.state().transcript.length, 0);
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
});

test('absent colleague: the follow-up is not sent when the candidate has started to type; their turn carries the note', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  rig.h.playback('utt1', 'started');
  rig.engine.typing(true);
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1, 'no follow-up while they are writing');
  rig.engine.typing(false);
  rig.engine.typed('Hello Priya');
  await flush();
  rig.sessions.opener.answer('Hi.');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  const turn = rig.options.at(-1);
  assert.equal(turn.candidateText, 'Hello Priya');
  assert.deepEqual(turn.absentHandover, ['Mei']);
  rig.sessions.main.answer('Welcome.');
  rig.streams[1].audio(500);
  await flush();
  await playOut(rig);
  assert.equal(rig.sessions.main.calls.length, 2, 'the note was given once');
});

test('absent colleague: a message typed while the reply plays carries the note instead of a separate follow-up', async () => {
  const rig = absentRig({ autoOpener: true });
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  rig.h.playback('utt1', 'started');
  rig.engine.typed('Hello Priya');
  await flush();
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'the greeting and the candidate\'s turn: no separate follow-up');
  assert.equal(rig.options.at(-1).candidateText, 'Hello Priya');
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
});

test('absent colleague: an over remark by them is dropped and triggers the same note', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Welcome.<over id="C">Hi.</over> Go on.', words('Welcome.', 'Go', 'on.'));
  assert.deepEqual(rig.streams[0].overlays, []);
  assert.deepEqual(rig.streams[0].texts, ['Welcome.', 'Go on.']);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.of('overlay'), []);
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
});

test('absent colleague: a screen or pad tag inside their segment is dropped; the lead\'s own tags still count', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello. <speaker id="C"/>[[screen:Theirs|Nope.]][[pad-open:go]] Look here. <speaker id="A"/>Mine.[[screen:Mine|Yes.]]',
    words('Hello.', 'Mine.'));
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.of('screen').map(event => event.title), ['Mine']);
  assert.deepEqual(rig.of('pad'), []);
});

test('a speaker id never cast: its text is dropped everywhere and the lead gets one follow-up with unknownSpeaker', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hi. <speaker id="Y"/>Hello there. <over id="Z">No.</over>');
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hi.' }]);
  assert.deepEqual(rig.streams[0].overlays, []);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'one follow-up turn');
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
  assert.equal(rig.options.at(-1).absentHandover, undefined);
  assert.deepEqual(rig.of('caption').map(event => event.text).filter(text => /Hello|No\./.test(text)), []);
  assert.equal(JSON.stringify(rig.engine.state().transcript).includes('Hello there'), false);
});

test('a speaker id never cast: the follow-up is not chained', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hi. <speaker id="Y"/>Hello there.');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  rig.sessions.main.answer('<speaker id="Y"/>Again.');
  rig.streams[1]?.audio?.(640);
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'the follow-up reply does not start another follow-up');
});

test('a speaker id never cast and a cast colleague who has not joined in one reply: names and the flag both reach the lead', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hi. <speaker id="C"/>Hello, Mei here. <speaker id="Y"/>Me too. <speaker id="A"/>Back.');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
});

test('a speaker id never cast: a message typed while the reply plays carries the flag', async () => {
  const rig = absentRig({ autoOpener: true });
  await absentStart(rig, 'Hi. <speaker id="Y"/>Hello there.');
  rig.h.playback('utt1', 'started');
  rig.engine.typed('Hello Priya');
  await flush();
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'no separate follow-up');
  assert.equal(rig.options.at(-1).candidateText, 'Hello Priya');
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
});

async function soloReply(main) {
  const options = [];
  const rig = makeRig({ autoOpener: true, createParser: richParser, formatTurn: option => { options.push(option); return '[turn]'; } });
  rig.options = options;
  await greet(rig);
  await deliver(rig, main);
  return rig;
}

test('solo call: a tag other than the lead\'s own drops its text and triggers one follow-up with unknownSpeaker', async () => {
  const rig = await soloReply('Fine. <speaker id="B"/>Theirs. <over id="C">Hm.</over>');
  assert.deepEqual(rig.streams[1].log.filter(item => item.text !== undefined).map(item => item.text), ['Fine.']);
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
  assert.equal(JSON.stringify(rig.engine.state().transcript).includes('Theirs'), false);
});

test('solo call: the lead\'s own tag is harmless', async () => {
  const rig = await soloReply('Fine. <speaker id="A"/>Mine.');
  assert.deepEqual(rig.streams[1].log.filter(item => item.text !== undefined).map(item => item.text), ['Fine.', 'Mine.']);
  assert.equal(rig.options.some(option => option.unknownSpeaker), false);
});

test('absent colleague: when they join before the follow-up, nothing is sent about them', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  rig.h.playback('utt1', 'started');
  rig.engine.participantJoined('C');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
});

test('the early-join patch is gone from the engine', () => {
  const source = fs.readFileSync(new URL('../../electron/interviewPracticeCallEngine.js', import.meta.url), 'utf8');
  assert(!/early-join|ensureJoined|earlyPending|serviceJoined/.test(source));
});

test('chat items are delivered when playback reaches them, and not when the reply is cut off before', async () => {
  const rig = makeRig({ createParser: richParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush();
  rig.sessions.main.answer('Look.[[chat:First note.]] Then more.[[chat:Second note.]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.', 'Then', 'more.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  assert.deepEqual(rig.of('chat'), [], 'not when the reply starts to play');
  rig.h.playback('utt2', 'position', 500);
  assert.deepEqual(rig.of('chat'), []);
  rig.h.playback('utt2', 'position', 700);
  assert.deepEqual(rig.of('chat').map(event => event.text), ['First note.']);
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  rig.h.playback('utt2', 'cancelled', 750);
  await flush();
  assert.deepEqual(rig.of('chat').map(event => event.text), ['First note.'], 'the second note was never reached');
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.channel === 'chat' && entry.speaker === 'interviewer').map(entry => entry.text), ['First note.']);
});

test('a cancel reporting a heard position past the last position event delivers the controls inside the heard text, none beyond', async () => {
  const rig = makeRig({ createParser: richParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush();
  // 'Then.' is a whole sentence: the stub parser drops an unterminated fragment, which the old punctuation-inclusive count tolerated by accident.
  rig.sessions.main.answer('Look.[[screen:Keep|Stay.]] Then.[[chat:Hear.]] More.[[screen:Next|Later.]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.', 'Then.', 'More.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'position', 300); // only 'Right.' is known to be heard
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  assert.equal(rig.engine.state().screen, null);
  rig.h.playback('utt2', 'cancelled', 900); // 'Right.', 'Look.' and 'Then' were in fact heard
  await flush();
  assert.deepEqual(rig.engine.state().screen, { title: 'Keep', content: 'Stay.', speakerId: 'A' });
  assert.deepEqual(rig.of('chat').map(event => event.text), ['Hear.']);
  assert.equal(rig.of('screen').length, 1, 'the second screen tag follows words that were not heard');
});

test('when the voice fails part way, controls after the words that were never spoken are dropped', async () => {
  const rig = makeRig({ createParser: richParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  await flush();
  rig.sessions.main.answer('Look.[[screen:Keep|Stay.]] Then more.[[screen:Next|Later.]][[chat:Late note.]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.')); // the voice stopped after these
  rig.streams[1].finish = () => Promise.reject(new Error('voice dropped'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.of('error').map(event => event.code), ['voice-failed']);
  assert.deepEqual(rig.engine.state().screen, { title: 'Keep', content: 'Stay.', speakerId: 'A' });
  assert.equal(rig.of('screen').length, 1);
  assert.deepEqual(rig.of('chat'), []);
});

// ---- a share being set up is silence between two segments --------------------
const SHARE_MAIN = 'Tell me about the design.[[screen:Doc|Body text.|#6]] What was hard?';
// "Tell me about the design." ends at 2380 ms; "What was hard?" is heard after that.
const shareRig = async (main = SHARE_MAIN, options = {}, wordList = REPLY_WORDS) => {
  const rig = makeRig({ createParser: screenParser, ...options });
  await greet(rig);
  await toPlaying(rig, { main, wordList });
  return rig;
};
const gapsOf = (rig, index = 1) => rig.streams[index].log.filter(item => item.gap !== undefined).map(item => item.gap);

test('share gap: a first-share screen tag between two sentences gives gap(6000) between them in the voice log', async () => {
  const rig = await shareRig();
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Tell me about the design.' }, { gap: 6000 }, { text: 'What was hard?' }]);
});

test('share gap: the queued path keeps the order of texts, switches and the gap', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[spk:B]]Look.[[screen:Doc|Body.|#6]]Next.');
  const log = rig.streams[rig.streams.length - 1].log;
  const at = log.findIndex(item => item.gap !== undefined);
  assert(at > 0, JSON.stringify(log));
  assert.deepEqual(log[at], { gap: 6000 });
  assert.deepEqual(log[at - 1], { text: 'Look.' });
  assert.deepEqual(log[at + 1], { text: 'Next.' });
  assert(log.findIndex(item => item.speaker === 'B') < at, 'the switch stays ahead of the gap');
});

test('share gap: while the voice gate is closed the gap is queued and sent in order when it opens', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('One.[[screen:Doc|Body.|#6]] Two.');
  await flush();
  assert.deepEqual(rig.streams[1].log, [], 'nothing reaches the voice before the gate opens');
  await rig.clock.advance(600);
  assert.deepEqual(rig.streams[1].log.slice(-3), [{ text: 'One.' }, { gap: 6000 }, { text: 'Two.' }]);
});

test('share gap: a tag value of 9 gives gap(9000), and the screen event carries the same value', async () => {
  const rig = await shareRig('Look.[[screen:Doc|Body.|#9]] Then.');
  assert.deepEqual(gapsOf(rig), [9000]);
  rig.h.playback('utt2', 'position', 1500);
  await flush();
  assert.equal(rig.of('screen')[0].delayMs, 9000);
});

test('share gap: a replacement of a shown screen gets no gap', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, 'A.[[screen:T|c]]');
  const before = rig.streams.length;
  await deliver(rig, 'B.[[screen:T2|c|#0.4]] C.');
  assert.deepEqual(rig.streams.slice(before).flatMap(stream => stream.log.filter(item => item.gap !== undefined)), [], 'a shown screen: a swap is quick');
});

test('share gap: a second screen tag in one reply is a replacement unless a stop came between', async () => {
  const twice = await shareRig('One.[[screen:A|a|#6]] Two.[[screen:B|b|#0.4]] Three.');
  assert.deepEqual(gapsOf(twice), [6000]);
  const stopped = await shareRig('One.[[screen:A|a|#6]] Two.[[stop]] Three.[[screen:B|b|#7]] Four.');
  assert.deepEqual(gapsOf(stopped), [6000, 7000]);
});

test('share gap: a screen already shown before the reply is judged at the time the item is read', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, 'A.[[screen:T|c]]');
  const before = rig.streams.length;
  await deliver(rig, 'B.[[stop]] C.[[screen:T3|c|#5]] D.');
  assert.deepEqual(rig.streams.slice(before).flatMap(stream => stream.log.filter(item => item.gap !== undefined)), [{ gap: 5000 }]);
});

test('share gap: a screen tag before any text gives the gap first', async () => {
  const rig = await shareRig('[[screen:Doc|Body.|#6]]Welcome.');
  const log = rig.streams[1].log;
  assert.deepEqual(gapsOf(rig), [6000]);
  assert(log.findIndex(item => item.gap !== undefined) <= log.findIndex(item => item.text === 'Welcome.'));
});

test('share gap: the screen control is delivered once, when playback reaches the end of the last word before the tag', async () => {
  const rig = await shareRig();
  rig.h.playback('utt2', 'position', 2300);
  await flush();
  assert.equal(rig.of('screen').length, 0, 'not before the word ends');
  rig.h.playback('utt2', 'position', 2400);
  rig.h.playback('utt2', 'position', 2500);
  await flush();
  assert.equal(rig.of('screen').length, 1);
});

test('share gap: a pad control after the tag goes up with the screen, not after the silence, and nothing is paused', async () => {
  // The words after the tag are timed with the 6 s silence included.
  const silent = [...REPLY_WORDS.slice(0, 8), { word: 'What', startMs: 8400, endMs: 8700 }, { word: 'was', startMs: 8700, endMs: 8900 }, { word: 'hard?', startMs: 8900, endMs: 9300 }];
  const rig = await shareRig('Tell me about the design.[[screen:Doc|Body text.|#6]] What was hard?[[pad-open:go]]', {}, silent);
  rig.h.playback('utt2', 'position', 2400);
  await flush();
  assert.equal(rig.of('screen').length, 1);
  assert.equal(rig.of('pad').length, 1, 'the pad comes with the problem it belongs to');
  rig.h.playback('utt2', 'position', 9400);
  await flush();
  assert.equal(rig.of('pad').length, 1, 'once');
  assert.equal(rig.opsOf('pause').length + rig.opsOf('resume').length, 0, 'no pause or resume for a share');
});

test('share gap: a voice without a gap method still works', async () => {
  const rig = await shareRig(SHARE_MAIN, { gapVoice: false });
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Tell me about the design.' }, { text: 'What was hard?' }]);
  rig.h.playback('utt2', 'position', 2400);
  await flush();
  assert.equal(rig.of('screen').length, 1);
});

test('share gap: the overlay anchor counts characters from the start of the segment after the gap', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[screen:Doc|Body.|#6]]Hi.[[spk:B]]');
  assert.deepEqual(rig.streams[rig.streams.length - 1].log.filter(item => item.gap !== undefined), [{ gap: 6000 }]);
});

test('pause tag: gives gap(ms) in order with the text, on the direct and the queued path', async () => {
  const direct = await shareRig('One.[[pause:4]] Two.', {}, REPLY_WORDS);
  assert.deepEqual(direct.streams[1].log, [{ text: 'Right, got it.' }, { text: 'One.' }, { gap: 4000 }, { text: 'Two.' }]);
  const queued = makeRig({ createParser: screenParser });
  await greet(queued);
  await speculate(queued);
  queued.sessions.opener.answer('Right.');
  await flush();
  queued.sessions.main.answer('One.[[pause:4]] Two.');
  await flush();
  assert.deepEqual(queued.streams[1].log, []);
  await queued.clock.advance(600);
  assert.deepEqual(queued.streams[1].log.slice(-3), [{ text: 'One.' }, { gap: 4000 }, { text: 'Two.' }]);
});

test('pause tag: clamped to 300..15000 ms', async () => {
  assert.deepEqual(gapsOf(await shareRig('One.[[pause:0.01]] Two.')), [300]);
  assert.deepEqual(gapsOf(await shareRig('One.[[pause:120]] Two.')), [15000]);
});

test('pause tag: a filler between a pause and a screen gap gives sentence, gap, sentence, gap, sentence', async () => {
  const rig = await shareRig('Let me set this up.[[pause:4]] Nearly there.[[screen:Doc|Body.|#4]] Here it is.');
  assert.deepEqual(rig.streams[1].log.slice(1), [{ text: 'Let me set this up.' }, { gap: 4000 }, { text: 'Nearly there.' }, { gap: 4000 }, { text: 'Here it is.' }]);
});

test('pause tag: inside the segment of someone not on the call it is dropped', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[spk:Z]]Hi.[[pause:4]]More.[[spk:A]]Back.');
  assert.deepEqual(lastStream(rig).log.filter(item => item.gap !== undefined), []);
});

test('controls: text punctuation that differs from the timed words does not shift the position', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'Jack, I\'m here.[[screen:Doc|Body.|#6]] Next.', [
    { word: 'Jack', startMs: 0, endMs: 200 }, { word: 'I', startMs: 300, endMs: 400 }, { word: 'm', startMs: 400, endMs: 500 },
    { word: 'here', startMs: 600, endMs: 800 }, { word: 'Next', startMs: 1200, endMs: 1400 },
  ]);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 700);
  await flush();
  assert.equal(rig.of('screen').length, 0, 'not before "here" has ended');
  rig.h.playback('utt1', 'position', 850);
  await flush();
  assert.equal(rig.of('screen').length, 1, 'reached when "here" ends although the characters differ');
});

// ---- the share silence: interruptions, overlay anchors and stranded delivery tags -------------
// Stub parser: [[screen:T|c|#6]], [[spk:B]] and [[over:B:N:text]] (N is the parser's own afterChars) become items in order;
// plain text is split into sentences, a trailing piece without punctuation (a bare delivery tag) included.
function gapParser() {
  const run = text => {
    const items = [];
    for (const piece of text.split(/(\[\[[^\]]*\]\])/).filter(Boolean)) {
      const token = piece.match(/^\[\[([a-z]+):([^\]]*)\]\]$/);
      if (!token) { for (const sentence of piece.match(/[^.!?]+[.!?]|[^.!?]+$/g) ?? []) if (sentence.trim()) items.push({ sentence: sentence.trim() }); continue; }
      const [, kind, arg] = token;
      if (kind === 'screen') {
        const [title, content, delay] = arg.split('|');
        items.push({ screen: { title, content, delaySeconds: Number(delay.slice(1)) } });
      } else if (kind === 'spk') items.push({ speaker: arg });
      else if (kind === 'over') { const [id, after, ...rest] = arg.split(':'); items.push({ over: { speakerId: id, text: rest.join(':'), afterChars: Number(after) } }); }
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}
const lastStream = rig => rig.streams[rig.streams.length - 1];

test('share gap: an interruption during the silence is acted on at once, not after the first word that follows it', async () => {
  const later = [8400, 8700, 9000].map((startMs, index) => ({ word: ['What', 'was', 'hard?'][index], startMs, endMs: startMs + 280 }));
  const rig = await shareRig(SHARE_MAIN, {}, [...REPLY_WORDS.slice(0, 8), ...later]);
  rig.h.playback('utt2', 'position', 4000); // after "design." (2380 ms), 4.4 s before "What"
  await shortOverlap(rig, 'right');
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'the silence has no word to wait for');
});

test('share gap: inside a word the stop still waits for the word to end', async () => {
  const later = [8400, 8700, 9000].map((startMs, index) => ({ word: ['What', 'was', 'hard?'][index], startMs, endMs: startMs + 280 }));
  const rig = await shareRig(SHARE_MAIN, {}, [...REPLY_WORDS.slice(0, 8), ...later]);
  rig.h.playback('utt2', 'position', 100);
  await shortOverlap(rig, 'right');
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
});

test('share gap: a pause decided during the silence pauses at once at the current position', async () => {
  const later = [8400, 8700, 9000].map((startMs, index) => ({ word: ['What', 'was', 'hard?'][index], startMs, endMs: startMs + 280 }));
  const ear = makeEar({ floorBid: () => ({ decision: 'pause' }) });
  const rig = await shareRig(SHARE_MAIN, { ear }, [...REPLY_WORDS.slice(0, 8), ...later]);
  rig.h.playback('utt2', 'position', 4000);
  await floorBidOverlap(rig, 'right');
  assert.equal(rig.opsOf('pause').length, 1, 'paused without waiting for "What"');
});

const overAfter = async (reply, options = {}) => {
  const rig = panelRig({ createParser: gapParser, ...options });
  await panelGreeting(rig, reply);
  return lastStream(rig).overlays;
};

test('share gap: an <over> remark after the gap is anchored from the start of the segment after it', async () => {
  // The parser counts "Hello there." (11) and "Next bit." (7, the remark after 4 of them): 15 from the speaker tag.
  assert.deepEqual(await overAfter('Hello there.[[screen:Doc|Body.|#6]]Next bit.[[over:B:15:Hmm.]]'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 4 }]);
});

test('share gap: an <over> remark before the gap keeps the parser count', async () => {
  assert.deepEqual(await overAfter('Hello there.[[over:B:5:Hmm.]][[screen:Doc|Body.|#6]]Next bit.'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 5 }]);
});

test('share gap: an <over> remark after a speaker switch that follows a gap keeps the parser count', async () => {
  assert.deepEqual(await overAfter('Hello there.[[screen:Doc|Body.|#6]]Next bit.[[spk:B]]Over here.[[over:A:3:Hmm.]]'), [{ speakerId: 'A', text: 'Hmm.', afterChars: 3 }]);
});

test('share gap: a gap near a screen tag never takes the anchor below zero', async () => {
  assert.deepEqual(await overAfter('Hello there.[[screen:Doc|Body.|#6]]Next bit.[[over:B:2:Hmm.]]'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 0 }]);
});

const ownText = stream => stream.log.filter(item => item.text !== undefined).map(item => item.text);

test('share gap: a delivery tag just before the screen tag is spoken with the sentence after the silence', async () => {
  const rig = makeRig({ createParser: gapParser });
  await greet(rig);
  await toPlaying(rig, { main: 'Let me pull it up. [softly] [[screen:T|x|#8]] Can you see it?' });
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Let me pull it up.' }, { gap: 8000 }, { text: '[softly] Can you see it?' }]);
});

test('share gap: a delivery tag with no later text is never sent, and the transcript has no trace of it', async () => {
  const rig = makeRig({ createParser: gapParser });
  await greet(rig);
  await toPlaying(rig, { main: 'Let me pull it up. [softly]' });
  assert.deepEqual(ownText(rig.streams[1]), ['Right, got it.', 'Let me pull it up.']);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop().text, 'Right, got it. Let me pull it up.');
});

test('share gap: a held delivery tag is dropped when the speaker changes first', async () => {
  const rig = panelRig({ createParser: gapParser });
  await panelGreeting(rig, 'Hello there. [softly] [[spk:B]]And I am John.');
  assert.deepEqual(ownText(lastStream(rig)), ['Hello there.', 'And I am John.']);
});

test('share gap: a held tag is counted with the segment it is sent in, so a later remark keeps its anchor', async () => {
  // Parser: "Hello there."(11) + "[softly]"(8) + "Next bit."(8, remark after 4 of them) = 23; sent after the gap: "[softly] Next bit." so 8 + 4.
  assert.deepEqual(await overAfter('Hello there. [softly] [[screen:Doc|Body.|#6]]Next bit.[[over:B:23:Hmm.]]'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 12 }]);
});

// ---- prepared screens and dropped pauses -------------------------------------
function refParser() {
  const base = screenParser();
  const run = text => {
    const out = [];
    for (const piece of text.split(/(\[\[ref:[^\]]*\]\])/).filter(Boolean)) {
      const token = piece.match(/^\[\[ref:([^\]|]*)(?:\|#(.+))?\]\]$/);
      if (token) out.push({ screen: { ref: token[1], delaySeconds: token[2] ? Number(token[2]) : null } });
      else out.push(...base.push(piece).items);
    }
    return { chats: [], sentences: out.filter(item => item.sentence).map(item => item.sentence), items: out, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}
const PREPARED = { p1: { parts: [{ title: 'Task', content: 'Add two numbers.' }, { title: 'Follow-up', content: 'Now sort them.' }] } };
function preparedRig(extra = {}) {
  const options = [];
  const rig = makeRig({ createParser: refParser, formatTurn: option => { options.push(option); return '[turn]'; }, prepared: PREPARED, ...extra });
  rig.options = options;
  return rig;
}

test('prepared screen: a reference resolves to the part title and content; p1 is part 1 and p1.2 part 2', async () => {
  const rig = preparedRig();
  await greet(rig);
  await deliver(rig, 'Look.[[ref:p1]] Done.');
  assert.deepEqual(rig.engine.state().screen, { title: 'Task', content: 'Add two numbers.', speakerId: 'A' });
  await deliver(rig, 'Next.[[ref:p1.2|#1]]');
  assert.deepEqual(rig.engine.state().screen, { title: 'Follow-up', content: 'Now sort them.', speakerId: 'A' });
  assert.equal(rig.of('screen')[0].delayMs, 6000, 'first share keeps the default set-up time');
  assert.equal(rig.of('screen')[1].delayMs, 1000, 'a swap takes the delay the interviewer wrote');
});

test('prepared screen: showing the problem of a plan question counts that question asked, tag or not', async () => {
  // Call of 2026-11-22: a colleague shared the exercise for a topic card without an asked tag, and the review listed it unasked.
  const rig = preparedRig({ prepared: { p1: { question: 4, parts: PREPARED.p1.parts }, p2: { question: 0, parts: PREPARED.p1.parts } } });
  await greet(rig);
  await deliver(rig, 'Have a look.[[ref:p1]]');
  assert.deepEqual(rig.engine.state().askedQuestions, [4]);
  assert.deepEqual(rig.of('question-asked').map(event => event.number), [4]);
  await deliver(rig, 'Part two.[[ref:p1.2]]');
  await deliver(rig, 'Your own one.[[ref:p2]]');
  assert.deepEqual(rig.engine.state().askedQuestions, [4], 'once only, and never for the interviewer\'s own question');
});

test('prepared screen: the first share gives the setup gap in the voice log, like a written screen', async () => {
  const rig = preparedRig();
  await greet(rig);
  await toPlaying(rig, { main: 'Tell me about the design.[[ref:p1|#6]] What was hard?' });
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Tell me about the design.' }, { gap: 6000 }, { text: 'What was hard?' }]);
});

test('prepared screen: an unknown reference or part is dropped and reported once in the next message', async () => {
  const rig = preparedRig();
  await greet(rig);
  await deliver(rig, 'Look.[[ref:p9]][[ref:p1.7]] Done.');
  assert.equal(rig.engine.state().screen, null);
  assert.deepEqual(rig.of('screen'), []);
  await speak(rig, 'ok sure', 'u1');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  assert.deepEqual(rig.options.at(-1).unknownScreen, ['p9', 'p1.7']);
  rig.sessions.main.answer('Good.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback(`utt${rig.streams.length}`, 'started');
  rig.h.playback(`utt${rig.streams.length}`, 'finished', 1500);
  await flush();
  await speak(rig, 'and another thing', 'u2');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Mm-hm.');
  await flush();
  assert.equal(rig.options.at(-1).unknownScreen, undefined, 'told once');
});

test('prepared screen: the opener message never carries the unknown-screen note', async () => {
  const rig = preparedRig();
  await greet(rig);
  await deliver(rig, 'Look.[[ref:nope]] Done.');
  await speak(rig, 'ok sure', 'u1');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  const forOpener = rig.options.filter(option => option.unknownScreen === undefined);
  assert(forOpener.length >= 1);
  assert.equal(rig.options.filter(option => option.unknownScreen).length, 1, 'only the main message');
});

const pauseRig = async main => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await toPlaying(rig, { main });
  return rig;
};

test('pause: a pause between spoken words becomes one gap', async () => {
  const rig = await pauseRig('One.[[pause:4]] Two.');
  assert.deepEqual(gapsOf(rig), [4000]);
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'One.' }, { gap: 4000 }, { text: 'Two.' }]);
});

test('pause: one with no words before it in the reply is dropped', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, '[[pause:4]]Two.');
  // the opener reaction counts as spoken before it, so look at a main-only greeting instead
  const solo = makeRig({ createParser: screenParser });
  solo.engine.start({ greeting: true });
  await flush();
  solo.sessions.main.answer('[[pause:4]]Hello.');
  await flush();
  assert.deepEqual(gapsOf(solo, 0), []);
  assert.deepEqual(solo.streams[0].log, [{ text: 'Hello.' }]);
});

test('pause: one with nothing spoken after it by the end of the reply is never sent to the voice', async () => {
  const rig = await pauseRig('One.[[pause:4]]');
  assert.deepEqual(gapsOf(rig), []);
  const queued = makeRig({ createParser: screenParser });
  await greet(queued);
  await speculate(queued);
  queued.sessions.opener.answer('Right.');
  await flush();
  queued.sessions.main.answer('One.[[pause:4]]');
  await flush();
  await queued.clock.advance(700);
  assert.deepEqual(gapsOf(queued), []);
});

test('pause: two pauses in a row keep the first only, and a pause before a speaker switch stays ahead of it', async () => {
  const rig = await pauseRig('One.[[pause:2]][[pause:5]] Two.');
  assert.deepEqual(gapsOf(rig), [2000]);
  const panel = panelRig({ createParser: screenParser });
  await panelGreeting(panel, 'Hello.[[pause:3]][[spk:B]]Hi.');
  const log = lastStream(panel).log;
  const at = log.findIndex(item => item.gap !== undefined);
  assert(at > 0, JSON.stringify(log));
  assert(log.findIndex(item => item.speaker === 'B') > at, 'the gap stays ahead of the switch');
});

// ---- the interviewer cutting into the candidate's live speech ---------------------------------
const LIVE = { cutInFirstMs: 3000, cutInEveryMs: 2000, cutInYieldMs: 2500 };
const STILL = '[The candidate is still speaking.';
const mainCalls = rig => rig.sessions.main.calls;

/** The candidate starts an answer by microphone and the first look is due 3000 ms later. */
async function liveAnswer(rig, text = 'So the first thing we did was move every job onto one queue') {
  rig.h.vad(true);
  rig.h.transcript(text, 'a', rig.clock.now(), false, rig.clock.now() + 500);
  await rig.clock.advance(3000);
  return text;
}

/** The look is answered with a cut-in whose audio arrives: it commits over the candidate's speech. */
async function cutInNow(rig, reply = 'Sorry to jump in, how many regions?') {
  rig.sessions.main.answer(reply);
  rig.streams.at(-1).audio(3200);
  await flush();
  return rig.streams.at(-1).utteranceId;
}

test('live cut-in: a long spoken answer gets a look from cutInFirstMs, then one every cutInEveryMs; <listen/> leaves no trace', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  rig.h.vad(true);
  rig.h.transcript('So the first thing we did', 'a', rig.clock.now(), false, rig.clock.now() + 500);
  await rig.clock.advance(2900);
  assert.equal(mainCalls(rig).length, 1, 'no look before cutInFirstMs');
  await rig.clock.advance(200);
  assert.equal(mainCalls(rig).length, 2);
  const look = mainCalls(rig)[1].message;
  assert(look.includes(STILL) && look.includes("Candidate: 'So the first thing we did'"), look);
  assert.equal(rig.sessions.opener.calls.length, 0, 'a look is never acknowledged first');
  assert(!look.includes('[voice:'), 'a look carries no tone note');
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert(!rig.engine.state().transcript.some(entry => entry.speaker === 'candidate'), 'listening leaves no transcript trace');
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.opsOf('play').length, 1, 'nothing is spoken: only the greeting played');
  rig.h.transcript('So the first thing we did was move every job', 'a', 0, false, rig.clock.now());
  await rig.clock.advance(1800);
  assert.equal(mainCalls(rig).length, 2, 'the next look comes cutInEveryMs after the last one');
  await rig.clock.advance(200);
  assert.equal(mainCalls(rig).length, 3);
  assert(mainCalls(rig)[2].message.includes('move every job'));
  rig.sessions.main.answer('<pass/>'); // a pass on a look is a listen
  await flush();
  assert(!rig.engine.state().transcript.some(entry => entry.speaker === 'candidate'));
});

test('live cut-in: no look without words, while a reply is being made, or when the answer is short', async () => {
  const quiet = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(quiet);
  quiet.h.vad(true); // a bare sound: no transcript yet
  await quiet.clock.advance(5000);
  assert.equal(mainCalls(quiet).length, 1, 'a turn must have real words before a look');
  quiet.h.transcript('So we moved the jobs', 'a', quiet.clock.now(), false, quiet.clock.now() + 400);
  await quiet.clock.advance(1000); // the look is already due: it goes out at the next retry
  assert.equal(mainCalls(quiet).length, 2);

  const short = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(short);
  await speak(short, 'I built a scheduler', 'a');
  await short.clock.advance(5000);
  assert(!mainCalls(short).some(call => call.message.includes(STILL)), 'a short answer is just answered');
});

test('live cut-in: a cut-in commits at once over the speech, the words so far become the cut-off entry and count as the answer', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE, createParser: askedParser });
  await greet(rig);
  // The interviewer asks (question 4); the candidate answers aloud at length.
  await askedReply(rig, '<asked n="4"/>Tell me about a scheduler you built.');
  rig.h.playback(rig.streams.at(-1).utteranceId, 'started');
  rig.h.playback(rig.streams.at(-1).utteranceId, 'finished', 1000);
  await flush();
  assert.deepEqual(rig.engine.state().askedQuestions, [4]);
  const first = 'It ran nightly jobs for the whole district and I wrote the retry logic and the alerting myself';
  rig.h.vad(true);
  const began = rig.clock.now();
  rig.h.transcript(first, 's1', began, false, began + 500);
  await rig.clock.advance(3000);
  const calls = mainCalls(rig).length;
  assert(mainCalls(rig).at(-1).message.includes(STILL));
  // Words kept arriving while the look was written.
  rig.h.transcript(`${first} over two quarters`, 's1', began, false, rig.clock.now());
  const id = await cutInNow(rig);
  assert.equal(mainCalls(rig).length, calls);
  assert(rig.opsOf('play').some(item => item.id === id), 'it plays at once although the candidate is speaking');
  assert.equal(rig.engine.state().phase, 'committed');
  const entries = rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate' && entry.text.includes('nightly'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, `${first} over two quarters`, 'recomputed at commit');
  assert.equal(entries[0].interrupted, true);
  assert.equal(entries[0].cutOffBy, 'interviewer');
  assert(entries[0].endMs >= entries[0].startMs);
  assert.deepEqual(rig.engine.state().answeredQuestions, [4], 'a cut-off answer is an answer');
  assert(!rig.opsOf('cancel').length, 'nothing is stopped');
});

test('live cut-in: trailing speech over the cut-in is never an interruption, is added to the entry and is not answered again', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'pause' }) });
  const rig = makeRig({ autoOpener: true, thresholds: LIVE, ear });
  await greet(rig);
  await liveAnswer(rig);
  const id = await cutInNow(rig);
  rig.h.playback(id, 'started');
  // A person cannot stop at once: they go on for a while, with new words and a breath in between.
  await rig.clock.advance(400);
  rig.h.transcript('So the first thing we did was move every job onto one queue and then', 'a', 0, false, rig.clock.now());
  rig.h.transcript('we split', 'b', rig.clock.now(), false, rig.clock.now() + 200);
  await rig.clock.advance(600);
  rig.h.vad(false);
  await rig.clock.advance(300);
  rig.h.vad(true); // a fresh onset still inside the window
  rig.h.transcript('the workers by region', 'c', rig.clock.now(), false, rig.clock.now() + 300);
  await rig.clock.advance(600);
  rig.h.vad(false);
  await rig.clock.advance(500);
  assert.equal(ear.calls.floorBid.length, 0, 'no floor bid against the cut-in');
  assert(!rig.opsOf('cancel').length && !rig.opsOf('pause').length, 'the cut-in is never stopped or paused');
  assert.equal(mainCalls(rig).length, 2, 'the end of the speech starts no turn');
  assert.equal(rig.of('interrupted').length, 0);
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'candidate' && item.cutOffBy === 'interviewer');
  assert.equal(entry.text, 'So the first thing we did was move every job onto one queue and then we split the workers by region', 'the trailing words are the entry\'s');
  rig.h.playback(id, 'finished', 3000);
  await flush();
  await rig.clock.advance(5000);
  assert.equal(mainCalls(rig).length, 2, 'the trailing words are not answered again');
  assert.equal(rig.engine.state().transcript.filter(item => item.speaker === 'candidate').length, 1);
  // The next answer starts clean.
  await speak(rig, 'There were three regions', 'n');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  const next = mainCalls(rig).at(-1).message;
  assert(next.includes("Candidate: 'There were three regions'") && !next.includes('split'), next);
});

test('live cut-in: speech that goes on without a break past the window is an ordinary overlap, measured from the window\'s end', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'continue' }) });
  const rig = makeRig({ autoOpener: true, thresholds: LIVE, ear });
  await greet(rig);
  await liveAnswer(rig);
  const id = await cutInNow(rig);
  rig.h.playback(id, 'started');
  await rig.clock.advance(2400);
  assert(!rig.opsOf('cancel').length && ear.calls.floorBid.length === 0, 'speech inside the window is ignored whatever its length');
  await rig.clock.advance(100); // the window ends with the candidate still speaking
  rig.h.transcript('and one more point', 'late', rig.clock.now() + 50, false, rig.clock.now() + 400);
  await rig.clock.advance(300); // 300 ms after the window ends: floor bid asked at 250
  assert.equal(ear.calls.floorBid.length, 1);
  assert.equal(ear.calls.floorBid[0].overlapStartMs, rig.clock.now() - 300 - HELPER_OFFSET, 'the overlap starts where the window ended');
  await rig.clock.advance(500); // 800 ms after the window ends, past interruptMs and with words: stopped
  assert(rig.opsOf('cancel').some(item => item.id === id), 'the existing rules now apply');
});

test('live cut-in: a fresh onset after the window is judged by the existing rules', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  await liveAnswer(rig);
  const id = await cutInNow(rig);
  rig.h.playback(id, 'started');
  await rig.clock.advance(300);
  rig.h.vad(false); // the trailing speech stops quickly
  await rig.clock.advance(2500);
  assert(!rig.opsOf('cancel').length);
  rig.h.vad(true);
  rig.h.transcript('wait no actually it was five regions', 'z', rig.clock.now(), false, rig.clock.now() + 600);
  await flush();
  assert(rig.opsOf('cancel').some(item => item.id === id), 'more than interruptWords words: the interviewer stops, as for any reply');
});

test('live cut-in: a normal reply still stops on the same overlap', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Nice.');
  await flush();
  rig.sessions.main.answer('Tell me how it handled retries in the end.');
  rig.streams.at(-1).audio(3200);
  await rig.clock.advance(1200);
  const id = rig.streams.at(-1).utteranceId;
  rig.h.playback(id, 'started');
  rig.h.vad(true);
  rig.h.transcript('actually hold on a second', 'o', rig.clock.now(), false, rig.clock.now() + 500);
  await flush();
  assert(rig.opsOf('cancel').some(item => item.id === id));
});

test('live cut-in: a look is dropped silently when the candidate stops, and the whole answer goes the normal way', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  const text = await liveAnswer(rig);
  const look = mainCalls(rig)[1];
  rig.h.transcript(`${text} and that was it`, 'a', 0, false, rig.clock.now());
  rig.h.vad(false);
  await flush();
  assert(look.signal.aborted, 'the look is aborted');
  assert(rig.of('discarded').some(event => event.reason === 'look-dropped'));
  assert(!rig.opsOf('play').some(item => item.id === rig.streams[1].utteranceId), 'nothing of it is spoken');
  await rig.clock.advance(600);
  assert.equal(mainCalls(rig).length, 3, 'the end of the turn runs on the whole answer');
  const message = mainCalls(rig)[2].message;
  assert(!message.includes(STILL) && message.includes('and that was it'), message);
  assert(message.includes('Your previous reply was not spoken'));
});

test('live cut-in: a look that began in a pause is dropped when the pause reaches the speculation point', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  rig.h.vad(true);
  rig.h.transcript('So the first thing we did was move every job', 'a', rig.clock.now(), false, rig.clock.now() + 500);
  await rig.clock.advance(2900);
  rig.h.vad(false);
  await rig.clock.advance(150); // look due, 150 ms into a pause shorter than speculateMs
  assert.equal(mainCalls(rig).length, 2);
  assert(mainCalls(rig)[1].message.includes(STILL));
  await rig.clock.advance(500);
  assert(rig.of('discarded').some(event => event.reason === 'look-dropped'));
  assert.equal(rig.sessions.opener.calls.length, 1, 'the ordinary turn took over');
  assert(rig.sessions.opener.calls[0].message.includes('move every job'));
  assert.equal(rig.engine.state().phase, 'speculating');
});

test('live cut-in: the candidate going on talking does not discard the look', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  rig.h.vad(true);
  rig.h.transcript('So the first thing we did was move every job', 'a', rig.clock.now(), false, rig.clock.now() + 500);
  await rig.clock.advance(2900);
  rig.h.vad(false);
  await rig.clock.advance(150);
  rig.h.vad(true); // keeps talking while the look is being written
  await flush();
  assert(!rig.of('discarded').length);
  const id = await cutInNow(rig);
  assert(rig.opsOf('play').some(item => item.id === id));
  assert.equal(rig.of('discarded').length, 0);
});

test('live cut-in: a pause drops the look; hanging up during a look ends the call cleanly', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  await liveAnswer(rig);
  rig.engine.setPaused(true);
  await flush();
  assert(rig.of('discarded').some(event => event.reason === 'paused'));
  rig.streams.at(-1).audio(3200);
  await flush();
  assert(!rig.opsOf('play').some(item => item.id === rig.streams.at(-1).utteranceId), 'a dropped look never speaks');
  assert(!rig.engine.state().transcript.some(entry => entry.speaker === 'candidate'));
  rig.engine.setPaused(false);
  await rig.clock.advance(20000);
  assert(!rig.engine.state().transcript.some(entry => entry.cutOffBy));

  const hang = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(hang);
  await liveAnswer(hang);
  hang.engine.hangUp();
  await flush();
  assert.equal(hang.engine.state().phase, 'ended');
  hang.streams.at(-1).audio(3200);
  await hang.clock.advance(20000);
  assert.equal(hang.engine.state().phase, 'ended');
  assert(!hang.engine.state().transcript.some(entry => entry.cutOffBy));
});

test('live cut-in: words said after a short cut-in has finished are a new answer, never added to the cut-off entry', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  await liveAnswer(rig);
  const id = await cutInNow(rig, 'Go on.');
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 600); // a very short cut-in, over well inside the window
  await flush();
  rig.h.transcript('and then we split the workers', 'b', rig.clock.now(), false, rig.clock.now() + 300);
  await rig.clock.advance(2600); // past where the window would have ended
  rig.h.transcript('by region', 'c', rig.clock.now(), false, rig.clock.now() + 300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the answer to the cut-in is answered as a turn');
  const message = rig.sessions.opener.calls[0].message;
  assert(message.includes("Candidate: 'and then we split the workers by region'"), message);
  const entry = rig.engine.state().transcript.find(item => item.cutOffBy === 'interviewer');
  assert(!entry.text.includes('split the workers'), 'the cut-off entry keeps only what was said before the cut-in ended');
});

test('live cut-in: an answer that starts and ends while the window would still run is answered, once', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  await liveAnswer(rig);
  const id = await cutInNow(rig, 'Go on.');
  rig.h.playback(id, 'started');
  rig.h.vad(false); // the candidate stopped for the cut-in
  rig.h.playback(id, 'finished', 600);
  await flush();
  rig.h.vad(true);
  rig.h.transcript('three regions', 'b', rig.clock.now(), false, rig.clock.now() + 300);
  await rig.clock.advance(400);
  rig.h.vad(false); // done before the old window end
  await rig.clock.advance(3000);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the reply to the cut-in is answered');
  assert(rig.sessions.opener.calls[0].message.includes("Candidate: 'three regions'"));
  rig.sessions.main.answer('Three, got it.');
  rig.streams.at(-1).audio(3200);
  await flush();
  await rig.clock.advance(1500);
  const entries = rig.engine.state().transcript.filter(item => item.speaker === 'candidate');
  assert.equal(entries.filter(item => item.text.includes('three regions')).length, 1, 'never twice in the transcript');
  assert(!entries.find(item => item.cutOffBy === 'interviewer').text.includes('three regions'));
});

// ---- the watcher: a fast session decides when the interviewer cuts into live speech ------------------------------
const WATCH = { cutInFirstMs: 3000, watchEveryMs: 1000, watchTimeoutMs: 500, cutInHoldMs: 800, cutInStaleWords: 3, cutInStaleMs: 0, cutInStaleHardWords: 1000, cutInYieldMs: 2500 };
// The prompt module's own formatting and parsing are tested there: the engine is given plain seams that show what it passed.
const watchFormat = options => JSON.stringify(options);
const watchParse = text => {
  const found = /^cut:(\w):([\w-]+)(?::([\w-]+))?$/u.exec(String(text ?? '').trim());
  return found ? { decision: 'cut-in', who: found[1], reason: found[2], when: found[3] === 'sentence-end' ? 'sentence-end' : 'now' } : { decision: 'listen', who: null, reason: null };
};
const watchRig = (options = {}) => makeRig({ autoOpener: true, watcher: true, formatWatch: watchFormat, parseWatch: watchParse, ...options, thresholds: { ...WATCH, ...options.thresholds } });
const watchCalls = rig => rig.sessions.watcher.calls;
const watchSent = (rig, index = watchCalls(rig).length - 1) => JSON.parse(watchCalls(rig)[index].message);
/** The watcher answers a call (the last by default) with this text. */
async function watchSays(rig, text, index = watchCalls(rig).length - 1) {
  const call = watchCalls(rig)[index];
  call.settled = true;
  call.resolve({ text });
  await flush();
}
/** The candidate starts a long answer by microphone: the first check is due 3000 ms later. */
async function watchedAnswer(rig, text = 'So the first thing we did was move every job onto one queue') {
  rig.h.vad(true);
  rig.h.transcript(text, 'a', rig.clock.now(), false, rig.clock.now() + 500);
  return text;
}

test('watcher: the first check comes at cutInFirstMs into the answer and carries the question, the answer so far and the plan number', async () => {
  const rig = watchRig({ createParser: askedParser });
  await greet(rig);
  await askedReply(rig, '<asked n="4"/>Tell me about a scheduler you built.');
  rig.h.playback(rig.streams.at(-1).utteranceId, 'started');
  rig.h.playback(rig.streams.at(-1).utteranceId, 'finished', 1000);
  await flush();
  const calls = mainCalls(rig).length;
  await watchedAnswer(rig, 'We began with the queue. Then we moved every job onto it');
  await rig.clock.advance(2900);
  assert.equal(watchCalls(rig).length, 0, 'no check before cutInFirstMs');
  await rig.clock.advance(200);
  assert.equal(watchCalls(rig).length, 1);
  const sent = watchSent(rig);
  assert.equal(sent.questionText, 'Tell me about a scheduler you built.');
  assert.equal(sent.questionNumber, 4);
  assert.equal(sent.askedBy, 'A');
  assert.equal(sent.answerText, 'We began with the queue. Then we moved every job onto it');
  assert.equal(sent.mostRecent, 'Then we moved every job onto it');
  assert(sent.answerMs >= 3000 && sent.answerMs < 3300, String(sent.answerMs));
  assert(sent.elapsedMs >= 3000);
  assert.equal(mainCalls(rig).length, calls, 'the main session is not asked yet: the timed looks are replaced');
});

test('watcher: with the pad open it sees the code, sent again only when it changed since its last look', async () => {
  const rig = watchRig({ createParser: screenParser, thresholds: { watchTimeoutMs: 5000 } });
  await greet(rig);
  await rig.clock.advance(3000);
  await watchedAnswer(rig, 'Here is my plan');
  await rig.clock.advance(3100);
  assert.equal(watchSent(rig).padText, undefined, 'no pad, no code');
  await watchSays(rig, 'listen');
  rig.h.vad(false);
  await deliver(rig, 'Write it in the pad.[[pad-open:go]]');
  assert.equal(rig.engine.state().pad.open, true);
  rig.engine.setPadText('func f() {}');
  const before = watchCalls(rig).length;
  await watchedAnswer(rig, 'So I start with the function signature and then');
  await rig.clock.advance(3100);
  assert.equal(watchCalls(rig).length, before + 1);
  assert.equal(watchSent(rig).padText, 'func f() {}', 'the watcher sees the code being written while the candidate talks');
  await watchSays(rig, 'listen');
  await rig.clock.advance(1100);
  assert.equal(watchCalls(rig).length, before + 2);
  assert.equal(watchSent(rig).padText, undefined, 'unchanged code is not sent again');
  await watchSays(rig, 'listen');
  rig.engine.setPadText('func f() { return 1 }');
  await rig.clock.advance(1100);
  assert.equal(watchSent(rig).padText, 'func f() { return 1 }', 'changed code is');
});

test('watcher: a line after a plan question that tags nothing is no plan question; the interviewer\'s own question 0 is one', async () => {
  // Call of 2026-11-22: every line after the exercise went to the watcher as "plan question 19".
  const rig = watchRig({ createParser: askedParser, thresholds: { watchTimeoutMs: 5000 } });
  await greet(rig);
  const ask = async (text, word) => {
    await askedReply(rig, text);
    rig.h.playback(rig.streams.at(-1).utteranceId, 'started');
    rig.h.playback(rig.streams.at(-1).utteranceId, 'finished', 1000);
    await flush();
    await watchedAnswer(rig, `${word} is what we chose for the queue`);
    await rig.clock.advance(3100);
    const sent = watchSent(rig);
    await watchSays(rig, 'listen');
    rig.h.vad(false);
    return sent;
  };
  const first = await ask('<asked n="4"/>Tell me about a scheduler you built.', 'Kafka');
  assert.equal(first.questionNumber, 4);
  assert.equal(first.lastPlanNumber, undefined);
  const follow = await ask('Why that queue?', 'Throughput');
  assert.equal(follow.questionNumber, null, 'a follow-up is not plan question 4');
  assert.equal(follow.lastPlanNumber, 4);
  const own = await ask('<asked n="0"/>Different gear: how would you red-team it?', 'Coverage');
  assert.equal(own.questionNumber, 0, 'the interviewer\'s own question has its own number and time');
});

test('watcher: a long answer with no sentence end falls back to the last words said', async () => {
  const rig = watchRig();
  await greet(rig);
  const words = Array.from({ length: 40 }, (_, index) => `w${index}`).join(' ');
  await watchedAnswer(rig, words);
  await rig.clock.advance(3100);
  assert.equal(watchSent(rig).mostRecent, Array.from({ length: 20 }, (_, index) => `w${index + 20}`).join(' '));
});

test('watcher: one check at a time, at least one every watchEveryMs while speaking, and listen does nothing', async () => {
  const rig = watchRig({ thresholds: { watchTimeoutMs: 5000 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  assert.equal(watchCalls(rig).length, 1);
  await rig.clock.advance(4000);
  assert.equal(watchCalls(rig).length, 1, 'never two at once: the next waits for the answer');
  await watchSays(rig, '<listen/>');
  await rig.clock.advance(0);
  assert.equal(watchCalls(rig).length, 2, 'the periodic check is overdue: it starts as soon as the last one returns');
  assert.equal(rig.sessions.watcher.calls[0].signal.aborted, false);
  await watchSays(rig, '<listen/>');
  assert.equal(watchCalls(rig).length, 2);
  await rig.clock.advance(900);
  assert.equal(watchCalls(rig).length, 2, 'the next is watchEveryMs after the last one started');
  await rig.clock.advance(200);
  assert.equal(watchCalls(rig).length, 3);
  await watchSays(rig, '<listen/>');
  assert.equal(mainCalls(rig).length, 1, 'a listen starts no look');
  assert.equal(rig.sessions.opener.calls.length, 0);
  assert(!rig.engine.state().transcript.some(entry => entry.speaker === 'candidate'));
  assert.equal(rig.of('watch').length, 3);
  assert(rig.of('watch').every(event => event.decision === 'listen' && event.who === null && event.reason === null));
});

test('watcher: a breath (a VAD end shorter than the speculation point) is checked at once, but not before cutInFirstMs', async () => {
  const rig = watchRig();
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(1000);
  rig.h.vad(false); // an early breath
  await rig.clock.advance(300);
  rig.h.vad(true);
  await flush();
  assert.equal(watchCalls(rig).length, 0, 'the first check is not before cutInFirstMs');
  await rig.clock.advance(2000);
  assert.equal(watchCalls(rig).length, 1);
  await watchSays(rig, '<listen/>');
  rig.h.transcript('So the first thing we did was move every job onto one queue and then', 'a', 0, false, rig.clock.now());
  await rig.clock.advance(100); // well inside watchEveryMs of the last check
  rig.h.vad(false);
  await flush();
  assert.equal(watchCalls(rig).length, 2, 'the breath starts a check without waiting for the periodic one');
  assert(watchSent(rig).answerText.endsWith('and then'), 'with the latest text at that instant');
  await watchSays(rig, '<listen/>');
  await rig.clock.advance(300);
  rig.h.vad(true);
  await rig.clock.advance(100);
  assert.equal(watchCalls(rig).length, 2);
});

test('watcher: a breath while a check is in flight starts the next one as soon as it returns', async () => {
  const rig = watchRig({ thresholds: { watchTimeoutMs: 5000 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  rig.h.vad(false);
  rig.h.vad(true);
  await flush();
  assert.equal(watchCalls(rig).length, 1, 'never two at once');
  await watchSays(rig, '<listen/>');
  assert.equal(watchCalls(rig).length, 2);
});

test('watcher: a yes starts the live look, with the last sentence heard and who would cut in and why, and the main session writes the cut-in', async () => {
  const seen = [];
  const rig = watchRig({ formatTurn: options => { seen.push(options); return formatTurnMessage(options); } });
  await greet(rig);
  await watchedAnswer(rig, 'We began with the queue. Then we moved every job onto it');
  await rig.clock.advance(3100);
  assert(!seen.some(options => options.cutInBy));
  await watchSays(rig, 'cut:A:probe');
  assert.equal(mainCalls(rig).length, 2);
  const look = seen.at(-1);
  assert.equal(look.stillSpeaking, true);
  assert.equal(look.candidateText, 'We began with the queue. Then we moved every job onto it');
  assert.equal(look.mostRecent, 'Then we moved every job onto it');
  assert.deepEqual(look.cutInBy, { id: 'A', reason: 'probe', when: 'now' });
  assert.equal(rig.sessions.opener.calls.length, 0, 'a look is never acknowledged first');
  assert.deepEqual(rig.of('watch').map(event => [event.decision, event.who, event.reason]), [['cut-in', 'A', 'probe']]);
  const id = await cutInNow(rig);
  assert(!rig.opsOf('play').some(item => item.id === id), 'the candidate is mid-sentence: it waits for the breath');
  rig.h.vad(false);
  assert(rig.opsOf('play').some(item => item.id === id), 'then plays');
});

test('watcher: a yes on a panel names the colleague who cuts in; a colleague who is not on the call falls back to who asked', async () => {
  const seen = [];
  const rig = panelRig({ autoOpener: true, watcher: true, formatWatch: watchFormat, parseWatch: watchParse, thresholds: WATCH, formatTurn: options => { seen.push(options); return formatTurnMessage(options); } });
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  assert.equal(watchSent(rig).askedBy, 'B', 'the last speaker of the question asked it');
  await watchSays(rig, 'cut:A:enough');
  assert.deepEqual(seen.at(-1).cutInBy, { id: 'A', name: 'Priya', reason: 'enough', when: 'now' });
  await cutInNow(rig, '<speaker id="A"/>Let me stop you there.');
  const other = panelRig({ autoOpener: true, watcher: true, formatWatch: watchFormat, parseWatch: watchParse, thresholds: WATCH, formatTurn: options => { seen.push(options); return formatTurnMessage(options); } });
  await panelGreeting(other);
  other.h.playback('utt1', 'started');
  other.h.playback('utt1', 'finished', 1500);
  await flush();
  await watchedAnswer(other);
  await other.clock.advance(3100);
  await watchSays(other, 'cut:C:probe'); // Mei has not joined
  assert.deepEqual(seen.at(-1).cutInBy, { id: 'B', name: 'John', reason: 'probe', when: 'now' });
});

test('watcher: a sentence-end cut-in on live speech waits through a breath mid-sentence and lands when a final ends the sentence', async () => {
  const rig = watchRig({ thresholds: { cutInStaleWords: 50 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe:sentence-end');
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  assert.deepEqual(rig.of('cut-in').map(event => [event.state, event.until, event.when]), [['held', 'sentence-end', 'sentence-end']]);
  rig.h.vad(false); // a breath with the sentence still going: "...onto one queue"
  await flush();
  assert(!rig.opsOf('play').some(item => item.id === id), 'a mid-sentence breath does not release it');
  await rig.clock.advance(200);
  rig.h.vad(true);
  rig.h.transcript('So the first thing we did was move every job onto one queue and shard it.', 'a', rig.clock.now() - 3500, true, rig.clock.now());
  await flush();
  assert(rig.opsOf('play').some(item => item.id === id), 'the sentence ended: it comes in');
  assert(rig.of('cut-in').some(event => event.state === 'committed'));
});

test('watcher: a sentence-end cut-in on live speech that hears no sentence end in time comes in at the next breath', async () => {
  const rig = watchRig({ thresholds: { cutInStaleWords: 50, cutInSentenceMaxMs: 2000 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe:sentence-end');
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  await rig.clock.advance(2100);
  assert(!rig.opsOf('play').some(item => item.id === id), 'still talking: it waits for a breath');
  rig.h.vad(false);
  await flush();
  assert(rig.opsOf('play').some(item => item.id === id), 'the next breath');
});

test('watcher: a cut-in written while the candidate is mid-sentence waits for the next breath', async () => {
  const rig = watchRig({ thresholds: { cutInStaleWords: 50 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe');
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  assert(!rig.opsOf('play').some(item => item.id === id), 'held: the candidate is mid-sentence');
  assert.deepEqual(rig.of('cut-in').map(event => event.state), ['held']);
  await rig.clock.advance(400);
  assert(!rig.opsOf('play').some(item => item.id === id));
  rig.h.vad(false); // the breath
  assert(rig.opsOf('play').some(item => item.id === id), 'it goes out at the VAD end');
  assert.deepEqual(rig.of('cut-in').map(event => event.state), ['held', 'committed']);
  const committed = rig.of('cut-in').at(-1);
  assert.equal(committed.who, 'A');
  assert.equal(committed.reason, 'probe');
  assert(committed.heldMs >= 400 && committed.heldMs < 800, String(committed.heldMs));
  assert.equal(rig.engine.state().phase, 'committed');
  await rig.clock.advance(5);
  assert(!rig.of('discarded').length, 'the breath did not drop the look');
});

test('watcher: a cut-in held for cutInHoldMs commits if the words said meanwhile are few', async () => {
  const rig = watchRig({ thresholds: { cutInStaleWords: 5 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:long');
  rig.sessions.main.answer('That is plenty, thanks.');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  await rig.clock.advance(700);
  assert(!rig.opsOf('play').some(item => item.id === id));
  rig.h.transcript('So the first thing we did was move every job onto one queue and so', 'a', 0, false, rig.clock.now()); // two new words
  await rig.clock.advance(100);
  assert(rig.opsOf('play').some(item => item.id === id), 'the hold ends at cutInHoldMs; two new words are not stale');
  assert.equal(rig.of('cut-in').at(-1).wordsSinceSnapshot, 2);
});

test('watcher: a cut-in about something said sentences ago is dropped silently and the watcher is asked again at once', async () => {
  const rig = watchRig();
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe');
  assert.equal(watchCalls(rig).length, 1);
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  rig.h.transcript('So the first thing we did was move every job onto one queue and then we split the workers by region', 'a', 0, false, rig.clock.now());
  await rig.clock.advance(800); // the hold ends: more than cutInStaleWords words have been said since the look began
  assert(!rig.opsOf('play').some(item => item.id === id), 'never spoken');
  assert(rig.of('discarded').some(event => event.reason === 'stale-cut-in'));
  assert.deepEqual(rig.of('cut-in').map(event => event.state), ['held', 'stale']);
  assert(rig.of('cut-in').at(-1).wordsSinceSnapshot > 3);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(watchCalls(rig).length, 2, 'asked again at once');
  assert(watchSent(rig).answerText.includes('split the workers by region'), 'about what was said last');
  assert(!rig.engine.state().transcript.some(entry => entry.speaker === 'candidate'), 'nothing of the dropped cut-in is kept');
  await watchSays(rig, 'cut:A:probe');
  rig.sessions.main.answer('And how did you split them?');
  rig.streams.at(-1).audio(3200);
  await flush();
  await rig.clock.advance(800);
  assert(rig.opsOf('play').some(item => item.id === rig.streams.at(-1).utteranceId), 'the fresh cut-in is not stale and plays');
  assert(mainCalls(rig).at(-1).message.includes('Your previous reply was not spoken'), 'the main session is told the dropped line never reached the candidate');
});

test('watcher: when the main declines a cut-in the watcher backs off, is told, and the not-spoken note is not repeated', async () => {
  const rig = watchRig({ thresholds: { watchVetoBackoffMs: 6000 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe');
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert(rig.of('discarded').some(event => event.reason === 'listen'));
  const checks = watchCalls(rig).length;
  await rig.clock.advance(4000);
  assert.equal(watchCalls(rig).length, checks, 'no new check inside the back-off, though watchEveryMs passed');
  await rig.clock.advance(2500);
  assert.equal(watchCalls(rig).length, checks + 1, 'the next check comes after the back-off');
  assert.deepEqual({ ...watchSent(rig).declined, agoMs: undefined }, { reason: 'probe', agoMs: undefined, count: 1 }, 'the watcher is told the cut-in was declined');
  await watchSays(rig, 'cut:A:probe');
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert(!mainCalls(rig).at(-1).message.includes('not spoken'), 'a plain listen never makes the main be told a reply was lost');
});

test('watcher: a cut-in is stale by time as well as words, so a fast voice is not dropped during the main\'s first sentence', async () => {
  const rig = watchRig({ thresholds: { cutInStaleWords: 3, cutInStaleMs: 5000, cutInStaleHardWords: 1000 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe');
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  rig.h.transcript('So the first thing we did was move every job onto one queue and then we split the workers by region', 'a', 0, false, rig.clock.now());
  await rig.clock.advance(800);
  assert(rig.opsOf('play').some(item => item.id === id), 'many words but little time: not stale');
  assert(!rig.of('discarded').some(event => event.reason === 'stale-cut-in'));
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'candidate');
  assert.equal(entry.cutInReason, 'probe');
  assert.equal(entry.cutWhileSpeaking, true);
});

test('watcher: a stale cut-in found at the breath is dropped and the breath is checked', async () => {
  const rig = watchRig();
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe');
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  rig.h.transcript('So the first thing we did was move every job onto one queue and then we split the workers by region', 'a', 0, false, rig.clock.now());
  await rig.clock.advance(100);
  rig.h.vad(false);
  await flush();
  assert(rig.of('discarded').some(event => event.reason === 'stale-cut-in'));
  assert.equal(watchCalls(rig).length, 2);
});

test('watcher: a timeout counts as listen and the next check follows; a crash restarts the watcher session', async () => {
  const rig = watchRig();
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  const first = watchCalls(rig)[0];
  await rig.clock.advance(500);
  assert(first.signal.aborted, 'aborted at watchTimeoutMs');
  assert.equal(rig.of('watch').length, 1);
  assert.equal(rig.of('watch')[0].decision, 'listen');
  assert.equal(rig.restarts.length, 0, 'a timeout needs no restart');
  assert.equal(mainCalls(rig).length, 1);
  await rig.clock.advance(600);
  assert.equal(watchCalls(rig).length, 1, 'a timed-out check is not chained straight into another: the next waits a full watchEveryMs');
  await rig.clock.advance(500);
  assert.equal(watchCalls(rig).length, 2, 'the next check follows');
  rig.sessions.watcher.fail();
  await flush();
  assert.deepEqual(rig.restarts.map(item => item.kind), ['watcher']);
  assert.equal(rig.of('watch').at(-1).decision, 'listen');
  assert(rig.of('session-restart').some(event => event.kind === 'watcher'));
  await rig.clock.advance(1100);
  assert(rig.sessions.watcher.calls.length >= 1 && rig.restarts.length === 1, 'the fresh session takes the next check');
});

test('watcher: a result that arrives after the answer is over is dropped; a pause drops the check and stops the checks', async () => {
  const rig = watchRig({ thresholds: { watchTimeoutMs: 5000 } });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  rig.h.vad(false);
  await rig.clock.advance(700); // the pause reached the speculation point: the answer goes the normal way
  assert.equal(rig.sessions.opener.calls.length, 1);
  await watchSays(rig, 'cut:A:probe', 0);
  assert.equal(mainCalls(rig).length, 2, 'no look: only the greeting and the ordinary turn');
  assert(!mainCalls(rig).some(call => call.message.includes(STILL)));
  assert(rig.of('watch').at(-1).ignored === true);

  const paused = watchRig({ thresholds: { watchTimeoutMs: 5000 } });
  await greet(paused);
  await watchedAnswer(paused);
  await paused.clock.advance(3100);
  paused.engine.setPaused(true);
  await flush();
  assert(watchCalls(paused)[0].signal.aborted);
  await paused.clock.advance(10000);
  assert.equal(watchCalls(paused).length, 1, 'no checks while paused');
  paused.engine.setPaused(false);
  paused.h.vad(false);
  await paused.clock.advance(5000);
  assert.equal(watchCalls(paused).length, 1);
});

test('watcher: no checks while a reply is being made or played, nor after hang-up', async () => {
  const rig = watchRig();
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600); // the ordinary turn is being made
  assert(rig.engine.state().phase === 'speculating');
  await rig.clock.advance(10000);
  assert.equal(watchCalls(rig).length, 0, 'a short answer is just answered');

  const hang = watchRig({ thresholds: { watchTimeoutMs: 5000 } });
  await greet(hang);
  await watchedAnswer(hang);
  await hang.clock.advance(3100);
  hang.engine.hangUp();
  await flush();
  assert(watchCalls(hang)[0].signal.aborted);
  await hang.clock.advance(10000);
  assert.equal(watchCalls(hang).length, 1);
  assert.equal(hang.of('watch').length, 0, 'nothing recorded after the call ended');
});

test('watcher: without a watcher the timed looks run exactly as before', async () => {
  const rig = makeRig({ autoOpener: true, thresholds: LIVE });
  await greet(rig);
  await watchedAnswer(rig);
  await rig.clock.advance(3100);
  assert.equal(mainCalls(rig).length, 2);
  assert(mainCalls(rig)[1].message.includes(STILL));
  assert.equal(rig.of('watch').length, 0);
});

// ---- the typing halt survives the keys typed while the candidate gave way ---------------------------------------------
async function haltPadAndFloor(rig) {
  await greet(rig);
  await openPad(rig);
  rig.engine.setPadText('-- portable version:\n-- SELECT');
  await speak(rig, 'I will add that as a comment', 'c1');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Why row number and not rank?');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started'); // the pad changed under 2.5 s ago: the candidate stops typing to listen
  return id;
}
async function endFloorAndAnswer(rig, id, said) {
  rig.h.playback(id, 'finished', 1500);
  await flush();
  await rig.clock.advance(PAD_IDLE * 2);
  await speak(rig, said, 'c2');
  await rig.clock.advance(1800);
  return spokenTurns(rig).at(-1);
}

test('pad halted: keys typed while the candidate gives way (the end of the word) do not clear the note', async () => {
  const rig = padRig();
  const id = await haltPadAndFloor(rig);
  await rig.clock.advance(300);
  rig.engine.setPadText('-- portable version:\n-- SELECT db_'); // the word is finished after the floor event
  await rig.clock.advance(400);
  rig.engine.setPadText('-- portable version:\n-- SELECT db_name');
  const turn = await endFloorAndAnswer(rig, id, 'rank would keep ties, so two rows could come back for one database');
  assert.equal(turn.padHalted, true, JSON.stringify(turn));
  assert.equal(turn.padTyping, undefined);
});

test('pad halted: an edit after the grace window, and a pad that is back at it, clear the note', async () => {
  const rig = padRig();
  const id = await haltPadAndFloor(rig);
  await rig.clock.advance(5000);
  rig.engine.setPadText('-- portable version:\n-- SELECT db_name'); // well after the yield: they went back to it
  const turn = await endFloorAndAnswer(rig, id, 'rank would keep ties, so two rows could come back for one database');
  assert.equal(turn.padHalted, undefined, JSON.stringify(turn));
});

test('pad edit: the first change of a burst of typing is logged once, not every key', async () => {
  const rig = padRig();
  await greet(rig);
  await openPad(rig);
  const before = rig.of('pad-edit').length;
  for (const text of ['d', 'de', 'def', 'def t']) { rig.engine.setPadText(text); await rig.clock.advance(100); }
  assert.equal(rig.of('pad-edit').length, before + 1, 'one event for the burst');
  assert.equal(rig.of('pad-edit').at(-1).chars, 1);
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.padTypingMs);
  rig.engine.setPadText('def total');
  assert.equal(rig.of('pad-edit').length, before + 2, 'a new burst after a pause');
});

// ---- a sentence-end cut-in whose judged snapshot already ended a sentence ---------------------------------------------
const FINISHED = 'So the first thing we did was move every job onto one queue.';

test('watcher: a sentence-end cut-in whose judged text already ended a sentence is dropped when new speech has begun, and the watcher is asked again', async () => {
  const rig = watchRig({ thresholds: { cutInStaleWords: 50 } });
  await greet(rig);
  await watchedAnswer(rig, FINISHED);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe:sentence-end');
  rig.h.transcript(`${FINISHED} Then we split the workers`, 'a', 0, false, rig.clock.now()); // the next sentence has begun
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  assert(!rig.opsOf('play').some(item => item.id === id), 'never spoken');
  assert(!rig.of('cut-in').some(event => event.until === 'sentence-end'), 'no hold for the end of a different sentence');
  assert(rig.of('discarded').some(event => event.reason === 'stale-cut-in'));
  assert.deepEqual(rig.of('cut-in').map(event => [event.state, event.dropped]), [['stale', 'sentence-over']]);
  assert.equal(watchCalls(rig).length, 2, 'asked again at once');
});

test('watcher: a sentence-end cut-in whose judged text already ended a sentence is not held for a sentence end when speech has not resumed', async () => {
  const rig = watchRig({ thresholds: { cutInStaleWords: 50 } });
  await greet(rig);
  await watchedAnswer(rig, FINISHED);
  await rig.clock.advance(3100);
  await watchSays(rig, 'cut:A:probe:sentence-end');
  rig.h.vad(false); // the pause after the sentence
  await flush();
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  assert(rig.opsOf('play').some(item => item.id === id), 'comes in at once, in the pause');
  assert(!rig.of('cut-in').some(event => event.until === 'sentence-end'), 'no sentence hold');
  assert(rig.of('cut-in').some(event => event.state === 'committed'));
});

// ---- a bare reaction is not the question the watcher is shown ---------------------------------------------------------
async function reactionAfterPlanQuestion(rig, opener, main) {
  await greet(rig);
  await askedReply(rig, '<asked n="4"/>Tell me about a scheduler you built.');
  rig.h.playback(rig.streams.at(-1).utteranceId, 'started');
  rig.h.playback(rig.streams.at(-1).utteranceId, 'finished', 1000);
  await flush();
  await speak(rig, 'let me pull it up for you', 'r');
  await rig.clock.advance(600);
  rig.sessions.opener.answer(opener);
  await flush();
  if (main === '<listen/>') { rig.streams.at(-1).audio(400); await flush(); await rig.clock.advance(700); } // the reaction is already playing when the main reply comes
  rig.sessions.main.answer(main);
  await flush();
  if (main !== '<listen/>') { rig.streams.at(-1).audio(1000); await flush(); await rig.clock.advance(700); }
  rig.h.playback(rig.streams.at(-1).utteranceId, 'started');
  rig.h.playback(rig.streams.at(-1).utteranceId, 'finished', 1500);
  await flush();
  await watchedAnswer(rig, 'We began with the queue and then moved every job onto it');
  await rig.clock.advance(3100);
  return watchSent(rig);
}

test('watcher: a reaction that is all the interviewer said keeps the question before it, with its plan number', async () => {
  const rig = watchRig({ createParser: askedParser, autoOpener: false });
  const sent = await reactionAfterPlanQuestion(rig, 'Right, go ahead.', '<listen/>');
  assert(rig.engine.state().transcript.some(entry => entry.speaker === 'interviewer' && entry.text === 'Right, go ahead.'), 'the reaction was spoken');
  assert.equal(sent.questionText, 'Right. Tell me about a scheduler you built.', 'the plan question (with the reaction that went before it), not "Right, go ahead."');
  assert.equal(sent.questionNumber, 4);
  assert.equal(sent.askedBy, 'A');
});

test('watcher: a short real follow-up after a reaction still replaces the question', async () => {
  const rig = watchRig({ createParser: askedParser, autoOpener: false });
  const sent = await reactionAfterPlanQuestion(rig, 'Right.', 'And an empty sequence, len zero?');
  assert.equal(sent.questionText, 'And an empty sequence, len zero?');
  assert.equal(sent.questionNumber, null);
});

test('watcher: a short follow-up that is not a question, or a reaction that asks one, still replaces the question', async () => {
  const bare = watchRig({ createParser: askedParser, autoOpener: false });
  const sent = await reactionAfterPlanQuestion(bare, 'Right.', 'Go through the empty case');
  assert.equal(sent.questionText, 'Go through the empty case');
  const asking = watchRig({ createParser: askedParser, autoOpener: false });
  const other = await reactionAfterPlanQuestion(asking, 'Sorry, which one?', '<listen/>');
  assert.equal(other.questionText, 'Sorry, which one?');
});
