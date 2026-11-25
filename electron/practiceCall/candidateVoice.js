/**
 * The candidate's own voice on a practice call. A message the candidate sends in the call chat is
 * spoken on the call in a voice of its own, so the interviewer hears an answer instead of reading one.
 *
 * Each line goes through the same pipeline as an interviewer's: delivery tags in square brackets
 * (written here by one short Claude call from the line and the conversation so far), then the
 * ElevenLabs dialogue voice with the interviewers' model. The tags only shape the sound: the call
 * names a tag for a numbered sentence and the code inserts it, so the words sent are always exactly
 * the words the candidate wrote, and a tagging call that fails, runs late or says nothing usable
 * leaves the line to be spoken plain.
 *
 * Two voices are drawn for every call, one female and one male; the app setting picks which one
 * speaks, read for every line so a change applies at once.
 *
 * Stage `practice-call-candidate-voice` (careerWritingCore.js): Sonnet at low effort, chosen by
 * analogy with practice-call-draft-answer and not measured. The interviewer waits on it, so speed
 * matters most, and a wrong tag costs little.
 */

export const CANDIDATE_VOICE_STAGE = 'practice-call-candidate-voice';
export const CANDIDATE_VOICE_GENDERS = Object.freeze(['female', 'male']);
export const DEFAULT_CANDIDATE_VOICE_GENDER = 'male';
// The interviewer is waiting for the line: tags that are not back by then are not worth the wait.
export const TAG_TIMEOUT_MS = 4000;
// Lines tagged ahead (the steps of a worked exercise) go in one call, and nobody waits on it until a line opens, so it
// may take longer; each line still waits at most TAG_TIMEOUT_MS from its own start.
export const PREPARE_TIMEOUT_MS = 15000;
// A line this short (a goodbye, a thank-you) is said as written: a call for tags would hold it longer than it takes to say.
const UNTAGGED_WORDS = 10;
const TRANSCRIPT_TURNS = 12;
const TURN_MAX = 600;
const REPLY_LOGGED_MAX = 400;
const TAG = /\[[^[\]\n]{1,80}\]/gu;

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

export const normalizeCandidateVoiceGender = value => (CANDIDATE_VOICE_GENDERS.includes(value) ? value : DEFAULT_CANDIDATE_VOICE_GENDER);

/** Words only: tags removed, white space squeezed. Two lines with the same words compare equal. */
export const wordsOf = value => String(value ?? '').replace(TAG, ' ').replace(/\s+/gu, ' ').trim();

/**
 * The line cut into sentences, each keeping its own text exactly (punctuation and the white space
 * that follows it), so the pieces joined again are the original line. Done in code so the model
 * never has to re-type the line: its output, and so the click-to-sound wait, no longer grows with length.
 */
