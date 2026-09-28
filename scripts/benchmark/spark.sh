#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

SPARK_ENV_FILE="${SPARK_ENV_FILE:-$REPO_ROOT/deploy/spark/.env}"
SPARK_BENCH_ROOT="${SPARK_BENCH_DIR:-$REPO_ROOT/runtime/benchmarks/spark}"
SPARK_BENCH_DIR="$SPARK_BENCH_ROOT/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$"
NOT_TESTED="NOT TESTED ON DGX SPARK"
RUNTIME_NOT_READY="EXTERNAL RUNTIME NOT READY"
mkdir -p "$SPARK_BENCH_DIR"

is_spark=0
gpu_name=""
if [[ "$(uname -m)" =~ ^(aarch64|arm64)$ ]] && command -v nvidia-smi >/dev/null 2>&1; then
  gpu_name="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)"
  [[ "$gpu_name" == *GB10* ]] && is_spark=1
fi

write_environment() {
  python3 - "$REPO_ROOT" "$SPARK_BENCH_DIR/environment.json" <<'PY'
import hashlib,json,platform,subprocess,sys,time
from pathlib import Path
root,out=Path(sys.argv[1]),Path(sys.argv[2])
def cmd(args):
    try: return subprocess.run(args,cwd=root,text=True,capture_output=True,timeout=5).stdout.strip() or None
    except Exception: return None
def fixture(name):
    path=root/"runtime/benchmarks/spark/fixtures"/name
    if not path.is_file(): return {"status":"MISSING"}
    digest=hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda:source.read(1024*1024),b""):
            digest.update(block)
    return {"status":"PRESENT","relative_path":str(path.relative_to(root)),
            "size_bytes":path.stat().st_size,"sha256":digest.hexdigest()}
payload={
 "captured_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
 "architecture":platform.machine(),
 "kernel":platform.release(),
 "git_sha":cmd(["git","rev-parse","HEAD"]),
 "nvidia_smi":cmd(["nvidia-smi","--query-gpu=name,driver_version,utilization.gpu","--format=csv,noheader"]),
 "realtime_fixtures":{
  "speech-short.wav":fixture("speech-short.wav"),
  "speech-long.wav":fixture("speech-long.wav"),
 },
}
out.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n")
PY
}

write_not_tested() {
  for name in text coach retriever realtime concurrency; do
    python3 - "$SPARK_BENCH_DIR/$name.json" "$NOT_TESTED" <<'PY'
import json,sys
with open(sys.argv[1],"w",encoding="utf-8") as out:
    json.dump({"status":sys.argv[2],"safe_error":"DGX Spark hardware was not detected; workload not run."},out,ensure_ascii=False,indent=2)
    out.write("\n")
PY
  done
  cat > "$SPARK_BENCH_DIR/summary.md" <<EOF
# DGX Spark Benchmark

Result: **$NOT_TESTED**

Benchmark workloads were skipped because this host did not pass the DGX Spark hardware check. The runner does not install, start, stop, or restart Runtime services.
EOF
}

write_runtime_not_ready() {
  python3 - "$SPARK_BENCH_DIR" "$RUNTIME_NOT_READY" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); status=sys.argv[2]
try:
    readiness=json.loads((root/"readiness.json").read_text(encoding="utf-8"))
except Exception:
    readiness={"checks":[]}
failed=[item for item in readiness.get("checks",[]) if item.get("status")!="PASS"]
names=[item.get("name","unknown") for item in failed]
for name in ("text","coach","retriever","realtime","concurrency"):
    with (root/f"{name}.json").open("w",encoding="utf-8") as out:
        json.dump({"status":status,"safe_error":"Required endpoints not ready: "+", ".join(names)},out,ensure_ascii=False,indent=2)
        out.write("\n")
lines=["# DGX Spark Benchmark","",f"Result: **{status}**","","| Readiness check | Status | Safe detail |","|---|---|---|"]
for item in readiness.get("checks",[]):
    lines.append(f"| {item.get('name','unknown')} | **{item.get('status','UNKNOWN')}** | {item.get('safe_error') or 'ready'} |")
lines += ["","All workloads were skipped. Start the product and prepare the external Runtime services, then rerun this script. The runner does not install, start, stop, or restart Runtime services."]
(root/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
PY
}

write_environment
if (( ! is_spark )); then
  write_not_tested
  echo "$NOT_TESTED"
  exit 0
fi

