#!/usr/bin/env python3
"""Career cosmetics through earned challenge, saved selection and deployment."""
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
        page.click('#btn-gunsmith')
        assert page.locator('#camo-choice').count() == 1, 'career camo selector missing'
        assert 'OPERATOR SLEEVES' in page.locator('#gs-slots').inner_text()
        assert page.locator('#camo-choice option').count() >= 3 and page.locator('#kit-choice option').count() >= 3, 'multiple challenge cosmetics missing'
        assert page.evaluate("document.querySelector('#camo-choice option[value=woodland]').disabled"), page.evaluate('getStats()')
        assert page.evaluate("document.querySelector('#kit-choice option[value=olive]').disabled")
        page.click('#btn-gunsmith-back')
        page.evaluate("recordRun({kills:100, headshots:100, wave:1, accuracy:0, score:0, streaks:0})")
        page.click('#btn-gunsmith')
        page.select_option('#camo-choice', 'woodland')
        page.select_option('#kit-choice', 'olive')
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-gunsmith')
        assert page.locator('#camo-choice').input_value() == 'woodland'
        assert page.locator('#kit-choice').input_value() == 'olive'
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("gunGroup && gunGroup.userData.camo === 'woodland' && VMAT.sleeve.color.getHex() === 0x73815a")
        assert page.evaluate("() => { let visible = false; gunGroup.traverse(o => { if (o.isMesh && o.visible && o.material === VMAT.sleeve) visible = true; }); return visible && gunGroup.parent === gunCamera; }")
        assert page.evaluate("() => { let found = false; gunGroup.traverse(o => { if (o.material && o.material.userData.careerCamo) found = !!o.material.map; }); return found; }")
        assert page.evaluate('''() => {
          const material = gunGroup.userData.camoMaterial, texture = material.map;
          let disposedMaterial = 0, disposedTexture = 0;
          material.addEventListener('dispose', () => disposedMaterial++);
          texture.addEventListener('dispose', () => disposedTexture++);
          curWeapon = 3; buildViewmodel();
          const independent = gunGroup.userData.camo === 'default' && VMAT.sleeve.color.getHex() === 0x73815a;
          curWeapon = 0; buildViewmodel();
          return independent && gunGroup.userData.camo === 'woodland' && disposedMaterial === 1 && disposedTexture === 1;
        }'''), 'per-weapon camo or texture disposal failed'
        page.evaluate("recordRun({kills:0, headshots:0, wave:15, accuracy:0, score:0, streaks:0})")
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-gunsmith')
        page.select_option('#camo-choice', 'urban')
        page.select_option('#kit-choice', 'sand')
        page.click('#btn-gunsmith-back')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("gunGroup.userData.camo === 'urban' && VMAT.sleeve.color.getHex() === 0xc6a979 && !!gunGroup.userData.camoMaterial.map")
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
