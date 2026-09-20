# DGX Spark Hackathon Scoring Alignment v1.0

> Status: Working competition map
>
> Source requirement: `资料库/DGX_Spark_Hackathon_比赛要求.md`

本文件不是新的比赛规则，而是把仓库已有工作与评分项对应起来，方便后续开发和最终提交时检查证据缺口。

## 1. 项目实用性、行业落地价值与技术创新性 — 25%

当前可展示：

- 已有完整 Web 产品基线，而不是从零开始的比赛 Demo；
- 面向真实回忆录采访场景；
- Story / Life Stage / Contributor / Book 完整领域模型；
- Evidence-aware Story Agent Memory；
- Agent Reasoning 与 Backend Execution 分权；
- Contract-First Agentization；
- Architecture v2.3 低轮次 Agent 执行策略；
- Future Realtime Fast / Slow 双系统。

差异化重点：

> 不把“更多 Agent / 更多 Tool Call”当成智能程度，而是把自主性放在真正需要语义判断和动态补信息的地方。

主要证据：

- `docs/product/life-interview-product-tech-data-v1.5.3.md`
- `docs/02-architecture/ARCHITECTURE_v2.3_agent-execution-efficiency.md`
- `docs/03-agent/AGENT_EXECUTION_POLICY_v1.0.md`
- `docs/06-decisions/ADR_INDEX_v1.0.md`

## 2. 智能体与模型优化技术深度 — 25%

当前已完成：

- NemoClaw / OpenClaw 真实最小 Smoke；
- Scoped Tool API；
- Agent Runtime 与业务数据库隔离；
- 4 个 Agent Task Contract；
- 4 个正式 Skill family；
- NemoClawAgentTaskAdapter；
- Task → Skill / Model Profile 确定性路由；
- Agent / Skill / Tool 职责分层；
- 低轮次执行策略已经冻结。

后续需要补齐：

- 正式 AgentTaskExecutor；
- 真实 4 Task Agent E2E；
- Retry / Validation Repair / Format Repair；
- Model Router；
- Agent Eval；
- Schema success / first-pass success / evidence accuracy / latency / tool-call-rate benchmark；
- Future 条件式 Memory Search；
- Future Realtime Slow Agent；
- 如确有价值，再展示目标不同的多 Agent 协作，而不是为了数量拆 Agent。

比赛展示可以强调：

```text
正常任务
→ 1 Agent Run
→ 0 Tool Call

遇到运行时历史疑点
→ 同一个 Agent 自主决定 Tool Call
→ 获得最小额外 Context
→ 继续完成
```

这比固定每轮检索或多 Agent 转发更能体现“有边界的自主决策”。

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
- 产品验收测试基线；
- Agent Contract；
- 正式 Skills；
- Phase 2B Adapter boundary。

当前缺口主要是正式 Agent Runtime E2E 与稳定性收敛。

## 4. 平台适配性 — 15%

当前：

- NemoClaw / OpenShell / OpenClaw 已进入 Runtime 方案；
- Mac 开发环境已验证真实 Sandbox Smoke。

后续：

- DGX Spark 本地推理；
- NVIDIA 模型或 NVIDIA 推理能力；
- StepFun 模型正式接入与评测；
- NeMo Retriever 后续条件式集成；
- 本地 Agent 部署说明；
- 性能与资源 Benchmark。

未实现内容必须明确标记 Planned / Future。

## 5. 演示效果 — 10%

最终 Demo 建议展示：

1. 一次完整采访；
2. Closeout 后 Summary / Agent Memory 更新；
3. Completion gaps；
4. Story Generation；
5. Agent Runtime / Skill / Model tracing；
6. 一次正常“1 Run 0 Tool”的高效路径；
7. 如 Memory Search 已实现，再展示一次“发现疑点 → 自主 Search → 继续”的复杂路径；
8. DGX Spark 本地运行证据。

## 6. 赛事征文 — 5%

持续保留：

- 架构版本；
- 失败与修复；
- Phase 1 Smoke；
- Contract-First 调整原因；
- 从“多 Agent”收敛到“低轮次有边界自主性”的设计过程；
- Mac → DGX Spark；
- 模型 Benchmark。

这些资料可直接转化为“一日谈”开发历程。

## 7. 提交前检查

- [ ] GitHub README 500 字以上项目说明完整
- [ ] 部署说明完整
- [ ] NVIDIA 技术栈说明完整
- [ ] StepFun 使用有真实代码或 Benchmark 证据
- [x] Skill Markdown 文件齐全
- [ ] 正式 Agent 4 Task E2E
- [ ] Retry / Repair / Format Repair 测试
- [ ] DGX Spark 本地运行步骤可复现
- [ ] Agent Eval / Benchmark 有报告
- [ ] Demo 视频链接
- [ ] 技术文章链接
- [ ] 团队资料
