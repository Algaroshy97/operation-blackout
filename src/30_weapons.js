// ============ WEAPONS, VIEWMODEL & SHOOTING ============
'use strict';
// ---- Weapon state ----
// indices into CFG.weapons; -1 = empty slot. Slots 0 and 1 are the deploy picks;
// slot 2 is the marksman rifle, carried on every run (key 3) unless it is
// already one of the picks; slot 3 is the sidearm, always carried (key 4).
const weaponsOwned = [0, -1, -1, -1];
const MARKSMAN_SLOT = 2;
const SIDEARM_SLOT = 3;
// 0..3 (slot)
let curWeapon = 0;
// per owned slot: {ammo, reserve, reloading, reloadT, nextShot}
let wState = [];
const FIRE_CLOCK_MAX_STEP = 0.5;
const MAX_FIRE_CATCHUP_SHOTS = 8;
let fireClockT = 0;
// Sentinel returned by curW() when the player carries only the knife (Gun Game
// tier 19).  Every consumer of curW() already does optional-chaining or uses
// the value only for type/spread/recoil queries, all of which are safe with
// these defaults.  The type 'MELEE' is not in the viewmodel builder table, so
// buildGunModel falls back to vmBuildAR — but buildViewmodel() never calls it
// for a knife slot (it tears down the gun group instead), so this entry is
// purely for the HUD and gameplay-loop callers.
const _KNIFE_WEAPON_SENTINEL = Object.freeze({
  name: 'Knife', type: 'MELEE', dmg: 0, rpm: 0, mag: 0, reserveMax: 0,
  reload: 0, spread: 0, adsSpread: 0, recoilV: 0, recoilH: 0, range: 0,
  auto: false
});
function marksmanIndex() {
  for (let i = 0; i < CFG.weapons.length; i++) if (CFG.weapons[i].type === 'SR') return i;
  return -1;
}
function sidearmIndex() {
  for (let i = 0; i < CFG.weapons.length; i++) if (CFG.weapons[i].sidearm) return i;
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
  syncSidearmSlot();
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
// The sidearm slot is fixed: it only ever needs filling (first deploy, or a
// state that lost it), never swapping.
function syncSidearmSlot() {
  const pi = sidearmIndex();
  if (weaponsOwned[SIDEARM_SLOT] === pi) return;
  weaponsOwned[SIDEARM_SLOT] = pi;
  if (pi >= 0 && wState.length) freshWeaponState(SIDEARM_SLOT);
}
function initWeapons(options) {
  // Ladder modes own every slot; ordinary deploys still receive bonus weapons.
  if (!options || !options.restrictedSlots) syncMarksmanSlot();
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
  if (s && s.up) return s.up;
  // Gun Game knife tier: all weapon slots are -1, so CFG.weapons[-1] is
  // undefined.  Return the sentinel so every curW() caller has a safe object.
  const gi = weaponsOwned[curWeapon];
  return (gi >= 0) ? CFG.weapons[gi] : _KNIFE_WEAPON_SENTINEL;
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
  const isDead = typeof player !== 'undefined' && !!player.dead;
  const isDowned = typeof player !== 'undefined' && !!player.downed;
  const isSwitching = typeof gunSwitchT === 'number' && gunSwitchT < 1;
  if (typeof CORE !== 'undefined' && typeof CORE.canPlayerSwitchWeapon === 'function') {
    if (!CORE.canPlayerSwitchWeapon(isDead, isDowned, isSwitching)) return;
  }
  const n = weaponsOwned.length;
  for (let k = 1; k < n; k++) {
    const s = (((curWeapon + dir * k) % n) + n) % n;
    if (weaponsOwned[s] >= 0) { switchWeapon(s); return; }
  }
}
function switchWeapon(slot) {
  if (slot === curWeapon) return;
  const isDead = typeof player !== 'undefined' && !!player.dead;
  const isDowned = typeof player !== 'undefined' && !!player.downed;
  const isSwitching = typeof gunSwitchT === 'number' && gunSwitchT < 1;
  if (typeof CORE !== 'undefined' && typeof CORE.canPlayerSwitchWeapon === 'function') {
    if (!CORE.canPlayerSwitchWeapon(isDead, isDowned, isSwitching)) return;
  }
  const n = weaponsOwned.length;
  const s = ((slot % n) + n) % n;
  if (weaponsOwned[s] < 0) return;
  // BUG-05: this used to drop `reloading` with no rollback, no cue and no HUD
  // change, so a player who swapped mid-reload came back to an empty magazine
  // believing they had reloaded. Remember the progress and resume it on return.
  const prev = curS();
  if (prev && prev.reloading) {
    prev.reloading = false;
    // keep reloadT; tryReload() picks it back up
    prev.reloadPaused = true;
  }
  if (prev) prev.nextShot = CORE.shotScheduleAfterInactive();
  curWeapon = s;
  const next = curS();
  const curWpn = curW();
  if (next) next.nextShot = CORE.shotScheduleAfterInactive();
  if (next && next.reloadPaused) {
    next.reloadPaused = false;
    // resume where it left off
    next.reloading = true;
    playSound(CORE.reloadMagazineOutSound(curWpn ? curWpn.type : ''));
  }
  // raise animation timer
  gunSwitchT = 0;
  buildViewmodel();
  updateHudAmmo();
  playSound(CORE.weaponDrawSound(curWpn ? curWpn.type : ''));
}

const _reloadOut = { ammo: 0, reserve: 0, take: 0 };
const _shellOut = { ammo: 0, reserve: 0, loaded: false, done: false };

function tryReload() {
  const s = curS(), w = curW();
  const isDead = typeof player !== 'undefined' && !!player.dead;
  const isPlating = typeof plateT === 'number' && plateT > 0;
  if (!s || !w || !CORE.canPlayerReload(isDead, s.reloading, s.ammo, w.mag, s.reserve, isPlating)) return;
  s.reloading = true;
  // Resume a reload that a weapon swap interrupted rather than restarting it.
  if (!s.reloadPaused) {
    s.reloadT = 0;
    s.emptyReload = CORE.isEmptyReload(s.ammo);
  }
  s.reloadPaused = false;
  updateHudAmmo();
  playSound(CORE.reloadMagazineOutSound(w.type));
}

function updateWeapons(dt) {
  const s = curS(); if (!s) return;
  const w = curW();
  // A shotgun reload is shell by shell, and pulling the trigger with anything in
  // the tube stops it so the next frame can fire.
  if (w.shellReload && s.reloading && mouse1Down && s.ammo > 0) { s.reloading = false; s.reloadPaused = false; updateHudAmmo(); }
  const wasReloading = s.reloading;
  if (s.reloading && w.shellReload) {
    s.reloadT += dt;
    const perShell = CORE.effectiveReloadDuration(w.reload, CORE.perkReloadMul(perks), false, w.type);
    while (s.reloading && s.reloadT >= perShell) {
      s.reloadT -= perShell;
      CORE.loadShell(s.ammo, w.mag, s.reserve, _shellOut);
      s.ammo = _shellOut.ammo; s.reserve = _shellOut.reserve;
      if (_shellOut.loaded) playSound('shell_in');
      if (_shellOut.done) {
        s.reloading = false; s.reloadPaused = false;
        if (s.emptyReload) { playSound('pump'); s.emptyReload = false; }
      }
      updateHudAmmo();
    }
    s.nextShot = CORE.shotScheduleAfterInactive();
  } else if (s.reloading) {
    s.reloadT += dt;
    const reloadDur = CORE.effectiveReloadDuration(w.reload, CORE.perkReloadMul(perks), s.emptyReload, w ? w.type : '');
    if (CORE.isReloadComplete(s.reloadT, reloadDur)) {
      CORE.completeReload(s.ammo, w.mag, s.reserve, _reloadOut);
      s.ammo = _reloadOut.ammo;
      s.reserve = _reloadOut.reserve;
      s.reloading = false; s.reloadPaused = false;
      playSound(CORE.reloadMagazineInSound(w ? w.type : ''));
      if (s.emptyReload) {
        playSound(CORE.reloadBoltSound(w ? w.type : ''));
        s.emptyReload = false;
      }
      updateHudAmmo();
    }
    s.nextShot = CORE.shotScheduleAfterInactive();
  }
  // fire: consume every automatic-fire deadline that elapsed since the last
  // render. The first shot keeps the existing immediate-fire behaviour.
  const isPlating = typeof plateT === 'number' && plateT > 0;
  if (mouse1Down && !wasReloading && started && !paused && CORE.canPlayerFire(player.dead, s.reloading, gunSwitchT < 1, s.ammo, isPlating)) {
    if (player.sprinting) {
      const wasTac = typeof player.tacT === 'number' && player.tacT > 0;
      const hasFastHands = typeof CORE.hasPerk === 'function' ? CORE.hasPerk(perks, 'reload') : (perks && perks.indexOf('reload') >= 0);
      const stf = CORE.weaponSprintToFireTime(w ? w.type : '', wasTac, hasFastHands) * (w && w.stfMul > 0 ? w.stfMul : 1);
      player.sprinting = false;
      player.tacT = 0;
      s.nextShot = Math.max(s.nextShot, fireClockT + stf);
    }
    if (fireClockT >= s.nextShot && s.ammo > 0) {
      let due = s.nextShot === 0 ? 1
        : CORE.advanceShotSchedule(fireClockT, s.nextShot, CORE.weaponFireInterval(w.rpm), MAX_FIRE_CATCHUP_SHOTS).shots;
      if (!w.auto) { due = Math.min(1, due); mouse1Down = false; }
      while (due-- > 0 && s.ammo > 0) fireShot(w.auto);
      if (s.ammo === 0 && s.reserve > 0) tryReload();
    }
  } else if (mouse1Down && !wasReloading && !s.reloading && !player.dead && started && !paused && gunSwitchT >= 1 && s.ammo === 0 && !isPlating) {
    if (CORE.shouldQuickDrawSidearm(s.ammo, s.reserve, curWeapon, SIDEARM_SLOT, weaponsOwned[SIDEARM_SLOT] >= 0)) {
      mouse1Down = false;
      switchWeapon(SIDEARM_SLOT);
      if (curWeapon === SIDEARM_SLOT) gunSwitchT = CORE.SIDEARM_QUICK_DRAW;
    } else if (fireClockT >= s.nextShot) {
      if (!dryPlayed) { playSound(CORE.dryFireSound(w ? w.type : '')); dryPlayed = true; }
      if (s.reserve > 0) tryReload();
    }
  } else {
    dryPlayed = false;
    s.nextShot = CORE.shotScheduleAfterInactive();
  }
  // LMG barrels cool off the trigger, held or not
  for (let i = 0; i < wState.length; i++) {
    const ws = wState[i];
    if (ws && ws.heat > 0) ws.heat = CORE.lmgHeatDecay(ws.heat, dt, fireClockT - (ws.lastShotClock || 0));
  }
  // Bloom recovers off the trigger, at the CURRENT stance's rate — using the
  // hipfire number while scoped would recover an ADS bloom far too fast.
  const bp0 = CORE.bloomParams(w.spread, w.adsSpread, adsDown(), w ? w.type : '');
  bloom = CORE.bloomDecay(bloom, dt, bp0.recover);
  if (meleeT > 0) meleeT = Math.max(0, meleeT - dt);
  if (meleeSwing > 0) meleeSwing = Math.max(0, meleeSwing - dt / CORE.MELEE_COOLDOWN);
  // KeyF became USE when stations landed, which is where CoD players expect it.
  if ((pressed['KeyV'] || pressed['__melee']) && CORE.canPlayerMelee(player.dead, player.downed, meleeT)) doMelee();
  // grenade input is handled in updateGrenades() to support hold-to-charge
  if (pressed['KeyR']) tryReload();
  if (pressed['Digit1']) switchWeapon(0);
  if (pressed['Digit2']) switchWeapon(1);
  if (pressed['Digit3']) switchWeapon(MARKSMAN_SLOT);
  if (pressed['Digit4']) switchWeapon(SIDEARM_SLOT);
}
let dryPlayed = false;

// ---- Ballistics ----
const raycaster = new THREE.Raycaster();
const _shootDir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _muzzleW = new THREE.Vector3();
const _to = new THREE.Vector3();
const _aimTgt = new THREE.Vector3();

function adsDown() {
  const isDead = typeof player !== 'undefined' && !!player.dead;
  const isDowned = typeof player !== 'undefined' && !!player.downed;
  const isSprint = typeof player !== 'undefined' && !!player.sprinting;
  return !!keys['Mouse2'] && (typeof CORE !== 'undefined' && typeof CORE.canPlayerAds === 'function'
    ? CORE.canPlayerAds(isDead, isDowned, isSprint)
    : (!isSprint && !isDead && !isDowned));
}
// 0..1 smooth
let adsAmount = 0;
// 1 = fully raised
let gunSwitchT = 1;

// ---- Sniper scope state ----
const SWAY_USE = 5.5, STEADY_RECOVER = CORE.STEADY_RECOVER, STEADY_MAX = CORE.STEADY_MAX;
let swayPhase = 0, swayX = 0, swayY = 0;
// remaining breath-hold time
let steadyT = STEADY_MAX;
let steadyActive = false;
let _wasSteadyActive = false;
const _swayOut = { x: 0, y: 0 };

function updateSway(dt) {
  swayPhase += dt;
  const w = curW();
  steadyActive = CORE.isSteadyActive(w ? w.type : '', adsAmount, !!keys['ShiftLeft'], steadyT);
  steadyT = CORE.stepSteadyAim(steadyT, steadyActive, dt, STEADY_MAX, STEADY_RECOVER);
  const breathEvt = CORE.steadyAimBreathEvent(steadyActive, _wasSteadyActive, steadyT);
  if (breathEvt) playSound(breathEvt);
  _wasSteadyActive = steadyActive;
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

// Aim help may only ever pull toward an actor the shot could legitimately damage.
// TDM/FFA/Domination keep teammates inside the shared `enemies` roster, and the
// friendly-fire guard rejects damage on them — so they must not attract the reticle.
function isAssistAlly(actor) {
  if (!actor || typeof CORE === 'undefined' || typeof CORE.isFriendlyFire !== 'function') return false;
  if (typeof player === 'undefined' || !player) return false;
  return CORE.isFriendlyFire(player, actor);
}

// ---- Aim assist: when scoped (or ADS), drifting crosshair gently onto nearest enemy chest/head within a small angle ----
function applyAimAssist(dir, from) {
  if (adsAmount < CORE.ADS_SCOPE_THRESHOLD) return dir;
  let hasBest = false, bestCos = CORE.aimAssistMinCos(CFG.assist.angle, steadyActive, 1.6);
  const maxDistSq = CORE.AIM_ASSIST_MAX_DIST * CORE.AIM_ASSIST_MAX_DIST;
  const minCos = bestCos;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    if (isAssistAlly(en)) continue;
    const toX = en.pos.x - from.x, toZ = en.pos.z - from.z;
    if (!CORE.isTargetInAimAssistRange(toX, toZ, maxDistSq)) continue;
    if (!CORE.isAimCandidateInForwardSector(dir.x, dir.z, toX, toZ)) continue;
    // chest centre of the corrected box
    _aimTgt.set(en.pos.x, en.pos.y + CORE.AIM_ASSIST_CHEST_OFFSET, en.pos.z);
    _assistTo.subVectors(_aimTgt, from).normalize();
    const chestDot = dir.dot(_assistTo);
    if (CORE.isAimAssistCandidateCloser(chestDot, bestCos)) {
      bestCos = chestDot;
      _assistBestTo.copy(_assistTo);
      hasBest = true;
    }
    // head magnet (smaller box)
    // head centre
    _aimTgt.set(en.pos.x, en.pos.y + CORE.AIM_ASSIST_HEAD_OFFSET, en.pos.z);
    _assistToH.subVectors(_aimTgt, from).normalize();
    const headDot = dir.dot(_assistToH);
    if (CORE.isAimAssistHeadCandidateCos(headDot, bestCos, minCos, CORE.AIM_ASSIST_HEAD_PRIORITY)) {
      bestCos = headDot;
      _assistBestTo.copy(_assistToH);
      hasBest = true;
    }
  }
  if (!hasBest) return dir;
  // blend: partial pull per shot (bullet magnetism) + persistent visual nudge
  const pull = CORE.aimAssistPull(CFG.assist.strength, CORE.AIM_ASSIST_PULL_WEIGHT);
  _assistNudged.copy(dir).lerp(_assistBestTo, pull).normalize();
  return _assistNudged;
}
// bullet magnetism: at fire time, snap within a small cone
// Scratch vectors, not per-enemy clones: this runs on every shot, and the SMG
// fires 15 times a second.
const _magTo = new THREE.Vector3();
const _magBest = new THREE.Vector3();
function magnetizeBullet(dir, from) {
  const minCos = CORE.bulletMagnetMinCos(CFG.assist.bulletAngle);
  const maxDistSq = CORE.BULLET_MAGNET_MAX_DIST * CORE.BULLET_MAGNET_MAX_DIST;
  let bestCos = minCos, found = false;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    if (isAssistAlly(en)) continue;
    const toX = en.pos.x - from.x, toZ = en.pos.z - from.z;
    if (!CORE.isTargetInMagnetRange(toX, toZ, maxDistSq)) continue;
    if (!CORE.isAimCandidateInForwardSector(dir.x, dir.z, toX, toZ)) continue;
    // centre mass
    _aimTgt.set(en.pos.x, en.pos.y + CORE.BULLET_MAGNET_Y_OFFSET, en.pos.z);
    _magTo.subVectors(_aimTgt, from).normalize();
    const dotVal = dir.dot(_magTo);
    if (CORE.isMagnetCandidateCloser(dotVal, bestCos)) {
      bestCos = dotVal;
      _magBest.copy(_magTo);
      found = true;
    }
  }
  return found ? _magBest : dir;
}

