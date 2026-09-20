#!/usr/bin/env bash
set -euo pipefail

for cmd in docker nemoclaw openshell node npm; do
  command -v "$cmd" >/dev/null || { echo "missing required command: $cmd" >&2; exit 1; }
done

docker info >/dev/null
echo "docker: ok"
nemoclaw agents list
nemoclaw inference get

sandbox="${NEMOCLAW_SANDBOX:-life-interview-agent}"
nemoclaw "$sandbox" status
