// The one grammar for an Interview Helper manual-AI run id. Persisted canvas
// data is validated against it before it reaches main-process cleanup, so it
// must never widen.
export const INTERVIEW_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
