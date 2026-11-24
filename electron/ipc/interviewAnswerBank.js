/**
 * Prepared candidate answers live separately from the no-candidate-claims
 * research brief. Spoken paraphrases are claims checked mechanically against
 * sealed citations; complete original evidence remains separately inspectable.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { INTERVIEW_ANSWER_BANK_STORE_DIR, INTERVIEW_ANSWER_BINDING_STORE_DIR } from '../utils/pathSafety.js';
import { validationFailureCollector } from './validationFailure.js';
import { wrapUntrustedText } from './promptSafety.js';
import { normalizeInterviewPublicUrl } from '../../src/utils/interviewUrlPrivacy.js';
import { deriveInterviewCandorFlags, interviewClaimGuardFailures, isCareerTextEvidence, interviewHeadlineFailures,
  interviewBulletFailures, interviewQuestionFit, interviewEvidenceRank, interviewStandaloneFailures, interviewClaimContent,
  interviewIntroRoleSummary } from './interviewSpokenClaims.js';
import { deriveInterviewResumeConsistency, resumeCoverage } from './interviewResumeCoverage.js';
import { interviewInterestFailures, interviewInterestReason, interviewWhyCardFailures } from './interviewInterest.js';
import { INTERVIEW_CARD_KINDS, INTERVIEW_CARD_KIND_NAMES, INTERVIEW_CARD_SETS, HAS_NEW_SHAPE, cardFacts, cardKind, impliedQuestionKinds, isRequiredInterviewCard } from './interviewCardKinds.js';
import { interviewQuestionFailure, interviewQuestionContext, interviewQuestionCareerText } from './interviewQuestionText.js';
import { INTERVIEW_LEGACY_QUESTION_CATALOG } from '../../src/utils/interviewAnswerQuestions.js';
import { sha256Hex } from '../utils/sha256Hex.js';
import { interviewAnswerRuleGuide } from './interviewAnswerRules.js';
import { sanitizeInterviewExtensions, validateInterviewExtensionPoint } from './interviewAnswerExtensions.js';

const HASH = /^[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^(?:career|research)-[a-f0-9]{64}$/u;
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const STORE = INTERVIEW_ANSWER_BANK_STORE_DIR;
const BINDING_STORE = INTERVIEW_ANSWER_BINDING_STORE_DIR;
const MAX_STORED_RECORDS = 100;
const MAX_BYTES = 1024 * 1024;
const MAX_EVIDENCE = 600;
const MAX_PROJECTION_BYTES = 200_000;
const MAX_STATEMENT = 740;
const MAX_QUOTE = 6000;
const MAX_QUESTION = 500;
const STAGES = new Set(['situation', 'task', 'action', 'result', 'point']);
export const INTERVIEW_ANSWER_MIN_CARDS = 8;
const MAX_QUESTION_TEXT = 200;
// A set the writer returns keeps at least this many cards in each tab.
const MIN_SET_CARDS = 3;
export { isRequiredInterviewCard, interviewQuestionContext };

/**
 * The sets one Prepare writes: only a tab with no cards is written, so the
 * writer is asked for exactly those sets (both when none is said). A set that
 * is not written needs no cards, no floor and, for the general set, no
 * introduction: the opening comes from the cards already saved.
 */
export function interviewAnswerSets(sets) {
  const wanted = INTERVIEW_CARD_SETS.filter(set => Array.isArray(sets) && sets.includes(set));
  return wanted.length ? wanted : [...INTERVIEW_CARD_SETS];
}
// How many cards a draft holds. A set that is dropped to the floor of eight fails the whole Prepare,
// so every write asks for more than the floor (General alone keeps a shorter list than a posting's).
const draftRange = written => (written.length === 1 && written[0] === 'general' ? [12, 16] : [12, 20]);
/** A required card (the introduction; for a card written by an earlier version also the project walkthrough) may narrow to one safe claim. */
export function isNarrowRequiredInterviewCard(card) {
  return isRequiredInterviewCard(card) && card.thinEvidence === true
    && Array.isArray(card.bullets) && card.bullets.length < 2;
}
function isNarrowInterviewWhyCard(card) {
  return cardKind(card) === 'motivation' && card.thinEvidence === true
    && Array.isArray(card.bullets) && card.bullets.length === 1;
}

// Cards written by earlier versions carry catalog wording and neither set nor kind.
const LEGACY_QUESTIONS = new Map(INTERVIEW_LEGACY_QUESTION_CATALOG.map(item => [item.question, item]));

const sha = sha256Hex;
const canonicalQuestion = value => (typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '');
function plain(value) { return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exact(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}
function text(value, max = MAX_QUOTE, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty && value === '' || value.trim().length > 0)
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}
function evidenceText(value) {
  return typeof value === 'string' && value.length <= MAX_QUOTE && value.trim().length > 0
    && !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\t\r\n]/gu, ''));
}
function list(value, max, check) { return Array.isArray(value) && value.length <= max && value.every(check); }
function segments(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && /^segment-[0-9]{4,}$/u.test(item)) : [];
}
function stop(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Interview answer preparation was cancelled.'); }

export function interviewAnswerBankApplicationDigest(bundle) { return plain(bundle?.digests) ? sha(stable(bundle.digests)) : ''; }

function evidenceAddress(evidence, snapshotId, briefId) {
  return `${evidence.kind}-${sha(stable({
    binding: evidence.kind === 'career' ? snapshotId : briefId,
    entityType: evidence.entityType, entityId: evidence.entityId,
    sourceField: evidence.sourceField, text: evidence.text, roleId: evidence.roleId, roleContext: evidence.roleContext,
  }))}`;
}

/** Only literal, complete, bounded fields from the already approved projection. */
export function buildInterviewAnswerEvidence({ snapshot, brief } = {}) {
  if (!HASH.test(snapshot?.snapshotId || '') || !plain(snapshot?.profile) || !HASH.test(brief?.briefId || '')) throw new TypeError('Validated interview answer inputs are required.');
  const evidence = [];
  const evidenceIds = new Set(); let projectionBytes = 2;
  const roles = new Map((snapshot.profile.roles || []).map(role => [role.id, role]));
  const add = value => {
    // Never truncate a statement or split off a qualifier. An oversized field
    // remains available outside this answer bank.
    if (!evidenceText(value.text) || !text(value.entityId, 160) || !text(value.sourceLabel, 700)) return;
    const item = { id: evidenceAddress(value, snapshot.snapshotId, brief.briefId), ...value,
      candorFlags: deriveInterviewCandorFlags(value.text) };
    if (evidenceIds.has(item.id)) return;
    projectionBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (evidence.length ? 1 : 0);
    // Refuse as soon as the complete projection exceeds its bound. In
    // particular, do not traverse a very large approved profile quadratically.
    if (evidence.length >= MAX_EVIDENCE || projectionBytes > MAX_PROJECTION_BYTES) throw new Error('The approved answer evidence projection is too large.');
    evidenceIds.add(item.id); evidence.push(item);
  };
  for (const [collection, entityType, sourceField] of [['achievements', 'achievement', 'claim'], ['projects', 'project', 'description'], ['otherEvidence', 'otherEvidence', 'text']]) {
    for (const entity of snapshot.profile[collection] || []) {
      const role = roles.get(entity.roleId);
      // An unknown role association is not permission to invent attribution.
      if (entity.roleId && !role) continue;
      const sourceLabel = [role?.title, role?.employer, entity.name || entity.label || (entityType === 'achievement' ? 'Saved achievement' : 'Saved career evidence')].filter(Boolean).join(' · ');
      add({ kind: 'career', text: entity[sourceField], roleId: role?.id || null,
        roleContext: role ? { title: role.title || '', employer: role.employer || '', startDate: role.startDate || '', endDate: role.endDate || '' } : null,
        sourceLabel, sourceUrl: '', entityType, entityId: entity.id, sourceField,
        evidenceSegmentIds: segments(entity.evidenceSegmentIds) });
    }
  }
  for (const sourceField of ['companyFacts', 'recentContext']) {
    for (const item of brief[sourceField] || []) {
      if (!text(item.sourceId, 80) || normalizeInterviewPublicUrl(item.sourceUrl) !== item.sourceUrl) continue;
      // The brief's fact is an exact quotation of validated raw research, not
      // an independently fetched/verified quotation of the remote source page.
      add({ kind: 'research', text: item.fact, roleId: null, sourceLabel: item.sourceUrl,
        roleContext: null,
        sourceUrl: item.sourceUrl, entityType: 'research', entityId: item.sourceId,
        sourceField, evidenceSegmentIds: [] });
    }
  }
  // Role motivation comes from the sealed research brief. These are visibly
  // brief-derived descriptions, distinct from externally quoted company facts.
  for (const [index, fact] of [brief.role?.summary, ...(brief.roleThemes || [])].entries()) {
    if (!fact) continue;
    add({ kind: 'research', text: fact, roleId: null, roleContext: null,
      sourceLabel: 'Prepared role research', sourceUrl: '', entityType: 'research',
      entityId: `brief-role-${index}`, sourceField: 'roleContext', evidenceSegmentIds: [] });
  }
  // Silently dropping late fields would make job-aware choice depend on source
  // order. Refuse an oversized projection so Prepare can report it honestly.
  return evidence;
}

/**
 * The most recent role that has career evidence: a current role, else the one
 * with the latest end date. Null when no role's dates establish an order.
 */
export function interviewLastRole(evidence) {
  const rank = context => (/\b(?:present|current)\b/iu.test(context?.endDate || '') || (!context?.endDate && context?.startDate) ? Infinity : Date.parse(context?.endDate || '') || 0);
  let best = null;
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (item?.kind !== 'career' || !item.roleId || !item.roleContext) continue;
    const value = rank(item.roleContext);
    if (value && (!best || value > best.rank)) best = { roleId: item.roleId, employer: item.roleContext.employer || '', title: item.roleContext.title || '', rank: value };
  }
  return best ? { roleId: best.roleId, employer: best.employer, title: best.title } : null;
}

