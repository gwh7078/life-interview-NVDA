# Controlled Fixed-Audio Next-Question Benchmark

This is a standalone quality benchmark. It is unrelated to the existing fast/slow-system benchmarks and does not add benchmark switches to normal interview behavior. Cases in `cases.ts` are frozen.

Each A/B/C sample uses a fresh Step-Audio-2-mini Realtime session, the same previous question, and the exact same canonical WAV bytes for that case. The Runner waits for StepFun's real `user.transcript.final` ASR event before running the Coach path and requesting one Mini response. It never fabricates a transcript event or sends the case answer as a user `input_text` item.

The text transport result is retained as failure evidence:

> Step-Audio-2-mini text user-turn transport was tested and rejected because the provider acknowledged the message item but the model did not demonstrably consume the input text.

`text-transport-canary.ts` remains available to reproduce that transport check; it is not an input path for this benchmark.

## Story fixture and Retriever probe

Create a private copy of the existing interview-quality benchmark database. This does not replace the app's Worktree database or the checked-in compressed source. The fixture combines its six completed source sessions under one new UUID owner, Life Stage, and Story. The Story context is shared with the Runner and its historical user answers remain source-derived.

```bash
python3 benchmark/next-question/prepare-fixture.py
bash scripts/codex-node.sh npm run benchmark:next-question:retriever-probe
```

The probe uses the production `RetrieverIndexService` and `RetrieverClient` through the configured `NEMO_RETRIEVER_BASE_URL`. It indexes every completed session and checks both required recalls:

- `1983年正式高考日期` returns evidence containing `7月15日`.
- `过沭河时发生了什么` returns evidence containing `水深得没过腰`, `相互搀扶`, and `行李举过头顶`.

Fixture IDs and the isolated SQLite copy live under ignored `data/next-question-benchmark/`. C runs use that manifest scope and the configured production Transcript collection; unique owner/story IDs keep the benchmark records scoped. The probe writes private repeat instructions and evidence to `benchmark/next-question/results/`.

## Coach Gate probe

Before any Realtime audio smoke, run the real production `BailianRealtimeCoach.evaluate()` three times for C06 and C07:

```bash
bash scripts/codex-node.sh npm run benchmark:next-question:gate-probe
```

The probe uses the fixture-backed `StoryInterviewContextBuilder`, the shared Gate input builder, and sanitized effective Coach settings. It records each parsed Gate result or the exact sanitized error code/message. The target is 6/6 schema-valid results; a valid `action: none` remains a real Gate decision and is not changed to force retrieval.

## Canonical audio

Generate the ten canonical files directly from the frozen `userAnswer` strings in `cases.ts`:

```bash
bash scripts/codex-node.sh npm run benchmark:next-question:audio
```

The generator uses Apple macOS Speech Synthesis (`say` / `NSSpeechSynthesizer`), Tingting (`zh_CN`), 180 words/minute, the system synthesis default volume, and `afconvert` to produce PCM16 mono 16 kHz WAV. It refuses to overwrite an existing fixture, resumes only against the same TTS manifest, and writes `audio/manifest.json` with source text, settings, duration, format, and SHA-256. All A/B/C runs use the exact same case WAV.

Canonical WAV format:

- PCM signed 16-bit little-endian
- mono
- 16 kHz

The current StepFun production adapter consumes 24 kHz PCM16 mono frames (`960` bytes / 20 ms). The Runner extracts the WAV data, deterministically resamples 16 kHz to the adapter's existing 24 kHz input, then sends frames using the production `appendAudioMessages()` and `commitInputTurn()` adapter methods. Production audio parameters are unchanged. The Runner stops treating input as valid only after the adapter emits a non-empty `user.transcript.final` from StepFun ASR.

The WAV bytes themselves remain the canonical identity (`audio_sha256`); the converted adapter PCM hash is recorded separately as `adapter_pcm_sha256`.

## ASR input equivalence

Each actual ASR transcript is normalized against its exact frozen `userAnswer`: Unicode punctuation, spaces, and standalone `嗯`/`呃`/`额` fillers are ignored; punctuation between adjacent digits remains. Dates, numbers, names, negation, and event words remain intact. A transcript that differs from the expected normalized answer is marked `INPUT_TRANSCRIPT_MISMATCH`; only that Sample is excluded from primary scoring. Completed candidates, including mismatches, remain in the blinded Judge input and their mismatch flag is kept in the private manifest.

## C06/C07 smoke

Optional targeted audio smoke command:

