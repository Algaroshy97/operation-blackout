// ============ SCORESTREAKS & FIELD UPGRADE ============
'use strict';
// registerKillT() already tracked a 4-second multi-kill window and did nothing with
// it but print RAMPAGE. This is the other streak — consecutive kills without going
// down — which is the one Call of Duty is actually known for.
//
// Everything here rides existing systems: the UAV reads the minimap that already
// draws every enemy, the airstrike reuses explodeGrenade(), and the sentry reuses
// hasLOS() pointed the other way.

let streakKills = 0;          // consecutive kills since the last down
const streakBank = [];        // earned, not yet used
let uavUntil = -99;
const sentries = [];
const SENTRY_RANGE = 26;
const SENTRY_ROF = 0.22;
const SENTRY_DMG = 22;

let fieldCharge = 0;
let runStreaksEarned = 0;   // career challenge counter, banked at end of run
const munitions = [];         // deployed munitions boxes

function resetStreaks() {
  streakKills = 0;
  streakBank.length = 0;
  uavUntil = -99;
  fieldCharge = 0;
  runStreaksEarned = 0;
  for (let i = sentries.length - 1; i >= 0; i--) scene.remove(sentries[i].m);
  sentries.length = 0;
  for (let i = munitions.length - 1; i >= 0; i--) scene.remove(munitions[i].m);
  munitions.length = 0;
  updateHudStreaks();
}

// ---- Earning -----------------------------------------------------------------
// Called from killEnemy(). Earned at EXACTLY the threshold, so a streak is banked
// once rather than re-granted on every kill past it.
function registerStreakKill() {
  streakKills++;
  const earned = CORE.streaksEarnedAt(streakKills);
  for (let i = 0; i < earned.length; i++) {
    streakBank.push(earned[i].key);
    runStreaksEarned++;
    showCenterMsg(earned[i].name + ' READY');
    playSound('powerup');
  }
  updateHudStreaks();
}
// Going down is what resets it. Taking damage does not: a streak you can only keep
// by not being shot at is a streak nobody sees.
function breakStreak() {
  streakKills = 0;
  updateHudStreaks();
}

// The field upgrade charges on damage DEALT, so it rewards fighting rather than
// waiting out a timer.
function addFieldCharge(dmg) {
  const was = CORE.fieldReady(fieldCharge);
  fieldCharge = CORE.fieldChargeAfter(fieldCharge, dmg);
  if (!was && CORE.fieldReady(fieldCharge)) {
    showCenterMsg(CORE.FIELD_UPGRADE.name + ' READY');
    playSound('powerup');
  }
  updateHudStreaks();
}

// ---- Using -------------------------------------------------------------------
function useStreak() {
  if (!streakBank.length) return false;
  const key = streakBank.shift();
  const def = CORE.streakByKey(key);
  if (key === 'uav') {
    uavUntil = gameT + def.dur;
    showCenterMsg('UAV ONLINE');
  } else if (key === 'airstrike') {
    callAirstrike();
  } else if (key === 'sentry') {
    deploySentry();
  }
  playSound('wave');
  updateHudStreaks();
  return true;
}

function useFieldUpgrade() {
  if (!CORE.fieldReady(fieldCharge)) return false;
  fieldCharge = 0;
  deployMunitions();
  updateHudStreaks();
  return true;
}

function uavActive() { return gameT < uavUntil; }

// ---- Precision airstrike ------------------------------------------------------
// Lands along the line the player is looking down, walking outward, so it is aimed
// rather than dropped on the player's own head.
function callAirstrike() {
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  const ox = player.pos.x + dirX * 14, oz = player.pos.z + dirZ * 14;
  showCenterMsg('AIRSTRIKE INBOUND');
  const id = runId;
  for (let i = 0; i < 6; i++) {
    setTimeout(function () {
      // The run can end mid-sequence; anything scheduled has to check (BUG-08).
      if (id !== runId || !started || player.dead) return;
      const x = ox + dirX * i * 5 + (Math.random() - 0.5) * 6;
      const z = oz + dirZ * i * 5 + (Math.random() - 0.5) * 6;
      if (Math.abs(x) > mapBounds || Math.abs(z) > mapBounds) return;
      _strikePos.set(x, 0.4, z);
      explodeGrenade(_strikePos);
    }, 700 + i * 260);
  }
}
const _strikePos = new THREE.Vector3();

// ---- Sentry gun ---------------------------------------------------------------
const sentryBodyGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const sentryBarrelGeo = new THREE.BoxGeometry(0.12, 0.12, 0.8);
const sentryMat = new THREE.MeshStandardMaterial({ color: 0x3a4a58, roughness: 0.5, metalness: 0.6 });
const _sentryFrom = new THREE.Vector3();
const _sentryTo = new THREE.Vector3();

