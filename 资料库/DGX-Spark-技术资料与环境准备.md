# DGX Spark 技术资料与环境准备

## 1. 官方硬件定位

DGX Spark 是基于 NVIDIA GB10 Grace Blackwell Superchip 的个人级 AI 系统，采用 128GB 统一内存，面向本地模型推理、Agent 原型、多模态应用、微调和边缘工作负载。官方产品页标称第五代 Tensor Core FP4 峰值最高可达 1 PFLOP，并支持较大规模本地模型运行。

官方资料：

- 产品页：<https://www.nvidia.cn/products/workstations/dgx-spark/>
- 用户指南：<https://docs.nvidia.com/dgx/dgx-spark/index.html>
- 发行说明：<https://docs.nvidia.com/dgx/dgx-spark/release-notes.html>
- 开发者快速开始：<https://developer.nvidia.cn/build-spark>
- Spark 开发入口：<https://build.nvidia.com/spark>
- DGX Spark 快速开始 PDF：<https://www.nvidia.com/content/dam/en-zz/solutions/support/dgx-spark/DGX-Spark-Quick-Start-Guide.pdf>

## 2. 技术准备重点

### 2.1 先确认真实环境

比赛可能提供远程或现场资源，也可能允许使用自有机器。赛前要记录：

- DGX Spark 型号和内存；
- DGX OS、驱动、CUDA、容器运行时版本；
- ARM64/aarch64 兼容性；
- 本地模型实际占用与并发上限；
- 音频、图像、向量库、浏览器或桌面工具是否能在环境中运行。

DGX OS 会更新，发行说明显示当前软件版本可能变化；以比赛机器实测版本为准，不要只按网上旧教程配置。

### 2.2 推荐的最小软件闭环

1. 一个能稳定本地推理的语言/多模态模型；
2. 一个 Agent 编排层；
3. 一个 Skill 注册与调用机制；
4. 结构化数据存储：人物、事件、关系、时间线、待确认事实；
5. 一个可替换的语音转写或图像输入模块；
6. 日志、耗时、显存/统一内存占用和错误记录；
7. 简单前端或命令行演示入口。

官方开发者入口列出了 JupyterLab、VS Code、LM Studio、llama.cpp、Ollama/Open WebUI、ComfyUI、NeMo、SGLang、CUDA-X 等路径。不要一开始全部安装，先选一条能完成演示的最短路径。

## 3. Agent Skill 目录建议

```text
skills/
  interview-planner/
    SKILL.md
    references/
    scripts/
    tests/
  follow-up-question/
    SKILL.md
    references/
    tests/
  life-archive/
    SKILL.md
    references/
    scripts/
    tests/
  story-drafter/
    SKILL.md
    references/
    tests/
```

每个 Skill 至少写清楚：用途、触发条件、输入格式、步骤、工具、输出格式、失败处理、隐私边界和测试样例。Skill 的价值不在于文字多，而在于重复执行时结果可预测。

## 4. “人生采访局”建议的数据结构

```json
{
  "person": {"name": "", "aliases": [], "consent": ""},
  "events": [{"date": "", "place": "", "people": [], "summary": "", "confidence": 0.0}],
  "relationships": [{"from": "", "to": "", "type": "", "confirmed": false}],
  "open_questions": [],
  "sensitive_items": [],
  "source_segments": [],
  "last_updated": ""
}
```

任何模型推断都要和原始访谈片段、置信度、确认状态关联起来。受访者可以修改、删除或拒绝公开某一项。

## 5. 建议的测量指标

| 类别 | 指标 |
|---|---|
| 任务完成 | 一次采访能否生成计划、追问、档案和成稿 |
| 质量 | 事实准确率、时间线冲突数、引用原文覆盖率 |
| 体验 | 首次响应时间、整段流程耗时、人工修改次数 |
| 本地价值 | 网络断开时可完成的步骤、敏感数据离开本机的比例 |
| 稳定性 | 连续运行成功率、工具调用失败率、恢复时间 |
| 资源 | 模型内存占用、并发数、音频/图像处理耗时 |

## 6. 必做验证清单

- [ ] 在比赛目标机器上跑通一条完整演示；
- [ ] 断网后确认哪些能力仍可用；
- [ ] 用短音频、长音频、多人说话、方言/噪声各测一次；
- [ ] 测试模型把“不确定”标出来，而不是补写事实；
- [ ] 删除/撤回敏感内容后，索引、缓存和导出文件同步删除；
- [ ] 工具失败时有重试、跳过和人工接管；
- [ ] 准备录屏和离线数据，现场机器出问题仍能演示；
- [ ] 记录最终环境版本，保证复现。
