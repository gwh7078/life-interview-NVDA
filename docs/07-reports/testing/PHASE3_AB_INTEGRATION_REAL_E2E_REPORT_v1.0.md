# Phase 3 A+B Integration Gate Report

- Generated at: 2026-09-22T03:47:10.400Z
- Overall status: **FAIL**
- Scope: Phase 3A Retriever boundary, Phase 3B realtime Tool/HOLD/Resume boundary, Agent runtime safety, and live-provider preflight.
- Credential values and bearer tokens are omitted from this report.

## Gate results

| Gate | Name | Status | Duration | Summary |
|---|---|---|---:|---|
| G0 | AI environment preflight | **PASS** | 150 ms | 命令通过。 |
| G1 | Deterministic local regression | **PASS** | 34929 ms | 命令通过。 |
| G2 | Real NeMo Retriever ingest/query smoke | **FAIL** | 1950 ms | 查询返回结果，但未能完成 owner/story/session/message 追溯校验。 |
| G3 | Real Agent runtime acceptance | **NOT_RUN** | 0 ms | PHASE3_SKIP_AGENT_REAL=true，未执行真实 Agent。 |
| G4 | Real Step-Audio Tool/HOLD smoke | **NOT_RUN** | 0 ms | PHASE3_SKIP_LIVE=true，未执行真实 Step-Audio。 |
| G5 | Real backend A+B session acceptance | **BLOCKED** | 0 ms | 等待 G2 真实 Retriever ingest/query 恢复后，再执行 backend + Step-Audio 联合验收。 |
| G6 | Concurrency and isolation acceptance | **BLOCKED** | 0 ms | 等待 G5 真实会话 runner；当前仅有 owner/story/source 过滤的确定性覆盖。 |
| G7 | Latency and slow-path budget acceptance | **BLOCKED** | 0 ms | 等待 G5/G6 真实数据；不能用本地 fake 或 HTTP 503 推导线上延迟。 |
| G8 | Persisted DB and trace final-state acceptance | **BLOCKED** | 0 ms | 等待真实会话完成后检查 SQLite authoritative rows、index state 和 trace counters。 |

## Evidence

- **G0**: 命令通过。 Command: `bash scripts/check-ai-env.sh`. {"exitCode":0,"signal":null,"outputTail":"[OK] NeMo Retriever: HTTP 200 {\"status\": \"ok\", \"mode\": \"standalone\"}\n[OK] Retriever VectorDB: HTTP 200 {\"status\": \"ok\", \"total_rows\": 2, \"table_exists\": true, \"embed_mode\": \"remote\", \"effective_retrieval_mode\": \"hybrid\", \"catalog\": {\"healthy\": true, \"initialized\": true, \"schema_version\": 2}, \"collections\": {\"active\": 1, \"deleting\": 0, \"expired\": 0}, \"cleanup\": {\"pending\": 0, \"oldest_age_seconds\": 0.0\n[OK] OpenClaw sandbox forward reachable: HTTP 400\n[OK] Codex MCP: nemo-retriever-local 已注册\n[OK] 本地 AI 开发环境检查完成"}
- **G1**: 命令通过。 Command: `bash scripts/codex-verify.sh`. {"exitCode":0,"signal":null,"outputTail":"…etrieval script and counts its marker (0.523042ms)\n✔ Format Repair removes retrieval authorization from the prompt and command (0.250708ms)\n✔ AttemptRunner records timing diagnostics without task content (2.696416ms)\n✔ AttemptRunner records failed timing diagnostics without task content (2.5935ms)\n✔ TaskExecutor owns runtime retry inside one total three-attempt budget (0.466917ms)\n✔ TaskExecutor uses Format Repair only after final-result formatting failure (0.23375ms)\n✔ Format Repair prompt carries the malformed candidate into the next Agent attempt (0.342541ms)\n✔ TaskExecutor sends schema or business validation failure to Validation Repair (0.245083ms)\n✔ TaskExecutor does not retry a cancelled task (0.290333ms)\n✔ agent tool token verifies exact run resource scope (1.324542ms)\n✔ agent tool token rejects resource mismatch and expiry (0.692167ms)\n✔ get_story_context is owner-scoped and returns Agent Memory + gaps (195.480708ms)\n✔ AgentStoryCompletionProcessor sends structured Completion context through AgentTaskPort (2.77975ms)\n✔ AgentStoryGenerationContextModel sends structured Generation context and resource version (2.793625ms)\n✔ story_continue receives a short-lived, Story-scoped retrieval script context (4.620833ms)\nℹ tests 24\nℹ suites 0\nℹ pass 24\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 2773.115583\n检查服务 TypeScript 类型……\n运行时：Node v24.21.0，npm 11.11.0\n\n> life-interview-nvda@0.1.0 typecheck\n> tsc --noEmit\n\n全部本地自动化验证通过。真实语音/总结模型 E2E 不在此操作中运行，因为它会发送音频并消耗外部模型用量。"}
- **G2**: 查询返回结果，但未能完成 owner/story/session/message 追溯校验。 Command: `RetrieverClient: GET /v1/health; POST /v1/ingest/job; POST /v1/ingest/job/{id}/document; GET status; POST /v1/query`. {"health":{"status":"ok","mode":"standalone"},"jobId":"0de994d714e04aba9597b5e14a389db6","documentId":"b9feb25b7a75443c81d9e8e2f351363c","indexStatus":"completed","evidenceCount":1,"matched":false,"evidencePreview":[{"ownerId":null,"storyId":null,"sourceType":null,"sessionId":"","messageIds":[],"segmentIds":[],"textPreview":""}],"ownerId":"phase3-gate-owner-6bbcc1ce-6ea4-4aed-9ea6-294323fb490f","storyId":"phase3-gate-story-ef00b8b9-ac22-4819-bb00-24a1a2eeee32","sessionId":"phase3-gate-session-a04fe18e-9d42-462d-9aee-15bf784f79e8","messageId":"phase3-gate-message-6d59458a-bb9f-4f02-a034-83a4be1ce7be"}
- **G3**: PHASE3_SKIP_AGENT_REAL=true，未执行真实 Agent。
- **G4**: PHASE3_SKIP_LIVE=true，未执行真实 Step-Audio。
- **G5**: 等待 G2 真实 Retriever ingest/query 恢复后，再执行 backend + Step-Audio 联合验收。 {"deterministicWiringTest":"test/realtime-retriever-wiring.test.ts"}
- **G6**: 等待 G5 真实会话 runner；当前仅有 owner/story/source 过滤的确定性覆盖。
- **G7**: 等待 G5/G6 真实数据；不能用本地 fake 或 HTTP 503 推导线上延迟。
- **G8**: 等待真实会话完成后检查 SQLite authoritative rows、index state 和 trace counters。

## Interpretation

- `PASS` means the named automated check completed and its assertions passed.
- `BLOCKED` means an external dependency or missing live acceptance path prevented a valid conclusion.
- The real Retriever smoke must be rerun after the current HTTP 503 is fixed; a local wiring test does not replace it.
- Real human voice experience acceptance remains a manual final step after all automated gates pass.
