"""The acceptance receipts must be byte-for-byte what the publisher parses.

dist/ is generated, so nothing writes these receipts on a schedule any more.
scripts/accept.py is the only writer; this pins its output format against the
real published receipt that ob-herenow-publish.sh accepted.
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ACCEPT = REPO / "scripts/accept.py"
PWA_FILES = (
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-maskable-512.png",
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class AcceptReceiptsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="accept-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        (self.repo / "dist/pwa/icons").mkdir(parents=True)
        shutil.copy(ACCEPT, self.repo / "scripts/accept.py")
        self.state = self.tmp / "state"
        self.artifact = self.repo / "dist/Operation Blackout.html"
        self.artifact.write_bytes(b"<html>accepted build</html>\n")
        self.pwa = {name: f"pwa body for {name}\n".encode() for name in PWA_FILES}
        for name, body in self.pwa.items():
            (self.repo / "dist/pwa" / name).write_bytes(body)

    def run_accept(self):
        return subprocess.run(
            [sys.executable, str(self.repo / "scripts/accept.py"), "--state-dir", str(self.state)],
            capture_output=True,
            text=True,
            cwd=str(self.tmp),  # must not depend on the caller's cwd
        )

    def test_writes_both_receipts_in_the_publisher_format(self):
        proc = self.run_accept()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        artifact_sha = sha(self.artifact.read_bytes())

        artifact_receipt = (self.state / "fps-accepted.sha256").read_text()
        self.assertEqual(artifact_receipt, f"{artifact_sha}\n")

        pwa_receipt = (self.state / "fps-accepted-pwa.sha256").read_text()
        expected = [f"{artifact_sha}  standalone.html"]
        expected += [f"{sha(self.pwa[n])}  {n}" for n in PWA_FILES]
        self.assertEqual(pwa_receipt, "\n".join(expected) + "\n")
        self.assertTrue(pwa_receipt.endswith("\n"), "receipt must end with a newline")
        self.assertEqual(pwa_receipt.count("\n"), len(PWA_FILES) + 1)

    def test_missing_build_writes_nothing(self):
        self.artifact.unlink()
        proc = self.run_accept()
        self.assertEqual(proc.returncode, 1)
        self.assertIn("missing build", proc.stderr)
        self.assertEqual(list(self.state.glob("fps-accepted*")) if self.state.exists() else [], [])

    def test_missing_pwa_file_writes_nothing(self):
        # Half a receipt would let the publisher upload a broken bundle.
        (self.repo / "dist/pwa/sw.js").unlink()
        proc = self.run_accept()
        self.assertEqual(proc.returncode, 1)
        self.assertIn("missing PWA file", proc.stderr)
        self.assertFalse((self.state / "fps-accepted.sha256").exists())
        self.assertFalse((self.state / "fps-accepted-pwa.sha256").exists())

    def test_no_pwa_directory_clears_the_stale_pwa_receipt(self):
        self.state.mkdir(parents=True)
        (self.state / "fps-accepted-pwa.sha256").write_text("stale\n")
        shutil.rmtree(self.repo / "dist/pwa")
        proc = self.run_accept()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.state / "fps-accepted.sha256").exists())
        self.assertFalse(
            (self.state / "fps-accepted-pwa.sha256").exists(),
            "a stale PWA receipt would make the publisher demand a bundle that is not there",
        )


if __name__ == "__main__":
    unittest.main()
