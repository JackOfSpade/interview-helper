// LIVE audio render of real turns: what the candidate would hear after each line, so two set-ups can be compared by ear.
// The candidate lines of a saved call are replayed in order on warm sessions (the acknowledgement session on Sonnet
// low, the reply on --model), with the real instructions built from the call's persona, panel and plan. For the turns
// named in --turns, the acknowledgement and the reply are spoken by the call's real ElevenLabs voices in the order and
// with the flushes the engine uses, and every audio chunk is placed where a player would play it (after the chunk
// before it, never before it arrived), so a late reply leaves the same silence it would on a call.
//
//   node scripts/practice-probes/turn-audio.mjs <call.json> --model opus|sonnet [--stability-add 0.15]
//        [--turns 2,4,6,12,13,17] [--out DIR] [--text-only [--limit 26]]
//
// The join follows the engine (joinAfterAcknowledgement in interviewPracticeCallEngine.js): whole sentences only; a
// reply ready while the acknowledgement has joinGapMinLeadMs or more to play starts after joinPauseMs (minus the
// near-silence already after its last word) in a new voice stream; its first sentence is flushed joinFlushLeadMs before
// the acknowledgement (and the pause) ends, or at once when less is left.
// --stability-add raises every voice's planned stability by that much (clamped to 0.75), to hear a steadier voice.
// --text-only replays the first --limit turns with no voice at all and writes only index.json (texts and timings).
// Writes DIR/turn-NN.wav (24 kHz mono: 0.4 s, a soft click when the candidate's line ends, then what is heard) and
// DIR/index.json (texts and timings). Spends Claude usage and ElevenLabs credits. Not part of any test suite.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterviewerSession } from '../../electron/interviewPracticeTransport.js';
import { buildInterviewerInstructions, buildOpenerInstructions, createReplyStreamParser, formatTurnMessage } from '../../electron/interviewPracticeCallPrompt.js';
import { connectedMarker, DEFAULT_CALL_THRESHOLDS, joinPauseMs } from '../../electron/interviewPracticeCallEngine.js';
import { readElevenLabsKey } from '../../electron/practiceCall/eleven/elevenKey.js';
import { createDialogueVoiceFactory, fetchSubscriptionTier } from '../../electron/practiceCall/eleven/dialogueVoice.js';
import { wavHeader } from '../../electron/practiceCall/audio/wavFormat.js';
import { activeElapsed, callPlanFrom } from './main-first-sentence.mjs';
import { pairsFrom } from './opener-ack.mjs';

const RATE = 24000;
const words = value => String(value ?? '').replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
const strip = value => String(value ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

function toRate(pcm, from) {
  const input = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  if (from === RATE) return input;
  const ratio = from / RATE;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) { const x = i * ratio; const a = Math.floor(x); const b = Math.min(input.length - 1, a + 1); out[i] = Math.round(input[a] + (input[b] - input[a]) * (x - a)); }
  return out;
}

