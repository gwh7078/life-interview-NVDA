# Realtime 双 Profile 与独立 Memory 验收报告

日期：2026-09-25
仓库：`gwh7078/life-interview-NVDA`
开发基线：`5827a2009878557d4010488371ba3905231897bc`
总状态：**NOT READY FOR HUMAN ACCEPTANCE**。双 Profile 已接入；2-mini 全流程 E2E PASS。StepAudio 3 续访 Closeout、Context Agent 运行、实时打断及真实 Hint 注入仍有 blocker。

> 下方原始状态与证据是 2026-09-25 / `5827a200` 的历史验收快照。Step-Audio-2-mini `supervisor_auto` 的当前轮 Coach 规则以 2026-09-26 补记为准；历史语音 E2E 结果不代表本次 Coach Deadline 改动已做 live 验收。

## 当前 Mini supervisor_auto Coach 规则（2026-09-26）

本轮开发基于最新 `main@b66a32c`。Step-Audio-2-mini 每个用户 final transcript 都由 Gate 判断当前轮是否需要 Coach：

```text
Gate action=none
→ 不调用 Memory、Era 或 Resolve
→ 立即发送当前轮普通 Mini response.create

Gate guide/correct 且不需要检索
→ 生成短 Gate Coach Packet
→ 发送当前轮 Mini response.create

Gate guide/correct 且需要检索
→ Current Story Memory 与 Era 并行检索
→ 任一路 evidence 非空才调用 Resolve
→ 两路 evidence 都为空时跳过 Resolve，使用 Gate 的 avoid/direction
→ 将短 Coach Packet 随当前轮 response.create 发送
```

- Gate 硬超时为 **2,000 ms**。Gate 超时或失败立即丢弃 Coach 并 fail-open 到当前轮 Mini 普通回答；不等待总 Deadline，也不启动检索或 Resolve。
- Coach 总 Deadline 从用户 final transcript 开始，Gate、Memory、Era、Resolve 共用 **6,000 ms**。检索与 Resolve 只使用剩余预算。Gate/Resolve 故障或超时、总 Deadline 到期、或两路检索都失败时丢弃 Coach 并 fail-open；单路检索失败不阻断另一路的有效 evidence。两路最终 evidence 都为空时跳过 Resolve 并使用 Gate Packet。迟到结果不会再次回答或污染后续轮次。
- `action=none` 与所有 fail-open 路径每轮最多请求一次 Mini response。重复的同一 final `messageId` 不会启动第二次 Coach。
- Memory 仍严格限制为 `ownerId + current storyId + sourceType=subject`，没有 `storyId` 时 fail closed；Q+A 中只有 Answer 是个人事实。
- Era 仍只用于 `story_continue` 且须有可靠窄年份范围。它只可成为 `background_hint`；普通公共描述中的“用户”等名词合法，个人化断言无效。Memory / Era 并行，单路失败时保留另一路有效 evidence。
- 定向 wiring、Coach 与 Era 确定性检查及 typecheck 的本轮结果见下方“2026-09-26 定向验证”。Retriever 健康检查通过不等于真实 Story Continue 检索/Resolve live 验收；该 live 链路仍标为 **NOT TESTED**。

## 2026-09-26 定向验证

- `bash scripts/codex-node.sh npm run typecheck`：**PASS**。
- `bash scripts/codex-node.sh node --import tsx --test test/realtime-retriever-wiring.test.ts test/realtime-coach.test.ts src/realtime/coach/pipeline.test.ts test/realtime-memory-trigger.test.ts src/realtime/slow-context-pipeline.test.ts src/realtime/slow-coordinator.test.ts`：**49/49 PASS**。覆盖重复 final 去重、Gate 2 秒超时与迟到结果、6 秒总 Deadline、临界完成 fail-open、Gate none/direct guide、双空 evidence 跳过 Resolve、单路检索成功、双路失败 fail-open，以及公共 Era 文本与个人化/亲属断言校验。
- `bash scripts/check-ai-env.sh`：**PASS**。本机 Retriever、VectorDB、OpenClaw forward 与 MCP 注册可用；该检查只验证服务健康，不触发模型推理。
- Step-Audio-2-mini 的真实语音及 Story Continue Retriever + Resolve live 验收：**NOT TESTED**。本轮 wiring 使用确定性本地 adapters；没有运行付费 provider E2E。
- 本地 test runner 收尾时输出了数条 `[realtime-trace] write failed (ENOENT)`（fixture 临时目录已清理）；49 项断言均通过。技术观测实现未改动。

## 2026-09-25 双 Profile 与独立 Memory 实现摘要（历史快照）

