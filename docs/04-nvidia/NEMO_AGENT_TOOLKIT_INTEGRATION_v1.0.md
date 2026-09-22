# NeMo Agent Toolkit 接入说明 v1.0

## 定位

NeMo Agent Toolkit（NAT）是本项目的 Evaluation / Regression / Profiling Lane。它不参与正常产品请求，不替换 `NemoClawAgentTaskAdapter`、`AgentTaskExecutor` 或 OpenClaw。

```text
Production Runtime
Backend → AgentTaskPort → NemoClaw Adapter → AgentTaskExecutor
          → NemoClaw/OpenShell → OpenClaw + Skills → Model

Evaluation Lane
NAT → Node Bridge → 同一个 AgentTaskPort → 上述 Production Runtime

Future Observability Lane
NAT → OpenClaw Gateway → nemo-relay → ATIF/OpenInference → Phoenix
```

业务 SQLite、`agent_runs`、Backend Validator 和 Runtime Timing JSONL 继续是生产事实、审计和故障定位的来源。

## 当前状态

| 能力 | 状态 | 说明 |
|---|---|---|
| Node NAT Bridge | Implemented | stdin 只接收 `case_id`，调用 `createAgentTaskPort()` |
| 6 路 Smoke Fixture Registry | Implemented | 原真实 E2E 与 NAT 共用唯一 TypeScript Fixture 来源 |
| NAT Python 子项目 | Implemented | 独立 Python 3.12 / uv 环境，锁定 NAT 1.9.0 |
| NAT Workflow / Evaluator | Implemented | 公开 Plugin API；确定性结果评分 |
| 真实 6-case NAT Smoke | Validated | 2026-09-22：6/6 Runtime、Contract、Backend Validator 与 Semantic checks 通过 |
| 24-case Regression Dataset | Validated locally | `NAT_AGENT_RUNTIME=stub`：24/24 Runtime、Contract 与 Backend Validator 通过；真实 Provider 全量仍是手动门禁 |
| NAT Profiler | Validated locally | Stub runtime 的 6-case profiler check 通过；真实 Provider profiling 仍是手动门禁 |
| NeMo Relay / ATIF / OpenInference | Future | 独立 Gateway Observability Lane，不接管生产链 |
| Phoenix | Future | 可选本地观测 UI，不是运行依赖 |

## 安全边界

- Dataset 只保存 `case_id` 和预期状态；完整 Synthetic Fixture 由 TypeScript Registry 提供。
- 不把真实用户 Transcript、Prompt、用户 ID、Token、API Key 或 Raw Agent Output 写入 Dataset、Git 或公开报告。
- NAT 原始结果、有效配置、Evaluator 输出和 Profiler Trace 只放在 `.tmp/nat/`。
- Python 不直接连接模型或 NemoClaw；它只调用 Node Bridge。Node Bridge 再进入现有 Agent Runtime。
- NAT 层不额外重试；Agent 自身的 retry / repair 只由 `AgentTaskExecutor` 负责。

## 命令

```bash
npm run test:agent:nat:unit
npm run test:agent:nat:smoke
npm run test:agent:nat:profile
npm run test:agent:nat:eval
```

Smoke 聚合指标见 [`NAT_AGENT_EVAL_REPORT_v1.0.md`](../07-reports/nat/NAT_AGENT_EVAL_REPORT_v1.0.md)。六路 Fixture
仍是 Runtime Port Fixture；Runner 已在 Proposal 边界复用现有 Backend Validator，六路
`backend_validation=passed`。由于没有构建并持久化 Session、Story、Share、Document 域数据，这不代表完整产品
工作流和数据库落库验收。

真实 NAT Smoke 与 Full Eval 需要本机已有 `NEMOCLAW_SANDBOX`、Provider 配置和 NemoClaw/OpenClaw 服务，因此不放入普通 CI。
