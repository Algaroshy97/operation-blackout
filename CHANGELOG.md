# Changelog

Recent changes verified against the repository's commit history and diffs, newest
first. This is not a complete release archive. Commit titles are historical labels,
not proof of deployment status, device support or measured frame-rate improvements.

## v177.1 — Snow footprint height depression fix and production texture/sky test execution

- **Snow footprint generation fix (`src/08_textures.js`).**
  - Fixed snow footprint generation in `src/08_textures.js`: changed `g.ellipse(px, py, 7, 3.5, a, 0, 7)` to `h.ellipse(px, py, 7, 3.5, a, 0, 7)` following `h.beginPath()`. Previously, `h.fill()` filled an empty path so the `#686868` (height value 104) footprint depressions never reached the height field or the derived tangent-space normal map.
  - Added `heightCanvas: hgt.c` export on `makeSurface` so generated height field data is accessible for testing and verification.
- **Production texture and sky preset integration in tests (`tests/test_modes_and_teams.js`).**
  - Replaced manually supplied `TEX` stubs and hand-written `applyMapSkyPreset` mock in `createFullMatchContext()` with production implementations:
    - Executed production `src/08_textures.js` with an in-memory software 2D canvas context, generating real procedural textures (`TEX.snow`, `TEX.frostedMetal`, `TEX.frostedWood`, `TEX.asphalt`).
    - Executed production `applyMapSkyPreset` from `src/10_config_world.js` and wired `c.scene` (background and fog), `c.SKY_UNIFORMS`, `c.sun`, `c.SUN_OFFSET`, and `c.groundMat`.
  - Updated integration test `milestone 3: procedural snowy textures and sky preset application on activeMap switch` to assert:
    - Generated texture data: verified presence of `TEX.snow.map`, `TEX.snow.normalMap`, `TEX.frostedMetal`, `TEX.frostedWood`, `TEX.asphalt`, and asserted footprint depression height data (`#686868` / value 104) and normal map deviations.
    - Bidirectional sky, fog, sun, and ground material changes when switching between `'snowy'` and `'urban'`.
  - Added regression test `regression [P2]: src/08_textures.js snow footprint generation draws on height canvas and produces depression height data`.
- **Release build budget & coverage.**
  - Rebuilt single-file release HTML (`dist/Operation Blackout.html`) at 2,043,562 bytes (53,590 bytes below the 2 MiB budget).
  - 604/604 Node tests passing across `tests/*.js` (429 in `test_core.js`, 91 in `test_modes_and_teams.js`).
  - 15/15 release-build integrity tests passing (`python3 -m unittest tests.test_release_build`).

## v177 — Milestone 3: Snowy textures, icy sky preset, and deploy map selector UI

- **Snowy textures & visual assets (`src/08_textures.js`, `src/10_config_world.js`).**
  - Added procedural canvas textures in `src/08_textures.js`:
    - `TEX.snow`: undulating snowdrifts, powder speckle, and footprint impressions.
    - `TEX.frostedMetal`: rime along seams, ice crystals, and cold steel highlights.
    - `TEX.frostedWood`: frosted grain grooves and plank rime.
  - Added `MAT.frostedMetal` and `MAT.frostedWood` in `src/10_config_world.js`.
  - Sourced Snowy Compound arena models with frosted materials and dynamic ground texture swapping.
- **Icy blue sky preset & low sun lighting (`src/01_core.js`, `src/10_config_world.js`).**
  - Added pure `sky` definitions in `CORE.MAP_DEFS.urban` (warm sunset peach horizon, high sun `[45, 55, -30]`, dark slate fog) and `CORE.MAP_DEFS.snowy` (frosty white-blue horizon `0xd4e6f4`, low sun `[50, 24, -35]` casting long winter shadows, atmospheric fog `0x7892ad`).
  - Added `applyMapSkyPreset(mapId)` dynamically updating `SKY_UNIFORMS`, `sun` color/position/offset, `scene.fog`, `scene.background`, and swapping `groundMat` between `TEX.asphalt` and `TEX.snow` (with roughness/tint adjustments). Integrated into `buildArena()` and `rebuildMapEnvironment()`.