export function splitSentences(line) {
  const value = String(line ?? '');
  // A sentence ends at . ! ? or … (with any closing quote or bracket) only when white space or the
  // end of the line follows, so "2.9 amps" and "e.g.a" stay in one piece and a tag never lands
  // inside a number. An abbreviation followed by a space still splits, which only moves a tag.
  const pieces = [];
  let from = 0;
  for (const match of value.matchAll(/[.!?…]+["'”’)\]]*(?=\s|$)\s*/gu)) {
    const end = match.index + match[0].length;
    pieces.push(value.slice(from, end));
    from = end;
  }
  if (from < value.length) pieces.push(value.slice(from));
  return pieces.filter(piece => piece.trim());
}

/** The prompt for the tagging call: the numbered sentences in, the tags to insert out. */
export function candidateTagPrompt({ text, sentences: given = null, transcript = [], role = '', company = '' } = {}) {
  const lines = (Array.isArray(transcript) ? transcript : [])
    .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim() && !entry.acknowledgement)
    .slice(-TRANSCRIPT_TURNS)
    .map(entry => `${entry.speaker === 'candidate' ? 'Candidate' : 'Interviewer'}: ${clip(wordsOf(entry.text), TURN_MAX)}`);
  // Several lines tagged together (said one after another, with code typed between them) are numbered straight through.
  const sentences = (Array.isArray(given) ? given : splitSentences(String(text ?? '').trim())).map((sentence, index) => `${index + 1}. ${String(sentence).trim()}`);
  return [
    `A job candidate is answering out loud in a live video interview${role ? ` for ${role}` : ''}${company ? ` at ${company}` : ''}. ${Array.isArray(given) ? 'What they say next, in a few lines said one after another while they work, is below' : 'Their next line is below'}, split into numbered sentences. It will be performed by an expressive text-to-speech voice.`,
    'Choose delivery tags so it sounds like a prepared, confident, likeable candidate speaking naturally on a call, not someone reading aloud. You only name the tags; the line itself is never re-typed.',
    '',
    'Rules:',
    // No sample tags here: a sample is copied. Every tag in the call of 2026-11-23 was one the prompt had listed.
    '- A tag is a short, plain, lower-case direction in square brackets for how the next words are said: a feeling, an energy, a pace or a small human sound. It is placed right before the sentence you number. Write your own, in your own words, for what that sentence needs.',
    '- Choose each from what the sentence says and where it sits in the conversation: what was just asked, what the candidate is describing, and how the moment would feel to the person speaking. Tags may differ from sentence to sentence and from line to line; do not settle on a favourite. A small human sound only when the moment really calls for it.',
    // The batch holds several lines, so "the whole line" read as the whole batch and left most lines plain (call of 2026-11-22).
    `- Most sentences need no tag. ${Array.isArray(given) ? 'Usually one or two tags in each line (a line of several sentences usually has one), at most one per sentence.' : 'Usually one or two tags in the whole line, at most one per sentence.'} A very short line often needs none.`,
    '- Keep every sound professional: never a sigh, groan, gasp or yawn. Describe only the voice, never an action, a gesture or a sound effect.',
    '- Output one tagged sentence per line, as <sentence number>: [<tag>], the number, a colon and the tag in square brackets. Nothing else: no sentence text, no explanation. If no sentence needs a tag, output "none".',
    '',
    '<conversation-so-far>',
    lines.length ? lines.join('\n') : '(nothing yet)',
    '</conversation-so-far>',
    '',
    '<line>',
    sentences.join('\n'),
    '</line>',
  ].join('\n');
}

/**
 * The line with the model's tags inserted, or null when there are none to insert. The reply is read
 * leniently: each "<number>: [tag]" line names a sentence; anything malformed or out of range is
 * ignored, and only the first tag for a sentence counts. The words of the line are never touched,
 * so there is nothing to check afterwards.
 */
export function applyTags(original, reply) {
  const sentences = splitSentences(String(original ?? '').trim());
  return insertTags(sentences, parseTags(reply, sentences.length));
}

/** The reply's tags by sentence index (0-based), read leniently as applyTags describes. */
function parseTags(reply, count) {
  const tags = new Map();
  for (const row of String(reply ?? '').split('\n')) {
    const found = row.match(/^\W*(\d{1,3})\s*[.:)\-–]\s*(\[[^[\]\n]{1,80}\])/u);
    if (!found) continue;
    const index = Number(found[1]) - 1;
    const tag = found[2].replace(/\s+/gu, ' ');
    if (index >= 0 && index < count && !tags.has(index)) tags.set(index, tag);
  }
  return tags;
}

/** The sentences joined again with the tags put in, or null when none lands on them. `offset` is the first sentence's index. */
function insertTags(sentences, tags, offset = 0) {
  if (!sentences.some((_, index) => tags.has(offset + index))) return null;
  return sentences.map((sentence, index) => {
    const tag = tags.get(offset + index);
    if (!tag) return sentence;
    const lead = sentence.match(/^\s*/u)[0];
    return `${lead}${tag} ${sentence.slice(lead.length)}`;
  }).join('').trim();
}

/**
 * Tags for one line, or the line as written. Never throws: tags are an improvement, never a
 * reason to keep the interviewer waiting or to lose the line.
 */
