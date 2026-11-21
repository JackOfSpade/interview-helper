# AI model and effort selection

This file records which model and effort each AI call in Interview Helper uses, why, and what was measured. Read it before testing a call again: a call marked **Proven** needs no new test unless a re-test trigger applies.

The policy, the measuring method and the results from before the split come from `infinite-canvas/docs/ai-model-selection.md`. That file's Interview Helper rows are history as of 2026-11-18. From 2026-11-20 this file is the record for this app.

Settings live in code:

- Interview stages, the typed-job stages, career file conversion, the practice-call plan, review and suggested reply: `electron/ipc/careerWritingCore.js` (`INTERVIEW_QA_STAGE_PROFILES`), all run by `electron/ipc/interviewClaudeTransport.js`.
- DeepSeek routing: `electron/ipc/aiCallProviders.js` (`qa:<stage>` keys). A routed stage keeps its Claude profile in the table only as a record. It never falls back to Claude.
- Live practice-call sessions: `electron/practiceCall/callService.js` (`SESSION_MODELS`, `MAIN_REPLY_MODELS`).
- Dormant code: the worker tasks in `claudeTaskProfiles.js` and the application stages in `APPLICATION_STAGE_PROFILES` came over with the shared code. Nothing in this app calls them, so they are not assessed here.

## Policy

- **Hard exclusions.** Never use `max` effort, for Claude or for DeepSeek reasoning. Never use Fable. Always use the latest model: the Claude family aliases (`haiku`, `sonnet`, `opus`) and the newest DeepSeek Flash and Pro.
- **Candidates.** A call that is not live is laddered across DeepSeek Flash and Pro (reasoning off, low, medium, high) as well as Claude Haiku, Sonnet and Opus. The exceptions stay on Claude: calls that use web tools (`qa-research`, `typed-job-research`), calls that read images (`career-file-to-text`) and truth checks (`qa-card-repair`). `interviewStageMayOffload` enforces this.
- **No fallback.** A routed call is answered only by DeepSeek. If Offload credit runs out, the call fails with `OFFLOAD_CREDIT_EXHAUSTED`. A rejected reply is corrected by DeepSeek again.
- **Calls that are not live.** Use the cheapest setting, by measured cost per call with retries included, whose quality is within the noise floor of the best tested setting. The noise floor comes from rerunning the reference setting. Generation time does not count.
- **Live calls** (they run while a practice call is going on). Use the fastest setting by p95 among those that meet the call's quality floor. A faster setting that breaks the call's rules is not eligible. When the speed gain is insignificant and the quality loss significant, the better-quality setting wins.
- **Every call is proven by a test.** A choice made by analogy is a placeholder until it is measured.
- **Re-test triggers:** a new model release in a family, a changed prompt, schema or validator, a new candidate provider, or a production signal such as rising retries.

## Model versions tested

`aiModelCalibration.js` (`CALIBRATED_MODELS`) must match this table.

| Date | Claude | DeepSeek | Covers |
|---|---|---|---|
| 2026-11-20 | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (ids in each result row) | alias `deepseek-flash` / `deepseek-pro` through Offload; the exact version is not exposed | Every 2026-11-20 result below |
| 2026-11-09 to 2026-11-19 | the same 5.5 ids | the same aliases | Results carried over from infinite-canvas, and the 2026-11-19 practice-call measurements in `callService.js` |

## How to measure

- Real prompts are recorded per attempt in `<userData>/ai-replay-samples/<task>/` (owner-only): the text, the answer, the resolved model, effort, cost, duration and the validator outcome. Offload-answered attempts are not recorded there.
- Replay them with infinite-canvas's `scripts/claude-effort-ladder.mjs run` (run from that repo, with `--ephemeral` so it writes nothing to that repo). It takes Claude `model:effort` arms and DeepSeek `flash:<reasoning>` and `pro:<reasoning>` arms. Records are `{id, task, text, systemAppend}`, one per line. Validate the answers with this app's own validator for the stage.
- Live calls: `scripts/practice-probes/` (main reply timing and parity, opener), `scripts/interview-practice-benchmark.mjs`. The classifier probe for 2026-11-20 is in the run folder below.
- Judge blind: shuffle the answers under labels, keep the key apart, and have two judges score each answer against the call's own failure modes. Include the stored production answer as one more arm.
- Run outputs, scorers, judge packets and keys: `~/Library/Application Support/Interview Helper/ai-test-runs/<date>-<name>/`. Never put them in the repository.

## Results by call

Status: **Proven** means tested from the bottom with a confirmation run. **Partial** means measured but thin (few prompts, one run, or a missing confirmation). **Needs test** means it was chosen by analogy.

### Prepare and Q&A (not live)

