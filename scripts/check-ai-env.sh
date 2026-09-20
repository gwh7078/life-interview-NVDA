#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
if [ ! -f "$ENV_FILE" ] && [ -f "$ROOT_DIR/.env.local" ]; then
  ENV_FILE="$ROOT_DIR/.env.local"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

NEMO_RETRIEVER_BASE_URL="${NEMO_RETRIEVER_BASE_URL:-http://127.0.0.1:7670}"
NEMO_RETRIEVER_VECTORDB_URL="${NEMO_RETRIEVER_VECTORDB_URL:-http://127.0.0.1:7671}"
OPENCLAW_SANDBOX_URL="${OPENCLAW_SANDBOX_URL:-http://127.0.0.1:18790}"

http_status=0
python3 - "$NEMO_RETRIEVER_BASE_URL" "$NEMO_RETRIEVER_VECTORDB_URL" "$OPENCLAW_SANDBOX_URL" <<'PY' || http_status=$?
import json
import sys
import urllib.error
import urllib.request

retriever, vectordb, openclaw = sys.argv[1:4]

def check_json(name, url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            body = response.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body)
                body = json.dumps(parsed, ensure_ascii=False)
            except json.JSONDecodeError:
                pass
            print(f"[OK] {name}: HTTP {response.status} {body[:300]}")
            return True
    except Exception as exc:
        print(f"[FAIL] {name}: {exc}")
        return False

ok = True
ok &= check_json("NeMo Retriever", retriever.rstrip("/") + "/v1/health")
ok &= check_json("Retriever VectorDB", vectordb.rstrip("/") + "/v1/health")

try:
    req = urllib.request.Request(openclaw, method="GET")
    with urllib.request.urlopen(req, timeout=3) as response:
        print(f"[OK] OpenClaw sandbox forward: HTTP {response.status} {openclaw}")
except urllib.error.HTTPError as exc:
    # 4xx 仍能证明 OpenClaw HTTP 服务已监听；具体路由可能要求 token、Host 或其他参数。
    if 400 <= exc.code < 500:
        print(f"[OK] OpenClaw sandbox forward reachable: HTTP {exc.code}")
    else:
        print(f"[FAIL] OpenClaw sandbox forward: HTTP {exc.code}")
        ok = False
except Exception as exc:
    print(f"[FAIL] OpenClaw sandbox forward: {exc}")
    ok = False

sys.exit(0 if ok else 1)
PY

if command -v codex >/dev/null 2>&1; then
  if codex mcp get nemo-retriever-local >/dev/null 2>&1; then
    echo "[OK] Codex MCP: nemo-retriever-local 已注册"
  else
    echo "[FAIL] Codex MCP: nemo-retriever-local 未注册"
    exit 1
  fi
else
  echo "[WARN] 未找到 codex CLI，跳过 MCP 配置检查"
fi

if [ "$http_status" -ne 0 ]; then
  echo "[FAIL] AI HTTP environment check failed." >&2
  exit "$http_status"
fi

echo "[OK] 本地 AI 开发环境检查完成"
