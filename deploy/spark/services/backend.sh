#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

start_one() {
  local name="$1" needle="$2" logfile="$3"; shift 3
  if pid_running "$name"; then
    local pid
    pid="$(read_pid "$name")"
    process_is_owned "$pid" "$needle" || die "Refusing to reuse unrelated PID $pid recorded for Product service '$name'."
    return
  fi
  clear_pid "$name"
  (cd "$REPO_ROOT"; nohup "$@" >>"$SPARK_LOG_DIR/$logfile" 2>&1 </dev/null & echo $! >"$(pid_file "$name")")
}

case "${1:-status}" in
  start)
    ensure_product_dirs
    host_ip="$(safe_host_ip)"
    [[ "$host_ip" != 127.0.0.1 ]] || die "Could not determine a private host address for the Agent retrieval proxy."
    export HOST=127.0.0.1 PORT="$SPARK_BACKEND_PORT"
    export AGENT_RETRIEVAL_BASE_URL="http://$host_ip:$SPARK_AGENT_RETRIEVAL_PORT"

    start_one backend src/server.ts backend.log \
      bash scripts/codex-node.sh node --env-file-if-exists=.env --import tsx src/server.ts
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_BACKEND_PORT/api/health" 120

    start_one agent-retrieval-proxy agent_retrieval_proxy.py agent-retrieval-proxy.log \
      env SPARK_AGENT_RETRIEVAL_BIND_HOST="$host_ip" \
        SPARK_AGENT_RETRIEVAL_PORT="$SPARK_AGENT_RETRIEVAL_PORT" \
        SPARK_BACKEND_PORT="$SPARK_BACKEND_PORT" \
        python3 "$DIR/services/agent_retrieval_proxy.py"
    "$DIR/lib/wait-for.sh" "http://$host_ip:$SPARK_AGENT_RETRIEVAL_PORT/health" 30
    echo "Product backend and Agent retrieval proxy are running."
    ;;
  stop)
    failed=0
    stop_owned_process agent-retrieval-proxy agent_retrieval_proxy.py || failed=1
    stop_owned_process backend src/server.ts || failed=1
    (( failed == 0 ))
    ;;
  status)
    if curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_BACKEND_PORT/api/health" >/dev/null 2>&1; then
      echo RUNNING
    else
      echo STOPPED
    fi
    ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
