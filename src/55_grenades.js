// ============ GRENADES & PICKUPS (v2) ============
'use strict';
const grenades = { count: CFG.grenade.count, cd: 0 };
const liveGrenades = [];
const grenadeGeo = new THREE.SphereGeometry(0.11, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x2e4a2e, roughness: 0.5, metalness: 0.3 });
const fuseLightMat = new THREE.MeshBasicMaterial({ color: 0xff3020 });
const fuseBlinkGeo = new THREE.SphereGeometry(0.045, 6, 4);   // shared across all throws
// Shared explosion-flash resources + a pool of the meshes that use them.
const blastFlashGeo = new THREE.SphereGeometry(1, 12, 8);
const blastFlashMat = new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.9 });
const blastFlashPool = [];
function releaseBlastFlash(m) { m.visible = false; blastFlashPool.push(m); }

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
// ---- Equipment selection ----
// The grenade was the most reusable system here and the only thing mounted on it
// was a single frag. Charge-throw, the preview, bounce and blast LOS are all
// payload-agnostic, so a variant is a different payload rather than a new system.
let equippedLethal = 'frag';
let equippedTactical = null;
let tacticalCount = 0;
const TACTICAL_MAX = 2;
const EQUIP_COLOR = {
  frag: 0x2e4a2e, semtex: 0x2f7a3f, thermite: 0xb05a1f, claymore: 0x4a4a3a,
  flash: 0xd8d8c0, stun: 0x6fa8ff, smoke: 0x9aa0a8
};
const equipMats = {};
function equipMaterial(key) {
  if (!equipMats[key]) {
    equipMats[key] = new THREE.MeshStandardMaterial({
      color: EQUIP_COLOR[key] || 0x2e4a2e, roughness: 0.5, metalness: 0.3
    });
  }
  return equipMats[key];
}
function lethalDef() { return CORE.equipmentByKey(equippedLethal) || CORE.LETHALS[0]; }
function tacticalDef() { return equippedTactical ? CORE.equipmentByKey(equippedTactical) : null; }

