# Feature matrix

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
| realtime | Doubao/Qwen abstraction + recovery | KEEP |
| health | server health endpoint | KEEP |
| Agent runtime | not in legacy product | ADD in Phase 1 |
| Agent Tool API | not in legacy product | ADD read-only in Phase 1 |
| NeMo Retriever | Phase 3A/B integration Gate in progress; local service currently HTTP 503 | KEEP Phase 1 boundary; complete after real Gate |
