# Operation Blackout — Roadmap

## User-approved phased delivery plan (supersedes remaining milestone scope below)

The historical milestone ledger below is retained as evidence, not as approval of
unmerged work. The following four stages replace the former all-in-one remaining
batch. No periodic development cron is authorized. Each stage requires production
regressions, full build/release/browser gates, independent exact-head review and
exact-head CI before its own GitHub PR merge, canonical acceptance and publication.
Push each stage to GitHub and verify published bytes; do not defer all publication
to the end. Do not claim physical Android/LOQ acceptance from headless checks.

### Stage 1 — Fair combat, mobile lifecycle and reliable AI
- Four meaningful difficulty levels: Very Easy, Easy, Medium, Hard, selectable in
  every mode including Gun Game; migrate old saves safely and persist selection.
- Keep tactical intelligence on easier levels, but reduce reaction speed, aim
  accuracy, damage and combat pressure so mistakes are survivable. Existing Easy
  is reported too lethal on a phone. Preserve a distinct harder challenge.
- Reproduce and fix mobile Gun Game weapon becoming unusable after death; cover
  real touch fire, repeated death/respawn, reload, promotion, knife and cancellation.
- Reduce early Survival wave congestion and concurrency on easier settings;
  validate actual early-wave play rather than only tuning helper constants.
- Repair retained PR14 cover-AI review findings, including stalled navigation,
  occluded peeks, melee cover misuse and stale state on respawn, with real lifecycle
  regression coverage. CI-green rejected code is not accepted baseline.
- Status: shipped in merge be626b45a7157859d69f97a3f6601449dd42b910.

### Stage 2 — Understandable Gunsmith and progression
- All base weapons available from the start; rank must not gate base weapons.
  Gun Game always issues its required ladder weapon independently of unlocks.
- Cover every suitable weapon with explicitly compatible attachments, clear
  benefits AND trade-offs, readable before/after comparisons and per-weapon saved
  builds; actual deployed effects must match the explanation. No fake knife mods.
- Career challenges unlock procedural weapon camos and operator kit colours.
- Allow one balanced starting perk choice; rank opens cosmetics and optional
  extras, never compulsory access to a basic weapon. Preserve existing save data.
- Existing shotgun builds keep historically valid but now-incompatible saved
  attachments as clearly labelled remove-only legacy choices. Sand unlocks on
  reaching wave 15, whether the run ends in defeat or victory.
- Status: merged as PR 15 (4a5b4a8355a392cb9ae4919dc8fd9f73170c6e88),
  independently reviewed, exact-head CI passed, canonical acceptance passed and
  published. Acceptance recorded 680 Node tests, 22 release tests and 351 browser
  checks with zero console errors. Physical Android/LOQ testing remains outstanding.

### Stage 3 — Audible music, atmosphere and visibility
- Phone report: music is missing from initial gameplay while other sounds work.
  Diagnose audio initialization, routing, saved settings and mobile gesture unlock,
  plus pause/death/respawn/resume. Do not assume the music code was removed or
  override intentional mute/zero-volume settings.
- Retain the existing musical style (the sequenced D-minor score); make it clearly
  audible from the very first gameplay moments and increase intensity during combat
  without masking footsteps or warnings. Separate music volume. User decision: keep
  the same score, not a new style — the fix is audibility from match start.
- Manual OR random weather/time selection before deployment, fixed for the match:
  clear/day, dusk, night, Urban rain and Snowy blizzard. Keep maps compatible.
- Night muzzle/flashlight lighting, readable gameplay, mobile/Low-quality frame
  budget, reduced-motion support and restrained effects are acceptance criteria.
- Status: local implementation in progress, not accepted or published. Weather/time
  selection, checkpoint restoration, weather effects and night lighting are in the
  worktree; focused browser probes cover their lifecycle. Music startup, muted saves,
  pause, death and respawn have focused WebAudio/browser coverage. Physical listening,
  mobile/LOQ visibility and performance, broader gameplay coverage, full gates and
  independent review remain outstanding.

