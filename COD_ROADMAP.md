# Operation Blackout — Review & Call of Duty Roadmap

**Date:** 2026-09-12
**Reviewed build:** `master` @ `8d5b902`, three.js r186, 70 node + 15 Python tests passing.
**Status:** Phases 9, 10 and 11 shipped in full. Phases 12-13 are open.
**Companion document:** `AUDIT_AND_ROADMAP.md` — the 2026-09 defect audit and Phases 0-8, all landed.
That document is about *making the game correct*. This one is about *making it a Call of Duty game*.

---

## 0. Verdict

Phases 0-8 fixed everything that was broken. Nothing in this document is a defect report — the
game works, performs, saves, scales and runs on a phone. What it lacks is **a reason to keep
playing past wave 8**, and the reason is structural, not cosmetic.

Three observations, in order of leverage:

1. **Operation Blackout is mechanically CoD Zombies wearing CoD Multiplayer's clothes.** It has
   MP's gunfeel surface (ADS, sprint, slide, aim assist, killfeed, minimap, killstreak text) and
   Zombies' actual structure (one fixed arena, escalating waves, resupply between rounds, a run
   that ends in death). Every feature decision below gets easier once that is named: borrow
   *feel* from Multiplayer and *systems* from Zombies.

2. **The score counter is inert.** `addScore()` ([`src/60_hud_waves.js:126`](src/60_hud_waves.js))
   increments a number and writes it to the HUD. Nothing in the codebase ever reads `score` back
   except the end screen. Both CoD modes this game resembles are built on an economy — Zombies
   spends points on walls, doors, Pack-a-Punch and perks; Multiplayer spends kills on streaks.
   This game earns a currency with no sink, which is why a 30-minute run has no shape.

3. **The loadout you deploy with is the loadout you die with.** `weaponsOwned` is set at deploy
   and only ever changed once, by `unlockSecondary()`. Four weapons, no attachments, no upgrades,
   no swaps. Waves 1 and 15 are played with identical tools against numerically larger enemies.

Everything below follows from those three.

---

## 1. Review — what is weak, and where

Tagged `[C]` where the claim is read directly from code, `[D]` where it is a design judgement.

### Gunplay

| ID | Finding |
|---|---|
| GUN-01 | Recoil is random noise, not a learnable pattern |
| GUN-02 | No hipfire bloom — sustained fire is as accurate as the first shot |
| GUN-03 | No material penetration — plywood stops a .308 like concrete does |
| GUN-04 | No melee attack of any kind |
| GUN-05 | Shielded-advancer feedback is indistinguishable from a normal hit |

**GUN-01 [C]** — `player.recoilP += w.recoilV * (0.8 + Math.random() * 0.4)` and
`player.recoilY += (Math.random() - 0.5) * 2 * w.recoilH`
([`src/30_weapons.js:226`](src/30_weapons.js)). Vertical kick varies ±20% randomly and horizontal
kick is *pure* noise with zero mean. That is unlearnable by construction: there is no pattern to
pull down against, so sustained fire is a dice roll rather than a skill. Every CoD weapon since
CoD4 has a deterministic recoil *shape* with a small random overlay — the AK climbing left, the
M4 drifting right — and learning it is the primary skill expression in the gunfight.

Compounding it: `player.recoilP *= Math.pow(0.02, dt)`
([`src/20_player.js:166`](src/20_player.js)) decays the recoil offset while the player is actively
compensating downward, so on trigger release the view ends up *below* where they were aiming.
CoD returns the camera toward the pre-fire aim point instead.

**GUN-02 [C]** — spread is `adsDown() ? w.adsSpread : w.spread`
([`src/30_weapons.js:175`](src/30_weapons.js)), scaled only by horizontal speed and airborne
state. It does not grow with sustained fire and does not recover. There is therefore no
mechanical reason to ever tap-fire, and no cost to holding the trigger at range.

**GUN-03 [C]** — `fireShot()` takes `worldHits[0]` and stops. The arena's cover — crates,
barrels, plywood, concrete — is all identical to a bullet. Penetration is one of the three things
that make CoD map geometry readable (the others being mantling and minimap fidelity).

