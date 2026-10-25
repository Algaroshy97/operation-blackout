"""Real-browser acceptance matrix; deterministic calls exercise production rules.

Each case uses a fresh page/storage, selects the map/mode through the actual menu,
and checks deployment, navigation, scoring, respawn/checkpoint, restart and reset.
This is software acceptance, not a physical-device/performance/audio certification.
"""

CASES = tuple((arena, mode) for arena in ('urban', 'snowy')
              for mode in ('survival', 'tdm', 'ffa', 'domination', 'gun-game'))


def probe_map_modes(browser, url):
    checks = []
    import sys
    for arena, mode_id in CASES:
        print(f'Acceptance matrix: {arena}/{mode_id}', file=sys.stderr, flush=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(url, wait_until='load')
            page.wait_for_function("typeof assetsReady !== 'undefined' && assetsReady", timeout=60000)
            page.evaluate("""() => {
                setSetting('muted', true); setSetting('musicVolume', 0);
                setSetting('masterVolume', 0);
                setSetting('ffaActorCount', 12); setSetting('gunGameActorCount', 12);
            }""")
            page.click('#btn-start')
            page.wait_for_selector('#gun-select', state='visible')
            page.click(f'#map-btn-{arena}')
            page.click(f'#mode-btn-{mode_id}')
            page.evaluate("pickGun(0); pickGun(1); paused = true;")
            result = page.evaluate("""async ({arena, modeId}) => {
                const out = {};
                const mode = getActiveMode();
                const map = getActiveMap();
                out.deploy = started && !gameEnded && map.id === arena && mode.id === modeId;
                const roster = mode.roster || [];
                const expectedActors = (modeId === 'ffa' || modeId === 'gun-game') ? 8 : 12;
                if (modeId !== 'survival') {
                    out.districtsOpen = map.districts.every(d => openDistricts.includes(d.key));
                    out.roster = roster.length === expectedActors && enemies.length === expectedActors - 1 &&
                        roster.filter(a => a.isPlayer).length === 1 &&
                        roster.every(a => a.health > 0 && !a.dead);
                    if (modeId === 'tdm' || modeId === 'domination') {
                        out.roster = out.roster && enemies.filter(a => a.team === 'friendly').length === 5 &&
                            enemies.filter(a => a.team === 'enemy').length === 6;
                    }
                }
                CORE.computeFlowField(navGrid, player.pos.x, player.pos.z);
                const points = openSpawnPoints();
                out.navigation = points.length > 0 && points.every(p =>
                    CORE.navDistanceAt(navGrid, p[0], p[1]) >= 0) && enemies.every(a =>
                    CORE.navDistanceAt(navGrid, a.pos.x, a.pos.z) >= 0);
                out.spawns = points.every(p => CORE.isSpawnValid(p[0], p[1], colliders, STEP_H_AI, 1.8));
                if (modeId === 'survival') {
                    startWave(1);
                    for (let i = 0; i < 100 && waveQueue > 0; i++) {
                        spawnTimer = 0; spawnFromQueue();
                    }
                    out.wave = waveActive && enemies.length > 0;
                    const victim = enemies.find(a => !a.dead);
                    if (victim) {
                        const before = kills;
                        victim.spawnProtectionT = 0;
                        damageEnemy(victim, 100000, victim.pos, false, false, 'AR', player);
                        out.scoring = victim.dead && kills === before + 1;
                    } else out.scoring = false;
                    const state = captureRunState();
                    state.wave = 2; state.score = 2468;
                    const district = map.districts[0];
                    state.openDistricts = district ? [district.key] : [];
                    saveCheckpoint(state);
                    const saved = loadCheckpoint();
                    setActiveMap(arena === 'urban' ? 'snowy' : 'urban', true);
                    resumeRun(); paused = true;
                    out.checkpoint = saved && saved.mapId === arena && getActiveMap().id === arena &&
                        getActiveMode().id === 'survival' && waveNum === 2 && score === 2468 &&
                        (!district || openDistricts.includes(district.key));
                    killPlayer(); paused = true;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    out.death = player.dead && getComputedStyle(document.getElementById('death-screen')).display !== 'none';
                    document.getElementById('btn-restart').click(); pickGun(0); pickGun(1); paused = true;
                    out.restart = !gameEnded && started && waveNum === 0 && score === 0 &&
                        getActiveMap().id === arena && enemies.length === 0 && modeRespawnQueue.length === 0;
                    document.getElementById('btn-quit').click();
                } else {
                    const victim = enemies.find(a => (modeId === 'tdm' || modeId === 'domination')
                        ? a.team !== player.team : true);
                    const before = player.kills || 0;
                    victim.spawnProtectionT = 0;
                    damageEnemy(victim, 100000, victim.pos, false, false, 'AR', player);
                    out.scoring = victim.dead && player.kills === before + 1;
                    if (modeId === 'tdm') out.scoring = out.scoring && mode.friendlyScore === 1;
                    if (modeId === 'gun-game') out.scoring = out.scoring && mode.tierOf(player) === 1;
                    if (modeId === 'domination') {
                        enemies.forEach((a, i) => a.pos.set(90 + i * 20, 0, 90));
                        const flag = mode.flags[0];
                        player.pos.set(flag.x, 1.7, flag.z);
                        for (let i = 0; i < 50; i++) mode.updateFlags(0.1);
                        paused = false; mode.update(1); paused = true;
                        out.objective = mode.flags.length === 3 && flag.owner === 'friendly' && mode.friendlyScore === 1;
                        CORE.computeFlowField(navGrid, player.pos.x, player.pos.z);
                        out.objectiveNavigation = mode.flags.every(f => CORE.navDistanceAt(navGrid, f.x, f.z) >= 0);
                    }
                    // Exercise the production death/respawn path, including clearing attribution.
                    killPlayer(victim); paused = true;
                    paused = false;
                    updateModeRespawns(10, openSpawnPoints(), enemies.filter(a => !a.dead), colliders);
                    paused = true;
                    out.respawn = !player.dead && player.health > 0 && !player.lastAttacker && !player.downedBy;
                    setScoreboardVisible(true);
                    const text = document.getElementById('match-scoreboard').textContent;
                    out.scoreboard = text.length > 30 && (modeId !== 'domination' || text.includes('FLAGS'));
                    setScoreboardVisible(false);
                    if (modeId === 'gun-game') {
                        mode.setTier(player, mode.tierCount - 1);
                        const finalVictim = enemies.find(a => !a.dead);
                        finalVictim.spawnProtectionT = 0;
                        damageEnemy(finalVictim, 100000, finalVictim.pos, false, false, 'melee', player);
                    } else mode.timeLeft = 0;
                    paused = false; mode.update(1 / 60); paused = true;
                    out.end = gameEnded && getComputedStyle(document.getElementById('match-end-screen')).display !== 'none';
                    document.getElementById('btn-match-restart').click(); paused = true;
                    out.restart = !gameEnded && started && getActiveMap().id === arena &&
                        getActiveMode().id === modeId && mode.roster.length === expectedActors &&
                        enemies.length === expectedActors - 1 && modeRespawnQueue.length === 0 &&
                        mode.roster.every(a => !a.kills && !a.deaths && !a.dead) &&
                        (modeId !== 'gun-game' || mode.roster.every(a => mode.tierOf(a) === 0)) &&
                        (modeId !== 'domination' || mode.flags.every(f => f.owner === 'neutral'));
                    document.getElementById('btn-match-quit').click();
                }
                out.reset = !started && !gameEnded && openDistricts.length === 0 && getActiveMode().id === 'survival' &&
                    getActiveMap().id === arena && enemies.length === 0 && modeRespawnQueue.length === 0 &&
                    getComputedStyle(document.getElementById('start-screen')).display !== 'none';
                return out;
            }""", {'arena': arena, 'modeId': mode_id})
            checks.extend((f'matrix-{arena}-{mode_id}-{name}', value is True)
                          for name, value in result.items())
            checks.append((f'matrix-{arena}-{mode_id}-no-page-errors', not errors))
        except Exception as error:
            raise RuntimeError(f'matrix-{arena}-{mode_id}: {error}') from error
        finally:
            page.close()
    return checks
