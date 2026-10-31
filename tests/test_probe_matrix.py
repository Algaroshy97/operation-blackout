"""Acceptance wiring and completeness guards (actual gameplay runs in Chromium)."""
import ast
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MapModeAcceptanceContract(unittest.TestCase):
    def test_matrix_has_every_map_mode_pair_once(self):
        spec = importlib.util.spec_from_file_location('probe_map_modes', ROOT / 'scripts/probe_map_modes.py')
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        expected = {(m, mode) for m in ('urban', 'snowy')
                    for mode in ('survival', 'tdm', 'ffa', 'domination', 'gun-game')}
        self.assertEqual(set(module.CASES), expected)
        self.assertEqual(len(module.CASES), len(expected))

    def test_full_probe_invokes_matrix(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_map_modes']
        self.assertEqual(len(calls), 1, 'full acceptance must execute the map/mode matrix')

    def test_ci_runs_contract_guards(self):
        self.assertIn('tests.test_probe_matrix', (ROOT / '.github/workflows/ci.yml').read_text())

    def test_spawn_wait_allows_slow_software_rendering_without_faking_spawn(self):
        text = (ROOT / 'scripts/probe_live.py').read_text()
        self.assertIn('wait_until(page, "() => typeof enemies !== \'undefined\' && enemies.length > 0", 120)', text)

    def test_probe_bullets_in_open_control_resets_enemy_state(self):
        text = (ROOT / 'scripts/probe_live.py').read_text()
        self.assertIn('bullets-still-land-in-the-open', text)
        idx = text.find('bullets-still-land-in-the-open')
        prior_block = text[max(0, idx - 850):idx]
        self.assertIn('spawnEnemy(1, 0, 5)', prior_block,
                      'bullets-still-land-in-the-open control must spawn/reset enemy cleanly at (0, 0, 5)')
        self.assertIn('g.pos.set(0, 0, 5)', prior_block,
                      'bullets-still-land-in-the-open control must reset g.pos to (0, 0, 5)')


if __name__ == '__main__':
    unittest.main()
