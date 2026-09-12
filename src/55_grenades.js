// ============ GRENADES & PICKUPS (v2) ============
'use strict';
const grenades = { count: CFG.grenade.count, cd: 0 };
const liveGrenades = [];
const grenadeGeo = new THREE.SphereGeometry(0.11, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x2e4a2e, roughness: 0.5, metalness: 0.3 });
const fuseLightMat = new THREE.MeshBasicMaterial({ color: 0xff3020 });

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

  let px = camera.position.x;
  let py = camera.position.y - 0.1;
  let pz = camera.position.z;
  let vx = _prevDir.x * speed;
  let vy = _prevDir.y * speed;
  let vz = _prevDir.z * speed;
  const dtStep = 0.04;

  let bounces = 0;
  let fuse = CFG.grenade.fuse;
  let stopped = false;
  for (let i = 0; i < PREVIEW_DOT_COUNT; i++) {
    if (stopped) {
      previewDots[i].visible = false;
      continue;
    }
    fuse -= dtStep;
    vy -= 14 * dtStep;
    px += vx * dtStep;
    py += vy * dtStep;
    pz += vz * dtStep;

    // ground bounce check (matches updateGrenades physics)
    if (py < 0.11) {
      py = 0.11;
      vy = -vy * CFG.grenade.bounce;
      vx *= 0.55;
      vz *= 0.55;
      bounces++;
      if (bounces > 1) {
        vx *= 0.3;
        vz *= 0.3;
      }
      if (bounces >= 3) {
        stopped = true;
      }
    }

    // wall bounce (AABBs) (matches updateGrenades physics)
    for (let c = 0; c < colliders.length; c++) {
      const col = colliders[c];
      if (px > col.min.x - 0.1 && px < col.max.x + 0.1 &&
          py > col.min.y && py < col.max.y &&
          pz > col.min.z - 0.1 && pz < col.max.z + 0.1) {
        const cx = (col.min.x + col.max.x) / 2, cz = (col.min.z + col.max.z) / 2;
        const ox = (col.max.x - col.min.x) / 2 + 0.1 - Math.abs(px - cx);
        const oz = (col.max.z - col.min.z) / 2 + 0.1 - Math.abs(pz - cz);
        if (ox < oz) { vx = -vx * 0.5; px += (px > cx ? ox : -ox); }
        else { vz = -vz * 0.5; pz += (pz > cz ? oz : -oz); }
        vy *= 0.8;
      }
    }

    if (fuse <= 0) {
      stopped = true;
    }

    previewDots[i].position.set(px, py, pz);
    previewDots[i].visible = true;
  }
}

