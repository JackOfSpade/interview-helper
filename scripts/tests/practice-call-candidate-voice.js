import assert from 'node:assert/strict';
import { askedParser, flush, greet, makeRig, speak } from './interview-practice-call-engine.js';
import { applyTags, splitSentences, candidateTagPrompt, createCandidateVoice, tagCandidateLine, wordsOf, CANDIDATE_VOICE_STAGE, DEFAULT_CANDIDATE_VOICE_GENDER } from '../../electron/practiceCall/candidateVoice.js';
import { careerWritingStageProfile } from '../../electron/ipc/careerWritingCore.js';
import { drawVoice } from '../../electron/practiceCall/eleven/voiceLibrary.js';
import { createPracticeVoiceStore, registerPracticeVoiceHandlers } from '../../electron/interviewApp/practiceVoiceSetting.js';
import { CUT_IN_FADE_MS, CUT_IN_OVERLAP_MS, fadeOutTail, firstSpeechSample, mixHeadInto } from '../../electron/practiceCall/audio/cutInMix.js';
import * as panelVoice from '../../electron/practiceCall/eleven/panelVoice.js';

// Synthetic data only: every name and sentence below is invented for the tests.

const cases = [];
const test = (name, run) => cases.push({ name: `practice call candidate voice: ${name}`, run });

/** A candidate voice the test drives: each open is one line, with audio, timed words and an end it settles. */
function fakeCandidateVoice() {
  const lines = [];
  return {
    lines,
    open({ utteranceId, text, signal }) {
      let resolveDone;
      let rejectDone;
      const line = { utteranceId, text, signal, cancelled: false };
      line.done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      line.done.catch(() => {});
      line.finish = () => resolveDone();
      line.fail = () => rejectDone(new Error('voice down'));
      lines.push(line);
      return {
        sampleRate: 24000,
        onAudio: callback => { line.audioCb = callback; },
        onWords: callback => { line.wordsCb = callback; },
        cancel: () => { line.cancelled = true; },
        done: line.done,
      };
    },
  };
}

// Words 300 ms apart, each 280 ms long: the gap between two words is a word boundary.
const timed = text => text.split(' ').map((word, index) => ({ word, startMs: index * 300, endMs: index * 300 + 280 }));

async function voicedRig(thresholds = {}) {
  const candidateVoice = fakeCandidateVoice();
  const rig = makeRig({ autoOpener: true, candidateVoice, thresholds });
  await greet(rig);
  return { rig, voice: candidateVoice };
}

/** The line has all its audio and words; the helper starts playing it. */
async function playLine(rig, line) {
  line.audioCb(Buffer.alloc(48000 * 4));
  line.wordsCb(timed(line.text));
  line.finish();
  await flush();
  rig.h.playback(line.utteranceId, 'started');
  await flush();
}

const lastMain = rig => rig.sessions.main.calls.at(-1).message;

