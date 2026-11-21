import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { validatePracticeFeedback } from '../../ipc/interviewQaPractice.js';
import { buildReviewPrompt, candidateAnswerKinds, pickedCards, REVIEW_MOMENT_KINDS, REVIEW_SCHEMA } from './reviewPrompt.js';
import { prosodyByEntry } from '../audio/callMetrics.js';
import { buildChapters } from './chapters.js';

// Opus at medium effort: the review is a judgement-and-writing task like
// qa-brief, and there is exactly one review call per practice, so it costs one
// prompt and response rather than a batch that would need a cheaper model.
const REVIEW_PROFILE = Object.freeze({ model: 'opus', effort: 'medium' });
const MAX_FEEDBACK_RETRIES = 1;
const list = value => (Array.isArray(value) ? value : []);
const clockMs = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const reason = error => (typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : String(error));

/** Lazy defaults: the parallel audio, Scribe and Claude modules need not exist for tests. */
async function resolveClients(deps) {
  const transcribe = deps.transcribe ?? await (async () => {
    const [scribe, keys] = await Promise.all([import('../eleven/scribe.js'), import('../eleven/elevenKey.js')]);
    const verbatim = scribe.transcribeVerbatim ?? scribe.default;
    const readKey = keys.readElevenLabsKey ?? keys.default;
    return async request => verbatim({ ...request, key: await readKey({ execFile: deps.execFile }) });
  })();
  const metrics = deps.metrics ?? await (async () => {
    const audio = await import('../audio/callMetrics.js');
    const compute = audio.callMetrics ?? audio.default;
    return request => compute(request);
  })();
  const callText = deps.callText ?? await (async () => {
    const { createInterviewClaudeTransport } = await import('../../ipc/interviewClaudeTransport.js');
    const transport = createInterviewClaudeTransport();
    return request => transport.callText(request.prompt, { task: 'practice-review', claudeStage: 'qa-practice-review', responseSchema: request.schema });
  })();
  return { transcribe, metrics, callText };
}

/** Scribe's verbatim words, bucketed into the candidate answer whose span holds them. */
export function wordsByAnswer(transcript, words) {
  const answers = transcript.map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn?.speaker === 'candidate' && clockMs(turn.startMs) !== null);
  const buckets = {};
  for (const word of list(words)) {
    const at = clockMs(word?.startMs) ?? clockMs(word?.start);
    if (at === null) continue;
    const hit = answers.find(({ turn }) => at >= turn.startMs && at <= (clockMs(turn.endMs) ?? Infinity));
    if (!hit) continue;
    (buckets[hit.index] ??= []).push(word);
  }
  return buckets;
}