- **Deploy-screen map selector UI & per-map career stats (`src/00_head.html`, `src/70_main.js`, `src/01_core.js`).**
  - Added `#map-row` to the deploy modal `#gun-select` with `#map-btn-urban` and `#map-btn-snowy` buttons.
  - Implemented `buildMapPickerRow()` generating map selection buttons with active selection highlighting, keyboard support, and subtitle displaying per-map career best score (`· Best X`).
  - Generalized career stats in `CORE.defaultStats()`, `CORE.sanitizeStats()`, and `CORE.mergeRunIntoStats()` to track `mapStats.urban` and `mapStats.snowy` independently (`bestScore` and `bestWave`).
  - Sourced active map in `recordRun()` callers to update the corresponding map's career record upon gameover/settlement.
- **Release build budget management (`scripts/build.py`).**
  - Updated `scripts/build.py`'s `strip_line_comments` to strip leading indentation on bundled JavaScript code lines. This reduced the single-file release HTML build (`dist/Operation Blackout.html`) to 2,043,541 bytes (53,611 bytes below the 2 MiB ceiling) while preserving all code comments and formatting in source files.
- **Coverage.**
  - Added unit tests in `tests/test_core.js` verifying `CORE.MAP_DEFS` icy blue sky preset/low sun lighting for Snowy Compound and independent per-map career stats tracking.
  - Added integration tests in `tests/test_modes_and_teams.js` verifying deploy-screen map selector UI, activeMap switching, per-map best score display, procedural snowy textures and sky preset application, and full Survival gameplay lifecycle on Snowy Compound with active combat, enemies, and per-map stat recording.
  - 603/603 Node tests passing (`node --test tests/*.js`).
  - 15/15 release-build integrity tests passing (`python3 -m unittest tests.test_release_build`).

## v176 — Map-switch lifecycle, Snowy district barriers, and Survival checkpoint preservation

- **Map-switch lifecycle (`src/10_config_world.js`, `src/02_settings.js`, `src/70_main.js`).**
  - Completed `setActiveMap(id, force)` lifecycle to rebuild map-owned environment (`rebuildMapEnvironment()`) when map changes or is forced: clears old static batches, colliders, district barriers, stations, and open districts via `clearMapGeometry()`, rebuilds arena (`buildArena()`), stations (`buildStations()`), district barriers (`buildDistrictBarriers()`), flushes static batches, and rebuilds both `worldRayGrid` and `navGrid`.
  - Props added during `scatterProps()` are tagged with `.isProp = true` so they persist through map transitions without leaking static batches.
  - Sourced player spawn position dynamically from active map in `resetGame()`, ensuring player spawns at the correct coordinate on snowy compound and urban arena.
  - Sourced map setting dynamically in `startGame()` and ensured `setSetting('gameMap', mapToRestore)` synchronizes settings with active map on checkpoint resume.
- **Snowy district barriers & purchasing (`src/01_core.js`, `src/57_stations.js`).**
  - Added barrier definitions for Snowy Compound in `CORE.SNOWY_BARRIERS` (`hangar` door and `depot` door/wall) and wired them into `CORE.MAP_DEFS.snowy.barriers`.
  - Generalized `CORE.districtByKey(key, mapId)` to look up districts across map definitions and the active map, fixing lookup for `'hangar'` and `'depot'`.
  - Updated `buildStations()` in `src/57_stations.js` to preserve station district identifiers (`district: def.district || null`) and clear previous stations on rebuild.
  - Updated `buildDistrictBarriers()`, `getDistrictBarriers()`, and `resetDistricts()` to derive barriers dynamically from the active map instead of hardcoded urban barriers, and added `clearDistrictBarriers()` for clean map switching.
- **Survival checkpoint mapId & district preservation (`src/01_core.js`, `src/70_main.js`).**
  - Updated `CORE.makeCheckpoint` to serialize sanitized `mapId` (defaulting to `'urban'`).
  - Updated `CORE.validateCheckpoint` to retain sanitized `mapId` (defaulting legacy checkpoints to `'urban'`), and validate `openDistricts` against the specific map's district keys (`getMapDef(mapId).districts`), safely filtering out cross-map invalid keys.
  - Updated `resumeRun()` in `src/70_main.js` to restore `mapId` via `setActiveMap()`, update `gameMap` setting, reset `openDistricts`, and open purchased districts.
