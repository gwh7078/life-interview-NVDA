# NAT Agent Evaluation Report v1.0

## Run

- Date: 2026-09-22
- Lane: NAT-1 Evaluation / Regression
- Dataset: `phase2b-smoke`, 6 synthetic cases
- Execution: real `AgentTaskPort → NemoClaw → OpenClaw → Model → Backend Validator`
- NAT: 1.9.0
- Provider: `bailian`
- Models: `bailian/qwen3.8-max`, `bailian/qwen3.8-flash`
- Raw outputs: retained only under ignored `.tmp/nat/smoke/`

## Metrics

| Metric | Result |
| --- | ---: |
| Case count | 6 |
| Runtime success | 100% |
| Schema / contract success | 100% |
| Backend Validator success | 6 / 6 |
| Deterministic semantic checks | 14 / 14 |
| Average attempts | 1.17 |
| Repair rate | 16.7% (1 / 6 cases) |
| Validation repair cases | 1 / 6 |
| Repair count | 1 |
| Format repair used | 0 / 6 |
| P50 latency | 48,203.5 ms |
| P95 latency | 87,590.25 ms |
| NAT workflow runtime | 350.27 s |

## Validation scope

The shared six fixtures exercise the AgentTaskPort runtime contract, `agent_runs` tracing and the existing
deterministic Backend Proposal Validators. All six cases reported `backend_validation=passed`; one case used the
existing Validation Repair path. They do not construct or persist Session, Story, Share, or Document domain records,
so this report does not claim full product workflow or database persistence validation.

The 24-case synthetic regression index is implemented in `nvidia/nat/datasets/regression.jsonl`. Full-provider execution is a separate manual gate because it requires NemoClaw, OpenClaw, provider configuration, and external model usage.

The current deterministic local gate ran all 24 cases with `NAT_AGENT_RUNTIME=stub`: 24/24 workflow results,
contract checks and Backend Validators passed with an evaluator average of 1.0. Stub mode intentionally skips
model-dependent semantic checks, so this is a fixture and bridge regression result rather than a provider quality
score.

## Environment

- macOS Apple Silicon
- Python 3.12.14
- Node.js 24.21.0 through `scripts/codex-node.sh`
- NemoClaw 0.0.124
- OpenClaw 2026.7.1
