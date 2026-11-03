#!/usr/bin/env python3
"""Old and malformed stores survive reload without granting locked cosmetics."""
from pathlib import Path
from playwright.sync_api import sync_playwright

BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.evaluate('''() => {
          localStorage.setItem('blackout.settings.v1', JSON.stringify({difficulty:'recruit', startingPerk:'bad'}));
          localStorage.setItem('blackout.stats.v1', JSON.stringify({runs:3,totalKills:14,totalHeadshots:7,xp:3000}));
          localStorage.setItem('ob_loadouts_v1', JSON.stringify({'0':{optic:'reddot'},'6':{stock:'lightstock'}}));
          localStorage.setItem('ob_cosmetics_v1', JSON.stringify({camos:{'0':'woodland'},kit:'olive'}));
        }''')
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        assert page.evaluate("getSetting('difficulty') === 'recruit' && getSetting('startingPerk') === 'none'")
        assert page.evaluate("getStats().runs === 3 && getStats().totalKills === 14 && getStats().totalHeadshots === 7")
        assert page.evaluate("getLoadout(0).optic === 'reddot' && !getLoadout(6).stock")
        assert page.evaluate("getCamo(0) === 'default' && getKitColour() === 'default'")
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("started && curW().attachments.includes('reddot') && gunGroup.userData.camo === 'default'")
        page.evaluate("localStorage.setItem('blackout.settings.v1', '{broken'); localStorage.setItem('ob_cosmetics_v1', '{broken')")
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        assert page.evaluate("getSetting('startingPerk') === 'none' && getCamo(0) === 'default' && getKitColour() === 'default' && getStats().runs === 3")
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