const _shotTargets = [];
const _tracerMissEnd = new THREE.Vector3();
const _recoilOut = { x: 0, y: 0 };
const _spreadOut = { x: 0, y: 0, z: 0 };
const _kickOut = { pitchKick: 0, yawKick: 0 };
const _worldHitsOut = [];
const _enemyHitsOut = [];
const _rfWorldHitsOut = [];
const _rfEnemyHitsOut = [];

function fireShot(preserveSchedule) {
  const s = curS(), w = curW();
  if (typeof player !== 'undefined') player.spawnProtectionT = 0;
  shotsFired++;
  s.ammo--;
  const interval = CORE.weaponFireInterval(w.rpm);
  s.nextShot = preserveSchedule && s.nextShot > 0 ? s.nextShot + interval : fireClockT + interval;
  // Spread now carries BLOOM: it grows with every shot toward a per-stance cap and
  // recovers off the trigger. Previously hipfire spread was identical on shot 1 and
  // shot 30, so there was no reason to ever tap-fire and no cost to holding.
  const ads = adsDown();
  const bp = CORE.bloomParams(w.spread, w.adsSpread, ads, w ? w.type : '');
  // STEADY AIM
  bp.perShot *= CORE.perkBloomMul(perks);
  bp.cap *= CORE.perkBloomMul(perks);
  const isTacSprint = typeof player !== 'undefined' && typeof player.tacT === 'number' && player.tacT > 0;
  const stanceSpread = CORE.stanceSpreadMultiplier(!!player.crouching, !!player.sliding, !!player.sprinting, isTacSprint);
  const heatMul = w.heatPerShot ? CORE.lmgHeatSpreadMul(s.heat) : 1;
  const spreadNow = CORE.effectiveSpread(ads ? w.adsSpread : w.spread, bloom,
    hSpeedForSpread, !player.onGround, stanceSpread) * heatMul;
  bloom = CORE.bloomAfterShot(bloom, bp.perShot, bp.cap);
  camera.getWorldPosition(_from);
  // A shotgun traces every pellet through the same path as a rifle round, inside
  // a fixed cone; one shot counts once for accuracy however many pellets connect.
  const pellets = w.pellets > 1 ? w.pellets : 1;
  const cone = pellets > 1 ? CORE.pelletConeSpread(w.pelletSpread, spreadNow, ads) : spreadNow;
  let anyHit = false, lastHit = null;
  for (let p = 0; p < pellets; p++) {
    const r = traceRound(w, cone, pellets === 1);
    if (r.enemy) anyHit = true;
    lastHit = r.hit;
  }
  if (anyHit) shotsHit++;
  const hit = lastHit;
  // shell casing eject
  spawnCasing(camera.position, camera.quaternion, w ? w.type : '');
  if (w.cls === 'SG') {
    const pumpRun = runId;
    setTimeout(function () {
      if (runId === pumpRun && started && !paused && !player.dead) playSound('pump');
    }, CORE.SHOTGUN_PUMP_DELAY_MS);
  }
  finishShot(s, w, hit);
}

