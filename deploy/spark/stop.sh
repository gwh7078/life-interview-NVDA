#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

failed=0
"$DIR/services/observer.sh" stop || failed=1
"$DIR/services/backend.sh" stop || failed=1
"$DIR/status.sh"
(( failed == 0 ))
