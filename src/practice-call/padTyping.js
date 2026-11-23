// Typing into the coding pad the way a person does, for the wand working an exercise: only the part that changes
// is deleted and retyped, one key at a time, at a human pace with small pauses at line ends.

/**
 * The edit that turns `from` into `to`: keep the common start and end, delete what is between in `from` and type what
 * is between in `to`. `at` is where the change starts; `remove` how many characters go; `insert` what is typed.
 */
export function padEdit(from, to) {
  const a = String(from ?? '');
  const b = String(to ?? '');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return { at: start, remove: a.length - start - end, insert: b.slice(start, b.length - end) };
}

/** How long a person takes before typing `char` (ms). `random` gives 0..1. Line ends and blocks take a beat longer. */
export function keyDelayMs(char, previous = '', random = Math.random) {
  const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
  if (char === '\n') return previous === '\n' ? 350 + jitter * 250 : 220 + jitter * 260;
  if (char === ' ' && previous === ' ') return 18; // indentation goes in quickly
  if (/[(){}[\]:,.=]/u.test(char)) return 70 + jitter * 70;
  return 45 + jitter * 55;
}

/** The pause before each deleted character (ms). */
export const DELETE_DELAY_MS = 35;

/** About how long a spoken word takes in the candidate's voice (ms): two and a half words a second. */
export const SPEECH_MS_PER_WORD = 400;
const PACE_MIN = 0.75;
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
