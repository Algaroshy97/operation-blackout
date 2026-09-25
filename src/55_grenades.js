// ============ GRENADES & PICKUPS (v2) ============
'use strict';
const grenades = { count: CFG.grenade.count, cd: 0 };
const liveGrenades = [];
const grenadeGeo = new THREE.SphereGeometry(0.11, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x2e4a2e, roughness: 0.5, metalness: 0.3 });
const fuseLightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3020).multiplyScalar(3) });
const fuseLightMatE = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff1000).multiplyScalar(5) });

// ---- Trajectory preview pool (zero per-frame allocation) ----
const PREVIEW_DOT_COUNT = 28;
const previewDotGeo = new THREE.SphereGeometry(0.04, 6, 4);
const previewDotMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.8 });
const previewDots = [];
for (let i = 0; i < PREVIEW_DOT_COUNT; i++) {
  const dot = new THREE.Mesh(previewDotGeo, previewDotMat);
  dot.visible = false;
  dot.userData.vfx = true;
  dot.castShadow = false;
  dot.receiveShadow = false;
  scene.add(dot);
  previewDots.push(dot);
}
function hidePreviewDots() {
  for (let i = 0; i < previewDots.length; i++) previewDots[i].visible = false;
}

// ---- Blast radius ring pool ----
const blastRingGeo = new THREE.RingGeometry(CFG.grenade.radius - 0.09, CFG.grenade.radius, 48);
const blastRingPool = [];
function getBlastRing() {
  if (blastRingPool.length > 0) return blastRingPool.pop();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff4030, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
  const r = new THREE.Mesh(blastRingGeo, mat);
  r.rotation.x = -Math.PI / 2;
  r.userData.vfx = true;
  r.castShadow = false;
  r.receiveShadow = false;
  return r;
}
function releaseBlastRing(ring) {
  if (!ring) return;
  scene.remove(ring);
  blastRingPool.push(ring);
}

// ---- Grenade hold-to-charge state ----
let grenadeCharging = false;
let grenadeChargeT = 0;
const GRENADE_MIN_SPEED = 6.0;
const GRENADE_MAX_SPEED = 13.0;
const GRENADE_RAMP_DURATION = 1.0;
const GRENADE_TAP_THRESHOLD = 0.22;

function getGrenadeSpeed() {
  const ratio = Math.min(1, grenadeChargeT / GRENADE_RAMP_DURATION);
  return GRENADE_MIN_SPEED + ratio * (GRENADE_MAX_SPEED - GRENADE_MIN_SPEED);
}

const _prevDir = new THREE.Vector3();
function updateGrenadePreview(speed) {
  if (grenades.count <= 0 || player.dead || paused || !started) {
    hidePreviewDots();
    return;
  }
  _prevDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _prevDir.y += 0.45;
  _prevDir.normalize();

  _pvP.set(camera.position.x, camera.position.y - 0.1, camera.position.z);
  _pvV.copy(_prevDir).multiplyScalar(speed);
  const dtStep = 0.04;
  let fuse = CFG.grenade.fuse;
  let stopped = false;
  // Same integrator + collision as updateGrenades, so the arc matches the throw.
  for (let i = 0; i < PREVIEW_DOT_COUNT; i++) {
    if (stopped) {
      previewDots[i].visible = false;
      continue;
    }
    fuse -= dtStep;
    stepGrenadeBody(_pvP, _pvV, dtStep);
    if (fuse <= 0 || (_pvV.lengthSq() < 0.04 && _pvRest)) stopped = true;
    previewDots[i].position.copy(_pvP);
    previewDots[i].visible = true;
  }
}
const _pvP = new THREE.Vector3(), _pvV = new THREE.Vector3();
let _pvRest = false;
const GRENADE_R = 0.1;
// One physics step for a grenade body. Returns the contact normal's up component.
function stepGrenadeBody(p, v, dt) {
  v.y -= 14 * dt;
  p.addScaledVector(v, dt);
  const g = sphereVsWorld(p, v, GRENADE_R, CFG.grenade.bounce, 0.28);
  _pvRest = g > 0.6;
  if (_pvRest) { const k = Math.exp(-2.8 * dt); v.x *= k; v.z *= k; }   // rolling resistance
  return g;
}

