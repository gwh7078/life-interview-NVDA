#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

[[ "${AGENT_MODEL_BASE_URL:-}" =~ ^http://(127\.0\.0\.1|localhost):([0-9]+)/v1/?$ ]] \
  || die "AGENT_MODEL_BASE_URL must be a loopback OpenAI-compatible /v1 URL."
port="${BASH_REMATCH[2]}"
sandbox="$NEMOCLAW_SANDBOX"

if ! have nemoclaw; then
  have curl || die "curl is required for the official NVIDIA NemoClaw installer."
  curl -fsSL https://www.nvidia.com/nemoclaw.sh | \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_AGENT=openclaw \
    NEMOCLAW_NO_EXPRESS=1 \
    NEMOCLAW_PROVIDER=vllm \
    NEMOCLAW_VLLM_PORT="$port" \
    NEMOCLAW_SANDBOX_NAME="$sandbox" \
    bash
fi

have nemoclaw || die "The NVIDIA installer returned without making the nemoclaw CLI available."
sandbox_list="$(nemoclaw list --json)" || die "Could not inspect the NemoClaw sandbox list."
found="$(STATUS_JSON="$sandbox_list" SANDBOX="$sandbox" python3 - <<'PY'
import json, os
target = os.environ["SANDBOX"]
def contains_sandbox(value):
    if isinstance(value, dict):
        if value.get("name") == target or value.get("sandboxName") == target:
            return True
        return any(contains_sandbox(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_sandbox(item) for item in value)
    return False
try:
    found = contains_sandbox(json.loads(os.environ["STATUS_JSON"]))
except json.JSONDecodeError:
    raise SystemExit("NemoClaw returned invalid sandbox-list JSON.")
print(str(found).lower())
PY
)"
if [[ "$found" != true ]]; then
  NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_AGENT=openclaw \
    NEMOCLAW_NO_EXPRESS=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_PROVIDER=vllm NEMOCLAW_VLLM_PORT="$port" \
    NEMOCLAW_SANDBOX_NAME="$sandbox" nemoclaw onboard --non-interactive
fi

status_json="$(nemoclaw "$sandbox" status --json)" \
  || die "Could not read status for NemoClaw sandbox '$sandbox'."

phase="$(STATUS_JSON="$status_json" python3 -c 'import json,os; print(json.loads(os.environ["STATUS_JSON"]).get("phase",""))')"
phase_lower="$(printf '%s' "$phase" | tr '[:upper:]' '[:lower:]')"
case "$phase_lower" in
  ready|running) ;;
  stopped)
    nemoclaw "$sandbox" start
    status_json="$(nemoclaw "$sandbox" status --json)" \
      || die "Could not verify the started NemoClaw sandbox."
    phase="$(STATUS_JSON="$status_json" python3 -c 'import json,os; print(json.loads(os.environ["STATUS_JSON"]).get("phase",""))')"
    phase_lower="$(printf '%s' "$phase" | tr '[:upper:]' '[:lower:]')"
    [[ "$phase_lower" == ready || "$phase_lower" == running ]] \
      || die "NemoClaw sandbox '$sandbox' did not reach RUNNING."
    ;;
  *) die "NemoClaw sandbox '$sandbox' is not ready (phase=$phase); inspect nemoclaw status." ;;
esac

echo "NemoClaw sandbox '$sandbox' is RUNNING and OpenClaw reuses the existing vLLM endpoint on port $port."
