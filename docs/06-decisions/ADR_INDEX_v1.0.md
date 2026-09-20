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

**Accepted.** 同时变化 Product、Runtime、Skill、Model、NVIDIA 环境会让故障定位变困难，因此调整为 Phase 2A Backend Contract + Stub，Phase 2B Agent Runtime 适配。

## ADR-004 — Phase 2A 不重新接 Legacy Model 完整闭环

**Accepted.** 已有 Web 产品已经完成完整功能验证。Phase 2A 只证明接口设计正确。

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

**Accepted.** Realtime 主链路继续追求低延迟。未来采用 Fast System + Parallel Slow System。

## ADR-010 — NeMo Retriever 产品集成延期

**Accepted.** SQLite 始终是 Source of Truth；Retriever 是未来可重建 Derived Index。

## ADR-011 — 历史文档不删除

**Accepted.** 新方案创建新版本，旧方案保留为架构演进、测试与比赛开发历程证据。

## ADR-012 — 正式 Agent 模式不隐式 fallback

**Accepted.** Agent 模式失败时明确重试或失败，不偷偷回落到 Direct Legacy Model。

## ADR-013 — Task 决定 Skill，Runtime 决定 Model

**Accepted.** Skill 是专业工作方法，Model 是可替换推理资源。

## ADR-014 — At-least-once Reasoning + Exactly-once Apply

**Accepted.** Agent Reasoning 可以重试，但 Domain Apply 必须通过 attempt ownership、resource version、idempotency 与 transaction 防止重复提交。
