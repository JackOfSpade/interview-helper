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
// A typed answer is stamped with its send time only (start and end are equal).
const isTypedTurn = turn => (turn?.speaker ?? turn?.role) === 'candidate'
  && (turn?.channel === 'chat' || (startOf(turn) !== null && Number.isFinite(turn?.endMs) && turn.endMs <= turn.startMs));

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
