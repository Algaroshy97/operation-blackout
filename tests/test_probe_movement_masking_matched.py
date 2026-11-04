"""Unit checks for the matched masking diagnostic; browser evidence is separate."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from probe_movement_masking_matched import compare


def blocks(cue=0.01, current=0.01, baseline=0.01, mix=0.02):
    return [{'t': i * 0.01, 'cue': cue**2, 'current': current**2,
             'baseline': baseline**2, 'mix': mix**2} for i in range(5)]


class MatchedMaskingTest(unittest.TestCase):
    def test_identical_paths_have_zero_loss(self):
        self.assertAlmostEqual(compare(blocks())['loss_db'], 0)

    def test_rejects_score_increase_relative_to_baseline(self):
        with self.assertRaisesRegex(ValueError, 'priority regression'):
            compare(blocks(current=0.02))

    def test_rejects_missing_and_nonfinite_inputs(self):
        for sample in (blocks(cue=0), blocks(current=0), blocks(baseline=0), blocks(mix=0), []):
            with self.subTest(sample=sample), self.assertRaises(ValueError):
                compare(sample)
        sample = blocks()
        sample[1]['current'] = float('nan')
        with self.assertRaises(ValueError):
            compare(sample)

    def test_rejects_capture_gap(self):
        sample = blocks()
        sample[2]['t'] = 2
        with self.assertRaisesRegex(ValueError, 'gap'):
            compare(sample)


if __name__ == '__main__':
    unittest.main()
