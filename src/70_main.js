// ============ GAME FLOW & MAIN LOOP ============
'use strict';
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
function killPlayer() {
  player.dead = true;
  stopMusic();
  mouse1Down = false;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  playSound('death');
  if (document.pointerLockElement) document.exitPointerLock();
  // if death lands while paused (e.g. queued enemy bullet), drop the pause so REDEPLOY works
  paused = false;
  $id('pause-menu').style.display = 'none';
  const accuracy = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
  const hsRate = kills > 0 ? Math.round(headshots / kills * 100) : 0;
  clearCheckpoint();   // a lost run is not resumable
  const beat = recordRun({ score: score, wave: waveNum, accuracy: accuracy, kills: kills });
  $id('ds-stats').innerHTML =
    'Waves survived: <b>' + waveNum + '</b>' + (beat.wave ? ' <span class="xp">NEW BEST</span>' : '') +
    '<br>Score: <b>' + score + '</b>' + (beat.score ? ' <span class="xp">NEW BEST</span>' : '') +
    '<br>Kills: <b>' + kills + '</b> (' + headshots + ' headshots · ' + hsRate + '% HS)' +
    '<br>Accuracy: <b>' + accuracy + '%</b> (' + shotsHit + '/' + shotsFired + ')' +
    '<br><br><span style="font-size:13px;opacity:.8">' + statsSummaryHtml() + '</span>';
  setTimeout(function () { if (player.dead) $id('death-screen').style.display = 'flex'; }, 900);
}
function victory() {
  gameEnded = true;
  stopMusic();
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  playSound('victory');
  if (document.pointerLockElement) document.exitPointerLock();
  const accuracy = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
  const hsRate = kills > 0 ? Math.round(headshots / kills * 100) : 0;
  const beat = recordRun({ score: score, wave: waveNum, accuracy: accuracy, kills: kills });
  $id('vs-stats').innerHTML =
    'Final score: <b>' + score + '</b>' + (beat.score ? ' <span class="xp">NEW BEST</span>' : '') +
    '<br>Kills: <b>' + kills + '</b> (' + headshots + ' headshots · ' + hsRate + '% HS)' +
    '<br>Accuracy: <b>' + accuracy + '%</b> (' + shotsHit + '/' + shotsFired + ')' +
    '<br><br><span style="font-size:13px;opacity:.8">' + statsSummaryHtml() + '</span>';
  $id('victory-screen').style.display = 'flex';
}

