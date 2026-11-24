import assert from 'node:assert/strict';
import { cleanDraft, cleanWork, draftAnswerPrompt, draftCandidateAnswer, draftCandidateWork, draftWorkPrompt, transcriptLines, DRAFT_ANSWER_MAX_CHARS, DRAFT_ANSWER_STAGE, DRAFT_WORK_SCHEMA, DRAFT_WORK_STAGE } from '../../electron/practiceCall/draftAnswer.js';
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
  assert(prompt.includes('gets the answer first and the reason after, usually 25 to 60 words'), 'a follow-up does not start a new story');
  assert(!prompt.includes('"quick one"'), 'no quoted phrase to match');
});

test('brevity is its own bullet that overrides the ranges, in both prompts, and the call time is data given only when known', () => {
  const work = { ...CONTEXT, pad: { open: true, lang: 'python', text: '' } };
  for (const prompt of [draftAnswerPrompt(CONTEXT), draftWorkPrompt(work)]) {
    const bullet = prompt.split('\n').find(line => line.startsWith('- When the interviewer asks for something quick or brief'));
    assert(bullet, 'a bullet of its own');
    assert(bullet.includes('the last question') && bullet.includes('nearly over') && bullet.includes('overrides every range'));
    assert(!prompt.includes('<call-time'), 'no timing, no section');
  }
  const timing = { elapsedMs: 283000, plannedMs: 300000, questionMinutes: 1.5 };
  for (const prompt of [draftAnswerPrompt({ ...CONTEXT, timing }), draftWorkPrompt({ ...work, timing })]) {
    assert(prompt.includes('Time on the call so far: 4:43') && prompt.includes('Planned length of the interview: 5:00') && prompt.includes('Time planned for the question being asked: 1.5 minutes'));
    assert(prompt.indexOf('<call-time') < prompt.indexOf('<conversation-so-far>'));
  }
  const partial = draftAnswerPrompt({ ...CONTEXT, timing: { elapsedMs: 60000 } });
  assert(partial.includes('Time on the call so far: 1:00') && !partial.includes('Planned length') && !partial.includes('being asked:'));
});

test('a topic the documents never touch is answered as a prepared candidate would, without disclaiming; consistency stays', () => {
  const prompt = draftAnswerPrompt(CONTEXT);
  assert(prompt.includes('A topic the documents never touch at all') && prompt.includes('without saying it is outside your experience'));
  // call-mwttebvu: the rule says what to do instead of disclaiming.
  assert(prompt.includes('how you would approach or learn it') && prompt.includes('never state that you lack it'));
  assert(prompt.includes('Keep anything you make up consistent with the documents'));
});

test('work: the silent typing budget is given in numbers', () => {
  const prompt = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: 'python', text: '' } });
  assert(prompt.includes('about eight to ten seconds') && prompt.includes('roughly fifty characters') && prompt.includes('one or two short lines'));
  assert(prompt.includes('signature at most') && prompt.includes('never more than about fifty characters typed in silence'));
});

test('prepared answers are offered as ideas to take in a few sentences, not as scripts', () => {
  const prompt = draftAnswerPrompt(CONTEXT);
  assert(prompt.includes('<prepared-answers (your own notes; take the idea from one when it fits, in a few sentences, never the whole thing)>'));
});

test('cleanDraft strips markdown marks from what is said and keeps the words and identifier underscores (call-mwttebvu)', () => {
  assert.equal(cleanDraft('`has` follows the array\'s `object_comparison` setting.'), 'has follows the array\'s object_comparison setting.');
  assert.equal(cleanDraft('It is **really** fast and *quite* simple.'), 'It is really fast and quite simple.');
  assert.equal(cleanDraft('*emphasis* here, and snake_case_name stays, 2 * 3 * 4 too.'), 'emphasis here, and snake_case_name stays, 2 * 3 * 4 too.');
  assert.equal(cleanDraft('the __init__ method and a _private field'), 'the __init__ method and a _private field');
  const work = cleanWork({ waitForReply: false, steps: [
    { say: 'Use `find` here.', code: 'x = `y`', explain: 'before', bridge: null },
    { say: 'Then `done`.', code: 'x = `y`\nz = 1', explain: 'after', bridge: 'Now `next`.' },
  ] });
  assert.equal(work[0].say, 'Use find here.');
  assert.equal(work[1].say, 'Now next.', 'the bridge');
  assert.equal(work[2].say, 'Then done.');
  assert.equal(work[0].code, 'x = `y`', 'code is never touched');
});

