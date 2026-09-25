// ============ WEAPONS: STATE, BALLISTICS, RELOADS, MELEE ============
'use strict';
// ---- Weapon state ----
const PISTOL = CFG.weapons.findIndex(function (w) { return !!w.sidearm; });
const SNIPER = CFG.weapons.findIndex(function (w) { return !!w.carried; });
// Loadout: [primary, SV-98 (always carried), sidearm (or an Armory primary)]
const SIDE_SLOT = 2;
const weaponsOwned = [0, SNIPER, PISTOL];
let curWeapon = 0;              // 0 or 1 (slot)
let wState = [];                // per owned slot
function magSize(w) { return Math.round(w.mag * perkMul('mag')); }
function newWeaponState(w) {
  return { ammo: magSize(w), reserve: w.reserveMax, reloading: false, reloadT: 0, reloadDur: 0, reloadKind: '', sndStage: 0,
    nextShot: 0, chambered: true, cycleT: 0, heat: 0, shotIdx: 0, lastShotT: -9, shellT: 0, pumpAfter: false };
}
function initWeapons() {
  wState = [];
  for (let i = 0; i < weaponsOwned.length; i++) {
    const gi = weaponsOwned[i];
    if (gi < 0) { wState.push(null); continue; }
    wState.push(newWeaponState(CFG.weapons[gi]));
  }
}
function curW() { return CFG.weapons[weaponsOwned[curWeapon]]; }
function curS() { return wState[curWeapon]; }

function switchWeapon(slot) {
  if (slot === curWeapon || meleeT > 0) return;
  const n = weaponsOwned.length;
  const s = ((slot % n) + n) % n;
  if (weaponsOwned[s] < 0) return;
  if (curS()) { curS().reloading = false; }
  curWeapon = s;
  gunSwitchT = 0;   // raise animation timer
  buildViewmodel();
  updateHudAmmo();
  playSound('draw');
}

function tryReload() {
  const s = curS(), w = curW();
  if (!s || s.reloading || meleeT > 0 || s.reserve <= 0) return;
  if (s.ammo >= magSize(w)) return;
  s.reloading = true; s.reloadT = 0; s.sndStage = 0;
  if (w.type === 'SG') {
    s.reloadKind = 'shell';
    s.shellT = 0.42;                    // lift + first shell
    s.pumpAfter = s.ammo === 0;
    s.reloadDur = 0;
  } else {
    s.reloadKind = s.ammo > 0 ? 'tac' : 'empty';
    s.reloadDur = (s.reloadKind === 'empty' ? w.reloadEmpty : w.reload) * perkMul('reload');
  }
  updateHudAmmo();
  playSound('reload_out');
}
function finishReload(s) {
  s.reloading = false;
  s.reloadKind = '';
  updateHudAmmo();
}
function updateReload(s, w, dt) {
  s.reloadT += dt;
  if (s.reloadKind === 'shell') {
    s.shellT -= dt;
    if (s.shellT <= 0) {
      if (s.ammo < magSize(w) && s.reserve > 0) {
        s.ammo++; s.reserve--;
        playSound('shell_in');
        updateHudAmmo();
        s.shellT = w.reload * perkMul('reload');
      }
      if (s.ammo >= magSize(w) || s.reserve <= 0) {
        if (s.pumpAfter && s.sndStage === 0) { s.sndStage = 1; s.shellT = 0.35; playSound('pump'); s.chambered = true; return; }
        finishReload(s);
      }
    }
    return;
  }
  const p = s.reloadT / s.reloadDur;
  if (p > 0.55 && s.sndStage < 1) { s.sndStage = 1; playSound('reload_in'); }
  if (s.reloadKind === 'empty' && p > 0.82 && s.sndStage < 2) { s.sndStage = 2; playSound(w.type === 'SR' ? 'bolt' : 'charge'); }
  if (p >= 1) {
    // tactical reloads keep the round in the chamber (+1)
    const cap = magSize(w) + (s.reloadKind === 'tac' && w.chamber ? 1 : 0);
    const take = Math.min(cap - s.ammo, s.reserve);
    s.ammo += take; s.reserve -= take;
    s.chambered = true; s.cycleT = 0;
    finishReload(s);
  }
}

