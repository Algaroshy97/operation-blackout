#!/usr/bin/env python3
"""Build the self-contained Operation Blackout release HTML.

Usage:
    python3 scripts/build.py .
    python3 scripts/build.py . --output "/path/to/Operation Blackout.html"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
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
                    line = re.sub(r'/\*[^*]*\*+(?:[^/*][^*]*\*+)*/', '', line)
                    line = re.sub(r'\s*([{}(),;\[\]:])\s*', r'\1', line)
                    line = re.sub(r'\s*\?(?!\.)\s*', '?', line)
                    line = re.sub(r'\s*(=>|<=|>=|==|!=|\+=|-=|\*=|\?\?)\s*', r'\1', line)
                    line = re.sub(r'\s+', ' ', line).strip()
        if line.count('`') % 2:
            in_template = not in_template
        kept.append(line)
    return LF.join(kept)


def build_pwa_bundle(project: Path, html_text: str, pwa_dir: Path) -> None:
    """Emit the same-origin installable standalone PWA directory (also ready for here.now)."""
    icon_src_dir = project / "assets" / "pwa"
    icon_names = ("icon-192.png", "icon-512.png", "icon-maskable-512.png")
    missing_icons = [str(icon_src_dir / name) for name in icon_names if not (icon_src_dir / name).is_file()]
    if missing_icons:
        raise FileNotFoundError(f"Missing PWA icon assets: {', '.join(missing_icons)}")

    pwa_dir.mkdir(parents=True, exist_ok=True)
    icons_dir = pwa_dir / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    for name in icon_names:
        shutil.copyfile(icon_src_dir / name, icons_dir / name)

    manifest = {
        "id": "./index.html",
        "name": "Operation Blackout",
        "short_name": "Blackout",
        "description": "Tactical 3D offline-ready wave & mission FPS for desktop and mobile.",
        "start_url": "./index.html",
        "scope": "./",
        "display": "standalone",
        "orientation": "landscape",
        "background_color": "#0b0d0c",
        "theme_color": "#0b0d0c",
        "categories": ["games", "action"],
        "icons": [
            {"src": "./icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "./icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "./icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    manifest_text = json.dumps(manifest, indent=2) + "\n"
    (pwa_dir / "manifest.webmanifest").write_text(manifest_text, encoding="utf-8", newline="")

    head_inject = (
        '<link rel="manifest" href="./manifest.webmanifest">\n'
        '<meta name="theme-color" content="#0b0d0c">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n'
        '<link rel="icon" type="image/png" sizes="192x192" href="./icons/icon-192.png">\n'
        '<link rel="apple-touch-icon" href="./icons/icon-192.png">\n'
        "</head>"
    )
    sw_register_snippet = """<script>
(function(){
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(function(reg){
      reg.addEventListener('updatefound', function(){
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function(){
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            window.__OB_PWA_UPDATE_READY = true;
          }
        });
      });
    }).catch(function(){});
  });
})();
</script>
</body>"""

    pwa_html = html_text.replace("</head>", head_inject, 1).replace("</body>", sw_register_snippet, 1)
    (pwa_dir / "index.html").write_text(pwa_html, encoding="utf-8", newline="")

    hasher = hashlib.sha256()
    hasher.update(pwa_html.encode("utf-8"))
    hasher.update(manifest_text.encode("utf-8"))
    for name in icon_names:
        hasher.update((icons_dir / name).read_bytes())
    cache_placeholder = '__OB_CACHE_VERSION__'
    sw_template = f"""/* Operation Blackout PWA Service Worker ({cache_placeholder}) */
const CACHE_NAME = '{cache_placeholder}';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
const SCOPE = self.registration.scope;
const INDEX = new URL('./index.html', SCOPE).href;
const PRECACHED = new Set(PRECACHE_URLS.map((path) => new URL(path, SCOPE).href));

self.addEventListener('install', (event) => {{
  event.waitUntil((async () => {{
    const cache = await caches.open(CACHE_NAME);
    try {{
      for (const url of PRECACHED) {{
        const req = new Request(url, {{ cache: 'reload' }});
        const res = await fetch(req);
        if (!res.ok) throw new Error('Precache failed for ' + url + ' (' + res.status + ')');
        await cache.put(req, res);
      }}
    }} catch (error) {{
      await caches.delete(CACHE_NAME);
      throw error;
    }}
    await self.skipWaiting();
  }})());
}});

self.addEventListener('activate', (event) => {{
  event.waitUntil((async () => {{
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('ob-pwa-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  }})());
}});

self.addEventListener('fetch', (event) => {{
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {{
    if (url.href !== SCOPE && url.href !== INDEX) return;
    // App-shell first: the shell is written only by a successful install, so a
    // half-published release (failed precache) can never replace the working copy,
    // online or offline. A good release rotates CACHE_NAME, so it takes over on
    // install instead of after the next network hit.
    event.respondWith((async () => {{
      const cache = await caches.open(CACHE_NAME);
      const cached = (await cache.match(INDEX)) || (await cache.match(SCOPE));
      if (cached) return cached;
      try {{
        const net = await fetch(req);
        if (net && net.ok) return net;
      }} catch (_) {{}}
      return Response.error();
    }})());
    return;
  }}
  url.search = '';
  if (!PRECACHED.has(url.href)) return; // Leave unrelated requests alone.
  event.respondWith((async () => {{
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(url.href)) || fetch(req);
  }})());
}});
"""
    hasher.update(sw_template.encode("utf-8"))
    cache_name = f"ob-pwa-{hasher.hexdigest()[:12]}"
    sw_code = sw_template.replace(cache_placeholder, cache_name)
    (pwa_dir / "sw.js").write_text(sw_code, encoding="utf-8", newline="")
    print(f"built PWA {pwa_dir} (cache={cache_name})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", nargs="?", default=".", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        help="Output file (default: <project_dir>/dist/Operation Blackout.html)",
    )
    parser.add_argument(
        "--pwa-dir",
        type=Path,
        help="Output directory for same-origin hosted PWA (default when --output omitted: <project_dir>/dist/pwa)",
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
    html_text = "".join(parts)
    output.parent.mkdir(parents=True, exist_ok=True)
    # newline="" prevents a second round of platform translation on write.
    output.write_text(html_text, encoding="utf-8", newline="")
    print(f"built {output} ({output.stat().st_size} bytes; {len(modules)} modules, {len(libraries)} libraries)")

    pwa_dir = args.pwa_dir
    if pwa_dir is None and args.output is None:
        pwa_dir = project / "dist" / "pwa"
    if pwa_dir is not None:
        build_pwa_bundle(project, html_text, pwa_dir.resolve())


if __name__ == "__main__":
    main()
