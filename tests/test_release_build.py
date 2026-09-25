#!/usr/bin/env python3
"""Regression checks for the offline release build and enemy visibility fallback."""
from __future__ import annotations

import re
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
            self.assertIn("startRagdoll", output.read_text())

    def test_soldiers_are_shared_procedural_rigs(self) -> None:
        rig = (ROOT / "src" / "38_soldier.js").read_text()
        assets = (ROOT / "src" / "05_assets.js").read_text()
        enemy_source = ENEMIES.read_text()
        self.assertIn("function buildSoldierTemplate(kind)", rig)
        self.assertIn("SOLDIER_TEMPLATES[kind].clone(true)", rig)   # one template per kind, shared geometry
        self.assertIn("mergeRigMeshes(root)", rig)                 # few draw calls per soldier
        self.assertIn("const parts = buildSoldier(kind);", enemy_source)
        self.assertNotIn("SOLDIER:", assets)                        # cartoon GLB soldier removed
        self.assertNotIn("GLB_SOLDIER_BROKEN", enemy_source)

    def test_verlet_ragdoll_is_constrained_and_collides(self) -> None:
        rig = (ROOT / "src" / "38_soldier.js").read_text()
        for needle in ("const RD_BONES", "const RD_BRACES", "const RD_MIN", "function rdHinge", "function rdCollide",
                       "R.asleep = true", "function ragdollBlast", "function ragdollHit"):
            self.assertIn(needle, rig)
        # fixed-step integration (stable at any frame rate)
        self.assertIn("while (R.acc >= RD_H)", rig)
        enemy_source = ENEMIES.read_text()
        self.assertIn("startRagdoll(en, dir,", enemy_source)
        self.assertIn("ragdollBlast(pos,", (ROOT / "src" / "55_grenades.js").read_text())

    def test_untextured_colours_are_linearised(self) -> None:
        # Regression: hex colours are linear in this renderer; dark kit rendered near-white.
        self.assertIn("if (!map) m.color.convertSRGBToLinear();", (ROOT / "src" / "38_soldier.js").read_text())
        self.assertIn("if (!params.map) m.color.convertSRGBToLinear();", (ROOT / "src" / "32_viewmodels.js").read_text())

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
        # 1) Grenade-flash pool pollution: explosions now use the GPU particle
        #    system (no per-blast meshes to pool or dispose)
        vfx_src = (ROOT / "src" / "50_vfx_audio.js").read_text()
        grenades_src = (ROOT / "src" / "55_grenades.js").read_text()
        particles_src = (ROOT / "src" / "48_particles.js").read_text()
        self.assertIn("fxExplosion(pos", grenades_src)
        self.assertNotIn("new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8)", grenades_src)
        self.assertIn("function clearParticles()", particles_src)

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
        self.assertIn("clearParticles();", main_src)
        self.assertIn("casingPool.push(c.m)", main_src)
        self.assertIn("casings.length = 0", main_src)

        # 7) Hitbox double raycast
        self.assertNotIn("targets.push(enemies[i].hitBody)", weapons_src)
        self.assertNotIn("targets.push(enemies[i].hitHead)", weapons_src)

        # 8) Ammo pickup HUD update
        self.assertIn("updateHudAmmo();", grenades_src)

        # 9) Secondary weapon reset across runs (slot 2 is the sidearm again,
        #    so an Armory swap from a previous run never persists)
        self.assertIn("weaponsOwned[1] = SNIPER; weaponsOwned[SIDE_SLOT] = PISTOL;\n  curWeapon = 0;\n  initWeapons();", main_src)

        # 10) Audio node disconnect in playSound3D
        self.assertIn("p.disconnect()", vfx_src)
        self.assertIn("g.disconnect()", vfx_src)

        # 11) Slide dust pooling: dust is emitted into the fixed-size particle ring
        self.assertIn("fxDust(", vfx_src)
        self.assertIn("function pfxEmit(", particles_src)
        self.assertIn("L.cursor = (L.cursor + 1) % L.cap", particles_src)

        # 12) Uncached LOS defaults to false
        self.assertIn("if (en._losCache === undefined) return false;", enemies_src)

        # 13) Viewmodel material disposal
        self.assertIn("if (o.material)", weapons_src)

        # 14) Weapon raise blocks firing
        self.assertIn("gunSwitchT >= 1", weapons_src)

    def test_soldier_hitbox_invariant(self) -> None:
        # head hitbox (on the head joint) must sit above the torso hitbox (on the spine joint)
        rig = (ROOT / "src" / "38_soldier.js").read_text()
        num = r"(-?[\d.]+)"
        hips = float(re.search(r"joint\(root, 'hips', 0, " + num + ", 0\)", rig).group(1))
        spine = float(re.search(r"joint\(hips, 'spine', 0, " + num + ", 0\)", rig).group(1))
        neck = float(re.search(r"joint\(spine, 'neck', 0, " + num, rig).group(1))
        head = float(re.search(r"joint\(neck, 'head', 0, " + num, rig).group(1))
        m = re.search(r"piece\(spine, boxG\([\d.]+, " + num + r", [\d.]+\), hbMat, 0, " + num, rig)
        body_top = hips + spine + float(m.group(2)) + float(m.group(1)) / 2
        m = re.search(r"piece\(head, boxG\([\d.]+, " + num + r", [\d.]+\), hbMat, 0, " + num, rig)
        head_bottom = hips + spine + neck + head + float(m.group(2)) - float(m.group(1)) / 2
        self.assertLess(body_top, head_bottom, f"body top {body_top} must be below head bottom {head_bottom}")

    def test_ground_mesh_in_raycast_colliders(self) -> None:
        world_source = (ROOT / "src" / "10_config_world.js").read_text()
        self.assertIn("raycastColliders.push(ground);", world_source)
        self.assertNotIn("colliders.push(ground)", world_source)
        self.assertIn("scene.add(ground);\nraycastColliders.push(ground);", world_source)

    def test_sniper_is_always_carried_and_penetrates_walls(self) -> None:
        world = (ROOT / "src" / "10_config_world.js").read_text()
        weapons = (ROOT / "src" / "30_weapons.js").read_text()
        vm = (ROOT / "src" / "32_viewmodels.js").read_text()
        self.assertIn("carried: true", world)
        self.assertIn("wallPen: 0.95", world)
        self.assertIn("const weaponsOwned = [0, SNIPER, PISTOL];", weapons)
        self.assertIn("function wallThickness(point, dir)", weapons)
        self.assertNotIn("adsAmount *= 0.45", weapons)            # no forced unscope after a shot
        self.assertNotIn("s.cycleT > 0 && w.bolt);", vm)          # stays scoped through the bolt cycle
        self.assertIn("function drawScope(dt)", (ROOT / "src" / "34_scope.js").read_text())

    def test_settings_are_persisted_defensively(self) -> None:
        src = (ROOT / "src" / "07_settings.js").read_text()
        self.assertIn("const SETTINGS_KEY", src)
        self.assertIn("QUALITY_PRESETS", src)
        for q in ("low:", "medium:", "high:"):
            self.assertIn(q, src)
        # storage access can throw (private mode / file://): every access sits in a try
        lines = src.splitlines()
        for i, line in enumerate(lines):
            if "localStorage." in line:
                context = line + (lines[i - 1] if i else "") + (lines[i - 2] if i > 1 else "")
                self.assertIn("try", context, f"unguarded storage access: {line.strip()}")

    def test_sky_shaders_encode_output_for_pmrem(self) -> None:
        # Regression: without the encoding include the RGBE-encoded PMREM target
        # decoded the sky as ~2^127 and NaN-poisoned every reflective material.
        world = (ROOT / "src" / "10_config_world.js").read_text()
        sky = world[world.index("function makeSkyMaterial"):world.index("const skyDome")]
        self.assertIn("#include <encodings_fragment>", sky)
        self.assertNotIn("(h + 0.02)", sky)   # old star term divided by zero below the horizon

    def test_first_frame_negative_dt_is_clamped(self) -> None:
        self.assertIn("if (!(dt > 0)) dt = 0;", MAIN.read_text())

    def test_viewmodel_springs_are_substepped(self) -> None:
        vm = (ROOT / "src" / "32_viewmodels.js").read_text()
        self.assertIn("Math.ceil(dt * 120)", vm)
        self.assertIn("isFinite(x)", vm)

    def test_stairs_block_ground_navigation(self) -> None:
        nav = (ROOT / "src" / "45_navigation.js").read_text()
        self.assertIn("function computeFlow", nav)
        self.assertNotIn("if (isStairStep(c)) { NAV.stairs.push(c); continue; }", nav)

    def test_postfx_has_plain_render_fallback(self) -> None:
        post = (ROOT / "src" / "65_postfx.js").read_text()
        self.assertIn("POST.failed = true", post)
        self.assertIn("if (!POST.enabled) {", post)
        self.assertIn("EXT_color_buffer_float", post)

    def test_weapon_roster_has_sidearm_and_primaries(self) -> None:
        world = (ROOT / "src" / "10_config_world.js").read_text()
        roster = world[world.index("weapons: ["):world.index("  ai: {")]
        self.assertEqual(roster.count("sidearm: true"), 1)
        for t in ("'AR'", "'SMG'", "'BR'", "'SR'", "'SG'", "'LMG'", "'PST'"):
            self.assertIn("type: " + t, roster)

    def test_menu_assets_embedded_and_dist_under_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "Operation Blackout.html"
            result = subprocess.run(
                [sys.executable, str(BUILD), str(ROOT), "--output", str(output)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            content = output.read_text()
            self.assertIn("data:image/jpeg;base64,", content)
            self.assertIn("data:image/svg+xml;base64,", content)
            self.assertIn("menu-emblem", content)
            self.assertLess(output.stat().st_size, 2 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main(verbosity=2)
