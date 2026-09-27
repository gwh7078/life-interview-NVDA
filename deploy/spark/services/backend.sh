#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

backend_pid="$(pid_file backend)"
tool_pid="$(pid_file agent-tool)"

start_one() {
  local name="$1" logfile="$2"; shift 2
  if pid_running "$name"; then return 0; fi
  (cd "$REPO_ROOT"; nohup "$@" >>"$SPARK_LOG_DIR/$logfile" 2>&1 & echo $! >"$(pid_file "$name")")
}

case "${1:-status}" in
  start)
    host_ip="$(safe_host_ip)"
    export HOST="${HOST:-127.0.0.1}" PORT="${PORT:-$SPARK_BACKEND_PORT}"
    export AGENT_TOOL_HOST="${AGENT_TOOL_HOST:-0.0.0.0}" AGENT_TOOL_PORT="${AGENT_TOOL_PORT:-$SPARK_AGENT_TOOL_PORT}"
    export AGENT_TOOL_BASE_URL="${AGENT_TOOL_BASE_URL:-http://$host_ip:$SPARK_AGENT_TOOL_PORT}"
    start_one agent-tool agent-tools.log npm run agent:tool-server
    start_one backend backend.log npm start
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_BACKEND_PORT/api/health" 120
    ;;
  stop)
    for n in backend agent-tool; do p="$(read_pid "$n")"; [[ "$p" =~ ^[0-9]+$ ]] && kill "$p" 2>/dev/null || true; clear_pid "$n"; done
    ;;
  status) curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_BACKEND_PORT/api/health" >/dev/null 2>&1 && echo RUNNING || echo STOPPED ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