function throwGrenade(customSpeed) {
  if (grenades.count <= 0 || grenades.cd > 0 || player.dead) return;
  grenades.count--;
  grenades.cd = 0.8;
  const speed = typeof customSpeed === 'number' ? customSpeed : CFG.grenade.speed;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  dir.y += 0.45; dir.normalize();
  const from = new THREE.Vector3(camera.position.x, camera.position.y - 0.1, camera.position.z);
  // inherit some of the thrower's momentum
  const vel = dir.multiplyScalar(speed).addScaledVector(player.vel, 0.5);
  spawnLiveGrenade(from, vel, CFG.grenade.fuse, false);
  playSound('pin');
  playSound('draw');
  if (typeof alertEnemiesTo === 'function') alertEnemiesTo(player.pos, 12);
  updateHudAmmo();
}
// Shared by the player and enemy grenadiers (enemy = true marks hostile frags).
function spawnLiveGrenade(from, vel, fuse, enemy) {
  const m = new THREE.Mesh(grenadeGeo, grenadeMat);
  const blink = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), enemy ? fuseLightMatE : fuseLightMat);
  blink.position.y = 0.1;
  m.add(blink);
  m.castShadow = true;
  m.position.copy(from);
  liveGrenades.push({
    m: m,
    vel: vel.clone(),
    fuse: fuse,
    blink: blink,
    atRest: false,
    ring: null,
    restFuse: fuse,
    enemy: !!enemy
  });
  scene.add(m);
}

function cancelGrenadeCharge() {
  grenadeCharging = false;
  grenadeChargeT = 0;
  hidePreviewDots();
  if (typeof updateHudGrenadeCharge === 'function') updateHudGrenadeCharge(false);
}

function updateGrenades(dt) {
  grenades.cd = Math.max(0, grenades.cd - dt);

  // Charge / aim input handling
  const canCharge = grenades.count > 0 && grenades.cd <= 0 && !player.dead && started && !paused;
  if (keys['KeyG']) {
    if (!grenadeCharging && canCharge) {
      grenadeCharging = true;
      grenadeChargeT = 0;
    }
    if (grenadeCharging) {
      if (player.dead || paused || !started || grenades.count <= 0) {
        cancelGrenadeCharge();
      } else {
        grenadeChargeT += dt;
        const curSpeed = getGrenadeSpeed();
        updateGrenadePreview(curSpeed);
        const chargePct = Math.min(100, Math.round((grenadeChargeT / GRENADE_RAMP_DURATION) * 100));
        if (typeof updateHudGrenadeCharge === 'function') updateHudGrenadeCharge(true, chargePct, curSpeed);
      }
    } else {
      cancelGrenadeCharge();
    }
  } else {
    if (grenadeCharging) {
      if (player.dead || paused || !started || grenades.count <= 0) {
        cancelGrenadeCharge();
      } else {
        const throwSpeed = grenadeChargeT <= GRENADE_TAP_THRESHOLD ? CFG.grenade.speed : getGrenadeSpeed();
        cancelGrenadeCharge();
        throwGrenade(throwSpeed);
      }
    } else {
      hidePreviewDots();
      if (typeof updateHudGrenadeCharge === 'function') updateHudGrenadeCharge(false);
    }
  }

  for (let i = liveGrenades.length - 1; i >= 0; i--) {
    const g = liveGrenades[i];
    g.fuse -= dt;
    const vBefore = g.vel.length();
    const contact = stepGrenadeBody(g.m.position, g.vel, dt);
    if (contact > 0 && vBefore - g.vel.length() > 1.2) playSound3D('bounce', g.m.position.x, g.m.position.y, g.m.position.z);
    if (contact > 0.6) g.grounded = (g.grounded || 0) + 1;
    g.m.rotation.x += g.vel.z * dt * 8; g.m.rotation.z -= g.vel.x * dt * 8;
    if (Math.random() < 0.5) pfxEmit(PFX_SMOKE, g.m.position.x, g.m.position.y + 0.05, g.m.position.z, 0, 0.3, 0, 0.6, 0.05, 0.25, 0x8a8a8a, 0x5a5a5a, 0.25, 1, -0.2, 0);
    // detect when grenade comes to rest on ground
    const hSpeedSq = g.vel.x * g.vel.x + g.vel.z * g.vel.z;
    if (!g.atRest && g.grounded && g.grounded > 1 && hSpeedSq < 0.1 && Math.abs(g.vel.y) < 0.4) {
      g.atRest = true;
      g.restFuse = Math.max(0.1, g.fuse);
      const ring = getBlastRing();
      ring.position.set(g.m.position.x, g.m.position.y - GRENADE_R + 0.03, g.m.position.z);
      ring.material.opacity = 0.32;
      scene.add(ring);
      g.ring = ring;
    }
    if (g.ring) {
      const fade = Math.max(0, Math.min(1, g.fuse / g.restFuse));
      g.ring.material.opacity = 0.32 * fade;
    }
    // blink faster as fuse burns
    g.blink.visible = Math.sin(g.fuse * (20 - g.fuse * 4) * 2) > 0;
    if (g.fuse <= 0) {
      explodeGrenade(g.m.position, g.enemy);
      if (g.ring) {
        releaseBlastRing(g.ring);
        g.ring = null;
      }
      scene.remove(g.m);
      liveGrenades.splice(i, 1);
    }
  }
}

