"""Real-browser verification for multi-touch, lifecycle, gyro, touch HUD editor, tabs, FPS cap & adaptive DPR."""
from __future__ import annotations

import functools
import http.server
import json
import socketserver
import threading
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STANDALONE_HTML = ROOT / "dist" / "Operation Blackout.html"
PWA_DIR = ROOT / "dist" / "pwa"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_http_server(directory: Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = ReusableTCPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def deploy_game(page) -> None:
    page.click("#btn-start")
    page.click("#gun-select .gun-card:not(.locked)")
    page.wait_for_function(
        "() => document.querySelector('#gun-select h2')?.textContent === 'SELECT SECONDARY'",
        timeout=15000,
    )
    page.click("#gun-select .gun-card:not(.locked)")
    page.wait_for_function("() => typeof started !== 'undefined' && started === true && !paused", timeout=20000)


class MobileBrowserFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not STANDALONE_HTML.is_file() or not (PWA_DIR / "index.html").is_file():
            raise RuntimeError("Run `python3 scripts/build.py .` before browser feature tests")
        cls.server, cls.base_url = start_http_server(PWA_DIR)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(
            headless=True,
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def new_context(self, **kwargs):
        context = self.browser.new_context(**kwargs)
        self.addCleanup(context.close)
        return context

    def test_01_standalone_file_url_offline_and_desktop_input(self) -> None:
        context = self.new_context(viewport={"width": 960, "height": 540}, has_touch=False)
        page = context.new_page()
        errors: list[str] = []
        external_urls: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("request", lambda req: external_urls.append(req.url) if not req.url.startswith("file://") and not req.url.startswith("data:") and not req.url.startswith("blob:") else None)

        page.goto(STANDALONE_HTML.resolve().as_uri(), wait_until="load", timeout=45000)
        page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=45000)

        defaults = page.evaluate(
            """() => ({
                isTouchBody: document.body.classList.contains('touch'),
                touchActive: touchState.active,
                gyroAim: getSetting('gyroAim'),
                fpsCap: getSetting('fpsCap'),
                showFps: getSetting('showFps'),
                adaptiveResolution: getSetting('adaptiveResolution'),
            })"""
        )
        self.assertFalse(defaults["isTouchBody"])
        self.assertFalse(defaults["touchActive"])
        self.assertEqual(defaults["gyroAim"], "off")
        self.assertEqual(defaults["fpsCap"], "uncapped")
        self.assertTrue(defaults["showFps"])
        self.assertFalse(defaults["adaptiveResolution"])

        deploy_game(page)

        page.wait_for_function("() => pointerLocked && !paused")
        before = page.evaluate("() => ({ x: player.pos.x, z: player.pos.z, mag: curS().ammo })")
        page.keyboard.down("KeyW")
        page.mouse.down(button="left")
        page.mouse.down(button="right")
        try:
            page.wait_for_function(
                "({x,z,mag}) => Math.hypot(player.pos.x-x, player.pos.z-z) > 0.25 && curS().ammo < mag",
                arg=before, timeout=20000,
            )
        except Exception as exc:
            state = page.evaluate("() => ({x: player.pos.x, z: player.pos.z, mag: curS().ammo, type: curW().type, gameT, pointerLocked, paused, keys: {...keys}, mouse1Down})")
            raise AssertionError(f"Desktop input did not reach gameplay: {before=}, {state=}, {errors=}") from exc
        page.mouse.up(button="right")
        page.mouse.up(button="left")
        page.keyboard.up("KeyW")
        after = page.evaluate("() => ({ x: player.pos.x, z: player.pos.z, mag: curS().ammo, wHeld: !!keys['KeyW'], m1: mouse1Down, m2: !!keys['Mouse2'] })")
        dist_moved = ((after["x"] - before["x"]) ** 2 + (after["z"] - before["z"]) ** 2) ** 0.5
        self.assertGreater(dist_moved, 0.25)
        self.assertLess(after["mag"], before["mag"])
        self.assertFalse(after["wHeld"])
        self.assertFalse(after["m1"])
        self.assertFalse(after["m2"])

        # Desktop reload + pause/blur lifecycle must clear held keys and leave no stuck fire/ADS/move
        page.keyboard.press("KeyR")
        page.wait_for_function("() => curS().reloading")
        page.keyboard.down("KeyW")
        page.mouse.down(button="left")
        page.evaluate("() => window.dispatchEvent(new Event('blur'))")
        after_blur = page.evaluate("() => ({ wHeld: !!keys['KeyW'], m1: mouse1Down, m2: !!keys['Mouse2'] })")
        self.assertFalse(after_blur["wHeld"])
        self.assertFalse(after_blur["m1"])
        self.assertFalse(after_blur["m2"])

        page.keyboard.down("KeyD")
        page.evaluate("() => pauseGame()")
        after_pause = page.evaluate("() => ({ paused, dHeld: !!keys['KeyD'], m1: mouse1Down })")
        self.assertTrue(after_pause["paused"])
        self.assertFalse(after_pause["dHeld"])
        self.assertFalse(after_pause["m1"])
        page.click("#btn-resume")
        self.assertFalse(page.evaluate("() => paused"))

        self.assertEqual(external_urls, [])
        self.assertEqual(errors, [])
        context.close()

    def test_02_multitouch_and_input_lifecycle_no_stuck_state(self) -> None:
        context = self.new_context(viewport={"width": 800, "height": 360}, has_touch=True, is_mobile=True)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        page.goto(f"{self.base_url}/index.html", wait_until="load", timeout=45000)
        page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=45000)
        deploy_game(page)

        # Simultaneous 4-finger multi-touch: joystick + look + ADS + fire
        snap = page.evaluate(
            """async () => {
                const mkTouch = (id, target, x, y) => new Touch({
                    identifier: id, target, clientX: x, clientY: y, pageX: x, pageY: y,
                    radiusX: 12, radiusY: 12, rotationAngle: 0, force: 1
                });
                const fireEv = (el, type, changed, all) => el.dispatchEvent(new TouchEvent(type, {
                    bubbles: true, cancelable: true, touches: all, targetTouches: changed, changedTouches: changed
                }));

                const joy = document.getElementById('joy-base');
                const look = document.getElementById('look-zone');
                const ads = document.getElementById('tbtn-ads');
                const fire = document.getElementById('tbtn-fire');
                const jr = joy.getBoundingClientRect();
                const lr = look.getBoundingClientRect();
                const ar = ads.getBoundingClientRect();
                const fr = fire.getBoundingClientRect();

                const tJoy = mkTouch(11, joy, jr.left + jr.width / 2, jr.top + jr.height / 2);
                const tLook = mkTouch(12, look, lr.left + lr.width * 0.4, lr.top + lr.height * 0.5);
                const tAds = mkTouch(13, ads, ar.left + ar.width / 2, ar.top + ar.height / 2);
                const tFire = mkTouch(14, fire, fr.left + fr.width / 2, fr.top + fr.height / 2);

                const pBefore = { x: player.pos.x, z: player.pos.z, yaw: player.yaw, mag: curS().ammo };

                fireEv(joy, 'touchstart', [tJoy], [tJoy]);
                fireEv(look, 'touchstart', [tLook], [tJoy, tLook]);
                fireEv(ads, 'touchstart', [tAds], [tJoy, tLook, tAds]);
                fireEv(fire, 'touchstart', [tFire], [tJoy, tLook, tAds, tFire]);

                const tJoyMove = mkTouch(11, joy, jr.left + jr.width / 2 + 12, jr.top + jr.height / 2 - 44);
                const tLookMove = mkTouch(12, look, lr.left + lr.width * 0.4 + 45, lr.top + lr.height * 0.5 - 12);
                fireEv(joy, 'touchmove', [tJoyMove], [tJoyMove, tLook, tAds, tFire]);
                fireEv(look, 'touchmove', [tLookMove], [tJoyMove, tLookMove, tAds, tFire]);

                const inputDeadline = performance.now() + 15000;
                // The first shot can land on a frame with very little movement.
                // Keep all four touches held until both gameplay effects occur.
                while ((curS().ammo >= pBefore.mag ||
                        Math.hypot(player.pos.x - pBefore.x, player.pos.z - pBefore.z) <= 0.15) &&
                       performance.now() < inputDeadline) {
                    await new Promise(requestAnimationFrame);
                }

                const during = {
                    moveZ: touchState.moveZ,
                    moveX: touchState.moveX,
                    ads: touchState.ads,
                    firing: touchState.firing,
                    mouse2: !!keys['Mouse2'],
                    yawDelta: Math.abs(player.yaw - pBefore.yaw),
                    magBefore: pBefore.mag,
                    magDuring: curS().ammo,
                    distMoved: Math.hypot(player.pos.x - pBefore.x, player.pos.z - pBefore.z),
                };

                // Cancel all touches via touchcancel (simulates incoming OS gesture / call)
                fireEv(fire, 'touchcancel', [tFire], [tJoyMove, tLookMove, tAds]);
                fireEv(ads, 'touchcancel', [tAds], [tJoyMove, tLookMove]);
                fireEv(look, 'touchcancel', [tLookMove], [tJoyMove]);
                fireEv(joy, 'touchcancel', [tJoyMove], []);

                const afterCancel = {
                    moveX: touchState.moveX,
                    moveZ: touchState.moveZ,
                    ads: touchState.ads,
                    firing: touchState.firing,
                    mouse1Down,
                };

                // Re-engage fire + ADS + joy, then trigger blur
                fireEv(joy, 'touchstart', [tJoyMove], [tJoyMove]);
                fireEv(ads, 'touchstart', [tAds], [tJoyMove, tAds]);
                fireEv(fire, 'touchstart', [tFire], [tJoyMove, tAds, tFire]);
                window.dispatchEvent(new Event('blur'));
                const afterBlur = {
                    moveX: touchState.moveX, moveZ: touchState.moveZ,
                    ads: touchState.ads, firing: touchState.firing,
                    mouse2: !!keys['Mouse2'], mouse1Down,
                };

                // Re-engage and trigger visibilitychange hidden=true
                fireEv(ads, 'touchstart', [tAds], [tAds]);
                fireEv(fire, 'touchstart', [tFire], [tAds, tFire]);
                const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                document.dispatchEvent(new Event('visibilitychange'));
                if (desc) Object.defineProperty(document, 'hidden', desc);
                else delete document.hidden;
                const afterHidden = {
                    ads: touchState.ads, firing: touchState.firing,
                    mouse2: !!keys['Mouse2'], mouse1Down,
                };

                // Reload check
                document.getElementById('tbtn-reload').dispatchEvent(new TouchEvent('touchstart', {
                    bubbles: true, cancelable: true, changedTouches: [mkTouch(21, document.getElementById('tbtn-reload'), 10, 10)], touches: [], targetTouches: []
                }));
                const reloadDeadline = performance.now() + 15000;
                while (!curS().reloading && performance.now() < reloadDeadline) {
                    await new Promise(requestAnimationFrame);
                }
                const reloadingStarted = !!curS().reloading;

                // Pause + clear state
                fireEv(fire, 'touchstart', [tFire], [tFire]);
                pauseGame();
                const afterPause = { paused, firing: touchState.firing, mouse1Down };
                document.getElementById('btn-resume').click();

                // Death + respawn clears inputs cleanly
                fireEv(ads, 'touchstart', [tAds], [tAds]);
                fireEv(fire, 'touchstart', [tFire], [tAds, tFire]);
                // A lethal hit can enter Second Wind instead. Exercise the
                // terminal death handler with both controls still held.
                killPlayer();
                const deadState = { dead: !!player.dead, firing: touchState.firing, ads: touchState.ads };
                defaultOnRespawn(player);
                const afterRespawn = {
                    dead: !!player.dead, firing: touchState.firing, ads: touchState.ads,
                    mouse1Down, mouse2: !!keys['Mouse2']
                };

                return { during, afterCancel, afterBlur, afterHidden, reloadingStarted, afterPause, deadState, afterRespawn };
            }"""
        )

        self.assertEqual(errors, [])
        self.assertGreater(snap["during"]["moveZ"], 0.3, snap)
        self.assertTrue(snap["during"]["ads"])
        self.assertTrue(snap["during"]["firing"])
        self.assertTrue(snap["during"]["mouse2"])
        self.assertGreater(snap["during"]["yawDelta"], 0.01)
        self.assertLess(snap["during"]["magDuring"], snap["during"]["magBefore"])
        self.assertGreater(snap["during"]["distMoved"], 0.15, snap)

        for cleared in (snap["afterCancel"], snap["afterBlur"], snap["afterHidden"]):
            self.assertFalse(cleared["firing"])
            self.assertFalse(cleared["ads"])
            self.assertFalse(cleared["mouse1Down"])

        self.assertTrue(snap["reloadingStarted"])
        self.assertTrue(snap["afterPause"]["paused"])
        self.assertFalse(snap["afterPause"]["firing"])
        self.assertFalse(snap["afterPause"]["mouse1Down"])
        self.assertTrue(snap["deadState"]["dead"])
        self.assertFalse(snap["deadState"]["firing"])
        self.assertFalse(snap["deadState"]["ads"])
        self.assertFalse(snap["afterRespawn"]["firing"])
        self.assertFalse(snap["afterRespawn"]["ads"])
        self.assertFalse(snap["afterRespawn"]["mouse1Down"])
        self.assertEqual(errors, [])
        context.close()

    def test_03_gyro_modes_orientations_migration_permissions_rebaseline(self) -> None:
        context = self.new_context(viewport={"width": 800, "height": 360}, has_touch=True, is_mobile=True)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        # Inject legacy boolean gyroAim + single gyroSensitivity before load
        page.add_init_script(
            """(() => {
                // This probe supplies synthetic readings, not a physical sensor.
                // Make the permission boundary explicit across Chromium versions.
                DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted');
                if (!sessionStorage.getItem('__legacy_seeded')) {
                    sessionStorage.setItem('__legacy_seeded', '1');
                    localStorage.setItem('blackout.settings.v1', JSON.stringify({ gyroAim: true, gyroSensitivity: 1.8 }));
                }
            })();"""
        )
        page.goto(f"{self.base_url}/index.html", wait_until="load", timeout=45000)
        page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=45000)

        migrated = page.evaluate(
            """() => ({
                gyroAim: getSetting('gyroAim'),
                hip: getSetting('gyroSensitivity'),
                ads: getSetting('gyroAdsSensitivity'),
            })"""
        )
        self.assertEqual(migrated["gyroAim"], "always")
        self.assertEqual(migrated["hip"], 1.8)
        self.assertAlmostEqual(migrated["ads"], 1.17)

        deploy_game(page)
        page.wait_for_function("() => gyroEnabled && touchGameplayEnabled()", timeout=10000)

        res = page.evaluate(
            """async () => {
                const sendGyro = (beta, gamma) => {
                    const ev = new Event('deviceorientation');
                    ev.beta = beta;
                    ev.gamma = gamma;
                    ev.alpha = 0;
                    window.dispatchEvent(ev);
                };
                const setAngle = (ang) => {
                    Object.defineProperty(screen.orientation, 'angle', {
                        configurable: true,
                        value: ang,
                    });
                };

                // Test ADS-only mode with 90 vs 270 landscape + rebaseline on ADS toggle & rotation
                setSetting('gyroAim', 'ads');
                setSetting('gyroSensitivity', 1.0);
                setSetting('gyroAdsSensitivity', 1.0);
                touchState.ads = false;
                keys['Mouse2'] = false;

                const yaw0 = touchState.lookX;
                sendGyro(10, 10);
                sendGyro(16, 15);
                const yawNoAds = touchState.lookX; // no input queued when not aiming

                // Engage ADS + verify first sample rebaselines (zero jump) and second sample moves
                setAngle(90);
                touchState.ads = true; keys['Mouse2'] = true;
                sendGyro(45, 20); // first sample -> rebaseline even after 35 deg change while idle!
                const yawAfterRebase = touchState.lookX;
                sendGyro(50, 20); // +5 beta delta in landscape 90
                applyTouchInput(); // drains touchState.lookX/lookY -> mouseX/mouseY
                const yaw90 = touchState.lookX === 0 ? mouseX : touchState.lookX;

                // Release ADS (should rebaseline) then switch to 270 orientation and re-engage
                touchState.ads = false; keys['Mouse2'] = false;
                applyTouchInput();
                mouseX = 0; mouseY = 0;
                setAngle(270);
                touchState.ads = true; keys['Mouse2'] = true;
                sendGyro(10, 5); // first sample after orientation flip -> rebaselines without jump!
                const jumpAfterFlip = Math.abs(touchState.lookX) + Math.abs(touchState.lookY);
                sendGyro(15, 5); // same +5 beta delta at 270 -> opposite sign vs 90!
                const look270 = touchState.lookX;

                // Switch to Always on and confirm hipfire responds + ADS uses ads sensitivity
                setSetting('gyroAim', 'always');
                setSetting('gyroSensitivity', 2.0);
                setSetting('gyroAdsSensitivity', 0.5);
                setAngle(90);
                touchState.ads = false; keys['Mouse2'] = false;
                touchState.lookX = 0;
                sendGyro(0, 0);
                sendGyro(4, 0);
                const hipLook = touchState.lookX;

                touchState.ads = true; keys['Mouse2'] = true;
                touchState.lookX = 0;
                sendGyro(4, 0);
                sendGyro(8, 0);
                const adsLook = touchState.lookX;

                // Permission denied case
                setSetting('gyroAim', 'off');
                const origReq = DeviceOrientationEvent.requestPermission;
                DeviceOrientationEvent.requestPermission = () => Promise.resolve('denied');
                setSetting('gyroAim', 'always');
                await new Promise((r) => setTimeout(r, 30));
                const deniedStatus = gyroStatus;
                if (origReq) DeviceOrientationEvent.requestPermission = origReq;
                else delete DeviceOrientationEvent.requestPermission;

                return {
                    movedWithoutAds: Math.abs(yawNoAds - yaw0),
                    movedOnRebaseSample: Math.abs(yawAfterRebase - yaw0),
                    look90Sample: yaw90,
                    jumpAfterFlip,
                    look270,
                    hipLook,
                    adsLook,
                    deniedStatus,
                };
            }"""
        )

        self.assertEqual(res["movedWithoutAds"], 0.0)
        self.assertEqual(res["movedOnRebaseSample"], 0.0)
        self.assertNotEqual(res["look90Sample"], 0.0, res)
        self.assertEqual(res["jumpAfterFlip"], 0.0)
        self.assertLess(res["look90Sample"] * res["look270"], 0.0, f"expected opposite signs at 90 vs 270: {res}")
        self.assertGreater(abs(res["hipLook"]), abs(res["adsLook"]) * 3.0)
        self.assertEqual(res["deniedStatus"], "denied")
        self.assertEqual(errors, [])
        context.close()

    def test_04_touch_hud_editor_drag_resize_opacity_safebounds_persist_reset(self) -> None:
        context = self.new_context(viewport={"width": 800, "height": 360}, has_touch=True, is_mobile=True)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        page.goto(f"{self.base_url}/index.html", wait_until="load", timeout=45000)
        page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=45000)

        page.click("#btn-settings")
        page.click("#settings-tab-touch")
        page.click("#btn-edit-touch-layout")
        page.wait_for_selector("#touch-editor-bar")

        edited = page.evaluate(
            """() => {
                // Inject simulated Xiaomi Mi 10T / Android safe area insets
                const root = document.documentElement.style;
                root.setProperty('--sa-l', '36px');
                root.setProperty('--sa-r', '24px');
                root.setProperty('--sa-t', '12px');
                root.setProperty('--sa-b', '20px');

                const fire = document.getElementById('tbtn-fire');
                const mkTouch = (id, target, x, y) => new Touch({
                    identifier: id, target, clientX: x, clientY: y, pageX: x, pageY: y,
                    radiusX: 10, radiusY: 10, rotationAngle: 0, force: 1
                });
                const r = fire.getBoundingClientRect();
                fire.dispatchEvent(new TouchEvent('touchstart', {
                    bubbles: true, cancelable: true,
                    changedTouches: [mkTouch(99, fire, r.left + r.width / 2, r.top + r.height / 2)],
                    touches: [], targetTouches: []
                }));
                // Drag past extreme bottom-right viewport edge (999, 999)
                window.dispatchEvent(new TouchEvent('touchmove', {
                    bubbles: true, cancelable: true,
                    changedTouches: [mkTouch(99, fire, 999, 999)],
                    touches: [], targetTouches: []
                }));
                window.dispatchEvent(new TouchEvent('touchend', {
                    bubbles: true, cancelable: true,
                    changedTouches: [mkTouch(99, fire, 999, 999)],
                    touches: [], targetTouches: []
                }));

                // Resize + opacity via real inputs
                const sz = document.getElementById('touch-editor-size');
                sz.value = '112';
                sz.dispatchEvent(new Event('input', { bubbles: true }));
                const op = document.getElementById('touch-editor-opacity');
                op.value = '0.55';
                op.dispatchEvent(new Event('input', { bubbles: true }));

                document.getElementById('touch-editor-done').click();
                const finalRect = fire.getBoundingClientRect();
                const saved = JSON.parse(localStorage.getItem('blackout.touch-layout.v1') || '{}');
                return {
                    rect: { left: finalRect.left, top: finalRect.top, right: finalRect.right, bottom: finalRect.bottom, width: finalRect.width },
                    opacity: Number(fire.style.opacity),
                    savedFire: saved['tbtn-fire'],
                };
            }"""
        )

        self.assertGreaterEqual(edited["rect"]["left"], 35.9)
        self.assertLessEqual(edited["rect"]["right"], 800 - 24 + 0.5)
        self.assertGreaterEqual(edited["rect"]["top"], 11.9)
        self.assertLessEqual(edited["rect"]["bottom"], 360 - 20 + 0.5)
        self.assertAlmostEqual(edited["rect"]["width"], 112.0, delta=1.5)
        self.assertAlmostEqual(edited["opacity"], 0.55, delta=0.02)
        self.assertEqual(edited["savedFire"]["size"], 112)
        self.assertAlmostEqual(edited["savedFire"]["opacity"], 0.55, delta=0.02)

        # Reload and confirm persisted size, opacity & bounds
        page.reload(wait_until="load", timeout=45000)
        page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=45000)
        persisted = page.evaluate(
            """() => {
                const fire = document.getElementById('tbtn-fire');
                const rect = fire.getBoundingClientRect();
                return { width: rect.width, opacity: Number(fire.style.opacity) };
            }"""
        )
        self.assertAlmostEqual(persisted["width"], 112.0, delta=1.5)
        self.assertAlmostEqual(persisted["opacity"], 0.55, delta=0.02)

        # Reset clears saved overrides
        page.click("#btn-settings")
        page.click("#settings-tab-touch")
        page.click("#btn-edit-touch-layout")
        page.click("#touch-editor-reset")
        page.click("#touch-editor-done")
        after_reset = page.evaluate(
            """() => ({
                stored: localStorage.getItem('blackout.touch-layout.v1'),
                inlineOpacity: document.getElementById('tbtn-fire').style.opacity,
            })"""
        )
        self.assertIn(after_reset["stored"], (None, "{}"))
        self.assertEqual(after_reset["inlineOpacity"], "")
        self.assertEqual(errors, [])
        context.close()

    def test_05_settings_tabs_aria_keyboard_fps_cap_display_and_adaptive_res(self) -> None:
        context = self.browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=2, has_touch=False)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        page.goto(f"{self.base_url}/index.html", wait_until="load", timeout=45000)
        page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=45000)

        page.click("#btn-settings")
        page.wait_for_selector("#settings-tabs")

        aria = page.evaluate(
            """() => {
                const tabs = [...document.querySelectorAll('#settings-tabs [role="tab"]')];
                const first = tabs[0];
                first.focus();
                first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
                const secondSelected = document.activeElement ? document.activeElement.id : null;
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
                const endSelected = document.activeElement ? document.activeElement.id : null;
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
                const homeSelected = document.activeElement ? document.activeElement.id : null;
                return {
                    tabCount: tabs.length,
                    selectedStatesAfterHome: tabs.map((t) => [t.id, t.getAttribute('aria-selected')]),
                    panelHiddenAfterHome: tabs.map((t) => [t.getAttribute('aria-controls'), document.getElementById(t.getAttribute('aria-controls')).hidden]),
                    secondSelected,
                    endSelected,
                    homeSelected,
                };
            }"""
        )
        self.assertGreaterEqual(aria["tabCount"], 3)
        self.assertEqual(aria["secondSelected"], "settings-tab-touch")
        self.assertEqual(aria["endSelected"], "settings-tab-gameplay")
        self.assertEqual(aria["homeSelected"], "settings-tab-controls")
        self.assertEqual(aria["panelHiddenAfterHome"][0][1], False)

        # Verify showFps toggle, fpsCap pacing vs game clock, and adaptive resolution bounds
        page.click("#btn-settings-back")
        deploy_game(page)

        perf_probe = page.evaluate(
            """() => {
                // 1. showFps toggle
                setSetting('showFps', false);
                const hiddenDisplay = document.getElementById('fps-counter').style.display;
                setSetting('showFps', true);
                const shownDisplay = document.getElementById('fps-counter').style.display;

                // 2. Step the real game loop at 60 Hz without depending on GPU
                // throughput. Count frames reaching the render boundary.
                const measureWindow = (capValue, start) => {
                    setSetting('fpsCap', capValue);
                    let renders = 0;
                    const origRender = renderFrame;
                    const origRaf = window.requestAnimationFrame;
                    const origTiming = [frame.lastRenderNow, frame.previousNow, lastT];
                    frame.lastRenderNow = start;
                    frame.previousNow = start;
                    renderFrame = () => renders++;
                    window.requestAnimationFrame = () => 0;
                    const gt0 = gameT;
                    try {
                        for (let i = 1; i <= 30; i++) frame(start + i * (1000 / 60));
                        return {renders, gtDelta: gameT - gt0};
                    } finally {
                        renderFrame = origRender;
                        window.requestAnimationFrame = origRaf;
                        [frame.lastRenderNow, frame.previousNow, lastT] = origTiming;
                    }
                };

                const start = performance.now();
                const uncapped = measureWindow('uncapped', start);
                const capped30 = measureWindow('30', start + 500);

                // 3. Adaptive resolution remains strictly opt-in until enabled, then clamps safely [0.6, dpr]
                const baselinePr = renderer.getPixelRatio();
                setSetting('adaptiveResolution', true);
                const stepDown = CORE.computeAdaptivePixelRatio(baselinePr, 18, window.devicePixelRatio || 1, getSetting('quality'), false, 'uncapped', 0);
                const stepFloor = CORE.computeAdaptivePixelRatio(0.6, 12, window.devicePixelRatio || 1, getSetting('quality'), false, 'uncapped', 0);
                renderer.setPixelRatio(stepDown.pixelRatio);
                const reducedPr = renderer.getPixelRatio();
                setSetting('adaptiveResolution', false);
                const restoredPr = renderer.getPixelRatio();

                return { hiddenDisplay, shownDisplay, uncapped, capped30, baselinePr, reducedPr, stepFloorPr: stepFloor.pixelRatio, restoredPr };
            }"""
        )

        self.assertEqual(errors, [])
        self.assertEqual(perf_probe["hiddenDisplay"], "none")
        self.assertEqual(perf_probe["shownDisplay"], "")
        self.assertEqual(perf_probe["uncapped"]["renders"], 30, perf_probe)
        self.assertEqual(perf_probe["capped30"]["renders"], 15, perf_probe)
        self.assertAlmostEqual(perf_probe["uncapped"]["gtDelta"], 0.5)
        self.assertAlmostEqual(perf_probe["capped30"]["gtDelta"], 0.5)
        self.assertGreaterEqual(perf_probe["stepFloorPr"], 0.6)
        self.assertLess(perf_probe["reducedPr"], perf_probe["baselinePr"])
        self.assertEqual(perf_probe["restoredPr"], perf_probe["baselinePr"])
        self.assertEqual(errors, [])
        context.close()


if __name__ == "__main__":
    unittest.main()
