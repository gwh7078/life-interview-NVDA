# DGX Spark 部署现场证据

**采集日期：** 2026-09-29（Asia/Shanghai）

**结果：** PARTIAL LOCAL
**用途：** 记录租用的 NVIDIA DGX Spark 上实际部署和检查过的本地组件。PASS 仅代表相应时间、设备和检查范围。

## 当前设备快照

Spark 仓库已快进到比赛项目 `main` / `origin/main`，提交 `43a60ac8dd792483c6438af86854fb3d6c97de66`，当时工作区干净。主机为 NVIDIA DGX Spark GB10（ARM64 / aarch64）。

在 Spark 仓库根目录运行 `bash deploy/spark/check-env.sh`：**12/12 PASS**。

| 检查项 | 现场结果 |
| --- | --- |
| ARM64、NVIDIA GPU/驱动、Docker、NVIDIA Container Runtime | PASS |
| Python 3.12.3、Node.js 24.21.0、npm 12.1.0、Git | PASS |
| Text | PASS；`nvidia/Qwen3.6-35B-A3B-NVFP4`，`127.0.0.1:8000/v1` |
| Coach | PASS；`Qwen3-8B`，`127.0.0.1:8004/v1` |
| StepAudio | PASS；WebSocket `127.0.0.1:8092/realtime`；健康检查 `8093` 返回 `{"ok":true,"model":"step-audio-2-mini"}` |
| NeMo Retriever | PASS；REST `127.0.0.1:7670/v1/health` 返回 `{"status":"ok","mode":"standalone"}` |
| 应用、Observer、SQLite | `bash deploy/spark/status.sh`：Backend/Web RUNNING、Observer RUNNING、SQLite PASS |

同一现场快照中，`status.sh` 报告 NemoClaw/OpenClaw **NOT READY**。本轮没有完成 OpenClaw Agent Task。`nvidia-smi` 在 15:58:57 返回 `NVIDIA GB10, 95%, memory [N/A]`；该读数与一次未完成的语音冒烟时间重叠，未能确认负载归属，不作为推理性能证据。

## 已有验证与边界

| 验证 | 结果 | 适用范围 |
| --- | --- | --- |
| Full `verify.sh`，run `20260929T053338Z-2542977` | **15 gates：13 PASS、2 FAIL**；失败为 G4b Product Realtime Provider E2E 和 G7b Actual OpenClaw Agent Task | 该报告记录的代码提交是旧提交 `66fa8f7ade5d6b37aec841174effdf137764ed55`，不是本次快进后的 `main`。不能当作最新 `main` 的 verify 结果。 |
| 历史 StepAudio bridge / Realtime Provider E2E | PASS；ASR 2.632 秒、首个音频 55.483 秒、12 个音频块；产品 E2E 的 user-commit-to-final-transcript 计时为 141.713 秒 | 使用 stub Coach、关闭 Retriever；不是完整业务 E2E 或真人语音验收。141.713 秒不是纯 ASR 耗时。详细记录见 [`spark-stepaudio2-realtime-e2e-20260929.md`](../references/spark-stepaudio2-realtime-e2e-20260929.md)。 |
| 历史 Spark benchmark，run `20260929T060400Z-2624627` | **FAIL**；Text 首 token P50/P95 65/102 ms、总耗时 336/362 ms；Coach Gate 6.955/9.279 秒、Resolve 4.697/5.160 秒；Retriever 查询 360/381 ms 且 scope 通过；Realtime 首音 P50/P95 57.054/59.375 秒；并发项 FAIL | 这是此前版本与运行时的一次测量，不能代表更新后的 Bridge 性能。 |
| 本次快进后 StepAudio 冒烟 | **NOT COMPLETED** | 有限租期内未取得完整结果；不计 PASS。 |

## 复现与评审说明

当前设备检查可在租用 Spark 上、从仓库根目录重跑：

```bash
bash deploy/spark/check-env.sh
bash deploy/spark/status.sh
```

本次检查证明 Spark 上已运行产品应用、Observer、Text、Coach、StepAudio 和 Retriever 的本地部署/接线。完整 Agent 与业务端到端验收仍未通过；因此整体结论为 **PARTIAL LOCAL**，不宣称 FULL LOCAL PASS。快进到最新 `main` 后没有重启应用进程，也没有在该提交上重跑完整 `verify.sh` 或 benchmark；当前进程是否已加载最新应用代码尚未验证。
