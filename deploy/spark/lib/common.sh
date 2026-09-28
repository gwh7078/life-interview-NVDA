#!/usr/bin/env bash
set -euo pipefail

SPARK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SPARK_DIR/../.." && pwd)"
SPARK_ENV_FILE="${SPARK_ENV_FILE:-$SPARK_DIR/.env}"

load_spark_env() {
  if [[ -f "$SPARK_ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$SPARK_ENV_FILE"
    set +a
  fi

  export SPARK_HOME="${SPARK_HOME:-$HOME/.local/share/life-interview/spark}"
  export SPARK_RUNTIME_DIR="${SPARK_RUNTIME_DIR:-$SPARK_HOME/runtime}"
  export SPARK_DIAGNOSTICS_DIR="${SPARK_DIAGNOSTICS_DIR:-$REPO_ROOT/runtime/diagnostics/spark}"
  export SPARK_LOG_DIR="${SPARK_LOG_DIR:-$REPO_ROOT/runtime/logs/spark}"
  export SPARK_STATE_DIR="${SPARK_STATE_DIR:-$SPARK_HOME/state}"
  export SPARK_PID_DIR="${SPARK_PID_DIR:-$SPARK_HOME/pids/spark}"
  export SPARK_BENCH_DIR="${SPARK_BENCH_DIR:-$REPO_ROOT/runtime/benchmarks/spark}"
  export SPARK_RETRIEVER_DATA_DIR="${SPARK_RETRIEVER_DATA_DIR:-$SPARK_HOME/retriever/data}"
  export SPARK_BASE_VERSION="${SPARK_BASE_VERSION:-1}"
  export SPARK_NODE_VERSION="${SPARK_NODE_VERSION:-24.21.0}"
  export SPARK_UV_VERSION="${SPARK_UV_VERSION:-0.12.19}"
  export SPARK_BASE_VLLM_IMAGE="${SPARK_BASE_VLLM_IMAGE:-${SPARK_VLLM_IMAGE:-}}"
  export SPARK_TEXT_SERVED_MODEL="${SPARK_TEXT_SERVED_MODEL:-nvidia/Qwen3.6-35B-A3B-NVFP4}"
  export SPARK_COACH_SERVED_MODEL="${SPARK_COACH_SERVED_MODEL:-Qwen/Qwen3-8B}"

  export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
  export MODEL_CACHE="${MODEL_CACHE:-$HF_HOME/hub}"
  export NGC_CACHE="${NGC_CACHE:-$HOME/.cache/ngc}"
  export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$SPARK_HOME/venv/nat}"
  export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,::1"
  export no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost,::1"

  local configured_database_path="${DATABASE_PATH:-}"
  if [[ "${DEPLOYMENT_PROFILE:-spark}" == "spark" ]]; then
    case "$configured_database_path" in
      ""|data/memoir.db|./data/memoir.db|"$REPO_ROOT/data/memoir.db")
        export SPARK_LEGACY_DATABASE_PATH="${configured_database_path:+$REPO_ROOT/data/memoir.db}"
        export DATABASE_PATH="$SPARK_HOME/data/memoir.db"
        ;;
      *) export SPARK_LEGACY_DATABASE_PATH="" ;;
    esac
  fi

  mkdir -p "$SPARK_HOME/data" "$SPARK_RUNTIME_DIR" "$SPARK_STATE_DIR" \
    "$SPARK_PID_DIR" "$SPARK_RETRIEVER_DATA_DIR" "$SPARK_DIAGNOSTICS_DIR" \
    "$SPARK_LOG_DIR" "$SPARK_BENCH_DIR" "$HF_HOME" "$MODEL_CACHE" "$NGC_CACHE"
  local legacy_pid_dir="$REPO_ROOT/runtime/pids/spark" source_pid target_pid
  if [[ "$legacy_pid_dir" != "$SPARK_PID_DIR" && -d "$legacy_pid_dir" ]]; then
    for source_pid in "$legacy_pid_dir"/*.pid; do
      [[ -f "$source_pid" ]] || continue
      target_pid="$SPARK_PID_DIR/${source_pid##*/}"
      [[ -e "$target_pid" ]] || cp -p "$source_pid" "$target_pid"
    done
  fi
  export PATH="$SPARK_HOME/tools/node/bin:$SPARK_HOME/tools/uv/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
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
stop_owned_process() {
  local name="$1" timeout="${2:-20}" p i
  p="$(read_pid "$name")"
  if [[ "$p" =~ ^[0-9]+$ ]] && kill -0 "$p" 2>/dev/null; then
    kill "$p" 2>/dev/null || true
    for ((i=0; i<timeout*5; i++)); do
      kill -0 "$p" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$p" 2>/dev/null; then
      warn "Process $name (PID $p) did not stop within ${timeout}s."
      return 1
    fi
  fi
  clear_pid "$name"
}

