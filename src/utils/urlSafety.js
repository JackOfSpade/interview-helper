/**
 * URL helpers for renderer-owned, potentially untrusted
 * content. Keep URL admission close to the renderer boundary: IPC validation
 * is a separate defense, but callers must not ask Electron to dispatch an
 * arbitrary scheme in the first place.
 */
function hasControlCharacter(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}

/** Returns the trimmed string form of a URL input, or '' when it is empty or has a control character. */
function cleanUrlInput(value) {
  const raw = String(value ?? '').trim();
  return !raw || hasControlCharacter(raw) ? '' : raw;
}

function toUrl(value) {
  const raw = cleanUrlInput(value);
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Returns a canonical http(s) URL suitable for Electron's external browser dispatcher. */
export function normalizeExternalHttpUrl(value) {
  const raw = cleanUrlInput(value);
  if (!raw) return '';

  // LinkNode historically accepted a bare domain. Do this only when no URI
  // scheme is present; never turn an untrusted scheme into a safe-looking URL.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const url = toUrl(candidate);
  return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
}
