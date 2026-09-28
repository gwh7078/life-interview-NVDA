# DGX Spark Official Reference Index v1.0

> 更新：2026-09-27  
> 用途：给开发 Agent 提供可直接查阅的官方来源。只记录与本项目 Spark 完整移植有关的资料。

> 部署职责边界（2026-09-28）：本页是上游资料索引，不是仓库安装规范。
> 由用户按官方说明准备 DGX OS、Driver、Docker 和 AI Runtime；应用侧流程
> 以 [当前部署说明](README.md) 为准。仓库不安装或管理 Text、Coach、
> StepAudio、Retriever Runtime。

## A. DGX Spark 系统与版本

### A1. DGX Spark User Guide
https://docs.nvidia.com/dgx/dgx-spark/

用途：

- 系统总入口；
- Release Notes；
- Known Issues；
- Docker / NVIDIA Container Runtime；
- NGC；
- NVIDIA Sync；
- DGX Dashboard。

### A2. System Overview
https://docs.nvidia.com/dgx/dgx-spark/system-overview.html

当前关键事实：

- 128 GB unified memory；
- 20-core ARM64 CPU；
- DGX OS / CUDA / Docker / NVIDIA Container Runtime 为系统主环境；
- SSH、NVIDIA Sync、remote desktop 都是官方支持访问方式。

项目含义：

- Runtime 操作者负责确认所选模型和镜像支持目标 ARM64 / GB10 环境；
- 本仓库的 Spark profile 只检查主机架构和外部 endpoint，不搬运系统镜像或二进制。

### A3. Release Notes
https://docs.nvidia.com/dgx/dgx-spark/release-notes.html

2026-09-27 可见 Founders Edition 当前版本：

```text
DGX OS        7.5.0
GPU Driver    580.159.03
CUDA Toolkit  13.0.2
Kernel        6.17
```

注意：

- 该版本表只保证 Founders Edition；
- 租用的 GB10 partner system 可能不同；
- `deploy/spark/check-env.sh` 只读检查 ARM64、GPU、Docker 和外部服务；需要完整 OS / driver / CUDA / kernel 清单时由操作者另行保存，不由应用脚本改写系统。

### A4. Known Issues
https://docs.nvidia.com/dgx/dgx-spark/known-issues.html

与本项目最相关：

- iGPU / UMA 下 `nvidia-smi` 可能显示 `Memory-Usage: Not Supported`；
- DGX Spark 是 unified memory architecture；
- 不应只依赖传统 dedicated VRAM 语义判断可分配内存；
- 调试内存压力时官方给出 drop-caches workaround，但自动部署脚本不得无条件执行破坏性内存操作。

### A5. NVIDIA Container Runtime for Docker
https://docs.nvidia.com/dgx/dgx-spark/nvidia-container-runtime-for-docker.html

关键事实：

- NVIDIA Container Toolkit / Docker GPU integration 在 DGX Spark 上是官方主路径；
- 真机第一 Gate 必须验证容器内 GPU 可见。

最低验证：

```bash
docker ps
nvidia-smi
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
```

## B. 本地文本模型：vLLM

### B1. DGX Spark vLLM Playbook
https://build.nvidia.com/spark/vllm/instructions

关键事项：

- OpenAI-compatible API；
- Spark 使用 UMA；
- 官方建议从较保守 `--gpu-memory-utilization` 起步；
- 提供 health 等待与 API smoke 模式；
- 模型缓存应挂载到 host，避免容器重启重新下载。

### B2. Agent-ready Models
https://build.nvidia.com/spark/vllm/agent-ready-models

NVIDIA 当前 DGX Spark 推荐：

```text
nvidia/Qwen3.6-35B-A3B-NVFP4
```

### B3. Qwen3.6-35B-A3B vLLM Recipe
https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10

当前 recipe 重点：

