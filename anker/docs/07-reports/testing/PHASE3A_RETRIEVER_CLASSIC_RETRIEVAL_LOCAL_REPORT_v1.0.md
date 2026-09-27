# Phase 3A Retriever / Classic Retrieval Local Report

## 状态

本报告记录 A 线在 Mac 本机完成的 Phase 3A 产品接入代码与确定性验证。

当前状态：**代码与本地确定性验证通过；真实 NeMo Retriever ingest/query 验收待服务恢复。**

## 已实现链路

```text
SQLite interview_sessions
  → retriever_index_jobs
  → RetrieverAdapter / NeMo Retriever REST
  → scoped Evidence Search
  → interview-closeout / story_continue
  → memory-search.mjs（按需、只读）
```

- SQLite Transcript 仍是事实源；Retriever 只保存可重建的派生索引。
- Session 结束后异步索引，不阻塞 Transcript 保存和结果页。
- `accepted/processing` 保持 `indexing`，状态刷新确认完成后才变为 `indexed`。
- 失败进入 `failed`，可显式重试；重试使用已保存的远端引用删除旧文档后重建。
- `memory-search` 只授权给 `interview.closeout / story_continue`，并由短期签名 token 绑定用户和 Story。
- Evidence 在 Backend 二次校验 owner、Story、`source_type=subject` 后才返回给 Skill Script；返回给 Agent 的结果不含授权字段。
- 未修改 `src/realtime/*`，不接入 Realtime Slow System、Agentic Retrieval 或 4175 Tool Server。

## 本机验证

- `npm install`：通过。
- `npm run typecheck`：通过。
- `npm test`：通过（全量确定性测试）。
- `bash scripts/check-ai-env.sh`：失败。OpenClaw sandbox forward 与 Codex MCP 注册正常；NeMo Retriever 和 VectorDB 当前返回 HTTP 503。
- 直连 `127.0.0.1:7670/7671`：当前无监听服务。

## 尚未完成的真实验收

Retriever 服务恢复后，仍需执行：

1. `/v1/health`、ingest job、multipart document、状态查询、query 的真实 REST smoke；
2. 用独特 Transcript 事实验证召回与 `user_id/story_id/session_id/message_id` 可追溯性；
3. 在真实 NemoClaw/OpenClaw `story_continue` 中验证按需 `memory-search.mjs` 调用、`script_call_count` 和耗时埋点；
4. 保存真实 latency、召回结果和失败重试证据。

在这些步骤完成前，不标记 Phase 3A Real Retriever Gate 为 PASS。
