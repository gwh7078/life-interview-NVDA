#!/usr/bin/env bash
set -euo pipefail

SPARK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SPARK_DIR/../.." && pwd)"
SPARK_ENV_FILE="${SPARK_ENV_FILE:-$SPARK_DIR/.env}"
SPARK_RUNTIME_DIR="${SPARK_RUNTIME_DIR:-$REPO_ROOT/runtime}"
SPARK_DIAGNOSTICS_DIR="${SPARK_DIAGNOSTICS_DIR:-$SPARK_RUNTIME_DIR/diagnostics/spark}"
SPARK_LOG_DIR="${SPARK_LOG_DIR:-$SPARK_RUNTIME_DIR/logs/spark}"
SPARK_STATE_DIR="${SPARK_STATE_DIR:-$SPARK_DIAGNOSTICS_DIR/state}"
SPARK_PID_DIR="${SPARK_PID_DIR:-$SPARK_RUNTIME_DIR/pids/spark}"
SPARK_BENCH_DIR="${SPARK_BENCH_DIR:-$SPARK_RUNTIME_DIR/benchmarks/spark}"

# Prefer deployment-local bootstrapped tools without mutating the user's system.
for _spark_bin in "$SPARK_RUNTIME_DIR/tools/node/bin" "$SPARK_RUNTIME_DIR/tools/uv/bin"; do
  [[ -d "$_spark_bin" ]] && export PATH="$_spark_bin:$PATH"
done
unset _spark_bin

load_spark_env() {
  if [[ -f "$SPARK_ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$SPARK_ENV_FILE"
    set +a
  fi
  export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
  export MODEL_CACHE="${MODEL_CACHE:-$HF_HOME/hub}"
  export NGC_CACHE="${NGC_CACHE:-$HOME/.cache/ngc}"
  export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,::1"
  export no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost,::1"
  mkdir -p "$SPARK_DIAGNOSTICS_DIR" "$SPARK_LOG_DIR" "$SPARK_STATE_DIR" "$SPARK_PID_DIR" "$SPARK_BENCH_DIR" "$HF_HOME" "$MODEL_CACHE" "$NGC_CACHE"
}

log() { printf '[spark] %s\n' "$*"; }
warn() { printf '[spark][WARN] %s\n' "$*" >&2; }
die() { printf '[spark][FAIL] %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

pid_file() { printf '%s/%s.pid\n' "$SPARK_PID_DIR" "$1"; }
read_pid() { local f; f="$(pid_file "$1")"; [[ -f "$f" ]] && cat "$f" || true; }
pid_running() { local p; p="$(read_pid "$1")"; [[ "$p" =~ ^[0-9]+$ ]] && kill -0 "$p" 2>/dev/null; }
write_pid() { printf '%s\n' "$2" > "$(pid_file "$1")"; }
clear_pid() { rm -f "$(pid_file "$1")"; }

safe_host_ip() {
  local ip
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true
  [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  printf '%s\n' "${ip:-127.0.0.1}"
}

ensure_tool_venv() {
  local venv="$SPARK_RUNTIME_DIR/venv/spark-tools"
  if [[ ! -x "$venv/bin/python" ]]; then
    python3 -m venv "$venv"
    "$venv/bin/python" -m pip install --quiet --upgrade pip
    "$venv/bin/python" -m pip install --quiet "huggingface_hub>=0.36,<2"
  fi
  printf '%s\n' "$venv"
}

hf_download() {
  local model="$1" target="$2" venv hfbin
  mkdir -p "$target"
  venv="$(ensure_tool_venv)"
  hfbin="$venv/bin/hf"
  if [[ -x "$hfbin" ]]; then
    "$hfbin" download "$model" --local-dir "$target"
  else
    "$venv/bin/huggingface-cli" download "$model" --local-dir "$target"
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

load_spark_env
