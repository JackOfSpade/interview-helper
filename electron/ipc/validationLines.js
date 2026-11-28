import { validationFailure } from './validationFailure.js';
import { escapeRegExp } from '../../src/utils/regexEscape.js';

// Code-authored teaching sentences. Variable values are formatted below.
export const VALIDATION_TEMPLATES = Object.freeze({
  "sections.preface": "text outside the sections was found; put nothing before the first BEGIN marker or after the last END marker, and no code fences",
  "sections.marker-malformed": "{raw} marker lines are malformed, nested or unmatched; each marker is on its own line in the exact form BEGIN {label} <id> and END {label} <id>, with one END for every BEGIN and no trailing spaces",
  "sections.unknown": "sections {ids} use ids that were not requested",
  "sections.duplicate": "sections {ids} appear more than once",
  "sections.empty": "sections {ids} are empty; every requested section needs content",
  "sections.missing": "requested sections {ids} are missing; return exactly one section for every requested id",
  "sections.order": "sections are not in the requested order",
  "text.official-research-empty": "official posting research is empty; return one candidate section or NOT FOUND section for every requested id",
  "text.official-research-length": "official posting research exceeds {max} characters; shorten candidate lists without omitting any requested id",
  "text.official-research-row": "official posting sections {ids} need only NOT FOUND or 1 to 6 CANDIDATE JSON lines; do not return a verdict or commentary",
  "text.official-research-json": "official posting candidate lines at {ids} are not valid JSON objects; use one complete object per CANDIDATE line",
  "text.official-research-fields": "official posting candidates at {ids} need exactly careersPageUrl, postingUrl, employer, employerDomain and ats as bounded strings",
  "text.official-research-url": "official posting candidates at {ids} need an absolute HTTPS careers or posting URL without credentials, whitespace or control characters",
  "text.official-research-domain": "official posting employerDomain at {ids} must be empty or an absolute HTTPS domain root without credentials, a query or a fragment",
  "text.official-research-duplicate": "official posting sections {ids} repeat a candidate; return each candidate URL combination once",
  "text.empty": "the response is empty; return the full research text",
  "text.too-long": "the response has {raw} characters and at most {max} are allowed; return a shorter answer that keeps the facts, direct URLs and quotes",
  "interview.not-object": "the answer is not a JSON object; return the brief object defined by the response schema",
  "interview.fact": "fact must be non-blank text copied exactly from RAW RESEARCH at {ids}",
  "interview.quote": "evidenceQuote must be non-blank text copied exactly from RAW RESEARCH at {ids}",
  "interview.url": "sourceUrl must be an http(s) URL copied exactly from RAW RESEARCH at {ids}",
  "interview.date": "sourceDate must be exactly unknown, or date text of at most 80 characters copied exactly from RAW RESEARCH and never a URL, at {ids}",
  "interview.positioning-kind": "documentKind must be resume or coverLetter at {ids}",
  "interview.positioning-point": "point must be text copied exactly from the APPLICATION POSITIONING of the same documentKind at {ids}",
  "interview.positioning-quote": "evidenceQuote must be text copied exactly from the APPLICATION POSITIONING of the same documentKind at {ids}",

});

export function templatesFor(...prefixes) {
  return Object.freeze(Object.fromEntries(Object.entries(VALIDATION_TEMPLATES).filter(([id]) => prefixes.some(prefix => id.startsWith(prefix)))));
}
export const SECTION_CORRECTION_TEMPLATES = templatesFor('sections.');
export const TEXT_CORRECTION_TEMPLATES = templatesFor('text.');

