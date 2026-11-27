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
const activeAirstrikes = [];
const strikeShockwaves = [];
let airstrikeTargeting = false;
const airstrikeHover = { active: false, cx: 75, cy: 75, worldX: 0, worldZ: 0, valid: false, reason: '' };
const SENTRY_RANGE = CORE.SENTRY_RANGE;
const SENTRY_ROF = CORE.SENTRY_ROF;
const SENTRY_DMG = CORE.SENTRY_DMG;

let fieldCharge = 0;
let runStreaksEarned = 0;   // career challenge counter, banked at end of run
const munitions = [];         // deployed munitions boxes

function isAirstrikeTargeting() { return airstrikeTargeting; }
function hasActiveAirstrikes() { return activeAirstrikes.length > 0 || strikeShockwaves.length > 0; }

function clearAirstrikeVisuals() {
  for (let i = activeAirstrikes.length - 1; i >= 0; i--) {
    const st = activeAirstrikes[i];
    if (st.telegraph) scene.remove(st.telegraph);
    for (let j = 0; j < st.bombs.length; j++) {
      if (st.bombs[j].mesh) scene.remove(st.bombs[j].mesh);
    }
  }
  activeAirstrikes.length = 0;
  for (let i = strikeShockwaves.length - 1; i >= 0; i--) {
    scene.remove(strikeShockwaves[i].m);
  }
  strikeShockwaves.length = 0;
}

function resetStreaks() {
  streakKills = 0;
  streakBank.length = 0;
  uavUntil = -99;
  fieldCharge = 0;
  runStreaksEarned = 0;
  cancelAirstrikeTargeting(true);
  clearAirstrikeVisuals();
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
    playSound(CORE.streakReadySound(earned[i].key));
  }
  updateHudStreaks();
}
// Going down is what resets it. Taking damage does not: a streak you can only keep
// by not being shot at is a streak nobody sees.
function breakStreak() {
  streakKills = 0;
  updateHudStreaks();
}

function awardFreeStreak(preferredStreak) {
  const choices = ['uav', 'airstrike', 'sentry'];
  const streak = preferredStreak || choices[Math.floor(Math.random() * choices.length)];
  streakBank.push(streak);
  runStreaksEarned = (typeof runStreaksEarned !== 'undefined' ? runStreaksEarned : 0) + 1;
  const d = (typeof CORE !== 'undefined' && typeof CORE.streakByKey === 'function') ? CORE.streakByKey(streak) : null;
  const name = d ? d.name : streak.toUpperCase();
  if (typeof showCenterMsg === 'function') showCenterMsg(name + ' READY');
  if (typeof updateHudStreaks === 'function') updateHudStreaks();
  return streak;
}

// The field upgrade charges on damage DEALT, so it rewards fighting rather than
// waiting out a timer.
function addFieldCharge(dmg) {
  const was = CORE.fieldReady(fieldCharge);
  fieldCharge = CORE.fieldChargeAfter(fieldCharge, dmg);
  if (!was && CORE.fieldReady(fieldCharge)) {
    showCenterMsg(CORE.FIELD_UPGRADE.name + ' READY');
    playSound(CORE.fieldUpgradeReadySound());
  }
  updateHudStreaks();
}

