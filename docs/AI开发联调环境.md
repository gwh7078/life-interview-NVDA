# 人生采访局 NVIDIA 版｜AI 开发、对接、联调与测试环境

版本：2026-09-24
适用对象：Codex、其他 AI 开发 Agent、前后端开发、Agent/Skill 开发、联调与测试人员。

## 1. 文档目的

本文件是本项目的运行环境入口。AI 接手任务时应先读取本文件，再读取对应的产品、数据库和功能文档。

当前 Mac 开发环境已经部署：

```text
Mac
├─ NemoClaw / OpenShell
│  └─ OpenClaw sandbox: my-assistant
│     └─ 本机转发 127.0.0.1:18790
│
└─ NVIDIA NeMo Retriever
   ├─ Service + REST + MCP: 127.0.0.1:7670
   └─ Internal VectorDB:     127.0.0.1:7671
      └─ LanceDB
```

当前 Retriever 使用百炼 `qwen3.7-text-embedding` 与 `qwen3.7-text-rerank` 远程接口；本机配置的索引模式为 `hybrid`。服务配置通过环境变量读取凭证，不要求使用 NVIDIA 远程模型。

Phase 1 的真实 Agent smoke 使用 NemoClaw/OpenClaw 加只读 Tool API，不依赖 Retriever 或 RAG。Phase 3 A+B 已将 Retriever 接入 Realtime Slow Path 的条件式 recall，但不改变 Phase 1 核心用户路径；当前自动 Gate G0–G8 已通过。

### 当前模型路由与验收状态（2026-09-25）

| 路径 | 当前配置 | 说明 |
|---|---|---|
| 默认实时语音 | `stepaudio3_quality` → StepAudio 3 Realtime Preview → StepFun Cloud | 使用共享 StepFun Realtime transport / normalized adapter；通过 `STEPAUDIO3_REALTIME_MODEL` 配置模型，默认 `stepaudio-3-realtime-preview`。 |
| 第二条正式实时语音 | `stepaudio2_mini` → Step-Audio-2-mini → StepFun Cloud | 使用同一共享 transport，保留 Local VAD / manual turn、Tool Result / Resume；通过 `STEPFUN_REALTIME_MODEL` 配置。未来只替换此 Profile 的执行后端。 |
| 实验语音 Provider | ModelBest MiniCPM-o Realtime — **Experimental** | 保留独立 adapter，不作为默认路线，也不自动回退。 |
| OpenClaw Agent 与会后文本任务 | Bailian `qwen3.6-35b-a3b` | Agent 的默认、推理、快速推理、写作 profile 共用此模型；文本任务通过 Model Studio OpenAI-compatible Chat API 调用。 |
| Realtime Memory | `REALTIME_MEMORY_TRIGGER=voice_tool` 由 Voice ToolCall 决定；`backend_auto` 由 `user.transcript.final` 后端触发。两种策略互斥，共用 Current Story Retriever → Q+A Evidence → `interview.context_hint` Agent → Realtime Context Result。 | Backend Auto 不 HOLD Voice；结果须在 5,000 ms 内完成，注入能力未通过真实 Provider 验证时报告 unsupported。Voice ToolCall 使用 5,000 ms 总 deadline，失败或超时发送 empty/no-context Tool Result 并 Resume。Pending Hint 带绝对 expiresAt，消费前复查 TTL；使用 turnId、contextVersion 与 coordinator generation 丢弃 stale 结果。禁止 raw Retriever fallback、recent transcript 与 full summary。 |

Realtime Context Agent 配置：`AGENT_MODEL_REALTIME_CONTEXT` → `AGENT_MODEL_REASONING_FAST` → `AGENT_MODEL_DEFAULT`；最多一次尝试，Task timeout 4.8 秒、关闭 thinking 与 repair。`interview.context_hint` 通过 OpenClaw `infer model run --local --json` 单次推理执行；运行时把 `interview-observer` Skill 和固定 Q+A Task Context 一起传入，不调用工具、脚本、MCP 或数据库。`REALTIME_MEMORY_TRIGGER` 只接受 `voice_tool` 或 `backend_auto`；默认 `backend_auto`，不自动切换。运行 `./deploy/mac/install-skill.sh` 可把 Skill 安装到 NemoClaw workspace；Context Hint 的执行不依赖 `openclaw agent` 工具配置。`COMPETITION_TECH_PANEL=1` 只控制比赛 WebSocket 面板的 allowlisted 状态发送，不会启用 Retriever 或 Agent；SSE 技术观测栏可独立读取运行模型、Trigger、Retriever、Context Agent 与 Context Injection 状态，并可用 `?demo=tech` 自动打开。两个面板和两个运行开关相互独立。

