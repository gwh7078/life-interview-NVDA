#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

dry_run=0
restart_product=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --no-restart) restart_product=0 ;;
    *) echo "usage: $0 [--dry-run] [--no-restart]" >&2; exit 2 ;;
  esac
done

if (( dry_run )); then
  printf '%s\n' \
    "Spark Product update plan:" \
    "  verify the recorded Spark Base fingerprint (fail with bootstrap instructions if incompatible)" \
    "  sync changed project dependencies and migrate the persistent Spark SQLite database" \
    "  validate Product configuration and TypeScript" \
    "  sync changed formal Skills and Product Agent configuration" \
    "  ensure changed Retriever collections and Era index data" \
    "  restart Backend/Web and Observer only"
  exit 0
fi

# Create only the two local signing secrets before common.sh imports the Spark env.
env_file="${SPARK_ENV_FILE:-$DIR/.env}"
if [[ -f "$env_file" ]]; then
  python3 - "$env_file" <<'PY'
from pathlib import Path
import secrets,sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines()
keys=("AUTH_SESSION_SECRET","AGENT_RETRIEVAL_TOKEN_SECRET")
seen=set(); out=[]
for line in lines:
    key,sep,value=line.partition("=")
    if sep and key in keys:
        seen.add(key)
        if not value.strip(): line=key+"="+secrets.token_urlsafe(48)
    out.append(line)
for key in keys:
    if key not in seen: out.append(key+"="+secrets.token_urlsafe(48))
tmp=p.with_suffix(p.suffix+".tmp")
tmp.write_text("\n".join(out)+"\n")
tmp.chmod(0o600); tmp.replace(p); p.chmod(0o600)
PY
fi

. "$DIR/lib/common.sh"

backend_was_running=0
observer_was_running=0
product_stopped=0
database_migration_incomplete=0
finish_update() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 && product_stopped )); then
    if (( database_migration_incomplete )); then
      warn "Persistent database migration did not complete; Product processes remain stopped to avoid switching databases."
    else
      (( backend_was_running )) && "$DIR/services/backend.sh" start >/dev/null 2>&1 || true
      (( observer_was_running )) && "$DIR/services/observer.sh" start >/dev/null 2>&1 || true
    fi
  fi
  exit "$rc"
}
trap finish_update EXIT

base_marker="$SPARK_STATE_DIR/base.fingerprint"
expected_base="$(spark_base_fingerprint)"
recorded_base="$(cat "$base_marker" 2>/dev/null || true)"
[[ -n "$recorded_base" && "$recorded_base" == "$expected_base" ]] || die \
  "Spark Base is missing or incompatible with this checkout/config. Run ./deploy/spark/bootstrap.sh (Base upgrades only)."

validate_product_config() {
  [[ "${DEPLOYMENT_PROFILE:-}" == "spark" ]] || die "DEPLOYMENT_PROFILE must be spark."
  [[ -n "${DATABASE_PATH:-}" ]] || die "DATABASE_PATH is required."
  [[ -n "${TEXT_MODEL_BASE_URL:-}" ]] || die "TEXT_MODEL_BASE_URL is required."
  [[ -n "${REALTIME_COACH_BASE_URL:-}" ]] || die "REALTIME_COACH_BASE_URL is required."
  [[ -n "${STEPAUDIO2_LOCAL_WS_URL:-}" ]] || die "STEPAUDIO2_LOCAL_WS_URL is required."
  [[ -n "${NEMO_RETRIEVER_BASE_URL:-}" ]] || die "NEMO_RETRIEVER_BASE_URL is required."
  [[ -n "${NEMOCLAW_SANDBOX:-}" ]] || die "NEMOCLAW_SANDBOX is required."
}

validate_product_config
backend_was_running=0; pid_running backend && backend_was_running=1
observer_was_running=0; pid_running observer && observer_was_running=1
product_stopped=1
"$DIR/services/backend.sh" stop
"$DIR/services/observer.sh" stop

migrate_legacy_database() {
  [[ -n "${SPARK_LEGACY_DATABASE_PATH:-}" ]] || return 0
  local marker="$SPARK_STATE_DIR/legacy-database-$(spec_hash "$SPARK_LEGACY_DATABASE_PATH" "$DATABASE_PATH").fingerprint"
  if [[ -f "$marker" ]]; then
    [[ -f "$DATABASE_PATH" ]] || die \
      "Legacy database migration was completed but the persistent database is missing; refusing to recreate it from the retained legacy copy."
    log "SKIP legacy database migration (already copied into persistent SPARK_HOME)."
    return 0
  fi
  [[ -f "$SPARK_LEGACY_DATABASE_PATH" ]] || return 0
  python3 - "$SPARK_LEGACY_DATABASE_PATH" "$DATABASE_PATH" <<'PY'
import filecmp, os, sqlite3, sys, tempfile
from pathlib import Path
source,target=map(Path,sys.argv[1:])
if target.exists():
    if filecmp.cmp(source,target,shallow=False):
        print("Legacy and persistent Spark database files already match.")
        raise SystemExit(0)
    print(f"Both legacy and persistent databases exist; preserved both. Select the intended DATABASE_PATH manually: {target}",file=sys.stderr)
    raise SystemExit(1)
target.parent.mkdir(parents=True,exist_ok=True)
fd,tmp=tempfile.mkstemp(prefix=target.name+".",suffix=".tmp",dir=target.parent)
os.close(fd)
try:
    src=sqlite3.connect(f"file:{source}?mode=ro",uri=True)
    dst=sqlite3.connect(tmp)
    src.backup(dst)
    result=dst.execute("PRAGMA integrity_check").fetchone()[0]
    dst.close(); src.close()
    if result!="ok": raise RuntimeError("SQLite integrity_check failed")
    os.chmod(tmp,0o600)
    os.replace(tmp,target)
except Exception:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
    raise
print(f"Copied legacy Spark database to persistent SPARK_HOME; original retained at {source}.")
PY
  printf '%s\n' "$SPARK_LEGACY_DATABASE_PATH -> $DATABASE_PATH" >"$marker"
  chmod 600 "$marker"
}

