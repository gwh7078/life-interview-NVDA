#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

image="${SPARK_STEPAUDIO_IMAGE:-stepfun2025/vllm:step-audio-2-v20250909}"
backend_name="${SPARK_STEPAUDIO_CONTAINER:-life-interview-spark-stepaudio}"
bridge_name="${SPARK_STEPAUDIO_BRIDGE_CONTAINER:-life-interview-spark-stepaudio-bridge}"
source_dir="${SPARK_STEPAUDIO_SOURCE_DIR:-$MODEL_CACHE/sources/Step-Audio2}"
source_ref="${SPARK_STEPAUDIO_SOURCE_REF:-76e272b56c3917a8d7188f18bbb5a65dfc8a0845}"
model_dir="${SPARK_STEPAUDIO_MODEL_DIR:-$MODEL_CACHE/stepfun-ai/Step-Audio-2-mini}"
model_identity="${SPARK_STEPAUDIO_MODEL_NAME:-step-audio-2-mini}"
bridge_file="$SPARK_RUNTIME_DIR/bridge/stepaudio2_bridge.py"
manifest_file="$SPARK_DIAGNOSTICS_DIR/stepaudio-image-manifest.json"
backend_args=(vllm serve /Step-Audio-2-mini --served-model-name "$model_identity" --port 8000
  --max-model-len "${SPARK_STEPAUDIO_MAX_MODEL_LEN:-16384}"
  --max-num-seqs "${SPARK_STEPAUDIO_MAX_NUM_SEQS:-4}"
  --tensor-parallel-size 1 --enable-auto-tool-choice --tool-call-parser step_audio_2
  --tokenizer-mode step_audio_2 --chat_template_content_format string
  --audio-parser step_audio_2_tts_ta4 --trust-remote-code --disable-log-requests)
backend_spec="$(spec_hash "$image" "${SPARK_STEPAUDIO_HF_MODEL:-stepfun-ai/Step-Audio-2-mini}" "$model_dir" "$SPARK_STEPAUDIO_BACKEND_PORT" "${backend_args[@]}")"
bridge_impl_hash="$(spark_path_fingerprint "$DIR/services/stepaudio2_bridge.py")"
bridge_spec="$(spec_hash bridge-v1 "$image" "$source_ref" "${SPARK_STEPAUDIO_HF_MODEL:-stepfun-ai/Step-Audio-2-mini}" "$model_identity" "$source_dir" "$model_dir" "$SPARK_STEPAUDIO_BACKEND_PORT" "$SPARK_STEPAUDIO_WS_PORT" "$SPARK_STEPAUDIO_HEALTH_PORT" "${SPARK_STEPAUDIO_BRIDGE_HOST:-127.0.0.1}" "${SPARK_STEPAUDIO_MAX_TURN_BYTES:-8640000}" "${SPARK_STEPAUDIO_TOKEN_CHUNK:-25}" "$bridge_impl_hash")"

sync_bridge_source() {
  mkdir -p "$(dirname "$bridge_file")"
  if ! cmp -s "$DIR/services/stepaudio2_bridge.py" "$bridge_file" 2>/dev/null; then
    install -m 0644 "$DIR/services/stepaudio2_bridge.py" "$bridge_file"
  fi
}

arm64_image() {
  local local_arch
  local_arch="$(docker image inspect -f '{{.Architecture}}' "$image" 2>/dev/null || true)"
  if [[ "$local_arch" == "arm64" || "$local_arch" == "aarch64" ]]; then
    return 0
  fi
  docker manifest inspect "$image" >"$manifest_file" 2>/dev/null || return 1
  grep -Eq '"architecture"[[:space:]]*:[[:space:]]*"arm64"|"architecture"[[:space:]]*:[[:space:]]*"aarch64"' "$manifest_file"
}

prefetch() {
  mkdir -p "$(dirname "$source_dir")" "$model_dir"
  if [[ ! -d "$source_dir/.git" ]]; then
    git clone https://github.com/stepfun-ai/Step-Audio2.git "$source_dir"
  fi
  git -C "$source_dir" fetch --depth 1 origin "$source_ref"
  git -C "$source_dir" reset --hard "$source_ref"
  if [[ ! -f "$model_dir/config.json" ]]; then
    hf_download "${SPARK_STEPAUDIO_HF_MODEL:-stepfun-ai/Step-Audio-2-mini}" "$model_dir"
  fi
  python3 "$DIR/fixtures/generate.py" "$source_dir" "$SPARK_BENCH_DIR/fixtures"
  docker manifest inspect "$image" >"$manifest_file" 2>/dev/null || true
  if arm64_image; then docker_pull_cached "$image"; else
    warn "StepFun image does not currently prove linux/arm64 support. Native runtime path remains available via SPARK_STEPAUDIO_NATIVE_START_CMD."
  fi
}

