/**
 * Saying why you want this role or company. Such a line may carry research
 * facts about the role or company and nothing about the candidate. Earlier
 * versions guaranteed that with one fixed opening sentence ("This role
 * interests me because [fact]"); the writer now words it freely and the host
 * checks only a few things (the old opening passes all of them, so saved answers
 * still load):
 *
 * - every source it cites is research, and with `requireInterest` the line
 *   speaks in the first person at all ("I", "we", "me", "my", "us");
 * - a figure the cited research does not state is refused;
 * - a statement of the person's own past or standing is refused, by a short
 *   list of unmistakable shapes: "I" or "we" with a perfect or simple past
 *   ("I have built", "I led", "I was"), an opener about their past ("Having
 *   worked ...", "After leading ...", "Coming from ...", "As a nurse, I ..."),
 *   "my" or "our" before a word for experience, and "I am a <noun phrase>"
 *   unless the noun is one of admiration ("a big fan", "a firm believer").
 *
 * This fails open on purpose. It does not read English: it does not judge what
 * the interest is in, whether a reason is given, or whether "I'm good with
 * people" is true, and it passes any wording these shapes do not name.
 * Earlier versions tried to judge all of that with word lists and refused
 * ordinary sentences of wanting and liking while still missing claims. Every
 * answer card is separately checked against its cited evidence, and the cards
 * are read and edited by hand.
 */
import { FUNCTION_WORDS, NUMBER_WORDS, root } from './interviewSpokenClaims.js';
import { cardKind } from './interviewCardKinds.js';

// "US" in capitals is a place, not "us".
const FIRST_PERSON_WORD = /\b(?:I|we|me|my|our|mine|ours|myself|ourselves)\b/iu;
const FIRST_PERSON = { test: value => FIRST_PERSON_WORD.test(value) || /\b[Uu]s\b/u.test(value) };
// Wording of wanting, liking, caring and being drawn. It only exempts a verb from the "past" shapes
// ("I loved", "I was drawn", "I have always admired") and drops interest wording from a research reason.
const INTEREST = /^(?:interest|draw|appeal|excit|attract|motivat|want|wish|hope|love|enjoy|admir|valu|apprecia|curio|passion|eager|keen|inspir|fascinat|intrigu|thrill|resonat|enthusias|feel|felt|find|found|forward|like|look|care|believ|respect|prefer|dream|follow|impress|glad|happy|proud|read|watch|learn|hear|explor|research)/u;
const MODALS = new Set('would will can could should might may must shall'.split(' '));
const ADVERBS = new Set('also just really truly always never ever already still previously recently once then first later actually even not'.split(' '));
// Past forms that do not end in -ed, and -ed words that are not past forms.
const IRREGULAR_PAST = new Set('built made led ran run wrote written grew grown chose chosen won began begun drove driven taught sent spent paid sold became become left kept brought gave given held did done'.split(' '));
const NOT_PAST = new Set('need feed seed speed proceed succeed exceed indeed embed hundred'.split(' '));
const LEARNING = /^(?:read|reading|seen|seeing|heard|hearing|learn\w*|look\w*|visit\w*|research\w*|explor\w*|watch\w*|think\w*|thought|talk\w*|spoke\w*|speak\w*|follow\w*|discover\w*|brows\w*)$/u;
const ADMIRATION = new Set(['fan', 'admirer', 'believer', 'supporter', 'advocate', 'enthusiast']);
const NOT_A_ROLE = new Set(['bit', 'little', 'lot', 'touch', 'tad']);
const NUMBER_ALTERNATIVE = [...NUMBER_WORDS.keys()].join('|');
const SENTENCE_START = String.raw`(?:^|[.!?;:,—–]\s*)`;
const EXPERIENCE_WORDS = String.raw`experience|background|career|work|years|skills|training|degree|team|clients|students|patients|time\s+(?:at|in)`;
const SHAPES = [
  [new RegExp(String.raw`\b(?:my|our)\s+(?:${EXPERIENCE_WORDS})\b`, 'iu'), 'names your own experience'],
  [new RegExp(String.raw`\bwith\s+(?:my|our)\s+(?:\p{L}+\s+){0,2}?(?:background|experience|career|training)\b`, 'iu'), 'names your own experience'],
  [new RegExp(String.raw`${SENTENCE_START}coming\s+from\b`, 'iu'), 'opens with where you come from'],
  [new RegExp(String.raw`${SENTENCE_START}as\s+(?:an?|the)\s+(?:[\p{L}'-]+\s+){0,3}?[\p{L}'-]+,?\s+(?:I|we)\b`, 'iu'), 'names you as a role'],
  [new RegExp(String.raw`\bas\s+(?:an?|the)\s+[\p{L}'-]+\s+of\s+(?:\d[\d,]*|${NUMBER_ALTERNATIVE})\s+years?\b`, 'iu'), 'names how long you have done something'],
];
const NUMBER_TOKEN = /^\d/u;

