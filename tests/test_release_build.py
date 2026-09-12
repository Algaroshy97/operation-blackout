#!/usr/bin/env python3
"""Regression checks for the offline release build and enemy visibility fallback."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "scripts" / "build.py"
ENEMIES = ROOT / "src" / "40_enemies.js"
MAIN = ROOT / "src" / "70_main.js"


class ReleaseBuildTests(unittest.TestCase):
    def test_release_build_works_from_repo_root_and_emits_shippable_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "Operation Blackout.html"
            result = subprocess.run(
                [sys.executable, str(BUILD), str(ROOT), "--output", str(output)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            self.assertTrue(output.is_file())
            self.assertIn("GLB_SOLDIER_BROKEN", output.read_text())

    def test_desktop_enemy_path_has_a_visible_fallback(self) -> None:
        enemy_source = ENEMIES.read_text()
        main_source = MAIN.read_text()
        self.assertIn("let GLB_SOLDIER_BROKEN = false", enemy_source)
        self.assertIn("!GLB_SOLDIER_BROKEN", enemy_source)
        self.assertIn("root.scale.setScalar(GLB_SOLDIER_SCALE)", enemy_source)
        self.assertIn("if (o.isSkinnedMesh) o.frustumCulled = false", enemy_source)
        self.assertIn("g.add(root); g.add(hitBody); g.add(hitHead)", enemy_source)
        self.assertIn("probeSkinnedSoldier()", main_source)

    def test_soldier_probe_restores_live_player_and_camera_state(self) -> None:
        enemy_source = ENEMIES.read_text()
        self.assertIn("const playerState = {", enemy_source)
        self.assertIn("const cameraState = {", enemy_source)
        self.assertIn("finally {", enemy_source)
        self.assertIn("player.pos.copy(playerState.pos)", enemy_source)
        self.assertIn("player.vel.copy(playerState.vel)", enemy_source)
        self.assertIn("camera.position.copy(cameraState.position)", enemy_source)
        self.assertIn("camera.rotation.copy(cameraState.rotation)", enemy_source)

    def test_soldier_probe_uses_a_before_after_pixel_comparison(self) -> None:
        enemy_source = ENEMIES.read_text()
        self.assertIn("function readProbePixels", enemy_source)
        self.assertIn("const before = readProbePixels", enemy_source)
        self.assertIn("const after = readProbePixels", enemy_source)
        self.assertIn("painted > before.length / 16", enemy_source)
    def test_performance_and_visibility_guards_exist(self) -> None:
        player_source = (ROOT / "src" / "20_player.js").read_text()
        world_source = (ROOT / "src" / "10_config_world.js").read_text()
        main_source = MAIN.read_text()
        self.assertIn("MAX_MOUSE_EVENT_DELTA", player_source)
        self.assertIn("Math.max(-MAX_MOUSE_EVENT_DELTA", player_source)
        self.assertIn("const useSimpleProp = mobileSafe || !gltf", world_source)
        self.assertIn("useSimpleProp ? makeMobileProp", world_source)
        self.assertIn("const targetFov =", main_source)
        self.assertIn("camera.fov += (targetFov - camera.fov)", main_source)
        self.assertIn("qualityAdjustT", main_source)

    def test_embedded_assets_are_preloaded_before_deploy(self) -> None:
        assets_source = (ROOT / "src" / "05_assets.js").read_text()
        main_source = MAIN.read_text()
        head_source = (ROOT / "src" / "00_head.html").read_text()
        self.assertIn("function loadEmbeddedAssets(onProgress)", assets_source)
        self.assertIn("onProgress(name, loaded, names.length)", assets_source)
        self.assertIn("let assetsReady = false", main_source)
        self.assertIn("function preloadGameAssets()", main_source)
        self.assertIn("assetsReady = true", main_source)
        self.assertIn("deploy.classList.toggle('disabled', !ready)", main_source)
        self.assertIn('id="asset-loading"', head_source)
        self.assertIn('id="asset-load-progress"', head_source)

    def test_review_findings_fixes(self) -> None:
        # 1) Grenade-flash pool pollution
        vfx_src = (ROOT / "src" / "50_vfx_audio.js").read_text()
        grenades_src = (ROOT / "src" / "55_grenades.js").read_text()
        self.assertIn("isBulletImpact: true", vfx_src)
        self.assertIn("impactPool.push(im.m)", vfx_src)
        self.assertIn("im.m.geometry.dispose()", vfx_src)
        self.assertIn("isBulletImpact: false", grenades_src)

        # 2) East parapet climb
        world_src = (ROOT / "src" / "10_config_world.js").read_text()
        self.assertIn("addBox(9.0, 4.55, 0, 0.8, 0.9, 14, MAT.concrete2)", world_src)
        self.assertNotIn("addBox(9.0, 4.4, 0, 0.8, 0.6, 14, MAT.concrete2)", world_src)

        # 3) Slide-jump double sound/velocity
        player_src = (ROOT / "src" / "20_player.js").read_text()
        self.assertIn("player.jumpBufT = 0", player_src)
        self.assertIn("player.coyoteT = 0", player_src)

        # 4) Sniper doubled scope_out
        weapons_src = (ROOT / "src" / "30_weapons.js").read_text()
        self.assertNotIn("playSound('scope_out')", weapons_src)

        # 5) Enemy ledge float+snap
        enemies_src = (ROOT / "src" / "40_enemies.js").read_text()
        self.assertIn("const ex = (c.max.x - c.min.x) * 0.5, ez = (c.max.z - c.min.z) * 0.5;", enemies_src)
        self.assertIn("dt * fallSpeed", enemies_src)
        self.assertNotIn("en.pos.y = floorY;", enemies_src)

        # 6) Restart pool leak
        main_src = (ROOT / "src" / "70_main.js").read_text()
        self.assertIn("tracerPool.push(t.m)", main_src)
        self.assertIn("impactPool.push(im.m)", main_src)
        self.assertIn("casingPool.push(c.m)", main_src)
        self.assertIn("casings.length = 0", main_src)

        # 7) Hitbox double raycast
        self.assertNotIn("targets.push(enemies[i].hitBody)", weapons_src)
        self.assertNotIn("targets.push(enemies[i].hitHead)", weapons_src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