test('work: the prompt covers greeting back, no disclaiming and the thanks rule (call-mwttebvu)', () => {
  const prompt = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: 'python', text: '' } });
  assert(prompt.includes('your first line returns the greeting briefly'));
  assert(prompt.includes('never say you lack experience') && prompt.includes('how you would approach or learn it'));
});

test('cleanDraft drops a label and wrapping quotes and keeps within the chat limit at a sentence end', () => {
  assert.equal(cleanDraft('Reply: "Sure, happy to."'), 'Sure, happy to.');
  assert.equal(cleanDraft('Here is where I land.\n\nMy leading explanation is the meter.\n'), 'Here is where I land. My leading explanation is the meter.', 'spoken as one flowing reply');
  assert.equal(cleanDraft('  plain  '), 'plain');
  const long = `${'This is one sentence. '.repeat(150)}`;
  const cleaned = cleanDraft(long);
  assert(cleaned.length <= DRAFT_ANSWER_MAX_CHARS);
  assert(cleaned.endsWith('.'));
  assert.equal(DRAFT_ANSWER_MAX_CHARS, 1100);
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

test('work: the prompt asks for intent before each piece, never code read aloud, a test by hand and a clear finish, from where the pad stands', () => {
  const prompt = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: 'python', text: 'def emittance(x, xp):\n' }, screen: { title: 'Emittance', content: 'Write it.' } });
  for (const rule of ['say in plain English what it will do and why', 'Never read the code aloud', 'walk the given example through by hand', 'that you are done', 'carry on from the code already in the pad', 'the WHOLE pad after that step']) assert(prompt.includes(rule), rule);
  assert(prompt.includes('<coding-pad-now lang="python">\ndef emittance(x, xp):'), 'the pad as it is now');
  assert(prompt.includes('Rebuilt the billing service in Go.') && prompt.includes('Write it.'), 'the same sources as a spoken reply');
  assert(!prompt.includes('<shared-pad>'), 'the pad goes in once');
  assert.deepEqual(DRAFT_WORK_SCHEMA.required, ['waitForReply', 'steps']);
  assert(prompt.includes('set waitForReply true') && prompt.includes('wait for them') && prompt.includes('they will tell you when to go on'), 'a question mid-exercise is answered, then the candidate waits');
  assert.deepEqual(DRAFT_WORK_SCHEMA.properties.steps.items.required, ['say', 'code', 'explain', 'bridge']);
  assert.deepEqual(DRAFT_WORK_SCHEMA.properties.steps.items.properties.explain.enum, ['before', 'during', 'after']);
  for (const choice of ['"before": you say what you are about to write', '"during": you talk while your hands write', '"after": you go quiet and write the piece, then say what you just wrote']) assert(prompt.includes(choice), choice);
  assert(prompt.includes('none is the rule') && prompt.includes('The line always matches its choice'), 'the model chooses per step, and the words fit the choice');
  assert(prompt.includes('One combination needs a bridge') && prompt.includes('It never explains the new piece') && prompt.includes('Every other step has bridge null'), 'two silent stretches back to back get a bridge');
  assert(!/onto the next part/iu.test(prompt), 'no quotable bridge line to repeat');
});

test('work: a language the candidate picked is the only one written, and said once; a required one is simply used', () => {
  const picked = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: '', choice: 'Go', text: '' } });
  assert(picked.includes('you are writing in Go') && picked.includes('Every piece of code you write is Go'), 'the pick is the language');
  assert(picked.includes('Say which language you are using once'), 'said once, in passing');
  assert(picked.includes('<coding-pad-now lang="Go">'));
  const required = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: 'SQL', choice: 'Go', text: '' } });
  assert(required.includes('The exercise asks for SQL') && !required.includes('writing in Go'), 'a required language wins over a pick');
  const none = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: '', choice: '', text: '' } });
  assert(!none.includes('left the language to you') && !none.includes('The exercise asks for'));
  assert(none.includes('the language is yours to choose') && none.includes('Code already in the pad settles it') && none.includes('Say which language you are using once'), 'with none set the writer chooses, staying with what is in the pad');
  assert(!picked.includes('yours to choose') && !required.includes('yours to choose'));
});

