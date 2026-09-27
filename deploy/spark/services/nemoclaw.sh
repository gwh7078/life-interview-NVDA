#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

sandbox="${NEMOCLAW_SANDBOX:-my-assistant}"
model="${SPARK_TEXT_MODEL:-nvidia/Qwen3.6-35B-A3B-NVFP4}"
policy_file="$SPARK_DIAGNOSTICS_DIR/life-interview-retrieval-api.yaml"

install_cli() {
  if have nemoclaw; then return 0; fi
  log "Installing NemoClaw from NVIDIA official installer."
  NEMOCLAW_NO_EXPRESS=1 \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_YES=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_AGENT=openclaw \
  NEMOCLAW_PROVIDER=vllm \
  NEMOCLAW_MODEL="$model" \
  NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" \
  NEMOCLAW_SANDBOX_NAME="$sandbox" \
    bash -c 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash'
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  have nemoclaw || die "NemoClaw installer finished but nemoclaw is not on PATH."
}

sandbox_ready() {
  nemoclaw "$sandbox" status >/dev/null 2>&1
}

ensure_sandbox() {
  sandbox_ready && return 0
  log "Creating NemoClaw/OpenClaw sandbox '$sandbox' against the existing local vLLM endpoint."
  NEMOCLAW_NO_EXPRESS=1 \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_YES=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_AGENT=openclaw \
  NEMOCLAW_PROVIDER=vllm \
  NEMOCLAW_MODEL="$model" \
  NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" \
  NEMOCLAW_SANDBOX_NAME="$sandbox" \
    nemoclaw onboard --non-interactive --no-gpu --name "$sandbox"
  sandbox_ready || die "NemoClaw sandbox '$sandbox' was not ready after onboarding."
}

install_skills() {
  local skills=(onboarding-closeout interview-closeout story-completion story-generation interview-observer)
  local installed
  installed="$(nemoclaw "$sandbox" skill list 2>/dev/null || true)"
  for skill in "${skills[@]}"; do
    local path="$REPO_ROOT/agent/skills/$skill"
    [[ -d "$path" ]] || die "Missing formal Skill: $path"
    if printf '%s\n' "$installed" | grep -Fq "$skill"; then
      log "Skill already installed: $skill"
    else
      nemoclaw "$sandbox" skill install "$path"
    fi
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
  nemoclaw "$sandbox" exec -- openclaw skills install \
    /sandbox/.openclaw/workspace/skills/interview-observer --agent "$agent_id" --force
}

apply_policy() {
  local host_ip
  host_ip="$(safe_host_ip)"
  [[ "$host_ip" != "127.0.0.1" ]] || die "Could not determine a private host address for the retrieval policy."
  python3 - "$DIR/services/retrieval-policy.yaml.template" "$policy_file" "$host_ip" "$SPARK_AGENT_RETRIEVAL_PORT" <<'PY'
from pathlib import Path
import sys
src,dst,host,port=sys.argv[1:]
text=Path(src).read_text().replace("__HOST__",host).replace("__PORT__",port)
Path(dst).write_text(text)
PY
  chmod 600 "$policy_file"
  nemoclaw "$sandbox" policy add --from-file "$policy_file" \
    --trusted-private-host "$host_ip" --yes >/dev/null
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
    NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" nemoclaw inference get >/dev/null
    install_skills
    configure_realtime_context_agent
    apply_policy
    ;;
  stop)
    # Preserve sandbox state; product stop must not destroy Agent data.
    ;;
  smoke)
    (cd "$REPO_ROOT"; printf 'onboarding.closeout\n' | node --import tsx scripts/nat-agent-runner.ts)
    ;;
  status)
    if ! have nemoclaw; then echo STOPPED; exit 0; fi
    if sandbox_ready; then echo RUNNING; else echo DEGRADED; fi
    ;;
  openclaw-status)
    if have nemoclaw && sandbox_ready && nemoclaw "$sandbox" exec -- openclaw --version >/dev/null 2>&1; then
      echo RUNNING
    else
      echo STOPPED
    fi
    ;;
  *) echo "usage: $0 {install|start|stop|smoke|status|openclaw-status}" >&2; exit 2 ;;
esac
