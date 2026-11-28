// A career-file import has two deliberately separate phases.  The compiler
// owns source paths and may publish an approved immutable snapshot; providers
// only receive the opaque snapshot id.  Keeping this receipt on the hub makes
// that boundary survive a render or a manual-AI pause.

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function snapshotId(value) {
  const id = text(value);
  return id && /^[a-f0-9]{64}$/u.test(id) ? id : null;
}

function nowAttemptId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function beginCareerImportCompilation({ generation, manualAiRunId = null, attemptId = nowAttemptId() } = {}) {
  const normalizedGeneration = text(generation);
  const normalizedAttemptId = text(attemptId);
  if (!normalizedGeneration || !normalizedAttemptId) return null;
  return {
    version: 1,
    generation: normalizedGeneration,
    attemptId: normalizedAttemptId,
    status: 'compiling',
    ...(text(manualAiRunId) ? { manualAiRunId: text(manualAiRunId) } : {}),
    startedAt: Date.now(),
  };
}

function careerImportCompilationMatches(receipt, { generation, attemptId } = {}) {
  return receipt?.version === 1
    && text(receipt.generation) === text(generation)
    && text(receipt.attemptId) === text(attemptId);
}

export function approveCareerImportCompilation(receipt, {
  generation,
  attemptId,
  careerSnapshotId,
  profileFingerprint = null,
} = {}) {
  if (!careerImportCompilationMatches(receipt, { generation, attemptId })) return null;
  const canonicalSnapshotId = snapshotId(careerSnapshotId);
  if (!canonicalSnapshotId) return null;
  return {
    ...receipt,
    status: 'approved',
    careerSnapshotId: canonicalSnapshotId,
    ...(text(profileFingerprint) ? { profileFingerprint: text(profileFingerprint) } : {}),
    approvedAt: Date.now(),
    error: undefined,
  };
}

export function failCareerImportCompilation(receipt, { generation, attemptId, error } = {}) {
  if (!careerImportCompilationMatches(receipt, { generation, attemptId })) return null;
  return {
    ...receipt,
    status: 'failed',
    error: String(error || 'Failed to compile career files').slice(0, 1000),
    failedAt: Date.now(),
  };
}
