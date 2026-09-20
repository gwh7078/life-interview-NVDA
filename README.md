# life-interview-NVDA

人生采访局 NVIDIA Agent-Native 比赛版。

> 当前开发阶段：**Phase 2A — Contract-First Scaffold**
>
> 当前原则：先冻结 Web / Backend 与 Agent 的任务边界，再让 NemoClaw / OpenClaw 适配；Realtime Agent 化与 NeMo Retriever 产品集成暂缓到后续版本。

## 项目定位

人生采访局是一款 AI 回忆录记者产品。它通过持续采访、资料整理、长期 Story Memory、完整度评估与成稿，把用户的口述人生经历逐步组织成可阅读、可继续补充、可最终成书的内容。

本仓库是在已有完整 Web 产品基础上，为 NVIDIA DGX Spark Hackathon 演进的 Agent-Native 版本。目标不是把所有后端逻辑改写成 Agent，而是在稳定的产品系统与 Agent Runtime 之间建立清晰、可测试、可替换的边界。

## 当前架构方向

```text
Web / Future Mini Program
          |
          v
Life Interview Backend
  - API / Auth / Session
  - Story / Life Stage / Document
  - Validator / Transaction / SQLite
          |
          v
Context Builder
          |
          v
AgentTaskPort
     |             |
     | Phase 2A    | Phase 2B
     v             v
 Stub Adapter   NemoClaw Agent Adapter
                    |
                    v
                NemoClaw
                OpenShell
                OpenClaw
                Skills
                    |
                    v
             Local / Remote Model
```

核心原则：

- **Agent = Reasoning Authority**：理解、判断、规划、写作。
- **Backend = Execution Authority**：验证、权限、事务、幂等、最终落库。
- Agent 输出是 **Proposal**，不是数据库 Command。
- SQLite 是业务 **Source of Truth**。
- Realtime 当前保持低延迟直接链路，不把复杂 Agent 放进实时主链路。
- Retriever / Memory Search 作为后续能力引入。

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

详细 Contract：[`docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`](docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md)

## 开发阶段

| 阶段 | 状态 | 目标 |
|---|---|---|
| Web 产品基线 | 已完成 | 完整产品逻辑与人工测试基线 |
| Phase 1 Agent Runtime Smoke | 已完成 | Node → NemoClaw → OpenClaw → Scoped Tool API 的真实最小闭环 |
| Phase 2A Contract-First Scaffold | **当前** | 冻结 Task Contract、Context、Output Schema、Port、Stub |
| Phase 2B Agent Runtime Integration | 后续 | 4 个 Skills、NemoClaw Adapter、Model Router、Agent Eval |
| Realtime Fast/Slow + Retriever | 延期 | Slow System、Memory Search、NeMo Retriever |
| DGX Spark Optimization | 后续 | 本地推理、模型评测、性能优化 |
| Competition Packaging | 后续 | README、部署文档、Demo、Benchmark、视频、征文 |

## 推荐阅读顺序

1. **文档总目录** — [`docs/README.md`](docs/README.md)
2. **当前主架构 v2.2** — [`docs/02-architecture/ARCHITECTURE_v2.2_task-contract-first.md`](docs/02-architecture/ARCHITECTURE_v2.2_task-contract-first.md)
3. **Agent Task Contract** — [`docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`](docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md)
4. **Phase 2A 开发计划** — [`docs/05-development/phases/PHASE_2A_CONTRACT_FIRST_SCAFFOLD_v1.0.md`](docs/05-development/phases/PHASE_2A_CONTRACT_FIRST_SCAFFOLD_v1.0.md)
5. **架构决策 ADR** — [`docs/06-decisions/ADR_INDEX_v1.0.md`](docs/06-decisions/ADR_INDEX_v1.0.md)
6. **未来 Realtime Fast / Slow** — [`docs/08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`](docs/08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md)
7. **比赛要求原始整理** — [`资料库/DGX_Spark_Hackathon_比赛要求.md`](资料库/DGX_Spark_Hackathon_比赛要求.md)

## 已有历史资料

以下历史资料继续保留，不删除：

- [`docs/nvidia-agent-native/`](docs/nvidia-agent-native/) — Phase 0 / Phase 1 的 baseline、API inventory、schema inventory、smoke test 与 implementation report。
- [`docs/product/`](docs/product/) — 当前 Web 产品技术与验收基线。
- [`资料库/`](资料库/) — DGX Spark、赛事要求与来源材料。
- [`docs/AI开发联调环境.md`](docs/AI开发联调环境.md) — 本地 AI 开发联调环境。
- [`docs/realtime-diagnostics.md`](docs/realtime-diagnostics.md) — 现有 Realtime 诊断资料。

文档采用版本化演进策略：**旧方案不删除，新方案新增版本并通过索引标记当前推荐版本。**
