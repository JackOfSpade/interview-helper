import assert from 'node:assert/strict';
import { cleanDraft, draftAnswerPrompt, draftCandidateAnswer, transcriptLines, DRAFT_ANSWER_MAX_CHARS, DRAFT_ANSWER_STAGE } from '../../electron/practiceCall/draftAnswer.js';
import { careerWritingStageProfile } from '../../electron/ipc/careerWritingCore.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call draft answer: ${name}`, run });

const CONTEXT = Object.freeze({
  brief: { company: 'Acme Robotics', role: 'Backend Engineer', location: 'Toronto', roleSummary: 'Builds fleet APIs.', roleThemes: ['Go services'], companyFacts: ['Ships warehouse robots.'] },
  listingText: 'We are hiring a Backend Engineer to own our fleet telemetry pipeline.',
  careerText: 'Senior Developer, Northwind (2021-2024)\n- Rebuilt the billing service in Go.',
  application: { resume: 'Tailored resume line.', coverLetter: 'Dear Acme...' },
  candidateName: 'Sam Rivera',
  transcript: [
    { speaker: 'interviewer', text: 'Hi Sam, thanks for joining.' },
    { speaker: 'candidate', acknowledgement: true, text: 'Mm-hm.' },
    { speaker: 'candidate', text: 'Thanks for having me.' },
    { speaker: 'interviewer', channel: 'chat', text: 'Here is the link.' },
    { speaker: 'interviewer', text: 'Tell me about a service you rebuilt.' },
  ],
  pool: [{ question: 'Tell me about a rebuild.', answer: 'Billing in Go.' }, { question: 'Unanswered', answer: '' }],
  pad: { open: true, lang: 'go', text: 'func main() {}' },
});

test('the prompt carries the career text, listing, role, name, notes, pad and the conversation in order', () => {
  const prompt = draftAnswerPrompt(CONTEXT);
  for (const fragment of ['Sam Rivera', 'Backend Engineer', 'Acme Robotics', 'fleet telemetry pipeline', 'Rebuilt the billing service in Go.', 'Tailored resume line.', 'Dear Acme', 'Q: Tell me about a rebuild.\nA: Billing in Go.', 'func main() {}', 'Theme: Go services', 'Company fact: Ships warehouse robots.']) {
    assert(prompt.includes(fragment), `prompt holds ${fragment}`);
  }
  assert(!prompt.includes('Q: Unanswered'), 'a card with no answer is left out');
  assert(!prompt.includes('Mm-hm.'), 'acknowledgements are left out');
  const conversation = prompt.slice(prompt.indexOf('<conversation-so-far>'));
  assert(conversation.indexOf('Thanks for having me.') < conversation.indexOf('Tell me about a service you rebuilt.'));
  assert(conversation.includes('Interviewer (typed in chat): Here is the link.'));
  assert(prompt.trim().endsWith('Your reply:'));
});

test('the prompt keeps the candidate in character and lets it make up what the documents do not cover', () => {
  const prompt = draftAnswerPrompt(CONTEXT);
  assert(prompt.includes('Stay in character the whole time.'));
  assert(prompt.includes('never mention documents, notes'));
  assert(prompt.includes('make up plausible, specific details that fit them, one or two, not a list'));
  assert(prompt.includes('consistent with the documents'));
  assert(!/do not invent/iu.test(prompt), 'no rule against inventing detail');
  assert(!/say so plainly/iu.test(prompt), 'no rule telling it to admit the documents lack an answer');
});

test('the prompt carries the shared screen, says it can be seen, and marks one shown earlier', () => {
  const now = draftAnswerPrompt({ ...CONTEXT, screen: { title: 'EVA timeline', content: 'Egress 00:00, task A 00:00-01:10, task B 01:10-02:30', current: true } });
  assert(now.includes('<interviewer-shared-screen>') && now.includes('Title: EVA timeline') && now.includes('task B 01:10-02:30'));
  assert(now.includes('never say you cannot see it'));
  assert(now.indexOf('<interviewer-shared-screen>') < now.indexOf('<conversation-so-far>'));
  const earlier = draftAnswerPrompt({ ...CONTEXT, screen: { title: '', content: 'Old problem', current: false } });
  assert(earlier.includes('<screen-the-interviewer-shared-earlier>') && earlier.includes('Old problem'));
  assert(!draftAnswerPrompt(CONTEXT).includes('shared-screen>'), 'no screen, no section');
});

test('a closed pad, an empty conversation and a missing name still make a prompt', () => {
  const prompt = draftAnswerPrompt({ ...CONTEXT, pad: { open: false, text: 'hidden' }, transcript: [], candidateName: '' });
  assert(!prompt.includes('hidden'));
  assert(prompt.includes('(nothing has been said yet)'));
  assert(prompt.startsWith('You are the candidate,'));
});

test('a resume identical to the career text is not repeated', () => {
  const prompt = draftAnswerPrompt({ ...CONTEXT, application: { resume: CONTEXT.careerText, coverLetter: '' } });
  assert(!prompt.includes('<submitted-resume>'));
});