**GUN-04 [C]** — no melee exists. Grep for `knife` returns nothing; the only melee in the game is
the one enemies use on you ([`src/40_enemies.js:676`](src/40_enemies.js)). A runner that has
closed inside its 1.9 m stop distance has no answer but backpedalling, which is exactly the
situation CoD's knife exists to solve. `KeyV` and `KeyF` are both unbound.

**GUN-05 [D]** — `showHitmarker(isHead)` ([`src/60_hud_waves.js:66`](src/60_hud_waves.js)) has two
states. The shielded advancer takes 15 damage frontally and 100 flanked, and gives the player the
identical ping either way. The mechanic is invisible unless you read the patch notes.

### Movement

| ID | Finding |
|---|---|
| MOV-01 | No mantle or vault — cover is scenery, not geometry |
| MOV-02 | Sprint is one speed; slide commits for a fixed 0.9 s |

**MOV-01 [C]** — movement has sprint, crouch, slide, slide-jump, coyote time (0.12 s) and jump
buffering (0.15 s) — genuinely good, better than a lot of hobby FPS code. But `resolveVertical()`
only does step-up to `STEP_H = 0.60` ([`src/20_player.js:75`](src/20_player.js)). A 1 m crate
cannot be climbed, so the scattered cover is decoration rather than a route. CoD's mantle is what
makes players read a wall as a decision.

**MOV-02 [C]** — `wantSprint` is a single speed gated by 3.2 s of stamina. Modern CoD layers a
*tactical sprint* burst on top (double-tap, faster, longer recovery), which is what makes
rotations feel urgent. And the slide locks in for 0.9 s
([`src/20_player.js:187`](src/20_player.js)) with no early-out except releasing crouch — slide
cancelling, the movement tech CoD players actually use, is unavailable.

### Systems / content

| ID | Finding |
|---|---|
| SYS-01 | Score is a currency with no sink |
| SYS-02 | No in-run weapon progression |
| SYS-03 | One equipment type — 2 frags, no tacticals, no field upgrade |
| SYS-04 | Killstreaks award score, and nothing else |
| SYS-05 | Armor is a one-time 50-point buffer topped up only by med pickups |
| SYS-06 | Nothing new happens after wave 12 |
| SYS-07 | Death ends a 30-minute run outright |

**SYS-01 [C]** — covered above.

**SYS-02 [C]** — `CFG.weapons` is four entries; `initWeapons()` fixes both slots at deploy. There
is no wall buy, no box, no upgrade, no attachment.

**SYS-03 [C]** — `CFG.grenade` is a single frag, `count: 2`. The grenade code is the *most*
reusable system in the project — it already has hold-to-charge with a speed ramp
([`src/55_grenades.js:60`](src/55_grenades.js)), a trajectory preview with a broad-phased collider
query, bounce physics, and blast line-of-sight ([`src/55_grenades.js:290`](src/55_grenades.js)).
`explodeGrenade()` ([`src/55_grenades.js:317`](src/55_grenades.js)) is the only payload-specific
function. Every CoD tactical and lethal is a different payload on machinery that already exists.

**SYS-04 [C]** — `registerKillT()` ([`src/60_hud_waves.js:152`](src/60_hud_waves.js)) tracks a
4-second multi-kill window and awards `CFG.score.multikill`. It prints DOUBLE KILL / RAMPAGE and
stops. Scorestreaks are the single most recognisable thing about CoD Multiplayer and the hook is
already half-written.

**SYS-05 [C]** — `player.armor` starts at 50, absorbs 60% of incoming damage
([`src/20_player.js:339`](src/20_player.js)) and is refilled +15 only by a med pickup
([`src/55_grenades.js:437`](src/55_grenades.js)). It never regenerates and cannot be bought. In
practice it is a wave-1 resource that is gone by wave 4 and irrelevant thereafter.

**SYS-06 [C]** — the last behaviour unlock is `enemyNades` at wave 12 and the last archetype is
the shielded advancer at wave 9 ([`src/01_core.js:233`](src/01_core.js)). Endless mode scales HP
by 8% per wave and enemy count, and that is all. Waves 13 through 30 are the same fight with
larger numbers — the exact failure Phase 4 diagnosed at wave 8 and fixed once.

