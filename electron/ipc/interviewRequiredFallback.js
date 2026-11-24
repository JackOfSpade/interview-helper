/** Required answers may become narrower after repairs, but never bypass the
 * claim validator or semantic review. These are candidates, not approvals. */
import { buildInterviewAnswerEvidence, inspectInterviewAnswerCards, interviewQuestionContext,
  isNarrowRequiredInterviewCard } from './interviewAnswerBank.js';
import { deriveInterviewResumeConsistency } from './interviewResumeCoverage.js';
import { roleEnd } from './interviewSpokenClaims.js';
import { cardKind, isRequiredInterviewCard, HAS_NEW_SHAPE } from './interviewCardKinds.js';
import { interviewInterestFailures } from './interviewInterest.js';
import { interviewQuestionFailure, interviewQuestionCareerText } from './interviewQuestionText.js';

const MAX_CANDIDATES = 8;
const MAX_SOURCE_ATTEMPTS = 32;
const controls = /[\p{Cc}\p{Cf}]/u;
const complete = /[.!?]["'’”]?$/u;
const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });

function statement(value) {
  if (!value || typeof value.text !== 'string' || !Array.isArray(value.evidenceIds) || !Array.isArray(value.quotes)) return null;
  return { text: value.text, evidenceIds: [...value.evidenceIds],
    quotes: value.quotes.map(quote => ({ evidenceId: quote?.evidenceId, quote: quote?.quote })) };
}

/** What makes the candidate the same card: its identity, wording and, for a current card, its set and kind. */
function cardIdentity(card, question, variants) {
  return { id: card.id, question, variants, ...(HAS_NEW_SHAPE(card) ? { set: card.set, kind: card.kind } : {}) };
}

/** The card's own wording when it passes the question rule; otherwise the first of its variants that does. */
function questionWording(card, context, evidence) {
  const texts = [card.question, ...(Array.isArray(card.variants) ? card.variants : [])].filter(item => typeof item === 'string');
  // A card written by an earlier version keeps its catalog wording as it is.
  if (!HAS_NEW_SHAPE(card)) return { question: card.question, variants: [...(card.variants || [])] };
  const { researchText } = interviewQuestionContext(context);
  const careerText = interviewQuestionCareerText(evidence);
  const passing = texts.filter(item => !interviewQuestionFailure(item, { set: card.set, researchText, careerText }));
  if (!passing.length) return null;
  // Wording that failed the rule is not kept as a variant: it would fail the card again.
  return { question: passing[0], variants: [...new Set(passing.slice(1))].slice(0, 4) };
}

/** Whether the card has wording (its question or a variant) that passes the question rule. */
export function interviewHasPassingWording(card, context) {
  return !!questionWording(card, context, buildInterviewAnswerEvidence(context));
}

function sourceStatement(source, text) {
  return { text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] };
}

/** Preserve a required question with one mechanically verified claim. Prefer
 * the worker's own surviving speech, then literal complete source sentences.
 * An intro may fall back to its explicitly licensed employment metadata.
 * The caller must semantically review every candidate before adopting it. */
