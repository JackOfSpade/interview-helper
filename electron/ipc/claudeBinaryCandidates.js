// Where the Claude Code CLI may live: every PATH entry first, then the user's
// own install location and the common package-manager locations. A leaf module
// (no app imports) shared by the account layer and the application runner,
// which cannot import each other.
import path from 'node:path';

export function claudeBinaryCandidates({ env = process.env, home = '' } = {}) {
  const candidates = [];
  for (const entry of String(env?.PATH || '').split(path.delimiter)) {
    if (entry) candidates.push(path.join(entry, 'claude'));
  }
  if (home) candidates.push(path.join(home, '.local', 'bin', 'claude'));
  candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  return candidates;
}

// The first candidate the caller's check accepts, or null. A check that throws
// counts as a refusal.
export function findClaudeBinaryCandidate({ env, home, isExecutable }) {
  for (const candidate of claudeBinaryCandidates({ env, home })) {
    let ok = false;
    try { ok = isExecutable(candidate) === true; } catch { ok = false; }
    if (ok) return candidate;
  }
  return null;
}
