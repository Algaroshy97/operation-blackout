# Changelog

Recent changes verified against the repository's commit history and diffs, newest
first. This is not a complete release archive. Commit titles are historical labels,
not proof of deployment status, device support or measured frame-rate improvements.

## v161 — Mobile optical look sensitivity scaling, touch action availability, and empty control pointer-events

- Implement optical ADS and sniper scope look sensitivity scaling (`CORE.touchLookSensitivity`, `CORE.TOUCH_ADS_SENSITIVITY_MUL` = 0.65, `CORE.TOUCH_SCOPED_SENSITIVITY_MUL` = 0.40, `CORE.TOUCH_STEADY_SENSITIVITY_MUL` = 0.25): scales touch drag look factor down when aiming down sights (0.65x), scoped in with sniper rifle (0.40x), or holding breath / steadying aim (0.25x) for fine-grained target acquisition on touchscreens; wired into `touchLookFactor()` in `src/25_touch.js` affecting `lookMove()`, `fireLookMove()`, and `onGyroOrientation()`.
- Implement touch action availability validation (`CORE.isTouchActionAvailable`): validates contextual action availability states (`ammo`, `reserve`, `hasWeapon`, `streakActive`, `hasUsePrompt`) before permitting touch control interactions.
- Implement empty control pointer-events suppression (`body.touch #tbtn-swap.empty,body.touch #tbtn-streak.empty,body.touch #tbtn-use.empty { pointer-events: none; }` in `src/00_head.html`) so non-functional contextual buttons do not intercept touch input, and clean crawl class cleanup in `releaseTouches()` in `src/25_touch.js`.
- Add unit and integration regression suites in `tests/test_mobile_optimization.js` and `tests/test_core.js`, plus contract check 111 (`mobile-optical-sensitivity-and-action-rules`) in `scripts/probe_live.py`.
- Compact pure core validations, enemy AI state kinetics, and ballistic helper functions in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,932 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 493 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## v160 — Ballistic enemy raycast spatial culling and grenade blast delta distance performance optimization

- Implement ballistic enemy raycast spatial culling (`CORE.isEnemyRayCandidate`, `CORE.ENEMY_RAY_BOUNDING_RADIUS` = 1.8, `CORE.ENEMY_RAY_CENTER_OFFSET_Y` = 0.9): evaluates forward ray projection and squared perpendicular distance against spherical bounding volume to eliminate off-axis, behind-the-camera, and out-of-range enemies with arithmetic before Three.js recursive hierarchy traversal; wired into `fireShot()` and `updateMarksmanScope()` in `src/30_weapons.js`.
- Implement grenade blast delta distance reuse (`CORE.blastTargetDistance`): reuses precalculated relative displacement deltas via `Math.hypot(dx, dy, dz)` rather than invoking redundant Three.js Vector3 `distanceTo` calls after `CORE.isTargetInBlastRadius`; wired into `explodeGrenade()` in `src/55_grenades.js`.
- Add unit and regression suites in `tests/test_performance_optimization.js` and `tests/test_core.js`, plus contract check 110 (`performance-optimization-v160-rules`) in `scripts/probe_live.py`.
- Compact pure core validations and helper functions in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,737 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 491 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## v159 — Tactical combat balance: weapon empty reload caliber scaling, enemy scout archetype combat tuning, and fast hands plate insertion agility

- Implement weapon empty reload caliber scaling (`CORE.weaponEmptyReloadMultiplier`, `CORE.effectiveReloadDuration`): scales tactical empty reload duration based on caliber ergonomics — SMG (1.10x), AR (1.15x), BR (1.22x), and SR (1.30x) instead of a flat 1.15x multiplier; wired into `updateWeapons()` in `src/30_weapons.js`.
- Implement enemy scout archetype combat tuning (`CORE.enemyWeaponType`, `CORE.enemyRangedDamage`): assigns lightweight SMG (`'SMG'`) weapon type to scout hostiles (`kind === 4` or `kind === 'scout'`, standard and elite) and applies scout ranged damage penalty (`ENEMY_RANGED_SCOUT_PENALTY` = -1) to match fast flanking combat identity; wired into enemy weapon initialization and shooting in `src/40_enemies.js`.
- Implement Fast Hands perk armor plating agility (`CORE.plateApplyDuration`, `FAST_HANDS_PLATE_MUL` = 0.80): reduces armor plate insertion duration by 20% (1.60s vs standard 2.0s) when Fast Hands perk is active; wired into `usePlate()` and `updateStations()` prompt calculations in `src/57_stations.js`.
- Add unit and integration regression suites in `tests/test_combat_balance_integration.js` and `tests/test_core.js`, plus contract check 109 (`tactical-combat-balance-v159-rules`) in `scripts/probe_live.py`.
- Compact pure core validations and helper functions in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,097,007 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 489 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## v158 — Tactical audio polish: enemy gunfire archetype acoustics, armor damage absorption gating, and chamber-empty caliber clack

