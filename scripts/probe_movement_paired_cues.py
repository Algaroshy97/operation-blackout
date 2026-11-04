"""Compare separate, time-aligned baseline/candidate cue and score signals."""
import math
from pathlib import Path


def compare_pair(base_cue, current_cue, base_score, current_score, peak=0):
    signals = (base_cue, current_cue, base_score, current_score)
    if not base_cue or any(len(s) != len(base_cue) for s in signals):
        raise ValueError('missing or misaligned capture')
    if not math.isfinite(peak) or peak >= 1:
        raise ValueError(f'clip or no output headroom: {peak}')
    energies = []
    for signal in signals:
        if any(not math.isfinite(x) for x in signal):
            raise ValueError('invalid PCM')
        energy = sum(x*x for x in signal) / len(signal)
        if energy < 1e-12:
            raise ValueError('missing cue or score')
        energies.append(energy)
    bcue, ccue, bscore, cscore = energies
    baseline = 10 * math.log10(bcue / bscore)
    current = 10 * math.log10(ccue / cscore)
    loss = baseline - current
    result = {'baseline_db': baseline, 'current_db': current, 'loss_db': loss,
              'cue_gain': math.sqrt(ccue / bcue), 'score_gain': math.sqrt(cscore / bscore), 'peak': peak}
    if loss > 1:
        raise ValueError(f'priority regression > 1 dB: {result}')
    return result


