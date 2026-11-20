// LIVE probe: where the main interviewer reply's wait before its first word goes. Same replay as
// main-first-sentence.mjs (one warm session, the candidate's lines of a saved call in order), but it taps the
// CLI's raw stream to time, per turn, from the moment the message is written to stdin:
//   apiStart   first stream event (message_start): CLI overhead + time to the model's first token
//   think      first thinking delta, and how many thinking characters came before the text
//   text       first text delta (what firstDeltaMs measures), first clause break, first sentence
//
//   node scripts/practice-probes/main-latency-breakdown.mjs <call.json> [--model opus] [--effort low]
//        [--thinking off] [--settings JSON] [--limit 12] [--json OUT]
//
// --thinking off sets MAX_THINKING_TOKENS=0 for the CLI process. Spends Claude usage only.
import fs from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterviewerSession } from '../../electron/interviewPracticeTransport.js';
import { buildInterviewerInstructions, formatTurnMessage } from '../../electron/interviewPracticeCallPrompt.js';
import { connectedMarker } from '../../electron/interviewPracticeCallEngine.js';
import { activeElapsed, callPlanFrom, percentile } from './main-first-sentence.mjs';

const REACTIONS = [
  'Mm-hm, okay, I follow that.', 'Yeah, sure, happy to.', 'Ah, okay, I hear you.', 'Gotcha, okay, thanks for that.',
  'Fair enough, yeah, that\'s alright.', 'Right, yeah, got it.', 'No worries, that\'s totally fine.', 'I see. Okay, thanks for walking me through that.',
];

/** A spawn that adds env and taps stdin writes and raw stdout events with timestamps. */
function tappedSpawn(extraEnv, tap, extraArgs = []) {
  return (binary, args, options) => {
    const child = nodeSpawn(binary, args.includes('-p') ? [...args, ...extraArgs] : args, { ...options, env: { ...options.env, ...extraEnv } });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => { tap.onWrite(); return write(chunk, ...rest); };
    let buffer = '';
    child.stdout.on('data', data => {
      const now = performance.now();
      buffer += data.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { tap.onEvent(JSON.parse(line), now); } catch { /* not json */ }
      }
    });
    return child;
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string', default: 'opus' }, effort: { type: 'string', default: 'low' }, thinking: { type: 'string', default: 'on' }, settings: { type: 'string' }, limit: { type: 'string', default: '12' }, json: { type: 'string' } },
  });
  const call = JSON.parse(await fs.readFile(positionals[0], 'utf8'));
  const lines = (call.transcript || []).filter(e => e.speaker === 'candidate' && String(e.text ?? '').trim()).slice(0, Number.parseInt(values.limit, 10) || 12);
  let turn = null;
  const tap = {
    onWrite() { turn = { writtenAt: performance.now(), apiStart: null, thinkFirst: null, thinkChars: 0, textFirst: null, clauseFirst: null, text: '', blocks: [] }; },
    onEvent(event, now) {
      if (!turn || event.type !== 'stream_event') return;
      const e = event.event; const at = Math.round(now - turn.writtenAt);
      if (e?.type === 'message_start' && turn.apiStart === null) turn.apiStart = at;
      if (e?.type === 'content_block_start') turn.blocks.push(e.content_block?.type);
      if (e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') { if (turn.thinkFirst === null) turn.thinkFirst = at; turn.thinkChars += String(e.delta.thinking ?? '').length; }
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        if (turn.textFirst === null) turn.textFirst = at;
        turn.text += e.delta.text;
        if (turn.clauseFirst === null && /[A-Za-z]{2}[,;:—–-]\s|[.!?]\s/.test(turn.text.replace(/^\s*\[[^\]]*\]\s*/, ''))) turn.clauseFirst = at;
      }
    },
  };
  const extraEnv = values.thinking === 'off' ? { MAX_THINKING_TOKENS: '0' } : {};
  const options = {
    persona: { name: call.persona?.name, role: call.persona?.role, team: call.persona?.team, temperament: call.persona?.temperament, voice: call.persona?.voice },
    brief: { company: 'Nexon Korea', role: 'Client Programmer, action RPG' },
    plan: [], targetMinutes: [25, 30],
    panel: (call.panel || []).map(e => ({ id: e.id, name: e.name, role: e.role, focus: e.focus, joins: e.joins, voice: e.voice })),
    callPlan: callPlanFrom(call),
  };
  const session = await createInterviewerSession({ model: values.model, effort: values.effort }, { spawn: tappedSpawn(extraEnv, tap, values.settings ? ['--settings', values.settings] : []) });
  const rows = [];
  try {
    await session.start({ instructions: buildInterviewerInstructions(options) });
    let last = (await session.turn(`[elapsed 00:00] ${connectedMarker(null)}`, {})).sentences.join(' ');
    const elapsed = activeElapsed(lines);
    for (const [index, entry] of lines.entries()) {
      const message = formatTurnMessage({ elapsedMs: elapsed[index], candidateText: String(entry.text).trim(), channel: entry.channel === 'chat' ? 'chat' : undefined, acknowledgement: REACTIONS[index % REACTIONS.length], lastSpoken: last.replace(/\s+/g, ' ').slice(0, 400) });
      const result = await session.turn(message, {});
      last = result.sentences.join(' ');
      rows.push({ turn: index + 1, apiStart: turn.apiStart, thinkFirst: turn.thinkFirst, thinkChars: turn.thinkChars, textFirst: turn.textFirst, clauseFirst: turn.clauseFirst, firstSentenceMs: result.firstSentenceMs, totalMs: result.totalMs, blocks: turn.blocks.join('+'), usage: result.usage, first: result.sentences[0] ?? '' });
    }
  } finally { await session.close(); }
  for (const r of rows) console.log(`#${String(r.turn).padStart(2)} api ${r.apiStart} think ${r.thinkFirst ?? '-'}(${r.thinkChars}c) text ${r.textFirst} clause ${r.clauseFirst} sentence ${r.firstSentenceMs} [${r.blocks}] ${r.first.slice(0, 70)}`);
  for (const key of ['apiStart', 'textFirst', 'clauseFirst', 'firstSentenceMs', 'thinkChars']) {
    const v = rows.map(r => r[key]);
    console.log(`${key.padEnd(16)} p50 ${percentile(v, 0.5)}  p75 ${percentile(v, 0.75)}  p95 ${percentile(v, 0.95)}`);
  }
  const u = rows.at(-1)?.usage; if (u) console.log('last usage speed', u.speed, 'thinking', u.output_tokens_details?.thinking_tokens, 'model', rows.length);
  if (values.json) await fs.writeFile(values.json, JSON.stringify(rows, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error?.stack ?? error); process.exit(1); });
