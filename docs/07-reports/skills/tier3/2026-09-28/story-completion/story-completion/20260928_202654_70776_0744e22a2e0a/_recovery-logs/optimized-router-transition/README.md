# SkillEvaluator Tier 3 执行优化与恢复记录

## 协议与范围

- Agent：Bailian `qwen3.6-35b-a3b`；Judge：StepFun `step-5-preview`，endpoint `https://api.stepfun.com/step_plan/v1/chat/completions`。
- 保留正式 Case、Prompt、评分器、with/without 条件、每 Case 两次 attempt、0.70 pass threshold；没有修改 Skill 或产品代码。
- 保留成功的原始 trial。执行错误与 Judge 失败不作为 0 分；`story-completion` 的最终报告从原有成功 trial 加两条 Judge 重试合成，原始不完整报告仍保留。

## Router 与 timeout

- 并行 Router 源码保存在本评测档案：`router/model-router-threaded.py`；监听 65410，Semaphore 上限 4，upstream timeout 180s。
- Qwen 路由 Bailian；`step-5-preview` 路由到上述 StepFun endpoint。
- Harbor 总并发保持 2。实际 Agent stage timeout 为 300s，verifier stage timeout 为 360s。Harbor 本轮没有独立 whole-trial deadline；360s 是 verifier timeout，不应解读为整个 trial 的外层上限。每个上游请求仍受 180s Router timeout 约束。
- Router 事件日志：`docs/07-reports/skills/tier3/2026-09-28/provider-router-parallel-events.jsonl`。其中 199 个完成请求均为 HTTP 200；记录的最大并发为 2，最大排队 13ms。日志另有 1 个未配对 start 事件；最终检查时没有活动 TCP 客户端连接。
- 正式 trial 的模型请求均完成并评分。模型目录预检曾遇到 `RemoteDisconnected`；正式报告的可选反馈文案生成出现 503 后使用 fallback。这两者没有改写 trial 分数，也没有重跑成功 trial。

## 正式报告状态

| Skill | 正式 scored attempts | 状态 | 报告目录 |
|---|---:|---|---|
| `story-generation` | 48/48 | succeeded | `docs/07-reports/skills/tier3/2026-09-28/story-generation/20260928_084021_49989_6398737131f7` |
| `interview-closeout` | 44/44 | succeeded | `docs/07-reports/skills/tier3/2026-09-28/interview-closeout/interview-closeout/20260928_121608_8005_7700559cd278` |
| `story-completion` | 36/36 | succeeded | `docs/07-reports/skills/tier3/2026-09-28/story-completion/story-completion/20260929_124102_17967_286c813d3e30` |
| `interview-observer` | 36/36 | succeeded | `docs/07-reports/skills/tier3/2026-09-28/interview-observer/interview-observer/20260929_125705_20173_7a9d9262a337` |
| `onboarding-closeout` | 32/32 | succeeded | `docs/07-reports/skills/tier3/2026-09-28/onboarding-closeout/onboarding-closeout/20260929_045902_20325_ced742c78f6c` |

总计 196 条 scored attempts。`interview-coach` 与 `story-context-inspector` 当前没有 Tier 3 `evals/evals.json`，不在本批可执行清单中。

`interview-observer` 的正式结果严格采用每 Case 两次 attempt。额外产生的 `OBS-005__aXp5QTB` 保存在原 Harbor Job 中，但排除于官方 36 条报告之外。

## 最小性能记录

- `story-completion` 的失败与恢复样本：本目录 `performance.csv`。旧 Judge 超时样本 Agent 约 41–43s、Judge 约 935–945s、总耗时约 994–1016s；成功重试总耗时 58.09s / 84.52s。失败样本不计分。
- `interview-observer` 正式 36 条 trial：`docs/07-reports/skills/tier3/2026-09-28/interview-observer/interview-observer/20260929_125705_20173_7a9d9262a337/_recovery-logs/optimized-router-transition/performance.csv`。
- `onboarding-closeout` 正式 32 条 trial：`docs/07-reports/skills/tier3/2026-09-28/onboarding-closeout/onboarding-closeout/20260929_045902_20325_ced742c78f6c/_recovery-logs/optimized-router-transition/performance.csv`。
- onboarding 中位数：with-skill Agent 12.83s / Judge 61.23s / total 86.37s；without-skill Agent 10.10s / Judge 88.53s / total 113.81s。observer 中位数：with-skill 22.19s / 78.69s / 137.93s；without-skill 15.53s / 100.47s / 138.40s。

## 清理

所有有 Tier 3 evals 的目标 Skill 已完成。评测专用 Router 与临时 Router token 在最终归档前关闭并清理；Colima 保持运行。SkillEvaluator 安装目录的临时 timeout 参数转发补丁已恢复为备份原文件。
