// ============ GAME FLOW & MAIN LOOP ============
'use strict';
// ---- Flow ----
function pauseGame() {
  paused = true;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  $id('pause-menu').style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
}
function resumeGame() {
  paused = false;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  $id('pause-menu').style.display = 'none';
  lockPointer();
}
function endStats(prefix) {
  const accuracy = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
  const hsRate = kills > 0 ? Math.round(headshots / kills * 100) : 0;
  const rec = recordBest(score, waveNum);
  return prefix + 'Score: <b>' + score + '</b>' + (rec.isNew && score > 0 ? ' <span class="newbest">NEW BEST</span>' : ' · best <b>' + rec.best.score + '</b>') +
    '<br>Kills: <b>' + kills + '</b> (' + headshots + ' headshots · ' + hsRate + '% HS)<br>Accuracy: <b>' + accuracy + '%</b> (' + shotsHit + '/' + shotsFired + ')' +
    '<br>Difficulty: <b>' + diff().label + '</b>';
}
function killPlayer() {
  player.dead = true;
  mouse1Down = false;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  playSound('death');
  if (document.pointerLockElement) document.exitPointerLock();
  // if death lands while paused (e.g. queued enemy bullet), drop the pause so REDEPLOY works
  paused = false;
  $id('pause-menu').style.display = 'none';
  $id('ds-stats').innerHTML = endStats('Waves survived: <b>' + Math.max(0, waveNum - 1) + '</b><br>');
  setTimeout(function () { if (player.dead) $id('death-screen').style.display = 'flex'; }, 1200);
}
function victory() {
  gameEnded = true;
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  playSound('victory');
  if (document.pointerLockElement) document.exitPointerLock();
  $id('vs-stats').innerHTML = endStats('All ' + CFG.wave.victoryWave + ' waves survived<br>');
  $id('victory-screen').style.display = 'flex';
}
function refreshBestLabel() {
  const b = loadBest()[SETTINGS.difficulty];
  const txt = b ? 'BEST · ' + diff().label + ' · ' + b.score + ' (WAVE ' + b.wave + ')' : '';
  $id('start-best').textContent = txt;
  hud.bestVal.textContent = b ? 'BEST ' + b.score : '';
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
  clearParticles();
  for (let i = casings.length - 1; i >= 0; i--) {
    const c = casings[i];
    scene.remove(c.m);
    c.m.visible = false;
    casingPool.push(c.m);
  }
  casings.length = 0;
  resetPerks();
  grenades.count = maxGrenades();
  grenades.cd = 0;
  resetBarrels();
  clearDebris();
  if (typeof clearDecals === 'function') clearDecals();   // v41: bullet holes never persist into a new run
  clearInputState();
  player.pos.set(0, CFG.player.height, 24);
  player.vel.set(0, 0, 0);
  player.yaw = Math.PI; player.pitch = 0;
  player.health = CFG.player.health; player.armor = maxArmor();
  player.dead = false; player.crouching = false; player.sprinting = false;
  player.sliding = false; player.slideT = 0; player.onGround = false;
  player.coyoteT = 0; player.jumpBufT = 0;
  player.stamina = CFG.player.maxStamina; player.exhausted = false;
  player.recoilP = 0; player.recoilY = 0; player.recoilTP = 0; player.recoilTY = 0; player.recoilVP = 0; player.recoilVY = 0;
  player.eyeH = CFG.player.height; player.crouchLatch = false; player.lean = 0; player.leanTarget = 0;
  player.leanOffset.set(0, 0, 0); player.mantle = null; player.landDip = 0; player.landVel = 0; player.lastLandSpeed = 0;
  waveNum = 0; score = 0; kills = 0; headshots = 0;
  shotsFired = 0; shotsHit = 0;
  steadyT = STEADY_MAX; steadyActive = false;
  adsAmount = 0; wasScoped = false; SCOPE.zoomIdx = 0; SCOPE.swayX = 0; SCOPE.swayY = 0; slowmoT = 0; shotKick = 0; slideFov = 0;
  waveQueue = 0; waveActive = false; gameEnded = false;
  betweenWaveT = CFG.wave.startDelay;
  killStreak = 0; lastKillT = -99;   // multi-kill streak state
  hudRedrawT = 1; lastHudYaw = player.yaw; hudFlickT = -9;   // force immediate HUD redraw on new run
  weaponsOwned[1] = SNIPER; weaponsOwned[SIDE_SLOT] = PISTOL;
  curWeapon = 0;
  initWeapons();
  gunSwitchT = 1;
  buildViewmodel();
  updateHudHealth(); updateHudAmmo();
  hud.scoreVal.textContent = '0';
  hud.killfeed.innerHTML = '';
  clearDamageNumbers();
  ghostHp = CFG.player.health; lastHudHp = -1; lastHudArmor = -1;
  POST.damage = 0; POST.lowHealth = 0; camTrauma = 0; meleeT = 0; meleeCd = 0;
  refreshBestLabel();
  clearTimeout(hud.waveBanner._t);
  hud.waveBanner.style.opacity = 0;   // cleared/ready banners stay up; never persist into menus
}

