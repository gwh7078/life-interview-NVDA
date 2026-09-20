# 文档中心

本目录是 life-interview-NVDA 的正式文档入口。

## 文档治理原则

本项目刻意保留技术演进过程。架构发生调整时：

1. 不删除旧版本；
2. 新建带版本号的新文档；
3. 旧文档标记为 Historical / Superseded（后续逐步补充）；
4. README 只指向当前推荐版本；
5. 部署报告、测试报告、Benchmark 作为独立工程证据长期保留。

这样既方便开发 AI 判断“当前应该以哪份文档为准”，也让评审能够看到项目从产品基线、Runtime 验证到 Agent-Native 架构收敛的全过程。

## 当前推荐阅读路径

### 1. 产品基线

- [`product/life-interview-product-tech-data-v1.5.3.md`](product/life-interview-product-tech-data-v1.5.3.md)
- [`product/life-interview-acceptance-test-v1.0.md`](product/life-interview-acceptance-test-v1.0.md)

### 2. 当前主架构

- [`02-architecture/ARCHITECTURE_v2.2_task-contract-first.md`](02-architecture/ARCHITECTURE_v2.2_task-contract-first.md)

**Status: Current**

核心变化：从“Backend 与 Agent Runtime 同步改造”收敛为 **Contract-First**。先把产品侧 Agent 边界做正确，再由 Agent 适配。

### 3. Agent Contract

- [`03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`](03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md)

### 4. 当前开发计划

- [`05-development/phases/PHASE_2A_CONTRACT_FIRST_SCAFFOLD_v1.0.md`](05-development/phases/PHASE_2A_CONTRACT_FIRST_SCAFFOLD_v1.0.md)

### 5. 架构决策

- [`06-decisions/ADR_INDEX_v1.0.md`](06-decisions/ADR_INDEX_v1.0.md)

### 6. Future Architecture

- [`08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`](08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md)
- [`08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md`](08-future/retriever/RETRIEVER_DEFERRED_PLAN_v1.0.md)

## 历史 Agent-Native 资料

原有 [`nvidia-agent-native/`](nvidia-agent-native/) **原样保留**，记录 Phase 0 / Phase 1：

- `BASELINE.md`
- `API_INVENTORY.md`
- `SCHEMA_INVENTORY.md`
- `REPOSITORY_LAYOUT.md`
- `FEATURE_MATRIX.md`
- `REGRESSION_MATRIX.md`
- `PHASE1_SMOKE_CHECKLIST.md`
- `PHASE1_LOCAL_SMOKE_RESULT.md`
- `PHASE1_IMPLEMENTATION_REPORT.md`

这些文档是架构演进证据，不因 v2.2 出现而删除。

## 比赛与技术资料

比赛原始要求、DGX Spark 技术资料与来源清单继续放在仓库根目录的 [`../资料库/`](../资料库/)。

其中当前比赛要求：

- [`../资料库/DGX_Spark_Hackathon_比赛要求.md`](../资料库/DGX_Spark_Hackathon_比赛要求.md)

后续文档持续保留：

- 架构版本演进；
- Agent Skill 设计；
- 模型评测；
- Runtime 测试；
- 部署与性能报告；
- 失败案例与修复；
- DGX Spark 优化结果。
