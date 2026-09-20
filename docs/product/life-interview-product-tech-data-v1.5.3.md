# 人生采访局｜产品、技术与数据基准文档

> 文档版本：V1.5.3  
> 更新日期：2026-09-19  
> 文档用途：作为比赛 V1 阶段的产品 / 技术 / 数据主基准，供产品、设计、前端、后端、AI/Agent、测试及后续开发统一理解当前产品定义与实现边界。  
> 基于版本：V1.5.2  
> 本版性质：**功能边界与运行时架构更新版。在 V1.5.2 基础上合并 Story Share / External Contributor，并同步 Story Agent Memory、Text Model Runtime、Realtime Voice Provider 解耦与 Interview 四场景定义。**

---

# 0. 阅读约定

本文同时描述“产品规则”和“当前实现状态”。后续 AI / Agent 必须区分二者：

- **[已实现]**：当前代码已具备该能力；
- **[已实现][本地自动化已覆盖]**：已有确定性本地测试保护；
- **[待人工验收]**：代码已完成，但真实模型质量、真机布局或完整人工流程仍需检查；
- **[规划 / Demo]**：比赛界面可展示，但不接真实业务闭环；
- **[后移]**：明确不进入当前比赛 V1；
- **[待确认]**：产品规则尚未冻结。

冲突原则：

> **产品行为以本文件最新冻结规则为准；实现事实以最新代码与专项开发结果为准。**

V1.3 以来的移动端优先、电话式 Interview、Story 内容优先等交互原则继续有效；本文件不再逐章重复旧版本中未变化的视觉细节。

---

# 1. 产品定位与比赛 V1 目标

“人生采访局”是一款通过 AI 长期访谈帮助用户整理人生经历、建立人生地图、沉淀 Story、形成忠于事实的 Story Document，并最终将多个 Story 成稿组织成一本完整人生书的产品。

它不是“一次输入资料 → 自动生成整本回忆录”的工具，而是一个渐进式的人生资料整理与成书系统。

比赛 V1 需要稳定证明完整闭环：

```text
认识用户
↓
建立人生地图
↓
围绕 Story 持续采访
↓
沉淀 Transcript / Summary
↓
判断 Story 还缺什么
↓
资料充分后生成 Story Document
↓
多个 Story Documents
↓
Book Assembly
↓
PDF / 纸质书 Demo / 出版 Demo
```

比赛 V1 的总原则：

> **稳定演示清晰闭环优先于功能数量；优先复用已经验证的 Story 链路，不为了“整本书”再新增复杂的大模型写作系统。**

---

# 2. 核心产品模型

```text
Account
└── Default Profile / User
    ├── Profile
    ├── Life Stage
    │   └── Story
    │       ├── Subject Interview Sessions
    │       │   └── Transcript
    │       ├── Story Share Links
    │       │   └── External Contributor Sessions
    │       │       ├── Transcript
    │       │       └── Contributor Summary
    │       ├── Story Summary
    │       ├── Story Agent Memory
    │       ├── Story Status + Gaps
    │       └── Story Documents / Versions
    │
    └── Book / Memoir Book
        └── Book Items
            └── Selected Story Document Version
```

核心定义：

- **Account**：谁在登录；
- **Profile / User**：正在记录谁的人生；
- **Life Stage**：人生时间结构与 Story 目录；
- **Story**：核心内容生产单元；
- **Interview Session**：一次具体访谈；通过 `source_type` 区分主人公本人采访与外部贡献者采访；
- **Transcript**：原始采访史料；外部贡献者 Transcript 也是原始史料，但不能自动等同于主人公本人事实；
- **Story Share Link**：主人公针对某个 Story 创建的 7 天能力链接；一个链接固定对应一个 relationship 和一个外部贡献者身份；
- **Contributor Summary**：同一分享链接对应受访者的滚动采访记忆，只用于该贡献者后续续访，不自动写入 Story Summary；当前 V1 硬限制为 **400 字以内**；
- **Story Summary**：面向用户和 Story Generation 的持续事实骨架；当前 V1 只由主人公本人采访链路维护；
- **Story Agent Memory**：面向 Interview Agent / Completion 的持久化滚动工作记忆，保存已知事实、已覆盖主题、纠正与不确定信息；不对前端暴露；
- **Story Status / Gaps**：当前是否可成稿，以及下一轮最值得直接问用户的 0～3 个问题；
- **Story Document**：单个 Story 面向用户阅读的正式成稿；
- **Document Version**：每次生成 / 再润色形成的独立版本；
- **Book**：多个 Story Document Version 的组织与最终交付层；
- **Book Item**：Book 中的章节引用，指向 Story 及实际采用的 Document Version。

永久边界：

> **Life Stage = 人生目录；Story = 内容生产单位；Story Document = 单篇正式成稿；Book = 多篇成稿的组织与交付单位。**

Book 不替代 Story，不重新采访，也不重新生成 Story 正文。

---

# 3. 当前功能状态

截至 2026-09-19，比赛 V1 主链路的当前状态：

| 模块 | 状态 | 说明 |
|---|---|---|
| Account / Auth | [已实现] | 比赛版手机号直接登录；个人资料入口显示当前登录手机号；owner scope 以服务端 AuthContext 为准 |
| Onboarding | [已实现][待人工验收] | 人生地图优先 → 阶段边界 → Story Seed；Closeout 后为新建 Stories 运行 Completion |
| Life Stage Main + CRUD | [已实现] | “我的人生” Timeline、阶段 CRUD、Story 分组 |
| Story Realtime Interview | [已实现][待人工验收] | 当前产品 UI 使用 Doubao Seeduplex；支持 Transcript / Session 持久化、真实 barge-in 与明确结束协议 |
| Story Closeout | [已实现][待人工验收] | 更新 Summary，并将独立新经历直接沉淀为 Story Seed；每轮最多 5 个 |
| Completion / Gaps | [已实现][本地自动化已覆盖] | 当前 Story 与本轮新建 Story 都进入正式 Story Readiness 判断 |
| Story Detail | [已实现] | Summary、状态、Gaps、继续采访、成稿入口、亲友分享入口 |
| Story Share / Contributor Interview | [已实现][本地自动化已覆盖][待人工验收] | 7 天分享链接、固定 relationship、免登录外链、同链接连续记忆、独立 Transcript / Contributor Summary |
| Story Agent Memory | [已实现][本地自动化已覆盖][待人工验收] | Story Closeout 同时维护 Summary 与 agent_memory；下一轮 Continue 与 Completion 消费 Agent Memory；历史 Story 由 Summary 回填 |
| Text Model Runtime | [已实现][本地自动化已覆盖] | Story Closeout / Onboarding Closeout / Completion / Generation / Contributor Closeout 统一通过可配置 TextModelProvider；默认云端兼容并支持 loopback OpenAI-compatible Runtime |
| Realtime Voice Provider Runtime | [已实现][本地自动化已覆盖][待人工验收] | Generic Realtime Lifecycle 只消费 normalized events；Doubao / legacy Qwen 各自封装 wire protocol、Audio Spec、输入 shutdown、close plan 与完成信号；默认 Web 行为仍为 Doubao |
| Story Generation | [已实现][本地自动化已覆盖][待人工验收] | 首次成稿与基于历史版本再次润色 |
| Documents / Versions | [已实现] | 多版本保留、只读详情、继续润色 |
| Book Assembly | [已实现][本地自动化已覆盖] | 书籍信息、内容编排、版本选择、排序、预览 |
| PDF Export | [已实现][本地自动化已覆盖] | 封面、目录、正文、封底，多页目录 |
| 打印纸质书 | [规划 / Demo] | 只展示体验入口，不创建真实订单 |
| 出版社出版服务 | [规划 / Demo] | 只展示服务入口，不创建真实出版流程 |

