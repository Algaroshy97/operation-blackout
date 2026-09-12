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
