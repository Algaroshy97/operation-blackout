# Changelog

Recent changes verified against the repository's commit history and diffs, newest
first. This is not a complete release archive. Commit titles are historical labels,
not proof of deployment status, device support or measured frame-rate improvements.

## v167 — Posthumous reward gating, spawn protection wiring, mode respawn lifecycle, and browser verification

- Restore dead-source gate on the player reward path in `src/40_enemies.js`:
  - In `damageEnemy`, gate hitmarker display, credit accrual, and field charge accumulation on `!isSourceDead`. Posthumous non-lethal damage applies to enemy health but awards no player rewards.
  - In `killEnemy`, gate score, credit multiplier, multi-kill streak bonuses, kill/headshot counters, killstreak registration, pickup/power-up drops, and kill confirmation audio on `isQualifyingKill = isPlayerKiller && isHostileTarget && !isSourceDead`. Posthumous kills continue to resolve physics, ragdolls, and mode death/kill hooks in the world without granting rewards to a dead player.
  - Add regression coverage in `tests/test_modes_and_teams.js` asserting reward effects themselves (counters, credits, hitmarker, streaks, drops) are withheld when player is dead and awarded when alive.
- Make spawn protection reachable in production gameplay in `src/20_player.js`, `src/60_hud_waves.js`, `src/40_enemies.js`, and `src/70_main.js`:
  - Initialize `player.spawnProtectionT = CORE.SPAWN_PROTECTION_DURATION` (2.0 s) on player deploy in `src/20_player.js` and reset it on redeploy in `resetGame()`.
  - Pass `{ elite: elite, spawnProtection: true }` in `spawnWaveEnemy` (`src/60_hud_waves.js:808`), naturally granting wave-spawned enemies 2 s of spawn protection.
  - Set 2 s spawn protection on mode-respawned actors in `src/35_modes.js`.
  - Preserve attack-triggered early cancellation across all weapons and grenades.
- Wire mode respawn framework into real production call paths in `src/35_modes.js`, `src/40_enemies.js`, and `src/70_main.js`:
  - Hook `activeMode.onDeath` into `killPlayer()` and `killEnemy()`. In Survival mode, allied bot deaths invoke `queueModeRespawn(victim)`.
  - In `MODES.survival.update(dt)` and `MODES.tdm.update(dt)`, invoke `updateModeRespawns(dt, ...)` each frame, decrementing respawn timers, selecting optimal cover spawn points via `CORE.pickBestSpawnPoint`, and reviving respawned actors with full health and spawn protection.
  - Implement `MODES.tdm` (Team Deathmatch) complete with target score tracking, match timer countdown, scoreboard integration, and `#match-hud` overlay (`src/00_head.html`) displaying the score bar and match timer, and push killfeed announcements on eliminations.
  - Add execution-level integration coverage in `tests/test_modes_and_teams.js` proving the production call path runs.
- Checkpoint serialization and defensive loading for new module state in `src/01_core.js`, `src/60_hud_waves.js`, and `src/70_main.js`:
  - Serialize `spawnProtectionT` and `modeRespawnQueue` in `CORE.makeCheckpoint`.
  - Validate and sanitize both fields in `CORE.validateCheckpoint`, defaulting to `0` and `[]` respectively when loading legacy checkpoints written by older builds.
  - Integrate save/resume roundtrip in `captureRunState` and `resumeRun`, asserting no duplicate and no lost respawns across save and restore boundaries.
- Tighten `CORE.isFriendlyFire` heuristic in `src/01_core.js`:
  - Require both actors to possess a genuine, identified matching team (`teamA === teamB`). Unidentified or team-less actors (no `team` property and not player) are never assumed friendly, preventing damage from team-less hostile actors against enemies or friendlies from being falsely negated.
  - Add unit test coverage in `tests/test_modes_and_teams.js` verifying team-less hostiles do not trigger friendly-fire negation.
