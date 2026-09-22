"""Parse and redact the Node bridge contract without importing NAT."""

from __future__ import annotations

import json
from typing import Any

RESULT_PREFIX = "LIFE_INTERVIEW_NAT_RESULT "


class ResultParseError(ValueError):
    """Raised when the Node bridge did not emit its final result line."""


def parse_result(stdout: str) -> dict[str, Any]:
    """Return the last bridge result from stdout."""

    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith(RESULT_PREFIX):
            continue
        try:
            value = json.loads(line[len(RESULT_PREFIX) :])
        except json.JSONDecodeError as exc:
            raise ResultParseError("NAT runner result is not valid JSON") from exc
        if not isinstance(value, dict):
            raise ResultParseError("NAT runner result must be a JSON object")
        return value
    raise ResultParseError("NAT runner result line is missing")


def public_result(value: dict[str, Any]) -> dict[str, Any]:
    """Keep only safe aggregate fields for reports and evaluator reasoning."""

    runtime = value.get("runtime") if isinstance(value.get("runtime"), dict) else {}
    metrics = value.get("metrics") if isinstance(value.get("metrics"), dict) else {}
    validation = value.get("validation") if isinstance(value.get("validation"), dict) else {}
    return {
        "case_id": value.get("case_id"),
        "run_id": value.get("run_id"),
        "task_type": value.get("task_type"),
        "mode": value.get("mode"),
        "status": value.get("status"),
        "runtime": {
            "provider": runtime.get("provider"),
            "model": runtime.get("model"),
        },
        "metrics": {
            key: metrics.get(key)
            for key in (
                "latency_ms",
                "attempt_count",
                "repair_count",
                "format_repair_used",
                "tool_call_count",
                "script_call_count",
            )
            if key in metrics
        },
        "validation": {
            key: validation.get(key)
            for key in (
                "contract_valid",
                "backend_validation",
                "semantic_valid",
                "semantic_checks",
            )
            if key in validation
        },
    }