// ---- Using -------------------------------------------------------------------
function useStreak() {
  if (!streakBank.length) return false;
  if (streakBank[0] === 'airstrike') {
    if (airstrikeTargeting) { cancelAirstrikeTargeting(false); return true; }
    return beginAirstrikeTargeting();
  }
  const key = streakBank.shift();
  const def = CORE.streakByKey(key);
  if (key === 'uav') {
    uavUntil = gameT + def.dur;
    showCenterMsg('UAV ONLINE');
  } else if (key === 'sentry') {
    deploySentry();
  }
  playSound(CORE.streakActivationSound(key));
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

// ---- Precision airstrike (minimap-selected, world-frozen) --------------------
const _airstrikeCoordOut = { x: 0, z: 0 };
const _airstrikeTargetOut = { x: 0, z: 0 };
const _strikePos = new THREE.Vector3();
function callAirstrike() {
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  showCenterMsg('AIRSTRIKE INBOUND');
  const id = runId;
  const px = player.pos.x, pz = player.pos.z;
  for (let i = 0; i < CORE.AIRSTRIKE_BOMB_COUNT; i++) {
    const delay = CORE.airstrikeDelay(i, CORE.AIRSTRIKE_BASE_DELAY, CORE.AIRSTRIKE_STEP_DELAY);
    setTimeout(function () {
      if (id !== runId || !started || player.dead ||
          (typeof gameEnded !== 'undefined' && gameEnded) ||
          (typeof extraction !== 'undefined' && extraction && extraction.phase === 'cinematic')) return;
      const jx = (Math.random() - 0.5) * CORE.AIRSTRIKE_JITTER;
      const jz = (Math.random() - 0.5) * CORE.AIRSTRIKE_JITTER;
      CORE.airstrikeBombCoord(px, pz, dirX, dirZ, i, CORE.AIRSTRIKE_LEAD_DIST, CORE.AIRSTRIKE_SPACING, jx, jz, _airstrikeCoordOut);
      const x = _airstrikeCoordOut.x, z = _airstrikeCoordOut.z;
      if (Math.abs(x) > mapBounds || Math.abs(z) > mapBounds) return;
      _strikePos.set(x, 0.4, z);
      explodeGrenade(_strikePos);
    }, delay);
  }
}

function setAirstrikeUiOpen(open) {
  const mm = typeof $id === 'function' ? $id('minimap') : (typeof document !== 'undefined' ? document.getElementById('minimap') : null);
  const pr = typeof $id === 'function' ? $id('airstrike-prompt') : (typeof document !== 'undefined' ? document.getElementById('airstrike-prompt') : null);
  const prTxt = typeof $id === 'function' ? $id('airstrike-prompt-txt') : null;
  if (mm && mm.classList) mm.classList.toggle('targeting', !!open);
  if (pr && pr.style) pr.style.display = open ? 'flex' : 'none';
  if (open && prTxt) {
    prTxt.textContent = (typeof IS_TOUCH !== 'undefined' && IS_TOUCH)
      ? 'TAP MINIMAP FOR AIRSTRIKE'
      : 'CLICK MINIMAP TO STRIKE · RMB/ESC CANCEL';
  }
}

function beginAirstrikeTargeting() {
  if (streakBank[0] !== 'airstrike' || !started || paused || player.dead || player.downed) return false;
  airstrikeTargeting = true;
  airstrikeHover.active = false;
  setAirstrikeUiOpen(true);
  if (typeof clearInputState === 'function') clearInputState();
  if (!(typeof IS_TOUCH !== 'undefined' && IS_TOUCH) && typeof document !== 'undefined' && document.exitPointerLock) {
    try { document.exitPointerLock(); } catch (e) {}
  }
  updateHudStreaks();
  if (typeof drawMinimap === 'function') drawMinimap();
  return true;
}

function cancelAirstrikeTargeting(silent) {
  if (typeof airstrikeTargeting === 'undefined' || !airstrikeTargeting) return false;
  airstrikeTargeting = false;
  airstrikeHover.active = false;
  setAirstrikeUiOpen(false);
  updateHudStreaks();
  if (typeof drawMinimap === 'function') drawMinimap();
  if (!silent && !(typeof IS_TOUCH !== 'undefined' && IS_TOUCH) &&
      typeof started !== 'undefined' && started && !paused && !player.dead &&
      !(typeof gameEnded !== 'undefined' && gameEnded) &&
      typeof canvas !== 'undefined' && canvas && typeof canvas.requestPointerLock === 'function') {
    try { canvas.requestPointerLock(); } catch (e) {}
  }
  return true;
}

function evalAirstrikeMinimapPoint(localX, localY, width, height) {
  const W = 150, R = 75;
  const w = width > 0 ? width : W;
  const h = height > 0 ? height : W;
  const cx = (localX / w) * W;
  const cy = (localY / h) * W;
  const dx = cx - R, dy = cy - R;
  const discNormSq = (dx * dx + dy * dy) / (R * R);
  const scale = CORE.minimapScale(R, CFG.world.size, 8);
  CORE.minimapScreenToWorld(cx, cy, R, player.pos.x, player.pos.z, player.yaw, scale, _airstrikeTargetOut);
  const bounds = typeof mapBounds === 'number' ? mapBounds : 43;
  const check = CORE.validateAirstrikeTarget(_airstrikeTargetOut.x, _airstrikeTargetOut.z, player.pos.x, player.pos.z, discNormSq, CORE.AIRSTRIKE_MAX_RANGE, bounds);
  airstrikeHover.active = true;
  airstrikeHover.cx = cx;
  airstrikeHover.cy = cy;
  airstrikeHover.worldX = _airstrikeTargetOut.x;
  airstrikeHover.worldZ = _airstrikeTargetOut.z;
  airstrikeHover.valid = check.valid;
  airstrikeHover.reason = check.reason;
  return check;
}

function confirmAirstrikeMinimapPoint(localX, localY, width, height) {
  if (!airstrikeTargeting) return false;
  const check = evalAirstrikeMinimapPoint(localX, localY, width, height);
  if (!check.valid) {
    if (typeof showCenterMsg === 'function') showCenterMsg(check.reason === 'bounds' ? 'INVALID TARGET' : 'OUT OF RANGE');
    playSound('click');
    if (typeof drawMinimap === 'function') drawMinimap();
    return false;
  }
  const idx = streakBank.indexOf('airstrike');
  if (idx < 0) { cancelAirstrikeTargeting(false); return false; }
  streakBank.splice(idx, 1);
  const frozenX = airstrikeHover.worldX;
  const frozenZ = airstrikeHover.worldZ;
  airstrikeTargeting = false;
  airstrikeHover.active = false;
  setAirstrikeUiOpen(false);
  launchAirstrikeAt(frozenX, frozenZ, player.yaw);
  playSound(CORE.streakActivationSound('airstrike'));
  updateHudStreaks();
  if (typeof drawMinimap === 'function') drawMinimap();
  if (!(typeof IS_TOUCH !== 'undefined' && IS_TOUCH) &&
      typeof started !== 'undefined' && started && !paused && !player.dead &&
      !(typeof gameEnded !== 'undefined' && gameEnded) &&
      typeof canvas !== 'undefined' && canvas && typeof canvas.requestPointerLock === 'function') {
    try { canvas.requestPointerLock(); } catch (e) {}
  }
  return true;
}

let _strikeRingGeo = null, _strikeDiscGeo = null, _strikeShellGeo = null, _strikeWaveGeo = null;
function strikeGeos() {
  if (!_strikeRingGeo) {
    _strikeRingGeo = new THREE.RingGeometry(0.88, 1.0, 36);
    _strikeDiscGeo = new THREE.CircleGeometry(1.0, 32);
    _strikeShellGeo = new THREE.CylinderGeometry(0.14, 0.22, 1.4, 8);
    _strikeWaveGeo = new THREE.RingGeometry(0.75, 1.0, 28);
  }
}

function makeAirstrikeTelegraph(tx, tz, zoneR) {
  strikeGeos();
  const g = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff4528, transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(_strikeRingGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.scale.set(zoneR, zoneR, 1);
  const discMat = new THREE.MeshBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
  const disc = new THREE.Mesh(_strikeDiscGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.scale.set(zoneR, zoneR, 1);
  const innerMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const inner = new THREE.Mesh(_strikeRingGeo, innerMat);
  inner.rotation.x = -Math.PI / 2;
  inner.scale.set(1.6, 1.6, 1);
  g.add(disc); g.add(ring); g.add(inner);
  g.position.set(tx, 0.08, tz);
  scene.add(g);
  return g;
}

function makeStrikeShellMesh() {
  strikeGeos();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffb84a });
  const m = new THREE.Mesh(_strikeShellGeo, mat);
  m.visible = false;
  scene.add(m);
  return m;
}

function spawnStrikeShockwave(x, z) {
  strikeGeos();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff9840, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
  const m = new THREE.Mesh(_strikeWaveGeo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.12, z);
  m.scale.set(0.5, 0.5, 1);
  scene.add(m);
  strikeShockwaves.push({ m, t: 0, dur: 0.45 });
}

function launchAirstrikeAt(targetX, targetZ, strikeYaw) {
  const dirX = -Math.sin(strikeYaw), dirZ = -Math.cos(strikeYaw);
  showCenterMsg('AIRSTRIKE INBOUND');
  const zoneR = CORE.AIRSTRIKE_ZONE_RADIUS || 11;
  const telegraph = makeAirstrikeTelegraph(targetX, targetZ, zoneR);
  const bombs = [];
  const bounds = typeof mapBounds === 'number' ? mapBounds : 43;
  let maxDelay = 0;
  for (let i = 0; i < CORE.AIRSTRIKE_BOMB_COUNT; i++) {
    const detonateAt = CORE.airstrikeDelay(i, CORE.AIRSTRIKE_BASE_DELAY, CORE.AIRSTRIKE_STEP_DELAY) / 1000;
    if (detonateAt > maxDelay) maxDelay = detonateAt;
    const jx = (Math.random() - 0.5) * CORE.AIRSTRIKE_JITTER;
    const jz = (Math.random() - 0.5) * CORE.AIRSTRIKE_JITTER;
    CORE.airstrikeZoneBombCoord(targetX, targetZ, dirX, dirZ, i, CORE.AIRSTRIKE_BOMB_COUNT, CORE.AIRSTRIKE_SPACING, jx, jz, _airstrikeCoordOut);
    const bx = Math.max(-bounds, Math.min(bounds, _airstrikeCoordOut.x));
    const bz = Math.max(-bounds, Math.min(bounds, _airstrikeCoordOut.z));
    bombs.push({
      x: bx, z: bz,
      startX: bx - dirX * 14, startY: 46, startZ: bz - dirZ * 14,
      detonateAt: detonateAt,
      fallDur: 0.45,
      mesh: makeStrikeShellMesh(),
      detonated: false
    });
  }
  activeAirstrikes.push({
    tx: targetX, tz: targetZ, zoneR: zoneR,
    t: 0, endT: maxDelay + 0.35,
    telegraph: telegraph, bombs: bombs
  });
}

function updateActiveAirstrikes(dt) {
  const cinematic = typeof extraction !== 'undefined' && extraction && extraction.phase === 'cinematic';
  const ended = typeof gameEnded !== 'undefined' && gameEnded;
  if (cinematic || ended) {
    if (hasActiveAirstrikes()) clearAirstrikeVisuals();
    return;
  }
  for (let i = activeAirstrikes.length - 1; i >= 0; i--) {
    const st = activeAirstrikes[i];
    st.t += dt;
    if (st.telegraph && st.telegraph.children && st.telegraph.children.length >= 3) {
      const pulse = 0.5 + 0.5 * Math.sin(st.t * 14);
      const fade = st.t > st.endT - 0.35 ? Math.max(0, (st.endT - st.t) / 0.35) : 1;
      st.telegraph.children[0].material.opacity = (0.12 + 0.14 * pulse) * fade;
      st.telegraph.children[1].material.opacity = (0.55 + 0.35 * pulse) * fade;
      st.telegraph.children[2].material.opacity = 0.85 * fade;
      const innerS = 1.2 + 0.7 * pulse;
      st.telegraph.children[2].scale.set(innerS, innerS, 1);
    }
    for (let j = 0; j < st.bombs.length; j++) {
      const b = st.bombs[j];
      if (b.detonated) continue;
      const rem = b.detonateAt - st.t;
      if (rem <= 0) {
        b.detonated = true;
        if (b.mesh) { scene.remove(b.mesh); b.mesh = null; }
        _strikePos.set(b.x, 0.4, b.z);
        explodeGrenade(_strikePos, 1.35, typeof player !== 'undefined' ? player : null);
        spawnStrikeShockwave(b.x, b.z);
      } else if (rem <= b.fallDur && b.mesh) {
        const k = 1 - rem / b.fallDur;
        b.mesh.visible = true;
        b.mesh.position.set(
          b.startX + (b.x - b.startX) * k,
          b.startY + (0.4 - b.startY) * k,
          b.startZ + (b.z - b.startZ) * k
        );
      }
    }
    if (st.t >= st.endT) {
      if (st.telegraph) scene.remove(st.telegraph);
      activeAirstrikes.splice(i, 1);
    }
  }
  for (let i = strikeShockwaves.length - 1; i >= 0; i--) {
    const sw = strikeShockwaves[i];
    sw.t += dt;
    const p = sw.t / sw.dur;
    if (p >= 1) {
      scene.remove(sw.m);
      strikeShockwaves.splice(i, 1);
    } else {
      const s = 0.8 + p * 8.5;
      sw.m.scale.set(s, s, 1);
      sw.m.material.opacity = 0.78 * (1 - p);
    }
  }
}

(function initAirstrikeMinimapUI() {
  if (typeof document === 'undefined') return;
  const mm = typeof $id === 'function' ? $id('minimap') : document.getElementById('minimap');
  const cancelBtn = typeof $id === 'function' ? $id('airstrike-cancel') : document.getElementById('airstrike-cancel');
  if (mm && typeof mm.addEventListener === 'function') {
    const updateHover = function (clientX, clientY) {
      const r = mm.getBoundingClientRect();
      evalAirstrikeMinimapPoint(clientX - r.left, clientY - r.top, r.width, r.height);
      if (typeof drawMinimap === 'function') drawMinimap();
    };
    mm.addEventListener('mousemove', function (e) {
      if (!airstrikeTargeting) return;
      updateHover(e.clientX, e.clientY);
    });
    mm.addEventListener('mousedown', function (e) {
      if (!airstrikeTargeting) return;
      e.preventDefault(); e.stopPropagation();
      if (e.button === 2) { cancelAirstrikeTargeting(false); return; }
      if (e.button === 0) {
        const r = mm.getBoundingClientRect();
        confirmAirstrikeMinimapPoint(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      }
    });
    let mmTouchId = null;
    mm.addEventListener('touchstart', function (e) {
      if (!airstrikeTargeting) return;
      e.preventDefault(); e.stopPropagation();
      const t = e.changedTouches && e.changedTouches[0];
      if (!t || mmTouchId !== null) return;
      mmTouchId = t.identifier;
      updateHover(t.clientX, t.clientY);
    }, { passive: false });
    mm.addEventListener('touchmove', function (e) {
      if (!airstrikeTargeting || mmTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === mmTouchId) {
          e.preventDefault(); e.stopPropagation();
          updateHover(t.clientX, t.clientY);
        }
      }
    }, { passive: false });
    mm.addEventListener('touchend', function (e) {
      if (!airstrikeTargeting || mmTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === mmTouchId) {
          e.preventDefault(); e.stopPropagation();
          mmTouchId = null;
          const r = mm.getBoundingClientRect();
          confirmAirstrikeMinimapPoint(t.clientX - r.left, t.clientY - r.top, r.width, r.height);
        }
      }
    }, { passive: false });
    mm.addEventListener('touchcancel', function (e) {
      if (mmTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === mmTouchId) { mmTouchId = null; airstrikeHover.active = false; }
      }
    }, { passive: false });
  }
  if (cancelBtn && typeof cancelBtn.addEventListener === 'function') {
    cancelBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      cancelAirstrikeTargeting(false);
    });
    cancelBtn.addEventListener('touchstart', function (e) {
      e.preventDefault(); e.stopPropagation();
      cancelAirstrikeTargeting(false);
    }, { passive: false });
  }
})();

