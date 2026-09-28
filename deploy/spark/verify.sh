#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/spark/lib/common.sh
. "$DIR/lib/common.sh"

ensure_product_dirs
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
evidence_dir="$SPARK_DIAGNOSTICS_DIR/verify-runs/$run_id"
mkdir -p "$evidence_dir"
if "$DIR/check-env.sh" >"$evidence_dir/check-env.log" 2>&1; then
  check_exit=0
else
  check_exit=$?
fi
export SPARK_VERIFY_CHECK_LOG="$evidence_dir/check-env.log"
python3 - "$REPO_ROOT" "$evidence_dir" "$DATABASE_PATH" "$check_exit" <<'PY'
import datetime, json, os, platform, re, shutil, subprocess, sys, time
from pathlib import Path

root, evidence, database = map(Path, sys.argv[1:4])
check_exit = int(sys.argv[4])
check_text = Path(os.environ["SPARK_VERIFY_CHECK_LOG"]).read_text(encoding="utf-8", errors="replace")
evidence.mkdir(parents=True, exist_ok=True)

def command(args, timeout=900):
    return subprocess.run(args, cwd=root, text=True, capture_output=True,
                          timeout=timeout, env=os.environ.copy(), check=False)

def endpoint_pass(label):
    return any(line.startswith("PASS:") and label.lower() in line.lower()
               for line in check_text.splitlines())

def physical_spark():
    if platform.machine().lower() not in {"aarch64", "arm64"} or not shutil.which("nvidia-smi"):
        return False
    result = command(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], timeout=10)
    return result.returncode == 0 and "GB10" in result.stdout.upper()

is_spark = physical_spark()
rows = []

def record(gid, name, status, output="", duration_ms=0):
    safe = re.sub(r"(?i)(authorization:?\s*bearer\s+)[^\s]+", r"\1[REDACTED]", output)
    safe = re.sub(r"\b(?:nvapi-|sk-)[A-Za-z0-9_-]{8,}\b", "[REDACTED]", safe)
    path = evidence / f"{gid}.log"
    path.write_text((safe.strip() or status) + "\n", encoding="utf-8")
    rows.append({"id": gid, "name": name, "status": status,
                 "duration_ms": duration_ms, "evidence_file": str(path.relative_to(root))})

def gate(gid, name, args, timeout=900, needs=()):
    if not is_spark:
        record(gid, name, "NOT TESTED ON DGX SPARK", "Physical DGX Spark GB10 host not detected.")
        return
    missing = [label for label in needs if not endpoint_pass(label)]
    if missing:
        record(gid, name, "EXTERNAL RUNTIME NOT READY", "Unavailable endpoint checks: " + ", ".join(missing))
        return
    started = time.monotonic()
    try:
        result = command(args, timeout=timeout)
        output = (result.stdout or "") + (("\n" + result.stderr) if result.stderr else "")
        record(gid, name, "PASS" if result.returncode == 0 else "FAIL",
               output or f"exit={result.returncode}", round((time.monotonic() - started) * 1000))
    except subprocess.TimeoutExpired:
        record(gid, name, "FAIL", f"Timed out after {timeout}s", round((time.monotonic() - started) * 1000))

if not is_spark:
    record("G0", "DGX Spark host prerequisites", "NOT TESTED ON DGX SPARK",
           "Requires ARM64, a detected NVIDIA GB10 GPU, and Docker.")
else:
    required = ("ARM64", "NVIDIA GPU", "Docker daemon")
    missing = [label for label in required if not endpoint_pass(label)]
    record("G0", "DGX Spark host prerequisites", "FAIL" if missing else "PASS",
           "Missing checks: " + ", ".join(missing) if missing else check_text)

if not is_spark:
    record("G0R", "External Runtime endpoint readiness", "NOT TESTED ON DGX SPARK",
           "The Spark profile is not running on detected DGX Spark GB10 hardware.")
elif check_exit == 0:
    record("G0R", "External Runtime endpoint readiness", "PASS", check_text)
else:
    failed_lines = [line for line in check_text.splitlines()
                    if line.startswith(("FAIL:", "EXTERNAL RUNTIME NOT READY:"))]
    status = "FAIL" if any(line.startswith("FAIL:") for line in failed_lines) \
        else "EXTERNAL RUNTIME NOT READY"
    record("G0R", "External Runtime endpoint readiness", status,
           "Required readiness checks failed:\n" + "\n".join(failed_lines))

