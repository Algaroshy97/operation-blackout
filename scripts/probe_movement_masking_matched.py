"""Matched score-path comparison against the pre-change footstep duck.

Runs the real score and production cue path once. A parallel, inaudible copy of
its score bus runs the baseline gain automation and identical compressor. Thus
both score paths receive exactly the same score samples and event times; the
cue in the real master is shared by both comparisons. This measures a 200-1000
Hz energy proxy, not human audibility. A 1 dB maximum loss is a deliberately
small engineering tolerance, not a psychoacoustic threshold.
"""
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def compare(blocks, max_loss_db=1.0):
    if len(blocks) < 4:
        raise ValueError('insufficient capture')
    for i, b in enumerate(blocks):
        if any(not math.isfinite(b[k]) or b[k] < 0 for k in ('cue', 'current', 'baseline', 'mix')):
            raise ValueError('invalid energy')
        if not math.isfinite(b['t']) or (i and not 0.005 < b['t'] - blocks[i-1]['t'] < 0.025):
            raise ValueError('capture gap')
    energy = {k: sum(b[k] for b in blocks) / len(blocks) for k in ('cue', 'current', 'baseline', 'mix')}
    if min(energy.values()) < 1e-12:
        raise ValueError('missing cue, score, baseline or master')
    current = 10 * math.log10(energy['cue'] / energy['current'])
    baseline = 10 * math.log10(energy['cue'] / energy['baseline'])
    loss = baseline - current
    result = {'baseline_db': baseline, 'current_db': current, 'loss_db': loss,
              'cue_rms': math.sqrt(energy['cue']), 'baseline_music_rms': math.sqrt(energy['baseline']),
              'current_music_rms': math.sqrt(energy['current']), 'blocks': len(blocks)}
    if loss > max_loss_db:
        raise ValueError(f'matched priority regression > {max_loss_db} dB: {result}')
    return result


