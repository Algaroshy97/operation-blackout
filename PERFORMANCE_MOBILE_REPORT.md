# CPU optimization and generated mobile controls

## Scope

Preserve all quality-preset definitions, pixel ratios, render effects, gameplay timing and higher-quality behavior. Improve redundant CPU/HUD work and mobile input reliability. Generated transparent raster artwork is embedded in the single-file release.

## Changes

- Shared enemy navigation flood is recomputed only when the target navigation cell, grid identity or explicit stuck-recovery invalidation changes.
- Routed steering reuses the caller-owned intermediate vector.
- Stationary minimap block rasters are reused only at exactly identical poses; moving/turning poses render directly. Enemy/pickup/deployable markers remain live.
- Identical streak HUD contents no longer replace the same DOM tree.
- Transparent generated icon atlas, persistent labels and accessible action names; at least 44px touch hitboxes. Removed mobile-control shadow and paint-transition costs.
- Quick taps are retained for one input sample; cancellation discards queued shots. Dedicated ADS and fire have independent ownership. Touch identities and hold states clear on lifecycle resets. Analog movement output is reused.

## Verification

- Test-first regressions observed failing, then passing.
- Node suites: 378 passed, zero failed.
- Release build: 15 tests passed.
- Full browser acceptance: 93/93, zero console errors.
- Additional mobile browser smoke: 12/12 checks, zero JavaScript errors. Includes actual embedded artwork, accessible names, hitbox bounds at 844×390, simultaneous ADS/fire, tap sampling, cancellation, blur and text-update artwork preservation. Landscape screenshot visually reviewed.
- Minimap raster comparison: zero differing RGBA bytes across 80 fractional poses including cache hits.

## Isolated measurements

On Chromium SwiftShader (software rendering), not Intel HD520:

- Stationary minimap median over 3,000 ticks: 217.3ms before, 32.9ms after.
- Continuous turning: 214.4ms before, 220.4ms after; no turning speedup claimed.
- Stationary navigation over 6,000 ticks: 375 floods / 230.7ms before, one flood / 1.9ms after.
- Identical streak updates: 100 DOM writes before, one after.

## Whole-game limitations

960×540 Low measurements preserve pixel ratio 0.7. Initial software runs returned 3.765 FPS before / 4.219 FPS after, median frame times 200ms / 191.65ms, p95 683.4ms / 750ms, five enemies in each endpoint sample, and no JavaScript errors. A sequential repeat was highly variable: 1.815 / 3.913 FPS with unequal ending enemy counts (zero / four). These uncontrolled, short software-rendered runs do not establish an overall FPS improvement or playability.

Headless EGL and Vulkan probes selected Mesa llvmpipe rather than the native Intel HD520. No driver installation or service changes were performed. Physical-device touch testing and actual hardware-accelerated playability on the low-end client remain unverified. This release should not be described as a proven playable Low-mode fix until measured in that client's GPU browser.