- **Release build budget management (`scripts/build.py`).**
  - Updated `scripts/build.py` to strip CSS block comments from `00_head.html` and drop empty lines in bundled JavaScript modules. This brought the release build (`dist/Operation Blackout.html`) down to 2,095,205 bytes (1,947 bytes below the 2 MiB budget) while keeping all comments intact in source files.
- **Coverage.**
  - Added new regression tests in `tests/test_core.js` and `tests/test_modes_and_teams.js` verifying:
    - Map-switch lifecycle rebuilding geometry, stations, barriers, navigation in both directions, and team deployment (TDM and Domination).
    - Snowy district barrier purchasing, opening, resetting for both hangar and depot gates with real colliders, door meshes, and navigation updates.
    - Survival checkpoint serialization, validation, and resume on Snowy compound with physical arena restoration and district unlocking.
  - Added browser acceptance checks in `scripts/probe_live.py`:
    - `snowy-survival-checkpoint-and-arena-restoration`: verifies checkpoint round-trip and `resumeRun()` on Snowy Compound with physical arena colliders, station layout, door collider/mesh removal, and nav grid reachability into the purchased hangar district.
    - `snowy-map-switch-lifecycle-and-team-mode`: verifies switching in both directions (urban -> snowy -> urban), barrier/station/collider restoration, purchasing/resetting depot and hangar gates, and team-mode deployment (TDM 12-actor roster and spawn sourcing, Domination flags and objective steering) under Snowy Compound.
    - Enhanced `checkpoint-between-wave-save-resume` to verify mapId preservation and legacy checkpoint defaults to urban.
  - 598/598 Node tests passing (`node --test tests/*.js`).
  - 15/15 release-build integrity tests passing (`python3 -m unittest tests.test_release_build`).

## v175 — Milestone 3: Map registry framework and Snowy Compound layout foundation

- **Map registry framework (`src/10_config_world.js`, `src/01_core.js`).**
  - Modularized arena generation behind `MAPS[id].build()`, with runtime map switching via `getActiveMap()` and `setActiveMap(id)`.
  - Added pure map definitions in `src/01_core.js` (`CORE.MAP_IDS`, `CORE.DEFAULT_MAP_ID`, `CORE.sanitizeMapId`, `CORE.getMapDef`, `CORE.MAP_DEFS` for `urban` and `snowy`), abstracting per-map world dimensions, player spawns, colliders, enemy spawn rings, station layouts, Domination flag points, and gated districts.
  - Sourced stations (`src/57_stations.js`), spawn rings and district filtering (`src/60_hud_waves.js`), and Domination flag entities (`src/35_modes.js`) from active map definitions.
- **Snowy Compound layout (`src/01_core.js`, `src/10_config_world.js`).**
  - Added `snowy` compound layout with two-storey command anchor building, vehicle hangar, fuel depot, watchtower, trenches, and sandbag perimeter.
  - Sourced `buildSnowyArena()` meshes from the defined collider bounds, and added Snowy station layout (16 stations) and 3 Domination capture flags (`A`, `B`, `C`).
- **Survival checkpoint compatibility (`src/60_hud_waves.js`, `src/70_main.js`, `src/02_settings.js`).**
  - `captureRunState()` captures `mapId`, and `resumeRun()` restores the active map via `setActiveMap()`, safely defaulting legacy checkpoints to `'urban'`.
  - Added `gameMap` setting schema entry with runtime dispatch in `applySetting()`.
- **Release build budget management (`scripts/build.py`, `src/*.js`).**
  - Relocated inline trailing comments across JavaScript modules onto preceding dedicated `//` comment lines, preserving full documentation in source while allowing `scripts/build.py` line-comment stripping to reduce the self-contained single-file HTML release to 2,094,911 bytes (2,241 bytes under the 2 MiB ceiling).