gate("G1", "Backend + Web + SQLite", [
    "python3", "-c",
    "import os,sqlite3,urllib.request; "
    "p=os.environ['DATABASE_PATH']; "
    "db=sqlite3.connect('file:'+p+'?mode=ro',uri=True); "
    "assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; db.close(); "
    "base='http://127.0.0.1:'+os.environ['SPARK_BACKEND_PORT']; "
    "urllib.request.urlopen(base+'/api/health',timeout=8).read(); "
    "urllib.request.urlopen(base+'/',timeout=8).read()"
], timeout=30)

gate("G2", "Text model connection", [
    "python3", "deploy/spark/lib/openai-smoke.py",
    os.environ.get("TEXT_MODEL_BASE_URL", ""), os.environ.get("TEXT_MODEL", ""),
], timeout=180, needs=("Text endpoint and served model",))

gate("G3", "Coach model connection", [
    "python3", "deploy/spark/lib/openai-smoke.py",
    os.environ.get("REALTIME_COACH_BASE_URL", ""), os.environ.get("REALTIME_COACH_MODEL", ""),
], timeout=180, needs=("Coach endpoint and served model",))

fixture = Path(os.environ.get("SPARK_REALTIME_FIXTURE", "runtime/benchmarks/spark/fixtures/speech-short.wav"))
if not fixture.is_absolute():
    fixture = root / fixture
if not is_spark:
    record("G4", "Realtime Provider + StepAudio integration",
           "NOT TESTED ON DGX SPARK", "Physical DGX Spark GB10 host not detected.")
elif not endpoint_pass("StepAudio WebSocket"):
    record("G4", "Realtime Provider + StepAudio integration", "EXTERNAL RUNTIME NOT READY",
           "StepAudio WebSocket endpoint did not pass the external readiness check.")
elif not fixture.is_file():
    record("G4", "Realtime Provider + StepAudio integration", "NOT TESTED",
           f"Speech fixture not found: {fixture}; set SPARK_REALTIME_FIXTURE to a speech WAV.")
else:
    gate("G4", "Realtime Provider + StepAudio integration", [
        "bash", "scripts/codex-node.sh", "node", "--env-file-if-exists=deploy/spark/.env",
        "--import", "tsx", "scripts/spark-realtime-bridge-smoke.ts", "--fixture", str(fixture),
    ], timeout=600, needs=("StepAudio WebSocket",))

gate("G5", "Retriever + transcript Evidence contract", [
    "bash", "scripts/codex-node.sh", "npm", "run", "spark:retriever:smoke",
], timeout=420, needs=("NeMo Retriever REST",))

gate("G6", "Era + Memory + Agent retrieval policy", [
    "bash", "-lc",
    "bash scripts/codex-node.sh npm run era:index && "
    "bash scripts/codex-node.sh npm run spark:agent-retrieval:smoke",
], timeout=900, needs=("NeMo Retriever REST",))

sandbox = os.environ.get("NEMOCLAW_SANDBOX", "my-assistant")
model = os.environ.get("AGENT_MODEL_DEFAULT", "")
def verify_agent_runtime():
    name = "NemoClaw + OpenClaw + Skills + model route"
    if not is_spark:
        record("G7", name, "NOT TESTED ON DGX SPARK", "Physical DGX Spark GB10 host not detected.")
        return
    if not shutil.which("nemoclaw"):
        record("G7", name, "FAIL", "nemoclaw CLI is unavailable.")
        return
    started = time.monotonic()
    try:
        status = command(["nemoclaw", sandbox, "status", "--json"], timeout=60)
        data = json.loads(status.stdout)
        if status.returncode or data.get("found") is not True or str(data.get("phase", "")).lower() not in {"ready", "running"}:
            raise RuntimeError("NemoClaw sandbox is not RUNNING.")
        if data.get("provider") != "vllm-local" or data.get("model") != model:
            raise RuntimeError("OpenClaw inference route does not match the configured Text model.")
        expected_route = {"provider": "vllm-local", "model": model}
        for route_name in ("recordedRoute", "liveRoute"):
            route = data.get(route_name)
            if not isinstance(route, dict) or any(route.get(key) != value for key, value in expected_route.items()):
                raise RuntimeError(f"OpenClaw {route_name} does not match the configured Text model.")
        if data.get("routeDrift"):
            raise RuntimeError("NemoClaw reports inference route drift.")
        openclaw = command(["nemoclaw", sandbox, "exec", "--", "openclaw", "--version"], timeout=30)
        if openclaw.returncode:
            raise RuntimeError("OpenClaw is not installed or not available in the sandbox.")
        agents = command(["nemoclaw", sandbox, "config", "get", "--key", "agents.list", "--format", "json"], timeout=60)
        if agents.returncode or "realtime-context" not in agents.stdout:
            raise RuntimeError("realtime-context Agent is not configured.")
        skills = ("onboarding-closeout", "interview-closeout", "interview-observer",
                  "story-completion", "story-generation")
        for skill in skills:
            result = command(["nemoclaw", sandbox, "exec", "--", "test", "-f",
                              f"/sandbox/.openclaw/workspace/skills/{skill}/SKILL.md"], timeout=30)
            if result.returncode:
                raise RuntimeError(f"Formal Skill is missing: {skill}")
        observer = command(["nemoclaw", sandbox, "exec", "--", "test", "-f",
                            "/sandbox/.openclaw/workspace-realtime-context/skills/interview-observer/SKILL.md"], timeout=30)
        if observer.returncode:
            raise RuntimeError("interview-observer is missing from realtime-context.")
        record("G7", name, "PASS",
               f"phase={data.get('phase')} provider=vllm-local model={model}; "
               "realtime-context and five formal Skills verified.",
               round((time.monotonic() - started) * 1000))
    except Exception as error:
        record("G7", name, "FAIL", str(error), round((time.monotonic() - started) * 1000))

