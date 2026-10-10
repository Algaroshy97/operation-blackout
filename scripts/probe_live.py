#!/usr/bin/env python3
"""Headless verification: load the release build in Chromium, start the game
through the real UI flow (DEPLOY -> weapon card), and probe live gameplay state.

Usage: python3 scripts/probe_live.py [--build <path>]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BUILD = ROOT / "dist" / "Operation Blackout.html"


def sanitize_headless_env() -> None:
    """Ensure headless Chromium has a clean environment without dead X11 displays."""
    disp = os.environ.get("DISPLAY")
    if not disp:
        return
    if disp.startswith(":"):
        screen = disp.split(":")[1].split(".")[0]
        sock = Path(f"/tmp/.X11-unix/X{screen}")
        if not sock.exists():
            del os.environ["DISPLAY"]
            return
    if shutil.which("xdpyinfo"):
        try:
            if subprocess.run(["xdpyinfo"], capture_output=True, timeout=1).returncode != 0:
                del os.environ["DISPLAY"]
        except Exception:
            del os.environ["DISPLAY"]


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
    sanitize_headless_env()
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
                player.dead = false; player.downed = false; player.health = 100;
                player.armor = 0;
                plates = 1;
                plateT = 0;
                usePlate();
                const inserting = played.length === 1 && played[0] === 'plate_insert' &&
                    plateT === CORE.PLATE_TIME && player.armor === 0 && plates === 1;
                updateStations(CORE.PLATE_TIME);
                return inserting && played.length === 2 && played[1] === 'plate_lock' &&
                    plateT === 0 && player.armor > 0 && plates === 0;
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

        # 18) Visual feedback: armor HUD warning and empty state.
        armor_hud_check = page.evaluate("""() => {
            if (typeof CORE.isArmorLow !== 'function' || typeof CORE.isArmorEmpty !== 'function') return false;
            const coreOk = CORE.isArmorLow(10, 50) === true &&
                           CORE.isArmorLow(15, 50) === false &&
                           CORE.isArmorLow(0, 50) === false &&
                           CORE.isArmorEmpty(0) === true &&
                           CORE.isArmorEmpty(10) === false;
            if (!coreOk) return false;

            const bar = document.getElementById('armor-bar');
            const bg = bar ? bar.parentElement : null;
            if (!bar || !bg) return false;

            const origArmor = player.armor;
            try {
                // Low armor state (e.g. 10/50 = 20%)
                player.armor = 10;
                updateHudHealth();
                const lowOk = bar.classList.contains('low') && !bg.classList.contains('empty');

                // Empty / broken armor state (0/50)
                player.armor = 0;
                updateHudHealth();
                const emptyOk = !bar.classList.contains('low') && bg.classList.contains('empty');

                // Fully replenished armor (50/50)
                player.armor = 50;
                updateHudHealth();
                const fullOk = !bar.classList.contains('low') && !bg.classList.contains('empty');

                return lowOk && emptyOk && fullOk;
            } finally {
                player.armor = origArmor;
                updateHudHealth();
            }
        }""")
        checks.append(("armor-hud-visual-feedback", armor_hud_check))

        # 19) Perf: vertical collision bounds and headroom rules.
        vert_check = page.evaluate("""() => {
            if (typeof CORE.resolveVerticalBounds !== 'function' ||
                typeof CORE.findFloorY !== 'function' ||
                typeof CORE.hasCrouchHeadroom !== 'function') return false;
            const colliders = [
                { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 1.0, z: 2 } },
                { min: { x: -2, y: 3.0, z: -2 }, max: { x: 2, y: 4.0, z: 2 } }
            ];
            const out = { floorY: 0, ceilY: 0 };
            const res = CORE.resolveVerticalBounds(0, 0, 0.4, colliders, 0.8, 0.6, 0, out);
            const resOk = res === out && out.floorY === 1.0 && out.ceilY === 3.0;
            const floorOnly = CORE.findFloorY(0, 0, 0.4, colliders, 0.8, 0.6, 0);
            const floorOk = floorOnly === 1.0;
            const lowSlab = [{ min: { x: -2, y: 1.0, z: -2 }, max: { x: 2, y: 2.0, z: 2 } }];
            const blockedHeadroom = CORE.hasCrouchHeadroom(0, 0, 0.4, 1.2, 1.7, lowSlab);
            const clearHeadroom = CORE.hasCrouchHeadroom(10, 10, 0.4, 1.2, 1.7, lowSlab);
            return resOk && floorOk && (blockedHeadroom === false) && (clearHeadroom === true);
        }""")
        checks.append(("vertical-collision-rules", vert_check))

        # 20) Audio polish: ordnance 3D spatial audio & contact rules.
        ordnance_audio_check = page.evaluate("""() => {
            if (typeof CORE.spatialExplosionParams !== 'function' ||
                typeof CORE.tacticalDetonationSound !== 'function' ||
                typeof CORE.grenadeContactSound !== 'function') return false;
            const distOk = CORE.SPATIAL_EXPLOSION_MAX_DIST === 85 &&
                           CORE.spatialExplosionParams(70, 0, 0).audible === true &&
                           CORE.spatialExplosionParams(90, 0, 0).audible === false &&
                           CORE.spatialExplosionParams(20, 0, 0).pan === 1.0;
            const tacticalOk = CORE.tacticalDetonationSound('smoke') === 'explosion' &&
                               CORE.tacticalDetonationSound('blind') === 'headshot' &&
                               CORE.tacticalDetonationSound('stun') === 'pin';
            const contactOk = CORE.grenadeContactSound(true, 0) === 'pin' &&
                              CORE.grenadeContactSound(false, -2) === 'bounce' &&
                              CORE.grenadeContactSound(false, 0.2) === null;
            const variedOk = typeof SOUND_VARIED !== 'undefined' &&
                             ['block', 'kill', 'dry', 'pickup_ammo', 'pickup_med'].every(k => SOUND_VARIED[k] === 1);
            return distOk && tacticalOk && contactOk && variedOk;
        }""")
        checks.append(("ordnance-spatial-audio-rules", ordnance_audio_check))

        # 21) Mobile UI polish: touch movement resolution & reload feedback rules.
        touch_reload_check = page.evaluate("""() => {
            if (typeof CORE.touchMovementKeys !== 'function' ||
                typeof CORE.touchReloadState !== 'function' ||
                typeof CORE.JOYSTICK_MOVE_THRESHOLD !== 'number') return false;
            const thresholdOk = CORE.JOYSTICK_MOVE_THRESHOLD === 0.15;
            const out = { w: false, s: false, a: false, d: false };
            const res = CORE.touchMovementKeys(0.5, -0.6, 0.15, out);
            const moveOk = res === out && out.w === false && out.s === true && out.d === true && out.a === false;
            const deadOk = CORE.touchMovementKeys(0.1, -0.1).s === false;
            const urgentOk = CORE.touchReloadState(0, 30, false) === 'urgent';
            const reloadingOk = CORE.touchReloadState(0, 30, true) === 'reloading';
            const emptyResOk = CORE.touchReloadState(0, 0, false) === '';
            const fullMagOk = CORE.touchReloadState(15, 30, false) === '';

            document.body.classList.add('touch');
            const uEl = document.createElement('div');
            uEl.id = 'tbtn-reload';
            uEl.className = 'tbtn urgent';
            document.body.appendChild(uEl);
            const urgentBorder = getComputedStyle(uEl).borderColor;
            document.body.removeChild(uEl);

            const rEl = document.createElement('div');
            rEl.id = 'tbtn-reload';
            rEl.className = 'tbtn reloading';
            document.body.appendChild(rEl);
            const reloadBorder = getComputedStyle(rEl).borderColor;
            document.body.removeChild(rEl);
            document.body.classList.remove('touch');

            const styleOk = (urgentBorder.includes('255, 74, 61') || urgentBorder.includes('rgb(255, 74, 61)')) &&
                            (reloadBorder.includes('255, 210, 74') || reloadBorder.includes('rgb(255, 210, 74)'));

            return thresholdOk && moveOk && deadOk && urgentOk && reloadingOk && emptyResOk && fullMagOk && styleOk;
        }""")
        checks.append(("touch-movement-and-reload-rules", touch_reload_check))

        # 22) Combat balance: enemy health scaling, accuracy, player bullet damage, and shield absorption.
        combat_balance_check = page.evaluate("""() => {
            if (typeof CORE.enemyBaseHealth !== 'function' ||
                typeof CORE.enemyMaxHealth !== 'function' ||
                typeof CORE.enemyAccuracy !== 'function' ||
                typeof CORE.playerBulletDamage !== 'function' ||
                typeof CORE.shieldMultiplier !== 'function' ||
                typeof CORE.ENEMY_HEALTH_SCALE !== 'object') return false;
            const scaleOk = CORE.ENEMY_HEALTH_SCALE[0] === 1.0 &&
                            CORE.ENEMY_HEALTH_SCALE[2] === 3.2 &&
                            CORE.enemyBaseHealth(2, 100) === 320 &&
                            CORE.enemyBaseHealth(1, 100) === 135;
            const healthOk = CORE.enemyMaxHealth(0, 100, 1, 15, 1.0, 1.0, false) === 100 &&
                             CORE.enemyMaxHealth(2, 100, 1, 15, 1.25, 1.0, false) === 400 &&
                             CORE.enemyMaxHealth(2, 100, 1, 15, 1.0, 1.0, true) === 704;
            const accOk = Math.abs(CORE.enemyAccuracy(0.5, 0.035, 1, 0.75, 0) - 0.535) < 1e-6 &&
                          CORE.enemyAccuracy(0.5, 0.035, 10, 0.75, 0) === 0.75;
            const bulletDmgOk = CORE.playerBulletDamage(26, false, 1.8, 10, 120, 1.0) === 26 &&
                                Math.abs(CORE.playerBulletDamage(26, true, 1.8, 10, 120, 1.0) - 46.8) < 1e-6;
            const shieldOk = Math.abs(CORE.shieldMultiplier(3, 0, 0, 0, 0, 5) - 0.15) < 1e-6 &&
                             CORE.shieldMultiplier(3, 0, 0, 0, 0, -5) === 1.0 &&
                             CORE.shieldMultiplier(0, 0, 0, 0, 0, 5) === 1.0;
            return scaleOk && healthOk && accOk && bulletDmgOk && shieldOk;
        }""")
        checks.append(("combat-balance-and-scaling-rules", combat_balance_check))

        # 24) Kill hitmarker visual feedback: distinct tier, scale, color, duration, and class styling.
        hitmarker_check = page.evaluate("""() => {
            if (typeof CORE.hitmarkerTier !== 'function' ||
                typeof CORE.hitmarkerParams !== 'function' ||
                typeof CORE.HITMARK_COLOR !== 'object') return false;
            const killTier = CORE.hitmarkerTier(1.0, false, true);
            const blockTier = CORE.hitmarkerTier(0.15, false, false);
            const coverTier = CORE.hitmarkerTier(1.0, true, false);
            const hitTier = CORE.hitmarkerTier(1.0, false, false);
            const tiersOk = killTier === 'kill' && blockTier === 'block' &&
                            coverTier === 'cover' && hitTier === 'hit';

            const pKill = CORE.hitmarkerParams(false, 'kill');
            const pKillHs = CORE.hitmarkerParams(true, 'kill');
            const pBlock = CORE.hitmarkerParams(false, 'block');
            const pHit = CORE.hitmarkerParams(false, 'hit');
            const pHitHs = CORE.hitmarkerParams(true, 'hit');

            const paramsOk = pKill.tier === 'kill' && pKill.color === '#ff2a1a' && pKill.scale === 1.45 && pKill.duration === 130 &&
                             pKillHs.scale === 1.9 && pBlock.scale === 0.75 && pHit.scale === 1.0 && pHitHs.scale === 1.6;

            // DOM hitmarker styling
            const testEl = document.createElement('div');
            testEl.id = 'crosshair';
            const hitmark = document.createElement('div');
            hitmark.className = 'hitmark kill';
            const s = document.createElement('span');
            hitmark.appendChild(s);
            testEl.appendChild(hitmark);
            document.body.appendChild(testEl);
            const spanStyle = getComputedStyle(s);
            const shadowOk = spanStyle.boxShadow.includes('255, 42, 26') || spanStyle.boxShadow.includes('rgb(255, 42, 26)') || spanStyle.boxShadow.includes('#ff2a1a');
            document.body.removeChild(testEl);

            return tiersOk && paramsOk && shadowOk;
        }""")
        checks.append(("kill-hitmarker-visual-feedback", hitmarker_check))

        # 25) Agent separation and performance rules: pre-computed radii, separation push, melee hit window pruning, texel snapping.
        separation_perf_check = page.evaluate("""() => {
            if (typeof CORE.enemySeparationRadius !== 'function' ||
                typeof CORE.resolveSeparationPush !== 'function' ||
                typeof CORE.pruneHitTimestamps !== 'function' ||
                typeof CORE.canRegisterHit !== 'function' ||
                typeof CORE.snapToTexel !== 'function') return false;
            const r0 = CORE.enemySeparationRadius(0);
            const r2 = CORE.enemySeparationRadius(2);
            const radiiOk = r0 === 0.85 && r2 === 1.1;

            const out = { pushX: 0, pushZ: 0, applied: false };
            const pushed = CORE.resolveSeparationPush(0, 0, 0.85, 1.0, 0, 0.85, out);
            const pushMathOk = pushed === true && out.applied === true &&
                               Math.abs(out.pushX - 0.35) < 1e-6 && Math.abs(out.pushZ) < 1e-6;

            const rejected = CORE.resolveSeparationPush(0, 0, 0.85, 2.0, 0, 0.85, out);
            const rejectOk = rejected === false && out.applied === false;

            const timestamps = [10.0, 10.4, 10.7];
            const activeCount = CORE.pruneHitTimestamps(timestamps, 11.0, 0.8);
            const pruneOk = activeCount === 2 && timestamps.length === 2 && timestamps[0] === 10.4 && timestamps[1] === 10.7;

            const canHit1 = CORE.canRegisterHit([10.4, 10.7], 11.0, 0.8, 2);
            const canHit2 = CORE.canRegisterHit([10.4], 11.0, 0.8, 2);
            const hitCapOk = canHit1 === false && canHit2 === true;

            const snapOk = Math.abs(CORE.snapToTexel(1.234, 0.05) - 1.25) < 1e-6;

            return radiiOk && pushMathOk && rejectOk && pruneOk && hitCapOk && snapOk;
        }""")
        checks.append(("agent-separation-and-performance-rules", separation_perf_check))

        # 26) Weapon fire acoustic differentiation & armor damage audio feedback rules.
        audio_rules_check = page.evaluate("""() => {
            if (typeof CORE.weaponFireSound !== 'function' ||
                typeof CORE.armorDamageSound !== 'function' ||
                typeof SOUND_RECIPES !== 'object' ||
                typeof SOUND_VARIED !== 'object') return false;

            const weaponOk = CORE.weaponFireSound('SR') === 'sniper' &&
                             CORE.weaponFireSound('SMG') === 'smg' &&
                             CORE.weaponFireSound('BR') === 'br' &&
                             CORE.weaponFireSound('AR') === 'shot' &&
                             CORE.weaponFireSound('') === 'shot';

            const armorOk = CORE.armorDamageSound(50, 20) === 'block' &&
                            CORE.armorDamageSound(50, 0) === 'armor_break' &&
                            CORE.armorDamageSound(10, -5) === 'armor_break' &&
                            CORE.armorDamageSound(0, 0) === null &&
                            CORE.armorDamageSound(-5, 0) === null;

            const recipesOk = Array.isArray(SOUND_RECIPES.smg) &&
                              Array.isArray(SOUND_RECIPES.br) &&
                              Array.isArray(SOUND_RECIPES.armor_break);

            const variedOk = SOUND_VARIED.smg === 1 &&
                             SOUND_VARIED.br === 1 &&
                             SOUND_VARIED.armor_break === 1 &&
                             SOUND_VARIED.draw === 1 &&
                             SOUND_VARIED.pin === 1 &&
                             SOUND_VARIED.reload_out === 1 &&
                             SOUND_VARIED.reload_in === 1;

            return weaponOk && armorOk && recipesOk && variedOk;
        }""")
        checks.append(("weapon-fire-and-armor-audio-rules", audio_rules_check))

        # 27) Touch equipment, plate & streak feedback rules.
        touch_feedback_check = page.evaluate("""() => {
            if (typeof CORE.touchPlateState !== 'function' ||
                typeof CORE.touchEquipmentState !== 'function' ||
                typeof CORE.touchStreakState !== 'function') return false;

            const plateEmpty = CORE.touchPlateState(0, 50, 50, false) === 'empty' &&
                               CORE.touchPlateState(-1, 50, 50, false) === 'empty' &&
                               CORE.touchPlateState(null, 50, 50, false) === 'empty';

            const plateIns = CORE.touchPlateState(2, 50, 50, true) === 'inserting' &&
                             CORE.touchPlateState(0, 0, 50, true) === 'inserting';

            const plateUrgent = CORE.touchPlateState(2, 0, 50, false) === 'urgent' &&
                                CORE.touchPlateState(2, 10, 50, false) === 'urgent';

            const plateReady = CORE.touchPlateState(2, 35, 50, false) === 'ready';
            const plateFull = CORE.touchPlateState(2, 50, 50, false) === '';

            const equipEmpty = CORE.touchEquipmentState(0, false) === 'empty' &&
                               CORE.touchEquipmentState(-1, false) === 'empty' &&
                               CORE.touchEquipmentState(null, false) === 'empty';
            const equipChg = CORE.touchEquipmentState(1, true) === 'charging';
            const equipReady = CORE.touchEquipmentState(1, false) === 'ready';

            const streakReady = CORE.touchStreakState(true, false) === 'streak' &&
                                CORE.touchStreakState(true, true) === 'streak';
            const fieldReady = CORE.touchStreakState(false, true) === 'field';
            const streakEmpty = CORE.touchStreakState(false, false) === 'empty';

            return plateEmpty && plateIns && plateUrgent && plateReady && plateFull &&
                   equipEmpty && equipChg && equipReady && streakReady && fieldReady && streakEmpty;
        }""")
        checks.append(("touch-utility-and-equipment-feedback-rules", touch_feedback_check))

        # 28) Ordnance explosive blast damage, self-damage, throw velocity, and enemy melee balance rules.
        balance_rules_check = page.evaluate("""() => {
            if (typeof CORE.grenadeBlastDamage !== 'function' ||
                typeof CORE.grenadeSelfDamage !== 'function' ||
                typeof CORE.grenadeChargedSpeed !== 'function' ||
                typeof CORE.grenadeThrowSpeed !== 'function' ||
                typeof CORE.canEnemyMelee !== 'function' ||
                typeof CORE.enemyMeleeReach !== 'function' ||
                typeof CORE.enemyAttackCooldown !== 'function') return false;

            const blastZero = CORE.grenadeBlastDamage(0, 7, 120, 1.0) === 120;
            const blastMid = Math.abs(CORE.grenadeBlastDamage(3.5, 7, 120, 1.0) - 81) < 1e-6;
            const blastEdge = CORE.grenadeBlastDamage(7, 7, 120, 1.0) === 0;
            const blastScale = Math.abs(CORE.grenadeBlastDamage(0, 7, 120, 0.45) - 54) < 1e-6;

            const selfZero = CORE.grenadeSelfDamage(0, 7, 55) === 55;
            const selfMid = CORE.grenadeSelfDamage(2.8, 7, 55) === 28;
            const selfEdge = CORE.grenadeSelfDamage(5.6, 7, 55) === 0;

            const spdMin = CORE.grenadeChargedSpeed(0) === 6.0;
            const spdMid = CORE.grenadeChargedSpeed(0.5) === 9.5;
            const spdMax = CORE.grenadeChargedSpeed(1.0) === 13.0;

            const throwTap = CORE.grenadeThrowSpeed(0.1, 9.5) === 9.5;
            const throwHeld = CORE.grenadeThrowSpeed(1.0, 9.5) === 13.0;

            const meleeCan = CORE.canEnemyMelee(0) === true &&
                             CORE.canEnemyMelee(2) === true &&
                             CORE.canEnemyMelee(1) === false &&
                             CORE.canEnemyMelee(5) === false;

            const meleeReach = CORE.enemyMeleeReach(2, 2.1) === 3.0 &&
                              CORE.enemyMeleeReach(0, 2.1) === 2.5;

            const meleeCd = CORE.enemyAttackCooldown(2) === 2.4 &&
                            CORE.enemyAttackCooldown(0) === 1.6;

            return blastZero && blastMid && blastEdge && blastScale &&
                   selfZero && selfMid && selfEdge &&
                   spdMin && spdMid && spdMax &&
                   throwTap && throwHeld &&
                   meleeCan && meleeReach && meleeCd;
        }""")
        checks.append(("ordnance-and-melee-balance-rules", balance_rules_check))

        # 29) Directional damage indicator, vignette alpha/style, and hit arc opacity rules.
        damage_feedback_check = page.evaluate("""() => {
            if (typeof CORE.damageVignetteAlpha !== 'function' ||
                typeof CORE.damageVignetteStyle !== 'function' ||
                typeof CORE.worldBearing !== 'function' ||
                typeof CORE.screenHitAngle !== 'function' ||
                typeof CORE.hitArcOpacity !== 'function') return false;

            const vigZero = CORE.damageVignetteAlpha(0) === 0 &&
                            CORE.damageVignetteAlpha(-5) === 0 &&
                            CORE.damageVignetteAlpha(null) === 0;
            const vigMid = Math.abs(CORE.damageVignetteAlpha(15) - 0.75) < 1e-6;
            const vigCap = CORE.damageVignetteAlpha(60) === 0.85;

            const styleZero = CORE.damageVignetteStyle(0, false) === 'inset 0 0 120px 40px rgba(180,0,0,0)';
            const styleFlesh = CORE.damageVignetteStyle(0.75, false) === 'inset 0 0 120px 40px rgba(180,0,0,0.750)';
            const styleArmor = CORE.damageVignetteStyle(0.75, true) === 'inset 0 0 120px 40px rgba(79,163,216,0.750)';

            const bearSouth = CORE.worldBearing(0, 0, 0, 10) === 0;
            const bearEast = CORE.worldBearing(0, 0, 10, 0) === 90;
            const bearNorth = CORE.worldBearing(0, 0, 0, -10) === 180;
            const bearWest = CORE.worldBearing(0, 0, -10, 0) === 270;
            const bearZero = CORE.worldBearing(5, 5, 5, 5) === 0;

            const screenAhead = CORE.screenHitAngle(180, 0) === 0;
            const screenRight = CORE.screenHitAngle(90, 0) === 90;
            const screenBehind = CORE.screenHitAngle(0, 0) === 180;
            const screenLeft = CORE.screenHitAngle(270, 0) === 270;

            const opMax = CORE.hitArcOpacity(0) === 0.9;
            const opMid = Math.abs(CORE.hitArcOpacity(0.56) - 0.45) < 1e-6;
            const opEnd = CORE.hitArcOpacity(0.7) === 0;
            const opPast = CORE.hitArcOpacity(0.8) === 0;

            return vigZero && vigMid && vigCap && styleZero && styleFlesh && styleArmor &&
                   bearSouth && bearEast && bearNorth && bearWest && bearZero &&
                   screenAhead && screenRight && screenBehind && screenLeft &&
                   opMax && opMid && opEnd && opPast;
        }""")
        checks.append(("directional-damage-and-vignette-feedback-rules", damage_feedback_check))

        # 30) Change-driven ammo HUD, particle physics integration, and zero-allocation melee target rules.
        perf_rules_check = page.evaluate("""() => {
            if (typeof CORE.stepParticlePhysics !== 'function' ||
                typeof CORE.ammoHudChanged !== 'function' ||
                typeof CORE.syncAmmoHudState !== 'function' ||
                typeof CORE.meleeTarget !== 'function') return false;

            // Particle flight & grounding
            const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };
            const fly = CORE.stepParticlePhysics(0, 1.0, 0, 1.0, 2.0, 0, 9.8, 0.1, 0.02, out);
            const flyOk = fly === out && Math.abs(out.y - 1.102) < 1e-5 && out.grounded === false;

            CORE.stepParticlePhysics(out.x, 0.03, 0, 1.0, -2.0, 0, 9.8, 0.1, 0.02, out);
            const landOk = out.y === 0.02 && out.vx === 0 && out.vy === 0 && out.grounded === true;

            // Ammo HUD change gating & sync
            const cache = { ammo: 30, reserve: 90, reloading: false, isLow: false, isEmpty: false,
                            prompt: '', weaponName: 'M4A1', lethalCount: 2, tacCount: 1, isCharging: false };
            const sameOk = CORE.ammoHudChanged(cache, 30, 90, false, false, false, '', 'M4A1', 2, 1, false) === false;
            const diffAmmo = CORE.ammoHudChanged(cache, 29, 90, false, false, false, '', 'M4A1', 2, 1, false) === true;
            const diffRel = CORE.ammoHudChanged(cache, 30, 90, true, false, false, '', 'M4A1', 2, 1, false) === true;
            const diffChg = CORE.ammoHudChanged(cache, 30, 90, false, false, false, '', 'M4A1', 2, 1, true) === true;

            CORE.syncAmmoHudState(cache, 25, 80, true, false, false, 'RELOADING', 'MP5', 1, 0, true);
            const syncOk = cache.ammo === 25 && cache.reserve === 80 && cache.isCharging === true &&
                           CORE.ammoHudChanged(cache, 25, 80, true, false, false, 'RELOADING', 'MP5', 1, 0, true) === false;

            // Melee direct agent entity coordinates (.pos)
            const agents = [
                { pos: { x: 0, z: 1.5 }, dead: false },
                { pos: { x: 0, z: 3.0 }, dead: false },
                { pos: { x: 0, z: 1.0 }, dead: true }
            ];
            const meleeIdx = CORE.meleeTarget(agents, 0, 0, 0, 1, CORE.MELEE_REACH, CORE.MELEE_CONE);
            const meleeOk = meleeIdx === 0;

            return flyOk && landOk && sameOk && diffAmmo && diffRel && diffChg && syncOk && meleeOk;
        }""")
        checks.append(("ammo-hud-and-particle-performance-rules", perf_rules_check))

        # 31) Kill confirmation and multi-kill acoustic feedback rules and sound recipes.
        audio_rules_check = page.evaluate("""() => {
            if (typeof CORE.killConfirmationSound !== 'function' ||
                typeof CORE.advanceKillStreak !== 'function' ||
                typeof CORE.multikillLabel !== 'function' ||
                typeof CORE.multikillSound !== 'function') return false;

            const killStd = CORE.killConfirmationSound(false, false) === 'kill';
            const killHead = CORE.killConfirmationSound(true, false) === 'kill_headshot';
            const killElite = CORE.killConfirmationSound(false, true) === 'kill_elite';
            const killEliteHead = CORE.killConfirmationSound(true, true) === 'kill_elite';

            const streakInit = CORE.advanceKillStreak(0, -99, 10, 4) === 1;
            const streakChain = CORE.advanceKillStreak(1, 10, 12, 4) === 2;
            const streakMax = CORE.advanceKillStreak(4, 16, 19, 4) === 5;
            const streakWrap = CORE.advanceKillStreak(5, 19, 21, 4) === 0;
            const streakReset = CORE.advanceKillStreak(3, 10, 15, 4) === 1;

            const labelDbl = CORE.multikillLabel(2) === 'DOUBLE KILL';
            const labelRamp = CORE.multikillLabel(5) === 'RAMPAGE';
            const labelNull = CORE.multikillLabel(1) === null;

            const sndDbl = CORE.multikillSound(2) === 'multikill';
            const sndNull = CORE.multikillSound(1) === null;

            const recipesOk = Array.isArray(SOUND_RECIPES.kill_headshot) &&
                              Array.isArray(SOUND_RECIPES.kill_elite) &&
                              Array.isArray(SOUND_RECIPES.multikill);

            const variedOk = SOUND_VARIED.kill_headshot === 1 &&
                             SOUND_VARIED.kill_elite === 1 &&
                             SOUND_VARIED.multikill === 1;

            return killStd && killHead && killElite && killEliteHead &&
                   streakInit && streakChain && streakMax && streakWrap && streakReset &&
                   labelDbl && labelRamp && labelNull && sndDbl && sndNull &&
                   recipesOk && variedOk;
        }""")
        checks.append(("kill-and-multikill-audio-rules", audio_rules_check))

        touch_tactical_rules_check = page.evaluate("""() => {
            if (typeof CORE.touchSwapState !== 'function' ||
                typeof CORE.touchSwapLabel !== 'function' ||
                typeof CORE.buyPromptPrefix !== 'function' ||
                typeof CORE.touchUseState !== 'function' ||
                typeof CORE.touchSlideState !== 'function' ||
                typeof CORE.touchSlideLabel !== 'function') return false;

            const mockWeapons = [
                { name: 'M4 Carbine', type: 'AR' },
                { name: 'MK18 Mod1', type: 'SMG' },
                { name: 'SCAR-H', type: 'BR' },
                { name: 'SV-98 Marksman', type: 'SR' }
            ];

            const swapEmpty = CORE.touchSwapState(0, [0, -1]) === 'empty';
            const swapReady = CORE.touchSwapState(0, [0, 3]) === 'ready';
            const swapLabelEmpty = CORE.touchSwapLabel(0, [0, -1], mockWeapons) === 'SWAP';
            const swapLabelReady = CORE.touchSwapLabel(0, [0, 3], mockWeapons) === 'SR';
            const swapLabelReverse = CORE.touchSwapLabel(1, [0, 3], mockWeapons) === 'AR';

            const promptMobile = CORE.buyPromptPrefix(true, true) === 'HOLD USE — ';
            const promptDesktop = CORE.buyPromptPrefix(false, true) === 'HOLD F — ';
            const promptBlocked = CORE.buyPromptPrefix(true, false) === '';

            const useEmpty = CORE.touchUseState(false, true, false) === 'empty';
            const useReady = CORE.touchUseState(true, true, false) === 'ready';
            const useHolding = CORE.touchUseState(true, true, true) === 'holding';
            const useBlocked = CORE.touchUseState(true, false, false) === 'blocked';

            const slideActive = CORE.touchSlideState(true, false, false) === 'sliding';
            const slideCrouch = CORE.touchSlideState(false, true, false) === 'crouch';
            const slideSprint = CORE.touchSlideState(false, false, true) === 'sprint';
            const slideLabelActive = CORE.touchSlideLabel(true, false) === 'SLIDE';
            const slideLabelCrouch = CORE.touchSlideLabel(false, true) === 'STAND';

            return swapEmpty && swapReady && swapLabelEmpty && swapLabelReady && swapLabelReverse &&
                   promptMobile && promptDesktop && promptBlocked &&
                   useEmpty && useReady && useHolding && useBlocked &&
                   slideActive && slideCrouch && slideSprint &&
                   slideLabelActive && slideLabelCrouch;
        }""")
        checks.append(("touch-tactical-interaction-rules", touch_tactical_rules_check))

        # 32) Player mobility, stamina, health regen, and pickup restore balance rules.
        balance_rules_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.slideSpeedAt !== 'function' ||
                typeof CORE.slideJumpBoost !== 'function' ||
                typeof CORE.stepPlayerStamina !== 'function' ||
                typeof CORE.isPlayerExhausted !== 'function' ||
                typeof CORE.canRegenHealth !== 'function' ||
                typeof CORE.stepHealthRegen !== 'function' ||
                typeof CORE.ammoPickupRestore !== 'function' ||
                typeof CORE.medkitPickupRestore !== 'function') return false;

            const sprintSpd = 8.1;
            const crouchSpd = 2.7;
            const slideStart = Math.abs(CORE.slideSpeedAt(0, sprintSpd, crouchSpd, 0.9, 1.2, 0.5) - 9.72) < 1e-4;
            const slideEnd = Math.abs(CORE.slideSpeedAt(0.9, sprintSpd, crouchSpd, 0.9, 1.2, 0.5) - 2.7) < 1e-4;
            const jumpBoost = Math.abs(CORE.slideJumpBoost(sprintSpd, sprintSpd, 1.35, 0.3) - 1.30) < 1e-4;

            const stamDrain = Math.abs(CORE.stepPlayerStamina(5.0, 5.0, true, false, 1.0, 1.0, 2.2, 0.7) - 4.0) < 1e-4;
            const stamTac = Math.abs(CORE.stepPlayerStamina(5.0, 5.0, true, true, 1.0, 1.0, 2.2, 0.7) - 2.8) < 1e-4;
            const exhaustTrig = CORE.isPlayerExhausted(0, false, 5.0, 0.35) === true;
            const exhaustHold = CORE.isPlayerExhausted(1.5, true, 5.0, 0.35) === true;
            const exhaustClear = CORE.isPlayerExhausted(1.8, true, 5.0, 0.35) === false;

            const regenDowned = CORE.canRegenHealth(true, 5.0, 4.0, 50, 100) === false;
            const regenDelay = CORE.canRegenHealth(false, 3.5, 4.0, 50, 100) === false;
            const regenOk = CORE.canRegenHealth(false, 5.0, 4.0, 50, 100) === true;
            const regenStep = Math.abs(CORE.stepHealthRegen(50, 100, 20, 1.0, 0.5) - 60) < 1e-4;

            const ammoRes = CORE.ammoPickupRestore(30, 120, 30, 1.0) === 75;
            const ammoScav = CORE.ammoPickupRestore(30, 120, 30, 1.6) === 102;
            const medRes = CORE.medkitPickupRestore(50, 100, 10, 50, 1.0);
            const medOk = medRes.health === 85 && medRes.armor === 25;
            const medScav = CORE.medkitPickupRestore(50, 100, 10, 50, 1.6);
            const medScavOk = medScav.health === 100 && medScav.armor === 34;

            return slideStart && slideEnd && jumpBoost &&
                   stamDrain && stamTac && exhaustTrig && exhaustHold && exhaustClear &&
                   regenDowned && regenDelay && regenOk && regenStep &&
                   ammoRes && ammoScav && medOk && medScavOk;
        }""")
        checks.append(("player-mobility-and-survival-balance-rules", balance_rules_check))

        # 33) Critical health danger alert, near-death perimeter vignette, and heartbeat pulse rules.
        crit_rules_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.isHealthCritical !== 'function' ||
                typeof CORE.criticalHealthIntensity !== 'function' ||
                typeof CORE.healthDangerState !== 'function' ||
                typeof CORE.criticalVignetteStyle !== 'function' ||
                typeof CORE.criticalPulseAlpha !== 'function') return false;

            const critNom = CORE.isHealthCritical(100, 100) === false &&
                            CORE.criticalHealthIntensity(100, 100) === 0 &&
                            CORE.healthDangerState(100, 100) === 'nominal';

            const critLow = CORE.isHealthCritical(28, 100) === false &&
                            CORE.isHealthLow(28, 100) === true &&
                            CORE.healthDangerState(28, 100) === 'low';

            const critBoundary = CORE.isHealthCritical(25, 100) === true &&
                                 CORE.criticalHealthIntensity(25, 100) === 0 &&
                                 CORE.healthDangerState(25, 100) === 'critical';

            const critMid = CORE.isHealthCritical(12.5, 100) === true &&
                            Math.abs(CORE.criticalHealthIntensity(12.5, 100) - 0.5) < 1e-4 &&
                            CORE.healthDangerState(12.5, 100) === 'critical';

            const critDead = CORE.isHealthCritical(0, 100) === false &&
                             CORE.criticalHealthIntensity(0, 100) === 0 &&
                             CORE.healthDangerState(0, 100) === 'dead';

            const styleInert = CORE.criticalVignetteStyle(0, false) === 'inset 0 0 90px 30px rgba(180,15,15,0)';
            const styleActive = CORE.criticalVignetteStyle(1.0, false) === 'inset 0 0 140px 55px rgba(180,15,15,0.800)';
            const styleReduced = CORE.criticalVignetteStyle(1.0, true) === 'inset 0 0 140px 55px rgba(180,15,15,0.600)';

            const pulseReduced = CORE.criticalPulseAlpha(1.0, 0, true) === 0.5;
            const pulsePeak = Math.abs(CORE.criticalPulseAlpha(1.0, 1 / (4 * 1.35), false) - 0.85) < 1e-4;

            // Live HUD DOM verification
            const bar = document.getElementById('health-bar');
            const num = document.getElementById('health-num');
            const critVig = document.getElementById('critical-vignette');
            if (!bar || !num || !critVig) return false;

            // Set player health to critical level (18 HP) and test DOM update
            player.health = 18;
            updateHudHealth();
            const critDomActive = bar.classList.contains('critical') &&
                                  num.classList.contains('critical') &&
                                  bar.parentElement.classList.contains('critical') &&
                                  critVig.classList.contains('active');

            // Restore player health to 100 HP and verify clean removal
            player.health = 100;
            updateHudHealth();
            const critDomCleared = !bar.classList.contains('critical') &&
                                   !num.classList.contains('critical') &&
                                   !bar.parentElement.classList.contains('critical') &&
                                   !critVig.classList.contains('active');

            return critNom && critLow && critBoundary && critMid && critDead &&
                   styleInert && styleActive && styleReduced && pulseReduced && pulsePeak &&
                   critDomActive && critDomCleared;
        }""")
        checks.append(("critical-health-visual-feedback-and-vignette-rules", crit_rules_check))

        # 34) Minimap obstacle culling, compass rules, and combat evaluation performance.
        perf_rules_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // Minimap obstacle filtering
            const testCols = [
                { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 0.3, z: 4 } },
                { min: { x: 10, y: 0, z: 10 }, max: { x: 16, y: 3.0, z: 22 } }
            ];
            const filtered = CORE.filterMinimapColliders(testCols, 0.6);
            const filterOk = Array.isArray(filtered) && filtered.length === 1 &&
                             filtered[0].minX === 10 && filtered[0].minZ === 10 &&
                             filtered[0].w === 6 && filtered[0].d === 12;

            // Minimap block culling
            const cullNear = CORE.isMinimapBlockVisible(10, 10, 6, 12, 10, 10, 1.4, 75 * 75 * 2.4) === true;
            const cullFar = CORE.isMinimapBlockVisible(300, 300, 6, 12, 0, 0, 1.4, 75 * 75 * 2.4) === false;

            // Compass calculations
            const headNorth = CORE.compassHeading(0) === 0;
            const headSouth = CORE.compassHeading(Math.PI) === 180;
            const tickZero = CORE.compassTickOffset(0, 0) === 0;
            const tickWrap = CORE.compassTickOffset(350, 0) === -10;
            const cardNorth = CORE.compassCardinalLabel(0) === 'N';
            const cardEast = CORE.compassCardinalLabel(90) === 'E';
            const cardNull = CORE.compassCardinalLabel(15) === null;

            // Combat enemy evaluation
            const testEnemies = [
                { pos: { x: 5, y: 0, z: 0 }, dead: false },
                { pos: { x: 0, y: 0, z: 12 }, dead: false },
                { pos: { x: 1, y: 0, z: 1 }, dead: true }
            ];
            const outBuf = { aliveCount: 0, nearestEnemy: undefined };
            const evalRes = CORE.evaluateCombatEnemies(testEnemies, 0, 0, outBuf);
            const combatOk = evalRes === outBuf && outBuf.aliveCount === 2 && outBuf.nearestEnemy === 5;

            // Live execution of drawMinimap and drawCompass
            let drawOk = true;
            try {
                if (typeof drawMinimap === 'function') drawMinimap();
                if (typeof drawCompass === 'function') drawCompass();
            } catch (e) {
                drawOk = false;
            }

            return filterOk && cullNear && cullFar && headNorth && headSouth &&
                   tickZero && tickWrap && cardNorth && cardEast && cardNull &&
                   combatOk && drawOk;
        }""")
        checks.append(("canvas-hud-and-combat-performance-rules", perf_rules_check))

        # 35) Scorestreak and field upgrade acoustic feedback rules, sound recipes, and variation.
        streak_audio_check = page.evaluate("""() => {
            if (typeof CORE.streakActivationSound !== 'function' ||
                typeof CORE.fieldUpgradeSound !== 'function' ||
                typeof CORE.sentryFireSound !== 'function' ||
                typeof CORE.canMunitionsResupply !== 'function' ||
                typeof SOUND_RECIPES !== 'object' ||
                typeof SOUND_VARIED !== 'object') return false;

            const uavOk = CORE.streakActivationSound('uav') === 'streak_uav';
            const strikeOk = CORE.streakActivationSound('airstrike') === 'streak_airstrike';
            const sentryOk = CORE.streakActivationSound('sentry') === 'streak_sentry';
            const streakFallback = CORE.streakActivationSound('unknown') === 'wave' &&
                                   CORE.streakActivationSound(null) === 'wave';

            const fieldDeployOk = CORE.fieldUpgradeSound(true) === 'munitions';
            const fieldResupplyOk = CORE.fieldUpgradeSound(false) === 'munitions_resupply';

            const sentryShotOk = CORE.sentryFireSound() === 'sentry_shot';
            const distLimitOk = CORE.SENTRY_AUDIO_MAX_DIST === 65;

            const resupplyGating = CORE.canMunitionsResupply(true, false, false) === true &&
                                   CORE.canMunitionsResupply(false, true, false) === true &&
                                   CORE.canMunitionsResupply(false, false, true) === true &&
                                   CORE.canMunitionsResupply(false, false, false) === false;

            const recipesOk = Array.isArray(SOUND_RECIPES.streak_uav) &&
                              Array.isArray(SOUND_RECIPES.streak_airstrike) &&
                              Array.isArray(SOUND_RECIPES.streak_sentry) &&
                              Array.isArray(SOUND_RECIPES.sentry_shot) &&
                              Array.isArray(SOUND_RECIPES.munitions) &&
                              Array.isArray(SOUND_RECIPES.munitions_resupply);

            const variedOk = SOUND_VARIED.streak_uav === 1 &&
                             SOUND_VARIED.streak_airstrike === 1 &&
                             SOUND_VARIED.streak_sentry === 1 &&
                             SOUND_VARIED.sentry_shot === 1 &&
                             SOUND_VARIED.munitions === 1 &&
                             SOUND_VARIED.munitions_resupply === 1;

            return uavOk && strikeOk && sentryOk && streakFallback &&
                   fieldDeployOk && fieldResupplyOk && sentryShotOk && distLimitOk &&
                   resupplyGating && recipesOk && variedOk;
        }""")
        checks.append(("scorestreak-and-field-upgrade-audio-rules", streak_audio_check))

        # 36) Mobile touch tactical equipment, plate, streak, and melee readiness rules and styles.
        touch_readiness_check = page.evaluate("""() => {
            if (typeof CORE.touchPlateLabel !== 'function' ||
                typeof CORE.touchTacticalLabel !== 'function' ||
                typeof CORE.touchLethalLabel !== 'function' ||
                typeof CORE.touchStreakLabel !== 'function' ||
                typeof CORE.touchMeleeState !== 'function' ||
                typeof CORE.touchMeleeLabel !== 'function') return false;

            const plateLabelArmor = CORE.touchPlateLabel(2, true) === 'ARMOR';
            const plateLabelPlt = CORE.touchPlateLabel(3, false) === 'PLT 3';
            const plateLabelEmpty = CORE.touchPlateLabel(0, false) === 'EMPTY';

            const tacLabelFlash = CORE.touchTacticalLabel('flash', 2) === 'FLASH';
            const tacLabelStun = CORE.touchTacticalLabel('stun', 1) === 'STUN';
            const tacLabelSmoke = CORE.touchTacticalLabel('smoke', 1) === 'SMOKE';
            const tacLabelEmpty = CORE.touchTacticalLabel('flash', 0) === 'EMPTY';

            const nadeLabelHold = CORE.touchLethalLabel('frag', 2, true) === 'HOLD';
            const nadeLabelFrag = CORE.touchLethalLabel('frag', 2, false) === 'FRAG';
            const nadeLabelSmtx = CORE.touchLethalLabel('semtex', 1, false) === 'SMTX';
            const nadeLabelClay = CORE.touchLethalLabel('claymore', 1, false) === 'CLAY';
            const nadeLabelEmpty = CORE.touchLethalLabel('frag', 0, false) === 'EMPTY';

            const streakUav = CORE.touchStreakLabel('uav', false) === 'UAV';
            const streakAir = CORE.touchStreakLabel('airstrike', false) === 'AIR';
            const streakTur = CORE.touchStreakLabel('sentry', false) === 'TUR';
            const streakBox = CORE.touchStreakLabel(null, true) === 'BOX';
            const streakDefault = CORE.touchStreakLabel(null, false) === 'STRK';

            const meleeReady = CORE.touchMeleeState(true, 0) === 'ready';
            const meleeCooldown = CORE.touchMeleeState(true, 0.5) === 'cooldown';
            const meleeNeutral = CORE.touchMeleeState(false, 0) === '';

            const meleeLabelStrike = CORE.touchMeleeLabel(true, 0) === 'STRIKE';
            const meleeLabelWait = CORE.touchMeleeLabel(true, 0.5) === 'WAIT';
            const meleeLabelKnife = CORE.touchMeleeLabel(false, 0) === 'KNIFE';

            // Verify DOM computed styles for touch ready/cooldown classes
            document.body.classList.add('touch');
            const pEl = document.createElement('div');
            pEl.id = 'tbtn-plate'; pEl.className = 'tbtn ready';
            const mEl = document.createElement('div');
            mEl.id = 'tbtn-melee'; mEl.className = 'tbtn ready';
            document.body.appendChild(pEl);
            document.body.appendChild(mEl);
            const pBorder = getComputedStyle(pEl).borderColor;
            const mBorder = getComputedStyle(mEl).borderColor;
            document.body.removeChild(pEl);
            document.body.removeChild(mEl);
            document.body.classList.remove('touch');

            const plateBorderOk = pBorder.includes('79, 163, 216') || pBorder.includes('rgb(79, 163, 216)');
            const meleeBorderOk = mBorder.includes('255, 95, 74') || mBorder.includes('rgb(255, 95, 74)');

            return plateLabelArmor && plateLabelPlt && plateLabelEmpty &&
                   tacLabelFlash && tacLabelStun && tacLabelSmoke && tacLabelEmpty &&
                   nadeLabelHold && nadeLabelFrag && nadeLabelSmtx && nadeLabelClay && nadeLabelEmpty &&
                   streakUav && streakAir && streakTur && streakBox && streakDefault &&
                   meleeReady && meleeCooldown && meleeNeutral &&
                   meleeLabelStrike && meleeLabelWait && meleeLabelKnife &&
                   plateBorderOk && meleeBorderOk;
        }""")
        checks.append(("touch-equipment-and-tactical-readiness-rules", touch_readiness_check))

        # 38) Marksman precision, scope sway, steady aim, and recoil decay balance rules.
        marksman_rules_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.isSteadyActive !== 'function' ||
                typeof CORE.stepSteadyAim !== 'function' ||
                typeof CORE.swayAmplitude !== 'function' ||
                typeof CORE.swayOffsets !== 'function' ||
                typeof CORE.isScoped !== 'function' ||
                typeof CORE.recoilDecay !== 'function' ||
                typeof CORE.aimAssistAngle !== 'function' ||
                typeof CORE.aimAssistPull !== 'function') return false;

            const steadySr = CORE.isSteadyActive('SR', 0.85, true, 2.0) === true;
            const steadyNoShift = CORE.isSteadyActive('SR', 0.85, false, 2.0) === false;
            const steadyNoAds = CORE.isSteadyActive('SR', 0.70, true, 2.0) === false;
            const steadyDepleted = CORE.isSteadyActive('SR', 0.85, true, 0) === false;
            const steadyAr = CORE.isSteadyActive('AR', 0.85, true, 2.0) === false;

            const stepDrain = Math.abs(CORE.stepSteadyAim(2.0, true, 0.5, 2.2, 2.2) - 1.5) < 1e-4;
            const stepClamp = Math.abs(CORE.stepSteadyAim(0.3, true, 0.5, 2.2, 2.2) - 0.0) < 1e-4;
            const stepRec = Math.abs(CORE.stepSteadyAim(1.0, false, 0.5, 2.2, 2.2) - 2.1) < 1e-4;
            const stepMax = Math.abs(CORE.stepSteadyAim(2.0, false, 0.5, 2.2, 2.2) - 2.2) < 1e-4;

            const swayBase = Math.abs(CORE.swayAmplitude(0.0042, false, 0.14, 1.0) - 0.0042) < 1e-6;
            const swaySteady = Math.abs(CORE.swayAmplitude(0.0042, true, 0.14, 1.0) - 0.0042 * 0.14) < 1e-6;
            const swayWeapon = Math.abs(CORE.swayAmplitude(0.0042, false, 0.14, 1.5) - 0.0042 * 1.5) < 1e-6;

            const s1 = CORE.swayOffsets(0, 0.01);
            const swayPhaseZero = Math.abs(s1.x) < 1e-6 && Math.abs(s1.y - (Math.sin(1.2) * 0.01 * 0.8)) < 1e-6;

            const scopedSr = CORE.isScoped(0.85, 'SR') === true;
            const scopedSrLow = CORE.isScoped(0.80, 'SR') === false;
            const scopedAr = CORE.isScoped(0.85, 'AR') === false;

            const recoilD0 = Math.abs(CORE.recoilDecay(1.0, 0, 0.02) - 1.0) < 1e-4;
            const recoilD1 = Math.abs(CORE.recoilDecay(1.0, 1.0, 0.02) - 0.02) < 1e-4;

            const assistAngNormal = Math.abs(CORE.aimAssistAngle(0.14, false, 1.6) - 0.14) < 1e-4;
            const assistAngSteady = Math.abs(CORE.aimAssistAngle(0.14, true, 1.6) - 0.224) < 1e-4;
            const assistPullCap = Math.abs(CORE.aimAssistPull(5.0, 0.5) - 1.0) < 1e-4;
            const assistPullNorm = Math.abs(CORE.aimAssistPull(2.2, 0.25) - 0.55) < 1e-4;

            return steadySr && steadyNoShift && steadyNoAds && steadyDepleted && steadyAr &&
                   stepDrain && stepClamp && stepRec && stepMax &&
                   swayBase && swaySteady && swayWeapon && swayPhaseZero &&
                   scopedSr && scopedSrLow && scopedAr &&
                   recoilD0 && recoilD1 &&
                   assistAngNormal && assistAngSteady && assistPullCap && assistPullNorm;
        }""")
        checks.append(("marksman-and-aim-precision-rules", marksman_rules_check))

        # 39) Crosshair and mobility visual feedback rules.
        crosshair_rules_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            const gapReduced = CORE.crosshairGapOffset(0.05, 0, true) === 0;
            const gapRest = CORE.crosshairGapOffset(0.010, 0, false) === 0;
            const gapSmg = CORE.crosshairGapOffset(0.020, 0, false) === 2;
            const gapFiring = CORE.crosshairGapOffset(0.065, 0, false) === 12;
            const gapCap = CORE.crosshairGapOffset(0.200, 0, false) === 24;
            const gapAdsHalf = CORE.crosshairGapOffset(0.014, 0.5, false) === -3;
            const gapAdsFull = CORE.crosshairGapOffset(0.014, 1.0, false) === -6;

            const opDead = CORE.crosshairOpacity(0, false, true) === 0;
            const opScopedRest = CORE.crosshairOpacity(0, true, false) === 1;
            const opScopedAim = CORE.crosshairOpacity(0.75, true, false) === 0;
            const opScopedHalf = Math.abs(CORE.crosshairOpacity(0.525, true, false) - 0.5) < 1e-4;
            const opNormRest = CORE.crosshairOpacity(0, false, false) === 1;
            const opNormAim = CORE.crosshairOpacity(0.70, false, false) === 0;
            const opNormHalf = Math.abs(CORE.crosshairOpacity(0.35, false, false) - 0.5) < 1e-4;

            const stateExh = CORE.sprintIndicatorState(true, true, true) === 'exhausted';
            const stateSlide = CORE.sprintIndicatorState(false, true, false) === 'slide';
            const stateTac = CORE.sprintIndicatorState(true, false, false) === 'tac';
            const stateNom = CORE.sprintIndicatorState(false, false, false) === '';

            const labelExh = CORE.sprintIndicatorLabel('exhausted') === 'EXHAUSTED';
            const labelSlide = CORE.sprintIndicatorLabel('slide') === 'SLIDE';
            const labelTac = CORE.sprintIndicatorLabel('tac') === 'TAC SPRINT';
            const labelNom = CORE.sprintIndicatorLabel('') === '';

            const spEl = document.getElementById('sprint-ind');
            const chEl = document.getElementById('crosshair');
            const domOk = Boolean(spEl && chEl);

            return gapReduced && gapRest && gapSmg && gapFiring && gapCap && gapAdsHalf && gapAdsFull &&
                   opDead && opScopedRest && opScopedAim && opScopedHalf && opNormRest && opNormAim && opNormHalf &&
                   stateExh && stateSlide && stateTac && stateNom &&
                   labelExh && labelSlide && labelTac && labelNom &&
                   domOk;
        }""")
        checks.append(("crosshair-and-mobility-visual-feedback-rules", crosshair_rules_check))

        # 40) Tactical mobility and movement audio rules.
        mobility_audio_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.mantleSound !== 'function' ||
                typeof CORE.slideStartSound !== 'function' ||
                typeof CORE.footstepCadence !== 'function' ||
                typeof CORE.playerFootstepSound !== 'function' ||
                typeof CORE.shouldPlayFootstep !== 'function') return false;

            const mantle = CORE.mantleSound() === 'mantle';
            const slideStart = CORE.slideStartSound() === 'slide';

            const cadWalk = Math.abs(CORE.footstepCadence(false, false, false) - 1.0) < 1e-4;
            const cadSprint = Math.abs(CORE.footstepCadence(true, false, false) - 1.6) < 1e-4;
            const cadTac = Math.abs(CORE.footstepCadence(true, true, false) - 2.0) < 1e-4;
            const cadCrouch = Math.abs(CORE.footstepCadence(false, false, true) - 0.65) < 1e-4;
            const cadCrouchSprint = Math.abs(CORE.footstepCadence(true, true, true) - 0.65) < 1e-4;

            const sndWalk = CORE.playerFootstepSound(false) === 'step';
            const sndCrouch = CORE.playerFootstepSound(true) === 'step_crouch';

            const footGroundWalk = CORE.shouldPlayFootstep(true, 3.0) === true;
            const footAirWalk = CORE.shouldPlayFootstep(false, 3.0) === false;
            const footGroundSlow = CORE.shouldPlayFootstep(true, 1.2) === false;
            const footGroundCustom = CORE.shouldPlayFootstep(true, 2.0, 2.5) === false;

            const recipeMantle = typeof SOUND_RECIPES !== 'undefined' && Array.isArray(SOUND_RECIPES.mantle);
            const recipeStepCrouch = typeof SOUND_RECIPES !== 'undefined' && Array.isArray(SOUND_RECIPES.step_crouch);
            const variedMantle = typeof SOUND_VARIED !== 'undefined' && SOUND_VARIED.mantle === 1;
            const variedStepCrouch = typeof SOUND_VARIED !== 'undefined' && SOUND_VARIED.step_crouch === 1;

            return mantle && slideStart &&
                   cadWalk && cadSprint && cadTac && cadCrouch && cadCrouchSprint &&
                   sndWalk && sndCrouch &&
                   footGroundWalk && footAirWalk && footGroundSlow && footGroundCustom &&
                   recipeMantle && recipeStepCrouch && variedMantle && variedStepCrouch;
        }""")
        checks.append(("tactical-mobility-audio-rules", mobility_audio_check))

        # 41) Mobile touch fire & reload combat feedback rules and styles.
        touch_combat_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.touchFireState !== 'function' ||
                typeof CORE.touchFireLabel !== 'function' ||
                typeof CORE.touchReloadLabel !== 'function') return false;

            const fireReady = CORE.touchFireState(30, 90, false) === 'ready';
            const fireDry = CORE.touchFireState(0, 90, false) === 'dry';
            const fireRel = CORE.touchFireState(0, 90, true) === 'reloading';
            const fireEmpty = CORE.touchFireState(0, 0, false) === 'empty';

            const fireLblReady = CORE.touchFireLabel(30, 90, false, false) === 'FIRE';
            const fireLblAds = CORE.touchFireLabel(30, 90, false, true) === 'ADS+FIRE';
            const fireLblDry = CORE.touchFireLabel(0, 90, false, false) === 'RELOAD';
            const fireLblRel = CORE.touchFireLabel(0, 90, true, false) === 'RELOAD';
            const fireLblEmpty = CORE.touchFireLabel(0, 0, false, false) === 'EMPTY';

            const rldLblReady = CORE.touchReloadLabel(30, 90, false) === 'RLD';
            const rldLblUrgent = CORE.touchReloadLabel(0, 90, false) === 'RELOAD';
            const rldLblWait = CORE.touchReloadLabel(0, 90, true) === 'WAIT';
            const rldLblEmpty = CORE.touchReloadLabel(0, 0, false) === 'EMPTY';

            document.body.classList.add('touch');
            let fireEl = document.getElementById('tbtn-fire');
            let rldEl = document.getElementById('tbtn-reload');
            if (!fireEl || !rldEl) {
                // Headless probe: the real touch UI only exists when IS_TOUCH, so
                // inject identical-fixture buttons that still match the real
                // stylesheet rules, then remove them after measuring.
                const wrap = document.createElement('div');
                wrap.id = '__probe_touch_fixture__';
                wrap.innerHTML = '<div id="tbtn-fire" class="tbtn">FIRE</div><div id="tbtn-reload" class="tbtn">RLD</div>';
                document.body.appendChild(wrap);
                fireEl = document.getElementById('tbtn-fire');
                rldEl = document.getElementById('tbtn-reload');
            }
            if (!fireEl || !rldEl) {
                document.body.classList.remove('touch');
                return false;
            }
            // The real buttons animate opacity/border over ~150ms; the probe reads
            // computed styles synchronously after flipping classes, so disable
            // transitions to measure final values instead of mid-transition ones.
            fireEl.style.transition = 'none';
            rldEl.style.transition = 'none';

            fireEl.classList.add('dry');
            const dryBorder = getComputedStyle(fireEl).borderColor;
            fireEl.classList.remove('dry');

            fireEl.classList.add('reloading');
            const relBorder = getComputedStyle(fireEl).borderColor;
            fireEl.classList.remove('reloading');

            fireEl.classList.add('empty');
            const emptyOp = parseFloat(getComputedStyle(fireEl).opacity);
            fireEl.classList.remove('empty');

            rldEl.classList.add('empty');
            const rldEmptyOp = parseFloat(getComputedStyle(rldEl).opacity);
            rldEl.classList.remove('empty');

            document.body.classList.remove('touch');
            if (document.getElementById('__probe_touch_fixture__')) {
                document.getElementById('__probe_touch_fixture__').remove();
            }

            const styleOk = Boolean(dryBorder && relBorder && emptyOp <= 0.5 && rldEmptyOp <= 0.5);

            return fireReady && fireDry && fireRel && fireEmpty &&
                   fireLblReady && fireLblAds && fireLblDry && fireLblRel && fireLblEmpty &&
                   rldLblReady && rldLblUrgent && rldLblWait && rldLblEmpty &&
                   styleOk;
        }""")
        checks.append(("touch-combat-feedback-rules", touch_combat_check))

        # 42) Tactical camera dynamics, dynamic FOV scaling, and procedural roll rules.
        tactical_camera_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.weaponAdsZoom !== 'function' ||
                typeof CORE.mobilityFovBoost !== 'function' ||
                typeof CORE.targetCameraFov !== 'function' ||
                typeof CORE.strafeDirection !== 'function' ||
                typeof CORE.cameraRoll !== 'function' ||
                typeof CORE.cameraPositionOffsets !== 'function') return false;

            const zoomSr = CORE.weaponAdsZoom('SR') === 52;
            const zoomAr = CORE.weaponAdsZoom('AR') === 24;
            const zoomSmg = CORE.weaponAdsZoom('SMG') === 24;

            const fovNom = CORE.mobilityFovBoost(false, false, 0, false) === 0;
            const fovSlide = CORE.mobilityFovBoost(true, false, 0, false) === 6;
            const fovTac = CORE.mobilityFovBoost(false, true, 0, false) === 4;
            const fovReduced = CORE.mobilityFovBoost(true, true, 0, true) === 0;
            const fovAds = CORE.mobilityFovBoost(true, true, 0.8, false) === 0;

            const fovTargetNom = Math.abs(CORE.targetCameraFov(75, 0, 24, 0) - 75) < 1e-4;
            const fovTargetZoom = Math.abs(CORE.targetCameraFov(75, 1, 24, 0) - 51) < 1e-4;
            const fovTargetSr = Math.abs(CORE.targetCameraFov(75, 1, 52, 0) - 23) < 1e-4;
            const fovTargetSlide = Math.abs(CORE.targetCameraFov(75, 0, 24, 6) - 81) < 1e-4;
            const fovTargetTac = Math.abs(CORE.targetCameraFov(75, 0, 24, 4) - 79) < 1e-4;

            const strafeNone = CORE.strafeDirection(false, false, 0) === 0;
            const strafeLeftKey = CORE.strafeDirection(true, false, 0) === -1;
            const strafeRightKey = CORE.strafeDirection(false, true, 0) === 1;
            const strafeBoth = CORE.strafeDirection(true, true, 0) === 0;
            const strafeAnalogL = CORE.strafeDirection(false, false, -0.6) === -1;
            const strafeAnalogR = CORE.strafeDirection(false, false, 0.5) === 1;
            const strafeAnalogDead = CORE.strafeDirection(false, false, 0.05) === 0;

            const rollReduced = Math.abs(CORE.cameraRoll(1.0, 1.0, 1.0, 1.0, true, 0, false)) < 1e-4;
            const rollStrafeL = CORE.cameraRoll(0, 0, 0, -1, false, 0, false);
            const rollStrafeR = CORE.cameraRoll(0, 0, 0, 1, false, 0, false);
            const rollOpposite = rollStrafeL < 0 && rollStrafeR > 0;
            const rollSlide = CORE.cameraRoll(0, 0, 1, 0, false, 0, false);
            const rollSlideOk = Math.abs(rollSlide - 0.16) < 1e-4;

            const out = { x: 0, y: 0 };
            CORE.cameraPositionOffsets(0, 1, 1, false, out);
            const posSlideOk = Math.abs(out.x) < 1e-4 && Math.abs(out.y - (-0.45)) < 1e-4;
            CORE.cameraPositionOffsets(0, 1, 1, true, out);
            const posReducedOk = Math.abs(out.x) < 1e-4 && Math.abs(out.y) < 1e-4;

            return zoomSr && zoomAr && zoomSmg &&
                   fovNom && fovSlide && fovTac && fovReduced && fovAds &&
                   fovTargetNom && fovTargetZoom && fovTargetSr && fovTargetSlide && fovTargetTac &&
                   strafeNone && strafeLeftKey && strafeRightKey && strafeBoth &&
                   strafeAnalogL && strafeAnalogR && strafeAnalogDead &&
                   rollReduced && rollOpposite && rollSlideOk &&
                   posSlideOk && posReducedOk;
        }""")
        checks.append(("tactical-camera-and-visual-polish-rules", tactical_camera_check))

        # 43) Player locomotion, jump grace, head-bob, and weapon recoil/ADS balance rules.
        locomotion_balance_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.playerMoveSpeed !== 'function' ||
                typeof CORE.movementAccelRate !== 'function' ||
                typeof CORE.stepHorizontalVelocity !== 'function' ||
                typeof CORE.stepHeadBob !== 'function' ||
                typeof CORE.landingStunDuration !== 'function' ||
                typeof CORE.stepJumpTimers !== 'function' ||
                typeof CORE.canInitiateJump !== 'function' ||
                typeof CORE.stepAdsTransition !== 'function' ||
                typeof CORE.stepGunSwitch !== 'function' ||
                typeof CORE.applyShotKick !== 'function' ||
                typeof CORE.decayShotKick !== 'function' ||
                typeof CORE.sniperUnscopeAds !== 'function') return false;

            const walkSpeed = Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, false, false, false, 1.65, 0.55, 1) - 5.4) < 1e-4;
            const sprintSpeed = Math.abs(CORE.playerMoveSpeed(5.4, 1, true, false, false, false, false, false, 1.65, 0.55, 1) - 8.91) < 1e-4;
            const tacSpeed = Math.abs(CORE.playerMoveSpeed(5.4, 1, true, true, false, false, false, false, 1.65, 0.55, 1) - 11.1375) < 1e-4;
            const downedSpeed = Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, true, false, false, false, 1.65, 0.55, 1) - 1.89) < 1e-4;
            const stunSpeed = Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, true, false, false, 1.65, 0.55, 1) - 2.97) < 1e-4;
            const crouchSpeed = Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, false, true, false, 1.65, 0.55, 1) - 2.97) < 1e-4;
            const adsSpeed = Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, false, false, true, 1.65, 0.55, 1) - 3.51) < 1e-4;

            const accelGround = CORE.movementAccelRate(true, false, true, 16, 38) === 16;
            const decelGround = CORE.movementAccelRate(true, false, false, 16, 38) === 38;
            const accelAir = CORE.movementAccelRate(false, false, true, 16, 38) === 7;
            const accelSlideAir = CORE.movementAccelRate(false, true, true, 16, 38) === 4;

            const vOut = { x: 0, z: 0 };
            CORE.stepHorizontalVelocity(0.03, 0.02, 0, 0, 38, 0.05, true, false, vOut);
            const snapZero = vOut.x === 0 && vOut.z === 0;

            const bobOut = { phase: 0, amp: 0 };
            CORE.stepHeadBob(0, 0, true, 3.0, false, 0.1, bobOut);
            const bobWalk = Math.abs(bobOut.phase - 0.9) < 1e-4;
            CORE.stepHeadBob(0, 0, true, 8.0, true, 0.1, bobOut);
            const bobSprint = Math.abs(bobOut.phase - 1.3) < 1e-4;

            const stunDur = CORE.landingStunDuration(1.0) === 0.25 && CORE.landingStunDuration(0.0) === 0.75;

            const jOut = { coyoteT: 0, jumpBufT: 0 };
            CORE.stepJumpTimers(0, 0, true, false, 0.016, jOut);
            const coyoteRefreshed = jOut.coyoteT === 0.12;
            CORE.stepJumpTimers(0.1, 0, false, true, 0.016, jOut);
            const jumpBuffered = jOut.jumpBufT === 0.15;

            const canJumpOk = CORE.canInitiateJump(0.15, 0.12, false, false, false, 0) === true;
            const canJumpNoBuf = CORE.canInitiateJump(0, 0.12, false, false, false, 0) === false;
            const canJumpCrouch = CORE.canInitiateJump(0.15, 0.12, true, false, false, 0) === false;
            const canJumpStun = CORE.canInitiateJump(0.15, 0.12, false, false, false, 0.2) === false;

            const adsIn = Math.abs(CORE.stepAdsTransition(0, true, 0.05, 1, 1) - (12 * 0.05)) < 1e-4;
            const switchStep = CORE.stepGunSwitch(0.95, 0.1) === 1.0;
            const kickApply = CORE.applyShotKick(0) === 0.5 && CORE.applyShotKick(1.2) === 1.4;
            const kickDecay = CORE.decayShotKick(1.0, 0.05) < 1.0;
            const unscopeOk = Math.abs(CORE.sniperUnscopeAds(1.0) - 0.45) < 1e-4;

            return walkSpeed && sprintSpeed && tacSpeed && downedSpeed && stunSpeed && crouchSpeed && adsSpeed &&
                   accelGround && decelGround && accelAir && accelSlideAir &&
                   snapZero && bobWalk && bobSprint && stunDur &&
                   coyoteRefreshed && jumpBuffered &&
                   canJumpOk && canJumpNoBuf && canJumpCrouch && canJumpStun &&
                   adsIn && switchStep && kickApply && kickDecay && unscopeOk;
        }""")
        checks.append(("locomotion-and-combat-balance-rules", locomotion_balance_check))

        # 44) Slide vignette, objective HUD, weapon scope overlay, and steady aim performance rules.
        overlay_perf_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.stepSlideVignette !== 'function' ||
                typeof CORE.slideVignetteStyle !== 'function' ||
                typeof CORE.objectiveLabel !== 'function' ||
                typeof CORE.objectiveHudChanged !== 'function' ||
                typeof CORE.syncObjectiveHudState !== 'function' ||
                typeof CORE.isScopeOverlayActive !== 'function' ||
                typeof CORE.scopeOverlayChanged !== 'function' ||
                typeof CORE.syncScopeOverlayState !== 'function' ||
                typeof CORE.isSteadyIndicatorVisible !== 'function' ||
                typeof CORE.steadyIndicatorLabel !== 'function' ||
                typeof CORE.steadyIndicatorChanged !== 'function' ||
                typeof CORE.syncSteadyIndicatorState !== 'function') return false;

            const vigStepUp = Math.abs(CORE.stepSlideVignette(0, true, 0.05) - 0.7) < 1e-4;
            const vigStepDown = Math.abs(CORE.stepSlideVignette(1.0, false, 0.05) - 0.3) < 1e-4;
            const vigSnapZero = CORE.stepSlideVignette(0.002, false, 0.05) === 0;
            const vigSnapOne = CORE.stepSlideVignette(0.998, true, 0.05) === 1;

            const vigStyleZero = CORE.slideVignetteStyle(0) === 'inset 0 0 90px 30px rgba(0,0,0,0)';
            const vigStyleFull = CORE.slideVignetteStyle(1) === 'inset 0 0 90px 30px rgba(0,0,0,0.55)';

            const objLblHold = CORE.objectiveLabel(true, 50) === 'HOLDING — 50%';
            const objLblReturn = CORE.objectiveLabel(false, 50) === 'RETURN TO THE ZONE — 50%';

            const objState = { visible: false, inside: false, pct: -1 };
            const objCh1 = CORE.objectiveHudChanged(objState, true, true, 10);
            CORE.syncObjectiveHudState(objState, true, true, 10);
            const objChSame = !CORE.objectiveHudChanged(objState, true, true, 10);
            const objChAdv = CORE.objectiveHudChanged(objState, true, true, 20);

            const scopeSr = CORE.isScopeOverlayActive(0.8, 'SR');
            const scopeBr = CORE.isScopeOverlayActive(0.8, 'BR');
            const scopeAr = !CORE.isScopeOverlayActive(0.85, 'AR');
            const scopeLow = !CORE.isScopeOverlayActive(0.5, 'SR');

            const scopeState = { active: false, isSniper: false };
            const scopeCh1 = CORE.scopeOverlayChanged(scopeState, true, true);
            CORE.syncScopeOverlayState(scopeState, true, true);
            const scopeChSame = !CORE.scopeOverlayChanged(scopeState, true, true);

            const steadyVisSr = CORE.isSteadyIndicatorVisible('SR', 0.85);
            const steadyVisAr = !CORE.isSteadyIndicatorVisible('AR', 0.9);
            const steadyLblActive = CORE.steadyIndicatorLabel(true, 1.5).startsWith('STEADY · 1.5s');
            const steadyLblHold = CORE.steadyIndicatorLabel(false, 1.5) === 'HOLD SHIFT TO STEADY';
            const steadyLblBreath = CORE.steadyIndicatorLabel(false, 0.1) === 'CATCH YOUR BREATH';

            const steadyState = { visible: false, steadyActive: false, label: '' };
            const steadyCh1 = CORE.steadyIndicatorChanged(steadyState, true, false, 'HOLD SHIFT TO STEADY');
            CORE.syncSteadyIndicatorState(steadyState, true, false, 'HOLD SHIFT TO STEADY');
            const steadyChSame = !CORE.steadyIndicatorChanged(steadyState, true, false, 'HOLD SHIFT TO STEADY');

            return vigStepUp && vigStepDown && vigSnapZero && vigSnapOne &&
                   vigStyleZero && vigStyleFull && objLblHold && objLblReturn &&
                   objCh1 && objChSame && objChAdv &&
                   scopeSr && scopeBr && scopeAr && scopeLow &&
                   scopeCh1 && scopeChSame &&
                   steadyVisSr && steadyVisAr && steadyLblActive && steadyLblHold && steadyLblBreath &&
                   steadyCh1 && steadyChSame;
        }""")
        checks.append(("hud-churn-and-overlay-performance-rules", overlay_perf_check))

        # 45) Adaptive music dynamics and tactical station/downed audio rules.
        adaptive_audio_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.stepMusicIntensity !== 'function' ||
                typeof CORE.musicBusGain !== 'function' ||
                typeof CORE.musicTensionGain !== 'function' ||
                typeof CORE.musicFilterCutoff !== 'function' ||
                typeof CORE.musicPulseBpm !== 'function' ||
                typeof CORE.stepMusicPulsePhase !== 'function' ||
                typeof CORE.musicPulseEnvelope !== 'function' ||
                typeof CORE.musicPulseGain !== 'function' ||
                typeof CORE.stationPurchaseSound !== 'function' ||
                typeof CORE.playerDownSound !== 'function' ||
                typeof CORE.playerReviveSound !== 'function') return false;

            const riseStep = Math.abs(CORE.stepMusicIntensity(0, 1, 0.05) - 0.08) < 1e-4;
            const fallStep = Math.abs(CORE.stepMusicIntensity(1, 0, 0.05) - 0.975) < 1e-4;
            const fullTarget = CORE.stepMusicIntensity(0, 0.8, 10) === 0.8;

            const busZero = Math.abs(CORE.musicBusGain(1.0, 0) - 0.22) < 1e-4;
            const busFull = Math.abs(CORE.musicBusGain(1.0, 1.0) - 0.72) < 1e-4;

            const tensionLow = CORE.musicTensionGain(0.2) === 0;
            const tensionHigh = Math.abs(CORE.musicTensionGain(1.0) - 0.16) < 1e-4;

            const cutoffLow = CORE.musicFilterCutoff(0) === 200;
            const cutoffHigh = CORE.musicFilterCutoff(1.0) === 1100;

            const bpmLow = CORE.musicPulseBpm(0) === 46;
            const bpmHigh = CORE.musicPulseBpm(1.0) === 132;

            const phaseStep = Math.abs(CORE.stepMusicPulsePhase(0, 0.5, 60) - 0.5) < 1e-4;
            const phaseWrap = Math.abs(CORE.stepMusicPulsePhase(0.9, 0.2, 60) - 0.1) < 1e-4;

            const envPeak = CORE.musicPulseEnvelope(0) === 1.0;
            const envFloor = CORE.musicPulseEnvelope(1.0) === 0.0;

            const pulseLow = Math.abs(CORE.musicPulseGain(1.0, 0) - 0.05) < 1e-4;
            const pulseHigh = Math.abs(CORE.musicPulseGain(1.0, 1.0) - 0.55) < 1e-4;

            const sndArmory = CORE.stationPurchaseSound('armory') === 'armory_upgrade';
            const sndDoor = CORE.stationPurchaseSound('door') === 'door_unlock';
            const sndWeapon = CORE.stationPurchaseSound('wall', false) === 'weapon_buy';
            const sndAmmo = CORE.stationPurchaseSound('wall', true) === 'pickup_ammo';
            const sndPlate = CORE.stationPurchaseSound('plate') === 'pickup_ammo';
            const sndPerk = CORE.stationPurchaseSound('perk') === 'powerup';

            const sndDown = CORE.playerDownSound() === 'player_down';
            const sndRevive = CORE.playerReviveSound() === 'player_revive';

            const recipesOk = typeof SOUND_RECIPES !== 'undefined' &&
                              Array.isArray(SOUND_RECIPES.armory_upgrade) &&
                              Array.isArray(SOUND_RECIPES.door_unlock) &&
                              Array.isArray(SOUND_RECIPES.weapon_buy) &&
                              Array.isArray(SOUND_RECIPES.player_down) &&
                              Array.isArray(SOUND_RECIPES.player_revive);

            const variedOk = typeof SOUND_VARIED !== 'undefined' &&
                             SOUND_VARIED.armory_upgrade === 1 &&
                             SOUND_VARIED.door_unlock === 1 &&
                             SOUND_VARIED.weapon_buy === 1 &&
                             SOUND_VARIED.player_down === 1 &&
                             SOUND_VARIED.player_revive === 1;

            return riseStep && fallStep && fullTarget &&
                   busZero && busFull && tensionLow && tensionHigh &&
                   cutoffLow && cutoffHigh && bpmLow && bpmHigh &&
                   phaseStep && phaseWrap && envPeak && envFloor &&
                   pulseLow && pulseHigh &&
                   sndArmory && sndDoor && sndWeapon && sndAmmo && sndPlate && sndPerk &&
                   sndDown && sndRevive && recipesOk && variedOk;
        }""")
        checks.append(("adaptive-music-and-tactical-audio-rules", adaptive_audio_check))

        # 46) Mobile touch station USE button contextual label, state, and change-detection rules.
        touch_use_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.touchUseState !== 'function' ||
                typeof CORE.touchUseLabel !== 'function' ||
                typeof CORE.touchUseChanged !== 'function' ||
                typeof CORE.syncTouchUseState !== 'function') return false;

            const stEmpty = CORE.touchUseState(false, true, false) === 'empty';
            const stReady = CORE.touchUseState(true, true, false) === 'ready';
            const stHolding = CORE.touchUseState(true, true, true) === 'holding';
            const stBlocked = CORE.touchUseState(true, false, false) === 'blocked';

            const lblIdle = CORE.touchUseLabel(false, false, false, '', '') === 'USE';
            const lblHold = CORE.touchUseLabel(true, true, true, 'armory', 'upgrade') === 'HOLD';
            const lblLock = CORE.touchUseLabel(true, false, false, 'door', 'door') === 'LOCK';
            const lblArmory = CORE.touchUseLabel(true, true, false, 'armory', 'upgrade') === 'UPGRADE';
            const lblDoor = CORE.touchUseLabel(true, true, false, 'door', 'door') === 'OPEN';
            const lblPlate = CORE.touchUseLabel(true, true, false, 'plate', 'plate') === 'PLATE';
            const lblPerk = CORE.touchUseLabel(true, true, false, 'perk', 'perk') === 'PERK';
            const lblWallAmmo = CORE.touchUseLabel(true, true, false, 'wall', 'ammo') === 'AMMO';
            const lblWallBuy = CORE.touchUseLabel(true, true, false, 'wall', 'buy') === 'BUY';
            const lblCycle = CORE.touchUseLabel(true, true, false, 'lethal', 'cycle') === 'CYCLE';

            const cacheState = { nearStation: false, canAfford: false, isHolding: false, stationKind: '', action: '' };
            const chInit = CORE.touchUseChanged(cacheState, true, true, false, 'armory', 'upgrade');
            CORE.syncTouchUseState(cacheState, true, true, false, 'armory', 'upgrade');
            const chSame = !CORE.touchUseChanged(cacheState, true, true, false, 'armory', 'upgrade');
            const chHold = CORE.touchUseChanged(cacheState, true, true, true, 'armory', 'upgrade');

            return stEmpty && stReady && stHolding && stBlocked &&
                   lblIdle && lblHold && lblLock && lblArmory && lblDoor &&
                   lblPlate && lblPerk && lblWallAmmo && lblWallBuy && lblCycle &&
                   chInit && chSame && chHold;
        }""")
        checks.append(("touch-station-use-feedback-and-contextual-rules", touch_use_check))

        # 47) Procedural viewmodel dynamics, tactical stance, and weapon animation rules.
        viewmodel_rules_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.viewmodelStance !== 'function' ||
                typeof CORE.viewmodelStanceOffsets !== 'function' ||
                typeof CORE.reloadAnimationOffsets !== 'function' ||
                typeof CORE.viewmodelBoltOffset !== 'function' ||
                typeof CORE.viewmodelPose !== 'function' ||
                typeof CORE.stepMuzzleFlash !== 'function' ||
                typeof CORE.stepMuzzleLight !== 'function' ||
                typeof CORE.impactVfxScale !== 'function') return false;

            const stAds = CORE.viewmodelStance(true, true, false, true) === 'ads';
            const stSlide = CORE.viewmodelStance(true, false, true, false) === 'slide';
            const stTac = CORE.viewmodelStance(true, true, false, false) === 'tac_sprint';
            const stSprint = CORE.viewmodelStance(true, false, false, false) === 'sprint';
            const stIdle = CORE.viewmodelStance(false, false, false, false) === 'idle';

            const oIdle = CORE.viewmodelStanceOffsets('idle');
            const oTac = CORE.viewmodelStanceOffsets('tac_sprint');
            const oSlide = CORE.viewmodelStanceOffsets('slide');
            const offsetsOk = oIdle.posX === 0 && oIdle.posY === 0 &&
                              oTac.posX === -0.04 && oTac.posY === 0.06 && oTac.rotX === 0.28 &&
                              oSlide.posX === 0.05 && oSlide.posY === -0.08 && oSlide.rotX === -0.12;

            const rInactive = CORE.reloadAnimationOffsets(-1, 2.5);
            const rMid = CORE.reloadAnimationOffsets(1.25, 2.5);
            const reloadOk = rInactive.dip === 0 && rInactive.rot === 0 &&
                             Math.abs(rMid.dip - CORE.VIEWMODEL_RELOAD_DIP) < 1e-4 &&
                             Math.abs(rMid.rot - CORE.VIEWMODEL_RELOAD_ROT) < 1e-4 &&
                             rMid.magY < CORE.VIEWMODEL_MAG_REST_Y;

            const boltRest = CORE.viewmodelBoltOffset(0) === CORE.VIEWMODEL_BOLT_REST_Z;
            const boltKick = Math.abs(CORE.viewmodelBoltOffset(0.5) - (CORE.VIEWMODEL_BOLT_REST_Z + 0.5 * CORE.VIEWMODEL_BOLT_KICK_SCALE)) < 1e-5;

            const poseOut = { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };
            CORE.viewmodelPose(0, 'idle', 0, 0, 0, 0, 0, false, 1, 0, 0, 0, 1.77, false, poseOut);
            const hipOk = Math.abs(poseOut.posX - CORE.VIEWMODEL_HIP_X) < 1e-4 &&
                          Math.abs(poseOut.posY - CORE.VIEWMODEL_HIP_Y) < 1e-4 &&
                          Math.abs(poseOut.posZ - CORE.VIEWMODEL_HIP_Z) < 1e-4;

            CORE.viewmodelPose(1, 'sprint', 0, 0, 0, 0, 0, false, 1, 0, 0, 0, 1.77, false, poseOut);
            const adsOk = Math.abs(poseOut.posX - CORE.VIEWMODEL_ADS_X) < 1e-4 &&
                          Math.abs(poseOut.posY - CORE.VIEWMODEL_ADS_Y) < 1e-4 &&
                          Math.abs(poseOut.posZ - CORE.VIEWMODEL_ADS_Z) < 1e-4 &&
                          Math.abs(poseOut.rotX) < 1e-4 && Math.abs(poseOut.rotZ) < 1e-4;

            const flashStep = Math.abs(CORE.stepMuzzleFlash(1, 0.05, 12) - 0.4) < 1e-4;
            const flashFloor = CORE.stepMuzzleFlash(0.2, 0.05, 12) === 0;
            const lightStep = Math.abs(CORE.stepMuzzleLight(3.2 * 4, 0.05, 26, 1) - (12.8 - 0.05 * 26 * 4)) < 1e-4;
            const vfxScalePeak = CORE.impactVfxScale(0.25, 0.25) === 1.0;
            const vfxScaleFloor = CORE.impactVfxScale(0, 0.25) === 0.001;

            return stAds && stSlide && stTac && stSprint && stIdle &&
                   offsetsOk && reloadOk && boltRest && boltKick &&
                   hipOk && adsOk && flashStep && flashFloor && lightStep &&
                   vfxScalePeak && vfxScaleFloor;
        }""")
        checks.append(("procedural-viewmodel-and-weapon-dynamics-rules", viewmodel_rules_check))

        # 48) Particle upload optimization, marksman scope dynamics, and spring physics rules.
        pfx_scope_spring_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.pfxNeedsUpload !== 'function' ||
                typeof CORE.scopeParallaxOffset !== 'function' ||
                typeof CORE.scopeParallaxChanged !== 'function' ||
                typeof CORE.rangefinderLabel !== 'function' ||
                typeof CORE.isHostileTarget !== 'function' ||
                typeof CORE.stepRangefinderTimer !== 'function' ||
                typeof CORE.stepSpring !== 'function' ||
                typeof CORE.vmSmooth !== 'function' ||
                typeof CORE.vmBump !== 'function' ||
                typeof CORE.wrapAngle !== 'function' ||
                typeof CORE.stepPostKick !== 'function' ||
                typeof CORE.postFringe !== 'function' ||
                typeof CORE.isPostfxWanted !== 'function') return false;

            const pfxIdle = CORE.pfxNeedsUpload(0, 0) === false;
            const pfxActive = CORE.pfxNeedsUpload(5, 0) === true;
            const pfxDying = CORE.pfxNeedsUpload(0, 5) === true;

            const pOut = { x: 0, y: 0, sx: '', sy: '' };
            CORE.scopeParallaxOffset(0.02, -0.01, false, 40, 900, pOut);
            const parallaxOk = pOut.x === -18 && pOut.y === -9 && pOut.sx === '-18.0px' && pOut.sy === '-9.0px';

            CORE.scopeParallaxOffset(0.02, -0.01, true, 40, 900, pOut);
            const parallaxRedOk = pOut.x === 0 && pOut.y === 0 && pOut.sx === '0.0px' && pOut.sy === '0.0px';

            const pCh1 = CORE.scopeParallaxChanged(null, null, '0.0px', '0.0px');
            const pChSame = !CORE.scopeParallaxChanged('0.0px', '0.0px', '0.0px', '0.0px');

            const rngNone = CORE.rangefinderLabel(Infinity, false) === 'RNG ---';
            const rngDist = CORE.rangefinderLabel(12.3, false) === 'RNG 12m';
            const rngTgt = CORE.rangefinderLabel(12.3, true) === 'TGT 12m';

            const hostNear = CORE.isHostileTarget(10, 15, 0.5) === true;
            const hostFar = CORE.isHostileTarget(16, 15, 0.5) === false;

            const sOut = [0, 0];
            CORE.stepSpring(0, 0, 1, 90, 11, 0.05, sOut);
            const springOk = sOut[0] > 0 && sOut[0] < 1 && sOut[1] > 0;

            const smoothOk = CORE.vmSmooth(0, 1, 0.5) === 0.5;
            const bumpOk = CORE.vmBump(0, 1, 0.5) === 1.0;
            const wrapOk = Math.abs(CORE.wrapAngle(Math.PI * 3) - Math.PI) < 1e-4;

            const kickOk = Math.abs(CORE.stepPostKick(1.0, 0.05, 1.6) - 0.92) < 1e-4;
            const fringeOk = CORE.postFringe(0.8, false) === 0.8 && CORE.postFringe(0.8, true) === 0;
            const pfxWantedOk = CORE.isPostfxWanted('low', false) === false && CORE.isPostfxWanted('high', true) === true;

            return pfxIdle && pfxActive && pfxDying && parallaxOk && parallaxRedOk &&
                   pCh1 && pChSame && rngNone && rngDist && rngTgt && hostNear && hostFar &&
                   springOk && smoothOk && bumpOk && wrapOk && kickOk && fringeOk && pfxWantedOk;
        }""")
        checks.append(("particle-scope-and-spring-physics-rules", pfx_scope_spring_check))

        # 49) Combat ordnance, weapon reload, sentry, enemy ballistics, and pickup lifecycle rules.
        balance_rules_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.canReload !== 'function' ||
                typeof CORE.effectiveReloadDuration !== 'function' ||
                typeof CORE.isReloadComplete !== 'function' ||
                typeof CORE.completeReload !== 'function' ||
                typeof CORE.munitionsAmmoRestore !== 'function' ||
                typeof CORE.airstrikeDelay !== 'function' ||
                typeof CORE.airstrikeBombCoord !== 'function' ||
                typeof CORE.enemyGrenadeSpeed !== 'function' ||
                typeof CORE.enemyGrenadeFuse !== 'function' ||
                typeof CORE.enemyGrenadeCooldown !== 'function' ||
                typeof CORE.enemyBurstInterval !== 'function' ||
                typeof CORE.pickupBobHeight !== 'function' ||
                typeof CORE.isPickupVisible !== 'function' ||
                typeof CORE.canCollectPickup !== 'function' ||
                typeof CORE.grenadeBlinkVisible !== 'function' ||
                typeof CORE.flashOverlayOpacity !== 'function' ||
                typeof CORE.smokeCloudScale !== 'function' ||
                typeof CORE.smokeCloudOpacity !== 'function' ||
                typeof CORE.burnPatchOpacity !== 'function') return false;

            const reloadOk = CORE.canReload(15, 30, 90, false) === true &&
                             CORE.canReload(30, 30, 90, false) === false &&
                             CORE.canReload(15, 30, 0, false) === false;

            const durOk = Math.abs(CORE.effectiveReloadDuration(2.1, 0.7) - 1.47) < 1e-4 &&
                          CORE.isReloadComplete(1.5, 1.47) === true &&
                          CORE.isReloadComplete(1.0, 1.47) === false;

            const rOut = { ammo: 0, reserve: 0, take: 0 };
            CORE.completeReload(10, 30, 50, rOut);
            const compOk = rOut.ammo === 30 && rOut.reserve === 30 && rOut.take === 20;

            const munOk = CORE.munitionsAmmoRestore(30, 120, 30, 0.5) === 45 &&
                          CORE.munitionsAmmoRestore(110, 120, 30, 0.5) === 120;

            const sentryOk = CORE.SENTRY_RANGE === 26 && CORE.SENTRY_ROF === 0.22 && CORE.SENTRY_DMG === 22 &&
                             CORE.SENTRY_DEPLOY_OFFSET === 2.2 && CORE.MUNITIONS_DEPLOY_OFFSET === 1.8;

            const airOk = CORE.airstrikeDelay(0) === 700 && CORE.airstrikeDelay(2) === 1220;
            const airCoord = CORE.airstrikeBombCoord(0, 0, 0, 1, 2, 14, 5, 0, 0);
            const airCoordOk = airCoord.x === 0 && airCoord.z === 24;

            const enSpdOk = CORE.enemyGrenadeSpeed(0) === 6 && CORE.enemyGrenadeSpeed(100) === 13;
            const enFuseOk = Math.abs(CORE.enemyGrenadeFuse(2.5, 0.4) - 2.9) < 1e-4;
            const enCdOk = Math.abs(CORE.enemyGrenadeCooldown(true, 10, 0.5) - 17.5) < 1e-4;
            const enBurstOk = CORE.enemyBurstInterval(2, 0.4, 0.5) === 0.12;

            const pickBobOk = Math.abs(CORE.pickupBobHeight(0, false) - 0.3) < 1e-4 &&
                              Math.abs(CORE.pickupBobHeight(0, true) - 0.55) < 1e-4;
            const pickVisOk = CORE.isPickupVisible(10, 20, 25) === true &&
                              CORE.isPickupVisible(26, 20, 25) === false;
            const pickColOk = CORE.canCollectPickup(0, 0, 0.5, 0.5, 1.3) === true &&
                              CORE.canCollectPickup(0, 0, 2, 2, 1.3) === false;

            const blinkOk = typeof CORE.grenadeBlinkVisible(1.5, 0, 0) === 'boolean' &&
                            CORE.grenadeBlinkVisible(Infinity, 0.6, 0.5) === true;
            const flashOk = Math.abs(CORE.flashOverlayOpacity(1.5, 1.5, 0.92) - 0.92) < 1e-4 &&
                            CORE.flashOverlayOpacity(0, 1.5, 0.92) === 0;
            const smokeOk = Math.abs(CORE.smokeCloudScale(1.0, 4, 1.0) - 4.0) < 1e-4 &&
                            Math.abs(CORE.smokeCloudOpacity(1.5, 1.5, 0.62) - 0.62) < 1e-4;
            const burnOk = Math.abs(CORE.burnPatchOpacity(1.0, 2.0, 0.5) - 0.25) < 1e-4;

            return reloadOk && durOk && compOk && munOk && sentryOk && airOk && airCoordOk &&
                   enSpdOk && enFuseOk && enCdOk && enBurstOk && pickBobOk && pickVisOk &&
                   pickColOk && blinkOk && flashOk && smokeOk && burnOk;
        }""")
        checks.append(("combat-ordnance-reload-and-lifecycle-balance-rules", balance_rules_check))

        # 50) Tactical power-ups, ordnance deployment, steady aim breath, and stamina exhaustion audio rules.
        tactical_audio_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.powerupSound !== 'function' ||
                typeof CORE.equipmentDeploySound !== 'function' ||
                typeof CORE.steadyAimBreathEvent !== 'function' ||
                typeof CORE.exhaustionSound !== 'function' ||
                typeof CORE.slideCancelSound !== 'function') return false;

            const nukeOk = CORE.powerupSound('nuke') === 'powerup_nuke';
            const ammoOk = CORE.powerupSound('maxammo') === 'powerup_ammo';
            const dblOk = CORE.powerupSound('double') === 'powerup_double';
            const instaOk = CORE.powerupSound('instakill') === 'powerup_instakill';
            const defOk = CORE.powerupSound('other') === 'powerup';

            const clayOk = CORE.equipmentDeploySound('proximity', 'claymore') === 'claymore_plant' &&
                           CORE.equipmentDeploySound('timed', 'claymore') === 'claymore_plant' &&
                           CORE.equipmentDeploySound('proximity', 'other') === 'claymore_plant';
            const pinOk = CORE.equipmentDeploySound('timed', 'frag') === 'pin' &&
                          CORE.equipmentDeploySound('tactical', 'flash') === 'pin';

            const breathHold = CORE.steadyAimBreathEvent(true, false, 5.0) === 'breath_hold';
            const breathGasp = CORE.steadyAimBreathEvent(false, true, 0.0) === 'breath_gasp';
            const breathSteady = CORE.steadyAimBreathEvent(true, true, 4.0) === null &&
                                 CORE.steadyAimBreathEvent(false, false, 5.0) === null;

            const exhTrigger = CORE.exhaustionSound(true, false) === 'exhausted';
            const exhSustain = CORE.exhaustionSound(true, true) === null &&
                               CORE.exhaustionSound(false, false) === null &&
                               CORE.exhaustionSound(false, true) === null;

            const slideCancel = CORE.slideCancelSound() === 'slide_cancel';

            return nukeOk && ammoOk && dblOk && instaOk && defOk &&
                   clayOk && pinOk && breathHold && breathGasp && breathSteady &&
                   exhTrigger && exhSustain && slideCancel;
        }""")
        checks.append(("tactical-audio-ordnance-steady-and-exhaustion-rules", tactical_audio_check))

        # 51) Mobile UI polish: touch jump/ads contextual states, labels, change detection, and steady-aim rules.
        touch_polish_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.touchJumpState !== 'function' ||
                typeof CORE.touchJumpLabel !== 'function' ||
                typeof CORE.touchJumpChanged !== 'function' ||
                typeof CORE.syncTouchJumpState !== 'function' ||
                typeof CORE.touchAdsState !== 'function' ||
                typeof CORE.touchAdsLabel !== 'function' ||
                typeof CORE.touchAdsChanged !== 'function' ||
                typeof CORE.syncTouchAdsState !== 'function' ||
                typeof CORE.touchSlideChanged !== 'function' ||
                typeof CORE.syncTouchSlideState !== 'function' ||
                typeof CORE.touchMeleeChanged !== 'function' ||
                typeof CORE.syncTouchMeleeState !== 'function' ||
                typeof CORE.isMobileSteadyAim !== 'function') return false;

            const jumpAir = CORE.touchJumpState(false) === 'airborne';
            const jumpGrd = CORE.touchJumpState(true) === '';
            const jumpBoost = CORE.touchJumpState(true, true, false, false, false) === 'boost';
            const jumpMantle = CORE.touchJumpState(false, false, true, false, false) === 'mantle';
            const jumpLock = CORE.touchJumpState(true, false, false, true, false) === 'locked';

            const lblBoost = CORE.touchJumpLabel('boost', false) === 'BOOST';
            const lblClimb = CORE.touchJumpLabel('mantle', false) === 'CLIMB';
            const lblAir = CORE.touchJumpLabel('airborne', false) === 'AIR';
            const lblStand = CORE.touchJumpLabel('', true) === 'STAND';
            const lblJump = CORE.touchJumpLabel('', false) === 'JUMP';

            const jCache = { jumpState: '', jumpLabel: 'JUMP' };
            const jSame = CORE.touchJumpChanged(jCache, '', 'JUMP') === false;
            const jDiff = CORE.touchJumpChanged(jCache, 'boost', 'BOOST') === true;
            CORE.syncTouchJumpState(jCache, 'boost', 'BOOST');
            const jSyncOk = jCache.jumpState === 'boost' && jCache.jumpLabel === 'BOOST';

            const adsZero = CORE.touchAdsState(0, 'SR', 0.82, false) === '';
            const adsAct = CORE.touchAdsState(0.5, 'SR', 0.82, false) === 'active';
            const adsScope = CORE.touchAdsState(0.85, 'SR', 0.82, false) === 'scoped';
            const adsSteady = CORE.touchAdsState(0.85, 'SR', 0.82, true) === 'steady';

            const lblSteady = CORE.touchAdsLabel('steady', 'SR', 2.0) === 'STEADY';
            const lblScope = CORE.touchAdsLabel('scoped', 'SR', 2.0) === 'SCOPE';
            const lblWait = CORE.touchAdsLabel('scoped', 'SR', 0) === 'WAIT';
            const lblAim = CORE.touchAdsLabel('active', 'AR', 0) === 'AIM';
            const lblAds = CORE.touchAdsLabel('', '', 0) === 'ADS';

            const aCache = { adsState: '', adsLabel: 'ADS' };
            const aSame = CORE.touchAdsChanged(aCache, '', 'ADS') === false;
            const aDiff = CORE.touchAdsChanged(aCache, 'steady', 'STEADY') === true;
            CORE.syncTouchAdsState(aCache, 'steady', 'STEADY');
            const aSyncOk = aCache.adsState === 'steady' && aCache.adsLabel === 'STEADY';

            const sCache = { slideState: '', slideLabel: 'SLIDE' };
            const sDiff = CORE.touchSlideChanged(sCache, 'sliding', 'SLIDE') === true;
            CORE.syncTouchSlideState(sCache, 'sliding', 'SLIDE');
            const sSame = CORE.touchSlideChanged(sCache, 'sliding', 'SLIDE') === false;

            const mCache = { meleeState: '', meleeLabel: 'KNIFE' };
            const mDiff = CORE.touchMeleeChanged(mCache, 'ready', 'STRIKE') === true;
            CORE.syncTouchMeleeState(mCache, 'ready', 'STRIKE');
            const mSame = CORE.touchMeleeChanged(mCache, 'ready', 'STRIKE') === false;

            const steadyOk = CORE.isMobileSteadyAim(true, 0.85, 'SR', 0, 0) === true &&
                             CORE.isMobileSteadyAim(false, 0.85, 'SR', 0, 0) === false &&
                             CORE.isMobileSteadyAim(true, 0.85, 'AR', 0, 0) === false &&
                             CORE.isMobileSteadyAim(true, 0.85, 'SR', 0.3, 0) === false;

            return jumpAir && jumpGrd && jumpBoost && jumpMantle && jumpLock &&
                   lblBoost && lblClimb && lblAir && lblStand && lblJump &&
                   jSame && jDiff && jSyncOk &&
                   adsZero && adsAct && adsScope && adsSteady &&
                   lblSteady && lblScope && lblWait && lblAim && lblAds &&
                   aSame && aDiff && aSyncOk && sDiff && sSame && mDiff && mSame && steadyOk;
        }""")
        checks.append(("touch-jump-ads-and-steady-aim-mobile-rules", touch_polish_check))

        # 52) Casing dynamics, ground settling, smooth scale fade, and viewmodel kinematics visual rules.
        visual_polish_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.casingScale !== 'function' ||
                typeof CORE.casingEjectVelocity !== 'function' ||
                typeof CORE.stepCasingPhysics !== 'function' ||
                typeof CORE.casingRestRotation !== 'function' ||
                typeof CORE.stepMeleeKnifePose !== 'function' ||
                typeof CORE.meleeGunDodgeOffsets !== 'function' ||
                typeof CORE.stepViewmodelMantle !== 'function' ||
                typeof CORE.viewmodelMantleOffsets !== 'function' ||
                typeof CORE.reloadHandOffsets !== 'function' ||
                typeof CORE.viewmodelLateralSpeed !== 'function' ||
                typeof CORE.stepViewmodelTilt !== 'function' ||
                typeof CORE.viewmodelLookInertiaTarget !== 'function') return false;

            const constsOk = CORE.CASING_MAX === 24 &&
                             CORE.CASING_LIFETIME === 2.2 &&
                             CORE.CASING_FADE_DURATION === 0.35 &&
                             CORE.CASING_FLOOR_Y === 0.02 &&
                             CORE.CASING_GRAVITY === 12 &&
                             CORE.CASING_BOUNCE === 0.35 &&
                             CORE.CASING_FRICTION === 0.5 &&
                             CORE.CASING_SPIN_DAMP === 0.4 &&
                             CORE.CASING_REST_SPEED === 0.6 &&
                             CORE.CASING_SND_GAP === 0.09 &&
                             CORE.VIEWMODEL_MANTLE_IN_RATE === 8 &&
                             CORE.VIEWMODEL_MANTLE_OUT_RATE === 5;

            const scaleFull = CORE.casingScale(2.2, 2.2, 0.35) === 1.0;
            const scaleFadeMid = Math.abs(CORE.casingScale(0.175, 2.2, 0.35) - 0.5) < 1e-4;
            const scaleZero = CORE.casingScale(0, 2.2, 0.35) === 0.001;

            const vel = CORE.casingEjectVelocity(1, 0, 0, 0.5, 0.5);
            const velOk = Math.abs(vel.x - 2.1) < 1e-4 && Math.abs(vel.y - 1.9) < 1e-4;

            const pOut = CORE.stepCasingPhysics(0, 0.05, 0, 1.0, -2.0, 0, 2.0, 0, 0, 0.05, 12, 0.35, 0.5, 0.4, 0.02, 0.6);
            const bounceOk = pOut.y === 0.02 && pOut.bounced === true && Math.abs(pOut.vy - 0.91) < 1e-4;

            const rot = CORE.casingRestRotation(0.2, 1.5, 0.8);
            const rotOk = Math.abs(rot.rotX - Math.PI * 0.5) < 1e-4 && rot.rotY === 1.5 && rot.rotZ === 0;

            const kPose = CORE.stepMeleeKnifePose(0.3);
            const knifeOk = kPose.posZ === -0.3 && kPose.rotX === -0.2 && typeof kPose.posX === 'number';

            const dMid = CORE.meleeGunDodgeOffsets(0.5);
            const dodgeOk = Math.abs(dMid.posY - (-0.25)) < 1e-4 && Math.abs(dMid.rotX - (-0.5)) < 1e-4;

            const mStep = CORE.stepViewmodelMantle(0, true, 0.05) === 0.4;
            const mOffsets = CORE.viewmodelMantleOffsets(1.0);
            const mantleOk = mStep && Math.abs(mOffsets.posY - (-0.18)) < 1e-4 && Math.abs(mOffsets.rotX - (-0.3)) < 1e-4;

            const handRest = CORE.reloadHandOffsets(0, 0, 0, 0, 0, 0, 0);
            const handOk = handRest.posX === 0 && handRest.posY === 0 && handRest.posZ === 0;

            const latSpdOk = Math.abs(CORE.viewmodelLateralSpeed(5, 0, 0) - 5) < 1e-4;
            const tiltOk = CORE.stepViewmodelTilt(0, 5, 0, 1, 0.05) < 0;
            const lookOk = CORE.viewmodelLookInertiaTarget(0.02, false, 0, 1) > 0 &&
                           CORE.viewmodelLookInertiaTarget(0.02, true, 0, 1) < 0;

            return constsOk && scaleFull && scaleFadeMid && scaleZero &&
                   velOk && bounceOk && rotOk && knifeOk && dodgeOk &&
                   mantleOk && handOk && latSpdOk && tiltOk && lookOk;
        }""")
        checks.append(("casing-and-viewmodel-visual-polish-rules", visual_polish_check))

        # 53) Buy prompt change gating, minimap/compass rules, ragdoll sink lifecycle, and procedural enemy kinematics.
        perf_rules_check = page.evaluate("""() => {
            if (!CORE ||
                typeof CORE.buyPromptLabel !== 'function' ||
                typeof CORE.buyPromptFillPct !== 'function' ||
                typeof CORE.compassNeedsRedraw !== 'function' ||
                typeof CORE.minimapBlipOffset !== 'function' ||
                typeof CORE.isRagdollSinkReady !== 'function' ||
                typeof CORE.enemyProcPose !== 'function') return false;

            const bpLabelOk = CORE.buyPromptLabel('MK18', 500, '[F] ') === '[F] MK18  ·  500 CR' &&
                              CORE.buyPromptLabel('ARMOR', 0, '') === 'ARMOR';
            const bpPctOk = CORE.buyPromptFillPct(0.5, 2.0) === 25 &&
                            CORE.buyPromptFillPct(2.5, 2.0) === 100;
            const bpColorOk = CORE.buyPromptColor(false) === CORE.BUY_PROMPT_DEFAULT_COLOR &&
                              CORE.buyPromptColor(true) === CORE.BUY_PROMPT_DIM_COLOR;

            const compassOk = CORE.compassNeedsRedraw(null, 1.0) === true &&
                              CORE.compassNeedsRedraw(1.0, 1.001) === false &&
                              CORE.compassNeedsRedraw(1.0, 1.003) === true;

            const blip = CORE.minimapBlipOffset(10, 20, 5, 10, 2);
            const mmOk = blip.x === 10 && blip.z === 20 &&
                         CORE.isMinimapBlipVisible(10, 20, 500) === true &&
                         CORE.isMinimapBlipVisible(10, 20, 400) === false &&
                         CORE.minimapEnemyRadius(2) === 4 &&
                         CORE.minimapEnemyRadius(0) === 3;

            const sinkOk = CORE.isRagdollSinkReady(false, 5.0) === false &&
                           CORE.isRagdollSinkReady(true, 3.0) === false &&
                           CORE.isRagdollSinkReady(true, 3.6) === true &&
                           CORE.isRagdollExpired(1.7) === true;

            const poseOut = { legLRotX: 0, legRRotX: 0, armLRotX: 0, armRRotX: 0, bodyRotX: 0, bodyPosY: 0, moving: false };
            const poseRes = CORE.enemyProcPose(Math.PI / 2, 3.2, 1, 5.0, 1.5, 0.0, poseOut);
            const poseOk = poseRes === poseOut && poseOut.moving === true && poseOut.legLRotX > 0 && poseOut.legRRotX < 0;

            return bpLabelOk && bpPctOk && bpColorOk && compassOk && mmOk && sinkOk && poseOk;
        }""")
        checks.append(("buy-prompt-and-minimap-perf-rules", perf_rules_check))

        # 54) Wave spawn pacing, enemy combat execution, and mobility balance rules.
        balance_rules_check = page.evaluate("""() => {
            if (!CORE ||
                typeof CORE.waveSpawnPressure !== 'function' ||
                typeof CORE.waveSpawnBurstCount !== 'function' ||
                typeof CORE.enemyBulletTravelDelay !== 'function' ||
                typeof CORE.enemyMeleeWindup !== 'function' ||
                typeof CORE.canSlideCancel !== 'function' ||
                typeof CORE.isSlideExpired !== 'function' ||
                typeof CORE.stepStationHold !== 'function' ||
                typeof CORE.weaponFireInterval !== 'function') return false;

            const constsOk = CORE.WAVE_SPAWN_PRESSURE_QUEUE === 18 &&
                             CORE.WAVE_SPAWN_SWEET_SPOT === 26 &&
                             CORE.AMMO_RELIEF_DRY_THRESHOLD === 5 &&
                             CORE.ENEMY_BULLET_MAX_DELAY_MS === 300 &&
                             CORE.SLIDE_CANCEL_MIN_T === 0.12 &&
                             CORE.STATION_HOLD_DECAY_RATE === 3;

            const wpOk = CORE.waveSpawnPressure(0) === 0 &&
                         CORE.waveSpawnPressure(9) === 0.5 &&
                         CORE.waveSpawnPressure(36) === 1;

            const burstOk = CORE.waveSpawnBurstCount(10, 5, 0, 0) === 3 &&
                            CORE.waveSpawnBurstCount(10, 5, 1, 0.9) === 5 &&
                            CORE.waveSpawnBurstCount(1, 5, 1, 0.9) === 1;

            const delayOk = CORE.enemyBulletTravelDelay(10) === 22 &&
                            CORE.enemyBulletTravelDelay(200) === 300;

            const meleeOk = CORE.enemyMeleeWindup(0) === 0.25 &&
                            CORE.enemyAttackReadyTime(5, 1.0, 0) === 6.0;

            const slideOk = CORE.canSlideCancel(0.10) === false &&
                            CORE.canSlideCancel(0.15) === true &&
                            CORE.isSlideExpired(0.95, true, true) === true &&
                            CORE.isSlideExpired(0.5, true, true) === false;

            const holdOk = Math.abs(CORE.stepStationHold(0, true, 0.2) - 0.2) < 1e-4 &&
                           CORE.stepStationHold(0.5, false, 0.1, 3, 0.6) < 0.3;

            const rpmOk = Math.abs(CORE.weaponFireInterval(600) - 0.1) < 1e-4;

            return constsOk && wpOk && burstOk && delayOk && meleeOk && slideOk && holdOk && rpmOk;
        }""")
        checks.append(("wave-pacing-and-combat-balance-rules", balance_rules_check))

        # 55) Surface ballistic impact acoustics, sniper bolt cycle, tactical readiness cues, and weapon draw rules.
        tactical_acoustics_check = page.evaluate("""() => {
            if (!CORE ||
                typeof CORE.surfaceImpactSound !== 'function' ||
                typeof CORE.sniperBoltSound !== 'function' ||
                typeof CORE.streakReadySound !== 'function' ||
                typeof CORE.fieldUpgradeReadySound !== 'function' ||
                typeof CORE.secondWindSound !== 'function' ||
                typeof CORE.objectiveCompleteSound !== 'function' ||
                typeof CORE.weaponDrawSound !== 'function') return false;

            const constsOk = CORE.SPATIAL_IMPACT_MAX_DIST === 55 &&
                             CORE.SNIPER_BOLT_DELAY_MS === 280;

            const impactOk = CORE.surfaceImpactSound('metal') === 'impact_metal' &&
                             CORE.surfaceImpactSound('wood') === 'impact_wood' &&
                             CORE.surfaceImpactSound('glass') === 'impact_glass' &&
                             CORE.surfaceImpactSound('ground') === 'impact_ground' &&
                             CORE.surfaceImpactSound('concrete') === 'impact' &&
                             CORE.surfaceImpactSound('brick') === 'impact' &&
                             CORE.surfaceImpactSound(null) === 'impact';

            const boltOk = CORE.sniperBoltSound() === 'sniper_bolt';

            const readyOk = CORE.streakReadySound('uav') === 'streak_ready' &&
                            CORE.streakReadySound('airstrike') === 'streak_ready' &&
                            CORE.fieldUpgradeReadySound() === 'field_ready' &&
                            CORE.secondWindSound() === 'second_wind' &&
                            CORE.objectiveCompleteSound() === 'objective_complete';

            const drawOk = CORE.weaponDrawSound('SR') === 'draw_heavy' &&
                           CORE.weaponDrawSound('BR') === 'draw_heavy' &&
                           CORE.weaponDrawSound('SMG') === 'draw_light' &&
                           CORE.weaponDrawSound('AR') === 'draw' &&
                           CORE.weaponDrawSound('') === 'draw';

            const recipesOk = typeof SOUND_RECIPES !== 'undefined' &&
                              Array.isArray(SOUND_RECIPES.impact_metal) &&
                              Array.isArray(SOUND_RECIPES.impact_wood) &&
                              Array.isArray(SOUND_RECIPES.impact_glass) &&
                              Array.isArray(SOUND_RECIPES.impact_ground) &&
                              Array.isArray(SOUND_RECIPES.sniper_bolt) &&
                              Array.isArray(SOUND_RECIPES.streak_ready) &&
                              Array.isArray(SOUND_RECIPES.field_ready) &&
                              Array.isArray(SOUND_RECIPES.second_wind) &&
                              Array.isArray(SOUND_RECIPES.objective_complete) &&
                              Array.isArray(SOUND_RECIPES.draw_heavy) &&
                              Array.isArray(SOUND_RECIPES.draw_light);

            const variedOk = typeof SOUND_VARIED !== 'undefined' &&
                             SOUND_VARIED.impact_metal === 1 &&
                             SOUND_VARIED.impact_wood === 1 &&
                             SOUND_VARIED.impact_glass === 1 &&
                             SOUND_VARIED.impact_ground === 1 &&
                             SOUND_VARIED.sniper_bolt === 1 &&
                             SOUND_VARIED.streak_ready === 1 &&
                             SOUND_VARIED.field_ready === 1 &&
                             SOUND_VARIED.second_wind === 1 &&
                             SOUND_VARIED.objective_complete === 1 &&
                             SOUND_VARIED.draw_heavy === 1 &&
                             SOUND_VARIED.draw_light === 1;

            return constsOk && impactOk && boltOk && readyOk && drawOk && recipesOk && variedOk;
        }""")
        checks.append(("tactical-surface-impact-and-weapon-acoustics-rules", tactical_acoustics_check))

        # 56) Mobile touch action button change-detection, weapon swap cycling, layout clamping, and control labeling rules.
        mobile_polish_check = page.evaluate("""() => {
            if (!CORE ||
                typeof CORE.touchFireChanged !== 'function' ||
                typeof CORE.syncTouchFireState !== 'function' ||
                typeof CORE.touchReloadChanged !== 'function' ||
                typeof CORE.syncTouchReloadState !== 'function' ||
                typeof CORE.touchPlateChanged !== 'function' ||
                typeof CORE.syncTouchPlateState !== 'function' ||
                typeof CORE.touchEquipmentChanged !== 'function' ||
                typeof CORE.syncTouchEquipmentState !== 'function' ||
                typeof CORE.touchStreakChanged !== 'function' ||
                typeof CORE.syncTouchStreakState !== 'function' ||
                typeof CORE.touchSwapChanged !== 'function' ||
                typeof CORE.syncTouchSwapState !== 'function' ||
                typeof CORE.touchSwapNextSlot !== 'function' ||
                typeof CORE.touchControlName !== 'function' ||
                typeof CORE.touchLayoutClampPercent !== 'function') return false;

            const constsOk = CORE.TOUCH_BUTTON_DEFAULT_SIZE === 56 &&
                             CORE.TOUCH_FIRE_DEFAULT_SIZE === 84 &&
                             CORE.TOUCH_PAUSE_DEFAULT_SIZE === 44;

            const fCache = { fireState: 'ready', fireLabel: 'FIRE' };
            const fSame = CORE.touchFireChanged(fCache, 'ready', 'FIRE') === false;
            const fDiff = CORE.touchFireChanged(fCache, 'empty', 'EMPTY') === true;
            CORE.syncTouchFireState(fCache, 'empty', 'EMPTY');
            const fSyncOk = fCache.fireState === 'empty' && fCache.fireLabel === 'EMPTY';

            const rCache = { reloadState: '', reloadLabel: 'RLD' };
            const rSame = CORE.touchReloadChanged(rCache, '', 'RLD') === false;
            const rDiff = CORE.touchReloadChanged(rCache, 'urgent', 'RELOAD') === true;
            CORE.syncTouchReloadState(rCache, 'urgent', 'RELOAD');
            const rSyncOk = rCache.reloadState === 'urgent' && rCache.reloadLabel === 'RELOAD';

            const pCache = { plateState: '', plateLabel: 'PLATE' };
            const pDiff = CORE.touchPlateChanged(pCache, 'urgent', 'PLATE 3') === true;
            CORE.syncTouchPlateState(pCache, 'urgent', 'PLATE 3');
            const pSame = CORE.touchPlateChanged(pCache, 'urgent', 'PLATE 3') === false;

            const eCache = { eqState: 'ready', eqLabel: 'FRAG 2' };
            const eDiff = CORE.touchEquipmentChanged(eCache, 'charging', 'FRAG 2') === true;
            CORE.syncTouchEquipmentState(eCache, 'charging', 'FRAG 2');
            const eSame = CORE.touchEquipmentChanged(eCache, 'charging', 'FRAG 2') === false;

            const sCache = { streakState: 'empty', streakLabel: 'STRK' };
            const sDiff = CORE.touchStreakChanged(sCache, 'streak', 'UAV') === true;
            CORE.syncTouchStreakState(sCache, 'streak', 'UAV');
            const sSame = CORE.touchStreakChanged(sCache, 'streak', 'UAV') === false;

            const swCache = { swapState: 'empty', swapLabel: 'SWAP' };
            const swDiff = CORE.touchSwapChanged(swCache, 'ready', 'SMG') === true;
            CORE.syncTouchSwapState(swCache, 'ready', 'SMG');
            const swSame = CORE.touchSwapChanged(swCache, 'ready', 'SMG') === false;

            const nextSlotOk = CORE.touchSwapNextSlot(0, [0, -1, 2]) === 2 &&
                               CORE.touchSwapNextSlot(2, [0, -1, 2]) === 0 &&
                               CORE.touchSwapNextSlot(0, [0, -1]) === -1;

            const ctrlNameOk = CORE.touchControlName('tbtn-fire') === 'FIRE' &&
                               CORE.touchControlName('tbtn-nade') === 'LETHAL' &&
                               CORE.touchControlName('joy-base') === 'JOYSTICK' &&
                               CORE.touchControlName('tbtn-pause') === 'PAUSE' &&
                               CORE.touchControlName('tbtn-plate') === 'ARMOR';

            const clampOk = Math.abs(CORE.touchLayoutClampPercent(500, 56, 1000) - 47.2) < 1e-4 &&
                            CORE.touchLayoutClampPercent(-50, 56, 1000) === 0 &&
                            Math.abs(CORE.touchLayoutClampPercent(1050, 56, 1000) - 94.4) < 1e-4;

            return constsOk && fSame && fDiff && fSyncOk &&
                   rSame && rDiff && rSyncOk && pDiff && pSame &&
                   eDiff && eSame && sDiff && sSame && swDiff && swSame &&
                   nextSlotOk && ctrlNameOk && clampOk;
        }""")
        checks.append(("touch-action-buttons-and-layout-mobile-rules", mobile_polish_check))

        # 57) Ballistic bullet hole decals, viewmodel muzzle flash dynamics, and tracer kinematics visual rules.
        decal_muzzle_tracer_visual_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.decalCaliberScale !== 'function' ||
                typeof CORE.decalSurfaceMultiplier !== 'function' ||
                typeof CORE.decalScale !== 'function' ||
                typeof CORE.decalRotationAngle !== 'function' ||
                typeof CORE.stepDecalLife !== 'function' ||
                typeof CORE.isDecalExpired !== 'function' ||
                typeof CORE.muzzleFlashRotation !== 'function' ||
                typeof CORE.muzzleFlashBaseScale !== 'function' ||
                typeof CORE.stepMuzzleFlashScale !== 'function' ||
                typeof CORE.tracerThicknessScale !== 'function' ||
                typeof CORE.tracerColor !== 'function') return false;

            const constsOk = CORE.DECAL_MAX === 48 &&
                             CORE.DECAL_LIFETIME === 25 &&
                             CORE.DECAL_FADE_DURATION === 3.5 &&
                             CORE.DECAL_BASE_RADIUS === 0.075 &&
                             CORE.DECAL_STANDOFF === 0.012 &&
                             CORE.MUZZLE_FLASH_SUPPRESSED_SCALE === 0.22 &&
                             CORE.TRACER_LIFETIME === 0.065;

            const calSmg = CORE.decalCaliberScale('SMG') === 0.72;
            const calSr = CORE.decalCaliberScale('SR') === 1.5;
            const surfGlass = CORE.decalSurfaceMultiplier('glass') === 1.25;
            const surfMetal = CORE.decalSurfaceMultiplier('metal') === 0.82;

            const scaleFull = CORE.decalScale('AR', 'concrete', 25, 25, 3.5) === 1.0;
            const scaleFade = CORE.decalScale('AR', 'concrete', 1.75, 25, 3.5) < 1.0;
            const scaleZero = CORE.decalScale('AR', 'concrete', 0, 25, 3.5) === 0.001;

            const rotOk = Math.abs(CORE.decalRotationAngle(0.5) - Math.PI) < 1e-4;
            const lifeStep = CORE.stepDecalLife(25, 1.0) === 24 &&
                             CORE.isDecalExpired(24) === false &&
                             CORE.isDecalExpired(0) === true;

            const flashSmg = CORE.muzzleFlashBaseScale('SMG', false, 0.5, 0.5);
            const smgFlashOk = Math.abs(flashSmg.k - 0.775) < 1e-4 && Math.abs(flashSmg.z - 0.75) < 1e-4;
            const flashSr = CORE.muzzleFlashBaseScale('SR', false, 0, 0);
            const srFlashOk = flashSr.k === 1.5 && flashSr.z === 1.4;
            const flashSupp = CORE.muzzleFlashBaseScale('AR', true, 0.5, 0.5);
            const suppFlashOk = flashSupp.k < 0.3 && flashSupp.z < 0.3;

            const msPeak = CORE.stepMuzzleFlashScale(1.0, 1.0, 1.0);
            const msMid = CORE.stepMuzzleFlashScale(1.0, 1.0, 0.5);
            const msZero = CORE.stepMuzzleFlashScale(1.0, 1.0, 0);
            const flashDecayOk = msPeak.x === 1.0 && Math.abs(msMid.x - 0.625) < 1e-4 && msZero.x === 0;

            const tracerOk = CORE.tracerThicknessScale(0.065, 0.065) === 1.0 &&
                             Math.abs(CORE.tracerThicknessScale(0.0325, 0.065) - 0.5) < 1e-4 &&
                             CORE.tracerColor(false) === 0xffe9a0 &&
                             CORE.tracerColor(true) === 0xff8844;

            return constsOk && calSmg && calSr && surfGlass && surfMetal &&
                   scaleFull && scaleFade && scaleZero && rotOk && lifeStep &&
                   smgFlashOk && srFlashOk && suppFlashOk && flashDecayOk && tracerOk;
        }""")
        checks.append(("ballistic-decal-muzzle-and-tracer-visual-rules", decal_muzzle_tracer_visual_check))

        # 58) Perf: zero-alloc recoil absorption & pattern sampling, collider relevance pruning, movement velocity synthesis, and HUD canvas throttling rules.
        zero_alloc_hud_perf_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            const colAbove = CORE.isColliderRelevantXZ(2.1, 4.0, 0, 1.8, 0.6) === false;
            const colBelow = CORE.isColliderRelevantXZ(0, 0.5, 0, 1.8, 0.6) === false;
            const colUnder = CORE.isColliderRelevantXZ(-2.0, 0.0, 0, 1.8, 0.6) === false;
            const colHit = CORE.isColliderRelevantXZ(0, 2.5, 0, 1.8, 0.6) === true;
            const colNan = CORE.isColliderRelevantXZ(NaN, 1.0, 0, 1.8, 0.6) === false;

            const rkOut = { x: 0, y: 0 };
            const rkRes = CORE.recoilAt('ar', 0, 0, 0, rkOut);
            const rkMutates = rkRes === rkOut && typeof rkRes.x === 'number';

            const absOut = { offset: 0, delta: 0 };
            const absRes = CORE.absorbRecoil(0.05, -0.02, absOut);
            const absMutates = absRes === absOut && Math.round(absOut.offset * 1000) / 1000 === 0.03 && absOut.delta === 0;

            const velOut = { x: 0, z: 0 };
            const velRes = CORE.movementTargetVelocity(0, 1, 0, 6.0, velOut);
            const velMutates = velRes === velOut && Math.abs(velOut.x) < 1e-4 && Math.abs(velOut.z - (-6.0)) < 1e-4;

            const hudConsts = CORE.HUD_REDRAW_INTERVAL === 0.05 &&
                              CORE.HUD_FLICK_YAW_THRESHOLD === 0.15 &&
                              CORE.HUD_FLICK_COOLDOWN === 0.12;
            const hudElapsed = CORE.shouldRedrawHudCanvas(0.051, 0.01, 1.0) === true;
            const hudHold = CORE.shouldRedrawHudCanvas(0.02, 0.05, 1.0) === false;
            const hudFlick = CORE.shouldRedrawHudCanvas(0.01, 0.20, 0.15) === true;
            const hudFlickCd = CORE.shouldRedrawHudCanvas(0.01, 0.20, 0.05) === false;

            const enemiesList = [{ dead: false }, { dead: true }, { dead: false }, null, { dead: false }];
            const countAlive = CORE.countAliveEnemies(enemiesList) === 3 && CORE.countAliveEnemies([]) === 0;
            const labelsOk = CORE.hostilesRemainingLabel(0) === '0 HOSTILES' &&
                             CORE.hostilesRemainingLabel(1) === '1 HOSTILE' &&
                             CORE.hostilesRemainingLabel(4) === '4 HOSTILES';

            const gunFovOk = CORE.gunCameraFov(0, 'AR') === 58 &&
                             CORE.gunCameraFov(1, 'AR') === 46 &&
                             CORE.gunCameraFov(1, 'SR') === 40;
            const narrowOk = CORE.viewmodelNarrowOffset(1.77, 0.2, 1.0) === 0 &&
                             CORE.viewmodelNarrowOffset(0.75, 0.2, 1.0) > 0;

            return colAbove && colBelow && colUnder && colHit && colNan &&
                   rkMutates && absMutates && velMutates && hudConsts &&
                   hudElapsed && hudHold && hudFlick && hudFlickCd &&
                   countAlive && labelsOk && gunFovOk && narrowOk;
        }""")
        checks.append(("zero-alloc-recoil-and-hud-canvas-perf-rules", zero_alloc_hud_perf_check))

        # 59) Balance: enemy combat kinematics, slide steering kinetics, tactical sprint gating, bleedout lifecycle, and objective progress balance rules.
        combat_kinematics_balance_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.enemyScale !== 'function' ||
                typeof CORE.enemyColliderRadius !== 'function' ||
                typeof CORE.enemyHeadHeight !== 'function' ||
                typeof CORE.enemySpawnSpeedMultiplier !== 'function' ||
                typeof CORE.isEnemyFlanker !== 'function' ||
                typeof CORE.enemyFallbackVelocity !== 'function' ||
                typeof CORE.enemyStrafeVelocity !== 'function' ||
                typeof CORE.enemyStrafeDuration !== 'function' ||
                typeof CORE.canEnemyThrowGrenade !== 'function' ||
                typeof CORE.enemyFootstepRate !== 'function' ||
                typeof CORE.enemyFootstepInterval !== 'function' ||
                typeof CORE.relocateFacingAlignment !== 'function' ||
                typeof CORE.relocateCandidateScore !== 'function' ||
                typeof CORE.stepSlideSteering !== 'function' ||
                typeof CORE.isTacSprintTriggered !== 'function' ||
                typeof CORE.stepGrenadeBounceVelocity !== 'function' ||
                typeof CORE.isGrenadeAtRest !== 'function' ||
                typeof CORE.downBleedoutLabel !== 'function' ||
                typeof CORE.multikillBonus !== 'function' ||
                typeof CORE.waveCountdownLabel !== 'function' ||
                typeof CORE.waveBannerLabels !== 'function') return false;

            const constsOk = CORE.STEP_HEIGHT === 0.60 &&
                             CORE.SLIDE_STEER_RATE === 2.2 &&
                             CORE.TAC_TAP_WINDOW === 0.32 &&
                             CORE.TAC_DURATION === 2.5 &&
                             CORE.GRENADE_BOUNCE_LAT_DAMP === 0.55 &&
                             CORE.GRENADE_ROLL_LAT_DAMP === 0.30;

            const scaleOk = CORE.enemyScale(0) === 1.0 &&
                            CORE.enemyScale(2) === 1.25 &&
                            CORE.enemyScale(3) === 1.1 &&
                            CORE.enemyScale(4) === 0.88;

            const radOk = CORE.enemyColliderRadius(0) === 0.4 &&
                          Math.abs(CORE.enemyColliderRadius(2) - 0.56) < 1e-4;

            const headOk = CORE.enemyHeadHeight(0, 0) === 1.85 &&
                           CORE.enemyHeadHeight(1, 2) === 3.3;

            const flankOk = CORE.isEnemyFlanker(4, false, 0.9) === true &&
                            CORE.isEnemyFlanker(3, true, 0.1) === false &&
                            CORE.isEnemyFlanker(1, true, 0.2) === true &&
                            CORE.isEnemyFlanker(1, true, 0.7) === false;

            const fbOut = { x: 0, z: 0 };
            const fbRes = CORE.enemyFallbackVelocity(0, 1, 1, fbOut);
            const fbOk = fbRes === fbOut && fbOut.z < -0.7;

            const strOut = { x: 0, z: 0 };
            const strRes = CORE.enemyStrafeVelocity(0, 1, 1, strOut);
            const strOk = strRes === strOut && strOut.x === -1.0;

            const nadeOk = CORE.canEnemyThrowGrenade(5, 20, false) === true &&
                           CORE.canEnemyThrowGrenade(5, 5, false) === false &&
                           CORE.canEnemyThrowGrenade(1, 15, false) === true &&
                           CORE.canEnemyThrowGrenade(1, 15, true) === false;

            const stepOk = CORE.enemyFootstepRate(0) === 1.7 &&
                           CORE.enemyFootstepRate(2) === 0.9 &&
                           CORE.enemyFootstepInterval(1.0) === 0.55;

            const steerOut = { x: 0, z: -1 };
            const steerRes = CORE.stepSlideSteering(0, -1, 1, 0, 0.05, 2.2, steerOut);
            const steerOk = steerRes === steerOut && steerOut.x > 0;

            const tacOk = CORE.isTacSprintTriggered(5.2, 5.0, false, 0.32) === true &&
                          CORE.isTacSprintTriggered(5.5, 5.0, false, 0.32) === false;

            const bncOut = { x: 0, y: 0, z: 0 };
            const bncRes = CORE.stepGrenadeBounceVelocity(4, -6, 2, 0.45, 1, bncOut);
            const bncOk = bncRes === bncOut && Math.abs(bncOut.y - 2.7) < 1e-4 && Math.abs(bncOut.x - 2.2) < 1e-4;

            const restOk = CORE.isGrenadeAtRest(0.04, 0.05, 0.10, 2) === true &&
                           CORE.isGrenadeAtRest(0.2, 0.05, 0.10, 2) === false;

            const hudLabelsOk = CORE.downBleedoutLabel(8.5) === 'BLEEDING OUT — 8.5s' &&
                                CORE.multikillBonus(60, 3) === 120 &&
                                CORE.waveCountdownLabel(0, 3.2) === 'COMBAT IN 4' &&
                                CORE.waveBannerLabels(5, true, 15).big === 'WAVE 5 CLEARED';

            return constsOk && scaleOk && radOk && headOk && flankOk &&
                   fbOk && strOk && nadeOk && stepOk && steerOk &&
                   tacOk && bncOk && restOk && hudLabelsOk;
        }""")
        checks.append(("combat-kinematics-and-balance-rules", combat_kinematics_balance_check))

        # 60) Perf: ballistic tracer & impact lifecycle, sentry kinematics, and thermite burn rules.
        tracer_impact_sentry_perf_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.stepTracerLife !== 'function' ||
                typeof CORE.isTracerExpired !== 'function' ||
                typeof CORE.stepImpactLife !== 'function' ||
                typeof CORE.isImpactExpired !== 'function' ||
                typeof CORE.sentryTargetYaw !== 'function' ||
                typeof CORE.stepSentryTimers !== 'function' ||
                typeof CORE.sentryAimTargetY !== 'function' ||
                typeof CORE.burnTickDamage !== 'function' ||
                typeof CORE.isPointInBurnRadius !== 'function') return false;

            const constsOk = CORE.SENTRY_AIM_Y_OFFSET === 1.1 &&
                             CORE.BURN_TICK_INTERVAL === 0.25;

            const tracerOk = CORE.stepTracerLife(0.065, 0.02) === 0.045 &&
                             CORE.stepTracerLife(0.01, 0.02) === 0 &&
                             CORE.isTracerExpired(0.045) === false &&
                             CORE.isTracerExpired(0) === true;

            const impactOk = Math.abs(CORE.stepImpactLife(0.25, 0.05) - 0.20) < 1e-4 &&
                             CORE.stepImpactLife(0.02, 0.05) === 0 &&
                             CORE.isImpactExpired(0.15) === false &&
                             CORE.isImpactExpired(0) === true;

            const yawOk = Math.abs(CORE.sentryTargetYaw(0, 10) - Math.PI) < 1e-4 &&
                          Math.abs(CORE.sentryTargetYaw(0, -10) - Math.PI * 2) < 1e-4 &&
                          CORE.wrapAngle(CORE.sentryTargetYaw(0, -10)) === 0;

            const sentryOut = { t: 0, cd: 0, expired: false, readyToFire: false };
            const sRes = CORE.stepSentryTimers(10.0, 0.08, 0.05, sentryOut);
            const timerOk = sRes === sentryOut &&
                            Math.abs(sentryOut.t - 9.95) < 1e-4 &&
                            Math.abs(sentryOut.cd - 0.03) < 1e-4 &&
                            sentryOut.expired === false &&
                            sentryOut.readyToFire === false;

            CORE.stepSentryTimers(9.95, 0.02, 0.05, sentryOut);
            const fireOk = sentryOut.readyToFire === true;

            const aimYOk = CORE.sentryAimTargetY(0) === 1.1 &&
                           CORE.sentryAimTargetY(2.0) === 3.1;

            const burnDmgOk = CORE.burnTickDamage(40, 0.25) === 10 &&
                              CORE.burnTickDamage(60) === 15;

            const burnRadOk = CORE.isPointInBurnRadius(0, 0, 1, 1, 3.2) === true &&
                              CORE.isPointInBurnRadius(0, 0, 4, 4, 3.2) === false;

            return constsOk && tracerOk && impactOk && yawOk && timerOk && fireOk && aimYOk && burnDmgOk && burnRadOk;
        }""")
        checks.append(("tracer-impact-pooling-and-sentry-kinematics-perf-rules", tracer_impact_sentry_perf_check))

        # 61) Balance: ballistic spread cone, aim assist dynamics, enemy combat state kinetics, mantle & grenade loft rules.
        ballistic_balance_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.ballisticSpreadVector !== 'function' ||
                typeof CORE.bulletPenetrationPower !== 'function' ||
                typeof CORE.isAimAssistHeadCandidate !== 'function' ||
                typeof CORE.aimAssistAngularDeltas !== 'function' ||
                typeof CORE.stepAimAssistLook !== 'function' ||
                typeof CORE.enemyAiNextState !== 'function' ||
                typeof CORE.stepFlankVelocity !== 'function' ||
                typeof CORE.playerPushoutOffset !== 'function' ||
                typeof CORE.enemyAimTargetY !== 'function' ||
                typeof CORE.stepMantleProgress !== 'function' ||
                typeof CORE.grenadeThrowVelocity !== 'function' ||
                typeof CORE.playerSelfFlashDuration !== 'function') return false;

            const constsOk = CORE.SPREAD_LONGITUDINAL_SCALE === 0.3 &&
                             CORE.AIM_ASSIST_HEAD_THRESHOLD === 0.55 &&
                             CORE.AIM_ASSIST_HEAD_PRIORITY === 1.8 &&
                             CORE.AIM_ASSIST_PULL_WEIGHT === 0.25 &&
                             CORE.AIM_ASSIST_TRACK_RATE === 3.5 &&
                             CORE.AIM_ASSIST_CHEST_OFFSET === 1.0 &&
                             CORE.AIM_ASSIST_HEAD_OFFSET === 1.68 &&
                             CORE.BULLET_MAGNET_Y_OFFSET === 1.1 &&
                             CORE.ENEMY_SPAWN_DURATION === 0.5 &&
                             CORE.ENEMY_STRAFE_MAX_T === 6.0 &&
                             CORE.GRENADIER_STRAFE_RANGE === 34 &&
                             CORE.GRENADIER_STRAFE_DURATION === 2.5 &&
                             CORE.RIFLEMAN_STRAFE_DURATION === 2.0 &&
                             CORE.RIFLEMAN_LOS_RETRY_DELAY === 0.4 &&
                             CORE.FLANK_STEER_WEIGHT === 0.45 &&
                             CORE.ENEMY_OVERLAP_MIN_DIST === 0.05 &&
                             CORE.ENEMY_SHOT_CHEST_Y_OFFSET === 0.2 &&
                             CORE.MANTLE_DURATION === 0.35 &&
                             CORE.MANTLE_COYOTE_GRACE === 0.12 &&
                             CORE.GRENADE_PITCH_LOFT === 0.45 &&
                             CORE.GRENADE_COOLDOWN === 0.8 &&
                             CORE.TACTICAL_SPEED_MUL === 1.15 &&
                             CORE.PLAYER_FLASH_SELF_MUL === 0.6;

            const spOut = { x: 0, y: 0, z: 0 };
            const spRes = CORE.ballisticSpreadVector(0, 0, -1, 0.1, 1.0, 0.5, 0.5, spOut);
            const expLen = Math.hypot(0.1, 0, -1);
            const spreadOk = spRes === spOut && Math.abs(spOut.x - (0.1 / expLen)) < 1e-4 && Math.abs(spOut.z - (-1 / expLen)) < 1e-4;

            const penOk = CORE.bulletPenetrationPower('sr', 1.0) === 1.6 &&
                          CORE.bulletPenetrationPower('smg', 1.0) === 0.4 &&
                          CORE.bulletPenetrationPower('ar', 1.0) === 0.75;

            const headOk = CORE.isAimAssistHeadCandidate(0.2, 0.5) === true &&
                           CORE.isAimAssistHeadCandidate(0.3, 0.5) === false;

            const angOut = { yawDelta: 0, pitchDelta: 0 };
            const angRes = CORE.aimAssistAngularDeltas(-1, 0, 0, 0, 0, -1, angOut);
            const angOk = angRes === angOut && Math.abs(angOut.yawDelta - Math.PI / 2) < 1e-4 && Math.abs(angOut.pitchDelta) < 1e-4;

            const lookOut = { yaw: 0, pitch: 0 };
            const lookRes = CORE.stepAimAssistLook(0, 0, 0.2, 0.1, 0.05, 3.5, lookOut);
            const lookOk = lookRes === lookOut && Math.abs(lookOut.yaw - 0.035) < 1e-4 && Math.abs(lookOut.pitch - 0.0175) < 1e-4;

            const sOut = { state: '', stateT: 0, strafeT: 0, resetStateT: false };
            const stateSpawnOk = CORE.enemyAiNextState(0, 'spawn', 0.55, 10, true, 44, 16, sOut).state === 'chase' && sOut.resetStateT === true;
            const stateRifleStrafeOk = CORE.enemyAiNextState(1, 'chase', 1.0, 20, true, 44, 16, sOut).state === 'strafe' && sOut.strafeT === 2.0;
            const stateGrenFallbackOk = CORE.enemyAiNextState(5, 'chase', 1.0, 10, true, 44, 16, sOut).state === 'fallback';

            const flankOut = { x: 0, z: 0 };
            const flankRes = CORE.stepFlankVelocity(0, -1, 1, 1.0, flankOut);
            const flankOk = flankRes === flankOut && flankOut.x > 0 && flankOut.z < 0;

            const pushOut = { pushX: 0, pushZ: 0, applied: false };
            const pushRes = CORE.playerPushoutOffset(0.2, 0, 0, 0, 0, 0.2, 0.5, pushOut);
            const pushOk = pushRes === pushOut && pushOut.applied && Math.abs(pushOut.pushX - 0.3) < 1e-4;

            const enemyAimOk = CORE.enemyAimTargetY(1.7, 0.2) === 1.5 &&
                               CORE.enemyAimTargetY(1.7) === 1.5;

            const mantleProgressOk = Math.abs(CORE.stepMantleProgress(0.35, 0.175, 0.35).progressK - 0.5) < 1e-4 &&
                                     CORE.stepMantleProgress(0.1, 0.2, 0.35).completed === true;

            const throwOut = { x: 0, y: 0, z: 0 };
            const throwRes = CORE.grenadeThrowVelocity(0, 0, -1, 10, 0, throwOut);
            const throwOk = throwRes === throwOut && throwOut.x === 0 && throwOut.y === 0 && throwOut.z === -10;

            const flashSelfOk = Math.abs(CORE.playerSelfFlashDuration(1.0, 3.0, 0.6) - CORE.flashDuration(1.0, 1.8)) < 1e-4;

            return constsOk && spreadOk && penOk && headOk && angOk && lookOk &&
                   stateSpawnOk && stateRifleStrafeOk && stateGrenFallbackOk && flankOk &&
                   pushOk && enemyAimOk && mantleProgressOk && throwOk && flashSelfOk;
        }""")
        checks.append(("ballistic-spread-aim-assist-and-combat-kinematics-balance-rules", ballistic_balance_check))

        # 62) Mobile touch weapon swap draw state, layout editor labels, and left-handed HUD symmetry.
        mobile_touch_polish_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;
            const mockWpns = [{ type: 'AR' }, { type: 'SMG' }];
            const swapSwitchOk = CORE.touchSwapState(0, [0, 1], true) === 'switching' &&
                                 CORE.touchSwapState(0, [0, 1], false) === 'ready' &&
                                 CORE.touchSwapState(0, [0, -1], true) === 'empty';
            const swapLabelOk = CORE.touchSwapLabel(0, [0, 1], mockWpns, true) === 'DRAW' &&
                                CORE.touchSwapLabel(0, [0, 1], mockWpns, false) === 'SMG' &&
                                CORE.touchSwapLabel(0, [0, -1], mockWpns, true) === 'SWAP';
            const edLabelOk = CORE.touchEditorControlLabel('tbtn-fire', 84) === 'FIRE (84px)' &&
                              CORE.touchEditorControlLabel('joy-base', 112) === 'JOYSTICK (112px)' &&
                              CORE.touchEditorControlLabel(null) === 'Select a button' &&
                              CORE.touchEditorControlLabel('tbtn-swap') === 'SWAP';
            return swapSwitchOk && swapLabelOk && edLabelOk;
        }""")
        checks.append(("mobile-touch-swap-switching-and-layout-polish-rules", mobile_touch_polish_check))

        # 63) Tactical minimap deployables & pickups, dynamic grenade danger ring, and thermite burn VFX visual rules.
        minimap_deployables_and_burn_vfx_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;
            const constsOk = CORE.GRENADE_RING_BASE_OPACITY === 0.32 &&
                             CORE.GRENADE_RING_MAX_OPACITY === 0.78 &&
                             CORE.MINIMAP_SENTRY_COLOR === '#50b4ff' &&
                             CORE.MINIMAP_MUNITIONS_COLOR === '#8fd66a' &&
                             CORE.MINIMAP_PICKUP_AMMO_COLOR === '#ffd24a' &&
                             CORE.MINIMAP_PICKUP_MED_COLOR === '#4fd08a' &&
                             CORE.MINIMAP_PICKUP_POWER_COLOR === '#d070ff' &&
                             CORE.MINIMAP_SENTRY_RADIUS === 3.2 &&
                             CORE.MINIMAP_MUNITIONS_SIZE === 4.5 &&
                             CORE.MINIMAP_PICKUP_BASE_RADIUS === 2.2;

            const ringZero = CORE.grenadeDangerRingOpacity(0, 3.0) === 0 &&
                             CORE.grenadeDangerRingOpacity(-1, 3.0) === 0;
            const ringBase = CORE.grenadeDangerRingOpacity(2.5, 3.0) === CORE.GRENADE_RING_BASE_OPACITY;
            const ringPulse = CORE.grenadeDangerRingOpacity(0.5, 3.0);
            const ringPulseOk = ringPulse >= 0.12 && ringPulse <= CORE.GRENADE_RING_MAX_OPACITY;

            const burnZero = CORE.burnPatchPulsingOpacity(0, 6.0, 0.5) === 0;
            const burnShimmer = CORE.burnPatchPulsingOpacity(5.0, 6.0, 0.5);
            const burnShimmerOk = burnShimmer > 0 && burnShimmer <= 0.6;
            const flameStrengthOk = CORE.burnPatchFlameStrength(0, 6.0) === 0 &&
                                    CORE.burnPatchFlameStrength(6.0, 6.0) === 1.0 &&
                                    CORE.burnPatchFlameStrength(3.0, 6.0) === 0.5;

            const colorOk = CORE.minimapPickupColor('ammo') === CORE.MINIMAP_PICKUP_AMMO_COLOR &&
                            CORE.minimapPickupColor('med') === CORE.MINIMAP_PICKUP_MED_COLOR &&
                            CORE.minimapPickupColor('power') === CORE.MINIMAP_PICKUP_POWER_COLOR &&
                            CORE.minimapPickupColor('other') === CORE.MINIMAP_PICKUP_AMMO_COLOR;

            const pulseExpOk = CORE.pickupMinimapPulse(15.0, 9.0, 14.0, 2.2) === 0;
            const pulseBaseOk = CORE.pickupMinimapPulse(5.0, 9.0, 14.0, 2.2) === 2.2;
            const pulseAct = CORE.pickupMinimapPulse(11.0, 9.0, 14.0, 2.2);
            const pulseActOk = pulseAct >= 2.2 * 0.5 && pulseAct <= 2.2 * 1.5;

            const sOut = { x: 0, z: 0 };
            const sRes = CORE.sentryMinimapPointer(50, 40, 0, 5.5, sOut);
            const ptrMutOk = sRes === sOut && Math.abs(sOut.x - 50) < 1e-4 && Math.abs(sOut.z - 34.5) < 1e-4;
            CORE.sentryMinimapPointer(50, 40, Math.PI / 2, 5.5, sOut);
            const ptrRotOk = Math.abs(sOut.x - 44.5) < 1e-4 && Math.abs(sOut.z - 40) < 1e-4;

            return constsOk && ringZero && ringBase && ringPulseOk &&
                   burnZero && burnShimmerOk && flameStrengthOk &&
                   colorOk && pulseExpOk && pulseBaseOk && pulseActOk &&
                   ptrMutOk && ptrRotOk;
        }""")
        checks.append(("minimap-deployables-grenade-ring-and-burn-visual-rules", minimap_deployables_and_burn_vfx_check))

        # 64) Tactical battlefield and weapon audio polish rules & recipes (v113 audio polish).
        audio_polish_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;
            const constsOk = CORE.BULLET_WHIZ_MAX_DIST === 3.6 &&
                             CORE.BULLET_WHIZ_MIN_OFFSET === 0.75 &&
                             CORE.LOW_AMMO_THRESHOLD_AR === 5 &&
                             CORE.LOW_AMMO_THRESHOLD_SMG === 6 &&
                             CORE.LOW_AMMO_THRESHOLD_BR === 4 &&
                             CORE.LOW_AMMO_THRESHOLD_SR === 1;

            const whizSndOk = CORE.bulletWhizSound() === 'bullet_whiz';
            const nearMissOk = CORE.isBulletNearMiss(2.0, 3.6) === true &&
                               CORE.isBulletNearMiss(4.0, 3.6) === false;

            const mOut = { x: 0, y: 0, z: 0 };
            const mRes = CORE.bulletNearMissOffset(0.5, 0.5, 0.75, 3.6, mOut);
            const offsetOk = mRes === mOut && mOut.x >= 0.75 && mOut.x <= 3.6 && mOut.y >= 0.3 && mOut.y <= 1.8;

            const volOk = Math.abs(CORE.bulletWhizVolume(1.8, 3.6) - 0.5) < 1e-4 &&
                          CORE.bulletWhizVolume(3.6, 3.6) === 0;

            const lowThreshOk = CORE.lowAmmoThreshold('SR') === 1 &&
                                CORE.lowAmmoThreshold('SMG') === 6 &&
                                CORE.lowAmmoThreshold('BR') === 4 &&
                                CORE.lowAmmoThreshold('AR') === 5;

            const isLowOk = CORE.isLowAmmo(1, 'SR') === true &&
                            CORE.isLowAmmo(2, 'SR') === false &&
                            CORE.isLowAmmo(0, 'SR') === false &&
                            CORE.isLowAmmo(5, 'AR') === true &&
                            CORE.isLowAmmo(6, 'AR') === false;

            const lowSndOk = CORE.lowAmmoSound(1, 'SR') === 'low_ammo' &&
                             CORE.lowAmmoSound(2, 'SR') === null &&
                             CORE.lowAmmoSound(5, 'AR') === 'low_ammo' &&
                             CORE.lowAmmoSound(10, 'AR') === null;

            const emptyRelOk = CORE.isEmptyReload(0) === true &&
                               CORE.isEmptyReload(10) === false;

            const boltSndOk = CORE.reloadBoltSound('SR') === 'sniper_bolt' &&
                              CORE.reloadBoltSound('AR') === 'reload_bolt' &&
                              CORE.reloadBoltSound('SMG') === 'reload_bolt' &&
                              CORE.reloadBoltSound('BR') === 'reload_bolt';

            const recipesOk = typeof SOUND_RECIPES !== 'undefined' &&
                              Array.isArray(SOUND_RECIPES.bullet_whiz) &&
                              Array.isArray(SOUND_RECIPES.reload_bolt) &&
                              Array.isArray(SOUND_RECIPES.low_ammo);

            const variedOk = typeof SOUND_VARIED !== 'undefined' &&
                             SOUND_VARIED.bullet_whiz === 1 &&
                             SOUND_VARIED.reload_bolt === 1 &&
                             SOUND_VARIED.low_ammo === 1;

            return constsOk && whizSndOk && nearMissOk && offsetOk && volOk &&
                   lowThreshOk && isLowOk && lowSndOk && emptyRelOk && boltSndOk &&
                   recipesOk && variedOk;
        }""")
        checks.append(("tactical-battlefield-and-weapon-audio-rules", audio_polish_check))

        # 65) Tactical stance weapon recoil stability and enemy grenade/LOS combat balance rules (v114 balance tuning).
        stance_balance_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;
            const constsOk = CORE.STANCE_RECOIL_CROUCH === 0.80 &&
                             CORE.STANCE_RECOIL_SLIDE === 0.85 &&
                             CORE.STANCE_RECOIL_AIRBORNE === 1.25 &&
                             CORE.ENEMY_GRENADE_ARM_DURATION === 0.5 &&
                             CORE.ENEMY_LIVE_GRENADES_CAP === 6 &&
                             CORE.GRENADIER_INITIAL_NADE_DELAY === 3.0 &&
                             CORE.RIFLEMAN_INITIAL_NADE_DELAY === 6.0 &&
                             CORE.ENEMY_EYE_OFFSET_Y === 0.5 &&
                             CORE.ENEMY_LOS_JITTER === 0.3 &&
                             CORE.ENEMY_MELEE_COOLDOWN_SENTINEL === -1.0 &&
                             CORE.ENEMY_MELEE_RESET_MARGIN === 0.01;

            const stanceMulOk = CORE.stanceRecoilMultiplier(false, false, false) === 1.0 &&
                                CORE.stanceRecoilMultiplier(true, false, false) === 0.80 &&
                                CORE.stanceRecoilMultiplier(false, true, false) === 0.85 &&
                                CORE.stanceRecoilMultiplier(false, false, true) === 1.25;

            const kOut = { pitchKick: 0, yawKick: 0 };
            const kRes = CORE.effectiveRecoilKick(0.014, 0.006, 1.0, 1.0, 0.80, kOut);
            const kickOk = kRes === kOut &&
                           Math.abs(kOut.pitchKick - 0.014 * 0.80) < 1e-5 &&
                           Math.abs(kOut.yawKick - 0.006 * 0.80) < 1e-5;

            const nadeDelayOk = CORE.enemyInitialGrenadeDelay(5) === 3.0 &&
                                CORE.enemyInitialGrenadeDelay(1) === 6.0 &&
                                CORE.enemyInitialGrenadeDelay(0) === Infinity;

            const nadeCapOk = CORE.canSpawnEnemyGrenade(5, 6) === true &&
                              CORE.canSpawnEnemyGrenade(7, 6) === false;

            const gOut = { x: 0, y: 0, z: 0 };
            const gRes = CORE.enemyGrenadeVelocity(10, 0, 10, 12, 0.55, 0.5, 0.5, 1.2, gOut);
            const gVelOk = gRes === gOut && gOut.x > 0 && gOut.y > 0;

            const eyeOk = CORE.enemyEyeHeight(0, 0, 0.95, 0.5) === 1.45 &&
                          CORE.enemyEyeHeight(0, 2, 0.95, 0.5) === 0.95 * 1.25 + 0.5;

            const losJitOk = CORE.enemyLosTargetCoord(10, 0.5, 0.3) === 10;

            const meleeResetOk = CORE.isEnemyMeleeReset(-1.0, -1.0, 0.01) === false &&
                                 CORE.isEnemyMeleeReset(-1.02, -1.0, 0.01) === true;

            return constsOk && stanceMulOk && kickOk && nadeDelayOk && nadeCapOk &&
                   gVelOk && eyeOk && losJitOk && meleeResetOk;
        }""")
        checks.append(("tactical-stance-and-enemy-combat-balance-rules", stance_balance_check))

        # 66) Zero-alloc raycast hit pooling, medkit output mutation, GPU particle update throttling, and ammo relief counting (v115 perf win).
        perf_win_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            const pfxThrottleOk = CORE.shouldUpdatePfxLayer(1, 0, false) === true &&
                                  CORE.shouldUpdatePfxLayer(0, 1, false) === true &&
                                  CORE.shouldUpdatePfxLayer(0, 0, true) === true &&
                                  CORE.shouldUpdatePfxLayer(0, 0, false) === false;

            const blockerOk = CORE.isGrenadeLosBlocker(false, false, false, false, false) === true &&
                              CORE.isGrenadeLosBlocker(true, false, false, false, false) === false &&
                              CORE.isGrenadeLosBlocker(false, true, false, false, false) === false &&
                              CORE.isGrenadeLosBlocker(false, false, true, false, false) === false &&
                              CORE.isGrenadeLosBlocker(false, false, false, true, false) === false &&
                              CORE.isGrenadeLosBlocker(false, false, false, false, true) === false;

            const dirOut = { x: 0, z: 0 };
            const dirRes = CORE.enemyToPlayerDir(3, 4, 5, dirOut);
            const dirOk = dirRes === dirOut &&
                          Math.abs(dirOut.x - 0.6) < 1e-5 &&
                          Math.abs(dirOut.z - 0.8) < 1e-5;

            CORE.enemyToPlayerDir(0, 0, 0, dirOut);
            const dirZeroOk = dirOut.x === 0 && dirOut.z === 0;

            const medOut = { health: 0, armor: 0 };
            const medRes = CORE.medkitPickupRestore(50, 100, 10, 50, 1.0, medOut);
            const medOk = medRes === medOut && medOut.health > 50 && medOut.armor > 10;

            const wStateMock = [
                { ammo: 30, reserve: 60 },
                { ammo: 0, reserve: 0 },
                null
            ];
            const ownedMock = [0, 1, -1];
            const roundsOk = CORE.totalPlayerRounds(wStateMock, ownedMock) === 90 &&
                             CORE.hasPlayerRounds(wStateMock, ownedMock) === true;

            const emptyMock = [
                { ammo: 0, reserve: 0 },
                { ammo: 0, reserve: 0 }
            ];
            const emptyOk = CORE.totalPlayerRounds(emptyMock, [0, 1]) === 0 &&
                            CORE.hasPlayerRounds(emptyMock, [0, 1]) === false;

            return pfxThrottleOk && blockerOk && dirOk && dirZeroOk && medOk && roundsOk && emptyOk;
        }""")
        checks.append(("zero-alloc-raycast-hit-pooling-and-pfx-throttling-perf-rules", perf_win_check))

        # 67) Persistent blast scorch decals, shockwave expansion, and enemy muzzle light rules (v117 visual polish).
        visual_polish_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            const constsOk = CORE.SCORCH_MAX === 16 &&
                             CORE.SCORCH_LIFETIME === 24.0 &&
                             CORE.SCORCH_FADE_DURATION === 4.0 &&
                             CORE.SCORCH_BASE_RADIUS === 2.5 &&
                             CORE.SCORCH_BASE_OPACITY === 0.88 &&
                             CORE.SCORCH_STANDOFF === 0.016 &&
                             CORE.SCORCH_EXPANSION_DURATION === 0.10 &&
                             CORE.ENEMY_MUZZLE_LIGHT_COLOR === 0xff9944 &&
                             CORE.ENEMY_MUZZLE_LIGHT_INTENSITY === 3.2 &&
                             CORE.ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY === 4.5;

            const scaleStd = CORE.scorchScale(1.0, 0.5);
            const scaleThermite = CORE.scorchScale(0.45, 0.5);
            const scaleAir = CORE.scorchScale(1.4, 0.5);
            const scaleOk = scaleStd === 2.5 &&
                            scaleThermite === 2.5 * 0.65 &&
                            scaleAir === 2.5 * 1.4;

            const expInit = CORE.scorchScaleProgress(2.5, 0, 0.10);
            const expEnd = CORE.scorchScaleProgress(2.5, 0.10, 0.10);
            const expOk = expInit === 2.5 * 0.45 && expEnd === 2.5;

            const opFull = CORE.scorchOpacity(24.0, 4.0, 0.88);
            const opFade = CORE.scorchOpacity(2.0, 4.0, 0.88);
            const opZero = CORE.scorchOpacity(0, 4.0, 0.88);
            const opOk = opFull === 0.88 &&
                         Math.abs(opFade - 0.22) < 1e-4 &&
                         opZero === 0;

            const lifeStep = CORE.stepScorchLife(24.0, 1.0);
            const expFalse = CORE.isScorchExpired(23.0);
            const expTrue = CORE.isScorchExpired(0);
            const lifeOk = lifeStep === 23.0 && expFalse === false && expTrue === true;

            const rotOk = CORE.scorchRotation(0.5) === Math.PI;
            const elevOk = CORE.scorchElevation(0.5, 0, 0.016) === 0.016;

            const elpStd = CORE.enemyMuzzleLightParams(false);
            const elpElite = CORE.enemyMuzzleLightParams(true);
            const lightOk = elpStd.intensity === 3.2 && elpElite.intensity === 4.5 &&
                            elpStd.color === 0xff9944 && elpElite.color === 0xff9944;

            return constsOk && scaleOk && expOk && opOk && lifeOk && rotOk && elevOk && lightOk;
        }""")
        checks.append(("blast-scorch-and-enemy-muzzle-flash-visual-rules", visual_polish_check))

        # 68) Critical heartbeat, elite gunfire, and atmospheric air-absorption audio rules (v118 audio polish).
        audio_polish_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;
            const constsOk = CORE.HEARTBEAT_BPM_MIN === 72 &&
                             CORE.HEARTBEAT_BPM_MAX === 136 &&
                             CORE.AIR_ABSORPTION_MAX_FREQ === 8000 &&
                             CORE.AIR_ABSORPTION_MIN_FREQ === 500 &&
                             CORE.AIR_ABSORPTION_Q === 0.5;

            const bpmMin = CORE.heartbeatBpm(25, 100);
            const bpmMid = CORE.heartbeatBpm(12.5, 100);
            const bpmOk = bpmMin === 72 && bpmMid === 104;

            const intOk = Math.abs(CORE.heartbeatInterval(120) - 0.5) < 1e-5;

            const stepWait = CORE.stepHeartbeatTimer(0.5, 0.1, 72);
            const stepTrig = CORE.stepHeartbeatTimer(0.05, 0.1, 72);
            const stepOk = stepWait.ready === false && stepTrig.ready === true;

            const gateOk = CORE.shouldPlayHeartbeat(false, false, true) === true &&
                           CORE.shouldPlayHeartbeat(true, false, true) === false &&
                           CORE.shouldPlayHeartbeat(false, true, true) === false &&
                           CORE.shouldPlayHeartbeat(false, false, false) === false;

            const sndOk = CORE.heartbeatSound() === 'heartbeat' &&
                          CORE.enemyGunfireSound(false) === 'eshot' &&
                          CORE.enemyGunfireSound(true) === 'eshot_elite';

            const cut0 = CORE.spatialAudioCutoff(0, 55);
            const cut55 = CORE.spatialAudioCutoff(55, 55);
            const cutMid = CORE.spatialAudioCutoff(27.5, 55);
            const cutoffOk = cut0 === 8000 && cut55 === 500 && cutMid === 4250;

            const nearP = CORE.spatialAudioParams(0, 0, 0);
            const distP = CORE.spatialAudioParams(100, 0, 0);
            const paramsOk = nearP.cutoff === 8000 && distP.cutoff === 500;

            const recipesOk = typeof SOUND_RECIPES !== 'undefined' &&
                              Array.isArray(SOUND_RECIPES.heartbeat) &&
                              Array.isArray(SOUND_RECIPES.eshot_elite);

            const variedOk = typeof SOUND_VARIED !== 'undefined' &&
                             SOUND_VARIED.heartbeat === 1 &&
                             SOUND_VARIED.eshot_elite === 1;

            return constsOk && bpmOk && intOk && stepOk && gateOk && sndOk && cutoffOk && paramsOk && recipesOk && variedOk;
        }""")
        checks.append(("critical-heartbeat-elite-gunfire-and-air-absorption-audio-rules", audio_polish_check))

        # 69) Stance spread, blast camera shake, weapon headshots, and enemy accuracy balance rules (v119 balance tuning).
        balance_tuning_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;
            const constsOk = CORE.STANCE_SPREAD_CROUCH === 0.80 &&
                             CORE.STANCE_SPREAD_SLIDE === 1.25 &&
                             CORE.STANCE_SPREAD_AIRBORNE_PENALTY === 0.80 &&
                             CORE.EXPLOSION_KICK_MAX_DIST === 20.0 &&
                             CORE.EXPLOSION_POST_KICK_MAX === 0.80 &&
                             CORE.EXPLOSION_SHOT_KICK_MAX === 1.4 &&
                             CORE.EXPLOSION_SHOT_KICK_CAP === 2.0 &&
                             CORE.HEADSHOT_MUL_SR === 2.4 &&
                             CORE.HEADSHOT_MUL_BR === 2.0 &&
                             CORE.HEADSHOT_MUL_AR === 1.8 &&
                             CORE.HEADSHOT_MUL_SMG === 1.5 &&
                             CORE.ENEMY_ACCURACY_FALLOFF_DIST === 16.0 &&
                             CORE.ENEMY_ACCURACY_MIN_FACTOR === 0.55;

            const stanceMulOk = CORE.stanceSpreadMultiplier(false, false) === 1.0 &&
                                CORE.stanceSpreadMultiplier(true, false) === 0.80 &&
                                CORE.stanceSpreadMultiplier(false, true) === 1.25 &&
                                CORE.stanceSpreadMultiplier(true, true) === 1.25;

            const spreadCrouch = CORE.effectiveSpread(0.02, 0, 0, false, 0.80);
            const spreadSlide = CORE.effectiveSpread(0.02, 0, 0, false, 1.25);
            const spreadOk = Math.abs(spreadCrouch - 0.016) < 1e-6 &&
                             Math.abs(spreadSlide - 0.025) < 1e-6;

            const kickIntNear = CORE.explosionKickIntensity(0, 20);
            const kickIntMid = CORE.explosionKickIntensity(10, 20);
            const kickIntFar = CORE.explosionKickIntensity(25, 20);
            const kickOk = kickIntNear === 1.0 && kickIntMid === 0.5 && kickIntFar === 0;

            const pkNear = CORE.explosionPostKick(0, 20, 0.80);
            const pkFar = CORE.explosionPostKick(30, 20, 0.80);
            const postKickOk = pkNear === 0.80 && pkFar === 0;

            const skNear = CORE.explosionShotKick(0, 20, 1.4);
            const skFar = CORE.explosionShotKick(30, 20, 1.4);
            const shotKickOk = skNear === 1.4 && skFar === 0;

            const applyKickOk = CORE.applyExplosionShotKick(0.5, 0.7, 2.0) === 1.2 &&
                                CORE.applyExplosionShotKick(1.5, 1.0, 2.0) === 2.0;

            const hsOk = CORE.weaponHeadshotMultiplier('SR') === 2.4 &&
                         CORE.weaponHeadshotMultiplier('BR') === 2.0 &&
                         CORE.weaponHeadshotMultiplier('AR') === 1.8 &&
                         CORE.weaponHeadshotMultiplier('SMG') === 1.5 &&
                         CORE.weaponHeadshotMultiplier('other', 1.9) === 1.9;

            const accNear = CORE.enemyDistanceAccuracy(0.60, 10, 16, 44, 0.55);
            const accFar = CORE.enemyDistanceAccuracy(0.60, 44, 16, 44, 0.55);
            const accBeyond = CORE.enemyDistanceAccuracy(0.60, 60, 16, 44, 0.55);
            const accOk = accNear === 0.60 &&
                          accFar === (0.60 * 0.55) &&
                          accBeyond === (0.60 * 0.55);

            return constsOk && stanceMulOk && spreadOk && kickOk && postKickOk && shotKickOk && applyKickOk && hsOk && accOk;
        }""")
        checks.append(("tactical-stance-spread-blast-kick-and-combat-accuracy-balance-rules", balance_tuning_check))

        # 70) Flashlight falloff, particle perspective, sentry rangefinding, shadow caster pooling & pickup opacity perf rules (v120 perf win).
        perf_win_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;
            const constsOk = CORE.FLASH_LIGHT_DECAY_EXPONENT === 2 &&
                             CORE.SENTRY_TARGET_ACQUIRE_EPSILON === 1e-4;

            const flStepOk = CORE.stepFlashLightLife(1.0, 0.25) === 0.75 &&
                             CORE.stepFlashLightLife(0.1, 0.5) === 0;

            const flIntPeak = CORE.flashLightIntensity(1.0, 1.0, 10.0);
            const flIntHalf = CORE.flashLightIntensity(0.5, 1.0, 10.0);
            const flIntZero = CORE.flashLightIntensity(0, 1.0, 10.0);
            const flIntOk = flIntPeak === 10.0 && Math.abs(flIntHalf - 2.5) < 1e-6 && flIntZero === 0;

            const pScale60 = CORE.particlePerspectiveScale(720, 60);
            const pScale90 = CORE.particlePerspectiveScale(720, 90);
            const pScaleOk = Math.abs(pScale60 - (720 / (2 * Math.tan(Math.PI / 6)))) < 1e-4 &&
                             Math.abs(pScale90 - (720 / (2 * Math.tan(Math.PI / 4)))) < 1e-4;

            const sentryRangeOk = CORE.isSentryTargetInRange(3, 4, 26) === true &&
                                  CORE.isSentryTargetInRange(3, 4, 25) === false &&
                                  CORE.isSentryTargetInRange(5, 5, 40) === false;

            const shadowPos = [{ x: 40, z: 0 }, { x: 2, z: 0 }, { x: 10, z: 0 }];
            const shadowOut = [];
            const shadowDists = [];
            const shadowKeep = CORE.shadowCasters(shadowPos, 0, 0, 2, shadowOut, shadowDists);
            const shadowPoolOk = shadowKeep === shadowOut &&
                                 shadowKeep.length === 2 &&
                                 shadowKeep[0] === 1 && shadowKeep[1] === 2;

            const maskOut = [];
            const shadowMask = CORE.buildShadowCasterMask(shadowKeep, 3, maskOut);
            const maskOk = shadowMask === maskOut &&
                           shadowMask.length === 3 &&
                           shadowMask[0] === false &&
                           shadowMask[1] === true &&
                           shadowMask[2] === true;

            const facingOut = { x: 0, z: 0 };
            const facingRes = CORE.planarFacingDirection(3, 4, facingOut);
            const facingOk = facingRes === facingOut &&
                             Math.abs(facingOut.x - 0.6) < 1e-6 &&
                             Math.abs(facingOut.z - 0.8) < 1e-6;

            const pickupThrottled = CORE.shouldUpdatePickupOpacity(5, 20, 1.0, 1.0) === false;
            const pickupFirstFrame = CORE.shouldUpdatePickupOpacity(0, 20, undefined, 1.0) === true;
            const pickupBlinkUpdated = CORE.shouldUpdatePickupOpacity(22, 20, 1.0, 0.8) === true;
            const pickupBlinkTiny = CORE.shouldUpdatePickupOpacity(22, 20, 0.80, 0.802) === false;
            const pickupOk = pickupThrottled && pickupFirstFrame && pickupBlinkUpdated && pickupBlinkTiny;

            return constsOk && flStepOk && flIntOk && pScaleOk && sentryRangeOk && shadowPoolOk && maskOk && facingOk && pickupOk;
        }""")
        checks.append(("flashlight-particle-sentry-and-shadow-pooling-perf-rules", perf_win_check))

        # 71) Mobile touch layout sanitization, look delta clamping, pause/gameplay gating & empty control state rules (v121 mobile UI polish)
        mobile_ui_check = page.evaluate("""() => {
            const constsOk = CORE.TOUCH_MIN_CONTROL_SIZE === 44 &&
                             CORE.TOUCH_MAX_CONTROL_SIZE === 150 &&
                             CORE.TOUCH_DEFAULT_CONTROL_SIZE === 72 &&
                             CORE.TOUCH_MAX_LOOK_DELTA === 180;

            const sizeOk = CORE.clampTouchControlSize(72) === 72 &&
                           CORE.clampTouchControlSize(20) === 44 &&
                           CORE.clampTouchControlSize(200) === 150 &&
                           CORE.clampTouchControlSize(NaN) === 72;

            const coordOk = CORE.clampTouchLayoutCoord(50.123) === 50.12 &&
                            CORE.clampTouchLayoutCoord(-10) === 0 &&
                            CORE.clampTouchLayoutCoord(120) === 100;

            const posOk = CORE.sanitizeTouchLayoutPosition(null) === null &&
                          JSON.stringify(CORE.sanitizeTouchLayoutPosition({ left: -5, top: 110, size: 25 })) ===
                          JSON.stringify({ left: 0, top: 100, size: 44 });

            const dictRes = CORE.sanitizeTouchLayout({
                'tbtn-fire': { left: 60, top: 70, size: 90 },
                'invalid-id': { left: 50, top: 50, size: 50 }
            });
            const dictOk = dictRes['tbtn-fire'] && dictRes['tbtn-fire'].size === 90 && dictRes['invalid-id'] === undefined;

            const gameplayOk = CORE.isTouchGameplayEnabled(true, false, false, false) === true &&
                               CORE.isTouchGameplayEnabled(true, true, false, false) === false &&
                               CORE.isTouchGameplayEnabled(true, false, true, false) === false &&
                               CORE.isTouchGameplayEnabled(true, false, false, true) === false;

            const pauseOk = CORE.canTouchPause(true, false, false, false) === true &&
                            CORE.canTouchPause(true, false, false, true) === false &&
                            CORE.canTouchPause(true, true, false, false) === false;

            const lookOk = CORE.touchLookDelta(100, 80, 1.0) === 20 &&
                           CORE.touchLookDelta(300, 50, 1.0, 180) === 180 &&
                           CORE.touchLookDelta(50, 300, 1.0, 180) === -180 &&
                           CORE.touchLookDelta(NaN, 50) === 0;

            const emptyOk = CORE.isTouchControlEmpty('empty') === true &&
                            CORE.isTouchControlEmpty('cooldown') === true &&
                            CORE.isTouchControlEmpty('locked') === true &&
                            CORE.isTouchControlEmpty('ready') === false;

            return constsOk && sizeOk && coordOk && posOk && dictOk && gameplayOk && pauseOk && lookOk && emptyOk;
        }""")
        checks.append(("mobile-touch-layout-sanitization-look-delta-and-empty-state-rules", mobile_ui_check))

        # 72) Blood pool seep expansion, settled corpse gore pooling, and textured bullet decal visual rules (v122 visual polish).
        blood_pool_visual_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.bloodPoolScale !== 'function' ||
                typeof CORE.bloodPoolScaleProgress !== 'function' ||
                typeof CORE.bloodPoolOpacity !== 'function' ||
                typeof CORE.stepBloodPoolLife !== 'function' ||
                typeof CORE.isBloodPoolExpired !== 'function' ||
                typeof CORE.bloodPoolRotation !== 'function' ||
                typeof CORE.bloodPoolElevation !== 'function' ||
                typeof CORE.canSpawnBloodPool !== 'function') {
                return false;
            }

            const constsOk = CORE.BLOOD_POOL_MAX === 16 &&
                             CORE.BLOOD_POOL_LIFETIME === 24.0 &&
                             CORE.BLOOD_POOL_FADE_DURATION === 4.0 &&
                             CORE.BLOOD_POOL_BASE_SIZE === 1.35 &&
                             CORE.BLOOD_POOL_HEAD_MUL === 1.35 &&
                             CORE.BLOOD_POOL_BASE_OPACITY === 0.88 &&
                             CORE.BLOOD_POOL_STANDOFF === 0.012 &&
                             CORE.BLOOD_POOL_EXPANSION_DURATION === 1.2 &&
                             CORE.BLOOD_POOL_SPAWN_MAX_DIST === 60.0;

            const scaleStd = CORE.bloodPoolScale(false, 0.5);
            const scaleHs = CORE.bloodPoolScale(true, 0.5);
            const scaleOk = Math.abs(scaleStd - 1.35) < 1e-4 &&
                            Math.abs(scaleHs - (1.35 * 1.35)) < 1e-4;

            const initProg = CORE.bloodPoolScaleProgress(2.0, 0, 1.2);
            const fullProg = CORE.bloodPoolScaleProgress(2.0, 1.2, 1.2);
            const progOk = Math.abs(initProg - 0.5) < 1e-4 && fullProg === 2.0;

            const fullOp = CORE.bloodPoolOpacity(24.0, 4.0, 0.88);
            const halfOp = CORE.bloodPoolOpacity(2.0, 4.0, 0.88);
            const zeroOp = CORE.bloodPoolOpacity(0, 4.0, 0.88);
            const opOk = fullOp === 0.88 && Math.abs(halfOp - 0.22) < 1e-4 && zeroOp === 0;

            const lifeStep = CORE.stepBloodPoolLife(24.0, 1.0) === 23.0 &&
                             CORE.isBloodPoolExpired(23.0) === false &&
                             CORE.isBloodPoolExpired(0) === true;

            const rotElev = Math.abs(CORE.bloodPoolRotation(0.5) - Math.PI) < 1e-4 &&
                            CORE.bloodPoolElevation(0, 0.012) === 0.012;

            const spawnOk = CORE.canSpawnBloodPool(true, false, 25.0, 60.0) === true &&
                            CORE.canSpawnBloodPool(false, false, 25.0, 60.0) === false &&
                            CORE.canSpawnBloodPool(true, true, 25.0, 60.0) === false &&
                            CORE.canSpawnBloodPool(true, false, 80.0, 60.0) === false;

            return constsOk && scaleOk && progOk && opOk && lifeStep && rotElev && spawnOk;
        }""")
        checks.append(("blood-pool-seep-and-textured-bullet-decal-visual-rules", blood_pool_visual_check))

        # 73) Suppressed weapon gunfire, armor plate insert/lock, flashbang tinnitus, and flesh hurt audio rules (v123 audio polish).
        audio_polish_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.weaponFireSound !== 'function' ||
                typeof CORE.plateInsertSound !== 'function' ||
                typeof CORE.plateLockSound !== 'function' ||
                typeof CORE.tinnitusSound !== 'function' ||
                typeof CORE.shouldTriggerTinnitus !== 'function' ||
                typeof CORE.tinnitusVolume !== 'function' ||
                typeof CORE.shouldPlayFleshHurt !== 'function' ||
                typeof CORE.playerDamageAcoustics !== 'function') {
                return false;
            }

            const constsOk = CORE.TINNITUS_MIN_THRESHOLD === 0.4 &&
                             CORE.TINNITUS_MAX_DURATION === 4.0 &&
                             CORE.TINNITUS_BASE_GAIN === 0.15;

            const unsuppressedOk = CORE.weaponFireSound('AR') === 'shot' &&
                                   CORE.weaponFireSound('SMG') === 'smg' &&
                                   CORE.weaponFireSound('BR') === 'br' &&
                                   CORE.weaponFireSound('SR') === 'sniper' &&
                                   CORE.weaponFireSound('') === 'shot';

            const suppressedOk = CORE.weaponFireSound('AR', true) === 'shot_suppressed' &&
                                 CORE.weaponFireSound('SMG', true) === 'smg_suppressed' &&
                                 CORE.weaponFireSound('BR', true) === 'br_suppressed' &&
                                 CORE.weaponFireSound('SR', true) === 'sniper_suppressed' &&
                                 CORE.weaponFireSound('', true) === 'shot_suppressed';

            const plateSndOk = CORE.plateInsertSound() === 'plate_insert' &&
                               CORE.plateLockSound() === 'plate_lock';

            const tinnitusTrigOk = CORE.tinnitusSound() === 'tinnitus' &&
                                   CORE.shouldTriggerTinnitus(1.5, 0, 0.4) === true &&
                                   CORE.shouldTriggerTinnitus(0.2, 0, 0.4) === false &&
                                   CORE.shouldTriggerTinnitus(1.5, 1.0, 0.4) === false &&
                                   Math.abs(CORE.tinnitusVolume(2.0, 4.0, 0.15) - 0.075) < 1e-4 &&
                                   CORE.tinnitusVolume(0, 4.0, 0.15) === 0;

            const hurtGatingOk = CORE.shouldPlayFleshHurt(0) === false &&
                                 CORE.shouldPlayFleshHurt(15) === true &&
                                 CORE.shouldPlayFleshHurt(undefined) === true;

            const dmgAcoustics = CORE.playerDamageAcoustics(0, 'block');
            const dmgOk = dmgAcoustics && dmgAcoustics.armorSound === 'block' && dmgAcoustics.playHurt === false;

            const recipesOk = typeof SOUND_RECIPES === 'object' &&
                              Array.isArray(SOUND_RECIPES.shot_suppressed) &&
                              Array.isArray(SOUND_RECIPES.smg_suppressed) &&
                              Array.isArray(SOUND_RECIPES.br_suppressed) &&
                              Array.isArray(SOUND_RECIPES.sniper_suppressed) &&
                              Array.isArray(SOUND_RECIPES.plate_insert) &&
                              Array.isArray(SOUND_RECIPES.plate_lock) &&
                              Array.isArray(SOUND_RECIPES.tinnitus);

            const variedOk = typeof SOUND_VARIED === 'object' &&
                             SOUND_VARIED.shot_suppressed === 1 &&
                             SOUND_VARIED.smg_suppressed === 1 &&
                             SOUND_VARIED.br_suppressed === 1 &&
                             SOUND_VARIED.sniper_suppressed === 1 &&
                             SOUND_VARIED.plate_insert === 1 &&
                             SOUND_VARIED.plate_lock === 1 &&
                             SOUND_VARIED.tinnitus === 1;

            const gapsOk = typeof SND_MIN_GAP === 'object' &&
                           SND_MIN_GAP.shot_suppressed === 0.045 &&
                           SND_MIN_GAP.plate_insert === 0.3 &&
                           SND_MIN_GAP.tinnitus === 1.5;

            return constsOk && unsuppressedOk && suppressedOk && plateSndOk &&
                   tinnitusTrigOk && hurtGatingOk && dmgOk && recipesOk && variedOk && gapsOk;
        }""")
        checks.append(("suppressed-weapon-armor-plate-and-tinnitus-audio-rules", audio_polish_check))

        # 74) Tactical combat balance, target evasion, backstab execution, and weapon falloff rules (v124 balance tuning).
        combat_balance_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined' ||
                typeof CORE.weaponFalloffParams !== 'function' ||
                typeof CORE.weaponDistanceFalloff !== 'function' ||
                typeof CORE.isMeleeBackstab !== 'function' ||
                typeof CORE.playerMeleeDamage !== 'function' ||
                typeof CORE.enemyTargetEvasionMultiplier !== 'function' ||
                typeof CORE.enemyEffectiveAccuracy !== 'function') {
                return false;
            }

            const falloffConstsOk = CORE.FALLOFF_SMG_KNEE === 0.38 &&
                                    CORE.FALLOFF_SMG_MIN_MUL === 0.45 &&
                                    CORE.FALLOFF_AR_KNEE === 0.58 &&
                                    CORE.FALLOFF_AR_MIN_MUL === 0.65 &&
                                    CORE.FALLOFF_BR_KNEE === 0.72 &&
                                    CORE.FALLOFF_BR_MIN_MUL === 0.78 &&
                                    CORE.FALLOFF_SR_KNEE === 0.85 &&
                                    CORE.FALLOFF_SR_MIN_MUL === 0.90;

            const meleeConstsOk = CORE.MELEE_BACKSTAB_MUL === 2.4 &&
                                  CORE.MELEE_SLIDE_MOMENTUM_MUL === 1.30 &&
                                  CORE.MELEE_SPRINT_MOMENTUM_MUL === 1.15 &&
                                  CORE.MELEE_BACKSTAB_COS_THRESHOLD === 0.50;

            const evasionConstsOk = CORE.ENEMY_EVASION_SPRINT_MUL === 0.82 &&
                                    CORE.ENEMY_EVASION_TAC_SPRINT_MUL === 0.70 &&
                                    CORE.ENEMY_EVASION_SLIDE_MUL === 0.75 &&
                                    CORE.ENEMY_EVASION_CROUCH_MUL === 0.85 &&
                                    CORE.ENEMY_EVASION_AIRBORNE_MUL === 0.80;

            const smgP = CORE.weaponFalloffParams('SMG');
            const arP = CORE.weaponFalloffParams('AR');
            const brP = CORE.weaponFalloffParams('BR');
            const srP = CORE.weaponFalloffParams('SR');
            const paramsOk = smgP.kneeFrac === 0.38 && smgP.minMul === 0.45 &&
                             arP.kneeFrac === 0.58 && arP.minMul === 0.65 &&
                             brP.kneeFrac === 0.72 && brP.minMul === 0.78 &&
                             srP.kneeFrac === 0.85 && srP.minMul === 0.90;

            const smgClose = CORE.weaponDistanceFalloff('SMG', 10, 80);
            const smgFar = CORE.weaponDistanceFalloff('SMG', 80, 80);
            const falloffOk = smgClose === 1.0 && Math.abs(smgFar - 0.45) < 1e-4;

            const bsHit = CORE.isMeleeBackstab(0, 1, 0, 0, -1, 0, 0);
            const frontHit = CORE.isMeleeBackstab(0, -1, 0, 0, 1, 0, 0);
            const flankHit = CORE.isMeleeBackstab(1, 0, 0, -1, 0, 0, 0);
            const bsOk = bsHit === true && frontHit === false && flankHit === false;

            const bsDmg = CORE.playerMeleeDamage(150, true, false, false);
            const slideDmg = CORE.playerMeleeDamage(150, false, true, false);
            const sprintDmg = CORE.playerMeleeDamage(150, false, false, true);
            const stdDmg = CORE.playerMeleeDamage(150, false, false, false);
            const dmgOk = bsDmg === 360 && slideDmg === 195 && sprintDmg === 172.5 && stdDmg === 150;

            const evaSlide = CORE.enemyTargetEvasionMultiplier(false, false, true, false, false);
            const evaTac = CORE.enemyTargetEvasionMultiplier(true, true, false, false, false);
            const evaSprint = CORE.enemyTargetEvasionMultiplier(true, false, false, false, false);
            const evaAir = CORE.enemyTargetEvasionMultiplier(false, false, false, false, true);
            const evaCrouch = CORE.enemyTargetEvasionMultiplier(false, false, false, true, false);
            const evaStand = CORE.enemyTargetEvasionMultiplier(false, false, false, false, false);
            const evaOk = evaSlide === 0.75 && evaTac === 0.70 && evaSprint === 0.82 &&
                          evaAir === 0.80 && evaCrouch === 0.85 && evaStand === 1.0;

            const effAccSlide = CORE.enemyEffectiveAccuracy(0.6, 0.75);
            const effAccClamp = CORE.enemyEffectiveAccuracy(1.0, 1.2);
            const accOk = Math.abs(effAccSlide - 0.45) < 1e-4 && effAccClamp === 1.0;

            return falloffConstsOk && meleeConstsOk && evasionConstsOk && paramsOk &&
                   falloffOk && bsOk && dmgOk && evaOk && accOk;
        }""")
        checks.append(("tactical-combat-balance-and-evasion-rules", combat_balance_check))

        # 75) v125 Performance optimization: spatial audio range culling, aim assist forward sector gating,
        # enemy separation overlap pre-check, grenade pooling, and wall buy offer pooling.
        perf_optimization_v125_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Spatial audio range culling and output pooling
            const range1 = CORE.isSpatialAudioInRange(0, 0, 50) === true;
            const range2 = CORE.isSpatialAudioInRange(30, 40, 50) === true;
            const range3 = CORE.isSpatialAudioInRange(31, 40, 50) === false;
            const rangeOk = range1 && range2 && range3;

            const audioOut = {};
            const inRangeRes = CORE.spatialAudioParams(10, 0, 0, 50, audioOut);
            const inRangeOk = (inRangeRes === audioOut) && audioOut.audible === true && audioOut.dist === 10;
            const outRangeRes = CORE.spatialAudioParams(60, 0, 0, 50, audioOut);
            const outRangeOk = (outRangeRes === audioOut) && audioOut.audible === false && audioOut.dist === 60;

            // 2. Aim assist forward sector gating
            const fwdDotOk = CORE.AIM_ASSIST_FORWARD_MIN_DOT === 0.0;
            const fwdOk = CORE.isAimCandidateInForwardSector(0, 1, 0, 10) === true;
            const behindOk = CORE.isAimCandidateInForwardSector(0, 1, 0, -10) === false;
            const flankOk = CORE.isAimCandidateInForwardSector(0, 1, 10, 0) === false;
            const angleThreshOk = CORE.isAngleWithinThreshold(0.8, 0.5) === true &&
                                  CORE.isAngleWithinThreshold(0.3, 0.5) === false;

            // 3. Enemy separation AABB overlap pre-check
            const overlap1 = CORE.canEnemiesOverlap(0, 0, 0.85, 1.0, 0, 0.85) === true;
            const overlap2 = CORE.canEnemiesOverlap(0, 0, 0.85, 2.0, 0, 0.85) === false;
            const overlap3 = CORE.canEnemiesOverlap(0, 0, 0.85, 0, 1.6, 0.85) === true;
            const overlap4 = CORE.canEnemiesOverlap(0, 0, 0.85, 0, 1.8, 0.85) === false;
            const overlapOk = overlap1 && overlap2 && overlap3 && overlap4;

            // 4. Grenade pooling rules
            const poolConstOk = CORE.GRENADE_POOL_MAX === 12;
            const rec1 = CORE.canRecycleGrenade(0, false) === true;
            const rec2 = CORE.canRecycleGrenade(1.5, false) === false;
            const rec3 = CORE.canRecycleGrenade(1.5, true) === true;
            const rec4 = CORE.canRecycleGrenade(5, 12) === true;
            const rec5 = CORE.canRecycleGrenade(12, 12) === false;
            const recOk = rec1 && rec2 && rec3 && rec4 && rec5;

            // 5. Wall buy offer with pre-allocated out object
            const offerOut = {};
            const buyRes = CORE.wallBuyOffer([0, 1], 2, 'ar', 0, 120, offerOut);
            const buyOk = (buyRes === offerOut) && offerOut.action === 'buy';
            const ammoRes = CORE.wallBuyOffer([0, 1], 1, 'smg', 60, 120, offerOut);
            const ammoOk = (ammoRes === offerOut) && offerOut.action === 'ammo';
            const fullRes = CORE.wallBuyOffer([0, 1], 1, 'smg', 120, 120, offerOut);
            const fullOk = (fullRes === offerOut) && offerOut.action === 'full' && offerOut.price === 0;

            return rangeOk && inRangeOk && outRangeOk && fwdDotOk && fwdOk && behindOk && flankOk &&
                   angleThreshOk && overlapOk && poolConstOk && recOk && buyOk && ammoOk && fullOk;
        }""")
        checks.append(("spatial-audio-aim-assist-enemy-separation-and-offer-pooling-perf-rules", perf_optimization_v125_check))

        # 76) v126 Mobile UI polish: downed control states, touch pause button states, editor selection,
        # streak HUD positioning, and virtual joystick indicator rules.
        mobile_ui_polish_v126_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Downed control states and labels
            const slideDownedStateOk = CORE.touchSlideState(false, false, false, true) === 'locked';
            const slideDownedLabelOk = CORE.touchSlideLabel(false, false, true) === 'CRAWL';
            const plateDownedStateOk = CORE.touchPlateState(3, 3, 3, false, true) === 'locked';
            const plateDownedLabelOk = CORE.touchPlateLabel('locked', 3, true) === 'LOCKED';
            const meleeDownedOk = CORE.canPlayerMelee(false, true, 0) === false &&
                                  CORE.canPlayerMelee(false, false, 0) === true;
            const meleeDownedStateOk = CORE.touchMeleeState(0, 1.0, true) === 'locked';
            const meleeDownedLabelOk = CORE.touchMeleeLabel('locked', 0, true) === 'LOCKED';
            const downedOk = slideDownedStateOk && slideDownedLabelOk && plateDownedStateOk &&
                             plateDownedLabelOk && meleeDownedOk && meleeDownedStateOk && meleeDownedLabelOk;

            // 2. Touch pause button state, label, and change detection
            const pauseStateReady = CORE.touchPauseState(true, false, false, false) === 'ready';
            const pauseStatePaused = CORE.touchPauseState(true, true, false, false) === 'paused';
            const pauseStateEditing = CORE.touchPauseState(true, false, false, true) === 'editing';
            const pauseStateDead = CORE.touchPauseState(true, false, true, false) === 'dead';
            const pauseLabelReady = CORE.touchPauseLabel('ready') === 'II';
            const pauseLabelPaused = CORE.touchPauseLabel('paused') === 'PLAY';
            const pauseLabelEditing = CORE.touchPauseLabel('editing') === 'EDIT';
            const pauseLabelDead = CORE.touchPauseLabel('dead') === '--';
            const cache = { state: 'ready', label: 'II' };
            const noChange = CORE.touchPauseChanged(cache, 'ready', 'II') === false;
            const hasChange = CORE.touchPauseChanged(cache, 'paused', 'PLAY') === true;
            CORE.syncTouchPauseState(cache, 'paused', 'PLAY');
            const syncOk = cache.state === 'paused' && cache.label === 'PLAY';
            const pauseOk = pauseStateReady && pauseStatePaused && pauseStateEditing && pauseStateDead &&
                            pauseLabelReady && pauseLabelPaused && pauseLabelEditing && pauseLabelDead &&
                            noChange && hasChange && syncOk;

            // 3. Touch layout editor selection and streak HUD safe area
            const editorSelOk = CORE.isTouchControlSelected('tbtn-fire', 'tbtn-fire') === true &&
                                CORE.isTouchControlSelected('tbtn-ads', 'tbtn-fire') === false;
            const streakRight = CORE.streakHudPosition(true, false);
            const streakLeft = CORE.streakHudPosition(true, true);
            const streakOk = streakRight.top === 'calc(96px + var(--sa-t))' &&
                             streakRight.side === 'right' && streakRight.inset === 'calc(16px + var(--sa-r))' &&
                             streakLeft.top === 'calc(96px + var(--sa-t))' &&
                             streakLeft.side === 'left' && streakLeft.inset === 'calc(16px + var(--sa-l))';

            // 4. Virtual joystick indicator rules
            const crawlTier = CORE.joystickMoveSpeedTier(0.5, true) === 'crawl';
            const sprintTier = CORE.joystickMoveSpeedTier(0.8, false) === 'sprint';
            const walkTier = CORE.joystickMoveSpeedTier(0.5, false) === 'walk';
            const idleTier = CORE.joystickMoveSpeedTier(0.05, false) === 'idle';
            const crawlClass = CORE.joystickIndicatorClass('crawl') === 'crawl';
            const sprintClass = CORE.joystickIndicatorClass('sprint') === 'sprint';
            const walkClass = CORE.joystickIndicatorClass('walk') === 'walk';
            const idleClass = CORE.joystickIndicatorClass('idle') === '';
            const joyOk = crawlTier && sprintTier && walkTier && idleTier &&
                          crawlClass && sprintClass && walkClass && idleClass;

            return downedOk && pauseOk && editorSelOk && streakOk && joyOk;
        }""")
        checks.append(("mobile-downed-state-pause-and-editor-polish-rules", mobile_ui_polish_v126_check))

        # 77) Visual polish: sentry muzzle kinematics, penetration cover impact, and melee surface strike rules.
        visual_polish_v127_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Sentry muzzle kinematics & lighting parameters
            const offsetOk = CORE.SENTRY_MUZZLE_FORWARD_OFFSET === 0.85 &&
                             CORE.SENTRY_MUZZLE_HEIGHT_OFFSET === 0.60;
            const mPos = CORE.sentryMuzzlePosition(10, 0, 20, 0);
            const mPosOk = Math.abs(mPos.x - 10) < 1e-4 &&
                           Math.abs(mPos.y - 0.60) < 1e-4 &&
                           Math.abs(mPos.z - (20 - 0.85)) < 1e-4;
            const dir = CORE.sentryShootDirection(0, 0, 0, 5, 0, 0);
            const dirOk = Math.abs(dir.x - 1.0) < 1e-4 && Math.abs(dir.y) < 1e-4 && Math.abs(dir.z) < 1e-4;
            const lp = CORE.sentryMuzzleLightParams();
            const lightOk = lp.color === 0xffaa44 && lp.intensity === 2.8 && lp.distance === 8.0 && lp.duration === 0.06;

            // 2. Through-cover penetration visual impact gating
            const penCoverOk = CORE.shouldSpawnPenetrationCoverVfx(0.75, 4.0, 10.0) === true &&
                               CORE.shouldSpawnPenetrationCoverVfx(1.0, 4.0, 10.0) === false &&
                               CORE.shouldSpawnPenetrationCoverVfx(0.75, 12.0, 10.0) === false;

            // 3. Melee world surface strike gating
            const meleeStrikeOk = CORE.canMeleeStrikeWorld(-1, 1.8, 2.2) === true &&
                                  CORE.canMeleeStrikeWorld(0, 1.8, 2.2) === false &&
                                  CORE.canMeleeStrikeWorld(-1, 2.8, 2.2) === false;

            return offsetOk && mPosOk && dirOk && lightOk && penCoverOk && meleeStrikeOk;
        }""")
        checks.append(("sentry-muzzle-vfx-and-combat-penetration-visual-rules", visual_polish_v127_check))

        # 78) Audio polish: melee combat impact acoustics, penetration hitmarker sound, tactical sprint footsteps, and heavy landing rules.
        audio_polish_v128_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Melee impact acoustics
            const meleeHitOk = CORE.MELEE_HIT_SOUND === 'melee_hit' &&
                               CORE.MELEE_BACKSTAB_SOUND === 'melee_backstab' &&
                               CORE.meleeHitSound(true) === 'melee_backstab' &&
                               CORE.meleeHitSound(false) === 'melee_hit';

            // 2. Through-cover penetration hitmarker acoustics
            const hitmarkerOk = CORE.hitmarkerSound('cover', false) === 'hit_cover' &&
                                CORE.hitmarkerSound('cover', true) === 'headshot' &&
                                CORE.hitmarkerSound('block', false) === 'block' &&
                                CORE.hitmarkerSound('kill', false) === null &&
                                CORE.hitmarkerSound('hit', false) === 'hit';

            // 3. Tactical sprint athletic footstep acoustics
            const footstepOk = CORE.playerFootstepSound(false, true) === 'step_tac' &&
                               CORE.playerFootstepSound(true, true) === 'step_crouch' &&
                               CORE.playerFootstepSound(false, false) === 'step';

            // 4. Heavy fall-damage landing shock acoustics
            const landingOk = CORE.landingSound(true) === 'land_heavy' &&
                              CORE.landingSound(false) === 'land';

            // 5. Sound recipes registered in SOUND_RECIPES and SOUND_VARIED
            const recipesOk = typeof SOUND_RECIPES !== 'undefined' &&
                              Boolean(SOUND_RECIPES.melee_hit) &&
                              Boolean(SOUND_RECIPES.melee_backstab) &&
                              Boolean(SOUND_RECIPES.hit_cover) &&
                              Boolean(SOUND_RECIPES.step_tac) &&
                              Boolean(SOUND_RECIPES.land_heavy);

            const variedOk = typeof SOUND_VARIED !== 'undefined' &&
                             SOUND_VARIED.melee_hit === 1 &&
                             SOUND_VARIED.melee_backstab === 1 &&
                             SOUND_VARIED.hit_cover === 1 &&
                             SOUND_VARIED.step_tac === 1 &&
                             SOUND_VARIED.land_heavy === 1;

            return meleeHitOk && hitmarkerOk && footstepOk && landingOk && recipesOk && variedOk;
        }""")
        checks.append(("melee-impact-penetration-hitmarker-and-locomotion-audio-rules", audio_polish_v128_check))

        # 79) Balance tuning: damage-type armor mitigation, fall-damage bypass, and weapon handling agility rules.
        combat_balance_v129_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Damage-type armor absorption ratios
            const ratioOk = CORE.ARMOR_ABSORB_RATIO_BULLET === 0.65 &&
                            CORE.ARMOR_ABSORB_RATIO_BLAST === 0.75 &&
                            CORE.ARMOR_ABSORB_RATIO_MELEE === 0.50 &&
                            CORE.ARMOR_ABSORB_RATIO_FALL === 0.00 &&
                            CORE.armorAbsorbRatioForType('bullet') === 0.65 &&
                            CORE.armorAbsorbRatioForType('blast') === 0.75 &&
                            CORE.armorAbsorbRatioForType('melee') === 0.50 &&
                            CORE.armorAbsorbRatioForType('fall') === 0.00;

            // 2. Armor damage resolution
            const rBul = CORE.resolveArmorDamage(20, 50, undefined, 'bullet');
            const bulOk = rBul.absorbed === 13 && rBul.absorbedDamage === 13 && rBul.healthDamage === 7 && rBul.remainingArmor === 37;
            const rBlast = CORE.resolveArmorDamage(40, 50, undefined, 'blast');
            const blastOk = rBlast.absorbed === 30 && rBlast.absorbedDamage === 30 && rBlast.healthDamage === 10 && rBlast.remainingArmor === 20;
            const rFall = CORE.resolveArmorDamage(30, 50, undefined, 'fall');
            const fallOk = rFall.absorbed === 0 && rFall.absorbedDamage === 0 && rFall.healthDamage === 30 && rFall.remainingArmor === 50;

            // 3. Weapon archetype switch speeds
            const swSpeedOk = CORE.WEAPON_SWITCH_SPEED_SMG === 4.6 &&
                              CORE.WEAPON_SWITCH_SPEED_AR === 3.6 &&
                              CORE.WEAPON_SWITCH_SPEED_BR === 3.0 &&
                              CORE.WEAPON_SWITCH_SPEED_SR === 2.4 &&
                              CORE.FAST_HANDS_SWITCH_MUL === 1.35 &&
                              CORE.weaponSwitchSpeed('SMG', false) === 4.6 &&
                              Math.abs(CORE.weaponSwitchSpeed('SMG', true) - 4.6 * 1.35) < 1e-4 &&
                              CORE.weaponSwitchSpeed('SR', false) === 2.4;

            // 4. Weapon archetype ADS speeds
            const adsSpeedOk = CORE.WEAPON_ADS_SPEED_SMG === 1.25 &&
                               CORE.WEAPON_ADS_SPEED_AR === 1.00 &&
                               CORE.WEAPON_ADS_SPEED_BR === 0.88 &&
                               CORE.WEAPON_ADS_SPEED_SR === 0.70 &&
                               CORE.weaponAdsSpeed('SMG') === 1.25 &&
                               CORE.weaponAdsSpeed('SR') === 0.70 &&
                               CORE.weaponAdsSpeed('AR', 1.5) === 1.5;

            return ratioOk && bulOk && blastOk && fallOk && swSpeedOk && adsSpeedOk;
        }""")
        checks.append(("tactical-armor-mitigation-and-weapon-agility-balance-rules", combat_balance_v129_check))

        # 80) Performance optimization: wave countdown & downed timer change-gating, blast radial culling, and zero-allocation ragdoll rules.
        perf_optimization_v130_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Wave countdown change gating & state tracking
            const cdInit = { active: false, sec: -1 };
            const cdChg1 = CORE.waveCountdownChanged(cdInit, true, 5);
            const cdSync1 = CORE.syncWaveCountdownState(cdInit, true, 5);
            const cdChg2 = CORE.waveCountdownChanged(cdInit, true, 5);
            const cdChg3 = CORE.waveCountdownChanged(cdInit, true, 4);
            const cdOk = cdChg1 === true && cdSync1.active === true && cdSync1.sec === 5 &&
                         cdChg2 === false && cdChg3 === true;

            // 2. Downed bleed-out timer change gating
            const dtInit = { downed: false, tenths: -1 };
            const dtChg1 = CORE.downedTimerChanged(dtInit, true, 8.42);
            const dtSync1 = CORE.syncDownedTimerState(dtInit, true, 8.42);
            const dtChg2 = CORE.downedTimerChanged(dtInit, true, 8.44);
            const dtChg3 = CORE.downedTimerChanged(dtInit, true, 8.31);
            const dtOk = dtChg1 === true && dtSync1.downed === true && dtSync1.tenths === 84 &&
                         dtChg2 === false && dtChg3 === true;

            // 3. Flash overlay opacity change gating
            const foOk = CORE.flashOverlayChanged(0.5, 0.502, 0.008) === false &&
                         CORE.flashOverlayChanged(0.5, 0.520, 0.008) === true;

            // 4. Blast radial spatial culling
            const radSq = 6.5 * 6.5;
            const blastOk = CORE.isTargetInBlastRadius(2, 0, 3, radSq) === true &&
                            CORE.isTargetInBlastRadius(6, 0, 4, radSq) === false;

            // 5. Zero-allocation ragdoll knockback & momentum rules
            const knockOut = { x: 0, z: 0 };
            const momOut = { x: 0, y: 0, z: 0 };
            const knockRes = CORE.soldierRagdollKnockback(10, 5, 6, 2, knockOut);
            const knockSame = knockRes === knockOut && Math.abs(knockOut.x - 3.2) < 1e-4 && Math.abs(knockOut.z - 2.4) < 1e-4;
            const momRes = CORE.soldierRagdollMomentum(4, -2, 2, 1, CORE.SOLDIER_RAGDOLL_MOMENTUM_SCALE, momOut);
            const momSame = momRes === momOut && Math.abs(momOut.x - (4 * 0.55 + 2)) < 1e-4 &&
                            Math.abs(momOut.z - (-2 * 0.55 + 1)) < 1e-4 && momOut.y === 0;

            return cdOk && dtOk && foOk && blastOk && knockSame && momSame;
        }""")
        checks.append(("countdown-downed-blast-and-ragdoll-perf-rules", perf_optimization_v130_check))

        # 81) Mobile UI polish: downed equipment, streaks, and station lockout gating rules.
        mobile_polish_v131_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Player capability gating during downed state
            const eqGateOk = CORE.canPlayerThrowEquipment(false, true, 2, 0) === false &&
                             CORE.canPlayerThrowEquipment(false, false, 2, 0) === true &&
                             CORE.canPlayerThrowEquipment(false, false, 0, 0) === false &&
                             CORE.canPlayerThrowEquipment(false, false, 2, 1.5) === false &&
                             CORE.canPlayerThrowEquipment(true, false, 2, 0) === false;

            const streakGateOk = CORE.canPlayerUseStreak(false, true, 1) === false &&
                                 CORE.canPlayerUseStreak(false, false, 1) === true &&
                                 CORE.canPlayerUseStreak(false, false, 0) === false;

            const fieldGateOk = CORE.canPlayerUseFieldUpgrade(false, true, 100, 100) === false &&
                                CORE.canPlayerUseFieldUpgrade(false, false, 100, 100) === true &&
                                CORE.canPlayerUseFieldUpgrade(false, false, 50, 100) === false;

            const stationGateOk = CORE.canPlayerInteractStation(false, true, true) === false &&
                                  CORE.canPlayerInteractStation(false, false, true) === true &&
                                  CORE.canPlayerInteractStation(false, false, false) === false;

            // 2. Mobile touch equipment button state & label
            const eqTouchOk = CORE.touchEquipmentState(2, false, true) === 'locked' &&
                              CORE.touchEquipmentState(2, false, false) === 'ready' &&
                              CORE.touchLethalLabel('frag', 2, false, true) === 'LOCKED' &&
                              CORE.touchLethalLabel('frag', 2, false, false) === 'FRAG' &&
                              CORE.touchTacticalLabel('flash', 2, true) === 'LOCKED' &&
                              CORE.touchTacticalLabel('flash', 2, false) === 'FLASH';

            // 3. Mobile touch streak button state & label
            const streakTouchOk = CORE.touchStreakState(true, false, true) === 'locked' &&
                                  CORE.touchStreakState(true, false, false) === 'streak' &&
                                  CORE.touchStreakLabel('uav', false, 0, true) === 'LOCKED' &&
                                  CORE.touchStreakLabel('uav', false, 0, false) === 'UAV';

            // 4. Mobile touch station USE button state & label
            const useTouchOk = CORE.touchUseState(true, true, false, true) === 'locked' &&
                               CORE.touchUseState(true, true, false, false) === 'ready' &&
                               CORE.touchUseLabel(true, true, false, 'armory', 'upgrade', true) === 'LOCKED' &&
                               CORE.touchUseLabel(true, true, false, 'armory', 'upgrade', false) === 'UPGRADE';

            // 5. Change detection for touch USE button with isDowned
            const useInit = { nearStation: null, canAfford: null, isHolding: null, stationKind: null, action: null, isDowned: null };
            const uChg1 = CORE.touchUseChanged(useInit, true, true, false, 'wall', 'buy', true);
            CORE.syncTouchUseState(useInit, true, true, false, 'wall', 'buy', true);
            const uChg2 = CORE.touchUseChanged(useInit, true, true, false, 'wall', 'buy', true);
            const uChg3 = CORE.touchUseChanged(useInit, true, true, false, 'wall', 'buy', false);
            const useChangeOk = uChg1 === true && useInit.isDowned === true && uChg2 === false && uChg3 === true;

            return eqGateOk && streakGateOk && fieldGateOk && stationGateOk &&
                   eqTouchOk && streakTouchOk && useTouchOk && useChangeOk;
        }""")
        checks.append(("mobile-downed-equipment-streaks-and-station-lockout-rules", mobile_polish_v131_check))

        # 82) Visual polish: tactical equipment detonation VFX & headshot ballistic impact rules.
        visual_polish_v132_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Tactical equipment flash light parameters
            const blindLight = CORE.tacticalFlashLightParams('blind');
            const stunLight = CORE.tacticalFlashLightParams('stun');
            const smokeLight = CORE.tacticalFlashLightParams('smoke');
            const lightOk = blindLight.color === CORE.TACTICAL_FLASH_LIGHT_BLIND_COLOR &&
                            blindLight.intensity === CORE.TACTICAL_FLASH_LIGHT_BLIND_INTENSITY &&
                            blindLight.distance === CORE.TACTICAL_FLASH_LIGHT_BLIND_DIST &&
                            blindLight.duration === CORE.TACTICAL_FLASH_LIGHT_BLIND_DUR &&
                            stunLight.color === CORE.TACTICAL_FLASH_LIGHT_STUN_COLOR &&
                            stunLight.intensity === CORE.TACTICAL_FLASH_LIGHT_STUN_INTENSITY &&
                            stunLight.distance === CORE.TACTICAL_FLASH_LIGHT_STUN_DIST &&
                            stunLight.duration === CORE.TACTICAL_FLASH_LIGHT_STUN_DUR &&
                            smokeLight.intensity === 0;

            // 2. Tactical equipment particle configuration
            const blindPfx = CORE.tacticalParticleParams('blind');
            const stunPfx = CORE.tacticalParticleParams('stun');
            const smokePfx = CORE.tacticalParticleParams('smoke');
            const pfxOk = blindPfx !== null && blindPfx.flashCount === 16 && blindPfx.sparkCount === 22 &&
                          stunPfx !== null && stunPfx.flashCount === 10 && stunPfx.sparkCount === 18 &&
                          smokePfx === null;

            // 3. Enemy helmet identification
            const helmetOk = CORE.enemyHasHelmet('rifleman') === true &&
                             CORE.enemyHasHelmet('tank') === true &&
                             CORE.enemyHasHelmet('shielded') === true &&
                             CORE.enemyHasHelmet('grenadier') === true &&
                             CORE.enemyHasHelmet('runner') === false &&
                             CORE.enemyHasHelmet('scout') === false &&
                             CORE.enemyHasHelmet('unknown') === false;

            // 4. Headshot VFX parameters
            const helmetVfx = CORE.headshotVfxParams(true);
            const bareVfx = CORE.headshotVfxParams(false);
            const headshotOk = helmetVfx.sparks === CORE.HEADSHOT_SPARK_COUNT_HELMET &&
                               helmetVfx.blood === CORE.HEADSHOT_BLOOD_MIST_HELMET &&
                               bareVfx.sparks === CORE.HEADSHOT_SPARK_COUNT_BARE &&
                               bareVfx.blood === CORE.HEADSHOT_BLOOD_MIST_BARE;

            return lightOk && pfxOk && helmetOk && headshotOk;
        }""")
        checks.append(("tactical-detonation-and-headshot-visual-rules", visual_polish_v132_check))

        # 83) Audio polish: tactical combat and locomotion acoustics rules.
        audio_polish_v133_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            const jumpSlide = CORE.jumpSound(true) === 'jump_slide' &&
                              CORE.jumpSound(false) === 'jump' &&
                              CORE.jumpSound() === 'jump';

            const chamberEmpty = CORE.chamberEmptySound(0) === 'chamber_empty' &&
                                 CORE.chamberEmptySound(1) === null &&
                                 CORE.chamberEmptySound(-1) === null;

            const grenadeAudio = CORE.grenadeCookSound() === 'pin' &&
                                 CORE.grenadeThrowSound(true, 'lethal', 'frag') === 'draw' &&
                                 CORE.grenadeThrowSound(false, 'lethal', 'frag') === 'pin' &&
                                 CORE.grenadeThrowSound(false, 'proximity', 'claymore') === 'claymore_plant';

            const enemyHit = CORE.enemyMeleeHitSound(true, false) === 'enemy_hit_heavy' &&
                             CORE.enemyMeleeHitSound(false, true) === 'enemy_hit_heavy' &&
                             CORE.enemyMeleeHitSound(false, false) === 'enemy_hit' &&
                             CORE.enemyMeleeHitSound() === 'enemy_hit';

            return jumpSlide && chamberEmpty && grenadeAudio && enemyHit;
        }""")
        checks.append(("tactical-combat-and-locomotion-acoustics-rules", audio_polish_v133_check))

        # 84) Tactical combat balance rules: weapon ADS strafe agility, empty reload penalty, bloom recovery & enemy melee.
        balance_tuning_v134_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            const adsMoveOk = CORE.weaponAdsMoveMultiplier('SMG') === 1.20 &&
                              CORE.weaponAdsMoveMultiplier('AR') === 1.00 &&
                              CORE.weaponAdsMoveMultiplier('BR') === 0.88 &&
                              CORE.weaponAdsMoveMultiplier('SR') === 0.70;

            const reloadOk = CORE.EMPTY_RELOAD_TIME_MUL === 1.15 &&
                             Math.abs(CORE.effectiveReloadDuration(2.0, 1.0, true) - 2.30) < 1e-4 &&
                             Math.abs(CORE.effectiveReloadDuration(2.0, 1.0, false) - 2.00) < 1e-4;

            const bloomOk = CORE.weaponBloomRecoveryMultiplier('SMG') === 1.30 &&
                            CORE.weaponBloomRecoveryMultiplier('AR') === 1.00 &&
                            CORE.weaponBloomRecoveryMultiplier('BR') === 0.85 &&
                            CORE.weaponBloomRecoveryMultiplier('SR') === 0.65;

            const enemyMeleeOk = Math.abs(CORE.enemyMeleeDamage(18, 2, 1, 1, false) - 28.4) < 1e-4 &&
                                 Math.abs(CORE.enemyMeleeDamage(18, 3, 1, 1, false) - 23.4) < 1e-4 &&
                                 Math.abs(CORE.enemyMeleeDamage(18, 4, 1, 1, false) - 14.4) < 1e-4 &&
                                 Math.abs(CORE.enemyMeleeDamage(18, 0, 1, 1, false) - 18.4) < 1e-4;

            return adsMoveOk && reloadOk && bloomOk && enemyMeleeOk;
        }""")
        checks.append(("tactical-weapon-agility-and-combat-balance-rules", balance_tuning_v134_check))

        # 85) Performance optimization: grenade charge HUD change-gating, tactical distance-squared culling, bullet magnetism dot-product selection, and cone range pre-check.
        perf_optimization_v135_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Grenade charge HUD change gating & label
            const st = { visible: false, pct: -1, speed: -1 };
            const g1 = CORE.grenadeChargeHudChanged(st, false, 0, 0) === false;
            const g2 = CORE.grenadeChargeHudChanged(st, true, 50, 14) === true;
            CORE.syncGrenadeChargeHudState(st, true, 50, 14);
            const g3 = st.visible === true && st.pct === 50 && st.speed === 14;
            const g4 = CORE.grenadeChargeHudChanged(st, true, 50, 14.2) === false;
            const g5 = CORE.grenadeChargeLabel(14, 50) === 'GRENADE 14 M/S (50%)';

            // 2. Tactical equipment radial distance-squared spatial culling
            const tac1 = CORE.isTargetInTacticalRadius(3, 4, 36) === true;
            const tac2 = CORE.isTargetInTacticalRadius(6, 0, 36) === false;

            // 3. Bullet magnetism unit-vector dot product selection
            const maxAng = 0.08;
            const minCos = CORE.bulletMagnetMinCos(maxAng);
            const mag1 = Math.abs(minCos - Math.cos(maxAng)) < 1e-6;
            const mag2 = CORE.isMagnetCandidateCloser(0.999, minCos) === true;
            const mag3 = CORE.isMagnetCandidateCloser(0.990, minCos) === false;

            // 4. Proximity ordnance cone range pre-check
            const cone1 = CORE.isTargetInConeRange(2, 2, 9) === true;
            const cone2 = CORE.isTargetInConeRange(3, 3, 9) === false;

            return g1 && g2 && g3 && g4 && g5 && tac1 && tac2 && mag1 && mag2 && mag3 && cone1 && cone2;
        }""")
        checks.append(("grenade-charge-tactical-culling-and-magnet-perf-rules", perf_optimization_v135_check))

        # 86) Mobile UI polish: downed weapon swap, ADS lockout gating, and reload state rules.
        mobile_ui_polish_v136_check = page.evaluate("""() => {
            if (typeof CORE === 'undefined') return false;

            // 1. Pure player capability gating
            const g1 = CORE.canPlayerSwitchWeapon(false, false, false) === true &&
                       CORE.canPlayerSwitchWeapon(true, false, false) === false &&
                       CORE.canPlayerSwitchWeapon(false, true, false) === false &&
                       CORE.canPlayerSwitchWeapon(false, false, true) === false;

            const g2 = CORE.canPlayerAds(false, false, false) === true &&
                       CORE.canPlayerAds(true, false, false) === false &&
                       CORE.canPlayerAds(false, true, false) === false &&
                       CORE.canPlayerAds(false, false, true) === false;

            // 2. Mobile touch weapon swap button state & label
            const wList = [{ type: 'AR' }, { type: 'SMG' }];
            const s1 = CORE.touchSwapState(0, [0, 1], false, true) === 'locked' &&
                       CORE.touchSwapState(0, [0, 1], false, false) === 'ready' &&
                       CORE.touchSwapState(0, [0, -1], false, false) === 'empty' &&
                       CORE.touchSwapState(0, [0, 1], true, false) === 'switching';

            const s2 = CORE.touchSwapLabel(0, [0, 1], wList, false, true) === 'LOCKED' &&
                       CORE.touchSwapLabel(0, [0, 1], wList, false, false) === 'SMG' &&
                       CORE.touchSwapLabel(0, [0, 1], wList, true, false) === 'DRAW' &&
                       CORE.touchSwapLabel(0, [0, -1], wList, false, false) === 'SWAP';

            // 3. Mobile touch ADS button state & label
            const a1 = CORE.touchAdsState(1.0, 'AR', 0.82, false, true) === 'locked' &&
                       CORE.touchAdsState(1.0, 'AR', 0.82, false, false) === 'active' &&
                       CORE.touchAdsState(1.0, 'SR', 0.82, false, false) === 'scoped' &&
                       CORE.touchAdsState(1.0, 'SR', 0.82, true, false) === 'steady' &&
                       CORE.touchAdsState(0, 'AR', 0.82, false, false) === '';

            const a2 = CORE.touchAdsLabel('locked', 'AR', 0, true) === 'LOCKED' &&
                       CORE.touchAdsLabel('active', 'AR', 0, false) === 'AIM' &&
                       CORE.touchAdsLabel('scoped', 'SR', 2.0, false) === 'SCOPE' &&
                       CORE.touchAdsLabel('scoped', 'SR', 0, false) === 'WAIT' &&
                       CORE.touchAdsLabel('steady', 'SR', 2.0, false) === 'STEADY' &&
                       CORE.touchAdsLabel('', 'AR', 0, false) === 'ADS';

            // 4. Mobile touch reload button state rules
            const r1 = CORE.touchReloadState(0, 0, false) === '' &&
                       CORE.touchReloadState(0, 60, false) === 'urgent' &&
                       CORE.touchReloadState(15, 60, true) === 'reloading' &&
                       CORE.touchReloadState(30, 60, false) === '';

            return g1 && g2 && s1 && s2 && a1 && a2 && r1;
        }""")
        checks.append(("mobile-downed-swap-ads-and-reload-polish-rules", mobile_ui_polish_v136_check))

        # 87) Clean console throughout gameplay.
        from probe_graphics import probe_graphics
        # Previous acceptance contexts have finished; retire their render loops
        # before the independent graphics UI run competes for software GPU time.
        for finished_context in list(browser.contexts):
            finished_context.close()
        probe_graphics(browser, args.build.resolve().as_uri(),
                       lambda name, ok, detail='': checks.append((name, bool(ok))), console_errors)
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
