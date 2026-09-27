# DGX Spark Deployment Profile

This directory is deployment-only. Product code remains shared with Mac.

## One-command path

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA
git checkout spark
./deploy/spark/install.sh
./deploy/spark/verify.sh
```

After this branch is merged to the final competition branch, the explicit checkout is no longer needed.

## Before renting Spark

Run locally:

```bash
./deploy/spark/install.sh --dry-run
```

Hardware-dependent verify gates are never reported as PASS off Spark; they remain
`NOT TESTED - REQUIRES DGX SPARK`.

Credentials are optional unless the selected upstream artifacts require them. The
preflight report records only present/missing for `HF_TOKEN`, `NGC_API_KEY`,
`NVIDIA_API_KEY`, and `NVIDIA_INFERENCE_API_KEY`; it never prints values.
Put required values in the shell environment or the untracked
`deploy/spark/.env` (mode 600).

## Architecture

```text
Shared Product (src/, web/public, agent/, nvidia/)
        |
        +-- OpenAI-compatible Text Provider -> local vLLM :8000
        +-- Coach -> local qwen3-8b vLLM :8001
        +-- RealtimeVoiceProvider(stepaudio2_mini)
        |      -> Local Adapter -> WS Bridge :8092
        |      -> Step-Audio2 vLLM :8010 + Token2Wav
        +-- Retriever contract -> NeMo Retriever :7670 / VectorDB :7671
        +-- Agent Task Contract -> NemoClaw/OpenShell/OpenClaw
        +-- NAT -> eval/profiler/regression only
```

Mac defaults remain StepFun Cloud because root `.env.example` keeps
`STEPAUDIO2_EXECUTION=stepfun-cloud`. Spark selects `local` only in this
deployment profile.

## Voice capability policy

The Local Adapter starts with every capability set to false. The Bridge announces
the features it actually implements during session setup. Current bridge:
context injection, explicit turn request, explicit session close, and manual turn
control are implemented; full duplex, interruption, playback ACK, and tool calling
are false. This must not be changed to PASS based on model marketing or an
unverified upstream API.

The StepFun reference image is probed for an ARM64 manifest before use. If ARM64
is not proven on the real machine, `models/realtime.sh` refuses x86 emulation and
uses only an explicit `SPARK_STEPAUDIO_NATIVE_START_CMD` fallback. That remaining
choice is a true GB10 compatibility task, not a second product implementation.

## Lifecycle

```bash
./deploy/spark/preflight.sh
./deploy/spark/start.sh
./deploy/spark/status.sh
./deploy/spark/restart.sh
./deploy/spark/benchmark.sh
./deploy/spark/stop.sh
```

Runtime state, logs, diagnostics, caches and benchmarks live under `runtime/` or
user cache directories and are not committed. Stop/restart never deletes SQLite,
Retriever data, model caches, NemoClaw sandboxes or user data.

## Spark-day order

1. `preflight.sh`
2. start/prefetch large images and models immediately
3. Text 35B
4. NemoClaw / OpenShell / formal Skills
5. NeMo Retriever + Era index
6. Coach
7. Step-Audio2 Local
8. backend/full stack
9. `benchmark.sh` → text / coach / retriever / realtime / concurrency evidence
10. clean-clone one-command replay
11. retain `runtime/diagnostics/spark/` and `runtime/benchmarks/spark/` as evidence

Never interpret Cloud fallback, Retriever fail-open, or Coach fail-open as a local
Spark PASS.
