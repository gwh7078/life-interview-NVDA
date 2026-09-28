#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

sandbox="${NEMOCLAW_SANDBOX:-my-assistant}"
model="$SPARK_TEXT_SERVED_MODEL"
policy_file="$SPARK_DIAGNOSTICS_DIR/life-interview-retrieval-api.yaml"
sandbox_key="$(spec_hash "$sandbox")"

fingerprint_matches() {
  local key="$1" expected="$2" path="$SPARK_STATE_DIR/$1"
  [[ -f "$path" ]] && [[ "$(cat "$path")" == "$expected" ]]
}

save_fingerprint() {
  local key="$1" value="$2" temp
  temp="$(mktemp "$SPARK_STATE_DIR/.${key}.XXXXXX")"
  printf '%s\n' "$value" > "$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$SPARK_STATE_DIR/$key"
}

sandbox_ready() {
  nemoclaw "$sandbox" status >/dev/null 2>&1
}

sandbox_running() {
  [[ "$(sandbox_status)" == "RUNNING" ]]
}

sandbox_status() {
  local status
  status="$(nemoclaw "$sandbox" status 2>/dev/null)" || { echo DEGRADED; return 0; }
  if grep -Eiq '^[[:space:]]*Phase:[[:space:]]*(Ready|Running)[[:space:]]*$' <<<"$status"; then
    echo RUNNING
  elif grep -Eiq '^[[:space:]]*Phase:[[:space:]]*Stopped[[:space:]]*$' <<<"$status"; then
    echo STOPPED
  else
    echo DEGRADED
  fi
}

skill_is_installed() {
  local skill="$1"
  nemoclaw "$sandbox" exec -- test -f \
    "/sandbox/.openclaw/workspace/skills/$skill/SKILL.md" >/dev/null 2>&1
}

product_skill_is_installed() {
  nemoclaw "$sandbox" exec -- test -f \
    "/sandbox/.openclaw/workspace-realtime-context/skills/interview-observer/SKILL.md" >/dev/null 2>&1
}

policy_is_installed() {
  local status
  status="$(nemoclaw "$sandbox" status --json 2>/dev/null)" || return 1
  python3 - "$status" <<'PY'
import json,re,sys
try:
    data=json.loads(sys.argv[1])
except json.JSONDecodeError:
    raise SystemExit(1)
if data.get("policiesAvailable") is False:
    raise SystemExit(1)
policies=json.dumps(data.get("policies", []),ensure_ascii=False).lower()
normalize=lambda value: re.sub(r"[^a-z0-9]", "", value.lower())
raise SystemExit(0 if normalize("life-interview-retrieval-api") in normalize(policies) else 1)
PY
}

require_base() {
  have nemoclaw || die "NemoClaw CLI is missing; run '$0 ensure-base'."
  sandbox_ready || die "NemoClaw sandbox '$sandbox' is not ready; run '$0 ensure-base'."
}

ensure_base() {
  "$DIR/services/nemoclaw-base.sh"
}

configure_runtime() {
  local fingerprint key
  # NemoClaw's current vllm-local interface takes the host endpoint as a port.
  fingerprint="$(spec_hash vllm-local "$SPARK_TEXT_PORT" "$model")"
  key="nemoclaw-runtime-$sandbox_key.fingerprint"
  if fingerprint_matches "$key" "$fingerprint"; then
    NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" nemoclaw "$sandbox" inference get >/dev/null
    return 0
  fi
  NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" \
    nemoclaw inference set --provider vllm-local --model "$model" --sandbox "$sandbox" >/dev/null
  NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" nemoclaw "$sandbox" inference get >/dev/null
  save_fingerprint "$key" "$fingerprint"
}

sync_skills() {
  local skill path fingerprint key
  local skills=(onboarding-closeout interview-closeout story-completion story-generation interview-observer)
  for skill in "${skills[@]}"; do
    path="$REPO_ROOT/agent/skills/$skill"
    [[ -d "$path" ]] || die "Missing formal Skill: $path"
    fingerprint="$(spark_path_fingerprint "$path")"
    key="nemoclaw-skill-$sandbox_key-$skill.fingerprint"
    if ! fingerprint_matches "$key" "$fingerprint" || ! skill_is_installed "$skill"; then
      nemoclaw "$sandbox" skill install "$path"
      save_fingerprint "$key" "$fingerprint"
    fi
    if [[ "$skill" == "interview-observer" ]] && [[ -n "$(product_agent_index)" ]]; then
      install_product_skill_if_changed "$fingerprint"
    fi
  done
}

skills_status() {
  local skill path fingerprint key
  local skills=(onboarding-closeout interview-closeout story-completion story-generation interview-observer)
  for skill in "${skills[@]}"; do
    path="$REPO_ROOT/agent/skills/$skill"
    [[ -d "$path" ]] || { echo STALE; return 0; }
    fingerprint="$(spark_path_fingerprint "$path")"
    key="nemoclaw-skill-$sandbox_key-$skill.fingerprint"
    fingerprint_matches "$key" "$fingerprint" && skill_is_installed "$skill" || { echo STALE; return 0; }
  done
  echo SYNCED
}

