#!/usr/bin/env python3
"""Rebuild an explicitly incomplete Story Completion report from retained Harbor trials."""

from __future__ import annotations

import json
import shutil
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

from skillevaluator import __version__
from skillevaluator.evaluation.tier3_report import render_agent_eval_html_report
from skillevaluator.tier3.harbor.collector import (
    DEFAULT_METRICS,
    _entry_id,
    _extract_rewards,
    _failed_judge_diagnostic,
    _overall_score,
    _partition_scoreable_rewards,
    collect_harbor_results,
)
from skillevaluator.tier3.harbor.metrics import metric_value
from skillevaluator.tier3.harbor.runner import _persist_dataset_truth
from skillevaluator.tier3.output_provenance import write_output_file_atomically


WORKSPACE = Path(__file__).resolve().parents[11]
RUN_DIR = WORKSPACE / "docs/07-reports/skills/tier3/2026-09-28/story-completion/story-completion/20260928_202654_70776_0744e22a2e0a"
MAIN_JOBS = RUN_DIR / "_harbor-jobs"
RECOVERY = RUN_DIR / "_recovery-logs/optimized-router-transition"
AGGREGATION_DIR = RECOVERY / "aggregation/generated"
MERGED_JOBS = AGGREGATION_DIR / "_harbor-jobs"
AGENT_MODEL = "openai/qwen3.6-35b-a3b"
JUDGE_MODEL = "step-5-preview"
ATTEMPTS_PER_CASE = 2
PASS_THRESHOLD = 0.70
EXPECTED_TRIALS = 18
ERROR_TRIALS = {
    "with": (MAIN_JOBS / "story-completion-opencode-with", "COMP-002__UhkPzpz"),
    "without": (MAIN_JOBS / "story-completion-opencode-without", "COMP-002__8HDKrLP"),
}
SOURCES = {
    "with": [
        MAIN_JOBS / "story-completion-opencode-with",
        RECOVERY / "validation/jobs/story-completion-router-validation-with",
    ],
    "without": [
        MAIN_JOBS / "story-completion-opencode-without",
        RECOVERY / "validation/jobs/story-completion-router-validation-without",
        RECOVERY / "recovery/jobs/story-completion-router-recovery-without-batch-1",
        RECOVERY / "recovery/jobs/story-completion-router-recovery-without-batch-2",
    ],
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fail_if_existing_outputs() -> None:
    owned = [RUN_DIR / "opencode", RUN_DIR / "result.json", RUN_DIR / "report.html", RUN_DIR / "run_config.json"]
    present = [str(path) for path in owned if path.exists()]
    if present:
        raise RuntimeError("Refusing to replace existing official outputs: " + ", ".join(present))
    if AGGREGATION_DIR.exists():
        raise RuntimeError(f"Refusing to replace existing aggregation evidence: {AGGREGATION_DIR}")


def source_rewards(condition: str, case_ids: list[str]):
    selected: dict[str, tuple[Path, dict]] = {}
    invalid: list[dict] = []
    sources = SOURCES[condition]
    for source in sources:
        raw = _extract_rewards(source)
        good, bad = _partition_scoreable_rewards(raw)
        invalid.extend({"source_job": str(source), **item} for item in bad)
        for reward in good:
            trial = str(reward.get("_trial_root_name") or "")
            if not trial:
                raise RuntimeError(f"Scored reward in {source} lacks a Harbor trial id")
            if trial in selected:
                raise RuntimeError(f"Duplicate successful trial id {trial}")
            selected[trial] = (source, reward)

    error_job, error_trial = ERROR_TRIALS[condition]
    error_dir = error_job / error_trial
    diagnostic = _failed_judge_diagnostic(error_dir)
    if not diagnostic or diagnostic.get("evaluation_status") != "failed":
        raise RuntimeError(f"Expected failed Judge sidecar is unavailable for {error_trial}")
    if diagnostic.get("entry_id") != "COMP-002":
        raise RuntimeError(f"Unexpected failed Judge case for {error_trial}: {diagnostic.get('entry_id')}")
    if len(selected) != 17:
        raise RuntimeError(f"Expected 17 scoreable {condition} trials, found {len(selected)}")
    cases = Counter(_entry_id(reward, set(case_ids)) for _, reward in selected.values())
    cases["COMP-002"] += 1  # The retained failed Judge attempt occupies the other COMP-002 slot.
    if set(cases) != set(case_ids) or any(count != ATTEMPTS_PER_CASE for count in cases.values()):
        raise RuntimeError(f"{condition} logical attempt coverage is not 2 per case: {dict(cases)}")
    return selected, error_dir, diagnostic, invalid


def materialize_condition(condition: str, case_ids: list[str]) -> dict:
    selected, error_source, diagnostic, invalid = source_rewards(condition, case_ids)
    job_name = f"story-completion-opencode-{condition}"
    job_dir = MERGED_JOBS / job_name
    job_dir.mkdir(parents=True)
    for trial, (source_job, _) in selected.items():
        shutil.copytree(source_job / trial, job_dir / trial)
    error_trial = ERROR_TRIALS[condition][1]
    shutil.copytree(error_source, job_dir / error_trial)
    (job_dir / error_trial / "exception.txt").write_text(
        "Retained SkillEvaluator verifier sidecar records evaluation_status=failed. "
        "The accuracy Judge call to step-5-preview timed out; this trial has no score and is not a zero.\n",
        encoding="utf-8",
    )

    score_rows = [reward for _, reward in selected.values()]
    reward_stats: dict[str, dict[str, list[str]]] = {}
    for metric in (*DEFAULT_METRICS, "overall"):
        grouped: dict[str, list[str]] = defaultdict(list)
        for reward in score_rows:
            value = metric_value(reward, metric) if metric != "overall" else _overall_score(reward)
            if value is not None:
                grouped[format(float(value), ".15g")].append(str(reward["_trial_root_name"]))
        reward_stats[metric] = dict(grouped)

    means = {}
    for metric in (*DEFAULT_METRICS, "overall"):
        values = [
            metric_value(reward, metric) if metric != "overall" else _overall_score(reward)
            for reward in score_rows
        ]
        values = [float(value) for value in values if value is not None]
        means[metric] = sum(values) / len(values) if values else None

    model_key = f"opencode__qwen3.6-35b-a3b__{condition}"
    harbor_result = {
        "id": f"offline-aggregate-{condition}",
        "started_at": "2026-09-29T00:00:00Z",
        "updated_at": datetime.now(UTC).isoformat(),
        "finished_at": datetime.now(UTC).isoformat(),
        "n_total_trials": EXPECTED_TRIALS,
        "aggregation_only": True,
        "stats": {
            "n_completed_trials": EXPECTED_TRIALS,
            "n_errored_trials": 1,
            "n_running_trials": 0,
            "n_pending_trials": 0,
            "n_cancelled_trials": 0,
            "n_retries": 0,
            "evals": {
                model_key: {
                    "n_trials": EXPECTED_TRIALS,
                    "n_errors": 1,
                    "metrics": [means],
                    "pass_at_k": {},
                    "reward_stats": reward_stats,
                    "exception_stats": {"LLMJudgeError": [error_trial]},
                }
            },
            "cost_usd": None,
        },
    }
    (job_dir / "result.json").write_text(json.dumps(harbor_result, indent=2), encoding="utf-8")
    return {
        "condition": condition,
        "aggregation_job": str(job_dir),
        "scoreable_trial_ids": sorted(selected),
        "unscoreable_trial": {
            "trial_id": error_trial,
            "source": str(error_source),
            "case_id": diagnostic.get("entry_id"),
            "reason": diagnostic.get("evaluation_errors"),
            "score": None,
        },
        "other_unscoreable_source_trials": invalid,
        "scoreable_count": len(selected),
        "expected_count": EXPECTED_TRIALS,
        "status": "incomplete",
    }


def main() -> None:
    fail_if_existing_outputs()
    case_rows = read_json(WORKSPACE / "agent/skills/story-completion/evals/evals.json")["evals"]
    case_ids = [str(row["id"]) for row in case_rows]
    if len(case_ids) != 9:
        raise RuntimeError(f"Expected 9 Story Completion cases, found {len(case_ids)}")
    AGGREGATION_DIR.mkdir(parents=True)
    MERGED_JOBS.mkdir(parents=True)
    conditions = [materialize_condition(condition, case_ids) for condition in ("with", "without")]

    manifest = {
        "kind": "offline-retained-trial-aggregation",
        "generated_at": datetime.now(UTC).isoformat(),
        "skill": "story-completion",
        "evaluator_version": __version__,
        "agent_model": AGENT_MODEL,
        "judge_model": JUDGE_MODEL,
        "judge_endpoint": "https://api.stepfun.com/step_plan/v1/chat/completions",
        "cases": case_ids,
        "attempts_per_case": ATTEMPTS_PER_CASE,
        "pass_threshold": PASS_THRESHOLD,
        "model_calls": 0,
        "conditions": conditions,
        "status": "INCOMPLETE: one StepFun Judge execution error remains in each condition",
    }
    (AGGREGATION_DIR / "aggregation_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    results = collect_harbor_results(
        skill_name="story-completion",
        agents=["opencode"],
        output_dir=RUN_DIR,
        jobs_dir=MERGED_JOBS,
        n_attempts=ATTEMPTS_PER_CASE,
        pass_threshold=PASS_THRESHOLD,
        stop_on_pass=False,
        expected_cases=len(case_ids),
        expected_case_ids=case_ids,
        expected_trials=EXPECTED_TRIALS,
        env_mode="docker",
        agent_models={"opencode": {"model": AGENT_MODEL, "source": "cli"}},
    )
    dataset_truth = _persist_dataset_truth(RUN_DIR, fallback_task_ids=case_ids)
    run_config = {
        "config_file": "agent/skills/story-completion/evals/config.yml",
        "harbor": {"environment": {"value": "docker", "source": "cli"}, "n_attempts": ATTEMPTS_PER_CASE,
                   "stop_on_pass": False, "n_concurrent": 2, "jobs_retained": True},
        "provider": {"name": "openai-compatible", "model": "qwen3.6-35b-a3b"},
        "judge": {"enabled": True, "provider": "openai-compatible", "model": JUDGE_MODEL,
                  "endpoint": "https://api.stepfun.com/step_plan/v1/chat/completions"},
        "task_source": "evals_json",
        "grading": {"mode": "default"},
        "agents": {"opencode": {"agent": "opencode", "model": AGENT_MODEL, "source": "cli"}},
        "evaluated_source": {"repository": "gwh7078/life-interview-NVDA",
                             "commit": "b6ae58267e6b3e4b6f06926e11fe423bdba8a472"},
        "aggregation": {"kind": "offline-retained-trial-aggregation", "model_calls": 0,
                         "manifest": str(AGGREGATION_DIR / "aggregation_manifest.json")},
    }
    (RUN_DIR / "run_config.json").write_text(json.dumps(run_config, indent=2), encoding="utf-8")
    results.update({
        "skill_name": "story-completion",
        "run_id": RUN_DIR.name,
        "run_dir": str(RUN_DIR),
        "result_path": str(RUN_DIR / "result.json"),
        "harbor_jobs_dir": str(MAIN_JOBS),
        "harbor_jobs_retained": True,
        "evaluated_at": datetime.now(UTC).isoformat(),
        "evaluator_version": __version__,
        "dataset_snapshot": dataset_truth,
        "dataset_snapshot_path": str(RUN_DIR / "dataset_snapshot.json"),
        "dataset_summary": dataset_truth["dataset_summary"],
        "dataset_digest": dataset_truth["dataset_digest"],
        "dataset_digest_algorithm": dataset_truth["dataset_digest_algorithm"],
        "run_config": run_config,
        "aggregation_manifest": str(AGGREGATION_DIR / "aggregation_manifest.json"),
        "report_status": "pending",
    })
    report = render_agent_eval_html_report(
        WORKSPACE / "agent/skills/story-completion",
        RUN_DIR,
        env_mode="docker",
        engine_result=results,
        use_llm_judge=False,
    )
    results["report_path"] = str(report)
    results["report_status"] = "complete"
    results["execution_status"] = "failed"
    results.setdefault("execution_errors", []).append(
        "Incomplete official coverage: the remaining COMP-002 StepFun Judge error must be retried in each condition."
    )
    write_output_file_atomically(RUN_DIR / "result.json", json.dumps(results, indent=2).encode("utf-8"))
    print(json.dumps({"result": str(RUN_DIR / "result.json"), "report": str(report),
                      "execution_status": results.get("execution_status"),
                      "conditions": {name: {"status": value.get("execution_status"),
                                            "expected": value.get("expected_attempts"),
                                            "scored": value.get("scored_attempts")}
                                    for name, value in results["agents"]["opencode"]["conditions"].items()}}, indent=2))


if __name__ == "__main__":
    main()
