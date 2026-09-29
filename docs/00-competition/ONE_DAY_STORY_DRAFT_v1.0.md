# 黑客松“一日谈”征文初稿

> 建议发布平台：知乎 / CSDN  
> 状态：初稿。Spark 真机与 Benchmark 完成后补入最终数字和截图。

# 从“会聊天”到“会采访”：我把一名回忆录记者拆成了一组 Agent Skills

最早做“人生采访局”时，我以为核心问题很简单：让 AI 和用户多聊一会儿，再把聊天内容整理成文章。

真正跑起来以后才发现，**会聊天和会采访完全是两件事**。

普通语音模型可以很自然地接话，但采访一旦超过几轮，问题就开始出现：它会重复问已经回答过的内容，会被一个有趣的话题带偏，会忘记前面确认过的事实，也可能把模型知道的时代背景误当成用户真实经历。

而回忆录最不能接受的，恰恰就是“为了故事完整而补全事实”。

于是这个项目开始从一个语音聊天应用，逐步变成一套“AI 回忆录记者”系统。

## 1. 第一个改变：不让一个模型承担所有事情

实时采访需要快。

用户讲完一句话，如果系统为了查历史、做推理、再调用几次工具才开口，采访体验会立即变成“问答表单”。

但专业采访又需要慢。

一个好记者应该知道：这件事之前是不是已经问过？用户今天的说法和上次有没有矛盾？某个年份的时代背景是否值得追问？哪些细节还不足以支撑成文？

因此我们最后采用了快慢两层。

快系统是实时 Voice Model，只负责自然地听、说和保持对话连续性。

慢系统是 Interview Coach。每次用户 final transcript 到来后，Coach 先做一个 Gate：这一轮到底需不需要介入？

如果 Voice 已经问得很好，就返回 none。

只有真的需要时，才进入下一步：查询 Current Story Memory，或者查询独立的 Era Context，再形成一个非常短的 Coach Packet，指导下一问。

这套系统最重要的设计不是“多调用一个大模型”，而是**尽量少介入**。

Gate 最长 2 秒，Coach 从用户 final 开始只有 6 秒总 Deadline。任何检索或推理迟到，都直接 fail-open，不能阻塞实时语音。

## 2. 第二个改变：把“记忆”和“历史背景”彻底分开

回忆录系统有两类看起来很像、实际上必须严格分开的信息。

第一类是用户以前亲口说过的话。

第二类是公共时代背景。

例如用户说“那几年我刚到北京工作”，系统可以去找他以前讲过的工作经历；也可以检索那个年份相关的公共背景，帮助记者想到一个更好的问题。

但时代背景永远不能自动变成：

“所以你当时一定受到了某件历史事件影响。”

这会从采访变成诱导。

因此 Personal Memory 与 Era Context 使用独立证据边界。Memory 只能访问当前 owner、current story、subject 范围内的 Q+A evidence；Era 只提供公共背景候选。

Era 可以改变“下一问问什么”，但不能改变“用户经历过什么”。

## 3. 第三个改变：从一个大 Prompt，变成一组 Agent Skills

采访之后还有一整套工作。

最早的做法很容易变成一个超长 Prompt：

“请总结采访、更新记忆、判断完成度、发现缺口、写文章……”

这样虽然看起来简单，但职责混在一起后，很难测试，也很难保证事实边界。

所以我们把一名回忆录记者的工作拆成了独立 Skills：

- **interview-coach**：实时判断要不要纠偏、检索或指导下一问；
- **interview-observer**：只读地选择相关证据、提示冲突；
- **onboarding-closeout**：首次采访后建立 Profile、Life Stage 与 Story Seeds；
- **interview-closeout**：把一次 Story 采访整理成有来源的 Proposal；
- **story-completion**：只判断这个 Story 是否足够成文，以及下一轮最值得问什么；
- **story-generation**：最后才根据可验证证据写回忆录正文。

这里有一个我后来越来越坚持的原则：

> **Agent / Model 是 Reasoning Authority，Backend 才是 Execution Authority。**