// ---- Sentry gun ---------------------------------------------------------------
const sentryBodyGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const sentryBarrelGeo = new THREE.BoxGeometry(0.12, 0.12, 0.8);
const sentryMat = new THREE.MeshStandardMaterial({ color: 0x3a4a58, roughness: 0.5, metalness: 0.6 });
const _sentryFrom = new THREE.Vector3();
const _sentryTo = new THREE.Vector3();
const _sentryMuzzle = new THREE.Vector3();
const _sentryShootDir = new THREE.Vector3();
const _sentryHitPoint = new THREE.Vector3();
const _sentryTimerOut = { t: 0, cd: 0, expired: false, readyToFire: false };

function deploySentry() {
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  let x = player.pos.x + dirX * CORE.SENTRY_DEPLOY_OFFSET, z = player.pos.z + dirZ * CORE.SENTRY_DEPLOY_OFFSET;
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
  const ownerActor = (typeof player !== 'undefined') ? player : null;
  const ownerTeam = (ownerActor && ownerActor.team) ? ownerActor.team : 'friendly';
  sentries.push({ m: g, barrel: barrel, t: CORE.streakByKey('sentry').dur, cd: 0, owner: ownerActor, team: ownerTeam });
  showCenterMsg('SENTRY DEPLOYED');
}