- **Coverage.**
  - 7 new regression tests (4 in `tests/test_core.js`, 3 in `tests/test_modes_and_teams.js`) verifying map registry lookups, nav grid reachability from player spawn to all 12 outer spawn points on both maps, Domination flag clearances, station stand-point walkability, runtime map switching, and Survival checkpoint save/resume round-trip.
  - 593/593 Node regression tests passing (`node --test tests/*.js`).
  - 15/15 release-build integrity tests passing (`python3 -m unittest tests.test_release_build`).

## v174.1 — Gun Game knife-tier viewmodel crash fix (PR7 CI failure)

- **Root cause (`src/30_weapons.js`).** At Gun Game tier 19 (the Knife), `applyGunGamePlayerLoadout`
  sets all `weaponsOwned` slots to `–1` (no firearm) and then calls `buildViewmodel()`.
  `buildViewmodel` read `CFG.weapons[weaponsOwned[curWeapon]]` = `CFG.weapons[–1]` = `undefined`,
  then accessed `.cls` on that → `TypeError: Cannot read properties of undefined (reading 'cls')`.
  The same `undefined` reached every `curW()` caller in the render loop (`70_main.js` line ~1316
  `curW().type`, line ~1349 `curW().type` for the FOV zoom), `30_weapons.js` `updateViewmodel`,
  and `updateSway` — crashing the whole frame-update path.
- **Fix 1 — `_KNIFE_WEAPON_SENTINEL` constant.** A `const _KNIFE_WEAPON_SENTINEL = Object.freeze({
  name:'Knife', type:'MELEE', … })` is added at module level in `src/30_weapons.js`.
  `curW()` returns the sentinel instead of `CFG.weapons[-1]` when `weaponsOwned[curWeapon] < 0`.
  Every caller that previously crashed now gets a safe object with zero-valued numerics and
  `type:'MELEE'` (not in the viewmodel builder table, so no model attempt is made).
- **Fix 2 — `buildViewmodel` early-exit for knife tier.** When `gi < 0`, `buildViewmodel`
  now tears down any existing gun group (removes it from `gunCamera`, disposes geometry,
  nulls `gunGroup`/`vmTune`/`gunParts`/`muzzleFlash`) and returns early, ensuring
  `updateViewmodel`'s existing `if (!gunGroup) return` guard fires each frame.
  `buildKnife()` (the separate melee mesh in `32_viewmodels.js`) is called lazily if
  `knifeGroup` has not been built yet, so the first melee strike on the knife tier
  renders correctly.
- **Coverage — 10 new regression tests (`tests/test_modes_and_teams.js`, 73 total).** Tests span
  the complete knife-tier lifecycle: `curW()` sentinel shape/frozen status, `buildViewmodel`
  no-crash, idempotency, round-trip gun→knife→gun, all 20 ladder tiers player and bot,
  repeated knife↔gun transitions, floor-clamp demotion, terminal knife win only on credited
  MELEE kill, and post-settlement damage freeze. All 421 core tests and all 15 release-build
  tests remain green.

## v174 — Milestone 2 completion: Free-for-All, Domination and Gun Game

- **Free-for-All (`src/35_modes.js`, `src/70_main.js`, `src/01_core.js`).** 8 actors (player + 7 bots) where every actor is its own faction (`ffa_you`, `ffa_1…ffa_7`), first to 30 kills over a 600 s clock, with deploy options for the kill limit (`ffaScoreLimit`) and actor budget (`ffaActorCount`).
  - Faction-per-actor keeps the shared IFF (`CORE.isHostile`), bot target selection, hostiles-only aim assist and friendly-fire guard correct without any mode-specific branch.
  - HUD shows your kills against the lobby leader; the end screen names the sole leader, and a shared top score is a draw.
- **Domination (`src/35_modes.js`).** 6v6, three fixed flags A/B/C, 5 s capture, 4 m capture radius, contested flags pause capture, abandoned captures decay, ownership scores 1 point per owned flag per second up to 200 (`dominationScoreLimit`).
  - Bots walk real attack/defend/hold flag orders: `objectiveSteerTarget()` feeds the existing navigation path, so an actor with no fight in range moves on the objective instead of idling, and the order is cleared before aim/attack stages so a flag is never treated as a target.
  - Scoring is whole-point with a carried fractional remainder, so a 1 s tick and twenty 0.05 s ticks award exactly the same score.
