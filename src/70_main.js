// ============ GAME FLOW & MAIN LOOP ============
'use strict';
// A victory screen can transition into endless mode. Career stats are settled once
// for the finite run, then only the incremental endless kills are settled on death.
let settlementSnapshot = null;
let runPhase = 'active';
function markSettlement() {
  settlementSnapshot = { score: score, kills: kills, headshots: headshots, streaks: runStreaksEarned };
}
function settlementDelta() {
  const accounting = CORE.settlementAccounting(settlementSnapshot, {
    score: score, wave: waveNum, accuracy: shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0,
    kills: kills, headshots: headshots, streaks: runStreaksEarned
  });
  return Object.assign({}, accounting.rewards, {
    recordScore: accounting.records.score,
    recordWave: accounting.records.wave,
    recordAccuracy: accounting.records.accuracy
  });
}
// ---- Flow ----
function pauseGame() {
  // A charged grenade is a committed action: throw it rather than silently
  // discarding the charge with no feedback.
  if (typeof grenadeCharging !== 'undefined' && grenadeCharging && !player.dead) {
    const spd = grenadeChargeT <= GRENADE_TAP_THRESHOLD ? CFG.grenade.speed : getGrenadeSpeed();
    cancelGrenadeCharge();
    throwGrenade(spd);
  }
  paused = true;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  $id('pause-menu').style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
}
function resumeGame() {
  paused = false;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  $id('pause-menu').style.display = 'none';
  canvas.requestPointerLock();
}
function killPlayer(killer) {
  if (player.dead) return;
  player.dead = true;
  const activeMode = typeof getActiveMode === 'function' ? getActiveMode() : null;
  const sourceActor = killer || player.downedBy || player.lastAttacker || null;
  if (activeMode && typeof activeMode.onDeath === 'function') activeMode.onDeath(player, sourceActor);
  if (activeMode && typeof activeMode.onKill === 'function') activeMode.onKill(player, false, sourceActor, player.lastDamageType);
  // A second lethal hit while already down comes straight here, so the bleed-out
  // state has to be cleared on THIS path too — otherwise the "BLEEDING OUT" timer
  // stays on screen behind the death screen until the next deploy.
  if (typeof clearDowned === 'function') clearDowned();
  // Music stops only when the death is terminal for this run/match. A nonterminal
  // match death (TDM/FFA/Domination/Gun Game) queues a respawn, so silencing the
  // soundtrack there would leave the rest of the match silent.
  const deathEndsRun = !activeMode || activeMode.id === 'survival'
    || (typeof gameEnded !== 'undefined' && gameEnded)
    || (typeof activeMode.isOver === 'function' && activeMode.isOver());
  if (deathEndsRun) stopMusic();
  mouse1Down = false;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  playSound('death');
  if (!activeMode || activeMode.id === 'survival' || (activeMode && typeof activeMode.isOver === 'function' && activeMode.isOver())) {
    if (document.pointerLockElement) document.exitPointerLock();
  }
  // if death lands while paused (e.g. queued enemy bullet), drop the pause so REDEPLOY works
  paused = false;
  const pm = $id('pause-menu');
  if (pm) pm.style.display = 'none';
  updateHudHealth();
  if (typeof updateHudAmmo === 'function') updateHudAmmo();
  if (typeof updateHudStreaks === 'function') updateHudStreaks();
  if (typeof applyTouchInput === 'function') applyTouchInput();
  if (!activeMode || activeMode.id === 'survival') {
    const accuracy = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
    const hsRate = kills > 0 ? Math.round(headshots / kills * 100) : 0;
    // a lost run is not resumable
    clearCheckpoint();
    const delta = settlementDelta();
    const beat = recordRun({ score: delta.score, wave: delta.wave,
      accuracy: delta.accuracy, recordScore: delta.recordScore,
      recordWave: delta.recordWave, recordAccuracy: delta.recordAccuracy,
      kills: delta.kills,
      headshots: delta.headshots, streaks: delta.streaks,
      countRun: !settlementSnapshot, victory: false });
    $id('ds-stats').innerHTML =
      'Waves survived: <b>' + waveNum + '</b>' + (beat.wave ? ' <span class="xp">NEW BEST</span>' : '') +
      '<br>Score: <b>' + score + '</b>' + (beat.score ? ' <span class="xp">NEW BEST</span>' : '') +
      '<br>Kills: <b>' + kills + '</b> (' + headshots + ' headshots · ' + hsRate + '% HS)' +
      '<br>Accuracy: <b>' + accuracy + '%</b> (' + shotsHit + '/' + shotsFired + ')' +
      '<br><br><span style="font-size:13px;opacity:.8">' + (typeof statsSummaryHtml === 'function' ? statsSummaryHtml() : '') + '</span>';
    setTimeout(function () { if (player.dead) { const ds = $id('death-screen'); if (ds) ds.style.display = 'flex'; } }, 900);
  } else {
    const ds = $id('death-screen');
    if (ds) ds.style.display = 'none';
    if (typeof showCenterMsgThrottled === 'function') showCenterMsgThrottled('RESPAWNING IN 3s…');
  }
}
function victory() {
  if (gameEnded) return;
  gameEnded = true;
  runPhase = 'victory';
  stopMusic();
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  playSound('victory');
  if (document.pointerLockElement) document.exitPointerLock();
  const accuracy = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
  const hsRate = kills > 0 ? Math.round(headshots / kills * 100) : 0;
  const beat = recordRun({ score: score, wave: waveNum, accuracy: accuracy, kills: kills,
    headshots: headshots, streaks: runStreaksEarned, victory: true });
  markSettlement();
  saveCheckpoint(captureRunState());
  $id('vs-stats').innerHTML =
    'Final score: <b>' + score + '</b>' + (beat.score ? ' <span class="xp">NEW BEST</span>' : '') +
    '<br>Kills: <b>' + kills + '</b> (' + headshots + ' headshots · ' + hsRate + '% HS)' +
    '<br>Accuracy: <b>' + accuracy + '%</b> (' + shotsHit + '/' + shotsFired + ')' +
    '<br><br><span style="font-size:13px;opacity:.8">' + statsSummaryHtml() + '</span>';
  $id('victory-screen').style.display = 'flex';
}

