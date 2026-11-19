import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerInterviewPreparationHandlers, validateInterviewPrepareArgs } from '../../electron/ipc/interviewPreparation.js';
import { addInterviewQaCard, interviewQaPostingKey, interviewQaStoreKey } from '../../electron/ipc/interviewQaStore.js';
import { createQuestionHistory } from '../../electron/practiceCall/questionHistory.js';

const SNAPSHOT = 'a'.repeat(64);
const BUNDLE = 'b'.repeat(64);
const URL_A = 'https://jobs.example.test/role-a';
const noAi = { callText: async () => { throw new Error('no AI in this suite'); }, callRaw: async () => { throw new Error('no AI in this suite'); } };

async function withHandlers(fn, { bundles = {} } = {}) {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-qa-handlers-')));
  const handlers = new Map(); const validators = new Map(); const warnings = [];
  const counts = new Map(); const adopted = []; const recorded = [];
  const questionCounts = {
    counts: async key => ({ ...(counts.get(key) || {}) }),
    record: async (key, ids) => { recorded.push([key, ids]); },
    adopt: async (from, to) => { adopted.push([from, to]); if (counts.has(from) && !counts.has(to)) { counts.set(to, { ...counts.get(from) }); return true; } return false; },
  };
  registerInterviewPreparationHandlers({
    appInstance: { getPath: () => root }, aiTransport: noAi, questionCounts, logWarning: message => warnings.push(message),
    registerHandler: (channel, handler, options) => { handlers.set(channel, handler); validators.set(channel, options?.validateArgs); },
    loadBundle: async ({ artifactId }) => bundles[artifactId] ?? null,
  });
  try { return await fn({ root, call: (channel, args) => handlers.get(channel)({}, args), validators, counts, adopted, recorded, warnings }); }
  finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}
const card = question => ({ question, variants: [], headline: 'A headline.', bullets: [], example: '', extensions: [] });
const qaArgs = (extra = {}) => ({ nodeId: 'node-1', snapshotId: null, canonicalJobUrl: null, bundleArtifactId: null, ...extra });
const bundleFor = company => ({ job: { company, title: 'Engineer' } });

