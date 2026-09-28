#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

start_one() {
  local name="$1" logfile="$2"; shift 2
  if pid_running "$name"; then return 0; fi
  (cd "$REPO_ROOT"; nohup "$@" >>"$SPARK_LOG_DIR/$logfile" 2>&1 & echo $! >"$(pid_file "$name")")
}

case "${1:-status}" in
  start)
    host_ip="$(safe_host_ip)"
    [[ "$host_ip" != "127.0.0.1" ]] || die "Could not determine a private host address for OpenShell retrieval access."
    export HOST="127.0.0.1" PORT="${PORT:-$SPARK_BACKEND_PORT}"
    export AGENT_RETRIEVAL_BASE_URL="http://$host_ip:$SPARK_AGENT_RETRIEVAL_PORT"

    start_one backend backend.log node --env-file-if-exists=.env --import tsx src/server.ts
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_BACKEND_PORT/api/health" 120

    if ! pid_running agent-retrieval-proxy; then
      SPARK_AGENT_RETRIEVAL_BIND_HOST="$host_ip" \
      SPARK_AGENT_RETRIEVAL_PORT="$SPARK_AGENT_RETRIEVAL_PORT" \
      SPARK_BACKEND_PORT="$SPARK_BACKEND_PORT" \
      nohup python3 "$DIR/services/agent_retrieval_proxy.py" >>"$SPARK_LOG_DIR/agent-retrieval-proxy.log" 2>&1 &
      write_pid agent-retrieval-proxy "$!"
    fi
    "$DIR/lib/wait-for.sh" "http://$host_ip:$SPARK_AGENT_RETRIEVAL_PORT/health" 30
    ;;
  stop)
    for n in backend agent-retrieval-proxy; do
      p="$(read_pid "$n")"
      [[ "$p" =~ ^[0-9]+$ ]] && kill "$p" 2>/dev/null || true
      clear_pid "$n"
    done
    ;;
  status)
    curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_BACKEND_PORT/api/health" >/dev/null 2>&1 && echo RUNNING || echo STOPPED
    ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
