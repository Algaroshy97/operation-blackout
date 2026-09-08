#!/usr/bin/env python3
"""Assemble a single-file HTML app: head + vendored libs + numbered modules.

Usage: python3 build.py <project_dir>
Expects <project_dir>/src/00_head.html (markup + CSS, body left unclosed),
numbered src/*.js modules (10_, 20_, ... in filename order), and vendored
libraries as *.min.js at the project root. Writes <project_dir>/index.html.
"""
import sys
import pathlib


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    proj = pathlib.Path(sys.argv[1])
    src = proj / "src"
    head = (src / "00_head.html").read_text()
    mods = sorted(src.glob("*.js"))
    libs = sorted(proj.glob("*.min.js"))
    if not mods:
        sys.exit(f"no src/*.js modules found under {src}")

    parts = [head, "\n"]
    for lib in libs:
        parts += ["<script>\n", lib.read_text(), "\n</script>\n"]
    parts += ["<script>\n", "\n".join(m.read_text() for m in mods), "\n</script>\n", "</body>\n</html>\n"]

    out = proj / "index.html"
    out.write_text("".join(parts))
    print(f"built {out} ({out.stat().st_size} bytes) from {len(mods)} modules, {len(libs)} libs")


if __name__ == "__main__":
    main()
