# Working in this repository

Read [docs/interview-helper-app.md](docs/interview-helper-app.md) first: it says how the app is built, where its data lives and how career data, saved Q&A and practice calls work.

- Run the tests with `npm test`. Never run `scripts/run-tests.mjs` without `--import ./scripts/test-stubs/register.mjs`: the suites need the Electron stub it installs. To run only some suites, set `TEST_SUITES` (names without `.js`), e.g. `TEST_SUITES=practice-call-audio,practice-call-service npm run test:unit`.
- `npm run lint` and `npm run build:compile` must stay clean.
- A new dependency of the practice call service or controller (`electron/practiceCall/`) that starts a process or calls an AI must default to off and be passed in from `electron/interviewApp/main.js` (as `draftText` and `planText` are); a real default runs for real in the unit suites.
- The app is signed with a local identity so macOS permission grants survive rebuilds. Do not change the signing settings in `electron-builder.interview.json`.
