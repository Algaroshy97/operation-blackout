"""Exercise actual browser WebGL renderer geometry counts and scene lifecycle under repeated bot death/ragdoll retirement/respawn."""
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class CorpseLifecycleProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            headless=True,
            args=['--use-gl=angle', '--use-angle=swiftshader']
        )
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

    def test_repeated_death_respawn_lifecycle_bounds_renderer_geometries(self):
        result = self.page.evaluate('''() => {
            const bot = enemies[0] || spawnEnemy(1, 0, 10, { team: 'enemy' });
            if (!enemies.includes(bot)) enemies.push(bot);

            // Isolate world item drops so only rig/ragdoll geometries are measured
            const origDropPickup = (typeof dropPickup === 'function') ? dropPickup : null;
            const origDropPowerUp = (typeof dropPowerUp === 'function') ? dropPowerUp : null;
            dropPickup = () => {};
            dropPowerUp = () => {};

            // Render at least one frame so renderer compiles geometries
            renderer.render(scene, camera);
            const initialGeos = renderer.info.memory.geometries;

            const counts = [];
            const hittableResults = [];

            try {
                // Run 5 cycles of death -> respawn -> ragdoll retirement
                for (let i = 0; i < 5; i++) {
                    bot.dead = false;
                    bot.health = 100;
                    killEnemy(bot, false, player);
                    defaultOnRespawn(bot, [i * 2, 10]);
                    resetRagdolls();

                    renderer.render(scene, camera);
                    counts.push(renderer.info.memory.geometries);

                    // Verify live hittable rig remains
                    const inScene = !!(bot.parts && bot.parts.group && bot.parts.group.parent === scene);
                    const hitBody = bot.parts && (bot.hitBody || bot.parts.hitBody);
                    const hasHitBody = !!hitBody && (hitBody.parent === bot.parts.group || !!bot.parts.group.getObjectByName('hitBody'));
                    const hasEnemyRef = !!hitBody && hitBody.userData && hitBody.userData.enemyRef === bot;

                    // Update transforms and test real raycast against live hitBody
                    bot.parts.group.updateMatrixWorld(true);
                    const worldPos = new THREE.Vector3();
                    hitBody.getWorldPosition(worldPos);

                    const raycaster = new THREE.Raycaster(
                        new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z - 5),
                        new THREE.Vector3(0, 0, 1)
                    );
                    const hits = raycaster.intersectObject(hitBody, false);
                    const hittable = hits.length > 0;

                    hittableResults.push({ inScene, hasHitBody, hasEnemyRef, hittable });
                }
            } finally {
                if (origDropPickup) dropPickup = origDropPickup;
                if (origDropPowerUp) dropPowerUp = origDropPowerUp;
            }

            return {
                initialGeos,
                counts,
                hittableResults
            };
        }''')

        # Assert no errors occurred in browser
        self.assertEqual(self.errors, [], f"Console/page errors: {self.errors}")

        # Check all 5 cycles kept live hittable rigs
        for i, hit in enumerate(result['hittableResults']):
            self.assertTrue(hit['inScene'], f"Cycle {i}: live rig must be in scene")
            self.assertTrue(hit['hasHitBody'], f"Cycle {i}: live hitBody must be attached")
            self.assertTrue(hit['hasEnemyRef'], f"Cycle {i}: live hitBody userData.enemyRef must point to bot")
            self.assertTrue(hit['hittable'], f"Cycle {i}: live hitBody must be raycast-hittable")

        # Check geometry count bounded (no monotonic growth)
        counts = result['counts']
        self.assertEqual(counts[-1], counts[0], f"Geometry counts must be identical across all cycles: {counts}")
        self.assertEqual(len(set(counts)), 1, f"Geometry counts must remain strictly constant with 0 leaks: {counts}")


if __name__ == '__main__':
    unittest.main()
