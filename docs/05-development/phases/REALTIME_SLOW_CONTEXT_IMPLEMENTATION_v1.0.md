# Realtime Slow Context implementation v1.0

> Date: 2026-09-24
> Scope: one read-only context-hint Agent step after Current Story Classic Retrieval.
> Status: implementation and deterministic validation are in place. Realtime Agent smoke is **FAIL**; full Step-Audio voice E2E is **NOT TESTED**.

This document records the behavior implemented on top of the existing Step-Audio Tool Call → HOLD → Backend → Tool Result → Resume path. The broader proposal remains in [Realtime Fast / Slow architecture v1.6](../../08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.6.md); this document is authoritative for the narrower implementation shipped here.

## 1. Request path

```text
Step-Audio 2 Mini
  └─ get_interview_context(query)
       └─ Backend validates story_continue + Current Story
            └─ RealtimeSlowCoordinator
                 ├─ starts Response A idle wait in parallel
                 ├─ Current Story Retriever (owner + story + subject)
                 └─ RealtimeSlowContextPipeline
                      ├─ no evidence → empty hint; skip Agent
                      ├─ Agent unavailable/fails → direct Retriever evidence
                      └─ one interview.context_hint run
                           └─ selected evidence IDs + short hints
       └─ Backend reconstructs facts from exact retrieved Answers
            └─ Tool Result + explicit Resume
                 └─ Step-Audio continues; first audio is traced
```

`RealtimeSlowCoordinator` remains the only owner of cancellation, deadline, supersede, latest-only and stale-result protection. The existing 5,500 ms slow-path deadline is retained. Response A idle waiting runs concurrently within that deadline rather than adding another second after retrieval.

## 2. Scope and evidence rules

- The Tool is exposed only for an existing `story_continue` Story. The backend checks the same conditions again and safely resumes unexpected or out-of-scope calls.
- Retriever requests require the current owner, current story and `sourceType=subject`. Missing story scope fails closed. Owner-wide, cross-Story, contributor, era and Agentic Retrieval are excluded.
- The index stores Q+A units. The assistant question is context only; only the user answer can become a fact. Source provenance points to the user answer message.
- The Agent receives at most five evidence units, each bounded to 450 characters, with a 2,000-character evidence budget; query is 2–500 characters, Story summary at most 1,000 characters, and at most four recent final messages with 1,000 characters total.
- The Agent can select at most three input evidence IDs. Backend rejects any ID that was not in the exact Agent input and rebuilds each fact from that answer. Model-generated text never replaces or rewrites evidence.
- No evidence skips the Agent and returns an empty hint. Disabled/unavailable/failed Agent uses direct scoped Retriever evidence with `fallbackUsed=true` and `fallbackType=direct_retrieval`. A coordinator timeout or cancellation does not wait for fallback; it follows the existing safe Resume path.

## 3. Agent execution policy

The task is `interview.context_hint`, Skill `interview-observer`, Model Profile `realtime-context`, and dedicated OpenClaw agent `realtime-context`.

- One attempt and one model call at most; task timeout 4,800 ms; thinking off.
- Format repair, validation repair, retrieval scripts and OpenClaw tools are disabled.
- Input and output use strict Zod schemas. Output permits only selected IDs, up to two short conflicts and up to two short interview hints; all output text is capped at 120 characters in total.
- Model selection is `AGENT_MODEL_REALTIME_CONTEXT` → `AGENT_MODEL_REASONING_FAST` → `AGENT_MODEL_DEFAULT`.
- The prompt contains only the query, bounded current Story context, recent final turns and bounded evidence. It does not contain full Agent Memory, a Transcript dump or another Story.

Install the Skill and provision the dedicated workspace/policy with:

```bash
./deploy/mac/install-skill.sh
```

The installer validates the OpenClaw config change before setting `agents.list[].tools.deny` to `[*]`, then installs the Skill in the dedicated agent workspace. OpenClaw's local CLI reported a Gateway restart notice for the policy write; the application Task Runner uses `openclaw agent --local`. The policy is stored and validated, but the live Agent smoke below remains the runtime acceptance gate.

`REALTIME_CONTEXT_AGENT_ENABLED` controls only the optional context-hint Agent: explicit `1`/`true` enables it, explicit `0` disables it, and an unset value enables it only when the Agent Task runtime is available. `.env.example` sets it to `0`. `NEMO_RETRIEVER_ENABLED=true` independently controls Retriever/Pipeline availability. `COMPETITION_TECH_PANEL=1` only enables allowlisted status messages on the competition WebSocket panel; it does not enable the Agent or Retriever.

## 4. Diagnostics and UI

