# life-interview-NVDA

人生采访局 NVIDIA / DGX Spark 比赛版。产品定位是 **AI 回忆录记者**：通过持续语音采访、事实整理、Story Memory、完整度判断、第三者补充与成稿，把分散的人生经历逐步整理为可阅读、可继续补充、可最终成书的内容。

> **当前文档真相优先级：代码与环境配置 > `docs/CURRENT_STATE.md` > Current 专项文档 > Reports / Archive。**
>
> 历史方案、阶段计划和旧测试报告不再作为当前开发依据。

## 当前状态

- 默认 Realtime：**Step-Audio-2-mini / StepFun Cloud**。
- 可选 Realtime：**StepAudio 3 Quality / StepFun Cloud**。
- Mini 默认使用 `supervisor_auto`：Qwen3-8B Realtime Coach 负责 Gate / 指导；Story Continue 可按需并行检索 Current Story Memory 与 Era Context。
- Gate 最长 2 秒；Coach 全链路从用户 final transcript 起共用 6 秒 Deadline，失败或超时不得阻塞 Voice。
- SQLite 仍是业务 Source of Truth；NeMo Retriever 是可重建的派生检索层。
- Web 会后任务支持 Direct Model 与 NemoClaw / OpenClaw Agent Runtime；`.env.example` 当前默认 `AI_TASK_RUNTIME=direct`。
- NemoClaw / OpenClaw、NeMo Retriever、NeMo Agent Toolkit 已进入工程实现与本机验证；**DGX Spark 上的最终本地推理与性能 Benchmark 尚未完成**。
- 当前仍处于真实语音人工测试与比赛收敛阶段，不把自动测试通过等同于完整真人体验验收。


## Benchmark：B 相比 A 提升在哪里

受控 Next-Question A/B 测试显示，**B（Mini + Coach）的优势主要集中在把重复、泛化或预设式追问收束成更具体、信息增益更高的下一问，而不是所有 Case 全面抬分。**

- **最强直接 Coach 信号 C03：A 33.0 → B 85.5，+52.5 分**（2 组有效配对）。A 的有效输出出现重复已知信息或预设老师意图；B 的有效输出转向追问老师给了什么具体鼓励或建议，表现出更强的具体性与信息增益。
- **定向回归 6 组有效配对：A 55.5 → B 64.5，平均 +9.0 分**。五个评分维度全部为正：Information Gain **+2.83**、Context Use **+0.83**、Story Value **+2.17**、Depth **+1.50**、Non-Leading **+1.67**。
- 完整冻结执行的 18 组有效 A/B 配对只提升 **+0.56**（47.00 → 47.56），说明 Coach 的收益是**针对 Mini 的特定失败模式**，不是普遍稳定抬分。

这里的“明显提升”指**场景级效果**，不等同于统计学显著性。完整正负结果、排除项与 Gate 限制见 [`benchmark/next-question/CURRENT_BENCHMARK_RESULT.md`](benchmark/next-question/CURRENT_BENCHMARK_RESULT.md)。

## 当前架构

```text
Web / Mobile Web
       |
       v
Life Interview Backend
- Auth / Session / Story / Life Stage / Share / Book
- Validator / Transaction / Idempotency
- SQLite (Source of Truth)
       |
       +-------------------------+
       |                         |
       v                         v
Realtime Voice             Post-session Tasks
       |                         |
Step-Audio-2-mini          onboarding.closeout
(default)                  interview.closeout
       |                   interview.context_hint
supervisor_auto            story.completion
       |                   story.generation
Qwen3-8B Coach                  |
       |                         +--> Direct Model (default)
Gate                            |
  +--> Current Story Memory     +--> NemoClaw/OpenClaw Agent Runtime
  +--> Era Context
       |
Coach Packet
       |
response.create
```

StepAudio 3 保留 `voice_tool` 路线，并继续使用现有 Context Hint / Tool Result / Resume 能力；Mini Coach 与该 Agent 路径是两套不同机制，不应混写。

## 文档入口

1. [当前实现状态](docs/CURRENT_STATE.md)
2. [产品定义](docs/PRODUCT.md)
3. [当前架构](docs/ARCHITECTURE.md)
4. [Realtime / Coach / Retrieval](docs/REALTIME.md)
5. [Agent Runtime](docs/AGENT_RUNTIME.md)
6. [NVIDIA / DGX Spark](docs/NVIDIA.md)
7. [测试与验收](docs/TESTING.md)
8. [完整文档目录](docs/README.md)

比赛评分映射见 [SCORING_ALIGNMENT_v1.0.md](docs/00-competition/SCORING_ALIGNMENT_v1.0.md)。

## 文档治理

旧方案可以保留，但必须满足两条规则：

1. **Current 文档只能描述当前代码真实状态。**
2. 被取代的设计、阶段计划和历史快照进入 `docs/archive/` 或 `docs/07-reports/`，不得继续出现在 Current 推荐阅读路径中。

需要判断“现在系统到底是什么”时，不从版本号最大的旧文档推断，先读 `docs/CURRENT_STATE.md`，再核对代码。
