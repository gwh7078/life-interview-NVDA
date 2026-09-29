#!/usr/bin/env python3
"""Small local OpenAI-compatible relay for the retained NVDA SkillEvaluator run."""

from __future__ import annotations

import hmac
import json
import os
import threading
import time
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


HOST = "0.0.0.0"
PORT = 65410
MAX_CONCURRENT = 4
MAX_QUEUE_WAIT_SECONDS = 45
UPSTREAM_TIMEOUT_SECONDS = 180
BAILIAN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
STEPFUN_COMPLETIONS = "https://api.stepfun.com/step_plan/v1/chat/completions"
EVENTS = Path(__file__).with_name("provider-router-events.jsonl")
MAX_BODY_BYTES = 64 * 1024 * 1024


def load_local_env() -> dict[str, str]:
    values = dict(os.environ)
    env_path = Path(__file__).resolve().parents[11] / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.removeprefix("export ").strip()
            value = value.strip().strip("\"'")
            values.setdefault(key, value)
    missing = [key for key in ("BAILIAN_API_KEY", "STEPFUN_API_KEY", "ROUTER_AUTH_TOKEN") if not values.get(key)]
    if missing:
        raise RuntimeError("Missing required local setting(s): " + ", ".join(missing))
    return values


CONFIG = load_local_env()
AUTH_TOKEN = CONFIG["ROUTER_AUTH_TOKEN"]
UPSTREAM_KEYS = {
    "agent": CONFIG["BAILIAN_API_KEY"],
    "judge": CONFIG["STEPFUN_API_KEY"],
}
GATE = threading.BoundedSemaphore(MAX_CONCURRENT)
STATE_LOCK = threading.Lock()
EVENT_LOCK = threading.Lock()
IN_FLIGHT = 0


def emit_event(event: str, **fields: object) -> None:
    record = {"time": datetime.now(UTC).isoformat(), "event": event, **fields}
    with EVENT_LOCK:
        with EVENTS.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")


class RouterHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        token = supplied[7:] if supplied.startswith("Bearer ") else ""
        return bool(token) and hmac.compare_digest(token, AUTH_TOKEN)

    def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"))

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._json(200, {"status": "ok", "max_concurrent": MAX_CONCURRENT})
            return
        if not self._authorized():
            self._json(401, {"error": {"message": "Unauthorized", "type": "authentication_error"}})
            return
        if path == "/v1/models":
            self._json(200, {"object": "list", "data": [
                {"id": "qwen3.6-35b-a3b", "object": "model", "owned_by": "bailian"},
                {"id": "step-5-preview", "object": "model", "owned_by": "stepfun"},
            ]})
            return
        self._json(404, {"error": {"message": "Unknown route", "type": "invalid_request_error"}})

    def do_POST(self) -> None:
        if not self._authorized():
            self._json(401, {"error": {"message": "Unauthorized", "type": "authentication_error"}})
            return
        route_path = urlsplit(self.path).path
        if route_path not in {"/v1/chat/completions", "/v1/responses"}:
            self._json(404, {"error": {"message": "Unknown route", "type": "invalid_request_error"}})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > MAX_BODY_BYTES:
                raise ValueError("request size is outside the allowed range")
            body = self.rfile.read(size)
            payload = json.loads(body)
            requested_model = str(payload.get("model", ""))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
            self._json(400, {"error": {"message": str(error), "type": "invalid_request_error"}})
            return

        model = requested_model.removeprefix("openai/")
        if model == "step-5-preview" and route_path == "/v1/chat/completions":
            route = "judge"
            upstream_url = STEPFUN_COMPLETIONS
        elif model == "qwen3.6-35b-a3b":
            route = "agent"
            upstream_url = BAILIAN_BASE + route_path.removeprefix("/v1")
        else:
            self._json(400, {"error": {"message": "Model or endpoint is not configured", "type": "invalid_request_error"}})
            return

        queued_at = time.monotonic()
        acquired = GATE.acquire(timeout=MAX_QUEUE_WAIT_SECONDS)
        queue_ms = round((time.monotonic() - queued_at) * 1000)
        if not acquired:
            emit_event("provider_call", route=route, path=route_path, requested_model=model,
                       upstream_model=model, status=503, elapsed_ms=0, queue_ms=queue_ms,
                       concurrent=MAX_CONCURRENT, error="router capacity wait exceeded")
            self._json(503, {"error": {"message": "Provider router is at capacity", "type": "server_error"}})
            return

        global IN_FLIGHT
        with STATE_LOCK:
            IN_FLIGHT += 1
            concurrent_at_start = IN_FLIGHT
        emit_event("provider_start", route=route, upstream_model=model,
                   queue_ms=queue_ms, concurrent=concurrent_at_start)
        started = time.monotonic()
        status = 502
        response_body = b""
        content_type = "application/json"
        error_text = ""
        try:
            upstream = Request(
                upstream_url,
                data=body,
                headers={
                    "Authorization": "Bearer " + UPSTREAM_KEYS[route],
                    "Content-Type": "application/json",
                    "Accept": self.headers.get("Accept", "application/json"),
                    "Accept-Encoding": "identity",
                },
                method="POST",
            )
            try:
                with urlopen(upstream, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
                    status = response.status
                    response_body = response.read()
                    content_type = response.headers.get("Content-Type", content_type)
            except HTTPError as response:
                status = response.code
                response_body = response.read()
                content_type = response.headers.get("Content-Type", content_type)
            except Exception as error:
                error_text = type(error).__name__ + ": " + str(error)[:240]
                response_body = json.dumps({"error": {"message": "Upstream provider request failed",
                                                        "type": "server_error"}}).encode("utf-8")
        finally:
            elapsed_ms = round((time.monotonic() - started) * 1000)
            with STATE_LOCK:
                IN_FLIGHT -= 1
            emit_event("provider_call", route=route, path=route_path, requested_model=model,
                       upstream_model=model, returned_model=None, status=status, elapsed_ms=elapsed_ms,
                       queue_ms=queue_ms, concurrent=concurrent_at_start,
                       **({"error": error_text} if error_text else {}))
            GATE.release()
        self._send(status, response_body, content_type)


class RouterServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    server = RouterServer((HOST, PORT), RouterHandler)
    print(f"parallel provider router listening on {HOST}:{PORT}; concurrency={MAX_CONCURRENT}; upstream_timeout={UPSTREAM_TIMEOUT_SECONDS}s",
          flush=True)
    server.serve_forever(poll_interval=0.5)