test('a sent message is spoken in the candidate voice, then reaches the interviewer as a spoken line', async () => {
  const { rig, voice } = await voicedRig();
  const mainBefore = rig.sessions.main.calls.length;
  assert.equal(rig.engine.typed('I rebuilt the billing service in Go.'), true);
  await flush();
  assert.equal(voice.lines.length, 1);
  assert.equal(voice.lines[0].text, 'I rebuilt the billing service in Go.');
  assert.equal(rig.sessions.main.calls.length, mainBefore, 'the interviewer hears nothing until the line has been said');
  const id = voice.lines[0].utteranceId;
  assert(rig.ops.some(item => item.op === 'play' && item.id === id), 'the line plays through the call audio');
  await playLine(rig, voice.lines[0]);
  assert(rig.ops.some(item => item.op === 'end' && item.id === id));
  rig.h.playback(id, 'finished', 2100);
  await flush();
  assert.equal(rig.sessions.main.calls.length, mainBefore + 1);
  const message = lastMain(rig);
  assert(message.includes("Candidate: 'I rebuilt the billing service in Go.'"), message);
  assert(!message.includes('typed in chat'), 'the interviewer hears it, it does not read it');
  const captions = rig.of('caption').filter(item => item.speaker === 'candidate');
  assert.equal(captions.at(-1).final, true);
  rig.sessions.main.answer('Nice. What was the hardest part?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'candidate' && item.voiced);
  assert(entry, 'the transcript keeps the line');
  assert.equal(entry.channel, 'chat', 'a sent message stays out of the delivery measures');
  assert.equal(entry.text, 'I rebuilt the billing service in Go.');
});

test('the interviewer gets a look at a long line, listens on, then cuts in over the candidate voice', async () => {
  const { rig, voice } = await voicedRig({ cutInFirstMs: 1000, cutInEveryMs: 1000, cutInMinLeftMs: 0 });
  const text = 'So the first thing we did was move every job onto one queue and then we split the workers by region and after that';
  rig.engine.typed(text, { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await playLine(rig, line);
  const before = rig.sessions.main.calls.length;
  rig.h.playback(line.utteranceId, 'position', 1250);
  await flush();
  assert.equal(rig.sessions.main.calls.length, before + 1, 'a look at the line so far');
  const look = lastMain(rig);
  assert(look.includes('[The candidate is still speaking.'), look);
  assert(look.includes("Candidate: 'So the first thing'"), look);
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert(!rig.ops.some(item => item.op === 'cancel' && item.id === line.utteranceId), 'listening lets the candidate go on');
  rig.h.playback(line.utteranceId, 'position', 2450);
  await flush();
  assert.equal(rig.sessions.main.calls.length, before + 2, 'a second look');
  rig.sessions.main.answer('Sorry to jump in, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  // As when one interviewer cuts into another: the candidate voice stops at once and the interviewer starts
  // straight away, with what the candidate was about to say mixed under their first words.
  const interviewerId = rig.streams.at(-1).utteranceId;
  const cancelAt = rig.ops.findIndex(item => item.op === 'cancel' && item.id === line.utteranceId);
  const playAt = rig.ops.findIndex(item => item.op === 'play' && item.id === interviewerId);
  assert(cancelAt >= 0 && playAt > cancelAt, 'the candidate voice is cut and the interviewer plays at once');
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'candidate' && item.voiced);
  assert.equal(entry.interrupted, true);
  assert.equal(entry.cutOffBy, 'interviewer');
  // Heard: everything finished by 2450 ms plus the interviewer's leading silence (66 ms of silent audio here) and the 700 ms overlap.
  assert.equal(entry.text, 'So the first thing we did was move every job', 'the words heard, the overlap included');
  const cut = rig.events.find(event => event.type === 'candidate-voice' && event.state === 'cut');
  assert.deepEqual(cut.messages, [{ chatId: 'm1', heard: 'So the first thing we did was move every job' }], 'the chat entry is told where the line broke off');
  rig.h.playback(line.utteranceId, 'cancelled', 2450); // late helper report for a line already over: ignored
  await flush();
  assert.equal(rig.engine.state().transcript.filter(item => item.voiced).length, 1);
  // The rest of the line is dropped: once the interviewer finishes, the call waits for the candidate.
  rig.h.playback(interviewerId, 'started');
  rig.h.playback(interviewerId, 'finished', 2000);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(voice.lines.length, 1);
});

test('a look that is still being written when the line ends is dropped and the whole line goes to the interviewer', async () => {
  const { rig, voice } = await voicedRig({ cutInFirstMs: 500, cutInMinLeftMs: 0 });
  rig.engine.typed('We moved the jobs onto one queue and split the workers.');
  await flush();
  const line = voice.lines[0];
  await playLine(rig, line);
  rig.h.playback(line.utteranceId, 'position', 900);
  await flush();
  assert(lastMain(rig).includes('still speaking'));
  rig.h.playback(line.utteranceId, 'finished', 3000);
  await flush();
  const message = lastMain(rig);
  assert(!message.includes('still speaking'), message);
  assert(message.includes("Candidate: 'We moved the jobs onto one queue and split the workers.'"), message);
});

test('a message sent mid-line is spoken next; a voice that fails twice is lost, never passed on as text', async () => {
  const { rig, voice } = await voicedRig();
  rig.engine.typed('First answer.');
  await flush();
  rig.engine.typed('And a second thought.');
  await flush();
  assert.equal(voice.lines.length, 1, 'one line at a time');
  await playLine(rig, voice.lines[0]);
  rig.h.playback(voice.lines[0].utteranceId, 'finished', 900);
  await flush();
  assert.equal(voice.lines.length, 2);
  assert.equal(voice.lines[1].text, 'And a second thought.');
  const before = rig.sessions.main.calls.length;
  voice.lines[1].fail();
  await flush();
  assert.equal(voice.lines.length, 3, 'the line is tried once more');
  assert.equal(voice.lines[2].text, 'And a second thought.');
  assert.equal(rig.sessions.main.calls.length, before, 'nothing reaches the interviewer meanwhile');
  voice.lines[2].fail();
  await flush();
  assert(rig.of('error').some(item => item.code === 'candidate-voice-failed'), 'the candidate is told');
  const message = lastMain(rig);
  assert(message.includes("Candidate: 'First answer.'"), 'what was heard still reaches the interviewer');
  assert(!rig.sessions.main.calls.some(call => call.message.includes('second thought')), 'a sent message is never passed on as text');
});

test('a suggested answer practises a question exactly like the candidate\'s own words', async () => {
  const candidateVoice = fakeCandidateVoice();
  const rig = makeRig({ autoOpener: true, candidateVoice, createParser: askedParser });
  await greet(rig);
  const say = async (text, options) => {
    rig.engine.typed(text, options);
    await flush();
    const line = candidateVoice.lines.at(-1);
    await playLine(rig, line);
    rig.h.playback(line.utteranceId, 'finished', 5000);
    await flush();
  };
  const reply = async text => {
    rig.sessions.main.answer(text);
    const stream = rig.streams.at(-1);
    stream.audio(1000);
    await flush();
    rig.h.playback(stream.utteranceId, 'started');
    rig.h.playback(stream.utteranceId, 'finished', 1000);
    await flush();
  };
  await say('Hi, thanks for having me.');
  await reply('<asked n="3"/>Tell me about a scheduler you built.');
  assert.deepEqual(rig.engine.state().askedQuestions, [3]);
  const answer = 'It ran nightly jobs for the whole district and I wrote the retry logic and the alerting myself over two quarters';
  await say(answer, { generated: true });
  await reply('Okay, and how did you test it?');
  assert.equal(rig.engine.state().transcript.filter(item => item.voiced).at(-1).generated, true);
  assert(rig.sessions.main.calls.some(call => call.message.includes('nightly jobs')), 'the interviewer hears a suggestion like any answer');
  assert.deepEqual(rig.engine.state().answeredQuestions, [3], 'a suggested answer counts as the answer, like any other');
});

/** A fake ear for AI voice lines: every call is recorded, the note is per test. Both functions are optional in the engine. */
function voicedEar(note = () => 'warm and steady') {
  const calls = { prepared: [], noted: [] };
  return {
    calls,
    prepareVoiced: args => { calls.prepared.push(args); },
    voicedNote: async args => { calls.noted.push(args); return note(args); },
  };
}

async function earRig(ear, thresholds = {}) {
  const candidateVoice = fakeCandidateVoice();
  const rig = makeRig({ autoOpener: true, candidateVoice, ear, thresholds });
  await greet(rig);
  return { rig, voice: candidateVoice };
}

test('an AI voice line carries the ear\'s tone note like spoken words do, and the ear is told about the line', async () => {
  const ear = voicedEar();
  const { rig, voice } = await earRig(ear);
  const before = rig.sessions.main.calls.length;
  rig.engine.typed('I rebuilt the billing service in Go.');
  await flush();
  const line = voice.lines[0];
  await playLine(rig, line);
  assert.equal(ear.calls.prepared.length, 1, 'prepared once, when the voice is whole');
  assert.equal(ear.calls.prepared[0].id, line.utteranceId);
  assert.equal(ear.calls.prepared[0].sampleRate, 24000);
  assert.equal(ear.calls.prepared[0].pcm.length, 48000 * 4);
  assert.equal(ear.calls.prepared[0].wordCount, 7);
  assert.equal(ear.calls.noted.length, 0, 'the note is asked for when the line ends');
  rig.h.playback(line.utteranceId, 'finished', 4000);
  await flush();
  await rig.clock.advance(0);
  assert.equal(ear.calls.noted.length, 1);
  const noted = ear.calls.noted[0];
  assert.equal(noted.id, line.utteranceId);
  assert(noted.endMs >= noted.startMs);
  assert.equal(noted.heardMs, 4000, 'the whole line was heard');
  const main = rig.sessions.main.calls.at(-1).message;
  assert.equal(rig.sessions.main.calls.length, before + 1);
  assert(main.includes('[voice: warm and steady]'), main);
  assert(main.includes("Candidate: 'I rebuilt the billing service in Go.'"), main);
});

test('an AI voice line\'s note is waited for at most voicedNoteWaitMs; a late, failed or missing note means none', async () => {
  const late = voicedEar(() => new Promise(() => {}));
  const { rig, voice } = await earRig(late);
  const before = rig.sessions.main.calls.length;
  rig.engine.typed('First answer.');
  await flush();
  await playLine(rig, voice.lines[0]);
  rig.h.playback(voice.lines[0].utteranceId, 'finished', 900);
  await flush();
  assert.equal(rig.sessions.main.calls.length, before, 'the note is awaited');
  await rig.clock.advance(299);
  assert.equal(rig.sessions.main.calls.length, before);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, before + 1, 'after 300 ms the turn goes on without it');
  assert(!lastMain(rig).includes('[voice:'));

  const failing = voicedEar(() => { throw new Error('ear down'); });
  const second = await earRig(failing);
  second.rig.engine.typed('Another answer.');
  await flush();
  await playLine(second.rig, second.voice.lines[0]);
  second.rig.h.playback(second.voice.lines[0].utteranceId, 'finished', 900);
  await flush();
  assert(second.rig.sessions.main.calls.at(-1).message.includes("Candidate: 'Another answer.'"));
  assert(!second.rig.sessions.main.calls.at(-1).message.includes('[voice:'));

  const quick = voicedEar(() => null);
  const third = await earRig(quick);
  third.rig.engine.typed('A third answer.');
  await flush();
  await playLine(third.rig, third.voice.lines[0]);
  third.rig.h.playback(third.voice.lines[0].utteranceId, 'finished', 900);
  await flush();
  assert(!third.rig.sessions.main.calls.at(-1).message.includes('[voice:'), 'no note, no marker');
});

test('a cut AI voice line reports how much of it was heard, and the note of the last line goes with the turn', async () => {
  const ear = voicedEar(args => `heard ${args.heardMs} ms`);
  const { rig, voice } = await earRig(ear);
  rig.engine.typed('So the first thing we did was move every job onto one queue.');
  await flush();
  const line = voice.lines[0];
  await playLine(rig, line);
  rig.h.playback(line.utteranceId, 'cancelled', 1000);
  await flush();
  assert.equal(ear.calls.noted.length, 1);
  assert.equal(ear.calls.noted[0].heardMs, 1000);
  assert(lastMain(rig).includes('[voice: heard 1000 ms]'), lastMain(rig));
});

test('a line cut while its voice is still streaming is still handed to the ear, with the audio so far', async () => {
  const ear = voicedEar(args => `heard ${args.heardMs} ms`);
  const { rig, voice } = await earRig(ear);
  rig.engine.typed('So the first thing we did was move every job onto one queue.');
  await flush();
  const line = voice.lines[0];
  line.audioCb(Buffer.alloc(48000 * 2)); // half the line so far; the voice has not finished
  line.wordsCb(timed(line.text));
  await flush();
  rig.h.playback(line.utteranceId, 'started');
  await flush();
  assert.equal(ear.calls.prepared.length, 0, 'not yet: the voice is still streaming');
  rig.h.playback(line.utteranceId, 'cancelled', 1000);
  await flush();
  assert.equal(ear.calls.prepared.length, 1, 'prepared at the end from the audio received');
  assert.equal(ear.calls.prepared[0].pcm.length, 48000 * 2);
  assert.equal(ear.calls.noted.length, 1);
  line.finish();
  await flush();
  assert.equal(ear.calls.prepared.length, 1, 'never twice');
});

test('an ear without the AI voice functions changes nothing', async () => {
  const { rig, voice } = await earRig({ endOfTurn: async () => 0.8 });
  rig.engine.typed('Plain line.');
  await flush();
  await playLine(rig, voice.lines[0]);
  rig.h.playback(voice.lines[0].utteranceId, 'finished', 900);
  await flush();
  assert(lastMain(rig).includes("Candidate: 'Plain line.'") && !lastMain(rig).includes('[voice:'));
});

test('a line that ends during a pause is answered when the call resumes; hanging up stops the voice', async () => {
  const { rig, voice } = await voicedRig();
  rig.engine.typed('Happy to walk through it.');
  await flush();
  const line = voice.lines[0];
  await playLine(rig, line);
  const before = rig.sessions.main.calls.length;
  rig.engine.setPaused(true);
  rig.h.playback(line.utteranceId, 'finished', 1200);
  await flush();
  assert.equal(rig.sessions.main.calls.length, before, 'nobody answers during the pause');
  rig.engine.setPaused(false);
  await flush();
  assert.equal(rig.sessions.main.calls.length, before + 1);
  rig.engine.typed('One more thing.');
  await flush();
  rig.engine.hangUp();
  assert.equal(voice.lines[1].cancelled, true);
  assert(voice.lines[1].signal.aborted);
});

test('tags are inserted by code before the named sentences: the words never change, a slow or useless reply is not waited for', async () => {
  const line = 'I led the team.  We shipped in May! Did that help? Yes';
  assert.equal(splitSentences(line).join(''), line, 'the pieces rejoin to the exact line');
  assert.equal(splitSentences(line).length, 4);
  const numbers = 'I ran about 2.9 amps at 3.5 kg. Then it held.';
  assert.deepEqual(splitSentences(numbers), ['I ran about 2.9 amps at 3.5 kg. ', 'Then it held.'], 'a decimal point is not a sentence end');
  assert.equal(applyTags(numbers, '2: [warmly]'), 'I ran about 2.9 amps at 3.5 kg. [warmly] Then it held.', 'no tag lands inside a number');
  assert.equal(applyTags(line, '1: [confident]\n3: [warmly]'), '[confident] I led the team.  We shipped in May! [warmly] Did that help? Yes');
  assert.equal(applyTags('I led the team.', '1: [confident]'), '[confident] I led the team.');
  assert.equal(applyTags('One. Two.', '2) [brightening]\n2: [earnest]'), 'One. [brightening] Two.', 'lenient separator; the first tag for a sentence wins');
  assert.equal(applyTags('One. Two.', 'none'), null);
  assert.equal(applyTags('One. Two.', '9: [warmly]\n0: [warmly]\nsentence 1: warmly\n1: warmly\n1: [' + 'x'.repeat(90) + ']'), null, 'out of range or malformed rows are ignored');
  assert.equal(applyTags('One. Two.', '[confident] One. Two.'), null, 'a re-typed line is not a tag list');
  for (const reply of ['1: [warmly]', '2: [light laugh]\n1: [engaged]', 'Sure!\n1: [a]\n2: [b]']) {
    assert.equal(applyTags(line, reply).replace(/\[[^\]]*\] ?/gu, ''), line, 'removing the tags gives the original back');
  }
  assert.equal(wordsOf('[warmly] Hi  there [light laugh] yes'), 'Hi there yes');
  const prompt = candidateTagPrompt({ text: 'Thanks for having me.', transcript: [{ speaker: 'interviewer', text: '[warm] Hi Sam.' }], role: 'Backend Engineer' });
  assert(prompt.includes('Interviewer: Hi Sam.') && prompt.includes('1. Thanks for having me.') && prompt.includes('Backend Engineer'));
  const tagged = await tagCandidateLine({ text: 'Thanks for having me.', tagText: async () => '1: [warmly]' });
  assert.deepEqual(tagged, { text: '[warmly] Thanks for having me.', tagged: true });
  const retyped = await tagCandidateLine({ text: 'Thanks for having me.', tagText: async () => 'Thank you for having me.' });
  assert.deepEqual(retyped, { text: 'Thanks for having me.', tagged: false });
  const failed = await tagCandidateLine({ text: 'Thanks.', tagText: async () => { throw new Error('down'); } });
  assert.deepEqual(failed, { text: 'Thanks.', tagged: false });
  let timer = null;
  const clock = { setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout: () => {} };
  const slow = tagCandidateLine({ text: 'Thanks.', tagText: () => new Promise(() => {}), clock });
  await flush();
  timer();
  assert.deepEqual(await slow, { text: 'Thanks.', tagged: false });
  assert.deepEqual({ ...careerWritingStageProfile(CANDIDATE_VOICE_STAGE) }, { model: 'sonnet', effort: 'low' });
});

test('the voice speaks the setting\'s gender, falls back to the other one, and sends the tagged line', async () => {
  const made = [];
  const factory = gender => ({ open: options => {
    const stream = { gender, options, sent: [], sampleRate: 24000, onAudio() {}, onWords() {}, cancel() {} };
    stream.sendText = text => stream.sent.push(text);
    stream.finish = async () => 'done';
    made.push(stream);
    return stream;
  } });
  let wanted = 'male';
  const voice = createCandidateVoice({ factories: { female: factory('female'), male: factory('male') }, gender: () => wanted, tagText: async () => '1: [confident]' });
  const line = voice.open({ utteranceId: 'u1', text: 'Yes, I did.' });
  assert.equal(line.gender, 'male');
  await line.done;
  assert.deepEqual(made[0].sent, ['[confident] Yes, I did.']);
  wanted = 'female';
  assert.equal(voice.open({ utteranceId: 'u2', text: 'Sure.' }).gender, 'female', 'a change applies to the next line');
  const onlyFemale = createCandidateVoice({ factories: { female: factory('female') }, gender: () => 'male' });
  assert.equal(onlyFemale.open({ utteranceId: 'u3', text: 'Sure.' }).gender, 'female');
  assert.equal(createCandidateVoice({ factories: {} }), null, 'no voice, no candidate voice');
  assert.equal(DEFAULT_CANDIDATE_VOICE_GENDER, 'male');
});

test('a voice draw can ask for one gender', async () => {
  const rows = [
    { voice_id: 'm1', public_owner_id: 'o', name: 'Max', gender: 'male', use_case: 'conversational', language: 'en', category: 'high_quality' },
    { voice_id: 'f1', public_owner_id: 'o', name: 'Fay', gender: 'female', use_case: 'conversational', language: 'en', category: 'high_quality' },
  ];
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ voices: rows, total_count: rows.length }) });
  let at = 0;
  const random = () => [0, 0.6, 0][at++ % 3];
  const drawn = await drawVoice({ fetch, key: 'k', random, gender: 'female' });
  assert.equal(drawn.voice.voiceId, 'f1');
  assert.equal(drawn.voice.gender, 'female');
});

