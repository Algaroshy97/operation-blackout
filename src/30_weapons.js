// ============ WEAPONS, VIEWMODEL & SHOOTING ============
'use strict';
// ---- Weapon state ----
// indices into CFG.weapons; -1 = empty slot. Slots 0 and 1 are the deploy picks;
// slot 2 is the marksman rifle, carried on every run (key 3) unless it is
// already one of the picks.
const weaponsOwned = [0, -1, -1];
const MARKSMAN_SLOT = 2;
let curWeapon = 0;              // 0..2 (slot)
let wState = [];                // per owned slot: {ammo, reserve, reloading, reloadT, nextShot}
const FIRE_CLOCK_MAX_STEP = 0.5;
const MAX_FIRE_CATCHUP_SHOTS = 8;
let fireClockT = 0;
function marksmanIndex() {
  for (let i = 0; i < CFG.weapons.length; i++) if (CFG.weapons[i].type === 'SR') return i;
  return -1;
}
function freshWeaponState(slot) {
  const w = CFG.weapons[weaponsOwned[slot]];
  wState[slot] = { ammo: w.mag, reserve: w.reserveMax, reloading: false, reloadT: 0, nextShot: 0 };
  refreshWeaponStats(slot);
  wState[slot].ammo = wState[slot].eff.mag;
  wState[slot].reserve = wState[slot].eff.reserveMax;
}
// Keep slot 2 holding the marksman rifle exactly when the picks do not. Called
// whenever slot 0 or 1 changes (deploy, resume, secondary unlock, wall buy).
function syncMarksmanSlot() {
  const sr = marksmanIndex();
  const want = (sr < 0 || weaponsOwned[0] === sr || weaponsOwned[1] === sr) ? -1 : sr;
  if (weaponsOwned[MARKSMAN_SLOT] === want) return;
  weaponsOwned[MARKSMAN_SLOT] = want;
  if (want < 0) {
    wState[MARKSMAN_SLOT] = null;
    if (curWeapon === MARKSMAN_SLOT) { curWeapon = 0; if (gunGroup) buildViewmodel(); }
  } else if (wState.length) {
    freshWeaponState(MARKSMAN_SLOT);
  }
}
function initWeapons() {
  syncMarksmanSlot();
  wState = [];
  for (let i = 0; i < weaponsOwned.length; i++) {
    const gi = weaponsOwned[i];
    if (gi < 0) { wState.push(null); continue; }
    const w = CFG.weapons[gi];
    wState.push({ ammo: w.mag, reserve: w.reserveMax, reloading: false, reloadT: 0, nextShot: 0 });
  }
  refreshAllWeaponStats();
  // Attachments can raise the magazine, and a fresh deploy should start full.
  for (let i = 0; i < wState.length; i++) {
    if (!wState[i] || !wState[i].eff) continue;
    wState[i].ammo = wState[i].eff.mag;
    wState[i].reserve = wState[i].eff.reserveMax;
  }
}
// Returns the EFFECTIVE weapon, so an armory upgrade reaches every one of the
// ~30 call sites without touching any of them. `s.up` is a whole stat block built
// by CORE.armoryUpgrade; CFG.weapons is never mutated, because it is shared across
// runs and an in-place upgrade would leak into the next one.
// Returns the EFFECTIVE weapon: base, then the armory upgrade, then attachments.
// Cached on the slot rather than recomputed, because curW() is called many times a
// frame and applyAttachments allocates.
function curW() {
  const s = wState[curWeapon];
  if (s && s.eff) return s.eff;
  return (s && s.up) ? s.up : CFG.weapons[weaponsOwned[curWeapon]];
}
// Recompute a slot's effective stats. Must be called whenever the loadout, the
// weapon or the armory upgrade changes — there is no other path that updates it.
function refreshWeaponStats(slot) {
  const s = wState[slot];
  if (!s || weaponsOwned[slot] < 0) return;
  const base = s.up || CFG.weapons[weaponsOwned[slot]];
  s.eff = CORE.applyAttachments(base, getLoadout(weaponsOwned[slot]));
  // An extended magazine must not leave the weapon holding more than it can.
  if (s.ammo > s.eff.mag) s.ammo = s.eff.mag;
  if (s.reserve > s.eff.reserveMax) s.reserve = s.eff.reserveMax;
}
function refreshAllWeaponStats() { for (let i = 0; i < wState.length; i++) refreshWeaponStats(i); }
function curS() { return wState[curWeapon]; }

