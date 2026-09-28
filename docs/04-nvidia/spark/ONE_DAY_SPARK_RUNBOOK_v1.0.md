# One-Day DGX Spark Runbook v1.0 (historical plan)

> 本文记录比赛日的验证顺序，不再定义安装器或 Runtime 管理方式。当前
> 部署边界、官方 Runtime 链接和命令以 [当前 Spark 部署说明](README.md)
> 与 [deploy/spark/README.md](../../../deploy/spark/README.md) 为准。旧版
> install/bootstrap/models/restart 命令已删除，不要按本文旧版本执行。

> 约束：Spark 只租用一天。  
> 原则：租机当天只做真机部署、兼容性修复、Benchmark、完整验收和证据留存。

## 0. 租机前一天必须 Ready

确认：

- 最新 main 包含 `deploy/spark/setup.sh`、`start.sh` 和应用验证脚本；
- 用户将按 NVIDIA / StepFun 官方说明准备 Text、Coach、StepAudio 和 Retriever；
- Text 与 Agent 共用的 served model ID、Coach served model ID 和各 endpoint 已确认；
- 模型许可、官方 Runtime 先决条件和必要凭证由 Runtime 操作者处理；
- 固定语音 fixture 与 benchmark dataset 已在 repo 或可快速获取的位置；
- README 不依赖当天临时写；
- Coding Agent 能在 Linux ARM64 上使用；
- 不需要现场重新做产品决策。

## 1. T+0：只检查机器与 endpoint readiness

仓库不安装或修复 DGX OS、Driver、CUDA、Docker 或 NVIDIA Container Runtime。
先运行只读检查：

```bash
./deploy/spark/check-env.sh
```

如需记录更完整的硬件清单，操作者另行保存下列命令结果。

人工同时确认：

```bash
uname -a
uname -m
cat /etc/os-release
nvidia-smi
docker info
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi
free -h
df -h
```

如果 ARM64 / GPU / Docker GPU 不成立，按 NVIDIA 官方说明准备主机后再运行应用 setup。

## 2. T+早期：按官方说明准备外部 Runtime

模型下载、镜像选择和 GPU memory 参数由 Runtime 操作者按当前供应商 recipe 决定。
本仓库不执行这些下载或启停操作。

在克隆应用前启动并检查：

```text
Text       OpenAI-compatible :8000/v1
Coach      OpenAI-compatible :8001/v1
StepAudio  Product WebSocket ws://127.0.0.1:8092/realtime
Retriever  REST :7670, VectorDB :7671
```

参考模型、官方文档、health checks 与完整安装步骤见当前部署说明。

## 3. Gate A：Post-session Model

先拿最确定的 Spark-native 闭环。

```text
vLLM
→ nvidia/Qwen3.6-35B-A3B-NVFP4
→ /health
→ /v1/models
→ chat completion
```

再验证：

```text
Backend Text Runtime
→ Closeout
→ Completion
→ Generation
```

失败顺序：

1. 对照 NVIDIA 当前 GB10 recipe；
2. 按模型 Runtime 官方说明检查 served ID、版本和设备资源；
3. 记录实际 latency、失败和资源观察；
4. 将 endpoint 配置回产品 profile；
5. 不通过修改访谈业务逻辑或 Coach deadline 掩盖 Runtime 问题。

## 4. Gate B：NemoClaw / OpenShell / Skills

```text
NemoClaw installed
→ sandbox healthy
→ local vLLM provider reachable
→ OpenClaw healthy
→ formal Skills installed
→ policy valid
→ Agent six-path E2E
```

遇到 sandbox 无法访问 host model：

- 优先查 OpenShell policy / bind address / provider route；
- 不关闭 sandbox security 作为长期修复。

## 5. Gate C：NeMo Retriever

```text
service health
→ ingest
→ query
→ current-story scope
→ isolation
→ Era index
→ Era query
```

必须保存 latency 与 isolation evidence。

如果 Retriever 全链失败但 ARM64 image/service 正常：

- 优先修 service config；
- 不修改 SQLite Source of Truth；
- 不允许 raw retrieval 直接绕过现有业务验证。

## 6. Gate D：Coach

将当前 Coach 的执行 endpoint 指向 Spark local model。

必须验证：

