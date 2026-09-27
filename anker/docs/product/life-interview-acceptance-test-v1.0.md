# 人生采访局｜产品验收测试基准

> 版本：V1.0  
> 日期：2026-09-18  
> 对应产品基准：`life-interview-product-tech-data-v1.5.3.md`  
> 用途：作为当前比赛 V1 的功能回归、人工 Smoke、真实 Doubao 语音验收和后续 Agent 开发的统一测试清单。

> 历史说明（2026-09-23）：本文保留 V1.0 当时的验收计划，其中 Doubao Realtime 内容不代表当前运行时。当前实时语音默认使用 Step-Audio 2 Mini，Doubao Realtime 已从运行时代码移除。当前环境约定请查阅 `docs/AI开发联调环境.md` 和 `docs/nvidia-agent-native/FEATURE_MATRIX.md`。

---

# 1. 测试目标

当前测试不追求“测试数量最多”，而是优先保护用户真实主链路：

```text
手机号登录
↓
Interview 1：首次建档 / Onboarding
↓
Profile + Life Stages + Story Seeds
↓
Story Completion
↓
我的人生
├─ Interview 2：Story 新建
├─ Interview 3：Story 续访
└─ Interview 4：第三者访谈 / External Contributor
↓
各自 Realtime 语音 + Transcript
↓
按场景进入对应 Closeout
↓
主人公链路：Story Summary + Agent Memory + Completion
第三者链路：Contributor Summary（与主人公事实链路隔离）
↓
Story Detail / Documents / Book
```

测试优先级：

- **P0**：会丢数据、错误结束通话、语音不可用、Story 丢失、Completion 不运行、处理页假死；
- **P1**：产品结构和交互错误，但不直接破坏数据；
- **P2**：视觉细节、调试信息、低风险兼容行为。

---

# 2. 测试分层

## 2.1 Deterministic 自动化

默认验证：

- Schema / Validator；
- Repository 原子性；
- owner scope；
- Prompt 关键产品规则；
- Closeout / Completion 工作流；
- HTTP DTO；
- Processing UI 状态机；
- Provider Adapter 合同；
- 不依赖真实外部模型。

开发时优先跑受影响 targeted tests，完成后运行：

```bash
bash scripts/codex-verify.sh
```

## 2.2 真实 Doubao Smoke

真实 Provider 测试不进入普通 deterministic verify，避免每次开发消耗外部模型额度。

只有人工验收或明确要求时运行真实语音测试。

重点验证：

- 用户说话识别；
- AI 响应延迟；
- TTS 完整播放；
- barge-in；
- 自动结束；
- Transcript；
- Closeout；
- Completion；
- Story Seed；
- Result Processing。

## 2.3 真机 UI Smoke

至少覆盖：

- iPhone Safari；
- 桌面 Chrome / Mac；
- 麦克风权限；
- 地址栏变化；
- 长文本；
- 通话按钮；
- Processing spinner；
- Profile Popover。

## 2.4 Interview 四场景验收矩阵

产品层固定有 4 种 Interview 场景。测试必须按场景分别覆盖，不能只因为 Story Create / Continue 共用同一个 Strategy 就合并成一条用例。

| 场景 | 启动输入 | 关键 Context | Session / 来源 | 会后处理 |
|---|---|---|---|---|
| 首次建档 | `interview_type=onboarding` | Onboarding profile / task context | `session_type=onboarding` | Onboarding Closeout |
| Story 新建 | `interview_type=story, target.mode=create` | Life Stage + optional target title；`story=null` | `session_type=story, source_type=subject` | Story Closeout → 新 Story / Agent Memory → Completion |
| Story 续访 | `interview_type=story, target.mode=continue` | existing Story + Agent Memory + gaps | `session_type=story, source_type=subject` | Story Closeout → Summary / Agent Memory → Completion |
| 第三者访谈 | `interview_type=external_contributor` | Story 公开信息 + relationship + Contributor Summary | `session_type=story, source_type=external_contributor` | Contributor Closeout；不得进入主人公事实链路 |

自动化至少要证明：

- 四种入口均能构造正确 Context；
- Story 新建和 Story 续访的 mode 不串；
- 第三者访谈不能被普通 Story Closeout 接管；
- 四种场景的 Transcript 都能持久化，但写入范围不同。

---

# 3. P0：Onboarding

## ONB-01 人生地图优先