- 正式默认 Profile 为 `stepaudio3_quality`，模型 `stepaudio-3-realtime-preview`；第二条正式 Profile 为 `stepaudio2_mini`，模型 `step-audio-2-mini`。当前两者都执行 `stepfun-cloud`。
- 仓库默认、浏览器默认和当前忽略的 `.env` 都已设为 StepAudio 3；`.env` 保持 `0600`，本轮只更改 provider 选择，没有更改凭据。
- 两条 Profile 共用 `StepFunRealtimeTransport` 和同一个 StepFun provider adapter；Profile 差异由模型、开场 prelude 和 capability 配置表达。没有 ModelBest 默认值、自动云端 fallback 或 DGX 本地假 Adapter。MiniCPM 保留为 Experimental。
- Provider capability 使用 `supportsContextInjection`，已移除 Voice Provider 层的 `supportsSlowContext`。StepFun 当前准确报告 `supportsInterrupt=false`：Realtime app 没有可验证的 provider cancel / barge-in 发送路径。
- Memory 在非空 `user.transcript.final` 到达后独立启动，输入限定为 session/story/subject/turn/context 版本及该条用户回答。Story scope 限于当前 Story；Retriever 候选被限制为有来源的 Q+A evidence，再交给必需的 Context Agent；事实从选中的 User Answer 重建，不把 raw Retriever evidence、最近 Transcript 或完整 summary 送入 Voice。
- 当前数据模型没有单独的 Story `subject_id` 字段；符合条件的自有 Story 会话以认证用户 ID 作为 Retriever 的 owner/subject scope，外部贡献者会话不会触发 Memory。
- Memory Slow Path 的绝对 TTL 为 5000 ms，覆盖 Retriever、Agent 和 Hint 准备。结果必须匹配当前 turn、context version 和 generation。过期、Agent/ Retriever 失败均 fail closed，不阻塞 Voice。
- 有内容且可安全注入的 Hint 暂存为 `pendingNextTurnContext`；只在没有活动 Assistant response 的下一次 manual turn commit 前注入，并在一次发送尝试后清除。空 Hint 不入队。真实 Agent 当前未成功，故本轮没有真实非空 Hint 注入的 live PASS。
- Native Tool Calling 仍独立保留。Tool Call 不启动 Memory Retrieval。已有 HOLD 超时路径会写入合法 empty/no-context Tool Result 并 Resume；此行为通过确定性测试验证，尚无真实 StepFun 模型 Tool Call 的 live 验收。

## 复跑命令

当前 Worktree 的 `.env` 权限为 `0600`。命令只把它加载到 Node 子进程，不打印或复制凭据；E2E 数据写入独立 artifacts 目录。

StepAudio 3：

```bash
env STORY_INTERVIEW_PROVIDER=stepaudio3_quality \
  CLOSEOUT_PROVIDER=volcengine-agent-plan \
  CLOSEOUT_MODEL=deepseek-v4-flash \
  CLOSEOUT_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \
  CLOSEOUT_API_FORMAT=chat-completions BAILIAN_API_KEY= \
  bash scripts/codex-node.sh node --env-file=.env --import tsx scripts/real-provider-e2e.ts
```

Step-Audio-2-mini：

```bash
env STORY_INTERVIEW_PROVIDER=stepaudio2_mini \
  CLOSEOUT_PROVIDER=volcengine-agent-plan \
  CLOSEOUT_MODEL=deepseek-v4-flash \
  CLOSEOUT_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \
  CLOSEOUT_API_FORMAT=chat-completions BAILIAN_API_KEY= \
  bash scripts/codex-node.sh node --env-file=.env --import tsx scripts/real-provider-e2e.ts
```

## 2026-09-25 验收结果（历史快照）