export function quoted(value, max = 80) {
  let text = String(value ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/'/g, String.fromCharCode(8217));
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}${String.fromCharCode(8230)}`;
  return JSON.stringify(text);
}
export function bracket(items, max = 8, maxChars = 120) {
  const all = [...new Set((Array.isArray(items) ? items : []).filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value).replace(/[[\]"'\p{Cc}]/gu, '').replace(/\//g, ':').trim().slice(0, 40)).filter(Boolean))];
  const kept = [];
  for (const value of all) {
    if (kept.length >= max || [...kept, value].join(', ').length > maxChars) break;
    kept.push(value);
  }
  if (kept.length < all.length) {
    let suffix = `+${all.length - kept.length} more`;
    while (kept.length && [...kept, suffix].join(', ').length > maxChars) {
      kept.pop(); suffix = `+${all.length - kept.length} more`;
    }
    kept.push(suffix);
  }
  return `[${kept.join(', ')}]`;
}
export const correctionRuleId = id => id.replace(/[.-]/g, '_').toUpperCase();

export function collector() {
  const entries = [];
  const api = {
    add(ruleId, entity, extra = {}) { entries.push({ ruleId, entity, ...extra }); },
    get size() { return entries.length; },
    first() { return entries[0] || null; },
    render(templates, vars = {}) {
      const grouped = new Map();
      for (const entry of entries) {
        if (!Object.hasOwn(templates, entry.ruleId)) throw new TypeError(`Missing validation template ${entry.ruleId}`);
        if (!grouped.has(entry.ruleId)) grouped.set(entry.ruleId, []);
        grouped.get(entry.ruleId).push(entry);
      }
      const problems = [...grouped].slice(0, 12).map(([ruleId, group]) => {
        const first = group[0];
        const values = { ...vars, ids: bracket(group.map(entry => entry.entity)), value: quoted(first.value), raw: String(first.raw), list: bracket(first.list || []), count: String(group.length) };
        const line = templates[ruleId].replace(/\{([A-Za-z]+)\}/g, (_match, name) => {
          if (!Object.hasOwn(values, name)) throw new TypeError(`Unknown validation placeholder ${name}`);
          return String(values[name]);
        });
        return { ruleId, correctionRuleId: correctionRuleId(ruleId), line };
      });
      return { problems, first: api.first() };
    },
    fail({ templates, vars, error, message = error?.message, code = error?.code ?? null, validationDiagnostic = error?.validationDiagnostic } = {}) {
      if (!entries.length) return;
      const { problems, first } = api.render(templates, vars);
      throw validationFailure({ error, message: message ?? first.message, code,
        validationDiagnostic: validationDiagnostic ?? first.diagnostic,
        details: problems.map(problem => problem.line), ruleIds: problems.map(problem => problem.correctionRuleId) });
    },
  };
  return api;
}

export function diagnoseMarkedSections(raw, {
  expectedIds = [], label, idPattern = '[a-f0-9]{24}', trimLines = false,
  caseInsensitive = true, outsideTextAllowed = false, ordered = false, decoratedLookalikes = false,
} = {}) {
  if (!Array.isArray(expectedIds) || !expectedIds.length || new Set(expectedIds).size !== expectedIds.length) return [];
  const normalize = id => caseInsensitive ? String(id).toLowerCase() : String(id);
  const expected = expectedIds.map(normalize);
  const flags = caseInsensitive ? 'i' : '';
  const exact = new RegExp(`^(BEGIN|END) ${escapeRegExp(label)} (${idPattern})$`, flags);
  const lookalike = decoratedLookalikes
    ? new RegExp(`^[ \\t>*#\\x60~_-]*(?:BEGIN|END)\\s+${escapeRegExp(label)}\\b[^\\n]*$`, 'i')
    : new RegExp(`^(?:BEGIN|END) ${escapeRegExp(label)}\\b`, flags);
  let input = String(raw || '').replace(/\r\n?/g, '\n');
  if (outsideTextAllowed) input = input.trim();
  const problems = collector();
  const completed = new Set(), order = [];
  let open = null, body = [], malformed = 0;
  for (const [index, sourceLine] of input.split('\n').entries()) {
    const line = trimLines ? sourceLine.trim() : sourceLine;
    const match = line.match(exact);
    if (match) {
      const id = normalize(match[2]);
      if (match[1].toUpperCase() === 'BEGIN') {
        if (open) malformed++;
        if (!expected.includes(id)) problems.add('sections.unknown', id);
        open = id; body = [];
      } else if (!open || open !== id) malformed++;
      else {
        if (!body.join('\n').trim()) problems.add('sections.empty', id);
        if (completed.has(id)) problems.add('sections.duplicate', id);
        completed.add(id); order.push(id); open = null; body = [];
      }
    } else if (lookalike.test(line)) malformed++;
    else if (open) body.push(line);
    else if (line.trim() && !outsideTextAllowed) problems.add('sections.preface', index);
  }
  if (open) malformed++;
  if (malformed) problems.add('sections.marker-malformed', '', { raw: malformed });
  for (const id of expected) if (!completed.has(id)) problems.add('sections.missing', id);
  if (ordered && order.length === expected.length && order.some((id, index) => id !== expected[index])) problems.add('sections.order', '');
  return problems.render(SECTION_CORRECTION_TEMPLATES, { label }).problems;
}