### Stage 4 — Per-mode statistics and completion audit
- Per-mode K/D, accuracy, favourite weapon and wins with clear presentation,
  durable storage/migration and correct attribution across real match lifecycles.
- Audit all approved stages and earlier delivered milestones against actual source,
  regressions and release evidence; do not infer completion from stale board cards.
- Daily challenge is explicitly DEFERRED by the user; do not implement a seeded
  challenge, daily modifiers or counted daily attempt as part of this plan.
- Status: pending.

Historical scope below is subordinate to these decisions, especially base-weapon
rank gates, daily challenges and the old milestone numbering/delivery granularity.

What comes next. The game already has a lot of systems: perks, wall buys, plates,
scorestreaks, five archetypes, checkpoints, endless, graphics settings for every device
class. The original variety gap (one mode, one map, four rifles) is now addressed by
new weapons, five modes and two maps. This roadmap records delivered scope and the
remaining milestones, in build order.

Each milestone is one PR. It must keep `node --test tests/*.js`,
`python3 -m unittest tests.test_release_build` and `scripts/probe_live.py` green, and
stay under the 2 MiB build budget. The build drops full-line comments from the shipped
file, so the release is about 1.97 MB (about 129 KB of headroom) and the src/ modules stay
fully commented. Everything stays procedural:
no new binary assets.

| # | Milestone | Size | Depends on |
|---|-----------|------|------------|
| 1 | ✅ New weapons: shotgun, LMG, sidearm, enemy breacher | M | — |
| 2 | ✅ Game modes: TDM, FFA, Domination, Gun Game | L | 1 (Gun Game ladder) |
| 3 | ✅ Second map: Snowy Compound (software acceptance; physical checks pending) | L | 2 (per-map spawns) |
| 4 | ✅ Survival climax + wave objectives (software acceptance; physical checks pending) | M | 3 (per-map points) |
| 5 | Feel & AI: audio, warnings, cover, weather (partial: audio, warnings, suppression, cover AI foundation) | M | — |
| 6 | Retention: unlocks + daily challenge | S | 1–4 |

---

## 1. New weapons

**Goal:** stop every fight from being the same rifle fight. Add close-range power,
sustained fire, and a backup gun.

- **M870 shotgun (pump).** 8 pellets per shell, so `01_core.js` needs a pellet-spread
  helper, with per-pellet falloff and penetration off. Shells load one at a time,
  and firing cancels the reload. Pump animation in the viewmodel.
- **M249 LMG.** 100-round box. Spread and recoil climb with sustained fire, and the
  barrel heats (glow on the viewmodel shroud, sizzle sound). Slow ADS and sprint-out.
  Long reload with a cover-open animation.
- **M1911 sidearm** in a 4th slot, always carried. Holding R on an empty primary, or
  pressing 4, quick-swaps to it in about 0.25 s. It needs a magazine-capacity entry in
  `captureRunState` / `resumeRun`.
- Each gun gets a viewmodel builder in `32_viewmodels.js` (`vmBuildSG`, `vmBuildLMG`,
  `vmBuildPistol`), attachment-aware like the others. Their own one-shot sounds are
  pre-rendered at deploy.
- Wiring: `CONFIG` weapon table (`10_config_world.js`), recoil patterns
  (`01_core.js`), `WEAPON_UNLOCK_RANK`, deploy picker, armory, and new wall-buy
  stations for the shotgun and LMG.
- Enemy side: grenadiers or a new "breacher" archetype carry the shotgun from wave 7.

**Done when:** all three are usable on desktop and touch, survive checkpoint/resume,
and have core tests for pellet spread and falloff, LMG heat and quick-swap.

**Status (v164):** shipped, with three differences from the plan above:
- The quick swap triggers when you pull the trigger on a completely dry gun (mag and
  reserve empty), not on a held R. A gun with reserve left still auto-reloads.
