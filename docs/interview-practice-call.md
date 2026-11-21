# Interview practice call (Phase 1 design)

A live AI practice-interview call inside Infinite Canvas. This is a design
record: every decision and number here is settled and measured, and the
measurements are Phase 0 results on synthetic scenarios. The call is built;
the status table says what has run live.

## Status: planned vs built

| Item | Status |
|---|---|
| `electron/interviewPracticeCallPrompt.js` | Built |
| `electron/interviewPracticeTransport.js` | Built |
| `scripts/interview-practice-benchmark.mjs` | Built |
| `scripts/fixtures/interview-practice-scenarios.mjs` | Built (synthetic) |
| `scripts/practice-probes/**` | Built (Phase 0 probes) |
| Practice audio helper: `native/practice-audio/`, `scripts/build-practice-audio-helper.mjs`, `electron/interviewPracticeAudio.js` | Built, Phase 2 (compiles; not yet run against a real mic) |
| Conversation engine and simulation harness: `electron/interviewPracticeCallEngine.js`, `scripts/interview-practice-simulate.mjs`, `scripts/fixtures/interview-practice-call-scenarios.mjs` | Built, Phase 3 (simulated only; not yet run with real sessions, voice or mic) |
| Merge A additions (2026-11-08): Smart Turn v3 + tone model (`electron/practiceCall/models/`), audio analysis (`electron/practiceCall/audio/`), pause-then-decide, voice notes, helper pause/resume | Built; unit-tested and parity-checked against the official Python pipelines; not yet run in a live call |
| Voice provider (ElevenLabs v4 Turbo dialogue WebSocket, Scribe) and call window (`electron/practiceCall/`, `src/practice-call/`) | Built, Phase 4 (fakes only; not yet run live) |
| Post-call analysis, two-track recording and in-app replay with chapters | Built, Phase 5 (fakes only; not yet run live) |
| Live checklist for the user | Written, Phase 6 (section 14); not yet run |
| First live runs (2026-11-17) | Run end to end with typed chat answers: real interviewer sessions, ElevenLabs voice, both models, recording, review and chapters. The spoken path (microphone capture, turn-taking on real speech, tone notes, Scribe) is still not run live. See "Live run record" below. |
| Candidate voice and interviewer cut-ins (2026-11-20) | Built: a sent chat message is spoken in the candidate's own voice, and the interviewer may cut into it. Unit-tested only; not yet heard in a live call. |
| Interviewer cut-ins on live speech, tone notes for the candidate's voice, voiced answers judged as spoken (2026-11-21) | Built (sections 6, 7, 11). Unit-tested only; not yet run on real speech. |
| Panel interviews (several voices, late joiners, interviewers talking to each other) | Built 2026-11-17 (section 9); run live from source with typed answers |
| Voice delivery for Eleven v4 (tags, stability, flush) and the fast acknowledgement | Built 2026-11-17 (sections 4a and 9a) |

## Live run record

**2026-11-17.** Two full calls from source and two in the packaged build, the candidate answering only by chat. In the built app the real audio helper ran (microphone capture, playback, recording), but nobody spoke, so on-device transcription, turn-taking on speech, tone notes and Scribe are still untested. The built app was launched from a shell for these calls: opened from Finder, macOS reported microphone access as denied for Interview Helper, which has to be allowed once in System Settings. Until this day no call had ever started: the unit suites ran on stand-ins and passed while the real parts did not fit together. Found and fixed:

