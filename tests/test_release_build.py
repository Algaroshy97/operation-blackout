#!/usr/bin/env python3
"""Build-integrity checks for the single-file release.

Scope note: this file tests *the artifact* — that the build runs, that the output
is genuinely self-contained and parseable, and that it stays under the size budget.

It deliberately does NOT assert on source text. The previous version of this file
asserted things like `assertNotIn("playSound('scope_out')", weapons_src)`, which
meant renaming a variable failed the suite while inverting a conditional passed it.
Gameplay rules are tested behaviourally in tests/test_core.js (`node --test`), which
this module also drives so a single command covers both.

Run:
    python -m unittest tests.test_release_build -v
"""
from __future__ import annotations

import itertools
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "scripts" / "build.py"
CORE_TESTS = ROOT / "tests" / "test_core.js"
SIZE_BUDGET = 2 * 1024 * 1024


def build_release(output: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(BUILD), str(ROOT), "--output", str(output)],
        capture_output=True,
        text=True,
        check=False,
    )


class BuildIntegrityTests(unittest.TestCase):
    """The build produces a shippable, self-contained, parseable artifact."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.output = Path(cls._tmp.name) / "Operation Blackout.html"
        cls.result = build_release(cls.output)
        cls.content = cls.output.read_text(encoding="utf-8") if cls.output.is_file() else ""

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def test_build_succeeds_from_repo_root(self) -> None:
        self.assertEqual(self.result.returncode, 0, self.result.stderr or self.result.stdout)
        self.assertTrue(self.output.is_file())
        self.assertGreater(self.output.stat().st_size, 500_000)

    def test_artifact_is_self_contained(self) -> None:
        """No external fetches: the file must play from file:// with no network."""
        for tag in re.findall(r'<script[^>]*\ssrc=', self.content):
            self.fail(f"external script reference in the release build: {tag}")
        for tag in re.findall(r'<link[^>]*\srel=["\']?stylesheet', self.content):
            self.fail(f"external stylesheet in the release build: {tag}")
        # Remote fetches defeat the offline promise. Scope this to our own code and
        # markup: vendored three.js carries doc-comment URLs and a protocol-list
        # string that are inert text, and policing vendor comments is noise.
        blocks = re.findall(r"<script>(.*?)</script>", self.content, re.S)
        ours = self.content.split("<script>", 1)[0] + (blocks[-1] if blocks else "")
        fetched = re.findall(r'(?:fetch|XMLHttpRequest|importScripts|\.load)\s*\(\s*["\']https?://', ours)
        self.assertEqual(fetched, [], f"remote fetch in game code: {fetched[:3]}")
        remote = re.findall(r'["\'](https?://[^\s"\'<>)]+)["\']', ours)
        self.assertEqual(remote, [], f"remote URL literal in game code: {remote[:5]}")

    def test_embedded_media_is_present(self) -> None:
        self.assertIn("data:image/jpeg;base64,", self.content)
        self.assertIn("data:image/svg+xml;base64,", self.content)

    def test_artifact_stays_under_size_budget(self) -> None:
        size = self.output.stat().st_size
        self.assertLess(size, SIZE_BUDGET, f"{size} bytes exceeds the {SIZE_BUDGET} byte budget")

    @unittest.skipIf(shutil.which("node") is None, "node not available")
    def test_bundled_script_parses(self) -> None:
        """Every module lands in ONE shared <script> scope, so a duplicate top-level
        declaration between two modules is an instant whole-game SyntaxError. Parse
        the concatenated bundle to catch that before it ships."""
        blocks = re.findall(r"<script>(.*?)</script>", self.content, re.S)
        self.assertTrue(blocks, "no inline script blocks found in the build")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp) / "bundle.js"
            bundle.write_text(blocks[-1], encoding="utf-8")
            proc = subprocess.run([shutil.which("node"), "--check", str(bundle)],
                                  capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, f"bundled game script failed to parse:\n{proc.stderr}")

    def test_every_source_module_reaches_the_bundle(self) -> None:
        """build.py globs src/*.js — a new module must not be silently dropped."""
        for module in sorted((ROOT / "src").glob("*.js")):
            first_line = module.read_text(encoding="utf-8").splitlines()[0]
            self.assertIn(first_line, self.content,
                          f"{module.name} did not make it into the build")