function resetGame() {
  paused = false;   // never reset into a paused state
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  // remove all enemies + pickups + grenades
  for (let i = enemies.length - 1; i >= 0; i--) { scene.remove(enemies[i].parts.group); disposeEnemyGeometry(enemies[i]); }
  enemies.length = 0;
  for (let i = pickups.length - 1; i >= 0; i--) scene.remove(pickups[i].m);
  pickups.length = 0;
  for (let i = liveGrenades.length - 1; i >= 0; i--) {
    if (liveGrenades[i].ring) {
      scene.remove(liveGrenades[i].ring);
      if (typeof releaseBlastRing === 'function') releaseBlastRing(liveGrenades[i].ring);
    }
    scene.remove(liveGrenades[i].m);
  }
  liveGrenades.length = 0;
  // clear vfx
  for (let i = vfx.tracers.length - 1; i >= 0; i--) {
    const t = vfx.tracers[i];
    scene.remove(t.m);
    t.m.visible = false;
    tracerPool.push(t.m);
  }
  vfx.tracers.length = 0;
  for (let i = vfx.impacts.length - 1; i >= 0; i--) {
    const im = vfx.impacts[i];
    scene.remove(im.m);
    im.m.visible = false;
    if (im.isBulletImpact || (im.m.userData && im.m.userData.isBulletImpact)) {
      impactPool.push(im.m);
    } else if (im.isBlastFlash || (im.m.userData && im.m.userData.blastFlash)) {
      releaseBlastFlash(im.m);
    } else {
      if (im.m.geometry) im.m.geometry.dispose();
      if (im.m.material) im.m.material.dispose();
    }
  }
  vfx.impacts.length = 0;
  for (let i = vfx.blood.length - 1; i >= 0; i--) {
    const b = vfx.blood[i];
    scene.remove(b.m);
    b.m.visible = false;
    if (b.isSpark) sparkPool.push(b.m);
    else if (b.isBlood) bloodPool.push(b.m);
    else if (b.isDust) dustPool.push(b.m);
  }
  vfx.blood.length = 0;
  for (let i = casings.length - 1; i >= 0; i--) {
    const c = casings[i];
    scene.remove(c.m);
    c.m.visible = false;
    casingPool.push(c.m);
  }
  casings.length = 0;
  grenades.count = CFG.grenade.count;
  grenades.cd = 0;
  if (typeof clearDecals === 'function') clearDecals();   // v41: bullet holes never persist into a new run
  clearInputState();
  player.pos.set(0, CFG.player.height, 24);
  player.vel.set(0, 0, 0);
  player.yaw = Math.PI; player.pitch = 0;
  player.health = CFG.player.health; player.armor = CFG.player.armor;
  player.dead = false; player.crouching = false; player.sprinting = false;
  player.sliding = false; player.slideT = 0; player.onGround = false;
  player.coyoteT = 0; player.jumpBufT = 0;
  player.stamina = CFG.player.maxStamina; player.exhausted = false;
  player.recoilP = 0; player.recoilY = 0;
  player.mantleT = 0; player.tacT = 0; lastSprintTap = -99;
  recoilShot = 0; lastShotT = -99; bloom = 0; meleeT = 0; meleeSwing = 0;
  credits = 0;
  powerUntil.double = -99; powerUntil.instakill = -99;
  if (hud.credits) hud.credits.textContent = '0';
  runId++;   // invalidate anything the previous run scheduled
  waveNum = 0; score = 0; kills = 0; headshots = 0;
  shotsFired = 0; shotsHit = 0;
  steadyT = STEADY_MAX; steadyActive = false;
  adsAmount = 0; wasScoped = false; shotKick = 0; slideFov = 0;
  waveQueue = 0; waveActive = false; gameEnded = false;
  betweenWaveT = CFG.wave.startDelay;
  killStreak = 0; lastKillT = -99;   // multi-kill streak state
  hudRedrawT = 1; lastHudYaw = player.yaw; hudFlickT = -9;   // force immediate HUD redraw on new run
  weaponsOwned[1] = -1;
  curWeapon = 0;
  initWeapons();
  gunSwitchT = 1;
  buildViewmodel();
  updateHudHealth(); updateHudAmmo();
  hud.scoreVal.textContent = '0';
  hud.killfeed.innerHTML = '';
  clearTimeout(hud.waveBanner._t);
  hud.waveBanner.style.opacity = 0;   // cleared/ready banners stay up; never persist into menus
}

