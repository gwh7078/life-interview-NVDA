#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
sandbox="${NEMOCLAW_SANDBOX:-life-interview-agent}"
nemoclaw "$sandbox" skill install "$repo_root/agent/skills/story-context-inspector"
