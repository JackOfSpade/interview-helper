import { INTERVIEW_PRACTICE_FEEDBACK_SCHEMA } from '../../ipc/interviewQaPractice.js';
import { prosodyByEntry } from '../audio/callMetrics.js';

/** Kinds the reviewer may flag; `filler` marks a counted filler moment. */
export const REVIEW_MOMENT_KINDS = Object.freeze(['moment', 'filler']);

// Feedback without `session`: the call record already says which session this
// was, and the call service re-attaches it when the feedback is stored.
const reviewFeedbackSchema = Object.freeze({
  ...INTERVIEW_PRACTICE_FEEDBACK_SCHEMA,
  required: ['overall', 'planned', 'priorities'],
});

/** The single review response: practice feedback, chapters and flagged moments. */
export const REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['feedback', 'chapters', 'moments'],
  properties: {
    feedback: reviewFeedbackSchema,
    chapters: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', additionalProperties: false, required: ['questionTurnIndex', 'title'],
        properties: {
          questionTurnIndex: { type: 'integer', minimum: 0, description: 'Index of the interviewer turn that asked the question.' },
          title: { type: 'string', maxLength: 120, description: 'Short chapter title for that question, in the candidate\'s own domain words.' },
        },
      },
    },
    moments: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', additionalProperties: false, required: ['turnIndex', 'label', 'kind'],
        properties: {
          turnIndex: { type: 'integer', minimum: 0, description: 'Index of the transcript turn where the moment happened.' },
          label: { type: 'string', maxLength: 200 },
          kind: { type: 'string', enum: REVIEW_MOMENT_KINDS },
        },
      },
    },
  },
});

