import { pcm16To16k, EAR_SAMPLE_RATE } from './audio/resample.js';

const TONE_CHUNK_MS = 6000;
// How long a line's note waits for its tone scores before going out on prosody alone.
const VOICED_TONE_WAIT_MS = 2000;

async function defaultWavOpen() {
  const module = await import('./audio/wavReader.js');
  return module.openGrowingWav;
}

async function defaultInference({ smartTurnPath, tonePath }) {
  const module = await import('./models/inferenceWorker.js');
  return module.createPracticeInference({ smartTurnPath, tonePath });
}

async function defaultProsody() {
  return (await import('./audio/prosody.js')).turnProsodyAsync;
}

async function defaultBaseline(options) {
  return (await import('./audio/baseline.js')).createVoiceBaseline(options);
}

async function defaultToneNote() {
  return (await import('./audio/toneNote.js')).composeVoiceNote;
}

async function defaultFloorBid(options) {
  return (await import('./audio/floorBid.js')).createFloorBidDetector(options);
}

/**
 * Ear on the candidate track. `endOfTurn` asks the inference worker for the
 * Smart Turn probability; `floorBid` judges an overlap with the user's
 * baseline; `voiceNote` is synchronous and never waits on a model: it composes
 * the prosody of a span with the most recent background tone scores.
 *
 * The candidate's synthetic voice (a sent chat line spoken on the call) is a different voice from
 * the microphone, never on the candidate track: `prepareVoiced` measures a line in the background
 * from its own audio and `voicedNote` composes the same kind of note against a baseline of its own.
 */