- Extend bounded browser lifecycle verification in `scripts/probe_live.py`:
  - Add check `survival-deploy-live-state` asserting live gameplay state immediately after DEPLOY and loadout selection.
  - Add check `checkpoint-between-wave-save-resume` testing between-wave checkpoint write and state identity alongside defensive legacy save loading.
  - Add check `checkpoint-settled-victory-and-endless` testing settled victory screen presentation and endless mode continuation persistence.
  - Add check `friendly-bot-iff-and-friendly-fire-immunity` testing friendly bot team registration, IFF marker presence, minimap color, and mutual friendly-fire damage negation.
  - Add check `tdm-end-to-end-match-lifecycle` running a short TDM match end-to-end verifying HUD score bar, match timer countdown, kill feed announcements, respawn queuing, and match completion.


## v166 — Friendly bot visual kits, IFF markers, friendly fire immunity, and respawn lifecycle

- Implement friendly bot visuals, kit tints, and IFF marker integration in `src/38_soldier.js` and `src/40_enemies.js`:
  - `SOLDIER_FRIENDLY_KITS` provides tactical blue/navy camouflage uniforms across soldier archetypes.
  - `buildSoldier(kind, team)` supports team selection (`'friendly'` vs `'enemy'`), caching skinned templates per team key (`kind + '_' + team`).
  - Friendly soldiers spawn with an articulated, high-visibility cyan/blue IFF diamond marker (`iffMarker`, `0x38b6ff`) mounted above the head joint (`head`), tracking head kinematics and surviving rig cloning.
  - In low-detail/touch mode (`makeEnemyMesh`), friendly units receive team-tinted armor materials and an IFF indicator.
  - Minimap rendering in `src/60_hud_waves.js` maps friendly bot blips to friendly blue (`#4da6ff`) via `CORE.minimapActorColor(actor)` while preserving archetype colors for enemy hostiles.
- Implement friendly-fire damage negation in `src/40_enemies.js` and `src/20_player.js`:
  - `CORE.isFriendlyFire(attacker, target)` detects non-hostile interactions between allied actors.
  - `damageEnemy` checks target hostility and negates friendly fire by default, ensuring teammates cannot be damaged by allied bullets, melee, or explosions unless explicitly allowed.
  - `damagePlayer` prevents damage from allied sources.
  - Friendly grenade detonations (`src/55_grenades.js`) do not inflict blast damage on friendly bots.
- Implement tactical spawn-point scoring and respawn protection lifecycle in `src/01_core.js` and `src/35_modes.js`:
  - `CORE.RESPAWN_DELAY = 3.0` (3 s respawn timer) and `CORE.SPAWN_PROTECTION_DURATION = 2.0` (2 s spawn protection).
  - `CORE.scoreSpawnPoint(point, hostiles, colliders, opts)` evaluates spawn point safety away from hostile sight lines: penalizes close proximity (< 10 m), evaluates hostile yaw and forward field-of-view, applies heavy line-of-sight penalties for unobstructed hostiles facing candidate points, and scores points behind cover or outside hostile sight lines higher.
  - `CORE.pickBestSpawnPoint(spawnPoints, hostiles, colliders, opts)` selects the optimal spawn location from candidates.
  - `CORE.stepRespawnTimer`, `CORE.canRespawn`, `CORE.stepSpawnProtection`, and `CORE.isSpawnProtected` manage timer and protection states.
  - Mode respawn queue framework in `src/35_modes.js` (`queueModeRespawn`, `clearModeRespawns`, `updateModeRespawns`) manages actor respawn scheduling and spawn relocation; Survival mode preserves wave-based spawning and clears respawn queues on setup.
  - Spawn protection grants temporary damage immunity upon spawn; attacking (shooting/melee) breaks protection early.
- Fix friendly fire and hostility gating in `damageEnemy` (`src/40_enemies.js`), `damagePlayer` (`src/20_player.js`), and player weapon callers (`src/30_weapons.js`):
  - In `CORE.isFriendlyFire(attacker, target)`, check direct team matching (`teamA === teamB`) rather than checking `!isHostile(attacker, target)`, which previously caused dead actors to be erroneously treated as friendly-fire immune.
  - In `src/30_weapons.js`, propagate player identity through bullet and melee damage paths (`damageEnemy(..., player)`), preventing friendly bots from taking damage from production weapon callers.
  - In `damageEnemy`, check friendly-fire negation for the active source actor (`attacker || player`), preventing omitted-attacker caller signatures from bypassing friendly fire while preserving legitimate environmental damage and posthumous damage against opposing hostiles.
  - In `damagePlayer`, check friendly fire only when an allied `attacker` is provided, preventing incoming enemy projectiles fired before an enemy's death from being falsely negated.
  - Resolves live probe Check 8 failures where `damageEnemy(en, 200, ...)` with omitted attacker failed to damage enemies when player was dead, restoring ragdoll spawning (`corpses-capped`) and AI list clearance (`dead-leave-the-ai-list`).