export async function tagCandidateLine({ tagText, text, transcript, brief, signal, clock = globalThis, timeoutMs = TAG_TIMEOUT_MS } = {}) {
  const line = String(text ?? '').trim();
  if (!line || typeof tagText !== 'function') return { text: line, tagged: false, tags: 0 };
  const controller = new AbortController();
  const stop = () => { try { controller.abort(); } catch { /* already stopped */ } };
  if (signal?.aborted) return { text: line, tagged: false, tags: 0 };
  signal?.addEventListener?.('abort', stop, { once: true });
  let timer = null;
  try {
    const timeout = new Promise(resolve => { timer = clock.setTimeout(() => { stop(); resolve(null); }, timeoutMs); });
    const reply = await Promise.race([
      Promise.resolve(tagText({ prompt: candidateTagPrompt({ text: line, transcript, role: brief?.role, company: brief?.company }), signal: controller.signal })).catch(() => null),
      timeout,
    ]);
    const sentences = splitSentences(line);
    const tags = parseTags(typeof reply === 'string' ? reply : reply?.text, sentences.length);
    const tagged = insertTags(sentences, tags);
    return tagged ? { text: tagged, tagged: true, tags: tags.size } : { text: line, tagged: false, tags: 0 };
  } finally {
    try { if (timer !== null) clock.clearTimeout(timer); } catch { /* fired */ }
    signal?.removeEventListener?.('abort', stop);
  }
}

/**
 * Tags for several lines said one after another, in one call: one result per line, in order, each the line as written
 * when the call fails, runs past `timeoutMs` or tags none of its sentences. Heard 2026-11-22: the seven steps of a
 * worked exercise went out as seven calls at once, and every one of them ran past the 4 s limit.
 */
export async function tagCandidateLines({ tagText, texts = [], transcript, brief, clock = globalThis, timeoutMs = PREPARE_TIMEOUT_MS } = {}) {
  const lines = (Array.isArray(texts) ? texts : []).map(value => String(value ?? '').trim());
  // `reply` is the model's answer (clipped) or null when there was none: a failed or late call, told apart in the log
  // from a reply that tagged nothing.
  const plain = () => lines.map(text => ({ text, tagged: false, tags: 0, reply: null }));
  const split = lines.map(line => splitSentences(line));
  const all = split.flat();
  if (!all.length || typeof tagText !== 'function') return plain();
  const controller = new AbortController();
  let timer = null;
  try {
    const timeout = new Promise(resolve => { timer = clock.setTimeout(() => { try { controller.abort(); } catch { /* stopped */ } resolve(null); }, timeoutMs); });
    const reply = await Promise.race([
      Promise.resolve(tagText({ prompt: candidateTagPrompt({ sentences: all, transcript, role: brief?.role, company: brief?.company }), signal: controller.signal })).catch(() => null),
      timeout,
    ]);
    const replyText = typeof reply === 'string' ? reply : reply?.text;
    const tags = parseTags(replyText, all.length);
    const shown = typeof replyText === 'string' ? clip(replyText, REPLY_LOGGED_MAX) : null;
    let offset = 0;
    return lines.map((text, index) => {
      const tagged = insertTags(split[index], tags, offset);
      const landed = split[index].filter((_, at) => tags.has(offset + at)).length;
      offset += split[index].length;
      return tagged ? { text: tagged, tagged: true, tags: landed, reply: shown } : { text, tagged: false, tags: 0, reply: shown };
    });
  } catch {
    return plain();
  } finally {
    try { if (timer !== null) clock.clearTimeout(timer); } catch { /* fired */ }
  }
}

