import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logEvent } from '../utils/eventLog.js';
import { AlertTriangle, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward, Trash2 } from 'lucide-react';
import { FeedbackView } from '../components/InterviewPracticePanel.jsx';
import { replaySpeakerName } from './persona.js';
import {
  activeToRecordingMs, bubbleLeftPx, KIND_LABELS, buildReplayModel, chapterAtActive, formatTime, markerTone, nearestMarker, overviewOf, partAtActive,
  partJumpTarget, playerKeyAction, positionToMs, scoreBand, skipPausedMs, timelineBlocks, timelineTicks, activeTimeMs,
} from './replayModel.js';
import SharedScreen from './SharedScreen.jsx';
import CodingPad from './CodingPad.jsx';
import { padSnapshotAt, screenAt } from './screenMarkup.js';
import { describeDeliveryValue, humanizeKey } from './callModel.js';

const TYPED_ONLY_DELIVERY = 'Delivery was not measured: every answer was typed.';
const SPEEDS = Object.freeze([1, 1.25, 1.5, 2]);
// The step a review run again is on, as the replay's running notice names it.
const ANALYSIS_STAGES = Object.freeze({ recording: 'preparing', transcribing: 'transcribing your answers', metrics: 'measuring delivery', review: 'writing the feedback', saving: 'saving' });
const SKIP_MS = 10_000;
const BUBBLE_ESTIMATE_PX = 120;
const RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300';

// Whether the post-call analysis found every answer was typed rather than spoken.
// Without the analysis figure (the payload may not carry it), the transcript decides: answers, all typed.
// A chat line the call spoke in the candidate's voice (`voiced`) is a spoken answer, so it is never typed.
const isTypedOnly = replay => {
  const given = replay?.analysis?.metrics?.typedOnly ?? replay?.metrics?.typedOnly;
  if (typeof given === 'boolean') return given;
  const answers = (Array.isArray(replay?.transcript) ? replay.transcript : []).filter(turn => (turn?.speaker ?? turn?.role) === 'candidate');
  return answers.length > 0 && answers.every(turn => turn?.channel === 'chat' && turn?.voiced !== true);
};

export function DeliverySection({ delivery, typedOnly = false }) {
  const record = delivery && typeof delivery === 'object' && !Array.isArray(delivery) ? delivery : null;
  // Nothing was spoken, so pace, pauses and the like have nothing to say: one line instead.
  if (typedOnly) {
    const summary = describeDeliveryValue(record?.summary) || TYPED_ONLY_DELIVERY;
    return <section aria-label="Delivery" data-delivery-typed-only="true" className="rounded-md border border-white/10 bg-black/20 p-2">
      <p className="text-[10px] font-semibold uppercase text-white/45">Delivery</p>
      <p className="mt-1 text-[11px] text-white/75">{summary}</p>
    </section>;
  }
  const entries = record
    ? Object.entries(record).map(([key, value]) => [key, describeDeliveryValue(value)]).filter(([, text]) => text)
    : [];
  if (!entries.length) return null;
  return <section aria-label="Delivery" className="rounded-md border border-white/10 bg-black/20 p-2">
    <p className="text-[10px] font-semibold uppercase text-white/45">Delivery</p>
    <ul className="mt-1 space-y-0.5">{entries.map(([key, text]) => <li key={key} className="text-[11px] text-white/75"><span className="capitalize text-violet-200">{humanizeKey(key)}</span>: {text}</li>)}</ul>
  </section>;
}

// Tints of a feedback score on the timeline and on the score badge.
const BAND_FILL = Object.freeze({ good: 'bg-emerald-500', mid: 'bg-amber-500', low: 'bg-red-500', none: 'bg-slate-500' });
const BAND_BADGE = Object.freeze({
  good: 'bg-emerald-500/20 text-emerald-100 ring-emerald-400/50',
  mid: 'bg-amber-500/20 text-amber-100 ring-amber-400/50',
  low: 'bg-red-500/20 text-red-100 ring-red-400/50',
  none: 'bg-white/10 text-white/70 ring-white/20',
});

function ScoreBadge({ score, size = 'lg', label = 'Score' }) {
  if (typeof score !== 'number') return null;
  const band = scoreBand(score);
  return <span data-score-badge={band} aria-label={`${label} ${score} out of 10`}
    className={`inline-flex shrink-0 items-baseline gap-0.5 rounded-xl font-semibold ring-1 ${BAND_BADGE[band]} ${size === 'lg' ? 'px-3 py-1.5 text-2xl' : 'px-2 py-0.5 text-sm'}`}>
    {score}<span className={`font-normal opacity-70 ${size === 'lg' ? 'text-sm' : 'text-xs'}`}>/10</span>
  </span>;
}