- **Gun Game (`src/35_modes.js`, `src/70_main.js`).** 8 free-for-all actors on an explicit, visible 20-tier ladder (`CORE.GUN_GAME_LADDER`, ascending unlock rank) ending with the Knife at `CORE.GUN_GAME_KNIFE`.
  - A credited weapon kill advances the killer one tier; a knife kill demotes its victim one tier and never below the first; grenade, sentry, environment, self and same-faction kills grant nothing.
  - The tier weapon is issued to the player immediately (every firearm slot is emptied at the knife tier), survives respawn, and drives bot damage through `actorDamageMul()`, and the final knife kill wins the match without overflowing the ladder.
- **Shared match plumbing, no per-mode copies.** `CORE.isModeOver` now covers every registered match mode via `CORE.MATCH_MODE_IDS`/`isMatchModeId`; one `matchSettled()` freeze replaced the TDM-only settlement checks in `src/40_enemies.js`, `src/20_player.js` and `src/70_main.js`; one `matchHudView()`/`updateMatchHud()` renders the score bar, clock and mode note; one scoreboard renderer and one end screen driven by each mode's `outcome()`; one roster purge on menu exit. Survival, its checkpoint/resume path and touch controls are unchanged.
- **Coverage.** 12 new regressions in `tests/test_modes_and_teams.js` (568 total Node tests) drive real deploy/damage/kill/respawn/capture/ladder/settlement paths with observed RED before implementation, plus 6 new browser acceptance checks in `scripts/probe_live.py` deploying each mode through the real menu.

## v173 — Team-aware aim assistance and nonterminal match music lifecycle repair

- Aim assist and bullet magnetism only ever attract to hostiles (`src/30_weapons.js`):
  - Added `isAssistAlly()` using the existing `CORE.isFriendlyFire` predicate, and applied it to the candidate loops in `applyAimAssist()` and `magnetizeBullet()`.
  - TDM/FFA/Domination/Gun Game keep teammates inside the shared `enemies` roster; previously only `dead` actors were excluded, so friendly bots attracted the reticle and shots even though the friendly-fire guard rejected the resulting damage.
  - Added enduring regressions in `tests/test_modes_and_teams.js` running the real production loops for ally-only, mixed ally/hostile, and dead-actor candidate sets.
- Match soundtrack survives nonterminal deaths and respawns (`src/70_main.js`, `src/35_modes.js`, `src/50_vfx_audio.js`):
  - `killPlayer()` no longer calls `stopMusic()` unconditionally: music stops only when the death is terminal for the run/match (Survival, `gameEnded`, or a settled match such as reaching the score limit).
  - Added `ensureMusicPlaying()` and called it from the player respawn path in `defaultOnRespawn()`, restoring the soundtrack after a nonterminal respawn while still honouring mute and zeroed music/master volumes.
  - Added a death-to-respawn audio regression plus terminal-settlement and muted-settings regressions in `tests/test_modes_and_teams.js`.

## v172 — Survival mode posthumous combat damage and probe corpse lifecycle repair

- Scope match settlement freeze to TDM match completion in `src/40_enemies.js`, `src/20_player.js`, and `src/70_main.js`:
  - Fixed regression where `activeMode.isOver()` evaluated to true in Survival mode whenever `player.dead` was true (via `CORE.isModeOver('survival', ...)`), incorrectly gating `damageEnemy` and freezing combat simulation loops.
  - The settlement freeze in `damageEnemy`, `damagePlayer`, and `frame()` now specifically checks for settled matches (`gameEnded || (activeMode && activeMode.id === 'tdm' && activeMode.isOver())`), preserving posthumous damage in Survival mode (such as delayed rounds, grenades, sentries, and probe check 8 assertions).
  - Dead enemies in Survival mode continue to correctly take damage, trigger ragdoll creation capped at `RAGDOLL_MAX`, and get cleaned up from the active enemies roster by `updateEnemies()`.
  - Added enduring regression tests in `tests/test_modes_and_teams.js` verifying combat damage applies and corpses cap/clean up with `player.dead = true` in Survival mode, while retaining strict combat freeze upon TDM match settlement and `gameEnded`.