function resetGame() {
  settlementSnapshot = null;
  runPhase = 'active';
  // never reset into a paused state
  paused = false;
  if (typeof document !== 'undefined') {
    if (!started && document.body) document.body.classList.remove('started');
    if (!started && document.pointerLockElement) document.exitPointerLock();
  }
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  suppression = 0;
  if (typeof MODES !== 'undefined' && MODES.tdm && Array.isArray(MODES.tdm.roster)) {
    for (let i = 0; i < MODES.tdm.roster.length; i++) {
      const act = MODES.tdm.roster[i];
      if (act && !act.isPlayer && act.parts && act.parts.group) {
        if (typeof scene !== 'undefined' && scene && scene.remove) scene.remove(act.parts.group);
        if (typeof disposeEnemyGeometry === 'function') disposeEnemyGeometry(act);
      }
    }
    MODES.tdm.roster.length = 0;
  }
  if (typeof clearModeRespawns === 'function') clearModeRespawns();
  if (typeof player !== 'undefined' && player) {
    player.lastAttacker = null;
    player.downedBy = null;
  }
  // remove all enemies + pickups + grenades
  for (let i = enemies.length - 1; i >= 0; i--) { scene.remove(enemies[i].parts.group); disposeEnemyGeometry(enemies[i]); }
  enemies.length = 0;
  for (let i = pickups.length - 1; i >= 0; i--) scene.remove(pickups[i].m);
  pickups.length = 0;
  for (let i = liveGrenades.length - 1; i >= 0; i--) {
    if (typeof releaseLiveGrenadeRecord === 'function') {
      releaseLiveGrenadeRecord(liveGrenades[i]);
    } else {
      if (liveGrenades[i].ring) {
        scene.remove(liveGrenades[i].ring);
        if (typeof releaseBlastRing === 'function') releaseBlastRing(liveGrenades[i].ring);
      }
      scene.remove(liveGrenades[i].m);
    }
  }
  liveGrenades.length = 0;
  // clear vfx
  if (typeof vfx !== 'undefined' && vfx) {
    if (Array.isArray(vfx.tracers)) {
      for (let i = vfx.tracers.length - 1; i >= 0; i--) {
        const t = vfx.tracers[i];
        scene.remove(t.m);
        t.m.visible = false;
        if (typeof tracerPool !== 'undefined' && tracerPool) tracerPool.push(t.m);
        if (typeof releaseTracerRecord === 'function') releaseTracerRecord(t);
      }
      vfx.tracers.length = 0;
    }
    if (Array.isArray(vfx.impacts)) {
      for (let i = vfx.impacts.length - 1; i >= 0; i--) {
        const im = vfx.impacts[i];
        scene.remove(im.m);
        im.m.visible = false;
        if (im.isBulletImpact || (im.m.userData && im.m.userData.isBulletImpact)) {
          if (typeof impactPool !== 'undefined' && impactPool) impactPool.push(im.m);
        } else if (im.isBlastFlash || (im.m.userData && im.m.userData.blastFlash)) {
          releaseBlastFlash(im.m);
        } else {
          if (im.m.geometry) im.m.geometry.dispose();
          if (im.m.material) im.m.material.dispose();
        }
        if (typeof releaseImpactRecord === 'function') releaseImpactRecord(im);
      }
      vfx.impacts.length = 0;
    }
    if (Array.isArray(vfx.blood)) {
      for (let i = vfx.blood.length - 1; i >= 0; i--) {
        const b = vfx.blood[i];
        scene.remove(b.m);
        b.m.visible = false;
        if (b.isSpark && typeof sparkPool !== 'undefined' && sparkPool) sparkPool.push(b.m);
        else if (b.isBlood && typeof bloodPool !== 'undefined' && bloodPool) bloodPool.push(b.m);
        else if (b.isDust && typeof dustPool !== 'undefined' && dustPool) dustPool.push(b.m);
        if (typeof releaseParticleRecord === 'function') releaseParticleRecord(b);
      }
      vfx.blood.length = 0;
    }
  }
  if (typeof clearCasings === 'function') {
    clearCasings();
  } else if (typeof casings !== 'undefined' && Array.isArray(casings)) {
    for (let i = casings.length - 1; i >= 0; i--) {
      const c = casings[i];
      scene.remove(c.m);
      c.m.visible = false;
      if (typeof casingPool !== 'undefined' && casingPool) casingPool.push(c.m);
    }
    casings.length = 0;
  }
  if (typeof grenades !== 'undefined' && grenades) {
    grenades.count = (typeof CFG !== 'undefined' && CFG.grenade && CFG.grenade.count) || 2;
    grenades.cd = 0;
  }
  // v41: bullet holes never persist into a new run
  if (typeof clearDecals === 'function') clearDecals();
  if (typeof clearParticles === 'function') clearParticles();
  if (typeof clearBloodPools === 'function') clearBloodPools();
  if (typeof clearInputState === 'function') clearInputState();
  player.pos.set(0, CFG.player.height, 24);
  player.vel.set(0, 0, 0);
  player.yaw = Math.PI; player.pitch = 0;
  player.health = CFG.player.health; player.armor = CFG.player.armor;
  player.downed = false;
  player.dead = false; player.crouching = false; player.sprinting = false;
  player.sliding = false; player.slideT = 0; player.onGround = false;
  player.spawnProtectionT = 0;
  player.coyoteT = 0; player.jumpBufT = 0;
  player.stamina = CFG.player.maxStamina; player.exhausted = false;
  player.recoilP = 0; player.recoilY = 0;
  player.mantleT = 0; player.tacT = 0; lastSprintTap = -99;
  if (typeof resetStations === 'function') resetStations();
  if (typeof clearDowned === 'function') clearDowned();
  if (typeof resetEquipment === 'function') resetEquipment();
  if (typeof resetStreaks === 'function') resetStreaks();
  if (typeof waveSpecial !== 'undefined') waveSpecial = null;
  if (typeof applySpecialLighting === 'function') applySpecialLighting(null);
  if (typeof resetDistricts === 'function') resetDistricts();
  if (typeof clearObjective === 'function') clearObjective();
  if (typeof resetRagdolls === 'function') resetRagdolls();
  player.airSpeedY = 0; player.landStunT = 0; player.heartbeatT = 0;
  if (typeof updateHudPlates === 'function') updateHudPlates();
  if (typeof updateHudPerks === 'function') updateHudPerks();
  if (typeof recoilShot !== 'undefined') recoilShot = 0;
  if (typeof lastShotT !== 'undefined') lastShotT = -99;
  if (typeof bloom !== 'undefined') bloom = 0;
  if (typeof meleeT !== 'undefined') meleeT = 0;
  if (typeof meleeSwing !== 'undefined') meleeSwing = 0;
  if (typeof credits !== 'undefined') credits = 0;
  if (typeof powerUntil !== 'undefined' && powerUntil) { powerUntil.double = -99; powerUntil.instakill = -99; }
  if (typeof hud !== 'undefined' && hud && hud.credits) hud.credits.textContent = '0';
  // invalidate anything the previous run scheduled
  if (typeof runId !== 'undefined') runId++;
  if (typeof waveNum !== 'undefined') waveNum = 0;
  if (typeof score !== 'undefined') score = 0;
  if (typeof kills !== 'undefined') kills = 0;
  if (typeof headshots !== 'undefined') headshots = 0;
  if (typeof shotsFired !== 'undefined') shotsFired = 0;
  if (typeof shotsHit !== 'undefined') shotsHit = 0;
  if (typeof steadyT !== 'undefined') steadyT = typeof STEADY_MAX !== 'undefined' ? STEADY_MAX : 5;
  if (typeof steadyActive !== 'undefined') steadyActive = false;
  if (typeof _wasSteadyActive !== 'undefined') _wasSteadyActive = false;
  if (typeof adsAmount !== 'undefined') adsAmount = 0;
  if (typeof wasScoped !== 'undefined') wasScoped = false;
  if (typeof shotKick !== 'undefined') shotKick = 0;
  if (typeof slideFov !== 'undefined') slideFov = 0;
  if (typeof _lastMobilityState !== 'undefined') _lastMobilityState = null;
  if (typeof _hudHealthState !== 'undefined') _hudHealthState.hp = -1;
  if (typeof _grenadeChargeHudState !== 'undefined') { _grenadeChargeHudState.visible = null; _grenadeChargeHudState.pct = -1; _grenadeChargeHudState.speed = -1; }
  if (typeof _lastChOp !== 'undefined') { _lastChOp = -1; _lastChGap = -1; }
  if (typeof _slideVigOpacity !== 'undefined') _slideVigOpacity = 0;
  if (typeof _lastSlideVigWritten !== 'undefined') _lastSlideVigWritten = -1;
  if (typeof _slideOvEl === 'undefined') _slideOvEl = $id('slide-vignette');
  if (_slideOvEl) { _slideOvEl.style.opacity = '0'; _slideOvEl.style.boxShadow = 'none'; }
  if (typeof _scopeOvState !== 'undefined') { _scopeOvState.active = null; _scopeOvState.isSniper = null; }
  if (typeof _lastSx !== 'undefined') { _lastSx = null; _lastSy = null; }
  if (typeof _scopeOvEl !== 'undefined' && _scopeOvEl) { _scopeOvEl.style.setProperty('--sx', '0px'); _scopeOvEl.style.setProperty('--sy', '0px'); }
  if (typeof _steadyIndState !== 'undefined') { _steadyIndState.visible = null; _steadyIndState.steadyActive = null; _steadyIndState.label = null; }
  if (typeof _lastTouchUseState !== 'undefined' && _lastTouchUseState) _lastTouchUseState.nearStation = null;
  if (typeof _touchJumpCache !== 'undefined' && _touchJumpCache) _touchJumpCache.jumpState = null;
  if (typeof _touchAdsCache !== 'undefined' && _touchAdsCache) _touchAdsCache.adsState = null;
  if (typeof _touchSlideCache !== 'undefined' && _touchSlideCache) _touchSlideCache.slideState = null;
  if (typeof _touchMeleeCache !== 'undefined' && _touchMeleeCache) _touchMeleeCache.meleeState = null;
  if (typeof _touchPlateCache !== 'undefined' && _touchPlateCache) _touchPlateCache.plateState = null;
  if (typeof _touchFireCache !== 'undefined' && _touchFireCache) _touchFireCache.fireState = null;
  if (typeof _touchReloadCache !== 'undefined' && _touchReloadCache) _touchReloadCache.reloadState = null;
  if (typeof _touchNadeCache !== 'undefined' && _touchNadeCache) _touchNadeCache.eqState = null;
  if (typeof _touchTacCache !== 'undefined' && _touchTacCache) _touchTacCache.eqState = null;
  if (typeof _touchSwapCache !== 'undefined' && _touchSwapCache) _touchSwapCache.swapState = null;
  if (typeof _touchStreakCache !== 'undefined' && _touchStreakCache) _touchStreakCache.streakState = null;
  if (typeof resetObjectiveHudCache === 'function') resetObjectiveHudCache();
  if (typeof waveQueue !== 'undefined') waveQueue = 0;
  if (typeof waveActive !== 'undefined') waveActive = false;
  if (typeof gameEnded !== 'undefined') gameEnded = false;
  if (typeof betweenWaveT !== 'undefined') betweenWaveT = (typeof CFG !== 'undefined' && CFG.wave && CFG.wave.startDelay) || 3;
  if (typeof killStreak !== 'undefined') killStreak = 0;
  // multi-kill streak state
  if (typeof lastKillT !== 'undefined') lastKillT = -99;
  if (typeof hudRedrawT !== 'undefined') hudRedrawT = 1;
  if (typeof lastHudYaw !== 'undefined') lastHudYaw = player.yaw;
  // force immediate HUD redraw on new run
  if (typeof hudFlickT !== 'undefined') hudFlickT = -9;
  if (typeof invalidateMinimapBlocks === 'function') invalidateMinimapBlocks();
  if (typeof _lastDrawnCompassYaw !== 'undefined') _lastDrawnCompassYaw = null;
  if (typeof curWeapon !== 'undefined') curWeapon = 0;
  if (typeof fireClockT !== 'undefined') fireClockT = 0;
  if (typeof initWeapons === 'function') initWeapons();
  if (typeof gunSwitchT !== 'undefined') gunSwitchT = 1;
  if (typeof buildViewmodel === 'function') buildViewmodel();
  if (typeof updateHudHealth === 'function') updateHudHealth();
  if (typeof updateHudAmmo === 'function') updateHudAmmo();
  if (typeof hud !== 'undefined' && hud) {
    if (hud.scoreVal) hud.scoreVal.textContent = '0';
    if (hud.killfeed) hud.killfeed.innerHTML = '';
    if (hud.waveBanner) {
      if (typeof hud.waveBanner._t !== 'undefined') clearTimeout(hud.waveBanner._t);
      // cleared/ready banners stay up; never persist into menus
      if (hud.waveBanner.style) hud.waveBanner.style.opacity = 0;
    }
  }
  const activeMode = typeof getActiveMode === 'function' ? getActiveMode() : null;
  if (activeMode && typeof activeMode.setup === 'function') activeMode.setup();
}

