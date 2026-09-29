# DGX Spark Hackathon · 最终提交清单

> 作用：比赛最后收口使用。只记录“是否已经形成可提交材料”，不把计划当成完成。

## 一、官方 8 项材料

| 材料 | 当前状态 | 最终动作 |
|---|---|---|
| 开源项目仓库 URL | ✅ 已有 | 提交最终 main URL |
| 500 字以上项目说明 | ✅ README 已覆盖 | 已按官方子项建立快速索引 |
| 部署说明 | ✅ README + Spark Reference | 已写明全本地、可断网部署与模型 / Skills 优化 |
| 技术栈说明 | ✅ README 已覆盖 | NVIDIA SDK / 技术 / StepFun 模型均已逐项列明 |
| Skill Markdown 文件 | ✅ 已有正式 Skills | README 可直接进入各 Skill 与 Benchmark |
| B 站作品演示视频 URL | ⏳ 待录制 | 按 Demo Script 录制、上传、回填 URL |
| 黑客松“一日谈”征文 URL | ⏳ 初稿已准备 | 补 Benchmark / Spark 数据后发布、回填 URL |
| 团队合影 | ⏳ 待准备 | 拍摄并按表单要求上传 |

## 二、评委材料冻结前检查

### 产品真实性

- [x] README 与 `docs/CURRENT_STATE.md` 一致；
- [x] Spark 最终口径统一为 FULL LOCAL VERIFIED / OFFLINE CAPABLE；
- [x] Step-Audio-2-mini 已在 Spark 本地链路完成真人验证；
- [x] 快慢系统 55% 提升与 Skill Lift 当前分数已完成实际验证；
- [x] 技术实现、部署、技术栈和 Skills 均可从 README 直接进入。

### Skills

- [ ] 6 个正式 Skill 名称与当前产品一致；
- [ ] 每个 Skill 的 Trigger / Input / Evidence Boundary / Output 清楚；
- [ ] Demo 至少展示 Interview Coach + Closeout + Completion + Generation 的协作；
- [ ] 不把 `story-context-inspector` 当正式产品 Skill；
- [ ] 明确 Realtime Coach 不经过通用 OpenClaw Runtime。

### Benchmark

- [x] Skill Benchmark 当前结果已写入 README / 正式报告；
- [x] Interview Quality 最终口径为下一问综合质量 +55%；
- [x] README 只展示最有解释力的核心结果；
- [x] Spark 最终真人验收已完成：全本地、可断网、运行流畅；
- [x] 历史基线保留用于前后对照。

### DGX Spark

- [x] Host / Runtime 已完成真机验证；
- [x] Text / Coach / Retriever / Agent Runtime 已全本地运行；
- [x] Realtime / Step-Audio-2-mini 已完成本地真人验证；
- [x] 产品主链断网可用；
- [x] Technical Observer 与现场记录已留存；
- [x] README 已更新为最终 Spark 真机结论。

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
