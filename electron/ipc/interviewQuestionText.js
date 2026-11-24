/**
 * The answer writer words every prepared question itself. A question must not
 * carry an uncited claim about the candidate into an otherwise grounded card
 * ("Why did you increase revenue by 40%?"), so the host holds a question and
 * its variants to a few narrow rules, and runs them only when a set is written
 * (a stored question is never re-judged):
 *
 * - shape: one line of a sane length that ends as a question or request;
 * - no figure that could be a result: no percent sign, currency or magnitude
 *   word ("million"), and no number above ten unless it counts time ("3 to 5
 *   years", "first 90 days", "month 3"). Counts of ten or less ("top 3
 *   strengths") and "1-on-1" are allowed;
 * - no name taken from the career text, by strong signals only (see below).
 *
 * This check fails open on purpose. It does not read grammar: it cannot tell
 * whether a question assumes something the person did ("Why did you leave the
 * team?"), takes a job for granted ("your manager") or points back at a thing
 * it never named. Earlier versions tried with word lists and patterns and kept
 * both refusing ordinary wording and accepting claims, and a refused card costs
 * a repair round. Those are left to the writer's prompt (interviewAnswerBank.js).
 * A question is asked by the interviewer and claims nothing; every answer card
 * is still checked against the evidence it cites.
 */

