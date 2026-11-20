/**
 * Interview Helper preparation helpers: the canonical job URL, the input
 * binding of a preparation run and the shape check of a saved research brief.
 */

import { hasControl as containsControlCharacters, normalizeInterviewPublicUrl } from './interviewUrlPrivacy.js';

// Setup data is persisted with an Interview Helper node, so keep its URL
// canonicalization deliberately small and deterministic.  In particular, do
// not accept credential-bearing URLs: a canvas is a shareable document and is
// never an appropriate place to retain a secret.
export function canonicalInterviewJobUrl(value) {
  // Keep renderer persistence exactly in lockstep with the main-process
  // boundary. This returns a URL stripped of arbitrary query/fragment data.
  return normalizeInterviewPublicUrl(value) || null;
}

function preparationText(value, limit = 512) {
  return typeof value === 'string' && !containsControlCharacters(value) && value.trim() && value.trim().length <= limit ? value.trim() : null;
}

// The worker deliberately permits an empty role summary when no safe summary
// can be produced.  It is nevertheless a required, bounded display field so
// a saved brief always has one unambiguous public shape.
function optionalPreparationText(value, limit = 512) {
  return value === '' || !!preparationText(value, limit);
}

/** A stable, non-secret binding for the three immutable preparation inputs. */
export function interviewPreparationInputDigest({ snapshotId, jobUrl, bundleArtifactId } = {}) {
  const snapshot = typeof snapshotId === 'string' && /^[a-f0-9]{64}$/u.test(snapshotId) ? snapshotId : null;
  const url = canonicalInterviewJobUrl(jobUrl);
  const bundle = preparationText(bundleArtifactId, 256);
  if (!snapshot || !url || !bundle) return null;
  // This is an input *binding*, not a security hash. The main process may
  // return its stronger digest, but the renderer can always reject a saved
  // brief whose explicit inputs no longer match.
  return `v1:${snapshot}:${url}:${bundle}`;
}

/**
 * Accept only a compact, display-oriented preparation result.  This keeps
 * accidental profile/source-text blobs from being written into canvas JSON.
 */
export function validInterviewPreparationBrief(value, { snapshotId, bundleArtifactId, bundleDigest } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !/^[a-f0-9]{64}$/u.test(value.briefId || '') || !preparationText(value.createdAt, 80)
    || !value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs)
    || !Object.keys(value.inputs).every(key => ['careerSnapshotId', 'jobUrlSha256', 'applicationArtifactId', 'applicationArtifactDigest'].includes(key))
    || value.inputs.careerSnapshotId !== snapshotId
    || value.inputs.applicationArtifactId !== bundleArtifactId
    || value.inputs.applicationArtifactDigest !== bundleDigest
    || !/^[a-f0-9]{64}$/u.test(value.inputs.jobUrlSha256 || '')) return false;
  const role = value.role;
  if (!role || typeof role !== 'object' || Array.isArray(role)
    || Object.keys(role).length !== 4
    || !['title', 'company', 'location', 'summary'].every(field => Object.hasOwn(role, field))
    || !['title', 'company', 'location'].every(field => !!preparationText(role[field], 1200))
    || !optionalPreparationText(role.summary, 1200)) return false;
  for (const field of ['roleThemes', 'likelyQuestions', 'questionsToAsk', 'warnings']) {
    if (!Array.isArray(value[field]) || value[field].length > 8 || !value[field].every(item => !!preparationText(item, 1200))) return false;
  }
  for (const field of ['companyFacts', 'recentContext']) {
    if (!Array.isArray(value[field]) || value[field].length > 8 || !value[field].every(item => (
      item && typeof item === 'object' && !Array.isArray(item)
      && !!preparationText(item.fact, 1200) && !!preparationText(item.sourceId, 80)
      // A brief can be restored from a canvas without repeating IPC. Require
      // its displayed citation to already be the privacy-safe canonical form,
      // rather than merely accepting a value that *could* be sanitized.
      && typeof item.sourceUrl === 'string' && canonicalInterviewJobUrl(item.sourceUrl) === item.sourceUrl
      && !!preparationText(item.sourceDate, 80)
      // Main-process provenance validation may use source quotes internally,
      // but the public durable brief retains source metadata only.
      && Object.keys(item).every(key => ['fact', 'sourceId', 'sourceUrl', 'sourceDate'].includes(key))
    ))) return false;
  }
  if (!Array.isArray(value.applicationPositioning) || value.applicationPositioning.length > 8 || !value.applicationPositioning.every(item => (
    item && typeof item === 'object' && !Array.isArray(item)
    && ['resume', 'coverLetter'].includes(item.documentKind) && !!preparationText(item.point, 1200)
    // Quote provenance is checked in the main process before this compact
    // projection crosses IPC. Never persist resume/cover-letter excerpts in
    // a shareable canvas document.
    && Object.keys(item).every(key => ['documentKind', 'point'].includes(key))
  ))) return false;
  if (!Array.isArray(value.sources) || value.sources.length > 16 || !value.sources.every(item => (
    item && typeof item === 'object' && !Array.isArray(item) && !!preparationText(item.sourceId, 80)
    && typeof item.sourceUrl === 'string' && canonicalInterviewJobUrl(item.sourceUrl) === item.sourceUrl
    && !!preparationText(item.sourceDate, 80)
    && Object.keys(item).every(key => ['sourceId', 'sourceUrl', 'sourceDate'].includes(key))
  ))) return false;
  // A strict allow-list prevents a profile, raw listing, or file payload from
  // being smuggled into canvas state alongside an otherwise plausible brief.
  return Object.keys(value).every(key => [
    'version', 'briefId', 'createdAt', 'inputs', 'role', 'roleThemes',
    'companyFacts', 'recentContext', 'likelyQuestions', 'questionsToAsk',
    'applicationPositioning', 'sources', 'warnings',
  ].includes(key));
}
