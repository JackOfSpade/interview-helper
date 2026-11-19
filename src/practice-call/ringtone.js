// Call sounds, synthesised with Web Audio (no audio files). Every function is
// safe to call in a renderer without Web Audio and never throws.

// One decaying sine partial.
function partial(context, out, at, hertz, seconds, peak) {
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(hertz, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    oscillator.connect(gain);
    gain.connect(out);
    oscillator.start(at);
    oscillator.stop(at + seconds + 0.02);
  } catch { /* a closed context stays silent */ }
}

// Repeats `ring(context, out, now)` every intervalMs until the returned stop function is called.
function startLoop(win, intervalMs, ring) {
  const AudioContextClass = win?.AudioContext || win?.webkitAudioContext;
  if (typeof AudioContextClass !== 'function') return () => {};
  let context;
  try { context = new AudioContextClass(); } catch { return () => {}; }
  try { Promise.resolve(context.resume?.()).catch(() => {}); } catch { /* autoplay policy: the ring stays silent */ }
  // A compressor keeps the stacked notes loud without clipping; without one the notes go straight out.
  let out = context.destination;
  try {
    if (typeof context.createDynamicsCompressor === 'function') {
      const compressor = context.createDynamicsCompressor();
      compressor.connect(context.destination);
      out = compressor;
    }
  } catch { out = context.destination; }
  let stopped = false;
  const play = () => { if (!stopped) ring(context, out, context.currentTime + 0.05); };
  play();
  const timer = setInterval(play, intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try { context.close(); } catch { /* already closed */ }
  };
}

// The rising chime of the incoming ring: C5 E5 G5 C6.
export const RING_NOTES = Object.freeze([523.25, 659.25, 783.99, 1046.5]);
const RING_NOTE_GAP = 0.16;
const RING_REPEAT_AFTER = 1.1;

// Incoming-call ring: a bright rising four-note chime played twice, then a
// pause, the way a video-call app rings. Each note is a bell: the note plus two
// quieter, shorter overtones. Returns a stop function.
export function startRingtone(win, { intervalMs = 3200 } = {}) {
  return startLoop(win, intervalMs, (context, out, now) => {
    for (const start of [0, RING_REPEAT_AFTER]) {
      RING_NOTES.forEach((hertz, index) => {
        const at = now + start + index * RING_NOTE_GAP;
        partial(context, out, at, hertz, 0.55, 0.4);
        partial(context, out, at, hertz * 2, 0.33, 0.12);
        partial(context, out, at, hertz * 3, 0.165, 0.048);
      });
    }
  });
}

// One steady sine tone with short fades at both ends, so it starts and stops without a click.
function steady(context, out, at, hertz, seconds, level) {
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(hertz, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.03);
    gain.gain.setValueAtTime(level, at + seconds - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    oscillator.connect(gain);
    gain.connect(out);
    oscillator.start(at);
    oscillator.stop(at + seconds + 0.02);
  } catch { /* a closed context stays silent */ }
}

// The tone a caller hears while the other phone rings, as the North American phone network
// plays it (the Precise Tone Plan's audible ringing): 440 Hz and 480 Hz together, two seconds
// on and four seconds off.
export const RINGBACK_HERTZ = Object.freeze([440, 480]);
export const RINGBACK_ON_SECONDS = 2;
export const RINGBACK_CYCLE_MS = 6000;

// Outgoing-call tone, played until the returned stop function is called.
export function startRingback(win) {
  return startLoop(win, RINGBACK_CYCLE_MS, (context, out, now) => {
    for (const hertz of RINGBACK_HERTZ) steady(context, out, now, hertz, RINGBACK_ON_SECONDS, 0.11);
  });
}

// Soft two-note chime for a colleague joining the call. Never throws: a
// window without audio (or a blocked context) just stays silent.
export function playJoinChime(win) {
  try {
    const AudioContextClass = win?.AudioContext || win?.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') return;
    const context = new AudioContextClass();
    try { Promise.resolve(context.resume?.()).catch(() => {}); } catch { /* autoplay policy: the chime stays silent */ }
    const now = context.currentTime;
    [[660, 0], [880, 0.14]].forEach(([hertz, offset]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = now + offset;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(hertz, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.32);
    });
    setTimeout(() => { try { context.close(); } catch { /* already closed */ } }, 800);
  } catch { /* no audio available */ }
}