start_docker() {
  reconcile_container_spec "$backend_name" "$backend_spec"
  reconcile_container_spec "$bridge_name" "$bridge_spec"
  if ! docker ps --format '{{.Names}}' | grep -qx "$backend_name"; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$backend_name"; then docker start "$backend_name" >/dev/null; else
      docker run -d --name "$backend_name" --label "life-interview.spark.spec=$backend_spec" --gpus all -v "$model_dir:/Step-Audio-2-mini:ro"         -p "$SPARK_STEPAUDIO_BACKEND_PORT:8000" "$image" -- "${backend_args[@]}"
    fi
  fi
  "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_STEPAUDIO_BACKEND_PORT/health" "${SPARK_STEPAUDIO_START_TIMEOUT_S:-1200}"
  if docker ps --format '{{.Names}}' | grep -qx "$bridge_name"; then
    :
  elif docker ps -a --format '{{.Names}}' | grep -qx "$bridge_name"; then
    docker start "$bridge_name" >/dev/null
  else
    sync_bridge_source
    docker run -d --name "$bridge_name" --label "life-interview.spark.spec=$bridge_spec" --gpus all --network host --entrypoint /bin/bash       -v "$bridge_file:/app/stepaudio2_bridge.py:ro" -v "$source_dir:/Step-Audio2:ro" -v "$model_dir:/Step-Audio-2-mini:ro"       -e STEP_AUDIO_BACKEND_URL="http://127.0.0.1:$SPARK_STEPAUDIO_BACKEND_PORT/v1/chat/completions"       -e STEP_AUDIO_MODEL="$model_identity" -e STEP_AUDIO_BRIDGE_HOST="${SPARK_STEPAUDIO_BRIDGE_HOST:-127.0.0.1}"       -e STEP_AUDIO_BRIDGE_PORT="$SPARK_STEPAUDIO_WS_PORT" -e STEP_AUDIO_HEALTH_PORT="$SPARK_STEPAUDIO_HEALTH_PORT"       -e STEP_AUDIO_MAX_TURN_BYTES="${SPARK_STEPAUDIO_MAX_TURN_BYTES:-8640000}" -e STEP_AUDIO_TOKEN_CHUNK="${SPARK_STEPAUDIO_TOKEN_CHUNK:-25}"       -e STEP_AUDIO_SOURCE_DIR=/Step-Audio2 -e STEP_AUDIO_TOKEN2WAV_DIR=/Step-Audio-2-mini/token2wav       "$image" -lc 'python3 -m pip install --quiet "websockets>=14,<16" && exec python3 /app/stepaudio2_bridge.py'
  fi
  "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_STEPAUDIO_HEALTH_PORT/health" "${SPARK_STEPAUDIO_BRIDGE_TIMEOUT_S:-600}"
}

