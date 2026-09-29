#!/usr/bin/env python3
"""Build a complete report from retained Story Completion Harbor trials."""

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


WORKSPACE = Path(__file__).resolve().parents[11]
SOURCE_RUN = WORKSPACE / "docs/07-reports/skills/tier3/2026-09-28/story-completion/story-completion/20260928_202654_70776_0744e22a2e0a"
RECOVERY = SOURCE_RUN / "_recovery-logs/optimized-router-transition"
AGENT_MODEL = "openai/qwen3.6-35b-a3b"
JUDGE_MODEL = "step-5-preview"
PASS_THRESHOLD = 0.70
ATTEMPTS = 2
EXPECTED_TRIALS = 18
CONDITIONS = ("with", "without")
SOURCES = {
    "with": [
        SOURCE_RUN / "_harbor-jobs/story-completion-opencode-with",
        RECOVERY / "validation/jobs/story-completion-router-validation-with",
        RECOVERY / "recovery/judge-retries/jobs/story-completion-comp002-judge-retry-with",
    ],
    "without": [
        SOURCE_RUN / "_harbor-jobs/story-completion-opencode-without",
        RECOVERY / "validation/jobs/story-completion-router-validation-without",
        RECOVERY / "recovery/jobs/story-completion-router-recovery-without-batch-1",
        RECOVERY / "recovery/jobs/story-completion-router-recovery-without-batch-2",
        RECOVERY / "recovery/judge-retries/jobs/story-completion-comp002-judge-retry-without",
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
    name = f"story-completion-opencode-{condition}"
    job_dir = jobs_root / name
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
    cases = [str(row["id"]) for row in read_json(WORKSPACE / "agent/skills/story-completion/evals/evals.json")["evals"]]
    if len(cases) != 9:
        raise RuntimeError(f"Expected 9 unchanged Story Completion cases, found {len(cases)}")
    selected_by_condition = {}
    excluded_by_condition = {}
    for condition in CONDITIONS:
        selected_by_condition[condition], excluded_by_condition[condition] = select_trials(condition, cases)

    run_id = f"{datetime.now().astimezone():%Y%m%d_%H%M%S}_{os.getpid()}_{uuid.uuid4().hex[:12]}"
    run_dir = SOURCE_RUN.parent / run_id
    if run_dir.exists():
        raise FileExistsError(run_dir)
    jobs_root = run_dir / "_harbor-jobs"
    jobs_root.mkdir(parents=True)
    jobs = {condition: materialize_job(condition, selected_by_condition[condition], jobs_root) for condition in CONDITIONS}

    manifest_path = run_dir / "aggregation_manifest.json"
    manifest = {
        "kind": "offline-retained-trial-aggregation",
        "generated_at": datetime.now(UTC).isoformat(),
        "skill": "story-completion",
        "evaluator_version": __version__,
        "agent_model": AGENT_MODEL,
        "judge_model": JUDGE_MODEL,
        "judge_endpoint": "https://api.stepfun.com/step_plan/v1/chat/completions",
        "cases": cases,
        "attempts_per_case": ATTEMPTS,
        "pass_threshold": PASS_THRESHOLD,
        "aggregation_model_calls": 0,
        "conditions": {
            condition: {
                "aggregation_job": str(jobs[condition]),
                "scored_trial_ids": sorted(selected_by_condition[condition]),
                "scored_count": len(selected_by_condition[condition]),
                "expected_count": EXPECTED_TRIALS,
                "per_case_scored_attempts": dict(sorted(Counter(
                    _entry_id(reward, set(cases)) for _, reward in selected_by_condition[condition].values()
                ).items())),
                "excluded_unscoreable_trials": excluded_by_condition[condition],
                "status": "complete",
            }
            for condition in CONDITIONS
        },
        "status": "COMPLETE: 18 scored attempts in each condition; previous Judge failures excluded and replaced by successful retries",
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    results = collect_harbor_results(
        skill_name="story-completion",
        agents=["opencode"],
        output_dir=run_dir,
        jobs_dir=jobs_root,
        n_attempts=ATTEMPTS,
        pass_threshold=PASS_THRESHOLD,
        stop_on_pass=False,
        expected_cases=len(cases),
        expected_case_ids=cases,
        expected_trials=EXPECTED_TRIALS,
        env_mode="docker",
        agent_models={"opencode": {"model": AGENT_MODEL, "source": "cli"}},
    )
    dataset_truth = _persist_dataset_truth(run_dir, fallback_task_ids=cases)
    run_config = read_json(SOURCE_RUN / "run_config.json")
    run_config["aggregation"] = {
        "kind": "offline-retained-trial-aggregation",
        "aggregation_model_calls": 0,
        "manifest": str(manifest_path),
        "source_run": str(SOURCE_RUN),
        "recovered_judge_errors": {
            "with": "COMP-002__UhkPzpz replaced by the successful COMP-002 retry",
            "without": "COMP-002__8HDKrLP replaced by the successful COMP-002 retry",
        },
    }
    (run_dir / "run_config.json").write_text(json.dumps(run_config, indent=2), encoding="utf-8")
    results.update({
        "skill_name": "story-completion",
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
        WORKSPACE / "agent/skills/story-completion",
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
            name: {
                "status": condition.get("execution_status"),
                "expected": condition.get("expected_attempts"),
                "scored": condition.get("scored_attempts"),
            }
            for name, condition in results["agents"]["opencode"]["conditions"].items()
        },
    }, indent=2))


if __name__ == "__main__":
    main()
