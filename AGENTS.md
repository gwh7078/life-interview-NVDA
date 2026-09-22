# Codex development instructions

- Use `bash scripts/codex-node.sh <command> [args...]` for every Node.js or npm command. The wrapper selects a Node.js version compatible with this project's lockfile without replacing the system Node.
- Use `bash scripts/codex-dev.sh` to start the local app and `bash scripts/codex-verify.sh` for the local test suite.
- Each Worktree owns `data/codex-worktree.db`. Never point it at a shared or production database. Setup initializes this file only when it does not already exist.
- On macOS, keep provider API keys in the user's login Keychain; setup may materialize only the required `VOLCENGINE_API_KEY`, `STEPFUN_API_KEY`, and `CLOSEOUT_API_KEY` into the current Worktree's ignored `.env` with mode 0600. Never copy `.env` into another Worktree, add it to `.worktreeinclude`, commit it, or print its values.
- `VOLCENGINE_API_KEY` is for the realtime voice model; `CLOSEOUT_API_KEY` is a separate key for post-interview text summaries. Both are Volcengine credentials and must not be reused interchangeably.
- `STEPFUN_API_KEY` is for the StepFun realtime voice model and is separate from `VOLCENGINE_API_KEY`.
- Do not run `npm run test:voice:e2e` unless the user specifically requests live-provider verification; it sends synthetic audio to external models and consumes usage.
- Preserve existing data/e2e artifacts; do not clear or replace them as part of routine setup or tests.

# 人生采访局 NVIDIA 版：AI 开发环境约定

进入本项目开发前，先阅读 `docs/AI开发联调环境.md` 和现有产品、数据库规范。

## 当前本机服务

- NemoClaw sandbox：`my-assistant`
- OpenClaw sandbox Web/服务转发：`http://127.0.0.1:18790`
- NeMo Retriever 对外 HTTP：`http://127.0.0.1:7670`
- NeMo Retriever MCP：`http://127.0.0.1:7670/mcp`
- Retriever 内部 VectorDB：`http://127.0.0.1:7671`，业务代码禁止直接写入

这些是当前 Mac 的本机示例；业务代码和检查脚本应从环境变量读取地址，不要硬编码端口。
本项目只使用 NemoClaw `my-assistant` sandbox 内的 OpenClaw；Host OpenClaw 不属于项目运行依赖。

## 数据边界

1. SQLite/业务数据库保存完整 Transcript、Session、Story State，是权威事实源。
2. NeMo Retriever 保存用于检索的 Transcript 副本，是可重建的派生索引，不是唯一存储。
3. Web/小程序浏览器不得直接访问 Retriever；由后端调用 `7670` REST API。
4. Retriever MCP 是可选的 Agent/Codex/OpenClaw 工具面，不是 Web 后端保存 Transcript 的前置依赖。
5. Retriever 写入失败不能回滚已成功保存的 Transcript；使用 pending/indexed/failed 状态与重试。
6. 不要把 API Key、token、authenticated dashboard URL 写入代码、文档、日志或 Git。

## Phase 1 边界

- Phase 1 的真实 Agent smoke 使用 NemoClaw/OpenClaw 加只读 Tool API；当前代码不依赖 Retriever 或 RAG。
- NeMo Retriever 是本机联调能力和后续 Phase 3 的预留边界，未授权前不要把它接入 Phase 1 的核心用户路径。
- OpenClaw 不直接读取业务 SQLite；长期状态仍以应用数据库为准。

## 开发前检查

运行：

```bash
bash scripts/check-ai-env.sh
```

该检查用于发现本机服务是否可用；Retriever 当前不可用时应报告失败，不得把失败吞成成功。只有需要重新启动远程 NVIDIA embedding/inference 时，才要求本机安全环境中已有对应 API Key。

## Retriever 写入规则

Web 后端只调用 `NEMO_RETRIEVER_BASE_URL`：

1. `POST /v1/ingest/job` 创建 ingest job。
2. `POST /v1/ingest/job/{job_id}/document` 上传一次 Session 的 Transcript 文档。
3. 查询使用 `POST /v1/query`，Agent 优先通过 MCP `query` 工具调用。

Transcript 文档 metadata 至少保留 `user_id`、`session_id`、`story_id`（如有）、`stage_id`（如有）、`session_type`、`ended_at`。原始 `segment_id` 应保留在正文或 metadata 中，保证搜索结果可追溯回业务数据库。
