// How one voice cuts into another on the call, as sound: the interrupted voice keeps going for a moment
// under the interrupter and fades out, so the two are heard together the way real overlaps are.
// Shared by the panel voice (one interviewer cutting into another, electron/practiceCall/eleven/panelVoice.js)
// and the engine (an interviewer cutting into the candidate's voice). Pure: 16-bit little-endian mono PCM in, out.

/**
 * A cut-in starts this long before the interrupted voice's SPEECH ends (not its buffer: a synthesised
 * segment ends in near-silence), so the two voices are heard together. Real overlaps are brief, 80% under 1 s.
 */
export const CUT_IN_OVERLAP_MS = 700;
/** The interrupted voice fades out over its last stretch, so it gives way instead of being cut. */
export const CUT_IN_FADE_MS = 120;
/** Speech is judged on 20 ms windows; a window or sample at or above this level is speech. */
export const CUT_IN_LEVEL_WINDOW_MS = 20;
export const CUT_IN_SPEECH_FLOOR = 8;

export const msSamples = (rate, ms) => Math.round((Number(rate) * ms) / 1000);

export const windowRms = (buffer, fromSample, toSample) => {
  let sum = 0;
  for (let i = fromSample; i < toSample; i += 1) { const v = buffer.readInt16LE(i * 2); sum += v * v; }
  return toSample > fromSample ? Math.sqrt(sum / (toSample - fromSample)) : 0;
};

/** Fades the last CUT_IN_FADE_MS of `tail` (whole samples) linearly to silence, in place. Returns `tail`. */
export function fadeOutTail(tail, rate) {
  const samples = tail.length >> 1;
  const fade = Math.min(msSamples(rate, CUT_IN_FADE_MS), samples);
  for (let k = 0; k < fade; k += 1) {
    const at = (samples - fade + k) * 2;
    tail.writeInt16LE(Math.round(tail.readInt16LE(at) * (1 - (k + 1) / fade)), at);
  }
  return tail;
}

/**
 * Sums `head` (the interrupted voice's tail) into the start of `data` (the interrupter's audio), from byte
 * `offset` (0, or 1 when `data` starts with the second half of a sample). Returns the mixed copy and what is
 * left of `head` for the next chunk.
 */
export function mixHeadInto(data, head, offset = 0) {
  const count = Math.max(0, Math.min(head.length, data.length - offset) >> 1);
  if (!count) return { mixed: data, rest: head };
  const mixed = Buffer.from(data);
  for (let i = 0; i < count; i += 1) {
    const sum = mixed.readInt16LE(offset + i * 2) + head.readInt16LE(i * 2);
    mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), offset + i * 2);
  }
  return { mixed, rest: head.subarray(count * 2) };
}

/** The first sample of speech in `buffer` (first 20 ms window at speech level, refined to its first loud sample), or -1. */
export function firstSpeechSample(buffer, rate) {
  const win = Math.max(1, msSamples(rate, CUT_IN_LEVEL_WINDOW_MS));
  const total = buffer.length >> 1;
  for (let lo = 0; lo < total; lo += win) {
    const hi = Math.min(total, lo + win);
    if (windowRms(buffer, lo, hi) < CUT_IN_SPEECH_FLOOR) continue;
    let at = lo;
    while (at < hi && Math.abs(buffer.readInt16LE(at * 2)) < CUT_IN_SPEECH_FLOOR) at += 1;
    return at;
  }
  return -1;
}