safe_host_ip() {
  local ip="${SPARK_HOST_IP:-}"
  if [[ -z "$ip" ]]; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true
  fi
  [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  printf '%s\n' "${ip:-127.0.0.1}"
}

ensure_tool_venv() {
  local venv="$SPARK_HOME/venv/spark-tools"
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
    if command -v flock >/dev/null 2>&1; then flock 9; fi
    docker image inspect "$image" >/dev/null 2>&1 && exit 0
    if docker pull "$image"; then exit 0; fi
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

spark_path_fingerprint() {
  python3 - "$REPO_ROOT" "$@" <<'PY'
import hashlib, os, sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
paths = [Path(value) for value in sys.argv[2:]]
items = []
for path in paths:
    path = (root / path).resolve() if not path.is_absolute() else path.resolve()
    try:
        label = path.relative_to(root).as_posix()
    except ValueError:
        label = path.name
    if path.is_dir():
        files = sorted(p for p in path.rglob("*") if p.is_file() or p.is_symlink())
        if not files:
            items.append((label + "/", b""))
        for file in files:
            rel = file.relative_to(path).as_posix()
            items.append((label + "/" + rel, os.readlink(file).encode() if file.is_symlink() else file.read_bytes()))
    elif path.is_file():
        items.append((label, os.readlink(path).encode() if path.is_symlink() else path.read_bytes()))
    else:
        items.append((label, b"<missing>"))
digest = hashlib.sha256()
for label, content in sorted(items):
    digest.update(label.encode())
    digest.update(b"\0")
    digest.update(content)
    digest.update(b"\0")
print(digest.hexdigest())
PY
}

spark_base_fingerprint() {
  local files_hash python_identity architecture gpu_identity docker_identity runtime_identity
  files_hash="$(spark_path_fingerprint \
    "$SPARK_DIR/bootstrap.sh" \
    "$SPARK_DIR/lib/install-node.sh" \
    "$SPARK_DIR/lib/docker-gpu-smoke.sh" \
    "$SPARK_DIR/services/nemoclaw-base.sh")"
  python_identity="$(python3 -c 'import platform,sys; print(sys.executable, platform.python_version())')"
  architecture="$(uname -m)"
  gpu_identity="$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | LC_ALL=C sort -u || true)"
  [[ -n "$gpu_identity" ]] || gpu_identity=unavailable
  docker_identity="$(docker version --format '{{.Client.Version}}|{{.Server.Version}}' 2>/dev/null \
    || docker --version 2>/dev/null || printf 'unavailable')"
  runtime_identity="$(docker info --format '{{.Architecture}}|{{.OSType}}|{{.DefaultRuntime}}|{{json .Runtimes}}' 2>/dev/null \
    || printf 'unavailable')"
  printf '%s\0' \
    "$SPARK_BASE_VERSION" "$SPARK_HOME" "$SPARK_NODE_VERSION" "$SPARK_UV_VERSION" "$python_identity" \
    "$architecture" "$gpu_identity" "$docker_identity" "$runtime_identity" \
    "$SPARK_BASE_VLLM_IMAGE" "$files_hash" | sha256sum | awk '{print $1}'
}

container_spec() {
  local name="$1"
  docker inspect -f '{{ index .Config.Labels "life-interview.spark.spec" }}' "$name" 2>/dev/null || true
}

reconcile_container_spec() {
  local name="$1" desired="$2" current
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$name"; then return 0; fi
  current="$(container_spec "$name")"
  if [[ "$current" != "$desired" ]]; then
    log "Recreating $name because runtime configuration changed."
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
}

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

load_spark_env