function deploySentry() {
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  let x = player.pos.x + dirX * 2.2, z = player.pos.z + dirZ * 2.2;
  if (!CORE.isSpawnValid(x, z, colliders, 0.6, 1.8, 0.5)) { x = player.pos.x; z = player.pos.z; }
  const g = new THREE.Group();
  const body = new THREE.Mesh(sentryBodyGeo, sentryMat);
  body.position.y = 0.55;
  const barrel = new THREE.Mesh(sentryBarrelGeo, sentryMat);
  barrel.position.set(0, 0.6, -0.5);
  g.add(body); g.add(barrel);
  g.position.set(x, 0, z);
  g.castShadow = true;
  scene.add(g);
  sentries.push({ m: g, barrel: barrel, t: CORE.streakByKey('sentry').dur, cd: 0 });
  showCenterMsg('SENTRY DEPLOYED');
}

function updateSentries(dt) {
  for (let i = sentries.length - 1; i >= 0; i--) {
    const s = sentries[i];
    s.t -= dt;
    s.cd -= dt;
    if (s.t <= 0) { scene.remove(s.m); sentries.splice(i, 1); continue; }
    // Nearest enemy it can actually see. Same analytic slab test the AI uses,
    // pointed the other way — including through smoke, which cuts both ways.
    let best = null, bestD = SENTRY_RANGE;
    _sentryFrom.set(s.m.position.x, 0.6, s.m.position.z);
    for (let e = 0; e < enemies.length; e++) {
      const en = enemies[e];
      if (en.dead) continue;
      const d = CORE.horizDist(en.pos.x, en.pos.z, s.m.position.x, s.m.position.z);
      if (d >= bestD) continue;
      _sentryTo.set(en.pos.x, en.pos.y + 1.1, en.pos.z);
      if (CORE.segmentBlocked(_sentryFrom.x, _sentryFrom.y, _sentryFrom.z,
          _sentryTo.x, _sentryTo.y, _sentryTo.z, colliders, 0.25)) continue;
      if (CORE.smokeBlocks(_sentryFrom.x, _sentryFrom.y, _sentryFrom.z,
          _sentryTo.x, _sentryTo.y, _sentryTo.z, smokeVolumes())) continue;
      best = en; bestD = d;
    }
    if (!best) continue;
    s.m.rotation.y = Math.atan2(best.pos.x - s.m.position.x, best.pos.z - s.m.position.z) + Math.PI;
    if (s.cd > 0) continue;
    s.cd = SENTRY_ROF;
    _sentryTo.set(best.pos.x, best.pos.y + 1.1, best.pos.z);
    spawnTracer(_sentryFrom, _sentryTo);
    damageEnemy(best, SENTRY_DMG, _sentryTo.clone(), false);
    playSound('eshot');
  }
}

// ---- Munitions box ------------------------------------------------------------
const munitionGeo = new THREE.BoxGeometry(0.7, 0.45, 0.5);
const munitionMat = new THREE.MeshStandardMaterial({ color: 0x4a5a2f, roughness: 0.8 });

function deployMunitions() {
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  let x = player.pos.x + dirX * 1.8, z = player.pos.z + dirZ * 1.8;
  if (!CORE.isSpawnValid(x, z, colliders, 0.6, 1.8, 0.5)) { x = player.pos.x; z = player.pos.z; }
  const m = new THREE.Mesh(munitionGeo, munitionMat);
  m.position.set(x, 0.23, z);
  m.castShadow = true;
  scene.add(m);
  munitions.push({ m: m, t: CORE.FIELD_UPGRADE.dur, tick: 0 });
  showCenterMsg('MUNITIONS BOX');
}

function updateMunitions(dt) {
  for (let i = munitions.length - 1; i >= 0; i--) {
    const b = munitions[i];
    b.t -= dt;
    b.tick -= dt;
    if (b.tick <= 0 &&
        CORE.horizDist(player.pos.x, player.pos.z, b.m.position.x, b.m.position.z) < CORE.FIELD_UPGRADE.radius) {
      b.tick = 1.0;
      const s = curS();
      if (s) {
        const w = curW();
        s.reserve = Math.min(w.reserveMax, s.reserve + Math.round(w.mag * 0.5));
        updateHudAmmo();
      }
      if (grenades.count < CFG.grenade.count) { grenades.count++; updateHudAmmo(); }
      else if (equippedTactical && tacticalCount < TACTICAL_MAX) { tacticalCount++; updateHudAmmo(); }
    }
    if (b.t <= 0) { scene.remove(b.m); munitions.splice(i, 1); }
  }
}

function updateStreaks(dt) {
  if (!started || paused || player.dead) return;
  if (pressed['KeyZ'] || pressed['__streak']) useStreak();
  if (pressed['KeyB'] || pressed['__field']) useFieldUpgrade();
  updateSentries(dt);
  updateMunitions(dt);
}

// ---- HUD ---------------------------------------------------------------------
function updateHudStreaks() {
  const el = $id('streak-hud');
  if (!el) return;
  let s = '';
  for (let i = 0; i < streakBank.length; i++) {
    const d = CORE.streakByKey(streakBank[i]);
    if (d) s += '<span class="ready" title="' + d.name + '">' + d.short + '</span>';
  }
  if (CORE.fieldReady(fieldCharge)) s += '<span class="field">FLD</span>';
  const next = CORE.nextStreak(streakKills);
  if (next) s += '<span class="next">' + next.short + ' ' + streakKills + '/' + next.kills + '</span>';
  el.innerHTML = s;
}
