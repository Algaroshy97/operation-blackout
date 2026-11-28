#!/usr/bin/env python3
"""Write the acceptance receipts the publisher insists on.

The release publisher (ob-herenow-publish.sh) refuses to upload anything whose
bytes are not named in a receipt written by the acceptance run. The receipts used
to be produced by the old 6-hourly cycle wrapper, which no longer exists and which
also relied on dist/ being tracked. dist/ is generated now, so the receipt has to
be written here, right after the deterministic build, from the bytes on disk.

Two files:
  fps-accepted.sha256      "<artifact sha256>\\n"
  fps-accepted-pwa.sha256  "<artifact sha>  standalone.html" + one line per PWA file

Usage: python3 scripts/accept.py [--state-dir DIR]
Exit 1 (nothing written) if the build or any PWA file is missing.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
from pathlib import Path

ARTIFACT = Path("dist/Operation Blackout.html")
PWA = Path("dist/pwa")
PWA_FILES = (
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-maskable-512.png",
)
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STATE = Path.home() / "server/maintenance/state"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_atomic(target: Path, text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=target.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", default=str(DEFAULT_STATE))
    args = ap.parse_args()
    state = Path(args.state_dir)
    artifact = ROOT / ARTIFACT
    pwa_dir = ROOT / PWA

    if not artifact.is_file():
        print(f"accept: missing build {ARTIFACT} — run scripts/build.py first", file=sys.stderr)
        return 1
    artifact_sha = sha256(artifact)

    pwa_lines = []
    if pwa_dir.is_dir():
        for name in PWA_FILES:
            path = pwa_dir / name
            if not path.is_file():
                print(f"accept: missing PWA file {PWA}/{name}", file=sys.stderr)
                return 1
            pwa_lines.append(f"{sha256(path)}  {name}")

    write_atomic(state / "fps-accepted.sha256", f"{artifact_sha}\n")
    if pwa_lines:
        # Trailing newline matters: the publisher's receipt is compared as text.
        body = "\n".join([f"{artifact_sha}  standalone.html", *pwa_lines]) + "\n"
        write_atomic(state / "fps-accepted-pwa.sha256", body)
    else:
        # No bundle staged: the publisher must not expect one.
        (state / "fps-accepted-pwa.sha256").unlink(missing_ok=True)

    print(artifact_sha)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