const stringSchema = max => ({ type: 'string', minLength: 1, maxLength: max });
const statementProperties = {
  text: stringSchema(MAX_STATEMENT),
  evidenceIds: { type: 'array', minItems: 1, maxItems: 4, items: stringSchema(80) },
  quotes: { type: 'array', minItems: 1, maxItems: 4, items: {
    type: 'object', additionalProperties: false, required: ['evidenceId', 'quote'],
    properties: { evidenceId: stringSchema(80), quote: stringSchema(MAX_QUOTE) },
  } },
};
const statementSchema = { type: 'object', additionalProperties: false, required: ['text', 'evidenceIds', 'quotes'], properties: statementProperties };
export const INTERVIEW_ANSWER_BANK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['cards'], properties: {
    cards: { type: 'array', minItems: 12, maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'set', 'kind', 'question', 'variants', 'headline', 'bullets', 'example', 'extensions', 'consistency', 'thinEvidence'],
      properties: {
        id: stringSchema(64), set: { type: 'string', enum: [...INTERVIEW_CARD_SETS] }, kind: { type: 'string', enum: [...INTERVIEW_CARD_KIND_NAMES] },
        question: stringSchema(MAX_QUESTION_TEXT),
        variants: { type: 'array', minItems: 1, maxItems: 4, items: stringSchema(MAX_QUESTION_TEXT) },
        headline: statementSchema, thinEvidence: { type: 'boolean' },
        bullets: { type: 'array', minItems: 0, maxItems: 3, items: {
          type: 'object', additionalProperties: false, required: ['stage', 'text', 'evidenceIds', 'quotes'],
          properties: { stage: { type: 'string', enum: [...STAGES] }, ...statementProperties },
        } },
        example: statementSchema,
        extensions: { type: 'array', minItems: 0, maxItems: 4, items: {
          // IDs already name complete exact evidence. Hydrate quotes on the
          // host instead of repeating large private paragraphs 2–4 more times.
          type: 'object', additionalProperties: false, required: ['id', 'text', 'evidenceIds'],
          properties: { id: stringSchema(96), text: stringSchema(220), evidenceIds: statementProperties.evidenceIds },
        } },
        consistency: { type: 'object', additionalProperties: false, required: ['consistentWithResume', 'resumeQuote'], properties: {
          consistentWithResume: { type: 'boolean' }, resumeQuote: { type: 'string', maxLength: 2400 },
        } },
      },
    } },
  },
});

/** The writer's response schema for the sets this Prepare writes (see interviewAnswerSets). */
export function interviewAnswerBankSchema(sets) {
  const written = interviewAnswerSets(sets);
  if (written.length === INTERVIEW_CARD_SETS.length) return INTERVIEW_ANSWER_BANK_SCHEMA;
  const [minItems, maxItems] = draftRange(written);
  const cards = INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards;
  return { ...INTERVIEW_ANSWER_BANK_SCHEMA, properties: { cards: { ...cards, minItems, maxItems,
    items: { ...cards.items, properties: { ...cards.items.properties, set: { type: 'string', enum: written } } } } } };
}

// A typed source (a link or a company and role) has no application documents;
// a generated listing is not the employer's text. Captured bundles add nothing.
/** The SETS paragraph of the writer's prompt: only the sets this Prepare writes are asked for. */
function setsParagraph({ writesGeneral, writesPosting, minCards, maxCards, savedGeneral = [] }) {
  const posting = '"posting" cards: what a real interviewer for THIS role at THIS company would ask, drawn from the brief\'s role themes and likely questions, the listing and the research; a posting question may name only what the listing or brief names.';
  const general = '"general" cards: what is asked at nearly every interview of any kind, chosen for the field the career text shows, not for this posting. They are shared by every interview, so they name nothing from this posting and nothing from the career text.';
  if (writesGeneral && writesPosting) return `SETS: ${posting.replace('"posting" cards:', '"posting" cards (the larger part of the bank):')} ${general.replace('"general" cards:', '"general" cards (4–8):')} Write ${minCards}–${maxCards} DISTINCT questions in all, at least 3 in each set.`;
  return writesPosting
    ? `SETS: ${posting} Every card is in the posting set: the general set is already written, so write no general card.${savedGeneral.length ? ' The general questions already saved are listed below as data; do not repeat or reword any of them in a posting question.' : ''} Write ${minCards}–${maxCards} DISTINCT questions.`
    : `SETS: ${general} Every card is in the general set: the posting's own set is already written, so write no posting card. Write ${minCards}–${maxCards} DISTINCT questions.`;
}

function answerListingNote(bundle) {
  const status = bundle?.verification?.status;
  if (status === 'typed-generated') return "The listing below is an AI-generated stand-in listing, not the employer's text; do not treat its specifics as facts about the employer. No application documents exist for this job: consistentWithResume is false and resumeQuote empty on every card.\n";
  if (status === 'typed-posting') return 'The listing below was read from the job posting page; no application documents were submitted for this job, so consistentWithResume is false and resumeQuote empty on every card.\n';
  return '';
}
/**
 * Said first when the candidate evidence is plain career text. It replaces the
 * wording rules written for a compiled profile, which the host no longer applies
 * to such lines (interviewClaimGuardFailures).
 */
function careerTextNote(evidence) {
  if (!(evidence || []).some(isCareerTextEvidence)) return '';
  return `CAREER TEXT: the candidate evidence below (kind "career") is the candidate's own career text, split into pieces. Each piece starts with the headings it sits under, usually the job title, employer and dates of the role it belongs to; there is no roleContext or roleId. The candidate reads and edits every card before the interview, so write full, natural spoken answers a person would really give: paraphrase freely, combine pieces, name the employer and role from a piece's heading lines, and tell the background question as a real arc through the roles the text shows, most recent first, with 2–3 bullets. The word-overlap, candor-flag, roleContext and "most recent role first" rules further down do NOT apply to this bank, for career lines or research lines, and the narrow thin fallbacks are not needed. What still applies: never state a fact, employer, number, tool or outcome that the career text (for the candidate) or the research (for the company and role) does not contain; every line cites the pieces it draws on; a line about the company or role cites research only (see INTEREST LINES below); the card shape and length limits; and the introduction ends with a bullet that states interest in the role and gives a reason from research only.
`;
}