// ---- Settings panel ---------------------------------------------------------
// Built from CORE.SETTINGS_SCHEMA so a new setting needs one schema entry, not a
// schema entry plus a hand-written row plus a hand-written validator.
// ---- Gunsmith ----------------------------------------------------------------
// Which weapon the screen is currently editing. Per-screen state, not per-run.
let gunsmithWeapon = 0;

function openGunsmith() {
  $id('start-screen').style.display = 'none';
  $id('gunsmith-screen').style.display = 'flex';
  buildGunsmith();
}
function closeGunsmith() {
  $id('gunsmith-screen').style.display = 'none';
  $id('start-screen').style.display = 'flex';
  refreshMenuStats();
}

function buildGunsmith() {
  const rank = playerRank();
  const wrap = $id('gs-weapons');
  wrap.innerHTML = '';
  CFG.weapons.forEach(function (w, i) {
    if (w.sidearm) return;
    const b = document.createElement('button');
    const unlocked = CORE.weaponUnlocked(i, rank);
    b.textContent = w.name.toUpperCase() + (unlocked ? '' : ' · RANK ' + CORE.weaponUnlockRank(i));
    b.className = i === gunsmithWeapon ? 'on' : '';
    b.disabled = !unlocked;
    if (unlocked) b.addEventListener('click', function () { gunsmithWeapon = i; buildGunsmith(); });
    wrap.appendChild(b);
  });
  if (!CORE.weaponUnlocked(gunsmithWeapon, rank)) {
    gunsmithWeapon = 0;
  }
  const slots = $id('gs-slots');
  slots.innerHTML = '';
  const loadout = getLoadout(gunsmithWeapon);
  CORE.ATTACH_SLOTS.forEach(function (slot) {
    const box = document.createElement('div');
    box.className = 'gs-slot';
    const title = document.createElement('b');
    title.textContent = CORE.ATTACH_SLOT_NAME[slot];
    box.appendChild(title);
    // "None" is a real option, not an absence: an empty slot is often the right call
    // once every attachment is a trade.
    box.appendChild(gunsmithOption(slot, null, loadout[slot], rank));
    CORE.attachmentsForSlot(slot).forEach(function (a) {
      box.appendChild(gunsmithOption(slot, a, loadout[slot], rank));
    });
    slots.appendChild(box);
  });
}

function gunsmithOption(slot, a, current, rank) {
  const btn = document.createElement('button');
  btn.className = 'gs-opt' + ((a ? a.key : null) === (current || null) ? ' on' : '');
  if (!a) {
    btn.innerHTML = 'NONE<i>No attachment</i>';
    btn.addEventListener('click', function () { setAttachment(gunsmithWeapon, slot, null); buildGunsmith(); });
    return btn;
  }
  const unlocked = CORE.attachmentUnlocked(a.key, rank);
  const d = CORE.attachmentDelta(a);
  // Show the trade, not just the name: an attachment nobody can read the cost of is
  // a coin flip.
  const pros = d.up.map(function (x) { return '<span class="up">+' + x.pct + '% ' + x.field + '</span>'; });
  const cons = d.down.map(function (x) { return '<span class="down">-' + x.pct + '% ' + x.field + '</span>'; });
  btn.innerHTML = a.name + (unlocked ? '' : ' · RANK ' + a.rank) +
    '<i>' + a.blurb + '</i><i>' + pros.concat(cons).join(' &nbsp;') + '</i>';
  btn.disabled = !unlocked;
  if (unlocked) {
    btn.addEventListener('click', function () { setAttachment(gunsmithWeapon, slot, a.key); buildGunsmith(); });
  }
  return btn;
}

let settingsReturnTo = 'menu';
function buildSettingsUI() {
  const list = $id('settings-list');
  list.innerHTML = '';
  for (const key in CORE.SETTINGS_SCHEMA) {
    if ((key === 'gyroAim' || key === 'gyroSensitivity') && !IS_TOUCH) continue;
    const spec = CORE.SETTINGS_SCHEMA[key];
    const row = document.createElement('div');
    row.className = 'set-row';
    const id = 'set-' + key;
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = spec.label;
    row.appendChild(label);

    const wrap = document.createElement('div');
    if (spec.type === 'number') {
      const input = document.createElement('input');
      input.type = 'range'; input.id = id;
      input.min = spec.min; input.max = spec.max; input.step = spec.step;
      input.value = getSetting(key);
      const val = document.createElement('span');
      val.className = 'set-val';
      const fmt = function (v) { return key === 'masterVolume' ? Math.round(v * 100) + '%' : (spec.step < 1 ? (+v).toFixed(2) : Math.round(v)); };
      val.textContent = fmt(input.value);
      input.addEventListener('input', function () { setSetting(key, input.value); val.textContent = fmt(input.value); });
      wrap.appendChild(val); wrap.appendChild(input);
    } else if (spec.type === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox'; input.id = id;
      input.checked = !!getSetting(key);
      input.addEventListener('change', function () { setSetting(key, input.checked); });
      wrap.appendChild(input);
    } else {
      const sel = document.createElement('select');
      sel.id = id;
      spec.values.forEach(function (v) {
        const o = document.createElement('option');
        o.value = v; o.textContent = v.toUpperCase();
        sel.appendChild(o);
      });
      sel.value = getSetting(key);
      sel.addEventListener('change', function () { setSetting(key, sel.value); });
      wrap.appendChild(sel);
    }
    row.appendChild(wrap);
    if (spec.help) {
      const help = document.createElement('p');
      help.className = 'set-help'; help.id = id + '-help'; help.textContent = spec.help;
      wrap.firstElementChild.setAttribute('aria-describedby', help.id);
      row.appendChild(help);
    }
    list.appendChild(row);
  }
  if (typeof openTouchLayoutEditor === 'function' && IS_TOUCH) {
    const row = document.createElement('div');
    row.className = 'set-row set-layout-action';
    row.innerHTML = '<label>Button positions and sizes</label><button type="button" id="btn-edit-touch-layout">EDIT ON SCREEN</button>';
    row.querySelector('button').addEventListener('click', openTouchLayoutEditor);
    list.appendChild(row);
  }
}
function openSettings(from) {
  settingsReturnTo = from || 'menu';
  buildSettingsUI();
  $id('settings-screen').style.display = 'flex';
}
function closeSettings() {
  $id('settings-screen').style.display = 'none';
  if (settingsReturnTo === 'pause') $id('pause-menu').style.display = 'flex';
}
function refreshMenuStats() {
  const el = $id('menu-stats');
  if (el) el.innerHTML = (typeof rankBarHtml === 'function' ? rankBarHtml() : '') + (typeof statsSummaryHtml === 'function' ? statsSummaryHtml() : '');
  const ch = $id('challenge-list');
  if (ch) ch.innerHTML = typeof challengesHtml === 'function' ? challengesHtml() : '';
}

// gun select UI
// Two-step deploy: primary, then secondary. The secondary used to be forced to
// (primary + 1) % 4 with no say in it, which made the SWAP key a coin toss the
// player never called.
let pickingSlot = 0;
let pendingSecondary = -1;
function buildModePickerRow() {
  const row = $id('mode-row');
  if (!row) return;
  row.innerHTML = '';
  const availableModes = [
    { id: 'survival', name: 'SURVIVAL', blurb: 'Wave defense' },
    { id: 'tdm', name: 'TEAM DEATHMATCH', blurb: '6v6 match' },
    { id: 'ffa', name: 'FREE-FOR-ALL', blurb: '8 actors, 30 kills' },
    { id: 'domination', name: 'DOMINATION', blurb: '3 flags to 200' },
    { id: 'gun-game', name: 'GUN GAME', blurb: '20-tier ladder' }
  ];
  const savedMode = (typeof getSetting === 'function') ? getSetting('gameMode') : null;
  const validSaved = (typeof isKnownModeId === 'function' && isKnownModeId(savedMode)) ? savedMode : 'survival';
  if ((typeof started === 'undefined' || !started || (typeof gameEnded !== 'undefined' && gameEnded)) && typeof activeModeId !== 'undefined' && activeModeId !== validSaved) {
    if (typeof setActiveMode === 'function') setActiveMode(validSaved);
    else activeModeId = validSaved;
  }
  const curMode = (typeof activeModeId !== 'undefined') ? activeModeId : validSaved;
  availableModes.forEach(function (m) {
    const b = document.createElement('div');
    b.className = 'diff-btn mode-btn' + (m.id === curMode ? ' on' : '');
    b.id = 'mode-btn-' + m.id;
    b.innerHTML = m.name + '<small>' + m.blurb + '</small>';
    enableMenuKeyboard(b);
    b.addEventListener('click', function () {
      setActiveMode(m.id);
      if (typeof setSetting === 'function') setSetting('gameMode', m.id);
      buildModePickerRow();
      buildDifficultyRow();
      buildTdmSettingsRow();
      const isMatch = (m.id !== 'survival');
      $id('diff-row').style.display = isMatch ? 'none' : 'flex';
      const tr = $id('tdm-settings-row');
      if (tr) tr.style.display = isMatch ? 'flex' : 'none';
      playSound('click');
    });
    row.appendChild(b);
  });
}