## v171 — Match end-screen restart audio lifecycle regression repair and audio settings gating

- Match end-screen restart audio lifecycle repair in `src/70_main.js`:
  - Fixed audio desynchronization where completing a match called `showMatchEndScreen()` (stopping music via `stopMusic()`), and restarting the match via `restartMatch()` or `#btn-match-restart` restarted gameplay without restarting music.
  - `restartMatch()` now restarts music consistently with existing audio settings (`!getSetting('muted') && getSetting('musicVolume') > 0 && getSetting('masterVolume') > 0`), ensuring audio starts only when enabled.
  - Avoids starting audio when muted or when volume is zero.
  - Updates match HUD (`updateMatchHud(activeMode)`) on restart for non-survival modes and preserves TDM game mode, score reset, and 6v6 roster correctness.
  - Added enduring actual-production end-screen -> restart lifecycle regression test in `tests/test_modes_and_teams.js` exercising real functions without replacement restart stubs.

## v170 — Bot rig reconstruction upon respawn, restart idempotency, match completion freeze, Survival resume mode restoration, sentry hostility targeting, and spawn point candidate scoring

- Rebuild live rig upon bot respawn and isolate corpse vs live-rig resource ownership in `src/35_modes.js`, `src/40_enemies.js`, and `src/45_ragdoll.js`:
  - Fixed corpse resource abandonment on respawn: ragdolls snapshot their own retired parts (`retiredParts`), ensuring retiring corpses cleanly dispose old private box geometries (12/12) and cloned-tint materials exactly once upon retirement or reset.
  - Skeletons and bone textures of detailed soldier corpses are freed on retirement while preserving shared template geometries and materials.
  - Newly rebuilt live actor rigs, hitboxes, geometries, and skeletons remain untouched and active in the scene across corpse retirement and match resets.
  - Both lifecycles isolated across death -> respawn before corpse retirement, corpse retirement before respawn, and repeated cycles without monotonic GPU geometry leaks.
  - Implemented `rebuildEnemyRig(actor)` in `src/35_modes.js` called from `defaultOnRespawn(actor, pt)`: transfers retired rig ownership snapshot to active ragdolls, completely reconstructs live rigs via `buildSoldier` / `makeEnemyMesh`, restores meshes and hitboxes, and wires `hitBody`, `hitHead`, and `hitLegs`.
  - Added enduring Node regression in `tests/test_modes_and_teams.js` and browser WebGL renderer probe in `tests/test_corpse_lifecycle_probe.py`.
- Eliminate duplicate bot initialization and ensure idempotent match setup in `src/70_main.js` and `src/35_modes.js`:
  - Removed duplicate `activeMode.setup()` invocation from `restartMatch()`, resolving the issue where `resetGame()` and `restartMatch()` each spawned 11 bots (22 total active bots vs 12 scoreboard participants).
  - Made `MODES.tdm.setup()` idempotent: cleans up and disposes existing roster bots and meshes if invoked repeatedly, maintaining exact team counts and actor identity correspondence across restarts.
- Freeze match combat and reject late damage and kill callbacks post-settlement in `src/20_player.js`, `src/35_modes.js`, `src/40_enemies.js`, and `src/70_main.js`:
  - Match completion now immediately halts combat updates (`updatePlayer`, `updateWeapons`, `updateEnemies`, `updateGrenades`) in `updateFrame()`.
  - Added settlement guards across `damageEnemy`, `damagePlayer`, `MODES.tdm.onKill`, and `MODES.tdm.endMatch` (`_settled`, `_ended`, `gameEnded`, `activeMode.isOver()`), preventing delayed projectiles, grenades, or bot attacks from altering scores, K/D, or outcome after a settled victory/defeat.