const grenadeLosRay = new THREE.Raycaster();
const grenadeLosDir = new THREE.Vector3();
const grenadeTargets = [];
function grenadeHasLineOfSight(from, to, targetEnemy) {
  grenadeLosDir.copy(to).sub(from);
  const dist = grenadeLosDir.length();
  if (dist < 0.05) return true;
  grenadeLosDir.multiplyScalar(1 / dist);
  grenadeLosRay.set(from, grenadeLosDir);
  grenadeLosRay.far = dist;
  grenadeTargets.length = 0;
  for (let i = 0; i < raycastColliders.length; i++) {
    grenadeTargets.push(raycastColliders[i]);
  }
  for (let i = 0; i < enemies.length; i++) {
    if (!enemies[i].dead && enemies[i].parts && enemies[i].parts.group) {
      grenadeTargets.push(enemies[i].parts.group);
    }
  }
  const hit = grenadeLosRay.intersectObjects(grenadeTargets, true).filter(function (h) {
    return h.object !== ground && !h.object.userData.vfx && !h.object.userData.gun && !h.object.userData.sky && !h.object.userData.pickup;
  })[0];
  if (!hit || hit.distance >= dist - 0.05) return true;
  return !!targetEnemy && hit.object.userData.enemyRef === targetEnemy;
}

function explodeGrenade(pos, fromEnemy) {
  applyExplosion(pos, { radius: CFG.grenade.radius, dmg: CFG.grenade.dmg, playerDmg: fromEnemy ? 70 : 55, scale: 1, sound: 'explosion', fromEnemy: !!fromEnemy });
}

// Shared blast: FX, falloff damage with cover occlusion, knockback impulse,
// chain reactions (barrels), camera trauma. Used by grenades and explosive barrels.
const _blastFrom = new THREE.Vector3(), _blastTarget = new THREE.Vector3(), _blastDir = new THREE.Vector3();
function applyExplosion(pos, o) {
  const R = o.radius;
  playSound3D(o.sound || 'explosion', pos.x, pos.y, pos.z, false, 140);
  fxExplosion(pos, o.scale || 1);
  const floorY = floorHeightAt(pos.x, pos.z, pos.y + 0.2);
  if (pos.y - floorY < 0.8) {
    if (floorY <= GROUND + 0.01) spawnScorch(pos.x, pos.z, R * 0.5);
  }
  _blastFrom.copy(pos); _blastFrom.y += 0.15;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _blastTarget.set(en.pos.x, en.pos.y + 1.0, en.pos.z);
    const d = _blastTarget.distanceTo(pos);
    if (d < R && grenadeHasLineOfSight(_blastFrom, _blastTarget, en)) {
      const falloff = 1 - d / R;
      const dmg = o.dmg * (0.35 + 0.65 * falloff);
      _blastDir.copy(_blastTarget).sub(pos).normalize();
      _blastDir.y = Math.max(0.35, _blastDir.y);
      en.blastImpulse = _blastDir.clone().multiplyScalar(4 + 9 * falloff);
      damageEnemy(en, dmg, _blastTarget.clone(), false, _blastDir, true);
    }
  }
  if (typeof damageBarrelsInRadius === 'function') damageBarrelsInRadius(pos, R, o.dmg);
  ragdollBlast(pos, R * 1.1, 14 * (o.scale || 1));
  // player: cover blocks it; enemy grenades hurt more than your own
  _blastTarget.copy(player.pos); _blastTarget.y -= 0.5;
  const pd = _blastTarget.distanceTo(pos);
  if (pd < R * 0.85 && grenadeHasLineOfSight(_blastFrom, _blastTarget, null)) {
    const falloff = 1 - pd / (R * 0.85);
    const bearing = (Math.atan2(pos.x - player.pos.x, pos.z - player.pos.z) * 180 / Math.PI + 360) % 360;
    damagePlayer(Math.round(o.playerDmg * falloff) * (o.fromEnemy ? diff().dmg : 1) * perkMul('blast'), bearing);
    // blast pushes the player
    _blastDir.copy(_blastTarget).sub(pos).normalize();
    player.vel.x += _blastDir.x * 7 * falloff; player.vel.z += _blastDir.z * 7 * falloff;
    player.vel.y = Math.max(player.vel.y, 2.5 * falloff);
  }
  const shake = Math.max(0, 1 - pd / (R * 5));
  addTrauma(shake * 0.95);
  postKick('aberration', shake * 0.9);
  if (pd < R * 1.3) postKick('flash', 0.35 * (1 - pd / (R * 1.3)));
  shotKick = Math.min(2, shotKick + shake * 1.2);
  if (typeof markNavDirty === 'function') markNavDirty();
}