**SYS-07 [D]** — a run is 15 waves and roughly 25-40 minutes. The between-wave checkpoint (Phase 4)
means a *closed tab* is survivable, but a death is not: `killPlayer()` clears the checkpoint.
Zombies' downed-and-revived state exists because losing 40 minutes to one mistake is a bad last
impression.

---

## 2. Roadmap

Five phases, continuing the numbering in `AUDIT_AND_ROADMAP.md`. Each has an exit criterion.
The ordering is deliberate and is argued in §3.

### Phase 9 — Gunfeel

> **Exit criterion:** firing 30 rounds from a fixed aim point traces the same recoil shape twice
> (within jitter); releasing the trigger returns the camera to within 0.2° of the pre-fire aim;
> tap-firing at 40 m is measurably more accurate than holding; a knife kills a runner at 2.2 m.

Cheapest phase in the document and the one that changes every second of play. All of it fits the
established pattern: pure functions in `src/01_core.js`, thin engine layer in `src/30_weapons.js`,
covered by `tests/test_core.js`.

| Task | Addresses | Notes |
|---|---|---|
| 9.1 **Recoil patterns.** `CORE.recoilAt(pattern, shotIndex)` returns a normalised (x, y) kick from a per-weapon table; ±15% jitter on top so it is not robotic | GUN-01 | ~40 lines. Author four shapes: M4 climbs then drifts right, MK18 wanders wide, SCAR-H hard vertical, SV-98 single hard kick. |
| 9.2 **Recoil recentering.** Track the pre-fire aim point; on trigger release, lerp the view back toward it over ~0.25 s instead of decaying the offset in place | GUN-01 | Fixes "I end up aiming at the floor". Interacts with 9.1 — do them together. |
| 9.3 **Hipfire bloom.** Accumulate spread per shot toward a per-weapon cap; decay when not firing. ADS caps it far lower | GUN-02 | Gives tap-firing a purpose. Pure function; trivially testable. |
| 9.4 **Material penetration.** Tag colliders with a class in `addBox()` ([`src/10_config_world.js:220`](src/10_config_world.js)); continue the ray through up to two surfaces with a per-material damage cost | GUN-03 | Apply symmetrically to `enemyShoot()` or it will feel unfair. |
| 9.5 **Melee.** `KeyV` / new touch button. One-hit kill on runner and scout inside 2.2 m, heavy damage otherwise, ~0.9 s lockout, lunge toward the nearest target in a small cone | GUN-04 | Reuses the aim-assist cone search at [`src/30_weapons.js:121`](src/30_weapons.js). |
| 9.6 **Mantle / vault.** Ledge probe 0.4-1.6 m ahead while sprinting into or airborne near a surface; lerp the player up over ~0.35 s | MOV-01 | Makes the scattered cover a route. Check it does not let the AI-unreachable roof become player-reachable in a way that breaks wave completion. |
| 9.7 **Tactical sprint + slide cancel.** Double-tap sprint for a 2.5 s burst at 1.25× sprint speed with a longer stamina recovery; allow a slide to be cancelled into crouch or jump at any point | MOV-02 | |
| 9.8 **Hit feedback tiers.** Distinct marker and sound for a shield/armor block vs a body hit vs a headshot vs a kill | GUN-05 | Teaches the shielded advancer without a tutorial. |

### Phase 10 — The economy

> **Exit criterion:** a player reaching wave 10 has meaningfully different equipment from the one
> they deployed with, and chose it. Credits earned across a full run are spent, not banked.

This is the structural phase. Everything in Phases 11 and 12 plugs into it.

