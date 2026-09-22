#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$project_root"
export LIFE_INTERVIEW_ROOT="$project_root"

uv run --project nvidia/nat nat eval --config_file nvidia/nat/configs/eval.yml
