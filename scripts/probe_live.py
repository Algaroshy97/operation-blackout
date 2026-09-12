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

        # 10) Clean console throughout gameplay.
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
