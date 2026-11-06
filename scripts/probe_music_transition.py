"""Production transition and deliberately overqueued control; not listening acceptance."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def validate_response(data, transition, bound):
    future = [c for c in data['calls'] if c['now'] >= transition]
    if not future:
        raise ValueError('no post-transition production decisions')
    delay = min(c['t'] for c in future) - transition
    if delay > bound:
        raise ValueError(f'excessive stale queue at {transition}: {delay:.3f}s > {bound:.3f}s')
    return delay


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            page.route('https://blackout.test/', lambda r: r.fulfill(status=200, content_type='text/html', body=Path(build).read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            result = page.evaluate('''async () => {
              contextLost=true;
              const saved={AC,masterGain,noiseBuf,music:{...MUSIC},random:Math.random,
                schedule:scheduleMusicStep,arp:musArp,bass:musBass,drum:musDrum};
              async function run(stale) {
                let seed=123456; Math.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
                const rate=48000,c=new OfflineAudioContext(4,rate*9,rate), calls=[],voices=[];
                AC=c;masterGain=null;noiseBuf=null;
                Object.assign(MUSIC,{built:false,ctx:null,bus:null,duck:null,comp:null,verb:null,layers:null,intensity:0,running:false,step:0,nextT:0,warningDuckUntil:0});
                startMusic();
                // Tap the actual post-layer-gain signal from production voices.
                const merger=c.createChannelMerger(4);merger.connect(c.destination);
                masterGain.disconnect(c.destination);
                function mono(src,ch){const g=c.createGain();g.channelCount=1;g.channelCountMode='explicit';src.connect(g);g.connect(merger,0,ch);}
                mono(masterGain,0);['drums','bass','arp'].forEach((k,i)=>mono(MUSIC.layers[k],i+1));
                musArp=function(ctx,t,n,out){voices.push({kind:'arp',t,n,now:ctx.currentTime}); return saved.arp(ctx,t,n,out);};
                musBass=function(ctx,t,n,out){voices.push({kind:'bass',t,n,now:ctx.currentTime}); return saved.bass(ctx,t,n,out);};
                musDrum=function(ctx,t,k,v,out){voices.push({kind:k,t,v,now:ctx.currentTime}); return saved.drum(ctx,t,k,v,out);};
                scheduleMusicStep=function(ctx,n,t,gains){
                  calls.push({n,t,now:ctx.currentTime,intensity:MUSIC.intensity});
                  return saved.schedule(ctx,n,t,gains);
                };
                const calm={inCombat:false,aliveEnemies:0,nearestEnemy:100,health:100};
                const combat={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};
                updateMusic(.04,calm);
                const frames=new Set(); for(let t=.04;t<8.96;t+=.04) frames.add(Math.round(t*rate/128)*128);
                const forced=[2.96,5.96].map(t=>Math.round(t*rate/128)*128);forced.forEach(f=>frames.add(f));
                const ordered=[...frames].sort((a,b)=>a-b),pauses=ordered.map(f=>c.suspend(f/rate)); const rendering=c.startRendering();
                for(let j=0;j<ordered.length;j++){await pauses[j];updateMusic(.04,c.currentTime>=3&&c.currentTime<6?combat:calm);
                  // Queue genuine future production voices before the transition.
                  // This simulates an excessive 1.8s lookahead without changing
                  // the normal production scheduler or replacing its decisions.
                  if(stale && forced.includes(ordered[j])) {
                    const gains=CORE.musicLayerGains(MUSIC.intensity), st=CORE.musicStepSeconds();
                    while(MUSIC.nextT<c.currentTime+1.8){scheduleMusicStep(c,MUSIC.step,MUSIC.nextT,gains);MUSIC.nextT+=st;MUSIC.step++;}
                  }
                  await c.resume();}
                const audio=await rendering;
                const samples=[3.5,6.5].map(t=>Array.from({length:4},(_,ch)=>Array.from(audio.getChannelData(ch).slice(t*rate,(t+1)*rate))));
                return {calls,voices,samples,step:CORE.musicStepSeconds(),lookahead:MUSIC_LOOKAHEAD};
              }
              try {return {normal:await run(false),stale:await run(true)};}
              finally {AC=saved.AC;masterGain=saved.masterGain;noiseBuf=saved.noiseBuf;Object.assign(MUSIC,saved.music);Math.random=saved.random;scheduleMusicStep=saved.schedule;musArp=saved.arp;musBass=saved.bass;musDrum=saved.drum;}
            }''')
            normal, stale = result['normal'], result['stale']
            # Fixed to the approved 0.5s maximum, not the possibly regressed
            # runtime constant; one score step plus one update allows phase.
            bound = .5 + normal['step'] + .04
            if normal['lookahead'] > .5:
                raise ValueError('production lookahead exceeds approved bound')
            for i, transition in enumerate((3, 6)):
                delay = validate_response(normal, transition, bound)
                try:
                    validate_response(stale, transition, bound)
                except ValueError as exc:
                    if 'excessive stale queue' not in str(exc):
                        raise
                    print('negative control rejected:', exc, flush=True)
                else:
                    raise ValueError('overqueued control unexpectedly passed')
                source_events = [v for v in normal['voices'] if transition <= v['t'] < transition + 1.5]
                control_events = [v for v in stale['voices'] if transition <= v['t'] < transition + 1.5]
                if not source_events or source_events == control_events:
                    raise ValueError('missing or indistinguishable scheduled sources')
                response_voices = [v for v in source_events if v['now'] >= transition]
                if not response_voices:
                    raise ValueError('no actual post-transition scheduled voices')
                decisions = [c for c in normal['calls'] if c['now'] >= transition and c['t'] < transition + 1.5]
                before = [c for c in normal['calls'] if c['now'] < transition][-1]['intensity']
                if not decisions or not (max(c['intensity'] for c in decisions) > before if transition == 3
                                         else min(c['intensity'] for c in decisions) < before):
                    raise ValueError('scheduled intensity did not change in the requested direction')
                # The actual audible post-gain layer waveforms must differ, not
                # merely the scheduler counters or nominal gain parameters.
                diffs = []
                for a, b in zip(normal['samples'][i], stale['samples'][i], strict=True):
                    energy = sum(x*x for x in a)
                    delta = sum((x-y)**2 for x, y in zip(a, b, strict=True))
                    diffs.append(delta / energy if energy else 0)
                if max(diffs[1:]) < .01 or diffs[0] < .000001:
                    raise ValueError(f'queued decisions did not affect rendered audio: {diffs}')
                print('transition', transition, 'post-state decision delay', delay,
                      'bound', bound, 'production voices', len(source_events),
                      'post-state voices', len(response_voices), 'control voices', len(control_events),
                      'rendered difference ratios', diffs, flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
