"""Stage4 browser acceptance, real menu/buttons, storage/reload and lifecycle.
Run after build: python3 -u tests/probe_stage4_stats.py
Uses isolated Chromium storage; no external services or publication.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run():
    checks = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 800, "height": 600}, device_scale_factor=0.5)
        page.add_init_script("localStorage.setItem('blackout.settings.v1', JSON.stringify({quality:'low', shadowQuality:'off', postProcessing:'off'}))")
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        def boot():
            page.wait_for_function('assetsReady === true')
        def kill():
            page.evaluate("""() => {
                paused = true;
                const e = spawnEnemy(0, 10, 10);
                e.health = 1; e.spawnProtectionT = 0;
                damageEnemy(e, 9999, e.pos, false, false, 'AR', player, 'Acceptance rifle');
            }""")
        def stat():
            return page.evaluate('STATS.modeStats.survival')
        page.goto((ROOT / 'dist/Operation Blackout.html').as_uri())
        boot()
        page.click('#btn-stats')
        assert page.locator('#stats-screen').is_visible()
        assert 'GUN-GAME' in page.locator('#stats-records').inner_text()
        assert page.evaluate("document.activeElement.id") == 'btn-stats-back'
        page.keyboard.press('Enter')
        assert not page.locator('#stats-screen').is_visible()
        assert page.evaluate("document.activeElement.id") == 'btn-stats'
        checks.append('separate statistics page and native keyboard navigation')
        page.click('#btn-start')
        page.locator('#gun-select .gun-card:not(.locked)').first.click()
        page.locator('#gun-select .gun-card:not(.locked)').first.click()
        page.wait_for_function('started === true')
        kill()
        first = stat()
        page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}))")
        kill()
        assert stat()['kills'] == first['kills'] + 1
        checks.append('actual pagehide event followed by continued production damage is durable')
        before = stat()
        page.reload()
        boot()
        assert stat() == before
        checks.append('abrupt reload keeps combat without requiring checkpoint/unload')
        # Fresh deploy; preserve career totals, then use the actual victory and
        # resume/endless buttons across a true document reload.
        page.click('#btn-start')
        page.locator('#gun-select .gun-card:not(.locked)').first.click()
        page.locator('#gun-select .gun-card:not(.locked)').first.click()
        page.wait_for_function('started === true')
        kill()
        page.evaluate('() => { waveNum=15; victory(); victory(); }')
        victory_stats = stat()
        assert victory_stats['wins'] == 1
        assert 'MATCH STATISTICS' in page.locator('#vs-stats').inner_text()
        assert 'Acceptance rifle' in page.locator('#vs-stats').inner_text()
        page.reload()
        boot()
        print('resuming victory checkpoint', flush=True)
        page.click('#btn-resume-run')
        print('resumed victory checkpoint', flush=True)
        assert page.locator('#victory-screen').is_visible()
        assert 'MATCH STATISTICS' in page.locator('#vs-stats').inner_text()
        assert stat() == victory_stats
        page.click('#btn-endless')
        kill()
        assert stat()['kills'] == victory_stats['kills'] + 1
        assert stat()['wins'] == 1
        page.evaluate('() => { killPlayer(); killPlayer(); }')
        assert stat()['deaths'] == 1
        assert stat()['wins'] == 1
        assert 'Favorite weapon' in page.locator('#ds-stats').inner_text()
        final = stat()
        page.reload()
        boot()
        assert stat() == final
        page.click('#btn-stats')
        assert 'Acceptance rifle' in page.locator('#stats-records').inner_text()
        checks.append('victory checkpoint true reload resume endless death exactly once with summaries')
        assert not errors, errors
        print(json.dumps({'ok': True, 'checks': checks, 'finalSurvival': final, 'pageErrors': errors}, indent=2))
        browser.close()


if __name__ == '__main__':
    run()