export function interviewAnswerBankPrompt({ brief, bundle, evidence, sets, savedGeneral } = {}) {
  const written = interviewAnswerSets(sets);
  const writesGeneral = written.includes('general'); const writesPosting = written.includes('posting');
  const [minCards, maxCards] = draftRange(written);
  // Only a posting-only write has General questions to avoid: they are saved, possibly edited by the person.
  const saved = !writesGeneral && Array.isArray(savedGeneral) ? savedGeneral.filter(item => typeof item === 'string' && item.trim()).slice(0, 40).map(item => item.slice(0, 300)) : [];
  // Preparation may resume after a newly published brief with the same
  // semantic hash. A wall-clock timestamp must not change the durable prompt.
  const { createdAt: _createdAt, ...stableBrief } = brief || {};
  // The person rehearses their most recent role, so its evidence leads each
  // question's choices ahead of equally fitting evidence from earlier roles.
  const lastRole = interviewLastRole(evidence);
  const recentIds = new Set((evidence || []).filter(item => lastRole && item.roleId === lastRole.roleId).map(item => item.id));
  const earlierRoles = (evidence || []).some(item => item.kind === 'career' && item.roleId && !recentIds.has(item.id));
  // Ranked once per kind of answer (the intro and why-role/company cards draw on
  // the whole career text and on research instead).
  const selection = INTERVIEW_CARD_KIND_NAMES.filter(kind => kind !== 'intro' && kind !== 'motivation').map(kind => ({ kind,
    ranked: interviewEvidenceRank(kind, evidence, stableBrief.roleThemes || [], bundle?.listingText || '')
      .map(item => (recentIds.has(item.evidenceId) ? { ...item, mostRecentRole: true } : item))
      .sort((a, b) => Number(b.questionFit) - Number(a.questionFit) || Number(recentIds.has(b.evidenceId)) - Number(recentIds.has(a.evidenceId)))
      .slice(0, 8) }));
  const recency = lastRole && recentIds.size && earlierRoles ? `
MOST RECENT ROLE FIRST: the candidate prepares for the interview by refreshing their most recent role, ${JSON.stringify([lastRole.title, lastRole.employer].filter(Boolean).join(' at '))} (roleId ${JSON.stringify(lastRole.roleId)}; its ranked choices carry mostRecentRole:true), and may not remember earlier roles in detail. For EVERY card take the headline, every bullet and the example from that role's evidence whenever any of it answers the question, even when an earlier role's evidence ranks higher for role fit. Use an earlier role in a headline, bullet or example only when the most recent role has no evidence that answers the question, or the question itself asks about earlier experience. Earlier-role material that is still useful belongs in extensions. The introduction is the one exception: it keeps its single earlier-role line for the background arc. This preference never relaxes a truth rule: an honest thin card from the most recent role is better than a fuller card from an earlier one, and a claim stays with the role its evidence names.` : '';
  return `Prepare ${minCards}–${maxCards} ready-to-say answer cards for this interview. Keep research and candidate claims separate. Use two stages.
${careerTextNote(evidence)}STAGE A — SELECTION: use the host's ranked evidence choices below. Rank question fit first, then the research brief's role themes AND original job listing. Reuse relevant evidence freely across questions when it answers them; there is no one-evidence-per-card assignment or distinct-primary requirement. Combine several evidence items in a card, binding each separate claim to its own sources. Prefer evidence that matches what this role actually does, as the role themes, brief and listing describe it, over less relevant stories when supported; the ranked choices only show where to look. Do not invent role experience or a collaboration split. Never repeat a spoken bullet across cards.${recency}
STAGE B — SPOKEN CLAIMS: headline, each bullet, example and each extension are each ONE sentence/claim {text,evidenceIds,quotes:[{evidenceId,quote}]}. Speakable PARAPHRASE is allowed. Cite 1–4 supplied evidence IDs, preferably one per claim; quotes retain the entire exact source text for the separate evidence toggle. Every content noun and verb must overlap that claim's cited evidence, allowing grammatical inflections and narrow supported equivalents. Verified roleContext title/employer may place the story in its role; sourceLabel alone supplies no facts. Every other entity, product, technology, number and unit must be in that same evidence; spoken numbers equal written numbers. Do not add motives, causality, metrics, improved/reduced/increased outcomes or shipment. Outcomes require explicit source support; shipment alone does not establish an outcome. Preserve negation and attribution.
CANDOR: source candorFlags constrain EVERY spoken line, including the headline. For inherited work describe maintaining, improving, extending or adding; do not claim original construction. Co-built work requires we or the cited other engineer in every agency claim. Mixed solo/shared evidence must retain that distinction; without an explicit who-did-what split, collaboration is thin evidence. Team-chosen work gives implementation/testing only; saying implemented a modified algorithm requires the team chose it in that same line, or omit modified. Supported/assisted sources permit supported, helped or contributed, never solo evaluated, presented, led, decided or owned. Preserve approximate quantities, partial scope, example-only such-as strategies, personal-project context and historical retirement. Do not turn an example into an adopted recommendation. Observed work stays attributed to its owner. No parentheticals, note boilerplate, technology labels or source annotations in speech.
HEADLINE: 10–16 whitespace-separated words, one first-person sentence with an active verb, no parentheses, colon or semicolon. BULLETS: exactly 2–3, each 8–18 words, one claim each. Headline and bullets are recall cues for the human to memorize before the interview. Each line stands alone: name its object instead of unresolved They/Those/It/The data. Bullets must add detail beyond the headline. EXAMPLE: retain a separately cited concrete career example for the prepared answer. OPTIONAL EXTENSIONS: for EACH card generate 2–4 additional glanceable points in extensions:[{id,text,evidenceIds}], with distinct bounded IDs within that card. Extension evidenceIds bind the whole claim; OMIT quotes on extension points to keep output compact: the host restores full exact quotes from those IDs before any validation or review. Each point is one line, at most 18 words/220 characters, answering that question more completely than the memorized bullets and example: another angle, project or skill, a role-fit link, or a documented lesson/tradeoff. Use DIFFERENT or ADDITIONAL evidence/detail, including other career stories; never paraphrase existing bullets or repeat the example. Each point must stand alone and preserve all source qualifications. Cite the specific project/role evidence so the host can attach a tiny exact-source example hook; no hook or source annotation in the spoken text. Research-only points are allowed for why-company/why-role and must introduce unused sealed research facts, never candidate experience. Do not infer a lesson, outcome or role fit from unrelated facts. These points are OPTIONAL material the human has NOT memorized: bring them in only if they can supply a real example. The host drops failing points individually; an empty list is honest only when no valid additional evidence remains. Use point unless the source literally starts with the chosen STAR stage and colon; never infer causal STAR relationships between separate entities. Behavioral cards must establish the asked trait: collaboration needs a working split, result an actual outcome beyond shipped, prioritize a choice between competing demands, process improvement a before/after change, and customer needs a discovery action. When the source lacks that shape, set thinEvidence:true and say less; a deliverable or audience alone is insufficient.
QUESTIONS: you write every question and its variants (1–4 other ways the same interviewer could ask it) in your own words; there is no list to copy from, and no wording here is meant to be reused. Word each as a real interviewer would say it, differently from question to question: vary how they open, their length and their phrasing. Each question is ONE plain sentence of 12–200 characters that a stranger could ask: no number, no employer, product, person or tool taken from the career text, and nothing that asserts or assumes what the candidate did (ask whether something ever happened, not about a particular thing they did). A number is allowed only as a length of time. A shared question (the general set) is asked of every kind of person, so it takes no particular job, manager, team, employer or field for granted: it never presumes the person has a previous, last or current job, and a manager, team or colleague appears only as an imagined one in a situation that might happen, never as the person's own. Give every card a set and a kind.
${setsParagraph({ writesGeneral, writesPosting, minCards, maxCards, savedGeneral: saved })}
KINDS: ${INTERVIEW_CARD_KINDS.filter(item => (writesGeneral || item.name !== 'intro') && (writesPosting || item.name !== 'motivation')).map(item => `${item.name} (${item.description})`).join('; ')}. Choose the kind that fits the question you wrote, and spread the kinds the way this role's interviewers would. A card whose question asks about a conflict, a decision, priorities, feedback, a setback or leading people has that kind, never "other".
${writesGeneral ? `ALWAYS include exactly one intro card, in the general set. It is REQUIRED and cannot be dropped. Write it as a short arc: current or last role first, earlier experience next, then why this role from the sealed research brief only. Name employers/roles from the cited roleContext. Separate role claims with their own citations and chronological wording; never merge separate events into a causal story. An intro employment-summary sentence may cite several roles, naming each employer and title from its own roleContext; it asserts employment only, never transfers achievements or candor between roles. Use last/earlier/previously only when the supplied role dates establish that order; omit dates from speech unless the cited source text supplies them.` : 'Write no introduction (no card of kind intro): the opening is already saved.'}
INTEREST LINES (the introduction's last bullet, and every why-role or why-company card, kind motivation, which belongs in the posting set): a line that states interest in the role or company cites research only. Say only that you are interested or drawn (no skill, past, number, employer or "my"/"our"), then give a reason taken from the research. Word it your own way and differently from card to card and call to call. No candidate experience may enter that line. WHY CARDS: prefer a headline answering why with research ONLY, as an interest line (a third-person research fact is also allowed), followed by two career-only bullets. If this format cannot be repaired, retain a safe career headline/example and one separately research-cited reason bullet with thinEvidence:true; this narrow fallback waives length/detail expectations, never factual guards. Every factual sentence is separately cited.
REQUIRED-CARD NARROWING: when the required intro cannot sustain the full format, retain fewer claims with thinEvidence:true and 0–1 bullets. A single safe headline may also be its example. This explicit narrow required format waives arc, new-detail and headline word-count expectations; all citation, entity, number, candor and semantic guards still apply. Prefer this honest fallback over an unsupported claim or dropping the question.
CONSISTENCY: the captured résumé text is supplied below. consistentWithResume:true requires a captured résumé quote covering each spoken career claim with its qualifiers, not every unused detail of the original source paragraph. Copy complete sentences, including qualifying prefixes; wrapped PDF whitespace may be normalized. Otherwise set false and resumeQuote empty. The cover letter and receipt cannot establish résumé consistency. The host verifies this annotation; failed coverage becomes false and never rejects a card.
CORRECTIONS: a later repair request supplies only failing cards and their own issues. Return only those requested cards, retaining their IDs, sets and kinds; a question or variant is rewritten only when an issue names it. Passing cards are locked by the host. Quoted rejected wording identifies the error; it is never a writing template.
HOST VALIDATION RULES AND TINY SYNTHETIC EXAMPLES (toy names/facts only, never interview evidence):
${interviewAnswerRuleGuide()}
HOST RANKED SELECTION (scores guide selection, never establish new candidate facts):
${JSON.stringify(selection)}
${saved.length ? `${wrapUntrustedText('interview-answer-saved-general-questions', JSON.stringify(saved))}\n` : ''}${wrapUntrustedText('interview-answer-sealed-brief', JSON.stringify(stableBrief))}
${wrapUntrustedText('interview-answer-approved-evidence', JSON.stringify(evidence))}
${answerListingNote(bundle)}${wrapUntrustedText('interview-answer-original-listing', bundle?.listingText || '')}
${wrapUntrustedText('interview-answer-submitted-positioning', JSON.stringify(bundle?.applicationPositioning || {}))}`;
}

