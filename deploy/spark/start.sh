#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib/common.sh"

log "Starting DGX Spark deployment profile."
"$DIR/models/post-session.sh" start
"$DIR/models/coach.sh" start
"$DIR/services/retriever.sh" start
"$DIR/services/nemoclaw.sh" start
"$DIR/models/realtime.sh" start
"$DIR/services/backend.sh" start
"$DIR/services/observer.sh" start
"$DIR/status.sh"