sync_dependencies() {
  local npm_spec nat_spec npm_marker nat_marker
  npm_spec="$(spark_path_fingerprint package.json package-lock.json)"
  nat_spec="$(spark_path_fingerprint nvidia/nat/pyproject.toml nvidia/nat/uv.lock)"
  npm_marker="$SPARK_STATE_DIR/product-npm-dependencies.fingerprint"
  nat_marker="$SPARK_STATE_DIR/product-nat-dependencies.fingerprint"
  if [[ ! -d "$REPO_ROOT/node_modules" || "$(cat "$npm_marker" 2>/dev/null || true)" != "$npm_spec" ]]; then
    log "Syncing changed/missing project dependencies."
    (cd "$REPO_ROOT" && bash scripts/codex-node.sh npm ci)
    printf '%s\n' "$npm_spec" >"$npm_marker"
  else
    log "SKIP project dependencies (lockfiles unchanged)."
  fi
  if [[ ! -x "$UV_PROJECT_ENVIRONMENT/bin/nat" || "$(cat "$nat_marker" 2>/dev/null || true)" != "$nat_spec" ]]; then
    log "Syncing changed/missing NAT product dependencies into SPARK_HOME."
    (cd "$REPO_ROOT" && uv sync --project nvidia/nat)
    printf '%s\n' "$nat_spec" >"$nat_marker"
  else
    log "SKIP NAT dependencies (lockfiles unchanged)."
  fi
}

if [[ -n "${SPARK_LEGACY_DATABASE_PATH:-}" ]]; then
  database_migration_incomplete=1
  migrate_legacy_database
  database_migration_incomplete=0
fi
sync_dependencies
(cd "$REPO_ROOT" && bash scripts/codex-node.sh npm run db:migrate)
(cd "$REPO_ROOT" && bash scripts/codex-node.sh npm run typecheck)

"$DIR/services/nemoclaw.sh" sync-skills
"$DIR/services/nemoclaw.sh" configure-product
"$DIR/services/nemoclaw.sh" apply-policy

collection_marker="$SPARK_RETRIEVER_DATA_DIR/.spark-collections.fingerprint"
collection_spec="$(spec_hash "${NEMO_RETRIEVER_BASE_URL:-}" "${NEMO_RETRIEVER_COLLECTION:-}" "${NEMO_ERA_CONTEXT_COLLECTION:-}")"
if [[ "${NEMO_RETRIEVER_ENABLED:-false}" == "true" && "$(cat "$collection_marker" 2>/dev/null || true)" != "$collection_spec" ]]; then
  "$DIR/services/retriever.sh" ensure-collections
  printf '%s\n' "$collection_spec" >"$collection_marker"
fi

if [[ "${NEMO_ERA_CONTEXT_ENABLED:-false}" == "true" ]]; then
  era_marker="$SPARK_STATE_DIR/era-index.fingerprint"
  era_spec="$(spark_path_fingerprint data/era-context scripts/index-era-context.ts src/era-context)"
  era_spec="$(spec_hash "$era_spec" "${NEMO_RETRIEVER_BASE_URL:-}" "${NEMO_ERA_CONTEXT_COLLECTION:-}" "${NEMO_ERA_CONTEXT_ENABLED:-}")"
  if [[ "$(cat "$era_marker" 2>/dev/null || true)" != "$era_spec" ]]; then
    [[ "$("$DIR/services/retriever.sh" status)" == "RUNNING" ]] || die \
      "Era dataset changed but Retriever Runtime is not ready; start Retriever, then rerun update.sh."
    (cd "$REPO_ROOT" && bash scripts/codex-node.sh npm run era:index)
    printf '%s\n' "$era_spec" >"$era_marker"
  else
    log "SKIP Era index (dataset/runtime inputs unchanged)."
  fi
fi

if (( restart_product )); then
  "$DIR/services/backend.sh" start
  "$DIR/services/observer.sh" start
  product_stopped=0
else
  log "Product processes remain stopped for the install orchestration."
  product_stopped=0
fi
log "Spark Product update complete."
