#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

ensure_product_dirs
"$DIR/services/backend.sh" start
"$DIR/services/observer.sh" start
"$DIR/status.sh"
