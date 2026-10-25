#!/usr/bin/env python3
"""Run isolated Survival checkpoint and snowy map integration verification."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from probe_live import main

if __name__ == "__main__":
    if "--filter" not in sys.argv and "--check" not in sys.argv and "--suite" not in sys.argv and "--isolate" not in sys.argv:
        sys.argv.extend(["--filter", "checkpoint|snowy"])
    sys.exit(main())
