#!/usr/bin/env python3
"""Headless verification: load the release build in Chromium, start the game
through the real UI flow (DEPLOY -> weapon card), and probe live gameplay state.

Usage: python3 scripts/probe_live.py [--build <path>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BUILD = ROOT / "dist" / "Operation Blackout.html"


def wait_until(page, expr, timeout_s=20):
    import time
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if page.evaluate(expr):
                return True
        except Exception:
            pass
        page.wait_for_timeout(400)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", type=Path, default=DEFAULT_BUILD)
    args = ap.parse_args()

    checks = []
    console_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))
        page.goto(args.build.resolve().as_uri())

        # 1) Boot + asset preload gate.
        checks.append(("boot-three-loaded", page.evaluate("() => typeof THREE !== 'undefined'")))
        checks.append(("assets-preloaded", wait_until(page, "() => typeof assetsReady !== 'undefined' && assetsReady === true", 30)))
        checks.append(("deploy-button-enabled", page.evaluate("() => !document.getElementById('btn-start').classList.contains('disabled')")))
        checks.append(("telemetry-disabled-by-default", page.evaluate("() => window.fpsGameTelemetry && window.fpsGameTelemetry.snapshot().enabled === false")))

        # 2) Real UI flow: DEPLOY -> gun-select -> PRIMARY card -> SECONDARY card.
        #    Picking a primary re-opens the same screen for the secondary, and only
        #    then does the run start; a single click leaves the game in the loadout.
        page.click("#btn-start")
        checks.append(("gun-select-opened", page.evaluate("() => document.getElementById('gun-select').style.display === 'flex'")))
        page.wait_for_timeout(300)
        cards = page.evaluate("() => document.querySelectorAll('#gun-select .gun-card').length")
        checks.append(("weapon-cards-present", cards > 0))
        # Exercise the real settings checkbox, then inspect a genuinely hovered card.
        def motion_setting(enabled):
            page.evaluate("() => document.getElementById('btn-settings').click()")
            page.evaluate("""enabled => {
                const box = document.getElementById('set-reducedMotion');
                if (box.checked !== enabled) box.click();
                document.getElementById('btn-settings-back').click();
            }""", enabled)

        motion_setting(False)
        page.hover('#gun-select .gun-card')
        page.wait_for_timeout(200)
        motion_normal = page.evaluate("""() => {
            const s = getComputedStyle(document.querySelector('#gun-select .gun-card'));
            return s.transitionDuration === '0.15s' && s.transform !== 'none';
        }""")
        checks.append(("loadout-normal-hover-preserved", motion_normal))
        motion_setting(True)
        motion_reduced = page.evaluate("""() => {
            const card = document.querySelector('#gun-select .gun-card');
            const controls = document.querySelectorAll('.gun-card,.menu-btn,.diff-btn');
            return document.body.classList.contains('reduced-motion') &&
                getComputedStyle(card).transform === 'none' &&
                Array.from(controls).every(el => getComputedStyle(el).transitionDuration === '0s');
        }""")
        checks.append(("reduced-motion-menu-feedback", motion_reduced))
        motion_setting(False)
        page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
        page.wait_for_timeout(600)
        checks.append(("secondary-prompt-shown", wait_until(
            page,
            "() => (document.querySelector('#gun-select h2') || {}).textContent === 'SELECT SECONDARY'",
            10)))
        page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
        page.wait_for_timeout(600)

        # 3) Game started: start screen hidden, countdown then wave 1.
        #    Budget is generous: wave 1 begins after a short in-game countdown and
        #    in-game time runs several times slower than wall clock when frames are
        #    slow (headless/swiftshader), so 25 s was not enough headroom.
        checks.append(("start-screen-hidden", page.evaluate("() => document.getElementById('start-screen').style.display === 'none'")))
        telemetry_snapshot = page.evaluate("""() => {
            const before = window.fpsGameTelemetry.snapshot();
            window.fpsGameTelemetry.enable();
            return { before, after: window.fpsGameTelemetry.snapshot() };
        }""")
        telemetry_after = wait_until(page, "() => window.fpsGameTelemetry.snapshot().summary.count > 0", 5)
        telemetry_final = page.evaluate("() => window.fpsGameTelemetry.snapshot()")
        checks.append(("telemetry-runtime-snapshot", telemetry_snapshot["before"]["enabled"] is False and
                       telemetry_final["enabled"] is True and telemetry_after))
        page.evaluate("() => window.fpsGameTelemetry.disable()")
        checks.append(("enemies-spawned", wait_until(page, "() => typeof enemies !== 'undefined' && enemies.length > 0", 60)))

        # 4) Enemies move and are grounded near y=0.
        s1 = page.evaluate("() => enemies.map(e => [e.pos.x, e.pos.y, e.pos.z])")
        page.wait_for_timeout(2000)
        s2 = page.evaluate("() => enemies.map(e => [e.pos.x, e.pos.y, e.pos.z])")
        if s1 and s2 and len(s1) == len(s2):
            moved = any(abs(a[0]-b[0]) > 0.01 or abs(a[1]-b[1]) > 0.01 or abs(a[2]-b[2]) > 0.01
                        for a, b in zip(s1, s2))
            checks.append(("enemies-move", moved))
            checks.append(("enemies-grounded", all(abs(y) < 1.0 for _, y, _ in s2)))
        else:
            checks.append(("enemies-move", False))
            checks.append(("enemies-grounded", False))

        # 5) Scoped raycast colliders registered (fix #1 live sanity).
        # Every station must have somewhere to stand. Two wall buys shipped inside
        # corner-district geometry the first time this ran, which is exactly the
        # failure this catches: unreachable, and invisible to a unit test because
        # it needs the built arena.
        bad = page.evaluate("() => window.__unreachableStations || []")
        if bad:
            console_errors.append("unreachable stations: %s" % bad)
        checks.append(("stations-all-reachable", bad == []))
        n_st = page.evaluate("() => typeof stations !== 'undefined' ? stations.length : -1")
        checks.append(("stations-built", n_st > 0))

        n = page.evaluate("() => typeof raycastColliders !== 'undefined' ? raycastColliders.length : -1")
        checks.append(("raycast-colliders-live", n > 0))

        # 6) Firing works: simulate a shot through the game's own function.
        shot = page.evaluate("""() => {
            try {
                if (typeof fireShot !== 'function' || typeof wState === 'undefined' || !wState.length) return false;
                const before = wState[curWeapon].ammo;
                fireShot();
                return wState[curWeapon].ammo <= before;
            } catch (e) { return false; }
        }""")
        checks.append(("fireshot-runs", shot))

        # Casings must obey the documented 24-mesh budget even in a burst.
        casing_check = page.evaluate("""() => {
            updateCasings(10);
            for (let i = 0; i < 60; i++) spawnCasing(camera.position, camera.quaternion);
            const count = casings.length;
            updateCasings(10);
            return {count, remaining: casings.length};
        }""")
        checks.append(("casing-burst-capped-at-24", casing_check["count"] == 24))
        checks.append(("casings-expire", casing_check["remaining"] == 0))

        # 7) The two reported through-floor bugs, as end-to-end guards.
        #
        # Both have unit tests in CORE, and neither of those would have caught the
        # real defect: the melee one was a horizontal-distance check in the engine
        # layer, and the bullet one was a setTimeout callback. They only show up with
        # the real arena geometry and the real update loop, which is what this probe
        # exists for.
        #
        # Every check below carries a CONTROL. "0 damage taken" is also what a broken
        # shooter looks like, and a guard that cannot fail is not a guard.
        melee = page.evaluate("""() => {
            const step = 1 / 60;
            const SLAB_EYE = 4.15 + CFG.player.height;
            const real = damagePlayer;
            function run(playerY) {
                for (const e of enemies) e.dead = true;
                enemies.length = 0;
                if (typeof resetRagdolls === 'function') resetRagdolls();
                player.pos.set(0, playerY, 0);
                player.dead = false; player.downed = false;
                player.health = 100; player.armor = 0; godMode = false;
                spawnEnemy(0, 0, 0);
                const en = enemies[0];
                en.pos.set(0, 0, 0);
                en.parts.group.position.copy(en.pos);
                en.dead = false; en.state = 'chase';
                let hits = 0;
                damagePlayer = function () { hits++; };
                try { for (let t = 0; t < 8; t += step) updateEnemies(step); }
                finally { damagePlayer = real; }
                return hits;
            }
            const upstairs = run(SLAB_EYE);
            const sameFloor = run(CFG.player.height);
            player.health = 100;
            return { upstairs, sameFloor };
        }""")
        checks.append(("no-melee-through-floor", melee["upstairs"] == 0))
        checks.append(("melee-still-works-same-floor", melee["sameFloor"] > 0))

        # Rounds land through setTimeout, so the counter has to outlive the call that
        # fires them: install it, fire, wait for the impacts, then read and restore.
        page.evaluate("""() => {
            const SLAB_EYE = 4.15 + CFG.player.height;
            for (const e of enemies) e.dead = true;
            enemies.length = 0;
            player.pos.set(0, CFG.player.height, 0);
            player.dead = false; player.downed = false;
            player.health = 100; player.armor = 0; godMode = false;
            spawnEnemy(1, 0, 5);
            const g = enemies[0];
            g.pos.set(0, 0, 5); g.parts.group.position.copy(g.pos); g.dead = false;
            window.__realDamage = damagePlayer;
            window.__hits = 0;
            damagePlayer = function () { window.__hits++; };
            for (let i = 0; i < 60; i++) {
                player.pos.set(0, CFG.player.height, 0);
                enemyShoot(g, 5);
                player.pos.set(0, SLAB_EYE, 0);      // climb before the round lands
            }
        }""")
        page.wait_for_timeout(1000)
        climbed = page.evaluate("() => { const n = window.__hits; window.__hits = 0; return n; }")
        page.evaluate("""() => {
            const g = enemies[0];
            for (let i = 0; i < 60; i++) {
                player.pos.set(0, CFG.player.height, 0);
                enemyShoot(g, 5);
            }
        }""")
        page.wait_for_timeout(1000)
        stayed = page.evaluate("""() => {
            const n = window.__hits;
            damagePlayer = window.__realDamage;
            player.health = 100;
            return n;
        }""")
        checks.append(("no-bullets-through-floor", climbed == 0))
        checks.append(("bullets-still-land-in-the-open", stayed > 0))

        # 8) Ragdolls: corpses appear, stay capped, settle, and clean themselves up.
        rag = page.evaluate("""() => {
            const step = 1 / 60;
            for (const e of enemies) e.dead = true;
            enemies.length = 0;
            resetRagdolls();
            godMode = true;
            player.pos.set(0, CFG.player.height, 24);
            for (let i = 0; i < 12; i++) {
                spawnEnemy(1, -8 + i * 1.4, 30);
                const en = enemies[enemies.length - 1];
                en.pos.set(-8 + i * 1.4, 0, 30);
                en.parts.group.position.copy(en.pos);
                en.health = 1;
                damageEnemy(en, 200, new THREE.Vector3(en.pos.x, 1.2, en.pos.z + 0.3), false);
            }
            updateEnemies(step);
            const spawned = ragdollCount();
            const aiListCleared = enemies.length;
            let lowest = Infinity, settledAll = true, casters = 0;
            for (let t = 0; t < 6; t += step) updateRagdolls(step);
            for (const r of ragdolls) {
                if (!r.rag.settled) settledAll = false;
                for (const q of r.rag.order) if (q.y < lowest) lowest = q.y;
                r.en.parts.group.traverse(function (o) { if (o.isMesh && o.castShadow) casters++; });
            }
            for (let t = 0; t < 20; t += step) updateRagdolls(step);
            const after = ragdollCount();
            godMode = false;
            return { spawned, aiListCleared, settledAll, casters,
                     lowest: isFinite(lowest) ? lowest : 0, after, cap: RAGDOLL_MAX };
        }""")
        checks.append(("corpses-capped", rag["spawned"] == rag["cap"]))
        checks.append(("dead-leave-the-ai-list", rag["aiListCleared"] == 0))
        checks.append(("corpses-settle", rag["settledAll"]))
        checks.append(("corpses-stay-above-ground", rag["lowest"] >= -0.01))
        checks.append(("corpses-cast-no-shadows", rag["casters"] == 0))
        checks.append(("corpses-clean-up", rag["after"] == 0))

        # 9) No GPU geometry growth across sustained combat. ROB-04 leaked one
        #    geometry per grenade for the life of the session; this is the guard.
        leak = page.evaluate("""() => {
            const step = 1 / 60;
            const before = renderer.info.memory.geometries;
            godMode = true;
            for (let n = 0; n < 3; n++) {
                for (let i = 0; i < 6; i++) {
                    throwGrenade(9, CORE.LETHALS[0]);
                    for (let t = 0; t < 3; t += step) updateGrenades(step);
                }
                for (let t = 0; t < 2; t += step) { updateGrenades(step); updateRagdolls(step); }
            }
            godMode = false;
            return renderer.info.memory.geometries - before;
        }""")
        checks.append(("no-geometry-growth", leak <= 0))

        # 10) Audio cues: plate insertion completion & sniper acoustic jitter.
        plate_audio = page.evaluate("""() => {
            const played = [];
            const realPlay = playSound;
            playSound = function (name) { played.push(name); realPlay(name); };
            try {
                player.armor = 0;
                plates = 1;
                plateT = 0;
                usePlate();
                updateStations(CORE.PLATE_TIME);
                return played.includes('reload_out') && played.includes('reload_in');
            } finally {
                playSound = realPlay;
            }
        }""")
        checks.append(("plate-audio-cues", plate_audio))
        checks.append(("sniper-sound-varied", page.evaluate("() => typeof SOUND_VARIED !== 'undefined' && SOUND_VARIED.sniper === 1")))
        checks.append(("action-sounds-varied", page.evaluate("() => typeof SOUND_VARIED !== 'undefined' && ['jump', 'land', 'melee', 'bounce', 'headshot', 'slide', 'hurt'].every(k => SOUND_VARIED[k] === 1)")))
        jitter_check = page.evaluate("""() => {
            if (typeof CORE.soundPlaybackRate !== 'function') return false;
            const mid = CORE.soundPlaybackRate(1, 0.5);
            const low = CORE.soundPlaybackRate(1, 0);
            const high = CORE.soundPlaybackRate(1, 1);
            return Math.abs(mid - 1.0) < 1e-6 && Math.abs(low - 0.97) < 1e-6 && Math.abs(high - 1.03) < 1e-6;
        }""")
        checks.append(("sound-playback-rate-jitter", jitter_check))
        spatial_audio_check = page.evaluate("""() => {
            if (typeof CORE.spatialAudioParams !== 'function' || typeof CORE.spatialAudioPan !== 'function') return false;
            const right = CORE.spatialAudioParams(10, 0, 0);
            const left = CORE.spatialAudioParams(-10, 0, 0);
            const front = CORE.spatialAudioParams(0, -10, 0);
            const distant = CORE.spatialAudioParams(60, 0, 0);
            const panOk = right.pan === 1.0 && left.pan === -1.0 && front.pan === 0;
            const distOk = right.audible === true && distant.audible === false && distant.vol === 0;
            return panOk && distOk;
        }""")
        checks.append(("spatial-audio-parameters", spatial_audio_check))

        # 11) Visual feedback: low-health HUD warning state.
        health_hud = page.evaluate("""() => {
            const bar = document.getElementById('health-bar');
            const num = document.getElementById('health-num');
            player.health = 25;
            updateHudHealth();
            const lowApplied = bar.classList.contains('low') && num.classList.contains('low');
            player.health = 100;
            updateHudHealth();
            const lowCleared = !bar.classList.contains('low') && !num.classList.contains('low');
            return lowApplied && lowCleared;
        }""")
        checks.append(("low-health-hud-warning", health_hud))

        # 12) The NE district entrance carries a high-contrast, emissive sign cue.
        # This is intentionally a structural/readability guard: it checks the live
        # config and material values without claiming anything about frame rate.
        district_visual = page.evaluate("""() => {
            const v = window.__districtReadability;
            if (!v || !v.ne) return false;
            return v.ne.label === 'NORTH-EAST DISTRICT' &&
                v.ne.panelColor === 0x1b2029 &&
                v.ne.accentColor === 0xffd34d &&
                v.ne.emissiveIntensity >= 0.7;
        }""")
        checks.append(("ne-district-sign-readable", district_visual))

        # 13) Perf: shadow budget stability (no redundant mesh mutations when positions stay stable).
        shadow_stability = page.evaluate("""() => {
            if (typeof updateEnemyShadowBudget !== 'function') return false;
            for (let i = 0; i < 6; i++) spawnEnemy(0, -6 + i * 2, 10);
            updateEnemyShadowBudget(1.0);
            const before = enemies.map(e => !!e._castsShadow);
            let meshUpdates = 0;
            const origSet = setEnemyCastShadow;
            setEnemyCastShadow = function (en, on) {
                if (en._castsShadow !== on) meshUpdates++;
                origSet(en, on);
            };
            try {
                updateEnemyShadowBudget(1.0);
                const after = enemies.map(e => !!e._castsShadow);
                const identical = before.length > 0 && before.every((val, idx) => val === after[idx]);
                return identical && meshUpdates === 0;
            } finally {
                setEnemyCastShadow = origSet;
                for (const e of enemies) { scene.remove(e.parts.group); disposeEnemyGeometry(e); }
                enemies.length = 0;
            }
        }""")
        checks.append(("shadow-budget-no-flap", shadow_stability))

        # 13) Mobile touch input rules & active feedback styling.
        auto_sprint_check = page.evaluate("""() => {
            if (typeof CORE.isAutoSprint !== 'function') return false;
            return CORE.isAutoSprint(0, 1.0, false) === true &&
                   CORE.isAutoSprint(0, 1.0, true) === false &&
                   CORE.isAutoSprint(0.85, 0.5, false) === false &&
                   CORE.isAutoSprint(0, 0.75, false) === false;
        }""")
        checks.append(("touch-auto-sprint-rule", auto_sprint_check))

        touch_style_check = page.evaluate("""() => {
            document.body.classList.add('touch');
            const fire = document.createElement('div');
            fire.id = 'tbtn-fire';
            fire.className = 'tbtn on';
            document.body.appendChild(fire);
            const fireBorder = getComputedStyle(fire).borderColor;
            document.body.removeChild(fire);

            const joyBase = document.createElement('div');
            joyBase.id = 'joy-base';
            joyBase.className = 'on';
            const stick = document.createElement('div');
            stick.id = 'joy-stick';
            joyBase.appendChild(stick);
            document.body.appendChild(joyBase);
            const stickBorder = getComputedStyle(stick).borderColor;
            document.body.removeChild(joyBase);

            document.body.classList.remove('touch');
            const fireOk = fireBorder.includes('255, 95, 74') || fireBorder.includes('rgb(255, 95, 74)');
            const stickOk = stickBorder.includes('255, 210, 74') || stickBorder.includes('rgb(255, 210, 74)');
            return fireOk && stickOk;
        }""")
        checks.append(("touch-active-feedback-styles", touch_style_check))

        joystick_input_check = page.evaluate("""() => {
            if (typeof CORE.joystickInput !== 'function') return false;
            const fullUp = CORE.joystickInput(0, -112, 56, 0.12);
            const fullRight = CORE.joystickInput(112, 0, 56, 0.12);
            const deadzone = CORE.joystickInput(4, -4, 56, 0.12);
            const clamped = fullUp.clampedX === 0 && fullUp.clampedY === -56 &&
                            fullUp.moveX === 0 && fullUp.moveZ === 1.0;
            const rightOk = fullRight.clampedX === 56 && fullRight.clampedY === 0 &&
                            fullRight.moveX === 1.0 && fullRight.moveZ === 0;
            const deadOk = deadzone.moveX === 0 && deadzone.moveZ === 0 &&
                           deadzone.clampedX === 4 && deadzone.clampedY === -4;
            return clamped && rightOk && deadOk;
        }""")
        checks.append(("joystick-input-rule", joystick_input_check))

        touch_sprint_style_check = page.evaluate("""() => {
            document.body.classList.add('touch');
            const joyBase = document.createElement('div');
            joyBase.id = 'joy-base';
            joyBase.className = 'on sprint';
            const stick = document.createElement('div');
            stick.id = 'joy-stick';
            joyBase.appendChild(stick);
            document.body.appendChild(joyBase);
            const baseBorder = getComputedStyle(joyBase).borderColor;
            const stickBorder = getComputedStyle(stick).borderColor;
            document.body.removeChild(joyBase);
            document.body.classList.remove('touch');

            const baseOk = baseBorder.includes('80, 180, 255') || baseBorder.includes('rgb(80, 180, 255)');
            const stickOk = stickBorder.includes('80, 180, 255') || stickBorder.includes('rgb(80, 180, 255)');
            return baseOk && stickOk;
        }""")
        checks.append(("touch-sprint-feedback-styles", touch_sprint_style_check))

        # 14) Balance: medkit drop scaling and pickup drop kind resolution.
        pickup_balance_check = page.evaluate("""() => {
            if (typeof CORE.medDropChance !== 'function' || typeof CORE.pickupDropKind !== 'function') return false;
            const fullHp = CORE.medDropChance(100, 100);
            const midHp = CORE.medDropChance(50, 100);
            const critHp = CORE.medDropChance(0, 100);
            const scavCrit = CORE.medDropChance(0, 100, 1.6);
            const smooth = fullHp === 0.15 && midHp > 0.15 && midHp < 0.25 && critHp === 0.50 && Math.abs(scavCrit - 0.80) < 1e-6;
            const kindsOk = CORE.pickupDropKind(0.1, 0.3, 0.2) === 'ammo' &&
                            CORE.pickupDropKind(0.35, 0.3, 0.2) === 'med' &&
                            CORE.pickupDropKind(0.55, 0.3, 0.2) === null;
            return smooth && kindsOk;
        }""")
        checks.append(("pickup-drop-balance-rules", pickup_balance_check))

        # 15) Visual feedback: ammo HUD empty glow, low warning, and contextual reload hint.
        ammo_hud_check = page.evaluate("""() => {
            if (typeof CORE.isAmmoLow !== 'function' || typeof CORE.isAmmoEmpty !== 'function' || typeof CORE.reloadPrompt !== 'function') return false;
            const coreOk = CORE.isAmmoLow(7, 30) === true &&
                           CORE.isAmmoLow(8, 30) === false &&
                           CORE.isAmmoEmpty(0) === true &&
                           CORE.isAmmoEmpty(1) === false &&
                           CORE.reloadPrompt(false, 0, 60, false) === 'RELOAD [R]' &&
                           CORE.reloadPrompt(false, 0, 60, true) === 'RELOAD' &&
                           CORE.reloadPrompt(true, 0, 60, false) === 'RELOADING' &&
                           CORE.reloadPrompt(false, 0, 0, false) === 'OUT OF AMMO — FIND PICKUPS';
            if (!coreOk) return false;

            const s = curS();
            if (!s) return false;
            const origAmmo = s.ammo, origRes = s.reserve, origRel = s.reloading;
            try {
                // Empty mag with reserve available
                s.ammo = 0; s.reserve = 60; s.reloading = false;
                updateHudAmmo();
                const emptyOk = hud.ammoMag.classList.contains('empty') &&
                                hud.ammoMag.classList.contains('low') &&
                                hud.reloadHint.classList.contains('urgent') &&
                                hud.reloadHint.textContent === 'RELOAD [R]' &&
                                hud.reloadHint.style.opacity === '1';

                // Actively reloading
                s.reloading = true;
                updateHudAmmo();
                const reloadOk = hud.reloadHint.textContent === 'RELOADING' &&
                                 !hud.reloadHint.classList.contains('urgent');

                // Fully replenished
                s.ammo = 30; s.reloading = false;
                updateHudAmmo();
                const fullOk = !hud.ammoMag.classList.contains('empty') &&
                               !hud.ammoMag.classList.contains('low') &&
                               hud.reloadHint.style.opacity === '0';

                return emptyOk && reloadOk && fullOk;
            } finally {
                s.ammo = origAmmo; s.reserve = origRes; s.reloading = origRel;
                updateHudAmmo();
            }
        }""")
        checks.append(("ammo-hud-visual-feedback", ammo_hud_check))

        # 16) Perf: fast AABB boundary pushout rule & mutation correctness.
        aabb_check = page.evaluate("""() => {
            if (typeof CORE.resolveAabbXZ !== 'function') return false;
            const box = { min: { x: -5, y: 0, z: -10 }, max: { x: 5, y: 2, z: 10 } };
            const outside = CORE.resolveAabbXZ(6.0, 0, 0.5, box) === null &&
                            CORE.resolveAabbXZ(0, 11.0, 0.5, box) === null;
            const out = { axis: '', val: 0 };
            const hit = CORE.resolveAabbXZ(5.2, 0, 0.5, box, out);
            const refIdentical = hit === out && out.axis === 'x' && out.val === 5.5;
            const hitZ = CORE.resolveAabbXZ(0, 10.2, 0.5, box, out);
            const zOk = hitZ === out && out.axis === 'z' && out.val === 10.5;
            return outside && refIdentical && zOk;
        }""")
        checks.append(("aabb-resolve-rule", aabb_check))

        # 17) Balance: combat damage resolution and armor absorption rules.
        combat_balance_check = page.evaluate("""() => {
            if (typeof CORE.resolveArmorDamage !== 'function' ||
                typeof CORE.enemyMeleeDamage !== 'function' ||
                typeof CORE.enemyRangedDamage !== 'function') return false;
            const r1 = CORE.resolveArmorDamage(20, 50);
            const r2 = CORE.resolveArmorDamage(20, 8);
            const r3 = CORE.resolveArmorDamage(25, 0);
            const armorOk = r1.absorbed === 13 && r1.healthDamage === 7 && r1.remainingArmor === 37 &&
                            r2.absorbed === 8 && r2.healthDamage === 12 && r2.remainingArmor === 0 &&
                            r3.absorbed === 0 && r3.healthDamage === 25 && r3.remainingArmor === 0;
            const meleeRunner = CORE.enemyMeleeDamage(18, false, 1, 1.0, false);
            const meleeTank = CORE.enemyMeleeDamage(18, true, 1, 1.0, false);
            const meleeElite = CORE.enemyMeleeDamage(18, false, 12, 1.0, true);
            const meleeOk = Math.abs(meleeRunner - 18.4) < 1e-4 &&
                            Math.abs(meleeTank - 28.4) < 1e-4 &&
                            Math.abs(meleeElite - (22.8 * 1.35)) < 1e-4;
            const rangedRifle = CORE.enemyRangedDamage(8, 1, 1.0, false);
            const rangedElite = CORE.enemyRangedDamage(8, 12, 1.0, true);
            const rangedOk = Math.abs(rangedRifle - 8.35) < 1e-4 &&
                             Math.abs(rangedElite - (12.2 * 1.35)) < 1e-4;
            return armorOk && meleeOk && rangedOk;
        }""")
        checks.append(("combat-damage-balance-rules", combat_balance_check))

        # 18) Clean console throughout gameplay.
        checks.append(("no-console-errors", len(console_errors) == 0))

        browser.close()

    passed = sum(1 for _, ok in checks if ok)
    failed = [name for name, ok in checks if not ok]
    # Human-readable summary FIRST, on stderr, so a CI log shows what broke without
    # anyone reading 28 JSON entries. The JSON still follows for machine consumers.
    if failed:
        print("PROBE FAILED: %d of %d checks" % (len(failed), len(checks)), file=sys.stderr)
        for name in failed:
            print("  x %s" % name, file=sys.stderr)
        if console_errors:
            print("  console errors:", file=sys.stderr)
            for e in console_errors[:5]:
                print("    %s" % e, file=sys.stderr)
    else:
        print("PROBE OK: %d checks passed" % len(checks), file=sys.stderr)
    print(json.dumps({
        "build": str(args.build),
        "checks": [{"name": n, "ok": ok} for n, ok in checks],
        "passed": passed,
        "total": len(checks),
        "console_errors": console_errors[:10],
    }, indent=2))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
