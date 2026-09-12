# Operation Blackout

A single-file, offline, wave-defense FPS built with Three.js. One HTML file — no server, no installs, no build step. Open it in Chrome or Edge and play.

![waves](https://img.shields.io/badge/waves-15%20to%20victory-8a2f2f) ![single file](https://img.shields.io/badge/single--file-HTML-blue)

## Play

**Windows / desktop (tested best):** download `dist/Operation Blackout.html`, double-click, play. Right-click → *Save link as* works too if your browser opens it as text.

**Android:** copy the same file to the phone, open in Chrome. Touch controls appear automatically (virtual joystick, look-drag, on-screen buttons; pushing the stick fully forward sprints). Landscape is required; the touch HUD and the end screens are laid out for viewports down to 800x360 and inset past display cutouts and the gesture bar.

Controls (desktop): WASD move · mouse aim/fire · right-mouse ADS · Shift sprint / steady sniper scope · C slide while sprinting · Space jump / slide-jump · R reload · G grenade · P/Esc pause.

SETTINGS on the main menu or the pause screen covers mouse sensitivity, invert-Y, field of view, master volume, mute, graphics quality, reduced camera motion, high-contrast enemy markers and the FPS counter. Everything is saved in the browser, along with your best score, best wave and best accuracy.

Pick a difficulty and both weapons at deploy, then survive 15 waves — or take **CONTINUE — ENDLESS** past the finish and see how far you get. Kills drop ammo and medkits. Multi-kill streaks award escalating bonuses (DOUBLE → RAMPAGE).

Your run is **checkpointed after every wave**, so closing the tab does not cost you the session — RESUME RUN appears on the main menu.

Hostiles escalate by *behaviour*, not just by count: they fire on the move from wave 5, flank from wave 8, fire in bursts from wave 10, and start throwing grenades to flush you out of cover from wave 12.

New archetypes arrive across the whole curve, each announced as it shows up: **scouts** (wave 3) are fast, fragile and always flanking; **grenadiers** (wave 6) hold their distance and lob frags to deny your cover; **shielded advancers** (wave 9) carry a frontal plate that absorbs most of what you put into it — flank them, headshot them, or grenade them.

The soundtrack is synthesised in-browser and follows the fight: a drone between waves, a heartbeat that climbs from 46 to 132 bpm as enemies close in and your health drops. Every one-shot is rendered to a buffer once at deploy rather than re-synthesised per trigger, so firing costs a single buffer playback.

## Repository layout

- `dist/Operation Blackout.html` — the shippable, self-contained game (all assets embedded as base64; works from `file://`)
- `src/` — modular source: pure core logic, config/world, player, touch input, weapons, enemies/AI, VFX/audio, grenades, HUD/waves, main loop
- `src/01_core.js` — engine-free gameplay rules (distances, sub-stepping, ballistics, wave scaling, AI navigation). No THREE, no DOM, so it runs unchanged in the browser build *and* under `node --test`.
- `vendor/` — three.js **r186** + GLTFLoader, bundled to a single IIFE (MIT). See `vendor/README.md` to regenerate.
- `scripts/build.py` — assembles head + vendor + src into the single file
- `scripts/probe_live.py` — drives the built file in headless Chromium and probes live gameplay state

The `src/` tree is the readable code; the `dist/` file is what you run.

## Build

```bash
python3 scripts/build.py .   # or: python3 scripts/build.py <repo root>
```

## Testing

Two suites. Both run in a couple of seconds and neither needs a GPU.

```bash
node --test tests/test_core.js              # gameplay rules, headless
python -m unittest tests.test_release_build # build integrity (also drives the node suite)
```

`tests/test_core.js` executes the real rules from `src/01_core.js` — enemy pathfinding
reachability, collision sub-stepping, damage falloff, spawn validity, wave scaling. Each
regression test names the audit ID it guards, so reintroducing a fixed defect fails here.

`tests/test_release_build.py` checks the artifact: that the build runs, that the output is
genuinely self-contained (no external fetches), that the concatenated bundle parses, that
every `src/` module reaches it, and that it stays under the size budget.

### End-to-end browser probe

One-time setup, then a full run through the real UI in headless Chromium:

```bash
pip install -r requirements.txt
playwright install chromium
python scripts/probe_live.py
```

Neither suite measures real-GPU frame rate or replaces playtesting on Android hardware.

## Project status

See [AUDIT_AND_ROADMAP.md](AUDIT_AND_ROADMAP.md) for the full findings register and the
phased plan. Phases 0-10 are complete.

## Credits

- Three.js r186 (MIT), bundled with esbuild so the game can stay one classic script
- CC0 models from Kenney (soldier, trees, crates, columns, barrels) embedded as base64
- All sounds synthesized in-browser with WebAudio — no copyrighted assets

## License

MIT
