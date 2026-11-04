"""Paired cue/score comparator tests, separate from browser evidence."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from probe_movement_paired_cues import compare_pair


class PairedCueTest(unittest.TestCase):
    def test_scaled_cue_compensates_scaled_score(self):
        result = compare_pair([0.1] * 100, [0.2] * 100, [0.2] * 100, [0.4] * 100)
        self.assertAlmostEqual(result['loss_db'], 0)

    def test_louder_score_without_cue_compensation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'priority'):
            compare_pair([0.1] * 100, [0.1] * 100, [0.2] * 100, [0.4] * 100)

    def test_missing_cue_and_clipping_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'missing'):
            compare_pair([0.1] * 100, [0.0] * 100, [0.2] * 100, [0.2] * 100)
        with self.assertRaisesRegex(ValueError, 'clip'):
            compare_pair([0.1] * 100, [0.1] * 100, [0.2] * 100, [0.2] * 100, peak=1.01)


if __name__ == '__main__':
    unittest.main()
