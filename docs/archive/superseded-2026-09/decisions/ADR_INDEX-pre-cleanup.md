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

**Historical decision.** 在 Phase 2 阶段，SQLite 始终是 Source of Truth；Retriever 被定义为未来可重建 Derived Index。当前 Phase 3 集成状态由 ADR-025 记录。

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

## ADR-018 — 动态能力只用于运行时增量信息

**Accepted / Refined by ADR-024.** 只有 Agent 推理过程中才发现的额外信息需求才允许动态获取。未来 Memory Search 必须条件触发，不作为每次 Closeout 的固定步骤。

## ADR-019 — Agent 不调用固定 Submit Tool

**Accepted.** Agent 直接返回 Proposal；Backend 自动 Validate / Apply，减少一次无意义 Agent ↔ Tool 往返。

## ADR-020 — Agent Loop 与 Final Schema 分离

**Accepted.** 中间执行允许 Tool Calling；任务完成后最终结果才必须满足业务 Schema 和 `LIFE_INTERVIEW_RESULT` 协议。

## ADR-021 — 强制 JSON 只用于格式失败修复

**Accepted.** 第一轮正常 Agent Run 保留完整 Tool Calling。纯格式错误时才通过模型/API 参数强制 JSON / JSON Schema。Runtime 错误、业务校验错误、信息不足分别采用对应的 Retry / Repair。

## ADR-022 — Retry 由 AgentTaskExecutor 单点管理

**Accepted.** 避免 Backend、OpenClaw、Model 多层重试相乘。初始最多 3 个 attempt，根据错误类型选择 Runtime Retry、Validation Repair 或 Format Repair。


## ADR-023 — 固定 Context 使用 Runtime stdin 预注入

**Accepted.** 固定 Task Context 由 Backend 预取后，Runtime 通过 OpenClaw `--message-file -` / stdin 在 Agent reasoning 前注入。

这不是 Agent Tool Call，不计入 `tool_call_count`，也不要求 Agent 主动执行 `get_task_context`。

原因：

- 符合 ADR-016“固定 Context 由 Backend 预取”；
- 避免把正常任务人为变成 1 次额外 Tool Round Trip；
- 大 Transcript 不进入 CLI 参数和 process listing；
- 保留 OpenClaw Tool Loop 给真正运行时才发现的增量信息需求。


## ADR-024 — 动态只读检索优先使用 Skill 内脚本，而不是专用 Product Tool

**Accepted.** `memory-search`、`memory-deep-search`、`era-context-search` 不再分别向模型暴露专用 Product Tool Schema。

推荐：

```text
Agent
-> Skill
-> scripts/*.mjs
-> restricted generic exec
-> Backend / RetrieverAdapter
-> Evidence
-> same Agent Run
```

理由：

- 减少模型每轮读取 Tool Schema 的 Token；
- 减少模型选择 Tool 与填写基础设施参数的错误；
- scope、token、endpoint、Top-K、rerank 等确定性参数由脚本封装；
- 多个低级检索步骤可以压缩成一次脚本执行；
- Agent 仍保留真正自主性：决定是否搜索、搜索什么、如何解释结果。

边界：

- Skill Script 只做受限只读检索与确定性辅助处理；
- 不允许脚本直接修改 Story、Agent Memory、Completion、Document 或 SQLite；
- 固定 Context 继续由 Backend 预注入，不通过脚本重新读取；
- OpenClaw 底层通用 exec 仍需要 sandbox / allowlist / authorization / audit。

## ADR-025 — Phase 3 A+B 真实 Integration Gate

**Accepted 2026-09-22.** Phase 3 将条件式 Classic Retrieval 接入 Realtime Slow Path：Step-Audio 通过 Tool Call 触发，Backend 负责 HOLD / Resume、scope、超时与结果校验；SQLite 继续保存权威 Transcript，Retriever 只保存可重建的派生索引。

Mac 本机自动 Gate G0–G8 已全部通过，覆盖 Retriever REST / MCP、真实 StepFun 会话、Tool/HOLD/Resume、并发隔离、slow recall 延迟、SQLite Transcript、Retriever index 与 trace 最终状态。Agentic Retrieval 不作为 Realtime 默认路径，人工真实语音体验验收另行完成。
