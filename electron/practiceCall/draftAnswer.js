/**
 * A testing aid: writes the candidate's reply to the interviewer's latest question, for the call
 * chat's "Suggest a reply" button. The reply is put in the chat box and never sent on its own.
 *
 * It only has to be believable enough to move the interview on, so nothing checks it against the
 * career text: the prompt tells the model to stay in character and make up plausible detail the
 * documents do not cover (a reply that said "my documents don't give me a reason" broke the call). Stage `practice-call-draft-answer` (careerWritingCore.js): Sonnet at low effort.
 * Chosen by reasoning, not measured: the person waits on it mid-call, so speed matters most, and
 * accuracy is not checked; Sonnet low already writes the call's spoken acknowledgements without
 * leaking content, and Haiku is the setting that drops supplied detail elsewhere in this app.
 */
export const DRAFT_ANSWER_STAGE = 'practice-call-draft-answer';
// Hard backstop only (about 180 words): the prompt sets the real length. Audited call: follow-ups came back at 140 to 210 words and were cut in on.
export const DRAFT_ANSWER_MAX_CHARS = 1100;
// How much of each source the prompt carries. The career text is the one that matters most.
const CAREER_MAX = 24000;
const LISTING_MAX = 12000;
const TRANSCRIPT_TURNS = 40;
const TURN_MAX = 1500;
const POOL_MAX = 30;
const PAD_MAX = 4000;
const SCREEN_MAX = 8000;
const SVG_MAX = 12000;

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};
const list = values => (Array.isArray(values) ? values : []).filter(item => typeof item === 'string' && item.trim());

/**
 * The conversation so far, oldest first, as the candidate would remember it. `participants`
 * ({ id, name } each) names who said what: on a panel each line, and each part of a reply two of
 * them shared, carries that interviewer's name; a line with no speaker id is the lead's.
 */
export function transcriptLines(transcript, { interviewerName = 'Interviewer', participants = [] } = {}) {
  const names = new Map((Array.isArray(participants) ? participants : [])
    .filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim())
    .map(item => [item.id, clip(item.name, 80)]));
  const lead = (Array.isArray(participants) && typeof participants[0]?.name === 'string' && participants[0].name.trim()) ? clip(participants[0].name, 80) : interviewerName;
  const nameOf = id => (typeof id === 'string' && names.get(id)) || lead;
  const entries = (Array.isArray(transcript) ? transcript : [])
    .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim() && !entry.acknowledgement);
  return entries.slice(-TRANSCRIPT_TURNS).map(entry => {
    // A sent message the candidate's voice spoke on the call was heard, not read.
    const how = entry.channel === 'chat' && !entry.voiced ? ' (typed in chat)' : '';
    if (entry.speaker === 'candidate') return `Candidate${how}: ${clip(entry.text, TURN_MAX)}`;
    const parts = Array.isArray(entry.segments) ? entry.segments.filter(item => item && typeof item.text === 'string' && item.text.trim()) : [];
    if (parts.length > 1) return parts.map(item => `${nameOf(item.speakerId)}${how}: ${clip(item.text, TURN_MAX)}`).join('\n');
    return `${nameOf(entry.speakerId)}${how}: ${clip(entry.text, TURN_MAX)}`;
  });
}

/**
 * The prompt. `context` holds what the call already has: the brief (company, role, summary,
 * themes), the listing text, the career text, the submitted résumé and cover letter, the
 * candidate's name, the transcript with the interviewers' names, the open pad and the prepared
 * questions with their answers.
 */