test('only the last 40 turns are kept', () => {
  const transcript = Array.from({ length: 60 }, (_, at) => ({ speaker: at % 2 ? 'candidate' : 'interviewer', text: `turn ${at}` }));
  const lines = transcriptLines(transcript);
  assert.equal(lines.length, 40);
  assert.equal(lines[0], 'Interviewer: turn 20');
  assert.equal(lines.at(-1), 'Candidate: turn 59');
});

test('each interviewer line carries the name of who said it, a shared reply split by speaker', () => {
  const participants = [{ id: 'A', name: 'Dana Whitfield' }, { id: 'B', name: 'John Park' }];
  const transcript = [
    { speaker: 'interviewer', speakerId: 'A', text: 'Welcome, I am Dana.' },
    { speaker: 'interviewer', speakerId: 'A', text: 'Over to John.', segments: [{ speakerId: 'A', text: 'Over to John.' }, { speakerId: 'B', text: 'Tell me about a launch.' }] },
    { speaker: 'candidate', text: 'Sure.' },
    { speaker: 'interviewer', speakerId: 'B', text: 'Nice.', overlay: true },
    { speaker: 'interviewer', text: 'No id.' },
    { speaker: 'interviewer', speakerId: 'Z', text: 'Unknown id.' },
  ];
  assert.deepEqual(transcriptLines(transcript, { participants }), [
    'Dana Whitfield: Welcome, I am Dana.',
    'Dana Whitfield: Over to John.\nJohn Park: Tell me about a launch.',
    'Candidate: Sure.',
    'John Park: Nice.',
    'Dana Whitfield: No id.',
    'Dana Whitfield: Unknown id.',
  ]);
  assert.equal(transcriptLines([{ speaker: 'interviewer', text: 'Hi.' }], { participants: [{ id: 'A', name: 'Dana Whitfield' }] })[0], 'Dana Whitfield: Hi.', 'a solo call names its one interviewer');
  assert.equal(transcriptLines([{ speaker: 'interviewer', text: 'Hi.' }])[0], 'Interviewer: Hi.', 'with no names known the line reads Interviewer');
  const prompt = draftAnswerPrompt({ ...CONTEXT, participants, transcript });
  assert(prompt.includes('John Park: Tell me about a launch.'));
});

test('the prompt fits the length to the kind of question without cutting realistic stories short', () => {
  const prompt = draftAnswerPrompt(CONTEXT);
  assert(prompt.includes('a story (situation, what you did, the result) in about 80 to 180 words'), 'a story keeps its usual length');
  assert(prompt.includes('Never more than 250 words.'), 'the ceiling is unchanged');
  assert(prompt.includes('A yes/no or one-fact question') && prompt.includes('no story'), 'a one-fact question gets a short direct answer');
  assert(prompt.includes('A follow-up or clarifying question gets the answer first'), 'a follow-up does not start a new story');
  assert(prompt.includes('"briefly", "quick one", "in a sentence"'), 'a request for brevity is honoured');
});

test('prepared answers are offered as ideas to take in a few sentences, not as scripts', () => {
  const prompt = draftAnswerPrompt(CONTEXT);
  assert(prompt.includes('<prepared-answers (your own notes; take the idea from one when it fits, in a few sentences, never the whole thing)>'));
});

test('cleanDraft drops a label and wrapping quotes and keeps within the chat limit at a sentence end', () => {
  assert.equal(cleanDraft('Reply: "Sure, happy to."'), 'Sure, happy to.');
  assert.equal(cleanDraft('Here is where I land.\n\nMy leading explanation is the meter.\n'), 'Here is where I land. My leading explanation is the meter.', 'spoken as one flowing reply');
  assert.equal(cleanDraft('  plain  '), 'plain');
  const long = `${'This is one sentence. '.repeat(150)}`;
  const cleaned = cleanDraft(long);
  assert(cleaned.length <= DRAFT_ANSWER_MAX_CHARS);
  assert(cleaned.endsWith('.'));
  assert.equal(DRAFT_ANSWER_MAX_CHARS, 2000);
});

test('draftCandidateAnswer sends the prompt with the signal and returns the cleaned text; empty or missing calls fail', async () => {
  const seen = [];
  const signal = new AbortController().signal;
  const text = await draftCandidateAnswer({ ...CONTEXT, signal, callText: async request => { seen.push(request); return '"I rebuilt billing at Northwind."'; } });
  assert.equal(text, 'I rebuilt billing at Northwind.');
  assert.equal(seen[0].signal, signal);
  assert(seen[0].prompt.includes('Sam Rivera'));
  await assert.rejects(draftCandidateAnswer({ ...CONTEXT, callText: async () => '   ' }), /empty/);
  await assert.rejects(draftCandidateAnswer({ ...CONTEXT }), /No text call/);
});

test('the stage runs on Sonnet at low effort', () => {
  assert.deepEqual({ ...careerWritingStageProfile(DRAFT_ANSWER_STAGE) }, { model: 'sonnet', effort: 'low' });
});

export default cases;