export function interviewRequiredFallbackCandidates(card, context, { validatedClaims, validatedOnly = false } = {}) {
  if (!isRequiredInterviewCard(card)) return [];
  // A question that failed the question rule is replaced by a variant that passes; none passing leaves no fallback.
  const evidence = buildInterviewAnswerEvidence(context);
  const wording = questionWording(card, context, evidence);
  if (!wording) return [];
  const career = evidence.filter(source => source.kind === 'career');
  const candidates = [];
  const seen = new Set();
  const add = claim => {
    if (!claim || candidates.length >= MAX_CANDIDATES || typeof claim.text !== 'string'
      || !claim.text.trim() || claim.text.length > 740 || controls.test(claim.text)) return;
    const key = JSON.stringify([claim.text, [...claim.evidenceIds].sort()]);
    if (seen.has(key)) return;
    seen.add(key);
    const candidate = { ...cardIdentity(card, wording.question, wording.variants),
      headline: claim, bullets: [], example: structuredClone(claim), thinEvidence: true,
      consistency: deriveInterviewResumeConsistency([claim], career, context.bundle?.applicationPositioning?.resume)
        || { consistentWithResume: false, resumeQuote: '' } };
    if (isNarrowRequiredInterviewCard(candidate) && inspectInterviewAnswerCards([candidate], context).failures.length === 0) candidates.push(candidate);
  };

  for (const claim of validatedClaims || []) add(statement(claim));
  if (validatedOnly) return candidates;
  for (const claim of [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example]) add(statement(claim));
  if (candidates.length >= MAX_CANDIDATES) return candidates;

  const citedIds = new Set([card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example]
    .flatMap(claim => Array.isArray(claim?.evidenceIds) ? claim.evidenceIds : []));
  const ordered = [...career].sort((left, right) => Number(citedIds.has(right.id)) - Number(citedIds.has(left.id))
    || Number(right.entityType === 'project') - Number(left.entityType === 'project'));
  // Employment alone is an honest final intro if none of the project claims
  // can carry all of their qualifications in a short spoken sentence.
  if (cardKind(card) === 'intro') {
    const roles = new Set();
    for (const source of [...career].sort((left, right) => roleEnd(right) - roleEnd(left))) {
      if (!source.roleId || roles.has(source.roleId) || !source.roleContext?.title || !source.roleContext?.employer) continue;
      roles.add(source.roleId);
      add(sourceStatement(source, `I worked as ${source.roleContext.title} at ${source.roleContext.employer}.`));
      if (candidates.length >= MAX_CANDIDATES || roles.size >= 4) break;
    }
  }
  for (const source of ordered.slice(0, MAX_SOURCE_ATTEMPTS)) {
    let attempted = 0;
    for (const { segment } of SENTENCES.segment(source.text)) {
      const text = segment.trim();
      if (!complete.test(text) || controls.test(text)) continue;
      add(sourceStatement(source, text));
      if (candidates.length >= MAX_CANDIDATES) return candidates;
      if (++attempted >= 4) break;
    }
  }
  return candidates;
}

/** Keep one safe career fact and a separate research reason. These candidates
 * still require semantic approval unless both exact claims were reviewed. */
export function interviewWhyFallbackCandidates(card, context, validatedClaims = []) {
  if (cardKind(card) !== 'motivation') return [];
  const evidence = buildInterviewAnswerEvidence(context);
  const wording = questionWording(card, context, evidence);
  if (!wording) return [];
  const byId = new Map(evidence.map(source => [source.id, source]));
  // Prefer the failed card's own reason over otherwise valid claims prepared
  // for a different question. Semantic approval does not change its subject.
  const claims = [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example, ...validatedClaims]
    .map(statement).filter(Boolean);
  const only = (claim, kind) => claim.evidenceIds.length && claim.evidenceIds.every(id => byId.get(id)?.kind === kind);
  // A reason qualifies when it is research only and, if it speaks as "I" or
  // "we", a plain statement of interest (interviewInterest.js).
  const research = claims.filter(claim => only(claim, 'research')
    && !interviewInterestFailures(claim.text, claim.evidenceIds.map(id => byId.get(id))).length);
  const career = claims.filter(claim => only(claim, 'career'));
  const candidates = [];
  for (const reason of research) for (const connection of career) {
    const candidate = { ...cardIdentity(card, wording.question, wording.variants),
      headline: connection, bullets: [{ stage: 'point', ...reason }], example: structuredClone(connection),
      thinEvidence: true, consistency: { consistentWithResume: false, resumeQuote: '' } };
    if (!inspectInterviewAnswerCards([candidate], context).failures.length) candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES) return candidates;
  }
  return candidates;
}
