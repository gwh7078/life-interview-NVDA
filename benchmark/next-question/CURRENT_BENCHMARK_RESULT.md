# Controlled Next-Question Benchmark — Current Results

**分支：** `benchmark/next-question`
**报告口径：** 仅整理仓库已有 Realtime、Judge、定向 A/B 与 Gate Probe 结果；本报告生成期间没有运行模型、修改 Prompt 或改写历史分数。

## 结论先行：已观察到 B 高于 A 的场景

现有记录里确实有 B 高于 A 的结果。最直接的 Coach 定向证据来自 C03：在 2 组 Judge 有效的 A/B 配对中，B 平均高 **52.5 分**；冻结 90 样本执行中，C02 高 **28.33 分**（3 对），Coach Case 子集 C01–C04 高 **20.67 分**（6 对）。

这些正向结果需要和完整有效配对一起看：冻结执行的 18 组 A/B 配对中，B 总体平均高 **0.56 分**，10 对 B 得分更高、8 对更低；额外定向回归的 6 对平均高 **9 分**，但只有 3 对 B 得分更高、另外 3 对更低。因而现有数据支持“B 在部分目标场景中表现更好”，还不足以证明 B 普遍或稳定优于 A。

### 最强的 Coach 定向正向证据：C03

在 2026-09-29 的定向 A/B 回归中，C03 有 2/3 组通过 Judge 并形成有效配对：A 均分 **33.0**，B 均分 **85.5**，配对提升 **+52.5**，两组有效配对都是 B 更高。A 的有效输出包括重复已知信息、预设杨老师“肯定信任”用户；B 则追问杨老师给了什么具体鼓励或建议。该次 C03 的 B Gate 均走了 `guide`，因此比 Gate 未介入时的分数差更能直接体现 Coach 方向的正向信号。

这个结果仅有两组有效配对。第三组 B 的 Judge 输出无效，没有被补分或纳入均值。

### 冻结执行中的正向 Case

| Case | A 均分 | B 均分 | B−A | 有效配对 | 观察 |
|---|---:|---:|---:|---:|---|
| C02 | 36.33 | 64.67 | **+28.33** | 3 | B 在 2/3 对得分更高。A 的一条输出变成助手自我介绍而非采访问题（得分 0），显著拉低 A 均分；该次冻结执行 B Gate 为 `none`，因此这是 B Profile 的正向观测，不能单独归因于一次 Coach intervention。 |
| C03 | 38.00 | 51.00 | **+13.00** | 3 | B 在 2/3 对得分更高；同一冻结执行中 Gate 均未介入，属于 Profile 结果，不是 Coach 介入的直接因果证据。 |
| C10 | 49.67 | 54.33 | **+4.67** | 3 | B 在 2/3 对得分更高；这是 Era 类型 Case，不作为 Coach 提升的主要证据。 |

冻结执行的 Coach Case 子集平均为 A **37.17**、B **57.83**，配对差 **+20.67（n=6）**。有效数据只覆盖 C02、C03；C01、C04 的音频转写不等价，因此该子集不能代表完整四个 Coach Case。并且冻结执行中 B Gate 为 `none`（0/29 次介入），所以此处应解读为 B Profile 的观察到的分数差，而不是已隔离出的 Coach 因果效果。

## 冻结 90 样本执行：最终可用的 A/B/C 分数

来源：`results/2026-09-28T13-34-48-step-plan-judge-682ebd14/`。90 条 Realtime Sample 均完成；按最终 Judge 评分和 ASR 资格筛选后，A/B/C 各有 18 条分数，形成 18 组有效 A/B 配对。

| Variant | 有效分数 N | 均分 | 中位数 | 标准差 |
|---|---:|---:|---:|---:|
| A — Mini only | 18 | 47.00 | 48 | 25.96 |
| B — Mini + Coach | 18 | **47.56** | **51** | 23.11 |
| C — Mini + Coach + Memory + Era | 18 | 44.83 | 38 | 23.87 |

**A→B 配对差：+0.56 分（n=18；中位配对差 +4；B 胜 10 对、A 胜 8 对、平局 0 对）。**

| 评分维度 | B−A 配对均值差（n=18） |
|---|---:|
| Information Gain | **+0.72** |
| Context Use / Non-Repetition | **+0.17** |
| Story Value | 0.00 |
| Depth | -0.06 |
| Non-Leading | -0.28 |