let lastSprintT = -9;
let fireSprintBlockUntil = 0;   // pressing fire cancels sprint (read by the player controller)
function updateWeapons(dt) {
  const s = curS(); if (!s) return;
  const w = curW();
  s.heat = Math.max(0, s.heat - dt * (w.type === 'LMG' ? 2.2 : 3.2));
  if (s.cycleT > 0) {
    const before = s.cycleT;
    s.cycleT -= dt;
    // eject the spent case mid-cycle (bolt / pump actions)
    if (before > s.cycleT && s.cycleT <= (w.bolt || w.pump || 0) * 0.55 && before > (w.bolt || w.pump || 0) * 0.55) {
      spawnCasing(camera.position, camera.quaternion, w.type === 'SG');
      playSound(w.bolt ? 'bolt' : 'pump');
    }
    if (s.cycleT <= 0) { s.cycleT = 0; s.chambered = true; }
  }
  if (player.sprinting) lastSprintT = gameT;
  if (mouse1Down && player.sprinting) fireSprintBlockUntil = gameT + 0.4;
  if (s.reloading) {
    // shotgun: firing interrupts a shell-by-shell reload
    if (mouse1Down && s.reloadKind === 'shell' && s.ammo > 0 && s.reloadT > 0.2 && s.chambered) finishReload(s);
    else updateReload(s, w, dt);
  }
  updateMelee(dt);
  // fire
  const ready = !s.reloading && !player.dead && started && !paused && gunSwitchT >= 1 && meleeT <= 0 && !player.mantle && !player.sprinting && gameT - lastSprintT > 0.12;
  if (mouse1Down && ready) {
    if (gameT >= s.nextShot && s.ammo > 0 && s.chambered) {
      if (!w.auto) mouse1Down = false;
      fireShot();
      if (typeof touchState !== 'undefined') touchState.tapFiring = false;
    } else if (gameT >= s.nextShot && s.ammo === 0) {
      if (!dryPlayed) { playSound('dry'); dryPlayed = true; }
      if (s.reserve > 0) tryReload();
    }
  } else if (!mouse1Down) { dryPlayed = false; }
  // grenade input is handled in updateGrenades() to support hold-to-charge
  if (pressed['KeyR']) tryReload();
  if (pressed['KeyV'] || pressed['KeyF']) tryMelee();
  if (pressed['Digit1'] && !perkMenuOpen()) switchWeapon(0);
  if (pressed['Digit2'] && !perkMenuOpen()) switchWeapon(1);
  if (pressed['Digit3'] && !perkMenuOpen()) switchWeapon(2);
  if (pressed['KeyX']) switchWeapon(curWeapon + 1);
}
let dryPlayed = false;

// ---- Ballistics ----
const raycaster = new THREE.Raycaster();
const _shootDir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _aimTgt = new THREE.Vector3();
const _camRight = new THREE.Vector3(), _camUp = new THREE.Vector3(), _camFwd = new THREE.Vector3();

function adsDown() { return !!keys['Mouse2'] && !player.sprinting && !player.dead && meleeT <= 0 && !player.mantle; }
let adsAmount = 0;   // 0..1 smooth
let gunSwitchT = 1;  // 1 = fully raised

// ---- Sniper scope state ----
const SWAY_USE = 5.5, STEADY_RECOVER = 1.4, STEADY_MAX = 3.5;
let swayPhase = 0, swayX = 0, swayY = 0;
let steadyT = STEADY_MAX; // remaining breath-hold time
let steadyActive = false;

function updateSway(dt) {
  swayPhase += dt;
  steadyActive = curW().type === 'SR' && adsAmount > 0.8 && !!keys['ShiftLeft'] && steadyT > 0;
  if (steadyActive) steadyT = Math.max(0, steadyT - dt);
  else steadyT = Math.min(STEADY_MAX, steadyT + dt * STEADY_RECOVER);
  const amp = CFG.assist.swayAmp * (steadyActive ? CFG.assist.steadyMul : 1) * (player.crouching ? 0.6 : 1);
  swayX = Math.sin(swayPhase * 1.7) * amp + Math.sin(swayPhase * 0.9) * amp * 0.6;
  swayY = Math.sin(swayPhase * 1.3 + 1.2) * amp * 0.8;
}
function isScoped() {
  return adsAmount > 0.82 && curW().type === 'SR';
}

