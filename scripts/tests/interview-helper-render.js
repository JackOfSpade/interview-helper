import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { withConsoleCollector } from './fixtures/practice-connector/renderHarness.js';
import { withTimeout } from './fixtures/practice-connector/harness.js';

const SNAPSHOT_A = 'a'.repeat(64);
const SNAPSHOT_B = 'b'.repeat(64);

function profile() {
  return {
    identity: { name: 'Ada Example', contacts: [], evidenceSegmentIds: ['segment-0001'] },
    roles: [{ id: 'role-acme', title: 'Product Manager', employer: 'Acme', startDate: '2021', endDate: 'Present', location: 'Toronto', achievementIds: ['achievement-onboarding'], skillIds: [], evidenceSegmentIds: ['segment-0002'] }],
    achievements: [{ id: 'achievement-onboarding', roleId: 'role-acme', claim: 'Improved onboarding conversion with a simpler setup flow.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0003'] }],
    projects: [{ id: 'project-dashboard', roleId: 'role-acme', name: 'Analytics Dashboard', description: 'Built an analytics dashboard for weekly retention reviews.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0004'] }],
    skills: [], education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
  };
}

function snapshot(id = SNAPSHOT_A) {
  return { snapshotId: id, profile: profile() };
}

function sourceNodes(id = SNAPSHOT_A) {
  return [{
    id: 'job-source', type: 'jobhub', position: { x: 0, y: 0 },
    data: { careerSnapshotId: id, resolvedRoles: ['Product Manager'], searchLocation: { city: 'Toronto' } },
  }];
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

function text(window) {
  return window.document.body.textContent;
}

function button(window, label) {
  return [...window.document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
}

function setTextarea(window, textarea, value) {
  textarea.focus();
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  descriptor.set.call(textarea, value);
  textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

function setInput(window, input, value) {
  input.focus();
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor.set.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
}

const BUNDLE_ID = 'b'.repeat(64);
const BUNDLE_DIGEST = 'c'.repeat(64);
const BRIEF_RECORD_ID = 'f'.repeat(64);
const JOB_URL = 'https://jobs.example.test/role';
function publicBundle(artifactId = BUNDLE_ID, digest = BUNDLE_DIGEST) {
  return { bundle: { artifactId, displayName: 'Acme application', applicationArtifactDigest: digest, verification: { status: 'verified' } } };
}
function publicBrief() {
  return {
    version: 1, briefId: 'd'.repeat(64), createdAt: '2026-10-08T00:00:00.000Z',
    inputs: { careerSnapshotId: SNAPSHOT_A, jobUrlSha256: 'e'.repeat(64), applicationArtifactId: BUNDLE_ID, applicationArtifactDigest: BUNDLE_DIGEST },
    role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Owns product outcomes.' },
    roleThemes: ['Customer discovery'], companyFacts: [], recentContext: [], likelyQuestions: ['How do you prioritize?'], questionsToAsk: [],
    applicationPositioning: [{ documentKind: 'resume', point: 'Emphasizes delivery leadership.' }], sources: [], warnings: [],
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

// The panel is the standalone app's view of one interview: `data` in, patches out.
const PROBE_SOURCE = panelPath => `
  import React, { useCallback, useState } from 'react';
  import { InterviewHelperPanel } from ${JSON.stringify(panelPath)};
  import { JobRunStatusSection } from ${JSON.stringify(path.resolve('src/components/ClaudeRunStatus.jsx'))};
  export function InterviewHelperProbe({ initialData, onPersist, nodeId = 'interview-helper', showRunStatus = false }) {
    const [data, setData] = useState(initialData);
    const update = useCallback((patch) => {
      setData(previous => {
        const next = { ...previous, ...patch };
        onPersist?.(patch, next);
        return next;
      });
      return true;
    }, [onPersist]);
    // showRunStatus draws the status cards the app shows beside the panel.
    return <><InterviewHelperPanel id={nodeId} data={data} onPatch={update} appliedJobsFolder="/Applied Jobs" />{showRunStatus && <JobRunStatusSection />}</>;
  }
`;

// React's controlled-input event plugin detects DOM support while its bundled
// module initializes. Build/import this particular probe after JSDOM is live
// so textarea input is exercised through the real React event path.
async function withDomBundledProbe(fn) {
  return withDom(async window => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-helper-render-dom-'));
    const entry = path.join(directory, 'InterviewHelperProbe.jsx');
    const controller = new AbortController();
    let bundle;
    try {
      await fsPromises.writeFile(entry, PROBE_SOURCE(path.resolve('src/interview-app/InterviewHelperPanel.jsx')));
      bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
      return await fn(bundle, window);
    } finally {
      controller.abort();
      await bundle?.dispose();
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });
}

async function mount(bundle, window, { initialData = {}, nodes = [], nodeId = 'interview-helper', onPersist = () => undefined, showRunStatus = false } = {}) {
  const root = bundle.module.createRoot(window.document.getElementById('root'));
  await bundle.module.act(async () => {
    root.render(bundle.module.React.createElement(bundle.module.InterviewHelperProbe, { initialData, nodes, nodeId, onPersist, showRunStatus }));
    await flush();
  });
  return root;
}

function typeInto(window, input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor.set.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}
function keyDown(window, target, key) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
async function settle(bundle, times = 4) {
  for (let index = 0; index < times; index += 1) await bundle.module.act(async () => { await flush(); });
}
const FOLDERS = [
  { token: 'tok-discord', company: 'Discord', location: 'Remote', role: 'Product Manager', label: 'Discord · Product Manager', modifiedAt: '2026-10-08T00:00:00.000Z' },
  { token: 'tok-acme', company: 'Acme', location: 'Toronto', role: 'Engineer', label: 'Acme · Engineer', modifiedAt: '2026-10-01T00:00:00.000Z' },
];
const OTHER_BUNDLE_ID = '9'.repeat(64);
// The dropdown is the only way to change the application: picking another
// folder replaces the current bundle (there is no separate remove control).
const SWITCH_APPLICATION_API = {
  listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
  selectInterviewApplicationFolder: async () => publicBundle(OTHER_BUNDLE_ID, '8'.repeat(64)),
};
async function switchApplication(bundle, window) {
  await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
  await settle(bundle);
  await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
  await settle(bundle);
}
// With an application selected, the list starts with the "None" option.
function firstFolderOption(window) {
  return [...window.document.querySelectorAll('[role="option"]')].find(item => item.textContent !== 'None');
}
const qaCard = (id, scope, question, extra = {}) => ({ id, scope, question, variants: [], headline: `${question} headline`, bullets: [{ stage: 'action', text: `${id} bullet` }], example: `${id} example`, extensions: [], origin: 'catalog', source: null, author: 'generated', status: 'ready', thinEvidence: false, ...extra });
function qaFixture() {
  return {
    foundation: { status: 'partial', cards: [
      qaCard('f1', 'foundation', 'Tell me about yourself.', { variants: ['Walk me through your résumé.'], extensions: [{ id: 'x1', text: 'Mention mentoring' }], practiced: 3 }),
      qaCard('f2', 'foundation', 'What is your biggest weakness?', { headline: '', bullets: [], example: '', status: 'needs-prep' }),
    ] },
    company: { status: 'ready', company: 'Discord', topics: [{ id: 't1', text: 'SQL query tuning', author: 'generated', practiced: 0 }, { id: 't2', text: 'Kubernetes basics', author: 'user', practiced: 2 }], foundationLinks: [{ foundationQuestion: 'Tell me about yourself.', question: 'Walk me through your background', sourceUrl: 'https://glassdoor.example/q1' }], cards: [
      qaCard('c1', 'company', 'How would you grow Nitro?', { origin: 'disclosed', source: { url: 'https://glassdoor.example/q2', date: '2026-09-01', quote: 'They asked how to grow Nitro.' } }),
      qaCard('c2', 'company', 'Why Discord?', { origin: 'research', author: 'user', practiced: 1 }),
    ] },
  };
}
function tabs(window) {
  return [...window.document.querySelectorAll('[role="tab"]')].map(item => item.textContent);
}
function article(window, question) {
  return [...window.document.querySelectorAll('article')].find(item => item.getAttribute('aria-label') === question);
}
function within(root, label) {
  return [...root.querySelectorAll('button')].find(item => item.textContent.trim() === label);
}

function typedReply(kind, extra = {}) {
  return { bundle: { artifactId: BUNDLE_ID, displayName: kind === 'generated' ? 'Acme · Engineer (generated listing)' : 'Acme · Engineer', applicationArtifactDigest: BUNDLE_DIGEST, integritySummary: 'Typed source.', listingSource: kind === 'link' ? 'given' : kind, verification: { status: kind === 'generated' ? 'typed-generated' : 'typed-posting' } }, jobUrl: JOB_URL, kind, notes: kind === 'generated' ? ['No open posting for this role was found, so this listing is generated.'] : [], ...extra };
}
async function mountTyped(bundle, window, resolve, { initialData = {}, updates = [], extra = {} } = {}) {
  window.interviewAppAPI = { resolveInterviewTypedJob: resolve };
  window.electronAPI = {
    loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
    loadInterviewApplicationBundle: async () => publicBundle(),
    listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
    selectInterviewApplicationFolder: async () => ({ ...publicBundle(OTHER_BUNDLE_ID), jobUrl: JOB_URL }),
    ...extra,
  };
  return mount(bundle, window, { nodes: sourceNodes(), initialData, onPersist: patch => updates.push(patch) });
}
const typedBox = window => window.document.querySelector('textarea[aria-label="Job link, or company and role"]');
async function submitTyped(bundle, window, value) {
  await bundle.module.act(async () => { setTextarea(window, typedBox(window), value); await flush(); });
  await bundle.module.act(async () => { button(window, 'Use this job').click(); await flush(); });
  await settle(bundle, 6);
}

const TYPED_JOB_TESTS = [
  {
    name: 'interview helper render: a typed job link or company and role is resolved and adopted like a picked bundle for every kind',
    async run() {
      for (const kind of ['link', 'found', 'generated']) {
        await withDomBundledProbe(async (bundle, window) => {
          const updates = []; const calls = [];
          const root = await mountTyped(bundle, window, async args => { calls.push(args); return typedReply(kind); }, { updates, extra: { loadInterviewApplicationBundle: async () => ({ bundle: typedReply(kind).bundle }) } });
          try {
            await settle(bundle);
            assert(text(window).includes('Or type a job link, or a company and role'), 'the typed job box must be labelled');
            assert(typedBox(window).maxLength === 2000, 'the box must cap the text at 2000 characters');
            assert(button(window, 'Use this job').disabled, 'the button must wait for text');
            assert(window.document.querySelector('[aria-label="Job listing source"]')?.dataset.listingSource === 'none', 'with nothing chosen the indicator says there is no listing yet');
            await submitTyped(bundle, window, 'Engineer at Acme');
            assert(calls.length === 1 && calls[0].nodeId === 'interview-helper' && calls[0].text === 'Engineer at Acme', 'the typed text must be sent with the node id');
            const patch = updates.find(item => item.interviewHelperApplicationBundle);
            assert(patch.interviewHelperApplicationBundle.artifactId === BUNDLE_ID && patch.interviewHelperApplicationBundle.digest === BUNDLE_DIGEST, 'the bundle must persist with the picker projection');
            assert(patch.interviewHelperJobUrl === JOB_URL && patch.interviewHelperPreparation === null, 'the job URL must be adopted and preparation reset');
            assert(patch.interviewHelperTypedJob === 'Engineer at Acme' && patch.interviewHelperTypedJobKind === kind, 'the typed text and kind must be kept on the session');
            const generated = window.document.querySelector('[data-testid="typed-job-generated"]');
            if (kind === 'generated') {
              assert(generated && /AI as a realistic stand-in/u.test(generated.textContent), 'a generated listing must be unmistakable');
              assert(text(window).includes('Acme · Engineer (generated listing)') && text(window).includes('No open posting for this role was found, so this listing is generated.'), 'the label and note must show');
            } else assert(!generated, 'only a generated listing carries the generated warning');
            const source = window.document.querySelector('[aria-label="2. Application"] [aria-label="Job listing source"]');
            const expected = { link: 'Job listing: given', found: 'Job listing: found', generated: 'Job listing: generated' }[kind];
            assert(source?.textContent.startsWith(expected), `the Application section must say the listing is ${expected.slice(13)}`);
          } finally { await bundle.module.act(async () => root.unmount()); }
        });
      }
    },
  },
  {
    name: 'interview helper render: an unclear typed job shows the question, an error shows amber alerts, and the typed text survives both',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = []; let mode = 'unclear';
        const root = await mountTyped(bundle, window, async () => {
          if (mode === 'unclear') throw Object.assign(new Error('x'), { userMessage: 'Which company and which role?' });
          if (mode === 'envelope') return { success: false, error: 'The link could not be read.' };
          return typedReply('found');
        }, { updates });
        try {
          await settle(bundle);
          await submitTyped(bundle, window, 'something vague');
          const alert = [...window.document.querySelectorAll('[role="alert"]')].find(item => item.textContent.includes('Which company and which role?'));
          assert(alert && alert.className.includes('amber'), 'the unclear question must show in an amber alert');
          assert(alert.textContent.includes('This job was not used.'), 'the alert must say the typed job was not used');
          assert(!updates.some(item => item.interviewHelperApplicationBundle), 'a failed resolve must not store a bundle');
          assert(typedBox(window).value === 'something vague' && updates.some(item => item.interviewHelperTypedJob === 'something vague'), 'the typed text must be kept so the user can add detail');
          mode = 'envelope';
          await submitTyped(bundle, window, 'something vague https://x.example.test/a');
          assert(text(window).includes('The link could not be read.'), 'an error envelope must show its message');
          mode = 'ok';
          await bundle.module.act(async () => { button(window, 'Use this job').click(); await flush(); });
          await settle(bundle, 6);
          assert(!text(window).includes('The link could not be read.') && updates.some(item => item.interviewHelperApplicationBundle), 'a retry must clear the error and adopt the job');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: the typed job shows a running state and the status strip entry while it works, and blocks double submission',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const gate = deferred(); const calls = [];
        const root = await mountTyped(bundle, window, args => { calls.push(args); return gate.promise; });
        try {
          await settle(bundle);
          await bundle.module.act(async () => { setTextarea(window, typedBox(window), 'Engineer at Acme'); await flush(); });
          await bundle.module.act(async () => { button(window, 'Use this job').click(); await flush(); });
          assert(button(window, 'Finding the job…')?.disabled && typedBox(window).disabled, 'the button and box must be disabled while running');
          assert(text(window).includes('Starting… This can take a minute.'), 'a running line must show');
          assert(button(window, 'Cancel'), 'a running job can be cancelled');
          assert(/^typed-[A-Za-z0-9_-]{1,58}$/u.test(calls[0].runId), 'each run is named so its activity and Cancel are its own');
          await bundle.module.act(async () => { button(window, 'Finding the job…').click(); await flush(); });
          assert(calls.length === 1, 'a second click must not start another run');
          await bundle.module.act(async () => { gate.resolve(typedReply('link')); await flush(); });
          await settle(bundle, 6);
          assert(button(window, 'Use this job') && !button(window, 'Use this job').disabled, 'the box must unlock when done');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Cancel ends the typed job run, unlocks the box at once and ignores a reply that still arrives',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const gate = deferred(); const calls = []; const cancels = []; const updates = [];
        const root = await mountTyped(bundle, window, args => { calls.push(args); return gate.promise; }, { updates });
        window.interviewAppAPI.cancelInterviewTypedJob = async args => { cancels.push(args); return { success: true, cancelled: true }; };
        try {
          await settle(bundle);
          await bundle.module.act(async () => { setTextarea(window, typedBox(window), 'Engineer at Acme'); await flush(); });
          await bundle.module.act(async () => { button(window, 'Use this job').click(); await flush(); });
          await bundle.module.act(async () => { button(window, 'Cancel').click(); await flush(); });
          assert(cancels.length === 1 && cancels[0].nodeId === 'interview-helper' && cancels[0].runId === calls[0].runId, 'Cancel must name the run in flight');
          assert(button(window, 'Use this job') && !button(window, 'Use this job').disabled && !typedBox(window).disabled && !button(window, 'Cancel'), 'the box must unlock at once');
          assert(typedBox(window).value === 'Engineer at Acme' && !window.document.querySelector('[role="alert"]'), 'the typed text stays and no error shows');
          await bundle.module.act(async () => { gate.resolve(typedReply('link')); await flush(); });
          await settle(bundle, 6);
          assert(!updates.some(item => item.interviewHelperApplicationBundle), 'a reply that arrives after Cancel must not be adopted');
          // The main process answers a cancelled run with cancelled:true: also no error.
          window.interviewAppAPI.resolveInterviewTypedJob = async () => ({ success: true, cancelled: true });
          await bundle.module.act(async () => { button(window, 'Use this job').click(); await flush(); });
          await settle(bundle, 6);
          assert(!window.document.querySelector('[role="alert"]') && !updates.some(item => item.interviewHelperApplicationBundle), 'a cancelled reply is quiet');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: picking a folder bundle after a typed job still works and clears the typed result marks',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        const root = await mountTyped(bundle, window, async () => typedReply('generated'), { updates });
        try {
          await settle(bundle);
          await submitTyped(bundle, window, 'Engineer at Acme');
          assert(window.document.querySelector('[data-testid="typed-job-generated"]'), 'the generated warning must show first');
          const combobox = window.document.querySelector('[role="combobox"]');
          await bundle.module.act(async () => { combobox.click(); await flush(); });
          await settle(bundle);
          await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
          await settle(bundle, 6);
          const patch = [...updates].reverse().find(item => item.interviewHelperApplicationBundle);
          assert(patch.interviewHelperApplicationBundle.artifactId === OTHER_BUNDLE_ID, 'the picked bundle must replace the typed one');
          assert(patch.interviewHelperTypedJobKind === null && patch.interviewHelperTypedJobNotes === null, 'the typed result marks must clear');
          assert(!window.document.querySelector('[data-testid="typed-job-generated"]'), 'the generated warning must go');
          assert(typedBox(window).value === 'Engineer at Acme', 'the typed text itself stays in the box');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a saved typed job text and generated mark are restored when the interview reopens',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const root = await mountTyped(bundle, window, async () => typedReply('link'), { initialData: { interviewHelperTypedJob: 'Engineer at Acme', interviewHelperTypedJobKind: 'generated', interviewHelperTypedJobNotes: ['Generated for Acme.'], interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme · Engineer (generated listing)', digest: BUNDLE_DIGEST } } });
        try {
          await settle(bundle);
          assert(typedBox(window).value === 'Engineer at Acme', 'the typed text must be restored');
          assert(window.document.querySelector('[data-testid="typed-job-generated"]') && text(window).includes('Generated for Acme.'), 'the generated mark and notes must be restored');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
];

const QA_SETUP_TESTS = [
  {
    name: 'interview helper render: application combobox lists, filters and selects a folder by keyboard and adopts the bundle URL',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = []; const listCalls = []; const selectCalls = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          listInterviewApplicationFolders: async args => { listCalls.push(args); return { root: '/Applied Jobs', folders: FOLDERS }; },
          selectInterviewApplicationFolder: async args => { selectCalls.push(args); return { ...publicBundle(), jobUrl: JOB_URL }; },
        };
        const root = await mount(bundle, window, { nodes: sourceNodes(), initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A } }, onPersist: patch => updates.push(patch) });
        try {
          await settle(bundle);
          assert(button(window, 'Prepare interview brief').disabled, 'Prepare must stay disabled until an application is selected');
          assert(window.document.body.textContent.includes('Writes Q&A only for a tab with no cards. A tab that has cards is never changed; delete every card in it to have it written again.'), 'the empty-tabs-only note must appear near Prepare');
          assert(!window.document.querySelector('[aria-label="Original job listing URL"]'), 'the editable job URL field must be gone; the bundle URL is the only source');
          const combobox = window.document.querySelector('[role="combobox"]');
          assert(combobox && combobox.getAttribute('aria-expanded') === 'false', 'the application combobox must start collapsed');
          await bundle.module.act(async () => { combobox.click(); await flush(); });
          await settle(bundle);
          assert(listCalls.length === 1 && listCalls[0].nodeId === 'interview-helper', 'opening must list folders for this node');
          assert(combobox.getAttribute('aria-expanded') === 'true', 'opening must expand the combobox');
          const listbox = window.document.getElementById(combobox.getAttribute('aria-controls'));
          assert(listbox?.getAttribute('role') === 'listbox', 'the combobox must control a listbox');
          assert(listbox.querySelectorAll('[role="option"]').length === 2, 'both folders must be listed');
          await bundle.module.act(async () => { keyDown(window, combobox, 'ArrowUp'); await flush(); });
          assert(combobox.getAttribute('aria-activedescendant') === listbox.querySelectorAll('[role="option"]')[1].id, 'ArrowUp from no selection must activate the last option');
          await bundle.module.act(async () => { typeInto(window, combobox, 'remote'); await flush(); });
          const filtered = [...listbox.querySelectorAll('[role="option"]')];
          assert(filtered.length === 1 && filtered[0].textContent.startsWith('Discord · Product Manager'), 'typing must filter by location');
          await bundle.module.act(async () => { keyDown(window, combobox, 'ArrowDown'); await flush(); });
          assert(combobox.getAttribute('aria-activedescendant') === filtered[0].id && filtered[0].getAttribute('aria-selected') === 'true', 'ArrowDown must activate the first option');
          await bundle.module.act(async () => { keyDown(window, combobox, 'Enter'); await flush(); });
          await settle(bundle, 6);
          assert(selectCalls.length === 1 && selectCalls[0].nodeId === 'interview-helper' && selectCalls[0].token === 'tok-discord', 'Enter must select the folder token');
          const bundlePatch = updates.find(patch => patch.interviewHelperApplicationBundle);
          assert(bundlePatch?.interviewHelperApplicationBundle.artifactId === BUNDLE_ID && bundlePatch.interviewHelperApplicationBundle.digest === BUNDLE_DIGEST, 'the folder bundle must persist like the picker bundle');
          assert(bundlePatch.interviewHelperJobUrl === JOB_URL, 'the bundle job URL must be persisted');
          assert(!window.document.querySelector('[aria-label="Original job listing URL"]'), 'no editable job URL field may remain');
          assert(combobox.getAttribute('aria-expanded') === 'false', 'selection must close the listbox');
          assert(!button(window, 'Prepare interview brief').disabled, 'Prepare must enable once career data and application are ready');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: application combobox overwrites a saved URL, closes on Escape and shows empty states',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = []; let reply = { root: null, folders: [], reason: 'canvas-unsaved' };
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          listInterviewApplicationFolders: async () => reply,
          selectInterviewApplicationFolder: async () => ({ ...publicBundle(), jobUrl: 'https://jobs.example.test/other' }),
        };
        const existing = 'https://jobs.example.test/existing';
        const root = await mount(bundle, window, { nodes: sourceNodes(), initialData: { interviewHelperJobUrl: existing }, onPersist: patch => updates.push(patch) });
        try {
          await settle(bundle);
          const combobox = window.document.querySelector('[role="combobox"]');
          await bundle.module.act(async () => { combobox.click(); await flush(); });
          await settle(bundle);
          const status = () => [...window.document.querySelectorAll('[role="status"]')].map(item => item.textContent);
          assert(status().includes('Save your canvas to list applications'), 'an unsaved canvas must explain how to list applications');
          await bundle.module.act(async () => { keyDown(window, combobox, 'Escape'); await flush(); });
          assert(combobox.getAttribute('aria-expanded') === 'false', 'Escape must close the listbox');
          reply = { root: '/Applied Jobs', folders: [] };
          await bundle.module.act(async () => { combobox.click(); await flush(); });
          await settle(bundle);
          assert(status().includes('No application folders found under Applied Jobs.'), 'an empty root must show the no-folders state');
          reply = { root: '/Applied Jobs', folders: FOLDERS };
          await bundle.module.act(async () => { keyDown(window, combobox, 'Escape'); await flush(); });
          await bundle.module.act(async () => { combobox.click(); await flush(); });
          await settle(bundle);
          const option = [...window.document.querySelectorAll('[role="option"]')].find(item => item.textContent.startsWith('Acme · Engineer'));
          await bundle.module.act(async () => { option.click(); await flush(); });
          await settle(bundle, 6);
          const bundlePatch = updates.find(patch => patch.interviewHelperApplicationBundle);
          assert(bundlePatch?.interviewHelperJobUrl === 'https://jobs.example.test/other', 'selecting a bundle must overwrite a previously saved job URL with the bundle job URL');
          assert(!window.document.querySelector('[aria-label="Original job listing URL"]'), 'no editable job URL field may remain');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Q&A reloads after Prepare completes',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred(); const loads = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => pending.promise,
          completeNonApiAiRun: async () => ({ absent: true }),
          loadInterviewQa: async args => { loads.push(args); return qaFixture(); },
        };
        const root = await mount(bundle, window, { nodes: sourceNodes(), initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } } });
        try {
          await settle(bundle);
          assert(loads.length >= 1 && loads.every(call => call.nodeId === 'interview-helper'), 'Q&A must load for this node on mount');
          assert(loads.at(-1).snapshotId === SNAPSHOT_A, 'Q&A must load with the active career snapshot');
          const prepareButton = button(window, 'Prepare interview brief');
          assert(prepareButton && !prepareButton.disabled, 'Prepare must be enabled with career data, URL and application ready');
          await bundle.module.act(async () => { prepareButton.click(); await flush(); });
          await settle(bundle);
          const beforeResolve = loads.length;
          await bundle.module.act(async () => { pending.resolve({ brief: publicBrief(), briefRecordId: BRIEF_RECORD_ID }); await flush(); });
          await settle(bundle, 6);
          assert(loads.length > beforeResolve, `Q&A must reload after Prepare completes (before ${beforeResolve}, after ${loads.length})`);
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Q&A panel shows tabs, badges and links and edits/adds/deletes through the contract APIs',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const saves = []; const adds = []; const deletes = []; let failNextSave = true;
        const fixture = qaFixture();
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewQa: async () => qaFixture(),
          saveInterviewQaCard: async args => {
            saves.push(args);
            if (failNextSave) { failNextSave = false; throw new Error('Disk full'); }
            return { status: 'ready', cards: [{ ...args.card, author: 'user' }, fixture.foundation.cards[1]] };
          },
          addInterviewQaCard: async args => { adds.push(args); return { status: 'ready', cards: [...fixture.company.cards, { ...args.card, id: 'c3', author: 'user', origin: 'user' }] }; },
          deleteInterviewQaCard: async args => { deletes.push(args); return { status: 'ready', cards: [fixture.company.cards[1]] }; },
        };
        const root = await mount(bundle, window, { nodes: sourceNodes() });
        try {
          await settle(bundle);
          const panel = window.document.querySelector('[data-testid="interview-qa-panel"]');
          assert(panel && !window.document.querySelector('[role="dialog"]') && !button(window, 'Edit Q&A'), 'the Q&A is an always-visible panel with no Edit Q&A button or dialog');
          assert(tabs(window).join('|') === 'General 2|Discord 2|Technical topics 2', `the tabs must count each set, got ${tabs(window).join('|')}`);
          const headings = [...panel.querySelectorAll('h3')].map(item => item.textContent);
          assert(headings.includes('General Q&A · shared across all interviews') && !headings.some(item => /Foundation/u.test(item)), `the shared set is worded General, got ${headings.join(' | ')}`);
          const f1 = article(window, 'Tell me about yourself.');
          assert(!f1.querySelector('.qa-origin') && !f1.querySelector('p.whitespace-pre-wrap'), 'a card starts collapsed to its question row');
          await bundle.module.act(async () => { f1.querySelector('button[aria-expanded]').click(); await flush(); });
          assert(f1.querySelector('.qa-origin').textContent === 'Generated', 'cards the writer made show the Generated badge once expanded (their questions are no longer a standard list)');
          const linkItem = [...f1.querySelectorAll('li')].find(item => item.textContent.startsWith('Also asked at'));
          assert(linkItem?.textContent === 'Also asked at Discord: “Walk me through your background” — source' && linkItem.querySelector('a').getAttribute('href') === 'https://glassdoor.example/q1', 'General links must appear under the matching General card');
          const f2 = article(window, 'What is your biggest weakness?');
          await bundle.module.act(async () => { f2.querySelector('button[aria-expanded]').click(); await flush(); });
          assert(f2.querySelector('.qa-needs-prep')?.textContent === 'Needs prep', 'needs-prep cards must be marked');
          assert(!f1.querySelector('.qa-needs-prep'), 'ready cards must not be marked as needing prep');

          await bundle.module.act(async () => { within(f1, 'Edit').click(); await flush(); });
          const form = article(window, 'Tell me about yourself.').querySelector('form');
          assert(form.querySelector('p').textContent === 'General edits apply to every interview.', 'General edits must warn they apply everywhere');
          const headline = [...form.querySelectorAll('label')].find(item => item.textContent.startsWith('Headline')).querySelector('textarea');
          await bundle.module.act(async () => { setTextarea(window, headline, 'My new headline'); await flush(); });
          await bundle.module.act(async () => { within(form, 'Save').click(); await flush(); });
          await settle(bundle);
          assert(saves.length === 1 && saves[0].nodeId === 'interview-helper' && saves[0].scope === 'foundation' && saves[0].card.id === 'f1' && saves[0].card.headline === 'My new headline', 'Save must call saveInterviewQaCard with the edited card');
          assert(form.isConnected && form.querySelector('[role="alert"]')?.textContent === 'Disk full', 'a rejected save must show the error inline');
          assert(headline.value === 'My new headline', 'a rejected save must keep the unsaved text');
          await bundle.module.act(async () => { within(form, 'Save').click(); await flush(); });
          await settle(bundle);
          const saved = article(window, 'Tell me about yourself.');
          assert(!saved.querySelector('form') && saved.querySelector('p.whitespace-pre-wrap')?.textContent === 'My new headline', 'a successful save must render the returned section');
          assert(saved.querySelector('.qa-edited')?.textContent === 'Edited by you', 'the returned user author must be shown');
          assert(saved.querySelector('[data-practised]').getAttribute('data-practised') === '3', 'an edit keeps the practised count already shown');

          await bundle.module.act(async () => { window.document.querySelector('[role="tab"]:nth-child(2)').click(); await flush(); });
          const companySection = [...panel.querySelectorAll('section')].find(item => item.getAttribute('aria-label') === 'Discord Q&A · this company and posting');
          assert(companySection, 'the company tab shows its own section');
          await bundle.module.act(async () => { within(companySection, 'Add card').click(); await flush(); });
          const addForm = companySection.querySelector('form[aria-label="Add company card"]');
          await bundle.module.act(async () => { setInput(window, addForm.querySelector('input'), 'What would you change about Discord?'); await flush(); });
          await bundle.module.act(async () => { within(addForm, 'Save').click(); await flush(); });
          await settle(bundle);
          assert(adds.length === 1 && adds[0].scope === 'company' && adds[0].nodeId === 'interview-helper' && adds[0].card.question === 'What would you change about Discord?' && !adds[0].card.id, 'Add must call addInterviewQaCard without an id');
          assert(article(window, 'What would you change about Discord?'), 'the added card must render from the returned section');

          const c1 = article(window, 'How would you grow Nitro?');
          await bundle.module.act(async () => { c1.querySelector('button[aria-expanded]').click(); await flush(); });
          const disclosed = c1.querySelector('a.qa-origin');
          assert(disclosed?.textContent === 'Disclosed' && disclosed.getAttribute('href') === 'https://glassdoor.example/q2', 'disclosed cards must link to their source');
          const sourceDetails = c1.querySelector('details'); 
          assert(sourceDetails && c1.querySelector('blockquote')?.textContent === 'They asked how to grow Nitro.', 'the disclosed quote must be available on expand');
          assert(article(window, 'Why Discord?').querySelector('[data-practised]').getAttribute('data-practised') === '1', 'company cards show their own count');
          await bundle.module.act(async () => { within(c1, 'Delete').click(); await flush(); });
          assert(deletes.length === 0, 'Delete must ask for confirmation first');
          await bundle.module.act(async () => { within(article(window, 'How would you grow Nitro?'), 'Confirm delete').click(); await flush(); });
          await settle(bundle);
          assert(deletes.length === 1 && deletes[0].scope === 'company' && deletes[0].cardId === 'c1' && deletes[0].nodeId === 'interview-helper', 'Confirm must call deleteInterviewQaCard with the card id');
          assert(!article(window, 'How would you grow Nitro?') && article(window, 'Why Discord?'), 'the returned section must replace the company cards');
          assert(tabs(window)[1] === 'Discord 1', `the tab count follows the returned section, got ${tabs(window)[1]}`);
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Q&A tabs switch, show the practised badge from the load reply and expand a card',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewQa: async () => qaFixture() };
        const root = await mount(bundle, window, { nodes: sourceNodes() });
        try {
          await settle(bundle);
          const tabEls = () => [...window.document.querySelectorAll('[role="tab"]')];
          assert(tabEls().length === 3 && tabEls()[0].getAttribute('aria-selected') === 'true' && tabEls()[1].getAttribute('aria-selected') === 'false', 'the General tab is selected first');
          const row = question => article(window, question).querySelector('button[aria-expanded]');
          assert(row('Tell me about yourself.').getAttribute('aria-expanded') === 'false', 'cards start collapsed');
          assert(row('Tell me about yourself.').textContent === 'Tell me about yourself.Practised ×3', `the row shows the question and the practised badge, got ${row('Tell me about yourself.').textContent}`);
          assert(article(window, 'Tell me about yourself.').querySelector('[data-practised]').getAttribute('data-practised') === '3', 'the badge carries the practiced number from the load reply');
          assert(article(window, 'What is your biggest weakness?').querySelector('[data-practised]').getAttribute('data-practised') === '0' && article(window, 'What is your biggest weakness?').textContent.includes('Practised ×0'), 'an unasked question shows zero');
          assert(!article(window, 'How would you grow Nitro?'), 'company cards are on the other tab');
          await bundle.module.act(async () => { row('Tell me about yourself.').click(); await flush(); });
          assert(row('Tell me about yourself.').getAttribute('aria-expanded') === 'true' && within(article(window, 'Tell me about yourself.'), 'Edit') && within(article(window, 'Tell me about yourself.'), 'Delete'), 'clicking a row expands it to its details with Edit and Delete');
          assert(article(window, 'Tell me about yourself.').textContent.includes('Tell me about yourself. headline'), 'the expanded card shows its answer');
          await bundle.module.act(async () => { row('Tell me about yourself.').click(); await flush(); });
          assert(!within(article(window, 'Tell me about yourself.'), 'Edit'), 'clicking again collapses it');
          await bundle.module.act(async () => { tabEls()[1].click(); await flush(); });
          assert(tabEls()[1].getAttribute('aria-selected') === 'true' && article(window, 'How would you grow Nitro?') && !article(window, 'Tell me about yourself.'), 'the company tab lists the company cards only');
          await bundle.module.act(async () => { tabEls()[2].click(); await flush(); });
          assert(tabEls()[2].getAttribute('aria-selected') === 'true' && !window.document.querySelector('article'), 'the topics tab has no cards');
          const items = [...window.document.querySelectorAll('section[aria-label="Technical topics"] li')];
          assert(items.map(item => item.textContent.replace(/Delete$/u, '')).join('|') === 'SQL query tuningPractised ×0|Kubernetes basics· added by youPractised ×2', `topics list with their badges, got ${items.map(item => item.textContent).join('|')}`);
          assert(!window.document.body.textContent.includes('Test which card a question matches') || !window.document.querySelector('details > summary')?.textContent.includes('Test which card'), 'the match tester is hidden on the topics tab');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: topics are added and deleted through the topic APIs and the list follows the reply',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const adds = []; const deletes = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewQa: async () => qaFixture(),
          addInterviewQaTopic: async args => { adds.push(args); if (args.text === 'bad') return { success: false, error: 'That topic is not allowed.' }; return { topics: [...qaFixture().company.topics, { id: 't3', text: args.text, author: 'user', practiced: 0 }] }; },
          deleteInterviewQaTopic: async args => { deletes.push(args); return { topics: qaFixture().company.topics.filter(topic => topic.id !== args.topicId) }; },
        };
        const root = await mount(bundle, window, { nodes: sourceNodes() });
        try {
          await settle(bundle);
          await bundle.module.act(async () => { window.document.querySelectorAll('[role="tab"]')[2].click(); await flush(); });
          const form = () => window.document.querySelector('section[aria-label="Technical topics"] form');
          const add = form().querySelector('button[type="submit"]');
          assert(add.disabled, 'Add stays off until a topic is typed');
          await bundle.module.act(async () => { setInput(window, form().querySelector('input'), 'bad'); await flush(); });
          await bundle.module.act(async () => { form().querySelector('button[type="submit"]').click(); await flush(); });
          await settle(bundle);
          assert(adds.length === 1 && adds[0].nodeId === 'interview-helper' && adds[0].text === 'bad', 'the topic goes to addInterviewQaTopic with the node id');
          assert(window.document.querySelector('section[aria-label="Technical topics"] [role="alert"]')?.textContent === 'That topic is not allowed.', 'a refused topic shows the reason');
          await bundle.module.act(async () => { setInput(window, form().querySelector('input'), '  Terraform modules '); await flush(); });
          await bundle.module.act(async () => { form().querySelector('button[type="submit"]').click(); await flush(); });
          await settle(bundle);
          assert(adds.at(-1).text === 'Terraform modules', 'the topic is trimmed');
          assert(tabs(window)[2] === 'Technical topics 3' && window.document.body.textContent.includes('Terraform modules'), 'the new topic is listed and counted from the reply');
          assert(form().querySelector('input').value === '', 'the box is cleared after a successful add');
          await bundle.module.act(async () => { window.document.querySelector('button[aria-label="Delete topic SQL query tuning"]').click(); await flush(); });
          await settle(bundle);
          assert(deletes.length === 1 && deletes[0].nodeId === 'interview-helper' && deletes[0].topicId === 't1', 'Delete calls deleteInterviewQaTopic with the topic id');
          assert(!window.document.body.textContent.includes('SQL query tuning') && tabs(window)[2] === 'Technical topics 1', 'the deleted topic is gone');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Clear all asks in a popup before it empties a tab, and each tab has its own',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const clears = []; let failNext = true;
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewQa: async () => qaFixture(),
          clearInterviewQaCards: async args => { clears.push(['cards', args]); if (failNext) { failNext = false; return { success: false, error: 'Disk full.' }; } return { status: 'missing', cards: [] }; },
          clearInterviewQaTopics: async args => { clears.push(['topics', args]); return { topics: [] }; },
        };
        const root = await mount(bundle, window, { nodes: sourceNodes() });
        try {
          await settle(bundle);
          const panel = window.document.querySelector('[data-testid="interview-qa-panel"]');
          const popup = () => window.document.querySelector('[role="alertdialog"]');
          const tabEls = () => [...window.document.querySelectorAll('[role="tab"]')];
          await bundle.module.act(async () => { within(panel, 'Clear all').click(); await flush(); });
          assert(clears.length === 0 && popup()?.getAttribute('aria-label') === 'Clear all General Q&A', 'Clear all opens a popup and deletes nothing yet');
          assert(popup().textContent.includes('all 2 items') && popup().textContent.includes('every interview'), `the popup says what is lost, got ${popup().textContent}`);
          await bundle.module.act(async () => { within(popup(), 'Cancel').click(); await flush(); });
          assert(!popup() && clears.length === 0 && article(window, 'Tell me about yourself.'), 'Cancel closes the popup and keeps the cards');
          await bundle.module.act(async () => { within(panel, 'Clear all').click(); await flush(); });
          await bundle.module.act(async () => { within(popup(), 'Clear all').click(); await flush(); });
          await settle(bundle);
          assert(clears.length === 1 && popup()?.querySelector('[role="alert"]')?.textContent === 'Disk full.' && article(window, 'Tell me about yourself.'), 'a failed clear stays open with the reason and keeps the cards');
          await bundle.module.act(async () => { within(popup(), 'Clear all').click(); await flush(); });
          await settle(bundle);
          assert(JSON.stringify(clears[1]) === JSON.stringify(['cards', { nodeId: 'interview-helper', scope: 'foundation' }]), 'clear call 1 carries only its reviewed fields');
          assert(!popup() && !window.document.querySelector('article') && tabs(window).join('|') === 'General 0|Discord 2|Technical topics 2', `only General is emptied, got ${tabs(window).join('|')}`);
          assert(within(panel, 'Clear all').disabled, 'Clear all is off for an empty tab');
          await bundle.module.act(async () => { tabEls()[1].click(); await flush(); });
          await bundle.module.act(async () => { within(panel, 'Clear all').click(); await flush(); });
          assert(popup().getAttribute('aria-label') === 'Clear all Discord Q&A', 'the posting tab names its own set');
          await bundle.module.act(async () => { within(popup(), 'Clear all').click(); await flush(); });
          await settle(bundle);
          assert(JSON.stringify(clears[2]) === JSON.stringify(['cards', { nodeId: 'interview-helper', scope: 'company' }]), 'clear call 2 carries only its reviewed fields');
          assert(tabs(window).join('|') === 'General 0|Discord 0|Technical topics 2', 'clearing the posting cards keeps its topics');
          await bundle.module.act(async () => { tabEls()[2].click(); await flush(); });
          await bundle.module.act(async () => { within(panel, 'Clear all').click(); await flush(); });
          assert(popup().getAttribute('aria-label') === 'Clear all technical topics' && popup().textContent.includes('by hand'), 'the topics popup says they are not listed again');
          await bundle.module.act(async () => { within(popup(), 'Clear all').click(); await flush(); });
          await settle(bundle);
          assert(JSON.stringify(clears[3]) === JSON.stringify(['topics', { nodeId: 'interview-helper' }]), 'clear call 3 carries only its reviewed fields');
          assert(!popup() && tabs(window)[2] === 'Technical topics 0', 'the topics are gone');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Q&A loads with the job URL and bundle artifact id once an application is chosen',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const loads = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewQa: async args => { loads.push(args); return qaFixture(); },
        };
        const root = await mount(bundle, window, { nodes: sourceNodes(), initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } } });
        try {
          await settle(bundle);
          const last = loads.at(-1);
          assert(last.nodeId === 'interview-helper' && last.snapshotId === SNAPSHOT_A && last.jobUrl === JOB_URL && last.bundleArtifactId === BUNDLE_ID, `loadInterviewQa must receive the posting keys, got ${JSON.stringify(last)}`);
        } finally { await bundle.module.act(async () => root.unmount()); }
        const bare = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: null }), loadInterviewQa: async args => { bare.push(args); return qaFixture(); } };
        const second = await mount(bundle, window, { nodes: sourceNodes() });
        try {
          // The first load is scheduled after mount; wait for it rather than assume one settle is enough.
          for (let attempt = 0; attempt < 50 && !bare.length; attempt += 1) { await settle(bundle); await new Promise(resolve => setTimeout(resolve, 10)); }
          assert(bare.length >= 1 && bare.at(-1).jobUrl === null && bare.at(-1).bundleArtifactId === null, `with no application the keys are null, got ${JSON.stringify(bare.at(-1))}`);
        } finally { await bundle.module.act(async () => second.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a first Prepare asks to reuse a saved preparation, Prepare again does not, and a reused reply shows a notice',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const calls = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async args => { calls.push(args); return { brief: publicBrief(), briefRecordId: BRIEF_RECORD_ID, reused: calls.length === 1 }; },
          completeNonApiAiRun: async () => ({ absent: true }), loadInterviewQa: async () => qaFixture(),
          loadInterviewPreparedBrief: async () => ({ brief: publicBrief(), answerBankAvailable: true, answerCardCount: 12 }),
        };
        const root = await mount(bundle, window, { nodes: sourceNodes(), initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } } });
        try {
          await settle(bundle);
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          await settle(bundle, 6);
          assert(calls.length === 1 && calls[0].reuseExisting === true, `a first Prepare passes reuseExisting: true, got ${JSON.stringify(calls[0])}`);
          assert(text(window).includes('Used the preparation already saved for this posting.'), 'a reused reply explains itself');
          await bundle.module.act(async () => { button(window, 'Prepare again').click(); await flush(); });
          await settle(bundle, 6);
          assert(calls.length === 2 && calls[1].reuseExisting === false, `Prepare again passes reuseExisting: false, got ${JSON.stringify(calls[1])}`);
          assert(!text(window).includes('Used the preparation already saved'), 'the notice goes away after a fresh Prepare');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
];