当前 promotion 前仍建议完成：

1. 一轮真实 iPhone Safari Smoke；
2. 一轮 Book 人工闭环：已有 Book → 新 Story 加入 → 历史版本保持 → 排序 → Preview → PDF；
3. Story Generation 的真实模型质量抽样验收；
4. 一轮亲友分享真机闭环：生成链接 → 未登录手机打开 → 第一次采访 → 再次打开同一链接 → 验证连续记忆与主人公事实隔离。

---

## 3.1 Realtime Voice Provider 架构

当前 Realtime 内部边界冻结为：

```text
Web / future mini-program
        │
        ▼
Unified Realtime WebSocket API
        │
        ▼
Generic Interview Lifecycle
        │
        ▼
RealtimeVoiceProvider
   ┌────┴────┐
   ▼         ▼
Doubao    legacy Qwen
```

冻结规则：

- Provider raw WebSocket frame 必须先在 Adapter 内转换为 typed `NormalizedRealtimeEvent`，server lifecycle 不解析 Doubao / Qwen wire event type；
- Audio encoding / sample rate / frame size 由 Adapter 的 `RealtimeAudioSpec` 声明；
- Doubao onboarding sentinel 与 Qwen completion tool call 必须在 Adapter 内统一成 `onboarding.completion.requested`；
- 输入结束、Qwen silence frames、Doubao session.close / session.closed 等 Provider 行为由 `beginInputShutdown()` / `closePlan()` 封装；
- Session 中的 provider 字段继续只作为 metadata / diagnostics 使用，不作为业务生命周期分支；
- Browser Realtime 协议保持兼容，不因内部 Provider 解耦而改变；
- 当前没有 Local / NVIDIA Provider。未来新增 Provider 应主要新增 Adapter + Runtime Config，不改 Story / Onboarding / External Contributor / Transcript / Closeout / Completion 主链路；
- 本轮架构重构没有调整 Doubao/Qwen VAD、采样率、voice、model、barge-in、wrapup、session timeout、close grace 等行为参数。

# 4. Transcript、Summary、Completion、Document 的职责边界

## 4.1 Transcript

Transcript 是最原始、最可信的一手采访资料。

规则：

- 保存完整用户与 AI 对话；
- Closeout 成功后仍永久保留；
- 一个 Story 可对应多次 Session / Transcript；
- Closeout / Completion / Generation 失败不得破坏 Transcript；
- Summary、Document、Book 都不能替代 Transcript。

Story Completion V1 **不读取全部 Transcript 正文**；Story Generation 则使用 Story 的完整事实证据。

### 旁支 Story 的证据

如果 Story 是其他 Story 的 Closeout 自动创建，其事实证据只包括：

```text
直接属于该 Story 的历史 Session Transcript
+
来源 Session 中被 closeout_result_json.source_message_ids
明确引用的 user messages
```

不得把整个来源 Session 无差别混入旁支 Story。

### 亲友补充采访的证据隔离

Story Share 引入第三方视角后，必须区分两类采访来源：

```text
source_type = subject
→ 主人公本人采访
→ 可进入 Story Closeout / Completion / Generation 的既有事实链路

source_type = external_contributor
→ 亲友 / 同事 / 同学等外部贡献者采访
→ 保存独立 Transcript + Contributor Summary
→ 当前 V1 不自动进入主人公 Story Summary / Completion / Generation
```

原因：

- 第三方记忆可能与主人公本人叙述不同；
- 第三方证词是重要史料，但不能在没有证据编排 / 冲突处理机制时被自动提升为主人公事实；
- V1 优先保证“收集更多视角”与“主人公事实链路不被污染”同时成立。

永久规则：

> **外部贡献者原话必须保留；差异可以存在；当前 V1 不由系统自动判断谁对谁错。**

## 4.2 Story Summary

Summary 是面向用户与正式成稿链路的持续事实骨架，主要用于：

- Story Detail 展示；
- 首次 Story Generation 的叙事骨架；
- 人类快速理解当前 Story 已整理到什么程度。

Summary 不要求复制 Transcript 每一个细节，也不再承担 Story Continue 的长期工作记忆职责。

## 4.3 Story Agent Memory

Agent Memory 是 Story 级 Interview 工作记忆，和 Summary 分工明确：

- 只属于主人公 Story 主链路；
- 保存已知事实、已经覆盖的采访方向、用户明确纠正、不确定性与后续采访需要记住的上下文；
- 下一轮 Story Continue 注入 `agent_memory`，不再注入完整历史 Transcript、历史 Q/A 或 `recent_asked_questions`；
- Story Completion 以 Agent Memory 为主要事实输入；
- 当前 Session 的最新明确表达优先于旧 Agent Memory；
- Closeout 必须以旧 Memory 为基线滚动更新，未触及旧信息默认保留；
- 只允许 add / correct / refine / merge / remove 五类显式变化；
- add / correct / refine / remove 必须有本轮用户证据，旧信息无解释消失必须拒绝并进入 repair；
- 内部 `memory_changes` 只用于 Validator / repair，不持久化到 Story，也不暴露给用户；
- 当前软目标约 3000 字符、建议不超过 5000、硬上限 8000 字符；真正 Provider 安全预算还应受最终 instructions token budget 约束。

## 4.4 Story Completion

Completion 只回答两件事：

1. 当前资料是否已足够成稿；
2. 下一轮最值得直接问用户的 0～3 个问题是什么。

正式链路：

```text
Story Interview
↓
Story Closeout
↓
Story.summary + Story.agent_memory 原子更新成功
├─ 当前 Story
└─ 本轮新建 Story Seeds
      ↓
Completion Evaluator
      ↓
stories.status + gaps_json
```

Onboarding 也复用同一个 Completion Evaluator：

```text
Onboarding Closeout 原子写入
↓
Profile + Life Stages + Stories 已提交
↓
对本次创建的每个 Story 运行 Completion
↓
status + gaps_json
```

Completion 是派生步骤。单个 Completion 失败不得回滚已经成功的 Story Closeout 或 Onboarding 原子写入。

正式状态：

```text
pending       → 资料较少
interviewing  → 正在完善
complete      → 已可成稿
```

核心规则：

- Completion 不读取全部 Transcript；
- 输入以 Story title、Agent Memory、当前 status 等轻量上下文为主；Summary 不再是 Completion 的主要事实输入；
- previous gaps 每轮滚动重评：Completion 输入必须包含上一轮有效 gaps，并结合最新 Agent Memory 判断保留、解决、替换或新增；Story Closeout 不得预先清空 gaps，只有 Completion 成功写入后才替换；
- Agent Memory 中用户明确表示“记不清、想不起来、没有印象、无法回忆、不愿继续或不想再聊”的方向视为已耗尽/禁止重复追问方向；Completion 不得生成语义等价的新 gap；
- gaps 最多 3 条，保持 `string[]`，但语义冻结为“下一轮可直接问用户的单一自然问题”：每条只问一个方向、以问号结尾、最多 80 个字符；禁止“缺少 / 信息不足 / 需要补充”类诊断说明；
- 最多 3 次模型调用；
- 失败不回滚已经成功的 Closeout；
- 使用 `updated_at` CAS 防旧结果覆盖新 Story；
- `complete` 必须 Prompt + Persistence 双层 sticky，不能因后续评估回退；
- Realtime Interview 可以判断追问和收尾，但不能正式设置 `complete`。