// One round (or one pellet) from the camera: spread, optional magnetism, the
// enemy/world raycasts with penetration, damage, impacts and the tracer. Returns
// the hit (or null) and whether it was an enemy.
const _roundOut = { hit: null, enemy: false };
function traceRound(w, spreadNow, magnetize) {
  // direction with random cone
  _shootDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  CORE.ballisticSpreadVector(_shootDir.x, _shootDir.y, _shootDir.z, spreadNow, Math.random(), Math.random(), Math.random(), _spreadOut);
  _shootDir.set(_spreadOut.x, _spreadOut.y, _spreadOut.z);
  // bullet magnetism (small snap onto enemy center-mass)
  if (magnetize) _shootDir.copy(magnetizeBullet(_shootDir, _from));
  raycaster.set(_from, _shootDir);
  raycaster.far = w.range;

  // test enemies first (hitboxes + visible meshes)
  _shotTargets.length = 0;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    if (typeof CORE !== 'undefined' && typeof CORE.isEnemyRayCandidate === 'function') {
      if (!CORE.isEnemyRayCandidate(_from.x, _from.y, _from.z, _shootDir.x, _shootDir.y, _shootDir.z, w.range, en.pos.x, en.pos.y, en.pos.z)) continue;
    }
    if (en.parts && en.parts.group) _shotTargets.push(en.parts.group);
  }

  _worldHitsOut.length = 0;
  const worldHits = raycaster.intersectObjects(worldRayTargets(_from, _shootDir, w.range), true, _worldHitsOut);
  _enemyHitsOut.length = 0;
  const enemyHits = raycaster.intersectObjects(_shotTargets, true, _enemyHitsOut);
  // Penetration is resolved against the collider AABBs rather than the rendered
  // meshes, and deliberately: the static arena is merged into batched meshes, so a
  // mesh raycast reports the entry AND exit faces of every box in a batch and
  // cannot tell one wall from two. The colliders are one entry per box and carry
  // the material tag.
  const penStart = CORE.bulletPenetrationPower(w.type, w.penetration);
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
    const en = hit.object.userData.enemyRef;
    const hsMul = CORE.weaponHeadshotMultiplier(w ? w.type : '', CFG.ai.headshotMul);
    const dmg = CORE.playerBulletDamage(w.dmg, isHead, hsMul, hit.distance, w.range, penMul, w ? w.type : '');
    damageEnemy(en, dmg, hit.point, isHead, penMul < 1, w ? w.type : 'AR', player);
    if (worldHits.length && CORE.shouldSpawnPenetrationCoverVfx(penMul, worldHits[0].distance, hit.distance)) {
      spawnImpact(worldHits[0].point, worldHits[0].face ? worldHits[0].face.normal : null, worldHits[0].object, null, w ? w.type : 'AR');
      if (worldHits[0].face && worldHits[0].face.normal) spawnDecal(worldHits[0].point, worldHits[0].face.normal, worldHits[0].object, w ? w.type : 'AR');
    }
  } else if (hit) {
    spawnImpact(hit.point, hit.face ? hit.face.normal : null, hit.object, null, w ? w.type : 'AR');
    // v41: persistent bullet hole
    if (hit.face && hit.face.normal) spawnDecal(hit.point, hit.face.normal, hit.object, w.type);
  }
  spawnTracer(_from, hit ? hit.point : _tracerMissEnd.copy(_from).addScaledVector(_shootDir, w.range), null, w ? w.type : 'AR');
  _roundOut.hit = hit; _roundOut.enemy = isEnemy;
  return _roundOut;
}