- The LMG reload drops and swaps the ammo box rather than animating the feed cover.
- The pistol needs no checkpoint entry: like the marksman rifle, it is re-synced on resume.

The shotgun **breacher** enemy (wave 7) shipped too: it charges, never flanks, and its pellets only land inside 12 m.

---

## 2. Game modes

**Goal:** turn a wave-defense game into a multi-mode shooter. It stays offline, so the
"other players" are bots.

**Framework first** (new `src/35_modes.js`):

- A `MODES` registry. Each mode defines `setup`, `onKill`, `onDeath`, `update`,
  `scoreboard` and `isOver`. Survival becomes one mode, so its wave logic moves behind
  that interface rather than being rewritten.
- **Teams.** Every actor gets a `team`. AI targeting stops assuming "the target is the
  player": `hasLOS`, `enemyShoot`, threat choice and grenade targets pick the nearest
  hostile actor. This is the riskiest refactor in the plan. It lands behind Survival
  first, with no gameplay change, before any new mode uses it.
- **Friendly bots** reuse `buildSoldier`, with a team-coloured kit tint and an IFF
  marker. Friendly fire is off.
- **Respawn:** spawn-point scoring in core (away from hostile sight lines), a 3 s
  respawn timer and 2 s spawn protection.
- **HUD:** score bar, Tab scoreboard (K/D per actor), kill feed, match timer, and
  end-of-match screen.

**Modes:**

| Mode | Rules |
|------|-------|
| **Survival** | The current game, unchanged. |
| **Team Deathmatch** | 6v6 (you + 5 bots vs 6). First to 75 kills or 10 min. |
| **Free-for-All** | 8 actors, everyone hostile. First to 30. |
| **Domination** | 3 flags (A/B/C); holding them ticks score; first to 200. Bots split between attack and defend. |
| **Gun Game** | 20-weapon ladder (every gun + attachment variants, knife last). A knife kill knocks the victim back one tier. |

- Deploy screen gains a mode picker. Mode, team size and score limit are saved in
  settings.
- Scorestreaks work in every mode. The sentry and airstrike are team-aware.
- No checkpoint/resume for matches, only for Survival.

**Done when:** each mode plays a full match vs bots on the current arena. Core tests
cover spawn scoring, flag capture maths and gun-game progression. The probe runs one
short TDM match end to end.

**Status (partial increment):**
- Foundation landed: `MODES` registry in `src/35_modes.js` (`setup`, `onKill`, `onDeath`, `update`, `scoreboard`, `isOver`), with Survival registered behind this interface and its wave logic preserved unchanged.
- Team-aware AI landed behind Survival: actors carry `team` (`player.team = 'friendly'`, `en.team = 'enemy'`), `CORE.isHostile` and `CORE.pickNearestHostile` govern target priority, and enemy LOS, movement, ranged fire, shotgun blast, grenades, and melee target the nearest hostile actor rather than assuming the player.
- Bot combat & navigation prerequisites completed:
  - Target-aware chase navigation routes toward selected bot hostile targets, retaining the shared player flow field only for player-targeted actors.
  - Attacker identity propagation through `damageEnemy` and `killEnemy` across melee, rifleman fire, and breacher shotgun blasts. Mode `onKill` hook receives verified killer actor identity.
  - Player rewards (kills, headshots, score, credits, streaks) and hitmarkers isolated exclusively to qualifying player kills against hostile targets; bot-to-bot kills and friendly-fire deaths do not modify player stats.
  - Delayed projectile and pellet impact callbacks (`enemyShoot`, `breacherShoot`) gate on paused/unstarted gameplay state consistently across player and non-player targets.
  - Execution-level regression test coverage in `tests/test_modes_and_teams.js` verifying bot-to-bot active combat, navigation vectors, pause impact gating, and kill attribution.
