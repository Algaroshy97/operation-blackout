"""Focused real-browser music lifecycle probe against the supplied release build."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main(build=ROOT / 'dist/Operation Blackout.html'):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
        page.add_init_script("""(() => {
          const connect = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function (dest, ...args) {
            if (this.context instanceof (window.AudioContext || window.webkitAudioContext) && dest === this.context.destination) {
              const tap = this.context.createAnalyser();
              const recorder = this.context.createScriptProcessor(1024, 2, 2);
              window.outputSamples = [];
              recorder.onaudioprocess = event => {
                let sum = 0, peak = 0, count = 0;
                for (let ch = 0; ch < event.outputBuffer.numberOfChannels; ch++) {
                  const input = event.inputBuffer.getChannelData(ch), output = event.outputBuffer.getChannelData(ch);
                  output.set(input);
                  for (const x of input) { sum += x*x; peak = Math.max(peak, Math.abs(x)); count++; }
                }
                window.outputSamples.push({time: event.playbackTime, rms: Math.sqrt(sum/count), peak});
                if (window.outputSamples.length > 2000) window.outputSamples.shift();
              };
              connect.call(this, tap); connect.call(tap, recorder); connect.call(recorder, dest);
              window.musicAnalyser = tap;
              return dest;
            }
            return connect.call(this, dest, ...args);
          };
        })();""")
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto(Path(build).resolve().as_uri(), wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady === true', timeout=60000)
        page.click('#btn-start')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        page.wait_for_function('() => started && MUSIC.step > 0')
        assert page.evaluate('() => !!window.musicAnalyser && masterGain.context.destination === MUSIC.ctx.destination')
        page.wait_for_function('() => Array.isArray(window.outputSamples) && window.outputSamples.length > 0', timeout=30000)
        page.evaluate('() => { window.outputSamples.length = 0; }')
        page.wait_for_timeout(1500)
        audio = page.evaluate("""() => {
          return {state: MUSIC.ctx.state, rms: Math.max(0, ...window.outputSamples.map(x => x.rms)), blocks: window.outputSamples.length};
        }""")
        print('initial music graph capture:', audio)
        assert audio['state'] == 'running' and audio['rms'] > 0.015, audio
        page.evaluate('() => { masterGain.gain.value = 0; }')
        page.wait_for_timeout(350)
        silent = page.evaluate("""() => {
          const a = new Float32Array(window.musicAnalyser.fftSize);
          window.musicAnalyser.getFloatTimeDomainData(a);
          return Math.sqrt(a.reduce((n,x) => n + x*x, 0) / a.length);
        }""")
        print('zero master output capture:', silent)
        assert silent < 0.0001, ('capture must be downstream of master', silent)
        page.evaluate('() => { masterGain.gain.value = AUDIO.master; }')
        page.evaluate('() => MUSIC.comp.disconnect(masterGain)')
        page.wait_for_timeout(350)
        disconnected = page.evaluate("""() => {
          const a = new Float32Array(window.musicAnalyser.fftSize);
          window.musicAnalyser.getFloatTimeDomainData(a);
          return Math.sqrt(a.reduce((n,x) => n + x*x, 0) / a.length);
        }""")
        print('disconnected music output capture:', disconnected)
        assert disconnected < 0.0001, ('capture must detect broken music routing', disconnected)
        page.evaluate('() => MUSIC.comp.connect(masterGain)')
        mix = page.evaluate("""async () => {
          const previousLost = contextLost;
          contextLost = true;
          const combatState = {inCombat: true, aliveEnemies: 6, nearestEnemy: 2, health: 35};
          const timer = setInterval(() => updateMusic(0.05, combatState), 50);
          try {
          MUSIC.intensity = 1;
          updateMusic(0.01, combatState);
          await new Promise(r => setTimeout(r, 400));
          async function capture(name) {
            window.outputSamples.length = 0;
            const start = MUSIC.ctx.currentTime;
            if (name === 'enemy-step') playSound3D('estep', player.pos.x + 1, player.pos.y, player.pos.z, 18);
            else if (name) playSound(name, null, true);
            await new Promise(r => setTimeout(r, 70));
            const duck = MUSIC.duck ? MUSIC.duck.gain.value : 1;
            await new Promise(r => setTimeout(r, 1130));
            const cueBlocks = window.outputSamples.filter(x => x.time >= start && x.time < start + 0.12);
            return {blocks: window.outputSamples.length,
                    duck, recovered: MUSIC.duck ? MUSIC.duck.gain.value : 1,
                    cueBlocks: cueBlocks.length, cueRms: Math.max(0, ...cueBlocks.map(x => x.rms)),
                    start, end: MUSIC.ctx.currentTime,
                    first: window.outputSamples[0]?.time, last: window.outputSamples.at(-1)?.time,
                    rmsMax: Math.max(0, ...window.outputSamples.map(x => x.rms)),
                    peak: Math.max(0, ...window.outputSamples.map(x => x.peak))};
          }
          const intensity = MUSIC.intensity;
          const music = await capture(null), stepMix = await capture('step'), enemyStep = await capture('enemy-step'), warningMix = await capture('low_ammo'), click = await capture('click');
          MUSIC.comp.disconnect(masterGain);
          await new Promise(r => setTimeout(r, 600));
          const stepAlone = await capture('step'), warningAlone = await capture('low_ammo');
          MUSIC.comp.connect(masterGain);
          const buffers = ['step', 'low_ammo'].map(name => ({name, cached: !!_sndBuffers[name],
            peak: _sndBuffers[name] ? Math.max(..._sndBuffers[name].getChannelData(0).map(Math.abs)) : null}));
          return {intensity, music, stepMix, enemyStep, warningMix, click, stepAlone, warningAlone, buffers};
          } finally { clearInterval(timer); contextLost = previousLost; }
        }""")
        print('destination-path combat/cue blocks:', mix)
        assert mix['intensity'] > 0.5, mix
        assert all(mix[k]['blocks'] > 0 and mix[k]['rmsMax'] > 0 for k in ('music', 'stepMix', 'enemyStep', 'warningMix', 'stepAlone', 'warningAlone')), mix
        # Footsteps retain moderate priority without repeatedly nearly silencing music;
        # urgent warnings still trigger deep attenuation.
        assert 0.3 < mix['stepMix']['duck'] < 0.6 and 0.3 < mix['enemyStep']['duck'] < 0.6 and mix['warningMix']['duck'] < 0.2, mix
        assert all(mix[k]['cueBlocks'] and mix[k]['cueRms'] > 0 for k in ('stepMix', 'enemyStep', 'warningMix')), mix
        assert mix['stepMix']['recovered'] > 0.9 and mix['warningMix']['recovered'] > 0.9 and mix['click']['duck'] > 0.9, mix
        page.evaluate('pauseGame()')
        assert not page.evaluate('MUSIC.running'), 'pause must silence scheduled music'
        page.click('#btn-resume')
        assert page.evaluate('MUSIC.running'), 'resume must restore music'
        page.evaluate('victory()')
        assert not page.evaluate('MUSIC.running'), 'victory must stop music'
        page.click('#btn-endless')
        assert page.evaluate('MUSIC.running'), 'endless must restore music after victory'
        page.evaluate("setSetting('musicVolume', 0); pauseGame()")
        page.click('#btn-resume')
        assert not page.evaluate('MUSIC.running'), 'zero music volume must remain silent'
        page.evaluate("setSetting('musicVolume', 0.5)")
        assert page.evaluate('MUSIC.running'), 'raising music volume during play must restore music'
        page.evaluate("setSetting('muted', true); setSetting('musicVolume', 0)")
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady === true', timeout=60000)
        page.click('#btn-start')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        assert page.evaluate("getSetting('muted') && getSetting('musicVolume') === 0 && AUDIO.master === 0")
        page.evaluate("setSetting('muted', false)")
        page.wait_for_timeout(400)
        assert page.evaluate("getSetting('musicVolume') === 0 && MUSIC.bus.gain.value < 0.005")
        page.wait_for_function('() => MUSIC.step > 6', timeout=30000)
        page.evaluate("setSetting('musicVolume', 0.5)")
        page.wait_for_timeout(1500)
        restored = page.evaluate("""() => { const a = new Float32Array(window.musicAnalyser.fftSize); window.musicAnalyser.getFloatTimeDomainData(a); return Math.sqrt(a.reduce((n,x) => n+x*x, 0)/a.length); }""")
        assert restored > 0.01, ('music must become audible promptly after raising volume', restored)
        page.evaluate('killPlayer()')
        assert not page.evaluate('MUSIC.running'), 'terminal Survival death must stop music'
        page.reload(wait_until='domcontentloaded')
        page.wait_for_function('() => assetsReady === true', timeout=60000)
        page.click('#btn-start')
        page.click('#mode-btn-tdm')
        page.click('#gun-select .gun-card:not(.locked)')
        page.click('#gun-select .gun-card:not(.locked)')
        page.wait_for_function('() => started && MUSIC.running')
        page.evaluate('killPlayer()')
        assert page.evaluate('player.dead && MUSIC.running'), 'nonterminal death must retain score'
        page.evaluate('pauseGame()')
        page.click('#btn-resume')
        assert page.evaluate('!MUSIC.running'), 'dead paused player must not restart before respawn'
        page.evaluate('updateModeRespawns(4, openSpawnPoints(), enemies, colliders)')
        assert page.evaluate('!player.dead && MUSIC.running'), 'real respawn must restore score'
        assert not errors, errors
        browser.close()
    print('stage3 music pause/resume and endless lifecycle: passed')


if __name__ == '__main__':
    main()
