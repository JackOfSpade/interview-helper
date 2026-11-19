import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { careerWritingStageProfile } from '../../electron/ipc/careerWritingCore.js';
import { gapAdmissionFailure, gapCareerPieces, gapClosestFailure, generateInterviewGapAnswers, interviewGapPrompt } from '../../electron/ipc/interviewAnswerGap.js';
import { addInterviewQaCard, fillInterviewQaFromPreparation, fillInterviewQaGaps, loadInterviewQa, loadInterviewQaLiveCards, saveInterviewQaCard } from '../../electron/ipc/interviewQaStore.js';

const PIECE = 'Engineer, Acme School, 2021 to 2024\nRan 3 Docker services on one virtual machine.';
const evidence = [
  { kind: 'career', id: 'evidence-long-hash-1', entityId: 'career-text-0001', text: PIECE },
  { kind: 'research', id: 'research-1', entityId: 'source-1', text: 'Acme sells schools software.' },
  { kind: 'career', id: 'evidence-long-hash-2', entityId: 'achievement-9', sourceLabel: 'Engineer · Old Health', text: 'Wrote the billing export.' },
];
const disclosed = question => ({ sourceUrl: 'https://example.com/interviews', sourceDate: '2026-01-01', evidenceQuote: 'They asked it.', target: 'none', question });
async function userData(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-gap-'));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

export default [
  { name: 'interview gap: an admission must deny something in the first person and hold no number', run() {
    assert.equal(gapAdmissionFailure('I have not run Kubernetes in production.'), null);
    assert.equal(gapAdmissionFailure("I haven't managed a team of engineers before."), null);
    for (const refused of ['I ran Kubernetes in production for a year.', 'The candidate has not used Kubernetes.', 'I have not used it. But I learn fast.',
      'I have not run Kubernetes for 2 years.', 'I never did.', 'Line one\nI have not done line two', '', null]) {
      assert.notEqual(gapAdmissionFailure(refused), null, `${JSON.stringify(refused)} must be refused`);
    }
  } },
  { name: 'interview gap: the closest line needs a real career piece and no number that piece lacks', run() {
    assert.equal(gapClosestFailure('The closest I have done is running 3 Docker services on one machine.', PIECE), null);
    assert.notEqual(gapClosestFailure('The closest I have done is running 40 Docker services.', PIECE), null, 'a number the piece lacks is refused');
    assert.notEqual(gapClosestFailure('The closest I have done is running Docker services.', ''), null, 'a line with no career piece is refused');
    assert.notEqual(gapClosestFailure('Running Docker services on one machine was close.', PIECE), null, 'the line is first person');
  } },
  { name: 'interview gap: only career pieces are offered, a structured piece keeps its label, and the stage is registered', run() {
    assert.deepEqual(gapCareerPieces(evidence), [{ id: 'evidence-long-hash-1', text: PIECE }, { id: 'evidence-long-hash-2', text: 'Engineer · Old Health: Wrote the billing export.' }]);
    assert.deepEqual(gapCareerPieces(null), []);
    assert.deepEqual(careerWritingStageProfile('qa-gap-answers'), { model: 'opus', effort: 'medium' });
  } },
  { name: 'interview gap: only gap questions get a card, and every line passes the host checks or is dropped', async run() {
    const units = [{ id: 'a', question: 'Tell me about your Kubernetes experience.' }, { id: 'b', question: 'Walk me through a project.' },
      { id: 'c', question: 'Have you managed people?' }, { id: 'd', question: 'Describe your on-call experience.' }];
    const calls = [];
    const warnings = [];
    const kept = await generateInterviewGapAnswers({ units, evidence, logWarning: message => warnings.push(message), callText: async (prompt, options) => {
      calls.push({ prompt, options });
      return { cards: [
        { id: 'a', gap: true, admission: 'I have not run Kubernetes in production.', closest: { text: 'The closest I have done is running 3 Docker services on one machine.', piece: 'p1' },
          reminders: ['Explain how you would learn it.', 'I learned Docker at Acme', 'Name what carries over', 'Ask what the team uses', 'Offer a fourth idea'] },
        { id: 'b', gap: false, admission: 'I have not done a project.', closest: { text: '', piece: '' }, reminders: [] },
        { id: 'c', gap: true, admission: 'I have not managed people directly.', closest: { text: 'The closest I have done is leading 12 engineers.', piece: 'p2' }, reminders: [] },
        { id: 'd', gap: true, admission: 'I have plenty of on-call experience.', closest: { text: '', piece: '' }, reminders: [] },
        { id: 'made-up', gap: true, admission: 'I have not done this at all.', closest: { text: '', piece: '' }, reminders: [] },
      ] };
    } });
    assert.deepEqual(kept.get('a'), { admission: 'I have not run Kubernetes in production.',
      closest: { text: 'The closest I have done is running 3 Docker services on one machine.', evidenceId: 'evidence-long-hash-1', quote: PIECE },
      approach: [{ text: 'Explain how you would learn it', example: '' }, { text: 'Name what carries over', example: '' }, { text: 'Ask what the team uses', example: '' }] },
    'the short piece id maps back to the real evidence, a first-person reminder is dropped and at most three are kept');
    assert(!kept.has('b'), 'a question the career text answers is left for the answer writer');
    assert.deepEqual(kept.get('c'), { admission: 'I have not managed people directly.', closest: null, approach: [] }, 'a closest line with an invented number is dropped and the card stands without it');
    assert(!kept.has('d'), 'a "gap" whose admission claims experience writes no card');
    assert(!kept.has('made-up'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.claudeStage, 'qa-gap-answers');
    assert.equal(calls[0].prompt, interviewGapPrompt(units, [{ id: 'p1', text: PIECE }, { id: 'p2', text: 'Engineer · Old Health: Wrote the billing export.' }]));
    assert(/When you are unsure, it is not a gap/u.test(calls[0].prompt) && !calls[0].prompt.includes('evidence-long-hash') && !calls[0].prompt.includes('Acme sells schools software'),
      'the request carries career pieces under short ids and no research');
    assert.equal(warnings.length, 1);
  } },
  { name: 'interview gap: no request is made without questions or without career text', async run() {
    const callText = async () => { throw new Error('must not be called'); };
    assert.equal((await generateInterviewGapAnswers({ units: [], evidence, callText })).size, 0);
    assert.equal((await generateInterviewGapAnswers({ units: [{ id: 'a', question: 'Have you managed people?' }], evidence: [evidence[1]], callText })).size, 0);
  } },
  { name: 'interview gap: a gap answer fills only an empty generated card, shows as an honest gap, and an edit makes it an ordinary card', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: { cards: [], evidence: [] }, company: 'Acme',
        disclosureMapping: [disclosed('Tell me about your Kubernetes experience.'), disclosed('Have you managed people?')] });
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'What is your notice period?', headline: '', bullets: [], example: '' } });
      const before = (await loadInterviewQa({ userDataPath: dir, nodeId: 'h' })).company.cards;
      const kubernetes = before.find(card => card.question.includes('Kubernetes'));
      const asked = [];
      const first = await fillInterviewQaGaps({ userDataPath: dir, nodeId: 'h', generate: async units => {
        asked.push(...units);
        return new Map([[`company:${kubernetes.id}`, { admission: 'I have not run Kubernetes in production.',
          closest: { text: 'The closest I have done is running 3 Docker services on one machine.', evidenceId: 'evidence-long-hash-1', quote: PIECE },
          approach: [{ text: 'Explain how you would learn it', example: '' }, { text: 'Name what carries over', example: '' }] }]]);
      } });
      assert.deepEqual(first, { requested: 2, saved: 1 });
      assert.deepEqual(asked.map(unit => unit.question).sort(), ['Have you managed people?', 'Tell me about your Kubernetes experience.'], 'a card the person wrote is never offered');
      const cards = (await loadInterviewQa({ userDataPath: dir, nodeId: 'h' })).company.cards;
      const gap = cards.find(card => card.id === kubernetes.id);
      assert(gap.gap === true && gap.status === 'ready' && gap.headline === 'I have not run Kubernetes in production.' && gap.thinEvidence === false);
      assert.deepEqual(gap.bullets, [{ stage: 'point', text: 'The closest I have done is running 3 Docker services on one machine.' }]);
      assert.deepEqual(gap.approach.map(item => item.text), ['Explain how you would learn it', 'Name what carries over']);
      assert(cards.find(card => card.question === 'Have you managed people?').gap === false, 'a question that was not a gap stays empty');
      assert((await loadInterviewQaLiveCards({ userDataPath: dir, nodeId: 'h' })).find(card => card.id === kubernetes.id).gap === true);

      const again = [];
      await fillInterviewQaGaps({ userDataPath: dir, nodeId: 'h', generate: async units => { again.push(...units); return new Map(); } });
      assert.deepEqual(again.map(unit => unit.question), ['Have you managed people?'], 'a written gap answer is an answer and is never rewritten');

      await saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { ...gap, headline: 'I ran Kubernetes on a side project.' } });
      const edited = (await loadInterviewQa({ userDataPath: dir, nodeId: 'h' })).company.cards.find(card => card.id === kubernetes.id);
      assert(edited.gap === false && edited.author === 'user', 'the person\'s own answer is no longer an honest-gap card');
    });
  } },
];
