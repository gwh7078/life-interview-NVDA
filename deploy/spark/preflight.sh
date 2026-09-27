#!/usr/bin/env bash
set -euo pipefail
SPARK_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SPARK_DIR/lib/common.sh"
# shellcheck source=lib/ports.sh
. "$SPARK_DIR/lib/ports.sh"

report_only=0
[[ "${1:-}" == "--report-only" ]] && report_only=1

python3 - "$SPARK_DIAGNOSTICS_DIR" "$report_only"   "$SPARK_TEXT_PORT" "$SPARK_COACH_PORT" "$SPARK_STEPAUDIO_BACKEND_PORT" "$SPARK_STEPAUDIO_WS_PORT"   "$SPARK_STEPAUDIO_HEALTH_PORT" "$SPARK_RETRIEVER_PORT" "$SPARK_VECTORDB_PORT" "$SPARK_BACKEND_PORT" "$SPARK_AGENT_TOOL_PORT" <<'PY'
import json, os, platform, shutil, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

out = Path(sys.argv[1]); report_only = sys.argv[2] == "1"; ports = [int(x) for x in sys.argv[3:]]
out.mkdir(parents=True, exist_ok=True)

def cmd(argv, timeout=15):
    try:
        p = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
        return {"ok": p.returncode == 0, "code": p.returncode, "stdout": p.stdout[-12000:], "stderr": p.stderr[-4000:]}
    except Exception as e:
        return {"ok": False, "code": None, "stdout": "", "stderr": type(e).__name__}

def version(argv):
    r = cmd(argv)
    text = (r["stdout"] or r["stderr"]).strip().splitlines()
    return text[0] if text else None

def network(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent":"life-interview-spark-preflight/1"})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            return {"status":"PASS","http":r.status}
    except urllib.error.HTTPError as e:
        return {"status":"PASS","http":e.code}
    except Exception as e:
        return {"status":"FAIL","error":type(e).__name__}

def port_free(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port)); return True
    except OSError:
        return False
    finally:
        s.close()

uname = cmd(["uname","-a"])
arch = platform.machine().lower()
os_release = Path("/etc/os-release").read_text(errors="replace") if Path("/etc/os-release").exists() else ""
smi = cmd(["nvidia-smi"]) if shutil.which("nvidia-smi") else {"ok":False,"stdout":"","stderr":"missing"}
docker_version = version(["docker","--version"]) if shutil.which("docker") else None
docker_info = cmd(["docker","info"]) if shutil.which("docker") else {"ok":False,"stdout":"","stderr":"missing"}
python_ver = version(["python3","--version"]) if shutil.which("python3") else None
node_ver = version(["node","--version"]) if shutil.which("node") else None
free = cmd(["free","-h"]) if shutil.which("free") else {"ok":False,"stdout":"","stderr":"missing"}
df = cmd(["df","-h"])
lsblk = cmd(["lsblk"]) if shutil.which("lsblk") else {"ok":False,"stdout":"","stderr":"missing"}
product = ""
for p in ["/sys/devices/virtual/dmi/id/product_name","/sys/firmware/devicetree/base/model"]:
    try:
        product += Path(p).read_text(errors="replace").strip("\x00") + " "
    except Exception:
        pass

mem_gb = None
try:
    mem_gb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
except Exception:
    pass
disk_gb = shutil.disk_usage(Path.cwd()).free / 1024**3

checks = {
    "architecture_arm64": {"status":"PASS" if arch in {"aarch64","arm64"} else "FAIL", "value":arch},
    "nvidia_gpu": {"status":"PASS" if smi["ok"] else "FAIL"},
    "docker": {"status":"PASS" if docker_info["ok"] else "FAIL"},
    "docker_gpu_runtime": {"status":"PASS" if docker_info["ok"] and ("nvidia" in docker_info["stdout"].lower() or "nvidia" in docker_info["stderr"].lower()) else "NOT_TESTED", "note":"Read-only preflight never pulls a test image."},
    "python": {"status":"PASS" if python_ver else "FAIL","value":python_ver},
    "node": {"status":"PASS" if node_ver else "FAIL","value":node_ver},
    "memory": {"status":"PASS" if mem_gb is not None and mem_gb >= float(os.getenv("SPARK_MIN_MEMORY_GB","100")) else "FAIL","gb":mem_gb},
    "disk": {"status":"PASS" if disk_gb >= float(os.getenv("SPARK_MIN_DISK_GB","180")) else "FAIL","free_gb":disk_gb},
    "ports": {"status":"PASS" if all(port_free(p) for p in ports) else "FAIL","busy":[p for p in ports if not port_free(p)]},
}
checks["network"] = {name: network(url) for name,url in {
    "github":"https://github.com",
    "huggingface":"https://huggingface.co",
    "ngc":"https://nvcr.io/v2/",
    "npm":"https://registry.npmjs.org/",
    "pypi":"https://pypi.org/",
}.items()}
checks["credentials"] = {name:("present" if os.getenv(name) else "missing") for name in [
    "HF_TOKEN","NGC_API_KEY","NVIDIA_API_KEY","NVIDIA_INFERENCE_API_KEY"
]}

versions = {
    "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "architecture": arch,
    "product_identity": product.strip() or None,
    "kernel": platform.release(),
    "docker": docker_version,
    "python": python_ver,
    "node": node_ver,
}
report = {
    "captured_at": versions["captured_at"],
    "system": {
        "uname": uname["stdout"].strip(),
        "os_release": os_release,
        "nvidia_smi": smi["stdout"].strip() or smi["stderr"].strip(),
        "docker_info": docker_info["stdout"].strip() or docker_info["stderr"].strip(),
        "free": free["stdout"].strip() or free["stderr"].strip(),
        "df": df["stdout"].strip() or df["stderr"].strip(),
        "lsblk": lsblk["stdout"].strip() or lsblk["stderr"].strip(),
    },
    "checks": checks,
}
(out/"preflight.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
(out/"versions.json").write_text(json.dumps(versions,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps({"architecture":checks["architecture_arm64"],"gpu":checks["nvidia_gpu"],"docker":checks["docker"],"docker_gpu_runtime":checks["docker_gpu_runtime"],"ports":checks["ports"],"credentials":checks["credentials"]},ensure_ascii=False,indent=2))
# Node is deliberately not a hard preflight gate: install.sh can bootstrap a
# pinned Node 22 runtime after hardware validation. Python is needed to run the
# installer itself, so it remains hard.
hard = ["architecture_arm64","nvidia_gpu","docker","python","memory","disk","ports"]
failed = [k for k in hard if checks[k]["status"] == "FAIL"]
if failed and not report_only:
    print("preflight failed: "+",".join(failed), file=sys.stderr)
    raise SystemExit(1)
PY