class SharedScopeTests(unittest.TestCase):
    """ENG-05: every module lands in ONE `<script>`, so top-level names are shared.

    `test_bundled_script_parses` already turns a collision into a failure, but only
    as a bare `SyntaxError` from node. These name the offender, and catch the case
    node cannot see: a `var`/`function` that shadows a browser global.
    """

    DECL = re.compile(r"^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)", re.M)
    # Assigning any of these at top level with var/function silently rebinds a real
    # window property, which fails at runtime rather than at parse time.
    WINDOW_PROPS = {
        "name", "status", "length", "top", "parent", "self", "closed", "origin",
        "history", "location", "navigator", "screen", "frames", "external", "event",
    }

    @classmethod
    def setUpClass(cls) -> None:
        cls.modules = {m.name: m.read_text(encoding="utf-8")
                       for m in sorted((ROOT / "src").glob("*.js"))}

    def test_no_duplicate_top_level_declaration_between_modules(self) -> None:
        owner: dict[str, str] = {}
        clashes: list[str] = []
        for module, text in self.modules.items():
            # Top-level only: a declaration inside a function or block is indented.
            for name in self.DECL.findall(text):
                if name in owner:
                    clashes.append(f"{name!r} declared in both {owner[name]} and {module}")
                else:
                    owner[name] = module
        self.assertEqual(clashes, [],
                         "duplicate top-level names share one script scope:\n  "
                         + "\n  ".join(clashes))

    def test_no_top_level_name_shadows_a_window_property(self) -> None:
        offenders = []
        for module, text in self.modules.items():
            for match in re.finditer(r"^(?:var|function)\s+([A-Za-z_$][\w$]*)", text, re.M):
                if match.group(1) in self.WINDOW_PROPS:
                    offenders.append(f"{module}: {match.group(1)}")
        self.assertEqual(offenders, [],
                         f"top-level var/function shadows a window property: {offenders}")


