#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

image="${SPARK_RETRIEVER_IMAGE:-nvcr.io/nvidia/nemo-microservices/nrl-service:26.8.2@sha256:6b93a1f4224387e57c3b0c5241c4a1496c57fd7c2d1f789b9e29db818a9504c1}"
name="${SPARK_RETRIEVER_CONTAINER:-life-interview-spark-retriever}"
data_dir="${SPARK_RETRIEVER_DATA_DIR:-$SPARK_RUNTIME_DIR/retriever}"
mkdir -p "$data_dir"
token_fingerprint="$(printf '%s' "${NEMO_RETRIEVER_API_TOKEN:-}" | sha256sum | awk '{print $1}')"
spec="$(spec_hash "$image" "$data_dir" "$token_fingerprint" "$SPARK_RETRIEVER_PORT" "$SPARK_VECTORDB_PORT")"

case "${1:-status}" in
  prefetch) docker_pull_cached "$image" ;;
  start)
    reconcile_container_spec "$name" "$spec"
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_RETRIEVER_PORT/v1/health" "${SPARK_RETRIEVER_START_TIMEOUT_S:-900}"
      "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_VECTORDB_PORT/v1/health" "${SPARK_RETRIEVER_START_TIMEOUT_S:-900}"
      exit 0
    fi
    docker rm "$name" >/dev/null 2>&1 || true
    args=(run -d --name "$name" --label "life-interview.spark.spec=$spec" --gpus all --network host -v "$data_dir:/data" -w /data)
    [[ -n "${NVIDIA_API_KEY:-}" ]] && args+=(-e NVIDIA_API_KEY)
    [[ -n "${NGC_API_KEY:-}" ]] && args+=(-e NGC_API_KEY)
    [[ -n "${NEMO_RETRIEVER_API_TOKEN:-}" ]] && args+=(-e NRL_API_TOKEN="$NEMO_RETRIEVER_API_TOKEN")
    docker "${args[@]}" --entrypoint /bin/bash "$image" -lc '
      set -e
      cfg="$(find /workspace -type f -name retriever-service.local.yaml 2>/dev/null | head -1)"
      if [ -z "$cfg" ]; then echo "retriever-service.local.yaml not found in image" >&2; exit 42; fi
      exec retriever service start --config "$cfg" --launch-vectordb
    '
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_RETRIEVER_PORT/v1/health" "${SPARK_RETRIEVER_START_TIMEOUT_S:-900}"
    "$DIR/lib/wait-for.sh" "http://127.0.0.1:$SPARK_VECTORDB_PORT/v1/health" "${SPARK_RETRIEVER_START_TIMEOUT_S:-900}"
    python3 - "http://127.0.0.1:$SPARK_RETRIEVER_PORT" "${NEMO_RETRIEVER_COLLECTION:-life-interview-transcripts}" "${NEMO_ERA_CONTEXT_COLLECTION:-life-interview-era-context-v1}" <<'PY'
import json,sys,urllib.error,urllib.request
base=sys.argv[1].rstrip("/")
token=__import__("os").environ.get("NEMO_RETRIEVER_API_TOKEN","")
headers={"content-type":"application/json",**({"authorization":"Bearer "+token} if token else {})}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for name,description in [(sys.argv[2],"Life Interview private transcript index."),(sys.argv[3],"Life Interview public era context index.")]:
    req=urllib.request.Request(base+"/v1/collections",data=json.dumps({"name":name,"description":description}).encode(),headers=headers,method="POST")
    try:
        with opener.open(req,timeout=15): pass
    except urllib.error.HTTPError as e:
        if e.code!=409: raise
PY
    ;;
  stop) docker stop "$name" >/dev/null 2>&1 || true ;;
  status)
    if curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_RETRIEVER_PORT/v1/health" >/dev/null 2>&1       && curl -fsS --noproxy '*' "http://127.0.0.1:$SPARK_VECTORDB_PORT/v1/health" >/dev/null 2>&1; then echo RUNNING; else echo STOPPED; fi
    ;;
  *) echo "usage: $0 {prefetch|start|stop|status}" >&2; exit 2 ;;
esac
