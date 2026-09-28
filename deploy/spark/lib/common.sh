#!/usr/bin/env bash
set -euo pipefail

SPARK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SPARK_DIR/../.." && pwd)"
SPARK_ENV_FILE="${SPARK_ENV_FILE:-$SPARK_DIR/.env}"

log() { printf '[spark] %s\n' "$*"; }
warn() { printf '[spark][WARN] %s\n' "$*" >&2; }
die() { printf '[spark][FAIL] %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

nemoclaw_status_ready() {
  local sandbox="$1" expected_model="${2:-}" status_json
  have nemoclaw || return 1
  status_json="$(nemoclaw "$sandbox" status --json 2>/dev/null)" || return 1
  if [[ -n "$expected_model" ]]; then
    printf '%s\n' "$status_json" | python3 "$SPARK_DIR/lib/nemoclaw_status.py" --model "$expected_model"
  else
    printf '%s\n' "$status_json" | python3 "$SPARK_DIR/lib/nemoclaw_status.py"
  fi
}

nemoclaw_status_phase() {
  local sandbox="$1" status_json
  have nemoclaw || return 1
  status_json="$(nemoclaw "$sandbox" status --json 2>/dev/null)" || return 1
  printf '%s\n' "$status_json" | python3 "$SPARK_DIR/lib/nemoclaw_status.py" --phase
}

if [[ -f "$SPARK_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$SPARK_ENV_FILE"
  set +a
elif [[ -f "$SPARK_DIR/env.example" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$SPARK_DIR/env.example"
  set +a
fi

export DEPLOYMENT_PROFILE="${DEPLOYMENT_PROFILE:-spark}"
export SPARK_HOME="${SPARK_HOME:-$HOME/.local/share/life-interview/spark}"
export DATABASE_PATH="${DATABASE_PATH:-$SPARK_HOME/data/memoir.db}"
export SPARK_BACKEND_PORT="${SPARK_BACKEND_PORT:-${PORT:-4174}}"
export SPARK_AGENT_RETRIEVAL_PORT="${SPARK_AGENT_RETRIEVAL_PORT:-4175}"
export SPARK_HOST_IP="${SPARK_HOST_IP:-}"
export SPARK_DIAGNOSTICS_DIR="${SPARK_DIAGNOSTICS_DIR:-$REPO_ROOT/runtime/diagnostics/spark}"
export SPARK_LOG_DIR="${SPARK_LOG_DIR:-$REPO_ROOT/runtime/logs/spark}"
export SPARK_PID_DIR="${SPARK_PID_DIR:-$SPARK_HOME/pids/spark}"
export SPARK_BENCH_DIR="${SPARK_BENCH_DIR:-$REPO_ROOT/runtime/benchmarks/spark}"
export SPARK_TELEMETRY_PATH="${SPARK_TELEMETRY_PATH:-$SPARK_DIAGNOSTICS_DIR/telemetry.json}"
export SPARK_NEMOCLAW_SANDBOX_CONFIGURED="${NEMOCLAW_SANDBOX:-}"
export NEMOCLAW_SANDBOX="${NEMOCLAW_SANDBOX:-my-assistant}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-$SPARK_BACKEND_PORT}"
export PATH="$HOME/.local/bin:$PATH"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,::1"
export no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost,::1"

ensure_product_dirs() {
  mkdir -p "$(dirname "$DATABASE_PATH")" "$SPARK_PID_DIR" \
    "$SPARK_DIAGNOSTICS_DIR/evidence" "$SPARK_LOG_DIR" "$SPARK_BENCH_DIR"
}

pid_file() { printf '%s/%s.pid\n' "$SPARK_PID_DIR" "$1"; }
read_pid() { local path; path="$(pid_file "$1")"; [[ -f "$path" ]] && cat "$path" || true; }
write_pid() { printf '%s\n' "$2" >"$(pid_file "$1")"; }
clear_pid() { rm -f "$(pid_file "$1")"; }
pid_running() { local pid; pid="$(read_pid "$1")"; [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; }

process_is_owned() {
  local pid="$1" needle="$2" cwd command_line
  [[ -r "/proc/$pid/cmdline" && -e "/proc/$pid/cwd" ]] || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$REPO_ROOT" ]] || return 1
  command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$command_line" == *"$needle"* ]]
}

stop_owned_process() {
  local name="$1" needle="$2" timeout="${3:-20}" pid i
  pid="$(read_pid "$name")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    clear_pid "$name"
    return 0
  fi
  if ! process_is_owned "$pid" "$needle"; then
    warn "Refusing to stop PID $pid for $name because it is not a matching process from this checkout."
    return 1
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for ((i=0; i<timeout*5; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "Product process $name (PID $pid) did not stop within ${timeout}s."
    return 1
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
