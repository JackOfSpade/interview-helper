import assert from 'node:assert/strict';
import { createMicrophoneAccess, MICROPHONE_SETTINGS_URL } from '../../electron/practiceCall/microphoneAccess.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call microphone access: ${name}`, run });

function harness({ status = 'not-determined', answer = true, bundleIds = ['com.example.app'], platform = 'darwin' } = {}) {
  const log = [];
  const state = { status };
  const systemPreferences = {
    getMediaAccessStatus(kind) { assert.equal(kind, 'microphone'); return state.status; },
    async askForMediaAccess(kind) { assert.equal(kind, 'microphone'); log.push(['ask', state.status]); return answer; },
  };
  const execFile = (file, args, options, done) => { log.push(['exec', file, ...args]); state.status = 'not-determined'; done(null); };
  const shell = { async openExternal(url) { log.push(['open', url]); } };
  return { log, access: createMicrophoneAccess({ systemPreferences, shell, execFile, platform, bundleIds }) };
}

test('access already granted asks nothing and resets nothing', async () => {
  const h = harness({ status: 'granted' });
  assert.equal(await h.access.ensure(), 'granted');
  assert.deepEqual(h.log, []);
});

test('an unanswered permission shows the macOS prompt without a reset', async () => {
  const h = harness({ status: 'not-determined' });
  assert.equal(await h.access.ensure(), 'granted');
  assert.deepEqual(h.log, [['ask', 'not-determined']]);
});

test('an earlier denial is cleared for the given bundles, then the prompt is shown again', async () => {
  const h = harness({ status: 'denied', bundleIds: ['com.example.app', 'com.example.helper', 'bad id; rm'] });
  assert.equal(await h.access.ensure(), 'granted');
  assert.deepEqual(h.log, [
    ['exec', '/usr/bin/tccutil', 'reset', 'Microphone', 'com.example.app'],
    ['exec', '/usr/bin/tccutil', 'reset', 'Microphone', 'com.example.helper'],
    ['ask', 'not-determined'],
  ]);
});

test('a refusal is reported as denied, and a restricted Mac is never asked', async () => {
  assert.equal(await harness({ status: 'not-determined', answer: false }).access.ensure(), 'denied');
  const restricted = harness({ status: 'restricted' });
  assert.equal(await restricted.access.ensure(), 'restricted');
  assert.deepEqual(restricted.log, []);
});

test('two callers share one prompt', async () => {
  const h = harness({ status: 'not-determined' });
  assert.deepEqual(await Promise.all([h.access.ensure(), h.access.ensure()]), ['granted', 'granted']);
  assert.equal(h.log.length, 1);
});

test('with no dependencies or off macOS nothing is asked or opened', async () => {
  const bare = createMicrophoneAccess();
  assert.equal(await bare.ensure(), 'unknown');
  assert.equal(await bare.openSettings(), false);
  const other = harness({ platform: 'win32' });
  assert.equal(await other.access.ensure(), 'unknown');
  assert.equal(await other.access.openSettings(), false);
  assert.deepEqual(other.log, []);
});

test('open settings goes to the Microphone privacy page', async () => {
  const h = harness();
  assert.equal(await h.access.openSettings(), true);
  assert.deepEqual(h.log, [['open', MICROPHONE_SETTINGS_URL]]);
});

export default cases;
