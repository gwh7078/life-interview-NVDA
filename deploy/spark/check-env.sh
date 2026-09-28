#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

failed=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; failed=1; }
external_not_ready() { printf 'EXTERNAL RUNTIME NOT READY: %s\n' "$1"; failed=1; }
python_ready=0

architecture="$(uname -m 2>/dev/null || true)"
if [[ "$architecture" == aarch64 || "$architecture" == arm64 ]]; then
  pass "ARM64 ($architecture)"
else
  fail "ARM64 required (found ${architecture:-unknown})"
fi

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  pass "NVIDIA GPU and driver"
else
  fail "NVIDIA GPU driver unavailable (nvidia-smi)"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  pass "Docker daemon"
  docker_runtimes="$(docker info --format '{{json .Runtimes}}' 2>/dev/null || true)"
  if [[ "$docker_runtimes" == *'"nvidia"'* ]]; then
    pass "NVIDIA Container Runtime"
  elif have nvidia-ctk \
    && nvidia-ctk cdi list 2>/dev/null | grep -Eq '^nvidia\.com/gpu=(all|[0-9]+)$'; then
    pass "NVIDIA Container Runtime (CDI)"
  else
    fail "NVIDIA Container Runtime unavailable in Docker"
  fi
else
  fail "Docker daemon unavailable"
  fail "NVIDIA Container Runtime cannot be checked without Docker"
fi

if command -v python3 >/dev/null 2>&1 \
  && python_version="$(python3 --version 2>&1)" \
  && [[ "$python_version" =~ ^Python[[:space:]]3\.([0-9]+) ]]; then
  if (( BASH_REMATCH[1] >= 9 )); then
    pass "Python 3.9+ ($python_version)"
    python_ready=1
  else
    fail "Python 3.9+ required ($python_version)"
  fi
else
  fail "Python 3.9+ unavailable (python3 --version)"
fi

if command -v node >/dev/null 2>&1 && node_version="$(node --version 2>/dev/null)" \
  && [[ "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  node_major="${BASH_REMATCH[1]}"
  node_minor="${BASH_REMATCH[2]}"
  if (( (node_major == 24 && node_minor >= 16) || (node_major == 26 && node_minor >= 1) || node_major > 26 )); then
    pass "Node.js ($node_version)"
  else
    fail "Node.js 24.16+ (24.x), 26.1+, or newer required ($node_version)"
  fi
else
  fail "Node.js unavailable (node --version)"
fi

if command -v npm >/dev/null 2>&1 && npm_version="$(npm --version 2>/dev/null)" \
  && [[ "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  pass "npm ($npm_version)"
else
  fail "npm unavailable (npm --version)"
fi

if command -v git >/dev/null 2>&1 && git_version="$(git --version 2>/dev/null)"; then
  pass "Git ($git_version)"
else
  fail "Git unavailable (git --version)"
fi

if [[ -n "${TEXT_MODEL_API_KEY:-}" ]]; then
  fail "Spark Text Runtime requires TEXT_MODEL_API_KEY to be empty"
fi

check_model_endpoint() {
  local name="$1" base="$2" model="$3" api_key_env="$4" url
  if (( ! python_ready )); then return; fi
  if [[ -z "$base" || -z "$model" ]]; then
    fail "$name endpoint/model configuration"
    return
  fi
  if [[ "$name" == Text && ! "$base" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/v1/?$ ]]; then
    fail "Text endpoint must be a loopback OpenAI-compatible /v1 URL"
    return
  fi
  url="${base%/}/models"
  if python3 - "$url" "$model" "$api_key_env" <<'PY'
import json, os, sys, urllib.error, urllib.request
url, model, api_key_env = sys.argv[1:]
api_key = os.environ.get(api_key_env, "")
headers = {"Authorization": "Bearer " + api_key} if api_key else {}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(urllib.request.Request(url, headers=headers), timeout=6) as response:
        payload = json.load(response)
except (OSError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
        json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
served = payload.get("data", []) if isinstance(payload, dict) else []
raise SystemExit(0 if any(isinstance(item, dict) and item.get("id") == model
                         for item in served) else 1)
PY
  then
    pass "$name endpoint and served model ($base)"
  else
    external_not_ready "$name endpoint/model ($base; expected $model from /v1/models)"
  fi
}

check_model_endpoint "Text" "${TEXT_MODEL_BASE_URL:-}" "${TEXT_MODEL:-}" TEXT_MODEL_API_KEY
if [[ "${REALTIME_COACH_PROVIDER:-}" == openai-compatible ]]; then
  check_model_endpoint "Coach" "${REALTIME_COACH_BASE_URL:-}" "${REALTIME_COACH_MODEL:-}" REALTIME_COACH_API_KEY
else
  fail "REALTIME_COACH_PROVIDER must be openai-compatible"
fi

check_websocket() {
  local endpoint="$1" host port path
  if [[ ! "$endpoint" =~ ^ws://([^/:]+):([0-9]+)(/[^[:space:]]*)?$ ]]; then
    fail "STEPAUDIO2_LOCAL_WS_URL must be a ws://host:port/path URL"
    return
  fi
  host="${BASH_REMATCH[1]}"
  port="${BASH_REMATCH[2]}"
  path="${BASH_REMATCH[3]:-/}"
  if (( ! python_ready )); then return; fi
  if python3 - "$host" "$port" "$path" <<'PY'
import socket, sys
host, port, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
key = "dGhlIHNhbXBsZSBub25jZQ=="
request = (
    f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
    "Upgrade: websocket\r\nConnection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
).encode("ascii")
try:
    with socket.create_connection((host, port), timeout=2) as connection:
        connection.settimeout(2)
        connection.sendall(request)
        status = connection.recv(1024).split(b"\r\n", 1)[0]
    raise SystemExit(0 if b" 101 " in status else 1)
except (OSError, TimeoutError):
    raise SystemExit(1)
PY
  then
    pass "StepAudio WebSocket ($endpoint)"
  else
    external_not_ready "StepAudio WebSocket ($endpoint; expected HTTP 101 upgrade)"
  fi
}

if [[ "${STEPAUDIO2_EXECUTION:-}" == local ]]; then
  check_websocket "${STEPAUDIO2_LOCAL_WS_URL:-}"
else
  fail "STEPAUDIO2_EXECUTION must be local for the Spark profile"
fi

check_http() {
  local name="$1" url="$2" api_token_env="${3:-}"
  if (( ! python_ready )); then return; fi
  if [[ -n "$url" ]] && python3 - "$url" "$api_token_env" >/dev/null 2>&1 <<'PY'
import os, sys, urllib.error, urllib.request
url, token_env = sys.argv[1:]
token = os.environ.get(token_env, "") if token_env else ""
headers = {"Authorization": "Bearer " + token} if token else {}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(urllib.request.Request(url, headers=headers), timeout=6) as response:
        raise SystemExit(0 if 200 <= response.status < 300 else 1)
except (OSError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
    raise SystemExit(1)
PY
  then
    pass "$name ($url)"
  else
    external_not_ready "$name ($url)"
  fi
}

if [[ "${NEMO_RETRIEVER_ENABLED:-}" == true ]]; then
  check_http "NeMo Retriever REST" "${NEMO_RETRIEVER_BASE_URL%/}/v1/health" NEMO_RETRIEVER_API_TOKEN
else
  fail "NEMO_RETRIEVER_ENABLED must be true for the Spark profile"
fi

(( failed == 0 ))
