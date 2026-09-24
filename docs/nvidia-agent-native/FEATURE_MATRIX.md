# Feature matrix

## Current implementation delta (2026-09-25)

| Feature | Current state | Acceptance note |
|---|---|---|
| Realtime provider | MiniCPM-o-4.5-Realtime is the formal **Candidate**; Step-Audio-2-mini is **Retired / no longer target realtime provider** | Official public protocol does not document native Tool Calling / Tool Result / Resume; initial opening and real E2E: **NOT TESTED** |
| Realtime Slow Context Agent | Current Story Retriever → mandatory `interview.context_hint` Agent → Tool Result; Agent failure yields no-context | 2026-09-25 real Agent smoke: **FAIL** (`AGENT_RUNTIME_TIMEOUT`); full Realtime runtime E2E: **NOT TESTED** |
| Current Story Q+A retrieval | Owner/story/subject scoped; user Answer is the only fact source | Retriever service health currently returns HTTP 200; preserve SQLite as source of truth |
| `realtime-context` OpenClaw agent | Dedicated workspace, `interview-observer` Skill and deny-all tools policy provisioned | Configuration checks passed; runtime smoke is **FAIL**, not unverified; do not claim slow-path acceptance |
| SSE Tech Observer | Reads the session-scoped Observation Bus stream and maps existing Realtime slow-path stages | Shows stage outcomes and available safe metrics; raw call/session/story IDs and user content are not displayed |
| Competition WebSocket panel | Allowlisted status emission only when `COMPETITION_TECH_PANEL=1` | Independent of `REALTIME_CONTEXT_AGENT_ENABLED` and `NEMO_RETRIEVER_ENABLED`; it does not enable either runtime |

Historical deterministic verification on 2026-09-24: fast **224/224**, integration **62/62**, Agent **39/39**, NAT unit **8/8**. Current 2026-09-25 convergence verification is recorded in [the integration report](../07-reports/testing/REALTIME_INTEGRATION_CONVERGENCE_REPORT_v1.0.md); neither historical tests nor protocol docs substitute for real MiniCPM E2E.

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
| realtime | Step-Audio compatibility adapter; MiniCPM Candidate is blocked on native Tool Calling / Resume confirmation | REVISIT |
| health | server health endpoint | KEEP |
| Agent runtime | not in legacy product | ADD in Phase 1 |
| Agent Tool API | not in legacy product | ADD read-only in Phase 1 |
| NeMo Retriever | Phase 3A/B integration Gate passed; current local health check HTTP 200 | KEEP Phase 1 boundary; current Story use remains backend-only |
