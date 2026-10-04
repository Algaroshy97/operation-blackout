"""Run the actual plate acceptance expression against the existing release.

No build is performed. Extracting the expression with AST keeps this regression
attached to the acceptance gate rather than a copied implementation.
"""
import ast
import json
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def plate_expression():
    tree = ast.parse((ROOT / 'scripts/probe_live.py').read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == 'plate_audio'
            for target in node.targets
        ):
            return ast.literal_eval(node.value.args[0])
    raise AssertionError('plate_audio acceptance expression not found')


class PlateAudioProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.page = cls.browser.new_page()
        cls.errors = []
        cls.page.on('pageerror', lambda error: cls.errors.append(str(error)))
        cls.page.on('console', lambda message: cls.errors.append(message.text)
                    if message.type == 'error' else None)
        cls.page.goto((ROOT / 'dist/Operation Blackout.html').as_uri())
        cls.page.wait_for_function('() => assetsReady === true', timeout=60000)
        cls.page.evaluate("() => document.getElementById('btn-start').click()")
        cls.page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
        cls.page.wait_for_function("() => document.querySelector('#gun-select h2').textContent === 'SELECT SECONDARY'")
        cls.page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
        cls.page.wait_for_function('() => started === true')
        cls.page.evaluate('() => { paused = true; }')

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def run_probe(self, mutation=''):
        # The release's real usePlate/updateStations execute synchronously. Only
        # observation wrappers and intentional negative controls are injected.
        return self.page.evaluate('''({expression, mutation}) => {
            const originalUse = usePlate, originalUpdate = updateStations;
            const originalPlay = playSound;
            const played = [], stages = [];
            started = true; paused = false;
            try {
                if (mutation) eval(mutation);
                const runUse = usePlate, runUpdate = updateStations;
                playSound = function(name) { played.push(name); originalPlay(name); };
                usePlate = function() {
                    runUse();
                    stages.push({stage: 'insert', played: played.slice(), armor: player.armor,
                                 plates, plateT});
                };
                updateStations = function(dt) {
                    runUpdate(dt);
                    stages.push({stage: 'lock', played: played.slice(), armor: player.armor,
                                 plates, plateT});
                };
                const accepted = eval('(' + expression + ')')();
                return {accepted, played, stages, plateTime: CORE.PLATE_TIME};
            } finally {
                usePlate = originalUse; updateStations = originalUpdate;
                playSound = originalPlay; paused = true;
            }
        }''', {'expression': plate_expression(), 'mutation': mutation})

    def test_accepts_real_plate_insert_then_lock_lifecycle(self):
        result = self.run_probe()
        print('PLATE_LIFECYCLE ' + json.dumps(result, sort_keys=True), flush=True)
        self.assertTrue(result['accepted'], result)
        self.assertEqual(result['played'], ['plate_insert', 'plate_lock'])
        insert, lock = result['stages']
        self.assertEqual(insert['played'], ['plate_insert'])
        self.assertEqual((insert['armor'], insert['plates'], insert['plateT']),
                         (0, 1, result['plateTime']))
        self.assertEqual(lock['played'], ['plate_insert', 'plate_lock'])
        self.assertGreater(lock['armor'], 0)
        self.assertEqual((lock['plates'], lock['plateT']), (0, 0))
        self.assertEqual(self.errors, [])

    def test_rejects_missing_wrong_reversed_or_duplicate_cues(self):
        mutations = {
            'missing insert': "const real = usePlate; usePlate = () => { const sound = playSound; playSound = () => {}; try { real(); } finally { playSound = sound; } };",
            'missing lock': "updateStations = () => {};",
            'old reload cues': "const insert = usePlate, lock = updateStations; usePlate = () => { const sound = playSound; playSound = () => sound('reload_out'); try { insert(); } finally { playSound = sound; } }; updateStations = dt => { const sound = playSound; playSound = () => sound('reload_in'); try { lock(dt); } finally { playSound = sound; } };",
            'reversed cues': "const insert = usePlate, lock = updateStations; usePlate = () => { const sound = playSound; playSound = () => sound('plate_lock'); try { insert(); } finally { playSound = sound; } }; updateStations = dt => { const sound = playSound; playSound = () => sound('plate_insert'); try { lock(dt); } finally { playSound = sound; } };",
            'premature lock': "const real = usePlate; usePlate = () => { real(); playSound('plate_lock'); };",
            'duplicate lock': "const real = updateStations; updateStations = dt => { real(dt); playSound('plate_lock'); };",
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                result = self.run_probe(mutation)
                self.assertFalse(result['accepted'], result)
        self.assertEqual(self.errors, [])


if __name__ == '__main__':
    unittest.main()