// A question named in an error is set in «» so a bug report can drop it whole, whatever quotes it holds.
const quoteQuestion = question => `«${String(question ?? '').replace(/[«»]/gu, '')}»`;
const sameText = (left, right) => String(left ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === String(right ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Hold feedback.planned to the cards the call picked: one entry per picked card in plan order, the
 * question copied exactly, `asked` as the engine counted it. Entries that match no picked card (or
 * repeat one) are dropped; a missing card the engine did not ask is added as unasked; a missing card
 * that was asked is an error so the reviewer is told to redo it. The unprepared question is kept when
 * the reviewer reported it and not invented when it did not.
 */
export function repairPlanned(planned, picked) {
  const entries = list(planned);
  const out = [];
  for (const card of picked) {
    const hit = entries.find(entry => sameText(entry.question, card.question));
    if (!hit) {
      if (card.unprepared) continue;
      if (card.asked !== false) return { error: `feedback.planned has no entry for card ${card.number} (${quoteQuestion(card.question)}), which the call asked; list one entry per picked card` };
      out.push({ question: card.question, asked: false, askedAs: '', score: null, covered: '', adapted: '', improve: '', extension: '' });
      continue;
    }
    const asked = card.unprepared || card.asked === null ? hit.asked : card.asked;
    if (asked && !hit.asked) return { error: `feedback.planned marks card ${card.number} (${quoteQuestion(card.question)}) as not asked, but the call asked it; judge the answer to it` };
    out.push(asked ? { ...hit, question: card.question, asked } : { question: card.question, asked: false, askedAs: '', score: null, covered: '', adapted: '', improve: '', extension: '' });
  }
  return { planned: out };
}

/** Validate the review reply: feedback plus turn-index anchors inside the transcript; `picked` (see pickedCards) holds planned to the picked cards. */
export function checkReview(raw, transcript, picked = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the review reply was not a JSON object' };
  let feedback;
  try {
    feedback = validatePracticeFeedback(raw.feedback);
  } catch (error) {
    return { error: `feedback: ${reason(error)}` };
  }
  if (Array.isArray(picked) && picked.length) {
    const repaired = repairPlanned(feedback.planned, picked);
    if (repaired.error) return { error: repaired.error };
    feedback = { ...feedback, planned: repaired.planned };
  }
  if (!Array.isArray(raw.chapters)) return { error: 'chapters must be an array' };
  const chapters = [];
  const seen = new Set();
  for (const entry of raw.chapters) {
    const index = entry?.questionTurnIndex;
    if (!Number.isInteger(index) || index < 0 || index >= transcript.length) return { error: `chapters: ${JSON.stringify(index)} is not a transcript turn index` };
    if (transcript[index]?.speaker !== 'interviewer') return { error: `chapters: turn ${index} is not an interviewer turn` };
    if (seen.has(index)) return { error: `chapters: turn ${index} is listed twice` };
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) return { error: `chapters: turn ${index} needs a title` };
    seen.add(index);
    chapters.push({ questionTurnIndex: index, title });
  }
  if (!Array.isArray(raw.moments)) return { error: 'moments must be an array' };
  const moments = [];
  for (const entry of raw.moments) {
    const index = entry?.turnIndex;
    if (!Number.isInteger(index) || index < 0 || index >= transcript.length) return { error: `moments: ${JSON.stringify(index)} is not a transcript turn index` };
    if (!REVIEW_MOMENT_KINDS.includes(entry.kind)) return { error: `moments: kind must be one of ${REVIEW_MOMENT_KINDS.join(', ')}` };
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!label) return { error: `moments: turn ${index} needs a label` };
    moments.push({ turnIndex: index, label, kind: entry.kind });
  }
  return { review: { feedback, chapters, moments } };
}

/** Filler totals: the review's counted total, with filler moments split per answer. */
export function fillerTotals({ feedback, moments = [], transcript = [], durationMs = 0 }) {
  const answers = transcript.map((turn, index) => ({ turn, index })).filter(({ turn }) => turn?.speaker === 'candidate');
  const starts = answers.map(({ turn }) => clockMs(turn.startMs) ?? 0);
  const byAnswer = answers.map(() => 0);
  for (const moment of list(moments)) {
    if (moment?.kind !== 'filler') continue;
    const at = clockMs(transcript[moment.turnIndex]?.startMs) ?? 0;
    let slot = -1;
    starts.forEach((start, position) => { if (start <= at) slot = position; });
    if (slot >= 0) byAnswer[slot] += 1;
  }
  const reported = feedback?.delivery?.fillerCount;
  const total = Number.isInteger(reported) && reported >= 0 ? reported : byAnswer.reduce((sum, count) => sum + count, 0);
  const perMinute = durationMs > 0 ? Math.round((total / (durationMs / 60_000)) * 10) / 10 : 0;
  return { total, perMinute, byAnswer };
}

