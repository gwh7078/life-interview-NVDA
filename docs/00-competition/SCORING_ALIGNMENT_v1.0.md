# DGX Spark Hackathon Scoring Alignment

> Current working map — 2026-09-28
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

Era Context **已实现并接线**，但默认模板仍关闭 `NEMO_ERA_CONTEXT_ENABLED`；比赛演示前需确认索引启用与真实效果。

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

Spark 目标为操作者准备标准 Text、Coach、StepAudio 与 Retriever Runtime，本仓库配置应用并接线。应重点证明“为什么这样拆”以及真实延迟 / 质量收益，不以 Agent 数量作为深度。

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
- Retriever Service：`127.0.0.1:7670`；内部 VectorDB：`127.0.0.1:7671`，业务后端不直接访问。

DGX Spark Runtime compatibility、完整应用 E2E、StepAudio WebSocket / 双工体验和性能 **均 NOT TESTED ON DGX SPARK**。官方部署 recipe 只证明存在外部操作参考，不证明本项目真机成功。

## 5. 模型优化与 Benchmark — 25% 中的关键证据

Spark 真机可复现后，按固定语料比较并归档：

1. Mini Cloud Baseline 与 Spark Local Runtime；
2. 有 Coach 与无 Coach；
3. Memory Retrieval on / off；
4. Era Context on / off；
5. 首字 / 首音、Coach latency、触发率、Evidence 命中 / 采用、超时率、P50 / P95；
6. 固定访谈 Benchmark：重复提问、跑题、上下文遗忘、历史冲突与时代背景追问质量。

NAT 负责 Agent Evaluation / Profiler / Regression；Technical Observer 记录实际运行状态；Benchmark 报告给出可复现的质量与性能对照；Skills 展示各 Task 的职责和证据边界。这些是比赛和应用证据框架，不是尚未运行的 Spark gate 的 PASS。

## 6. 当前禁止夸大的能力

提交材料不要写：

- “已完成 DGX Spark 本地部署 / 兼容性验证”；
- “Step-Audio-2-mini 已在 Spark 稳定全双工运行”；
- “Spark 已有 P50 / P95 或并发性能结果”；
- “所有 Realtime 都走 OpenClaw / Agent”；
- “NAT 编排产品 Runtime”；
- “Retriever 是事实源”；
- “所有 Agent Task 已成为 Web 默认 Runtime”。

在 DGX Spark 真机日志、E2E 和 Benchmark 报告产生之前，Spark 兼容、完整 E2E 和性能状态一律写 **NOT TESTED ON DGX SPARK**。
