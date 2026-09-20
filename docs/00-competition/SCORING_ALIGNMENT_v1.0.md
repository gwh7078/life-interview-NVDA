# DGX Spark Hackathon Scoring Alignment v1.0

> Status: Working competition map
>
> Source requirement: `资料库/DGX_Spark_Hackathon_比赛要求.md`

本文件不是新的比赛规则，而是把仓库已有工作与评分项对应起来，方便后续开发和最终提交时检查是否存在证据缺口。

## 1. 项目实用性、行业落地价值与技术创新性 — 25%

当前可展示：

- 已有完整 Web 产品基线，而不是从零开始的比赛 Demo；
- 面向真实回忆录采访场景；
- Story / Life Stage / Contributor / Book 的完整领域模型；
- Evidence-aware Story Agent Memory；
- Agent Reasoning 与 Backend Execution 分权；
- Contract-First Agentization；
- Future Realtime Fast / Slow 双系统。

主要证据：

- `docs/product/life-interview-product-tech-data-v1.5.3.md`
- `docs/02-architecture/ARCHITECTURE_v2.2_task-contract-first.md`
- `docs/06-decisions/ADR_INDEX_v1.0.md`
- `docs/08-future/realtime/REALTIME_FAST_SLOW_ARCHITECTURE_v1.0.md`

## 2. 智能体与模型优化技术深度 — 25%

当前已完成：

- NemoClaw / OpenClaw 真实最小 Smoke；
- Scoped Tool API；
- Agent Runtime 与业务数据库隔离；
- 4 个 Agent Task 的 Contract 设计；
- Agent Skills 分工已冻结。

后续需要补齐：

- 4 个正式 Skills；
- Model Router；
- Agent Eval；
- Retry / Repair；
- Schema success / evidence accuracy / latency benchmark；
- 多 Agent / 多 Task 协作演示。

主要证据：

- `docs/nvidia-agent-native/PHASE1_LOCAL_SMOKE_RESULT.md`
- `docs/nvidia-agent-native/PHASE1_IMPLEMENTATION_REPORT.md`
- `docs/03-agent/contracts/AGENT_TASK_CONTRACTS_v1.0.md`

## 3. 项目完整性 — 20%

已有：

- 前端；
- 后端；
- SQLite；
- Session / Story / Life Stage / Document；
- Realtime；
- Closeout；
- Completion；
- Contributor；
- Story Generation；
- 产品验收测试基线。

当前 Agent-Native 版本仍处于迁移期，Phase 2A 只做 Contract Scaffold，最终必须在 Phase 2C 做完整 Product + Agent E2E。

主要证据：

- `docs/product/`
- `docs/05-development/phases/PHASE_2A_CONTRACT_FIRST_SCAFFOLD_v1.0.md`
- 后续 `docs/07-reports/` 测试报告。

## 4. 平台适配性 — 15%

当前：

- NemoClaw / OpenShell / OpenClaw 已进入 Runtime 方案；
- Mac 开发环境已验证真实 Sandbox Smoke。

后续：

- DGX Spark 本地推理；
- NVIDIA 模型或 NVIDIA 推理能力；
- StepFun 模型正式接入与评测；
- NeMo Retriever 后续可选集成；
- 本地 Agent 部署说明。

注意：未实现的内容在 README / Demo 中必须明确标记 Planned / Future，不能写成已完成。

## 5. 演示效果 — 10%

最终 Demo 建议展示：

1. 一次完整采访；
2. Closeout 后 Summary / Agent Memory 更新；
3. Completion gaps；
4. Story Generation；
5. Agent Runtime / Skill / Model tracing；
6. DGX Spark 本地运行证据。

当前 Phase 2A 不以 Demo 为目标。

## 6. 赛事征文 — 5%

持续保留：

- 架构版本；
- 失败与修复；
- Phase 1 Smoke；
- Contract-First 调整原因；
- Mac → DGX Spark；
- 模型 Benchmark。

这些资料后续可直接转化为“一日谈”开发历程。

## 7. 提交前检查

- [ ] GitHub README 500 字以上项目说明完整
- [ ] 部署说明完整
- [ ] NVIDIA 技术栈说明完整
- [ ] StepFun 使用有真实代码或 Benchmark 证据
- [ ] Skill Markdown 文件齐全
- [ ] DGX Spark 本地运行步骤可复现
- [ ] Agent Eval / Benchmark 有报告
- [ ] Demo 视频链接
- [ ] 技术文章链接
- [ ] 团队资料
