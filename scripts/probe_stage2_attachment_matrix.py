#!/usr/bin/env python3
"""Exercise every offered attachment against real deployed weapon states."""
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
        page.evaluate('STATS.xp = CORE.xpForRank(CORE.MAX_RANK); saveStats()')
        page.click('#btn-start')
        page.locator('#gun-cards .gun-card').first.click()
        page.locator('#gun-cards .gun-card').first.click()
        failures = page.evaluate('''() => {
          const failures = [];
          for (let i = 0; i < CFG.weapons.length; i++) {
            for (const a of CORE.ATTACHMENTS) {
              if (!compatibleAttachment(i, a)) continue;
              LOADOUTS[i] = {}; weaponsOwned[0] = i; curWeapon = 0; initWeapons();
              gunsmithWeapon = i; buildGunsmith();
              const options = Array.from(document.querySelectorAll('.gs-opt'));
              const button = options.find(b => b.textContent.startsWith(a.name));
              if (!button || button.disabled || !button.textContent.includes('→')) { failures.push([i,a.key,'UI']); continue; }
              const before = CORE.applyAttachments(CFG.weapons[i], {});
              const after = CORE.applyAttachments(CFG.weapons[i], {[a.slot]: a.key});
              for (const field in a.mods) {
                if (field === 'sway' || field === 'adsSpread' || (field === 'spread' && before.pellets > 1)) continue;
                const pair = field + ' ' + Number(before[field].toFixed(4)) + ' → ' + Number(after[field].toFixed(4));
                if (!button.textContent.includes(pair)) failures.push([i,a.key,'comparison',pair]);
              }
              if (a.mods.adsSpread || a.mods.sway || (a.mods.spread && before.pellets > 1)) {
                const isPellet = before.pellets > 1;
                const a0 = before.adsSpread * before.sway, a1 = after.adsSpread * after.sway;
                const b = isPellet ? CORE.pelletConeSpread(before.pelletSpread, a0, true) : a0;
                const n = isPellet ? CORE.pelletConeSpread(after.pelletSpread, a1, true) : a1;
                const label = isPellet ? 'pellet cone ADS (stationary first shot)' : 'aimed spread (stationary first shot)';
                const pair = label + ' ' + Number(b.toFixed(4)) + ' → ' + Number(n.toFixed(4));
                if (!button.textContent.includes(pair)) failures.push([i,a.key,'aimed comparison',pair]);
              }
              button.click(); refreshWeaponStats(0);
              const w = curW(), base = CORE.applyAttachments(CFG.weapons[i], {});
              if (getLoadout(i)[a.slot] !== a.key) failures.push([i,a.key,'save']);
              for (const field in a.mods) {
                let expected = base[field] * a.mods[field];
                if (field === 'mag' || field === 'reserveMax') expected = Math.round(expected);
                if (typeof expected !== 'number' || Math.abs(w[field] - expected) > 1e-8) failures.push([i,a.key,field,w[field],expected]);
              }
              const ammo = curS().ammo; fireShot();
              if (curS().ammo !== ammo - 1) failures.push([i,a.key,'fire']);
            }
          }
          return failures;
        }''')
        assert not failures, failures
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    main()
