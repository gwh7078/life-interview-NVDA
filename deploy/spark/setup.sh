#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -f "$DIR/.env" ]]; then
  cp "$DIR/env.example" "$DIR/.env"
  chmod 600 "$DIR/.env"
  echo "Created deploy/spark/.env from env.example. Review served model IDs before continuing."
fi
chmod 600 "$DIR/.env"

# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

validate_product_config() {
  [[ "$DEPLOYMENT_PROFILE" == spark ]] || die "DEPLOYMENT_PROFILE must be spark."
  [[ "${TEXT_MODEL_PROVIDER:-}" == openai-compatible ]] || die "TEXT_MODEL_PROVIDER must be openai-compatible."
  [[ -n "${TEXT_MODEL_BASE_URL:-}" && -n "${TEXT_MODEL:-}" ]] || die "TEXT_MODEL_BASE_URL and TEXT_MODEL are required."
  [[ "${AGENT_MODEL_BASE_URL:-}" == "$TEXT_MODEL_BASE_URL" ]] || die "AGENT_MODEL_BASE_URL must match TEXT_MODEL_BASE_URL."
  [[ "${AGENT_MODEL_DEFAULT:-}" == "$TEXT_MODEL" ]] || die "AGENT_MODEL_DEFAULT must match the served TEXT_MODEL."
  [[ "${REALTIME_COACH_PROVIDER:-}" == openai-compatible ]] || die "REALTIME_COACH_PROVIDER must be openai-compatible."
  [[ -n "${REALTIME_COACH_BASE_URL:-}" && -n "${REALTIME_COACH_MODEL:-}" ]] || die "Coach endpoint and served model are required."
  [[ "${STEPAUDIO2_EXECUTION:-}" == local && -n "${STEPAUDIO2_LOCAL_WS_URL:-}" ]] || die "Configure the operator-managed local StepAudio WebSocket endpoint."
  [[ "${NEMO_RETRIEVER_ENABLED:-}" == true && -n "${NEMO_RETRIEVER_BASE_URL:-}" ]] || die "Configure the operator-managed NeMo Retriever endpoint."
  [[ "${AI_TASK_RUNTIME:-}" == agent && -n "${NEMOCLAW_SANDBOX:-}" ]] || die "Spark requires AI_TASK_RUNTIME=agent and NEMOCLAW_SANDBOX."
  [[ "${SPARK_SEED_DEMO_DATA:-false}" == true || "${SPARK_SEED_DEMO_DATA:-false}" == false ]] \
    || die "SPARK_SEED_DEMO_DATA must be true or false."
}

validate_product_config
"$DIR/check-env.sh" || die "External Runtime or DGX Spark prerequisites are not ready. See the CHECK output above."
ensure_product_dirs

# Keep local signing secrets in the ignored, owner-only profile file.
python3 - "$DIR/.env" <<'PY'
from pathlib import Path
import secrets, sys

path = Path(sys.argv[1])
keys = ("AUTH_SESSION_SECRET", "AGENT_RETRIEVAL_TOKEN_SECRET")
lines = path.read_text(encoding="utf-8").splitlines()
found = set()
updated = []
for line in lines:
    key, separator, value = line.partition("=")
    if separator and key in keys:
        found.add(key)
        if not value.strip():
            line = f"{key}={secrets.token_urlsafe(48)}"
    updated.append(line)
for key in keys:
    if key not in found:
        updated.append(f"{key}={secrets.token_urlsafe(48)}")
path.write_text("\n".join(updated) + "\n", encoding="utf-8")
path.chmod(0o600)
PY
set -a
# shellcheck disable=SC1091
. "$DIR/.env"
set +a

# Keep a previous checkout-local database if this is its first move to SPARK_HOME.
legacy_database="$REPO_ROOT/data/memoir.db"
if [[ "$legacy_database" != "$DATABASE_PATH" && -f "$legacy_database" && ! -e "$DATABASE_PATH" ]]; then
  python3 - "$legacy_database" "$DATABASE_PATH" <<'PY'
import os, sqlite3, sys, tempfile
from pathlib import Path

source, target = map(Path, sys.argv[1:])
target.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
os.close(fd)
try:
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as original, sqlite3.connect(temporary) as copy:
        original.backup(copy)
        if copy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite integrity_check failed")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
except Exception:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
print(f"Preserved existing database at {source}; copied it to {target}.")
PY
elif [[ -f "$legacy_database" && -f "$DATABASE_PATH" && "$legacy_database" != "$DATABASE_PATH" ]]; then
  warn "Both checkout-local and persistent databases exist; keeping both and using DATABASE_PATH."
fi

cd "$REPO_ROOT"
bash scripts/codex-node.sh npm ci
bash scripts/codex-node.sh npm run typecheck
bash scripts/codex-node.sh npm run db:migrate
if [[ "${SPARK_SEED_DEMO_DATA:-false}" == true ]]; then
  bash scripts/codex-node.sh npm run db:seed
else
  log "Demo data seed skipped (set SPARK_SEED_DEMO_DATA=true to opt in)."
fi

"$DIR/services/retriever.sh" ensure-collections
bash scripts/codex-node.sh npm run era:dataset:validate
if [[ "${NEMO_ERA_CONTEXT_ENABLED:-false}" == true ]]; then
  bash scripts/codex-node.sh npm run era:index
fi

"$DIR/agent/install-nemoclaw.sh"
"$DIR/agent/configure-runtime.sh"
"$DIR/agent/sync-skills.sh"
"$DIR/agent/configure-policy.sh"

echo "Spark application setup complete. Start the Product services with ./deploy/spark/start.sh."
