// ============ WEAPONS, VIEWMODEL & SHOOTING ============
'use strict';
// ---- Weapon state ----
const weaponsOwned = [0, -1];   // indices into CFG.weapons; -1 = empty slot
let curWeapon = 0;              // 0 or 1 (slot)
let wState = [];                // per owned slot: {ammo, reserve, reloading, reloadT, nextShot}
function initWeapons() {
  wState = [];
  for (let i = 0; i < 2; i++) {
    const gi = weaponsOwned[i];
    if (gi < 0) { wState.push(null); continue; }
    const w = CFG.weapons[gi];
    wState.push({ ammo: w.mag, reserve: w.reserveMax, reloading: false, reloadT: 0, nextShot: 0 });
  }
}
function curW() { return CFG.weapons[weaponsOwned[curWeapon]]; }
function curS() { return wState[curWeapon]; }

function switchWeapon(slot) {
  if (slot === curWeapon) return;
  const s = ((slot % 2) + 2) % 2;
  if (weaponsOwned[s] < 0) return;
  if (curS()) { curS().reloading = false; }
  curWeapon = s;
  gunSwitchT = 0;   // raise animation timer
  buildViewmodel();
  updateHudAmmo();
  playSound('draw');
}

function tryReload() {
  const s = curS(); if (!s || s.reloading || s.ammo >= curW().mag || s.reserve <= 0) return;
  s.reloading = true; s.reloadT = 0;
  updateHudAmmo();
  playSound('reload_out');
}

function updateWeapons(dt) {
  const s = curS(); if (!s) return;
  const w = curW();
  if (s.reloading) {
    s.reloadT += dt;
    if (s.reloadT >= w.reload) {
      const need = w.mag - s.ammo;
      const take = Math.min(need, s.reserve);
      s.ammo += take; s.reserve -= take;
      s.reloading = false;
      playSound('reload_in');
      updateHudAmmo();
    }
  }
  // fire
  if (mouse1Down && !s.reloading && !player.dead && started && !paused) {
    if (gameT >= s.nextShot && s.ammo > 0) {
      if (!w.auto) mouse1Down = false;
      fireShot();
    } else if (gameT >= s.nextShot && s.ammo === 0) {
      if (pressed['noop']) {} // dry
      if (!dryPlayed) { playSound('dry'); dryPlayed = true; }
      if (s.reserve > 0) tryReload();
    }
  } else { dryPlayed = false; }
  // grenade
  if (pressed['KeyG']) throwGrenade();
  if (pressed['KeyR']) tryReload();
  if (pressed['Digit1']) switchWeapon(0);
  if (pressed['Digit2']) switchWeapon(1);
}
let dryPlayed = false;

// ---- Ballistics ----
const raycaster = new THREE.Raycaster();
const _shootDir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _aimTgt = new THREE.Vector3();

function adsDown() { return !!keys['Mouse2'] && !player.sprinting && !player.dead; }
let adsAmount = 0;   // 0..1 smooth
let gunSwitchT = 1;  // 1 = fully raised

// ---- Sniper scope state ----
const SWAY_USE = 5.5, STEADY_RECOVER = 2.2, STEADY_MAX = 2.2;
let swayPhase = 0, swayX = 0, swayY = 0;
let steadyT = STEADY_MAX; // remaining breath-hold time
let steadyActive = false;

function updateSway(dt) {
  swayPhase += dt;
  steadyActive = curW().type === 'SR' && adsAmount > 0.8 && !!keys['ShiftLeft'] && steadyT > 0;
  if (steadyActive) steadyT = Math.max(0, steadyT - dt);
  else steadyT = Math.min(STEADY_MAX, steadyT + dt * STEADY_RECOVER);
  const amp = CFG.assist.swayAmp * (steadyActive ? CFG.assist.steadyMul : 1);
  swayX = Math.sin(swayPhase * 1.7) * amp + Math.sin(swayPhase * 0.9) * amp * 0.6;
  swayY = Math.sin(swayPhase * 1.3 + 1.2) * amp * 0.8;
}
function isScoped() {
  return adsAmount > 0.82 && curW().type === 'SR';
}

