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
