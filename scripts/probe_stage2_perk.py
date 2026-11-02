#!/usr/bin/env python3
"""Fresh-career starting perk through real deploy and match respawn."""
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
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-start')
        assert page.locator('#starting-perk').count() == 1, 'starting perk choice missing'
        page.select_option('#starting-perk', 'reload')
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-start')
        assert page.locator('#starting-perk').input_value() == 'reload'
        page.click('#mode-btn-tdm')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("perks.length === 1 && perks[0] === 'reload' && CORE.perkReloadMul(perks) < 1")
        assert page.evaluate("() => { killPlayer(); updateModeRespawns(4, openSpawnPoints(), enemies, colliders); return !player.dead && perks.length === 1 && perks[0] === 'reload'; }")
        page.context.close()
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-start')
        page.select_option('#starting-perk', 'steady')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("() => { waveNum = 1; return saveCheckpoint(captureRunState()); }")
        page.evaluate("setSetting('startingPerk', 'scav')")
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate('resumeRun()')
        assert page.evaluate("started && perks.length === 1 && perks[0] === 'steady' && CORE.perkBloomMul(perks) < 1")
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