- Implement enemy gunfire archetype acoustics (`CORE.enemyGunfireSound`): Tank enemies (`en.kind === 2` or `en.kind === 'tank'`) fire heavy battle rifle rounds and now trigger the punchier elite gunfire sound (`'eshot_elite'`) rather than the lightweight runner rifle shot; wired into `enemyShoot()` in `src/40_enemies.js`.
- Implement armor damage absorption gating in player hit acoustics (`CORE.armorDamageSound`): clean `absorbedDamage` gating prevents non-absorbed damage (such as fall damage or damage bypassing armor) from playing the metallic `'block'` cue when armor plates are equipped; wired into `damagePlayer()` in `src/20_player.js`.
- Implement weapon chamber-empty caliber clack (`CORE.chamberEmptySound`): heavy caliber weapons (`SR` and `BR`) produce a distinct heavy mechanical clack (`DRY_FIRE_HEAVY_SOUND = 'dry_heavy'`) on the final empty shot, while standard and lightweight weapons retain the crisp chamber clack (`'chamber_empty'`); wired into `fireShot()` in `src/30_weapons.js`.
- Implement tactical equipment detonation acoustic range rules (`CORE.tacticalDetonationMaxDist`, `CORE.TACTICAL_DETONATION_MAX_DIST_BLIND`, `CORE.TACTICAL_DETONATION_MAX_DIST_SMOKE`): 85m for smoke canisters and 65m for flashbangs; wired into `applyTactical()` in `src/55_grenades.js`.
- Add unit and integration regression suites in `tests/test_combat_balance_integration.js` and `tests/test_core.js`, plus contract check 108 (`tactical-audio-polish-v158-rules`) in `scripts/probe_live.py`.
- Compact pure core helper definitions, ragdoll kinematics, and explosion/trail parameter mappings in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,940 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 487 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## v157 — Ballistic casing caliber dimensions, eject kinematics, and tactical slide dust puff scaling

- Implement ballistic casing caliber dimensions and ejection impulse scaling (`CORE.casingCaliberScale`, `CORE.casingEjectImpulse`, `CORE.casingScale`, `CORE.casingEjectVelocity`): SMG (0.75 scale, 1.15 impulse), AR (1.0 scale, 1.0 impulse), BR (1.25 scale, 0.90 impulse), and SR (1.60 scale, 0.75 impulse); wired into spent casing spawning and fade lifecycle in `src/50_vfx_audio.js`.
- Implement action-specific tactical slide and locomotion dust puff scaling (`CORE.slideDustVfxParams`): action-tuned particle counts, spread, and puff scales for slide start (7 puffs, 1.15 spread, 1.05 scale), slide-jump boost (9 puffs, 1.35 spread, 1.25 scale), slide cancel (5 puffs, 0.90 spread, 0.85 scale), mantle grab (6 puffs, 1.00 spread, 0.95 scale), and slide stop (4 puffs, 0.75 spread, 0.75 scale), with speed-dependent scaling; wired into `src/20_player.js`, `src/50_vfx_audio.js`, and `src/48_particles.js`.
- Add regression suites in `tests/test_combat_balance_integration.js` and `tests/test_core.js`, plus live-check 107 (`ballistic-casing-and-slide-dust-vfx-rules`) in `scripts/probe_live.py`.
- Compact pure core validations, locomotion audio, and combat kinematics in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,687 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 485 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## v156 — Touch control activation gating, downed action key sanitization, and locked control pointer-events