export function createPracticeEar({
  candidatePath,
  wavOpen = defaultWavOpen,
  inference = defaultInference,
  createInference = null,
  prosody = defaultProsody,
  baseline = defaultBaseline,
  floorBid = defaultFloorBid,
  toneNote = defaultToneNote,
  smartTurnPath = null,
  tonePath = null,
  minSpeechMs = 20000,
  voicedMinSpeechMs: voicedMinOption = null,
  onToneSample = () => {},
} = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath) throw new TypeError('Practice ear requires the candidate recording path.');
  let wav = null;
  let worker = null;
  let pro = null;
  let base = null;
  let note = null;
  const toneSamples = [];
  // Every measured answer span, kept so the call record can hold the prosody per turn.
  const measuredTurns = [];
  // R12: noteSpeech runs in the background; settle() can wait for its work.
  const inflight = new Set();
  let speechMs = 0;
  let latestTone = null;
  let closed = false;
  // The synthetic voice: its own baseline, tone memory and measured lines, never mixed with the microphone's.
  const voicedLines = new Map();
  const voicedToneSamples = [];
  let voicedBase = null;
  let voicedSpeechMs = 0;
  let voicedLatestTone = null;
  // A synthetic voice's tone model scores drift more than a person's, so its baseline is built from more speech.
  const voicedMinSpeechMs = Number.isFinite(voicedMinOption) && voicedMinOption > 0 ? voicedMinOption : minSpeechMs * 3;

  // Background work settle() can wait for; it leaves the set when it ends, however it ends.
  function track(work) {
    inflight.add(work);
    const done = () => { inflight.delete(work); };
    work.then(done, done);
    return work;
  }
  /** A measured turn with its pace added when the word count and the speech time are known. */
  function withPace(measured, words) {
    const spoken = Number(measured?.speechMs) || 0;
    return words > 0 && spoken > 0
      ? { ...measured, wordCount: words, wordsPerMinute: Math.round((words / spoken) * 60000 * 10) / 10 }
      : measured;
  }

  let opening = null;
  function reader() {
    // One shared attempt: two callers arriving together must not each open the file, or the
    // first handle is overwritten and never closed. A failed attempt is forgotten so the next
    // caller tries again (the recording may not exist yet).
    opening ??= (async () => {
      // Every dependency here is a loader (an async function), like the defaults above.
      const open = await wavOpen();
      // The reader uses synchronous file calls, so it takes its own default file system.
      wav = await open(candidatePath);
      return wav;
    })().catch(error => { opening = null; throw error; });
    return opening;
  }
  // Each loader caches its pending promise, so callers arriving together share one load. A
  // failed load is forgotten so the next caller tries again.
  const pending = {};
  function loadOnce(key, load) {
    pending[key] ??= load().catch(error => { pending[key] = null; throw error; });
    return pending[key];
  }
  function workerOf() {
    return loadOnce('worker', async () => {
      const created = createInference ? createInference({ smartTurnPath, tonePath }) : await inference({ smartTurnPath, tonePath });
      // A worker that finishes loading after close() would never be closed by anyone else.
      if (closed) {
        try { created?.close?.(); } catch { /* worker already gone */ }
        throw new Error('Practice ear is closed.');
      }
      worker = created;
      return worker;
    });
  }
  function prosodyOf() { return loadOnce('prosody', async () => { pro = await prosody(); return pro; }); }
  function baselineOf() { return loadOnce('baseline', async () => { base = await baseline({ minSpeechMs }); return base; }); }
  function floorOf() { return loadOnce('floor', async () => { return floorBid({ baseline: await baselineOf() }); }); }
  function voicedBaselineOf() { return loadOnce('voicedBaseline', async () => { voicedBase = await baseline({ minSpeechMs: voicedMinSpeechMs }); return voicedBase; }); }
  function noteOf() { return loadOnce('note', async () => { note = await toneNote(); return note; }); }
  // composeVoiceNote is pure and cheap, so load it with the ear: the voice-note
  // path then has it in hand instead of waiting on a model mid-call.
  const noteLoaded = noteOf().catch(() => null);

  function spanSamples(startMs, endMs) {
    if (!wav) return null;
    return wav.readMs(Math.max(0, startMs), Math.max(0, endMs));
  }

  async function endOfTurn(atMs) {
    if (closed) return 0.5;
    const readerNow = await reader();
    const end = Number.isFinite(atMs) ? atMs : readerNow.writtenMs();
    const samples = readerNow.readMs(Math.max(0, end - 8000), Math.max(0, end));
    if (!samples.length) return 0.5;
    let workerNow;
    try { workerNow = await workerOf(); } catch (error) {
      if (closed) return 0.5;
      throw error;
    }
    const value = await workerNow.endOfTurn(samples);
    return Number.isFinite(value) ? value : 0.5;
  }

  async function assessFloor({ startMs, endMs, wordCount = 0 } = {}) {
    const readerNow = await reader();
    const end = Number.isFinite(endMs) ? endMs : readerNow.writtenMs();
    const samples = readerNow.readMs(Math.max(0, startMs || 0), Math.max(0, end));
    const detector = await floorOf();
    return detector.assess({ samples, sampleRate: readerNow.sampleRate ?? 16000, overlapMs: Math.max(0, end - (startMs || 0)), wordCount });
  }

  /** Feed an answer span: baseline prosody now, tone scores in the background. */
  function noteSpeech({ startMs, endMs, wordCount = 0, voiced = false } = {}) {
    if (closed || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
    const run = async () => {
      // The recording is opened here too: a call may reach its first answer before any
      // end-of-turn check has opened it.
      await reader();
      const samples = spanSamples(startMs, endMs);
      if (!samples || !samples.length) return;
      await noteLoaded;
      const measure = await prosodyOf();
      if (closed) return;
      // The default measure is async so a long answer's pitch track never stalls the call.
      const measured = await measure({ samples, sampleRate: 16000, startMs, endMs, words: [] });
      if (closed) return;
      // The measure has no word timings here, so pace is the segment's word count over its speech time.
      const turn = withPace(measured, Number.isFinite(wordCount) && wordCount > 0 ? Math.round(wordCount) : 0);
      measuredTurns.push({ ...turn, startMs, endMs, ...(voiced ? { voiced: true } : {}) });
      // Only the first ~minSpeechMs of candidate speech defines the baseline;
      // later answers are measured against it rather than moving it. A segment the caller says is the synthetic
      // voice (heard on the microphone path) feeds that voice's baseline, never the human's.
      const feedsBaseline = voiced ? voicedSpeechMs < voicedMinSpeechMs : speechMs < minSpeechMs;
      if (voiced) voicedSpeechMs += Number(turn?.speechMs) || 0; else speechMs += Number(turn?.speechMs) || 0;
      const active = voiced ? await voicedBaselineOf() : await baselineOf();
      if (feedsBaseline) active.add(turn, voiced ? voicedLatestTone : latestTone);
      const workerNow = await workerOf();
      for (let offset = 0; offset < endMs - startMs; offset += TONE_CHUNK_MS) {
        if (closed) return;
        const chunkStart = startMs + offset;
        const chunkEnd = Math.min(endMs, chunkStart + TONE_CHUNK_MS);
        if (chunkEnd - chunkStart < 1000) continue;
        const chunk = wav.readMs(chunkStart, chunkEnd);
        if (!chunk.length) continue;
        try {
          const tone = await workerNow.tone(chunk);
          if (!tone) continue;
          if (voiced) voicedLatestTone = tone; else latestTone = tone;
          const sample = { atMs: chunkStart, endMs: chunkEnd, arousal: tone.arousal, dominance: tone.dominance, valence: tone.valence, ...(voiced ? { voiced: true } : {}) };
          toneSamples.push(sample);
          try { onToneSample(sample); } catch { /* observer errors never break the call */ }
        } catch { /* tone is best effort */ }
      }
    };
    track(run());
  }

  /** R12: resolve once background tone/prosody work is done, or after the timeout. */
  async function settle(timeoutMs = 2000) {
    const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 2000;
    const deadline = Date.now() + budget;
    while (inflight.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let timer = null;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise(resolveWaited => { timer = setTimeout(resolveWaited, remaining); timer?.unref?.(); }),
      ]);
      clearTimeout(timer);
    }
  }

  /** Tone scores for the 6 s chunks of one voiced line, kept with their offset into the line. */
  async function voicedTone(line) {
    let workerNow;
    try { workerNow = await workerOf(); } catch { return; }
    for (let offset = 0; offset < line.durationMs; offset += TONE_CHUNK_MS) {
      if (closed) return;
      const endOffset = Math.min(line.durationMs, offset + TONE_CHUNK_MS);
      const chunk = line.samples.subarray(Math.floor((offset * EAR_SAMPLE_RATE) / 1000), Math.floor((endOffset * EAR_SAMPLE_RATE) / 1000));
      if (endOffset - offset < 1000 || !chunk.length) continue;
      try {
        const tone = await workerNow.tone(chunk);
        if (tone) line.chunks.push({ offset, endOffset, arousal: tone.arousal, dominance: tone.dominance, valence: tone.valence });
      } catch { /* tone is best effort */ }
    }
  }

  /**
   * Background analysis of one AI-voice line (16-bit mono PCM at 24 or 44.1 kHz): converted to 16 kHz
   * for the prosody and tone models. Never throws and never waits for anything.
   */
  function prepareVoiced({ id, pcm, sampleRate, wordCount = 0 } = {}) {
    try {
      if (closed || id === undefined || id === null || !pcm || !pcm.length || !(sampleRate > 0)) return;
      const run = async () => {
        const samples = pcm16To16k(pcm, sampleRate);
        if (!samples.length) return;
        const line = {
          samples, wordCount: Number.isFinite(wordCount) && wordCount > 0 ? Math.round(wordCount) : 0,
          durationMs: (samples.length * 1000) / EAR_SAMPLE_RATE, chunks: [], tone: null, recorded: false, turn: null,
        };
        voicedLines.set(id, line);
        // The conversion is quick; the tone scores keep running on their own and settle() still waits for them.
        line.tone = track(voicedTone(line));
      };
      if (voicedLines.has(id)) return;
      // The line is known at once so a note asked for while it converts waits for it rather than missing it.
      const placeholder = {};
      voicedLines.set(id, placeholder);
      const work = track(run().catch(() => {}));
      // Until the conversion has made the line, the placeholder holds the wait; run() replaces it.
      if (voicedLines.get(id) === placeholder) placeholder.pending = work;
    } catch { /* the ear never breaks the call */ }
  }

  async function lineOf(id) {
    const first = voicedLines.get(id);
    if (!first) return null;
    if (first.pending) await first.pending;
    const line = voicedLines.get(id);
    return line?.samples ? line : null;
  }

  /** Tone samples of the heard part go on the call record, once, on the transcript timeline. */
  function recordVoicedTone(line, startMs, heardMs) {
    if (line.recorded || closed) return;
    line.recorded = true;
    for (const chunk of line.chunks) {
      if (chunk.offset >= heardMs) continue;
      const end = Math.min(chunk.endOffset, heardMs);
      if (end - chunk.offset < 1000) continue;
      const sample = { atMs: startMs + chunk.offset, endMs: startMs + end, arousal: chunk.arousal, dominance: chunk.dominance, valence: chunk.valence, voiced: true };
      voicedToneSamples.push(sample);
      try { onToneSample(sample); } catch { /* observer errors never break the call */ }
    }
  }

  /**
   * The [voice] note for an AI-voice line, measured on its heard part against the synthetic voice's own
   * baseline; null until that baseline is ready. The measured turn also goes into the call record.
   */
  // Tracked like the other background work, so settle() before the record is written waits for the last line's measures.
  function voicedNote(args = {}) {
    return track(measureVoiced(args));
  }

  async function measureVoiced({ id, startMs, endMs, heardMs } = {}) {
    try {
      if (closed || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      const line = await lineOf(id);
      if (!line || closed) return null;
      const heard = Number.isFinite(heardMs) && heardMs > 0 ? Math.min(heardMs, line.durationMs) : line.durationMs;
      // The tone scores are the slow part: wait for them a little, then go out on prosody alone.
      let timer = null;
      const finished = await Promise.race([
        line.tone.then(() => true),
        new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), VOICED_TONE_WAIT_MS); timer?.unref?.(); }),
      ]);
      clearTimeout(timer);
      if (!finished) line.tone.then(() => recordVoicedTone(line, startMs, heard));
      await noteLoaded;
      const measure = await prosodyOf();
      const active = await voicedBaselineOf();
      if (closed) return null;
      const part = line.samples.subarray(0, Math.floor((heard * EAR_SAMPLE_RATE) / 1000));
      const measured = await measure({ samples: part, sampleRate: EAR_SAMPLE_RATE, startMs, endMs, words: [] });
      if (closed) return null;
      // Pace over the heard part: the line's word count scaled by how much of it was heard.
      const words = line.wordCount > 0 ? Math.round(line.wordCount * Math.min(1, heard / line.durationMs)) : 0;
      const turn = withPace(measured, words);
      const heardChunks = line.chunks.filter(chunk => chunk.offset < heard);
      const tone = heardChunks.length ? heardChunks[heardChunks.length - 1] : voicedLatestTone;
      if (heardChunks.length) voicedLatestTone = tone;
      const record = { ...turn, startMs, endMs, voiced: true };
      const at = line.turn ? measuredTurns.indexOf(line.turn) : -1;
      if (at >= 0) measuredTurns[at] = record; else measuredTurns.push(record);
      const firstNote = !line.turn;
      line.turn = record;
      if (finished) recordVoicedTone(line, startMs, heard);
      // Only the first ~minSpeechMs of the synthetic voice defines its baseline, as for the microphone.
      if (firstNote && voicedSpeechMs < voicedMinSpeechMs) active.add(turn, tone);
      if (firstNote) voicedSpeechMs += Number(turn?.speechMs) || 0;
      if (!active.ready()) return null;
      const compose = await noteOf();
      // The synthetic voice's tone-model confidence and pitch range wander by more than the thresholds on their own, so
      // only pace, long pauses, energy and restarts can be noted for it.
      return compose({ ...active.relative(turn, tone), dominanceDelta: null, pitchRangeDeltaSt: null }) ?? null;
    } catch { return null; }
  }

  function voiceNote({ startMs, endMs, wordCount } = {}) {
    if (closed || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    const samples = spanSamples(startMs, endMs);
    if (!samples || !samples.length || !pro || !base || !note) return null;
    if (!base.ready()) return null;
    const whole = pro({ samples, sampleRate: 16000, startMs, endMs, words: [] });
    // The baseline is made of single recogniser segments, so a turn's pauses and speech time come from its segments
    // too (as the call record has them); measuring the whole span would count the silence between sentences as pauses.
    const inside = measuredTurns.filter(item => !item.voiced && item.startMs >= startMs - 50 && item.endMs <= endMs + 50);
    const pauses = inside.flatMap(item => item.pauses ?? []);
    const measured = inside.length
      ? { ...whole, pauses, pauseCount: pauses.length, longestPauseMs: pauses.reduce((longest, pause) => Math.max(longest, pause.endMs - pause.startMs), 0), speechMs: inside.reduce((sum, item) => sum + (Number(item.speechMs) || 0), 0) || whole.speechMs }
      : whole;
    // Pace needs the words of this span: use the caller's count, else the one noted for the same span.
    const known = Number.isFinite(wordCount) ? wordCount : measuredTurns.find(item => !item.voiced && item.startMs === startMs && item.endMs === endMs)?.wordCount;
    const turn = withPace(measured, known);
    let tone = latestTone;
    for (const sample of toneSamples) if (sample.atMs >= startMs && sample.atMs < endMs) tone = sample;
    return note(base.relative(turn, tone));
  }

  return Object.freeze({
    endOfTurn,
    floorBid: assessFloor,
    voiceNote,
    noteSpeech,
    prepareVoiced,
    voicedNote,
    settle,
    toneSamples: () => [...toneSamples, ...voicedToneSamples].map(sample => ({ ...sample })).sort((left, right) => left.atMs - right.atMs),
    /** Measured candidate turns in time order, each with its pauses, for the call record. */
    prosodyTurns: () => measuredTurns.map(turn => ({ ...turn })).sort((left, right) => left.startMs - right.startMs),
    /** The voice baseline's medians, or null when no answer has been measured. */
    baselineSnapshot: () => { try { return base?.snapshot?.() ?? null; } catch { return null; } },
    /** The synthetic voice's own baseline medians, or null before any AI-voice line was measured. */
    voicedBaselineSnapshot: () => { try { return voicedBase?.snapshot?.() ?? null; } catch { return null; } },
    transcript: async () => (await reader()).writtenMs(),
    close: () => {
      closed = true;
      voicedLines.clear();
      try { wav?.close(); } catch { /* already closed */ }
      try { worker?.close?.(); } catch { /* worker already gone */ }
    },
  });
}

export const createEar = createPracticeEar;
export default createPracticeEar;
