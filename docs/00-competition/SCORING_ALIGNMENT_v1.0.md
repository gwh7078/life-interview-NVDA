# DGX Spark Hackathon Scoring Alignment

> Current working map — 2026-09-27  
> 比赛原始要求：`资料库/DGX_Spark_Hackathon_比赛要求.md`  
> 当前实现依据：[CURRENT_STATE.md](../CURRENT_STATE.md)

本文件只做“当前能力 → 评分项”的映射，不把 Planned 写成 Implemented。

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

- Agent Task Contract；
- NemoClaw / OpenClaw Adapter；
- onboarding / closeout / context_hint / completion / generation Task；
- 5 个正式产品 Skill family；
- Direct / Agent 双 Runtime；
- Qwen3-8B Mini Realtime Coach；
- Gate 2s + 全链 6s Deadline；
- Memory / Era 双路独立触发与并行 Retrieval；
- bounded evidence / stale protection / fail-open；
- NeMo Agent Toolkit eval / profiler / regression；
- Realtime 技术观测。

应重点证明“为什么这样拆”以及真实延迟/质量收益，不以 Agent 数量作为深度。

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
- Retriever；
- Era Context；
- Agent Runtime；
- NAT；
- Technical Observer。

当前主要缺口是 **真实语音体验收敛 + DGX Spark 实机 + 最终比赛包装**，不是继续扩产品功能。

## 4. 平台适配性 — 15%

当前：

- Mac 已运行 NemoClaw / OpenClaw；
- Mac 已运行 NeMo Retriever；
- NAT 已有 smoke / eval / profiler；
- Step-Audio-2-mini 仍为 StepFun Cloud；
- 文本 Agent 当前仍为 Bailian Cloud。

尚未完成：

- DGX Spark 实机部署；
- Mini 本地执行后端；
- Agent 文本模型本地执行；
- Spark 上 Retriever / Voice / Agent 并发验证；
- 可复现 Spark 部署文档。

因此比赛材料不能把“目标 Spark 架构”写成“已完成 Spark 实测”。

## 5. 模型优化与 Benchmark — 25% 中的关键证据

最低成本但有效的加分路径：

1. Mini Cloud Baseline vs Spark Local Mini；
2. 有 Coach vs 无 Coach；
3. Memory Retrieval on/off；
4. Era Context on/off；
5. 指标记录：首字/首音、总 Coach latency、触发率、Evidence 命中/采用、超时率；
6. 固定访谈 Benchmark，评价重复提问、跑题、上下文遗忘、历史冲突和时代背景追问质量。

不要用合成单测代替真实模型 Benchmark。

## 6. 当前禁止夸大的能力

提交材料不要写：

- “已完成 DGX Spark 本地部署”；
- “Era Context 默认生产启用”；
- “Provider 侧打断完全通过”；
- “所有 Realtime 都走 Agent”；
- “NAT 编排产品 Runtime”；
- “Retriever 是事实源”；
- “所有 Agent Task 已成为 Web 默认 Runtime”。

这些结论只有在后续真实验收后才能升级。
