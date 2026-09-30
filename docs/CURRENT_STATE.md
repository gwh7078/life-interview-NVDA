# 当前状态

> 更新：2026-09-29
> 作用：回答“当前 main 到底实现了什么”。任何历史设计与本文冲突时，以当前代码、`.env.example` 和本文为准。

## 1. 产品主链

当前 Web 产品已经具备：

- 演示手机号登录；
- 首次建档 / 人生地图；
- 人生阶段增删改查；
- 故事创建 / 故事续访；
- 第三者分享与 第三方采访；
- 访谈原文持久化；
- 采访收尾；
- 故事摘要 / 故事记忆；
- 完整度判断 / 缺口；
- 故事生成 / 文档版本；
- 成书组织与 PDF 路径。

四种采访场景仍分别处理：`初始化配置`、`story_create`、`story_continue`、`external_contributor`。

比赛版本已完成 Spark 真机真人全链测试，覆盖连续语音、开场/追问、打断、检索、采访收尾、Completion 与 Generation；整套系统全本地运行、可断网，实际体验流畅。

## 2. 实时语音

### 默认

`.env.example` 当前默认：

```text
STORY_INTERVIEW_PROVIDER=stepaudio2_mini
STEPFUN_REALTIME_MODEL=step-audio-2-mini
REALTIME_MEMORY_TRIGGER=supervisor_auto  # 配置默认值
```

比赛 Spark 配置使用本地 Step-Audio-2-mini 运行时。2026-09-29 已在 DGX Spark GB10 / ARM64 上完成实时语音真机全链与真人体验验证，支持全本地运行和断网使用。

### 其他配置

- `stepaudio3_quality`：兼容配置，不属于比赛主链；
- `stepfun`：Mini 的兼容别名；
- `modelbest` / MiniCPM-o-4.5-Realtime：实验配置；
- Qwen 实时语音适配器 仍存在，但不是当前默认路线。

## 3. Mini 实时采访教练

Mini 默认 `supervisor_auto`，Coach 模型为 `qwen3-8b`，使用独立 OpenAI 兼容配置。该能力现正式定义为 `interview-coach` Skill，由产品自建的低延迟 实时运行时 执行，而不是经过 OpenClaw / NemoClaw。

### 首次建档

```text
用户最终发言
  ├─> Mini 立即回复
  └─> Coach 异步 旁路任务（不检索）
        └─ 如在下一次用户发言前形成有效指导
           → 最多缓存 30 秒
           → 只注入紧接着的一次 Mini 回复
```

Coach 不允许阻塞 首次建档 当前轮。

### 故事创建 / 第三方采访

先跑 采访教练判断，但不允许 个人记忆 / 时代背景检索。普通轮次 `无需介入` 时不增加无意义指导。

### 故事续访

```text
用户最终发言
   ↓
Qwen3-8B 判断
   ├─ 是否检索故事记忆？
   └─ 是否检索时代背景？
        ↓
两路按需并行
   ├─ 当前 Story 记忆检索
   └─ 时代背景检索
        ↓
生成采访指导（需要证据时）
        ↓
采访指导包
        ↓
当前 Mini 下一轮回复指令
```

关键约束：

- Gate 硬上限：2,000 ms；
- 采访教练总时限：6,000 ms；
- 故事记忆与时代背景 独立判断，可同时触发；
- Memory 只允许 用户 + 当前 Story + 主人公 范围的 问答证据；
- Era 只允许公共背景，不能变成用户事实；
- 第三方贡献者 不读取主人公私密 访谈原文；
- 失败 / 超时 / 结果过期均失败放行，不阻塞 语音；
- 迟到结果默认不跨回合使用，首次建档 的下一回合短期 采访指导包 是唯一特殊路径。

## 4. StepAudio 3 慢路径

StepAudio 3 使用 `voice_tool` 路线，不加载 Mini 采访教练。

它保留现有：

```text
语音工具调用
→ 当前 Story 检索
→ interview.context_hint
→ 工具结果
→ 恢复回复
```

该路径与 Mini 采访教练 必须分开描述，不能再统称为“独立记忆”。

## 5. Retriever / 时代背景

### 个人记忆

NeMo Retriever 已有真实 客户端、索引器、当前 Story 召回 与测试。SQLite 仍是业务真相源，Retriever 是可重建派生索引。

`.env.example` 当前：

```text
NEMO_RETRIEVER_ENABLED=true
NEMO_RETRIEVER_COLLECTION=life-interview-transcripts
```

### 时代背景

代码已具备：

- 独立 时代背景数据集；
- 独立 public collection；
- 数据集构建 / 校验；
- 索引 / 重试；
- benchmark；
- Era 客户端 / validation；
- Realtime Coach 故事续访 接入。

默认模板当前仍为：

```text
NEMO_ERA_CONTEXT_ENABLED=false
```

因此正确表述是：**能力已实现并接线，但默认环境模板未开启该索引。** 不能再写成 未来能力，也不能写成所有环境已经启用。

## 6. 智能体运行时

任务注册表 当前包含：

- `初始化配置.closeout`
- `interview.closeout`
  - `story_create`
  - `story_continue`
  - `contributor`
- `interview.context_hint`
- `story.completion`
- `story.generation`

