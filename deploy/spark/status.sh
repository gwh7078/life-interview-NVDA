#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

row() { printf '%-34s %s\n' "$1" "$2"; }
http_state() {
  local url="$1" api_key_env="${2:-}"
  if python3 - "$url" "$api_key_env" >/dev/null 2>&1 <<'PY'
import os, sys, urllib.error, urllib.request
url, key_env = sys.argv[1:]
key = os.environ.get(key_env, "") if key_env else ""
headers = {"Authorization": "Bearer " + key} if key else {}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(urllib.request.Request(url, headers=headers), timeout=5) as response:
        raise SystemExit(0 if 200 <= response.status < 300 else 1)
except (OSError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
    raise SystemExit(1)
PY
  then
    printf 'PASS'
  else
    printf 'EXTERNAL RUNTIME NOT READY'
  fi
}

echo "PRODUCT"
row "Backend / Web" "$("$DIR/services/backend.sh" status)"
row "Technical Observer" "$("$DIR/services/observer.sh" status)"
row "SQLite" "$([[ -f "$DATABASE_PATH" ]] && printf 'PASS' || printf 'NOT INITIALIZED')"

echo "EXTERNAL RUNTIMES (read-only)"
row "Text" "$(http_state "${TEXT_MODEL_BASE_URL%/}/models" TEXT_MODEL_API_KEY)"
row "Coach" "$(http_state "${REALTIME_COACH_BASE_URL%/}/models" REALTIME_COACH_API_KEY)"
row "Retriever REST" "$(http_state "${NEMO_RETRIEVER_BASE_URL%/}/v1/health" NEMO_RETRIEVER_API_TOKEN)"
row "StepAudio WebSocket" "CHECK WITH ./deploy/spark/check-env.sh"
if [[ -n "${NEMOCLAW_SANDBOX:-}" ]] \
  && nemoclaw_status_ready "$NEMOCLAW_SANDBOX" >/dev/null 2>&1 \
  && nemoclaw "$NEMOCLAW_SANDBOX" exec -- openclaw --version >/dev/null 2>&1; then
  row "NemoClaw / OpenClaw" "RUNNING"
else
  row "NemoClaw / OpenClaw" "NOT READY"
fi
