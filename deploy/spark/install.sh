#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" == "--dry-run" ]]; then
  printf '%s\n' \
    "Spark first-install plan:" \
    "  1. prefetch Text, Coach, Voice and Retriever Runtime artifacts" \
    "  2. start Text and Coach so first OpenClaw onboarding can reuse local vLLM" \
    "  3. bootstrap Spark Base and verify host/NemoClaw prerequisites" \
    "  4. start Retriever Runtime" \
    "  5. install/update Product dependencies, database, Skills and Era index" \
    "  6. start the full Runtime and Product profile" \
    "  7. run the complete Spark verify gates"
  exit 0
fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

if [[ ! -f "$DIR/.env" ]]; then
  cp "$DIR/env.example" "$DIR/.env"
  chmod 600 "$DIR/.env"
fi

. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"
events="$SPARK_DIAGNOSTICS_DIR/install-events.jsonl"
report="$SPARK_DIAGNOSTICS_DIR/install-report.json"
install_log="$SPARK_LOG_DIR/install.log"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
: >"$events"

finalize() {
  local rc=$?
  python3 - "$report" "$events" "$started" "$rc" <<'PY'
import json,sys,time
report,events,started,rc=sys.argv[1:]
rows=[json.loads(line) for line in open(events,encoding="utf-8") if line.strip()]
with open(report,"w",encoding="utf-8") as out:
    json.dump({"started_at":started,"finished_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
               "exit_code":int(rc),"steps":rows},out,ensure_ascii=False,indent=2)
PY
  exit "$rc"
}
trap finalize EXIT

run_step() {
  local name="$1"; shift
  local t0 t1 rc
  t0="$(python3 -c 'import time; print(int(time.time()*1000))')"
  log "RUN $name"
  if "$@" >>"$install_log" 2>&1; then
    t1="$(python3 -c 'import time; print(int(time.time()*1000))')"
    python3 - "$events" "$name" PASS "$((t1-t0))" <<'PY'
import json,sys
path,name,status,duration=sys.argv[1:]
with open(path,"a",encoding="utf-8") as f: f.write(json.dumps({"step":name,"status":status,"duration_ms":int(duration)},ensure_ascii=False)+"\n")
PY
  else
    rc=$?
    t1="$(python3 -c 'import time; print(int(time.time()*1000))')"
    python3 - "$events" "$name" FAIL "$((t1-t0))" <<'PY'
import json,sys
path,name,status,duration=sys.argv[1:]
with open(path,"a",encoding="utf-8") as f: f.write(json.dumps({"step":name,"status":status,"duration_ms":int(duration)},ensure_ascii=False)+"\n")
PY
    tail -100 "$install_log" >&2 || true
    return "$rc"
  fi
}

preflight_install() {
  local args=()
  local text_name="${SPARK_TEXT_CONTAINER:-life-interview-spark-text}"
  local coach_name="${SPARK_COACH_CONTAINER:-life-interview-spark-coach}"
  local voice_backend="${SPARK_STEPAUDIO_CONTAINER:-life-interview-spark-stepaudio}"
  local voice_bridge="${SPARK_STEPAUDIO_BRIDGE_CONTAINER:-life-interview-spark-stepaudio-bridge}"
  local retriever_name="${SPARK_RETRIEVER_CONTAINER:-life-interview-spark-retriever}"
  if docker ps --format '{{.Names}}' | grep -qx "$text_name"; then args+=(--allow-busy-port "$SPARK_TEXT_PORT"); fi
  if docker ps --format '{{.Names}}' | grep -qx "$coach_name"; then args+=(--allow-busy-port "$SPARK_COACH_PORT"); fi
  if docker ps --format '{{.Names}}' | grep -qx "$voice_backend" || pid_running stepaudio-backend; then
    args+=(--allow-busy-port "$SPARK_STEPAUDIO_BACKEND_PORT")
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$voice_bridge" || pid_running stepaudio-bridge; then
    args+=(--allow-busy-port "$SPARK_STEPAUDIO_WS_PORT" --allow-busy-port "$SPARK_STEPAUDIO_HEALTH_PORT")
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$retriever_name"; then
    args+=(--allow-busy-port "$SPARK_RETRIEVER_PORT" --allow-busy-port "$SPARK_VECTORDB_PORT")
  fi
  if pid_running backend; then args+=(--allow-busy-port "$SPARK_BACKEND_PORT"); fi
  if pid_running agent-retrieval-proxy; then args+=(--allow-busy-port "$SPARK_AGENT_RETRIEVAL_PORT"); fi
  "$DIR/preflight.sh" "${args[@]}"
}

run_step preflight preflight_install
run_step model-prefetch "$DIR/models.sh" prefetch
run_step retriever-prefetch "$DIR/services/retriever.sh" prefetch
run_step text-model "$DIR/models/post-session.sh" start
run_step coach-model "$DIR/models/coach.sh" start
run_step bootstrap "$DIR/bootstrap.sh" ensure
run_step verify-base "$DIR/verify-base.sh"
run_step retriever-start "$DIR/services/retriever.sh" start
run_step product-update "$DIR/update.sh" --no-restart
run_step start-services "$DIR/start.sh"
run_step verify "$DIR/verify.sh"
log "DGX Spark installation profile complete."
