# DGX Spark application profile

This repository is the Life Interview application for DGX Spark. It does not
install or manage the machine's NVIDIA stack or the Text, Coach, Voice, or
Retriever runtimes. Prepare those services with their maintainers' instructions,
then configure this application to use their HTTP and WebSocket endpoints.

## Prerequisites

Prepare the Spark host yourself:

- DGX Spark with DGX OS / Linux on ARM64 and an NVIDIA GB10 driver.
- NVIDIA Container Toolkit and Docker Engine, configured for GPU access.
- Git and Node.js 24.16+ (24.x), 26.1+, or newer. npm is required by the
  repository's Node wrapper.
- Network access and enough disk for the application and your chosen runtimes.
- The four application endpoints below. Text must be running before NemoClaw
  onboarding. Python 3.12 and uv are only needed for optional NAT evaluation;
  they are not prerequisites for application setup or verification.

Official references:

- [NVIDIA DGX Spark documentation](https://docs.nvidia.com/dgx/dgx-spark/)
- [NVIDIA Container Toolkit installation guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- [Docker Engine installation](https://docs.docker.com/engine/install/ubuntu/)

Verify host prerequisites and Docker GPU access:

```bash
uname -m
nvidia-smi
docker info
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

The final command follows NVIDIA's [Container Toolkit sample workload](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/sample-workload.html).

## 1. Clone

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA
```

## 2. Prepare the AI Runtime endpoints

Start each runtime yourself, using its official documentation. The application
only calls the configured endpoint. It does not pull model images, download
weights, choose GPU memory limits, or restart these services.

| Runtime | Recommended model | Endpoint contract | Official instructions |
|---|---|---|---|
| Text | `nvidia/Qwen3.6-35B-A3B-NVFP4` | OpenAI-compatible `http://127.0.0.1:8000/v1` | [NVIDIA DGX Spark vLLM model recipes](https://build.nvidia.com/spark/vllm/agent-ready-models), [Qwen3.6-35B-A3B recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10) |
| Coach | `Qwen/Qwen3-8B` | OpenAI-compatible `http://127.0.0.1:8001/v1` | [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) |
| Voice | Step-Audio 2 Mini | Product WebSocket `ws://127.0.0.1:8092/realtime` | [Step-Audio 2 official repository](https://github.com/stepfun-ai/Step-Audio2) |
| Retrieval | NeMo Retriever | REST `http://127.0.0.1:7670` | [NeMo Retriever getting started](https://docs.nvidia.com/nemo/retriever/latest/extraction/getting-started-about/) |

### Text model

Follow NVIDIA's current DGX Spark vLLM recipe. Its model selection starts with:

```bash
export MODEL_HANDLE=nvidia/Qwen3.6-35B-A3B-NVFP4
```

Start the server using the recipe's current command and verify the served model
ID:

```bash
curl http://127.0.0.1:8000/v1/models
```

For NemoClaw's unauthenticated local-vLLM route, bind the existing server to
loopback as NVIDIA documents. Setup reuses this server; it does not start a
second Text model.

### Coach model

For vLLM, start the served model on port 8001:

```bash
vllm serve Qwen/Qwen3-8B --host 127.0.0.1 --port 8001
```

Verify it with `curl http://127.0.0.1:8001/v1/models`, then use the exact
served model ID in the application configuration. Another OpenAI-compatible
runtime may use the same endpoint contract.

### StepAudio

StepAudio Local Runtime is an external dependency. Follow StepFun's current
instructions to install and start it. StepFun's Docker/vLLM examples are
upstream references only; this project has **NOT VERIFIED ON DGX SPARK / ARM64**
the cited image or any specific StepAudio runtime path. The product only
requires a Realtime WebSocket endpoint at
`ws://127.0.0.1:8092/realtime`. The retained `stepaudio2_bridge.py` is the
product protocol adapter; an HTTP model endpoint alone does not satisfy the
WebSocket contract. After preparing the backend and its dependencies according
to StepFun's instructions, the adapter can be run separately, for example:

```bash
STEP_AUDIO_SOURCE_DIR=/opt/Step-Audio2 \
STEP_AUDIO_BACKEND_URL=http://127.0.0.1:8002/v1/chat/completions \
STEP_AUDIO_TOKEN2WAV_DIR=/opt/Step-Audio-2-mini/token2wav \
STEP_AUDIO_PROMPT_WAV=/opt/Step-Audio2/assets/default_male.wav \
python3 deploy/spark/services/stepaudio2_bridge.py
```

The configured service must expose the Life Interview WebSocket contract at
`/realtime`. Spark `setup.sh`, `start.sh`, and `stop.sh` do not install, start,
or manage the model or bridge processes.

### NeMo Retriever

Start the NeMo Retriever Service with NVIDIA's instructions. Any VectorDB is
an internal Retriever Runtime dependency and is not an application endpoint.
This application creates its Transcript and Era collections, indexes
application data, and uses only the Retriever REST service. It never starts,
stops, or updates Retriever containers.

Verify the endpoints before continuing:

```bash
curl http://127.0.0.1:8000/v1/models
curl http://127.0.0.1:8001/v1/models
curl http://127.0.0.1:7670/v1/health
```

The WebSocket handshake and model IDs are checked by `check-env.sh`.

## 3. Configure

```bash
cp deploy/spark/env.example deploy/spark/.env
chmod 600 deploy/spark/.env
```

Edit the served model IDs and endpoint URLs if your runtimes use different
values. Keep the Text and Agent URLs/models aligned:

```dotenv
TEXT_MODEL_PROVIDER=openai-compatible
TEXT_MODEL_BASE_URL=http://127.0.0.1:8000/v1
TEXT_MODEL=<actual-served-model-id>
TEXT_MODEL_API_KEY=

REALTIME_COACH_PROVIDER=openai-compatible
REALTIME_COACH_BASE_URL=http://127.0.0.1:8001/v1
REALTIME_COACH_MODEL=<actual-served-model-id>
REALTIME_COACH_API_KEY=

STEPAUDIO2_EXECUTION=local
STEPAUDIO2_LOCAL_WS_URL=ws://127.0.0.1:8092/realtime

NEMO_RETRIEVER_ENABLED=true
NEMO_RETRIEVER_BASE_URL=http://127.0.0.1:7670
NEMO_RETRIEVER_API_TOKEN=

AGENT_MODEL_BASE_URL=http://127.0.0.1:8000/v1
AGENT_MODEL_DEFAULT=<same-actual-served-text-model-id>
SPARK_SEED_DEMO_DATA=false
```

Do not put provider secrets in Git or print them in diagnostics. The setup script
generates application signing secrets into this ignored mode-0600 file.

## 4. Set up the application

With the endpoints running:

```bash
./deploy/spark/check-env.sh
./deploy/spark/setup.sh
```

`check-env.sh` only reports host and endpoint readiness. It does not install,
repair, restart, or stop anything.

`setup.sh` installs npm dependencies, migrates the application SQLite database,
initializes Retriever collections and Era data, then installs
and configures NemoClaw/OpenClaw and the formal Skills. It uses NVIDIA's hosted
NemoClaw installer when the CLI is absent and the documented
`nemoclaw onboard --non-interactive` path for a missing sandbox. It sets the
existing vLLM provider and served model in NemoClaw, so OpenClaw reuses the
already-running Text endpoint. It never selects `install-vllm` or starts a
second model server. Non-interactive onboarding explicitly sets
`NEMOCLAW_WEB_SEARCH_PROVIDER=none`, so unrelated host credentials do not
silently enable optional external web search.

Demo data is optional. The default `SPARK_SEED_DEMO_DATA=false` leaves a new
database without sample people or stories. Set it to `true` in `.env` only when
you want the demo seed.

References: [NemoClaw Quickstart with OpenClaw](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart),
[reuse an existing vLLM server](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm),
[OpenAI-compatible endpoints](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/custom-endpoints/set-up-openai-compatible-endpoint).

## 5. Start and stop

```bash
./deploy/spark/start.sh
./deploy/spark/status.sh
./deploy/spark/stop.sh
```

These commands manage only Product-owned Backend/Web, retrieval proxy, and
Technical Observer processes. They do not stop user-managed Text, Coach,
StepAudio, or Retriever runtimes, and they do not stop NemoClaw/OpenClaw.

## 6. Verify

```bash
./deploy/spark/verify.sh
```

Verification writes a timestamped report and logs under
`runtime/diagnostics/spark/verify-runs/`; each run keeps its own evidence. It
checks the hardware profile, HTTP/WebSocket endpoints, model responses, Backend,
Web, SQLite, realtime integration, Retriever and Era/Memory, NemoClaw/OpenClaw,
Skills, selected deterministic product acceptance tests, and Technical
Observer. NAT, profiler, and benchmark evaluation are separate optional
competition evidence and do not gate application verification.

Statuses stay explicit:

- `PASS`: the named check ran and passed.
- `FAIL`: a required check ran and failed.
- `EXTERNAL RUNTIME NOT READY`: an operator-managed endpoint is unavailable.
- `NOT TESTED ON DGX SPARK`: the host is not a detected ARM64 GB10 system.
- `NOT TESTED`: an additional verification input, such as a speech fixture, is
  missing.

The full StepAudio audio-to-audio gate uses a speech WAV fixture. Set
`SPARK_REALTIME_FIXTURE=/path/to/speech.wav` to use a prepared fixture.
Verification does not claim DGX Spark hardware validation when run on a Mac or
another machine.

DGX Spark compatibility, including the StepAudio Runtime on ARM64, remains
**NOT TESTED ON DGX SPARK / ARM64** until the hardware run produces reviewed
evidence.

## Benchmark

Competition benchmarks remain separate from deployment. Run them after preparing
the Spark runtime and product:

```bash
bash scripts/codex-node.sh npm run spark:benchmark
```

The benchmark records model, Coach, Retriever, realtime, and end-to-end evidence;
it does not install or manage the external AI runtimes.

## Mac and other profiles

Spark is a deployment profile. The root `.env.example`, default
`npm run dev`, StepFun Cloud voice path, and Direct Model Runtime remain the
normal Mac development defaults.
