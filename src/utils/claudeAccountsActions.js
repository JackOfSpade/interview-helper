import { useCallback, useEffect, useRef, useState } from 'react';

const CLAUDE_ACCOUNT_ADD_UNAVAILABLE = 'Adding Claude accounts is not available in this build.';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const emailOf = value => (typeof value === 'string' && value ? value : null);

/**
 * Pure: the one-line result of a finished addClaudeAccount call, or null when
 * there is nothing worth saying (the user cancelled).
 */
export function claudeAccountAddMessage(result) {
  if (!isObject(result)) return 'Sign-in did not finish.';
  if (result.ok === true) {
    const email = emailOf(result.account?.email);
    return email ? `Added ${email}.` : 'Added the account.';
  }
  switch (result.reason) {
    case 'cancelled': return null;
    case 'duplicate': return 'That account is already added.';
    case 'cli-missing': return 'Claude Code is not installed.';
    case 'timeout': return 'Sign-in timed out.';
    default: return emailOf(result.message) || 'Sign-in did not finish.';
  }
}

/**
 * The one add-account flow behind both the dock notice and the accounts panel:
 * click → browser sign-in (minutes) → pending line with a Cancel escape →
 * one-line result. `onAdded` refreshes whatever list the caller renders.
 */
export function useClaudeAccountAddFlow({ onAdded } = {}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const addAccount = useCallback(async () => {
    const bridge = globalThis.window?.electronAPI;
    if (!bridge?.addClaudeAccount) { setMessage(CLAUDE_ACCOUNT_ADD_UNAVAILABLE); return; }
    setMessage(null);
    setPending(true);
    let result = null;
    try { result = await bridge.addClaudeAccount(); } catch { result = { ok: false, reason: 'failed' }; }
    if (!mounted.current) return;
    setPending(false);
    setMessage(claudeAccountAddMessage(result));
    if (result?.ok === true) { try { await onAdded?.(); } catch { /* the next push refreshes the list */ } }
  }, [onAdded]);

  const cancelLogin = useCallback(async () => {
    try { await globalThis.window?.electronAPI?.cancelClaudeAccountLogin?.(); } catch { /* the add call resolves on its own */ }
  }, []);

  return { pending, message, addAccount, cancelLogin };
}
