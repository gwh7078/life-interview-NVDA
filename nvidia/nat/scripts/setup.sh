#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$project_root/nvidia/nat"

if [[ ! -x .venv/bin/python ]]; then
  uv venv --python 3.12 .venv
fi

uv pip install --python .venv/bin/python -e .
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/nat --version