test('the voice setting is saved, read back and refused when it is not a choice', async () => {
  const files = new Map();
  const fsApi = { readFileSync: file => { if (!files.has(file)) throw new Error('missing'); return files.get(file); } };
  const store = createPracticeVoiceStore({ filePath: '/tmp/never-written/practice-voice.json', fsApi });
  assert.equal(store.read(), 'male', 'a missing file is the default');
  const handlers = new Map();
  registerPracticeVoiceHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, guarded: fn => (_event, ...args) => fn(...args), store: { read: () => 'male', write: async gender => gender } });
  assert.deepEqual(await handlers.get('interview-app:get-practice-voice')({}), { gender: 'male', choices: ['female', 'male'], default: 'male' });
  assert.equal((await handlers.get('interview-app:set-practice-voice')({}, { gender: 'female' })).gender, 'female');
  await assert.rejects(() => handlers.get('interview-app:set-practice-voice')({}, { gender: 'robot' }));
  await assert.rejects(() => handlers.get('interview-app:set-practice-voice')({}, { gender: 'male', extra: 1 }));
});

test('the cut-in sound is one piece of code: fade, mix and first speech, shared with the panel voice', () => {
  assert.equal(panelVoice.CUT_IN_OVERLAP_MS, CUT_IN_OVERLAP_MS);
  assert.equal(panelVoice.CUT_IN_FADE_MS, CUT_IN_FADE_MS);
  const rate = 1000; // 1 sample per ms keeps the arithmetic readable
  const tail = Buffer.alloc(200 * 2);
  for (let i = 0; i < 200; i += 1) tail.writeInt16LE(1000, i * 2);
  fadeOutTail(tail, rate);
  assert.equal(tail.readInt16LE(0), 1000, 'the start plays as it was');
  assert.equal(tail.readInt16LE((200 - CUT_IN_FADE_MS - 1) * 2), 1000);
  assert.equal(tail.readInt16LE(199 * 2), 0, 'it ends in silence');
  assert(tail.readInt16LE(140 * 2) > 0 && tail.readInt16LE(140 * 2) < 1000, 'and fades on the way');
  const data = Buffer.alloc(6 * 2);
  data.writeInt16LE(32000, 0);
  const head = Buffer.alloc(4 * 2);
  for (let i = 0; i < 4; i += 1) head.writeInt16LE(1000, i * 2);
  const { mixed, rest } = mixHeadInto(data, head);
  assert.equal(mixed.readInt16LE(0), 32767, 'a sum is clipped, never wrapped');
  assert.equal(mixed.readInt16LE(2), 1000);
  assert.equal(mixed.readInt16LE(8), 0, 'past the head the audio is untouched');
  assert.equal(rest.length, 0);
  const short = mixHeadInto(Buffer.alloc(4), head);
  assert.equal(short.rest.length, 4, 'what does not fit waits for the next chunk');
  const speech = Buffer.alloc(100 * 2);
  speech.writeInt16LE(500, 63 * 2);
  for (let i = 64; i < 100; i += 1) speech.writeInt16LE(500, i * 2);
  assert.equal(firstSpeechSample(speech, rate), 63);
  assert.equal(firstSpeechSample(Buffer.alloc(100), rate), -1);
});

