"""Adaptive score driven by real production animation frames, not direct audio calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for mode in ('tdm', 'ffa', 'survival'):
            page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
            page.goto(Path(build).resolve().as_uri(), wait_until='domcontentloaded')
            page.wait_for_function('() => assetsReady', timeout=60000)
            page.click('#btn-start'); page.click('#mode-btn-' + mode)
            page.click('#gun-select .gun-card:not(.locked)'); page.click('#gun-select .gun-card:not(.locked)')
            page.wait_for_function('() => started && MUSIC.running && gameT > 0', timeout=60000)
            if mode == 'survival':
                page.evaluate("""() => {
                  waveActive = false; betweenWaveT = 100000; player.health = 25;
                  spawnEnemy(1, player.pos.x + 3, player.pos.z);
                  window.sampleTime = gameT;
                }""")
                page.wait_for_function('() => gameT > window.sampleTime + 0.2', timeout=60000)
                state = page.evaluate('() => ({combat:_musicState.inCombat, target:CORE.combatIntensity(_musicState), running:MUSIC.running})')
                print(mode, 'between-wave:', state, flush=True)
                assert not state['combat'] and state['target'] == 0 and state['running'], state
                page.evaluate('startWave(1); window.sampleTime = gameT')
                page.wait_for_function('() => gameT > window.sampleTime + 0.5', timeout=60000)
                assert page.evaluate('_musicState.inCombat && CORE.combatIntensity(_musicState) > 0 && MUSIC.intensity > 0'), 'Survival wave must raise intensity'
                page.evaluate('pauseGame()')
                assert page.evaluate('paused && !MUSIC.running'), 'Survival pause must stop music'
                page.click('#btn-resume')
                assert page.evaluate('MUSIC.running'), 'Survival resume must restore music'
                page.evaluate('killPlayer()')
                assert page.evaluate('player.dead && !MUSIC.running'), 'Survival death must stop music'
            else:
                # Continuously place the existing real roster and health at controlled
                # distances; normal game frames still execute all production updates.
                page.evaluate("""() => {
                  window.musicPressure = false;
                  window.musicHealth = 100;
                  window.musicControl = setInterval(() => {
                    player.spawnProtectionT = 99;
                    player.health = window.musicHealth;
                    enemies.forEach((e, i) => {
                      if (!e.dead) e.pos.set(player.pos.x + (window.musicPressure ? 3 + i : 20 + i), 0, player.pos.z);
                    });
                  }, 30);
                  window.sampleTime = gameT;
                }""")
                page.wait_for_function('() => gameT > window.sampleTime + 0.4', timeout=60000)
                calm = page.evaluate("""() => ({combat:_musicState.inCombat, target:CORE.combatIntensity(_musicState),
                  intensity:MUSIC.intensity, alive:_musicState.aliveEnemies,
                  hostiles:enemies.filter(e => CORE.isHostile(player,e)).length})""")
                page.evaluate('() => { window.musicPressure = true; window.sampleTime = gameT; }')
                page.wait_for_function('() => gameT > window.sampleTime + 0.5', timeout=60000)
                close_healthy = page.evaluate('() => ({target:CORE.combatIntensity(_musicState), health:_musicState.health})')
                page.evaluate('() => { window.musicHealth = 25; window.sampleTime = gameT; }')
                page.wait_for_function('() => gameT > window.sampleTime + 1', timeout=60000)
                pressure = page.evaluate("""() => ({combat:_musicState.inCombat, target:CORE.combatIntensity(_musicState),
                  intensity:MUSIC.intensity, health:_musicState.health, alive:_musicState.aliveEnemies,
                  hostiles:enemies.filter(e => CORE.isHostile(player,e)).length, waveActive})""")
                print(mode, 'calm:', calm, 'close/healthy:', close_healthy, 'pressure:', pressure, flush=True)
                assert calm['combat'] and pressure['combat'] and not pressure['waveActive'], (calm, pressure)
                assert calm['alive'] == calm['hostiles'] and pressure['alive'] == pressure['hostiles'], (calm, pressure)
                assert close_healthy['target'] > calm['target'] + 0.08, (calm, close_healthy)
                assert pressure['target'] > calm['target'] + 0.1 and pressure['intensity'] > calm['intensity'] + 0.05, (calm, pressure)
                assert close_healthy['health'] > pressure['health'] and pressure['target'] > close_healthy['target'] + 0.1, (close_healthy, pressure)
                page.evaluate('() => { window.musicPressure = false; window.musicHealth = 100; window.sampleTime = gameT; }')
                page.wait_for_function('() => gameT > window.sampleTime + 1.5', timeout=60000)
                easing = page.evaluate('() => ({target:CORE.combatIntensity(_musicState), intensity:MUSIC.intensity})')
                print(mode, 'easing:', easing, flush=True)
                assert easing['target'] < pressure['target'] - 0.1 and easing['intensity'] < pressure['intensity'], (pressure, easing)
                page.evaluate('clearInterval(window.musicControl); pauseGame()')
                assert page.evaluate('paused && !MUSIC.running'), 'pause must stop music'
                paused = page.evaluate('MUSIC.intensity')
                page.wait_for_timeout(500)
                assert page.evaluate('MUSIC.intensity') == paused, 'paused frame must not advance intensity'
                page.click('#btn-resume')
                page.evaluate('killPlayer(); window.sampleTime = gameT')
                page.wait_for_function('() => gameT > window.sampleTime + 0.2', timeout=60000)
                dead = page.evaluate('() => ({dead:player.dead, combat:_musicState.inCombat, target:CORE.combatIntensity(_musicState), running:MUSIC.running})')
                print(mode, 'nonterminal death:', dead, flush=True)
                assert dead['dead'] and not dead['combat'] and dead['target'] == 0 and dead['running'], dead
            assert not errors, errors
            page.close()
        browser.close()
    print('production-frame adaptive combat music: passed')


if __name__ == '__main__':
    main()