const _assistTo = new THREE.Vector3();
const _assistToH = new THREE.Vector3();
const _assistBestTo = new THREE.Vector3();
const _assistNudged = new THREE.Vector3();

// ---- Aim assist (touch / gamepad): drift the crosshair gently onto the nearest enemy chest/head ----
function applyAimAssist(dir, from) {
  if (adsAmount < 0.8) return dir;
  let hasBest = false, bestAng = CFG.assist.angle * (steadyActive ? 1.6 : 1);
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _aimTgt.set(en.pos.x, en.pos.y + 1.15, en.pos.z);   // chest
    _assistTo.subVectors(_aimTgt, from).normalize();
    const ang = dir.angleTo(_assistTo);
    if (ang < bestAng) {
      bestAng = ang;
      _assistBestTo.copy(_assistTo);
      hasBest = true;
    }
    // head magnet (smaller box)
    _aimTgt.set(en.pos.x, en.pos.y + 1.72, en.pos.z);
    _assistToH.subVectors(_aimTgt, from).normalize();
    const angH = dir.angleTo(_assistToH);
    if (angH < bestAng * 0.55) {
      bestAng = angH * 1.8;
      _assistBestTo.copy(_assistToH);
      hasBest = true;
    }
  }
  if (!hasBest) return dir;
  const pull = Math.min(1, CFG.assist.strength * 0.25);
  _assistNudged.copy(dir).lerp(_assistBestTo, pull).normalize();
  return _assistNudged;
}
// bullet magnetism (touch / gamepad): at fire time, snap within a small cone
const _magTo = new THREE.Vector3();
function magnetizeBullet(dir, from) {
  let bestAng = CFG.assist.bulletAngle, found = false;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _aimTgt.set(en.pos.x, en.pos.y + 1.35, en.pos.z);
    _magTo.copy(_aimTgt).sub(from).normalize();
    const ang = dir.angleTo(_magTo);
    if (ang < bestAng) { bestAng = ang; dir.copy(_magTo); found = true; }
  }
  return dir;
}

