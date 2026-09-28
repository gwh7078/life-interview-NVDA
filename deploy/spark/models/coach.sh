#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

image="${SPARK_VLLM_IMAGE:-${SPARK_BASE_VLLM_IMAGE:-nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2}}"
model="${SPARK_COACH_MODEL:-Qwen/Qwen3-8B}"
served_model="$SPARK_COACH_SERVED_MODEL"
name="${SPARK_COACH_CONTAINER:-life-interview-spark-coach}"
max_len="${SPARK_COACH_MAX_MODEL_LEN:-8192}"
gpu_util="${SPARK_COACH_GPU_MEMORY_UTILIZATION:-0.18}"
runtime_args=(vllm serve "$model" --served-model-name "$served_model" --max-model-len "$max_len"
  --gpu-memory-utilization "$gpu_util" --reasoning-parser qwen3 --disable-log-requests)
spec="$(spec_hash "$image" "$SPARK_COACH_PORT" "${runtime_args[@]}")"

case "${1:-status}" in
  prefetch)
    docker_pull_cached "$image"
    hf_prefetch_cache "$model"
    ;;
  start)
    reconcile_container_spec "$name" "$spec"
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_COACH_PORT/health" "${SPARK_COACH_START_TIMEOUT_S:-900}"
      exit 0
    fi
    if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then docker start "$name" >/dev/null; else
      args=(run -d --name "$name" --label "life-interview.spark.spec=$spec" --gpus all --ipc host --ulimit memlock=-1 --ulimit stack=67108864
        -p "$SPARK_COACH_PORT:8000" -v "$HF_HOME:/root/.cache/huggingface" --entrypoint "")
      [[ -n "${HF_TOKEN:-}" ]] && args+=(-e HF_TOKEN)
      docker "${args[@]}" "$image" "${runtime_args[@]}"
    fi
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_COACH_PORT/health" "${SPARK_COACH_START_TIMEOUT_S:-900}"
    ;;
  stop) docker stop "$name" >/dev/null 2>&1 || true ;;
  status) curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_COACH_PORT/health" >/dev/null 2>&1 && echo RUNNING || echo STOPPED ;;
  *) echo "usage: $0 {prefetch|start|stop|status}" >&2; exit 2 ;;
esac
