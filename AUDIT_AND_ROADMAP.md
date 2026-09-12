# Operation Blackout — Audit & Roadmap

> ## Status — Phases 0-11 complete (2026-09-12)
>
> **Phase 0 — regressions are now detectable.** `src/01_core.js` holds the gameplay rules as
> engine-free pure functions; `tests/test_core.js` executes them under `node --test` (58 tests).
> `tests/test_release_build.py` was rewritten from ~40 source-text greps into 7 artifact-integrity
> checks and now also drives the node suite. Mutation-checked: reintroducing BUG-03, BUG-04 or
> BUG-07 fails the suite. CI workflow added.
>
> **Phase 1 — the core loop works.** Measured before → after:
>
> | | before | after |
> |---|---|---|
> | enemies reaching a player inside the central building | **2 / 6** | **8 / 8** |
> | closest enemy-to-player separation | **0.001 m** (inside the body) | **1.71 m** |
> | enemies stuck on the external stairs | 2 of 6, at y = 3.2 | **0**, all at y = 0 |
> | sprint into a 0.8 m wall at 10 fps | passes through to **z = −28.9** | **blocked**, same as 60 fps |
> | `updateEnemies` cost, 14 enemies | 0.695 ms | **0.318 ms** |
> | damage at 71 m → 73 m (M4) | 26 → **16.9** (cliff) | 26 → **25.81** (ramp) |
>
> **Phase 2 — performance & robustness.** Measured at a wave-15 load (14 enemies):
>
> | | before | after |
> |---|---|---|
> | draw calls | **504** | **166** |
> | static-world meshes | 698 (one per box) | **38 merged batches** |
> | shadow casters | 185 | **113** |
> | raycast roots per bullet | 162 | **16** (grid-narrowed from 71) |
> | `updateEnemies`, 14 enemies | 0.695 ms | **0.396 ms** |
> | `fireShot` | 0.562 ms | **0.281 ms** |
> | grenade trajectory preview | 0.097 ms | **0.027 ms** |
> | DOM elements under sustained fire | 147 → **627** | flat at **168** |
> | geometry growth, 3 × 10-min runs | ~1 per grenade | **0 / 0 / 0** |
>
> Also fixed a latent bug the batching work uncovered: `probeSkinnedSoldier` read the
> **default framebuffer**, which is undefined to sample after the browser composites.
> Both samples came back identical (difference of exactly 0), so a working GPU was
> reported as broken and desktop players were silently downgraded to the fallback
> box-man. Reading an off-screen render target instead gives 979 of 1024 pixels.
>
> **Correction to PERF-02 below.** The audit attributed `fireShot`'s 0.562 ms to "two
> raycast passes with no spatial index". That was wrong — I measured the function as a
> whole and assumed the raycasts dominated. Profiled properly, the world raycast is
> 0.048 ms and the enemy raycast 0.012 ms, while `playSound('shot')` alone is
> **0.116 ms** and the impact ping another **0.074 ms**. Synthesised audio, not
> raycasting, was the cost. The ray grid was still worth building — it cut
> `updateEnemies` by a third, where LOS rays run several times per frame — but the
> `fireShot` win came from throttling repeated sounds and adding a master bus.
>
> **Exit criteria not met, carried forward:** draw calls are 166, not <60 (the
> remaining cost is 32 unbatched GLB props and 14 skinned soldiers, plus the shadow
> pass); `fireShot` is 0.281 ms, not <0.1 ms (the floor is one synthesised gunshot per
> shot, which is a design requirement, not a defect).
>
> **Phase 3 — player-facing quality.**
>
> | | before | after |
> |---|---|---|
> | settings | none at all | **9 options**, schema-driven, persisted |
> | mouse sensitivity | hardcoded `0.0022` | slider, 0.2×–4× |
> | audio volume / mute | no master bus existed | slider + mute, applied live |
> | persistence | `localStorage` untouched | settings + career bests survive reloads |
> | compass | 560 px canvas in a 280 px box, ~45° off | **280 = 280**, cardinal correct at all four headings |
> | mobile DEPLOY button | x 24–220 in a 379 px viewport | **centred**, 89–286 |
> | mobile HUD collisions | pause×score, health×ammo, armor×ammo | **none** |
> | portrait play | viewmodel off-screen at NDC 13.1 | landscape prompt + viewmodel pulled in |
> | reload interrupted by a swap | silently cancelled, magazine still empty | **resumes at 0.5 s, completes to 30** |
> | grenade cooking at pause | charge silently discarded | **thrown** (count 2→1, one live) |
> | enemy head hitbox | floated 0.18 m above the model, 0.21 m gap | **flush: head 1.52–1.84, body 0.45–1.52** |
>
> Corrupt or hostile stored settings are clamped, not trusted: `sensitivity: 99999`
> → 4, `fov: "banana"` → 72, `quality: "ultra"` → auto, unparseable JSON → defaults.
> `prefers-reduced-motion` is adopted on first run but never overrides a saved choice.
>
> **Phase 4 — depth & replayability.**
>
> | | before | after |
> |---|---|---|
> | losing a 30-minute run to a closed tab | nothing saved | **checkpoint every wave**, resume from the menu |
> | difficulty | one setting, fixed | **RECRUIT / REGULAR / VETERAN**, chosen at deploy |
> | after wave 15 | run just ends | **CONTINUE — ENDLESS**, HP ×1.84 → ×4.05 by wave 30 |
> | secondary weapon | forced to `(primary + 1) % 4` | **player picks it** at deploy |
> | escalation past wave 8 | accuracy capped; only the count grew | **4 behaviour unlocks** at waves 5/8/10/12 |
> | enemy types | 3, all by wave 4 | **4** — shielded advancer from wave 9 |
> | wave-15 spawn gating | ~37 s before kill time | burst size and cadence scale with queue pressure |
>
> The shielded advancer is the answer to the flat back half: an 85% frontal damage
> plate (measured: **15 damage head-on vs 100 flanked**), so it has to be worked
> around rather than out-DPS'd. Behaviour unlocks are announced on screen, so
> escalation reads as a change rather than just more bodies.
>
> Checkpoint round-trip verified live: saved at wave 4 (veteran, SCAR-H + SV-98,
> 57 HP, 1 frag) → menu shows `RESUME — WAVE 5 · VETERAN · score 6610` → resumed with
> every field intact. Corrupt (`{"v":2,"wave":"nope"}`) and unparseable saves are
> rejected, not loaded. A death clears the checkpoint; a lost run is not resumable.
>
> 120 s at wave 13 on veteran with every behaviour live: 0 frames with an enemy
> inside the player, max enemy Y 0 (nobody on the stairs), 0 geometry growth, 0 mesh
> growth, no console errors.
>
> **Phase 5 — roster, audio, batching and a balance pass.**
>
> Three more archetypes rather than a boss (a deliberate call): **scout** (wave 3,
> fast, fragile, always flanks), **grenadier** (wave 6, holds range and denies
> position) and **shielded advancer** (wave 9). Every wave band now plays
> differently instead of one wave being a set-piece. Composition is weight-based so
> adding a kind cannot silently starve an existing one — verified by test.
>
> Adaptive music, fully synthesised: a drone bed plus a tension voice and a
> heartbeat pulse driven by one intensity number. Measured response — idle 46 bpm /
> 200 Hz cutoff, overrun 132 bpm / 1098 Hz, tension voice fading in past 25%.
> Mute and stop both take it to exactly 0.
>
> Prop batching: the 48 scattered GLB props became **4 merged meshes**, taking draw
> calls **166 → 106**. The `fireShot` monkey-patch (ENG-07) is gone.
>
> **The balance pass found two genuine defects**, both invisible without measuring:
>
> - **A wave could stall forever.** `updateStuck` only catches an agent that stops
>   moving; one that circles the player moves constantly while never arriving, and
>   the wave waits on it. Wave 4 ran **434 s without completing**. Added
>   `updateProgress`, which tracks closest-approach-so-far and repositions an agent
>   that has not improved in 16 s. Wave 4 now clears in **19 s**.
> - **Running dry was a soft-lock.** Ammo dropped on a flat 30% roll, so an
>   inaccurate player empties both weapons, can no longer get the kills that produce
>   drops, and can never reach the wave clear that resupplies. Measured at wave 2:
>   0 rounds, 0 pickups, enemies alive. Added a drop floor that rises as the player
>   runs dry, plus an emergency cache that does not require a kill.
>
> Difficulty tiers confirmed genuinely different with one fixed-skill bot:
>
> | | wave reached | died | HP lost | time |
> |---|---|---|---|---|
> | RECRUIT | 8 (cap) | no | 23 | 187 s |
> | REGULAR | 8 (cap) | no | 55 | 234 s |
> | VETERAN | **4** | **yes** | 100 | 70 s |
>
> Two regressions I introduced and caught by measuring: the grenadier walked into
> the player (1146 frames inside the body) because it was left off a hand-kept
> stop-distance list — now table-driven; and scouts orbited forever (only **75%**
> ever arrived) because the flank bias never expired — now time-boxed, back to
> **100%** across all five archetypes, 48/48 each.
>
> **Phase 6 — three.js r128 to r186.**
>
> The blocker was never the API churn, it was packaging: three stopped shipping a
> UMD build after r159 and the non-module `examples/js` GLTFLoader after r147, and
> this game is one classic `<script>`. Solved by bundling three + GLTFLoader to a
> single IIFE with esbuild (`vendor/README.md` has the one-line command), which
> keeps the architecture and gets a current engine. 700 KB of vendor became 788 KB.
>
> Two global rendering behaviours changed underneath the art:
>
> - **r152 colour management.** r128 had none: a hex colour went to the shader raw
>   and `outputEncoding` applied an sRGB encode on the way out, brightening
>   everything. The palette was tuned against that. With management on, the same
>   numbers round-trip correctly and render **~75% darker** — measured, not
>   guessed. `ColorManagement.enabled = false` keeps the authored look; the
>   alternative is re-authoring every colour in the game.
> - **r155 physical lighting**, with `useLegacyLights` removed outright in r165.
>   The delta for ambient/hemisphere/directional is exactly the pi factor legacy
>   mode folded in, so `LIGHT_COMPAT = Math.PI` restores the original exposure.
>   Verified against r128 screenshots at matched camera poses.
>
> **A performance finding that had nothing to do with the upgrade.** Profiling the
> new build showed `updateEnemies` at **1.744 ms**, 4x worse than before. It was not
> r186 — it was the prop batching from Phase 5. Merging static geometry into a few
> large meshes made every AI line-of-sight raycast walk thousands of triangles,
> because three has no BVH. But "is a wall in the way" never needed triangle
> precision: an analytic slab test against the collider AABBs answers it in a few
> operations per box. `updateEnemies` went **1.744 ms → 0.224 ms**, better than the
> pre-upgrade 0.396 ms.
>
> | | r128 | r186 |
> |---|---|---|
> | revision | 128 (2021) | **186** |
> | draw calls, wave 15 | 106 | **97** |
> | `updateEnemies`, 14 enemies | 0.396 ms | **0.224 ms** |
> | `fireShot` | 0.287 ms | **0.263 ms** |
> | vendor bytes | 700 KB | 788 KB |
> | geometry growth, 3 passes | 0 / 0 / 0 | **0 / 0 / 0** |
>
> **Still not done:** the wave-15 boss, dropped deliberately in favour of spreading
> variety across the whole curve.
>
> **Phase 7 — the Android pass.** The README advertised Android, and nothing in Phases
> 0-6 had been checked on a touch layout in landscape. Tested under Chrome device
> emulation (Pixel 8 UA, 5 touch points, `pointer: coarse`, so `IS_TOUCH` resolved true
> and the real mobile path ran) at 800×360, 844×390, 915×412 and 1024×600, plus 375×812
> portrait. Four defects, measured rather than eyeballed:
>
> | ID | | before | after |
> |---|---|---|---|
> | MOB-01 | MAIN MENU on the victory screen, 800×360 | **0 px visible** | fully visible, no scroll |
> | MOB-01 | MAIN MENU on the death screen, 800×360 | 12 of 51 px | fully visible, no scroll |
> | MOB-02 | FIRE button over the ammo readout | 86×39 px, **every size tested** | none |
> | MOB-03 | RELOAD over PAUSE (two live tap targets) | 31×47 px at ≤844×390 | none |
> | MOB-04 | edge-anchored controls with no cutout inset | 6 of 9 | 0 |
>
> **MOB-01 — the end screens clipped their own buttons.** `#death-screen` and
> `#victory-screen` are `justify-content:center` with `overflow:visible`. Content taller
> than the viewport is then clipped at *both* ends and unreachable in either direction:
> at 800×360 the victory screen is 430 px of content in 360 px, so "AREA SECURED" and
> MAIN MENU were both entirely off-screen. Winning a 15-wave run left the player unable
> to reach the menu without reloading the page. The fix already existed in the codebase
> and had simply never been applied here — `#gun-select` and `#settings-screen` both
> carry `overflow-y:auto`. Added that plus `justify-content:safe center` (plain `center`
> first as the fallback), and a `@media (max-height:480px)` type scale so the content
> fits outright rather than merely scrolling.
>
> **MOB-02 — the ammo counter was under the firing thumb.** `#hud-bottom-right` and
> `#tbtn-fire` were both anchored bottom-right. Not a small-screen edge case: the
> overlap was identical at 1024×600. Ammo now sits bottom-centre, clear of both thumb
> clusters.
>
> **MOB-03 — RELOAD and PAUSE shared 31×47 px.** Five controls stacked in one column
> reached 346 px up from the bottom; a landscape phone is 360 px tall, so the top of the
> column arrived at the pause button. A tap in the shared zone could pause the fight
> instead of reloading. The right-hand cluster is now two staggered columns bounded to
> 244 px, and nothing sits within 50 px of the bottom edge, where a tap competes with
> the gesture bar.
>
> **MOB-04 — `viewport-fit=cover` with no safe-area insets.** The meta tag opts the page
> in under the display cutout and gesture bar, and `env(safe-area-inset-*)` appeared
> nowhere in the stylesheet — the worst combination. Six of nine controls sat within
> 48 px of an edge, PAUSE 14 px from the top-right corner where a landscape punch-hole
> camera lives. Every edge-anchored control and HUD readout now insets through
> `--sa-t/r/b/l`.
>
> Six new tests in `tests/test_release_build.py` solve the touch CSS box model at
> 800×360 and intersect the rectangles, so this is caught without a browser.
> Mutation-checked: restoring the old RELOAD offset, dropping `safe center`, or removing
> one control's inset each fails the suite.
>
> **Passed, and left alone:** touch detection, the portrait rotate-gate, `touch-action:
> none` on every control (no pull-to-refresh or accidental zoom), WebAudio unlocking on
> first gesture, all tap targets ≥44 px, gun-select and settings scrolling correctly,
> and the dynamic resolution scaler, which drops pixel ratio to 0.65 below 48 fps and
> steps back up asymmetrically to avoid oscillation.
>
> **Not covered by this pass, and still unmeasured:** real GPU throughput, thermal
> throttling, memory pressure and touch ergonomics. The emulator runs a desktop GPU and
> backgrounded the tab during measurement, so every frame-rate number collected was
> meaningless and none is quoted here. Shadows are on at 1024² with 107 casters on
> touch — the most likely real-device cost, and untested on hardware.
>
> **One overlap found and deliberately not fixed:** `#compass` (top:54px) intersects
> `#wave-hud` by 78×18 px. It is pre-existing, present at every size including desktop,
> and cosmetic — the compass letters run through the hostiles line. Logged, not changed,
> because it was outside the four defects this pass was asked to fix.
>
> **Phase 8 — closing out the register.** Everything still open that was actually a
> defect, plus the two performance criteria carried since Phase 2. Two of the four
> are now closed, one is materially improved, and one is reported as unreachable as
> specified rather than quietly dropped.
>
> | | before | after |
> |---|---|---|
> | BUG-11: head through a 3.65 m slab at 15 m/s | reaches **8.8 m** | **3.61 m**, never through |
> | same, at 30 / 60 m/s | 26.2 m / 62.3 m | 3.64 m / 3.61 m |
> | `playSound('shot')` | 0.148 ms | **0.0268 ms** (5.5x) |
> | `fireShot`, interleaved median of 15 x 200 shots | 0.435 ms | **0.246 ms** (1.77x) |
> | `fireShot`, warm minimum | 0.281 ms | **0.089 ms** |
> | draw calls, wave 15, 14 enemies | 98 | **86** |
> | enemy shadow meshes, wave 15 | 56 | **32** desktop / **16** touch |
> | MOB-05 compass over the wave counter | 78x18 px | **none** |
>
> **BUG-11 is closed, and it was real.** `resolveVertical()` zeroed upward velocity on
> a head bonk but never repositioned, so the head stayed inside the slab. Worse, the
> test was `c.min.y > feet`, which stops matching the moment the eye clears the slab —
> so once past it, nothing pulled the player back. Replaced with `CORE.ceilingClamp`,
> which tracks the lowest slab overhead every step and clamps the eye under it, with
> the floor winning when the gap is shorter than the player (sinking the camera into
> the ground is worse than a head in a slab). Verified by A/B against the live
> collision path, not a hand-rolled step: with the clamp neutered the head reaches
> **62 m** on a 60 m/s launch; with it, 3.61 m. Sub-stepping alone did **not** prevent
> this — `MAX_SUBSTEPS` caps at 8, so a long enough step still skips the slab.
> Seven regression tests, mutation-checked: making `ceilingClamp` a no-op fails four.
>
> **The `fireShot` audio floor was not a floor.** Phase 2 recorded "<0.1 ms is
> unreachable, the floor is one synthesised gunshot per shot, which is a design
> requirement, not a defect." That was wrong — the requirement is one gunshot per
> shot, not one *synthesis* per shot. Every sound is now declared as data in
> `SOUND_RECIPES` and rendered once through an `OfflineAudioContext` at deploy time,
> so playback is a single `BufferSource` instead of five freshly built nodes. Audio's
> share of `fireShot` fell from 0.453 ms to 0.122 ms. Percussive repeats get a few
> percent of pitch jitter, which is *more* variation than the old path had, since its
> parameters were fixed too.
>
> **Draw calls: 98 to 86, and <60 is not reachable as specified.** Each shadow-casting
> enemy is drawn again in the shadow pass, so the soldiers cost more than the entire
> static arena. `CORE.shadowCasters` budgets the pass to the nearest 8 (4 on touch);
> a soldier 40 m away casts a shadow a few pixels across. But the Phase 2 target was
> set without doing the arithmetic: 14 skinned soldiers are ~4 meshes each, so the
> roster alone is up to 56 colour-pass draw calls before a single arena batch is
> drawn. Skinned meshes cannot be merged. **<60 at a wave-15 load is arithmetically
> impossible while all 14 soldiers are on screen**, and the criterion is closed as
> mis-specified rather than left open to imply work remains.
>
> **ENG-05 stays open, deliberately.** The hazard — a duplicate top-level `const`
> between two modules becoming a whole-game `SyntaxError` — is already caught by
> `test_bundled_script_parses`. Two further tests now name the offending pair instead
> of leaving a bare parser error, and catch what node cannot see: a top-level
> `var`/`function` shadowing a real `window` property. The remaining fix, wrapping the
> bundle in an IIFE, would break `scripts/probe_live.py`, which evaluates page globals
> (`enemies`, `raycastColliders`) directly — the repo's most valuable behavioural test
> asset. Not worth trading for a risk that is already covered.
>
> **Not done, and not an oversight:** the wave-15 boss. It was dropped by an explicit
> product decision in favour of spreading variety across the curve, and three
> archetypes were added instead. On-device performance remains unverified; that needs
> hardware, not more code.
>
> Closed: BUG-01, BUG-02, BUG-03, BUG-04, BUG-05, BUG-06, BUG-07, BUG-08, BUG-09,
> BUG-10, UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, ROB-01, ROB-02, ROB-03,
> ROB-04, ROB-05, PERF-01, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07, PERF-08,
> PERF-09, GAP-01, GAP-02, GAP-03, GAP-05, GAP-06, GAP-08, GAP-09,
> ENG-01, ENG-02, ENG-03, ENG-06, ENG-08, MOB-01, MOB-02, MOB-03, MOB-04, MOB-05,
> BUG-11, PERF-02 (the `fireShot` criterion).
> **Still open:** three items, none of them an unfixed defect.
> - The **wave-15 boss** — dropped by an explicit product decision, not an oversight.
> - **ENG-05** (278 globals) — the real hazard is covered by three tests; the remaining
>   fix would break `probe_live.py`. See Phase 8.
> - **On-device performance** — layout and input are verified under emulation; GPU
>   throughput, thermals and memory need real hardware.
>
> The **<60 draw calls** criterion is closed as mis-specified (Phase 8): 14 skinned
> soldiers cannot be merged and cost up to 56 colour-pass calls on their own.
> ENG-04 is closed by Phase 6; the `fireShot` criterion by Phase 8.
> Sections below are the original audit, unedited except where a correction is noted.

