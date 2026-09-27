# One-Day DGX Spark Runbook v1.0

> 约束：Spark 只租用一天。  
> 原则：租机当天只做真机部署、兼容性修复、Benchmark、完整验收和证据留存。

## 0. 租机前一天必须 Ready

确认：

- GitHub main 已包含 `deploy/spark/`；
- `install.sh` / `verify.sh` 已完成非 Spark 环境的静态验证；
- HF token / NGC / GitHub 凭据准备好；
- 需要 accept license / model access 的模型已经提前处理；
- 模型 handle、镜像 tag、端口全部配置化；
- 固定音频与 benchmark dataset 已在 repo 或可快速获取的位置；
- README 不依赖当天临时写；
- Coding Agent 能在 Linux ARM64 上使用；
- 不需要现场重新做产品决策。

## 1. T+0：先采集机器事实

第一件事不是安装。

执行 `preflight.sh`，保存：

```text
hostname
OS / kernel
architecture
DGX / partner identity
driver
CUDA
Docker
Container Runtime
CPU
system memory
swap
disk
network
ports
```

人工同时确认：

```bash
uname -a
uname -m
cat /etc/os-release
nvidia-smi
docker info
free -h
df -h
```

如果 ARM64 / GPU / Docker GPU 不成立，暂停产品部署，先修基础环境。

## 2. T+早期：立即启动所有大下载

最浪费一天的是串行等待模型。

尽早并行准备：

- Qwen3.6-35B-A3B-NVFP4；
- Step-Audio-2-mini；
- Coach local model；
- NeMo Retriever image / model assets；
- vLLM / vLLM-Omni / NemoClaw images；
- Hugging Face cache。

规则：

- 所有下载进入持久 cache；
- 不允许相同模型被两个脚本重复下载；
- 记录 download start/end；
- 下载失败可 resume；
- 不为了并行把磁盘 / network 打爆。

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
2. 检查 image / vLLM version；
3. 检查 UMA pressure；
4. 降低 context / memory utilization；
5. 再考虑 SGLang；
6. 不要直接重写产品 Runtime。

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
ARM64 runtime / image
→ model load
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

## 10. Gate H：一键重装验证

当天后段必须做一次“接近新用户”的复现：

```bash
git clone ...
cd life-interview-NVDA
./deploy/spark/install.sh
./deploy/spark/verify.sh
```

不要求浪费时间重新下载已缓存模型，但必须证明：

- fresh repo；
- 只依赖 documented env/secrets；
- 不依赖手工复制未提交文件；
- 不依赖某个 shell session 的临时变量；
- start/stop/restart/status 可重复。

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
P0  环境事实 + 下载 + Post-session Local
P0  NemoClaw / Skills
P0  Retriever
P0  Step-Audio Local
P0  Full Stack
P1  Coach latency tuning
P1  Benchmark
P1  One-command replay
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
