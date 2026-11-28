// Interviewer track rebuilt from what the engine sent and what the helper
// reported. Each utterance keeps its own PCM; events place the played spans on
// the helper timeline. File I/O only happens in finalize.
import { HEADER_BYTES, TWO_POW_15, wavHeader } from './wavFormat.js';
import { pcm16ToFloat } from './resample.js';

const SILENCE = 0;

function toSamples(pcm16le) {
  if (pcm16le instanceof Int16Array) return Float32Array.from(pcm16le, value => value / TWO_POW_15);
  if (typeof pcm16le === 'string') throw new Error('trackWriter: pcm16le must be bytes, not a string');
  let bytes = pcm16le;
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!bytes || typeof bytes.length !== 'number') throw new Error('trackWriter: pcm16le must be a byte buffer');
  return pcm16ToFloat(bytes);
}

const msToFrames = (ms, rate) => Math.round((ms * rate) / 1000);

export function writePcm16Wav(filePath, samples, sampleRate, { fs }) {
  const fd = fs.openSync(filePath, 'w');
  try {
    const frames = samples.length;
    fs.writeSync(fd, wavHeader(frames * 2, sampleRate), 0, HEADER_BYTES, 0);
    const blockFrames = sampleRate;
    let position = HEADER_BYTES;
    for (let start = 0; start < frames; start += blockFrames) {
      const count = Math.min(blockFrames, frames - start);
      const chunk = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[start + i]));
        chunk.writeInt16LE(Math.round(value * 32767), i * 2);
      }
      fs.writeSync(fd, chunk, 0, chunk.length, position);
      position += chunk.length;
    }
  } finally { fs.closeSync(fd); }
}

