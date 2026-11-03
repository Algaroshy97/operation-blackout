"""Contract for the comparative software-renderer regression guard."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stage3_budget', ROOT / 'scripts/measure_stage3_budget.py')
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


class Stage3BudgetTest(unittest.TestCase):
    def test_comparison_rejects_unmatched_or_excessive_timings(self):
        self.assertTrue(hasattr(budget, 'check_budget'), 'matched frame comparison must enforce an engineering bound')
        base = dict(frames=60, medianMs=100, p95Ms=120, renderer='software', enemies=0,
                    quality='low', effects='reduced', map='urban', pixelRatio=0.7)
        good = dict(base, medianMs=149, p95Ms=203)
        budget.check_budget(base, good)
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, medianMs=151))
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, p95Ms=205))
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, map='snowy'))
        with self.assertRaises(AssertionError):
            budget.check_budget(base, dict(good, frames=0))
        with self.assertRaises(AssertionError):
            budget.check_budget(dict(base, enemies=1), dict(good, enemies=1))


if __name__ == '__main__':
    unittest.main()
