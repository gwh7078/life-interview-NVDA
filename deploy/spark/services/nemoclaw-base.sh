#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

sandbox="${NEMOCLAW_SANDBOX:-my-assistant}"
model="$SPARK_TEXT_SERVED_MODEL"

install_cli() {
  if have nemoclaw; then return 0; fi
  log "Installing NemoClaw from NVIDIA official installer."
  NEMOCLAW_NO_EXPRESS=1 \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_YES=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_AGENT=openclaw \
  NEMOCLAW_PROVIDER=vllm \
  NEMOCLAW_MODEL="$model" \
  NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" \
  NEMOCLAW_SANDBOX_NAME="$sandbox" \
    bash -c 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash'
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  have nemoclaw || die "NemoClaw installer finished but nemoclaw is not on PATH."
}

sandbox_ready() {
  nemoclaw "$sandbox" status >/dev/null 2>&1
}

ensure_sandbox() {
  sandbox_ready && return 0
  log "Creating NemoClaw/OpenClaw sandbox '$sandbox'."
  NEMOCLAW_NO_EXPRESS=1 \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_YES=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_AGENT=openclaw \
  NEMOCLAW_PROVIDER=vllm \
  NEMOCLAW_MODEL="$model" \
  NEMOCLAW_VLLM_PORT="$SPARK_TEXT_PORT" \
  NEMOCLAW_SANDBOX_NAME="$sandbox" \
    nemoclaw onboard --non-interactive --no-gpu --name "$sandbox"
  sandbox_ready || die "NemoClaw sandbox '$sandbox' was not ready after onboarding."
}

install_cli
ensure_sandbox
