import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(import.meta.url);
// Interview Helper's renderer bridge is the standalone app's preload; the canvas preload has none of it.
const preloadPath = fileURLToPath(new URL('../../electron/interviewApp/interviewAppPreload.js', import.meta.url));

/**
 * Evaluate the preload entry with its Electron seam.
 * This intentionally does not import Electron or launch a renderer process:
 * the bridge and every invoked IPC request remain observable in this VM.
 */
function loadPreloadBridge() {
  const invocations = [];
  const exposures = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposures.push({ name, value });
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        const invocation = { channel, args };
        invocations.push(invocation);
        return Promise.resolve(invocation);
      },
      on() {},
      removeListener() {},
      send() {},
    },
    webUtils: {
      getPathForFile: file => `/stubbed/${file?.name || 'file'}`,
    },
  };
  const sandbox = {
    require(specifier) {
      assert.equal(specifier, 'electron', 'preload must require only Electron at this seam');
      return electron;
    },
    console: { error() {} },
    Set,
  };

  const source = fs.readFileSync(preloadPath, 'utf8');
  vm.runInNewContext(source, sandbox, { filename: preloadPath });

  assert.deepEqual(exposures.map(item => item.name), ['electronAPI', 'interviewAppAPI'], 'the app preload exposes the shared bridge name plus its own saved-state bridge');
  return { api: exposures[0].value, appApi: exposures[1].value, invocations };
}

const DIRECT_FORWARDING = [
  ['loadInterviewHelperCareerSnapshot', 'load-interview-helper-career-snapshot', { nodeId: 'interview-node', snapshotId: 'a'.repeat(64) }],
  ['loadInterviewApplicationBundle', 'load-interview-preparation-bundle', { nodeId: 'interview-node', artifactId: 'b'.repeat(64) }],
  ['launchInterviewWindow', 'interview-window:launch', { nodeId: 'interview-node', snapshotId: 'a'.repeat(64), brief: { briefId: 'brief-1' } }],
];

