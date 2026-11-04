"""Deterministic real-score OfflineAudioContext scheduler stress probe."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        try:
            page = browser.new_page()
            page.route('https://blackout.test/', lambda r: r.fulfill(status=200, content_type='text/html', body=(ROOT / 'dist/Operation Blackout.html').read_bytes()))
            page.goto('https://blackout.test/', wait_until='domcontentloaded')
            page.wait_for_function('assetsReady === true', timeout=60000)
            result = page.evaluate('''async () => {
              contextLost=true;
              const saved={AC,masterGain,noiseBuf,music:{...MUSIC},schedule:scheduleMusicStep};
              const rate=48000, c=new OfflineAudioContext(2,rate*4,rate), calls=[];
              try {
                AC=c;masterGain=null;noiseBuf=null;
                Object.assign(MUSIC,{built:false,ctx:null,bus:null,duck:null,comp:null,verb:null,layers:null,intensity:1,running:false,step:0,nextT:0,warningDuckUntil:0});
                startMusic();
                scheduleMusicStep=function(ctx,n,t,gains){calls.push({n,t,now:ctx.currentTime});return saved.schedule(ctx,n,t,gains)};
                const state={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};
                updateMusic(.01,state);
                const frames=[];for(let t=.3;t<3.9;t+=.3)frames.push(Math.round(t*rate/128)*128);
                const pauses=frames.map(f=>c.suspend(f/rate));
                const rendering=c.startRendering();
                for(const pause of pauses){await pause;updateMusic(.3,state);await c.resume();}
                const audio=await rendering, data=audio.getChannelData(0);
                let sum=0,peak=0;for(const x of data){sum+=x*x;peak=Math.max(peak,Math.abs(x));}
                return {calls,step:CORE.musicStepSeconds(),rms:Math.sqrt(sum/data.length),peak};
              } finally {scheduleMusicStep=saved.schedule;AC=saved.AC;masterGain=saved.masterGain;noiseBuf=saved.noiseBuf;Object.assign(MUSIC,saved.music);}
            }''')
            calls = result['calls']
            gaps = [b['t']-a['t'] for a,b in zip(calls,calls[1:])]
            late = [s for s in calls if s['t'] < s['now'] - 0.001]
            print('production scheduler stress', result, flush=True)
            if len(calls) < 20 or result['rms'] < 0.001 or result['peak'] >= 1:
                raise ValueError('missing production audio or clipped output')
            if max(gaps) > result['step'] * 1.01 or late:
                raise ValueError(f'scheduled score gap or overdue note: max_gap={max(gaps)}, late={late}')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
