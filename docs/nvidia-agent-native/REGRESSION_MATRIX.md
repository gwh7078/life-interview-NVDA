# Regression matrix

Imported automated suites remain the source of truth for baseline behavior.

P0 regression requirements:

- authentication and owner isolation;
- DB migration/seed correctness;
- onboarding interview, closeout and result;
- life-stage CRUD and delete guard;
- story create/continue/result;
- Story Agent Memory evidence validation and information-loss rejection;
- closeout idempotency, stale-attempt protection and transactional persistence;
- Completion and gaps behavior;
- story generation and versioning;
- contributor share create/revoke/expiry/hash behavior;
- same-link contributor continuity and Contributor Summary;
- realtime provider contract and transcript preservation;
- 4-second stalled user-turn recovery;
- book APIs, preview and PDF export;
- repository boundary tests.

Phase 1 adds:

- AgentGateway unit tests;
- Tool token signature/expiry/scope tests;
- owner-scope test for `get_story_context`;
- invalid resource test;
- runtime timeout/failure test;
- agent-run state transition test;
- real NemoClaw/OpenClaw smoke test kept outside normal CI.