当前正式 Skill 集合：

- 初始化配置-closeout
- interview-closeout
- interview-observer
- interview-coach
- story-completion
- story-generation

`story-context-inspector` 是历史 Smoke / 诊断用途，不应计为当前产品 Skill。

当前五个 Agent Skill 元数据版本为 `1.1.0`，任务注册表 版本为 `v1.1`。四个离线或异步核心 Skill 可按任务授权主动调用 证据检索：`初始化配置-closeout`、`interview-closeout`、`story-completion`、`story-generation`。`interview-observer` 属于实时低延迟路径，由 后端 按需预取 owner / current-Story scoped 的有界历史证据，再执行零工具分析。证据检索 由 后端 限定 owner、Story 与来源类型；Agent 无法扩大查询范围。检索只补充证据，不覆盖主人公当前明确纠正，也不改变现有 候选结果、来源引用或 后端 校验协议。具体映射见 [SKILL_SCRIPT_MAPPING_v1.0.md](03-agent/SKILL_SCRIPT_MAPPING_v1.0.md)。

2026-09-28～29 的 NVIDIA SkillEvaluator Tier 3 基线保留了完整的 49 个评测案例 / 196 次执行尝试 原始结果。v1.1 检索能力升级 后的 综合分 指标已于 2026-09-29 实际复测并确认，与 README 和正式报告中的当前分数一致。独立 20-case 评测包 保留作为可复现评测输入。当前 任务注册表、后端 路由、证据检索 服务 / 网关、四个 Skill 内置封装脚本、各 Task 授权上下文及 Observer 后端 预取 已接入共享路径。

`.env.example` 当前默认：

```text
AI_TASK_RUNTIME=direct
```

NemoClaw / OpenClaw Agent Adapter 已实现并有真实 Smoke/端到端 证据，但不能描述成 Web 默认运行时。

## 7. NVIDIA 状态

### Spark 部署边界

DGX Spark 的目标方式是：**用户准备并运行标准运行时，本仓库部署应用并接线**。运行时接口 默认值如下；以操作者实际配置和 实际服务模型 ID 为准：

| 运行时 | 模型 / 接口 |
|---|---|
| 文本 / 智能体 | `nvidia/Qwen3.6-35B-A3B-NVFP4` — `http://127.0.0.1:8000/v1` |
| Mini 采访教练 | `Qwen3-8B` — 默认 `http://127.0.0.1:8001/v1`；2026-09-29 真机现场实际为 `:8004` |
| StepAudio 协议 | `ws://127.0.0.1:8092/realtime` |
| NeMo Retriever 服务 | `127.0.0.1:7670` |
| Retriever 内部存储 | 由 NeMo Retriever 运行时管理；不是应用接口 |

NemoClaw/OpenClaw 是一项 由操作者管理的智能体运行时，默认 `my-assistant` 沙箱 内提供 OpenClaw Agent。操作者负责官方安装、初始化配置 与 readiness；仓库只检查 readiness 并配置应用 路由、Agent、Skills 和 策略。官方 onboard 可发现并复用已经运行的 `localhost:8000/v1/models`；这是 endpoint 配置能力，不构成 Spark 兼容性或 端到端 证明。正式会后 Agent Skills 在 OpenClaw 运行时 执行。Mini 的 `interview-coach` Skill 仍由产品低延迟 实时运行时 执行，不经过 OpenClaw。

比赛文档只描述 Spark 全本地主链；其他开发配置不作为比赛能力口径。

### DGX Spark 验证状态

DGX Spark 当前统一状态为 **全本地验证通过 / 支持断网运行**。2026-09-29 已在 NVIDIA DGX Spark GB10（ARM64）完成最终真人全链测试：文本 / 智能体、Qwen3-8B Coach、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、后端/Web、Technical Observer 与 SQLite 均在本地协同运行；断开外部网络后仍可完成产品主链，实际语音与操作体验流畅。

早期调试阶段的局部失败记录仅用于历史排障，不再代表当前比赛版本。最终验收口径见 [spark-deployment-evidence-2026-09-29.md](07-reports/spark-deployment-evidence-2026-09-29.md)。

**比赛与应用证据保留：**正式 Skills 描述 Task 能力与边界；NAT 提供 评测 / 性能分析 / 回归；Technical Observer 呈现真实运行状态；基准评测 记录固定输入下的质量、性能和环境。每项结论须绑定真机实际运行产物。

`deploy/spark/setup.sh` / `deploy/spark/start.sh` 是用户自管 Runtime 下的应用 部署 / 启动入口；外部 文本、采访教练、StepAudio 与 Retriever 需由用户先行准备。

## 8. 当前不应再使用的说法

以下表述已经过时：

- “Doubao 是当前 Realtime”；
- “StepAudio 3 是默认 Realtime”；
- “每轮固定 Qwen3.5-2B Judge”；
- “Realtime 当前不 Agent/Coach 化”；
- “Retriever 不进入正式产品链路”；
- “时代背景 仍是 未来能力”；
- “Mini 使用 独立记忆 → interview.context_hint Agent”；
- “Phase 2B 智能体运行时集成仍在进行”。

如代码再次变化，应优先修改本文，而不是再新增一个平行的 Current 版本。
