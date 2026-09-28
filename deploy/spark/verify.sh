#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib/common.sh"
. "$DIR/lib/ports.sh"

python3 - "$DIR" "$REPO_ROOT" "$SPARK_DIAGNOSTICS_DIR" <<'PY'
import json, os, platform, re, subprocess, sys, time
from pathlib import Path

spark_dir, root, diag = map(Path, sys.argv[1:])
evidence=diag/"evidence"; evidence.mkdir(parents=True,exist_ok=True)
is_spark=platform.machine().lower() in {"aarch64","arm64"} and subprocess.run(["sh","-lc","command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1"]).returncode==0
NOT_TESTED="NOT TESTED - REQUIRES DGX SPARK"

def redact(s):
    s=re.sub(r'(?i)(authorization:?[ =]+bearer )[A-Za-z0-9._-]+',r'\1[REDACTED]',s)
    s=re.sub(r'\b(?:nvapi-|sk-)[A-Za-z0-9_-]{8,}\b','[REDACTED]',s)
    return s

def gate(gid,name,command,requires_spark=True,timeout=900):
    path=evidence/f"{gid}.log"; start=time.monotonic()
    if requires_spark and not is_spark:
        path.write_text(NOT_TESTED+"\n")
        return {"id":gid,"name":name,"status":NOT_TESTED,"duration_ms":0,"evidence_file":str(path.relative_to(root)),"safe_error":None}
    try:
        p=subprocess.run(["bash","-lc",command],cwd=root,text=True,capture_output=True,timeout=timeout,env=os.environ.copy())
        out=redact((p.stdout or "")+(("\n"+p.stderr) if p.stderr else ""))
        path.write_text(out[-100000:])
        status="PASS" if p.returncode==0 else "FAIL"
        err=None if p.returncode==0 else (out.strip().splitlines()[-1][-500:] if out.strip() else f"exit {p.returncode}")
    except subprocess.TimeoutExpired:
        path.write_text("timeout\n"); status="FAIL"; err=f"timeout after {timeout}s"
    except Exception as e:
        path.write_text(type(e).__name__+"\n"); status="FAIL"; err=type(e).__name__
    return {"id":gid,"name":name,"status":status,"duration_ms":round((time.monotonic()-start)*1000),"evidence_file":str(path.relative_to(root)),"safe_error":err}

q=lambda s: "'" + str(s).replace("'","'\\''") + "'"
text_model=os.getenv("SPARK_TEXT_MODEL","nvidia/Qwen3.6-35B-A3B-NVFP4")
sandbox=os.getenv("NEMOCLAW_SANDBOX","my-assistant")
db=os.getenv("DATABASE_PATH","data/memoir.db")
gates=[
 gate("G0","Hardware / ARM64 / Docker GPU",f"{q(spark_dir/'preflight.sh')} && {q(spark_dir/'lib/docker-gpu-smoke.sh')}"),
 gate("G1","Dependencies","node --version && npm --version && python3 --version && docker --version",False,60),
 gate("G2","Local Text Model",f"python3 {q(spark_dir/'lib/openai-smoke.py')} http://127.0.0.1:{os.getenv('SPARK_TEXT_PORT','8000')}/v1 {q(text_model)}",True,180),
 gate("G3","NemoClaw / OpenShell / Skills",f"test \"$({q(spark_dir/'services/nemoclaw.sh')} status)\" = RUNNING && nemoclaw {q(sandbox)} skill list && {q(spark_dir/'services/nemoclaw.sh')} smoke",True,360),
 gate("G4","Private Retriever + Agent retrieval boundary","node --import tsx scripts/spark-retriever-smoke.ts && node --import tsx scripts/spark-agent-retrieval-smoke.ts",True,420),
 gate("G5","Era Context","npm run era:index && npm run era:benchmark",True,600),
 gate("G6","Coach","npm run test:realtime:coach:live",True,180),
 gate("G7","Step-Audio model load",f"curl -fsS --noproxy '*' http://127.0.0.1:{os.getenv('SPARK_STEPAUDIO_BACKEND_PORT','8010')}/health && curl -fsS --noproxy '*' http://127.0.0.1:{os.getenv('SPARK_STEPAUDIO_HEALTH_PORT','8093')}/health",True,60),
 gate("G8","Audio-to-audio / streaming","node --import tsx scripts/spark-realtime-bridge-smoke.ts",True,300),
 gate("G9","Realtime Provider E2E","node --import tsx scripts/spark-realtime-provider-e2e.ts",True,600),
 gate("G10","Backend + Web + DB",f"test -f {q(db)} && curl -fsS --noproxy '*' http://127.0.0.1:{os.getenv('SPARK_BACKEND_PORT','4174')}/api/health && curl -fsS --noproxy '*' http://127.0.0.1:{os.getenv('SPARK_BACKEND_PORT','4174')}/ >/dev/null",True,60),
 gate("G11","Interview + Closeout","npm run test:closeout:real",True,600),
 gate("G12","Completion / Continue / Contributor / Generation","npm run test:agent:nat:eval",True,900),
 gate("G13","NAT","npm run test:agent:nat:smoke",True,600),
 gate("G14","Technical Observer",f"test \"$({q(spark_dir/'services/observer.sh')} status)\" = RUNNING && python3 -c 'import json; d=json.load(open(\"runtime/diagnostics/spark/telemetry.json\")); assert d[\"platform\"]==\"dgx-spark\"; assert d[\"system_memory\"][\"total_bytes\"] is not None; assert d[\"gpu\"][\"utilization_pct\"] is None or d[\"gpu\"][\"utilization_pct\"] >= 0'",True,60),
]
summary={"captured_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"dgx_spark_detected":is_spark,"gates":gates}
(diag/"verify.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2))
lines=["# DGX Spark Verify","","| Gate | Check | Status | Duration | Evidence |","|---|---|---|---:|---|"]
for g in gates:
    lines.append(f"| {g['id']} | {g['name']} | {g['status']} | {g['duration_ms']} ms | `{g['evidence_file']}` |")
fail=[g for g in gates if g["status"]=="FAIL"]
lines += ["",f"Result: {'FAIL' if fail else ('NOT TESTED - REQUIRES DGX SPARK' if not is_spark else 'PASS')}."]
(diag/"verify.md").write_text("\n".join(lines)+"\n")
print("\n".join(lines))
raise SystemExit(1 if fail else 0)
PY
