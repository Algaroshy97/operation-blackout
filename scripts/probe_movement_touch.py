from pathlib import Path
from playwright.sync_api import sync_playwright

build = Path(__file__).resolve().parents[1] / 'dist/Operation Blackout.html'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(build.as_uri(), wait_until='domcontentloaded')
    page.wait_for_function('assetsReady === true', timeout=60000)
    page.click('#btn-start')
    page.click('#gun-select .gun-card:not(.locked)')
    page.click('#gun-select .gun-card:not(.locked)')
    page.wait_for_function('started && MUSIC.running', timeout=60000)
    page.evaluate('''() => {
      window.samples = []; window.audioBlocks = []; window.gainEvents = []; window.cues=[]; const originalPlaySound=playSound; playSound=function(name,...args){cues.push({name,time:MUSIC.ctx.currentTime}); return originalPlaySound(name,...args)}; const param=MUSIC.duck.gain; const target=param.setTargetAtTime.bind(param); param.setTargetAtTime=function(value,time,constant){gainEvents.push({value,time,constant}); return target(value,time,constant)};
      const tap = MUSIC.ctx.createScriptProcessor(1024, 1, 1), sink = MUSIC.ctx.createGain(); sink.gain.value = 0;
      MUSIC.comp.connect(tap); tap.connect(sink); sink.connect(MUSIC.ctx.destination);
      tap.onaudioprocess = e => { let sum = 0; const a=e.inputBuffer.getChannelData(0); for (const v of a) sum += v*v; audioBlocks.push({t:e.playbackTime,rms:Math.sqrt(sum/a.length)}); };
      window.sampler = setInterval(() => samples.push({time:MUSIC.ctx.currentTime, duck:MUSIC.duck.gain.value, x:player.pos.x, z:player.pos.z, speed:Math.hypot(player.vel.x,player.vel.z), step:MUSIC.step, running:MUSIC.running}), 50);
      window.joy = (kind) => { const el=document.querySelector('#joy-base'), r=el.getBoundingClientRect(); const t=new Touch({identifier:37,target:el,clientX:r.left+r.width/2,clientY:r.top+r.height/2+(kind==='back' ? 45 : -45)}); const type=kind==='back'?'touchstart':kind; (type==='touchstart'?el:window).dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,changedTouches:[t],touches:type==='touchend'?[]:[t],targetTouches:type==='touchend'?[]:[t]})); };
    }''')
    for phase, action, ms in [('stationary',None,3500),('moving','touchstart',5000),('stopped','touchend',3500),('moving-again','back',3500),('stopped-again','touchend',2000)]:
        if action: page.evaluate('(action) => joy(action)',action)
        page.evaluate('samples.length=0; audioBlocks.length=0; gainEvents.length=0; cues.length=0')
        page.wait_for_timeout(ms)
        result = page.evaluate('''() => ({samples, audio: audioBlocks, gainEvents, cues, movement:{x:touchState.moveX,z:touchState.moveZ}, dead:player.dead, paused:paused})''')
        audio = result.pop('audio')
        result.update(audioBlocks=len(audio), silentBlocks=sum(x['rms'] < 0.0001 for x in audio), maxRms=max((x['rms'] for x in audio), default=0))
        samples = result.pop('samples')
        if samples:
            result.update(count=len(samples), minDuck=min(s['duck'] for s in samples), maxDuck=max(s['duck'] for s in samples), below02=sum(s['duck']<0.2 for s in samples), positionFirst=[samples[0]['x'],samples[0]['z']], positionLast=[samples[-1]['x'],samples[-1]['z']], maxSpeed=max(s['speed'] for s in samples), stepFirst=samples[0]['step'], stepLast=samples[-1]['step'])
        print(phase, result, flush=True)
        assert not result['dead'] and not result['paused'] and result['audioBlocks'] > 10 and result['maxRms'] > 0, (phase, result)
        assert samples and samples[-1]['step'] > samples[0]['step'], (phase, result)
        if phase in ('moving', 'moving-again'):
            assert abs(samples[-1]['z'] - samples[0]['z']) > 1, (phase, result)
            assert any(c['name'].startswith('step') for c in result['cues']), (phase, result)
        if phase in ('stopped', 'stopped-again'):
            assert result['movement']['z'] == 0, (phase, result)
    print('pageerrors', errors, flush=True)
    assert not errors, errors
    browser.close()
