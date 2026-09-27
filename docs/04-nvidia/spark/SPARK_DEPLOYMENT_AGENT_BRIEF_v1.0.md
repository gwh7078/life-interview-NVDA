# Spark Deployment Agent Brief v1.0

> 适用对象：负责在租用 DGX Spark 前完成部署准备的开发 Agent  
> 当前业务真相源：`docs/CURRENT_STATE.md`、`docs/REALTIME.md`、`docs/NVIDIA.md`  
> 本文只定义 Spark 移植任务，不重新设计产品。

## 1. 最终目标

实现一台接近干净状态的 DGX Spark 从 GitHub 到完整产品的可复现部署：

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA
./deploy/spark/install.sh
./deploy/spark/verify.sh
```

最终本地链路：

```text
Browser
→ Web / Node Backend
→ SQLite
→ Local Realtime Voice
→ Mini Coach
→ NeMo Retriever (Private + Era)
→ NemoClaw / OpenShell / OpenClaw
→ Local Text / Agent Model
→ Closeout / Completion / Generation
→ NAT Eval / Tech Observer
```

比赛最终验收不以 cloud model 成功替代 Spark Local 成功。

## 2. 严格边界

### 禁止顺手重构

除非 Spark 真机接口证明当前抽象有缺陷，否则不要修改：

- Story / Life Stage / Contributor 业务语义；
- SQLite Source of Truth；
- Agent Task Contract；
- Backend = Execution Authority；
- Agent = Proposal / Reasoning Authority；
- Mini Coach 的 2s Gate / 6s total deadline；
- Current Story Memory scope；
- private / Era collection 隔离；
- stale / fail-open 行为；
- 场景划分。

### NAT 不接管 Runtime

NeMo Agent Toolkit 继续用于：

- eval；
- profiler；
- regression；
- observability。

NAT 不替换 NemoClaw/OpenClaw 产品 Runtime，也不接管 Realtime Adapter。

## 3. 必须新增的部署目录

目标：

```text
deploy/spark/
├── README.md
├── env.example
├── preflight.sh
├── install.sh
├── start.sh
├── stop.sh
├── restart.sh
├── status.sh
├── verify.sh
├── docker-compose.yml          # 仅适合容器化的服务
├── lib/
│   ├── common.sh
│   ├── ports.sh
│   └── wait-for.sh
├── models/
│   ├── post-session.sh
│   ├── coach.sh
│   └── realtime.sh
└── services/
    ├── backend.sh
    ├── retriever.sh
    ├── nemoclaw.sh
    └── observer.sh