**前置：** 新账号，无 Life Stage / Story。

**操作：**

1. 开始首次建档。
2. 用户在早期回答中主动讲一个非常有趣、细节很多的具体事件。
3. 继续回答后续人生阶段。

**预期：**

- AI 可以简单确认这个事件是什么、属于哪个阶段；
- 不连续围绕该事件深挖十几轮；
- 很快回到人生时间线；
- 最终覆盖从较早阶段到当前状态的主要人生阶段；
- 单个 Story 很完整不能替代整个人生地图。

**自动化：** Prompt Contract。  
**人工：** 必须。

---

## ONB-01A 人生概况只写 Facts

**操作：**

首次建档同时聊到多个 Life Stage、职业变化、家庭与当前状态。

**预期：**

- `profile_summary` 只保留 3–6 个明确 Facts；
- 不按“后来 / 之后 / 随后 / 毕业后”把 Life Stage 再叙述一遍；
- Life Stage 负责时间线，Story 负责事件，Profile 概况负责稳定事实；
- `current_status` 只描述当前状态，不在概况里长篇重复。

**自动化：** Prompt / Schema Contract。  
**人工：** 必须。

---

## ONB-02 Life Stage 粒度

**操作：**

用户经历包含：

- 小学 / 初中同城且生活结构基本相同；
- 高中开始寄宿；
- 大学跨城市独立生活；
- 毕业后第一份工作。

**预期：**

- 不机械规定小学 / 初中 / 高中各一个 Stage；
- 高中寄宿、大学跨城市等明显结构变化可以成为边界；
- 不把“小学到大学”全部压成一个“求学生涯”超级 Stage。

**自动化：** Prompt Contract。  
**人工：** 抽样。

---

## ONB-03 Story Seed 粒度

用户在求学阶段讲：

- 高中差点被开除；
- 高考失利；
- 大学第一次独自去外地。

**预期：**

- 可以生成多个独立 Story Seed；
- 不创建“我的求学生涯”之类超级 Story；
- Story Seed 不要求已经采访完整；
- 每条 Story 有独立 title / summary / stage。

**自动化：** Closeout Prompt + Repository。  
**人工：** 必须。

---

## ONB-04 Onboarding 原子性

**模拟：** Story 插入中途 DB 写失败。

**预期：**

- Profile / Life Stage / Story 不留下半套数据；
- Onboarding 状态可安全重试；
- Transcript 保留。

**自动化：** 必须。

---

## ONB-05 所有新 Story 都进入 Completion

**操作：**

Onboarding 一次生成多个 Story。

**预期：**

- 原子 Closeout 先成功；
- 每个新 Story 都调用 Story Completion；
- 每个 Story 最终得到 status / gaps；
- 单个 Completion 失败不回滚其他 Story / Stage / Profile。

**自动化：** 必须。

---

## ONB-06 Completion 运行期间仍显示 Processing

**操作：**

人为阻塞一个 Onboarding Story Completion。

**预期：**

- Onboarding Closeout 可以已经 completed；
- API 返回 `story_completion_pending=true`；
- Processing 页面不提前跳到结果页；
- Completion 全部结束后才进入 Onboarding Result。

**自动化：** 必须。

---

# 4. P0：Story 新建 Interview

## CREATE-01 从 Life Stage 发起新 Story

**前置：**

已有 Profile 与目标 Life Stage，但当前还没有目标 Story。

**操作：**

1. 从 Life Stage 点击“新增故事”；
2. 可选输入一个目标标题；
3. 开始 Realtime Interview。

**预期：**

- 启动输入为 `interview_type=story + target.mode=create`；
- Context 中 `story=null`；
- Life Stage 必须来自当前 owner；
- `task_context.mode=create`；
- 如果提供标题，只作为本轮采访目标，不要求 DB 中已存在 Story；
- Session 保存为 `session_type=story, source_type=subject`；
- 不读取任何其他 Story 的 Agent Memory。

**自动化：** 必须。

---

## CREATE-02 新 Story 结束后进入 Story Closeout

**操作：**

Story Create Interview 中形成一段可独立命名的真实事件后结束。

**预期：**

- Transcript 完整保存；
- Story Closeout 可以创建目标 Story / Story Seed；
- 新 Story 产生 Summary 与 Agent Memory；
- 对新 Story 运行 Completion；
- 不因这是“新建模式”而跳过 Story Closeout 或 Completion。