// Current cone half-angle (radians): base x bloom x movement/air/stance modifiers.
function currentSpread() {
  const w = curW(), s = curS();
  const ads = adsAmount;
  let sp = w.spread + (w.adsSpread - w.spread) * ads;
  const moveK = Math.min(1, hSpeedForSpread / 5);
  sp *= 1 + (s ? s.heat : 0) * (w.type === 'SR' ? 0 : 1);
  sp *= 1 + moveK * (ads > 0.5 ? 0.6 : 1.1);
  if (!player.onGround) sp *= 2.2;
  if (player.crouching && player.onGround) sp *= 0.8;
  if (w.type === 'SR' && ads > 0.8) sp = w.adsSpread * (steadyActive ? 0.5 : 1) * (1 + moveK * 8);
  return sp * perkMul('spread');
}
function distanceFalloff(w, dist) {
  if (dist <= w.r0) return 1;
  if (dist >= w.r1) return w.minMul;
  return 1 + (w.minMul - 1) * (dist - w.r0) / (w.r1 - w.r0);
}
// How much bullet energy survives passing through a surface (0 = stops it).
// Concrete / brick can only be crossed by weapons with wallPen >= wall thickness.
const PEN_MUL = { wood: 0.65, glass: 0.9, metal: 0.45, concrete: 0, brick: 0, ground: 0 };
// Thickness of the solid the ray just entered, measured on the collider AABB that
// contains the hit point (slab test from the entry point along the ray).
const _exitP = new THREE.Vector3();
function wallThickness(point, dir) {
  let best = null;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (point.x < c.min.x - 0.03 || point.x > c.max.x + 0.03 || point.y < c.min.y - 0.03 || point.y > c.max.y + 0.03 || point.z < c.min.z - 0.03 || point.z > c.max.z + 0.03) continue;
    let tExit = Infinity;
    for (const ax of ['x', 'y', 'z']) {
      const d = dir[ax];
      if (Math.abs(d) < 1e-6) continue;
      const t = ((d > 0 ? c.max[ax] : c.min[ax]) - point[ax]) / d;
      if (t < tExit) tExit = t;
    }
    if (tExit > 0 && (!best || tExit < best)) best = tExit;
  }
  return best === null ? 0.06 : best;   // no collider: a thin decorative surface
}
// Per-shot context for scoring bonuses (wallbang, collateral).
const bulletCtx = { wallbang: false, kills: 0 };
const _tmpExitN = new THREE.Vector3();
const _bulletTargets = [];
const _muzzleW = new THREE.Vector3();
const _tracerEnd = new THREE.Vector3();
let shotHitThisTrigger = false;
function traceBullet(from, dir, w, showTracer) {
  raycaster.set(from, dir);
  raycaster.far = w.range;
  _bulletTargets.length = 0;
  for (let i = 0; i < enemies.length; i++) {
    if (enemies[i].dead) { if (enemies[i].ragdoll) _bulletTargets.push(enemies[i].ragdoll.container); continue; }
    if (enemies[i].parts && enemies[i].parts.group) _bulletTargets.push(enemies[i].parts.group);
  }
  const worldHits = raycaster.intersectObjects(raycastColliders, true);
  const enemyHits = _bulletTargets.length ? raycaster.intersectObjects(_bulletTargets, true) : [];
  let power = 1, pens = w.pen, endDist = w.range, wi = 0, ei = 0, skipUntil = -1;
  const seen = [];
  bulletCtx.wallbang = false;
  while (wi < worldHits.length || ei < enemyHits.length) {
    const useEnemy = ei < enemyHits.length && (wi >= worldHits.length || enemyHits[ei].distance <= worldHits[wi].distance);
    const h = useEnemy ? enemyHits[ei++] : worldHits[wi++];
    if (!useEnemy && h.distance < skipUntil) continue;   // inner faces of a wall we already crossed
    if (useEnemy) {
      const en = h.object.userData.enemyRef;
      if (en && en.dead && en.ragdoll && seen.indexOf(en) < 0) {
        // shooting a corpse shoves the ragdoll; the round carries on
        seen.push(en);
        ragdollHit(en, h.point, dir, (w.impulse || 2.2) * 1.4 * power);
        spawnBlood(h.point, false, dir);
        continue;
      }
      if (!en || en.dead || seen.indexOf(en) >= 0) continue;
      seen.push(en);
      // headshot if any hit on this enemy within 0.35 m of the entry is the head box
      let isHead = !!h.object.userData.isHead;
      for (let k = ei; k < enemyHits.length && !isHead; k++) {
        const o = enemyHits[k];
        if (o.distance - h.distance > 0.35) break;
        if (o.object.userData.enemyRef === en && o.object.userData.isHead) isHead = true;
      }
      const dmg = w.dmg * (isHead ? w.headMul : h.object.userData.isLegs ? 0.75 : 1) * distanceFalloff(w, h.distance) * power * perkMul('damage');
      en.hitImpulse = (w.impulse || 2.2) * power;
      damageEnemy(en, dmg, h.point, isHead, dir);
      shotHitThisTrigger = true;
      // the sniper round keeps going through heads and bodies alike
      if (pens > 0 && (!isHead || w.type === 'SR')) { pens--; power *= w.type === 'SR' ? 0.8 : 0.55; continue; }
      endDist = h.distance;
      break;
    }
    if (h.object.userData.barrelRef) damageBarrel(h.object.userData.barrelRef, w.dmg * power);
    const surf = surfaceOf(h.object);
    spawnImpact(h.point, h.face ? h.face.normal : null, h.object);
    if (h.face && h.face.normal && surf !== 'glass') spawnDecal(h.point, h.face.normal, h.object);
    let pm = PEN_MUL[surf] || 0;
    const thick = wallThickness(h.point, dir);
    if (pm > 0 && thick > 1.3) pm = 0;
    if (!pm && (surf === 'concrete' || surf === 'brick' || surf === 'metal') && thick <= (w.wallPen || 0)) pm = Math.max(0.35, 1 - thick * 0.55);
    if (pens > 0 && pm > 0) {
      pens--; power *= pm;
      if (thick > 0.1) {
        // exit wound on the far side
        _exitP.copy(h.point).addScaledVector(dir, thick + 0.01);
        _tmpExitN.copy(dir);
        fxImpact(_exitP, _tmpExitN, surf);
        placeDecal(DECAL, _exitP, _tmpExitN, 0.16);
        bulletCtx.wallbang = true;
      }
      skipUntil = h.distance + thick + 0.02;
      continue;
    }
    if (surf === 'metal' && Math.random() < 0.25) playSound3D('ricochet', h.point.x, h.point.y, h.point.z);
    endDist = h.distance;
    break;
  }
  _tracerEnd.copy(from).addScaledVector(dir, endDist);
  if (showTracer) spawnTracer(muzzleWorldPos(_muzzleW), _tracerEnd, w.type === 'SR' ? 'sniper' : undefined);
  if (w.type === 'SR') sniperTrail(muzzleWorldPos(_muzzleW), _tracerEnd);
  if (typeof bulletNearMiss === 'function') bulletNearMiss(from, dir, endDist, w.suppressed);
  bulletCtx.wallbang = false;
}

