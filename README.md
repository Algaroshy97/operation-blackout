# Operation Blackout

A single-file, offline, wave-defense FPS built with Three.js. One HTML file — no server, no installs, no build step. Open it in Chrome or Edge and play.

![waves](https://img.shields.io/badge/waves-15%20to%20victory-8a2f2f) ![single file](https://img.shields.io/badge/single--file-HTML-blue)

## Play

**Windows / desktop (tested best):** download `dist/Operation Blackout.html`, double-click, play. Right-click → *Save link as* works too if your browser opens it as text.

**Android:** copy the same file to the phone, open in Chrome. Touch controls appear automatically (virtual joystick, look-drag, on-screen buttons; pushing the stick fully forward sprints).

Controls (desktop): WASD move · mouse aim/fire · right-mouse ADS · Shift sprint / steady sniper scope · C slide while sprinting · Space jump / slide-jump · R reload · G grenade · P/Esc pause.

Survive 15 waves. Kills drop ammo and medkits. Multi-kill streaks award escalating bonuses (DOUBLE → RAMPAGE).

## Repository layout

- `dist/Operation Blackout.html` — the shippable, self-contained game (all assets embedded as base64; works from `file://`)
- `src/` — modular source: config/world, player, touch input, weapons, enemies/AI, VFX/audio, grenades, HUD/waves, main loop
- `vendor/` — vendored Three.js + GLTFLoader (MIT)
- `scripts/build.py` — assembles head + vendor + src into the single file

The `src/` tree is the readable code; the `dist/` file is what you run.

## Build

```bash
python3 scripts/build.py .   # or: python3 scripts/build.py <repo root>
```

## Testing

Run the fast regression checks with:

```bash
python3 -m unittest tests/test_release_build.py -v
```

They verify that the release build works from the repository root and that the desktop soldier path has a scale-correct, non-culled GLB plus a guaranteed procedural fallback. The test suite does not measure real-GPU frame rate or replace playtesting on Android hardware.

## Credits

- Three.js (MIT)
- CC0 models from Kenney (soldier, trees, crates, columns, barrels) embedded as base64
- All sounds synthesized in-browser with WebAudio — no copyrighted assets

## License

MIT
