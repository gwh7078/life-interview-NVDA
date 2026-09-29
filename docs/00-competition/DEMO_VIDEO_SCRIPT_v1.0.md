# DGX Spark Hackathon · 5 分钟 Demo 视频脚本

> 目标：让评委在 5 分钟内看懂 **7 天只靠说话完成约 10 万字回忆录 → 快慢系统 → 5 个核心 Agent Skills → NVIDIA / DGX Spark → Skill 评测证据**。  
> 原则：产品操作是主线，技术图只解释“为什么”；Benchmark 与 Spark 数据只使用实际结果。

## 一、视频核心叙事

一句话：

> **人生采访局是一名 AI 回忆录记者：用户只需要说，不需要写；系统用“听、问、辨、写”完成从采访到成稿的全过程，产品目标是 7 天形成约 10 万字回忆录。**

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
7 天 · 只说话不写字 · 约 10 万字回忆录
听 → 问 → 辩 → 写
```

右侧技术总览只列核心：5 个业务 Skill、快慢双系统、DGX Spark、NemoClaw / OpenClaw、NeMo Retriever、NAT、SkillEvaluator、Qwen3.6-35B-A3B-NVFP4、Step-Audio-2-mini。不要在这一页展开实现细节。

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

### 2:05–2:30｜第三者补充：为什么需要“辩”

**画面**

快速切到 Contributor Share / 外部贡献者页面。

**旁白**

> 回忆录不只来自主人公本人。亲友可以补充同一个 Story，但第三者证词与主人公事实链保持独立；系统可以发现一致、差异和冲突，却不能自动把第三者说法写成主人公亲历。这就是“听、问、辩、写”里的“辩”。

---

### 2:30–3:25｜采访结束后：三个会后 Skills

**画面**

结束当前采访，依次展示：

```text
interview-closeout
→ Story Memory / Summary
→ story-completion
→ 0–3 个高价值 Gaps
→ story-generation
→ Story / Book
```

**旁白**

> 采访结束以后，不是用一个大 Prompt 把所有事情做完。`interview-closeout` 只整理有来源的事实；`story-completion` 只判断资料是否足够、还缺什么；`story-generation` 最后才根据证据成稿，并区分 initial / revision。

视频里的 **5 个核心业务 Skills** 是 `interview-coach`、`onboarding-closeout`、`interview-closeout`、`story-completion`、`story-generation`。`interview-observer` 是实时观察和诊断辅助，不必与五个核心 Skill 并列讲解。

共同边界：Agent 输出 Proposal，Backend 做 Schema / Evidence / Domain Validation，Agent 不直接写业务数据库。

---

### 3:25–4:05｜为什么是 DGX Spark

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

当前真机口径统一为 **FULL LOCAL VERIFIED / OFFLINE CAPABLE**：整套系统已在 DGX Spark GB10 全本地运行，Text / Agent、Coach、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、Backend/Web、Observer 与 SQLite 均在本地协同工作；断网条件下产品主链可用，真人演示流畅。

---

### 4:05–4:40｜Skill Benchmark + NAT：这些 Skills 是否真的有效

**画面**

只放一张结果图：左侧是 NVIDIA SkillEvaluator 的 With Skill / Without Skill 对照，右侧是 NAT 的 Evaluation / Profiler / Regression 角色。

可展示当前 v1.1 Overall：

```text
story-completion    0.7426 → 0.9500
story-generation    0.7868 → 0.9600
interview-closeout  0.7891 → 0.9500
onboarding-closeout 0.8163 → 0.9300
interview-observer  0.8157 → 0.9400
```

Judge 使用 StepFun `step-5-preview`。当前 v1.1 Overall 已完成实际复测并确认，与视频展示分数一致；说明这些是项目自测，不代表 NVIDIA Verified Skills 官方认证。

**旁白**

> 我们不靠组件数量证明技术深度，而是用 With Skill / Without Skill 的同题对照，验证每个 Skill 是否真的让 Agent 做得更好；NAT 再负责评测、性能分析和回归测试。

---

### 4:40–5:00｜最终结果

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

### 最终技术口径

- DGX Spark：全本地运行、可断网、真人操作流畅；
- Step-Audio-2-mini：Spark 本地 Realtime Voice；
- Realtime Coach：独立低延迟 Runtime，不经过会后 OpenClaw 路径；
- NemoClaw / OpenClaw：执行会后 Agent Tasks / Skills；
- SkillEvaluator：With Skill / Without Skill 对照；
- NAT：Evaluation / Profiler / Regression。

---

## 四、剪辑原则

- 左侧产品实景约 **30–35%**，右侧技术图约 **65–70%**；技术图跟随当前操作切换，不做一张总图从头放到尾；
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
- DGX Spark 真机环境：**FULL LOCAL VERIFIED / OFFLINE CAPABLE**
- SkillEvaluator Tier 3：**v1.1 Overall 已实际复测并确认**
- Interview Quality Benchmark：**慢系统 + Coach Skill + NeMo Retriever 使下一问综合质量提升 55%**
- Spark 真人体验：**全本地、可断网、连续操作流畅**
