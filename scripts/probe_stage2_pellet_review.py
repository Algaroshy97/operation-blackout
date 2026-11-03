#!/usr/bin/env python3
"""Shotgun Gunsmith comparison matches real stationary first-shot pellet cones."""
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
        page.locator('#gs-weapons button').nth(4).click()
        dot = page.get_by_role('button', name='RED DOT', exact=False)
        text = dot.inner_text()
        assert 'pellet cone ADS (stationary first shot)' in text, text
        dot.click()
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').nth(4).click()
        page.locator('#gun-cards .gun-card').first.click()
        values = page.evaluate('''() => {
          const old = traceRound, cones = [];
          try {
            traceRound = function(w, cone, magnetize) { cones.push(cone); return old(w, cone, magnetize); };
            player.onGround = true; player.crouching = false; player.sliding = false; player.sprinting = false;
            hSpeedForSpread = 0; keys.Mouse2 = true;
            for (const key of [null, 'reddot']) {
              setAttachment(4, 'optic', key); refreshWeaponStats(0); bloom = 0; fireShot();
            }
          } finally { traceRound = old; }
          return [cones[0], cones[CFG.weapons[4].pellets]];
        }''')
        expected_pair = f'{values[0]:.4f}'.rstrip('0').rstrip('.') + ' → ' + f'{values[1]:.4f}'.rstrip('0').rstrip('.')
        assert expected_pair in text, (text, values, expected_pair)
        percent = page.evaluate('([b,n]) => Math.round(Math.abs((n-b)/b)*1000)/10', values)
        assert f'(+{percent:g}%)' in text, (text, values, percent)
        assert values[1] < values[0], values
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-gunsmith')
        page.locator('#gs-weapons button').nth(4).click()
        stock = page.get_by_role('button', name='HEAVY STOCK', exact=False)
        stock_text = stock.inner_text()
        stock.click()
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').nth(4).click()
        page.locator('#gun-cards .gun-card').first.click()
        values = page.evaluate('''() => {
          const old = traceRound, cones = [];
          try {
            traceRound = function(w, cone, magnetize) { cones.push(cone); return old(w, cone, magnetize); };
            player.onGround = true; player.crouching = false; player.sliding = false; player.sprinting = false;
            hSpeedForSpread = 0; keys.Mouse2 = true;
            for (const key of [null, 'heavystock']) {
              setAttachment(4, 'stock', key); refreshWeaponStats(0); bloom = 0; fireShot();
            }
          } finally { traceRound = old; }
          return [cones[0], cones[CFG.weapons[4].pellets]];
        }''')
        pair = f'{values[0]:.4f}'.rstrip('0').rstrip('.') + ' → ' + f'{values[1]:.4f}'.rstrip('0').rstrip('.')
        assert pair in stock_text and values[1] < values[0], (stock_text, values)
        percent = page.evaluate('([b,n]) => Math.round(Math.abs((n-b)/b)*1000)/10', values)
        assert f'(+{percent:g}%)' in stock_text, (stock_text, values, percent)
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