- Story Create / Contributor Gate；
- Story Continue Gate；
- memory true/false；
- era true/false；
- dual retrieval；
- Gate timeout；
- Resolve timeout；
- stale；
- Onboarding async sidecar。

业务 deadline 不因为 Spark 迁移而放宽：

```text
Gate <= 2s
Coach total <= 6s
```

如果本地模型性能达不到，先记真实 benchmark，再决定模型优化；不要靠改 deadline 隐藏问题。

## 7. Gate E：Step-Audio-2-mini

这是当天最高风险任务，但不要让它阻塞前四个 Gate。

执行顺序：

### E1 Model / Runtime

```text
按 StepFun 官方说明安装并启动外部 Local Runtime
→ 产品 WebSocket contract 可用
→ fixed audio ASR
→ fixed text/audio generation
→ audio-to-audio
```

### E2 Streaming

```text
stream input
→ progressive output
→ first audio latency
→ long response stability
```

### E3 Local Provider Adapter

验证真实 normalized events。

### E4 Interview

至少完成：

- opening；
- 5 turns；
- ASR transcript；
- audio replies；
- manual/server turn behavior；
- Coach injection；
- end / closeout。

### E5 Capability

分别实测，不假设：

- interrupt；
- barge-in；
- tool call；
- context injection；
- explicit turn；
- response cancel。

不支持就准确关闭 capability。

## 8. Gate F：完整产品

Spark 本机浏览器：

```text
Onboarding
→ Life Stage
→ Story Create
→ Realtime Interview
→ Closeout
→ Summary / Agent Memory
→ Completion / Gap
→ Story Continue + Memory/Era Coach
→ Contributor
→ Story Generation
→ Book / PDF path
```

再从远程机器通过安全 tunnel 访问一次，证明远程使用路径。

## 9. Gate G：并发和资源

至少测：

```text
Voice only
Voice + Coach
Voice + Retriever
Voice + Coach + Retriever
Voice + background Closeout
2 Realtime Sessions
```

记录：

- first audio；
- Coach P50/P95；
- retrieval P50/P95；
- text generation；
- CPU；
- system memory；
- swap；
- GPU utilization；
- process list；
- timeout/error rate。

UMA 下如果 `nvidia-smi` 不提供 Memory-Usage，不写假数据；记录 `free`、process metrics、DGX Dashboard / 可用 telemetry。

## 10. Gate H：应用部署复现

在 AI Runtime 已准备并运行后，按正常开源软件步骤复现应用部署：

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA
cp deploy/spark/env.example deploy/spark/.env
# 编辑 deploy/spark/.env，填入 served model IDs 和 endpoints
./deploy/spark/check-env.sh
./deploy/spark/setup.sh
./deploy/spark/start.sh
./deploy/spark/verify.sh
```

必须证明：

- 用户预先启动的四类 Runtime 可连接；
- setup 配置的 OpenClaw 复用已运行的 Text model；
- 只依赖文档与本机 ignored 配置；
- 不依赖手工复制未提交文件；
- 不依赖某个 shell session 的临时变量；
- setup、start、stop 可重复；
- stop 不影响任何用户管理的 AI Runtime。

## 11. 最终必须带走的证据

在租期结束前 push 到 GitHub 或导出：

```text
docs / reports
deploy/spark final files
exact versions
final env.example
benchmark summary
verify report
service logs (sanitized)
screenshots
technical observer capture
architecture diagram updates
final commit SHA
```

禁止只把证据留在租用机器本地。

建议最终目录：

```text
docs/07-reports/spark/
├── ENVIRONMENT.md
├── INSTALLATION_REPORT.md
├── FULL_STACK_ACCEPTANCE.md
├── BENCHMARK.md
└── KNOWN_LIMITATIONS.md
```

## 12. 当天优先级

必须完成优先级：

```text
P0  环境事实 + 用户准备的 Runtime + Post-session Local
P0  NemoClaw / Skills
P0  Retriever
P0  Step-Audio Local
P0  Full Stack
P1  Coach latency tuning
P1  Benchmark
P1  应用部署复现
P2  UI polish
P3  非必要架构优化
```

当天禁止：

- 为比赛“看起来复杂”而加 Agent；
- 临时重写数据库；
- 改业务 Contract；
- 临时做 Agentic Retrieval 大功能；
- 在 Voice 尚未跑通时做无关 UI 优化；
- 未保存证据就结束远程租用。
