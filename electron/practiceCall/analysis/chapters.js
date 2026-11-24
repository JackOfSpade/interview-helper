/**
 * Timeline chapters and markers for a finished practice call. Pure: transcript,
 * review anchors and metrics in, chapters out. No clock, no I/O, no word lists.
 *
 * Chapter shape matches analysis.json exactly:
 * { title, startMs, endMs, questionTurnIndex, markers: [{ atMs, kind, label }] }.
 *
 * Metrics are read defensively because callMetrics.js owns their exact shape:
 * pauses come from `pauses`, `longPauses` or `answers[].pauses`, and
 * interruptions from `interruptions`, `candidateInterruptions` or per-answer
 * lists. Each entry may be `{ startMs, endMs }` or `{ atMs, durationMs }`.
 */

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const ms = value => number(value);
const list = value => (Array.isArray(value) ? value : []);
const label = value => (typeof value === 'string' ? value.trim() : '');
const isInterviewer = turn => turn?.speaker === 'interviewer';
const arrays = (metrics, keys) => keys.flatMap(key => list(metrics?.[key]));
const answerArrays = (metrics, key) => list(metrics?.answers).flatMap(answer => list(answer?.[key]));

/** Cut at a word boundary with an ellipsis; text that fits is returned whole. */
function clip(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(' ');
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd().replace(/[,;:.-]+$/, '')}\u2026`;
}

function pauseMarkers(candidateProsodyByTurn) {
  const seen = new Set();
  const markers = [];
  // The map holds one measured turn or a list of them per transcript entry.
  for (const turn of Object.values(candidateProsodyByTurn ?? {}).flat()) {
    for (const entry of list(turn?.pauses)) {
      const startMs = ms(entry?.startMs);
      const endMs = ms(entry?.endMs);
      if (startMs === null || endMs === null || endMs - startMs < 2000) continue;
      const key = "pause:" + startMs;
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push({ atMs: startMs, kind: "pause", label: "Long pause " + ((endMs - startMs) / 1000).toFixed(1) + "s" });
    }
  }
  return markers;
}

function interruptionMarkers(metrics) {
  const entries = [...arrays(metrics, ['interruptions', 'candidateInterruptions']), ...answerArrays(metrics, 'interruptions')];
  return entries.map(entry => {
    const atMs = ms(entry?.atMs) ?? ms(entry?.startMs);
    if (atMs === null) return null;
    const text = entry?.beforeQuestionFinished === false ? 'Talked over the interviewer' : 'Cut in before the question finished';
    return { atMs, kind: 'interruption', label: text };
  }).filter(Boolean);
}

/**
 * The interview's farewell is the last interviewer turn after the last question; Closing starts at its start,
 * except when the candidate spoke just before it (a question of theirs) and the turn is segmented by voice.
 * The engine has the lead take the floor back for the thanks and goodbye, with colleagues adding theirs after,
 * so the farewell is the lead's last segment and whatever follows it; segments before it answer the candidate
 * and belong to the previous chapter. The lead is the voice of the first segment. When the lead speaks only in
 * the first segment, or the turn has one segment, nothing can be told apart and the whole turn is Closing (a
 * single segment that answers and says goodbye cannot be split). The farewell's time is the segment's own
 * `startMs` when recorded, else the turn's start plus the share of characters before it, over the turn's length.
 */
function closingStartOf(turn, total) {
  const startMs = ms(turn.startMs) ?? total;
  const segments = list(turn.segments);
  const lead = segments[0]?.speakerId;
  if (lead === undefined || lead === null) return startMs;
  const farewell = segments.findLastIndex(segment => segment?.speakerId === lead);
  if (farewell <= 0) return startMs;
  const endMs = ms(turn.endMs) ?? total;
  const recorded = ms(segments[farewell].startMs);
  if (recorded !== null) return Math.max(startMs, Math.min(recorded, endMs));
  const size = segment => label(segment?.text).length;
  const all = segments.reduce((sum, segment) => sum + size(segment), 0);
  if (!all) return startMs;
  const before = segments.slice(0, farewell).reduce((sum, segment) => sum + size(segment), 0);
  return Math.round(startMs + (before / all) * Math.max(0, endMs - startMs));
}

function closingIndex(transcript, questionIndices) {
  const lastQuestion = questionIndices.length ? Math.max(...questionIndices) : -1;
  for (let index = transcript.length - 1; index > lastQuestion; index -= 1) {
    if (isInterviewer(transcript[index])) return closingExchangeStart(transcript, index, lastQuestion);
  }
  return -1;
}

const asks = turn => label(typeof turn?.sentText === 'string' && turn.sentText.trim() ? turn.sentText : turn?.text).includes('?');
// A candidate line longer than this, in words or in time, is an answer, not part of a goodbye.
const GOODBYE_MAX_WORDS = 40;
const GOODBYE_MAX_MS = 12000;

/**
 * The close can be several turns (the thanks, the candidate's goodbye, the goodbye back), so Closing starts at the first
 * of them: the turn is taken back over an earlier interviewer turn while nobody asked anything in it or since, what the
 * candidate said since is short, and the candidate turn before it asked nothing (else it is an answer to them).
 */
function closingExchangeStart(transcript, last, lastQuestion) {
  if (lastQuestion < 0) return last; // no question to bound it
  let start = last;
  for (let index = last - 1; index > lastQuestion; index -= 1) {
    const turn = transcript[index];
    if (turn?.acknowledgement) continue;
    if (asks(turn)) break;
    if (!isInterviewer(turn)) {
      if (label(turn?.text).split(/\s+/u).length > GOODBYE_MAX_WORDS || (ms(turn?.endMs) ?? 0) - (ms(turn?.startMs) ?? 0) > GOODBYE_MAX_MS) break;
      continue;
    }
    const before = transcript.slice(0, index).findLast(item => item?.speaker === 'candidate' && !item.acknowledgement);
    if (before && asks(before)) break;
    start = index;
  }
  return start;
}

/**
 * Whether the closing turn follows a candidate turn that asked something, so that it may open with an answer.
 * What the candidate asked is read from the text that was sent when the entry has it, else from the transcript.
 */
function answersCandidate(transcript, index, questionIndices) {
  const lastQuestion = questionIndices.length ? Math.max(...questionIndices) : -1;
  const before = transcript[index - 1];
  if (!(index - 1 > lastQuestion && before?.speaker === 'candidate' && !before.acknowledgement)) return false;
  return asks(before);
}

// An opening shorter than this, with nothing said by the candidate, is only the connection and is not its own chapter.
const OPENING_MIN_MS = 3000;

const candidateTurn = turn => turn?.speaker === 'candidate' && !turn.acknowledgement;

/**
 * Where an anchored chapter starts: at its interviewer turn, except a turn that first answers what the candidate asked
 * and then leaves them room to ask again. That answer belongs to the chapter before, so this one starts at the
 * candidate's next question.
 */
function anchorStartOf(turns, index) {
  const start = ms(turns[index].startMs) ?? 0;
  const before = turns.slice(0, index).findLast(turn => !turn?.acknowledgement);
  const next = turns.slice(index + 1).find(turn => !turn?.acknowledgement);
  if (!candidateTurn(before) || !asks(before) || !candidateTurn(next) || !asks(next)) return start;
  return ms(next.startMs) ?? start;
}

function chapterFor(chapters, atMs) {
  const containing = chapters.find(chapter => chapter.startMs <= atMs && atMs < chapter.endMs);
  if (containing) return containing;
  const last = chapters[chapters.length - 1] ?? null;
  return last && atMs >= last.endMs ? last : null;
}

export function buildChapters({ transcript = [], reviewChapters = [], moments = [], metrics = {}, candidateProsodyByTurn = {}, durationMs = 0 } = {}) {
  const turns = list(transcript);
  const total = ms(durationMs) ?? turns.reduce((max, turn) => Math.max(max, ms(turn?.endMs) ?? 0), 0);
  const anchors = [];
  const seenQuestions = new Set();
  for (const entry of list(reviewChapters)) {
    const index = number(entry?.questionTurnIndex);
    if (index === null || !Number.isInteger(index) || index < 0 || index >= turns.length) continue;
    if (!isInterviewer(turns[index]) || seenQuestions.has(index)) continue;
    seenQuestions.add(index);
    anchors.push({ index, startMs: anchorStartOf(turns, index), title: label(entry?.title) || 'Interviewer question' });
  }
  anchors.sort((left, right) => left.startMs - right.startMs);
  const closing = closingIndex(turns, anchors.map(anchor => anchor.index));
  const anchorIndices = anchors.map(anchor => anchor.index);
  const closingStart = closing < 0 ? total
    : answersCandidate(turns, closing, anchorIndices) ? closingStartOf(turns[closing], total) : ms(turns[closing].startMs) ?? total;

  const chapters = [];
  const firstQuestion = anchors[0]?.startMs ?? closingStart;
  const candidateSpoke = turns.some(turn => turn?.speaker === 'candidate' && (ms(turn.startMs) ?? 0) < firstQuestion);
  const foldOpening = firstQuestion > 0 && firstQuestion < OPENING_MIN_MS && anchors.length > 0 && !candidateSpoke;
  if (firstQuestion > 0 && !foldOpening) chapters.push({ title: 'Opening', questionTurnIndex: null, startMs: 0, endMs: firstQuestion, markers: [] });
  anchors.forEach((anchor, position) => {
    const next = anchors[position + 1]?.startMs ?? closingStart;
    chapters.push({ title: anchor.title, questionTurnIndex: anchor.index, startMs: position === 0 && foldOpening ? 0 : anchor.startMs, endMs: Math.max(anchor.startMs, next), markers: [] });
  });
  if (closing >= 0 && closingStart > (anchors.at(-1)?.startMs ?? 0)) {
    chapters.push({ title: 'Closing', questionTurnIndex: null, startMs: closingStart, endMs: Math.max(closingStart, total), markers: [] });
  }
  if (!chapters.length) chapters.push({ title: 'Call', questionTurnIndex: null, startMs: 0, endMs: total, markers: [] });
  chapters.forEach((chapter, position) => { chapter.endMs = Math.min(chapter.endMs, chapters[position + 1]?.startMs ?? Math.max(chapter.endMs, total)); });

  const markers = [
    ...pauseMarkers(candidateProsodyByTurn),
    ...interruptionMarkers(metrics),
    ...list(metrics?.fillerMoments).map(entry => ({ atMs: ms(entry?.atMs), kind: 'filler', label: label(entry?.label) || 'Filler' })),
    ...list(moments).map(moment => {
      const turn = turns[number(moment?.turnIndex)] ?? null;
      return { atMs: turn ? ms(moment?.atMs) ?? ms(turn.startMs) : null, kind: moment?.kind === 'filler' ? 'filler' : 'moment', label: label(moment?.label) || 'Flagged moment' };
    }),
    // The candidate's own typed lines are the chapter's text already; only the interviewer's chat is a marker.
    ...turns.filter(turn => turn?.channel === 'chat' && isInterviewer(turn)).map(turn => ({
      atMs: ms(turn.startMs),
      kind: 'chat',
      label: `Interviewer typed: ${clip(label(turn.text), 120)}`,
    })),
  ].filter(marker => marker.atMs !== null).map(marker => ({ ...marker, atMs: Math.max(0, Math.min(marker.atMs, total)) })).sort((left, right) => left.atMs - right.atMs);

  for (const marker of markers) chapterFor(chapters, marker.atMs)?.markers.push(marker);
  return chapters.filter(chapter => chapter.endMs > chapter.startMs || chapter.markers.length > 0);
}