function fireShot() {
  const s = curS(), w = curW();
  shotsFired++;
  s.ammo--;
  s.nextShot = gameT + 60 / w.rpm;
  if (gameT - s.lastShotT > 0.35) s.shotIdx = 0;
  s.shotIdx++; s.lastShotT = gameT;
  if (w.bolt) { s.chambered = false; s.cycleT = w.bolt; }
  if (w.pump) { s.chambered = false; s.cycleT = w.pump; }
  camera.updateMatrixWorld();
  camera.getWorldPosition(_from);
  _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const spread = currentSpread();
  const pellets = w.pellets || 1;
  shotHitThisTrigger = false;
  const killsBefore = kills;
  for (let p = 0; p < pellets; p++) {
    // uniform sample inside the spread cone
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
    _shootDir.copy(_camFwd).addScaledVector(_camRight, Math.cos(a) * r).addScaledVector(_camUp, Math.sin(a) * r).normalize();
    if (pellets === 1 && lastInputDevice !== 'mouse') magnetizeBullet(_shootDir, _from);
    traceBullet(_from, _shootDir, w, pellets === 1 || p % 3 === 0);
  }
  if (shotHitThisTrigger) shotsHit++;
  const shotKills = kills - killsBefore;
  if (shotKills >= 2 && pellets === 1) { addScore(75 * shotKills, 'COLLATERAL x' + shotKills); playSound('headshot'); }
  s.heat = Math.min(1.6, s.heat + w.heat);
  // recoil: vertical climb + S-shaped horizontal drift (learnable pattern + a little noise)
  const rm = perkMul('recoil') * (adsAmount > 0.5 ? 0.8 : 1) * (player.crouching ? 0.85 : 1);
  const seed = weaponsOwned[curWeapon] * 1.7;
  // camera recoil feeds a target the view springs toward (smooth rise, smooth recovery)
  player.recoilTP += w.recoilV * (0.85 + Math.random() * 0.3) * rm;
  player.recoilTY += w.recoilH * (Math.sin(s.shotIdx * 0.55 + seed) * 0.8 + (Math.random() - 0.5) * 0.7) * rm;
  player.pitch += w.recoilV * (w.type === 'SR' ? 0.08 : 0.22) * rm;   // part of the climb stays (you pull it down)
  kickViewmodel(w);
  shotKick = Math.min(shotKick + 0.5, 1.4);
  // casing eject (bolt/pump weapons eject during their cycle)
  if (!w.bolt && !w.pump) spawnCasing(camera.position, camera.quaternion, false);
  triggerMuzzleFlash();
  flashMuzzleLight();
  muzzleWorldPos(_muzzleW);
  if (!w.suppressed) fxMuzzle(_muzzleW, _camFwd, w.type === 'SG' || w.type === 'SR');
  if (w.suppressed) playSound('shot_SMG'); else playSound('shot_' + w.type);
  if (w.type === 'SR') { setTimeout(function () { playSound('sniper_echo'); }, 260); postKick('aberration', 0.25); }
  if (typeof alertEnemiesTo === 'function') alertEnemiesTo(_from, w.suppressed ? 14 : 55);
  addTrauma(w.type === 'SG' || w.type === 'SR' ? 0.12 : 0.025);
  updateHudAmmo();
}
let hSpeedForSpread = 0;
let shotKick = 0;