Agent 可以理解和提议，但不能直接修改业务事实。

Closeout 的输出必须先经过 Schema Validation、Evidence Validation 和 Domain Validation，再由后端事务性地 Apply 到 SQLite。

这让“模型觉得故事应该这样”与“用户真正说过什么”之间，多了一道明确的系统边界。

## 4. NVIDIA 技术栈不是装饰，而是把这些角色真正拆开

这次 DGX Spark Hackathon 让我重新考虑了一个问题：

如果这个产品未来真的要长期处理个人口述资料，本地算力应该承担什么？

答案并不是“把原来的云模型换成本地模型”这么简单。

我们希望在同一台本地设备上同时容纳：

- Text / Agent Model；
- 低延迟 Qwen3-8B Coach；
- Realtime Voice Runtime；
- NeMo Retriever；
- NemoClaw / OpenClaw Agent Runtime；
- NeMo Agent Toolkit 的 Evaluation / Profiler；
- Technical Observer。

NemoClaw / OpenClaw 承担正式会后 Agent Tasks 与 Skills；NeMo Retriever 负责 Personal Memory 与 Era Context；NAT 不接管产品 Runtime，而是负责 Evaluation、Regression、Profiler 与轨迹分析。

Realtime Coach 则故意不经过通用 Agent Runtime，因为实时语音有完全不同的延迟预算。

对我来说，这次架构调整最大的收获是：**不是所有东西都应该 Agent 化，也不是所有 Agent 都应该走同一个 Runtime。**

## 5. 我们开始用 Benchmark 回答一个更重要的问题

系统越来越复杂以后，很容易陷入另一个误区：

组件越多，看起来越高级。

但评委或者真实用户真正应该问的是：

> Coach、Memory、Era 这些东西，真的让采访变好了吗？

所以现在我们正在做固定采访案例的 A/B Benchmark：

```text
Realtime Only
→ + Coach
→ + Personal Memory
→ + Era Context
→ Full Interview Coach
```

评测不只看延迟，还看：

- 是否重复提问；
- 是否跑题；
- 是否出现 unsupported fact；
- 能否发现并处理冲突；
- 下一问是否真正有价值；
- Coach 是否在“不需要介入”的时候保持安静。

最终结果会绑定具体 case、commit、环境和真实输出，而不是只给一个主观“效果不错”。

**【待 Benchmark 完成后补充关键结果图与数字】**

## 6. DGX Spark 真机：最后一块需要真实证明的地方

应用侧已经完成 Spark Profile 的接线设计，包括 Text、Coach、StepAudio contract、Retriever 与 NemoClaw/OpenClaw Runtime。

但在真正跑完 Spark 之前，我们不会把“官方支持”写成“项目已经验证”。

目前仍需要 DGX Spark 真机回答的问题包括：

- GB10 / ARM64 Runtime compatibility；
- StepAudio 实际 Realtime 路径；
- Voice + Coach + Retriever + Agent Runtime 的完整 E2E；
- First Token / First Audio；
- P50 / P95；
- 并发与资源占用。

**【待 Spark 真机完成后补充现场截图与结果】**

这也是我现在越来越重视的一件事：技术比赛里，架构图只能证明“你想清楚了”，运行证据才证明“它真的成立”。

## 7. 最后的产品目标没有变

技术架构越来越复杂，但用户看到的东西应该越来越简单。

用户只需要说。

系统负责听、问、辨、整理证据、发现缺口，再把这些真实经历写成文章。

最终得到的不是一份聊天总结，而是一条可以追溯的链路：

```text
原始口述
→ 证据
→ Story Memory
→ Interview Gaps
→ Story Document
→ Book
```

如果这套系统最终做对了，用户甚至不需要知道背后有多少 Skills、多少模型、多少 Retriever。

他只会感觉：

**“这个采访者记得我说过什么，而且真的知道下一句该问什么。”**

---

## 最终发布前补充

- 项目 GitHub：**待发布时填写**
- B 站演示视频：**待录制后填写**
- Interview Quality Benchmark：**待正式结果**
- DGX Spark 真机结果：**待正式结果**