// gun select UI: stat bars normalised across the primary roster
const GUN_TYPE_LABEL = { AR: 'ASSAULT RIFLE', SMG: 'SUBMACHINE GUN', BR: 'BATTLE RIFLE', SR: 'BOLT-ACTION SNIPER', SG: 'PUMP SHOTGUN', LMG: 'LIGHT MACHINE GUN', PST: 'PISTOL' };
function gunStats(w) {
  const dmg = w.dmg * (w.pellets || 1);
  return {
    Damage: Math.min(1, dmg / 130),
    'Fire rate': Math.min(1, w.rpm / 1050),
    Range: Math.min(1, (w.r0 + w.r1) / 380),
    Control: Math.max(0.08, 1 - (w.recoilV * 30 + w.recoilH * 40)),
    Mobility: Math.min(1, (w.moveMul || 1) * (w.type === 'LMG' ? 0.55 : w.type === 'SR' ? 0.6 : w.type === 'SMG' ? 1 : 0.8)),
    Capacity: Math.min(1, w.mag / 60)
  };
}
function buildGunSelect() {
  const wrap = $id('gun-cards');
  wrap.innerHTML = '';
  CFG.weapons.forEach(function (w, i) {
    if (w.sidearm || w.carried) return;
    const card = document.createElement('div');
    card.className = 'gun-card';
    enableMenuKeyboard(card);
    const st = gunStats(w);
    let bars = '';
    for (const k in st) bars += '<div class="gc-stat"><span>' + k.toUpperCase() + '</span><i><u style="width:' + Math.round(st[k] * 100) + '%"></u></i></div>';
    card.innerHTML = '<div class="gc-name">' + w.name.toUpperCase() + '</div><div class="gc-type">' + GUN_TYPE_LABEL[w.type] + '</div>' + bars +
      '<div class="gc-foot">' + (w.auto ? 'Full auto' : w.bolt ? 'Bolt action' : w.pump ? 'Pump action' : 'Semi auto') + ' · ' + w.mag + ' rds · ' + ({ reddot: 'Red dot', holo: 'Holographic', acog: '4x ACOG', scope: '8x scope', iron: 'Iron sights' })[w.sight] + (w.pen ? ' · penetrates cover' : '') + '</div>';
    card.addEventListener('click', function () { pickGun(i); });
    wrap.appendChild(card);
  });
  const first = wrap.querySelector('.gun-card');
  if (first && lastInputDevice === 'pad') first.focus();
}
function pickGun(i) {
  weaponsOwned[0] = i;
  weaponsOwned[1] = SNIPER; weaponsOwned[SIDE_SLOT] = PISTOL;
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
  deploy.setAttribute('aria-disabled', String(!ready));
  deploy.tabIndex = ready ? 0 : -1;
  deploy.textContent = ready ? 'DEPLOY' : 'LOADING ASSETS…';
}
function startGame() {
  if (!assetsReady) return;
  started = true;
  paused = false;              // belt & suspenders
  resetGame();
  showWaveBanner(0);            // "GET READY" + COMBAT IN n countdown until wave 1
  $id('start-screen').style.display = 'none';
  startAmbient();
  lockPointer();
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
  const t = e.target && e.target.closest ? e.target.closest('.menu-btn, .gun-card, .perk-card') : null;
  if (t) playSound('click');
});
// buttons
$id('btn-start').addEventListener('click', function () {
  if (!assetsReady) return;
  buildGunSelect();
  $id('gun-select').style.display = 'flex';
  audioCtx(); // unlock audio on user gesture
});
$id('btn-resume').addEventListener('click', resumeGame);
$id('btn-settings').addEventListener('click', function () { audioCtx(); openSettings('start-screen'); });
$id('btn-pause-settings').addEventListener('click', function () { openSettings('pause-menu'); });
$id('btn-settings-back').addEventListener('click', function () { closeSettings(); refreshBestLabel(); });
enableMenuKeyboard($id('btn-settings')); enableMenuKeyboard($id('btn-pause-settings')); enableMenuKeyboard($id('btn-settings-back'));
$id('btn-quit').addEventListener('click', function () {
  paused = false; started = false;
  $id('pause-menu').style.display = 'none';
  $id('start-screen').style.display = 'flex';
  resetGame();
});
$id('btn-restart').addEventListener('click', function () {
  $id('death-screen').style.display = 'none';
  buildGunSelect();
  $id('gun-select').style.display = 'flex';
});
$id('btn-death-quit').addEventListener('click', function () {
  $id('death-screen').style.display = 'none';
  $id('start-screen').style.display = 'flex';
  resetGame(); started = false;
});
$id('btn-v-restart').addEventListener('click', function () {
  $id('victory-screen').style.display = 'none';
  buildGunSelect();
  $id('gun-select').style.display = 'flex';
});
$id('btn-v-quit').addEventListener('click', function () {
  $id('victory-screen').style.display = 'none';
  $id('start-screen').style.display = 'flex';
  resetGame(); started = false;
});