- NVFP4 支持 Blackwell，包括 DGX Spark GB10；
- 当前 recipe 要求 NVFP4 vLLM >= 0.28.0；
- GB10 tuned profile 使用 UMA-aware 配置，recipe 当前将 `gpu-memory-utilization` 限制在 0.5；
- recipe 记录了 2026-08-31 一次 GB10 实测，这只是 NVIDIA recipe 基准，不是本项目性能承诺。

项目用途：

- Post-session Agent / Closeout / Completion / Generation 第一主测；
- OpenAI-compatible endpoint 直接适配现有 Text Runtime；
- Runtime 操作者应从 recipe 获取最终启动 flags；仓库记录 endpoint 和实际 served model ID，不决定 GPU memory utilization。

## C. NemoClaw / OpenShell / OpenClaw

### C1. Run NemoClaw with a Local LLM
https://build.nvidia.com/spark/nemoclaw/instructions

重要：

- NVIDIA 已提供 DGX Spark 的 NemoClaw 本地 LLM playbook；
- 官方当前安装入口：
  `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`
- installer 会处理 Node.js / OpenShell / NemoClaw CLI 等基础工作；
- custom onboarding 支持 existing vLLM / managed vLLM / OpenAI-compatible endpoint；
- Node.js 低于要求是常见故障点；
- remote dashboard 可以走 SSH tunnel。

本项目用途：

- 不再自己发明一套 NemoClaw 安装过程；
- `deploy/spark/setup.sh` 在 Text endpoint 已运行后使用 NVIDIA 官方 installer / onboarding，配置 OpenClaw 复用既有模型，并安装本项目 Skills / policies；
- 不通过 NemoClaw 下载或启动第二份 Text model；
- 必须保留现有 scoped Tool / policy 边界。

### C2. OpenShell DGX Spark Playbook
https://build.nvidia.com/spark/openshell

### C3. OpenShell Developer Guide
https://docs.nvidia.com/openshell/latest/home

重点：

- sandbox / gateway；
- declarative network / filesystem policy；
- local inference routing；
- observability；
- sandbox 默认限制与 egress 故障排查。

本项目原则：

- 不为了省事取消 OpenShell policy；
- Agent 需要的访问显式加入 policy；
- 本项目业务 DB 不直接暴露给 Agent sandbox。

## D. NeMo Retriever

### D1. NeMo Retriever Documentation
https://docs.nvidia.com/nemo/retriever/latest/

### D2. Deployment Options
https://docs.nvidia.com/nemo/retriever/latest/extraction/quickstart-library-mode/

支持形态包括：

- local library；
- standalone Docker service；
- Helm/Kubernetes；
- hosted/self-hosted model components。

### D3. Support Matrix
https://docs.nvidia.com/nemo/retriever/latest/extraction/support-matrix/

2026-09-27 可见关键事实：

- local GPU inference：Linux；
- CUDA 13；
- Python 3.12；
- release `nrl-service` container 当前是 `linux/amd64` + `linux/arm64` multi-arch manifest。

项目意义：

- NeMo Retriever Runtime 由用户按 NVIDIA 当前文档准备；仓库不 pull image 或管理容器生命周期；
- 应用继续拥有 collection 初始化、Transcript / Era 索引、Retriever Client 和 fail-open contract；
- 仍要在真机跑现有 ingest/query/scope-isolation Gate；
- private Transcript 和 public Era Context 继续使用独立 collection；
- SQLite 继续是 Source of Truth。

## E. Step-Audio-2-mini / Voice

### E1. StepFun Step-Audio2 Official Repository
https://github.com/stepfun-ai/Step-Audio2

已确认：

- Step-Audio-2-mini 为 Apache-2.0 开源模型；
- 官方提供 vLLM backend；
- 官方 vLLM 示例包含 streaming inference；
- 官方上游镜像示例（仅参考，不代表本项目验证）：
  `stepfun2025/vllm:step-audio-2-v20250909`。

