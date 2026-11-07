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
    weights = [b.get('samples', 1) for b in blocks]
    energy = {k: sum(b[k] * w for b, w in zip(blocks, weights)) / sum(weights)
              for k in ('cue', 'current', 'baseline', 'mix')}
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


def compare_baseline_waveform(blocks):
    result = compare(blocks)
    difference = sum(b['difference'] * b.get('samples', 1) for b in blocks)
    reference = sum(b['baseline'] * b.get('samples', 1) for b in blocks)
    if not math.isfinite(difference) or difference > reference * 1e-8:
        raise ValueError(f'baseline waveform mismatch: difference/reference={difference/reference}')
    result['waveform_difference_ratio'] = difference / reference
    return result


def main(build=ROOT / 'dist/Operation Blackout.html'):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else print(m.text, flush=True) if m.text.startswith('worklet metadata anomalies') else None)
            page.route('https://blackout.test/', lambda route: route.fulfill(status=200, content_type='text/html', body=Path(build).read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            page.click('#btn-start')
            page.click('#gun-select .gun-card:not(.locked)')
            page.click('#gun-select .gun-card:not(.locked)')
            page.wait_for_function('started && MUSIC.running', timeout=60000)
            clock_code = (ROOT / 'scripts/movement_audio_clock.js').read_text()
            print('setup', page.evaluate('''async clockCode => {
              contextLost=true; waveActive=false; betweenWaveT=100000;
              const c=MUSIC.ctx;
              const scale=4194304, startFrame=Math.ceil((c.currentTime+0.5)*c.sampleRate/128)*128;
              const code=clockCode+`\nclass Capture extends AudioWorkletProcessor {
                constructor(){super();this.n=0;this.s=[new Float32Array(512),new Float32Array(512),new Float32Array(512),new Float32Array(512)];this.frame=0;this.expected=null;this.clock=new RampClock(${scale});}
                process(inputs){const x=inputs[0];
                  if(this.expected!==null && currentFrame!==this.expected){
                    this.port.postMessage({metadata:'worklet frame discontinuity',expected:this.expected,actual:currentFrame});
                  }
                  this.expected=currentFrame+128;
                  if(!x || x.length<4){this.port.postMessage({fault:'missing input',frame:currentFrame});this.n=0;return true;}
                  if(x[3][0]===0 && this.clock.next===null)return true;
                  let first;
                  try {first=${startFrame}+this.clock.accept(x[3]);}
                  catch(e){this.port.postMessage({fault:String(e),frame:currentFrame});return false;}
                  for(let i=0;i<x[0].length;i++){
                    if(!this.n)this.frame=first+i;
                    const mix=x[0][i],current=x[1][i],baseline=x[2][i],cue=mix-current;
                    this.s[0][this.n]=cue;this.s[1][this.n]=current;this.s[2][this.n]=baseline;this.s[3][this.n]=mix;
                    if(++this.n===512){this.port.postMessage({frame:this.frame,s:this.s},this.s.map(a=>a.buffer));this.n=0;this.s=[new Float32Array(512),new Float32Array(512),new Float32Array(512),new Float32Array(512)];}
                  }return true;}}
                registerProcessor('matched-capture',Capture);`;
              const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
              try{await c.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
              const merge=c.createChannelMerger(4), tap=new AudioWorkletNode(c,'matched-capture'), sink=c.createGain();
              sink.gain.value=0;merge.connect(tap);tap.connect(sink);sink.connect(c.destination);
              window.matchedBlocks=[];window.matchedFaults=[];window.matchedMetadata=[];
              tap.port.onmessage=e=>{if(e.data.fault)matchedFaults.push(e.data);else if(e.data.metadata)matchedMetadata.push(e.data);else matchedBlocks.push(e.data);};
              const ramp=c.createConstantSource();ramp.offset.setValueAtTime(0,c.currentTime);ramp.offset.setValueAtTime(0,startFrame/c.sampleRate);
              ramp.offset.linearRampToValueAtTime(1,(startFrame+scale)/c.sampleRate);ramp.connect(merge,0,3);ramp.start();
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
              const startSource=AudioBufferSourceNode.prototype.start;
              AudioBufferSourceNode.prototype.start=function(when,...args){
                if(window.matchArmed && this.buffer){window.matchSource={t:when,duration:this.buffer.duration/this.playbackRate.value};window.matchArmed=false;}
                return startSource.call(this,when,...args);
              };
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
            }''', clock_code), flush=True)
            page.wait_for_timeout(1400)
            failures = []
            def trial(kind):
                source = page.evaluate('''kind=>{window.matchSource=null;window.matchArmed=true;
                  if(kind.startsWith('estep'))playSound3D(kind,player.pos.x+1,player.pos.y,player.pos.z,18);else playSound(kind,null,true);
                  window.matchArmed=false;return window.matchSource;}''', kind)
                if not source:
                    raise ValueError(f'{kind}: no pre-rendered cue source captured')
                page.wait_for_timeout(850)
                return page.evaluate('''source=>{
                  const rate=MUSIC.ctx.sampleRate, start=Math.ceil(source.t*rate), end=Math.ceil((source.t+source.duration)*rate);
                  const relevant=matchedBlocks.filter(b=>b.frame<end && b.frame+512>start).sort((a,b)=>a.frame-b.frame);
                  const faults=matchedFaults.filter(f=>(f.frame ?? f.actual)>=start && (f.frame ?? f.actual)<end);
                  if(faults.length)throw Error(`worklet faults: ${JSON.stringify(faults)}`);
                  if(matchedFaults.length)throw Error(`worklet capture stopped: ${JSON.stringify(matchedFaults)}`);
                  for(let i=1;i<relevant.length;i++)if(relevant[i].frame!==relevant[i-1].frame+512)
                    throw Error(`capture missing/overlap: ${relevant[i-1].frame} -> ${relevant[i].frame}, phase ${start}..${end}`);
                  const bins=[];let frame=start;
                  while(frame<end){const stop=Math.min(end,frame+Math.round(rate*0.01)), sum=[0,0,0,0,0];let n=0;
                    for(const b of relevant){const first=b.frame,lo=Math.max(frame,first),hi=Math.min(stop,first+512);
                      for(let f=lo;f<hi;f++){for(let k=0;k<4;k++)sum[k]+=b.s[k][f-first]**2;sum[4]+=(b.s[1][f-first]-b.s[2][f-first])**2;n++;}}
                    if(n!==stop-frame)throw Error(`capture gap ${n}/${stop-frame} at ${frame}..${stop}; blocks ${JSON.stringify(relevant.map(b=>b.frame))}`);
                    bins.push({t:frame/rate,samples:n,cue:sum[0]/n,current:sum[1]/n,baseline:sum[2]/n,mix:sum[3]/n,difference:sum[4]/n});frame=stop;
                  }
                  matchedBlocks=matchedBlocks.filter(b=>b.frame+512>end);
                  matchedFaults=matchedFaults.filter(f=>(f.frame ?? f.actual)>=end);
                  if(matchedMetadata.length){console.log('worklet metadata anomalies',JSON.stringify(matchedMetadata));matchedMetadata=[];}
                  return bins;
                }''', source)
            page.evaluate("() => {window.matchMode='baseline'}")
            try:
                result = compare_baseline_waveform(trial('step'))
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
            for kind in ('step', 'estep', 'estep_heavy', 'step_snow', 'estep_snow', 'estep_snow_heavy', 'step_ice', 'estep_ice', 'estep_ice_heavy'):
                for i in range(3):
                    try:
                        print('experimental-transient', kind, i, 'PASS', compare(trial(kind)), flush=True)
                    except ValueError as exc:
                        print('experimental-transient', kind, i, 'RED', exc, flush=True)
            page.evaluate("() => {window.matchMode=null}")
            page.wait_for_timeout(1000)
            for kind in ('step', 'estep', 'estep_heavy', 'step_snow', 'estep_snow', 'estep_snow_heavy', 'step_ice', 'estep_ice', 'estep_ice_heavy'):
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


def offline_main(build=ROOT / 'dist/Operation Blackout.html', experiment=False):
    """Deterministic audio-clock replay; not a real-time or listening test."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            page.route('https://blackout.test/', lambda r: r.fulfill(status=200, content_type='text/html', body=Path(build).read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            result = page.evaluate('''async experiment => {
              contextLost=true;
              const saved={AC,masterGain,noiseBuf,music:{...MUSIC},random:Math.random};
              const rate=48000, duration=12, c=new OfflineAudioContext(5,rate*duration,rate);
              const events=[
                [1.0,'step'],[1.48,'estep'],[1.96,'estep_heavy'],[2.44,'step_snow'],
                [2.92,'estep_snow'],[3.40,'estep_snow_heavy'],[3.88,'step_ice'],
                [4.36,'estep_ice'],[4.84,'estep_ice_heavy']
              ];
              for(let n=0;n<40;n++){events.push([6+n*.08,'estep']);if(n%3===0)events.push([6+n*.08+.04,'step']);}
              events.push([9.4,'player_down'],[9.56,'low_ammo'],[9.68,'step'],[9.8,'step'],
                          [10.4,'step'],[10.44,'low_ammo']);
              const byFrame=new Map();
              for(const [t,name] of events){const f=Math.round(t*rate/128)*128;if(!byFrame.has(f))byFrame.set(f,[]);byFrame.get(f).push(name);}
              const frames=new Set(byFrame.keys());
              for(const t of [10.8,11.04,11.28,11.6])frames.add(Math.round(t*rate/128)*128);
              for(let f=1920;f<duration*rate;f+=1920)frames.add(f);
              const sorted=[...frames].sort((a,b)=>a-b);
              const suspensions=sorted.map(f=>c.suspend(f/rate));
              try {
                let seed=0x12345678;
                Math.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
                AC=c;masterGain=null;noiseBuf=null;
                Object.assign(MUSIC,{built:false,ctx:null,bus:null,duck:null,comp:null,verb:null,layers:null,intensity:1,running:false,step:0,nextT:0,warningDuckUntil:0});
                startMusic();
                masterGain.disconnect(c.destination);
                // Exploratory test-only notch; the production graph remains unchanged.
                const notch=c.createBiquadFilter();notch.type='peaking';notch.frequency.value=500;notch.Q.value=.5;notch.gain.value=0;
                if(experiment){MUSIC.bus.disconnect(MUSIC.duck);MUSIC.bus.connect(notch);notch.connect(MUSIC.duck);}
                const merge=c.createChannelMerger(5);merge.connect(c.destination);
                const band=(src,ch)=>{const hp=c.createBiquadFilter(),lp=c.createBiquadFilter();hp.type='highpass';hp.frequency.value=200;lp.type='lowpass';lp.frequency.value=1000;hp.channelCount=1;hp.channelCountMode='explicit';src.connect(hp);hp.connect(lp);lp.connect(merge,0,ch);};
                const base=c.createGain(),comp=c.createDynamicsCompressor();
                for(const k of ['threshold','knee','ratio','attack','release'])comp[k].value=MUSIC.comp[k].value;
                MUSIC.bus.connect(base);base.connect(comp);band(MUSIC.bus,0);band(MUSIC.comp,1);band(comp,2);
                const cue=c.createGain();band(cue,3);
                // Mirror the real AudioParam events into an isolated DC measurement path.
                const dc=c.createConstantSource(),gain=c.createGain();dc.offset.value=1;dc.connect(gain);gain.connect(merge,0,4);dc.start();
                const proto=AudioParam.prototype, origCancel=proto.cancelScheduledValues, origTarget=proto.setTargetAtTime;
                proto.cancelScheduledValues=function(t){if(this===MUSIC.duck.gain)origCancel.call(gain.gain,t);return origCancel.call(this,t);};
                proto.setTargetAtTime=function(v,t,k){if(this===MUSIC.duck.gain)origTarget.call(gain.gain,v,t,k);return origTarget.call(this,v,t,k);};
                const recorded=[];
                const state={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};
                const rendering=c.startRendering();
                try {
                  for(let i=0;i<sorted.length;i++){
                    await suspensions[i]; const f=sorted[i],now=c.currentTime;
                    if(Math.abs(now-f/rate)>1/rate)throw Error(`offline suspend mismatch ${now} ${f/rate}`);
                    updateMusic(.04,state);
                    if(f===Math.round(10.8*rate/128)*128)MUSIC.bus.disconnect(base);
                    if(f===Math.round(11.04*rate/128)*128){cue.gain.value=0;playSound('step',cue,true);}
                    if(f===Math.round(11.28*rate/128)*128)MUSIC.duck.disconnect(MUSIC.comp);
                    if(f===Math.round(11.6*rate/128)*128){MUSIC.duck.gain.cancelScheduledValues(now);MUSIC.duck.gain.setTargetAtTime(.04,now,.003);}
                    for(const name of byFrame.get(f)||[]){
                      const g=base.gain;g.cancelScheduledValues(now);g.setTargetAtTime(.04,now,.003);g.setTargetAtTime(1,now+.12,.14);
                      playSound(name,cue,true);
                      if(experiment && /^e?step(?:_|$)/.test(name) && now >= (MUSIC.warningDuckUntil||0)){
                        const current=MUSIC.duck.gain;current.cancelScheduledValues(now);current.setTargetAtTime(1,now,.003);
                        notch.gain.cancelScheduledValues(now);notch.gain.setTargetAtTime(-24,now,.003);notch.gain.setTargetAtTime(0,now+.12,.14);
                      }
                      recorded.push({name,frame:f,duration:recipeDuration(SOUND_RECIPES[name])});
                    }
                    await c.resume();
                  }
                  const rendered=await rendering;
                  const channels=Array.from({length:5},(_,i)=>Array.from(rendered.getChannelData(i)));
                  return {rate,frames:rendered.length,events:recorded,channels};
                } finally {proto.cancelScheduledValues=origCancel;proto.setTargetAtTime=origTarget;}
              } finally {Math.random=saved.random;AC=saved.AC;masterGain=saved.masterGain;noiseBuf=saved.noiseBuf;Object.assign(MUSIC,saved.music);}
            }''', experiment)
            rate = result['rate']
            channels = result.pop('channels')
            if len(channels) != 5 or any(len(x) != result['frames'] for x in channels):
                raise ValueError('offline capture length mismatch')
            print('offline replay', result, flush=True)
            dense = channels[4][int(6.5 * rate):int(9.2 * rate)]
            mean = sum(dense) / len(dense)
            below = sum(x < .2 for x in dense) / len(dense)
            print('dense gain', {'mean': mean, 'below20_fraction': below}, flush=True)
            failures = []
            if mean < .5 or below >= .25:
                failures.append('dense footstep continuity')
            for label, at in (('overlap warning tail', 9.79), ('step then warning', 10.49)):
                value = channels[4][round(at * rate)]
                print(label, {'time': at, 'gain': value}, flush=True)
                if value >= .2:
                    failures.append(f'{label}: gain {value}')
            reference_rms = math.sqrt(sum(x*x for x in channels[0][int(6.5*rate):int(9.2*rate)]) / len(dense))
            print('dense reference band RMS', reference_rms, flush=True)
            if reference_rms < 1e-6:
                failures.append('missing dense score reference')
            def rms(ch, start, end):
                data = channels[ch][round(start*rate):round(end*rate)]
                return math.sqrt(sum(x*x for x in data) / len(data))
            controls = {'baseline-disconnect': rms(2, 10.96, 11.02),
                        'cue-mute': rms(3, 11.06, 11.12),
                        'music-disconnect': rms(1, 11.44, 11.5),
                        'gain': channels[4][round(11.65*rate)]}
            print('graph negative controls', controls, flush=True)
            if any(controls[k] > 1e-6 for k in ('baseline-disconnect', 'cue-mute', 'music-disconnect')) or controls['gain'] >= .2:
                failures.append('graph negative control failed')
            for event in result['events'][:9]:
                start = event['frame']
                end = min(result['frames'], start + math.ceil(event['duration'] * rate))
                bins = []
                for i in range(start, end, rate // 100):
                    stop = min(end, i + rate // 100)
                    energies = [sum(x*x for x in ch[i:stop]) / (stop-i) for ch in channels[:4]]
                    bins.append(dict(t=i/rate, samples=stop-i, cue=energies[3], current=energies[1], baseline=energies[2], mix=energies[0]))
                try:
                    print(event['name'], 'PASS', compare(bins), flush=True)
                except ValueError as exc:
                    print(event['name'], 'RED', exc, flush=True)
                    failures.append(f"{event['name']}: {exc}")
            if failures:
                raise ValueError('; '.join(failures))
        finally:
            browser.close()


if __name__ == '__main__':
    import sys
    offline_main(experiment='--notch' in sys.argv) if '--offline' in sys.argv else main()