| Task | Addresses | Notes |
|---|---|---|
| 10.1 **Credits.** Earn in parallel with score — 10 per hit, 60 per kill, 100 per headshot kill, 250 × wave on clear. `score` stays the leaderboard number | SYS-01 | One call site: `addScore()`. Keep the two separate so career bests stay comparable across versions. |
| 10.2 **Wall buys.** 5-7 weapon boards on arena walls; hold-to-buy prompt; buying the weapon at full price, refilling its ammo at a third | SYS-02, SYS-01 | The four corner districts and the central building give natural anchors. This also gives the ammo economy a shape better than the current random-drop-plus-emergency-cache. |
| 10.3 **Armory (Pack-a-Punch).** One station, unlocked at wave 8. Upgrades the held weapon: damage tier, magazine, tracer rounds, a new name. Expensive — around 5000 | SYS-02 | Gives the back half of a run a goal that is not just survival. |
| 10.4 **Perks, three slots.** Juggernaut (+50 max HP), Speed Reload (−40% reload), Steady Aim (less bloom, faster ADS), Scavenger (better drops), Second Wind (one auto-revive) | SYS-05 | Every one of these is a multiplier on a number that already exists in `CFG`. No new systems. |
| 10.5 **Power-up drops.** Rare enemy drop, floating icon: MAX AMMO, INSTA-KILL (10 s), DOUBLE POINTS (30 s), NUKE (kills everything alive) | SYS-01 | Highest fun-per-line item in this document. `dropPickup()` ([`src/55_grenades.js:379`](src/55_grenades.js)) already handles spawn, life, blink and despawn — this is a new pickup kind, not a new system. |
| 10.6 **Armor plates.** Buyable/lootable plates that restore the 50-point buffer, three carried | SYS-05 | Turns armor from a wave-1 resource into a between-wave decision. |
| 10.7 **Last stand.** On lethal damage, drop to a downed state with a pistol and a 10 s bleed-out. Second Wind or clearing the wave revives; bleeding out ends the run | SYS-07 | Softens a 40-minute loss without removing the stakes. |

### Phase 11 — Equipment and streaks

> **Exit criterion:** a player has at least one non-frag answer to each of: a shielded advancer
> holding a doorway, a grenadier at 16 m, and four runners closing at once.

| Task | Addresses | Notes |
|---|---|---|
| 11.1 **Tacticals.** Flashbang (white-out + enemies in LOS stop firing and wander), Stun (slow in radius), Smoke (a volume that blocks enemy LOS) | SYS-03 | All three are payloads on the existing grenade. Smoke plugs into `CORE.segmentBlocked` ([`src/01_core.js:472`](src/01_core.js)) as one extra sphere test — cheap because the LOS path is already analytic, not mesh raycast. |
| 11.2 **Lethal variants.** Semtex (sticks, no bounce, short fuse), Claymore (proximity, directional cone), Thermite (burning ground over 5 s) | SYS-03 | Claymore's cone reuses the `SHIELD_ARC` math at [`src/40_enemies.js:334`](src/40_enemies.js). |
| 11.3 **Field upgrade.** One, charged by damage dealt. Start with Deployable Cover or Munitions Box | SYS-03 | Pick one and ship it; do not build the whole CoD list. |
| 11.4 **Scorestreaks.** UAV (reveal all enemies on the minimap, 30 s), Precision Airstrike (mark a line, delayed blast sequence), Sentry Gun (placeable turret), Care Package | SYS-04 | UAV is the best first one: it costs almost nothing (the minimap already draws every enemy at [`src/60_hud_waves.js:390`](src/60_hud_waves.js)) and it *retroactively* makes the minimap meaningful, because the baseline becomes near-only detection. Airstrike reuses `explodeGrenade`; the sentry reuses `hasLOS` inverted. |

### Phase 12 — Wave and map design

> **Exit criterion:** waves 13-25 present different problems from waves 5-12, not larger ones.

| Task | Addresses | Notes |
|---|---|---|
| 12.1 **Special waves.** Every fifth wave is an announced modifier: Blitz (all runners and scouts, double count, half HP), Blackout (arena lights down, tracers and muzzle flash only), Marksman (all riflemen at range), Ironclad (all shielded and tanks) | SYS-06 | This is the variety a boss would have provided, in the shape the wave-15-boss decision asked for: spread across the curve rather than concentrated in one set piece. |
| 12.2 **Gated areas.** Two of the four corner districts start behind a 750 / 1500 credit door | SYS-01, SYS-06 | Paces the run, gives credits a second sink, and makes the 90×90 arena reveal itself rather than arrive all at once. Requires the nav grid to be rebuilt on open — `rebuildNavGrid()` already exists at [`src/10_config_world.js:661`](src/10_config_world.js). |
| 12.3 **Elite variants.** Rare high-wave rolls on existing kinds — armored rifleman, minigun tank | SYS-06 | Rides the existing weight table at [`src/01_core.js:260`](src/01_core.js). Cheap variety, no new AI. |
| 12.4 **Objective waves.** Occasional secondary goal — hold a zone, defend a package, survive without regen | SYS-06 | Borrows Hardpoint / Domination. Schedule after 12.1 proves special waves land. |

