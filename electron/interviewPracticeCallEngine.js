/**
 * Pure, injectable conversation engine for the live practice-interview call.
 * No I/O: time, sessions, audio and voice are all injected. No word lists: decisions use counts, durations and the classifier.
 */
import { createReplyStreamParser, formatTurnMessage } from './interviewPracticeCallPrompt.js';
import { CUT_IN_OVERLAP_MS, fadeOutTail, firstSpeechSample, mixHeadInto, msSamples } from './practiceCall/audio/cutInMix.js';

export const DEFAULT_CALL_THRESHOLDS = Object.freeze({
  speculateMs: 500,
  commitMs: 1200,
  interruptWords: 2,
  interruptMs: 700,
  silencePromptMs: 20000, // default patience after a reply that carries no <wait>
  typingExpireMs: 6000,
  padIdleMs: 12000, // the candidate stopped typing in the coding pad this long ago: the interviewer, who can see it, gets one look
  padProgressMs: 25000, // while the pad keeps changing, the interviewer sees it this often (from the last time it had the text)
  turnTimeoutMs: 20000,
  classifierTimeoutMs: 2500,
  voiceGateMs: 1200,
  smartTurnHoldBelow: 0.5,
  smartTurnTimeoutMs: 300,
  holdSpeculateMs: 1500,
  holdCommitMs: 2500,
  floorBidAfterMs: 250,
  resumeDelayMs: 250,
  maxResumePauseMs: 1200,
  maxPausedMs: 2500,
  voiceNoteTimeoutMs: 150,
  openerDeadlineMs: 1500, // from the start of the turn: an acknowledgement not known by then is aborted and none is spoken
  // Joining the acknowledgement and the reply. The reply's first sentence is flushed to the voice (spoken without
  // waiting for more text, which the service otherwise does until it has about 8 words) only when the acknowledgement
  // is about to run out: joinFlushLeadMs before its audio ends. When the reply is ready earlier, a natural pause is
  // left after the acknowledgement (JOIN_PAUSE_MS, by how it ended), but only with at least joinGapMinLeadMs of the
  // acknowledgement still to play, since the pause starts a new voice segment that must connect in time.
  joinFlushLeadMs: 900,
  joinGapMinLeadMs: 900,
  // The candidate's voice (a sent chat message spoken on the call). Once this much of a line has been heard, the
  // interviewer is asked whether a real interviewer would cut in, and again every cutInEveryMs after that, while at
  // least cutInMinLeftMs of the line is still to come. A voice that has sent no audio by candidateVoiceStartMs (the
  // tags and the first audio) has failed, and the message reaches the interviewer as typed text instead.
  cutInFirstMs: 12000,
  cutInEveryMs: 10000,
  cutInMinLeftMs: 2500,
  candidateVoiceStartMs: 15000,
});

