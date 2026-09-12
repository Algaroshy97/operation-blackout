// ============ GAME FLOW & MAIN LOOP ============
'use strict';
// ---- Flow ----
function pauseGame() {
  paused = true;
  $id('pause-menu').style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
}
function resumeGame() {
  paused = false;
  $id('pause-menu').style.display = 'none';
  canvas.requestPointerLock();
}
function killPlayer() {
  player.dead = true;
  mouse1Down = false;
  playSound('death');
  if (document.pointerLockElement) document.exitPointerLock();
  // if death lands while paused (e.g. queued enemy bullet), drop the pause so REDEPLOY works
  paused = false;
  $id('pause-menu').style.display = 'none';
  const accuracy = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
  const hsRate = kills > 0 ? Math.round(headshots / kills * 100) : 0;
  $id('ds-stats').innerHTML =
    'Waves survived: <b>' + waveNum + '</b><br>Score: <b>' + score + '</b><br>Kills: <b>' + kills + '</b> (' + headshots + ' headshots · ' + hsRate + '% HS)<br>Accuracy: <b>' + accuracy + '%</b> (' + shotsHit + '/' + shotsFired + ')';
  setTimeout(function () { if (player.dead) $id('death-screen').style.display = 'flex'; }, 900);
}
function victory() {
  gameEnded = true;
  playSound('victory');
  if (document.pointerLockElement) document.exitPointerLock();
  const accuracy = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
  const hsRate = kills > 0 ? Math.round(headshots / kills * 100) : 0;
  $id('vs-stats').innerHTML =
    'Final score: <b>' + score + '</b><br>Kills: <b>' + kills + '</b> (' + headshots + ' headshots · ' + hsRate + '% HS)<br>Accuracy: <b>' + accuracy + '%</b> (' + shotsHit + '/' + shotsFired + ')';
  $id('victory-screen').style.display = 'flex';
}

function resetGame() {
  paused = false;   // never reset into a paused state
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

// gun select UI
function buildGunSelect() {
  const wrap = $id('gun-cards');
  wrap.innerHTML = '';
  CFG.weapons.forEach(function (w, i) {
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
function pickGun(i) {
  weaponsOwned[0] = i;
  weaponsOwned[1] = -1;
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
  canvas.requestPointerLock();
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
  buildGunSelect();
  $id('gun-select').style.display = 'flex';
  audioCtx(); // unlock audio on user gesture
});
$id('btn-resume').addEventListener('click', resumeGame);
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
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.1) dt = 0.1;
  // Measure real frame time, not the clamped simulation timestep.
  fpsAcc += Math.max(0, (now - (frame.previousNow || now)) / 1000); frame.previousNow = now; fpsN++;
  if (fpsAcc > 0.5) {
    const fps = fpsN / fpsAcc;
    hud.fps.textContent = Math.round(fps) + ' FPS';
    // Adapt deliberately, not every sample: frequent canvas reallocations cause
    // the camera to appear to hitch on slower GPUs.
    qualityAdjustT += fpsAcc;
    if (qualityAdjustT >= 1.5) {
      const maxPR = Math.min(window.devicePixelRatio, 1.5);
      if (fps < 48 && renderer.getPixelRatio() > 0.65) renderer.setPixelRatio(Math.max(0.65, renderer.getPixelRatio() - 0.1));
      else if (fps > 62 && renderer.getPixelRatio() < maxPR) renderer.setPixelRatio(Math.min(maxPR, renderer.getPixelRatio() + 0.1));
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
    updateCasings(dt);
    updateMuzzleLight(dt);
    updateFootsteps(dt);
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
    const bobY = Math.abs(Math.sin(player.bobPhase)) * player.bobAmp * 0.05;
    const bobX = Math.sin(player.bobPhase) * player.bobAmp * 0.025;
    // slide: lower camera + roll tilt + slight FOV widen
    const slideBlend = player.sliding ? 1 : 0;
    slideFov += (slideBlend * 6 - slideFov) * Math.min(1, 10 * dt);
    // Ease toward one bounded FOV target. The old incremental update let FOV
    // drift upward after a slide and looked like a camera rotation skip.
    const baseFov = 72 - adsAmount * (curW().type === 'SR' ? 52 : 24);
    const targetFov = baseFov + slideFov;
    const previousFov = camera.fov;
    camera.fov += (targetFov - camera.fov) * Math.min(1, 12 * dt);
    if (Math.abs(camera.fov - previousFov) > 0.001) camera.updateProjectionMatrix();
    const slideDip = slideBlend * 0.45;
    camera.position.set(player.pos.x + bobX, player.pos.y - slideDip + bobY, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw + player.recoilY;
    camera.rotation.x = player.pitch + player.recoilP;
    // roll: bob + slide lean + sway
    camera.rotation.z = Math.sin(player.bobPhase) * player.bobAmp * 0.008 + slideBlend * 0.16 + (adsAmount > 0.8 ? swayX * 0.5 : 0);
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
function triggerMuzzleFlashIdle() { /* flash triggered in fireShot via flashT */ }

// hook muzzle flash + sniper boom + muzzle light into fireShot (defined earlier; patch via wrapper)
const _origFire = fireShot;
fireShot = function () {
  _origFire();
  triggerMuzzleFlash();
  flashMuzzleLight();
  if (curW().type === 'SR') playSound('sniper');
};

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
    assetsReady = true;
    setDeployReady(true);
    if (n) console.log('preloaded props placed:', n);
    return results;
  });
}
preloadGameAssets();
