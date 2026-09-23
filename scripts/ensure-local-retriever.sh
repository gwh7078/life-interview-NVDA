#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

retriever_url="${NEMO_RETRIEVER_BASE_URL:-http://127.0.0.1:7670}"
vectordb_url="${NEMO_RETRIEVER_VECTORDB_URL:-http://127.0.0.1:7671}"

if [[ "$(uname -s)" == "Darwin" ]]; then
  bash scripts/install-local-retriever-service.sh
fi

env -i PATH="$PATH" python3 - "$retriever_url" "$vectordb_url" <<'PY'
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

retriever, vectordb = (value.rstrip("/") for value in sys.argv[1:3])
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
targets = {
    "NeMo Retriever": retriever + "/v1/health",
    "VectorDB": vectordb + "/v1/health",
}
last_errors = {}
deadline = time.monotonic() + 60

while True:
    ready = True
    for name, url in targets.items():
        if urlparse(url).hostname not in {"127.0.0.1", "localhost", "::1"}:
            last_errors[name] = "expected a loopback URL"
            ready = False
            continue
        try:
            with opener.open(url, timeout=2) as response:
                if response.status != 200:
                    last_errors[name] = f"HTTP {response.status}"
                    ready = False
                else:
                    last_errors.pop(name, None)
        except (OSError, urllib.error.URLError) as exc:
            last_errors[name] = type(exc).__name__
            ready = False
    if ready:
        print("[OK] NeMo Retriever and VectorDB are healthy.")
        break
    if time.monotonic() >= deadline:
        for name, error in last_errors.items():
            print(f"[FAIL] {name}: {error}")
        raise SystemExit(1)
    time.sleep(1)
PY