- Fix `scoreSpawnPoint` obstacle cover evaluation in `src/01_core.js`:
  - Pass proper 6 endpoint coordinates with actor eye heights (`hx, hy, hz, px, spawnEyeY, pz`) to `segmentBlocked` followed by the collider array and slack, resolving a `TypeError` when evaluating facing hostiles in nonempty collider environments and properly rewarding occluded spawn points behind cover.
- Implement attack-triggered spawn protection cancellation across players and bots in `src/30_weapons.js`, `src/40_enemies.js`, and `src/55_grenades.js`:
  - Firing a gun (`fireShot`, `enemyShoot`, `breacherShoot`), executing melee (`doMelee`, bot melee initiation/strike), or throwing a grenade (`throwGrenade`, `throwEnemyGrenade`) immediately clears `spawnProtectionT = 0`, ensuring attacking actors become vulnerable upon offensive action.
- Add regression test suites in `tests/test_core.js` and `tests/test_modes_and_teams.js` covering friendly bot visual kits and IFF markers, friendly fire immunity across players, bots, and grenades (including production caller signatures with omitted attacker), attack-triggered spawn protection break-off for players and bots, occluded spawn scoring with real collider data without TypeError, mode respawn queues, and damage application regardless of dead attacker status or omitted attacker.
- Fix grenade-owner propagation into player friendly-fire guard and test harness in `src/55_grenades.js`, `src/20_player.js`, and `tests/test_modes_and_teams.js`:
  - In `explodeGrenade` (`src/55_grenades.js`), propagate the `owner` parameter to `damagePlayer(selfDmg, blastDeg, 'blast', owner)`, preventing allied bot grenade blasts from bypassing friendly-fire damage negation.
  - In `damagePlayer` (`src/20_player.js`), restrict friendly-fire immunity to allied non-player actors (`attacker !== player && !attacker.isPlayer`), preserving intentional self-damage from player-owned explosives while negating allied bot damage.
  - In `tests/test_modes_and_teams.js`, resolve vacuous grenade immunity verification by populating the production lexical `enemies` array directly rather than reassigning `c.enemies`, and include a hostile target that takes damage to prove blast damage execution.
  - Add regression coverage in `tests/test_modes_and_teams.js` verifying player blast damage negation for allied grenades alongside damage application for hostile, self-owned (`player` and `isPlayer`), unowned, and `CFG.friendlyFire`-enabled explosions.
- Local test verification: 526 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). The release artifact is 2,008,710 bytes (88,442 bytes under the 2 MiB budget limit). Bounded browser acceptance probe coverage gaps for Survival deployment, save/resume, checkpoints, and team interactions are retained in `ROADMAP.md`.

## v165 — Game modes foundation: MODES registry and team-aware AI targeting

- Observe the live music sequencer immediately after real UI deployment, before destructive combat probes can end the run; retain the existing running/layer/step assertions and additionally require the audio-clock scheduler to advance. A browser regression covers real deployment, scheduler progress, and death stopping playback without flag-only revival restarting it.

- Implement game modes registry and lifecycle interface in new module `src/35_modes.js`:
  - `MODES` registry with `registerMode(id, def)`, `getActiveMode()`, and `setActiveMode(id)` (default `'survival'`).
  - Standardized mode contract: `setup`, `onKill`, `onDeath`, `update`, `scoreboard`, and `isOver`.
  - Registered `survival` mode behind this interface (`MODES.survival`), delegating frame wave management to `updateWaves(dt)`, tracking resets via `setup()`, and preserving existing wave logic, scorestreaks, powerups, and checkpoints without modification.
  - Wired active mode lifecycle into `resetGame()`, `killPlayer()`, and the frame simulation tick in `src/70_main.js`, and `killEnemy()` in `src/40_enemies.js`.
