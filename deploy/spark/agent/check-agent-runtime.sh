#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

not_ready() {
  printf '%s\n' \
    'AGENT RUNTIME NOT READY' \
    'NemoClaw/OpenClaw Agent Runtime is an operator-managed prerequisite. Install and onboard NemoClaw with OpenClaw before running Life Interview setup.' \
    "Reason: $1" >&2
  exit 1
}

if [[ "${SPARK_NEMOCLAW_SANDBOX_CONFIGURED+x}" == x ]]; then
  sandbox="$SPARK_NEMOCLAW_SANDBOX_CONFIGURED"
else
  sandbox="${NEMOCLAW_SANDBOX:-}"
fi
[[ -n "$sandbox" ]] || not_ready "NEMOCLAW_SANDBOX is not configured."
have nemoclaw || not_ready "nemoclaw CLI is unavailable."

status_json="$(nemoclaw "$sandbox" status --json 2>/dev/null)" \
  || not_ready "Could not read sandbox status JSON."
# Apply the same shared status contract as nemoclaw_status_ready to this one captured response.
if ! printf '%s\n' "$status_json" | python3 "$DIR/lib/nemoclaw_status.py" >/dev/null 2>&1; then
  not_ready "Sandbox must exist and have found=true with phase=ready or running."
fi

if ! nemoclaw "$sandbox" exec -- openclaw --version >/dev/null 2>&1; then
  not_ready "OpenClaw is unavailable inside sandbox '$sandbox'."
fi

printf 'NemoClaw/OpenClaw Agent Runtime is ready (sandbox=%s).\n' "$sandbox"