// ---- the candidate's voice mixed into the microphone (helper can inject) ------------------------------------------

async function injectRig({ thresholds = {}, random = () => 0, ear = null } = {}) {
  const candidateVoice = fakeCandidateVoice();
  const rig = makeRig({ autoOpener: true, candidateVoice, inject: true, random, ear, thresholds });
  await greet(rig);
  return { rig, voice: candidateVoice };
}

/** The line has its audio and words; the helper starts mixing it into the microphone signal. */
async function injectLine(rig, line, started = true) {
  line.audioCb(Buffer.alloc(48000 * 4));
  line.wordsCb(timed(line.text));
  line.finish();
  await flush();
  if (started) rig.h.inject(line.utteranceId, 'started');
  await flush();
}

/** The microphone hears the injected line: the helper's vad and transcript events, like real speech. */
function micHears(rig, text, segmentId = 's1') {
  rig.h.vad(true);
  (rig.micStarts ||= {})[segmentId] = rig.clock.now();
  rig.h.transcript(text, segmentId, rig.clock.now(), false, rig.clock.now() + 300);
}
/** The recogniser settles what it heard (the final for that segment, same start), as it does a moment after the speech ends. */
function micSettles(rig, text, segmentId = 's1') {
  const start = rig.micStarts?.[segmentId] ?? rig.clock.now();
  rig.h.transcript(text, segmentId, start, true, start + 300);
}

/** The candidate answers by microphone and the interviewer's reply is on air (playing, not finished). */
async function interviewerSpeaking(rig) {
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Tell me more about how it retried failed jobs on the queue.');
  rig.streams.at(-1).audio(6400);
  await flush();
  await rig.clock.advance(700);
  const reply = rig.streams.at(-1).utteranceId;
  rig.h.playback(reply, 'started');
  await flush();
  assert.equal(rig.engine.state().phase, 'playing');
  return reply;
}

const lastOpener = rig => rig.sessions.opener.calls.at(-1).message;
const injectOps = (rig, id) => rig.ops.filter(item => item.id === id).map(item => item.op);
const injectCancels = (rig, id) => rig.ops.filter(item => item.op === 'injectCancel' && item.id === id);
const LONG = 'So the first thing we did was move every job onto one queue';
const LIVE_LOOK = { cutInFirstMs: 1000, cutInEveryMs: 1000, cutInYieldMs: 2500 };

test('injected: a sent message goes to the helper as an injected line, never played on the interviewer playback', async () => {
  const { rig, voice } = await injectRig({ thresholds: { cutInFirstMs: 500, cutInMinLeftMs: 0 } });
  const before = rig.sessions.main.calls.length;
  assert.equal(rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' }), true);
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  assert.deepEqual(injectOps(rig, line.utteranceId), ['inject', 'injectAudio', 'injectEnd']);
  assert.equal(rig.opsOf('inject')[0].rate, 24000);
  assert(!rig.opsOf('play').some(item => item.id === line.utteranceId) && !rig.opsOf('push').some(item => item.id === line.utteranceId));
  const speaking = rig.of('candidate-voice').find(item => item.state === 'speaking');
  assert.equal(speaking.injected, true, 'the debug trail can tell the line was injected');
  // The app-played machinery is off: position events alone drive no look, and the interviewer hears nothing until the microphone does.
  rig.h.inject(line.utteranceId, 'position', 900);
  rig.h.inject(line.utteranceId, 'position', 2900);
  await flush();
  assert.equal(rig.sessions.main.calls.length, before);
  assert(!rig.engine.state().transcript.some(item => item.voiced), 'no voiced entry is ever made');
  rig.h.inject(line.utteranceId, 'finished', 4000);
  await flush();
  assert.equal(rig.sessions.main.calls.length, before, 'finishing the line is not a turn by itself');
  const done = rig.of('candidate-voice').find(item => item.state === 'finished');
  assert.equal(done.injected, true);
});

test('injected: the turn ends by vad and speculation like speech, with the microphone\'s own entry and no AI-voice ear calls', async () => {
  const ear = voicedEar();
  const { rig, voice } = await injectRig({ ear });
  const before = rig.sessions.main.calls.length;
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  micHears(rig, 'I rebuilt the billing service in Go.');
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.equal(rig.sessions.main.calls.length, before, 'a pause while the line is still playing starts nothing');
  micSettles(rig, 'I rebuilt the billing service in Go.');
  rig.h.inject(line.utteranceId, 'finished', 3000);
  await flush();
  await rig.clock.advance(10);
  assert.equal(rig.sessions.main.calls.length, before + 1, 'speculated on the heard words once the line is over');
  const message = lastMain(rig);
  assert(message.includes("Candidate: 'I rebuilt the billing service in Go.'"), message);
  assert(!message.includes('typed in chat') && !message.includes('[voice: warm'), message);
  rig.sessions.main.answer('Nice. What was the hardest part?');
  rig.streams.at(-1).audio(3200);
  await flush();
  await rig.clock.advance(700);
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'candidate');
  assert.notEqual(entry.channel, 'chat', 'a microphone entry, not a sent message');
  assert(!entry.voiced && !entry.interrupted);
  assert.equal(ear.calls.prepared.length + ear.calls.noted.length, 0, 'the ear measures candidate.wav, not the AI voice');
});