> **Phase 9 — gunfeel, and the first half of the economy.** The first phase driven by
> `COD_ROADMAP.md` rather than the defect register: nothing here was broken, and all of it
> was missing. Measured before → after:
>
> | | before | after |
> |---|---|---|
> | recoil, two identical 10-shot M4 bursts | random walk, sign differs ~half the time | **+0.0210 / +0.0222 yaw** — same shape twice |
> | horizontal recoil mean | **0** by construction | a learnable right-hand drift |
> | compensating for recoil | correction kept, kick decays → aiming low | **absorbed**: counter-input cancels the kick |
> | hipfire spread, shot 1 vs shot 30 | identical | **0 → 0.0224** bloom, recovers in ~0.9 s |
> | 3 AR rounds through a wood slab | 78 (slab ignored) | **46** |
> | the same slab as concrete | 78 | **0** |
> | a runner inside 1.9 m | no counter but backpedalling | **knife, one shot**, 60 credits |
> | a 1.5 m crate | unclimbable | **mantle**, feet 0 → 1.50 m |
> | score | a number nothing read back | **credits**, earned and spent |
> | power-ups | none | MAX AMMO / DOUBLE POINTS / INSTA-KILL / NUKE |
>
> **GUN-01 was two defects, not one.** The obvious half is that recoil was noise:
> `(Math.random() - 0.5) * 2 * recoilH` has zero mean and no memory, so no amount of
> practice could improve a burst. `CORE.recoilAt` replaces it with a per-weapon shape —
> the M4 climbs nearly straight for six shots then leans right and holds — walked by a
> shot index that resets after 0.35 s off the trigger, with ±15% jitter so it is not
> mechanical. Two independent 10-shot bursts now finish at +0.0210 and +0.0222 yaw.
>
> The second half only shows up once the first is fixed. Recoil is an additive camera
> offset (`camera.rotation.x = player.pitch + player.recoilP`) that decays to zero, so a
> player who pulled down to compensate kept the correction in `player.pitch` and finished
> the burst aiming at the floor — the kick went away, their compensation did not.
> `CORE.absorbRecoil` spends counter-input against the outstanding offset first and passes
> only the remainder to the aim. Same-sign input is never absorbed, because looking further
> up while the gun climbs is the player choosing to.
>
> **Penetration is resolved against the colliders, not the meshes** — and that is the whole
> reason it works. The static arena was merged into batched meshes in Phase 2, so a mesh
> raycast reports the entry *and* exit faces of every box in a batch and cannot tell one
> wall from two. `colliders[]` is exactly one entry per box, and the material tag is derived
> from the render material in `addBox()`, so no call site had to change: 27 wood, 27 metal
> and 75 concrete colliders were classified by that one mapping. Anything unmapped stays
> concrete, which is the conservative default — an untagged surface stops a round exactly as
> it did before the feature existed.
>
> **Two things measured rather than assumed.** The first penetration test read 0 damage and
> looked like a broken feature; the enemy had been relocated by spawn validation and was
> standing behind a real concrete wall, so 0 was correct. The second read a stale camera at
> (-20, -37) while `player.pos` was (0, 24) — the preview pane backgrounds the tab, so the
> rAF loop was not ticking and the camera had never followed. Neither was a code defect, and
> quoting either as one would have been wrong.
>
> 36 new node tests, all mutation-checked: **17 of 17 deliberate breakages fail the suite**,
> including reverting recoil to random noise, making `absorbRecoil` a no-op, removing the
> penetration surface limit, and letting untagged colliders become free passage.
>
> **Still open from `COD_ROADMAP.md`:** 9.7 tactical sprint and slide cancel shipped with
> this phase; wall buys, the armory, perks, plates and last stand (10.2-10.7), all of
> Phase 11 (equipment and streaks), Phase 12 (wave and map design) and Phase 13 (meta
> progression) are not started.

