"""Offline, full-band production score/cue graph, not a listening test."""
import math
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def check_capture(reference, score, cue, mix_left, mix_right):
    if not reference or not all(len(x) == len(reference) for x in (score, cue, mix_left, mix_right)):
        raise ValueError('missing or misaligned capture')
    if any(not math.isfinite(v) for channel in (reference, score, cue, mix_left, mix_right) for v in channel):
        raise ValueError('nonfinite capture')
    ref_energy = sum(x*x for x in reference)
    cue_energy = sum(x*x for x in cue)
    if ref_energy / len(reference) < 1e-8 or cue_energy / len(cue) < 1e-10:
        raise ValueError('missing score or cue')
    error = sum((a-b)**2 for a,b in zip(reference, score)) / ref_energy
    peak = max(max(map(abs, mix_left)), max(map(abs, mix_right)))
    if error > 1e-8:
        raise ValueError(f'full-band score mismatch: {error}')
    if peak >= 1:
        raise ValueError(f'mix clipping: {peak}')
    return {'score_rms': math.sqrt(ref_energy/len(reference)), 'cue_rms': math.sqrt(cue_energy/len(cue)), 'score_error': error, 'mix_peak': peak}


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
              const saved={AC,masterGain,noiseBuf,music:{...MUSIC},random:Math.random};
              const rate=48000,c=new OfflineAudioContext(5,rate*6,rate);
              try {
                let seed=123456;Math.random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
                AC=c;masterGain=null;noiseBuf=null;
                Object.assign(MUSIC,{built:false,ctx:null,bus:null,duck:null,comp:null,verb:null,layers:null,intensity:1,running:false,step:0,nextT:0,warningDuckUntil:0});
                startMusic();masterGain.disconnect(c.destination);
                const merger=c.createChannelMerger(5);merger.connect(c.destination);
                const mono=(src,ch)=>{const g=c.createGain();g.channelCount=1;g.channelCountMode='explicit';src.connect(g);g.connect(merger,0,ch);};
                const reference=c.createDynamicsCompressor();
                for(const k of ['threshold','knee','ratio','attack','release'])reference[k].value=MUSIC.comp[k].value;
                MUSIC.bus.connect(reference);mono(reference,0);mono(MUSIC.comp,1);
                const cue=c.createGain();cue.connect(masterGain);mono(cue,2);
                const split=c.createChannelSplitter(2);masterGain.connect(split);split.connect(merger,0,3);split.connect(merger,1,4);
                const byFrame=new Map();
                const names=['step','step_crouch','step_tac','step_snow','step_snow_crouch','step_snow_tac','step_ice','step_ice_crouch','step_ice_tac','estep','estep_heavy','estep_snow','estep_snow_heavy','estep_ice','estep_ice_heavy'];
                for(let n=0;n<50;n++){const f=Math.round((1+n*.08)*rate/128)*128;if(!byFrame.has(f))byFrame.set(f,[]);byFrame.get(f).push(names[n%names.length]);if(n%3===0)byFrame.get(f).push('step');}
                const frames=new Set(byFrame.keys());for(let f=1920;f<rate*5.7;f+=1920)frames.add(f);
                const disconnect=Math.round(5.12*rate/128)*128, reconnect=Math.round(5.50*rate/128)*128;
                frames.add(disconnect);frames.add(reconnect);
                const ordered=[...frames].sort((a,b)=>a-b), pauses=ordered.map(f=>c.suspend(f/rate));
                const state={inCombat:true,aliveEnemies:6,nearestEnemy:2,health:35};
                updateMusic(.01,state);const rendering=c.startRendering();let events=0;
                for(let i=0;i<ordered.length;i++){
                  await pauses[i];updateMusic(.04,state);
                  if(ordered[i]===disconnect){MUSIC.duck.disconnect(MUSIC.comp);playSound('step',cue,true);}
                  if(ordered[i]===reconnect)MUSIC.duck.connect(MUSIC.comp);
                  for(const name of byFrame.get(ordered[i])||[]){playSound(name,cue,true);events++;}
                  await c.resume();
                }
                const audio=await rendering;
                const take=(start,end)=>Array.from({length:5},(_,i)=>Array.from(audio.getChannelData(i).slice(start,end)));
                return {rate,events,channels:take(rate*2,rate*4),disconnected:take(disconnect+512,disconnect+3072)};
              } finally {Math.random=saved.random;AC=saved.AC;masterGain=saved.masterGain;noiseBuf=saved.noiseBuf;Object.assign(MUSIC,saved.music);}
            }''')
            if result['events'] < 60:
                raise ValueError('insufficient dense cue events')
            channels = result['channels']
            print('full-band dense matched production graph:', check_capture(*channels), 'events', result['events'], flush=True)
            try:
                check_capture(*result['disconnected'])
            except ValueError as exc:
                if 'full-band score mismatch' not in str(exc):
                    raise ValueError(f'actual graph disconnect rejected for wrong reason: {exc}') from exc
                print('actual production score disconnect rejected:', exc, flush=True)
            else:
                raise ValueError('actual score disconnect unexpectedly passed')
            zeros = [0.0] * len(channels[0])
            controls = {'muted-score': [channels[0], zeros, channels[2], *channels[3:]],
                        'disconnected-reference': [zeros, channels[1], channels[2], *channels[3:]],
                        'muted-cue': [channels[0], channels[1], zeros, *channels[3:]],
                        'clipped-mix': [channels[0], channels[1], channels[2], channels[3], [1.1] * len(zeros)]}
            for name, sample in controls.items():
                try:
                    check_capture(*sample)
                except ValueError as exc:
                    print(name, 'rejected:', exc, flush=True)
                else:
                    raise ValueError(f'{name} control passed unexpectedly')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