- Authoritatively restore Survival mode upon resuming runs across menu mode selections in `src/70_main.js`:
  - `resumeRun()` explicitly sets mode to `'survival'` via `setActiveMode('survival')` and synchronizes `setSetting('gameMode', 'survival')` before calling `resetGame()`, preventing checkpoints from running under TDM mode with frozen waves and 11 bots.
  - Added regression test covering victory and endless checkpoints resumed after switching menu selection to TDM.
- Filter sentry targeting by owner team hostility in `src/58_streaks.js`:
  - Sentry deployment stores `owner` and `team` on the sentry object.
  - `updateSentries()` filters target candidates using `CORE.isFriendlyFire` / actor team, preventing friendly teammates from monopolizing sentry aim and allowing hostile targets to be fired upon immediately.
- Candidate scoring for respawns isolates opponents and includes live player in `src/35_modes.js`:
  - Implemented `getHostilesForActor(actor, candidateList, livePlayer)` for per-entry candidate evaluation in `pickBestSpawnPoint()`.
  - Excludes friendly teammates so friendly proximity does not repel spawns; includes the live player when hostile to ensure player sightlines and proximity are accurately scored.
- Persist and restore saved `gameMode` setting into `activeModeId` in `src/02_settings.js`, `src/35_modes.js`, and `src/70_main.js`:
  - `activeModeId` initializes from validated `getSetting('gameMode')`.
  - Added `'gameMode'` handler to `applySetting()` with safety guard preventing mid-match mode switching.
  - Mode picker row synchronizes saved setting properly across page reloads and deployments.

## v169 — Authoritative TDM player death attribution, stable scoreboard roster, pause safety, and bidirectional E2E match lifecycle

- Authoritative player death and kill attribution in `src/20_player.js`, `src/40_enemies.js`, `src/57_stations.js`, `src/70_main.js`, and `src/35_modes.js`:
  - Fix asymmetric TDM scoring defect where hostile lethal attacks against player left `enemyScore = 0`, `enemy.kills = 0`, and `player.deaths = 0`.
  - Propagate attacker identity through `damagePlayer(amount, dirDeg, damageType, attacker)` into `player.lastAttacker` and `downPlayer(attacker)`.
  - Pass attacker identity from `src/40_enemies.js` across melee, rifleman bullet, and breacher shotgun attacks.
  - In `src/57_stations.js`, retain `player.downedBy = attacker || player.lastAttacker || null` during downed state and pass killer to `killPlayer(killer)` on immediate lethal down or bleedout timer expiration.
  - In `src/70_main.js`, add idempotency guard to `killPlayer(killer)` (`if (player.dead) return;`) to prevent duplicate death events on repeated damage, and dispatch both `activeMode.onDeath(player, sourceActor)` and `activeMode.onKill(player, false, sourceActor)`.
  - In `src/35_modes.js`, update `MODES.tdm.onKill` to attribute kills to the hostile killer, increment `enemyScore`, record `player.deaths` and `killer.kills`, and push authoritative killfeed messages. Attacker-absent, environmental, and self deaths are deterministic and grant no spurious enemy or friendly score credit.
  - Verify player death that reaches target score limit ends match immediately and never subsequently queues respawn.
  - Reset attribution cleanly across respawn, restart, and mode switch.
- Stable match roster and scoreboard retention in `src/35_modes.js` and `src/70_main.js`:
  - Back TDM scoreboard with a persistent actor roster (`MODES.tdm.roster`) initialized during `MODES.tdm.setup()` and cleared upon `resetGame()` and `quitMatchToMenu()`.
  - Scoreboard queries `this.roster` with deduplication (`seenIds`), retaining participants through death and respawn without duplicate or lost rows even when `updateEnemies` temporarily drops dead corpses from the lexical `enemies` array.
  - Mesh removal and geometry disposal in `resetGame()` clean up match roster objects without leaking Survival actors, scene meshes, or corpses.
- Pause safety in `src/20_player.js`, `src/35_modes.js`:
  - Gate match countdown timer, mode respawn queue timers, and player spawn protection duration so they do not elapse while `paused` is true.
- Survival mode isolation:
  - Preserve Survival mode down, revive, bleedout, Second Wind perk consumption, and checkpoint lifecycle completely unchanged without match immunities or score leakage.
