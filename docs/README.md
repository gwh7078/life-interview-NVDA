# 文档中心

本目录是 life-interview-NVDA 的正式文档入口。

## 文档治理原则

本项目刻意保留技术演进过程：

1. 不删除旧版本；
2. 新方案新建版本文档；
3. README 只指向当前推荐版本；
4. 部署、测试、Benchmark 和失败报告长期保留；
5. 已实现与 Planned / Future 必须清楚区分；
6. 早期快照统一归档到 `archive/`，仅供追溯，不作为当前开发依据。

## 评委推荐阅读路径

1. [比赛评分对照](00-competition/SCORING_ALIGNMENT_v1.0.md)
2. [产品基线](product/life-interview-product-tech-data-v1.5.3.md)
3. [架构演进](02-architecture/ARCHITECTURE_EVOLUTION_v1.0.md)
4. [当前主架构 v2.3](02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md)
5. [Agent Task Contract](03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md)
6. [Agent 执行策略](03-agent/AGENT_EXECUTION_POLICY_v1.0.md)
7. [Skill / Script 映射](03-agent/SKILL_SCRIPT_MAPPING_v1.0.md)
8. [Phase 2B-C 产品 Runtime 与真实 E2E](05-development/phases/PHASE_2B_C_PRODUCT_RUNTIME_INTEGRATION_v1.0.md)
9. [架构决策 ADR](06-decisions/ADR_INDEX_v1.0.md)
10. [NVIDIA Integration](04-nvidia/README.md)
11. [NeMo Agent Toolkit 接入说明](04-nvidia/NEMO_AGENT_TOOLKIT_INTEGRATION_v1.0.md)
12. [工程报告入口](07-reports/README.md)
13. [Phase 3 A+B Integration Gate](07-reports/testing/PHASE3_AB_INTEGRATION_REAL_E2E_REPORT_v1.0.md)
14. [Future Realtime Fast / Slow](08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.6.md)

## 当前状态

### Current

- Architecture v2.3 — 低轮次 Agent 执行策略
- Agent Task Contract v1.0 — Frozen
- Agent Execution Policy v1.2
- Phase 2A Contract Scaffold — Completed
- Phase 2B-C Agent Runtime Integration — Completed / six-path Real Agent E2E 6/6
- Phase 3A NeMo Retriever + Classic Retrieval — **真实 Mac ingest/query、来源追溯与索引状态验收通过**
- Phase 3 A+B Integration Gate — **自动 Gate G0–G8 全部 PASS**；人工真实语音体验验收仍待完成
- 4 个正式 Skill family — 已提交

### Validated Historical Work

- Web 产品完整基线
- Phase 1 NemoClaw / OpenClaw 真实 Smoke
- Scoped Tool API
- Agent Runtime 与 SQLite 隔离
- Architecture v2.2 Contract-First

### Future / Deferred

- Agentic Retrieval、Realtime Slow System 的完整真实验收
- 人工真实语音体验验收
- DGX Spark 最终本地推理与 Benchmark
- 外部世界事实核查

## 当前 Agent 执行原则

```text
固定业务路由
→ Backend 决定

固定任务上下文
→ Backend 预取

非确定性理解 / 判断 / 写作
→ Agent

同一职责内的专项方法
→ Skill

运行中才发现的额外只读信息需求
→ Skill Script（受限 exec）

最终 Proposal
→ Backend Validate / Apply
```

目标不是“最多 Agent / 最多 Tool / 最多脚本调用”，而是：

> **最少调用次数下实现真正必要的 Agent 自主性。**

## 目录

```text
docs/
├── 00-competition/    评分与提交要求对照
├── 02-architecture/   当前架构与演进历史
├── 03-agent/          Agent Contract / Execution Policy / Skills / Eval
├── 04-nvidia/         NVIDIA Runtime / DGX Spark / Retriever
├── 05-development/    分阶段开发计划
├── 06-decisions/      ADR
├── 07-reports/        测试 / 部署 / Benchmark
├── 08-future/         已冻结但延期的未来架构
├── archive/           早期项目快照，仅供历史追溯
├── nvidia-agent-native/  Phase 0/1 历史资料
└── product/           Web 产品与验收基线
```

## 历史资料

原有 `nvidia-agent-native/` 原样保留，包括 BASELINE、API / Schema Inventory、Repository Layout、Feature Matrix、Regression Matrix、Phase 1 Smoke 与 Implementation Report。

产品基线继续保留在 `product/`。

比赛原始要求、DGX Spark 技术资料与来源清单位于仓库根目录 `../资料库/`。

早期项目文档已归档到 `archive/initial-snapshot/`。这些文件记录项目早期产品、数据库、原型和竞品研究状态，**不得作为当前开发、架构或 Agent 行为的规范来源**；当前实现请始终从本 README 的“评委推荐阅读路径”与 Current 文档进入。

文档版本化的目的不是堆数量，而是让每一次技术判断、验证、失败与收敛都可以追溯。