// The timeline: the call's parts as blocks on the active clock, each split into a lighter
// question and a solid answer, tinted by its score. One slider element; the blocks are drawing.
function Timeline({ model, positionActiveMs, onSeek, disabled, format, currentIndex }) {
  const total = model.activeMs;
  const blocks = useMemo(() => timelineBlocks(model.chapters, total), [model.chapters, total]);
  const ticks = useMemo(() => timelineTicks(model.chapters, model.pauseSpans, total), [model.chapters, model.pauseSpans, total]);
  const [pointer, setPointer] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [dragMs, setDragMs] = useState(0);
  const shownMs = dragging ? dragMs : Math.min(Math.max(0, positionActiveMs), total);
  const percent = total > 0 ? Math.min(100, Math.max(0, (shownMs / total) * 100)) : 0;
  const hoverMs = pointer && total > 0 ? positionToMs(pointer.x, pointer.width, total) : null;
  const hoverChapter = hoverMs === null ? null : model.chapters[chapterAtActive(model.chapters, Math.min(hoverMs, Math.max(0, total - 1)))] || null;
  const tick = hoverMs === null ? null : nearestMarker(ticks.map(item => ({ ...item, atMs: item.activeMs })), hoverMs, total, pointer.width);
  const currentTitle = model.chapters[currentIndex]?.synthetic ? '' : model.chapters[currentIndex]?.title || '';
  const bubbleLeft = pointer ? bubbleLeftPx(pointer.x, pointer.width, Math.min(pointer.width, BUBBLE_ESTIMATE_PX)) : 0;

  const read = event => {
    const rect = event.currentTarget.getBoundingClientRect?.();
    const width = rect && rect.width > 0 ? rect.width : 0;
    if (!(width > 0)) return null;
    return { x: Math.min(Math.max(0, Number(event.clientX) - rect.left), width), width };
  };
  const onPointerDown = event => {
    if (disabled || !(total > 0)) return;
    const next = read(event);
    if (!next) return;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* best effort */ }
    setPointer(next);
    setDragMs(positionToMs(next.x, next.width, total));
    setDragging(true);
  };
  const onPointerMove = event => {
    if (disabled) return;
    const next = read(event);
    if (!next) return;
    setPointer(next);
    if (dragging) setDragMs(positionToMs(next.x, next.width, total));
  };
  const finish = event => {
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    if (!dragging) return;
    const next = event.type === 'pointercancel' ? null : read(event);
    const target = next ? positionToMs(next.x, next.width, total) : dragMs;
    setDragging(false);
    if (event.pointerType !== 'mouse') setPointer(null);
    onSeek(Math.min(Math.max(0, target), total));
  };

  return <div role="slider" tabIndex={disabled ? -1 : 0} aria-label="Replay position" aria-disabled={disabled ? 'true' : undefined}
    aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(shownMs)}
    aria-valuetext={`${format(shownMs)} of ${format(total)}${currentTitle ? `, ${currentTitle}` : ''}`} data-timeline="true"
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={finish} onPointerLeave={() => { if (!dragging) setPointer(null); }}
    className={`relative w-full touch-none select-none rounded-lg py-3 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${RING}`}>
    <div className="relative h-12 w-full">
      {blocks.map(block => {
        const fill = BAND_FILL[block.band];
        const current = block.index === currentIndex;
        return <div key={`block-${block.index}`} data-chapter={block.index} data-band={block.band} data-current={current ? 'true' : undefined}
          className={`absolute inset-y-0 overflow-hidden rounded-[4px] ${current ? 'ring-2 ring-white/90' : ''}`}
          style={{ left: `${block.leftPct}%`, width: `max(2px, calc(${block.widthPct}% - 2px))` }}>
          <div aria-hidden="true" data-part="question" className={`absolute inset-y-0 left-0 ${fill} opacity-40`} style={{ width: `${block.questionPct}%` }} />
          <div aria-hidden="true" data-part="answer" className={`absolute inset-y-0 right-0 ${fill}`} style={{ width: `${100 - block.questionPct}%` }} />
        </div>;
      })}
      {blocks.length === 0 && <div aria-hidden="true" className="absolute inset-0 rounded-[4px] bg-white/10" />}
      {ticks.map(item => <span key={`tick-${item.key}`} aria-hidden="true" data-marker-kind={item.kind}
        className={`pointer-events-none absolute top-0 h-2 w-0.5 -translate-x-1/2 ${markerTone(item.kind)}`} style={{ left: `${item.leftPct}%` }} />)}
      <div aria-hidden="true" data-playhead="true" className="pointer-events-none absolute -inset-y-1.5 w-0.5 -translate-x-1/2 rounded bg-white shadow" style={{ left: `${percent}%` }}>
        <span data-timeline-knob="true" className="absolute -top-1 left-1/2 h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow ring-2 ring-[#202124]" />
      </div>
      {pointer && hoverMs !== null && !disabled && <div aria-hidden="true" data-timeline-bubble="true"
        className="pointer-events-none absolute z-20 max-w-[220px] rounded-md bg-black/90 px-2 py-1.5 text-xs leading-tight text-white shadow-lg"
        style={{ left: `${bubbleLeft}px`, bottom: 'calc(100% + 10px)' }}>
        <p className="truncate font-medium">{tick ? tick.label : hoverChapter && !hoverChapter.synthetic ? hoverChapter.title : 'Call'}</p>
        <p className="font-mono text-[11px] text-white/65">{format(tick ? tick.atMs : hoverMs)}{!tick && typeof hoverChapter?.score === 'number' ? ` · ${hoverChapter.score}/10` : ''}</p>
      </div>}
    </div>
  </div>;
}

