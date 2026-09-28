import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
STATUS = ROOT / "deploy/spark/lib/nemoclaw_status.py"
STATUS_SCRIPT = ROOT / "deploy/spark/status.sh"
SANITIZER_PATH = ROOT / "scripts/spark/evidence.py"
spec = importlib.util.spec_from_file_location("spark_evidence", SANITIZER_PATH)
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


def valid_status(phase="running"):
    route = {"provider": "vllm-local", "model": "served-model"}
    return {
        "found": True,
        "phase": phase,
        "provider": "vllm-local",
        "model": "served-model",
        "recordedRoute": route,
        "liveRoute": route,
        "routeDrift": False,
    }


class NemoClawStatusTest(unittest.TestCase):
    def validate(self, payload, model=None):
        command = [sys.executable, str(STATUS)]
        if model:
            command += ["--model", model]
        return subprocess.run(command, input=payload, text=True, capture_output=True, check=False)

    def test_ready_and_running_sandbox_pass_with_exact_model_route(self):
        for phase in ("ready", "running"):
            result = self.validate(json.dumps(valid_status(phase)), "served-model")
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_stopped_missing_invalid_json_and_route_drift_fail(self):
        cases = [
            json.dumps(valid_status("stopped")),
            json.dumps({"found": False, "phase": "running"}),
            "not-json",
        ]
        drifted = valid_status()
        drifted["liveRoute"] = {"provider": "vllm-local", "model": "other-model"}
        cases += [json.dumps(drifted)]
        for payload in cases:
            with self.subTest(payload=payload):
                self.assertNotEqual(self.validate(payload, "served-model").returncode, 0)

    def run_status(self, payload, fail_command=False):
        with tempfile.TemporaryDirectory(prefix="spark-status-test-") as temp:
            root = Path(temp)
            bindir = root / "bin"
            bindir.mkdir()
            fake_cli = bindir / "nemoclaw"
            fake_cli.write_text(
                "#!/bin/sh\n"
                "[ \"${FAKE_NEMOCLAW_FAIL:-false}\" = true ] && exit 7\n"
                "printf '%s\\n' \"$FAKE_NEMOCLAW_STATUS\"\n",
                encoding="utf-8",
            )
            fake_cli.chmod(0o755)
            env_file = root / "spark.env"
            env_file.write_text(
                "TEXT_MODEL_BASE_URL=http://127.0.0.1:8000/v1\n"
                "REALTIME_COACH_BASE_URL=http://127.0.0.1:8001/v1\n"
                "NEMO_RETRIEVER_BASE_URL=http://127.0.0.1:7670\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            env.update({
                "PATH": f"{bindir}:{env.get('PATH', '')}",
                "HOME": str(root / "home"),
                "SPARK_ENV_FILE": str(env_file),
                "SPARK_HOME": str(root / "home"),
                "SPARK_PID_DIR": str(root / "pids"),
                "SPARK_DIAGNOSTICS_DIR": str(root / "diagnostics"),
                "SPARK_LOG_DIR": str(root / "logs"),
                "SPARK_BENCH_DIR": str(root / "benchmarks"),
                "DATABASE_PATH": str(root / "data.sqlite"),
                "FAKE_NEMOCLAW_STATUS": payload,
                "FAKE_NEMOCLAW_FAIL": "true" if fail_command else "false",
            })
            result = subprocess.run(
                ["bash", str(STATUS_SCRIPT)], cwd=ROOT, env=env,
                capture_output=True, text=True, timeout=15, check=False,
            )
            row = next(line for line in result.stdout.splitlines()
                       if line.startswith("NemoClaw / OpenClaw"))
            return result, row

    def test_status_reports_running_only_for_found_ready_sandbox(self):
        ready, ready_row = self.run_status(json.dumps(valid_status("ready")))
        self.assertEqual(ready.returncode, 0, ready.stderr)
        self.assertTrue(ready_row.endswith("RUNNING"), ready_row)

        stopped, stopped_row = self.run_status(json.dumps(valid_status("stopped")))
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertTrue(stopped_row.endswith("NOT READY"), stopped_row)
        self.assertFalse(stopped_row.endswith("RUNNING"), stopped_row)

        command_error, error_row = self.run_status("{}", fail_command=True)
        self.assertEqual(command_error.returncode, 0, command_error.stderr)
        self.assertTrue(error_row.endswith("NOT READY"), error_row)


class EvidenceSanitizerTest(unittest.TestCase):
    def test_redacts_bearer_and_common_secret_assignments(self):
        raw = (
            'Authorization: Bearer auth-secret Bearer loose-secret '
            'api_key=key-secret api-key: hyphen-secret token=token-secret '
            'password="pass-secret" secret=secret-value sk-live-secret nvapi-live-secret'
        )
        safe = evidence.sanitize_text(raw)
        for secret in (
            "auth-secret", "loose-secret", "key-secret", "hyphen-secret",
            "token-secret", "pass-secret", "secret-value", "sk-live-secret",
            "nvapi-live-secret",
        ):
            self.assertNotIn(secret, safe)
        self.assertGreaterEqual(safe.count("[REDACTED]"), 9)

    def test_redacts_prefixed_environment_names_and_json_secret_fields(self):
        raw = (
            'TEXT_MODEL_API_KEY=env-text-secret '
            'NEMO_RETRIEVER_API_TOKEN=env-retriever-secret '
            '"api_key":"json-text-secret" '
            '{"REALTIME_COACH_API_KEY": "json-coach-secret"}'
        )
        safe = evidence.sanitize_text(raw)
        for secret in (
            "env-text-secret", "env-retriever-secret", "json-text-secret",
            "json-coach-secret",
        ):
            self.assertNotIn(secret, safe)
        self.assertEqual(safe.count("[REDACTED]"), 4)


if __name__ == "__main__":
    unittest.main()
