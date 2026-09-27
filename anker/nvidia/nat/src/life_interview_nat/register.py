"""NAT plugin entry point."""

from .evaluator_register import register_life_interview_result_evaluator
from .workflow import life_interview_agent

__all__ = [
    "life_interview_agent",
    "register_life_interview_result_evaluator",
]
