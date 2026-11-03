"""Focused real-browser music lifecycle probe against the supplied release build."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto(Path(build).resolve().as_uri(), wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady === true', timeout=60000)
        page.click('#btn-start')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        page.wait_for_function('() => started && MUSIC.step > 0')
        page.evaluate("""() => { window.musicAnalyser = MUSIC.ctx.createAnalyser(); MUSIC.comp.connect(window.musicAnalyser); }""")
        page.wait_for_timeout(1500)
        audio = page.evaluate("""() => {
          const a = new Float32Array(window.musicAnalyser.fftSize);
          window.musicAnalyser.getFloatTimeDomainData(a);
          return {state: MUSIC.ctx.state, rms: Math.sqrt(a.reduce((n,x) => n + x*x, 0) / a.length)};
        }""")
        print('initial music graph capture:', audio)
        assert audio['state'] == 'running' and audio['rms'] > 0.015, audio
        page.evaluate('pauseGame()')
        assert not page.evaluate('MUSIC.running'), 'pause must silence scheduled music'
        page.click('#btn-resume')
        assert page.evaluate('MUSIC.running'), 'resume must restore music'
        page.evaluate('victory()')
        assert not page.evaluate('MUSIC.running'), 'victory must stop music'
        page.click('#btn-endless')
        assert page.evaluate('MUSIC.running'), 'endless must restore music after victory'
        page.evaluate("setSetting('musicVolume', 0); pauseGame()")
        page.click('#btn-resume')
        assert not page.evaluate('MUSIC.running'), 'zero music volume must remain silent'
        page.evaluate("setSetting('musicVolume', 0.5)")
        assert page.evaluate('MUSIC.running'), 'raising music volume during play must restore music'
        page.evaluate("setSetting('muted', true); setSetting('musicVolume', 0)")
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady === true', timeout=60000)
        page.click('#btn-start')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        assert page.evaluate("getSetting('muted') && getSetting('musicVolume') === 0 && AUDIO.master === 0")
        page.evaluate("setSetting('muted', false)")
        page.wait_for_timeout(400)
        assert page.evaluate("getSetting('musicVolume') === 0 && MUSIC.bus.gain.value < 0.005")
        page.wait_for_function('() => MUSIC.step > 6', timeout=30000)
        page.evaluate("""() => { window.musicAnalyser = MUSIC.ctx.createAnalyser(); MUSIC.comp.connect(window.musicAnalyser); setSetting('musicVolume', 0.5); }""")
        page.wait_for_timeout(1500)
        restored = page.evaluate("""() => { const a = new Float32Array(window.musicAnalyser.fftSize); window.musicAnalyser.getFloatTimeDomainData(a); return Math.sqrt(a.reduce((n,x) => n+x*x, 0)/a.length); }""")
        assert restored > 0.01, ('music must become audible promptly after raising volume', restored)
        page.evaluate('killPlayer()')
        assert not page.evaluate('MUSIC.running'), 'terminal Survival death must stop music'
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady === true', timeout=60000)
        page.click('#btn-start')
        page.click('#mode-btn-tdm')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        page.wait_for_function('() => started && MUSIC.running')
        page.evaluate('killPlayer()')
        assert page.evaluate('player.dead && MUSIC.running'), 'nonterminal death must retain score'
        page.evaluate('pauseGame()')
        page.click('#btn-resume')
        assert page.evaluate('!MUSIC.running'), 'dead paused player must not restart before respawn'
        page.evaluate('updateModeRespawns(4, openSpawnPoints(), enemies, colliders)')
        assert page.evaluate('!player.dead && MUSIC.running'), 'real respawn must restore score'
        assert not errors, errors
        browser.close()
    print('stage3 music pause/resume and endless lifecycle: passed')


if __name__ == '__main__':
    main()