# NAT benchmarks must exercise the real NemoClaw/OpenClaw Runtime, never a test stub.
export NAT_AGENT_RUNTIME=agent
unset SPARK_BENCH_VOICE_LOAD_MS

readiness_status="$(python3 - "$SPARK_ENV_FILE" "$SPARK_BENCH_DIR/readiness.json" <<'PY'
import base64,hashlib,json,os,re,shutil,socket,ssl,subprocess,sys
import urllib.error,urllib.parse,urllib.request

env_file,out_path=sys.argv[1:]
values={}
try:
    for raw in open(env_file,encoding="utf-8"):
        line=raw.strip()
        if not line or line.startswith("#"): continue
        if line.startswith("export "): line=line[7:].lstrip()
        key,sep,value=line.partition("=")
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",key.strip()): continue
        value=value.strip()
        if len(value)>=2 and value[0]==value[-1] and value[0] in "\"'": value=value[1:-1]
        values[key.strip()]=value
except OSError:
    pass

def setting(key,default=""):
    value=os.environ.get(key)
    if value is None: value=values.get(key,default)
    return value.strip()

class EndpointError(Exception): pass

def error_name(exc):
    if isinstance(exc,urllib.error.HTTPError): return f"HTTP {exc.code}"
    if isinstance(exc,(TimeoutError,socket.timeout)): return "connection timeout"
    if isinstance(exc,urllib.error.URLError): return "endpoint unavailable"
    return type(exc).__name__

opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def http(url,headers=None,parse_json=False):
    try:
        request=urllib.request.Request(url,headers=headers or {})
        with opener.open(request,timeout=6) as response:
            if response.status!=200: raise EndpointError(f"HTTP {response.status}")
            body=response.read()
    except EndpointError: raise
    except (urllib.error.HTTPError,urllib.error.URLError,TimeoutError,socket.timeout,OSError) as exc:
        raise EndpointError(error_name(exc)) from None
    if parse_json:
        try: return json.loads(body)
        except (UnicodeDecodeError,json.JSONDecodeError): raise EndpointError("invalid JSON response") from None
    return body

checks=[]
def record(name,fn):
    try:
        fn()
        checks.append({"name":name,"status":"PASS","safe_error":None})
    except EndpointError as exc:
        checks.append({"name":name,"status":"NOT READY","safe_error":str(exc)})
    except Exception as exc:
        checks.append({"name":name,"status":"NOT READY","safe_error":error_name(exc)})

def model_endpoint(name,base,model,token):
    def check():
        if not base: raise EndpointError("endpoint not configured")
        if not model: raise EndpointError("served model not configured")
        payload=http(base.rstrip("/")+"/models",{"authorization":"Bearer "+token},True)
        served={item.get("id") for item in payload.get("data",[]) if isinstance(item,dict)} if isinstance(payload,dict) else set()
        if model not in served: raise EndpointError("configured model unavailable at /models")
    record(name,check)

port=setting("SPARK_BACKEND_PORT") or setting("PORT") or "4174"
product_base=setting("SPARK_PRODUCT_BASE_URL") or f"http://127.0.0.1:{port}"
def check_product():
    payload=http(product_base.rstrip("/")+"/api/health",parse_json=True)
    if not isinstance(payload,dict) or payload.get("ok") is not True or payload.get("databaseAvailable") is not True:
        raise EndpointError("product health or database unavailable")
record("product",check_product)

text_base=setting("TEXT_MODEL_BASE_URL") or "http://127.0.0.1:8000/v1"
text_model=setting("TEXT_MODEL") or setting("SPARK_TEXT_SERVED_MODEL") or "nvidia/Qwen3.6-35B-A3B-NVFP4"
model_endpoint("text_model",text_base,text_model,setting("TEXT_MODEL_API_KEY") or "local-spark")
coach_base=setting("REALTIME_COACH_BASE_URL") or "http://127.0.0.1:8001/v1"
coach_model=setting("REALTIME_COACH_MODEL") or setting("SPARK_COACH_SERVED_MODEL") or "Qwen/Qwen3-8B"
model_endpoint("coach",coach_base,coach_model,setting("REALTIME_COACH_API_KEY") or "local-spark")

retriever=(setting("NEMO_RETRIEVER_BASE_URL") or "http://127.0.0.1:7670").rstrip("/")
retriever_headers={}
if setting("NEMO_RETRIEVER_API_TOKEN"):
    retriever_headers["authorization"]="Bearer "+setting("NEMO_RETRIEVER_API_TOKEN")