/** The pause a speaker leaves after a line, by how the line ended: a full stop pauses longer than a comma. */
export const JOIN_PAUSE_MS = Object.freeze({ '.': 450, '!': 450, '?': 550, '…': 650, ',': 220, ';': 300, ':': 300, '—': 280, '–': 280, '-': 280, other: 200 });
/** The pause after a spoken line: its last letter-or-punctuation character decides; tags and closing quotes are skipped. */
export function joinPauseMs(text) {
  const tail = String(text ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/['"”’)\]\s]+$/u, '');
  const last = tail.endsWith('...') ? '…' : tail.slice(-1);
  return JOIN_PAUSE_MS[last] ?? JOIN_PAUSE_MS.other;
}

// Fallback if the helper never reports `cancelled` for a stopped utterance.
const CANCEL_WAIT_MS = 500;
const OFFSET_WINDOW_MS = 2000;
const START_WATCH_MS = 3000;
// A question was practised once this much followed it; fewer words is a greeting, a "say that again?" or nothing.
const ANSWER_MIN_WORDS = 15;
const ANSWER_MIN_PAD_CHARS = 20;
// A line answered with <listen/> joins the candidate's next speech when it resumes within this long: one thought.
const SCREEN_TITLE_CAP = 120;
// Starting to share takes a moment (finding the window, clicking share); swapping what is already shared is quick.
const SCREEN_FIRST_DELAY = { minMs: 2000, maxMs: 20000, defaultMs: 6000 };
const SCREEN_SWAP_DELAY = { minMs: 0, maxMs: 3000, defaultMs: 400 };
// A share that takes this long to set up is real silence in the interviewer's speech: a person busy finding the
// document stays quiet. The voice synthesises the text after the tag as its own segment, so nothing is ever cut.
const SHARE_GAP_MIN_MS = 1000;
// A written pause (<pause s="4"/>) is silence the lead chose: kept within what a call can plausibly hold.
const PAUSE_MIN_MS = 300;
const PAUSE_MAX_MS = 15000;
const SCREEN_CONTENT_CAP = 6000;
const PAD_TEXT_CAP = 20000;
const FINISH_SLACK_MS = 3000;
const OVERLAP_LOOKBACK_MS = 250;
const OVERLAP_WORD_WAIT_MS = 600;
const WAIT_MIN_S = 6;
const WAIT_MAX_S = 300;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Joining it to the reply: an acknowledgement word not yet voiced is counted at this (measured 2026-11-19 on the real
// voices: 13 clips, 320 to 470 ms a word, median about 390), the near-silence after its last word at this until known,
// and a pause shorter than this is not worth a new voice segment.
const ACK_WORD_ESTIMATE_MS = 390;
const ACK_TAIL_ESTIMATE_MS = 150;
const JOIN_GAP_MIN_MS = 60;
const LEADING_TAGS = /^(?:\s*\[[^\]]*\])+\s*/u;
const MAX_SILENCE_CHECKS = 3; // unanswered check-ins before the interviewer gives up and the line drops
const nonSpace = text => String(text ?? '').replace(/\s/g, '').length; // the overlay position unit: whitespace never counts
const tokens = value => String(value ?? '').split(/\s+/).filter(Boolean);
// v4 audio tags such as [laughs] or [sighs] are spoken by the voice but never shown in captions or heard text.
// Delivery tags are free-form ("[warm, faint amusement]"), so anything short in square brackets is one.
const AUDIO_TAG = /\[[^[\]\n]{1,80}\]/g;
const stripAudioTags = value => String(value ?? '').replace(AUDIO_TAG, ' ').replace(/\s+/g, ' ').trim();
// Control positions are compared in letters and digits only, with delivery tags removed from both the
// sentence text and the voice's timed words: the voice reports tags as words (or glued to a word), and
// punctuation or spelling can differ between the text sent and the words timed, so raw characters drift.
const spokenChars = value => String(value ?? '').replace(AUDIO_TAG, '').replace(/[^\p{L}\p{N}]/gu, '').length;
const isCancel = error => error?.name === 'AbortError' || error?.code === 'CANCELLED';
const attempt = fn => { try { return fn(); } catch { return undefined; } };

function parseVerdict(value) {
  const first = tokens(value)[0] || '';
  return first.toLowerCase().replace(/[^a-z]/g, '') === 'interruption' ? 'interruption' : 'acknowledgement';
}

/** Words of `reply` whose end time is at or before the playback position. */
function heardFor(reply, positionMs) {
  return reply.words.filter(word => word.endMs <= positionMs).map(word => word.word).join(' ');
}

const UNHEARD_MAX = 700;

/**
 * What the interviewer had written for a cut-off reply but the candidate never heard, so the next
 * reply can pick the thread up from the right place. Empty when the heard part cannot be lined up
 * with the written text.
 */
function unheardFor(reply) {
  const squeeze = value => stripAudioTags(String(value ?? '')).replace(/\s+/g, ' ').trim();
  const full = squeeze((reply?.parts || []).join(' '));
  const heard = squeeze(reply?.heardText);
  if (!full || !full.startsWith(heard)) return '';
  const rest = full.slice(heard.length).trim();
  return rest.length > UNHEARD_MAX ? `${rest.slice(0, UNHEARD_MAX).trimEnd()}…` : rest;
}

/** Spoken letters and digits in the words of `reply` that have ended by the playback position (tag-only words add none). */
function heardChars(reply, positionMs) {
  let total = 0;
  for (const word of reply.words) if (word.endMs <= positionMs) total += spokenChars(word.word);
  return total;
}

/** The sentence being spoken at a playback position, judged from word counts. */
function sentenceAt(reply, positionMs) {
  if (!reply.parts.length) return '';
  const index = reply.words.findIndex(word => word.endMs > positionMs);
  if (index < 0) return reply.parts[reply.parts.length - 1];
  let seen = 0;
  for (const part of reply.parts) {
    seen += tokens(part).length;
    if (index < seen) return part;
  }
  return reply.parts[reply.parts.length - 1];
}

/** "just now", "about 3 minutes ago": how long ago the missed ring was, the way a person would put it. */
function agoWords(agoMs) {
  const seconds = Math.max(0, Number(agoMs) || 0) / 1000;
  if (seconds < 45) return 'a moment ago';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

/**
 * The first message of the call. A plain call is [call connected]; a returned call says so inside
 * the same marker, with what happened to the first ring and how long ago.
 */
export function connectedMarker(callback) {
  const how = callback?.how;
  if (how !== 'declined' && how !== 'unanswered') return '[call connected]';
  const earlier = how === 'declined' ? 'You called them and they declined the call' : 'You called them and it rang out with no answer';
  return `[call connected: the candidate is calling you back. ${earlier} ${agoWords(callback.agoMs)}.]`;
}

export function createPracticeCallEngine({
  clock, sessions, restartSession, audio, voice, ear = null,
  thresholds = DEFAULT_CALL_THRESHOLDS, onEvent = () => {}, newId, panel = null,
  formatTurn = formatTurnMessage, // seam for tests: they assert on the options passed
  createParser = createReplyStreamParser, // seam for tests; the main reply is the only stream that carries asked tags
  prepared = {}, // { [ref]: { parts: [{ title, content }] } }: screens written before the call, shown by reference
  callback = null, // { how: 'declined' | 'unanswered', agoMs }: the candidate is returning a call they missed
  // The candidate's voice: when given, a sent chat message is spoken on the call and the interviewer hears it as a
  // spoken line. `open({ utteranceId, text, signal })` → { sampleRate, onAudio, onWords, cancel, done }.
  candidateVoice = null,
}) {
  const th = { ...DEFAULT_CALL_THRESHOLDS, ...thresholds };
  const live = { opener: sessions.opener, main: sessions.main, classifier: sessions.classifier };
  const transcript = [];
  const segments = new Map();
  const handles = new Set();
  const named = { spec: null, commit: null, silence: null, typing: null, padIdle: null, padTyping: null };
  const classifierControllers = new Set();
  let phase = 'connecting';
  let startedAt = null;
  let offset = null; // clock ms minus helper ms (max seen in the first OFFSET_WINDOW_MS of events, then frozen)
  let offsetSince = null;
  let turnStartMs = -Infinity;
  let pendingTyped = []; // sent messages not yet committed: { text, generated } (generated: written by Suggest a reply)
  let padText = ''; // the candidate's current pad text (capped)
  let padSent = ''; // the pad text the main session last received (set when a reply is delivered)
  let padEditedAt = null; // clock ms of the last pad edit that changed the text
  let padDirty = false; // the pad was edited (live) since the interviewer last received its text
  let padDirtySince = null; // clock ms of the first such edit
  let padSentAt = null; // clock ms the interviewer last received the pad text, by any route
  let screenShown = null; // { title, content, speakerId } while the interviewer shares their screen
  let padState = { open: false, lang: '' };
  let cutOffNote = null; // prefix for the next main message after a partial main failure
  let mainRestart = null;
  let overlapWait = null;
  let overlapRecord = null; // the live overlap record, kept after the vad ends so a pause can end it
  let speaking = false;
  let candidateSpoke = false;
  let lastVadEndMs = null;
  let typingNow = false;
  let paused = false; // hidden pause: silence accounting and the elapsed time the interviewer sees stand still
  let pausedAt = null;
  let pausedTotalMs = 0;
  let silencePrompts = 0; // silence prompts sent since the candidate last said or typed anything
  let silenceTotalMs = 0;
  let patienceS = null; // seconds of normal silence after the last delivered reply (its <wait>); null = the default
  let nextGapMs = null; // a check-in reply's own <wait>: the gap to the next check-in, once
  let notSpoken = false;
  const askedQuestions = []; // plan numbers in first-asked order
  const answeredQuestions = []; // asked questions the candidate went on to answer
  let openQuestions = []; // the questions asked last, still waiting for an answer
  let answerWords = 0; // words the candidate has said or typed since those were asked
  let padAtAsk = 0; // length of the pad text when they were asked
  let pendingAcks = [];
  let pendingInterruption = null;
  let current = null; // reply being generated, committed or played
  let said = null; // the candidate's voice line being spoken (see speakTyped)
  let voicedDone = []; // candidate voice lines heard in full or in part that no reply has answered yet
  let voicedHeld = false; // a voice line ended during a pause: the interviewer answers it on resume
  let cancelling = null; // reply stopped, waiting for the helper's cancelled event
  let overlap = null;
  let audioHint = false; // Smart Turn said the candidate sounds unfinished: opener-only [audio: ...] hint
  let generation = 0;
  // Panel calls only: who is on the call, who holds the floor (spoke last), and names not yet announced to the model.
  const speakers = panel && Array.isArray(panel.speakers) ? panel.speakers.map(item => ({ ...item })) : null;
  const leadId = panel?.leadId ?? 'A';
  let floor = leadId;
  let joinedQueue = [];
  let unknownScreens = []; // prepared-screen refs the lead named that do not exist; told once, like unknownPending
  let unknownPending = false; // the lead wrote lines for someone never on this call; it is told once, like absentQueue
  let absentQueue = []; // ids of cast colleagues the lead gave the floor to before they joined; the lead is told once

  const now = () => clock.now();
  const currentPauseMs = () => pausedTotalMs + (paused && pausedAt !== null ? now() - pausedAt : 0);
  // Conversational elapsed time (shown to the interviewer) excludes paused time. The helper timeline
  // (offset, transcript and audio times) is a clock-minus-offset mapping and is deliberately never shifted
  // by a pause: the helper keeps recording real audio while paused, so shifting it would misalign entries.
  const elapsed = () => (startedAt === null ? 0 : now() - startedAt - currentPauseMs());
  const rawElapsed = () => (startedAt === null ? 0 : now() - startedAt);
  const toClock = ms => (offset === null || ms === null || ms === undefined ? null : ms + offset);
  // Only vad, level and playback events latch the offset: delivery delay only adds, so keep the max, then freeze.
  const noteHelperTime = atMs => {
    if (!Number.isFinite(atMs)) return;
    const candidate = now() - atMs;
    if (offset === null) { offset = candidate; offsetSince = now(); return; }
    if (now() - offsetSince <= OFFSET_WINDOW_MS && candidate > offset) offset = candidate;
  };
  const emit = event => { attempt(() => onEvent(event)); };

  function setPhase(next) {
    if (phase === next || phase === 'ended') return;
    phase = next;
    emit({ type: 'phase', phase });
  }

  function schedule(ms, fn) {
    const handle = clock.setTimeout(() => { handles.delete(handle); if (phase !== 'ended') fn(); }, Math.max(0, ms));
    handles.add(handle);
    return handle;
  }
  function unschedule(handle) {
    if (handle !== null && handle !== undefined && handles.delete(handle)) clock.clearTimeout(handle);
  }
  function arm(name, ms, fn) {
    unschedule(named[name]);
    named[name] = schedule(ms, () => { named[name] = null; fn(); });
  }
  function disarm(name) { unschedule(named[name]); named[name] = null; }

  const addEntry = entry => { transcript.push(entry); return entry; };
  // Helper-timeline ms for transcript entries: helper ms = clock ms - offset, else the elapsed call time.
  const helperTimelineMs = () => Math.round(offset === null ? rawElapsed() : now() - offset);
  const timedEntry = (entry, atMs) => addEntry({ ...entry, startMs: atMs, endMs: atMs });
  /** Helper-timeline span of the spoken words since `fromMs`: first word start to last word end. */
  function candidateSpan(fromMs = turnStartMs) {
    let start = null;
    let end = null;
    for (const item of segments.values()) {
      if (!(item.startMs >= fromMs)) continue;
      if (start === null || item.startMs < start) start = item.startMs;
      if (Number.isFinite(item.endMs) && (end === null || item.endMs > end)) end = item.endMs;
    }
    const fallback = Number.isFinite(lastVadEndMs) ? lastVadEndMs : helperTimelineMs();
    const from = start ?? fallback;
    return { startMs: Math.round(from), endMs: Math.round(Math.max(from, end ?? from)) };
  }
  // An interviewer entry spans playback start to playback end (or the cut point).
  function setEntryEnd(reply, endMs) {
    if (!reply.entry || !Number.isFinite(endMs)) return;
    reply.entry.endMs = Math.max(reply.entry.startMs, Math.round(endMs));
  }
  const lineOf = entry => {
    if (entry.speaker === 'interviewer') {
      // On a panel call a restarted session must be able to tell who said what.
      const nameOf = id => speakers?.find(item => item.id === id)?.name || 'Interviewer';
      if (speakers && Array.isArray(entry.segments) && entry.segments.length > 1) return entry.segments.map(item => `${nameOf(item.speakerId)}: '${item.text}'`).join('\n');
      return `${speakers && entry.speakerId ? nameOf(entry.speakerId) : 'Interviewer'}: '${entry.text}'`;
    }
    return `${entry.channel === 'chat' && !entry.voiced ? 'Candidate (typed in chat)' : 'Candidate'}: '${entry.text}'`;
  };

  function candidateText(fromMs = turnStartMs) {
    return [...segments.values()].filter(item => item.startMs >= fromMs)
      .sort((a, b) => a.startMs - b.startMs).map(item => item.text.trim()).filter(Boolean).join(' ');
  }
  // The helper's VAD onset can trail the recogniser's start, so look back a little.
  const overlapText = record => candidateText(record.startMs - OVERLAP_LOOKBACK_MS);
  const lastSpoken = () => {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index];
      if (entry.speaker === 'interviewer' && entry.channel !== 'chat' && !entry.overlay && entry.text) return stripAudioTags(entry.text);
    }
    return undefined;
  };

  // ---- replies -------------------------------------------------------------
  function abortReply(reply) {
    unschedule(reply.cancelTimer);
    reply.cancelTimer = null;
    unschedule(reply.startTimer);
    reply.startTimer = null;
    unschedule(reply.finishTimer);
    reply.finishTimer = null;
    unschedule(reply.gateTimer);
    reply.gateTimer = null;
    unschedule(reply.openerTimer);
    cancelJoinFlush(reply);
    reply.openerTimer = null;
    reply.voiceQueue = [];
    reply.buffered = [];
    attempt(() => reply.ctl.opener.abort());
    attempt(() => reply.ctl.main.abort());
    attempt(() => reply.ctl.voice.abort());
    attempt(() => reply.stream?.cancel());
  }

  function emitDiscarded(reply, reason) {
    emit({ type: 'discarded', voiceCharsSent: reply.voiceCharsSent, reason });
  }

  function discardPending(markNotSpoken, reason = 'resumed') {
    const reply = current;
    current = null;
    if (reply) { abortReply(reply); emitDiscarded(reply, reason); }
    if (markNotSpoken) notSpoken = true;
    setPhase('listening');
  }

  /** The interviewer has now been told this pad text (by a delivered turn, or by a progress message it watched in silence). */
  function markPadReceived(reply) {
    if (reply.padSnapshot === null || !reply.padCarried) return;
    if (reply.padSnapshot !== padSent) emit({ type: 'pad-sent', text: reply.padSnapshot, atMs: helperTimelineMs() });
    padSent = reply.padSnapshot;
    padSentAt = now();
    padDirty = padText !== padSent; // edits made while the reply was being made are still owed
    padDirtySince = padDirty ? padSentAt : null;
  }

  /**
   * A line the interviewer answered with only <pass/> is finished and needs no reply ("okay", "thanks"): it is kept in the
   * transcript as its own entry and the message that carried it counts as delivered. It is never joined to what the
   * candidate says next, never resent, never carried by a later typed message. The interviewer's last <wait> stays in
   * force unless this reply wrote its own. (<listen/> is the other silence: the line is unfinished and is not kept here.)
   * A typed line follows the same rule: a sent message is finished, so <listen/> on it counts as <pass/>.
   */
  function keepPassedLine(reply) {
    const span = candidateSpan();
    noteAnswer(reply.candidates);
    for (const entry of reply.candidates) addEntry({ ...entry }); // a typed turn's entries include any spoken words it overtook
    turnStartMs = Math.max(turnStartMs, span.endMs + 1);
    if (reply.typed) { pendingTyped = []; markTurnConsumed(); }
    candidateSpoke = false;
    markNotesDelivered(reply);
    if (reply.padSnapshot !== null) markPadReceived(reply);
    if (reply.wait !== null) noteWait(reply);
  }

  /**
   * The reply is dropped and nothing is spoken. kind 'listen': the candidate sounds unfinished, so the words stay
   * unconsumed and join whatever the candidate says next, however long the pause. kind 'pass': the line is finished.
   */
  function discardSilent(reply, kind) {
    if (current !== reply) return;
    if (reply.padProgress) markPadReceived(reply); // watched in silence: it left no trace, but it did see the text
    current = null;
    abortReply(reply);
    emitDiscarded(reply, kind);
    disarm('commit');
    if (kind === 'pass' && reply.candidates.length) keepPassedLine(reply);
    setPhase('listening');
    armSilence();
  }

  async function restart(kind, pending = []) {
    emit({ type: 'session-restart', kind });
    try {
      // `pending` are entries of the turn being answered that are not in the transcript yet.
      const lines = [...transcript, ...pending].map(lineOf);
      if (kind === 'main') {
        // A new main session knows only what the history says: what it is showing and that the pad is open.
        if (screenShown) lines.push(`[Your shared screen is showing "${screenShown.title}":\n${screenShown.content}\n]`);
        if (padState.open) lines.push('[The coding pad is open.]');
        padSent = null; // the pad text goes out again with the next turn
      }
      const history = lines.join('\n');
      const next = await restartSession(kind, { transcriptText: history });
      if (phase === 'ended') { attempt(() => next?.close?.()); return false; }
      live[kind] = next; // always adopt: only the resend is fenced by the caller
      return true;
    } catch {
      return false;
    }
  }

  function createReply({ immediate, greeting, typed, candidates, lastWordAt, respeculated, specTokens, handover = false }) {
    generation += 1;
    return {
      handover, absent: [], unknown: false, dropping: false, voiceFailed: false,
      id: generation, utteranceId: newId(), immediate, greeting, typed, candidates, respeculated, specTokens,
      mainSentences: [], positionAt: null, startTimer: null, finishTimer: null, audioBytes: 0,
      commitDue: immediate, committed: false, done: false, silent: false, gotAudio: false,
      buffered: [], words: [], parts: [], chats: [], controls: [], deliveredControls: 0, padSnapshot: null, endCall: false,
      voiceDone: false, finishCalled: false, endSent: false,
      gateOpen: immediate, gateTimer: null, voiceQueue: [], voiceCharsSent: 0, finishDeferred: false,
      mainDone: false, mainListen: false, mainPass: false, mainForwarded: 0,
      openerSettled: greeting, noteSettled: true, mainStarted: false, voiceNote: '', ackText: '', openerTimer: null,
      ctl: { opener: new AbortController(), main: new AbortController(), voice: new AbortController() },
      stream: null, sampleRate: null, entry: null, heardText: undefined,
      wait: null, heldPause: null, textSinceGap: false, unknownScreens: [], heldTurn: false, checkIn: false, padProgress: false, segChars: 0, parserChars: 0, gapParserChars: 0, heldTag: '', openerChars: 0, openerInSegment: false, joinFlushTimer: null, joinFlushAtGate: false, joinPauseMs: 0, overlayCaption: null, overlayCount: 0, overlaysSent: [], overlayStarts: [], overlaysShown: 0,
      asked: [], writer: null, tagged: null, taggedCutIn: false, partSpeakers: [], speakerStarts: [], shownSpeaker: null,
      positionMs: 0, playbackStarted: false, shownInOrder: null, cancelTimer: null, boundaryAfter: [], cancelWait: null, afterCancel: null,
      used: { acks: 0, interruption: null, notSpoken: false },
      spec: { at: now(), lastWordAt, openerFirstDeltaMs: null, mainFirstSentenceMs: null, firstAudioAt: null },
    };
  }

  function beginTurn({
    greeting = false, typed = false, candidates = [], text = '', channel, silenceMs = null, padProgress = null, immediate = false,
    lastWordAt = null, respeculated = 0, specTokens = null, pausedAck = null, spokenText = '', handover = false, cutInCheck = false,
  }) {
    disarm('spec');
    disarm('silence');
    if (immediate) disarm('commit');
    if (current) { const old = current; current = null; abortReply(old); } // never leave an orphan reply
    const reply = createReply({ immediate, greeting, typed, candidates, lastWordAt, respeculated, specTokens, handover });
    reply.heldTurn = audioHint && !greeting; // the ear heard unfinished audio: a listen then means "still mid-thought"
    reply.checkIn = silenceMs !== null && silenceMs !== undefined;
    reply.padProgress = padProgress !== null && padProgress !== undefined;
    // A look at the candidate's voice line while it is still being spoken: the interviewer may cut in or listen on.
    reply.cutIn = cutInCheck;
    current = reply;
    setPhase('speculating');
    reply.used = { acks: pendingAcks.length, interruption: pendingInterruption, notSpoken, cutOff: cutOffNote, joined: greeting ? 0 : joinedQueue.length, absent: greeting ? 0 : absentQueue.length, unknown: greeting ? false : unknownPending, unknownScreens: greeting ? [] : unknownScreens.slice() };
    // The connect message carries no markers: names stay queued for the first real turn.
    const joined = greeting ? [] : joinedQueue.slice();
    const prefix = cutOffNote ?? '';
    reply.mainPrefix = prefix;
    const heldTurn = audioHint && !greeting; // Smart Turn hold: the voice gate is re-armed with the held schedule below
    const hint = heldTurn ? '[audio: sounds unfinished]' : null;
    audioHint = false;
    const presence = presenceNow();
    const absentHandover = greeting ? [] : handoverNames();
    const unknownSpeaker = !greeting && unknownPending;
    if (greeting) reply.messages = { main: `${prefix}[elapsed 00:00] ${connectedMarker(callback)}${presence ? ` ${presenceNote(presence)}` : ''}` };
    else {
      const base = {
        elapsedMs: elapsed(), candidateText: text, channel, silenceMs, acknowledgements: pendingAcks.slice(),
        interruption: pendingInterruption ? { heardText: pendingInterruption.reply.heardText ?? '', unheardText: unheardFor(pendingInterruption.reply) } : null,
        notSpoken, typing: typingNow, spokenText, ...(cutInCheck ? { stillSpeaking: true } : {}), ...(reply.checkIn ? { silenceCheck: silencePrompts } : {}), ...(reply.padProgress ? { padProgress } : {}), ...(joined.length ? { joined } : {}),
        ...(presence ? { presence } : {}), ...(absentHandover.length ? { absentHandover } : {}), ...(unknownSpeaker ? { unknownSpeaker: true } : {}), ...(!greeting && unknownScreens.length ? { unknownScreen: unknownScreens.slice() } : {}),
        ...(padText !== padSent ? { padText } : {}),
      };
      reply.padSnapshot = padText;
      reply.padCarried = padText !== padSent && pausedAck === null;
      reply.turnBase = base;
      // A silence prompt or pad progress answers nothing the candidate said, so there is nothing to acknowledge first.
      // Nor does a cut-in: the interviewer is taking the floor, not reacting to a finished answer.
      const withOpener = !reply.checkIn && !reply.padProgress && !handover && !cutInCheck;
      reply.pausedAck = pausedAck;
      reply.messages = {
        // The short opening reaction never needs the pad's code or the unheard rest of a cut-off reply, so only the main message carries them.
        ...(withOpener ? { opener: formatTurn({ ...base, ...(base.interruption ? { interruption: { heardText: base.interruption.heardText } } : {}), padText: undefined, unknownScreen: undefined, lastSpoken: lastSpoken(), audioHint: hint }) } : {}),
      };
      if (!withOpener) reply.openerSettled = true;
    }
    if (pausedAck !== null) reply.openerSettled = true;
    reply.noteSettled = typed || greeting || pausedAck !== null || handover || cutInCheck;
    try {
      reply.stream = voice.open({ utteranceId: reply.utteranceId, signal: reply.ctl.voice.signal, ...(speakers ? { speakerId: floor } : {}) });
    } catch {
      current = null;
      abortReply(reply);
      emit({ type: 'error', code: 'voice-open-failed' });
      setPhase('listening');
      armSilence();
      return reply;
    }
    reply.sampleRate = reply.stream.sampleRate;
    reply.stream.onAudio(buffer => onVoiceAudio(reply, buffer));
    reply.stream.onWords(list => {
      if (current !== reply || !Array.isArray(list)) return;
      reply.words.push(...list);
      // Timings that arrive after playback began may be the ones a waiting control needed.
      if (reply.playbackStarted) deliverDueControls(reply, reply.positionMs);
    });
    if (speakers) {
      reply.writer = floor;
      reply.openSpeaker = floor;
      // The voice says when a remark spoken over the current speaker starts; playback position decides when it is shown.
      attempt(() => reply.stream.onOverlay?.(info => {
        if (current !== reply || !info) return;
        reply.overlayStarts.push({ speakerId: info.speakerId, text: reply.overlayCaption ?? stripAudioTags(String(info.text ?? '')).trim(), offsetMs: Number.isFinite(info.offsetMs) ? info.offsetMs : 0 });
        showOverlays(reply, reply.playbackStarted ? reply.positionMs : -1);
      }));
      // The stream says when each speaker's audio starts in the utterance; playback position decides when it is shown.
      attempt(() => reply.stream.onSpeaker?.(info => {
        if (current !== reply || !info || !Number.isFinite(info.startMs)) return;
        reply.speakerStarts.push({ speakerId: info.speakerId, startMs: info.startMs });
        if (reply.playbackStarted) showSpeaker(reply);
      }));
    }
    if (!reply.gateOpen) {
      // Spoken turn: hold text back until the candidate has been silent for voiceGateMs (from the vad end, like commit).
      // On a Smart Turn hold the gate is re-armed at max(voiceGateMs, holdSpeculateMs) from the vad end, so a held turn
      // never reaches its held commit with the text still gated (which would commit a reply the voice never spoke).
      const gateMs = heldTurn ? Math.max(th.voiceGateMs, th.holdSpeculateMs) : th.voiceGateMs;
      const since = Math.max(0, now() - (toClock(lastVadEndMs) ?? now()));
      reply.gateTimer = schedule(gateMs - since, () => { reply.gateTimer = null; openGate(reply); });
    }
    // The main message waits for the acknowledgement's words (so the reply never repeats it) and, on a spoken
    // turn, for the ear's note; both are awaited at once.
    if (reply.messages.opener !== undefined) {
      reply.openerTimer = schedule(th.openerDeadlineMs, () => {
        reply.openerTimer = null;
        if (current !== reply || reply.openerSettled) return;
        attempt(() => reply.ctl.opener.abort());
        finishOpener(reply, 'timeout');
      });
      runOpener(reply);
    }
    if (!reply.noteSettled) requestVoiceNote(reply);
    else maybeStartMain(reply);
    return reply;
  }

  /** The acknowledgement is known (spoken, dropped, passed, timed out or failed): report it once and release the main reply. */
  function finishOpener(reply, outcome, written = '', words = 0) {
    if (reply.openerSettled) return;
    reply.openerSettled = true;
    unschedule(reply.openerTimer);
    reply.openerTimer = null;
    if (outcome === 'spoken') reply.ackText = stripAudioTags(written);
    emit({ type: 'opener', text: written, spoken: outcome === 'spoken', words, ms: Math.round(now() - reply.spec.at), outcome });
    if (outcome === 'listen') return;
    maybeStartMain(reply);
    settle(reply);
  }

  /** Start the main session once both the acknowledgement and (spoken turns) the voice note are known. */
  function maybeStartMain(reply) {
    if (current !== reply || reply.mainStarted || !reply.openerSettled || !reply.noteSettled) return;
    reply.mainStarted = true;
    // Built now, once, so it can carry the acknowledgement's words and the ear's note (the greeting's is set at the start).
    if (reply.turnBase) {
      reply.messages.main = reply.mainPrefix + formatTurn({
        ...reply.turnBase, pausedAck: reply.pausedAck, ...(reply.voiceNote ? { voiceNote: reply.voiceNote } : {}), ...(reply.ackText ? { acknowledgement: reply.ackText } : {}),
      });
    }
    runMain(reply);
  }

  /** Ask the ear how the candidate sounded; a note decorates the MAIN message only. */
  function requestVoiceNote(reply) {
    if (typeof ear?.voiceNote !== 'function') { reply.noteSettled = true; maybeStartMain(reply); return; }
    const startMs = Number.isFinite(turnStartMs) ? turnStartMs : 0;
    const endMs = Number.isFinite(lastVadEndMs) ? lastVadEndMs : startMs;
    let settled = false;
    let timer = null;
    const settle = note => {
      if (settled) return;
      settled = true;
      unschedule(timer);
      if (current !== reply) return; // generation fence: a stale note never reaches a newer turn
      reply.voiceNote = typeof note === 'string' ? note.trim() : '';
      reply.noteSettled = true;
      maybeStartMain(reply);
    };
    timer = schedule(th.voiceNoteTimeoutMs, () => settle(null));
    Promise.resolve().then(() => ear.voiceNote({ startMs, endMs })).then(settle, () => settle(null));
  }

  function transmit(reply, text) {
    reply.voiceCharsSent += text.length;
    attempt(() => reply.stream.sendText(text));
  }

  /** Ask the voice to speak what it has now; behind the silence gate the request waits in the queue with the texts. */
  function flushVoice(reply) {
    if (reply.gateOpen) attempt(() => reply.stream.flush?.());
    else reply.voiceQueue.push({ flush: true });
  }

  /** The silence gate fired: flush the queued texts in order, then run a finish that was waiting on the flush. */
  function openGate(reply) {
    if (current !== reply || reply.gateOpen) return;
    reply.gateOpen = true;
    const queued = reply.voiceQueue;
    reply.voiceQueue = [];
    for (const text of queued) {
      if (typeof text === 'string') transmit(reply, text);
      else if (text.flush) attempt(() => reply.stream.flush?.());
      else if (text.overlay) attempt(() => reply.stream.overlay?.(text.overlay));
      else if (text.gap !== undefined) attempt(() => reply.stream.gap?.(text.gap));
      else attempt(() => (text.cutIn ? reply.stream.setSpeaker?.(text.speakerId, { cutIn: true }) : reply.stream.setSpeaker?.(text.speakerId)));
    }
    // Only the acknowledgement was waiting: speak it now (see runOpener).
    if (queued.length === 1 && queued[0] === reply.flushAfter) attempt(() => reply.stream.flush?.());
    // The reply's first sentence waited with it: flush it joinFlushLeadMs before the acknowledgement and the pause end.
    if (reply.joinFlushAtGate) {
      reply.joinFlushAtGate = false;
      scheduleJoinFlush(reply, Math.max(0, ackRemainingMs(reply) + (reply.joinPauseMs || 0) - th.joinFlushLeadMs));
    }
    if (reply.finishDeferred) { reply.finishDeferred = false; callFinish(reply); }
  }

  function sendVoice(reply, sentence) {
    reply.parts.push(sentence);
    reply.textSinceGap = true;
    reply.partSpeakers.push(reply.writer);
    reply.segChars += nonSpace(sentence);
    if (reply.gateOpen) transmit(reply, sentence);
    else reply.voiceQueue.push(sentence);
    if (reply.entry) {
      refreshEntry(reply);
      emit(captionEvent(reply, false));
    }
  }

  // ---- panel speakers ------------------------------------------------------
  const castMember = id => speakers?.find(item => item.id === id);

  /** Who is on the call and who is not yet, as the lead is told with every message; undefined when everyone is here. */
  function presenceNow() {
    if (!speakers) return undefined;
    const notJoined = speakers.filter(item => !item.present).map(item => item.name);
    if (!notJoined.length) return undefined;
    return { here: speakers.filter(item => item.present).map(item => item.name), notJoined };
  }
  const presenceNote = ({ here, notJoined }) => `[On the call: ${here.join(', ')}. Not joined yet: ${notJoined.join(', ')}.]`;
  /** Names the lead gave the floor to who are still not on the call. */
  const handoverNames = () => absentQueue.map(id => castMember(id)).filter(item => item && !item.present).map(item => item.name);

  function noteAbsent(reply, member) {
    if (!reply.absent.includes(member.id)) reply.absent.push(member.id);
    // Written after delivery began (commit already ran): the lead still has to be told.
    if (reply.committed && !absentQueue.includes(member.id)) absentQueue.push(member.id);
  }

  function noteUnknown(reply) {
    reply.unknown = true;
    if (reply.committed) unknownPending = true;
  }

  /** Whether what the lead writes next is attributed to a cast colleague who has not joined (a pending tag counts). */
  function absentAt(reply) {
    if (reply.tagged !== null) {
      const member = castMember(reply.tagged);
      if (member) return !member.present;
      return !onCall(reply.tagged); // never cast: nobody is on the call under that id
    }
    return reply.dropping;
  }

  /** Whether an id is a person on the call right now; in a solo call only the lead is. */
  function onCall(id) {
    if (!speakers) return id === leadId;
    return castMember(id)?.present === true;
  }

  /**
   * A speaker tag only counts for an interviewer who is on the call; the lead stays the default. A cast colleague who has
   * not joined gets nothing said in their name: what is attributed to them is dropped until the reply switches to someone
   * on the call, and the lead is told afterwards. An id never cast is treated the same way (the lead is told with no name).
   */
  function applyTag(reply) {
    const id = reply.tagged;
    const cutIn = reply.taggedCutIn;
    reply.tagged = null;
    reply.taggedCutIn = false;
    if (id === null) return;
    const member = castMember(id);
    if (!onCall(id)) {
      reply.dropping = true; reply.heldTag = '';
      if (member) noteAbsent(reply, member); else noteUnknown(reply);
      return;
    }
    if (!speakers) { reply.dropping = false; return; } // the lead's own tag in a solo call
    reply.dropping = false; // the voice never left the speaker before the dropped segment
    if (id === reply.writer) return;
    reply.writer = id;
    cancelJoinFlush(reply); // the segment that held the first sentence ends here and is voiced whole
    reply.heldTag = ''; // a delivery tag shapes only its own speaker's next words
    reply.segChars = 0;
    reply.openerInSegment = false; // the acknowledgement belongs to the segment that just ended
    // The switch travels with the texts, so it reaches the voice between the same sentences the model wrote it between.
    // A cut-in flag is passed as a second argument only when set, so a voice that ignores it sees the old call shape.
    if (reply.gateOpen) attempt(() => (cutIn ? reply.stream.setSpeaker?.(id, { cutIn: true }) : reply.stream.setSpeaker?.(id)));
    else reply.voiceQueue.push(cutIn ? { speakerId: id, cutIn: true } : { speakerId: id });
  }

  /** Consecutive parts by the same speaker, as { speakerId, text } segments. */
  function partSegments(reply) {
    const segs = [];
    reply.parts.forEach((part, index) => {
      const speakerId = reply.partSpeakers[index] ?? reply.openSpeaker;
      const last = segs.at(-1);
      if (last && last.speakerId === speakerId) last.parts.push(part);
      else segs.push({ speakerId, parts: [part] });
    });
    return segs.map(item => ({ speakerId: item.speakerId, text: stripAudioTags(item.parts.join(' ')) }));
  }

  /** The words heard up to a playback position, grouped into the segments they belong to. */
  function heardSegments(reply, positionMs) {
    const runs = [];
    for (const word of reply.words) {
      if (word.endMs > positionMs) continue;
      const speakerId = word.speakerId ?? reply.openSpeaker;
      const last = runs.at(-1);
      if (last && last.speakerId === speakerId) last.words.push(word.word);
      else runs.push({ speakerId, words: [word.word] });
    }
    return runs.map(run => ({ speakerId: run.speakerId, text: stripAudioTags(run.words.join(' ')) }));
  }

  /** Who spoke first, and (only when more than one segment was spoken) the segments, on a panel entry. */
  function applyEntrySegments(reply, segs) {
    const entry = reply.entry;
    if (!speakers || !entry) return;
    const kept = segs.filter(item => item.text);
    if (kept.length) entry.speakerId = kept[0].speakerId;
    if (kept.length > 1) entry.segments = kept;
    else delete entry.segments;
  }

  function refreshEntry(reply) {
    const entry = reply.entry;
    if (!entry) return;
    entry.text = stripAudioTags(reply.parts.join(' '));
    if (!entry.interrupted) applyEntrySegments(reply, partSegments(reply));
  }

  function captionEvent(reply, final) {
    const entry = reply.entry;
    const event = { type: 'caption', speaker: 'interviewer', text: entry.text, final };
    if (speakers) {
      event.speakerId = entry.segments?.at(-1)?.speakerId ?? entry.speakerId;
      // Two interviewers in one reply: the caption says who said which part.
      if (Array.isArray(entry.segments) && entry.segments.length > 1) event.segments = entry.segments.map(item => ({ ...item }));
    }
    return event;
  }

  /** The interviewer who spoke last is the one who holds the floor for the next reply. */
  function settleFloor(reply) {
    const entry = reply.entry;
    if (!speakers || !entry) return;
    const id = entry.segments?.at(-1)?.speakerId ?? entry.speakerId;
    if (id) floor = id;
  }

  /** Emit a speaker event when the playback position has reached a segment by a different interviewer. */
  function showSpeaker(reply) {
    if (!speakers || !reply.playbackStarted) return;
    let id = reply.openSpeaker;
    let bestStart = -Infinity;
    for (const item of reply.speakerStarts) {
      if (item.startMs <= reply.positionMs && item.startMs >= bestStart) { id = item.speakerId; bestStart = item.startMs; }
    }
    if (id === reply.shownSpeaker) return;
    reply.shownSpeaker = id;
    emit({ type: 'speaker', speakerId: id });
  }

  function addChat(reply, chat) {
    if (reply.chats.includes(chat)) return; // de-duplicated per reply by exact text
    if (absentAt(reply)) return; // written inside a segment attributed to a colleague who has not joined
    reply.chats.push(chat);
    // Posted when playback reaches the words before it, like a screen or pad control.
    addControl(reply, { kind: 'chat', text: chat });
  }

  /** The interviewer speaking at this point of the reply, as applyTag would resolve it (without consuming the tag). */
  function writerNow(reply) {
    const id = reply.tagged;
    if (speakers && id && id !== reply.writer && speakers.some(item => item.id === id && item.present)) return id;
    return reply.writer ?? leadId;
  }

  /**
   * A short remark by another interviewer heard over the current speaker. Dropped (never spoken as text) unless the
   * speaker is another interviewer on the call (one who has not joined is also noted for the lead), and at most one per reply; a voice without overlay support plays nothing.
   */
  function addOverlay(reply, over) {
    const id = over?.speakerId;
    if (!id) return;
    const member = castMember(id);
    if (!member) { if (!onCall(id)) noteUnknown(reply); return; } // nothing is spoken for someone never cast
    if (!member.present) { noteAbsent(reply, member); return; } // nothing is spoken in their name
    if (reply.overlayCount >= 1 || id === writerNow(reply) || absentAt(reply)) return;
    const text = String(over.text ?? '').trim();
    if (!text) return;
    reply.overlayCount += 1;
    // The tag sits inside the writer's sentence; a speaker switch still waiting means the new speaker has said nothing yet.
    const sameSegment = writerNow(reply) === reply.writer;
    // The parser counts only the main reply's text in this segment; the acknowledgement already sent on it comes first.
    // The parser knows nothing of gaps and counts from the speaker tag; the voice counts from the latest gap.
    const afterChars = Number.isFinite(over.afterChars)
      ? Math.max(0, over.afterChars - reply.gapParserChars) + (sameSegment && reply.openerInSegment ? reply.openerChars : 0)
      : (sameSegment ? reply.segChars : 0);
    const request = { speakerId: id, text, afterChars };
    // Captions show what is heard: the parser's spoken form, else the text without delivery tags.
    reply.overlayCaption = typeof over.spoken === 'string' && over.spoken.trim() ? over.spoken.trim() : stripAudioTags(text).trim();
    if (typeof reply.stream?.overlay !== 'function') return;
    if (reply.gateOpen) attempt(() => reply.stream.overlay(request));
    else reply.voiceQueue.push({ overlay: request });
  }

  /** Emit the overlays whose audio has started by the playback position (every one when it is Infinity). */
  function showOverlays(reply, positionMs) {
    if (!reply.entry && !reply.committed) return;
    while (reply.overlaysShown < reply.overlayStarts.length) {
      const item = reply.overlayStarts[reply.overlaysShown];
      if (item.offsetMs > positionMs) break;
      reply.overlaysShown += 1;
      if (!speakers?.some(member => member.id === item.speakerId && member.present) || !item.text) continue;
      const base = reply.entry && Number.isFinite(reply.entry.startMs) ? reply.entry.startMs + item.offsetMs : helperTimelineMs();
      const atMs = Math.round(base);
      timedEntry({ speaker: 'interviewer', speakerId: item.speakerId, text: item.text, overlay: true }, atMs);
      emit({ type: 'overlay', speakerId: item.speakerId, text: item.text, atMs });
      emit({ type: 'caption', speaker: 'interviewer', speakerId: item.speakerId, text: item.text, final: true, overlay: true });
    }
  }

  /**
   * A screen that takes a while to set up becomes real silence between two separately synthesised segments. Whether one
   * is already shown is judged in reply order as the item is read: shown before this reply, or by an earlier screen
   * item here not followed by a stop. The gap travels with the texts and speaker switches, so it sits between the
   * same sentences the model wrote the tag between.
   */
  function noteScreen(reply, control) {
    const shown = reply.shownInOrder ?? !!screenShown;
    reply.shownInOrder = true;
    flushHeldPause(reply); // a share after a pause counts as what follows it, so the order stays
    const delayMs = screenDelayMs(control, shown);
    if (delayMs < SHARE_GAP_MIN_MS) return;
    queueGap(reply, delayMs);
  }

  /**
   * A written pause is held until words follow it: one with no words before it, or with nothing spoken after it by the
   * end of the reply, adds only dead air and is never sent to the voice (a gap cannot be taken back once sent).
   */
  /** `pendingChars`: parser characters already counted for a sentence that will be sent after this pause. */
  function flushHeldPause(reply, pendingChars = 0) {
    if (reply.heldPause === null) return;
    const delayMs = reply.heldPause;
    reply.heldPause = null;
    queueGap(reply, delayMs, pendingChars);
  }

  /** The prepared screen a reference names ("p1" is part 1, "p1.2" part 2), or null. */
  function resolvePrepared(ref) {
    const text = String(ref ?? '').trim();
    const dot = text.lastIndexOf('.');
    const numbered = dot > 0 && /^\d+$/.test(text.slice(dot + 1));
    const key = numbered ? text.slice(0, dot) : text;
    const index = numbered ? Number(text.slice(dot + 1)) : 1;
    if (!prepared || !Object.hasOwn(prepared, key)) return null;
    const part = prepared[key]?.parts?.[index - 1];
    if (!part || typeof part.content !== 'string') return null;
    // A picture or diagram made for this part during setup travels with it by id.
    return { title: String(part.title ?? ''), content: part.content, ...(part.visual?.id ? { visualId: String(part.visual.id) } : {}) };
  }

  function noteUnknownScreen(reply, ref) {
    if (!reply.unknownScreens.includes(ref)) reply.unknownScreens.push(ref);
    if (reply.committed && !unknownScreens.includes(ref)) unknownScreens.push(ref);
  }

  /** Real silence between the words before and after this point, in order with the text, speaker switches and gates. */
  function queueGap(reply, delayMs, pendingChars = 0) {
    if (typeof reply.stream?.gap !== 'function') return;
    cancelJoinFlush(reply); // a gap ends the segment that held the first sentence, which voices it
    // The voice starts a new segment: the overlay anchors count characters from here, as after a speaker switch.
    reply.textSinceGap = false;
    reply.segChars = 0;
    reply.openerInSegment = false;
    // A held delivery tag was counted by the parser here but is sent after the gap, so it belongs to the new segment;
    // so does a sentence already counted that is sent after it (a held pause is let out ahead of its sentence).
    reply.gapParserChars = reply.parserChars - nonSpace(reply.heldTag) - pendingChars;
    if (reply.gateOpen) attempt(() => reply.stream.gap(delayMs));
    else reply.voiceQueue.push({ gap: delayMs });
  }

  function addControl(reply, control) {
    // The anchor is the main reply's spoken characters before the tag; the acknowledgement spoken first is added when it is checked.
    reply.controls.push({ ...control, afterMain: spokenChars(reply.mainSentences.join(' ')) });
    if (reply.playbackStarted && reply === current) deliverDueControls(reply, reply.positionMs);
  }

  /** Whether playback has heard everything spoken before this control's tag (see deliverDueControls for the fallbacks). */
  function controlReached(reply, control, positionMs) {
    const anchor = (reply.openerSpoken ?? 0) + control.afterMain;
    if (anchor <= 0) return true;
    if (reply.words.length) return heardChars(reply, positionMs) >= anchor;
    // No word timings: place the tag in proportion to its characters over the audio length, once the whole reply is known.
    const total = spokenChars(reply.parts.join(' '));
    const audioMs = reply.sampleRate ? (reply.audioBytes / 2 / reply.sampleRate) * 1000 : 0;
    return reply.voiceDone && total > 0 && audioMs > 0 && positionMs >= (anchor / total) * audioMs;
  }

  /**
   * Deliver, in order, the controls whose position in the reply playback has reached. Word timings decide when they
   * arrive; without any, the position is proportional to characters; a tag never reached waits for the reply to
   * finish (everything is delivered then) or, if the reply is cut off, never takes effect.
   */
  function deliverDueControls(reply, positionMs) {
    if (!reply.committed || reply.done) return;
    while (reply.deliveredControls < reply.controls.length) {
      if (!controlReached(reply, reply.controls[reply.deliveredControls], positionMs)) break;
      deliverOneControl(reply);
    }
  }

  /** How long a screen takes to set up, clamped to the range for a first share or a swap. */
  function screenDelayMs(control, shown) {
    const range = shown ? SCREEN_SWAP_DELAY : SCREEN_FIRST_DELAY;
    const asked = Number.isFinite(control.delaySeconds) ? control.delaySeconds * 1000 : range.defaultMs;
    return Math.round(Math.min(range.maxMs, Math.max(range.minMs, asked)));
  }

  function deliverControls(reply) {
    while (reply.deliveredControls < reply.controls.length) deliverOneControl(reply);
  }

  /**
   * The reply has played to its end. When the voice failed part way, only the controls whose preceding words were
   * actually spoken are delivered; the rest never take effect.
   */
  function deliverRemaining(reply) {
    if (!reply.voiceFailed) { deliverControls(reply); return; }
    deliverDueControls(reply, Infinity);
    reply.deliveredControls = reply.controls.length;
  }

  function deliverOneControl(reply) {
    const control = reply.controls[reply.deliveredControls];
    reply.deliveredControls += 1;
    const atMs = helperTimelineMs();
    if (control.kind === 'chat') {
      emit({ type: 'chat', from: 'interviewer', text: control.text });
      timedEntry({ speaker: 'interviewer', channel: 'chat', text: control.text }, atMs);
    } else if (control.kind === 'screen') {
      const delayMs = screenDelayMs(control, !!screenShown);
      const visual = control.visualId ? { visualId: control.visualId } : {};
      screenShown = { title: control.title, content: control.content, speakerId: control.speakerId, ...visual };
      emit({ type: 'screen', title: control.title, content: control.content, speakerId: control.speakerId, delayMs, atMs, ...visual });
    } else if (control.kind === 'screen-stop') {
      screenShown = null;
      emit({ type: 'screen-stop', atMs });
    } else if (control.kind === 'pad') {
      // Opening an open pad keeps its text; a label given again replaces the old one.
      padState = control.open ? { open: true, lang: control.lang || (padState.open ? padState.lang : '') } : { open: false, lang: padState.lang };
      emit({ type: 'pad', open: padState.open, lang: padState.lang, atMs });
    }
  }

  /** Playback position now: extrapolated from the last position event while audio runs. */
  function livePosition(reply) {
    const since = reply.positionAt === null ? 0 : Math.max(0, now() - reply.positionAt);
    return reply.positionMs + since;
  }

  /** How long the acknowledgement still has to play: its audio not yet played, plus an estimate for words not yet voiced. */
  function ackRemainingMs(reply) {
    const audioMs = reply.sampleRate ? (reply.audioBytes / 2 / reply.sampleRate) * 1000 : 0;
    const played = reply.playbackStarted ? Math.min(livePosition(reply), audioMs) : 0;
    const count = tokens(reply.ackText).length;
    // Until every word is voiced (or when the voice reports no words), the whole acknowledgement is estimated from its
    // word count, and the audio already received stands in for it once it is longer: never the two added together.
    const total = reply.words.length >= count ? audioMs : Math.max(audioMs, count * ACK_WORD_ESTIMATE_MS);
    return Math.max(0, total - played);
  }

  function cancelJoinFlush(reply) {
    if (reply.joinFlushTimer) unschedule(reply.joinFlushTimer);
    reply.joinFlushTimer = null;
    reply.joinFlushAtGate = false;
  }

  /** Flush the first sentence `ms` from now (at once for 0), unless its segment ends first. */
  function scheduleJoinFlush(reply, ms) {
    cancelJoinFlush(reply);
    if (ms <= 0) { flushVoice(reply); return; }
    reply.joinFlushTimer = schedule(ms, () => { reply.joinFlushTimer = null; if (current === reply) flushVoice(reply); });
  }

  /** Near-silence the voice already left after the acknowledgement's last word; an assumed typical value until it is all voiced. */
  function ackTailMs(reply) {
    const audioMs = reply.sampleRate ? (reply.audioBytes / 2 / reply.sampleRate) * 1000 : 0;
    const done = reply.words.length > 0 && reply.words.length >= tokens(reply.ackText).length;
    return done ? Math.max(0, audioMs - Math.max(...reply.words.map(word => word.endMs))) : ACK_TAIL_ESTIMATE_MS;
  }

  /**
   * Before the reply's first sentence goes to the voice: when the acknowledgement still has time to play, leave a
   * natural pause after it (a new voice segment, so only with joinGapMinLeadMs to spare). Returns when to flush the
   * first sentence: at once when nothing is playing ahead of it, else joinFlushLeadMs before the acknowledgement (and
   * the pause) ends, so a sentence that arrives early waits for the next one and the two are voiced together.
   */
  function joinAfterAcknowledgement(reply, parsedChars) {
    if (!reply.ackText || !reply.openerInSegment) return 0; // nothing ahead, or a pause or a switch already parted them
    const remaining = ackRemainingMs(reply);
    let pause = 0;
    const report = flushInMs => { emit({ type: 'join', utteranceId: reply.utteranceId, remainingMs: Math.round(remaining), pauseMs: pause, flushInMs: flushInMs === null ? null : Math.round(flushInMs), gated: !reply.gateOpen }); return flushInMs; };
    // Behind the voice gate nothing has played yet, so the whole acknowledgement is still ahead (its words estimated).
    if (remaining >= th.joinGapMinLeadMs) {
      pause = Math.round(Math.max(0, joinPauseMs(reply.ackText) - ackTailMs(reply)));
      if (pause >= JOIN_GAP_MIN_MS) {
        queueGap(reply, pause);
        // The parser has already counted this sentence, but it is sent after the gap, in the new segment.
        reply.gapParserChars = reply.parserChars - parsedChars;
      } else pause = 0;
    }
    reply.joinPauseMs = pause;
    // Behind the gate nothing plays yet: the flush is timed when the gate opens and the acknowledgement starts.
    if (!reply.gateOpen) { report(null); reply.joinFlushAtGate = true; return null; }
    return report(Math.max(0, remaining + pause - th.joinFlushLeadMs));
  }

  function forwardMain(reply, sentence) {
    if (reply.spec.mainFirstSentenceMs === null) reply.spec.mainFirstSentenceMs = now() - reply.spec.at;
    // A held pause goes out ahead of the next words (and of a speaker switch before them), unless nobody will say them.
    if (reply.heldPause !== null && /[\p{L}\p{N}]/u.test(stripAudioTags(sentence)) && !absentAt(reply)) flushHeldPause(reply, nonSpace(sentence));
    applyTag(reply); // before the sentence is counted: a switch sits ahead of it
    if (reply.dropping) return; // attributed to a colleague who has not joined: said by no voice, counted nowhere
    // Delivery tags alone make no sound: they wait for the next words of this speaker, also across a gap.
    if (!/[\p{L}\p{N}]/u.test(stripAudioTags(sentence))) { reply.heldTag = reply.heldTag ? `${reply.heldTag} ${sentence}` : sentence; return; }
    if (reply.heldTag) { sentence = `${reply.heldTag} ${sentence}`; reply.heldTag = ''; }
    // Heard 2026-11-19: a mood tag on the reply's first sentence made the voice flip tone straight after the
    // acknowledgement, and the instruction alone did not stop it (24 of 25 replies kept one). Right after an
    // acknowledgement in the same voice, the first sentence is voiced in the same mood: its leading tags are dropped
    // (later sentences keep theirs, so a real change of tone still comes, one sentence on).
    const first = reply.mainSentences.length === 0;
    const parsedChars = nonSpace(sentence); // as the parser counted it, held tag included
    let droppedChars = 0;
    if (first && reply.ackText && reply.openerInSegment) {
      const plain = sentence.replace(LEADING_TAGS, '');
      if (/[\p{L}\p{N}]/u.test(plain)) { droppedChars = parsedChars - nonSpace(plain); sentence = plain; }
    }
    const flushInMs = first ? joinAfterAcknowledgement(reply, parsedChars) : null;
    // Overlay anchors are in parser characters: the dropped tag was counted there but never reaches the voice.
    reply.gapParserChars += droppedChars;
    reply.mainForwarded += 1;
    reply.mainSentences.push(sentence);
    sendVoice(reply, sentence);
    // The voice waits for about 8 words before it speaks, and a first sentence is often shorter ("Good to hear.").
    if (flushInMs !== null) scheduleJoinFlush(reply, flushInMs);
  }

  /**
   * One session turn with a deadline: a turn that has produced no output by turnTimeoutMs is aborted and rejected
   * (even by a session that ignores the signal), with `state.timedOut` set so the caller can tell it from a cancel.
   */
  function guardedTurn(session, message, parentSignal, onDelta) {
    const control = new AbortController();
    const state = { timedOut: false };
    let timer = null;
    let over = false;
    let expire = null;
    const stopTimer = () => { unschedule(timer); timer = null; };
    // Every streamed delta restarts the deadline, so a turn that stalls mid-stream times out like one that never started.
    const armTimer = () => {
      stopTimer();
      if (!over && expire) timer = schedule(th.turnTimeoutMs, () => { state.timedOut = true; expire(); });
    };
    const gone = new Promise((resolve, reject) => {
      const abortNow = () => {
        over = true;
        attempt(() => control.abort());
        reject(Object.assign(new Error('turn aborted'), { name: 'AbortError', code: 'CANCELLED' }));
      };
      if (parentSignal.aborted) { abortNow(); return; }
      parentSignal.addEventListener('abort', abortNow, { once: true });
      expire = abortNow;
      armTimer();
    });
    let run;
    try {
      run = Promise.resolve(session.turn(message, {
        signal: control.signal,
        onDelta: delta => { armTimer(); onDelta?.(delta); },
      }));
    } catch (error) { run = Promise.reject(error); }
    return { state, promise: Promise.race([run, gone]).finally(() => { over = true; stopTimer(); }) };
  }

  /** A typed line is finished (a sent message is never "unfinished"), so <listen/> on it counts as <pass/>. */
  function controlFor(reply, control) {
    // A cut-in look sees part of a line still being spoken: letting it go on is listening, never a finished line.
    if (reply.cutIn) return control === 'pass' ? 'listen' : control;
    return reply.typed && control === 'listen' ? 'pass' : control;
  }

  async function runOpener(reply) {
    for (let tries = 0; ; tries += 1) {
      if (current !== reply || reply.openerSettled) return;
      let guard = null;
      try {
        guard = guardedTurn(live.opener, reply.messages.opener, reply.ctl.opener.signal,
          () => { if (current === reply && reply.spec.openerFirstDeltaMs === null) reply.spec.openerFirstDeltaMs = now() - reply.spec.at; });
        const result = await guard.promise;
        if (current !== reply || reply.openerSettled) return;
        if (reply.spec.openerFirstDeltaMs === null) reply.spec.openerFirstDeltaMs = now() - reply.spec.at;
        const parser = createReplyStreamParser();
        const head = parser.push(String(result?.text ?? ''));
        const tail = parser.end();
        const control = controlFor(reply, tail.control ?? result?.control);
        if (control === 'listen') {
          finishOpener(reply, 'listen');
          return discardSilent(reply, 'listen');
        }
        // A pass from the acknowledgement session only means it makes no sound. Whether the line gets a reply is the
        // main session's decision alone: found live on 2026-11-18, where this session's pass cancelled a real reply.
        const written = [...head.sentences, ...tail.sentences].join(' ').trim();
        // The acknowledgement chooses its own length and is spoken as written, however long (the owner's call,
        // 2026-11-19: a word cap was arbitrary and untested). A bare delivery tag with no words makes no sound.
        const words = tokens(stripAudioTags(written)).length;
        const spoken = words >= 1 ? written : '';
        if (spoken) {
          sendVoice(reply, spoken);
          reply.openerChars = nonSpace(spoken);
          reply.openerSpoken = spokenChars(spoken);
          reply.openerInSegment = true;
          // An acknowledgement is far below what the voice service waits for before it makes a sound.
          // Ask for it now, or it would only be heard once the reply arrives.
          reply.flushAfter = spoken;
          if (reply.gateOpen) attempt(() => reply.stream.flush?.());
        }
        return finishOpener(reply, spoken ? 'spoken' : control === 'pass' ? 'pass' : 'dropped', written, words);
      } catch (error) {
        if (current !== reply || reply.openerSettled || (isCancel(error) && !guard?.state.timedOut)) return;
        if (tries >= 1) return finishOpener(reply, 'error');
        const restarted = await restart('opener');
        if (current !== reply) return;
        if (!restarted) return finishOpener(reply, 'error');
      }
    }
  }

  /** Main failed after it already forwarded output: finish with what was produced, restart for the next turn. */
  function cutOffMain(reply) {
    const forwarded = reply.mainSentences.length ? reply.mainSentences.join(' ') : reply.chats.join(' ');
    cutOffNote = `[Your previous reply was cut off by a connection problem after: '${forwarded}'.] `;
    reply.mainDone = true;
    reply.mainListen = false;
    reply.mainPass = false;
    reply.endCall = false;
    mainRestart = restart('main', reply.candidates).then(() => { mainRestart = null; });
    settle(reply);
  }

  async function runMain(reply) {
    if (mainRestart) await mainRestart;
    for (let tries = 0; ; tries += 1) {
      if (current !== reply) return;
      const parser = createParser();
      reply.asked = []; // a retried attempt starts clean: tags of a failed attempt never count
      reply.dropping = false;
      reply.absent = [];
      reply.unknown = false;
      reply.unknownScreens = [];
      reply.heldPause = null;
      reply.wait = null;
      let fed = false;
      let guard = null;
      const take = snapshot => {
        const items = snapshot.items ?? snapshot.sentences.map(sentence => ({ sentence }));
        // A parser that places chats among the items gives their exact position; otherwise they sit where the reply has reached.
        if (!items.some(item => item.chat !== undefined)) for (const chat of snapshot.chats) addChat(reply, chat);
        for (const item of items) {
          if (item.asked !== undefined) {
            reply.asked.push(item.asked);
            // A tag that arrives once the reply is already being delivered counts at once.
            if (reply.committed) noteAsked(reply);
          }
          else if (item.wait !== undefined) {
            reply.wait = Number.isFinite(item.wait) ? item.wait : reply.wait; // the last one counts
            // The tag is written last, so it usually arrives after commit: it still sets the next gap.
            if (reply.committed) noteWait(reply);
          }
          else if (item.pause !== undefined) {
            if (!absentAt(reply) && Number.isFinite(item.pause) && reply.textSinceGap && reply.heldPause === null) reply.heldPause = Math.round(clamp(item.pause * 1000, PAUSE_MIN_MS, PAUSE_MAX_MS));
          }
          else if (item.over) addOverlay(reply, item.over);
          else if (item.chat !== undefined) addChat(reply, String(item.chat));
          else if (item.speaker) {
            reply.tagged = item.speaker; reply.taggedCutIn = item.cutIn === true;
            reply.parserChars = 0; reply.gapParserChars = 0; // the parser restarts its count at every speaker tag
          }
          else if (item.screen) {
            if (!absentAt(reply)) {
              let shown = item.screen;
              if (shown.ref !== undefined) {
                const found = resolvePrepared(shown.ref);
                if (!found) { noteUnknownScreen(reply, String(shown.ref)); continue; }
                shown = { ...found, delaySeconds: shown.delaySeconds };
              }
              const control = {
                kind: 'screen', speakerId: writerNow(reply),
                title: String(shown.title ?? '').slice(0, SCREEN_TITLE_CAP),
                content: String(shown.content ?? '').slice(0, SCREEN_CONTENT_CAP),
                delaySeconds: typeof shown.delaySeconds === 'number' ? shown.delaySeconds : null,
                ...(shown.visualId ? { visualId: shown.visualId } : {}),
              };
              noteScreen(reply, control);
              addControl(reply, control);
            }
          }
          else if (item.screenStop) { if (!absentAt(reply)) { reply.shownInOrder = false; addControl(reply, { kind: 'screen-stop' }); } }
          else if (item.pad) { if (!absentAt(reply)) addControl(reply, { kind: 'pad', open: item.pad.open === true, lang: String(item.pad.lang ?? '').slice(0, 40) }); }
          else { reply.parserChars += nonSpace(item.sentence); forwardMain(reply, item.sentence); }
        }
      };
      try {
        guard = guardedTurn(live.main, reply.messages.main, reply.ctl.main.signal,
          delta => { if (current === reply) { fed = true; take(parser.push(delta)); } });
        const result = await guard.promise;
        if (current !== reply) return;
        if (!fed) take(parser.push(String(result?.text ?? '')));
        const tail = parser.end();
        take(tail);
        reply.heldPause = null; // nothing was spoken after it
        reply.mainDone = true;
        const control = controlFor(reply, tail.control ?? result?.control);
        reply.mainListen = control === 'listen';
        reply.mainPass = control === 'pass';
        reply.endCall = tail.endCall || result?.endCall === true;
        return settle(reply);
      } catch (error) {
        if (current !== reply || (isCancel(error) && !guard?.state.timedOut)) return;
        if (reply.mainForwarded > 0 || reply.chats.length > 0 || reply.controls.length > 0) return cutOffMain(reply);
        if (tries >= 1) { end('session-error'); return; }
        const restarted = await restart('main');
        if (current !== reply) return;
        if (!restarted) { end('session-error'); return; }
      }
    }
  }

  function settle(reply) {
    if (current !== reply || !reply.mainDone || !reply.openerSettled || reply.finishCalled) return;
    reply.finishCalled = true;
    // The main reply chose silence for a finished line and the opener's short reaction has not started playing:
    // nothing is spoken (a reaction already playing is committed and simply finishes).
    const silentKind = reply.mainPass ? 'pass' : 'listen';
    if ((reply.mainListen || reply.mainPass) && reply.candidates.length && !reply.committed && (!reply.heldTurn || reply.typed) && reply.mainForwarded === 0 && reply.chats.length === 0 && reply.controls.length === 0) {
      return discardSilent(reply, silentKind);
    }
    if (!reply.parts.length) {
      if (reply.mainListen || reply.mainPass) {
        if (reply.checkIn || (reply.padProgress && reply.wait !== null)) noteWait(reply); // a quiet check-in or pad progress still says how long to wait next
        return discardSilent(reply, silentKind);
      }
      attempt(() => reply.stream.cancel());
      reply.silent = true;
      reply.voiceDone = true;
      return tryCommit(reply);
    }
    if (!reply.gateOpen) { reply.finishDeferred = true; return; } // finish only after the queue was flushed
    callFinish(reply);
  }

  function callFinish(reply) {
    cancelJoinFlush(reply); // finishing voices everything sent, so a pending first-sentence flush has nothing left to do
    const done = failed => {
      if (current !== reply) return;
      if (!reply.gotAudio) return voiceNotSpoken(reply);
      if (failed) { reply.voiceFailed = true; emit({ type: 'error', code: 'voice-failed' }); }
      reply.voiceDone = true;
      afterVoiceDone(reply);
    };
    let pending;
    try { pending = reply.stream.finish(); } catch { pending = undefined; }
    Promise.resolve(pending).then(() => done(false), () => done(true));
  }

  /** The voice produced no audio for a reply with text: it was not spoken (end-call is not honoured). */
  function voiceNotSpoken(reply) {
    if (current !== reply) return;
    current = null;
    reply.done = true;
    abortReply(reply);
    emit({ type: 'error', code: 'voice-failed' });
    notSpoken = true;
    disarm('commit');
    setPhase('listening');
    armSilence();
  }

  function afterVoiceDone(reply) {
    if (reply.committed) {
      if (!reply.endSent) sendEnd(reply);
      return;
    }
    tryCommit(reply);
  }

  function onVoiceAudio(reply, buffer) {
    if (current !== reply) return;
    reply.gotAudio = true;
    reply.audioBytes += buffer?.length ?? 0;
    if (reply.spec.firstAudioAt === null) reply.spec.firstAudioAt = now();
    if (reply.committed) pushReplyAudio(reply, buffer);
    else { reply.buffered.push(buffer); tryCommit(reply); }
  }

  function tryCommit(reply) {
    if (current !== reply || reply.committed || !reply.commitDue) return;
    if (!(reply.buffered.length || reply.silent)) return;
    // An interviewer cutting in: the candidate's voice stops first, the way theirs does when the candidate cuts in.
    if (reply.cutIn && said && reply.buffered.length) return cutInOnSaid(reply);
    commit(reply);
  }

  function markTurnConsumed() {
    const helperNow = offset === null ? null : now() - offset;
    if (helperNow !== null) turnStartMs = Math.max(turnStartMs, helperNow);
  }

  /** Clock time of the latest word end among this turn's candidate segments, else the vad end. */
  function lastWordClock() {
    let max = null;
    for (const item of segments.values()) {
      if (item.startMs >= turnStartMs && Number.isFinite(item.endMs) && (max === null || item.endMs > max)) max = item.endMs;
    }
    return toClock(max) ?? toClock(lastVadEndMs);
  }

  function startSpokenTurn(immediate, respeculated) {
    const text = candidateText();
    beginTurn({
      text, candidates: [{ speaker: 'candidate', text, ...candidateSpan() }], lastWordAt: lastWordClock(), immediate,
      respeculated, specTokens: tokens(text).length,
    });
  }

  /** The candidate said more since the speculation: drop it and speculate again on the fresh text, committing at once. */
  function respeculate(reply) {
    current = null;
    abortReply(reply);
    emitDiscarded(reply, 'respeculated');
    notSpoken = true;
    startSpokenTurn(true, reply.respeculated + 1);
  }

  /** Answered questions, counting words and pad edits no reply has been committed for yet (a hang-up mid-answer). */
  function answeredNow() {
    const pending = tokens(candidateText()).length + pendingTyped.reduce((sum, item) => sum + tokens(item.text).length, 0);
    const open = answerWords + pending >= ANSWER_MIN_WORDS || Math.abs(padText.length - padAtAsk) >= ANSWER_MIN_PAD_CHARS ? openQuestions : [];
    return [...answeredQuestions, ...open.filter(number => !answeredQuestions.includes(number))];
  }

  function noteAsked(reply) {
    const fresh = [];
    for (const number of reply.asked) {
      if (!Number.isInteger(number) || number < 1 || askedQuestions.includes(number)) continue;
      askedQuestions.push(number);
      fresh.push(number);
      emit({ type: 'question-asked', kind: 'question-asked', number });
    }
    reply.asked = [];
    if (fresh.length) { openQuestions = fresh; answerWords = 0; padAtAsk = padText.length; }
  }

  /**
   * A question counts as answered once the candidate has said or typed a real answer's worth of
   * words after it, or written in the pad. "Could you repeat that?" is not an answer, and neither
   * is hanging up straight after the question.
   */
  function noteAnswer(entries = []) {
    if (!openQuestions.length) return;
    // Only the candidate's own words practise a question: a line written by Suggest a reply is heard by the
    // interviewer like any other, but does not count towards "Practised ×N".
    for (const entry of entries) if (entry?.speaker === 'candidate' && !entry.acknowledgement && !entry.generated) answerWords += tokens(entry.text).length;
    if (answerWords < ANSWER_MIN_WORDS && Math.abs(padText.length - padAtAsk) < ANSWER_MIN_PAD_CHARS) return;
    for (const number of openQuestions) if (!answeredQuestions.includes(number)) answeredQuestions.push(number);
    openQuestions = [];
  }

  /** Only a delivered reply sets how long the interviewer waits next; a check-in without its own <wait> keeps the schedule. */
  function noteWait(reply) {
    const own = reply.wait === null ? null : clamp(Math.round(reply.wait), WAIT_MIN_S, WAIT_MAX_S);
    if (reply.checkIn) { nextGapMs = own === null ? null : own * 1000; return; }
    patienceS = own;
    nextGapMs = null;
  }

  /** The notes the delivered message carried (acknowledgements, joins, absences, interruption...) are told: forget them. */
  function markNotesDelivered(reply) {
    pendingAcks = pendingAcks.slice(reply.used.acks);
    joinedQueue = joinedQueue.slice(reply.used.joined);
    absentQueue = absentQueue.slice(reply.used.absent);
    for (const id of reply.absent) if (!absentQueue.includes(id)) absentQueue.push(id);
    if (reply.used.unknown) unknownPending = false;
    if (reply.unknown) unknownPending = true;
    unknownScreens = unknownScreens.filter(ref => !reply.used.unknownScreens.includes(ref));
    for (const ref of reply.unknownScreens) if (!unknownScreens.includes(ref)) unknownScreens.push(ref);
    if (pendingInterruption === reply.used.interruption) pendingInterruption = null;
    if (notSpoken && reply.used.notSpoken) notSpoken = false;
    if (cutOffNote !== null && cutOffNote === reply.used.cutOff) cutOffNote = null;
  }

  function commit(reply) {
    if (reply.specTokens !== null && tokens(candidateText()).length > reply.specTokens) return respeculate(reply);
    reply.committed = true;
    // Commit is the one point where a reply is certain to be delivered: a speculative reply thrown away
    // (resumed, respeculated, listen) or one the voice never spoke never gets here, so it counts nothing.
    noteAnswer(reply.candidates); // these words answer what was asked before this reply, so they are counted first
    noteAsked(reply);
    noteWait(reply);
    disarm('commit');
    markNotesDelivered(reply);
    for (const entry of reply.candidates) addEntry({ ...entry });
    if (reply.typed) pendingTyped = [];
    if (reply.padSnapshot !== null) {
      // The main session has now been told this text. A paused-acknowledgement message carries no
      // pad note, so it leaves the text owed for the next turn.
      markPadReceived(reply);
    }
    if (reply.candidates.length) candidateSpoke = false;
    if (reply.parts.length) {
      const at = helperTimelineMs();
      reply.entry = addEntry({ speaker: 'interviewer', text: stripAudioTags(reply.parts.join(' ')), startMs: at, endMs: at });
      refreshEntry(reply);
      emit(captionEvent(reply, false));
    }
    if (reply.silent) {
      deliverControls(reply); // no audio to wait for

      if (reply.typed || reply.candidates.length) markTurnConsumed();
      return finishReply(reply, null);
    }
    if (reply.typed) markTurnConsumed();
    setPhase('committed');
    audio.play(reply.utteranceId, reply.sampleRate);
    for (const buffer of reply.buffered) pushReplyAudio(reply, buffer);
    reply.buffered = [];
    reply.startTimer = schedule(START_WATCH_MS, () => playbackStalled(reply));
    if (speaking && !overlap && offset !== null) overlapStart(now() - offset); // committed over ongoing speech
    if (reply.voiceDone && !reply.endSent) sendEnd(reply);
  }

  function sendEnd(reply) {
    // A reply shorter than the overlap: the rest of the cut-into voice plays on its own.
    if (reply.mixHead?.length) { const rest = reply.mixHead; reply.mixHead = null; attempt(() => audio.pushAudio(reply.utteranceId, rest)); }
    reply.endSent = true;
    attempt(() => audio.endUtterance(reply.utteranceId));
    armFinishWatch(reply);
  }

  /** After endUtterance, `finished` must arrive within the remaining audio plus a slack. */
  function armFinishWatch(reply) {
    unschedule(reply.finishTimer);
    reply.finishTimer = null;
    if (current !== reply || !reply.endSent || !reply.playbackStarted) return;
    reply.finishTimer = schedule(remainingMs(reply) + FINISH_SLACK_MS, () => playbackStalled(reply));
  }

  /** Audio of an utterance still to play: what has arrived (or been timed) past the live position. */
  function remainingMs(utterance) {
    const bytesMs = utterance.sampleRate ? (utterance.audioBytes / 2 / utterance.sampleRate) * 1000 : 0;
    const wordsMs = utterance.words.reduce((max, word) => Math.max(max, word.endMs), 0);
    return Math.max(0, Math.max(bytesMs, wordsMs) - livePosition(utterance));
  }

  function playbackStalled(reply) {
    if (current !== reply) return;
    emit({ type: 'error', code: 'playback-stalled' });
    attempt(() => audio.cancel(reply.utteranceId));
    reply.endCall = false;
    finishInterrupted(reply, reply.positionMs, null);
  }

  /** The reply ended early with the heard part only and no candidate turn behind it. */
  function finishInterrupted(reply, positionMs, atMs) {
    deliverDueControls(reply, positionMs);
    reply.heardText = stripAudioTags(heardFor(reply, positionMs));
    if (reply.entry) {
      if (reply.heardText) {
        Object.assign(reply.entry, { text: reply.heardText, interrupted: true, heardText: reply.heardText });
        applyEntrySegments(reply, heardSegments(reply, positionMs));
      } else { removeEntry(reply.entry); reply.entry = null; }
    }
    pendingInterruption = { reply };
    emit({ type: 'interrupted', heardText: reply.heardText });
    const parts = reply.parts;
    reply.parts = reply.heardText ? [reply.heardText] : [];
    finishReply(reply, atMs);
    reply.parts = parts;
  }

  function removeEntry(entry) {
    const index = transcript.indexOf(entry);
    if (index >= 0) transcript.splice(index, 1);
  }

  /** The reply is over (played to the end, or had nothing to play). */
  function finishReply(reply, atMs) {
    if (current !== reply) return;
    current = null;
    reply.done = true;
    abortReply(reply);
    if (reply.entry) {
      setEntryEnd(reply, reply.playbackStarted ? (atMs ?? helperTimelineMs()) : reply.entry.startMs);
      refreshEntry(reply);
      emit(captionEvent(reply, true));
      settleFloor(reply);
    }
    if (atMs !== null && atMs !== undefined) {
      noteHelperTime(atMs);
      turnStartMs = overlap?.speaking ? overlap.startMs : Math.max(turnStartMs, atMs);
    }
    if (overlap) {
      if (overlap.speaking) candidateSpoke = true;
      endOverlapRecord(overlap);
      overlap = null;
    }
    if (reply.endCall) return end('interviewer');
    setPhase('listening');
    // A typed message queued behind this reply is answered now: the stop that would have started it is gone.
    if (pendingTyped.length && !current) { beginTyped(); return; }
    // A candidate voice line that ended while this reply was on air is answered now.
    if (voicedDone.length && !current && !said) { deliverVoiced(); return; }
    // The lead handed the floor to a colleague who has not joined; one chain only, so it cannot loop on itself.
    if (!reply.handover && startAbsentHandover()) return;
    armSilence();
  }

  /** The lead is told right away (when the candidate has not started to speak or type) that nothing was said for the absent colleague. */
  function startAbsentHandover() {
    if (phase === 'ended' || current || said || paused || speaking || typingNow || named.spec || named.commit || pendingTyped.length) return false;
    if (!handoverNames().length && !unknownPending) { absentQueue = []; return false; }
    beginTurn({ immediate: true, handover: true });
    return true;
  }

  function emitTiming(reply, atMs) {
    const playbackStartedAt = toClock(atMs) ?? now();
    const { lastWordAt } = reply.spec;
    emit({
      type: 'timing', ...(reply.respeculated ? { respeculated: reply.respeculated } : {}),
      voiceCharsSent: reply.voiceCharsSent,
      lastWordAt, speculatedAt: reply.spec.at,
      openerFirstDeltaMs: reply.spec.openerFirstDeltaMs, mainFirstSentenceMs: reply.spec.mainFirstSentenceMs,
      firstAudioAt: reply.spec.firstAudioAt, playbackStartedAt,
      lastWordToFirstSoundMs: lastWordAt === null || lastWordAt === undefined ? null : playbackStartedAt - lastWordAt,
    });
  }

  // ---- stopping playback ---------------------------------------------------
  function stopPlayback(reply, afterCancel = null) {
    if (current !== reply) return;
    current = null;
    if (overlap) { endOverlapRecord(overlap); overlap = null; }
    cancelling = reply;
    // Follow-ups queued for the word-boundary stop belong to whichever stop actually happens.
    const followUps = [afterCancel, ...reply.boundaryAfter].filter(Boolean);
    reply.boundaryAfter = [];
    reply.afterCancel = followUps.length ? () => followUps.forEach(fn => fn()) : null;
    abortReply(reply);
    attempt(() => audio.cancel(reply.utteranceId));
    reply.heardText = stripAudioTags(heardFor(reply, reply.positionMs));
    if (reply.entry) {
      Object.assign(reply.entry, { text: reply.heardText, interrupted: true, heardText: reply.heardText });
      applyEntrySegments(reply, heardSegments(reply, reply.positionMs));
      // Nobody who was not heard takes the floor.
      if (reply.heardText) settleFloor(reply);
      setEntryEnd(reply, reply.playbackStarted ? helperTimelineMs() : reply.entry.startMs);
    }
    pendingInterruption = { reply };
    reply.cancelWait = schedule(CANCEL_WAIT_MS, () => resolveCancel(reply, null));
    setPhase('listening');
  }

  function resolveCancel(reply, positionMs) {
    if (cancelling !== reply) return;
    cancelling = null;
    unschedule(reply.cancelWait);
    if (positionMs === Infinity) {
      // The helper finished the whole utterance before the cancel landed: it was fully heard, not interrupted.
      reply.heardText = stripAudioTags(reply.parts.join(' '));
      deliverRemaining(reply);
      if (reply.entry) {
        reply.entry.text = reply.heardText;
        delete reply.entry.interrupted;
        delete reply.entry.heardText;
        applyEntrySegments(reply, partSegments(reply));
        settleFloor(reply);
      }
      if (pendingInterruption?.reply === reply) pendingInterruption = null;
    } else {
      if (positionMs !== null && positionMs !== undefined) {
        reply.heardText = stripAudioTags(heardFor(reply, positionMs));
        // The final heard position can be a little past the last position event: controls inside the heard text still count.
        deliverDueControls(reply, positionMs);
        if (reply.playbackStarted && reply.entry && Number.isFinite(positionMs)) setEntryEnd(reply, reply.entry.startMs + positionMs);
      }
      if (reply.entry) {
        if (reply.heardText) {
          Object.assign(reply.entry, { text: reply.heardText, interrupted: true, heardText: reply.heardText });
          if (positionMs !== null && positionMs !== undefined) applyEntrySegments(reply, heardSegments(reply, positionMs));
          settleFloor(reply);
        } else { removeEntry(reply.entry); reply.entry = null; }
      }
      emit({ type: 'interrupted', heardText: reply.heardText });
    }
    const next = reply.afterCancel;
    reply.afterCancel = null;
    if (next) next();
  }

  function onPlayback(event) {
    if (said && said.utteranceId === event.utteranceId) return onSaidPlayback(said, event);
    const reply = [current, cancelling].find(item => item && item.utteranceId === event.utteranceId);
    if (!reply) return;
    noteHelperTime(event.atMs);
    if (event.state === 'position') {
      reply.positionMs = event.positionMs;
      reply.positionAt = now();
      armFinishWatch(reply);
      showSpeaker(reply);
      showOverlays(reply, reply.positionMs);
      if (reply === current) deliverDueControls(reply, reply.positionMs);
      return;
    }
    if (event.state === 'paused' || event.state === 'resumed') {
      // Helper playback states: keep the position the helper reports (heard text uses it when paused).
      if (Number.isFinite(event.positionMs)) reply.positionMs = event.positionMs;
      reply.positionAt = now();
      return;
    }
    if (event.state === 'started') {
      if (reply === current && !reply.playbackStarted) {
        reply.playbackStarted = true;
        if (reply.entry && Number.isFinite(event.atMs)) {
          reply.entry.startMs = Math.round(event.atMs);
          reply.entry.endMs = reply.entry.startMs;
        }
        reply.positionAt = now();
        unschedule(reply.startTimer);
        reply.startTimer = null;
        armFinishWatch(reply);
        setPhase('playing');
        emitTiming(reply, event.atMs);
        showSpeaker(reply);
        deliverDueControls(reply, reply.positionMs);
      }
      return;
    }
    if (reply === cancelling) {
      resolveCancel(reply, event.state === 'finished' ? Infinity : event.positionMs);
      return;
    }
    if (event.state === 'finished') {
      if (reply === current) { showOverlays(reply, Infinity); deliverRemaining(reply); }
      return finishReply(reply, event.atMs);
    }
    if (event.state === 'cancelled') {
      // Not requested by the engine (for example helper backpressure): trim to what was heard.
      finishInterrupted(reply, event.positionMs, event.atMs);
    }
  }

  // ---- overlap, classifier, interruption ------------------------------------
  function boundaryDelay(reply) {
    // Estimate the live position from the last position event, capped at the utterance length.
    const lastEnd = reply.words.reduce((max, item) => Math.max(max, item.endMs), 0);
    const estimate = livePosition(reply);
    const position = reply.words.length ? Math.min(estimate, lastEnd) : estimate;
    return atBoundary(reply, position) ? 0 : (reply.words.find(item => item.endMs > position)?.endMs ?? position) - position;
  }

  /** Playback sits in a stretch with no word being spoken (the share silence), so a stop can happen at once. */
  function atBoundary(reply, position) {
    const next = reply.words.find(item => item.endMs > position);
    if (!next) return true;
    // Before the first word nothing is mid-speech either, but only a word already heard marks a silence between speech.
    return reply.words.some(item => item.endMs <= position) && next.startMs - position > 200;
  }

  function boundaryCancel(reply, onStop, afterCancel = null) {
    // Follow-ups wait on the reply, not on this timer: whichever stop happens first runs them.
    if (afterCancel) reply.boundaryAfter.push(afterCancel);
    if (reply.cancelTimer !== null) return; // a stop is already waiting for the word boundary
    const go = () => {
      reply.cancelTimer = null;
      if (current !== reply) return;
      onStop?.();
      stopPlayback(reply);
    };
    reply.cancelTimer = afterWordBoundary(reply, go);
  }

  /**
   * Run `fn` once the utterance reaches the end of the word being spoken (at once between words). Shared by every
   * voice that is cut off: the interviewer's when the candidate cuts in, the candidate's when an interviewer does.
   * Returns the timer, or null when `fn` already ran.
   */
  function afterWordBoundary(utterance, fn) {
    const delay = boundaryDelay(utterance);
    if (delay <= 0) { fn(); return null; }
    return schedule(delay, fn);
  }

  function endOverlapRecord(record) {
    if (!record) return;
    record.active = false;
    for (const key of ['timer', 'bidTimer', 'boundaryTimer', 'maxPausedTimer', 'resumeTimer']) unschedule(record[key]);
    record.timer = null; record.bidTimer = null; record.boundaryTimer = null;
    record.maxPausedTimer = null; record.resumeTimer = null;
    if (overlapRecord === record) overlapRecord = null;
  }

  const earFloorBid = () => (typeof ear?.floorBid === 'function' ? ear.floorBid : null);

  function armOverlapDuration(record) {
    unschedule(record.timer);
    const startClock = toClock(record.startMs) ?? now();
    record.timer = schedule(th.interruptMs + 1 - Math.max(0, now() - startClock), () => {
      if (!record.active || record.paused) return;
      // Echo residue has duration but no words: only stop on duration once a transcript word was counted.
      if (tokens(overlapText(record)).length >= 1) immediateStop(record);
      else record.durationElapsed = true;
    });
  }

  function overlapStart(atMs) {
    if (overlapWait) { unschedule(overlapWait.timer); overlapWait = null; }
    const record = {
      startMs: atMs, endMs: null, speaking: true, reply: current, timer: null, durationElapsed: false,
      active: true, decision: earFloorBid() ? null : 'continue', paused: false, pausedAt: null,
      bidTimer: null, boundaryTimer: null, maxPausedTimer: null, resumeTimer: null,
    };
    if (earFloorBid()) record.bidTimer = schedule(th.floorBidAfterMs, () => requestFloorBid(record));
    else armOverlapDuration(record);
    overlap = record;
    overlapRecord = record;
  }

  /** Pause-then-decide: ask the ear at floorBidAfterMs whether the candidate is bidding for the floor. */
  function requestFloorBid(record) {
    record.bidTimer = null;
    if (!record.active) return;
    const reply = record.reply;
    if (!reply || current !== reply) { endOverlapRecord(record); return; }
    if (!record.speaking && tokens(overlapText(record)).length < 1) return; // echo residue: leave it to the word wait
    const endMs = record.endMs ?? (offset === null ? record.startMs : now() - offset);
    const bid = earFloorBid();
    const args = {
      overlapStartMs: record.startMs, overlapMs: Math.max(0, endMs - record.startMs),
      wordCount: tokens(overlapText(record)).length,
    };
    Promise.resolve().then(() => bid(args)).then(
      result => onFloorBid(record, result?.decision === 'pause' ? 'pause' : 'continue'),
      () => onFloorBid(record, 'continue'),
    );
  }

  function onFloorBid(record, decision) {
    if (!record.active || record.decision !== null) return;
    const reply = record.reply;
    if (!reply || current !== reply) { endOverlapRecord(record); return; }
    record.decision = decision;
    if (decision === 'continue') {
      if (overlap === record) armOverlapDuration(record);
      else if (tokens(overlapText(record)).length) evaluateOverlap(record, reply);
      return;
    }
    pauseAtBoundary(record, reply);
  }

  function immediateStop(record) {
    const reply = current;
    if (overlap === record) overlap = null;
    endOverlapRecord(record);
    if (!reply || reply !== record.reply) return;
    turnStartMs = record.startMs;
    candidateSpoke = true;
    stopPlayback(reply);
  }

  function overlapEnd(atMs) {
    const record = overlap;
    overlap = null;
    unschedule(record.timer);
    record.speaking = false;
    record.endMs = atMs;
    record.timer = null;
    const reply = record.reply;
    if (!record.active || !reply || current !== reply) return;
    if (record.paused) {
      if (clearInterruption(record)) return stopFromOverlap(record);
      if (tokens(overlapText(record)).length >= 1) return classify(record, reply, overlapText(record));
      return; // echo residue: the maxPaused timer decides
    }
    if (record.decision === null) return; // the floor bid is still in flight: it applies the decision
    if (record.decision === 'pause') return; // the boundary pause applies the decision, then the classifier
    if (tokens(overlapText(record)).length) return evaluateOverlap(record, reply);
    // No words yet: the recogniser can trail the VAD, so wait a little before ignoring the overlap.
    record.timer = schedule(OVERLAP_WORD_WAIT_MS, () => { if (overlapWait === record) overlapWait = null; });
    overlapWait = record;
  }

  function evaluateOverlap(record, reply) {
    if (!record.active || current !== reply) return;
    const count = tokens(overlapText(record)).length;
    if (record.endMs - record.startMs > th.interruptMs || count > th.interruptWords) {
      turnStartMs = record.startMs;
      candidateSpoke = true;
      endOverlapRecord(record);
      stopPlayback(reply);
    } else if (count >= 1) {
      classify(record, reply, overlapText(record));
    }
  }

  /** A clear interruption by the counts alone: too many words, or a long enough stretch of overlap. */
  function clearInterruption(record) {
    const endMs = record.endMs ?? (offset === null ? record.startMs : now() - offset);
    return tokens(overlapText(record)).length > th.interruptWords || endMs - record.startMs > th.interruptMs;
  }

  function pauseAtBoundary(record, reply) {
    if (record.paused || !record.active) return;
    const pause = () => {
      record.boundaryTimer = null;
      if (!record.active || current !== reply) return;
      record.paused = true;
      record.pausedAt = now();
      reply.positionMs = livePosition(reply);
      reply.positionAt = now();
      unschedule(reply.finishTimer); // a paused utterance is not stalled
      reply.finishTimer = null;
      attempt(() => audio.pause?.(reply.utteranceId));
      emit({ type: 'playback', state: 'paused', utteranceId: reply.utteranceId });
      record.maxPausedTimer = schedule(th.maxPausedMs, () => onMaxPaused(record));
      if (clearInterruption(record)) return stopFromOverlap(record);
      if (!record.speaking && tokens(overlapText(record)).length >= 1) classify(record, reply, overlapText(record));
      return;
    };
    const delay = boundaryDelay(reply);
    if (delay <= 0) pause();
    else record.boundaryTimer = schedule(delay, pause);
  }

  function stopFromOverlap(record, afterCancel = null) {
    const reply = record.reply;
    if (overlap === record) overlap = null;
    endOverlapRecord(record);
    if (!reply || current !== reply) return;
    turnStartMs = record.startMs;
    candidateSpoke = true;
    stopPlayback(reply, afterCancel);
  }

  /** Put a paused utterance back on air and forget the overlap that paused it. */
  function resumePlayback(record, reply) {
    record.paused = false;
    attempt(() => audio.resume?.(reply.utteranceId));
    emit({ type: 'playback', state: 'resumed', utteranceId: reply.utteranceId });
    reply.positionAt = now();
    armFinishWatch(reply);
  }

  function onMaxPaused(record) {
    record.maxPausedTimer = null;
    if (!record.active || !record.paused) return;
    const reply = record.reply;
    if (!reply || current !== reply) { endOverlapRecord(record); return; }
    if (tokens(overlapText(record)).length === 0 && !clearInterruption(record)) {
      // Only a wordless noise paused the reply and nothing followed it: carry on speaking.
      if (overlap === record) overlap = null;
      endOverlapRecord(record);
      resumePlayback(record, reply);
      return;
    }
    // No decision in time: the pause counts as an interruption, and the call must not go quiet afterwards.
    stopFromOverlap(record, () => {
      if (speaking || phase !== 'listening' || current) return;
      if (candidateText()) scheduleTurnEnd(record.endMs ?? helperTimelineMs());
      else armSilence();
    });
  }

  function classify(record, reply, text) {
    const sentence = stripAudioTags(sentenceAt(reply, reply.positionMs));
    const message = `Interviewer sentence being spoken: '${sentence}'\nCandidate's words: '${text}'\n`
      + 'Reply with exactly one word: acknowledgement or interruption.';
    const controller = new AbortController();
    classifierControllers.add(controller);
    let settled = false;
    let timer = null;
    const finish = verdict => {
      if (settled) return;
      settled = true;
      unschedule(timer);
      classifierControllers.delete(controller);
      onVerdict(record, reply, verdict, text);
    };
    timer = schedule(th.classifierTimeoutMs, () => { attempt(() => controller.abort()); finish('acknowledgement'); });
    Promise.resolve().then(() => live.classifier.turn(message, { signal: controller.signal })).then(
      result => finish(parseVerdict(result?.text)),
      error => {
        const wasSettled = settled;
        finish('acknowledgement');
        if (!wasSettled && !isCancel(error) && phase !== 'ended') restart('classifier');
      },
    );
  }

  function storeAck(record, text) {
    pendingAcks.push(text);
    const startMs = Math.round(record.startMs ?? helperTimelineMs());
    const endMs = Math.round(Math.max(startMs, record.endMs ?? helperTimelineMs()));
    addEntry({ speaker: 'candidate', acknowledgement: true, text, startMs, endMs });
    emit({ type: 'acknowledgement', text });
  }

  /** The classifier answered for an overlap that was paused at a word boundary. */
  function pausedVerdict(record, reply, verdict, text) {
    if (!record.active) return;
    if (verdict === 'interruption') {
      endOverlapRecord(record);
      return stopPlayback(reply);
    }
    const pausedMs = record.pausedAt === null ? 0 : now() - record.pausedAt;
    if (pausedMs > th.maxResumePauseMs) return cancelAfterPause(record, reply, text);
    unschedule(record.maxPausedTimer);
    record.maxPausedTimer = null;
    storeAck(record, text);
    record.resumeTimer = schedule(th.resumeDelayMs, () => {
      record.resumeTimer = null;
      record.active = false;
      if (current !== reply) return; // fence: a stale resume never touches a newer reply
      resumePlayback(record, reply);
    });
  }

  /** The pause ran too long to resume in place: drop the rest and tell the main model where it stopped. */
  function cancelAfterPause(record, reply, text) {
    endOverlapRecord(record);
    stopPlayback(reply, () => beginPausedAckTurn(text));
  }

  function beginPausedAckTurn(text) {
    if (phase === 'ended') return;
    if (pendingInterruption?.reply) pendingInterruption = null; // the paused message already explains the stop
    beginTurn({ immediate: true, candidates: [], text: '', pausedAck: text });
  }

  function onVerdict(record, reply, verdict, text) {
    if (phase === 'ended' || paused) return; // a verdict on speech from before a pause finds the overlap already ended
    if (record.paused && current === reply && reply.committed) return pausedVerdict(record, reply, verdict, text);
    const playing = current === reply && reply.committed;
    const finished = reply.done && !current && phase === 'listening';
    if (!playing && !finished) return;
    if (verdict !== 'interruption') return storeAck(record, text);
    if (playing) {
      boundaryCancel(reply, () => { turnStartMs = record.startMs; candidateSpoke = true; }, () => {
        if (!speaking && phase === 'listening' && !current) scheduleTurnEnd(record.endMs);
      });
      return;
    }
    // The reply already finished: this is an ordinary candidate turn.
    candidateSpoke = true;
    turnStartMs = Math.min(turnStartMs, record.startMs);
    if (!speaking) scheduleTurnEnd(record.endMs);
  }

  // ---- candidate turns ------------------------------------------------------
  function scheduleTurnEnd(atMs) {
    noteHelperTime(atMs);
    lastVadEndMs = atMs;
    disarm('silence');
    const since = Math.max(0, now() - (toClock(atMs) ?? now()));
    arm('spec', th.speculateMs - since, onSpeculate);
    arm('commit', th.commitMs - since, onCommitDue);
    requestEndOfTurn(atMs);
  }

  /**
   * Smart Turn: ask the ear, right away, whether the audio that just ended sounds like a finished turn.
   * A held end pushes both timers out (still measured from the vad end) and flags the opener as unfinished audio.
   */
  function requestEndOfTurn(atMs) {
    if (typeof ear?.endOfTurn !== 'function') return;
    let settled = false;
    let timer = null;
    const settle = probability => {
      if (settled) return;
      settled = true;
      unschedule(timer);
      const value = typeof probability === 'number' && Number.isFinite(probability) ? probability : null;
      // Fenced against a stale answer: the candidate resumed, a newer vad end arrived, or the fast path already began.
      const stale = speaking || lastVadEndMs !== atMs || named.spec === null || current !== null;
      const held = value !== null && value < th.smartTurnHoldBelow && !stale;
      emit({ type: 'turn-model', probability: value, held });
      if (!held) return;
      audioHint = true;
      const since = Math.max(0, now() - (toClock(atMs) ?? now()));
      arm('spec', th.holdSpeculateMs - since, onSpeculate);
      arm('commit', th.holdCommitMs - since, onCommitDue);
    };
    timer = schedule(th.smartTurnTimeoutMs, () => settle(null));
    Promise.resolve().then(() => ear.endOfTurn(atMs)).then(settle, () => settle(null));
  }

  function beginSpoken() {
    if (!candidateText()) { armSilence(); return false; }
    startSpokenTurn(false, 0);
    return true;
  }

  function onSpeculate() {
    if (phase === 'listening' && !current && !said) beginSpoken();
  }

  function onCommitDue() {
    if (said) return; // the candidate's own voice is still speaking: the turn ends when it does
    if (phase === 'listening' && !current && !beginSpoken()) return;
    if (current && !current.committed) { current.commitDue = true; tryCommit(current); }
  }

  /** Every typed text not yet committed (plus `text`, if given): spoken in the candidate's voice when there is one, else one typed turn. */
  function beginTyped(item) {
    if (candidateVoice) return speakTyped(item);
    return beginTypedTurn(item);
  }

  /** Start one typed turn from every typed text not yet committed (plus `text`, if given), in order. */
  function beginTypedTurn(item) {
    if (item !== undefined) pendingTyped.push(item);
    if (!pendingTyped.length) return;
    disarm('spec');
    disarm('commit');
    const texts = pendingTyped.slice();
    const atMs = helperTimelineMs();
    // Words the candidate already said aloud that no reply has answered stay in the turn, ahead of the typed text.
    const spokenText = candidateText();
    const spoken = spokenText ? [{ speaker: 'candidate', text: spokenText, ...candidateSpan() }] : [];
    // Lines already spoken in the candidate's voice (when a later one could not be) come first, as spoken.
    const voiced = voicedDone;
    voicedDone = [];
    const heard = voiced.map(entry => entry.text).join(' ');
    beginTurn({
      text: texts.map(item => item.text).join('\n'), channel: 'chat', typed: true, immediate: true, spokenText: [spokenText, heard].filter(Boolean).join(' '),
      candidates: [
        ...spoken,
        ...voiced,
        ...texts.map(item => ({ speaker: 'candidate', channel: 'chat', text: item.text, startMs: atMs, endMs: atMs, ...(item.generated ? { generated: true } : {}) })),
      ],
    });
  }

  function armSilence() {
    disarm('silence');
    if (paused || phase !== 'listening' || typingNow || speaking || current || said || named.spec || named.commit) return;
    if (maybeSendPadProgress()) return;
    // Like a person: the first check comes after a while, the next ones come further apart.
    // The interviewer judges the first wait (<wait>); the later gaps widen with it, like a person who gives more room.
    const first = patienceS === null ? th.silencePromptMs : patienceS * 1000;
    const waitMs = silencePrompts === 0 ? first
      : nextGapMs !== null ? nextGapMs
        : silencePrompts === 1 ? clamp(first, 12000, 30000) : clamp(first * 1.5, 20000, 45000);
    arm('silence', waitMs, () => {
      if (paused || phase !== 'listening' || typingNow || speaking || current || said) return;
      // The interviewer has checked in the allowed number of times: the line drops, whatever the model would say.
      if (silencePrompts >= MAX_SILENCE_CHECKS) return end('interviewer', undefined, { cause: 'silence' });
      nextGapMs = null;
      silencePrompts += 1;
      silenceTotalMs += waitMs;
      beginTurn({ silenceMs: silenceTotalMs, immediate: true });
    });
  }

  /**
   * Pad progress: the interviewer watches the candidate write, so it gets the pad text every padProgressMs while
   * the text keeps changing (from the last time it had the text), and once when typing stops for padIdleMs.
   * Not a check-in (not counted, nothing acknowledged first). When it is held back (the interviewer speaking,
   * a reply being made, the candidate speaking, a pause) it is simply tried again when that ends, so at most one is pending.
   */
  function padProgressDueAt() {
    if (!padDirty || !padText || padText === padSent || padEditedAt === null) return null;
    const base = Math.max(padSentAt ?? -Infinity, padDirtySince ?? -Infinity);
    return Math.min(base + th.padProgressMs, padEditedAt + th.padIdleMs);
  }

  function schedulePadProgress() {
    disarm('padIdle');
    const dueAt = padProgressDueAt();
    if (dueAt === null || phase === 'ended' || paused) return;
    arm('padIdle', Math.max(0, dueAt - now()), maybeSendPadProgress);
  }

  function maybeSendPadProgress() {
    if (paused || phase !== 'listening' || typingNow || speaking || current || said || named.spec || named.commit) return false;
    const dueAt = padProgressDueAt();
    if (dueAt === null) { padDirty = padDirty && padText !== padSent; return false; }
    if (now() < dueAt) { schedulePadProgress(); return false; }
    const idleMs = now() - padEditedAt;
    beginTurn({ padProgress: { typing: idleMs < th.padIdleMs, idleMs }, immediate: true });
    return true;
  }

  // ---- helper events --------------------------------------------------------
  function onVad(event) {
    noteHelperTime(event.atMs);
    // While the call is paused the candidate's voice starts nothing; the recording still has it.
    if (paused) { if (!event.speaking) speaking = false; return; }
    if (event.speaking) {
      speaking = true; // a bare sound postpones the check-in but is not an answer: the counters stay
      audioHint = false; // the candidate resumed: no stale Smart Turn hint
      disarm('silence');
      if (current && current.committed) {
        if (!overlap) overlapStart(event.atMs);
        return;
      }
      if (current && !current.typed) {
        disarm('spec');
        disarm('commit');
        candidateSpoke = true;
        discardPending(true);
        return;
      }
      if (!current) {
        disarm('spec');
        disarm('commit');
        candidateSpoke = true;
      }
      return;
    }
    speaking = false;
    if (overlap) overlapEnd(event.atMs);
    if (phase === 'listening' && !current && candidateSpoke) scheduleTurnEnd(event.atMs);
    else if (phase === 'listening') armSilence();
  }

  function onTranscript(event) {
    if (paused) return; // dropped: no caption, no stored words, so nothing from the pause reaches a turn
    segments.set(event.segmentId, { text: String(event.text ?? ''), startMs: event.startMs, endMs: event.endMs, final: !!event.final });
    emit({ type: 'caption', speaker: 'candidate', text: String(event.text ?? ''), final: !!event.final });
    if (String(event.text ?? '').trim()) { silencePrompts = 0; silenceTotalMs = 0; nextGapMs = null; } // the candidate actually said something
    if (overlapWait && current === overlapWait.reply && tokens(overlapText(overlapWait)).length >= 1) {
      const record = overlapWait;
      overlapWait = null;
      unschedule(record.timer);
      evaluateOverlap(record, record.reply);
    }
    const speakingOverlap = overlap?.speaking ? overlap : null;
    if (speakingOverlap && current && current === speakingOverlap.reply) {
      const count = tokens(overlapText(speakingOverlap)).length;
      if (speakingOverlap.paused) {
        if (count > th.interruptWords) stopFromOverlap(speakingOverlap); // a clear interruption while paused cancels as today
      } else if (speakingOverlap.decision === 'continue' && (count > th.interruptWords || (speakingOverlap.durationElapsed && count >= 1))) {
        immediateStop(speakingOverlap);
      }
    }
  }

  function helperEvent(event) {
    if (phase === 'ended' || !event || typeof event !== 'object') return;
    if (event.type === 'error') return end('audio-error', event.code);
    if (phase === 'connecting') { noteHelperTime(event.atMs); return; }
    switch (event.type) {
      case 'vad': return onVad(event);
      case 'transcript': return onTranscript(event);
      case 'playback': return onPlayback(event);
      case 'level': noteHelperTime(event.atMs); return;
      default: return;
    }
  }

  // ---- the candidate's voice -----------------------------------------------
  // A sent chat message is spoken on the call in the candidate's voice. While it plays the interviewer may cut in;
  // the cut uses the same word-boundary stop (afterWordBoundary) and heard-text rule (heardFor) as an interviewer
  // who is cut off. When the line ends (or is cut), the interviewer hears it as a spoken line.

  /** Speak every typed text not yet spoken (plus `text`, if given) as one line in the candidate's voice. */
  function speakTyped(item, tries = 1) {
    if (item !== undefined) pendingTyped.push(item);
    if (!pendingTyped.length || said || phase === 'ended') return;
    disarm('spec');
    disarm('commit');
    disarm('silence');
    const texts = pendingTyped.slice();
    pendingTyped = [];
    const line = texts.map(entry => entry.text).join(' ');
    const utterance = {
      utteranceId: newId(), texts, text: line, tries, generated: texts.every(entry => entry.generated), parts: [line], words: [], positionMs: 0, positionAt: null,
      playbackStarted: false, audioBytes: 0, sampleRate: null, gotAudio: false, voiceDone: false, startMs: null,
      ctl: new AbortController(), stream: null, startTimer: null, finishTimer: null, cancelWait: null, boundaryTimer: null,
      stopping: false, cutBy: null, nextCheckMs: th.cutInFirstMs, caption: '', pcm: [],
    };
    let stream;
    try {
      stream = candidateVoice.open({ utteranceId: utterance.utteranceId, text: line, signal: utterance.ctl.signal });
    } catch {
      return candidateVoiceLost(texts, tries);
    }
    said = utterance;
    utterance.stream = stream;
    utterance.sampleRate = stream.sampleRate;
    stream.onAudio(buffer => {
      if (said !== utterance || utterance.stopping) return;
      utterance.gotAudio = true;
      utterance.audioBytes += buffer?.length ?? 0;
      // Kept so an interviewer cutting in can play what comes next of it under their first words.
      if (buffer?.length) utterance.pcm.push(Buffer.from(buffer));
      attempt(() => audio.pushAudio(utterance.utteranceId, buffer));
    });
    stream.onWords(list => { if (said === utterance && Array.isArray(list)) utterance.words.push(...list); });
    attempt(() => audio.play(utterance.utteranceId, utterance.sampleRate));
    utterance.startTimer = schedule(th.candidateVoiceStartMs, () => { if (!utterance.gotAudio) saidFailed(utterance); });
    Promise.resolve(stream.done).then(() => saidVoiceDone(utterance, false), () => saidVoiceDone(utterance, true));
    setPhase('listening');
    emit({ type: 'candidate-voice', state: 'speaking', chars: line.length });
  }

  function dropSaid(utterance) {
    for (const key of ['startTimer', 'finishTimer', 'cancelWait', 'boundaryTimer']) { unschedule(utterance[key]); utterance[key] = null; }
    attempt(() => utterance.ctl.abort());
    attempt(() => utterance.stream?.cancel());
  }

  /** The voice has sent everything it will: let the line play out. */
  function saidVoiceDone(utterance, failed) {
    if (said !== utterance || utterance.stopping) return;
    utterance.voiceDone = true;
    if (!utterance.gotAudio) return saidFailed(utterance);
    if (failed) emit({ type: 'error', code: 'candidate-voice-failed' });
    attempt(() => audio.endUtterance(utterance.utteranceId));
    armSaidFinishWatch(utterance);
  }

  /** No sound came out of the line. */
  function saidFailed(utterance) {
    if (said !== utterance) return;
    said = null;
    dropSaid(utterance);
    attempt(() => audio.cancel(utterance.utteranceId));
    if (current && !current.committed) discardPending(false, 'candidate-voice-failed');
    candidateVoiceLost(utterance.texts, utterance.tries);
  }

  /**
   * The interviewer only ever hears the candidate: a sent message is never passed on as text. A line the voice could
   * not say is tried once more; after that it is lost, like speech on a line that dropped, and the candidate is told
   * (the message stays in their chat history to send again).
   */
  function candidateVoiceLost(texts, tries) {
    if (phase === 'ended') return;
    if (tries < 2) {
      pendingTyped = [...texts, ...pendingTyped];
      return speakTyped(undefined, tries + 1);
    }
    emit({ type: 'error', code: 'candidate-voice-failed' });
    if (pendingTyped.length) return speakTyped();
    deliverVoiced();
  }

  function armSaidFinishWatch(utterance) {
    unschedule(utterance.finishTimer);
    utterance.finishTimer = null;
    if (said !== utterance || !utterance.voiceDone || !utterance.playbackStarted || utterance.stopping) return;
    utterance.finishTimer = schedule(remainingMs(utterance) + FINISH_SLACK_MS, () => {
      emit({ type: 'error', code: 'playback-stalled' });
      attempt(() => audio.cancel(utterance.utteranceId));
      saidEnded(utterance, utterance.positionMs, null);
    });
  }

  function onSaidPlayback(utterance, event) {
    noteHelperTime(event.atMs);
    if (event.state === 'position' || event.state === 'paused' || event.state === 'resumed') {
      if (Number.isFinite(event.positionMs)) utterance.positionMs = event.positionMs;
      utterance.positionAt = now();
      if (event.state !== 'position' || utterance.stopping) return;
      armSaidFinishWatch(utterance);
      captionSaid(utterance, false);
      maybeCutIn(utterance);
      return;
    }
    if (event.state === 'started') {
      if (utterance.playbackStarted) return;
      utterance.playbackStarted = true;
      utterance.startMs = Number.isFinite(event.atMs) ? Math.round(event.atMs) : helperTimelineMs();
      utterance.positionAt = now();
      unschedule(utterance.startTimer);
      utterance.startTimer = null;
      armSaidFinishWatch(utterance);
      return;
    }
    if (event.state === 'finished') return saidEnded(utterance, utterance.stopping ? livePosition(utterance) : Infinity, event.atMs);
    if (event.state === 'cancelled') return saidEnded(utterance, event.positionMs, event.atMs);
  }

  /** The candidate's words so far as a running caption, like the transcription gives for spoken words. */
  function captionSaid(utterance, final, heard) {
    const text = heard ?? stripAudioTags(heardFor(utterance, utterance.positionMs));
    if (!text || (!final && text === utterance.caption)) return;
    utterance.caption = text;
    emit({ type: 'caption', speaker: 'candidate', text, final });
  }

  /**
   * While the line plays, the interviewer gets a look at what has been heard so far (from cutInFirstMs, then every
   * cutInEveryMs) and either listens on (<listen/>) or cuts in. Only one look at a time, never paused, never near the end.
   */
  function maybeCutIn(utterance) {
    if (said !== utterance || utterance.stopping || paused || current || cancelling || phase === 'ended') return;
    const position = livePosition(utterance);
    if (position < utterance.nextCheckMs) return;
    if (utterance.voiceDone && remainingMs(utterance) < th.cutInMinLeftMs) return;
    const heard = stripAudioTags(heardFor(utterance, position));
    if (!heard) return;
    utterance.nextCheckMs = position + th.cutInEveryMs;
    const earlier = voicedDone.map(entry => entry.text);
    beginTurn({ text: [...earlier, heard].join(' '), channel: 'voice', immediate: true, cutInCheck: true, candidates: [] });
  }

  /**
   * The interviewer's cut-in is ready to play. As when one interviewer cuts into another (the panel voice), the two
   * voices overlap: the candidate's voice stops now, but what it was about to say plays on under the interviewer's
   * first words, through their leading silence and then CUT_IN_OVERLAP_MS more, fading out (audio/cutInMix.js).
   * Without that audio (a different rate, nothing left of the line) it stops at the end of its current word instead.
   */
  function cutInOnSaid(reply) {
    const utterance = said;
    if (utterance.stopping) return;
    utterance.stopping = true;
    utterance.cutBy = reply;
    unschedule(utterance.finishTimer);
    utterance.finishTimer = null;
    const position = livePosition(utterance);
    const overlap = overlapTail(utterance, reply, position);
    if (overlap) {
      reply.mixHead = overlap.tail;
      attempt(() => audio.cancel(utterance.utteranceId));
      // The words heard are those finished by the end of the overlap; the interviewer's audio carries that part.
      saidEnded(utterance, position + overlap.ms, null);
      return;
    }
    utterance.boundaryTimer = afterWordBoundary(utterance, () => {
      utterance.boundaryTimer = null;
      if (said !== utterance) return;
      utterance.positionMs = livePosition(utterance);
      utterance.positionAt = now();
      attempt(() => audio.cancel(utterance.utteranceId));
      // The helper reports where it stopped; if it never does, the estimate stands.
      utterance.cancelWait = schedule(CANCEL_WAIT_MS, () => saidEnded(utterance, utterance.positionMs, null));
    });
  }

  /** The candidate's audio from `position` to the interviewer's first speech plus the overlap, faded out; null when there is none. */
  function overlapTail(utterance, reply, position) {
    const rate = utterance.sampleRate;
    if (!rate || rate !== reply.sampleRate || !utterance.pcm.length) return null;
    const theirs = Buffer.concat(reply.buffered);
    const first = firstSpeechSample(theirs, rate);
    // Their leading silence, as far as it has arrived; a long one is not waited through.
    const leadMs = Math.min(1000, ((first < 0 ? theirs.length >> 1 : first) / rate) * 1000);
    const pcm = Buffer.concat(utterance.pcm);
    const from = msSamples(rate, position) * 2;
    const length = msSamples(rate, leadMs + CUT_IN_OVERLAP_MS) * 2;
    if (from >= pcm.length) return null;
    const tail = Buffer.from(pcm.subarray(from, Math.min(pcm.length, from + length)));
    if (tail.length < msSamples(rate, 100) * 2) return null;
    return { tail: fadeOutTail(tail, rate), ms: ((tail.length >> 1) / rate) * 1000 };
  }

  /** An interviewer reply's audio to the helper, with a cut-into voice's tail summed under its start. */
  function pushReplyAudio(reply, buffer) {
    let data = buffer;
    if (reply.mixHead?.length && data?.length) {
      const { mixed, rest } = mixHeadInto(data, reply.mixHead, (reply.pushedBytes ?? 0) & 1);
      data = mixed;
      reply.mixHead = rest;
    }
    reply.pushedBytes = (reply.pushedBytes ?? 0) + (data?.length ?? 0);
    audio.pushAudio(reply.utteranceId, data);
  }

  /** The line is over: played to the end (positionMs Infinity) or cut at positionMs. */
  function saidEnded(utterance, positionMs, atMs) {
    if (said !== utterance) return;
    said = null;
    dropSaid(utterance);
    const whole = positionMs === Infinity;
    const heard = whole ? utterance.text : stripAudioTags(heardFor(utterance, Number.isFinite(positionMs) ? positionMs : livePosition(utterance)));
    const startMs = utterance.startMs ?? helperTimelineMs();
    const endMs = Math.max(startMs, Math.round(Number.isFinite(atMs) ? atMs : helperTimelineMs()));
    // A voice line is a sent message (channel chat, so the review keeps it out of the delivery measures) that was spoken.
    const entry = heard ? {
      speaker: 'candidate', channel: 'chat', voiced: true, text: heard, startMs, endMs, ...(utterance.generated ? { generated: true } : {}),
      ...(whole ? {} : { interrupted: true, heardText: heard, ...(utterance.cutBy ? { cutOffBy: 'interviewer' } : {}) }),
    } : null;
    if (heard) captionSaid(utterance, true, heard);
    emit({ type: 'candidate-voice', state: whole ? 'finished' : 'cut', heardChars: heard.length });
    if (heard) { silencePrompts = 0; silenceTotalMs = 0; nextGapMs = null; }
    const reply = utterance.cutBy;
    if (reply && current === reply && !reply.committed) {
      // The interviewer's reply answers everything heard so far; the unspoken rest of the line is dropped.
      reply.candidates = [...voicedDone, ...(entry ? [entry] : [])];
      reply.typed = true; // what it answers is finished: nothing more of it will come
      voicedDone = [];
      return tryCommit(reply);
    }
    if (entry) voicedDone.push(entry);
    if (pendingTyped.length) return speakTyped();
    deliverVoiced();
  }

  /** The interviewer hears the candidate's voice lines as one spoken turn. */
  function deliverVoiced() {
    if (phase === 'ended') return;
    if (paused) { voicedHeld = true; return; }
    if (current && !current.committed) discardPending(true, 'cut-in-late'); // a look at the line that never spoke: the line is whole now
    if (current || cancelling) return; // a reply already on air answers when it ends (finishReply)
    if (!voicedDone.length) { setPhase('listening'); armSilence(); return; }
    const entries = voicedDone;
    voicedDone = [];
    const spokenText = candidateText();
    const spoken = spokenText ? [{ speaker: 'candidate', text: spokenText, ...candidateSpan() }] : [];
    beginTurn({
      text: entries.map(entry => entry.text).join(' '), channel: 'voice', typed: true, immediate: true, spokenText,
      candidates: [...spoken, ...entries],
    });
  }

  // ---- chat and typing ------------------------------------------------------
  /** A sent chat message. `generated`: the text was written by Suggest a reply (heard the same, never counted as practice). */
  function typed(value, { generated = false } = {}) {
    const text = String(value ?? '').trim();
    if (!text || paused) return false; // only the shortcut resumes: a message typed during a pause is refused
    queueTyped({ text, generated: generated === true });
    return true;
  }

  function setPadText(value) {
    const next = String(value ?? '').slice(0, PAD_TEXT_CAP);
    if (next === padText) return;
    padText = next;
    // An edit during a pause or before the call is live opens no burst: the text simply goes with the next turn.
    if (phase === 'ended' || phase === 'connecting' || paused) return;
    padEditedAt = now();
    if (!padDirty) { padDirty = true; padDirtySince = padEditedAt; }
    // Writing in the pad is the candidate working, not the candidate being silent: every edit
    // holds the silence checks by itself (the window sends no typing signal for the pad, because
    // that signal means chat typing and holds the progress messages back). The hold lapses a
    // little after the last edit, and the normal silence wait starts from there.
    disarm('silence');
    silencePrompts = 0;
    silenceTotalMs = 0;
    arm('padTyping', th.typingExpireMs, () => { armSilence(); });
    schedulePadProgress();
  }

  function queueTyped(item) {
    if (phase === 'ended' || phase === 'connecting') return;
    disarm('silence');
    disarm('typing');
    typingNow = false;
    silencePrompts = 0;
    silenceTotalMs = 0;
    nextGapMs = null;
    if (said) {
      // The candidate's voice is still on an earlier message: this one is spoken straight after it.
      pendingTyped.push(item);
      return;
    }
    if (cancelling && !current) {
      // Queue behind the cancel: every typed text ends up in ONE typed turn, never a parallel reply.
      pendingTyped.push(item);
      const stopped = cancelling;
      const previous = stopped.afterCancel;
      stopped.afterCancel = () => { previous?.(); if (!current) beginTyped(); };
      return;
    }
    if (current && current.committed) {
      // Typed text is never an acknowledgement: whatever its length, the reply stops at a word boundary
      // and the text becomes one typed turn.
      pendingTyped.push(item);
      if (!current.typed) markTurnConsumed(); // what was said aloud before is already answered
      boundaryCancel(current, null, () => { if (!current) beginTyped(); });
      return;
    }
    if (current) discardPending(true);
    beginTyped(item);
  }

  /** Pause or resume the silence clock. Resuming re-arms the wait from zero; the check-in count is kept. */
  function setPaused(value) {
    const next = !!value;
    if (phase === 'ended' || phase === 'connecting' || next === paused) return;
    paused = next;
    if (paused) {
      pausedAt = now();
      disarm('silence');
      disarm('padIdle'); // the progress wait stands still too: it starts again from zero on resume
      dropCandidateActivity();
    } else {
      pausedTotalMs += now() - pausedAt;
      pausedAt = null;
      // Speech that began during the pause can still deliver words after it: they start before this mark.
      if (!current) { markTurnConsumed(); candidateSpoke = false; }
      if (padDirty) { padEditedAt = now(); padDirtySince = padEditedAt; schedulePadProgress(); }
      if (voicedHeld) { voicedHeld = false; deliverVoiced(); } else armSilence();
    }
    emit({ type: 'paused', paused });
  }
  /**
   * A pause stops the candidate's voice from steering the call: end any overlap (a reply the overlap had
   * paused plays on), forget unanswered speech and its timers. A reply already being spoken finishes.
   */
  function dropCandidateActivity() {
    speaking = false;
    if (overlapWait) { unschedule(overlapWait.timer); overlapWait = null; }
    const record = overlapRecord;
    overlap = null;
    if (record) {
      const wasPaused = record.paused && record.active;
      endOverlapRecord(record);
      if (wasPaused && current === record.reply && current?.committed) resumePlayback(record, current);
    }
    disarm('spec');
    disarm('commit');
    if (!current) { candidateSpoke = false; audioHint = false; markTurnConsumed(); }
  }

  function typing(isTyping) {
    if (phase === 'ended') return;
    typingNow = !!isTyping;
    if (typingNow) {
      disarm('silence');
      // The panel can vanish without saying it stopped: typing lapses unless it is refreshed.
      arm('typing', th.typingExpireMs, () => { typingNow = false; armSilence(); });
    } else {
      disarm('typing');
      armSilence();
    }
  }

  // ---- end of call ----------------------------------------------------------
  function end(reason, code, extra = {}) {
    if (phase === 'ended') return;
    const reply = current;
    current = null;
    if (reply) {
      const played = reply.committed && !reply.done;
      abortReply(reply);
      if (played) attempt(() => audio.cancel(reply.utteranceId));
    }
    if (cancelling) { abortReply(cancelling); cancelling = null; }
    if (said) {
      const line = said;
      said = null;
      dropSaid(line);
      attempt(() => audio.cancel(line.utteranceId));
    }
    phase = 'ended';
    for (const handle of [...handles]) { handles.delete(handle); attempt(() => clock.clearTimeout(handle)); }
    for (const controller of classifierControllers) attempt(() => controller.abort());
    classifierControllers.clear();
    named.spec = null; named.commit = null; named.silence = null; named.typing = null; named.padIdle = null; named.padTyping = null;
    endOverlapRecord(overlap);
    overlap = null;
    overlapWait = null;
    emit({ type: 'phase', phase });
    emit(code === undefined ? { type: 'ended', reason, ...extra } : { type: 'ended', reason, code, ...extra });
  }

  return {
    start() {
      if (phase !== 'connecting') return;
      startedAt = now();
      beginTurn({ greeting: true, immediate: true });
    },
    helperEvent,
    typed,
    typing,
    setPaused,
    setPadText,
    /** A late colleague arrived: the model hears about it with the next message, never on its own. */
    participantJoined(id) {
      const member = speakers?.find(item => item.id === id);
      if (!member || phase === 'ended') return;
      if (member.present) return;
      member.present = true;
      joinedQueue.push(member.name);
    },
    hangUp() { end('candidate'); },
    state: () => ({ phase, transcript: transcript.map(entry => ({ ...entry })), elapsedMs: elapsed(), paused, pausedMs: currentPauseMs(), askedQuestions: [...askedQuestions], answeredQuestions: answeredNow(),
      screen: screenShown ? { ...screenShown } : null, pad: { ...padState } }),
  };
}
