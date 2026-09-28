#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib/common.sh"

state() {
  local value
  value="$("$@" 2>/dev/null | tail -1 || true)"
  case "$value" in RUNNING|DEGRADED|STOPPED|UNKNOWN|SYNCED|STALE) printf '%s' "$value" ;; *) printf 'UNKNOWN' ;; esac
}

host_toolchain_status() {
  if [[ -x "$SPARK_HOME/tools/node/bin/node" && -x "$SPARK_HOME/tools/uv/bin/uv" ]] \
    && command -v python3 >/dev/null 2>&1; then
    echo RUNNING
  else
    echo DEGRADED
  fi
}

runtime_prereq_status() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1 \
    && docker info >/dev/null 2>&1 && docker image inspect "$SPARK_BASE_VLLM_IMAGE" >/dev/null 2>&1; then
    echo RUNNING
  else
    echo DEGRADED
  fi
}

row() { printf '%-26s %s\n' "$1" "$2"; }
echo BASE
row "  Host Toolchain" "$(host_toolchain_status)"
row "  NemoClaw / OpenShell" "$(state "$DIR/services/nemoclaw.sh" status)"
row "  OpenClaw sandbox" "$(state "$DIR/services/nemoclaw.sh" openclaw-status)"
row "  Runtime prerequisites" "$(runtime_prereq_status)"
echo RUNTIME
row "  Text Model" "$(state "$DIR/models/post-session.sh" status)"
row "  Coach" "$(state "$DIR/models/coach.sh" status)"
row "  Voice" "$(state "$DIR/models/realtime.sh" status)"
row "  Retriever" "$(state "$DIR/services/retriever.sh" status)"
echo PRODUCT
row "  Backend / Web" "$(state "$DIR/services/backend.sh" status)"
row "  Skills" "$(state "$DIR/services/nemoclaw.sh" skills-status)"
row "  Observer" "$(state "$DIR/services/observer.sh" status)"
row "  NAT" "$(state "$DIR/services/nat.sh" status)"
