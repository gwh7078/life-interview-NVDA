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
