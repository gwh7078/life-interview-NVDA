#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"

case "${1:-status}" in
  smoke) (cd "$REPO_ROOT"; bash scripts/codex-node.sh npm run test:agent:nat:smoke) ;;
  profile) (cd "$REPO_ROOT"; bash scripts/codex-node.sh npm run test:agent:nat:profile) ;;
  eval) (cd "$REPO_ROOT"; bash scripts/codex-node.sh npm run test:agent:nat:eval) ;;
  status)
    if command -v uv >/dev/null 2>&1 && [[ -d "$REPO_ROOT/nvidia/nat" ]]; then echo RUNNING; else echo DEGRADED; fi
    ;;
  *) echo "usage: $0 {smoke|profile|eval|status}" >&2; exit 2 ;;
esac
