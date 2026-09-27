#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"

image="${SPARK_VLLM_IMAGE:-vllm/vllm-openai:v0.28.0}"
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