function throwGrenade(customSpeed) {
  if (grenades.count <= 0 || grenades.cd > 0 || player.dead) return;
  grenades.count--;
  grenades.cd = 0.8;
  const speed = typeof customSpeed === 'number' ? customSpeed : CFG.grenade.speed;
  const m = new THREE.Mesh(grenadeGeo, grenadeMat);
  const blink = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), fuseLightMat);
  blink.position.y = 0.1;
  m.add(blink);
  m.castShadow = true;
  m.position.set(camera.position.x, camera.position.y - 0.1, camera.position.z);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  dir.y += 0.45; dir.normalize();
  liveGrenades.push({
    m: m,
    vel: dir.multiplyScalar(speed),
    fuse: CFG.grenade.fuse,
    blink: blink,
    atRest: false,
    ring: null,
    restFuse: CFG.grenade.fuse
  });
  scene.add(m);
  playSound('pin');
  playSound('draw');
  updateHudAmmo();
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
    g.vel.y -= 14 * dt;
    g.m.position.addScaledVector(g.vel, dt);
    // ground bounce
    if (g.m.position.y < 0.11) {
      g.m.position.y = 0.11;
      if (Math.abs(g.vel.y) > 1) playSound('bounce');
      g.vel.y = -g.vel.y * CFG.grenade.bounce;
      g.vel.x *= 0.55; g.vel.z *= 0.55;
      if (g.grounded === undefined) g.grounded = 0;
      g.grounded++;
      if (g.grounded > 1) { g.vel.x *= 0.3; g.vel.z *= 0.3; }  // heavy friction once rolling
    }
    // wall bounce (AABBs)
    for (let c = 0; c < colliders.length; c++) {
      const col = colliders[c];
      const p = g.m.position;
      if (p.x > col.min.x - 0.1 && p.x < col.max.x + 0.1 && p.y > col.min.y && p.y < col.max.y && p.z > col.min.z - 0.1 && p.z < col.max.z + 0.1) {
        // push out along smallest axis and reflect
        const cx = (col.min.x + col.max.x) / 2, cz = (col.min.z + col.max.z) / 2;
        const px = (col.max.x - col.min.x) / 2 + 0.1 - Math.abs(p.x - cx);
        const pz = (col.max.z - col.min.z) / 2 + 0.1 - Math.abs(p.z - cz);
        if (px < pz) { g.vel.x = -g.vel.x * 0.5; p.x += (p.x > cx ? px : -px); }
        else { g.vel.z = -g.vel.z * 0.5; p.z += (p.z > cz ? pz : -pz); }
        g.vel.y *= 0.8;
      }
    }
    // detect when grenade comes to rest on ground
    const hSpeedSq = g.vel.x * g.vel.x + g.vel.z * g.vel.z;
    if (!g.atRest && g.grounded && g.grounded > 1 && hSpeedSq < 0.1 && Math.abs(g.vel.y) < 0.2 && g.m.position.y <= 0.12) {
      g.atRest = true;
      g.restFuse = Math.max(0.1, g.fuse);
      const ring = getBlastRing();
      ring.position.set(g.m.position.x, 0.03, g.m.position.z);
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
      explodeGrenade(g.m.position);
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

function explodeGrenade(pos) {
  playSound('explosion');
  // flash sphere vfx
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.9 }));
  flash.position.copy(pos);
  flash.userData.vfx = true;
  flash.userData.isBulletImpact = false;
  scene.add(flash);
  vfx.impacts.push({ m: flash, life: 0.35, isBulletImpact: false });
  // smoke/spark debris
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Mesh(sparkGeo, sparkMat);
    s.position.copy(pos);
    const v = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.4, (Math.random() - 0.5) * 2).multiplyScalar(3 + Math.random() * 5);
    s.userData.vfx = true;
    scene.add(s);
    vfx.blood.push({ m: s, v: v, life: 0.7, grav: 10 });
  }
  // damage with distance falloff and real cover occlusion
  const blastFrom = pos.clone(); blastFrom.y += 0.12;
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    const d = en.pos.distanceTo(pos);
    const target = en.pos.clone().setY(1.1);
    if (d < CFG.grenade.radius && grenadeHasLineOfSight(blastFrom, target, en)) {
      const falloff = 1 - d / CFG.grenade.radius;
      const dmg = CFG.grenade.dmg * (0.35 + 0.65 * falloff);
      damageEnemy(en, dmg, target, false);
    }
  }
  // player self-damage (half, encourages careful use; solid cover blocks it)
  const pd = player.pos.distanceTo(pos);
  const playerTarget = player.pos.clone(); playerTarget.y -= 0.5;
  if (pd < CFG.grenade.radius * 0.8 && grenadeHasLineOfSight(blastFrom, playerTarget, null)) {
    const falloff = 1 - pd / (CFG.grenade.radius * 0.8);
    damagePlayer(Math.round(55 * falloff), undefined);
  }
  // camera shake kick
  shotKick = Math.min(2, shotKick + 1.2);
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
  if (roll < 0.30) kind = 'ammo';
  else if (roll < 0.45) kind = 'med';
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
          s.reserve = Math.min(CFG.weapons[weaponsOwned[curWeapon]].reserveMax, s.reserve + Math.round(CFG.weapons[weaponsOwned[curWeapon]].mag * 1.5));
          updateHudAmmo();
          showCenterMsg('+ AMMO');
        }
      } else {
        player.health = Math.min(CFG.player.health, player.health + 35);
        player.armor = Math.min(CFG.player.armor, player.armor + 15);
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