// `questionContext` (the listing and brief a posting question may name) and
// `floors` (each set keeps cards) exist only where a set is being written. A
// stored bank is checked without them: the listing is not stored with it, and
// a bank written by an earlier version has neither sets nor kinds.
function checkCards(cards, evidence, { resume, verifyResume = false, selectionEvidence, collect = false, minCards = INTERVIEW_ANSWER_MIN_CARDS, requireIntro = true, floors = false, questionContext = null, lockedIds = new Set(), sets = null } = {}) {
  // The sets this call is for: a written bank is asked for the tabs that were empty, a stored one for none in particular.
  const written = sets ? interviewAnswerSets(sets) : [...INTERVIEW_CARD_SETS];
  const issues = validationFailureCollector({ stage: 'interview-answer-bank', reason: 'answer-truth', prefix: 'Invalid prepared interview answers: ' });
  const failures = [];
  const add = (rule, at, instruction) => {
    const cardIndex = /^cards\[(\d+)\]/u.exec(at)?.[1];
    let returned = at === 'cards' ? { type: Array.isArray(cards) ? 'array' : typeof cards, count: cards?.length } : cards;
    for (const key of at.replaceAll('[', '.').replaceAll(']', '').split('.').slice(1)) returned = returned?.[key];
    if (plain(returned)) returned = typeof returned.text === 'string' ? returned.text : {
      fields: Object.keys(returned), ...(typeof returned.id === 'string' ? { id: returned.id, question: returned.question } : returned),
    };
    const detail = `returned ${JSON.stringify(returned) ?? 'undefined'}; ${instruction}`;
    const failure = { rule, path: at, cardIndex: cardIndex === undefined ? null : Number(cardIndex), instruction: detail };
    failures.push(failure); issues.add(rule, `${at}: ${detail}`);
  };
  if (!Array.isArray(cards) || cards.length < minCards || cards.length > 20) {
    add('INTERVIEW_ANSWER_CARD_COUNT', 'cards', `received ${Array.isArray(cards) ? cards.length : 'a non-array'}; require ${minCards}–20 complete cards.`);
    if (collect) return { used: new Set(), failures };
    issues.throwIfAny();
  }
  const factsOf = new Map(cards.map(card => [card, cardFacts(card)]));
  if (requireIntro && !cards.some(card => factsOf.get(card).kind === 'intro')) add('INTERVIEW_ANSWER_INTRO_REQUIRED', 'cards', 'include the required introduction (a card of kind intro); it cannot be omitted from a prepared bank.');
  if (floors && cards.every(card => !factsOf.get(card).legacy)) {
    for (const set of written) {
      const have = cards.filter(card => factsOf.get(card).set === set).length;
      if (have < MIN_SET_CARDS) add('INTERVIEW_ANSWER_SET_FLOOR', 'cards', `the ${set} set has ${have} cards; keep at least ${MIN_SET_CARDS} in each of the ${written.join(' and ')} ${written.length === 1 ? 'set' : 'sets'}.`);
    }
  }
  const byId = new Map(evidence.map(item => [item.id, item]));
  // What the career text names is kept out of every question, whatever the case.
  const careerText = questionContext ? interviewQuestionCareerText(evidence) : '';
  const bulletKeys = new Map();
  const used = new Set(); const cardIds = new Set(); const questions = new Set(); let introCards = 0;
  const canonicalText = value => typeof value === 'string' ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
  // A new repair must never displace an already accepted card on a duplicate.
  const ordered = [...cards.entries()].sort((a, b) => Number(lockedIds.has(b[1]?.id)) - Number(lockedIds.has(a[1]?.id)));
  for (const [index, card] of ordered) {
    const at = `cards[${index}]`;
    const cardFields = ['id', 'question', 'variants', 'headline', 'bullets', 'example', 'consistency', 'thinEvidence'];
    // Previously sealed v2 banks remain readable. New Prepare requests the
    // dedicated extensions field; its contents are bound by the same bank hash.
    // A card says both its set and its kind, or neither (written by an earlier version).
    const shaped = (HAS_NEW_SHAPE(card) ? [...cardFields, 'set', 'kind'] : cardFields);
    if (!(exact(card, shaped) || exact(card, [...shaped, 'extensions']))) { add('INTERVIEW_ANSWER_CARD_SHAPE', at, 'use exactly the required card fields, including the set, the kind, the evidence warning flag and optional extensions array.'); continue; }
    if (!CARD_ID.test(card.id || '') || cardIds.has(card.id)) add('INTERVIEW_ANSWER_CARD_ID', `${at}.id`, 'use a unique bounded card ID.');
    cardIds.add(card.id);
    const facts = factsOf.get(card);
    if (facts.legacy) {
      const catalog = LEGACY_QUESTIONS.get(card.question);
      if (!text(card.question, MAX_QUESTION) || !catalog || questions.has(canonicalText(card.question))) add('INTERVIEW_ANSWER_QUESTION', `${at}.question`, 'copy one unique question verbatim from the host catalog.');
      if (!list(card.variants, 8, value => text(value, MAX_QUESTION) && catalog?.variants.includes(value)) || card.variants.length < 1
        || new Set(card.variants).size !== card.variants.length) add('INTERVIEW_ANSWER_VARIANTS', `${at}.variants`, 'copy only distinct variants listed for this question.');
    } else {
      if (sets && INTERVIEW_CARD_SETS.includes(card.set) && !written.includes(card.set)) {
        add('INTERVIEW_ANSWER_CARD_KIND', `${at}.set`, `this Prepare writes only the ${written.join(' and ')} ${written.length === 1 ? 'set' : 'sets'}; the ${card.set} set is already saved, so write no ${card.set} card.`);
      } else if (!INTERVIEW_CARD_SETS.includes(card.set) || !INTERVIEW_CARD_KIND_NAMES.includes(card.kind)
        || card.kind === 'intro' && card.set !== 'general' || card.kind === 'motivation' && card.set !== 'posting') {
        add('INTERVIEW_ANSWER_CARD_KIND', `${at}.kind`, `use set ${INTERVIEW_CARD_SETS.join(' or ')} and one kind of ${INTERVIEW_CARD_KIND_NAMES.join(', ')}; an intro is in the general set and a motivation card in the posting set.`);
      } else if (card.kind === 'intro' && ++introCards > 1) add('INTERVIEW_ANSWER_CARD_KIND', `${at}.kind`, 'keep exactly one introduction (kind intro).');
      else if (card.kind === 'other' && questionContext) {
        // Judged only where a set is written: a stored card keeps the kind it was sealed with.
        const asked = impliedQuestionKinds([card.question, ...(Array.isArray(card.variants) ? card.variants : [])]);
        if (asked.length) add('INTERVIEW_ANSWER_CARD_KIND', `${at}.kind`, `the question or a variant asks for a ${asked.join(' or ')} answer, which kind "other" does not check; reword them so they ask for none of that, or the card is dropped.`);
      }
      const mentioned = [card.question, ...(Array.isArray(card.variants) ? card.variants : [])];
      const wording = (value, field) => {
        if (!text(value, MAX_QUESTION_TEXT)) return `${field} must be text of at most ${MAX_QUESTION_TEXT} characters`;
        return questionContext ? interviewQuestionFailure(value, { set: card.set, researchText: questionContext.researchText, careerText }) : null;
      };
      const questionReason = wording(card.question, 'the question');
      if (questionReason || questions.has(canonicalText(card.question))) add('INTERVIEW_ANSWER_QUESTION', `${at}.question`, `${questionReason ? `question ${JSON.stringify(card.question)} ${questionReason}` : 'repeats the question of another card'}; write a plain question a stranger could ask, naming no figure, employer, product, person or personal past.`);
      // The writer's schema asks for at least one variant. A required card that kept only one passing
      // wording (interviewRequiredFallback.js) has none left, and an alternative wording is optional.
      const variantReasons = !list(card.variants, 8, value => typeof value === 'string') ? ['needs a list of variants']
        : card.variants.flatMap(value => { const reason = wording(value, 'a variant'); return reason ? [`variant ${JSON.stringify(value)} ${reason}`] : []; });
      const distinct = new Set(mentioned.map(canonicalText));
      if (variantReasons.length || distinct.size !== mentioned.length) add('INTERVIEW_ANSWER_VARIANTS', `${at}.variants`, `${variantReasons.length ? `${variantReasons.join('; ')}` : 'a variant repeats the question or another variant'}; give 1–4 distinct plain questions a stranger could ask, naming no figure, employer, product, person or personal past.`);
    }
    if (typeof card.question === 'string') questions.add(canonicalText(card.question));
    const narrowRequired = isNarrowRequiredInterviewCard(card);
    const narrowWhy = isNarrowInterviewWhyCard(card);
    if (!Array.isArray(card.bullets) || !narrowRequired && !narrowWhy && card.bullets.length < 2 || card.bullets.length > 3) { add('INTERVIEW_ANSWER_BULLETS', `${at}.bullets`, 'provide 2–3 separately cited spoken bullets, 0–1 for a thin required intro/project, or one research bullet for a thin why-card.'); continue; }
    const careerUsed = new Map(); const localBullets = new Map();
    if (Object.hasOwn(card, 'extensions')) {
      if (!Array.isArray(card.extensions) || card.extensions.length > 4) add('INTERVIEW_EXTENSION_SHAPE', `${at}.extensions`, 'retain at most four individually validated optional points.');
      else {
        const previousPoints = [];
        for (const [pointIndex, point] of card.extensions.entries()) {
          try {
            validateInterviewExtensionPoint(point, { evidence, card, previousPoints, compareSiblingDetails: !collect });
            previousPoints.push(point);
            for (const id of point.evidenceIds) used.add(id);
          } catch (error) { add(error.code || 'INTERVIEW_EXTENSION_INVALID', `${at}.extensions[${pointIndex}]`, 'drop this optional point; it must add a separately grounded detail, preserving its complete claim citations and candor.'); }
        }
      }
    }
    const statements = [['headline', card.headline, false], ...card.bullets.map((item, i) => [`bullets[${i}]`, item, true]), ['example', card.example, false]];
    for (const [field, statement, bullet] of statements) {
      const here = `${at}.${field}`;
      const requiredFields = bullet ? ['stage', 'text', 'evidenceIds', 'quotes'] : ['text', 'evidenceIds', 'quotes'];
      if (!exact(statement, requiredFields) || !text(statement?.text, MAX_STATEMENT)) {
        add('INTERVIEW_ANSWER_STATEMENT_SHAPE', here, `returned fields ${JSON.stringify(plain(statement) ? Object.keys(statement) : typeof statement)} and text length ${statement?.text?.length}; require exactly ${JSON.stringify(requiredFields)} with nonempty text of at most ${MAX_STATEMENT} characters and no control characters.`); continue;
      }
      if (bullet && !STAGES.has(statement.stage)) { add('INTERVIEW_ANSWER_STATEMENT_SHAPE', `${here}.stage`, `use one permitted stage: ${[...STAGES].join(', ')}.`); continue; }
      if (!list(statement.evidenceIds, 4, id => typeof id === 'string' && EVIDENCE_ID.test(id)) || !statement.evidenceIds.length
        || new Set(statement.evidenceIds).size !== statement.evidenceIds.length
        || !list(statement.quotes, 4, quote => exact(quote, ['evidenceId', 'quote']) && EVIDENCE_ID.test(quote.evidenceId) && evidenceText(quote.quote))
        || statement.quotes.length !== statement.evidenceIds.length || new Set(statement.quotes.map(item => item.evidenceId)).size !== statement.quotes.length
        || statement.quotes.some(quote => !statement.evidenceIds.includes(quote.evidenceId))) {
        add('INTERVIEW_ANSWER_CITATION', `${here}.evidenceIds`, `returned quote bindings ${JSON.stringify(statement.quotes)}; cite 1–4 distinct supplied evidence IDs, each paired once with its complete exact quote.`); continue;
      }
      const sources = statement.evidenceIds.map(id => byId.get(id));
      if (sources.some(source => !source)) { add('INTERVIEW_ANSWER_CITATION', `${here}.evidenceIds`, `unknown IDs ${JSON.stringify(statement.evidenceIds.filter(id => !byId.has(id)))}; bind this claim only to supplied evidence IDs.`); continue; }
      for (const source of sources) {
        const quoteIndex = statement.quotes.findIndex(quote => quote.evidenceId === source.id);
        if (statement.quotes[quoteIndex]?.quote !== source.text) add('INTERVIEW_ANSWER_QUOTE', `${here}.quotes[${quoteIndex}]`, `the quote bound to ${source.id} differs from its supplied evidence; retain that entire exact source in the evidence quotation.`);
        if (bullet && statement.stage !== 'point' && !source.text.toLowerCase().startsWith(`${statement.stage}:`)) add('INTERVIEW_ANSWER_STAGE', `${here}.stage`, `evidence ${source.id} does not start literally with this stage and a colon; use stage point.`);
        if (source.kind === 'career') careerUsed.set(source.id, source);
        used.add(source.id);
      }
      if (field === 'example' && !sources.some(source => source.kind === 'career')) add('INTERVIEW_ANSWER_EXAMPLE', here, 'cite a concrete career example.');
      const researchOnly = sources.every(source => source.kind === 'research');
      // A line citing research may speak as "I" or "we" only to state interest
      // (interviewInterest.js); its research reason is what the claim guards ground.
      const speaksAsCandidate = /\b(?:I|we|my|our|me)\b/iu.test(statement.text);
      const interestReasons = researchOnly && speaksAsCandidate ? interviewInterestFailures(statement.text, sources) : [];
      if (sources.some(source => source.kind === 'research') && speaksAsCandidate && (!researchOnly || interestReasons.length)) {
        add('INTERVIEW_ANSWER_RESEARCH_AGENCY', here, `research cannot establish candidate experience${interestReasons.length ? `: this line ${interestReasons.join('; ')}` : ''}; a line citing research may say only that you are interested or drawn, then give its reason as a research fact.`);
      }
      const grounded = researchOnly && speaksAsCandidate && !interestReasons.length ? { ...statement, text: interviewInterestReason(statement.text) || statement.text } : statement;
      const intro = facts.kind === 'intro';
      for (const failure of interviewClaimGuardFailures(grounded, sources, { intro, roleEvidence: selectionEvidence || evidence }, evidence)) add(failure.rule, here, failure.instruction);
      const presentation = field === 'headline' ? interviewHeadlineFailures(statement.text) : bullet ? interviewBulletFailures(statement.text) : [];
      for (const failure of presentation) {
        if ((narrowRequired || narrowWhy) && (failure.rule === 'INTERVIEW_ANSWER_HEADLINE_LENGTH' || narrowWhy && failure.rule === 'INTERVIEW_ANSWER_BULLET_LENGTH')) continue;
        if (field === 'headline' && (
          facts.kind === 'motivation' && failure.rule === 'INTERVIEW_ANSWER_HEADLINE_ACTIVE')) continue;
        add(failure.rule, here, failure.instruction);
      }
      if (field === 'example') for (const failure of interviewStandaloneFailures(statement.text)) add(failure.rule, here, failure.instruction);
      if (!narrowRequired && !narrowWhy && (bullet || field === 'example')) {
        const prior = field === 'example' ? [card.headline, ...card.bullets] : [card.headline];
        const known = new Set(prior.flatMap(item => interviewClaimContent(item?.text || '')));
        if (!interviewClaimContent(statement.text).some(token => !known.has(token))) add('INTERVIEW_ANSWER_DETAIL_REQUIRED', here, 'add a distinct cited detail beyond the headline (and, for the example, beyond all bullets); paraphrasing the same facts adds no new point.');
      }
      if (bullet) {
        if (canonicalText(statement.text) === canonicalText(card.headline?.text)) add('INTERVIEW_ANSWER_HEADLINE_DUPLICATE', here, `duplicates ${at}.headline; make these distinct supported claims.`);
        const wording = canonicalText(statement.text);
        if (localBullets.has(wording)) add('INTERVIEW_ANSWER_BULLET_DUPLICATE', here, `duplicates ${localBullets.get(wording)}; use a distinct supported bullet.`);
        localBullets.set(wording, here);
        const key = interviewClaimContent(statement.text).sort().join(' ');
        const reusableWhyReason = narrowWhy && sources.every(source => source.kind === 'research');
        const previous = reusableWhyReason ? undefined : bulletKeys.get(key);
        if (previous && previous.index !== index) add('INTERVIEW_ANSWER_BULLET_DUPLICATE', here, `repeats the supported action/detail already used at ${previous.path} (card ID ${JSON.stringify(cards[previous.index].id)}); use a distinct supported point.`);
        if (!reusableWhyReason) bulletKeys.set(key, { index, path: here });
      }
    }
    const visible = [card.headline, ...card.bullets];
    const speech = visible.map(item => item?.text || '').join(' ');
    const visibleIds = new Set(visible.flatMap(item => Array.isArray(item?.evidenceIds) ? item.evidenceIds : []));
    const visibleSources = evidence.filter(item => visibleIds.has(item.id));
    if (typeof card.thinEvidence !== 'boolean') add('INTERVIEW_ANSWER_THIN_EVIDENCE', `${at}.thinEvidence`, 'provide a boolean evidence warning flag.');
    else if (!card.thinEvidence && !interviewQuestionFit(facts.kind, speech, visibleSources)) add('INTERVIEW_ANSWER_QUESTION_FIT', `${at}.headline`, `does not establish the requested shape of ${JSON.stringify(card.question)}; use a supported question-shaped answer or retain a narrower honest claim and set thinEvidence:true.`);
    for (const failure of interviewWhyCardFailures(card, evidence)) add(failure.rule, `${at}.${failure.path}`, failure.instruction);
    if (facts.kind === 'intro' && !narrowRequired) {
      const roles = visible.flatMap(item => {
        const sources = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map(id => byId.get(id)).filter(Boolean);
        if (interviewIntroRoleSummary(item, sources)) sources.sort((a, b) =>
          item.text.indexOf(`${a.roleContext.title} at ${a.roleContext.employer}`) - item.text.indexOf(`${b.roleContext.title} at ${b.roleContext.employer}`));
        return sources.map(source => source.roleId);
      }).filter(Boolean);
      const availableRoles = new Set((selectionEvidence || evidence).map(item => item.roleId).filter(Boolean));
      if (availableRoles.size >= 2 && new Set(roles).size < 2) add('INTERVIEW_ANSWER_INTRO_ARC', at, 'use the current/last role, then an earlier role in separately cited statements; a single deliverable is not a background arc.');
      if (new Set(roles).size < 2 && !card.thinEvidence) add('INTERVIEW_ANSWER_QUESTION_FIT', at, 'set thinEvidence:true when a multi-role background arc is unavailable.');
      const endRank = source => /\b(?:present|current)\b/iu.test(source.roleContext?.endDate || '') ? Infinity : Date.parse(source.roleContext?.endDate || '') || 0;
      const dated = (selectionEvidence || evidence).filter(item => item.roleId && endRank(item));
      if (dated.length && roles.length && dated.some(item => item.roleId !== roles[0] && endRank(item) > Math.max(...dated.filter(source => source.roleId === roles[0]).map(endRank), 0))) add('INTERVIEW_ANSWER_INTRO_ORDER', at, 'place the current or last documented role before earlier roles.');
      const why = card.bullets.at(-1);
      const whySources = (Array.isArray(why?.evidenceIds) ? why.evidenceIds : []).map(id => byId.get(id));
      const whyReasons = whySources.length && whySources.every(source => source?.kind === 'research')
        ? interviewInterestFailures(why?.text, whySources, { requireInterest: true }) : ['is not cited to research only'];
      if (whyReasons.length) add('INTERVIEW_ANSWER_INTRO_WHY', at, `end the introduction with a bullet cited only to sealed research that states, in your own words, interest in the role and gives a research reason (the last bullet ${whyReasons.join('; ')}).`);
    }
    if (!careerUsed.size) add('INTERVIEW_ANSWER_ROLE_PATH', at, 'include at least one cited career example.');
    if (card.bullets.some(item => STAGES.has(item?.stage) && item.stage !== 'point')
      && new Set([...careerUsed.values()].map(item => `${item.entityType}:${item.entityId}`)).size > 1) add('INTERVIEW_ANSWER_STAR_RELATION', at, `returned STAR stages stitch entity IDs ${JSON.stringify([...careerUsed.values()].map(item => `${item.entityType}:${item.entityId}`))}; use one career entity for STAR stages, or independent point bullets. Sharing an employer does not establish a causal story.`);
    // Résumé consistency is an annotation, never a reason to repair or drop a
    // factual draft. Sealing replaces it from the captured résumé below. Keep
    // strict checks for already-sealed data so a tampered true flag cannot load.
    if (!collect) {
      const consistency = card.consistency;
      if (!exact(consistency, ['consistentWithResume', 'resumeQuote']) || typeof consistency.consistentWithResume !== 'boolean' || !text(consistency.resumeQuote, 2400, true)) add('INTERVIEW_ANSWER_RESUME_SHAPE', `${at}.consistency`, 'provide the boolean flag and bounded résumé quote.');
      else if (!consistency.consistentWithResume && consistency.resumeQuote !== '') add('INTERVIEW_ANSWER_RESUME_QUOTE', `${at}.consistency`, 'use an empty quote when exact résumé coverage is unverified.');
      else if (consistency.consistentWithResume && !resumeCoverage(consistency.resumeQuote, [...careerUsed.values()], resume, verifyResume, statements.map(([, statement]) => statement))) add('INTERVIEW_ANSWER_RESUME_COVERAGE', `${at}.consistency`, `does not establish captured résumé coverage for each spoken career claim and its qualifiers; copy complete captured résumé sentences, allowing wrapped whitespace, or set consistentWithResume:false and resumeQuote empty.`);
    }
  }
  if (collect) return { used, failures };
  issues.throwIfAny();
  return used;
}