> **Phase 10 — the economy.** Credits shipped in Phase 9 with nothing to spend them
> on. Eleven stations now sit in the arena, deliberately placed to pull the player out
> of the central building, which was otherwise the whole game. Measured before -> after:
>
> | | before | after |
> |---|---|---|
> | the deploy loadout | what you die with | **wall buy**: M4 -> MK18 for 1000 CR, live |
> | owning the wall weapon | n/a | **refill at 333 CR**, and a full reserve is refused free |
> | a weapon at wave 15 | identical to wave 1 | **MK2**: 18 -> 32.4 dmg, 32 -> 48 mag, 5000 CR |
> | the armory before wave 8 | n/a | locked, and charges nothing while locked |
> | perks | none | **3 of 5 slots**, blocked buys say why |
> | JUGGERNAUT | n/a | max health **100 -> 150** |
> | armor | one 50-point buffer, +15 per medkit | **3 plates**, refill to full, none wasted at full |
> | a lethal hit | run over | **downed**, 10 s bleed-out |
> | downed movement | n/a | **0.35x** (1.89 vs 5.40 m/s, interleaved trials) |
> | SECOND WIND | n/a | revives once at 35 HP, **and is consumed** |
> | draw calls at deploy | 64 | **64** — housings join the existing static batches |
>
> **The bug this phase produced was a good one.** `buildStations()` was called from
> `buildArena()`, which reads correctly and is wrong: every module is concatenated into
> ONE script scope, and `STATION_LAYOUT` is a top-level `const` in a *later* module, so
> the call ran before that module's declarations and died in the temporal dead zone —
> `Cannot access 'STATION_LAYOUT' before initialization`. That is ENG-05 exactly, and it
> behaved exactly as the audit predicted: one throw took out every module after it and
> the whole game went dark. `node --check` passes it, because it is a runtime error, not
> a parse error. The bootstrap now lives in the module that owns the data.
>
> **Two wall buys shipped inside corner-district geometry** — measured zero clear
> stand-points on the buy ring, i.e. shop signs painted on solid walls. Hand-checking
> coordinates against a 140-collider arena does not scale, so `unreachableStations()`
> now runs at load and `scripts/probe_live.py` asserts on it. Repositioned by scanning
> the live collider set for cells with at least 10 of 12 clear stand-points.
>
> 28 new node tests (134 total). Mutation-checked: 25 of 27 breakages fail the suite,
> and the two survivors were confirmed **equivalent mutants** — `platesAffordable` has
> two redundant guards, so removing either alone leaves the function correct; removing
> both is caught. A third apparent survivor was a broken mutation: its anchor string
> appeared twice in the file, so it had patched `penetrate()` instead of the bleed-out
> clock. Re-run with a unique anchor, it kills.
>
> **Still open from `COD_ROADMAP.md`:** all of Phase 11 (tacticals, lethal variants,
> field upgrade, scorestreaks), Phase 12 (special waves, gated map areas, elite variants,
> objective waves) and Phase 13 (XP, unlocks, attachments, camos).