/** Write analysis.json atomically (temp file, 0600, then rename). */
async function writeAnalysis(callDir, analysis, io = {}) {
  const mkdir = io.mkdir ?? nodeFs.mkdir;
  const writeFile = io.writeFile ?? nodeFs.writeFile;
  const rename = io.rename ?? nodeFs.rename;
  const unlink = io.unlink ?? nodeFs.unlink;
  const target = path.join(callDir, 'analysis.json');
  const temp = path.join(callDir, `.analysis.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await mkdir(callDir, { recursive: true });
  try {
    await writeFile(temp, `${JSON.stringify(analysis, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return target;
}

export async function analyzeCall({ callDir, callRecord = {}, plan, brief, deps = {} } = {}) {
  if (typeof callDir !== 'string' || !callDir) throw new Error('analyzeCall needs the call directory.');
  if (!callRecord || typeof callRecord !== 'object') throw new Error('analyzeCall needs the call record.');
  const transcript = list(callRecord.transcript);
  const durationMs = clockMs(callRecord.durationMs) ?? transcript.reduce((max, turn) => Math.max(max, clockMs(turn?.endMs) ?? 0), 0);
  const createdAt = (deps.now ?? (() => new Date().toISOString()))();
  const clients = await resolveClients(deps);

  // Progress for the call window; a listener that throws never stops the analysis.
  const stage = name => { try { deps.onStage?.(name); } catch { /* display only */ } };
  // Diagnostics for the call's debug log (and so bug reports): states, sizes, durations and error
  // text, never transcript or feedback content. A listener that throws never stops the analysis.
  const now = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const begun = now();
  const elapsed = (from = begun) => Math.round(now() - from);
  const event = (name, fields) => { try { deps.onEvent?.(name, fields); } catch { /* diagnostics only */ } };
  event('begin', {
    transcriptEntries: transcript.length, durationMs, planCards: list(plan).length,
    hasBrief: !!brief, toneSamples: list(callRecord.toneSamples).length, prosodySamples: list(callRecord.candidateProsody).length,
    clients: { transcribe: !!deps.transcribe, metrics: !!deps.metrics, callText: !!deps.callText },
  });

  let words = [];
  let transcriptionError = null;
  // A call with no live speech has a silent candidate track: there is nothing to transcribe,
  // and the review is not told that transcription failed.
  const answerKinds = candidateAnswerKinds(transcript);
  // Only the microphone has anything to transcribe: a line the voice spoke is not on the candidate track.
  const nothingSpoken = answerKinds.live === 0;
  event('answers', { ...answerKinds });
  if (!nothingSpoken) {
    stage('transcribing');
    const started = now();
    try {
      const scribed = await clients.transcribe({ path: path.join(callDir, 'candidate.wav') });
      words = list(scribed?.words);
      event('transcription', { ms: elapsed(started), words: words.length });
    } catch (error) {
      // Scribe failing only costs the word-level view; the call still gets metrics and a review.
      transcriptionError = reason(error);
      event('transcription', { ms: elapsed(started), failed: true, error: transcriptionError, code: error?.code ?? null, status: error?.status ?? null });
    }
  } else {
    event('transcription', { skipped: 'nothing-spoken' });
  }
  let metrics = null;
  let metricsError = null;
  stage('metrics');
  const metricsStarted = now();
  try {
    metrics = await clients.metrics({
      transcript,
      candidateProsody: list(callRecord.candidateProsody),
      baselineSnapshot: callRecord.voiceBaseline ?? null,
      ...(callRecord.voicedBaseline ? { voicedBaselineSnapshot: callRecord.voicedBaseline } : {}),
    });
    event('metrics', { ms: elapsed(metricsStarted), keys: metrics && typeof metrics === 'object' ? Object.keys(metrics).slice(0, 30) : [] });
  } catch (error) {
    metricsError = reason(error);
    event('metrics', { ms: elapsed(metricsStarted), failed: true, error: metricsError });
  }
  const wordsByTurn = wordsByAnswer(transcript, words);
  event('words-by-answer', { answersWithWords: Object.keys(wordsByTurn).length, wordsPlaced: Object.values(wordsByTurn).reduce((sum, bucket) => sum + bucket.length, 0), wordsTotal: words.length });
  // analysis.json key order follows the build doc.
  const compose = ({ status, chapters, fillers, error: failure }) => ({
    callId: callRecord.callId, status, createdAt, metrics, chapters,
    toneTimeline: list(callRecord.toneSamples), fillers,
    ...(failure ? { error: failure } : {}),
    ...(metricsError ? { metricsError } : {}),
  });

  const picked = pickedCards(callRecord, plan);
  event('picked', {
    cards: list(picked).length, asked: list(picked).filter(card => card?.asked === true).length,
    unasked: list(picked).filter(card => card?.asked === false).length, unprepared: list(picked).some(card => card?.unprepared),
    wholePlanPrompt: !(Array.isArray(picked) && picked.length),
  });
  let checked = null;
  let error = null;
  stage('review');
  for (let attempt = 0; attempt <= MAX_FEEDBACK_RETRIES && !checked; attempt += 1) {
    const request = { prompt: buildReviewPrompt({ callRecord, plan, brief, metrics, wordsByTurn, transcriptionError, correction: error }),
      schema: REVIEW_SCHEMA, profile: REVIEW_PROFILE };
    const started = now();
    event('review-request', { attempt: attempt + 1, promptChars: request.prompt.length, correction: !!error, model: REVIEW_PROFILE.model, effort: REVIEW_PROFILE.effort });
    let raw;
    try {
      raw = await clients.callText(request);
    } catch (thrown) {
      error = `the review call failed: ${reason(thrown)}`;
      event('review-reply', { attempt: attempt + 1, ms: elapsed(started), outcome: 'call-failed', error, code: thrown?.code ?? null, status: thrown?.status ?? null });
      continue;
    }
    const replyShape = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { keys: Object.keys(raw).slice(0, 20), chapters: Array.isArray(raw.chapters) ? raw.chapters.length : null, moments: Array.isArray(raw.moments) ? raw.moments.length : null, planned: Array.isArray(raw.feedback?.planned) ? raw.feedback.planned.length : null }
      : { type: Array.isArray(raw) ? 'array' : typeof raw };
    const checkedAttempt = checkReview(raw, transcript, picked);
    if (checkedAttempt.review) {
      checked = checkedAttempt.review;
      event('review-reply', { attempt: attempt + 1, ms: elapsed(started), outcome: 'accepted', ...replyShape, keptChapters: checked.chapters.length, keptMoments: checked.moments.length, keptPlanned: list(checked.feedback?.planned).length });
    } else {
      error = checkedAttempt.error;
      event('review-reply', { attempt: attempt + 1, ms: elapsed(started), outcome: 'rejected', error, ...replyShape });
    }
  }
  if (!checked) {
    const analysis = compose({ status: 'failed', chapters: [], fillers: { total: 0, perMinute: 0, byAnswer: [] }, error });
    await writeAnalysis(callDir, analysis, deps);
    event('done', { status: 'failed', ms: elapsed(), error });
    return { analysis, feedback: null };
  }

  // The call clock starts at the answer but every transcript time is on the recording's
  // timeline, which began earlier; the chapters live on the recording's timeline.
  const timelineMs = Math.max(durationMs + (clockMs(callRecord.recordingLeadMs) ?? 0), transcript.reduce((max, turn) => Math.max(max, clockMs(turn?.endMs) ?? 0), 0));
  const chapters = buildChapters({
    transcript, reviewChapters: checked.chapters, moments: checked.moments, metrics,
    candidateProsodyByTurn: prosodyByEntry(transcript, callRecord.candidateProsody), durationMs: timelineMs,
  });
  const analysis = compose({ status: 'ready', chapters, fillers: fillerTotals({ feedback: checked.feedback, moments: checked.moments, transcript, durationMs }) });
  await writeAnalysis(callDir, analysis, deps);
  event('done', { status: 'ready', ms: elapsed(), chapters: chapters.length, fillers: analysis.fillers?.total ?? null, timelineMs, metricsError });
  return { analysis, feedback: { ...checked.feedback, callId: callRecord.callId } };
}