function Block({ label, tone = 'neutral', children }) {
  const styles = tone === 'work' ? 'border-amber-400/40 bg-amber-500/10' : 'border-white/10 bg-white/5';
  return <section aria-label={label} data-feedback-block={label} className={`rounded-xl border p-4 ${styles}`}>
    <h3 className={`text-xs font-semibold uppercase tracking-wide ${tone === 'work' ? 'text-amber-200' : 'text-white/55'}`}>{label}</h3>
    <p className={`mt-1.5 whitespace-pre-line text-base leading-relaxed ${tone === 'work' ? 'text-amber-50' : 'text-white/90'}`}>{children}</p>
  </section>;
}

// The feedback that belongs to the part under the playhead.
function PartFeedback({ chapter, hasFeedback }) {
  const entry = chapter.feedback;
  return entry ? <>{PartFeedbackMain({ chapter, hasFeedback })}<ExtraMoments items={entry.extras} /></> : PartFeedbackMain({ chapter, hasFeedback });
}

// Follow-up moments in the same part, shown under its main feedback.
function ExtraMoments({ items }) {
  if (!Array.isArray(items) || !items.length) return null;
  return <ul aria-label="Also in this part" className="mt-3 space-y-2">{items.map((item, index) => <li key={index} className="flex flex-wrap items-baseline gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-base text-white/85">
    <span className="rounded-full bg-violet-500/20 px-2.5 py-0.5 text-xs text-violet-100">{KIND_LABELS[item.kind] || item.kind || 'Moment'}</span>
    <ScoreBadge score={item.score} />
    {item.note && <span>{item.note}</span>}
  </li>)}</ul>;
}

function PartFeedbackMain({ chapter, hasFeedback }) {
  const entry = chapter.feedback;
  if (!entry) return hasFeedback ? <p data-feedback-empty="true" className="text-base text-white/55">No notes for this part.</p> : null;
  const item = entry.item;
  if (entry.kind === 'moment') {
    return <div className="space-y-3" data-feedback-kind="moment">
      <div className="flex flex-wrap items-center gap-3">
        <ScoreBadge score={item.score} />
        <span className="rounded-full bg-violet-500/20 px-3 py-1 text-sm text-violet-100">{KIND_LABELS[item.kind] || item.kind || 'Moment'}</span>
      </div>
      {item.note ? <p className="text-lg leading-relaxed text-white/90">{item.note}</p> : <p className="text-base text-white/55">No notes for this part.</p>}
    </div>;
  }
  const none = !item.covered && !item.improve && !item.adapted;
  return <div className="space-y-3" data-feedback-kind="planned">
    <ScoreBadge score={item.score} />
    {item.covered && <Block label="What worked">{item.covered}</Block>}
    {item.improve && <Block label="Work on" tone="work">{item.improve}</Block>}
    {item.adapted && <Block label="Adapting">{item.adapted}</Block>}
    {none && <p className="text-base text-white/55">No notes for this part.</p>}
    {item.extension && <details className="practice-extension rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/70">
      <summary className={`cursor-pointer rounded ${RING}`}>Optional extension</summary>
      <p className="mt-1 text-xs text-white/45">Say this only if you can back it with a real example.</p>
      <p className="mt-1 text-base text-white/80">{item.extension}</p>
    </details>}
  </div>;
}

