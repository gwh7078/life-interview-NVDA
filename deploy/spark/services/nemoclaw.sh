#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

sandbox="${NEMOCLAW_SANDBOX:-my-assistant}"
model="${SPARK_TEXT_MODEL:-nvidia/Qwen3.6-35B-A3B-NVFP4}"
policy_file="$SPARK_DIAGNOSTICS_DIR/life-interview-tool-api.yaml"

install_cli() {
  if have nemoclaw; then return 0; fi
  log "Installing NemoClaw from NVIDIA official installer."
  NEMOCLAW_NO_EXPRESS=1 NEMOCLAW_YES=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1     NEMOCLAW_PROVIDER=vllm NEMOCLAW_MODEL="$model"     bash -c 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash'
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  have nemoclaw || die "NemoClaw installer finished but nemoclaw is not on PATH. Reload shell or add its install bin directory."
}

sandbox_ready() {
  nemoclaw "$sandbox" status >/dev/null 2>&1
}

ensure_sandbox() {
  sandbox_ready && return 0
  log "Creating NemoClaw/OpenClaw sandbox '$sandbox' against the existing local vLLM endpoint."
  NEMOCLAW_NO_EXPRESS=1 NEMOCLAW_YES=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1     NEMOCLAW_PROVIDER=vllm NEMOCLAW_MODEL="$model"     nemoclaw onboard --gpu --name "$sandbox"
  sandbox_ready || die "NemoClaw sandbox '$sandbox' was not ready after onboarding."
}

install_skills() {
  local skills=(onboarding-closeout interview-closeout story-completion story-generation interview-observer)
  for skill in "${skills[@]}"; do
    local path="$REPO_ROOT/agent/skills/$skill"
    [[ -d "$path" ]] || die "Missing formal Skill: $path"
    nemoclaw "$sandbox" skill install "$path"
  done
}

configure_realtime_context_agent() {
  local agent_id="realtime-context"
  local workspace="/sandbox/.openclaw/workspace-realtime-context"
  local list index
  list="$(nemoclaw "$sandbox" exec -- openclaw config get agents.list)"
  index="$(printf '%s\n' "$list" | python3 -c '
import json,re,sys
raw=sys.stdin.read(); m=re.search(r"(?m)^[ \t]*\[[ \t]*$",raw)
if not m: raise SystemExit(0)
items,_=json.JSONDecoder().raw_decode(raw,m.start())
for i,item in enumerate(items):
    if item.get("id")=="realtime-context": print(i); break
')" || true
  if [[ -z "$index" ]]; then
    nemoclaw "$sandbox" exec -- openclaw agents add "$agent_id" --workspace "$workspace" --non-interactive
    list="$(nemoclaw "$sandbox" exec -- openclaw config get agents.list)"
    index="$(printf '%s\n' "$list" | python3 -c '
import json,re,sys
raw=sys.stdin.read(); m=re.search(r"(?m)^[ \t]*\[[ \t]*$",raw)
if not m: raise SystemExit(0)
items,_=json.JSONDecoder().raw_decode(raw,m.start())
for i,item in enumerate(items):
    if item.get("id")=="realtime-context": print(i); break
')" || true
  fi
  [[ -n "$index" ]] || die "OpenClaw did not register realtime-context agent."
  nemoclaw "$sandbox" exec -- openclaw config set --strict-json "agents.list[$index].tools.allow" '[]'
  nemoclaw "$sandbox" exec -- openclaw config set --strict-json "agents.list[$index].tools.deny" '["*"]'
  nemoclaw "$sandbox" exec -- openclaw skills install /sandbox/.openclaw/workspace/skills/interview-observer --agent "$agent_id" --force
}

apply_policy() {
  local host_ip
  host_ip="$(safe_host_ip)"
  python3 - "$REPO_ROOT/nvidia/nemoclaw/openshell-policy/life-interview-tool-api.yaml.example" "$policy_file" "$host_ip" "$SPARK_AGENT_TOOL_PORT" <<'PY'
from pathlib import Path
import sys
src,dst,host,port=sys.argv[1:]
text=Path(src).read_text()
text=text.replace("10.0.0.5",host).replace("port: 4175",f"port: {port}")
Path(dst).write_text(text)
PY
  chmod 600 "$policy_file"
  # policy-add is idempotent for the same named preset in current NemoClaw; if a
  # maintained release changes this behavior, verification will surface it.
  nemoclaw "$sandbox" policy-add "$policy_file" >/dev/null
}

case "${1:-status}" in
  install)
    install_cli
    ensure_sandbox
    install_skills
    configure_realtime_context_agent
    apply_policy
    ;;
  start)
    install_cli
    ensure_sandbox
    nemoclaw inference set --model "$model" --provider vllm --sandbox "$sandbox" >/dev/null
    install_skills
    configure_realtime_context_agent
    apply_policy
    ;;
  stop)
    # The sandbox is intentionally preserved. Product stop does not destroy user state.
    ;;
  smoke)
    npm --prefix "$REPO_ROOT" run agent:smoke
    ;;
  status)
    if ! have nemoclaw; then echo STOPPED; exit 0; fi
    if sandbox_ready; then echo RUNNING; else echo DEGRADED; fi
    ;;
  openclaw-status)
    if have nemoclaw && sandbox_ready && nemoclaw "$sandbox" exec -- openclaw --version >/dev/null 2>&1; then echo RUNNING; else echo STOPPED; fi
    ;;
  *) echo "usage: $0 {install|start|stop|smoke|status|openclaw-status}" >&2; exit 2 ;;
esac
