"""End-to-end build and real-browser lifecycle tests for the installable PWA."""
from __future__ import annotations

import functools
import http.server
import json
import shutil
import socketserver
import struct
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BUILD_SCRIPT = ROOT / "scripts" / "build.py"

SAVE_KEYS = {
    "blackout.settings.v1": json.dumps({"gyroAim": "ads", "gyroSensitivity": 1.35, "fpsCap": "60"}),
    "blackout.stats.v1": json.dumps({"kills": 42, "wins": 3}),
    "blackout.save.v1": json.dumps({"wave": 4, "score": 1950}),
    "ob_loadouts_v1": json.dumps({"active": 1, "slots": [{"primary": "m4a1"}]}),
    "ob_cosmetics_v1": json.dumps({"skin": "obsidian"}),
    "blackout.touch-layout.v1": json.dumps({"fire": {"left": 82, "top": 64, "size": 1.1, "opacity": 0.85}}),
}


def read_png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    width, height = struct.unpack(">II", data[16:24])
    return width, height


class OutageAwareHandler(http.server.SimpleHTTPRequestHandler):
    outage_paths: set[str] = set()
    full_outage: bool = False

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if self.full_outage or path in self.outage_paths:
            self.send_response(503, "Service Unavailable")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"origin unavailable")
            return
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_http_server(directory: Path):
    class BoundHandler(OutageAwareHandler):
        outage_paths = set()
        full_outage = False

    handler = functools.partial(BoundHandler, directory=str(directory))
    server = ReusableTCPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, BoundHandler, f"http://127.0.0.1:{server.server_address[1]}"