// Next owned slot in a direction (mouse wheel, touch SWAP), skipping empties.
function cycleWeapon(dir) {
  const n = weaponsOwned.length;
  for (let k = 1; k < n; k++) {
    const s = (((curWeapon + dir * k) % n) + n) % n;
    if (weaponsOwned[s] >= 0) { switchWeapon(s); return; }
  }
}
function switchWeapon(slot) {
  if (slot === curWeapon) return;
  const n = weaponsOwned.length;
  const s = ((slot % n) + n) % n;
  if (weaponsOwned[s] < 0) return;
  // BUG-05: this used to drop `reloading` with no rollback, no cue and no HUD
  // change, so a player who swapped mid-reload came back to an empty magazine
  // believing they had reloaded. Remember the progress and resume it on return.
  const prev = curS();
  if (prev && prev.reloading) {
    prev.reloading = false;
    prev.reloadPaused = true;        // keep reloadT; tryReload() picks it back up
  }
  if (prev) prev.nextShot = CORE.shotScheduleAfterInactive();
  curWeapon = s;
  const next = curS();
  if (next) next.nextShot = CORE.shotScheduleAfterInactive();
  if (next && next.reloadPaused) {
    next.reloadPaused = false;
    next.reloading = true;           // resume where it left off
    playSound('reload_out');
  }
  gunSwitchT = 0;   // raise animation timer
  buildViewmodel();
  updateHudAmmo();
  playSound('draw');
}

function tryReload() {
  const s = curS(); if (!s || s.reloading || s.ammo >= curW().mag || s.reserve <= 0) return;
  s.reloading = true;
  // Resume a reload that a weapon swap interrupted rather than restarting it.
  if (!s.reloadPaused) s.reloadT = 0;
  s.reloadPaused = false;
  updateHudAmmo();
  playSound('reload_out');
}

function updateWeapons(dt) {
  const s = curS(); if (!s) return;
  const w = curW();
  const wasReloading = s.reloading;
  if (s.reloading) {
    s.reloadT += dt;
    if (s.reloadT >= w.reload * CORE.perkReloadMul(perks)) {
      const need = w.mag - s.ammo;
      const take = Math.min(need, s.reserve);
      s.ammo += take; s.reserve -= take;
      s.reloading = false; s.reloadPaused = false;
      playSound('reload_in');
      updateHudAmmo();
    }
    s.nextShot = CORE.shotScheduleAfterInactive();
  }
  // fire: consume every automatic-fire deadline that elapsed since the last
  // render. The first shot keeps the existing immediate-fire behaviour.
  if (mouse1Down && !wasReloading && !s.reloading && !player.dead && started && !paused && gunSwitchT >= 1) {
    if (fireClockT >= s.nextShot && s.ammo > 0) {
      let due = s.nextShot === 0 ? 1
        : CORE.advanceShotSchedule(fireClockT, s.nextShot, 60 / w.rpm, MAX_FIRE_CATCHUP_SHOTS).shots;
      if (!w.auto) { due = Math.min(1, due); mouse1Down = false; }
      while (due-- > 0 && s.ammo > 0) fireShot(w.auto);
      if (s.ammo === 0 && s.reserve > 0) tryReload();
    } else if (fireClockT >= s.nextShot && s.ammo === 0) {
      if (!dryPlayed) { playSound('dry'); dryPlayed = true; }
      if (s.reserve > 0) tryReload();
    }
  } else {
    dryPlayed = false;
    s.nextShot = CORE.shotScheduleAfterInactive();
  }
  // Bloom recovers off the trigger, at the CURRENT stance's rate — using the
  // hipfire number while scoped would recover an ADS bloom far too fast.
  const bp0 = CORE.bloomParams(w.spread, w.adsSpread, adsDown());
  bloom = CORE.bloomDecay(bloom, dt, bp0.recover);
  if (meleeT > 0) meleeT = Math.max(0, meleeT - dt);
  if (meleeSwing > 0) meleeSwing = Math.max(0, meleeSwing - dt / CORE.MELEE_COOLDOWN);
  // KeyF became USE when stations landed, which is where CoD players expect it.
  if ((pressed['KeyV'] || pressed['__melee']) && meleeT <= 0 && !player.dead) doMelee();
  // grenade input is handled in updateGrenades() to support hold-to-charge
  if (pressed['KeyR']) tryReload();
  if (pressed['Digit1']) switchWeapon(0);
  if (pressed['Digit2']) switchWeapon(1);
  if (pressed['Digit3']) switchWeapon(MARKSMAN_SLOT);
}
let dryPlayed = false;