2026-09-25 本轮真实 Provider 证据（合成音频）：Step-Audio-2-mini 与 StepAudio 3 均确认 assistant 上下文项被接受，后续 response.create 的语音转录读出了唯一测试标记；两者手动 commit、response.create 与音频收发通过。StepAudio 3 正向 Tool Call、Tool Result、Resume 与恢复音频通过。Mini 的一次正向历史人物探针注册工具成功，但模型没有发出 Tool Call。Bailian Context Agent smoke 已到达模型请求，但返回 HTTP 403 `Free quota exhausted`；StepAudio 3 语音 E2E 的 CASE A 语音采访通过，Closeout 同样返回 HTTP 403，CASE B Continue 未运行。因此两种策略的真实 Retriever + Agent 完整链路，以及 StepAudio 3 Continue Closeout 的真实验收仍未通过；不得从本轮结果推断策略优劣。

Model Studio 文档确认模型 ID 为 `qwen3.6-35b-a3b`，支持文本输入、函数调用和 262,144-token context window；参见 [Qwen3.6-35B-A3B 模型说明](https://www.alibabacloud.com/help/en/model-studio/qwen3-6-35b-a3b) 与 [OpenAI-compatible Chat API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)。

## 2. 环境文件

仓库提供：

- `.env.example`：可提交的环境模板，不包含真实凭证。
- `.env`：当前 Mac 的本地地址配置，已由 `.gitignore` 排除。
- `AGENTS.md`：进入项目的 AI 必须遵守的环境与数据边界。
- `scripts/check-ai-env.sh`：一键检查 Retriever、VectorDB、OpenClaw 转发和 Codex MCP 注册。

业务代码应从环境变量读取地址，不要硬编码本机端口。

## 3. 当前服务与用途

| 组件 | 地址/名称 | 谁使用 | 用途 |
|---|---|---|---|
| NemoClaw sandbox | `my-assistant` | 开发/运维 | OpenClaw 隔离运行环境 |
| OpenClaw sandbox forward | `http://127.0.0.1:18790` | 开发者/后端 | 当前 sandbox 的 Web/服务入口 |
| NeMo Retriever Service | `http://127.0.0.1:7670` | Web Backend/Agent | ingest、query、collections、health |
| NeMo Retriever MCP | `http://127.0.0.1:7670/mcp` | Codex/OpenClaw/Agent | Agent 工具式检索与写入 |
| Retriever VectorDB | `http://127.0.0.1:7671` | Retriever 内部 | LanceDB 向量/混合索引 |

`7671` 是内部接口。业务后端和 Agent 不得直接调用 `/internal/vectordb/write`，统一经过 `7670`，避免耦合 Retriever 内部实现。

## 4. Codex MCP 已配置

当前 Codex 全局已注册：

```text
name:      nemo-retriever-local
transport: streamable_http
url:       http://127.0.0.1:7670/mcp
enabled:   true
```

检查：

```bash
codex mcp get nemo-retriever-local
```

如新的 Codex 会话没有立即出现 Retriever 工具，重新打开/刷新 Codex 会话，让 MCP 配置重新加载。

当前 Retriever MCP 可提供的核心工具包括：

- `health`
- `pipeline_config`
- `get_job`
- `list_job_documents`
- `get_document`
- `query`
- `answer`
- `ingest_documents`

当前配置为 `query_methods: classic`，因此以 `query` 为主；Agentic query 未作为本阶段依赖。

## 5. 产品数据与 Retriever 的职责

本项目必须维持两层存储：

```text
实时采访
  │
  ├─> 业务数据库（权威数据）
  │    ├─ interview_sessions
  │    ├─ transcript_segments
  │    ├─ stories / story_state
  │    └─ closeout 结果
  │
  └─> NeMo Retriever（可重建的检索副本）
       └─ Transcript document -> chunks -> embedding -> LanceDB
```

规则：

1. Transcript 先成功写业务数据库，再进入 Retriever。
2. Retriever 失败不能导致原始 Transcript 丢失或 Session 保存失败。
3. Retriever 索引可以删除并根据业务数据库重建。
4. Story State、Summary、Gaps 等结构化业务状态仍由业务数据库管理，Retriever 主要解决“历史原话/历史采访片段搜索”。
5. Agent 检索结果必须能追溯到 `session_id + segment_id` 或等价来源引用。

## 6. Web 写入 Retriever 的标准链路

浏览器/WebView/微信小程序不能直接访问 Retriever。标准链路：

```text
Browser / 小程序
       │
       ▼
人生采访局 Backend
       │
       ├─> SQLite/业务数据库
       │
       └─> NeMo Retriever REST :7670
```

一次 Session 结束后的推荐流程：

```text
1. transcript_segments 持久化完成
2. session 标记 ended/processing
3. Closeout / Summary 正常执行
4. 构造一份 Session Transcript 文档
5. POST /v1/ingest/job
6. POST /v1/ingest/job/{job_id}/document
7. 异步确认索引结果
8. retriever_status = indexed / failed
```

建议业务侧增加索引状态字段或独立任务状态：

```text
pending -> indexing -> indexed
                  \-> failed -> retry
```

不要让 Retriever 网络耗时阻塞“结束通话 -> 结果页”的核心用户路径。

## 7. Transcript 文档格式

Retriever 的最小检索单位由其 pipeline 切 chunk；业务侧建议“一次 Session 一份文档”，不要逐句调用 embedding。

推荐文本：

```text
# Story: 第一次创业
session_id: sess_xxx
story_id: story_xxx
stage_id: stage_xxx
session_type: story

[segment_id=seg_001][user]
我第一次真正决定创业是在……

[segment_id=seg_002][agent]
当时是什么让你最终下这个决定？

[segment_id=seg_003][user]
……
```

上传 metadata 至少包含：

```json
{
  "user_id": "...",
  "session_id": "...",
  "story_id": "...",
  "stage_id": "...",
  "session_type": "story",
  "ended_at": "2026-09-20T..."
}
```

`story_id` / `stage_id` 在对应场景不存在时可为空。不要把敏感 token 或 API Key 放进 metadata。

## 8. Retriever REST 契约

### 8.1 健康检查

```text
GET /v1/health
```

### 8.2 创建 ingest job

```text
POST /v1/ingest/job
Content-Type: application/json
```

最小 body：

```json
{
  "expected_documents": 1,
  "label": "session:sess_xxx",
  "metadata": {
    "source": "life-interview-web"
  }
}
```

保存返回的 `job_id`。

### 8.3 上传 Transcript

```text
POST /v1/ingest/job/{job_id}/document
Content-Type: multipart/form-data
```

字段：

- `file`：完整 Transcript 文档。
- `metadata`：JSON 字符串，包含 filename/content_type/业务 metadata。

Retriever 返回 `202` 表示已接受处理，不代表 embedding/index 已完成。后端需要查询 job/document 状态或异步重试。

### 8.4 查询

```text
POST /v1/query
```

Agent 侧优先通过 MCP `query` 使用同一能力。需要引用原文时返回 hits/evidence，并保留 document/chunk metadata。

## 9. MCP 与 REST 的分工

```text
Web Backend ──REST──> Retriever
   负责：Session Transcript 写入、状态同步、删除/重建索引

Agent/Codex/OpenClaw ──MCP──> Retriever
   负责：按需要搜索历史采访、检查索引、开发调试
```

不要让 Web 后端依赖 MCP 才能保存 Transcript。HTTP 是产品后端稳定的数据面；MCP 是 Agent 工具面。

## 10. 本机启动与检查

### 10.1 检查整体环境

```bash
bash scripts/check-ai-env.sh
```

### 10.2 NemoClaw

常用命令：

```bash
nemoclaw my-assistant status
nemoclaw launch my-assistant
nemoclaw my-assistant connect
nemoclaw my-assistant logs --follow
```

需要浏览器认证地址时现场生成：

```bash
nemoclaw my-assistant dashboard-url --quiet
```

该命令可能输出带认证信息的 URL，只用于本机临时访问，不得提交到 Git 或粘进公共日志。

### 10.3 NeMo Retriever

默认 Retriever runtime 目录为 `$HOME/.local/share/nemo-retriever`，可通过 `NEMO_RETRIEVER_HOME` 覆盖。仓库不打包 Retriever venv 或服务配置；首次使用前需准备：

```text
$NEMO_RETRIEVER_HOME/.venv/bin/retriever
$NEMO_RETRIEVER_HOME/retriever-service.yaml
$NEMO_RETRIEVER_HOME/.env
$NEMO_RETRIEVER_HOME/lancedb
```

这些属于本机运行时路径，不应成为仓库代码依赖。DGX Spark 部署时通过环境变量换成 Spark 对应路径。

macOS 本机 Retriever 由用户级 launchd agent `com.gwh.nemo-retriever` 管理：登录时启动，进程退出后自动重启；Retriever 前台进程同时监督本机 VectorDB。`scripts/codex-worktree-setup.sh` 和 `scripts/codex-dev.sh` 都会调用幂等的 `scripts/install-local-retriever-service.sh`，为已准备好的 runtime 安装或更新 LaunchAgent。安装器从当前用户登录钥匙串同步 `DASHSCOPE_API_KEY` 到 runtime `.env`（权限 `0600`），不会把密钥写入 LaunchAgent plist、日志或 Git。新 Mac/协作者需先准备 Retriever venv 和配置，并在自己的登录钥匙串中配置凭据；仓库安装器不会下载或安装 NeMo Retriever 本身。

`scripts/codex-dev.sh` 会等待 Retriever 和 VectorDB 的 health endpoint 都返回 HTTP 200，再启动网页。检查、安装或重启：

macOS 登录钥匙串只对当前用户账户共享；其他协作者需通过各自的安全凭据渠道配置，不要通过仓库共享密钥。

```bash
NEMO_RETRIEVER_HOME="$HOME/.local/share/nemo-retriever" bash scripts/install-local-retriever-service.sh
launchctl print "gui/$(id -u)/com.gwh.nemo-retriever"
launchctl kickstart -k "gui/$(id -u)/com.gwh.nemo-retriever"
bash scripts/ensure-local-retriever.sh
bash scripts/check-ai-env.sh
```

`scripts/check-ai-env.sh` 对 loopback 地址禁用系统代理，避免把 `127.0.0.1` 的健康请求送到 HTTP 代理。

## 11. 凭证

当前 NeMo Retriever 服务的远程 embedding / rerank 会读取：

```text
DASHSCOPE_API_KEY
```

两个正式语音 Profile 共用 StepFun Cloud 凭证与 Realtime transport：

```text
STEPFUN_API_KEY
```

实验性 MiniCPM-o Realtime 读取 `MODELBEST_API_KEY`。该 Key 必须由本机安全运行环境提供；当前 Worktree 没有配置该凭证。

MiniCPM-o Realtime adapter 配置 `MODELBEST_API_KEY`，输入为 16 kHz 单声道 Float32 PCM，输出为 24 kHz 单声道 Float32 PCM；本项目把浏览器 PCM16 转为/从 Float32。连接地址遵循 [OpenBMB 官方 Realtime API 文档](https://github.com/OpenBMB/MiniCPM-o-Demo/blob/main/docs-app/content/docs/en/realtime-api/overview.md)，使用 `wss://minicpmo45.modelbest.cn/v1/realtime?mode=audio`。该公开协议不定义 `response.create` 或工具调用/结果事件。当前工作树未配置 MiniCPM 凭证，真实 E2E 为 **NOT TESTED**。

切换到 NVIDIA endpoint 时才需要相应的 NVIDIA credential，例如：

```text
NVIDIA_INFERENCE_API_KEY
```

原则：

- `.env.example` 只能保留空值/变量名。
- `.env` 不提交 Git；本机凭证通过 macOS 登录钥匙串同步到当前工作树，当前文件权限为 `0600`。
- `scripts/codex-keychain.swift` 支持 `STEPFUN_API_KEY`、`BAILIAN_API_KEY`、`CLOSEOUT_API_KEY` 与 `DASHSCOPE_API_KEY` 的安全导入和同步。
- AI 不得通过 `printenv`、日志、异常堆栈主动输出完整 Key。
- 重新部署时若缺凭证，应提示开发者在本机安全环境设置，而不是写死到代码。

## 12. 开发阶段接口抽象

后端建议只依赖一个 `RetrieverAdapter`（名称可按现有项目风格调整），至少提供：

```text
indexSessionTranscript(sessionId)
searchTranscript(scope, query, topK)
deleteSessionTranscript(sessionId)
getIndexStatus(sessionId)
```

这样 Mac 开发环境使用 `127.0.0.1:7670`，迁移 DGX Spark 时只替换 endpoint/config，不改业务调用方。

索引任务必须幂等。相同 `session_id` 重试不能无限制造重复检索内容；实现时应保存 Retriever `job_id/document_id`，并设计 replace/delete+reindex 策略。

## 13. 测试最低要求

每次涉及 Retriever 的开发至少验证：

1. `scripts/check-ai-env.sh` 通过。
2. Session 原始 Transcript 即使 Retriever 不可用仍能正常落库。
3. 一次 Session 能成功 ingest，最终 VectorDB 出现可查询内容。
4. 用 Transcript 中一个独特事实进行 `query`，能召回对应片段。
5. 结果能追溯到正确的 `user_id/session_id/story_id/segment_id`。
6. 重复执行索引不会造成不可控重复数据。
7. Retriever 失败时状态进入 `failed` 且可重试。
8. 不在浏览器代码中出现 `7670/7671` 或 NVIDIA Key。

## 14. 本机验证记录

环境状态会随本机服务变化，不能把下面的结果当作永久可用性保证：

### 2026-09-20 历史记录

- 先前验收记录曾确认 NeMo Retriever `7670 /v1/health`、VectorDB `7671 /v1/health` 返回 HTTP 200，并已初始化 `life-interview-transcripts` collection。
- 本次合并前重新运行 `scripts/check-ai-env.sh` 时，Retriever 和 VectorDB 当前均返回 HTTP 503；这条记录保留为当时的失败证据，不能代表当前状态。
- 当前 OpenClaw sandbox 转发可达（HTTP 400 仍证明端口监听），Codex 已注册 `nemo-retriever-local -> http://127.0.0.1:7670/mcp`。
- NemoClaw sandbox `my-assistant` 经 OpenShell 转发到本机 `18790`；Phase 1 smoke 不因 Retriever 503 而失效。

### 2026-09-22 历史 StepFun / Phase 3 记录

以下 PASS 只代表当时的 StepFun / Phase 3 A+B Gate，不验证现行 MiniCPM Candidate 或本轮新的 Realtime 慢系统状态机。

- `bash scripts/check-ai-env.sh`：通过；NeMo Retriever、VectorDB、OpenClaw 转发与 Codex MCP 均可达。
- `bash scripts/codex-node.sh npm run test:phase3:integration`：Phase 3 A+B Gate G0–G8 全部通过。
- 真实 REST ingest/query、MCP query、StepFun Realtime、Retriever scoped concurrency、slow recall latency 与最终 SQLite / Retriever index / trace 状态均已核对。
- 当前真实会话最终 SQLite 状态为 `completed`，Retriever index 为 `indexed`；SQLite 仍是权威事实源，Retriever 仍是可重建派生索引。
- 自动化 Gate 通过后，仍需人工完成最后的真实语音体验验收。

当前报告：`docs/07-reports/testing/PHASE3_AB_INTEGRATION_REAL_E2E_REPORT_v1.0.md`。

### 2026-09-25 Realtime 收敛状态（历史快照）

- `bash scripts/check-ai-env.sh` 于 2026-09-25 通过；Retriever、VectorDB、OpenClaw 与 Codex MCP 均可达。
- 该快照记录的是后续双 Profile 改造前的 MiniCPM Candidate 方案，不代表当前正式默认路线。
- 2026-09-25 Realtime Context Agent smoke 为 **FAIL**（`AGENT_RUNTIME_TIMEOUT`）。
- 5 秒慢系统 deadline、强制 Agent / no-context、Q+A 证据、stale drop 与观察事件的本地 deterministic / integration 检查见[集成收敛报告](07-reports/testing/REALTIME_INTEGRATION_CONVERGENCE_REPORT_v1.0.md)。

当前双 Profile 与 Independent Memory 的实现及真实 E2E 结果见[Realtime 双路线实施报告](07-reports/testing/REALTIME_DUAL_PROFILE_MEMORY_REPORT_v1.0.md)。

### Codex 项目环境

仓库已提供 Codex Desktop 本地环境定义：

`/.codex/environments/environment.toml`

环境名称：`人生采访局 NVIDIA 本地开发`。

新建 worktree 时会自动运行 `scripts/codex-worktree-setup.sh`；如果 `.env` 不存在，脚本会创建仅本机可读的最小运行模板，并尽力从 macOS Keychain 同步已授权的运行凭证，不会复制其他 worktree 的 `.env`。Codex 顶部环境菜单中可使用“检查 AI 环境”和“查看 NemoClaw 状态”两个项目操作。

## 15. 其他 AI 接手任务的推荐读取顺序

```text
1. AGENTS.md
2. docs/AI开发联调环境.md
3. 人生采访局_V0.2_产品开发文档.md
4. 人生采访局_V0.1_数据库与Tool工程规范.md
5. 当前功能对应的最新开发文档/代码
```

在修改架构前，先以运行中的 API、数据库 schema 和当前代码为准；旧文档与新实现冲突时，记录冲突并以最新已确认产品决策为准。
