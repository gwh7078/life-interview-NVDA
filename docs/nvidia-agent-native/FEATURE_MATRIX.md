# Feature matrix

## Current implementation delta (2026-09-23)

| Feature | Current state | Acceptance note |
|---|---|---|
| Realtime Slow Context Agent | Code and deterministic contracts implemented | Real local Agent smoke failed; full Step-Audio voice acceptance is not passed |
| Current Story Q+A retrieval | Owner/story/subject scoped; user Answer is the only fact source | Retriever service health currently returns HTTP 200; preserve SQLite as source of truth |
| `realtime-context` OpenClaw agent | Dedicated workspace, `interview-observer` Skill and deny-all tools policy provisioned | Config dry-run/read-back passed; live model/runtime execution remains unverified |
| Competition Tech Panel | Hidden unless `COMPETITION_TECH_PANEL=1` | Displays allowlisted stage/latency/model metadata; GPU values stay Not available without telemetry |

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
