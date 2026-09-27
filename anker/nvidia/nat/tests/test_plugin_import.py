import importlib
import unittest


class PluginImportTest(unittest.TestCase):
    def test_plugin_entrypoint_imports_with_locked_nat_environment(self):
        plugin = importlib.import_module("life_interview_nat.register")
        self.assertTrue(callable(plugin.life_interview_agent))
        self.assertTrue(callable(plugin.register_life_interview_result_evaluator))


if __name__ == "__main__":
    unittest.main()