function inputBinding({ snapshot, brief, bundle, canonicalJobUrl, bundleArtifactId } = {}) {
  if (!HASH.test(snapshot?.snapshotId || '') || !HASH.test(brief?.briefId || '') || !plain(brief?.inputs)
    || brief.inputs.careerSnapshotId !== snapshot.snapshotId || !HASH.test(bundleArtifactId || '')
    || brief.inputs.applicationArtifactId !== bundleArtifactId || !plain(bundle?.digests)
    || brief.inputs.applicationArtifactDigest !== interviewAnswerBankApplicationDigest(bundle)
    || normalizeInterviewPublicUrl(canonicalJobUrl) !== canonicalJobUrl || brief.inputs.jobUrlSha256 !== sha(canonicalJobUrl)) throw new TypeError('Prepared answer bindings do not match.');
  return { careerSnapshotId: snapshot.snapshotId, briefId: brief.briefId,
    applicationArtifactId: bundleArtifactId, applicationArtifactDigest: brief.inputs.applicationArtifactDigest,
    jobUrlSha256: brief.inputs.jobUrlSha256 };
}

/**
 * Complete, uncapped per-card diagnostics for the host's sparse repair loop.
 * `floors` asks that each set keep its cards; it is for the whole set the
 * writer returned, not for a subset of it or for the survivors of a drop.
 */
