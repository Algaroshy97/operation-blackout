#!/usr/bin/env python3
"""Migrate an actual pre-Stage-2 Gunsmith save into the current game."""
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'dist' / 'Operation Blackout.html'
BASE = 'be626b45a7157859d69f97a3f6601449dd42b910'


def main(build=BUILD):
    fixture = tempfile.TemporaryDirectory()
    legacy = Path(fixture.name) / 'base.html'
    with legacy.open('wb') as output:
        subprocess.run(['git', 'show', BASE + ':dist/Operation Blackout.html'], cwd=ROOT, stdout=output, check=True)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width':1280,'height':720})
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(legacy.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate("recordRun({kills:10000,headshots:0,wave:1,accuracy:0,score:0,streaks:0})")
        page.click('#btn-gunsmith')
        page.locator('#gs-weapons button').nth(4).click()
        for name in ('4x SCOPE', 'SUPPRESSOR', 'FOREGRIP', 'EXTENDED MAG'):
            page.get_by_role('button', name=name, exact=False).click()
        saved = page.evaluate("() => ({loadouts:localStorage.getItem('ob_loadouts_v1'),stats:localStorage.getItem('blackout.stats.v1')})")
        assert saved['loadouts'] and saved['stats'], saved
        context.close()
        context = browser.new_context(viewport={'width':1280,'height':720})
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.evaluate('''s => {localStorage.setItem('ob_loadouts_v1', s.loadouts); localStorage.setItem('blackout.stats.v1', s.stats);}''', saved)
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        assert page.evaluate("JSON.stringify(getLoadout(4))") == '{"optic":"scope4x","barrel":"suppressor","under":"foregrip","mag":"extmag"}'
        page.click('#btn-gunsmith')
        page.locator('#gs-weapons button').nth(4).click()
        for name in ('PRECISION OPTIC', 'SUPPRESSOR', 'FOREGRIP', 'EXTENDED MAG'):
            option = page.get_by_role('button', name=name, exact=False)
            assert 'on' in option.get_attribute('class').split() and 'LEGACY' in option.inner_text(), name
            assert option.is_disabled(), name
        page.get_by_role('button', name='LIGHT STOCK', exact=False).click()
        assert page.evaluate("getLoadout(4).mag === 'extmag' && getLoadout(4).barrel === 'suppressor' && getLoadout(4).under === 'foregrip'")
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').nth(4).click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("curW().mag === 8 && curW().recoilH < CFG.weapons[4].recoilH && curW().range < CFG.weapons[4].range && curW().attachments.length === 5")
        assert page.evaluate("() => { let n=curS().ammo; fireShot(); return curS().ammo === n-1; }")
        assert page.evaluate("() => { setAttachment(4, 'mag', null); setAttachment(4, 'mag', 'extmag'); return !getLoadout(4).mag && getLoadout(4).under === 'foregrip'; }")
        assert not errors, errors
        browser.close()
    fixture.cleanup()


if __name__ == '__main__':
    main()