export default [
  { name: 'interview Q&A handlers: load-interview-qa validates the four keys strictly', async run() {
    await withHandlers(async ({ validators }) => {
      const validate = validators.get('load-interview-qa');
      validate(qaArgs()); validate(qaArgs({ snapshotId: SNAPSHOT, canonicalJobUrl: URL_A, bundleArtifactId: BUNDLE }));
      for (const bad of [{ nodeId: 'node-1' }, qaArgs({ extra: 1 }), qaArgs({ snapshotId: 'short' }), qaArgs({ canonicalJobUrl: 'https://jobs.example.test/x?utm_source=y#frag' }), qaArgs({ bundleArtifactId: 'nope' }), qaArgs({ nodeId: 'bad id!' })]) {
        assert.throws(() => validate(bad), TypeError, JSON.stringify(bad));
      }
      assert.throws(() => validators.get('add-interview-qa-topic')({ nodeId: 'node-1' }), TypeError);
      assert.throws(() => validators.get('add-interview-qa-topic')({ nodeId: 'node-1', text: 'x', extra: 1 }), TypeError);
      assert.throws(() => validators.get('delete-interview-qa-topic')({ nodeId: 'node-1', topicId: 'topic-xyz' }), TypeError);
      validators.get('delete-interview-qa-topic')({ nodeId: 'node-1', topicId: 'topic-0123456789ab' });
      validateInterviewPrepareArgs({ nodeId: 'node-1', snapshotId: SNAPSHOT, canonicalJobUrl: URL_A, bundleArtifactId: BUNDLE, manualAiRunId: 'interview-helper:prepare:1' });
      validateInterviewPrepareArgs({ nodeId: 'node-1', snapshotId: SNAPSHOT, canonicalJobUrl: URL_A, bundleArtifactId: BUNDLE, manualAiRunId: 'interview-helper:prepare:1', reuseExisting: true });
      assert.throws(() => validateInterviewPrepareArgs({ nodeId: 'node-1', snapshotId: SNAPSHOT, canonicalJobUrl: URL_A, bundleArtifactId: BUNDLE, manualAiRunId: 'interview-helper:prepare:1', reuseExisting: 1 }), TypeError);
    });
  } },
  { name: 'interview Q&A handlers: load-interview-qa returns cards and topics with practiced counts from the right buckets', async run() {
    await withHandlers(async ({ root, call, counts }) => {
      await call('add-interview-qa-topic', { nodeId: 'node-1', text: 'SQL tuning' });
      const topics = (await call('load-interview-qa', qaArgs())).company.topics;
      await addInterviewQaCard({ userDataPath: root, nodeId: 'node-1', scope: 'company', card: card('Why Acme?') });
      await addInterviewQaCard({ userDataPath: root, nodeId: 'node-1', scope: 'foundation', card: card('Tell me about yourself.') });
      const before = await call('load-interview-qa', qaArgs());
      const general = before.foundation.cards[0]; const own = before.company.cards[0];
      assert.deepEqual([general.practiced, own.practiced, before.company.topics[0].practiced], [0, 0, 0], 'never practised reads as zero');
      counts.set('general', { [general.id]: 3, [own.id]: 9 });
      counts.set('node-1', { [own.id]: 2, [topics[0].id]: 4, [general.id]: 7 });
      const after = await call('load-interview-qa', qaArgs());
      assert.equal(after.foundation.cards[0].practiced, 3, 'General cards count from the general bucket');
      assert.equal(after.company.cards[0].practiced, 2, 'company cards count from the store key bucket');
      assert.equal(after.company.topics[0].practiced, 4, 'topics count from the store key bucket');
      assert.equal(after.company.topics[0].text, 'SQL tuning');
    });
  } },
  { name: 'interview Q&A handlers: both keys bind the posting, node-2 shares the set, and the first bind moves its counts', async run() {
    await withHandlers(async ({ root, call, counts, adopted }) => {
      await addInterviewQaCard({ userDataPath: root, nodeId: 'node-1', scope: 'company', card: card('Why Acme?') });
      const own = (await call('load-interview-qa', qaArgs())).company.cards[0];
      counts.set('node-1', { [own.id]: 5 });
      const keys = { snapshotId: SNAPSHOT, canonicalJobUrl: URL_A, bundleArtifactId: BUNDLE };
      const first = await call('load-interview-qa', qaArgs(keys));
      const postingKey = interviewQaPostingKey({ company: 'Acme', jobUrl: URL_A, title: 'Engineer' });
      assert.equal(await interviewQaStoreKey({ userDataPath: root, nodeId: 'node-1' }), `posting:${postingKey}`, 'the interview is now filed under its posting');
      assert.deepEqual(adopted, [['node-1', `posting:${postingKey}`]], 'the first bind hands the interview counts to the posting');
      assert.equal(first.company.cards[0].practiced, 5, 'the adopted counts show on the shared set');
      const second = await call('load-interview-qa', qaArgs({ ...keys, nodeId: 'node-2' }));
      assert.deepEqual(second.company.cards.map(item => item.question), ['Why Acme?'], 'a second interview for the posting shares the set');
      assert.equal(adopted.length, 1, 'a later node adopts no counts');
      assert.equal(second.company.cards[0].practiced, 5);
    }, { bundles: { [BUNDLE]: bundleFor('Acme') } });
  } },
  { name: 'interview Q&A handlers: only one of the two posting keys binds nothing', async run() {
    await withHandlers(async ({ root, call, warnings }) => {
      await addInterviewQaCard({ userDataPath: root, nodeId: 'node-1', scope: 'company', card: card('Why Acme?') });
      await call('load-interview-qa', qaArgs({ canonicalJobUrl: URL_A }));
      await call('load-interview-qa', qaArgs({ bundleArtifactId: BUNDLE }));
      assert.equal(await interviewQaStoreKey({ userDataPath: root, nodeId: 'node-1' }), 'node-1');
      assert(Array.isArray(warnings));
    });
  } },
  { name: 'interview Q&A handlers: add and delete topic return the topic list with practiced counts', async run() {
    await withHandlers(async ({ call, counts }) => {
      const added = await call('add-interview-qa-topic', { nodeId: 'node-1', text: 'Kubernetes basics' });
      assert.deepEqual(added.topics.map(({ text, author, practiced }) => [text, author, practiced]), [['Kubernetes basics', 'user', 0]]);
      counts.set('node-1', { [added.topics[0].id]: 2 });
      const second = await call('add-interview-qa-topic', { nodeId: 'node-1', text: 'Terraform' });
      assert.deepEqual(second.topics.map(topic => [topic.text, topic.practiced]), [['Kubernetes basics', 2], ['Terraform', 0]]);
      await assert.rejects(call('add-interview-qa-topic', { nodeId: 'node-1', text: 'terraform' }), /already listed/u);
      const left = await call('delete-interview-qa-topic', { nodeId: 'node-1', topicId: added.topics[0].id });
      assert.deepEqual(left.topics.map(topic => topic.text), ['Terraform']);
      await assert.rejects(call('delete-interview-qa-topic', { nodeId: 'node-1', topicId: added.topics[0].id }), /no longer listed/u);
    });
  } },
  { name: 'interview Q&A handlers: clear all validates strictly and empties the cards of one scope or the topics', async run() {
    await withHandlers(async ({ root, call, validators }) => {
      validators.get('clear-interview-qa-cards')({ nodeId: 'node-1', scope: 'foundation' });
      validators.get('clear-interview-qa-topics')({ nodeId: 'node-1' });
      for (const bad of [{ nodeId: 'node-1' }, { nodeId: 'node-1', scope: 'topics' }, { nodeId: 'bad id!', scope: 'company' }, { nodeId: 'node-1', scope: 'company', extra: 1 }]) assert.throws(() => validators.get('clear-interview-qa-cards')(bad), TypeError, JSON.stringify(bad));
      for (const bad of [{}, { nodeId: 'bad id!' }, { nodeId: 'node-1', scope: 'company' }]) assert.throws(() => validators.get('clear-interview-qa-topics')(bad), TypeError, JSON.stringify(bad));
      await addInterviewQaCard({ userDataPath: root, nodeId: 'node-1', scope: 'company', card: card('Why Acme?') });
      await addInterviewQaCard({ userDataPath: root, nodeId: 'node-1', scope: 'foundation', card: card('Tell me about yourself.') });
      await call('add-interview-qa-topic', { nodeId: 'node-1', text: 'Terraform' });
      assert.deepEqual((await call('clear-interview-qa-cards', { nodeId: 'node-1', scope: 'foundation' })).cards, []);
      assert.deepEqual((await call('clear-interview-qa-topics', { nodeId: 'node-1' })).topics, []);
      const after = await call('load-interview-qa', qaArgs());
      assert.deepEqual([after.foundation.cards.length, after.company.cards.length, after.company.topics.length], [0, 1, 0]);
    });
  } },
  { name: 'interview Q&A handlers: a broken counts file reads as never practised', async run() {
    const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-qa-handlers-broken-')));
    try {
      const handlers = new Map();
      registerInterviewPreparationHandlers({ appInstance: { getPath: () => root }, aiTransport: noAi, registerHandler: (channel, handler) => handlers.set(channel, handler),
        questionCounts: { counts: async () => { throw new Error('unreadable'); }, record: async () => {}, adopt: async () => false } });
      await addInterviewQaCard({ userDataPath: root, nodeId: 'node-1', scope: 'foundation', card: card('Tell me about yourself.') });
      const reply = await handlers.get('load-interview-qa')({}, qaArgs());
      assert.equal(reply.foundation.cards[0].practiced, 0);
      // The default store is the real question history file under the user data folder.
      const history = createQuestionHistory({ filePath: path.join(root, 'practice-question-history.json') });
      await history.record('general', ['g1']); await history.record('node-x', ['c1']);
      assert.equal(await history.adopt('node-x', 'posting:abc'), true);
      assert.deepEqual(await history.counts('posting:abc'), { c1: 1 });
      assert.equal(await history.adopt('node-x', 'posting:abc'), false, 'a key that already has counts keeps them');
      assert.equal(await history.adopt('missing', 'posting:def'), false);
    } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
  } },
  { name: 'interview typed job: the default page reader is a plain fetch, then the Parallel reader, with no rendered-browser step', async run() {
    const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-typed-reader-')));
    try {
      const handlers = new Map(); const composed = [];
      const typedJob = {
        composeReadPage: options => { composed.push(options); return async () => ({ ok: false }); },
        resolveTypedJob: async ({ readPage }) => { assert.equal(typeof readPage, 'function'); return { kind: 'generated', job: { title: 'Engineer', company: 'Acme', location: 'Remote' }, organization: 'Acme', listingText: 'A listing.', jobUrl: URL_A, notes: [] }; },
      };
      registerInterviewPreparationHandlers({ appInstance: { getPath: () => root }, aiTransport: noAi, typedJob, registerHandler: (channel, handler) => handlers.set(channel, handler),
        publishTypedBundle: async () => ({ bundle: { artifactId: BUNDLE }, jobUrl: URL_A }) });
      const reply = await handlers.get('resolve-interview-typed-job')({}, { nodeId: 'node-1', text: 'Engineer at Acme' });
      assert.equal(reply.kind, 'generated');
      assert.deepEqual(Object.keys(composed[0]).sort(), ['fetchPage', 'readerPage'], 'no renderPage is wired');
      assert.equal(typeof composed[0].fetchPage, 'function'); assert.equal(typeof composed[0].readerPage, 'function');
    } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
  } },
];
