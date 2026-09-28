#!/usr/bin/env bash
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

failed=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; failed=1; }
external_not_ready() { printf 'EXTERNAL RUNTIME NOT READY: %s\n' "$1"; failed=1; }

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
else
  fail "Docker daemon unavailable"
fi

check_model_endpoint() {
  local name="$1" base="$2" model="$3" api_key_env="$4" url
  if [[ -z "$base" || -z "$model" ]]; then
    fail "$name endpoint/model configuration"
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
  local endpoint="$1" url response
  if [[ ! "$endpoint" =~ ^ws://([^/:]+):([0-9]+)(/[^[:space:]]*)?$ ]]; then
    fail "STEPAUDIO2_LOCAL_WS_URL must be a ws://host:port/path URL"
    return
  fi
  url="http://${BASH_REMATCH[1]}:${BASH_REMATCH[2]}${BASH_REMATCH[3]:-/}"
  response="$(curl --noproxy '*' --http1.1 --connect-timeout 2 --max-time 2 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
  if [[ "$response" == 101 ]]; then
    pass "StepAudio WebSocket ($endpoint)"
  else
    external_not_ready "StepAudio WebSocket ($endpoint; expected HTTP 101, received ${response:-no response})"
  fi
}

if [[ "${STEPAUDIO2_EXECUTION:-}" == local ]]; then
  check_websocket "${STEPAUDIO2_LOCAL_WS_URL:-}"
else
  fail "STEPAUDIO2_EXECUTION must be local for the Spark profile"
fi

check_http() {
  local name="$1" url="$2" api_token_env="${3:-}"
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
