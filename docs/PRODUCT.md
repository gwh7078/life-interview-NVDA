# Product

> 当前产品定义，更新于 2026-09-27。  
> 技术 Provider、模型和超时参数不在本文重复维护，见 [REALTIME.md](REALTIME.md) 与 [CURRENT_STATE.md](CURRENT_STATE.md)。

## 1. 产品定位

人生采访局是一款 **AI 回忆录记者**。核心不是“一次输入后自动写一本书”，而是通过持续采访和证据整理，把人生经历逐步沉淀为 Story，再形成文章与整书。

```text
认识用户
→ 建立人生地图
→ 选择 / 创建 Story
→ 持续采访
→ Transcript / Closeout
→ Summary / Agent Memory
→ Completion / Gaps
→ Story Document
→ Book
```

## 2. 核心领域模型

```text
Account / Profile
├─ Life Stage
│  └─ Story
│     ├─ Subject Interview Sessions
│     │  └─ Transcript
│     ├─ Share Links
│     │  └─ External Contributor Sessions
│     │     ├─ Transcript
│     │     └─ Contributor Summary
│     ├─ Story Summary
│     ├─ Story Agent Memory
│     ├─ Status / Gaps
│     └─ Story Documents / Versions
└─ Book
   └─ Book Items
      └─ Selected Story Document Version
```

永久边界：

- Life Stage：人生时间目录；
- Story：内容生产单位；
- Transcript：原始采访证据；
- Story Summary：面向用户与成稿的事实骨架；
- Story Agent Memory：面向采访与 Completion 的工作记忆；
- Story Document：单 Story 正式成稿；
- Book：多个 Story Document Version 的组织与交付。

## 3. 四种 Interview 场景

### Onboarding

目标是先建立人生地图，不应被单个精彩故事长期带偏。

输出重点：

- Profile 稳定事实；
- Life Stages；
- Story Seeds；
- 后续 Completion 所需最小信息。

### Story Create

围绕一个新的经历采访，允许从 Life Stage / target title 起步。结束后创建或补全对应 Story。

### Story Continue

围绕已有 Story 深挖：

- 利用 Story Agent Memory 与 gaps；
- 必要时通过 Current Story Retrieval 找回旧回答；
- 必要时使用 Era Context 帮助设计更好的追问；
- 不把检索结果直接当新事实。

### External Contributor

主人公可创建 7 天分享链接，请亲友补充某一 Story。

边界：

- relationship 固定；
- Contributor Transcript / Summary 与主人公事实链隔离；
- 第三者说法不能自动进入主人公 Story Summary、Memory 或 Completion；
- 第三者不得访问主人公私密 Transcript。

## 4. 会后处理

Interview 结束后按场景执行对应 Closeout。

主人公链路：

```text
Transcript
→ evidence-aware Closeout
→ Summary / Agent Memory
→ Story discovery / correction
→ Completion
→ Gaps
```

Contributor 链路：

```text
Contributor Transcript
→ Contributor Closeout
→ Contributor Summary
```

不自动污染主人公事实链。

失败原则：**失败不写半成品。** Proposal 必须经过 Schema / Evidence / Domain Validation 后再 Apply。

## 5. Story Completion

Completion 是轻量 readiness 判断，不重新读取所有历史 Transcript。

输出核心：

- 当前 Story 是否资料较少 / 正在完善 / 已可成稿；
- 下一轮最值得问的 0–3 个 gaps。

不使用百分比完成度。

## 6. Story Generation

成稿必须回到原始 Transcript / 可验证 Evidence。Agent Memory 是工作记忆，不是最高事实证据。

生成结果版本化，允许后续重新生成或润色而不覆盖旧版本。

## 7. Book

Book 只负责组织已经生成的 Story Document Version，不重新采访，也不重写 Story 事实。

当前代码包含 Book UI / Service / Repository / PDF 路径。最终比赛展示可以在已有能力基础上扩展电子书、印刷/邮寄、出版等交付表达，但未实现的商业交付不能写成当前功能。

## 8. 产品体验原则

- Interview 是 Call UI，不是 Chat UI；
- Story 内容优先，技术信息不干扰普通用户；
- 用户可以随时结束采访；
- Transcript 是证据，Summary 是整理结果；
- 不确定内容保持不确定，不替用户补全；
- 纠错优先于“保持故事好看”；
- 长采访优先信息密度与连续性，而不是频繁总结和打断。
