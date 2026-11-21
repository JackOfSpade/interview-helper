// Sample-rate conversion for the ear. Pure: no I/O.
// The synthetic voice arrives as 16-bit PCM at 24 kHz or 44.1 kHz, while the prosody and tone
// models work on 16 kHz floats like the microphone track, so a line is converted before it is measured.
import { TWO_POW_15 } from './wavFormat.js';

export const EAR_SAMPLE_RATE = 16000;

/** 16-bit little-endian mono PCM bytes as floats in [-1, 1). A trailing odd byte is ignored. */
export function pcm16ToFloat(pcm) {
  if (!pcm || typeof pcm.length !== 'number') return new Float32Array(0);
  const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer ?? pcm, pcm.byteOffset ?? 0, pcm.byteLength ?? pcm.length);
  const frames = bytes.length >> 1;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = bytes.readInt16LE(i * 2) / TWO_POW_15;
  return out;
}

/**
 * Floats at `fromRate` to floats at `toRate`. Each output sample is the area average of the input
 * over its own span (fractional edges weighted), which low-passes before decimating so the
 * pitch tracker does not see aliased energy. Upsampling falls back to linear interpolation.
 */
export function resample(samples, fromRate, toRate = EAR_SAMPLE_RATE) {
  if (!samples || !samples.length) return new Float32Array(0);
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('Sample rates must be positive.');
  if (fromRate === toRate) return Float32Array.from(samples);
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  if (ratio <= 1) {
    for (let i = 0; i < outLength; i += 1) {
      const position = i * ratio;
      const index = Math.floor(position);
      const next = Math.min(samples.length - 1, index + 1);
      const fraction = position - index;
      out[i] = samples[index] * (1 - fraction) + samples[next] * fraction;
    }
    return out;
  }
  for (let i = 0; i < outLength; i += 1) {
    const start = i * ratio;
    const end = start + ratio;
    let sum = 0;
    let index = Math.floor(start);
    while (index < end && index < samples.length) {
      const weight = Math.min(index + 1, end) - Math.max(index, start);
      sum += samples[index] * weight;
      index += 1;
    }
    out[i] = sum / ratio;
  }
  return out;
}

/** PCM16 bytes at `sampleRate` straight to 16 kHz floats. */
export function pcm16To16k(pcm, sampleRate) {
  return resample(pcm16ToFloat(pcm), sampleRate, EAR_SAMPLE_RATE);
}

export default pcm16To16k;
