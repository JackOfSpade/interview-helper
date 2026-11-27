// Listing-page evidence is deliberately transient. Only the small verdict pair
// belongs on a job row; page text stays in the invocation-local evidence map.

const closedRules = Object.freeze([
  Object.freeze({ id: 'no-longer-accepting', pattern: 'no\\s+longer\\s+accepting\\s+applications' }),
  Object.freeze({ id: 'job-no-longer-available', pattern: '(?:this\\s+)?job\\s+is\\s+no\\s+longer\\s+available' }),
  Object.freeze({ id: 'listing-no-longer-available', pattern: '(?:this\\s+)?listing\\s+is\\s+no\\s+longer\\s+available' }),
  Object.freeze({ id: 'no-longer-available', pattern: 'no\\s+longer\\s+available' }),
  Object.freeze({ id: 'job-expired', pattern: '(?:this\\s+)?job\\s+has\\s+expired' }),
  Object.freeze({ id: 'page-not-found', pattern: '(?:page\\s+not\\s+found|we\\s+can[’\x27]t\\s+find\\s+this\\s+page)' }),
  Object.freeze({ id: 'position-filled', pattern: '(?:this\\s+)?position\\s+has\\s+been\\s+filled' }),
]);

const rule = (id, selectors) => Object.freeze({ id, version: 1, state: 'shadow', selectors: Object.freeze(selectors) });
const commonDescriptionSelectors = Object.freeze([
  '#job-details', '#jobDescriptionText', '.simple-job-description-html', '[data-testid="job-description"]',
  '.jobs-description-content__text', '.jobs-description__content',
  '.jobs-box__html-content', '.description__text', '.show-more-less-html__markup',
  '[itemprop="description"]', '.job-description', '.jobDescription',
]);

function boardRules(descriptionSelectors, openRules, structuralRules = []) {
  return Object.freeze({
    descriptionSelectors: Object.freeze(descriptionSelectors),
    closedRules,
    openRules: Object.freeze(openRules),
    structuralRules: Object.freeze(structuralRules),
  });
}

/** Candidate open controls begin in shadow until independent AI checks calibrate them. */
export const LISTING_LIVENESS_RULES = Object.freeze({
  linkedin: boardRules(
    ['#job-details', '.jobs-description-content__text', '.jobs-description__content', '.jobs-box__html-content', '.description__text', '.show-more-less-html__markup'],
    [rule('linkedin-enabled-apply', ['button.jobs-apply-button', 'a.jobs-apply-button'])],
  ),
  indeed: boardRules(
    ['#jobDescriptionText', '.jobsearch-JobComponent-description', '[data-testid="jobDescriptionText"]', '.simple-job-description-html'],
    [rule('indeed-enabled-apply', ['#indeedApplyButton', 'button[data-testid="apply-button"]'])],
  ),
  ziprecruiter: boardRules(
    ['[data-testid="job-description"]', '[class~="whitespace-pre-line"]', '.whitespace-pre-line',
      '.job_description', '.job-description', '[itemprop="description"]'],
    [rule('ziprecruiter-enabled-apply', ['button[data-testid="apply-button"]', 'a[data-testid="apply-button"]', '.apply_button'])],
    ['closed_job_redirect', 'workday-posting-unavailable'],
  ),
  dice: boardRules(
    ['[data-testid="job-description"]', '#jobDescription', '.job-description', '[itemprop="description"]'],
    [rule('dice-enabled-apply', ['button[data-testid="apply-button"]', 'a[data-testid="apply-button"]'])],
  ),
  generic: boardRules(
    commonDescriptionSelectors,
    [rule('generic-enabled-apply', ['button[data-testid="apply-button"]', 'a[data-testid="apply-button"]'])],
    ['workday-posting-unavailable'],
  ),
});

function dateExpired(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const raw = value.trim();
  const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(raw)
    ? Date.parse(`${raw}T23:59:59.999Z`) : Date.parse(raw);
  return Number.isFinite(expiry) && expiry < now;
}

/** The marker check is shared with calibration eligibility; it never decides closure. */
export function listingClosedMarkerPresent(evidence, now = Date.now()) {
  return (Array.isArray(evidence?.closedHits) && evidence.closedHits.some(hit => hit && hit.insideDescription === false))
    || evidence?.jsonLd?.isListed === false
    || dateExpired(evidence?.jsonLd?.validThrough, now);
}