**自动化：** Core / Closeout / Repository。  
**真实 Doubao：** 必须。

---

# 5. P0：Story Realtime Interview

## RT-01 Continue 第一问优先 gaps[0]

**前置：**

Story 有：

```json
"gaps": ["父亲到学校后发生了什么？", "学校最后如何处理？"]
```

**预期：**

Doubao 开场直接把第一条 gap 作为唯一问题，不重新泛泛问“你再讲讲这个故事”，也不追加第二个问题。gap 必须是可直接提问的单一问题，不能是“缺少 A/B/C”的诊断说明。

**自动化：** 必须。

---

## RT-02 Agent Memory 避免跨 Session 重复追问

**前置：**

Story 已有持久化 `agent_memory`，其中包含已知事实、已覆盖主题、纠正与不确定信息。

**预期：**

- 下一轮 Realtime Context 注入完整受控长度的 `agent_memory`；
- 不再注入 `recent_asked_questions`、历史 Q/A 或完整历史 Transcript；
- AI 不应重复询问 Agent Memory 中已经明确回答或已经说明记不清的方向；
- 用户当前 Session 的明确表达与纠正优先于 Agent Memory；
- 同一语义方向默认只问一轮，只有用户主动带出新具体线索时允许继续澄清；
- `agent_memory` 属于内部工作记忆，不通过 ready DTO 暴露给浏览器。

**自动化：** Context / Prompt / ready DTO Contract。  
**人工：** 用跨两次 Session 的同一 Story 验证语义不重复。

---

## RT-02B Agent Memory Preservation Guard

**场景 A：未触及旧事实**

旧 Agent Memory 同时包含多条已确认事实，本轮只补充其中一个新细节。

**预期：**

- 本轮未触及的旧事实必须继续存在；
- 不能因压缩、润色、重组而静默丢失旧信息；
- Agent Memory 发生变化时必须返回内部 `memory_changes`；
- `memory_changes` 不写入 Story、不出现在前端 DTO。

**场景 B：明确纠正 / 删除**

用户本轮明确纠正旧事实，或明确否定旧信息。

**预期：**

- `correct / refine / remove / add` 必须引用本轮 `role=user` 的 source message；
- `previous_text` 必须来自旧 Agent Memory，`new_text` 必须来自新版 Agent Memory；
- 无证据的破坏性修改必须拒绝；
- 旧信息无解释消失时返回 `MEMORY_INFORMATION_LOSS` 并进入 Closeout repair；
- 非法变更记录返回 `INVALID_MEMORY_CHANGE` 并进入 Closeout repair。

**自动化：** 必须。Validator + Closeout repair contract。

---

## RT-02A User Turn 判停与底噪

**环境：**

- 浏览器麦克风使用 `echoCancellation=true`、`noiseSuppression=true`、`autoGainControl=false`；
- Doubao `end_smooth_window_ms=1500`；
- 不启用自研 VAD / Noise Gate。

**操作：**

1. 正常回答一句话后保持安静；
2. 重复一次，并在停说后敲几下键盘；
3. 再做一次 2–3 秒自然思考停顿后继续说话。

**预期：**

- 正常停说后应在合理时间内得到 `user_final` 并进入下一轮；
- 键盘底噪不应造成十几秒持续不判停；
- 2–3 秒自然思考停顿不应被过度激进地截成多轮；
- User Turn 已产生 ASR delta 后，如连续 **4 秒**没有新的 ASR activity、仍未产生 `user_final` 且 AI 没有开始响应，则触发 Provider 级 stalled-turn recovery；
- Doubao recovery 使用 Adapter 内的 `input_audio_buffer.commit`，不得把 Doubao wire event 写回 `server.ts`；
- recovery 必须留下 `user_turn.stall_detected` / `user_turn.stall_recovery_sent` trace，便于真机继续判断 endpointing；
- 不提前引入客户端 VAD，也不修改当前 `end_smooth_window_ms=1500`。

**自动化：** Browser constraint + Doubao session config。  
**真实 Doubao：** 必须。

---

## RT-03 TTS 不被误 speech_started 截断

**场景：**

- Provider 已返回完整 assistant 文本；
- `response_done` 已到；
- 浏览器 WebAudio 仍有 queued node / pending schedule；
- 此时收到一次错误或噪声 `speech_started`。

**预期：**

