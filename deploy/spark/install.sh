#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then dry_run=1; fi

if (( dry_run )); then
  export SPARK_ENV_FILE="$DIR/env.example"
elif [[ ! -f "$DIR/.env" ]]; then
  cp "$DIR/env.example" "$DIR/.env"
  chmod 600 "$DIR/.env"
fi

. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"
report="$SPARK_DIAGNOSTICS_DIR/install-report.json"
events="$SPARK_DIAGNOSTICS_DIR/install-events.jsonl"
install_log="$SPARK_LOG_DIR/install.log"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
: > "$events"

current_install_fingerprint() {
  {
    git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'no-git\n'
    if [[ -f "$SPARK_ENV_FILE" ]]; then sha256sum "$SPARK_ENV_FILE"; else printf 'no-env\n'; fi
  } | sha256sum | awk '{print $1}'
}

record() {
  local name="$1" status="$2" duration="$3" message="${4:-}"
  python3 - "$events" "$name" "$status" "$duration" "$message" <<'PY'
import json,sys
path,name,status,duration,message=sys.argv[1:]
with open(path,"a",encoding="utf-8") as f:
    f.write(json.dumps({"step":name,"status":status,"duration_ms":int(duration),"message":message},ensure_ascii=False)+"\n")
PY
}

finalize() {
  local rc=$?
  python3 - "$report" "$events" "$started" "$dry_run" "$rc" <<'PY'
import json,sys,time
report,events,started,dry,rc=sys.argv[1:]
rows=[]
try:
    rows=[json.loads(x) for x in open(events,encoding="utf-8") if x.strip()]
except FileNotFoundError:
    pass
with open(report,"w",encoding="utf-8") as f:
    json.dump({"started_at":started,"finished_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
               "dry_run":dry=="1","exit_code":int(rc),"steps":rows},f,ensure_ascii=False,indent=2)
PY
  exit "$rc"
}
trap finalize EXIT

run_step() {
  local name="$1"; shift
  local marker="$SPARK_STATE_DIR/install-$name.ok"
  local install_fingerprint
  install_fingerprint="$(current_install_fingerprint)"
  if [[ -f "$marker" && "$name" != "preflight" && "$name" != "start-services" && "$name" != "verify" ]]; then
    local recorded
    recorded="$(cat "$marker" 2>/dev/null || true)"
    if [[ "$recorded" == "$install_fingerprint" ]]; then
      log "SKIP $name (already complete for current code/config)"
      record "$name" SKIPPED 0 "fingerprint match"
      return 0
    fi
  fi
  if (( dry_run )); then
    log "DRY-RUN $name: $*"
    record "$name" DRY_RUN 0 ""
    return 0
  fi
  local t0 t1
  t0="$(python3 -c 'import time; print(int(time.time()*1000))')"
  log "RUN $name"
  if "$@" >>"$install_log" 2>&1; then
    t1="$(python3 -c 'import time; print(int(time.time()*1000))')"
    [[ "$name" == "preflight" || "$name" == "start-services" || "$name" == "verify" ]] || printf '%s\n' "$install_fingerprint" > "$marker"
    record "$name" PASS "$((t1-t0))" ""
  else
    local rc=$?
    t1="$(python3 -c 'import time; print(int(time.time()*1000))')"
    record "$name" FAIL "$((t1-t0))" "see runtime/logs/spark/install.log"
    tail -80 "$install_log" >&2 || true
    return "$rc"
  fi
}

bootstrap_tools() {
  "$DIR/lib/install-node.sh"
  local uvroot="$SPARK_RUNTIME_DIR/tools/uv"
  if [[ ! -x "$uvroot/bin/uv" ]]; then
    python3 -m venv "$uvroot"
    "$uvroot/bin/python" -m pip install --quiet --upgrade pip uv
  fi
  export PATH="$SPARK_RUNTIME_DIR/tools/node/bin:$uvroot/bin:$PATH"
  # Build the shared Hugging Face helper venv once before parallel model prefetch
  # jobs begin; concurrent first-time venv creation is not reliable.
  ensure_tool_venv >/dev/null
  cd "$REPO_ROOT"
  npm ci
  uv sync --project nvidia/nat
}