test('work: steps are cleaned, empty ones dropped, JSON text parsed, and nothing usable throws', async () => {
  assert.deepEqual(cleanWork({ steps: [{ say: ' First.\n\nThen. ', code: 'a\r\nb', typeWhileSpeaking: true }, { say: '', code: null }, { say: 'Done.', code: null, typeWhileSpeaking: true }] }),
    [{ say: 'First. Then.', code: 'a\nb', order: 'during', together: true }, { say: 'Done.', code: null, order: 'before', together: false }], 'typing while talking needs both a line and code');
  assert.deepEqual(cleanWork('```json\n{"steps":[{"say":"Hi.","code":null}]}\n```'), [{ say: 'Hi.', code: null, order: 'before', together: false }]);
  // The three choices, and what an order means without a line or without code.
  assert.deepEqual(cleanWork({ steps: [{ say: 'A.', code: 'a', explain: 'before' }, { say: 'B.', code: 'ab', explain: 'during' }, { say: 'C.', code: 'abc', explain: 'after' }, { say: 'D.', code: null, explain: 'after' }, { say: '', code: 'abcd', explain: 'during' }, { say: 'E.', code: 'abcde', explain: 'sideways' }] }).map(step => [step.order, step.together]),
    [['before', false], ['during', true], ['after', false], ['before', false], ['before', false], ['before', false]]);
  // A piece typed in silence straight after a piece typed in silence: the bridge is said between them, as its own line.
  assert.deepEqual(cleanWork({ steps: [{ say: 'First the mask.', code: 'a', explain: 'before', bridge: null }, { say: 'That cleared the field.', code: 'ab', explain: 'after', bridge: ' Right, the other half. ' }] }),
    [{ say: 'First the mask.', code: 'a', order: 'before', together: false }, { say: 'Right, the other half.', code: null, order: 'before', together: false }, { say: 'That cleared the field.', code: 'ab', order: 'after', together: false }]);
  assert.deepEqual(cleanWork({ steps: [{ say: 'First the mask.', code: 'a', explain: 'before' }, { say: 'That cleared the field.', code: 'ab', explain: 'after', bridge: null }] }).map(step => [step.say, step.order]),
    [['First the mask.', 'before'], ['That cleared the field.', 'during']], 'with no bridge written the piece is explained while it is typed, never after a second silence');
  assert.deepEqual(cleanWork({ steps: [{ say: 'Talk only.', code: null, explain: 'before' }, { say: 'Wrote it.', code: 'a', explain: 'after', bridge: 'Moving on.' }, { say: 'And this.', code: 'ab', explain: 'after', bridge: 'Next.' }] }).map(step => step.say),
    ['Talk only.', 'Wrote it.', 'And this.'], 'a bridge is dropped where no silent typing came just before');
  assert.throws(() => cleanWork({ steps: [] }));
  assert.throws(() => cleanWork('not json'));
  assert.deepEqual(cleanWork({ waitForReply: true, steps: [{ say: 'Positivity keeps the sum monotonic.', code: 'def f():\n', typeWhileSpeaking: true }, { say: 'Now the loop.', code: 'def f():\n    pass\n', typeWhileSpeaking: false }] }),
    [{ say: 'Positivity keeps the sum monotonic.', code: null, order: 'before', together: false }], 'an answer to a question is said hands off the keyboard, and nothing follows it');
  assert.equal(cleanWork({ waitForReply: false, steps: [{ say: 'Fixed.', code: 'a', typeWhileSpeaking: false }, { say: 'Next.', code: 'ab', typeWhileSpeaking: false }] }).length, 2, 'otherwise the work carries on');
  const asked = [];
  const steps = await draftCandidateWork({ ...CONTEXT, pad: { open: true, text: '' }, callText: async request => { asked.push(request); return { steps: [{ say: 'Go.', code: 'x = 1\n' }] }; } });
  assert.deepEqual(steps, [{ say: 'Go.', code: 'x = 1\n', order: 'before', together: false }]);
  assert.equal(asked[0].schema, DRAFT_WORK_SCHEMA);
});

test('work: a technical spoken reply leads with the answer and never reads a matrix out element by element', () => {
  const prompt = draftAnswerPrompt(CONTEXT);
  assert(prompt.includes('answer only the part or bullet being asked about now'));
  assert(prompt.includes('never reading it out element by element'));
});

