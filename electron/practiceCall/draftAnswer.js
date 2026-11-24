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
    // The candidate's own AI-voiced line is shown as the interviewers heard it (the speech recogniser's words, sentText), which is what the conversation holds.
    if (entry.speaker === 'candidate') return `Candidate${how}: ${clip(typeof entry.sentText === 'string' && entry.sentText.trim() ? entry.sentText : entry.text, TURN_MAX)}`;
    const parts = Array.isArray(entry.segments) ? entry.segments.filter(item => item && typeof item.text === 'string' && item.text.trim()) : [];
    if (parts.length > 1) return parts.map(item => `${nameOf(item.speakerId)}${how}: ${clip(item.text, TURN_MAX)}`).join('\n');
    return `${nameOf(entry.speakerId)}${how}: ${clip(entry.text, TURN_MAX)}`;
  });
}

// Rules both prompts share, as situations and options (never a sentence to repeat: whatever is quoted gets said in every call).
// The spoken-not-notes rule: shared, since the work prompt's lines were said as stray note fragments.
const SPOKEN_NOT_NOTES = '- Every sentence is one a person would actually say, never a note or a slide: no sentence opens with a short label and a colon that names what follows (a heading for the point, a name for the result, a key and its value), no bare fragment stands in for a sentence (a cost, a property or a finding named on its own), and no dash or semicolon stitches notes together. Say the same thing as a whole spoken sentence. Mentioning cost or complexity is optional: only when it matters to the question.';
// What a real candidate keeps in mind about what they have already said and how a call flows (audited calls repeated one self-description in most replies and thanked at every hand-over).
const CONVERSATION_REALISM = [
  '- What you have already said on the call is not said again. A way of describing yourself or your background, a caveat, an assumption, a reason you suit the role or an opening habit is said once at most; your own earlier lines in the conversation below are there so you can see what is already said, and a later reply moves on to what is new.',
  '- An opening reaction to the question (praising it, calling it a good point, saying they caught something) is for when the interviewer really did catch something or ask something sharp; most replies just begin with the answer.',
  '- Thanking the interviewers for their time, or saying goodbye, happens once, when the call is actually closing. A hand-over, a new question or a new part of an exercise gets no thanks. An invitation to ask them questions is not the close: a word of thanks there is your choice, but then the closing thanks at the real goodbye are not said again in the same words or at length.',
  // Audited call call-mwttebvu: a colleague who joined and greeted the candidate got no greeting back.
  '- When someone has just greeted you, or has just joined the call and been introduced, and you have not yet answered them, your reply returns the greeting briefly before anything else, as a person would. Once only: not again in later replies.',
  '- Reading values aloud while checking or testing: an engineer names what matters (the field or quantity that changes, the result, what it means) rather than reciting every digit of every register or table entry, and says hexadecimal the way engineers say it aloud, with a long value summarised or its meaningful part named.',
  '- The size of the answer follows the size of the question and how short the interview is: a follow-up or one-fact question gets a short answer, not a presentation. So does a question whose planned minutes below are small while more of the interview is still to come (an exercise or other questions you know are ahead): the answer is sized to those minutes, spoken at about two and a half words a second, and the time left is kept for what comes next.',
  // Its own bullet: inside the long length bullet it lost to the technical range (a "quick one" at 4:56 of five minutes got 49 seconds).
  '- When the interviewer asks for something quick or brief, or in a sentence, or says it is the last question, or the call time below shows the interview is nearly over, this overrides every range and limit here: a sentence or two, and a reply that works in the pad is one short step or two.',
];
// How fast the work plays, so the words and the typing can be matched. Measured with padTypingMs on realistic code: about 5.5 characters a second
// (pauses at new lines and words, slower punctuation), and 400 ms a spoken word, so one spoken word covers about two typed characters.
const WORK_PACE = 'Real pace: your hands write code the way a person composes it, about five to six characters a second on average (a forty-character line of code takes around seven seconds; a ten-line function of about two hundred and fifty characters around forty-five), and your voice speaks about two and a half words a second (a forty-word line takes around sixteen seconds). So when typing and talking go together, each spoken word covers about two typed characters: a line of twenty-five words lasts about ten seconds, which is about fifty-five characters of code, and a hundred and ten characters of code needs a line of about fifty words.';

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
  const timing = context.timing || {};
  const clockOf = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const minutesOf = minutes => `${Math.round(minutes * 10) / 10} minute${minutes === 1 ? '' : 's'}`;
  // Each fact only when the call knows it (an unplanned question has no minutes).
  const callTime = [
    Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0 && `Time on the call so far: ${clockOf(timing.elapsedMs)}`,
    Number.isFinite(timing.plannedMs) && timing.plannedMs > 0 && `Planned length of the interview: ${clockOf(timing.plannedMs)}`,
    Number.isFinite(timing.questionMinutes) && timing.questionMinutes > 0 && `Time planned for the question being asked: ${minutesOf(timing.questionMinutes)}`,
  ].filter(Boolean).join('\n');
  return [
    section('role', [brief.company && `Company: ${brief.company}`, brief.role && `Role: ${brief.role}`, brief.location && `Location: ${brief.location}`, brief.roleSummary && `Summary: ${brief.roleSummary}`, ...list(brief.roleThemes).map(theme => `Theme: ${theme}`), ...list(brief.companyFacts).slice(0, 8).map(fact => `Company fact: ${fact}`)].filter(Boolean).join('\n')),
    section('job-listing', listing),
    section('career-documents', career),
    section('submitted-resume', resume && resume !== career ? resume : ''),
    section('submitted-cover-letter', coverLetter),
    section('prepared-answers (your own notes; take the idea from one when it fits, in a few sentences, never the whole thing)', pool.join('\n\n')),
    section(context.screen?.current === false ? 'screen-the-interviewer-shared-earlier' : 'interviewer-shared-screen', screen),
    section('shared-pad', pad),
    section('call-time (facts about the clock, not something to mention)', callTime),
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
    SPOKEN_NOT_NOTES,
    '- One flowing reply, no paragraph breaks.',
    '- Say numbers and units the way people say them aloud when it reads oddly otherwise: rounded where a person would round, with the unit spelled out as a word.',
    ...CONVERSATION_REALISM,
    '- Stay in character the whole time. You are this person speaking from memory, not an assistant reading files: never mention documents, notes, a résumé as a source, a prompt, being an AI, or what you can or cannot say, and never hedge or refuse because something is not written down.',
    '- Build on the career documents below: they are your history, so use their employers, projects, tools and results. Where they do not cover what was asked (why you left a job, a specific story, a number, an opinion, a hobby), make up plausible, specific details that fit them, one or two, not a list. A topic the documents never touch at all (a field, a kind of system or a tool they do not mention) is answered as a candidate prepared for this role would answer it, from the principles you know or a plausible adjacent project, without saying it is outside your experience or that you have not done it: frame it as how you would approach or learn it, the way a prepared candidate would, and never state that you lack it. This reply is for rehearsing the interview, so sounding like a real, well-prepared candidate matters more than sticking to what is written.',
    '- Keep anything you make up consistent with the documents (do not contradict their employers, titles or dates) and with what you have already said in the conversation.',
    '- Answer the question that was asked, directly, the way a strong candidate would.',
    '- Fit the length to what was asked, the way a real candidate on a call does, and stop once it is answered. A greeting or small talk gets one or two sentences. A behavioural or experience question, or a request to talk them through a plan, gets a story (situation, what you did, the result) in about 80 to 180 words. A technical question gets a clear, direct explanation that leads with the answer, in about 60 to 130 words: answer only the part or bullet being asked about now (a later bullet on the screen waits until they get to it), give results rather than every intermediate step, and say a matrix, table or long calculation the way a person would on a call (the key entries or the final value, and what it means), never reading it out element by element; the interviewer will ask for more if they want it. A yes/no or one-fact question (a qualification, a number, a tool, a date, "did you ever") is answered in the first sentence, with a sentence or two of context at most and no story, usually 15 to 40 words. A follow-up or clarifying question ("why", "how do you know", "what would change your mind") gets the answer first and the reason after, usually 25 to 60 words, without starting a new story unless one was asked for or re-telling what was already said. A question put in the middle of a live scenario ("what do you say", "what do you do") gets the decision or the words you would actually say first, then at most a line of why; the interviewer can ask for more, and a long answer is cut in on. Judge each question by what a real person would take the time to say on a call; the ranges are a guide, not a target to fill. Never more than 250 words.',
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
  // It is spoken, so markdown marks go and the words stay. Underscores are left alone: they are part of names
  // (object_comparison, __init__, _private).
  value = value.replace(/`+/gu, '')
    .replace(/(^|[^\p{L}\p{N}*])\*{1,3}(?=\S)([^*]*?\S)\*{1,3}(?![\p{L}\p{N}*])/gu, '$1$2')
    .trim();
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
/** When a step's line is said against the typing of its code: ahead of it, while it is typed, or once it is written. */
export const WORK_ORDERS = Object.freeze(['before', 'during', 'after']);
const SAY_MAX = 700;
const BRIDGE_MAX = 120;
const BRIDGES_MAX = 5; // bridges become lines of their own, beside the steps the reply may have
const WORK_PAD_MAX = 20000;

/** The JSON schema the work reply must follow. */
export const DRAFT_WORK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['waitForReply', 'steps'],
  properties: {
    waitForReply: { type: 'boolean', description: 'true when an interviewer has just asked you a question that only needs answering (not an instruction to change or carry on with the code) and has not yet said to carry on: your one step answers it and you then wait for them.' },
    steps: {
      type: 'array', minItems: 1, maxItems: DRAFT_WORK_MAX_STEPS,
      items: {
        type: 'object', additionalProperties: false, required: ['say', 'code', 'explain', 'bridge'],
        properties: {
          say: { type: 'string', description: 'What you say out loud at this step, spoken word for word. It is about the code this same step types, never a piece an earlier step already typed or a later step will type.' },
          code: { type: ['string', 'null'], description: 'The whole coding pad as it reads after this step, or null to leave it as it is. The pad is only added to, in order, unless you are fixing something: everything between the first and the last change is retyped.' },
          bridge: { type: ['string', 'null'], description: 'Only for an "after" step that follows a "before" step with code (two silent stretches of typing back to back): the few words you say before starting this piece, which mark that you are moving on to something new without saying what it is. null everywhere else.' },
          explain: { type: 'string', enum: [...WORK_ORDERS], description: 'When the line is said against the typing of this step\'s code. "before": say the line, then type in silence. "during": type while saying the line (the two start together and should take about as long as each other). "after": type in silence first, then say the line about what was just written.' },
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
  const required = String(context.pad?.lang || '').trim();
  // The exercise offers several languages: the candidate picked one in the pad, and that is the only one written.
  // With no language required and none offered, the choice is the writer's own, as it would be the candidate's.
  const chosen = required ? '' : String(context.pad?.choice || '').trim();
  const lang = required || chosen;
  const padText = typeof context.pad?.text === 'string' ? context.pad.text.slice(0, WORK_PAD_MAX) : '';
  const languageRule = chosen
    ? [`- The interviewers left the language to you, and you are writing in ${chosen}. Every piece of code you write is ${chosen}, whatever the screen's examples look like or any earlier step used. Say which language you are using once, in passing and in your own words, the first time you start writing code, unless you already said so in the conversation below. If the pad already holds code in another language, you switched: say so briefly and rewrite it in ${chosen}.`]
    : required ? [`- The exercise asks for ${required}: write the code in ${required}.`]
      : ['- No language is set for this exercise, so when it calls for code the language is yours to choose, and you use one language throughout. Code already in the pad settles it: carry on in that language. Otherwise a language you named in the conversation below settles it. Otherwise pick the one a strong candidate for this role would reach for, given the role and the exercise. Say which language you are using once, in passing and in your own words, the first time you start writing code, unless you already said so in the conversation below.'];
  return [
    `You are ${name || 'the candidate'}, a strong candidate in a live video interview for ${brief.role || 'the role'}${brief.company ? ` at ${brief.company}` : ''}. The interviewers have shared an exercise and opened a coding pad${lang ? ` (${lang})` : ''} that you write in while they watch.`,
    'Show what an excellent answer to this exercise looks like, done live. Write it as a short sequence of steps. Each step is a line you say out loud, the whole coding pad as it should read after you have typed that step (or null when that step changes nothing in the pad), and when you say the line against the typing. Your words are spoken on the call in your voice and the code is typed into the pad at a person\'s pace, so the interviewers hear you and watch you write.',
    '',
    'How a strong candidate works through it:',
    '- Start where things stand now: read the conversation and the pad below. If an interviewer has just put a question to you (why an approach works, its cost, what would change if, how you would test it), answer it briefly and naturally in a single step with code null, and set waitForReply true. Then stop: take your hands off the keyboard and wait for them, as a candidate does when someone cuts in mid-exercise, since they may want to follow up, push back or move on. Do not say what you will code next or announce that you are carrying on; they will tell you when to go on. If they have pointed out a bug, given a hint or asked you to change something, the first step acknowledges it briefly and then you carry on from the code already in the pad (fix it, or continue it), never starting over without a reason. If they have just confirmed your answer or told you to go ahead, pick up where you left off without re-answering. If they said you can leave the unfinished part, leave it as it is and answer only what they asked. If the code is finished and you already said so, answer what was asked in one step with code null.',
    '- When someone has just greeted you, or has just joined the call and been introduced, and you have not yet answered them, your first line returns the greeting briefly before anything else, as a person would, then goes on to the task. Once only.',
    '- Starting fresh: the first step restates the task in a sentence in your own words, states any assumption you are making (as a statement, never a question you would wait on), and gives the approach in plain English with its cost when that matters. Its code may be just the function signature, or null, and never more than about fifty characters typed in silence.',
    '- For each step that types code, choose when you explain it ("explain"), the way a person does at that moment. "before": you say what you are about to write and why, then type it without talking; usually for a new idea or a choice worth explaining before you commit to it. "during": you talk while your hands write; usually for straightforward code you are describing as it appears. "after": you go quiet and write the piece, then say what you just wrote and why; usually for a short piece that is quicker to write than to announce, or one you want to get down before you lose it. Mix them across the steps as a real candidate would; none is the rule, and a run that uses the same one every time sounds mechanical. The line always matches its choice: before the code it looks ahead, during it describes what is appearing, after it looks back at what is now in the pad. Typing takes real time: a piece of more than a line or two typed in silence (before or after its line) leaves the call quiet for ten seconds or more, which a candidate would rarely do; they talk while typing a longer piece, or write it in smaller pieces. The budget for typing in silence, before or after its line, is about eight to ten seconds, which is roughly fifty characters or one or two short lines of code; a first piece typed in silence is the signature at most, and anything longer is typed while its line is said or split into smaller steps.',
    '- One combination needs a bridge. When a "before" step (line, then silent typing) is followed by an "after" step (silent typing, then line), the listeners would watch two pieces appear in one unbroken silence and take the second for more of what you explained first. So that "after" step carries a "bridge": a few words said before its typing starts that mark the move to a new piece, the way a person mutters when they turn to the next thing. It never explains the new piece (that is what the line after the typing is for) and never repeats an earlier bridge; choose words that fit this moment and how you have been talking. Every other step has bridge null.',
    `- Keep the words and the hands together. A step's line is about the code that same step types: never explaining a piece an earlier step already typed while typing the next one, and never explaining a later piece while still typing this one. ${WORK_PACE} Typing and talking should take about the same time when they go together ("during"; the hands slow down or speed up a little to keep with the voice, but only a little): when typing a piece would far outlast its line, either say more about that piece while you type it (what it does, why, what it handles) or split the piece into smaller steps; when the line is much longer than the typing, say it first or shorten it. The pad is only added to, in order, unless you are fixing something (retyping rewrites everything between the first and the last change, so a fix is made in place and minimal).`,
    '- Then write the code in a few small, logical pieces, one per step (usually two to four). Before each piece, say in plain English what it will do and why, at the level of intent: the operation and the reason for it, in your own words. Never read the code aloud or spell out syntax, symbols, brackets, variable assignments, operators or loop headers. One or two sentences per step.',
    '- The code is correct, runnable, idiomatic and small: what a careful senior engineer writes in an interview, with a short docstring or a comment only where it helps. Each step\'s code is the WHOLE pad after that step, so it repeats the earlier code and adds to it.',
    '- Then test it out loud: walk the given example through by hand with its actual numbers, said the way people say numbers, and give the result with its units. If the exercise asks for a hand calculation or a value, this is where you give it, worked briefly. Mention an edge case your code handles or that you would check, in a sentence. A step that only talks has code null.',
    '- Finish by saying plainly, in your own words, that you are done and are ready for their questions or to go through any part of it; there are many natural ways a person says that, so word it as you would, not as a stock closing. This is how the interviewers know your answer is final, so say it only in the last step, and say it clearly enough that nobody could take it for anything else.',
    '- Keep every line short and spoken: no lists, headings or markdown in what you say, no paragraph breaks, and never more than about forty words in a line. Numbers and units are said as words where it reads oddly otherwise.',
    SPOKEN_NOT_NOTES,
    ...CONVERSATION_REALISM,
    ...languageRule,
    '- Answer every bullet the exercise asks, in order, and nothing it does not ask.',
    '- Stay in character: never mention documents, notes, a prompt or being an AI, and never say you lack experience with something: an area the documents never touch is framed as how you would approach or learn it, the way a prepared candidate would.',
    '- Reply with JSON only, matching the schema: {"waitForReply":true or false,"steps":[{"say":"...","code":"..." or null,"explain":"before" or "during" or "after","bridge":"..." or null}]}.',
    ...sources,
    `\n<coding-pad-now${lang ? ` lang="${lang}"` : ''}>\n${padText || '(empty)'}\n</coding-pad-now>\n`,
    ...(context.pad?.seed?.text ? [`The exercise came with this code already in the pad. It was given to you, so you did not write it: you say so if you refer to it, go straight to what has to be changed or added, and keep the rest of it as it is.\n<given-code>\n${String(context.pad.seed.text).slice(0, WORK_PAD_MAX)}\n</given-code>`] : []),
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
    // An order only means something with both a line and code; an older reply's typeWhileSpeaking still reads as "during".
    const asked = WORK_ORDERS.includes(step?.explain) ? step.explain : step?.typeWhileSpeaking === true ? 'during' : 'before';
    const order = say && code !== null ? asked : 'before';
    return { say, code, order, together: order === 'during', bridge: cleanDraft(step?.bridge).slice(0, BRIDGE_MAX) };
  }).filter(step => step.say || step.code !== null).flatMap((step, at, all) => {
    // Typing in silence straight after a piece that was typed in silence after its own line: the two would read as
    // one piece, the one already explained. The bridge is said between them, as a line of its own; a reply that left
    // it out has this piece explained while it is typed instead, so the words and the hands still start together.
    const { bridge, ...kept } = step;
    const before = all[at - 1];
    const silentRun = step.order === 'after' && !!before && before.order === 'before' && before.code !== null;
    if (!silentRun) return [kept];
    if (bridge) return [{ say: bridge, code: null, order: 'before', together: false }, kept];
    return [{ ...kept, order: 'during', together: true }];
  }).slice(0, DRAFT_WORK_MAX_STEPS + BRIDGES_MAX);
  if (!steps.length) throw new Error('The drafted work had no steps.');
  // An answer to an interviewer's question mid-exercise is said with the hands off the keyboard, and then the candidate
  // waits for the interviewer's reply: only the first line is kept, and it types nothing.
  if (value?.waitForReply === true) {
    const answer = steps.find(step => step.say);
    if (answer) return [{ say: answer.say, code: null, order: 'before', together: false }];
  }
  return steps;
}

/** One structured call. Returns the steps; throws when the call fails or gives nothing usable. */
export async function draftCandidateWork({ callText, signal, ...context } = {}) {
  if (typeof callText !== 'function') throw new Error('No text call is available to draft the work.');
  const image = context.screen?.image && typeof context.screen.image.data === 'string' ? [context.screen.image] : null;
  const reply = await callText({ prompt: draftWorkPrompt(context), schema: DRAFT_WORK_SCHEMA, signal, ...(image ? { pageImages: image } : {}) });
  return cleanWork(reply && typeof reply === 'object' && !Array.isArray(reply) && 'text' in reply && !('steps' in reply) ? reply.text : reply);
}
