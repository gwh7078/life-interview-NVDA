# 文档中心

本目录从 2026-09-27 起采用 **Current / Evidence / Archive** 三层治理，解决历史方案、阶段报告和当前规范混在一起的问题。

## 1. Current：当前开发唯一入口

后续 AI、开发和评审默认只需要读取以下文件：

| 文档 | 用途 |
|---|---|
| [CURRENT_STATE.md](CURRENT_STATE.md) | 当前实现状态与已知边界，最高优先级文档 |
| [PRODUCT.md](PRODUCT.md) | 当前产品模型、业务流程、四类采访场景 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前整体技术架构与职责边界 |
| [REALTIME.md](REALTIME.md) | Voice / Coach / Memory / Era / Tool 路线 |
| [AGENT_RUNTIME.md](AGENT_RUNTIME.md) | Agent Task、Skill、Runtime、Evidence Search 与 Contract |
| [SKILL_SCRIPT_MAPPING_v1.0.md](03-agent/SKILL_SCRIPT_MAPPING_v1.0.md) | Task-specific Evidence Search 来源范围与调用条件 |
| [NVIDIA.md](NVIDIA.md) | NemoClaw、Retriever、NAT、DGX Spark 状态 |
| [TESTING.md](TESTING.md) | 当前自动化、Live Smoke 与人工验收规则 |

## Agent Skills v1.1

本轮涉及的五个 Skill 元数据版本为 `1.1.0`，Task Registry 版本为 `v1.1`。四个离线或异步核心 Skill 可按任务授权主动调用 Evidence Search：`onboarding-closeout`、`interview-closeout`、`story-completion`、`story-generation`。`interview-observer` 属于实时低延迟路径，继续采用 Backend 预取有界证据并进行零工具推理。

Evidence Search 由 Backend 限定 owner、Story 与来源类型，Agent 不能自行扩大查询范围。2026-09-28～29 的 Skill v1.0 基线保留完整原始 HTML / JSON；v1.1 Retrieval Upgrade 后的 Overall 指标已于 2026-09-29 实际复测，并记录在正式 Tier 3 报告与 `run-metadata.json` 的 `post_upgrade_validation` 中。该次新版复测没有保存新的 run_id / pass@2 / raw HTML / JSON；20-case eval pack 继续用于未来做一轮 provenance 完整的 v1.1 Live 重跑。

冲突时按以下顺序判断：

```text
当前 main 代码 / .env.example
        ↓
CURRENT_STATE.md
        ↓
Current 专项文档
        ↓
测试报告
        ↓
Archive
```

**Archive 永远不能反向覆盖 Current。**

## 2. Evidence：保留真实验证证据

以下目录可以长期保留，但它们描述的是某次验证时刻，不是当前规范：

- `07-reports/`：E2E、Benchmark、NAT Eval、失败与收敛报告；
- `00-competition/`：比赛要求与评分映射；
- `09-uiux/`：当前 UI/UX 视觉资料；
- `AI开发联调环境.md`：本机环境与联调细节。

报告中的 PASS 只证明该报告记录的 commit / 环境 / 路径，不自动代表当前 main 全量验收。

## 3. Archive：历史方案

`archive/` 保存：

- 已被代码取代的架构方案；
- 旧产品基准；
- 旧模型选型；
- Deferred 但后来已经实现的计划；
- 早期 Phase 开发计划；
- 初始产品快照。

历史内容保留用于追溯，不得作为当前实现依据。

## 4. 专项目录

```text
docs/
├── CURRENT_STATE.md
├── PRODUCT.md
├── ARCHITECTURE.md
├── REALTIME.md
├── AGENT_RUNTIME.md
├── NVIDIA.md
├── TESTING.md
├── 00-competition/   # 比赛要求与当前评分映射
├── 03-agent/         # Contracts / 执行策略等底层规范
├── 04-nvidia/        # NVIDIA 专项参考
├── 06-decisions/     # ADR
├── 07-reports/       # 历史验证证据
├── 09-uiux/          # UI / UX
└── archive/          # 被取代的设计与历史快照
```

原 `02-architecture/`、`05-development/`、`08-future/` 中仍存在的旧路径仅用于兼容历史链接；被取代内容应明确指向 Current 文档或 Archive。

## 5. 文档维护规则

- 功能进入 main 后，同一提交或紧邻提交更新 Current 文档。
- “计划实现”与“已经实现”必须分开。
- 环境默认值以 `.env.example` 为准，不凭历史报告推断。
- 模型、Provider、Deadline、Feature Flag 等易变化信息优先写在 `CURRENT_STATE.md` / `REALTIME.md`，不要复制到多份文档。
- 新增报告时不修改历史报告结论；如被取代，在报告顶部加 superseded 指向。
- 不再采用“每次方案变化都新增一个 Current 版本文档”的方式。
