import { officialHttpsUrl } from './officialPostingFields.js';
import { collector, diagnoseMarkedSections, templatesFor } from './validationLines.js';
import { validationFailure } from './validationFailure.js';

export const OFFICIAL_POSTING_RESEARCH_TASK = 'job-official-posting-research';
const MAX_RESEARCH_POSTINGS = 12;
const MAX_RESEARCH_RESPONSE_CHARS = 120_000;
const OFFICIAL_POSTING_CORRECTION_TEMPLATES = templatesFor('text.official-research-', 'sections.');

const LABEL = 'OFFICIAL POSTING RESEARCH';
const CANDIDATE_KEYS = ['careersPageUrl', 'postingUrl', 'employer', 'employerDomain', 'ats'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const bounded = (value, max, blank = true) => typeof value === 'string' && value.length <= max
  && (blank || value.trim()) && !/[<>]/u.test(value)
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function fail(issues, message) {
  issues.fail({ templates: OFFICIAL_POSTING_CORRECTION_TEMPLATES, vars: { max: MAX_RESEARCH_RESPONSE_CHARS },
    message, code: 'OFFICIAL_POSTING_RESPONSE_INVALID' });
}

function parseOfficialPostingResearchResponse(raw, expectedIds) {
  const ids = Array.isArray(expectedIds) ? expectedIds.map(String) : [];
  if (!ids.length || ids.length > MAX_RESEARCH_POSTINGS || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{24}$/u.test(id))) {
    throw new TypeError('Official posting research requires 1 to 12 distinct host member ids.');
  }
  const issues = collector();
  if (typeof raw !== 'string' || !raw.trim()) issues.add('text.official-research-empty', 'response');
  else if (raw.length > MAX_RESEARCH_RESPONSE_CHARS) issues.add('text.official-research-length', 'response');
  fail(issues, 'Official posting research response is empty or over its bound.');
  // The sections are strictly delimited by exact BEGIN/END marker lines. Web
  // research replies may open with a short preface or close with a note; that
  // surrounding prose is not part of any section and must not force a redo.
  const sectionProblems = diagnoseMarkedSections(raw, { expectedIds: ids, label: LABEL, trimLines: true, outsideTextAllowed: true, decoratedLookalikes: true });
  if (sectionProblems.length) throw validationFailure({ message: 'Official posting research sections are malformed.',
    details: sectionProblems.map(problem => problem.line), ruleIds: sectionProblems.map(problem => problem.correctionRuleId),
    code: 'OFFICIAL_POSTING_RESPONSE_INVALID' });
  const sections = new Map();
  const pattern = /^\s*BEGIN OFFICIAL POSTING RESEARCH ([a-f0-9]{24})\s*\n([\s\S]*?)^\s*END OFFICIAL POSTING RESEARCH \1\s*$/gimu;
  for (const match of raw.replace(/\r\n?/gu, '\n').matchAll(pattern)) sections.set(match[1].toLowerCase(), match[2].trim());
  const rows = ids.map(id => {
    const body = sections.get(id);
    if (body === 'NOT FOUND') return { id, candidates: [] };
    const lines = String(body ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 6 || lines.some(line => !line.startsWith('CANDIDATE: '))) {
      issues.add('text.official-research-row', id); return { id, candidates: [] };
    }
    const candidates = []; const seen = new Set();
    for (const line of lines) {
      let candidate;
      try { candidate = JSON.parse(line.slice('CANDIDATE: '.length)); }
      catch { issues.add('text.official-research-json', id); continue; }
      if (!exact(candidate, CANDIDATE_KEYS) || !bounded(candidate.employer, 120)
        || !bounded(candidate.ats, 80) || ['careersPageUrl', 'postingUrl', 'employerDomain'].some(key => !bounded(candidate[key], 2000))) {
        issues.add('text.official-research-fields', id); continue;
      }
      const normalized = { ...candidate };
      let invalid = false;
      for (const key of ['careersPageUrl', 'postingUrl']) {
        normalized[key] = candidate[key] ? officialHttpsUrl(candidate[key]) : '';
        if (candidate[key] && !normalized[key]) invalid = true;
      }
      if (invalid || (!normalized.careersPageUrl && !normalized.postingUrl)) { issues.add('text.official-research-url', id); continue; }
      if (candidate.employerDomain) {
        const url = officialHttpsUrl(candidate.employerDomain);
        const parsed = url ? new URL(url) : null;
        const supplied = url ? new URL(candidate.employerDomain) : null;
        if (!parsed || parsed.pathname !== '/' || supplied.search || supplied.hash) { issues.add('text.official-research-domain', id); continue; }
        normalized.employerDomain = parsed.origin;
      }
      const key = JSON.stringify([normalized.careersPageUrl, normalized.postingUrl, normalized.employerDomain]);
      if (seen.has(key)) { issues.add('text.official-research-duplicate', id); continue; }
      seen.add(key); candidates.push(normalized);
    }
    return { id, candidates };
  });
  fail(issues, 'Official posting research candidates are malformed.');
  return rows;
}

