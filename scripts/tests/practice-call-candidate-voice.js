import assert from 'node:assert/strict';
import { askedParser, flush, greet, makeRig } from './interview-practice-call-engine.js';
import { acceptTags, candidateTagPrompt, createCandidateVoice, tagCandidateLine, wordsOf, CANDIDATE_VOICE_STAGE, DEFAULT_CANDIDATE_VOICE_GENDER } from '../../electron/practiceCall/candidateVoice.js';
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
  rig.engine.typed(text);
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

test('only the candidate\'s own words practise a question: a sent suggestion is heard but does not count', async () => {
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
  assert.deepEqual(rig.engine.state().answeredQuestions, [], 'a suggested answer is not practice');
  await say(answer);
  await reply('Great.');
  assert.deepEqual(rig.engine.state().answeredQuestions, [3], 'the candidate\'s own answer is');
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

test('tags keep every word: a reply that changes one is dropped, a slow one is not waited for', async () => {
  assert.equal(acceptTags('I led the team.', '[confident] I led the team.'), '[confident] I led the team.');
  assert.equal(acceptTags('I led the team.', '[confident] I led a team.'), null);
  assert.equal(acceptTags('I led the team.', '<line>\nI led the team.\n</line>'), 'I led the team.');
  assert.equal(wordsOf('[warmly] Hi  there [light laugh] yes'), 'Hi there yes');
  const prompt = candidateTagPrompt({ text: 'Thanks for having me.', transcript: [{ speaker: 'interviewer', text: '[warm] Hi Sam.' }], role: 'Backend Engineer' });
  assert(prompt.includes('Interviewer: Hi Sam.') && prompt.includes('Thanks for having me.') && prompt.includes('Backend Engineer'));
  const tagged = await tagCandidateLine({ text: 'Thanks for having me.', tagText: async () => '[warmly] Thanks for having me.' });
  assert.deepEqual(tagged, { text: '[warmly] Thanks for having me.', tagged: true });
  const changed = await tagCandidateLine({ text: 'Thanks for having me.', tagText: async () => 'Thank you for having me.' });
  assert.deepEqual(changed, { text: 'Thanks for having me.', tagged: false });
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
  const voice = createCandidateVoice({ factories: { female: factory('female'), male: factory('male') }, gender: () => wanted, tagText: async () => '[confident] Yes, I did.' });
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

export default cases;
