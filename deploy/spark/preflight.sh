#!/usr/bin/env bash
set -euo pipefail
SPARK_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SPARK_DIR/lib/common.sh"
# shellcheck source=lib/ports.sh
. "$SPARK_DIR/lib/ports.sh"

report_only=0
allow_owned_ports=0
allow_busy_ports=()
while (( $# )); do
  case "$1" in
    --report-only) report_only=1; shift ;;
    --allow-owned-ports) allow_owned_ports=1; shift ;;
    --allow-busy-port)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || { echo "--allow-busy-port requires a numeric port" >&2; exit 2; }
      allow_busy_ports+=("$2"); shift 2 ;;
    *) echo "usage: $0 [--report-only] [--allow-owned-ports] [--allow-busy-port PORT ...]" >&2; exit 2 ;;
  esac
done

if (( allow_owned_ports )); then
  running_containers="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
  container_running() { grep -Fqx "$1" <<<"$running_containers"; }
  allow_if_owned() {
    local port="$1" container="${2:-}" process="${3:-}"
    if { [[ -n "$container" ]] && container_running "$container"; } \
      || { [[ -n "$process" ]] && pid_running "$process"; }; then
      allow_busy_ports+=("$port")
    fi
  }
  allow_if_owned "$SPARK_TEXT_PORT" "${SPARK_TEXT_CONTAINER:-life-interview-spark-text}"
  allow_if_owned "$SPARK_COACH_PORT" "${SPARK_COACH_CONTAINER:-life-interview-spark-coach}"
  allow_if_owned "$SPARK_STEPAUDIO_BACKEND_PORT" "${SPARK_STEPAUDIO_CONTAINER:-life-interview-spark-stepaudio}" stepaudio-backend
  allow_if_owned "$SPARK_STEPAUDIO_WS_PORT" "${SPARK_STEPAUDIO_BRIDGE_CONTAINER:-life-interview-spark-stepaudio-bridge}" stepaudio-bridge
  allow_if_owned "$SPARK_STEPAUDIO_HEALTH_PORT" "${SPARK_STEPAUDIO_BRIDGE_CONTAINER:-life-interview-spark-stepaudio-bridge}" stepaudio-bridge
  allow_if_owned "$SPARK_RETRIEVER_PORT" "${SPARK_RETRIEVER_CONTAINER:-life-interview-spark-retriever}"
  allow_if_owned "$SPARK_VECTORDB_PORT" "${SPARK_RETRIEVER_CONTAINER:-life-interview-spark-retriever}"
  allow_if_owned "$SPARK_BACKEND_PORT" "" backend
  allow_if_owned "$SPARK_AGENT_RETRIEVAL_PORT" "" agent-retrieval-proxy
fi
allowed_busy_csv="$(IFS=,; printf '%s' "${allow_busy_ports[*]-}")"

python3 - "$SPARK_DIAGNOSTICS_DIR" "$report_only" "$allowed_busy_csv" \
  "$SPARK_TEXT_PORT" "$SPARK_COACH_PORT" "$SPARK_STEPAUDIO_BACKEND_PORT" "$SPARK_STEPAUDIO_WS_PORT" \
  "$SPARK_STEPAUDIO_HEALTH_PORT" "$SPARK_RETRIEVER_PORT" "$SPARK_VECTORDB_PORT" "$SPARK_BACKEND_PORT" "$SPARK_AGENT_RETRIEVAL_PORT" <<'PY'
import json, os, platform, shutil, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

