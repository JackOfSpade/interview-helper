import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './testHelpers.js';

// Synthetic call shaped like a real analysed one: interviewer turns that open each chapter, a candidate
// answer after each, an overlay remark, a turn several people spoke in, an audio tag, and a closing
// chapter that no turn index points at.
const model = () => import(pathToFileURL(path.resolve('src/practice-call/replayModel.js')).href);

const TRANSCRIPT = [
  /* 0 */ { speaker: 'interviewer', speakerId: 'A', text: '[warmly] Hi Sam, this is Rowan Pike from the platform team. Before we get going, how has your day been so far?', startMs: 1_000, endMs: 30_000 },
  /* 1 */ { speaker: 'interviewer', speakerId: 'B', text: 'Hello, Sam.', overlay: true, startMs: 12_000, endMs: 12_000 },
  /* 2 */ { speaker: 'candidate', channel: 'chat', voiced: true, text: 'Good, thanks for having me.', startMs: 40_000, endMs: 50_000 },
  /* 3 */ { speaker: 'interviewer', speakerId: 'A', text: 'Glad to hear it. So tell me about a time you led a migration under pressure, and what you would change.', startMs: 51_000, endMs: 70_000 },
  /* 4 */ { speaker: 'candidate', text: 'We moved the billing database over a weekend.', startMs: 80_000, endMs: 160_000 },
  /* 5 */ { speaker: 'interviewer', speakerId: 'A', text: 'Right. What was the hardest disagreement you had with the other engineer during it?', startMs: 161_000, endMs: 175_000 },
  /* 6 */ { speaker: 'candidate', text: 'We argued about the cutover date.', startMs: 185_000, endMs: 240_000 },
  /* 7 */ { speaker: 'interviewer', speakerId: 'B', text: 'Over to me. Here is the first reading: the flow is flat while pressure falls. Walk me through your next two checks.', startMs: 241_000, endMs: 262_000, segments: [{ speakerId: 'A', text: 'Over to you, Ines.' }, { speakerId: 'B', text: 'Here is the first reading: the flow is flat while pressure falls. Walk me through your next two checks.' }] },
  /* 8 */ { speaker: 'candidate', text: 'I would check the outlet temperature first.', startMs: 270_000, endMs: 330_000 },
  /* 9 */ { speaker: 'interviewer', speakerId: 'A', text: 'Thanks, that is all from us. The team will review everything and follow up with you on next steps.', startMs: 340_000, endMs: 360_000 },
];
const CHAPTERS = [
  { title: 'Opening', questionTurnIndex: 0, startMs: 0, endMs: 51_000, markers: [{ atMs: 20_000, kind: 'pause', label: 'Long pause' }] },
  { title: 'Leading a migration', questionTurnIndex: 3, startMs: 51_000, endMs: 161_000, markers: [] },
  { title: 'Disagreeing over the cutover', questionTurnIndex: 5, startMs: 161_000, endMs: 241_000, markers: [] },
  { title: 'Reading the flow data', questionTurnIndex: 7, startMs: 241_000, endMs: 340_000, markers: [{ atMs: 300_000, kind: 'moment', label: 'Outlet temperature first' }] },
  { title: 'Closing', questionTurnIndex: null, startMs: 340_000, endMs: 400_000, markers: [] },
];
const FEEDBACK = {
  overall: { score: 7, summary: 'One. Two. Three.' },
  planned: [
    { question: 'Tell me about leading a migration.', asked: true, askedAs: 'Tell me about a time you led a migration under pressure', score: 6, covered: 'c', improve: 'i' },
    { question: 'Tell me about a disagreement.', asked: true, askedAs: 'What was the hardest disagreement you had with the other engineer?', score: 8, covered: 'c' },
    { question: 'Why this team?', asked: false },
    { question: 'Never quoted', asked: true, askedAs: '', score: 5 },
  ],
  moments: [
    { kind: 'small-talk', prompt: 'Before we get going, how has your day been so far?', score: 9, note: 'Warm.' },
    { kind: 'follow-up', prompt: 'Walk me through your next two checks.', score: 7, note: 'Sound.' },
    { kind: 'follow-up', prompt: 'the hardest disagreement you had…', score: 3, note: 'Shown with the planned question in the same chapter.' },
    { kind: 'closing', prompt: 'The team will review everything and follow up with you on next steps.', score: 6, note: 'Fine.' },
    { kind: 'other', prompt: 'Something nobody ever said about the quarterly roadmap and budget', score: 4, note: 'No such line.' },
  ],
};
const REPLAY = {
  durationMs: 400_000, transcript: TRANSCRIPT, chapters: CHAPTERS, feedback: FEEDBACK,
  persona: { name: 'Rowan Pike', role: 'Engineering manager' },
  panel: [{ id: 'B', name: 'Ines Vale', role: 'Staff engineer' }],
  pauseSpans: [{ startMs: 100_000, endMs: 140_000 }, { startMs: 280_000, endMs: 290_000 }],
};

