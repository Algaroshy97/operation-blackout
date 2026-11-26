"""Regression tests for score-continuity evidence and fail-closed controls."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from movement_music_evidence import validate_continuity, analyze_scheduler, validate_scheduler


def blocks(output=0.02):
    return [{'t': i * 0.1, 'expected': 0.05, 'reference': 0.05, 'output': output} for i in range(100)]


class ContinuityEvidenceTest(unittest.TestCase):
    def test_valid_capture_and_natural_quiet_blocks(self):
        samples = blocks()
        for item in samples[20:25]:
            item.update(expected=0.0, reference=0.0, output=0.0)
        validate_continuity(samples)

    def test_rejects_partial_outage_not_just_zero_peak(self):
        samples = blocks()
        for item in samples[30:70]:
            item['output'] = 0
        with self.assertRaisesRegex(ValueError, 'gap'):
            validate_continuity(samples)

    def test_rejects_long_partial_upstream_outage(self):
        samples = blocks()
        for item in samples[30:70]:
            item.update(reference=0.0, output=0.0)
        with self.assertRaises(ValueError):
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

    def test_scheduler_rejects_stalls_despite_step_progress(self):
        frames = [{'t': t} for t in (0, 0.1, 0.9)]
        scheduled = [{'n': 1, 't': 0.1, 'now': 0.05}, {'n': 2, 't': 0.2, 'now': 0.24}, {'n': 3, 't': 1.0, 'now': 0.9}]
        with self.assertRaisesRegex(ValueError, 'scheduler'):
            validate_scheduler(frames, scheduled, 0.1)

    def test_scheduler_rejects_skipped_score_gap_even_if_frames_are_fast(self):
        frames = [{'t': t} for t in (0, 0.1, 0.2, 0.3)]
        scheduled = [{'n': 1, 't': 0.1, 'now': 0.05}, {'n': 2, 't': 0.3, 'now': 0.25}]
        with self.assertRaisesRegex(ValueError, 'scheduler'):
            validate_scheduler(frames, scheduled, 0.1)

    def test_scheduler_accepts_even_renderer_bound_cadence(self):
        # Software GL on a moving scene: frames arrive every ~0.4s, evenly.
        frames = [{'t': 0.4 * i} for i in range(13)]
        frames[11]['t'] = 0.4 * 11 + 0.18
        scheduled = [{'n': i, 't': 0.1 * i, 'now': 0.1 * i - 0.05} for i in range(1, 40)]
        metrics = validate_scheduler(frames, scheduled, 0.1)
        self.assertAlmostEqual(metrics['median_frame_gap'], 0.4, places=6)
        self.assertGreaterEqual(round(metrics['max_frame_gap_bound'], 6), 0.8)

    def test_scheduler_rejects_true_stall_inside_renderer_bound_capture(self):
        frames = [{'t': 0.4 * i} for i in range(13)]
        frames[6]['t'] = frames[5]['t'] + 1.6
        for i in range(7, 13):
            frames[i]['t'] = frames[5]['t'] + 1.6 + 0.4 * (i - 6)
        scheduled = [{'n': i, 't': 0.1 * i, 'now': 0.1 * i - 0.05} for i in range(1, 40)]
        with self.assertRaisesRegex(ValueError, 'scheduler'):
            validate_scheduler(frames, scheduled, 0.1)

    def test_scheduler_accepts_lateness_within_one_render_cadence(self):
        # Steps are drained inside frames only, so at a ~0.4s cadence a step
        # due between two frames is structurally late by up to one gap.
        frames = [{'t': 0.4 * i} for i in range(13)]
        scheduled = [{'n': i, 't': 0.1 * i, 'now': 0.1 * i + 0.14} for i in range(1, 40)]
        metrics = validate_scheduler(frames, scheduled, 0.1)
        self.assertAlmostEqual(metrics['max_lateness_bound'], 0.4, places=6)
        self.assertGreater(metrics['max_lateness'], 0.08)

    def test_scheduler_rejects_lateness_beyond_one_render_cadence(self):
        # A step left past a whole frame that was available is a real defect,
        # even on a renderer-bound capture.
        frames = [{'t': 0.4 * i} for i in range(13)]
        scheduled = [{'n': i, 't': 0.1 * i, 'now': 0.1 * i + 0.05} for i in range(1, 20)]
        scheduled[4]['now'] = scheduled[4]['t'] + 1.1
        with self.assertRaisesRegex(ValueError, 'scheduler'):
            validate_scheduler(frames, scheduled, 0.1)

    def test_scheduler_keeps_absolute_lateness_bound_when_rendering_is_smooth(self):
        frames = [{'t': 0.016 * i} for i in range(40)]
        scheduled = [{'n': i, 't': 0.1 * i, 'now': 0.1 * i + 0.05} for i in range(1, 12)]
        scheduled[3]['now'] = scheduled[3]['t'] + 0.12
        with self.assertRaisesRegex(ValueError, 'scheduler'):
            validate_scheduler(frames, scheduled, 0.1)

    def test_scheduler_keeps_absolute_bound_for_small_samples(self):
        frames = [{'t': t} for t in (0, 0.4, 1.1)]
        scheduled = [{'n': 1, 't': 0.1, 'now': 0.05}, {'n': 2, 't': 0.2, 'now': 0.15}]
        with self.assertRaisesRegex(ValueError, 'scheduler'):
            validate_scheduler(frames, scheduled, 0.1)

    def test_rejects_missing_capture_intervals(self):
        samples = blocks()
        del samples[30:70]
        with self.assertRaisesRegex(ValueError, 'capture'):
            validate_continuity(samples)


if __name__ == '__main__':
    unittest.main()
