# Phase 2B-C Real Agent E2E Report v1.0

> Status: **PASS**
>
> Observed at: 2026-09-22 00:51 UTC
>
> Verification source: commit `6a7ea65` (the six-path run was executed from the same source changes immediately before this commit).

## Scope

This report covers the real Agent Runtime gate:

```text
AgentTaskPort
 -> NemoClaw
 -> OpenClaw main Agent
 -> installed Skill
 -> configured model
 -> LIFE_INTERVIEW_RESULT
 -> schema / business validation
 -> retry or repair when required
 -> agent_runs tracing
```

The command uses isolated synthetic fixtures and an isolated temporary SQLite
database. It validates the Runtime Port and tracing contract. It does not claim
full browser, HTTP product workflow, or persistent Story/Document acceptance.

## Environment

| Field | Value |
|---|---|
| Repository | `gwh7078/life-interview-NVDA` |
| Branch | `codex/phase2b-closeout` |
| Source commit | `6a7ea65` |
| Command | `bash scripts/codex-node.sh npm run test:agent:real` |
| NemoClaw | `v0.0.124` |
| Sandbox | `my-assistant` |
| OpenClaw | `2026.7.1` |
| Agent | `main` (default) |
| Provider | `volcengine` |
| Model profiles | all `volcengine/deepseek-v4-flash` |
| Thinking | default / unset |
| Fixture database | isolated temporary SQLite database |

The NemoClaw control-plane `inference get` command displayed its configured
NVIDIA management provider. The formal Phase 2B-C task executor selected the
OpenClaw `main` Agent model shown above through `AGENT_MODEL_*`; no NVIDIA model
was selected for these six task runs.

## Gate Summary

| Metric | Result |
|---|---:|
| Passed | 6 |
| Total | 6 |
| Process exit code | 0 |
| Agent runs created | 6 |
| Agent runs succeeded | 6 |
| Dynamic Tool Calls | 0 for every case |
| Skill Script Calls | 0 for every case |
| Raw outputs stored in `agent_runs` | no; only when `DIAGNOSTICS_CAPTURE_CONTENT=1` |

## Case Results

| Case | Result | Latency ms | Attempts | Repairs | Format Repair | Script Calls |
|---|---|---:|---:|---:|---:|---:|
| `onboarding.closeout` | PASS | 16,828 | 1 | 0 | no | 0 |
| `interview.closeout/story_create` | PASS | 15,065 | 1 | 0 | no | 0 |
| `interview.closeout/story_continue` | PASS | 14,300 | 1 | 0 | no | 0 |
| `interview.closeout/contributor` | PASS | 16,876 | 1 | 0 | no | 0 |
| `story.completion` | PASS | 24,193 | 2 | 1 | yes | 0 |
| `story.generation` | PASS | 21,966 | 1 | 0 | no | 0 |

The `story.completion` case first returned `AGENT_RESULT_MISSING`; the second
attempt used Format Repair and passed. The timing diagnostics now contain both
the failed first attempt and the successful repair attempt.

## Required Behavioral Checks

### Story Continue

The fixture supplied an old approximate year around 2012 and a current user
correction to 2013 after Spring Festival. The accepted Proposal:

- kept 2013 as the updated year;
- recorded `memory_changes` for the correction;
- retained the uncertain residential detail instead of inventing a specific
  neighborhood;
- retained source message references.

### Contributor

The contributor case passed the strict contributor output contract and returned
only the contributor `summary` field. It did not receive the owner Story
Summary or Story Agent Memory as mutable output fields.

### Tracing

Each successful run recorded the required task, mode, Skill, Skill version,
provider, model, resource scope/version, context/schema versions, attempt and
repair counts, Tool/Script counts, format-repair flag, latency, hashes, and
status. Normal Phase 2B-C paths remained at `script_call_count = 0`.

## Timing Evidence

The new per-Attempt timing diagnostics recorded prompt build, command, OpenClaw,
host overhead, parse, total latency, and error code when an Attempt failed.
Observed OpenClaw execution was approximately 10.0–20.0 seconds per Attempt;
prompt construction and parsing were negligible by comparison.

## Limitations and Follow-up

- The current six-path script is a Runtime Port gate with synthetic fixtures;
  product HTTP/UI and final domain persistence need separate acceptance tests.
- Generation schema validation is complete, while a broader factuality Eval for
  unsupported names, dates, numbers, places, and relationships remains future
  work.
- NeMo Retriever was not required by this gate. The local Retriever/VectorDB
  health check was unavailable during this run and remains a Phase 3A
  infrastructure prerequisite.
- Runtime latency remains above the earlier ten-second target. Timing data is
  retained for later model and DGX Spark benchmarking; no further latency
  tuning is included in this Phase 2B-C closeout.

No API key, token, credential, raw Transcript, prompt, owner identifier, run
identifier, or raw model output is stored in this committed report.