function buildTdmSettingsRow() {
  const row = $id('tdm-settings-row');
  if (!row) return;
  const modeId = (typeof activeModeId !== 'undefined') ? activeModeId : 'survival';
  const isMatch = (typeof isMatchMode === 'function') ? isMatchMode(MODES[modeId]) : (modeId !== 'survival');
  if (!isMatch) {
    row.style.display = 'none';
    const diffRowHidden = $id('diff-row');
    if (diffRowHidden) diffRowHidden.style.display = 'flex';
    return;
  }
  row.style.display = 'flex';
  row.innerHTML = '';
  // The difficulty row only means something for the Survival run; keep the menu
  // consistent no matter who triggered this rebuild.
  const diffRow = $id('diff-row');
  if (diffRow) diffRow.style.display = 'none';
  if (modeId !== 'tdm') {
    // One labelled group of choices per match mode, built from the same schema keys
    // the mode reads at setup time, so the menu and the match can never disagree.
    const groupLabel = function (label, marginLeft) {
      const g = document.createElement('div');
      g.style.display = 'flex';
      g.style.gap = '6px';
      g.style.alignItems = 'center';
      if (marginLeft) g.style.marginLeft = '16px';
      const l = document.createElement('span');
      l.style.fontSize = '12px';
      l.style.letterSpacing = '1px';
      l.style.color = '#ffdf8a';
      l.textContent = label;
      g.appendChild(l);
      return g;
    };
    const choices = function (group, prefix, values, current, fmt, onPick) {
      values.forEach(function (v) {
        const b = document.createElement('div');
        b.className = 'diff-btn' + (v === current ? ' on' : '');
        b.style.padding = '6px 12px';
        b.id = prefix + v;
        b.textContent = fmt ? fmt(v) : String(v);
        enableMenuKeyboard(b);
        b.addEventListener('click', function () {
          onPick(v);
          buildTdmSettingsRow();
          playSound('click');
        });
        group.appendChild(b);
      });
    };
    const setting = function (key, fallback, min) {
      if (typeof getSetting !== 'function') return fallback;
      const v = getSetting(key);
      return (typeof v === 'number' && isFinite(v) && v >= min) ? v : fallback;
    };
    if (modeId === 'ffa') {
      const curScore = setting('ffaScoreLimit', 30, 2);
      const scoreGroup = groupLabel('SCORE:');
      choices(scoreGroup, 'ffa-score-', [30, 15, 5, 2], curScore, null, function (v) {
        if (MODES.ffa) MODES.ffa.targetScore = v;
        if (typeof setSetting === 'function') setSetting('ffaScoreLimit', v);
      });
      row.appendChild(scoreGroup);
      const curActors = setting('ffaActorCount', CORE.FREE_FOR_ALL_MAX_ACTORS, 2);
      const actorGroup = groupLabel('ACTORS:', true);
      choices(actorGroup, 'ffa-actors-', [8, 6, 4, 2], curActors, null, function (v) {
        if (MODES.ffa) MODES.ffa.actors = v;
        if (typeof setSetting === 'function') setSetting('ffaActorCount', v);
      });
      row.appendChild(actorGroup);
      return;
    }
    if (modeId === 'domination') {
      const curScore = setting('dominationScoreLimit', 200, 50);
      const scoreGroup = groupLabel('SCORE:');
      choices(scoreGroup, 'domination-score-', [200, 150, 100, 50], curScore, null, function (v) {
        if (MODES.domination) MODES.domination.targetScore = v;
        if (typeof setSetting === 'function') setSetting('dominationScoreLimit', v);
      });
      row.appendChild(scoreGroup);
      return;
    }
    const curActors = setting('gunGameActorCount', CORE.FREE_FOR_ALL_MAX_ACTORS, 2);
    const actorGroup = groupLabel('ACTORS:');
    choices(actorGroup, 'gg-actors-', [8, 6, 4, 2], curActors, null, function (v) {
      if (MODES['gun-game']) MODES['gun-game'].actors = v;
      if (typeof setSetting === 'function') setSetting('gunGameActorCount', v);
    });
    row.appendChild(actorGroup);
    return;
  }
  const curScore = (typeof getSetting === 'function' ? getSetting('tdmScoreLimit') : null) || (MODES.tdm ? MODES.tdm.targetScore : 75) || 75;
  const scoreGroup = document.createElement('div');
  scoreGroup.style.display = 'flex';
  scoreGroup.style.gap = '6px';
  scoreGroup.style.alignItems = 'center';
  const scoreLabel = document.createElement('span');
  scoreLabel.style.fontSize = '12px';
  scoreLabel.style.letterSpacing = '1px';
  scoreLabel.style.color = '#ffdf8a';
  scoreLabel.textContent = 'SCORE:';
  scoreGroup.appendChild(scoreLabel);
  [75, 50, 25, 10, 2].forEach(function (lim) {
    const b = document.createElement('div');
    b.className = 'diff-btn' + (lim === curScore ? ' on' : '');
    b.style.padding = '6px 12px';
    b.id = 'tdm-score-' + lim;
    b.textContent = String(lim);
    enableMenuKeyboard(b);
    b.addEventListener('click', function () {
      if (MODES.tdm) MODES.tdm.targetScore = lim;
      if (typeof setSetting === 'function') setSetting('tdmScoreLimit', lim);
      buildTdmSettingsRow();
      playSound('click');
    });
    scoreGroup.appendChild(b);
  });
  row.appendChild(scoreGroup);

  const curTeam = (typeof getSetting === 'function' ? getSetting('tdmTeamSize') : null) || (MODES.tdm ? MODES.tdm.teamSize : 6) || 6;
  const teamGroup = document.createElement('div');
  teamGroup.style.display = 'flex';
  teamGroup.style.gap = '6px';
  teamGroup.style.alignItems = 'center';
  teamGroup.style.marginLeft = '16px';
  const teamLabel = document.createElement('span');
  teamLabel.style.fontSize = '12px';
  teamLabel.style.letterSpacing = '1px';
  teamLabel.style.color = '#ffdf8a';
  teamLabel.textContent = 'TEAM:';
  teamGroup.appendChild(teamLabel);
  [6, 4, 2].forEach(function (sz) {
    const b = document.createElement('div');
    b.className = 'diff-btn' + (sz === curTeam ? ' on' : '');
    b.style.padding = '6px 12px';
    b.id = 'tdm-team-' + sz;
    b.textContent = sz + 'v' + sz;
    enableMenuKeyboard(b);
    b.addEventListener('click', function () {
      if (MODES.tdm) MODES.tdm.teamSize = sz;
      if (typeof setSetting === 'function') setSetting('tdmTeamSize', sz);
      buildTdmSettingsRow();
      playSound('click');
    });
    teamGroup.appendChild(b);
  });
  row.appendChild(teamGroup);
}

