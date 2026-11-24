/**
 * What a prepared answer card is, without reading its wording. The answer
 * writer words every question itself and says what it is: `set` (the General
 * tab, shared by every interview, or the posting's tab) and `kind` (the shape
 * of answer the question asks for). Everything that used to recognise a card by
 * its catalog question reads these two fields.
 *
 * A card written by an earlier version has neither field. Its question is one
 * of the legacy table's words, and the table says what it was. The writer is
 * never offered that table.
 */
import { INTERVIEW_LEGACY_QUESTION_CATALOG } from '../../src/utils/interviewAnswerQuestions.js';

/** Descriptions only: they go into the writer's prompt, so none quotes wording a question could copy. */
export const INTERVIEW_CARD_KINDS = Object.freeze([
  { name: 'intro', description: 'asks the person to introduce themselves and their background; exactly one card, in the general set' },
  { name: 'motivation', description: 'asks why this role or this company; posting set only' },
  { name: 'problem', description: 'a difficulty, failure, setback, pressure, ambiguity or technical problem the person dealt with' },
  { name: 'outcome', description: 'a result or impact the person achieved' },
  { name: 'priority', description: 'choosing what to do first among competing demands' },
  { name: 'decision', description: 'a choice between options and the tradeoffs weighed' },
  { name: 'collaboration', description: 'working with other people or other teams' },
  { name: 'disagreement', description: 'a conflict or pushback and how it was handled' },
  { name: 'leadership', description: 'leading, coaching or supporting other people' },
  { name: 'process', description: 'improving how work gets done, a before and an after' },
  { name: 'customer-need', description: 'finding out what the people the work serves need' },
  { name: 'learning', description: 'something the person learned and what they took from it' },
  { name: 'feedback', description: 'receiving feedback and acting on it' },
  { name: 'change', description: 'adapting when direction or requirements changed' },
  { name: 'delivery', description: 'planning work and bringing it to completion' },
  { name: 'other', description: 'anything else: a walk through a project, strengths, relevant experience, a closing question' },
]);
export const INTERVIEW_CARD_KIND_NAMES = Object.freeze(INTERVIEW_CARD_KINDS.map(item => item.name));
export const INTERVIEW_CARD_SETS = Object.freeze(['general', 'posting']);

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const LEGACY = new Map(INTERVIEW_LEGACY_QUESTION_CATALOG.map(item => [normalize(item.question), item]));

/** The legacy table's entry for a question, matched the way saved Q&A matches questions. */
export const legacyQuestionEntry = question => LEGACY.get(normalize(question)) || null;
export const legacyKindOfQuestion = question => legacyQuestionEntry(question)?.kind || null;

// The writer declares each card's kind and the kind picks the answer shape the host checks, so
// "other" (no shape of its own) must not be a way out of one the question plainly asks for.
// Only the words that name a shape outright count; a card may still ask for a stricter kind.
const SHAPE_WORDING = [
  ['disagreement', /\b(?:conflicts?|disagree\w*|push\s?back|clash\w*)\b/iu],
  ['priority', /\b(?:prioriti[sz]\w*|competing (?:demands|priorities|deadlines))\b/iu],
  ['decision', /\b(?:trade-?offs?|decisions?|decide\w*)\b/iu],
  ['leadership', /\b(?:mentor\w*|coach\w*|lead(?:ing)? (?:a |the |your )?(?:team|people|engineers))\b/iu],
  ['feedback', /\bfeedback\b/iu],
  ['problem', /\b(?:failures?|setbacks?|mistakes?|outages?|obstacles?|ambigu\w+)\b/iu],
  ['customer-need', /\b(?:customer|user|client)s?['’]? needs\b/iu],
  ['change', /\b(?:changing requirements|change in direction|changes? of direction)\b/iu],
];

/** The kinds a question's own words ask for, whatever kind its card declares. */
export const impliedQuestionKinds = texts => SHAPE_WORDING
  .filter(([, pattern]) => (Array.isArray(texts) ? texts : [texts]).some(text => typeof text === 'string' && pattern.test(text)))
  .map(([kind]) => kind);

/** True when the card says its own set or kind: it was written by the current writer. */
export const HAS_NEW_SHAPE = card => !!card && typeof card === 'object' && (Object.hasOwn(card, 'kind') || Object.hasOwn(card, 'set'));

/**
 * `{ legacy, set, kind, required }` for a bank card, or for a stored or
 * projected Q&A card (`question` and an optional `kind`). Only the intro is
 * required of a new card; a legacy card also keeps its project walkthrough.
 * A value that is not a known set or kind is read as `posting` and `other`.
 */
export function cardFacts(card) {
  if (HAS_NEW_SHAPE(card)) {
    const kind = INTERVIEW_CARD_KIND_NAMES.includes(card.kind) ? card.kind : (legacyKindOfQuestion(card.question) || 'other');
    const set = INTERVIEW_CARD_SETS.includes(card.set) ? card.set : 'posting';
    return { legacy: false, set, kind, required: kind === 'intro' };
  }
  const entry = legacyQuestionEntry(card?.question);
  return { legacy: true, set: entry?.set || 'posting', kind: entry?.kind || 'other', required: !!entry?.required };
}
export const cardKind = card => cardFacts(card).kind;
export const isRequiredInterviewCard = card => cardFacts(card).required;
