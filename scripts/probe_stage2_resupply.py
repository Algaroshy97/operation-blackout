#!/usr/bin/env python3
"""Resupply uses the deployed weapon's effective ammunition capacity."""
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
        page.evaluate("STATS.xp = CORE.xpForRank(CORE.MAX_RANK); setAttachment(0, 'mag', 'extmag')")
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        actual, expected = page.evaluate('''() => {
          curS().reserve = 0;
          const expected = CORE.waveResupplyAmmo(0, curW().reserveMax, curW().mag, CORE.RESUPPLY_MAG_RATIO);
          resupply(); return [curS().reserve, expected];
        }''')
        assert actual == expected, f'resupply gave {actual}, effective weapon requires {expected}'
        wall = page.evaluate('''() => {
          credits = 100000; curS().reserve = CFG.weapons[0].reserveMax;
          const st = {kind:'wall', weapon:0};
          const offer = stationOffer(st); const canBuy = offer.ok;
          const bought = purchase(st);
          return {canBuy, bought, reserve:curS().reserve, maximum:curW().reserveMax};
        }''')
        assert wall['canBuy'] and wall['bought'] and wall['reserve'] == wall['maximum'], wall
        box = page.evaluate('''() => {
          waveNum = 10; credits = 100000;
          const upgraded = purchase({kind:'armory'});
          curS().reserve = curS().up.reserveMax;
          const start = curS().reserve;
          const mesh = new THREE.Object3D(); mesh.position.copy(player.pos);
          munitions.push({m:mesh,t:10,tick:0}); updateMunitions(0.1);
          return {upgraded, start, reserve:curS().reserve, maximum:curW().reserveMax};
        }''')
        assert box['upgraded'] and box['reserve'] > box['start'] and box['reserve'] <= box['maximum'], box
        page.evaluate('saveCheckpoint(captureRunState()); saveStats()')
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate('resumeRun()')
        assert page.evaluate("started && curS().up && curW().attachments.includes('extmag') && curW().mag > curS().up.mag")
        page.evaluate('resetGame()')
        assert page.evaluate("curW().attachments.includes('extmag') && !curS().up"), 'reset lost build or retained upgrade'
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.click('#btn-start')
        page.click('#mode-btn-tdm')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        assert page.evaluate("() => { killPlayer(); updateModeRespawns(4, openSpawnPoints(), enemies, colliders); return !player.dead && curW().attachments.includes('extmag') && curS().ammo === curW().mag; }")
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
