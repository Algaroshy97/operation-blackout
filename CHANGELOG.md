# Changelog

Recent changes verified against the repository's commit history and diffs, newest
first. This is not a complete release archive. Commit titles are historical labels,
not proof of deployment status, device support or measured frame-rate improvements.

## `ba26cb0` — Raycast and particle-update optimization

- Reuse result arrays for weapon, scope-rangefinder and grenade line-of-sight raycasts;
  replace the grenade-hit filter allocation with a first-blocker scan. Three.js may
  still allocate individual intersection records; this is not an allocation-free
  guarantee for the whole raycast.
- Skip particle-layer updates when no current, previous or newly emitted particles
  need processing, while retaining cleanup and emission handling.
- Reuse medkit restoration output and enemy steering output; reuse the enemy-to-player
  distance and centralize owned-weapon ammo accounting.
- Add core regressions and extend the browser probe for these rules.

## `2177962` — Stance recoil and enemy grenade spawn gate

- Apply stance multipliers to firing recoil, with airborne taking precedence over
  sliding and sliding over crouching.
- Prevent enemy grenade spawning when the shared live-grenade count reaches the
  configured cap. Player grenades count toward that gate, but player throws do not
  use it: this is not a global grenade-count limit.
- Extract enemy grenade velocity/timing, eye-height, LOS jitter and melee-reset rules
  into testable core helpers.
- Add firing/grenade integration regressions and extend the browser acceptance probe.

## `473b467` — Combat audio polish

- Add positional near-miss bullet sounds and offset missed enemy tracers.
- Add a bolt sound after empty-magazine reloads and a low-ammo warning on firing.
- Synthesize the new sounds through WebAudio recipes; delayed enemy-shot effects are
  guarded against stale runs, paused gameplay and player death.
- Add core tests and browser checks for the audio rules.

## `c92406d` — Repeated CPU work and generated mobile controls

- Recompute the enemy navigation flow field only when its target navigation cell,
  grid identity or explicit invalidation changes; reuse routed steering output.
- Cache stationary minimap block rasters only for identical poses; draw moving and
  turning poses directly, keeping dynamic markers live.
- Avoid replacing unchanged streak HUD contents.
- Embed a generated transparent mobile-control atlas, preserving labels and
  accessibility names independently of artwork.
- Improve touch ownership, quick-tap sampling, cancellation and lifecycle resets;
  reuse analog movement output.
- Add mobile and performance regression suites and
  [a scoped verification/measurement report](PERFORMANCE_MOBILE_REPORT.md).

## Current limitations

`src/40_enemies.js` still forces the lightweight procedural box-man when `IS_TOUCH`
is true. These commits do not enable detailed articulated soldiers on phones.
Headless software-renderer measurements do not establish native-GPU performance
or physical-phone playability. See [README.md](README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) for testing and release requirements.