// ---- Settings panel ---------------------------------------------------------
// Built from CORE.SETTINGS_SCHEMA so a new setting needs one schema entry, not a
// schema entry plus a hand-written row plus a hand-written validator.
let settingsReturnTo = 'menu';
function buildSettingsUI() {
  const list = $id('settings-list');
  list.innerHTML = '';
  for (const key in CORE.SETTINGS_SCHEMA) {
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
  if (el) el.innerHTML = statsSummaryHtml();
}

// gun select UI
// Two-step deploy: primary, then secondary. The secondary used to be forced to
// (primary + 1) % 4 with no say in it, which made the SWAP key a coin toss the
// player never called.
let pickingSlot = 0;
let pendingSecondary = -1;
function buildGunSelect(slot) {
  pickingSlot = slot || 0;
  if (pickingSlot === 0) { pendingSecondary = -1; buildDifficultyRow(); }
  $id('diff-row').style.display = pickingSlot === 0 ? 'flex' : 'none';
  document.querySelector('#gun-select h2').textContent =
    pickingSlot === 0 ? 'SELECT PRIMARY' : 'SELECT SECONDARY';
  const wrap = $id('gun-cards');
  wrap.innerHTML = '';
  CFG.weapons.forEach(function (w, i) {
    if (pickingSlot === 1 && i === weaponsOwned[0]) return;   // already carrying it
    const card = document.createElement('div');
    card.className = 'gun-card';
    enableMenuKeyboard(card);
    const scoped = w.type === 'BR' || w.type === 'SR';
    card.innerHTML = '<div class="gc-name">' + w.name.toUpperCase() + '</div>' +
      '<div class="gc-type">' + ({ AR: 'ASSAULT RIFLE', SMG: 'SMG', BR: 'BATTLE RIFLE', SR: 'SNIPER RIFLE' })[w.type] + '</div>' +
      '<div class="gc-stats">Damage <b>' + w.dmg + '</b> · RPM <b>' + w.rpm + '</b><br>Mag <b>' + w.mag + '</b> · ' + (scoped ? 'Scoped ADS' : 'Iron sights') + '<br>' + (w.auto ? 'Full auto' : 'Semi auto') + ' · ' + (scoped ? 'High' : w.type === 'AR' ? 'Mid' : 'Low') + ' recoil</div>';
    card.addEventListener('click', function () { pickGun(i); });
    wrap.appendChild(card);
  });
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
    buildGunSelect(1);        // now choose what gets unlocked on the first wave clear
    return;
  }
  pendingSecondary = i;
  endlessMode = false;
  clearCheckpoint();          // starting fresh invalidates any saved run
  $id('gun-select').style.display = 'none';
  paused = false;              // always start unpaused — fixes frozen redeploy
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
  started = true;
  paused = false;              // belt & suspenders
  resetGame();
  showWaveBanner(0);            // "GET READY" + COMBAT IN n countdown until wave 1
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
  started = true; paused = false;
  resetGame();
  runDifficulty = cp.difficulty;
  endlessMode = cp.endless;
  weaponsOwned[0] = cp.weapons[0].gi;
  weaponsOwned[1] = cp.weapons[1] ? cp.weapons[1].gi : -1;
  initWeapons();
  for (let i = 0; i < 2; i++) {
    if (!wState[i] || !cp.weapons[i]) continue;
    wState[i].ammo = Math.min(CFG.weapons[weaponsOwned[i]].mag, cp.weapons[i].ammo);
    wState[i].reserve = Math.min(CFG.weapons[weaponsOwned[i]].reserveMax, cp.weapons[i].reserve);
  }
  curWeapon = 0; buildViewmodel();
  score = cp.score; kills = cp.kills; headshots = cp.headshots;
  shotsFired = cp.shotsFired; shotsHit = cp.shotsHit;
  player.health = cp.health; player.armor = cp.armor;
  credits = cp.credits || 0;
  if (hud.credits) hud.credits.textContent = credits;
  grenades.count = cp.grenades;
  waveNum = cp.wave;                  // next startWave() call is wave+1
  waveActive = false; betweenWaveT = CFG.wave.startDelay;
  hud.waveNum.textContent = waveNum;
  hud.scoreVal.textContent = score;
  updateHudHealth(); updateHudAmmo();
  showWaveBanner(0);
  $id('start-screen').style.display = 'none';
  document.body.classList.add('started');
  startMusic();
  canvas.requestPointerLock();
}

function refreshResumeButton() {
  const cp = loadCheckpoint();
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
// buttons
$id('btn-start').addEventListener('click', function () {
  if (!assetsReady) return;
  buildGunSelect(0);
  $id('start-screen').style.display = 'none';   // was left visible, bleeding through
  $id('gun-select').style.display = 'flex';
  $id('gun-select').scrollTop = 0;
  $id('gun-cards').firstElementChild.focus({ preventScroll: true });
  audioCtx(); // unlock audio on user gesture
  // Render every one-shot to a buffer while the player is still choosing a weapon,
  // so the first trigger of each is already a single BufferSource rather than a
  // freshly built node graph.
  prerenderSounds();
});
$id('btn-settings').addEventListener('click', function () { openSettings('menu'); audioCtx(); });
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
  gameEnded = false;
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
  $id('start-screen').style.display = 'flex';
  refreshMenuStats();
  resetGame(); started = false;
});