test('injected: after a line heard whole the first look waits for the recogniser\'s final on its last words, a little while at most', async () => {
  // As in call-mwqscir3-3yraup: the look began on the cut-short text and was thrown away when the final came.
  const { rig, voice } = await injectRig();
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  micHears(rig, 'I rebuilt the billing service in');
  await rig.clock.advance(300);
  rig.h.vad(false);
  await flush();
  rig.h.inject(line.utteranceId, 'finished', 3000);
  await flush();
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 0, 'no look on the cut-short words');
  micSettles(rig, 'I rebuilt the billing service in Go.');
  await rig.clock.advance(100);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the look starts once the final is in');
  assert(lastOpener(rig).includes('I rebuilt the billing service in Go.'), lastOpener(rig));
  // Without a final the wait ends on its own.
  const other = await injectRig();
  other.rig.engine.typed('Short answer.', { chatId: 'm1' });
  await flush();
  await injectLine(other.rig, other.voice.lines[0]);
  micHears(other.rig, 'Short');
  await other.rig.clock.advance(300);
  other.rig.h.vad(false);
  await flush();
  other.rig.h.inject(other.voice.lines[0].utteranceId, 'finished', 3000);
  await flush();
  await other.rig.clock.advance(1300);
  assert.equal(other.rig.sessions.opener.calls.length, 1, 'the wait is bounded');
});

test('injected: the end of the AI voice line is a sure finish, however the turn model scores it', async () => {
  const ear = { ...voicedEar(), endOfTurn: async () => 0.05 };
  const { rig, voice } = await injectRig({ ear });
  const before = rig.sessions.main.calls.length;
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  micHears(rig, 'I rebuilt the billing service in Go.');
  await rig.clock.advance(300);
  rig.h.vad(false);
  await flush();
  micSettles(rig, 'I rebuilt the billing service in Go.');
  rig.h.inject(line.utteranceId, 'finished', 3000);
  await flush();
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 1, 'speculated at the normal point, not the held one');
  assert(!lastOpener(rig).includes('sounds unfinished'), lastOpener(rig));
  assert.equal(rig.of('turn-model').filter(event => event.held).length, 0);
  assert.equal(rig.sessions.main.calls.length, before + 1);
});

test('injected: the turn model is not even asked about a vad end that belongs to the AI voice line', async () => {
  const asked = [];
  const ear = { ...voicedEar(), endOfTurn: async atMs => { asked.push(atMs); return 0.05; } };
  const { rig, voice } = await injectRig({ ear });
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  micHears(rig, 'I rebuilt the billing service in Go.');
  await rig.clock.advance(300);
  rig.h.vad(false); // the line is still playing when the vad end arrives
  await flush();
  micSettles(rig, 'I rebuilt the billing service in Go.');
  rig.h.inject(line.utteranceId, 'finished', 3000);
  await flush();
  await rig.clock.advance(600);
  assert.equal(asked.length, 0);
  assert.equal(rig.sessions.opener.calls.length, 1);
  assert(!lastOpener(rig).includes('sounds unfinished'), lastOpener(rig));
});

test('injected: a long pause inside a line still playing is not a turn end: nothing speculates or commits until the line finishes', async () => {
  const ear = { ...voicedEar(), endOfTurn: async () => 0.9 };
  const { rig, voice } = await injectRig({ ear });
  const before = rig.sessions.main.calls.length;
  rig.engine.typed('I rebuilt the billing service in Go. [slightly slower] Then we cut costs.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  micHears(rig, 'I rebuilt the billing service in Go.');
  await rig.clock.advance(300);
  rig.h.vad(false); // a gap between the line's sentences, longer than the commit wait
  await flush();
  await rig.clock.advance(2000);
  assert.equal(rig.sessions.opener.calls.length, 0, 'no speculative reply on a pause inside the line');
  assert.equal(rig.sessions.main.calls.length, before, 'no commit while the candidate\'s voice is still playing');
  rig.h.inject(line.utteranceId, 'finished', 5000);
  await flush();
  await rig.clock.advance(1300);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the turn ends once the line is over');
  assert.equal(rig.sessions.main.calls.length, before + 1);
});

test('injected: a line cut short after a pause inside it still ends the turn on the usual schedule', async () => {
  const ear = { ...voicedEar(), endOfTurn: async () => 0.9 };
  const { rig, voice } = await injectRig({ ear });
  const before = rig.sessions.main.calls.length;
  rig.engine.typed('I rebuilt the billing service in Go. Then we cut costs.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  micHears(rig, 'I rebuilt the billing service in Go.');
  await rig.clock.advance(300);
  rig.h.vad(false); // armed nothing: the line is still playing
  await flush();
  rig.h.inject(line.utteranceId, 'cancelled', 1200); // the line stops part-way, with no interviewer reply in flight
  await flush();
  await rig.clock.advance(1300);
  assert.equal(rig.sessions.main.calls.length, before + 1, 'the turn ends instead of waiting for the silence check-in');
});

test('injected: live speech right after a line is judged as live speech, not as the line\'s end', async () => {
  const ear = { ...voicedEar(), endOfTurn: async () => 0.05 };
  const { rig, voice } = await injectRig({ ear });
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  rig.h.inject(line.utteranceId, 'finished', 3000);
  await flush();
  await speak(rig, 'and also I', 'live'); // the candidate goes on in their own voice within the line's window
  await flush();
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 0, 'held by the turn model, as live speech is');
  assert(rig.of('turn-model').some(event => event.held));
});

test('injected: timers from a live pause just before a sent line do not fire while it starts playing', async () => {
  const { rig } = await injectRig();
  const before = rig.sessions.main.calls.length;
  await speak(rig, 'Let me think', 'a'); // arms the 500 / 1200 ms timers
  await rig.clock.advance(100);
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' }); // its voice is still being made
  await flush();
  await rig.clock.advance(1500);
  assert.equal(rig.sessions.opener.calls.length, 0);
  assert.equal(rig.sessions.main.calls.length, before, 'nothing is said over the line that is about to play');
});

test('live microphone speech with an unsure verdict is still held', async () => {
  const ear = { ...voicedEar(), endOfTurn: async () => 0.05 };
  const { rig } = await injectRig({ ear });
  await speak(rig, 'I built a scheduler', 'a');
  await flush();
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 0, 'held past the normal speculation point');
  await rig.clock.advance(900);
  assert(lastOpener(rig).includes('[audio: sounds unfinished]'), lastOpener(rig));
});

test('injected: a long line gets the live-speech looks, and a cut-in makes the candidate yield after a reaction time at the end of the word', async () => {
  const { rig, voice } = await injectRig({ thresholds: LIVE_LOOK, random: () => 0 });
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  const started = rig.clock.now();
  micHears(rig, 'So the first thing we did was move');
  await rig.clock.advance(1000);
  assert(lastMain(rig).includes('[The candidate is still speaking.'), 'the microphone path looks at the live speech');
  rig.sessions.main.answer('Sorry to jump in, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const reply = rig.streams.at(-1).utteranceId;
  assert.equal(injectCancels(rig, line.utteranceId).length, 0, 'nothing stops the line before the reply is heard');
  rig.h.inject(line.utteranceId, 'position', 1000); // the line has been mixed for 1000 ms
  rig.h.playback(reply, 'started');
  await flush();
  assert.equal(rig.clock.now() - started, 1000);
  await rig.clock.advance(299);
  assert.equal(injectCancels(rig, line.utteranceId).length, 0, 'the reaction time (300 ms with random 0) is not over');
  await rig.clock.advance(179); // at 1300 ms the word 1200..1480 is being said: it is finished first
  assert.equal(injectCancels(rig, line.utteranceId).length, 0, 'it keeps going to the end of the word');
  await rig.clock.advance(2);
  const cancels = injectCancels(rig, line.utteranceId);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].fadeMs, 60, 'a short fade');
  assert.equal(rig.opsOf('cancel').filter(item => item.id === line.utteranceId).length, 0, 'the interviewer playback is not what stops it');
  rig.h.inject(line.utteranceId, 'cancelled', 1480);
  await flush();
  const cut = rig.of('candidate-voice').find(item => item.state === 'cut');
  assert.equal(cut.injected, true);
  assert.deepEqual(cut.messages, [{ chatId: 'm1', heard: 'So the first thing we' }], 'the chat is cut where the inject position reached');
});

