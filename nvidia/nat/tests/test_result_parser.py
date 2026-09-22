import unittest

from life_interview_nat.result_parser import ResultParseError, parse_result, public_result


class ResultParserTest(unittest.TestCase):
    def test_uses_last_result_marker(self):
        value = parse_result(
            "runtime noise\n"
            'LIFE_INTERVIEW_NAT_RESULT {"case_id":"old","status":"failed"}\n'
            'LIFE_INTERVIEW_NAT_RESULT {"case_id":"new","status":"succeeded"}\n'
        )
        self.assertEqual(value["case_id"], "new")

    def test_rejects_missing_marker(self):
        with self.assertRaises(ResultParseError):
            parse_result("runtime noise\n")

    def test_public_result_drops_agent_output(self):
        value = public_result({
            "case_id": "x",
            "status": "succeeded",
            "output": {"private": "synthetic output"},
            "metrics": {"latency_ms": 4},
        })
        self.assertNotIn("output", value)
        self.assertEqual(value["metrics"]["latency_ms"], 4)


if __name__ == "__main__":
    unittest.main()
