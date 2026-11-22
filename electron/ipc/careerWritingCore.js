/**
 * Career-grounded writing core shared by application bundle generation and the
 * Interview Helper Q&A. Quality for "is this first-person career claim
 * supported by its cited quotes" is tested once, here.
 *
 * - Stage model profiles (Claude CLI aliases resolve to the newest release).
 * - The fact-check inflation rules and the verbatim-span finding contract.
 * - The "every flagged span must change" correction contract.
 * - The fact-correction round transition.
 *
 * Callers supply document-specific unit text through a `unitText(id)` lookup,
 * so résumé/letter units and interview card claims share one validator.
 * Application prompts and error strings are pinned byte-for-byte by
 * scripts/tests/career-writing-core.js against a pre-extraction golden capture.
 */

export const CLAUDE_SONNET_MODEL = 'sonnet';
export const CLAUDE_OPUS_MODEL = 'opus';
export const CLAUDE_HAIKU_MODEL = 'haiku';
export const CAREER_WRITING_DEFAULT_PROFILE = Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' });

// Chosen on cost and quality, 2026-11-01 (docs/application-improvement-sessions.md).
// docs/ai-model-selection.md holds the selection policy, results and open gaps.
// Writing at Opus low cost a quarter of xhigh with no measurable loss in blind
// panels; Opus high fact-checks catch ownership overstatements Sonnet passes.
export const APPLICATION_STAGE_PROFILES = Object.freeze({
  'editorial-plan': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'xhigh' }),
  write: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }),
  pick: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  convert: Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'medium' }),
  // requirements-adjudication, 2026-11-10: Sonnet low matched a production rerun (Sonnet high) at 91.3% decision agreement on 54 real prompts at 7% less; every Haiku setting failed (68-77%) (docs/ai-model-selection.md).
  'requirements-adjudication': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'low' }),
  // verify-correction, 2026-11-10: Haiku medium matched production in blind judging of final bundles over 7 jobs (mean 7.57 vs 7.43 and 7.29 for two Sonnet high runs) with acceptance within the production pair and 30-43% lower stage cost; Haiku low failed (docs/ai-model-selection.md).
  'verify-correction': Object.freeze({ model: CLAUDE_HAIKU_MODEL, effort: 'medium' }),
  'fit-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-check': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  'fact-correction': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  'fact-recheck': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
});
// The writer on a cover-letter-only run (it also reads the saved résumé). 2026-11-15: on the one real cover-only
// prompt, 3 runs per setting, two blind judges ranked Opus medium first both times (7.67 vs 6.50 for Opus low and
// 6.17 for Sonnet high) at $0.44 vs $0.38 a call. One job only; the owner chose medium on that evidence. Re-test when
// 3 or more cover-only jobs exist (docs/ai-model-selection.md).
export const COVER_ONLY_WRITE_PROFILE = Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'medium' });
// Interview Q&A. qa-research, 2026-11-09: Opus high scored within the run-to-run noise of
// Opus xhigh in blind judging on three postings at 18-47% less cost; every low and medium
// setting lost real content (docs/ai-model-selection.md).
export const INTERVIEW_QA_STAGE_PROFILES = Object.freeze({
  // Since 2026-11-20 the stages below marked [routed] run on DeepSeek with no Claude fallback (aiCallProviders.js, `qa:` keys); their profile here is what they ran on before.
  'qa-research': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  // qa-brief, 2026-11-10: Opus low scored within the noise of an Opus medium rerun in blind judging of 4 real Prepare briefs (7.5 vs 8.0; two production runs differ by 0.75) at 39% less cost; Sonnet medium and Haiku medium scored 7.0 (docs/ai-model-selection.md).
  'qa-brief': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }), // [routed]
  // qa-disclosures, 2026-11-12: Sonnet low matched Opus low's extraction and mapping answers on 2 real prompts x 2 runs at about 43% less; Haiku dropped extracted questions (docs/ai-model-selection.md).
  'qa-disclosures': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'low' }),
  // qa-practice-order, 2026-11-12: Blind judge gave Opus low reruns 10 and 10, production 9; every Sonnet and Haiku setting scored 2-8, and one Haiku answer repeated a question (docs/ai-model-selection.md).
  'qa-practice-order': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }),
  // qa-card-repair, 2026-11-12: Blind judge over 2 real repair prompts gave Opus low 9 and 8, production 8 and 9, at 34% less; Sonnet medium added unsupported claims and Haiku high broke sentences (docs/ai-model-selection.md).
  'qa-card-repair': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }),
  // qa-write, 2026-11-20 (re-tested after its evidence became plain career text): on 3 real banks x 2 runs, blind-judged twice, Sonnet medium tied Opus medium (6.92 vs 6.92; Opus reruns differ 0-1.5 per bank) with fewer cards failing the app's checks (3.8 vs 6.0 a bank) at about 55% of the cost; DeepSeek truncated the bank at its 32k output cap (docs/ai-model-selection.md).
  'qa-write': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'medium' }),
  // Post-call review of an in-app practice call (judgement and writing, one call per practice): Opus medium, not yet tested (needs a recorded practice call; docs/ai-model-selection.md).
  'qa-practice-review': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'medium' }),
  // Planning of an in-app practice call (cast, questions, time, probes and prepared problems, one call per practice): Opus high, not yet tested (docs/ai-model-selection.md).
  'practice-call-plan': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }), // [routed]
  // practice-call-draft-answer (testing aid: the candidate's chat reply to the latest question, put in the chat box and never sent on its own; electron/practiceCall/draftAnswer.js): Sonnet low, chosen by reasoning, not measured. The person waits on it mid-call and accuracy is not checked, so speed wins; Sonnet low writes the call's acknowledgements without leaking content, and Haiku drops supplied detail in qa-disclosures.
  'practice-call-draft-answer': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'low' }),
  // practice-call-draft-work (testing aid: the wand working a coding-pad exercise as a strong candidate would, as steps of a spoken line and the pad after it; electron/practiceCall/draftAnswer.js): Opus low, chosen by analogy with practice-call-diagram, not measured. The code is shown as what a great answer looks like, so it must be right; the person waits on it once per exercise.
  'practice-call-draft-work': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }),
  // practice-call-candidate-voice (delivery tags for the candidate's sent chat message, spoken on the call in the candidate's voice; electron/practiceCall/candidateVoice.js): Sonnet low, chosen by analogy with practice-call-draft-answer, not measured. The interviewer waits on it, the words are checked unchanged, and a wrong tag costs little.
  'practice-call-candidate-voice': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'low' }),
  // practice-call-visual-pick (during setup: whether one of the Commons pictures found for a shared screen really makes the question clearer, and which; it reads the images; electron/practiceCall/visuals.js): Sonnet medium, chosen by analogy (image judgement with a short answer), not measured.
  'practice-call-visual-pick': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'medium' }),
  // practice-call-diagram (during setup: a diagram or chart for a shared screen, drawn as SVG from the screen's own content, every value checked against it): Opus low, chosen by analogy with the planner's care over examples, not measured.
  'practice-call-diagram': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }),
  // qa-approach-reminders (general good-practice reminders for how-do-you-work questions, one call per Prepare): Opus medium, not yet tested. The advice itself is the output, so it gets more thought than a short reminder (docs/ai-model-selection.md).
  'qa-approach-reminders': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'medium' }), // [routed]
  // qa-gap-answers (which unanswered questions the career text cannot answer, and the honest admission, closest experience and reminders for those; one call per Prepare that has unanswered cards). 2026-11-20: on 3 real prompts x 2 runs, blind-judged, Opus low tied Opus medium (7.50 vs 7.50, reruns 7.33 and 7.67) with no false gaps, at about 15% less; every Sonnet, Haiku and DeepSeek setting scored lower or called real experience a gap (docs/ai-model-selection.md).
  'qa-gap-answers': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }),
  // qa-technical-topics (the list of technical subjects a posting's interview would test, one call per posting): Sonnet low, not yet tested. Chosen by analogy with qa-disclosures, another extraction from supplied text where Sonnet low kept everything and Haiku dropped items.
  'qa-technical-topics': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'low' }), // [routed]
  // Typed-job stages (a typed link, or a company and role, turned into a job for Prepare; electron/ipc/interviewTypedJob.js). All four are chosen by analogy and need a test (docs/ai-model-selection.md).
  // typed-job-intake: short-text understanding into JSON, like job-preference-interpretation, where Haiku medium was judged best.
  'typed-job-intake': Object.freeze({ model: CLAUDE_HAIKU_MODEL, effort: 'medium' }), // [routed]
  // typed-job-posting: reads a whole fetched page and copies the posting text out. 2026-11-20: on 3 real pages plus 3 planted ones (closed notice, job list) x 2 runs, blind-judged, Haiku medium copied the most complete posting (9.19 against 6.54 for Sonnet low, which cut benefits and closing sections, as production did) at a tenth of the cost; every setting classified closed and non-posting pages correctly (docs/ai-model-selection.md).
  'typed-job-posting': Object.freeze({ model: CLAUDE_HAIKU_MODEL, effort: 'medium' }),
  // typed-job-research: Parallel web research about one company. 2026-11-20: on 10 distinct targets, blind-judged twice, Sonnet high scored 7.87 against Opus high 8.02 (same-case reruns 7.50 and 7.60) at about 45% of the cost, all first-try valid; Haiku high scored 7.42, thinner, and one answer was rejected by the app (docs/ai-model-selection.md).
  'typed-job-research': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  // typed-job-listing: realistic stand-in posting written from research alone; like qa-write, where cheaper settings invented specifics.
  'typed-job-listing': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'medium' }), // [routed]
  // career-file-to-text: Claude reads one dropped image (or document) and copies its text out verbatim, in reading order, with [unreadable] for a part it cannot read (electron/ipc/interviewCareerFileConversion.js). 2026-11-20: on 3 rendered résumé images (one column, two columns, rotated and blurred) x 2 runs, Haiku high copied every word exactly, as Sonnet low and medium did, at about a fifteenth of the cost; Haiku medium dropped a word once. Synthetic images only; re-check on a real photo or scan (docs/ai-model-selection.md).
  'career-file-to-text': Object.freeze({ model: CLAUDE_HAIKU_MODEL, effort: 'high' }),
});
export const CAREER_WRITING_STAGE_PROFILES = Object.freeze({ ...APPLICATION_STAGE_PROFILES, ...INTERVIEW_QA_STAGE_PROFILES });