def stage_temp_project(dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for sub in ("src", "vendor", "assets"):
        shutil.copytree(ROOT / sub, dest / sub)


def deploy_from_menu(page) -> None:
    page.wait_for_function("() => typeof assetsReady !== 'undefined' && assetsReady === true", timeout=45000)
    btn_text = page.locator("#btn-start").text_content()
    assert btn_text and "DEPLOY" in btn_text, f"deploy button not ready: {btn_text}"
    page.click("#btn-start")
    page.click("#gun-select .gun-card:not(.locked)")
    page.wait_for_function(
        "() => document.querySelector('#gun-select h2')?.textContent === 'SELECT SECONDARY'",
        timeout=15000,
    )
    page.click("#gun-select .gun-card:not(.locked)")
    page.wait_for_function("() => typeof started !== 'undefined' && started === true && !paused", timeout=20000)


class PwaBuildTests(unittest.TestCase):
    def test_pwa_bundle_deterministic_and_manifest_valid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out1 = tmp_path / "dist1" / "Operation Blackout.html"
            pwa1 = tmp_path / "pwa1"
            out2 = tmp_path / "dist2" / "Operation Blackout.html"
            pwa2 = tmp_path / "pwa2"

            subprocess.run(
                ["python3", str(BUILD_SCRIPT), str(ROOT), "--output", str(out1), "--pwa-dir", str(pwa1)],
                check=True,
                cwd=ROOT,
            )
            subprocess.run(
                ["python3", str(BUILD_SCRIPT), str(ROOT), "--output", str(out2), "--pwa-dir", str(pwa2)],
                check=True,
                cwd=ROOT,
            )

            required = [
                "index.html",
                "manifest.webmanifest",
                "sw.js",
                "icons/icon-192.png",
                "icons/icon-512.png",
                "icons/icon-maskable-512.png",
            ]
            for rel in required:
                self.assertTrue((pwa1 / rel).is_file(), f"missing {rel} in pwa output")
                self.assertEqual((pwa1 / rel).read_bytes(), (pwa2 / rel).read_bytes(), f"{rel} not deterministic")

            standalone_html = out1.read_text(encoding="utf-8")
            self.assertNotIn("manifest.webmanifest", standalone_html)
            self.assertNotIn("serviceWorker", standalone_html)

            manifest = json.loads((pwa1 / "manifest.webmanifest").read_text(encoding="utf-8"))
            self.assertEqual(manifest.get("display"), "standalone")
            self.assertEqual(manifest.get("start_url"), "./index.html")
            self.assertEqual(manifest.get("scope"), "./")
            self.assertTrue(manifest.get("name"))
            self.assertTrue(manifest.get("short_name"))

            self.assertEqual(read_png_size(pwa1 / "icons/icon-192.png"), (192, 192))
            self.assertEqual(read_png_size(pwa1 / "icons/icon-512.png"), (512, 512))
            self.assertEqual(read_png_size(pwa1 / "icons/icon-maskable-512.png"), (512, 512))

    def test_pwa_install_offline_update_preserves_saves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            proj_dir = tmp_path / "proj"
            stage_temp_project(proj_dir)
            serve_dir = tmp_path / "serve"
            out_html = tmp_path / "Operation Blackout.html"
            subprocess.run(
                ["python3", str(BUILD_SCRIPT), str(proj_dir), "--output", str(out_html), "--pwa-dir", str(serve_dir)],
                check=True,
                cwd=ROOT,
            )
            sw_v1 = (serve_dir / "sw.js").read_text(encoding="utf-8")
            self.assertIn("ob-pwa-", sw_v1)

            server, handler_cls, base_url = start_http_server(serve_dir)
            server_closed = False
            try:
                with sync_playwright() as p:
                    browser = p.chromium.launch(
                        headless=True,
                        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
                    )
                    context = browser.new_context(viewport={"width": 800, "height": 360})
                    page = context.new_page()
                    errors: list[str] = []
                    page.on("pageerror", lambda err: errors.append(str(err)))
                    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

                    # 1. Online initial load + SW registration + precache + write saves
                    resp1 = page.goto(f"{base_url}/index.html", wait_until="load", timeout=45000)
                    self.assertIsNotNone(resp1)
                    self.assertEqual(resp1.status, 200)
                    sw_info = page.evaluate(
                        """async (saves) => {
                            for (const [k, v] of Object.entries(saves)) localStorage.setItem(k, v);
                            const reg = await navigator.serviceWorker.ready;
                            if (!navigator.serviceWorker.controller) {
                                await new Promise((resolve) => {
                                    const onCtrl = () => {
                                        navigator.serviceWorker.removeEventListener('controllerchange', onCtrl);
                                        resolve();
                                    };
                                    navigator.serviceWorker.addEventListener('controllerchange', onCtrl);
                                    setTimeout(resolve, 3500);
                                });
                            }
                            const cacheKeys = await caches.keys();
                            const manifestResp = await fetch('./manifest.webmanifest');
                            const iconResp = await fetch('./icons/icon-192.png');
                            return {
                                hasController: Boolean(navigator.serviceWorker.controller),
                                activeState: reg.active ? reg.active.state : null,
                                cacheKeys,
                                manifestStatus: manifestResp.status,
                                iconStatus: iconResp.status,
                            };
                        }""",
                        SAVE_KEYS,
                    )
                    self.assertTrue(sw_info["hasController"], f"SW controller missing: {sw_info}")
                    self.assertEqual(sw_info["activeState"], "activated")
                    self.assertEqual(sw_info["manifestStatus"], 200)
                    self.assertEqual(sw_info["iconStatus"], 200)
                    self.assertTrue(len(sw_info["cacheKeys"]) >= 1)
                    old_cache_key = sw_info["cacheKeys"][0]

                    # 2. Origin outage toggle (HTTP 503): verify SW navigation + saves retained + ready/deploy
                    handler_cls.full_outage = True
                    offline_resp = page.reload(wait_until="load", timeout=45000)
                    self.assertIsNotNone(offline_resp)
                    self.assertEqual(offline_resp.status, 200)
                    self.assertTrue(offline_resp.from_service_worker, "offline reload must be served by service worker")

                    offline_saves = page.evaluate(
                        """(keys) => {
                            const out = {};
                            for (const k of keys) out[k] = localStorage.getItem(k);
                            return {
                                hasStartBtn: Boolean(document.getElementById('btn-start')),
                                saves: out,
                            };
                        }""",
                        list(SAVE_KEYS.keys()),
                    )
                    self.assertTrue(offline_saves["hasStartBtn"])
                    self.assertEqual(offline_saves["saves"], SAVE_KEYS)

                    deploy_from_menu(page)
                    offline_deploy = page.evaluate("() => ({ started, assetsReady })")
                    self.assertTrue(offline_deploy["started"])
                    self.assertTrue(offline_deploy["assetsReady"])

                    # Also verify root './' navigation under origin outage
                    root_resp = page.goto(f"{base_url}/", wait_until="load", timeout=45000)
                    self.assertIsNotNone(root_resp)
                    self.assertEqual(root_resp.status, 200)
                    self.assertTrue(root_resp.from_service_worker, "root './' offline navigation must come from SW")

                    # Re-seed checkpoint before v2 update (starting a fresh match above intentionally clears blackout.save.v1)
                    page.evaluate(
                        "(saves) => { for (const [k, v] of Object.entries(saves)) localStorage.setItem(k, v); }",
                        SAVE_KEYS,
                    )

                    # 3. Online real generated v1 -> v2 update via build.py
                    handler_cls.full_outage = False
                    main_js = proj_dir / "src" / "70_main.js"
                    main_js.write_text(
                        main_js.read_text(encoding="utf-8") + "\nwindow.__OB_PWA_RELEASE = 'v2-generated';\n",
                        encoding="utf-8",
                    )
                    subprocess.run(
                        ["python3", str(BUILD_SCRIPT), str(proj_dir), "--output", str(out_html), "--pwa-dir", str(serve_dir)],
                        check=True,
                        cwd=ROOT,
                    )
                    sw_v2 = (serve_dir / "sw.js").read_text(encoding="utf-8")
                    self.assertNotIn(old_cache_key, sw_v2, "real v2 build must rotate SW cache key")

                    update_info = page.evaluate(
                        """async (oldKey) => {
                            const reg = await navigator.serviceWorker.getRegistration('./');
                            await reg.update();
                            const deadline = Date.now() + 8000;
                            while (Date.now() < deadline) {
                                const keys = await caches.keys();
                                if (!keys.includes(oldKey) && keys.some((k) => k.startsWith('ob-pwa-') && k !== oldKey)) {
                                    return { keys, updated: true, activeScript: reg.active ? reg.active.scriptURL : null };
                                }
                                await new Promise((r) => setTimeout(r, 80));
                            }
                            return { keys: await caches.keys(), updated: false };
                        }""",
                        old_cache_key,
                    )
                    self.assertTrue(update_info["updated"], f"real v2 SW cache did not rotate cleanly: {update_info}")

                    # 4. Shut down origin server completely + navigate fresh page to prove v2 offline works & saves intact
                    server.shutdown()
                    server.server_close()
                    server_closed = True
                    page.close()

                    page2 = context.new_page()
                    page2.on("pageerror", lambda err: errors.append(str(err)))
                    page2.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                    v2_resp = page2.goto(f"{base_url}/index.html", wait_until="load", timeout=45000)
                    self.assertIsNotNone(v2_resp)
                    self.assertEqual(v2_resp.status, 200)
                    self.assertTrue(v2_resp.from_service_worker, "v2 offline navigation must come from SW after server shutdown")

                    v2_state = page2.evaluate(
                        """(keys) => {
                            const out = {};
                            for (const k of keys) out[k] = localStorage.getItem(k);
                            return {
                                release: window.__OB_PWA_RELEASE || null,
                                hasStartBtn: Boolean(document.getElementById('btn-start')),
                                saves: out,
                            };
                        }""",
                        list(SAVE_KEYS.keys()),
                    )
                    self.assertEqual(v2_state["release"], "v2-generated")
                    self.assertTrue(v2_state["hasStartBtn"])
                    self.assertEqual(v2_state["saves"], SAVE_KEYS)

                    deploy_from_menu(page2)
                    v2_deploy = page2.evaluate("() => ({ started, assetsReady })")
                    self.assertTrue(v2_deploy["assetsReady"])
                    self.assertTrue(v2_deploy["started"])
                    self.assertEqual(errors, [])

                    browser.close()
            finally:
                if not server_closed:
                    server.shutdown()
                    server.server_close()

    def test_pwa_failed_v2_precache_preserves_working_v1_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            proj_dir = tmp_path / "proj"
            stage_temp_project(proj_dir)
            serve_dir = tmp_path / "serve"
            out_html = tmp_path / "Operation Blackout.html"
            subprocess.run(
                ["python3", str(BUILD_SCRIPT), str(proj_dir), "--output", str(out_html), "--pwa-dir", str(serve_dir)],
                check=True,
                cwd=ROOT,
            )

            server, handler_cls, base_url = start_http_server(serve_dir)
            try:
                with sync_playwright() as p:
                    browser = p.chromium.launch(
                        headless=True,
                        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
                    )
                    context = browser.new_context(viewport={"width": 800, "height": 360})
                    page = context.new_page()
                    page.goto(f"{base_url}/index.html", wait_until="load", timeout=45000)
                    v1_info = page.evaluate(
                        """async () => {
                            const reg = await navigator.serviceWorker.ready;
                            if (!navigator.serviceWorker.controller) {
                                await new Promise((resolve) => {
                                    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
                                    setTimeout(resolve, 3500);
                                });
                            }
                            return { keys: await caches.keys(), ctrl: Boolean(navigator.serviceWorker.controller) };
                        }"""
                    )
                    self.assertTrue(v1_info["ctrl"])
                    v1_key = v1_info["keys"][0]

                    # Serve the new HTML but fail its last precache asset. An online
                    # navigation must not overwrite the active version's offline shell.
                    main_js = proj_dir / "src" / "70_main.js"
                    main_js.write_text(main_js.read_text(encoding="utf-8") + "\nwindow.__OB_V2 = 1;\n", encoding="utf-8")
                    subprocess.run(
                        ["python3", str(BUILD_SCRIPT), str(proj_dir), "--output", str(out_html), "--pwa-dir", str(serve_dir)],
                        check=True,
                        cwd=ROOT,
                    )

                    handler_cls.outage_paths = {"/icons/icon-maskable-512.png"}
                    update_res = page.evaluate(
                        """async () => {
                            const reg = await navigator.serviceWorker.getRegistration('./');
                            try { await reg.update(); } catch (_) {}
                            const deadline = Date.now() + 10000;
                            while (reg.installing && Date.now() < deadline) {
                                await new Promise((r) => setTimeout(r, 50));
                            }
                            return { keys: await caches.keys(), hasWaiting: !!reg.waiting, hasInstalling: !!reg.installing };
                        }"""
                    )
                    self.assertIn(v1_key, update_res["keys"], f"failed v2 install wiped working v1 cache: {update_res}")
                    self.assertFalse(update_res["hasInstalling"] or update_res["hasWaiting"], update_res)

                    online_resp = page.reload(wait_until="commit", timeout=45000)
                    self.assertTrue(online_resp.from_service_worker)
                    self.assertFalse("window.__OB_V2" in online_resp.text(),
                                     "uninstalled v2 replaced the active v1 shell online")

                    # Now full outage: v1 must still load from SW
                    handler_cls.full_outage = True
                    resp = page.reload(wait_until="commit", timeout=45000)
                    self.assertIsNotNone(resp)
                    self.assertEqual(resp.status, 200)
                    self.assertTrue(resp.from_service_worker)
                    self.assertFalse("window.__OB_V2" in resp.text(),
                                     "uninstalled v2 replaced the working v1 offline shell")
                    browser.close()
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
