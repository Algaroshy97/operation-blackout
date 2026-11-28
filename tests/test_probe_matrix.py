"""Acceptance wiring and completeness guards (actual gameplay runs in Chromium)."""
import ast
import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MapModeAcceptanceContract(unittest.TestCase):
    def test_full_probe_requires_movement_score_evidence(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_movement_music_evidence']
        self.assertEqual(len(calls), 1, 'movement score evidence must be a release gate')
        self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n)
                             for n in ast.walk(main)), 'failures must propagate')

    def test_movement_evidence_requires_fullband_steady_score_probe(self):
        tree = ast.parse((ROOT / 'scripts/probe_movement_music_evidence.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'probe_steady_fullband']
        self.assertEqual(len(calls), 1, 'full-band matched score and headroom must gate movement acceptance')
        self.assertFalse(any(isinstance(n, ast.Try) and any(isinstance(h.type, ast.Name) and h.type.id in ('ValueError', 'Exception') for h in n.handlers) and calls[0] in ast.walk(n) for n in ast.walk(main)))

    def test_movement_gate_requires_separation_and_transition_probes(self):
        tree = ast.parse((ROOT / 'scripts/probe_movement_music_evidence.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        for name in ('probe_footstep_separation', 'probe_music_transition'):
            calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                     and isinstance(n.func, ast.Name) and n.func.id == name]
            self.assertEqual(len(calls), 1)
            self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n)
                                 for n in ast.walk(main)))

    def test_movement_gate_propagates_failure_under_optimized_python(self):
        script = '''
import ast, pathlib
from types import SimpleNamespace
tree = ast.parse(pathlib.Path('scripts/probe_live.py').read_text())
main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
call = next(n for n in ast.walk(main) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'probe_movement_music_evidence')
def fail(build): raise RuntimeError('negative control reached')
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.Expr(value=call)], type_ignores=[])), '<actual gate call>', 'exec'), {'probe_movement_music_evidence': fail, 'args': SimpleNamespace(build='fixture')})
'''
        result = subprocess.run([sys.executable, '-O', '-c', script], cwd=ROOT,
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('negative control reached', result.stderr)

    def test_full_probe_invokes_stage3_frame_combat_music(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_stage3_combat_music']
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n) for n in ast.walk(main)))

    def test_full_probe_invokes_stage3_match_restart_lifecycle(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_stage3_restart']
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n) for n in ast.walk(main)))

    def test_full_probe_invokes_stage3_budget_guard(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_stage3_budget']
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n) for n in ast.walk(main)))

    def test_full_probe_invokes_stage3_weather_lifecycle(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_stage3_weather']
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n) for n in ast.walk(main)))

    def test_full_probe_invokes_stage3_music_lifecycle(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_stage3_music']
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n)
                             for n in ast.walk(main)))

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
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_gameplay')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_map_modes']
        self.assertEqual(len(calls), 1, 'full acceptance must execute the map/mode matrix')

    def test_full_probe_invokes_touch_lifecycle(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_lifecycle')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_stage1_touch']
        self.assertEqual(len(calls), 1, 'full acceptance must execute the production touch lifecycle')

    def test_ci_runs_contract_guards(self):
        self.assertIn('tests.test_probe_matrix', (ROOT / '.github/workflows/ci.yml').read_text())

    def test_legacy_migration_probe_is_a_required_gate_with_base_history(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_progression')
        calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'probe_stage2_legacy_build']
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(isinstance(n, ast.Try) and calls[0] in ast.walk(n)
                             for n in ast.walk(main)), 'probe failures must propagate')
        self.assertIn('fetch-depth: 0', (ROOT / '.github/workflows/ci.yml').read_text())
        # The browser lane must keep headroom for the legacy migration probe. This used to
        # pin "timeout-minutes: 90" on a single monolithic job; now the matrix job owns it.
        browser = self.browser_job()
        self.assertIn('fetch-depth: 0', browser, 'progression needs full history')
        self.assertGreaterEqual(self.job_timeout(browser), 60)

    # --- helpers for the two-tier workflow -------------------------------
    def workflow(self):
        return (ROOT / '.github/workflows/ci.yml').read_text()

    def job_block(self, name):
        text = self.workflow()
        start = text.index(f'\n  {name}:\n')
        nxt = text.find('\n  ', start + 3)
        # Skip to the next line that starts a sibling job (two-space indent + name + colon).
        while nxt != -1:
            line = text[nxt + 3:text.index('\n', nxt + 3)]
            if line and not line.startswith(' ') and line.endswith(':'):
                return text[start:nxt]
            nxt = text.find('\n  ', nxt + 3)
        return text[start:]

    def browser_job(self):
        return self.job_block('browser')

    @staticmethod
    def job_timeout(block):
        m = re.search(r'timeout-minutes:\s*(\d+)', block)
        return int(m.group(1)) if m else 0

    def test_fast_lane_runs_every_unit_suite_on_every_push(self):
        build = self.job_block('build')
        self.assertIn('node --test tests/*.js', build)
        for suite in ('tests.test_release_build', 'tests.test_probe_matrix',
                      'tests.test_probe_shards'):
            self.assertIn(suite, build, f'{suite} must gate every push, not only the full lane')

    def test_full_acceptance_is_deliberate_not_per_push(self):
        browser = self.browser_job()
        self.assertIn("github.event_name == 'workflow_dispatch'", browser)
        self.assertIn("full-ci", browser, 'a PR must be able to request the matrix explicitly')
        self.assertIn("'refs/heads/release/'", browser)
        # Each shard must still be a separate job so one hang cannot stall the rest.
        self.assertIn('shard: [gameplay, lifecycle, progression, mobile-offline]', browser)
        # test_pwa_build boots a real HTTP server (~3 min); it belongs to the matrix lane.
        self.assertIn('tests.test_pwa_build', browser)

    def test_generated_build_is_not_committed(self):
        self.assertIn('git ls-files dist', self.job_block('build'),
                      'the fast lane must reject committed build output')
        self.assertIn('/dist/', (ROOT / '.gitignore').read_text())

    def test_gate_script_refuses_merge_without_full_run_for_head(self):
        gate = (ROOT / 'scripts/gate.sh').read_text()
        self.assertIn('head_sha==', gate)
        self.assertIn('full-ci', gate)
        self.assertIn('scripts/build.py', gate, 'merging must rebuild, never merge a stale artifact')

    def test_spawn_wait_allows_slow_software_rendering_without_faking_spawn(self):
        text = (ROOT / 'scripts/probe_live.py').read_text()
        self.assertIn('wait_until(page, "() => typeof enemies !== \'undefined\' && enemies.length > 0", 120)', text)

    def test_probe_bullet_floor_and_open_control_share_a_clean_shot(self):
        tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
        fixture = next(n.value.args[0].value for n in ast.walk(tree)
                       if isinstance(n, ast.Assign) and any(
                           isinstance(t, ast.Name) and t.id == 'bullet_floor' for t in n.targets)
                       and isinstance(n.value, ast.Call) and n.value.args
                       and isinstance(n.value.args[0], ast.Constant)
                       and isinstance(n.value.args[0].value, str))
        self.assertEqual(fixture.count('spawnEnemy('), 1)
        self.assertIn('spawnEnemy(1, 0, 5)', fixture)
        self.assertIn('gunner.pos.set(0, 0, 5)', fixture)
        self.assertIn('enemyShoot(gunner, 5)', fixture)
        self.assertIn('climbed: await run(SLAB_EYE), stayed: await run(CFG.player.height)', fixture)
        self.assertIn('setTimeout(resolve, CORE.ENEMY_BULLET_MAX_DELAY_MS + 50)', fixture)


if __name__ == '__main__':
    unittest.main()
