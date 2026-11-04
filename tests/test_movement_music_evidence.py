"""Regression tests for score-continuity evidence and fail-closed controls."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from movement_music_evidence import validate_continuity, analyze_scheduler


def blocks(output=0.02):
    return [{'t': i * 0.1, 'reference': 0.05, 'output': output} for i in range(100)]


class ContinuityEvidenceTest(unittest.TestCase):
    def test_valid_capture_and_natural_quiet_blocks(self):
        samples = blocks()
        for item in samples[20:25]:
            item.update(reference=0.0, output=0.0)
        validate_continuity(samples)

    def test_rejects_partial_outage_not_just_zero_peak(self):
        samples = blocks()
        for item in samples[30:70]:
            item['output'] = 0
        with self.assertRaisesRegex(ValueError, 'gap'):
            validate_continuity(samples)

    def test_rejects_mute_disconnect_and_missing_evidence(self):
        for samples in (blocks(0), [], [{'t': 0, 'reference': 0, 'output': 0}]):
            with self.subTest(samples=len(samples)), self.assertRaises(ValueError):
                validate_continuity(samples)

    def test_rejects_repeated_deep_duck_even_without_zero_audio(self):
        samples = blocks()
        for item in samples[30:34]:
            item['output'] = 0.004
        with self.assertRaisesRegex(ValueError, 'deep attenuation'):
            validate_continuity(samples, min_ratio=0.2)

    def test_scheduler_reports_clock_gaps_and_late_steps(self):
        frames = [{'t': t} for t in (0, 0.1, 0.5)]
        scheduled = [{'n': 1, 't': 0.1, 'now': 0.05}, {'n': 2, 't': 0.2, 'now': 0.24}, {'n': 3, 't': 0.6, 'now': 0.5}]
        metrics = analyze_scheduler(frames, scheduled, 0.1)
        self.assertEqual(metrics['overdue_steps'], 1)
        self.assertEqual(metrics['schedule_gaps'], 1)
        self.assertAlmostEqual(metrics['max_frame_gap'], 0.4)

    def test_rejects_missing_capture_intervals(self):
        samples = blocks()
        del samples[30:70]
        with self.assertRaisesRegex(ValueError, 'capture'):
            validate_continuity(samples)


if __name__ == '__main__':
    unittest.main()
