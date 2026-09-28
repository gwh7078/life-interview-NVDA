#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(uname -m | tr '[:upper:]' '[:lower:]')" != "aarch64" && "$(uname -m | tr '[:upper:]' '[:lower:]')" != "arm64" ]] \
  || ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
  echo "Result: NOT TESTED - REQUIRES DGX SPARK (ARM64 + NVIDIA GPU)."
  exit 2
fi

. "$DIR/lib/common.sh"
report="$SPARK_DIAGNOSTICS_DIR/verify-base.json"
python3 - "$DIR" "$REPO_ROOT" "$report" <<'PY'
import json,os,platform,shutil,shlex,subprocess,sys,time
from pathlib import Path

spark_dir,root,report=map(Path,sys.argv[1:])
NOT_TESTED="NOT TESTED - REQUIRES DGX SPARK"
gates=[]

def gate(name,command,timeout=120):
    started=time.monotonic()
    try:
        result=subprocess.run(command,cwd=root,text=True,capture_output=True,timeout=timeout,check=False)
        gates.append({"name":name,"status":"PASS" if result.returncode==0 else "FAIL",
                      "duration_ms":round((time.monotonic()-started)*1000),
                      "detail":(result.stdout or result.stderr).strip().splitlines()[-1:][0][:300] if (result.stdout or result.stderr).strip() else None})
    except subprocess.TimeoutExpired:
        gates.append({"name":name,"status":"FAIL","duration_ms":round((time.monotonic()-started)*1000),"detail":"timeout"})

gate("ARM64 / host GPU",["bash","-c","test \"$(uname -m)\" = aarch64 -o \"$(uname -m)\" = arm64 && nvidia-smi >/dev/null"])
gate("Docker GPU runtime",[str(spark_dir/"lib/docker-gpu-smoke.sh")],180)
node=Path(os.environ["SPARK_HOME"])/"tools/node/bin/node"
uv=Path(os.environ["SPARK_HOME"])/"tools/uv/bin/uv"
toolchain_check=(
    "import os,subprocess,sys; "
    "node,uv,expected_node,expected_uv=sys.argv[1:]; "
    "assert subprocess.check_output([node,'--version'],text=True).strip()=='v'+expected_node; "
    "assert sys.version_info >= (3,10); "
    "version=subprocess.check_output([uv,'--version'],text=True).split()[1]; "
    "assert expected_uv=='latest' or version==expected_uv"
)
gate("Node / Python / uv toolchain",[sys.executable,"-c",toolchain_check,str(node),str(uv),
     os.environ.get("SPARK_NODE_VERSION","24.21.0"),os.environ.get("SPARK_UV_VERSION","latest")])
gate("NemoClaw / OpenShell Base",["bash","-c",
     f"command -v nemoclaw >/dev/null && command -v openshell >/dev/null && test \"$({shlex.quote(str(spark_dir/'services/nemoclaw.sh'))} status)\" = RUNNING && test \"$({shlex.quote(str(spark_dir/'services/nemoclaw.sh'))} openclaw-status)\" = RUNNING"],60)

def check_paths():
    names=("SPARK_HOME","SPARK_RUNTIME_DIR","SPARK_STATE_DIR","SPARK_PID_DIR","SPARK_RETRIEVER_DATA_DIR","HF_HOME","MODEL_CACHE","NGC_CACHE")
    paths=[Path(os.environ[name]) for name in names]
    for path in paths:
        path.mkdir(parents=True,exist_ok=True)
        probe=path/".verify-base-write-check"
        probe.touch(exist_ok=True); probe.unlink()
    return True
try:
    check_paths()
    gates.append({"name":"Persistent Spark Home / caches","status":"PASS","duration_ms":0,"detail":"all configured paths are writable"})
except Exception as exc:
    gates.append({"name":"Persistent Spark Home / caches","status":"FAIL","duration_ms":0,"detail":type(exc).__name__})

marker=Path(os.environ["SPARK_STATE_DIR"])/"base.fingerprint"
expected=subprocess.run(["bash","-c",f"{shlex.quote(str(spark_dir/'bootstrap.sh'))} fingerprint"],cwd=root,text=True,capture_output=True,check=False)
recorded=marker.read_text().strip() if marker.exists() else ""
match=expected.returncode==0 and recorded==expected.stdout.strip()
gates.append({"name":"Base inputs / bootstrap state","status":"PASS" if match else "FAIL","duration_ms":0,
              "detail":"fingerprint matches" if match else "run ./deploy/spark/bootstrap.sh for this Base version"})

failed=[gate for gate in gates if gate["status"]=="FAIL"]
payload={"captured_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"gates":gates,
         "result":"FAIL" if failed else "PASS"}
report.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n")
print("# Spark Base Verification")
for item in gates:
    print(f"{item['status']}: {item['name']}"+(f" ({item['detail']})" if item.get("detail") else ""))
print(f"Result: {payload['result']}.")
raise SystemExit(1 if failed else 0)
PY
