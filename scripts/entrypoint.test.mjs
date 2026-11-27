import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './lib/entrypoint.mjs';
import { mulberry32 } from './lib/prng.mjs';
import { resamplePcm16 } from './lib/pcm.mjs';

test('isMainModule matches the started script, also through a symlink, and is false without one', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
  try {
    const real = path.join(directory, 'real.mjs');
    const link = path.join(directory, 'link.mjs');
    fs.writeFileSync(real, '');
    fs.symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    assert.equal(isMainModule(url, real), true);
    assert.equal(isMainModule(url, link), true);
    assert.equal(isMainModule(url, path.join(directory, 'other.mjs')), false);
    assert.equal(isMainModule(url, ''), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('mulberry32 is deterministic per seed and stays in [0, 1)', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let index = 0; index < 50; index += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
  assert.notEqual(mulberry32(7)(), mulberry32(8)());
});

test('resamplePcm16 keeps the rate or interpolates to the requested one', () => {
  const pcm = Buffer.from(new Int16Array([0, 100, 200, 300]).buffer);
  assert.deepEqual([...resamplePcm16(pcm, 24000, 24000)], [0, 100, 200, 300]);
  assert.equal(resamplePcm16(pcm, 48000, 24000).length, 2);
  assert.equal(resamplePcm16(Buffer.from([1, 2, 3]), 24000, 24000).length, 1);
});
