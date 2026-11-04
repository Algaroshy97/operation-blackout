from pathlib import Path
from playwright.sync_api import sync_playwright

build=Path(__file__).resolve().parents[1] / 'dist/Operation Blackout.html'
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
        return {name,sent,blocks:values.length,min:Math.min(...values.map(x=>x.g)),max:Math.max(...values.map(x=>x.g)),below20:values.filter(x=>x.g<0.2).length,below50:values.filter(x=>x.g<0.5).length,raw:values};
      }
      let baseline=await trial('no cue',null,500),steps=await trial('step','step',500),warning=await trial('warning','low_ammo',1200);
      playSound('low_ammo',null,true); await wait(40); playSound('step',null,true); await wait(40); const overlap=MUSIC.duck.gain.value;
      dc.disconnect(); await wait(300); let neg=chunks.slice(-20);
      return {baseline,steps,warning,overlap,negative:neg};
    }''')
    for key in ('baseline','steps','warning'):
        x=result[key]; raw=x.pop('raw'); print(key,x,flush=True)
    print('negative',result['negative'],flush=True)
    assert result['baseline']['blocks'] > 100 and result['steps']['blocks'] > 100 and result['warning']['blocks'] > 100
    assert len(result['steps']['sent']) >= 5 and len(result['warning']['sent']) >= 2
    assert result['baseline']['min'] > 0.99 and result['baseline']['below20'] == 0
    assert result['negative'] and all(abs(x['g']) < 0.001 for x in result['negative'])
    assert result['steps']['below20'] / result['steps']['blocks'] < 0.10, 'frequent footstep ducking severely attenuates the music'
    assert result['warning']['min'] < 0.2, 'priority warnings must still duck'
    assert result['overlap'] < 0.2, f"footstep must not cancel warning duck: {result['overlap']}"
    browser.close()
