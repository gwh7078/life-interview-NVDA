import unittest

from life_interview_nat.result_parser import ResultParseError, parse_result


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

if __name__ == "__main__":
    unittest.main()