Realtime traces contain only allowlisted stage names, counts, latencies, model/Skill labels, token counts when reported, fallback state and safe error codes. They do not contain query text, Transcript, Story summary, recent context, evidence text or source message IDs. The SSE Tech Observer is opened independently with `?demo=tech`; it renders fixed event labels and allowlisted metrics, shows missing values as `暂无数据`, and does not display call/session/story identifiers. The competition WebSocket panel remains gated only by `COMPETITION_TECH_PANEL=1`. DGX Spark/GPU utilization shows `暂无数据` unless a real telemetry source exists.

The SSE adapter reuses the existing trace stream and its tool-cycle span; `realtime.tool_cycle_recall_finished` is suppressed in the timeline because `realtime.slow_recall_finished` already reports the same terminal result.

| Existing trace event | Tech Observer state | Safe values shown when present |
|---|---|---|
| `realtime.tool_call_requested`, `realtime.tool_cycle_started` | Tool Call → HOLD | Tool label, lifecycle state |
| `realtime.slow_path.retrieval.started/finished` | Retriever running → complete | Stage duration, candidate count, evidence count |
| `realtime.slow_path.slow_agent.started/finished` | Context Hint Agent running → complete | Agent duration, model/Skill labels, token counts, selected evidence count |
| `realtime.slow_path.slow_agent.skipped` | Agent skipped | Safe skip reason: no evidence, explicitly disabled, or unavailable runtime |
| `realtime.slow_path.slow_agent.failed` | Agent failed or timed out | Safe error code; fallback type/state when emitted |
| `realtime.slow_path.context_hint.ready` | Context Hint ready | Selected evidence count and fallback state/type; this remains success after a handled Agent failure |
| `realtime.slow_recall_finished` | Slow Path result | Final status and measured latency; timeout/failed/aborted/stale are distinct from completed |
| `realtime.tool_result_sent`, `realtime.tool_cycle_message_write` (`resume`), `realtime.tool_cycle_response_started`, `realtime.tool_cycle_response_first_audio` | Tool Result → Resume → AI resumed → First audio | Tool-result timing, Resume-to-response timing, Tool-to-first-audio and response-to-first-audio timings |

The Agent failure event and the successful `context_hint.ready` / completed slow-path result are separate timeline entries when direct-retrieval fallback succeeds. A missing trace field is never inferred or filled with a fabricated value.

Summarize retained traces without session or call IDs:

```bash
bash scripts/codex-node.sh npm run trace:tool-cycles
```

The summary reports outcome counts, fallback/no-evidence rates, retrieval/Agent/slow-path/tool-result/Resume/first-audio latency percentiles, selected-evidence averages and token statistics when present. No P50/P95 or token values are claimed until traces provide samples.

## 5. Known data and runtime limits

- `TranscriptMessage` has no partial/final marker. Indexing runs only after persisted session closeout, but the schema cannot distinguish an accidentally persisted partial message; adding that distinction needs a separate data migration decision.
- Retriever failure does not roll back the authoritative SQLite Transcript. Retriever remains a rebuildable derived index.
- The current local Agent smoke uses synthetic input and a temporary migrated database. It does not create or index a user Session.
- A passing local Tool/HOLD/Resume or Retriever gate does not prove human voice acceptance. Real Step-Audio latency, interruption behavior and audible playback remain separate checks.

## 6. Validation status

| Check | Status | Evidence |
|---|---|---|
| TypeScript typecheck | PASS | `bash scripts/codex-node.sh npm run typecheck` |
| Full deterministic local verification | PASS | `bash scripts/codex-verify.sh`: typecheck; fast 224/224; integration 62/62; Agent 39/39; NAT unit 8/8. The Agent contract cases are included in the fast suite. |
| OpenClaw agent and no-tools policy config | PASS, config only | `configure-realtime-context-agent.sh` dry-run and read-back returned `[*]`; Skill reports Ready in its dedicated workspace |
| Real context-hint Agent smoke | FAIL | First run hit `AGENT_RUNTIME_TIMEOUT`; after task-level thinking-off and timeout adjustment, a run exited with `AGENT_RUNTIME_EXEC_FAILED` |
| Full Step-Audio voice E2E with Agent enabled | NOT TESTED | Agent runtime smoke is not passing |
| P50/P95 latency or token benchmark | NOT TESTED | No successful slow-path trace samples |
| DGX Spark/GPU telemetry | NOT TESTED | Local sandbox status reported no GPU |

On 2026-09-23, `nemoclaw my-assistant status` reported HTTP 503 for its default NVIDIA managed-inference probe. On 2026-09-24, `bash scripts/check-ai-env.sh` returned HTTP 200 for NeMo Retriever, VectorDB, and the OpenClaw forward; that health check did not invoke a model and does not change the Agent smoke result. The exact cause of the failed Agent invocation remains unresolved. Do not report the Realtime slow path as accepted: Agent smoke is **FAIL** and full Step-Audio voice E2E is **NOT TESTED**.
