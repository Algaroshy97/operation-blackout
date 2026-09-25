#!/usr/bin/env python3
"""Headless verification: load the release build in Chromium, start the game
through the real UI flow (DEPLOY -> weapon card), and probe live gameplay state.

Usage: python3 scripts/probe_live.py [--build <path>] [--chromium <executable>]

The Chromium executable defaults to $CHROMIUM_PATH, then Playwright's bundled
browser, then /opt/pw-browsers/chromium. Rendering uses SwiftShader, so frame
rates are not representative — the probe checks behaviour, not performance.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BUILD = ROOT / "dist" / "Operation Blackout.html"
FALLBACK_CHROMIUM = Path("/opt/pw-browsers/chromium")
GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


def wait_until(page, expr, timeout_s=20):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if page.evaluate(expr):
                return True
        except Exception:
            pass
        page.wait_for_timeout(400)
    return False


def launch(p, chromium):
    if chromium:
        return p.chromium.launch(executable_path=str(chromium), headless=True, args=GL_ARGS)
    try:
        return p.chromium.launch(headless=True, args=GL_ARGS)
    except Exception:
        if FALLBACK_CHROMIUM.exists():
            return p.chromium.launch(executable_path=str(FALLBACK_CHROMIUM), headless=True, args=GL_ARGS)
        raise


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", type=Path, default=DEFAULT_BUILD)
    ap.add_argument("--chromium", type=Path, default=os.environ.get("CHROMIUM_PATH") or None)
    ap.add_argument("--quality", default="low", choices=["low", "medium", "high"])
    args = ap.parse_args()

    checks = []
    console_errors = []

    def check(name, ok):
        checks.append((name, bool(ok)))

    with sync_playwright() as p:
        browser = launch(p, args.chromium)
        ctx = browser.new_context(viewport={"width": 1280, "height": 720})
        ctx.add_init_script(
            "localStorage.setItem('operation-blackout.settings.v2', JSON.stringify({quality: '%s'}))" % args.quality
        )
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))
        page.goto(args.build.resolve().as_uri())

        # 1) Boot + asset preload gate.
        check("boot-three-loaded", page.evaluate("() => typeof THREE !== 'undefined'"))
        check("assets-preloaded", wait_until(page, "() => typeof assetsReady !== 'undefined' && assetsReady === true", 40))
        check("deploy-button-enabled", page.evaluate("() => !document.getElementById('btn-start').classList.contains('disabled')"))
        check("procedural-textures", page.evaluate("() => TEX_ALL.length >= 10 && !!TEX.brick.normalMap.image"))

        # 2) Real UI flow: DEPLOY -> gun-select -> first weapon card.
        page.click("#btn-start")
        check("gun-select-opened", page.evaluate("() => document.getElementById('gun-select').style.display === 'flex'"))
        page.wait_for_timeout(300)
        cards = page.evaluate("() => document.querySelectorAll('#gun-select .gun-card').length")
        check("primary-cards-exclude-carried", cards > 0 and cards == page.evaluate("() => CFG.weapons.filter(w => !w.sidearm && !w.carried).length"))
        page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
        page.wait_for_timeout(500)
        check("start-screen-hidden", page.evaluate("() => document.getElementById('start-screen').style.display === 'none'"))
        check("sniper-and-sidearm-carried", page.evaluate("() => CFG.weapons[weaponsOwned[1]].type === 'SR' && CFG.weapons[weaponsOwned[2]].sidearm === true"))

        # 3) Waves spawn; enemies move, stay grounded, and navigation has a flow field.
        check("enemies-spawned", wait_until(page, "() => typeof enemies !== 'undefined' && enemies.length > 0", 90))
        s1 = page.evaluate("() => enemies.map(e => [e.pos.x, e.pos.y, e.pos.z])")
        page.wait_for_timeout(2500)
        s2 = page.evaluate("() => enemies.map(e => [e.pos.x, e.pos.y, e.pos.z])")
        n = min(len(s1), len(s2))
        moved = any(abs(a[0] - b[0]) > 0.01 or abs(a[2] - b[2]) > 0.01 for a, b in zip(s1[:n], s2[:n]))
        check("enemies-move", moved)
        check("enemies-grounded", all(abs(y) < 1.0 for _, y, _ in s2))
        check("nav-flow-field", page.evaluate(
            "() => { let b = 0; for (let i = 0; i < NAV.blocked.length; i++) b += NAV.blocked[i]; const c = navCell(0, 20); return b > 100 && isFinite(NAV.dist[c]); }"))
        check("raycast-colliders-live", page.evaluate("() => typeof raycastColliders !== 'undefined' && raycastColliders.length > 50"))

        # 4) Firing: ammo drops, particles and tracers spawn.
        shot = page.evaluate("""() => {
            try {
                const before = wState[curWeapon].ammo;
                fireShot();
                return wState[curWeapon].ammo === before - 1;
            } catch (e) { return false; }
        }""")
        check("fireshot-runs", shot)
        page.wait_for_timeout(300)
        check("particles-alive", page.evaluate("() => PFX_ADD.alive + PFX_SMOKE.alive > 0 || vfx.tracers.length > 0"))

        # 5) Explosive barrel: ignite -> explode -> collider removed -> respawn on reset.
        page.evaluate("() => { godMode = true; damageBarrel(barrels[0], 999); }")
        check("barrel-explodes", wait_until(page, "() => barrels[0].state === 'gone' && colliders.indexOf(barrels[0].collider) < 0", 60))

        # 5b) Sniper: always carried, punches through a 0.8 m wall; the kill ragdolls and settles.
        wall = page.evaluate("""() => {
            switchWeapon(1);
            const e = spawnEnemy(1, 3.5, 3); e.state = 'spawn'; e.stateT = -1e9;
            animateEnemy(e, 0.016, 13); scene.updateMatrixWorld(true);
            camera.position.set(3.5, 1.7, 16); camera.rotation.set(-0.02, 0, 0, 'YXZ'); camera.updateMatrixWorld();
            adsAmount = 1; const s = curS(); s.chambered = true; s.cycleT = 0; s.nextShot = 0;
            const hp = e.health; fireShot(); window.__probeE = e;
            return curW().type === 'SR' && e.health < hp;
        }""")
        check("sniper-wallbang", wall)
        page.evaluate("() => damageEnemy(__probeE, 9999, __probeE.pos.clone().setY(1.2), false, new THREE.Vector3(0, 0, -1))")
        check("ragdoll-settles", wait_until(page, "() => __probeE.ragdoll && __probeE.ragdoll.asleep && __probeE.ragdoll.P[1] < 0.6", 60))

        # 6) Supply drop: open, pick with the keyboard, perk applied.
        page.evaluate("() => openPerkMenu()")
        check("perk-menu-opens", page.evaluate("() => perkMenuOpen() && document.getElementById('perk-menu').style.display === 'flex'"))
        page.keyboard.press("Digit1")
        page.wait_for_timeout(200)
        check("perk-picked", page.evaluate("() => !perkMenuOpen() && Object.keys(ownedPerks).length === 1"))

        # 7) Live quality switch rebuilds the post pipeline without errors.
        page.evaluate("() => applyQuality('medium')")
        page.wait_for_timeout(800)
        check("quality-switch", page.evaluate("() => QUALITY.postfx === true && (POST.enabled || POST.failed)"))
        page.evaluate("() => applyQuality('low')")
        page.wait_for_timeout(400)

        # 8) Clean console throughout gameplay.
        check("no-console-errors", len(console_errors) == 0)

        browser.close()

    passed = sum(1 for _, ok in checks if ok)
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
