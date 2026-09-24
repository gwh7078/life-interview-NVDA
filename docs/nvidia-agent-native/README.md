# NVIDIA Agent-Native development notes

This directory records implementation artifacts derived from the V2.1 development document set supplied for this repository.

Frozen principles:

1. Preserve the existing product behavior before replacing orchestration.
2. OpenClaw/NemoClaw never open `memoir.db` directly.
3. Agent access to product data goes through scoped Node Tool APIs.
4. Long-term state remains in the application database, not OpenClaw session history.
5. Mac and DGX Spark share the same business code; environment differences are adapters/configuration.
6. Phase 1 uses a real NemoClaw/OpenClaw sandbox, not a mock runtime, for the smoke gate.
7. NeMo Retriever remains outside the Phase 1 core path; the historical Phase 3A/B Gate G0–G8 passed for its then-current path. Step-Audio-2-mini is Retired; MiniCPM-o-4.5-Realtime is Candidate, with official native Tool Calling / Tool Result / Resume undocumented. The latest real Realtime Agent smoke is **FAIL** (`AGENT_RUNTIME_TIMEOUT`); full MiniCPM E2E is **NOT TESTED**. See the [integration convergence report](../07-reports/testing/REALTIME_INTEGRATION_CONVERGENCE_REPORT_v1.0.md).
