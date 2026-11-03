"""Production deploy/weather lifecycle against the standalone game."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(Path(build).resolve().as_uri(), wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady', timeout=60000)
        page.click('#btn-start')
        assert page.locator('#weather-select').count() == 1, 'deployment must offer weather selection'
        assert page.evaluate("""() => {
          const r = document.getElementById('weather-select').getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.width >= 44 && r.height >= 30;
        }"""), 'weather selector must fit the mobile viewport'
        for map_id, weather in [('urban', 'clear'), ('urban', 'dusk'), ('urban', 'night'), ('urban', 'rain'), ('snowy', 'blizzard')]:
            page.click('#map-btn-' + map_id)
            page.select_option('#weather-select', weather)
            assert page.input_value('#weather-select') == weather
        page.select_option('#weather-select', 'blizzard')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        assert page.evaluate('activeWeather') == 'blizzard'
        assert page.evaluate('scene.fog.far < 150'), 'blizzard must change the live environment'
        fog = page.evaluate("""() => { const before = scene.fog.color.getHex(); applyPostFog(); return [before, scene.fog.color.getHex()]; }""")
        assert fog[0] == fog[1], ('post-processing reset lost weather fog', fog)
        assert page.evaluate("captureRunState().weather") == 'blizzard', 'checkpoint must preserve the fixed weather'
        assert page.evaluate("""() => {
          const state = captureRunState(); state.wave = 1;
          return saveCheckpoint(state) && loadCheckpoint().weather === 'blizzard';
        }"""), 'weather must survive checkpoint validation'
        weather_counts = page.evaluate("""() => {
          const old = pfxEmit; let count = 0;
          pfxEmit = (...args) => { count++; return old(...args); };
          try {
            activeWeather = 'clear'; _snowAcc = 0; updateWeatherParticles(1); const clear = count;
            activeWeather = 'blizzard'; _snowAcc = 0; updateWeatherParticles(1); const snow = count - clear;
            activeWeather = 'rain'; _snowAcc = 0; updateWeatherParticles(1); const rain = count - clear - snow;
            activeWeather = 'blizzard'; return {clear, snow, rain};
          } finally { pfxEmit = old; }
        }""")
        assert weather_counts['clear'] == 0, weather_counts
        assert weather_counts['snow'] > 0 and weather_counts['rain'] > 0, weather_counts
        graphics_calls = page.evaluate("""() => {
          graphicsNow(); const original = CORE.graphicsSettings; let calls = 0;
          CORE.graphicsSettings = (...args) => { calls++; return original(...args); };
          try { for (let i=0; i<10; i++) updateWeatherParticles(0.016); return calls; }
          finally { CORE.graphicsSettings = original; }
        }""")
        assert graphics_calls == 0, ('weather must reuse the cached graphics plan', graphics_calls)
        lights = page.evaluate("""() => {
          activeWeather = 'night'; setSetting('quality', 'low'); setSetting('effects', 'reduced'); applyMatchWeather();
          updateFlashLights(0.016);
          const before = typeof nightLight === 'undefined' ? 0 : nightLight.intensity;
          fxMuzzle(camera.position, camera.getWorldDirection(new THREE.Vector3()), 'AR', false);
          const flashed = typeof nightLight !== 'undefined' && nightLight.userData.life > 0;
          const flashIntensity = nightLight.intensity;
          setSetting('reducedMotion', true);
          fxMuzzle(camera.position, camera.getWorldDirection(new THREE.Vector3()), 'AR', false);
          const restrained = nightLight.intensity < flashIntensity;
          activeWeather = 'blizzard'; applyMatchWeather();
          return {before, flashed, restrained};
        }""")
        assert lights['before'] > 0 and lights['flashed'], lights
        assert lights['restrained'], 'reduced motion must restrain muzzle flashes'
        visibility = page.evaluate("""() => {
          activeWeather = 'night'; applyMatchWeather();
          const oldPos = camera.position.clone(), oldQuat = camera.quaternion.clone();
          camera.position.set(0, 1.7, 0);
          const enemy = spawnEnemy(1, 0, -4); camera.lookAt(0, 1.2, -4);
          camera.updateMatrixWorld(true); scene.updateMatrixWorld(true); updateFlashLights(0.016);
          const target = enemy.hitBody.getWorldPosition(new THREE.Vector3());
          const projected = target.clone().project(camera);
          const ray = new THREE.Raycaster(camera.position, target.clone().sub(camera.position).normalize());
          const hits = ray.intersectObject(enemy.hitBody, false).length;
          const blocked = CORE.segmentBlocked(camera.position.x, camera.position.y, camera.position.z, target.x, target.y, target.z, colliders, 0.1);
          const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          function pixels() { renderer.render(scene, camera); const data = new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data); return data; }
          const visible = pixels(); enemy.parts.group.visible = false; const hidden = pixels();
          let changed = 0; for (let i=0; i<visible.length; i+=4) if (Math.abs(visible[i]-hidden[i])+Math.abs(visible[i+1]-hidden[i+1])+Math.abs(visible[i+2]-hidden[i+2]) >= 12) changed++;
          const lightDistance = nightLight.position.distanceTo(target);
          scene.remove(enemy.parts.group); disposeEnemyGeometry(enemy); enemies.splice(enemies.indexOf(enemy),1);
          camera.position.copy(oldPos); camera.quaternion.copy(oldQuat);
          activeWeather = 'blizzard'; applyMatchWeather();
          return {projected: [projected.x, projected.y, projected.z], hits, blocked, changed, lightDistance, lightRange: nightLight.distance};
        }""")
        print('night target geometry and rendered difference:', visibility)
        # Engineering tripwire, not a human contrast/readability assessment.
        assert visibility['hits'] > 0 and not visibility['blocked'], visibility
        assert all(abs(n) <= 1 for n in visibility['projected']) and visibility['lightDistance'] < visibility['lightRange'], visibility
        assert visibility['changed'] >= 12, visibility
        blackout = page.evaluate("""() => {
          activeWeather = 'night'; applyMatchWeather(); updateFlashLights(0.016);
          const normal = nightLight.intensity;
          const show = showCenterMsg;
          showCenterMsg = function (text) { if (text === 'BLACKOUT') window.blackoutAnnounced = true; return show(text); };
          startWave(10); const initial = nightLight.intensity;
          updateFlashLights(0.016); const updated = nightLight.intensity;
          return {normal, initial, updated, special: waveSpecial && waveSpecial.key};
        }""")
        print('blackout transition:', blackout)
        assert blackout['special'] == 'blackout' and blackout['initial'] < blackout['normal'] * 0.11, blackout
        assert blackout['updated'] < blackout['normal'] * 0.11, blackout
        page.wait_for_function('() => window.blackoutAnnounced === true', timeout=30000)
        restored = page.evaluate("""() => { startWave(11); updateFlashLights(0.016); return nightLight.intensity; }""")
        assert abs(restored - blackout['normal']) < 0.001, (blackout, restored)
        page.wait_for_timeout(1000)
        page.evaluate("activeWeather = 'blizzard'; applyMatchWeather()")
        metrics = page.evaluate("""async () => {
          const times = []; let last = performance.now();
          for (let i = 0; i < 24; i++) {
            await new Promise(requestAnimationFrame);
            const now = performance.now(); if (i > 3) times.push(now - last); last = now;
          }
          times.sort((a,b) => a-b);
          const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
          return {renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                  frames: times.length, medianMs: times[Math.floor(times.length/2)], p95Ms: times[Math.ceil(times.length*0.95)-1],
                  calls: renderer.info.render.calls, triangles: renderer.info.render.triangles};
        }""")
        print('mobile-emulated low weather frame sample:', metrics)
        page.evaluate("setSetting('weather', 'night')")
        assert page.evaluate('activeWeather') == 'blizzard', 'weather changed during match'
        page.evaluate("activeWeather = 'night'; applyMatchWeather(); pauseGame()")
        page.click('#btn-quit')
        assert page.evaluate('!nightLight || nightLight.intensity === 0'), 'quit must retire night lighting'
        assert page.evaluate('!nightLight || nightLight.parent !== scene'), 'inactive night light must not consume a scene light slot'
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady', timeout=60000)
        page.click('#btn-resume-run')
        assert page.evaluate('activeMapId') == 'snowy'
        assert page.evaluate('activeWeather') == 'blizzard', 'resume must restore the same weather'
        assert page.evaluate('scene.fog.far') == 80
        page.evaluate('pauseGame()')
        page.click('#btn-quit')
        page.click('#btn-start')
        assert page.locator('#weather-select option[value="rain"]').evaluate('(option) => option.disabled')
        page.select_option('#weather-select', 'random')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        chosen = page.evaluate('activeWeather')
        assert chosen in ('clear', 'dusk', 'night', 'blizzard'), chosen
        page.wait_for_timeout(500)
        assert page.evaluate('activeWeather') == chosen, 'random weather must remain fixed'
        reset_sun = page.evaluate("""() => {
          applySpecialLighting({dark: true}); setSetting('weather', 'dusk'); startGame();
          return {weather: activeWeather, actual: sun.intensity, expected: 1.35 * LIGHT_COMPAT * 0.72};
        }""")
        assert reset_sun['weather'] == 'dusk' and abs(reset_sun['actual'] - reset_sun['expected']) < 0.001, reset_sun
        page.evaluate("setSetting('weather', 'night'); killPlayer()")
        assert page.evaluate('activeWeather') == 'dusk', 'death must not change current weather'
        page.wait_for_selector('#death-screen', state='visible', timeout=30000)
        page.click('#btn-restart')
        page.click('#gun-select .gun-card:not(.locked)'); page.click('#gun-select .gun-card:not(.locked)')
        assert page.evaluate("activeWeather === 'night' && started && !gameEnded"), 'survival redeploy must choose the next weather'
        assert not errors, errors
        browser.close()
    print('stage3 weather deployment lifecycle: passed')


if __name__ == '__main__':
    main()
