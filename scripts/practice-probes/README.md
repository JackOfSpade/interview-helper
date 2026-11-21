# Practice-interview Phase 0 probes

Measurement probes and a live-call runner. Nothing here is imported by the app.

**Recordings and transcripts stay out of the repo.** Use a scratch directory
(`/tmp/speech-probe` below) and delete everything in it after scoring.

## A. Does Apple's on-device SpeechTranscriber keep um/uh?

Rule: if it keeps >= 80% of the reference um/uh, analysis stays local.

Requires macOS 26+ on Apple Silicon and Xcode command line tools. The first
`record` run asks for microphone permission for your terminal app.

```sh
# 1. Build into a scratch dir
scripts/practice-probes/build-speech-probe.sh /tmp/speech-probe/SpeechProbe

# 2. Record 150 s while reading scripts/practice-probes/reading-script.md aloud
#    (say every marked {um}/{uh}, and speak the [restart: ...] words)
/tmp/speech-probe/SpeechProbe record --seconds 150 --out /tmp/speech-probe/reading.caf

# 3. Transcribe the file on-device (may download speech assets the first time)
/tmp/speech-probe/SpeechProbe transcribe --in /tmp/speech-probe/reading.caf --out /tmp/speech-probe/words.json

# 4. Score
node scripts/practice-probes/filler-score.mjs --script scripts/practice-probes/reading-script.md --transcript /tmp/speech-probe/words.json

# 5. Delete the recording and transcript
rm -rf /tmp/speech-probe
```

Verdict: `local` (recall >= 0.8), `cloud` (recall < 0.8), or `INCONCLUSIVE`
(empty transcript or WER > 0.5, i.e. a bad recording; re-record).

Note: the SDK's SpeechTranscriber has no disfluency option (only
`etiquetteReplacements`), so the probe passes no transcription options.

## B. A whole live call from source, answered by chat

`live-call.mjs` runs the real call service with a stand-in for the microphone helper, so a full
call (ring, interviewer, voice, models, hang-up, recording, review) can be driven from a terminal.
Drop text files into `<outDir>/inbox` to answer as the candidate; see the header of the file for the
commands. It spends Claude usage and ElevenLabs credits.

```sh
node --import ./scripts/test-stubs/register.mjs scripts/practice-probes/live-call.mjs "$PWD" /tmp/practice-live "Quick recruiter screen, about 6 minutes"
```

It does not cover microphone capture, on-device transcription or turn-taking on real speech: those
need a spoken call in the built app.

## C. The acknowledgement ("opener") on the real Claude CLI

`opener-ack.mjs` feeds interviewer-line / candidate-line pairs from a saved `call.json` to the real opener
instructions on one warm Claude CLI session, in call order, and prints every reaction with its latency, word count
and structural rule breaks (word count, question, ellipsis, digits, content words shared with the candidate's line).
Whether a reaction reads like a real listener is for the reader. Spends Claude usage only.

```sh
node scripts/practice-probes/opener-ack.mjs <call.json> --model haiku --effort low --limit 25
```

The acknowledgement chooses its own length (no target note since 2026-11-19), so the probe sends none.

## D. The main session's time to its first sentence (what the acknowledgement must cover)

`main-first-sentence.mjs` starts one real main interviewer session (Opus low by default) with the real instructions
(`buildInterviewerInstructions`) built from a saved call's persona, panel and plan (a stand-in brief: the record does not
keep the real one), greets, then replays the call's candidate lines in order. Each message is built as the engine builds it,
with the `[You have already started your reply out loud with ...]` marker carrying a plausible reaction and
`[You last said ...]` carrying the session's own last reply, and long pauses taken out of the call clock (`activeElapsed`).
It prints, per turn and as p50/p75/p90/p95, the time to the first delta, to the first complete sentence (the
transport's own sentence splitting) and for the whole reply, and `--json` keeps each reply's full text. Spends Claude
usage only.

`main-latency-breakdown.mjs` replays the same way and times, per turn, the CLI's first stream event, thinking, the first
text and the first sentence (`--model`, `--settings JSON`, `--thinking off`).

## E. Rendered turns: what the candidate would hear

`turn-audio.mjs` replays a saved call's lines on a warm acknowledgement session (Sonnet low) and reply session
(`--model`), and for the turns in `--turns` speaks both with the call's real ElevenLabs voices in the engine's order,
pauses and flushes, placing each audio chunk where a player would play it. It writes `turn-NN.wav` (a soft click marks
the end of the candidate's line) and `index.json` with texts and timings. `--stability-add 0.15` raises every voice's
stability; `--text-only` writes texts only, no voice. Spends Claude usage and ElevenLabs credits.

```sh
node scripts/practice-probes/turn-audio.mjs <call.json> --model opus --turns 2,4,6,9,12,13,17 --out <dir>
```

```sh
node scripts/practice-probes/main-first-sentence.mjs <call.json> --model opus --effort low --limit 26
```

## F. The helper's inject commands, end to end

`inject-probe.mjs` launches a real Practice Audio Helper build, waits for `status ready` (checks `inject: true`), speaks
two synthetic sentences with a 2.2 s pause (macOS `say`, converted with `afconvert` to 24 kHz PCM16) into the microphone
signal over `inject` / `inject-audio` / `inject-end`, and prints the inject, vad, transcript and playback events with
numbers, then reads the 16 kHz recording. Run 1 also plays an interviewer line (`play`/`audio`/`end`) during the
injected line; run 2 sends `inject-cancel` with `fadeMs` 60 after 3 s. Without microphone permission the helper runs on
its silent microphone (level stays 0 before the line), which must still carry the injected audio. Scratch files go to
`--out` (default `/private/tmp/claude-501/inject-probe`); delete them after reading. No network, no credits.

```sh
node scripts/practice-probes/inject-probe.mjs "<path to practice-audio-helper>" --out /tmp/inject-probe
```

## Tests (no network, no microphone)

```sh
node --test scripts/practice-probes/filler-score.test.mjs
```
