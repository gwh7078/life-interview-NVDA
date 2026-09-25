#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
retriever_service_status="not applicable"

echo "安装本地服务依赖……"
bash scripts/codex-node.sh npm ci

mkdir -p data
if [[ ! -e .env ]]; then
  bash scripts/codex-node.sh node --eval '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const toolTokenSecret = crypto.randomBytes(32).toString("hex");
    const content = [
      "# 本工作树的本地设置；不会被提交到 Git。",
      "DATABASE_PATH=./data/codex-worktree.db",
      "HOST=127.0.0.1",
      "PORT=0",
      "AUTH_MODE=demo_phone",
      "AI_TASK_RUNTIME=direct",
      "REALTIME_CONTEXT_AGENT_ENABLED=1",
      "NEMO_RETRIEVER_ENABLED=true",
      "NEMOCLAW_SANDBOX=my-assistant",
      "STORY_INTERVIEW_PROVIDER=stepaudio3_quality",
      "STEPAUDIO3_REALTIME_MODEL=stepaudio-3-realtime-preview",
      "STEPFUN_REALTIME_MODEL=step-audio-2-mini",
      "MODELBEST_REALTIME_MODEL=MiniCPM-o-4.5-Realtime",
      "TEXT_MODEL_PROVIDER=openai-compatible",
      "TEXT_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1",
      "TEXT_MODEL=qwen3.6-35b-a3b",
      "TEXT_MODEL_API_FORMAT=chat-completions",
      "TEXT_MODEL_TIMEOUT_MS=120000",
      "AGENT_PROVIDER=bailian",
      "AGENT_MODEL_DEFAULT=bailian/qwen3.6-35b-a3b",
      "AGENT_MODEL_REASONING=bailian/qwen3.6-35b-a3b",
      "AGENT_MODEL_REASONING_FAST=bailian/qwen3.6-35b-a3b",
      "AGENT_MODEL_WRITING=bailian/qwen3.6-35b-a3b",
      "AGENT_TOOL_HOST=127.0.0.1",
      "AGENT_TOOL_PORT=4175",
      "AGENT_TOOL_BASE_URL=",
      "AGENT_TOOL_TOKEN_SECRET=" + toolTokenSecret,
      "AGENT_RUNTIME_TIMEOUT_MS=120000",
      "OPENCLAW_SANDBOX_URL=http://127.0.0.1:18790",
      "NEMO_RETRIEVER_BASE_URL=http://127.0.0.1:7670",
      "NEMO_RETRIEVER_MCP_URL=http://127.0.0.1:7670/mcp",
      "NEMO_RETRIEVER_VECTORDB_URL=http://127.0.0.1:7671",
      "NO_PROXY=127.0.0.1,localhost,::1",
      "no_proxy=127.0.0.1,localhost,::1",
      "# 实时语音与会后总结密钥仅在需要真实模型联调时填写。",
      "# STEPFUN_API_KEY=",
      "# MODELBEST_API_KEY=",
      "# CLOSEOUT_API_KEY=",
      "# DASHSCOPE_API_KEY=NeMo Retriever 百炼 embedding/rerank 凭证（macOS 钥匙串同步）",
      "",
    ].join("\n");
    const fd = fs.openSync(".env", "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.closeSync(fd);
  '
  echo "已创建仅本机可读写的安全默认 .env；未复制任何密钥。"
fi

if [[ "$(uname -s)" == "Darwin" ]] && command -v swift >/dev/null 2>&1; then
  if ! swift scripts/codex-keychain.swift sync-env .env; then
    echo "未能从 macOS 钥匙串同步凭证；本地页面、数据库和自动化测试仍可使用。"
  fi
else
  echo "未检测到 macOS 钥匙串；保留当前 .env，不会从其他工作树复制密钥。"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if bash scripts/install-local-retriever-service.sh; then
    retriever_service_status="installed"
  else
    retriever_service_status="not installed"
    echo "[WARN] 未能安装本机 Retriever LaunchAgent；请先按 docs/AI开发联调环境.md 第 10.3 节准备 Retriever runtime。"
  fi
fi

database_path="data/codex-worktree.db"
if [[ ! -e "$database_path" && ! -e "$database_path-wal" && ! -e "$database_path-shm" ]]; then
  echo "为这个 Worktree 创建并填充独立的 SQLite 开发数据库……"
  DATABASE_PATH="./$database_path" bash scripts/codex-node.sh npm run db:setup
else
  echo "发现现有 Worktree 数据库，保留原样，不自动迁移或重新填充。"
fi

if bash scripts/codex-node.sh node --env-file-if-exists=.env --eval '
  process.exit((process.env.STEPFUN_API_KEY?.trim() || process.env.MODELBEST_API_KEY?.trim()) && process.env.CLOSEOUT_API_KEY?.trim() ? 0 : 1);
'; then
  echo "检测到实时语音与会后总结凭证；只确认是否存在，不显示其内容。"
else
  echo "未配置真实模型凭证；本地页面、SQLite 与自动化测试可用，真实语音 E2E 需另行配置密钥并会产生模型用量。"
fi

echo "Worktree Environment 准备完成；NeMo Retriever LaunchAgent: ${retriever_service_status}。"