export default [
  {
    name: 'replay model: match text ignores case, punctuation, spacing and audio tags; quotes match by substring, else by word overlap of 0.6',
    async run() {
      const { normalizeMatchText, matchScore } = await model();
      assert(normalizeMatchText('  [warmly] Hi,   THERE!  [laughs] How’s it?  ') === "hi there how's it", 'case, punctuation, spaces and tags are normalised');
      assert(matchScore('how is your day', 'How is your day?') === 1, 'equal after normalising');
      assert(matchScore('how has your day been', 'Before we start, how has your day been so far?') > 0.9, 'a quote inside the line is a substring match');
      assert(matchScore('the hardest disagreement you had…', 'What was the hardest disagreement you had with them?') > 0.9, 'a trailing ellipsis is ignored');
      const paraphrase = matchScore('Walk me through the next two checks you would do', 'Walk me through your next two checks.');
      assert(paraphrase > 0 && paraphrase < 0.9, 'a paraphrase matches by word overlap, never above a substring match (0.9 and up)');
      assert(matchScore('Tell me about a time you had to work with them on that', 'Can you tell me about the time you had with them on the project?') === 0, 'shared filler words alone are not a match');
      assert(matchScore('walk me through your next', 'tell me about the flow of the weekend plan please thanks') === 0, 'low overlap does not match');
      assert(matchScore('one two three four five', 'one two nine ten eleven') === 0, '2 of 5 words is below the threshold');
      assert(matchScore('one two three four five', 'one two three four zzz') > 0.6 * 0.8 - 0.01, '4 of 5 words matches');
      assert(matchScore('', 'x') === 0 && matchScore('x', '') === 0 && matchScore(null, undefined) === 0, 'empty text never matches');
      assert(matchScore('Yes', 'Yes, I would like that very much indeed') === 0, 'one common word is not a match');
    },
  },
  {
    name: 'replay model: asked planned questions and moments land on the chapter of the interviewer turn that matches, one per chapter',
    async run() {
      const { buildReplayModel } = await model();
      const built = buildReplayModel(REPLAY);
      const at = index => built.chapters[index].feedback;
      assert(at(0)?.kind === 'moment' && at(0).item.kind === 'small-talk', 'the small-talk moment lands on the chapter that opens with it (an audio tag in the turn)');
      assert(at(1)?.kind === 'planned' && at(1).item.score === 6, 'a planned question lands on the chapter of the turn that asked it');
      assert(at(2)?.kind === 'planned' && at(2).item.score === 8, 'the planned question beats the moment quoting the same turn');
      assert(at(3)?.kind === 'moment' && at(3).item.note === 'Sound.', 'a quote of one speaker in a multi-speaker turn matches that part');
      assert(at(4)?.kind === 'moment' && at(4).item.kind === 'closing', 'a chapter no turn index opens is found by the turn time');
      assert(built.leftover.planned.length === 0, 'the unasked and unquoted planned questions are not leftovers of the matcher');
      assert(JSON.stringify(at(2).extras.map(item => item.note)) === JSON.stringify(['Shown with the planned question in the same chapter.']), 'a follow-up moment in a planned question\'s chapter is shown with it');
      assert(built.leftover.moments.map(item => item.note).join('|') === 'No such line.', 'only moments that match nothing stay for the overview');
      assert(built.chapters.every(chapter => !chapter.feedback || [chapter.feedback].length === 1), 'at most one item per chapter');
      const noFeedback = buildReplayModel({ ...REPLAY, feedback: null });
      assert(noFeedback.chapters.every(chapter => chapter.feedback === null && chapter.score === null), 'no feedback, no matches');
      const overlayOnly = buildReplayModel({ ...REPLAY, feedback: { moments: [{ kind: 'other', prompt: 'Hello, Sam.', score: 5, note: 'n' }] } });
      assert(overlayOnly.chapters[0].feedback?.turnIndex === 1, 'an overlay remark can be quoted too and belongs to the chapter it was said in');
    },
  },
  {
    name: 'replay model: a chapter splits into the question (to the first candidate turn) and the answer, and names who asked',
    async run() {
      const { buildReplayModel } = await model();
      const { chapters } = buildReplayModel({ ...REPLAY, pauseSpans: [] });
      assert(chapters[1].questionEndMs === 80_000 && chapters[1].hasAnswer && chapters[1].endMs === 161_000, 'the question runs from the chapter start to the first candidate turn');
      assert(chapters[0].questionEndMs === 40_000, 'the first candidate turn is a voiced chat line and counts as an answer');
      assert(chapters[4].hasAnswer === false && chapters[4].questionEndMs === chapters[4].endMs, 'a chapter with no candidate turn is all question');
      assert(chapters[1].asker.name === 'Rowan Pike' && chapters[1].asker.role === 'Engineering manager', 'the lead comes from the persona');
      assert(chapters[3].asker.name === 'Ines Vale' && chapters[3].asker.role === 'Staff engineer', 'a colleague comes from the panel');
      assert(chapters[4].asker === null || chapters[4].asker.name, 'a chapter nobody opened has an asker or none');
      const spans = buildReplayModel(REPLAY).chapters;
      assert(spans[1].activeStartMs === 51_000 && spans[1].activeQuestionEndMs === 80_000 && spans[1].activeEndMs === 121_000, 'the split is on the active clock too: 40 s of pause are inside the answer');
      const { partAtActive } = await model();
      assert(partAtActive(spans[1], 79_999) === 'question' && partAtActive(spans[1], 80_000) === 'answer' && partAtActive(spans[4], 999_999) === 'question', 'part at a time');
    },
  },
  {
    name: 'replay model: chapters cover the call; no chapters is one block; chapters inside a pause have no length',
    async run() {
      const { buildReplayModel, chapterAtActive } = await model();
      const none = buildReplayModel({ durationMs: 60_000, chapters: [], transcript: [] });
      assert(none.chapters.length === 1 && none.chapters[0].synthetic && none.chapters[0].startMs === 0 && none.chapters[0].endMs === 60_000, 'no chapters: one block for the whole call');
      const gappy = buildReplayModel({ durationMs: 100_000, chapters: [{ title: 'A', startMs: 5_000, endMs: 20_000 }, { title: 'B', startMs: 30_000, endMs: 50_000 }], transcript: [] });
      assert(gappy.chapters[0].startMs === 0 && gappy.chapters[0].endMs === 30_000 && gappy.chapters[1].endMs === 100_000, 'the first chapter starts at zero, a gap joins the earlier chapter and the last one runs to the end');
      const inPause = buildReplayModel({ durationMs: 100_000, pauseSpans: [{ startMs: 20_000, endMs: 60_000 }], chapters: [{ title: 'A', startMs: 0 }, { title: 'Gone', startMs: 30_000 }, { title: 'C', startMs: 55_000 }], transcript: [] });
      assert(inPause.activeMs === 60_000 && inPause.chapters[1].activeEndMs === inPause.chapters[1].activeStartMs, 'a chapter wholly inside a pause has no active length');
      assert(chapterAtActive(inPause.chapters, 20_000) === 2, 'the playhead is never in the empty chapter');
      assert(chapterAtActive(inPause.chapters, 5_000) === 0 && chapterAtActive(inPause.chapters, 59_999) === 2 && chapterAtActive(inPause.chapters, 60_000) === 2, 'chapter by active time, the end of the call stays in the last one');
      assert(chapterAtActive([], 5) === -1, 'no chapters, no index');
      const missing = buildReplayModel(null);
      assert(missing.chapters.length === 1 && missing.activeMs === 0, 'no replay at all still gives a model');
    },
  },
  {
    name: 'replay model: active time maps both ways and the timeline is laid out without the pauses',
    async run() {
      const { activeToRecordingMs, activeTimeMs, skipPausedMs, normalizePauseSpans, buildReplayModel, timelineBlocks, timelineTicks } = await model();
      const spans = normalizePauseSpans([{ startMs: 100, endMs: 200 }, { startMs: 500, endMs: 530 }], 1_000);
      assert(activeToRecordingMs(spans, 50) === 50 && activeToRecordingMs(spans, 99) === 99, 'before a pause nothing shifts');
      assert(activeToRecordingMs(spans, 100) === 200, 'the edge of a pause lands after it');
      assert(activeToRecordingMs(spans, 150) === 250 && activeToRecordingMs(spans, 400) === 530 && activeToRecordingMs(spans, 500) === 630, 'every pause before the point is added back');
      assert(activeToRecordingMs([], 77) === 77 && activeToRecordingMs(undefined, -5) === 0, 'no spans, no shift; never negative');
      for (const rec of [0, 99, 200, 250, 499, 530, 800, 1_000]) assert(activeToRecordingMs(spans, activeTimeMs(spans, rec)) === rec, `round trip at ${rec}`);
      for (const rec of [100, 150, 199, 500, 520]) assert(activeToRecordingMs(spans, activeTimeMs(spans, rec)) === skipPausedMs(spans, rec), `a point inside a pause maps to the end of it at ${rec}`);
      const built = buildReplayModel(REPLAY);
      assert(built.activeMs === 350_000, 'active length is the recording minus 50 s of pauses');
      const blocks = timelineBlocks(built.chapters, built.activeMs);
      assert(blocks.length === 5 && Math.abs(blocks.reduce((sum, block) => sum + block.widthPct, 0) - 100) < 1e-9, 'the blocks fill the whole bar with no space for the pauses');
      assert(blocks[0].leftPct === 0 && blocks.every((block, index) => index === 0 || Math.abs(block.leftPct - (blocks[index - 1].leftPct + blocks[index - 1].widthPct)) < 1e-9), 'blocks are contiguous');
      assert(blocks[1].questionPct > 0 && blocks[1].questionPct < 100 && blocks[4].questionPct === 100, 'each block has a question share, all question without an answer');
      assert(blocks[0].band === 'good' && blocks[1].band === 'mid' && blocks[2].band === 'good' && blocks[3].band === 'mid' && blocks[4].band === 'mid', 'bands follow the scores 9, 6, 8, 7, 6');
      const ticks = timelineTicks(built.chapters, built.pauseSpans, built.activeMs);
      assert(ticks.length === 2 && ticks[0].activeMs === 20_000 && ticks[1].activeMs === 300_000 - 40_000 - 10_000 + 0, 'ticks are placed on the active clock');
      assert(timelineBlocks(built.chapters, 0).length === 0, 'a call with no length draws nothing');
    },
  },
  {
    name: 'replay model: keys, part jumps, score bands and the overview cut',
    async run() {
      const { playerKeyAction, partJumpTarget, scoreBand, firstSentences, overviewOf, buildReplayModel } = await model();
      assert(playerKeyAction(' ').type === 'toggle' && playerKeyAction('ArrowLeft').deltaMs === -5000 && playerKeyAction('ArrowRight').deltaMs === 5000, 'Space and the arrows');
      assert(playerKeyAction('ArrowUp').direction === -1 && playerKeyAction('ArrowDown').direction === 1, 'Up and Down move between parts');
      assert(playerKeyAction('Enter') === null && playerKeyAction('ArrowLeft', { metaKey: true }) === null && playerKeyAction(' ', { altKey: true }) === null, 'other keys and modified keys are left alone');
      const { chapters, activeMs } = buildReplayModel({ ...REPLAY, pauseSpans: [] });
      assert(partJumpTarget(chapters, 0, 1, activeMs) === 51_000 && partJumpTarget(chapters, 60_000, 1, activeMs) === 161_000, 'next part');
      assert(partJumpTarget(chapters, 398_000, 1, activeMs) === 400_000, 'next from the last part is the end of the call');
      assert(partJumpTarget(chapters, 60_000, -1, activeMs) === 51_000 && partJumpTarget(chapters, 51_500, -1, activeMs) === 0 && partJumpTarget(chapters, 500, -1, activeMs) === 0, 'previous restarts the part unless we are barely into it');
      assert(scoreBand(8) === 'good' && scoreBand(7.9) === 'mid' && scoreBand(5) === 'mid' && scoreBand(4) === 'low' && scoreBand(null) === 'none' && scoreBand('9') === 'none', 'score bands: 8+ green, 5+ amber, below red');
      assert(firstSentences('One. Two! Three?').text === 'One. Two!' && firstSentences('One. Two! Three?').cut === true, 'two sentences, cut');
      assert(firstSentences('Only one sentence here').cut === false && firstSentences('').text === '', 'short text is whole');
      assert(firstSentences('A. B.').cut === false, 'exactly two is not cut');
      const overview = overviewOf({ overall: { score: 6, summary: 'One. Two. Three.' }, priorities: ['a', 'b', '', 'c', 'd'] });
      assert(overview.score === 6 && overview.summary === 'One. Two.' && overview.summaryCut && overview.fullSummary === 'One. Two. Three.' && overview.priorities.join('') === 'abc', 'overview: score, short summary, three priorities');
      assert(overviewOf(null).score === null && overviewOf(null).priorities.length === 0, 'no feedback, empty overview');
    },
  },
];
