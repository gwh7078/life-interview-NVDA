#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

image="${SPARK_VLLM_IMAGE:-vllm/vllm-openai:v0.28.0}"
model="${SPARK_TEXT_MODEL:-nvidia/Qwen3.6-35B-A3B-NVFP4}"
name="${SPARK_TEXT_CONTAINER:-life-interview-spark-text}"
max_len="${SPARK_TEXT_MAX_MODEL_LEN:-32768}"
gpu_util="${SPARK_TEXT_GPU_MEMORY_UTILIZATION:-0.50}"

case "${1:-status}" in
  prefetch)
    docker pull "$image"
    hf_download "$model" "${SPARK_TEXT_MODEL_DIR:-$MODEL_CACHE/nvidia/Qwen3.6-35B-A3B-NVFP4}"
    ;;
  start)
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then exit 0; fi
    if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then docker start "$name" >/dev/null; else
      args=(run -d --name "$name" --gpus all --ipc host --ulimit memlock=-1 --ulimit stack=67108864
        -p "$SPARK_TEXT_PORT:8000" -v "$HF_HOME:/root/.cache/huggingface" --entrypoint "" )
      [[ -n "${HF_TOKEN:-}" ]] && args+=(-e HF_TOKEN)
      docker "${args[@]}" "$image" vllm serve "$model" --served-model-name "$model"         --max-model-len "$max_len" --gpu-memory-utilization "$gpu_util"
    fi
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_TEXT_PORT/health" "${SPARK_TEXT_START_TIMEOUT_S:-1200}"
    ;;
  stop) docker stop "$name" >/dev/null 2>&1 || true ;;
  status) curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_TEXT_PORT/health" >/dev/null 2>&1 && echo RUNNING || echo STOPPED ;;
  *) echo "usage: $0 {prefetch|start|stop|status}" >&2; exit 2 ;;
esac