/** What the call already has, as the prompt sections both drafts carry (role, listing, documents, screen, pad, conversation). */
function sourceSections(context = {}) {
  const brief = context.brief || {};
  const lines = transcriptLines(context.transcript, { interviewerName: 'Interviewer', participants: context.participants });
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
  const shownVisual = context.screen?.visual;
  const visualLines = shownVisual && typeof shownVisual.description === 'string' && shownVisual.description.trim()
    ? `\n${shownVisual.kind === 'diagram' ? 'Diagram above the text' : 'Picture above the text (attached)'}: ${clip(shownVisual.description, 400)}${shownVisual.kind === 'diagram' && shownVisual.svg ? `\nThe diagram itself (SVG):\n${clip(shownVisual.svg, SVG_MAX)}` : ''}` : '';
  const screen = context.screen && typeof context.screen.content === 'string' && context.screen.content.trim()
    ? `${context.screen.title ? `Title: ${clip(context.screen.title, 200)}\n` : ''}${clip(context.screen.content, SCREEN_MAX)}${visualLines}` : '';
  const section = (title, body) => (body ? `\n<${title}>\n${body}\n</${title}>\n` : '');
  return [
    section('role', [brief.company && `Company: ${brief.company}`, brief.role && `Role: ${brief.role}`, brief.location && `Location: ${brief.location}`, brief.roleSummary && `Summary: ${brief.roleSummary}`, ...list(brief.roleThemes).map(theme => `Theme: ${theme}`), ...list(brief.companyFacts).slice(0, 8).map(fact => `Company fact: ${fact}`)].filter(Boolean).join('\n')),
    section('job-listing', listing),
    section('career-documents', career),
    section('submitted-resume', resume && resume !== career ? resume : ''),
    section('submitted-cover-letter', coverLetter),
    section('prepared-answers (your own notes; take the idea from one when it fits, in a few sentences, never the whole thing)', pool.join('\n\n')),
    section(context.screen?.current === false ? 'screen-the-interviewer-shared-earlier' : 'interviewer-shared-screen', screen),
    section('shared-pad', pad),
    section('conversation-so-far', lines.length ? lines.join('\n') : '(nothing has been said yet)'),
  ];
}

export function draftAnswerPrompt(context = {}) {
  const brief = context.brief || {};
  const name = String(context.candidateName || '').trim();
  return [
    `You are ${name || 'the candidate'}, a job candidate in a live video interview for ${brief.role || 'the role'}${brief.company ? ` at ${brief.company}` : ''}.`,
    'Write what you would say out loud right now, answering what the interviewer most recently asked or said. It is spoken on the call in your voice, word for word, so write it to be heard, not read.',
    '',
    'How to write it:',
    '- First person, as yourself, in natural spoken English: the way a prepared, confident candidate answers out loud. No headings, lists, markdown, quotation marks around the whole reply, or sign-off.',
    '- Every sentence is one a person would actually say. Never open a sentence with a label and a colon the way notes or slides do ("Short version: I was wrong", "Leading explanation: the meter", "What\'s changed: the current fell", "To the ground:"); say it as speech instead ("The short version is that I was wrong", "My leading explanation is the meter", "What\'s changed is that the current fell", "and to the ground I\'d say"). The same goes for a dash or semicolon used to stitch notes together. One flowing reply, no paragraph breaks.',
    '- Say numbers and units the way people say them aloud when it reads oddly otherwise ("about 170 kilograms an hour", "two point nine amps").',
    '- Stay in character the whole time. You are this person speaking from memory, not an assistant reading files: never mention documents, notes, a résumé as a source, a prompt, being an AI, or what you can or cannot say, and never hedge or refuse because something is not written down.',
    '- Build on the career documents below: they are your history, so use their employers, projects, tools and results. Where they do not cover what was asked (why you left a job, a specific story, a number, an opinion, a hobby), make up plausible, specific details that fit them, one or two, not a list. This reply is for rehearsing the interview, so sounding like a real, well-prepared candidate matters more than sticking to what is written.',
    '- Keep anything you make up consistent with the documents (do not contradict their employers, titles or dates) and with what you have already said in the conversation.',
    '- Answer the question that was asked, directly, the way a strong candidate would.',
    '- Fit the length to what was asked, the way a real candidate on a call does, and stop once it is answered. A greeting or small talk gets one or two sentences. A behavioural or experience question, or a request to talk them through a plan, gets a story (situation, what you did, the result) in about 80 to 180 words. A technical question gets a clear, direct explanation that leads with the answer, in about 60 to 130 words: answer only the part or bullet being asked about now (a later bullet on the screen waits until they get to it), give results rather than every intermediate step, and say a matrix, table or long calculation the way a person would on a call (the key entries or the final value, and what it means), never reading it out element by element; the interviewer will ask for more if they want it. A yes/no or one-fact question (a qualification, a number, a tool, a date, "did you ever") is answered in the first sentence, with a sentence or two of context at most and no story, usually 15 to 40 words. A follow-up or clarifying question ("why", "how do you know", "what would change your mind") gets the answer first and the reason after, usually 25 to 60 words, without starting a new story unless one was asked for or re-telling what was already said. A question put in the middle of a live scenario ("what do you say", "what do you do") gets the decision or the words you would actually say first, then at most a line of why; the interviewer can ask for more, and a long answer is cut in on. Judge each question by what a real person would take the time to say on a call; the ranges are a guide, not a target to fill. When the interviewer says "briefly", "quick one", "in a sentence" or that time is short, keep it to a sentence or two. Never more than 250 words.',
    '- If the interviewer asked you to write code or work in the shared pad, describe your approach briefly; the pad text, if any, is below.',
    '- The interviewer may be sharing their screen (a problem, a diagram, data, a timeline); its text is below. You can see it, so work from it directly: use its actual numbers, names and details, and never say you cannot see it or ask them to share or paste it. Read all of it, picture or diagram included, before you answer. If it contradicts itself or what was just said, you notice, as a careful candidate would, and deal with it however suits the moment: ask which is current, say which version you are working from, or point it out in passing.',
    '- If the last thing said is not a question (for example, they are wrapping up or asking if you have questions), reply as a candidate naturally would, using the listing and company to ask one good question when that fits.',
    '- Output only the reply text, nothing before or after it.',
    ...sourceSections(context),
    'Your reply:',
  ].join('\n');
}

