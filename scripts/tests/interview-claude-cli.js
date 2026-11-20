import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../../electron/ipc/claudeApplicationRunner.js';
import { captureCliOutput, createWarmProcess, managedSpawn, requireCliFlags } from '../../electron/interviewClaudeCli.js';

// Synthetic child processes only; no CLI or model request is made by this suite.
function fakeSpawn({ onWrite, onEnd } = {}) {
  const children = [];
  function spawn(binary, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.signals = [];
    children.push({ binary, args, options, child });
    child.kill = signal => { child.signals.push(signal); child.emit('close', 0); };
    child.stdin.end = () => { onEnd?.(child, args); };
    child.stdin.write = (input, callback) => { onWrite?.(child, JSON.parse(input)); callback?.(); };
    return child;
  }
  return { spawn, children };
}
const result = (message, text) => `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'synthetic', user_message_uuid: message.uuid, result: text })}\n`;

export default [
  { name: 'interview Claude CLI: children get the output-token limit and no ANTHROPIC_ or provider-switch variables', async run() {
    const injected = { ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_BASE_URL: 'https://synthetic.invalid', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1' };
    const saved = {};
    for (const [key, value] of Object.entries(injected)) { saved[key] = process.env[key]; process.env[key] = value; }
    const fake = fakeSpawn();
    try {
      const handle = managedSpawn('claude-test', ['--print'], undefined, fake.spawn);
      const { options } = fake.children[0];
      assert.equal(options.shell, false);
      assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_MAX_OUTPUT_TOKENS);
      assert.deepEqual(Object.keys(options.env).filter(key => key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_')), []);
      assert.equal(options.env.CLAUDECODE, undefined);
      assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, undefined);
      await handle.stop();
      assert.deepEqual(fake.children[0].child.signals, ['SIGTERM']);
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  } },
  { name: 'interview Claude CLI: required flags must all be in the help text, and a capture returns stdout only on a clean exit', async run() {
    requireCliFlags('--print --model', ['--print', '--model']);
    assert.throws(() => requireCliFlags('--print', ['--print', '--model']), { code: 'TRANSPORT_CAPABILITY_UNSUPPORTED' });
    const ok = fakeSpawn({ onEnd: child => queueMicrotask(() => { child.stdout.emit('data', 'help text'); child.emit('close', 0); }) });
    assert.equal(await captureCliOutput('claude-test', ['--help'], { spawn: ok.spawn, handles: new Set(), outputLimit: 1000 }), 'help text');
    const failed = fakeSpawn({ onEnd: child => queueMicrotask(() => child.emit('close', 1)) });
    await assert.rejects(captureCliOutput('claude-test', ['--help'], { spawn: failed.spawn, handles: new Set(), outputLimit: 1000 }), { code: 'TRANSPORT_UNAVAILABLE' });
    const noisy = fakeSpawn({ onEnd: child => queueMicrotask(() => child.stdout.emit('data', 'x'.repeat(50))) });
    await assert.rejects(captureCliOutput('claude-test', ['--help'], { spawn: noisy.spawn, handles: new Set(), outputLimit: 10 }), { code: 'TRANSPORT_OUTPUT_LIMIT' });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(captureCliOutput('claude-test', ['--help'], { spawn: ok.spawn, handles: new Set(), outputLimit: 10, signal: abort.signal }), { name: 'AbortError' });
  } },
  { name: 'interview Claude CLI: a warm conversation answers turns in order, split across chunks, and keeps its session id', async run() {
    const writes = [];
    const fake = fakeSpawn({ onWrite: (child, message) => {
      writes.push(message);
      const line = result(message, `answer ${writes.length}`);
      queueMicrotask(() => { child.stdout.emit('data', line.slice(0, 14)); child.stdout.emit('data', line.slice(14)); });
    } });
    const warm = createWarmProcess(managedSpawn('claude-test', [], undefined, fake.spawn), 10_000);
    try {
      const first = await warm.request('one');
      const second = await warm.request('two');
      assert.deepEqual([first.text, second.text], ['answer 1', 'answer 2']);
      assert.equal(writes[0].session_id, undefined); assert.equal(writes[1].session_id, 'synthetic');
      await warm.whenIdle();
    } finally { await warm.close(); }
  } },
  { name: 'interview Claude CLI: cancelling a queued turn never sends it, and a sent turn drains before the next one', async run() {
    const writes = []; const replies = [];
    const fake = fakeSpawn({ onWrite: (child, message) => { writes.push(message); replies.push(() => child.stdout.emit('data', result(message, `answer ${writes.length}`))); } });
    const warm = createWarmProcess(managedSpawn('claude-test', [], undefined, fake.spawn), 10_000);
    try {
      const abortQueued = new AbortController();
      const first = warm.request('first');
      const queued = warm.request('queued', abortQueued.signal);
      abortQueued.abort();
      await assert.rejects(queued, { name: 'AbortError' });
      assert.equal(writes.length, 1, 'the cancelled queued turn was never sent');
      replies.shift()();
      assert.equal((await first).text, 'answer 1');
      const abortSent = new AbortController();
      const sent = warm.request('sent', abortSent.signal);
      const next = warm.request('next');
      abortSent.abort();
      await assert.rejects(sent, { name: 'AbortError' });
      assert.equal(writes.length, 2, 'the next turn waits for the aborted one to drain');
      replies.shift()();
      await Promise.resolve();
      assert.equal(writes.length, 3);
      replies.shift()();
      assert.equal((await next).text, 'answer 3');
    } finally { await warm.close(); }
  } },
  { name: 'interview Claude CLI: tool use, malformed output and over-limit output fail the conversation with a fixed code', async run() {
    const cases = [
      [`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } })}\n`, 'TRANSPORT_TOOL_USE'],
      ['not json\n', 'TRANSPORT_INVALID_RESPONSE'],
      ['x'.repeat(200), 'TRANSPORT_OUTPUT_LIMIT'],
    ];
    for (const [output, code] of cases) {
      const fake = fakeSpawn({ onWrite: child => queueMicrotask(() => child.stdout.emit('data', output)) });
      const warm = createWarmProcess(managedSpawn('claude-test', [], undefined, fake.spawn), 100);
      await assert.rejects(warm.request('go'), { code });
      await assert.rejects(warm.request('again'), { code: 'TRANSPORT_UNAVAILABLE' });
      await warm.close();
    }
  } },
];
