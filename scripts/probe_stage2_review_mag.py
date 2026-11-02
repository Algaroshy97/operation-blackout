#!/usr/bin/env python3
"""Magazine trade-off displayed by Gunsmith matches deployed capacity."""
from pathlib import Path
from playwright.sync_api import sync_playwright
BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width':1280,'height':720})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate('STATS.xp = CORE.xpForRank(CORE.MAX_RANK); saveStats()')
        page.click('#btn-gunsmith')
        page.locator('#gs-weapons button').nth(3).click()
        option = page.get_by_role('button', name='FAST MAG', exact=False)
        text = option.inner_text()
        assert 'mag 5 → 4 (-20%)' in text and '-15% mag' not in text, text
        option.click()
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').nth(3).click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate('curW().mag === 4 && curS().ammo === 4')
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