function buildGunSelect(slot) {
  pickingSlot = slot || 0;
  if (pickingSlot === 0) {
    pendingSecondary = -1;
    buildModePickerRow();
    buildDifficultyRow();
    buildTdmSettingsRow();
    const isTdm = (typeof activeModeId !== 'undefined' && activeModeId === 'tdm');
    $id('diff-row').style.display = isTdm ? 'none' : 'flex';
    if ($id('tdm-settings-row')) $id('tdm-settings-row').style.display = isTdm ? 'flex' : 'none';
    if ($id('mode-row')) $id('mode-row').style.display = 'flex';
  } else {
    $id('diff-row').style.display = 'none';
    if ($id('tdm-settings-row')) $id('tdm-settings-row').style.display = 'none';
    if ($id('mode-row')) $id('mode-row').style.display = 'none';
  }
  document.querySelector('#gun-select h2').textContent =
    pickingSlot === 0 ? 'SELECT PRIMARY' : 'SELECT SECONDARY';
  const wrap = $id('gun-cards');
  wrap.innerHTML = '';
  const rank = playerRank();
  CFG.weapons.forEach(function (w, i) {
    // already carrying it
    if (pickingSlot === 1 && i === weaponsOwned[0]) return;
    // always carried
    if (w.sidearm) return;
    const unlocked = CORE.weaponUnlocked(i, rank);
    const card = document.createElement('div');
    card.className = 'gun-card' + (unlocked ? '' : ' locked');
    // A locked card is shown rather than hidden: knowing what is coming is most of
    // what a progression system is for.
    if (unlocked) enableMenuKeyboard(card);
    const scoped = w.type === 'BR' || w.type === 'SR';
    card.innerHTML = '<div class="gc-name">' + w.name.toUpperCase() + '</div>' +
      '<div class="gc-type">' + (({ SG: 'SHOTGUN', LMG: 'LIGHT MACHINE GUN', PST: 'PISTOL' })[w.cls] || ({ AR: 'ASSAULT RIFLE', SMG: 'SMG', BR: 'BATTLE RIFLE', SR: 'SNIPER RIFLE' })[w.type]) + '</div>' +
      '<div class="gc-stats">Damage <b>' + w.dmg + (w.pellets > 1 ? '×' + w.pellets : '') + '</b> · RPM <b>' + w.rpm + '</b><br>Mag <b>' + w.mag + '</b> · ' + (scoped ? 'Scoped ADS' : 'Iron sights') + '<br>' + (w.auto ? 'Full auto' : 'Semi auto') + ' · ' + (scoped ? 'High' : w.type === 'AR' ? 'Mid' : 'Low') + ' recoil</div>' +
      (unlocked ? '' : '<div class="gc-lock">LOCKED · RANK ' + CORE.weaponUnlockRank(i) + '</div>');
    if (unlocked) card.addEventListener('click', function () { pickGun(i); });
    wrap.appendChild(card);
  });
  if (pickingSlot === 1) {
    const first = wrap.querySelector('.gun-card:not(.locked)');
    if (first) first.focus({ preventScroll: true });
  }
}
function buildDifficultyRow() {
  const row = $id('diff-row');
  row.innerHTML = '';
  Object.keys(CORE.DIFFICULTIES).forEach(function (key) {
    const d = CORE.DIFFICULTIES[key];
    const b = document.createElement('div');
    b.className = 'diff-btn' + (key === runDifficulty ? ' on' : '');
    b.innerHTML = d.label + '<small>' + d.blurb + '</small>';
    enableMenuKeyboard(b);
    b.addEventListener('click', function () {
      runDifficulty = key;
      buildDifficultyRow();
      playSound('click');
    });
    row.appendChild(b);
  });
}

function pickGun(i) {
  if (pickingSlot === 0) {
    weaponsOwned[0] = i;
    weaponsOwned[1] = -1;
    // now choose what gets unlocked on the first wave clear
    buildGunSelect(1);
    return;
  }
  pendingSecondary = i;
  weaponsOwned[1] = i;
  endlessMode = false;
  // starting fresh invalidates any saved run
  clearCheckpoint();
  $id('gun-select').style.display = 'none';
  // always start unpaused — fixes frozen redeploy
  paused = false;
  $id('pause-menu').style.display = 'none';
  startGame();
}
// Deployment is blocked until every embedded GLB has parsed (or reported a
// controlled fallback failure). Prevents the async-parse race where the arena
// rendered before desktop cover props existed.
let assetsReady = false;
function setDeployReady(ready) {
  const deploy = $id('btn-start');
  deploy.classList.toggle('disabled', !ready);
  deploy.textContent = ready ? 'DEPLOY' : 'LOADING ASSETS…';
}
function startGame() {
  if (!assetsReady) return;
  if (IS_TOUCH) {
    const root = document.documentElement;
    const fullscreen = root.requestFullscreen || root.webkitRequestFullscreen;
    const request = fullscreen ? fullscreen.call(root) : Promise.resolve();
    Promise.resolve(request).catch(function () {}).then(function () {
      const orientation = window.screen && window.screen.orientation;
      if (orientation && typeof orientation.lock === 'function') {
        try { const lock = orientation.lock('landscape'); if (lock && lock.catch) lock.catch(function () {}); }
        catch (e) { /* Orientation lock is not available in every browser. */ }
      }
    });
  }
  started = true;
  // belt & suspenders
  paused = false;
  resetGame();
  const activeMode = typeof getActiveMode === 'function' ? getActiveMode() : null;
  if (!activeMode || activeMode.id === 'survival') {
    // "GET READY" + COMBAT IN n countdown until wave 1
    showWaveBanner(0);
    startMusic();
  } else {
    updateMatchHud(activeMode);
  }
  $id('start-screen').style.display = 'none';
  document.body.classList.add('started');
  startMusic();
  canvas.requestPointerLock();
}

// Resume a saved run. Only ever written between waves, so the restored state is
// always a clean wave boundary — no half-resolved combat to reconstruct.
function resumeRun() {
  const cp = loadCheckpoint();
  if (!cp || !assetsReady) return;
  if (typeof setActiveMode === 'function') setActiveMode('survival');
  else if (typeof activeModeId !== 'undefined') activeModeId = 'survival';
  if (typeof setSetting === 'function') setSetting('gameMode', 'survival');
  const mapToRestore = (typeof CORE !== 'undefined' && CORE.sanitizeMapId) ? CORE.sanitizeMapId(cp.mapId) : (cp.mapId || 'urban');
  if (typeof setActiveMap === 'function') setActiveMap(mapToRestore);
  started = true; paused = false;
  resetGame();
  runDifficulty = cp.difficulty;
  endlessMode = cp.endless;
  settlementSnapshot = cp.settlementSnapshot || null;
  runPhase = cp.runPhase || (cp.endless ? 'endless' : 'active');
  const resumeState = CORE.resumeCheckpointState(runPhase);
  weaponsOwned[0] = cp.weapons[0].gi;
  weaponsOwned[1] = cp.weapons[1] ? cp.weapons[1].gi : -1;
  initWeapons();
  for (let i = 0; i < Math.min(weaponsOwned.length, cp.weapons.length); i++) {
    if (!wState[i] || !cp.weapons[i] || cp.weapons[i].gi !== weaponsOwned[i]) continue;
    wState[i].up = cp.weapons[i].up ? Object.assign({}, cp.weapons[i].up) : null;
    refreshWeaponStats(i);
    const eff = wState[i].eff || CFG.weapons[weaponsOwned[i]];
    wState[i].ammo = Math.min(eff.mag, cp.weapons[i].ammo);
    wState[i].reserve = Math.min(eff.reserveMax, cp.weapons[i].reserve);
  }
  openDistricts = [];
  for (let i = 0; i < (cp.openDistricts || []).length; i++) openDistrict(cp.openDistricts[i]);
  equippedLethal = cp.equipment.lethal;
  equippedTactical = cp.equipment.tactical;
  tacticalCount = cp.equipment.tacticalCount;
  fieldCharge = cp.equipment.fieldCharge;
  streakBank.length = 0; cp.equipment.streakBank.forEach(function (k) { streakBank.push(k); });
  streakKills = cp.streakKills || 0;
  runStreaksEarned = cp.runStreaksEarned || 0;
  curWeapon = 0; buildViewmodel();
  score = cp.score; kills = cp.kills; headshots = cp.headshots;
  shotsFired = cp.shotsFired; shotsHit = cp.shotsHit;
  player.health = cp.health; player.armor = cp.armor;
  player.spawnProtectionT = cp.spawnProtectionT || 0;
  if (typeof clearModeRespawns === 'function') clearModeRespawns();
  credits = cp.credits || 0;
  if (hud.credits) hud.credits.textContent = credits;
  perks = (cp.perks || []).slice();
  plates = cp.plates || 0;
  updateHudPerks(); updateHudPlates();
  grenades.count = cp.grenades;
  // next startWave() call is wave+1
  waveNum = cp.wave;
  waveActive = false; betweenWaveT = CFG.wave.startDelay;
  hud.waveNum.textContent = waveNum;
  hud.scoreVal.textContent = score;
  updateHudHealth(); updateHudAmmo();
  $id('start-screen').style.display = 'none';
  document.body.classList.add('started');
  if (resumeState.showVictory) {
    // A victory checkpoint is already settled. Do not enter the next wave or call
    // victory() again; let the player explicitly choose endless continuation.
    gameEnded = resumeState.gameEnded;
    stopMusic();
    $id('victory-screen').style.display = 'flex';
    return;
  }
  showWaveBanner(0);
  startMusic();
  canvas.requestPointerLock();
}

function refreshResumeButton() {
  const cp = typeof loadCheckpoint === 'function' ? loadCheckpoint() : null;
  const btn = $id('btn-resume-run');
  const note = $id('save-note');
  if (cp) {
    btn.style.display = '';
    btn.textContent = 'RESUME — WAVE ' + (cp.wave + 1);
    if (note) note.textContent = CORE.difficulty(cp.difficulty).label + (cp.endless ? ' · ENDLESS' : '') +
      ' · score ' + cp.score;
  } else {
    btn.style.display = 'none';
    if (note) note.textContent = '';
  }
}