| Stage | Current | Status | Evidence |
|---|---|---|---|
| `qa-research` | Opus high, Parallel Search | Proven (2026-11-09, re-checked 2026-11-15) | Blind judges: Opus high was within noise of xhigh, and every lower setting lost content. It was re-checked under Parallel Search over 4 bundles. On 2026-11-20 the prompt was unchanged apart from one line naming the listing's source. Web tools, so it stays on Claude. |
| `qa-brief` | **DeepSeek Pro, reasoning low** (routed 2026-11-20; was Opus low) | Proven (2026-11-20) | 5 real prompts × 2 runs, two blind judges. Pro low 6.56, Opus low reruns 6.35 and 6.45 (noise floor 0.10, per-case spread about 3), production 6.55, Sonnet low 6.03, Pro high 5.63. First-try valid: Pro low 9/10, Opus low 10/10. Flash failed exact copy on half its answers (5/10 valid), so it was not chosen. Cost $0.021 against $0.123 a call. The prompt is unchanged since its 2026-11-10 Claude proof. |
| `qa-write` | **Sonnet medium** (2026-11-20; was Opus medium) | Proven (2026-11-20) | Re-test trigger: the evidence is now plain career text split into pieces, not a compiled profile. Ladder on 3 real banks, two blind judges: Opus medium reruns 7.83 and 6.83 (floor 1.0), production 7.83, Sonnet medium 6.83, Sonnet high 6.83, Opus low 6.33 with only 12 cards. Every Claude arm was 100% valid. DeepSeek Flash high and Pro high truncated at the 32k output cap. Confirmation, 3 banks × 2 fresh runs each: Sonnet medium 6.92, Opus medium 6.92 (rerun gaps 1.5, 1.0 and 0.0), production 7.5. 6/6 valid in both. The app's card checks failed 3.8 cards a bank on Sonnet against 6.0 on Opus and 5.7 in production, so card repair has less to do. No bank had invented numbers or inflated ownership. $0.59 against $1.08 a call. |
| `qa-card-repair` | Opus low | Proven (2026-11-12) | Its instructions on 2026-11-20 match the 2026-11-12 records. A truth check, so it is never routed. |
| `qa-disclosures` | Sonnet low | Proven (2026-11-12; DeepSeek arms 2026-11-15) | Its instructions on 2026-11-20 match the 2026-11-12 records. On 2026-11-15 only Pro medium matched, and not stably. |
| `qa-practice-order` | DeepSeek Flash, reasoning low | Proven (2026-11-15) | Prompt code unchanged since. |
| `qa-gap-answers` | **Opus low** (2026-11-20; was Opus medium) | Partial | 3 real prompts × 2 runs, two blind judges. Opus low 7.50 (reruns 7.83 and 7.17), Opus medium 7.50 (7.33 and 7.67), Opus high 7.92, production 8.0. None of the three called real experience a gap. Sonnet high 7.25 with one false gap, Sonnet low and medium 3–4 false gaps, Haiku 5.1–6.3, Flash 3.0–6.4, Pro 2.5–6.8 with false gaps. $0.055 against $0.065 a call. The saving is small and n is 6. |
| `qa-approach-reminders` | **DeepSeek Flash, reasoning medium** (routed 2026-11-20; was Opus medium) | Partial | 3 real prompts × 2 runs, two blind judges. Flash medium 7.67 (reruns 7.5 and 8.0), Pro off 6.83 (reruns swing 2.2), Haiku medium 6.50, Opus medium 6.33 (reruns 6.8 and 5.8), production 6.00, Opus low 5.33. Flash medium was 6/6 valid. $0.0023 against $0.051 a call. Validity was checked with a copy of the app's validator. |
| `qa-technical-topics` | **DeepSeek Flash, reasoning low** (routed 2026-11-20; was Sonnet low) | Partial | 2 real postings × 2 runs, two blind judges, all arms valid. Opus low and Flash high 7.5, Flash medium 7.0, Pro low and off 6.9, Flash low 6.75, Haiku medium 6.5, Sonnet low 5.75 (reruns identical), production 5.5. Sonnet missed database and architecture topics. Flash off marked a non-technical question technical. Floor taken as 1.0. $0.0006 against $0.019 a call. Flash high ($0.0015) is the fallback if quality slips. |

### Typed job and career files (not live)