// ---- Ballistics ----
const raycaster = new THREE.Raycaster();
const _shootDir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _muzzleW = new THREE.Vector3();
const _to = new THREE.Vector3();
const _aimTgt = new THREE.Vector3();

function adsDown() { return !!keys['Mouse2'] && !player.sprinting && !player.dead; }
let adsAmount = 0;   // 0..1 smooth
let gunSwitchT = 1;  // 1 = fully raised

// ---- Sniper scope state ----
const SWAY_USE = 5.5, STEADY_RECOVER = CORE.STEADY_RECOVER, STEADY_MAX = CORE.STEADY_MAX;
let swayPhase = 0, swayX = 0, swayY = 0;
let steadyT = STEADY_MAX; // remaining breath-hold time
let steadyActive = false;
const _swayOut = { x: 0, y: 0 };

function updateSway(dt) {
  swayPhase += dt;
  const w = curW();
  steadyActive = CORE.isSteadyActive(w ? w.type : '', adsAmount, !!keys['ShiftLeft'], steadyT);
  steadyT = CORE.stepSteadyAim(steadyT, steadyActive, dt, STEADY_MAX, STEADY_RECOVER);
  const amp = CORE.swayAmplitude(CFG.assist.swayAmp, steadyActive, CFG.assist.steadyMul, w ? w.sway : 1);
  CORE.swayOffsets(swayPhase, amp, _swayOut);
  swayX = _swayOut.x;
  swayY = _swayOut.y;
}
function isScoped() {
  const w = curW();
  return CORE.isScoped(adsAmount, w ? w.type : '');
}

const _assistTo = new THREE.Vector3();
const _assistToH = new THREE.Vector3();
const _assistBestTo = new THREE.Vector3();
const _assistNudged = new THREE.Vector3();

// ---- Aim assist: when scoped (or ADS), drifting crosshair gently onto nearest enemy chest/head within a small angle ----
function applyAimAssist(dir, from) {
  if (adsAmount < CORE.ADS_SCOPE_THRESHOLD) return dir;
  let hasBest = false, bestAng = CORE.aimAssistAngle(CFG.assist.angle, steadyActive, 1.6);
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _aimTgt.set(en.pos.x, en.pos.y + 1.0, en.pos.z);   // chest centre of the corrected box
    _assistTo.subVectors(_aimTgt, from).normalize();
    const ang = dir.angleTo(_assistTo);
    if (ang < bestAng) {
      bestAng = ang;
      _assistBestTo.copy(_assistTo);
      hasBest = true;
    }
    // head magnet (smaller box)
    _aimTgt.set(en.pos.x, en.pos.y + 1.68, en.pos.z);   // head centre
    _assistToH.subVectors(_aimTgt, from).normalize();
    const angH = dir.angleTo(_assistToH);
    if (angH < bestAng * 0.55) {
      bestAng = angH * 1.8;
      _assistBestTo.copy(_assistToH);
      hasBest = true;
    }
  }
  if (!hasBest) return dir;
  // blend: partial pull per shot (bullet magnetism) + persistent visual nudge
  const pull = CORE.aimAssistPull(CFG.assist.strength, 0.25);
  _assistNudged.copy(dir).lerp(_assistBestTo, pull).normalize();
  return _assistNudged;
}
// bullet magnetism: at fire time, snap within a small cone
// Scratch vectors, not per-enemy clones: this runs on every shot, and the SMG
// fires 15 times a second.
const _magTo = new THREE.Vector3();
const _magBest = new THREE.Vector3();
function magnetizeBullet(dir, from) {
  let bestAng = CFG.assist.bulletAngle, found = false;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _aimTgt.set(en.pos.x, en.pos.y + 1.1, en.pos.z);    // centre mass
    _magTo.subVectors(_aimTgt, from).normalize();
    const ang = dir.angleTo(_magTo);
    if (ang < bestAng) { bestAng = ang; _magBest.copy(_magTo); found = true; }
  }
  return found ? _magBest : dir;
}