- 不调用 `stopPlayback()`；
- 剩余 TTS 播放完整；
- trace 中 `outputAudioPending=true`。

**自动化：** Helper / Client Contract 必须。  
**真实 Doubao：** 必须。

---

## RT-04 真实用户插话可以打断

**场景：**

AI 正在输出，用户真实开始讲话。

**预期：**

- 仅 `speech_started` 不足以立即截断 queued audio；
- 收到非空 `user_partial` 或 `user_final` 后执行真实 barge-in；
- AI 音频停止；
- 用户 Transcript 正常保存；
- 下一轮继续。

**自动化：** Helper /协议层。  
**真实 Doubao：** 必须。

---

## RT-05 响应延迟

记录 A/B/C/D：

- A：speech_stopped；
- B：user_final；
- C：assistant_started；
- D：first_audio。

**预期：**

- 能从 trace 区分 ASR 延迟、模型首 token 延迟、首音频延迟；
- 不在 trace 中记录 Transcript 正文或音频 payload；
- 当前 `DOUBAO_END_SMOOTH_WINDOW_MS=1500`；没有新证据时不继续随意调整。

**自动化：** trace privacy / milestone。  
**真实 Doubao：** 必须。

---

# 6. P0：结束通话

## END-01 普通礼貌语不挂断

AI 说：

> 谢谢你的分享。

**预期：**

- 不触发 `assistant_farewell`；
- Session 继续。

**自动化：** 必须。

---

## END-02 AI 主动结束必须固定语句

当 AI 判断本轮确实应结束：

**预期最终一句：**

> 本次先聊到这里，再见。

**并且：**

- 完整播放结束语后再结束；
- 不追加“谢谢”“我们下次继续”等额外文字；
- 服务端识别为 `assistant_farewell`。

**自动化：** Farewell parser / Prompt Contract。  
**真实 Doubao：** 必须。

---

## END-03 AI 不按轮数生硬结束

**场景：**

已经 8–10 个有效回答，但用户刚开始补充重要新线索。

**预期：**

- 不因为达到固定轮数立即结束；
- 继续追问明显关键点。

**人工：** 必须。

---

## END-04 用户明确要求结束

用户说：

- “今天先到这里”
- “不聊了”
- “结束吧”

**预期：**

- 立即尊重；
- 保存最后用户 Transcript；
- 不再继续追问；
- 正常进入 Closeout。

**自动化：** 必须。

---

## RT-06 手动结束立即进入 Result Processing

**操作：**

Story 通话中点击“结束”。

**预期：**

- 服务端回 `status=ending, reason=user` 后，客户端立即进入 `/interview/result?session_id=...`；
- 不在通话页等待 Provider drain / Session ended；
- 后台仍继续保存最后 Transcript，并随后执行 Closeout / Completion；
- Result 页面在此期间保持 processing，不能因为提前跳转而丢最后一轮 Transcript。

**自动化：** UI Contract + Result Processing。  
**真实 Doubao：** 必须。

---

# 7. P0：Story Closeout / Story Seed

## CO-01 Summary 合并

**预期：**

- 保留旧 Summary 未被纠正的事实；
- 加入本轮与当前 Story 直接相关的新事实；
- 用户最新纠正覆盖旧错误；
- 保留“大概 / 可能 / 记不清”等不确定表达；
- 不把旁支 Story 塞入当前 Summary。

---

## CO-02 同 Stage 新 Story

当前 Story：

> 高中参加演出

本轮提到：

> 高中差点被开除，父亲还去了学校。

**预期：**

- 当前 Story Summary 只更新“参加演出”；
- 新建 Story Seed“高中差点被开除”；
- 两个 Story 可以属于同一 Stage。

---

## CO-03 跨 Stage 新 Story

当前采访高中 Story，用户提到大学时期一件独立事件。

**预期：**

- 新 Story Seed 可以挂到大学 Stage；
- 不因为当前采访高中而丢弃。

---

## CO-04 Story Seed 门槛

应创建：

> “高中差点被开除，父亲去了学校找老师。”

不应创建：

> “大学还有很多事情，以后再说。”

**预期：**

- Story Seed 不要求人物 / 过程 / 结果已经完整；
- 至少需要“发生什么 + 一项具体上下文或细节”。

---

## CO-05 每轮最多 5 个 Story Seed

**预期：**

- 0–5 个合法；
- 超过 Schema 上限拒绝并进入既有修复 / 失败流程；
- 不恢复旧的 max=3。