- Friendly bots & respawn framework landed:
  - Friendly soldier kits (`SOLDIER_FRIENDLY_KITS`) with distinct blue/navy camouflage uniforms and overhead IFF marker mesh (`iffMarker`, cyan/blue `0x38b6ff`) tracking head kinematics.
  - Friendly bot support in `buildSoldier(kind, team)` and `makeEnemyMesh(kind, team)`, with friendly blips on minimap (`CORE.minimapActorColor`).
  - Friendly fire damage immunity across bullets, melee, and grenades (`CORE.isFriendlyFire`).
  - Spawn-point scoring in core (`CORE.scoreSpawnPoint`, `CORE.pickBestSpawnPoint`) evaluating distance and hostile facing sight lines with obstacle occlusion.
  - Revived bot roster re-entry into lexical `enemies` with identity, mesh, and position restored; verified to target, engage, take damage, and avoid duplicate entries over repeated deaths.
  - Respawn timers (3 s) and match spawn protection (2 s) with damage immunity and attack-triggered break-off across all combat paths.
  - Survival baseline preserved: wave enemy spawns and player deploy have zero spawn protection; checkpoints are strictly forbidden for matches and exclusive to Survival between-wave states without detached stubs.
- Team Deathmatch (TDM) production release:
  - Deploy mode picker (`SURVIVAL` vs `TEAM DEATHMATCH`) with saved settings (`gameMode`, `tdmScoreLimit` defaulting to 75, `tdmTeamSize` defaulting to 6).
  - Production 6v6 roster setup (player + 5 friendly bots vs 6 enemy bots), 75 kills / 600 s default match rules, scorebar HUD and match countdown clock.
  - Tab scoreboard displaying full K/D per actor across both teams, real killfeed announcements on eliminations, player death queuing respawn instead of Survival gameover, and result screen (`#match-end-screen`) with victory/defeat/draw and restart/main-menu lifecycle.
  - Authoritative player death and kill attribution: hostile damage through down and finishing/bleedout attributes the killer, increments enemy score, records player deaths and killer kills, queues respawns, deduplicates repeated hits, and stops respawns on match-ending score limits. Attacker-absent and self deaths award no spurious credit.
  - Stable match roster (`MODES.tdm.roster`) preserves all participants through death and respawn on the scoreboard without losing or duplicating rows when dead bots are dropped from `enemies`.
  - Pause safety: match timer, respawn queue, and spawn protection do not elapse while paused.
  - Corpse vs. live-rig resource ownership repair:
    - Retiring corpses snapshot their own retired parts (`retiredParts`), ensuring all privately owned simple box geometries (12/12) and cloned-tint materials are disposed exactly once when corpses retire or reset.
    - Skeletons and bone textures of detailed soldier corpses are freed on retirement while leaving shared template geometries and materials alive.
    - Newly rebuilt live actor rigs, hitboxes, geometries, and skeletons remain untouched and active in the scene across corpse retirement and match resets.
    - Full lifecycle isolation across death -> respawn before corpse retirement, corpse retirement before respawn, and repeated cycles with zero monotonic GPU geometry leak.
    - Enduring Node regression in `tests/test_modes_and_teams.js` and real WebGL browser lifecycle probe in `tests/test_corpse_lifecycle_probe.py`.
