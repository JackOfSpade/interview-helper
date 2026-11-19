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
  and practice history are stored per id). "Import from canvas file" reads a
  canvas without writing it.
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
