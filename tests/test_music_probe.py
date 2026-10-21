"""Exercise the real deployment/music lifecycle and its acceptance observation."""
import ast
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def probe_observation():
    tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
    observation = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'mus' for t in n.targets))
    first_combat = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'melee' for t in n.targets))
    return ast.literal_eval(observation.value.args[0]), observation.lineno, first_combat.lineno


class MusicProbeTests(unittest.TestCase):
    def test_gate_observes_deployment_before_destructive_combat_probes(self):
        _, music_line, combat_line = probe_observation()
        self.assertLess(music_line, combat_line,
                        'Observe deployment music before tests can kill/revive the player')

    def test_real_ui_starts_scheduler_and_death_stops_it(self):
        expression, _, _ = probe_observation()
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto((ROOT / 'dist/Operation Blackout.html').as_uri(), wait_until='domcontentloaded')
            page.wait_for_function('() => assetsReady === true', timeout=60000)
            # Real menu/loadout flow, not a direct startMusic call.
            page.evaluate("() => document.getElementById('btn-start').click()")
            page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
            page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
            page.wait_for_function('() => started && MUSIC.step > 0')
            live = page.evaluate(expression)
            self.assertTrue(live['built'])
            self.assertTrue(live['running'])
            self.assertEqual(live['layers'], 'arp,bass,drums,horn,pad')
            page.wait_for_function('(step) => MUSIC.step > step', arg=live['steps'])
            # Real lifecycle reproducer: later combat tests revive actor flags,
            # but that must not be mistaken for a fresh UI deployment.
            page.evaluate('() => { killPlayer(); player.dead = false; player.health = 100; }')
            ended = page.evaluate(expression)
            self.assertTrue(ended['built'])
            self.assertFalse(ended['running'])
            page.wait_for_timeout(300)
            self.assertEqual(page.evaluate(expression)['steps'], ended['steps'])
            self.assertEqual(errors, [])
            browser.close()


if __name__ == '__main__':
    unittest.main()
