# NVIDIA Agent-Native development notes

This directory records implementation artifacts derived from the V2.1 development document set supplied for this repository.

Frozen principles:

1. Preserve the existing product behavior before replacing orchestration.
2. OpenClaw/NemoClaw never open `memoir.db` directly.
3. Agent access to product data goes through scoped Node Tool APIs.
4. Long-term state remains in the application database, not OpenClaw session history.
5. Mac and DGX Spark share the same business code; environment differences are adapters/configuration.
6. Phase 1 uses a real NemoClaw/OpenClaw sandbox, not a mock runtime, for the smoke gate.
7. NeMo Retriever remains outside the Phase 1 core path; Phase 3A/B now owns its scoped integration Gate, and the Mac automated Gate G0–G8 has passed. The final manual real-voice experience check remains separate.
