/** Trimmed text cut to `max` characters with an ellipsis; a cut never leaves half of a surrogate pair. */
export function clipText(value, max) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`;
}
