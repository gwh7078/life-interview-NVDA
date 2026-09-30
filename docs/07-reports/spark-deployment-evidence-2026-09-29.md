# DGX Spark 最终部署与运行验证

**验证日期：** 2026-09-29（Asia/Shanghai）  
**最终结果：** **全本地验证通过 / 支持断网运行**

本文件记录比赛版本在 NVIDIA DGX Spark GB10（ARM64 / aarch64）上的最终验收状态，作为 README 中全本地运行结论的真机证据。

## 1. 最终验收结论

整套“人生采访局”已经在 DGX Spark 上完成实际运行验证：

- **全本地运行**：文本 / 智能体、实时语音、采访教练、检索服务、智能体运行时、Web 与数据层均运行在 Spark 本地；
- **可断网运行**：完成 Runtime / 模型准备后，断开外部网络仍可完成产品主链；
- **真人全链操作流畅**：连续语音采访、慢系统指导、证据检索、会后 Skills 与成稿链路均可正常协同；
- **比赛口径**：提交材料统一使用 **全本地验证通过 / 支持断网运行**。

## 2. 本地组件

| 组件 | 最终状态 | 作用 |
|---|---|---|
| DGX Spark GB10 / ARM64 / NVIDIA Runtime | 通过 | 本地算力平台 |
| 文本 / 智能体：`nvidia/Qwen3.6-35B-A3B-NVFP4` | 通过 | 本地文本推理与 Agent Tasks |
| Qwen3-8B 采访教练 | 通过 | 判断 / 检索 / 生成指导 |
| Step-Audio-2-mini | 通过 | 本地 实时语音 |
| NeMo 检索服务 | 通过 | 访谈原文 / Story 记忆 / 时代背景 检索 |
| NemoClaw / OpenClaw | 通过 | 会后 Agent Tasks / Skills |
| 后端 / Web | 通过 | 产品主链 |
| Technical Observer | 通过 | Runtime / Agent 可观测性 |
| SQLite | 通过 | 业务 业务真相源 |

基础环境检查曾运行 `bash deploy/spark/check-env.sh` 并取得 **12/12 通过**。实际部署中的 接口 以现场配置为准；例如 采访教练 现场使用 `:8004`，仓库默认 配置 为 `:8001`。

## 3. 产品全链验证

最终真人验收覆盖：

```text
用户语音
→ Step-Audio-2-mini 快系统
→ interview-coach / Qwen3-8B 慢系统
→ NeMo 检索服务（个人证据 / Era Context）
→ 下一问
→ interview-closeout
→ story-completion / gaps
→ story-generation
→ Story / Book
```

同时验证第三方 Contributor 证据与主人公证据保持“关联但不自动融合”的边界。

## 4. 性能与质量结论

- Spark 本地连续操作和语音采访体验：**流畅**；
- 快慢系统：加入 采访教练 Skill + NeMo 检索服务 后，访谈**下一问综合质量实测提升 55%**；
- Agent Skills：检索能力升级 后 加载 Skill 相比不加载 Skill 的 综合分 实测提升约 **11%～21%**，具体结果见 SkillEvaluator Tier 3 报告。


## 5. 复现入口

从仓库根目录：

```bash
bash deploy/spark/check-env.sh
bash deploy/spark/status.sh
bash deploy/spark/verify.sh
```

应用部署说明见 [Spark Deployment Reference](../04-nvidia/spark/README.md)，比赛总览见根目录 [README](../../README.md)。