- **Delivered: Free-for-All, Domination and Gun Game (`src/35_modes.js`, `src/70_main.js`, `src/01_core.js`).**
  - **Free-for-All.** 8 actors (player + 7 bots), each its own faction (`ffa_you`, `ffa_1…ffa_7`), so the shared IFF, bot targeting and hostiles-only aim assist work unchanged; first to 30 kills, 600 s clock, deploy option for the kill limit and actor budget.
  - **Domination.** 6v6, three fixed flags A/B/C, 5 s capture, 4 m capture radius, contested flags pause capture, ownership (not occupation) scores 1 point per flag per second up to 200, and bots walk attack/defend flag orders as real navigation destinations instead of idling.
  - **Gun Game.** 8 free-for-all actors on an explicit 20-tier ladder in ascending unlock rank, the Knife on the final tier: credited weapon kills advance the killer one tier, a knife kill demotes its victim one tier (never below the first), grenade/self/friendly kills grant nothing, tier weapons are issued to the player and drive bot damage, and the final knife kill wins without overflowing the ladder.
  - **Shared generalization.** `CORE.isModeOver`/`CORE.isMatchModeId`, one `matchSettled()` freeze, one `matchHudView()`/`updateMatchHud()` HUD model, one scoreboard renderer, one end-of-match screen driven by each mode's `outcome()`, and one roster purge on exit — no mode-specific copies of the settlement, HUD, scoreboard or cleanup paths. Survival and its checkpoint/touch behaviour are untouched.
  - Node regressions (12) in `tests/test_modes_and_teams.js` drive the production deploy, damage, kill, respawn, ladder, capture, scoring and settlement paths for all three modes; browser acceptance (6 checks) in `scripts/probe_live.py` deploys each mode through the real menu.
- Browser acceptance: verified in `scripts/probe_live.py` covering real UI deployment of TDM, FFA, Domination and Gun Game, roster validation for each mode, HUD and Tab scoreboard presentation, live combat lifecycle with real actors, corpse removal and roster re-entry on respawn, friendly victory, restart lifecycle, hostile-to-player death attribution and respawn, enemy victory with defeat screen, flag capture/contestation and scoring, ladder advance/demotion and the gun-game knife win, and settings restoration.
- Milestone 2 scope is delivered by this change: TDM, FFA, Domination and Gun Game are all implemented, with regression coverage and browser acceptance, and ship through the reviewed PR workflow.

---

## 3. Second map: Snowy Compound

**Goal:** a map that plays differently from the current dense urban block. It should
have long sightlines for the sniper, plus tight interiors for the new shotgun.

- ✅ **Map registry** (foundation done in v175): `buildArena()` becomes `MAPS[id].build()`.
  Colliders, the nav grid, `STATION_LAYOUT`, enemy spawns, mode spawn points, gated
  districts, and flag positions all come from map definitions (`CORE.MAP_DEFS` / `CORE.getMapDef`).
- ✅ **Layout foundation** (done in v175): A walled research compound in a snowfield:
  - a two-storey command building (the anchor point)
  - a vehicle hangar with catwalk
  - fuel depot, trenches, sandbag lines, and open perimeter with watchtower
  - station layout (16 stations) and domination flags A/B/C
  - core tests verify nav grid reaches all 12 outer spawn points to anchor player position
- **Look:**
  - ✅ snow ground texture with footprints-style variation (`TEX.snow`, done in v177)
  - ✅ icy blue sky preset and low sun lighting (`CORE.MAP_DEFS.snowy.sky`, `applyMapSkyPreset`, done in v177)
  - ✅ frosted metal and wood variants in `08_textures.js` (`TEX.frostedMetal`, `TEX.frostedWood`, done in v177)
  - ✅ snowfall particles on a `PFX` layer (done in v178)
  - ✅ breath-mist on the viewmodel (done in v178)
- **Feel:**
  - ✅ snow and ice footstep sounds (done in v178)
  - ✅ slightly longer slides on ice patches (done in v178)
  - ✅ powder puffs on impact instead of concrete chips (done in v178)
- ✅ **Map picker on deploy screen** (done in v177): `#map-row` on deploy modal `#gun-select` with `#map-btn-urban` and `#map-btn-snowy`. Each map keeps its own independent career best score and wave (`mapStats.urban`, `mapStats.snowy`).

**Status:** SOFTWARE ACCEPTANCE COMPLETE (v178.2). The v175–v178 map registry,
layout, lifecycle, appearance and feel implementation is retained. The acceptance
closure adds a permanent browser matrix for Urban and Snowy Compound × Survival,
TDM, FFA, Domination and Gun Game; it runs as part of the default full probe.