function updateSentries(dt) {
  const activeSmokes = (typeof smokeVolumes === 'function') ? smokeVolumes() : null;
  const maxRangeSq = SENTRY_RANGE * SENTRY_RANGE;
  for (let i = sentries.length - 1; i >= 0; i--) {
    const s = sentries[i];
    CORE.stepSentryTimers(s.t, s.cd, dt, _sentryTimerOut);
    s.t = _sentryTimerOut.t;
    s.cd = _sentryTimerOut.cd;
    if (_sentryTimerOut.expired) { scene.remove(s.m); sentries.splice(i, 1); continue; }
    // Nearest enemy it can actually see. Same analytic slab test the AI uses,
    // pointed the other way — including through smoke, which cuts both ways.
    let best = null, bestDSq = maxRangeSq;
    const sentryOwner = s.owner || (typeof player !== 'undefined' ? player : null);
    const sentryTeam = s.team || (sentryOwner && sentryOwner.team) || 'friendly';
    _sentryFrom.set(s.m.position.x, 0.6, s.m.position.z);
    for (let e = 0; e < enemies.length; e++) {
      const en = enemies[e];
      if (en.dead) continue;
      const isAlly = (typeof CORE !== 'undefined' && typeof CORE.isFriendlyFire === 'function')
        ? CORE.isFriendlyFire(sentryOwner, en)
        : (en.team === sentryTeam);
      if (isAlly) continue;
      const dx = en.pos.x - s.m.position.x, dz = en.pos.z - s.m.position.z;
      const dSq = dx * dx + dz * dz;
      if (!CORE.isSentryTargetInRange(dx, dz, bestDSq)) continue;
      _sentryTo.set(en.pos.x, CORE.sentryAimTargetY(en.pos.y, CORE.SENTRY_AIM_Y_OFFSET), en.pos.z);
      if (CORE.segmentBlocked(_sentryFrom.x, _sentryFrom.y, _sentryFrom.z,
          _sentryTo.x, _sentryTo.y, _sentryTo.z, colliders, 0.25)) continue;
      if (activeSmokes && CORE.smokeBlocks(_sentryFrom.x, _sentryFrom.y, _sentryFrom.z,
          _sentryTo.x, _sentryTo.y, _sentryTo.z, activeSmokes)) continue;
      best = en; bestDSq = dSq;
    }
    if (!best) continue;
    s.m.rotation.y = CORE.sentryTargetYaw(best.pos.x - s.m.position.x, best.pos.z - s.m.position.z);
    if (!_sentryTimerOut.readyToFire) continue;
    s.cd = SENTRY_ROF;
    _sentryTo.set(best.pos.x, CORE.sentryAimTargetY(best.pos.y, CORE.SENTRY_AIM_Y_OFFSET), best.pos.z);
    CORE.sentryMuzzlePosition(s.m.position.x, s.m.position.y, s.m.position.z, s.m.rotation.y, CORE.SENTRY_MUZZLE_FORWARD_OFFSET, CORE.SENTRY_MUZZLE_HEIGHT_OFFSET, _sentryMuzzle);
    CORE.sentryShootDirection(_sentryMuzzle.x, _sentryMuzzle.y, _sentryMuzzle.z, _sentryTo.x, _sentryTo.y, _sentryTo.z, _sentryShootDir);
    if (typeof fxMuzzle === 'function') fxMuzzle(_sentryMuzzle, _sentryShootDir, false);
    if (typeof flashLight === 'function') {
      const slp = CORE.sentryMuzzleLightParams();
      flashLight(_sentryMuzzle, slp.color, slp.intensity, slp.distance, slp.duration);
    }
    spawnTracer(_sentryMuzzle, _sentryTo, null, 'BR');
    _sentryHitPoint.copy(_sentryTo);
    damageEnemy(best, SENTRY_DMG, _sentryHitPoint, false, false, 'SENTRY', sentryOwner);
    playSound3D(CORE.sentryFireSound(), s.m.position.x, s.m.position.y, s.m.position.z, CORE.SENTRY_AUDIO_MAX_DIST);
  }
}