// Question and Your answer are also buttons: each jumps to where that half of the part starts.
function PartChips({ chapter, part, onJump }) {
  const asker = chapter.asker;
  const label = chapter.hasAnswer ? null : 'Interviewer';
  const chip = (key, text, ms) => {
    const now = part === key;
    return <button type="button" data-part-chip={key} aria-current={now ? 'true' : undefined} disabled={!onJump}
      aria-label={`Jump to the start of ${key === 'answer' ? 'your answer' : 'the question'}`} title={key === 'answer' ? 'Jump to your answer' : 'Jump to the question'}
      onClick={() => onJump?.(ms)}
      className={`px-3 py-1 transition-colors duration-150 -outline-offset-2 ${RING} ${now ? 'bg-white text-[#202124]' : 'text-white/55 enabled:hover:bg-white/10 enabled:hover:text-white/85'} disabled:cursor-default`}>{text}</button>;
  };
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-part-now={part}>
    <div role="group" aria-label="Where we are in this part" className="inline-flex overflow-hidden rounded-full border border-white/15 text-sm">
      {chip('question', label || 'Question', chapter.activeStartMs)}
      {chapter.hasAnswer && chip('answer', 'Your answer', chapter.activeQuestionEndMs)}
    </div>
    {asker?.name && <p className="text-sm text-white/65">Asked by <span className="text-white/90">{asker.name}</span>{asker.role ? <span className="text-white/50"> · {asker.role}</span> : null}</p>}
  </div>;
}

function Overview({ model, replay, overview, typedOnly, hasAudio, summaryOpen, onSummaryOpen, showAll, onShowAll, callTitle }) {
  const feedback = replay?.feedback || null;
  return <div data-replay-overview="true" className="mx-auto w-full max-w-3xl space-y-5">
    <div className="flex flex-wrap items-center gap-4">
      {feedback && overview.score !== null && <ScoreBadge score={overview.score} label="Overall score" />}
      <div className="min-w-0">
        <h2 className="text-2xl font-normal text-white">{feedback ? 'How the call went' : callTitle}</h2>
        <p className="text-sm text-white/55">{formatTime(model.activeMs)} of talking{model.chapters.length > 1 ? ` · ${model.chapters.length} parts` : ''}</p>
      </div>
    </div>
    {feedback && overview.summary && <p data-overview-summary="true" className="whitespace-pre-line text-lg leading-relaxed text-white/90">
      {summaryOpen ? overview.fullSummary : overview.summary}
      {overview.summaryCut && <> <button type="button" onClick={() => onSummaryOpen(!summaryOpen)} aria-expanded={summaryOpen} className={`rounded text-base text-violet-200 underline underline-offset-2 hover:text-violet-100 ${RING}`}>{summaryOpen ? 'Less' : 'More'}</button></>}
    </p>}
    {overview.priorities.length > 0 && <section aria-label="Work on first" data-overview-priorities="true" className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-200">Work on first</h3>
      <ol className="mt-2 list-decimal space-y-2 pl-5 text-base leading-relaxed text-amber-50">{overview.priorities.map((item, index) => <li key={index}>{item}</li>)}</ol>
    </section>}
    <p data-overview-hint="true" className="text-sm text-white/55">{hasAudio ? 'Press play, or pick a part on the timeline, to see the feedback for what you hear.' : feedback ? 'The recording is gone, so the timeline is off. Your feedback is below.' : 'The recording is gone, so there is nothing to play.'}</p>
    {feedback && <div>
      <button type="button" onClick={() => onShowAll(!showAll)} aria-expanded={showAll} data-all-feedback-toggle="true"
        className={`rounded-lg border border-white/15 px-3 py-1.5 text-sm text-violet-100 hover:bg-white/5 ${RING}`}>{showAll ? 'Hide all feedback' : 'All feedback'}</button>
      {showAll && <div data-all-feedback="true" className="mt-3 space-y-3 rounded-xl bg-[#2d2e30] p-3">
        <FeedbackView feedback={feedback} typedOnly={typedOnly} compact />
        <DeliverySection delivery={feedback.delivery} typedOnly={typedOnly} />
      </div>}
    </div>}
  </div>;
}