function wordsOf(clause) {
  return (clause.match(/[\p{L}\p{N}][\p{L}\p{N}'.,%$£€+#-]*/gu) || []).map(word => {
    const base = word.replace(/[.,'-]+$/u, '');
    return { word: base, lower: base.toLowerCase().replace(/(?:'(?:m|d|ll|re|s|ve)|n't)$/u, ''), perfect: /'ve$/iu.test(base),
      be: /'(?:m|re)$/iu.test(base), wish: /'(?:d|ll)$/iu.test(base) };
  }).filter(item => item.lower);
}
const isInterest = item => !!item && INTEREST.test(item.lower);
const isAdverb = item => !!item && (ADVERBS.has(item.lower) || (item.lower.length > 4 && item.lower.endsWith('ly')));
const isPastForm = item => !!item && (IRREGULAR_PAST.has(item.lower) || (item.lower.length > 3 && item.lower.endsWith('ed') && !NOT_PAST.has(item.lower)));

/** Where "I" or "we" is followed by a past or perfect form, or a being as a role, or null. */
function subjectClaim(words) {
  for (let at = 0; at < words.length; at += 1) {
    const subject = words[at];
    if (subject.lower !== 'i' && subject.lower !== 'we') continue;
    let next = at + 1;
    while (isAdverb(words[next])) next += 1;
    const verb = words[next];
    if (!verb || subject.wish || MODALS.has(verb.lower)) continue;
    const after = from => { let index = from + 1; while (isAdverb(words[index]) || words[index]?.lower === 'been') index += 1; return words[index]; };
    // "I am a ...", "I'm a ...": a role it names is a standing, unless it is one of admiration.
    if (subject.be || verb.lower === 'am' || verb.lower === 'are') {
      let article = subject.be ? next : next + 1;
      while (isAdverb(words[article])) article += 1;
      if (!['a', 'an'].includes(words[article]?.lower)) continue;
      const phrase = [];
      for (let index = article + 1; index < words.length && phrase.length < 5 && !FUNCTION_WORDS.has(words[index].lower); index += 1) phrase.push(words[index].lower);
      if (phrase.length && !NOT_A_ROLE.has(phrase[0]) && !phrase.some(word => ADMIRATION.has(word))) return `names you as "a ${phrase.join(' ')}"`;
      continue;
    }
    if (subject.perfect || ['have', 'has'].includes(verb.lower)) {
      const participle = subject.perfect ? verb : after(next);
      if (participle && !isInterest(participle) && (isPastForm(participle) || participle.lower === 'been')) return `says what you have done ("${subject.word} ${words.slice(next, next + 3).map(item => item.word).join(' ')}")`;
      continue;
    }
    if (['was', 'were', 'had', 'did'].includes(verb.lower)) {
      if (!isInterest(after(next))) return `says what you did ("${subject.word} ${verb.word}")`;
      continue;
    }
    if (isPastForm(verb) && !isInterest(verb)) return `says what you did ("${subject.word} ${verb.word}")`;
  }
  return null;
}

/** Openers about the person's own past: "Having worked ...", "After leading ...". */
function openerClaim(text) {
  for (const match of text.matchAll(new RegExp(String.raw`${SENTENCE_START}(having|after)\s+(\p{L}+)`, 'giu'))) {
    const lead = match[1].toLowerCase(); const word = match[2].toLowerCase();
    if (LEARNING.test(word)) continue;
    if (lead === 'having' ? isPastForm({ lower: word }) : word.endsWith('ing')) return `opens with your own past ("${match[1]} ${match[2]}")`;
  }
  return null;
}

/**
 * What stops `text` from being a research-only statement of interest, as a
 * list of reasons (empty when it is one). `sources` are the statement's cited
 * evidence. A sentence with no first-person word is a third-person research
 * fact and passes; with `requireInterest` it must speak in the first person.
 */
export function interviewInterestFailures(text, sources, { requireInterest = false } = {}) {
  const problems = [];
  const value = typeof text === 'string' ? text : '';
  const cited = Array.isArray(sources) ? sources : [];
  if (!cited.length || cited.some(source => source?.kind !== 'research')) problems.push('cites something other than research evidence; state interest and cite only research');
  if (!value.trim()) { problems.push('is empty'); return problems; }
  if (!FIRST_PERSON.test(value)) {
    if (requireInterest) problems.push('states no interest of its own; say that you are interested or drawn, then give the reason from the research');
    return problems;
  }
  const known = new Set(cited.flatMap(source => wordsOf(String(source?.text || ''))).map(item => root(item.lower)));
  const spoken = value.normalize('NFKC').replace(/’/gu, "'");
  const words = wordsOf(spoken);
  const unstated = words.filter(item => (NUMBER_TOKEN.test(item.lower) || (NUMBER_WORDS.has(item.lower) && item.lower !== 'one' && item.lower !== 'zero')) && !known.has(root(item.lower)));
  if (unstated.length) problems.push(`holds the figure ${unstated.map(item => JSON.stringify(item.word)).join(', ')}, which the cited research does not state`);
  const claim = subjectClaim(words) || openerClaim(spoken) || SHAPES.map(([pattern, why]) => (pattern.test(spoken) ? why : null)).find(Boolean);
  if (claim) problems.push(`${claim}; a line about the role or company states interest and never what you are, have or did`);
  return problems;
}

/**
 * The research reason of an interest statement: the text without its
 * first-person clauses and the connective after them. Claim checks written for
 * a compiled profile ground this part against the cited research. When every
 * clause is spoken as "I" or "we", what remains is the words that are neither
 * plain function words nor interest wording; with none left, the whole text is
 * returned.
 */
export function interviewInterestReason(text) {
  const value = typeof text === 'string' ? text : '';
  const clauses = [];
  let start = 0;
  for (const match of value.matchAll(/[,;:]|\s[-–—]\s|[–—]|\b(?:because|since|as|given|while|so|where|which|that|who|whom|whose)\b/giu)) {
    clauses.push({ start, end: match.index }); start = match.index + match[0].length;
  }
  clauses.push({ start, end: value.length });
  const filled = clauses.map(clause => ({ ...clause, text: value.slice(clause.start, clause.end) })).filter(clause => clause.text.trim());
  const kept = filled.filter(clause => !FIRST_PERSON.test(clause.text));
  if (!kept.length) {
    const content = wordsOf(value).filter(item => !FUNCTION_WORDS.has(item.lower) && !isInterest(item)).map(item => item.word);
    return content.length ? `${content.join(' ')}.` : value;
  }
  if (kept.length === filled.length) return value.trim();
  const first = kept[0]; const last = kept.at(-1);
  const between = filled.filter(clause => clause.start >= first.start && clause.end <= last.end);
  return (between.length === kept.length ? value.slice(first.start, last.end) : kept.map(clause => clause.text).join(' ')).trim();
}

/** Prefer a research reason in the headline. A warned fallback can retain the
 * reason in a separately cited bullet; ordinary claim guards still check every
 * line, including the career connection. */
export function interviewWhyCardFailures(card, evidence = []) {
  if (cardKind(card) !== 'motivation') return [];
  const failures = [];
  const add = (rule, path, instruction) => failures.push({ rule: `INTERVIEW_ANSWER_${rule}`, path, instruction });
  const byId = new Map(evidence.map(item => [item.id, item]));
  const sourcesFor = statement => Array.isArray(statement?.evidenceIds) ? statement.evidenceIds.map(id => byId.get(id)) : [];
  if (card.thinEvidence === true && [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : [])].some(statement => {
    const sources = sourcesFor(statement);
    return sources.length && sources.every(source => source?.kind === 'research');
  })) return failures;
  const headlineSources = sourcesFor(card.headline);
  if (!headlineSources.length || headlineSources.some(item => item?.kind !== 'research')) {
    add('WHY_HEADLINE_RESEARCH', 'headline', 'state the reason in the headline and cite only sealed research evidence there; career evidence belongs in the connecting bullets.');
  }
  const headline = typeof card.headline?.text === 'string' ? card.headline.text : '';
  // A headline that cites career evidence already failed its own rule above.
  const reasons = interviewInterestFailures(headline, headlineSources.filter(Boolean)).filter(reason => !/^cites something other/u.test(reason));
  if (reasons.length) {
    add('WHY_HEADLINE_REASON', 'headline', `${reasons.join('; ')}. Answer why in your own words with a cited role or company fact; the headline may say you are interested or drawn, but never describes your own past or work.`);
  }
  const bullets = Array.isArray(card.bullets) ? card.bullets : [];
  const careerConnections = bullets.filter(bullet => {
    const sources = sourcesFor(bullet);
    return sources.length && sources.every(source => source?.kind === 'career');
  });
  if (careerConnections.length < 1 || careerConnections.length > 2 || careerConnections.length !== bullets.length) {
    add('WHY_CAREER_CONNECTION', 'bullets', 'follow the research reason with one or two separately cited career facts in the bullets; keep research facts in the headline.');
  }
  return failures;
}
