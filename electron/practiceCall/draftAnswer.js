/**
 * A testing aid: writes the candidate's reply to the interviewer's latest question, for the call
 * chat's "Suggest a reply" button. The reply is put in the chat box and never sent on its own.
 *
 * It only has to be believable enough to move the interview on, so nothing checks it against the
 * career text. Stage `practice-call-draft-answer` (careerWritingCore.js): Sonnet at low effort.
 * Chosen by reasoning, not measured: the person waits on it mid-call, so speed matters most, and
 * accuracy is not checked; Sonnet low already writes the call's spoken acknowledgements without
 * leaking content, and Haiku is the setting that drops supplied detail elsewhere in this app.
 */

export const DRAFT_ANSWER_STAGE = 'practice-call-draft-answer';
export const DRAFT_ANSWER_MAX_CHARS = 2000;
// How much of each source the prompt carries. The career text is the one that matters most.
const CAREER_MAX = 24000;
const LISTING_MAX = 12000;
const TRANSCRIPT_TURNS = 40;
const TURN_MAX = 1500;
const POOL_MAX = 30;
const PAD_MAX = 4000;

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};
const list = values => (Array.isArray(values) ? values : []).filter(item => typeof item === 'string' && item.trim());

/** The conversation so far, oldest first, as the candidate would remember it. */
export function transcriptLines(transcript, { interviewerName = 'Interviewer' } = {}) {
  const entries = (Array.isArray(transcript) ? transcript : [])
    .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim() && !entry.acknowledgement);
  return entries.slice(-TRANSCRIPT_TURNS).map(entry => {
    const who = entry.speaker === 'candidate' ? 'Candidate' : interviewerName;
    const how = entry.channel === 'chat' ? ' (typed in chat)' : '';
    return `${who}${how}: ${clip(entry.text, TURN_MAX)}`;
  });
}

/**
 * The prompt. `context` holds what the call already has: the brief (company, role, summary,
 * themes), the listing text, the career text, the submitted résumé and cover letter, the
 * candidate's name, the transcript, the open pad and the prepared questions with their answers.
 */
export function draftAnswerPrompt(context = {}) {
  const brief = context.brief || {};
  const name = String(context.candidateName || '').trim();
  const lines = transcriptLines(context.transcript, { interviewerName: 'Interviewer' });
  const career = clip(context.careerText, CAREER_MAX);
  const resume = clip(context.application?.resume, CAREER_MAX);
  const coverLetter = clip(context.application?.coverLetter, 6000);
  const listing = clip(context.listingText, LISTING_MAX);
  const pool = (Array.isArray(context.pool) ? context.pool : [])
    .filter(card => card && typeof card.question === 'string' && typeof card.answer === 'string' && card.answer.trim())
    .slice(0, POOL_MAX)
    .map(card => `Q: ${clip(card.question, 400)}\nA: ${clip(card.answer, 1200)}`);
  const pad = context.pad?.open && typeof context.pad.text === 'string' && context.pad.text.trim()
    ? clip(context.pad.text, PAD_MAX) : '';
  const section = (title, body) => (body ? `\n<${title}>\n${body}\n</${title}>\n` : '');
  return [
    `You are ${name || 'the candidate'}, a job candidate in a live video interview for ${brief.role || 'the role'}${brief.company ? ` at ${brief.company}` : ''}.`,
    'Write the reply you would type into the call chat right now, answering what the interviewer most recently asked or said.',
    '',
    'How to write it:',
    '- First person, as yourself, in natural spoken English: the way a prepared, confident candidate answers out loud. No headings, lists, markdown, quotation marks around the whole reply, or sign-off.',
    '- Draw on your real experience from the career documents below: name actual employers, projects, tools and results that are in them. Do not invent employers, titles, degrees or numbers.',
    '- If the documents have nothing that answers it, say so plainly and give the closest real experience instead.',
    '- Fit the length to the question: a greeting or small talk gets one or two sentences; a behavioural or experience question gets a short story (situation, what you did, the result) in about 80 to 180 words; a technical question gets a clear, direct explanation. Never more than 250 words.',
    '- If the interviewer asked you to write code or work in the shared pad, describe your approach briefly in chat; the pad text, if any, is below.',
    '- If the last thing said is not a question (for example, they are wrapping up or asking if you have questions), reply as a candidate naturally would, using the listing and company to ask one good question when that fits.',
    '- Output only the reply text, nothing before or after it.',
    section('role', [brief.company && `Company: ${brief.company}`, brief.role && `Role: ${brief.role}`, brief.location && `Location: ${brief.location}`, brief.roleSummary && `Summary: ${brief.roleSummary}`, ...list(brief.roleThemes).map(theme => `Theme: ${theme}`), ...list(brief.companyFacts).slice(0, 8).map(fact => `Company fact: ${fact}`)].filter(Boolean).join('\n')),
    section('job-listing', listing),
    section('career-documents', career),
    section('submitted-resume', resume && resume !== career ? resume : ''),
    section('submitted-cover-letter', coverLetter),
    section('prepared-answers (your own notes; use one when it fits the question, reworded as you would say it)', pool.join('\n\n')),
    section('shared-pad', pad),
    section('conversation-so-far', lines.length ? lines.join('\n') : '(nothing has been said yet)'),
    'Your reply:',
  ].join('\n');
}

/** Tidies a model reply into chat text: no wrapping quotes or label, at most the chat's limit. */
export function cleanDraft(text) {
  let value = String(text ?? '').trim();
  value = value.replace(/^(?:your reply|reply|candidate|answer)\s*:\s*/iu, '').trim();
  if (value.length > 1 && /^["“]/u.test(value) && /["”]$/u.test(value)) value = value.slice(1, -1).trim();
  if (value.length > DRAFT_ANSWER_MAX_CHARS) {
    const cut = value.slice(0, DRAFT_ANSWER_MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    value = end > DRAFT_ANSWER_MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut;
  }
  return value;
}

/** One text call. Returns the reply text; throws when the call fails or says nothing. */
export async function draftCandidateAnswer({ callText, signal, ...context } = {}) {
  if (typeof callText !== 'function') throw new Error('No text call is available to draft an answer.');
  const reply = await callText({ prompt: draftAnswerPrompt(context), signal });
  const text = cleanDraft(typeof reply === 'string' ? reply : reply?.text);
  if (!text) throw new Error('The drafted answer was empty.');
  return text;
}
