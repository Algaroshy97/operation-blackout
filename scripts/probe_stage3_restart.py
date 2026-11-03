"""Weather remains match-locked and resolves once at actual match restart."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(Path(build).resolve().as_uri(), wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady', timeout=60000)
        page.click('#btn-start'); page.click('#mode-btn-tdm')
        page.select_option('#weather-select', 'night')
        page.click('#gun-select .gun-card:not(.locked)'); page.click('#gun-select .gun-card:not(.locked)')
        assert page.evaluate('activeWeather') == 'night'
        page.evaluate('pauseGame()'); page.click('#btn-settings-pause')
        page.select_option('#set-weather', 'dusk')
        assert page.evaluate('activeWeather') == 'night', 'next match setting must not change the current match'
        page.click('#btn-settings-back'); page.click('#btn-resume')
        page.evaluate('killPlayer(); updateModeRespawns(10, openSpawnPoints(), enemies, colliders)')
        assert page.evaluate('!player.dead && activeWeather === "night"'), 'respawn must preserve weather'
        page.evaluate("""() => {
          window.weatherCalls = 0; window.originalChooseWeather = chooseMatchWeather;
          chooseMatchWeather = function(map, choice) {
            window.weatherCalls++; const previous = Math.random; Math.random = () => 0.99;
            try { return window.originalChooseWeather(map, choice); } finally { Math.random = previous; }
          };
          const mode = getActiveMode(); mode.timeLeft = 0; mode.update(1/60);
        }""")
        page.click('#btn-match-restart')
        state = page.evaluate("() => ({weather:activeWeather, calls:window.weatherCalls, sun:sun.intensity, expected:1.35*LIGHT_COMPAT*0.72, light:nightLight && nightLight.parent === scene})")
        print('manual restart:', state)
        assert state['weather'] == 'dusk' and state['calls'] == 1 and abs(state['sun'] - state['expected']) < 0.001 and not state['light'], state
        page.evaluate('pauseGame()'); page.click('#btn-settings-pause'); page.select_option('#set-weather', 'random')
        assert page.evaluate('activeWeather') == 'dusk'
        page.click('#btn-settings-back'); page.click('#btn-resume')
        page.evaluate('() => { window.weatherCalls = 0; const mode = getActiveMode(); mode.timeLeft = 0; mode.update(1/60); }')
        page.click('#btn-match-restart')
        random_state = page.evaluate("() => ({weather:activeWeather, calls:window.weatherCalls})")
        print('random restart:', random_state)
        assert random_state == {'weather': 'rain', 'calls': 1}, random_state
        page.wait_for_timeout(500)
        assert page.evaluate('activeWeather') == 'rain'
        assert not errors, errors
        browser.close()
    print('stage3 match weather restart lifecycle: passed')


if __name__ == '__main__':
    main()
