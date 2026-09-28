#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"

image="${SPARK_BASE_VLLM_IMAGE:-${SPARK_VLLM_IMAGE:-nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2}}"
docker image inspect "$image" >/dev/null 2>&1 || {
  echo "Required cached image is missing: $image" >&2
  exit 1
}
docker run --rm --gpus all --entrypoint python "$image" -c '
import json
import torch
if not torch.cuda.is_available():
    raise SystemExit("torch.cuda.is_available() is false inside Docker")
print(json.dumps({
    "cuda_available": True,
    "device_count": torch.cuda.device_count(),
    "device_name": torch.cuda.get_device_name(0),
}))
'