export default function Replay({ replay, api, initialPositionMs = 0, initialShowAll = false }) {
  const model = useMemo(() => buildReplayModel(replay), [replay]);
  const { durationMs, activeMs, pauseSpans } = model;
  const [positionMs, setPositionMs] = useState(Math.max(0, Number(initialPositionMs) || 0));
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [interacted, setInteracted] = useState(false);
  const [overviewPinned, setOverviewPinned] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [showAll, setShowAll] = useState(Boolean(initialShowAll));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  // A failed review run again from the notice: whether the request is out, and why it was refused.
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(null);
  const audioRef = useRef(null);
  const pendingSeekRef = useRef(null);
  const audioUrl = !deleted && replay?.audioUrl ? replay.audioUrl : null;
  const analysis = replay?.analysis || null;
  const hasFeedback = !!replay?.feedback;
  const typedOnly = isTypedOnly(replay);
  const overview = useMemo(() => overviewOf(replay?.feedback), [replay?.feedback]);

  const activePos = activeTimeMs(pauseSpans, positionMs);
  const currentIndex = chapterAtActive(model.chapters, activePos);
  const chapter = currentIndex >= 0 ? model.chapters[currentIndex] : null;
  const part = chapter ? partAtActive(chapter, activePos) : 'question';
  const showOverview = overviewPinned || (!interacted && positionMs === 0) || !chapter;
  const fmt = ms => formatTime(ms);

  const seek = useCallback(ms => {
    const raw = Math.max(0, Number(ms) || 0);
    const clamped = durationMs > 0 ? Math.min(raw, durationMs) : raw;
    // A paused stretch is never played: landing in one goes to its end.
    const target = skipPausedMs(pauseSpans, clamped);
    setPositionMs(target);
    setInteracted(true);
    setOverviewPinned(false);
    const audio = audioRef.current;
    let ready = false;
    if (audio) {
      try { ready = audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0; } catch { ready = false; }
      if (ready) { try { audio.currentTime = target / 1000; } catch { ready = false; } }
    }
    pendingSeekRef.current = ready ? null : target;
  }, [durationMs, pauseSpans]);
  const seekActive = useCallback(ms => {
    const clamped = Math.min(Math.max(0, Number(ms) || 0), activeMs);
    seek(activeToRecordingMs(pauseSpans, clamped));
  }, [activeMs, pauseSpans, seek]);
  const applyPendingSeek = () => {
    const pending = pendingSeekRef.current;
    const audio = audioRef.current;
    if (pending === null || !audio) return;
    try { audio.currentTime = pending / 1000; } catch { return; }
    pendingSeekRef.current = null;
    setPositionMs(pending);
  };
  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (playing) { try { audio.pause?.(); } catch { /* detached */ } setPlaying(false); return; }
    setInteracted(true);
    setOverviewPinned(false);
    // Played to the end: play again from the start.
    if (durationMs > 0 && positionMs >= durationMs - 250) seek(0);
    try {
      const started = audio.play?.();
      if (started && typeof started.catch === 'function') started.catch((error) => { logEvent('WARN recording did not play:', error?.name || 'error', error?.message || ''); setPlaying(false); });
      setPlaying(true);
    } catch { setPlaying(false); }
  }, [audioUrl, durationMs, playing, positionMs, seek]);
  const jumpPart = useCallback(direction => seekActive(partJumpTarget(model.chapters, activePos, direction, activeMs)), [model.chapters, activePos, activeMs, seekActive]);
  const retryAnalysis = async () => {
    if (typeof api?.retryAnalysis !== 'function' || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const result = await api.retryAnalysis();
      if (result?.error) setRetryError(result.error);
    } catch (error) { setRetryError(error?.message || 'The feedback could not be run again.'); }
    setRetrying(false);
  };
  const confirmDelete = async () => {
    if (typeof api?.deleteRecording === 'function') {
      try { await api.deleteRecording(); }
      catch (error) {
        setDeleteError(error?.message || 'The recording could not be deleted.');
        setConfirmingDelete(false);
        return;
      }
    }
    setDeleteError(null);
    setDeleted(true);
    setConfirmingDelete(false);
    setPlaying(false);
  };

  // Playback speed follows the buttons, and a new recording starts at the chosen speed.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try { audio.playbackRate = rate; } catch { /* not ready */ }
  }, [rate, audioUrl]);
  // While playing, follow the audio every frame: a smooth playhead, and a pause is jumped over
  // at once instead of up to a quarter second late.
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    let last = -1;
    const tick = () => {
      const audio = audioRef.current;
      if (audio && pendingSeekRef.current === null) {
        const now = (Number(audio.currentTime) || 0) * 1000;
        const landing = skipPausedMs(pauseSpans, now);
        if (landing !== now) { try { audio.currentTime = landing / 1000; } catch { /* not seekable yet */ } }
        if (Math.abs(landing - last) >= 30) { last = landing; setPositionMs(landing); }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, pauseSpans]);

  // The shared screen can be enlarged over the feedback; it keeps following playback, and the player stays usable.
  const [screenEnlarged, setScreenEnlarged] = useState(false);
  const shrinkRef = useRef(null);
  const enlargeOpenedRef = useRef(false);
  const closeEnlarged = () => {
    setScreenEnlarged(false);
    // Focus goes back to the Enlarge button it came from.
    setTimeout(() => { try { document.querySelector('[data-replay-share] [data-screen-enlarge]')?.focus(); } catch { /* gone */ } }, 0);
  };

  const onKeyDown = event => {
    if (screenEnlarged && event.key === 'Escape') { event.preventDefault(); closeEnlarged(); return; }
    const action = playerKeyAction(event.key, { altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    if (!action || !audioUrl) return;
    const tag = String(event.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
    // Space on a button or a disclosure belongs to that control.
    if (action.type === 'toggle' && (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A')) return;
    // In the feedback area Up, Down, Home, End and Space scroll it, as they would any page.
    if (action.type !== 'seekBy' && event.target?.closest?.('[data-replay-focus]')) return;
    event.preventDefault();
    if (action.type === 'toggle') togglePlay();
    else if (action.type === 'seekBy') seekActive(activePos + action.deltaMs);
    else if (action.type === 'part') jumpPart(action.direction);
    else if (action.type === 'seekTo') seekActive(action.ms);
  };

  // What was on the shared screen, and the code the candidate had written, at this moment.
  const shownScreen = screenAt(replay?.screens, positionMs);
  const shownPad = padSnapshotAt(replay?.pad, positionMs);
  const hasPadSnapshots = Array.isArray(replay?.pad?.snapshots) && replay.pad.snapshots.length > 0;
  const showScreen = !showOverview && !!shownScreen;
  const showPad = !showOverview && hasPadSnapshots && !!shownPad;
  const screenEnlargedShown = screenEnlarged && showScreen;
  useEffect(() => {
    if (screenEnlargedShown && !enlargeOpenedRef.current) { enlargeOpenedRef.current = true; try { shrinkRef.current?.focus(); } catch { /* not mounted */ } }
    if (!screenEnlargedShown) enlargeOpenedRef.current = false;
  }, [screenEnlargedShown]);

  const callTitle = replay?.persona?.name ? `Interview with ${replay.persona.name}` : 'Practice interview';
  const partTitle = chapter ? (chapter.synthetic ? callTitle : chapter.title) : '';
  const startedAt = replay?.startedAt ? new Date(replay.startedAt) : null;
  const dateLabel = startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  return <main onKeyDown={onKeyDown} className="flex h-screen min-w-0 flex-col overflow-hidden bg-[#202124] text-violet-50" aria-label="Call replay" data-replay-root="true">
    <header className="pc-rise flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-normal text-white">{callTitle}</h1>
        <p className="truncate text-xs text-white/50">{[dateLabel, `${formatTime(activeMs)} long`].filter(Boolean).join(' · ')}</p>
      </div>
      {hasFeedback && overview.score !== null && <ScoreBadge score={overview.score} size="sm" label="Overall score" />}
      <button type="button" onClick={() => setOverviewPinned(true)} aria-pressed={showOverview} aria-label="Overview"
        className={`rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5 ${showOverview ? 'bg-white/10 text-white' : 'text-violet-100'} ${RING}`}>Overview</button>
      <button type="button" aria-label="Delete recording" onClick={() => setConfirmingDelete(true)} disabled={!audioUrl}
        className={`flex items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-500/15 px-3 py-1.5 text-sm text-red-100 hover:bg-red-500/25 disabled:opacity-40 ${RING}`}>
        <Trash2 size={14} aria-hidden="true" /><span className="hidden min-[820px]:inline">Delete recording</span>
      </button>
    </header>
    {(!audioUrl || analysis?.status === 'analyzing' || analysis?.status === 'failed' || deleteError || confirmingDelete) && <div data-replay-notices="true" className="shrink-0 space-y-1.5 px-4 pt-2.5">
      {!audioUrl && <p role="status" aria-label="Recording unavailable" className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/65">
        {deleted ? 'Recording deleted. The feedback is kept.'
          : replay?.recordingPruned ? `Only the ${replay.recordingsKept ?? 10} most recent calls keep their recording. The feedback of this one is kept.`
            : 'The recording for this call is not available. The feedback is kept.'}
      </p>}
      {analysis?.status === 'analyzing' && <p role="status" aria-label="Analysis status" className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Analysis is still running{ANALYSIS_STAGES[analysis.stage] ? ` (${ANALYSIS_STAGES[analysis.stage]})` : ''}. Chapters and feedback may be incomplete.</p>}
      {analysis?.status === 'failed' && <p role="alert" aria-label="Analysis failed" className="flex items-start gap-1.5 rounded-lg border border-red-400/30 bg-red-500/15 px-3 py-2 text-sm text-red-100">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" /><span>Analysis failed{analysis.error ? `: ${analysis.error}` : ''}. The recording is still available.{retryError ? ` ${retryError}` : ''}</span>
        {typeof api?.retryAnalysis === 'function' && <button type="button" onClick={retryAnalysis} disabled={retrying} aria-label="Try the feedback again" className={`ml-auto shrink-0 rounded-md border border-red-400/40 bg-red-500/25 px-3 py-0.5 hover:bg-red-500/35 disabled:opacity-40 ${RING}`}>{retrying ? 'Trying…' : 'Try again'}</button>}
      </p>}
      {deleteError && <p role="alert" aria-label="Delete failed" className="rounded-lg border border-red-400/30 bg-red-500/15 px-3 py-2 text-sm text-red-100">{deleteError}</p>}
      {confirmingDelete && <div role="alertdialog" aria-label="Delete recording" className="space-y-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
        <p>Delete the recording for this call? The feedback is kept.</p>
        <div className="flex gap-2">
          <button type="button" onClick={confirmDelete} aria-label="Confirm delete recording" className={`rounded-md border border-red-400/40 bg-red-500/25 px-3 py-1 hover:bg-red-500/35 ${RING}`}>Delete</button>
          <button type="button" onClick={() => setConfirmingDelete(false)} className={`rounded-md border border-white/15 px-3 py-1 text-white/70 hover:bg-white/5 ${RING}`}>Keep recording</button>
        </div>
      </div>}
    </div>}

    <div className="relative flex min-h-0 flex-1 flex-col">
    <section aria-label="Now playing" data-replay-focus="true" data-focus-mode={showOverview ? 'overview' : 'part'} tabIndex={0}
      className={`pc-scroll-hidden min-h-0 flex-1 overflow-y-auto px-4 py-5 min-[720px]:px-8 min-[720px]:py-6 ${RING}`}>
      <p className="sr-only" role="status" aria-live="polite" data-replay-announce="true">{showOverview ? '' : partTitle}</p>
      {showOverview
        ? <Overview model={model} replay={replay} overview={overview} typedOnly={typedOnly} hasAudio={!!audioUrl} summaryOpen={summaryOpen} onSummaryOpen={setSummaryOpen} showAll={showAll} onShowAll={setShowAll} callTitle={callTitle} />
        : <article key={chapter.index} data-focus-part={chapter.index} className="pc-fade mx-auto w-full max-w-6xl space-y-5">
          {chapter.synthetic ? null : <PartChips chapter={chapter} part={part} onJump={audioUrl ? seekActive : undefined} />}
          <h2 data-focus-title="true" className="text-3xl font-normal leading-tight text-white min-[1000px]:text-4xl">{partTitle}</h2>
          <div className={`grid gap-6 ${showScreen || showPad ? 'min-[1000px]:grid-cols-2' : 'max-w-3xl'}`}>
            <div className="min-w-0"><PartFeedback chapter={chapter} hasFeedback={hasFeedback} /></div>
            {(showScreen || showPad) && <div data-replay-share="true" className="min-w-0 space-y-3">
              {showScreen && <SharedScreen title={shownScreen.title} content={shownScreen.content} visual={shownScreen.visual ?? null} presenterName={replaySpeakerName(replay, shownScreen.speakerId)} className="h-72" onEnlarge={() => setScreenEnlarged(true)} />}
              {showPad && <CodingPad readOnly lang={replay?.pad?.lang || replay?.pad?.chosen || ''} value={shownPad.text} className="h-60" />}
            </div>}
          </div>
        </article>}
    </section>
    {screenEnlargedShown && <div role="dialog" aria-modal="true" aria-label="Shared screen, enlarged" data-replay-screen-enlarged="true" data-replay-focus="true"
      onMouseDown={event => { if (event.target === event.currentTarget) closeEnlarged(); }}
      className="pc-fade absolute inset-0 z-30 flex bg-black/75 p-3 min-[720px]:p-6">
      <SharedScreen title={shownScreen.title} content={shownScreen.content} visual={shownScreen.visual ?? null} presenterName={replaySpeakerName(replay, shownScreen.speakerId)}
        className="mx-auto h-full w-full max-w-6xl shadow-2xl" large onClose={closeEnlarged} closeRef={shrinkRef} />
    </div>}
    </div>

    <footer data-replay-player="true" className="pc-rise shrink-0 border-t border-white/10 bg-[#17181a] px-4 pb-4 pt-3 min-[720px]:px-8" style={{ animationDelay: '120ms' }}>
      <audio ref={audioRef} src={audioUrl || undefined} preload="metadata" aria-label="Call recording"
        onLoadedMetadata={() => { try { if (audioRef.current) audioRef.current.playbackRate = rate; } catch { /* not ready */ } applyPendingSeek(); }}
        onTimeUpdate={event => {
          if (pendingSeekRef.current !== null) return;
          const audio = event.currentTarget;
          const now = (Number(audio.currentTime) || 0) * 1000;
          const landing = skipPausedMs(pauseSpans, now);
          if (landing !== now) {
            try { audio.currentTime = landing / 1000; } catch { /* not seekable yet */ }
            setPositionMs(landing);
            return;
          }
          setPositionMs(now);
        }}
        onPlay={() => { setPlaying(true); setInteracted(true); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <div className="mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-3">
        <span data-replay-clock="true" className="whitespace-nowrap font-mono text-sm text-white/70">{fmt(activePos)} / {fmt(activeMs)}</span>
        <div className="flex items-center gap-1.5 min-[720px]:gap-3" role="group" aria-label="Playback controls">
          <IconButton label="Previous part" onClick={() => jumpPart(-1)} disabled={!audioUrl}><SkipBack size={20} aria-hidden="true" /></IconButton>
          <IconButton label="Back 10 seconds" onClick={() => seekActive(activePos - SKIP_MS)} disabled={!audioUrl}><RotateCcw size={22} aria-hidden="true" /></IconButton>
          <button type="button" aria-label={playing ? 'Pause recording' : 'Play recording'} onClick={togglePlay} disabled={!audioUrl} data-play-button="true"
            className={`grid h-14 w-14 shrink-0 place-items-center rounded-full bg-white text-[#202124] shadow-lg transition-transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 ${RING}`}>
            {playing ? <Pause size={26} fill="currentColor" aria-hidden="true" /> : <Play size={26} fill="currentColor" className="translate-x-0.5" aria-hidden="true" />}
          </button>
          <IconButton label="Forward 10 seconds" onClick={() => seekActive(activePos + SKIP_MS)} disabled={!audioUrl}><RotateCw size={22} aria-hidden="true" /></IconButton>
          <IconButton label="Next part" onClick={() => jumpPart(1)} disabled={!audioUrl}><SkipForward size={20} aria-hidden="true" /></IconButton>
        </div>
        <div role="group" aria-label="Playback speed" className="flex justify-end gap-0.5">
          {SPEEDS.map(speed => <button key={speed} type="button" onClick={() => setRate(speed)} aria-pressed={rate === speed} aria-label={`Speed ${speed}x`} disabled={!audioUrl}
            className={`rounded-md px-1.5 py-1 text-xs min-[720px]:px-2 min-[720px]:text-sm ${rate === speed ? 'bg-white/15 text-white' : 'text-white/55 hover:bg-white/5'} disabled:opacity-40 ${RING}`}>{speed}x</button>)}
        </div>
      </div>
      <div className="mx-auto mt-2 w-full max-w-6xl">
        <Timeline model={model} positionActiveMs={activePos} onSeek={seekActive} disabled={!audioUrl} format={fmt} currentIndex={currentIndex} />
        <p data-replay-now-title="true" className="mt-0.5 truncate text-center text-sm text-white/65">{chapter && (interacted || positionMs > 0) ? partTitle : ''}</p>
      </div>
    </footer>
  </main>;
}

function IconButton({ label, onClick, disabled, children }) {
  return <button type="button" aria-label={label} onClick={onClick} disabled={disabled}
    className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-white/85 hover:bg-white/10 disabled:opacity-40 ${RING}`}>{children}</button>;
}

export { Replay };
