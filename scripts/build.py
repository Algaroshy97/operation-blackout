#!/usr/bin/env python3
"""Build the self-contained Operation Blackout release HTML.

Usage:
    python3 scripts/build.py .
    python3 scripts/build.py . --output "/path/to/Operation Blackout.html"
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

LF = "\n"
CRLF = "\r\n"


def read_lf(path: Path) -> str:
    """Read a source file with newlines normalised to LF.

    Without this, text-mode I/O translates to CRLF on Windows, so the same
    commit produces byte-different artifacts depending on the build host.
    """
    return path.read_text(encoding="utf-8").replace(CRLF, LF)


def compact_css(css: str) -> str:
    """Remove optional CSS whitespace without changing quoted content or selectors."""
    out = []
    quote = None
    escaped = False
    pending = False
    for char in css:
        if quote:
            out.append(char)
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in ('"', "'"):
            if pending and out and out[-1] not in '{;}:,':
                out.append(' ')
            pending = False
            quote = char
            out.append(char)
        elif char.isspace():
            pending = True
        else:
            if pending and out and out[-1] not in '{;}:,' and char not in '{};,':
                out.append(' ')
            pending = False
            if char == '}' and out and out[-1] == ';':
                out.pop()
            out.append(char)
    return ''.join(out)


def strip_css_comments(html: str) -> str:
    """Drop CSS block comments from HTML head for the shipped release."""
    cleaned = re.sub(r"/\*.*?\*/", "", html, flags=re.S)
    cleaned = re.sub(r'(?<=<style>)(.*?)(?=</style>)',
                     lambda match: compact_css(match.group(1)), cleaned, flags=re.S)
    return LF.join(line.strip() if line.lstrip().startswith('<') else line.rstrip()
                   for line in cleaned.split(LF))


def strip_line_comments(js: str, compact_extra: bool = False) -> str:
    """Drop full-line `//` comments from a source module for the shipped file.

    The release has a hard 2 MiB budget and the modules are heavily commented,
    which is where their explanations belong; the player's browser has no use
    for them. Only lines whose first non-blank characters are `//` go, so code,
    strings and trailing comments are untouched. A module's first line is its
    banner and is kept: it marks where each module starts in the bundle (the
    release test checks every banner arrives). No module has a multi-line
    template literal or string with a line beginning `//`; the release test
    that parses the bundle would catch one that did.
    """
    lines = js.split(LF)
    kept = lines[:1]
    in_template = False
    for line in lines[1:]:
        line = line.strip()
        if not line or (not in_template and line.startswith('//')):
            continue
        if not in_template:
            line = re.sub(r'''^([^/'"`]*;)\s+//.*$''', r'\1', line)
            if not any(char in line for char in "'\"`/"):
                line = line.replace(' === ', '===').replace(' !== ', '!==')
                line = line.replace(' && ', '&&').replace(' || ', '||')
                line = line.replace(' = ', '=')
                if compact_extra:
                    # Only delimiters, never operator characters: `a + +b`,
                    # optional chaining and HTML-comment token boundaries matter.
                    line = re.sub(r'\s*([{}(),;])\s*', r'\1', line)
        if line.count('`') % 2:
            in_template = not in_template
        kept.append(line)
    return LF.join(kept)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", nargs="?", default=".", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        help="Output file (default: <project_dir>/dist/Operation Blackout.html)",
    )
    args = parser.parse_args()

    project = args.project_dir.resolve()
    source = project / "src"
    vendor = project / "vendor"
    output = args.output or project / "dist" / "Operation Blackout.html"
    output = output.resolve()

    head_path = source / "00_head.html"
    modules = sorted(source.glob("*.js"))
    libraries = sorted(vendor.glob("*.min.js"))
    missing = [str(path) for path in [head_path] if not path.is_file()]
    if not modules:
        missing.append(f"no JavaScript modules in {source}")
    if not libraries:
        missing.append(f"no vendored libraries in {vendor}")
    if missing:
        parser.error("; ".join(missing))

    parts = [strip_css_comments(read_lf(head_path)), "\n"]
    for library in libraries:
        parts.extend(["<script>\n", read_lf(library), "\n</script>\n"])
    parts.extend([
        "<script>\n",
        "\n".join(strip_line_comments(read_lf(module), compact_extra=True) for module in modules),
        "\n</script>\n</body>\n</html>\n",
    ])
    output.parent.mkdir(parents=True, exist_ok=True)
    # newline="" prevents a second round of platform translation on write.
    output.write_text("".join(parts), encoding="utf-8", newline="")
    print(f"built {output} ({output.stat().st_size} bytes; {len(modules)} modules, {len(libraries)} libraries)")


if __name__ == "__main__":
    main()
