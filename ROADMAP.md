# Operation Blackout — Roadmap

What comes next. The game already has a lot of systems: perks, wall buys, plates,
scorestreaks, five archetypes, checkpoints, endless, graphics settings for every device
class. What it lacks is **variety**. You play one mode, on one map, with
four rifles. This plan fixes that in six milestones, in build order.

Each milestone is one PR. It must keep `node --test tests/*.js`,
`python3 -m unittest tests.test_release_build` and `scripts/probe_live.py` green, and
stay under the 2 MiB build budget. The build drops full-line comments from the shipped
file, so the release is about 1.97 MB (about 129 KB of headroom) and the src/ modules stay
fully commented. Everything stays procedural:
no new binary assets.

| # | Milestone | Size | Depends on |
|---|-----------|------|------------|
| 1 | ✅ New weapons: shotgun, LMG, sidearm, enemy breacher | M | — |
| 2 | Game modes: TDM, FFA, Domination, Gun Game | L | 1 (Gun Game ladder) |
| 3 | Second map: Snowy Compound | L | 2 (per-map spawns) |
| 4 | Survival climax + wave objectives | M | 3 (per-map points) |
| 5 | Feel & AI: audio, warnings, cover, weather | M | — |
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

---

## 3. Second map: Snowy Compound

**Goal:** a map that plays differently from the current dense urban block. It should
have long sightlines for the sniper, plus tight interiors for the new shotgun.

- **Map registry.** `buildArena()` becomes `MAPS[id].build()`. Colliders, the nav
  grid, `STATION_LAYOUT`, enemy spawns, mode spawn points and flag positions all come
  from the map definition.
- **Layout.** A walled research compound in a snowfield:
  - a two-storey command building (the anchor point)
  - a vehicle hangar with a catwalk
  - radio mast, fuel tanks (explosive), trenches and sandbag lines
  - an open perimeter with a watchtower for the sniper
- **Look:**
  - snow ground texture with footprints-style variation
  - icy blue sky preset and a low sun
  - snowfall particles on a `PFX` layer
  - breath-mist on the viewmodel
  - frosted metal and wood variants in `08_textures.js`
- **Feel:**
  - snow and ice footstep sounds
  - slightly longer slides on ice patches
  - powder puffs on impact instead of concrete chips
- Map picker on the deploy screen. Each map keeps its own best score.

**Done when:** every mode is playable on both maps. The nav grid reaches all spawns,
which the existing core test is extended to check for both maps. The probe deploys on
the new map, and the build is still under budget.

---

## 4. Survival climax + wave objectives

**Goal:** give a Survival run a shape and an ending, instead of fifteen identical
kill-everything waves.

- **Objective waves** (about 1 in 3 from wave 4, never back to back), drawn from:
  - **Defend:** keep a generator or radio alive. It has HP and enemies target it.
  - **Retrieve:** grab an intel case from across the map and bring it back.
  - **Demolition:** plant charges on 2 enemy mortar sites.
  - **Hold:** stay inside a zone for 60 s.
- A completed objective pays bonus credits and a free scorestreak. Failure costs no
  run, only the bonus.
- **Wave 15 — Extraction.** A helicopter is called in. You survive a 90 s surge with
  every archetype, then reach the LZ while it lands. The finale includes:
  - smoke markers
  - rotor wash on the particles
  - heavier music
  - a proper victory cinematic
- Endless mode continues after extraction as before.
- Objective markers go in the HUD and on the minimap. Objective state is saved in
  the checkpoint.

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
- **Cover AI:** cover points are generated from colliders at nav-build time. Enemies
  move between them, peek, fire bursts and suppress. Bots in TDM use the same system.
- **Weather and time of day** per match: clear, dusk, night (muzzle flashes and
  flashlights do the lighting), rain (urban) and blizzard (snow map). This is mostly
  sky uniforms, fog and the particle layers that already exist.

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
