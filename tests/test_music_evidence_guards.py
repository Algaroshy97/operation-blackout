"""Failure-mode checks for the deterministic audio evidence validators."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load {name}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MusicEvidenceGuards(unittest.TestCase):
    def test_note_target_uses_repeat_floor_and_rejects_overqueue(self):
        check = load('probe_music_note_target').compare
        normal, rejected, margin = check(1, 0, 0, 1e-10, 1)
        self.assertTrue(normal)
        self.assertTrue(rejected)
        self.assertGreater(margin, 16e-10)
        self.assertFalse(check(1, 0, 1, 1e-10, 1)[1])
        self.assertFalse(check(1e-10, 0, 0, 1e-10, 1)[0])

    def test_full_master_direction_guard_rejects_static_reversed_and_nonfinite(self):
        check = load('probe_music_full_master').is_directional
        self.assertTrue(check(2, 1, 1))
        self.assertTrue(check(1, 2, -1))
        self.assertFalse(check(1, 1, 1))
        self.assertFalse(check(1, 2, 1))
        with self.assertRaises(ValueError):
            check(float('nan'), 1, 1)

    def test_linear_preservation_rejects_nonzero_loss_and_missing_signals(self):
        check = load('probe_footstep_separation').validate_linear
        valid = {'linearCue': 1, 'linearScore': 2, 'linearError': 1e-14, 'peak': .5}
        check(valid)
        for changes in ({'linearError': .81}, {'linearCue': 0}, {'linearScore': 0}, {'peak': 1}, {'linearError': float('nan')}):
            with self.assertRaises(ValueError):
                check({**valid, **changes})

    def test_rendered_direction_rejects_static_reversed_and_missing_response(self):
        check = load('probe_music_transition').rendered_direction
        reference = {'bins': [[0, 0, 1] for _ in range(45)]}
        candidate = {'bins': [row[:] for row in reference['bins']]}
        candidate['bins'][19][2] = 2
        self.assertEqual(check(candidate, reference, 3, 1)[0], .8)
        with self.assertRaises(ValueError):
            check(reference, reference, 3, 1)
        with self.assertRaises(ValueError):
            check(candidate, reference, 3, -1)

    def test_separation_rejects_nonzero_attenuation_and_muted_score(self):
        check = load('probe_footstep_separation').validate_row
        ref = {'ratios': [1, 2, 3], 'scores': [1, 1, 1]}
        check({'ratios': [1, 2, 3], 'scores': [1, 1, 1], 'peak': .2}, ref)
        with self.assertRaisesRegex(ValueError, 'separation materially degraded'):
            check({'ratios': [.01, .02, .03], 'scores': [1, 1, 1], 'peak': .2}, ref)
        with self.assertRaisesRegex(ValueError, 'missing/nonfinite'):
            check({'ratios': [1, 2, 3], 'scores': [0, 0, 0], 'peak': .2}, ref)
        with self.assertRaisesRegex(ValueError, 'clipping'):
            check({'ratios': [1, 2, 3], 'scores': [1, 1, 1], 'peak': 1}, ref)
        with self.assertRaisesRegex(ValueError, 'missing frequency band'):
            check({'ratios': [], 'scores': [], 'peak': .2}, ref)

    def test_transition_rejects_excessively_stale_queue(self):
        check = load('probe_music_transition').validate_response
        self.assertAlmostEqual(check({'calls': [{'now': 3, 't': 3.55}]}, 3, .69), .55)
        with self.assertRaisesRegex(ValueError, 'excessive stale queue'):
            check({'calls': [{'now': 3, 't': 4.8}]}, 3, .69)
        with self.assertRaisesRegex(ValueError, 'no post-transition'):
            check({'calls': [{'now': 2, 't': 3.1}]}, 3, .69)


if __name__ == '__main__':
    unittest.main()
