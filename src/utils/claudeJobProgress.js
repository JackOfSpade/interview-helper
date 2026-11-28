// What the status card says about a handoff the Claude task worker holds: the
// current action, recent steps and separately labelled clocks.

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const time = value => Number.isFinite(value) && value >= 0 ? value : null;

/** 20s, 4 min, 1 h 5 min. Null for a value that is not a non-negative number. */
export function formatProgressDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export const CLAUDE_PROGRESS_COPY = Object.freeze({
  lastHeard: ago => `Last heard from Claude ${ago}`,
  notHeardYet: 'Waiting for activity from Claude',
  justNow: 'just now',
  ago: duration => `${duration} ago`,
  region: 'Claude progress',
  toneLabel: Object.freeze({ neutral: '', working: '', attention: 'Needs attention', problem: 'Problem' }),
});

// Tone styling for the Claude progress section.
export const TONE_CLASS = Object.freeze({
  neutral: 'border-white/10 bg-white/[0.03]',
  working: 'border-violet-400/25 bg-violet-500/10',
  attention: 'border-amber-400/35 bg-amber-500/10',
  problem: 'border-red-400/35 bg-red-500/10',
});
export const HEADLINE_CLASS = Object.freeze({
  neutral: 'text-white',
  working: 'text-white',
  attention: 'text-amber-50',
  problem: 'text-red-100',
});

const CLAUDE_PAUSED_HEADLINE = 'Paused';
const CLAUDE_PAUSED_DETAIL = 'Finished work is saved. No new Claude calls will start until you resume.';
const CLAUDE_PAUSING_NOTE = 'Pausing after this call finishes';
const TASK_STEP_LIMIT = 8;
const titleCase = value => value ? `${value[0].toUpperCase()}${value.slice(1)}` : '';

function taskToolHeadline(task) {
  if (task.tool === 'WebSearch' || task.tool === 'mcp__parallel__web_search') return 'Searching the web';
  if (task.tool === 'WebFetch' || task.tool === 'mcp__parallel__web_fetch') return 'Reading a page';
  // web_decisions, find_verticals, search_vertical and image_search all search.
  if (typeof task.tool === 'string' && task.tool.startsWith('mcp__parallel__')) return 'Searching the web';
  return task.tool ? `Using ${task.tool}` : 'Using a tool';
}

function taskRunningCopy(task) {
  switch (task.phase) {
    case 'waiting': return ['Waiting for Claude to respond', ''];
    case 'thinking': return ['Claude is thinking', ''];
    case 'writing': return ['Claude is writing the answer', ''];
    case 'tool': return [taskToolHeadline(task), task.target || ''];
    case 'api-retry': {
      const retry = task.apiRetry || {};
      const parts = [Number.isSafeInteger(retry.attempt) ? `Attempt ${retry.attempt}${Number.isSafeInteger(retry.maxRetries) ? ` of ${retry.maxRetries}` : ''}` : '',
        Number.isSafeInteger(retry.delayMs) ? `waiting ${formatProgressDuration(retry.delayMs)}` : '',
        Number.isSafeInteger(retry.status) ? `(HTTP ${retry.status})` : ''].filter(Boolean);
      return ["Claude's service asked to retry", parts.length ? `${parts.join(', ').replace(', (', ' (')}.` : ''];
    }
    default: return ['Starting Claude', ''];
  }
}

const taskSteps = task => (Array.isArray(task.steps) ? task.steps : []).slice(-TASK_STEP_LIMIT);

function taskLiveCounts(task) {
  const countOf = (value, words) => Number.isSafeInteger(value) && value > 0 ? `${value.toLocaleString('en-US')} ${words}` : '';
  return [
    Number.isSafeInteger(task.rejections) && task.rejections > 0 ? `${task.rejections} rejected` : '',
    Number.isSafeInteger(task.maxTurns) ? `Web research turn ${task.toolTurns || 0} of ${task.maxTurns}` : countOf(task.toolTurns, 'tool turns'),
  ].filter(Boolean);
}

