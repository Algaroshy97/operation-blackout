#!/usr/bin/env python3
"""Career wave challenge accurately describes real defeat and victory paths."""
from pathlib import Path
from playwright.sync_api import sync_playwright
BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for wave, win in ((14, False), (15, False), (15, True)):
            context = browser.new_context(viewport={'width':1280,'height':720})
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
            page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
            page.click('#btn-start')
            page.locator('#gun-cards .gun-card').first.click()
            page.locator('#gun-cards .gun-card').first.click()
            page.evaluate('(n) => { waveNum = n; }', wave)
            page.evaluate('victory()' if win else 'killPlayer()')
            assert page.evaluate("getStats().bestWave") == wave
            assert page.evaluate("cosmeticUnlocked('sand')") == (wave >= 15)
            assert 'Reach wave 15' in page.evaluate('challengesHtml()'), 'challenge incorrectly promises a clear'
            page.reload(wait_until='load', timeout=120000)
            page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
            page.click('#btn-gunsmith')
            assert 'Reach wave 15' in page.locator('#kit-choice option[value=sand]').inner_text()
            assert page.evaluate("document.querySelector('#kit-choice option[value=sand]').disabled") == (wave < 15)
            context.close()
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