def main(experiment=False):
    from playwright.sync_api import sync_playwright
    build = Path(__file__).resolve().parents[1] / 'dist/Operation Blackout.html'
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            page.route('https://blackout.test/', lambda r: r.fulfill(status=200, content_type='text/html', body=build.read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            result = page.evaluate('''async experiment => {
              contextLost=true;
              const saved={AC,masterGain,noiseBuf,music:{...MUSIC},random:Math.random};
              const rate=48000,duration=11,c=new OfflineAudioContext(8,rate*duration,rate);
              const isolated=['step','step_crouch','step_tac','step_snow','step_snow_crouch','step_snow_tac',
                'step_ice','step_ice_crouch','step_ice_tac','estep','estep_heavy','estep_snow',
                'estep_snow_heavy','estep_ice','estep_ice_heavy'];
              const events=isolated.map((name,i)=>[1+i*.3,name]);
              for(let n=0;n<40;n++){events.push([6+n*.08,'estep']);if(n%3===0)events.push([6+n*.08+.04,'step']);}
              events.push([9.4,'player_down'],[9.56,'low_ammo'],[9.68,'step'],[9.8,'step'],[10.3,'step'],[10.34,'low_ammo']);
              const byFrame=new Map();for(const [t,name] of events){const f=Math.round(t*rate/128)*128;if(!byFrame.has(f))byFrame.set(f,[]);byFrame.get(f).push(name);}
              const frames=new Set(byFrame.keys());for(let f=1920;f<duration*rate;f+=1920)frames.add(f);
              const sorted=[...frames].sort((a,b)=>a-b),suspensions=sorted.map(f=>c.suspend(f/rate));
              try {
                let seed=0x12345678;Math.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
                AC=c;masterGain=null;noiseBuf=null;
                Object.assign(MUSIC,{built:false,ctx:null,bus:null,duck:null,comp:null,verb:null,layers:null,intensity:1,running:false,step:0,nextT:0,warningDuckUntil:0});
                startMusic();masterGain.disconnect(c.destination);
                const merge=c.createChannelMerger(8);merge.connect(c.destination);
                const mono=(src,ch)=>{const g=c.createGain();g.channelCount=1;g.channelCountMode='explicit';src.connect(g);g.connect(merge,0,ch);};
                const baseDuck=c.createGain(),baseComp=c.createDynamicsCompressor();
                for(const k of ['threshold','knee','ratio','attack','release'])baseComp[k].value=MUSIC.comp[k].value;
                MUSIC.bus.connect(baseDuck);baseDuck.connect(baseComp);
                const baseCue=c.createGain(),candidateCue=c.createGain();
                const baseMix=c.createGain(),candidateMix=c.createGain(),master=AUDIO.master;
                baseMix.gain.value=master;candidateMix.gain.value=master;
                baseCue.connect(baseMix);baseComp.connect(baseMix);candidateCue.connect(candidateMix);MUSIC.comp.connect(candidateMix);
                mono(baseCue,0);mono(candidateCue,1);mono(baseComp,2);mono(MUSIC.comp,3);mono(baseMix,4);mono(candidateMix,5);mono(MUSIC.bus,6);
                const dc=c.createConstantSource(),gain=c.createGain();dc.connect(gain);gain.connect(merge,0,7);dc.start();
                const proto=AudioParam.prototype, cancel=proto.cancelScheduledValues,target=proto.setTargetAtTime;
                const startBuffer=AudioBufferSourceNode.prototype.start;let armed=null;
                AudioBufferSourceNode.prototype.start=function(...args){
                  if(armed && this.buffer===_sndBuffers[armed.name])armed.duration=this.buffer.duration/this.playbackRate.value;
                  return startBuffer.apply(this,args);
                };
                proto.cancelScheduledValues=function(t){if(this===MUSIC.duck.gain)cancel.call(gain.gain,t);return cancel.call(this,t);};
                proto.setTargetAtTime=function(v,t,k){if(this===MUSIC.duck.gain)target.call(gain.gain,v,t,k);return target.call(this,v,t,k);};
                const recorded=[],state={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};
                const rendering=c.startRendering();
                try {
                  for(let i=0;i<sorted.length;i++){
                    await suspensions[i];const f=sorted[i],now=c.currentTime;
                    updateMusic(.04,state);
                    for(const name of byFrame.get(f)||[]){
                      const foot=/^e?step(?:_|$)/.test(name),g=baseDuck.gain;
                      g.cancelScheduledValues(now);g.setTargetAtTime(.04,now,.003);g.setTargetAtTime(1,now+.12,.14);
                      const cue=c.createGain(),boost=c.createGain();cue.connect(baseCue);cue.connect(boost);boost.connect(candidateCue);
                      boost.gain.value=experiment && foot?2:1;
                      armed={name,duration:recipeDuration(SOUND_RECIPES[name])};playSound(name,cue,true);const actualDuration=armed.duration;armed=null;
                      if(experiment && foot && now >= (MUSIC.warningDuckUntil||0)){
                        MUSIC.duck.gain.cancelScheduledValues(now);MUSIC.duck.gain.setTargetAtTime(.5,now,.003);MUSIC.duck.gain.setTargetAtTime(1,now+.12,.14);
                      }
                      recorded.push({name,frame:f,duration:actualDuration});
                    }
                    await c.resume();
                  }
                  const rendered=await rendering;
                  return {rate,frames:rendered.length,events:recorded,channels:Array.from({length:8},(_,i)=>Array.from(rendered.getChannelData(i)))};
                } finally {proto.cancelScheduledValues=cancel;proto.setTargetAtTime=target;AudioBufferSourceNode.prototype.start=startBuffer;}
              } finally {Math.random=saved.random;AC=saved.AC;masterGain=saved.masterGain;noiseBuf=saved.noiseBuf;Object.assign(MUSIC,saved.music);}
            }''', experiment)
            rate = result['rate']
            channels = result.pop('channels')
            if len(channels) != 8 or any(len(x) != result['frames'] for x in channels):
                raise ValueError('missing PCM')
            print('mode', 'experimental-2x-cue-0.5-duck' if experiment else 'retained-production', 'rate', rate, flush=True)
            peak = max(abs(x) for x in channels[5])
            base_peak = max(abs(x) for x in channels[4])
            dense = slice(int(6.5*rate), int(9.2*rate))
            dc = channels[7][dense]
            print('headroom', {'baseline_peak': base_peak, 'candidate_peak': peak}, flush=True)
            print('dense score gain', {'mean': sum(dc)/len(dc), 'below20_fraction': sum(x < .2 for x in dc)/len(dc)}, flush=True)
            dense_ref = math.sqrt(sum(x*x for x in channels[6][dense])/len(dc))
            dense_music = math.sqrt(sum(x*x for x in channels[3][dense])/len(dc))
            print('dense fullband score', {'reference_rms': dense_ref, 'output_rms': dense_music, 'output_reference_ratio': dense_music/dense_ref}, flush=True)
            cue_factor = 2 if experiment else 1
            cue_residual = max(abs(b-cue_factor*a) for a,b in zip(channels[0][dense],channels[1][dense]))
            print('same-source dense PCM residual', cue_residual, flush=True)
            failures = []
            if cue_residual > 1e-7: failures.append('same-source cue mismatch')
            for event in result['events'][:15]:
                start = event['frame']; end = start + math.ceil(event['duration']*rate)
                print(event['name'], 'paired mix peaks', {'baseline':max(abs(x) for x in channels[4][start:end]), 'candidate':max(abs(x) for x in channels[5][start:end])}, flush=True)
                try:
                    measurement = compare_pair(*(channel[start:end] for channel in channels[:4]), peak=max(abs(x) for x in channels[5][start:end]))
                    print(event['name'], 'PASS', measurement, flush=True)
                except ValueError as exc:
                    print(event['name'], 'RED', exc, flush=True); failures.append(event['name'])
            try:
                print('dense paired', compare_pair(*(channel[dense] for channel in channels[:4]), peak=max(abs(x) for x in channels[5][dense])), flush=True)
            except ValueError as exc:
                print('dense paired RED', exc, flush=True); failures.append('dense paired')
            for label, at in [('overlap warning tail', 9.79), ('step then warning', 10.39)]:
                value = channels[7][round(at*rate)]
                print(label, value, flush=True)
                if value >= .2: failures.append(label)
            for label, data in [('muted-cue', (channels[0][dense], [0.0]*len(dc), channels[2][dense], channels[3][dense])),
                                ('muted-score', (channels[0][dense], channels[1][dense], channels[2][dense], [0.0]*len(dc)))]:
                try: compare_pair(*data)
                except ValueError as exc: print(label, 'rejected', exc, flush=True)
                else: failures.append(label+' not rejected')
            if peak >= 1: failures.append('clipping')
            if sum(dc)/len(dc) < .5 or sum(x < .2 for x in dc)/len(dc) >= .25: failures.append('dense continuity')
            if failures: raise ValueError('paired experiment failed: '+', '.join(failures))
        finally:
            browser.close()


if __name__ == '__main__':
    import sys
    main('--experiment' in sys.argv)