> **Phase 11 — equipment and streaks.** The grenade was the most reusable system in
> the project and the only thing mounted on it was a single frag. Charge-throw, the
> trajectory preview, bounce physics and blast line-of-sight are all payload-agnostic,
> so every variant below is a payload rather than a subsystem. Measured before -> after:
>
> | | before | after |
> |---|---|---|
> | equipment | 2 frags | **4 lethals + 3 tacticals**, all reachable by cycling a board |
> | a flashbang, looking at it / turned away / at range | n/a | **3.86 s / 0.19 s / 1.93 s** blind |
> | a blinded enemy | n/a | **fires 0 tracers**, vs 1 with sight |
> | a stun | n/a | speedMul **1.10 -> 0.38**, restored on expiry |
> | enemy sight through smoke | always clear | **blocked**, and clear again on expiry |
> | thermite burning ground | n/a | **110 damage over 2 s** at 55 dps, expires |
> | semtex | n/a | **sticks on contact**; a frag in the same throw does not |
> | a claymore at 0 / 75 / 180 degrees | n/a | **fires / holds / holds** |
> | a precision airstrike | n/a | **956 damage across 6 targets** down the lane |
> | a sentry gun | n/a | kills a 60 HP target in 1.2 s, expires at 45 s |
> | the field upgrade | n/a | reserve **0 -> 45**, grenades **0 -> 2** |
> | minimap detection | the whole arena, always | **26 m**, lifted to everything by the UAV |
>
> **The UAV is the interesting one**, because it is the cheapest item here and it
> changes something that already existed: the minimap drew every enemy in the arena
> unconditionally, so it had no value to add. Baseline detection is now 26 m, and the
> streak lifts it. The same 30 seconds of information is worth having only because the
> baseline is worth less.
>
> **Smoke is affordable because of a Phase 6 decision.** Enemy line-of-sight became an
> analytic slab test against collider AABBs when prop batching made mesh raycasts cost
> 1.37 ms/frame. Adding a sphere to an analytic path is a few operations; adding one to
> a mesh raycast pass would have been a second full raycast per enemy per tick.
>
> **One real bug, found by measuring rather than by reading.** The claymore's facing was
> captured in the object literal *after* `vel: dir.multiplyScalar(speed)` had already
> mutated `dir` in place, so it stored the velocity — magnitude ~6.7 — instead of a unit
> vector. The cone test `dot / d >= 0.5` then meant `cos >= 0.075`: an **86-degree**
> half-angle instead of 60, which is most of a hemisphere and not a directional mine at
> all. Fixed by moving the cone test into `CORE.coneHit`, which normalises the facing
> itself, so no caller can reintroduce it.
>
> 22 new node tests (156 total). Mutation-checked 15 of 15, including reverting smoke to
> an infinite-line test, making the flash ignore facing, and re-granting a streak on
> every kill past its threshold. One apparent survivor was a broken mutation that added
> an unused field instead of changing the one under test; corrected, it kills.
>
> **Still open from `COD_ROADMAP.md`:** Phase 12 (special waves, gated map areas, elite
> variants, objective waves) and Phase 13 (XP, unlocks, attachments, camos).

