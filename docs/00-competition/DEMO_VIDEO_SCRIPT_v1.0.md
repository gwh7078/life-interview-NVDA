# DGX Spark Hackathon · 5 分钟 Demo 视频脚本

> 目标：让评委在 5 分钟内看懂 **产品价值 → 快慢系统 → Agent Skills → NVIDIA / DGX Spark → 结果证据**。  
> 原则：只展示真实可运行能力；Benchmark 与 Spark 数据只使用实际运行结果。

## 一、视频核心叙事

一句话：

> **人生采访局不是“帮你写一篇文章”的聊天机器人，而是一名会持续采访、核对证据、判断缺口并最终成稿的 AI 回忆录记者。**

整条视频只讲一个故事：

```text
一个 Story Continue 采访
→ Voice 自然追问
→ Coach 判断是否需要慢系统
→ Memory / Era 在必要时提供证据
→ 采访结束
→ Agent Skills 完成 Closeout / Completion / Generation
→ 最终得到可验证的回忆录正文
```

技术组件只在它们真实参与这条链路时出现。

---

## 二、5 分钟分镜

### 0:00–0:25｜问题与产品

**画面**

左侧：产品首页 / Story 页面。  
右侧：一句话标题 + 简单流程图。

**旁白**

> 写回忆录最难的不是“写”，而是把几十年的经历重新问出来、理清楚、核对清楚。一次性把材料丢给大模型，很容易漏掉关键细节，也容易把背景知识和用户真实经历混在一起。  
> 人生采访局把这个过程做成了一名 AI 回忆录记者：它先采访，再整理证据，判断还缺什么，最后才写。

**屏幕文字**

```text
Interview → Evidence → Gaps → Writing
```

---

### 0:25–0:55｜为什么不是普通语音聊天

**画面**

显示核心架构图：

```text
Realtime Voice
     |
Interview Coach
  /       \
Memory    Era
     |
Next Question
```

**旁白**

> 实时语音模型负责自然地听和问，但小模型不适合每一轮都承担长记忆和复杂判断。  
> 所以我们把系统拆成快慢两层：Voice 保持实时对话，Interview Coach 只在必要时介入；Story Memory 负责找回用户以前说过的内容，Era Context 只提供公共时代背景。

强调：

- Gate 最长 2 秒；
- Coach 总 Deadline 6 秒；
- 超时或失败直接 fail-open，不阻塞采访。

---

### 0:55–2:05｜核心现场：Story Continue

这是全片最重要的一段。

**准备一个固定 Story**

要求它天然包含：

1. 已经采访过、可被 Memory 找回的旧事实；
2. 一个适合 Era Context 的时间点；
3. 当前新回答与旧证据存在可澄清点，或至少需要避免重复问。

**画面**

以产品真实语音界面为主，Technical Observer 放在右侧或画中画。

**现场演示顺序**

1. 用户继续讲述；
2. Voice 先接住对话；
3. Technical Observer 显示 Coach Gate；
4. 如需要，显示 Memory / Era Retrieval；
5. Coach Packet 形成；
6. 下一问明显利用了旧信息或时代背景，但不替用户下结论。

**旁白尽量少。**

在关键节点可加字幕：

```text
Gate → Memory → Era → Coach Resolve
```

**需要让评委看懂的点**

- Coach 不是每轮都强行介入；
- Memory 只访问 Current Story 的受限证据；
- Era 是公共背景，不进入用户事实链；
- 最终仍由 Voice Model 自然地问用户。

如果某一路在正式录制时没有触发，不要伪造 UI；改用已经保存的真实 Benchmark / Trace 画面说明。

---

### 2:05–3:10｜采访结束后：Agent Skills 工作流

**画面**

结束当前采访。

随后依次展示：

```text
Interview Closeout
→ Story Memory / Summary
→ Story Completion
→ Gaps
→ Story Generation
```

同时显示 Skill 文件或简化 Skill 卡片。

**旁白**

> 采访结束以后，不是再用一个大 Prompt 把所有事情做完。  
> 我们把专业工作拆成独立 Agent Skills：Closeout 只负责整理有来源的事实；Completion 只判断资料是否足以成文以及下一轮还缺什么；Generation 最后才根据证据写正文。

展示三个关键边界：

- Agent 只返回 Proposal；
- Backend 做 Schema / Evidence / Domain Validation；
- Agent 不直接写业务数据库。

**Skill 快速扫过**

- interview-coach
- interview-observer
- onboarding-closeout
- interview-closeout
- story-completion
- story-generation