整体正向主要在信息增益和上下文利用；故事价值持平，深挖和非诱导略低。分数方差较大，未进行统计显著性检验。

### 全部 Case 的 A/B 配对结果

| Case | 有效配对 | A 均分 | B 均分 | B−A | B 胜 / A 胜 | 主能力 |
|---|---:|---:|---:|---:|---:|---|
| C01 | 0 | — | — | — | — | Coach |
| C02 | 3 | 36.33 | 64.67 | **+28.33** | 2 / 1 | Coach |
| C03 | 3 | 38.00 | 51.00 | **+13.00** | 2 / 1 | Coach |
| C04 | 0 | — | — | — | — | Coach |
| C05 | 3 | 54.00 | 41.00 | -13.00 | 1 / 2 | Memory Retrieval |
| C06 | 3 | 40.00 | 39.33 | -0.67 | 2 / 1 | Memory Retrieval |
| C07 | 0 | — | — | — | — | Memory Retrieval |
| C08 | 0 | — | — | — | — | Memory Retrieval |
| C09 | 3 | 64.00 | 35.00 | **-29.00** | 1 / 2 | Era |
| C10 | 3 | 49.67 | 54.33 | **+4.67** | 2 / 1 | Era |

C01、C04、C07、C08 的 36 条样本均因 ASR 核心内容不等价而排除，未以这些样本计算质量分。

## 定向 Coach A/B 回归：正向结果与反向结果同时保留

来源：`results/2026-09-29T01-49-43-154Z-4284d1f6/`。该回归针对 C03、C05、C06、C10，复用冻结 A 输出并新跑 12 条 B。12/12 输入等价且 Realtime 完成；最终只有 6/12 组配对通过 Judge，另 6 组因 Judge 输出无效而排除。

| 指标 | A | B | B−A |
|---|---:|---:|---:|
| 总分均值（6 组有效配对） | 55.5 | **64.5** | **+9.0** |
| Information Gain | — | — | **+2.83** |
| Context Use / Non-Repetition | — | — | **+0.83** |
| Story Value | — | — | **+2.17** |
| Depth | — | — | **+1.50** |
| Non-Leading | — | — | **+1.67** |

定向均值为正，但 6 对中 B 胜 3 对、A 胜 3 对；C03 的 +52.5 拉高了总体均值。排除 C03 后，其余 4 对的平均差为 **-12.75**。Case 细项如下：

| Case | 有效配对 | A 均分 | B 均分 | B−A |
|---|---:|---:|---:|---:|
| C03 | 2/3 | 33.0 | 85.5 | **+52.5** |
| C05 | 2/3 | 58.5 | 57.5 | -1.0 |
| C06 | 1/3 | 55.0 | 40.0 | -15.0 |
| C10 | 1/3 | 95.0 | 61.0 | -34.0 |

该回归中 B Gate 介入 11/12 次，Coach 成功 11/12 次、fail-open 1/12 次。C05、C06、C10 均出现 Coach 已介入但 Judge 分数仍下降的样本；介入本身不等于质量提升。

## 技术可靠性与当前 Gate 限制

### 冻结 90 样本与 Judge

- Realtime：90/90 完成；10/10 canonical WAV；30/30 Case×Run 运行条件一致性检查通过。
- ASR：54/90 输入等价通过（60%）；36/90 样本因核心转写不等价排除。
- 最终 Step 5 Judge：`step-5-preview`，endpoint `https://api.stepfun.com/step_plan/v1/chat/completions`，温度 0。逐 Candidate 取 `judge-results.jsonl` 中最后一次尝试，90 个 Candidate 中 88 个有有效评分、2 个因输出长度限制失败；最终可用于主评分的样本为 54/90。
- Judge 温度为 0。质量分和延迟分开处理。
- B Gate 介入 0/29，C Gate 介入 0/28；C 的 Memory、Era 请求各为 0/30。因此 C 组数据没有实际测到 Memory/Era 检索收益。
- 冻结执行 Coach 运行成功率 95%（57/60），fail-open 5%（3/60），timeout 0%。B Gate/Coach 延迟 P50 1290.98 ms、P95 1782.86 ms；延迟不计入质量分。

