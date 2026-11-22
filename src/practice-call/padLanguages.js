/**
 * The languages the candidate can pick for the coding pad when the exercise leaves the choice to them. Shared by the
 * call window (the dropdown) and the main process (which takes only a name on this list).
 */
export const PAD_LANGUAGES = Object.freeze([
  'Python', 'JavaScript', 'TypeScript', 'Java', 'C++', 'C', 'C#', 'Go', 'Rust', 'Kotlin', 'Swift', 'Ruby', 'PHP',
  'Scala', 'Dart', 'R', 'MATLAB', 'Julia', 'Haskell', 'Elixir', 'Perl', 'Lua', 'Objective-C', 'SQL', 'Bash',
]);

/** The pick a new pad starts on when the candidate has never chosen one. */
export const DEFAULT_PAD_LANGUAGE = 'Python';

/** The listed name for a value, or '' when it is not on the list. */
export function padLanguageName(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return PAD_LANGUAGES.find(name => name.toLowerCase() === key) ?? '';
}
