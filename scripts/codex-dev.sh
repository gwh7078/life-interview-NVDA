#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

diagnostics_dir="${DIAGNOSTICS_DIR:-runtime/diagnostics}"
mkdir -p "$diagnostics_dir/logs"
exec > >(tee -a "$diagnostics_dir/logs/process.log") 2>&1

if [[ "$(uname -s)" == "Darwin" ]]; then
  bash scripts/ensure-local-retriever.sh
fi

database_path="./data/codex-worktree.db"
DATABASE_PATH="$database_path" bash scripts/codex-node.sh npm run db:migrate

exec bash scripts/codex-node.sh env \
  DATABASE_PATH="$database_path" \
  HOST=127.0.0.1 \
  PORT=0 \
  npm run dev