const MIN_CHARACTERS = 12;
const MAX_CHARACTERS = 200;
const TOKEN = /(?:\.(?=\p{L}))?[\p{L}\p{N}][\p{L}\p{N}+#.'’_-]*/gu;
const SMALL_NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']);
const LARGE_NUMBER_WORDS = new Set(['eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred']);
const MAGNITUDE_WORDS = new Set(['thousand', 'million', 'billion', 'trillion']);
const TIME_UNIT = /^(?:day|week|month|quarter|year)s?$/u;
// "90-day", "12-months": a figure fused to its unit of time.
const TIME_SPAN_TOKEN = /^\d[\d,.+–-]*(?:day|week|month|quarter|year)s?$/u;
const RANGE_WORD = new Set(['to', 'or', 'and', 'through', 'thru']);

const cleanToken = token => token.replace(/['’]s$/iu, '').replace(/[.'’_-]+$/u, '');
const tokensOf = value => (String(value || '').normalize('NFKC').match(TOKEN) || []).map(cleanToken).filter(Boolean);
const keyOf = token => token.toLowerCase();
// "KPI", "HR", "SaaS": a plain initialism is a word, never a name.
const isInitialism = token => /^(?:\p{Lu}{2,6}s?|\p{Lu}+\p{Ll}{1,2}\p{Lu}+s?)$/u.test(token);
// A token that is a name whatever case it is written in: a symbol or digit in a word ("C++", "S3",
// ".NET", "Node.js", "3M"), or camelCase ("PostgreSQL", "iPhone"). Plain figures and "90-day" are not.
const isStrongName = token => /\p{L}/u.test(token) && !isInitialism(token)
  && (/[+#]/u.test(token) || /\p{L}{2,}\.\p{L}|^\.\p{L}{2,}/u.test(token) || /\p{L}\d/u.test(token) || /^\d+\p{Lu}+$/u.test(token)
    || /^\p{Ll}+\p{Lu}\p{Ll}/u.test(token) || /^\p{Lu}\p{Ll}{2,}\p{Lu}/u.test(token));

// What the career text names. A word the text merely capitalises is not a name by that alone: a
// skills list, a degree line and a heading capitalise plain words ("Leadership", "Education"), so
// such a word counts only when the question itself capitalises it mid-sentence.
let lastVocabulary = null;
function careerVocabulary(careerText) {
  if (lastVocabulary?.text === careerText) return lastVocabulary;
  const lowerSeen = new Set(); const strong = new Set(); const capitalised = new Set();
  for (const line of careerText.split('\n')) {
    // A line in capitals is a heading ("EDUCATION"): its words are not names.
    const heading = !/\p{Ll}/u.test(line);
    for (const match of line.normalize('NFKC').matchAll(TOKEN)) {
      const token = cleanToken(match[0]);
      if (!token) continue;
      const key = keyOf(token);
      if (/^\p{Ll}/u.test(token)) lowerSeen.add(key);
      if (isStrongName(token)) strong.add(key);
      else if (!heading && /^\p{Lu}\p{Ll}+/u.test(token) && !isInitialism(token)) capitalised.add(key);
    }
  }
  for (const key of [...strong, ...capitalised]) if (lowerSeen.has(key)) { strong.delete(key); capitalised.delete(key); }
  lastVocabulary = { text: careerText, strong, capitalised };
  return lastVocabulary;
}

/** The figures in `tokens` that could state a result, and what is refused about them. */
function resultFigures(text, tokens) {
  const found = [];
  if (/%/u.test(text) || /\bper ?cent\b/iu.test(text)) found.push('percent');
  for (const symbol of text.match(/[$£€¥]/gu) || []) found.push(symbol);
  const figureValue = token => {
    const key = keyOf(token);
    if (/^\d+-on-\d+$/u.test(key) || TIME_SPAN_TOKEN.test(key)) return null;
    // "40k", "2m" scale a figure; "3rd" and "3d" are not figures.
    const digits = /^(\d[\d,]*(?:\.\d+)?)\+?(k|m|bn?|x)?$/u.exec(key);
    if (digits) return digits[2] ? Infinity : Number.parseFloat(digits[1].replaceAll(',', ''));
    if (/^\d[\d,.]*[–-]\d[\d,.]*$/u.test(key)) return Math.max(...key.split(/[–-]/u).map(part => Number.parseFloat(part.replaceAll(',', ''))));
    if (LARGE_NUMBER_WORDS.has(key)) return Infinity;
    if (SMALL_NUMBER_WORDS.has(key)) return 0;
    return null;
  };
  tokens.forEach((token, index) => {
    const key = keyOf(token);
    if (MAGNITUDE_WORDS.has(key)) { found.push(token); return; }
    const value = figureValue(token);
    if (value === null || value <= 10) return;
    // A figure, or a range or run of numbers ("3 to 5", "twenty five"), straight before a unit of time
    // states how long; one straight after a unit ("month 3") says which.
    if (TIME_UNIT.test(keyOf(tokens[index - 1] || ''))) return;
    let next = index + 1;
    for (;;) {
      if (figureValue(tokens[next] || '') !== null) next += 1;
      else if (RANGE_WORD.has(keyOf(tokens[next] || '')) && figureValue(tokens[next + 1] || '') !== null) next += 2;
      else break;
    }
    if (!TIME_UNIT.test(keyOf(tokens[next] || ''))) found.push(token);
  });
  return found;
}

/**
 * Why `text` cannot be a prepared question, or null when it can. `set` is
 * `general` (one set shared by every interview) or `posting` (it may use a
 * figure or name that `researchText`, the listing and brief, states). The
 * research text grants nothing in the general set. `careerText` is the
 * candidate's own career text: a question may not name what it names.
 */
export function interviewQuestionFailure(text, { set = 'posting', researchText = '', careerText = '' } = {}) {
  if (typeof text !== 'string') return 'is not text';
  const value = text.trim();
  if (value.length < MIN_CHARACTERS || value.length > MAX_CHARACTERS) return `is ${value.length} characters; write ${MIN_CHARACTERS}–${MAX_CHARACTERS}`;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return 'has a line break or control character; write one line';
  if (/[.!?](?:\s)/u.test(value.replace(/[.!?]+$/u, ''))) return 'has more than one sentence; ask one question';
  if (!/[?.]$/u.test(value)) return 'does not end as a sentence';
  const posting = set !== 'general';
  const research = posting ? new Set(tokensOf(researchText).map(keyOf)) : new Set();
  const researchLower = posting ? String(researchText).normalize('NFKC').toLowerCase() : '';
  const tokens = tokensOf(value);
  const stated = figure => posting && (research.has(keyOf(figure)) || (figure === 'percent' ? /%|per ?cent/u.test(researchLower) : researchLower.includes(figure)));
  const figures = resultFigures(value.normalize('NFKC'), tokens).filter(figure => !stated(figure));
  if (figures.length) return `holds the figure ${figures.map(figure => JSON.stringify(figure)).join(', ')}${posting ? ', which the listing and brief do not state' : ''}`;
  const career = typeof careerText === 'string' && careerText.trim() ? careerVocabulary(careerText) : null;
  if (!career) return null;
  const names = tokens.filter((token, index) => {
    const key = keyOf(token);
    if (research.has(key)) return false;
    if (career.strong.has(key)) return true;
    return index > 0 && /^\p{Lu}\p{Ll}+/u.test(token) && !isInitialism(token) && career.capitalised.has(key);
  });
  if (names.length) return `names ${names.map(token => JSON.stringify(token)).join(', ')}${posting ? ', which the listing and brief do not name' : '; a question shared by every interview names nothing from the career text'}`;
  return null;
}

/** What a posting question may name: the brief's role, themes, likely questions, research facts and the listing. */
export function interviewQuestionContext({ brief, bundle } = {}) {
  const parts = [];
  const role = brief?.role;
  if (role && typeof role === 'object') parts.push(role.title, role.company, role.location, role.summary);
  for (const list of [brief?.roleThemes, brief?.likelyQuestions]) for (const item of Array.isArray(list) ? list : []) parts.push(typeof item === 'string' ? item : item?.question);
  for (const field of ['companyFacts', 'recentContext']) for (const item of Array.isArray(brief?.[field]) ? brief[field] : []) parts.push(item?.fact);
  parts.push(bundle?.listingText);
  return { researchText: parts.filter(item => typeof item === 'string').join('\n') };
}

/** The candidate's own career text, from the evidence a card may cite. */
export const interviewQuestionCareerText = evidence => (Array.isArray(evidence) ? evidence : [])
  .filter(item => item?.kind === 'career' && typeof item.text === 'string').map(item => item.text).join('\n');
