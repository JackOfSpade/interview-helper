/** Question shape is a separate gate from factual entailment. A deliverable or
 * domain noun alone does not establish a behavioral answer. Missing shape is
 * allowed only with the card's thinEvidence warning. The shape asked for is the
 * card's `kind` (interviewCardKinds.js), never its wording. */
const ACTION = /\b(?:built|maintained|implemented|tested|migrated|replaced|changed|added|fixed|resolved|reviewed|supported|helped|contributed|investigated|compared|asked|interviewed|prioriti[sz]ed|chose|selected|decided|coordinated|planned|split|paired|agreed)\b/iu;
const PEOPLE = /\b(?:engineers?|designers?|stakeholders?|customers?|users?|clients?|students?|members?|staff|management|team|product|colleagues?|partners?)\b/iu;
const PROBLEM = /\b(?:problem|failure|failed|errors?|constraint|missing|slow|latency|lag|deadline|outage|blocked|bug|bottleneck|conflict|unclear|unknown|uncertain)\b/iu;
const OUTCOME_STATE = /\b(?:(?:operations|service|systems?|access)\s+(?:continued|stayed|remained)[^.;]*(?:without interruption|available|live)|(?:delivered|completed|migrated|launched|rolled out)\b[^.;]*\bwithout\s+(?:interrupting|disrupting|interruption|downtime))\b/iu;
const EFFECT_OBJECT = /\b(?:costs?|errors?|defects?|failures?|latency|performance|availability|reliability|accessibility|accuracy|throughput|time|hours?|minutes?|seconds?|downtime|interruptions?|spend|revenue|conversion|retention|engagement|manual (?:data )?entry|manual work|processing|load times?)\b/iu;
const CHOICE = /\b(?:decided|chose|selected|adopted|bought|rejected|approved|decision to)\b/iu;
const CRITERION = /\b(?:cost|tradeoffs?|budget|criteria|risk|quality|impact|urgency|deadlines?|dependencies|capacity|effort|value|reliability|performance|requirements?)\b/iu;

function hasBoth(pattern, spoken, evidence) { return pattern.test(spoken) && pattern.test(evidence); }
function outcomeShape(value) {
  if (OUTCOME_STATE.test(value)) return true;
  // "Improved a system" names work, not its effect. Require an achieved effect
  // on something concrete; a following purpose clause cannot supply it.
  // A decimal point ("1.5 hours") does not end the effect object.
  return [...value.matchAll(/\b(?:reduced|increased|improved|saved|eliminated|prevented|accelerated|grew)\s+((?:[^.;]|\.(?=\d))+)/giu)]
    .some(match => EFFECT_OBJECT.test(match[1].split(/\b(?:to|for|so|because)\b/iu)[0]));
}
function collaborationShape(value) {
  if (!PEOPLE.test(value)) return false;
  // A shared label does not say how the collaboration worked. A documented
  // contribution split or reciprocal action supplies that missing shape.
  const split = /\b(?:I|my)\b[^.;]+\b(?:while|whereas)\b[^.;]+\b(?:engineer|designer|team|colleague|partner)\b|\b(?:engineer|designer|team|colleague|partner)\b[^.;]+\b(?:while|whereas)\b[^.;]+\b(?:I|my)\b/iu;
  const reciprocal = /\b(?:paired|pairing)\b|\b(?:reviewed|reviewing|discussed|discussing|coordinated|coordinating|agreed|agreeing)\b[^.;]+\b(?:with|together|among|between)\b|\bwe\s+(?:reviewed|discussed|coordinated|agreed)\b|\b(?:requested|asked|incorporated|shared|exchanged|gathered|discussed)\b[^.;]+\bfeedback\b/iu;
  const explicitResponsibilities = /\b(?:split|divided|assigned|agreed)\b[^.;]+\b(?:responsibilit\w*|tasks?|work|roles?)\b/iu;
  return split.test(value) || reciprocal.test(value) || explicitResponsibilities.test(value);
}
function priorityShape(value) {
  return /\b(?:prioriti[sz]\w*|work(?:ed)? on first|first[^.;]+then|competing|urgent|triage\w*|ordered[^.;]+work)\b/iu.test(value)
    && CRITERION.test(value) && ACTION.test(value);
}
function processShape(value) {
  return /\b(?:replaced|instead of|before[^.;]+after|from[^.;]+to|used to|previously|manual[^.;]+automat\w*|migrated)\b/iu.test(value)
    && ACTION.test(value);
}
function needsShape(value) {
  return PEOPLE.test(value)
    && /\b(?:interviewed|interviewing|asked|listened|observed|surveyed|researched|gathered|collected|elicited|discovered)\b|\b(?:reviewed|discussed|incorporated)\b[^.;]+\b(?:feedback|requests?|needs?|requirements?)\b|\b(?:customers?|users?|clients?|students?|members?|staff)\b[^.;]+\b(?:reported|requested|asked)\b/iu.test(value)
    && /\b(?:needs?|problems?|requests?|requirements?|feedback|pain|goals?|reported|interview\w*|asked)\b/iu.test(value);
}

/** Whether `spokenText` establishes the shape a card of this `kind` asks for
 * (see INTERVIEW_CARD_KINDS). A kind with no shape of its own always fits. */