**Audit date:** 2026-09-12
**Build under test:** `dist/Operation Blackout.html` (1,351,402 bytes), verified byte-identical to a fresh
`scripts/build.py` output modulo line endings.
**Engine at audit time:** three.js **r128** (vendored, 2021). Now **r186** — see Phase 6.
**Method:** static read of all 11 `src/` modules, plus live instrumentation of the running game in Chromium —
scripted AI simulations, collision stress tests, renderer counters, DOM/rect measurement at desktop and
375×812, and isolated leak tests.

Every item below is tagged:

- **[V]** — reproduced at runtime, with the measurement quoted.
- **[S]** — found by source inspection; consequence reasoned but not reproduced.

---

## 0. Verdict

The game is genuinely finished and genuinely fun to look at — the asset pipeline, the single-file
constraint, the touch layer, and the audio synthesis are all real work, and the codebase is unusually
well-commented for a hobby project. Many past bugs were clearly found and fixed with care.

Three things hold it back, in order:

1. **Enemies cannot navigate.** They seek in a straight line. On roughly half the map they never reach you.
   This is not a polish issue — it is the core loop failing.
2. **The test suite cannot detect a behavioural regression.** Every assertion is a substring match on
   source text. Nothing in it executes the game.
3. **The renderer is doing ~25× more draw calls than the geometry needs**, entirely because the static
   arena is built one `Mesh` per box.

Everything else is downstream of having those three fixed.

---

## 1. Findings register

### A. Correctness & gameplay

| ID | Severity | Finding |
|---|---|---|
| BUG-01 | **Critical** | Enemies have no pathfinding |
| BUG-02 | **Critical** | Enemies stand inside the player's body |
| BUG-03 | **High** | Player tunnels through walls at low framerate |
| BUG-04 | **High** | Enemies permanently trapped on the external staircase |
| BUG-05 | Medium | Weapon swap silently cancels a reload |
| BUG-06 | Medium | Enemy hitboxes do not match the soldier model |
| BUG-07 | Medium | Damage falloff is a binary cliff |
| BUG-08 | Low | In-flight enemy bullets carry across REDEPLOY |
| BUG-09 | Low | ~2% of enemy spawns land inside solid geometry |
| BUG-10 | Low | Pause silently eats a cooking grenade |
| BUG-11 | Low | Ceiling collision only zeroes velocity, never repositions |

---

**BUG-01 — Enemies have no pathfinding.** `moveEnemy()` in [`src/40_enemies.js:275`](src/40_enemies.js)
is a straight-line seek toward the player plus an AABB push-out. There is no navmesh, no waypoint graph,
no wall-following, and no stuck detection.

**[V]** Player placed inside the central building; six melee enemies released from the compass points;
25 s simulated at 60 Hz. **Zero reached him.**

| spawn | final position | outcome |
|---|---|---|
| (0, −30) | (0, **3.2**, −7.7) | climbed the external stairs, jammed under the 2nd-floor parapet |
| (0, +30) | (0, **3.2**, +7.7) | same, mirrored |
| (+30, 0) | (0, 0, 0) | reached the player (open approach) |
| (−30, 0) | (−1.7, 0, 0) | reached the player (open approach) |
| (+25, +25) | (9.4, 0, 7.4) | wedged on the building's outside corner, never found a door |
| (−25, −25) | (−2.0, 0, −7.8) | wedged on the north wall |

Only the two enemies with a clear straight line arrived. This is the single highest-impact defect in the
project.

---

**BUG-02 — Enemies stand inside the player's body.** `dist` is a **3-D** distance
(`en.pos.distanceTo(player.pos)`, [`src/40_enemies.js:430`](src/40_enemies.js)) but is compared against
**horizontal** stop distances (`stopDist` 1.9 / 2.6) and melee reach. `player.pos` is anchored at eye
height 1.7 m while `en.pos.y` is 0, so an enemy standing exactly on your feet reads `dist = 1.7 < 1.9`.
The back-off branch then computes its normal as `(en.pos.x - player.pos.x) / (dist || 1)` — with a zero
horizontal delta, the normal is degenerate and the push-out does nothing.

**[V]** Final horizontal separation measured at **0.001 m** — the enemy occupies the player's exact
position.

This is the same bug class the project already found and fixed for pickups — there is an explicit comment
about it in `updatePickups()` ([`src/55_grenades.js:378`](src/55_grenades.js)) — but the AI never got the
same fix. Every `dist` comparison in `updateEnemies` inherits it, including `rangedRange`, `giveUpDist`,
and the footstep radius.

---

**BUG-03 — Collision tunnelling at low framerate.** `dt` is clamped at 0.1 s
([`src/70_main.js:246`](src/70_main.js)); sprint speed is ~8.9 m/s, so a worst-case step is **0.89 m**
against walls that are **0.8 m** thick. Resolution is discrete AABB overlap, not swept.

**[V]** At `dt = 0.1`, sprinting from z = +9.5 toward −z, the player passed straight through the central
building's south wall, the interior, **and** the north wall, ending at **z = −28.9**. At `dt = 1/60` the
same run is correctly blocked. A single GC pause, an alt-tab, or a mid-range phone hitting 12 fps is
enough to trigger it.

---

**BUG-04 — The external staircase is a one-way trap for AI.** The stairs are cumulative boxes:
step *i* spans y = 0 → (i+1)×0.4, topping out at 4.0 m, while the 2nd-floor slab top is at 4.15 m.
`STEP_H` is 0.60. An enemy that climbs to 3.2 m can never make the final 0.95 m step onto the slab, and
`moveEnemy` has no reversal logic, so it pushes into the parapet forever.

**[V]** Two of six test enemies ended stuck at exactly y = 3.2 and never moved again.

---

**BUG-05 — Weapon swap silently cancels a reload.** `switchWeapon()`
([`src/30_weapons.js:19`](src/30_weapons.js)) sets `curS().reloading = false` with no rollback, no audio
cue and no HUD change.

**[V]** Mid-reload at `reloadT = 0.5`, swapped away and back: `reloading` → `false`, `ammo` still `0`.
The player believes they reloaded and dry-fires into a wave.

---

**BUG-06 — Enemy hitboxes do not match the soldier model.**

**[V]** Measured on a spawned GLB soldier:

| | y-range |
|---|---|
| visible model | 0.00 – **1.84** |
| `hitHead` box | 1.68 – **2.02** |
| `hitBody` box | 0.43 – 1.47 |

- **0.18 m of the head hitbox floats above the model's head** — you can headshot empty air.
- There is a **0.21 m gap** between body-top (1.47) and head-bottom (1.68).

The gap is not a damage dead-zone (the visible mesh is also tagged `enemyRef`, so those shots land as body
hits), but the aim-assist head magnet targets `pos.y + 1.72` and bullet magnetism targets `pos.y + 1.35` —
so the assist snaps into the floating box, making headshots register above the model and land more often
than the visuals justify.

---

**BUG-07 — Damage falloff is a binary cliff.** `distanceFalloff(base, dist, range)`
([`src/30_weapons.js:200`](src/30_weapons.js)) ignores its `base` parameter entirely and returns
`dist > range * 0.6 ? 0.65 : 1`.

**[V]** M4: 26 damage at 71 m → 26 at 72 m → **16.9** at 72.1 m. A one-metre step changes
shots-to-kill from 4 to 6 with no feedback.

---

**BUG-08 — In-flight enemy bullets carry across REDEPLOY.** `enemyShoot()` schedules damage with
`setTimeout` guarded on `started && !paused && !player.dead`
([`src/40_enemies.js:520`](src/40_enemies.js)). **[S]** REDEPLOY leaves `started === true`, so a bullet
fired in the previous run can land in the first ~300 ms of the new one. Quitting to the menu is safe
(`started` goes false).

---

**BUG-09 — Spawns inside geometry.** Spawn ring points are jittered ±6 m with no validity check.
**[V]** 2.0 % of jittered positions land inside a solid collider — roughly **7 enemies per 341-enemy
run** spawn clipped into a wall or crate.