const MAX_RESEARCH_CANDIDATES = 6;
const MEMBERS_BEGIN = 'BEGIN UNTRUSTED SCRAPED REFERENCES JSON\n';
const MEMBERS_END = '\nEND UNTRUSTED SCRAPED REFERENCES JSON';

/** The members a research prompt was built from (id, title, poster, location), or [] when the block is absent. */
export function officialPostingResearchMembers(prompt) {
  const text = String(prompt ?? '');
  const start = text.indexOf(MEMBERS_BEGIN);
  const end = start >= 0 ? text.indexOf(MEMBERS_END, start + MEMBERS_BEGIN.length) : -1;
  if (start < 0 || end < 0) return [];
  try {
    const members = JSON.parse(text.slice(start + MEMBERS_BEGIN.length, end));
    return Array.isArray(members) ? members.filter(member => member && /^[a-f0-9]{24}$/u.test(String(member.id ?? ''))) : [];
  } catch { return []; }
}

const leadKey = url => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase().replace(/^www\./u, '')}${parsed.pathname.replace(/\/+$/u, '').toLowerCase()}`;
  } catch { return ''; }
};

/**
 * One research answer from several independent lookups for the same ids: each valid reply's
 * candidates in the order given (earlier replies first), then plain extra leads per id,
 * deduplicated by posting/careers URL and capped at the 6 a section allows. A reply that
 * fails validation contributes nothing; null when no reply was valid and no lead exists.
 * Since 2026-11-14 the worker sends one Claude reply (Parallel Search, or built-in as its fallback) plus plain
 * Parallel leads: 30 postings, two seeds, built-in 18 and 18, Parallel 28 and 27, both 28 and 28.
 */
export function mergeOfficialPostingResearchReplies({ ids, replies = [], extraLeads = {} } = {}) {
  const ordered = (Array.isArray(ids) ? ids : []).map(String);
  const parsed = [];
  for (const reply of replies) {
    if (typeof reply !== 'string' || !reply.trim()) continue;
    try { parsed.push(new Map(parseOfficialPostingResearchResponse(reply, ordered).map(row => [row.id, row.candidates]))); } catch { /* an invalid reply adds nothing */ }
  }
  const leadsFor = id => (Array.isArray(extraLeads?.[id]) ? extraLeads[id] : [])
    .map(url => officialHttpsUrl(url)).filter(Boolean)
    .map(url => ({ careersPageUrl: '', postingUrl: url, employer: '', employerDomain: '', ats: '' }));
  const anyLeads = ordered.some(id => leadsFor(id).length);
  if (!parsed.length && !anyLeads) return null;
  const sections = ordered.map(id => {
    const seen = new Set();
    const merged = [];
    for (const candidate of [...parsed.flatMap(map => map.get(id) || []), ...leadsFor(id)]) {
      const key = leadKey(candidate.postingUrl || candidate.careersPageUrl);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
      if (merged.length >= MAX_RESEARCH_CANDIDATES) break;
    }
    const body = merged.length
      ? merged.map(candidate => `CANDIDATE: ${JSON.stringify({ careersPageUrl: candidate.careersPageUrl, postingUrl: candidate.postingUrl,
        employer: candidate.employer, employerDomain: candidate.employerDomain, ats: candidate.ats })}`).join('\n')
      : 'NOT FOUND';
    return `BEGIN ${LABEL} ${id}\n${body}\nEND ${LABEL} ${id}`;
  });
  return sections.join('\n');
}
