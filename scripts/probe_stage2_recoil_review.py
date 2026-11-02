#!/usr/bin/env python3
"""Compare actual recoil from matched deployed shots with and without foregrip."""
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
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        result = page.evaluate('''() => {
          const old = Math.random, shots = [];
          try {
            Math.random = () => 0.5;
            for (const key of [null, 'foregrip']) {
              LOADOUTS[0] = {}; if (key) setAttachment(0, 'under', key);
              refreshWeaponStats(0); player.recoilP = 0; player.recoilY = 0;
              player.onGround = true; player.crouching = false; player.sliding = false;
              recoilShot = 3; lastShotT = gameT; bloom = 0;
              const pat = CORE.recoilAt(CORE.recoilPatternFor(curW().type), 4, 0, 0);
              const kick = CORE.effectiveRecoilKick(curW().recoilV, curW().recoilH, pat.x, pat.y, 1);
              fireShot(); shots.push({actual:player.recoilY, expected:kick.yawKick});
            }
          } finally { Math.random = old; }
          return shots;
        }''')
        assert all(abs(x['actual'] - x['expected']) < 1e-9 for x in result), result
        assert abs(result[1]['actual']) < abs(result[0]['actual']) and abs(result[0]['actual']) > 0, result
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
