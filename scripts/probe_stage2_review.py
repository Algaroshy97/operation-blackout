#!/usr/bin/env python3
"""Review regressions through real deployed shots and Gunsmith DOM."""
from pathlib import Path
from playwright.sync_api import sync_playwright

BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate('STATS.xp = CORE.xpForRank(CORE.MAX_RANK); saveStats()')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        result = page.evaluate('''() => {
          const originalRandom = Math.random, originalSet = raycaster.set;
          const directions = [];
          try {
            Math.random = () => 0.75; keys.Mouse2 = true;
            raycaster.set = function(origin, direction) { directions.push(direction.clone()); return originalSet.call(this, origin, direction); };
            for (const key of [null, 'heavystock', 'scope4x']) {
              LOADOUTS[0] = {}; if (key) setAttachment(0, key === 'scope4x' ? 'optic' : 'stock', key);
              refreshWeaponStats(0); swayPhase = 0; bloom = 0; updateSway(0.7); fireShot();
              if (key) { curS().eff.sway = 1; bloom = 0; fireShot(); }
            }
          } finally { Math.random = originalRandom; raycaster.set = originalSet; }
          return directions.slice(0,5).map(v => [v.x,v.y,v.z]);
        }''')
        assert len(result) == 5 and result[1] != result[2] and result[3] != result[4], f'sway modifiers do not change fired direction: {result}'
        assert abs(result[1][0]) < abs(result[2][0]) and abs(result[3][0]) > abs(result[4][0]), result
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
