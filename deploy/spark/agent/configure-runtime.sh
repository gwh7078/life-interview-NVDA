#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

have nemoclaw || die "NemoClaw CLI is missing; run deploy/spark/setup.sh first."
[[ "$AGENT_MODEL_BASE_URL" == "$TEXT_MODEL_BASE_URL" ]] \
  || die "AGENT_MODEL_BASE_URL must reuse TEXT_MODEL_BASE_URL."
[[ "$AGENT_MODEL_DEFAULT" == "$TEXT_MODEL" && -n "$AGENT_MODEL_DEFAULT" ]] \
  || die "AGENT_MODEL_DEFAULT must match the model served by the Text endpoint."
[[ "$AGENT_MODEL_BASE_URL" =~ ^http://(127\.0\.0\.1|localhost):([0-9]+)/v1/?$ ]] \
  || die "AGENT_MODEL_BASE_URL must be a loopback OpenAI-compatible /v1 URL."

sandbox="$NEMOCLAW_SANDBOX"
port="$(sed -E 's|^http://(127\.0\.0\.1|localhost):([0-9]+)/v1/?$|\2|' <<<"$AGENT_MODEL_BASE_URL")"
model="$AGENT_MODEL_DEFAULT"
route_model="vllm-local/$model"

nemoclaw_status_ready "$sandbox" \
  || die "NemoClaw sandbox '$sandbox' must be RUNNING before runtime configuration."
NEMOCLAW_VLLM_PORT="$port" nemoclaw inference set \
  --provider vllm-local --model "$model" --sandbox "$sandbox"
nemoclaw_status_ready "$sandbox" "$model" \
  || die "NemoClaw route does not match the configured Text endpoint."

read_agent_config() {
  nemoclaw "$sandbox" config get --key agents.list --format json
}
agent_config="$(read_agent_config)" || die "Could not read OpenClaw agent configuration."
agent_index="$(AGENT_CONFIG="$agent_config" python3 - <<'PY'
import json, os
try:
    agents = json.loads(os.environ["AGENT_CONFIG"])
except json.JSONDecodeError:
    raise SystemExit(1)
for index, agent in enumerate(agents):
    if agent.get("id") == "realtime-context":
        print(index)
        break
PY
)"

if [[ -z "$agent_index" ]]; then
  nemoclaw "$sandbox" agents add realtime-context \
    --workspace /sandbox/.openclaw/workspace-realtime-context \
    --model "$route_model" --non-interactive
  agent_config="$(read_agent_config)" || die "Could not verify the new OpenClaw agent."
  agent_index="$(AGENT_CONFIG="$agent_config" python3 - <<'PY'
import json, os
try:
    agents = json.loads(os.environ["AGENT_CONFIG"])
except json.JSONDecodeError:
    raise SystemExit(1)
for index, agent in enumerate(agents):
    if agent.get("id") == "realtime-context":
        print(index)
        break
PY
)"
fi
[[ -n "$agent_index" ]] || die "OpenClaw did not register the realtime-context agent."

agent_model="$(AGENT_CONFIG="$agent_config" AGENT_INDEX="$agent_index" python3 - <<'PY'
import json, os
agents = json.loads(os.environ["AGENT_CONFIG"])
model = agents[int(os.environ["AGENT_INDEX"])].get("model", "")
if isinstance(model, dict):
    model = model.get("primary", "")
print(model if isinstance(model, str) else "")
PY
)"
if [[ "$agent_model" != "$route_model" ]]; then
  nemoclaw "$sandbox" config set --key "agents.list[$agent_index].model" \
    --value "$route_model" --config-accept-new-path --restart
  agent_config="$(read_agent_config)" || die "Could not verify realtime-context model routing."
fi

if ! AGENT_CONFIG="$agent_config" AGENT_INDEX="$agent_index" python3 - <<'PY'
import json, os
agents = json.loads(os.environ["AGENT_CONFIG"])
tools = agents[int(os.environ["AGENT_INDEX"])].get("tools", {})
raise SystemExit(0 if tools == {"allow": [], "deny": ["*"]} else 1)
PY
then
  nemoclaw "$sandbox" config set --key "agents.list[$agent_index].tools" \
    --value '{"allow":[],"deny":["*"]}' --config-accept-new-path --restart
fi

agent_config="$(read_agent_config)" || die "Could not verify realtime-context configuration."
AGENT_CONFIG="$agent_config" AGENT_INDEX="$agent_index" EXPECTED_MODEL="$route_model" python3 - <<'PY'
import json, os
agents = json.loads(os.environ["AGENT_CONFIG"])
agent = agents[int(os.environ["AGENT_INDEX"])]
if agent.get("id") != "realtime-context":
    raise SystemExit("realtime-context agent identity mismatch")
if agent.get("model") != os.environ["EXPECTED_MODEL"]:
    raise SystemExit("realtime-context model route mismatch")
if agent.get("tools") != {"allow": [], "deny": ["*"]}:
    raise SystemExit("realtime-context tools are not restricted")
PY

nemoclaw_status_ready "$sandbox" "$model" \
  || die "NemoClaw final route does not match the configured Text endpoint."
echo "OpenClaw sandbox '$sandbox' is RUNNING on vllm-local/$model; realtime-context is routed to the same model with restricted tools."