// ---- Aim assist: when scoped (or ADS), drifting crosshair gently onto nearest enemy chest/head within a small angle ----
function applyAimAssist(dir, from) {
  if (adsAmount < 0.8) return dir;
  let best = null, bestAng = CFG.assist.angle * (steadyActive ? 1.6 : 1);
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _aimTgt.set(en.pos.x, en.pos.y + 1.15, en.pos.z);   // chest
    const to = _aimTgt.clone().sub(from);
    const d = to.length();
    to.normalize();
    const ang = dir.angleTo(to);
    if (ang < bestAng) { bestAng = ang; best = { to: to, d: d, en: en, head: false }; }
    // head magnet (smaller box)
    _aimTgt.set(en.pos.x, en.pos.y + 1.72, en.pos.z);
    const toH = _aimTgt.clone().sub(from).normalize();
    const angH = dir.angleTo(toH);
    if (angH < bestAng * 0.55) { bestAng = angH * 1.8; best = { to: toH, d: d, en: en, head: true }; }
  }
  if (!best) return dir;
  // blend: partial pull per shot (bullet magnetism) + persistent visual nudge
  const pull = Math.min(1, CFG.assist.strength * 0.25);
  const nudged = dir.clone().lerp(best.to, pull).normalize();
  return nudged;
}
// bullet magnetism: at fire time, snap within a small cone
function magnetizeBullet(dir, from) {
  let bestDir = dir, bestAng = CFG.assist.bulletAngle;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _aimTgt.set(en.pos.x, en.pos.y + 1.35, en.pos.z);
    const to = _aimTgt.clone().sub(from).normalize();
    const ang = dir.angleTo(to);
    if (ang < bestAng) { bestAng = ang; bestDir = to; }
  }
  return bestDir;
}

function fireShot() {
  const s = curS(), w = curW();
  shotsFired++;
  s.ammo--;
  s.nextShot = gameT + 60 / w.rpm;
  // spread
  const spread = adsDown() ? w.adsSpread : w.spread;
  const spreadMul = 1 + Math.min(1.2, hSpeedForSpread * 0.25) + (player.onGround ? 0 : 0.8);
  camera.getWorldPosition(_from);
  // direction with random cone
  _shootDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _shootDir.x += (Math.random() - 0.5) * 2 * spread * spreadMul;
  _shootDir.y += (Math.random() - 0.5) * 2 * spread * spreadMul;
  _shootDir.z += (Math.random() - 0.5) * 2 * spread * spreadMul * 0.3;
  _shootDir.normalize();
  // bullet magnetism (small snap onto enemy center-mass)
  _shootDir.copy(magnetizeBullet(_shootDir, _from));
  raycaster.set(_from, _shootDir);
  raycaster.far = w.range;

  // test enemies first (meshes have userData.enemy)
  const targets = [];
  for (let i = 0; i < enemies.length; i++) {
    if (enemies[i].dead) continue;
    targets.push(enemies[i].hitBody);
    targets.push(enemies[i].hitHead);
  }
  const worldHits = raycaster.intersectObjects(scene.children, true)
    .filter(function (h) { return h.object !== ground && !h.object.userData.vfx && !h.object.userData.gun && !h.object.userData.sky; });
  const enemyHits = raycaster.intersectObjects(targets, false);
  let hit = null, isEnemy = false, isHead = false;
  if (enemyHits.length && worldHits.length) {
    const w0 = worldHits[0];
    if (w0.object.userData.enemyFlesh && w0.object.userData.enemyRef && !w0.object.userData.enemyRef.dead) {
      // bullet struck a visible enemy mesh directly — treat as body hit at that point
      hit = w0; isEnemy = true; isHead = false;
    } else if (enemyHits[0].distance <= w0.distance) { hit = enemyHits[0]; isEnemy = true; isHead = hit.object.userData.isHead; }
    else hit = w0;
  } else if (enemyHits.length) { hit = enemyHits[0]; isEnemy = true; isHead = hit.object.userData.isHead; }
  else if (worldHits.length) {
    const w0 = worldHits[0];
    if (w0.object.userData.enemyFlesh && w0.object.userData.enemyRef && !w0.object.userData.enemyRef.dead) { hit = w0; isEnemy = true; isHead = false; }
    else hit = w0;
  }

  if (hit && isEnemy) {
    shotsHit++;
    const en = hit.object.userData.enemyRef;
    const dmg = w.dmg * (isHead ? CFG.ai.headshotMul : 1) * distanceFalloff(w.dmg, hit.distance, w.range);
    damageEnemy(en, dmg, hit.point, isHead);
  } else if (hit) {
    spawnImpact(hit.point, hit.face ? hit.face.normal : null, hit.object);
  }
  spawnTracer(_from, hit ? hit.point : _from.clone().add(_shootDir.clone().multiplyScalar(w.range)));
  // shell casing eject
  spawnCasing(camera.position, camera.quaternion);
  // sniper: brief unscope on shot (recoil re-chamber feel)
  if (w.type === 'SR') { adsAmount *= 0.45; }
  // recoil
  player.recoilP += w.recoilV * (0.8 + Math.random() * 0.4);
  player.recoilY += (Math.random() - 0.5) * 2 * w.recoilH;
  shotKick = Math.min(shotKick + 0.5, 1.4);
  playSound('shot');
  if (w.type === 'SR') { playSound('scope_out'); }
  updateHudAmmo();
}
function distanceFalloff(base, dist, range) { return dist > range * 0.6 ? 0.65 : 1; }
let hSpeedForSpread = 0;
let shotKick = 0;