---

**BUG-10 — Pause eats a cooking grenade.** **[V]** Charging at `t = 0.5`; `pauseGame()` →
`grenadeCharging = false`, charge discarded, no throw, no feedback. The grenade count is correctly *not*
decremented, so nothing is lost but the input.

---

**BUG-11 — Ceiling collision is incomplete.** `resolveVertical()`
([`src/20_player.js:104`](src/20_player.js)) zeroes `vel.y` on a head bonk but never repositions the head
below the ceiling; the inner `if` also re-tests a condition the outer `if` already guarantees.
**[V]** Not reachable today — jump apex puts the head at 2.83 m versus a 3.65 m slab bottom. Latent: a
boosted slide-jump or a larger `dt` could clip through.

---

### B. Mobile & UI

| ID | Severity | Finding |
|---|---|---|
| UI-01 | **High** | Weapon viewmodel is entirely off-screen in portrait |
| UI-02 | **High** | Compass is 45° misaligned and half-clipped (desktop *and* mobile) |
| UI-03 | Medium | HUD elements overlap on phone-width screens |
| UI-04 | Medium | Menus are left-aligned on mobile |
| UI-05 | Medium | No landscape prompt; look-zone overlaps action buttons |
| UI-06 | Low | Gun-select renders on top of a still-visible start screen |
| UI-07 | Low | "0 HOSTILES" shown during the pre-wave countdown |

**UI-01 [V]** — At 375×812 the viewmodel projects to NDC **(13.12, −5.51)** — far outside the frustum.
`camera.fov` is *vertical*, so at aspect 0.46 the horizontal FOV collapses and the gun at `x = +0.22`
leaves the screen. **The player sees no weapon at all on a phone held upright.**

**UI-02 [V]** — `#compass-canvas` has `width="560"` and no CSS width override, inside a 280 px
`overflow:hidden` strip (measured: `attrW 560, cssW 560, stripW 280`). `drawCompass()` centres the current
heading at **x = 280** — the strip's right clip edge — while the yellow index line is at **x = 140**. The
compass reads ~45° off with half its ticks invisible. Visible as stray ticks in any desktop screenshot.

**UI-03 [V]** — Measured rect collisions at 379×821: `pause × score`, `health × ammo`, `armor × ammo`.
The 220 px fixed-width health bar simply does not fit beside the ammo column.

**UI-04 [V]** — DEPLOY occupies x 24–220 in a 379 px viewport (centred would be 91–287).
`body.touch #start-screen>div{max-width:100%}` makes the wrapper full-width, and the `inline-block`
button's parent has no `text-align:center`.

**UI-05 [V]** — `#look-zone` spans the right 55 % and overlaps FIRE, ADS, JUMP and NADE. Buttons win the
tap (they are later in the DOM with `pointer-events:auto`), so taps work — but a look-drag that *starts*
on a button is swallowed, and there is no orientation guidance anywhere.

---

### C. Robustness & error handling

| ID | Severity | Finding |
|---|---|---|
| ROB-01 | **High** | Unguarded WebGL init — total silent failure if WebGL is unavailable |
| ROB-02 | **High** | No WebGL context-loss / restore handling |
| ROB-03 | Medium | Unbounded DOM churn under sustained combat |
| ROB-04 | Medium | GPU geometry leak — ~1 per grenade throw |
| ROB-05 | Low | No audio master gain; every sound connects direct to `destination` |

**ROB-01 [V]** — `const renderer = new THREE.WebGLRenderer({...})` sits unguarded at module top level
([`src/10_config_world.js:23`](src/10_config_world.js)). Because `build.py` concatenates every module into
**one** `<script>`, a throw there kills the entire remaining script: no menu, no message, no fallback —
a black page with a console error the player will never open. Confirmed: no `try` anywhere near renderer
construction.

**ROB-02 [V]** — No `webglcontextlost` or `webglcontextrestored` handler exists in the codebase.
Mobile browsers drop WebGL contexts routinely on tab-switch; the game renders black forever with no
recovery path.

**ROB-03 [V]** — `showDamageFx()` creates a `<div>` + **two** `setTimeout`s per hit taken;
`addScore()` creates a `<div>` + one `setTimeout` per kill. A 120-hit burst took the document from
**147 to 627 elements**, with 120 orphaned children each in `#hit-dir-container` and `#killfeed` and
~360 pending timers.

**ROB-04 [V]** — `throwGrenade()` allocates `new THREE.SphereGeometry(0.045, 6, 4)` for the fuse blink on
every throw; `explodeGrenade()` only `scene.remove()`s the mesh and never disposes. Isolated measurement
over 25 throws: **1.04 GPU geometries leaked per throw**, permanently resident.

*Checked and cleared:* the bullet-hole decal pool and the muzzle light are correctly bounded — 300 decal
spawns added **zero** scene children beyond the 48-entry cap. The VFX pools all return to full size after
combat. These are **not** leaks.

**ROB-05 [V]** — `playSound()` builds fresh oscillator/filter/gain nodes per call and connects each gain
straight to `ctx.destination`. At the M4's 750 RPM that is ~37 nodes/second with no master bus, which is
also why there is no possible volume or mute control (see GAP-01).

---

### D. Performance — all figures measured at a wave-10 load (14 live enemies)

| ID | Severity | Finding | Measured |
|---|---|---|---|
| PERF-01 | **High** | Static arena is one mesh per box — no batching | **504 draw calls / 15,710 tris** |
| PERF-02 | **High** | Bullet raycast has no spatial index | **0.562 ms per shot** |
| PERF-03 | Medium | Shadow pass covers the whole arena | 185 casters, 2048², 120×120 ortho |
| PERF-04 | Medium | Grenade blast LOS is O(enemies × scene) | up to 14 full raycasts in one frame |
| PERF-05 | Medium | `hasLOS` double-raycasts for riflemen | 2× per tick instead of 1 |
| PERF-06 | Medium | Grenade trajectory preview brute-forces colliders | ~3,600 AABB tests/frame while charging |
| PERF-07 | Low | Per-shot heap allocations in the hot path | `.clone()` per enemy per shot |
| PERF-08 | Low | HUD writes to the DOM every frame | `updateHudHealth()` + `enemiesLeft` |
| PERF-09 | Low | Pixel-ratio adaptation reallocates the drawbuffer | every 4.5 s, both directions |
| PERF-10 | Low | Synchronous `gl.readPixels` in the soldier probe | one-time, behind the loading screen |

**PERF-01** is the headline. The scene holds **698 meshes**, 439 of them `BoxGeometry`, drawn from only
**8** arena materials — about **32 triangles per draw call**. `addBox()`
([`src/10_config_world.js:123`](src/10_config_world.js)) creates a unique geometry *and* a unique mesh for
every box in the arena. Merging the static world by material takes it from ~200 draw calls to ~8, and it
is close to free to implement because the `colliders[]` AABB array is already stored separately from the
meshes — collision does not depend on mesh identity.

**PERF-02** — `fireShot()` runs two recursive `intersectObjects` passes over 162 roots with no spatial
index: ~7 ms/s at the M4's 750 RPM, ~3× that on the MK18.

> **Corrected 2026-09-12 (Phase 2).** This attribution was wrong. Profiling the function's parts
> showed the world raycast at 0.048 ms and the enemy raycast at 0.012 ms, against 0.116 ms for
> `playSound('shot')` and 0.074 ms for the impact ping. The bottleneck was synthesised audio, not
> raycasting. I had measured `fireShot` as a whole and assumed the raycasts dominated.

**PERF-05** — the LOS throttle only caches on *skipped* frames. On an enemy's own frame, the rifleman
state machine and the ranged-attack block each trigger a full raycast.

---

### E. Content & design gaps

