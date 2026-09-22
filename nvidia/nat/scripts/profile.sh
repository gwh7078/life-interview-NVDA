#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$project_root"
export LIFE_INTERVIEW_ROOT="$project_root"
export NAT_AGENT_RUNTIME="${NAT_AGENT_RUNTIME:-agent}"

uv run --project nvidia/nat nat eval --config_file nvidia/nat/configs/profiler.yml
