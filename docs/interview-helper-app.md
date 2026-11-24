# Interview Helper app

Interview Helper is a macOS desktop app in its own repository. It began as a
node inside Infinite Canvas and was split out on 2026-11-18; nothing is shared
with that repository at build or run time.

| | |
| --- | --- |
| Build and package | `npm run build` |
| Compile only | `npm run build:compile` |
| Run from source | `npm run dev` |
| Tests | `npm test` (`test:unit` runs every suite in `scripts/tests`, `test:scripts` the `*.test.mjs` files) |
| Compiled output | `dist-interview/`, `dist-electron-interview/` |
| Packaged app | `release-interview/mac-arm64/Interview Helper.app` |
| Bundle id | `com.antigravity.interviewhelper` (unchanged, so macOS permission grants carry over) |
| Packaging config | `electron-builder.interview.json` |
| Bundler config | `vite.interview.config.js` |
| Launcher | `scripts/launch-interview-helper.command` |
| Main process | `electron/interviewApp/main.js` |
| Renderer entry | `interview.html` → `src/interview-app/main.jsx` |

The launcher rebuilds only when a file the build read has changed
(`dist-electron-interview/build-inputs.json`).

The build reads its signing settings (`mac.forceCodeSigning`, `mac.identity`)
from `electron-builder.interview.json`, the file electron-builder runs with.
`package.json` has no `build` block.

## Bug reports (built 2026-11-18)

"Report a bug…" at the bottom of the interview list opens a dialog with an
optional description and two actions, modelled on Infinite Canvas.

- **Copy to clipboard** writes the full report to
  `~/Library/Application Support/Interview Helper/bug-reports/bug-report-<time>.md`
  and copies a pointer: the file path, its size and the typed description. An AI
  assistant reads the file from disk. If the file cannot be written, the whole
  report is copied instead. Reports older than 7 days or beyond the 20 newest
  are removed at start and on each write.
- **Save to file…** writes the same report where the person chooses.
- **What a report holds** (`electron/interviewApp/bugReport.js`): versions, open
  windows, each interview (title, career file names, job kind and link,
  preparation state), the Claude worker and its tasks with every step, usage
  pauses, requests still running, AI step counts, the top level of the data
  folder (names and sizes), the practice calls (below), status and error
  messages on screen, the window's events and the main process log of this run.
- **Full content, secrets masked (2026-11-23).** Reports are read on this Mac by
  the owner or Claude Code, so nothing is reduced for privacy: links keep their
  queries, paths and ids stay, captions, chat, prompts, plan text and review
  errors appear as logged. Only credentials are masked (`maskSecrets`: cookies,
  authorization headers, passwords, API keys, tokens, `sk-`/`pk-` keys, JWTs).
  The owner asked for this; an earlier version (2026-11-18 to 11-20) reduced
  content to lengths on the assumption that a report would be shared.
- **The whole run, no caps.** The main process log buffer (`electron/logger.js`,
  20,000 lines plus 5,000 warnings and errors), the main window's events and the
  call and replay windows' events (20,000 lines each) hold a whole run; the
  report shows all of it. Main log lines from before about a minute before this
  launch (left in the buffer by the previous one) are left out.
- **Practice calls.** Every call with a `debug.jsonl` that started during this
  run, newest first; when none did, the newest call
  (`callStore.recentDiagnostics({ since })`). For each: its folder (with
  `call.json`, `analysis.json`, `debug.jsonl`, `call.m4a`), the record's states
  and counts, the review's status and error, the transcript (time, speaker and
  text of each entry) and every line of the debug log: phases, setup steps,
  planner attempts, engine and audio helper events, messages to the interviewer
  sessions, the candidate's actions, the call window's events and each step of
  the feedback review. Then the call and replay windows' own events.