/** The prepared result, or the line as written when it is not back within `ms` (the line is not held up longer). */
function within(promise, ms, fallback, clock) {
  let timer = null;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise(resolve => { timer = clock.setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => { try { if (timer !== null) clock.clearTimeout(timer); } catch { /* fired */ } });
}

/**
 * The engine's candidate voice. `factories` holds a dialogue voice factory per gender (either may
 * be missing); `gender()` reads the setting. `open({ utteranceId, text, signal })` returns a stream
 * with `sampleRate`, `onAudio`, `onWords`, `cancel` and `done` (settles when the voice has sent
 * all its audio; rejects when it failed). Returns null when no voice can speak.
 */
export function createCandidateVoice({ factories = {}, gender = () => DEFAULT_CANDIDATE_VOICE_GENDER, tagText = null, context = () => ({}), clock = globalThis, onEvent = () => {} } = {}) {
  const pick = () => {
    const wanted = normalizeCandidateVoiceGender(attemptValue(gender));
    if (factories[wanted]) return { factory: factories[wanted], gender: wanted };
    const other = CANDIDATE_VOICE_GENDERS.find(item => item !== wanted && factories[item]);
    return other ? { factory: factories[other], gender: other } : null;
  };
  if (!pick()) return null;
  // Heard 2026-11-22: tagging a line takes about 2 s and only began when the line opened, so the steps of a worked
  // exercise had a 2.4 s silence between them. Lines known ahead are tagged ahead (`prepare`), and `open` takes the
  // result for the same words; a line nobody prepared is tagged as before.
  const prepared = new Map();
  const isShort = key => key.split(' ').length <= UNTAGGED_WORDS;
  const keyOf = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  return Object.freeze({
    prepare(texts = []) {
      const keys = [...new Set((Array.isArray(texts) ? texts : [texts]).map(keyOf).filter(key => key && !prepared.has(key)))];
      // A short line on its own needs no tags (as in `open`); among others it costs nothing.
      if (keys.length === 1 && isShort(keys[0])) return;
      if (!keys.length) return;
      const { transcript, brief } = attemptValue(context) || {};
      // One call for all of them (see tagCandidateLines), shared by each line's entry.
      const batch = tagCandidateLines({ tagText, texts: keys, transcript, brief, clock }).catch(() => keys.map(text => ({ text, tagged: false, tags: 0, reply: null })));
      keys.forEach((key, index) => prepared.set(key, batch.then(results => results[index] ?? { text: key, tagged: false, tags: 0, reply: null })));
      while (prepared.size > PREPARED_MAX) prepared.delete(prepared.keys().next().value);
    },
    open({ utteranceId, text, signal } = {}) {
      const chosen = pick();
      if (!chosen) throw new Error('No candidate voice is available.');
      const stream = chosen.factory.open({ utteranceId, signal });
      const started = typeof clock.now === 'function' ? clock.now() : Date.now();
      const key = keyOf(text);
      const ready = prepared.get(key);
      if (ready) prepared.delete(key);
      const done = (async () => {
        const { transcript, brief } = attemptValue(context) || {};
        const tagged = ready
          ? await within(ready, TAG_TIMEOUT_MS, { text: String(text ?? '').trim(), tagged: false, tags: 0, reply: null }, clock)
          : await tagCandidateLine({ tagText: isShort(key) ? null : tagText, text, transcript, brief, signal, clock });
        attemptValue(() => onEvent({ type: 'candidate-voice', gender: chosen.gender, tagged: tagged.tagged, tags: tagged.tags ?? 0, prepared: Boolean(ready), ...(ready ? { reply: tagged.reply ?? null } : {}), tagMs: Math.round((typeof clock.now === 'function' ? clock.now() : Date.now()) - started), chars: tagged.text.length }));
        if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        stream.sendText(tagged.text);
        return stream.finish();
      })();
      // A rejection nobody awaited yet must not surface as unhandled.
      done.catch(() => {});
      return {
        sampleRate: stream.sampleRate,
        onAudio: listener => stream.onAudio(listener),
        onWords: listener => stream.onWords(listener),
        cancel: () => { try { stream.cancel(); } catch { /* already closed */ } },
        done,
        gender: chosen.gender,
      };
    },
  });
}

/** Lines tagged ahead and not yet spoken that are kept; the oldest go first. */
const PREPARED_MAX = 20;

function attemptValue(fn) {
  try { return typeof fn === 'function' ? fn() : fn; } catch { return undefined; }
}
