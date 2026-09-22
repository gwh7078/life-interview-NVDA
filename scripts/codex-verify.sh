#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

run() {
  bash scripts/codex-node.sh "$@"
}

echo "检查服务 TypeScript 类型……"
run npm run typecheck

echo "运行完整 deterministic 本地测试（test:fast + test:integration + test:agent + NAT unit/plugin）……"
run npm test

echo "全部本地自动化验证通过。真实语音/总结模型 E2E 不在此操作中运行，因为它会发送音频并消耗外部模型用量。"
