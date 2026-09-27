"""Deterministic evaluators for the Node bridge result."""

from __future__ import annotations

from typing import Any


def evaluate_result(result: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    """Score runtime, contract, backend and semantic outcomes without an LLM judge."""

    validation = result.get("validation")
    validation = validation if isinstance(validation, dict) else {}
    checks = validation.get("semantic_checks")
    checks = checks if isinstance(checks, list) else []
    failed_checks = [item for item in checks if isinstance(item, dict) and item.get("passed") is False]

    runtime_ok = result.get("status") == "succeeded"
    contract_ok = validation.get("contract_valid") is True
    semantic_ok = validation.get("semantic_valid") is True
    backend = validation.get("backend_validation")
    backend_ok = backend == "passed"
    passed = runtime_ok and contract_ok and semantic_ok and backend_ok and not failed_checks

    return float(passed), {
        "evaluation_scope": "runtime_contract",
        "runtime_contract_passed": passed,
        "runtime_success": runtime_ok,
        "contract_valid": contract_ok,
        "backend_validation": backend,
        "business_validation_passed": backend == "passed",
        "semantic_valid": semantic_ok,
        "failed_semantic_checks": failed_checks,
    }
