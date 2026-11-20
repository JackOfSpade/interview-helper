// LIVE probe of the acknowledgement ("opener") session: the real opener instructions on the real Claude CLI
// (the same warm session the call uses), fed interviewer-line / candidate-line pairs from a saved call.
//
//   node scripts/practice-probes/opener-ack.mjs <call.json> [--model haiku] [--effort low] [--limit 25] [--json OUT]
//
// Spends Claude usage only: never ElevenLabs, never the microphone. Turns run in order on ONE session, like
// a call, so wording variety is measured as the call would hear it. Rule checks are structural only (word
// count, question mark, ellipsis, digits, content words shared with the candidate's line); whether a reaction
// reads like a real listener is for the reader of the printout.
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterviewerSession } from '../../electron/interviewPracticeTransport.js';
import { buildOpenerInstructions, formatTurnMessage } from '../../electron/interviewPracticeCallPrompt.js';

const BARE_WORDS = 2; // a candidate line this short gets no length note, like in the engine
const words = value => String(value ?? '').replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
const letters = value => String(value ?? '').toLowerCase().replace(/[^a-z']/g, '');

/** Structural rule breaks of one reply (no word lists). */
export function ruleBreaks(reply, candidateText) {
  const body = String(reply ?? '').replace(/\[[^\]]*\]/g, ' ').trim();
  const breaks = [];
  const count = words(body).length;
  if (/<(listen|pass)\/>/.test(reply)) return breaks;
  if (count < 1) breaks.push('words:0'); // no cap: the acknowledgement chooses its own length
  if (/\?/.test(body)) breaks.push('question');
  if (/\.\.\.|…/.test(body)) breaks.push('ellipsis');
  if (/\d/.test(body)) breaks.push('digit');
  const theirs = new Set(words(candidateText).map(letters).filter(word => word.length >= 6));
  const shared = words(body).map(letters).filter(word => word.length >= 6 && theirs.has(word));
  if (shared.length) breaks.push(`echo:${[...new Set(shared)].join('/')}`);
  return breaks;
}

/** Pairs of (what the interviewer last said, what the candidate answered) in call order. */
export function pairsFrom(transcript) {
  const pairs = [];
  let last = '';
  for (const entry of transcript) {
    if (entry.speaker === 'interviewer') last = String(entry.text ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    else if (entry.speaker === 'candidate' && String(entry.text ?? '').trim()) {
      pairs.push({ lastSpoken: last, candidate: String(entry.text).trim(), startMs: entry.startMs ?? 0, channel: entry.channel === 'chat' ? 'chat' : undefined });
    }
  }
  return pairs;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string', default: 'haiku' }, effort: { type: 'string', default: 'low' }, limit: { type: 'string', default: '25' }, json: { type: 'string' }, claude: { type: 'string' } },
  });
  if (!positionals[0]) throw new Error('Usage: opener-ack.mjs <call.json> [--model haiku] [--effort low] [--limit 25] [--json OUT]');
  const call = JSON.parse(await fs.readFile(positionals[0], 'utf8'));
  const limit = Math.max(1, Number.parseInt(values.limit, 10) || 25);
  const pairs = pairsFrom(call.transcript || []).slice(0, limit);
  const panel = Array.isArray(call.panel) ? call.panel : [];
  const session = await createInterviewerSession({ model: values.model, effort: values.effort, ...(values.claude ? { claudeBin: values.claude } : {}) });
  const rows = [];
  try {
    await session.start({ instructions: buildOpenerInstructions({ persona: call.persona, panel }) });
    for (const [index, pair] of pairs.entries()) {
      // The engine's length note: the target words for this turn (0 = none), left out after a line of one or two words.
      const target = 0; // the acknowledgement chooses its own length (no target note since 2026-11-19)
      const message = formatTurnMessage({ elapsedMs: pair.startMs, candidateText: pair.candidate, channel: pair.channel, lastSpoken: pair.lastSpoken });
      const begun = performance.now();
      const result = await session.turn(message, {});
      const text = String(result.text ?? '').trim();
      rows.push({ turn: index + 1, target, candidate: pair.candidate, text, words: words(text).length, firstMs: result.firstDeltaMs, totalMs: Math.round(performance.now() - begun), breaks: ruleBreaks(text, pair.candidate) });
    }
  } finally {
    await session.close();
  }
  for (const row of rows) {
    console.log(`#${String(row.turn).padStart(2)} first ${String(row.firstMs).padStart(4)} ms  total ${String(row.totalMs).padStart(4)} ms  ${String(row.words).padStart(2)}w/${String(row.target || '-').padStart(2)}  ${row.breaks.length ? `BREAK ${row.breaks.join(',')}  ` : ''}${row.text}`);
    console.log(`      candidate: ${row.candidate.slice(0, 140).replace(/\n/g, ' ')}`);
  }
  const first = rows.map(row => row.firstMs);
  const total = rows.map(row => row.totalMs);
  console.log(`\nturns ${rows.length}; first delta p50 ${percentile(first, 0.5)} ms p95 ${percentile(first, 0.95)} ms; whole reply p50 ${percentile(total, 0.5)} ms p95 ${percentile(total, 0.95)} ms`);
  console.log(`words min ${Math.min(...rows.map(row => row.words))} median ${percentile(rows.map(row => row.words), 0.5)} max ${Math.max(...rows.map(row => row.words))}; turns with a rule break ${rows.filter(row => row.breaks.length).length}`);
  const aimed = rows.filter(row => row.target);
  if (aimed.length) console.log(`target ${values.target}: ${aimed.filter(row => Math.abs(row.words - row.target) <= 2).length} of ${aimed.length} within 2 words, ${aimed.filter(row => row.words >= row.target).length} at or above it; mean ${(aimed.reduce((sum, row) => sum + row.words, 0) / aimed.length).toFixed(1)} words`);
  if (values.json) await fs.writeFile(values.json, JSON.stringify(rows, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error?.message ?? error); process.exit(1); });
