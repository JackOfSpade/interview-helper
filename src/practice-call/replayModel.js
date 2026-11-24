import { replaySpeakerName } from './persona.js';

// Pure positioning helpers for the practice call replay view. Times are
// integer ms on the practice helper timeline (see
// docs/interview-practice-call-build.md, "Time base").

const asNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.round(asNumber(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const OVERLAY_WINDOW_MS = 1500;

const startOf = turn => (typeof turn?.startMs === 'number' && Number.isFinite(turn.startMs) ? turn.startMs : null);
const isOverlay = turn => Boolean(turn?.overlay) && (turn?.speaker ?? turn?.role) !== 'candidate';
// A typed answer is stamped with its send time only (start and end are equal). A chat line spoken in
// the candidate's voice has a real span on the recording and plays like any spoken turn.
const isTypedTurn = turn => (turn?.speaker ?? turn?.role) === 'candidate'
  && ((turn?.channel === 'chat' && turn?.voiced !== true) || (startOf(turn) !== null && Number.isFinite(turn?.endMs) && turn.endMs <= turn.startMs));

// Index of the transcript turn that is current at ms (final turn stays current
// until the end of the recording) or -1 when nothing covers it. A remark said
// over another speaker has no length, so it counts only just after it starts.
// A typed answer is current from the end of the turn before it until the next
// turn starts, since its own timestamp is a single instant.
export function turnAt(transcript, ms) {
  const list = Array.isArray(transcript) ? transcript : [];
  const at = asNumber(ms);
  let overlayIndex = -1;
  let current = -1;
  for (let index = 0; index < list.length; index += 1) {
    const turn = list[index];
    const startMs = startOf(turn);
    if (startMs === null) continue;
    if (startMs > at) break;
    if (isOverlay(turn)) {
      if (at - startMs < OVERLAY_WINDOW_MS) overlayIndex = index;
      continue;
    }
    current = index;
  }
  if (overlayIndex >= 0) return overlayIndex;
  // Not past a typed answer's send time yet, but already after the turn before it.
  for (let index = 0; index < list.length; index += 1) {
    const turn = list[index];
    if (!isTypedTurn(turn) || startOf(turn) === null) continue;
    let from = startOf(turn);
    for (let before = index - 1; before >= 0; before -= 1) {
      if (isOverlay(list[before]) || startOf(list[before]) === null) continue;
      const end = Number(list[before].endMs);
      from = Math.min(from, Number.isFinite(end) ? end : startOf(list[before]));
      break;
    }
    let until = Infinity;
    for (let after = index + 1; after < list.length; after += 1) {
      if (isOverlay(list[after]) || startOf(list[after]) === null) continue;
      until = startOf(list[after]);
      break;
    }
    if (at >= from && at < until) return index;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Paused time. A call held paused while the candidate typed is part of the
// recording, so the player skips it and shows the length without it.

// Sorted, non-overlapping spans clipped to the recording; bad entries dropped.
export function normalizePauseSpans(spans, durationMs) {
  const total = asNumber(durationMs, Infinity);
  const list = (Array.isArray(spans) ? spans : [])
    .map(span => ({ startMs: Math.max(0, asNumber(span?.startMs, NaN)), endMs: Math.min(total, asNumber(span?.endMs, NaN)) }))
    .filter(span => Number.isFinite(span.startMs) && Number.isFinite(span.endMs) && span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const span of list) {
    const last = merged[merged.length - 1];
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
}

// The span containing ms, or null.
export function pauseSpanAt(spans, ms) {
  const at = asNumber(ms);
  return (Array.isArray(spans) ? spans : []).find(span => at >= span.startMs && at < span.endMs) || null;
}

// Where playback lands for ms: the end of the pause it falls in, else ms itself.
export function skipPausedMs(spans, ms) {
  const span = pauseSpanAt(spans, ms);
  return span ? span.endMs : asNumber(ms);
}

// Recording time with the paused time before it taken out.
export function activeTimeMs(spans, ms) {
  const at = asNumber(ms);
  let removed = 0;
  for (const span of Array.isArray(spans) ? spans : []) {
    if (span.startMs >= at) break;
    removed += Math.min(span.endMs, at) - span.startMs;
  }
  return Math.max(0, at - removed);
}

// Active length: the payload's own figure, else the recording minus its spans.
export function activeLengthMs(durationMs, spans, activeMs) {
  const given = Number(activeMs);
  if (Number.isFinite(given) && given > 0) return Math.min(given, asNumber(durationMs, given));
  return activeTimeMs(spans, durationMs);
}

 const MARKER_TONES = Object.freeze({
  tone: 'bg-sky-300/80',
  pause: 'bg-amber-300/80',
  interruption: 'bg-rose-300/80',
  filler: 'bg-fuchsia-300/80',
  moment: 'bg-emerald-300/80',
  chat: 'bg-violet-300/80',
});

export const markerTone = kind => MARKER_TONES[kind] || 'bg-white/40';

// ---------------------------------------------------------------------------
// Chaptered seek bar geometry. Everything here is pure so the scrubber's
// behaviour can be unit-tested without a DOM.

const clampMsValue = (value, durationMs) => {
  const total = Math.max(0, asNumber(durationMs));
  return Math.min(Math.max(0, asNumber(value)), total);
};

// Pointer x (px, relative to the bar) as a clamped timeline position.
export function positionToMs(x, width, durationMs) {
  const barWidth = asNumber(width);
  const total = asNumber(durationMs);
  if (!(barWidth > 0) || !(total > 0)) return 0;
  const fraction = asNumber(x) / barWidth;
  return Math.min(Math.max(0, fraction * total), total);
}

function chapterEndMs(list, index, startMs) {
  const next = list[index + 1];
  const nextStart = next ? Math.max(startMs, asNumber(next?.startMs)) : Infinity;
  const declared = Number(list[index]?.endMs);
  const declaredEnd = Number.isFinite(declared) && declared > startMs ? declared : Infinity;
  return Math.min(nextStart, declaredEnd);
}

// Index of the chapter covering ms, or -1 when no chapter does.
export function chapterIndexAt(chapters, ms) {
  const list = Array.isArray(chapters) ? chapters : [];
  const at = asNumber(ms);
  for (let index = 0; index < list.length; index += 1) {
    const startMs = Math.max(0, asNumber(list[index]?.startMs));
    if (at < startMs) return -1;
    if (at < chapterEndMs(list, index, startMs)) return index;
  }
  return -1;
}

// Segment geometry as percentages of the whole recording.
export function segmentLayout(chapters, durationMs) {
  const total = asNumber(durationMs);
  const list = Array.isArray(chapters) ? chapters : [];
  if (!(total > 0) || !list.length) return [];
  return list.map((chapter, index) => {
    const startMs = Math.min(Math.max(0, asNumber(chapter?.startMs)), total);
    const next = list[index + 1];
    const nextStart = next ? Math.min(total, Math.max(startMs, asNumber(next?.startMs))) : total;
    const declared = Number(chapter?.endMs);
    const declaredEnd = Number.isFinite(declared) && declared > startMs ? Math.min(declared, total) : nextStart;
    const endMs = Math.max(startMs, Math.min(declaredEnd, nextStart));
    return {
      index,
      title: String(chapter?.title || `Chapter ${index + 1}`),
      startMs,
      endMs,
      leftPct: (startMs / total) * 100,
      widthPct: ((endMs - startMs) / total) * 100,
    };
  });
}

// Played fraction (0..1) of one segment at ms.
export function segmentFill(segment, ms) {
  const startMs = asNumber(segment?.startMs);
  const endMs = asNumber(segment?.endMs, startMs);
  if (!(endMs > startMs)) return 0;
  const at = asNumber(ms);
  if (at <= startMs) return 0;
  if (at >= endMs) return 1;
  return (at - startMs) / (endMs - startMs);
}

// Left offset (px) for a bubble centred on x and kept inside the bar.
export function bubbleLeftPx(x, barWidth, bubbleWidth) {
  const bar = asNumber(barWidth);
  const bubble = asNumber(bubbleWidth);
  if (!(bar > 0) || !(bubble > 0)) return 0;
  const room = bar - bubble;
  if (!(room > 0)) return 0;
  return Math.min(Math.max(0, asNumber(x) - bubble / 2), room);
}

// Closest marker tick within maxPx of ms, else null.
export function nearestMarker(markers, ms, durationMs, barWidth, maxPx = 6) {
  const list = Array.isArray(markers) ? markers : [];
  const total = asNumber(durationMs);
  const width = asNumber(barWidth);
  if (!list.length || !(total > 0) || !(width > 0)) return null;
  const at = asNumber(ms);
  let best = null;
  let bestPx = Infinity;
  list.forEach((marker, index) => {
    const raw = Number(marker?.atMs);
    if (!Number.isFinite(raw)) return;
    const markerMs = Math.min(Math.max(0, raw), total);
    const distancePx = (Math.abs(markerMs - at) / total) * width;
    if (distancePx < bestPx) {
      bestPx = distancePx;
      best = { ...marker, atMs: markerMs, index, label: String(marker?.label || marker?.kind || 'Moment') };
    }
  });
  if (!best) return null;
  return bestPx <= Math.max(0, asNumber(maxPx, 6)) ? best : null;
}

// 'Previous track': restarting the current chapter, or skipping back one when
// we are barely into it.
export function prevChapterStart(chapters, ms, graceMs = 1000) {
  const list = Array.isArray(chapters) ? chapters : [];
  const at = asNumber(ms);
  const grace = Math.max(0, asNumber(graceMs, 1000));
  let index = -1;
  for (let position = 0; position < list.length; position += 1) {
    if (Math.max(0, asNumber(list[position]?.startMs)) > at) break;
    index = position;
  }
  if (index < 0) return 0;
  const startMs = Math.max(0, asNumber(list[index]?.startMs));
  if (at - startMs > grace) return startMs;
  return index > 0 ? Math.max(0, asNumber(list[index - 1]?.startMs)) : 0;
}

// Start of the following chapter, or the end of the recording.
export function nextChapterStart(chapters, ms, durationMs) {
  const list = Array.isArray(chapters) ? chapters : [];
  const at = asNumber(ms);
  for (let index = 0; index < list.length; index += 1) {
    const startMs = Math.max(0, asNumber(list[index]?.startMs));
    if (startMs > at) return startMs;
  }
  return Math.max(0, asNumber(durationMs));
}

// Keyboard target for the focused slider, or null for a key we do not handle.
export function scrubberKeyTarget(key, modifiers, ms, durationMs, chapters) {
  const total = Math.max(0, asNumber(durationMs));
  const at = clampMsValue(ms, total);
  const list = Array.isArray(chapters) ? chapters : [];
  const altKey = Boolean(modifiers && modifiers.altKey);
  let target;
  switch (key) {
    case 'ArrowLeft': target = altKey ? prevChapterStart(list, at) : at - 5000; break;
    case 'ArrowRight': target = altKey ? nextChapterStart(list, at, total) : at + 5000; break;
    case 'j': case 'J': target = at - 10000; break;
    case 'l': case 'L': target = at + 10000; break;
    case 'Home': target = 0; break;
    case 'End': target = total; break;
    case 'PageUp': target = prevChapterStart(list, at); break;
    case 'PageDown': target = nextChapterStart(list, at, total); break;
    default: return null;
  }
  return clampMsValue(target, total);
}

// What the past-calls list shows: the call's length without the stretches it was held paused.
export function callLengthMs(call) {
  const total = Math.max(0, asNumber(call?.durationMs));
  const active = Number(call?.activeMs);
  if (Number.isFinite(active) && active > 0) return total > 0 ? Math.min(active, total) : active;
  const paused = asNumber(call?.pausedMs);
  return paused > 0 ? Math.max(0, total - paused) : total;
}

// ---------------------------------------------------------------------------
// Active time. The recording keeps the stretches the call was held paused, but
// everything the candidate sees (timeline, clock, seeking) leaves them out.

// Inverse of activeTimeMs: the recording time of an active time. At a pause's
// edge it lands after the pause, which is where playback would go anyway.
export function activeToRecordingMs(spans, activeMs) {
  let at = Math.max(0, asNumber(activeMs));
  for (const span of Array.isArray(spans) ? spans : []) {
    if (span.startMs <= at) at += span.endMs - span.startMs;
    else break;
  }
  return at;
}

// ---------------------------------------------------------------------------
// The chapter model: every chapter with its recording range, its active range,
// its question/answer split, who asked, and the feedback that belongs to it.

const isCandidate = turn => (turn?.speaker ?? turn?.role) === 'candidate';

// Chapter ranges on the recording clock, contiguous and covering the whole call.
// No chapters at all gives one block for the whole call.
function chapterRanges(chapters, durationMs) {
  const list = Array.isArray(chapters) ? chapters : [];
  const total = Math.max(0, asNumber(durationMs));
  if (!list.length) return [{ title: '', startMs: 0, endMs: total, questionTurnIndex: null, markers: [], synthetic: true }];
  return list.map((chapter, index) => {
    const own = Math.max(0, asNumber(chapter?.startMs));
    const startMs = index === 0 ? 0 : own;
    const next = list[index + 1];
    const last = index === list.length - 1;
    const nextStart = next ? Math.max(startMs, asNumber(next?.startMs)) : Infinity;
    const declared = Number(chapter?.endMs);
    let endMs = last ? Math.max(Number.isFinite(declared) ? declared : 0, total) : nextStart;
    if (total > 0) endMs = Math.min(endMs, total);
    endMs = Math.max(startMs, endMs);
    return {
      title: String(chapter?.title || '').trim() || `Part ${index + 1}`,
      startMs: total > 0 ? Math.min(startMs, total) : startMs,
      endMs,
      questionTurnIndex: Number.isInteger(chapter?.questionTurnIndex) ? chapter.questionTurnIndex : null,
      markers: Array.isArray(chapter?.markers) ? chapter.markers : [],
      synthetic: false,
    };
  });
}

// Where the answer starts inside a chapter: the first candidate turn that begins in it, else null (all question).
export function answerStartMs(transcript, startMs, endMs) {
  for (const turn of Array.isArray(transcript) ? transcript : []) {
    if (!isCandidate(turn)) continue;
    const at = startOf(turn);
    if (at === null || at < startMs || at >= endMs) continue;
    return at;
  }
  return null;
}

// Who asked: the interviewer turn that opens the chapter, else the first interviewer turn inside it.
function askerOf(replay, chapter, transcript) {
  const list = Array.isArray(transcript) ? transcript : [];
  let turn = Number.isInteger(chapter.questionTurnIndex) ? list[chapter.questionTurnIndex] : null;
  if (!turn || isCandidate(turn)) {
    turn = list.find(item => !isCandidate(item) && !item?.overlay && startOf(item) !== null && startOf(item) >= chapter.startMs && startOf(item) < chapter.endMs) || null;
  }
  if (!turn) return null;
  // A turn several interviewers spoke in is asked by whoever put the question: the last of them to ask something,
  // else the last to speak (a lead who hands over, then the colleague who sets the exercise). The turn's own id is
  // only who spoke first.
  const parts = Array.isArray(turn.segments) ? turn.segments.filter(item => item?.speakerId && item.text) : [];
  const asked = parts.length > 1 ? ([...parts].reverse().find(item => /\?/u.test(item.text)) || parts.at(-1)) : null;
  const id = asked?.speakerId || turn.speakerId || turn.segments?.[0]?.speakerId || '';
  const panel = Array.isArray(replay?.panel) ? replay.panel : [];
  const person = panel.find(item => item?.id === id) || (replay?.persona && (!id || id === 'A' || !panel.length) ? replay.persona : null);
  return { id, name: replaySpeakerName(replay, id), role: String(person?.role || '') };
}

// ---------------------------------------------------------------------------
// Matching feedback to chapters, deterministically.

const AUDIO_TAG = /\[[^\]]{0,40}\]/gu;
export function normalizeMatchText(text) {
  return String(text ?? '')
    .replace(AUDIO_TAG, ' ')
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const OVERLAP_MIN = 0.6;
// Words that say nothing about which line is meant: overlap is counted on the rest, so two unrelated questions that
// share "what do you want to ... in this role" do not match (review, 2026-11-21).
const STOPWORDS = new Set(('a an and are as at be but by can could did do does for from had has have how i if in is it its '
  + 'me my of on or our so that the their them then there these they this to us was we were what when where which who '
  + 'why will with would you your just about tell give me okay right well yeah').split(' '));

// How well the interviewer's line `hay` is the line `needle` quotes: 0 for no match,
// else up to 1 (equal). Substring either way beats word overlap; the overlap is the share of
// the needle's distinct words found in the line and must reach 0.6.
export function matchScore(needle, hay) {
  const a = normalizeMatchText(String(needle ?? '').replace(/(?:\.{3}|…)\s*$/u, ''));
  const b = normalizeMatchText(hay);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // A quote of one or two words says too little to place: only an exact line matches.
  if (a.split(' ').length < 3) return 0;
  if (` ${b} `.includes(` ${a} `)) return 0.9 + 0.1 * (a.length / b.length);
  if (b.split(' ').length >= 3 && ` ${a} `.includes(` ${b} `)) return 0.85 + 0.1 * (b.length / a.length);
  const content = text => text.split(' ').filter(word => !STOPWORDS.has(word));
  const wordsA = [...new Set(content(a))];
  const wordsB = new Set(content(b));
  if (wordsA.length < 2 || !wordsB.size) return 0;
  const shared = wordsA.filter(word => wordsB.has(word)).length;
  const ratio = shared / wordsA.length;
  if (ratio < OVERLAP_MIN) return 0;
  return ratio * 0.8 + 0.05 * (shared / wordsB.size);
}

// The interviewer turn that best matches a quoted line: { turnIndex, score } or null. A turn several
// interviewers spoke in also matches on each of its parts; the earliest turn wins a tie.
export function bestTurnFor(text, transcript) {
  let best = null;
  (Array.isArray(transcript) ? transcript : []).forEach((turn, turnIndex) => {
    if (!turn || isCandidate(turn)) return;
    let score = matchScore(text, turn.text);
    for (const part of Array.isArray(turn.segments) ? turn.segments : []) score = Math.max(score, matchScore(text, part?.text));
    if (score > 0 && (!best || score > best.score)) best = { turnIndex, score };
  });
  return best;
}

// The chapter a transcript turn belongs to: the one it opens, else the one containing its start time,
// else the last chapter opened at or before it.
function chapterOfTurn(chapters, transcript, turnIndex) {
  const opened = chapters.findIndex(chapter => chapter.questionTurnIndex === turnIndex);
  if (opened >= 0) return opened;
  const at = startOf(transcript[turnIndex]);
  if (at !== null) {
    const found = chapters.findIndex(chapter => at >= chapter.startMs && at < chapter.endMs);
    if (found >= 0) return found;
  }
  let result = -1;
  chapters.forEach((chapter, index) => { if (chapter.questionTurnIndex !== null && chapter.questionTurnIndex <= turnIndex) result = index; });
  return result;
}

// Attach each asked planned question and each moment to one chapter. `chapters` are the model's
// chapters (recording ranges, questionTurnIndex). One item per chapter at most: the best match
// wins, a planned question beating a moment on a tie. The rest are returned as leftovers.
export function matchFeedbackToChapters(chapters, transcript, feedback) {
  const list = Array.isArray(chapters) ? chapters : [];
  const turns = Array.isArray(transcript) ? transcript : [];
  const candidates = [];
  (Array.isArray(feedback?.planned) ? feedback.planned : []).forEach((item, itemIndex) => {
    if (!item || item.asked !== true || !item.askedAs) return;
    candidates.push({ kind: 'planned', itemIndex, item, text: item.askedAs, rank: 1 });
  });
  (Array.isArray(feedback?.moments) ? feedback.moments : []).forEach((item, itemIndex) => {
    if (!item || !item.prompt) return;
    candidates.push({ kind: 'moment', itemIndex, item, text: item.prompt, rank: 0 });
  });
  const byChapter = list.map(() => null);
  const leftover = { planned: [], moments: [] };
  const placed = [];
  for (const candidate of candidates) {
    const hit = bestTurnFor(candidate.text, turns);
    const chapterIndex = hit ? chapterOfTurn(list, turns, hit.turnIndex) : -1;
    placed.push({ ...candidate, score: hit ? hit.score : 0, turnIndex: hit ? hit.turnIndex : -1, chapterIndex });
  }
  placed.sort((a, b) => (b.score - a.score) || (b.rank - a.rank) || (a.turnIndex - b.turnIndex));
  const lost = new Set();
  for (const entry of placed) {
    if (entry.chapterIndex < 0) { lost.add(entry); continue; }
    const held = byChapter[entry.chapterIndex];
    // A second item for the same part (a follow-up moment after a planned question) is shown with it, not lost.
    if (held) { if (entry.kind === 'moment') held.extras.push(entry.item); else lost.add(entry); continue; }
    byChapter[entry.chapterIndex] = { kind: entry.kind, itemIndex: entry.itemIndex, item: entry.item, matchScore: entry.score, turnIndex: entry.turnIndex, extras: [] };
  }
  placed.filter(entry => lost.has(entry)).sort((a, b) => a.itemIndex - b.itemIndex)
    .forEach(entry => (entry.kind === 'planned' ? leftover.planned : leftover.moments).push(entry.item));
  return { byChapter, leftover };
}

// ---------------------------------------------------------------------------

// The tint for a feedback score: green at 8 and up, amber at 5 and up, red below, neutral without one.
export function scoreBand(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'none';
  return score >= 8 ? 'good' : score >= 5 ? 'mid' : 'low';
}

// First n sentences of a text and whether anything was cut.
export function firstSentences(text, count = 2) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!clean) return { text: '', cut: false };
  const sentences = clean.match(/[^.!?]+(?:[.!?]+["')\]]*(?=\s|$)|$)/gu) || [clean];
  if (sentences.length <= count) return { text: clean, cut: false };
  return { text: sentences.slice(0, count).join('').trim(), cut: true };
}

// The call overview: score, a short summary, the top priorities.
export function overviewOf(feedback, { prioritiesMax = 3, sentences = 2 } = {}) {
  const summary = firstSentences(feedback?.overall?.summary, sentences);
  return {
    score: typeof feedback?.overall?.score === 'number' ? feedback.overall.score : null,
    summary: summary.text,
    summaryCut: summary.cut,
    fullSummary: String(feedback?.overall?.summary ?? ''),
    priorities: (Array.isArray(feedback?.priorities) ? feedback.priorities : []).filter(Boolean).slice(0, prioritiesMax),
  };
}

// Whose voice the candidate's spoken turns in a chapter were in, for a call that used the AI voice; null otherwise.
export function chapterVoice(transcript, startMs, endMs) {
  const spoken = (Array.isArray(transcript) ? transcript : []).filter(turn => isCandidate(turn) && !turn.acknowledgement && !isTypedTurn(turn));
  if (!spoken.some(turn => turn.voiced === true)) return null;
  const here = spoken.filter(turn => { const at = startOf(turn); return at !== null && at >= startMs && at < endMs; });
  if (!here.length) return null;
  const ai = here.some(turn => turn.voiced === true);
  return ai && here.some(turn => turn.voiced !== true) ? 'AI voice and your voice' : ai ? 'AI voice' : 'Your voice';
}

// Everything the replay screen needs about the call's parts, on both clocks.
export function buildReplayModel(replay) {
  const durationMs = Math.max(0, asNumber(replay?.durationMs));
  const pauseSpans = normalizePauseSpans(replay?.pauseSpans, durationMs || Infinity);
  const activeMs = activeLengthMs(durationMs, pauseSpans, replay?.activeMs);
  const transcript = Array.isArray(replay?.transcript) ? replay.transcript : [];
  const ranges = chapterRanges(replay?.chapters, durationMs);
  const matched = replay?.feedback ? matchFeedbackToChapters(ranges, transcript, replay.feedback) : { byChapter: ranges.map(() => null), leftover: { planned: [], moments: [] } };
  const chapters = ranges.map((range, index) => {
    const answerMs = answerStartMs(transcript, range.startMs, range.endMs);
    const questionEndMs = answerMs === null ? range.endMs : Math.max(range.startMs, answerMs);
    const activeStartMs = activeTimeMs(pauseSpans, range.startMs);
    const activeEndMs = activeTimeMs(pauseSpans, range.endMs);
    const feedback = matched.byChapter[index];
    return {
      index,
      title: range.title,
      synthetic: range.synthetic,
      questionTurnIndex: range.questionTurnIndex,
      startMs: range.startMs,
      endMs: range.endMs,
      questionEndMs,
      hasAnswer: answerMs !== null,
      voice: chapterVoice(transcript, range.startMs, range.endMs),
      activeStartMs,
      activeEndMs,
      activeQuestionEndMs: activeTimeMs(pauseSpans, questionEndMs),
      markers: range.markers,
      asker: askerOf(replay, range, transcript),
      feedback,
      score: feedback && typeof feedback.item?.score === 'number' ? feedback.item.score : null,
    };
  });
  return { durationMs, activeMs, pauseSpans, chapters, leftover: matched.leftover };
}

// Index of the chapter under an active-time playhead, or -1 for an empty model.
export function chapterAtActive(chapters, activeMs) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) return -1;
  const at = asNumber(activeMs);
  let found = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index].activeStartMs <= at && at < list[index].activeEndMs) found = index;
  }
  if (found >= 0) return found;
  // Past the last chapter's end (the very end of the call) stays in the last chapter that has any length.
  for (let index = list.length - 1; index >= 0; index -= 1) if (list[index].activeEndMs > list[index].activeStartMs && at >= list[index].activeEndMs) return index;
  return -1;
}

// Question or answer at an active time inside a chapter.
export function partAtActive(chapter, activeMs) {
  if (!chapter || !chapter.hasAnswer) return 'question';
  return asNumber(activeMs) < chapter.activeQuestionEndMs ? 'question' : 'answer';
}

// Timeline blocks as percentages of the active length: the whole block and its question share.
// Chapters with no active length (inside a pause) are dropped.
export function timelineBlocks(chapters, activeMs) {
  const total = asNumber(activeMs);
  if (!(total > 0)) return [];
  return (Array.isArray(chapters) ? chapters : [])
    .filter(chapter => chapter.activeEndMs > chapter.activeStartMs)
    .map(chapter => {
      const length = chapter.activeEndMs - chapter.activeStartMs;
      const question = Math.min(length, Math.max(0, (chapter.hasAnswer ? chapter.activeQuestionEndMs : chapter.activeEndMs) - chapter.activeStartMs));
      return {
        index: chapter.index,
        leftPct: (chapter.activeStartMs / total) * 100,
        widthPct: (length / total) * 100,
        questionPct: (question / length) * 100,
        band: scoreBand(chapter.score),
      };
    });
}

// Moment ticks on the active timeline.
export function timelineTicks(chapters, pauseSpans, activeMs) {
  const total = asNumber(activeMs);
  const ticks = [];
  if (!(total > 0)) return ticks;
  (Array.isArray(chapters) ? chapters : []).forEach(chapter => (chapter.markers || []).forEach((marker, at) => {
    const raw = Number(marker?.atMs);
    if (!Number.isFinite(raw)) return;
    const active = Math.min(total, activeTimeMs(pauseSpans, Math.max(0, raw)));
    ticks.push({ key: `${chapter.index}-${at}`, kind: marker?.kind, label: String(marker?.label || marker?.kind || 'Moment'), activeMs: active, leftPct: (active / total) * 100 });
  }));
  return ticks;
}

// What a key does in the player, or null: Space toggles, Left/Right 5 s, Up/Down previous/next part.
export function playerKeyAction(key, modifiers = {}) {
  if (modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) return null;
  switch (key) {
    case ' ': case 'Spacebar': return { type: 'toggle' };
    case 'ArrowLeft': return { type: 'seekBy', deltaMs: -5000 };
    case 'ArrowRight': return { type: 'seekBy', deltaMs: 5000 };
    case 'ArrowUp': return { type: 'part', direction: -1 };
    case 'ArrowDown': return { type: 'part', direction: 1 };
    case 'Home': return { type: 'seekTo', ms: 0 };
    case 'End': return { type: 'seekTo', ms: Infinity };
    default: return null;
  }
}

// Previous / next part start on the active clock. Previous restarts the current part unless we
// are barely into it. Next at the last part goes to the end of the call.
export function partJumpTarget(chapters, activeMs, direction, totalActiveMs, graceMs = 1500) {
  const list = (Array.isArray(chapters) ? chapters : []).filter(chapter => chapter.activeEndMs > chapter.activeStartMs);
  const at = asNumber(activeMs);
  if (direction < 0) {
    let current = -1;
    list.forEach((chapter, index) => { if (chapter.activeStartMs <= at) current = index; });
    if (current < 0) return 0;
    if (at - list[current].activeStartMs > graceMs) return list[current].activeStartMs;
    return current > 0 ? list[current - 1].activeStartMs : 0;
  }
  const next = list.find(chapter => chapter.activeStartMs > at);
  return next ? next.activeStartMs : Math.max(0, asNumber(totalActiveMs));
}

// Names of the moment kinds the review reports.
export const KIND_LABELS = Object.freeze({ 'small-talk': 'Small talk', curveball: 'Curveball', 'off-topic': 'Off-topic', 'follow-up': 'Follow-up', 'questions-for-interviewer': 'Your questions', closing: 'Closing', other: 'Moment' });