**自动化：** 必须。

---

## CO-06 当前 Story + 新 Story 全部 Completion

Closeout 创建 N 个新 Story。

**预期：**

```text
unique([
  currentStoryId,
  ...createdStoryIds
])
```

全部调用 Completion。

**自动化：** 必须。

---

## CO-07 Completion 失败隔离

让某个新 Story Completion 抛错。

**预期：**

- Closeout 仍为 completed；
- Summary 已提交；
- 新 Story 已存在；
- 其他 Story Completion 仍继续；
- 错误被记录，但不污染主事务。

**自动化：** 必须。

---

# 8. P0：Story Result

## RESULT-01 Closeout Processing

**预期：**

- 显示明显 spinner；
- 显示阶段文案；
- 不显示虚假百分比；
- “先回到我的人生”可用；
- 离开页面不调用 cancel。

---

## RESULT-02 Closeout completed + Completion pending

返回：

```json
{
  "closeoutStatus": "completed",
  "storyCompletionPending": true
}
```

**预期：**

- UI 仍显示 processing spinner；
- 文案说明正在更新故事状态；
- “先回到我的人生”可点击；
- 页面继续 GET 轮询；
- 用户离开不会取消 Completion。

**自动化：** 必须。

---

## RESULT-03 Completed

**预期：**

- 展示更新后的 Story Summary；
- 展示本轮新建 Story；
- 普通 UI 不展示 Provider / Model / token / latency / Session ID；
- 只有一个主要去向：“回到我的人生”。

---

# 9. P0：Story Share / 第三者访谈

## SHARE-01 创建 7 天分享链接

**操作：**

Owner 在 Story Detail 选择 relationship 并生成链接。

**预期：**

- Story Detail 存在“分享给亲友”入口；
- relationship 创建后固定；
- 链接默认 7 天有效；
- DB 只保存 token hash，不保存明文 token；
- 非 owner 不能创建 / 撤销该 Story 的分享链接。

**自动化：** 必须。

---

## SHARE-02 未登录第三者读取公开 Story

**操作：**

在无登录态设备打开分享链接。

**预期：**

- 可以查看 Story title / status / Summary / gaps / relationship；
- 不暴露 userId / shareId / Session ID / Agent Memory / Debug 字段；
- 每次打开读取 Story 当前最新内容；
- revoked / expired token 返回不可用。

**自动化：** 必须。  
**人工：** 真机必须。

---

## SHARE-03 第三者首次 Interview

**预期：**

- WebSocket 通过 share token 鉴权，不要求 Account 登录；
- 启动为 `interview_type=external_contributor`；
- 服务端从 token 解析 owner / Story / relationship，客户端不能自行指定；
- Context 使用 Story 当前公开信息；
- Session 标记 `source_type=external_contributor`；
- Transcript 正常持久化。

**自动化：** 必须。  
**真实 Doubao：** 必须。

---

## SHARE-04 同一链接连续记忆

第一次第三者 Interview 完成后再次使用同一链接进入。

**预期：**

- 第一次 Closeout 生成独立 Contributor Summary，最终长度 ≤ 400 字；
- 第二次 Context 带入同一个 share_id 的 Contributor Summary；
- AI 不把第二次当成第一次采访；
- 不要求读取旧完整 Transcript 才能续访；
- 不同 share_id 的 Contributor Summary 互不串线。

**自动化：** 必须。  
**人工：** 必须。

---

## SHARE-05 主人公事实链路隔离

第三者 Transcript 中出现与主人公不同或冲突的说法。

**预期：**

- 第三者 Transcript 原样保留；
- 不自动修改 Story Summary；
- 不自动修改 Story Agent Memory；
- 不影响 Story Completion session count / status / gaps；
- 不进入 Story Generation subject evidence；
- 普通 Story Closeout 的 claim / Context / Persistence 三层都拒绝该 Session；
- 不判断第三者和主人公谁真谁假。

**自动化：** 必须。

---

## SHARE-05A 第三者手动结束立即退出通话页

**操作：**

第三者访谈中点击结束。

**预期：**

- 服务端回 `status=ending, reason=user` 后立即离开通话页；
- 跳回分享结果页并显示“正在整理”；
- 不在通话页等待 Provider drain 或 Contributor Summary 模型调用；
- 分享结果页通过 share token 轮询最新第三者 Session 的 closeout 状态，不在 URL / DOM 暴露 Session ID；
- completed 显示保存成功；failed 显示重试入口，Transcript 不丢失。

