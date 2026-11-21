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
const TRANSCRIPT_TURNS = 12;
const TURN_MAX = 600;
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
export function candidateTagPrompt({ text, transcript = [], role = '', company = '' } = {}) {
  const lines = (Array.isArray(transcript) ? transcript : [])
    .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim() && !entry.acknowledgement)
    .slice(-TRANSCRIPT_TURNS)
    .map(entry => `${entry.speaker === 'candidate' ? 'Candidate' : 'Interviewer'}: ${clip(wordsOf(entry.text), TURN_MAX)}`);
  const sentences = splitSentences(String(text ?? '').trim()).map((sentence, index) => `${index + 1}. ${sentence.trim()}`);
  return [
    `A job candidate is answering out loud in a live video interview${role ? ` for ${role}` : ''}${company ? ` at ${company}` : ''}. Their next line is below, split into numbered sentences. It will be performed by an expressive text-to-speech voice.`,
    'Choose delivery tags so it sounds like a prepared, confident, likeable candidate speaking naturally on a call, not someone reading aloud. You only name the tags; the line itself is never re-typed.',
    '',
    'Rules:',
    '- A tag is a short, plain, lower-case description of how the voice sounds, in square brackets, for example [warmly], [engaged], [thoughtful], [confident], [matter-of-fact], [brightening], [earnest], [light laugh], [slightly slower]. Write the one each moment calls for. It is placed right before the sentence you number.',
    '- Choose them from what the line says and where the conversation is: friendly for small talk, steady and confident for an experience story, a lift for a result they are proud of, thoughtful for a hard question, a light laugh only when something is actually funny.',
    '- Most sentences need no tag. Usually one or two tags in the whole line, at most one per sentence. A very short line often needs none.',
    '- Keep every sound professional: never a sigh, groan, gasp or yawn. Describe only the voice, never an action, a gesture or a sound effect.',
    '- Output one tagged sentence per line, as the sentence number, a colon and the tag, for example "1: [warmly]". Nothing else: no sentence text, no explanation. If no sentence needs a tag, output "none".',
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
  const line = String(original ?? '').trim();
  const sentences = splitSentences(line);
  const tags = new Map();
  for (const row of String(reply ?? '').split('\n')) {
    const found = row.match(/^\W*(\d{1,3})\s*[.:)\-–]\s*(\[[^[\]\n]{1,80}\])/u);
    if (!found) continue;
    const index = Number(found[1]) - 1;
    const tag = found[2].replace(/\s+/gu, ' ');
    if (index >= 0 && index < sentences.length && !tags.has(index)) tags.set(index, tag);
  }
  if (!tags.size) return null;
  return sentences.map((sentence, index) => {
    const tag = tags.get(index);
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
  if (!line || typeof tagText !== 'function') return { text: line, tagged: false };
  const controller = new AbortController();
  const stop = () => { try { controller.abort(); } catch { /* already stopped */ } };
  if (signal?.aborted) return { text: line, tagged: false };
  signal?.addEventListener?.('abort', stop, { once: true });
  let timer = null;
  try {
    const timeout = new Promise(resolve => { timer = clock.setTimeout(() => { stop(); resolve(null); }, timeoutMs); });
    const reply = await Promise.race([
      Promise.resolve(tagText({ prompt: candidateTagPrompt({ text: line, transcript, role: brief?.role, company: brief?.company }), signal: controller.signal })).catch(() => null),
      timeout,
    ]);
    const tagged = applyTags(line, typeof reply === 'string' ? reply : reply?.text);
    return tagged ? { text: tagged, tagged: true } : { text: line, tagged: false };
  } finally {
    try { if (timer !== null) clock.clearTimeout(timer); } catch { /* fired */ }
    signal?.removeEventListener?.('abort', stop);
  }
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
  return Object.freeze({
    open({ utteranceId, text, signal } = {}) {
      const chosen = pick();
      if (!chosen) throw new Error('No candidate voice is available.');
      const stream = chosen.factory.open({ utteranceId, signal });
      const started = typeof clock.now === 'function' ? clock.now() : Date.now();
      const done = (async () => {
        const { transcript, brief } = attemptValue(context) || {};
        const tagged = await tagCandidateLine({ tagText, text, transcript, brief, signal, clock });
        attemptValue(() => onEvent({ type: 'candidate-voice', gender: chosen.gender, tagged: tagged.tagged, tagMs: Math.round((typeof clock.now === 'function' ? clock.now() : Date.now()) - started), chars: tagged.text.length }));
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

function attemptValue(fn) {
  try { return typeof fn === 'function' ? fn() : fn; } catch { return undefined; }
}
