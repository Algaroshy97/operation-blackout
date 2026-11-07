"""Pre-registered note-targeted production-master experiment; not listening proof."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PHASES = (0, 4, 8, 12, 16, 20, 24, 28)


def compare(normal, baseline, stale, repeat_null, direction):
    margin = 16 * repeat_null + 32 * 2**-23 * max(normal, baseline, stale, 1e-20)
    return direction * (normal - baseline) > margin, not (direction * (stale - baseline) > margin), margin


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            page.route('https://blackout.test/', lambda r: r.fulfill(status=200, content_type='text/html', body=(ROOT / 'dist/Operation Blackout.html').read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            protocol = page.evaluate('''() => ({step:CORE.musicStepSeconds(),lookahead:MUSIC_LOOKAHEAD,sourceLifetime:.25,compressorRelease:.25,phases:[0,4,8,12,16,20,24,28]})''')
            print('PREREGISTERED', protocol, flush=True)
            failures = []
            for phase in PHASES:
                result = page.evaluate('''async ({phase}) => {
                  contextLost=true;
                  const saved={AC,masterGain,noiseBuf,music:{...MUSIC},random:Math.random,noise:musNoise,bass:musBass};
                  const rate=48000, duration=9, step=CORE.musicStepSeconds();
                  const calm={inCombat:false,aliveEnemies:0,nearestEnemy:100,health:100};
                  const combat={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};
                  async function run(mode,target,scale){
                    let seed=123456;Math.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
                    const c=new OfflineAudioContext(2,rate*duration,rate);AC=c;masterGain=null;noiseBuf=null;
                    Object.assign(MUSIC,{built:false,ctx:null,bus:null,duck:null,comp:null,verb:null,layers:null,intensity:0,running:false,step:0,nextT:0,warningDuckUntil:0});
                    startMusic();MUSIC.step=phase;
                    let events=[];
                    musBass=function(ctx,t,n,out){
                      events.push({t,n});
                      if(target && Math.abs(t-target.t)<1e-7 && n===target.n){const g=ctx.createGain();g.gain.value=scale;g.connect(out);return saved.bass(ctx,t,n,g);}
                      return saved.bass(ctx,t,n,out);
                    };
                    musNoise=function(ctx,t,dur,type,hz,q,peak,out){const old=Math.random;let x=(Math.round(t*rate)^Math.round(hz)^123456)>>>0;Math.random=()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};try{return saved.noise(ctx,t,dur,type,hz,q,peak,out);}finally{Math.random=old;}};
                    updateMusic(.04,calm);
                    const frames=new Set();for(let t=.04;t<8.96;t+=.04)frames.add(Math.round(t*rate/128)*128);
                    const forced=[2.96,5.96].map(t=>Math.round(t*rate/128)*128);forced.forEach(f=>frames.add(f));
                    const ordered=[...frames].sort((a,b)=>a-b),pauses=ordered.map(f=>c.suspend(f/rate)),rendering=c.startRendering();
                    for(let j=0;j<ordered.length;j++){
                      await pauses[j];updateMusic(.04,mode!=='calm'&&c.currentTime>=3&&(mode==='hold'||c.currentTime<6)?combat:calm);
                      if(mode==='stale'&&forced.includes(ordered[j])){const gains=CORE.musicLayerGains(MUSIC.intensity);while(MUSIC.nextT<c.currentTime+1.8){scheduleMusicStep(c,MUSIC.step,MUSIC.nextT,gains);MUSIC.nextT+=step;MUSIC.step++;}}
                      await c.resume();
                    }
                    const audio=await rendering;
                    if(!target)return {events};
                    const a=Math.round(target.t*rate),b=Math.min(rate*duration,Math.round((target.t+.5)*rate));
                    return {events:events.filter(e=>Math.abs(e.t-target.t)<1e-7&&e.n===target.n).length, audio:[audio.getChannelData(0).slice(a,b),audio.getChannelData(1).slice(a,b)]};
                  }
                  function power(a,b){let sum=0;for(let ch=0;ch<2;ch++)for(let i=0;i<a[ch].length;i++)sum+=(a[ch][i]-b[ch][i])**2;return sum/(2*a[0].length);}
                  try {
                    const normalScout=await run('normal',null,1),holdScout=await run('hold',null,1);
                    const targets=[normalScout.events.find(e=>e.t>=3+MUSIC_LOOKAHEAD),holdScout.events.find(e=>e.t>=6+MUSIC_LOOKAHEAD)];
                    const result=[];
                    for(let j=0;j<2;j++){
                      const target=targets[j];if(!target){result.push({error:'missing target'});continue;}
                      const data={};
                      for(const mode of ['normal',j===0?'calm':'hold','stale']){
                        const a=await run(mode,target,0),b=await run(mode,target,0),c=await run(mode,target,0),on=await run(mode,target,1);
                        data[mode]={power:power(on.audio,a.audio),nulls:[power(a.audio,b.audio),power(a.audio,c.audio),power(b.audio,c.audio)],events:on.events};
                      }
                      result.push({target,data});
                    }
                    return result;
                  }finally{AC=saved.AC;masterGain=saved.masterGain;noiseBuf=saved.noiseBuf;Object.assign(MUSIC,saved.music);Math.random=saved.random;musNoise=saved.noise;musBass=saved.bass;}
                }''', {'phase': phase})
                for idx, (label, reference, direction) in enumerate((('entry', 'calm', 1), ('exit', 'hold', -1))):
                    item = result[idx]
                    if 'error' in item:
                        print('phase', phase, label, item, flush=True)
                        failures.append((phase, label, 'missing target'))
                        continue
                    data = item['data']
                    repeat_null = max(v for mode in data.values() for v in mode['nulls'])
                    normal, stale, baseline = (data[k]['power'] for k in ('normal', 'stale', reference))
                    valid, rejected, margin = compare(normal, baseline, stale, repeat_null, direction)
                    if not (valid and rejected):
                        failures.append((phase, label, 'normal', valid, 'overqueue_rejected', rejected))
                    print('phase', phase, label, 'target', item['target'], 'window', [item['target']['t'], item['target']['t']+.5], 'data', data, 'margin', margin, 'normal_pass', valid, 'overqueue_rejected', rejected, flush=True)
            print('PROTOCOL RESULT', 'FAIL' if failures else 'PASS', failures, flush=True)
            if failures:
                raise SystemExit(1)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