**自动化：** UI Contract + Story Share API。  
**真实 Doubao：** 必须。

---

## SHARE-06 Contributor Closeout 失败与重试

**模拟：**

Contributor Closeout 模型调用瞬时失败或持续返回非法结果。

**预期：**

- 最多自动尝试 3 次；
- 仍失败则保留 Transcript，Session 标记 failed；
- 前端不得显示“保存成功”；
- 同一分享链接可点击“重新整理”最近失败 Session；
- 不要求受访者重新讲；
- 空采访不增加 interview_count，也不生成伪 Summary。

**自动化：** 必须。

---

# 10. P1：Profile / Provider

## PROFILE-01 手机号

登录后打开 Profile Popover。

**预期：**

- 显示用户名；
- 显示当前账号完整手机号；
- 手机号来自服务端当前 AuthContext 对应账号；
- 不新增 DB 字段；
- 不把手机号传入 Story Interview Prompt。

**自动化：** Auth Service + `/api/auth/me`。  
**人工：** UI Smoke。

---

## PROVIDER-01 Qwen 不出现在产品 UI

**预期：**

- Provider 下拉不显示 Qwen；
- 产品默认 Doubao；
- Qwen Adapter 代码可以保留作为 inactive / legacy；
- Provider Adapter 抽象不能删。

**自动化：** UI Contract。

---

## PROVIDER-02 Text Runtime 统一路由

**配置：**

```text
TEXT_MODEL_PROVIDER=openai-compatible
TEXT_MODEL_BASE_URL=http://127.0.0.1:8001/v1
TEXT_MODEL=local-text-model
TEXT_MODEL_API_FORMAT=chat-completions
```

**预期：**

- `closeout.story`、`closeout.onboarding`、`completion.story`、`generation.story` 都使用同一共享 Text Runtime；
- 任务名称和业务流程不改变；
- 未设置 `TEXT_MODEL_*` 时继续使用当前默认云端 Text Runtime；
- `CLOSEOUT_* / STORY_COMPLETION_* / STORY_GENERATION_*` 仍可做任务级覆盖；
- Text Runtime 配置不能改变 `interview.story` 的 Realtime Provider。

**自动化：** `test/ai-task-config.test.ts`。

---

## PROVIDER-03 OpenAI-compatible Endpoint 与安全边界

**预期：**

- 任意合法远程 HTTPS OpenAI-compatible Endpoint 可以接入，并使用 Bearer API Key；
- `http://127.0.0.1:PORT` 与 `http://localhost:PORT` 可以作为 loopback 本地 Runtime；
- loopback 本地 Runtime 允许 API Key 为空；
- 非 loopback 的明文 HTTP 必须在发请求前拒绝；
- URL 中包含 username / password / query / hash 时必须拒绝；
- 失败日志和异常不得暴露 API Key、Prompt、Transcript 或 Provider 原始错误正文。

**自动化：** `test/llm-provider.test.ts`。

---

## PROVIDER-04 云端缺 Key 行为保持兼容

**场景：**

现有 Web 云端 Closeout / Onboarding Closeout 没有配置文本模型 API Key。

**预期：**

- 仍按原有业务错误语义返回“模型未配置”；
- 不因为支持 local no-key 而放宽远程云端鉴权要求；
- 已有 Closeout / Onboarding 回归测试继续通过。

**自动化：** Closeout / Onboarding workflow tests + 完整 verify。

---

## PROVIDER-05 Text Runtime 解耦不得影响 Realtime Voice

**操作：**

只设置 `TEXT_MODEL_*` 为 OpenAI-compatible loopback Runtime，不设置 Realtime Provider。

**预期：**

- `interview.story` 仍使用 Doubao；
- Web Realtime / Audio / WebSocket 协议和行为不改变；
- 本阶段不增加 `LocalRealtimeProvider`；
- 不应修改 Story Interview Prompt、barge-in、结束协议、Transcript 生命周期。

**自动化：** AI task config contract。
**人工：** Web + Doubao Smoke。

---

## PROVIDER-06 Local / NVIDIA Realtime 可扩展性

当前**只要求保留接口，不要求实现 Local Realtime Provider**：

