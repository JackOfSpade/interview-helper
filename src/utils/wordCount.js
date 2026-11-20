/** Whitespace-separated word count, used by the answer length checks. */
export const glanceWordCount = value => String(value || '').trim().split(/\s+/u).filter(Boolean).length;
