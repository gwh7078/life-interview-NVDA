import unittest

from life_interview_nat.evaluators import evaluate_result


class EvaluatorTest(unittest.TestCase):
    def test_successful_contract_scores_one(self):
        score, reasoning = evaluate_result({
            "status": "succeeded",
            "validation": {
                "contract_valid": True,
                "backend_validation": "passed",
                "semantic_valid": True,
                "semantic_checks": [],
            },
        })
        self.assertEqual(score, 1.0)
        self.assertTrue(reasoning["runtime_success"])

    def test_failed_semantic_check_scores_zero(self):
        score, reasoning = evaluate_result({
            "status": "succeeded",
            "validation": {
                "contract_valid": True,
                "backend_validation": "passed",
                "semantic_valid": True,
                "semantic_checks": [{"name": "uncertainty", "passed": False}],
            },
        })
        self.assertEqual(score, 0.0)
        self.assertEqual(len(reasoning["failed_semantic_checks"]), 1)

    def test_missing_semantics_or_backend_validation_scores_zero(self):
        for validation in (
            {"contract_valid": True, "backend_validation": "passed"},
            {
                "contract_valid": True,
                "backend_validation": "not_applicable",
                "semantic_valid": True,
            },
        ):
            score, _ = evaluate_result({"status": "succeeded", "validation": validation})
            self.assertEqual(score, 0.0)


if __name__ == "__main__":
    unittest.main()