## 4.5 Story Document

Story Document 是单个 Story 的正式文章成稿。

事实优先级：

> **用户 Transcript 中最新明确表达 > Summary / 历史 Document。**

AI 不得为了文章完整而编造用户没有提供的事实。

---

# 5. Onboarding、Life Stage 与 Story 主流程

## 5.1 Onboarding

目标是快速建立人生地图，不是深挖每个 Story。

当前访谈顺序冻结为：

```text
Phase 1：人生时间线 / 主要阶段骨架
↓
Phase 2：确认明显阶段边界与时间空档
↓
Phase 3：每个主要阶段至少保留一个 Story Seed
↓
Onboarding Closeout 原子写入
↓
Profile + Life Stages + Stories
↓
Story Completion（逐个新 Story）
↓
我的人生
```

核心规则：

- 首次建档必须“人生地图优先、故事细节靠后”；
- Profile 中的“人生概况”是 Facts，不是时间线摘要：只保留 3–6 个跨阶段仍有价值的明确事实，不按“后来 / 之后 / 随后”复述 Life Stage；
- 遇到具体事件时，只确认“发生了什么、属于哪段人生”，然后回到时间线；
- 某一个 Story 聊得非常详细，不能替代主要人生阶段的覆盖；
- Life Stage 表示持续一段时间相对稳定的环境、身份、角色或生活结构；
- 不机械按小学 / 初中 / 高中切段，也不能把环境明显不同的多年经历压成一个“求学生涯”超级阶段；
- Story 是可以独立命名和后续采访的一件事件 / 经历；同一 Life Stage 可以有多个 Story；
- 禁止创建“我的求学生涯”“小学到大学的学习生活”之类吞并多年独立事件的超级 Story；
- Onboarding 处理页在本轮 Story Completion 尚未结束时保持 processing，不提前宣告全部完成。

当前不增加：

- Checklist UI；
- 百分比完成度；
- 服务端逐轮 Completion Judge；
- Life Stage 专门 Interview。

## 5.2 “我的人生”

Life Stage 是 Timeline 目录，Story 是内容单位。

```text
我的人生
├─ Life Stage
│   └─ Story
│       └─ Story Detail
└─ 制作我的人生书
    └─ Book
```

“制作我的人生书”是页面级能力入口，应清晰可见，但不压过 Life Stage / Story 主内容。

## 5.3 Story Interview / Closeout / Result

### Interview 四种产品场景

当前产品必须从产品行为和验收层明确区分 **4 种 Interview 场景**：

| 场景 | 产品含义 | 当前路由 / mode | 主要上下文 | 会后处理 |
|---|---|---|---|---|
| 1. 首次建档 | 第一次认识主人公并建立人生地图 | `interview_type=onboarding` | Profile 草稿 / Onboarding task context | Onboarding Closeout → Profile / Life Stages / Story Seeds → Completion |
| 2. Story 新建 | 用户从某个 Life Stage 主动开始讲一段尚不存在的新 Story | `interview_type=story` + `target.mode=create` | Life Stage + 可选目标标题；开始时没有既有 Story Memory | Story Closeout 创建 / 更新目标 Story → Agent Memory → Completion |
| 3. Story 续访 | 围绕已经存在的 Story 继续补充 | `interview_type=story` + `target.mode=continue` | Story title + Agent Memory + status + gaps | Story Closeout 滚动更新 Summary / Agent Memory → Completion |
| 4. 第三者访谈 | 亲友 / 同事等通过分享链接从自己的视角补充同一 Story | `interview_type=external_contributor` | Story 当前公开信息 + relationship + 该 share_id 的 Contributor Summary | 独立 Contributor Closeout → Contributor Summary；不得进入主人公事实链路 |

这里的“4 种”是**产品场景数**，不要求代码必须实现 4 个独立 Strategy 类。当前 Story 新建和 Story 续访可以继续复用同一个 Story Interview Strategy，通过 `target.mode=create / continue` 分流；首次建档与第三者访谈拥有各自独立策略与 Closeout 语义。

四种场景共同使用统一 Realtime Provider 抽象，但 Context、开场、允许写入的数据和会后工作流不能串线。

### Story Realtime Interview

Story 新建与 Story 续访共用主人公 Story Realtime 基础协议；其中续访的自动结束不是按固定轮数硬切。

续访提问规则：

- 第一问优先直接使用当前最高优先级的合法 `gaps[0]`，只问一个问题，不朗读“缺少……”等内部诊断文本；
- 同一语义方向默认只问一轮；只有用户主动带出新的具体线索时，才允许再追问一轮；
- 用户已经实质回答后应切换到另一个尚未覆盖的方向；用户说“问过了”“继续”“换一个”时，本场不要再回到该方向；
- 准备页“可以从这里开始”直接显示最新 gap；其余 gap 作为次级问题。

约 8–10 个有效回答只作为软参考。AI 主动结束前应综合满足：

- 当前 Story 已获得实质补充；
- 重要 gaps 已经问过，或用户明确不愿 / 无法继续；
- 最近连续 2–3 轮新增信息明显下降；
- 当前没有一个明显、顺手就应该继续追问的关键点。

AI 主动结束时最后且只能明确说：

> **本次先聊到这里，再见。**

普通的“谢谢分享”“感谢你讲这些”不属于自动结束信号。用户明确要求结束时则立即尊重，不要求先满足完成标准。

### Story Closeout

Story Closeout 负责：

- 整理本次 Interview 新增 / 修正事实；
- 更新 Story Summary；
- 识别并直接创建独立 Story Seed。

Story Seed 的创建门槛：

- 用户明确讲到一件真实发生的独立事件；
- 可以独立命名；
- 可以归入已有 Life Stage；
- 与当前 Story / 已有 Story 不是同一核心事件；
- 至少具有“发生了什么”以及一项具体上下文或细节。

Story Seed **不要求已经采访完整**。同一 Life Stage 可以创建多个新 Story，也允许在当前 Story 访谈中发现属于其他 Life Stage 的新 Story。每轮最多创建 5 个。

Story Closeout 本身不判断 gaps / complete；写库成功后，由 Completion Evaluator 对当前 Story 与本轮所有新 Story 逐个评估。

### Story Result

Story Result 回答“刚才这次采访更新了什么”，正常用户路径最终回到“我的人生”。

只要 Session 收尾、Closeout 或 Story Completion 仍在运行，结果页都保持明显的 processing 状态。Story 手动点击结束后，服务端一确认进入 ending，客户端就立即进入 Result Processing；服务端继续后台 drain 最后一段 Transcript，再结束 Session、Closeout、Completion。用户无需停留在结果页，可以点击“先回到我的人生”；离开页面不会取消后台处理。

### Story Share / External Contributor Interview

主人公可以在 Story Detail 创建亲友补充采访链接。

V1 冻结规则：

