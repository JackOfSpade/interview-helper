// Post-call deterministic metrics from the timed transcript. Pure: no I/O,
// no word lists; only counts, durations and prosody numbers already measured.
const round = (value, digits = 1) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const median = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function countWords(text) {
  return String(text ?? '').split(/\s+/)
    .map(piece => piece.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean).length;
}

function prosodyFor(source, index) {
  if (!source) return [];
  if (source instanceof Map) return [source.get(index)].flat().filter(Boolean);
  if (Array.isArray(source)) return [source[index]].flat().filter(Boolean);
  return [source[index]].flat().filter(Boolean);
}

// Uniform word positions across the answer; deterministic without Scribe words.
function wordPositions(wordCount, startMs, endMs) {
  const duration = Math.max(1, endMs - startMs);
  const positions = [];
  for (let i = 0; i < wordCount; i += 1) positions.push(startMs + ((i + 0.5) * duration) / wordCount);
  return positions;
}

function fastestWindowWpm(wordCount, startMs, endMs, windowMs = 20000) {
  const duration = endMs - startMs;
  if (wordCount <= 0 || !(duration > 0)) return 0;
  if (duration <= windowMs) return round((wordCount / duration) * 60000, 1);
  const positions = wordPositions(wordCount, startMs, endMs);
  let best = 0;
  let end = 0;
  for (let start = 0; start < positions.length; start += 1) {
    if (end < start) end = start;
    while (end < positions.length && positions[end] - positions[start] < windowMs) end += 1;
    best = Math.max(best, end - start);
  }
  return round((best / windowMs) * 60000, 1);
}

// A silence between two recogniser segments counts as a pause from this length (the same floor as prosody's own pauses).
const PAUSE_MIN_MS = 300;

// Merge [start, end] spans so overlapping speech (a talk-over) is counted once; paused time is taken out of the total.
function mergedSpanMs(spans, pauseSpans) {
  const sorted = spans.filter(span => finite(span.startMs) && finite(span.endMs) && span.endMs > span.startMs)
    .map(span => ({ startMs: span.startMs, endMs: span.endMs })).sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let current = null;
  const close = () => { if (current) total += current.endMs - current.startMs - pausedOverlapMs(pauseSpans, current.startMs, current.endMs); };
  for (const span of sorted) {
    if (current && span.startMs <= current.endMs) current.endMs = Math.max(current.endMs, span.endMs);
    else { close(); current = span; }
  }
  close();
  return Math.max(0, total);
}

// A line spoken on the call in the candidate's voice is a spoken answer; only an unvoiced chat line is typed.
const isTypedLine = entry => entry?.channel === 'chat' && entry.voiced !== true;

/**
 * Measured turns from the ear, keyed by the spoken candidate transcript entry they overlap
 * most in time. The ear and the transcript share the helper timeline, so overlap is the link.
 */
export function prosodyByEntry(transcript = [], turns = []) {
  const entries = Array.isArray(transcript) ? transcript : [];
  const byEntry = {};
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!finite(turn?.startMs) || !finite(turn?.endMs)) continue;
    let best = -1;
    let bestOverlap = 0;
    entries.forEach((entry, index) => {
      if (entry?.speaker !== 'candidate' || isTypedLine(entry) || entry.acknowledgement) return;
      if (!finite(entry.startMs) || !finite(entry.endMs)) return;
      const overlap = Math.min(entry.endMs, turn.endMs) - Math.max(entry.startMs, turn.startMs);
      if (overlap > bestOverlap) { best = index; bestOverlap = overlap; }
    });
    if (best >= 0) (byEntry[best] ??= []).push(turn);
  }
  return byEntry;
}

