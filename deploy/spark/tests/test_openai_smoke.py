import os
import json
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SMOKE = REPO_ROOT / "deploy/spark/lib/openai-smoke.py"
MODEL = "served-test-model"


class OpenAISmokeTest(unittest.TestCase):
    def setUp(self):
        self.requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(inner_self):
                self.requests.append(("GET", inner_self.path, inner_self.headers.get("Authorization")))
                if inner_self.path != "/v1/models":
                    inner_self.send_error(404)
                    return
                body = json.dumps({"data": [{"id": MODEL}]}).encode()
                inner_self.send_response(200)
                inner_self.send_header("Content-Type", "application/json")
                inner_self.send_header("Content-Length", str(len(body)))
                inner_self.end_headers()
                inner_self.wfile.write(body)

            def do_POST(inner_self):
                self.requests.append(("POST", inner_self.path, inner_self.headers.get("Authorization")))
                payload = json.loads(inner_self.rfile.read(int(inner_self.headers["Content-Length"])))
                content = (json.dumps({"ok": True}) if "response_format" in payload else "SPARK_OK")
                body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
                inner_self.send_response(200)
                inner_self.send_header("Content-Type", "application/json")
                inner_self.send_header("Content-Length", str(len(body)))
                inner_self.end_headers()
                inner_self.wfile.write(body)

            def log_message(self, *_args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def run_smoke(self, api_key):
        env = os.environ.copy()
        env["SPARK_OPENAI_API_KEY"] = api_key
        return subprocess.run(
            [sys.executable, str(SMOKE), self.base_url, MODEL],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def test_uses_api_key_for_models_and_chat_without_health_route(self):
        result = self.run_smoke("test-api-key")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("test-api-key", result.args)
        self.assertEqual(
            self.requests,
            [
                ("GET", "/v1/models", "Bearer test-api-key"),
                ("POST", "/v1/chat/completions", "Bearer test-api-key"),
                ("POST", "/v1/chat/completions", "Bearer test-api-key"),
            ],
        )
        self.assertNotIn("health", result.stdout.lower())

    def test_omits_authorization_when_api_key_is_empty(self):
        result = self.run_smoke("")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.requests)
        self.assertTrue(all(auth is None for _, _, auth in self.requests))


if __name__ == "__main__":
    unittest.main()