export default [
  {
    name: 'interview helper render: no Job Search career source UI remains and legacy job-search data loads nothing',
    async run() {
      await withDomBundledProbe(async (bundle, window) => withConsoleCollector(async entries => {
        const loads = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async args => { loads.push(args); return { snapshot: null }; } };
        const root = await mount(bundle, window, { nodes: sourceNodes(), initialData: { interviewHelperCareerMode: 'job-search', interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A } });
        try {
          const body = window.document.body.textContent;
          assert(!body.includes('Job Search'), `the Job Search career source must be gone from the node, got ${body}`);
          assert(!window.document.querySelector('[aria-label="Career source for Interview Helper"]'), 'no Job Search snapshot selector may remain');
          assert(!body.includes('Use latest Job Search snapshot'), 'no Job Search refresh action may remain');
          assert(!window.document.querySelector('[aria-label="Paste or type the interviewer question"]'), 'node must not offer retrieval without imported career files');
          assert(loads.length === 0, `legacy job-search data must not load any career snapshot, got ${JSON.stringify(loads)}`);
          assert(entries.length === 0, 'empty state must render silently');
        } finally {
          await bundle.module.act(async () => root.unmount());
        }
      }));
    },
  },
  {
    name: 'interview helper render: setup uses opaque bundle metadata, distinguishes cancellation, and fails closed without reload IPC',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        let selectReply = { cancelled: true };
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
          selectInterviewApplicationFolder: async () => { if (selectReply instanceof Error) throw selectReply; return selectReply; },
          loadInterviewApplicationBundle: async () => publicBundle(),
        };
        const root = await mount(bundle, window, { nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          const choose = async () => {
            const combobox = window.document.querySelector('[role="combobox"]');
            await bundle.module.act(async () => { combobox.click(); await flush(); });
            await settle(bundle);
            const option = firstFolderOption(window);
            await bundle.module.act(async () => { option.click(); await flush(); });
            await settle(bundle, 6);
          };
          await choose();
          assert(!text(window).includes('could not be read'), 'picker cancellation must remain quiet');
          selectReply = publicBundle();
          await choose();
          const bundlePatch = updates.find(item => item.patch.interviewHelperApplicationBundle);
          assert(bundlePatch?.patch.interviewHelperApplicationBundle?.artifactId === BUNDLE_ID, 'the picker must persist the opaque artifact id');
          assert(!JSON.stringify(bundlePatch.patch).includes('listingText') && !JSON.stringify(bundlePatch.patch).includes('Application.html'), 'bundle projection must never persist source text or paths');
          selectReply = new Error('read failed');
          await choose();
          assert(text(window).includes('read failed'), 'a folder read failure must be visible and recoverable');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
      await withDomBundledProbe(async (bundle, window) => {
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
        const root = await mount(bundle, window, { initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('cannot be checked in this app version'), 'a persisted bundle must fail closed if reload IPC is unavailable');
          assert(button(window, 'Prepare interview brief').disabled, 'preparation must remain disabled without authoritative bundle reload');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: native career drop resolves via preload path API and persists only receipt metadata',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = []; let parseArgs; const pendingParse = deferred();
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          parseCareerData: async args => { parseArgs = args; return pendingParse.promise; },
          listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
          selectInterviewApplicationFolder: async () => publicBundle(),
          completeNonApiAiRun: async () => ({ cleared: true }),
        };
        const root = await mount(bundle, window, { onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          const target = window.document.querySelector('[data-career-drop]');
          const event = new window.Event('drop', { bubbles: true });
          Object.defineProperty(event, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          let bubbledToCanvas = false;
          const canvasDropListener = () => { bubbledToCanvas = true; };
          window.document.body.addEventListener('drop', canvasDropListener);
          await bundle.module.act(async () => { target.dispatchEvent(event); await flush(); });
          window.document.body.removeEventListener('drop', canvasDropListener);
          assert(parseArgs?.filePaths?.[0] === '/private/candidate/career.md', 'native drop must use getPathForFile through filesToDropPayloads');
          assert(!bubbledToCanvas, 'career-file drops must not bubble to the canvas document-drop handler');
          // A separate bundle picker must not cancel an in-flight career
          // compilation merely because both actions update setup state.
          await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
          await settle(bundle);
          await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); pendingParse.resolve({ success: true, careerSnapshotId: SNAPSHOT_A, fingerprint: 'fingerprint', profile: { identity: { name: 'Private Candidate' } }, careerData: 'raw private source' }); await flush(); });
          const persisted = JSON.stringify(updates.map(item => item.patch));
          assert(!persisted.includes('/private/candidate/career.md') && !persisted.includes('Private Candidate') && !persisted.includes('raw private source'), 'career import persistence must contain no path, profile, or raw source');
          assert(updates.some(item => item.patch.interviewHelperCareerFilenames?.[0] === 'career.md'), 'only a safe filename may be retained');
          assert(updates.some(item => item.patch.interviewHelperCareerCompilation?.status === 'approved'), 'an unrelated bundle picker must not discard the valid career compilation result');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: direct import clears a legacy Job Search pin and stays removable',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          parseCareerData: async () => ({ success: true, careerSnapshotId: SNAPSHOT_B, fingerprint: 'independent-career' }),
          completeNonApiAiRun: async () => ({ cleared: true }),
          loadInterviewHelperCareerSnapshot: async ({ snapshotId: requested }) => ({ snapshot: snapshot(requested) }),
          loadInterviewApplicationBundle: async () => publicBundle(),
        };
        const root = await mount(bundle, window, {
          initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          const target = window.document.querySelector('[data-career-drop]');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          const importing = updates.find(item => item.patch.interviewHelperCareerMode === 'import');
          assert(importing?.patch.interviewHelperSourceNodeId === null && importing.patch.interviewHelperSourceSnapshotId === null, 'starting an independent import must clear the old Job Search source pin');
          assert(!window.document.querySelector('[aria-label="Career source for Interview Helper"]'), 'the Job Search selector must be gone');
          assert(window.document.querySelector('[aria-label="Clear imported career source"]'), 'an approved direct import must provide an explicit accessible removal action');
          await bundle.module.act(async () => { window.document.querySelector('[aria-label="Clear imported career source"]').click(); await flush(); });
          assert(updates.some(item => item.patch.interviewHelperCareerMode === 'none'
            && item.patch.interviewHelperCareerCompilation === null
            && item.patch.interviewHelperCareerSnapshotId === null
            && item.patch.interviewHelperPreparation === null
            && item.patch.interviewHelperJobUrl === undefined
            && item.patch.interviewHelperApplicationBundle === undefined),
          'clearing an imported source must remove only import/dependent state while preserving URL and bundle setup');
          assert(!updates.some(item => item.patch.interviewHelperCareerMode === 'job-search'), 'an import must never switch the helper back to a Job Search source');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: unsafe career filenames fail before parse IPC',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        let parseCalls = 0;
        window.electronAPI = {
          getPathForFile: file => `/private/candidate/${file.name}`,
          parseCareerData: async () => { parseCalls += 1; return { success: true, careerSnapshotId: SNAPSHOT_A, fingerprint: 'unused' }; },
        };
        const root = await mount(bundle, window);
        try {
          const target = window.document.querySelector('[data-career-drop]');
          for (const name of ['bad\u0001.md', 'bad\u007f.md', 'bad\u0085.md', 'bad\u202e.md']) {
            const drop = new window.Event('drop', { bubbles: true });
            Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name }] } });
            await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
            assert(text(window).includes('safe visible filename'), `unsafe filename ${JSON.stringify(name)} must produce a visible input error`);
          }
          assert(parseCalls === 0, 'a selection containing C0, DEL, C1, or Unicode format characters must not reach parse IPC');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: any-type career drop converts first, lists each file and compiles only the converted ones',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const scenarios = [
          { label: 'mixed', names: ['cv.pdf', 'notes.md', 'photo.png'], reply: [{ status: 'converted', filePath: '/conv/cv.pdf.txt', convertedName: 'cv.pdf.txt', method: 'pdf-text-layer', machineExtracted: true, reason: 'This PDF was extracted by machine.', token: 't1' }, { status: 'passthrough', filePath: '/priv/notes.md', convertedName: 'notes.md' }, { status: 'converted', filePath: '/conv/photo.png.txt', convertedName: 'photo.png.txt', method: 'ai', token: 't3' }], paths: ['/conv/cv.pdf.txt', '/priv/notes.md', '/conv/photo.png.txt'], note: 'This PDF was extracted by machine.' },
          { label: 'one refusal', names: ['cv.pdf', 'locked.pdf'], reply: [{ status: 'converted', filePath: '/conv/cv.pdf.txt', method: 'ai', token: 't1' }, { status: 'refused', reason: 'it is encrypted' }], paths: ['/conv/cv.pdf.txt'], note: 'not converted: it is encrypted' },
          { label: 'all refused', names: ['a.bin', 'b.bin'], reply: [{ status: 'refused', reason: 'unreadable' }, { status: 'refused', reason: 'too large' }], paths: null, note: 'nothing was imported' },
        ];
        for (const scenario of scenarios) {
          let parseArgs = null; let convertArgs = null; const opened = [];
          window.interviewAppAPI = {
            convertCareerFiles: async args => { convertArgs = args; return { success: true, files: scenario.reply.map((r, i) => ({ name: scenario.names[i], ...r })) }; },
            revealConvertedCareerFile: async args => { opened.push(args); return { ok: true }; },
          };
          window.electronAPI = {
            getPathForFile: file => `/orig/${file.name}`,
            parseCareerData: async args => { parseArgs = args; return { success: false, error: 'stop' }; },
          };
          const updates = [];
          const root = await mount(bundle, window, { onPersist: (patch, next) => updates.push({ patch, next }) });
          try {
            const drop = new window.Event('drop', { bubbles: true });
            Object.defineProperty(drop, 'dataTransfer', { value: { files: scenario.names.map(name => ({ name })) } });
            await bundle.module.act(async () => { window.document.querySelector('[data-career-drop]').dispatchEvent(drop); await flush(); await flush(); });
            assert(convertArgs?.nodeId && convertArgs.filePaths.length === scenario.names.length && convertArgs.filePaths[0] === `/orig/${scenario.names[0]}`, `${scenario.label}: conversion must get the dropped paths in order`);
            assert(text(window).includes(scenario.note), `${scenario.label}: the panel must list each file's outcome`);
            if (scenario.paths) {
              assert(JSON.stringify(parseArgs?.filePaths) === JSON.stringify(scenario.paths), `${scenario.label}: compile must get converted and pass-through paths in dropped order`);
              assert(updates.some(item => JSON.stringify(item.patch.interviewHelperCareerFilenames) === JSON.stringify(scenario.paths.map(path => path.split('/').pop()))), `${scenario.label}: saved filenames must be the converted names`);
              const button = window.document.querySelector('button[aria-label^="Open converted text"]');
              await bundle.module.act(async () => { button.click(); await flush(); });
              assert(opened.length === 1 && opened[0].token && Object.keys(opened[0]).length === 1, `${scenario.label}: Open text must pass the token`);
            } else {
              assert(parseArgs === null, 'nothing may compile when no file converted');
            }
          } finally { await bundle.module.act(async () => root.unmount()); }
        }
      });
    },
  },
  {
    name: 'interview helper render: a text-only drop skips conversion and a re-drop of the same originals reuses the converted names',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        let convertCalls = 0; let parseArgs = null;
        window.interviewAppAPI = { convertCareerFiles: async () => { convertCalls += 1; return { success: true, files: [{ name: 'cv.pdf', status: 'converted', filePath: '/conv/cv.pdf.txt', convertedName: 'cv.pdf.txt', method: 'ai', token: 't' }] }; } };
        window.electronAPI = { getPathForFile: file => `/orig/${file.name}`, parseCareerData: async args => { parseArgs = args; return { success: false, error: 'stop' }; } };
        const updates = [];
        const root = await mount(bundle, window, { onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          const dropFiles = async names => {
            const drop = new window.Event('drop', { bubbles: true });
            Object.defineProperty(drop, 'dataTransfer', { value: { files: names.map(name => ({ name })) } });
            await bundle.module.act(async () => { window.document.querySelector('[data-career-drop]').dispatchEvent(drop); await flush(); await flush(); });
          };
          await dropFiles(['cv.pdf']);
          assert(convertCalls === 1 && updates.some(item => item.patch.interviewHelperCareerFilenames?.[0] === 'cv.pdf.txt'), 'a PDF drop must convert once and save the converted name');
          assert(JSON.stringify(parseArgs?.filePaths) === JSON.stringify(['/conv/cv.pdf.txt']), 'compile must read the converted path');
          parseArgs = null;
          await dropFiles(['cv.pdf']);
          assert(convertCalls === 2 && !text(window).includes('awaiting recovery'), 'a re-drop of the same original must resume the same run, not ask for recovery');
          assert(JSON.stringify(parseArgs?.filePaths) === JSON.stringify(['/conv/cv.pdf.txt']), 'a re-drop of the same original must compile the same converted path');
        } finally { await bundle.module.act(async () => root.unmount()); }
        convertCalls = 0; parseArgs = null;
        const textRoot = await mount(bundle, window);
        try {
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          await bundle.module.act(async () => { window.document.querySelector('[data-career-drop]').dispatchEvent(drop); await flush(); await flush(); });
          assert(convertCalls === 0 && parseArgs?.filePaths?.[0] === '/orig/career.md', 'a text-only drop must reach compile unchanged without conversion');
        } finally { await bundle.module.act(async () => textRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: maximum-length node ids still create bounded career and preparation worker ids',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const nodeId = 'n'.repeat(160);
        const careerUpdates = []; let careerArgs;
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          parseCareerData: async args => { careerArgs = args; return { success: false, error: 'retryable' }; },
        };
        const careerRoot = await mount(bundle, window, { nodeId, onPersist: (patch, next) => careerUpdates.push({ patch, next }) });
        try {
          const target = window.document.querySelector('[data-career-drop]');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          const compiling = careerUpdates.find(item => item.patch.interviewHelperCareerCompilation?.status === 'compiling');
          assert(careerArgs?.nodeId === nodeId && careerArgs.manualAiRunId.length <= 160, 'career compilation must reach IPC with a bounded run id even for a 160-character node id');
          assert(compiling?.patch.interviewHelperCareerGeneration.length <= 160 && compiling.patch.interviewHelperCareerCompilation.manualAiRunId === careerArgs.manualAiRunId, 'career generation and receipt ids must not embed the oversized node id');
        } finally { await bundle.module.act(async () => careerRoot.unmount()); }

        let preparationArgs;
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async args => { preparationArgs = args; return { brief: publicBrief(), briefRecordId: BRIEF_RECORD_ID }; },
          completeNonApiAiRun: async () => ({ absent: true }),
        };
        const preparationRoot = await mount(bundle, window, { nodeId, initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST }, interviewHelperJobUrl: JOB_URL }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          assert(preparationArgs?.nodeId === nodeId && preparationArgs.manualAiRunId.length <= 160, 'preparation must reach IPC with a bounded run id even for a 160-character node id');
        } finally { await bundle.module.act(async () => preparationRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Cancel ends the Prepare in flight and puts the node back as it was',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred(); const updates = []; const cancels = []; const released = []; let prepareArgs;
        window.electronAPI = {
          releaseClaude: async key => { released.push(key); return { held: false }; },
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async args => { prepareArgs = args; return pending.promise; },
          completeNonApiAiRun: async () => ({ absent: true }),
        };
        window.interviewAppAPI = { cancelInterviewBrief: async args => { cancels.push(args); return { success: true, cancelled: true }; } };
        const root = await mount(bundle, window, { initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST }, interviewHelperJobUrl: JOB_URL }, nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }), showRunStatus: true });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(!button(window, 'Cancel'), 'there is nothing to cancel before Prepare starts');
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          assert(!button(window, 'Cancel preparation'), 'the panel has no cancel button of its own');
          const cancel = button(window, 'Cancel'); const pause = button(window, 'Pause & save');
          assert(cancel && pause, 'the status card of a running Prepare offers Pause & save and Cancel');
          assert(pause.parentElement.parentElement === cancel.parentElement && (pause.compareDocumentPosition(cancel) & window.Node.DOCUMENT_POSITION_FOLLOWING), 'Cancel sits in the same row, after Pause & save');
          await bundle.module.act(async () => { cancel.click(); await flush(); });
          assert(released.length === 1 && released[0] === `interview:${prepareArgs.manualAiRunId}`, 'a cancelled run leaves no hold behind');
          assert(cancels.length === 1 && cancels[0].nodeId === 'interview-helper' && cancels[0].runId === prepareArgs.manualAiRunId, 'Cancel names the run in flight');
          const last = updates.at(-1).next;
          assert(last.interviewHelperPreparation === null && last.interviewHelperPreparationRunId === null, 'the node is no longer preparing and holds no run to resume');
          assert(!button(window, 'Cancel') && text(window).includes('Preparation cancelled.'), 'the Cancel button goes and the panel says what happened');
          await bundle.module.act(async () => { pending.resolve({ success: true, cancelled: true }); await flush(); });
          assert(!updates.some(item => item.patch.interviewHelperPreparation?.status === 'failed'), 'a cancelled Prepare is not reported as a failure');
          const again = button(window, 'Prepare interview brief');
          assert(again && !again.disabled, 'Prepare can be started again once the cancelled run has ended');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: preparation is fenced after URL invalidation and a valid public brief shows the ready panel',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred(); const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => pending.promise,
          ...SWITCH_APPLICATION_API,
        };
        const root = await mount(bundle, window, { initialData: { interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          // Switching to an application without a posting link clears the
          // canonical URL, which must fence the in-flight preparation so its
          // late response cannot land.
          await switchApplication(bundle, window);
          await bundle.module.act(async () => { pending.resolve({ brief: publicBrief() }); await flush(); });
          assert(!updates.some(item => item.patch.interviewHelperPreparation?.briefId === publicBrief().briefId), 'a late preparation response must not resurrect a stale brief after URL invalidation');
          assert(updates.some(item => item.patch.interviewHelperJobUrl === null), 'switching to an application without a posting link must clear the job URL binding');
          const binding = `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`;
          await bundle.module.act(async () => {
            // Inject an already validated public brief only through the probe's
            // normal persistence callback path, emulating a completed request.
            const replacement = updates.find(item => item.next.interviewHelperJobUrl === null);
            assert(replacement, 'fixture must commit the cleared URL');
          });
          // Relaunch coverage uses a fresh prepared mount below; this instance
          // specifically proves late async preparation cannot overwrite it.
          assert(binding.includes(BUNDLE_ID) && !button(window, 'Open cue card'), 'stale preparation must not show a ready brief');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
      await withDomBundledProbe(async (bundle, window) => {
        const ready = publicBrief();
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewApplicationBundle: async () => { const reply = publicBundle(); reply.bundle.listingSource = 'given'; return reply; }, loadInterviewPreparedBrief: async () => ({ brief: ready }) };
        const root = await mount(bundle, window, { initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST }, interviewHelperPreparation: ready, interviewHelperPreparationRecordId: BRIEF_RECORD_ID, interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}` }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(!button(window, 'Open cue card'), 'the cue card is gone: no launch button is offered');
          const readyPanel = window.document.querySelector('[aria-label="Interview preparation ready"]');
          assert(readyPanel?.textContent.includes('Research ready · Product Manager at Acme')
            && readyPanel.textContent.includes('Research is prepared. Your answers are in the Q&A tabs; to have Prepare write a tab again, delete every card in it first.') && !/cue card/iu.test(readyPanel.textContent), 'ready copy for research alone points to the Q&A tabs');
          assert(readyPanel.textContent.includes('Confirm this career source matches the application you submitted.')
            && readyPanel.textContent.includes('This bundle is a captured copy; replace it after editing the documents.'), 'ready copy must explain application alignment and how to refresh frozen document content');
          assert(!readyPanel.textContent.includes('Job listing:') && window.document.querySelector('[aria-label="2. Application"] [data-listing-source="given"]:last-child')?.textContent.startsWith('Job listing: given'), 'the listing source shows in the Application section, not the preparation card');
          assert(readyPanel.textContent.includes('Submitted wording — reference, not career evidence'), 'submitted application wording must stay visibly separate from approved career evidence');
          assert(window.document.querySelector('[aria-label="3. Interview preparation"]')
            && !text(window).includes('Worker preparation'), 'the setup section must use interview terminology');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: only a verified host answer-bank summary announces prepared answers',
    async run() {
      for (const bankAvailable of [true, false]) {
        await withDomBundledProbe(async (bundle, window) => {
          const ready = publicBrief();
          window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewApplicationBundle: async () => publicBundle(), loadInterviewPreparedBrief: async () => ({ brief: ready, answerBankAvailable: bankAvailable, answerCardCount: 16 }) };
          const root = await mount(bundle, window, { initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST }, interviewHelperPreparation: ready, interviewHelperPreparationRecordId: BRIEF_RECORD_ID, interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`, interviewHelperAnswerCardCount: 20 }, nodes: sourceNodes() });
          try {
            await bundle.module.act(async () => { await flush(); await flush(); });
            const panel = window.document.querySelector('[aria-label="Interview preparation ready"]');
            assert(text(window).includes('then writes answer cards from your career data. Read and edit the cards in the Q&A panel before the interview.'), 'preparation must explain the separate answer step before the interview');
            if (bankAvailable) {
              assert(panel?.textContent.includes('16 prepared answers ready') && !/cue card/iu.test(panel.textContent), 'a verified answer bank must announce its real count');
            } else {
              assert(panel?.textContent.includes('Research ready') && panel.textContent.includes('Your answers are in the Q&A tabs') && !panel.textContent.includes('20 prepared answers'), 'research-only preparation keeps research-only copy and ignores renderer-supplied answer counts');
            }
          } finally { await bundle.module.act(async () => root.unmount()); }
        });
      }
    },
  },
  {
    name: 'interview helper render: cached briefs wait for main verification and never preview on failure',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred(); const ready = publicBrief();
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => pending.promise,
        };
        const root = await mount(bundle, window, { initialData: {
          interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: ready, interviewHelperPreparationRecordId: BRIEF_RECORD_ID,
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
        }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('Checking saved brief…') && button(window, 'Prepare interview brief')?.disabled && !window.document.querySelector('[aria-label="Interview preparation ready"]'), 'cached brief content must remain hidden and preparation disabled while main verification is pending');
          await bundle.module.act(async () => { pending.resolve({ brief: null }); await flush(); });
          assert(text(window).includes('Saved brief could not be verified; prepare again.') && !text(window).includes('Research ready · Product Manager') && !window.document.querySelector('[aria-label="Interview preparation ready"]'), 'a missing/mismatched main record must not create a renderer preview or launch path');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: an imported snapshot pin stays stable, never falls back to Job Search and tolerates old cue card fields',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const initialData = {
          interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: publicBrief(), interviewHelperPreparationRecordId: BRIEF_RECORD_ID,
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          interviewHelperLockedPlan: { stale: 'saved by an older version' }, interviewHelperCurrentStep: 3,
        };
        const updates = []; const loadedSnapshotIds = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async ({ snapshotId: requested }) => { loadedSnapshotIds.push(requested); return { snapshot: snapshot(requested) }; },
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => ({ brief: publicBrief() }),
        };
        const root = await mount(bundle, window, { initialData, nodes: sourceNodes(SNAPSHOT_B), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(loadedSnapshotIds.includes(SNAPSHOT_A)
            && !text(window).includes('Job Search')
            && !updates.some(item => item.patch.interviewHelperCareerMode === 'job-search'),
          'an imported snapshot pin must stay active and nothing may fall back to a Job Search source');
          assert(!window.document.querySelector('[aria-label="Locked interview answer rail"]') && !window.document.querySelector('[aria-label="Paste or type the interviewer question"]') && !/cue card/iu.test(text(window)),
            'old saved cue card rail fields load without rendering any rail or launch button');
          assert(loadedSnapshotIds.every(requested => requested === SNAPSHOT_A), 'only the pinned import snapshot may be requested');
        } finally { await bundle.module.act(async () => root.unmount()); }

        const noneLoads = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async ({ snapshotId: requested }) => { noneLoads.push(requested); return { snapshot: snapshot(requested) }; } };
        const noneRoot = await mount(bundle, window, {
          initialData: { interviewHelperCareerMode: 'none', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperLockedPlan: { stale: 'saved by an older version' }, interviewHelperCurrentStep: 3 },
          nodes: sourceNodes(),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(noneLoads.length === 0, 'an explicit no-source mode must ignore stale legacy source ids and never load their snapshot');
        } finally { await bundle.module.act(async () => noneRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: setup controls safely revert or remove persisted choices',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const base = runId => ({
          interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: { status: 'failed', error: 'Retryable worker interruption.' },
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          interviewHelperPreparationRunId: runId,
        });
        const mountCase = async (runId, action) => {
          const updates = []; const completions = [];
          window.electronAPI = {
            loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
            loadInterviewApplicationBundle: async () => publicBundle(),
            completeNonApiAiRun: async id => { completions.push(id); return { cleared: true }; },
            ...SWITCH_APPLICATION_API,
          };
          const root = await mount(bundle, window, { initialData: base(runId), nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
          try {
            await bundle.module.act(async () => { await flush(); });
            await action(updates, completions);
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        await mountCase('interview-helper:prepare:interview-helper:remove-bundle', async (updates, completions) => {
          await switchApplication(bundle, window);
          assert(completions[0] === 'interview-helper:prepare:interview-helper:remove-bundle'
            && updates.some(item => item.patch.interviewHelperApplicationBundle?.artifactId === OTHER_BUNDLE_ID && item.patch.interviewHelperJobUrl === null && item.patch.interviewHelperPreparation === null),
          'switching the application must retire a settled preparation recovery before replacing its opaque reference and job URL');
        });
        await mountCase('interview-helper:prepare:interview-helper:none-option', async (updates, completions) => {
          await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
          await settle(bundle);
          const options = [...window.document.querySelectorAll('[role="option"]')];
          assert(options[0]?.textContent === 'None' && options.length === FOLDERS.length + 1, 'a selected application must offer None ahead of the folders');
          await bundle.module.act(async () => { options[0].click(); await flush(); });
          await settle(bundle);
          assert(completions[0] === 'interview-helper:prepare:interview-helper:none-option'
            && updates.some(item => item.patch.interviewHelperApplicationBundle === null && item.patch.interviewHelperJobUrl === null && item.patch.interviewHelperPreparation === null),
          'choosing None must retire a settled preparation recovery before clearing the application and its job URL');
          assert(window.document.querySelector('[role="combobox"]').getAttribute('aria-expanded') === 'false', 'choosing None must close the listbox');
        });
        await mountCase('interview-helper:prepare:interview-helper:clear-source', async (updates, completions) => {
          await bundle.module.act(async () => { window.document.querySelector('[aria-label="Clear imported career source"]').click(); await flush(); });
          assert(completions[0] === 'interview-helper:prepare:interview-helper:clear-source'
            && updates.some(item => item.patch.interviewHelperCareerMode === 'none' && item.patch.interviewHelperCareerCompilation === null && item.patch.interviewHelperCareerSnapshotId === null && item.patch.interviewHelperPreparation === null),
          'clearing an imported source must retire the preparation recovery and persist an explicit no-source state');
        });

      });
    },
  },
  {
    name: 'interview helper render: preparation exceptions persist only a generic recovery error',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = []; const rawError = 'provider rejected /private/candidate/resume.pdf';
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => { throw new Error(rawError); },
        };
        const root = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          const failure = updates.find(item => item.patch.interviewHelperPreparation?.status === 'failed');
          assert(failure?.patch.interviewHelperPreparation?.error === 'Preparation did not complete. Resume or change setup to try again.'
            && !JSON.stringify(failure?.patch).includes(rawError)
            && text(window).includes('Preparation did not complete. Resume or change setup to try again.')
            && !text(window).includes(rawError),
          'provider exception details must not enter canvas persistence or the rendered recovery message');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a failed Prepare keeps its fixed failure code and says why',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => ({ success: false, error: 'The interview brief could not be prepared safely.', errorCode: 'CLAUDE_SAFEGUARD_BLOCKED' }),
        };
        const root = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          const failure = updates.find(item => item.patch.interviewHelperPreparation?.status === 'failed');
          assert(failure?.patch.interviewHelperPreparation?.code === 'CLAUDE_SAFEGUARD_BLOCKED'
            && text(window).includes("Claude's safety filter stopped this preparation"),
          'a safeguard stop must be named in the saved state and on screen');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: hostile persisted setup display text is never rendered raw',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const hostileLabel = 'Unsafe\u202E bundle';
        const hostileFilename = 'career\u202E.md';
        const hostileError = 'Provider failure at /private/candidate/resume.pdf';
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
        const root = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'approved-generation',
            interviewHelperCareerSnapshotId: SNAPSHOT_A,
            interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
            interviewHelperCareerFilenames: ['career.md', hostileFilename],
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: hostileLabel, digest: BUNDLE_DIGEST, integritySummary: 'Verified\u202E status' },
            interviewHelperPreparation: { status: 'failed', error: hostileError },
          },
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('Career data ready · career.md')
            && !text(window).includes(hostileFilename)
            && text(window).includes('Selected application bundle')
            && !text(window).includes(hostileLabel)
            && !text(window).includes('Verified\u202E status')
            && text(window).includes('Preparation did not complete. Resume or change setup to try again.')
            && !text(window).includes(hostileError),
          'untrusted persisted filenames, bundle metadata, and failures must be filtered or replaced before rendering');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a stale terminal response is retired once, and failed cleanup remains retryable',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred();
        const updates = [];
        const completions = [];
        let cleanupOutcome = 'fail';
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => pending.promise,
          ...SWITCH_APPLICATION_API,
          completeNonApiAiRun: async runId => {
            completions.push(runId);
            if (cleanupOutcome === 'fail') throw new Error('offline');
            if (cleanupOutcome === 'invalid') return { cleared: false };
            return { cleared: true };
          },
        };
        const root = await mount(bundle, window, { initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          await switchApplication(bundle, window);
          assert(completions.length === 0, 'input invalidation must not retire an in-flight manual worker before its response is terminal');
          await bundle.module.act(async () => { pending.resolve({ brief: publicBrief() }); await flush(); });
          assert(completions.length === 1, 'a terminal stale response must be retired exactly once');
          const failedReceipt = updates.find(item => item.patch.interviewHelperManualAiCleanup?.status === 'failed');
          assert(failedReceipt?.patch.interviewHelperManualAiCleanup?.kind === 'preparation', 'a failed terminal cleanup must persist an exact preparation receipt');
          assert(button(window, 'Prepare interview brief').disabled, 'a pending cleanup must block a new manual worker operation');
          cleanupOutcome = 'invalid';
          await bundle.module.act(async () => { button(window, 'Retry manual-AI cleanup').click(); await flush(); });
          assert(!updates.some(item => item.patch.interviewHelperManualAiCleanup === null), 'an unacknowledged cleanup retry must retain its receipt');
          cleanupOutcome = 'success';
          await bundle.module.act(async () => { button(window, 'Retry manual-AI cleanup').click(); await flush(); });
          assert(completions.length === 3 && updates.some(item => item.patch.interviewHelperManualAiCleanup === null), 'only an authoritative cleared response may remove the cleanup receipt');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: reload lets terminal cleanup retry despite persisted active receipts',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const cases = [
          ['career', 'interview-helper:compile:interview-helper:reload', {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', manualAiRunId: 'interview-helper:compile:interview-helper:reload' },
          }],
          ['preparation', 'interview-helper:prepare:interview-helper:reload', {
            interviewHelperPreparation: { status: 'preparing' },
            interviewHelperPreparationRunId: 'interview-helper:prepare:interview-helper:reload',
          }],
        ];
        for (const [kind, runId, receipt] of cases) {
          const updates = []; const completions = [];
          window.electronAPI = {
            completeNonApiAiRun: async completedRunId => { completions.push(completedRunId); return { cleared: true }; },
          };
          const root = await mount(bundle, window, {
            initialData: {
              ...receipt,
              interviewHelperManualAiCleanup: { version: 1, kind, runId, status: 'failed' },
            },
            onPersist: (patch, next) => updates.push({ patch, next }),
          });
          try {
            await bundle.module.act(async () => { await flush(); });
            const retry = button(window, 'Retry manual-AI cleanup');
            assert(retry && !retry.disabled, `reloaded ${kind} receipt must not masquerade as a live worker`);
            await bundle.module.act(async () => { retry.click(); await flush(); });
            assert(completions.length === 1 && completions[0] === runId, `reloaded ${kind} cleanup must retire its exact run`);
            assert(updates.some(item => item.patch.interviewHelperManualAiCleanup === null), `reloaded ${kind} cleanup receipt must clear after confirmation`);
          } finally { await bundle.module.act(async () => root.unmount()); }
        }
      });
    },
  },
  {
    name: 'interview helper render: restored deletion receipts block work and retry exact ids atomically',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const receipt = (runId, cancellationPending = true) => ({
          runId,
          retirementPending: true,
          retirementReason: 'node-deleted',
          cancellationPending,
          cancellationReason: 'node-deleted',
        });
        const careerRunId = 'interview-helper:compile:interview-helper:restored-career';
        const preparationRunId = 'interview-helper:prepare:interview-helper:restored-preparation';
        const markerRunId = 'interview-helper:prepare:interview-helper:restored-marker';
        const acknowledgedRunId = 'interview-helper:prepare:interview-helper:restored-ack';
        const hostileReceipt = Object.assign(Object.create({ inheritedPayload: 'must-not-survive' }), receipt('interview-helper:prepare:interview-helper:inherited'));
        const expectedRunIds = new Set([careerRunId, preparationRunId, markerRunId, acknowledgedRunId]);
        const updates = [];
        const cancellationCalls = [];
        const completionBatches = [];
        let completionFails = true;
        window.electronAPI = {
          cancelNodeTaskAndWait: async (nodeId, reason) => {
            cancellationCalls.push({ nodeId, reason });
            return { settled: true, manualAiRunIds: [acknowledgedRunId, acknowledgedRunId, 'not a valid run id'] };
          },
          completeNonApiAiRuns: async runIds => {
            completionBatches.push([...runIds]);
            if (completionFails) throw new Error('retirement unavailable');
            return { completed: true, clearedRunIds: [...runIds], absentRunIds: [] };
          },
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'job-search',
            interviewHelperCareerGeneration: 'restored-career-generation',
            interviewHelperCareerCompilation: { version: 1, status: 'failed', manualAiRunId: careerRunId },
            interviewHelperPreparation: { status: 'failed', error: 'Saved worker interruption.' },
            interviewHelperPreparationRunId: preparationRunId,
            interviewHelperManualAiCleanup: { version: 1, kind: 'preparation', runId: markerRunId, status: 'failed' },
            interviewHelperManualAiRetirementReceipts: [
              receipt(careerRunId), receipt(preparationRunId), receipt(markerRunId), receipt(careerRunId, false),
              receipt('not a valid run id'), { ...receipt('interview-helper:prepare:interview-helper:extra'), unexpectedPayload: 'must-not-survive' },
              hostileReceipt, { runId: 'interview-helper:prepare:unfenced' },
            ],
          },
          nodes: sourceNodes(),
          onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('A restored deletion cleanup is still pending')
            && button(window, 'Resume preparation').disabled
            && button(window, 'Choose files…').disabled,
          'only strictly valid restored deletion receipts must block new career and preparation work with an explicit recovery alert');

          await bundle.module.act(async () => { button(window, 'Retry restored cleanup').click(); await flush(); });
          const retainedAfterFailure = updates.at(-1)?.patch.interviewHelperManualAiRetirementReceipts;
          assert(cancellationCalls.length === 1
            && cancellationCalls[0].nodeId === 'interview-helper'
            && cancellationCalls[0].reason === 'cleanup-retry'
            && completionBatches[0].length === expectedRunIds.size
            && completionBatches[0].every(runId => expectedRunIds.has(runId))
            && retainedAfterFailure?.length === expectedRunIds.size
            && retainedAfterFailure.every(item => expectedRunIds.has(item.runId) && item.cancellationPending === false && !Object.hasOwn(item, 'unexpectedPayload') && !Object.hasOwn(item, 'inheritedPayload')),
          'a failed atomic retirement must retain only allowlisted deduped receipts for another explicit retry');

          completionFails = false;
          await bundle.module.act(async () => { button(window, 'Retry restored cleanup').click(); await flush(); });
          const cleared = updates.at(-1);
          assert(cancellationCalls.length === 2
            && completionBatches[1].length === expectedRunIds.size
            && completionBatches[1].every(runId => expectedRunIds.has(runId))
            && cleared.patch.interviewHelperManualAiRetirementReceipts === null
            && cleared.patch.interviewHelperCareerCompilation === null
            && cleared.patch.interviewHelperPreparation === null
            && cleared.patch.interviewHelperPreparationRunId === null
            && cleared.patch.interviewHelperManualAiCleanup === null,
          'only a fully acknowledged atomic retirement may clear its receipts and matching resumable worker state');
        } finally { await bundle.module.act(async () => root.unmount()); }

        const preservedUpdates = [];
        const completedBrief = publicBrief();
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          cancelNodeTaskAndWait: async () => ({ settled: true, manualAiRunIds: [] }),
          completeNonApiAiRuns: async runIds => ({ completed: true, clearedRunIds: [...runIds], absentRunIds: [] }),
        };
        const preservedRoot = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'approved-generation',
            interviewHelperCareerSnapshotId: SNAPSHOT_A,
            interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A, manualAiRunId: 'interview-helper:compile:approved' },
            interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperPreparation: completedBrief,
            interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
            interviewHelperManualAiCleanup: { version: 1, kind: 'preparation', runId: markerRunId, status: 'failed' },
            interviewHelperManualAiRetirementReceipts: [receipt(markerRunId)],
          },
          onPersist: (patch, next) => preservedUpdates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); button(window, 'Retry restored cleanup').click(); await flush(); });
          const cleared = preservedUpdates.at(-1);
          assert(cleared.patch.interviewHelperManualAiRetirementReceipts === null
            && cleared.patch.interviewHelperManualAiCleanup === null
            && cleared.next.interviewHelperCareerCompilation?.status === 'approved'
            && cleared.next.interviewHelperCareerSnapshotId === SNAPSHOT_A
            && cleared.next.interviewHelperPreparation?.briefId === completedBrief.briefId,
          'retiring a separate cleanup receipt must preserve approved snapshots and completed preparation briefs');
        } finally { await bundle.module.act(async () => preservedRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: stale rejected workers retire while current failures remain resumable',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const careerPending = deferred(); const careerCompletions = [];
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          parseCareerData: async () => careerPending.promise,
          completeNonApiAiRun: async runId => { careerCompletions.push(runId); return { cleared: true }; },
        };
        const alternateSource = { ...sourceNodes(SNAPSHOT_B)[0], id: 'job-source-2' };
        const careerRoot = await mount(bundle, window, { nodes: [...sourceNodes(), alternateSource] });
        try {
          const target = window.document.querySelector('[data-career-drop]');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          assert(!window.document.querySelector('[aria-label="Career source for Interview Helper"]'), 'the Job Search source selector must be gone');
          await bundle.module.act(async () => {
            window.document.querySelector('[aria-label="Clear imported career source"]').click();
            await flush();
            assert(careerCompletions.length === 0, 'clearing the source must not retire a genuinely local compiling worker before it settles');
            careerPending.reject(new Error('terminal compilation rejection'));
            await flush();
          });
          assert(careerCompletions.length === 1 && careerCompletions[0].startsWith('interview-helper:compile:'), 'a stale rejected compilation must retire its exact worker run');
        } finally { await bundle.module.act(async () => careerRoot.unmount()); }

        const stalePending = deferred(); const staleCompletions = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => stalePending.promise,
          completeNonApiAiRun: async runId => { staleCompletions.push(runId); return { cleared: true }; },
          ...SWITCH_APPLICATION_API,
        };
        const staleRoot = await mount(bundle, window, { initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          await switchApplication(bundle, window);
          await bundle.module.act(async () => {
            assert(staleCompletions.length === 0, 'changing input must not retire a genuinely local preparing worker before it settles');
            stalePending.reject(new Error('terminal preparation rejection'));
            await flush();
          });
          assert(staleCompletions.length === 1 && staleCompletions[0].startsWith('interview-helper:prepare:'), 'a stale rejected preparation must retire its exact worker run');
        } finally { await bundle.module.act(async () => staleRoot.unmount()); }

        const currentPending = deferred(); const currentCompletions = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => currentPending.promise,
          completeNonApiAiRun: async runId => { currentCompletions.push(runId); return { cleared: true }; },
        };
        const currentRoot = await mount(bundle, window, { initialData: { interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); currentPending.reject(new Error('retryable preparation rejection')); await flush(); });
          assert(currentCompletions.length === 0, 'a current rejected preparation must retain its resumable worker identity');
          assert(button(window, 'Resume preparation') && !button(window, 'Resume preparation').disabled, 'a current rejected preparation must remain resumable');
        } finally { await bundle.module.act(async () => currentRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: changing inputs retires settled recovery runs before clearing them',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const careerRunId = 'interview-helper:compile:interview-helper:failed-career';
        const careerUpdates = []; const careerCompletions = [];
        window.electronAPI = {
          completeNonApiAiRun: async runId => { careerCompletions.push(runId); return { cleared: true }; },
        };
        const careerRoot = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'interview-helper:interview-helper:failed-career',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', manualAiRunId: careerRunId },
            interviewHelperCareerFilenames: ['original-career.md'],
          },
          nodes: sourceNodes(), onPersist: (patch, next) => careerUpdates.push({ patch, next }),
        });
        try {
          assert(!window.document.querySelector('[aria-label="Career source for Interview Helper"]'), 'a failed import must not expose a Job Search source switch');
          assert(careerCompletions.length === 0, 'an idle failed import must not retire its worker before a new drop arrives');
        } finally { await bundle.module.act(async () => careerRoot.unmount()); }

        const discardRunId = 'interview-helper:compile:interview-helper:discard';
        const discardUpdates = []; const discardCompletions = [];
        window.electronAPI = {
          getPathForFile: file => file.name === 'different-career.md' ? '/private/candidate/different-career.md' : '',
          parseCareerData: async () => ({ success: false }),
          completeNonApiAiRun: async runId => { discardCompletions.push(runId); return { cleared: true }; },
        };
        const discardRoot = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'interview-helper:interview-helper:discard',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', generation: 'interview-helper:interview-helper:discard', manualAiRunId: discardRunId },
            interviewHelperCareerFilenames: ['original-career.md'],
          },
          onPersist: (patch, next) => discardUpdates.push({ patch, next }),
        });
        try {
          const target = window.document.querySelector('[data-career-drop]');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'different-career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          assert(button(window, 'Discard previous career recovery'), 'different files must expose an explicit safe abandon path for a reloaded recovery');
          await bundle.module.act(async () => { button(window, 'Discard previous career recovery').click(); await flush(); });
          assert(discardCompletions.length === 1 && discardCompletions[0] === discardRunId, 'discarding a reloaded compilation must retire its exact worker');
          assert(discardUpdates.some(item => item.patch.interviewHelperCareerCompilation === null), 'discarding a retired compilation must remove the filename-binding receipt');
          assert(text(window).includes('Choose or drop the new career files'), 'successful discard must tell the user how to start the replacement import');
        } finally { await bundle.module.act(async () => discardRoot.unmount()); }

        const failedPrep = (suffix, status = 'failed') => ({
          interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: { status, error: 'Retryable worker interruption.' },
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          interviewHelperPreparationRunId: `interview-helper:prepare:interview-helper:${suffix}`,
        });
        const runAbandonmentCase = async ({ suffix, status, picked = publicBundle(), action, assertion }) => {
          const completions = []; const updates = [];
          window.electronAPI = {
            loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
            loadInterviewApplicationBundle: async () => publicBundle(),
            listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
            selectInterviewApplicationFolder: async () => picked,
            getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
            parseCareerData: async () => ({ success: false, error: 'new career run is separately resumable' }),
            completeNonApiAiRun: async runId => { completions.push(runId); return { cleared: true }; },
          };
          const root = await mount(bundle, window, { initialData: failedPrep(suffix, status), nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
          try {
            await bundle.module.act(async () => { await flush(); });
            await action();
            assert(completions[0] === `interview-helper:prepare:interview-helper:${suffix}`, `${suffix} change must retire the abandoned preparation run`);
            assertion(updates);
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        await runAbandonmentCase({
          suffix: 'url',
          status: 'preparing',
          // Re-picking the same application after its posting link is gone.
          action: async () => {
            await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
            await settle(bundle);
            await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
          },
          assertion: updates => assert(updates.some(item => item.patch.interviewHelperJobUrl === null && item.patch.interviewHelperPreparation === null), 'clearing the bundle URL must clear preparation only after retirement'),
        });
        await runAbandonmentCase({
          suffix: 'bundle',
          picked: publicBundle('9'.repeat(64), '8'.repeat(64)),
          action: async () => {
            await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
            await settle(bundle);
            await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
          },
          assertion: updates => assert(updates.some(item => item.patch.interviewHelperApplicationBundle?.artifactId === '9'.repeat(64) && item.patch.interviewHelperPreparation === null), 'bundle replacement must clear preparation only after retirement'),
        });
        await runAbandonmentCase({
          suffix: 'career',
          action: async () => {
            const target = window.document.querySelector('[data-career-drop]');
            const drop = new window.Event('drop', { bubbles: true });
            Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
            await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          },
          assertion: updates => assert(updates.some(item => item.patch.interviewHelperCareerMode === 'import' && item.patch.interviewHelperPreparation === null), 'starting a career import must retire and clear the abandoned preparation run first'),
        });
      });
    },
  },
  {
    name: 'interview helper render: reload preserves a resumable preparation run',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        let prepareArgs;
        const runId = 'interview-helper:prepare:interview-helper:resume';
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async args => { prepareArgs = args; return { brief: publicBrief(), briefRecordId: BRIEF_RECORD_ID }; },
          completeNonApiAiRun: async () => ({ absent: true }),
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
            interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperPreparation: { status: 'failed', error: 'Retryable worker interruption.' },
            interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
            interviewHelperPreparationRunId: runId,
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(button(window, 'Resume preparation') && !button(window, 'Resume preparation').disabled, 'a persisted failed preparation must survive reload as an explicit resume action');
          assert(!updates.some(item => item.patch.interviewHelperPreparation === null), 'reload must not erase a valid resumable preparation receipt');
          await bundle.module.act(async () => { button(window, 'Resume preparation').click(); await flush(); });
          assert(prepareArgs?.manualAiRunId === runId, 'resume must retain the original manual worker identity');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: bundle changes preserve the independent career data',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
          selectInterviewApplicationFolder: async () => publicBundle(),
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
            interviewHelperJobUrl: 'https://jobs.example.test/original',
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('Career data ready'), 'fixture must show the imported career data before setup changes');
          await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
          await settle(bundle);
          await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
          assert(updates.some(item => item.patch.interviewHelperJobUrl === null), 'choosing another bundle must rewrite the job URL from the chosen bundle');
          assert(text(window).includes('Career data ready'), 'bundle setup changes must not clear the imported career data');
          assert(!updates.some(item => Object.hasOwn(item.patch, 'interviewHelperCareerSnapshotId') || Object.hasOwn(item.patch, 'interviewHelperCareerMode')), 'bundle updates must clear only preparation state, never career evidence');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a failed bundle reload keeps a durable preparation recovery until it is retired',
    async run() {
      const runId = 'interview-helper:prepare:interview-helper:bundle-reload';
      for (const [variant, loader] of [
        ['rejected', async () => { throw new Error('io'); }],
        ['missing', async () => ({ bundle: null })],
      ]) {
        for (const status of ['failed', 'preparing']) {
          await withDomBundledProbe(async (bundle, window) => {
            const updates = []; const completions = [];
            window.electronAPI = {
              loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
              loadInterviewApplicationBundle: loader,
              completeNonApiAiRun: async id => { completions.push(id); return { cleared: true }; },
              ...SWITCH_APPLICATION_API,
            };
            const root = await mount(bundle, window, {
              initialData: {
                interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL,
                interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
                interviewHelperPreparation: status === 'failed' ? { status, error: 'Retryable worker interruption.' } : { status },
                interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
                interviewHelperPreparationRunId: runId,
              },
              nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
            });
            try {
              await bundle.module.act(async () => { await flush(); await flush(); });
              assert(!updates.some(item => item.patch.interviewHelperPreparationRunId === null), `${variant}/${status}: a failed bundle reload must not drop a durable preparation run without retiring it`);
              assert(text(window).includes('The selected application bundle is unavailable'), `${variant}/${status}: the bundle error must be visible`);
              const resume = button(window, 'Resume preparation');
              assert(!resume || resume.disabled, `${variant}/${status}: preparation must stay disabled while the bundle is unverified`);
              await switchApplication(bundle, window);
              assert(completions.includes(runId), `${variant}/${status}: replacing the bundle must retire the recovery run`);
              assert(updates.some(item => item.patch.interviewHelperApplicationBundle?.artifactId === OTHER_BUNDLE_ID && item.patch.interviewHelperPreparationRunId === null), `${variant}/${status}: the recovery is cleared only after retirement`);
            } finally { await bundle.module.act(async () => root.unmount()); }
          });
        }
      }
    },
  },
  {
    name: 'interview helper render: a prepare that fails while the bundle picker is open is retired, not orphaned, when another bundle is picked',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const prep = deferred(); const picker = deferred(); const completions = []; const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
          selectInterviewApplicationFolder: () => picker.promise,
          prepareInterviewBrief: () => prep.promise,
          completeNonApiAiRun: async runId => { completions.push(runId); return { cleared: true }; },
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          const runId = updates.map(item => item.patch.interviewHelperPreparationRunId).find(Boolean);
          assert(/^interview-helper:prepare:/u.test(runId || ''), 'prepare must record its durable run id');
          await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
          await settle(bundle);
          await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
          await bundle.module.act(async () => { prep.reject(new Error('worker interrupted')); await flush(); await flush(); await flush(); });
          assert(updates.some(item => item.patch.interviewHelperPreparation?.status === 'failed' && item.patch.interviewHelperPreparationRunId === runId), 'the interrupted prepare must leave a resumable recovery while the picker is open');
          await bundle.module.act(async () => { picker.resolve(publicBundle('9'.repeat(64), '8'.repeat(64))); await flush(); await flush(); await flush(); });
          assert(completions.includes(runId), `the recovery that appeared while the picker was open must be retired before it is cleared, got ${JSON.stringify(completions)}`);
          const clearIndex = updates.findIndex(item => item.patch.interviewHelperApplicationBundle?.artifactId === '9'.repeat(64) && item.patch.interviewHelperPreparationRunId === null);
          assert(clearIndex >= 0, 'picking a different bundle still clears the preparation state');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: re-picking the identical bundle keeps a finished brief',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => ({ brief: publicBrief() }),
          listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
          selectInterviewApplicationFolder: async () => ({ ...publicBundle(), jobUrl: JOB_URL }),
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import', interviewHelperCareerSnapshotId: SNAPSHOT_A, interviewHelperCareerGeneration: 'approved-generation', interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A }, interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperPreparation: publicBrief(), interviewHelperPreparationRecordId: BRIEF_RECORD_ID,
            interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); await flush(); });
          assert(window.document.querySelector('[aria-label="Interview preparation ready"]'), 'fixture must start with a ready brief');
          const before = updates.length;
          await bundle.module.act(async () => { window.document.querySelector('[role="combobox"]').click(); await flush(); });
          await settle(bundle);
          await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); await flush(); await flush(); });
          assert(!updates.slice(before).some(item => item.patch.interviewHelperPreparation === null || item.patch.interviewHelperPreparationRecordId === null), 'an identical bundle must not clear the finished brief');
          assert(window.document.querySelector('[aria-label="Interview preparation ready"]'), 'the finished brief must still show as ready after re-picking the same bundle');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: the same career files in a different order resume the recorded run in the recorded order',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const parseCalls = [];
        window.electronAPI = {
          getPathForFile: file => `/private/candidate/${file.name}`,
          parseCareerData: async args => { parseCalls.push(args); return { success: false }; },
        };
        const runId = 'interview-helper:compile:interview-helper:order';
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import', interviewHelperCareerGeneration: 'interview-helper:interview-helper:order',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', generation: 'interview-helper:interview-helper:order', manualAiRunId: runId },
            interviewHelperCareerFilenames: ['resume.md', 'linkedin.md'],
          },
        });
        try {
          const target = window.document.querySelector('[data-career-drop]');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'linkedin.md' }, { name: 'resume.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); await flush(); });
          assert(parseCalls.length === 1 && parseCalls[0].manualAiRunId === runId, `the same files in another order must resume the recorded run, got ${JSON.stringify(parseCalls.map(call => call.manualAiRunId))}`);
          assert(parseCalls[0].filePaths.join('|') === '/private/candidate/resume.md|/private/candidate/linkedin.md', `files must be resumed in the recorded order, got ${parseCalls[0].filePaths.join('|')}`);
          const other = new window.Event('drop', { bubbles: true });
          Object.defineProperty(other, 'dataTransfer', { value: { files: [{ name: 'resume.md' }, { name: 'different.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(other); await flush(); await flush(); });
          assert(parseCalls.length === 1, 'a genuinely different file set must still be refused');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Retry on a failed career import is disabled while the node is locked',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        window.electronAPI = { getPathForFile: file => `/private/candidate/${file.name}`, parseCareerData: async () => ({ success: false }) };
        const root = await mount(bundle, window, {
          initialData: {
            locked: true, interviewHelperCareerMode: 'import', interviewHelperCareerGeneration: 'interview-helper:interview-helper:locked',
            interviewHelperCareerCompilation: { version: 1, status: 'failed', generation: 'interview-helper:interview-helper:locked', manualAiRunId: 'interview-helper:compile:interview-helper:locked' },
            interviewHelperCareerFilenames: ['resume.md'],
          },
        });
        try {
          const retry = button(window, 'Retry');
          assert(retry && retry.disabled, 'a locked node must not offer a Retry that silently does nothing');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: the file chooser compiles the chosen career files and ignores a cancelled or blank choice',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const parsePaths = [];
        let chosen = [];
        window.electronAPI = { parseCareerData: async args => { parsePaths.push(args.filePaths); return { success: false, error: 'retryable' }; } };
        window.interviewAppAPI = { chooseCareerFiles: async () => chosen };
        const root = await mount(bundle, window);
        try {
          await bundle.module.act(async () => { await flush(); });
          const choose = async paths => {
            chosen = paths;
            await bundle.module.act(async () => { button(window, 'Choose files…').click(); await flush(); await flush(); });
            await settle(bundle);
          };
          await choose([]);
          await choose(['   ']);
          assert(parsePaths.length === 0, `a cancelled chooser and a blank path must start nothing, got ${JSON.stringify(parsePaths)}`);
          await choose(['/private/candidate/career.md']);
          assert(parsePaths.length === 1 && parsePaths[0][0] === '/private/candidate/career.md', `the chooser must compile exactly the chosen career file, got ${JSON.stringify(parsePaths)}`);
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: setup shows no Job Search source or Finder bundle button and the bundle URL always wins',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
          selectInterviewApplicationFolder: async () => ({ ...publicBundle(), jobUrl: JOB_URL }),
          loadInterviewApplicationBundle: async () => publicBundle(),
        };
        const root = await mount(bundle, window, {
          initialData: { interviewHelperJobUrl: 'https://jobs.example.test/saved-before', interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          nodes: sourceNodes(), onPersist: patch => updates.push(patch),
        });
        try {
          await settle(bundle);
          assert(!window.document.querySelector('[aria-label="Career source for Interview Helper"]'), 'no Job Search source selector may remain');
          assert(!text(window).includes('Choose application bundle') && !text(window).includes('Replace application bundle'), 'the Finder bundle button must be gone');
          assert(!text(window).includes('Or choose an application bundle manually'), 'the manual Finder bundle copy must be gone');
          assert(!window.document.querySelector('[aria-label="Original job listing URL"]'), 'the editable job URL field must be gone');
          const combobox = window.document.querySelector('[role="combobox"]');
          await bundle.module.act(async () => { combobox.click(); await flush(); });
          await settle(bundle);
          await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
          await settle(bundle, 6);
          assert(updates.some(patch => patch.interviewHelperJobUrl === JOB_URL), `choosing a bundle must overwrite the saved job URL with the bundle URL, got ${JSON.stringify(updates.map(patch => patch.interviewHelperJobUrl))}`);
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a bundle without a job posting link explains why preparation stays disabled',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          listInterviewApplicationFolders: async () => ({ root: '/Applied Jobs', folders: FOLDERS }),
          selectInterviewApplicationFolder: async () => publicBundle(),
          loadInterviewApplicationBundle: async () => publicBundle(),
        };
        const root = await mount(bundle, window, {
          initialData: { interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          nodes: sourceNodes(), onPersist: patch => updates.push(patch),
        });
        try {
          await settle(bundle);
          const combobox = window.document.querySelector('[role="combobox"]');
          await bundle.module.act(async () => { combobox.click(); await flush(); });
          await settle(bundle);
          await bundle.module.act(async () => { firstFolderOption(window).click(); await flush(); });
          await settle(bundle, 6);
          assert(text(window).includes('This application has no job posting link, so preparation cannot research it. Regenerate the application, then choose it again.'), 'a bundle without a job URL must explain that preparation cannot research it');
          assert(button(window, 'Prepare interview brief').disabled, 'preparation must stay disabled without a canonical job URL');
          assert(updates.some(patch => patch.interviewHelperJobUrl === null), 'a bundle without a URL must clear the previously saved job URL');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  ...QA_SETUP_TESTS,
  ...TYPED_JOB_TESTS,
];