const tests = [
  {
    name: 'interview preload: exposes the reviewed renderer methods without a raw brief builder',
    run() {
      const { api } = loadPreloadBridge();
      for (const [method] of DIRECT_FORWARDING) {
        assert.equal(typeof api[method], 'function', `electronAPI must expose ${method}`);
      }
      assert.equal(typeof api.prepareInterviewBrief, 'function', 'electronAPI must expose the renderer-safe brief preparation method');
      assert.equal(api.buildInterviewBrief, undefined, 'renderer must not receive a direct backend-named brief builder');
      for (const method of ['selectInterviewApplicationBundle', 'loadInterviewPractice', 'startInterviewPractice', 'cancelInterviewPractice', 'onInterviewPracticeUpdated']) {
        assert.equal(api[method], undefined, `electronAPI must not expose the removed ${method}`);
      }
      for (const method of ['inspectCareerCompileResume', 'onCareerCompileProgress']) assert.equal(api[method], undefined, `electronAPI must not expose the removed ${method}`);
      return { methods: DIRECT_FORWARDING.length + 1 };
    },
  },
  {
    name: 'interview preload: the standalone app bridge reaches only its own saved-state and chooser channels',
    run: async () => {
      const { api, appApi, invocations } = loadPreloadBridge();
      assert.deepEqual(Object.keys(appApi).sort(), ['chooseAppliedJobsFolder', 'chooseCareerFiles', 'convertCareerFiles', 'copyBugReport', 'getTextSize', 'loadState', 'loadStateFromFile', 'onInterviewQaChanged', 'onSaveStateNow', 'onTextSizeChanged', 'resolveInterviewTypedJob', 'revealConvertedCareerFile', 'saveBugReport', 'saveState', 'saveStateToFile', 'setTextSize', 'stateSavedNow']);
      await appApi.loadState(); await appApi.saveState({ sessions: [] }); await appApi.chooseCareerFiles(); await appApi.chooseAppliedJobsFolder();
      await appApi.resolveInterviewTypedJob({ nodeId: 'interview-node', text: 'Engineer at Acme', extra: 'dropped' });
      await appApi.convertCareerFiles({ nodeId: 'interview-node', filePaths: ['/a/resume.pdf'], extra: 'dropped' });
      await appApi.revealConvertedCareerFile({ token: 'tok', path: '/etc/passwd' });
      assert.deepEqual(invocations.map(({ channel }) => channel), ['interview-app:load-state', 'interview-app:save-state', 'interview-app:choose-career-files', 'interview-app:choose-applied-jobs-folder', 'resolve-interview-typed-job', 'convert-interview-career-files', 'interview-app:reveal-converted-career-file']);
      assert.deepEqual({ ...invocations.at(-2).args[0] }, { nodeId: 'interview-node', filePaths: ['/a/resume.pdf'] }, 'conversion forwards only nodeId and filePaths');
      assert.deepEqual({ ...invocations.at(-1).args[0] }, { token: 'tok' }, 'reveal forwards only an opaque token, never a path');
      assert.deepEqual({ ...invocations.at(-3).args[0] }, { nodeId: 'interview-node', text: 'Engineer at Acme' }, 'the typed job call forwards only its two reviewed fields');
      await appApi.copyBugReport({ description: 'It froze', renderer: { events: [] }, path: '/etc/passwd' });
      await appApi.saveBugReport({ description: 'It froze', renderer: { events: [] }, filePath: '/etc/passwd' });
      assert.deepEqual(invocations.slice(-2).map(({ channel, args }) => [channel, { ...args[0] }]), [
        ['interview-app:copy-bug-report', { description: 'It froze', renderer: { events: [] } }],
        ['interview-app:save-bug-report', { description: 'It froze', renderer: { events: [] } }],
      ], 'a bug report forwards only the description and the window details, never a path');
      await appApi.getTextSize(); await appApi.setTextSize({ percent: 150, zoom: 9 });
      assert.deepEqual(invocations.slice(-2).map(({ channel, args }) => [channel, args.map(arg => ({ ...arg }))]), [
        ['interview-app:get-text-size', []],
        ['interview-app:set-text-size', [{ percent: 150 }]],
      ], 'the text size call forwards only the percent');
      // There is no canvas here: the application list never forwards a renderer-supplied path.
      const listed = await api.listInterviewApplicationFolders({ nodeId: 'interview-node', canvasFilePath: '/Users/someone/elsewhere.json' });
      assert.deepEqual({ ...listed.args[0] }, { nodeId: 'interview-node', canvasFilePath: null });
      for (const method of ['saveWorkspace', 'readFile', 'searchJobs', 'scoreJobs', 'getSettings']) assert.equal(api[method], undefined, `the app bridge must not expose the canvas method ${method}`);
    },
  },
  {
    name: 'interview preload: forwards reviewed helper calls on their exact IPC channels',
    run: async () => {
      const { api, invocations } = loadPreloadBridge();
      for (const [method, channel, args] of DIRECT_FORWARDING) {
        const result = await api[method](args);
        assert.equal(result.channel, channel, `${method} must resolve its IPC invocation`);
        assert.deepEqual(result.args, [args], `${method} must forward its renderer args as one payload`);
      }
      assert.deepEqual(invocations.map(({ channel }) => channel), DIRECT_FORWARDING.map(([, channel]) => channel),
        'the reviewed renderer methods must use only their mapped IPC channels');
      return { channels: invocations.length };
    },
  },
  {
    name: 'interview preload: adapts renderer jobUrl to the backend canonicalJobUrl brief contract',
    run: async () => {
      const { api, invocations } = loadPreloadBridge();
      const rendererArgs = {
        nodeId: 'interview-node',
        snapshotId: 'a'.repeat(64),
        jobUrl: 'https://jobs.example.test/roles/123?source=canvas',
        bundleArtifactId: 'b'.repeat(64),
        manualAiRunId: 'manual-run-1',
        canonicalJobUrl: 'https://renderer-must-not-control.example.test/',
        untrustedExtra: 'must not cross the bridge',
      };

      const result = await api.prepareInterviewBrief(rendererArgs);
      assert.equal(result.channel, 'build-interview-brief', 'brief preparation must use the reviewed backend channel');
      assert.deepEqual({ ...result.args[0] }, {
        nodeId: rendererArgs.nodeId,
        snapshotId: rendererArgs.snapshotId,
        canonicalJobUrl: rendererArgs.jobUrl,
        bundleArtifactId: rendererArgs.bundleArtifactId,
        manualAiRunId: rendererArgs.manualAiRunId,
        reuseExisting: false,
      }, 'brief preparation must allowlist its payload and rename jobUrl for the backend contract');
      assert.equal(invocations.length, 1, 'brief preparation must make exactly one IPC request');
      const reused = await api.prepareInterviewBrief({ ...rendererArgs, reuseExisting: true });
      assert.equal(reused.args[0].reuseExisting, true, 'a first Prepare may ask to reuse a finished preparation');
      const truthy = await api.prepareInterviewBrief({ ...rendererArgs, reuseExisting: 'yes' });
      assert.equal(truthy.args[0].reuseExisting, false, 'only the boolean true asks for reuse');
      return { canonicalJobUrl: result.args[0].canonicalJobUrl };
    },
  },
  {
    name: 'interview preload: Q&A calls forward only their reviewed fields, with null defaults and renamed jobUrl',
    run: async () => {
      const { api } = loadPreloadBridge();
      const loaded = await api.loadInterviewQa({ nodeId: 'n' });
      assert.equal(loaded.channel, 'load-interview-qa');
      assert.deepEqual({ ...loaded.args[0] }, { nodeId: 'n', snapshotId: null, canonicalJobUrl: null, bundleArtifactId: null });
      const bound = await api.loadInterviewQa({ nodeId: 'n', snapshotId: 'a'.repeat(64), jobUrl: 'https://jobs.example.test/1', bundleArtifactId: 'b'.repeat(64), extra: 1 });
      assert.deepEqual({ ...bound.args[0] }, { nodeId: 'n', snapshotId: 'a'.repeat(64), canonicalJobUrl: 'https://jobs.example.test/1', bundleArtifactId: 'b'.repeat(64) });
      const added = await api.addInterviewQaTopic({ nodeId: 'n', text: 'Kubernetes', extra: 1 });
      assert.deepEqual([added.channel, { ...added.args[0] }], ['add-interview-qa-topic', { nodeId: 'n', text: 'Kubernetes' }]);
      const deleted = await api.deleteInterviewQaTopic({ nodeId: 'n', topicId: 't1', extra: 1 });
      assert.deepEqual([deleted.channel, { ...deleted.args[0] }], ['delete-interview-qa-topic', { nodeId: 'n', topicId: 't1' }]);
    },
  },
  {
    name: 'interview preload: scopes prepared-brief verification to exact public bindings',
    run: async () => {
      const { api, invocations } = loadPreloadBridge();
      const args = {
        nodeId: 'interview-node', briefRecordId: 'c'.repeat(64), snapshotId: 'a'.repeat(64),
        jobUrl: 'https://jobs.example.test/roles/123', bundleArtifactId: 'b'.repeat(64), bundleArtifactDigest: 'd'.repeat(64),
        brief: { shouldNotCross: true }, untrustedExtra: 'must not cross the bridge',
      };
      const result = await api.loadInterviewPreparedBrief(args);
      assert.equal(result.channel, 'load-interview-prepared-brief', 'prepared-brief verification must use its narrow reviewed IPC route');
      assert.deepEqual({ ...result.args[0] }, {
        nodeId: args.nodeId, briefRecordId: args.briefRecordId, snapshotId: args.snapshotId,
        canonicalJobUrl: args.jobUrl, bundleArtifactId: args.bundleArtifactId, bundleArtifactDigest: args.bundleArtifactDigest,
      }, 'prepared-brief verification must not pass a renderer cache or arbitrary fields to main');
      assert.equal(invocations.length, 1, 'verification must issue exactly one narrow IPC request');
    },
  },
];

export default tests;

async function runDirectly() {
  for (const test of tests) {
    await test.run();
    console.log(`PASS ${test.name}`);
  }
  console.log(`[INTERVIEW PRELOAD TEST] ${tests.length} passed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === testPath) {
  runDirectly().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