// Everything that happens once per trigger pull, after the round(s) are traced.
function finishShot(s, w, hit) {
  // sniper: brief unscope on shot (recoil re-chamber feel)
  if (w.type === 'SR') {
    adsAmount = CORE.sniperUnscopeAds(adsAmount);
    const firedRun = runId;
    setTimeout(function () {
      if (runId === firedRun && started && !paused && !player.dead) {
        playSound(CORE.sniperBoltSound());
      }
    }, CORE.SNIPER_BOLT_DELAY_MS);
  }
  // recoil
  // Learnable pattern, not noise. The old model was +/-20% random vertical and a
  // zero-mean random horizontal, so there was no shape to pull against and no
  // amount of practice could improve a burst. The same burst now traces the same
  // shape every time, with a few percent of jitter so it is not mechanical.
  recoilShot = CORE.recoilShotIndex(recoilShot, gameT - lastShotT);
  lastShotT = gameT;
  CORE.recoilAt(CORE.recoilPatternFor(w.type), recoilShot,
    (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, _recoilOut);
  const stanceMul = CORE.stanceRecoilMultiplier(!!player.crouching, !!player.sliding, !player.onGround);
  CORE.effectiveRecoilKick(w.recoilV, w.recoilH, _recoilOut.x, _recoilOut.y, stanceMul, _kickOut);
  if (w.heatPerShot) {
    _kickOut.pitchKick *= CORE.lmgHeatRecoilMul(s.heat);
    s.heat = CORE.lmgHeatAfterShot(s.heat, w.heatPerShot);
    s.lastShotClock = fireClockT;
    if (s.heat > 0.8) playSound('sizzle');
  }
  player.recoilP += _kickOut.pitchKick;
  const isSuppressed = !!(s && s.att && s.att.barrel === 'suppressor');
  const kickImp = CORE.weaponShotKickImpulse(w ? w.type : '', isSuppressed);
  shotKick = CORE.applyShotKick(shotKick, kickImp);
  playSound(CORE.weaponClassFireSound(w ? w.cls : '', w ? w.type : '', isSuppressed));
  const lowSnd = CORE.lowAmmoSound(s.ammo, w ? w.type : '');
  if (lowSnd) playSound(lowSnd);
  const emptySnd = CORE.chamberEmptySound(s.ammo, w ? w.type : '');
  if (emptySnd) playSound(emptySnd);
  triggerMuzzleFlash(w ? w.type : 'AR', isSuppressed);
  flashMuzzleLight(w ? w.type : 'AR', isSuppressed);
  kickViewmodel(w, vmTune);
  if (muzzleFlash) fxMuzzle(muzzleWorldPos(_muzzleW), _shootDir, w ? w.type : 'AR', isSuppressed);
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
  if (typeof player !== 'undefined') player.spawnProtectionT = 0;
  meleeT = CORE.MELEE_COOLDOWN;
  meleeSwing = 1;
  const isTac = typeof player !== 'undefined' && typeof player.tacT === 'number' && player.tacT > 0;
  playSound(CORE.meleeSwingSound(isTac, !!(player && player.sliding)));
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  const idx = CORE.meleeTarget(enemies, player.pos.x, player.pos.z,
    dirX, dirZ, CORE.MELEE_REACH, CORE.MELEE_CONE);
  if (idx < 0) {
    _meleeDir.set(dirX, 0, dirZ);
    raycaster.set(camera.position, _meleeDir);
    raycaster.far = CORE.MELEE_REACH;
    _worldHitsOut.length = 0;
    const wh = raycaster.intersectObjects(worldRayTargets(camera.position, _meleeDir, CORE.MELEE_REACH), true, _worldHitsOut);
    if (wh.length && CORE.canMeleeStrikeWorld(idx, wh[0].distance, CORE.MELEE_REACH)) {
      const srf = fxSurfaceFor(wh[0].object);
      spawnImpact(wh[0].point, wh[0].face ? wh[0].face.normal : null, wh[0].object, CORE.meleeSurfaceSound(srf));
    }
    return;
  }
  const en = enemies[idx];
  _meleePoint.set(en.pos.x, en.pos.y + 1.2, en.pos.z);
  const isBackstab = CORE.isMeleeBackstab(dirX, dirZ, en.yaw, player.pos.x, player.pos.z, en.pos.x, en.pos.z);
  const meleeDmg = CORE.playerMeleeDamage(CORE.MELEE_DAMAGE, isBackstab, !!player.sliding, !!player.sprinting, isTac);
  const hitSnd = CORE.meleeHitSound(isBackstab);
  if (hitSnd) playSound(hitSnd);
  damageEnemy(en, meleeDmg, _meleePoint, isBackstab, false, 'MELEE', player);
  CORE.meleeSlashNormal(player.yaw, _meleeNormOut);
  if (typeof fxMeleeSlash === 'function') fxMeleeSlash(_meleePoint, _meleeNormOut, isBackstab);
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
// cooldown / lockout
let meleeT = 0;
// 1 -> 0 viewmodel thrust
let meleeSwing = 0;
const _meleeTargets = [];
const _meleePoint = new THREE.Vector3();
const _meleeDir = new THREE.Vector3();
const _meleeNormOut = { x: 0, y: 0, z: 0 };

// ---- Viewmodel ----
// The models, materials, springs and animation live in 32_viewmodels.js. The gun
// is a child of gunCamera and renders in its own depth-tested pass after the world.
let gunGroup = null;
let muzzleFlash = null;
let gunParts = { bolt: null, mag: null, handL: null, handR: null };
let vmTune = null;

function buildViewmodel() {
  meleeSwing = 0;
  if (typeof knifeGroup !== 'undefined' && knifeGroup) knifeGroup.visible = false;
  if (gunGroup) {
    gunCamera.remove(gunGroup);
    disposeGunModel(gunGroup);
    gunGroup = null;
    vmTune = null;
    gunParts = { bolt: null, mag: null, handL: null, handR: null };
    muzzleFlash = null;
  }
  const gi = weaponsOwned[curWeapon];
  // Gun Game knife tier: no firearm to render.  The knife mesh lives in
  // knifeGroup (built lazily in 32_viewmodels.js) and is shown by
  // poseViewmodel during the melee swing.  Ensure it exists so the first
  // melee strike on the knife tier does not silently fail.
  if (gi < 0) {
    if (typeof buildKnife === 'function' && !knifeGroup) buildKnife();
    return;
  }
  gunGroup = new THREE.Group();
  const P = { bolt: null, mag: null, handL: null, handR: null };
  vmTune = buildGunModel(gunGroup, P, CFG.weapons[gi].cls || CFG.weapons[gi].type, getLoadout(gi));
  gunParts = P;
  muzzleFlash = vmFlash(gunGroup, vmTune.muzzleZ, vmTune.muzzleY);
  gunGroup.traverse(function (o) { o.userData.gun = true; });
  gunCamera.add(gunGroup);
}

// per-frame viewmodel pose
function updateViewmodel(dt) {
  if (typeof poseMeleeKnife === 'function') poseMeleeKnife();
  if (!gunGroup) return;
  const w = curW();
  const aimAds = adsDown() && !player.sprinting && gunSwitchT >= 1;
  const hasFastHands = typeof CORE.hasPerk === 'function' ? CORE.hasPerk(perks, 'reload') : (perks && perks.indexOf('reload') >= 0);
  const stanceAdsMul = CORE.stanceAdsSpeedMultiplier(!!(player && player.crouching), !!(player && player.sliding));
  adsAmount = CORE.stepAdsTransition(adsAmount, aimAds, dt, CORE.perkAdsMul(perks), CORE.weaponAdsSpeed(w ? w.type : '', w ? w.adsSpeed : undefined, stanceAdsMul));
  const s = curS();
  const isEmptySwap = !!(s && s.ammo === 0);
  gunSwitchT = CORE.stepGunSwitch(gunSwitchT, dt, CORE.weaponSwitchSpeed(w ? w.type : '', hasFastHands, isEmptySwap));
  const isSniper = w.type === 'SR';
  const scoped = isSniper && adsAmount > 0.82;
  const isRedMotion = typeof getSetting === 'function' ? !!getSetting('reducedMotion') : false;
  poseViewmodel(dt, gunGroup, gunParts, vmTune, w, s, isRedMotion);

  // muzzle flash decay
  if (muzzleFlash && muzzleFlash.visible) {
    flashT = CORE.stepMuzzleFlash(flashT, dt, CORE.VIEWMODEL_MUZZLE_FLASH_DECAY);
    if (flashT <= 0) {
      muzzleFlash.visible = false;
    } else {
      const ms = CORE.stepMuzzleFlashScale(_flashBaseScale.k, _flashBaseScale.z, flashT, _flashDecayScaleOut);
      muzzleFlash.scale.set(ms.x, ms.y, ms.z);
    }
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
    const isTacSprint = typeof player !== 'undefined' && typeof player.tacT === 'number' && player.tacT > 0;
    const stanceSpread = CORE.stanceSpreadMultiplier(!!player.crouching, !!player.sliding, !!player.sprinting, isTacSprint);
    const spreadNow = CORE.effectiveSpread(adsDown() ? w.adsSpread : w.spread, bloom, hSpeedForSpread, !player.onGround, stanceSpread);
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
  _rfWorldHitsOut.length = 0;
  const wh = _rfRay.intersectObjects(worldRayTargets(_rfFrom, _rfDir, CORE.SCOPE_RANGE_MAX), true, _rfWorldHitsOut);
  if (wh.length) best = wh[0].distance;
  _rfTargets.length = 0;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    if (typeof CORE !== 'undefined' && typeof CORE.isEnemyRayCandidate === 'function') {
      if (!CORE.isEnemyRayCandidate(_rfFrom.x, _rfFrom.y, _rfFrom.z, _rfDir.x, _rfDir.y, _rfDir.z, CORE.SCOPE_RANGE_MAX, en.pos.x, en.pos.y, en.pos.z)) continue;
    }
    if (en.parts && en.parts.group) _rfTargets.push(en.parts.group);
  }
  _rfEnemyHitsOut.length = 0;
  const eh = _rfRay.intersectObjects(_rfTargets, true, _rfEnemyHitsOut);

  if (eh.length && CORE.isHostileTarget(eh[0].distance, best, 0.5)) { best = eh[0].distance; hostile = true; }
  const txt = CORE.rangefinderLabel(best, hostile);
  if (_scopeRangeEl.textContent !== txt) _scopeRangeEl.textContent = txt;
  _scopeRangeEl.classList.toggle('tgt', hostile);
}
let flashT = 0;
let _flashBaseScale = { k: 1, z: 1 };
const _flashScaleOut = { k: 1, z: 1 };
const _flashDecayScaleOut = { x: 1, y: 1, z: 1 };

function triggerMuzzleFlash(weaponType, isSuppressed) {
  if (!muzzleFlash) return;
  muzzleFlash.visible = true;
  muzzleFlash.rotation.z = CORE.muzzleFlashRotation(Math.random());
  _flashBaseScale = CORE.muzzleFlashBaseScale(weaponType, isSuppressed, Math.random(), Math.random(), _flashScaleOut);
  muzzleFlash.scale.set(_flashBaseScale.k, _flashBaseScale.k, _flashBaseScale.z);
  flashT = 1;
}
