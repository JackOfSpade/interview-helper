// 16-bit mono PCM helpers shared by the live probes.

/** Resamples little-endian 16-bit PCM in a Buffer to `toRate` by linear interpolation; the same rate returns the samples unchanged. */
export function resamplePcm16(pcm, fromRate, toRate) {
  const input = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let index = 0; index < out.length; index += 1) {
    const position = index * ratio;
    const before = Math.floor(position);
    const after = Math.min(input.length - 1, before + 1);
    out[index] = Math.round(input[before] + (input[after] - input[before]) * (position - before));
  }
  return out;
}