export function inspectInterviewAnswerCards(cards, context = {}, { lockedIds, floors = false, sets } = {}) {
  inputBinding(context);
  const projection = buildInterviewAnswerEvidence(context);
  const complete = cards.length >= INTERVIEW_ANSWER_MIN_CARDS;
  return checkCards(cards, projection, { resume: context.bundle.applicationPositioning?.resume, verifyResume: true,
    selectionEvidence: projection, collect: true, minCards: 1, requireIntro: complete && interviewAnswerSets(sets).includes('general'), floors: floors && complete,
    questionContext: interviewQuestionContext(context), lockedIds, sets });
}

/** Drafts are internal data, never sealed claims. Accept truth failures here so
 * transport retries cannot regenerate cards that already passed. */
export function validateInterviewAnswerDraft(value, targets, { requireExtensions = false, sets } = {}) {
  const written = interviewAnswerSets(sets);
  const [minDraft, maxDraft] = draftRange(written);
  const issues = validationFailureCollector({ stage: 'interview-answer-draft', reason: 'draft-shape' });
  const add = (rule, line) => issues.add(`INTERVIEW_ANSWER_${rule}`, line);
  const bytes = Buffer.byteLength(JSON.stringify(value) || '', 'utf8');
  if (bytes > MAX_BYTES) {
    add('BANK_SHAPE', `returned ${bytes} bytes; the complete internal draft must stay within ${MAX_BYTES} bytes.`);
    issues.throwIfAny();
  }
  if (!exact(value, ['cards']) || !Array.isArray(value.cards)
    || value.cards.length < (targets ? targets.length : minDraft) || value.cards.length > (targets ? targets.length : maxDraft)) {
    add('CARD_COUNT', `returned fields ${JSON.stringify(plain(value) ? Object.keys(value) : typeof value)} and card count ${value?.cards?.length}; return only cards with ${targets ? `exactly ${targets.length}` : `${minDraft}–${maxDraft}`} entries.`);
    issues.throwIfAny();
  }
  const seen = new Set(); const seenQuestions = new Set();
  for (const [index, card] of value.cards.entries()) {
    if (!plain(card) || !CARD_ID.test(card.id || '') || seen.has(card.id)) {
      add('CARD_ID', `cards[${index}] returned id ${JSON.stringify(card?.id)}; use distinct bounded IDs.`);
    }
    seen.add(card?.id);
    if (!plain(card) || typeof card.question !== 'string' || !card.question.trim() || seenQuestions.has(canonicalQuestion(card.question))) {
      add('QUESTION', `cards[${index}] returned question ${JSON.stringify(card?.question)}; write a distinct question of your own for every card.`);
    }
    seenQuestions.add(canonicalQuestion(card?.question));
    if (!plain(card) || !INTERVIEW_CARD_SETS.includes(card.set) || !INTERVIEW_CARD_KIND_NAMES.includes(card.kind)) {
      add('CARD_KIND', `cards[${index}] returned set ${JSON.stringify(card?.set)} and kind ${JSON.stringify(card?.kind)}; use set ${INTERVIEW_CARD_SETS.join(' or ')} and one kind of ${INTERVIEW_CARD_KIND_NAMES.join(', ')}.`);
    } else if (!targets && !written.includes(card.set)) {
      add('CARD_KIND', `cards[${index}] is in the ${card.set} set; this Prepare writes only the ${written.join(' and ')} ${written.length === 1 ? 'set' : 'sets'}, so write no ${card.set} card.`);
    }
    if (requireExtensions && !Object.hasOwn(card || {}, 'extensions')) add('EXTENSIONS_REQUIRED', `cards[${index}] omitted extensions; return the separately prepared extensions array for every card. Generate 2–4 supported additional points, or an empty array only when no valid additional evidence remains.`);
    // A repair keeps its card's identity. Its wording may change: a rejected question has to be rewritable.
    const target = targets?.find(item => item.id === card?.id);
    if (targets && (!target || target.set !== undefined && (target.set !== card?.set || target.kind !== card?.kind))) {
      add('REPAIR_BINDING', `cards[${index}] returned id ${JSON.stringify(card?.id)}, set ${JSON.stringify(card?.set)} and kind ${JSON.stringify(card?.kind)}; return only the requested cards with their ID, set and kind unchanged.`);
    }
  }
  if (!targets) {
    if (written.includes('general') && !value.cards.some(card => cardFacts(card).kind === 'intro')) add('INTRO_REQUIRED', 'the draft omitted the required introduction; include one card of kind intro.');
    if (value.cards.every(card => plain(card) && HAS_NEW_SHAPE(card))) {
      for (const set of written) {
        const have = value.cards.filter(card => card?.set === set).length;
        if (have < MIN_SET_CARDS) add('SET_FLOOR', `the ${set} set has ${have} cards; keep at least ${MIN_SET_CARDS} in each of the ${written.join(' and ')} ${written.length === 1 ? 'set' : 'sets'}.`);
      }
    }
  }
  issues.throwIfAny();
  return structuredClone(value);
}

