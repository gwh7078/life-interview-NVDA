# life-interview-NVDA

人生采访局 NVIDIA / DGX Spark 比赛版。产品定位是 **AI 回忆录记者**：通过持续语音采访、事实整理、Story Memory、完整度判断、第三者补充与成稿，把分散的人生经历逐步整理为可阅读、可继续补充、可最终成书的内容。

> **当前文档真相优先级：代码与环境配置 > `docs/CURRENT_STATE.md` > Current 专项文档 > Reports / Archive。**
>
> 历史方案、阶段计划和旧测试报告不再作为当前开发依据。

## 当前状态

- Mac 默认 Realtime：**Step-Audio-2-mini / StepFun Cloud**；可选 Realtime：**StepAudio 3 Quality / StepFun Cloud**。
- Mini 默认使用 `supervisor_auto`：Qwen3-8B Realtime Coach 负责 Gate / 指导；Story Continue 可按需并行检索 Current Story Memory 与 Era Context。Mini Coach 由产品低延迟 Realtime Runtime 执行，不经过 OpenClaw。
- Gate 最长 2 秒；Coach 全链路从用户 final transcript 起共用 6 秒 Deadline，失败或超时不得阻塞 Voice。
- SQLite 仍是业务 Source of Truth；NeMo Retriever 是可重建的派生检索层。
- Web 会后任务支持 Direct Model 与 NemoClaw / OpenClaw Agent Runtime；Mac `.env.example` 当前默认 `AI_TASK_RUNTIME=direct`。
- DGX Spark 部署边界是：用户准备并运行标准模型 / 检索 Runtime，本仓库配置并运行应用、接通这些 endpoint。
- **DGX Spark 兼容性、完整端到端和性能仍 NOT TESTED ON DGX SPARK。** 代码、官方 recipe、Mac 验证都不能替代 Spark 真机证据。
- NAT、正式 Skills、Technical Observer 与 Benchmark 是比赛和应用证据的组成部分；只有保存了实际运行结果的报告才是对应场景的验证证据。

## 当前架构

```text
Web / Mobile Web
       |
       v
Life Interview Backend
- Auth / Session / Story / Life Stage / Share / Book
- Validator / Transaction / Idempotency
- SQLite (Source of Truth)
       |
       +-------------------------+
       |                         |
       v                         v
Realtime Voice             Post-session Tasks
       |                         |
Step-Audio-2-mini          onboarding.closeout
(default: StepFun Cloud)   interview.closeout
       |                   interview.context_hint
supervisor_auto            story.completion
       |                   story.generation
Qwen3-8B Coach                  |
       |                         +--> Direct Model (Mac default)
Gate                            |
  +--> Current Story Memory     +--> NemoClaw/OpenClaw Agent Runtime
  +--> Era Context
       |
Coach Packet
       |
response.create
```

StepAudio 3 保留 `voice_tool` 路线，并继续使用现有 Context Hint / Tool Result / Resume 能力；Mini Coach 与该 Agent 路径是两套不同机制，不应混写。

## DGX Spark deployment

Spark 的 Runtime 由操作者准备和维护；本仓库负责应用配置、数据库、Agent Contract / Skills、后端接线和观测。先阅读 [Spark Deployment Reference](docs/04-nvidia/spark/README.md)。

### Prerequisites

- 可登录的 DGX Spark（ARM64 / aarch64），NVIDIA driver 可通过 nvidia-smi 检查，Docker daemon 可用；Runtime 由操作者按官方说明准备。
- Git、Python 3，以及 Node.js / npm。Node 命令统一经 `bash scripts/codex-node.sh` 执行。
- 下表所列服务已在 Spark 上启动，并可从应用进程访问。
- NemoClaw / OpenShell 可完成 NVIDIA 官方 onboarding；模型与服务凭据由操作者安全管理。

| Runtime | 默认 endpoint | 模型 / 边界 |
|---|---|---|
| Text / Agent | `http://127.0.0.1:8000/v1` | `nvidia/Qwen3.6-35B-A3B-NVFP4`；以 `/v1/models` 返回的 served ID 为准 |
| Mini Coach | `http://127.0.0.1:8001/v1` | `Qwen3-8B`；产品低延迟 Realtime Runtime |
| StepAudio contract | `ws://127.0.0.1:8092/realtime` | 外部 Realtime Runtime / bridge 应实现的应用协议 |
| NeMo Retriever | REST / MCP `:7670`；内部 VectorDB `:7671` | 应用只访问 Retriever Service `:7670` |