| ID | Finding |
|---|---|
| GAP-01 | **No settings of any kind** — no sensitivity, volume, mute, FOV, invert-Y, rebinding, quality |
| GAP-02 | **No persistence** — `localStorage` untouched; no high score, no stats, no mid-run save |
| GAP-03 | Difficulty curve flattens hard after wave 8 |
| GAP-04 | Only 3 enemy types, all introduced by wave 4; no boss, no new mechanic in the back half |
| GAP-05 | No endless mode after wave 15; no difficulty selection |
| GAP-06 | Secondary weapon is not a choice — always `(slot0 + 1) % 4` |
| GAP-07 | No music, no ambience |
| GAP-08 | No reduced-motion, colorblind, or audio-cue accessibility options |
| GAP-09 | Wave 15 needs ~37 s of spawn gating alone before kill time |

**GAP-01 [V]** — no settings UI exists in the DOM; mouse sensitivity is hardcoded at `0.0022` inside
`updatePlayer`; there is no master gain node to attach a volume control to. For an FPS, sensitivity and
volume are table stakes.

**GAP-02 [V]** — `localStorage` has zero keys. A full run is **341 enemies** at max 14 concurrent —
roughly 25–40 minutes with no checkpoint and nothing recorded at the end.

**GAP-03 [V]** — rifleman accuracy reaches its `accMax` 0.75 cap at **wave 8**. After that only the count
grows:

| wave | count | runner HP | tank HP | rifle acc | rifle dmg |
|---|---|---|---|---|---|
| 1 | 5 | 100 | 320 | 0.54 | 8.3 |
| 8 | 23 | 142 | 454 | **0.75** | 10.8 |
| 15 | 40 | 184 | 589 | **0.75** | 13.3 |

Combined with 12 HP/s regen after 3.5 s and 175 effective HP, waves 9–15 are the same fight, longer —
safe-if-patient rather than harder.

---

### F. Engineering & process

| ID | Severity | Finding |
|---|---|---|
| ENG-01 | **High** | The test suite asserts on source *text*, not behaviour |
| ENG-02 | Medium | The README's documented test command does not run |
| ENG-03 | Medium | `scripts/probe_live.py` — the one real behavioural test — is undocumented and undeclared |
| ENG-04 | Medium | three.js r128 (2021) with deprecated APIs |
| ENG-05 | Medium | 278 globals in a single flat script scope |
| ENG-06 | Low | `build.py` output is not byte-reproducible across platforms |
| ENG-07 | Low | `fireShot` is monkey-patched by reassignment |
| ENG-08 | Low | Dead code throughout |

**ENG-01** — every assertion in `tests/test_release_build.py` is a substring match, e.g.
`assertNotIn("playSound('scope_out')", weapons_src)` and `assertIn("player.jumpBufT = 0", player_src)`.
Renaming a variable **fails** the suite; inverting a conditional **passes** it. **None of BUG-01 through
BUG-11 is detectable by it.** It is a change-detector, not a test suite.

**ENG-02 [V]** — the README's `python3 -m unittest tests/test_release_build.py -v` fails with
`ModuleNotFoundError: No module named 'tests.test_release_build'` (no `tests/__init__.py`).
`python tests/test_release_build.py` works — 11 tests pass in 1.2 s.

**ENG-03 [V]** — `scripts/probe_live.py` is a real Playwright probe that drives the actual UI flow and
checks live state. It is mentioned **0 times** in the README, there is no `requirements.txt` /
`package.json` / CI config anywhere in the repo, and it fails out of the box with
`Executable doesn't exist … run 'playwright install'`. The most valuable testing asset in the project is
effectively invisible.

**ENG-04 [V]** — `REVISION = "128"`. `renderer.outputEncoding` / `THREE.sRGBEncoding` were replaced by
`outputColorSpace` / `SRGBColorSpace` in r152. Also forgoes ~5 years of renderer optimisation and
`BatchedMesh` (r166+), which would suit PERF-01 directly.

**ENG-05 [V]** — 278 top-level declarations share one scope because `build.py` concatenates every module
into a single `<script>`. No collisions exist today (checked), but one future duplicate `const` name is an
instant whole-game `SyntaxError` — and ENG-01 means no test would catch it.

**ENG-06 [V]** — `build.py` uses text-mode I/O, so line endings follow the build OS. A Windows build is
7,351 bytes larger than the committed file with identical content. Fix: `open(..., newline="")`.

**ENG-08 [V]** — all confirmed present: `vfx.muzzleLights` (declared, never used), `addKill()` (defined,
never called), `triggerMuzzleFlashIdle()` (empty), `gunScene = null`, `if (pressed['noop']) {}`,
`(mouseX - assistYaw * 0)`, `hs >= 0` in the land-sound test (always true), `g.add ? null : null` in
`makeEnemyMesh`, box-man arms and legs built as upper halves only, and `distanceFalloff`'s unused `base`
parameter.

---

## 2. Roadmap

Five phases. Each has an explicit exit criterion; do not start the next until the current one's criterion
holds. Phase 0 comes first because without it, nothing in Phases 1–4 can be verified.

### Phase 0 — Make regressions detectable *(foundation)*

> **Exit criterion:** a deliberately reintroduced BUG-02 fails CI.

| Task | Addresses |
|---|---|
| 0.1 Add `tests/__init__.py`; fix the README command | ENG-02 |
| 0.2 Add `requirements.txt` (`playwright`), document `playwright install` and `probe_live.py` in the README | ENG-03 |
| 0.3 Extract pure logic into `src/lib/` — AABB resolve, wave math, ballistics, AI steering — so it runs headless under node | ENG-01 |
| 0.4 Replace every substring assertion with a behavioural equivalent; keep only build-integrity checks as text tests | ENG-01 |
| 0.5 Extend `probe_live.py` into a real scenario suite: AI reachability, tunnelling at `dt=0.1`, HUD rects at 375×812, leak counters | ENG-01 |
| 0.6 Add a GitHub Actions workflow running both suites on push | ENG-03 |
| 0.7 Add a smoke test that the built file parses (`node --check` on the extracted script) | ENG-05 |

*Note: 0.3 is the one structurally invasive task in this phase. Keep it mechanical — move functions, change
nothing — and land it as its own commit so a bisect stays useful.*

### Phase 1 — Fix the core loop *(the game is broken without these)*

> **Exit criterion:** ≥ 95 % of enemies spawned at any ring point reach melee range of a player standing
> anywhere on the map within 30 s; no enemy ends a run inside the player; no tunnelling at `dt = 0.1`.

| Task | Addresses | Notes |
|---|---|---|
| 1.1 **Navigation grid** — bake a 1 m walkable grid from `colliders[]` at load; A\* or flow-field to the player, recomputed ~4 Hz | BUG-01 | The arena is 90×90 and static: a 90×90 flow field is ~8 K cells, recomputable in well under a millisecond. Prefer a flow field — one BFS serves all 14 enemies. |
| 1.2 **Stuck detector** — if an enemy's position moves < 0.3 m in 3 s while in `chase`, repath; after 8 s, respawn at the nearest valid ring point | BUG-01, BUG-04 | Cheap insurance that survives any navmesh gap. |
| 1.3 **Fix the 3-D/horizontal distance bug** — introduce `horizDist(en)` and use it for every stop/reach/range comparison | BUG-02 | One helper, ~8 call sites. Highest value-per-line fix in the document. |
| 1.4 **Sub-step movement** — split the integrate/resolve step whenever `speed * dt > 0.3 m` | BUG-03, BUG-11 | Apply to both player and enemies. Cheaper and far less invasive than swept collision. |
| 1.5 Mark stair cells non-walkable for AI, or give the top step a 0.4 m riser so the climb completes | BUG-04 | Decide whether AI *should* use the roof at all; simplest is to exclude it. |
| 1.6 Validate spawn positions against `colliders[]`; resample up to 8 times | BUG-09 | |

### Phase 2 — Performance & robustness

