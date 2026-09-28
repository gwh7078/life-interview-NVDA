#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib/common.sh"

"$DIR/services/observer.sh" stop || true
"$DIR/services/backend.sh" stop || true
"$DIR/models/realtime.sh" stop || true
"$DIR/services/nemoclaw.sh" stop || true
"$DIR/services/retriever.sh" stop || true
"$DIR/models/coach.sh" stop || true
"$DIR/models/post-session.sh" stop || true
"$DIR/status.sh"