// Keyboard-operable menu controls, including dynamically created weapon cards.
function enableMenuKeyboard(el) {
  el.tabIndex = 0; el.setAttribute("role", "button");
  el.addEventListener("keydown", function(e) {
    if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); e.stopPropagation(); el.click(); }
  });
}
document.querySelectorAll(".menu-btn").forEach(enableMenuKeyboard);
// UI click feedback for every menu button and weapon card. Delegated, so it also
// catches the dynamically built gun cards (and their inner stat divs) plus
// keyboard Enter/Space activation, which dispatches a real el.click().
document.addEventListener('click', function (e) {
  const t = e.target && e.target.closest ? e.target.closest('.menu-btn, .gun-card') : null;
  if (t) playSound('click');
});
// Fullscreen is opt-in because browsers only allow it from a user gesture. The
// menu button is especially useful on phones, where browser chrome consumes a
// large part of the already-short landscape viewport. Keep WebKit fallbacks for
// older iOS Safari builds and reflect exits triggered by the OS/browser controls.
function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function fullscreenSupported() {
  return !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
}
function updateFullscreenButtons() {
  const label = fullscreenElement() ? 'EXIT FULL SCREEN' : 'FULL SCREEN';
  ['btn-fullscreen-menu', 'btn-fullscreen-pause'].forEach(function (id) {
    const el = $id(id);
    if (el) el.textContent = label;
  });
}
function toggleFullscreen() {
  if (!fullscreenSupported()) {
    ['btn-fullscreen-menu', 'btn-fullscreen-pause'].forEach(function (id) {
      const el = $id(id);
      if (el) { el.textContent = 'FULL SCREEN UNAVAILABLE'; setTimeout(updateFullscreenButtons, 1800); }
    });
    return;
  }
  const root = document.documentElement;
  try {
    const result = fullscreenElement()
      ? (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen())
      : (root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen());
    if (result && typeof result.catch === 'function') result.catch(function () { updateFullscreenButtons(); });
  } catch (e) { updateFullscreenButtons(); }
}
document.addEventListener('fullscreenchange', updateFullscreenButtons);
document.addEventListener('webkitfullscreenchange', updateFullscreenButtons);
updateFullscreenButtons();
// buttons
$id('btn-start').addEventListener('click', function () {
  if (!assetsReady) return;
  buildGunSelect(0);
  // was left visible, bleeding through
  $id('start-screen').style.display = 'none';
  $id('gun-select').style.display = 'flex';
  $id('gun-select').scrollTop = 0;
  $id('gun-cards').firstElementChild.focus({ preventScroll: true });
  // unlock audio on user gesture
  audioCtx();
  // Render every one-shot to a buffer while the player is still choosing a weapon,
  // so the first trigger of each is already a single BufferSource rather than a
  // freshly built node graph.
  prerenderSounds();
});
$id('btn-settings').addEventListener('click', function () { openSettings('menu'); audioCtx(); });
$id('btn-gunsmith').addEventListener('click', function () { openGunsmith(); audioCtx(); });
$id('btn-fullscreen-menu').addEventListener('click', toggleFullscreen);
$id('btn-fullscreen-pause').addEventListener('click', toggleFullscreen);
$id('btn-gunsmith-back').addEventListener('click', closeGunsmith);
$id('btn-settings-pause').addEventListener('click', function () {
  $id('pause-menu').style.display = 'none';
  openSettings('pause');
});
$id('btn-settings-back').addEventListener('click', closeSettings);
$id('btn-resume-run').addEventListener('click', function () { audioCtx(); prerenderSounds(); resumeRun(); });
$id('btn-endless').addEventListener('click', function () {
  // Victory is no longer a dead end: keep the run going with escalating waves.
  $id('victory-screen').style.display = 'none';
  endlessMode = true;
  runPhase = 'endless';
  gameEnded = false;
  saveCheckpoint(captureRunState());
  waveActive = false;
  betweenWaveT = CFG.wave.startDelay;
  paused = false;
  showWaveBanner(0);
  canvas.requestPointerLock();
});
$id('btn-settings-reset').addEventListener('click', function () { resetSettings(); buildSettingsUI(); });
$id('btn-resume').addEventListener('click', resumeGame);
$id('btn-quit').addEventListener('click', function () {
  paused = false; started = false;
  stopMusic();
  if (document.body) document.body.classList.remove('started');
  if (document.pointerLockElement) document.exitPointerLock();
  $id('pause-menu').style.display = 'none';
  $id('start-screen').style.display = 'flex';
  refreshMenuStats();
  refreshResumeButton();
  resetGame();
});
$id('btn-restart').addEventListener('click', function () {
  $id('death-screen').style.display = 'none';
  buildGunSelect(0);
  $id('gun-select').style.display = 'flex';
  $id('gun-select').scrollTop = 0;
  $id('gun-cards').firstElementChild.focus({ preventScroll: true });
});
// Esc backs out of the gun select / settings instead of trapping the player there.
addEventListener('keydown', function (e) {
  if (e.code !== 'Escape') return;
  if ($id('settings-screen').style.display === 'flex') { closeSettings(); return; }
  if ($id('gun-select').style.display === 'flex' && !started) {
    $id('gun-select').style.display = 'none';
    $id('start-screen').style.display = 'flex';
  }
});
$id('btn-death-quit').addEventListener('click', function () {
  $id('death-screen').style.display = 'none';
  if (document.body) document.body.classList.remove('started');
  if (document.pointerLockElement) document.exitPointerLock();
  $id('start-screen').style.display = 'flex';
  refreshMenuStats();
  refreshResumeButton();
  resetGame(); started = false;
});
$id('btn-v-restart').addEventListener('click', function () {
  $id('victory-screen').style.display = 'none';
  buildGunSelect(0);
  $id('gun-select').style.display = 'flex';
  $id('gun-select').scrollTop = 0;
  $id('gun-cards').firstElementChild.focus({ preventScroll: true });
});
$id('btn-v-quit').addEventListener('click', function () {
  $id('victory-screen').style.display = 'none';
  if (document.body) document.body.classList.remove('started');
  if (document.pointerLockElement) document.exitPointerLock();
  $id('start-screen').style.display = 'flex';
  refreshMenuStats();
  resetGame(); started = false;
});

function showMatchEndScreen(mode) {
  if (typeof document === 'undefined') return;
  const es = $id('match-end-screen');
  if (!es) return;
  if (document.pointerLockElement) document.exitPointerLock();
  stopMusic();
  // Every match mode describes its own result; TDM keeps its original score-line
  // rendering, so its end screen is byte-for-byte what it has always been.
  const view = (mode && typeof mode.outcome === 'function') ? mode.outcome() : null;
  const fScore = (mode && typeof mode.friendlyScore === 'number') ? mode.friendlyScore : 0;
  const eScore = (mode && typeof mode.enemyScore === 'number') ? mode.enemyScore : 0;
  const title = view ? view.title : (fScore > eScore ? 'VICTORY' : (fScore === eScore ? 'DRAW' : 'DEFEAT'));
  const won = title === 'VICTORY';
  const draw = title === 'DRAW';
  playSound(won ? 'victory' : 'death');
  const titleEl = $id('match-end-title');
  if (titleEl) {
    titleEl.textContent = title;
    titleEl.style.color = draw ? '#ffd24a' : (won ? '#7ee08a' : '#ff4030');
  }
  const scoreEl = $id('match-end-scores');
  if (scoreEl) {
    if (view) {
      scoreEl.innerHTML = '<span style="color:#38b6ff">' + view.leftScore + '</span> — <span style="color:#ff4030">' + view.rightScore + '</span>';
    } else {
      scoreEl.innerHTML = '<span style="color:#38b6ff">' + fScore + '</span> — <span style="color:#ff4030">' + eScore + '</span>';
    }
  }
  const statsEl = $id('match-end-stats');
  if (statsEl) {
    const pk = (typeof player !== 'undefined' && player) ? (player.kills || 0) : 0;
    const pd = (typeof player !== 'undefined' && player) ? (player.deaths || 0) : 0;
    const kd = pd > 0 ? (pk / pd).toFixed(2) : pk;
    const detail = (view && view.note) ? view.note : ('Target score: <b>' + (mode.targetScore || 75) + '</b>');
    statsEl.innerHTML = 'Your K/D: <b>' + pk + ' / ' + pd + '</b> (' + kd + ' ratio)<br>' + detail;
  }
  es.style.display = 'flex';
}

function restartMatch() {
  const es = $id('match-end-screen');
  if (es) es.style.display = 'none';
  const ds = $id('death-screen');
  if (ds) ds.style.display = 'none';
  paused = false;
  gameEnded = false;
  started = true;
  resetGame();
  const activeMode = typeof getActiveMode === 'function' ? getActiveMode() : null;
  if (activeMode && activeMode.id !== 'survival') {
    if (typeof updateMatchHud === 'function') updateMatchHud(activeMode);
  }
  const audioDisabled = typeof getSetting === 'function' && (getSetting('muted') || getSetting('musicVolume') <= 0 || getSetting('masterVolume') <= 0);
  if (!audioDisabled && typeof startMusic === 'function') {
    startMusic();
  }
  if (typeof canvas !== 'undefined' && canvas && typeof canvas.requestPointerLock === 'function') {
    try { canvas.requestPointerLock(); } catch (e) {}
  }
}

function quitMatchToMenu() {
  const es = $id('match-end-screen');
  if (es) es.style.display = 'none';
  const mh = $id('match-hud');
  if (mh) mh.style.display = 'none';
  const sb = $id('match-scoreboard');
  if (sb) sb.style.display = 'none';
  const ds = $id('death-screen');
  if (ds) ds.style.display = 'none';
  paused = false;
  gameEnded = false;
  started = false;
  if (typeof clearAllMatchRosters === 'function') clearAllMatchRosters();
  if (document.body) document.body.classList.remove('started');
  if (document.pointerLockElement) document.exitPointerLock();
  setActiveMode('survival');
  resetGame();
  $id('start-screen').style.display = 'flex';
  refreshResumeButton();
  refreshMenuStats();
}

