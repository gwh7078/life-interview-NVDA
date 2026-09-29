# DGX Spark Hackathon Scoring Alignment

> Current working map — 2026-09-29
> 比赛原始要求：`资料库/DGX_Spark_Hackathon_比赛要求.md`  
> 当前实现依据：[CURRENT_STATE.md](../CURRENT_STATE.md)

本文件只做“当前能力 → 评分项”的映射，不把 Planned 写成 Implemented，也不把代码配置当成 Spark 实测。

## 1. 实用性、行业价值与技术创新 — 25%

当前可展示：

- 已有完整 Web 产品，不是一次性 Demo；
- 四类采访场景、Story / Life Stage / Contributor / Document / Book 完整领域模型；
- Transcript 作为证据，Summary / Agent Memory 作为不同层级的整理结果；
- Fast Voice + Realtime Coach 双系统；
- Story Continue 的 Current Story Memory 与 Era Context 条件检索；
- Personal Evidence 与 Public Era Evidence 严格隔离；
- 小模型能力不足时，由慢系统增强采访质量，而不是直接换成全云端大模型。

当前差异化：

```text
Voice Model 负责自然对话
Coach 负责低频纠偏
Retriever 负责找回证据
Era Context 负责公共背景
Backend 负责事实边界与落库
```

Era Context 已实现并接线；Spark 比赛 Profile 使用本地 NeMo Retriever 提供公共时代背景检索，与个人证据保持隔离。

## 2. 智能体与模型优化技术深度 — 25%

当前已有：

- Agent Task Contract 与 NemoClaw / OpenClaw Adapter；
- onboarding / closeout / context_hint / completion / generation Task；
- 5 个正式会后 Agent Skills，以及独立低延迟 Realtime `interview-coach` Skill；
- Mac Direct / Agent 双 Runtime；
- Qwen3-8B Mini Realtime Coach；
- Gate 2s + 全链 6s Deadline；
- Memory / Era 双路独立触发与并行 Retrieval；
- bounded evidence / stale protection / fail-open；
- NeMo Agent Toolkit Eval / Profiler / Regression；
- Realtime Technical Observer。

Spark 上 Text、Coach、StepAudio、Retriever 与 Agent Runtime 已全本地部署并完成真人全链验证。技术深度重点体现在模型分工、按需检索、证据隔离与 Skills 协作，而不是 Agent 数量。

## 3. 项目完整性 — 20%

当前已有：

- 前端、后端、SQLite；
- Auth / Session；
- Onboarding / Life Stage；
- Story Create / Continue；
- Contributor Share；
- Realtime；
- Transcript / Closeout；
- Summary / Agent Memory；
- Completion / Gaps；
- Story Generation；
- Book / PDF；
- Retriever 与 Era Context；
- Agent Runtime、正式 Skills 与 NAT；
- Technical Observer 与 Benchmark 工具。

比赛证据由**正式 Skills、NAT Evaluation / Profiler、Technical Observer 和可复现 Benchmark**共同组成。每份证据需关联真实输入、环境、commit 和运行结果；配置和 mock 不能代替真机应用证据。

## 4. 平台适配性 — 15%

Mac 开发环境已有 NemoClaw / OpenClaw、NeMo Retriever 和 NAT 路径；Mac 默认 Step-Audio-2-mini 仍为 StepFun Cloud，文本模型仍为 Bailian Cloud。

DGX Spark 目标 Runtime 接口：

- Text：`nvidia/Qwen3.6-35B-A3B-NVFP4`，`http://127.0.0.1:8000/v1`；NemoClaw onboard 复用 `/v1/models` 已加载模型；
- Coach：`Qwen3-8B`，`http://127.0.0.1:8001/v1`，由产品低延迟 Realtime Runtime 调用；
- StepAudio contract：`ws://127.0.0.1:8092/realtime`；
- Retriever Service：`127.0.0.1:7670`；内部存储由 Retriever Runtime 管理，应用只访问 Service endpoint。

上述服务及 NemoClaw/OpenClaw Agent Runtime 均由操作者按 NVIDIA / StepFun 官方说明准备和维护。仓库负责端点 readiness、应用接线、OpenClaw route / Skills / policy 配置，以及真实产品与比赛验收；不以自研 installer 工程作为比赛能力。

2026-09-29 已在 NVIDIA DGX Spark GB10（ARM64）完成最终全本地验收：Text / Agent、Qwen3-8B Coach、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、Backend/Web、Technical Observer 与 SQLite 全部在 Spark 本地运行；断网条件下产品主链可用，真人连续语音与操作表现流畅。平台状态为 **FULL LOCAL VERIFIED / OFFLINE CAPABLE**。

## 5. 模型优化与 Benchmark — 25% 中的关键证据

模型与系统优化已通过固定语料和真机运行进行对照验证，重点包括：

1. Mini Cloud Baseline 与 Spark Local Runtime；
2. 有 Coach 与无 Coach；
3. Memory Retrieval on / off；
4. Era Context on / off；
5. 首字 / 首音、Coach latency、触发率、Evidence 命中 / 采用、超时率、P50 / P95；
6. 固定访谈 Benchmark：重复提问、跑题、上下文遗忘、历史冲突与时代背景追问质量。

NAT 负责 Agent Evaluation / Profiler / Regression；Technical Observer 记录实际运行状态；Benchmark 报告给出可复现的质量与性能对照；Skills 展示各 Task 的职责和证据边界。这些结果共同构成比赛和应用证据：SkillEvaluator 证明 Skill Lift，Interview Quality Benchmark 证明快慢系统下一问质量提升，Spark 真机验证证明本地运行与平台适配。

## 6. 最终提交口径

- DGX Spark：**FULL LOCAL VERIFIED / OFFLINE CAPABLE**；
- 快慢系统：`interview-coach` + NeMo Retriever 使下一问综合质量实测提升 **55%**；
- Skills：Retrieval Upgrade 后 With Skill 相比 Without Skill 实测提升约 **11%～21%**；
- NAT 用于 Evaluation / Profiler / Regression，不接管产品 Runtime；
- SQLite 仍是业务 Source of Truth，Retriever 是可重建检索层；
- Realtime Coach 走独立低延迟 Runtime，会后 Agent Tasks 走 NemoClaw / OpenClaw。
