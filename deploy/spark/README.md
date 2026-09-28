# DGX Spark Deployment Profile

This directory is deployment-only. Product code remains shared with Mac.

## Three deployment operations

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA
git checkout main
./deploy/spark/install.sh
```

For a frozen test run, check out the `SPARK_RC_SHA` recorded in the final
validation handoff instead of following a moving branch.

`install.sh` is the first-machine one-command flow: Runtime artifact prefetch,
Text/Coach startup, Base bootstrap, Retriever startup, Product update, full
start and verify. Text is ready before first NemoClaw onboarding so OpenClaw
uses the existing local vLLM service rather than installing a separate model.
It already runs `verify.sh`.

Daily Product development:

```bash
git pull
./deploy/spark/update.sh
```

`update.sh` applies Product dependencies, migrations, changed Skills and Era
data, and validates the Product. On success it stops and restarts Backend/Web,
the scoped retrieval proxy, and Observer; this can start them even if they were
stopped before the update. `--no-restart` leaves those services stopped after a
successful update. The update may call Retriever APIs to ensure collections but
does not start or restart the Retriever service. It never installs or upgrades
Spark Base or restarts Text, Coach, Voice, Retriever, or NemoClaw Runtime
services. If Base inputs are incompatible, it fails with the required
`bootstrap.sh` command.

Model changes stay in the Spark Runtime profile:

```bash
./deploy/spark/models.sh status
./deploy/spark/models.sh sync text       # or coach / voice; fetch the selected artifacts
./deploy/spark/restart.sh text           # or coach / voice
```

`models.sh prefetch [text|coach|voice]` downloads only the selected Runtime
artifacts. Container `spec_hash` reconciliation recreates only a service whose
image, model or runtime arguments changed. `SPARK_TEXT_MODEL` and
`SPARK_COACH_MODEL` select model artifacts; their `*_SERVED_MODEL` values keep
the Product-facing API route stable when the underlying model changes. Set
`TEXT_MODEL` and `AGENT_MODEL_*` to the Text served name, and `REALTIME_COACH_MODEL`
to the Coach served name; these are API model identifiers, not weight IDs. The
example aliases are `text-api` and `coach-api`. Changing Text also refreshes the
NemoClaw route after its selective restart; it does not reinstall the NemoClaw
Base. `models.sh sync` only prepares the selected model;
the following restart applies its container spec and does not restart other
models.

### Unified Memory budget

The default vLLM utilization settings are Text `0.40`, Coach `0.18`, and
StepAudio `0.12`, for a configured total of `0.70`. This leaves headroom for
Retriever, KV-cache variation, CUDA, Docker, Node, OpenClaw, and the operating
system on DGX Spark's Unified Memory. These are runtime limits, not measured peak
usage; only the Spark run can establish actual concurrent memory use. Changing
`SPARK_STEPAUDIO_GPU_MEMORY_UTILIZATION` changes the Voice backend fingerprint
and recreates that backend on the next start.

## Spark Base

`install.sh` invokes `bootstrap.sh` during first setup after Text is ready. On a
configured Spark, run `bootstrap.sh` only for a real Base upgrade:

```bash
./deploy/spark/bootstrap.sh
./deploy/spark/verify-base.sh
```

`verify-base.sh` checks ARM64/GPU/Docker GPU, the host toolchain, NemoClaw /
OpenShell, the Base fingerprint and persistent paths. It has no dependency on
current model IDs, database contents or Skills. A Spark `PASS` is the Base
freeze point; `NOT TESTED - REQUIRES DGX SPARK` is not a pass.

The Base fingerprint covers the host architecture, GPU/driver, Docker/NVIDIA
Runtime, Base version inputs, managed tool versions, generic vLLM image and Base
setup scripts. The Base pins `uv` to 0.12.19, the version used by a successful Spark CI run; changing it changes the fingerprint. It does not include Git HEAD or the full Spark `.env`. Text,
Coach and Voice use separate container specifications; formal Skills and
Product dependencies have their own content/lockfile fingerprints.

## Before renting Spark

Run locally:

```bash
./deploy/spark/install.sh --dry-run
```

Hardware-dependent verify gates are never reported as PASS off Spark; they remain
`NOT TESTED - REQUIRES DGX SPARK`.

`verify.md` records the checked-out Git commit, host architecture and device,
GPU driver, Docker/GPU runtime, memory and free disk, configured model IDs,
runtime gate results, and the overall result. Its Git commit is captured from
`git rev-parse HEAD` for reproducible hardware evidence.

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
        |      -> signed retrieval scripts -> private proxy :4175
        |      -> Backend /internal/agent-retrieval/* :4174
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

The Spark deployment path and local Adapter/Bridge integration are implemented.
GB10 / ARM64 runtime compatibility still requires verification on DGX Spark. The
StepFun reference image is checked for a verified `linux/arm64` manifest before
prefetch. If ARM64 is not proven and `SPARK_STEPAUDIO_NATIVE_START_CMD` is empty,
prefetch fails before downloading artifacts. A configured native command is
reported as `NATIVE_FALLBACK`; it must bind local services to loopback and honor
`SPARK_STEPAUDIO_GPU_MEMORY_UTILIZATION`. No unverified native command is
provided by the deployment.

Text, Coach, and the StepAudio backend publish their API ports only on
`127.0.0.1`. The StepAudio bridge and Retriever use host networking: the bridge
binds WebSocket and health endpoints to loopback, while Retriever is started
with `--host 127.0.0.1`; its supervised VectorDB child also listens on loopback.
The scoped `agent-retrieval-proxy` remains reachable on the private host address
for the NemoClaw sandbox and continues to rely on its scoped API and token policy.

## Agent retrieval boundary

The product Backend remains bound to loopback. A tiny Spark-only reverse proxy
binds the host's private address and exposes only the two signed formal-Agent
retrieval routes. OpenShell policy permits only those routes and Node binaries;
it does not mount `memoir.db` or the repository into the sandbox. The persistent
token-signing secret is generated into untracked `deploy/spark/.env`; each Agent
run still receives only its normal short-lived scoped retrieval token.

## Selective service operations

```bash
./deploy/spark/preflight.sh
./deploy/spark/start.sh
./deploy/spark/status.sh
./deploy/spark/restart.sh all
./deploy/spark/restart.sh product
./deploy/spark/restart.sh backend
./deploy/spark/restart.sh text
./deploy/spark/restart.sh coach
./deploy/spark/restart.sh voice
./deploy/spark/restart.sh retriever
./deploy/spark/restart.sh nemoclaw
./deploy/spark/benchmark.sh
./deploy/spark/stop.sh
```

The default `restart.sh` target remains `all`. Use `product` or a named service
to avoid restarting unrelated models.

## Persistent paths and data

`SPARK_HOME` defaults to `$HOME/.local/share/life-interview/spark`. It holds
bootstrapped tools, Base state, PIDs, runtime state, Retriever data and the
Spark SQLite database (`$SPARK_HOME/data/memoir.db`). HF/NGC model caches keep
using `HF_HOME`, `MODEL_CACHE` and `NGC_CACHE`. Diagnostics, logs and benchmark
evidence remain under the Product checkout's `runtime/` for easy archiving.
If an older checkout has `data/memoir.db`, `update.sh` copies it using SQLite's
backup API, verifies integrity and retains the original; conflicting old and
new databases stop the update without overwriting either file. Existing
Retriever data from the former `runtime/retriever` path is copied into an empty
`SPARK_HOME` Retriever directory on first start; the source remains in place.
If both old and persistent SQLite files differ, `update.sh` stops without
choosing one and leaves Backend/Observer stopped until `DATABASE_PATH` is
resolved, preventing service startup against the wrong copy.

This path policy is Spark-only. Mac setup and its per-Worktree database path
remain unchanged. Stop/restart never deletes SQLite, Retriever data, model
caches, NemoClaw sandboxes or user data. Re-running `install.sh` while the
deployment is live is supported: preflight allows ports owned by services this
profile can positively identify; unrelated occupied target ports fail closed.

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