**计数审计说明：** 该 Judge 重评分目录的 `manifest.json` 仍记录较早阶段的 69 scored / 21 failed；这与最终 `judge-results.jsonl` 按每个 Candidate 最后一次尝试得到的 88 / 2，以及 `summary.json` 的最终计数不一致。本报告保留历史文件不变，分数与 Judge 计数按原始逐次结果重新计算，并通过 `manifest.samples` 对应到 `technical.jsonl` 后应用 `input_equivalence=PASS` 和 `primary_score_eligible=true` 过滤。

### 后续独立 Gate Probe（不与历史 Judge 分数合并）

最新 Gate Probe：`results/gate-probe-2026-09-29T07-30-15-495Z-aec2d797/`。

- Schema：12/12 有效；intervention：12/12；timeout：0/12。
- 延迟：P50 1265.19 ms，P95 1914.48 ms。
- 定向语义验收：**0/4 Case 通过**。C03 重问老师已让用户“再试”的信息；C05 泛问已知学校选择；C06 把不确定日期转成影响追问；C10 泛问对高考的态度。
- 因此，这个 Gate Probe 只证明结构与工程门槛通过，语义路由仍未通过。它不是新的 B Realtime/Judge 结果，也没有覆盖或改变前述冻结分数。

此前首轮 Judge 使用的 endpoint 是 `https://api.stepfun.com/v1/chat/completions`，只有 2 组有效 A/B 配对且大量评分失败。该首轮曾出现 +30.5 的 A→B 均值差，但因后续改用 Step Plan endpoint 对冻结输出重新评分，本报告不把它并入主结果或比赛结论。

## 比赛可用摘要

**English**

In the final available re-judge of the frozen run, the 18 valid ASR-equivalent A/B pairs show a small positive mean for Coach-assisted B: 47.56 versus 47.00 for Mini-only A (+0.56 points), with B higher in 10 of 18 pairs. The clearest targeted signal is C03, where B scored 52.5 points higher across two valid pairs and asked for concrete details about a teacher's encouragement instead of repeating known information or presuming the teacher's intent. The four-case targeted Coach regression averaged +9.0 over six valid pairs, but three pairs favored A; gains were concentrated in C03 while C06 and C10 regressed. A later Gate probe passed schema checks 12/12 but passed semantic review 0/4, so the evidence supports targeted observed improvements, not a claim that B is generally or consistently superior to A.

**中文**

冻结执行的最终可用重评分中，18 组 ASR 等价 A/B 配对显示 Coach 版 B 均分略高于 Mini-only A：47.56 对 47.00，提升 0.56 分，18 对中 B 高于 A 的有 10 对。最明显的定向信号来自 C03：两组有效配对中 B 高 52.5 分，并追问老师具体如何鼓励，而不是重复已知信息或预设老师的想法。四 Case Coach 定向回归的 6 组有效配对均值高 9.0 分，但其中 3 对 A 更高；提升集中在 C03，C06 和 C10 出现回退。后续 Gate Probe 虽然 Schema 12/12 通过，语义检查仅 0/4 通过，因此这些数据支持“部分目标场景已观察到 B 改善”，不支持“B 普遍或稳定优于 A”的结论。

## 数据来源与复核口径

- 冻结 Realtime 数据及首轮 Judge：`results/2026-09-28T11-54-23-404Z-27c55a4d/`。
- 冻结输出的 Step Plan Judge 重评分：`results/2026-09-28T13-34-48-step-plan-judge-682ebd14/`。
- 定向 Coach A/B 回归：`results/2026-09-29T01-49-43-154Z-4284d1f6/`。
- 最新 Gate Probe：`results/gate-probe-2026-09-29T07-30-15-495Z-aec2d797/`，语义复核见 `results/targeted-coach-ab-regression-preflight-2026-09-29/gate-probe-summary.json`。
- 固定音频与 SHA：[`audio/manifest.json`](audio/manifest.json)。
- Runner/Judge 命令说明：[`README.md`](README.md)。本报告仅读取上述已有数据，没有重新调用 Realtime 或 Judge。
- 可复核主分数的计算方式：对 Judge JSONL 每个 candidate 取最后一次尝试；只保留有效评分；通过 manifest 将 candidate 映射到 technical 记录；要求技术记录 `input_equivalence=PASS` 且 `primary_score_eligible=true`；按相同 Case 和 Run 配对 A/B。定向回归另按其自身 manifest、technical 与 judge-results 文件配对，不与冻结执行混池。
