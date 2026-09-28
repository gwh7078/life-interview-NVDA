#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"
name=observer

case "${1:-status}" in
  start)
    ensure_product_dirs
    if pid_running "$name"; then
      pid="$(read_pid "$name")"
      process_is_owned "$pid" telemetry.py || die "Refusing to reuse unrelated PID $pid recorded for the Product observer."
      exit 0
    fi
    clear_pid "$name"
    cd "$REPO_ROOT"
    nohup env SPARK_TELEMETRY_PATH="$SPARK_TELEMETRY_PATH" \
      python3 "$DIR/services/telemetry.py" >>"$SPARK_LOG_DIR/observer.log" 2>&1 </dev/null &
    write_pid "$name" "$!"
    ;;
  stop) stop_owned_process "$name" telemetry.py ;;
  status) pid_running "$name" && echo RUNNING || echo STOPPED ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
