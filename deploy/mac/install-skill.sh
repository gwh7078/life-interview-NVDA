#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
sandbox="${NEMOCLAW_SANDBOX:-my-assistant}"

skills=(
  "onboarding-closeout"
  "interview-closeout"
  "story-completion"
  "story-generation"
)

echo "Installing Phase 2B-C skills into NemoClaw sandbox: $sandbox"

for skill in "${skills[@]}"; do
  skill_dir="$repo_root/agent/skills/$skill"
  if [ ! -d "$skill_dir" ]; then
    echo "missing skill directory: $skill_dir" >&2
    exit 1
  fi
  nemoclaw "$sandbox" skill install "$skill_dir"
done

echo
echo "Installed skills:"
nemoclaw "$sandbox" skill list

echo
echo "Phase 2B-C skill installation complete."
echo "Legacy Phase 1 skill 'story-context-inspector' is intentionally not installed by this script."
