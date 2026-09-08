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

Every shipped version passes: `node --check` on all modules, a full-parse syntax gate on the assembled file, and a headless browser regression suite — movement axes, aimed-shot ballistics (spawn target dead-ahead via camera-forward math, assert exact damage), wave progression, menu button battery, mobile touch emulation (press/release ownership, multi-finger fire, joystick sprint), grenade cover occlusion, and GPU-geometry stability across resets. See the changelog in the project documentation for per-version verified results.

Known unverified: real-GPU frame rates, full 15-wave completion, physical Android hardware. Headless CI runs at ~10 FPS software rendering — it verifies mechanics, not performance.

## Credits

- Three.js (MIT)
- CC0 models from Kenney (soldier, trees, crates, columns, barrels) embedded as base64
- All sounds synthesized in-browser with WebAudio — no copyrighted assets

## License

MIT
