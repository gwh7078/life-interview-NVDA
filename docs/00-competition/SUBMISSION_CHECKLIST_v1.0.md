# DGX Spark Hackathon · 最终提交清单

> 作用：比赛最后收口使用。只记录“是否已经形成可提交材料”，不把计划当成完成。

## 一、官方 8 项材料

| 材料 | 当前状态 | 最终动作 |
|---|---|---|
| 开源项目仓库 URL | ✅ 已有 | 提交最终 main URL |
| 500 字以上项目说明 | ✅ README 已覆盖 | Benchmark / Spark 结果完成后更新数字 |
| 部署说明 | ✅ README + Spark Reference | 真机完成后补实际验证状态 |
| 技术栈说明 | ✅ README 已覆盖 | 核对 NVIDIA / StepFun 名称与实际使用一致 |
| Skill Markdown 文件 | ✅ 已有正式 Skills | Skill Benchmark 完成后补报告入口 |
| B 站作品演示视频 URL | ⏳ 待录制 | 按 Demo Script 录制、上传、回填 URL |
| 黑客松“一日谈”征文 URL | ⏳ 初稿已准备 | 补 Benchmark / Spark 数据后发布、回填 URL |
| 团队合影 | ⏳ 待准备 | 拍摄并按表单要求上传 |

## 二、评委材料冻结前检查

### 产品真实性

- [ ] README 与 `docs/CURRENT_STATE.md` 一致；
- [ ] 不把 Planned 写成 Implemented；
- [ ] 不把 Mac / Cloud 验证写成 DGX Spark PASS；
- [ ] StepAudio ARM64 只有真机通过后才写已验证；
- [ ] Benchmark 数字可以追溯到固定 case、环境与 commit。

### Skills

- [ ] 6 个正式 Skill 名称与当前产品一致；
- [ ] 每个 Skill 的 Trigger / Input / Evidence Boundary / Output 清楚；
- [ ] Demo 至少展示 Interview Coach + Closeout + Completion + Generation 的协作；
- [ ] 不把 `story-context-inspector` 当正式产品 Skill；
- [ ] 明确 Realtime Coach 不经过通用 OpenClaw Runtime。

### Benchmark

- [ ] Skill Benchmark 最终报告归档；
- [ ] Interview Quality A/B 最终报告归档；
- [ ] 结果表只保留最有解释力的 3–5 个指标；
- [ ] 如有 Spark 性能 Benchmark，记录 P50/P95、环境与 commit；
- [ ] 不为“结果更好看”删除失败 case。

### DGX Spark

- [ ] Host / Runtime readiness 有真实证据；
- [ ] Text / Coach / Retriever / Agent Runtime 分别记录状态；
- [ ] Realtime / StepAudio 状态单独记录；
- [ ] 完整 E2E 能否 PASS 明确写出；
- [ ] Technical Observer / 日志留存关键截图；
- [ ] 最终 README 更新 Spark 真机结论。

## 三、视频录制前

- [ ] 冻结一个最终 Demo commit；
- [ ] 固定 Story Continue Demo 数据；
- [ ] Memory 可命中；
- [ ] Era Context 可在合适场景触发；
- [ ] Closeout 正常；
- [ ] Completion 能返回有价值 gaps；
- [ ] Story Generation 可稳定生成；
- [ ] Technical Observer 画面可读；
- [ ] 全链人工预演至少 2 次；
- [ ] 视频中所有技术结论与实际状态一致。

Demo 脚本见 [DEMO_VIDEO_SCRIPT_v1.0.md](DEMO_VIDEO_SCRIPT_v1.0.md)。

## 四、提交前最后一次检查

- [ ] README 第一屏对评委友好；
- [ ] GitHub 默认分支就是最终提交版本；
- [ ] README 中 B 站 URL 已回填；
- [ ] README 中一日谈 URL 已回填；
- [ ] 征文中 GitHub / B 站 URL 已回填；
- [ ] 团队合影已准备；
- [ ] GitHub 不含 API Key / SSH Key / 密码；
- [ ] 重要报告可直接从 README 进入；
- [ ] 最终表单全部链接逐个打开检查；
- [ ] 保存提交成功截图 / 回执。
