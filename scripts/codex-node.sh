#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "用法：bash scripts/codex-node.sh <命令> [参数…]" >&2
  exit 2
fi

node_is_supported() {
  "$1" --eval '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major === 24 && minor >= 16)
      || (major === 26 && minor >= 1)
      || major > 26;
    process.exit(supported ? 0 : 1);
  ' >/dev/null 2>&1
}

node_executable="$(command -v node || true)"
if [[ -z "$node_executable" ]]; then
  echo "需要先有 Node.js 和 npm，才能在本机缓存兼容版本。" >&2
  exit 1
fi

if ! node_is_supported "$node_executable"; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "本项目需要 Node.js 24.16+（24.x）或 26.1+；当前缺少 npm，无法准备兼容运行时。" >&2
    exit 1
  fi

  echo "通过本机 npm 缓存准备兼容的 Node.js 24.21.0（不会替换系统 Node）。"
  if ! npm exec --yes --package=node@24.21.0 -- node --eval '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major === 24 && minor >= 16 ? 0 : 1);
  ' >/dev/null; then
    echo "无法在 npm 缓存中准备 Node.js 24.21.0。" >&2
    exit 1
  fi
  exec npm exec --yes --package=node@24.21.0 -- "$@"
fi

export PATH="$(dirname "$node_executable"):$PATH"
if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 npm；请确认 Node.js 安装包含 npm。" >&2
  exit 1
fi

printf '运行时：Node %s，npm %s\n' "$(node --version)" "$(npm --version)"
exec "$@"