/** One turn's audio timeline: streams play one after another; a chunk plays after the one before it, never before it arrives. */
function createTimeline(t0) {
  const chunks = [];
  let head = 0;
  let pauseMs = 0; // a deliberate pause before the next chunk, counted from the end of the last one
  return {
    place(samples) { const at = performance.now() - t0; const startMs = Math.max(head + pauseMs, at); pauseMs = 0; head = startMs + (samples.length / RATE) * 1000; chunks.push({ startMs, arrivedMs: at, samples }); return startMs; },
    pause(ms) { pauseMs = ms; },
    get nowMs() { return performance.now() - t0; },
    get headMs() { return head; },
    chunks,
    wav() {
      const lead = 400; const end = head + 700;
      const mix = new Float32Array(Math.ceil(((end + lead) / 1000) * RATE));
      for (const chunk of chunks) { const at = Math.round(((chunk.startMs + lead) / 1000) * RATE); for (let i = 0; i < chunk.samples.length && at + i < mix.length; i += 1) mix[at + i] += chunk.samples[i]; }
      const click = Math.round((lead / 1000) * RATE);
      for (let k = 0; k < 480; k += 1) mix[click + k] += 2500 * Math.sin((2 * Math.PI * 1000 * k) / RATE) * (1 - k / 480);
      const buf = Buffer.alloc(mix.length * 2);
      for (let i = 0; i < mix.length; i += 1) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i]))), i * 2);
      return Buffer.concat([wavHeader(buf.length, RATE), buf]);
    },
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string', default: 'opus' }, 'stability-add': { type: 'string', default: '0' }, turns: { type: 'string', default: '2,4,6,12,13,17' }, 'text-only': { type: 'boolean', default: false }, limit: { type: 'string', default: '26' }, out: { type: 'string', default: 'turn-audio' } },
  });
  const call = JSON.parse(await fs.readFile(positionals[0], 'utf8'));
  const stabilityAdd = Number.parseFloat(values['stability-add']) || 0;
  const steadier = value => Math.min(0.75, (Number.isFinite(value) ? value : 0.3) + stabilityAdd);
  const { joinGapMinLeadMs, joinFlushLeadMs } = DEFAULT_CALL_THRESHOLDS;
  const textOnly = values['text-only'];
  const wanted = new Set(values.turns.split(',').map(Number));
  const pairs = pairsFrom(call.transcript || []).slice(0, textOnly ? Number.parseInt(values.limit, 10) || 26 : Math.max(...wanted));
  const elapsed = activeElapsed(pairs); // long pauses out, or the interviewer would think the call is over time
  await fs.mkdir(values.out, { recursive: true });

  const factories = {};
  if (!textOnly) {
    const key = await readElevenLabsKey();
    const tier = await fetchSubscriptionTier({ key });
    factories.A = createDialogueVoiceFactory({ key, tier, voiceId: call.persona.voiceId, stability: steadier(call.persona.stability) });
    for (const entry of call.panel || []) factories[entry.id] = createDialogueVoiceFactory({ key, tier, voiceId: entry.voiceId, stability: steadier(entry.stability) });
  }

  const panel = (call.panel || []).map(e => ({ id: e.id, name: e.name, role: e.role, focus: e.focus, joins: e.joins, voice: e.voice }));
  const options = {
    persona: { name: call.persona?.name, role: call.persona?.role, team: call.persona?.team, temperament: call.persona?.temperament, voice: call.persona?.voice },
    brief: { company: 'Nexon Korea', role: 'Client Programmer, action RPG' }, plan: [], targetMinutes: [25, 30], panel, callPlan: callPlanFrom(call),
  };
  const opener = await createInterviewerSession({ model: 'sonnet', effort: 'low' });
  const mainSession = await createInterviewerSession({ model: values.model, effort: 'low' });
  const index = [];
  try {
    await Promise.all([opener.start({ instructions: buildOpenerInstructions({ persona: call.persona, panel: call.panel || [] }) }), mainSession.start({ instructions: buildInterviewerInstructions(options) })]);
    let last = strip((await mainSession.turn(`[elapsed 00:00] ${connectedMarker(null)}`, {})).text);
    for (const [at, pair] of pairs.entries()) {
      const turn = at + 1;
      const render = !textOnly && wanted.has(turn);
      const t0 = performance.now();
      const timeline = createTimeline(t0);
      const finishes = [];
      let stream = null;
      let speaker = 'A';
      const openStream = id => {
        const factory = factories[id] ?? factories.A;
        const opened = factory.open({ utteranceId: `t${turn}-${id}-${finishes.length}` });
        const rate = factory.sampleRate;
        opened.onAudio(pcm => timeline.place(toRate(pcm, rate)));
        opened.words = [];
        opened.onWords?.(list => opened.words.push(...list));
        return opened;
      };
      if (render) stream = openStream('A'); // the engine opens the reply's voice when the turn starts
      const openerMessage = formatTurnMessage({ elapsedMs: elapsed[at], candidateText: pair.candidate, channel: pair.channel, lastSpoken: last });
      const ackResult = await opener.turn(openerMessage, {});
      const ackText = String(ackResult.text ?? '').trim();
      const ackSpoken = /<(listen|pass)\/>/.test(ackText) || !words(ackText).length || words(ackText).length > 16 ? '' : ackText;
      const ackAtMs = Math.round(performance.now() - t0);
      if (render && ackSpoken) { stream.sendText(ackSpoken); stream.flush(); }
      const ackStream = stream;
      const parser = createReplyStreamParser();
      let flushTimer = null;
      let joined = null;
      let sentPieces = 0;
      const pieces = [];
      const take = snapshot => {
        for (const item of snapshot.items ?? []) {
          if (item.speaker && item.speaker !== speaker) {
            speaker = item.speaker;
            if (render) { finishes.push(stream.finish()); stream = openStream(speaker); }
          }
          if (item.sentence === undefined) continue;
          if (!/[\p{L}\p{N}]/u.test(strip(item.sentence))) continue;
          pieces.push({ text: item.sentence, atMs: Math.round(performance.now() - t0), speaker });
          sentPieces += 1;
          if (render) {
            if (sentPieces === 1) {
              // As the engine: how long the acknowledgement still plays, from the audio already placed.
              const remaining = ackSpoken ? Math.max(0, timeline.headMs - timeline.nowMs) : 0;
              const tail = ackStream.words.length ? Math.max(0, timeline.headMs - (timeline.chunks[0]?.startMs ?? 0) - Math.max(...ackStream.words.map(w => w.endMs))) : 150;
              let pause = 0;
              if (ackSpoken && remaining >= joinGapMinLeadMs) {
                pause = Math.round(Math.max(0, joinPauseMs(ackSpoken) - tail));
                if (pause >= 60) { finishes.push(stream.finish()); stream = openStream(speaker); timeline.pause(pause); } else pause = 0;
              }
              const flushIn = ackSpoken ? Math.max(0, remaining + pause - joinFlushLeadMs) : 0;
              joined = { remaining: Math.round(remaining), pause, flushIn: Math.round(flushIn) };
              // As the engine: right after an acknowledgement in the same voice, the first sentence keeps its mood.
              const plain = item.sentence.replace(/^(?:\s*\[[^\]]*\])+\s*/u, '');
              stream.sendText(ackSpoken && speaker === 'A' && /[\p{L}\p{N}]/u.test(plain) ? plain : item.sentence);
              const target = stream;
              if (flushIn === 0) target.flush(); else flushTimer = setTimeout(() => target.flush(), flushIn);
            } else stream.sendText(item.sentence);
          }
        }
      };
      const mainMessage = formatTurnMessage({ elapsedMs: elapsed[at], candidateText: pair.candidate, channel: pair.channel, lastSpoken: last, ...(ackSpoken ? { acknowledgement: ackSpoken } : {}) });
      const mainStartMs = Math.round(performance.now() - t0);
      const result = await mainSession.turn(mainMessage, { onDelta: delta => take(parser.push(delta)) });
      take(parser.end());
      last = strip(result.text).slice(0, 400);
      if (textOnly) { index.push({ turn, model: values.model, candidate: pair.candidate, acknowledgement: ackSpoken, reply: result.text.trim(), firstPieceMs: pieces[0]?.atMs ?? null, ackWrittenMs: ackAtMs }); console.log(`#${turn} ${ackSpoken} || ${strip(result.text).slice(0, 120)}`); continue; }
      if (!render) continue;
      clearTimeout(flushTimer);
      finishes.push(stream.finish());
      await Promise.allSettled(finishes);
      // The acknowledgement's audio is the first chunks; the reply's first audio is the first chunk that arrived after
      // its first piece was sent. A gap is time the candidate hears nothing between the two.
      const firstPieceAt = pieces[0]?.atMs ?? null;
      const replyChunk = timeline.chunks.find(chunk => firstPieceAt !== null && chunk.arrivedMs >= firstPieceAt);
      const ackChunks = ackSpoken ? timeline.chunks.filter(chunk => chunk !== replyChunk && (!replyChunk || chunk.arrivedMs < replyChunk.arrivedMs)) : [];
      const ackEndMs = ackChunks.length ? Math.max(...ackChunks.map(chunk => chunk.startMs + (chunk.samples.length / RATE) * 1000)) : null;
      const row = {
        turn, model: values.model, stabilityAdd, join: joined, candidate: pair.candidate, acknowledgement: ackSpoken, reply: strip(result.text),
        pieces: pieces.map(p => p.text),
        ms: {
          acknowledgementWritten: ackAtMs, firstSound: timeline.chunks.length ? Math.round(timeline.chunks[0].startMs) : null, acknowledgementEnds: ackEndMs === null ? null : Math.round(ackEndMs),
          replyStarted: mainStartMs, replyFirstPiece: firstPieceAt, replyFirstSound: replyChunk ? Math.round(replyChunk.startMs) : null,
          silenceBeforeReply: replyChunk && ackEndMs !== null ? Math.round(Math.max(0, replyChunk.startMs - ackEndMs)) : null,
        },
      };
      index.push(row);
      await fs.writeFile(path.join(values.out, `turn-${String(turn).padStart(2, '0')}.wav`), timeline.wav());
      console.log(`#${turn} first sound ${row.ms.firstSound} ms, ack ends ${row.ms.acknowledgementEnds}, reply sound ${row.ms.replyFirstSound}, silence ${row.ms.silenceBeforeReply} ms | ${ackSpoken} || ${row.pieces.slice(0, 2).join(' | ')}`);
    }
  } finally {
    await Promise.allSettled([opener.close(), mainSession.close()]);
  }
  await fs.writeFile(path.join(values.out, 'index.json'), JSON.stringify(index, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error?.stack ?? error); process.exit(1); });
