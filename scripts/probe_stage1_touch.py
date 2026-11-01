#!/usr/bin/env python3
"""Exercise Gun Game touch handlers through the built game in Chromium.

Synthetic TouchEvents verify the production lifecycle, not physical phone input.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

BUILD = Path(__file__).resolve().parents[1] / 'dist' / 'Operation Blackout.html'


def main(build=BUILD):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 720}, has_touch=True, is_mobile=True)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto(build.resolve().as_uri(), wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        page.evaluate("setSetting('muted', true)")
        page.click('#btn-start')
        page.locator('#diff-row .diff-btn').first.click()
        page.reload(wait_until='load', timeout=120000)
        page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=120000)
        assert page.evaluate("runDifficulty === 'very-easy'")
        page.click('#btn-start')
        for mode in ('survival', 'tdm', 'ffa', 'domination', 'gun-game'):
            page.click(f'#mode-btn-{mode}')
            assert page.locator('#diff-row').is_visible(), mode
            assert page.locator('#diff-row .diff-btn').count() == 4, mode
        page.click('#mode-btn-gun-game')
        page.evaluate('pickGun(0); pickGun(1)')
        result = page.evaluate('''() => {
          const button = document.getElementById('tbtn-fire'), result = [];
          function event(type, id) {
            const touch = new Touch({identifier:id,target:button,clientX:1100,clientY:600});
            button.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,
              changedTouches:[touch],touches:type === 'touchstart' ? [touch] : [],
              targetTouches:type === 'touchstart' ? [touch] : []}));
          }
          for (let i = 0; i < 2; i++) {
            killPlayer();
            const locked = player.dead && getComputedStyle(button).pointerEvents === 'none';
            updateModeRespawns(4, openSpawnPoints(), enemies, colliders);
            const unlocked = !player.dead && getComputedStyle(button).pointerEvents !== 'none';
            curS().nextShot = 0; gunSwitchT = 1; fireClockT += 1;
            const before = curS().ammo;
            event('touchstart', i + 1); applyTouchInput(); updateWeapons(0.016); event('touchend', i + 1);
            result.push({locked, unlocked, fired:curS().ammo < before});
          }
          event('touchstart', 11); event('touchcancel', 11); applyTouchInput();
          result.push({cancelled:!mouse1Down});
          MODES['gun-game'].setTier(player, 1);
          const promoted = weaponsOwned[0] === CORE.gunGameTierWeapon(1);
          curS().ammo = 1; curS().reserve = 30;
          const reload = document.getElementById('tbtn-reload');
          const reloadFinger = new Touch({identifier:13,target:reload,clientX:1000,clientY:600});
          reload.dispatchEvent(new TouchEvent('touchstart', {bubbles:true,cancelable:true,
            changedTouches:[reloadFinger],touches:[reloadFinger],targetTouches:[reloadFinger]}));
          updateWeapons(0.016); delete pressed.KeyR; updateWeapons(20);
          result.push({promoted, reloaded:curS().ammo > 1});
          reload.dispatchEvent(new TouchEvent('touchend', {bubbles:true,cancelable:true,
            changedTouches:[reloadFinger],touches:[],targetTouches:[]}));
          event('touchstart', 14); window.dispatchEvent(new Event('blur')); applyTouchInput();
          result.push({blurClears:!mouse1Down});
          event('touchstart', 15); pauseGame(); applyTouchInput();
          result.push({pauseClears:!mouse1Down});
          paused = false;
          MODES['gun-game'].setTier(player, 19);
          killPlayer(); updateModeRespawns(4, openSpawnPoints(), enemies, colliders);
          result.push({knifeRespawn:!player.dead && MODES['gun-game'].tierOf(player) === 19});
          meleeT = 0;
          const knife = document.getElementById('tbtn-melee');
          applyTouchInput();
          result.push({knifePointer:getComputedStyle(knife).pointerEvents !== 'none'});
          const finger = new Touch({identifier:12,target:knife,clientX:1000,clientY:600});
          knife.dispatchEvent(new TouchEvent('touchstart', {bubbles:true,cancelable:true,
            changedTouches:[finger],touches:[finger],targetTouches:[finger]}));
          updateWeapons(0.016);
          result.push({knife:meleeT > 0});
          knife.dispatchEvent(new TouchEvent('touchend', {bubbles:true,cancelable:true,
            changedTouches:[finger],touches:[],targetTouches:[]}));
          return result;
        }''')
        print('touch lifecycle:', result)
        print('browser errors:', errors)
        assert all(all(item.values()) for item in result), result
        assert not errors, errors
        context.close()
        browser.close()


if __name__ == '__main__':
    main()