// ---- Viewmodel (procedural low-poly gun) ----
// Rendered as a child of the camera in the MAIN render pass (single-pass, driver-proof).
// All gun materials get depthTest:false + renderOrder 999 so the gun always draws on top.
const gunMats = {
  black: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.55, metalness: 0.35, depthTest: false }),
  dark: new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.6, metalness: 0.3, depthTest: false }),
  metal: new THREE.MeshStandardMaterial({ color: 0x666c75, roughness: 0.35, metalness: 0.8, depthTest: false }),
  tan: new THREE.MeshStandardMaterial({ color: 0x8f7d5a, roughness: 0.8, depthTest: false }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6a4a2c, roughness: 0.85, depthTest: false }),
  hand: new THREE.MeshStandardMaterial({ color: 0xb08d6a, roughness: 0.9, depthTest: false })
};
const gunScene = null;   // legacy: viewmodel now lives on the camera
scene.add(camera);       // camera children render in the main pass
let gunGroup = null;
let muzzleFlash = null;
let gunParts = { bolt: null, mag: null, handL: null, handR: null };

function buildViewmodel() {
  if (gunGroup) {
    camera.remove(gunGroup);
    gunGroup.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
  }
  gunGroup = new THREE.Group();
  const gi = weaponsOwned[curWeapon];
  const type = CFG.weapons[gi].type;
  const M = gunMats;

  function part(w, h, d, x, y, z, mat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.renderOrder = 999;   // always on top
    m.userData.gun = true;
    gunGroup.add(m);
    return m;
  }
  // receiver
  part(0.07, 0.09, 0.34, 0, 0, -0.12, M.black);
  // barrel + handguard
  if (type === 'BR') {
    part(0.05, 0.05, 0.34, 0, 0.012, -0.44, M.dark);
    part(0.065, 0.065, 0.2, 0, 0.012, -0.42, M.dark);
  } else {
    part(0.045, 0.045, 0.22, 0, 0.012, -0.38, M.dark);
    part(0.06, 0.06, 0.16, 0, 0.005, -0.36, M.black);
  }
  // stock
  part(0.06, 0.085, 0.16, 0, -0.008, 0.11, M.black);
  part(0.055, 0.11, 0.05, 0, -0.02, 0.2, M.dark);
  // grip
  part(0.05, 0.13, 0.06, 0, -0.1, 0.02, M.black).rotation.x = 0.3;
  // magazine
  const mag = part(0.055, 0.16, 0.09, 0, -0.13, -0.1, M.dark);
  mag.rotation.x = type === 'SMG' ? 0.12 : 0.05;
  gunParts.mag = mag;
  // optic / iron sights / sniper scope
  if (type === 'SR') {
    // big scope tube on top
    part(0.052, 0.052, 0.34, 0, 0.085, -0.18, M.black);
    part(0.075, 0.075, 0.06, 0, 0.085, -0.36, M.dark);    // objective bell
    part(0.062, 0.062, 0.05, 0, 0.085, 0.0, M.dark);      // ocular
    part(0.02, 0.05, 0.02, 0.035, 0.055, -0.1, M.metal);  // mount
    part(0.02, 0.05, 0.02, 0.035, 0.055, -0.26, M.metal);
    part(0.02, 0.03, 0.05, 0.036, 0.085, -0.14, M.metal); // turret
    // bipod (folded)
    part(0.012, 0.09, 0.012, -0.03, -0.03, -0.55, M.dark);
    part(0.012, 0.09, 0.012, 0.03, -0.03, -0.55, M.dark);
    // cheek rest
    part(0.05, 0.04, 0.14, 0, 0.02, 0.14, M.dark);
  } else if (type === 'BR') {
    part(0.05, 0.05, 0.09, 0, 0.075, -0.2, M.dark);
    part(0.035, 0.035, 0.035, 0, 0.105, -0.16, M.metal);
  } else {
    part(0.014, 0.05, 0.014, 0, 0.062, -0.5, M.metal);   // front post
    part(0.05, 0.045, 0.02, 0, 0.062, -0.05, M.dark);   // rear sight
  }
  // charging handle / bolt (kicks on shots)
  const bolt = part(0.02, 0.02, 0.1, 0.045, 0.03, -0.02, M.metal);
  gunParts.bolt = bolt;
  // hands (stylized)
  const handR = part(0.075, 0.1, 0.12, 0.005, -0.075, 0.05, M.hand);
  const handL = part(0.075, 0.1, 0.1, -0.005, -0.06, -0.32, M.hand);
  handL.rotation.x = 0.4; handR.rotation.x = 0.25;
  gunParts.handL = handL; gunParts.handR = handR;
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffdd88, transparent: true, opacity: 0.95, depthTest: false });
  // muzzle flash position per type
  const muzzleZ = type === 'SR' ? -0.72 : type === 'BR' ? -0.64 : -0.5;
  muzzleFlash = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 6), flashMat);
  muzzleFlash.rotation.x = Math.PI / 2;
  muzzleFlash.position.set(0, 0.012, muzzleZ);
  muzzleFlash.visible = false;
  muzzleFlash.userData.gun = true;
  muzzleFlash.renderOrder = 1000;
  gunGroup.add(muzzleFlash);
  gunGroup.traverse(function (o) { o.userData.gun = true; });
  camera.add(gunGroup);
}