agent_index() {
  python3 -c '
import json,re,sys
raw=sys.stdin.read(); m=re.search(r"(?m)^[ \t]*\[[ \t]*$",raw)
if m:
    items,_=json.JSONDecoder().raw_decode(raw,m.start())
    for i,item in enumerate(items):
        if item.get("id")=="realtime-context": print(i); break
' <<<"$1"
}

product_agent_index() {
  local list
  list="$(nemoclaw "$sandbox" exec -- openclaw config get agents.list 2>/dev/null || true)"
  agent_index "$list"
}

install_product_skill_if_changed() {
  local fingerprint="$1" key="nemoclaw-product-skill-$sandbox_key-interview-observer.fingerprint"
  fingerprint_matches "$key" "$fingerprint" && product_skill_is_installed && return 0
  nemoclaw "$sandbox" exec -- openclaw skills install \
    /sandbox/.openclaw/workspace/skills/interview-observer --agent realtime-context --force >/dev/null
  save_fingerprint "$key" "$fingerprint"
}

configure_product() {
  local agent_id="realtime-context" workspace="/sandbox/.openclaw/workspace-realtime-context" index observer_fingerprint observer_path
  index="$(product_agent_index)"
  if [[ -z "$index" ]]; then
    nemoclaw "$sandbox" exec -- openclaw agents add "$agent_id" --workspace "$workspace" --non-interactive
    index="$(product_agent_index)"
  fi
  [[ -n "$index" ]] || die "OpenClaw did not register realtime-context agent."
  nemoclaw "$sandbox" exec -- openclaw config set --strict-json "agents.list[$index].tools.allow" '[]' >/dev/null
  nemoclaw "$sandbox" exec -- openclaw config set --strict-json "agents.list[$index].tools.deny" '["*"]' >/dev/null
  observer_path="$REPO_ROOT/agent/skills/interview-observer"
  [[ -d "$observer_path" ]] || die "Missing formal Skill: $observer_path"
  observer_fingerprint="$(spark_path_fingerprint "$observer_path")"
  if ! fingerprint_matches "nemoclaw-skill-$sandbox_key-interview-observer.fingerprint" "$observer_fingerprint" \
    || ! skill_is_installed interview-observer; then
    nemoclaw "$sandbox" skill install "$observer_path"
    save_fingerprint "nemoclaw-skill-$sandbox_key-interview-observer.fingerprint" "$observer_fingerprint"
  fi
  install_product_skill_if_changed "$observer_fingerprint"
}

apply_policy() {
  local host_ip template fingerprint key
  host_ip="$(safe_host_ip)"
  [[ "$host_ip" != "127.0.0.1" ]] || die "Could not determine a private host address for the retrieval policy."
  template="$DIR/services/retrieval-policy.yaml.template"
  fingerprint="$(spec_hash "$host_ip" "$SPARK_AGENT_RETRIEVAL_PORT" "$(spark_path_fingerprint "$template")")"
  key="nemoclaw-policy-$sandbox_key.fingerprint"
  fingerprint_matches "$key" "$fingerprint" && policy_is_installed && return 0
  python3 - "$template" "$policy_file" "$host_ip" "$SPARK_AGENT_RETRIEVAL_PORT" <<'PY'
from pathlib import Path
import sys
src,dst,host,port=sys.argv[1:]
text=Path(src).read_text().replace("__HOST__",host).replace("__PORT__",port)
Path(dst).write_text(text)
PY
  chmod 600 "$policy_file"
  nemoclaw "$sandbox" policy add --from-file "$policy_file" \
    --trusted-private-host "$host_ip" --yes >/dev/null
  save_fingerprint "$key" "$fingerprint"
}

case "${1:-status}" in
  ensure-base)
    ensure_base
    ;;
  configure-runtime)
    require_base
    configure_runtime
    ;;
  sync-skills)
    require_base
    sync_skills
    ;;
  configure-product)
    require_base
    configure_product
    ;;
  apply-policy)
    require_base
    apply_policy
    ;;
  install)
    # Compatibility entry point for the former all-in-one installation flow.
    ensure_base
    configure_runtime
    sync_skills
    configure_product
    apply_policy
    ;;
  start)
    require_base
    if ! sandbox_running; then nemoclaw "$sandbox" start; fi
    configure_runtime
    apply_policy
    ;;
  check)
    require_base
    NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" nemoclaw "$sandbox" inference get >/dev/null
    echo RUNNING
    ;;
  skills-status)
    if have nemoclaw && sandbox_ready; then skills_status; else echo STOPPED; fi
    ;;
  stop)
    # Preserve sandbox state; product stop must not destroy Agent data.
    if have nemoclaw && sandbox_running; then nemoclaw "$sandbox" stop; else echo SKIP; fi
    ;;
  smoke)
    (cd "$REPO_ROOT"; printf 'onboarding.closeout\n' | bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/nat-agent-runner.ts)
    ;;
  status)
    if ! have nemoclaw; then echo STOPPED; exit 0; fi
    sandbox_status
    ;;
  openclaw-status)
    if have nemoclaw && sandbox_ready && nemoclaw "$sandbox" exec -- openclaw --version >/dev/null 2>&1; then
      echo RUNNING
    else
      echo STOPPED
    fi
    ;;
  *) echo "usage: $0 {ensure-base|configure-runtime|sync-skills|configure-product|apply-policy|install|start|check|smoke|status|skills-status|stop|openclaw-status}" >&2; exit 2 ;;
esac
