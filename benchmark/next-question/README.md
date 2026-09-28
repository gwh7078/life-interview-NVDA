# Controlled Next-Question Benchmark

This is an independent quality benchmark with its own local A/B/C capability matrix, fixed cases, and result artifacts. It is separate from the removed slow-system/runtime benchmark and does not add benchmark switches to normal interview behavior.

Each sample creates a fresh Step-Audio-2-mini Realtime connection, seeds the case's previous question as an assistant conversation item, and sends the fixed answer as a real `conversation.item.create` user message with `input_text`. It waits for StepFun to acknowledge that item before running the current Mini Coach path and requesting one response. The live StepFun acknowledgement observed here identifies the created item as a user message but reports its content type as `audio` without echoing text; the runner records that acknowledgement and sends no audio-buffer or ASR events.

The harness reuses the current Gate input builder, Gate/Resolve Coach, `RealtimeCoachPipeline`, Retriever/Era clients, Mini Coach packet renderer, prompt builder, and StepFun provider adapter. The current Mini `supervisor_auto` production path uses `RealtimeCoachPipeline`; the separate `RealtimeSlowCoordinator`/Context Hint path is not Mini's Story Continue route. Variant flags are local to this runner; no production benchmark profile or environment switch is used.

## Requirements

- `.env` contains the normal StepFun and Coach credentials; values are never written to results.
- `STEPFUN_REALTIME_MODEL=step-audio-2-mini` and `STEPAUDIO2_EXECUTION=stepfun-cloud`.
- C runs require `NEMO_RETRIEVER_ENABLED=true` and the prepared historical Story indexed under the owner/story IDs passed to the runner.
- Set `NEXT_QUESTION_BENCHMARK_OWNER_ID` and `NEXT_QUESTION_BENCHMARK_STORY_ID`, or pass `--owner-id` and `--story-id`. These IDs must scope the actual historical Story; the Runner does not seed or fabricate retrieval evidence.

## Smoke

```bash
bash scripts/codex-node.sh npm run benchmark:next-question -- \
  --cases C06,C07 --variants A,B,C --runs 1 \
  --owner-id "$NEXT_QUESTION_BENCHMARK_OWNER_ID" \
  --story-id "$NEXT_QUESTION_BENCHMARK_STORY_ID"
```

## Formal run

Only start the 90 samples after the C06/C07 smoke confirms the expected scoped historical evidence and one-question behavior.

```bash
bash scripts/codex-node.sh npm run benchmark:next-question -- \
  --cases C01,C02,C03,C04,C05,C06,C07,C08,C09,C10 \
  --variants A,B,C --runs 3 \
  --owner-id "$NEXT_QUESTION_BENCHMARK_OWNER_ID" \
  --story-id "$NEXT_QUESTION_BENCHMARK_STORY_ID"
```

Each run gets a new private directory under `results/` containing `technical.jsonl`, blind `judge.jsonl`, the candidate-to-trace `manifest.json`, and `run.json` with the repeat command and verification rules. Candidate IDs are random and Judge rows are shuffled after collection. The response rule is the first completed assistant transcript, with surrounding whitespace trimmed only. The result files are mode `0600` and ignored by Git because they can contain retrieved personal evidence.