const btnMR = $id('btn-match-restart');
if (btnMR) btnMR.addEventListener('click', restartMatch);
const btnMQ = $id('btn-match-quit');
if (btnMQ) btnMQ.addEventListener('click', quitMatchToMenu);

function updateScoreboard() {
  if (typeof document === 'undefined') return;
  const sbEl = $id('match-scoreboard');
  if (!sbEl) return;
  const activeMode = typeof getActiveMode === 'function' ? getActiveMode() : null;
  if (!activeMode || typeof activeMode.scoreboard !== 'function') return;
  const data = activeMode.scoreboard();
  if (data.mode === 'ffa' || data.mode === 'gun-game') {
    const gunGame = (data.mode === 'gun-game');
    let html = '<div style="background:rgba(20,35,50,0.92);border:1px solid #38b6ff;border-radius:6px;padding:12px;min-width:300px;box-shadow:0 0 15px rgba(0,0,0,.8)">';
    html += '<div style="font-weight:900;font-size:18px;color:#38b6ff;margin-bottom:8px">' + (gunGame ? 'GUN GAME — LADDER' : 'FREE-FOR-ALL — KILLS') + '</div>';
    html += '<table style="width:100%;font-size:13px;text-align:left"><tr style="opacity:.6;border-bottom:1px solid rgba(255,255,255,.2)"><th>PLAYER</th>' + (gunGame ? '<th style="text-align:right">TIER</th>' : '') + '<th style="text-align:right">K</th><th style="text-align:right">D</th></tr>';
    const members = data.members || [];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      html += '<tr style="' + (m.isPlayer ? 'font-weight:bold;color:#ffdf8a;' : '') + '"><td>' + m.name + '</td>'
        + (gunGame ? '<td style="text-align:right">' + ((m.tier || 0) + 1) + '/' + (data.tierCount || 20) + '</td>' : '')
        + '<td style="text-align:right">' + m.kills + '</td><td style="text-align:right">' + m.deaths + '</td></tr>';
    }
    html += '</table></div>';
    sbEl.innerHTML = html;
    return;
  }
  if (data.mode === 'domination') {
    const flags = data.flags || [];
    let flagHtml = '';
    for (let i = 0; i < flags.length; i++) {
      const owner = flags[i].owner;
      const color = (owner === 'friendly') ? '#38b6ff' : ((owner === 'enemy') ? '#ff4030' : '#cfd8e3');
      flagHtml += '<span style="color:' + color + ';font-weight:900">' + flags[i].name + '</span> ';
    }
    const sideTable = function (title, color, team) {
      let h = '<div style="flex:1;background:rgba(20,35,50,0.92);border:1px solid ' + color + ';border-radius:6px;padding:12px;box-shadow:0 0 15px rgba(0,0,0,.8)">';
      h += '<div style="font-weight:900;font-size:18px;color:' + color + ';display:flex;justify-content:space-between;margin-bottom:8px"><span>' + title + '</span><span>' + ((team && team.score) || 0) + '</span></div>';
      h += '<table style="width:100%;font-size:13px;text-align:left"><tr style="opacity:.6;border-bottom:1px solid rgba(255,255,255,.2)"><th>PLAYER</th><th style="text-align:right">K</th><th style="text-align:right">D</th></tr>';
      const members = (team && team.members) || [];
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        h += '<tr style="' + (m.isPlayer ? 'font-weight:bold;color:#ffdf8a;' : '') + '"><td>' + m.name + '</td><td style="text-align:right">' + m.kills + '</td><td style="text-align:right">' + m.deaths + '</td></tr>';
      }
      h += '</table></div>';
      return h;
    };
    let html = '<div style="display:flex;gap:30px;justify-content:center;width:90%;max-width:700px">';
    html += sideTable('FRIENDLY', '#38b6ff', data.friendlyTeam);
    html += '<div style="align-self:center;text-align:center;font-size:13px">FLAGS<br>' + flagHtml + '</div>';
    html += sideTable('ENEMY', '#ff4030', data.enemyTeam);
    html += '</div>';
    sbEl.innerHTML = html;
    return;
  }
  if (data.mode === 'tdm') {
    let html = '<div style="display:flex;gap:30px;justify-content:center;width:90%;max-width:700px">';
    html += '<div style="flex:1;background:rgba(20,35,50,0.92);border:1px solid #38b6ff;border-radius:6px;padding:12px;box-shadow:0 0 15px rgba(0,0,0,.8)">';
    html += '<div style="font-weight:900;font-size:18px;color:#38b6ff;display:flex;justify-content:space-between;margin-bottom:8px"><span>ALLIES</span><span>' + (data.friendlyScore || 0) + '</span></div>';
    html += '<table style="width:100%;font-size:13px;text-align:left"><tr style="opacity:.6;border-bottom:1px solid rgba(255,255,255,.2)"><th>PLAYER</th><th style="text-align:right">K</th><th style="text-align:right">D</th></tr>';
    const fMembers = (data.friendlyTeam && data.friendlyTeam.members) || [];
    for (let i = 0; i < fMembers.length; i++) {
      const m = fMembers[i];
      const isYou = m.isPlayer;
      html += '<tr style="' + (isYou ? 'font-weight:bold;color:#ffdf8a;' : '') + '"><td>' + m.name + '</td><td style="text-align:right">' + m.kills + '</td><td style="text-align:right">' + m.deaths + '</td></tr>';
    }
    html += '</table></div>';
    html += '<div style="flex:1;background:rgba(50,20,20,0.92);border:1px solid #ff4030;border-radius:6px;padding:12px;box-shadow:0 0 15px rgba(0,0,0,.8)">';
    html += '<div style="font-weight:900;font-size:18px;color:#ff4030;display:flex;justify-content:space-between;margin-bottom:8px"><span>HOSTILES</span><span>' + (data.enemyScore || 0) + '</span></div>';
    html += '<table style="width:100%;font-size:13px;text-align:left"><tr style="opacity:.6;border-bottom:1px solid rgba(255,255,255,.2)"><th>PLAYER</th><th style="text-align:right">K</th><th style="text-align:right">D</th></tr>';
    const eMembers = (data.enemyTeam && data.enemyTeam.members) || [];
    for (let i = 0; i < eMembers.length; i++) {
      const m = eMembers[i];
      html += '<tr><td>' + m.name + '</td><td style="text-align:right">' + m.kills + '</td><td style="text-align:right">' + m.deaths + '</td></tr>';
    }
    html += '</table></div></div>';
    sbEl.innerHTML = html;
  }
}

let scoreboardOpen = false;
function setScoreboardVisible(visible) {
  scoreboardOpen = !!visible;
  const sbEl = (typeof $id === 'function') ? $id('match-scoreboard') : null;
  if (!sbEl) return;
  if (scoreboardOpen) {
    updateScoreboard();
    sbEl.style.display = 'flex';
  } else {
    sbEl.style.display = 'none';
  }
}

// Runtime telemetry is disabled unless a local probe explicitly enables it.
const runtimeTelemetry = CORE.createRuntimeTelemetry();
if (typeof window !== 'undefined') {
  window.fpsGameTelemetry = Object.freeze({
    enable: function () { runtimeTelemetry.setEnabled(true); return runtimeTelemetry.snapshot(); },
    disable: function () { runtimeTelemetry.setEnabled(false); return runtimeTelemetry.snapshot(); },
    snapshot: function () { return runtimeTelemetry.snapshot(); }
  });
}

