"""NAT evaluator registration; pure scoring remains usable without NAT installed."""

from __future__ import annotations

import json
from typing import Any

from nat.plugin_api import EvalBuilder, EvaluatorBaseConfig, EvaluatorInfo, register_evaluator
from nat.plugins.eval.evaluator.base_evaluator import BaseEvaluator, EvalInputItem, EvalOutputItem

from .evaluators import evaluate_result


class LifeInterviewResultEvaluatorConfig(EvaluatorBaseConfig, name="life_interview_result"):
    """Configuration for deterministic bridge result scoring."""


class LifeInterviewResultEvaluator(BaseEvaluator):
    async def evaluate_item(self, item: EvalInputItem) -> EvalOutputItem:
        raw = item.output_obj
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                raw = {}
        result = raw if isinstance(raw, dict) else {}
        score, reasoning = evaluate_result(result)
        return EvalOutputItem(id=item.id, score=score, reasoning=reasoning)


@register_evaluator(config_type=LifeInterviewResultEvaluatorConfig)
async def register_life_interview_result_evaluator(
    config: LifeInterviewResultEvaluatorConfig,
    builder: EvalBuilder,
):
    evaluator = LifeInterviewResultEvaluator(builder.get_max_concurrency())
    yield EvaluatorInfo(
        config=config,
        evaluate_fn=evaluator.evaluate,
        description="Deterministic status, contract and semantic result evaluator.",
    )