- Implement universal touch control activation gating (`CORE.canTouchControlActivate`): cleanly checks lifecycle state (`started`, `paused`, `isDead`, `isDowned`, `isEditing`) and prevents inactive or dead/downed buttons from activating, gaining the `'on'` visual class, or triggering click audio; wired into `holdBtn()`, `fireBtn()`, and `tbtn-pause` in `src/25_touch.js`.
- Implement downed input key sanitization (`CORE.isActionKeyLockedWhileDowned`, `CORE.sanitizeDownedInputKeys`): cleanly releases locked inputs (`Space`, `KeyC`, `Mouse2`, `KeyG`, `__use`, `__melee`, `__plate`, `__tactical`, `__streak`, `__field`) and clears `adsHeld` / `touchState.ads` when player enters the downed state; wired into `applyTouchInput()` in `src/25_touch.js`.
- Add locked touch control pointer-events gating (`body.touch .tbtn.locked { pointer-events: none; }`) in `src/00_head.html` to prevent touch event consumption on locked buttons during gameplay.
- Add regression suites in `tests/test_mobile_optimization.js` and `tests/test_core.js`, plus live-check 106 (`mobile-touch-activation-and-downed-key-rules`) in `scripts/probe_live.py`.
- Compact pure core validations, blood pool/scorch, sentry kinematics, and combat acoustics in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,739 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 483 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## v155 — Ragdoll blast spatial culling, particle squared-distance gating, impulse scaling, and aim assist cosine selection

- Implement soldier ragdoll blast spatial pre-culling and impulse calculation (`CORE.isRagdollInBlastRadius`, `CORE.isRagdollParticleInBlast`, `CORE.ragdollBlastImpulse`, `CORE.nearestRagdollParticle`, `CORE.RAGDOLL_BLAST_BOUNDING_RADIUS`): spatial distance-squared bounding box and per-particle culling to eliminate redundant updates on distant ragdoll corpses; wired into `sdRagdollBlast` and `sdStartRagdoll` in `src/38_soldier.js`.
- Implement aim assist candidate cosine dot-product selection and scoped head-target priority (`CORE.isAimAssistHeadCandidateCos`): evaluates angle cone thresholds directly in cosine space without per-frame `dir.angleTo` / `Math.acos` trigonometric calls while ADS; wired into `applyAimAssist` in `src/30_weapons.js`.
- Add dedicated performance optimization suite in `tests/test_performance_optimization.js` (13 tests) and pure core unit coverage in `tests/test_core.js`, plus live-check 105 in `scripts/probe_live.py`.
- Compact pure core validations, clamp expressions, and object property shorthands in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,037 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 481 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## v154 — Weapon shot kick impulses, stance ADS agility, and enemy ranged damage scaling

- Implement weapon shot kick impulse scaling (`CORE.weaponShotKickImpulse`): SMG (0.35), AR (0.50), BR (0.70), and SR (1.10), with 15% suppressor kick dampening (`SUPPRESSOR_KICK_MUL` = 0.85); wired into `fireShot()` in `src/30_weapons.js`.
- Implement stance ADS agility multipliers (`CORE.stanceAdsSpeedMultiplier`): 15% ADS acceleration while crouching (`STANCE_ADS_CROUCH_MUL` = 1.15) and 20% penalty while sliding (`STANCE_ADS_SLIDE_MUL` = 0.80); wired into `CORE.weaponAdsSpeed` and `updateViewmodel()` in `src/30_weapons.js`.
- Implement enemy archetype ranged damage scaling (`CORE.enemyRangedDamage`): +3 caliber bonus for heavy tank enemies (`ENEMY_RANGED_TANK_BONUS`) and -2 damage penalty for shield units (`ENEMY_RANGED_SHIELD_PENALTY`); wired into enemy shooting in `src/40_enemies.js`.
- Add integration and unit regression suites in `tests/test_combat_balance_integration.js` and `tests/test_core.js`, plus built-game probe contract checks in `scripts/probe_live.py`.
- Compact pure core validations and object checks in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,795 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 479 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

## Reconstructed / partial — updates after the documented v116 baseline

The following 40 commit entries were reconstructed from each commit's actual
source/test/probe diff and file statistics, not inferred from its release title.
They summarize implementation and regression additions, not historical test runs,
deployments, device verification or measured performance. Version labels in those
commits are historical and may overlap earlier entries. Newest first:

