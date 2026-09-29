#!/usr/bin/env python3
"""Build a complete report from retained Interview Observer Harbor trials."""

from __future__ import annotations

import json
import os
import shutil
import uuid
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

from skillevaluator import __version__
from skillevaluator.evaluation.tier3_report import render_agent_eval_html_report
from skillevaluator.tier3.harbor.collector import (
    DEFAULT_METRICS,
    _entry_id,
    _extract_rewards,
    _overall_score,
    _partition_scoreable_rewards,
    collect_harbor_results,
)
from skillevaluator.tier3.harbor.metrics import metric_value
from skillevaluator.tier3.harbor.runner import _persist_dataset_truth
from skillevaluator.tier3.output_provenance import write_output_file_atomically


WORKSPACE = Path(__file__).resolve().parents[10]
SOURCE_RUN = WORKSPACE / "docs/07-reports/skills/tier3/2026-09-28/interview-observer/interview-observer/20260929_012401_99240_ca298aac18a1"
RECOVERY = SOURCE_RUN / "_recovery-logs/optimized-router-transition"
AGENT_MODEL = "openai/qwen3.6-35b-a3b"
JUDGE_MODEL = "step-5-preview"
PASS_THRESHOLD = 0.70
ATTEMPTS = 2
EXPECTED_TRIALS = 18
CONDITIONS = ("with", "without")
SOURCES = {
    "with": [
        SOURCE_RUN / "_harbor-jobs/interview-observer-opencode-with",
        RECOVERY / "jobs/final-batch/interview-observer-router-final-with",
    ],
    "without": [
        SOURCE_RUN / "_harbor-jobs/interview-observer-opencode-without",
        RECOVERY / "jobs/final-batch/interview-observer-router-final-without",
    ],
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def select_trials(condition: str, case_ids: list[str]):
    selected: dict[str, tuple[Path, dict]] = {}
    excluded = []
    for source in SOURCES[condition]:
        good, bad = _partition_scoreable_rewards(_extract_rewards(source))
        excluded.extend(
            {"source_job": str(source), "trial": row.get("trial"), "reason": row.get("reason"), "score": None}
            for row in bad
        )
        for reward in good:
            trial = str(reward.get("_trial_root_name") or "")
            if not trial or trial in selected:
                raise RuntimeError(f"Missing or duplicate successful trial id: {trial!r}")
            selected[trial] = (source, reward)
    coverage = Counter(_entry_id(reward, set(case_ids)) for _, reward in selected.values())
    if len(selected) != EXPECTED_TRIALS or set(coverage) != set(case_ids):
        raise RuntimeError(f"Unexpected {condition} scoreable coverage: {len(selected)} trials, {dict(coverage)}")
    if any(count != ATTEMPTS for count in coverage.values()):
        raise RuntimeError(f"Expected exactly {ATTEMPTS} scored trials per case in {condition}: {dict(coverage)}")
    return selected, excluded


def materialize_job(condition: str, selected: dict[str, tuple[Path, dict]], jobs_root: Path) -> Path:
    job_dir = jobs_root / f"interview-observer-opencode-{condition}"
    job_dir.mkdir(parents=True)
    for trial, (source, _) in selected.items():
        shutil.copytree(source / trial, job_dir / trial)

    reward_stats: dict[str, dict[str, list[str]]] = {}
    means = {}
    rows = [reward for _, reward in selected.values()]
    for metric in (*DEFAULT_METRICS, "overall"):
        grouped: dict[str, list[str]] = defaultdict(list)
        values = []
        for reward in rows:
            value = metric_value(reward, metric) if metric != "overall" else _overall_score(reward)
            if value is not None:
                value = float(value)
                values.append(value)
                grouped[format(value, ".15g")].append(str(reward["_trial_root_name"]))
        reward_stats[metric] = dict(grouped)
        means[metric] = sum(values) / len(values) if values else None

    model_key = f"opencode__qwen3.6-35b-a3b__{condition}"
    result = {
        "id": f"offline-complete-aggregate-{condition}",
        "started_at": datetime.now(UTC).isoformat(),
        "updated_at": datetime.now(UTC).isoformat(),
        "finished_at": datetime.now(UTC).isoformat(),
        "n_total_trials": EXPECTED_TRIALS,
        "aggregation_only": True,
        "stats": {
            "n_completed_trials": EXPECTED_TRIALS,
            "n_errored_trials": 0,
            "n_running_trials": 0,
            "n_pending_trials": 0,
            "n_cancelled_trials": 0,
            "n_retries": 0,
            "evals": {
                model_key: {
                    "n_trials": EXPECTED_TRIALS,
                    "n_errors": 0,
                    "metrics": [means],
                    "pass_at_k": {},
                    "reward_stats": reward_stats,
                }
            },
            "cost_usd": None,
        },
    }
    (job_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return job_dir


def main() -> None:
    case_ids = [str(row["id"]) for row in read_json(WORKSPACE / "agent/skills/interview-observer/evals/evals.json")["evals"]]
    if len(case_ids) != 9:
        raise RuntimeError(f"Expected 9 unchanged Interview Observer cases, found {len(case_ids)}")
    selected_by_condition = {}
    excluded_by_condition = {}
    for condition in CONDITIONS:
        selected_by_condition[condition], excluded_by_condition[condition] = select_trials(condition, case_ids)

    # This extra OBS-005 result was completed after the planned batch had already
    # advanced to the same case. Preserve it as evidence, but honor pass@2.
    surplus_job = RECOVERY / "jobs/final-batch-parallel/interview-observer-router-final-without-OBS-005-parallel"
    surplus_rewards, surplus_bad = _partition_scoreable_rewards(_extract_rewards(surplus_job))
    if len(surplus_rewards) != 1 or surplus_bad:
        raise RuntimeError("Expected exactly one successful surplus OBS-005 trial")
    surplus = surplus_rewards[0]

    run_id = f"{datetime.now().astimezone():%Y%m%d_%H%M%S}_{os.getpid()}_{uuid.uuid4().hex[:12]}"
    run_dir = SOURCE_RUN.parent / run_id
    if run_dir.exists():
        raise FileExistsError(run_dir)
    jobs_root = run_dir / "_harbor-jobs"
    jobs_root.mkdir(parents=True)
    jobs = {condition: materialize_job(condition, selected_by_condition[condition], jobs_root) for condition in CONDITIONS}

    original_stats = {}
    for condition in CONDITIONS:
        result_path = SOURCE_RUN / "_harbor-jobs" / f"interview-observer-opencode-{condition}" / "result.json"
        stats = read_json(result_path).get("stats", {})
        original_stats[condition] = {key: stats.get(key) for key in (
            "n_total_trials", "n_completed_trials", "n_errored_trials", "n_pending_trials", "n_cancelled_trials"
        )}

    manifest_path = run_dir / "aggregation_manifest.json"
    manifest = {
        "kind": "offline-retained-trial-aggregation",
        "generated_at": datetime.now(UTC).isoformat(),
        "skill": "interview-observer",
        "evaluator_version": __version__,
        "agent_model": AGENT_MODEL,
        "judge_model": JUDGE_MODEL,
        "judge_endpoint": "https://api.stepfun.com/step_plan/v1/chat/completions",
        "cases": case_ids,
        "attempts_per_case": ATTEMPTS,
        "pass_threshold": PASS_THRESHOLD,
        "aggregation_model_calls": 0,
        "original_harbor_job_stats": original_stats,
        "conditions": {
            condition: {
                "aggregation_job": str(jobs[condition]),
                "scored_trial_ids": sorted(selected_by_condition[condition]),
                "scored_count": len(selected_by_condition[condition]),
                "expected_count": EXPECTED_TRIALS,
                "per_case_scored_attempts": dict(sorted(Counter(
                    _entry_id(reward, set(case_ids)) for _, reward in selected_by_condition[condition].values()
                ).items())),
                "excluded_unscoreable_trials": excluded_by_condition[condition],
                "status": "complete",
            }
            for condition in CONDITIONS
        },
        "prior_incomplete_recovery_job": str(RECOVERY / "jobs/interview-observer-recovery-router-OBS-004"),
        "extra_successful_trial_excluded_by_attempt_cap": {
            "condition": "without",
            "trial_id": str(surplus["_trial_root_name"]),
            "source_job": str(surplus_job),
            "case_id": "OBS-005",
            "overall_score": _overall_score(surplus),
            "reason": "The planned final batch already produced the second OBS-005 score; preserve this extra run without changing the official two-attempt protocol.",
        },
        "status": "COMPLETE: 18 scored attempts in each condition; excluded execution/Judge errors were not scored as zero",
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    results = collect_harbor_results(
        skill_name="interview-observer",
        agents=["opencode"],
        output_dir=run_dir,
        jobs_dir=jobs_root,
        n_attempts=ATTEMPTS,
        pass_threshold=PASS_THRESHOLD,
        stop_on_pass=False,
        expected_cases=len(case_ids),
        expected_case_ids=case_ids,
        expected_trials=EXPECTED_TRIALS,
        env_mode="docker",
        agent_models={"opencode": {"model": AGENT_MODEL, "source": "cli"}},
    )
    dataset_truth = _persist_dataset_truth(run_dir, fallback_task_ids=case_ids)
    run_config = {
        "config_file": "agent/skills/interview-observer/evals/config.yml",
        "harbor": {"environment": {"value": "docker", "source": "retained task configuration"},
                   "n_attempts": ATTEMPTS, "stop_on_pass": False, "n_concurrent": 2, "jobs_retained": True},
        "provider": {"name": "openai-compatible", "model": "qwen3.6-35b-a3b"},
        "judge": {"enabled": True, "provider": "openai-compatible", "model": JUDGE_MODEL,
                  "endpoint": "https://api.stepfun.com/step_plan/v1/chat/completions"},
        "task_source": "evals_json",
        "grading": {"mode": "default"},
        "agents": {"opencode": {"agent": "opencode", "model": AGENT_MODEL, "source": "cli"}},
        "evaluated_source": {"repository": "gwh7078/life-interview-NVDA",
                             "commit": "b6ae58267e6b3e4b6f06926e11fe423bdba8a472"},
        "aggregation": {"kind": "offline-retained-trial-aggregation", "aggregation_model_calls": 0,
                         "manifest": str(manifest_path), "source_run": str(SOURCE_RUN)},
    }
    (run_dir / "run_config.json").write_text(json.dumps(run_config, indent=2), encoding="utf-8")
    results.update({
        "skill_name": "interview-observer",
        "run_id": run_id,
        "run_dir": str(run_dir),
        "result_path": str(run_dir / "result.json"),
        "harbor_jobs_dir": str(jobs_root),
        "harbor_jobs_retained": True,
        "evaluated_at": datetime.now(UTC).isoformat(),
        "evaluator_version": __version__,
        "dataset_snapshot": dataset_truth,
        "dataset_snapshot_path": str(run_dir / "dataset_snapshot.json"),
        "dataset_summary": dataset_truth["dataset_summary"],
        "dataset_digest": dataset_truth["dataset_digest"],
        "dataset_digest_algorithm": dataset_truth["dataset_digest_algorithm"],
        "run_config": run_config,
        "aggregation_manifest": str(manifest_path),
        "report_status": "pending",
    })
    report_path = render_agent_eval_html_report(
        WORKSPACE / "agent/skills/interview-observer",
        run_dir,
        env_mode="docker",
        engine_result=results,
        use_llm_judge=False,
    )
    results["report_path"] = str(report_path)
    results["report_status"] = "complete"
    write_output_file_atomically(run_dir / "result.json", json.dumps(results, indent=2).encode("utf-8"))
    print(json.dumps({
        "run_id": run_id,
        "run_dir": str(run_dir),
        "result": str(run_dir / "result.json"),
        "report": str(report_path),
        "execution_status": results.get("execution_status"),
        "conditions": {
            name: {"status": condition.get("execution_status"), "expected": condition.get("expected_attempts"),
                   "scored": condition.get("scored_attempts")}
            for name, condition in results["agents"]["opencode"]["conditions"].items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
