"""Matched full-graph footstep/score discrimination proxy; not a listening test."""
from pathlib import Path
import json
import math
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def validate_linear(row):
    """Bound roundoff in float32 addition, not a hearing/masking threshold."""
    cue, score, error = (row[k] for k in ('linearCue', 'linearScore', 'linearError'))
    if not all(math.isfinite(x) for x in (cue, score, error)) or cue <= 0 or score <= 0 or error < 0:
        raise ValueError('missing linear signal')
    if row['peak'] >= 1:
        raise ValueError('mix clipping')
    # Eight float32 epsilons allow independent gain and sum rounding.
    limit = (8 * 2**-23)**2 * (cue + score)
    if error > limit:
        raise ValueError(f'cue not preserved: residual {error:g} exceeds {limit:g}')
    return error / limit


def validate_row(row, reference):
    """Relative regression guard, not an absolute audibility threshold.

    This historical 6 dB regression sentinel uses a previously rejected
    reference and is not a criterion for audibility. Separate score/headroom checks
    avoid passing by muting the music or clipping the mix.
    """
    if row['peak'] >= 1:
        raise ValueError('mix clipping')
    if any(len(v) != 3 for v in (row['ratios'], row['scores'], reference['ratios'], reference['scores'])):
        raise ValueError('missing frequency band')
    for ratio, score, expected_ratio, expected_score in zip(
            row['ratios'], row['scores'], reference['ratios'], reference['scores'], strict=True):
        if not all(math.isfinite(x) and x > 0 for x in (ratio, score, expected_ratio, expected_score)):
            raise ValueError('missing/nonfinite cue or score')
        if not .5 <= score / expected_score <= 2:
            raise ValueError('reference score energy changed')
        if ratio / expected_ratio < .25:
            raise ValueError('cue-to-score separation materially degraded')