1. 创建链接前必须选择 relationship，例如妻子、丈夫、女儿、儿子、父母、兄弟姐妹、朋友、同学、同事、其他；
2. 分享链接默认有效期 7 天；
3. **一个链接 = 一个固定贡献者 = 一个固定 relationship**；同一链接不得在后续采访中改变 relationship；
4. 外部受访者不创建 Account / User，也不需要登录；
5. 外链只展示当前 Story 的标题、状态、Summary、gaps 和邀请关系，不暴露主人公内部 userId、Session ID、数据库字段或 Debug 信息；
6. 外链每次打开都读取 Story 当前最新内容，不生成静态快照；
7. 同一分享链接多次进入时，采访官必须带入该链接自己的 `contributor_summary`，避免把已经讲过的内容当作第一次采访；
8. Contributor Summary 是滚动记忆，不是全文归档；**每次整理后的最终结果必须控制在 400 字以内**，不再额外增加独立压缩环节；
9. 每次外部采访保留完整 Transcript；会后只更新该链接自己的 Contributor Summary；
10. Contributor Closeout 发生瞬时失败时服务端最多自动尝试 3 次；仍失败则 Transcript 保留、Session 标记 failed，前端不得显示“保存成功”；
11. failed Closeout 允许受访者通过当前分享链接点击“重新整理”，直接重试最近一次失败 Session，不要求重新讲述；
12. 外部采访不得触发主人公 Story Closeout、Story Completion、Story Summary 更新或自动成稿；
13. 普通 Story Closeout 的 claim、ContextBuilder 和最终持久化层都必须拒绝 `source_type = external_contributor`；
14. 外部贡献者与主人公叙述发生冲突时，保留差异，不自动裁决；
15. 链接过期或被撤销后不能新开采访；已经开始的 Session 允许正常收尾，并允许对其失败 Closeout 做重试；
16. 空采访 / 没有有效 user turn 时，不增加 interview_count，也不伪造 Contributor Summary。

当前产品价值：

> **让同一个 Story 从“主人公单视角”扩展为“可持续收集多方口述史料”，但不牺牲既有事实链路的可信边界。**

---

# 6. Story Detail、Generation 与 Document Versions

## 6.1 Story Detail

用户进入 Story Detail 应能快速理解：

1. 这段故事已经整理成什么样；
2. 当前是资料较少 / 正在完善 / 已可成稿；
3. 下一轮最值得继续聊什么；
4. 是否已经可以生成 Story Document。

操作规则：

所有状态都提供低于主任务的“分享给亲友”入口。分享不是 Completion 前置条件，也不影响“继续聊 / 润色成稿”的主次关系。

### pending / interviewing

- 主操作：继续聊；
- 显示 0～3 条 gaps；
- “润色成稿”保留但置灰。

### complete

- 显示“已可成稿”；
- 开放“润色成稿”；
- complete 后仍可继续 Interview；
- 已有多个版本时可以显示版本数量。

Book 不在 Story Detail 内编辑；Book 是“我的人生”级别能力。

## 6.2 Documents 页面结构

正式结构：

```text
Story Detail
↓
Documents List
↓
Document Detail
```

首次成稿：

```text
Story Detail
↓ 点击“润色成稿”
Documents List 空状态
↓ 点击“生成第一版”
Generation Modal
```

不得通过 URL 参数或页面加载自动弹出 Generation Modal。

Documents List：

- 版本倒序展示；
- 点击进入 Document Detail；
- 不做 Version Diff、版本树、删除恢复。

Document Detail：

- 正文只读；
- 显示版本号与生成时间；
- 可基于当前版本再次润色。

## 6.3 Generation Modal

固定 Style：

```text
默认纪实
温暖叙事
克制口述
文学化
```

User Instruction 可以为空。

比赛 V1 不提供：

- 语音润色意见；
- 自定义 Style；
- 用户可见 temperature / token；
- 复杂长度与文章结构设置。

## 6.4 两种 Generation Mode

### Mode A：首次成稿

```text
Profile 必要背景
+
Life Stage 必要背景
+
Story.title
+
Story.summary             ← 叙事骨架
+
Story 完整 subject 事实证据 ← 事实边界（当前 V1 排除 external_contributor Transcript）
+
Style
+
User Instruction
↓
Document V1
```

### Mode B：基于历史版本再次润色

```text
Selected Document         ← 本轮唯一文章骨架
+
ALL latest subject Story evidence ← 最新完整事实边界（当前 V1 排除 external_contributor Transcript）
+
必要 Profile / Life Stage 背景
+
Style
+
User Instruction
↓
Document Vn
```

Mode B 不再让 Summary 成为第二套文章骨架。

Generation Runtime 当前默认 `maxOutputTokens = 8192`。

## 6.5 Document Version

每次生成 / 再润色创建新版本：

```text
MAX(version_number) + 1
```

旧版本永久保留，不覆盖。

新 Interview 后：

- 不自动生成新 Document；
- 不自动替换 Book 中已经选定的旧版本；
- 用户可以在 Book 中主动改选新版本。

---

# 7. Book / Memoir Book V1

## 7.1 产品职责

Book 的目标是：

> 把用户已经拥有的多个 Story Document Version，按人生结构组织成一本可预览、可导出的完整人生书。

Book 不负责：

- Interview；
- Summary；
- Completion；
- Story Generation；
- 全书 AI 重写。

Book V1 本质：

```text
Selected Story Document Versions
+
章节顺序
+
Life Stage 结构
+
书名 / 作者
+
简单封面
+
自动目录
↓
Book
```

## 7.2 默认内容来源

Book 默认：

```text
Life Stage 顺序
↓
该阶段下 Story 顺序
↓
每个 Story 默认最新 Document Version
```

只有存在 Story Document 的 Story 才能直接进入 Book。

没有 Document 的 Story 默认不进入 Book，也不会为了补齐一本书自动触发 Generation。

### 已有 Book 的长期规则

已有 Book 再次打开时：

- 保留用户已经选择的 Document Version；
- 保留 included 状态；
- 保留用户在阶段内的排序；
- 如果后来出现新的、已经有 Document 的 Story，应自动加入 Book 候选；
- 新 Story 默认 `included = true`，默认最新 Document；
- 已有 Story 即使后来出现新 Document，也**不自动升级用户原来选择的版本**。

## 7.3 三步流程

Book 使用移动端优先的三个独立页面 / 页面状态：

```text
Step 1：书籍信息
↓
Step 2：内容编排
↓
Step 3：成书与交付
```

不得把三步实现成同一页面连续向下滚动的三个超长区块。

### Step 1：书籍信息

设置：

- 书名；
- 作者名；
- 简单封面风格。

本页不常驻展示整本正文。

### Step 2：内容编排

支持：

- 选择 Story 是否收录；
- 为 Story 选择 Document Version；
- 调整章节顺序；
- 按 Life Stage 展示人生结构；
- 打开按需全书预览。

排序规则：

- Life Stage 顺序固定；
- V1 只允许 Story 在**同一 Life Stage 内**调整顺序；
- 服务端必须拒绝跨 Life Stage、阶段回穿等非法持久化顺序；
- UI 显示顺序、DB `sort_order`、Preview、PDF 必须一致。

### Step 3：成书与交付

显示：

- 当前书名；
- 已收录章节数量；
- “预览整本书”；
- 三个并列交付选项。

```text
├─ 导出 PDF 电子书【真实功能】
├─ 打印纸质书并邮寄到家【Demo】
└─ 出版社出版服务【Demo】
```

三者是平行关系，不是先 PDF → 再打印 → 再出版的顺序流程。

## 7.4 Book Preview

