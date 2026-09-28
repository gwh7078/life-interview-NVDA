#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

case "${1:-ensure-collections}" in
  ensure-collections)
    [[ "${NEMO_RETRIEVER_ENABLED:-false}" == true ]] || die "Set NEMO_RETRIEVER_ENABLED=true for the Spark profile."
    base="${NEMO_RETRIEVER_BASE_URL%/}"
    [[ -n "$base" ]] || die "NEMO_RETRIEVER_BASE_URL is required."
    "$DIR/lib/wait-for.sh" "$base/v1/health" "${NEMO_RETRIEVER_READY_TIMEOUT_S:-90}"
    python3 - "$base" "${NEMO_RETRIEVER_COLLECTION:-life-interview-transcripts}" \
      "${NEMO_ERA_CONTEXT_COLLECTION:-life-interview-era-context-v1}" <<'PY'
import json, os, sys, urllib.error, urllib.parse, urllib.request

base=sys.argv[1].rstrip("/")
token=os.environ.get("NEMO_RETRIEVER_API_TOKEN", "")
headers={"content-type":"application/json"}
if token:
    headers["authorization"]="Bearer "+token
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
collections=[
    (sys.argv[2], "Life Interview private transcript index."),
    (sys.argv[3], "Life Interview public era context index."),
]
for name, description in collections:
    encoded=urllib.parse.quote(name, safe="")
    request=urllib.request.Request(base+"/v1/collections/"+encoded, headers=headers)
    try:
        with opener.open(request, timeout=15):
            continue
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    request=urllib.request.Request(
        base+"/v1/collections",
        data=json.dumps({"name": name, "description": description}).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with opener.open(request, timeout=30):
            pass
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
print("Application Retriever collections are ready.")
PY
    ;;
  *) echo "usage: $0 ensure-collections" >&2; exit 2 ;;
esac