/** Tidies a model reply into chat text: no wrapping quotes or label, at most the chat's limit. */
export function cleanDraft(text) {
  let value = String(text ?? '').trim();
  value = value.replace(/^(?:your reply|reply|candidate|answer)\s*:\s*/iu, '').trim();
  if (value.length > 1 && /^["“]/u.test(value) && /["”]$/u.test(value)) value = value.slice(1, -1).trim();
  // It is spoken as one flowing reply: measured 2026-11-21, the prompt alone left paragraph breaks in 39 of 52 replies.
  value = value.replace(/\s*\n+\s*/gu, ' ').trim();
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
  // A picture on the shared screen goes with the prompt, so the reply can work from what it shows.
  const image = context.screen?.image && typeof context.screen.image.data === 'string' ? [context.screen.image] : null;
  const reply = await callText({ prompt: draftAnswerPrompt(context), signal, ...(image ? { pageImages: image } : {}) });
  const text = cleanDraft(typeof reply === 'string' ? reply : reply?.text);
  if (!text) throw new Error('The drafted answer was empty.');
  return text;
}

// ---- working through an exercise in the coding pad ----------------------------------------------------------------
// When the pad is open the wand does not just talk about the code: it writes it, the way a strong candidate does in a
// live coding interview. The reply is a short sequence of steps, each a line said out loud and then the pad as it
// should read after that step; the window says each line in the candidate's voice and types the code into the pad at
// a person's pace. Stage `practice-call-draft-work` (careerWritingCore.js).

export const DRAFT_WORK_STAGE = 'practice-call-draft-work';
export const DRAFT_WORK_MAX_STEPS = 10;
const SAY_MAX = 700;
const WORK_PAD_MAX = 20000;

/** The JSON schema the work reply must follow. */
export const DRAFT_WORK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['steps'],
  properties: {
    steps: {
      type: 'array', minItems: 1, maxItems: DRAFT_WORK_MAX_STEPS,
      items: {
        type: 'object', additionalProperties: false, required: ['say', 'code', 'typeWhileSpeaking'],
        properties: {
          say: { type: 'string', description: 'What you say out loud at this step, spoken word for word.' },
          code: { type: ['string', 'null'], description: 'The whole coding pad as it reads after this step, or null to leave it as it is.' },
          typeWhileSpeaking: { type: 'boolean', description: 'true to type this step\'s code while saying the line, false to say the line first and then type.' },
        },
      },
    },
  },
});

