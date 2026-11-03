#!/usr/bin/env python3
"""Verify new-career weapon selection and Gun Game issuance in the built game."""
from pathlib import Path
from playwright.sync_api import sync_playwright

BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 720})
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        assert page.evaluate('playerRank()') == 1
        page.click('#btn-gunsmith')
        assert page.locator('#gs-weapons button:disabled').count() == 0, 'rank-one Gunsmith locks weapons'
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        assert page.locator('#gun-cards .gun-card.locked').count() == 0, 'rank-one deploy locks weapons'
        assert page.locator('#gun-cards .gun-card').count() == page.evaluate('CFG.weapons.filter(w => !w.sidearm).length')
        page.locator('#gun-cards .gun-card').last.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate('started && weaponsOwned[0] === CFG.weapons.length - 2')
        context.close()
        context = browser.new_context(viewport={'width': 1280, 'height': 720})
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-start')
        page.click('#mode-btn-gun-game')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate('''() => {
            for (let tier = 0; tier < CORE.GUN_GAME_LADDER.length - 1; tier++) {
              MODES['gun-game'].setTier(player, tier);
              if (weaponsOwned[0] !== CORE.gunGameTierWeapon(tier)) return false;
            }
            return playerRank() === 1;
        }'''), 'Gun Game failed to issue a ladder weapon at rank one'
        assert not errors, errors
        context.close()
        browser.close()


if __name__ == '__main__':
    main()
