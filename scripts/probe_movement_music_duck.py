from pathlib import Path
from playwright.sync_api import sync_playwright

def main(build=Path(__file__).resolve().parents[1] / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':844,'height':390},is_mobile=True,has_touch=True)
        page.goto(build.as_uri(),wait_until='domcontentloaded')
        page.wait_for_function('assetsReady === true',timeout=60000)
        page.click('#btn-start');page.click('#gun-select .gun-card:not(.locked)');page.click('#gun-select .gun-card:not(.locked)')
        page.wait_for_function('started && MUSIC.running',timeout=60000)
        result=page.evaluate('''async () => {
          contextLost=true; const ctx=MUSIC.ctx; MUSIC.bus.disconnect(MUSIC.duck);
          const dc=ctx.createConstantSource(); dc.offset.value=0.1; dc.connect(MUSIC.duck); dc.start();
          const rec=ctx.createScriptProcessor(256,1,1),sink=ctx.createGain();sink.gain.value=0; MUSIC.duck.connect(rec);rec.connect(sink);sink.connect(ctx.destination);
          let chunks=[]; rec.onaudioprocess=e=>{const a=e.inputBuffer.getChannelData(0);let sum=0;for(const x of a) sum+=x;chunks.push({t:e.playbackTime,g:sum/a.length/0.1});};
          const wait=ms=>new Promise(r=>setTimeout(r,ms));
          async function trial(name,cue,interval){
            await wait(1300); chunks=[]; let sent=[]; const start=ctx.currentTime;
            let handle=cue?setInterval(()=>{sent.push(ctx.currentTime);playSound(cue,null,true)},interval):null;
            await wait(3500); if(handle)clearInterval(handle); await wait(400);
            let values=chunks.filter(x=>x.t>=start && x.t<start+3.5);
            return {name,sent,blocks:values.length,min:Math.min(...values.map(x=>x.g)),max:Math.max(...values.map(x=>x.g))};
          }
          let baseline=await trial('no cue',null,500),steps=await trial('step','step',500),warning=await trial('warning','low_ammo',1200);
          await wait(1300); chunks=[];
          const denseStart=ctx.currentTime, denseSent=[];
          const enemy=setInterval(()=>{denseSent.push(['estep',ctx.currentTime]);playSound('estep',null,true)},80);
          await wait(40);
          const playerSteps=setInterval(()=>{denseSent.push(['step',ctx.currentTime]);playSound('step',null,true)},240);
          await wait(3500);clearInterval(enemy);clearInterval(playerSteps);await wait(400);
          const denseBlocks=chunks.filter(x=>x.t>=denseStart+0.5 && x.t<denseStart+3.4);
          const dense={cues:denseSent.length,blocks:denseBlocks.length,min:Math.min(...denseBlocks.map(x=>x.g))};
          // Use rendered audio, not AudioParam.value (a main-thread snapshot),
          // to check attack and recovery even if the capture callback arrives late.
          function windowAt(start, from, to) {
            const gain=chunks.filter(x=>x.t>=start+from && x.t<start+to).map(x=>x.g);
            return {blocks:gain.length,min:Math.min(...gain),max:Math.max(...gain)};
          }
          async function envelope(cue, {before=false, after=[], steps=false}={}) {
            await wait(1300); chunks=[];
            if(before){ playSound('step',null,true); await wait(30); }
            const start=ctx.currentTime;
            playSound(cue,null,true);
            const sent=[];
            const timers=after.map(([name,ms])=>setTimeout(()=>{
              sent.push([name,ctx.currentTime-start]); playSound(name,null,true);
            },ms));
            const repeat=steps ? setInterval(()=>{sent.push(['estep',ctx.currentTime-start]);playSound('estep',null,true)},80) : null;
            try { await wait(1250); } finally {
              timers.forEach(clearTimeout);
              if(repeat) clearInterval(repeat);
            }
            return {sent, attack:windowAt(start,0.07,0.16), release:windowAt(start,0.3,0.5), recovered:windowAt(start,0.95,1.1)};
          }
          const ammoWithStep=await envelope('low_ammo',{after:[['step',40]]});
          const stepBeforeAmmo=await envelope('low_ammo',{before:true});
          const death=await envelope('player_down');
          const deathOverlap=await envelope('player_down',{after:[['low_ammo',160],['step',240]]});
          const whizz=await envelope('bullet_whiz',{steps:true});
          dc.disconnect(); await wait(300); let neg=chunks.slice(-20);
          return {baseline,steps,warning,dense,ammoWithStep,stepBeforeAmmo,death,deathOverlap,whizz,negative:neg};
        }''')
        for key, value in result.items():
            print(key, value, flush=True)
        # Cue-specific output bands at the end of attack. These are measured
        # envelopes, not the lower asymptotic targets (0.34, 0.12, 0.62).
        ammo_band, death_band, whizz_band = (0.34, 0.48), (0.12, 0.28), (0.62, 0.73)

        def envelope_ok(key, band):
            x = result[key]
            return (all(x[k]['blocks'] >= 8 for k in ('attack', 'release', 'recovered'))
                    and band[0] <= x['attack']['min'] <= band[1]
                    and x['release']['min'] > x['attack']['min'] + 0.1
                    and x['recovered']['min'] > 0.97)

        checks = [
            (all(result[k]['blocks'] > 100 for k in ('baseline','steps','warning')), 'insufficient blocks'),
            (len(result['steps']['sent']) >= 5 and len(result['warning']['sent']) >= 2, 'insufficient cues'),
            (result['baseline']['min'] > 0.99, 'baseline gain'),
            (bool(result['negative']) and all(abs(x['g']) < 0.001 for x in result['negative']), 'disconnect control'),
            # The user superseded footstep priority ducking: isolated and dense
            # footsteps must leave the music gain steady, not merely shallower.
            (result['steps']['min'] > 0.99, 'footsteps must not duck music'),
            (result['dense']['cues'] >= 45 and result['dense']['blocks'] > 400 and result['dense']['min'] > 0.99, 'dense footsteps must not duck music'),
            (ammo_band[0] <= result['warning']['min'] <= ammo_band[1], 'low-ammo duck'),
            (envelope_ok('ammoWithStep', ammo_band)
             and len(result['ammoWithStep']['sent']) == 1
             and 0 < result['ammoWithStep']['sent'][0][1] < 0.12,
             'step must not cancel active ammo duck'),
            (envelope_ok('stepBeforeAmmo', ammo_band), 'recent step must not prevent ammo duck'),
            (envelope_ok('death', death_band), 'death duck and recovery'),
            (envelope_ok('deathOverlap', death_band)
             and [cue for cue, _ in result['deathOverlap']['sent']] == ['low_ammo', 'step']
             and 0.12 < result['deathOverlap']['sent'][0][1] < 0.5
             and abs(result['deathOverlap']['release']['min'] - result['death']['release']['min']) < 0.05,
             'overlapping warning must not replace the death envelope'),
            (envelope_ok('whizz', whizz_band) and len(result['whizz']['sent']) >= 10, 'incoming fire ducks gently over enemy footsteps'),
        ]
        failures = [label for ok, label in checks if not ok]
        if failures:
            raise ValueError('Music duck probe failed: ' + '; '.join(failures))
        browser.close()


if __name__ == '__main__':
    main()