test('transcript: the candidate\'s own voiced line is shown as it was heard (sentText), falling back to its text', () => {
  const lines = transcriptLines([
    { speaker: 'candidate', voiced: true, text: 'The immutable boot ROM checks it.', sentText: 'The mutable boot rom checks it.' },
    { speaker: 'candidate', text: 'Typed text.' },
    { speaker: 'candidate', text: 'Whole line.', sentText: '   ' },
  ]);
  assert.deepEqual(lines, ['Candidate: The mutable boot rom checks it.', 'Candidate: Typed text.', 'Candidate: Whole line.']);
});

test('both prompts share the spoken-not-notes rule and the realism options, with no quotable example sentences', () => {
  const reply = draftAnswerPrompt(CONTEXT);
  const work = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: 'python', text: '' } });
  for (const prompt of [reply, work]) {
    assert(prompt.includes('no sentence opens with a short label and a colon'), 'the label rule');
    assert(prompt.includes('is not said again') && prompt.includes('your own earlier lines'), 'no repeated framing');
    assert(prompt.includes('is for when the interviewer really did catch something'), 'praise only when earned');
    assert(prompt.includes('Thanking the interviewers for their time') && prompt.includes('once, when the call is actually closing'), 'thanks once, at the close');
    assert(prompt.includes('rather than reciting every digit') && prompt.includes('says hexadecimal the way engineers say it aloud'), 'values aloud');
    assert(prompt.includes('follow-up or one-fact question gets a short answer'), 'size follows the question');
    // call-mwttebvu: a 41 s answer to a one-minute question with the exercise still to come.
    assert(prompt.includes('planned minutes below are small while more of the interview is still to come'), 'small planned minutes with more to come');
    // call-mwttebvu: a joined colleague's greeting went unanswered; the thanks at the questions invitation was repeated at goodbye.
    assert(prompt.includes('has just greeted you, or has just joined the call and been introduced') && prompt.includes('returns the greeting briefly before anything else'), 'greeting returned');
    assert(prompt.includes('An invitation to ask them questions is not the close') && prompt.includes('not said again in the same words or at length'), 'invitation is not the close');
  }
  for (const quoted of ['Short version', 'Leading explanation', 'I think that\'s it', 'Happy to go through', 'assume the arrays', 'centre the coordinates', 'x equals x minus', 'about 170 kilograms', 'two point nine amps']) {
    assert(!reply.includes(quoted) && !work.includes(quoted), `no quotable example: ${quoted}`);
  }
});

test('questions to the interviewers and the goodbye are separate turns, and a work line and its code fit together (call-mwuj4kjg)', () => {
  const reply = draftAnswerPrompt(CONTEXT);
  assert(reply.includes('A turn that asks them something ends on the question') && reply.includes('Those come in a later turn of their own'));
  assert(reply.includes('ask one at a time') && reply.includes('How many you ask in all is yours to judge'));
  const work = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: 'ruby', text: '' } });
  assert(work.includes('at most about ninety characters') && !work.includes('about 50 words') && !work.includes('a hundred and ten characters'), 'no piece that needs a line longer than the line limit');
  assert(work.includes('waitForReply is false and the step carries the smallest fix in place'), 'a fix agreed to can be made');
  assert(work.includes('name a specific method or behaviour only when you are sure'));
});

test('work: the prompt keeps words and typing in step: the line is about its own code, with the real pace, and the pad is only added to', () => {
  const prompt = draftWorkPrompt({ ...CONTEXT, pad: { open: true, lang: 'python', text: '' } });
  assert(prompt.includes('A step\'s line is about the code that same step types') && prompt.includes('an earlier step already typed') && prompt.includes('a later piece'));
  assert(prompt.includes('five to six characters a second') && prompt.includes('each spoken word covers about two typed characters') && prompt.includes('two and a half words a second'));
  assert(prompt.includes('either say more about that piece while you type it') && prompt.includes('split the piece'));
  assert(prompt.includes('only added to, in order, unless you are fixing something'));
  assert(prompt.includes('ten seconds or more'), 'the silence guidance stays');
  assert(prompt.includes('that you are done and are ready for their questions'), 'the finish is still said plainly, in the candidate\'s words, in the last step only');
  const props = DRAFT_WORK_SCHEMA.properties.steps.items.properties;
  assert(props.say.description.includes('this same step types'));
  assert(props.code.description.includes('only added to, in order'));
  assert(props.explain.description.includes('"during": type while saying the line') && props.bridge.description.includes('without saying what it is'));
});

test('work: the stage runs on Opus at low effort', () => {
  assert.deepEqual({ ...careerWritingStageProfile(DRAFT_WORK_STAGE) }, { model: 'opus', effort: 'low' });
});

export default cases;
