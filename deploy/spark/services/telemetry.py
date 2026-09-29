#!/usr/bin/env python3
import json, os, platform, subprocess, sys, time
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[3]/"deploy/spark/lib"))
from nemoclaw_status import validate_status_json

OUT=Path(os.environ.get("SPARK_TELEMETRY_PATH","runtime/diagnostics/spark/telemetry.json"))
PID_DIR=Path(os.environ.get("SPARK_PID_DIR","runtime/pids/spark"))
INTERVAL=float(os.environ.get("SPARK_TELEMETRY_INTERVAL_S","2"))
SERVICES={
 "Text Model":("http://127.0.0.1:"+os.environ.get("SPARK_TEXT_PORT","8000")+"/health"),
 "Coach":((os.environ["REALTIME_COACH_BASE_URL"].strip().rstrip("/").removesuffix("/v1")+"/health")
          if os.environ.get("REALTIME_COACH_BASE_URL","").strip() else
          "http://127.0.0.1:"+os.environ.get("SPARK_COACH_PORT","8001")+"/health"),
 "Voice":("http://127.0.0.1:"+os.environ.get("SPARK_STEPAUDIO_HEALTH_PORT","8093")+"/health"),
 "Retriever":("http://127.0.0.1:"+os.environ.get("SPARK_RETRIEVER_PORT","7670")+"/v1/health"),
 "Backend":("http://127.0.0.1:"+os.environ.get("SPARK_BACKEND_PORT","4174")+"/api/health"),
}
NEMOCLAW_SANDBOX=os.environ.get("NEMOCLAW_SANDBOX","")
_nemo_cache={"at":0.0,"state":"UNKNOWN"}

def meminfo():
    d={}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k,v,*_=line.replace(":","").split()
            d[k]=int(v)*1024
    except Exception:
        pass
    return d

def gpu():
    def number(value):
        try:
            text=str(value).strip().replace("[","").replace("]","")
            return float(text) if text and text.upper() not in {"N/A","NA"} else None
        except Exception:
            return None
    try:
        p=subprocess.run(["nvidia-smi","--query-gpu=utilization.gpu,memory.used,memory.total","--format=csv,noheader,nounits"],
                         text=True,capture_output=True,timeout=3,check=True)
        first=p.stdout.strip().splitlines()[0].split(",")
        return {
            "utilization_pct":number(first[0] if len(first)>0 else None),
            "memory_used_mib":number(first[1] if len(first)>1 else None),
            "memory_total_mib":number(first[2] if len(first)>2 else None),
        }
    except Exception:
        return {"utilization_pct":None,"memory_used_mib":None,"memory_total_mib":None}

def process_rss():
    out={}
    if not PID_DIR.exists():
        return out
    for f in PID_DIR.glob("*.pid"):
        try:
            pid=int(f.read_text().strip())
            status=Path(f"/proc/{pid}/status").read_text()
            rss=None
            for line in status.splitlines():
                if line.startswith("VmRSS:"):
                    rss=int(line.split()[1])*1024
                    break
            out[f.stem]={"pid":pid,"rss_bytes":rss}
        except Exception:
            pass
    return out

def reachable(url):
    import urllib.request
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url,timeout=1.5) as r:
            return "RUNNING" if 200 <= r.status < 500 else "DEGRADED"
    except Exception:
        return "STOPPED"

def nemoclaw_state():
    now=time.monotonic()
    if now-_nemo_cache["at"] < 30:
        return _nemo_cache["state"]
    if not NEMOCLAW_SANDBOX:
        state="NOT READY"
    else:
        try:
            p=subprocess.run(["nemoclaw",NEMOCLAW_SANDBOX,"status","--json"],text=True,capture_output=True,timeout=5)
            status_ready=p.returncode==0 and validate_status_json(p.stdout) is None
            openclaw=subprocess.run(["nemoclaw",NEMOCLAW_SANDBOX,"exec","--","openclaw","--version"],
                                    text=True,capture_output=True,timeout=5) if status_ready else None
            state="RUNNING" if openclaw is not None and openclaw.returncode==0 else "DEGRADED"
        except FileNotFoundError:
            state="STOPPED"
        except Exception:
            state="UNKNOWN"
    _nemo_cache.update(at=now,state=state)
    return state

def docker_stats():
    try:
        p=subprocess.run(["docker","stats","--no-stream","--format","{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"],
                         text=True,capture_output=True,timeout=5,check=True)
        return [dict(zip(("name","cpu","memory"),line.split("|",2))) for line in p.stdout.splitlines() if "|" in line]
    except Exception:
        return []

while True:
    m=meminfo()
    payload={
      "captured_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
      "platform":"dgx-spark",
      "architecture":platform.machine(),
      "gpu":gpu(),
      "system_memory":{"total_bytes":m.get("MemTotal"),"available_bytes":m.get("MemAvailable")},
      "swap":{"total_bytes":m.get("SwapTotal"),"free_bytes":m.get("SwapFree")},
      "cpu":{"load_1m":os.getloadavg()[0] if hasattr(os,"getloadavg") else None,"count":os.cpu_count()},
      "process_rss":process_rss(),
      "containers":docker_stats(),
      "services":{**{name:reachable(url) for name,url in SERVICES.items()},"NemoClaw":nemoclaw_state()},
    }
    OUT.parent.mkdir(parents=True,exist_ok=True)
    tmp=OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload,ensure_ascii=False,indent=2))
    os.replace(tmp,OUT)
    time.sleep(INTERVAL)