Preview 是按需打开的独立全屏层 / 页面状态，不是固定第四步。

明确禁止：

- 在 Step 1 / 2 / 3 底部常驻完整电子书；
- 让十万字级正文把配置页变成超长滚动页。

打开 Preview：

- 保存当前 Book 配置；
- 按当前 selected Document Version 读取正文；
- 展示目录与章节。

关闭 Preview：

- 返回进入预览前的步骤；
- 保留书名、作者、收录选择、Document Version、章节顺序；
- 浏览器 history 不制造重复 Preview 记录或 Back 循环。

## 7.5 Book 非目标

V1 不做：

- 序言 / 前言生成和编辑；
- 整本书富文本编辑器；
- Word 类专业排版；
- 模板商城；
- AI 自动重写所有 Story；
- 章节 Diff；
- 多人协作；
- Book 复杂版本树；
- 出版工作流管理系统。

---

# 8. PDF 与最终交付

## 8.1 PDF Export

PDF 是比赛 V1 唯一真实要求的完整电子书导出格式。

不扩展：

- EPUB；
- MOBI；
- Word；
- Kindle 格式。

PDF 最小结构：

```text
封面
↓
书名 / 作者
↓
目录（允许多页）
↓
章节正文
↓
封底
```

正文必须严格来自 Book Item 实际指向的 Document Version。

PDF Export：

- 不调用大模型；
- 不重新生成或改写正文；
- 目录可以跨多页，不能因单页空间不足而截断后续章节；
- included=false 的 Story 不进入目录与正文；
- 目录章节数、最终正文章节数、Book included 数量应一致。

序言 / 前言不是 V1 PDF 必需内容。

## 8.2 打印纸质书 Demo

产品可以展示：

```text
打印纸质书
专业排版 · 印刷装订 · 邮寄到家
```

但 V1 不实现：

- 下单；
- 支付；
- 地址；
- 印刷厂 API；
- 物流；
- 订单状态；
- 售后。

不得在产品或比赛材料中表述为“已经真实接入”。

## 8.3 出版社出版服务 Demo

可以展示：

```text
出版社出版服务
编辑审校 · 出版对接 · 正式出版
```

但 V1 不实现：

- 出版社接口；
- ISBN / 书号；
- 合同；
- 支付；
- 审校后台；
- 出版进度管理。

---

# 9. AI Task、Agent 与 Provider 边界

当前 AI Task：

```text
interview.story
interview.onboarding
closeout.story
closeout.onboarding
completion.story
generation.story
```

当前 V1 **不新增**：

```text
generation.book
full_memoir
```

Book Assembly、Preview、PDF Export 都是普通业务 / 渲染能力，不需要新模型 Provider。

Realtime Provider 当前策略：

- 产品 UI 当前只暴露 Doubao Seeduplex；
- Qwen Realtime 不再作为近期产品选项，新功能不再为 Qwen 单独适配；
- 现有 Qwen Adapter 暂时保留为 inactive / legacy provider-contract 实现；
- 必须继续保留 `RealtimeInterviewProvider` / Provider Adapter 抽象，不能把 Interview 业务逻辑写死到 Doubao；
- 后续 NVIDIA / DGX Spark 方向优先新增 `LocalRealtimeProvider`，可组合本地 VAD / ASR / LLM / TTS，或接入未来可用的一体化本地 realtime speech 模型；
- 上层 Interview 继续只消费统一 speech / transcript / assistant / response 生命周期事件。

原则：

- Story Context / Prompt Builder 不因 Book 改变；
- Book 逻辑不要塞入 `StoryGenerationContextBuilder`；
- Interview、Closeout、Completion、Generation 保持模块职责分离；
- Book 不成为新的 Agent，只负责确定性组织。

---

# 10. 数据模型与 Owner Scope

## 10.1 Owner Scope

所有业务资源必须使用服务端 AuthContext 中的当前 `user_id` 校验 owner。

覆盖：

- Profile；
- Life Stage；
- Story；
- Interview Session；
- Transcript；
- Memoir Document；
- Completion / Gaps；
- Story Generation；
- Book；
- Book Items；
- Preview；
- PDF Export。

前端传入的 userId 不可信，不能作为授权依据。

Story Share 是唯一例外的“未登录业务入口”，但它不是匿名 owner scope：服务端必须先通过高熵 share token 解析出固定的 `user_id + story_id + share_id`，客户端无权自行指定 owner 或目标 Story。

## 10.2 核心业务表

当前核心业务数据：

```text
accounts
users
life_stages
stories
interview_sessions
story_share_links
memoir_documents
memoir_books
memoir_book_items
```

比赛 V1 不新增订单、支付、物流、出版流程表。

## 10.3 stories

关键字段：

```text
story_id
user_id
stage_id
title
summary
agent_memory
status
gaps_json
created_source_session_id
created_at
updated_at
```

Book 不向 Story 增加“成书状态”。

## 10.4 interview_sessions

保存：

- Session；
- Transcript；
- Closeout 状态；
- Closeout Result；
- 来源证据链。

Book 不修改 Interview Session 数据。

Story Share 新增两个来源字段：

```text
source_type
source_share_id
```

其中：

- `session_type=onboarding`：首次建档；
- `session_type=story, source_type=subject`：主人公 Story 新建或续访，二者由启动 Context 的 mode 区分；
- `source_type=external_contributor`：分享链接进入的第三者访谈；

来源字段语义：

- `subject`：主人公本人采访；
- `external_contributor`：分享链接进入的外部贡献者采访；
- 老 Session 默认视为 `subject`；
- 删除 Share Link 时历史 Session 保留，`source_share_id` 可置空；
- 删除 Story 时历史 Session 按既有规则保留并解除 Story 关联。

## 10.5 story_share_links

核心字段：

```text
share_id
story_id
user_id
token_hash
relationship
contributor_summary
status
expires_at
interview_count
last_interview_at
created_at
updated_at
```

规则：

- 数据库只保存 token hash，不保存分享 URL 中的明文 token；
- `story_id + user_id` 必须保持 owner 一致；
- 一个 share_id 的 relationship 创建后固定；
- Contributor Summary 只属于这个 share_id；
- Story 删除时 Share Link 级联删除；
- revoked / expired 链接不能创建新 Session。

## 10.6 memoir_documents

比赛 V1 的正式内容主要使用：

```text
scope_type = story
```

如旧 schema 仍保留 `full_memoir` 扩展位，可以兼容存在，但 Book V1 不依赖它。

Document 保留多版本和来源信息。

## 10.7 memoir_books

最小职责：

```text
book_id
user_id
title
author_name
cover_config_json
created_at
updated_at
```

V1 不设计复杂出版状态机。

## 10.8 memoir_book_items

核心字段：

```text
book_item_id
book_id
story_id
document_id
sort_order
included
created_at
updated_at
```

必须保证：

- Story 属于当前用户；
- Document 属于当前用户；
- Document 必须属于对应 Story；
- 一个 Book 中同一 Story 不重复；
- `sort_order` 与 Life Stage 固定顺序兼容；
- `included = false` 表示保留配置但不进入最终书。

---

# 11. 页面与核心 API

## 11.1 页面主路径

