#!/usr/bin/env bash
set -euo pipefail

sandbox="${NEMOCLAW_SANDBOX:-my-assistant}"
agent_id="realtime-context"
workspace="/sandbox/.openclaw/workspace-realtime-context"

find_agent_index() {
  printf '%s\n' "$1" | python3 -c '
import json, re, sys
raw = sys.stdin.read()
match = re.search(r"(?m)^[ \t]*\[[ \t]*$", raw)
if match is None:
    raise SystemExit("Could not find the OpenClaw agents.list JSON array.")
agents, _ = json.JSONDecoder().raw_decode(raw, match.start())
for index, agent in enumerate(agents):
    if agent.get("id") == "realtime-context":
        print(index)
        break
'
}

echo "Configuring least-privilege OpenClaw agent '$agent_id' in sandbox '$sandbox'."

agent_list_output="$(nemoclaw "$sandbox" exec -- openclaw config get agents.list)"
agent_index="$(find_agent_index "$agent_list_output")"

if [ -z "$agent_index" ]; then
  nemoclaw "$sandbox" exec -- openclaw agents add "$agent_id" \
    --workspace "$workspace" \
    --non-interactive
  agent_list_output="$(nemoclaw "$sandbox" exec -- openclaw config get agents.list)"
  agent_index="$(find_agent_index "$agent_list_output")"
fi

if [ -z "$agent_index" ]; then
  echo "OpenClaw did not register the '$agent_id' agent." >&2
  exit 1
fi

tools_allow_path="agents.list[$agent_index].tools.allow"
tools_deny_path="agents.list[$agent_index].tools.deny"
nemoclaw "$sandbox" exec -- openclaw config set \
  --dry-run --strict-json "$tools_allow_path" '[]'
nemoclaw "$sandbox" exec -- openclaw config set \
  --strict-json "$tools_allow_path" '[]'
nemoclaw "$sandbox" exec -- openclaw config set \
  --dry-run --strict-json "$tools_deny_path" '["*"]'
nemoclaw "$sandbox" exec -- openclaw config set \
  --strict-json "$tools_deny_path" '["*"]'

nemoclaw "$sandbox" exec -- openclaw skills install \
  /sandbox/.openclaw/workspace/skills/interview-observer \
  --agent "$agent_id" --force

echo
echo "Verified per-agent empty tool allowlist: $tools_allow_path"
nemoclaw "$sandbox" exec -- openclaw config get "$tools_allow_path"
echo "Verified per-agent policy path: $tools_deny_path"
nemoclaw "$sandbox" exec -- openclaw config get "$tools_deny_path"
nemoclaw "$sandbox" exec -- openclaw skills info interview-observer --agent "$agent_id"
