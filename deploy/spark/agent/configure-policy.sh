#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

have nemoclaw || die "NemoClaw/OpenClaw Agent Runtime is not ready; prepare it before application setup."
[[ -n "${NEMOCLAW_SANDBOX:-}" ]] || die "NEMOCLAW_SANDBOX is not configured."
sandbox="$NEMOCLAW_SANDBOX"
host_ip="$(safe_host_ip)"
[[ "$host_ip" != 127.0.0.1 ]] || die "Could not determine a private host address for retrieval policy access."

mkdir -p "$SPARK_DIAGNOSTICS_DIR"
policy_file="$(mktemp "$SPARK_DIAGNOSTICS_DIR/.life-interview-retrieval-api.XXXXXX")"
policy_yaml="${policy_file}.yaml"
trap 'rm -f "$policy_file" "$policy_yaml"' EXIT
python3 - "$DIR/services/retrieval-policy.yaml.template" "$policy_file" "$host_ip" "$SPARK_AGENT_RETRIEVAL_PORT" <<'PY'
from pathlib import Path
import sys
source, destination, host, port = sys.argv[1:]
content = Path(source).read_text(encoding="utf-8")
Path(destination).write_text(content.replace("__HOST__", host).replace("__PORT__", port), encoding="utf-8")
PY
chmod 600 "$policy_file"
mv "$policy_file" "$policy_yaml"
nemoclaw "$sandbox" policy add --from-file "$policy_yaml" \
  --trusted-private-host "$host_ip" --yes
echo "Installed the application retrieval policy for $host_ip:$SPARK_AGENT_RETRIEVAL_PORT."
