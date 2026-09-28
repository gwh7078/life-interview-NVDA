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
  local name="$1" base="$2" model="$3" api_key="$4" response url auth=()
  if [[ -z "$base" || -z "$model" ]]; then
    fail "$name endpoint/model configuration"
    return
  fi
  url="${base%/}/models"
  [[ -n "$api_key" ]] && auth=(-H "Authorization: Bearer $api_key")
  response="$(curl --noproxy '*' --connect-timeout 2 --max-time 6 -fsS "${auth[@]}" "$url" 2>/dev/null || true)"
  if [[ -n "$response" ]] && python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
served = payload.get("data", []) if isinstance(payload, dict) else []
raise SystemExit(0 if any(isinstance(item, dict) and item.get("id") == sys.argv[1]
                         for item in served) else 1)
' "$model" <<<"$response"; then
    pass "$name endpoint and served model ($base)"
  else
    external_not_ready "$name endpoint/model ($base; expected $model from /v1/models)"
  fi
}

check_model_endpoint "Text" "${TEXT_MODEL_BASE_URL:-}" "${TEXT_MODEL:-}" "${TEXT_MODEL_API_KEY:-}"
if [[ "${REALTIME_COACH_PROVIDER:-}" == openai-compatible ]]; then
  check_model_endpoint "Coach" "${REALTIME_COACH_BASE_URL:-}" "${REALTIME_COACH_MODEL:-}" "${REALTIME_COACH_API_KEY:-}"
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
  local name="$1" url="$2"
  if [[ -n "$url" ]] && curl --noproxy '*' --connect-timeout 2 --max-time 6 -fsS "$url" >/dev/null 2>&1; then
    pass "$name ($url)"
  else
    external_not_ready "$name ($url)"
  fi
}

if [[ "${NEMO_RETRIEVER_ENABLED:-}" == true ]]; then
  check_http "NeMo Retriever REST" "${NEMO_RETRIEVER_BASE_URL%/}/v1/health"
  check_http "NeMo Retriever VectorDB" "${NEMO_RETRIEVER_VECTORDB_URL%/}/v1/health"
else
  fail "NEMO_RETRIEVER_ENABLED must be true for the Spark profile"
fi

(( failed == 0 ))
