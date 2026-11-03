#!/usr/bin/env python3
"""Gunsmith must expose every carried firearm including the sidearm."""
from pathlib import Path
from playwright.sync_api import sync_playwright

BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate("recordRun({kills:100, headshots:0, wave:1, accuracy:0, score:0, streaks:0})")
        page.click('#btn-gunsmith')
        assert page.locator('#gs-weapons button').count() == page.evaluate('CFG.weapons.length'), 'sidearm missing from Gunsmith'
        dot = page.get_by_role('button', name='RED DOT', exact=False)
        assert '→' in dot.inner_text(), 'attachment lacks before/after comparison'
        dot.click()
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-gunsmith')
        assert page.evaluate("getLoadout(0).optic === 'reddot'")
        page.locator('#gs-weapons button').last.click()
        assert page.get_by_text('LIGHT STOCK', exact=False).count() == 0, 'pistol offered rifle stocks'
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("curW().adsSpeed > 1 && curW().adsSpread < CFG.weapons[0].adsSpread && curW().spread > CFG.weapons[0].spread")
        assert page.evaluate("""() => {
          setAttachment(0, 'optic', null); refreshWeaponStats(0);
          return CFG.weapons.every((base, i) => {
            weaponsOwned[0] = i; initWeapons();
            const w = curW();
            return CORE.weaponAdsSpeed(w.type, w.adsSpeed) === CORE.weaponAdsSpeed(base.type, base.adsSpeed) &&
                   CORE.weaponAdsMoveMultiplier(w.type, w.moveMul) === CORE.weaponAdsMoveMultiplier(base.type, base.moveMul);
          });
        }"""), 'empty loadout changes baseline aim speed or movement'
        page.evaluate("STATS.xp = CORE.xpForRank(12); saveStats();")
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-gunsmith')
        page.get_by_role('button', name='LONG BARREL', exact=False).click()
        suppressor = page.get_by_role('button', name='SUPPRESSOR', exact=False).inner_text()
        assert 'penetration' in suppressor and 'adsSpeed' in suppressor, 'comparison hides removed attachment effects'
        page.get_by_role('button', name='SUPPRESSOR', exact=False).click()
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate('''() => {
          const original = playSound, heard = [];
          try { playSound = function (key) { heard.push(key); }; fireShot(); }
          finally { playSound = original; }
          return heard.includes(CORE.weaponClassFireSound(curW().cls, curW().type, true));
        }'''), 'suppressed shot did not use suppressed sound'
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