// ---- Munitions box ------------------------------------------------------------
const munitionGeo = new THREE.BoxGeometry(0.7, 0.45, 0.5);
const munitionMat = new THREE.MeshStandardMaterial({ color: 0x4a5a2f, roughness: 0.8 });

function deployMunitions() {
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  let x = player.pos.x + dirX * CORE.MUNITIONS_DEPLOY_OFFSET, z = player.pos.z + dirZ * CORE.MUNITIONS_DEPLOY_OFFSET;
  if (!CORE.isSpawnValid(x, z, colliders, 0.6, 1.8, 0.5)) { x = player.pos.x; z = player.pos.z; }
  const m = new THREE.Mesh(munitionGeo, munitionMat);
  m.position.set(x, 0.23, z);
  m.castShadow = true;
  scene.add(m);
  munitions.push({ m: m, t: CORE.FIELD_UPGRADE.dur, tick: 0 });
  showCenterMsg('MUNITIONS BOX');
  playSound(CORE.fieldUpgradeSound(true));
}

const _munitionsTimerOut = { t: 0, tick: 0, expired: false, readyToResupply: false };
function updateMunitions(dt) {
  const radSq = CORE.FIELD_UPGRADE.radius * CORE.FIELD_UPGRADE.radius;
  for (let i = munitions.length - 1; i >= 0; i--) {
    const b = munitions[i];
    CORE.stepMunitionsTimers(b.t, b.tick, dt, _munitionsTimerOut);
    b.t = _munitionsTimerOut.t;
    b.tick = _munitionsTimerOut.tick;
    if (_munitionsTimerOut.readyToResupply &&
        CORE.isTargetInMunitionsRadius(player.pos.x, player.pos.z, b.m.position.x, b.m.position.z, radSq)) {
      const s = curS();
      const w = curW();
      const ammoNeed = s ? (s.reserve < w.reserveMax) : false;
      const nadeNeed = grenades.count < CFG.grenade.count;
      const tacNeed = !!(equippedTactical && tacticalCount < TACTICAL_MAX);
      if (CORE.canMunitionsResupply(ammoNeed, nadeNeed, tacNeed)) {
        if (ammoNeed) {
          s.reserve = CORE.munitionsAmmoRestore(s.reserve, w.reserveMax, w.mag, CORE.MUNITIONS_MAG_RATIO);
        }
        if (nadeNeed) grenades.count++;
        else if (tacNeed) tacticalCount++;
        updateHudAmmo();
        playSound(CORE.fieldUpgradeSound(false));
      }
    }
    if (_munitionsTimerOut.expired) { scene.remove(b.m); munitions.splice(i, 1); }
  }
}