- Implement team-aware actor hostility and threat selection rules in `src/01_core.js`:
  - `CORE.isHostile(actorA, actorB)`: mutual hostility across different teams; self and dead actors are never hostile; friendly teammates are non-hostile (friendly fire off); defaults player to `'friendly'` and enemies to `'enemy'`.
  - `CORE.pickNearestHostile(actor, candidates, maxRange)`: filters alive opposing-team actors, excludes teammates, and selects the nearest hostile candidate within range.
  - `CORE.modeScoreboardData(modeId, stats)`: formats and sanitizes scoreboard data across modes.
  - `CORE.isModeOver(modeId, state)`: evaluates game-over and death/downed rules per mode.
- Implement team-aware enemy AI targeting in `src/40_enemies.js`:
  - Every actor carries a `team` property (`player.team = 'friendly'` in `src/20_player.js`, `en.team = opts.team || 'enemy'` in `src/40_enemies.js`).
  - `findNearestHostileActor(en)` and `findHostileTarget(en)` dynamically evaluate all alive actors to acquire the closest hostile threat.
  - `hasLOS(en, target)`, `moveEnemy(en, dt, dist)`, `distToTarget(en, target)`, `vertGapToTarget(en, target)`, `enemyShoot(en, dist, target)`, `breacherShoot(en, dist, target)`, `throwEnemyGrenade(en, target)`, and melee resolve against the acquired hostile target.
  - Chase navigation in `moveEnemy(en, dt, dist)` respects selected hostile bot targets and retains the shared player flow field only for player-targeted actors.
  - Propagate attacking actor identity through `damageEnemy` and `killEnemy` across melee, rifleman fire, and breacher shotgun blast paths; pass verified killer actor to active mode `onKill` hook.
  - Restrict player rewards (kills, headshots, score, credits, streaks) and hitmarkers to qualifying hostile player kills, isolating bot-to-bot kills and friendly-fire deaths from player progression.
  - Gate delayed projectile and pellet impact callbacks (`enemyShoot`, `breacherShoot`) on paused and unstarted gameplay state across all targets.
  - In Survival mode, player remains the sole hostile target: all combat kinetics, cover checks, grenade arcs, and pushout mechanics operate identically to prior releases.
- Add test suites in `tests/test_modes_and_teams.js` and `tests/test_core.js` covering mode registry contracts, team hostility, threat prioritization over closer allies, target re-acquisition upon kill, target-aware navigation vectors, active bot-to-bot combat engagement, paused delayed impact gating, and kill attribution isolation (enemy-kills-friendly, friendly-kills-enemy, player-kills-enemy, and player-kills-friendly).
- Propagate grenade owner identity from bot throw through pooled projectile lifetime, detonation, and blast damage to the mode kill hook; bot blast kills no longer award player progression. Clear ownership on recycling and retain default player grenade rewards and existing blast damage behavior.
- Route bot-targeted chase around obstacles using cached target-cell flood distances with shared static walkability, without overwriting the player flow field or changing target acquisition. Full AI regressions cover both bot teams reaching a hostile behind a wall without teleport recovery.
- Follow-up regression verification: `node --test tests/*.js` passes 516/516 tests, including real grenade fuse/physics/detonation attribution, pooled ownership reset, player rewards, and 20-second obstacle-navigation simulations. Both blockers were reproduced by failing regressions before the production fixes. No build, browser probe, commit, push, or deployment was performed for this follow-up.
- Earlier local test verification: 511 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). The release artifact is 1,996,283 bytes (100,869 bytes under the 2 MiB budget). Browser acceptance probe and PR creation remain pending external wrapper execution.

## v164 — New weapons: M870 pump shotgun, M249 SAW, M1911 sidearm, and the breacher enemy

- **M870 Express** (index 4, `type: 'AR'`, `cls: 'SG'`):
  - 8 pellets × 16 damage in a fixed cone (`CORE.pelletConeSpread`, ADS ×`PELLET_ADS_TIGHTEN` 0.75). `fireShot()` now traces each pellet through the same round path (`traceRound()`), skips magnetism per pellet, and counts one shot once for accuracy.
  - Measured in a clear lane: about 125 damage at 3 m, about 70 at 6 m, falling off hard past 15 m.
  - Shell-by-shell reload (`CORE.loadShell`) that the trigger cancels.
  - Pump sound and fore-end/hand animation after each shot.
  - Viewmodel `vmBuildSG`: tube magazine, rib, bead and notch, or a red dot.
  - Rank 2; west-flank wall buy at 900.
