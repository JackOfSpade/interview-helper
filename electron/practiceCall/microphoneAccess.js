import { execFile as nodeExecFile } from 'node:child_process';

export const MICROPHONE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const RESET_TIMEOUT_MS = 5000;
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,155}$/u;

/**
 * Microphone permission for practice calls. macOS shows its permission prompt
 * only while no answer is stored, so an earlier "Don't Allow" is cleared first
 * (for the given bundle ids only) and the prompt is shown again on every call
 * that still lacks access. Every dependency defaults to off: with none passed
 * in, nothing is asked, reset or opened.
 */
export function createMicrophoneAccess({
  systemPreferences = null,
  shell = null,
  execFile = nodeExecFile,
  platform = process.platform,
  bundleIds = [],
} = {}) {
  const ids = bundleIds.filter(id => typeof id === 'string' && BUNDLE_ID.test(id));
  const usable = platform === 'darwin' && typeof systemPreferences?.getMediaAccessStatus === 'function';
  const status = () => { try { return systemPreferences.getMediaAccessStatus('microphone'); } catch { return 'unknown'; } };
  const reset = id => new Promise(resolve => {
    try { execFile('/usr/bin/tccutil', ['reset', 'Microphone', id], { timeout: RESET_TIMEOUT_MS }, () => resolve()); } catch { resolve(); }
  });
  let pending = null;

  /** Resolves to 'granted', 'denied', 'restricted' or 'unknown'. Never rejects. */
  async function ensure() {
    if (!usable) return 'unknown';
    const before = status();
    if (before === 'granted' || before === 'restricted') return before;
    if (before === 'denied') for (const id of ids) await reset(id);
    if (typeof systemPreferences.askForMediaAccess !== 'function') return status();
    try { return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'; } catch { return 'denied'; }
  }

  return Object.freeze({
    // One prompt at a time: a second caller waits for the answer to the first.
    ensure() {
      pending ??= ensure().finally(() => { pending = null; });
      return pending;
    },
    async openSettings() {
      if (platform !== 'darwin' || typeof shell?.openExternal !== 'function') return false;
      try { await shell.openExternal(MICROPHONE_SETTINGS_URL); return true; } catch { return false; }
    },
  });
}
