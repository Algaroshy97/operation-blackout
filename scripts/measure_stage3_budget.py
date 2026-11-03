"""Matched idle-frame engineering guard, not hardware playability acceptance."""
import json
import math
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = '477876ccee300d17476d7b69921d19d3d95b3fcf'



def check_budget(base, actual):
    # The retained 35-frame SwiftShader sample showed a night p95 ratio of 1.35.
    # Allow 1.7 p95 / 1.5 median for noisy software CI while rejecting large
    # regressions; these are engineering tripwires, not frame-rate targets.
    for key in ('renderer', 'enemies', 'quality', 'effects', 'map', 'pixelRatio'):
        assert base[key] == actual[key], (key, base[key], actual[key])
    assert base['enemies'] == 0, 'idle comparison must not include changing enemy workloads'
    assert base['frames'] >= 35 and actual['frames'] >= 35
    for key, limit in (('medianMs', 1.5), ('p95Ms', 1.7)):
        assert math.isfinite(base[key]) and math.isfinite(actual[key]) and base[key] > 0
        assert actual[key] <= base[key] * limit, (key, base[key], actual[key], limit)


def main(build=ROOT / 'dist/Operation Blackout.html'):
    baseline = subprocess.check_output(['git', 'show', BASE + ':dist/Operation Blackout.html'], cwd=ROOT)
    candidate = Path(build).read_bytes()
    cases = [('base-urban', baseline, 'urban', None),
             ('night-urban', candidate, 'urban', 'night'),
             ('base-snowy', baseline, 'snowy', None),
             ('blizzard-snowy', candidate, 'snowy', 'blizzard')]
    output = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for name, content, map_id, weather in cases:
            context = browser.new_context(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True, device_scale_factor=1)
            page = context.new_page(); errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.route('https://blackout.test/**', lambda route: route.fulfill(status=200, content_type='text/html', body=content))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('() => assetsReady', timeout=60000)
            page.evaluate("setSetting('quality','low'); setSetting('effects','reduced'); setSetting('postProcessing','off')")
            page.click('#btn-start'); page.click('#map-btn-' + map_id)
            if weather:
                page.select_option('#weather-select', weather)
            page.click('#gun-select .gun-card:not(.locked)'); page.click('#gun-select .gun-card:not(.locked)')
            page.evaluate('() => { waveActive = false; betweenWaveT = 100000; }')
            metrics = page.evaluate("""async () => {
              let t = performance.now(), times=[];
              for (let i=0; i<80; i++) { await new Promise(requestAnimationFrame); const n=performance.now(); if(i>=20) times.push(n-t); t=n; }
              times.sort((a,b)=>a-b); const gl=renderer.getContext(), ext=gl.getExtension('WEBGL_debug_renderer_info');
              return {frames:times.length, medianMs:times[Math.floor(times.length/2)], p95Ms:times[Math.ceil(times.length*.95)-1],
                meanMs:times.reduce((a,b)=>a+b,0)/times.length, calls:renderer.info.render.calls, triangles:renderer.info.render.triangles,
                renderer:ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), enemies:enemies.length,
                quality:getSetting('quality'), effects:getSetting('effects'), map:activeMapId, pixelRatio:renderer.getPixelRatio()};
            }""")
            metrics['pageErrors'] = errors
            if weather:
                assert not errors, errors
            output[name] = metrics
            print(name, json.dumps(metrics), flush=True)
            context.close()
        browser.close()
    check_budget(output['base-urban'], output['night-urban'])
    check_budget(output['base-snowy'], output['blizzard-snowy'])
    print('matched idle-frame engineering guard passed; not hardware acceptance', flush=True)
    return output


if __name__ == '__main__':
    main()