```

不强制所有组件塞进一个 compose。NemoClaw/OpenShell、host service 与 GPU model service 应按官方推荐方式部署。

## 4. install.sh 设计要求

必须：

- `set -euo pipefail`；
- 可重复运行；
- 已成功步骤应检测并跳过；
- 下载与安装状态可恢复；
- 不在 stdout 打印 token / secret；
- 默认不删除现有数据、镜像、模型缓存；
- 大下载前显示预计对象并允许已有 cache 复用；
- 真机不匹配时 fail fast，并给明确 remediation；
- 生成 machine-readable install report。

建议：

```text
runtime/diagnostics/spark/
├── preflight.json
├── install.json
├── versions.json
└── services.json
```

## 5. preflight.sh 必须检查

至少：

```bash
uname -a
uname -m
cat /etc/os-release
nvidia-smi
docker --version
docker info
python3 --version
node --version
free -h
df -h
lsblk
```

并判断：

- ARM64；
- DGX/GB10 identity（允许 partner system）；
- NVIDIA GPU 可见；
- Docker 可用；
- Docker GPU 可用；
- Python 3.12 availability；
- Node 满足 NemoClaw 当前要求；
- 磁盘足够；
- 必要端口未冲突；
- GitHub / Hugging Face / NGC / npm / PyPI 可访问；
- system clock 正常；
- `HF_TOKEN` / 必要 credentials 是否存在，仅输出 present/missing。

禁止把 Founders Edition 固定版本作为硬性匹配条件。

## 6. Post-session Local Model

第一主测：

```text
nvidia/Qwen3.6-35B-A3B-NVFP4
```

来源必须参考：

- NVIDIA DGX Spark vLLM playbook；
- vLLM Recipes 的当前 GB10 recipe。

目标 endpoint：

```text
http://127.0.0.1:8000/v1
```

现有应用继续通过 OpenAI-compatible Text Runtime 接入。

不要把 model-specific flags 写死在业务代码；放进 Spark deployment config/script。

验收：

- `/health`；
- `/v1/models`；
- chat completion；
- structured output；
- NemoClaw Agent 真实六路径；
- Closeout；
- Completion；
- Generation。

## 7. NemoClaw / OpenShell / OpenClaw

优先复用 NVIDIA 当前官方 NemoClaw Spark installer/playbook。

部署脚本负责：

1. 检测现有 NemoClaw；
2. 安装/验证；
3. 创建或复用目标 sandbox；
4. 配置 local vLLM inference；
5. 安装本项目正式 Skills；
6. 应用 reviewed policies；
7. 运行 Agent runtime smoke。

禁止：

- 为了快速通过而绕过 OpenShell；
- 将整个 repo / DB 无限制 mount 给 Agent；
- 把 secret 写进 repo 或普通日志。

## 8. NeMo Retriever

继续使用现有业务接口：

```text
Retriever Service
→ private Transcript collection
→ public Era Context collection
```

Spark 部署优先使用当前官方 ARM64-compatible service/library 路径。

验收：

- health；
- private ingest；
- private scoped query；
- owner/story isolation；
- Era index；
- Era query；
- 两个 collection 事实空间隔离；
- 现有 Phase 3 / Retriever tests。

## 9. Realtime Voice：最高风险模块

当前 `stepaudio2_mini` 是 StepFun Cloud transport。

Spark 目标不能简单把 cloud URL 改成本地 URL。

必须保持：

```text
Server
→ RealtimeVoiceProvider
→ normalized events
```

新增/实现本地执行边界时，至少应继续向 Server 提供这些语义：

```text
session.ready
session.configured
speech.started
speech.stopped
user.transcript.delta
user.transcript.final
assistant.started
assistant.transcript.delta/final
assistant.audio.started/delta/done
response.done/cancelled
provider.error
```

以及准确 capability：

```text
fullDuplex
supportsInterrupt
supportsToolCalling
supportsContextInjection
supportsExplicitTurnRequest
supportsPlaybackAck
supportsExplicitSessionClose
manualTurnControl
```

### 禁止伪造能力

如果 Spark 上的 Step-Audio2 runtime 没有证实：

- full duplex；
- cancel / barge-in；
- native Tool Calling；
- Tool Result / Resume；
- context injection；

Adapter 必须返回真实 capability，而不是为了复用当前 cloud 逻辑写 `true`。

### 预先开发目标

租机前应完成：

- Local Step-Audio Adapter interface；
- fake/test transport；
- protocol parser contract；
- local audio format conversion boundary；
- launch / health / smoke script；
- offline audio fixture；
- live E2E harness。

真机当天只填真实协议细节与修兼容问题。

## 10. Coach

当前产品真相：

- Mini 使用 supervisor_auto；
- Gate 2s；
- Coach total 6s；
- Story Continue 才允许 Personal Memory / Era Retrieval；
- Onboarding current turn 不阻塞。

Spark 移植先保持业务行为不变，只替换 Coach 模型执行 endpoint 为 local OpenAI-compatible 服务。

不得擅自恢复历史 `Qwen3.5-2B` 方案或改变当前 `qwen3-8b` 决策，除非另有产品决策。

## 11. verify.sh

最终应输出清晰 Gate：

```text
G0 Hardware / ARM64 / CUDA / Docker
G1 Node / Python / repo dependencies
G2 Post-session vLLM
G3 NemoClaw / OpenShell / Skills
G4 NeMo Retriever private
G5 Era Context
G6 Coach
G7 Step-Audio local model load
G8 Audio-to-audio / streaming
G9 Realtime Provider E2E
G10 Web + Backend + DB
G11 Full interview + Closeout
G12 Completion / Continue / Contributor / Generation
G13 NAT smoke/eval
G14 Technical Observer / Spark metrics
```

每个 Gate：

- PASS / FAIL / NOT TESTED；
- duration；
- safe error code；
- evidence file；
- 不输出 secret / raw private transcript。

## 12. Benchmark 提前准备

不能租机当天再写 benchmark。

至少提前提供：

- fixed text Agent dataset；
- Coach route dataset；
- Retriever recall dataset；
- Era dataset；
- 固定短音频；
- 固定长音频；
- 30 min stability fixture / runner；
- 1 / 2 session concurrency runner。

结果写：

```text
runtime/benchmarks/spark/
├── environment.json
├── post-session.json
├── coach.json
├── retriever.json
├── realtime.json
├── concurrency.json
└── summary.md
```

指标至少：

- first-token；
- first-audio；
- P50 / P95；
- Coach timeout rate；
- retrieval P50 / P95；
- schema success；
- long-session stability；
- CPU / system memory / swap；
- GPU utilization（能读取多少记录多少）；
- concurrency degradation。

注意 DGX Spark UMA 下 `nvidia-smi Memory-Usage` 可能不可用，不得伪造显存数据。

## 13. 租机前 Definition of Ready

只有下面都完成才建议开始计费租机：

- `deploy/spark/` 全部文件存在；
- shell syntax / shellcheck 可通过；
- install 可 dry-run；
- idempotency 有测试；
- cloud current path 无回归；
- Local Voice Adapter contract 测试完成；
- all smoke/benchmark input fixtures 已提交；
- credentials checklist 已准备；
- HF model access/license 提前处理；
- 所有大型模型 handle / cache path / image tag 可配置；
- README 已完成 90%，只等真机版本和 benchmark；
- 一日 Runbook 已冻结。
