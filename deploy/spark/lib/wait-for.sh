#!/usr/bin/env bash
set -euo pipefail
url="${1:?usage: wait-for.sh URL [timeout_seconds]}"
timeout="${2:-120}"
python3 - "$url" "$timeout" <<'PY'
import os, sys, time, urllib.error, urllib.request
from urllib.parse import urlparse

url, timeout = sys.argv[1], float(sys.argv[2])
token = os.environ.get("NEMO_RETRIEVER_API_TOKEN", "")
headers = {"authorization": "Bearer " + token} if token else {}
deadline = time.monotonic() + timeout
opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if urlparse(url).hostname in {"127.0.0.1","localhost","::1"} else urllib.request.build_opener()
last = "unreachable"
while time.monotonic() < deadline:
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=3) as r:
            if 200 <= r.status < 500:
                print(f"ready: {url} HTTP {r.status}")
                raise SystemExit(0)
            last = f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        if 200 <= e.code < 500:
            print(f"ready: {url} HTTP {e.code}")
            raise SystemExit(0)
        last = f"HTTP {e.code}"
    except Exception as e:
        last = type(e).__name__
    time.sleep(1)
print(f"timeout: {url} ({last})", file=sys.stderr)
raise SystemExit(1)
PY
