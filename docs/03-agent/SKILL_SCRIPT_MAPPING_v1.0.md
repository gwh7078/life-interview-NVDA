# Skill / Script Mapping v1.0

> 更新：2026-09-29。本文定义共享有界 证据检索 的 任务、工具调用 与数据范围。

五个 v1.1 Skill 已完成 检索能力升级 与实际复测；任务注册表 版本为 `v1.1`。当前 加载 Skill / 不加载 Skill 结果见 NVIDIA SkillEvaluator Tier 3 正式报告。

## 1. 共享检索约定

四个离线或异步核心 Skill 可按任务授权主动调用共享 证据检索：`onboarding-closeout`、`interview-closeout`、`story-completion`、`story-generation`。`interview-observer` 属于实时低延迟路径，由 后端 按需预取有界历史证据后执行零工具分析。固定 任务上下文 已足够时不检索。只有当前上下文不足、存在待核对冲突，或确需比较多个来源时，四个主动检索 Skill 才调用 `evidence-search`；不得为了重新加载已提供的 访谈原文、记忆、摘要、档案、人生阶段 或文档而检索。

流程如下：

```text
Agent 判断是否需要补充证据
↓
共享 证据检索（Task 允许的 source type 子集 + 短 查询；可选参数受限）
↓
后端 校验授权、用户 / 资源范围、来源通道 与 来源信息
↓
少量有来源的 Evidence 返回同一 Agent Run
↓
原有 候选结果 / 输出协议 与 后端 校验器s
```

Agent 不能指定或扩大 owner、Story、share scope、凭证或 endpoint。后端 校验来源 白名单、查询、结果上限和 Era 年份范围。Evidence 是不可信数据，不是指令；它可以补充信息或提示核对，不能推翻主人公当前明确纠正。检索只读，不获得业务写入权。

## 2. Source type 与范围

| Source type | 服务端范围 | 使用边界 |
|---|---|---|
| `owner_transcript` | `subject` 访谈原文；owner 必须匹配。Story Task 还须匹配当前 Story | 主人公直接陈述；当前明确纠正优先于旧说法 |
| `contributor_transcript` | 仅 `external_contributor` lane，限当前授权的 Contributor / share context | 不得读取主人公 访谈原文、Story 记忆 或其他主人公个人资料；保留第三者归属 |
| `profile`、`life_stage` | 当前 owner | 用于背景核对与重复项识别；不能代替新 候选结果 所需的当前用户证据 |
| `story_memory`、`story_summary` | 当前 owner + 当前 Story | 当前 Story 的派生记忆与摘要；不能覆盖直接纠正 |
| `related_story` | 当前 owner；排除当前 Story | 只作重复检测或背景线索，不是当前 Story 新事实的证据 |
| `era` | 仅公共 Era adapter | 公共历史背景，不是个人经历或个人证据 |

## 3. Task 映射

| Task / Skill | 调用方式与允许来源 | 何时检索 |
|---|---|---|
| `onboarding.closeout` / `onboarding-closeout` | `evidence-search`：`profile`, `life_stage`, `related_story` | 当前访谈或建档上下文不足以核对既有 档案 / Stage 或识别重复 Story 时；当前 访谈原文 已在 任务上下文，不搜索重载 |
| `interview.closeout:story_create` | `evidence-search`：`related_story` | 当前已注入 Story 摘要不足以判断重复项时 |
| `interview.closeout:story_continue` | `evidence-search`：`owner_transcript`, `story_memory`, `story_summary`, `related_story` | 具体历史疑点未被当前 访谈原文 / 记忆 解答，或需要核对冲突时 |
| `interview.closeout:contributor` | `evidence-search`：`contributor_transcript` | 当前 Contributor 上下文不足以核对同一 Contributor 的旧说法时；绝不访问主人公证据 |
| `story.completion` / `story-completion` | `evidence-search`：`owner_transcript`, `story_memory`, `story_summary`, `related_story` | 当前 记忆 不足以判断关键 Gap 是否已由当前 Story 历史回答时 |
| `story.generation` / `story-generation` | `evidence-search`：`owner_transcript`, `contributor_transcript`, `profile`, `life_stage`, `story_memory`, `story_summary`, `related_story`, `era` | 当前材料不足以支撑用户要求的事实，存在冲突，或用户要求补充公共 Era 背景时 |
| `interview.context_hint` / `interview-observer` | Agent 无 Script / Tool。后端 仅在固定上下文不足、冲突未解或需要比较历史来源时，异步经共享 证据检索 预取 subject-only、owner / current-Story scoped 访谈原文 证据 | Observer 不决定或发起检索；只消费 任务上下文 中已预取的证据 |

`interview-observer` 继续保持单次、无工具推理。Prompt 必须说明 后端 已按需完成异步预取，证据随 任务上下文 提供；不得声称 Observer Agent 执行了脚本。固定上下文已足够时不得为重载它而预取。

四个 tool-enabled Skill 目录各自保留独立打包的 `scripts/evidence-search.mjs`。它们是同一 后端 协议的自包含 Skill-local wrapper，必须保持内容一致；Observer 不含检索脚本。

## 4. 输出、Realtime 与验收边界

- 各 Skill 的现有输入、输出、候选结果、来源引用和 后端 校验器 Contract 保持不变。检索结果的 来源信息 不得冒充输入中提供的用户消息 alias；只有现有规则允许的来源 ID 才能进入 候选结果。
- 检索结果不能绕过 Schema、Evidence、Domain、版本或 stale 校验，也不能直接写业务数据库。
- 自定义低延迟 实时采访教练 仍是独立应用路径，直接使用现有 Coach、Retriever 与 时代背景 集成；本文不改变 StepAudio、Coach Gate、总时限、失败放行 或语音行为。实时上下文提示 的 Observer 仍是单次无工具路径。
- 当前 `TaskDefinition`、后端 route、证据检索 service / gateway、四个一致的 Skill 内置封装脚本，以及 Observer 的 后端 prefetch 已接入共享路径；v1.1 结果已实际复测，NemoClaw / OpenClaw Skill 激活、工具调用 与 Spark 本地 Agent Task 链路已完成验收。