- `e61067b`: Add weapon-specific scope sounds, casing-bounce acoustics, tank kill
  confirmation and secondary-unlock/station-cycle audio rules, with core and integration regressions.
- `d53f567`: Add surface-dependent ballistic dust/chip/spark and light parameters,
  plus blood-spatter kinematics; add core and integration regressions.
- `ca15632`: Gate virtual joystick feedback and touch controls during dead/downed
  states, with joystick change-detection and core/integration regressions.
- `386e708`: Pack flow-field queue coordinates, check diagonal walkability, cull
  distant footsteps and gate remaining-hostiles updates; add core/integration regressions.
- `5472bac`: Add weapon-specific sprint-to-fire timing, sprint stance spread and
  armor-plate action/movement gating; add core and integration regressions.
- `6725233`: Differentiate dry-fire, resource-pickup, moving melee and ordnance
  explosion audio, with core and integration regressions.
- `3f94f97`: Parameterize explosion effects/lights, sniper vapor trails and enemy
  muzzle flashes; add core and integration regressions.
- `9fcfa4f`: Extend dead-state lockouts to tactical/equipment, streak, weapon-swap
  and station controls and labels; add core and integration regressions.
- `3a1a44e`: Use squared-distance checks for bullet magnetism, munitions boxes and
  objective zones; gate objective-ring opacity updates and add timer/core/integration regressions.
- `b7dda91`: Tune weapon recoil decay, empty-weapon swap speed and tactical-sprint
  slide momentum; add core and integration regressions.
- `1a5626c`: Differentiate enemy footsteps, weapon reload-magazine audio and melee
  surface strikes, with core and integration regressions.
- `df7a790`: Add melee slash/backstab effects and weapon/suppressor-specific muzzle
  light parameters; add core and integration regressions.
- `5f59db2`: Gate dead-state fire/reload, slide, melee and jump controls and labels;
  add action-capability and locked-style core/integration regressions.
- `ef8a425`: Add aim-assist range/cosine checks and hit-arc opacity change detection,
  with core and integration regressions.
- `1817f67`: Tune weapon-class bloom accumulation and tactical-sprint melee momentum;
  gate armor-plate use and add core/integration regressions.
- `87a7fa9`: Add shield-deflection, helmet-hit and heavy-landing sound rules, with
  core and integration regressions.
- `15b4b77`: Add shield-deflection effects, helmet-headshot detection and landing
  dust parameters, with core and integration regressions.
- `8f8dcdd`: Gate downed weapon switching and ADS, update touch labels/reload state,
  and add core and integration regressions.
- `57a4f7e`: Gate grenade-charge HUD changes, use squared tactical/cone range checks
  and dot-product bullet-magnet selection; add core and integration regressions.
- `da4151c`: Tune weapon ADS movement, empty reloads, bloom recovery and enemy
  archetype melee damage, with core and integration regressions.
- `926ff10`: Add slide-jump, empty-chamber, grenade cooking/throw and enemy melee
  impact audio rules, with core and integration regressions.
- `ed21ab0`: Add tactical detonation lights/particles and helmet-dependent headshot
  effects, with core and integration regressions.
- `5954e51`: Gate downed equipment, streak, field-upgrade and station actions and
  touch labels, with core and integration regressions.
- `666cc98`: Gate countdown/downed-timer/flash-overlay updates, use squared blast
  checks and parameterize ragdoll momentum; add core and integration regressions.
- `7d91196`: Add damage-type armor absorption including fall-damage bypass, plus
  weapon-class switch/ADS handling rules; add core and integration regressions.
- `ed5652c`: Differentiate melee/backstab, through-cover hitmarker, tactical-sprint
  footstep and landing audio; add core and integration regressions.
- `86adc7a`: Add sentry muzzle/light kinematics, penetration-cover impact gating
  and world melee strike effects; extend core/integration tests and adjust probe expectations.
- `7599eb2`: Transform gyro look deltas by screen orientation, add independently
  sanitized gyro sensitivity, and request fullscreen/landscape without the portrait
  overlay; update core/mobile regressions.
- `343e563`: Add a portrait-phone landscape instruction overlay and optional
  landscape-lock request, with a mobile source regression. The later `7599eb2`
  change removes the overlay; this entry records history, not current behavior.
