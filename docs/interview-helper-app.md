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
  the data folder (names and sizes), status and error messages on screen, the
  window's events and the main process log of this run.
- **What it leaves out:** interview names, job links, file names of career
  data, career text, questions, answers, posting text and recordings. Log and
  event lines lose URL queries, local paths, credentials and opaque ids.
- **Window events** (`src/utils/eventLog.js`) are the last 300 lines of buttons
  pressed, uncaught errors, rejected promises and console warnings and errors
  in the main window, kept in memory only. Typed text is not recorded.
- There are no filter codes: a report here is small enough to read whole.
- Only the main window can ask for a report (`interview-app:copy-bug-report`,
  `interview-app:save-bug-report`). The cue card and practice call windows have
  no button and their events are not recorded.

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

## Text size (built 2026-11-18)

One setting for every window the app opens: the main window, the cue card and
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
  less than its 100% minimum layout (main 720×520, cue card 320×380, practice
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
  leads with the admission on the cue card; an edit makes it an ordinary card.
  The answer writer keeps only questions it can answer, so a job far from the
  career often leaves no empty card. So once per posting
  (`gapQuestionsGeneratedAt` in the posting's Q&A file) the same call also
  names up to five experience questions the role's interviewers would ask that
  the career text cannot answer, from the role themes and the listing; they are
  added as posting cards with their gap answers, and a deleted one does not
  come back. Live check from source, 2026-11-19: a music teacher's career
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

General Q&A is one file (`interview-helper-qa/foundation.json`), not part of
any interview: deleting an interview never touches it. When a Prepare writes
Q&A the main process sends `interview-app:qa-changed`, and the Q&A panel on
screen reloads, whichever interview it shows.

Prepare only fills empty answers. A saved answer, generated or edited, is never
rewritten, and a deleted question or topic does not come back. A first Prepare
on an interview reuses a finished preparation of the same career data, posting
and application when one exists; "Prepare again" always runs.

Practice calls draw from the whole pool (General, posting, topics) and do not
cover all of it in one call. Each entry shows "Practised ×N": how many practice
calls asked it. General questions are counted across every job, the rest per
posting (`practice-question-history.json`). The planner favours entries asked
least, so repeated practice goes through the pool. For a topic the interviewer
makes up its own question or exercise each call.

## The cue card

The live window is a display only. The page reaches the controller
(`electron/interviewWindow.js`) through five bridge calls: `getBrief`,
`startListening`, `stopListening`, `onListeningUpdated` and `onBriefUpdated`.
The controller exports `launch`, `getBrief`, `startListening`, `stopListening`
and session helpers, nothing else. A question reaches it from the listening
path (`onQuestion`) or from a plan the canvas supplies at launch; there is no
typed question, follow-up, prepared-card choice, Next, layout or pin control.
The window opens pinned and stays pinned. The snapshot and sealed answer bank
are verified once at launch. Details: `docs/interview-live-ai-matching.md`.

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
- **Models:** four `typed-job-*` stages, all "Needs test" in ai-model-selection.md.

## Career files of any type (built 2026-11-18)

The career drop and file chooser accept any file type.

- **Conversion comes first.** `electron/ipc/careerFileToText.js` turns each file into a plain `.txt` in the private folder `interview-helper-career-conversions` (named after the original, `resume.pdf.txt`, cached by content hash), and the text import then reads those files. `.txt` and `.md` are read as they are.
- **By kind, decided by the file's signature:** RTF, HTML, CSV, JSON and other text are decoded on the machine; `.docx` and `.odt` are read on the machine; images (png, jpg, webp, gif) are read by Claude (stage `career-file-to-text`, "Needs test"), which copies the text out and marks what it cannot read `[unreadable]`.
- **PDFs use the on-machine text layer, with a visible "machine-extracted, check the converted text" note.** A scanned PDF with no text layer is refused with a reason (save its pages as images).
- **One bad file does not stop the rest.** The panel lists each file as converted (and how) or refused with a plain reason, and imports the good ones.
- **Practice calls.** When a job has no application documents (a typed job), the planner and interviewers get the career text, described as documents the candidate provided and not a résumé tailored to the job.