官方资料：[DGX Spark vLLM agent-ready models](https://build.nvidia.com/spark/vllm/agent-ready-models)、[Qwen3.6-35B-A3B Spark recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10)、[Step-Audio 2](https://github.com/stepfun-ai/Step-Audio2)、[NeMo Retriever](https://docs.nvidia.com/nemo/retriever/latest/extraction/getting-started-about/)。官方 recipe 是 Runtime 准备资料，不是本项目 Spark 验收结果。

### 1. Clone

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA
```

### 2. Prepare runtimes

在仓库之外按官方说明准备并启动 Text、Coach、StepAudio contract 和 Retriever。先确认 Text Runtime 已加载目标模型：

```bash
curl -fsS http://127.0.0.1:8000/v1/models
```

NemoClaw 可复用已经运行的 vLLM：onboard 读取 `localhost:8000/v1/models` 中的模型。选择现有 Local vLLM 路径；不要因为 OpenClaw 再下载或启动一份 Text 模型。

### 3. Configure

```bash
cp deploy/spark/env.example deploy/spark/.env
chmod 600 deploy/spark/.env
```

编辑 `deploy/spark/.env`：将 Text / Coach 模型名设为各自 `/v1/models` 实际返回的 ID，并核对四个 Runtime 地址、`NEMOCLAW_SANDBOX=my-assistant` 与数据库路径。Mac 根目录 `.env.example` 的 StepFun Cloud 默认值保持不变。

### 4. Setup

在四个外部 Runtime 已启动、`deploy/spark/.env` 已配置后运行应用 setup：

```bash
bash deploy/spark/setup.sh
```

setup 会检查 Spark 与外部 Runtime endpoint、安装应用依赖、初始化 / 迁移独立 Spark SQLite、确保 Retriever collections，并安装应用 Agent 配置、Skills 与 policy。缺少 NemoClaw 时，它通过 NVIDIA 官方 [`nemoclaw.sh` installer](https://www.nvidia.com/nemoclaw.sh) 安装 NemoClaw，并运行 `nemoclaw onboard`。当 Text vLLM 已在 `localhost:8000` 运行，onboard 使用 `/v1/models` 发现并复用当前模型，不另起一个 Text 服务。OpenClaw 运行在 `my-assistant` NemoClaw sandbox 内。

`interview-coach` 是正式产品 Skill。其定义可随正式 Skills 同步，但 Mini Coach 的实际 Gate / Retrieval / Resolve 仍由产品低延迟 Realtime Runtime 调用 Qwen3-8B；不经过 OpenClaw。

### 5. Start

```bash
bash deploy/spark/start.sh
```

`setup.sh` ensures that the NemoClaw/OpenClaw sandbox is running and configured.
`start.sh` starts only the Product Backend and Technical Observer. Text, Coach,
StepAudio, and Retriever continue to be provided by user-managed runtimes.

### 6. Verify

在 DGX Spark 上、所有 Runtime 与应用启动后执行：

```bash
set -a
. deploy/spark/.env
set +a
bash deploy/spark/verify.sh
```

报告写入 `runtime/diagnostics/spark/`。只有真机命令实际运行并保存证据后，才可把相应 gate 更新为 PASS。当前 Spark 兼容、完整 E2E、性能均为 **NOT TESTED ON DGX SPARK**。

> `deploy/spark/setup.sh` / `start.sh` 是外部 Runtime 已准备后的应用 setup / start 入口；它们不会代替操作者部署或启动 Text、Coach、StepAudio 与 Retriever 服务。

## 文档入口

1. [当前实现状态](docs/CURRENT_STATE.md)
2. [产品定义](docs/PRODUCT.md)
3. [当前架构](docs/ARCHITECTURE.md)
4. [Realtime / Coach / Retrieval](docs/REALTIME.md)
5. [Agent Runtime](docs/AGENT_RUNTIME.md)
6. [NVIDIA / DGX Spark](docs/NVIDIA.md)
7. [测试与验收](docs/TESTING.md)
8. [完整文档目录](docs/README.md)

比赛评分映射见 [SCORING_ALIGNMENT_v1.0.md](docs/00-competition/SCORING_ALIGNMENT_v1.0.md)。

## 文档治理

旧方案可以保留，但必须满足两条规则：

1. **Current 文档只能描述当前代码真实状态。**
2. 被取代的设计、阶段计划和历史快照进入 `docs/archive/` 或 `docs/07-reports/`，不得继续出现在 Current 推荐阅读路径中。

需要判断“现在系统到底是什么”时，不从版本号最大的旧文档推断，先读 `docs/CURRENT_STATE.md`，再核对代码。
