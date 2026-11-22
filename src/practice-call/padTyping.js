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