- Extend browser acceptance verification in `scripts/probe_live.py`:
  - Extend real TDM browser E2E test to verify hostile bot attacking player with spawn protection immunity, downing, finishing kill, killer stats, enemy score increment, player deaths, killfeed announcement, player respawn with protection, and second hostile kill reaching score limit to trigger match completion, enemy victory, and `#match-end-title` `'DEFEAT'` display, followed by return to menu and clean settings restoration.

## v168 — Production deployable TDM, review findings repairs, roster re-entry, and UI mode picker

- Repair bot respawn roster re-entry in `src/35_modes.js`:
  - Revived bot actors in `defaultOnRespawn` re-enter lexical `enemies` array with original identity, mesh, and position restored.
  - Reset state to idle, reset timers, and ensure bots immediately pathfind, acquire hostile targets, engage, and take damage after respawn.
  - Assert in tests that repeated deaths and respawns cleanly drop and re-insert the actor without creating duplicate entries in `enemies`.
- Restrict checkpoints strictly to Survival mode in `src/01_core.js`, `src/02_settings.js`, `src/60_hud_waves.js`, and `src/70_main.js`:
  - Disallow saving checkpoints when in match modes (`saveCheckpoint` early-returns false if `activeModeId !== 'survival'`).
  - Remove `modeRespawnQueue` serialization and deserialization from `CORE.makeCheckpoint` and `CORE.validateCheckpoint`.
  - Remove detached stub replay from `resumeRun()`, ensuring Survival checkpoint restore remains clean, defensive, and free of phantom actors.
- Preserve Survival gameplay baseline in `src/20_player.js`, `src/60_hud_waves.js`, and `src/70_main.js`:
  - Remove 2.0 s spawn immunity from Survival player deploy (`player.spawnProtectionT = 0` in `20_player.js` and `resetGame()`).
  - Remove `spawnProtection: true` from Survival wave enemy spawning (`spawnWaveEnemy` in `60_hud_waves.js`).
  - Maintain 2.0 s spawn protection strictly for match modes (TDM), verifying it negates bullets, melee, and explosive damage and breaks early on attack.
- Implement production deploy mode picker and saved settings in `src/01_core.js`, `src/00_head.html`, and `src/70_main.js`:
  - Add `#mode-row` to the deploy screen (`#gun-select`), exposing only implemented modes (`SURVIVAL` and `TEAM DEATHMATCH`).
  - Add match settings row (`#tdm-settings-row`) for score limits (default 75, with 50, 25, 10, and short 2-kill acceptance options) and team size (default 6v6, with 4v4 and 2v2).
  - Persist `gameMode`, `tdmScoreLimit`, and `tdmTeamSize` in `CORE.SETTINGS_SCHEMA`.
- Implement full Team Deathmatch (TDM) match lifecycle in `src/35_modes.js`, `src/00_head.html`, and `src/70_main.js`:
  - TDM setup spawns 6v6 roster: player + 5 friendly bots vs 6 enemy bots, with default first-to-75-kills or 10-minute (600 s) duration rules.
  - Integrated kill attribution, deaths, respawn queuing, and killfeed announcements.
  - Player deaths in TDM queue respawn after 3 s rather than triggering Survival game over.
  - Tab scoreboard (`#match-scoreboard`) renders real-time team tables and actor K/D statistics upon holding Tab.
  - Match conclusion triggers result screen (`#match-end-screen`) with victory/defeat/draw status, scores, player K/D, and restart/main-menu lifecycle.
  - Defensively release pointer lock and clear `started` body state across all menu quit paths (`quitMatchToMenu`, `btn-quit`, `btn-death-quit`, `btn-v-quit`, and `resetGame`) to ensure clean menu transitions.
- Update browser acceptance verification in `scripts/probe_live.py`:
  - Isolate TDM acceptance in a dedicated browser page/context to prevent prior probes' pointer-lock and DOM state mutations from intercepting deployment UI clicks.
  - Verify real default spawn immunity on hostile bot before waiting/expiring protection naturally via updates, corpse dropping and roster re-entry on respawn, 2-kill match completion vs normal 75, end screen presentation, restart lifecycle, and standard settings cleanup.

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
