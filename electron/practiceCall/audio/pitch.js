// YIN pitch tracking (De Cheveigné & Kawahara 2002).
// Frames of 40 ms, hop 10 ms; 0 means unvoiced. Pure: no I/O, no state.
const FRAME_MS = 40;
const UNVOICED_DBFS = -45;
const ABSOLUTE_THRESHOLD = 0.15;

const dbfsToAmplitude = db => 10 ** (db / 20);

function frameRms(samples, start, length) {
  let sum = 0;
  const end = Math.min(samples.length, start + length);
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  const count = Math.max(1, end - start);
  return Math.sqrt(sum / count);
}

// Fills `d` (reused across frames) for tau in [tauMin, tauMax]; entries below tauMin are never written and stay 0.
function differenceFunction(d, samples, start, windowSamples, tauMin, tauMax) {
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    let sum = 0;
    for (let j = 0; j < windowSamples; j += 1) {
      const delta = samples[start + j] - samples[start + j + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  return d;
}

function cumulativeMeanNormalised(cmnd, d, tauMax) {
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    running += d[tau] ?? 0;
    cmnd[tau] = running > 0 ? (d[tau] ?? 0) * tau / running : 1;
  }
}

function pickPeriod(cmnd, tauMin, tauMax) {
  for (let tau = tauMin; tau < tauMax; tau += 1) {
    if (cmnd[tau] >= ABSOLUTE_THRESHOLD) continue;
    let best = tau;
    while (best + 1 <= tauMax && cmnd[best + 1] < cmnd[best]) best += 1;
    return { tau: best, value: cmnd[best] };
  }
  return null;
}

function parabolicPeriod(cmnd, tau) {
  const left = tau > 0 ? cmnd[tau - 1] : cmnd[tau];
  const right = tau + 1 < cmnd.length ? cmnd[tau + 1] : cmnd[tau];
  const denom = left - 2 * cmnd[tau] + right;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return tau;
  return tau + (0.5 * (left - right)) / denom;
}

function pitchTracker(samples, sampleRate, { hopMs = 10, minHz = 60, maxHz = 400 } = {}) {
  if (!(sampleRate > 0)) throw new Error('trackPitch: sampleRate must be positive');
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const windowSamples = Math.max(4, Math.round((sampleRate * FRAME_MS) / 1000));
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.max(tauMin + 2, Math.ceil(sampleRate / minHz));
  const frameLength = windowSamples + tauMax;
  const total = samples?.length ?? 0;
  const frameCount = total === 0 ? 0 : total <= frameLength ? 1 : 1 + Math.floor((total - frameLength) / hop);
  const f0 = new Float32Array(frameCount);
  const floorAmplitude = dbfsToAmplitude(UNVOICED_DBFS);
  const d = new Float64Array(tauMax + 1);
  const cmnd = new Float64Array(tauMax + 1);

  function track(frame) {
    const start = frame * hop;
    if (frameRms(samples, start, windowSamples) < floorAmplitude) { f0[frame] = 0; return; }
    differenceFunction(d, samples, start, windowSamples, tauMin, tauMax);
    cumulativeMeanNormalised(cmnd, d, tauMax);
    const found = pickPeriod(cmnd, tauMin, tauMax);
    if (!found) { f0[frame] = 0; return; }
    const period = parabolicPeriod(cmnd, found.tau);
    const hz = period > 0 ? sampleRate / period : 0;
    f0[frame] = hz >= minHz && hz <= maxHz ? Math.round(hz * 100) / 100 : 0;
  }
  return { frameCount, track, result: () => ({ hopMs, f0 }) };
}

export function trackPitch(samples, sampleRate, options = {}) {
  const tracker = pitchTracker(samples, sampleRate, options);
  for (let frame = 0; frame < tracker.frameCount; frame += 1) tracker.track(frame);
  return tracker.result();
}

const yieldToEventLoop = () => new Promise(resolve => { setImmediate(resolve); });

/**
 * The same result as trackPitch, computed in slices of about `sliceMs` with the event loop
 * free in between. A long answer takes most of a second to track, which on the main
 * process would stall the live call's audio and IPC.
 */
export async function trackPitchAsync(samples, sampleRate, options = {}, { sliceMs = 8 } = {}) {
  const tracker = pitchTracker(samples, sampleRate, options);
  let sliceStart = performance.now();
  for (let frame = 0; frame < tracker.frameCount; frame += 1) {
    tracker.track(frame);
    if (performance.now() - sliceStart >= sliceMs) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }
  return tracker.result();
}

export default trackPitch;
