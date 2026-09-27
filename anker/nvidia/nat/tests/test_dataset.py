import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]


class DatasetTest(unittest.TestCase):
    def test_smoke_dataset_is_case_index_only(self):
        rows = [json.loads(line) for line in (ROOT / "datasets/smoke.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 6)
        for row in rows:
            self.assertIn("id", row)
            self.assertEqual(set(row["question"]), {"case_id"})
            self.assertNotIn("transcript", json.dumps(row, ensure_ascii=False).lower())
            self.assertNotIn("api_key", json.dumps(row, ensure_ascii=False).lower())
            self.assertNotIn("token", json.dumps(row, ensure_ascii=False).lower())

    def test_regression_dataset_has_24_case_indexes_only(self):
        rows = [json.loads(line) for line in (ROOT / "datasets/regression.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 24)
        self.assertEqual(len({row["id"] for row in rows}), 24)
        for row in rows:
            self.assertEqual(set(row["question"]), {"case_id"})
            self.assertEqual(row["id"], row["question"]["case_id"])
            self.assertNotIn("transcript", json.dumps(row, ensure_ascii=False).lower())
            self.assertNotIn("api_key", json.dumps(row, ensure_ascii=False).lower())
            self.assertNotIn("token", json.dumps(row, ensure_ascii=False).lower())


if __name__ == "__main__":
    unittest.main()