test('injected: the reaction time is drawn from the thresholds with deps.random', async () => {
  const run = async random => {
    const { rig, voice } = await injectRig({ thresholds: { ...LIVE_LOOK, candidateYieldMinMs: 400, candidateYieldMaxMs: 1000 }, random });
    rig.engine.typed('Yes sure.', { chatId: 'm1' });
    await flush();
    const line = voice.lines[0];
    await injectLine(rig, line);
    micHears(rig, 'Yes sure');
    await rig.clock.advance(1000);
    rig.sessions.main.answer('Right, thanks.');
    rig.streams.at(-1).audio(3200);
    await flush();
    rig.h.inject(line.utteranceId, 'position', 3000); // past every word: any moment is a word end
    rig.h.playback(rig.streams.at(-1).utteranceId, 'started');
    let waited = 0;
    while (!injectCancels(rig, line.utteranceId).length && waited < 2000) { await rig.clock.advance(1); waited += 1; }
    return waited;
  };
  assert.equal(await run(() => 0), 400);
  assert.equal(await run(() => 0.5), 700);
  assert.equal(await run(() => 1), 1000);
});

test('injected: a line sent while the interviewer is already speaking is talking over them: never auto-stopped, judged by the overlap rules', async () => {
  const { rig, voice } = await injectRig();
  const reply = await interviewerSpeaking(rig);
  rig.engine.typed('It retried with a backoff.', { chatId: 'm1' });
  await flush();
  const line = voice.lines.at(-1);
  await injectLine(rig, line); // started while the interviewer is speaking
  assert.equal(rig.opsOf('cancel').filter(item => item.id === reply).length, 0);
  micHears(rig, 'It retried with a backoff', 'b'); // the helper hears it as the candidate's speech
  await rig.clock.advance(800);
  rig.h.transcript('It retried with a backoff', 'b', rig.clock.now() - 800, false, rig.clock.now());
  await rig.clock.advance(0);
  assert.equal(rig.opsOf('cancel').filter(item => item.id === reply).length, 1, 'the usual overlap rules stop the interviewer');
  assert.equal(injectCancels(rig, line.utteranceId).length, 0, 'the candidate went on talking');
  await rig.clock.advance(3000);
  assert.equal(injectCancels(rig, line.utteranceId).length, 0);
});

test('injected: a brief overlap by an injected line goes to the classifier like a person\'s "right", and the line is left alone', async () => {
  const { rig, voice } = await injectRig();
  await interviewerSpeaking(rig);
  rig.engine.typed('Right.', { chatId: 'm1' });
  await flush();
  const line = voice.lines.at(-1);
  await injectLine(rig, line);
  const classifierBefore = rig.sessions.classifier.calls.length;
  micHears(rig, 'Right', 'c');
  await rig.clock.advance(300);
  rig.h.vad(false);
  await flush();
  assert.equal(rig.sessions.classifier.calls.length, classifierBefore + 1, 'the interruption rules judge it');
  assert.equal(injectCancels(rig, line.utteranceId).length, 0);
});

test('injected: a message sent while a line is going is spoken straight after it; a cut line keeps its chat entry', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const first = voice.lines[0];
  await injectLine(rig, first);
  rig.engine.typed('And a second thought.', { chatId: 'm2' });
  rig.engine.typed('Third bit.', { chatId: 'm3' });
  await flush();
  assert.equal(voice.lines.length, 1, 'one line at a time');
  rig.h.inject(first.utteranceId, 'finished', 3600);
  await flush();
  assert.equal(voice.lines.length, 2, 'the next line starts as soon as the previous one finished');
  assert.equal(voice.lines[1].text, 'And a second thought. Third bit.', 'queued messages go as one line');
  assert(!rig.of('candidate-voice').some(item => item.state === 'cut'));
  await injectLine(rig, voice.lines[1]);
  assert.deepEqual(injectOps(rig, voice.lines[1].utteranceId), ['inject', 'injectAudio', 'injectEnd']);
  const ends = rig.ops.filter(item => item.op === 'inject').map(item => item.id);
  assert.deepEqual(ends, [first.utteranceId, voice.lines[1].utteranceId]);
});

test('injected: after giving way to an interviewer, the next queued message waits until they have finished', async () => {
  const { rig, voice } = await injectRig({ thresholds: LIVE_LOOK, random: () => 0 });
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  micHears(rig, 'So the first thing we did was move');
  await rig.clock.advance(1000);
  rig.engine.typed('And a second thought.', { chatId: 'm2' });
  await flush();
  rig.sessions.main.answer('Sorry to jump in, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const reply = rig.streams.at(-1).utteranceId;
  rig.h.inject(line.utteranceId, 'position', 1000);
  rig.h.playback(reply, 'started');
  await flush();
  await rig.clock.advance(600);
  assert.equal(injectCancels(rig, line.utteranceId).length, 1, 'the candidate gave way');
  rig.h.inject(line.utteranceId, 'cancelled', 1480);
  await flush();
  assert.equal(voice.lines.length, 1, 'the queued message is not spoken over the interviewer');
  rig.h.vad(false);
  rig.h.playback(reply, 'finished', 2000);
  await flush();
  assert.equal(voice.lines.length, 2, 'it is spoken once the interviewer has finished');
  assert.equal(voice.lines[1].text, 'And a second thought.');
});

test('injected: a cancel the wrapper made for backpressure keeps the last known position for the chat', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  rig.h.inject(line.utteranceId, 'position', 1480);
  rig.engine.helperEvent({ type: 'inject', utteranceId: line.utteranceId, state: 'cancelled', positionMs: 0, reason: 'backpressure' });
  await flush();
  const cut = rig.of('candidate-voice').find(item => item.state === 'cut');
  assert.deepEqual(cut.messages, [{ chatId: 'm1', heard: 'So the first thing we' }], 'what was mixed before the backlog stays said');
});

test('injected: pausing cuts the line and everything queued behind it, where they stand; nothing is spoken again on resume', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  rig.engine.typed('And a second thought.', { chatId: 'm2' });
  await flush();
  rig.h.inject(line.utteranceId, 'position', 900);
  rig.engine.setPaused(true);
  await flush();
  const cancels = injectCancels(rig, line.utteranceId);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].fadeMs, 60);
  rig.h.inject(line.utteranceId, 'cancelled', 940);
  await flush();
  const cut = rig.of('candidate-voice').find(item => item.state === 'cut');
  assert.deepEqual(cut.messages, [{ chatId: 'm1', heard: 'So the first' }, { chatId: 'm2', heard: '' }]);
  rig.engine.setPaused(false);
  await flush();
  assert.equal(voice.lines.length, 1, 'the queued message was dropped, not spoken later');
});

test('injected: a generated line sent during a pause is made and held, reported ready, and played whole on the resume', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.setPaused(true);
  await flush();
  assert.equal(rig.engine.canHoldVoice(), true);
  assert.equal(rig.engine.typed('Typed by hand.', { chatId: 'm0' }), false, 'a typed message is still refused while paused');
  assert.equal(rig.engine.typed(LONG, { generated: true, chatId: 'm1' }), true, 'the wand\'s line is accepted and made now');
  await flush();
  const line = voice.lines[0];
  line.audioCb(Buffer.alloc(4800));
  await flush();
  const ready = rig.of('candidate-voice').find(item => item.state === 'ready');
  assert.deepEqual({ held: ready.held, chatIds: ready.chatIds }, { held: true, chatIds: ['m1'] }, 'ready while still paused');
  line.audioCb(Buffer.alloc(4800));
  line.wordsCb(timed(line.text));
  line.finish();
  await flush();
  assert.deepEqual(injectOps(rig, line.utteranceId), [], 'nothing reaches the microphone during the pause');
  rig.engine.setPaused(false);
  await flush();
  assert.deepEqual(injectOps(rig, line.utteranceId), ['inject', 'injectAudio', 'injectAudio', 'injectEnd'], 'played from its start on the resume');
});