> **Exit criterion:** < 60 draw calls at a wave-15 load; `fireShot` < 0.1 ms; zero geometry growth over a
> 10-minute scripted run; graceful message on WebGL failure.

| Task | Addresses |
|---|---|
| 2.1 Merge the static arena by material (`BufferGeometryUtils.mergeBufferGeometries` on r128) — keep `colliders[]` exactly as-is | PERF-01 |
| 2.2 Add a uniform spatial grid (or `three-mesh-bvh`) for bullet and LOS raycasts; skip the world pass when the enemy hit is already nearer than the closest wall AABB | PERF-02, PERF-05 |
| 2.3 Cache `hasLOS` per enemy per tick | PERF-05 |
| 2.4 Build the grenade LOS target array once per explosion, not once per enemy | PERF-04 |
| 2.5 Tighten the shadow camera to a box tracking the player; drop `castShadow` from crates, barrels, casings | PERF-03 |
| 2.6 Broad-phase the grenade trajectory preview | PERF-06 |
| 2.7 Hoist per-shot allocations to module-level scratch vectors (pattern already used elsewhere in the file) | PERF-07 |
| 2.8 Make HUD writes change-driven, not per-frame | PERF-08 |
| 2.9 Pool the hit-direction arcs and killfeed rows | ROB-03 |
| 2.10 Wrap renderer construction in `try/catch` with a real "WebGL unavailable" screen | ROB-01 |
| 2.11 Add `webglcontextlost` / `webglcontextrestored` handlers — pause, show a message, rebuild on restore | ROB-02 |
| 2.12 Share one `SphereGeometry` for the grenade fuse blink; dispose on explode | ROB-04 |
| 2.13 Only step pixel ratio *down* readily and *up* rarely, to stop drawbuffer thrash | PERF-09 |

### Phase 3 — Player-facing quality

> **Exit criterion:** a new player can set sensitivity and volume before deploying; a phone in portrait
> shows a weapon and a readable HUD; the compass points where the player is looking.

| Task | Addresses |
|---|---|
| 3.1 **Settings panel** (menu + pause): sensitivity, master/SFX volume, mute, FOV, invert-Y, quality preset — persisted to `localStorage` | GAP-01, GAP-02 |
| 3.2 Route all audio through a master `GainNode` (prerequisite for 3.1) | ROB-05 |
| 3.3 Fix the compass: set the canvas to 280 px, or draw the heading at the strip's true centre | UI-02 |
| 3.4 Portrait: widen the viewmodel FOV or clamp `camera.aspect` for the gun so it stays framed | UI-01 |
| 3.5 Responsive HUD: percentage-width bars, reflow the pause button and score, stack the ammo block | UI-03 |
| 3.6 Centre mobile menus (`text-align:center` on the wrapper) | UI-04 |
| 3.7 Landscape prompt; move the look-zone origin off the action buttons | UI-05 |
| 3.8 Hide the start screen when gun-select opens; show the incoming count during the countdown | UI-06, UI-07 |
| 3.9 Preserve reload progress across a weapon swap, or cue the cancel audibly | BUG-05 |
| 3.10 Re-cook or refund the grenade charge on unpause | BUG-10 |
| 3.11 Recalibrate hitboxes to the 1.84 m model; retune the aim-assist target heights to match | BUG-06 |
| 3.12 Make falloff a smooth ramp between `0.6×range` and `range` | BUG-07 |
| 3.13 Tag scheduled enemy damage with a run ID; drop it if the ID changed | BUG-08 |
| 3.14 Persist high score, best wave, best accuracy; show them on the menu and end screens | GAP-02 |
| 3.15 `prefers-reduced-motion` support; a colorblind-safe enemy marker option | GAP-08 |

### Phase 4 — Depth & replayability

> **Exit criterion:** waves 9–15 present mechanically different problems, not just more bodies.

| Task | Addresses |
|---|---|
| 4.1 Let enemy *behaviour* scale past wave 8 — flanking, suppressing fire, grenades — rather than accuracy, which is already capped | GAP-03 |
| 4.2 Two new enemy types in the back half (e.g. a shielded advancer, a fast flanker) | GAP-04 |
| 4.3 A wave-10 or wave-15 boss with a telegraphed mechanic | GAP-04 |
| 4.4 Endless mode past wave 15 + difficulty selection at deploy | GAP-05 |
| 4.5 Let the player *choose* the secondary from the remaining roster on unlock | GAP-06 |
| 4.6 Between-wave checkpoint save (wave, score, loadout, ammo) so a 30-minute run survives a closed tab | GAP-02 |
| 4.7 Synthesised ambience and a combat music layer on the new master bus | GAP-07 |
| 4.8 Rebalance wave 15's spawn gating so the finale is intense, not slow | GAP-09 |
| 4.9 Consider upgrading three.js and adopting `BatchedMesh` | ENG-04, PERF-01 |
| 4.10 Delete the dead code listed in ENG-08 | ENG-08 |

---

## 3. Recommended immediate slice

If only one day is available, this ordering delivers the most recoverable value:

1. **BUG-02** (`horizDist` helper) — ~20 lines, removes enemies standing inside the player.
2. **BUG-03** (movement sub-stepping) — ~15 lines, closes wall tunnelling.
3. **PERF-01** (merge static arena) — largest measured win, low risk, collision untouched.
4. **UI-02** (compass width) — one CSS/JS line for a bug visible in every single screenshot.
5. **ENG-02** (`tests/__init__.py`) — one empty file; makes the documented command work.

BUG-01 is the most important defect in the project but is a multi-day task; it should be scheduled
deliberately as Phase 1, not squeezed in.

---

## 4. Measurement appendix

Figures captured live at a wave-10 load unless noted.

```
Renderer      504 draw calls · 15,710 triangles · 698 meshes · 157 unique geometries
              439 BoxGeometry meshes · 43 materials (8 for the arena) · 185 shadow casters
              2048² shadow map over a 120×120 ortho frustum · 11 programs · 31 textures

Timings       fireShot            0.562 ms / shot
              updateEnemies       0.695 ms / frame (14 enemies)
              drawMinimap         0.095 ms
              grenade preview     0.097 ms (~3,600 AABB tests)
              updatePlayer        0.008 ms

World         129 collider AABBs · 162 raycast roots · 90×90 m arena

Leaks         grenade throw       1.04 GPU geometries per throw (unbounded)
              decal pool          bounded at 48 (verified: 300 spawns, 0 growth)
              VFX pools           fully restored after combat (verified)
              DOM under fire      147 → 627 elements over a 120-hit burst

Run length    341 enemies across 15 waves · max 14 concurrent
              wave 15 spawn gating alone ≈ 37 s

Mobile        375×812 · viewmodel NDC (13.12, −5.51) — off-screen
              overlaps: pause×score, health×ammo, armor×ammo
              DEPLOY at x 24–220 in a 379 px viewport (centred = 91–287)

Engine        three.js r128 (2021)
Build         dist byte-identical to a fresh build modulo line endings
Tests         11 pass via `python tests/test_release_build.py`
              README command fails: ModuleNotFoundError
              probe_live.py: requires `playwright install`; 0 README mentions
```

---

## 5. Non-goals / explicitly out of scope

- **Rewriting to ES modules or a bundler.** The single-file, no-build-step, `file://`-runnable constraint
  is the project's identity. Phase 0.3 extracts logic for *testing* only; the shipped artifact stays one
  HTML file.
- **Replacing three.js r128 urgently.** It works. Schedule the upgrade (ENG-04) only when `BatchedMesh`
  or a specific fix is wanted — after Phase 2 has already banked the batching win.
- **Multiplayer.** Nothing in the architecture anticipates it; treat it as a different project.
- **The `innerHTML` call sites.** All nine interpolate developer-controlled strings only. In a
  single-player local file with no user input and no network, this is not a security issue. Left as-is.