def main(build=ROOT / 'dist/Operation Blackout.html'):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.route('https://blackout.test/', lambda route: route.fulfill(status=200, content_type='text/html', body=Path(build).read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            page.click('#btn-start')
            page.click('#gun-select .gun-card:not(.locked)')
            page.click('#gun-select .gun-card:not(.locked)')
            page.wait_for_function('started && MUSIC.running', timeout=60000)
            print('setup', page.evaluate('''async () => {
              contextLost=true; waveActive=false; betweenWaveT=100000;
              const c=MUSIC.ctx;
              const code=`class Capture extends AudioWorkletProcessor {
                constructor(){super();this.n=0;this.s=[0,0,0,0];this.t=0;}
                process(inputs){const x=inputs[0];if(!x || x.length<3)return true;
                  for(let i=0;i<x[0].length;i++){
                    if(!this.n)this.t=(currentFrame+i)/sampleRate;
                    const mix=x[0][i],current=x[1][i],baseline=x[2][i],cue=mix-current;
                    this.s[0]+=cue*cue;this.s[1]+=current*current;this.s[2]+=baseline*baseline;this.s[3]+=mix*mix;
                    if(++this.n===512){this.port.postMessage({t:this.t,cue:this.s[0]/512,current:this.s[1]/512,baseline:this.s[2]/512,mix:this.s[3]/512});this.n=0;this.s=[0,0,0,0];}
                  }return true;}}
                registerProcessor('matched-capture',Capture);`;
              const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
              try{await c.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
              const merge=c.createChannelMerger(3), tap=new AudioWorkletNode(c,'matched-capture'), sink=c.createGain();
              sink.gain.value=0;merge.connect(tap);tap.connect(sink);sink.connect(c.destination);
              window.matchedBlocks=[];tap.port.onmessage=e=>matchedBlocks.push(e.data);
              function band(src,ch){const hp=c.createBiquadFilter(),lp=c.createBiquadFilter();hp.type='highpass';hp.frequency.value=200;lp.type='lowpass';lp.frequency.value=1000;hp.channelCount=1;hp.channelCountMode='explicit';src.connect(hp);hp.connect(lp);lp.connect(merge,0,ch);}
              const baseDuck=c.createGain(), baseComp=c.createDynamicsCompressor(), baseMaster=c.createGain();
              for(const key of ['threshold','knee','ratio','attack','release'])baseComp[key].value=MUSIC.comp[key].value;
              baseMaster.gain.value=masterGain.gain.value;
              MUSIC.bus.connect(baseDuck);baseDuck.connect(baseComp);baseComp.connect(baseMaster);
              const ref=c.createGain();ref.gain.value=masterGain.gain.value;MUSIC.comp.connect(ref);
              band(masterGain,0);band(ref,1);band(baseMaster,2);
              const gate=c.createGain();gate.connect(masterGain);const connect=AudioNode.prototype.connect;
              AudioNode.prototype.connect=function(dest,...args){if(dest===masterGain && this!==MUSIC.comp && this!==gate)return connect.call(this,gate,...args);return connect.call(this,dest,...args);};
              const old=playSound;
              playSound=function(name,...args){
                if (/^(e?step(?:_|$)|low_ammo$|bullet_whiz$|player_down$|heartbeat$)/.test(name) && MUSIC.running){
                  const t=c.currentTime,g=baseDuck.gain;
                  // Exact pre-change automation from ad340ec, with the same audio clock as production.
                  g.cancelScheduledValues(t);g.setTargetAtTime(0.04,t,0.003);g.setTargetAtTime(1,t+0.12,0.14);
                }
                const result=old(name,...args);
                if (/^e?step(?:_|$)/.test(name) && window.matchMode) {
                  const t=c.currentTime,g=MUSIC.duck.gain;
                  g.cancelScheduledValues(t);
                  g.setTargetAtTime(window.matchMode==='boost' ? 2 : 0.04, t, 0.003);
                  if(window.matchMode==='transient')g.setTargetAtTime(0.45,t+0.045,0.003);
                  g.setTargetAtTime(1,t+0.12,0.14);
                }
                return result;
              };
              window.matchGate=gate;window.matchRef=ref;window.matchBase=baseMaster;
              const state={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};
              MUSIC.intensity=1;updateMusic(0.01,state);window.matchTimer=setInterval(()=>updateMusic(0.05,state),50);
              return {sampleRate:c.sampleRate,intensity:MUSIC.intensity,master:masterGain.gain.value,musicVolume:getSetting('musicVolume')};
            }'''), flush=True)
            page.wait_for_timeout(1400)
            failures = []
            def trial(kind):
                start = page.evaluate('''kind=>{matchedBlocks=[];const t=MUSIC.ctx.currentTime;
                  if(kind==='step')playSound('step',null,true);else playSound3D('estep',player.pos.x+1,player.pos.y,player.pos.z,18);return t;}''', kind)
                page.wait_for_timeout(850)
                return page.evaluate('''t=>matchedBlocks.filter(x=>x.t+512/MUSIC.ctx.sampleRate>t && x.t<t+0.045)''', start)
            page.evaluate("() => {window.matchMode='baseline'}")
            try:
                result = compare(trial('step'))
                if abs(result['loss_db']) > 1:
                    raise ValueError(f'parallel baseline mismatch: {result}')
                print('baseline-equivalence control PASS', result, flush=True)
            except ValueError as exc:
                failures.append(f'baseline-equivalence control: {exc}')
            page.wait_for_timeout(1000)
            page.evaluate("() => {window.matchMode='boost'}")
            try:
                result = compare(trial('step'))
            except ValueError as exc:
                if 'matched priority regression' not in str(exc):
                    failures.append(f'boost control failed for wrong reason: {exc}')
                else:
                    print('music-boost control rejected', exc, flush=True)
            else:
                failures.append(f'music-boost control unexpectedly passed: {result}')
            page.evaluate("() => {window.matchMode=null}")
            page.wait_for_timeout(1000)
            page.evaluate("() => {window.matchMode='transient'}")
            for kind in ('step', 'enemy-step'):
                for i in range(3):
                    try:
                        print('experimental-transient', kind, i, 'PASS', compare(trial(kind)), flush=True)
                    except ValueError as exc:
                        print('experimental-transient', kind, i, 'RED', exc, flush=True)
            page.evaluate("() => {window.matchMode=null}")
            page.wait_for_timeout(1000)
            for kind in ('step', 'enemy-step'):
                for i in range(3):
                    blocks = trial(kind)
                    try:
                        print(kind, i, 'PASS', compare(blocks), flush=True)
                    except ValueError as exc:
                        print(kind, i, 'RED', exc, flush=True)
                        failures.append(str(exc))
            for name, change, restore in (
                ('cue-mute', 'matchGate.gain.value=0', 'matchGate.gain.value=1'),
                ('music-disconnect', 'MUSIC.comp.disconnect(matchRef)', 'MUSIC.comp.connect(matchRef)'),
                ('baseline-disconnect', 'matchBase.gain.value=0', 'matchBase.gain.value=masterGain.gain.value'),
                ('master-mute', 'masterGain.gain.value=0', 'masterGain.gain.value=AUDIO.master'),
            ):
                page.evaluate('() => {' + change + '}')
                page.wait_for_timeout(250)
                try:
                    result = compare(trial('step'), max_loss_db=1000)
                except ValueError as exc:
                    print(name, 'rejected', exc, flush=True)
                else:
                    failures.append(f'{name} unexpectedly passed: {result}')
                page.evaluate('() => {' + restore + '}')
                page.wait_for_timeout(400)
            if errors:
                failures.append(f'browser errors: {errors}')
            if failures:
                raise ValueError('matched masking failed: ' + '; '.join(failures))
            print('matched priority proxy passed; physical listening still required', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
