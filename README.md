# life-interview-NVDA

人生采访局 NVIDIA Agent-Native 比赛版。

> 当前开发阶段：**Phase 3 A+B 自动 Integration Gate 已完成 G0–G8；人工真实语音体验验收待完成**
>
> 当前主架构：**Architecture v2.3 — 低轮次 Agent 执行策略**
>
> 核心原则：固定业务流程由 Backend 决定；固定上下文由 Backend 预取；Agent 只处理需要语义判断的部分；只有运行时才能判断是否需要的额外信息，才通过 Tool 动态获取。

## 项目定位

人生采访局是一款 AI 回忆录记者产品。它通过持续采访、资料整理、长期 Story Memory、完整度评估与成稿，把用户的口述人生经历逐步组织成可阅读、可继续补充、可最终成书的内容。

本仓库是在已有完整 Web 产品基础上，为 NVIDIA DGX Spark Hackathon 演进的 Agent-Native 版本。目标不是把所有后端逻辑改写成 Agent，也不是为了比赛堆叠 Agent，而是在稳定业务系统与 Agent Runtime 之间建立清晰、可测试、低延迟、可替换的边界。

## 当前架构方向

```text
Web / Future Mini Program
          |
          v
Life Interview Backend
  - API / Auth / Session
  - Story / Life Stage / Document
  - ContextBuilder
  - Validator / Transaction / SQLite
          |
          v
AgentTaskPort
          |
          v
NemoClawAgentTaskAdapter
          |
          v
AgentTaskExecutor
          |
          v
NemoClaw / OpenShell
          |
          v
OpenClaw Agent + Skills
          |
          v
Local / Remote Model
```

评测层独立于生产 Runtime：

```text
NeMo Agent Toolkit
  -> Node NAT Bridge
  -> AgentTaskPort
  -> 同一条 NemoClaw / OpenClaw 生产链
  -> Deterministic Evaluation / Workflow Profiling
```

核心原则：

- **Agent = Reasoning Authority**：理解、判断、规划、写作。
- **Backend = Execution Authority**：验证、权限、事务、幂等、最终落库。
- Agent 输出是 **Proposal**，不是数据库 Command。
- SQLite 是业务 **Source of Truth**。
- 固定 Task 路由由 Backend 决定，不额外增加没有业务意义的总控 Agent。
- 固定数据在 Agent 启动前由 Backend 一次性准备，避免无意义 Tool Round Trip。
- Skill 优先于新 Agent；同一职责内的专项判断优先通过 Skill 扩展。
- Tool 只用于 Agent 运行时才能决定是否需要的增量信息。
- 正常任务目标是 **1 次 Agent Run 完成**。
- 复杂任务目标是 **1 次 Agent Run + 少量必要 Tool Call**。
- 最终结果严格结构化；仅在“结果格式失败”时使用强制 JSON / JSON Schema 作为兜底修复。
- Realtime 主链路当前保持低延迟；Future v1.6 优先采用 Step-Audio Tool Calling 触发慢系统，Backend Adapter 负责 HOLD / Deadline / Stale Protection，独立 2B Judge 暂作为 Benchmark / Fallback。
- Retriever / Memory Search 已完成 Phase 3A 真实 ingest/query、限定检索与来源追溯验收。

## 当前 4 个 Agent Task

```text
onboarding.closeout

interview.closeout
  - story_create
  - story_continue
  - contributor

story.completion

story.generation
```

Task Contract：[`docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`](docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md)

Agent 执行策略：[`docs/03-agent/AGENT_EXECUTION_POLICY_v1.0.md`](docs/03-agent/AGENT_EXECUTION_POLICY_v1.0.md)

当前架构：[`docs/02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md`](docs/02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md)

## 开发阶段