**Acceptance evidence and boundaries:**
- `scripts/probe_map_modes.py`: all 10 map/mode pairs, 120 assertions. Each case uses
  fresh storage and the real menu/loadout deployment, verifies map/mode, navigation
  and collision-valid spawn pads, and checks reset back to the menu.
- Survival on both maps: production wave spawning, checkpoint save/resume after a
  map switch (map, wave, score and district restoration), player death and fresh restart.
- All four match modes on both maps: production rosters, checkpoint rejection,
  bot/player death and respawn, credited kill or flag/ladder progression, settlement,
  restart with cleared scores/flags/tiers, and final roster/respawn-queue cleanup.
  These accelerated deterministic rule checks supplement the existing combat probe;
  they are not ten unattended, real-time full-length matches.
- Match deployment now opens Survival-only district gates, making all domination
  objectives reachable. Reset restores closed Survival districts. The northwest Snowy
  outer spawn pad is moved clear of the depot wall; navigation and collision checks
  cover both maps with the actual runtime colliders, not just the bare core layout.
- `tests/test_probe_matrix.py` guards exact 10-pair enumeration, default-probe wiring
  and CI execution. Existing core/integration tests retain the appearance, audio
  synthesis/routing, ice slide and impact coverage listed above.
- The single-file build is 2,053,710 bytes, 43,442 bytes below the 2 MiB ceiling.
  Release still requires the full regression, independent review and exact-head CI gates.

**Physical evidence gaps (not software blockers):** Actual Android and Lenovo LOQ
playability, hardware-GPU performance, audible snow/ice balance, controls and overall
balance/feel have **not** been tested on those devices. Headless Chromium and
synthetic audio/rule assertions do not establish physical-device acceptance.
**Next milestone:** Milestone 4 remains unstarted by this acceptance-only change.

**Done when:** every mode is playable on both maps. The nav grid reaches all spawns,
which the existing core test is extended to check for both maps. The probe deploys on
the new map, and the build is still under budget.

---

## 4. Survival climax + wave objectives

**Goal:** give a Survival run a shape and an ending, instead of fifteen identical
kill-everything waves.

- ✅ **Objective waves framework** (done in v179; about 1 in 3 from wave 4, never back to back), drawn from:
  - ✅ **Defend:** keep a generator alive. It has HP (500) and team-aware enemies target and damage it.
  - ✅ **Retrieve:** grab an intel case from across the map and bring it back to base dropoff.
  - ✅ **Demolition:** plant charges on 2 enemy mortar sites with 3.0 s interaction timer.
  - ✅ **Hold:** stay inside a zone for 60 s.
- ✅ A completed objective pays bonus credits (900) and a free scorestreak into `streakBank`. Failure costs no
  run, only the bonus.
- ✅ Objective markers rendered in the 3D scene, HUD status bar, and on the minimap. Objective state and completed counts saved in the checkpoint.
- ✅ **Wave 15 — Extraction (done in v180).** A helicopter is called in. You survive a 90 s surge with
  every archetype, then reach the LZ while it lands. The finale includes:
  - smoke markers
  - rotor wash on the particles
  - heavier music
  - a proper victory cinematic
- ✅ Endless mode continues after extraction as before.

**Status:** SOFTWARE ACCEPTANCE & SCOPE COMPLETE (v180; pending independent review & PR gates). Objective waves framework (Hold, Defend, Retrieve, Demolition) and Wave 15 Extraction finale (90 s surge across all 5 archetypes, helicopter LZ landing, smoke markers, particle rotor wash, heavier music intensity, victory cinematic, and browser probe forcing) are implemented and verified locally with unit and integration regressions.

**Next dependency:** Milestone 5 — Feel & AI (cover points generated from colliders at nav-build time, weather and time of day per match).

**Evidence gaps:** Physical-device balance and audio playtesting (Android touch controls, mobile speaker balance, and hardware-GPU frame rates on Lenovo LOQ) remain unverified.