ensure_local_secrets() {
  python3 - "$DIR/.env" <<'PY'
from pathlib import Path
import secrets,sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines()
keys=("AUTH_SESSION_SECRET","AGENT_RETRIEVAL_TOKEN_SECRET")
seen=set(); out=[]
for line in lines:
    for key in keys:
        if line.startswith(key+"="):
            seen.add(key)
            if not line.partition("=")[2].strip():
                line=key+"="+secrets.token_urlsafe(48)
            break
    out.append(line)
for key in keys:
    if key not in seen:
        out.append(key+"="+secrets.token_urlsafe(48))
p.write_text("\n".join(out)+"\n")
PY
  chmod 600 "$DIR/.env"
}

prefetch_all() {
  local jobs=() names=()
  for item in "text:$DIR/models/post-session.sh" "coach:$DIR/models/coach.sh" "voice:$DIR/models/realtime.sh" "retriever:$DIR/services/retriever.sh"; do
    local name="${item%%:*}" cmd="${item#*:}"
    "$cmd" prefetch >>"$SPARK_LOG_DIR/prefetch-$name.log" 2>&1 &
    jobs+=("$!"); names+=("$name")
  done
  local failed=0
  for i in "${!jobs[@]}"; do
    if ! wait "${jobs[$i]}"; then warn "prefetch failed: ${names[$i]}"; failed=1; fi
  done
  (( failed == 0 ))
}

db_migrate() { cd "$REPO_ROOT"; npm run db:migrate; }
era_index() { cd "$REPO_ROOT"; npm run era:index; }

preflight_install() {
  local args=()
  if [[ "$("$DIR/models/post-session.sh" status 2>/dev/null || true)" == "RUNNING" ]]; then
    args+=(--allow-busy-port "$SPARK_TEXT_PORT")
  fi
  if [[ "$("$DIR/models/coach.sh" status 2>/dev/null || true)" == "RUNNING" ]]; then
    args+=(--allow-busy-port "$SPARK_COACH_PORT")
  fi
  if [[ "$("$DIR/models/realtime.sh" status 2>/dev/null || true)" == "RUNNING" ]]; then
    args+=(--allow-busy-port "$SPARK_STEPAUDIO_BACKEND_PORT" --allow-busy-port "$SPARK_STEPAUDIO_WS_PORT" --allow-busy-port "$SPARK_STEPAUDIO_HEALTH_PORT")
  fi
  if [[ "$("$DIR/services/retriever.sh" status 2>/dev/null || true)" == "RUNNING" ]]; then
    args+=(--allow-busy-port "$SPARK_RETRIEVER_PORT" --allow-busy-port "$SPARK_VECTORDB_PORT")
  fi
  if [[ "$("$DIR/services/backend.sh" status 2>/dev/null || true)" == "RUNNING" ]]; then
    args+=(--allow-busy-port "$SPARK_BACKEND_PORT" --allow-busy-port "$SPARK_AGENT_RETRIEVAL_PORT")
  fi
  "$DIR/preflight.sh" "${args[@]}"
}

if (( dry_run )); then
  run_step preflight "$DIR/preflight.sh" --report-only
else
  run_step preflight preflight_install
  ensure_local_secrets
  set -a
  . "$DIR/.env"
  set +a
fi
run_step dependencies bootstrap_tools
run_step model-prefetch prefetch_all
run_step db-migrate db_migrate
run_step text-model "$DIR/models/post-session.sh" start
run_step nemoclaw "$DIR/services/nemoclaw.sh" install
run_step retriever "$DIR/services/retriever.sh" start
run_step era-index era_index
run_step start-services "$DIR/start.sh"
run_step verify "$DIR/verify.sh"
log "DGX Spark installation profile complete."