// ---- Melee (V / F): knife slash, backstabs are lethal ----
let meleeT = 0, meleeHitDone = false, meleeCd = 0;
const MELEE_DUR = 0.5;
function tryMelee() {
  if (meleeT > 0 || meleeCd > 0 || player.dead || !started || paused) return;
  const s = curS();
  if (s && s.reloading) finishReloadCancel(s);
  meleeT = MELEE_DUR; meleeHitDone = false; meleeCd = 0.75;
  playSound('knife');
}
function finishReloadCancel(s) { s.reloading = false; s.reloadKind = ''; updateHudAmmo(); }
const _meleeRay = new THREE.Raycaster();
function updateMelee(dt) {
  meleeCd = Math.max(0, meleeCd - dt);
  if (meleeT <= 0) return;
  meleeT -= dt;
  if (!meleeHitDone && meleeT < MELEE_DUR - 0.14) {
    meleeHitDone = true;
    _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    let best = null, bestD = 2.4;
    for (let i = 0; i < enemies.length; i++) {
      const en = enemies[i];
      if (en.dead) continue;
      const dx = en.pos.x - player.pos.x, dz = en.pos.z - player.pos.z, d = Math.hypot(dx, dz);
      const feet = player.pos.y - eyeHeight();
      if (d > bestD || Math.abs(en.pos.y - feet) > 1.6) continue;
      if ((dx * _camFwd.x + dz * _camFwd.z) / (d || 1) < 0.55) continue;
      best = en; bestD = d;
    }
    if (best) {
      // behind the target? (enemy facing away from the player)
      const fx = Math.sin(best.yaw), fz = Math.cos(best.yaw);
      const tx = player.pos.x - best.pos.x, tz = player.pos.z - best.pos.z, tl = Math.hypot(tx, tz) || 1;
      const backstab = (fx * tx + fz * tz) / tl < -0.2;
      const pt = new THREE.Vector3(best.pos.x, best.pos.y + 1.2, best.pos.z);
      best.blastImpulse = new THREE.Vector3(_camFwd.x * 4, 1.5, _camFwd.z * 4);
      damageEnemy(best, backstab ? 400 : 115, pt, false, _camFwd);
      playSound('knife_hit');
      addTrauma(0.18);
      if (backstab) addScore(40, 'BACKSTAB');
    } else {
      camera.getWorldPosition(_from);
      _meleeRay.set(_from, _camFwd); _meleeRay.far = 1.7;
      const hits = _meleeRay.intersectObjects(raycastColliders, true);
      if (hits.length) {
        spawnImpact(hits[0].point, hits[0].face ? hits[0].face.normal : null, hits[0].object);
        if (hits[0].object.userData.barrelRef) damageBarrel(hits[0].object.userData.barrelRef, 20);
        addTrauma(0.08);
      }
    }
  }
}

// ---- Viewmodel disposal (models are built in 32_viewmodels.js) ----
let gunGroup = null;
function disposeViewmodel() {
  if (!gunGroup) return;
  gunCamera.remove(gunGroup);
  gunGroup.traverse(function (o) {
    if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(function (m) { if (!m.userData.shared) m.dispose(); });
      else if (!o.material.userData.shared) o.material.dispose();
    }
  });
  gunGroup = null;
}
