import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { withTimeout } from './fixtures/practice-connector/harness.js';
import { INTERVIEW_PRACTICE_FEEDBACK_SCHEMA, PRACTICE_CALL_ID_RE, PRACTICE_CODE_RE, PRACTICE_FEEDBACK_LIMITS, newPracticeCode, orderPracticeQuestions, practiceCodeHash, trimPracticeFeedback, trimPracticeText, validatePracticeFeedback } from '../../electron/ipc/interviewQaPractice.js';
import { listInterviewPracticeSessions, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPractice, saveInterviewPracticeSession, updateInterviewPracticeSession } from '../../electron/ipc/interviewQaStore.js';
import { createInterviewPracticeRegistry } from '../../electron/ipc/interviewPracticeRegistry.js';

async function userData(run) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-'));
  try { await run(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
const feedbackPayload = code => ({
  session: code, overall: { score: 7, summary: 'Solid call; the opening was stiff.' },
  planned: [{ question: 'Tell me about yourself.', asked: true, askedAs: 'Walk me through your path so far.', score: 8, covered: 'Hit the headline and the example.', adapted: 'Adjusted fine.', improve: 'Tighten the ending.', extension: 'Mention the on-call rotation you ran.' }, { question: 'Why Discord?', asked: false, score: 1 }],
  moments: [{ kind: 'curveball', prompt: 'If voice went down tomorrow, what would you ship?', score: 5, note: 'Froze for a bit.' }],
  communication: { pace: 'Good', filler: 'Many "like"s' }, priorities: ['Curveballs', 'Shorter intro'],
  transcript: [{ role: 'interviewer', text: 'Hi, can you hear me?' }, { role: 'candidate', text: 'Loud and clear.' }],
});

export default [
  { name: 'practice registry: a code armed while the first index read is still running stays findable', async run() {
    await userData(async dir => {
      let release; let reads = 0;
      const gate = new Promise(resolve => { release = resolve; });
      // Only the first read is slow, so a second one could finish before it.
      const slowStore = { listInterviewPracticeSessions: async options => { reads += 1; const sessions = await listInterviewPracticeSessions(options); if (reads === 1) await gate; return sessions; },
        loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPracticeSession, updateInterviewPracticeSession };
      const registry = createInterviewPracticeRegistry({ userDataPath: dir, store: slowStore });
      const checking = registry.check('PRACTICE-23456789ABCDEFGHJKLM');
      setTimeout(release, 250);
      const code = await registry.arm({ nodeId: 'node-race', company: 'Acme', role: 'Engineer', questionCount: 2 });
      await checking;
      assert.equal((await registry.check(code)).status, 'armed', 'the shared index holds the code armed during the first read');
    });
  } },
  { name: 'practice feedback: bounded, typed, and rejected with a reason the chat can fix', async run() {
    const ok = validatePracticeFeedback(feedbackPayload('PRACTICE-X'));
    assert.equal(ok.overall.score, 7); assert.equal(ok.planned.length, 2); assert.equal(ok.planned[1].askedAs, ''); assert.equal(ok.moments[0].kind, 'curveball');
    assert.equal(ok.planned[0].extension, 'Mention the on-call rotation you ran.'); assert.equal(ok.planned[1].extension, '');
    assert.equal(ok.planned[1].score, null, 'a placeholder score on an unasked question is dropped');
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), planned: [{ question: 'q', asked: true, extension: 'x'.repeat(601) }] }), /planned\[0\]\.extension/u);
    assert.deepEqual(ok.communication, { pace: 'Good', clarity: '', structure: '', confidence: '', filler: 'Many "like"s' });
    assert.equal(ok.transcript.length, 2);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), overall: { score: 11, summary: 's' } }), /overall\.score/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), moments: [{ kind: 'rant', prompt: 'x' }] }), /moments\[0\]\.kind/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), priorities: ['a', 'b', 'c', 'd', 'e', 'f'] }), /priorities/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), overall: { score: 5, summary: 'bad\u0007char' } }), /overall\.summary/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), planned: [{ asked: true }] }), /planned\[0\]/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), transcript: [{ role: 'user', text: 'x' }] }), /transcript\[0\]\.role/u);
  } },
  { name: 'practice feedback: optional callId and delivery notes validate, and bad values are rejected', async run() {
    const base = validatePracticeFeedback(feedbackPayload('PRACTICE-X'));
    assert.deepEqual(Object.keys(base), ['overall', 'planned', 'moments', 'communication', 'priorities', 'transcript'], 'an existing payload keeps exactly its old keys');
    const ok = validatePracticeFeedback({ ...feedbackPayload('PRACTICE-X'), callId: 'call-3_A', delivery: {
      summary: ' Steady at 130 words per minute. ', pace: ' 130 words per minute ', pauses: 'Two over a second', fillers: 'Four, down from nine',
      confidence: 'Even', interruptions: 'One', typedAnswers: 'One typed number', fillerCount: 4, wordsPerMinute: 130.5,
    } });
    assert.equal(ok.callId, 'call-3_A');
    assert.deepEqual(ok.delivery, { summary: 'Steady at 130 words per minute.', pace: '130 words per minute', pauses: 'Two over a second', fillers: 'Four, down from nine', confidence: 'Even', interruptions: 'One', typedAnswers: 'One typed number', fillerCount: 4, wordsPerMinute: 130.5 });
    assert.deepEqual(validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 'Fine.' } }).delivery, { summary: 'Fine.' }, 'everything but the summary is optional');
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), callId: 'bad id' }), /callId/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), callId: 'x'.repeat(65) }), /callId/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), callId: 7 }), /callId/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: {} }), /delivery\.summary/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', fillerCount: -1 } }), /delivery\.fillerCount/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', fillerCount: 1.5 } }), /delivery\.fillerCount/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', wordsPerMinute: 'fast' } }), /delivery\.wordsPerMinute/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', pace: 'x'.repeat(5000) } }), /delivery\.pace/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: 'fine' }), /delivery must be an object/u);
  } },
  { name: 'practice store: planned order, armed session found by code hash, feedback with history', async run() {
    await userData(async dir => {
      await saveInterviewPractice({ userDataPath: dir, nodeId: 'h', practice: { order: ['Tell me about yourself.', 'Why Discord?', 'bad\u0001'] } });
      let saved = await loadInterviewPractice({ userDataPath: dir, nodeId: 'h' });
      assert.deepEqual(saved.order, ['Tell me about yourself.', 'Why Discord?']); assert.equal(saved.session, null);
      assert.equal(await loadInterviewPractice({ userDataPath: dir, nodeId: 'nobody' }), null);
      const hash = practiceCodeHash('PRACTICE-A');
      await saveInterviewPracticeSession({ userDataPath: dir, nodeId: 'h', session: { codeHash: hash, status: 'armed', armedAt: new Date().toISOString(), company: 'Discord' } });
      const found = (await listInterviewPracticeSessions({ userDataPath: dir })).find(item => item.session.codeHash === hash);
      assert.equal(found.nodeId, 'h'); assert.equal(found.session.status, 'armed');
      assert.equal((await listInterviewPracticeSessions({ userDataPath: dir })).find(item => item.session.codeHash === practiceCodeHash('PRACTICE-B')), undefined);
      await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: validatePracticeFeedback(feedbackPayload('x')), receivedAt: '2026-10-30T01:00:00.000Z' });
      await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: { ...validatePracticeFeedback(feedbackPayload('x')), overall: { score: 9, summary: 'Better.' } }, receivedAt: '2026-10-30T02:00:00.000Z' });
      saved = await loadInterviewPractice({ userDataPath: dir, nodeId: 'h' });
      assert.equal(saved.feedback.overall.score, 9); assert.equal(saved.history.length, 1); assert.equal(saved.history[0].overall.score, 7);
      assert.equal(saved.session.status, 'finished'); assert.deepEqual(saved.order, ['Tell me about yourself.', 'Why Discord?'], 'the plan survives feedback');
      assert.equal(saved.feedback.session.company, 'Discord');
      assert.equal(await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: validatePracticeFeedback(feedbackPayload('x')), codeHash: hash }), null, 'a finished session refuses a second write for its code');
      assert.equal((await listInterviewPracticeSessions({ userDataPath: dir })).length, 1);
    });
  } },
  { name: 'practice registry: arm once, accept feedback once, refuse unknown, duplicate and expired codes', async run() {
    await userData(async dir => {
      let clock = Date.parse('2026-10-30T10:00:00Z');
      let scans = 0;
      const counted = { listInterviewPracticeSessions: async args => { scans += 1; return listInterviewPracticeSessions(args); }, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPracticeSession, updateInterviewPracticeSession: (await import('../../electron/ipc/interviewQaStore.js')).updateInterviewPracticeSession };
      const registry = createInterviewPracticeRegistry({ userDataPath: dir, now: () => clock, store: counted });
      const events = []; registry.subscribe(event => events.push(event));
      const code = await registry.arm({ nodeId: 'h', company: 'Discord', role: 'PE', questionCount: 2 });
      assert.match(code, PRACTICE_CODE_RE);
      assert.equal((await registry.check(code)).status, 'armed');
      assert.equal((await registry.check('PRACTICE-ZZZZZZZZZZZZZZZZZZZZ')).status, 'unknown');
      for (let index = 0; index < 20; index += 1) await registry.check(`PRACTICE-${'Q'.repeat(19)}${'ABCDEFGHJKLMNPQRSTUV'[index]}`);
      assert.equal(scans, 1, 'unknown codes never make the store rescan the disk');
      await assert.rejects(registry.arm({ nodeId: 'h' }), /already in progress/u);
      assert.equal((await registry.status('h')).session.status, 'armed');
      assert.equal((await registry.status('h')).session.codeHash, undefined, 'the renderer view never carries the code hash');
      const rejected = await registry.finish(code, { overall: {} });
      assert.equal(rejected.status, 'rejected'); assert.match(rejected.note, /overall/u);
      assert.equal((await registry.finish('PRACTICE-ZZZZZZZZZZZZZZZZZZZZ', { overall: {} })).status, 'unknown_session', 'an unknown code is reported before the payload is judged');
      const race = await Promise.all([registry.finish(code, feedbackPayload(code)), registry.finish(code, feedbackPayload(code))]);
      assert.deepEqual(race.map(item => item.status).sort(), ['accepted', 'duplicate'], 'two racing finishes store exactly once');
      assert.match(race.find(item => item.status === 'accepted').note, /Stay in character/u, 'the accepted note keeps the interviewer in character');
      assert.equal((await registry.finish(code, feedbackPayload(code))).status, 'duplicate');
      assert.deepEqual(events.map(event => event.kind), ['armed', 'feedback']);
      assert.equal((await registry.status('h')).history.length, 0);
      const view = await registry.status('h');
      assert.equal(view.session.status, 'finished'); assert.equal(view.feedback.overall.score, 7);
      // A second registry (app restart) still resolves a persisted session from disk.
      const other = createInterviewPracticeRegistry({ userDataPath: dir, now: () => clock });
      const code2 = await registry.arm({ nodeId: 'h', company: 'Discord' });
      assert.equal((await other.check(code2)).status, 'armed');
      clock += 4 * 60 * 60_000;
      assert.equal((await other.check(code2)).status, 'expired');
      assert.equal((await other.finish(code2, feedbackPayload(code2))).status, 'expired');
      const code3 = await registry.arm({ nodeId: 'h' });
      await registry.cancel('h');
      assert.equal((await registry.finish(code3, feedbackPayload(code3))).status, 'cancelled');
      // A late cancel (stale UI) never overwrites a finished session.
      const code4 = await registry.arm({ nodeId: 'h' });
      assert.equal((await registry.finish(code4, feedbackPayload(code4))).status, 'accepted');
      const late = events.length;
      await registry.cancel('h');
      assert.equal((await registry.status('h')).session.status, 'finished', 'cancel after finish keeps the finished session');
      assert.equal(events.length, late, 'no cancelled notification for a finished session');
      assert.equal((await registry.finish(code4, feedbackPayload(code4))).status, 'duplicate');
    });
  } },
  { name: 'practice feedback view: memorized answer first, optional extension second and only when present', async run() {
    await withDom(async window => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-render-'));
      const entry = path.join(directory, 'PracticeProbe.jsx');
      const controller = new AbortController();
      let bundle;
      try {
        await fs.promises.writeFile(entry, `import React from 'react';\nimport { FeedbackView } from ${JSON.stringify(path.resolve('src/components/InterviewPracticePanel.jsx'))};\nexport function PracticeProbe({ feedback }) { return <FeedbackView feedback={feedback} />; }\n`);
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PracticeProbe, { feedback: validatePracticeFeedback(feedbackPayload('x')) })); await new Promise(resolve => setTimeout(resolve, 0)); });
        const view = window.document.querySelector('[data-testid="practice-feedback"]');
        const memorized = [...view.querySelectorAll('section[aria-label="Memorized answer"]')];
        const extensions = [...view.querySelectorAll('details.practice-extension')];
        assert.equal(memorized.length, 1, 'every asked question gets a memorized-answer section; the unasked one is collapsed into one line');
        assert.ok(view.querySelector('details[data-testid="practice-unasked"]')?.textContent.includes('Why Discord?'), 'an unasked question is listed inside the collapsed line');
        assert.equal(extensions.length, 1, 'only the question with extension material gets the optional section');
        assert.ok(memorized[0].textContent.includes('Hit the headline and the example.'));
        assert.ok(extensions[0].textContent.includes('Mention the on-call rotation you ran.'));
        assert.ok(extensions[0].textContent.includes('Say this only if you can back it with a real example.'));
        assert.ok(memorized[0].compareDocumentPosition(extensions[0]) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the memorized section comes before the optional extension');
        assert.ok(extensions[0].closest('li') === memorized[0].closest('li'), 'both sections belong to the same question');
        assert.ok(view.textContent.indexOf('Work on first') < view.textContent.indexOf('Memorized answer'), 'priorities lead the report');
        await bundle.module.act(async () => { root.unmount(); });
      } finally { controller.abort(); await bundle?.dispose(); await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  } },
  { name: 'practice panel source: the Claude-chat practice UI and its IPC are gone, the in-app call and feedback view stay', async run() {
    const source = await fs.promises.readFile(path.resolve('src/components/InterviewPracticePanel.jsx'), 'utf8');
    assert.equal(source.includes('Practice in Claude chat'), false, 'no Claude-chat practice heading');
    assert.equal(source.includes('Start practice interview'), false, 'no Claude-chat start button');
    assert.equal(source.includes('onInterviewPracticeUpdated'), false, 'no Claude-chat subscription');
    assert.equal(source.includes('connectorUrl'), false, 'no connector URL box');
    assert.doesNotMatch(source, /\b(?:load|cancel|start)InterviewPractice\b/u, 'the panel never calls the Claude-chat IPC');
    assert.equal(/import \{[^}]*\bCopy\b[^}]*\} from 'lucide-react'/u.test(source), false, 'the unused Copy icon import is gone');
    assert(source.includes('Start practice call'), 'the in-app call button stays');
    assert(source.includes('Past calls'), 'past calls stay');
    assert.match(source, /export function FeedbackView/u, 'FeedbackView keeps its named export');
    assert.match(source, /export default InterviewPracticePanel/u);
  } },
  { name: 'practice panel render: the call starts with no connector, no Claude-chat API and no session', async run() {
    await withDom(async window => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-panel-'));
      const entry = path.join(directory, 'PracticePanelProbe.jsx');
      const controller = new AbortController();
      let bundle;
      try {
        await fs.promises.writeFile(entry, `import React from 'react';\nimport { InterviewPracticePanel } from ${JSON.stringify(path.resolve('src/components/InterviewPracticePanel.jsx'))};\nexport function PanelProbe(props) { return <InterviewPracticePanel {...props} />; }\n`);
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
        const started = [];
        window.electronAPI = { startPracticeCall: async args => { started.push(args); return { success: true }; } };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const props = { nodeId: 'helper-1', briefRecordId: 'c'.repeat(64), snapshotId: 'd'.repeat(64), canonicalJobUrl: 'https://jobs.example/1', ready: true };
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PanelProbe, props)); await new Promise(resolve => setTimeout(resolve, 0)); });
        const panel = () => window.document.querySelector('section[aria-label="Practice interview"]');
        assert.ok(panel(), 'the panel renders when only the in-app call API exists');
        assert.equal(panel().textContent.includes('Practice in Claude chat'), false, 'no Claude-chat practice UI is rendered');
        const button = [...panel().querySelectorAll('button')].find(item => item.textContent.trim() === 'Start practice call');
        assert.ok(button, 'the Start practice call button renders');
        assert.equal(button.disabled, false, 'the call is not gated on connector readiness or a Claude-chat session');
        await bundle.module.act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
        assert.equal(started.length, 1, 'clicking the button starts the in-app call');
        assert.equal(started[0].nodeId, 'helper-1'); assert.equal(started[0].canonicalJobUrl, 'https://jobs.example/1');
        delete window.electronAPI.startPracticeCall;
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PanelProbe, props)); await new Promise(resolve => setTimeout(resolve, 0)); });
        assert.equal(panel(), null, 'without the in-app call API there is nothing to practise');
        await bundle.module.act(async () => { root.unmount(); });
      } finally { controller.abort(); await bundle?.dispose(); await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  } },
  { name: 'practice panel render: with interviews held before for this job, Start offers a new one or an earlier one again', async run() {
    await withDom(async window => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-saved-'));
      const entry = path.join(directory, 'PracticePanelProbe.jsx');
      const controller = new AbortController();
      let bundle;
      try {
        await fs.promises.writeFile(entry, `import React from 'react';\nimport { InterviewPracticePanel } from ${JSON.stringify(path.resolve('src/components/InterviewPracticePanel.jsx'))};\nexport function PanelProbe(props) { return <InterviewPracticePanel {...props} />; }\n`);
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
        const started = [];
        const removed = [];
        let saved = [];
        const SAVED = { id: 'iv-abcd1234-000001', lastUsedAt: Date.UTC(2026, 10, 20, 15), timesUsed: 2, lead: { name: 'Nora Lead', role: 'Hiring Manager' }, panel: [{ name: 'Ben Second', role: 'Staff Engineer' }], questionCount: 6, problemCount: 1, minutes: 27, steering: 'Final round' };
        window.electronAPI = {
          startPracticeCall: async args => { started.push(args); return { success: true }; },
          listSavedPracticeInterviews: async ({ nodeId }) => { assert.equal(nodeId, 'helper-1'); return saved; },
          removeSavedPracticeInterview: async args => { removed.push(args); saved = []; return true; },
        };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const props = { nodeId: 'helper-1', briefRecordId: 'c'.repeat(64), snapshotId: 'd'.repeat(64), canonicalJobUrl: 'https://jobs.example/1', ready: true, steering: 'Go easy on me' };
        const settle = () => bundle.module.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
        const click = async node => { await bundle.module.act(async () => { node.dispatchEvent(new window.Event('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 5)); }); };
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PanelProbe, props)); await new Promise(resolve => setTimeout(resolve, 5)); });
        const panel = () => window.document.querySelector('section[aria-label="Practice interview"]');
        const buttonNamed = text => [...panel().querySelectorAll('button')].find(item => item.textContent.trim() === text);
        // None kept yet: Start starts a new interview at once, with the steering.
        await click(buttonNamed('Start practice call'));
        assert.equal(started.length, 1);
        assert.equal(started[0].steering, 'Go easy on me');
        assert.equal('repeatInterviewId' in started[0], false);
        // One kept: Start asks first.
        saved = [SAVED];
        await click(buttonNamed('Start practice call'));
        assert.equal(started.length, 1, 'nothing starts before the choice');
        const chooser = panel().querySelector('[aria-label="Choose an interview"]');
        assert.ok(chooser, 'the choice is shown');
        assert.ok(chooser.textContent.includes('Nora Lead (Hiring Manager) + 1 colleague · 6 questions · 1 problem · ~27 min'), chooser.textContent);
        assert.ok(chooser.textContent.includes('2 times') && chooser.textContent.includes('Focus: Final round'));
        await click(chooser.querySelector('button[aria-label="Repeat the interview with Nora Lead"]'));
        assert.equal(started.length, 2);
        assert.equal(started[1].repeatInterviewId, SAVED.id, 'the earlier interview is held again');
        assert.equal('steering' in started[1], false, 'a repeat keeps the steering it was planned with');
        assert.equal(panel().querySelector('[aria-label="Choose an interview"]'), null, 'the choice closes once started');
        // Start again: a new one, with the box's steering.
        await click(buttonNamed('Start practice call'));
        await click(buttonNamed('New interview'));
        assert.equal(started.length, 3);
        assert.equal(started[2].steering, 'Go easy on me');
        assert.equal('repeatInterviewId' in started[2], false);
        // The steer box stays editable while a call cannot start (not ready, disabled, or starting).
        const steerBox = () => panel().querySelector('textarea');
        for (const blocked of [{ ready: false }, { disabled: true }]) {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PanelProbe, { ...props, ...blocked })); await new Promise(resolve => setTimeout(resolve, 5)); });
          assert.equal(steerBox().disabled, false, `the steer box is editable when ${JSON.stringify(blocked)}`);
        }
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PanelProbe, props)); await new Promise(resolve => setTimeout(resolve, 5)); });
        // While choosing, the focus box is hidden: a repeat keeps the focus it was planned with.
        await click(buttonNamed('Start practice call'));
        assert.equal(steerBox(), null, 'the focus box is hidden while choosing');
        // Back closes it; removing the last one closes it too, after a second press.
        await click(buttonNamed('Back'));
        assert.equal(panel().querySelector('[aria-label="Choose an interview"]'), null);
        assert.equal(started.length, 3);
        await click(buttonNamed('Start practice call'));
        await click(panel().querySelector('button[aria-label="Remove the interview with Nora Lead"]'));
        await settle();
        assert.deepEqual(removed, [], 'one press only asks');
        await click(panel().querySelector('[aria-label="Remove the interview with Nora Lead?"] button'));
        await settle();
        assert.deepEqual(removed, [{ nodeId: 'helper-1', id: SAVED.id }]);
        assert.equal(panel().querySelector('[aria-label="Choose an interview"]'), null, 'nothing left to choose');
        await bundle.module.act(async () => { root.unmount(); });
      } finally { controller.abort(); await bundle?.dispose(); await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  } },
  { name: 'practice codes: one-shot, well formed and stored only as a hash', async run() {
    const code = newPracticeCode();
    assert.match(code, PRACTICE_CODE_RE);
    assert.notEqual(newPracticeCode(), code, 'every run arms a fresh one-shot code');
    assert.notEqual(practiceCodeHash(code), code, 'the code is never stored in the clear');
    assert.notEqual(practiceCodeHash(code), practiceCodeHash(newPracticeCode()), 'a hash names exactly one code');
  } },
  { name: 'practice code pattern is built from the alphabet and length, and the schema reuses the call id pattern', async run() {
    assert.equal(PRACTICE_CODE_RE.source, '^PRACTICE-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{20}$');
    assert.equal(PRACTICE_CODE_RE.flags, 'u');
    assert.equal(INTERVIEW_PRACTICE_FEEDBACK_SCHEMA.properties.callId.pattern, PRACTICE_CALL_ID_RE.source);
  } },
  { name: 'practice plan order: saved order first, then any card the plan does not know yet', async run() {
    const ordered = orderPracticeQuestions([{ question: 'B?' }, { question: 'A?' }, { question: 'a?' }, { question: 'C?' }], ['A?', 'Missing?', 'C?']);
    assert.deepEqual(ordered.map(card => card.question), ['A?', 'C?', 'B?']);
  } },
  { name: 'practice feedback: a planned question is the plan\'s own text and may be longer than a model-written field', async run() {
    const question = `${'Why do you want this role? '.repeat(12)}`.trim();
    assert.ok(question.length > 300 && question.length <= PRACTICE_FEEDBACK_LIMITS.question);
    assert.equal(validatePracticeFeedback({ ...feedbackPayload('c'), planned: [{ question, asked: false }] }).planned[0].question, question);
    assert.equal(INTERVIEW_PRACTICE_FEEDBACK_SCHEMA.properties.planned.items.properties.question.maxLength, PRACTICE_FEEDBACK_LIMITS.question);
  } },
  { name: 'practice feedback: validation can collect every violation instead of stopping at the first', async run() {
    const bad = { ...feedbackPayload('c'), overall: { score: 5, summary: 'x'.repeat(1501) }, priorities: ['y'.repeat(301)], moments: [{ kind: 'rant', prompt: 'p' }] };
    assert.throws(() => validatePracticeFeedback(bad), error => !error.issues && /overall\.summary/u.test(error.message) && !/priorities/u.test(error.message), 'the default stops at the first');
    try { validatePracticeFeedback(bad, { all: true }); assert.fail('must throw'); } catch (error) {
      assert.equal(error.issues.length, 3);
      assert.match(error.message, /overall\.summary.*moments\[0\]\.kind.*priorities\[0\]/u);
    }
  } },
  { name: 'practice feedback: over-long model text is cut at a sentence end or a word, and over-long lists lose their tail', async run() {
    const sentence = 'This is a sentence of moderate length that says something. ';
    const long = sentence.repeat(40);
    const cutSentence = trimPracticeText(long, 600);
    assert.ok(cutSentence.length <= 600 && cutSentence.endsWith('something.'), 'ends on a sentence end inside the limit');
    const noStops = trimPracticeText('word '.repeat(200), 100);
    assert.ok(noStops.length <= 100 && noStops.endsWith('\u2026') && !/\s\u2026$/u.test(noStops), 'a word boundary and an ellipsis');
    assert.equal(trimPracticeText('short', 100), 'short');
    assert.ok(trimPracticeText(`Ok. ${'word '.repeat(200)}`, 100).endsWith('\u2026'), 'an early sentence end that would gut the text is not used');
    const input = { ...feedbackPayload('c'), overall: { score: 5, summary: long }, priorities: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      planned: [{ question: 'Q?', asked: true, score: 4, covered: long }], communication: { pace: 'p'.repeat(400) }, delivery: { summary: 'd'.repeat(1600), fillerCount: 'many' } };
    const { feedback, trimmed } = trimPracticeFeedback(input);
    assert.equal(input.overall.summary, long, 'the input is not changed');
    assert.deepEqual(trimmed.map(item => item.path).sort(), ['communication.pace', 'delivery.summary', 'overall.summary', 'planned[0].covered', 'priorities'].sort());
    assert.deepEqual(trimmed.find(item => item.path === 'priorities'), { path: 'priorities', length: 7, limit: 5 });
    assert.equal(trimmed.find(item => item.path === 'overall.summary').length, long.length);
    assert.equal(feedback.delivery.fillerCount, 'many', 'a wrong type is left for the validator');
    assert.throws(() => validatePracticeFeedback(feedback), /delivery\.fillerCount/u);
    const fixed = validatePracticeFeedback({ ...feedback, delivery: { summary: feedback.delivery.summary } });
    assert.ok(fixed.overall.summary.length <= 1500 && fixed.priorities.length === 5);
  } },
];