- `0cf5df2`: Add gyroscope look input plus downed touch-control, pause-feedback,
  editor-selection and streak-HUD inset changes; add core/mobile/integration regressions.
- `0955628`: Replace stale reload-sound acceptance expectations with ordered
  `plate_insert`/`plate_lock` cues and intermediate/final armor, plate-count and
  timer assertions; add Python probe-contract regressions.
- `b90a8b2`: Add spatial-audio range culling, forward-sector aim gating and enemy
  overlap prechecks; pool grenade records and wall-buy offer output, with core/integration regressions.
- `028d421`: Add weapon-class ballistic falloff, target-evasion accuracy rules and
  melee backstab/momentum behavior, with core and integration regressions.
- `810a52e`: Add suppressed weapon fire, dedicated plate insert/lock, tinnitus and
  flesh-hurt audio rules, with core regressions.
- `a983b64`: Add expanding/fading blood pools, settled-corpse pooling rules and
  textured bullet-hole decals, with core regressions.
- `b715460`: Sanitize touch layout dimensions/coordinates, clamp look jumps and
  gate gameplay/pause/empty control states; add core/mobile regressions.
- `92c5dd4`: Reuse shadow-caster and particle-layer data, add sentry squared-range
  checks and gate pickup-opacity writes; add core/integration regressions.
- `2e7dbc0`: Tune stance spread, blast camera shake, weapon-class headshot
  multipliers and enemy accuracy rules, with core regressions.
- `d2b781f`: Add critical-health heartbeat timing, elite enemy gunfire and
  distance-dependent audio filtering, with core regressions.
- `61315e6`: Add persistent blast scorch decals, expanding shockwaves and enemy
  muzzle lights, with core visual-rule regressions.

## v117 — Longer sprint, quicker stamina recovery

- Extend normal sprint from 3.2 to 8 seconds; recover a fully empty bar in
  4 seconds instead of about 4.57 seconds.
- Clear exhaustion at 20% stamina (0.8 seconds from empty), rather than 35%
  (1.6 seconds); holding sprint still waits for recovery before resuming.
- Preserve tactical sprint's 2.5-second burst, 1.25x speed and 2.2x drain,
  normal movement speeds and combat behavior.
- Add real-config/controller lifecycle regression tests for duration, recovery,
  held-sprint hysteresis, repeated bounded cycles and tactical sprint; extend
  the built-game browser acceptance probe with eight stamina lifecycle checks.

## v116 — Configurable graphics across devices

- Add saved independent enemy/scenery detail, particles/effect lights, ragdolls,
  shadow quality and bloom/colour-grading settings to the existing generated UI.
  Explicit detailed/full/high/on choices work on touch; auto retains device defaults.
- Latch enemy/scenery detail until page reload to avoid destructive combat rebuilds.
  Apply effect/ragdoll/shadow/post-processing budgets live, clean retired resources,
  and retain gameplay hazards, cover, collisions, input controls and combat rules.
- Preserve desktop texture filtering; explicit high enables it on touch. Keep the
  existing resolution setting instead of adding a duplicate. Map retired soft
  shadow filtering to supported PCF in the bundled Three.js r184.
- Return detached simple-ragdoll limbs to their owning group before retirement
  disposal, so lowering the live budget frees their geometry and cloned materials.
- Document the pre-existing simple/detailed hit-geometry mismatch rather than
  claiming strict gameplay neutrality; no shooting/combat behavior is changed here.
- Keep shadow and post-processing controls independent of adaptive resolution and
  unrelated GPU targets. Apply combined renderer settings once on reset/startup,
  avoiding three successive post-target allocation/disposal cycles.
- Add schema/storage/reset/lifecycle regressions and real touch-browser acceptance
  for UI persistence, detailed/simple actors and scenery, resource disposal, and
  switching. These checks do not establish physical-phone FPS or native-GPU support.

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

Under `auto`, `src/40_enemies.js` retains the lightweight procedural box-man when `IS_TOUCH`
is true; explicit `detailed` enables articulated procedural soldiers on touch devices too.
However, note the known hit-geometry mismatch between simple and detailed models.
Headless software-renderer measurements do not establish native-GPU performance
or physical-phone playability. See [README.md](README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) for testing and release requirements.
