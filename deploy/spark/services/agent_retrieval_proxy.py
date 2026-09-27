#!/usr/bin/env python3
"""Private reverse proxy for the two signed formal-Agent retrieval routes.

Request and response bodies are never logged. The product backend remains
loopback-only and the OpenShell policy can target only this private listener.
"""
import http.client
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("SPARK_AGENT_RETRIEVAL_BIND_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPARK_AGENT_RETRIEVAL_PORT", "4175"))
UPSTREAM_HOST = os.environ.get("SPARK_BACKEND_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("SPARK_BACKEND_PORT", "4174"))
MAX_BODY = int(os.environ.get("SPARK_AGENT_RETRIEVAL_MAX_BODY_BYTES", "65536"))
ALLOWED = {
    "/internal/agent-retrieval/memory-search",
    "/internal/agent-retrieval/era-context-search",
}

class Handler(BaseHTTPRequestHandler):
    server_version = "LifeInterviewRetrievalProxy/1"

    def _json(self, status, body):
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "agent-retrieval-proxy"})
        else:
            self._json(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        if self.path not in ALLOWED:
            self._json(404, {"error": "NOT_FOUND"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self._json(400, {"error": "INVALID_CONTENT_LENGTH"})
            return
        if length <= 0 or length > MAX_BODY:
            self._json(413 if length > MAX_BODY else 400, {"error": "INVALID_BODY_SIZE"})
            return
        body = self.rfile.read(length)
        authorization = self.headers.get("authorization")
        if not authorization:
            self._json(401, {"error": "MISSING_AUTHORIZATION"})
            return
        connection = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=15)
        try:
            connection.request("POST", self.path, body=body, headers={
                "authorization": authorization,
                "content-type": self.headers.get("content-type", "application/json"),
                "accept": "application/json",
            })
            response = connection.getresponse()
            payload = response.read(MAX_BODY + 1)
            if len(payload) > MAX_BODY:
                self._json(502, {"error": "UPSTREAM_RESPONSE_TOO_LARGE"})
                return
            self.send_response(response.status)
            self.send_header("content-type", response.getheader("content-type", "application/json"))
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            self._json(502, {"error": "UPSTREAM_UNAVAILABLE"})
        finally:
            connection.close()

    def log_message(self, fmt, *args):
        # BaseHTTPRequestHandler's line contains method/path/status only.
        print(fmt % args, flush=True)

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
