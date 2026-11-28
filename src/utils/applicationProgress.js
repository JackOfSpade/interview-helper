// Plain-language labels for the application runner's stages. A stage is a
// current activity, not evidence that every earlier activity finished.
const STAGE_LABELS = Object.freeze({
  requirements: 'Read job requirements',
  'requirements-audit': 'Audit job requirements',
  'requirements-adjudication': 'Resolve requirement disagreements',
  'evidence-plan': 'Plan supporting evidence',
  'editorial-plan': 'Plan application',
  'host-verification': 'Check response',
  resume: 'Write résumé',
  'cover-letter': 'Write cover letter',
  review: 'Review and edit',
  'requirement-disposition': 'Check requirement coverage',
  'blind-review': 'Independent review',
  'blind-repair-context': 'Prepare review corrections',
  'refinement-judge': 'Compare revisions',
  write: 'Write application',
  convert: 'Structure application',
  'verify-correction': 'Correct verification findings',
  'fit-correction': 'Fit documents to one page',
  pick: 'Compare candidates',
  'fact-check': 'Fact-check selected candidate',
  'fact-correction': 'Correct fact-check findings',
  'fact-recheck': 'Recheck corrected facts',
  'write-verify-human-stop': 'Application needs review',
});

export function applicationProgressStageLabel(stage) {
  return typeof stage === 'string' && Object.hasOwn(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : null;
}