**Done when:** core tests cover the objective schedule and its rules. The probe can
force an objective wave and the extraction.

---

## 5. Feel & AI

**Goal:** make fights readable and enemies smarter.

- ✅ **Positional audio** (done): panning, distance falloff, air absorption, enemy
  footsteps and near-miss whizzes were already in. Sounds behind walls are now muffled too.
- ✅ **Grenade warning** (done): an icon and arrow for live grenades within the blast radius.
- ✅ **Adaptive soundtrack** (done, not in the original plan): the drone and per-frame
  pulse were replaced by a sequenced D-minor score whose layers follow combat intensity.
- ✅ **Suppression** (done): near misses draw a grey arc toward the shooter, and edge
  darkening and blur build with sustained fire.
- ✅ **Cover AI (foundation landed in v181):** cover points are generated from colliders at nav-build time. Enemies
  move between them, peek, fire bursts and suppress. Bots in TDM use the same system.
- **Weather and time of day** per match: clear, dusk, night (muzzle flashes and
  flashlights do the lighting), rain (urban) and blizzard (snow map). This is mostly
  sky uniforms, fog and the particle layers that already exist.

**Status (partial increment in v181):**
- Cover AI foundation landed:
  - Nav-build cover point generation in `src/01_core.js` (`CORE.generateCoverPoints`), automatically populated onto `navGrid.coverPoints` for both Urban and Snowy Compound arenas.
  - Analytic occlusion evaluation (`CORE.evalCoverOcclusion`), scoring (`CORE.scoreCoverPoint`), candidate selection (`CORE.pickBestCoverPoint`), and tangent peeking positions (`CORE.coverPeekPosition`).
  - Tactical AI cover states (`take_cover`, `in_cover`, `peek`) implemented in `src/01_core.js` (`CORE.enemyAiNextState`, `CORE.enemyMoveSpeed`) and `src/40_enemies.js`: Riflemen and match bots steer to cover, duck/crouch behind low cover, peek along obstacle edges, and fire bursts.
  - Relentless charging archetypes (Runners, Breachers, Tanks) retain direct seek without seeking cover.
  - Checkpoint save/resume and Survival wave pacing completely preserved.
- **Next dependency / remaining work for Milestone 5:** Dynamic weather and time of day per match (clear, dusk, night with muzzle/flashlight lighting, rain, blizzard), plus frame-time checks on Low quality and reduced-motion blur gating.
- **Evidence gaps:** Physical mobile device (Android touch controls) and Lenovo LOQ hardware-GPU frame rates and audio playability remain unverified on hardware.

**Done when:** the probe still meets its frame-time checks on Low quality, and
reduced-motion turns off the new blur.

---

## 6. Retention

**Goal:** a reason to come back tomorrow.

- **Unlocks** fed by the career challenges that already exist:
  - weapon camos (procedural canvas textures)
  - starting perk choice
  - operator kit tints
  - the new weapons gated by rank
- **Daily challenge:** a date-seeded Survival run on a fixed map with 2 modifiers
  (e.g. "headshots only heal", "double grenadiers"). One attempt counts, and the best
  score is kept per day.
- **Per-mode stats page:** K/D, accuracy, favourite gun, wins per mode.

**Done when:** unlock state persists in the browser like the existing career data.
Core tests check that the daily seed is deterministic.

---

## Risks

- **Team-aware AI refactor (M2).** It touches the hottest code in `40_enemies.js`.
  The mitigation is to land it with Survival as the only consumer and the full probe
  green before any new mode is built on it.
- **Draw calls with 12 soldiers plus a teammate kit.** Rigid skinning keeps a soldier
  to about 7 calls. Respect the Enemy detail setting (auto keeps touch devices on the
  simple model), and cap bots per team on Low quality.
- **Build size.** Two maps' code plus three weapons is estimated at about 120 KB of
  code, against about 129 KB of headroom left after comment stripping. Track it in
  each PR, and split textures by map or compact helpers if needed.