out = Path(sys.argv[1]); report_only = sys.argv[2] == "1"
allowed_busy = {int(x) for x in sys.argv[3].split(",") if x}
ports = [int(x) for x in sys.argv[4:]]
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
docker_runtime = cmd(["docker","info","--format","{{.DefaultRuntime}}|{{json .Runtimes}}"])
gpu_info = cmd(["nvidia-smi","--query-gpu=name,driver_version","--format=csv,noheader"]) if smi["ok"] else {"ok":False,"stdout":""}
gpu_fields = [part.strip() for part in gpu_info["stdout"].splitlines()[0].split(",",1)] if gpu_info.get("stdout","").strip() else []
python_ver = version(["python3","--version"]) if shutil.which("python3") else None
node_ver = version(["node","--version"]) if shutil.which("node") else None
required_tools = ["curl","git","tar","xz","sha256sum","awk"]
missing_tools = [name for name in required_tools if not shutil.which(name)]
python_venv = cmd(["python3","-c","import venv, ensurepip"]) if shutil.which("python3") else {"ok":False}
native_build_tools = [name for name in ["make","g++"] if shutil.which(name)]
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
    "node": {"status":"PASS" if node_ver else "FAIL","value":node_ver,"note":"Node may be bootstrapped locally by install.sh."},
    "system_tools": {"status":"PASS" if not missing_tools else "FAIL","missing":missing_tools},
    "python_venv": {"status":"PASS" if python_venv.get("ok") else "FAIL"},
    "native_build_tools": {
        "status":"PASS" if len(native_build_tools)==2 else "NOT_TESTED",
        "present":native_build_tools,
        "note":"Only required if an npm native dependency has no matching prebuilt binary.",
    },
    "memory": {"status":"PASS" if mem_gb is not None and mem_gb >= float(os.getenv("SPARK_MIN_MEMORY_GB","100")) else "FAIL","gb":mem_gb},
    "disk": {"status":"PASS" if disk_gb >= float(os.getenv("SPARK_MIN_DISK_GB","180")) else "FAIL","free_gb":disk_gb},
    "ports": {
        "status":"PASS" if all(port_free(p) or p in allowed_busy for p in ports) else "FAIL",
        "busy":[p for p in ports if not port_free(p)],
        "allowed_busy":[p for p in ports if not port_free(p) and p in allowed_busy],
        "unexpected_busy":[p for p in ports if not port_free(p) and p not in allowed_busy],
    },
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

hard = ["architecture_arm64","nvidia_gpu","docker","python","python_venv","system_tools","memory","disk","ports"]
failed = [name for name in hard if checks[name]["status"] == "FAIL"]

versions = {
    "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "architecture": arch,
    "product_identity": product.strip() or None,
    "kernel": platform.release(),
    "docker": docker_version,
    "docker_gpu_runtime": docker_runtime["stdout"].strip() or None,
    "gpu": gpu_fields[0] if gpu_fields else None,
    "driver": gpu_fields[1] if len(gpu_fields) > 1 else None,
    "system_memory_gb": mem_gb,
    "free_disk_gb": disk_gb,
    "python": python_ver,
    "node": node_ver,
    "deployment": {
        "text_model": os.getenv("SPARK_TEXT_MODEL"),
        "vllm_image": os.getenv("SPARK_VLLM_IMAGE"),
        "coach_model": os.getenv("SPARK_COACH_MODEL"),
        "retriever_image": os.getenv("SPARK_RETRIEVER_IMAGE"),
        "stepaudio_image": os.getenv("SPARK_STEPAUDIO_IMAGE"),
        "stepaudio_source_ref": os.getenv("SPARK_STEPAUDIO_SOURCE_REF"),
        "stepaudio_hf_model": os.getenv("SPARK_STEPAUDIO_HF_MODEL"),
    },
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
    "hard_checks": {"required":hard,"failed":failed},
}
(out/"preflight.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
(out/"versions.json").write_text(json.dumps(versions,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps({
    "architecture":checks["architecture_arm64"],
    "gpu":checks["nvidia_gpu"],
    "docker":checks["docker"],
    "docker_gpu_runtime":checks["docker_gpu_runtime"],
    "system_tools":checks["system_tools"],
    "python_venv":checks["python_venv"],
    "ports":checks["ports"],
    "credentials":checks["credentials"],
},ensure_ascii=False,indent=2))
# Node is deliberately not a hard preflight gate: install.sh can bootstrap a
# pinned Node runtime after hardware validation.
if failed and not report_only:
    print("preflight failed: "+",".join(failed), file=sys.stderr)
    raise SystemExit(1)
PY