function interviewerRuns(entries) {
  // Contiguous interviewer entries are one question; the run end is when it finished.
  // A typed interviewer message is not speech, so it neither makes nor extends a run.
  const runs = [];
  let current = null;
  entries.forEach((entry, index) => {
    if (entry.speaker !== 'interviewer' || entry.channel === 'chat') return;
    if (!current || current.lastIndex !== index - 1) {
      current = { firstIndex: index, lastIndex: index, startMs: entry.startMs, endMs: entry.endMs };
      runs.push(current);
    } else {
      current.lastIndex = index;
      current.startMs = Math.min(current.startMs, entry.startMs);
      current.endMs = Math.max(current.endMs, entry.endMs);
    }
  });
  return runs;
}

// Paused time inside [fromMs, toMs]: the recording ran through a pause, but the candidate was not on the clock.
function pausedOverlapMs(pauseSpans, fromMs, toMs) {
  return (Array.isArray(pauseSpans) ? pauseSpans : []).reduce((sum, span) => (
    finite(span?.startMs) && finite(span?.endMs) ? sum + Math.max(0, Math.min(span.endMs, toMs) - Math.max(span.startMs, fromMs)) : sum
  ), 0);
}

// `voicedBaselineSnapshot` is the baseline of the synthetic voice: an answer made only of voiced lines
// is compared with it, never with the microphone baseline (a different voice).
export function callMetrics({ transcript = [], candidateProsodyByTurn = null, candidateProsody = null, baselineSnapshot = null, voicedBaselineSnapshot = null, pauseSpans = [] } = {}) {
  const entries = Array.isArray(transcript) ? transcript : [];
  const prosodyMap = Array.isArray(candidateProsody) ? prosodyByEntry(entries, candidateProsody) : candidateProsodyByTurn;
  const groups = [];
  const typedAnswers = [];
  let group = null;
  entries.forEach((entry, index) => {
    if (isTypedLine(entry)) {
      // Only the candidate's own typed lines are typed answers; the interviewer's chat
      // messages and spoken acknowledgements typed in passing are not. A line the voice spoke is not typed.
      if (entry.speaker !== 'candidate' || entry.acknowledgement) return;
      typedAnswers.push({ startMs: entry.startMs, endMs: entry.endMs, wordCount: countWords(entry.text), text: String(entry.text ?? '') });
      return;
    }
    if (entry?.speaker !== 'candidate') { group = null; return; }
    if (entry.acknowledgement) return;
    if (!group) { group = { turnIndexes: [], startMs: entry.startMs, endMs: entry.endMs, words: 0, voicedOnly: true }; groups.push(group); }
    if (entry.voiced !== true) group.voicedOnly = false;
    group.turnIndexes.push(index);
    group.startMs = Math.min(group.startMs, entry.startMs);
    group.endMs = Math.max(group.endMs, entry.endMs);
    // A voiced line's known sent words are counted when the call kept them: the recogniser's text can repeat itself.
    group.words += countWords(entry.voiced === true && typeof entry.sentText === 'string' ? entry.sentText : entry.text);
  });

  // When the call kept no baseline of the synthetic voice (its lines were heard on the microphone path), the voice's
  // own first stretch of speech is its baseline: the deltas then show drift within the voice, never against a human's.
  let voicedFallback = null;
  if (!voicedBaselineSnapshot) {
    const items = groups.filter(item => item.voicedOnly).flatMap(item => item.turnIndexes.flatMap(index => prosodyFor(prosodyMap, index)))
      .filter(item => finite(item.startMs)).sort((a, b) => a.startMs - b.startMs);
    const used = [];
    let spoken = 0;
    for (const item of items) {
      if (spoken >= 20000) break;
      used.push(item);
      spoken += finite(item.speechMs) ? item.speechMs : 0;
    }
    if (used.length) voicedFallback = { pitchRangeSt: median(used.map(item => item.pitchRangeSt)), loudnessDb: median(used.map(item => item.loudnessDb)) };
  }

  const answers = groups.map((answer, answerIndex) => {
    const prosody = answer.turnIndexes.flatMap(index => prosodyFor(prosodyMap, index));
    const pauses = prosody.flatMap(item => item.pauses ?? []);
    // Each recogniser segment is measured alone, so the silence between two segments of one answer is a pause no
    // segment saw. It counts unless the call was paused through it or an interviewer spoke in it.
    const ordered = prosody.filter(item => finite(item.startMs) && finite(item.endMs)).sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < ordered.length; i += 1) {
      const fromMs = ordered[i - 1].endMs;
      const toMs = ordered[i].startMs;
      if (toMs - fromMs < PAUSE_MIN_MS) continue;
      if (pausedOverlapMs(pauseSpans, fromMs, toMs) > 0) continue;
      if (entries.some(other => other?.speaker === 'interviewer' && other.channel !== 'chat' && finite(other.startMs) && finite(other.endMs) && other.startMs < toMs && other.endMs > fromMs)) continue;
      pauses.push({ startMs: fromMs, endMs: toMs });
    }
    const speechMs = prosody.reduce((sum, item) => sum + (finite(item.speechMs) ? item.speechMs : 0), 0);
    const durationMs = Math.max(0, answer.endMs - answer.startMs);
    // Pace is over the time the candidate was on the clock: wall clock less any paused time. The speech-frame rate
    // (articulationWpm) leaves out every silence, so it reads faster and is a separate figure.
    const activeMs = Math.max(0, durationMs - pausedOverlapMs(pauseSpans, answer.startMs, answer.endMs));
    const pitchRangeSt = median(prosody.map(item => item.pitchRangeSt));
    const base = answer.voicedOnly ? (voicedBaselineSnapshot ?? voicedFallback) : baselineSnapshot;
    const prior = answer.turnIndexes[0] - 1;
    // The question is the contiguous run of spoken interviewer entries just before the answer. A back-channel
    // laid over it (an overlay) ends early and is not the question, so the latest end of the run counts, and paused time does not.
    let questionEndMs = null;
    let askedNothing = false; // the line just before asked nothing: the time until the candidate spoke is not a response time
    for (let i = prior; i >= 0; i -= 1) {
      const before = entries[i];
      if (before?.speaker === 'interviewer' && before.channel !== 'chat' && !before.overlay) {
        if (questionEndMs === null) askedNothing = before.statement === true;
        questionEndMs = Math.max(questionEndMs ?? -Infinity, before.endMs);
      }
      else if (before?.overlay === true && before.speaker === 'interviewer') continue;
      // A back-channel ("mm-hm") said right after the question is not the end of an earlier answer.
      else if (before?.speaker === 'candidate' && before.acknowledgement) continue;
      else if (questionEndMs !== null || before?.speaker === 'candidate') break;
    }
    const responseLatencyMs = finite(questionEndMs) && !askedNothing
      ? Math.max(0, answer.startMs - questionEndMs - pausedOverlapMs(pauseSpans, questionEndMs, answer.startMs)) : null;
    return {
      index: answerIndex,
      turnIndexes: answer.turnIndexes.slice(),
      startMs: answer.startMs,
      endMs: answer.endMs,
      durationMs,
      wordCount: answer.words,
      speechMs,
      activeMs,
      wordsPerMinute: round(activeMs > 0 ? (answer.words / activeMs) * 60000 : 0, 1),
      articulationWpm: round(speechMs > 0 ? (answer.words / speechMs) * 60000 : 0, 1),
      fastest20sWindowWpm: fastestWindowWpm(answer.words, 0, activeMs),
      pauseCount: pauses.length,
      pausesOver1s: pauses.filter(pause => pause.endMs - pause.startMs > 1000).length,
      pausesOver2s: pauses.filter(pause => pause.endMs - pause.startMs > 2000).length,
      longestPauseMs: pauses.reduce((longest, pause) => Math.max(longest, pause.endMs - pause.startMs), 0),
      responseLatencyMs,
      longAnswer: durationMs > 120000,
      pitchRangeSt,
      pitchRangeDeltaSt: finite(pitchRangeSt) && finite(base?.pitchRangeSt) ? round(pitchRangeSt - base.pitchRangeSt, 2) : null,
      loudnessDeltaDb: finite(median(prosody.map(item => item.loudnessDb))) && finite(base?.loudnessDb)
        ? round(median(prosody.map(item => item.loudnessDb)) - base.loudnessDb, 2) : null,
    };
  });

  const runs = interviewerRuns(entries);
  const candidateInterruptions = [];
  entries.forEach((entry, index) => {
    if (entry?.speaker !== 'candidate' || isTypedLine(entry) || entry.acknowledgement) return;
    const run = runs.find(item => entry.startMs > item.startMs && entry.startMs < item.endMs);
    if (!run) return;
    candidateInterruptions.push({
      turnIndex: index,
      atMs: entry.startMs,
      interviewerFirstIndex: run.firstIndex,
      interviewerEndMs: run.endMs,
      overlapMs: Math.max(0, run.endMs - entry.startMs),
      beforeQuestionFinished: entry.startMs < run.endMs,
    });
  });

  // Answers the interviewer had to stop: the candidate's line carries the cut-in, spoken live or by voice.
  const interviewerCutIns = [];
  // A cut that fell in a gap (cutWhileSpeaking false) stopped nothing the candidate was saying: it is not a cut-in.
  // cutInReason is the reason the interviewer gave, counted per reason; a cut without one is counted as unspecified.
  const interviewerCutInsByReason = {};
  entries.forEach((entry, index) => {
    if (entry?.speaker === 'candidate' && entry.interrupted === true && entry.cutOffBy === 'interviewer' && entry.cutWhileSpeaking !== false) {
      const reason = typeof entry.cutInReason === 'string' && entry.cutInReason ? entry.cutInReason : 'unspecified';
      interviewerCutIns.push({ turnIndex: index, atMs: entry.endMs ?? entry.startMs, reason });
      interviewerCutInsByReason[reason] = (interviewerCutInsByReason[reason] ?? 0) + 1;
    }
  });

  // Both sides on wall-clock spans: overlapping speech on one side counts once and paused time counts for neither.
  const candidateTalkMs = mergedSpanMs(entries.filter(entry => entry?.speaker === 'candidate' && !isTypedLine(entry) && !entry.acknowledgement), pauseSpans);
  const interviewerTalkMs = mergedSpanMs(entries.filter(entry => entry?.speaker === 'interviewer' && entry.channel !== 'chat'), pauseSpans);
  const totalTalkMs = candidateTalkMs + interviewerTalkMs;

  return {
    answers,
    typedAnswers,
    // A call answered only by typing has no voice to measure: pace, pauses, fillers and tone do not apply.
    // A line spoken in the candidate's voice is a spoken answer, so it is never typed.
    typedOnly: answers.length === 0 && typedAnswers.length > 0,
    answerCount: answers.length,
    typedAnswerCount: typedAnswers.length,
    candidateTalkMs,
    interviewerTalkMs,
    talkRatio: totalTalkMs > 0 ? round(candidateTalkMs / totalTalkMs, 3) : 0,
    candidateInterruptions,
    interruptionCount: candidateInterruptions.length,
    interviewerCutIns,
    interviewerCutInCount: interviewerCutIns.length,
    interviewerCutInsByReason,
    responseLatencyMs: median(answers.map(answer => answer.responseLatencyMs)),
    longAnswerCount: answers.filter(answer => answer.longAnswer).length,
    pausesOver1s: answers.reduce((sum, answer) => sum + answer.pausesOver1s, 0),
    pausesOver2s: answers.reduce((sum, answer) => sum + answer.pausesOver2s, 0),
    fastest20sWindowWpm: answers.reduce((best, answer) => Math.max(best, answer.fastest20sWindowWpm), 0),
  };
}

export default callMetrics;