// ---- Main loop ----
let lastT = performance.now();
let fpsAcc = 0, fpsN = 0, fpsT = 0;
let qualityAdjustT = 0; // avoid resolution thrashing every half-second
let upscaleStreak = 0;  // consecutive good samples before raising resolution again
let wasScoped = false;
let slideFov = 0;   // extra FOV kick while sliding
let hudRedrawT = 0;     // HUD canvas redraw accumulator (20 Hz throttle)
let lastHudYaw = 0;     // yaw at last HUD redraw (flick detection)
let hudFlickT = -9;     // gameT of last flick-forced redraw
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.1) dt = 0.1;
  // Nothing can be drawn until the driver hands the context back; rendering into a
  // lost context throws every frame and buries the console.
  if (contextLost) return;
  // Measure real frame time, not the clamped simulation timestep.
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
    hSpeedForSpread = Math.hypot(player.vel.x, player.vel.z);
    updateSway(dt);
    updatePlayer(dt);
    updateWeapons(dt);
    updateEnemies(dt);
    updateWaves(dt);
    updateVfx(dt);
    updateGrenades(dt);
    updatePickups(dt);
    updateAmmoRelief(dt);
    updateCasings(dt);
    updateMuzzleLight(dt);
    updateFootsteps(dt);
    updateSunShadow(player.pos.x, player.pos.z);
    // Adaptive score: follows the fight rather than looping regardless of it.
    let nearest;
    for (let i = 0; i < enemies.length; i++) {
      if (enemies[i].dead) continue;
      const d = CORE.horizDist(enemies[i].pos.x, enemies[i].pos.z, player.pos.x, player.pos.z);
      if (nearest === undefined || d < nearest) nearest = d;
    }
    updateMusic(dt, { inCombat: waveActive && !player.dead, aliveEnemies: aliveEnemies(),
                      nearestEnemy: nearest, health: player.health });
    updateHitArcs();
    updateHudHealth();
    // HUD canvases (minimap + compass) redraw at 20 Hz instead of every
    // frame: they cost significant CPU overhead on 2D contexts and the
    // human eye cannot track a rotating minimap at 60+ Hz. A fast flick
    // forces an immediate redraw so snappy turns remain responsive.
    hudRedrawT += dt;
    const yawMoved = Math.abs(player.yaw - lastHudYaw);
    if (hudRedrawT >= 0.05 || (yawMoved > 0.15 && gameT - hudFlickT > 0.12)) {
      hudRedrawT = 0; lastHudYaw = player.yaw;
      if (yawMoved > 0.15) hudFlickT = gameT;
      drawMinimap();
      drawCompass();
    }
    // scope in/out sounds
    if (curW().type === 'SR' || curW().type === 'BR') {
      if (adsAmount > 0.8 && !wasScoped) { playSound('scope_in'); wasScoped = true; }
      if (adsAmount < 0.5 && wasScoped) { playSound('scope_out'); wasScoped = false; }
    } else wasScoped = false;
    // slide vignette + FOV kick
    const slideOv = $id('slide-vignette');
    if (slideOv) {
      const wantSlide = player.sliding ? 1 : 0;
      const cur = slideOv.style.opacity ? parseFloat(slideOv.style.opacity) : 0;
      slideOv.style.opacity = String(Math.min(1, cur + (wantSlide - cur) * Math.min(1, 14 * dt)));
      slideOv.style.boxShadow = 'inset 0 0 90px 30px rgba(0,0,0,' + (0.55 * parseFloat(slideOv.style.opacity)) + ')';
    }
  }
  // clear edge-trigger keys
  for (const k in pressed) delete pressed[k];

  // camera pose
  if (!player.dead) {
    // GAP-08: reduced motion strips the bob and roll that make some players ill.
    const motion = getSetting('reducedMotion') ? 0 : 1;
    const bobY = Math.abs(Math.sin(player.bobPhase)) * player.bobAmp * 0.05 * motion;
    const bobX = Math.sin(player.bobPhase) * player.bobAmp * 0.025 * motion;
    // slide: lower camera + roll tilt + slight FOV widen
    const slideBlend = player.sliding ? 1 : 0;
    slideFov += (slideBlend * 6 - slideFov) * Math.min(1, 10 * dt);
    // Ease toward one bounded FOV target. The old incremental update let FOV
    // drift upward after a slide and looked like a camera rotation skip.
    const baseFov = getSetting('fov') - adsAmount * (curW().type === 'SR' ? 52 : 24);
    const targetFov = baseFov + slideFov;
    const previousFov = camera.fov;
    camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * dt);
    if (Math.abs(camera.fov - previousFov) > 0.001) camera.updateProjectionMatrix();
    const slideDip = slideBlend * 0.45 * motion;
    camera.position.set(player.pos.x + bobX, player.pos.y - slideDip + bobY, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw + player.recoilY;
    camera.rotation.x = player.pitch + player.recoilP;
    // roll: bob + slide lean + sway
    camera.rotation.z = (Math.sin(player.bobPhase) * player.bobAmp * 0.008 + slideBlend * 0.16) * motion + (adsAmount > 0.8 ? swayX * 0.5 : 0);
    shotKick *= Math.pow(0.001, dt);
  } else {
    // death cam: fall to ground
    camera.position.y += (0.45 - camera.position.y) * Math.min(1, 3 * dt);
    camera.rotation.z += (0.5 - camera.rotation.z) * Math.min(1, 2 * dt);
  }

  // single-pass render: viewmodel is a camera child with depthTest:false materials
  renderer.autoClear = true;
  renderer.render(scene, camera);
  if (started && !player.dead && gunGroup) {
    updateViewmodel(dt);
  }
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
    if (GLB_PARSED.SOLDIER) {
      probeSkinnedSoldier();
      if (!GLB_SOLDIER_BROKEN) console.log('soldier asset ready');
    }
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
