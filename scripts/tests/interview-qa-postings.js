import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addInterviewQaCard, addInterviewQaTopic, bindInterviewQaPosting, deleteInterviewQaTopic, fillInterviewQaTopics,
  interviewQaPostingKey, interviewQaStoreKey, interviewQaTopicId, loadInterviewQa, loadInterviewQaTopics,
} from '../../electron/ipc/interviewQaStore.js';

async function userData(fn) {
  const directory = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-qa-postings-')));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}
const card = question => ({ question, variants: [], headline: 'A headline.', bullets: [], example: '', extensions: [] });
const companyQuestions = async (dir, nodeId) => (await loadInterviewQa({ userDataPath: dir, nodeId })).company.cards.map(item => item.question);
const KEY_A = interviewQaPostingKey({ company: 'Acme', jobUrl: 'https://jobs.example.test/1', title: 'Engineer' });
const KEY_B = interviewQaPostingKey({ company: 'Acme', jobUrl: 'https://jobs.example.test/2', title: 'Engineer' });

export default [
  { name: 'interview Q&A postings: the key follows company, link and title, and needs a link', run() {
    assert.match(KEY_A, /^[a-f0-9]{64}$/u);
    assert.notEqual(KEY_A, KEY_B, 'the same title at different links is a different posting');
    assert.equal(KEY_A, interviewQaPostingKey({ company: 'ACME, Inc.', jobUrl: ' https://jobs.example.test/1 ', title: 'engineer' }), 'company suffix, case and spacing do not matter');
    assert.notEqual(KEY_A, interviewQaPostingKey({ company: 'Acme', jobUrl: 'https://jobs.example.test/1', title: 'Designer' }), 'the title is part of the identity');
    assert.equal(interviewQaPostingKey({ company: 'Acme', jobUrl: '', title: 'Engineer' }), null, 'no link, no posting');
  } },
  { name: 'interview Q&A postings: the first bind adopts the interview set and a later node shares it without overwriting', async run() {
    await userData(async dir => {
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'node-1', scope: 'company', card: card('Why Acme?') });
      assert.equal(await interviewQaStoreKey({ userDataPath: dir, nodeId: 'node-1' }), 'node-1', 'an unbound interview files under its own id');
      const first = await bindInterviewQaPosting({ userDataPath: dir, nodeId: 'node-1', postingKey: KEY_A });
      assert.deepEqual(first, { adopted: true, storeKey: `posting:${KEY_A}` });
      assert.deepEqual(await companyQuestions(dir, 'node-1'), ['Why Acme?'], 'the interview keeps the cards it already had');
      assert.equal(await bindInterviewQaPosting({ userDataPath: dir, nodeId: 'node-1', postingKey: KEY_A }), false, 'binding again changes nothing');
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'node-2', scope: 'company', card: card('A private question') });
      const second = await bindInterviewQaPosting({ userDataPath: dir, nodeId: 'node-2', postingKey: KEY_A });
      assert.deepEqual(second, { adopted: false, storeKey: `posting:${KEY_A}` }, 'a later node does not overwrite the posting set');
      assert.deepEqual(await companyQuestions(dir, 'node-2'), ['Why Acme?'], 'the later node now reads the shared set');
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'node-2', scope: 'company', card: card('Added from node 2') });
      assert.deepEqual(await companyQuestions(dir, 'node-1'), ['Why Acme?', 'Added from node 2'], 'a write from one node shows in the other');
    });
  } },
  { name: 'interview Q&A postings: an unbound node keeps its own set and different postings keep separate sets', async run() {
    await userData(async dir => {
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'solo', scope: 'company', card: card('Only mine') });
      await bindInterviewQaPosting({ userDataPath: dir, nodeId: 'a', postingKey: KEY_A });
      await bindInterviewQaPosting({ userDataPath: dir, nodeId: 'b', postingKey: KEY_B });
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'a', scope: 'company', card: card('Posting A question') });
      assert.deepEqual(await companyQuestions(dir, 'solo'), ['Only mine']);
      assert.deepEqual(await companyQuestions(dir, 'a'), ['Posting A question']);
      assert.deepEqual(await companyQuestions(dir, 'b'), [], 'a posting with the same title but another link has its own set');
      assert.equal(await interviewQaStoreKey({ userDataPath: dir, nodeId: 'solo' }), 'solo');
      assert.notEqual(await interviewQaStoreKey({ userDataPath: dir, nodeId: 'a' }), await interviewQaStoreKey({ userDataPath: dir, nodeId: 'b' }));
      assert.equal(await bindInterviewQaPosting({ userDataPath: dir, nodeId: 'a', postingKey: 'not-a-key' }), false, 'a malformed key binds nothing');
    });
  } },
  { name: 'interview Q&A postings: bindings survive a restart', async run() {
    await userData(async dir => {
      await bindInterviewQaPosting({ userDataPath: dir, nodeId: 'a', postingKey: KEY_A });
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'a', scope: 'company', card: card('Kept') });
      const aliasFile = path.join(dir, 'interview-helper-qa', 'company', 'aliases.json');
      assert.equal(JSON.parse(await fs.promises.readFile(aliasFile, 'utf8')).aliases.a, KEY_A);
      assert.equal((await fs.promises.stat(aliasFile)).mode & 0o077, 0, 'private file');
    });
  } },
  { name: 'interview Q&A topics: add, duplicate, delete, and the 40 limit', async run() {
    await userData(async dir => {
      const added = await addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: '  SQL   query tuning ' });
      assert.deepEqual(added.topics.map(({ text, author }) => [text, author]), [['SQL query tuning', 'user']], 'a topic is trimmed and marked as the user\'s');
      assert.equal(added.topics[0].id, interviewQaTopicId('sql query tuning'), 'the id follows the normalised text');
      await assert.rejects(addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: 'sql QUERY tuning' }), /already listed/u);
      await assert.rejects(addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: '   ' }), /Write a topic/u);
      await assert.rejects(addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: 'x'.repeat(161) }), /Write a topic/u);
      const after = await deleteInterviewQaTopic({ userDataPath: dir, nodeId: 'n', topicId: added.topics[0].id });
      assert.deepEqual(after.topics, []);
      await assert.rejects(deleteInterviewQaTopic({ userDataPath: dir, nodeId: 'n', topicId: added.topics[0].id }), /no longer listed/u);
      for (let index = 0; index < 40; index += 1) await addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: `Topic number ${index}` });
      await assert.rejects(addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: 'One too many' }), /at most 40/u);
      assert.equal((await loadInterviewQaTopics({ userDataPath: dir, nodeId: 'n' })).length, 40);
      assert.equal((await loadInterviewQa({ userDataPath: dir, nodeId: 'n' })).company.topics.length, 40, 'the company section carries the topics');
    });
  } },
  { name: 'interview Q&A topics: generation runs once, a deleted generated topic stays deleted and user topics survive', async run() {
    await userData(async dir => {
      await addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: 'My own topic' });
      const calls = [];
      const generate = async args => { calls.push(args); return { topics: ['REST API design', 'Caching', 'my own topic'], technical: [] }; };
      const first = await fillInterviewQaTopics({ userDataPath: dir, nodeId: 'n', generate });
      assert.equal(first.generated, true); assert.deepEqual(calls, [{ needList: true, questions: [] }]);
      assert.deepEqual(first.topics.map(topic => [topic.text, topic.author]), [['My own topic', 'user'], ['REST API design', 'generated'], ['Caching', 'generated']], 'a topic the user already has is not added twice');
      const second = await fillInterviewQaTopics({ userDataPath: dir, nodeId: 'n', generate });
      assert.equal(calls.length, 1, 'the second call does not call generate');
      assert.deepEqual([second.generated, second.converted], [false, 0]);
      const caching = first.topics.find(topic => topic.text === 'Caching');
      await deleteInterviewQaTopic({ userDataPath: dir, nodeId: 'n', topicId: caching.id });
      await fillInterviewQaTopics({ userDataPath: dir, nodeId: 'n', generate });
      assert.deepEqual((await loadInterviewQaTopics({ userDataPath: dir, nodeId: 'n' })).map(topic => topic.text), ['My own topic', 'REST API design'], 'a deleted generated topic is not re-added and the user topic survives');
      await addInterviewQaTopic({ userDataPath: dir, nodeId: 'n', text: 'Caching' });
      assert((await loadInterviewQaTopics({ userDataPath: dir, nodeId: 'n' })).some(topic => topic.text === 'Caching'), 'adding it by hand lifts the deletion');
    });
  } },
  { name: 'interview Q&A topics: a reported unanswered technical question becomes a topic and its card is removed for good', async run() {
    await userData(async dir => {
      const { fillInterviewQaFromPreparation } = await import('../../electron/ipc/interviewQaStore.js');
      const bank = { cards: [] };
      const mapping = [
        { question: 'Design a rate limiter.', sourceUrl: 'https://example.test/c', sourceDate: 'unknown', evidenceQuote: 'q', target: 'none', cardQuestion: '' },
        { question: 'Why Acme?', sourceUrl: 'https://example.test/b', sourceDate: '2026', evidenceQuote: 'q2', target: 'none', cardQuestion: '' },
      ];
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'n', bank, company: 'Acme', disclosureMapping: mapping });
      const seen = [];
      const generate = async ({ needList, questions }) => { seen.push(questions); return { topics: [], technical: [{ question: 'Design a rate limiter.', topic: 'Rate limiting' }], needList }; };
      const result = await fillInterviewQaTopics({ userDataPath: dir, nodeId: 'n', generate });
      assert.equal(result.converted, 1);
      assert.deepEqual(seen[0].slice().sort(), ['Design a rate limiter.', 'Why Acme?']);
      assert.deepEqual(await companyQuestions(dir, 'n'), ['Why Acme?']);
      assert.deepEqual((await loadInterviewQaTopics({ userDataPath: dir, nodeId: 'n' })).map(topic => topic.text), ['Rate limiting']);
    });
  } },
];
