import assert from 'node:assert/strict';
import { generateInterviewTopics, INTERVIEW_TOPICS_SCHEMA, INTERVIEW_TOPICS_STAGE, interviewTopicsPrompt, validateInterviewTopics } from '../../electron/ipc/interviewQaTopics.js';

const brief = { role: { title: 'Backend Engineer', company: 'Acme' }, roleThemes: ['Distributed systems'] };

export default [
  { name: 'interview topics: the prompt names the role, wraps the listing and questions as data and numbers the questions', run() {
    const prompt = interviewTopicsPrompt({ brief, listingText: 'We use Postgres and Go.', questions: ['Design a rate limiter.', 'Why Acme?'] });
    assert(prompt.includes('Backend Engineer at Acme') && prompt.includes('We use Postgres and Go.') && prompt.includes('Distributed systems'));
    assert(prompt.includes('1. Design a rate limiter.') && prompt.includes('2. Why Acme?'));
    assert(/<untrusted-interview-topics-listing-[a-f0-9]+>/u.test(prompt) && /<untrusted-interview-topics-questions-[a-f0-9]+>/u.test(prompt), 'listing and questions sit inside untrusted boundaries');
    assert(prompt.includes('TASK 1, "topics": list the technical topics'), 'the list task is asked when needed');
    const noList = interviewTopicsPrompt({ brief, listingText: 'x', needList: false, questions: [] });
    assert(noList.includes('TASK 1, "topics": return an empty list. The topic list for this job already exists.') && noList.includes('TASK 2, "technical": return an empty list.') && noList.includes('(none)'));
    assert.equal(INTERVIEW_TOPICS_STAGE, 'qa-technical-topics');
    assert.deepEqual(INTERVIEW_TOPICS_SCHEMA.required, ['topics', 'technical']);
  } },
  { name: 'interview topics: the prompt quotes no sample topic and still says what a topic is', run() {
    const prompt = interviewTopicsPrompt({ brief, listingText: 'x', questions: [] });
    assert(!prompt.includes('REST API design') && !prompt.includes('Example of the form'), 'no sample topic to copy');
    assert(prompt.includes('A topic is a subject in 1 to 6 words, not a question and not a sentence.') && !prompt.includes('taken from this job') && prompt.includes('the subject the numbered question tests')
      && prompt.includes('Return JSON {"topics":["..."],"technical":[{"number":1,"topic":"..."}]}.'), 'the topic form and the output format stay');
  } },
  { name: 'interview topics: validation trims, de-duplicates, caps and maps numbers to the offered questions', run() {
    const questions = ['Design a rate limiter.', 'Why Acme?'];
    const result = validateInterviewTopics({
      topics: ['  REST   API design ', 'rest api design', '', 42, 'x'.repeat(161), 'Caching', ...Array.from({ length: 20 }, (_, index) => `Topic ${index}`)],
      technical: [{ number: 1, topic: 'Rate limiting' }, { number: 1, topic: 'Duplicate number' }, { number: 3, topic: 'Out of range' }, { number: 2, topic: '' }, { number: 'x', topic: 'Bad' }, null],
    }, { questions });
    assert.equal(result.topics.length, 15, 'at most 15 topics');
    assert.deepEqual(result.topics.slice(0, 2), ['REST API design', 'Caching']);
    assert.deepEqual(result.technical, [{ question: 'Design a rate limiter.', topic: 'Rate limiting' }]);
    assert.throws(() => validateInterviewTopics({ technical: [] }), /topics must be an array/u);
    assert.throws(() => validateInterviewTopics(null), /topics must be an array/u);
    assert.deepEqual(validateInterviewTopics({ topics: ['A topic'] }).technical, [], 'a missing technical list is empty');
  } },
  { name: 'interview topics: generateInterviewTopics makes one call on the qa-technical-topics stage and drops the list when it was not wanted', async run() {
    const calls = [];
    const callText = async (prompt, options) => {
      calls.push(options);
      const value = { topics: ['Go concurrency'], technical: [{ number: 1, topic: 'Rate limiting' }] };
      options.responseValidator(value);
      return value;
    };
    const wanted = await generateInterviewTopics({ brief, listingText: 'Go', questions: ['Design a rate limiter.'], callText });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].claudeStage, 'qa-technical-topics'); assert.equal(calls[0].task, 'interview-technical-topics'); assert.equal(calls[0].responseSchema, INTERVIEW_TOPICS_SCHEMA);
    assert.deepEqual(wanted, { topics: ['Go concurrency'], technical: [{ question: 'Design a rate limiter.', topic: 'Rate limiting' }] });
    const unwanted = await generateInterviewTopics({ brief, listingText: 'Go', needList: false, questions: ['Design a rate limiter.'], callText });
    assert.deepEqual(unwanted.topics, [], 'an existing list is not extended');
    assert.equal(unwanted.technical.length, 1);
    assert.throws(() => calls[0].responseValidator({ nope: 1 }), /topics must be an array/u, 'the transport validator refuses a malformed reply');
    await assert.rejects(generateInterviewTopics({ brief, listingText: '' }), TypeError);
  } },
];
