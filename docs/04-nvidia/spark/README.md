# DGX Spark 部署说明

> 状态：当前部署边界与操作者参考  
> 更新：2026-09-29

## 1. 部署定位

DGX Spark 的标准模型与检索运行时由操作者准备和运行；本仓库负责部署人生采访局应用，并把应用接到这些本地服务。

比赛版本已经在 NVIDIA DGX Spark GB10 完成**全本地验证，支持断网运行**。本仓库不把“从裸机一键安装全部模型运行时”作为目标；`deploy/spark/setup.sh` 与 `start.sh` 负责应用部署和接线。

## 2. 本地运行时接口

| 角色 | 模型 / 服务 | 默认接口 | 作用 |
|---|---|---|---|
| 文本 / 智能体 | `nvidia/Qwen3.6-35B-A3B-NVFP4` | `http://127.0.0.1:8000/v1` | 文本推理、会后智能体任务、写作 |
| Mini 采访教练 | `Qwen3-8B` | `http://127.0.0.1:8001/v1` | 实时判断、检索、下一问指导 |
| 实时语音 | Step-Audio-2-mini | `ws://127.0.0.1:8092/realtime` | 连续语音采访 |
| 检索 | NeMo Retriever | `http://127.0.0.1:7670` | 访谈原文、故事记忆、时代背景检索 |

NemoClaw / OpenClaw 作为会后智能体运行时，执行正式 Agent Skills。Mini `interview-coach` 使用独立低延迟运行时，不经过 OpenClaw。

## 3. 前置条件

- DGX Spark（ARM64 / aarch64），NVIDIA 驱动与 Docker 可用；
- Git、Python 3、Node.js 24.16+（24.x）或 26.1+、npm；
- 文本、采访教练、StepAudio、NeMo Retriever 已在 Spark 本地启动；
- `:8000/v1/models` 与 `:8001/v1/models` 返回实际服务模型 ID；
- NemoClaw / OpenClaw 已按 NVIDIA 官方方式安装并完成初始化，指定沙箱处于可用状态；
- 密钥只保存在忽略提交的本地配置中。

## 4. 部署步骤

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA

cp deploy/spark/env.example deploy/spark/.env
# 按实际服务模型 ID 和本地接口修改配置

bash deploy/spark/check-env.sh
bash deploy/spark/setup.sh
bash deploy/spark/start.sh
bash deploy/spark/verify.sh
```

各脚本职责：

1. `check-env.sh`：检查主机、GPU、Docker 和本地服务接口；
2. `setup.sh`：安装应用依赖、迁移 SQLite、初始化 Retriever 集合 / 时代背景索引、同步 Skills、配置 NemoClaw / OpenClaw 路由与策略；
3. `start.sh`：启动后端、网页端、智能体检索代理和 Technical Observer；
4. `verify.sh`：执行 Spark 应用验收并保存验证证据。

示例数据默认不额外写入；只有显式设置 `SPARK_SEED_DEMO_DATA=true` 才执行附加种子步骤。

## 5. 模型与智能体优化

- 文本 / 智能体、采访教练、实时语音按任务拆分模型；
- 已运行的本地文本模型直接被 OpenClaw 复用，不启动第二份模型；
- 采访教练仅在需要时进入慢路径；
- 个人记忆与时代背景检索可以并行；
- 会后智能体只在上下文不足或存在冲突时调用 `evidence-search`；
- 工具权限、来源类型、结果数量和资源范围由后端限制；
- 智能体候选结果必须经过结构、证据和业务规则校验后才能写入业务数据。

## 6. 比赛与应用证据

- **Agent Skills**：任务职责、工具调用、执行循环和输出协议；
- **NVIDIA SkillEvaluator**：加载 Skill / 不加载 Skill 的实际对照评测；
- **NAT**：评测、回归、性能分析和轨迹记录；
- **Technical Observer**：真实服务状态与运行指标；
- **基准评测**：固定输入下的质量、时延和运行环境结果。

## 7. 最终验收状态

- **全本地验证通过，支持断网运行**；
- 文本 / 智能体、Qwen3-8B 采访教练、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、后端 / 网页端、Technical Observer、SQLite 已在 DGX Spark GB10 本地协同运行；
- 断开外部网络后产品主链仍可正常使用；
- 真人连续语音采访和产品操作表现流畅。

现场证据：[DGX Spark 最终运行验证](../../07-reports/spark-deployment-evidence-2026-09-29.md)

## 8. 官方参考

- [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/)
- [NVIDIA vLLM agent-ready models for Spark](https://build.nvidia.com/spark/vllm/agent-ready-models)
- [Qwen3.6-35B-A3B GB10 recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling%2Creasoning&hardware=dgx_spark_gb10)
- [NemoClaw installer](https://www.nvidia.com/nemoclaw.sh)
- [NemoClaw OpenClaw quickstart](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart)
- [NemoClaw existing vLLM setup](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-vllm)
- [Step-Audio 2 official repository](https://github.com/stepfun-ai/Step-Audio2)
- [NeMo Retriever getting started](https://docs.nvidia.com/nemo/retriever/latest/extraction/getting-started-about/)