// ---- Main loop ----
let lastT = performance.now();
let fpsAcc = 0, fpsN = 0, fpsT = 0;
// avoid resolution thrashing every half-second
let qualityAdjustT = 0;
// consecutive good samples before raising resolution again
let upscaleStreak = 0;
let wasScoped = false;
// extra FOV kick while sliding
let slideFov = 0;
// HUD canvas redraw accumulator (20 Hz throttle)
let hudRedrawT = 0;
// yaw at last HUD redraw (flick detection)
let lastHudYaw = 0;
// gameT of last flick-forced redraw
let hudFlickT = -9;
const _musicState = { inCombat: false, aliveEnemies: 0, nearestEnemy: undefined, health: 100 };
const _combatEvalOut = { aliveCount: 0, nearestEnemy: undefined };
const _camPosOut = { x: 0, y: 0 };
let _slideOvEl = null;
let _slideVigOpacity = 0;
let _lastSlideVigWritten = -1;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastT) / 1000;
  lastT = now;
  const wallDt = Math.max(0, dt);
  if (dt > 0.1) dt = 0.1;
  // Nothing can be drawn until the driver hands the context back; rendering into a
  // lost context throws every frame and buries the console.
  if (contextLost) return;
  // Measure real frame time, not the clamped simulation timestep.
  if (runtimeTelemetry.enabled) runtimeTelemetry.record(Math.max(0, now - (frame.previousNow || now)));
  fpsAcc += Math.max(0, (now - (frame.previousNow || now)) / 1000); frame.previousNow = now; fpsN++;
  if (fpsAcc > 0.5) {
    const fps = fpsN / fpsAcc;
    hud.fps.textContent = Math.round(fps) + ' FPS';
    // Adapt deliberately, not every sample: frequent canvas reallocations cause
    // the camera to appear to hitch on slower GPUs.
    qualityAdjustT += fpsAcc;
    // An explicit quality preset means the player has decided; stop second-guessing.
    if (qualityAdjustT >= 4.5 && qualityIsAuto()) {
      const maxPR = Math.min(window.devicePixelRatio, 1.5);
      const currentPR = renderer.getPixelRatio();
      let desiredPR = currentPR;
      if (fps < 48 && currentPR > 0.65) desiredPR = Math.max(0.65, currentPR - 0.1);
      // Upscale threshold must be below 60 (58) because vsync on 60 Hz displays caps fps near 60,
      // which would make >62 unreachable and prevent resolution from recovering after a hitch.
      // Asymmetric on purpose: each change reallocates the drawing buffer, which is
      // itself a hitch, so step down readily but require several consecutive good
      // samples before stepping back up. Stops the oscillation near the threshold.
      else if (fps > 58 && currentPR < maxPR) {
        upscaleStreak++;
        if (upscaleStreak >= 3) { desiredPR = Math.min(maxPR, currentPR + 0.1); upscaleStreak = 0; }
      } else upscaleStreak = 0;
      if (desiredPR < currentPR) upscaleStreak = 0;
      if (Math.abs(desiredPR - currentPR) >= 0.05) {
        renderer.setPixelRatio(desiredPR);
      }
      qualityAdjustT = 0;
    }
    fpsAcc = 0; fpsN = 0;
  }

  if (started && !paused) {
    gameT += dt;
    SKY_UNIFORMS.time.value = gameT;
    fireClockT += CORE.fireClockStep(wallDt, FIRE_CLOCK_MAX_STEP);
    hSpeedForSpread = Math.hypot(player.vel.x, player.vel.z);
    updateSway(dt);
    const activeMode = typeof getActiveMode === 'function' ? getActiveMode() : null;
    const isSettled = (typeof matchSettled === 'function')
      ? matchSettled()
      : ((typeof gameEnded !== 'undefined' && gameEnded) || (!!(activeMode && activeMode.id && activeMode.id !== 'survival') && typeof activeMode.isOver === 'function' && activeMode.isOver()));
    if (!isSettled) {
      updatePlayer(dt);
      updateWeapons(dt);
      updateEnemies(dt);
    }
    if (activeMode && typeof activeMode.update === 'function') activeMode.update(dt);
    else updateWaves(dt);
    updateVfx(dt);
    if (!isSettled) {
      updateGrenades(dt);
      updatePickups(dt);
      updateAmmoRelief(dt);
      updateStations(dt);
      updateDowned(dt);
      updateStreaks(dt);
    }
    updateRagdolls(dt);
    updateCasings(dt);
    updateMuzzleLight(dt);
    updateParticles(dt);
    updateFlashLights(dt);
    updateFootsteps(dt);
    updateSunShadow(player.pos.x, player.pos.z);
    // Adaptive score: follows the fight rather than looping regardless of it.
    CORE.evaluateCombatEnemies(enemies, player.pos.x, player.pos.z, _combatEvalOut);
    _musicState.inCombat = waveActive && !player.dead;
    _musicState.aliveEnemies = _combatEvalOut.aliveCount;
    _musicState.nearestEnemy = _combatEvalOut.nearestEnemy;
    _musicState.health = player.health;
    updateMusic(dt, _musicState);
    updateHitArcs();
    updateGrenadeWarnings();
    updateSuppression(dt);
    updateHudHealth();
    // HUD canvases (minimap + compass) redraw at 20 Hz instead of every
    // frame: they cost significant CPU overhead on 2D contexts and the
    // human eye cannot track a rotating minimap at 60+ Hz. A fast flick
    // forces an immediate redraw so snappy turns remain responsive.
    hudRedrawT += dt;
    const yawMoved = Math.abs(player.yaw - lastHudYaw);
    if (CORE.shouldRedrawHudCanvas(hudRedrawT, yawMoved, gameT - hudFlickT, CORE.HUD_REDRAW_INTERVAL, CORE.HUD_FLICK_YAW_THRESHOLD, CORE.HUD_FLICK_COOLDOWN)) {
      hudRedrawT = 0; lastHudYaw = player.yaw;
      if (yawMoved > CORE.HUD_FLICK_YAW_THRESHOLD) hudFlickT = gameT;
      drawMinimap();
      drawCompass();
    }
    // scope in/out sounds
    const curType = curW().type;
    if (CORE.isWeaponScopeType(curType)) {
      const scopeTrans = CORE.scopeTransitionState(adsAmount, wasScoped);
      if (scopeTrans === 1) { playSound(CORE.weaponScopeSound(curType, true)); wasScoped = true; }
      else if (scopeTrans === -1) { playSound(CORE.weaponScopeSound(curType, false)); wasScoped = false; }
    } else wasScoped = false;
    // slide vignette
    const wantSlide = player.sliding ? 1 : 0;
    if (_slideVigOpacity > 0 || wantSlide) {
      _slideVigOpacity = CORE.stepSlideVignette(_slideVigOpacity, wantSlide, dt);
      const roundedOp = Math.round(_slideVigOpacity * 100) / 100;
      if (roundedOp !== _lastSlideVigWritten) {
        _lastSlideVigWritten = roundedOp;
        if (!_slideOvEl) _slideOvEl = $id('slide-vignette');
        if (_slideOvEl) {
          _slideOvEl.style.opacity = String(roundedOp);
          _slideOvEl.style.boxShadow = roundedOp > 0 ? CORE.slideVignetteStyle(roundedOp) : 'none';
        }
      }
    }
  }
  // clear edge-trigger keys
  for (const k in pressed) delete pressed[k];

  // camera pose
  if (!player.dead) {
    // GAP-08: reduced motion strips the bob and roll that make some players ill.
    const motion = getSetting('reducedMotion') ? 0 : 1;
    const isRedMotion = !motion;
    const slideBlend = player.sliding ? 1 : 0;
    const isTac = player.tacT > 0;
    const desiredMobilityFov = CORE.mobilityFovBoost(player.sliding, isTac, adsAmount, isRedMotion);
    slideFov += (desiredMobilityFov - slideFov) * Math.min(1, 10 * dt);
    const zoom = CORE.weaponAdsZoom(curW().type);
    const targetFov = CORE.targetCameraFov(getSetting('fov'), adsAmount, zoom, slideFov);
    const previousFov = camera.fov;
    camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * dt);
    if (Math.abs(camera.fov - previousFov) > 0.001) camera.updateProjectionMatrix();

    CORE.cameraPositionOffsets(player.bobPhase, player.bobAmp, slideBlend, isRedMotion, _camPosOut);
    camera.position.set(player.pos.x + _camPosOut.x, player.pos.y + _camPosOut.y, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw + player.recoilY;
    camera.rotation.x = player.pitch + player.recoilP;

    // roll: bob + slide lean + strafe banking + sway
    const strafeDir = CORE.strafeDirection(!!keys['KeyA'], !!keys['KeyD'], window.__analogMove ? window.__analogMove.x : 0);
    camera.rotation.z = CORE.cameraRoll(player.bobPhase, player.bobAmp, slideBlend, strafeDir, isRedMotion, swayX, adsAmount > 0.8);
    shotKick = CORE.decayShotKick(shotKick, dt);
  } else {
    // death cam: fall to ground
    camera.position.y += (0.45 - camera.position.y) * Math.min(1, 3 * dt);
    camera.rotation.z += (0.5 - camera.rotation.z) * Math.min(1, 2 * dt);
  }

  // pose the viewmodel for THIS frame, then draw world + gun (65_postfx.js)
  if (started && !player.dead) {
    updateViewmodel(dt);
  } else if (typeof poseMeleeKnife === 'function') {
    poseMeleeKnife();
  }
  renderer.autoClear = true;
  renderFrame(dt);
}

applyAllSettings();
refreshMenuStats();
refreshResumeButton();
initWeapons();
buildViewmodel();
updateHudHealth();
updateHudAmmo();
requestAnimationFrame(frame);
// Parse every embedded GLB before deployment. This matters for file:// launches:
// the previous asynchronous path could render the arena before desktop props were
// constructed, producing missing cover. The menu remains intentionally blocked
// until all assets have either parsed or reported a controlled fallback failure.
function preloadGameAssets() {
  const progress = $id('asset-load-progress');
  setDeployReady(false);
  return loadEmbeddedAssets(function (name, loaded, total) {
    progress.textContent = loaded + ' / ' + total + ' · ' + name;
  }).then(function (results) {
    const n = scatterProps();
    const failed = results.filter(function (ok) { return !ok; }).length;
    progress.textContent = failed ? 'Ready with ' + failed + ' fallback' + (failed === 1 ? '' : 's') : 'All 3D assets ready';
    // the status line sits over the DEPLOY button: fade it out once the menu is interactive
    const note = $id('asset-loading');
    if (note) {
      note.dataset.state = failed ? 'warn' : 'ok';
      setTimeout(function () { note.classList.add('hidden'); }, failed ? 4000 : 1200);
      setTimeout(function () { note.style.display = 'none'; }, failed ? 4600 : 1800);
    }
    assetsReady = true;
    setDeployReady(true);
    if (n) console.log('preloaded props placed:', n);
    return results;
  });
}
preloadGameAssets();