export function createInterviewerTrack({ sampleRate = 24000 } = {}) {
  if (!(sampleRate > 0)) throw new Error('trackWriter: sampleRate must be positive');
  const utterances = new Map();

  const utteranceOf = id => {
    const utterance = utterances.get(id);
    if (!utterance) throw new Error(`trackWriter: unknown utterance ${String(id)}`);
    return utterance;
  };
  const closeSegment = (utterance, audioEndMs) => {
    const open = utterance.open;
    if (!open) return;
    utterance.segments.push({ wallStartMs: open.wallStartMs, audioStartMs: open.audioStartMs, audioEndMs: Math.max(open.audioStartMs, audioEndMs) });
    utterance.open = null;
  };

  return {
    addUtterance(id, pcm16le, rate) {
      if (!(rate > 0)) throw new Error('trackWriter: utterance sampleRate must be positive');
      const samples = toSamples(pcm16le);
      const durationMs = (samples.length * 1000) / rate;
      const existing = utterances.get(id);
      utterances.set(id, { samples, base: samples, parts: [], byteLength: 0, sampleRate: rate, durationMs, segments: existing?.segments ?? [], open: existing?.open ?? null });
    },
    // Adds bytes to the end of an utterance without converting anything: the chunks are joined and
    // converted once, when the audio is rendered. Only the duration is kept current, from the byte count.
    appendUtterance(id, pcm16le, rate) {
      if (!(rate > 0)) throw new Error('trackWriter: utterance sampleRate must be positive');
      if (typeof pcm16le === 'string') throw new Error('trackWriter: pcm16le must be bytes, not a string');
      let bytes = pcm16le instanceof ArrayBuffer ? new Uint8Array(pcm16le) : pcm16le;
      if (!bytes || typeof bytes.length !== 'number') throw new Error('trackWriter: pcm16le must be a byte buffer');
      if (bytes instanceof Int16Array) bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
      let utterance = utterances.get(id);
      if (!utterance) {
        utterance = { samples: null, base: null, parts: [], byteLength: 0, sampleRate: rate, durationMs: 0, segments: [], open: null };
        utterances.set(id, utterance);
      }
      utterance.parts.push(Buffer.from(buffer));
      utterance.byteLength += buffer.length;
      utterance.samples = null;
      utterance.sampleRate = rate;
      utterance.durationMs = (((utterance.base?.length ?? 0) + (utterance.byteLength >> 1)) * 1000) / rate;
    },
    started(id, atMs) {
      const utterance = utteranceOf(id);
      if (utterance.open) closeSegment(utterance, utterance.durationMs);
      utterance.open = { wallStartMs: Math.max(0, atMs ?? 0), audioStartMs: 0 };
    },
    paused(id, positionMs, atMs) {
      const utterance = utteranceOf(id);
      if (!utterance.open) throw new Error('trackWriter: paused before started');
      const position = Math.min(utterance.durationMs, Math.max(utterance.open.audioStartMs, positionMs ?? 0));
      closeSegment(utterance, position);
      utterance.resume = { positionMs: position, atMs: Math.max(0, atMs ?? 0) };
    },
    resumed(id, atMs) {
      const utterance = utteranceOf(id);
      const resume = utterance.resume ?? { positionMs: utterance.segments.at(-1)?.audioEndMs ?? 0, atMs: 0 };
      utterance.resume = null;
      utterance.open = { wallStartMs: Math.max(0, atMs ?? resume.atMs), audioStartMs: resume.positionMs };
    },
    ended(id, positionMs, atMs) {
      const utterance = utteranceOf(id);
      if (!utterance.open) return;
      const position = Math.min(utterance.durationMs, Math.max(utterance.open.audioStartMs, positionMs ?? utterance.durationMs));
      closeSegment(utterance, position);
      utterance.endedAtMs = Math.max(0, atMs ?? 0);
    },
    segments(id) {
      const utterance = utteranceOf(id);
      return utterance.segments.map(segment => ({ ...segment }));
    },
    finalize(path, { durationMs, fs } = {}) {
      if (!fs) throw new Error('trackWriter: finalize requires fs');
      const duration = Math.max(0, Math.round(durationMs ?? 0));
      const frames = msToFrames(duration, sampleRate);
      const mix = new Float32Array(frames);
      for (const utterance of utterances.values()) {
        if (utterance.open) closeSegment(utterance, utterance.durationMs);
        for (const segment of utterance.segments) renderSegment(mix, utterance, segment, sampleRate);
      }
      writePcm16Wav(path, mix, sampleRate, { fs });
      return { durationMs: duration, sampleRate, frames, silence: SILENCE };
    },
  };
}

// The utterance's samples, converted once from its appended chunks.
function samplesOf(utterance) {
  if (!utterance.samples) {
    const joined = Buffer.concat(utterance.parts ?? []);
    const tail = pcm16ToFloat(joined);
    const base = utterance.base;
    if (base && base.length) { const all = new Float32Array(base.length + tail.length); all.set(base); all.set(tail, base.length); utterance.samples = all; }
    else utterance.samples = tail;
    // The joined bytes stand in for the chunks, so later bytes continue after them.
    utterance.parts = [joined];
  }
  return utterance.samples;
}

// Place one played span of one utterance into the output timeline, summing.
function renderSegment(mix, utterance, segment, targetRate) {
  const { sampleRate: sourceRate } = utterance;
  const samples = samplesOf(utterance);
  const startSource = (segment.audioStartMs * sourceRate) / 1000;
  const spanSource = ((segment.audioEndMs - segment.audioStartMs) * sourceRate) / 1000;
  const spanTarget = Math.round((spanSource * targetRate) / sourceRate);
  const targetStart = msToFrames(segment.wallStartMs, targetRate);
  const step = sourceRate / targetRate;
  for (let k = 0; k < spanTarget; k += 1) {
    const out = targetStart + k;
    if (out < 0 || out >= mix.length) continue;
    const position = startSource + k * step;
    const index = Math.floor(position);
    if (index >= samples.length) break;
    const next = Math.min(index + 1, samples.length - 1);
    const fraction = position - index;
    mix[out] += samples[index] * (1 - fraction) + samples[next] * fraction;
  }
}

export default createInterviewerTrack;