export function careerWritingStageProfile(stage) {
  return CAREER_WRITING_STAGE_PROFILES[stage] || CAREER_WRITING_DEFAULT_PROFILE;
}

/**
 * The inflation taxonomy a fact checker applies to first-person career claims.
 * `target` is the already-quoted employer name (or a descriptive phrase) the
 * writing is addressed to; employment/affiliation implications toward it are
 * inflation unless it is one of the candidate's own role companies.
 */
export function careerInflationRules(target) {
  return `List only actual inflation of ownership, scope, metrics, dates, tools or employment. Employment inflation is any statement or implication that the candidate works at, worked at, joined, left, or was otherwise employed by or affiliated with ${target}, unless ${target} is one of the résumé role companies. Applying to ${target}, wanting to join it, or describing what you would do there is not employment.`;
}

const FACT_FINDING_MAX_LINES = 20;
const clip = (value, max) => {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}${String.fromCharCode(0x2026)}`;
};
const foldFinding = value => value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');

/**
 * Validate fact-check findings: each names a checkable unit id, quotes a
 * verbatim span of that unit's text as `claim`, and gives a reason.
 * `unitText(id)` returns the unit's checkable text, or null when `id` is not a
 * checkable unit.
 */
export function careerFactFindingErrors(findings, unitText) {
  if (!Array.isArray(findings)) return [`fact-findings-shape: The reply needs a "findings" array (an empty array when every claim is supported); it has ${findings === undefined ? 'no "findings" field' : `a ${findings === null ? 'null' : typeof findings}`}.`];
  const errors = [];
  for (const [i, finding] of findings.entries()) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      errors.push(`fact-finding-shape: findings[${i}] is ${finding === null ? 'null' : Array.isArray(finding) ? 'an array' : `a ${typeof finding}`}, not an object with id, claim and reason.`);
      continue;
    }
    const { id, claim, reason } = finding;
    const unit = unitText(id);
    const segments = [];
    if (unit === null) segments.push(`fact-finding-unit: findings[${i}].id ${typeof id === 'string' ? JSON.stringify(clip(id, 60)) : `(${id === undefined ? 'missing' : typeof id})`} is not a unit id of the documents (use only the ids under CHECKABLE UNITS).`);
    if (typeof claim !== 'string' || !claim.trim()) segments.push(`fact-finding-claim: findings[${i}].claim is missing or empty.`);
    else if (unit !== null && !unit.includes(claim)) {
      let k = 0;
      let upper = claim.length;
      while (k + 1 < upper) {
        const middle = Math.floor((k + upper) / 2);
        if (unit.includes(claim.slice(0, middle))) k = middle;
        else upper = middle;
      }
      const cause = /…|\.\.\./u.test(claim)
        ? ` A claim is one unbroken span; it cannot contain "${String.fromCharCode(0x2026)}" or "...".`
        : foldFinding(unit).includes(foldFinding(claim))
          ? " It matches once whitespace, quote marks and dashes are ignored; copy the span character for character, with the unit's own spacing and marks."
          : ' Copy the span character for character from that unit in the DOCUMENTS block; do not paraphrase.';
      segments.push(`fact-finding-span: findings[${i}].claim ${JSON.stringify(clip(claim, 80))} is not a verbatim span of unit ${id}: its first ${k} of ${claim.length} characters appear in the unit and character ${k + 1} does not.${cause}`);
    }
    if (typeof reason !== 'string' || !reason.trim()) segments.push(`fact-finding-reason: findings[${i}].reason is missing or empty.`);
    if (segments.length) errors.push(segments.join(' | '));
  }
  return errors.length > FACT_FINDING_MAX_LINES ? [...errors.slice(0, FACT_FINDING_MAX_LINES), `fact-finding-shape: ${errors.length - FACT_FINDING_MAX_LINES} more findings also failed these checks; correct the lines above first.`] : errors;
}

/** After a correction, every flagged span must be gone from its unit. */
export function careerChangedFindingErrors(findings, unitText) {
  return findings.flatMap(finding => {
    const unit = unitText(finding.id);
    return unit && unit.includes(finding.claim)
      ? [`fact-check-unchanged: ${finding.id} still contains ${JSON.stringify(finding.claim)}.`] : [];
  });
}

/** The findings block a fact-correction prompt shows the writer. */
export function careerFactFindingsSection(findings) {
  if (!Array.isArray(findings) || !findings.length) throw new Error('Fact correction requires the fact-check findings.');
  return `\n\nFACT-CHECK FINDINGS TO CORRECT (every flagged span must change; a span returned unchanged is rejected):\n${findings.map(finding => `- ${finding?.id}: the span ${JSON.stringify(finding?.claim)} is not supported. ${finding?.reason}${typeof finding?.quote === 'string' && finding.quote.trim() ? ` Cited quote: ${JSON.stringify(finding.quote)}` : ''}`).join('\n')}`;
}

/**
 * Next step after a fact-correction round: recheck when it passed, correct
 * again while rounds remain, otherwise fall to the next-ranked candidate (or a
 * human stop when none remain).
 */
export function careerFactTransition({ priorRound = 0, failed, factIndex, rankedCount, maxRounds }) {
  if (!Number.isInteger(priorRound) || priorRound < 0 || !Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error('Invalid fact-correction round state.');
  }
  if (!failed) return { round: priorRound + 1, factIndex, nextStage: 'fact-recheck' };
  const round = priorRound + 1;
  if (round < maxRounds) return { round, factIndex, nextStage: 'fact-correction' };
  const nextIndex = factIndex + 1;
  return { round, factIndex: nextIndex, nextStage: nextIndex < rankedCount ? 'fact-check' : 'write-verify-human-stop' };
}
