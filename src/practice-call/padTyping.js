// Typing into the coding pad the way a person does, for the wand working an exercise: only the part that changes
// is deleted and retyped, one key at a time, at a human pace with small pauses at line ends.

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const isWordChar = char => typeof char === 'string' && WORD_CHAR.test(char);
// How far back an insertion is looked for a better place to make it. A place is found within a line or two.
const INSERT_SHIFT_MAX = 400;

/**
 * How good a place `at` in `a` is for typing `text` in: 0 the end of a line (Enter, then the new lines), 1 the start of
 * a line with whole lines typed above it, 2 anywhere that is not inside a word, 3 inside a word.
 */
function insertRank(a, at, text) {
  if (text[0] === '\n') return 0;
  if ((at === 0 || a[at - 1] === '\n') && text.endsWith('\n')) return 1;
  return isWordChar(a[at - 1]) && isWordChar(a[at]) ? 3 : 2;
}

/**
 * The edit that turns `from` into `to`: keep the common start and end, delete what is between in `from` and type what
 * is between in `to`. `at` is where the change starts; `remove` how many characters go; `insert` what is typed.
 *
 * Text that is only added can often go in at several places with the same result: new lines put above a line that
 * starts as they do (an `ensure` clause above `end`) share its first letters, and the longest common start would put
 * the cursor after "en" and push the "d" along in front of every key. Of the places that give the same text, the one a
 * person would type at is taken: the end of the line above, else the start of a line, else not inside a word.
 */
export function padEdit(from, to) {
  const a = String(from ?? '');
  const b = String(to ?? '');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const remove = a.length - start - end;
  const insert = b.slice(start, b.length - end);
  if (remove || !insert) return { at: start, remove, insert };
  let best = { at: start, insert, rank: insertRank(a, start, insert) };
  let at = start;
  let text = insert;
  for (let shift = 0; best.rank > 0 && shift < INSERT_SHIFT_MAX && at > 0 && a[at - 1] === text[text.length - 1]; shift += 1) {
    text = `${a[at - 1]}${text.slice(0, -1)}`;
    at -= 1;
    const rank = insertRank(a, at, text);
    if (rank < best.rank) best = { at, insert: text, rank };
  }
  return { at: best.at, remove: 0, insert: best.insert };
}

/**
 * How long a person takes before typing `char` (ms), for someone writing code as they compose it: about six characters a
 * second on average, unevenly. `random` gives 0..1. A new line's content starts after a beat, a word or identifier after a
 * smaller one, punctuation and brackets are a little slower, indentation goes in quickly and a line end takes a pause.
 */
export function keyDelayMs(char, previous = '', random = Math.random) {
  const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
  if (char === '\n') return previous === '\n' ? 400 + jitter * 300 : 250 + jitter * 300;
  if (char === ' ' && previous === ' ') return 20; // indentation goes in quickly
  if (previous === '\n') return 380 + jitter * 420; // a new line's content: thinking what comes next
  if (/[(){}[\]:,.=;<>+\-*/%!&|"'`]/u.test(char)) return 150 + jitter * 120;
  if (isWordChar(char) && !isWordChar(previous)) return 190 + jitter * 200; // the start of a word or identifier
  return 90 + jitter * 80;
}

/** The pause before each deleted character (ms). */
export const DELETE_DELAY_MS = 35;

/** About how long a spoken word takes in the candidate's voice (ms): two and a half words a second. */
export const SPEECH_MS_PER_WORD = 400;
// Never faster than a person writes code: the hands are not hurried to fit a line.
const PACE_MIN = 1;
const PACE_MAX = 1.8;

/**
 * How much to stretch (above 1) or tighten (below 1) the keys of a piece typed while `say` is spoken, so the hands and
 * the voice take about the same time: a person talking while typing slows the hands to the sentence, or hurries a
 * little. Kept within what still looks like a person typing; beyond that the shorter of the two simply ends first.
 */
export function typingPace(say, typingMs) {
  const words = String(say ?? '').trim().split(/\s+/u).filter(Boolean).length;
  if (!words || !(typingMs > 0)) return 1;
  return Math.max(PACE_MIN, Math.min(PACE_MAX, (words * SPEECH_MS_PER_WORD) / typingMs));
}

/** About how long typing `to` over `from` takes (ms): the deletions, then the keys at their average delay. */
export function padTypingMs(from, to) {
  const { remove, insert } = padEdit(from, to);
  let ms = remove * DELETE_DELAY_MS;
  for (let at = 0; at < insert.length; at += 1) ms += keyDelayMs(insert[at], insert[at - 1] ?? '', () => 0.5);
  return Math.round(ms);
}
