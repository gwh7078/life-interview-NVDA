#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

service_log() { printf '%s/%s.log\n' "$SPARK_LOG_DIR" "$1"; }

run_logged() {
  local name="$1"; shift
  local file; file="$(service_log "$name")"
  log "$name -> $file"
  "$@" >>"$file" 2>&1
}
