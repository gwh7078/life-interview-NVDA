# Feature matrix

## Current implementation delta (2026-09-24)

| Feature | Current state | Acceptance note |
|---|---|---|
| Realtime Slow Context Agent | Existing Current Story Retriever pipeline can run at most one `interview.context_hint` Agent | Agent smoke: **FAIL** (`AGENT_RUNTIME_TIMEOUT`, then `AGENT_RUNTIME_EXEC_FAILED`); full Step-Audio voice E2E: **NOT TESTED** |
| Current Story Q+A retrieval | Owner/story/subject scoped; user Answer is the only fact source | Retriever service health currently returns HTTP 200; preserve SQLite as source of truth |
| `realtime-context` OpenClaw agent | Dedicated workspace, `interview-observer` Skill and deny-all tools policy provisioned | Configuration checks passed; runtime smoke is **FAIL**, not unverified; do not claim slow-path acceptance |
| SSE Tech Observer | Reads the session-scoped Observation Bus stream and maps existing Realtime slow-path stages | Shows stage outcomes and available safe metrics; raw call/session/story IDs and user content are not displayed |
| Competition WebSocket panel | Allowlisted status emission only when `COMPETITION_TECH_PANEL=1` | Independent of `REALTIME_CONTEXT_AGENT_ENABLED` and `NEMO_RETRIEVER_ENABLED`; it does not enable either runtime |

Deterministic verification on 2026-09-24: fast **224/224**, integration **62/62**, Agent **39/39**, NAT unit **8/8**. This does not change the Realtime Agent smoke **FAIL** or full voice E2E **NOT TESTED** status.

The Phase 0/1 baseline below is retained as a historical disposition matrix.

| Feature | Baseline | Phase 0/1 disposition |
|---|---|---|
| onboarding | stable Web flow | KEEP |
| life stages | create/edit/delete, story guard | KEEP |
| story create | interview driven | KEEP |
| story continue | Story context + Agent Memory | KEEP |
| story detail | title/summary/gaps/stage/docs/share | KEEP |
| completion/gaps | max 3 important questions | KEEP |
| contributor share | 7-day hashed token | KEEP |
| contributor interview | relationship-scoped continuation | KEEP |
| contributor summary | reused across same link | KEEP |
| closeout | schema/evidence/transaction/idempotency | KEEP now, REPLACE orchestration later |
| story generation | versioned memoir document | KEEP |
| book preview/export | existing product path | KEEP |
| auth | owner-scoped demo phone baseline | KEEP |
| realtime | Step-Audio default with optional server-side Qwen adapter | KEEP |
| health | server health endpoint | KEEP |
| Agent runtime | not in legacy product | ADD in Phase 1 |
| Agent Tool API | not in legacy product | ADD read-only in Phase 1 |
| NeMo Retriever | Phase 3A/B integration Gate passed; current local health check HTTP 200 | KEEP Phase 1 boundary; current Story use remains backend-only |