function deriveTaskInner({ activity, requestId }) {
  const snapshot = object(activity), task = object(object(snapshot.tasks)[requestId]);
  const blocked = snapshot.paused === true || Boolean(snapshot.usageLimit);
  const pausedHeadline = snapshot.usageLimit ? 'Paused until Claude usage resets' : 'Paused until Claude is available';
  const base = { steps: [], tone: 'working', contextLabel: '', summary: '', detail: '', since: null, startedAt: null, lastHeard: null, action: null, actionLabel: null };
  if (!task.state) {
    return { ...base, kind: 'claude-queued', tone: blocked ? 'attention' : 'working',
      headline: blocked ? pausedHeadline : 'Waiting for Claude to pick this up' };
  }
  const round = Number.isSafeInteger(task.round) && task.round > 1 ? `round ${task.round}` : '';
  const contextLabel = [titleCase(task.model), task.effort ? `${task.effort} effort` : '', round].filter(Boolean).join(' · ');
  const running = Number.isSafeInteger(snapshot.running) ? snapshot.running : 0;
  const waiting = Number.isSafeInteger(snapshot.waiting) ? snapshot.waiting : 0;
  const summary = [...taskLiveCounts(task),
    running + waiting > 1 ? `${running} tasks running · ${waiting} waiting for a slot` : '',
  ].filter(Boolean).join(' · ');
  const steps = taskSteps(task);
  const shared = { ...base, steps, contextLabel, summary, since: time(task.phaseStartedAt), startedAt: time(task.firstStartedAt) };
  const heldKeys = Array.isArray(snapshot.held) ? snapshot.held : [];
  const held = heldKeys.includes(requestId) || (task.nodeId && heldKeys.includes(`node:${task.nodeId}`));
  if (held && (task.state === 'queued' || task.state === 'retrying')) {
    return { ...shared, kind: 'claude-queued', tone: 'attention', headline: CLAUDE_PAUSED_HEADLINE, detail: CLAUDE_PAUSED_DETAIL, retryAt: null };
  }
  // A job that names its own stages is headed by the stage; what Claude is
  // doing inside it is the detail. Pauses and retries keep their own headline.
  const stage = typeof task.stage === 'string' && task.stage ? task.stage : '';
  if (task.state === 'queued') {
    if (stage && !blocked) return { ...shared, kind: 'claude-checking', headline: stage };
    return { ...shared, kind: 'claude-queued', tone: blocked ? 'attention' : 'working',
      headline: blocked ? pausedHeadline : 'Waiting for an available Claude slot' };
  }
  if (task.state === 'retrying') {
    const failure = object(task.failure);
    return { ...shared, kind: 'claude-retrying', tone: 'attention', headline: 'Retrying after a failed attempt',
      detail: failure.label ? `${failure.label}.` : '', retryAt: time(failure.retryAt) };
  }
  if (task.state === 'checking') {
    // Between two calls of a staged job the app is doing that stage's own work.
    if (stage) return { ...shared, kind: 'claude-checking', headline: stage };
    return { ...shared, kind: 'claude-checking', headline: "Checking Claude's answer", detail: 'The app is validating this response before continuing.' };
  }
  const [liveHeadline, liveDetail] = taskRunningCopy(task);
  const [headline, detail] = stage ? [stage, liveDetail ? `${liveHeadline}: ${liveDetail}` : liveHeadline] : [liveHeadline, liveDetail];
  return { ...shared, kind: 'claude-writing', tone: task.phase === 'api-retry' ? 'attention' : 'working', headline, detail, lastHeard: time(task.lastActivityAt),
    summary: [held ? CLAUDE_PAUSING_NOTE : '', summary].filter(Boolean).join(' · ') };
}

/** The view for a handoff the Claude task worker holds, from its activity snapshot. */
export function deriveClaudeTaskProgress(input) {
  try { return deriveTaskInner(object(input)); }
  catch { return { kind: 'claude-queued', steps: [], tone: 'working', contextLabel: '', summary: '', headline: 'Waiting for Claude to pick this up', detail: '', since: null, startedAt: null, lastHeard: null, action: null, actionLabel: null }; }
}

// Long enough that a slow web page or a long think is not called silence.
export const CLAUDE_STALE_AFTER_MS = 120_000;

export function claudeProgressTimeLines(view, now) {
  try {
    const clock = time(now), since = time(view?.since), startedAt = time(view?.startedAt), heard = time(view?.lastHeard), retryAt = time(view?.retryAt);
    const duration = start => clock !== null && start !== null ? formatProgressDuration(Math.max(0, clock - start)) : null;
    let heardLine = null;
    if (heard !== null && clock !== null) {
      const ms = Math.max(0, clock - heard);
      heardLine = CLAUDE_PROGRESS_COPY.lastHeard(ms < 2000 ? CLAUDE_PROGRESS_COPY.justNow : CLAUDE_PROGRESS_COPY.ago(formatProgressDuration(ms)));
    } else if (since !== null && !['claude-checking', 'claude-queued', 'claude-retrying'].includes(view?.kind)) heardLine = CLAUDE_PROGRESS_COPY.notHeardYet;
    const next = retryAt !== null && clock !== null
      ? (retryAt > clock ? `Next attempt in ${formatProgressDuration(retryAt - clock)}` : 'Next attempt now') : null;
    return { total: duration(startedAt) ? `Total elapsed: ${duration(startedAt)}` : null,
      elapsed: duration(since) ? `${view?.kind === 'claude-queued' ? 'Waiting' : 'This action'}: ${duration(since)}` : null, heard: heardLine,
      next, stale: heard !== null && clock !== null && clock - heard >= CLAUDE_STALE_AFTER_MS };
  } catch { return { total: null, elapsed: null, heard: null, next: null, stale: false }; }
}
