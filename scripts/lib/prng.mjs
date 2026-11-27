// mulberry32: a tiny deterministic 32-bit PRNG returning values in [0, 1). Shared by the
// simulation, the benchmark and the probes so a seed means the same stream everywhere.
export function mulberry32(seed) {
  let state = (Number(seed) || 0) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
