#!/usr/bin/env python3
"""Real-browser regression probe for cold first-shot freeze (muted and unmuted)."""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "dist" / "Operation Blackout.html"


def run_cold_first_shot(browser, mobile: bool, muted: bool) -> dict:
    ctx = browser.new_context(
        viewport={"width": 800, "height": 360} if mobile else {"width": 1280, "height": 720},
        has_touch=mobile,
        is_mobile=mobile,
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    if muted:
        page.add_init_script("localStorage.setItem('blackout.settings.v1', JSON.stringify({ muted: true }));")

    page.goto(BUILD.resolve().as_uri())
    page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=30000)

    page.evaluate("""() => {
        window.__shotProbe = { frames: [], shots: [] };
        const gl = renderer.getContext();
        const origCompile = gl.compileShader.bind(gl);
        const origLink = gl.linkProgram.bind(gl);
        let compileCount = 0, linkCount = 0;
        gl.compileShader = function(s) { compileCount++; return origCompile(s); };
        gl.linkProgram = function(p) { linkCount++; return origLink(p); };
        window.__glCounts = () => ({ compileCount, linkCount });

        const origFire = fireShot;
        window.fireShot = function(...args) {
            const t0 = performance.now();
            const r = origFire.apply(this, args);
            window.__shotProbe.shots.push({
                fireShotMs: performance.now() - t0,
                shotBufReady: !!(_sndBuffers && _sndBuffers.shot),
            });
            return r;
        };
        const origRender = renderFrame;
        window.renderFrame = function(dt) {
            const c0 = window.__glCounts();
            const p0 = renderer.info.programs ? renderer.info.programs.length : -1;
            const t0 = performance.now();
            const r = origRender.apply(this, arguments);
            const c1 = window.__glCounts();
            const p1 = renderer.info.programs ? renderer.info.programs.length : -1;
            window.__shotProbe.frames.push({
                t: performance.now(),
                renderMs: performance.now() - t0,
                shots: window.__shotProbe.shots.length,
                progBefore: p0,
                progAfter: p1,
                compiles: c1.compileCount - c0.compileCount,
                links: c1.linkCount - c0.linkCount,
            });
            if (window.__shotProbe.frames.length > 120) window.__shotProbe.frames.shift();
            return r;
        };
    }""")

    page.click("#btn-start")
    page.click("#gun-select .gun-card:not(.locked)")
    page.wait_for_function("() => document.querySelector('#gun-select h2')?.textContent === 'SELECT SECONDARY'", timeout=10000)
    page.click("#gun-select .gun-card:nth-child(2)")
    page.wait_for_function("() => typeof started !== 'undefined' && started === true", timeout=15000)
    page.wait_for_timeout(500)

    before_state = page.evaluate("""() => ({
        muzzleLightInScene: !!(typeof muzzleLight !== 'undefined' && muzzleLight && muzzleLight.parent === scene && muzzleLight.intensity === 0),
        programsBefore: renderer.info.programs ? renderer.info.programs.length : -1,
        decalPoolCount: typeof DECAL !== 'undefined' ? DECAL.pool.length : 0,
    })""")

    page.evaluate("() => { window.__shotProbe.frames.length = 0; }")
    if mobile:
        page.evaluate("""() => {
            const btn = document.getElementById('tbtn-fire');
            const r = btn.getBoundingClientRect();
            const t = new Touch({ identifier: 201, target: btn, clientX: r.left + r.width/2, clientY: r.top + r.height/2 });
            btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
            btn.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
        }""")
    else:
        page.evaluate("() => { mouse1Down = true; requestAnimationFrame(() => { mouse1Down = false; }); }")

    page.wait_for_timeout(200)
    shot1 = page.evaluate("""() => {
        const fs = window.__shotProbe.frames;
        const shotFrames = fs.filter(f => f.shots >= 1);
        return {
            shotCount: window.__shotProbe.shots.length,
            fireShotMs: window.__shotProbe.shots[0] ? window.__shotProbe.shots[0].fireShotMs : null,
            shotBufReady: window.__shotProbe.shots[0] ? window.__shotProbe.shots[0].shotBufReady : false,
            maxRenderMs: shotFrames.length ? Math.max(...shotFrames.map(f => f.renderMs)) : null,
            totalCompiles: fs.reduce((s, f) => s + f.compiles, 0),
            totalLinks: fs.reduce((s, f) => s + f.links, 0),
            programsAfter: renderer.info.programs ? renderer.info.programs.length : -1,
            tracerCount: vfx.tracers.length,
            casingCount: casings.length,
            hasTracerOrCasingOrDecal: (vfx.tracers.length + casings.length + DECAL.live.length) > 0,
            muzzleLightIntensity: muzzleLight ? muzzleLight.intensity : -1,
        };
    }""")

    # Follow-up shot 2
    page.evaluate("() => { window.__shotProbe.frames.length = 0; }")
    if mobile:
        page.evaluate("""() => {
            const btn = document.getElementById('tbtn-fire');
            const r = btn.getBoundingClientRect();
            const t = new Touch({ identifier: 202, target: btn, clientX: r.left + r.width/2, clientY: r.top + r.height/2 });
            btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
            btn.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
        }""")
    else:
        page.evaluate("() => { mouse1Down = true; requestAnimationFrame(() => { mouse1Down = false; }); }")

    page.wait_for_timeout(200)
    shot2 = page.evaluate("""() => {
        const fs = window.__shotProbe.frames;
        return {
            shotCount: window.__shotProbe.shots.length,
            fireShotMs: window.__shotProbe.shots[1] ? window.__shotProbe.shots[1].fireShotMs : null,
            maxRenderMs: fs.length ? Math.max(...fs.map(f => f.renderMs)) : null,
            totalCompiles: fs.reduce((s, f) => s + f.compiles, 0),
        };
    }""")

    ctx.close()
    return {
        "mobile": mobile,
        "muted": muted,
        "errors": errors,
        "before": before_state,
        "shot1": shot1,
        "shot2": shot2,
    }


class ColdFirstShotTests(unittest.TestCase):
    def test_cold_first_shot_has_no_shader_compile_stall_or_duplicate_effects(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                for mobile in (False, True):
                    for muted in (False, True):
                        with self.subTest(mobile=mobile, muted=muted):
                            res = run_cold_first_shot(browser, mobile=mobile, muted=muted)
                            print("FIRST_SHOT_PROBE", json.dumps(res), flush=True)
                            self.assertEqual(res["errors"], [])
                            self.assertTrue(res["before"]["muzzleLightInScene"],
                                            "muzzleLight must be pre-mounted at intensity 0 before first shot")
                            self.assertEqual(res["shot1"]["shotCount"], 1, "must fire exactly one shot (no duplicates)")
                            self.assertEqual(res["shot1"]["casingCount"], 1, "must spawn one casing on single shot")
                            self.assertEqual(res["shot1"]["totalCompiles"], 0,
                                             "cold first shot must not trigger synchronous GL shader compilation")
                            self.assertEqual(res["shot1"]["totalLinks"], 0,
                                             "cold first shot must not trigger synchronous GL program linking")
                            self.assertEqual(res["before"]["programsBefore"], res["shot1"]["programsAfter"],
                                             "program count must remain stable across first shot")
                            self.assertLess(res["shot1"]["maxRenderMs"], 150.0,
                                            f"Shot 1 renderMs {res['shot1']['maxRenderMs']}ms too high")
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
