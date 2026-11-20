// "Report a bug" in the standalone Interview Helper app: what a report holds,
// what it leaves out, where it is saved and what reaches the clipboard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUG_REPORT_COPY_CHANNEL, BUG_REPORT_DESCRIPTION_MAX, BUG_REPORT_MAX_AGE_MS, BUG_REPORT_RETENTION, BUG_REPORT_SAVE_CHANNEL,
  buildBugReportMarkdown, buildBugReportPointer, createBugReportService, createBugReportStore, interviewRows, listDataFolder,
  callTimeline, debugLineForReport, normalizeBugReportPayload, redactReportText, registerBugReportHandlers, validateBugReportDescription,
} from '../../electron/interviewApp/bugReport.js';
import { callControlName } from '../../src/practice-call/callEventLog.js';
import { controlName, eventLogSnapshot, installEventCapture, logEvent, resetEventLogForTest } from '../../src/utils/eventLog.js';
import { buildMacApplication, readConfiguredMacSigningConfig, selectBuildTarget } from '../build-macos.mjs';

async function withTempDir(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-bug-report-'));
  try { return await fn(directory); }
  finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

const SECRET_TITLE = 'Staff Engineer at Hidden Corp';
const sessionsState = () => ({
  selectedId: 'two', appliedJobsFolder: '/Users/someone/Applied Jobs',
  sessions: [
    { id: 'one', title: SECRET_TITLE, data: { interviewHelperCareerFilenames: ['resume.pdf', 'notes.md'], interviewHelperCareerSnapshotId: 'a'.repeat(64), interviewHelperApplicationBundle: { label: SECRET_TITLE }, interviewHelperPreparation: { status: 'failed', message: 'private text' }, interviewHelperPreparationRunId: 'run-1', interviewHelperCurrentStep: 2 } },
    { id: 'two', title: '', data: { interviewHelperTypedJob: 'Engineer at Hidden Corp', interviewHelperTypedJobKind: 'generated', interviewHelperJobUrl: 'https://jobs.hidden.test/1?token=abc' } },
    { id: 'three', title: '', data: {} },
  ],
});

const sources = (overrides = {}) => ({
  app: () => ({ getVersion: () => '1.2.3', isPackaged: true }),
  windows: () => ({ 'Cue card': false, 'Practice call': true }),
  sessions: () => sessionsState(),
  claudeStatus: () => ({ paused: true, pauseCode: 'CLAUDE_USAGE_LIMIT' }),
  claudeActivity: () => ({
    running: 1, waiting: 2, held: ['node:x'], claudeAccounts: [{ id: 'a' }],
    tasks: { r1: { task: 'interview-answer', state: 'running', phase: 'writing', model: 'claude-opus', effort: 'high', round: 2, rejections: 1, toolTurns: 3, firstStartedAt: 1_000_000 - 90_000, phaseStartedAt: 1_000_000 - 5_000, failure: { code: 'CLAUDE_TIMEOUT', attempts: 1 }, steps: [{ at: 999_000, label: 'Reading https://example.test/page?session=abc' }] } },
  }),
  claudePauses: () => '\n## Claude Usage Pauses (CLAUDEPAUSE)\n- Current: not limited\n',
  activeTasks: () => [{ taskCount: 2, oldestAgeMs: 61_000, channels: ['build-interview-brief'], nodeId: 'one' }],
  handoffs: () => ({ aggregate: { issued: 4, accepted: 3, rejected: 0 } }),
  dataFolder: () => [{ name: 'career-text', kind: 'folder', children: 2, changedAt: 5 }, { name: 'interview-helper-sessions.json', kind: 'file', bytes: 2048, changedAt: 6 }],
  logs: () => [
    { ts: Date.now() + 2, level: 'error', message: '[build-interview-brief] failed: boom at /Users/someone/secret/file.js token=abc123' },
    { ts: Date.now() + 1, level: 'info', message: 'fetched https://api.example.test/v1/thing?api_key=zzz#frag for 123e4567-e89b-12d3-a456-426614174000' },
  ],
  ...overrides,
});

const payload = (overrides = {}) => ({
  description: 'Prepare never finished.\nI pressed it twice.',
  renderer: {
    events: ['[t] click "Prepare"', '[t] ERROR console: failed to read /Users/someone/x.txt'], eventsDropped: 3,
    screenMessages: ['alert: Preparation failed'], windowWidth: 1180, windowHeight: 860, selectedIndex: 1, online: true,
  },
  ...overrides,
});

const tests = [
  {
    name: 'bug report: log and event text loses URL queries, local paths, credentials and opaque ids',
    run() {
      const text = redactReportText('GET https://a.example.test/p/q?x=1#y, wrote /Users/jack/Desktop/file.txt (password: "hunter2") Bearer abc.def id 123e4567-e89b-12d3-a456-426614174000 sk-abcdefghijklmnopqrstuv');
      assert.match(text, /https:\/\/a\.example\.test\/p\/q,/u, 'the address stays, its query and fragment go');
      for (const gone of ['x=1', '#y', 'jack', 'hunter2', 'abc.def', '123e4567', 'sk-abcdef']) assert.ok(!text.includes(gone), `${gone} is removed`);
      assert.match(text, /<local-path>/u);
      assert.match(text, /<opaque-id>/u);
      assert.equal(redactReportText('round 2 of 3: tokens used 5120'), 'round 2 of 3: tokens used 5120', 'ordinary diagnostics are left alone');
    },
  },
  {
    name: 'bug report: the description is kept whole and only bounded; other window input is reduced to reviewed fields',
    run() {
      assert.deepEqual(validateBugReportDescription(undefined), { ok: true, value: '' });
      assert.deepEqual(validateBugReportDescription('  a\r\nb\u0007  '), { ok: true, value: 'a\nb' });
      assert.equal(validateBugReportDescription(5).ok, false);
      assert.equal(validateBugReportDescription('x'.repeat(BUG_REPORT_DESCRIPTION_MAX + 1)).ok, false);
      assert.throws(() => normalizeBugReportPayload({ description: {} }), TypeError);
      const normalized = normalizeBugReportPayload({ description: 'hi', renderer: { events: ['a', 5, 'b'], screenMessages: 'nope', windowWidth: -1, windowHeight: 700.4, selectedIndex: 'x', online: 'yes', extra: 1 }, extra: 1 });
      assert.deepEqual(normalized, { description: 'hi', renderer: { events: ['a', 'b'], eventsDropped: 0, screenMessages: [], windowWidth: null, windowHeight: 700, selectedIndex: null, online: null } });
      assert.equal(normalizeBugReportPayload({ renderer: { events: Array.from({ length: 900 }, (_, index) => `e${index}`) } }).renderer.events.length, 400, 'only the newest events are kept');
    },
  },
  {
    name: 'bug report: interviews appear as states and counts, never as names, links or text',
    run() {
      const rows = interviewRows(sessionsState());
      assert.deepEqual(rows[0], { index: 1, selected: false, named: true, careerFiles: 2, careerSnapshot: true, job: 'application folder', preparation: 'failed', runPending: true, step: 2 });
      assert.deepEqual(rows[1], { index: 2, selected: true, named: false, careerFiles: 0, careerSnapshot: false, job: 'typed (generated)', preparation: 'none', runPending: false, step: 0 });
      assert.equal(rows[2].job, 'none');
      assert.equal(interviewRows(sessionsState(), 0)[0].selected, true, 'the window says which interview is on screen');
      assert.deepEqual(interviewRows(null), []);
    },
  },
  {
    name: 'bug report: the report has every section and none of the private text',
    async run() {
      const markdown = await buildBugReportMarkdown({ payload: payload(), sources: sources(), now: 1_000_000 });
      for (const heading of ['# Interview Helper bug report', '## Issue description', '## System', '## Windows', '## Interviews', '## Claude worker', '## Claude Usage Pauses (CLAUDEPAUSE)', '## Requests still running in the app', '## AI steps since the app started', '## Data folder', '## Messages on screen', '## Window events (2, 3 older dropped)', '## App log (2 lines)']) {
        assert.ok(markdown.includes(heading), `missing ${heading}`);
      }
      assert.ok(markdown.includes('Prepare never finished.\nI pressed it twice.'), 'the description is kept as typed');
      assert.match(markdown, /Interview Helper 1\.2\.3 \(packaged\)/u);
      assert.match(markdown, /Main window: 1180 × 860 px/u);
      assert.match(markdown, /- Practice call: open/u);
      assert.match(markdown, /3 saved · Applied Jobs folder chosen/u);
      assert.match(markdown, /\| 1 \| no \| yes \| 2 \| yes \| application folder \| failed \| yes \| 2 \|/u);
      assert.match(markdown, /Paused: CLAUDE_USAGE_LIMIT/u);
      assert.match(markdown, /interview-answer · running \/ writing · model claude-opus \(high\) · round 2 · rejected 1 · tool turns 3 · started 90s ago · in this phase 5s · last failure CLAUDE_TIMEOUT \(attempt 1\)/u);
      assert.match(markdown, /Reading https:\/\/example\.test\/page$/mu, 'a step keeps the page, not its query');
      assert.match(markdown, /2 task\(s\) · oldest 61s · build-interview-brief/u);
      assert.match(markdown, /issued 4 · accepted 3/u);
      assert.match(markdown, /interview-helper-sessions\.json · file · 2,048 bytes/u);
      assert.match(markdown, /- alert: Preparation failed/u);
      assert.match(markdown, / {4}\[t\] click "Prepare"/u);
      const info = markdown.indexOf('INFO  fetched https://api.example.test/v1/thing for <opaque-id>');
      const error = markdown.indexOf('ERROR [build-interview-brief] failed: boom at <local-path>');
      assert.ok(info > 0 && error > info, 'the app log is redacted and oldest first');
      for (const secret of [SECRET_TITLE, 'Hidden Corp', 'jobs.hidden.test', 'private text', 'resume.pdf', '/Users/someone', 'abc123', 'api_key', 'run-1', 'session=abc']) {
        assert.ok(!markdown.includes(secret), `${secret} must not be in a report`);
      }
    },
  },
  {
    name: 'bug report: a section whose source fails is reported and the rest is still written',
    async run() {
      const markdown = await buildBugReportMarkdown({
        payload: { description: '' },
        sources: sources({ sessions: () => { throw new Error('sessions file unreadable at /Users/someone/x.json'); }, dataFolder: async () => { throw new Error('gone'); }, claudeActivity: undefined, logs: () => [] }),
      });
      assert.match(markdown, /_No description was given\._/u);
      assert.match(markdown, /## Interviews\n- This section could not be written: sessions file unreadable at <local-path>/u);
      assert.match(markdown, /## Data folder\n- This section could not be written: gone/u);
      assert.match(markdown, /No Claude task is queued or running\./u);
      assert.match(markdown, /## App log \(0 lines\)\n[^\n]*\n- Nothing logged\./u);
      const bare = await buildBugReportMarkdown({ payload: {}, sources: {} });
      assert.match(bare, /## Data folder\n- Could not be read\./u, 'a report can be made with no sources at all');
    },
  },
  {
    name: 'bug report: the data folder is listed by name, kind and size without opening files',
    async run() {
      await withTempDir(async (directory) => {
        await fs.promises.mkdir(path.join(directory, 'practice-calls', 'call-1'), { recursive: true });
        await fs.promises.writeFile(path.join(directory, 'practice-calls', 'note.txt'), 'x');
        await fs.promises.writeFile(path.join(directory, 'sessions.json'), '12345');
        await fs.promises.writeFile(path.join(directory, '.hidden'), 'x');
        const entries = await listDataFolder(directory);
        assert.deepEqual(entries.map(({ name, kind, children, bytes }) => ({ name, kind, children, bytes })), [
          { name: 'practice-calls', kind: 'folder', children: 2, bytes: undefined },
          { name: 'sessions.json', kind: 'file', children: undefined, bytes: 5 },
        ]);
      });
    },
  },
  {
    name: 'bug report: saved reports never overwrite each other and are pruned by age and count',
    async run() {
      await withTempDir(async (root) => {
        const directory = path.join(root, 'bug-reports');
        let clock = Date.parse('2026-11-18T10:00:00.000Z');
        const store = createBugReportStore({ directory, now: () => clock });
        assert.throws(() => createBugReportStore({ directory: 'relative' }), TypeError);
        assert.deepEqual(await store.prune(), { removed: 0, error: null }, 'a first run with no folder is not an error');
        const first = await store.write('one\ntwo');
        const second = await store.write('three');
        assert.equal(path.basename(first.filePath), 'bug-report-2026-11-18T10-00-00-000Z.md');
        assert.equal(path.basename(second.filePath), 'bug-report-2026-11-18T10-00-00-000Z-2.md', 'the same millisecond gets a new name');
        assert.deepEqual([first.chars, first.lines], [7, 2]);
        assert.equal(await fs.promises.readFile(first.filePath, 'utf8'), 'one\ntwo');
        assert.equal((await fs.promises.stat(first.filePath)).mode & 0o777, 0o600);

        // An old report and a file of another name: only the report is removed.
        const old = path.join(directory, 'bug-report-old.md');
        const foreign = path.join(directory, 'notes.txt');
        await fs.promises.writeFile(old, 'old');
        await fs.promises.writeFile(foreign, 'mine');
        const longAgo = new Date(Date.now() - BUG_REPORT_MAX_AGE_MS - 60_000);
        await fs.promises.utimes(old, longAgo, longAgo);
        clock = Date.now();
        assert.deepEqual(await store.prune(), { removed: 1, error: null });
        assert.equal(fs.existsSync(old), false);
        assert.equal(fs.existsSync(foreign), true);

        for (let index = 0; index < BUG_REPORT_RETENTION + 3; index += 1) { clock += 1000; await store.write(`report ${index}`); }
        const kept = (await fs.promises.readdir(directory)).filter(name => name.startsWith('bug-report-'));
        assert.equal(kept.length, BUG_REPORT_RETENTION, 'only the newest reports stay');
        clock += 1000;
        const last = await store.write('newest');
        assert.equal(fs.existsSync(last.filePath), true, 'the report just written is never pruned');
      });
    },
  },
  {
    name: 'bug report: copy saves the report and puts only a pointer and the description on the clipboard',
    async run() {
      await withTempDir(async (root) => {
        const copied = [];
        const store = createBugReportStore({ directory: path.join(root, 'bug-reports') });
        const service = createBugReportService({ store, sources: sources(), clipboard: { writeText: text => copied.push(text) }, dialog: {}, now: () => Date.parse('2026-11-18T10:00:00.000Z') });
        const result = await service.copy(payload());
        assert.equal(result.delivery, 'file-pointer');
        const saved = await fs.promises.readFile(result.savedPath, 'utf8');
        assert.match(saved, /^# Interview Helper bug report\n/u);
        assert.equal(saved.length, result.chars);
        assert.equal(copied.length, 1);
        assert.ok(copied[0].includes(`\`${result.savedPath}\``), 'the clipboard names the file');
        assert.ok(copied[0].includes('## Issue description\nPrepare never finished.\nI pressed it twice.'), 'the description is on the clipboard in full');
        assert.ok(!copied[0].includes('## App log'), 'the report body is not pasted');
        assert.match(copied[0], /Generated: 2026-11-18T10:00:00\.000Z/u);
        assert.ok(!buildBugReportPointer({ filePath: '/x', chars: 1, lines: 1, generatedAt: 't', description: '' }).includes('Issue description'));

        // The file cannot be written: the whole report is copied instead of nothing.
        const failing = createBugReportService({ store: { write: async () => { throw new Error('disk full'); } }, sources: sources(), clipboard: { writeText: text => copied.push(text) }, dialog: {} });
        const fallback = await failing.copy(payload());
        assert.deepEqual([fallback.delivery, fallback.saveError], ['inline', 'disk full']);
        assert.ok(copied[1].includes('## App log'));
        await assert.rejects(service.copy({ description: 'x'.repeat(BUG_REPORT_DESCRIPTION_MAX + 1) }), TypeError);
      });
    },
  },
  {
    name: 'bug report: save writes where the person chooses and does nothing when the dialog is cancelled',
    async run() {
      await withTempDir(async (root) => {
        const target = path.join(root, 'chosen.md');
        const asked = [];
        const owner = { id: 1 };
        let answer = { canceled: false, filePath: target };
        const dialog = { showSaveDialog: async (...args) => { asked.push(args); return answer; } };
        const service = createBugReportService({ store: null, sources: sources(), clipboard: null, dialog, getWindow: () => owner, desktopPath: () => '/Users/x/Desktop', now: () => Date.parse('2026-11-18T10:00:00.000Z') });
        const result = await service.save(payload());
        assert.deepEqual([result.canceled, result.savedPath], [false, target]);
        assert.equal(asked[0][0], owner, 'the dialog belongs to the main window');
        assert.equal(asked[0][1].defaultPath, '/Users/x/Desktop/interview-helper-bug-report-2026-11-18T10-00-00-000Z.md');
        assert.match(await fs.promises.readFile(target, 'utf8'), /## Issue description\nPrepare never finished\./u);
        answer = { canceled: true };
        await fs.promises.rm(target);
        assert.deepEqual(await service.save(payload()), { canceled: true });
        assert.equal(fs.existsSync(target), false);
      });
    },
  },
  {
    name: 'bug report: handlers are guarded, answer with success or the error, and the app wires them once',
    async run() {
      const handled = new Map();
      const guardedCalls = [];
      registerBugReportHandlers({
        ipcMain: { handle: (channel, handler) => handled.set(channel, handler) },
        guarded: handler => async (_event, ...args) => { guardedCalls.push(args.length); return handler(...args); },
        service: { copy: async value => ({ delivery: 'file-pointer', got: value.description }), save: async () => { throw new TypeError('The description must be text.'); } },
      });
      assert.deepEqual([...handled.keys()], [BUG_REPORT_COPY_CHANNEL, BUG_REPORT_SAVE_CHANNEL]);
      assert.deepEqual(await handled.get(BUG_REPORT_COPY_CHANNEL)({}, { description: 'd' }), { success: true, delivery: 'file-pointer', got: 'd' });
      assert.deepEqual(await handled.get(BUG_REPORT_SAVE_CHANNEL)({}, { description: 5 }), { success: false, error: 'The description must be text.' });
      assert.deepEqual(guardedCalls, [1, 1]);
      const main = fs.readFileSync(new URL('../../electron/interviewApp/main.js', import.meta.url), 'utf8');
      assert.match(main, /createBugReportStore\(\{ directory: path\.join\(roots\.profile, BUG_REPORT_DIRECTORY\) \}\)/u, 'reports live in the profile, outside the interview data');
      assert.match(main, /registerBugReportHandlers\(\{\s*ipcMain, guarded,/u, 'only the main window may ask for a report');
      const app = fs.readFileSync(new URL('../../src/interview-app/InterviewHelperApp.jsx', import.meta.url), 'utf8');
      assert.match(app, /Report a bug…/u);
    },
  },
  {
    name: 'bug report: the window remembers presses, errors and warnings, not typed text or interview names',
    run() {
      resetEventLogForTest();
      const listeners = new Map();
      const printed = [];
      const target = {
        console: { error: (...args) => printed.push(['error', ...args]), warn: (...args) => printed.push(['warn', ...args]) },
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
      };
      const stop = installEventCapture(target);
      assert.equal(typeof installEventCapture(target), 'function', 'a second install is a no-op');
      const control = (label, inList = false) => ({ getAttribute: name => (name === 'aria-label' ? label : null), textContent: 'ignored', closest: selector => (selector.includes('listbox') ? (inList ? {} : null) : null) });
      listeners.get('click')({ target: { closest: () => control('Prepare') } });
      listeners.get('click')({ target: { closest: () => control('Acme interview', true) } });
      listeners.get('click')({ target: { closest: () => null } });
      listeners.get('error')({ error: new TypeError('x is not a function') });
      listeners.get('unhandledrejection')({ reason: 'late failure' });
      target.console.warn('careful', { a: 1 });
      target.console.error('bad');
      assert.deepEqual(printed, [['warn', 'careful', { a: 1 }], ['error', 'bad']], 'console output still prints');
      const { events, eventsDropped } = eventLogSnapshot();
      assert.equal(eventsDropped, 0);
      const text = events.map(line => line.replace(/^\[[^\]]+\] /u, ''));
      assert.equal(text[0], 'window opened');
      assert.equal(text[1], 'click "Prepare"');
      assert.equal(text[2], 'click (an interview in the list)');
      assert.match(text[3], /^ERROR TypeError: x is not a function/u);
      assert.deepEqual(text.slice(4), ['ERROR unhandled rejection: late failure', 'WARN console: careful {"a":1}', 'ERROR console: bad']);
      assert.equal(controlName({ getAttribute: () => null, textContent: `  ${'long '.repeat(40)}` }).length, 60);
      stop();
      assert.equal(listeners.size, 0);
      target.console.error('after');
      assert.equal(eventLogSnapshot().events.length, events.length, 'nothing is recorded after stopping');
      for (let index = 0; index < 320; index += 1) logEvent('note', `x${index}`);
      assert.deepEqual([eventLogSnapshot().events.length, eventLogSnapshot().eventsDropped], [300, events.length + 20]);
      resetEventLogForTest();
    },
  },
  {
    name: 'practice calls: each recent call\'s debug log is a timeline with content reduced to sizes; notes, warnings and errors keep their text',
    async run() {
      const line = (up, ms, event, data) => JSON.stringify({ t: '2026-11-20T10:00:00.000Z', up, ms, event, ...(data ? { data } : {}) });
      const debugText = [
        line(5, null, 'start', { callId: 'call-1', args: { nodeId: 'n', canonicalJobUrl: 'https://jobs.hidden.test/1' }, steering: 'SECRET STEERING' }),
        line(900, null, 'setup-timing', { name: 'voices', ms: 880 }),
        line(1000, null, 'phase', { from: 'precheck', phase: 'ringing', elapsedMs: 0 }),
        line(5000, 10, 'session-turn', { kind: 'main', message: 'SECRET PROMPT TO THE INTERVIEWER' }),
        line(6000, 1000, 'engine', { type: 'caption', text: 'SECRET CAPTION', speaker: 'A', name: 'Private Interviewer' }),
        line(7000, 2000, 'helper', { type: 'transcript', final: true, text: 'SECRET SPOKEN ANSWER', segmentId: 4 }),
        line(8000, 3000, 'user', { action: 'chat', text: 'SECRET CHAT' }),
        line(8100, 3100, 'window', { line: '[2026-11-20T10:00:08.000Z] click "Hang up"' }),
        line(9000, 4000, 'warn', { message: '[PracticeCall] session restarted: timeout at /Users/someone/Library/x.js' }),
        line(9500, 4500, 'fail', { code: 'precheck-failed', message: 'helper exited 1', stack: 'Error: helper exited 1\n at /Users/someone/app.js:1:1' }),
        line(12000, null, 'analysis-review-reply', { attempt: 1, ms: 52000, outcome: 'rejected', error: 'feedback.planned has no entry for card 1 ("SECRET QUESTION"), which the call asked', keys: ['feedback', 'chapters'] }),
        line(13000, null, 'analysis-done', { status: 'ready', ms: 61000, chapters: 4 }),
        '{not json',
      ].join('\n');
      const markdown = await buildBugReportMarkdown({ payload: {}, now: Date.parse('2026-11-20T10:05:00.000Z'), sources: sources({
        practiceCalls: () => ({
          logStats: { count: 2, bytes: 4096 },
          calls: [
            { callId: 'call-1', startedAt: Date.parse('2026-11-20T10:00:00.000Z'), bytes: debugText.length, text: debugText, hasAudio: true,
              record: { durationMs: 300_000, reason: 'candidate', transcriptEntries: 12, candidateTurns: 6, interviewers: 2, pickedQuestions: 5, askedQuestions: 4, answeredQuestions: 3, feedbackSkipped: false, timings: { setupLeadMs: 4200 } },
              analysis: { status: 'failed', error: 'feedback.planned marks card 2 ("SECRET OTHER QUESTION") as not asked', chapters: 0, hasFeedback: false } },
            { callId: 'call-0', startedAt: null, bytes: 0, text: null, record: null, analysis: null },
          ],
          windowEvents: { events: ['[2026-11-20T10:00:01.000Z] screen in-call', '[2026-11-20T10:00:02.000Z] ERROR console: failed "SECRET QUOTE"'], eventsDropped: 3 },
        }),
      }) });
      const section = markdown.slice(markdown.indexOf('## Practice calls'), markdown.indexOf('## Messages on screen'));
      assert.ok(markdown.indexOf('## Practice calls') > markdown.indexOf('## Data folder'));
      for (const secret of ['SECRET', 'Private Interviewer', 'jobs.hidden.test', '/Users/someone']) assert.ok(!section.includes(secret), `${secret} stays out of the report`);
      for (const needle of [
        '- Debug logs on disk: 2 · 4,096 bytes',
        '### Call 1 (newest): started 2026-11-20T10:00:00.000Z (300s ago)',
        'length 300s · ended candidate · 12 transcript entries (6 the candidate\'s) · 2 interviewer(s) · questions picked 5, asked 4, answered 3 · feedback skipped no · recording kept',
        '- Timings: setupLeadMs 4200',
        '- Review: failed · 0 chapter(s) · feedback no · error: feedback.planned marks card 2 ("…") as not asked',
        'lines by event:',
        '1 unreadable line(s)',
        'setup-timing {"name":"voices","ms":880}',
        'phase {"from":"precheck","phase":"ringing","elapsedMs":0}',
        'session-turn {"kind":"main","message":"‹32 chars›"}',
        'engine {"type":"caption","text":"‹14 chars›","speaker":"A","name":"‹19 chars›"}',
        'user {"action":"chat","text":"‹11 chars›"}',
        'window {"line":"[2026-11-20T10:00:08.000Z] click \\"Hang up\\""}',
        '+8.1s call 3.1s window',
        'ERROR console: failed "…"',
        'warn {"message":"[PracticeCall] session restarted: timeout at <local-path>"}',
        'fail {"code":"precheck-failed","message":"helper exited 1"',
        'analysis-review-reply {"attempt":1,"ms":52000,"outcome":"rejected","error":"feedback.planned has no entry for card 1 (\\"…\\"), which the call asked","keys":["feedback","chapters"]}',
        'analysis-done {"status":"ready","ms":61000,"chapters":4}',
        '### Call 2: started unknown',
        '- Record: none',
        '- The debug log could not be read.',
        '### Call window events (2, 3 older dropped)',
        'screen in-call',
      ]) assert.ok(section.includes(needle), `the practice call section shows ${needle}`);
      assert.ok(section.includes('start {"callId":"‹6 chars›","args":{"nodeId":"‹1 chars›","canonicalJobUrl":"‹26 chars›"},"steering":"‹15 chars›"}'));
      // No call at all, or no practice call service, still writes the section.
      const empty = await buildBugReportMarkdown({ payload: {}, sources: sources({ practiceCalls: () => ({ calls: [] }) }) });
      assert.match(empty, /## Practice calls[\s\S]*- No practice call has a debug log\.[\s\S]*### Call window events \(0\)/u);
    },
  },
  {
    name: 'practice calls: text is shown only under known code keys, and quoted questions are dropped whole',
    async run() {
      const shaped = (event, data) => debugLineForReport(JSON.stringify({ up: 1500, event, data })).text;
      // A cut-off reply of one word is still interviewer speech.
      assert.equal(shaped('engine', { type: 'interrupted', heardText: 'Salesforce.' }), '+1.5s engine {"type":"interrupted","heardText":"‹11 chars›"}');
      assert.equal(shaped('engine', { type: 'pad', open: true, lang: 'python' }), '+1.5s engine {"type":"pad","open":true,"lang":"python"}');
      assert.equal(shaped('x', { tags: ['Google', 'Meta'], map: { 'What is your SECRET?': 1, ok: 2 } }), '+1.5s x {"tags":["‹6 chars›","‹4 chars›"],"map":{"ok":2,"‹other keys›":1}}');
      // A note ending in JSON is shaped field by field, escaped quotes and all.
      const plan = shaped('note', { message: `plan ${JSON.stringify({ ms: 60000, kind: 'panel', unprepared: [{ text: 'Explain "SECRET" in Acme Corp' }] })}` });
      assert.ok(!plan.includes('SECRET') && !plan.includes('Acme'), plan);
      assert.ok(plan.includes('\\"kind\\":\\"panel\\"') && plan.includes('\\"text\\":\\"‹29 chars›\\"'), plan);
      // analyzeCall sets a question in «» so it goes whole, whatever quotes it holds.
      const rejected = shaped('analysis-review-reply', { outcome: 'rejected', error: 'feedback.planned marks card 2 («What does "SECRET" mean») as not asked' });
      assert.ok(rejected.includes('card 2 («…») as not asked') && !rejected.includes('SECRET'), rejected);
      const single = shaped('warn', { message: "review quoted 'SECRET project' wrongly; it's fine" });
      assert.ok(single.includes("quoted '…' wrongly; it's fine"), single);
      const escaped = shaped('warn', { message: 'bad reply: {"q":"a \\"SECRET\\" b"}' });
      assert.ok(!escaped.includes('SECRET'), escaped);
    },
  },
  {
    name: 'practice calls: a long call keeps every important line and the newest routine lines',
    async run() {
      const lines = [];
      for (let index = 0; index < 2000; index += 1) lines.push(JSON.stringify({ up: index, ms: index, event: 'engine', data: { type: 'timing', n: index } }));
      lines.splice(10, 0, JSON.stringify({ up: 10, event: 'warn', data: { message: 'early warning' } }));
      lines.push(JSON.stringify({ up: 3000, event: 'analysis-done', data: { status: 'ready' } }));
      const timeline = callTimeline(lines.join('\n'), 100);
      assert.equal(timeline.lines.length, 100);
      assert.equal(timeline.dropped, 1902);
      assert.ok(timeline.lines.some(text => text.includes('early warning')), 'an early warning survives');
      assert.ok(timeline.lines.at(-1).includes('analysis-done'));
      assert.ok(timeline.lines.at(-2).includes('"n":1999'), 'the newest routine lines are kept');
      assert.deepEqual(timeline.counts, { engine: 2000, warn: 1, 'analysis-done': 1 });
      assert.equal(debugLineForReport('[]'), null);
      assert.equal(debugLineForReport('{"event":"x"}').text, '+? x');
    },
  },
  {
    name: 'practice calls: the call window names a pressed control only from a fixed set of names',
    async run() {
      const control = (label, text = '') => ({ getAttribute: name => (name === 'aria-label' ? label : null), textContent: text });
      assert.equal(callControlName(control('Hang up')), 'Hang up');
      assert.equal(callControlName(control(null, "I'm ready")), "I'm ready");
      assert.equal(callControlName(control('Seek to Tell me about a SECRET project at 01:02')), 'Seek to a moment');
      assert.equal(callControlName(control('Current chapter: SECRET. Show chapters')), 'Show chapters');
      assert.equal(callControlName(control(null, 'SECRET transcript turn')), '(a control)');
      assert.equal(callControlName(control('SECRET')), '(a control)');
    },
  },
  {
    name: 'build: signing settings are read from the electron-builder configuration the build runs with',
    async run() {
      await withTempDir(async (directory) => {
        const { builderConfig } = selectBuildTarget('interview');
        const write = mac => fs.promises.writeFile(path.join(directory, builderConfig), JSON.stringify({ mac }));
        // package.json has no `build` block in this repository; it must not be consulted.
        await fs.promises.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'x' }));
        await write({ forceCodeSigning: true, identity: '  Local Identity ' });
        assert.deepEqual(readConfiguredMacSigningConfig(directory), { identity: 'Local Identity' });
        await write({ identity: 'Local Identity' });
        assert.throws(() => readConfiguredMacSigningConfig(directory), /mac\.forceCodeSigning to be true in electron-builder\.interview\.json/u);
        await write({ forceCodeSigning: true, identity: ' ' });
        assert.throws(() => readConfiguredMacSigningConfig(directory), /mac\.identity in electron-builder\.interview\.json/u);
      });
      // The real configuration passes the same check the launcher's build starts with.
      assert.equal(typeof readConfiguredMacSigningConfig(path.resolve('.')).identity, 'string');
      assert.equal(typeof buildMacApplication, 'function');
    },
  },
];

export default tests;
