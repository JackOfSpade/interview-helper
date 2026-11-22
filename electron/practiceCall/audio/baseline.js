// Candidate voice baseline: median prosody over the user's own turns.
// Pure: accumulates numbers, never touches the filesystem.
const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteOrNull(value) { return Number.isFinite(value) ? value : null; }

// "Long pauses" are gaps a listener notices (a breath between phrases is 300 to 500 ms), counted per minute of speech
// so a long answer is not "pausing more" just for being long. Short stretches count as this long, so one pause in a
// few seconds of speech does not read as a high rate.
export const LONG_PAUSE_MS = 700;
const PAUSE_RATE_MIN_SPAN_MS = 15000;
export function longPauseCount(prosody) {
  return Array.isArray(prosody?.pauses)
    ? prosody.pauses.filter(pause => Number(pause?.endMs) - Number(pause?.startMs) >= LONG_PAUSE_MS).length
    : finiteOrNull(prosody?.longPauseCount) ?? finiteOrNull(prosody?.pauseCount); // without the pauses, every one counts
}
// One long pause is a breath or a thought, not a habit: a turn needs at least this many before it can read as pausing more.
export const MIN_LONG_PAUSES_FOR_RATIO = 2;
export function longPausesPerMinute(prosody) {
  const speechMs = finiteOrNull(prosody?.speechMs) ?? 0;
  const count = longPauseCount(prosody);
  if (count === null) return null;
  return (count / Math.max(speechMs, PAUSE_RATE_MIN_SPAN_MS)) * 60000;
}

export function createVoiceBaseline({ minSpeechMs = 20000 } = {}) {
  const speech = [];
  const tones = [];
  let sampledSpeechMs = 0;

  const medians = () => ({
    turns: speech.length,
    speechMs: median(speech.map(turn => turn.speechMs)),
    wordsPerMinute: median(speech.map(turn => turn.wordsPerMinute)),
    pauseCount: median(speech.map(turn => turn.pauseCount)),
    longestPauseMs: median(speech.map(turn => turn.longestPauseMs)),
    longPausesPerMinute: median(speech.map(turn => turn.longPausesPerMinute)),
    pitchMedianHz: median(speech.map(turn => turn.pitchMedianHz)),
    pitchRangeSt: median(speech.map(turn => turn.pitchRangeSt)),
    loudnessDb: median(speech.map(turn => turn.loudnessDb)),
    arousal: median(tones.map(tone => tone.arousal)),
    dominance: median(tones.map(tone => tone.dominance)),
    valence: median(tones.map(tone => tone.valence)),
  });

  const ready = () => speech.length > 0 && sampledSpeechMs >= minSpeechMs;

  return {
    add(prosody, tone) {
      if (!prosody || typeof prosody !== 'object') return;
      speech.push({
        speechMs: finiteOrNull(prosody.speechMs) ?? 0,
        wordsPerMinute: finiteOrNull(prosody.wordsPerMinute),
        pauseCount: finiteOrNull(prosody.pauseCount) ?? 0,
        longestPauseMs: finiteOrNull(prosody.longestPauseMs) ?? 0,
        longPausesPerMinute: longPausesPerMinute(prosody),
        pitchMedianHz: finiteOrNull(prosody.pitchMedianHz),
        pitchRangeSt: finiteOrNull(prosody.pitchRangeSt),
        loudnessDb: finiteOrNull(prosody.loudnessDb),
      });
      sampledSpeechMs += finiteOrNull(prosody.speechMs) ?? 0;
      if (tone && ['arousal', 'dominance', 'valence'].some(key => Number.isFinite(tone[key]))) tones.push(tone);
    },
    ready,
    minSpeechMs,
    speechMs() { return sampledSpeechMs; },
    snapshot() { return speech.length ? medians() : null; },
    relative(prosody, tone) {
      const empty = {
        rateRatio: null, pauseRatio: null, pitchRangeDeltaSt: null, loudnessDeltaDb: null,
        arousalDelta: null, dominanceDelta: null, valenceDelta: null, restarts: null,
      };
      if (!ready() || !prosody) return empty;
      const base = medians();
      const rateRatio = Number.isFinite(prosody.wordsPerMinute) && base.wordsPerMinute > 0
        ? round(prosody.wordsPerMinute / base.wordsPerMinute, 3) : null;
      // Long pauses per minute against the usual rate. The +2 per minute keeps a zero-pause baseline finite, and a
      // turn with a single long pause has no ratio at all, so one pause never reads as "more than usual" on its own.
      const rate = longPausesPerMinute(prosody);
      const baseRate = base.longPausesPerMinute;
      const pauseRatio = rate !== null && baseRate !== null && (longPauseCount(prosody) ?? 0) >= MIN_LONG_PAUSES_FOR_RATIO
        ? round((1 + rate) / (2 + baseRate), 3) : null;
      const pitchRangeDeltaSt = Number.isFinite(prosody.pitchRangeSt) && base.pitchRangeSt !== null
        ? round(prosody.pitchRangeSt - base.pitchRangeSt, 2) : null;
      const loudnessDeltaDb = Number.isFinite(prosody.loudnessDb) && base.loudnessDb !== null
        ? round(prosody.loudnessDb - base.loudnessDb, 2) : null;
      const toneDelta = key => (tone && Number.isFinite(tone[key]) && base[key] !== null)
        ? round(tone[key] - base[key], 3) : null;
      return {
        rateRatio,
        pauseRatio,
        pitchRangeDeltaSt,
        loudnessDeltaDb,
        arousalDelta: toneDelta('arousal'),
        dominanceDelta: toneDelta('dominance'),
        valenceDelta: toneDelta('valence'),
        restarts: Number.isFinite(prosody.restarts) ? prosody.restarts : null,
      };
    },
  };
}

export default createVoiceBaseline;
