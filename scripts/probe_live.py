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

        # 2) Real UI flow: DEPLOY -> gun-select -> first weapon card.
        page.click("#btn-start")
        checks.append(("gun-select-opened", page.evaluate("() => document.getElementById('gun-select').style.display === 'flex'")))
        page.wait_for_timeout(300)
        cards = page.evaluate("() => document.querySelectorAll('#gun-select .gun-card').length")
        checks.append(("weapon-cards-present", cards > 0))
        page.evaluate("() => document.querySelector('#gun-select .gun-card').click()")
        page.wait_for_timeout(500)

        # 3) Game started: start screen hidden, countdown then wave 1.
        checks.append(("start-screen-hidden", page.evaluate("() => document.getElementById('start-screen').style.display === 'none'")))
        checks.append(("enemies-spawned", wait_until(page, "() => typeof enemies !== 'undefined' && enemies.length > 0", 25)))

        # 4) Enemies move and are grounded near y=0.
        s1 = page.evaluate("() => enemies.map(e => [e.pos.x, e.pos.y, e.pos.z])")
        page.wait_for_timeout(1200)
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

        # 7) Clean console throughout gameplay.
        checks.append(("no-console-errors", len(console_errors) == 0))

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
