#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

have nemoclaw || die "NemoClaw/OpenClaw Agent Runtime is not ready; prepare it before application setup."
[[ -n "${NEMOCLAW_SANDBOX:-}" ]] || die "NEMOCLAW_SANDBOX is not configured."
nemoclaw_status_ready "$NEMOCLAW_SANDBOX" \
  || die "NemoClaw sandbox is not RUNNING."

skills=(
  onboarding-closeout
  interview-closeout
  interview-observer
  story-completion
  story-generation
)
for skill in "${skills[@]}"; do
  path="$REPO_ROOT/agent/skills/$skill"
  [[ -f "$path/SKILL.md" ]] || die "Missing formal Skill: $path/SKILL.md"
  nemoclaw "$NEMOCLAW_SANDBOX" skill install "$path"
done

# The NemoClaw command installs into OpenClaw's main-agent skill root. The
# observer is also installed in the restricted product agent's own workspace.
nemoclaw "$NEMOCLAW_SANDBOX" exec -- openclaw skills install \
  /sandbox/.openclaw/workspace/skills/interview-observer \
  --agent realtime-context --force >/dev/null

echo "Synced ${#skills[@]} formal Skills; interview-observer is available to realtime-context."