export function mergeInterviewAnswerCardRepair(cards, repair, targets) {
  if (!Array.isArray(targets) || !targets.length || new Set(targets.map(card => card.id)).size !== targets.length
    || targets.some(target => !cards.some(card => card.id === target.id && card.question === target.question))) throw new TypeError('Repair targets must be distinct current card ID/question pairs.');
  const checked = validateInterviewAnswerDraft(repair, targets);
  const replacements = new Map(checked.cards.map(card => [card.id, card]));
  return cards.map(card => replacements.has(card.id) ? replacements.get(card.id) : structuredClone(card));
}

export function interviewAnswerRepairSchema(targets) {
  // The values the requested cards already hold; every value when none says its own.
  const only = (values, all) => { const held = [...new Set(values.filter(Boolean))]; return held.length ? held : [...all]; };
  return { ...INTERVIEW_ANSWER_BANK_SCHEMA, properties: { cards: {
    ...INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards, minItems: targets.length, maxItems: targets.length,
    items: { ...INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards.items, properties: {
      ...INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards.items.properties,
      id: { type: 'string', enum: targets.map(card => card.id) },
      // The card keeps its identity; its wording may be rewritten.
      question: stringSchema(MAX_QUESTION_TEXT),
      set: { type: 'string', enum: only(targets.map(card => card.set), INTERVIEW_CARD_SETS) },
      kind: { type: 'string', enum: only(targets.map(card => card.kind), INTERVIEW_CARD_KIND_NAMES) },
    } },
  } } };
}

export function interviewAnswerRepairPrompt({ cards, failures, evidence = [], brief, bundle, lockedCards = [] } = {}) {
  // No passing card text is supplied. Every issue stays with its own card,
  // including issues beyond the generic transport's 12-line display cap.
  const withoutQuotes = value => plain(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'quotes')) : value;
  const requested = cards.map(card => ({ card: { ...card, headline: withoutQuotes(card.headline),
    bullets: Array.isArray(card.bullets) ? card.bullets.map(withoutQuotes) : card.bullets, example: withoutQuotes(card.example),
    ...(Object.hasOwn(card, 'extensions') ? { extensions: Array.isArray(card.extensions) ? card.extensions.map(withoutQuotes) : card.extensions } : {}) },
  issues: failures.filter(failure => failure.cardId === card.id)
    .map(({ rule, path, instruction }) => ({ rule, path, instruction })) }));
  const ids = new Set(cards.flatMap(card => [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example, ...(Array.isArray(card.extensions) ? card.extensions : [])]
    .flatMap(item => Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])));
  for (const card of cards) {
    const kind = cardKind(card);
    for (const item of interviewEvidenceRank(kind, evidence, brief?.roleThemes || [], bundle?.listingText || '').slice(0, 3)) ids.add(item.evidenceId);
    if (kind === 'intro' || kind === 'motivation') {
      for (const item of evidence) if (item.kind === 'research') ids.add(item.id);
      if (kind === 'intro') {
        const roles = new Set();
        for (const item of evidence) if (item.roleId && !roles.has(item.roleId)) { roles.add(item.roleId); ids.add(item.id); }
        // Plain career text has no roles: the background arc needs the whole text.
        for (const item of evidence) if (isCareerTextEvidence(item)) ids.add(item.id);
      }
    }
  }
  const cited = evidence.filter(item => ids.has(item.id));
  // Preserve the omitted-card duplicate guard without resending accepted prose.
  const lockedBulletKeys = lockedCards.flatMap(card => card.bullets.map(item => interviewClaimContent(item.text).sort().join(' ')));
  return `${careerTextNote(evidence)}SPARSE CARD REPAIR: return {cards:[...]} containing exactly the ${cards.length} requested cards. Preserve each ID, set and kind; rewrite the question and variants only when an issue names them, in your own words as one plain question a stranger could ask. Do not return passing cards or new cards. Fix every issue attached to each card. Values quoted in an issue are your own rejected text, evidence of the error, never a template to repeat.
Input cards omit repeated quotes for brevity; output each prepared headline/bullet/example citation's full exact quote from the bounded evidence below. Extensions cite evidenceIds only: omit repeated quotes, which the host restores exactly before validation. Headline 10–16 words, bullets 8–18 words each, one standalone sentence per line, no note syntax, stage point unless source literally starts with its STAR stage. Headline/bullets are memorized recall cues; example remains a concrete prepared career example. Include extensions:[{id,text,evidenceIds}] with 2–4 new points, each at most 18 words/220 characters, adding different or additional evidence beyond headline/bullets/example and answering this question more completely. Other projects/roles are allowed; why-company/role may use unused research. Every extension obeys the same truth and candor rules; the host supplies the source hook and drops failing points individually. Never fill space with duplicates or unsupported lessons. Preserve all entity, quantity, attribution and candor constraints. Inherited work is not original creation; shared work needs we/collaborator in every agency line; team choice stays attributed to the team; supported work stays supported. Preserve approximation, partial scope, personal context, example-only strategies and retirement. Recheck every line after editing. Required intro: prefer thinEvidence:true with fewer claims (0–1 bullets, safe headline repeated as example; length/detail/arc waived) over another failing arc or story. A line stating interest in the role or company says only that you are interested or drawn, in your own words, then gives its reason as a cited research fact. Prefer research-only why headlines and career-only bullets; a thin why fallback may keep a safe career headline/example and one research reason bullet, with length/detail expectations waived. True résumé consistency still requires complete captured sentences supporting every spoken career claim; retain a valid matching quote when the claim survives.
${wrapUntrustedText('interview-answer-repair-evidence', JSON.stringify(cited))}
${wrapUntrustedText('interview-answer-repair-resume', bundle?.applicationPositioning?.resume || '')}
${wrapUntrustedText('interview-answer-locked-bullet-keys', JSON.stringify(lockedBulletKeys))}
${wrapUntrustedText('interview-answer-failing-cards', JSON.stringify(requested))}`;
}

/** Seal only a completely valid merged bank, optionally with explicit omissions. */
export function validateInterviewAnswerBank(value, context = {}, { droppedQuestions = [], sets } = {}) {
  if (!exact(value, ['cards'])) {
    const issues = validationFailureCollector({ stage: 'interview-answer-bank', reason: 'answer-shape' });
    issues.add('INTERVIEW_ANSWER_BANK_SHAPE', `Returned fields ${JSON.stringify(plain(value) ? Object.keys(value) : typeof value)}; return one object containing only the complete cards array.`); issues.throwIfAny();
  }
  const inputs = inputBinding(context);
  const projection = buildInterviewAnswerEvidence(context);
  const career = projection.filter(item => item.kind === 'career');
  const cards = Array.isArray(value.cards) ? value.cards.map(card => {
    if (!plain(card)) return card;
    let consistency;
    try {
      consistency = deriveInterviewResumeConsistency([card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example],
        career, context.bundle.applicationPositioning?.resume);
    } catch { /* An unusable annotation cannot invalidate a career claim. */ }
    return { ...card, ...(Object.hasOwn(card, 'extensions') ? { extensions: sanitizeInterviewExtensions(card, projection) } : {}), consistency: consistency && text(consistency.resumeQuote, 2400)
      ? consistency : { consistentWithResume: false, resumeQuote: '' } };
  }) : value.cards;
  const used = checkCards(cards, projection, { resume: context.bundle.applicationPositioning?.resume, verifyResume: true, selectionEvidence: projection,
    // Cards dropped for failing a truth rule cannot also fail the writer for the split of its sets.
    floors: droppedQuestions.length === 0, questionContext: interviewQuestionContext(context), sets,
    requireIntro: interviewAnswerSets(sets).includes('general') });
  const bank = { version: 2, inputs, cards: structuredClone(cards), evidence: projection.filter(item => used.has(item.id)),
    ...(droppedQuestions.length ? { droppedQuestions: [...droppedQuestions] } : {}) };
  if (!isInterviewAnswerBank(bank)) throw new Error('Prepared interview answers could not be validated.');
  return bank;
}

function evidenceShape(item, inputs) {
  if (!exact(item, ['id', 'kind', 'text', 'roleId', 'roleContext', 'sourceLabel', 'sourceUrl', 'entityType', 'entityId', 'sourceField', 'evidenceSegmentIds', 'candorFlags'])
    || stable(item.candorFlags) !== stable(deriveInterviewCandorFlags(item.text))
    || !EVIDENCE_ID.test(item.id) || !evidenceText(item.text) || !text(item.sourceLabel, 700) || !text(item.entityId, 160)
    || !(item.roleId === null || text(item.roleId, 160)) || !list(item.evidenceSegmentIds, 128, id => typeof id === 'string' && /^segment-[0-9]{4,}$/u.test(id))) return false;
  if (item.roleId === null ? item.roleContext !== null : !exact(item.roleContext, ['title', 'employer', 'startDate', 'endDate'])
    || !Object.values(item.roleContext).every(value => text(value, 700, true))) return false;
  if (item.kind === 'career') {
    if (item.sourceUrl !== '' || !new Set(['achievement:claim', 'project:description', 'otherEvidence:text']).has(`${item.entityType}:${item.sourceField}`)) return false;
  } else if (item.kind !== 'research' || item.entityType !== 'research' || !['companyFacts', 'recentContext', 'roleContext'].includes(item.sourceField)
    || item.roleId !== null || item.evidenceSegmentIds.length
    || (item.sourceField === 'roleContext' ? item.sourceUrl !== '' : normalizeInterviewPublicUrl(item.sourceUrl) !== item.sourceUrl)) return false;
  return item.id === evidenceAddress(item, inputs.careerSnapshotId, inputs.briefId);
}