export function interviewQuestionFit(kind, spokenText, sources = []) {
  const spoken = typeof spokenText === 'string' ? spokenText : '';
  const evidence = sources.map(item => item.text || '').join(' ');
  if (!spoken.trim() || !evidence.trim()) return false;
  switch (kind) {
    case 'problem': return hasBoth(PROBLEM, spoken, evidence) && hasBoth(ACTION, spoken, evidence);
    case 'outcome': return outcomeShape(spoken) && outcomeShape(evidence);
    case 'priority': return priorityShape(spoken) && priorityShape(evidence);
    case 'decision': return hasBoth(CHOICE, spoken, evidence) && hasBoth(CRITERION, spoken, evidence);
    case 'collaboration': return collaborationShape(spoken) && collaborationShape(evidence);
    case 'disagreement': return hasBoth(/\b(?:disagreed|disagreement|conflict|pushback|different views|opposing)\b/iu, spoken, evidence)
      && collaborationShape(spoken) && collaborationShape(evidence);
    case 'leadership': return hasBoth(/\b(?:coached|mentored|guided|delegated|supported|helped|led)\b/iu, spoken, evidence)
      && hasBoth(PEOPLE, spoken, evidence) && collaborationShape(spoken) && collaborationShape(evidence);
    case 'process': return processShape(spoken) && processShape(evidence);
    case 'customer-need': return needsShape(spoken) && needsShape(evidence);
    case 'learning': return hasBoth(/\b(?:learned|found|discovered|realized)\b[^.;]+\b(?:that|when|because|needed|must|should)\b/iu, spoken, evidence);
    case 'feedback': return hasBoth(/\bfeedback\b/iu, spoken, evidence) && hasBoth(/\b(?:changed|revised|adapted|added|removed|implemented)\b/iu, spoken, evidence);
    case 'change': return hasBoth(/\b(?:changed|replaced|new requirements|shifted|adapted|migrated)\b/iu, spoken, evidence) && hasBoth(ACTION, spoken, evidence);
    case 'delivery': return hasBoth(/\b(?:planned|milestones?|validation|phases?|sequenced|rollout|until[^.;]+ready|until[^.;]+set up)\b/iu, spoken, evidence) && hasBoth(ACTION, spoken, evidence);
    // Whether a statement of interest is allowed to cite only research is the
    // interest rule's concern (interviewInterest.js); here the card must cite some.
    case 'motivation': return sources.some(item => item.kind === 'research');
    default: return true;
  }
}

const STOP = new Set('a an and are as at be by for from has have in is it its of on or our that the their this to we with work working role experience development engineer engineering software'.split(' '));
// A generic key, not role vocabulary: a trailing plural is dropped and a long
// word is cut to its first six letters, so "integrate" and "integration", or
// "performance" and "performing", meet without any word being named here.
function terms(value) {
  return new Set((String(value).toLowerCase().match(/[a-z][a-z0-9+#]*/gu) || [])
    .map(term => term.replace(/s$/u, '')).filter(term => !STOP.has(term))
    .map(term => (term.length > 6 ? term.slice(0, 6) : term)));
}

const itemTermsCache = new WeakMap();
function itemTerms(item) {
  const cached = itemTermsCache.get(item);
  if (cached && cached.text === item.text) return cached.terms;
  const entry = { text: item.text, terms: terms(item.text) };
  itemTermsCache.set(item, entry);
  return entry.terms;
}

// Role themes and listing do not depend on the question, so one prompt build
// that ranks many questions prepares them, and each item's role score, once.
let lastRankingContext = null;
function rankingContext(themes, listing) {
  if (lastRankingContext && lastRankingContext.themes === themes && lastRankingContext.listing === listing) return lastRankingContext;
  lastRankingContext = {
    themes, listing, themeTerms: terms(themes), listingTerms: terms(listing), roleScores: new WeakMap(),
  };
  return lastRankingContext;
}

// What makes a piece of evidence relevant is the role itself: the words it
// shares with the brief's role themes and with the listing. No word, skill or
// field earns a bonus or a penalty on its own.
function roleScoreFor(context, item) {
  const cached = context.roleScores.get(item);
  if (cached && cached.text === item.text) return cached.score;
  const sourceTerms = itemTerms(item);
  const themeOverlap = [...context.themeTerms].filter(term => sourceTerms.has(term)).length;
  const listingOverlap = [...context.listingTerms].filter(term => sourceTerms.has(term)).length;
  const score = themeOverlap * 2 + listingOverlap;
  context.roleScores.set(item, { text: item.text, score });
  return score;
}

/** Ranking selects grounded material; listing words never license a claim. */
export function interviewEvidenceRank(kind, evidence, roleThemes = [], jobListing = '') {
  const themes = Array.isArray(roleThemes) ? roleThemes.join(' ') : String(roleThemes || '');
  const listing = typeof jobListing === 'string' ? jobListing : JSON.stringify(jobListing || '');
  const context = rankingContext(themes, listing);
  return evidence.filter(item => item.kind === 'career').map(item => {
    const roleScore = roleScoreFor(context, item);
    const questionFit = interviewQuestionFit(kind, item.text, [item]);
    return { evidenceId: item.id, questionFit, roleScore, score: (questionFit ? 40 : 0) + roleScore * 3 };
  }).sort((a, b) => Number(b.questionFit) - Number(a.questionFit) || b.score - a.score || a.evidenceId.localeCompare(b.evidenceId));
}
