# Operation Blackout

A single-file, offline, wave-defense FPS built with Three.js. One HTML file — no server, no installs, no build step. Open it in Chrome or Edge and play.

![waves](https://img.shields.io/badge/waves-15%20to%20victory-8a2f2f) ![single file](https://img.shields.io/badge/single--file-HTML-blue)

## Play

**Windows / desktop (tested best):** download `dist/Operation Blackout.html`, double-click, play. Right-click → *Save link as* works too if your browser opens it as text.

**Android:** copy the same file to the phone, open in Chrome. Touch controls appear automatically (virtual joystick, look-drag, on-screen buttons; pushing the stick fully forward sprints). Mobile defaults to the *Low* graphics preset.

**Controller:** any standard-mapping gamepad (Xbox / PlayStation) works in game and in menus.

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Move / look | WASD · mouse | LS · RS |
| Fire / aim | Mouse1 · Mouse2 | RT · LT |
| Sprint (steady scope when aimed) | Shift | L3 |
| Crouch · slide (while sprinting) | C / Ctrl | B (hold) |
| Jump · mantle · slide-jump | Space | A |
| Lean | Q / E | D-pad ◀ ▶ |
| Knife | V / F | RB / R3 |
| Reload | R | X |
| Grenade (hold to aim the arc) | G | LB |
| Weapons (primary · sniper · pistol) | 1 / 2 / 3 / X / wheel | Y |
| Scope zoom 4x ↔ 8x (while scoped) | Z / wheel | D-pad ▲ |
| Pause | P / Esc | Start |

Survive 15 waves. Kills drop ammo and medkits; supply drops every three waves offer a choice of upgrades.

## What's in it

- **Graphics** — HDR rendering with MSAA, two-level bloom, ACES tone mapping and colour grading; dusk sky with drifting clouds and sun glow; image-based reflections; player-following texel-snapped sun shadows; procedural PBR textures (colour + normal maps generated on canvases at startup — zero asset bytes); GPU particle system for smoke, fire, sparks, dust and blood; travelling HDR tracers; bullet-hole, blood and scorch decals; set-dressing (cars, barriers, sandbags, lamps, power lines, rubble, puddles, skyline).
- **Physics** — sphere-vs-AABB rigid bodies (grenades land on roofs and ledges; tumbling debris); explosive barrels with fuses, chain reactions, shrapnel and burning pools; blast knockback; enemy deaths topple as rigid bodies (or launch, if a blast killed them); casings bounce on whatever floor is below; bullet penetration through wood, glass and sheet metal.
- **Movement** — smooth crouch, slide and slide-jump, lean around cover, mantle/vault onto anything up to ~2 m, fall damage and landing impact, camera shake.
- **Sniper (always carried)** — the SV-98 rides in slot 2 whatever primary you pick: 4x/8x scope with mil-dot reticle, rangefinder, eye-box parallax and breath gauge; you stay scoped while working the bolt; breathing sway moves your real aim (hold Shift to steady); rounds punch through bodies and up to 0.95 m of concrete (wallbang and collateral bonuses); vapour trails and bullet-time on long headshots.
- **Weapons** — M4A1, KRISS Vector, SCAR-H, M249, M870 plus the SV-98 and an M17 sidearm: patterned recoil with recovery, spread bloom, damage falloff, tactical vs empty reloads, shell-by-shell shotgun reloads, bolt and pump cycling, knife with lethal backstabs. Each viewmodel is built from primitives at runtime with animated parts, gloved hands and working optics.
- **Enemy models & ragdolls** — articulated procedural soldiers (shaped torsos, rounded limbs, plate carriers, helmets with NVGs or visors, boots, rifles) with stride-synced walk/run cycles, aim and crouch poses, melee and throw animations and physical hit reactions. Deaths hand over to a 15-particle Verlet ragdoll with knee/elbow limits and world collisions; explosions and bullets keep pushing corpses.
- **Enemies** — runners (zig-zag, lunge), riflemen (cover, crouch, bursts, suppression), heavies (armour, roar-and-charge) and grenadiers (ballistic grenade lobs). They navigate a flow field around the map, fire real hitscan rounds that cover blocks, and react to gunfire and incoming grenades.
- **Systems** — supply-drop perks, three difficulties, best score per difficulty, settings menu (sensitivity, FOV, toggles, live graphics quality, volume), damage numbers, dynamic crosshair, minimap, compass, synthesized positional audio with reverb.

## Repository layout

- `dist/Operation Blackout.html` — the shippable, self-contained game (all assets embedded; works from `file://`)
- `src/` — modular source, concatenated in file-name order:
  `00_head.html` (UI/CSS) · `05/06` embedded assets · `07_settings` · `08_textures` · `10_config_world` · `15_world_detail` · `20_player` · `25_touch` · `27_gamepad` · `30_weapons` · `32_viewmodels` · `34_scope` · `38_soldier` · `40_enemies` · `45_navigation` · `47_physics` · `48_particles` · `50_vfx_audio` · `55_grenades` · `57_destructibles` · `60_hud_waves` · `62_perks` · `64_settings_ui` · `65_postfx` · `70_main`
- `vendor/` — vendored Three.js r128 + GLTFLoader (MIT)
- `scripts/build.py` — assembles head + vendor + src into the single file
- `scripts/probe_live.py` — headless gameplay probe (Playwright + SwiftShader)

## Build

```bash
python3 scripts/build.py .   # or: python3 scripts/build.py <repo root>
```

## Testing

```bash
python3 -m unittest tests/test_release_build.py -v   # fast static + build checks
python3 scripts/probe_live.py [--quality low|medium|high] [--chromium /path/to/chrome]
```

The probe boots the build, deploys through the real menus and checks enemies, navigation, firing, particles, a barrel explosion, a sniper wallbang, ragdoll settling, the perk menu, a live quality switch and a clean console. It runs on SwiftShader, so it verifies behaviour, not frame rate — playtest on real hardware (especially Android) for performance.

## Credits

- Three.js (MIT)
- CC0 models from Kenney (trees, crates, columns, barrels) embedded as base64; soldiers and weapons are built procedurally
- All textures generated procedurally; all sounds synthesized in-browser with WebAudio — no copyrighted assets

## License

MIT
