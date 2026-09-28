#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

NOT_TESTED="NOT TESTED - REQUIRES DGX SPARK"
mkdir -p "$SPARK_BENCH_DIR"

is_spark=0
if [[ "$(uname -m)" =~ ^(aarch64|arm64)$ ]] && command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  is_spark=1
fi

write_environment() {
  python3 - "$SPARK_BENCH_DIR/environment.json" "$SPARK_DIAGNOSTICS_DIR" <<'PY'
import json,platform,subprocess,sys,time
from pathlib import Path
out=Path(sys.argv[1]); diag=Path(sys.argv[2])
def load(name):
    try: return json.loads((diag/name).read_text())
    except Exception: return None
def cmd(args):
    try: return subprocess.run(args,text=True,capture_output=True,timeout=5).stdout.strip() or None
    except Exception: return None
payload={
 "captured_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
 "architecture":platform.machine(),
 "kernel":platform.release(),
 "git_sha":cmd(["git","rev-parse","HEAD"]),
 "nvidia_smi":cmd(["nvidia-smi","--query-gpu=name,driver_version,utilization.gpu","--format=csv,noheader"]),
 "versions":load("versions.json"),
 "preflight":load("preflight.json"),
 "telemetry":load("telemetry.json"),
}
out.write_text(json.dumps(payload,ensure_ascii=False,indent=2))
PY
}

write_not_tested() {
  for name in text coach retriever realtime concurrency; do
    python3 - "$SPARK_BENCH_DIR/$name.json" "$NOT_TESTED" <<'PY'
import json,sys
open(sys.argv[1],"w").write(json.dumps({"status":sys.argv[2]},ensure_ascii=False,indent=2)+"\n")
PY
  done
  cat > "$SPARK_BENCH_DIR/summary.md" <<EOF
# DGX Spark Benchmark

Result: **$NOT_TESTED**

The runner and fixtures are prepared. Execute `./deploy/spark/benchmark.sh` on the real DGX Spark after `install.sh`.
EOF
}

write_environment
if (( ! is_spark )); then
  write_not_tested
  echo "$NOT_TESTED"
  exit 0
fi

"$DIR/start.sh" >/dev/null

voice_load_status=0
"$DIR/models/realtime.sh" stop >/dev/null 2>&1 || true
voice_t0="$(python3 -c 'import time; print(int(time.time()*1000))')"
if "$DIR/models/realtime.sh" start >>"$SPARK_LOG_DIR/benchmark-realtime-load.log" 2>&1; then
  voice_t1="$(python3 -c 'import time; print(int(time.time()*1000))')"
  export SPARK_BENCH_VOICE_LOAD_MS="$((voice_t1-voice_t0))"
else
  voice_load_status=1
  export SPARK_BENCH_VOICE_LOAD_MS=0
fi

overall_fail=0
run_json() {
  local name="$1"; shift
  local stdout="$SPARK_BENCH_DIR/.$name.stdout" stderr="$SPARK_BENCH_DIR/.$name.stderr" target="$SPARK_BENCH_DIR/$name.json"
  if "$@" >"$stdout" 2>"$stderr"; then
    if ! python3 - "$stdout" "$target" <<'PY'
import json,sys
lines=[x.strip() for x in open(sys.argv[1],encoding="utf-8") if x.strip()]
if not lines: raise SystemExit(1)
value=json.loads(lines[-1])
open(sys.argv[2],"w",encoding="utf-8").write(json.dumps(value,ensure_ascii=False,indent=2)+"\n")
PY
    then
      overall_fail=1
      python3 - "$target" <<'PY'
import json,sys
open(sys.argv[1],"w").write(json.dumps({"status":"FAIL","safe_error":"invalid benchmark JSON"},indent=2)+"\n")
PY
    fi
    if [[ -s "$target" ]] && ! python3 - "$target" <<'PY'
import json,sys
try:
    report=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if report.get("status")=="PASS" else 1)
PY
    then
      overall_fail=1
    fi
  else
    overall_fail=1
    python3 - "$stderr" "$target" <<'PY'
import json,re,sys
try: text=open(sys.argv[1],encoding="utf-8",errors="replace").read()
except Exception: text=""
text=re.sub(r"(?i)Bearer\s+[^\s\"']+","Bearer [redacted]",text)
text=re.sub(r"\b(?:nvapi-|sk-)[A-Za-z0-9_-]{8,}\b","[redacted]",text)
err=(text.strip().splitlines()[-1][-500:] if text.strip() else "benchmark command failed")
open(sys.argv[2],"w").write(json.dumps({"status":"FAIL","safe_error":err},ensure_ascii=False,indent=2)+"\n")
PY
  fi
  rm -f "$stdout" "$stderr"
}

run_json text bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-text-agent-benchmark.ts
run_json coach bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-coach-benchmark.ts
run_json retriever bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-retriever-benchmark.ts
run_json realtime bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-realtime-benchmark.ts
run_json concurrency bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-concurrency-benchmark.ts

if (( voice_load_status )); then
  overall_fail=1
  python3 - "$SPARK_BENCH_DIR/realtime.json" <<'PY'
import json,sys
p=sys.argv[1]
try: d=json.load(open(p))
except Exception: d={}
d["status"]="FAIL"
d["model_load_ms"]=None
d["model_load_error"]="Step-Audio restart failed; see runtime/logs/spark/benchmark-realtime-load.log"
open(p,"w").write(json.dumps(d,ensure_ascii=False,indent=2)+"\n")
PY
fi

python3 - "$SPARK_BENCH_DIR" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1])
names=["text","coach","retriever","realtime","concurrency"]
data={n:json.load(open(root/f"{n}.json")) for n in names}
lines=["# DGX Spark Benchmark","", "| Area | Status | Key metrics |","|---|---|---|"]
def metric(n,d):
    if n=="text":
        s=d.get("streaming",{})
        return f"first token P50/P95 {s.get('first_token_p50_ms')}/{s.get('first_token_p95_ms')} ms; total {s.get('total_p50_ms')}/{s.get('total_p95_ms')} ms"
    if n=="coach":
        return f"Gate P50/P95 {d.get('gate',{}).get('p50_ms')}/{d.get('gate',{}).get('p95_ms')} ms; Resolve {d.get('resolve',{}).get('p50_ms')}/{d.get('resolve',{}).get('p95_ms')} ms"
    if n=="retriever":
        return f"query P50/P95 {d.get('query',{}).get('p50_ms')}/{d.get('query',{}).get('p95_ms')} ms; scope={d.get('scope_correctness')}"
    if n=="realtime":
        return f"load {d.get('model_load_ms')} ms; first audio P50/P95 {d.get('first_audio',{}).get('p50_ms')}/{d.get('first_audio',{}).get('p95_ms')} ms"
    return f"{len(d.get('scenarios',[]))} concurrency scenarios"
for n in names:
    lines.append(f"| {n} | **{data[n].get('status','UNKNOWN')}** | {metric(n,data[n])} |")
lines += ["", "All inputs are synthetic or upstream public audio fixtures. No private transcript content is used."]
(root/"summary.md").write_text("\n".join(lines)+"\n")
PY

if (( overall_fail )); then
  echo "Spark benchmark completed with failures; evidence was retained." >&2
  exit 1
fi
echo "Spark benchmark PASS: $SPARK_BENCH_DIR"