```bash
bash scripts/codex-node.sh npm run benchmark:next-question -- \
  --cases C06,C07 --variants A,B,C --runs 1
```

Each sample starts its own StepFun session, includes the fixed previous question in the response instructions, sends the canonical audio through the adapter's input-audio append and commit path, waits for ASR final, runs the shared Coach/Retriever pipeline when selected by the real Gate, requests one response, then stops. No `input_text` item is sent. The stdout report includes each case's audio hash, expected answer, A/B/C ASR, Gate, evidence, packet, next question, and `INPUT_EQUIVALENCE`.

Cases are never changed to force a Gate choice. `action: none`, no Memory request, no retrieved evidence, Coach fail-open, and Era not triggered are valid system outcomes; none causes a sample retry. The Runner records these results and continues.

## Production parity

| Production path | Runner path | Check |
|---|---|---|
| `StoryInterviewContextBuilder` in `server.ts` | Same builder against the isolated fixture DB | Shared |
| `buildRealtimeCoachGateInput()` | Same builder with the fixed prior question and real ASR transcript | Shared |
| `BailianRealtimeCoach.evaluate()` | Same Coach, same effective settings, 2 s Gate deadline | Shared |
| `RealtimeCoachPipeline.retrieveAndResolve()` | Same pipeline and Story scope, within the 6 s total deadline | Shared |
| `renderMiniCoachPacket()` and `buildStepAudio2MiniInstructions()` | Same renderer and prompt builder | Shared |
| StepFun input/response adapter | Same `appendAudioMessages()`, `commitInputTurn()`, and `requestAssistantTurnMessages()` | Shared |
| Context Hint injection | Not used by Mini `supervisor_auto` Story Continue | Not part of this path |
| `respondOnce`, stale-turn cancellation, superseded-turn guards | One serialized turn on a fresh session | Concurrency guards are not exercised |

The fixed previous question is included in response instructions because the rejected text-item transport cannot seed it as a conversation item. This keeps it identical across A/B/C; production normally has the previous assistant transcript in the Realtime conversation. Audio does arrive through the provider and Coach receives its real ASR final. Gate and pipeline failures fail open to one Mini response.

## Formal benchmark

Run the frozen 10 × 3 × 3 design:

```bash
bash scripts/codex-node.sh npm run benchmark:next-question -- \
  --cases C01,C02,C03,C04,C05,C06,C07,C08,C09,C10 --variants A,B,C --runs 3
```

Each logical Sample runs in a separate worker process and a fresh Realtime session. Network/socket/HTTP 5xx and worker-process failures may retry up to two times; question quality, Gate choices, Coach timeouts, and retrieval outcomes do not retry. `technical.jsonl` records attempts and retry reasons. `judge.jsonl` uses randomized candidate IDs and includes only the case, previous question, actual ASR answer, shared Story/Memory context, source-derived historical facts, and candidate question.

Judge every completed candidate independently with Step 5 Preview through the Step Plan endpoint:

```bash
bash scripts/codex-node.sh npm run benchmark:next-question:judge -- --result-dir benchmark/next-question/results/<RUN_ID>
bash scripts/codex-node.sh npm run benchmark:next-question:summary -- --result-dir benchmark/next-question/results/<RUN_ID>
```

The Judge uses the Step Plan Chat Completions endpoint `https://api.stepfun.com/step_plan/v1/chat/completions`, `STEPFUN_API_KEY`, temperature 0, and JSON mode. It scores each candidate independently and receives no variant, Coach/Memory/Era configuration, or technical trace. `manifest.json` privately maps candidate IDs back to variants. Truncated output, request failures, timeouts, and HTTP 5xx may retry automatically; schema-invalid output remains failed by default. For an explicitly requested recovery pass, `--retry-schema-invalid-once` retries only unresolved schema-invalid candidates once, and `--retry-latest-failures-once --expect-retry-count N` retries exactly N unresolved failures once. These modes keep every attempt, do not rescore already-scored candidates, and do not change the prompt or scoring rules. Never mix scores from different Judge models or endpoints: create a separate result directory when changing either. A summary with missing or invalid Judge results is marked incomplete and must not be used as a competition conclusion. The summary reports overall and case-group scores, all ten cases, ASR exclusions, Coach/Gate/Retrieval/Era behavior, and P50/P95 latency separately from quality scores. Result traces and judge inputs may contain interview facts and remain ignored/local; only the summary and non-sensitive run manifest should be considered for Git.