/** Structural/truth checks plus optional freshly verified input authorities. */
export function isInterviewAnswerBank(bank, bindings = {}) {
  try {
    if (!(exact(bank, ['version', 'inputs', 'cards', 'evidence']) || exact(bank, ['version', 'inputs', 'cards', 'evidence', 'droppedQuestions'])) || bank.version !== 2
      || !exact(bank.inputs, ['careerSnapshotId', 'briefId', 'applicationArtifactId', 'applicationArtifactDigest', 'jobUrlSha256'])
      || !Object.values(bank.inputs).every(value => typeof value === 'string' && HASH.test(value))
      || !list(bank.evidence, MAX_EVIDENCE, item => evidenceShape(item, bank.inputs)) || !bank.evidence.length
      || new Set(bank.evidence.map(item => item.id)).size !== bank.evidence.length) return false;
    if (Object.hasOwn(bank, 'droppedQuestions') && (!list(bank.droppedQuestions, 20, question => text(question, MAX_QUESTION))
      || new Set(bank.droppedQuestions).size !== bank.droppedQuestions.length
      || bank.droppedQuestions.some(question => bank.cards?.some(card => card.question === question)))) return false;
    // A bank written for the posting tab alone holds no introduction: the opening was already saved.
    const requireIntro = !Array.isArray(bank.cards) || bank.cards.some(card => { const facts = cardFacts(card); return facts.legacy || facts.set === 'general'; });
    const used = checkCards(bank.cards, bank.evidence, { resume: bindings.bundle?.applicationPositioning?.resume, verifyResume: !!bindings.bundle, requireIntro });
    if (used.size !== bank.evidence.length) return false;
    const expected = {
      careerSnapshotId: bindings.snapshot?.snapshotId || bindings.snapshotId || bindings.careerSnapshotId,
      briefId: bindings.brief?.briefId || bindings.briefId,
      applicationArtifactId: bindings.bundleArtifactId || bindings.applicationArtifactId || bindings.brief?.inputs?.applicationArtifactId,
      applicationArtifactDigest: bindings.bundleArtifactDigest || bindings.applicationArtifactDigest || bindings.brief?.inputs?.applicationArtifactDigest,
      jobUrlSha256: bindings.canonicalJobUrl ? sha(bindings.canonicalJobUrl) : bindings.jobUrlSha256 || bindings.brief?.inputs?.jobUrlSha256,
    };
    if (Object.entries(expected).some(([key, value]) => value !== undefined && bank.inputs[key] !== value)) return false;
    if (bindings.snapshot || bindings.brief) {
      if (!bindings.snapshot || !bindings.brief || bindings.brief.inputs?.careerSnapshotId !== bank.inputs.careerSnapshotId) return false;
      const current = new Map(buildInterviewAnswerEvidence(bindings).map(item => [item.id, item]));
      if (!bank.evidence.every(item => stable(current.get(item.id)) === stable(item))) return false;
      checkCards(bank.cards, bank.evidence, { selectionEvidence: [...current.values()], requireIntro });
    }
    if (bindings.bundle?.digests && sha(stable(bindings.bundle.digests)) !== bank.inputs.applicationArtifactDigest) return false;
    return true;
  } catch { return false; }
}

export function answerBankRecordId(bank) { return isInterviewAnswerBank(bank) ? sha(stable(bank)) : ''; }

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
async function storeRoot(userDataPath, { create = false, directory = STORE } = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('Interview answer bank store is unavailable.');
  const base = await fs.promises.lstat(userDataPath);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error('Unsafe interview answer bank store.');
  const realBase = await fs.promises.realpath(userDataPath);
  const root = path.join(realBase, directory);
  if (create) {
    try { await fs.promises.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await fs.promises.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.promises.realpath(root) !== root) throw new Error('Unsafe interview answer bank store.');
  return { root, identity: stat };
}
async function sameRoot(store) {
  const stat = await fs.promises.lstat(store.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(store.identity, stat) || (stat.mode & 0o077) !== 0 || await fs.promises.realpath(store.root) !== store.root) throw new Error('Interview answer bank store changed.');
}

// Retain the latest publications in each private store, including a reused
// content-addressed bank. No renderer paths, temporary files or symlink targets
// participate in retention. 
async function pruneRecords(store, currentRecordId) {
  await sameRoot(store);
  const currentFile = path.join(store.root, `${currentRecordId}.json`);
  const before = await fs.promises.lstat(currentFile);
  const handle = await fs.promises.open(currentFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || !opened.isFile() || !sameFile(before, opened)) throw new Error('Interview answer record changed.');
    await sameRoot(store);
    const now = new Date();
    await handle.utimes(now, now);
  } finally { await handle.close(); }
  const records = [];
  for (const name of await fs.promises.readdir(store.root)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const file = path.join(store.root, name);
    let stat;
    try { stat = await fs.promises.lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isFile() && !stat.isSymbolicLink()) records.push({ name, file, stat });
  }
  const currentName = `${currentRecordId}.json`;
  records.sort((left, right) => Number(right.name === currentName) - Number(left.name === currentName)
    || right.stat.mtimeMs - left.stat.mtimeMs || right.name.localeCompare(left.name));
  for (const record of records.slice(MAX_STORED_RECORDS)) {
    await sameRoot(store);
    try {
      const current = await fs.promises.lstat(record.file);
      if (current.isFile() && !current.isSymbolicLink() && sameFile(record.stat, current)
        && current.mtimeMs === record.stat.mtimeMs && current.ctimeMs === record.stat.ctimeMs) await fs.promises.unlink(record.file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await sameRoot(store);
}

/** Main-only retention after the current brief-to-bank binding was verified. */
export async function pruneInterviewAnswerBindings({ userDataPath, briefId } = {}) {
  if (!HASH.test(briefId || '')) throw new Error('Invalid interview answer binding.');
  await pruneRecords(await storeRoot(userDataPath, { directory: BINDING_STORE }), briefId);
}
async function readRecord({ answerBankRecordId: recordId, userDataPath }) {
  if (!HASH.test(recordId || '')) return null;
  try {
    const store = await storeRoot(userDataPath);
    const file = path.join(store.root, `${recordId}.json`);
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES || (before.mode & 0o077) !== 0) return null;
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened) || opened.size > MAX_BYTES || (opened.mode & 0o077) !== 0) return null;
      const chunks = []; let offset = 0;
      while (offset <= MAX_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (offset > MAX_BYTES) return null;
      const after = await handle.stat(); const current = await fs.promises.lstat(file);
      if (!sameFile(opened, after) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !current.isFile() || current.isSymbolicLink() || !sameFile(opened, current)) return null;
      await sameRoot(store);
      const record = JSON.parse(Buffer.concat(chunks, offset).toString('utf8'));
      if (!exact(record, ['version', 'recordId', 'bank']) || record.version !== 1 || record.recordId !== recordId || answerBankRecordId(record.bank) !== recordId) return null;
      return record.bank;
    } finally { await handle.close(); }
  } catch { return null; }
}

/** Main-only writer, atomically published and independently re-read. */
export async function publishInterviewAnswerBank({ bank, userDataPath, signal } = {}) {
  stop(signal);
  const recordId = answerBankRecordId(bank);
  if (!recordId) throw new Error('Invalid prepared interview answer bank.');
  const encoded = JSON.stringify({ version: 1, recordId, bank });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) throw new Error('Prepared interview answer bank is too large.');
  const store = await storeRoot(userDataPath, { create: true });
  const tmp = path.join(store.root, `.${recordId}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    stop(signal); await sameRoot(store);
    await fs.promises.writeFile(tmp, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    stop(signal); await sameRoot(store);
    try { await fs.promises.link(tmp, path.join(store.root, `${recordId}.json`)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const published = await readRecord({ answerBankRecordId: recordId, userDataPath });
    if (!published || stable(published) !== stable(bank)) throw new Error('Published interview answer bank could not be verified.');
    stop(signal);
    await pruneRecords(store, recordId);
    return Object.freeze({ answerBankRecordId: recordId, cardCount: bank.cards.length });
  } finally { await fs.promises.unlink(tmp).catch(() => undefined); }
}

/** Reload a sealed record; optional authorities recheck all source bindings. */
export async function loadInterviewAnswerBank({ answerBankRecordId: recordId, userDataPath, ...bindings } = {}) {
  const bank = await readRecord({ answerBankRecordId: recordId, userDataPath });
  return bank && isInterviewAnswerBank(bank, bindings) ? bank : null;
}