const _shotTargets = [];
const _tracerMissEnd = new THREE.Vector3();

function fireShot(preserveSchedule) {
  const s = curS(), w = curW();
  shotsFired++;
  s.ammo--;
  const interval = 60 / w.rpm;
  s.nextShot = preserveSchedule && s.nextShot > 0 ? s.nextShot + interval : fireClockT + interval;
  // Spread now carries BLOOM: it grows with every shot toward a per-stance cap and
  // recovers off the trigger. Previously hipfire spread was identical on shot 1 and
  // shot 30, so there was no reason to ever tap-fire and no cost to holding.
  const ads = adsDown();
  const bp = CORE.bloomParams(w.spread, w.adsSpread, ads);
  bp.perShot *= CORE.perkBloomMul(perks);      // STEADY AIM
  bp.cap *= CORE.perkBloomMul(perks);
  const spreadNow = CORE.effectiveSpread(ads ? w.adsSpread : w.spread, bloom,
    hSpeedForSpread, !player.onGround);
  bloom = CORE.bloomAfterShot(bloom, bp.perShot, bp.cap);
  camera.getWorldPosition(_from);
  // direction with random cone
  _shootDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _shootDir.x += (Math.random() - 0.5) * 2 * spreadNow;
  _shootDir.y += (Math.random() - 0.5) * 2 * spreadNow;
  _shootDir.z += (Math.random() - 0.5) * 2 * spreadNow * 0.3;
  _shootDir.normalize();
  // bullet magnetism (small snap onto enemy center-mass)
  _shootDir.copy(magnetizeBullet(_shootDir, _from));
  raycaster.set(_from, _shootDir);
  raycaster.far = w.range;

  // test enemies first (hitboxes + visible meshes)
  _shotTargets.length = 0;
  for (let i = 0; i < enemies.length; i++) {
    if (enemies[i].dead) continue;
    if (enemies[i].parts && enemies[i].parts.group) _shotTargets.push(enemies[i].parts.group);
  }
  const worldHits = raycaster.intersectObjects(worldRayTargets(_from, _shootDir, w.range), true);
  const enemyHits = raycaster.intersectObjects(_shotTargets, true);
  // Penetration is resolved against the collider AABBs rather than the rendered
  // meshes, and deliberately: the static arena is merged into batched meshes, so a
  // mesh raycast reports the entry AND exit faces of every box in a batch and
  // cannot tell one wall from two. The colliders are one entry per box and carry
  // the material tag.
  const penStart = CORE.penetrationPower(w.type) * (w.penetration || 1);
  const penWalk = CORE.penetrationWalk(_from.x, _from.y, _from.z,
    _shootDir.x, _shootDir.y, _shootDir.z, w.range, colliders, penStart);
  let hit = null, isEnemy = false, isHead = false, penMul = 1;
  if (enemyHits.length) {
    const m = CORE.penetrationMulAt(penWalk, enemyHits[0].distance);
    if (m > 0) {
      hit = enemyHits[0]; isEnemy = true;
      isHead = !!hit.object.userData.isHead;
      penMul = m;
    }
  }
  if (!isEnemy && worldHits.length) hit = worldHits[0];

  if (hit && isEnemy) {
    shotsHit++;
    const en = hit.object.userData.enemyRef;
    const dmg = CORE.playerBulletDamage(w.dmg, isHead, CFG.ai.headshotMul, hit.distance, w.range, penMul);
    damageEnemy(en, dmg, hit.point, isHead, penMul < 1);
  } else if (hit) {
    spawnImpact(hit.point, hit.face ? hit.face.normal : null, hit.object);
    if (hit.face && hit.face.normal) spawnDecal(hit.point, hit.face.normal, hit.object);   // v41: persistent bullet hole
  }
  spawnTracer(_from, hit ? hit.point : _tracerMissEnd.copy(_from).addScaledVector(_shootDir, w.range));
  // shell casing eject
  spawnCasing(camera.position, camera.quaternion);
  // sniper: brief unscope on shot (recoil re-chamber feel)
  if (w.type === 'SR') { adsAmount = CORE.sniperUnscopeAds(adsAmount); }
  // recoil
  // Learnable pattern, not noise. The old model was +/-20% random vertical and a
  // zero-mean random horizontal, so there was no shape to pull against and no
  // amount of practice could improve a burst. The same burst now traces the same
  // shape every time, with a few percent of jitter so it is not mechanical.
  recoilShot = CORE.recoilShotIndex(recoilShot, gameT - lastShotT);
  lastShotT = gameT;
  const rk = CORE.recoilAt(CORE.recoilPatternFor(w.type), recoilShot,
    (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
  player.recoilP += w.recoilV * rk.y;
  player.recoilY += w.recoilH * rk.x;
  shotKick = CORE.applyShotKick(shotKick);
  playSound(CORE.weaponFireSound(w ? w.type : ''));
  triggerMuzzleFlash();
  flashMuzzleLight();
  kickViewmodel(w, vmTune);
  if (muzzleFlash) fxMuzzle(muzzleWorldPos(_muzzleW), _shootDir, w.type === 'SR' || w.type === 'BR');
  // a heavy round leaves a hanging vapour trail you can read back to the shooter
  if (w.type === 'SR') sniperTrail(_from, hit ? hit.point : _tracerMissEnd);
  updateHudAmmo();
}
// ---- Melee ----
// A runner that had closed inside its 1.9 m stop distance had no counter but
// backpedalling, which is exactly the situation a knife exists to solve. Targets
// are filtered by a forward cone rather than taken nearest-first, so the swing
// goes where the player is looking.
function doMelee() {
  meleeT = CORE.MELEE_COOLDOWN;
  meleeSwing = 1;
  playSound('melee');
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  const idx = CORE.meleeTarget(enemies, player.pos.x, player.pos.z,
    dirX, dirZ, CORE.MELEE_REACH, CORE.MELEE_CONE);
  if (idx < 0) return;
  const en = enemies[idx];
  _meleePoint.set(en.pos.x, en.pos.y + 1.2, en.pos.z);
  damageEnemy(en, CORE.MELEE_DAMAGE, _meleePoint, false);
}

// Smooth ramp from full damage at 0.6 x range down to 0.65 x at max range. The old
// version was a binary step: an M4 did 26 damage at 71 m and 16.9 at 72 m, moving
// shots-to-kill from 4 to 6 across a single metre with no feedback to the player.
function distanceFalloff(dist, range) { return CORE.distanceFalloff(dist, range); }
let hSpeedForSpread = 0;
let shotKick = 0;

// ---- Recoil pattern + bloom state ----
// recoilShot indexes the current weapon's pattern; it resets after a gap off the
// trigger so shot 1 of every burst behaves like shot 1. bloom is carried in the
// same units as the weapon's base spread and simply adds to it.
let recoilShot = 0;
let lastShotT = -99;
let bloom = 0;
let _lastChOp = -1, _lastChGap = -1;
let _scopeOvEl = null, _chEl = null, _steadyIndEl = null;
const _scopeOvState = { active: null, isSniper: null };
const _steadyIndState = { visible: null, steadyActive: null, label: null };
let meleeT = 0;        // cooldown / lockout
let meleeSwing = 0;    // 1 -> 0 viewmodel thrust
const _meleeTargets = [];
const _meleePoint = new THREE.Vector3();

// ---- Viewmodel ----
// The models, materials, springs and animation live in 32_viewmodels.js. The gun
// is a child of gunCamera and renders in its own depth-tested pass after the world.
let gunGroup = null;
let muzzleFlash = null;
let gunParts = { bolt: null, mag: null, handL: null, handR: null };
let vmTune = null;

function buildViewmodel() {
  if (gunGroup) {
    gunCamera.remove(gunGroup);
    disposeGunModel(gunGroup);
  }
  gunGroup = new THREE.Group();
  const gi = weaponsOwned[curWeapon];
  const P = { bolt: null, mag: null, handL: null, handR: null };
  vmTune = buildGunModel(gunGroup, P, CFG.weapons[gi].type, getLoadout(gi));
  gunParts = P;
  muzzleFlash = vmFlash(gunGroup, vmTune.muzzleZ, vmTune.muzzleY);
  gunGroup.traverse(function (o) { o.userData.gun = true; });
  gunCamera.add(gunGroup);
}

// per-frame viewmodel pose
function updateViewmodel(dt) {
  if (!gunGroup) return;
  const w = curW();
  const aimAds = adsDown() && !player.sprinting && gunSwitchT >= 1;
  adsAmount = CORE.stepAdsTransition(adsAmount, aimAds, dt, CORE.perkAdsMul(perks), w ? w.adsSpeed : 1);
  gunSwitchT = CORE.stepGunSwitch(gunSwitchT, dt);

  const s = curS();
  const isSniper = w.type === 'SR';
  const scoped = isSniper && adsAmount > 0.82;
  const isRedMotion = typeof getSetting === 'function' ? !!getSetting('reducedMotion') : false;
  poseViewmodel(dt, gunGroup, gunParts, vmTune, w, s, isRedMotion);

  // muzzle flash decay
  if (muzzleFlash && muzzleFlash.visible) {
    flashT = CORE.stepMuzzleFlash(flashT, dt, CORE.VIEWMODEL_MUZZLE_FLASH_DECAY);
    if (flashT <= 0) muzzleFlash.visible = false;
  }
  // scope overlay for BR / SR
  const isSr = w.type === 'SR';
  const wantScope = CORE.isScopeOverlayActive(adsAmount, w.type);
  if (CORE.scopeOverlayChanged(_scopeOvState, wantScope, isSr)) {
    CORE.syncScopeOverlayState(_scopeOvState, wantScope, isSr);
    if (!_scopeOvEl) _scopeOvEl = $id('scoping-overlay');
    if (_scopeOvEl) {
      _scopeOvEl.style.opacity = wantScope ? '1' : '0';
      _scopeOvEl.classList.toggle('scope-sniper', isSr);
      if (!wantScope) {
        if (_lastSx !== null) { _scopeOvEl.style.setProperty('--sx', '0px'); _lastSx = null; }
        if (_lastSy !== null) { _scopeOvEl.style.setProperty('--sy', '0px'); _lastSy = null; }
      }
    }
  }
  // sniper: hide gun viewmodel fully when scoped (overlay takes over), hide crosshair
  if (gunGroup) gunGroup.visible = !(scoped);
  if (!_chEl) _chEl = $id('crosshair');
  if (_chEl) {
    const isScopedW = (w.type === 'BR' || w.type === 'SR');
    const isRedMotion = typeof getSetting === 'function' ? !!getSetting('reducedMotion') : false;
    const spreadNow = CORE.effectiveSpread(adsDown() ? w.adsSpread : w.spread, bloom, hSpeedForSpread, !player.onGround);
    const chOp = Math.round(CORE.crosshairOpacity(adsAmount, isScopedW, player.dead) * 100) / 100;
    const chGap = CORE.crosshairGapOffset(spreadNow, adsAmount, isRedMotion);
    if (chOp !== _lastChOp) {
      _lastChOp = chOp;
      _chEl.style.opacity = String(chOp);
    }
    if (chGap !== _lastChGap) {
      _lastChGap = chGap;
      _chEl.style.setProperty('--ch-gap', chGap + 'px');
    }
  }
  if (isSr && wantScope) updateMarksmanScope(dt);
  // steady indicator
  const steadyVis = CORE.isSteadyIndicatorVisible(w.type, adsAmount);
  const steadyLbl = steadyVis ? CORE.steadyIndicatorLabel(steadyActive, steadyT) : '';
  if (CORE.steadyIndicatorChanged(_steadyIndState, steadyVis, steadyActive, steadyLbl)) {
    CORE.syncSteadyIndicatorState(_steadyIndState, steadyVis, steadyActive, steadyLbl);
    if (!_steadyIndEl) _steadyIndEl = $id('steady-ind');
    if (_steadyIndEl) {
      _steadyIndEl.style.opacity = steadyVis ? '1' : '0';
      if (steadyVis) _steadyIndEl.textContent = steadyLbl;
      _steadyIndEl.classList.toggle('steady-on', !!steadyActive);
    }
  }
}
// Marksman scope extras: the eyebox shadow slides against the breath sway (so a
// steadied scope visibly settles), and a rangefinder reads the distance to
// whatever sits under the reticle, flagging a hostile. The ray is cheap but not
// free, so it runs at 10 Hz.
let _scopeRangeEl = null, _scopeRangeT = 0;
let _lastSx = null, _lastSy = null;
const _parallaxOut = { x: 0, y: 0, sx: '0.0px', sy: '0.0px' };
const _rfRay = new THREE.Raycaster();
const _rfFrom = new THREE.Vector3(), _rfDir = new THREE.Vector3();
const _rfTargets = [];
function updateMarksmanScope(dt) {
  if (!_scopeOvEl) return;
  const isRed = typeof getSetting === 'function' ? !!getSetting('reducedMotion') : false;
  CORE.scopeParallaxOffset(swayX, swayY, isRed, CORE.SCOPE_PARALLAX_MAX, CORE.SCOPE_PARALLAX_SCALE, _parallaxOut);
  if (CORE.scopeParallaxChanged(_lastSx, _lastSy, _parallaxOut.sx, _parallaxOut.sy)) {
    _lastSx = _parallaxOut.sx;
    _lastSy = _parallaxOut.sy;
    _scopeOvEl.style.setProperty('--sx', _parallaxOut.sx);
    _scopeOvEl.style.setProperty('--sy', _parallaxOut.sy);
  }
  const rfStep = CORE.stepRangefinderTimer(_scopeRangeT, dt, CORE.SCOPE_RANGE_INTERVAL);
  _scopeRangeT = rfStep.timer;
  if (!rfStep.ready) return;
  if (!_scopeRangeEl) _scopeRangeEl = $id('scope-range');
  if (!_scopeRangeEl) return;
  camera.getWorldPosition(_rfFrom);
  _rfDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _rfRay.set(_rfFrom, _rfDir); _rfRay.far = CORE.SCOPE_RANGE_MAX;
  let best = Infinity, hostile = false;
  const wh = _rfRay.intersectObjects(worldRayTargets(_rfFrom, _rfDir, CORE.SCOPE_RANGE_MAX), true);
  if (wh.length) best = wh[0].distance;
  _rfTargets.length = 0;
  for (let i = 0; i < enemies.length; i++) if (!enemies[i].dead) _rfTargets.push(enemies[i].parts.group);
  const eh = _rfRay.intersectObjects(_rfTargets, true);
  if (eh.length && CORE.isHostileTarget(eh[0].distance, best, 0.5)) { best = eh[0].distance; hostile = true; }
  const txt = CORE.rangefinderLabel(best, hostile);
  if (_scopeRangeEl.textContent !== txt) _scopeRangeEl.textContent = txt;
  _scopeRangeEl.classList.toggle('tgt', hostile);
}
let flashT = 0;
function triggerMuzzleFlash() {
  if (!muzzleFlash) return;
  muzzleFlash.visible = true;
  muzzleFlash.rotation.z = Math.random() * Math.PI;
  const k = 0.8 + Math.random() * 0.5;
  muzzleFlash.scale.set(k, k, 0.8 + Math.random() * 0.6);
  flashT = 1;
}
