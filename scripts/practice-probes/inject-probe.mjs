#!/usr/bin/env node
// End-to-end probe of the practice audio helper's "inject" commands (candidate AI voice mixed into the
// microphone signal). Real helper, real NDJSON protocol. Needs macOS 26, `say` and `afconvert`.
// Usage: node scripts/practice-probes/inject-probe.mjs <helper-binary> [--out DIR]
// Nothing is logged except counts, timings and the words of the synthetic test sentence (no real audio).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const helperPath = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : '/private/tmp/claude-501/inject-probe';
if (!helperPath) { console.error('usage: inject-probe.mjs <helper> [--out DIR]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const TEXT_A = 'Thank you for having me today. I have spent six years building data pipelines for retail companies.';
const TEXT_B = 'My biggest achievement was cutting our nightly batch time from four hours to forty minutes.';
const SENTENCE = `${TEXT_A} [[slnc 2200]] ${TEXT_B}`;
const PLAY_TEXT = 'Great, tell me more about that.';

function say(text, name, rate) {
  const aiff = path.join(OUT, `${name}.aiff`), wav = path.join(OUT, `${name}.wav`);
  spawnSync('say', ['-o', aiff, text]);
  spawnSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${rate}`, '-c', '1', aiff, wav]);
  return readWav(wav);
}
function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, rate = 0, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4); let size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(p + 12);
    if (id === 'data') { if (p + 8 + size > b.length) size = b.length - p - 8; data = b.subarray(p + 8, p + 8 + size); break; }
    p += 8 + size + (size & 1);
  }
  const n = data.length >> 1, s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  return { rate, samples: s, pcm: Buffer.from(data) };
}
// energy segments: rms over 20 ms windows > thr, gaps < minGapMs merged
function segments(w, thr, minGapMs = 400) {
  const win = Math.round(w.rate * 0.02), segs = []; let cur = null, quiet = 0;
  for (let i = 0; i + win <= w.samples.length; i += win) {
    let e = 0; for (let j = 0; j < win; j++) e += w.samples[i + j] ** 2;
    const rms = Math.sqrt(e / win), t = Math.round(i / w.rate * 1000);
    if (rms > thr) { if (!cur) { cur = { start: t, end: t + 20 }; segs.push(cur); } cur.end = t + 20; quiet = 0; }
    else if (cur) { quiet += 20; if (quiet >= minGapMs) cur = null; }
  }
  return segs;
}
const rmsRange = (w, a, b) => { const s = Math.floor(a * w.rate / 1000), e = Math.min(w.samples.length, Math.floor(b * w.rate / 1000)); let x = 0; for (let i = s; i < e; i++) x += w.samples[i] ** 2; return e > s ? Math.sqrt(x / (e - s)) : 0; };
const peak = (w) => { let m = 0; for (const v of w.samples) m = Math.max(m, Math.abs(v)); return m; };

async function run(name, { cancelAfterMs, play }) {
  const rec = path.join(OUT, `${name}.wav`.replace('.wav', '-rec.wav'));
  try { fs.unlinkSync(rec); } catch { /* no recording left from an earlier run */ }
  const ev = [], t0 = Date.now(); let stderr = '';
  const child = spawn(helperPath, ['--parent-pid', String(process.pid), '--locale', 'en-US', '--recording', rec], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { stderr += d; });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { ev.push({ ...JSON.parse(l), wall: Date.now() - t0 }); } catch { ev.push({ type: 'unparsed', len: l.length, wall: Date.now() - t0 }); } } });
  let exit = null; child.on('exit', (c, s) => { exit = { code: c, signal: s }; });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; };

  await waitFor(() => ev.some((e) => e.type === 'status' && e.state === 'ready') || ev.some((e) => e.type === 'error') || exit, 30000);
  const readyEv = ev.find((e) => e.type === 'status' && e.state === 'ready');
  if (!readyEv) return { name, failed: 'no ready', ev, stderr, exit };
  await sleep(1000); // let the noise floor settle
  const A = A_WAV;
  send({ type: 'inject', utteranceId: 'line1', sampleRate: 24000 });
  const sendStart = Date.now();
  // real-time-ish: 200 ms chunks
  const chunk = 24000 * 2 / 5;
  let cancelSent = null;
  const feed = (async () => {
    for (let o = 0; o < A.pcm.length; o += chunk) {
      if (cancelAfterMs != null && Date.now() - sendStart > cancelAfterMs) return;
      send({ type: 'inject-audio', utteranceId: 'line1', pcm: A.pcm.subarray(o, Math.min(o + chunk, A.pcm.length)).toString('base64') });
      await sleep(200);
    }
    send({ type: 'inject-end', utteranceId: 'line1' });
  })();
  if (cancelAfterMs != null) { await sleep(cancelAfterMs); cancelSent = Date.now() - t0; send({ type: 'inject-cancel', utteranceId: 'line1', fadeMs: 60 }); }
  if (play) {
    await sleep(2500);
    send({ type: 'play', utteranceId: 'int1', sampleRate: 24000 });
    for (let o = 0; o < P_WAV.pcm.length; o += 96000) send({ type: 'audio', utteranceId: 'int1', pcm: P_WAV.pcm.subarray(o, o + 96000).toString('base64') });
    send({ type: 'end', utteranceId: 'int1' });
  }
  await feed;
  const dur = A.samples.length / A.rate * 1000;
  await waitFor(() => ev.some((e) => e.type === 'inject' && (e.state === 'finished' || e.state === 'cancelled')), 30000);
  await sleep(cancelAfterMs != null ? 2500 : 4000 + (play ? 1500 : 0));
  send({ type: 'stop' });
  await waitFor(() => exit, 8000);
  if (!exit) child.kill('SIGKILL');
  return { name, ev, stderr, exit, cancelSent, rec, durMs: dur, ready: readyEv };
}

const A_WAV = say(SENTENCE, 'line-a', 24000);
const P_WAV = say(PLAY_TEXT, 'line-play', 24000);
const R = {};
const summarize = (r) => {
  const inj = r.ev.filter((e) => e.type === 'inject');
  const started = inj.find((e) => e.state === 'started'), fin = inj.find((e) => e.state === 'finished'), canc = inj.find((e) => e.state === 'cancelled');
  const pos = inj.filter((e) => e.state === 'position');
  const vad = r.ev.filter((e) => e.type === 'vad').map((e) => `${e.speaking ? 'ON' : 'off'}@${e.atMs}`);
  const tr = r.ev.filter((e) => e.type === 'transcript');
  const finals = tr.filter((e) => e.final).map((e) => `[${e.startMs}-${e.endMs}] ${e.text}`);
  const partials = tr.filter((e) => !e.final).length;
  const pb = r.ev.filter((e) => e.type === 'playback').map((e) => `${e.state}@${e.atMs}/${e.positionMs}`);
  const recEv = r.ev.find((e) => e.type === 'recording');
  const errs = r.ev.filter((e) => e.type === 'error');
  const gaps = pos.slice(1).map((e, i) => e.atMs - pos[i].atMs);
  const out = { run: r.name, readyEv: r.ready, started, finished: fin, cancelled: canc, expectedAudioMs: Math.round(r.durMs), positionEvents: pos.length,
    positionGapMs: gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps), mean: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) } : null,
    positionMonotonic: pos.every((e, i) => i === 0 || e.positionMs >= pos[i - 1].positionMs), vad, finals, partialCount: partials, playback: pb, recording: recEv, errors: errs, exit: r.exit, stderrBytes: r.stderr.length, stderrHead: r.stderr.slice(0, 600) };
  if (r.rec && fs.existsSync(r.rec)) {
    const w = readWav(r.rec), b = fs.readFileSync(r.rec);
    out.wav = { rate: w.rate, channels: b.readUInt16LE(22), bits: b.readUInt16LE(34), ms: Math.round(w.samples.length / w.rate * 1000), peak: +peak(w).toFixed(3), segs: segments(w, 0.01) };
    const src = segments(A_WAV, 0.01);
    out.srcSegs = src;
    out.srcRmsSpeech = +rmsRange(A_WAV, src[0]?.start ?? 0, src[0]?.end ?? 1).toFixed(4);
    if (started && out.wav.segs.length) { out.wavFirstSegMinusStartedAt = out.wav.segs[0].start - started.atMs; }
    if (canc) { out.wavEnergyAfterCancel = { lastSegEnd: out.wav.segs.at(-1)?.end, cancelAtMs: canc.atMs, rmsAfter150ms: +rmsRange(w, canc.atMs + 150, canc.atMs + 1500).toFixed(5), rmsBefore: +rmsRange(w, canc.atMs - 300, canc.atMs).toFixed(4) }; }
  }
  return out;
};
const r1 = await run('run1-full-with-play', { play: true });
fs.writeFileSync(path.join(OUT, 'run1-events.json'), JSON.stringify(r1.ev));
const r2 = await run('run2-cancel', { cancelAfterMs: 3000 });
fs.writeFileSync(path.join(OUT, 'run2-events.json'), JSON.stringify(r2.ev));
for (const r of [r1, r2]) { if (r.failed) console.log(JSON.stringify({ run: r.name, failed: r.failed, stderr: r.stderr, exit: r.exit })); else console.log(JSON.stringify(summarize(r), null, 1)); }
console.log('mic-permission-hint: stderr/events above show whether the helper ran with the real or the silent microphone');
