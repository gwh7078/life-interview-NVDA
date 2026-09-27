"""Thin NAT function that invokes the real TypeScript Agent bridge."""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from nat.plugin_api import Builder, FunctionBaseConfig, FunctionInfo, register_function

from .result_parser import parse_result


class LifeInterviewAgentConfig(FunctionBaseConfig, name="life_interview_agent"):
    """Configuration for the subprocess boundary."""

    project_root: str = "."
    timeout_seconds: float = 420.0


def _case_id(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("case_id")
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = value
        if isinstance(parsed, dict):
            value = parsed.get("case_id")
        else:
            value = parsed
    if not isinstance(value, str) or not value.strip():
        raise ValueError("NAT input must contain a case_id")
    return value.strip()


def _safe_diagnostic(value: str) -> str:
    return re.sub(
        r"(Bearer\s+[^\s\"']+|(?:API_KEY|TOKEN|PASSWORD|SECRET)=[^\s&]+)",
        "<redacted>",
        value,
        flags=re.IGNORECASE,
    )


def _invoke(config: LifeInterviewAgentConfig, case_id: str) -> str:
    root = Path(config.project_root).expanduser().resolve()
    command = [
        "bash",
        "scripts/codex-node.sh",
        "node",
        "--env-file-if-exists=.env",
        "--import",
        "tsx",
        "scripts/nat-agent-runner.ts",
    ]
    completed = subprocess.run(
        command,
        cwd=root,
        input=json.dumps({"case_id": case_id}) + "\n",
        capture_output=True,
        text=True,
        timeout=config.timeout_seconds,
        check=False,
        env=os.environ.copy(),
    )
    try:
        result = parse_result(completed.stdout)
    except ValueError as exc:
        stderr = _safe_diagnostic(completed.stderr[-2000:])
        raise RuntimeError(
            f"NAT Node runner did not emit a result for {case_id}; "
            f"exit={completed.returncode}; stderr={stderr}"
        ) from exc

    # The runner uses a non-zero exit code for an Agent failure, while still
    # emitting the structured failure result. Keep that result in the NAT
    # evaluation stream so the evaluator can score the failure contract.
    return json.dumps(result, ensure_ascii=False)


@register_function(config_type=LifeInterviewAgentConfig)
async def life_interview_agent(config: LifeInterviewAgentConfig, _builder: Builder):
    async def run(value: Any) -> str:
        case_id = _case_id(value)
        return await asyncio.to_thread(_invoke, config, case_id)

    yield FunctionInfo.from_fn(
        run,
        description="Run one synthetic life-interview Agent case through the real NemoClaw/OpenClaw runtime.",
    )
