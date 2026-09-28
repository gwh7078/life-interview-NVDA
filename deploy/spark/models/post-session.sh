#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

# NVIDIA's current DGX Spark Qwen3.6 recipe image is pinned by digest.
image="${SPARK_VLLM_IMAGE:-nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2}"
model="${SPARK_TEXT_MODEL:-nvidia/Qwen3.6-35B-A3B-NVFP4}"
name="${SPARK_TEXT_CONTAINER:-life-interview-spark-text}"
# Keep lower context/concurrency than NVIDIA's 262K/4-sequence default because this
# deployment concurrently hosts Coach, Voice and Retriever in DGX Spark UMA.
max_len="${SPARK_TEXT_MAX_MODEL_LEN:-32768}"
gpu_util="${SPARK_TEXT_GPU_MEMORY_UTILIZATION:-0.40}"
max_seqs="${SPARK_TEXT_MAX_NUM_SEQS:-2}"
max_batched_tokens="${SPARK_TEXT_MAX_NUM_BATCHED_TOKENS:-4096}"
async_scheduling="${SPARK_TEXT_ASYNC_SCHEDULING:-false}"

spec="$(spec_hash "$image" "$model" "$max_len" "$gpu_util" "$max_seqs" "$max_batched_tokens" "$async_scheduling" "$SPARK_TEXT_PORT")"

case "${1:-status}" in
  prefetch)
    docker_pull_cached "$image"
    hf_prefetch_cache "$model"
    ;;
  start)
    reconcile_container_spec "$name" "$spec"
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_TEXT_PORT/health" "${SPARK_TEXT_START_TIMEOUT_S:-1800}"
      exit 0
    fi
    if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
      docker start "$name" >/dev/null
    else
      args=(run -d --name "$name" --label "life-interview.spark.spec=$spec" --gpus all --ipc host
        --ulimit memlock=-1 --ulimit stack=67108864
        -p "$SPARK_TEXT_PORT:8000"
        -v "$HF_HOME:/root/.cache/huggingface"
        --entrypoint "")
      [[ -n "${HF_TOKEN:-}" ]] && args+=(-e HF_TOKEN)
      scheduling_flag=--no-async-scheduling
      [[ "$async_scheduling" == "true" ]] && scheduling_flag=--async-scheduling
      docker "${args[@]}" "$image" vllm serve "$model"         --served-model-name "$model"         --max-model-len "$max_len"         --gpu-memory-utilization "$gpu_util"         --dtype auto         --quantization modelopt         --kv-cache-dtype fp8         --attention-backend flashinfer         --moe-backend marlin         --max-num-seqs "$max_seqs"         --max-num-batched-tokens "$max_batched_tokens"         --enable-chunked-prefill         "$scheduling_flag"         --enable-prefix-caching         --enable-auto-tool-choice         --tool-call-parser qwen3_coder         --reasoning-parser qwen3         --load-format fastsafetensors         --disable-log-requests
    fi
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_TEXT_PORT/health" "${SPARK_TEXT_START_TIMEOUT_S:-1800}"
    ;;
  stop) docker stop "$name" >/dev/null 2>&1 || true ;;
  status)
    curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_TEXT_PORT/health" >/dev/null 2>&1       && echo RUNNING || echo STOPPED
    ;;
  *) echo "usage: $0 {prefetch|start|stop|status}" >&2; exit 2 ;;
esac
