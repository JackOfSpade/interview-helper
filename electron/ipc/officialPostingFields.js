// Pure shared wire schema: main-process records and renderer whitelists use
// the same field list. Scraped identity fields remain separate from these.
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, officialPostingNegativeNeedsRecheck } from './officialPostingNegativePolicy.js';
export const OFFICIAL_POSTING_ROW_FIELDS = Object.freeze(['postedBy', 'applyOptions', 'salaryProvenance', 'officialPosting', 'boardClosed', 'listingLiveness', 'alternateListings']);
const OFFICIAL_POSTING_LEVELS = Object.freeze(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
// Levels whose source is the employer's own page, and the subset whose full text is stored.
const OFFICIAL_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const OFFICIAL_POSTING_OUTCOMES = Object.freeze(['found', 'link-only', 'not-found', 'ambiguous', 'unreadable', 'closed', 'failed']);
export const OFFICIAL_FETCH_FAILURE_REASONS = Object.freeze(['access-denied', 'rate-limited', 'server-error', 'network-error', 'dns-error']);
const FETCH_FAILURE_CODES = Object.freeze(['fetch-failed', 'fetch-timeout', 'unsafe-url', 'unsafe-address', 'unsupported-content-type', 'oversize', 'invalid-text']);
const OFFICIAL_FETCH_FAILURE_LIMIT = 8;
const SALARY_PROVENANCES = Object.freeze(['posted', 'estimated', 'unknown']);
const OFFICIAL_POSTING_COMPARATIVE_CODES = Object.freeze([
  'comparative-match', 'comparative-equivalent', 'comparative-disagree', 'comparative-invalid', 'comparative-none', 'comparative-unavailable',
]);
// The second attempt reached the same doubt, so nothing more will come from retrying.
// 'retry-paused' marked this before careers-page snapshots carried job-board links from
// page markup. It stays a known code but means nothing, so those cards get one more try.
const OFFICIAL_POSTING_EXHAUSTED_TRAIL = 'lookup-exhausted';
const RETIRED_RETRY_PAUSED_TRAIL = 'retry-paused';
const OFFICIAL_POSTING_TRAIL = Object.freeze([
  OFFICIAL_POSTING_EXHAUSTED_TRAIL, RETIRED_RETRY_PAUSED_TRAIL, 'free-lead', 'careers-page', 'ats-adapter', 'json-ld', 'structured-proof', 'domain-proof',
  'salary-anchor', 'identifier-anchor', 'description-anchor', 'quoted-match', 'cache-hit', 'recent-miss',
  'worker-research', 'worker-timeout', 'worker-unavailable', 'worker-aborted', 'research-miss',
  'title-mismatch', 'location-mismatch', 'employer-mismatch', 'tenant-unproven', 'source-unproven', 'poster-tenant',
  'salary-mismatch', 'no-anchor', 'invalid-quotes', 'ambiguous', 'closed', 'unreadable', 'oversize',
  'unsafe-url', 'unsafe-address', 'fetch-timeout', 'fetch-failed', 'unsupported-content-type',
  'crawl-budget', 'crawl-partial', 'invalid-text', 'stub-text', 'official-text-missing', 'no-resolution', 'reverified', 'reverify-failed', 'official-liveness-unconfirmed', 'material-jd-change', 'storage-failed', 'failed',
  'semantic-match-v1', 'closure-page-read', 'page-unreadable', 'semantic-uncertain', 'semantic-overflow', 'judge-location-split', 'judge-location-equivalent', 'judge-salary-split', 'judge-title-split', 'judge-employer-split', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL,
  ...OFFICIAL_POSTING_COMPARATIVE_CODES,
  'comparative-a-valid', 'comparative-a-invalid', 'comparative-b-valid', 'comparative-b-invalid', 'comparative-truncated', 'insufficient-text',
  ...['a', 'b', 'choice'].flatMap(run => ['none', 'uncertain', ...Array.from({ length: 8 }, (_, index) => `p${index + 1}`)]
    .map(choice => `comparative-${run}-${choice}`)),
]);

export const OFFICIAL_POSTING_LABELS = Object.freeze({
  L1: 'Official careers site', L2: 'ATS linked from careers page', L3: "Employer's ATS",
  L4: 'Official link, listing text', L5: 'Original listing', L6: 'Original listing (employer unknown)',
});

export function officialHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2_000 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/iu.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

export function normalizeApplyOptions(value) {
  const options = []; const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const href = officialHttpsUrl(item?.href);
    if (!href || seen.has(href)) continue;
    const label = typeof item?.label === 'string' ? [...item.label].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').replace(/\s+/gu, ' ').trim().slice(0, 120) : '';
    seen.add(href); options.push({ label, href });
    if (options.length === 8) break;
  }
  return options;
}

function onlyKnownKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function shortString(value, max = 500) {
  return typeof value === 'string' && value.length <= max && !/[<>]/u.test(value)
    && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
/** Diagnostic metadata only: never retain response bodies or raw error messages. */
function normalizeOfficialPostingFetchFailure(value) {
  if (!onlyKnownKeys(value, ['url', 'code', 'reason', 'statusCode']) || !FETCH_FAILURE_CODES.includes(value.code)) return null;
  const url = officialHttpsUrl(value.url);
  if (!url || (value.reason !== undefined && (value.code !== 'fetch-failed' || !OFFICIAL_FETCH_FAILURE_REASONS.includes(value.reason)))
    || (value.statusCode !== undefined && (!Number.isInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599))) return null;
  return { url, code: value.code, ...(value.reason ? { reason: value.reason } : {}),
    ...(value.statusCode !== undefined ? { statusCode: value.statusCode } : {}) };
}
function normalizeOfficialSalary(value) {
  if (!onlyKnownKeys(value, ['text', 'provenance']) || !shortString(value.text, 500) || !SALARY_PROVENANCES.includes(value.provenance)) return null;
  return { text: value.text, provenance: value.provenance };
}
export function normalizeOfficialLocation(value) {
  if (!onlyKnownKeys(value, ['display', 'workMode', 'remote', 'remoteCountry', 'remoteRegion'])) return null;
  if (!shortString(value.display, 500) || !['', 'remote', 'hybrid', 'onsite', 'on-site'].includes(value.workMode ?? '')
    || (value.remote !== undefined && typeof value.remote !== 'boolean')
    || !shortString(value.remoteCountry ?? '', 120) || !shortString(value.remoteRegion ?? '', 160)) return null;
  const suppliedMode = value.workMode || '';
  if ((value.remote === true && suppliedMode && suppliedMode !== 'remote') || (value.remote === false && suppliedMode === 'remote')) return null;
  const remote = value.remote === true || suppliedMode === 'remote';
  const remoteCountry = value.remoteCountry || ''; const remoteRegion = value.remoteRegion || '';
  const statedRestriction = restriction => restriction.trim() && !/^(?:none|n\/a|not stated|unspecified|unknown)$/iu.test(restriction.trim());
  if (remote ? !statedRestriction(remoteCountry) && !statedRestriction(remoteRegion) : remoteCountry || remoteRegion) return null;
  return { display: value.display, workMode: remote ? 'remote' : suppliedMode, remote, remoteCountry, remoteRegion };
}

// Records saved by earlier versions carry these trail codes on disk.
const SAVED_TRAIL_CODES = Object.freeze({
  'bridge-research': 'worker-research', 'bridge-timeout': 'worker-timeout',
  'bridge-unavailable': 'worker-unavailable', 'bridge-aborted': 'worker-aborted',
});

export function normalizeOfficialPosting(value) {
  const keys = ['level', 'outcome', 'employer', 'title', 'location', 'salary', 'sourceUrl', 'officialApplyUrl',
    'ats', 'tenant', 'fetchedAt', 'contentHash', 'scrapedListingSha256', 'trail', 'alternatives', 'semanticMatch', 'fetchFailures'];
  if (!onlyKnownKeys(value, keys) || !OFFICIAL_POSTING_LEVELS.includes(value.level) || !OFFICIAL_POSTING_OUTCOMES.includes(value.outcome)
    || !shortString(value.employer, 120)) return null;
  const result = { level: value.level, outcome: value.outcome, employer: value.employer };
  for (const [key, max] of [['title', 500], ['ats', 80], ['tenant', 240]]) {
    if (value[key] === undefined) continue;
    if (!shortString(value[key], max)) return null;
    result[key] = value[key];
  }
  for (const key of ['sourceUrl', 'officialApplyUrl']) {
    if (value[key] === undefined || value[key] === '') continue;
    const url = officialHttpsUrl(value[key]); if (!url) return null; result[key] = url;
  }
  for (const [key, normalize] of [['location', normalizeOfficialLocation], ['salary', normalizeOfficialSalary]]) {
    if (value[key] === undefined) continue;
    result[key] = normalize(value[key]); if (!result[key]) return null;
  }
  for (const key of ['contentHash', 'scrapedListingSha256']) {
    if (value[key] === undefined || value[key] === '') continue;
    if (!/^[a-f0-9]{64}$/u.test(value[key])) return null; result[key] = value[key];
  }
  if (value.semanticMatch !== undefined) {
    if (!onlyKnownKeys(value.semanticMatch, ['version', 'inputHash', 'sourceHash']) || value.semanticMatch.version !== 1
      || !/^[a-f0-9]{64}$/u.test(value.semanticMatch.inputHash)) return null;
    if (value.semanticMatch.sourceHash !== undefined && !/^[a-f0-9]{64}$/u.test(value.semanticMatch.sourceHash)) return null;
    result.semanticMatch = { version: 1, inputHash: value.semanticMatch.inputHash,
      ...(value.semanticMatch.sourceHash ? { sourceHash: value.semanticMatch.sourceHash } : {}) };
  }
  if (value.fetchedAt !== undefined) {
    if (!shortString(value.fetchedAt, 40) || !Number.isFinite(Date.parse(value.fetchedAt))) return null;
    result.fetchedAt = value.fetchedAt;
  }
  if (value.trail !== undefined) {
    if (!Array.isArray(value.trail) || value.trail.length > 32) return null;
    const trail = value.trail.map(item => SAVED_TRAIL_CODES[item] || item);
    if (trail.some(item => !OFFICIAL_POSTING_TRAIL.includes(item))) return null;
    result.trail = [...new Set(trail)];
  }
  if (value.fetchFailures !== undefined) {
    if (!Array.isArray(value.fetchFailures) || value.fetchFailures.length > OFFICIAL_FETCH_FAILURE_LIMIT) return null;
    result.fetchFailures = [];
    for (const item of value.fetchFailures) {
      const failure = normalizeOfficialPostingFetchFailure(item);
      if (!failure) return null;
      result.fetchFailures.push(failure);
    }
  }
  if (value.alternatives !== undefined) {
    if (!Array.isArray(value.alternatives) || value.alternatives.length > 12) return null;
    result.alternatives = [];
    for (const item of value.alternatives) {
      if (!onlyKnownKeys(item, ['url', 'title']) || !shortString(item.title, 500)) return null;
      const url = officialHttpsUrl(item.url); if (!url) return null;
      result.alternatives.push({ url, title: item.title });
    }
  }
  return result;
}

const BOARD_LABELS = Object.freeze({
  linkedin: 'LinkedIn', indeed: 'Indeed', ziprecruiter: 'ZipRecruiter', glassdoor: 'Glassdoor', dice: 'Dice',
  google: 'Google', remoteok: 'RemoteOK', weworkremotely: 'WWRemotely',
});
const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export function boardClosedBoardLabel(board) {
  if (typeof board !== 'string' || !BOARD_ID_RE.test(board)) return '';
  return BOARD_LABELS[board] || board.charAt(0).toUpperCase() + board.slice(1);
}

const LISTING_LIVENESS_VERDICTS = Object.freeze(['open', 'closed', 'pending', 'unclear']);
const LISTING_LIVENESS_BASES = Object.freeze(['open-marker', 'structural', 'ai', 'closed-marker', 'neither', 'both']);
/** A bounded observation, never a copy of page text or a URL. */
function normalizeListingLiveness(value) {
  if (!onlyKnownKeys(value, ['verdict', 'basis', 'board', 'at'])
    || !['verdict', 'basis', 'board', 'at'].every(key => Object.hasOwn(value, key))) return null;
  if (!LISTING_LIVENESS_VERDICTS.includes(value.verdict) || !LISTING_LIVENESS_BASES.includes(value.basis)
    || typeof value.board !== 'string' || !BOARD_ID_RE.test(value.board) || !shortString(value.at, 40)) return null;
  const instant = Date.parse(value.at);
  if (!Number.isFinite(instant)) return null;
  return { verdict: value.verdict, basis: value.basis, board: value.board, at: new Date(instant).toISOString() };
}

// Trail codes meaning the research step did not run, did not finish, or hit a
// transient failure. A miss carrying any of them is retryable, never a conclusion.
const RESEARCH_UNSETTLED_TRAIL = Object.freeze(['worker-aborted', 'worker-timeout', 'worker-unavailable', 'research-miss',
  'source-unproven',
  ...FETCH_FAILURE_CODES, 'crawl-budget', 'crawl-partial', 'official-text-missing', 'storage-failed', 'failed',
  'comparative-invalid', 'comparative-unavailable', 'comparative-truncated', 'insufficient-text', 'semantic-uncertain', 'judge-title-split', 'judge-employer-split', 'semantic-overflow', 'official-liveness-unconfirmed']);
/** True only for a definitive miss reached after research actually ran (or an official page that is itself closed). */
function officialResearchSettled(value) {
  const posting = value && typeof value === 'object' ? value : null;
  if (!posting || !['not-found', 'ambiguous', 'closed'].includes(posting.outcome)) return false;
  if (officialPostingNegativeNeedsRecheck(posting)) return false;
  const trail = Array.isArray(posting.trail) ? posting.trail : [];
  const officialClosed = OFFICIAL_LEVELS.has(posting.level) && posting.outcome === 'closed'
    && officialHttpsUrl(posting.sourceUrl) && trail.includes('closed') && trail.includes('semantic-match-v1')
    && /^[a-f0-9]{64}$/u.test(posting.semanticMatch?.inputHash || '') && /^[a-f0-9]{64}$/u.test(posting.semanticMatch?.sourceHash || '');
  if (!['L5', 'L6'].includes(posting.level) && !officialClosed) return false;
  if (posting.fetchFailures?.length || trail.some(code => RESEARCH_UNSETTLED_TRAIL.includes(code))) return false;
  return posting.outcome === 'closed' || trail.includes('worker-research')
    || trail.includes('comparative-none') || trail.includes('comparative-disagree');
}

/** Shared user-facing lookup state. A failed search is never an exact-match miss. */
export function officialPostingLookupStatus(value) {
  const posting = normalizeOfficialPosting(value);
  const result = (state, label, detail, retryable, sourceUrl = '', applyUrl = '') => ({ state, label, detail, retryable, sourceUrl, applyUrl });
  if (!posting) return result('unchecked', 'Official posting not checked', 'Run the official posting lookup in the app.', true);
  const official = OFFICIAL_LEVELS.has(posting.level);
  const trail = new Set(posting.trail || []);
  if (official && ['found', 'link-only'].includes(posting.outcome) && (posting.sourceUrl || posting.officialApplyUrl)) {
    if (trail.has('reverify-failed')) {
      const recheck = officialPostingLookupStatus({ ...posting, level: 'L5', outcome: 'failed',
        ...(posting.fetchFailures?.length ? { trail: posting.fetchFailures.map(failure => failure.code) } : {}) });
      return result('verified', 'Previously verified official posting', `Latest recheck: ${recheck.label}. ${recheck.detail}`, true,
        posting.sourceUrl || '', posting.officialApplyUrl || '');
    }
    return result('verified', 'Exact official posting verified',
      posting.outcome === 'link-only' ? 'The official link is verified; the application uses the original listing text.' : '',
      false, posting.sourceUrl || '', posting.officialApplyUrl || '');
  }
  const unsettled = Boolean(posting.fetchFailures?.length) || [...trail].some(code => RESEARCH_UNSETTLED_TRAIL.includes(code));
  if (!unsettled && (officialResearchSettled(posting) || (official && posting.outcome === 'closed'))) {
    if (posting.outcome === 'closed') return result('closed', 'Official posting closed', 'The official posting is no longer accepting applications.', false);
    if (posting.outcome === 'ambiguous' || trail.has('comparative-disagree')) return result('ambiguous', 'Several official postings match', 'The completed lookup could not identify one exact match. The original listing is retained.', false);
    return result('not-found', 'No exact official posting found', 'The lookup completed without a verified exact match. The original listing is retained.', false);
  }
  // Neither a plain download nor a browser could read the posting page, which says nothing about the posting itself.
  const unreadablePage = trail.has('page-unreadable') ? ' The employer\'s page could not be read, in a plain download or in a browser.' : '';
  if (officialPostingExhausted(posting)) return result('exhausted', 'No confirmed official posting',
    `Two full lookups could not confirm an official posting, so the original listing is used. Any links shown here are unconfirmed.${unreadablePage}`, false);
  const retry = 'Retry the official posting lookup in the app.';
  const retained = `The original listing is retained. ${retry}`;
  const failureLabels = { 'access-denied': 'access denied', 'rate-limited': 'rate limited', 'server-error': 'server error',
    'network-error': 'network request failed', 'dns-error': 'DNS lookup failed', 'fetch-timeout': 'request timed out',
    'fetch-failed': 'request failed', 'unsafe-url': 'URL rejected', 'unsafe-address': 'address rejected',
    'unsupported-content-type': 'unsupported page format', oversize: 'page exceeded the size limit', 'invalid-text': 'page text could not be decoded' };
  const fetchDetail = () => {
    const failures = posting.fetchFailures || [];
    const detail = failures.length ? failures.map(failure => `${failure.url}: ${failureLabels[failure.reason || failure.code]}${failure.statusCode ? ` (HTTP ${failure.statusCode})` : ''}.`).join('\n')
      : 'An employer careers or hiring-platform page could not be fetched during verification. The failed URL and response details were not recorded.';
    return `${detail}\n${retained}`;
  };
  if (trail.has('storage-failed')) return result('incomplete', 'Official posting check could not be saved', retained, true);
  if (trail.has('source-unproven')) return result('incomplete', 'Employer source verification incomplete',
    `Possible postings were found, but their employer ownership could not be verified. ${retained}`, true);
  if (trail.has('worker-unavailable') || trail.has('comparative-unavailable')) return result('incomplete', 'Official lookup incomplete: research unavailable', 'Claude research was unavailable. Retry the official posting lookup in the app.', true);
  if (trail.has('worker-timeout')) return result('incomplete', 'Official lookup incomplete: research timed out', retry, true);
  if (trail.has('worker-aborted')) return result('incomplete', 'Official lookup incomplete: research interrupted', retry, true);
  if (trail.has('fetch-timeout')) return result('incomplete', 'Employer site verification timed out', fetchDetail(), true);
  if (trail.has('crawl-budget') || trail.has('crawl-partial')) return result('incomplete', 'Official lookup incomplete: search coverage limited', retry, true);
  if (FETCH_FAILURE_CODES.some(code => trail.has(code)) || posting.fetchFailures?.length) return result('incomplete', 'Employer site verification incomplete', fetchDetail(), true);
  if (posting.outcome === 'ambiguous' || ['semantic-uncertain', 'semantic-overflow', 'comparative-invalid', 'comparative-truncated', 'insufficient-text', 'official-liveness-unconfirmed'].some(code => trail.has(code))) {
    return result('incomplete', 'Official posting match uncertain', `An exact, current official match has not been verified.${unreadablePage} ${retry}`, true);
  }
  if (posting.outcome === 'unreadable' || ['official-text-missing', 'unreadable', 'stub-text', 'invalid-text'].some(code => trail.has(code))) return result('incomplete', 'Official lookup incomplete: posting could not be read', retry, true);
  if (officialPostingNegativeNeedsRecheck(posting)) return result('incomplete', 'Outdated lookup · check again',
    `This result predates improved employer-source verification. ${retry}`, true);
  return result('incomplete', 'Official posting lookup incomplete', `The lookup did not finish, so no exact-match conclusion was reached. ${retry}`, true);
}

const JUDGED_UNCERTAIN_TRAIL = Object.freeze(['semantic-uncertain', 'judge-title-split', 'judge-employer-split', 'source-unproven', 'official-liveness-unconfirmed']);
const INTERRUPTED_RESEARCH_TRAIL = Object.freeze(RESEARCH_UNSETTLED_TRAIL.filter(code => !JUDGED_UNCERTAIN_TRAIL.includes(code)));

/** Research ran to completion without a conclusion: its judges could not confirm
 * the match, or both searches found nothing to judge. A failed download or an
 * interrupted worker can recover by itself, so it is excluded. A verification
 * still standing counts only once a recheck has failed. */
function officialPostingResearchInconclusive(value) {
  const posting = normalizeOfficialPosting(value);
  if (!posting || posting.fetchFailures?.length) return false;
  const trail = posting.trail || [];
  const official = OFFICIAL_LEVELS.has(posting.level) && ['found', 'link-only'].includes(posting.outcome);
  if (official && !trail.includes('reverify-failed')) return false;
  // Only the no-leads path records research-miss beside worker-research; a failed search records it alone.
  // A kept verification carries worker-research from its earlier run, so it cannot show this.
  const noLeads = !official && trail.includes('research-miss') && trail.includes('worker-research');
  return (noLeads || trail.some(code => JUDGED_UNCERTAIN_TRAIL.includes(code)))
    && !trail.some(code => INTERRUPTED_RESEARCH_TRAIL.includes(code) && !(noLeads && code === 'research-miss'));
}

/** Two attempts ended without a conclusion: a settled end state, not unfinished
 * work. Only a person's explicit recheck runs it again. */
function officialPostingExhausted(value) {
  const posting = normalizeOfficialPosting(value);
  return Boolean(posting?.trail?.includes(OFFICIAL_POSTING_EXHAUSTED_TRAIL)) && officialPostingResearchInconclusive(posting);
}

/** Judged on the page as a person sees it. An older closure may rest on a download that could not see the page, so it is rechecked. */
function officialPostingClosureReadFullPage(posting) {
  return (posting?.trail || []).includes('closure-page-read');
}

/** A confirmed official posting says this job is closed: the source of truth. A third party's closed verdict never counts,
 * and neither does a lookup below official level or one from before the current checks. */
function officialPostingStatesClosed(value) {
  const posting = normalizeOfficialPosting(value);
  return Boolean(posting) && OFFICIAL_LEVELS.has(posting.level) && Boolean(posting.sourceUrl)
    && (posting.trail || []).includes('semantic-match-v1') && officialPostingClosureReadFullPage(posting)
    && officialPostingLookupStatus(posting).state === 'closed';
}

/**
 * Sources are ranked by how official they are, and only the top one counts: a confirmed official posting, or else the
 * listing itself. Whether that one source is closed decides whether the job shows at all.
 */
export function mostOfficialSource(job) {
  const posting = normalizeOfficialPosting(job?.officialPosting);
  if (officialPostingStatesClosed(posting)) return { kind: 'official', closed: true };
  if (posting && OFFICIAL_LEVELS.has(posting.level) && ['found', 'link-only'].includes(posting.outcome)
    && (posting.sourceUrl || posting.officialApplyUrl)) return { kind: 'official', closed: false };
  return { kind: 'listing', closed: normalizeListingLiveness(job?.listingLiveness)?.verdict === 'closed' };
}