function updateStreaks(dt) {
  if (!started || paused || player.dead) return;
  const isDowned = typeof player !== 'undefined' && !!player.downed;
  if ((pressed['KeyZ'] || pressed['__streak']) && CORE.canPlayerUseStreak(player.dead, isDowned, streakBank.length)) {
    delete pressed['KeyZ']; delete pressed['__streak'];
    useStreak();
  }
  if ((pressed['KeyB'] || pressed['__field']) && CORE.canPlayerUseFieldUpgrade(player.dead, isDowned, fieldCharge, CORE.FIELD_UPGRADE && CORE.FIELD_UPGRADE.charge ? CORE.FIELD_UPGRADE.charge : 100)) useFieldUpgrade();
  updateActiveAirstrikes(dt);
  updateSentries(dt);
  updateMunitions(dt);
}

// ---- HUD ---------------------------------------------------------------------
let _touchStreakCache = { streakState: null, streakLabel: null };
let _streakHudElement = null, _streakHudHtml = null;
function updateHudStreaks() {
  const el = $id('streak-hud');
  if (el) {
    let s = '';
    for (let i = 0; i < streakBank.length; i++) {
      const d = CORE.streakByKey(streakBank[i]);
      if (d) s += '<span class="ready" title="' + d.name + '">' + d.short + '</span>';
    }
    if (CORE.fieldReady(fieldCharge)) s += '<span class="field">FLD</span>';
    const next = CORE.nextStreak(streakKills);
    if (next) s += '<span class="next">' + next.short + ' ' + streakKills + '/' + next.kills + '</span>';
    // Damage can charge the field upgrade many times without changing any visible
    // streak label. Avoid reparsing/replacing identical span trees on each hit.
    if (el !== _streakHudElement || s !== _streakHudHtml) {
      el.innerHTML = s;
      _streakHudElement = el; _streakHudHtml = s;
    }
  }
  const isTouch = typeof IS_TOUCH !== 'undefined' && !!IS_TOUCH;
  if (isTouch) {
    const tbtnStreak = typeof $id === 'function' ? $id('tbtn-streak') : document.getElementById('tbtn-streak');
    if (tbtnStreak) {
      const hasStreak = streakBank.length > 0;
      const fReady = CORE.fieldReady(fieldCharge);
      const isDowned = typeof player !== 'undefined' && !!player.downed;
      const isDead = typeof player !== 'undefined' && !!player.dead;
      const sState = CORE.touchStreakState(hasStreak, fReady, isDowned, isDead);
      const topStreak = hasStreak ? streakBank[0] : null;
      const fieldChargePct = CORE.FIELD_UPGRADE && CORE.FIELD_UPGRADE.charge > 0
        ? fieldCharge / CORE.FIELD_UPGRADE.charge * 100 : 0;
      const sLabel = airstrikeTargeting ? 'CANCEL' : CORE.touchStreakLabel(topStreak, fReady, fieldChargePct, isDowned, isDead);
      if (CORE.touchStreakChanged(_touchStreakCache, sState, sLabel)) {
        CORE.syncTouchStreakState(_touchStreakCache, sState, sLabel);
        tbtnStreak.classList.toggle('streak', sState === 'streak');
        tbtnStreak.classList.toggle('field', sState === 'field');
        tbtnStreak.classList.toggle('empty', sState === 'empty');
        tbtnStreak.classList.toggle('locked', sState === 'locked');
        if (tbtnStreak.textContent !== sLabel) tbtnStreak.textContent = sLabel;
      }
    }
  }
}