record("retriever",lambda: http(retriever+"/v1/health",retriever_headers))
vectordb=(setting("NEMO_RETRIEVER_VECTORDB_URL") or "http://127.0.0.1:7671").rstrip("/")
record("vectordb",lambda: http(vectordb+"/v1/health"))

ws_url=setting("STEPAUDIO2_LOCAL_WS_URL") or "ws://127.0.0.1:8092/realtime"
def check_realtime():
    try: parsed=urllib.parse.urlsplit(ws_url); port_num=parsed.port
    except ValueError: raise EndpointError("invalid WebSocket URL") from None
    if parsed.scheme not in {"ws","wss"} or not parsed.hostname:
        raise EndpointError("invalid WebSocket URL")
    port_num=port_num or (443 if parsed.scheme=="wss" else 80)
    key=base64.b64encode(os.urandom(16)).decode("ascii")
    target=urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    authority=parsed.netloc
    try:
        raw=socket.create_connection((parsed.hostname,port_num),timeout=6)
        if parsed.scheme=="wss": raw=ssl.create_default_context().wrap_socket(raw,server_hostname=parsed.hostname)
        with raw as conn:
            conn.settimeout(6)
            request=(f"GET {target} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
            conn.sendall(request.encode("ascii"))
            response=b""
            while b"\r\n\r\n" not in response and len(response)<16384:
                chunk=conn.recv(4096)
                if not chunk: break
                response+=chunk
            header=response.split(b"\r\n\r\n",1)[0].decode("latin-1")
            lines=header.split("\r\n")
            if not lines or not re.search(r"\s101\s",lines[0]): raise EndpointError("WebSocket endpoint did not return HTTP 101")
            headers={line.partition(":")[0].strip().lower():line.partition(":")[2].strip() for line in lines[1:] if ":" in line}
            expected=base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if headers.get("sec-websocket-accept")!=expected: raise EndpointError("invalid WebSocket handshake")
            mask=os.urandom(4)
            conn.sendall(b"\x88\x80"+mask)
    except EndpointError: raise
    except (OSError,ssl.SSLError,TimeoutError,socket.timeout): raise EndpointError("WebSocket endpoint unavailable") from None
record("realtime",check_realtime)

def check_agent_runtime():
    cli=shutil.which("nemoclaw")
    if not cli: raise EndpointError("NemoClaw CLI unavailable")
    sandbox=setting("NEMOCLAW_SANDBOX")
    if not sandbox: raise EndpointError("NemoClaw sandbox not configured")
    try:
        result=subprocess.run([cli,sandbox,"status","--json"],text=True,capture_output=True,timeout=10)
    except (OSError,subprocess.TimeoutExpired): raise EndpointError("NemoClaw status unavailable") from None
    try: status=json.loads(result.stdout)
    except json.JSONDecodeError: raise EndpointError("NemoClaw returned invalid status JSON") from None
    configured_model=setting("AGENT_MODEL_DEFAULT")
    if result.returncode!=0 or status.get("found") is not True or str(status.get("phase","")).lower() not in {"ready","running"}:
        raise EndpointError("NemoClaw sandbox is not running")
    if status.get("provider")!="vllm-local" or status.get("model")!=configured_model:
        raise EndpointError("NemoClaw route does not match the configured Text model")
    expected={"provider":"vllm-local","model":configured_model}
    for route_name in ("recordedRoute","liveRoute"):
        route=status.get(route_name)
        if not isinstance(route,dict) or any(route.get(key)!=value for key,value in expected.items()):
            raise EndpointError(f"NemoClaw {route_name} does not match the configured Text model")
    if status.get("routeDrift"):
        raise EndpointError("NemoClaw reports inference route drift")
    try:
        openclaw=subprocess.run([cli,sandbox,"exec","--","openclaw","--version"],text=True,capture_output=True,timeout=10)
    except (OSError,subprocess.TimeoutExpired): raise EndpointError("OpenClaw status unavailable") from None
    if openclaw.returncode!=0: raise EndpointError("OpenClaw Runtime unavailable")
record("agent_runtime",check_agent_runtime)

status="PASS" if all(item["status"]=="PASS" for item in checks) else "EXTERNAL RUNTIME NOT READY"
with open(out_path,"w",encoding="utf-8") as out:
    json.dump({"status":status,"checks":checks},out,ensure_ascii=False,indent=2)
    out.write("\n")
print(status)
PY
)"

