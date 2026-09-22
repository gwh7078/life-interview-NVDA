# Life Interview NAT Evaluation Lane

This directory contains the optional NeMo Agent Toolkit evaluation lane. It is not a product runtime dependency.

## Boundary

```text
NAT workflow
  -> Node bridge (stdin: case_id)
  -> createAgentTaskPort()
  -> NemoClaw sandbox
  -> OpenClaw + Skills
  -> LIFE_INTERVIEW_NAT_RESULT
  -> NAT evaluator / profiler
```

The Python package never calls the provider or NemoClaw directly. Product requests do not import this package.

## Environment

- Python 3.12
- uv
- `nvidia-nat[eval,profiler]==1.9.0`
- `langchain-core>=0.3,<1` (NAT 1.9.0 evaluation adapter dependency)
- `LIFE_INTERVIEW_ROOT` should point to the repository root
- `NEMOCLAW_SANDBOX` and the existing provider settings remain in the ignored root `.env`

Set up the isolated environment from the repository root:

```bash
bash nvidia/nat/scripts/setup.sh
```

Run the six-case real smoke gate:

```bash
bash nvidia/nat/scripts/smoke.sh
```

Run the 24-case synthetic regression gate when a provider-backed manual run is intended:

```bash
bash nvidia/nat/scripts/eval.sh
```

For a deterministic bridge and validator check without model usage:

```bash
NAT_AGENT_RUNTIME=stub bash nvidia/nat/scripts/eval.sh
```

Run the profiler lane with the same smoke dataset. Set `NAT_AGENT_RUNTIME=stub` for a deterministic local profiler
check; the default is the real Agent runtime:

```bash
bash nvidia/nat/scripts/profile.sh
```

All NAT outputs, including workflow output, evaluator output, profiler traces and effective config, belong under `.tmp/nat/` and must not be committed. The dataset stores only synthetic `case_id` values; fixture content stays in the TypeScript registry.

The current evaluator reports runtime status, contract validity, backend validation state, deterministic semantic checks,
attempts, repairs and latency. `not_applicable` is used when a Case has not wired a production business validator; it is
kept separate from business validation success.