// ---- Main loop ----
let lastT = performance.now();
let fpsAcc = 0, fpsN = 0, fpsT = 0;
let qualityAdjustT = 0; // avoid resolution thrashing every half-second
let wasScoped = false;
let slideFov = 0;   // extra FOV kick while sliding
let hudRedrawT = 0;     // HUD canvas redraw accumulator (20 Hz throttle)
let lastHudYaw = 0;     // yaw at last HUD redraw (flick detection)
let hudFlickT = -9;     // gameT of last flick-forced redraw
let heartT = 0;
let slowmoT = 0;
function triggerSlowmo(sec) { slowmoT = Math.max(slowmoT, sec); }
function updateHeartbeat(dt) {
  if (player.health > 30 || player.dead) { heartT = 0; return; }
  heartT -= dt;
  if (heartT <= 0) { heartT = 0.55 + player.health / 60; playSound('heartbeat'); }
}
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.1) dt = 0.1;
  if (!(dt > 0)) dt = 0;   // the first rAF timestamp can precede lastT after a long startup
  // brief bullet-time after long-range sniper headshot kills (real-time duration)
  if (slowmoT > 0) { slowmoT -= dt; dt *= 0.3; }
  // Measure real frame time, not the clamped simulation timestep.
  fpsAcc += Math.max(0, (now - (frame.previousNow || now)) / 1000); frame.previousNow = now; fpsN++;
  if (fpsAcc > 0.5) {
    const fps = fpsN / fpsAcc;
    hud.fps.textContent = Math.round(fps) + ' FPS';
    // Adapt deliberately, not every sample: frequent canvas reallocations cause
    // the camera to appear to hitch on slower GPUs.
    qualityAdjustT += fpsAcc;
    if (qualityAdjustT >= 4.5) {
      const maxPR = Math.min(window.devicePixelRatio, QUALITY.maxPR);
      const currentPR = renderer.getPixelRatio();
      let desiredPR = currentPR;
      if (fps < 48 && currentPR > 0.65) desiredPR = Math.max(0.65, currentPR - 0.1);
      // Upscale threshold must be below 60 (58) because vsync on 60 Hz displays caps fps near 60,
      // which would make >62 unreachable and prevent resolution from recovering after a hitch.
      else if (fps > 58 && currentPR < maxPR) desiredPR = Math.min(maxPR, currentPR + 0.1);
      if (Math.abs(desiredPR - currentPR) >= 0.05) {
        renderer.setPixelRatio(desiredPR);
        postfxResize();
      }
      qualityAdjustT = 0;
    }
    fpsAcc = 0; fpsN = 0;
  }

  if (started && !paused) {
    gameT += dt;
    hSpeedForSpread = Math.hypot(player.vel.x, player.vel.z);
    updateSway(dt);
    updateScopeSway(dt);
    updatePlayer(dt);
    updateWeapons(dt);
    updateEnemies(dt);
    updateWaves(dt);
    updateVfx(dt);
    updateGrenades(dt);
    updatePickups(dt);
    updateCasings(dt);
    updateDestructibles(dt);
    updateAmbient(dt);
    updateMuzzleLight(dt);
    updateFootsteps(dt);
    updateHudHealth();
    updateHudTick(dt);
    updateDamageNumbers(dt);
    updateGrenadeWarning();
    updateHeartbeat(dt);
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
  pollGamepadMenus(dt);
  // clear edge-trigger keys
  for (const k in pressed) delete pressed[k];

  // camera pose
  if (!player.dead) {
    const bobY = Math.abs(Math.sin(player.bobPhase)) * player.bobAmp * 0.05;
    const bobX = Math.sin(player.bobPhase) * player.bobAmp * 0.025;
    // slide: lower camera + roll tilt + slight FOV widen
    const slideBlend = player.sliding ? 1 : 0;
    slideFov += (slideBlend * 6 - slideFov) * Math.min(1, 10 * dt);
    // Ease toward one bounded FOV target. The old incremental update let FOV
    // drift upward after a slide and looked like a camera rotation skip.
    // ADS zoom scales the tangent of the half-angle (true optical magnification)
    const adsFov = 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(SETTINGS.fov) / 2) * currentAdsZoom()));
    const baseFov = SETTINGS.fov + (adsFov - SETTINGS.fov) * adsAmount;
    const targetFov = baseFov + slideFov;
    const previousFov = camera.fov;
    camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * dt);
    if (Math.abs(camera.fov - previousFov) > 0.001) camera.updateProjectionMatrix();
    updateLandSpring(dt);
    camera.position.set(player.pos.x + bobX + player.leanOffset.x, player.pos.y + bobY + player.leanOffset.y + player.landDip, player.pos.z + player.leanOffset.z);
    camera.rotation.order = 'YXZ';
    updateCameraShake(dt, performance.now() / 1000);
    camera.rotation.y = player.yaw + player.recoilY + camShake.yaw + SCOPE.swayX;
    camera.rotation.x = player.pitch + player.recoilP + camShake.pitch + SCOPE.swayY;
    // roll: bob + slide lean + sway
    camera.rotation.z = Math.sin(player.bobPhase) * player.bobAmp * 0.008 + (slideFov / 6) * 0.12 + (adsAmount > 0.8 ? SCOPE.swayX * 0.3 : 0) + camShake.roll - player.lean * 0.13;
    shotKick *= Math.pow(0.001, dt);
  } else {
    // death cam: fall to ground
    camera.position.y += (0.45 - camera.position.y) * Math.min(1, 3 * dt);
    camera.rotation.z += (0.5 - camera.rotation.z) * Math.min(1, 2 * dt);
  }

  if (started && !player.dead && gunGroup) {
    updateViewmodel(dt);
    drawScope(dt);
    updateGunLighting();
  } else if (scopeCanvas.style.display !== 'none') scopeCanvas.style.display = 'none';
  updateSunShadow(player.pos);
  SKY_UNIFORMS.time.value += dt;
  updateWorldDetail(performance.now() / 1000);
  // world pass + viewmodel pass (own camera, cleared depth) + post-FX
  renderFrame(dt, started && !player.dead && !!gunGroup && gunGroup.visible);
}
initWeapons();
buildViewmodel();
updateHudHealth();
updateHudAmmo();
updatePerkHud();
refreshBestLabel();
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
    // warm the soldier templates so the first wave does not hitch on building them
    for (let k = 0; k < 4; k++) buildSoldier(k);
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