def capture(page, scale):
    return page.evaluate('''async (scale) => {
      contextLost=true;
      const saved={AC,masterGain,noiseBuf,music:{...MUSIC},random:Math.random,master:audioMaster,throttle:soundThrottled,now:performance.now.bind(performance)};
      let seed=123456; Math.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
      const rate=48000,names=['step','step_crouch','step_tac','step_snow','step_snow_crouch','step_snow_tac','step_ice','step_ice_crouch','step_ice_tac','estep','estep_heavy','estep_snow','estep_snow_heavy','estep_ice','estep_ice_heavy'];
      const events=names.map((name,i)=>({time:1+i*.55,name,spatial:name.startsWith('estep'),distance:i%2?4:2}));
      const denseStart=10; for(let i=0;i<30;i++)events.push({time:denseStart+i*.08,name:names[(i*7)%names.length],spatial:names[(i*7)%names.length].startsWith('estep'),distance:i%2?4:2,dense:true});
      const length=13, c=new OfflineAudioContext(12,rate*length,rate);
      try {
        Object.defineProperty(performance,'now',{configurable:true,value:()=>c.currentTime*1000});
        AC=c;masterGain=null;noiseBuf=null;
        // Populate the same production one-shot cache deterministically before
        // the score starts; asynchronous cache completion must not change a run.
        for(const name of names) {
          const off=new OfflineAudioContext(1,Math.ceil(recipeDuration(SOUND_RECIPES[name])*rate),rate);
          buildSound(off,SOUND_RECIPES[name],off.destination,0,noiseBuffer(off));
          _sndBuffers[name]=await off.startRendering();
        }
        seed=123456;
        Object.assign(MUSIC,{built:false,ctx:null,bus:null,duck:null,comp:null,verb:null,layers:null,intensity:1,running:false,step:0,nextT:0,warningDuckUntil:0});
        startMusic();
        // Separate cue bus is inserted only at audioMaster's return; 3D gain/filter/pan,
        // attenuation, and production throttle remain intact. Score remains untouched.
        const real=audioMaster(), cue=c.createGain(), mixedCue=c.createGain(); mixedCue.gain.value=scale; cue.connect(mixedCue); mixedCue.connect(real);
        const admissions=[];soundThrottled=function(name){const blocked=saved.throttle(name);admissions.push({name,blocked});return blocked;};
        real.disconnect(c.destination);
        const merger=c.createChannelMerger(12);merger.connect(c.destination);
        const score=c.createGain();score.gain.value=AUDIO.master;MUSIC.comp.connect(score);
        function mono(src,ch){const g=c.createGain();g.channelCount=1;g.channelCountMode='explicit';src.connect(g);g.connect(merger,0,ch);}
        const split=c.createChannelSplitter(2);real.connect(split);split.connect(merger,0,6);split.connect(merger,1,7);
        const cueTap=c.createGain();cueTap.channelCount=2;cueTap.channelCountMode='explicit';cueTap.gain.value=AUDIO.master;cue.connect(cueTap);
        const cueSplit=c.createChannelSplitter(2);cueTap.connect(cueSplit);cueSplit.connect(merger,0,8);cueSplit.connect(merger,1,9);
        const scoreSplit=c.createChannelSplitter(2);score.connect(scoreSplit);scoreSplit.connect(merger,0,10);scoreSplit.connect(merger,1,11);
        [250,1000,4000].forEach((hz,i)=>{for(const [src,ch] of [[real,2*i],[score,2*i+1]]) {const f=c.createBiquadFilter();f.type='bandpass';f.frequency.value=hz;f.Q.value=1;src.connect(f);mono(f,ch);}});
        const p=player.pos.clone(), yaw=player.yaw;
        player.pos.set(0,1.6,0);player.yaw=0;
        const byFrame=new Map();for(const e of events){const frame=Math.round(e.time*rate/128)*128;e.time=frame/rate;if(!byFrame.has(frame))byFrame.set(frame,[]);byFrame.get(frame).push(e);}
        const frames=new Set(byFrame.keys());for(let t=.04;t<length-.04;t+=.04)frames.add(Math.round(t*rate/128)*128);
        const ordered=[...frames].sort((a,b)=>a-b), pauses=ordered.map(f=>c.suspend(f/rate));
        const state={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};updateMusic(.04,state);
        const rendering=c.startRendering();
        for(let i=0;i<ordered.length;i++) {await pauses[i];updateMusic(.04,state);for(const e of byFrame.get(ordered[i])||[]) {
          audioMaster=()=>cue;
          // Offline rendering can outlast the real-time cleanup timer; keep the
          // short-lived nodes connected until render completion, without changing
          // the spatial graph, production throttle, or cue envelopes.
          const timer=window.setTimeout;
          try {window.setTimeout=()=>0;if(e.spatial)playSound3D(e.name,e.distance,1.6,0,20);else playSound(e.name);}
          finally {window.setTimeout=timer;audioMaster=saved.master;}
        } await c.resume();}
        const audio=await rendering;
        player.pos.copy(p);player.yaw=yaw;
        function metric(start,end) {const a=Math.floor(start*rate),b=Math.floor(end*rate),ratios=[],energies=[],scores=[];
          for(let k=0;k<3;k++){const m=audio.getChannelData(k*2),s=audio.getChannelData(k*2+1);let cueE=0,scoreE=0;for(let i=a;i<b;i++){cueE+=(m[i]-s[i])**2;scoreE+=s[i]**2;}energies.push(cueE/(b-a));scores.push(scoreE/(b-a));ratios.push(cueE/scoreE);}
          let peak=0, error=0, cueEnergy=0, scoreEnergy=0;
          // Save stereo score separately below; channels 0..5 are band-limited.
          for(let k=0;k<2;k++){const m=audio.getChannelData(6+k),q=audio.getChannelData(8+k),s=audio.getChannelData(10+k);for(let i=a;i<b;i++){peak=Math.max(peak,Math.abs(m[i]));error+=(m[i]-s[i]-q[i])**2;cueEnergy+=q[i]**2;scoreEnergy+=s[i]**2;}}
          return {ratios,energies,scores,peak,linearError:error,linearCue:cueEnergy,linearScore:scoreEnergy};}
        return {individual:events.filter(e=>!e.dense).map(e=>({...e,...metric(e.time,e.time+.12)})),dense:metric(denseStart,denseStart+2.5),admissions};
      } finally {audioMaster=saved.master;soundThrottled=saved.throttle;Object.defineProperty(performance,'now',{configurable:true,value:saved.now});Math.random=saved.random;AC=saved.AC;masterGain=saved.masterGain;noiseBuf=saved.noiseBuf;Object.assign(MUSIC,saved.music);}
    }''', scale)


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            results = []
            for scale in (1, .5, .1, 0):
                page = browser.new_page()
                try:
                    page.route('https://blackout.test/', lambda r: r.fulfill(status=200, content_type='text/html', body=Path(build).read_bytes()))
                    page.goto('https://blackout.test/', wait_until='domcontentloaded')
                    page.wait_for_function('assetsReady === true', timeout=60000)
                    results.append(capture(page, scale))
                finally:
                    page.close()
            normal, halved, suppressed, disconnected = results
            reference = json.loads((ROOT / 'tests/steady_footstep_reference.json').read_text())
            rows = normal['individual'] + [normal['dense']]
            controls = suppressed['individual'] + [suppressed['dense']]
            half_controls = halved['individual'] + [halved['dense']]
            zero_controls = disconnected['individual'] + [disconnected['dense']]
            refs = reference['individual'] + [reference['dense']]
            if len(rows) != 16 or len(refs) != 16 or len(normal['admissions']) != 45:
                raise ValueError('missing variant, dense event or throttle invocation')
            if any(a['blocked'] for a in normal['admissions']):
                raise ValueError('expected footstep throttled')
            for idx, (row, control, ref) in enumerate(zip(rows, controls, refs, strict=True)):
                if idx < 15 and any(row[k] != ref[k] for k in ('name', 'spatial', 'distance')):
                    raise ValueError('variant or spatial fixture differs from reference')
                validate_row(row, ref)
                residual = validate_linear(row)
                for label, altered in (('half', half_controls[idx]), ('tenth', control), ('disconnected', zero_controls[idx])):
                    try:
                        validate_linear(altered)
                    except ValueError as exc:
                        if 'cue not preserved' not in str(exc):
                            raise
                    else:
                        raise ValueError(f'linear {label} control {idx} passed')
                if not all(e > 0 for e in control['energies']):
                    raise ValueError('negative control cue must remain nonzero')
                try:
                    validate_row(control, ref)
                except ValueError as exc:
                    if str(exc) != 'cue-to-score separation materially degraded':
                        raise ValueError(f'control {idx} rejected for wrong reason: {exc}') from exc
                else:
                    raise ValueError(f'suppressed nonzero control {idx} passed')
                print('footstep', row.get('name', 'dense'), 'ratios', row['ratios'],
                      'nonzero suppressed ratios', control['ratios'], 'peak', row['peak'],
                      'linear residual/roundoff limit', residual, flush=True)
            print('production throttle admissions:', len(normal['admissions']), 'nonzero suppressed controls rejected:', len(controls), 'linear half/tenth/disconnected controls rejected:', 3 * len(controls), flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