// ---- Ground effects ----
// Thermite leaves burning ground; smoke leaves a volume that blocks enemy LOS.
// Both are plain data the update loop walks; neither needs a new subsystem.
const burnPatches = [];
const smokeClouds = [];
const burnRingGeo = new THREE.RingGeometry(0.2, 3.2, 28);
const burnRingMat = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
const smokeGeo = new THREE.SphereGeometry(1, 12, 10);
const smokeMat = new THREE.MeshBasicMaterial({ color: 0xb8bcc2, transparent: true, opacity: 0.62 });

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
// Colliders within reach of the throw arc, refreshed once per preview frame
// instead of scanning all of them at every one of the 28 sample points.
const previewNear = [];
const PREVIEW_REACH = 22;
function refreshPreviewNear(ox, oz) {
  previewNear.length = 0;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.min.x - PREVIEW_REACH > ox || c.max.x + PREVIEW_REACH < ox) continue;
    if (c.min.z - PREVIEW_REACH > oz || c.max.z + PREVIEW_REACH < oz) continue;
    previewNear.push(c);
  }
}
function updateGrenadePreview(speed) {
  if (grenades.count <= 0 || player.dead || paused || !started) {
    hidePreviewDots();
    return;
  }
  refreshPreviewNear(camera.position.x, camera.position.z);
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
    // Broad-phase first: the full arc used to test 28 points against all 129
    // colliders every frame while the throw was charging (~3,600 AABB tests).
    for (let c = 0; c < previewNear.length; c++) {
      const col = previewNear[c];
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

function throwGrenade(customSpeed, def) {
  const d = def || lethalDef();
  const tactical = d.mode === 'tactical';
  if (tactical) {
    if (tacticalCount <= 0) return;
  } else if (grenades.count <= 0) return;
  if (grenades.cd > 0 || player.dead) return;
  if (tactical) tacticalCount--; else grenades.count--;
  grenades.cd = 0.8;
  const speed = typeof customSpeed === 'number' ? customSpeed : CFG.grenade.speed;
  const m = new THREE.Mesh(grenadeGeo, equipMaterial(d.key));
  // Shared, not per-throw: this used to allocate a fresh SphereGeometry on every
  // throw and explodeGrenade() only scene.remove()d the mesh, leaking ~1 GPU
  // geometry per grenade for the life of the session.
  const blink = new THREE.Mesh(fuseBlinkGeo, fuseLightMat);
  blink.position.y = 0.1;
  m.add(blink);
  m.castShadow = true;
  m.position.set(camera.position.x, camera.position.y - 0.1, camera.position.z);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  dir.y += 0.45; dir.normalize();
  // A claymore has no fuse at all: it arms where it lands and waits. Everything
  // else counts down from its own value, not the frag's.
  const fuse = d.mode === 'proximity' ? Infinity : d.fuse;
  // Capture the claymore's facing BEFORE the object literal below, because
  // `vel: dir.multiplyScalar(speed)` mutates `dir` in place and a later
  // `faceX: dir.x` would read the VELOCITY instead of a unit vector. With a
  // magnitude of ~6.7 in it, the cone test `dot / d >= arc` was effectively
  // comparing against 0.5/6.7 — an 86-degree half-angle instead of 60, which is
  // most of a hemisphere and not a directional mine at all.
  const faceLen = Math.hypot(dir.x, dir.z) || 1;
  const faceX = dir.x / faceLen, faceZ = dir.z / faceLen;
  liveGrenades.push({
    m: m,
    vel: dir.multiplyScalar(speed),
    fuse: fuse,
    blink: blink,
    atRest: false,
    ring: null,
    restFuse: isFinite(fuse) ? fuse : 1,
    def: d,
    stuck: false,
    armT: 0,
    faceX: faceX, faceZ: faceZ      // claymore cone, unit length on XZ
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
  // Tacticals are a separate slot on a separate key, thrown at a fixed speed —
  // there is no reason to cook a flashbang, and a charge bar on one would just be
  // a second thing to learn.
  if ((pressed['KeyQ'] || pressed['__tactical']) && tacticalCount > 0 && grenades.cd <= 0
      && !player.dead && started && !paused) {
    throwGrenade(CFG.grenade.speed * 1.15, tacticalDef());
    updateHudAmmo();
  }
  updateEquipmentEffects(dt);

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
    const def = g.def || CORE.LETHALS[0];
    if (isFinite(g.fuse)) g.fuse -= dt;
    // Semtex and thermite stick where they land; nothing moves them afterwards.
    if (g.stuck) { stepLiveGrenade(g, dt, i, def); continue; }
    g.vel.y -= 14 * dt;
    g.m.position.addScaledVector(g.vel, dt);
    // ground bounce
    if (g.m.position.y < 0.11) {
      g.m.position.y = 0.11;
      if (def.sticky) { g.vel.set(0, 0, 0); g.stuck = true; g.atRest = true; playSound('pin'); }
      else if (Math.abs(g.vel.y) > 1) playSound('bounce');
      g.vel.y = -g.vel.y * (def.bounce === undefined ? CFG.grenade.bounce : def.bounce);
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
        if (def.sticky) { g.vel.set(0, 0, 0); g.stuck = true; g.atRest = true; playSound('pin'); }
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
    stepLiveGrenade(g, dt, i, def);
  }
}

// The per-payload half of the projectile loop, split out so the physics above
// stays one path for every type.
function stepLiveGrenade(g, dt, i, def) {
  // blink faster as fuse burns; an armed claymore holds a steady light instead
  g.blink.visible = isFinite(g.fuse)
    ? Math.sin(g.fuse * (20 - g.fuse * 4) * 2) > 0
    : (g.armT >= (def.arm || 0));

  if (def.mode === 'proximity') {
    if (!g.atRest && !g.stuck) return;
    g.armT += dt;
    if (g.armT < (def.arm || 0)) return;
    // Directional: a claymore facing away from an enemy does nothing, which is
    // the whole reason to place one deliberately rather than lob it.
    const p = g.m.position;
    for (let e = 0; e < enemies.length; e++) {
      const en = enemies[e];
      if (en.dead) continue;
      if (!CORE.coneHit(p.x, p.z, en.pos.x, en.pos.z, g.faceX, g.faceZ, def.trigger, def.arc)) continue;
      detonate(g, i, def);
      return;
    }
    return;
  }
  if (g.fuse <= 0) detonate(g, i, def);
}

function detonate(g, i, def) {
  const p = g.m.position;
  if (def.mode === 'tactical') {
    applyTactical(def, p);
  } else if (def.mode === 'burn') {
    // Thermite trades burst damage for area denial: a smaller bang, then ground
    // that stays lethal for six seconds.
    explodeGrenade(p, 0.45);
    addBurnPatch(p.x, p.z, def);
  } else {
    explodeGrenade(p);
  }
  if (g.ring) { releaseBlastRing(g.ring); g.ring = null; }
  scene.remove(g.m);
  liveGrenades.splice(i, 1);
}

// ---- Tactical payloads -------------------------------------------------------
function applyTactical(def, pos) {
  if (def.effect === 'smoke') {
    addSmokeCloud(pos.x, Math.max(1.2, pos.y), pos.z, def);
    playSound('explosion');
    return;
  }
  playSound(def.effect === 'blind' ? 'headshot' : 'pin');
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    const d = CORE.horizDist(en.pos.x, en.pos.z, pos.x, pos.z);
    if (d >= def.radius) continue;
    // Behind cover means behind cover: a flash through a wall is the thing that
    // makes tacticals feel arbitrary.
    if (CORE.segmentBlocked(pos.x, pos.y, pos.z,
        en.pos.x, en.pos.y + 1.2, en.pos.z, colliders, 0.25)) continue;
    if (def.effect === 'blind') {
      const fx = Math.sin(en.yaw), fz = Math.cos(en.yaw);
      const tx = (pos.x - en.pos.x) / (d || 1), tz = (pos.z - en.pos.z) / (d || 1);
      const s = CORE.flashStrength(d, def.radius, tx * fx + tz * fz);
      const dur = CORE.flashDuration(s, def.dur);
      if (dur > en.blindT) en.blindT = dur;
    } else {
      en.stunT = Math.max(en.stunT || 0, def.dur);
    }
  }
  // A flashbang the player is looking at blinds the player too. Anything else
  // would make it a free win rather than a tool with a cost.
  if (def.effect === 'blind') {
    const pd = CORE.horizDist(player.pos.x, player.pos.z, pos.x, pos.z);
    if (pd < def.radius && !CORE.segmentBlocked(pos.x, pos.y, pos.z,
        player.pos.x, player.pos.y, player.pos.z, colliders, 0.25)) {
      const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
      const tx = (pos.x - player.pos.x) / (pd || 1), tz = (pos.z - player.pos.z) / (pd || 1);
      const s = CORE.flashStrength(pd, def.radius, tx * fwdX + tz * fwdZ);
      playerFlashT = Math.max(playerFlashT, CORE.flashDuration(s, def.dur * 0.6));
    }
  }
}

let playerFlashT = 0;

function addBurnPatch(x, z, def) {
  const ring = new THREE.Mesh(burnRingGeo, burnRingMat.clone());
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.04, z);
  ring.scale.setScalar(def.burnRadius / 3.2);
  scene.add(ring);
  burnPatches.push({ x: x, z: z, t: def.burnTime, life: def.burnTime,
                     r: def.burnRadius, dps: def.burnDps, m: ring, tick: 0 });
}

function addSmokeCloud(x, y, z, def) {
  const m = new THREE.Mesh(smokeGeo, smokeMat.clone());
  m.position.set(x, y, z);
  m.scale.setScalar(0.2);
  scene.add(m);
  smokeClouds.push({ x: x, y: y, z: z, r: def.radius, t: def.dur, life: def.dur, m: m });
}

// Shared with enemy line-of-sight, which is why it is kept as plain data rather
// than read off the meshes.
function smokeVolumes() { return smokeClouds; }

function updateEquipmentEffects(dt) {
  if (playerFlashT > 0) {
    playerFlashT = Math.max(0, playerFlashT - dt);
    const el = $id('flash-overlay');
    if (el) el.style.opacity = Math.min(0.92, playerFlashT / 1.5);
  }
  for (let i = burnPatches.length - 1; i >= 0; i--) {
    const b = burnPatches[i];
    b.t -= dt;
    b.tick -= dt;
    b.m.material.opacity = 0.5 * Math.max(0, b.t / b.life);
    if (b.tick <= 0) {
      b.tick = 0.25;
      for (let e = 0; e < enemies.length; e++) {
        const en = enemies[e];
        if (en.dead) continue;
        if (CORE.horizDist(en.pos.x, en.pos.z, b.x, b.z) < b.r) {
          damageEnemy(en, b.dps * 0.25, en.pos.clone().setY(en.pos.y + 1), false);
        }
      }
    }
    if (b.t <= 0) { scene.remove(b.m); b.m.material.dispose(); burnPatches.splice(i, 1); }
  }
  for (let i = smokeClouds.length - 1; i >= 0; i--) {
    const c = smokeClouds[i];
    c.t -= dt;
    // Bloom out over the first second, then hold, then fade.
    const grow = Math.min(1, (c.life - c.t) / 1.0);
    c.m.scale.setScalar(c.r * (0.25 + 0.75 * grow));
    c.m.material.opacity = 0.62 * Math.min(1, Math.max(0, c.t / 1.5));
    if (c.t <= 0) { scene.remove(c.m); c.m.material.dispose(); smokeClouds.splice(i, 1); }
  }
}

function resetEquipment() {
  equippedLethal = 'frag';
  equippedTactical = null;
  tacticalCount = 0;
  playerFlashT = 0;
  for (let i = burnPatches.length - 1; i >= 0; i--) {
    scene.remove(burnPatches[i].m); burnPatches[i].m.material.dispose();
  }
  burnPatches.length = 0;
  for (let i = smokeClouds.length - 1; i >= 0; i--) {
    scene.remove(smokeClouds[i].m); smokeClouds[i].m.material.dispose();
  }
  smokeClouds.length = 0;
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
  const hit = grenadeLosRay.intersectObjects(grenadeTargets, true).filter(function (h) {
    return h.object !== ground && !h.object.userData.vfx && !h.object.userData.gun && !h.object.userData.sky && !h.object.userData.pickup;
  })[0];
  if (!hit || hit.distance >= dist - 0.05) return true;
  return !!targetEnemy && hit.object.userData.enemyRef === targetEnemy;
}

// One blast can query line of sight for every enemy in radius. Building the target
// list per enemy meant up to 14 full-scene array copies plus 14 raycasts in a
// single frame — a guaranteed hitch on a multi-kill grenade. Build it once.
function refreshGrenadeTargets() {
  grenadeTargets.length = 0;
  for (let i = 0; i < raycastColliders.length; i++) grenadeTargets.push(raycastColliders[i]);
  for (let i = 0; i < enemies.length; i++) {
    if (!enemies[i].dead && enemies[i].parts && enemies[i].parts.group) {
      grenadeTargets.push(enemies[i].parts.group);
    }
  }
}

function explodeGrenade(pos, scale) {
  const dmgScale = scale === undefined ? 1 : scale;
  playSound('explosion');
  refreshGrenadeTargets();
  // flash sphere vfx — pooled. This used to allocate a fresh SphereGeometry AND
  // material per explosion; anything that outlived a resetGame() leaked both.
  const flash = blastFlashPool.length ? blastFlashPool.pop() : (function () {
    const m = new THREE.Mesh(blastFlashGeo, blastFlashMat);
    m.userData.vfx = true;
    m.userData.isBulletImpact = false;
    m.userData.blastFlash = true;
    return m;
  })();
  flash.visible = true;
  flash.position.copy(pos);
  scene.add(flash);
  vfx.impacts.push({ m: flash, life: 0.35, isBulletImpact: false, isBlastFlash: true });
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
      const dmg = CFG.grenade.dmg * (0.35 + 0.65 * falloff) * dmgScale;
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
  // Total rounds across everything the player is carrying.
  let roundsLeft = 0, magSize = 30;
  for (let i = 0; i < wState.length; i++) {
    if (!wState[i] || weaponsOwned[i] < 0) continue;
    roundsLeft += wState[i].ammo + wState[i].reserve;
    if (i === curWeapon) magSize = CFG.weapons[weaponsOwned[i]].mag;
  }
  const ammoChance = CORE.ammoDropChance(roundsLeft, magSize);
  const roll = Math.random();
  let kind = null;
  if (roll < ammoChance) kind = 'ammo';
  else if (player.health < playerMaxHealth() * 0.5 || roll < ammoChance + 0.15 * CORE.perkPickupMul(perks)) kind = 'med';
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

// ---- Power-up drops ----------------------------------------------------------
// A new pickup KIND rather than a new system: spawn, bob, blink and despawn are
// all already handled by updatePickups().
const powerGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
const POWER_COLOR = { maxammo: 0x6fa8ff, double: 0xffd24a, instakill: 0xff4030, nuke: 0x8fd66a };
const powerMats = {};
function powerMaterial(key) {
  if (!powerMats[key]) {
    powerMats[key] = new THREE.MeshBasicMaterial({ color: POWER_COLOR[key] || 0xffffff });
  }
  return powerMats[key];
}
function dropPowerUp(pos) {
  const def = CORE.pickPowerUp(Math.random());
  const g = new THREE.Mesh(powerGeo, powerMaterial(def.key));
  g.position.set(pos.x, 0.55, pos.z);
  g.userData.pickup = 'power';
  scene.add(g);
  pickups.push({ m: g, kind: 'power', power: def, t: 0 });
}

// Drop an ammo box at a specific spot, bypassing the random roll.
function forceAmmoPickup(x, z) {
  const g = new THREE.Mesh(pickupAmmoGeo, pickupAmmoMat);
  g.position.set(x, 0.3, z);
  g.castShadow = true;
  g.userData.pickup = 'ammo';
  scene.add(g);
  pickups.push({ m: g, kind: 'ammo', t: 0 });
}

function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.t += dt;
    p.m.rotation.y += dt * (p.kind === 'power' ? 4 : 2);
    if (p.kind === 'power') {
      p.m.rotation.x += dt * 1.6;
      p.m.position.y = 0.55 + Math.sin(p.t * 3) * 0.12;
    } else {
      p.m.position.y = 0.3 + Math.sin(p.t * 3) * 0.06;
    }
    // walk-over collect: HORIZONTAL distance — player.pos is anchored at eye
    // height (1.7 m), so 3D distance to a ground pickup (y=0.3) is always
    // >= 1.4 m and a 3D radius of 1.3 m could never collect anything.
    const d = Math.hypot(p.m.position.x - player.pos.x, p.m.position.z - player.pos.z);
    if (d < 1.3) {
      if (p.kind === 'power') {
        activatePowerUp(p.power);
        scene.remove(p.m);
        pickups.splice(i, 1);
        continue;
      }
      if (p.kind === 'ammo') {
        const s = curS();
        if (s) {
          const cw = curW();
          s.reserve = Math.min(cw.reserveMax, s.reserve + Math.round(cw.mag * 1.5 * CORE.perkPickupMul(perks)));
          updateHudAmmo();
          showCenterMsg('+ AMMO');
        }
      } else {
        const heal = 35 * CORE.perkPickupMul(perks);     // SCAVENGER
        player.health = Math.min(playerMaxHealth(), player.health + heal);
        player.armor = Math.min(CFG.player.armor, player.armor + 15 * CORE.perkPickupMul(perks));
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