```text
Login
↓
Onboarding（Interview 场景 1：首次建档）
↓
我的人生
├─ Life Stage / Story
│   ├─ New Story Interview（Interview 场景 2：Story 新建）
│   └─ Story Detail
│       ├─ Continue Interview（Interview 场景 3：Story 续访）
│       ├─ Share to Contributor
│       │   └─ Public Story Share → External Contributor Interview（Interview 场景 4：第三者访谈）
│       └─ Documents / Versions
└─ 制作我的人生书
    ├─ Book Step 1：书籍信息
    ├─ Book Step 2：内容编排
    │   └─ Book Preview
    └─ Book Step 3：成书与交付
        ├─ Book Preview
        ├─ PDF
        ├─ 打印 Demo
        └─ 出版 Demo
```

## 11.2 Story Share API

当前核心接口：

```text
POST   /api/stories/:storyId/share-links
GET    /api/stories/:storyId/share-links
DELETE /api/story-share-links/:shareId
GET    /api/public/story-share/:token
WS     /api/realtime?share_token=:token
```

要求：

- 创建 / 列表 / 撤销必须使用当前登录 owner；
- 公共读取与 Realtime 握手通过 share token 授权；
- 明文 token 只在创建响应和用户持有的 URL 中出现；
- 公共接口不得返回内部 userId / shareId / Session ID；
- 无效、撤销、过期 token 必须拒绝；
- Realtime 服务端必须从 token 解析目标，不能信任客户端传入 Story / relationship。

## 11.3 Book API

当前 Book 核心接口：

```text
GET  /api/book
PUT  /api/book
GET  /api/book/preview
GET  /api/book/export.pdf
```

基本要求：

- 必须认证；
- PUT 做 same-origin 校验；
- owner scope 只使用当前登录用户；
- Preview / PDF 只读取该用户自己的 Book；
- Document 引用必须属于同一用户和同一 Story。

---

# 12. 核心验收标准

这里仅保留真正保护产品闭环的验收，不重复视觉实现细节。

## 12.1 Onboarding

至少保证：

- Realtime 访谈优先建立连续人生地图，不因某个 Story 很有趣而提前深挖；
- Life Stage 边界依据环境 / 身份 / 角色 / 生活结构变化，不机械按年龄或学段切分；
- 不生成跨多年吞并独立事件的超级 Story；
- 自然访谈可以生成 Profile / Life Stages / Stories；
- 每个主要阶段至少有一个可继续采访的 Story Seed；
- source refs 只指向真实用户证据；
- Closeout 原子落库；
- 本次创建的每个 Story 都会进入 Completion；
- Completion 失败不回滚已提交的 Profile / Stage / Story；
- Completion 运行期间结果保持 processing；
- 重试幂等；
- 失败不留下半套 Profile / Stage / Story；
- owner scope 正确；
- Transcript 不因 Closeout 丢失。

## 12.2 Interview 四场景

至少保证：

- 首次建档只能进入 Onboarding Context / Onboarding Closeout；
- Story 新建必须以 `target.mode=create` 启动，绑定目标 Life Stage，不能伪装成已有 Story Continue；
- Story 续访必须以 `target.mode=continue` 启动并读取目标 Story Agent Memory / gaps；
- 第三者访谈必须由有效 share token 解析 owner / Story / relationship，客户端不能自行指定这些内部身份；
- Story 新建与续访虽然复用 Story Strategy，但测试和人工验收必须分别覆盖；
- 第三者 Session 必须标记 `source_type=external_contributor`，普通主人公 Session 必须保持 `source_type=subject`；
- 四种场景的 Transcript 都要可靠保存，但会后 Closeout 与事实写入范围必须严格隔离。

## 12.3 Completion

至少保证：

- Story Closeout 后，当前 Story 与本轮所有新 Story 都触发 Completion；
- Onboarding Closeout 后，本轮所有新 Story 都触发 Completion；
- 不读取全部 Transcript；
- previous gaps 滚动重评，Completion 失败时保留旧 gaps；
- Agent Memory 中明确“记不清 / 无法回忆 / 不愿继续”的方向不得重新生成等价 gap；
- gaps ≤ 3；
- strict Schema / Validator；
- 有限重试；
- 单个 Completion 失败不回滚 Closeout / Onboarding；
- CAS 防旧评估覆盖新 Story；
- complete sticky；
- Realtime 不直接正式宣告 complete；
- 日志能判断 Completion 是否运行、模型给出什么 status/gap 数量、最终是否真的产生状态变化，但不得打印用户长文本。

## 12.4 Story Generation

至少保证：

- 只有 complete Story 才能真实生成；
- pending / interviewing 的按钮不可用；
- Mode A = Summary 骨架 + 完整 Story evidence；
- 旁支 Story 只继承 source_message_ids 指向的事实；
- Mode B = Selected Document 骨架 + 最新完整 evidence；
- Selected Document 必须属于当前 user / Story；
- 模型失败或结构错误不创建半成品 Document；
- 新 Interview 不自动生成新版本。

## 12.5 Story Share / Contributor Interview

至少保证：

- Owner 可针对自己的 Story 创建 7 天链接并固定 relationship；
- 明文 token 不落库；
- 未登录访问者可以读取允许公开的 Story 最新信息；
- 同一链接多次采访复用同一 Contributor Summary；
- 两个不同链接的 Contributor Summary 互不串线；
- 外部 Session 标记为 `external_contributor`；
- 外部 Transcript 不计入主人公 Completion session count；
- 外部 Transcript 不进入当前 Story Generation 的 subject evidence；
- 空采访不推进 interview_count；
- revoked / expired token 不能新开 Session；已开始 Session 的失败 Closeout 仍可完成重试；
- 普通 Story Closeout 必须拒绝 external_contributor Session；
- 删除 Story 后分享链接立即失效，历史 Session / Transcript 不因 Share Link 删除而丢失。

## 12.6 Book

至少保证：

- “我的人生”存在 Book 入口；
- 三步是独立页面状态；
- 已有 Book 再打开恢复配置；
- 新 eligible Story 能进入已有 Book；
- 已选择的历史 Document 不因新版本出现而自动升级；
- Story 只在同 Life Stage 内排序；
- 非法跨阶段顺序服务端拒绝；
- UI / DB / Preview / PDF 顺序一致；
- included=false 不进入 Preview / PDF；
- Preview 按需打开，关闭后返回原步骤且配置不丢；
- Preview history 不产生循环。

## 12.7 PDF

至少保证：

- 内容严格来自 Book 选定版本；
- 目录与正文顺序一致；
- 多页目录不截断；
- 40～50 章节场景最后章节仍存在于目录和正文；
- included item 数 = TOC 章节数 = 正文章节数；
- PDF 不调用大模型；
- 可以真实导出。

## 12.8 UI / 真机

自动化只保护稳定的产品行为，不用大量 CSS 字符串测试替代真实视觉检查。

人工 Smoke 建议覆盖：

- iPhone Safari Interview Pre-call；
- 地址栏展开 / 收起后的通话布局；
- 长问题滚动；
- 静音 / 扬声器 / 结束通话触摸区域；
- Doubao 长回答完整播放，不因误判 speech_started 截断；
- 用户真实插话时能够正常 barge-in；
- AI 主动结束时完整说出“本次先聊到这里，再见。”后再挂断；
- 普通“谢谢分享”不会误触自动挂断；
- Story Result 在 Closeout / Completion 期间 spinner 持续可见，并允许“先回到我的人生”；
- Profile Popover 显示当前登录手机号；
- 普通 UI 不再显示 Qwen Provider 选项；
- Story Summary 展开全文；
- Book 三步；
- Preview 开关；
- PDF 入口。