| Stage | Current | Status | Evidence |
|---|---|---|---|
| `typed-job-intake` | **DeepSeek Flash, reasoning low** (routed 2026-11-20; was Haiku medium) | Partial | 16 inputs (3 real, 13 written: links, company and role forms, same-name companies, unclear text) × 2 runs, scored by exact match. Flash low 32/32 and Haiku medium 32/32 (noise floor 0), Flash off 31/32, Haiku low 31/32, Sonnet low 28/32, Pro off 16/32 (left out empty fields). $0.00011 against $0.00041 a call. Some Flash replies are fenced; `firstJsonObject` parses them. |
| `typed-job-posting` | **Haiku medium** (2026-11-20; was Sonnet low) | Partial | 3 real pages and 3 planted ones (a closed notice, a job list) × 2 runs, two blind judges. Every arm classified the posting and closed state correctly; they differ on completeness. Haiku medium 9.19, Haiku high 9.15, Flash low 8.88, Flash off 8.77, Haiku low 8.65, Pro off 8.44, Sonnet medium 6.71, Sonnet low 6.54, production 7.08. Sonnet cut benefits and closing sections, as production did. Haiku medium costs $0.0039 against $0.044. Flash off ($0.0016) scored 0.4 lower, outside the 0.2–0.4 floor. |
| `typed-job-research` | **Sonnet high**, Parallel Search (2026-11-20; was Opus high) | Partial | 10 distinct targets (5 real, 5 built with the app's prompt: a same-name company, a small company, roles with and without an open posting), two blind judges, posting URLs checked with curl. Opus high 8.02 (n=24; same-case reruns 7.50 and 7.60), Sonnet high 7.87 (n=19), Opus medium 7.75, Haiku high 7.42 (thinner; 1 of 20 rejected by the app), Sonnet medium 6.50, production 8.50 (5 cases). Every setting said "none" correctly where no posting was open. Dead posting URLs: Opus high 2 of 18, Sonnet high 1 of 13, Haiku high 0 of 14. Sonnet high is −0.15 overall, within noise, at $0.19 against $0.41. Without the one case where several answers cited an unverifiable posting, the gap is about 0.5, so it stays Partial. Web tools, so Claude only. |
| `typed-job-listing` | **DeepSeek Flash, reasoning off** (routed 2026-11-20; was Opus medium) | Partial | Never run in production. 5 prompts built with the app's `listingPrompt` from real research × 2 runs, two blind judges. Opus low 7.65, Flash off 7.60, Flash high 7.25, Opus medium 7.20 (reruns 7.40 and 7.00), Sonnet low 7.15, Flash low 6.90, Sonnet medium 6.65, Pro 6.4–6.5, Haiku high 4.80. Haiku high invented requisition ids or URLs in 4 of 10, Sonnet medium in 1, the rest in none. $0.0007 against $0.072 a call. Re-check on real production prompts. |
| `career-file-to-text` | **Haiku high** (2026-11-20; was Sonnet low) | Partial | 3 rendered résumé images (one column, two columns, rotated and blurred) × 2 runs, scored by word diff against the source. Haiku high, Sonnet low and Sonnet medium were exact 6/6 (noise floor 0). Haiku medium was exact 5/6 (one dropped word, two added). $0.001 against $0.015 a call. Synthetic images only, and `[unreadable]` was not exercised. Re-check on a real photo or scan. Images, so Claude only. |

### Practice call

| Call | Current | Live? | Status | Evidence |
|---|---|---|---|---|
| `practice-call-plan` | **DeepSeek Flash, reasoning high** (routed 2026-11-20; was Opus high) | No (runs before the ring) | Partial | 7 real plan prompts, two blind judges (correlation 0.87). Opus high 8.50 (reruns differ 0.5–1.5 per case), Opus medium 8.46, production 8.35, Flash high 8.12, Sonnet high 7.92, Flash low 7.50, Sonnet medium 7.31, Pro low 6.97, Opus low 6.89, Pro high 6.42. Paired per case against Opus high: Flash high −0.38, inside the 0.5–0.8 floor. First-try valid: Flash high 7/10, Opus high 6/7; the failures were mostly `interviewKind` over its limit, and the app re-asks. About $0.013 against $0.24 per accepted plan. Outputs were 10–12k characters, well under the 32k cap. Opus xhigh was not run, and the usage limit cut 3 Opus cells. |
| `qa-practice-review` | Opus medium | No | Partial (2026-11-20) | 3 real reviews × 2 runs, two blind judges. Opus medium 7.00 (reruns 7.17 and 6.83), production 7.00, Opus low 5.83, Sonnet low 5.67, Pro high 5.25, Pro low 4.92, Flash high 4.67, Sonnet medium 4.42, Flash low 4.17. The cheaper arms often broke the schema. No cheaper arm is within noise, so it is kept. |
| `practice-call-draft-answer` ("Suggest a reply") | Sonnet low | Yes (the person waits on it mid-call) | Partial (2026-11-20) | 4 real prompts × 3 runs, cold CLI, two blind judges. Sonnet low 8.00 and 7.62 (p95 3.9–4.1 s), Opus low 8.12 (p95 6.1 s), Haiku medium 7.50 (p95 7.0 s), Flash low 7.46 (p95 2.9 s), Flash off 7.38 (p95 3.5 s), Haiku low 5.38 (broke character in 3 of 12). Flash is about 1 s faster at p95 but weaker on the work-history case (lows of 4.5–5.0 against Sonnet's 6.5). The reply lands in the chat box at once, so 1 s is small and the quality wins. |
| Opener (acknowledgement) | Sonnet low | Yes | Proven (2026-11-19, `callService.js`) | Live probe, 25 real turns: Haiku low leaked content in about 5 of 25 reactions, Sonnet low in 0 of 25, at about +0.1 s to the first word. Whole reaction 794 ms at p95. |
| Main reply | Opus low (Sonnet low selectable) | Yes | Proven (2026-11-19, Haiku re-check 2026-11-20) | 2026-11-19, current prompt: Sonnet low starts about 2.5 s sooner but lost blind (22 to 43 turn votes) and numbered planned questions in its own order, which breaks question tracking. 2026-11-20, one saved call of 26 turns, 3 runs per arm: Haiku low and medium scored about 1.2–1.6 below Opus low (noise 0.3–0.6) and tracked 0–4 of 6 planned questions (Opus low 6 of 6). Haiku is faster by about 0.74 s at p95 (2.23 s against 2.97 s), but it breaks the call's rules, so it is not eligible. |
| Interruption classifier | **Haiku low** (2026-11-20; was Opus low) | Yes | Proven (2026-11-20) | Re-test trigger: production instructions differ from the old benchmark's. 36 overlaps (24 benchmark cases, 12 harder) × 2 passes, production instructions and message format, warm sessions. Every setting was 100% right with one-word replies. p50/p95: Haiku low 581/770 ms, Haiku medium 590/790 ms, Sonnet low 719/870 ms, Opus low 1924/2576 ms, Opus medium 1909/2634 ms. Opus reaches the 2.5 s classifier timeout, which counts as an acknowledgement. |

## Open gaps

1. **`typed-job-research`:** Sonnet high is within noise overall, but about 0.5 behind Opus high without its hardest case. Re-check when more real typed targets are recorded. Also watch for Claude safeguard refusals on Sonnet (Prepare research hit the `bio` category on a protein-design posting).
2. **`career-file-to-text`:** check Haiku high on a real phone photo and a real scan, and on a part that should be marked `[unreadable]`.
3. **`typed-job-listing`:** re-check on real production prompts once some exist.
4. **Thin bases.** The Partial rows rest on 2–7 real prompts. Re-check when the replay samples hold more, or when a production signal appears (retries or rejections on a routed stage).
5. **DeepSeek routed stages are not recorded in `ai-replay-samples/`.** Only Claude attempts are, so a later re-test of a routed stage needs its prompts captured another way, or `INFINITE_CANVAS_OFFLOAD_STAGES=off` for a session.

## Log

### 2026-11-20 — audit of every AI call against the policy

The six calls proven in infinite-canvas were compared prompt by prompt against their proof records. `qa-research`, `qa-brief`, `qa-card-repair`, `qa-disclosures` and `qa-practice-order` were unchanged. `qa-write` had changed its evidence, so it got a regression check. Eleven calls had been chosen by analogy, and the live classifier's production instructions differed from the benchmark's. Each was replayed from real prompts (or prompts built with the app's own builders where none existed), at Claude and, where allowed, DeepSeek arms. The reference setting ran twice for the noise floor, two blind judges scored each call (or exact scoring where possible), and the policy was applied.

- **Routed to DeepSeek:** `qa-brief` (Pro low), `qa-approach-reminders` (Flash medium), `qa-technical-topics` (Flash low), `typed-job-intake` (Flash low), `typed-job-listing` (Flash off), `practice-call-plan` (Flash high).
- **Changed on Claude:** `qa-gap-answers` → Opus low, `typed-job-posting` → Haiku medium, `career-file-to-text` → Haiku high, classifier → Haiku low.
- **Kept:** `qa-practice-review`, `practice-call-draft-answer`, main reply, opener.
- The weekly Claude usage limit stopped the first `qa-write` confirmation and three `practice-call-plan` Opus cells. After an account change, the `qa-write` confirmation was finished and `typed-job-research` was re-run on 10 targets with Haiku added. **Changed:** `qa-write` → Sonnet medium, `typed-job-research` → Sonnet high.
- Spend: about $64 at list price, most of it on `qa-write`, `typed-job-research` and `practice-call-plan`. DeepSeek was a few dollars.
- Runs: `~/Library/Application Support/Interview Helper/ai-test-runs/2026-11-20-policy-audit/`.