| 阶段 | 状态 | 目标 |
|---|---|---|
| Web 产品基线 | 已完成 | 完整产品逻辑与人工测试基线 |
| Phase 1 Agent Runtime Smoke | 已完成 | Node → NemoClaw → OpenClaw → Scoped Tool API 的真实最小闭环 |
| Phase 2A Contract-First Scaffold | 已完成 | 冻结 Task Contract、Context、Output Schema、Port、Stub |
| Phase 2B-C Agent Runtime Integration | **已完成 / 6 路真实 E2E 通过** | 正式 Skills、NemoClaw Adapter、Executor、重试/修复、Tracing、真实 E2E |
| Phase 3A Retriever / Classic Retrieval | **已完成 / 真实 Gate 通过** | SQLite Transcript 异步索引、RetrieverAdapter、条件式 Memory Search、真实 ingest/query 与来源追溯 |
| Phase 3 A+B Integration Gate | **自动验收通过 / G0–G8 PASS** | Realtime Tool/HOLD/Resume、Slow Coordinator、Retriever recall、并发隔离、延迟与最终状态核对 |
| NAT-1 Agent Evaluation Lane | **已完成 / 真实 Smoke 6/6** | NAT Bridge、确定性 Evaluator、Profiler、24 条 Synthetic Regression；Relay / ATIF / Phoenix 后续 |
| Realtime Fast/Slow + Agentic Retrieval | 延期 | Slow System、Agentic Retrieval、时代背景检索 |
| DGX Spark Optimization | 后续 | 本地推理、模型评测、性能优化 |
| Competition Packaging | 后续 | README、部署文档、Demo、Benchmark、视频、征文 |

## 推荐阅读顺序

1. [文档总目录](docs/README.md)
2. [当前主架构 v2.3](docs/02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md)
3. [Agent Task Contract](docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md)
4. [Agent 执行策略](docs/03-agent/AGENT_EXECUTION_POLICY_v1.0.md)
5. [Phase 2B-C 产品 Runtime 与真实 E2E](docs/05-development/phases/PHASE_2B_C_PRODUCT_RUNTIME_INTEGRATION_v1.0.md)
6. [架构决策 ADR](docs/06-decisions/ADR_INDEX_v1.0.md)
7. [未来 Realtime Fast / Slow](docs/08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.6.md)
8. [比赛评分对照](docs/00-competition/SCORING_ALIGNMENT_v1.0.md)
9. [比赛要求原始整理](资料库/DGX_Spark_Hackathon_比赛要求.md)

真实 Agent 验收记录：[`docs/07-reports/testing/PHASE2B_C_REAL_AGENT_E2E_REPORT_v1.0.md`](docs/07-reports/testing/PHASE2B_C_REAL_AGENT_E2E_REPORT_v1.0.md)

NeMo Agent Toolkit 接入说明：[`docs/04-nvidia/NEMO_AGENT_TOOLKIT_INTEGRATION_v1.0.md`](docs/04-nvidia/NEMO_AGENT_TOOLKIT_INTEGRATION_v1.0.md)

Phase 3A 历史本机报告：[`docs/07-reports/testing/PHASE3A_RETRIEVER_CLASSIC_RETRIEVAL_LOCAL_REPORT_v1.0.md`](docs/07-reports/testing/PHASE3A_RETRIEVER_CLASSIC_RETRIEVAL_LOCAL_REPORT_v1.0.md)

Phase 3 A+B 真实 Gate 报告：[`docs/07-reports/testing/PHASE3_AB_INTEGRATION_REAL_E2E_REPORT_v1.0.md`](docs/07-reports/testing/PHASE3_AB_INTEGRATION_REAL_E2E_REPORT_v1.0.md)

## 历史资料

以下资料继续保留，不删除：

- `docs/02-architecture/ARCHITECTURE_v2.2_task-contract-first.md` — Phase 2A Contract-First 架构。
- `docs/nvidia-agent-native/` — Phase 0 / Phase 1 baseline、API / Schema Inventory、Smoke 与 Implementation Report。
- `docs/product/` — Web 产品技术与验收基线。
- `资料库/` — DGX Spark、赛事要求与来源材料。
- `docs/AI开发联调环境.md` — 本地 AI 开发联调环境。
- `docs/realtime-diagnostics.md` — 现有 Realtime 诊断资料。

文档采用版本化演进策略：**旧方案不删除，新方案新增版本并通过索引标记当前推荐版本。**