---

# 13. 测试与开发原则

比赛 V1 的测试目标：

> **更少的脆弱测试 + 更强的业务不变量保护 + 更快的开发反馈。**

优先测试：

- owner scope；
- 数据不丢失；
- 状态不可错误回退；
- Story / Document 引用正确；
- Book 版本与排序正确；
- Preview / PDF 内容正确；
- 原子性与幂等。

减少或避免：

- 精确 CSS 字号 / padding 正则；
- class 名库存式测试；
- Prompt 某句中文必须完全一致；
- 重复启动服务器只验证静态资源 200；
- 每次小修改都运行全部集成套件。

真实 Provider 测试继续与默认本地测试分离，不在普通 `npm test` / merge verify 中消耗外部模型额度。

开发时：

1. 先跑受影响的 targeted tests；
2. 优先测试“完整用户行为 + 业务不变量”，而不是只锁实现细节；
3. Realtime 改动至少覆盖：播放不中断、真实 barge-in、明确结束协议、用户主动结束；
4. Closeout 改动至少覆盖：Summary、Story Seed、跨 Stage、新 Story Completion、失败隔离；
5. Onboarding 改动至少覆盖：人生地图优先、Stage / Story 粒度、全部新 Story Completion、processing pending；
6. 修改完成后再跑完整 deterministic local verify；
7. 真实 Doubao Smoke 与默认本地测试分离，只有人工 / 显式命令才消耗外部模型额度；
8. Interview Core / Realtime 改动必须分别覆盖四种产品场景：Onboarding、Story Create、Story Continue、External Contributor；不得只测 Story Strategy 一条 happy path；
9. Story Share 改动至少覆盖：token 生命周期、relationship 固定、连续记忆、不同贡献者隔离、主人公证据隔离、空采访、撤销 / 过期；
10. Text Provider / Runtime 改动至少覆盖默认云端兼容、通用远程 HTTPS、loopback HTTP、local no-key、安全 Endpoint 拒绝，并确保 Contributor Closeout 也走同一 Provider 抽象；
11. 不因为测试失败而削弱正确的产品规则。

---

# 14. 比赛 V1 明确不做 / 后移

## 14.1 Story / Completion / Document

当前不做：

- Completion 百分比；
- Completion 全量 Transcript 输入；
- Completion reasoning 持久化；
- Completion 历史版本表；
- stale 状态机；
- 后台 retry worker / queue；
- Gap topic / priority / suggested_question 复杂结构；
- 一次显示超过 3 条 Gap；
- 独立 Generation Page；
- 语音润色 Instruction；
- 自定义 Style；
- 用户可见 temperature / token；
- Document 正文手工富文本编辑；
- Version Diff / 分支图 / 删除恢复；
- 自动根据新 Interview 生成新 Document；
- 自动把 external_contributor Transcript 合并进主人公 Story Summary；
- 自动用亲友证词改变 Story Completion；
- 自动把亲友证词写入 Story Document；
- 外部贡献者注册 / 登录；
- relationship 身份真实性验证；
- 多人协同编辑或冲突裁决工作台。

## 14.2 Onboarding / Account

当前不做：

- Onboarding Checklist UI；
- Onboarding 逐轮 Completion Judge；
- Life Stage Interview；
- Life Stage Document；
- 多 Profile / 家庭共享 / RBAC。

## 14.3 Book / 最终交付

当前后移：

- 序言 / 前言 / 致谢生成与编辑；
- Full Memoir AI Generation；
- 整本书重新 AI 创作；
- 富文本书籍编辑器；
- Word 类专业排版；
- 复杂模板商城；
- AI 自动统一重写所有 Story；
- 章节 Diff；
- Book 多人协作；
- Book 复杂版本树；
- 印刷厂 API；
- 真实订单 / 支付 / 地址 / 物流 / 售后；
- 出版社 API；
- ISBN / 合同 / 审校后台 / 出版进度管理。

同时禁止为了“架构漂亮”大规模重构已经验证的 Story 主链路。

---

# 15. 安全与事实原则

1. Demo Phone Auth 是比赛 Tradeoff，正式生产未来应恢复 SMS 或等价验证；
2. 不信任前端 userId；
3. 所有业务资源必须 owner-check；
4. API Key 不进入业务 DB 或模型 Context；
5. Transcript 属于敏感个人内容；
6. AI 写入人物事实必须有用户证据；
7. Story Generation 不能为了文章完整而编造事实；
8. 用户 Transcript 是最终原始事实依据；
9. Completion 是派生判断，不能破坏事实层；
10. Realtime 采访官不是正式 Completion Judge；
11. 旁支 Story 只能继承明确引用的用户证据；
12. Book 不重新生成事实，只引用选定 Story Document Version；
13. PDF Export 不通过 AI 改写 Story 正文；
14. Share token 必须使用高熵随机值且只存 hash；
15. 外部访问者不能通过参数选择 owner / Story / relationship；
16. External Contributor Transcript 是敏感口述资料，必须保存来源身份边界；
17. 外部证词与主人公叙述冲突时不得自动判断真伪或覆盖主人公事实。

---

# 16. 当前待确认 / 生产化前事项

这些事项不阻塞比赛 V1：

### A. Story 删除策略

软删除还是强确认永久删除仍待确认。

### B. Document Version 并发唯一约束

当前 `MAX(version_number)+1` 足够比赛流程；生产化前建议增加数据库唯一约束与并发冲突处理。

### C. Book 视觉模板

V1 已冻结“简单封面 + 自动目录 + 基础排版”，但具体字体、页边距、更多封面样式不属于当前产品逻辑。

### D. 序言 / 前言

未来版本再确定：

- 用户自己写还是 AI 生成；
- 是否允许单独编辑 / 再生成；
- 数据来源；
- PDF 固定位置。

在规则冻结前，开发 Agent 不得自行增加序言链路。

### E. Full Memoir AI Generation

继续后移，不是当前 Book V1 的实现方式。

### F. External Contributor Evidence Promotion

当前 V1 只“采集并隔离保存”外部证词。未来若允许外部证词进入正式 Story Document，需要先冻结：

- 证词引用 / attribution 方式；
- 多来源冲突展示；
- 主人公确认机制；
- Generation 如何区分第一人称本人事实与第三方观察；
- 是否允许主人公选择某条外部证词进入正式成稿。

规则冻结前，开发 Agent 不得自行把 external contributor evidence 混入现有 subject Generation。

---

# 17. 当前最终产品主链路

```text
手机号直接登录（比赛 Demo）
↓
Account + Default Profile
↓
Interview 1：Onboarding / 首次建档
↓
Profile + Life Stages + Story Seeds
↓
Story Completion
↓
我的人生
├─ Interview 2：Story 新建（从 Life Stage 发起）
│   ↓
│  Story Create Interview
│   ↓
│  Subject Transcript
│
└─ Existing Story
    ├─ Interview 3：Story 续访
    │   ↓
    │  Story Continue Interview
    │   ↓
    │  Subject Transcript
    │
    └─ 分享给亲友
        ↓
       7 天 Share Link
        ↓
       Interview 4：External Contributor / 第三者访谈
        ↓
       External Transcript + Contributor Summary
    ↓
   与主人公事实链路隔离保存

主人公主链路：
Transcript
↓
Story Closeout
↓
Story Summary
↓
Completion Evaluator
↓
继续采访
↓
Story complete
↓
用户主动生成 Story Document
↓
Document V1 / V2 / V3...
↓
多个 Story 已形成正式 Documents
↓
制作我的人生书
↓
Step 1：书籍信息
↓
Step 2：内容编排
├─ Story 收录
├─ Document Version
├─ 同 Life Stage 内排序
└─ 按需 Book Preview
↓
Step 3：成书与交付
↓
├─ PDF 电子书【真实】
├─ 打印纸质书【Demo】
└─ 出版社出版【Demo】
```