class TouchLayoutTests(unittest.TestCase):
    """Solve the touch HUD's CSS box model on the smallest landscape phone.

    Guards the Android pass: RELOAD used to overlap PAUSE by its full height (a tap
    there could pause the fight instead of reloading) and FIRE sat on top of the ammo
    readout at every size. Both are pure geometry, so they can be checked without a
    browser — parse the offsets out of the stylesheet and intersect the rectangles.
    """

    # 1600x720 and 1440x720 panels at dpr 2. The shortest landscape viewport in
    # common use, and the one where a bottom-anchored column runs out of room.
    VIEWPORT = (800, 360)

    @classmethod
    def setUpClass(cls) -> None:
        cls.css = (ROOT / "src" / "00_head.html").read_text(encoding="utf-8")

    def _boxes(self) -> dict[str, tuple[float, float, float, float]]:
        """(x, y, right, bottom) for every body.touch control, in viewport pixels."""
        vw, vh = self.VIEWPORT
        pattern = re.compile(
            r"body\.touch\s+#(tbtn-[\w-]+|joy-base)\{([^}]*)\}")

        def offset(decls: str, prop: str) -> float | None:
            # `right:calc(26px + var(--sa-r))` — safe-area vars are 0 without a cutout.
            m = re.search(rf"(?:^|;){prop}:\s*(?:calc\(\s*)?(-?[\d.]+)px", decls)
            return float(m.group(1)) if m else None

        boxes: dict[str, tuple[float, float, float, float]] = {}
        for name, decls in pattern.findall(self.css):
            w, h = offset(decls, "width"), offset(decls, "height")
            if w is None or h is None:
                continue
            left, right = offset(decls, "left"), offset(decls, "right")
            top, bottom = offset(decls, "top"), offset(decls, "bottom")
            x = left if left is not None else vw - right - w
            y = top if top is not None else vh - bottom - h
            boxes[name] = (x, y, x + w, y + h)
        return boxes

    @staticmethod
    def _overlap(a, b) -> tuple[float, float]:
        return (min(a[2], b[2]) - max(a[0], b[0]),
                min(a[3], b[3]) - max(a[1], b[1]))

    def test_stylesheet_defines_every_touch_control(self) -> None:
        boxes = self._boxes()
        expected = {"joy-base", "tbtn-fire", "tbtn-ads", "tbtn-jump", "tbtn-slide",
                    "tbtn-reload", "tbtn-nade", "tbtn-swap", "tbtn-pause",
                    "tbtn-melee", "tbtn-use", "tbtn-plate",
                    "tbtn-tactical", "tbtn-streak"}
        self.assertEqual(expected, set(boxes), "touch control set changed — update this test")

    def test_no_two_touch_controls_overlap(self) -> None:
        boxes = self._boxes()
        for a, b in itertools.combinations(sorted(boxes), 2):
            ix, iy = self._overlap(boxes[a], boxes[b])
            self.assertFalse(ix > 0 and iy > 0,
                             f"{a} and {b} overlap by {ix:.0f}x{iy:.0f}px at "
                             f"{self.VIEWPORT[0]}x{self.VIEWPORT[1]} — a tap there is ambiguous")

    def test_controls_stay_inside_the_viewport(self) -> None:
        vw, vh = self.VIEWPORT
        for name, (x, y, r, b) in sorted(self._boxes().items()):
            self.assertGreaterEqual(x, 0, f"{name} runs off the left edge")
            self.assertGreaterEqual(y, 0, f"{name} runs off the top edge")
            self.assertLessEqual(r, vw, f"{name} runs off the right edge")
            self.assertLessEqual(b, vh, f"{name} runs off the bottom edge")

    def test_tap_targets_meet_the_44px_minimum(self) -> None:
        for name, (x, y, r, b) in sorted(self._boxes().items()):
            self.assertGreaterEqual(min(r - x, b - y), 44,
                                    f"{name} is smaller than a 44px tap target")

    def test_end_screens_can_scroll_when_content_overflows(self) -> None:
        """A 15-wave run ends here; the buttons must never be unreachable.

        Flex centring clips overflow at both ends with no way to scroll to it, which
        is how MAIN MENU ended up off-screen on a 360px-tall phone.
        """
        for panel in ("#death-screen", "#victory-screen"):
            rule = re.search(rf"[^\n]*{re.escape(panel)}[^{{\n]*\{{([^}}]*overflow-y:auto[^}}]*)\}}",
                             self.css)
            self.assertIsNotNone(rule, f"{panel} has no overflow-y:auto rule")
            self.assertIn("safe center", rule.group(1),
                          f"{panel} centres without `safe`, so overflow is unreachable")

    def test_edge_anchored_controls_inset_past_the_display_cutout(self) -> None:
        """The viewport meta opts into viewport-fit=cover, so insets are mandatory."""
        self.assertIn("viewport-fit=cover", self.css)
        self.assertIn("env(safe-area-inset-top", self.css)
        for name in ("tbtn-fire", "tbtn-pause", "tbtn-reload", "joy-base"):
            decls = re.search(rf"body\.touch\s+#{name}\{{([^}}]*)\}}", self.css).group(1)
            self.assertIn("var(--sa-", decls,
                          f"{name} is edge-anchored but never insets past the cutout")


class CoreBehaviourTests(unittest.TestCase):
    """Drive the headless gameplay-rule tests so one command covers both suites."""

    @unittest.skipIf(shutil.which("node") is None, "node not available")
    def test_core_rules_pass(self) -> None:
        proc = subprocess.run(
            [shutil.which("node"), "--test", str(CORE_TESTS)],
            capture_output=True, text=True, check=False, cwd=str(ROOT),
        )
        self.assertEqual(proc.returncode, 0,
                         f"tests/test_core.js failed:\n{proc.stdout[-4000:]}\n{proc.stderr[-2000:]}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
