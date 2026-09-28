#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

mode="${1:-ensure}"
if [[ "$mode" == "--dry-run" ]]; then
  printf '%s\n' \
    "Spark Base bootstrap plan:" \
    "  validate ARM64/GPU/Docker host" \
    "  install project-compatible Node, Python/uv tools under SPARK_HOME" \
    "  prepare the generic vLLM GPU runtime image" \
    "  ensure NemoClaw CLI/OpenShell sandbox" \
    "  keep product dependencies, model weights, Skills, migrations and indexes outside Base"
  exit 0
fi

. "$DIR/lib/common.sh"

if [[ "$mode" == "fingerprint" ]]; then
  spark_base_fingerprint
  exit 0
fi
[[ "$mode" == "ensure" || "$mode" == "upgrade" ]] || {
  echo "usage: $0 [ensure|upgrade|fingerprint|--dry-run]" >&2
  exit 2
}

marker="$SPARK_STATE_DIR/base.fingerprint"
fingerprint="$(spark_base_fingerprint)"
recorded="$(cat "$marker" 2>/dev/null || true)"
if [[ "$recorded" == "$fingerprint" ]]; then
  log "Spark Base fingerprint matches; checking idempotent prerequisites."
else
  log "Spark Base inputs changed or are missing; running Base bootstrap/upgrade."
fi

"$DIR/preflight.sh" --report-only >"$SPARK_LOG_DIR/bootstrap-preflight.log" 2>&1 || {
  cat "$SPARK_LOG_DIR/bootstrap-preflight.log" >&2
  die "Spark host preflight could not run."
}
python3 - "$SPARK_DIAGNOSTICS_DIR/preflight.json" <<'PY'
import json,sys
from pathlib import Path
checks=json.loads(Path(sys.argv[1]).read_text())['checks']
required=('architecture_arm64','nvidia_gpu','docker','python','python_venv','system_tools')
failed=[name for name in required if checks.get(name,{}).get('status')!='PASS']
if failed:
    print('Base host checks failed: '+', '.join(failed),file=sys.stderr)
    raise SystemExit(1)
PY

"$DIR/lib/install-node.sh" >>"$SPARK_LOG_DIR/bootstrap-tools.log" 2>&1 || {
  tail -80 "$SPARK_LOG_DIR/bootstrap-tools.log" >&2 || true
  die "Could not prepare the compatible Node.js toolchain."
}
uv_root="$SPARK_HOME/tools/uv"
uv_python="$uv_root/bin/python"
if [[ ! -x "$uv_root/bin/uv" ]]; then
  python3 -m venv "$uv_root"
  "$uv_python" -m pip install --quiet --upgrade pip
  if [[ "${SPARK_UV_VERSION:-0.12.19}" == "latest" ]]; then
    "$uv_python" -m pip install --quiet --upgrade uv
  else
    "$uv_python" -m pip install --quiet --upgrade "uv==$SPARK_UV_VERSION"
  fi
elif [[ "${SPARK_UV_VERSION:-0.12.19}" != "latest" && "$("$uv_root/bin/uv" --version | awk '{print $2}')" != "$SPARK_UV_VERSION" ]]; then
  "$uv_python" -m pip install --quiet --upgrade "uv==$SPARK_UV_VERSION"
fi

export PATH="$SPARK_HOME/tools/node/bin:$uv_root/bin:$PATH"
[[ -n "$SPARK_BASE_VLLM_IMAGE" ]] || die "SPARK_BASE_VLLM_IMAGE is required for the model-independent Docker GPU check."
docker_pull_cached "$SPARK_BASE_VLLM_IMAGE"
"$DIR/lib/docker-gpu-smoke.sh" >>"$SPARK_LOG_DIR/bootstrap-gpu-smoke.log" 2>&1 || {
  tail -80 "$SPARK_LOG_DIR/bootstrap-gpu-smoke.log" >&2 || true
  die "Docker could not access the Spark GPU with the Base runtime image."
}
"$DIR/services/nemoclaw.sh" ensure-base >>"$SPARK_LOG_DIR/bootstrap-nemoclaw.log" 2>&1 || {
  tail -80 "$SPARK_LOG_DIR/bootstrap-nemoclaw.log" >&2 || true
  die "Could not prepare the NemoClaw/OpenShell Base."
}

printf '%s\n' "$fingerprint" >"$marker"
log "Spark Base ready at $SPARK_HOME."