### Phase 13 — Meta progression

> **Exit criterion:** a second run starts differently from the first.

| Task | Notes |
|---|---|
| 13.1 **XP and player level**, persisted next to career bests | `CORE.mergeRunIntoStats` ([`src/01_core.js:209`](src/01_core.js)) and the sanitiser are already the right shape; add fields there. |
| 13.2 **Weapon unlocks by level** — deploy with two, earn the rest | Gives the first three runs a visible arc. |
| 13.3 **Attachments** — optic / barrel / underbarrel / magazine / stock with real trade-offs (+range, −ADS speed) | The deepest CoD feature and the largest single task here. Needs 9.1-9.3 first, because attachments are only interesting once recoil and bloom are systems worth modifying. |
| 13.4 **Challenges and camos** — "50 headshots with the SCAR-H", shown in the menu | Cheap retention; reuses the stats store. |

---

## 3. Sequencing, and why

**Phase 9 before everything.** It is the cheapest phase, it improves every second of play
immediately, and it is a prerequisite for the depth in 13.3 — attachments that modify a random
recoil value modify nothing a player can perceive.

**Phase 10 before 11 and 12.** Streaks, doors and equipment loadouts all need a currency to
attach to. Building any of them first means building them twice.

**Phase 13 last.** Meta progression is only motivating once there is something worth progressing
toward. Unlocking a fifth weapon matters when weapons have attachments and recoil patterns; it
does not matter today.

### If only one weekend is available

1. **9.1 + 9.2 — recoil patterns and recentering.** The single biggest change to how the game
   feels, and roughly 60 lines of pure function plus a small camera change.
2. **9.5 — melee.** Closes the one genuine gap in the player's toolkit.
3. **10.5 — power-up drops.** MAX AMMO and INSTA-KILL alone change the texture of every wave, and
   the pickup system to hang them on is already written and already tested.
4. **10.1 — credits.** One call site. Ship it even before there is anything to spend on, so the
   number in the HUD stops being a lie.

That slice is under a thousand lines and takes the game from "a competent wave shooter" to
"recognisably Call of Duty".

---

## 4. Constraints this plan respects

- **One self-contained HTML file, runnable from `file://`.** No ES modules, no bundler for the
  shipped artifact, no external asset fetches. Every feature above is procedural geometry,
  synthesised audio (`SOUND_RECIPES`), or CSS/canvas UI. Nothing here needs a new asset.
- **Gameplay rules go in `src/01_core.js` as pure functions**, with the engine layer kept thin, so
  `tests/test_core.js` can cover them under `node --test`. That is what made Phases 0-8 verifiable
  and it is the only reason this plan can be executed without re-auditing the game each time.
- **Draw-call budget.** Sentries, care packages, wall-buy boards and deployable cover all add
  meshes. Budget them the way `CORE.shadowCasters` already budgets enemy shadows — nearest-N,
  refreshed on a timer — rather than adding them unbounded.
- **Touch parity.** Melee, field upgrade, tactical and streak all want an input. The right-hand
  touch cluster is already at seven controls in 244 px; adding four more needs a radial or a
  swipe-up tray, not four more buttons. Design that before shipping 9.5.

## 5. Explicitly out of scope

- **Multiplayer.** Nothing in the architecture anticipates it, and none of the above needs it.
- **A campaign or scripted missions.** The wave loop is the game; deepen it rather than replacing it.
- **Licensed CoD content** — weapon names, map names, operator likenesses, audio. Take the
  mechanics, not the trademarks. The existing weapon names are already generic analogues
  (M4 Carbine, MK18 Mod1, SCAR-H, SV-98) and should stay that way.
- **A wave-15 boss.** Declined by an explicit product decision in Phase 5. 12.1 and 12.3 deliver
  the variety it was meant to provide, spread across the curve instead of concentrated.