if [[ "$readiness_status" != PASS ]]; then
  write_runtime_not_ready
  echo "$RUNTIME_NOT_READY; benchmark workloads were skipped and readiness evidence was retained." >&2
  exit 2
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
with open(sys.argv[2],"w",encoding="utf-8") as out:
    json.dump(value,out,ensure_ascii=False,indent=2)
    out.write("\n")
PY
    then
      overall_fail=1
      python3 - "$target" <<'PY'
import json,sys
with open(sys.argv[1],"w",encoding="utf-8") as out:
    json.dump({"status":"FAIL","safe_error":"invalid benchmark JSON"},out,indent=2)
    out.write("\n")
PY
    fi
    if [[ "$name" == realtime && -s "$target" ]]; then
      python3 - "$target" <<'PY'
import json,sys
path=sys.argv[1]
try: data=json.load(open(path,encoding="utf-8"))
except Exception: data={}
data["model_load_ms"]=None
data["model_load_measurement"]="NOT MEASURED: benchmark leaves the user-prepared Runtime running."
with open(path,"w",encoding="utf-8") as out:
    json.dump(data,out,ensure_ascii=False,indent=2)
    out.write("\n")
PY
    fi
    if [[ -s "$target" ]] && ! python3 - "$target" <<'PY'
import json,sys
try: report=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception: raise SystemExit(1)
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
text=re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+|Bearer\s+)[^\s\"']+",r"\1[redacted]",text)
text=re.sub(r"\b(?:nvapi-|sk-)[A-Za-z0-9_-]{8,}\b","[redacted]",text,flags=re.I)
text=re.sub(r"(?i)\b(api[_-]?key|token|password|secret)(\s*[=:]\s*)[^\s&,;\"']+",r"\1\2[redacted]",text)
err=(text.strip().splitlines()[-1][-500:] if text.strip() else "benchmark command failed")
with open(sys.argv[2],"w",encoding="utf-8") as out:
    json.dump({"status":"FAIL","safe_error":err},out,ensure_ascii=False,indent=2)
    out.write("\n")
PY
  fi
  rm -f "$stdout" "$stderr"
}

run_json text bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-text-agent-benchmark.ts
run_json coach bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-coach-benchmark.ts
run_json retriever bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-retriever-benchmark.ts
run_json realtime bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-realtime-benchmark.ts
run_json concurrency bash scripts/codex-node.sh node --env-file-if-exists=deploy/spark/.env --import tsx scripts/spark-concurrency-benchmark.ts

python3 - "$SPARK_BENCH_DIR" "$overall_fail" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); failed=bool(int(sys.argv[2]))
names=["text","coach","retriever","realtime","concurrency"]
data={name:json.load(open(root/f"{name}.json",encoding="utf-8")) for name in names}
lines=["# DGX Spark Benchmark","",f"Result: **{'FAIL' if failed else 'PASS'}**","","| Area | Status | Key metrics |","|---|---|---|"]
def metric(name,report):
    if name=="text":
        stream=report.get("streaming",{})
        return f"first token P50/P95 {stream.get('first_token_p50_ms')}/{stream.get('first_token_p95_ms')} ms; total {stream.get('total_p50_ms')}/{stream.get('total_p95_ms')} ms"
    if name=="coach":
        return f"Gate P50/P95 {report.get('gate',{}).get('p50_ms')}/{report.get('gate',{}).get('p95_ms')} ms; Resolve {report.get('resolve',{}).get('p50_ms')}/{report.get('resolve',{}).get('p95_ms')} ms"
    if name=="retriever":
        return f"query P50/P95 {report.get('query',{}).get('p50_ms')}/{report.get('query',{}).get('p95_ms')} ms; scope={report.get('scope_correctness')}"
    if name=="realtime":
        return f"model load not measured; first audio P50/P95 {report.get('first_audio',{}).get('p50_ms')}/{report.get('first_audio',{}).get('p95_ms')} ms"
    return f"{len(report.get('scenarios',[]))} concurrency scenarios"
for name in names:
    lines.append(f"| {name} | **{data[name].get('status','UNKNOWN')}** | {metric(name,data[name])} |")
lines += ["","Inputs are synthetic or upstream public audio fixtures. No private transcript content is used.","The product and user-prepared external Runtime must already be running. This benchmark does not install, start, stop, or restart Runtime services."]
(root/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
PY

if (( overall_fail )); then
  echo "Spark benchmark completed with failures; sanitized JSON evidence was retained." >&2
  exit 1
fi
echo "Spark benchmark PASS: $SPARK_BENCH_DIR"
