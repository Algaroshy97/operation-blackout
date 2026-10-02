# Contributing

## Source and release contract

Edit the modular `src/` tree, not the generated `dist/Operation Blackout.html` or
historical versioned HTML snapshots. `scripts/build.py` combines `src/00_head.html`,
sorted `vendor/*.min.js` files and sorted `src/*.js` files into the self-contained
release. The source modules share one classic-script scope; they are not isolated
ES modules. Keep top-level names unique and do not shadow browser globals.

Put engine-free gameplay rules in `src/01_core.js` where appropriate, and cover
behavior with regression tests. Rendering, DOM and input behavior also need
integration or browser checks. Keep changes focused and document any changed
controls or release behavior in the README and changelog.

Single-file packaging is the distribution format, not a requirement to maintain
one giant source file. It does not by itself explain frame-time problems.

## Build and test

From the repository root, with Python 3 and Node.js installed:

```bash
python3 scripts/build.py .
node --test tests/*.js
python3 -m unittest tests.test_release_build
```

The wildcard is intentional: running just `tests/test_core.js` misses the other
JavaScript suites. The Python suite invokes only that core Node file in addition
to its own build-integrity, shared-scope and touch-layout checks. Ensure Node is
available so Node-dependent Python checks are not skipped.

Install the browser-probe dependencies in your Python environment:

```bash
python3 -m pip install -r requirements.txt
python3 -m playwright install chromium
python3 scripts/probe_live.py
```

On Linux, Playwright may also need system dependencies; use
`python3 -m playwright install --with-deps chromium` where appropriate. The probe
opens the local `dist/Operation Blackout.html` through `file://` and drives the real
UI before probing gameplay state. It is not a hosted-deployment check. Require
exit code 0, all reported checks passing and an empty `console_errors` list.

For a non-mutating build comparison, write outside the repository instead:

```bash
python3 scripts/build.py . --output "$TMPDIR/operation-blackout-check.html"
cmp "dist/Operation Blackout.html" "$TMPDIR/operation-blackout-check.html"
python3 scripts/probe_live.py --build "$TMPDIR/operation-blackout-check.html"
```

Set `TMPDIR` to an existing scratch directory if your environment does not provide
one. A documentation-only change should not regenerate tracked release artifacts.

## Offline release gates

- Run every JavaScript regression file, the Python release tests and the Chromium
  acceptance probe; investigate failures rather than accepting a partial pass.
- Confirm the shipped artifact byte-matches a fresh source build. The build
  normalizes line endings for reproducibility.
- Keep scripts, styles, models and artwork embedded or vendored into the release.
  Do not add CDN dependencies, remote asset loads or network calls to play.
- Preserve the release suite's self-contained-media, script-parse, source-inclusion,
  shared-scope and size-budget checks. The size budget is an artifact gate, not a
  runtime performance target.
- Test opening the release through `file://` with network access disabled. The
  static release tests and current browser probe are useful evidence, but the
  probe does not explicitly disable networking; inspect requests or use browser
  offline mode for a stronger offline acceptance check.
- If publishing a release, verify the hosted response matches the built artifact
  separately. A successful local probe does not prove deployment succeeded.

## Mobile, artwork and hardware limits

Under default `auto`, `src/40_enemies.js` selects `makeEnemyMesh(kind)` (the lightweight
box-man) whenever `IS_TOUCH` is true, preserving the mobile GPU budget. Explicit `detailed`
in Settings → Enemy detail enables `buildSoldier(kind)` across devices upon page reload.
Do not claim detailed soldiers are performant on phones without validating on physical hardware.

The mobile controls use image-generated transparent raster artwork embedded as a
PNG atlas, not entirely procedural art. Preserve labels, accessible names, touch
hitboxes and atlas embedding. Credit provenance in
[assets/ui/mobile/README.md](assets/ui/mobile/README.md) and the main README.

Headless Chromium can use SwiftShader or llvmpipe instead of a native GPU. Passing
functional checks does not establish playable frame rates on a low-end desktop or
Android phone. Record the actual renderer, device, viewport, pixel ratio, graphics
preset and combat workload before making performance claims. Use matched scenarios
and retain raw measurements; do not infer speedups from test success or commit titles.
Physical touch, orientation, safe-area, audio and sustained-play tests remain
separate from browser emulation. See
[PERFORMANCE_MOBILE_REPORT.md](PERFORMANCE_MOBILE_REPORT.md) for existing evidence
and its limitations.