// per-frame viewmodel pose
const _gunQ = new THREE.Quaternion();
function updateViewmodel(dt) {
  if (!gunGroup) return;
  const w = curW();
  const aimAds = adsDown() && !player.sprinting && gunSwitchT >= 1;
  adsAmount += ((aimAds ? 1 : 0) - adsAmount) * Math.min(1, 12 * dt);
  gunSwitchT = Math.min(1, gunSwitchT + dt * 3.5);
  const raise = (1 - gunSwitchT) * 0.25;
  const bob = player.bobAmp * 0.014;
  const swayX2 = Math.sin(player.bobPhase) * bob;
  const swayY2 = Math.abs(Math.cos(player.bobPhase)) * bob;
  // hip pose / ads pose lerp
  const hipX = 0.22, hipY = -0.2, hipZ = -0.05;
  const adsX = 0, adsY = -0.148, adsZ = 0.02;
  let px = hipX + (adsX - hipX) * adsAmount;
  let py = hipY + (adsY - hipY) * adsAmount;
  let pz = hipZ + (adsZ - hipZ) * adsAmount;
  // sprint pose
  const sprintPose = player.sprinting ? 1 : 0;
  px += sprintPose * 0.08 * (1 - adsAmount);
  py += sprintPose * -0.06 * (1 - adsAmount);
  // kick
  const kick = shotKick * 0.045;
  pz += kick; py += kick * 0.3;
  // sniper scope pose: pull gun up so ocular fills center; hide crosshair
  const scoped = w.type === 'SR' && adsAmount > 0.82;
  if (w.type === 'SR') {
    // scoped alignment: scope ocular at eye level
    py += adsAmount * 0.062;
    pz += adsAmount * 0.16;
    px += swayX * (1 - adsAmount * 0.5);
    py += swayY * (1 - adsAmount * 0.5);
  }
  // reload dip
  const s = curS();
  let reloadDip = 0, reloadRot = 0;
  if (s && s.reloading) {
    const p = s.reloadT / w.reload;
    const bump = Math.sin(p * Math.PI);
    reloadDip = bump * 0.09;
    reloadRot = bump * 0.5;
    if (gunParts.mag) gunParts.mag.position.y = -0.13 - (p < 0.4 ? p * 0.3 : Math.max(0, 0.55 - p) * 0.45);
  } else if (gunParts.mag) gunParts.mag.position.y = -0.13;
  gunGroup.position.set(px + swayX2 * (1 - adsAmount), py - swayY2 * (1 - adsAmount) - reloadDip - raise, pz);
  gunGroup.rotation.set(-reloadRot * 0.6 - player.pitch * 0.03, (0.06 - sprintPose * 0.35) * (1 - adsAmount), sprintPose * 0.3 * (1 - adsAmount));
  if (gunParts.bolt) gunParts.bolt.position.z = -0.02 + Math.min(0.06, shotKick * 0.05);
  // muzzle flash decay
  if (muzzleFlash && muzzleFlash.visible) {
    flashT -= dt * 12;
    if (flashT <= 0) muzzleFlash.visible = false;
  }
  // camera FOV: ads zoom (sniper much tighter)
  const sniperZoom = w.type === 'SR' ? 52 : 24;
  const targetFov = 72 - adsAmount * sniperZoom;
  if (Math.abs(camera.fov - targetFov) > 0.1) { camera.fov += (targetFov - camera.fov) * Math.min(1, 10 * dt); camera.updateProjectionMatrix(); }
  // scope overlay for BR / SR
  const scopeOv = $id('scoping-overlay');
  const wantScope = adsAmount > 0.75 && (w.type === 'BR' || w.type === 'SR');
  scopeOv.style.opacity = wantScope ? 1 : 0;
  scopeOv.classList.toggle('scope-sniper', w.type === 'SR');
  // sniper: hide gun viewmodel fully when scoped (overlay takes over), hide crosshair
  if (gunGroup) gunGroup.visible = !(scoped);
  const ch = $id('crosshair');
  if (ch) ch.style.opacity = (adsAmount > 0.75 && (w.type === 'BR' || w.type === 'SR')) ? 0 : 1;
  // steady indicator
  const steadyInd = $id('steady-ind');
  if (steadyInd) {
    steadyInd.style.opacity = (w.type === 'SR' && adsAmount > 0.8) ? 1 : 0;
    steadyInd.textContent = steadyActive ? 'STEADY · ' + Math.ceil(steadyT * 10) / 10 + 's' : (steadyT < 0.25 ? 'CATCH YOUR BREATH' : 'HOLD SHIFT TO STEADY');
    steadyInd.classList.toggle('steady-on', steadyActive);
  }
}
let flashT = 0;
function triggerMuzzleFlash() { if (muzzleFlash) { muzzleFlash.visible = true; muzzleFlash.rotation.z = Math.random() * Math.PI; flashT = 1; } }