- **Feedback generation is logged step by step** (`analyzeCall` `onEvent`, into
  the call's `debug.jsonl` as `analysis-*`): the transcript and answer counts,
  the transcription (words, duration, error and HTTP status), the metrics, the
  picked cards, each review request (attempt, prompt size, model) and reply
  (accepted with what was kept, rejected with the validation error, or the call
  failing), and the result. Failures and rejected reviews also go to the app log.
  Also logged: the recording step, a wrap-up that throws (`finish-failed`), the
  practice history update, the end of the wrap-up and a failed analysis write.
  The plan note gives the lead's and panel's roles and the unprepared question.
- **A failed review can be run again** from the replay (`retryAnalysis`, the
  "Try again" button): over-long model text is trimmed before validation (the
  trims are logged), the host fills the planned questions from the picked
  cards, and a failed review keeps `candidate.wav` / `interviewer.wav` (and the
  picked cards in `analysis.json` as `retry`) so the re-run can transcribe; with
  the tracks gone it reviews without the word-level transcript. Each reply is
  logged in full (`analysis-review-reply`, `analysis-review-reply-text`).
- **The audio helper's stderr** goes to the app log line by line as
  `[PracticeAudio stderr]` (`onStderr`, passed in from `main.js`).
- **Window events** (`src/utils/eventLog.js`): buttons pressed (by their label,
  interview list entries included), uncaught errors, rejected promises and
  console warnings and errors, in memory only. Keystrokes are not recorded.
- There are no filter codes: the report is one Markdown file to read or search.
- Only the main window can ask for a report (`interview-app:copy-bug-report`,
  `interview-app:save-bug-report`). The practice call window has no button. It
  records its own clicks (by the control's label), screens, errors and console
  warnings (`src/practice-call/callEventLog.js`) and sends each line over
  `practice-call-window:log-event`; the main process adds it to the call's debug
  log and keeps it in memory for the report.

## Saving (2026-11-19)

- **Every change is saved as it is made**; there is no Save step for the app's
  own copy (`interview-helper-sessions.json` in the data folder).
- **Closing the window or quitting** (⌘Q, the menu, or Quit from the Dock icon)
  first asks the window for its newest state and waits for it, then waits for
  every queued write (`saveWindowStateNow` and `flush` in
  `electron/interviewApp/sessionStore.js`). A window that does not answer in
  two seconds is closed anyway. Checked from source on 2026-11-19 by quitting a
  trial copy with a quit Apple event; closing by the red button was not checked.
- **File > Save Interviews… (⌘S) and Load Interviews… (⌘O)** write the list to
  a file the person chooses and read one back. They act on the main window,
  whichever window is in front. The file holds the interview list only:
  career text, Q&A, briefs and recordings stay in the data folder and are found
  again by interview id, so a file loaded on another machine brings the list
  without them. Load replaces the list after a confirmation, keeps the Applied
  Jobs folder of this machine, and first writes the replaced list to
  `interview-helper-sessions.before-load-<time>.json` in the data folder.
- **Both dialogs open on the current save** (built 2026-11-19): the file last
  saved to or loaded from, kept in `save-location.json` in the profile folder
  (`electron/interviewApp/saveLocation.js`). Save offers that same file name, so
  saving again replaces it after the system's own confirmation. Before any
  save or load, or when that folder is gone, Save offers a dated name and Load
  opens where the system chooses. A cancelled dialog changes nothing. Not
  driven through the real dialogs yet.
- **Opening the app shows the list as it was last left**, including which
  interview was selected: the window reads the app's own copy at start. A
  saved file is never loaded on its own; it could be older than that copy.

## Right-click menu (built 2026-11-19)

Every window has one (`electron/interviewApp/contextMenu.js`, attached in
`web-contents-created`). Electron shows none unless the app builds it.

- **On a misspelled word in a text box:** up to six corrections, or "No Guesses
  Found", then Learn Spelling, then Cut, Copy, Paste and Select All.
- **In a text box otherwise:** Cut, Copy, Paste and Select All.
- **On selected page text:** Copy. Anywhere else no menu opens.
- The call window turns text selection off (`src/index.css`); its chat
  messages and the shared screen's title and text turn it back on
  (`select-text` in `ChatPanel.jsx` and `SharedScreen.jsx`, the screen since
  2026-11-20) so they can be dragged over and copied. The screen stays
  read-only.
- The coding pad turns spell checking off, so it gets the edit items only.
- Not yet checked by right-clicking in the running app; the suites cover the
  menu's contents and that a correction replaces the word.

## Text size (built 2026-11-18)

One setting for every window the app opens: the main window and
the practice call (`electron/interviewApp/textSize.js`).

- **The list control is − 125% +.** The percentage is a readout, not a button:
  it used to reset to 100% when clicked, which undid the choice.
- **Where it is changed:** "Text size" at the bottom of the interview list, and
  View > Bigger Text (⌘+), Smaller Text (⌘−), Default Text Size (⌘0). The menu
  works from any window. Steps: 80, 90, 100, 110, 125, 150, 175, 200%.
- **It is a page zoom, not a font size.** Text, boxes, icons and spacing scale
  together, so larger words cannot outgrow a box that stayed small.
- **Windows keep up.** Each window's minimum size is multiplied by the setting,
  a window that is now too small is grown, and a new window opens larger by the
  same factor, all within the screen it is on. A window therefore never shows
  less than its 100% minimum layout (main 720×520, practice
  call 760×520), unless the screen itself is smaller than that.
- **Saved** in `text-size.json` in the profile folder; a missing or damaged
  file is 100%.
- Every window is picked up through `browser-window-created` in `main.js`, so a
  new kind of window needs no code of its own. Give it a `minWidth` and
  `minHeight` at which its layout holds.

## Career data is plain text (2026-11-18)

Career files are used as written. Nothing compiles them into a structured
profile, and no AI call is involved in importing them (the owner's decision:
answer cards are read and edited by hand, and practice interviewers do not need
verified facts).

- `electron/ipc/careerText.js` stores the text of the chosen files as one
  "career snapshot": a private JSON file in `career-text/`, named by the SHA-256
  of the file names and text. Importing the same files again is a no-op.
- The answer writer gets the text as evidence pieces, one per list item or
  paragraph, each starting with the headings above it (for a job, usually its
  title, employer and dates). Contact lines are left out.
- Practice interviewers get the whole text. The practice call greets the
  candidate by the name stated near the top of the text, when there is one.
- **The job is never fitted to the candidate** (owner's request, 2026-11-19).
  A found or generated listing may not match the career data at all, and the
  interview is held anyway. The call planner picks questions, people and
  problems from the role and company alone and uses the career text only for
  probes; the interviewer runs the role's real interview at its real bar, never
  asks why the candidate was invited, and takes "I have never done that" as an
  ordinary answer; the review judges against the role and counts an honest gap
  as a gap, not as a bad answer.
- **Honest-gap answers** (`electron/ipc/interviewAnswerGap.js`, stage
  `qa-gap-answers`, built 2026-11-19). After
  the answer writer and the topics step, Prepare offers every card that is
  still empty to one more call, with the career text. A question the career
  text does not answer at all gets a gap card: an admission ("I have not
  done X"), at most one closest-experience line tied to one career piece, and
  two or three reminders on how to carry on. The host refuses an admission
  that denies nothing or holds a number, a closest line with a number its
  career piece lacks, and reminders that describe the person. A question the
  career text can answer is not a gap and stays empty for the answer writer.
  The card is stored with `gap: true`, shows "Honest gap" in the Q&A panel and
  leads with the admission; an edit makes it an ordinary card.
  The answer writer keeps only questions it can answer, so a job far from the
  career often leaves no empty card. So once each time the posting's tab is
  written (`gapQuestionsGeneratedAt` in the posting's Q&A file) the same call also
  names up to five experience questions the role's interviewers would ask that
  the career text cannot answer, from the role themes and the listing; they are
  added as posting cards with their gap answers, and a deleted one stays away
  until the tab is emptied and written again. Live check from source, 2026-11-19: a music teacher's career
  against a found Shopify Site Reliability Engineer posting. The first Prepare
  (before role questions existed) wrote no gap card; the second added two
  ("debugged a problem in a production software system", "contributing to open
  source projects"), each with a correct admission. One live run only: how
  often a real experience is wrongly called a gap is not measured.
- A snapshot compiled before the split is still readable from
  `career-snapshot-store/career-snapshots`, so an interview prepared then keeps
  working. Nothing writes that folder.
- Prepare no longer runs the AI wording review (entailment) or the final
  fact-check. The host's own checks on a card (citations, numbers, card shape)
  and up to two repair rounds remain.

## Saved Q&A

The Q&A is always on screen in the side panel, in three tabs.

- **General**: questions asked at every interview, one set shared by every
  interview. (The internal scope name is still `foundation`.)
- **The company and posting**: one set per job posting, keyed by the company,
  the posting link and the role title (`interviewQaPostingKey`). Two interviews
  for the same posting share the set; two roles with the same title but
  different postings do not. The first interview bound to a posting brings the
  set it already had.
- **Technical topics**: subjects only, with no prepared answers, because the
  answer depends on how the question is asked. Prepare writes the list once per
  posting from the listing; after that only the person changes it. An unanswered
  question from the posting or from reported past interviews that the AI marks
  technical becomes a topic and its empty card is removed.

Each tab has a Clear all button that deletes everything in it after a
confirmation popup. It counts as deleting each item: an emptied General or
posting tab is written again by the next Prepare, and cleared topics stay gone.

General Q&A is one file (`interview-helper-qa/foundation.json`), not part of
any interview: deleting an interview never touches it. When a Prepare writes
Q&A the main process sends `interview-app:qa-changed`, and the Q&A panel on
screen reloads, whichever interview it shows.

Prepare writes Q&A only for a tab that has no cards (owner's request,
2026-11-19). It looks at General and at the posting's set separately and writes
the empty ones; a tab that holds any card, generated, edited or added by hand,
is left exactly as it is: no new question, no added wording, no filled answer
and no approach reminder. A card added by hand before
the first Prepare makes its tab count as not empty. To have a tab written again,
delete every card in it: its deleted questions then return, and for the posting
the role's honest-gap questions are written again. While a tab has cards a
deleted question stays away. Technical topics are a separate list: written once
per posting, never again, and a deleted topic does not come back. Reported past
interview questions and technical topics belong to the posting, so those steps
run only when the posting's tab is written.

A Prepare with at least one empty tab writes one full answer set and seals it on
disk; only what is saved to the tabs is limited. The sealed set is what the Q&A
fill, the honest-gap answers and the reuse check below work from (it must hold
the required introduction; before 2026-11-24 the two required General questions), and its card count is the "prepared
answers" number the panel shows. Nothing else reads it. **A Prepare with no empty
tab is research only (2026-11-20):** the answer set would be thrown away, so it
is not written (no answer-writer call, no repair rounds); the reply has
`answerBankAvailable: false`, `answerCardCount: 0` and `qaKept: true`, and the
panel shows "Research ready" and points to the Q&A tabs. A first Prepare on an
interview reuses a finished preparation of the same career data, posting and
application when one exists; a research-only preparation is reused only while
no tab is empty, since an empty tab needs answers. "Prepare again" reuses too
when both tabs have cards, so it then calls no AI and the panel says nothing was
generated; redoing the research needs an empty tab or changed inputs. With
changed inputs and both tabs holding cards, only the research is prepared again
and the tabs are kept.

**Failure reasons (2026-11-20).** Claude's safeguards stopped Prepare research on Opus high for a Moderna protein-design posting twice in a row (refusal category `bio`), and the window only said "Preparation did not complete". A failed Prepare now keeps its fixed error code: the main process sets it on the generic error, the window stores it as `interviewHelperPreparation.code` and shows a specific line (safeguards, Parallel out of usage, usage limit, timeout, sign-in), and the bug report's Preparation column shows it, for example `failed (CLAUDE_SAFEGUARD_BLOCKED)`, after a restart too. There is no model fallback: the owner chose to show the reason rather than retry on Sonnet (2026-11-20).

**Cancel preparation (2026-11-19).** While a Prepare runs, its status card
shows Cancel to the right of Pause & save (and of Resume once paused); the panel
has no cancel button of its own. It calls `cancel-interview-brief` with the run
id, which aborts the signal every Claude call of that Prepare
holds, so the call in flight stops and no later step starts. The handler
answers `{ cancelled: true }` instead of failing. The node goes back to what it
held before (the earlier brief, or nothing) and the run is retired, so there is
nothing to resume. A hold from Pause & save on that run is released with it. Steps that had already finished keep what they saved: a
sealed brief or answer set stays on disk, and Q&A cards already written stay in
their tabs.

**The call stays in the fiction (2026-11-19).** From the ring to the hang-up
nothing the candidate sees or hears says practice, AI, voice, transcription or
this app: the ring screen reads "Incoming call", the window is titled
"Virtual Call" in every phase, setup and review included (`CALL_WINDOW_TITLE`
in `src/practice-call/callModel.js`), never the app's name, mid-call
notices and errors are worded as connection problems, and the prepared answers
panel is labelled "Notes". The interviewer's instructions tell it that the call
is real, to answer "are you an AI?" in character, and to give no feedback or
coaching. A brief with no team names none (no "the hiring team"). The screens
before the ring and after the hang-up do not say practice either (they keep
the disclosures: what is downloaded, that the voice is AI, that feedback uses
AI). While the call window is in front
the menu bar shows a short call menu (`callMenu` in
`electron/interviewApp/main.js`, passed to the call window; off in the unit
suites); the app name in the menu bar cannot change per window. The pause
notice is a translucent overlay in the middle of the window. New text shown or
spoken during the call must keep to this; the render and prompt suites assert
it.

**Suggest a reply (testing aid, built 2026-11-20).** The call chat has a magic wand
button, "Suggest a reply", left of Send. It asks Claude for the candidate's reply
to what the interviewer last asked and puts it in the chat box with the cursor
at the end; it is never sent until the person presses Enter. The reply is
written from the career text (read once per call from the snapshot), the job
listing text of the prepared application, the brief, the submitted résumé and
cover letter, the prepared Q&A answers, the open pad and the last 40 turns of
the conversation, and the shared screen (the one shown, else the last one shown,
added 2026-11-20 after a suggestion said it could not see the screen)
(`electron/practiceCall/draftAnswer.js`, `draftAnswer` in
`callService.js`, window channel `draft-answer`). Nothing checks it against
the career text: it only has to move the interview on for manual testing. The
prompt keeps the candidate in character (never mentioning documents, notes or
what it can say) and has it make up plausible detail the documents do not
cover, consistent with them and with the conversation (2026-11-20, after a
reply said "my documents don't give me" a reason).
Stage `practice-call-draft-answer`, Sonnet at low effort, chosen by reasoning
and not measured (the person waits on it mid-call and accuracy is not
checked). While it is being written the candidate counts as typing, so the
interviewer waits; hanging up aborts it. Pausing does neither: the button
stays enabled while paused and a reply already being written finishes and lands
in the box (2026-11-20). The service refuses it unless the app
passes `draftText` in (`main.js`), so the unit suites never call Claude.

**Suggested replies are written to be heard (2026-11-21).** Since a sent message is spoken, Suggest a reply now writes what the candidate would say out loud: no note-style labels with a colon ("Short version: …" becomes "The short version is that …"), no paragraph breaks, numbers said the way people say them. Its conversation view no longer marks a spoken message as typed, and `cleanDraft` joins any paragraph breaks into one flowing reply. Measured 2026-11-21 (26 real prompts × 2 runs per arm, Sonnet low, two blind judges; `docs/ai-model-selection.md`): note-style labels 14 of 52 replies before, 1 after; unit symbols 17 to 1; quality 5.88 to 6.42 (paired +0.55, se 0.19, both judges the same way); latency and cost unchanged. The prompt alone still left paragraph breaks in 39 of 52 replies, hence the code join; 29% of replies still run past 250 words.

**The wand works coding exercises (2026-11-21).** With the coding pad open, the wand no longer only talks about the code: it drafts the work as steps (`draftCandidateWork`, stage `practice-call-draft-work`, Opus low, passed in from `main.js` as `draftWorkText`), each a line said out loud and the whole pad after it. The window says each line in the candidate's voice and types the code into the pad key by key, after the line or, when the step chose to (`typeWhileSpeaking`, the model's call per step), while the line is being said, through the pad's own edits (`padTyping.js`, the `typerRef` on `CodingPad`), so the interviewers see it exactly as typing. The steps follow the usual advice for live coding: restate and state assumptions, give the approach, narrate intent before each piece (never read code aloud), test the example by hand, then say plainly that it is done (the interviewers treat the code as final only then). When an interviewer starts speaking it gives way exactly as a spoken answer does (owner's request, 2026-11-21): the engine announces each start (`floor`, with the reaction time it draws, 0.3 to 0.9 s), a voice line is cut at a word boundary as before, and typing stops after that same reaction time at the end of the word being typed, even mid-piece; when it is talking and typing at once, both stop together. What was typed stays in the pad. The wand is always a go button, never a stop button: pressed while it works, that run ends where it is and a fresh draft starts from the pad as it stands, which is also how it answers an interviewer and carries on after giving way.

**The wand answers a question mid-exercise and waits (2026-11-22).** In the Google DeepMind call of 2026-11-22 Kofi asked, mid-exercise, why positive latencies mattered; the wand answered and went straight on typing and saying what it would code next, before he had said whether the answer was enough. The work reply now has `waitForReply` (required in `DRAFT_WORK_SCHEMA`): true when an interviewer has just put a question that only needs answering and has not yet said to carry on. Then `cleanWork` keeps only the first spoken line, with no code, so the candidate answers with hands off the keyboard and stops; the next press of the wand, after the interviewer confirms or moves on, carries on from the pad. A pointed-out bug, a hint or a request to change something is not such a question: the wand acknowledges it and carries on as before. Unit-tested only, not yet seen in a call.

**Any language unless one is required (2026-11-22).** The same call showed "python" beside the pad's title and "Write the code in Python" on the screen, though nothing in the role or the problem needed Python and nothing checks the language. A prepared problem's `language` is now empty unless the answer must be in one language (the role is hired for it, or the problem tests a feature of it), and the planner writes coding problems language-neutral. The interviewer prompt receives `requiredLanguage` for such a problem and `language: 'any: the candidate chooses'` otherwise, and is told to name no language, on screen, aloud or as the pad's `lang`, unless one is required. The service enforces the label (`padLabel` in `callService.js`): when the plan has prepared problems, the pad shows a language only when one of them requires it, by the problem's own name for it (the interviewer's "JS" or "cpp" is matched through `languageKey`); a label naming no required language shows the one required language when there is exactly one, else nothing. A call without prepared problems keeps the label as written. Unit-tested only.

**The candidate picks the language (2026-11-22, owner's request).** When the exercise leaves the language open, the interviewer is now told to say that any language is fine (and that the pad lets them pick), and the pad's title has a Language dropdown instead of a label (`CodingPad` `choice`/`onChooseLanguage`; the list is `src/practice-call/padLanguages.js`, shared with the main process). A first pad starts on the candidate's last pick (`practiceCall.padLanguage` in the window's localStorage) or Python. A pick goes through `setPadLanguage` (preload, `set-pad-language`), which takes only a listed name, stores it as `state.pad.choice`, logs `pad-language` and keeps it in `call.json` as `pad.chosen` (only while no language is required); the replay shows it as the pad's label. The wand writes every piece of code in that language only, says once in passing which language it is using (unless it already did), and rewrites code already in the pad when the pick changed. The interviewers are not told of the pick: they hear it from the candidate and see the code. A required language is a label with no dropdown and wins over a pick. Render- and unit-tested only, not yet seen in a call.

**A pick among the languages the role is hired for (2026-11-23, owner's request).** A typed "c++ embedded engineer at a famous company" became an Apple listing asking for "C and C++", and the planner required C alone, so the pad was a fixed "c" label. A problem now has `languages` beside `language`: when the role is hired for more than one language and the problem tests none in particular, the planner leaves `language` empty and lists them (names from `padLanguages.js`; the validator keeps listed names once each, turns a single one into the required `language` and drops the list when a language is required). The interviewer prompt gets `languageOneOf` for such a problem and says which languages are allowed without naming one to use or a pad `lang`. The service publishes `state.pad.options` (`padOptions`/`syncPadOptions` in `callService.js`): the languages of the prepared problem whose part is on screen (matched by title and content, as shown or as planned); empty means every listed language. The limit belongs to the exercise: while the pad stays open it holds through a stopped share or a screen the interviewer wrote (a follow-up), closing the pad ends it, and a pad opened for a screen of the interviewer's own offers every language. With the pad left open, a screen of their own is a new exercise when they opened the pad again with it (the prompt says to; either tag may come first, within `SAME_REPLY_MS`) or after they moved on to another planned question (`question-asked` for a number other than the problem's). With nothing on screen, a plan with one problem means that problem. `setPadLanguage` takes only an offered name, a pick that is no longer offered is dropped and the window picks again (the saved pick when offered, else the first offered), and a pick among offered languages is not saved as the candidate's preference. A label the interviewer writes for an offered language is not shown. Render- and unit-tested only, not yet seen in a call.

**The AI writes the pad's languages; the app keeps no list (2026-11-23, owner's request).** The dropdown enforces nothing: it is there to show the language and to tell the wand what to write in, so a fixed list only got in the way of a role hired for a language it did not hold (Eiffel). This replaces the list parts of the two paragraphs above. `padLanguages.js` no longer names any language; it holds only `padLanguageNames`, which cleans what the model wrote (one line, 40 characters, each name once whatever its case). The planner's `languages` is free text with no enum, and the validator keeps up to six names as written. The pad then shows one of three things: a label for a required language (one name), a dropdown of exactly the offered names (two or more), or no language at all when the exercise leaves it open (nothing written). The Python default and the remembered pick in the window's localStorage are gone. The service owns the pick (`syncPadOptions`): it starts on the first offered name, comes back to the candidate's own last pick when that is offered again, and is empty when nothing is offered; `setPadLanguage` takes only an offered name. With no language required and none offered, the wand chooses: the language of code already in the pad, else one the candidate named in the conversation, else one that suits the role and the exercise, said once in passing. The interviewer is no longer told that the pad lets the candidate pick when any language is fine. `LANGUAGE_ALIASES` in `callService.js` stays: it only matches an interviewer's spelling of a required language ("cpp") to the plan's name for it, and an unknown name is compared as written. Render- and unit-tested only, not yet seen in a call.

**Interviewers wait for each other (2026-11-23, call-mwtb4q1v-9xcsen).** Every hand-over between interviewers in one reply had 0.18 to 0.38 s of quiet, heard as one mind speaking. A plain hand-over now leaves 1.2 to 1.8 s after the other's speech ends, drawn each time (the engine's own two waits before answering the candidate); an interruption between interviewers still overlaps. See docs/interview-practice-call.md, section 9. Unit-tested only, not yet heard in a call.

**The planner spent a scarce technical pick on a listed subject and narrowed the languages silently (2026-11-23, call-mwtb4q1v-9xcsen).** An Eiffel job (listing duties: documentation and code for Eiffel programs; requirements: C/C++, Eiffel, UNIX, Linux) in a five-minute call with one coding question had thirteen technical topics in the pool. The planner spent that one exercise on the "C/C++ programming" topic, wrote a generic balanced-delimiters problem with a C signature and offered only C and C++, so the language the work is done in was not even offered and nothing tested C or C++. Two gaps in `buildPlanPrompt`: step (a) said "pick a few topics" but not which when there is room for one or two, and step (i) let a language topic narrow the languages. Now (a) spends scarce technical picks on what the role's work mainly is (the listing's duties, what the company's product is built in or about) before a subject only listed among requirements, still rotating by timesAsked and never judging the candidate; (i) says an exercise under a language topic either really tests that language (restricted and says so) or is general and offered in every language the role is hired for, the main one included and first, with signature and examples reading in each; a topic naming a few closely related languages restricts to those, in "languages"; a role whose code is written in one main language and partly in others counts as hired for more than one, while a query, shell or markup language the listing only mentions does not unless the exercise is about it. The "languages" schema description says the main language comes first. Prompt only; unit-tested for the text, not yet seen in a call.

**The planner and the interviewer now see what earlier calls asked under a topic (2026-11-23, call-mwtb4q1v-9xcsen).** A "[Technical topic]" pool item has no fixed question, and until now the planner saw only `timesAsked` for it, so when the topic came round again nothing stopped the same exercise being written (that call's "C/C++ programming" topic got a balanced-delimiters problem). `practice-question-history.json` keeps, beside the counts and under the same job key, `asked: { [topic id]: [{ text, at }] }` (at most 5 per topic, newest last) and `own: [{ text, at }]` (the planner's own questions, at most 8); each text is one line of at most 300 characters, cut at a word end, and an identical text (case and spacing aside) is stored once and refreshed to newest. At hang-up the service notes, for the job only, every topic that was asked and answered (its prepared problem's part titles and the start of part 1, else what the interviewer said when it asked it, from the engine's `askedTexts`; nothing when neither exists) and the planner's own question when it was asked (with its problem's part titles). Notes never add a count, and a failure to keep them is only warned. The planner gets them under the topic as `askedOnEarlierCalls` and in a block of its own earlier questions (told the new exercise or question must be a different problem on different ground), and the live interviewer's plan view carries `askedOnEarlierCalls` as private bookkeeping, never to be mentioned, only for a picked topic it must still make up a question for (`interviewerPoolOf`): a topic whose exercise the planner prepared is asked as written, and shown the notes the interviewer would be told to differ from the problem it was handed. The spoken text is read when the call ends, not when the reply is committed, so a reply still streaming then is noted whole and one that was cut by what was heard. `adopt` carries notes even when there are no counts. Fixed prepared questions need no note: their wording is the same every call and the count says it all. A held-again interview skips the planner, and its interviewer gets none. Unit-tested only, not yet seen in a call.

**Voices and the asked tag (2026-11-22, call-mws8wx6g).** The library's gender label is the uploader's and can be wrong: the male candidate voice drawn was "Belle B - Natural AI Companion", labelled male but described as "her". A library voice whose name or description speaks only of the other gender is now never drawn (`contradictsGender`, voiceCatalog.js), and a retake of a kept interview draws again any candidate voice missing from it (never a built-in voice, as on a new call) and, once answered, keeps it with the interview (`touch` with `candidateVoiceIds`). The interviewer said its reasoning about the unprepared question's tag out loud ("unnumbered, no asked tag"): that question is now Plan question 0 and is tagged like any other (the engine ignores 0), and the prompt says every word outside a tag is spoken. Unit-tested only.

**No gap between the wand's lines (2026-11-22).** Each candidate line gets delivery tags from a short AI call (about 2 s) that began only when the line opened, so the steps of a worked exercise had about 2.4 s of silence between them, and the review counted those gaps as the candidate's own pauses (8 over two seconds in that call). When the work steps arrive, the service now has them all tagged at once (`prepare` on the candidate voice); `open` takes the tags for the same words, and a line nobody prepared is tagged as before. Unit-tested only.

**Fixes from the call of 2026-11-22 (call-mwsdnl2g).**
- *The pad opens with the problem.* The interviewer shared the problem, then said "there's a coding pad open beside it too" at the end of the line, so the pad came up 13 s after the problem. A pad open later in the same reply (with no other screen, stop or pad change between) now goes up with its screen (`padWithScreen` in the engine); the service already holds a pad until a share that is still being set up appears.
- *The Language dropdown never showed.* The call window built its own API object for the call screen and left `setPadLanguage` out, so the pad had no dropdown and no pick was ever made (the render tests passed the API in directly). It is passed through now, with a test through the window's entry point.
- *The wand's exercise lines went untagged.* The seven steps were tagged ahead as seven Claude calls at once and every one ran past the 4 s limit. Lines prepared ahead now go in one call (`tagCandidateLines`, numbered straight through, up to 15 s), and each line waits at most 4 s from its own start.
- *The interviewers see the code while the candidate talks.* The main session already got the pad every 25 s while it changes, 12 s after typing stops, and with every turn, but only in gaps in the candidate's speech; the cut-in watcher, which looks during speech, never saw it. The watcher now gets the open pad whenever it changed since its last look, and may cut in on what is written (a bug, an approach that cannot work, code that does not match what is said), though usually it just watches.
- *The interviewer hears the words that were sent.* A line in the candidate's injected voice reached the interviewer as the recogniser wrote it ("A cell loop counters a cycle" for "A self-loop counts as a cycle"). The messages to the sessions now give such a line as its sent (or, if cut, heard) words; counts and comparisons still use the recognised text, and the transcript keeps it.
- *The review blamed the candidate for the wand's typing.* The recogniser joined the seven exercise lines into one 116 s entry that no single line covered half of, so it went unstamped and was judged as live speech (a 95 dB loudness change against an empty baseline, "silent stretches of 18 and 12 seconds"). An entry now counts as generated when the generated lines together cover half of it, with their texts joined as `sentText`.
- *Long silent typing.* The wand typed a piece for 17 s in silence. Its prompt now says typing takes real time and that a candidate talks through a longer piece or writes it in smaller ones (the choice stays the model's).
- *The watcher's question label.* After the exercise was answered, every later line (follow-ups, the interviewer's own question, the closing) reached the watcher as "plan question 19", so it judged them against the exercise's 7 minutes; the interviewer's own question (tagged 0) was never told apart. The watcher now gets the plan number of the interviewer's latest line only when that line tagged one (0 included), and otherwise "not a plan question (a follow-up or other line; the last plan question asked was N)", judged by the rough norms.
- *A dropped reaction meant silence.* "Right. That's followed." was dropped whole for repeating "followed", and the interviewer was silent 3.1 s instead of about 1.7 s. A reaction is now cut at its first sentence that repeats a recent one, and what came before it ("Right.") is still said (`cutFrom` on the opener event); a reaction whose first sentence repeats is dropped as before.
Unit-tested only, not yet seen in a call.

**Fixes from the call of 2026-11-22 (call-mwsri09o, Cisco database operations).**
- *Asked about half-typed code, and the work left half done.* The candidate said "I'll add that as a comment for reference" and kept typing a portable version into the pad. The interviewer, told nothing of the typing, asked about that version 1.7 s later; the wand stops typing when an interviewer takes the floor, answered the question and waited (as designed), and nobody handed back, so the comment stayed at `ROW_NUMBER() OVER` to the end. A candidate turn that begins while the pad changed in the last 2.5 s (`padTypingMs`) now carries `[coding pad: the candidate is still typing as this line ends]` and gets no quick reaction first (a reaction is the interviewer taking the floor, which stops the typing). The interviewer is told such a line is usually thinking aloud, to <listen/> unless a real interviewer would stop someone mid-typing. When an interviewer does start speaking while the pad is still changing, the next three replies carry `[coding pad: the candidate stopped typing when an interviewer began speaking over their work …]` until the pad changes again, and the interviewer is told to settle the unfinished work: hand back, ask more first, or say in passing it can be left (its choice). The same rule now covers a spoken answer cut into on a live look. The wand leaves the unfinished part alone when told it can.
- *The exercise counted as never asked.* The colleague shared the prepared exercise for a topic card without an asked tag, so the review listed the card unasked. A prepared problem now carries its plan question number to the engine, and showing it counts that question asked.
- *5.6 s of silence before a reply.* The reaction "Right, that landed fine." was dropped because an earlier one began "Right, I followed": "right" (five letters) counted as a content word. "Right" and "alright" are now free like "okay" and "mm-hm"; the two-word opening check still stops a repeat.
Unit-tested only, not yet seen in a call.

**Fixes from the call of 2026-11-23 (call-mwsvsqmu, Apple embedded C screen).** An audit of the call (seven reviewers, each finding checked by a second) and a review of the fixes. Unit-tested only, not yet seen in a call.
- *The feedback failed on length.* The review was rejected twice: a summary over 1,500 characters, then the plan's own 311-character question, which the model is told to copy and which was limited to 300. See the bug report section: over-long text is trimmed, the host fills in the planned questions, the model is told the limits, the correction names every violation, and a failed review has Try again.
- *The lead's farewell came out in the colleague's voice.* The quick reaction is voiced by whoever spoke last (the colleague); the main session was not told, wrote the lead's thanks and next steps with no speaker tag, and all of it was spoken as the colleague. The "already started your reply" note now names the voice on a panel and says untagged text stays in it; the reaction writer is told whom it speaks as when that is not the lead, and gets a reply several people spoke in by speaker.
- *Who says goodbye is the AI's choice.* The lead closes under their own tag; whether nobody else, one colleague or each of them adds a goodbye (one after another, or over the lead's last words) is chosen fresh each call, each under its own speaker's tag. There is no default number.
- *Reactions.* "Mm-hm, I've got it." was said before answering the candidate's own question, and three of five reactions claimed to have followed. The reaction rules no longer offer "followed"; a question gets a small sound of taking it up. A warm reaction (thanks, lovely) is dropped only right after another or for the same word: "Right, thanks for walking me through that." had been dropped for a "lovely" said 283 s earlier, leaving 3.9 s of silence.
- *The wand explains before, during or after typing* (owner's request). Each step of a worked exercise chooses `explain`: "before" (line, then silent typing), "during" (the hands start with the voice and the keys are paced to the line, within 1 to 1.8 times a person's delays (never faster than a person, since call-mwttebvu), `typingPace`) or "after" (silent typing, a 1.5 s look, then the line about what was written). A step starts only when the one before is both typed and heard, so the words are always about the piece being typed, just typed or about to be. A "before" step followed by an "after" step would put two silent stretches back to back, the second read as more of the first: that "after" step carries a `bridge`, a few words of the model's own that mark the move to a new piece without explaining it, said between them (`cleanWork` makes it a line of its own; with none written the piece is explained while typed). The prompt gives the real typing and speaking pace and says a line is about its own step's code.
- *The run is logged.* The `draft-answer` event holds every step (order, line, code in pieces of 1,900 characters), and the window logs each step's start, typing start and end, line heard, any drift over 3 s in a "during" step, and why a run stopped. The pad is sent when typing ends and about once a second while it runs (it had lagged the last keys).
- *The wand's lines.* No quoted example sentences are left in its prompts (the closing example had been said word for word); a self-description already given is not repeated ("I'm coming from the software side" was in four of six replies); its own earlier lines are shown as sent, not as recognised; a follow-up gets a short answer; thanks for the interviewers' time are said once, at the close; values are named, not recited digit by digit.
- *Lateness fits the call.* The colleague who owned the only exercise of a five-minute screen joined at 2:52. Whoever asks the plan's first question is now there from the start, and a late join comes within a quarter of the planned minutes. The planner's own question carries no words of order ("One last thing" had been written into a question that was then asked first).
- *Replay.* The pad's record marks its opening and its closing (`closed: true`), so the replay shows it from when it came up and takes it down; a turn several interviewers spoke in is credited to whoever asked. Response time is not measured for a wand line, and gaps between wand lines are not counted as the candidate's pauses.
- *No example lines to say in the interviewer prompt* (owner's decision, 2026-11-23). A line a prompt quotes as something to say gets said: the colleague took a question with the prompt's own example words. The interviewer prompt's examples of things to say (hand-overs, fillers while a screen comes up, deflections, the pick-up after a cut-in, the answer to "are you an AI?") are now descriptions. Kept: lines that must never be said, how tags are written, and the planner's examples of description text. Not changed: the quick-reaction prompt, which was measured with its short example sounds and needs measuring again before they go.
- *Left as it is:* the interviewers ending the exercise after part 1 when the time was up, and the call window staying open after the interviewers leave until Hang up.

**Both voices are judged alike and named (2026-11-23, owner's request).** An answer in the AI voice and one in the candidate's own voice get the same standard, delivery included. This replaces the earlier rule that an AI-voice answer was judged for content only. On a call that used the AI voice the review prompt marks each spoken candidate turn and each answer's metrics "AI voice", "own voice" or both, the delivery summary says which answers were which, and the replay labels each part ("Answered in: AI voice"). Pitch and loudness are still compared within one voice, and the wand's own waits are still left out of the numbers.

**Fixes from the call of 2026-11-24 (call-mwua5djj, AECOM archaeologist screen).** The call ran to its goodbye, its recording and its feedback. Unit-tested only, except that the two timing constants were checked against this call's log; no prompt change was measured in a live run.
- *A look started too early.* After a whole voice line the look waited only for the newest recogniser segment to be final; the line's last sentence had no segment yet, so a reaction and a reply were written and thrown away (2.7 s to the first sound instead of about 1.9). It now waits until a segment reaches the line's end (`lineHeardToItsEnd`), still at most `injectFinalWaitMs`.
- *A cut-in reported as none.* An answer cut at a breath with a tenth unsaid was recorded `cutWhileSpeaking: false`, and feedback said there were no cut-ins. A voice line with a tenth or more of its words left is now still speaking (`injectedMoreToSay`).
- *"…isolate. ST".* The broken-off start of a cut line's next word no longer joins the candidate's entry (`brokenOffWord`).
- *Pace and pauses.* Silences inside one wand line were taken off the clock as if between two lines. Entries carry `lineSpans`, and only the gap between lines is left out; older records are measured as before.
- *Late joiner.* The note says how long ago they came in, so someone who sat through an answer is not introduced as just arrived and told about it.
- *Cut-ins, deflections and review.* A cut-in is written to still make sense after the candidate finishes the thought. The deflection rule no longer supplies a reason to give (it contradicted "never explain"); a referral is made at most once, and a specialist talks about their own field. The review looks for a term in the candidate's lines before saying they used or missed it.
- *Planner.* An exercise's data is checked against itself (the key named one unbagged find of several, judged by an undefined APE, and put a test unit on top of a shovel test), and a question's minutes cover reading, the answer and follow-ups (four questions were planned in ten minutes; three were reached).
- *Logs.* `plan-full`, `participant-joined` and `participant-left` are logged; the plan's `attempts` is `failedAttempts`. Question-history notes drop bold marks.
- *Left as it is:* a quick reaction that says it sees or follows: that prompt is measured and has a size limit, so it needs a measured change.

**Fixes from the call of 2026-11-23 (call-mwu3jble, IBM HLASM screen).**
- *The answer reached the watcher several times over.* A line still being spoken was matched to each recognised sentence as a new object, so it was repeated once per sentence. The cut-in look's "Most recent" also now uses the words sent, like the rest of its message.
- *The replay showed the pad 5 s before the problem.* A pad taken back for a share coming up left its record mark behind.
- *The bug report squeezed spaces,* which hid the column layout of code, the call log turned every link into `[path]`, and "AI steps since the app started" read a counter nothing raised (it now lists each answered AI call).
Unit-tested only, not yet seen in a call.

**Realism changes after call-mwu3jble (2026-11-23, owner's request).**
- *Starter code.* A prepared problem on given code carries `starter`; the pad opens with it, the engine is told it is not the candidate's work (`seedPadText`), the record marks it (`starter: true`), and the interviewer, the wand and the review know it was given.
- *A verdict on a technical answer is the interviewer's choice* (neutral, a word that it works, or shown by the next question), no longer forbidden in one rule and allowed in another. The quick reaction never gives one.
- *Goodbyes* belong to the main reply. The reaction and the reply had each said one.
- *Time.* Nobody claims time is short before the wrap-up time, and the planner's question budgets leave room for the greeting, the candidate's questions and the goodbye.
- *Quick reaction.* "[audio: sounds unfinished]" is explained as a guess the words overrule, and a reaction already arriving at the 1.5 s deadline gets 0.4 s more (`openerGraceMs`). Its instructions are about 4,900 characters (the test's bound is 5,000); on four recorded calls, old and new prompt in turn, first-word time showed no clear difference beyond a noisy service.
- *The candidate's voice* is the planner's pick among three drawn per gender, by description.
- *Replay markers* sit where the reviewer's quoted words were said (`momentAtMs`), else at the turn's start.
- *Planning time, left as it is.* The recorded test of 2026-11-20 already had Flash low: 48 to 122 s on the long case against 91 to 108 s for high, so not dependably faster, and judged 7.50 against 8.12. Flash medium has not been measured.
Unit-tested only, not yet seen in a call (the quick reaction also ran against real recorded lines).

**Lines that ask nothing (2026-11-23, owner's request).** After answering the candidate's questions at the end of call-mwsri09o, the panel ended on a statement and sat silent 18.5 s until the candidate spoke; the only thing that would have broken the silence was the 20 s check-in, whose first step nudges the candidate as if they had missed a question. An interviewer may now end a reply on a statement (an answer, a point, a reaction) and leave room, as people do; whether to is its call each time. Such a reply ends `<wait s="N" statement/>` (N from 3 s, usually 3 to 8). If the candidate says nothing by then, the interviewer gets `[candidate silent Ns after your last line, which asked them nothing]`: not a check-in and not counted, so it picks the conversation up itself (checks the answer landed, offers more, moves on) and never nudges or asks whether they can hear. One such carry-on per quiet stretch; if the candidate stays quiet after it, the usual check-ins run. The transcript entry carries `statement: true`; the review marks the turn "(asked nothing; left room for a reaction)" and is told not to fault the silence after it, and no response latency is measured from such a line. Unit-tested only, not yet seen in a call.

**Fixes from the call of 2026-11-23 (call-mwt3ga4p, Apple embedded C++ screen).** An audit of the call (six readers, each finding checked by a second against the log and the code) and a review of each fix. Unit-tested only, not yet seen in a call.
- *The wand's typing was stopped after 2.3 s.* The window sent the pad a full second after a typing run began, so a turn that began 0.78 s in (the recogniser closing the line said just before) found no typing: the quick reaction "Right, go ahead." was spoken, took the floor and stopped the typing at `#include `. The first key of every typing run is now sent at once (`sendFirst` in `CodingPad.jsx`), so the "still typing" rule of call-mwsri09o applies from the first key; the engine logs `pad-edit` when a burst of typing first reaches it.
- *The "stopped typing when an interviewer spoke" note survives the last keys.* The keys typed while giving way (the reaction time and the end of the word) counted as the candidate going back to the work and cleared the note. For the reaction time plus 2 s after the floor (`PAD_HALT_GRACE_MS`) a changed pad now moves the halted text along; an edit after that clears it as before.
- *A cut-in is not delivered into the next line.* The watcher chose to probe the loop explanation at a sentence end; the sentence it judged was already over, so the hold released on the first sentence end of new speech, six seconds later and one sentence into the hand test, which ended the walkthrough. When the judged text already ended a sentence, the cut-in is now dropped as stale if more words have been heard since (`dropped: 'sentence-over'`, and the watcher looks again), and is made at once if none have.
- *The watcher keeps the question.* After "Right, go ahead." every look showed that reaction as the question asked, without the exercise, its plan number or its minutes. A reply that was only a reaction (no plan number, no question mark, no screen or pad change, nothing beyond the reaction's words) no longer replaces the question the watcher is shown.
- *The wand.* Its prompt gives a number for silent typing (about 8 to 10 s, 90 to 100 characters then; roughly fifty characters since the hands were slowed after call-mwttebvu, the signature at most for a first piece; the order stays the model's choice, and nothing in code enforces it: the first run had planned 21 s). Both wand prompts get the call's time facts when known (elapsed active time, planned length, the minutes planned for the question) and a rule of its own that a question asked as quick or last, or with time nearly up, gets a short answer whatever the usual ranges (a 49 s answer had been given to a last quick question at 4:56 of five minutes). A topic the documents never touch is answered as a candidate prepared for the role would, without disclaiming experience.
- *The review's clock.* Every time the review prompt shows (turns, screens, tone, joins, cut-ins, answer times in the metrics) is on the active clock with pauses removed (`analysis/activeTime.js`), the clock the replay shows; after the 55 s pause every quoted time had been 55 s off.
- *The review's judgement.* Planner probes are labelled as possible probes; one that was never asked, and a check the interviewer cut short or ended, is never a priority, gap or improvement (two of four priorities had come from unasked probes). What the screen states is a given, not the candidate's assumption; the review says when the interviewer ended an exercise and what was not reached. An admitted lack of experience is named as a gap for the role in that question's entry. Pace differences between answers are not praised or faulted.
- *Numbers.* Pace for wand answers leaves out the gaps between wand lines. A voiced entry (`voiced: true`, no channel) is not live speech, so a call with no live speech runs no transcription. The Closing chapter begins at the farewell inside the last interviewer turn: when that turn follows a candidate turn (they asked something), Closing starts at the last part spoken by the lead (the voice of the turn's first part), and the parts before it stay in the previous chapter (Closing had swallowed the colleague's answer to the candidate's question). Parts carry no times, so the start is estimated from the share of characters before it (430.4 s on this call); a recorded part time is used when present. One part that both answers and says goodbye, and a lead who speaks only in the first part, stay whole in Closing.
- *The record.* An entry made of whole wand lines and a cut last line gets `sentText` (the whole lines, then the words heard of the cut one). The bug report's Record line gives active and recorded length for a paused call and notes the unprepared question; each wand line's log says how many delivery tags it got and, for a line tagged ahead, the tagging reply (a line had gone untagged with no way to tell why; the batch prompt now speaks of each line).
- *A recogniser segment that runs on past a cut wand line.* The recogniser closes a segment only on silence, so the cut line's last segment stayed open through the interviewer's whole line (7.5 s here) and was stored as the candidate speaking. When every word of such a segment comes, in order, from the cut line's sent text, its end is now the cut plus 500 ms (`clampedEndOfCutSegment` in `callService.js`), for the entry, the answer timings and the tone notes; the debug log has `transcript-clamped`. A segment with any word of its own, a whole line, a segment that starts before the line or after the cut, and one touching another spoken line stay exactly as recognised.
- *The quick reaction, measured.* "Right, go ahead." and "Glad you enjoyed it, and sure." broke the reaction's own rules (no word of what comes next, no promise to answer). Three versions of its prompt were run on the 46 real reaction turns of six saved calls, twice each on Sonnet low, and judged blind by two judges (run folder `ai-test-runs/2026-11-23-opener-rules`, numbers in `docs/ai-model-selection.md`). Adopted: the prompt with three added rules (no agreement to do what was asked, no permission or instruction to the candidate; a question or request gets only a sound of taking it up, never a yes; a stated plan gets attention, never a go-ahead). Reactions that agree or direct fell from 14 of 80 to 7 of 84, "go ahead"-type lines from about 8% to 1%, with the judges' naturalness up from 2.84 to 3.09 of 5 and no change in speed. Not adopted: the same with the quoted example sounds turned into descriptions. It agreed least (3 of 83) but was judged unnatural more often (30% against 22 to 24%), because the description's own words were said ("Right, all taken in."); the example sounds stay until a wording is found that does not leak.

**Fixes from the call of 2026-11-23 (call-mwttebvu, Eiffel Software five-minute coding screen).** The call ran as designed end to end (plan, late join, hand-overs, exercise in Eiffel with the pad labelled, follow-up, candidate's question, farewell, review). An audit (five readers, each finding checked by a second) and a review of the fixes found the following. Unit-tested only, not yet seen in a call.
- *A stray letter ran along in front of the cursor.* The wand typed an `ensure` clause above `end`; the pad's edit kept the longest common start ("en"), so the cursor sat inside `end` and its "d" was pushed along by every key. For text that is only added, `padEdit` now takes, of the places that give the same result, the one a person types at: the end of the line above (Enter, then the new lines), else the start of a line, else not inside a word. The typer works its edit out once and types it through, and works it out again only when the pad is not what its last key left (the person edited in between).
- *The hands type like a person writing code.* 242 characters had gone in at 14 a second, with no pause. Keys now average five to six characters a second, with a beat before a new line's content, a smaller one at the start of a word, slower punctuation and quick indentation (`keyDelayMs`); the hands are never sped up to fit a line (`PACE_MIN` 1). The wand's prompt gives the new speed, about two typed characters to a spoken word for a piece explained while typed, and roughly fifty characters for a silent piece. No typing slips are simulated.
- *The wand's lines.* Markdown code marks and asterisk emphasis are taken out of what is said (the transcript and the interviewers had been given backticks); underscores stay, they are part of names. A person who has just greeted the candidate, or just joined and been introduced, is greeted back once before the task. An area the documents never touch is framed as how the candidate would approach or learn it. An invitation to ask questions is not the close, so thanks are not given twice at length. A question planned for a minute with more to come gets an answer of that size.
- *"Your previous reply was not spoken" for a reply that never existed.* A silent look at the pad was in flight when the candidate's next line began; dropping it set the note. The note is now set only when the dropped reply had written words, a screen or pad change, or the end of the call.
- *The cut-in watcher.* It gets the focus note (it had been told a steered five-minute call was 25 to 30 minutes), the shared screen as data once per screen, and, for a wand line still playing, the sent words up to what has been heard (it had seen "uses an cross expression").
- *Interviewer prompt (descriptions only).* What an interviewer says the candidate's code contains must match the pad it was given (a clause using `all` was called `some`). Staying neutral covers answers to the candidate's own questions: no comparing them with what the candidate said earlier. Words about waiting for a screen belong only to a setup that takes long.
- *Review.* The Closing chapter starts at the lead's first part of the farewell unless the candidate turn before it really asked something (a question mark in the sent words); it had started at "Have a good rest of your day". An Opening shorter than 3 s with no candidate speech is folded into the first chapter. The reviewer gets the stretches when the pad was being typed in (changes less than 10 s apart are one stretch) and judges talking while writing only from them; a point it can only state with "if" is never a priority (it had coached "narrate while typing" to a candidate who did). Praise or fault for dealing with a joiner or hand-over needs a candidate line that shows it. Answers made of voiced lines are marked `voicedAnswer`, and their pace, pauses and tone are the voice's: never coached (the greeting's 236 wpm had been a priority).
- *Logs.* The engine logs `wait` (seconds and whether the line was a statement) for each reply, the call logs `question-history` at hang-up (what was counted and noted, or the error), and the bug report's Timings line is labelled ("recording trimmed before the answer" was shown as `setupLeadMs`). An exercise note for later calls ends at a sentence end when one falls in the second half of its 300 characters.
- *Left as it is:* the planner's own question on a call steered to "only one coding question" (every plan has one; here it put the exercise on screen at 2:12 of five minutes), the call running to 6:50 because the candidate's questions are never cut short, the candidate voice's speed (the service default), and two thanks when one is a word at the invitation to ask questions.

**The AI writes the interviewers' names; the app keeps no list (2026-11-23, owner's request).** Names had come from fixed tables (`voiceNames.js`: eight first names and eight surnames for American and British voices, four for each regional accent), so "Dev", "Omar" and "Marcus" came up call after call. The tables are gone. A voice is drawn with no name (`pickPersonaVoice` gives none), and the call planner, which already fits voices to people, writes each person's `name` in the plan (`lead.name`, `panel[].name`, required in `PLAN_SCHEMA`): a first name and a surname that someone from the region the voice's accent label suggests could have, of the voice's gender; a broad label (american, british) covers every background. To keep the names different from call to call the planner gets, per voice, a `nameStart` letter (taken from the call and voice ids, not from the call's random draws) as a nudge to where to start looking, and the people of the twelve newest calls (`recentInterviewerNames` in `callService.js`, from each `call.json`). `validatePlan` refuses a name that is not two plain words or more, is over 60 characters, or shares a first name or surname with another person on the call or with the candidate (particles such as "de" and "van" are not compared); a refusal goes back to the planner like any other problem. The recent calls' names are advice in the prompt only: a plan is never written again (most of a minute) over a name used on an earlier call. A voice with no accent label, or too broad a one, may get a name of any origin, and a neutral voice a name used for any gender. A colleague the plan leaves without a name fails the start, as a nameless lead does. The service takes the names from the plan (`settlePlan`), the saved setup and the kept-interview list show them, and an interview kept from before this keeps the names on its voices. Unit-tested only, not yet seen in a call: whether the names really vary and suit the accents has to be judged over a few calls.

**The AI chooses; the app keeps no fixed lists (2026-11-23/24, owner's request).** After the name list, a survey of the code for other fixed content found the items below, and the owner decided: for fixed lists and draws, the AI chooses; quoted examples in prompts go, so a model cannot copy them. This replaces what earlier paragraphs of this file and of docs/interview-practice-call.md say about the same things. Unit-tested only; none of it has been seen in a live Prepare or call, and no prompt change here was measured.
- *Prepared questions.* The 24-question catalog (`src/utils/interviewAnswerQuestions.js`) is now only a lookup for Q&A and answer sets saved before this (`INTERVIEW_LEGACY_QUESTION_CATALOG`); the answer writer is never shown it. The writer writes each card's question and variants in its own words, with a `set` (`general` or `posting`) and a `kind` (a description of what the question asks for, `electron/ipc/interviewCardKinds.js`; the kind picks the evidence shape that used to be picked by the catalog wording). The General tab is the writer's own choice of questions asked at nearly any interview, no longer a fixed seven. Only an introduction of oneself is required, as a kind, not as wording; the practice order finds it by `kind: intro`. A Prepare asks only for the tabs it will write, tells a posting-only write the General questions already saved, and gives every write at least four cards over the floor of eight. A General card written by Prepare has an id made from its wording (`g-` plus a hash), so practice counts never move to a different question when the tab is rewritten. Cards made by the writer show "Generated" (was "Standard").
- *The host check on a written question* (`interviewQuestionText.js`) is deliberately narrow and fails open: it refuses a figure that could be a result (a percentage, money, a magnitude, a number over ten that is not a length of time) and a name taken from the career text (a token with a digit or symbol, a camelCase token, or a word the question itself capitalises that the career text capitalises and never writes in lower case and the listing does not contain). It does not try to judge whether a question assumes something the person did: three rounds of review of a grammar-based version kept finding ordinary questions refused and claims accepted, a refused card costs a repair round, and cards are read and edited by hand. The prompt still tells the writer that a question assumes nothing about the person's past.
- *Evidence ranking.* The fixed bonus points for React, TypeScript, full-stack and the like, and the penalty for medical and aviation words (tastes of particular résumés, applied to every role), are gone from `interviewQuestionFit.js`. A piece of evidence scores by overlap with the role's own themes and listing.
- *"Why this role / company" headlines* no longer have to begin "This role interests me because". The writer words them; the host check (`interviewInterest.js`) keeps what the frame guaranteed in a narrow form: every cited source is research, no figure the research lacks, and no statement of the person's own past or standing in a few unmistakable shapes (a past or perfect verb after I/we, an opener about their past, "my experience", "I am a <role>"). The old opening still passes, so saved answer sets load. Soft self-description is not caught.
- *"Prepare again" fills an empty tab from the saved set.* With reuse on and an empty tab the saved set covers, the tab is now filled (it used to stay empty while the notice said the saved preparation was used).
- *Lead temperament* is a sentence or two written by the planner (how this person comes across), printed as written to the interviewer, the quick reaction and the watcher. The warm / neutral / tough list and its three fixed paragraphs are gone; a temperament a request or brief gives is passed through as written, and "warm", "neutral" or "tough" on an interview kept from before is printed as that word.
- *Late joins* are the planner's choice per colleague (`joins`, `joinMinutes` in the plan), reasoned from who they are and what they ask. The 60% dice and the 40 s to 3.5 min draw are gone. Kept: whoever asks first is there from the start, nobody arrives later than a quarter of the call, and a kept interview replays its saved join draws.
- *Call length* is the planner's choice (`callMinutes`, 5 to 60, with `wrapUpMinutes` for when the wrap-up starts); the focus note still overrides. The 25 to 30 minute default and the fixed five-minute wrap-up are gone. The service derives the range every prompt is given from the plan (`plannedMinutesOf`, `targetMinutesOf`), and the wand and the late-join cap use the same length. A longer call uses more voice credits.
- *Silence* is the interviewer's call each time (wait, say something, check the line, offer to rearrange, end the call), no longer nudge, "can you hear me", hang up. The engine keeps a backstop only: after eight unanswered check-ins or ten minutes of silence it gives the interviewer one last check-in, marked as the last, and ends the call if that too goes unanswered.
- *Quick reactions.* The reaction prompt quotes no sample sound or reaction; it describes the kind of sound. The measured version of 2026-11-23 kept the samples because described ones were said aloud, so this wording, written not to be sayable, needs measuring. The engine's repeat guard uses no word list (no "thanks / lovely", no "right / alright"): a reaction is dropped or cut when it repeats a recent one's sentence or opening.
- *No sample values in prompts.* Delivery-tag samples (interviewer and candidate voice), the planner's sample interrupting styles and picture subjects, sample numbers in tag syntax, and the sample topic, approach reminder and question openers in the preparation prompts are replaced by descriptions. Phrases a rule must name as things never to say remain.
- *Removed outright:* the second list of interviewer names (`PEOPLE`, `pickPersona`), and the language nickname table (`LANGUAGE_ALIASES`): a pad label is compared with the plan's language names as written, case and spacing aside.
- *Still fixed, by decision or by nature:* voices are English and from the library's high-quality tier; the ring tone and ring time; avatar colours; notices and error messages; turn-taking, hand-over and typing timings measured on real calls; the review's timeline labels; the kinds a card may have.

**The wand's spinner stops when the line is ready (2026-11-21).** A chat entry's `voice` is now 'waiting', 'ready' (the voice has made it), 'playing', 'heard' or 'failed', and the spinner runs only while it is 'waiting'. During a pause the wand's line is still sent: the voice makes it and holds it (`canHoldVoice`, engine `releaseHeld`), so the spinner stops while paused and the line plays the moment the call resumes. A line not yet heard when a pause starts is held the same way instead of being dropped.

**Sent messages are spoken (2026-11-20).** A message sent in the call chat is
spoken in the candidate's own voice and the interviewer may cut into it; the
voice (female or male) is chosen in Settings (sidebar, or ⌘,), or during a call
under More options (⋮) in the call's control bar, which writes the same setting and
applies to the next line said. See
docs/interview-practice-call.md, section 6. Unit-tested only.

**Pictures and diagrams on shared screens (2026-11-21).** The planner may give a
prepared screen one picture (from Parallel's web image search, with Wikimedia
Commons as the fallback, checked by Claude for fit)
or one drawn diagram, only where it makes the question clearer; they are made
during setup. See docs/interview-practice-call.md, section 6b. Unit-tested only.

**Screens that go out of date, and the enlarged screen in the replay (2026-11-21).** In the St Athan ATC call (`call-mwr579in-xjeguy`) the third part of a scenario kept the first part's traffic list and diagram (the Piper on 8 NM final) while its new text said the Piper had landed; the candidate followed the list and the review marked it down. Now: the planner keeps anything that changes between parts (positions, traffic, state) out of a problem's shared setup and its shared visual, each later part states the current state in full, and a diagram of changing positions belongs to its part. The interviewer knows a screen or plan can be wrong; when the candidate points it out, asks which is current, or answered from the stale half, it handles it however a real interviewer might (acknowledge, say what it should show, swap in a corrected screen, carry on or move on: the model's choice, no scripted line, so calls do not repeat) and never counts it against them. Suggest a reply notices a self-contradicting screen and deals with it as suits the moment. The review sees what each screen's picture or diagram showed and does not mark down an answer that followed a contradictory screen. In the replay, the shared screen beside the feedback has an Enlarge button (and its picture or diagram is clickable): it fills the content area over the feedback with bigger text and a taller visual, keeps following playback while the player stays usable, and closes with Shrink, Escape or a click outside. Render-tested only.

**Fixes from the St Athan call audit (2026-11-21).** An audit of `call-mwr579in-xjeguy` (37 agents, each finding checked by a second) confirmed these, now fixed; unit-tested only, not yet seen on a live call:
- *Planner:* a technical topic's probes come from the topic, the role and the company, never from an unrelated CV line (the "Inter-unit ATC coordination" topic had been asked as an ETL vendor question); generic "working with others or outside parties" questions go to the lead, and a colleague's focus is written only from what they ask; a focus note saying earlier rounds covered background steers picks to skills; exercises name vehicles, aircraft or people with realistic distinct identifiers (not GBAAA/GBBBB); diagrams draw quoted distances as dimension lines and keep labels apart. The interviewer keeps a topic question inside its topic and never refers to application details not yet mentioned in the call as if already discussed.
- *Cut-ins:* when the main session declines a watcher's cut-in, the watcher backs off for 10 s (or 40 new words) and is told it was declined; "probe" is the exception, not the rule (only 4 of 33 probes had been taken). A cut-in goes stale after more than 12 words and 5 s, or 30 words, instead of 12 words alone (the AI voice says 12 words while the main writes its first sentence). The "previous reply was not spoken" note is given once, not on every later look. Each cut candidate entry records `cutInReason` and `cutWhileSpeaking`; a voice line cut after about nine tenths of it played is not a cut-in.
- *Suggest a reply:* follow-ups and one-fact questions are given short ranges (the model judges), scenario questions lead with the decision or words, and the hard cap is 1,100 characters, trimmed at a sentence end.
- *Feedback numbers:* pace (`wordsPerMinute`, fastest 20 s window) is words over the answer's time less paused time; the old voiced-time rate is kept as `articulationWpm` and never quoted as pace (it had read 207–305 wpm for a voice speaking about 150–205). Talk ratio uses wall-clock spans for both sides. Gaps between recogniser segments within an answer count as pauses. Cut-ins are counted by reason, excluding ones made after the answer had finished. AI-voice speech heard on the microphone feeds the voice's own baseline (it had polluted the microphone baseline and left voiced deltas null); a tone note needs at least two long pauses before "more long pauses", is measured per recogniser segment like its baseline, and never says "less confident" or "flatter" for the synthetic voice.
- *Microphone (call-mwr9jx18 audit, 2026-11-21):* the app's own entitlements (`build/entitlements.interview.plist`) must carry `com.apple.security.device.audio-input`. macOS charges the helper's microphone request to the app, and under the hardened runtime a missing entitlement refuses it without a prompt, so the helper ran on silence and no call had ever heard the microphone. The helper's ready status now says `microphone: false` when it runs on silence, and the call shows a notice with a way to the Microphone settings. While muted the helper keeps feeding zeroed audio to the recogniser, which only closes a segment once it hears silence after it. Before, the last sentence of an AI-voice line stayed open until unmute or the next line, and the interviewer waited on a cut-off answer. If a line's last words still have not settled after the bounded wait, a `<listen/>` gets the usual quiet look. Acknowledgements after long answers choose among several kinds instead of defaulting to "I followed that".
- *Microphone failures (2026-11-22):* a microphone that fails no longer ends the call. When voice processing or the engine will not start, when a device change cannot be survived (more than four restarts in 10 s, or a restart that fails), or when the microphone's audio cannot be converted, the helper rebuilds its engine without the input node, a silent signal stands in (as without microphone access), and it sends `{type:'status', state:'microphone', available:false, reason}`. The call window shows the notice with a Reconnect button. Reconnect sends `reconnect-microphone`, and the helper rebuilds the engine with the microphone. It always answers with a `microphone` status: `reason:'denied'` while access is still refused, and `reason:'rejoin'` when recognition was never prepared in this call, so only a new call can use the microphone (the notice then says to rejoin and offers no Reconnect). An input with no channels (the device is gone) counts as a failed microphone, because tapping it would crash the helper. Only a helper that cannot play audio at all, or that exits, still ends the call.
- *Mute:* a muted mic carries nothing, the candidate's AI voice included (no special treatment). Muting cuts a wand or typed line that is playing where it stands, drops any line still being made, held by a pause or queued, and aborts a suggestion being written. While muted the wand writes nothing (nothing is spent) and a typed line is not sent (the box keeps it). The call shows "You're muted" when the wand is pressed or a line is sent, and "Are you talking? Your mic is off." when the helper hears speech on the muted mic (`muted-speech`: only the time leaves the helper, never the audio). After unmuting the candidate presses the wand again.
- *Review:* it reads the words actually sent (with the recogniser version noted when different) for whole and cut lines, judges a cut by its recorded reason and says "ran long" only when that or the answer's length shows it, and never prints transcript turn numbers. Technical-topic rows read "Technical topic: …" instead of the planner's instruction text.

**Resizing the call's side panel and chat box (2026-11-20).** The chat and notes
panel shares one width, dragged from the strip in the gap on its left (arrow keys
when it has focus, double click for the default 340 px); it stays between 280 px
and the window width less 360 px for the call. The chat box has a grip above it:
dragging up makes it taller (the messages keep at least 160 px), double click goes
back to growing with the answer. Both sizes are kept in the call window's
`localStorage` (`src/practice-call/panelSize.js`). Render-tested only, not yet
dragged in the built app.

**Closing the practice call window (2026-11-19).** Closing the window ends the
call: the three Claude CLI sessions are stopped (SIGTERM to each process group,
SIGKILL after 250 ms), the reply in flight and its ElevenLabs voice socket are
aborted, and the audio helper stops. Closing it without choosing how to leave
saves the recording and transcript and writes no review, so no ElevenLabs
transcription and no Claude review run with the window gone. A review already
asked for ("Get feedback", chosen on the screen after the call) is finished even if the window is closed
while it is being prepared: that is one transcription and one Claude call, and
the replay shows it.

Practice calls draw from the whole pool (General, posting, topics) and do not
cover all of it in one call. Each entry shows "Practised ×N": how many practice
calls asked it and got an answer. Since 2026-11-19 a question counts only once
the candidate has said or typed at least 15 words after it, or written in the
pad, before the next planned question or the end of the call; a question asked
just before hanging up, or met only with "could you repeat that?", is not
counted. A message written by Suggest a reply counts like the candidate's own
words, for the asked-question rotation and "Practised ×N" alike (owner's call,
2026-11-21; from 2026-11-20 until then it added nothing). It is still marked
`generated` on the transcript entry for the record and the review. This is a word count,
not a judgment of the answer. General questions are counted across every job, the rest per
posting (`practice-question-history.json`). The planner favours entries asked
least, so repeated practice goes through the pool. For a topic the interviewer
makes up its own question or exercise each call.

## Holding the same interview again (built 2026-11-21)

Every answered practice call keeps the interview it was made from, so the same
interview can be taken again without drawing voices or planning anew
(`electron/practiceCall/savedInterviews.js`, `<interview-data>/practice-interviews/<id>/`).
Kept: the drawn interviewer voices, the planner's plan, each colleague's late-join
draw, the candidate voices, the steering it was planned with, the prepared
questions it picked (id, text and answer) and its screens' pictures and diagrams
(`visuals/`). Saved when the call is answered (`keepInterview`); a missed or
failed setup keeps nothing.

- **Choice.** After Start practice call, a job and company that has kept
  interviews shows a choice in the hub panel: Generate a new interview, or Repeat
  one of the earlier ones (lead, colleagues, questions, length, last held), or
  Forget one. With none kept the call starts at once, as before. A repeat passes
  `repeatInterviewId` to `practice-call:start`; it keeps the steering it was
  planned with and the box's steering is not sent.
- **Same job and company** is the posting key the question history uses
  (`postingCountsKey`: company + job link + role title, else the interview id).
  A kept interview of another job is refused (`saved-interview-unavailable`).
- **Replay of the setup.** The setup step skips the voice draws, the planner
  and the visuals; warm-ups, sessions, audio and the ring run as always. Plan
  question numbers are positions in the pool of the first call, so each is found
  again by card id and wording in today's pool; a card removed or reworded since
  joins this call's pool as it was, since the plan's probes and screens were written for it. A voice that has left the library fails the warm-up as before.
  The repeat's `call.json` has `repeatOf`; it is not kept a second time, it moves
  to the front of the queue (`lastUsedAt`, `timesUsed`). Asked questions still
  count in the question history.
- **How many are kept.** Measured 2026-11-21 on the calls on disk, a kept
  interview's JSON is 4–25 KB; a diagram adds a few KB and a photo up to 5 MB
  (at most 4 per interview). So 5 are kept per job and company and 40 in all,
  under a 100 MB budget that only photo-heavy interviews reach. The least
  recently held goes first; the one just saved is never removed.

## Removed: the live cue card (2026-11-20)

The always-on-top live window that listened to the interview audio, matched each
question to a prepared card with AI and showed short cues was removed at the
owner's request, together with the Interview Audio Helper, the short-cue
("glance") writing step in Prepare and the Q&A editor's card preview and match
tester. Reasons: practising without a crutch prepares better for in-person
finals, and a near-miss match is worse than no card. Q&A tabs, approach
reminders, extensions, variants, the sealed answer bank, practice calls and the
practice-audio helper are unchanged. Old saved data that carries the cue card's
fields still loads; data already on disk (such as the cue card logs folder) is
not deleted by code.

## Data

- **Profile** (`~/Library/Application Support/Interview Helper`): Electron's own
  files, plus the Claude worker's bookkeeping (`non-api-ai-handoffs.json`,
  `claude-accounts/`, usage and replay logs).
- **Interview data** (`~/Library/Application Support/Interview Helper/interview-data`):
  `career-text`, `interview-helper-*`, `practice-calls`, `practice-interviews`, `practice-models`,
  `practice-voice-pool.json`, `practice-question-history.json` and the list of
  interviews in `interview-helper-sessions.json`.
- **First start after the split**: `electron/interviewApp/migrateFromCanvas.js`
  copies the interview data once from `~/Library/Application Support/infinite-canvas`
  and writes `.copied-from-infinite-canvas.json`. That folder is only read. The
  API keys stay where they were, in the login keychain.

`INTERVIEW_HELPER_PROFILE_DIR`, `INTERVIEW_HELPER_DATA_DIR` and
`INTERVIEW_HELPER_LEGACY_DATA_DIR` (absolute paths) point a trial run at other folders.

## What replaced the canvas

- One interview is what one Interview Helper node was, under the same id (before a posting is chosen, Q&A
  and practice history are stored per id). Interviews cannot be imported from
  a canvas file: that import and its button were removed on 2026-11-19 (owner's
  decision). The one-time copy of data on first start, above, is unchanged.
- Career files are dropped on the window or picked with "Choose files".
- Applications come from an `Applied Jobs` folder chosen once in the app.
- Changes save immediately; there is no undo.

## Typed job (built 2026-11-18)

The Application section has, under the application dropdown, a text box: "Or type a job link, or a company and role". AI reads what was typed (`electron/ipc/interviewTypedJob.js`, handler `resolve-interview-typed-job`), and the result is stored as an application artifact of the usual shape, so Prepare, the questions and the practice call run unchanged.

- **A link** is taken as a job posting link. The page is read (plain fetch, then the Parallel reader) and the AI gets the unprocessed full text. A page that is not one open posting is refused with a message.
- **A company and a role** is the target. One Parallel research call identifies the organisation, its background and careers page, looks for an open posting for that role, and notes how the company writes its postings. A found posting is read and used only if it is open, from the same organisation, and one a person seeking that role would apply through (a general posting the company really uses counts).
- **No posting found:** a stand-in listing is generated from the company, role, optional location and the research only. Career data never reaches this module. The job's name ends "(generated listing)", the artifact's status is `typed-generated`, and the Prepare prompts and the brief's first warning say it is not the employer's text. Owner's request, 2026-11-18; it is the one place the app writes a listing itself.
- **Typed job specifics reach the listing writer (2026-11-23).** The intake step also returns `specifics`: what the typed text says about the job itself beyond company, title and location (a language, a level, a domain), never anything about the person. The listing prompt gets only that (fenced as `typed-job-specifics`) and asks for it plainly in the listing without limiting the listing to it. The typed text itself still never reaches the listing writer. Before, a typed "c++" was lost once a company and title had been chosen. Unit-tested only.
- **Stops instead of guessing:** unclear text returns the AI's short question; an uncertain company identity (same-name companies) or failed web search stops with a message and nothing is generated.
- **No application documents.** A typed job has no résumé or cover letter (`applicationPositioning` is empty), so answer cards read "not verified against résumé" and practice interviewers probe from the questions alone.
- **Known limits.** The stored job link drops its query string like every job link here, so two postings told apart only by a query (`?gh_jid=`) share one link; the page itself is read with the query. With no location typed, the posting found may be in another region (live: a Singapore posting for "Shopify senior backend developer"); the box shows which posting was used.
- **Live checks from source, 2026-11-18:** pasted posting link used (11 s); company and role with a posting found (66 s); with none found, generated (87 s to 112 s); careers home page refused as not a posting; "backend role" answered with "Which company is this backend role at?". Not yet driven through the window itself.
- **Models:** four `typed-job-*` stages; their settings and measurements are in docs/ai-model-selection.md.
- **Any language in, English out (2026-11-19).** A posting in any language can be the match: research searches in the local language too, and the posting judge reads the page in its own language. For a posting that is not in English the judge returns `language` and a complete English translation as `listingText`, with the title, company and location in English, and a note under the box says the text is a translation. The original wording is never stored, so Prepare, the questions and the interviewers have only English to quote. A generated listing is always written in English. Not live-checked against a real non-English posting yet.
- **Listing source indicator (2026-11-20).** The last line of the Application section says which listing Prepare will use for what is selected now: *given* (a submitted application or a typed posting link), *found* (a real open posting found online) or *generated* (AI stand-in, amber), or *none yet*. It comes from the bundle projection's `listingSource` (`listingSourceOf` in `interviewPreparation.js`, from the artifact's verification status and reason), so it survives restarts and older saved bundles gain it on their next load.
- **Progress and Cancel (2026-11-19).** The window names each run (`runId`). The resolver's `onStatus` stages go to `standaloneClaudeActivity.stage()` under `interview-typed:<runId>`, the same feed the calls report their web searches and page reads to, so the status card is headed by the stage with Claude's current action under it; the box shows the stage. Cancel (in the box and on the card) calls `cancel-interview-typed-job`, which aborts that run only: the handler's own signal would also end a preparation for the same session. A cancelled run replies `{ cancelled: true }` and stores nothing the window adopts.

## Career files of any type (built 2026-11-18)

The career drop and file chooser accept any file type.

- **Conversion comes first.** `electron/ipc/careerFileToText.js` turns each file into a plain `.txt` in the private folder `interview-helper-career-conversions` (named after the original, `resume.pdf.txt`, cached by content hash), and the text import then reads those files. `.txt` and `.md` are read as they are.
- **By kind, decided by the file's signature:** RTF, HTML, CSV, JSON and other text are decoded on the machine; `.docx` and `.odt` are read on the machine; images (png, jpg, webp, gif) are read by Claude (stage `career-file-to-text`, "Needs test"), which copies the text out and marks what it cannot read `[unreadable]`.
- **PDFs use the on-machine text layer, with a visible "machine-extracted, check the converted text" note.** A scanned PDF with no text layer is refused with a reason (save its pages as images).
- **One bad file does not stop the rest.** The panel lists each file as converted (and how) or refused with a plain reason, and imports the good ones.
- **Practice calls.** When a job has no application documents (a typed job), the planner and interviewers get the career text, described as documents the candidate provided and not a résumé tailored to the job.