start_native() {
  [[ -n "${SPARK_STEPAUDIO_NATIVE_START_CMD:-}" ]] || die "No ARM64 Step-Audio image and SPARK_STEPAUDIO_NATIVE_START_CMD is unset. Inspect manifest/runtime on the real Spark and provide the native command; do not emulate x86."
  local backend_native_spec bridge_native_spec backend_spec_file bridge_spec_file current_spec bridge_cmd p
  sync_bridge_source
  bridge_cmd="${SPARK_STEPAUDIO_NATIVE_BRIDGE_CMD:-python3 '$bridge_file'}"
  backend_native_spec="$(spec_hash "$SPARK_STEPAUDIO_NATIVE_START_CMD" "$source_ref" "${SPARK_STEPAUDIO_HF_MODEL:-stepfun-ai/Step-Audio-2-mini}" "$model_dir" "$SPARK_STEPAUDIO_BACKEND_PORT" "${SPARK_STEPAUDIO_MAX_MODEL_LEN:-16384}" "${SPARK_STEPAUDIO_MAX_NUM_SEQS:-4}")"
  bridge_native_spec="$(spec_hash "$bridge_cmd" "$source_ref" "${SPARK_STEPAUDIO_HF_MODEL:-stepfun-ai/Step-Audio-2-mini}" "$model_identity" "$source_dir" "$model_dir" "$SPARK_STEPAUDIO_BACKEND_PORT" "$SPARK_STEPAUDIO_WS_PORT" "$SPARK_STEPAUDIO_HEALTH_PORT" "${SPARK_STEPAUDIO_BRIDGE_HOST:-127.0.0.1}" "${SPARK_STEPAUDIO_MAX_TURN_BYTES:-8640000}" "${SPARK_STEPAUDIO_TOKEN_CHUNK:-25}" "$bridge_impl_hash")"
  backend_spec_file="$SPARK_STATE_DIR/stepaudio-backend-native.spec"
  bridge_spec_file="$SPARK_STATE_DIR/stepaudio-bridge-native.spec"
  current_spec="$(cat "$backend_spec_file" 2>/dev/null || true)"
  if [[ "$current_spec" != "$backend_native_spec" ]]; then
    p="$(read_pid stepaudio-backend)"; [[ "$p" =~ ^[0-9]+$ ]] && kill "$p" 2>/dev/null || true; clear_pid stepaudio-backend
  fi
  current_spec="$(cat "$bridge_spec_file" 2>/dev/null || true)"
  if [[ "$current_spec" != "$bridge_native_spec" ]]; then
    p="$(read_pid stepaudio-bridge)"; [[ "$p" =~ ^[0-9]+$ ]] && kill "$p" 2>/dev/null || true; clear_pid stepaudio-bridge
  fi
  if ! pid_running stepaudio-backend; then
    nohup bash -lc "$SPARK_STEPAUDIO_NATIVE_START_CMD" >>"$SPARK_LOG_DIR/realtime.log" 2>&1 &
    write_pid stepaudio-backend "$!"
  fi
  "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_STEPAUDIO_BACKEND_PORT/health" "${SPARK_STEPAUDIO_START_TIMEOUT_S:-1200}"
  if ! pid_running stepaudio-bridge; then
    STEP_AUDIO_BACKEND_URL="http://127.0.0.1:$SPARK_STEPAUDIO_BACKEND_PORT/v1/chat/completions"       STEP_AUDIO_MODEL="$model_identity" STEP_AUDIO_BRIDGE_HOST="${SPARK_STEPAUDIO_BRIDGE_HOST:-127.0.0.1}"       STEP_AUDIO_BRIDGE_PORT="$SPARK_STEPAUDIO_WS_PORT" STEP_AUDIO_HEALTH_PORT="$SPARK_STEPAUDIO_HEALTH_PORT"       STEP_AUDIO_MAX_TURN_BYTES="${SPARK_STEPAUDIO_MAX_TURN_BYTES:-8640000}" STEP_AUDIO_TOKEN_CHUNK="${SPARK_STEPAUDIO_TOKEN_CHUNK:-25}"       STEP_AUDIO_SOURCE_DIR="$source_dir" STEP_AUDIO_TOKEN2WAV_DIR="$model_dir/token2wav"       nohup bash -lc "$bridge_cmd" >>"$SPARK_LOG_DIR/realtime.log" 2>&1 &
    write_pid stepaudio-bridge "$!"
  fi
  "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_STEPAUDIO_HEALTH_PORT/health" "${SPARK_STEPAUDIO_BRIDGE_TIMEOUT_S:-600}"
  printf '%s\n' "$backend_native_spec" > "$backend_spec_file"
  printf '%s\n' "$bridge_native_spec" > "$bridge_spec_file"
}

case "${1:-status}" in
  prefetch) prefetch ;;
  bridge-fingerprint) printf '%s\n' "$bridge_spec" ;;
  start)
    if arm64_image; then start_docker; else start_native; fi
    ;;
  stop)
    docker stop "$bridge_name" "$backend_name" >/dev/null 2>&1 || true
    for n in stepaudio-bridge stepaudio-backend; do p="$(read_pid "$n")"; [[ "$p" =~ ^[0-9]+$ ]] && kill "$p" 2>/dev/null || true; clear_pid "$n"; done
    ;;
  status) curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_STEPAUDIO_HEALTH_PORT/health" >/dev/null 2>&1 && echo RUNNING || echo STOPPED ;;
  manifest) arm64_image && echo ARM64_SUPPORTED || echo ARM64_NOT_PROVEN ;;
  *) echo "usage: $0 {prefetch|start|stop|status|manifest}" >&2; exit 2 ;;
esac
