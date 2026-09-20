# Phase 0 baseline

- BASELINE_MAIN_SHA=`f05b22ce57ae06e4e619bd53218278e6937475e4`
- BASELINE_DATE=`2026-09-20`
- SOURCE_REPOSITORY=`gwh7078/life-interview`
- TARGET_REPOSITORY=`gwh7078/life-interview-NVDA`
- TARGET_BRANCH=`nvidia/agent-native`

## Frozen stable behavior

- 4 second stalled-turn recovery remains required.
- Contributor opening must include relationship context.
- Contributor interview completion moves immediately into result processing.
- Story Agent Memory updates remain evidence-aware.
- Completion failure does not roll back a successful closeout.
- Share links expire after 7 days.
- Share tokens are persisted as hashes only.
- Re-entering the same share link represents the same contributor.
- Contributor summary keeps the current product length bound.
- Closeout is idempotent / stale-attempt guarded.
- All domain reads and writes remain owner-scoped.

## Migration scope

The competition repository imports the current runnable product code, tests, migrations and minimal current product docs. Historical audit reports, local data, credentials, diagnostics, large vendor PDFs and old one-off artifacts are deliberately excluded.
