# NVIDIA Agent-Native development notes

This directory records implementation artifacts derived from the V2.1 development document set supplied for this repository.

Frozen principles:

1. Preserve the existing product behavior before replacing orchestration.
2. OpenClaw/NemoClaw never open `memoir.db` directly.
3. Agent access to product data goes through scoped Node Tool APIs.
4. Long-term state remains in the application database, not OpenClaw session history.
5. Mac and DGX Spark share the same business code; environment differences are adapters/configuration.
6. Phase 1 uses a real NemoClaw/OpenClaw sandbox, not a mock runtime, for the smoke gate.
7. NeMo Retriever remains outside the Phase 1 core path. Current Realtime has formal StepAudio 3 Quality and Step-Audio-2-mini StepFun Cloud profiles; Independent Memory is triggered by the final user transcript and never by Native Tool Calling. Current implementation and acceptance status are in the [dual-profile report](../07-reports/testing/REALTIME_DUAL_PROFILE_MEMORY_REPORT_v1.0.md).