- **M249 SAW** (index 5, `cls: 'LMG'`):
  - 100-round box at 760 rpm.
  - Barrel heat (`CORE.lmgHeatAfterShot`, `lmgHeatDecay`, `lmgHeatSpreadMul`, `lmgHeatRecoilMul`). It scales spread and kick quadratically, holds `LMG_HEAT_HOLD` 0.35 s after the last shot, then bleeds off. Every slot cools.
  - The shroud glows from a per-build emissive material, which `disposeGunModel()` now frees, and the gun sizzles when hot.
  - `adsSpeed` 0.72, `moveMul` 0.75, and a new `stfMul` 1.6 for sprint-to-fire.
  - Viewmodel `vmBuildLMG` with a side-hung ammo box that the reload drops.
  - Rank 4; east-flank wall buy at 1800.
- **M1911** (index 6, `cls: 'PST'`, `sidearm: true`):
  - Always carried in the new `SIDEARM_SLOT` 3 (key 4; the wheel and touch SWAP cycle through it).
  - The trigger on a gun with no mag and no reserve quick-draws it (`CORE.shouldQuickDrawSidearm`, `SIDEARM_QUICK_DRAW` head start).
  - Never a deploy pick, gunsmith entry, secondary unlock or wall-buy replacement.
  - Viewmodel `vmBuildPST` (walnut grip, sliding slide).
- **Breacher** (enemy kind 6, wave 7, weight 0.4):
  - 1.5× health and a helmet; charges at 1.2× walk speed and never flanks.
  - Fires a pump shotgun only inside `BREACHER_RANGE` 12 m with line of sight, every ~`BREACHER_ROF` 1.6 s. Its 8 pellets hit independently with a chance that falls with range (`CORE.breacherPelletHitChance`, `breacherPelletHits`). Measured at wave 1: about 34 damage per blast at 4 m, about 17 at 9 m, nothing past 12 m.
  - Same cover and smoke re-check at impact as a rifle round; a blast that lands nothing suppresses.
  - Dark kit with a red vest, a soldier shotgun model, and its own minimap and touch-mesh colours.
- Shared changes:
  - `CORE.weaponClassFireSound` picks `shotgun`/`lmg`/`pistol` and falls back to the type sound.
  - New sounds: `pump`, `shell_in`, `sizzle`.
  - Wall-buy prices by class (`sg` 900, `lmg` 1800).
  - Deploy cards show SHOTGUN / LIGHT MACHINE GUN and pellet damage.
  - The touch SWAP label shows the class.
- Add regression tests in `tests/test_core.js`, plus probe checks 113e–g covering shotgun range falloff and shell reload, LMG heat/glow/cooling, and the sidearm slot, quick draw and wall-buy safety.
- Local test verification: 502 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`), and 201/201 browser acceptance checks passing locally in headless Chromium (`scripts/probe_live.py`; probe checks 113e–h). Checkpoint/resume verified with the shotgun and LMG as picks. The release artifact is 1,987,467 bytes.

## v163 — Build comment stripping, grenade HUD warnings, near-miss suppression, wall occlusion, and an adaptive score

- Build headroom: `scripts/build.py` now drops full-line `//` comments from the shipped file (`strip_line_comments`). Each module keeps its banner line, which `tests/test_release_build.py` checks. The `src/` modules keep every comment. With this release's features included, the artifact goes from 2,096,877 to 1,968,167 bytes, 128,985 under the 2,097,152-byte budget.
- Live-grenade HUD warning (`CORE.grenadeWarnUrgency`, `CORE.GRENADE_WARN_MARGIN` = 1.3): each timed frag/semtex within its blast radius plus margin gets an arrow and icon on the hit-direction ring. It turns red and blinks as the fuse runs down or distance closes. Claymores, thermite, tacticals and the player's own mid-air throw stay quiet. Wired into `updateGrenadeWarnings()` in `src/60_hud_waves.js`.
- Near-miss suppression (`CORE.suppressionAdd`, `CORE.suppressionDecay`, `CORE.SUPPRESS_HOLD` = 0.6 s). It applies to misses that already play `bulletWhizSound` and have a clear line to the player. Each one draws a grey arc toward the shooter and stacks suppression, which holds and then bleeds off. A `#suppress-vignette` darkens the edges on every quality level. With post-FX, the composite pass also desaturates and blurs them; the blur is off under reduced motion.
- Wall occlusion for positional audio (`CORE.occludedCutoff`, `CORE.occludedGain`, `CORE.OCCLUDED_CUTOFF` = 700 Hz, `CORE.OCCLUDED_GAIN` = 0.55). `playSound3D()` checks the segment from the player to the source; a blocked sound is capped below air absorption's cutoff and played quieter.
- Adaptive score:
  - Replaces the sawtooth drone and the per-frame noise pulse, which crackled at low frame rates, with a look-ahead sequencer on the audio clock in `src/50_vfx_audio.js`.
  - The music is an i–VI–iv–V cue in D minor at 104 bpm. Layers are a pad, bass ostinato, drums, brass swells and a sixteenth-note arpeggio. They follow `CORE.combatIntensity` via `setTargetAtTime`, through a generated-impulse reverb and a compressor.
  - Pure rules: `CORE.musicLayerGains`, `musicDrumHits`, `musicBassNote`, `musicArpNote`, `musicChordAt`, `musicChordChanges`, `musicStepSeconds`, `midiToHz`. The tension/filter/pulse helpers are removed.
