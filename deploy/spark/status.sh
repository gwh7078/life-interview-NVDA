#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib/common.sh"

state() {
  local value
  value="$("$@" 2>/dev/null | tail -1 || true)"
  case "$value" in RUNNING|DEGRADED|STOPPED|UNKNOWN) printf '%s' "$value" ;; *) printf 'UNKNOWN' ;; esac
}
printf '%-16s %s\n' "SERVICE" "STATE"
printf '%-16s %s\n' "Text Model" "$(state "$DIR/models/post-session.sh" status)"
printf '%-16s %s\n' "Coach" "$(state "$DIR/models/coach.sh" status)"
printf '%-16s %s\n' "Step-Audio" "$(state "$DIR/models/realtime.sh" status)"
printf '%-16s %s\n' "Retriever" "$(state "$DIR/services/retriever.sh" status)"
printf '%-16s %s\n' "NemoClaw" "$(state "$DIR/services/nemoclaw.sh" status)"
printf '%-16s %s\n' "OpenClaw" "$(state "$DIR/services/nemoclaw.sh" openclaw-status)"
printf '%-16s %s\n' "Backend" "$(state "$DIR/services/backend.sh" status)"
printf '%-16s %s\n' "Web" "$(state "$DIR/services/backend.sh" status)"
printf '%-16s %s\n' "NAT" "$(state "$DIR/services/nat.sh" status)"
printf '%-16s %s\n' "Observer" "$(state "$DIR/services/observer.sh" status)"
