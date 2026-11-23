/**
 * The call's active clock: recording time with the paused stretches taken out, the clock the replay shows.
 * Same maths as activeTimeMs in src/practice-call/replayModel.js; a time inside a pause counts as the pause's start.
 */
export function activeClock(pauseSpans) {
  const spans = (Array.isArray(pauseSpans) ? pauseSpans : [])
    .filter(span => span && Number.isFinite(span.startMs) && Number.isFinite(span.endMs) && span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  return ms => {
    const at = Number(ms);
    if (!Number.isFinite(at)) return ms;
    let removed = 0;
    for (const span of spans) {
      if (span.startMs >= at) break;
      removed += Math.min(span.endMs, at) - span.startMs;
    }
    return Math.max(0, at - removed);
  };
}
