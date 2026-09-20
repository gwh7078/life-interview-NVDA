# Architecture Decision Records v1.0

> Status: Current decision index

## ADR-001 — Backend 不整体 Agent 化

**Accepted.** 保留 API、Auth、Session、Repository、SQLite、事务、幂等、权限等确定性系统；只将理解、判断、规划、写作 Agent 化。

## ADR-002 — Agent 输出 Proposal，不直接修改数据库

**Accepted.**

```text
Agent -> Proposal -> Validator -> Backend Apply -> SQLite
```

Reasoning Authority 与 Execution Authority 分离。

## ADR-003 — Contract-First 替代同步开发

**Accepted.** Phase 2A 冻结 Backend Contract，Phase 2B 让 Agent Runtime 适配。

## ADR-004 — Phase 2A 不重新接 Legacy Model 完整闭环

**Accepted.** Phase 2A 只证明接口设计正确。

## ADR-005 — Closeout 统一为 interview.closeout

**Accepted.** 三个 mode：story_create、story_continue、contributor。onboarding.closeout 独立。

## ADR-006 — Story Agent Memory 是长期工作记忆

**Accepted.**

```text
Old Agent Memory + Current Transcript -> Updated Memory
```

续访不重复读取全部历史 Transcript。

## ADR-007 — Story Generation 回到原始 Transcript

**Accepted.** Memory 服务工作上下文，不作为最终文章最高事实证据。

## ADR-008 — Contributor Evidence 与主人公事实隔离

**Accepted.** Contributor Summary 不自动进入 Story Summary、Agent Memory、Completion 或 Story Generation。

## ADR-009 — Realtime 当前不 Agent 化

**Accepted.** Realtime 主链路继续追求低延迟。未来采用 Fast System + Parallel Slow Agent。

## ADR-010 — NeMo Retriever 产品集成延期

**Accepted.** SQLite 始终是 Source of Truth；Retriever 是未来可重建 Derived Index。

## ADR-011 — 历史文档不删除

**Accepted.** 新方案创建新版本，旧方案保留为架构演进、测试与比赛开发历程证据。

## ADR-012 — 正式 Agent 模式不隐式 fallback

**Accepted.** Agent 模式失败时明确重试或失败，不偷偷回落到 Direct Legacy Model。

## ADR-013 — Task 决定 Skill，Runtime 决定 Model

**Accepted.** Skill 是专业工作方法，Model 是可替换推理资源。

## ADR-014 — At-least-once Reasoning + Exactly-once Apply

**Accepted.** Reasoning 可以重试；Apply 必须通过 attempt ownership、resource version、idempotency 与 transaction 防止重复提交。

## ADR-015 — 不增加无业务意义的总控 Agent

**Accepted.** 已知的 Task 路由继续由 Backend / TaskDefinitionRegistry 决定，不额外花一次模型调用判断固定流程。

## ADR-016 — 固定 Context 由 Backend 预取

**Accepted.** Agent 启动前已经确定需要的数据由 ContextBuilder 一次准备。Tool 不承担固定上下文搬运。

## ADR-017 — Skill 优先于新 Agent

**Accepted.** Story Discovery、Memory Reconcile 等同一职责内的专项判断优先做辅助 Skill。只有角色目标、上下文、模型或评测体系明显不同才拆 Agent。

## ADR-018 — Tool 只用于运行时增量信息

**Accepted.** Tool 用于 Agent 推理过程中才发现的额外信息需求。未来 Memory Search 必须条件触发，不作为每次 Closeout 的固定步骤。

## ADR-019 — Agent 不调用固定 Submit Tool

**Accepted.** Agent 直接返回 Proposal；Backend 自动 Validate / Apply，减少一次无意义 Agent ↔ Tool 往返。

## ADR-020 — Agent Loop 与 Final Schema 分离

**Accepted.** 中间执行允许 Tool Calling；任务完成后最终结果才必须满足业务 Schema 和 `LIFE_INTERVIEW_RESULT` 协议。

## ADR-021 — 强制 JSON 只用于格式失败修复

**Accepted.** 第一轮正常 Agent Run 保留完整 Tool Calling。纯格式错误时才通过模型/API 参数强制 JSON / JSON Schema。Runtime 错误、业务校验错误、信息不足分别采用对应的 Retry / Repair。

## ADR-022 — Retry 由 AgentTaskExecutor 单点管理

**Accepted.** 避免 Backend、OpenClaw、Model 多层重试相乘。初始最多 3 个 attempt，根据错误类型选择 Runtime Retry、Validation Repair 或 Format Repair。