- Add `ROADMAP.md` (six milestones: weapons, game modes, a second map, Survival objectives and extraction, feel and AI, retention).
- Add regression tests in `tests/test_core.js`, plus probe checks 113a–d: `grenade-warning-*`, `near-misses-build-suppression`, `suppression-bleeds-off`, `occluded-sounds-are-muffled`, `music-sequencer-running`. The adaptive-music contract check is updated for the new rules.
- Local test verification: 498 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`), and 193/193 browser acceptance checks passing locally in headless Chromium (`scripts/probe_live.py`).

## v162 — Ballistic tracer caliber scaling and impact flash sphere dimensions

- Implement ballistic tracer caliber dimensions and thickness scaling (`CORE.tracerCaliberScale`, `CORE.tracerThicknessScale`, `CORE.TRACER_CALIBER_SCALE_SMG` = 0.80, `CORE.TRACER_CALIBER_SCALE_AR` = 1.00, `CORE.TRACER_CALIBER_SCALE_BR` = 1.30, `CORE.TRACER_CALIBER_SCALE_SR` = 1.75): scales ballistic tracer geometry thickness based on caliber ergonomics (SMG 0.80x, AR 1.00x, BR 1.30x, SR 1.75x) for both initial mesh sizing and lifecycle thickness decay; wired into `spawnTracer()` and `updateVfx()` in `src/50_vfx_audio.js`, player firing in `src/30_weapons.js`, enemy shooting in `src/40_enemies.js` via `CORE.enemyWeaponType()`, and sentry turret fire in `src/58_streaks.js`.
- Implement ballistic impact flash sphere caliber scaling (`CORE.impactFlashCaliberScale`, `CORE.impactVfxScale`, `CORE.IMPACT_FLASH_SCALE_SMG` = 0.75, `CORE.IMPACT_FLASH_SCALE_AR` = 1.00, `CORE.IMPACT_FLASH_SCALE_BR` = 1.25, `CORE.IMPACT_FLASH_SCALE_SR` = 1.60): scales impact flash sphere mesh dimensions and lifetime expansion by weapon caliber; wired into `spawnImpact()`, record pooling, and `updateVfx()` in `src/50_vfx_audio.js`.
- Add unit and integration regression suites in `tests/test_combat_balance_integration.js` and `tests/test_core.js`, plus contract check 112 (`ballistic-tracer-and-impact-flash-rules`) in `scripts/probe_live.py`.
- Compact pure core validations, locomotion kinetics, and combat helper functions in `src/01_core.js`, keeping release artifact `dist/Operation Blackout.html` at 2,096,877 bytes (under the 2,097,152-byte budget limit).
- Local test verification: 495 Node tests passing (`node --test tests/*.js`), 15 release build tests passing (`python3 -m unittest tests.test_release_build`). Browser acceptance, commit, push, and deployment remain pending external wrapper execution.

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
