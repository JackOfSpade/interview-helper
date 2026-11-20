import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addInterviewQaCard, deleteInterviewQaCard, emptyInterviewQaScopes, fillInterviewQaFromPreparation, isAnsweredCard, isFoundationQuestion,
  loadInterviewQa, saveInterviewQaCard,
} from '../../electron/ipc/interviewQaStore.js';
import { groundedDisclosures, mapInterviewDisclosures, validateDisclosureMapping } from '../../electron/ipc/interviewQaDisclosures.js';
import { createInterviewClaudeTransport, firstJsonObject, interviewClaudeStage, interviewStageMayOffload, INTERVIEW_RESEARCH_MAX_TURNS } from '../../electron/ipc/interviewClaudeTransport.js';
import { PARALLEL_RESEARCH_TOOLS, PARALLEL_EXHAUSTED_CODE, parallelBlocked, parallelExhaustedError, resetParallelLimit } from '../../electron/ipc/parallelSearch.js';
import { planInterviewPracticeOrder, validatePracticeOrder } from '../../electron/ipc/interviewQaPractice.js';

const statement = (text, evidenceIds = ['career-1']) => ({ text, evidenceIds, quotes: [] });
const card = (id, question, headline) => ({
  id, question, variants: [], headline: statement(headline), bullets: [{ stage: 'point', ...statement(`${headline} bullet`) }],
  example: statement(`${headline} example`), extensions: [], consistency: { consistentWithResume: true, resumeQuote: '' }, thinEvidence: false,
});
const bank = (...cards) => ({ cards });
async function userData(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-qa-'));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

export default [
  { name: 'interview Q&A: foundation questions are the shared set; everything else is company-specific', run() {
    assert(isFoundationQuestion('Tell me about yourself.') && isFoundationQuestion('tell me about yourself'));
    assert(!isFoundationQuestion('Why are you interested in this company?'));
    assert(!isAnsweredCard({ headline: { text: '' }, bullets: [], example: { text: '  ' } }));
    assert(isAnsweredCard({ headline: { text: '' }, bullets: [{ text: 'x' }], example: { text: '' } }));
  } },
  { name: 'interview Q&A: preparation fills foundation (global) and company stores; foundation is shared across helpers', async run() {
    await userData(async dir => {
      const first = bank(card('intro', 'Tell me about yourself.', 'I build tools.'), card('why-company', 'Why are you interested in this company?', 'Discord reaches millions.'));
      const qa = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'helper-a', bank: first, company: 'Discord' });
      assert.deepEqual(qa.foundation.cards.map(item => item.question), ['Tell me about yourself.']);
      assert.deepEqual(qa.company.cards.map(item => item.question), ['Why are you interested in this company?']);
      assert.equal(qa.company.company, 'Discord');
      assert.equal(qa.foundation.status, 'ready');
      const other = await loadInterviewQa({ userDataPath: dir, nodeId: 'helper-b' });
      assert.deepEqual(other.foundation.cards.map(item => item.headline), ['I build tools.'], 'a second helper sees the same foundation set');
      assert.deepEqual(other.company.cards, [], 'company Q&A belongs to one helper');
      const stat = await fs.promises.stat(path.join(dir, 'interview-helper-qa', 'foundation.json'));
      assert.equal(stat.mode & 0o077, 0, 'store files are private');
    });
  } },
  { name: 'interview Q&A: a tab that has cards is left exactly as it is by a later Prepare', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: bank(card('intro', 'Tell me about yourself.', 'Original intro.'), card('why-role', 'Why are you interested in this role?', 'Original why.'), card('lead', 'Describe your approach to leadership.', 'Original lead.')) });
      assert.deepEqual(await emptyInterviewQaScopes({ userDataPath: dir, nodeId: 'h' }), []);
      const loaded = await loadInterviewQa({ userDataPath: dir, nodeId: 'h' });
      const why = loaded.company.cards.find(item => item.question === 'Why are you interested in this role?');
      await saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { ...why, headline: 'My own why.', bullets: [{ text: 'My own bullet.' }], example: '' } });
      const lead = loaded.company.cards.find(item => item.question === 'Describe your approach to leadership.');
      await deleteInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', cardId: lead.id });
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'How do you adapt to change?', variants: [], headline: '', bullets: [], example: '', extensions: [] } });
      const before = await loadInterviewQa({ userDataPath: dir, nodeId: 'h' });
      const again = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h',
        bank: bank(card('intro', 'Tell me about yourself.', 'NEW intro.'), card('project', 'Walk me through a project.', 'NEW project.'), card('why-role', 'Why are you interested in this role?', 'NEW why.'), card('lead', 'Describe your approach to leadership.', 'NEW lead.'), card('pressure', 'How do you work under pressure?', 'New pressure.'), card('adapt', 'How do you adapt to change?', 'New adapt.')),
        disclosureMapping: [
          { question: 'Why this job?', sourceUrl: 'https://example.test/b', sourceDate: '2026', evidenceQuote: 'q', target: 'company', cardQuestion: 'Why are you interested in this role?' },
          { question: 'Tell us about you', sourceUrl: 'https://example.test/a', sourceDate: 'unknown', evidenceQuote: 'q', target: 'foundation', cardQuestion: 'Tell me about yourself.' }] });
      assert.deepEqual(again, before, 'neither tab changes: no new card, no added wording, no filled answer, no link');
      assert.equal(again.foundation.cards.length, 1); assert.equal(again.foundation.cards[0].headline, 'Original intro.');
      assert.equal(again.company.cards.find(item => item.question === 'Why are you interested in this role?').headline, 'My own why.');
      assert(!again.company.cards.some(item => item.question === 'Describe your approach to leadership.'), 'a deleted question does not come back while the tab has cards');
      assert.equal(again.company.cards.find(item => item.question === 'How do you adapt to change?').status, 'empty', 'an empty card in a tab that has cards is not filled');
    });
  } },
  { name: 'interview Q&A: only the empty tab is written, and an emptied tab is written again with its deleted questions', async run() {
    await userData(async dir => {
      assert.deepEqual(await emptyInterviewQaScopes({ userDataPath: dir, nodeId: 'h' }), ['foundation', 'company']);
      const first = bank(card('intro', 'Tell me about yourself.', 'Original intro.'), card('why-role', 'Why are you interested in this role?', 'Original why.'), card('lead', 'Describe your approach to leadership.', 'Original lead.'));
      // A tab that is not listed is not written even when it is empty.
      const generalOnly = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: first, scopes: ['foundation'] });
      assert.equal(generalOnly.foundation.cards.length, 1); assert.deepEqual(generalOnly.company.cards, []);
      assert.deepEqual(await emptyInterviewQaScopes({ userDataPath: dir, nodeId: 'h' }), ['company']);
      const filled = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: first, scopes: ['company'] });
      assert.equal(filled.company.cards.length, 2);
      // Every posting card is deleted: the posting tab is empty and General is not.
      for (const item of filled.company.cards) await deleteInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', cardId: item.id });
      assert.deepEqual(await emptyInterviewQaScopes({ userDataPath: dir, nodeId: 'h' }), ['company']);
      const again = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h',
        bank: bank(card('intro', 'Tell me about yourself.', 'NEW intro.'), card('project', 'Walk me through a project.', 'NEW project.'), card('why-role', 'Why are you interested in this role?', 'NEW why.'), card('lead', 'Describe your approach to leadership.', 'NEW lead.')) });
      assert.deepEqual(again.foundation.cards.map(item => item.headline), ['Original intro.'], 'General has cards and stays as it is');
      assert.deepEqual(again.company.cards.map(item => item.headline).sort(), ['NEW lead.', 'NEW why.'], 'the emptied tab is written again, deleted questions included');
    });
  } },
  { name: 'interview Q&A: disclosures become variants, foundation links or needs-prep cards when the posting tab is written', async run() {
    await userData(async dir => {
      const mapping = [
        { question: 'Tell us about yourself and your background', sourceUrl: 'https://example.test/a', sourceDate: 'unknown', evidenceQuote: 'q', target: 'foundation', cardQuestion: 'Tell me about yourself.' },
        { question: 'Why Discord?', sourceUrl: 'https://example.test/b', sourceDate: '2026', evidenceQuote: 'q2', target: 'company', cardQuestion: 'Why are you interested in this company?' },
        { question: 'Design a rate limiter for chat messages.', sourceUrl: 'https://example.test/c', sourceDate: 'unknown', evidenceQuote: 'q3', target: 'none', cardQuestion: '' },
        // A company mapping whose card did not survive becomes a needs-prep disclosed card.
        { question: 'Why do you want to join Acme?', sourceUrl: 'https://example.test/d', sourceDate: 'unknown', evidenceQuote: 'q4', target: 'company', cardQuestion: 'Why Acme?' },
      ];
      const qa = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: bank(card('pressure', 'How do you work under pressure?', 'I prioritize.'), card('why-company', 'Why are you interested in this company?', 'Discord reaches millions.')), disclosureMapping: mapping });
      const pressure = qa.company.cards.find(item => item.question === 'How do you work under pressure?');
      assert.equal(pressure.headline, 'I prioritize.'); assert.equal(pressure.author, 'generated');
      const why = qa.company.cards.find(item => item.question === 'Why are you interested in this company?');
      assert(why.variants.includes('Why Discord?') && why.origin === 'disclosed' && why.source.url === 'https://example.test/b');
      const design = qa.company.cards.find(item => item.question === 'Design a rate limiter for chat messages.');
      assert.equal(design.status, 'needs-prep'); assert.equal(design.origin, 'disclosed');
      assert.deepEqual(qa.company.foundationLinks, [{ foundationQuestion: 'Tell me about yourself.', question: 'Tell us about yourself and your background', sourceUrl: 'https://example.test/a' }]);
      assert(!qa.company.cards.some(item => item.question === 'Tell us about yourself and your background'), 'a foundation-equivalent disclosure never duplicates into company Q&A');
      const kept = qa.company.cards.find(item => item.question === 'Why do you want to join Acme?');
      assert(kept, 'the disclosed question is not lost'); assert.equal(kept.status, 'needs-prep'); assert.equal(kept.origin, 'disclosed');
      assert.equal(kept.source.url, 'https://example.test/d');
    });
  } },
  { name: 'interview Q&A: a written card never reuses an id already held by a different question', async run() {
    await userData(async dir => {
      const qa = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'a', bank: bank(card('c3', 'Tell me about yourself.', 'By impact.'), card('c3', 'Walk me through a project.', 'I weighed options.')) });
      const ids = qa.foundation.cards.map(item => item.id);
      assert.equal(ids.length, 2); assert.equal(new Set(ids).size, ids.length, 'card ids stay unique');
      const decision = qa.foundation.cards.find(item => item.question === 'Walk me through a project.');
      const after = await deleteInterviewQaCard({ userDataPath: dir, nodeId: 'a', scope: 'foundation', cardId: decision.id });
      assert(after.cards.some(item => item.question === 'Tell me about yourself.'), 'deleting one card keeps the other');
    });
  } },
  { name: 'interview Q&A: re-preparing for another company drops the old company generated cards but keeps the person\'s own', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Acme', bank: bank(card('why', 'Why are you interested in this company?', 'Acme ships fast.')),
        disclosureMapping: [{ question: 'Tell us about you', sourceUrl: 'https://example.test/a', sourceDate: 'unknown', evidenceQuote: 'q', target: 'foundation', cardQuestion: 'Tell me about yourself.' }] });
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'My own note?', headline: 'Mine.' } });
      assert.deepEqual(await emptyInterviewQaScopes({ userDataPath: dir, nodeId: 'h', company: 'Acme Inc.' }), ['foundation'], 'the same company with cards is not empty');
      assert.deepEqual(await emptyInterviewQaScopes({ userDataPath: dir, nodeId: 'h', company: 'Globex' }), ['foundation', 'company'], 'a set re-pointed at another company is written again');
      const next = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Globex', bank: bank(card('why', 'Why are you interested in this company?', 'Globex scales.')) });
      assert.equal(next.company.cards.find(item => item.question === 'Why are you interested in this company?').headline, 'Globex scales.', 'the new company answer replaces the old one');
      assert(next.company.cards.some(item => item.question === 'My own note?'), 'the person\'s card stays');
      assert.deepEqual(next.company.foundationLinks, []);
      // A spelling variant or a placeholder for the same company changes nothing.
      const same = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Globex, Inc.', bank: bank(card('why', 'Why are you interested in this company?', 'Other text.')),
        disclosureMapping: [{ question: 'Tell us about you', sourceUrl: 'https://example.test/a', sourceDate: 'unknown', evidenceQuote: 'q', target: 'foundation', cardQuestion: 'Tell me about yourself.' }] });
      assert.equal(same.company.cards.find(item => item.question === 'Why are you interested in this company?').headline, 'Globex scales.');
      const placeholder = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Unknown company', bank: bank() });
      assert.deepEqual(placeholder.company.foundationLinks, [], 'a tab that has cards gains no link');
      assert.equal(placeholder.company.company, 'Globex, Inc.', 'a placeholder never overwrites a real name');
    });
  } },
  { name: 'interview Q&A: editing a card to another card\'s question is refused', async run() {
    await userData(async dir => {
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'First question?', headline: 'A.' } });
      const both = await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'Second question?', headline: 'B.' } });
      const second = both.cards.find(item => item.question === 'Second question?');
      await assert.rejects(saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { ...second, question: 'first question' } }), /already in this section/);
    });
  } },
  { name: 'interview Q&A: user edits are bounds-checked and stored without citations', async run() {
    await userData(async dir => {
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: '' } }), /Write a question/);
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'Q?', bullets: Array.from({ length: 7 }, () => 'b') } }), /at most 6/);
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'nope', card: { question: 'Q?' } }), /section is invalid/);
      await assert.rejects(saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { id: 'missing', question: 'Q?' } }), /no longer exists/);
      const added = await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'What would you change about Discord?', headline: 'Faster onboarding.', bullets: ['One'], extensions: ['Extra'] } });
      assert.match(added.cards[0].id, /^user-[a-f0-9]{12}$/u);
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'what would you change about discord' } }), /already in this section/);
      const stored = (await loadInterviewQa({ userDataPath: dir, nodeId: 'h' })).company.cards[0];
      assert.equal(stored.headline, 'Faster onboarding.');
      assert.equal(stored.author, 'user');
    });
  } },
  { name: 'interview Q&A disclosures: only exact research substrings survive; AI mapping must name offered cards', async run() {
    const raw = 'Glassdoor https://www.glassdoor.com/x reports: "Why Discord?" was asked in 2025. Also "Design a rate limiter."';
    const kept = groundedDisclosures({ disclosures: [
      { question: 'Why Discord?', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: '2025', evidenceQuote: '"Why Discord?" was asked', kind: 'company' },
      { question: 'Why do you want Discord?', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: '2025', evidenceQuote: 'asked', kind: 'company' },
      { question: 'Design a rate limiter.', sourceUrl: 'https://invented.test/', sourceDate: 'unknown', evidenceQuote: 'Design', kind: 'technical' },
      { question: 'Design a rate limiter.', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: 'May 9', evidenceQuote: 'Also "Design', kind: 'weird' },
    ] }, raw);
    assert.deepEqual(kept.map(item => item.question), ['Why Discord?', 'Design a rate limiter.']);
    assert.equal(kept[1].sourceDate, 'unknown'); assert.equal(kept[1].kind, 'role');
    const privateRaw = 'See https://user:tok@h.example/q?s=1 and https://h.example/q?sessionId=a#f for "Q one?" and "Q two?"';
    const privateKept = groundedDisclosures({ disclosures: [
      { question: 'Q one?', sourceUrl: 'https://user:tok@h.example/q?s=1', sourceDate: 'unknown', evidenceQuote: 'Q one?' },
      { question: 'Q two?', sourceUrl: 'https://h.example/q?sessionId=a#f', sourceDate: 'unknown', evidenceQuote: 'Q two?' },
    ] }, privateRaw);
    assert.deepEqual(privateKept.map(item => [item.question, item.sourceUrl]), [['Q two?', 'https://h.example/q']], 'credentials are dropped; query and fragment are stripped');
    const context = { disclosures: kept, foundationQuestions: ['Tell me about yourself.'], companyQuestions: ['Why are you interested in this company?'] };
    assert.throws(() => validateDisclosureMapping({ mappings: [{ index: 0, target: 'company', cardQuestion: 'Why this company?' }, { index: 1, target: 'none', cardQuestion: '' }] }, context), /mapping-card/);
    assert.throws(() => validateDisclosureMapping({ mappings: [{ index: 0, target: 'none', cardQuestion: '' }] }, context), /mapping-missing/);
    const calls = [];
    const callText = async (prompt, opts) => { calls.push(opts); return calls.length === 1
      ? { disclosures: [{ question: 'Why Discord?', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: '2025', evidenceQuote: '"Why Discord?" was asked', kind: 'company' }] }
      : { mappings: [{ index: 0, target: 'company', cardQuestion: 'Why are you interested in this company?' }] }; };
    const mapped = await mapInterviewDisclosures({ rawResearch: raw, ...context, callText });
    assert.deepEqual(mapped.map(item => [item.question, item.target, item.cardQuestion]), [['Why Discord?', 'company', 'Why are you interested in this company?']]);
    assert(calls.every(opts => opts.claudeStage === 'qa-disclosures'));
    assert.deepEqual(await mapInterviewDisclosures({ rawResearch: '', ...context, callText }), [], 'no research, no disclosures');
  } },
  { name: 'interview Claude transport: application stage profiles and same-session retry on rejection', async run() {
    assert.equal(interviewClaudeStage('interview-brief-research'), 'qa-research');
    assert.equal(interviewClaudeStage('interview-answer-bank', 'qa-card-repair'), 'qa-card-repair');
    assert.equal(interviewClaudeStage('interview-answer-bank'), 'qa-write');
    assert.deepEqual(firstJsonObject('Sure: {"a":"b}"} trailing'), { a: 'b}' });
    const runs = [];
    const research = [];
    let replies = ['not json', '{"ok":false}', '{"ok":true}'];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: replies.shift(), model: 'claude-opus-5-5' }; },
      runResearchStage: async args => { research.push(args); return { text: 'Research prose with https://x.test', model: 'claude-opus-5-5' }; } });
    const value = await transport.callText('PROMPT', { task: 'interview-answer-bank', responseSchema: { type: 'object' }, responseValidator: v => { if (!v.ok) throw new Error('not ok'); } });
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(runs.map(run => [run.model, run.effort, run.resume, run.tools]), [['opus', 'medium', false, ''], ['opus', 'medium', true, ''], ['opus', 'medium', true, '']]);
    assert.equal(new Set(runs.map(run => run.sessionId)).size, 1, 'retries stay in one Claude session');
    assert.match(runs[0].text, /REPLY FORMAT: one JSON object/u);
    assert.match(runs[2].text, /^YOUR PREVIOUS REPLY WAS REJECTED BY THE APP\..*\nnot ok$/su);
    runs.length = 0;
    assert.equal(await transport.callRaw('R', { task: 'interview-brief-research' }), 'Research prose with https://x.test');
    assert.equal(runs.length, 0, 'research never runs on the built-in runStage');
    assert.deepEqual([research[0].model, research[0].effort, research[0].tools], ['opus', 'high', [...PARALLEL_RESEARCH_TOOLS]]);
    runs.length = 0; replies = ['{}'];
    await transport.callText('C', { task: 'interview-answer-bank', claudeStage: 'qa-card-repair', responseSchema: { type: 'object' } });
    assert.deepEqual([runs[0].model, runs[0].effort, runs[0].tools], ['opus', 'low', '']);
    runs.length = 0; replies = ['{}'];
    await transport.callText('C', { task: 'interview-answer-bank', claudeStage: 'qa-technical-topics', responseSchema: { type: 'object' } });
    assert.deepEqual([runs[0].model, runs[0].effort, runs[0].tools], ['sonnet', 'low', ''], 'the technical-topics stage is Sonnet low');
    replies = ['bad', 'bad', 'bad'];
    await assert.rejects(transport.callText('X', { task: 'interview-answer-bank', responseSchema: { type: 'object' } }), error => /no JSON object/.test(error.message) && error.code === 'VALIDATION_FAILED');
  } },
  { name: 'interview practice: AI-planned order uses every question once with the introduction first', async run() {
    const questions = ['Why are you interested in this company?', 'Tell me about yourself.', 'Design a rate limiter.'];
    assert.deepEqual(validatePracticeOrder({ order: [1, 0, 2] }, questions), [1, 0, 2]);
    assert.throws(() => validatePracticeOrder({ order: [0, 1, 2] }, questions), /order-intro/);
    assert.throws(() => validatePracticeOrder({ order: [1, 0] }, questions), /order-permutation/);
    assert.throws(() => validatePracticeOrder({ order: [1, 1, 2] }, questions), /order-permutation/);
    const prompts = [];
    const ordered = await planInterviewPracticeOrder({ questions: [...questions, 'tell me about yourself'], company: 'Discord', callText: async (prompt, opts) => {
      prompts.push(prompt); assert.equal(opts.claudeStage, 'qa-practice-order');
      assert.throws(() => opts.responseValidator({ order: [2, 1, 0] }), /order-intro/);
      return { order: [1, 0, 2] };
    } });
    assert.deepEqual(ordered, ['Tell me about yourself.', 'Why are you interested in this company?', 'Design a rate limiter.']);
    assert.match(prompts[0], /an introduction first.*closing or reflective questions last/su, 'the plan asks for a natural interview arc');
    assert.deepEqual(await planInterviewPracticeOrder({ questions: ['Only one?'], callText: async () => { throw new Error('unused'); } }), ['Only one?']);
  } },
  { name: 'interview Q&A offload: a routed qa-brief is answered by the offload call with the handoff messages', async run() {
    const runs = []; const offloads = []; const stages = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: stage => (stage === 'qa-brief' ? { route: 'deepseek-flash', reasoning: 'medium' } : null),
      offloadCall: async args => { offloads.push(args); return { text: '{"ok":true}', model: 'deepseek-v4-flash', provider: 'offload' }; },
      onStage: info => stages.push(info) });
    const value = await transport.callText('PROMPT BODY', { claudeStage: 'qa-brief' });
    assert.deepEqual(value, { ok: true });
    assert.equal(runs.length, 0, 'Claude must not run for a routed answer');
    assert.equal(offloads.length, 1);
    assert.equal(offloads[0].route, 'deepseek-flash');
    assert.equal(offloads[0].reasoning, 'medium');
    assert.equal(offloads[0].tag, 'qa-brief');
    assert.deepEqual(offloads[0].messages.map(item => item.role), ['system', 'user']);
    assert.equal(offloads[0].messages[1].content, 'PROMPT BODY');
    assert.equal(stages[0].provider, 'offload');
    assert.equal(stages[0].route, 'deepseek-flash');
    await transport.callText('OTHER', { claudeStage: 'qa-write' });
    assert.equal(runs.length, 1, 'a stage without a table entry stays on Claude');
    assert.equal(stages[1].provider, 'claude');
  } },
  { name: 'interview Q&A offload: qa-research and qa-card-repair stages never route even with a table entry', async run() {
    const runs = [];
    const research = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: '{"ok":true}', model: 'claude-parallel' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => { throw new Error('offload must not be called'); } });
    for (const stage of ['qa-research', 'qa-card-repair']) await transport.callText('P', { claudeStage: stage });
    assert.equal(runs.length, 1, 'research is not a runStage stage any more');
    assert.equal(research.length, 1);
    assert.deepEqual(research[0].tools, [...PARALLEL_RESEARCH_TOOLS]);
    assert.deepEqual(runs.map(run => run.tools), ['']);
    assert.equal(interviewStageMayOffload('qa-card-repair'), false);
    assert.equal(interviewStageMayOffload('career-file-to-text'), false, 'a verbatim copy of a personal file never routes to another provider');
    assert.equal(interviewStageMayOffload('qa-disclosures'), true);
    assert.equal(interviewStageMayOffload('qa-practice-order'), true);
  } },
  { name: 'interview Claude transport: typed-job stages use their own profiles; only typed-job-research gets Parallel tools and fails when Parallel is out', async run() {
    const runs = []; const research = [];
    const make = enabled => createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => enabled },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: 'Acme research', model: 'claude-parallel' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => { throw new Error('typed-job stages with no table entry must not route here'); } });
    const transport = make(true);
    // routeFor above answers every stage, so the stages that may offload would call offloadCall; check the gate directly.
    assert.equal(interviewStageMayOffload('typed-job-research'), false, 'research never routes');
    assert.equal(interviewStageMayOffload('typed-job-intake'), true);
    assert.equal(await transport.callRaw('R', { claudeStage: 'typed-job-research', task: 'interview-typed-job-research' }), 'Acme research');
    assert.deepEqual([research[0].model, research[0].effort, research[0].tools], ['opus', 'high', [...PARALLEL_RESEARCH_TOOLS]]);
    assert.equal(runs.length, 0, 'typed-job-research never runs on the built-in runStage');
    const noRoute = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; }, routeFor: () => null });
    for (const stage of ['typed-job-intake', 'typed-job-posting', 'typed-job-listing']) await noRoute.callText('P', { claudeStage: stage, responseSchema: { type: 'object' } });
    assert.deepEqual(runs.map(run => [run.model, run.effort, run.tools]), [['haiku', 'medium', ''], ['sonnet', 'low', ''], ['opus', 'medium', '']]);
    research.length = 0;
    await assert.rejects(make(false).callRaw('R', { claudeStage: 'typed-job-research' }), error => error.code === 'PARALLEL_SEARCH_EXHAUSTED');
    assert.equal(research.length, 0, 'no research session starts when Parallel is out');
  } },
  { name: 'interview Claude transport: career-file-to-text sends page images on the first message only and never offloads', async run() {
    const runs = [];
    const images = [{ label: 'resume.png', mimeType: 'image/png', data: 'AAAA' }];
    let replies = 0;
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); replies += 1; return { text: replies === 1 ? 'not json' : '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => { throw new Error('career-file-to-text must never offload'); },
      recordSample: sample => { assert.equal(JSON.stringify(sample).includes('AAAA'), false, 'image data is never recorded'); } });
    await transport.callText('Copy the text.', { claudeStage: 'career-file-to-text', task: 'career-file-to-text', pageImages: images, responseSchema: { type: 'object' } });
    assert.deepEqual(runs.map(run => [run.model, run.effort, run.tools]), [['sonnet', 'low', ''], ['sonnet', 'low', '']]);
    assert.deepEqual(runs[0].pageImages, images);
    assert.equal(runs[1].pageImages, undefined, 'a resumed correction round carries no image again');
  } },
  { name: 'interview Q&A offload: an OFFLOAD_ error fails the call loudly with its own code and Claude never answers a routed stage', async run() {
    const runs = []; let offloadCalls = 0;
    const make = code => createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-pro', reasoning: 'high' }),
      offloadCall: async () => { offloadCalls += 1; throw Object.assign(new Error(code), { code }); } });
    await assert.rejects(() => make('OFFLOAD_PROVIDER_ERROR').callText('ORIGINAL', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_PROVIDER_ERROR');
    const credit = make('OFFLOAD_CREDIT_EXHAUSTED');
    await assert.rejects(() => credit.callText('A', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_CREDIT_EXHAUSTED');
    await assert.rejects(() => credit.callText('B', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_CREDIT_EXHAUSTED');
    assert.equal(offloadCalls, 3, 'every call asks DeepSeek; nothing is remembered as blocked');
    await assert.rejects(() => make('CLAUDE_CANCELLED').callText('C', { claudeStage: 'qa-write' }), error => error.code === 'CLAUDE_CANCELLED');
    assert.equal(runs.length, 0, 'Claude was never called');
  } },
  { name: 'interview Q&A offload: an empty offload reply fails loudly and Claude never answers a routed stage', async run() {
    const runs = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-pro', reasoning: 'high' }),
      offloadCall: async () => null });
    await assert.rejects(() => transport.callText('P', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_EMPTY_REPLY');
    assert.equal(runs.length, 0, 'Claude was never called');
  } },
  { name: 'interview Q&A offload: rejected offload replies are resent statelessly to DeepSeek and never escalate to Claude', async run() {
    const runs = []; const offloads = [];
    const replies = ['{"ok":false}', '{"ok":false}', '{"ok":true}'];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async args => { offloads.push(args.messages.map(item => ({ ...item }))); return { text: replies.shift(), model: 'd' }; } });
    const validator = (value) => { if (value.ok !== true) throw new Error('ok must be true'); };
    assert.deepEqual(await transport.callText('ORIGINAL', { claudeStage: 'qa-write', responseValidator: validator }), { ok: true });
    assert.equal(offloads.length, 3);
    assert.deepEqual(offloads[2].map(item => item.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    assert.equal(offloads[1][2].content, '{"ok":false}');
    assert.match(offloads[1][3].content, /REJECTED BY THE APP[\s\S]*ok must be true/u);
    assert.equal(runs.length, 0, 'Claude was never called');
    // Every reply rejected: the call ends as an exhausted validation, still without Claude.
    const never = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => ({ text: '{"ok":false}', model: 'd' }) });
    await assert.rejects(() => never.callText('ORIGINAL', { claudeStage: 'qa-write', responseValidator: validator }), /ok must be true/u);
    assert.equal(runs.length, 0);
  } },
  { name: 'interview Q&A shadow: only Claude-answered first attempts of qa-brief and qa-write are measured', async run() {
    const jobs = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async () => ({ text: '{"ok":true}', model: 'claude-x' }),
      shadow: { enabled: true, measure: job => jobs.push(job) } });
    const validator = (value) => { if (value.ok !== true) throw Object.assign(new Error('no'), { code: 'NOT_OK' }); };
    await transport.callText('P', { claudeStage: 'qa-brief', responseValidator: validator });
    await transport.callText('P', { claudeStage: 'qa-write', responseValidator: validator });
    await transport.callText('P', { claudeStage: 'qa-card-repair', responseValidator: validator });
    assert.deepEqual(jobs.map(job => job.id), ['qa-brief', 'qa-write']);
    assert.equal(jobs[0].kind, 'qa');
    assert.equal(jobs[0].claude.outcome, 'accepted');
    assert.equal(jobs[0].messages[1].content, 'P');
    assert.deepEqual(jobs[0].validate('{"ok":true}'), { valid: true, code: null });
    assert.deepEqual(jobs[0].validate('{"ok":false}'), { valid: false, code: 'NOT_OK' });
    assert.equal(jobs[0].validate('no json').valid, false);
  } },
  { name: 'interview Claude transport: qa-research always calls runResearchStage with the six Parallel tools and MCP server', async run() {
    const runs = []; const research = []; const samples = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true, readKey: async () => 'pk-test-key-0123456789' },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: '{"ok":true}', model: 'claude-parallel' }; },
      recordSample: sample => samples.push(sample),
      routeFor: () => null });
    assert.deepEqual(await transport.callText('RESEARCH', { task: 'interview-brief-research' }), { ok: true });
    assert.equal(runs.length, 0, 'runStage is never called for qa-research');
    assert.equal(research.length, 1);
    const request = research[0];
    assert.deepEqual(request.tools, [...PARALLEL_RESEARCH_TOOLS]);
    assert.equal(request.tools.length, 6);
    assert.equal(request.tools.some(name => name === 'WebSearch' || name === 'WebFetch'), false);
    assert.equal(request.mcpServers.parallel.url, 'https://mcp.parallel.ai/mcp');
    assert.deepEqual(request.mcpServers.parallel.headers, { Authorization: 'Bearer pk-test-key-0123456789' });
    assert.equal(typeof request.onToolResult, 'function');
    assert.equal(request.maxTurns, INTERVIEW_RESEARCH_MAX_TURNS);
    assert.equal(request.maxTurns, 24);
    assert.equal(request.persistSession, false);
    assert.equal(request.resume, false);
    assert.equal(request.ultracode, false);
    assert.equal(request.model, 'opus');
    assert.equal(request.effort, 'high');
    assert.equal(samples[0].tools, PARALLEL_RESEARCH_TOOLS.join(','));
    assert.equal(samples[0].tools.split(',').length, 6);
  } },
  { name: 'interview Claude transport: a research error other than exhaustion propagates and never reaches runStage', async run() {
    const runs = []; let researchCalls = 0;
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 3,
      parallel: { enabled: async () => true, readKey: async () => '' },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async () => { researchCalls += 1; throw Object.assign(new Error('mcp down'), { code: 'CLAUDE_RUN_FAILED' }); },
      routeFor: () => null });
    await assert.rejects(transport.callText('RESEARCH', { task: 'interview-brief-research' }),
      error => error.code === 'CLAUDE_RUN_FAILED' && error.message === 'mcp down');
    assert.equal(researchCalls, 1, 'a thrown research error is not retried');
    assert.equal(runs.length, 0, 'runStage is never called for qa-research');
  } },
  { name: 'interview Claude transport: PARALLEL_SEARCH_EXHAUSTED from research propagates at once and is never retried', async run() {
    const runs = []; const research = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 3,
      parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); throw parallelExhaustedError(); },
      routeFor: () => null });
    await assert.rejects(transport.callText('RESEARCH', { task: 'interview-brief-research' }),
      error => error.code === PARALLEL_EXHAUSTED_CODE);
    assert.equal(research.length, 1, 'exhaustion is not retried');
    assert.equal(runs.length, 0, 'runStage is never called for qa-research');
  } },
  { name: 'interview Claude transport: a rejected research reply is retried through Parallel with the original prompt and rejection', async run() {
    const runs = []; const research = [];
    const replies = ['{"ok":false}', '{"ok":true}'];
    const validator = value => { if (value.ok !== true) throw Object.assign(new Error('ok must be true'), { code: 'NOT_OK' }); };
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 3,
      parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: replies.shift(), model: 'claude-parallel' }; },
      routeFor: () => null });
    assert.deepEqual(await transport.callText('ORIGINAL', { task: 'interview-brief-research', responseValidator: validator }), { ok: true });
    assert.equal(research.length, 2, 'the rejection is retried, not abandoned');
    assert.equal(research[0].text, 'ORIGINAL');
    assert.equal(research[1].resume, false, 'a Parallel session is never persisted, so it cannot be resumed');
    assert.equal(research[1].persistSession, false);
    assert.match(research[1].text, /^ORIGINAL\n\nYOUR PREVIOUS REPLY WAS REJECTED BY THE APP[\s\S]*ok must be true$/u);
    assert.equal(runs.length, 0, 'the retry is another Parallel call, never the built-in runner');
    const spent = [];
    const exhausted = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 1,
      parallel: { enabled: async () => true },
      runStage: async args => { spent.push(args); return { text: '{"ok":true}' }; },
      runResearchStage: async args => { spent.push(args); return { text: '{"ok":false}' }; },
      routeFor: () => null });
    await assert.rejects(exhausted.callText('ORIGINAL', { task: 'interview-brief-research', responseValidator: validator }),
      error => error.code === 'NOT_OK');
    assert.equal(spent.length, 1, 'a rejected research reply consumes an attempt, never a built-in one');
  } },
  { name: 'interview Claude transport: Parallel exhausted before the call rejects with PARALLEL_SEARCH_EXHAUSTED and calls neither runner', async run() {
    const runs = []; const research = [];
    const stage = async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; };
    const researchStage = async args => { research.push(args); return { text: '{"ok":true}' }; };
    const off = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => false },
      runStage: stage, runResearchStage: researchStage, routeFor: () => null });
    await assert.rejects(off.callText('R', { task: 'interview-brief-research' }), error => error.code === PARALLEL_EXHAUSTED_CODE);
    assert.equal(runs.length, 0, 'runStage is never a research fallback');
    assert.equal(research.length, 0, 'Claude is not called when Parallel is exhausted');
    const throwing = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => { throw new Error('no keychain'); } },
      runStage: stage, runResearchStage: researchStage, routeFor: () => null });
    await assert.rejects(throwing.callText('R', { task: 'interview-brief-research' }), error => error.code === PARALLEL_EXHAUSTED_CODE);
    assert.equal(runs.length, 0, 'a throwing enabled() also means exhausted, never built-in');
    assert.equal(research.length, 0);
  } },
  { name: 'interview Claude transport: a non-research stage never calls runResearchStage or consults Parallel', async run() {
    let researchCalls = 0;
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => { throw new Error('Parallel must not be consulted'); } },
      runStage: async () => ({ text: '{"ok":true}', model: 'claude-x' }),
      runResearchStage: async () => { researchCalls += 1; return { text: '{"ok":true}' }; },
      routeFor: () => null });
    await transport.callText('Q', { task: 'interview-answer-bank', claudeStage: 'qa-card-repair' });
    await transport.callText('Q', { task: 'interview-brief-assessment' });
    await transport.callText('Q', { task: 'interview-answer-bank' });
    assert.equal(researchCalls, 0);
  } },
  { name: 'interview Claude transport: research onToolResult throws only for a Parallel tool error that reports a limit', async run() {
    const research = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true, readKey: async () => '' },
      runStage: async () => { throw new Error('runStage must not run for research'); },
      runResearchStage: async args => { research.push(args); return { text: '{"ok":true}', model: 'claude-parallel' }; },
      routeFor: () => null });
    await transport.callText('SEARCH', { task: 'interview-brief-research' });
    const { onToolResult } = research[0];
    assert.equal(typeof onToolResult, 'function');
    try {
      assert.equal(onToolResult({ toolName: 'mcp__tavily__search', isError: true, text: '429 rate limit exceeded' }), undefined);
      assert.equal(onToolResult({ toolName: 'mcp__parallel__web_search', isError: false, text: '429 rate limit exceeded' }), undefined);
      assert.equal(onToolResult({ toolName: 'mcp__parallel__web_search', isError: true, text: 'failed to fetch https://x.test' }), undefined);
      assert.throws(() => onToolResult({ toolName: 'mcp__parallel__web_search', isError: true, text: '429 rate limit exceeded, try again later' }),
        error => error.code === PARALLEL_EXHAUSTED_CODE);
      assert.equal(parallelBlocked(), true, 'the limit is noted for the dock and the next call');
    } finally { resetParallelLimit(); }
  } },
  { name: 'interview Claude transport: recorded samples name the Parallel tools research used', async run() {
    const samples = []; const research = [];
    const replies = ['{"ok":false}', '{"ok":true}'];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => true },
      runStage: async () => ({ text: '{"ok":true}', model: 'claude-x' }),
      runResearchStage: async args => { research.push(args); return { text: replies.shift(), model: 'claude-parallel' }; },
      recordSample: sample => samples.push(sample),
      routeFor: () => null });
    const validator = value => { if (value.ok !== true) throw new Error('ok must be true'); };
    await transport.callText('ORIGINAL', { task: 'interview-brief-research', responseValidator: validator });
    await transport.callText('BRIEF', { task: 'interview-brief-assessment' });
    assert.deepEqual(samples.map(sample => [sample.stage, sample.tools]), [
      ['qa-research', PARALLEL_RESEARCH_TOOLS.join(',')],
      ['qa-research', PARALLEL_RESEARCH_TOOLS.join(',')],
      ['qa-brief', null],
    ]);
    assert.deepEqual(samples.map(sample => sample.outcome), ['rejected', 'accepted', 'accepted']);
    assert.match(samples[1].text, /^ORIGINAL\n\nYOUR PREVIOUS REPLY WAS REJECTED BY THE APP/u);
    assert.equal(samples.some(sample => String(sample.tools || '').includes('WebSearch')), false);
  } },
];
