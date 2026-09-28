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

hf_prefetch_cache() {
  local model="$1" venv hfbin
  venv="$(ensure_tool_venv)"
  hfbin="$venv/bin/hf"
  if [[ -x "$hfbin" ]]; then
    "$hfbin" download "$model" --cache-dir "$MODEL_CACHE"
  else
    "$venv/bin/huggingface-cli" download "$model" --cache-dir "$MODEL_CACHE"
  fi
}

docker_pull_cached() {
  local image="$1" lock_id lock_file
  if docker image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi
  lock_id="$(printf '%s' "$image" | sha256sum | awk '{print $1}')"
  lock_file="$SPARK_STATE_DIR/docker-pull-$lock_id.lock"
  (
    if command -v flock >/dev/null 2>&1; then
      flock 9
    fi
    docker image inspect "$image" >/dev/null 2>&1 && exit 0
    if docker pull "$image"; then
      exit 0
    fi
    if [[ "$image" == nvcr.io/* && -n "${NGC_API_KEY:-}" ]]; then
      printf '%s' "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin >/dev/null
      docker pull "$image"
      exit 0
    fi
    echo "Docker pull failed for $image. If NGC authentication is required, export NGC_API_KEY and rerun." >&2
    exit 1
  ) 9>"$lock_file"
}

spec_hash() {
  printf '%s\0' "$@" | sha256sum | awk '{print $1}'
}

container_spec() {
  local name="$1"
  docker inspect -f '{{ index .Config.Labels "life-interview.spark.spec" }}' "$name" 2>/dev/null || true
}

reconcile_container_spec() {
  local name="$1" desired="$2" current
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    return 0
  fi
  current="$(container_spec "$name")"
  if [[ "$current" != "$desired" ]]; then
    log "Recreating $name because runtime configuration changed."
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

load_spark_env