test('injected: a line not heard yet when the pause starts is held for the resume, not dropped', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  rig.engine.setPaused(true);
  await flush();
  line.audioCb(Buffer.alloc(4800));
  line.finish();
  await flush();
  assert.deepEqual(injectOps(rig, line.utteranceId), []);
  assert.equal(rig.of('candidate-voice').some(item => item.state === 'cut'), false);
  rig.engine.setPaused(false);
  await flush();
  assert.deepEqual(injectOps(rig, line.utteranceId), ['inject', 'injectAudio', 'injectEnd']);
});

test('injected: a sentence-end cut-in on the voice line waits for the sentence to end as heard on the microphone, exactly as for live speech', async () => {
  // Nothing about the voice line's own words or timings is used: only what the microphone path hears, as for a real voice.
  const candidateVoice = fakeCandidateVoice();
  const watchParse = text => {
    const found = /^cut:(\w):([\w-]+)(?::([\w-]+))?$/u.exec(String(text ?? '').trim());
    return found ? { decision: 'cut-in', who: found[1], reason: found[2], when: found[3] === 'sentence-end' ? 'sentence-end' : 'now' } : { decision: 'listen', who: null, reason: null };
  };
  const rig = makeRig({ autoOpener: true, candidateVoice, inject: true, watcher: true, formatWatch: options => JSON.stringify(options), parseWatch: watchParse,
    thresholds: { cutInFirstMs: 3000, watchEveryMs: 1000, watchTimeoutMs: 500, cutInHoldMs: 800, cutInStaleWords: 50, cutInYieldMs: 2500 } });
  await greet(rig);
  const text = 'We moved every job onto one queue and then we sharded it by region. After that the retries became cheap.';
  rig.engine.typed(text, { chatId: 'm1' });
  await flush();
  const line = candidateVoice.lines[0];
  line.audioCb(Buffer.alloc(48000 * 12));
  line.wordsCb(timed(text));
  line.finish();
  await flush();
  rig.h.inject(line.utteranceId, 'started');
  await flush();
  micHears(rig, 'We moved every job onto one queue and then');
  await rig.clock.advance(3100);
  const watch = rig.sessions.watcher.calls.at(-1);
  watch.settled = true;
  watch.resolve({ text: 'cut:A:probe:sentence-end' });
  await flush();
  rig.h.inject(line.utteranceId, 'position', 2700);
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  const held = rig.of('cut-in').find(event => event.state === 'held');
  assert.equal(held.until, 'sentence-end');
  assert.equal(held.waitMs, undefined, 'no wait worked out from the line itself');
  rig.h.vad(false); // a clause gap in the voice line, which goes straight on
  await flush();
  assert(!rig.opsOf('play').some(item => item.id === id), 'a clause gap does not release it');
  await rig.clock.advance(200);
  rig.h.vad(true);
  await flush();
  await rig.clock.advance(1200);
  assert(!rig.opsOf('play').some(item => item.id === id), 'still mid-sentence');
  // The recogniser settles the sentence: that is the end of it, for this voice as for any.
  rig.h.transcript('We moved every job onto one queue and then we sharded it by region.', 's1', rig.micStarts.s1, true, rig.clock.now());
  await flush();
  assert(rig.opsOf('play').some(item => item.id === id), 'it lands at the full stop');
  assert(rig.of('cut-in').some(event => event.state === 'committed'));
});

test('injected: a now cut-in on the voice line comes in at the next breath, exactly as on live speech', async () => {
  // As in call-mwqscir3-3yraup: the voice line's clause gaps read as breaths, so the cut landed mid-clause.
  const candidateVoice = fakeCandidateVoice();
  const watchParse = text => {
    const found = /^cut:(\w):([\w-]+)(?::([\w-]+))?$/u.exec(String(text ?? '').trim());
    return found ? { decision: 'cut-in', who: found[1], reason: found[2], when: found[3] === 'sentence-end' ? 'sentence-end' : 'now' } : { decision: 'listen', who: null, reason: null };
  };
  const rig = makeRig({ autoOpener: true, candidateVoice, inject: true, watcher: true, formatWatch: options => JSON.stringify(options), parseWatch: watchParse,
    thresholds: { cutInFirstMs: 3000, watchEveryMs: 1000, watchTimeoutMs: 500, cutInHoldMs: 800, cutInStaleWords: 50, cutInYieldMs: 2500 } });
  await greet(rig);
  const text = 'We moved every job onto one queue and then we sharded it by region. After that the retries became cheap.';
  rig.engine.typed(text, { chatId: 'm1' });
  await flush();
  const line = candidateVoice.lines[0];
  line.audioCb(Buffer.alloc(48000 * 12));
  line.wordsCb(timed(text));
  line.finish();
  await flush();
  rig.h.inject(line.utteranceId, 'started');
  await flush();
  micHears(rig, 'We moved every job onto one queue and then');
  await rig.clock.advance(3100);
  const watch = rig.sessions.watcher.calls.at(-1);
  watch.settled = true;
  watch.resolve({ text: 'cut:A:probe' });
  await flush();
  rig.h.inject(line.utteranceId, 'position', 2700);
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  assert(!rig.of('cut-in').some(event => event.until === 'sentence-end'), 'no sentence hold');
  rig.h.vad(false); // a clause gap in the voice line: the breath
  await flush();
  assert(rig.opsOf('play').some(item => item.id === id), 'it comes in at the breath, mid-sentence');
});

test('injected: a cut-in already stale when it is ready is dropped, never held to the sentence end', async () => {
  const candidateVoice = fakeCandidateVoice();
  const watchParse = text => {
    const found = /^cut:(\w):([\w-]+)(?::([\w-]+))?$/u.exec(String(text ?? '').trim());
    return found ? { decision: 'cut-in', who: found[1], reason: found[2], when: found[3] === 'sentence-end' ? 'sentence-end' : 'now' } : { decision: 'listen', who: null, reason: null };
  };
  const rig = makeRig({ autoOpener: true, candidateVoice, inject: true, watcher: true, formatWatch: options => JSON.stringify(options), parseWatch: watchParse,
    thresholds: { cutInFirstMs: 3000, watchEveryMs: 1000, watchTimeoutMs: 500, cutInHoldMs: 800, cutInStaleWords: 3, cutInStaleMs: -1, cutInStaleHardWords: 1000, cutInYieldMs: 2500 } });
  await greet(rig);
  const text = 'We moved every job onto one queue and then we sharded it by region. After that the retries became cheap.';
  rig.engine.typed(text, { chatId: 'm1' });
  await flush();
  const line = candidateVoice.lines[0];
  line.audioCb(Buffer.alloc(48000 * 12));
  line.wordsCb(timed(text));
  line.finish();
  await flush();
  rig.h.inject(line.utteranceId, 'started');
  await flush();
  micHears(rig, 'We moved every job');
  await rig.clock.advance(3100);
  const watch = rig.sessions.watcher.calls.at(-1);
  watch.settled = true;
  watch.resolve({ text: 'cut:A:probe:sentence-end' });
  await flush();
  micHears(rig, 'We moved every job onto one queue and then we sharded it', 's2'); // many words since the look
  rig.h.inject(line.utteranceId, 'position', 3300);
  rig.sessions.main.answer('Sorry, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  assert(!rig.of('cut-in').some(event => event.until === 'sentence-end'), 'not held to the sentence end');
});

test('injected: a wand line sent while the playing line is still being cut for the pause is made, held and played on the resume', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const first = voice.lines[0];
  await injectLine(rig, first);
  rig.h.inject(first.utteranceId, 'position', 900);
  rig.engine.setPaused(true); // the line is playing: it is cut, and the helper has not said so yet
  await flush();
  assert.equal(rig.engine.typed('Picking up from there.', { generated: true, chatId: 'm2' }), true);
  await flush();
  assert.equal(voice.lines.length, 1, 'nothing new while the old line is still ending');
  rig.h.inject(first.utteranceId, 'cancelled', 940);
  await flush();
  assert.equal(voice.lines.length, 2, 'made once the old line is over, still paused');
  const second = voice.lines[1];
  second.audioCb(Buffer.alloc(4800));
  second.finish();
  await flush();
  assert.deepEqual(injectOps(rig, second.utteranceId), [], 'held through the pause');
  rig.engine.setPaused(false);
  await flush();
  assert.deepEqual(injectOps(rig, second.utteranceId), ['inject', 'injectAudio', 'injectEnd'], 'played on the resume');
});