/** The prompt for working through the exercise: the reply prompt's sources, with the work rules in place of its last lines. */
export function draftWorkPrompt(context = {}) {
  // Everything the reply prompt knows (role, documents, screen, conversation); the pad goes in on its own, below.
  const sources = sourceSections({ ...context, pad: { open: false } });
  const name = String(context.candidateName || '').trim();
  const brief = context.brief || {};
  const lang = String(context.pad?.lang || '').trim();
  const padText = typeof context.pad?.text === 'string' ? context.pad.text.slice(0, WORK_PAD_MAX) : '';
  return [
    `You are ${name || 'the candidate'}, a strong candidate in a live video interview for ${brief.role || 'the role'}${brief.company ? ` at ${brief.company}` : ''}. The interviewers have shared an exercise and opened a coding pad${lang ? ` (${lang})` : ''} that you write in while they watch.`,
    'Show what an excellent answer to this exercise looks like, done live. Write it as a short sequence of steps. Each step is a line you say out loud, then the whole coding pad as it should read after you have typed that step (or null when that step changes nothing in the pad). Your words are spoken on the call in your voice and the code is typed into the pad at a person\'s pace after each line, so the interviewers hear you and watch you write.',
    '',
    'How a strong candidate works through it:',
    '- Start where things stand now: read the conversation and the pad below. If an interviewer has just asked you something (a question, a hint, a bug they spotted), the first step answers that briefly and naturally, then you carry on from the code already in the pad (fix it, or continue it), never starting over without a reason. If the code is finished and you already said so, answer what was asked in one step with code null.',
    '- Starting fresh: the first step restates the task in a sentence in your own words, states any assumption you are making (as a statement, never a question you would wait on: "I\'ll assume the arrays are the same length"), and gives the approach in plain English with its cost when that matters. Its code may be just the function signature, or null.',
    '- For each step choose how the line and the typing go together, the way a person does at that moment: say it first and then type (typeWhileSpeaking false), usually for a new idea or a choice worth explaining before you commit to it; or type while you talk (typeWhileSpeaking true), usually for straightforward code you are describing as your hands write it. Mix them as a real candidate would; neither is the rule.',
    '- Then write the code in a few small, logical pieces, one per step (usually two to four). Before each piece, say in plain English what it will do and why, at the level of intent: "First I\'ll centre the coordinates by taking off the mean, so the second moments are about the centre." Never read the code aloud or spell out syntax, symbols, brackets, variable assignments or operators ("x equals x minus mean of x", "for i in range", "open bracket"). One or two sentences per step.',
    '- The code is correct, runnable, idiomatic and small: what a careful senior engineer writes in an interview, with a short docstring or a comment only where it helps. Each step\'s code is the WHOLE pad after that step, so it repeats the earlier code and adds to it.',
    '- Then test it out loud: walk the given example through by hand with its actual numbers, said the way people say numbers, and give the result with its units. If the exercise asks for a hand calculation or a value, this is where you give it, worked briefly. Mention an edge case your code handles or that you would check, in a sentence. A step that only talks has code null.',
    '- Finish by saying plainly, in your own words, that you are done and inviting their questions ("I think that\'s it. Happy to go through any part of it."). This is how the interviewers know your answer is final, so say it only in the last step.',
    '- Keep every line short and spoken: no lists, headings or markdown in what you say, no paragraph breaks, and never more than about forty words in a line. Numbers and units are said as words where it reads oddly otherwise.',
    '- Answer every bullet the exercise asks, in order, and nothing it does not ask.',
    '- Stay in character: never mention documents, notes, a prompt or being an AI.',
    '- Reply with JSON only, matching the schema: {"steps":[{"say":"...","code":"..." or null,"typeWhileSpeaking":true or false}]}.',
    ...sources,
    `\n<coding-pad-now${lang ? ` lang="${lang}"` : ''}>\n${padText || '(empty)'}\n</coding-pad-now>\n`,
    'Your steps:',
  ].join('\n');
}

/** The steps as the window plays them; anything malformed is dropped. Throws when nothing usable is left. */
export function cleanWork(raw) {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    try { value = JSON.parse(text); } catch { value = null; }
  }
  const steps = (Array.isArray(value?.steps) ? value.steps : []).slice(0, DRAFT_WORK_MAX_STEPS).map(step => {
    const say = cleanDraft(step?.say).slice(0, SAY_MAX);
    const code = typeof step?.code === 'string' ? step.code.replace(/\r\n?/gu, '\n').slice(0, WORK_PAD_MAX) : null;
    return { say, code, together: step?.typeWhileSpeaking === true && !!say && code !== null };
  }).filter(step => step.say || step.code !== null);
  if (!steps.length) throw new Error('The drafted work had no steps.');
  return steps;
}

/** One structured call. Returns the steps; throws when the call fails or gives nothing usable. */
export async function draftCandidateWork({ callText, signal, ...context } = {}) {
  if (typeof callText !== 'function') throw new Error('No text call is available to draft the work.');
  const image = context.screen?.image && typeof context.screen.image.data === 'string' ? [context.screen.image] : null;
  const reply = await callText({ prompt: draftWorkPrompt(context), schema: DRAFT_WORK_SCHEMA, signal, ...(image ? { pageImages: image } : {}) });
  return cleanWork(reply && typeof reply === 'object' && !Array.isArray(reply) && 'text' in reply && !('steps' in reply) ? reply.text : reply);
}
