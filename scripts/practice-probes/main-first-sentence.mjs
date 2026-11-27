// LIVE probe of the MAIN interviewer session: how long from the start of a turn to its first complete sentence.
// That is the time the spoken acknowledgement has to cover (see electron/interviewPracticeCallEngine.js,
// acknowledgementTarget). The real interviewer instructions (buildInterviewerInstructions) are built from the persona,
// the panel and the plan of a saved call, then the candidate's lines are replayed in order on ONE warm session, each
// message built as the engine builds it, including the "[You have already started your reply out loud with ...]" marker carrying a plausible reaction.
//
//   node scripts/practice-probes/main-first-sentence.mjs <call.json> [--model opus] [--effort low] [--limit 26] [--json OUT]
//
// Spends Claude usage only: never ElevenLabs, never the microphone. The first sentence is taken by the transport's own
// sentence splitting (createReplyStreamParser), the one the engine feeds to the voice. The interviewer's own previous
// reply (not the saved one) is what "[You last said ...]" carries, so the session stays self-consistent.
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isMainModule } from '../lib/entrypoint.mjs';
import { createInterviewerSession } from '../../electron/interviewPracticeTransport.js';
import { buildInterviewerInstructions, formatTurnMessage } from '../../electron/interviewPracticeCallPrompt.js';
import { connectedMarker } from '../../electron/interviewPracticeCallEngine.js';

// Plausible listener reactions of 4 to 9 words, used in turn; the real ones come from the opener session.
const REACTIONS = [
  'Mm-hm, okay, I follow that.', 'Yeah, sure, happy to.', 'Ah, okay, I hear you.', 'Gotcha, okay, thanks for that.',
  'Fair enough, yeah, that\'s alright.', 'Right, yeah, got it.', 'No worries, that\'s totally fine.', 'I see. Okay, thanks for walking me through that.',
  'Yeah, good question.', 'Oh, nice, glad to hear that.',
];

/**
 * Call-clock times of a saved call's lines with long pauses taken out: each gap between two lines counts at most
 * `capMs`. A call paused for a long time (call-mwnvhypn-666sq7 ran 9:41 active in 89 minutes) would otherwise tell the
 * interviewer it is far past time, and every reply after the first few would close the call.
 */
export function activeElapsed(entries, capMs = 40_000) {
  let last = 0; let clock = 0;
  return entries.map(entry => { const at = Number(entry.startMs) || 0; clock += Math.min(Math.max(0, at - last), capMs); last = at; return clock; });
}

export function percentile(values, p) {
  const list = values.filter(Number.isFinite);
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** The engine's call plan shape from a saved call: the lead is A, each colleague keeps their id, voice keys map to ids. */
export function callPlanFrom(call) {
  const plan = call.setup?.plan ?? {};
  const panel = Array.isArray(call.panel) ? call.panel : [];
  const idByKey = new Map([[plan.lead?.voice, 'A']]);
  (plan.panel || []).forEach((member, index) => { if (panel[index]) idByKey.set(member.voice, panel[index].id); });
  return {
    interviewKind: plan.interviewKind,
    people: [
      { id: 'A', name: call.persona?.name, role: call.persona?.role, focus: '', temperament: call.persona?.temperament, manner: plan.lead?.manner ?? '', voice: call.persona?.voice },
      ...panel.map((entry, index) => ({ id: entry.id, name: entry.name, role: entry.role, focus: entry.focus, manner: (plan.panel || [])[index]?.manner ?? '', joins: entry.joins })),
    ],
    questions: (plan.questions || []).map(q => ({ number: q.number, ...(q.number === 0 ? { text: String(q.text ?? '') } : {}), askedBy: idByKey.get(q.askedBy) ?? 'A', minutes: q.minutes, probes: [...(q.probes || [])] })),
    problems: [],
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string', default: 'opus' }, effort: { type: 'string', default: 'low' }, limit: { type: 'string', default: '26' }, json: { type: 'string' }, claude: { type: 'string' } },
  });
  if (!positionals[0]) throw new Error('Usage: main-first-sentence.mjs <call.json> [--model opus] [--effort low] [--limit 26] [--json OUT]');
  const call = JSON.parse(await fs.readFile(positionals[0], 'utf8'));
  const lines = (call.transcript || []).filter(e => e.speaker === 'candidate' && String(e.text ?? '').trim()).slice(0, Math.max(1, Number.parseInt(values.limit, 10) || 26));
  const options = {
    persona: { name: call.persona?.name, role: call.persona?.role, team: call.persona?.team, temperament: call.persona?.temperament, voice: call.persona?.voice },
    brief: { company: 'Nexon Korea', role: 'Client Programmer, action RPG' }, // stand-in: the real brief is not kept in the call record
    plan: [], targetMinutes: [25, 30],
    panel: (call.panel || []).map(e => ({ id: e.id, name: e.name, role: e.role, focus: e.focus, joins: e.joins, voice: e.voice })),
    callPlan: callPlanFrom(call),
  };
  const session = await createInterviewerSession({ model: values.model, effort: values.effort, ...(values.claude ? { claudeBin: values.claude } : {}) });
  const rows = [];
  try {
    await session.start({ instructions: buildInterviewerInstructions(options) });
    let last = (await session.turn(`[elapsed 00:00] ${connectedMarker(null)}`, {})).sentences.join(' '); // the greeting; not measured
    const elapsed = activeElapsed(lines);
    for (const [index, entry] of lines.entries()) {
      const reaction = REACTIONS[index % REACTIONS.length];
      const message = formatTurnMessage({ elapsedMs: elapsed[index], candidateText: String(entry.text).trim(), channel: entry.channel === 'chat' ? 'chat' : undefined, acknowledgement: reaction, lastSpoken: last.replace(/\s+/g, ' ').slice(0, 400) });
      const result = await session.turn(message, {});
      last = result.sentences.join(' ');
      rows.push({ turn: index + 1, candidate: String(entry.text).trim(), channel: entry.channel ?? 'voice', text: result.text, reaction, firstDeltaMs: result.firstDeltaMs, firstSentenceMs: result.firstSentenceMs, totalMs: result.totalMs, first: result.sentences[0] ?? '' });
    }
  } finally {
    await session.close();
  }
  for (const row of rows) console.log(`#${String(row.turn).padStart(2)} delta ${String(row.firstDeltaMs).padStart(5)} ms  first sentence ${String(row.firstSentenceMs).padStart(5)} ms  total ${String(row.totalMs).padStart(5)} ms  ${row.first.slice(0, 90)}`);
  for (const key of ['firstDeltaMs', 'firstSentenceMs', 'totalMs']) {
    const v = rows.map(row => row[key]);
    console.log(`${key.padEnd(16)} n ${v.length}  p50 ${percentile(v, 0.5)}  p75 ${percentile(v, 0.75)}  p90 ${percentile(v, 0.9)}  p95 ${percentile(v, 0.95)}  max ${Math.max(...v)}`);
  }
  if (values.json) await fs.writeFile(values.json, JSON.stringify(rows, null, 2));
}

if (isMainModule(import.meta.url)) main().catch(error => { console.error(error?.message ?? error); process.exit(1); });
