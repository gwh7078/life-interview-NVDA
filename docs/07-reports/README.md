# Engineering Reports

本目录用于逐阶段保存测试、部署、Agent Eval、Benchmark 与失败修复报告。

## 为什么单独保存 Reports

比赛项目不仅要展示“最后能跑”，还应该能够回答：

- 哪一步什么时候被验证；
- 哪些方案失败过；
- 为什么换架构；
- Agent 是否真的稳定；
- Mac 与 DGX Spark 性能差多少；
- 不同模型在不同 Task 上效果如何。

因此报告不覆盖旧版，新测试生成新文件。

## 已有历史报告

当前已有 Phase 1 报告仍位于：

- `../nvidia-agent-native/PHASE1_IMPLEMENTATION_REPORT.md`
- `../nvidia-agent-native/PHASE1_LOCAL_SMOKE_RESULT.md`
- `../nvidia-agent-native/PHASE1_SMOKE_CHECKLIST.md`

暂不移动，以保持历史路径稳定。

当前验收报告：

- `nat/NAT_AGENT_EVAL_REPORT_v1.0.md` — NeMo Agent Toolkit 六路真实 Runtime Smoke 与聚合指标
- `testing/PHASE2B_C_REAL_AGENT_E2E_REPORT_v1.0.md` — Phase 2B-C 六路径真实 Agent E2E
- `testing/PHASE3A_RETRIEVER_CLASSIC_RETRIEVAL_LOCAL_REPORT_v1.0.md` — Phase 3A Retriever / Classic Retrieval 本机联调
- `testing/PHASE3_AB_INTEGRATION_REAL_E2E_REPORT_v1.0.md` — Phase 3 A+B 真实 Integration Gate，G0–G8 全部通过

## Future Structure

```text
07-reports/
├── deployment/
├── testing/
├── agent-eval/
├── benchmarks/
└── incidents/
```

建议后续报告命名：

```text
PHASE2A_CONTRACT_TEST_REPORT_v1.0.md
PHASE2B_AGENT_E2E_REPORT_v1.0.md
MODEL_BENCHMARK_v1.0.md
DGX_SPARK_DEPLOYMENT_REPORT_v1.0.md
REALTIME_SLOW_SYSTEM_BENCHMARK_v1.0.md
```

## Benchmark 建议指标

### Agent

- Task success rate
- Schema success rate
- Repair rate
- Evidence validation failure rate
- Memory information-loss rate
- Latency P50 / P95
- Token usage

### Generation

- factual consistency
- unsupported detail rate
- style adherence
- revision preservation

### Runtime

- NemoClaw start / execution success
- timeout rate
- result missing rate
- stale result handling

### DGX Spark

- model load time
- first-token latency
- end-to-end task latency
- GPU / memory footprint