项目验证状态：**NOT VERIFIED ON DGX SPARK / ARM64**。该具体镜像 / vLLM backend 尚未由本项目在 Spark ARM64 真机验证；使用者应按 StepFun 当前官方说明选择并启动兼容 Runtime。本仓库只要求产品 WebSocket endpoint `ws://127.0.0.1:8092/realtime`。

高风险提醒：

- 官方 README 没有在该段声明此 StepFun Docker image 的 ARM64 manifest；
- Spark 是 ARM64，Runtime 操作者应按 StepFun 当前文档确认其选定 Runtime 可用；
- 仓库不执行 manifest probing、下载、ARM64 fallback 或 Native Runtime 生命周期管理；
- 应用只检查 WebSocket endpoint 并保留 Local Provider / protocol adapter；
- 不应在租机当天才设计 Realtime Provider Contract。

### E2. vLLM-Omni StepAudio2
https://github.com/vllm-project/vllm-omni/tree/main/examples/offline_inference/step_audio2

关键事实：

- vLLM-Omni 已有 StepAudio2 two-stage pipeline；
- Stage 0 Thinker：audio → text + audio token；
- Stage 1 Token2Wav：audio token → waveform；
- 当前公开参考：
  - ASR：约 20–25 GB；
  - single-GPU S2ST：约 40–50 GB；
- 官方 README 记录测试硬件主要是 H100 / A10。

因此：

> “vLLM-Omni 支持 StepAudio2”只能证明模型 pipeline 路径存在，不能等价于“DGX Spark 上 full-duplex Realtime 已验证”。

### E3. vLLM-Omni Quickstart
https://github.com/vllm-project/vllm-omni/blob/main/docs/getting_started/quickstart.md

重点：

- Linux；
- Python 3.12；
- vLLM 与 vLLM-Omni major/minor 版本必须匹配；
- 支持 offline inference 与 OpenAI-compatible online serving，但每个模型的 online / realtime 能力应按其具体实现核实。

## F. 备选推理 Runtime

### F1. SGLang on DGX Spark
https://build.nvidia.com/spark/sglang

用途：

- OpenAI-compatible；
- structured JSON；
- prefix cache；
- 作为文本模型 vLLM 启动失败时的备选，不是当前首选。

### F2. TensorRT-LLM on DGX Spark
https://build.nvidia.com/spark/trt-llm/instructions

用途：

- NVIDIA 高性能推理备选；
- 需要额外工程工作；
- 一天租用约束下，不应在 vLLM 已满足需求时临时切换 Runtime。

## G. 远程接入

### G1. NVIDIA Sync
https://docs.nvidia.com/dgx/dgx-spark/nvidia-sync.html

官方支持：

- SSH；
- port forwarding / tunnels；
- direct connection；
- Tailscale；
- application launch。

项目建议：

- 远程桌面用于操作环境；
- SSH/NVIDIA Sync 用于稳定命令执行与端口转发；
- Web 产品最后既要能在 Spark 本机 `localhost` 打开，也应能通过安全 tunnel 从开发机访问。

## H. Spark 上的 Coding Agent

### H1. CLI Coding Agents
https://build.nvidia.com/spark/cli-coding-agent

NVIDIA 当前 playbook 明确包括 Codex CLI，并支持 DGX Spark。

用途：

- 租机当天让 coding agent 直接在 Spark repo / terminal 中诊断；
- 不是产品 Runtime；
- 不应把 Coding Agent 自身的本地模型下载与产品模型部署混在同一个 install path。

## I. 开发 Agent 的来源使用规则

1. 每次引用版本、镜像 tag、CLI flag 前重新检查官方页面；
2. 不从历史文档复制旧命令；
3. 对 ARM64 镜像先查 manifest；
4. 对 Realtime Voice capability 必须以真实事件/协议和真机 E2E 为准；
5. 对 UMA 内存不要沿用离散 GPU 的简单 VRAM 判断；
6. 所有“已支持 / 已验证”都必须注明：
   - upstream 支持；
   - DGX Spark 官方验证；
   - 本项目真机验证；
   三者不能混写。