```text
RealtimeInterviewProvider
├─ Doubao
├─ legacy Qwen
└─ future Local / NVIDIA
```

新增 Realtime Provider 时不应重写 Story Interview 业务流程。

**测试：** 架构 review / adapter contract。


## PROVIDER-07 Realtime Voice Provider 解耦

**预期：**

- `src/server.ts` 的 Realtime lifecycle 只消费 typed normalized events，不解析 Doubao / Qwen raw event type；
- Doubao / Qwen 均满足同一 `RealtimeVoiceProvider` Contract；
- Audio Spec、input shutdown、close plan、onboarding completion protocol、Provider error sanitization 均由 Adapter / Runtime Config 提供；
- `server.ts` 不出现 Doubao response-id fallback、Qwen function-call wire event、Doubao onboarding sentinel、Qwen silence-frame 常量或 Doubao PCM 常量；
- 默认 Web Provider 仍是 Doubao；
- Browser Realtime 消息协议不变；
- Text Runtime 配置与 Realtime Provider 配置相互独立；
- Local / NVIDIA Realtime Provider 仍为未实现状态。

**自动化：** `test/realtime-provider-contract.test.ts` + Realtime integration tests + 完整 verify。  
**人工：** 四场景真实 Doubao Smoke 必须全部通过后，才能把本阶段标记为真实运行稳定。

---

# 11. 数据安全与不变量

任何回归都必须保护：

1. Transcript 是一手史料，不因 Closeout / Completion / Generation 失败而丢失；
2. assistant 文本不能作为用户事实 source refs；
3. owner scope 只信服务端 AuthContext；
4. Closeout 原子性；
5. Completion 是派生步骤，不回滚已提交 Closeout；
6. Story `complete` sticky；
7. stale Completion 不能覆盖新 Story；
8. 模型 / trace 日志不得打印用户长文本或音频 payload；
9. 普通 UI 不暴露 API Key、Provider 细节、内部 JSON；
10. 测试只使用 worktree / 临时数据库，不污染共享或生产数据；
11. Story Continue 的 Agent Memory 与 External Contributor 的 Contributor Summary 是两套独立记忆，绝不能互相写入；
12. `source_type=external_contributor` 的 Transcript 永远不能被默认主人公事实读取接口无条件返回。

---

# 12. 发布前最小回归集

每次准备提交比赛版本前至少执行：

## 自动化

- Auth / owner scope；
- Onboarding Closeout；
- Story Closeout；
- Story Completion；
- Text Runtime / OpenAI-compatible endpoint / loopback no-key / endpoint security；
- Realtime prompt / Doubao adapter；
- Result UI；
- Book / PDF 原有主链路；
- 完整 `bash scripts/codex-verify.sh`。

## 真实 Doubao 人工流程

发布前至少各完成一次 4 类 Interview 场景；其中 Story Create 与 Story Continue 必须分开验收。

### 流程 A：首次建档

```text
手机号登录
→ Onboarding
→ 多阶段人生地图
→ 至少 3 个 Story Seed
→ Completion
→ Onboarding Result
→ 我的 人生
```

### 流程 B：Story Create

```text
进入一个已有 Life Stage
→ 新增故事
→ Story Create Realtime
→ 讲出一个尚不存在的具体事件
→ 正常结束
→ Story Closeout
→ 新 Story 产生 Summary / Agent Memory
→ Completion 产生 status / gaps
→ Story Detail 可继续访问
```

### 流程 C：Story Continue

```text
选择已有 Story
→ gaps[0] 开场
→ 长回答
→ AI 多轮追问
→ 用户真实插话一次
→ AI 完整继续
→ 本轮讲出 1 个同 Stage 新 Story
→ 再讲出 1 个跨 Stage 新 Story
→ AI 自主固定语句结束
→ Story Result Processing
→ 提前返回我的人生
→ 最终检查当前 Story + 新 Story 的 Summary / status / gaps
```

### 流程 D：External Contributor

```text
Story Detail 生成分享链接
→ 未登录设备打开
→ 查看 title / status / Summary / gaps
→ 第一次第三者 Realtime Interview
→ Contributor Closeout 成功
→ 再次打开同一链接
→ AI 能利用 Contributor Summary 续访
→ 检查 Story Summary / Agent Memory / Completion / Generation evidence 均未被第三者内容污染
```

若这四类真实流程没有分别通过，不应仅凭单元测试宣称 Interview 主链路完成。
