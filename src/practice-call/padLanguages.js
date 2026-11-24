/**
 * The languages a coding exercise offers in the pad are written by the AI that prepares it, in its own words: nothing
 * here knows any language, so a role hired for an obscure one is offered it as written. Shared by the planner (which
 * cleans what the model wrote) and the call service (which offers it).
 */
export const PAD_LANGUAGE_NAME_MAX = 40;

/** The names as offered: one line each, trimmed and cut to length, each once (whatever its letter case), at most `max`. */
export function padLanguageNames(values, max = Infinity) {
  const seen = new Set();
  const names = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const name = value.replace(/\s+/gu, ' ').trim().slice(0, PAD_LANGUAGE_NAME_MAX).trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

/**
 * One spelling of a language name for comparing two of them: lower case, with spaces and dots dropped. There is no
 * table of short names here: "JS" and "JavaScript" are different names, and a label that matches nothing is left
 * to the caller's rule for that.
 */
export const padLanguageKey = value => String(value ?? '').toLowerCase().replace(/[\s.]+/gu, '');
