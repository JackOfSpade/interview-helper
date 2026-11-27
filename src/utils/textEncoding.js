// HTML entity decoding and markup stripping for scraped text.
//
// Framework-agnostic (no DOMParser, no Node Buffer) so both `src/` and
// `electron/` can import it.

// ── HTML markup normalization ────────────────────────────────────────────────
//
// Sources that hand us text through a DOM (`innerText`/`textContent`) arrive
// already-decoded. The ones that DON'T — WeWorkRemotely (regex over raw RSS
// XML) and LinkedIn (raw `description` HTML) — leak markup and entities all the
// way into the scoring prompt, the card, and the résumé generator: confirmed in
// a live run as titles reading "Customer Support &amp; Product Demo Specialist"
// and descriptions opening with "<p> <strong>Headquarters:</strong> …". Raw tags
// are pure token waste on a paid scoring call and dilute the text the model
// reasons over, so both are normalized once at the pipeline chokepoint rather
// than per-extractor (a new source gets the fix free).

// Only the entities that actually appear in scraped listing text. A general
// named-entity table would be dead weight; numeric refs cover the long tail.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·', trade: '™',
  reg: '®', copy: '©', deg: '°', eacute: 'é', euro: '€', pound: '£', cent: '¢',
};

/**
 * Decode the HTML entities a non-DOM extraction path leaves behind. Handles
 * named refs (table above), decimal (`&#39;`) and hex (`&#x27;`) numeric refs.
 * Unknown entities are left verbatim — never guessed at, so a literal "&foo;"
 * in a job description survives intact. Pure + testable.
 */
export function decodeHtmlEntities(s) {
  if (typeof s !== 'string' || !s || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    const b = body.toLowerCase();
    if (b[0] === '#') {
      const cp = b[1] === 'x' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      // Reject non-characters/surrogates rather than emitting a replacement char.
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, b) ? NAMED_ENTITIES[b] : whole;
  });
}

/**
 * Read one HTML-like tag without treating `>` inside a quoted attribute as its
 * end. This is deliberately a small tokenizer rather than a regular-expression
 * tag filter: scraped HTML is untrusted and commonly contains quoted URLs,
 * malformed attributes, comments, and raw script/style bodies. It is also
 * framework-agnostic, so the same behavior is available in the renderer and
 * Electron's main process without a DOMParser dependency.
 */
function readHtmlTag(source, start) {
  const length = source.length;
  let i = start + 1;
  if (i >= length) return { kind: 'literal', end: length };

  // Comments and declarations have no tag name, but are still markup. An
  // unterminated comment consumes the remainder just as an HTML parser would.
  if (source.startsWith('<!--', start)) {
    const normalClose = source.indexOf('-->', start + 4);
    const bangClose = source.indexOf('--!>', start + 4);
    const close = normalClose === -1 ? bangClose
      : bangClose === -1 ? normalClose : Math.min(normalClose, bangClose);
    return { kind: 'comment', end: close === -1 ? length : close + (close === bangClose ? 4 : 3) };
  }
  if (source[i] === '!' || source[i] === '?') {
    const boundary = findHtmlTagEnd(source, i + 1);
    if (boundary.end !== -1) return { kind: 'declaration', end: boundary.end + 1 };
    return boundary.unterminatedQuote ? { kind: 'malformed', end: length } : { kind: 'literal', end: boundary.resume };
  }

  let closing = false;
  if (source[i] === '/') {
    closing = true;
    i += 1;
  }
  // A tag name must begin with a letter. This retains prose such as "x < 5"
  // and malformed literal fragments instead of silently deleting it.
  if (!isAsciiLetter(source[i])) return { kind: 'literal', end: start + 1 };
  const nameStart = i;
  i += 1;
  while (i < length && isHtmlTagNameChar(source[i])) i += 1;
  const boundary = findHtmlTagEnd(source, i);
  if (boundary.end !== -1) return { kind: 'tag', name: source.slice(nameStart, i).toLowerCase(), closing, end: boundary.end + 1 };
  // An unmatched quote means the apparent tag consumed the rest of the source
  // as an attribute value. Drop it rather than feeding an instruction-looking
  // attribute into downstream prompts. Unquoted incomplete fragments remain
  // literal text (for example, a comparison or a truncated job description).
  return boundary.unterminatedQuote ? { kind: 'malformed', end: length } : { kind: 'literal', end: boundary.resume };
}

function findHtmlTagEnd(source, start) {
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { end: i, resume: i + 1, unterminatedQuote: false };
    }
  }
  return { end: -1, resume: source.length, unterminatedQuote: quote !== null };
}

function isAsciiLetter(ch) {
  return typeof ch === 'string' && ch.length === 1
    && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'));
}

function isHtmlTagNameChar(ch) {
  return isAsciiLetter(ch) || (ch >= '0' && ch <= '9') || ch === ':' || ch === '-' || ch === '_';
}

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'section', 'article', 'blockquote']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

/**
 * Strip HTML markup from a description body, preserving its BLOCK structure as
 * newlines so the model still sees paragraph/list boundaries. Entities are
 * decoded AFTER tokenizing, so an escaped "&lt;script&gt;" in the copy stays inert
 * text rather than becoming markup.
 */
export function stripHtmlToText(s) {
  if (typeof s !== 'string' || !s) return s;
  let text = '';
  let rawTextTag = null;
  let textStart = 0;
  let foundMarkup = false;
  for (let i = 0; i < s.length;) {
    if (s[i] !== '<') { i += 1; continue; }
    const tagStart = i;
    const tag = readHtmlTag(s, i);
    if (tag.kind === 'literal') { i = tag.end; continue; }
    i = tag.end;
    if (rawTextTag) {
      if (tag.kind === 'tag' && tag.closing && tag.name === rawTextTag) {
        rawTextTag = null;
        text += ' ';
        textStart = i;
      }
      continue;
    }
    foundMarkup = true;
    text += s.slice(textStart, tagStart);
    textStart = i;
    if (tag.kind !== 'tag') {
      text += ' ';
    } else if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      rawTextTag = tag.name;
      text += ' ';
    } else if (!tag.closing && tag.name === 'li') {
      text += '\n• ';
    } else if (!tag.closing && (tag.name === 'br' || tag.name === 'hr')) {
      text += '\n';
    } else if (tag.closing && BLOCK_TAGS.has(tag.name)) {
      text += '\n';
    } else {
      text += ' ';
    }
  }
  // The no-markup path must preserve clean source byte-for-byte, including
  // surrounding whitespace; entity decoding remains the intentional exception.
  if (!foundMarkup) return decodeHtmlEntities(s);
  if (!rawTextTag) text += s.slice(textStart);
  return decodeHtmlEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