verify_agent_runtime()

gate("G8", "Closeout + Completion + Generation + Contributor + Memory tests",
     ["bash", "scripts/codex-node.sh", "npm", "test"], timeout=1800)

gate("G9", "NAT evaluation", [
    "bash", "scripts/codex-node.sh", "npm", "run", "test:agent:nat:smoke",
], timeout=1200, needs=("Text endpoint and served model",))

if not is_spark:
    record("G10", "Technical Observer", "NOT TESTED ON DGX SPARK",
           "Physical DGX Spark GB10 host not detected.")
else:
    started = time.monotonic()
    try:
        telemetry = json.loads(Path(os.environ["SPARK_TELEMETRY_PATH"]).read_text(encoding="utf-8"))
        if telemetry.get("platform") != "dgx-spark":
            raise RuntimeError("Observer telemetry does not identify dgx-spark.")
        if not telemetry.get("system_memory", {}).get("total_bytes"):
            raise RuntimeError("Observer telemetry has no system memory reading.")
        record("G10", "Technical Observer", "PASS", json.dumps(telemetry, ensure_ascii=False),
               round((time.monotonic() - started) * 1000))
    except Exception as error:
        record("G10", "Technical Observer", "FAIL", str(error), round((time.monotonic() - started) * 1000))

try:
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, text=True,
                            capture_output=True, timeout=10).stdout.strip()
except Exception:
    commit = "UNAVAILABLE"

statuses = {row["status"] for row in rows}
if "FAIL" in statuses:
    overall = "FAIL"
elif "NOT TESTED ON DGX SPARK" in statuses:
    overall = "NOT TESTED ON DGX SPARK"
elif "EXTERNAL RUNTIME NOT READY" in statuses:
    overall = "EXTERNAL RUNTIME NOT READY"
elif "NOT TESTED" in statuses:
    overall = "NOT TESTED"
else:
    overall = "PASS"

summary = {
    "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "git_commit": commit, "dgx_spark_gb10_detected": is_spark,
    "external_runtime_check_exit": check_exit, "overall": overall, "gates": rows,
}
(evidence / "verify.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
lines = [
    "# Spark application verification", "",
    f"Result: **{overall}**", "",
    f"- Git commit: {commit}",
    f"- DGX Spark GB10 detected: {str(is_spark).lower()}",
    f"- External endpoint check: {'PASS' if check_exit == 0 else 'NOT READY'}",
    "- Repeat: bash deploy/spark/verify.sh",
    f"- Evidence: {evidence.relative_to(root)}", "",
    "## Gates", "",
    "| Gate | Check | Status | Duration | Evidence |",
    "|---|---|---|---:|---|",
]
for row in rows:
    lines.append(f"| {row['id']} | {row['name']} | {row['status']} | {row['duration_ms']} ms | {row['evidence_file']} |")
report = evidence / "verify.md"
report.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
print(f"\nDetailed report: {report.relative_to(root)}")
raise SystemExit(0 if overall == "PASS" else 1)
PY