const clock = ms => {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const line = value => (typeof value === 'string' ? value.trim() : '');

/** The persona is stored as an object (name, role, team, temperament); an older record may hold a string. */
function personaText(persona) {
  if (typeof persona === 'string') return line(persona);
  if (!persona || typeof persona !== 'object') return '';
  const head = [line(persona.name), line(persona.role), line(persona.team)].filter(Boolean).join(', ');
  const temperament = line(persona.temperament);
  return temperament ? `${head}${head ? ' ' : ''}(${temperament})` : head;
}

/** The start time is stored as epoch milliseconds; an older record may hold an ISO string. */
function startedText(value) {
  if (typeof value === 'string') return line(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * How the candidate answered: spoken answers, typed answers, or both. Acknowledgements are neither.
 * A chat line the call voiced in the candidate's voice (`voiced`) is spoken, exactly like live speech;
 * `live` counts only what the microphone heard, which is what the recording can be transcribed for.
 */
export function candidateAnswerKinds(transcript) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const own = turns.filter(turn => turn?.speaker === 'candidate' && !turn.acknowledgement);
  const typed = own.filter(turn => turn.channel === 'chat' && turn.voiced !== true).length;
  const spoken = own.length - typed;
  const live = own.filter(turn => turn.channel !== 'chat').length;
  return { spoken, live, typed, typedOnly: spoken === 0 && typed > 0 };
}

/** Prepared cards may be `question`/`headline`/`bullets`/`example` or a single `answer`. */
function planEntries(plan) {
  const cards = Array.isArray(plan) ? plan : plan?.cards ?? plan?.preparedCards ?? plan?.questions ?? [];
  return Array.isArray(cards) ? cards.filter(card => card && typeof card === 'object') : [];
}

function formatCard(card, head, extra = []) {
  const parts = [head];
  if (line(card.scope)) parts.push(`   scope: ${line(card.scope)}`);
  if (line(card.headline)) parts.push(`   headline: ${line(card.headline)}`);
  if (Array.isArray(card.bullets) && card.bullets.length) parts.push(`   points: ${card.bullets.map(line).filter(Boolean).join(' | ')}`);
  if (line(card.example)) parts.push(`   example: ${line(card.example)}`);
  if (line(card.answer) || line(card.preparedAnswer)) parts.push(`   prepared answer: ${line(card.answer) || line(card.preparedAnswer)}`);
  return [...parts, ...extra].join('\n');
}

const questionOf = card => line(card?.question) || line(card?.prompt);

function formatPlan(plan) {
  const entries = planEntries(plan);
  if (!entries.length) return '(no prepared answers were part of this call)';
  return entries.map((card, index) => formatCard(card, `${index + 1}. ${questionOf(card) || '(question)'}`)).join('\n');
}

const numbers = value => (Array.isArray(value) ? value.filter(Number.isInteger) : []);

/**
 * The cards this call picked, in the plan's order, with what the engine says happened to each.
 * `number` is the 1-based index into the prepared pool (the same number `pickedQuestions` and
 * `askedQuestions` use); number 0 is the one unprepared question. Null when the record has no
 * picked list (an older call): the review then falls back to the whole plan.
 */
export function pickedCards(callRecord, plan) {
  const picked = numbers(callRecord?.pickedQuestions);
  if (!picked.length) return null;
  const pool = planEntries(plan);
  const planned = Array.isArray(callRecord?.setup?.plan?.questions) ? callRecord.setup.plan.questions.filter(entry => entry && typeof entry === 'object') : [];
  const unprepared = unpreparedText(callRecord);
  const order = planned.length ? planned.map(entry => entry.number).filter(Number.isInteger).filter(number => number === 0 || picked.includes(number)) : [];
  for (const number of picked) if (!order.includes(number)) order.push(number);
  if (unprepared && !order.includes(0)) order.push(0);
  const askedList = Array.isArray(callRecord?.askedQuestions) ? numbers(callRecord.askedQuestions) : null;
  const answeredList = numbers(callRecord?.answeredQuestions);
  const cards = [];
  for (const number of order) {
    const probes = (planned.find(entry => entry.number === number)?.probes ?? []).map(line).filter(Boolean);
    if (number === 0) {
      if (unprepared) cards.push({ number: 0, question: unprepared, probes, card: null, unprepared: true, asked: null, answered: null });
      continue;
    }
    const card = pool[number - 1];
    const question = questionOf(card);
    if (!question) continue;
    cards.push({ number, question, probes, card, unprepared: false, asked: askedList ? askedList.includes(number) : null, answered: answeredList.includes(number) });
  }
  return cards;
}

const yesNo = value => (value === null ? 'unknown' : value ? 'yes' : 'no');

function formatPicked(cards) {
  return cards.map(entry => {
    if (entry.unprepared) {
      return [`card 0 (the unprepared question, no prepared answer): ${entry.question}`, ...(entry.probes.length ? [`   interviewer's probes: ${entry.probes.join(' | ')}`] : [])].join('\n');
    }
    const status = `   engine: asked ${yesNo(entry.asked)}, answered ${entry.asked === false ? 'no' : yesNo(entry.answered)}`;
    return formatCard(entry.card, `card ${entry.number}: ${entry.question}`, [status, ...(entry.probes.length ? [`   interviewer's probes for this card: ${entry.probes.join(' | ')}`] : [])]);
  }).join('\n');
}

function wordsOf(entry) {
  const words = Array.isArray(entry) ? entry : entry?.words ?? [];
  return words.map(word => line(typeof word === 'string' ? word : word?.text)).filter(Boolean).join(' ');
}

const LEAD_ID = 'A';

/**
 * Every interviewer of a panel call, lead first. The record keeps the lead in `persona` and may
 * or may not repeat them in `panel`; a solo call (empty panel) gives an empty list.
 */
function panelInterviewers(callRecord) {
  const panel = Array.isArray(callRecord?.panel) ? callRecord.panel.filter(member => member && typeof member === 'object') : [];
  if (!panel.length) return [];
  const persona = callRecord.persona && typeof callRecord.persona === 'object' ? callRecord.persona : {};
  const lead = panel.find(member => member.id === LEAD_ID) ?? { id: LEAD_ID, name: persona.name, role: persona.role };
  return [lead, ...panel.filter(member => member !== lead)];
}

function interviewerText(member) {
  const parts = [line(member.name) || `interviewer ${line(member.id)}`.trim()];
  if (line(member.role)) parts.push(line(member.role));
  const focus = line(member.focus);
  const late = member.joins === 'late';
  const when = typeof member.joinedAtMs === 'number' && Number.isFinite(member.joinedAtMs) ? ` at ${clock(member.joinedAtMs)}` : '';
  const tail = [
    focus ? `focus: ${focus}` : '',
    late ? (when ? `joined late${when}` : 'joined late, but never joined the call') : '',
  ].filter(Boolean);
  return `${parts.join(', ')}${tail.length ? ` (${tail.join('; ')})` : ''}`;
}

const sentOf = turn => (turn?.speaker === 'candidate' && typeof turn.sentText === 'string' ? line(turn.sentText) : '');

function formatTranscript(transcript, wordsByTurn, interviewers = []) {
  const names = new Map(interviewers.map(member => [member.id, line(member.name)]).filter(([, name]) => name));
  return transcript.map((turn, index) => {
    const named = turn.speaker !== 'candidate' ? names.get(turn.speakerId) : '';
    const who = turn.speaker === 'candidate' ? 'candidate' : (named || 'interviewer');
    const segments = turn.speaker !== 'candidate' && interviewers.length && Array.isArray(turn.segments)
      ? turn.segments.filter(segment => line(segment?.text)) : [];
    // A hand-over inside one turn: each segment gets its own line so the reviewer sees who said what.
    const overlap = turn.overlay && turn.speaker !== 'candidate' ? ' (overlapping remark, said over the speaker)' : '';
    // A line that asked the candidate nothing: a silence after it, and the interviewer picking it up again, are not the candidate's doing.
    const statement = turn.statement === true && turn.speaker !== 'candidate' ? ' (asked nothing; left room for a reaction)' : '';
    // A voiced chat line was spoken on the call: it carries no (chat) mark, so it reads as the speech it was.
    const channelMark = turn.channel && turn.channel !== 'audio' && !(turn.voiced === true && turn.speaker === 'candidate') ? ` (${turn.channel})` : '';
    const head = `[${index}] ${who}${overlap}${statement} ${clock(turn.startMs)}-${clock(turn.endMs)}${channelMark}:${segments.length ? '' : ` ${line(sentOf(turn) || turn.text)}`}`;
    const extras = segments.map(segment => `    ${names.get(segment.speakerId) || 'interviewer'}: ${line(segment.text)}`);
    // The recogniser's text can carry mis-hearings; for a line the AI voice spoke the known words lead and the recogniser's version follows.
    if (sentOf(turn) && line(turn.text) && line(turn.text) !== line(sentOf(turn))) extras.push(`    recogniser heard it as: ${line(turn.text)}`);
    else if (!sentOf(turn) && line(turn.heardText)) extras.push(`    heard as: ${line(turn.heardText)}`);
    const verbatim = wordsOf(wordsByTurn?.[index]);
    if (verbatim) extras.push(`    scribe verbatim: ${verbatim}`);
    if (turn.speaker === 'candidate' && turn.interrupted === true && turn.cutOffBy === 'interviewer') {
      // cutWhileSpeaking and cutInReason come from the engine; calls recorded before they existed carry neither.
      const reason = line(turn.cutInReason);
      if (turn.cutWhileSpeaking === false) extras.push('    (the interviewer came in after the candidate had essentially finished: this is not a cut-in and says nothing about the answer running long)');
      else extras.push(`    (this answer was cut off by the interviewer, and only the words above were heard${reason ? `; the interviewer's reason: ${reason}` : '; the reason is not recorded'})`);
    }
    else if (turn.interrupted) extras.push('    (the interviewer was still speaking when this turn started)');
    return [head, ...extras].join('\n');
  }).join('\n');
}

function formatToneTimeline(samples) {
  if (!Array.isArray(samples) || !samples.length) return '(no tone samples)';
  return samples.map(sample => `${clock(sample?.atMs)} arousal ${sample?.arousal} dominance ${sample?.dominance} valence ${sample?.valence}`).join('\n');
}

function formatMetrics(metrics) {
  try {
    return JSON.stringify(metrics ?? {}, null, 2);
  } catch {
    return '(metrics were not serializable)';
  }
}

const RULES = [
  'You are reviewing one recorded mock interview the candidate just finished. This feedback is read, never spoken back during a call.',
  // Two of six reviews up to 2026-11-22 were rejected for a 610-character "covered" and cost a minute's retry: the
  // schema's maxLength is not enforced on the model's side, so the limits are stated here.
  '- Length limits are hard, and a reply over any of them is rejected whole: overall.summary and delivery.summary at most 1500 characters; each planned question\'s covered, adapted, improve and extension, and each moment\'s note, at most 600 characters (about 90 words, so aim for 400 to 500); chapter titles at most 120 and moment labels at most 200; every other text field at most 300 characters. Pick the points that matter most rather than listing everything.',
  'Use only what the transcript, the metrics and the plan below support. Never invent a number that is not in the metrics; when you cite pace, pauses, talk time or words per minute, copy the measured value. Pace is wordsPerMinute and fastest20sWindowWpm (words over the answer\'s time, pauses included); articulationWpm counts only voiced time and is never quoted as pace.',
  '- Fillers: count only non-lexical filler uses in the candidate\'s own words (the sounds people make while thinking). A word that carries meaning in that sentence is not a filler, and quoting a word from the plan is not a filler. Do not use any list of filler words; judge each use in context.',
  '- Write every duration the way a person would say it, in seconds or in minutes and seconds ("about a minute and a half", "01:32"). Never print a raw millisecond count, even though the metrics are in milliseconds.',
  '- Aim for fewer fillers, not zero: fluent speech keeps some. Say what got in the way, not that any filler is a failure.',
  '- Chapters: one chapter per interviewer question turn, in the order they were asked. Use the turn index shown in brackets, and give each a short, specific title.',
  '- Moments: flag only moments worth replaying, with the turn index where they happened, a short label, and kind "filler" only for a counted filler moment.',
  '- Delivery: fill the delivery section from the measured numbers and the observed behaviour; it is a summary of pace, pauses, fillers, confidence, interruptions and any typed answers.',
  '- Interviewer cut-ins: a turn marked as cut off by the interviewer means the candidate was still speaking when the interviewer came in. Why they came in is a separate question, and the turn says it when recorded: an interviewer can cut in to probe a detail, to move on once they have enough, or because an answer really ran long, and a persona that interrupts readily does so on short answers too. Judge each cut by its recorded reason and by how long the answer had run, and call an answer long only when the reason or its length shows that. A turn that says the interviewer came in after the candidate had essentially finished is not a cut-in. When the reason is not recorded, say so rather than guessing at length. Mention cut-ins in delivery when they happened, and count them from the metrics (interviewerCutInCount), never from memory.',
  '- Never print transcript turn numbers (the bracketed indices) in any feedback text: refer to the question, or to a time as mm:ss. The indices are only for the chapter and moment index fields.',
  '- Words: for a candidate line that has a "recogniser heard it as" note, the words on the main line are what was actually said; the note is speech recognition and may be wrong. Never criticise a word that appears only in the recogniser version.',
  '- Fit for the role: this interview was held whether or not the candidate\'s background matches the job. Judge every answer against what this role really needs, as its interviewers would, never against an easier bar because of the candidate\'s background. Saying honestly that they have not done something is not a bad answer in itself: name it as a gap for this role, and judge what they did with it (the closest experience they offered, the approach they described, or nothing). Never fault the interviewer for asking about something the candidate has not done.',
  '- Typed turns: a transcript turn marked (chat) was typed, not spoken. Every turn without that mark was spoken, and all spoken answers are judged the same way. A typed line from the candidate is one of their answers and is judged for content, structure and relevance like any spoken answer. Never make a claim about pace, pauses, fillers, confidence or tone for a typed turn: typing has no voice to measure. Never critique typos, spelling, stray characters or missing punctuation in typed text as if they were speech; typed text is judged for content only.',
].join('\n');

const SCOPE_RULES = [
  '- Scope: judge each answer against the question that was actually asked and the follow-ups the interviewer put to it. A prepared point the candidate was not asked about may appear only in the optional extension of that entry, never in improve and never as a gap or something they missed.',
  '- Hedges: report a hedged statement as hedged. Quote the hedge ("perhaps", "maybe", "I might") and never upgrade it into a decision, a commitment or a fact the candidate did not state.',
].join('\n');

const PICKED_RULE = [
  '- Planned questions: this call picked only the cards listed under PICKED QUESTIONS, and the card number is a card\'s identity. The planned list has exactly one entry per listed card, in the listed order, with the question copied exactly as written there. Take "asked" from the engine line of that card, never from a similar-sounding interviewer line; when it was asked, askedAs is the interviewer\'s own line that asked that card\'s question and the score and notes judge the answer to it. Follow-ups and every other interviewer line (small talk, a different topic, the closing) go into moments, never into another card\'s entry. Pool cards that were not picked are not part of this call: do not list or judge them. The unprepared question, when listed, is its own entry at the position listed.',
].join('\n');

// Only on a call that has such a turn: a line that ended on a statement rather than a question.
const STATEMENT_RULE = '- An interviewer turn marked (asked nothing; left room for a reaction) ended on a statement, not a question. The candidate was not required to answer it: never fault them for a silence after it or for the interviewer picking the conversation up again, and never count that silence as slow responding. A reaction to it, when they gave one, is judged like any other answer.';
const PANEL_RULE = '- Panel: more than one interviewer was on this call. Say how the candidate handled that (addressing the right person, coping with a hand-over between interviewers or with a colleague who joined late), but only when the transcript shows it. Do not comment on it otherwise, and do not fault the candidate for how the interviewers dealt with each other.';

const TYPED_ONLY_NOTE = [
  'The candidate answered only by typing in the chat; every candidate turn below is typed text, and no spoken answer was recorded. This is how the call went, not a technical failure.',
  'Judge the typed answers as the candidate\'s answers, for content, structure and relevance.',
  'Delivery was not measured because every answer was typed. In the delivery section write one summary line saying exactly that, and leave pace, pauses, fillers, confidence, interruptions, typedAnswers, fillerCount and wordsPerMinute out (empty strings for the text ones). In communication, leave pace, confidence and filler as empty strings; clarity and structure describe the content of the answers only. Make no claim about pace, pauses, fillers, confidence, tone, talk time or typos anywhere in the review.',
].join('\n');

 const REVIEW_SCREEN_CAP = 6000;
 const REVIEW_PAD_CAP = 12000;

const cut = (text, cap) => (text.length > cap ? `${text.slice(0, cap)}\n(cut: the first ${cap} characters of ${text.length} are shown)` : text);

// A fence longer than any backtick run inside keeps the data from closing its own block.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** Where a time falls against the transcript: the last turn that had started by then. */
function turnAt(transcript, atMs) {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return 'at an unknown time';
  let index = -1;
  transcript.forEach((turn, i) => { if (typeof turn?.startMs === 'number' && turn.startMs <= atMs) index = i; });
  return index < 0 ? 'before the first transcript turn' : `during or after transcript turn [${index}]`;
}

function formatScreens(screens, transcript) {
  return screens.map((screen, index) => {
    const ended = typeof screen.endMs === 'number' && Number.isFinite(screen.endMs) ? `, until ${clock(screen.endMs)}` : ', until the end of the call';
    const head = `screen ${index + 1}: "${line(screen.title) || '(untitled)'}" shown at ${clock(screen.atMs)} (${turnAt(transcript, screen.atMs)})${ended}`;
    // What a picture or diagram above the text showed: a stale diagram can contradict the text, and the candidate saw both.
    const visual = screen.visual && typeof screen.visual === 'object' && line(screen.visual.description)
      ? `\n(${screen.visual.kind === 'picture' ? 'picture' : 'diagram'} above the text, showing: ${cut(line(screen.visual.description), 600)})` : '';
    return `${head}${visual}\n${fenced(cut(String(screen.content ?? '').trim(), REVIEW_SCREEN_CAP))}`;
  }).join('\n\n');
}

/** The one question the candidate had not prepared: { text, askedBy } on the call record, or the number-0 plan entry. */
function unpreparedText(callRecord) {
  const direct = line(callRecord?.unpreparedQuestion?.text);
  if (direct) return direct;
  const entries = callRecord?.setup?.plan?.questions;
  const zero = Array.isArray(entries) ? entries.find(entry => entry && entry.number === 0) : null;
  return line(zero?.text);
}

const UNPREPARED_NOTE = (text) => [
  `One question on this call was not one the candidate had prepared: "${text}"`,
  'There is no prepared answer for it. Judge it only if the transcript shows the interviewer actually reached it: then judge the candidate\'s answer on its own, as a test of adaptability (structure, relevance, composure) and never fault it for departing from prepared material. If the transcript never shows it being asked, say nothing about it and give it no score.',
].join('\n');

const SCREEN_PAD_RULE = '- Shared screen and coding pad: when the data below shows screens the interviewer shared or code the candidate wrote, judge the written code for correctness, edge cases and how the candidate talked through it, and say whether they addressed each part shown. Never claim anything about code that is not in the pad text below; if the pad is empty or missing, say no code was written. Before marking an answer down for misreading a screen, check that screen as shown (its text and the picture or diagram above it): when the screen contradicted itself or was wrong, for example an earlier traffic list or a diagram of starting positions left on screen beside an update, an answer that followed one of its versions is not a misreading, so do not count it against the candidate; say the screen was unclear, and credit a candidate who noticed the contradiction or asked which was current.';

/** Active length: the call's length minus the time it was paused (the candidate typing). */
function lengthLine(callRecord) {
  const total = Number(callRecord.durationMs);
  const paused = Number(callRecord.pausedMs);
  if (!(paused > 0) || !Number.isFinite(total)) return `length: ${clock(callRecord.durationMs)}`;
  return `length: ${clock(Math.max(0, total - paused))} active. The call was also paused for ${clock(paused)}; that paused time is excluded from the length and from every rate. Transcript times run on the recording's clock and include the pauses, so large gaps between turns are pauses, not silence.`;
}

/** The one review prompt: timed transcript, plan, metrics, tone, Scribe words. */
export function buildReviewPrompt({ callRecord = {}, plan, brief, metrics, wordsByTurn = {}, transcriptionError = null, correction = null } = {}) {
  const transcript = Array.isArray(callRecord.transcript) ? callRecord.transcript : [];
  const role = [line(brief?.role?.title) || line(brief?.title), line(brief?.role?.company) || line(brief?.company)].filter(Boolean).join(' at ');
  const focus = line(callRecord.steering);
  const reason = line(callRecord.reason);
  // The candidate hung up or closed the window while the interviewer was still in the call.
  const candidateEnded = reason === 'candidate' || reason === 'window-closed';
  // Anything else but the interviewer's own wrap-up (audio helper, session or other failure) cut the call short.
  const technicalEnd = Boolean(reason) && !candidateEnded && reason !== 'interviewer';
  const { typedOnly } = candidateAnswerKinds(transcript);
  const interviewers = panelInterviewers(callRecord);
  const header = [
    `call id: ${line(callRecord.callId) || '(unknown)'}`,
    `interviewer persona: ${personaText(callRecord.persona) || '(unknown)'}`,
    interviewers.length ? `interviewers on this call (a panel): ${interviewers.map(interviewerText).join('; ')}` : '',
    focus ? `interview focus requested by the candidate: ${focus}` : '',
    focus ? 'judge the call against that requested focus: a stage, depth or topic the focus asked to skip or lighten is not a gap, so do not penalise the interviewer for leaving it out' : '',
    `started: ${startedText(callRecord.startedAt) || '(unknown)'}`,
    role ? `role: ${role}` : '',
    lengthLine(callRecord),
    candidateEnded ? 'how the call ended: the candidate ended the call early, before the interviewer had wrapped up or said goodbye' : '',
    technicalEnd ? `how the call ended: a technical failure cut the call short (${reason}); the candidate did not end it and must not be faulted for it` : '',
    candidateEnded || technicalEnd ? `review only the part of the call that took place. Planned questions that were never reached are not asked: do not score them or count them against the candidate, and do not treat the missing wrap-up or the closing questions of the candidate as a gap. Say once in the overall summary that the call ended early${technicalEnd ? ' because of a technical problem' : ''} and the review covers the call up to that point` : '',
    callRecord.reason === 'interviewer' ? 'how the call ended: the interviewer wrapped up and ended the call' : '',
  ].filter(Boolean).join('\n');
  // Where the voice came from is not the review's business: the marker never reaches the prompt.
  const measuredProsody = Object.fromEntries(Object.entries(prosodyByEntry(transcript, callRecord.candidateProsody))
    .map(([index, turns]) => [index, turns.map(turn => { const copy = { ...turn }; delete copy.voiced; return copy; })]));
  const screens = Array.isArray(callRecord.screens)
    ? callRecord.screens.filter(screen => screen && typeof screen === 'object' && line(screen.content)) : [];
  const snapshots = Array.isArray(callRecord.pad?.snapshots) ? callRecord.pad.snapshots : [];
  const padText = String(snapshots.at(-1)?.text ?? '').trim();
  const hasPad = Boolean(padText);
  const unprepared = unpreparedText(callRecord);
  const picked = pickedCards(callRecord, plan);
  const sections = [
    [RULES, SCOPE_RULES, picked ? PICKED_RULE : '', interviewers.length ? PANEL_RULE : '', transcript.some(turn => turn?.statement === true && turn.speaker !== 'candidate') ? STATEMENT_RULE : '', screens.length || hasPad ? SCREEN_PAD_RULE : ''].filter(Boolean).join('\n'),
    '--- CALL ---', header,
    ...(typedOnly ? ['--- HOW THE CANDIDATE ANSWERED ---', TYPED_ONLY_NOTE] : []),
    ...(picked
      ? ['--- PICKED QUESTIONS (the planned questions of this call; the interviewers did not see the prepared answers) ---', formatPicked(picked)]
      : ['--- PLAN (prepared answers the candidate could draw on; the interviewers did not see them) ---', formatPlan(plan)]),
    ...(unprepared ? ['--- THE UNPREPARED QUESTION ---', UNPREPARED_NOTE(unprepared)] : []),
    '--- TIMED TRANSCRIPT (turn indices are what chapters and moments must cite) ---', formatTranscript(transcript, wordsByTurn, interviewers),
    ...(typedOnly ? [] : ['--- DETERMINISTIC METRICS (the only source of numbers) ---', formatMetrics(metrics)]),
    ...(screens.length ? ['--- SHARED SCREENS (what the interviewer showed, in order; the interviewer did not read this aloud) ---', formatScreens(screens, transcript)] : []),
    ...(hasPad ? [`--- CANDIDATE CODING PAD (final text${line(callRecord.pad?.lang) ? `, language: ${line(callRecord.pad.lang)}` : ''}) ---`, fenced(cut(padText, REVIEW_PAD_CAP))] : []),
    ...(typedOnly ? [] : [
      '--- CANDIDATE PROSODY BY TURN (measured per spoken answer, keyed by transcript turn index: pace, pauses with helper-timeline ms, pitch, loudness; typed turns have none) ---', formatMetrics(measuredProsody),
      '--- TONE TIMELINE (0-1 arousal, dominance, valence; spoken answers only) ---', formatToneTimeline(callRecord.toneSamples),
    ]),
  ];
  if (transcriptionError) sections.push(`--- TRANSCRIPTION NOTE ---\nThe verbatim Scribe pass failed (${line(transcriptionError) || 'unknown error'}), so no word-level transcript is available. Judge fillers only from the readable transcript, and do not claim a filler count you cannot support.`);
  if (correction) sections.push(`--- CORRECTION REQUIRED ---\nThe previous reply was rejected: ${line(correction) || 'it did not match the schema'}\nReturn the full JSON object again, corrected.`);
  return sections.join('\n\n');
}
