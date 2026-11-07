"""Actual-master event attribution with fixed, exploration-selected fixtures.

Uses the retained renderer unchanged except for event selection and the assertion:
compare one real bass or arpeggio source, not a shared layer's gain. Fixtures
were chosen from an earlier exploratory run, not preregistered. Output is not
evidence of audibility. Stale is deliberately scheduled 1.8 s in advance.
"""
from pathlib import Path

source = Path(__file__).with_name('probe_music_note_target.py').read_text()
changes = {
    'noise:musNoise,bass:musBass': 'noise:musNoise,bass:musBass,arp:musArp',
    '''musBass=function(ctx,t,n,out){
                      events.push({t,n});
                      if(target && Math.abs(t-target.t)<1e-7 && n===target.n){const g=ctx.createGain();g.gain.value=scale;g.connect(out);return saved.bass(ctx,t,n,g);}
                      return saved.bass(ctx,t,n,out);
                    };''':
    '''function wrap(kind, original){return function(ctx,t,n,out){
                      events.push({t,n,kind});
                      if(target && target.kind===kind && Math.abs(t-target.t)<1e-7 && n===target.n){const g=ctx.createGain();g.gain.value=scale;g.connect(out);return original(ctx,t,n,g);}
                      return original(ctx,t,n,out);
                    };}
                    musBass=wrap('bass',saved.bass);musArp=wrap('arp',saved.arp);''',
    'Math.abs(e.t-target.t)<1e-7&&e.n===target.n': 'Math.abs(e.t-target.t)<1e-7&&e.n===target.n&&e.kind===target.kind',
    'musBass=saved.bass;}': 'musBass=saved.bass;musArp=saved.arp;}',
    "const normalScout=await run('normal',null,1),holdScout=await run('hold',null,1);":
    "const normalScout=await run('normal',null,1),holdScout=await run('hold',null,1),staleScout=await run('stale',null,1);",
    "holdScout.events.find(e=>e.t>=6+MUSIC_LOOKAHEAD)":
    "({t:.08+50*step,n:({0:46,4:46,8:46,12:65,16:43,20:43,24:43,28:62})[phase],kind:(phase===12||phase===28)?'arp':'bass',owner:'stale'})",
    "normalScout.events.find(e=>e.t>=3+MUSIC_LOOKAHEAD)": "({t:.08+((phase%8===4)?26:27)*step,n:({0:38,4:50,8:34,12:34,16:34,20:46,24:34,28:34})[phase],kind:'bass'})",
    "valid, rejected, margin = compare(normal, baseline, stale, repeat_null, direction)":
    """margin = 16 * repeat_null + 32 * 2**-23 * max(normal, baseline, stale, 1e-20)
                    # Entry: production-only note must be present, stale absent.
                    # Exit: stale-only note must be absent from production and present in stale.
                    normal_present = idx == 0 or item['target']['owner'] == 'normal'
                    valid = normal > margin if normal_present else normal <= margin
                    rejected = stale <= margin if normal_present else stale > margin
                    if normal_present:
                        valid = valid and data['normal']['events'] == 1
                        rejected = rejected and data['stale']['events'] == 0
                    else:
                        valid = valid and data['normal']['events'] == 0
                        rejected = rejected and data['stale']['events'] == 1""",
    "PREREGISTERED": "BOUNDED EVENT ATTRIBUTION",
    "PROTOCOL RESULT": "EVENT ATTRIBUTION RESULT",
}
for old, new in changes.items():
    if source.count(old) != 1:
        raise RuntimeError(f'retained diagnostic expression changed: {old}')
    source = source.replace(old, new)
exec(compile(source, __file__, 'exec'))
