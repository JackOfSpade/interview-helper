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
  windows, each interview as states and counts, the Claude worker and its
  tasks, usage pauses, requests still running, AI step counts, the top level of
  the data folder (names and sizes), the newest practice calls (below), status
  and error messages on screen, the window's events and the main process log of
  this run.
- **Practice calls (built 2026-11-20; unit-tested only, not yet seen in the
  built app).** The section covers the newest 3 calls that have a `debug.jsonl`
  (`callStore.recentDiagnostics`, the last 2 MB of each log). For each call it
  gives the record as states and counts (length, how it ended, transcript
  entries, interviewers, questions picked, asked and answered, feedback skipped,
  recording kept or pruned, numeric timings), the review's status, chapter
  count and error, and then the call's whole timeline: phases, setup steps,
  planner attempts, engine and audio helper events, messages to the interviewer
  sessions, the candidate's actions, the call window's events and each step of
  the feedback review. Each line keeps its event name, numbers and booleans.
  Text is shown only under a fixed list of code keys (`type`, `phase`,
  `status`, `outcome`, `action`, `lang`...) and only when it has no spaces;
  every other string becomes its length (`‹32 chars›`) and a map keyed by text
  shows only how many keys it has. Notes, warnings, failures and errors keep
  their text, redacted like the log, with quoted spans dropped whole («», double
  quotes with escapes, curly and single quotes). A rejected review names its
  question in «» for this. A note ending in JSON (`plan {...}`) has that JSON
  shaped like event data. A call with more than 1,500 lines drops engine, helper
  and session-turn lines oldest first. Also logged since 2026-11-20: the
  recording step (`recording`: mixdown and encode durations, mixed length,
  `call.m4a` size, and a warning when the encoder left no file), a call whose
  wrap-up throws (`finish-failed` with the phase and stack, and a warning;
  every caller drops that error), the practice history update
  (`history-registry`), the end of the wrap-up (`wrapped-up`), a failed
  analysis write (with its error code), and in the window, a recording that
  fails to load or play. The plan summary note now gives the lengths of roles
  and of the unprepared question instead of their text, and a planner problem
  no longer quotes a panel member's role.
  Then the last 300 lines of the practice call and replay windows' own events.
- **Feedback generation is logged step by step** (`analyzeCall` `onEvent`, into
  the call's `debug.jsonl` as `analysis-*`): the transcript and answer counts,
  the transcription (words, duration, error and HTTP status), the metrics, the
  picked cards, each review request (attempt, prompt size, model) and reply
  (accepted with what was kept, rejected with the validation error, or the call
  failing), and the result. Failures and rejected reviews also go to the app log.
- **What it leaves out:** interview names, job links, file names of career
  data, career text, questions, answers, posting text and recordings. Log and
  event lines lose URL queries, local paths, credentials and opaque ids.
- **Window events** (`src/utils/eventLog.js`) are the last 300 lines of buttons
  pressed, uncaught errors, rejected promises and console warnings and errors
  in the main window, kept in memory only. Typed text is not recorded.
- There are no filter codes: a report here is small enough to read whole.
- Only the main window can ask for a report (`interview-app:copy-bug-report`,
  `interview-app:save-bug-report`). The practice call window has
  no button. The practice call window records its own clicks, screens, errors and
  console warnings (`src/practice-call/callEventLog.js`) and sends each line over
  `practice-call-window:log-event`; the main process adds it to the call's debug
  log and keeps the last 300 in memory. A pressed control there is named only
  from a fixed list (seek and chapter buttons, whose labels hold call content,
  become "Seek to a moment" and "Show chapters"; anything else is "(a
  control)").

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
the two required General questions), and its card count is the "prepared
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

**Sent messages are spoken (2026-11-20).** A message sent in the call chat is
spoken in the candidate's own voice and the interviewer may cut into it; the
voice (female or male) is chosen in Settings (sidebar, or ⌘,). See
docs/interview-practice-call.md, section 6. Unit-tested only.

**Pictures and diagrams on shared screens (2026-11-21).** The planner may give a
prepared screen one picture (from Parallel's web image search, with Wikimedia
Commons as the fallback, checked by Claude for fit)
or one drawn diagram, only where it makes the question clearer; they are made
during setup. See docs/interview-practice-call.md, section 6b. Unit-tested only.

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
counted. Since 2026-11-20 only the candidate's own words count: speech into
the microphone, or a message they typed themselves (which is spoken in their
voice). A message written by Suggest a reply is heard by the interviewer like
any other but adds nothing, even after edits (the box remembers that it held a
suggestion until it is emptied; `generated` on `sendChat` and on the
transcript entry, skipped in the engine's `noteAnswer`). This is a word count,
not a judgment of the answer. General questions are counted across every job, the rest per
posting (`practice-question-history.json`). The planner favours entries asked
least, so repeated practice goes through the pool. For a topic the interviewer
makes up its own question or exercise each call.

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
  `career-text`, `interview-helper-*`, `practice-calls`, `practice-models`,
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
