#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

row() { printf '%-34s %s\n' "$1" "$2"; }
http_state() {
  local url="$1"
  curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS "$url" >/dev/null 2>&1 \
    && printf 'PASS' || printf 'EXTERNAL RUNTIME NOT READY'
}

echo "PRODUCT"
row "Backend / Web" "$("$DIR/services/backend.sh" status)"
row "Technical Observer" "$("$DIR/services/observer.sh" status)"
row "SQLite" "$([[ -f "$DATABASE_PATH" ]] && printf 'PASS' || printf 'NOT INITIALIZED')"

echo "EXTERNAL RUNTIMES (read-only)"
row "Text" "$(http_state "${TEXT_MODEL_BASE_URL%/}/models")"
row "Coach" "$(http_state "${REALTIME_COACH_BASE_URL%/}/models")"
row "Retriever REST" "$(http_state "${NEMO_RETRIEVER_BASE_URL%/}/v1/health")"
row "Retriever VectorDB" "$(http_state "${NEMO_RETRIEVER_VECTORDB_URL%/}/v1/health")"
row "StepAudio WebSocket" "CHECK WITH ./deploy/spark/check-env.sh"
if have nemoclaw && nemoclaw "$NEMOCLAW_SANDBOX" status >/dev/null 2>&1; then
  row "NemoClaw / OpenClaw" "RUNNING"
else
  row "NemoClaw / OpenClaw" "NOT READY"
fi