| 路径 | 结果 | 证据 |
|---|---|---|
| StepAudio 3 新建 Story | **PASS** | 真实 StepFun Cloud 开场、5 个用户回合、6 个 Assistant 音频回复、11 条 Transcript；Story Closeout 真实 HTTP 200 并保存成功。运行目录 `runtime/diagnostics/test-artifacts/real-provider/2026-09-25T02-12-23-529Z-real-provider-HAnfI1/`。 |
| StepAudio 3 续访 Story | **FAIL** | 真实 5 轮语音与 Transcript 保存完成；Closeout 三次模型输出经当前用户 source-ID validator 拒绝，`INVALID_SOURCE_MESSAGE_IDS`。Voice 正常结束，但续访 Story 未应用。 |
| Step-Audio-2-mini 新建 + 续访 | **PASS / READY** | 两场各 5 个用户回合、6 个 Assistant 音频回复；ASR Transcript、Provider Session ID、Closeout、故事历史及数据隔离均 PASS。续访首次输出需要一次格式修复后通过。运行目录 `runtime/diagnostics/test-artifacts/real-provider/2026-09-25T02-39-21-260Z-real-provider-cbVpdT/`。 |
| Local VAD / manual turn | **PASS（2-mini live）** | 通过 `session.configured` 手动回合确认后完成多轮上传、静音 commit、ASR 与 Assistant 音频。StepAudio 3 也完成相同 E2E manual-turn 传输。 |
| Interrupt / barge-in | **FAIL / unsupported** | live E2E 没有打断回合；StepFun adapter 没有向 Provider 发送 cancel 的路径，因此两条 StepFun Profile 均报告 `supportsInterrupt=false`。客户端停止播放不等价于取消 Provider response。 |
| Context injection | **NOT TESTED live** | 两个 Profile 的 adapter 使用 StepFun `conversation.item.create` 注入路径，契约测试 PASS；本轮未取得 Agent 产出的真实 Hint，故没有声称模型侧动态注入 PASS。 |
| Native Tool Call / timeout | **PASS deterministic; NOT TESTED live** | Provider event 规范化、Tool Result、empty/no-context Tool Result 与 Resume 有确定性测试覆盖。没有合成真实模型 Tool Call 冒充 live 结果。 |
| Independent Memory Trigger | **PASS wiring; Agent blocked** | StepAudio 3 E2E trace 显示每个用户 final 独立启动 Recall，Current Story Retriever 返回候选；不会由 Voice Tool Call 启动。Retriever、Q+A 限额、Agent 选择校验、失败 fail-closed、deadline 与 stale 单测 PASS。 |
| Memory Hint → next safe turn | **PASS deterministic; NOT TESTED live** | 队列受 turn/story/version/generation 检查，只在无活动 response 的 manual commit 前消费一次；Agent 成功路径由现有确定性测试覆盖。真实 Context Agent 当前无法完成调用。 |
| Agent failure / timeout / Retriever failure / stale | **PASS deterministic** | 真实 StepAudio 3 trace 中 Agent 执行失败与 5000 ms 超时期间语音继续，未阻塞 Voice。模拟错误、绝对 deadline、late/stale 结果及 Retriever failure 测试均通过。 |

### Context Agent blocker

`realtime-context` agent 已在 `my-assistant` 注册，模型配置可解析且 OpenClaw 未报告缺失 provider credential；但真实 smoke 仍以 `AGENT_RUNTIME_EXEC_FAILED` 结束。只含合成证据的 gateway/local 诊断显示：显式工具 allowlist 为 `*` / `bundle-mcp`，运行时没有匹配的 callable tools。该 Agent 按当前设计禁止工具，因此不能通过开放 Retriever、MCP 或其他工具来绕过。E2E 中 Agent 因此 fail closed；成功 Hint 的 live 路径尚未验收。

## 2026-09-25 自动验证（历史快照）

- `bash scripts/codex-node.sh npm run typecheck`：**PASS**。
- StepFun Profile capability 及协议契约：**18/18 PASS**。
- Slow Coordinator、Slow Context Pipeline、Retriever wiring、Realtime end/manual turn：**21/21 PASS**。覆盖独立 final trigger、Tool Call 分离、Q+A 证据、Agent/Retriever 失败、绝对 5 秒 deadline、timeout、stale 丢弃、manual VAD commit 和不阻塞语音。
- `bash scripts/check-ai-env.sh`：**PASS**（在允许本机 loopback 检查的执行环境中）；Retriever、VectorDB、OpenClaw forward HTTP 200。该健康检查不代表 Agent 模型调用成功。
- `git diff --check`：**PASS**。

## 2026-09-25 历史 Blocker

1. OpenClaw Context Agent 的 no-tools 配置与当前工具注册/allowlist 行为冲突；需让受限的无工具 Agent 可以完成一次模型调用，且不开放 Retriever/MCP 工具，然后重新验收 `Hint → next safe turn`。
2. StepAudio 3 续访 Closeout 在 live run 中三次 source IDs 校验失败；需要保持“仅引用当前 Transcript 用户消息”的数据边界并查明模型输出原因。
3. StepFun 两个 Profile 目前不支持可验证的 Provider 侧 barge-in/cancel。实时打断验收未通过。
4. 两个 Profile 的真实 native Tool Call/Tool Result 路径及真实非空 Context Hint 动态注入未做 live 验收。