test('an interviewer starting to speak is announced with the reaction time the candidate gives way after, the same one the voice line uses', async () => {
  const { rig } = await injectRig({ random: () => 0.5 });
  await interviewerSpeaking(rig);
  const floor = rig.of('floor').at(-1);
  assert.equal(floor.yieldMs, 600, 'halfway between 300 and 900 ms');
  assert.equal(floor.speakerId, null, 'a call with one interviewer names no speaker');
});

test('injected: hanging up cancels the injection and ignores what the helper reports after', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.typed(LONG, { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await injectLine(rig, line);
  rig.engine.hangUp();
  assert.equal(injectCancels(rig, line.utteranceId).length, 1);
  assert.equal(voice.lines[0].cancelled, true, 'the synthesis is cancelled too');
  const events = rig.events.length;
  rig.h.inject(line.utteranceId, 'cancelled', 500);
  await flush();
  assert.equal(rig.events.length, events);
});

test('injected: a voice that fails is tried once more, then lost; a voice that sends nothing times out; nothing is injected or passed on as text', async () => {
  const { rig, voice } = await injectRig();
  const before = rig.sessions.main.calls.length;
  rig.engine.typed('A line that fails.', { chatId: 'm1' });
  await flush();
  voice.lines[0].fail();
  await flush();
  assert.equal(voice.lines.length, 2, 'tried once more');
  voice.lines[1].fail();
  await flush();
  assert(rig.of('error').some(item => item.code === 'candidate-voice-failed'));
  assert.equal(rig.opsOf('inject').length, 0);
  rig.engine.typed('A silent voice.', { chatId: 'm2' });
  await flush();
  await rig.clock.advance(15000);
  assert.equal(voice.lines.length, 4, 'no audio by candidateVoiceStartMs: tried again');
  await rig.clock.advance(15000);
  assert.equal(rig.of('error').filter(item => item.code === 'candidate-voice-failed').length, 2);
  assert.equal(rig.sessions.main.calls.length, before, 'a sent message never reaches the interviewer as text');
});

test('injected: a helper that cannot inject keeps the old app-played path', async () => {
  const candidateVoice = fakeCandidateVoice();
  const rig = makeRig({ autoOpener: true, candidateVoice, inject: false });
  await greet(rig);
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' });
  await flush();
  const line = candidateVoice.lines[0];
  await playLine(rig, line);
  assert(rig.opsOf('play').some(item => item.id === line.utteranceId));
  assert.equal(rig.opsOf('inject').length, 0);
  rig.h.playback(line.utteranceId, 'finished', 3000);
  await flush();
  rig.sessions.main.answer('Nice. What was the hardest part?');
  rig.streams.at(-1).audio(3200);
  await flush();
  assert(rig.engine.state().transcript.some(item => item.voiced), 'the AI-voice entry exists on the fallback');
});

test('a line reports when it starts playing, naming its messages, so the window stops waiting only then', async () => {
  const { rig, voice } = await voicedRig();
  rig.engine.typed('First answer.', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  line.audioCb(Buffer.alloc(48000 * 4));
  line.wordsCb(timed(line.text));
  line.finish();
  await flush();
  assert(!rig.of('candidate-voice').some(item => item.state === 'started'), 'audio arriving is not the line being heard');
  rig.h.playback(line.utteranceId, 'started');
  rig.h.playback(line.utteranceId, 'started');
  await flush();
  assert.deepEqual(rig.of('candidate-voice').filter(item => item.state === 'started').map(item => item.chatIds), [['m1']], 'once, when the helper starts playing it');
  // Two messages queued behind a line are spoken as one line: it names both.
  rig.engine.typed('Second.', { chatId: 'm2' });
  rig.engine.typed('Third.', { chatId: 'm3' });
  await flush();
  rig.h.playback(line.utteranceId, 'finished', 900);
  await flush();
  await playLine(rig, voice.lines[1]);
  assert.deepEqual(rig.of('candidate-voice').filter(item => item.state === 'started').at(-1).chatIds, ['m2', 'm3']);
});

test('a message queued behind a line the interviewer cuts into is let go as unsaid, so nothing waits on it', async () => {
  const { rig, voice } = await voicedRig({ cutInFirstMs: 1000, cutInEveryMs: 1000, cutInMinLeftMs: 0 });
  rig.engine.typed('So the first thing we did was move every job onto one queue and then we split the workers by region', { chatId: 'm1' });
  await flush();
  const line = voice.lines[0];
  await playLine(rig, line);
  rig.engine.typed('And a second thought.', { chatId: 'm2' });
  await flush();
  rig.h.playback(line.utteranceId, 'position', 1250);
  await flush();
  rig.sessions.main.answer('Sorry to jump in, how many regions?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const cuts = rig.of('candidate-voice').filter(item => item.state === 'cut');
  assert(cuts.some(item => item.messages.some(message => message.chatId === 'm1')), 'the cut line is cut in the chat');
  assert(cuts.some(item => item.messages.some(message => message.chatId === 'm2' && message.heard === '')), 'the queued message is marked never said');
  assert.equal(voice.lines.length, 1, 'it is not spoken after the cut');
});

test('a line the voice gives up on names its messages in the failure', async () => {
  const { rig, voice } = await voicedRig();
  rig.engine.typed('A line that fails.', { chatId: 'm7' });
  await flush();
  voice.lines[0].fail();
  await flush();
  voice.lines[1].fail();
  await flush();
  assert.deepEqual(rig.of('error').filter(item => item.code === 'candidate-voice-failed').map(item => item.chatIds), [['m7']]);
  assert(!rig.of('candidate-voice').some(item => item.state === 'started'));
});

test('injected: a line reports when the helper starts mixing it, naming its messages; a failure names them too', async () => {
  const { rig, voice } = await injectRig();
  rig.engine.typed('I rebuilt the billing service in Go.', { chatId: 'm1' });
  await flush();
  await injectLine(rig, voice.lines[0], false);
  assert(!rig.of('candidate-voice').some(item => item.state === 'started'), 'not before the helper starts it');
  rig.h.inject(voice.lines[0].utteranceId, 'started');
  await flush();
  const started = rig.of('candidate-voice').filter(item => item.state === 'started');
  assert.deepEqual(started.map(item => [item.injected, item.chatIds]), [[true, ['m1']]]);
  rig.h.inject(voice.lines[0].utteranceId, 'finished', 4000);
  await flush();
  rig.engine.typed('A line that fails.', { chatId: 'm2' });
  await flush();
  voice.lines[1].fail();
  await flush();
  voice.lines[2].fail();
  await flush();
  assert.deepEqual(rig.of('error').filter(item => item.code === 'candidate-voice-failed').map(item => item.chatIds), [['m2']]);
});

export default cases;
