# Repository layout freeze

During Phase 0/1:

```text
public/                 # stable legacy Web baseline
src/                    # stable legacy server/domain/repository baseline
test/                   # imported legacy regression suite

agent/
  runtime/              # AgentGateway + NemoClaw/OpenClaw adapter
  skills/               # OpenClaw Skills
  tools/                # Tool contracts/auth/server
  tracing/              # agent_runs and audit helpers

nvidia/
  nemoclaw/
    config/
    openshell-policy/

deploy/
  mac/
  dgx-spark/

tests/
  unit/
  integration/
  e2e/
  agent-eval/
```

Rules:

- Do not bulk-move `public/` or `src/` during Phase 0/1.
- New Agent code goes directly under `agent/`.
- NVIDIA-specific configuration goes under `nvidia/`, never business rules.
- Mac and DGX Spark do not get duplicated business implementations.
- Third-party NemoClaw/OpenShell/OpenClaw/NIM/RAG source code and model weights are not vendored.