// ---- Pickups: ammo + medkit drops from enemies ----
const pickups = [];
const pickupAmmoGeo = new THREE.BoxGeometry(0.35, 0.22, 0.25);
const pickupAmmoMat = new THREE.MeshStandardMaterial({ color: 0x8a6d2f, roughness: 0.7, metalness: 0.2 });
const pickupMedGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
const pickupMedMat = new THREE.MeshStandardMaterial({ color: 0xd8d8e0, roughness: 0.4 });
const medCrossMat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
// shared cross geometry (was allocated per-drop, never disposed — GPU leak over long sessions)
const medCrossGeo1 = new THREE.BoxGeometry(0.16, 0.05, 0.31);
const medCrossGeo2 = new THREE.BoxGeometry(0.05, 0.16, 0.31);
const PICKUP_LIFE = 25;        // seconds before despawn
const PICKUP_BLINK = 20;       // start blinking during the last 5s

function dropPickup(pos) {
  const roll = Math.random();
  let kind = null;
  const k = perkMul('drops');
  if (roll < 0.30 * k) kind = 'ammo';
  else if (roll < 0.45 * k) kind = 'med';
  if (!kind) return;
  const g = kind === 'ammo' ? new THREE.Mesh(pickupAmmoGeo, pickupAmmoMat) : new THREE.Mesh(pickupMedGeo, pickupMedMat);
  if (kind === 'med') {
    const cross1 = new THREE.Mesh(medCrossGeo1, medCrossMat);
    const cross2 = new THREE.Mesh(medCrossGeo2, medCrossMat);
    cross1.position.y = 0.16; cross2.position.y = 0.16;
    g.add(cross1); g.add(cross2);
  }
  g.position.set(pos.x, 0.3, pos.z);
  g.castShadow = true;
  g.userData.pickup = kind;
  scene.add(g);
  pickups.push({ m: g, kind: kind, t: 0 });
}

function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.t += dt;
    p.m.rotation.y += dt * 2;
    p.m.position.y = 0.3 + Math.sin(p.t * 3) * 0.06;
    // walk-over collect: HORIZONTAL distance — player.pos is anchored at eye
    // height (1.7 m), so 3D distance to a ground pickup (y=0.3) is always
    // >= 1.4 m and a 3D radius of 1.3 m could never collect anything.
    const d = Math.hypot(p.m.position.x - player.pos.x, p.m.position.z - player.pos.z);
    if (d < 1.3) {
      if (p.kind === 'ammo') {
        const s = curS();
        if (s) {
          // tops up both weapons; the one in hand gets the bigger share
          for (let si = 0; si < wState.length; si++) {
            if (!wState[si]) continue;
            const ww = CFG.weapons[weaponsOwned[si]];
            wState[si].reserve = Math.min(ww.reserveMax, wState[si].reserve + Math.round(magSize(ww) * (si === curWeapon ? 1.5 : 0.75)));
          }
          updateHudAmmo();
          showCenterMsg('+ AMMO');
        }
      } else {
        player.health = Math.min(CFG.player.health, player.health + 35);
        player.armor = Math.min(maxArmor(), player.armor + 15);
        showCenterMsg('+ MEDKIT');
        updateHudHealth();
      }
      playSound(p.kind === 'ammo' ? 'pickup_ammo' : 'pickup_med');
      scene.remove(p.m);
      pickups.splice(i, 1);
      continue;
    }
    // blink during the last seconds so despawn never looks like a bug
    if (p.t > PICKUP_BLINK) p.m.visible = (p.t * 6 % 2) < 1.4;
    else p.m.visible = true;
    // despawn after PICKUP_LIFE seconds
    if (p.t > PICKUP_LIFE) { scene.remove(p.m); pickups.splice(i, 1); }
  }
}