这条链路是比赛 V1 的产品、技术与演示共同基准。

---

# 18. V1.5.3 相比 V1.5.2 的变化

1. Story Detail 新增“分享给亲友”能力；
2. 新增 7 天 Story Share Link，一个链接固定映射一个 relationship 与一个贡献者身份；
3. 外部贡献者无需 Account / 登录，使用高熵 share token 访问允许公开的 Story 最新信息并进入 Realtime；
4. 同一 share_id 跨 Session 维护独立 contributor_summary，实现连续采访；
5. interview_sessions 新增 source_type / source_share_id，明确区分 subject 与 external_contributor；
6. external contributor Transcript 永久保留，但当前 V1 不自动进入主人公 Story Summary / Completion / Generation；
7. 主人公 Completion session count、recent interview history 与 Story Generation evidence 只读取 subject Session；
8. 外部证词冲突只保留差异，不自动裁决；
9. revoked / expired 链接拒绝新访问；已开始 Session 允许正常收尾；
10. token 仅以 hash 入库；公共 API 不暴露内部 owner / Session 标识；
11. 空外部采访不推进 contributor memory；
12. 新增 Story Share 的 deterministic regression 与真机 Smoke 验收要求；
13. 产品层正式冻结 4 种 Interview 场景：首次建档、Story 新建、Story 续访、第三者访谈；Story Create / Continue 允许共用 Story Strategy，但必须作为两个独立产品场景测试；
14. 同步 V1.5.2 当前主线的 Story Agent Memory：Summary 面向用户 / Generation，Agent Memory 面向 Continue / Completion；
15. Contributor Closeout 接入当前统一 TextModelProvider，不恢复旧模型调用耦合；
16. 合并后数据库迁移顺序冻结为 `0008_story_agent_memory.sql` → `0009_story_share_contributors.sql`。

---

# 19. V1.5.2 相比 V1.5.1 的变化

1. Onboarding 冻结为“人生地图优先 → 阶段边界 → Story Seed”，禁止因单个故事有趣而提前深挖；
2. 明确 Life Stage / Story 粒度，禁止“求学生涯”类超级 Story，同时不机械按小学 / 初中 / 高中硬切 Stage；
3. Onboarding 原子写库后，对全部新建 Story 复用 Story Completion，并在 Completion 结束前保持 processing；
4. Story Realtime 自动结束改为明确完成条件 + 固定收尾语“本次先聊到这里，再见。”，普通礼貌语不再触发挂断；
5. Doubao 本地仍有待播放音频时，speech_started 不立即截断；真实非空 user partial / final 才执行 barge-in；
6. Story Closeout 将新故事定义为 Story Seed，同 Stage 可多 Story、可跨 Stage，每轮最多 5 个；
7. Story Closeout 后对当前 Story 与全部新 Story 执行 Completion，单个 Completion 失败不回滚 Closeout；
8. Story Result 将 storyCompletionPending 视为 processing，持续显示 spinner，同时允许用户提前返回“我的人生”；
9. Profile Popover 显示当前登录手机号；
10. 产品 UI 暂停 Qwen Provider 入口，但保留 Provider Adapter，为后续 Local / NVIDIA Realtime Provider 预留；
11. Story 续访改为使用 `stories.agent_memory` 作为长期采访工作记忆；下一轮 Realtime 不再注入 `recent_asked_questions` 或历史 Transcript，Completion 也以 Agent Memory 为主要输入；
12. User Turn 判停优先使用浏览器 / Doubao 原生能力：`noiseSuppression=true`、`autoGainControl=false`，`DOUBAO_END_SMOOTH_WINDOW_MS = 1500`；本版不引入自研 VAD / Noise Gate；
13. Story `gaps` 冻结为“下一轮可直接提问的单一问题”，写入 Validator / Persistence 双层校验，Realtime 只消费合法问题；
14. Story 准备页直接显示最高优先级 gap，开场只问一个 gap；同一语义方向回答后不再换说法重复追问；
15. Onboarding `profile_summary` 改为 Facts 概况，不再复述 Life Stage 时间线；
16. Story 手动结束收到 `ending` 后立即进入 Result Processing，后台继续完成 Provider drain / Transcript / Closeout / Completion；
17. 完成 Text Model Provider / Runtime 解耦，Story Closeout、Onboarding Closeout、Completion、Generation 可共享 OpenAI-compatible Runtime；
18. Story Closeout 同时生成面向用户的 Summary 与面向 Interview Agent 的 `agent_memory`；Memory 原子落库、下一轮 Continue 消费、Completion 消费，并以旧 Summary 回填历史 Story；
19. Agent Memory 冻结为持久化滚动快照，以旧 Memory 为基线，只允许 add / correct / refine / merge / remove 五类显式变化，无解释信息丢失必须 repair；
20. 本地运行诊断统一收口到 `runtime/diagnostics/`，业务数据库仍保留在 `data/memoir.db`；默认诊断不保存正文，仅显式 `DIAGNOSTICS_CAPTURE_CONTENT=1` 时允许本地抓取 Transcript / Summary / Agent Memory / gaps。

---

# 20. V1.5.1 相比 V1.5 的变化

V1.5.1 **不改变产品定义**，只做基准文档治理：

1. 将原 V1.5 中多次重复的 Book 定义、Book Assembly、PDF、交付方式、主链路、页面地图、数据生命周期合并；
2. 不再在新版本正文中完整重复 V1.4 vs V1.3 的历史 Changelog；
3. 对 Onboarding、Completion、Generation 等旧版本已冻结内容只保留当前仍有开发价值的规则；
4. 将 Book Assembly、Book Preview、PDF Export 更新为当前 **[已实现]** 状态；
5. 明确已有 Book 合并新 eligible Story、历史 Document Version 不自动升级、只允许同 Life Stage 排序等最新实现规则；
6. 明确 PDF 目录支持多页并保留全部章节；
7. 将测试原则改为“业务不变量优先”，减少 CSS / 源码字符串型低价值 Contract；
8. 将完整产品主链路只保留一份，避免 AI 因重复内容浪费上下文；
9. 继续保留 V1.5 原文作为历史版本，V1.5.1 作为后续开发优先读取的精简基准。

---

# 21. 当前阶段最核心判断

人生采访局比赛 V1 需要稳定证明的不是“一个模型能一次写出一本书”，而是：

> **AI 能通过长期访谈逐渐认识一个人，建立人生地图，围绕具体 Story 持续收集事实，知道哪些信息还不足，在资料充分后生成忠于事实的 Story 成稿，并最终把这些成稿组织成一本完整人生书。**

底层原则保持：

```text
Story
= 内容生产单位

Story Document
= 单篇正式内容成稿

Book
= 多篇成稿的组织与最终交付单位
```

> **成书进入 V1，但整本重新 AI 创作继续后移。三步成书、移动端优先、按需 Preview、确定性 PDF，是当前最稳定且最适合比赛演示的方案。**