不要逐个读文档，重点展示“分工 + 协作”。

---

### 3:10–3:40｜第三者补充与证据隔离

**画面**

快速切到 Contributor Share / 外部贡献者页面。

**旁白**

> 回忆录也不只来自主人公本人。用户可以邀请亲友补充同一个 Story，但第三者证词与主人公事实链严格隔离，不能自动写成主人公亲历。只有主人公后来明确确认，才可以进入主人公事实。

这一段控制在 30 秒以内，用来证明产品完整性和证据设计深度。

---

### 3:40–4:20｜为什么是 DGX Spark

**画面**

Spark 架构图 + 真机终端 / Technical Observer。

```text
DGX Spark
├─ Text / Agent Model
├─ Qwen3-8B Coach
├─ StepAudio Runtime
├─ NeMo Retriever
├─ NemoClaw / OpenClaw
└─ NAT / Technical Observer
```

**旁白**

> 这类应用天然需要处理长期个人资料，同时又要并行运行 Voice、Coach、Retriever 和 Agent Runtime。  
> DGX Spark 的价值不是把一个模型搬到本地，而是让这套多 Runtime 工作流可以在一台本地设备上协同运行。

必须只展示已经真机验证成功的组件。

如果 StepAudio ARM64 或完整 E2E 尚未通过，视频中明确区分：

- 已完成真机验证；
- 当前仍使用外部 Runtime / Cloud 的部分。

不做模糊表述。

---

### 4:20–4:45｜Benchmark：复杂架构到底值不值

**画面**

只放 1 张最有力的结果图 / 表，不堆日志。

优先展示 **Interview Quality A/B**：

```text
Realtime Only
vs
+ Coach
vs
+ Memory
vs
+ Era
vs
Full
```

推荐指标：

- 重复提问；
- 跑题；
- unsupported fact；
- useful follow-up；
- contradiction handling。

如 Spark 性能数据足够稳定，再在角落补：

- First Token / First Audio；
- Coach P50/P95；
- Retriever P50/P95。

**旁白**

> 我们不是用组件数量证明技术深度，而是用固定案例对照，验证这些组件有没有真的让采访更好。

---

### 4:45–5:00｜最终结果

**画面**

Story Document → Book / PDF。

**旁白**

> 最终，用户得到的不是一段聊天记录，而是一条从原始口述、证据整理、采访缺口到正式成稿都可以追溯的回忆录生产链。  
> 这就是人生采访局：一个运行在本地 Agent 技术栈上的 AI 回忆录记者。

最后一屏：

```text
Life Interview
AI Memoir Journalist

Voice × Evidence × Agent Skills × DGX Spark
```

---

## 三、录制前必须准备

### 固定 Demo 数据

不要临场随机聊天。准备一个已验证 Story，使其至少包含：

- 2–3 条可命中的 Story Memory；
- 一个窄年份 Era Context；
- 一个适合澄清 / 深挖的当前回答；
- 一次 Closeout 后可新增 Memory；
- Completion 可产生 1–3 个有价值 gaps；
- Generation 有足够 Transcript 可生成正文。

### Technical Observer

录制前确认画面能够清楚显示：

- Coach Gate；
- Retrieval requested / result；
- Era / Memory 区分；
- timeout / fail-open 状态；
- Agent Task；
- Skill / Runtime；
- Spark 主机状态（仅在真机时）。

### 真实性检查

视频中禁止出现未经实测的描述：

- “DGX Spark 全链已稳定运行”——除非已有真机证据；
- “StepAudio 已在 ARM64 完整验证”——除非真实通过；
- “P50/P95 为某数值”——除非来自保存的 Benchmark；
- “所有 Agent 都通过 NemoClaw”——Realtime Coach 不是这条 Runtime。

---

## 四、剪辑原则

- 产品真实画面至少占 **60%**；
- PPT / 架构图只解释“为什么”，不要代替产品 Demo；
- 每个技术名词出现时，都要能回答“它解决了什么问题”；
- 不展示长终端日志；
- Benchmark 只展示最关键的一张图；
- 不在 5 分钟里解释安装过程；
- 不从登录 / 注册开始录，直接进入 Story Continue。

---

## 五、最终素材占位

- B 站视频 URL：**待录制后补充**
- Demo 使用 commit：**待最终冻结**
- DGX Spark 真机环境：**待真机验证后补充**
- Interview Quality Benchmark：**待正式结果**
- Spark Performance Benchmark：**待正式结果**
