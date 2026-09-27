# Phase 1 本机真实联调与验收结果

Date: 2026-09-20
Worktree: `/Users/gwh/.codex/worktrees/7292/英伟达黑客松（人生采访局）`
Branch: `codex/phase1-local-smoke`
Baseline HEAD: `875b47c181b2be4813e8fe3bd06dce2850090766`

## Environment

- NemoClaw sandbox: `my-assistant`
- NemoClaw: `0.0.124`
- OpenClaw runtime: `2026.7.1`
- OpenClaw model used by the smoke: `volcengine/deepseek-v4-flash`
- Tool API: `http://192.168.31.147:4175`
- Worktree database: `data/codex-worktree.db`
- Tool audit log: `runtime/diagnostics/agent-tools.jsonl`

The sandbox cannot see the worktree database or the host user's OpenClaw state. The smoke uses the current worktree only.

## Automated checks

- `bash scripts/codex-node.sh npm run typecheck`: passed
- `bash scripts/codex-node.sh npm run test:agent`: passed, 7/7
- `bash scripts/codex-node.sh npm run test:fast`: passed, 159/159

## Network and policy

The Tool API health check returned HTTP 200. The applied NemoClaw custom policy allows only:

- `ark.cn-beijing.volces.com:443` from `/usr/local/bin/node` for `POST /api/plan/v3/chat/completions`;
- the existing read-only Tool API route on `192.168.31.147:4175`.

The Ark route was observed as allowed by OpenShell and returned HTTP 200 during the successful smoke.

## Real Agent Smoke

Command:

```bash
bash scripts/codex-node.sh npm run agent:smoke
```

Successful run:

```json
{
  "runId": "664719e1-f416-43ab-a049-0e9b0019e320",
  "status": "succeeded",
  "output": {
    "title": "第一次独立负责跨团队项目",
    "gap_count": 0
  }
}
```

The run used the isolated session key `agent:main:phase1-smoke:<run_id>` and the embedded `openclaw agent --local` path so the short-lived Tool API environment stayed in the same sandbox process chain as the Agent.

## Persistence and Tool evidence

The final SQLite row for the successful run is:

- `runtime`: `nemoclaw-openclaw`
- `model`: `volcengine/deepseek-v4-flash`
- `status`: `succeeded`
- `latency_ms`: `24562`
- `error_code`: `null`
- `result_json`: `{"title":"第一次独立负责跨团队项目","gap_count":0}`

The matching audit record is present in `runtime/diagnostics/agent-tools.jsonl`:

```json
{"runId":"664719e1-f416-43ab-a049-0e9b0019e320","tool":"get_story_context","resourceType":"story","resourceId":"00000000-0000-4000-8000-000000000204","outcome":"allowed","latencyMs":180}
```

No Tool token or provider API key appears in the result JSON or this audit record.

## Problems found and resolved

1. The worktree smoke override still pointed at the NVIDIA model. The ignored `.env` now uses `volcengine/deepseek-v4-flash`.
2. The Ark endpoint was initially denied by NemoClaw. A minimal custom policy was applied for the exact host, process, method, and path.
3. Gateway-backed `openclaw agent` did not receive the per-run `LIFE_INTERVIEW_*` variables injected into its CLI client. This caused repeated model attempts and `AGENT_RESULT_MISSING` or timeout failures. The runtime now uses embedded `--local` execution and an isolated smoke session key.
4. The optional local Retriever MCP server still reports `fetch failed`. Phase 1 does not depend on Retriever or RAG, so it is recorded as a non-blocking environment issue.
5. The OpenClaw 2026.7.1 settings page has a frontend dynamic-module loading issue in the Web UI. It is separate from the Phase 1 Agent runtime gate.

## Code changes

- `agent/runtime/nemoclaw-openclaw-gateway.ts`: use embedded local execution and a unique Phase 1 smoke session key.
- Ignored worktree `.env`: select `volcengine/deepseek-v4-flash` for the smoke runtime.

## Remaining risks

- OpenClaw 2026.7.1 remains the NemoClaw-maintained runtime; the UI issue is still present intermittently.
- Retriever/MCP is unavailable locally, but no Phase 1 path calls it.
- The live-provider result proves this configured local route and this Story fixture; it does not prove NVIDIA upstream availability.

## Phase 1 REAL RUNTIME GATE: PASS

The real chain completed on the current Mac worktree:

```text
Node AgentGateway
→ NemoClaw
→ OpenShell sandbox
→ OpenClaw story-context-inspector
→ get_story_context Tool API
→ owner-scoped SQLite Repository
→ structured result
→ agent_runs.status = succeeded
```