- The packaged app could not load the call service's parts (a dynamic import through a variable is not bundled), and the failure showed nothing in the hub.
- The interviewer sessions were created without awaiting the async factory, and the classifier session was never asked for its ready reply, so every call failed before ringing.
- The tone model download was refused (HTTP 403 for Node's default user agent).
- The ear called its loaders wrongly and passed the promise file API to a reader that needs the synchronous one, so turn-end detection and tone notes could never run. The same file API mistake stopped the interviewer track and the mixdown, so no call produced a recording.
- Prepared cards hold their answer as headline, points and example; the call read a plain `answer` that does not exist, so the interviewer, the review and the in-call cards panel all had empty answers.
- Words split across two voice alignment chunks were reported as two words ("Ani ka").
- Spoken transcript entries had no times, so the replay had one chapter for the whole call.
- The audio helper could not start on macOS 27.2: with voice processing on, the engine refuses to start unless the output side exists before voice processing is enabled and the mixer is joined to the output explicitly (0 of 6 starts before, 6 of 6 after). The helper now also names the failed step on stderr.
- In the built app a helper failure during setup was reported as "CANCELLED", the audio-check screen was never shown (the window opened only once the call rang), captions did not follow the newest line, and the chat box stayed one line tall.
- The recording starts during setup, so the replay's times ran about 25 s ahead of the call and the audio was longer than the call length shown. The lead is now cut from both tracks and every time is on the call's own clock, read off the helper's clock.
- Feedback with an unanswered question was accepted by the review and then refused when stored (validation was not repeatable), and the session it had armed stayed armed and blocked later calls.
- Realism: the short acknowledgement spoken before each reply restated the answer, and the reply then restated it again; every answer was praised; a silent candidate was prompted every 10 s. The acknowledgement is now one to three words with no content and is skipped before a silence check-in, praise is rare, vague answers are probed, and silence check-ins come at 20 s, then 30 s and 45 s later. (Since 2026-11-19 it chooses its own length with no cap and joins the reply as section 4c describes.)

Measured in those calls (typed turns): greeting starts 2.6 to 3.0 s after answering; first sound 1.9 to 5.0 s after a typed answer; a typed interruption stops the interviewer in under 0.4 s; the review takes 45 to 50 s.

## 1. Purpose

An in-app call window where a Claude interviewer talks with the candidate by
voice in real time. The interviewer reacts, answers clarifying questions,
handles acknowledgements and interruptions, can interrupt the candidate, and
ends the call itself. After the call it reviews performance, including
delivery: filler words, pace, pauses and interruptions.

The in-app practice call is the only practice mode.

## 2. Why not the alternatives

All settled.

- **No Claude audio API.** There is no way to send or receive speech with
  Claude directly.
- **claude.ai voice mode cannot be embedded** in the app.
- **Custom MCP tools are unreliable in voice mode.** The existing path
  already carries a text-mode fallback for this reason.
- **Google Meet** gives a personal Gmail account no transcripts, and its
  real-time media API shuts down 2027-01-15.
- **Meet bots** cost money and lose exact timing.
- **A direct Anthropic API opener is slower than the warm Claude CLI.**
  Measured, see section 10.

## 3. Architecture

```
 Renderer                      Main process                         Helper / network
 --------                      ------------                         ----------------
 Call window  <--IPC-------->  Conversation engine                  Practice audio helper (Swift)
  tiles, captions,              (pure, injectable                    - mic capture, Apple voice
  chat panel, timer             state machine)                         processing (echo cancel)
                                   |                                 - playback
                                   |-- warm CLI: opener session      - voice-activity events
                                   |-- warm CLI: main interviewer    - live on-device SpeechAnalyzer
                                   |-- warm CLI: classifier             transcript of the candidate
                                   |-- warm CLI: interjection        - 16 kHz mono local recording
                                   |     watcher (later phase)            ^
                                   |                                      | NDJSON protocol
                                   |-- ElevenLabs streaming TTS <---------+ (audio to playback)
                                   |     (WebSocket, word alignment)
                                   '-- ElevenLabs Scribe (post-call
                                         verbatim transcript)
```

- **Practice audio helper** is a new Swift app, separate from the Listen
  helper, which stays barred from mic and playback. It owns mic capture with
  Apple voice processing (echo cancellation) and playback, so the app hears
  the candidate while the interviewer speaks. It emits voice-activity events,
  a live on-device SpeechAnalyzer transcript of the candidate, and writes a
  16 kHz mono local recording. Its NDJSON protocol mirrors the Listen
  helper's discipline.
- **Main process** holds the conversation engine, a pure state machine with
  injected clock, sessions and audio, so it can be driven by the simulation
  harness. It runs two warm Claude CLI sessions per call (opener and main
  interviewer), a warm classifier session and, in a later phase, an
  interjection watcher session. ElevenLabs streaming TTS runs over WebSocket
  with word alignment. ElevenLabs Scribe produces the post-call verbatim
  transcript.
- **Renderer** is the call window.

## Practice audio helper protocol

NDJSON over stdio: one JSON object per line, UTF-8. The Node wrapper is
`electron/interviewPracticeAudio.js`. Stderr is drained and ignored.

**Launch**

| Item | Value |
|---|---|
| Executable (packaged) | `<resources>/practice-audio/Practice Audio Helper.app/Contents/MacOS/practice-audio-helper` |
| Executable (dev) | `<project>/native/practice-audio/build/Practice Audio Helper.app/Contents/MacOS/practice-audio-helper` |
| Arguments | `--parent-pid <pid> --locale en-US --recording <absolute .wav path>` |
| Spawn | stdio pipes, no shell; Apple Silicon and macOS 26 or later only |
| Recording | path is absolute, ends `.wav`, must not exist; created `O_EXCL\|O_NOFOLLOW`, mode 0600; 16 kHz mono 16-bit PCM WAV; muted time is written as silence |
| Clock | one monotonic clock, ms since mic capture start, for every `atMs`, `startMs`, `endMs` |
| Audio engine | one AVAudioEngine with Apple voice processing, so echo cancellation has the playback reference |
| Line limits | stdin lines at most 262144 bytes (wrapper sends audio chunks of at most 96000 bytes before base64); stdout lines under 16384 bytes (the wrapper drops longer lines) |
| Stop | `stop` line, stdin EOF, then SIGTERM or SIGINT; the wrapper sends SIGKILL after 750 ms |
| Watchdog | the helper exits when `--parent-pid` is gone |

**Commands (main → helper)**

| Command | Fields | Notes |
|---|---|---|
| `play` | `utteranceId`, `sampleRate` (24000 or 44100) | Starts an utterance; a new utterance cancels the active one. `utteranceId` matches `[A-Za-z0-9_-]{1,64}`. |
| `audio` | `utteranceId`, `pcm` | Base64 of 16-bit little-endian mono samples, at most 96000 bytes before base64, never split mid-sample. |
| `end` | `utteranceId` | No more audio for the utterance. |
| `cancel` | `utteranceId` | Stops the utterance now. |
| `mute` | `muted` (boolean) | Mutes the candidate's mic; the recording gets silence. |
| `stop` | none | Finish the recording and exit. |
| `inject` | `utteranceId`, `sampleRate` (16000, 24000 or 44100) | Starts a line in the candidate's AI voice mixed into the microphone signal (2026-11-21). A new `inject` cancels the active one with a 30 ms fade. |
| `inject-audio` | `utteranceId`, `pcm` | Base64 16-bit LE mono at the line's rate, at most 96000 bytes before base64, never split mid-sample. |
| `inject-end` | `utteranceId` | No more audio for the line. |
| `inject-cancel` | `utteranceId`, `fadeMs` (0..500, default 60) | Stops the line with a fade, on the mix and the monitor. |

**Events (helper → main)**

| Event | Fields | Notes |
|---|---|---|
| `status` | `state`: `preparing` or `ready`; `inject: true` | `ready` once mic capture, playback and the analyzer run. A helper that can inject says `inject: true` (an older one omits it, and the wrapper then refuses the inject commands). |
| `inject` | `utteranceId`, `state`: `started`, `position`, `finished` or `cancelled`, `positionMs`, `atMs` | `positionMs` is how much of the line has been mixed into the microphone; `atMs` is on the mic timeline (the clock of `vad` and `transcript`). Positions about every capture buffer, at least 40 ms apart (100 ms on the silent microphone). Backpressure in the wrapper gives a local `cancelled` with `reason: 'backpressure'`. |
| `level` | `rms` (0..1), `atMs` | Every 100 ms. |
| `vad` | `speaking` (boolean), `atMs` | On change only. Energy-based with an adaptive noise floor; at least 100 ms to start, 200 ms to end; constants tuned in Phase 3. |
| `transcript` | `text` (1..4000 chars), `segmentId`, `final`, `startMs`, `endMs` (≥ `startMs`) | On-device SpeechTranscriber, volatile and fast results. |
| `playback` | `utteranceId`, `state`: `started`, `position`, `finished` or `cancelled`, `positionMs`, `atMs` | Position about every 50 ms. |
| `recording` | `state`: `closed`, `durationMs` | After the file is finalized. |
| `error` | `code` | Fatal; the wrapper stops the helper. |

Times are integers ≥ 0. The wrapper validates every event by shape, copies only
the listed fields, and drops malformed, unknown or oversized lines. A helper
exit without a prior stop or error counts as `capture-failed`. If the helper
stops reading and more than 4 MB of lines queue, the wrapper cancels the active
utterance, drops its queued audio and reports a local `playback` event with
state `cancelled` and reason `backpressure`; control lines are never dropped.

**Error codes**

| Code | Meaning |
|---|---|
| `permission-denied` | Microphone access denied. |
| `unsupported-locale` | On-device English recognition unavailable. |
| `speech-assets` | Speech assets could not be prepared. |
| `unsupported-platform` | Not Apple Silicon with macOS 26 or later. |
| `capture-failed` | Mic capture stopped; also the wrapper's code for a crash or an unknown code. |
| `recognition-failed` | Live transcription stopped. |
| `playback-failed` | Playback failed. |
| `recording-failed` | The recording could not be created or written; the wrapper also uses it for a bad recording path. |
| `helper-unavailable` | Wrapper only: the helper could not be spawned or errored. |

**Privacy.** No transcript text or recording path is ever logged. The
recording is 0600 and created exclusively, and is deleted after successful
analysis unless "keep recording" is on.

## 4. Two-part replies (latency design)

The first sound matters most. No single configuration met the original 1.5 s
p95 gate (section 10), so a reply is made of two parts.

1. At 0.5 s of candidate silence (tuned in Phase 3, section 10a) the turn is sent speculatively to
   both sessions in parallel.
2. The **opener session** writes only a 2–8 word natural reaction
   (acknowledge or reflect back; never a question, a judgment or a fact), or
   `<listen/>` if the candidate is not done.
3. The **main session** is told a reaction is already being spoken for it
   and starts with the substance.
4. Speech is fed to ElevenLabs from the first phrase, not the full sentence.
5. Playback starts at the commit threshold, 1.2 s. Text reaches the voice
   only after the voice gate, also 1.2 s of silence, so discarded speculation
   costs no ElevenLabs characters.
6. If the candidate resumes before playback, both replies are discarded. The
   work is generation-fenced like the matcher.
7. The app keeps the authoritative transcript of what was actually spoken.

Estimated last-word-to-first-sound is about 1.7–2.0 s typical. This is an
estimate, to be measured end to end in Phase 3.

## 4a. The acknowledgement, re-measured (2026-11-17)

In the first live calls the short reaction ("opener") was the slow part: on the full interviewer instructions Opus low needed a median 3.3 s to its first word, later than the main reply's first sentence, and the reaction restated the answer, which the reply then restated again. It is now a one-to-three-word acknowledgement with no content, written by its own session from small instructions that hold nothing of the brief or plan, on Haiku at low effort (20 of 20 sample turns in rule, median 0.65 s). Since 2026-11-19 it runs on Sonnet at low effort, after Haiku leaked content in about 5 of 25 real reactions (see `docs/ai-model-selection.md`). The engine drops an acknowledgement longer than three words, skips it before a silence check-in, and flushes it to the voice at once. Measured end to end on typed turns: first sound 0.85 to 1.0 s after the answer, against 3.0 to 3.5 s before.

**The reply repeating the acknowledgement (2026-11-17).** The main session cannot see what the acknowledgement said, and it sometimes opened its reply with one of its own ("Sure. Sure...", "Okay. Okay, so that..."), most often when the candidate asked for something and both sessions said yes. Measured on 14 scripted typed turns per run with the real instructions on Opus low: 7 of 28 replies began with a second acknowledgement or agreement. Moving the reminder to the end of each message changed nothing (same rate in one run). Rewording the rule did: it now says the two are heard in one breath, that the first words are never another acknowledgement or agreement, and that a request has already been answered yes, so the reply goes straight to doing it. With the final wording, 1 of 42 replies (an "okay" delivered flat, as a signal of doubt). A direct yes or no to a question the candidate asked ("Yes, please, walk me through it") still opens the reply, as it should. A sentence that explicitly allowed a leading yes or no was tried and removed: it let the repeats back in (3 of 28). The rule also names the panel case (the acknowledgement is in the floor holder's voice) and gives way to the interruption rule. The marker is sent whenever the acknowledgement session was started, so on the rare turn where its text is dropped (over three words, or a failure) the reply starts without one. Decided by the prompt alone; no code drops words from a reply.

**The candidate's name (2026-11-17).** The interviewer is given the candidate's name from the approved career snapshot the interview was prepared from (`profile.identity.name`, read in the main process by `practiceCall/candidateName.js`) and is told to use the first name in the greeting and now and then after it. With no readable name the old rule stands: never guess, say "you". The name is not written to the call record or the published call state.

## 4b. A listening acknowledgement the reply can see (built 2026-11-19, unit-tested and probed only; not yet seen in the built app)

After a real 30-minute call the owner found the acknowledgements unrelated to what he had said, sometimes off, and too short to cover the reply's generation ("Okay. Okay. Then let me come at...", "Right. Fair enough.", "Nice. Glad to hear it."). Section 4a's one-to-three-word, content-free acknowledgement is replaced; 4a stays as the record of why.

- **What it writes.** One short listener reaction that fits the feeling of the line (good news gladness, bad news a brief sympathy that names nothing, a long answer "I follow", "I don't remember" ease, a request or question a quick yes), 4 to 9 words (about 1.5 to 3 s spoken at 330 ms a word), a bare "Mm-hm." only after a one- or two-word line. It is only about how the line was received: never a restatement, a verdict ("that's a clear plan"), praise, a fact, a question, who will answer, or what comes next, and no hesitation. The test it is given: it must work word for word after any line of that kind. `<listen/>` and `<pass/>` are unchanged. Manner differs by temperament (warm, neutral, tough).
- **Engine cap.** `MAX_OPENER_WORDS` was 12 (was 3), then 16; removed on 2026-11-19 (section 4c): an acknowledgement of any length is spoken as written.
- **Sequential order.** For a turn that has an acknowledgement the opener runs first. The main message is built when the acknowledgement is settled (spoken, dropped, `<pass/>`, failed or timed out) and, on a spoken turn, the ear's voice note has settled; both are awaited at once. A deadline of `openerDeadlineMs` (1500 ms from the start of the turn) aborts a slow opener and speaks none. An opener `<listen/>` discards the turn and the main session never starts. The acknowledgement still goes to the voice, and is flushed, the moment it is known. Turns without an acknowledgement (greeting, silence check-in, pad progress, hand-over, paused-ack) start the main session as before; typed turns do wait for theirs.
- **The reply sees it (marker reworded 2026-11-19, section 4c).** The main message carries `[Already said to the candidate just before your reply, in the floor holder's voice and in the same breath: '<exact words>']`, and nothing when nothing is spoken. The prompt rule says the reply continues from those words as one breath; whoever speaks first does not acknowledge, agree, sympathise or react again nor repeat the sentiment, and begins with the substance. The interruption rule keeps precedence.
- **Diagnostics.** One engine event per turn: `{ type: 'opener', text, spoken, words, ms, outcome }`, outcome `spoken | dropped | pass | listen | timeout | error` (`ms` from the start of the turn); a turn abandoned before its acknowledgement settled reports nothing. The `timing` event is unchanged.
- **Probe** (`scripts/practice-probes/opener-ack.mjs`, real Claude CLI, no ElevenLabs): 25 turns of the real call, one session, in order. Haiku low: first delta p50 0.35 s, whole reply p50 0.60 s / p95 0.70 s, 4 to 9 words, but 5 to 6 of 25 reactions still described the answer ("that's a clear reason", "a clean cutover plan"). Sonnet low: first delta 0.48 s, whole reply 0.71 s / 0.79 s, 4 to 9 words, 0 to 2 of 25 with content, varied openings. Recommendation: move the opener session to Sonnet low (`SESSION_MODELS.opener` in `practiceCall/callService.js`, not changed by this work); the instructions and the sweep below were measured on both.
- **Simulation** (`npm run` harness `scripts/interview-practice-simulate.mjs --sweep --seeds 5`, default 500/1200/1200 ms, synthetic latencies, the acknowledgement spoken at 330 ms a word): last word to first sound p50/p95 1964/2200 ms before (parallel, "Got it," 2 words, opener first word 700/1170 ms) and 1789/1854 ms after (sequential, 8 words, whole text known in 650/800 ms). Like for like (sequential order but the old opener timing and 2-word text) it is 1964/2271 ms: the order itself costs about 70 ms at p95. The main reply's first audio was ready 1.9 s (p50) and 1.5 s (p95) before the 8-word acknowledgement ended (never late), so about 4 to 5 words would already cover it in the model; with the old 2-word text it starts 150 ms (p50) and 630 ms (p95) after the acknowledgement ends, late in 67% of replies. Real Opus first-sentence times are the largest uncertainty.
- **Model entry.** The figures above are the record for the opener; `docs/ai-model-selection.md` lists every call's current setting.
- **Measured, adaptive length (built and then removed, 2026-11-19).** For a few hours the engine told the acknowledgement how many words to say (`[Say about N words this time.]`, N from the rolling p75 of the reply's time to its first sentence over 330 ms a word, 4 to 12). Heard in rendered clips, the 10-to-12-word reactions were padded and wordy, and the real voices speak a reaction at about 390 ms a word (13 clips, 320 to 470), not 330, so they also ran 1.5 to 2.5 s past the point where the reply was ready. The owner removed it; see 4c.

## 4c. Joining the acknowledgement and the reply (built 2026-11-19, unit-tested and rendered with the real voices; not yet heard in the built app or on a live call)

The owner listened to rendered turns (`scripts/practice-probes/turn-audio.mjs`: the call's real voices, the engine's streaming and flush order, every chunk placed where a player plays it) and heard four faults: a second acknowledgement right after the first ("I appreciate you being upfront." then "Thanks, that's a straight answer."), a mood flip at the join, a mood flip inside a sentence that was voiced in two pieces, and padded reactions. What changed:

- **The acknowledgement chooses its own length, with no word cap.** The opener instructions ask for the length a real listener would say after this line: a bare "Mm-hm." after a word or two, a few words after most answers, a little more after something long, personal or hard, never padded. There is no target note and no limit: the old 16-then-12-word drop is gone, so a long reaction is spoken as written (the owner's call: the cap was arbitrary and untested; the content rules in the instructions are the only guard). Two text runs on the 26 turns of call-mwnvhypn-666sq7: median 6 and 7 words, 3 to 11.
- **Silence before the reply is accepted.** Opus took a median 3.6 to 3.8 s from the acknowledgement being written to its first sentence in these runs, so after a short reaction the candidate hears 0 to about 3 s of silence before the reply. The owner accepted this: a listener does not answer instantly, and a natural reaction matters more than covering the wait.
- **Sentences are never split.** The first-clause split (built and removed the same day) made the voice render "When you say a lot of full stack work," on its own, and the tone jumped mid-sentence. The voice only ever gets whole sentences.
- **The first sentence is flushed only when needed.** The voice service waits for about 8 words before it speaks. The reply's first sentence is flushed `joinFlushLeadMs` (900) before the acknowledgement (and any pause) ends, or at once when less is left; a sentence that arrives earlier waits for the next one and the two are voiced together. Behind the voice gate (spoken turns) the flush is timed when the gate opens. A gap or a speaker switch ends that segment and cancels the pending flush, and so does an abandoned reply.
- **A natural pause when the reply is early.** When the first sentence arrives with at least `joinGapMinLeadMs` (900) of the acknowledgement still to play, the engine puts `JOIN_PAUSE_MS` after it by how it ended (full stop 450, question 550, comma 220, ellipsis 650 ms), less the near-silence the voice already left after its last word (150 ms assumed until it is voiced). The pause is a voice gap, so it starts a new segment; with less than 900 ms left a new segment would not connect in time, and the silence that happens anyway stands in for it. The time left is the acknowledgement's audio not yet played, or its word count at 390 ms a word while it is not all voiced (never both added). In the rendered runs the reply was ready early in almost no turn, so the pause rarely fires with Opus.
- **No mood flip at the join.** Right after an acknowledgement in the same voice, the reply's first sentence is voiced without its leading delivery tags; later sentences keep theirs, so a real change of tone comes one sentence on. An instruction alone did not do it (24 of 25 replies kept a leading tag before and after it was added), because the delivery rules ask for tags throughout. Overlay anchors are corrected for the dropped characters.
- **No second acknowledgement.** The marker is now `[You have already started your reply out loud with: '…' Carry on from there.]`, placed last in the message (after the Candidate line), and the rule says those are the reply's own first words, so the next words never react again. Blind-judged on 102 reply openings from four 26-turn runs (two judges, shuffled, conditions hidden): a second acknowledgement in 36 of 51 with the old marker and 6 of 51 with the new one (both judges agreeing). What is left is mostly a lone "Okay.", "Sure." or "Makes sense." before a hand-over or a new topic. Naming that case in the rule was tried and removed: 5 of 51 to 2 of 52, but blind whole-conversation judges preferred the conversations without it in both pairs (7.6 to 6.8, 7.5 to 6.5), so the small gain was not worth the risk.
- **Voice stability unchanged (owner's listening test, 2026-11-19).** The same turns rendered with each voice at its planned stability and 0.15 steadier: the owner heard no problem in either and kept the planned values. The short silence before the acknowledgement also sounded natural to them (thinking time plus call latency).
- **Debug log.** Each reply's join is an engine event (`join`: `remainingMs`, `pauseMs`, `flushInMs`, `gated`), so it lands in the call's `debug.jsonl`.
- **Reply model unchanged.** Opus low stays (`MAIN_REPLY_MODELS` / `DEFAULT_MAIN_REPLY_MODEL` in `practiceCall/callService.js`): on the same 26 turns, blind, it won 43 turn votes to Sonnet's 22 (13 ties) and both whole-conversation judges preferred it (8.0 and 7.8 against 6.5), and Sonnet numbered planned questions in its own order instead of the plan's. Sonnet reaches its first sentence in about 0.9 s against Opus's 2.8 to 3.7 s; thinking off and fast mode did not take effect through the CLI (`scripts/practice-probes/main-latency-breakdown.mjs`).

## 5. Turn-taking state machine

```
                      candidate speech
        +---------------------------------------------+
        |                                             |
        v        ~0.5 s silence                       |
   [LISTENING] ------------------> [SPECULATING] -----+  candidate resumes:
        ^                           opener + main      |  discard both replies
        |                           run in parallel    |
        |  opener says <listen/>         |             |
        +--------------------------------+             |
                                         | commit threshold (start 1.2 s)
                                         v
                                    [PLAYING] ---- overlap ----> [OVERLAP?]
                                      |  ^                         |      |
                                      |  |  acknowledgement:       |      |
                                      |  +-------- keep playing ---+      |
                                      |                                   |
                                      |     interruption: stop voice, add note
                                      |     <------------------------------+
                                      v
                       reply finished  --> [LISTENING]
                       <end-call/> after farewell --> [ENDED]
                       hang-up (any state)         --> [ENDED]
```

| State / event | Behaviour |
|---|---|
| Listening | Waits for the candidate. After 20 s of silence the interviewer is sent `[candidate silent 20s]` and reacts; further check-ins follow 30 s and 45 s later with the cumulative silence, and after about three unanswered check-ins the interviewer ends the call. No acknowledgement is spoken before a check-in. |
| Speculating | At 0.5 s of silence the turn goes to the opener and main sessions at once. Either may answer `<listen/>` (the candidate is still thinking), which discards the reply. |
| Keep-listening | The opener answers `<listen/>`: nothing is spoken, the interviewer keeps waiting. A 1.5 s mid-answer pause must not cause a cut-in. |
| Commit | At the commit threshold (1.2 s) playback may begin. Resumed speech before this discards both replies, and the next message says the reply was not spoken. |
| Playing | Reply streams from ElevenLabs through the helper's playback. |
| Clear interruption | Overlap of more than 2 words or more than about 0.7 s stops the voice immediately. |
| Ambiguous overlap | Shorter overlap asks the classifier session. If it says interruption, the voice stops at the next word boundary. Otherwise it is an acknowledgement and speech continues. |
| Acknowledgement | Mid-sentence "right" or "gotcha": no stop and no reply. |
| End of call | The interviewer says a farewell, then emits `<end-call/>`; the app ends the call. |
| Hang-up | The candidate ends the call from any state. |
| Session crash | The warm session is restarted with the transcript so far and the call continues. |

No word lists in code. Acknowledgement versus interruption is decided by
duration, word count and the classifier only.

**Interruption note.** Using ElevenLabs word timestamps against the playback
position, the app works out what the candidate actually heard and tells the
interviewer:

```
[You were interrupted after saying: '<heard text>'. The rest was not heard. What you had not yet said: '<unheard text>'] Candidate: '<text>'
```

The unheard text (added 2026-11-19, at most 700 characters) is what the reply
had written past the cut; only the main session gets it, not the
acknowledgement session. The rule that went with the note used to say "do not
resume the cut sentence", so after a "hello" typed over the introduction the
interviewer left a sentence hanging ("...on the Vindictus: Defying Fate") and
moved to the next one. Now a cut-in that changes nothing (a greeting, "sorry,
go on") is returned in a word or two and the cut-off thought is said again
whole, in fresh words, before carrying on; a question, correction or answer is
dealt with first. Unit-tested only: not yet heard in a live call.

**Ready, then the ring (2026-11-19).** Setup can take minutes, so nothing rings
by itself. When setup finishes the service stays in `precheck` with
`setup: { step: 'ready' }` and the window shows "I'm ready". Pressing it
(`ready`) clears the screen to "Waiting for call…" and the call rings 3 to 7
seconds later. `readyGate: false` (the unit suites) rings at once.

**Missed call and call back (2026-11-19).** The ring is the "Meeting app" chime
(`startRingtone` in `src/practice-call/ringtone.js`). A ring that is declined
(`decline`) or not answered within 10 seconds (`RING_TIMEOUT_MS`, the owner's
choice) does not end anything: the service moves to phase `missed` with `missed: 'declined'` or
`'unanswered'`, and the window shows the caller with Call back and Close. The
microphone, the recording and the three warm sessions stay up. Call back
(`callBack`) moves to phase `calling`, where `startRingback` plays the North
American phone network's ringing tone (440 Hz and 480 Hz together, 2 seconds on,
4 off); the interviewer picks up 2 to 5 seconds later and the call connects as
usual.
Hanging up before that (`cancelCallBack`) returns to `missed`. The engine gets
`callback: { how, agoMs }` and the first message becomes `[call connected: the
candidate is calling you back. You called them and it rang out with no answer
about 3 minutes ago.]`; the OPENING section tells the interviewer to thank them
for calling back, not to dwell on it, and then open as usual. The saved record
carries `returnedCall`. A missed call nobody returns within 10 minutes
(`MISSED_HOLD_MS`) is let go: everything is torn down, no record is kept, and
the window stays on the missed call with `missed: 'expired'` and no Call back.
Closing the window on a missed call abandons it quietly. Unit-tested only: not
yet tried in the built app.

**A failed reply reads as a dropped connection (2026-11-19).** When the
interviewer's reply fails twice (engine end reason `session-error`) the call
screen stays up, as it does when the interviewer hangs up, with "<name> lost
their connection" (`state.connectionLost`). The candidate leaves when they
choose, and the record keeps `reason: 'session-error'`, so the review still
treats it as a technical ending.

**Feedback is chosen after the call (2026-11-19).** The red button ends
the call at once, with no confirmation, whether or not the interviewer is still
there; after the interviewer leaves, the candidate stays on the call until they
press it. Closing the window mid-call does the same and keeps the window for
the question. The window calls `leave`, which is `hangUp({ feedback: 'ask' })`: the call is saved
as one left without feedback, the service waits in phase `ended` with
`feedbackChoice: 'pending'`, and the ended screen asks "Want feedback on this
call?". `chooseFeedback(true)` runs the transcription and review;
`chooseFeedback(false)`, closing the window or quitting the app keeps the
recording and transcript only. A call in which the candidate said nothing is
not asked. `hangUp({ feedback: true | false })` still decides at once.

**Time and silence.** Every message carries the elapsed time. Silence is
reported as `[candidate silent 10s]`.

## 6. Chat box

New and decided. The call window has an optional chat panel for typed
messages, mixable with voice.

**The candidate's voice goes through the microphone path (2026-11-21, owner's design).** So that the real
microphone pipeline can be tested with the AI voice, a line spoken in the candidate's voice is now mixed into the
microphone signal inside the helper, right after Apple voice processing (echo cancellation) and before level, the
energy VAD, the on-device SpeechAnalyzer and the 16 kHz `candidate.wav`, consumed at the capture rate so it is
"spoken" in real time on the mic timeline. The candidate hears it through a separate monitor player node on the same
engine's main mixer (voice processing's echo reference, so the real microphone does not pick it back up), which can
sound together with an interviewer. From the mix on, everything is the microphone path, unchanged: turn end from VAD,
speculation and Smart Turn (including the "sounds unfinished" hint), the live-speech looks and the 2.5 s trailing
window (section 7), the overlap and interruption rules when it talks over an interviewer, the ear's tone notes and
baseline, Scribe fillers, and the recording. Transcript entries are the recogniser's, like any speech; nothing the
interviewer, the review or the replay sees tells them apart. With the mic muted, the real mic samples are zeroed but an
injected line still goes through (with a 0.4 s tail). Without microphone permission the silent microphone feeds the
same processing at 16 kHz, recognition only if the speech assets are already installed (it never waits on a download).
- **Giving way like a person.** When an interviewer reply starts playing over a line the candidate was already in, the
  candidate carries on for a reaction time drawn from `candidateYieldMinMs`..`candidateYieldMaxMs` (300..900 ms,
  `deps.random`), to the end of the word being said, then stops with a `candidateYieldFadeMs` (60 ms) fade. A line
  started while an interviewer was already speaking is talking over them on purpose: it is not stopped, and the
  interruption rules decide. A message queued behind a line that gave way waits until the interviewer has finished.
- **Queue, chat, pause, hang-up.** Messages sent while a line is going are spoken straight after it, as one line. The
  chat is cut where the inject position reached (`candidate-voice` `cut`, as before). Pausing cancels the line with the
  fade and drops what was queued (their chat entries cut or marked "Not said"); hang-up cancels it.
- **Debug log.** `inject` entries (state, id, positions; never text or audio).
- **Fallback.** A helper that cannot inject keeps the app-played path described below (the ear's `prepareVoiced` /
  `voicedNote` and the synthetic-voice baseline are used only there).
- **Measured (2026-11-21, `scripts/practice-probes/inject-probe.mjs`, the real helper on the silent microphone, speech
  from `say`).** Ready with `inject: true`; `finished.positionMs` 12890 against 12889 ms of audio; VAD on/off at the
  speech and its 2.4 s pause; three final transcripts matching the words (numbers as digits); speech in the WAV about
  60 ms after `started` at the source level; `inject-cancel` with 60 ms fade silenced the WAV within 20 ms and turned
  the VAD off; interviewer playback worked during an injection. Not yet run with a real microphone, the monitor's
  echo-reference behaviour, or in a live call.

**The candidate's voice (2026-11-20, now the fallback).** A sent message still shows in the
chat history, but the interviewer no longer reads it: it is spoken on the call
in the candidate's own voice and the interviewer hears it as an ordinary
`Candidate: '…'` line once it has been said.

- **Voices.** At setup two library voices are drawn for the candidate, one
  female and one male (`drawCandidateVoices` in `callService.js`; `drawVoice`
  takes a `gender`), never one an interviewer could use. The Settings dialog of
  the main window (sidebar, or Settings… on the App menu, ⌘,) picks which one
  speaks (`practice-voice.json` in the profile folder; default male). It is
  read for every line, so a change applies mid-call.
- **Pipeline.** The same as the interviewers': one short Claude call
  (`practice-call-candidate-voice`, Sonnet low) adds delivery tags from the line
  and the last 12 turns, aimed at a prepared, confident candidate; then the
  ElevenLabs dialogue voice with the interviewers' model. The tagged words must
  equal the sent words, else the line is spoken plain; tags that take more than
  4 s are not waited for (`electron/practiceCall/candidateVoice.js`).
- **Playback.** Through the helper like an interviewer line, so it is on the
  interviewer track and in the replay, never in `candidate.wav` (which feedback
  transcribes). The transcript entry is `channel: 'chat'` with `voiced: true`,
  so delivery measures still leave it out. Captions show the words as they are
  heard.
- **Interviewer cut-ins.** Once 12 s of a line has played, and every 10 s
  after while at least 2.5 s is left, the main session gets the heard words
  with `[The candidate is still speaking. …]` (no acknowledgement first). It
  answers `<listen/>` (the usual case) or writes a cut-in. A cut-in sounds
  like one interviewer cutting into another (2026-11-21): the candidate's voice
  stops as the interviewer's starts, and what it was about to say plays on
  under the interviewer's leading silence and first CUT_IN_OVERLAP_MS (700 ms),
  fading out over the last 120 ms. The fade, the mix and the speech level are
  the panel voice's own code, now in `electron/practiceCall/audio/cutInMix.js`
  and used by both. The helper still plays one utterance at a time; the overlap
  is mixed into the interviewer's audio before it reaches the helper. When the
  two voices run at different rates or nothing of the line is left, the
  candidate's voice instead stops at the end of its word
  (`afterWordBoundary`, as when the candidate cuts into an interviewer). The
  entry keeps only the heard words, the overlap included
  (`interrupted`, `cutOffBy: 'interviewer'`), the rest is dropped, and the
  call then waits for the candidate. A look still being written when the line
  ends is dropped and the whole line goes to the interviewer.
- **The interviewer never reads the chat.** The chat history is for the
- **A cut-off line is cut off in the chat too (2026-11-21).** Each sent message carries a chat id to the engine. When the interviewer cuts in, the `candidate-voice` `cut` event lists, per message of the line, the words heard (by word count), and the chat entry becomes the heard words ending in " —" (`cutOff`, the sent text kept as `sent`); a message the voice never reached stays, dimmed, marked "Not said" (`unsaid`). Line breaks in a sent message are not passed to the interviewer (heard speech has no paragraphs). Unit-tested only.
  candidate only. A message the voice cannot say (no audio within 15 s, or a
  failed stream) is tried once more; if that fails too it is lost, like speech
  on a bad line: the window says "Your audio didn't go through. Send your
  message again." and the interviewer gets nothing of it. Only a call for which
  no candidate voice could be drawn at all still passes messages on as typed
  lines. A message sent while the voice is speaking is spoken next. A line that
  ends during a pause is answered on resume.
- **Practice count (changed 2026-11-21, owner's call).** A message from Suggest a reply (edited or not) is
  marked `generated` on the fallback path only (an injected line is plain microphone speech), and it now counts as the answer to a question exactly like the candidate's own words:
  for the asked-question rotation and "Practised ×N" alike. Until 2026-11-21 it did not count.
- **Tone notes for the candidate's voice (2026-11-21).** A line spoken in the candidate's voice carries a `[voice: …]`
  note like a spoken answer. When its voice is whole (or at its end, if it was cut while still streaming) the engine
  hands the ear the line's audio, `ear.prepareVoiced({ id, pcm, sampleRate, wordCount })`; the ear converts it to
  16 kHz (`audio/resample.js`) and runs the tone model in 6 s chunks in the background. When the line ends,
  `ear.voicedNote({ id, startMs, endMs, heardMs })` measures the heard part against a baseline of the synthetic voice's
  own (the same 20 s of speech rule; it never feeds or uses the microphone baseline, saved as `record.voicedBaseline`)
  and records its prosody and tone in `candidateProsody` and `toneSamples` (`voiced: true`). The turn waits at most
  `voicedNoteWaitMs` (300) for the note; a late or missing note means none. `ear.settle()` waits for these too.
  Unit-tested only.
- **Off in the unit suites.** The service draws candidate voices only when the
  app passes `candidateVoices: true` and the tag call (`candidateTagText`) in
  from `main.js`.

- **Typed turns** go to the interviewer marked as typed:
  `Candidate (typed in chat): '…'`. They carry the same elapsed time and the
  same acknowledgement and interruption notes as spoken turns.
- **"I'll type it in chat."** The interviewer answers naturally (generated,
  not canned) and waits. The app shows a typing indicator, tells the
  interviewer the candidate is typing, and pauses the silence prompt. The typing flag lapses 6 s after the last keystroke.
- **Typing while the interviewer speaks** follows the same rules as talking
  over it. More than 2 words interrupts, with the heard-text note. A shorter
  message goes to the classifier.
- **Interviewer posts.** The interviewer may post to chat with a
  `<chat>…</chat>` tag. The text is shown, not spoken. Example: a problem
  statement.
- **Feedback.** Typed turns count for content feedback but are excluded from
  delivery metrics. The review notes which answers were typed.

## 6b. Pictures and diagrams on shared screens (2026-11-21)

A prepared screen may carry one visual above its text, made during setup so
every screen is ready before the call rings (the owner: a real interviewer has
their slides ready). Most screens get none: the planner adds one only when it
makes the question clearer or illustrates it better than text, at most 4 per
plan (`visual` on a part: `kind` picture or diagram, `search`, `shows`). A
spoken question a picture would help (living a year in a moon colony, with a
photo of the lunar surface) may get a one-part screen just for that.

- **Pictures** come first from Parallel's image search across the web (the
  `image_search` tool of the Parallel MCP server, signed in with the owner's
  Keychain key so it runs Parallel's "advanced" mode; without a key, the free
  "fast" mode). The owner chose this on 2026-11-21: the app is for personal use,
  so licences do not narrow the choice. A probe that day returned direct image
  links with their pages and sizes in 1.4 s (anonymous mode: three Alamy stock
  previews, which the pick step rejects for watermarks). No watermarked picture
  is ever shown (the owner, 2026-11-21: it looks unprofessional): images hosted
  on, or found on a page of, a stock library that watermarks its previews
  (`WATERMARKED_HOSTS`: Alamy, Shutterstock, Getty, iStock, Adobe Stock and
  others) are never downloaded, the search asks for clean photos, and the pick
  step rules out any image with a watermark, however faint, before choosing.
  When the web gives
  fewer than two usable images, Wikimedia Commons tops the choice up to six.
  Images are downloaded whole (at most 5 MB, a known size of at least 400×250),
  and one Claude call (`practice-call-visual-pick`, Sonnet medium) looks at them
  beside the screen and keeps one only if it really fits; "none" is a normal
  answer. A Commons photo shows its credit (author, licence, "via Wikimedia
  Commons"); a web photo shows none, like a presenter's own slide.
- **Diagrams** are drawn as SVG by one Claude call (`practice-call-diagram`,
  Opus low) from the screen's own content, every value checked against it.
  `safeSvg` accepts only a short list of drawing elements with no scripts,
  styles, links, images or outside references, and the window shows it through
  an `<img>`, where nothing could run anyway.
- **Timing.** Visuals start when the plan is settled and run beside the voice
  warm-up and audio start; the new setup step "Preparing the shared screens"
  waits for them (90 s budget) before the interviewer sessions start, since
  their prompts list what each screen shows. A visual that fails or runs late
  is left out and the screen keeps its text.
- **Where they live.** Saved in the call folder (`visuals/<ref>.<ext>`) and
  served by `practice-call://<callId>/visuals/<file>` (`replayProtocol.js`; plain
  files only, an SVG with a policy that blocks everything), so the live screen
  and the replay use the same address.
- **Who sees them.** The interviewer's plan lists `pictureAboveTheText` or
- **A picture's lead sentence (2026-11-21).** The screen text is written before any picture is found, so on its own a picture can read as an afterthought. The pick step may return `lead`: one sentence, stating only what is plainly visible or certain, that ties the question to that exact picture ("The photo above shows…"). It goes above the part's text (`settleVisuals`), so the window, the interviewer's plan and the replay all show the screen as one piece; a screen whose picture was not kept keeps its text unchanged. Diagrams need none: they are drawn from the screen's own content. Unit-tested only.
  `diagramAboveTheText` with a description, and the prompt lets it refer to the
  visual naturally. Suggest a reply gets the description, the diagram's SVG and
  the picture itself (as an image).
- **Off in the unit suites**: nothing is searched or drawn unless the app passes
  `visualPickText` and `diagramText` in from `main.js` (and `imageSearch`, for the
  web search).
- Claude Design was considered: it is a separate product (claude.ai/design) with
  no API the app could call during setup.

Unit-tested only (2026-11-21): no live call has made a visual yet.

## 7. The interviewer interrupting the candidate

**The watcher (built 2026-11-21, owner's design; unit-tested and measured offline only, not yet run in a live call).**
An interruption must be about what the candidate said in the last few seconds and must come from a real reason AND
the interviewer's personality. A first version (earlier the same day) let the main session take a look every 10 s; each
look took 3 to 4 s on Opus low, so it noticed late and filled the main session's history. Now a small, fast session
decides whether to cut in, and the main session only writes the line.

- **The watcher session** (`SESSION_MODELS.watcher`, Sonnet low; started only when the app passes `watcher: true` from
  `main.js`, so it is off in the unit suites; restarted like the classifier, with the conversation so far before its
  READY line). Its instructions (`buildWatcherInstructions`) hold the reasons, the rule, each person's role, temperament,
  manner and interrupting style, and the planned questions with number, asker and minutes. It answers exactly `<listen/>`
  or `<cut-in who="B" reason="probe"/>` (`parseWatchDecision`; anything unreadable, or a who not on the call, is listen).
  Without a watcher, the earlier timed looks below stay as they were.
- **When it checks.** After `cutInFirstMs` (12 s) of an answer: at every breath (a VAD end shorter than `speculateMs`;
  a check starts at the VAD end and its result is dropped if the pause turns into a turn end), and at least every
  `watchEveryMs` (2500) while the candidate talks without a break. One check at a time; a breath during a check is owed
  and starts as soon as it returns. A check that fails or times out (`watchTimeoutMs`, 2500) counts as listen and the
  next one waits a full `watchEveryMs`; a crashed watcher is restarted once, and the next check waits for it. Each
  check (`formatWatchMessage`) carries the question asked (the last interviewer line), its plan number and asker, the
  answer so far at that instant, the last sentence heard, elapsed call time and how long the answer has run. No checks
  while paused, during a reply, while an app-played voice line plays, or after the call ends. Live microphone speech
  and injected AI-voice lines are the same path; the app-played fallback keeps its position-based looks (section 6).
- **The reasons and the rule.** long (against the plan's minutes for the question; rough norms about 2 minutes for a
  behavioural story and 30 to 60 s for a factual answer; past about twice the plan almost anyone steps in), off-topic,
  probe (a detail just said), enough (they have what they need), misunderstood, and composure (only for roles where
  handling interruptions is part of the job, such as sales, consulting or client-facing work, and only when the
  personality fits). A cut-in needs both a reason and the personality: a reason with the wrong personality, or the right
  personality without a reason, is listen. A pause alone is never a reason. No fixed cap: the old "a real interviewer
  rarely cuts in / never more than a couple of times" wording is gone. Never on the candidate's own questions at the end.
- **Personality.** A required plan field per person, `interrupting` (the planner writes it for the lead and every
  colleague; `validatePlan` rejects a plan without it; carried into the persona, the panel, the prompts and `call.json`):
  what makes them jump in, how readily, how it sounds, and when (almost always at a breath or sentence end; mid-phrase
  only for a very blunt person, and rarely). Planner examples are illustrations, never lines. `who` is the asker unless a
  colleague's own area is clearly what the answer is about, and then less often.
- **On a yes.** The main session gets the usual live look (`[The candidate is still speaking. …]`) with the latest words,
  `[Most recent: '…']` and a line naming who would cut in and why. It writes the cut-in as that person (their speaker
  tag on a panel), in their manner and interrupting style (both are in its instructions), about the reason and about
  what was said most recently; the engine inserts no wording and the prompt describes style, not words. It may still
  reply `<listen/>`.
- **Natural timing.** A cut-in ready while the candidate is mid-sentence is held until the next VAD end, at most
  `cutInHoldMs` (1500). **Stale guard:** at commit, more than `cutInStaleWords` (12) words said since the look's snapshot
  drops it silently (discard reason `stale-cut-in`) and asks the watcher again at once; the worst case reacts to speech
  about 4 s old.
- **Events** (in `debug.jsonl`): `watch` (ms, decision, who, reason, wordsSinceSnapshot, trigger, ignored) and `cut-in`
  (held, stale, committed, with who, reason and heldMs).
- **Measured offline (2026-11-21, `ai-test-runs/2026-11-21-cut-in-watcher/`).** 42 check points in the long answers of
  call-mwq2lkdo-jz4w5m, cold CLI. Two blind judges agreed on 40 of 42 (each cut in once, on different cases). Sonnet low
  matched the agreed cases 39/40 and 40/40 over two runs (one false cut-in in one run, and one wrong who); Haiku low 40/40.
  Latency p50/p95: Sonnet 817-850 / 1962-2193 ms, Haiku 886 / 2892 ms (CLI overhead included; the warm in-call session
  should be faster, not yet measured). About $0.0008 a check for Sonnet with a cached prefix. Recall is untested: the
  set held almost no case where a cut-in was clearly due. After it, the who rule (the asker unless clearly a colleague's
  area) and the twice-the-plan line were added.
- **Research behind it.** In a job-interview dialogue corpus the listener took the turn at 84% of transition-relevance
  places (clause or sentence complete in grammar and intonation) and at 1% of other places (Hara et al., Interspeech
  2019), and interruptions in a speaker's pause start about 373 ms into it on average (Gravano and Hirschberg,
  Interspeech 2012), hence the breath checks and the hold. Why interviewers interrupt (OPM structured-interview guidance;
  recruiter guides): pace and time, a tangent, probing a detail just said, redirecting when they have enough, clarifying a
  misunderstood question, and in some roles testing composure. Frequency varies widely by interviewer (some interrupt
  10 to 20 times a call out of curiosity, others hardly ever), and frequent interrupting lowers candidates' sense of being
  listened to (Communication Monographs 1984) and the candidate experience (ACM IUI 2023), hence personality rather than
  a cap. About a quarter of speaker changes in expert-novice conversation are interruptions, mostly cooperative (NoXi,
  LREC 2022).

**The timed looks (built 2026-11-21, now the fallback without a watcher).** A microphone answer gets a look
`cutInFirstMs` (12 s) after its first speech, then every `cutInEveryMs` (10 s), on the main session itself, with the
same conditions as above; `<listen/>` leaves no trace, and a look still being written is dropped when the candidate
stops. A look answered with words commits at once over the live speech; the candidate's words so far become an entry
with `interrupted: true` and `cutOffBy: 'interviewer'`.
- **Talking over each other for a moment (the owner's worry).** A person cannot stop the instant someone cuts in. For
  `cutInYieldMs` (2.5 s) from when the cut-in is heard (re-anchored on the helper's `started` event), candidate speech
  never stops, pauses, floor-bids or classifies against it: those words join the cut-off entry, and a VAD end in the
  window schedules no turn end. Speech that runs on past the window, or a fresh onset after it, is an ordinary overlap
  judged by the usual rules, measured from the window end (the candidate is pushing back). The window closes as soon as
  the cut-in itself ends, so words said after a short cut-in ("Go on.") are a new answer, never added to the old entry
  (found in review on 2026-11-21). Voiced cut-ins and every other reply keep their interruption rules unchanged.
- **Known gap.** Words are assigned to the cut-off entry by the recogniser segment's start time, so a segment that
  starts inside the window and keeps growing after it loses its later words. Fine if the helper emits short
  per-phrase segments; not yet checked on real speech.
- **Feedback.** `callMetrics` counts `interviewerCutIns` (any candidate entry with `cutOffBy: 'interviewer'`, voiced
  or live), the review transcript marks "the interviewer had to stop the candidate here" and the review cites the
  count.

## 8. Personas and voices

Pick the voice first, then a fitting name.

- **Labels.** ElevenLabs voices carry labels for gender, age, accent and use
  case (verified via the API).
- **Pool.** Conversational English voices with known gender at price
  multiplier 1.0, from the built-in voices and the shared Voice Library.
  Library voices need a paid plan via the API.
- **Names.** A distinct regional accent gets a name common in that region.
  Broad American and British accents get a name from a deliberately diverse
  pool. Neutral-gender voices are included and get gender-neutral names. Age
  can inform seniority. Name pools are data, not checks.
- **Temperament.** Warm, neutral or tough. Unless the user picks tough, the
  interviewer (Claude) chooses it to fit the voice: the main session's
  prompt describes the voice (age, accent, gender, the descriptors after the
  dash in its ElevenLabs name, its `descriptive` label and a 200-character
  blurb with the voice's own name cut out) and asks for one temperament with
  a sound-based rule (warm only for clearly warm or playful voices, neutral
  for calm or professional ones, tough for firm or deep confident ones) and
  "do not default to warm". It answers `READY <temperament>`; only the last
  line counts, since Claude sometimes explains first. The opener session
  starts after that with the same temperament, which adds one session start
  to the precheck. An unreadable choice falls back to neutral
  (`persona.temperamentFrom`: `claude`, `request` or `fallback`). A restarted
  main session gets the settled temperament. Without the rule Claude chose
  warm for all 8 account voices (2026-11-08). With it, the same choice came
  back every time over 3 runs: 3 warm, 4 neutral, 1 tough (Charlie).
- **Consistency.** One consistent voice per persona.
- **Eligibility.** A voice joins the pool only when it is conversational,
  has a gender label, is English (labels, fine-tuning and verified languages;
  premade voices carry no language label and count as English) and has a price
  multiplier of at most 1. Until 2026-11-08 a Chinese-language library voice
  ("Xin", `language: zh`) passed the conversational filter.
- **Selection.** One uniform random draw over the high-quality tier of the
  ElevenLabs shared library (`category=high_quality`, the voices ElevenLabs
  has reviewed as studio quality) and never over the user's own account
  voices. Chosen by the owner on 2026-11-17: the tier keeps 558 of the 2,961
  otherwise eligible voices, with a median yearly use about seven times the
  whole pool's. The tier is asked for in the request and checked again on
  the row drawn. It does not filter manner: a voice described as
  "Expressive and Upbeat" is in it. Before that date the draw covered every
  English conversational voice (3,427 on 2026-11-08, about 70% male). The voice used on the previous call is skipped while another exists
  (`lastUsed` in `<userData>/practice-voice-pool.json`). The draw is
  GET-only (`/v1/shared-voices`) and never writes to the account. Temperament
  variety comes from the voice pick, since Claude's choice is steady per
  voice. Checked live by `scripts/practice-probes/persona-e2e.mjs`
  (`--claude K` starts K real interviewer sessions and records their
  choices; `--library-draws N` chains N real draws and checks gender,
  consecutive repeats and GET-only traffic). There is no fallback: if the
  library cannot be read, or no eligible library row is found, the call ends
  with `voice-library-unavailable` before it rings and the loading screen
  shows "Could not load an interviewer voice from the ElevenLabs voice
  library. Check your internet connection and try again."
- **Library voices** are used straight from the shared library and never
  saved, removed or edited (`electron/practiceCall/eleven/voiceLibrary.js`):
  an unsaved library voice id works with the text-to-dialogue WebSocket, and
  the app sends no POST or DELETE to `/v1/voices`, so it can never hit a
  voice-slot or voice-operation limit. The first line of an unsaved voice is
  slow (~4.5 s on 2026-11-08) while every later line is ~0.2 s, the same as
  an account voice; loading time at call start does not matter to the user,
  mid-call latency does. So a library voice gets exactly one discarded
  warm-up `Hi.` while the call is loading, before it can ring: measured
  latencies stay ~0.25 s for the greeting and later lines, even after 30, 90
  and 180 s of silence. If the warm-up errors, returns no audio or does not
  finish within 15 s, the call ends with `voice-warmup-failed` before it
  rings and the loading screen shows "The interviewer voice did not respond.
  Try starting the call again."; nothing falls back to an account voice and
  no helper, track or session is created. The probe's step 10
  measures the warm-up and the greeting on a real drawn library voice and
  saves the greeting WAV. Background from 2026-11-08: saved library voices
  take no custom voice slot (a Starter account with 10 slots reported
  `voice_slots_used` 1 while holding 8 saved library voices, because slots
  count only Voice Design and cloned voices), and saving or removing one
  cost 0 of the 65 monthly voice operations (`voice_add_edit_counter`
  stayed 0; editing would cost one).
- **Audio format.** 44.1 kHz on Pro and above (same credits; ElevenLabs
  bills per character). 24 kHz on Free, Starter and Creator: ElevenLabs
  refuses `pcm_44100` below Pro (403 `subscription_required`, verified live
  on Starter 2026-11-08). Tiers it does not know ask for 44.1 kHz and fall
  back to 24 kHz automatically.
- **Listening test.** The user found the conversational voices Roger, Chris,
  Jessica and River sounded much better than the narrative voice George.

## 9. Panel interviews (built 2026-11-17)

A call may have a panel: the lead interviewer plus up to four colleagues (ids A to E, five tiles).

- **One mind, several voices.** The lead's main Claude session plays every interviewer and marks who speaks with `<speaker id="B"/>`. Each interviewer has an ElevenLabs voice of their own (`eleven/panelVoice.js` plays the segments of one reply in order as one utterance). This is what lets them talk to each other: hand-overs, building on each other's questions, catching a colleague up.
- **The AI casts the call from the questions (redesigned 2026-11-17, agreed with the owner).** Nothing about the cast is chance, and the lead never picks a number of interviewers. During setup four more library voices are drawn as candidates (only the chosen ones are warmed up). On its READY line the lead writes one JSON object: its own job title (`role`), the plan numbers of the questions it will ask in this call in order (`questions`), its voice setting, and the colleagues it brings (`panel`, each with a role and a focus). Its instructions walk it through this order: pick the questions for this call and its length; for each, ask whether a person in its own role could credibly ask it and judge the answer; group the ones it cannot cover by the expertise needed, one colleague per group; nothing outside its role means a solo call. A focus note that says who should be on the call overrides this. The random lean towards a panel and the random pick between two lead titles are gone. With no title in the reply the lead is "Hiring Manager".
- **Question rotation.** Each prepared question is shown to the lead with how many earlier calls for the same job asked it (`timesAskedBefore`). It favours questions never asked, may repeat a staple, and once all were asked favours the least asked; code never shuffles or draws. The lead marks the first time it asks a prepared question with `<asked n="3"/>`, which is never spoken. The engine counts the tag only for a reply that is delivered, and at hang-up the service adds one per asked question that was also answered (`answeredQuestions`: at least 15 candidate words or a pad edit after it, since 2026-11-19) to `<userData>/practice-question-history.json` (per job, by prepared-card id, so re-running Prepare starts fresh counts). This costs no AI call and happens with or without feedback. `call.json` gains `pickedQuestions`, `askedQuestions` and `askedQuestionIds`.
- **Measured on the real prepared job (2026-11-17, four setups).** With no focus note: a recruiter lead who picked 9 of 17 questions and brought one staff engineer for the two coding questions; and an engineer lead who picked 6 including a coding question and ran it alone. "About 10 minutes": an engineer lead, 5 questions, alone. "45 minutes, behavioural only": an engineer lead, 11 behavioural questions, alone. So the title the lead gives itself decides solo versus panel: a lead that makes itself an engineer covers the coding questions itself. The owner asked for that to change the same day: the lead is now told it owns the interview (the hiring manager, the lead of the team or a recruiter), settles its title before looking at the questions, and never stretches the title to cover everything; a hands-on exercise or deep specialist question belongs to a practitioner. Four setups after that: twice an engineering manager who picked 7 questions and brought a senior engineer for the coding question; "about 10 minutes", a manager with 4 questions and no coding, alone; "behavioural only", a manager with 10 questions, alone. Drawing the lead and four candidates took 9 to 14 library requests, 2.2 to 5.1 s in all; the ring came 12 to 19 s after start.
- **Late joiners are rolled by chance.** Each candidate colleague is late with 60% chance and then joins 40 to 210 s after the call is answered, whatever is happening at that moment. Their tile appears with a chime, they say nothing, and the next message to the lead carries a note that they joined. The lead introduces them at the next pause and catches them up in a sentence. Until then nobody may speak as them (the engine ignores a speaker tag for someone not on the call).
- **Conduct.** The same rules are in the casting instructions and in the settled instructions, because the lead's session is never restarted after it picks its colleagues: a hand-over is finished in the same reply, a specialist does not repeat the introduction questions, the colleague who asked usually takes the answer, the lead says the farewell.
- **The candidate's questions are never cut short for time (owner, 2026-11-21).** The clock limits only the interviewers' own questions. Past the upper target the interviewer starts nothing new of its own, goes to the candidate's questions if they have not had them, answers every one fully by the person best placed (it may say lightly it is happy to run a couple of minutes over), and closes only once the candidate has nothing more to ask. It never offers to answer only some of them. No code limit ends a call by time. Prompt only.
- **Answering the candidate's questions as a panel (2026-11-21).** In call-mwq2lkdo-jz4w5m the candidate asked one question of two colleagues and one of the lead; the lead said "glad you asked", a colleague answered straight after with no hand-over, the lead went on, and the second colleague never spoke. The panel conduct now says each question is answered by the person it was asked of, the floor passes between them with a short hand-over or bridge, never back to back as if one mind were speaking, and the lead closes. Prompt only; not yet heard live.
- **Greeting once (2026-11-19, prompt only, unit-tested for the text).** In the call-mwnvhypn-666sq7 record a colleague said "Hey Jack." over the lead's introduction and again when handed the floor 40 minutes later. The panel conduct rules now say a colleague greets the candidate once; one who already said hello (a spoken-over remark counts) or was introduced and has spoken starts their first line on taking the floor with their question or a reference to what was said, never another hello. No parser stripping.
- **Tiles.** Every interviewer shows as a circle with the first letter of their first name on a solid colour picked from the name, as a video call shows someone with no photo. The speaking interviewer's tile has the ring.
- **Record.** `call.json` gains `panel` (who, role, focus, when they joined) and interviewer transcript entries carry `speakerId` and, when two spoke in one reply, `segments`.

Verified in live calls from source: a panel opening with introductions, a hand-over with the colleague replying in his own voice, a colleague joining mid-sentence at 3:15 and being introduced after the candidate's next answer, and follow-ups by the interviewer who asked.

## 9d. The planning step (built 2026-11-18, replaces the READY-line casting in section 9)

Loading time before the ring does not matter (owner, 2026-11-17: "speed only matters AFTER a call has started"), so the call is planned by one careful call before any interviewer session starts. Section 9's "the lead casts on its READY line" is history: the lead's setup reply is a bare `READY` again and `castFromReady` is gone.

- **Order of setup.** Draw up to five library voices (V1 to V5) → `planCall` (`practiceCall/callPlanner.js`, stage `practice-call-plan`, DeepSeek Flash high reasoning since 2026-11-20, see docs/ai-model-selection.md) → settle the cast from the plan → warm the lead voice → start classifier, main and opener once → ring. The window shows "Planning the interview" meanwhile.
- **What the planner decides.** The kind of interview, which pool questions are asked and in what order, the lead's title, who else is on the call and which questions each asks, a time budget per question, which drawn voice fits which person (best effort from what was drawn, never a re-draw; owner ruling), each person's temperament or voice stability, room amount and manner (manner only, no company facts), probes per question, and prepared on-screen problems with a worked reference solution, edge cases and a hint ladder.
- **Prepared screens.** A planned problem is shown by reference, `<screen ref="p1.2" delay="6"/>`; the engine resolves the ref. An unknown ref is dropped and reported to the lead once.
- **The interviewers never see the prepared answers (owner, 2026-11-18).** The planner and every interviewer session get the questions only, plus the application the candidate submitted for the job: the résumé and cover letter text stored in the application artifact (`loadInterviewApplicationText`, the `applicationPositioning` fields). Probes come from the application and the question. Only the post-call review still compares against prepared answers.
- **One unprepared question per call (owner, 2026-11-18).** The plan has exactly one question that is not in the pool: the entry with `number: 0` and `text`. The planner reads the whole pool first and writes something realistic for this interview that no pool question already covers, and places it where it fits naturally in the order (not by default last). It is asked like any other, never marked `<asked/>`, never counted in the rotation history, saved as `call.json` `unpreparedQuestion`, and the review judges it on its own as a test of adaptability.
- **Validation, no silent fallback.** `validatePlan` rejects any broken plan whole; the retry prompt carries the rejected plan and its problems; after three failed attempts the call fails with "The interview could not be planned" and nothing rings.
- **Saved for diagnosis.** `call.json` `setup`: the plan, the problems of each failed attempt, `planMs`, and every drawn voice with whether it was used. The same goes to the log.
- **Per-call debug log (built 2026-11-19; unit-tested only, not yet seen in the built app).** Every call writes `<callId>/debug.jsonl` (0600, in the call folder, so it shares the call's privacy) through `practiceCall/callDebugLog.js`: one JSON line per event with `t` (wall time), `up` (ms since the folder was made), `ms` (call clock, null before the call is answered), `event` and `data`. It records phase changes, setup steps and their durations (`setup-timing`: voices, plan, cast, voice warm-up, audio helper, sessions), planner attempts and problems, every `note()` and warning, every engine event whatever its type (`timing`, `opener`, captions, speaker, session restarts...), helper events (vad, final transcripts, errors, recording), the messages sent to the interviewer sessions (`session-turn`: the service wraps each session's `turn`), session restarts, the candidate's actions (answer, decline, mute, chat, pause, hang-up, window closed), the feedback choice, each analysis stage with its duration, and failure text. Strings are cut at about 2,000 characters; audio, keys and paths outside the call folder are never written. It is strictly best effort: a queued append that never throws or blocks, flushed when the call is finalized, abandoned or failed. No `appendFile` on the injected fs (`deps.debugFs`, default `deps.fs`) or no folder means no log. A call whose folder could not be made has no debug log; only the app log has its warnings.
- **Retention of debug logs.** Nothing deletes `call.json`, `analysis.json` or a finished call's folder: they accumulate forever. Recordings are removed only by "Delete recording" and, after a stored review, the two WAV sources (the mix `call.m4a` stays). Unchanged. New: at the start of a call and after each call is finalized, `callStore.pruneDebugLogs` deletes `debug.jsonl` of every call except the newest 10 by start time (the running call is protected; a folder with no `call.json` is ordered by its change time and is removed once only its log was in it). It never touches `call.json`, `analysis.json` or audio. `callStore.remove` (a setup that failed or a missed call that expired) now keeps `debug.jsonl` and clears the rest. Bug reports include the newest 3 logs with every text reduced to its length except notes, warnings and errors (2026-11-20; see "Bug reports" in `interview-helper-app.md`); `debugLogStats` gives their count and size. Since 2026-11-20 the log also holds the call window's own events (`window`) and each step of the feedback review (`analysis-*`).
- **Leftover raw audio (2026-11-19).** Measured on this machine: a call folder is `call.json` (20 to 40 KB), `analysis.json` (about 45 KB) and `call.m4a` (0.6 and 4.3 MB for the two calls here, 64 kbit/s AAC), so records barely grow and recordings are about 99% of the space. The real pile-up was the raw audio: `candidate.wav` and `interviewer.wav` (recorded during the call, about 60 to 150 MB each for 30 minutes) and the mix `call.wav`, left behind for ever when a review failed (R9 kept the tracks, but nothing ever read them again: there is no retry) or the app quit during a call or its review. After every call, in the background, `tidyLeftoverAudio` in `practiceCall/callService.js` (with `callStore.leftoverAudio` and `deleteRawAudio`) goes through every other call folder (never the one just finished, which keeps its tracks until the next call, nor a call that started meanwhile): with a finished `call.m4a`, or with no `call.json` (a call quit mid-way, which nothing in the app can open), the raw files are deleted; with a record but no recording, `call.m4a` is made from the mix or the two tracks first and the raw files are deleted only once it exists (a failed encode, or only one track, leaves them). Records, reviews, recordings and debug logs are never touched. - **Recordings kept for the newest 10 calls (owner's call, 2026-11-19).** After the leftover-audio pass, `callStore.pruneRecordings` (`RECORDINGS_KEPT` 10, by start time across all calls) deletes the audio of every older call (as "Delete recording" does) and marks its `call.json` `recordingPruned: true`; the record, transcript, chapters, review and debug log stay, so the past-calls list and the replay still show it, and the replay says "Only the 10 most recent calls keep their recording." The call that just ended and a call in progress are never pruned, and a call outside the newest 10 is not rescued into `call.m4a` first (its raw audio is simply deleted). Records still accumulate, at about 70 KB a call.
- **No reply needed is the AI's call.** `<listen/>` means the candidate sounds unfinished (line joined to what comes next, however long the pause). `<pass/>` means the line is finished and needs no answer, such as an "okay" after "give me a minute": kept in the transcript, nothing spoken, silence wait restarts. No timer chooses between them.
- **Live run from source, 2026-11-18** (typed answers, "panel, about 10 minutes, one coding problem"): planned in 60 s on the first attempt; manager lead plus a senior engineer from four drawn voices; unprepared question placed fifth of seven; the lead dug at a date gap from the résumé; the engineer joined late, was introduced, said a filler during the share setup, showed the prepared problem, and caught a planted bug in the pad by pointing at one of the checked examples. Found and fixed: the plan budgeted 28.5 minutes because the focus note's length was not treated as the call length. Not exercised: `<pass/>` on a spoken line (typed lines always get a reply), and the unprepared question being asked aloud.

- **Typed and spoken lines follow one rule (owner, 2026-11-18).** A typed line that needs no reply gets `<pass/>` exactly like a spoken one. `<listen/>` stays spoken-only, and on a typed line the engine reads it as `<pass/>`.
- **Only the main session decides whether a line gets a reply.** A `<pass/>` from the acknowledgement session means only that it makes no sound. Found in the second live run on 2026-11-18: its pass on "Going well, thanks for asking." cancelled the main reply, and the interviewer only spoke again at the silence check.
- **Wording fits the voice's accent (owner, 2026-11-18).** Each interviewer is told the accent ElevenLabs lists for their voice and chooses the everyday words a speaker from there would use, lightly and consistently, never a caricature.
- **Second live run, 2026-11-18** (solo, "about 10 minutes"): the plan budgeted 7.5 minutes; a typed "okay" got no reply; the unprepared question was asked fourth of five in the interviewer's own words and was not counted in the asked history; the interviewer followed up from the cover letter. Not yet exercised live: `<pass/>` on a spoken line, and the accent wording rule (added after this call began).

## 9b. Shared screen and coding pad (built 2026-11-17)

Technical questions are hard by voice alone, so the interviewer can share its screen and open a coding pad. It decides per question whether to use the screen, the pad, both or neither; no code rule picks.

- **Tags in the reply.** `<screen title="…">content</screen>` shows a formatted question and replaces what was shown; `<screen-stop/>` stops sharing; `<pad-open lang="python"/>` and `<pad-close/>` open and close the pad. They are parsed like `<chat>` and never reach speech or captions. A closing tag inside a fenced code block is code, and a `>` inside a quoted title does not end the tag.
- **What is spoken.** The interviewer says one short line pointing to the screen and the spoken instructions; it does not read the content out. A question in several parts shows one part at a time, and the next part replaces it when the candidate has finished.
- **Content format.** Paragraphs, `- ` bullets, fenced code blocks, inline code and bold. The window builds it from parsed text as React elements; no HTML is interpreted. Caps: title 120, content 6,000 characters.
- **The pad.** A monospace editor with line numbers and a Ready button. The window owns the text while typing and sends it debounced. The interviewer receives the pad text with the candidate's next turn only when it changed; Ready is a turn of its own. Typing in the pad uses the same typing signal as chat, so silence check-ins wait. No code is run.
- **Layout.** Google Meet's presenting view was the starting point, not the target: this window has one purpose, so while a screen or the pad is up the layout is built around the question and the code. One bar across the top names who is presenting and holds everyone on the call as small chips (picture and first name, a blue ring on whoever is speaking, the candidate as a chip while their camera is off). There is no tile strip. Under the bar the question and the pad share the whole width side by side (stacked when the chat panel is open on a narrow window). With the camera on, the candidate's preview floats small in the bottom corner. The tile grid returns when sharing ends. In the grid, with three or more tiles the last one carries its name at the top so the candidate's own picture does not cover it.
- **Pad keys.** Tab writes two spaces and Enter keeps the indentation of the line it leaves.
- **Record, replay, review.** `call.json` gains `screens` (title, content, who, from and to) and `pad` (language, snapshots each time the text reached the interviewer and at hang-up). The replay shows the screen and pad as they were at the playback time, and the feedback review receives the screens and the final code.
- **Verified.** A live call from source: part one on screen with examples and the pad opened, a short spoken pointer, code written and Ready pressed, the engineer judging the code, part two swapped in after a follow-up, the record and feedback referring to the code. In the built app: the presenting layout with the chat panel closed and open, typing in the pad and Ready. Also seen in the built app: the replay showing the screen and the pad as they were at the playback time, and the content-first layout with three interviewers, chat panel open and closed, with code in the pad. The chip bar was then run with five interviewers in the built app. Chat closed, all five named chips fit. Chat open, they squeezed the presenting line to one letter, so with the chat panel open and four or more interviewers the chips show the picture only (name on hover); seen again with five after the fix. Not exercised on screen: Enter keeping indentation (unit tested only) and the camera preview while sharing.
- **Leaving the call (built 2026-11-19, unit-tested only, not yet seen in the built app).** An interviewer who left (`interviewerLeft`, or `status: 'left'` for one of a panel) loses their tile: it fades and shrinks out over about 300 ms (`pc-leave`), then is removed, and the remaining tiles re-flow. When nobody is left the candidate's own tile expands from its corner to the whole stage (`pc-expand`, `data-self="full"`): camera picture, or the "You" avatar centred. In the presenting layout the chips of people who left go away. The left-the-call or lost-connection notice stays. Both animations are off under prefers-reduced-motion.
- **Staggered departures (built 2026-11-19, unit-tested only, not yet seen in the built app).** When the interviewer ends the call (engine `ended`, reason `interviewer`, which the engine emits only after the farewell has finished playing, or after the last silence check-in) nobody vanishes at once: each interviewer on the call (the lead and every colleague who had joined) leaves on their own delay of 2.0 to 4.0 s in steps of 0.1 s (`deps.random`, one draw each, lead first; `deps.clock`), measured from that event. Each departure sets that person's participant `status: 'left'` (the tile fades out, a soft falling two-note `playLeaveChime` plays, quieter than the join chime) and emits `participant-left`. `state.interviewerLeft` (the notice, the full-stage candidate tile, the disabled chat) turns true only when the last one has gone. In between the call is over for the interviewers: the engine has ended, so no line, silence check, typed message or late joiner reaches any session; the chat box still takes a typed line (a real call lets you type) and shows it, but nothing answers and nothing is recorded as delivered; pause and pad are closed. A candidate hang-up or closing the window finishes the call as usual (the reason stays `interviewer`) and every pending departure timer is cleared with the join timers. A lost connection (`session-error`) still drops everyone at once. `call.json` gains `leftAtMs` on the persona and each panel entry (call clock, like `joinedAtMs`; absent for someone still on the line at hang-up) and `interviewerLeftAtMs` (the last departure).
- **Record fixes (2026-11-19, unit-tested only).** `call.json` `thresholds` was always null: it now holds the engine's `DEFAULT_CALL_THRESHOLDS` merged with `deps.thresholds`. `pauseSpans` (`[{ startMs, endMs }]`, on the recording timeline like the transcript, after the lead trim; one still open at hang-up is closed there) is written, and `getReplay` returns `pauseSpans`, `pausedMs` and `activeMs` (length minus pauses). The ended screen shows the active length (`state.activeMs`; the engine's elapsed time already left pauses out). The voice descriptions sent to the planner no longer repeat or end mid-sentence: parts are normalised, a part contained in a longer one is dropped, and the line is cut at a word under 300 characters with an ellipsis (observed in `setup.voices` of call-mwnvhypn-666sq7).
- **Acknowledgement model (2026-11-19).** `SESSION_MODELS.opener` is Sonnet at low effort (this morning's probe: Haiku low leaked content in about 5 of 25 reactions, Sonnet low in 0 of 25, at about +0.1 s, whole reply p95 794 ms); section 4b's recommendation is now applied. Its length and how it joins the reply: section 4c.

## 9c. Pauses, cut-ins and talking over (built 2026-11-17)

- **Pause patience is the interviewer's judgment.** A reply may end with `<wait s="90"/>`: how long a silence would be normal after it (long for a hard problem, a shared screen or the pad; short after a greeting). The engine clamps it to 6 to 300 s; with no tag it is 20 s. Check-ins come at W, then W + clamp(W, 12, 30), then + clamp(1.5 W, 20, 45), so the default is 20, 40 and 70 s of silence; a check-in reply may set the next gap with its own tag. Each check-in note carries its number ("check 2 of 3"): a nudge, then asking whether the candidate can hear, then saying the line seems to have dropped and ending. After the third check the engine ends the call itself if nothing comes back, whatever the model replied, so a call can never run on in silence. Typing in chat or in the pad still holds the timers. This replaces the fixed 20 s, +30 s, +45 s schedule described in earlier sections. `call.json` gains `endedBy: "silence"` for such a call.
- **Two kinds of overlap, set by the owner after listening (2026-11-17).** (1) A remark over a speaker who keeps talking is one to three spoken words (`<over id="B">Hey Jack.</over>`, one per reply, a colleague who has joined); a longer one is dropped by the parser. `eleven/panelVoice.js` synthesises it on that interviewer's own stream and adds its samples to the outgoing audio from the moment the speaker reaches that point (found from the word timings; position counted in non-whitespace characters). Speech is synthesised faster than it plays, so the main audio waits for the whole remark while there is audio buffered ahead (never more than 3 s, at least 250 ms). (2) A longer line is a cut-in: the interrupted interviewer gives way, written as a sentence broken off mid-thought with a dash and a speaker switch (the parser marks the switch `cutIn`), and when the first interviewer picks the thread up there is no overlap, because resuming is not an interruption. Both are kept to once or twice a call and never during the candidate's answer. The window rings both interviewers during a remark, its caption is its own line, and its transcript entry is marked `overlay`.
- **How long a cut-in overlaps.** The first version started the interrupter 350 ms before the end of the interrupted audio. The owner heard no overlap: it sounded as if the speaker knew the interruption was coming and paused for it. The cause was that a synthesised segment ends in near-silence and a stopping tone, so those 350 ms held almost no speech. Measured overlap in real talk averages about 0.65 s with 80% under 1 s (LREC 2024 broadcast corpus), and most interrupted turns show little overlap at all (ICSI meetings, Interspeech 2016), so the target is a short but clearly audible overlap: the interrupter now starts 700 ms before the interrupted SPEECH ends (trailing silence found by level and dropped), the interrupted voice fades over its last 120 ms, and the interrupter's leading silence is skipped.
- **Call sound: a room per interviewer, then the call codec.** Each interviewer's voice passes through `audio/callSound.js` before the voices are mixed: early reflections, a short reverberant tail, a rumble filter and a low-pass, and call-style levelling with a limiter. No noise is added, because call software removes steady noise. People on a call sit in different rooms at different distances from their microphones, so each voice has its own room: the lead sets a "room" amount from 0 to 1 for itself and each colleague on its setup line (0 is a headset in a quiet room, 1 a laptop microphone in a bare room), and `roomFor(voiceId, amount)` turns that into the decay (160 to 480 ms) and microphone distance (direct-to-reverberant 15 to 6 dB), with the filters and level varying by voice. With no amount the room comes from the voice id alone. The minimum is never dry: the owner found a voice with no room at all sounds too perfect, so the lowest setting is a slight room, barely noticeable unless listened for. The mixed audio then goes through the real Opus codec (`audio/callCodec.js`, package `opusscript`, voice mode, 24 kbit/s, wideband, 20 ms frames) on its way to the speaker and the recording; it adds about 26 ms of delay and falls back to untreated audio if it cannot load. Opus takes 24 kHz audio directly; a 44.1 kHz stream (paid ElevenLabs tier) is passed through untreated, which is a known gap. History: two echoes and a faint hiss won 2 of 3 against clean audio in a blind set, then lost every time to a modelled room without hiss, and the codec version was preferred or tied in all three sets.
- **The interviewer watches the pad; there is no Ready button.** The owner found the button unnatural and asked for what happens in a live coding interview. While the pad text keeps changing the interviewer is sent it about every 25 s, and once more when typing stops for 12 s; never when nothing changed. Most of these get `<listen/>` (silent, no trace). Speaking up is never required: it comments only when a real person in that role would, and on a panel it is the interviewer whose area the code is. The candidate can keep typing while it talks. It never treats the code as finished until the candidate says so, because they may be testing. Edits in the pad hold the silence checks by themselves; the window sends no typing signal for the pad.
- **Sharing a screen takes the interviewer a moment.** The `<screen>` tag carries `delay`, the seconds it takes to find the document and start sharing this time (2 to 20, default 6, usually 5 to 15; 0 to 3 when only swapping what is already shared). Control tags take effect when playback reaches their place in the reply, after the words before them have been heard (at first they fired when the reply began, which put the screen up before the interviewer had said it would share). At a share that takes a second or more, the reply is spoken as two separately synthesised pieces with real silence between them (`stream.gap(ms)` in `eleven/panelVoice.js`): the words before the tag play to their natural end, the setup time is silence in the audio itself, and the words after the tag start cleanly as the content appears. Nothing shows in the window meanwhile, and a pad opened in the same reply appears with it. A solo call uses the panel voice with only the lead, so the gap works there too. History: the first version paused playback of one continuous stream at the tag, which clipped the start of the next word, once landed two words late (the voice reports delivery tags such as [warmly] as timed words, so positions are now compared on letters and digits only with tags removed from both sides), and cut a word's dying sound; the owner asked why the audio was being cut at all, and the pausing code was removed. Measured in a live solo call from a word-timestamped transcript and audio levels: the sentence before the tag died away by 16.4 s, 8.3 s of quiet, the screen appeared at 24.5 s and the next sentence began at 24.6 s, with no pause or resume issued.
- **Share timing with a multi-word delivery tag (fixed 2026-11-21).** In call-mwq2lkdo-jz4w5m the reply was "…in stages. <pause s="4"/> One moment. <screen ref="p1.1" delay="4"/> Should be up now." The recording shows speech to 984.5 s, 4.3 s of quiet, "One moment." at 989.0 s, 4.4 s of quiet, then "Should be up now" at 994 s, but the screen came up at 988.1 s, before "One moment.". The voice times a delivery tag of several words (`[slightly amused]`) as several timed words, and `heardChars` stripped tags one word at a time, so those letters counted as heard speech and the screen control fired about one phrase early. `heardChars` now follows the brackets across words, and `heardFor` drops a tag only partly heard. Unit-tested; not yet seen in a live call.
- **A voice that breaks off by itself.** On `eleven_v4_turbo` a delivery tag before the last word makes the line stop sharply: measured on one voice and line, the level fell from half to quiet in 160 ms with `[interrupted]` before the last word, against 920 ms for the same line ending in a dash alone (a drawn-out trailing word) and 320 ms for a finished sentence; a tag placed after the dash did nothing. The owner found the tagged version more natural, and the cut-in instructions now tell the interrupted interviewer to write it.
- **Who is on the call.** While any cast colleague has not joined, every message to the lead says who is on the call and who is not. Until a colleague joins, the lead runs the call itself: it may say they are joining shortly, but does not introduce them as present, hand over to them or ask their questions. If it does write a switch to an absent colleague, nothing is spoken for them in any voice, and the lead is told at once and recovers in its own words. Nobody is made to join early (a first patch did that; the owner rejected it as unrealistic). Seen live: "my colleague Tomas will be joining us shortly", then Tomas introduced and speaking in his own voice after joining at 1:31.
- **Hidden pause.** P pauses and resumes the call (Command+P or Control+P from inside the chat box or the pad). While paused no silence check-in fires, the call cannot be ended for silence, and the elapsed time the interviewer sees stands still. Only the shortcut resumes (owner's rule): speech during a pause is dropped, and a chat message or Ready is refused. The chat box stays editable with a reminder under it and the draft is kept for sending after the resume. The timers themselves stay tuned for a candidate who speaks.
- **Verified live from source.** A silent call: a nudge and "can you hear me?" 16 s after the greeting, "are you still there?" 23 s later, "looks like the line's dropped" 24 s after that, and the call ended. A three-person panel: a colleague's "Hey Jack, good to meet you." spoken over the lead's introduction, with the overlay in the transcript at the right time. The mixing itself is covered by numeric tests; whether it sounds right is for the owner's ear (clip in `tmp/voice-compare/overlap/`). A later live call had both kinds in its opening: "Hey Jack." over the lead, and a colleague cutting in before the lead resumed with "As I was saying" (clips in the same folder).

## 9a. Voice delivery (2026-11-17)

The model is `eleven_v4_turbo`, the real-time member of the v4 family, over the Text to Dialogue WebSocket. Full `eleven_v4` also works on that socket (first audio about 0.6 s against 0.2 s, twice the price); comparison clips are in `tmp/voice-compare/`.

Plain, polished sentences came out flat. What changed:

- **The other voice settings (decided by the owner 2026-11-17).** `clone_strength` is sent as 0 for every interviewer voice, ElevenLabs' recommended value. `similarity_boost`, `style`, `use_speaker_boost` and `speed` are not sent, so the service defaults apply. By his instruction this was not probed live or compared by ear.
- **Stability is chosen by the AI, per voice, once at setup** (`voice_settings.stability`, sent in the first socket message; the service default when nothing is sent is 0.5, and lower values widen the emotional range). The lead's start instructions carry a VOICE SETTING section (only when the voice is described, never on a restart or with a settled panel) and the lead writes its own value, and one per colleague, as JSON on the READY line (`READY <temperament> {"stability":0.3,"panel":[...]}`; solo calls carry `{"stability":0.3}`). Values are clamped to 0.15 to 0.75 and anything unusable is ignored. 0.3 is the starting point and the fallback (`VOICE_STABILITY`): blind listening preferred it on most lines, but a voice the library describes as expressive or upbeat overacted at 0.3, so one fixed value does not fit every voice. The lead's voice is made again with the chosen value after the READY reply (the warm-up is not repeated), colleagues' voices are made with theirs before their warm-up, and the call record keeps `persona.stability`, `persona.stabilityFrom` (`claude` or `fallback`) and `stability` on each panel entry.
- **The interviewer writes for the voice.** A DELIVERY section tells it to talk like a person on a call (contractions, an ellipsis for a thinking pause, an occasional restart or filler, fragments), to direct delivery with free-form tags in square brackets placed before the words they apply to (`[warmly]`, `[thoughtful, slower]`, `[flat, unconvinced]`, `[light laugh]`), to choose the delivery from what is happening in the call, to stress a word with capitals rarely, and to spell words normally. Tags are stripped from captions, the transcript and heard text.
- **Checked live:** tagged lines are performed, not read aloud (Scribe transcripts of the audio contain no tag words and keep the "um").
- **Flush.** The service waits for about 40 characters and 8 words before it makes a sound, so a one-word acknowledgement was silent until the reply arrived (2.6 s). The engine now sends `flush` after the acknowledgement (0.2 s).

## 10. Phase 0 measurements

All on synthetic scenarios.

### Interviewer benchmark

9 configurations × 2 runs. First-sentence time in ms (p50 / p95). Quality is
from blind judges over 7 scenarios; the judges did not know the configs.

| Config | First sentence p50 / p95 (ms) | Blind-judge quality |
|---|---|---|
| opus / low | 1398 / 2040 | 83.1% |
| opus / medium | 1516 / 2611 | 83.1% |
| opus / high | 1612 / 2493 | 85.4% |
| sonnet / low | 1628 / 5520 (one timeout) | 76.7% |
| sonnet / medium | 2331 / 5559 | 76.2% |
| sonnet / high | 3283 / 5278 | 72.3% |
| haiku / low | 1347 / 1857 | 77.0% |
| haiku / medium | 1400 / 2704 | 72.3% |
| haiku / high | 2118 / 4255 | 73.1% |

Keep-listening was correct in every config. No single config met the
original 1.5 s p95 gate, which led to the two-part design (section 4).

### Opener

First word p50 / p95. Rule-following means a short reaction of at most 12
words with no question.

| Opener | First word p50 / p95 | Rule-following |
|---|---|---|
| Claude CLI, warm, Opus low | 0.70 / 1.17 s | 34/34 |
| Claude CLI, Haiku low | 0.93 / 1.89 s | 3/34 |
| Anthropic API, Haiku, thinking off | 0.44 / 0.82 s | 11/34 |
| Anthropic API, Sonnet, thinking off | 0.58 / 0.97–1.07 s | 23/34 |
| Anthropic API, Opus (thinking cannot be disabled; adaptive at low effort) | 0.95–0.98 / 1.92–2.29 s | 34/34 |
| DeepSeek Flash, one-shot via offload | whole opener 1.41 / 1.70 s (complete reply, not first word) | frequently ignored the length rule |

**Decision:** the opener is Opus low on the warm Claude CLI. Thinking is
adaptive at low effort, on the Ultra plan, with no API spend.

### Main reply

Opus low. Quality is within noise of Opus high, first-sentence p95 is 2.0 s,
and the reply is ready before the opener finishes speaking.

### Classifier

Acknowledgement versus interruption, 48 cases. Every config was 100%
accurate. The fastest p95 was Opus low at 1087 ms. The 0.6 s gate is
unreachable with a warm CLI (about 0.9 s floor), and the user relaxed it to
1.2 s. **Decision:** Opus low.

### Voice

| Model | Time to first audio |
|---|---|
| ElevenLabs Flash, one session | 160 / 169 ms |
| ElevenLabs Flash, another session | about 546 / 574 ms |
| Turbo | 535 / 576 ms |
| Multilingual v2 | 501 / 535 ms |
| v3 | 531 / 612 ms |

Turbo, Multilingual v2 and v3 were measured in the same session. Word alignment arrived in every trial.

User listening test: v3 was the most realistic. Flash and Multilingual v2
are indistinguishable when spliced; v3 is audibly different. So one model
speaks a whole reply. Conversational voices (labelled `conversational`)
avoid the storytelling feel of narrative voices.

**Decision:** ElevenLabs only; v3 with conversational voices. The final pick
is confirmed in Phase 4.

### Filler recall for post-call analysis

16 speakers from the AMI Meeting Corpus test split (CC BY 4.0), scored
against the human transcript.

| Engine | Fillers found | Recall | Result |
|---|---|---|---|
| Apple SpeechTranscriber, on-device | 147/341 | 43% | Fails the 80% rule (the SDK has no disfluency option) |
| ElevenLabs Scribe v2 | 311/353 | 88% | Passes; about 0.4 s per short clip; works on the ElevenLabs free tier |

**Decision:** Scribe v2 is the only speech-to-text vendor supported for the
post-call verbatim transcript. AssemblyAI and Deepgram were considered and
rejected, so one vendor holds both voice and transcription. Apple
SpeechAnalyzer stays for the live in-call transcript.

### Known prompt gap

Fix in Phase 3: at 46:00 elapsed no config properly began wrapping up. The
Phase 3 prompt now gives time-anchored wrap-up guidance from the upper target
(start about 5 minutes before it, close after it). Not yet re-measured live.

## 10a. Phase 3 threshold tuning (simulation)

The harness (`scripts/interview-practice-simulate.mjs`) drives the real engine
with a virtual clock, fake helper, fake voice and fake sessions whose
latencies are the Phase 0 measurements. Within-answer pauses are REAL: 1380
gaps from the AMI Meeting Corpus test split (CC BY 4.0), in
`scripts/fixtures/ami-within-turn-pauses.json`: median 1.61 s, 36% over 2 s,
10% over 4 s. The speech text is synthetic.

Silence alone cannot tell a thinking pause from a finished turn at these
lengths. The opener and main models decide (`<listen/>`); silence only sets
how soon they are asked. A wrong guess means the interviewer starts a reaction,
the candidate keeps talking, and playback stops after about 0.3-0.5 s, as a
real interviewer would. So a small cut-in rate is accepted for lower latency.

Sweep, 20 seeds, voice gate 1.2 s, models right about "still thinking" 90% of
the time (an assumption; not yet measured on real fragments):

| speculateMs | Answers with a cut-in | Talk-over | Last word to first sound p50 / p95 |
|---|---|---|---|
| 400 | 12.5% | ~330 ms | 1.85 / 2.20 s |
| 500 | 10.8% | ~420 ms | 1.95 / 2.27 s |
| 600 | 8.3% | ~480 ms | 2.05 / 2.41 s |
| 800 | 5.8% | ~410 ms | 2.25 / 2.60 s |

At 100% accuracy there are no cut-ins; at 80% they roughly triple. commitMs up
to 1.5 s changes nothing (generation is slower than that); 2.0 s or more only
adds delay. The voice gate adds no latency in any row.

**Decision:** speculateMs 0.5 s, commitMs 1.2 s, voiceGateMs 1.2 s,
interruptWords 2, interruptMs 0.7 s (a duration stop needs at least one
transcribed word, so echo residue never stops playback), silence prompt 10 s (raised to 20 s after the first live runs on 2026-11-17),
classifier timeout 2.5 s. Confirm in the Phase 6 live checklist.

## 11. Post-call analysis

**The replay, redesigned (owner, 2026-11-21).** Less text, feedback in step with the audio. No transcript and no
chapter list: the window is a slim header (title, overall score, Overview, delete), a focus area, and a player docked at
the bottom. Before playback (or on Overview) the focus area shows the overall score, the summary cut to two sentences
(More), the top three "Work on first" and an "All feedback" toggle (the compact `FeedbackView`, no transcript). Once a
part plays or is picked it shows that part: Question / Your answer, who asked, the title, and its feedback (score,
What worked, Work on, Adapting, the extension behind a disclosure; a moment's kind, score and note; follow-up moments in
the same part under it), with the shared screen or pad beside it when one was up. Feedback is attached to parts in code
(`matchFeedbackToChapters` in `src/practice-call/replayModel.js`): each asked planned question's `askedAs` and each
moment's `prompt` is matched to the interviewer turn it quotes (normalised substring first, else at least 60% of its
content words, stopwords left out; quotes under three words must be exact), then to the chapter holding that turn. On
call-mwq2lkdo-jz4w5m: 7 of 7 asked questions and 10 of 10 moments on the right part, none left over. A paraphrase that
shares 60% of its content words with an unrelated line can still attach to it (a stricter floor lost a real paraphrase).
The player: a large play button, back/forward 10 s, previous/next part, speed 1x to 2x, and a 48 px timeline of the
parts as blocks, each a lighter question share and a solid answer share, tinted by score (green 8+, amber 5+, red, grey
without), with moment ticks and a hover card. Keys: Space, Left/Right 5 s, Up/Down part, Home/End (inside the feedback
area Up, Down, Home, End and Space scroll it). Pauses: the recording is not re-cut; the whole replay runs on the active
clock, the timeline leaves paused spans out, and playback jumps over them (checked every animation frame). Checked by
eye in a preview with the real call at 800 px; not yet seen in the app window. `getReplay` now sends `startedAt` for the
header.

**Voiced and spoken answers are judged the same (owner, 2026-11-21).** A line spoken in the candidate's voice is a
spoken answer everywhere after the call: it counts in `answers`, never in `typedAnswers`; pace, pauses and tone come
from its own measurements (section 6, against the synthetic voice's baseline); fillers are 0 because the voice has
none (it is meant to be a polished version of the candidate) and Scribe runs only when there was live speech. The
review never sees whether a line was voiced or came from Suggest a reply, and never calls it typed. Only a truly
typed, unvoiced chat line is typed, and the typed-only note fires only when nothing was spoken live or by voice. The
replay follows the same rule.

**Deterministic metrics, computed in code** from the timed transcript and
the recording:

- Pace in words per minute, per answer and for the fastest 20 s window.
- Pauses longer than 1 s and longer than 2 s; response latency.
- Answer length flag at about 2 minutes; talk ratio.
- Candidate interruptions, and whether each came before the question
  finished.
- Restarts and repetitions, and um/uh, from Scribe's verbatim transcript.
- Pitch range, P90−P10 of F0, against the candidate's own baseline.

**Judged by Claude in the review.** Word fillers ("like", "you know") and
hedges, counting only non-lexical uses. No string lists in code.

**Review.** One Claude review call writes the existing feedback schema,
extended with a delivery section that cites the metrics. The aim is fewer
fillers, not zero. The result goes into the existing practice feedback
history and is shown in `InterviewPracticePanel`. Feedback is read, never
spoken.

**Privacy.** Recordings go to ElevenLabs for Scribe. After successful
analysis they are deleted: locally unless "keep recording" is on, and from
ElevenLabs if its API allows.

**Review fixes after a real call (2026-11-19; unit-tested and run offline on call-mwnvhypn-666sq7, no Claude call made).**
- *Picked cards.* `buildReviewPrompt` replaces the full PLAN with PICKED QUESTIONS (`pickedCards` in `reviewPrompt.js`): the cards in `pickedQuestions`, in the plan's order (`setup.plan.questions`, whose `number` is the 1-based index into the prepared pool; 0 is the unprepared question), each with the engine's asked/answered flags and the planner's probes. The card number is the identity; unpicked cards are never shown. `checkReview(raw, transcript, picked)` then holds `feedback.planned` to them (`repairPlanned`): question matched by text ignoring case and spacing, strays and repeats dropped, order and exact question text restored, `asked` taken from the engine (an unasked card keeps no judgement), a missing unasked card added, a missing asked card rejected so the review is retried. The unprepared question is its own last entry when the reviewer reports it. A record without `pickedQuestions` keeps the old whole-plan prompt and no check.
- *Rules.* Answers are judged against the question and follow-ups actually asked (unasked prepared points only in `extension`); hedges are quoted as hedges; typed text is never critiqued for typos; the unprepared note applies only if the transcript shows it was reached.
- *Typed-only calls.* The prompt asks for one delivery summary line, empty pace/pauses/fillers/confidence (also in communication) and drops the metrics section.
- *Length.* `length` is `durationMs - pausedMs` and says the paused time (typing) is excluded; transcript times stay on the recording clock, which includes the pauses.
- *Chapter markers.* Candidate typed lines no longer produce markers; interviewer chat markers are cut at a word with an ellipsis.

## 12. Phases

| Phase | Scope |
|---|---|
| 2 | Practice audio helper. |
| 3 | Conversation engine, simulation harness and threshold tuning. |
| 4 | Voice provider and call window. |
| 5 | Post-call analysis and feedback UI. |
| 6 | Live checklist for the user. |
| 7 | After acceptance: the interviewer interrupts long answers. |
| Done | Panel interviews (section 9). |

**Phase 3 simulation harness.** A scripted candidate with real timing.
Cases: "right" or "gotcha" mid-sentence (no stop, no reply); "sorry, do you
mean X?" (stops and answers); a 1.5 s mid-answer pause (no cut-in); 10 s of
silence (the interviewer reacts); hang-up; session crash (recovers);
end-call (farewell, then ends); and chat cases (typed turns, "I'll type it
in chat" with the typing indicator and paused silence prompt, typing while
the interviewer speaks, a `<chat>` post). Phase 3 tuned the thresholds (section 10a) and added the wrap-up guidance.

**Phase 4 call window.** Incoming-call screen with a ringtone and Answer
button; interviewer tile with a speaking ring; optional camera tile; mute,
hang up and timer; captions toggle, off by default; prepared-answer cards
switch, hidden by default; chat panel; call-ended screen. A generic
video-call look, with no Google Meet branding.

## 13. Rules carried forward

- Never mention the app, the tool or the feedback in character.
- Never invent company facts. Answer only from the sealed brief and deflect
  otherwise.
  A lead asked for a figure the brief lacks (their own team's size, say) no longer
  says "I'd rather not throw out a number offhand" (call-mwnvhypn-666sq7, 2026-11-19,
  prompt only, text unit-tested): they speak as someone who knows the team but
  cannot pin it down (still being shaped around the project, changes with the
  phase), point to the recruiter for the current picture, and give no number.
- Model choices use family aliases, with reasons.
- No word lists in code checks.
- Fixtures are labelled synthetic.
- The ElevenLabs API key lives in the Keychain item
  `infinite-canvas-elevenlabs-api-key` and is never logged.

## 14. Live checklist (Phase 6)

Run after building the app. Wear headphones for the first call. Timings come from the call record (`<userData>/practice-calls/<callId>/call.json`, `timings` and `transcript`).

1. **Setup.** Interview Helper → Prepare done → "Start practice call". First time: the consent screen lists the two models (32 MB, 610 MB); agree and wait for the download. Pass: the pre-call check shows a moving mic level and when setup finishes nothing rings until "I'm ready" is pressed; then "Waiting for call…" shows and the incoming-call screen rings with a persona name a few seconds later.
2. **Answer and first reply.** Answer; the interviewer greets you. Pass: speech starts within about 3 s, sounds like one consistent voice, captions (if turned on) match.
3. **Thinking pause.** Answer a question, pause 2-3 s mid-thought, then continue. Pass: no interruption in most tries (a rare short "mm" reaction that stops is acceptable).
4. **Acknowledgement.** Say "right" or "mm-hm" quietly while it talks. Pass: it keeps talking without a hiccup and does not reply to it.
5. **Interruption.** Interrupt with "sorry, do you mean …?". Pass: it stops within about half a second, answers the clarification and does not resume its old sentence.
6. **Short interruption.** Say "no, wait" over it. Pass: it pauses, then either yields or picks back up naturally.
7. **Silence.** Say nothing for 20 s after a question. Pass: it prompts or rephrases once, and does not prompt again for another 30 s.
8. **Chat.** Type an answer in the chat panel. Pass: it treats it as your answer; it may post a written problem statement in chat.
9. **Off-brief question.** Ask something the brief does not cover. Pass: it deflects, never invents a company fact.
10. **End.** Let it wrap up (or hang up). Pass: farewell, then the call ends; the replay screen appears after analysis with chapters per question, markers (long pauses, interruptions, fillers, chat), the transcript highlight following playback, and feedback with a delivery section.
11. **Replay check.** Click a "less confident" or pause marker. Pass: the audio jumps to that moment and you hear both voices in sync.

**Feedback page scrolling (2026-11-19).** The page could not be scrolled: the window's body has `overflow: hidden` and the replay root was `min-h-screen`, so it grew past the window and was cut off. The root is now exactly `h-screen` (flex column, `overflow-hidden`). The header and the player strip (recording, status notes, seek bar, time, delete confirmation) stay fixed. The feedback column and the chapters/transcript column are two `overflow-y-auto min-h-0` regions with no visible scrollbar (`.pc-scroll-hidden`) and `tabIndex=0`, so wheel, trackpad and keyboard scroll each on its own. Below 720 px the two columns stack, each half the height. The transcript list no longer has its own `max-h-56` scroll. Measured in Chrome with a stub bridge at 760 x 520 (with and without feedback, with no recording, at 1.5x text size): both columns overflow, both scroll, and the header and player stay put. Not yet seen in the built Electron app; the structure is unit tested.

**Replay page: paused time, highlight, follow, typed-only, unasked (2026-11-19).** Built in `Replay.jsx`, `replayModel.js` and `InterviewPracticePanel.jsx`; unit tested, and also run in Chrome (not the built Electron app) with a throwaway Vite page rendering the real Replay with the real call-mwnvhypn-666sq7 `call.json`/`analysis.json` and a silent stand-in recording, at 760 x 520.
- **Paused time.** The payload's `pauseSpans`, `pausedMs` and `activeMs` (absent on old calls: nothing changes) drive the player. A `timeupdate` inside a span, or a seek into one, lands on the span's end. Spans are shaded on the seek bar (`.pc-paused-span`). When they exist the time row reads `3:30 / 6:00 · recording 89:08`, and every time shown (row, chapters, moments, transcript) leaves the paused time out; the positions themselves stay on the recording clock. The past-calls label shows the active length (`callLengthMs`: `activeMs`, else `durationMs - pausedMs`); `listPracticeCalls` summaries must carry `pausedMs` or `activeMs` for that to show.
- **Transcript highlight.** `turnAt` skips zero-length overlay turns except for 1.5 s after they start, and treats a typed candidate turn (chat channel, or `endMs <= startMs`) as current from the end of the turn before it until the next turn starts.
- **Follow playback.** While playing, a new current turn that is out of view moves `scrollTop` of the `data-replay-scroll="chapters"` container (never `scrollIntoView`). Not on first mount, and not for 4 s after a wheel, touch or key scroll in that container.
- **Typed-only.** When `analysis.metrics.typedOnly` is true (read from `replay.analysis.metrics` or `replay.metrics`) the delivery section is one line (the review's `delivery.summary`, else "Delivery was not measured: every answer was typed."), and the communication rows for pace, pauses, confidence and filler are hidden. Rows with an empty value are always hidden.
- **Unasked cards.** Planned questions with `asked: false` are one collapsed `<details>` ("N prepared questions were not asked") listing their titles, after the asked cards.


Report any failure with the step number; the call record and `analysis.json` have the timings needed to diagnose it.
