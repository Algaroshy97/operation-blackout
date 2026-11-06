"""Collect real touch, score-path and production scheduler evidence in Chromium."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from movement_music_evidence import validate_continuity, validate_scheduler

ROOT = Path(__file__).resolve().parents[1]


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
            # Fulfil a secure-origin navigation from the local artifact in-process.
            # Chromium's file: origin cannot reliably load blob AudioWorklets.
            page.route('https://blackout.test/', lambda route: route.fulfill(status=200, content_type='text/html', body=Path(build).read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            page.click('#btn-start')
            page.click('#gun-select .gun-card:not(.locked)')
            page.click('#gun-select .gun-card:not(.locked)')
            page.wait_for_function('started && MUSIC.running', timeout=60000)
            page.evaluate('''async () => {
              window.trace = {audio: [], frames: [], scheduled: [], cues: []};
              const c = MUSIC.ctx, merge = c.createChannelMerger(3);
              const code = `class ScoreCapture extends AudioWorkletProcessor {
                constructor() { super(); this.n=0; this.s=[0,0,0]; this.start=0; }
                process(inputs) {
                  const a=inputs[0];
                  if (!a || a.length < 3) return true;
                  for (let i=0;i<a[0].length;i++) {
                    if (!this.n) this.start=(currentFrame+i)/sampleRate;
                    this.s[0]+=a[0][i]*a[0][i]; this.s[1]+=a[1][i]*a[1][i];
                    this.s[2]+=a[2][i]*a[2][i];
                    if (++this.n === 1024) {
                      this.port.postMessage({t:this.start,reference:Math.sqrt(this.s[0]/this.n),output:Math.sqrt(this.s[1]/this.n),expected:Math.sqrt(this.s[2]/this.n)});
                      this.n=0; this.s=[0,0,0];
                    }
                  }
                  return true;
                }
              } registerProcessor('score-capture',ScoreCapture);`;
              const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
              try { await c.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
              const ref = c.createGain(), out = c.createGain();
              MUSIC.bus.connect(ref); ref.connect(merge, 0, 0);
              MUSIC.comp.connect(out); out.connect(merge, 0, 1);
              const independent = c.createGain();
              for (const layer of Object.values(MUSIC.layers)) layer.connect(independent);
              independent.connect(merge,0,2);
              const tap = new AudioWorkletNode(c,'score-capture'), sink = c.createGain();
              sink.gain.value = 0; merge.connect(tap); tap.connect(sink); sink.connect(c.destination);
              tap.port.onmessage = e => trace.audio.push(e.data);
              const oldSchedule = scheduleMusicStep;
              scheduleMusicStep = function(ctx,n,t,gains) {
                trace.scheduled.push({n, t, now:ctx.currentTime});
                return oldSchedule(ctx,n,t,gains);
              };
              const oldUpdate = updateMusic;
              window.haltScheduler = false;
              window.interruptScore = false;
              updateMusic = function(dt,state) {
                if (window.haltScheduler) return;
                trace.frames.push({t:c.currentTime, dt, next:MUSIC.nextT, running:MUSIC.running});
                const result=oldUpdate(dt,state);
                if(window.interruptScore)MUSIC.bus.gain.setValueAtTime(0,c.currentTime);
                return result;
              };
              const oldPlay = playSound;
              playSound = function(name,...args) { trace.cues.push({t:c.currentTime,name}); return oldPlay(name,...args); };
              window.touchJoy = kind => {
                const el=document.querySelector('#joy-base'), r=el.getBoundingClientRect();
                const t=new Touch({identifier:37,target:el,clientX:r.left+r.width/2,clientY:r.top+r.height/2+(kind==='back'?45:-45)});
                const type=kind==='back'?'touchstart':kind;
                (type==='touchstart'?el:window).dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,changedTouches:[t],touches:type==='touchend'?[]:[t],targetTouches:type==='touchend'?[]:[t]}));
              };
              window.measureOut = out;
              waveActive=false; betweenWaveT=100000; player.spawnProtectionT=10000;
            }''')
            for phase, action in [('stationary', None), ('moving', 'touchstart'), ('stopped', 'touchend'), ('moving-again', 'back'), ('stopped-again', 'touchend')]:
                if action:
                    page.evaluate('(action) => touchJoy(action)', action)
                page.evaluate('''() => { trace.audio=[]; trace.frames=[]; trace.scheduled=[]; trace.cues=[];
                  window.phaseStart={x:player.pos.x,z:player.pos.z,time:MUSIC.ctx.currentTime}; }''')
                page.wait_for_timeout(4000)
                page.evaluate('''() => { window.phaseEnd={x:player.pos.x,z:player.pos.z,time:MUSIC.ctx.currentTime}; }''')
                page.wait_for_timeout(600)
                result = page.evaluate('''() => ({...trace, audio:trace.audio.filter(b => b.t >= phaseStart.time && b.t < phaseEnd.time), start:phaseStart,
                  end:phaseEnd,
                  dead:player.dead, paused, movement:{x:touchState.moveX,z:touchState.moveZ}})''')
                print(phase, result, flush=True)
                if result['dead'] or result['paused']:
                    raise ValueError(f'{phase}: gameplay stopped')
                print(phase, 'continuity', validate_continuity(result['audio'], min_ratio=0.2), flush=True)
                if len(result['frames']) < 10 or len(result['scheduled']) < 4:
                    raise ValueError(f'{phase}: inadequate scheduler evidence')
                print(phase, 'scheduler', validate_scheduler(result['frames'], result['scheduled'], page.evaluate('CORE.musicStepSeconds()')), flush=True)
                if 'moving' in phase:
                    if abs(result['end']['z'] - result['start']['z']) < 1:
                        raise ValueError(f'{phase}: no real touch movement')
                    if not any(c['name'].startswith('step') for c in result['cues']):
                        raise ValueError(f'{phase}: no player steps')
                elif phase.startswith('stopped') and result['movement']['z'] != 0:
                    raise ValueError(f'{phase}: touch did not stop')
            # Inject a bounded production scheduler outage; the same timing
            # validator must reject it even though MUSIC.step later advances.
            page.evaluate('''() => { trace.frames=[]; trace.scheduled=[]; }''')
            page.wait_for_timeout(800)
            page.evaluate('''() => { haltScheduler=true; }''')
            page.wait_for_timeout(1200)
            page.evaluate('''() => { haltScheduler=false; }''')
            page.wait_for_timeout(1000)
            timing = page.evaluate('''() => ({frames:trace.frames,scheduled:trace.scheduled,step:CORE.musicStepSeconds()})''')
            try:
                validate_scheduler(timing['frames'], timing['scheduled'], timing['step'])
            except ValueError as exc:
                print('scheduler outage control rejected:', str(exc), flush=True)
            else:
                raise ValueError('scheduler outage control unexpectedly passed')
            # Mute the production score upstream of both existing capture paths,
            # while independently tapping scheduled layer voices before the bus.
            page.evaluate('''() => { trace.audio=[]; trace.frames=[]; trace.scheduled=[]; window.interruptScore=true; window.controlStart=MUSIC.ctx.currentTime; }''')
            page.wait_for_timeout(1800)
            page.evaluate('''() => { window.interruptScore=false; window.controlEnd=MUSIC.ctx.currentTime; }''')
            page.wait_for_timeout(400)
            interrupted = page.evaluate('''() => ({audio:trace.audio.filter(b => b.t >= controlStart && b.t < controlEnd), frames:trace.frames, scheduled:trace.scheduled, step:CORE.musicStepSeconds()})''')
            print('upstream interruption scheduler', validate_scheduler(interrupted['frames'], interrupted['scheduled'], interrupted['step']), flush=True)
            try:
                validate_continuity(interrupted['audio'], min_ratio=0.2)
            except ValueError as exc:
                if 'upstream score interruption' not in str(exc):
                    raise ValueError(f'upstream control rejected for wrong reason: {exc}') from exc
                print('scheduled-score upstream interruption control rejected:', str(exc), flush=True)
            else:
                raise ValueError('upstream score interruption unexpectedly passed')
            # Negative controls must be rejected by the same analyzer. Flush
            # asynchronous worklet messages and exclude pre-control blocks.
            page.evaluate("() => { setSetting('musicVolume', 0); window.controlStart=MUSIC.ctx.currentTime+0.6; trace.audio=[]; }")
            page.wait_for_timeout(2200)
            muted = page.evaluate('''() => trace.audio.filter(b => b.t >= controlStart)''')
            try:
                validate_continuity(muted, min_ratio=0.2)
            except ValueError as exc:
                print('mute control rejected:', str(exc), flush=True)
            else:
                raise ValueError('muted negative control unexpectedly passed')
            page.evaluate("() => { setSetting('musicVolume', 0.5); }")
            page.wait_for_timeout(1500)
            page.evaluate('''() => { MUSIC.comp.disconnect(measureOut); window.controlStart=MUSIC.ctx.currentTime+0.2; trace.audio=[]; }''')
            page.wait_for_timeout(1800)
            disconnected = page.evaluate('''() => trace.audio.filter(b => b.t >= controlStart)''')
            try:
                validate_continuity(disconnected, min_ratio=0.2)
            except ValueError as exc:
                print('disconnected capture control rejected:', str(exc), flush=True)
            else:
                raise ValueError('disconnected negative control unexpectedly passed')
            if errors:
                raise ValueError(f'browser errors: {errors}')
        finally:
            browser.close()
    # The legacy priority-vs-footstep-duck comparison is retained as a
    # diagnostic, but its contract was superseded by steady full-band music.
    from probe_steady_fullband import main as probe_steady_fullband
    from probe_movement_music_duck import main as probe_movement_music_duck
    from probe_footstep_separation import main as probe_footstep_separation
    from probe_music_transition import main as probe_music_transition
    probe_steady_fullband(build)
    probe_movement_music_duck(build)
    probe_footstep_separation(build)
    probe_music_transition(build)


if __name__ == '__main__':
    main()
