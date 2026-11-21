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
  assert(prompt.includes('make up plausible, specific details'));
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

test('cleanDraft drops a label and wrapping quotes and keeps within the chat limit at a sentence end', () => {
  assert.equal(cleanDraft('Reply: "Sure, happy to."'), 'Sure, happy to.');
  assert.equal(cleanDraft('Here is where I land.\n\nMy leading explanation is the meter.\n'), 'Here is where I land. My leading explanation is the meter.', 'spoken as one flowing reply');
  assert.equal(cleanDraft('  plain  '), 'plain');
  const long = `${'This is one sentence. '.repeat(150)}`;
  const cleaned = cleanDraft(long);
  assert(cleaned.length <= DRAFT_ANSWER_MAX_CHARS);
  assert(cleaned.endsWith('.'));
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
