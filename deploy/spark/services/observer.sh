#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"
name=observer

case "${1:-status}" in
  start)
    if pid_running "$name"; then exit 0; fi
    export SPARK_TELEMETRY_PATH="${SPARK_TELEMETRY_PATH:-$SPARK_DIAGNOSTICS_DIR/telemetry.json}"
    nohup python3 "$DIR/services/telemetry.py" >>"$SPARK_LOG_DIR/observer.log" 2>&1 &
    write_pid "$name" "$!"
    ;;
  stop) p="$(read_pid "$name")"; [[ "$p" =~ ^[0-9]+$ ]] && kill "$p" 2>/dev/null || true; clear_pid "$name" ;;
  status) pid_running "$name" && echo RUNNING || echo STOPPED ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
