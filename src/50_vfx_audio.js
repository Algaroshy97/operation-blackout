// ============ VFX & AUDIO ============
'use strict';
// ---- Pooled VFX ----
const vfx = { tracers: [], impacts: [], blood: [] };
const tracerGeo = new THREE.BoxGeometry(0.025, 0.025, 1);
// Over-bright on purpose so the post-FX bloom gives tracers a hot core and glow.
const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe9a0).multiplyScalar(3) });
const tracerMatE = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8844).multiplyScalar(3) });
const impactGeo = new THREE.SphereGeometry(0.06, 6, 4);
const impactMat = new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85 });
const sparkGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffaa33 });
const bloodGeo = new THREE.SphereGeometry(0.05, 5, 4);
const bloodMat = new THREE.MeshBasicMaterial({ color: 0xa11212 });
const casingGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6);
const casingMat = new THREE.MeshStandardMaterial({ color: 0xd9a94a, roughness: 0.35, metalness: 0.85 });
// casings are 3 cm and there can be 24 of them; never worth a shadow-pass draw
const dustGeo = new THREE.SphereGeometry(0.14, 6, 5);
const dustMat = new THREE.MeshBasicMaterial({ color: 0xb9a98c, transparent: true, opacity: 0.5 });

// Mesh & particle pools
const tracerPool = [];
const impactPool = [];
const sparkPool = [];
const bloodPool = [];
const casingPool = [];
const dustPool = [];
// Record pools: reuse wrapper objects and Vector3 instances to eliminate GC churn
const particlePool = [];
const tracerRecPool = [];
const impactRecPool = [];
const _tmpSparkV = new THREE.Vector3();
const _particleOut = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };

function warmupVfx() {
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(tracerGeo, tracerMat);
    m.userData.vfx = true; m.visible = false;
    tracerPool.push(m);
    tracerRecPool.push({ m: null, life: 0, maxLife: 0, len: 0 });
  }
  for (let i = 0; i < 25; i++) {
    const m = new THREE.Mesh(impactGeo, impactMat);
    m.userData.vfx = true; m.visible = false;
    impactPool.push(m);
    impactRecPool.push({ m: null, life: 0, isBulletImpact: false, isBlastFlash: false });
  }
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(sparkGeo, sparkMat);
    m.userData.vfx = true; m.visible = false;
    sparkPool.push(m);
  }
  for (let i = 0; i < 80; i++) {
    const m = new THREE.Mesh(bloodGeo, bloodMat);
    m.userData.vfx = true; m.visible = false;
    bloodPool.push(m);
  }
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(casingGeo, casingMat);
    m.userData.vfx = true; m.visible = false;
    casingPool.push(m);
  }
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(dustGeo, dustMat);
    m.userData.vfx = true; m.visible = false;
    dustPool.push(m);
  }
  for (let i = 0; i < 80; i++) {
    particlePool.push({
      m: null, v: new THREE.Vector3(), life: 0, grav: 0,
      isSpark: false, isBlood: false, isDust: false
    });
  }
}
warmupVfx();

function getTracerRecord(m, life, maxLife, len, weaponType) {
  const r = tracerRecPool.length > 0 ? tracerRecPool.pop() : { m: null, life: 0, maxLife: 0, len: 0, weaponType: '' };
  r.m = m;
  r.life = life;
  r.maxLife = maxLife;
  r.len = len;
  r.weaponType = weaponType || '';
  return r;
}

function releaseTracerRecord(t) {
  if (!t) return;
  t.m = null;
  t.weaponType = '';
  tracerRecPool.push(t);
}

function getImpactRecord(m, life, isBulletImpact, isBlastFlash, weaponType) {
  const r = impactRecPool.length > 0 ? impactRecPool.pop() : { m: null, life: 0, isBulletImpact: false, isBlastFlash: false, weaponType: '' };
  r.m = m;
  r.life = life;
  r.isBulletImpact = !!isBulletImpact;
  r.isBlastFlash = !!isBlastFlash;
  r.weaponType = weaponType || '';
  return r;
}

function releaseImpactRecord(im) {
  if (!im) return;
  im.m = null;
  im.weaponType = '';
  impactRecPool.push(im);
}

function getParticleRecord(m, vx, vy, vz, life, grav, isSpark, isBlood, isDust) {
  const p = particlePool.length > 0 ? particlePool.pop() : {
    m: null, v: new THREE.Vector3(), life: 0, grav: 0,
    isSpark: false, isBlood: false, isDust: false
  };
  p.m = m;
  p.v.set(vx, vy, vz);
  p.life = life;
  p.grav = grav;
  p.isSpark = !!isSpark;
  p.isBlood = !!isBlood;
  p.isDust = !!isDust;
  return p;
}

function releaseParticleRecord(p) {
  if (!p) return;
  p.m = null;
  p.isSpark = false;
  p.isBlood = false;
  p.isDust = false;
  particlePool.push(p);
}

function getTracerMesh(mat) {
  const m = tracerPool.length > 0 ? tracerPool.pop() : new THREE.Mesh(tracerGeo, mat || tracerMat);
  m.material = mat || tracerMat;
  m.userData.vfx = true; m.visible = true;
  return m;
}
function getImpactMesh() {
  const m = impactPool.length > 0 ? impactPool.pop() : new THREE.Mesh(impactGeo, impactMat);
  m.userData.vfx = true; m.visible = true;
  return m;
}
function getSparkMesh() {
  const m = sparkPool.length > 0 ? sparkPool.pop() : new THREE.Mesh(sparkGeo, sparkMat);
  m.userData.vfx = true; m.visible = true;
  return m;
}
function getBloodMesh() {
  const m = bloodPool.length > 0 ? bloodPool.pop() : new THREE.Mesh(bloodGeo, bloodMat);
  m.userData.vfx = true; m.visible = true;
  return m;
}
function getDustMesh() {
  const m = dustPool.length > 0 ? dustPool.pop() : new THREE.Mesh(dustGeo, dustMat);
  m.userData.vfx = true; m.visible = true;
  return m;
}
function getCasingMesh() {
  const m = casingPool.length > 0 ? casingPool.pop() : new THREE.Mesh(casingGeo, casingMat);
  m.userData.vfx = true; m.visible = true;
  return m;
}

function spawnTracer(from, to, mat, weaponType) {
  const mMat = (mat === 0xff8844 || mat === tracerMatE) ? tracerMatE : (mat || tracerMat);
  const m = getTracerMesh(mMat);
  const len = from.distanceTo(to);
  const cal = (typeof CORE !== 'undefined' && typeof CORE.tracerCaliberScale === 'function')
    ? CORE.tracerCaliberScale(weaponType) : 1;
  m.scale.set(cal, cal, len);
  m.position.copy(from).add(to).multiplyScalar(0.5);
  m.lookAt(to);
  scene.add(m);
  vfx.tracers.push(getTracerRecord(m, CORE.TRACER_LIFETIME, CORE.TRACER_LIFETIME, len, weaponType));
}

const _tmpN = new THREE.Vector3();
function spawnImpact(point, normal, obj, soundOverride, weaponType) {
  // flash sphere + spark lines + decal-ish quad
  const m = getImpactMesh();
  m.position.copy(point);
  const cal = (typeof CORE !== 'undefined' && typeof CORE.impactFlashCaliberScale === 'function')
    ? CORE.impactFlashCaliberScale(weaponType) : 1;
  m.scale.set(cal, cal, cal);
  m.userData.isBulletImpact = true;
  scene.add(m);
  vfx.impacts.push(getImpactRecord(m, CORE.IMPACT_VFX_LIFETIME, true, false, weaponType));
  // dust, chips and sparks per surface (48_particles.js). The raycast normal is
  // in the hit object's space; the static batches sit at the origin, props do not.
  if (normal) {
    _tmpN.copy(normal);
    if (obj && obj.matrixWorld) _tmpN.transformDirection(obj.matrixWorld).normalize();
  } else _tmpN.set(0, 1, 0);
  const surface = fxSurfaceFor(obj);
  fxImpact(point, _tmpN, surface, weaponType);
  const impSnd = soundOverride || CORE.surfaceImpactSound(surface);
  if (point && player && player.pos) playSound3D(impSnd, point.x, point.y, point.z, CORE.SPATIAL_IMPACT_MAX_DIST);
  else playSound(impSnd);
}

// ---- Bullet-hole decals (v41): persistent marks on world hits ----
// One shared material + a fixed pool of 48 quads, FIFO-recycled when full:
// zero per-shot allocations, zero per-decal clones. Not in raycastColliders,
// so the scoped AI-LOS raycast can never see them; vfx-tagged for scene-wide rays.
const decalGeo = new THREE.PlaneGeometry(CORE.DECAL_BASE_RADIUS * 2, CORE.DECAL_BASE_RADIUS * 2);   // 15 cm base quad — reads at 15–40 m engagement range
const decalMat = new THREE.MeshBasicMaterial({
  map: TEX.bulletHole,
  transparent: true,
  opacity: 0.92,
  depthWrite: false,                                  // draw like a decal, not a solid
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4   // beat z-fighting on the wall face
});
const DECAL = { max: CORE.DECAL_MAX, live: [], pool: [] };
const _tmpD = new THREE.Vector3();
const _tmpD2 = new THREE.Vector3();
function spawnDecal(point, normal, obj, weaponType) {
  let d;
  if (DECAL.pool.length) {
    d = DECAL.pool.pop();
    d.m.visible = true;
  } else if (DECAL.live.length >= CORE.DECAL_MAX) {
    d = DECAL.live.shift();
  } else {
    const m = new THREE.Mesh(decalGeo, decalMat);
    m.userData.vfx = true;    // bullets / grenade LOS pass through every hole
    m.userData.decal = true;
    m.renderOrder = 1;
    scene.add(m);
    d = { m: m, life: CORE.DECAL_LIFETIME, weaponType: 'AR', surface: 'default' };
  }
  DECAL.live.push(d);
  _tmpD.copy(normal);
  if (obj && obj.matrixWorld) _tmpD.transformDirection(obj.matrixWorld).normalize();
  d.m.position.copy(point).addScaledVector(_tmpD, CORE.DECAL_STANDOFF);
  _tmpD2.copy(point).add(_tmpD);
  d.m.lookAt(_tmpD2);
  d.m.rotateZ(CORE.decalRotationAngle(Math.random()));
  const surface = fxSurfaceFor(obj);
  d.weaponType = weaponType || 'AR';
  d.surface = surface;
  d.life = CORE.DECAL_LIFETIME;
  const s = CORE.decalScale(d.weaponType, d.surface, d.life, CORE.DECAL_LIFETIME, CORE.DECAL_FADE_DURATION);
  d.m.scale.set(s, s, 1);
  d.t = gameT;
}
function updateDecals(dt) {
  for (let i = DECAL.live.length - 1; i >= 0; i--) {
    const d = DECAL.live[i];
    d.life = CORE.stepDecalLife(d.life, dt);
    if (CORE.isDecalExpired(d.life)) {
      d.m.visible = false;
      d.m.scale.set(1, 1, 1);
      DECAL.pool.push(d);
      DECAL.live.splice(i, 1);
      continue;
    }
    if (d.life < CORE.DECAL_FADE_DURATION) {
      const s = CORE.decalScale(d.weaponType, d.surface, d.life, CORE.DECAL_LIFETIME, CORE.DECAL_FADE_DURATION);
      d.m.scale.set(s, s, 1);
    }
  }
}
function clearDecals() {
  for (let i = 0; i < DECAL.live.length; i++) {
    DECAL.live[i].m.visible = false;
    DECAL.live[i].m.scale.set(1, 1, 1);
    DECAL.pool.push(DECAL.live[i]);
  }
  DECAL.live.length = 0;
}

const _bloodDir = new THREE.Vector3();
function spawnBlood(point, isHead, weaponType) {
  // spray away from the shooter: exit spatter reads as the hit direction
  _bloodDir.copy(point).sub(camera.position).setY(0);
  if (_bloodDir.lengthSq() < 1e-6) _bloodDir.set(0, 0, -1);
  _bloodDir.normalize();
  fxBlood(point, _bloodDir, isHead, weaponType);
}

// ---- Shell casings (eject on every shot) ----
let casingSndT = 0;   // last tink (ms) — throttle so full-auto doesn't spam
const casings = [];
const casingRecPool = [];
const _casingRight = new THREE.Vector3();
const _casingUp = new THREE.Vector3();
const _casingFwd = new THREE.Vector3();
const _casingVelOut = { x: 0, y: 0, z: 0 };
const _casingPhysOut = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spinX: 0, spinY: 0, spinZ: 0, rest: false, bounced: false };
const _casingRotOut = { rotX: 0, rotY: 0, rotZ: 0 };

function getCasingRecord(m, vx, vy, vz, sx, sy, sz, weaponType) {
  const r = casingRecPool.length > 0 ? casingRecPool.pop() : {
    m: null, v: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, rest: false, ry: 0, weaponType: ''
  };
  r.m = m;
  r.v.set(vx, vy, vz);
  r.spin.set(sx, sy, sz);
  r.life = CORE.CASING_LIFETIME;
  r.rest = false;
  r.ry = 0;
  r.weaponType = weaponType || '';
  return r;
}

function releaseCasingRecord(c) {
  if (!c) return;
  if (c.m) {
    scene.remove(c.m);
    c.m.visible = false;
    c.m.scale.set(1, 1, 1);
    casingPool.push(c.m);
    c.m = null;
  }
  casingRecPool.push(c);
}

function clearCasings() {
  for (let i = 0; i < casings.length; i++) {
    releaseCasingRecord(casings[i]);
  }
  casings.length = 0;
}

function spawnCasing(camPos, camQ, weaponType) {
  if (casings.length >= CORE.CASING_MAX) {
    const old = casings.shift();
    releaseCasingRecord(old);
  }
  const m = getCasingMesh();
  m.position.copy(camPos);
  const cal = (typeof CORE !== 'undefined' && typeof CORE.casingCaliberScale === 'function')
    ? CORE.casingCaliberScale(weaponType) : 1;
  m.scale.set(cal, cal, cal);
  _casingRight.set(1, 0, 0).applyQuaternion(camQ);
  _casingUp.set(0, 1, 0).applyQuaternion(camQ);
  _casingFwd.set(0, 0, -1).applyQuaternion(camQ);
  m.position.addScaledVector(_casingRight, 0.25).addScaledVector(_casingUp, -0.15);
  m.position.addScaledVector(_casingFwd, 0.3);
  const imp = (typeof CORE !== 'undefined' && typeof CORE.casingEjectImpulse === 'function')
    ? CORE.casingEjectImpulse(weaponType) : 1;
  const vel = CORE.casingEjectVelocity(_casingRight.x, _casingRight.y, _casingRight.z, Math.random(), Math.random(), imp, _casingVelOut);
  const sx = Math.random() * 14 - 7, sy = Math.random() * 14 - 7, sz = Math.random() * 14 - 7;
  scene.add(m);
  casings.push(getCasingRecord(m, vel.x, vel.y, vel.z, sx, sy, sz, weaponType));
}

function updateCasings(dt) {
  for (let i = casings.length - 1; i >= 0; i--) {
    const c = casings[i];
    c.life -= dt;
    if (c.life <= 0) {
      releaseCasingRecord(c);
      casings.splice(i, 1);
      continue;
    }
    // Smooth visual despawn: shrink in final 0.35s to eliminate abrupt pop-out
    if (c.life < CORE.CASING_FADE_DURATION) {
      const cal = (typeof CORE !== 'undefined' && typeof CORE.casingCaliberScale === 'function')
        ? CORE.casingCaliberScale(c.weaponType) : 1;
      c.m.scale.setScalar(CORE.casingScale(c.life, CORE.CASING_LIFETIME, CORE.CASING_FADE_DURATION, cal));
    }
    if (!c.rest) {
      const p = CORE.stepCasingPhysics(
        c.m.position.x, c.m.position.y, c.m.position.z,
        c.v.x, c.v.y, c.v.z,
        c.spin.x, c.spin.y, c.spin.z,
        dt, CORE.CASING_GRAVITY, CORE.CASING_BOUNCE, CORE.CASING_FRICTION, CORE.CASING_SPIN_DAMP,
        CORE.CASING_FLOOR_Y, CORE.CASING_REST_SPEED, _casingPhysOut
      );
      c.m.position.set(p.x, p.y, p.z);
      c.v.set(p.vx, p.vy, p.vz);
      c.spin.set(p.spinX, p.spinY, p.spinZ);
      c.m.rotation.x += c.spin.x * dt;
      c.m.rotation.y += c.spin.y * dt;
      c.m.rotation.z += c.spin.z * dt;
      if (p.bounced) {
        const now = performance.now();
        if (now - casingSndT > CORE.CASING_SND_GAP * 1000) {
          playSound(CORE.casingBounceSound(c.weaponType));
          casingSndT = now;
        }
      }
      if (p.rest) {
        c.rest = true;
        // Realistic ground settle: spent casing rests horizontally on floor
        CORE.casingRestRotation(c.m.rotation.x, c.m.rotation.y, c.m.rotation.z, _casingRotOut);
        c.m.rotation.set(_casingRotOut.rotX, _casingRotOut.rotY, _casingRotOut.rotZ);
      }
    }
  }
}

// ---- Slide dust ----
function spawnSlideDust(pos, actionType, speed) {
  if (typeof CORE !== 'undefined' && typeof CORE.slideDustVfxParams === 'function') {
    const p = CORE.slideDustVfxParams(actionType, speed);
    fxDust(pos, p.count, p.spread, p.scale, p.color0, p.color1);
  } else {
    fxDust(pos, 6, 1);
  }
}

// ---- Muzzle light (point light flash at gun) ----
let muzzleLight = null;
function flashMuzzleLight(weaponType, isSuppressed) {
  if (!muzzleLight) {
    // Punctual lights are in candela since r155; decay 2 is now the default.
    muzzleLight = new THREE.PointLight(CORE.MUZZLE_LIGHT_COLOR_STANDARD, 0, CORE.MUZZLE_LIGHT_DIST_STANDARD, 2);
    muzzleLight.userData.vfx = true;
    scene.add(muzzleLight);
  }
  const params = CORE.muzzleFlashLightParams(weaponType, isSuppressed);
  muzzleLight.color.setHex(params.color);
  muzzleLight.distance = params.distance;
  muzzleLight.position.copy(camera.position);
  muzzleLight.intensity = CORE.VIEWMODEL_MUZZLE_LIGHT_BASE_INTENSITY * LIGHT_COMPAT * 4 * params.intensityMul;
}
function updateMuzzleLight(dt) {
  if (muzzleLight && muzzleLight.intensity > 0) {
    muzzleLight.intensity = CORE.stepMuzzleLight(muzzleLight.intensity, dt, CORE.VIEWMODEL_MUZZLE_LIGHT_DECAY_RATE, LIGHT_COMPAT);
  }
}
function updateVfx(dt) {
  updateDecals(dt);
  for (let i = vfx.tracers.length - 1; i >= 0; i--) {
    const t = vfx.tracers[i];
    t.life = CORE.stepTracerLife(t.life, dt);
    if (CORE.isTracerExpired(t.life)) {
      scene.remove(t.m);
      t.m.visible = false;
      t.m.scale.set(1, 1, 1);
      tracerPool.push(t.m);
      releaseTracerRecord(t);
      vfx.tracers.splice(i, 1);
    } else {
      const cal = (typeof CORE !== 'undefined' && typeof CORE.tracerCaliberScale === 'function')
        ? CORE.tracerCaliberScale(t.weaponType) : 1;
      const thick = CORE.tracerThicknessScale(t.life, t.maxLife, cal);
      t.m.scale.set(thick, thick, t.len);
    }
  }
  for (let i = vfx.impacts.length - 1; i >= 0; i--) {
    const im = vfx.impacts[i];
    im.life = CORE.stepImpactLife(im.life, dt);
    const impCal = (typeof CORE !== 'undefined' && typeof CORE.impactFlashCaliberScale === 'function')
      ? CORE.impactFlashCaliberScale(im.weaponType) : 1;
    im.m.scale.setScalar(CORE.impactVfxScale(im.life, CORE.IMPACT_VFX_LIFETIME, impCal));
    if (CORE.isImpactExpired(im.life)) {
      scene.remove(im.m);
      im.m.visible = false;
      if (im.isBulletImpact || (im.m.userData && im.m.userData.isBulletImpact)) {
        impactPool.push(im.m);
      } else if (im.isBlastFlash || (im.m.userData && im.m.userData.blastFlash)) {
        releaseBlastFlash(im.m);   // shared geo/material: recycle, never dispose
      } else {
        if (im.m.geometry) im.m.geometry.dispose();
        if (im.m.material) im.m.material.dispose();
      }
      releaseImpactRecord(im);
      vfx.impacts.splice(i, 1);
    }
  }
  for (let i = vfx.blood.length - 1; i >= 0; i--) {
    const b = vfx.blood[i];
    b.life -= dt;
    const stepped = CORE.stepParticlePhysics(
      b.m.position.x, b.m.position.y, b.m.position.z,
      b.v.x, b.v.y, b.v.z,
      b.grav, dt, 0.02, _particleOut
    );
    b.m.position.set(stepped.x, stepped.y, stepped.z);
    b.v.set(stepped.vx, stepped.vy, stepped.vz);
    if (b.life <= 0) {
      scene.remove(b.m);
      b.m.visible = false;
      if (b.isSpark) sparkPool.push(b.m);
      else if (b.isBlood) bloodPool.push(b.m);
      else if (b.isDust) dustPool.push(b.m);
      releaseParticleRecord(b);
      vfx.blood.splice(i, 1);
    }
  }
}

// ---- Audio (WebAudio, all synthesized — no assets) ----
let AC = null;
let masterGain = null;
// Every sound used to connect straight to ctx.destination, which meant there was
// nowhere to put a volume control and no way to see how many voices were live.
// One bus fixes both.
function audioMaster() {
  const ctx = audioCtx();
  if (!ctx) return null;
  if (!masterGain) {
    masterGain = ctx.createGain();
    masterGain.gain.value = AUDIO.master;
    masterGain.connect(ctx.destination);
  }
  return masterGain;
}
const AUDIO = { master: 0.9, voices: 0, maxVoices: 24 };
function setMasterVolume(v) {
  AUDIO.master = Math.max(0, Math.min(1, v));
  const g = audioMaster();
  if (g) g.gain.value = AUDIO.master;
}
// Rate-limit per sound name. At 750 RPM the impact ping alone was building ~5
// WebAudio nodes 12 times a second; measured, synthesised audio was the single
// largest cost in fireShot — larger than both raycasts combined.
const _sndLast = Object.create(null);
const SND_MIN_GAP = {
  impact: 0.045, impact_metal: 0.045, impact_wood: 0.045, impact_glass: 0.045, impact_ground: 0.045,
  casing: 0.09, estep: 0.05, step: 0.05, hit: 0.03,
  breath_hold: 0.4, breath_gasp: 0.4, exhausted: 1.2, slide_cancel: 0.15,
  sniper_bolt: 0.4, streak_ready: 0.5, field_ready: 0.5, second_wind: 1.0, objective_complete: 0.5,
  draw_heavy: 0.15, draw_light: 0.15,
  heartbeat: 0.3, eshot_elite: 0.05,
  shot_suppressed: 0.045, smg_suppressed: 0.04, br_suppressed: 0.05, sniper_suppressed: 0.15,
  plate_insert: 0.3, plate_lock: 0.3, tinnitus: 1.5,
  melee_hit: 0.12, melee_backstab: 0.20, hit_cover: 0.03, step_tac: 0.04, land_heavy: 0.20,
  jump_slide: 0.15, chamber_empty: 0.10, enemy_hit: 0.08, enemy_hit_heavy: 0.15,
  shield_deflect: 0.05, helmet_hit: 0.04,
  estep_heavy: 0.05, reload_heavy_out: 0.15, reload_heavy_in: 0.15, reload_smg_out: 0.15, reload_smg_in: 0.15, melee_hit_metal: 0.08,
  dry_heavy: 0.06, melee_heavy: 0.08, explosion_heavy: 0.08,
  scope_heavy_in: 0.08, scope_heavy_out: 0.08, casing_heavy: 0.05, kill_heavy: 0.06
};
function soundThrottled(name) {
  const gap = SND_MIN_GAP[name];
  if (gap === undefined) return false;
  const now = performance.now() / 1000;
  if (_sndLast[name] !== undefined && now - _sndLast[name] < gap) return true;
  _sndLast[name] = now;
  return false;
}
function audioCtx() {
  if (!AC) {
    try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function noiseBuffer(ctx) {
  const len = ctx.sampleRate * 0.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
let noiseBuf = null;

// ---- Sound recipes ---------------------------------------------------------
// Every sound is a short stack of two primitives, so the same description can be
// synthesised live OR rendered once into an AudioBuffer and replayed. Layers:
//   ['noise', dur, gain, freq, q]        band-passed white noise
//   ['osc', type, f0, f1, dur, gain]     oscillator with an optional pitch ramp
// Keeping these as data — rather than the switch that used to build nodes inline —
// is what makes the pre-render below possible.
const SOUND_RECIPES = {
  shot:        [['noise', 0.09, 0.5, 900, 0.7], ['osc', 'square', 190, 70, 0.07, 0.28]],
  smg:         [['noise', 0.065, 0.42, 1250, 0.85], ['osc', 'square', 260, 110, 0.05, 0.22]],
  br:          [['noise', 0.12, 0.58, 650, 0.6], ['osc', 'square', 140, 50, 0.10, 0.32], ['osc', 'sine', 85, 30, 0.13, 0.22]],
  sniper:      [['noise', 0.16, 0.6, 700, 0.6], ['osc', 'sine', 150, 40, 0.22, 0.4], ['noise', 0.5, 0.25, 220, 0.4]],
  shotgun:     [['noise', 0.2, 0.72, 520, 0.5], ['osc', 'sine', 115, 34, 0.2, 0.46], ['noise', 0.45, 0.24, 1300, 0.6]],
  pump:        [['noise', 0.06, 0.3, 1100, 2.2], ['osc', 'square', 210, 120, 0.05, 0.12], ['noise', 0.05, 0.26, 1700, 2.6]],
  shell_in:    [['noise', 0.045, 0.22, 1900, 3], ['osc', 'square', 430, 300, 0.03, 0.06]],
  scope_in:    [['osc', 'sine', 900, 1300, 0.09, 0.08]],
  scope_out:   [['osc', 'sine', 1300, 800, 0.09, 0.08]],
  slide:       [['noise', 0.25, 0.3, 420, 0.5], ['noise', 0.18, 0.2, 150, 0.4]],
  casing:      [['osc', 'square', 2400, 1800, 0.03, 0.04]],
  eshot:       [['noise', 0.11, 0.24, 500, 0.8], ['osc', 'sawtooth', 140, 55, 0.09, 0.14]],
  impact:      [['noise', 0.05, 0.18, 2400, 2]],
  explosion:   [['noise', 0.6, 0.55, 180, 0.5], ['osc', 'sine', 120, 25, 0.5, 0.4], ['noise', 0.3, 0.3, 700, 0.6]],
  bounce:      [['osc', 'sine', 500, 350, 0.04, 0.1]],
  pin:         [['noise', 0.05, 0.15, 2000, 3]],
  reload_out:  [['noise', 0.06, 0.2, 1300, 3], ['osc', 'square', 220, 140, 0.05, 0.06]],
  reload_in:   [['noise', 0.05, 0.22, 1600, 3], ['osc', 'square', 300, 200, 0.04, 0.07]],
  dry:         [['osc', 'square', 900, 700, 0.03, 0.1]],
  draw:        [['noise', 0.05, 0.15, 1800, 2]],
  melee:       [['noise', 0.12, 0.3, 300, 0.6], ['osc', 'sawtooth', 90, 45, 0.11, 0.2]],
  hit:         [['osc', 'sine', 1150, 900, 0.05, 0.16]],
  // Dull, low and short: a blocked round has to sound like nothing happened,
  // because that is exactly the information the player needs.
  block:       [['osc', 'square', 340, 260, 0.05, 0.10], ['noise', 0.05, 0.12, 500, 1.2]],
  armor_break: [['osc', 'square', 780, 260, 0.07, 0.22], ['noise', 0.12, 0.35, 2200, 2], ['osc', 'sine', 200, 80, 0.10, 0.25]],
  powerup:     [['osc', 'sine', 520, 1040, 0.22, 0.20], ['osc', 'sine', 780, 1560, 0.22, 0.10]],
  headshot:    [['osc', 'sine', 1500, 1150, 0.07, 0.2], ['osc', 'sine', 750, 600, 0.07, 0.12]],
  kill:        [['osc', 'sine', 600, 400, 0.09, 0.14]],
  kill_headshot: [['osc', 'sine', 1600, 1100, 0.08, 0.22], ['noise', 0.05, 0.18, 2800, 2.5], ['osc', 'sine', 750, 420, 0.11, 0.16]],
  kill_elite:    [['noise', 0.10, 0.35, 750, 1.8], ['osc', 'sawtooth', 280, 120, 0.14, 0.22], ['osc', 'sine', 140, 35, 0.22, 0.35]],
  multikill:     [['osc', 'sine', 520, 780, 0.12, 0.20], ['osc', 'sine', 780, 1040, 0.14, 0.16], ['osc', 'triangle', 260, 520, 0.16, 0.12]],
  hurt:        [['osc', 'sawtooth', 180, 90, 0.16, 0.22], ['noise', 0.14, 0.16, 400, 0.7]],
  wave:        [['osc', 'sine', 220, 0, 0.5, 0.2], ['osc', 'sine', 330, 0, 0.5, 0.14], ['osc', 'sine', 440, 0, 0.7, 0.1]],
  death:       [['osc', 'sawtooth', 200, 30, 1.2, 0.3], ['noise', 0.8, 0.2, 200, 0.5]],
  victory:     [['osc', 'sine', 523, 0, 0.3, 0.18], ['osc', 'sine', 659, 0, 0.3, 0.18], ['osc', 'sine', 784, 0, 0.6, 0.2]],
  step:        [['noise', 0.04, 0.05, 500, 1]],
  jump:        [['noise', 0.06, 0.06, 700, 1]],
  land:        [['noise', 0.08, 0.12, 300, 0.8]],
  click:       [['osc', 'square', 1000, 800, 0.02, 0.08]],
  estep:       [['noise', 0.05, 0.06, 320, 1]],          // enemy footstep: deeper/thud-ier than player step
  pickup_ammo: [['osc', 'square', 520, 780, 0.09, 0.12], ['noise', 0.04, 0.10, 2400, 2]],  // metallic ammo-box rattle
  pickup_med:  [['osc', 'sine', 660, 990, 0.12, 0.12], ['osc', 'sine', 990, 1320, 0.14, 0.08]], // bright medkit chime
  streak_uav:        [['osc', 'sine', 880, 1760, 0.14, 0.22], ['osc', 'sine', 1760, 880, 0.12, 0.12], ['noise', 0.08, 0.12, 3200, 2]],
  streak_airstrike:  [['noise', 0.55, 0.45, 280, 0.5], ['osc', 'sawtooth', 160, 65, 0.45, 0.26], ['noise', 0.35, 0.3, 850, 0.8]],
  streak_sentry:     [['noise', 0.08, 0.28, 1400, 2], ['osc', 'square', 320, 580, 0.12, 0.18], ['osc', 'sine', 180, 90, 0.10, 0.25]],
  sentry_shot:       [['noise', 0.07, 0.38, 1100, 1.2], ['osc', 'square', 240, 75, 0.06, 0.24], ['osc', 'sine', 110, 45, 0.08, 0.18]],
  munitions:         [['osc', 'sine', 130, 40, 0.20, 0.35], ['noise', 0.12, 0.32, 450, 1.0], ['noise', 0.06, 0.25, 2200, 2.5]],
  munitions_resupply:[['osc', 'sine', 587, 880, 0.12, 0.18], ['noise', 0.06, 0.16, 2600, 2.2], ['osc', 'square', 440, 660, 0.08, 0.10]],
  mantle:            [['noise', 0.09, 0.22, 950, 1.2], ['osc', 'sine', 160, 70, 0.12, 0.20]],
  step_crouch:       [['noise', 0.035, 0.022, 280, 0.8]],
  armory_upgrade:    [['noise', 0.14, 0.32, 900, 1.5], ['osc', 'sawtooth', 220, 660, 0.22, 0.25], ['osc', 'sine', 330, 880, 0.25, 0.20]],
  door_unlock:       [['noise', 0.35, 0.38, 240, 0.7], ['osc', 'sawtooth', 120, 40, 0.30, 0.28], ['osc', 'sine', 80, 30, 0.40, 0.32]],
  weapon_buy:        [['noise', 0.08, 0.25, 1400, 2.2], ['osc', 'square', 320, 180, 0.06, 0.16], ['noise', 0.06, 0.22, 2200, 3]],
  player_down:       [['osc', 'sawtooth', 140, 40, 0.35, 0.28], ['noise', 0.22, 0.26, 320, 0.8], ['osc', 'sine', 75, 25, 0.30, 0.35]],
  player_revive:     [['osc', 'sine', 330, 660, 0.20, 0.22], ['osc', 'sine', 550, 1100, 0.22, 0.18], ['osc', 'triangle', 220, 440, 0.25, 0.15]],
  powerup_nuke:      [['noise', 0.65, 0.45, 160, 0.6], ['osc', 'sine', 110, 25, 0.7, 0.5], ['osc', 'sawtooth', 440, 330, 0.35, 0.18]],
  powerup_ammo:      [['noise', 0.12, 0.30, 1800, 2.5], ['osc', 'square', 480, 240, 0.08, 0.18], ['osc', 'sine', 350, 700, 0.16, 0.22]],
  powerup_double:    [['osc', 'sine', 587, 880, 0.15, 0.18], ['osc', 'triangle', 740, 1175, 0.18, 0.16], ['osc', 'sine', 1175, 1760, 0.20, 0.12]],
  powerup_instakill: [['osc', 'sawtooth', 196, 65, 0.30, 0.28], ['noise', 0.10, 0.26, 2600, 2.8], ['osc', 'sine', 98, 40, 0.32, 0.30]],
  claymore_plant:    [['noise', 0.08, 0.24, 600, 1.2], ['osc', 'square', 620, 310, 0.04, 0.14], ['osc', 'sine', 1200, 1600, 0.05, 0.10]],
  breath_hold:       [['noise', 0.18, 0.10, 450, 1.0], ['osc', 'sine', 70, 50, 0.20, 0.08]],
  breath_gasp:       [['noise', 0.22, 0.14, 550, 0.8], ['osc', 'sine', 90, 45, 0.18, 0.10]],
  exhausted:         [['noise', 0.28, 0.16, 420, 0.7], ['osc', 'sine', 110, 45, 0.22, 0.12]],
  slide_cancel:      [['noise', 0.10, 0.22, 650, 1.4], ['osc', 'sine', 160, 80, 0.08, 0.16]],
  impact_metal:      [['noise', 0.04, 0.22, 3400, 3], ['osc', 'sine', 1800, 900, 0.08, 0.18], ['osc', 'square', 880, 440, 0.05, 0.12]],
  impact_wood:       [['noise', 0.07, 0.24, 750, 1.4], ['osc', 'triangle', 220, 90, 0.06, 0.14]],
  impact_glass:      [['noise', 0.05, 0.28, 4800, 3.5], ['osc', 'square', 2400, 1200, 0.04, 0.12], ['osc', 'sine', 3200, 1600, 0.06, 0.10]],
  impact_ground:     [['noise', 0.08, 0.22, 350, 0.8], ['osc', 'sine', 110, 45, 0.07, 0.16]],
  sniper_bolt:       [['noise', 0.18, 0.32, 1600, 2.2], ['osc', 'square', 260, 130, 0.08, 0.18], ['osc', 'square', 180, 360, 0.09, 0.20], ['osc', 'sine', 140, 60, 0.12, 0.24]],
  streak_ready:      [['osc', 'sine', 880, 880, 0.08, 0.18], ['osc', 'sine', 1320, 1320, 0.10, 0.22], ['noise', 0.04, 0.08, 3000, 2]],
  field_ready:       [['osc', 'triangle', 660, 880, 0.10, 0.20], ['osc', 'sine', 880, 1100, 0.12, 0.18]],
  second_wind:       [['osc', 'sawtooth', 80, 240, 0.28, 0.35], ['osc', 'sine', 55, 110, 0.35, 0.40], ['noise', 0.20, 0.25, 400, 1.0]],
  objective_complete:[['osc', 'sine', 440, 660, 0.15, 0.22], ['osc', 'sine', 660, 880, 0.18, 0.20], ['osc', 'triangle', 880, 1320, 0.22, 0.16]],
  draw_heavy:        [['noise', 0.08, 0.22, 1200, 1.8], ['osc', 'square', 180, 90, 0.06, 0.14]],
  draw_light:        [['noise', 0.04, 0.14, 2400, 2.5], ['osc', 'sine', 400, 600, 0.03, 0.08]],
  bullet_whiz:       [['noise', 0.035, 0.28, 3600, 3.2], ['osc', 'sine', 2100, 480, 0.03, 0.14]],
  reload_bolt:       [['noise', 0.07, 0.28, 1400, 2.0], ['osc', 'square', 340, 180, 0.05, 0.15], ['osc', 'sine', 160, 70, 0.08, 0.22]],
  low_ammo:          [['osc', 'square', 1400, 1100, 0.025, 0.08], ['noise', 0.02, 0.08, 4200, 4]],
  heartbeat:         [['osc', 'sine', 68, 30, 0.11, 0.32], ['osc', 'sine', 52, 22, 0.13, 0.26], ['noise', 0.06, 0.12, 110, 0.8]],
  eshot_elite:       [['noise', 0.14, 0.36, 420, 0.7], ['osc', 'sawtooth', 160, 48, 0.11, 0.22], ['osc', 'sine', 95, 30, 0.15, 0.26]],
  shot_suppressed:   [['noise', 0.05, 0.28, 480, 1.2], ['osc', 'square', 140, 55, 0.04, 0.16], ['osc', 'sine', 90, 40, 0.06, 0.18]],
  smg_suppressed:    [['noise', 0.04, 0.24, 750, 1.5], ['osc', 'square', 180, 80, 0.035, 0.14], ['osc', 'sine', 110, 50, 0.05, 0.15]],
  br_suppressed:     [['noise', 0.07, 0.32, 380, 1.0], ['osc', 'square', 110, 45, 0.06, 0.18], ['osc', 'sine', 70, 25, 0.08, 0.22]],
  sniper_suppressed: [['noise', 0.09, 0.36, 420, 1.1], ['osc', 'sine', 110, 32, 0.14, 0.28], ['noise', 0.04, 0.22, 2200, 3.0]],
  plate_insert:      [['noise', 0.16, 0.26, 680, 1.2], ['osc', 'sine', 120, 80, 0.12, 0.14], ['noise', 0.08, 0.18, 1600, 2.0]],
  plate_lock:        [['osc', 'square', 480, 220, 0.06, 0.22], ['noise', 0.08, 0.24, 1800, 2.2], ['osc', 'sine', 160, 60, 0.09, 0.24]],
  tinnitus:          [['osc', 'sine', 3400, 3000, 1.8, 0.15], ['osc', 'sine', 6800, 6000, 1.2, 0.03]],
  melee_hit:         [['noise', 0.08, 0.32, 1200, 1.8], ['osc', 'sawtooth', 220, 70, 0.08, 0.24], ['osc', 'sine', 160, 40, 0.10, 0.28]],
  melee_backstab:    [['noise', 0.14, 0.42, 850, 1.2], ['osc', 'sawtooth', 310, 60, 0.16, 0.32], ['osc', 'sine', 120, 30, 0.22, 0.40]],
  hit_cover:         [['noise', 0.06, 0.28, 950, 1.4], ['osc', 'sine', 380, 180, 0.08, 0.18], ['osc', 'square', 180, 90, 0.04, 0.12]],
  step_tac:          [['noise', 0.05, 0.11, 420, 1.1], ['osc', 'sine', 130, 45, 0.06, 0.16]],
  land_heavy:        [['noise', 0.16, 0.32, 180, 0.6], ['osc', 'sine', 140, 30, 0.20, 0.35], ['osc', 'square', 75, 25, 0.12, 0.18]],
  jump_slide:        [['noise', 0.08, 0.12, 520, 1.2], ['osc', 'sine', 150, 260, 0.08, 0.14]],
  chamber_empty:     [['osc', 'square', 680, 260, 0.035, 0.10], ['noise', 0.03, 0.12, 2800, 2.8]],
  enemy_hit:         [['noise', 0.08, 0.25, 750, 1.4], ['osc', 'sawtooth', 150, 50, 0.09, 0.20]],
  enemy_hit_heavy:   [['noise', 0.15, 0.35, 200, 0.7], ['osc', 'sine', 110, 30, 0.16, 0.32], ['osc', 'square', 75, 25, 0.09, 0.16]],
  shield_deflect:    [['noise', 0.05, 0.35, 2600, 2.5], ['osc', 'square', 520, 240, 0.07, 0.22], ['osc', 'sine', 960, 480, 0.10, 0.20]],
  helmet_hit:        [['noise', 0.04, 0.28, 3600, 3.2], ['osc', 'sine', 2400, 1200, 0.08, 0.20], ['osc', 'square', 1200, 600, 0.04, 0.12]],
  estep_heavy:       [['noise', 0.08, 0.12, 180, 0.7], ['osc', 'sine', 95, 30, 0.10, 0.22]],
  reload_heavy_out:  [['noise', 0.08, 0.26, 950, 1.8], ['osc', 'square', 160, 90, 0.06, 0.12]],
  reload_heavy_in:   [['noise', 0.08, 0.30, 1100, 2.0], ['osc', 'square', 200, 280, 0.05, 0.15], ['osc', 'sine', 110, 45, 0.08, 0.20]],
  reload_smg_out:    [['noise', 0.04, 0.16, 2200, 3.2], ['osc', 'square', 380, 220, 0.035, 0.08]],
  reload_smg_in:     [['noise', 0.045, 0.18, 2400, 3.0], ['osc', 'square', 420, 520, 0.04, 0.10]],
  melee_hit_metal:   [['noise', 0.05, 0.28, 3600, 3.0], ['osc', 'square', 1400, 700, 0.06, 0.16], ['osc', 'sine', 2200, 1100, 0.08, 0.18]],
  dry_heavy:         [['osc', 'square', 460, 240, 0.04, 0.15], ['noise', 0.03, 0.12, 1600, 2.5], ['osc', 'sine', 180, 80, 0.045, 0.12]],
  melee_heavy:       [['noise', 0.16, 0.38, 480, 0.9], ['osc', 'sawtooth', 130, 45, 0.13, 0.26], ['osc', 'sine', 85, 30, 0.12, 0.20]],
  explosion_heavy:   [['noise', 0.75, 0.65, 140, 0.4], ['osc', 'sine', 95, 20, 0.65, 0.5], ['osc', 'sawtooth', 60, 20, 0.35, 0.22], ['noise', 0.4, 0.32, 550, 0.7]],
  scope_heavy_in:    [['osc', 'sine', 600, 1050, 0.11, 0.14], ['noise', 0.04, 0.10, 1800, 2.0]],
  scope_heavy_out:   [['osc', 'sine', 1050, 520, 0.10, 0.12], ['noise', 0.03, 0.08, 1400, 2.0]],
  casing_heavy:      [['osc', 'square', 1400, 950, 0.045, 0.07], ['noise', 0.025, 0.08, 2800, 2.0]],
  kill_heavy:        [['osc', 'sine', 380, 180, 0.16, 0.28], ['noise', 0.08, 0.22, 600, 1.5], ['osc', 'sawtooth', 180, 60, 0.12, 0.20]]
};

// Percussive sounds that repeat constantly. A pre-rendered buffer is bit-identical
// every time, so these get a few percent of pitch jitter — which is more variation
// than the old live synthesis had, since its parameters were fixed too.
const SOUND_VARIED = {
  shot: 1, smg: 1, br: 1, eshot: 1, impact: 1, casing: 1, step: 1, estep: 1, hit: 1, sniper: 1,
  shotgun: 1, pump: 1, shell_in: 1,
  jump: 1, land: 1, melee: 1, bounce: 1, headshot: 1, slide: 1, hurt: 1,
  block: 1, armor_break: 1, kill: 1, kill_headshot: 1, kill_elite: 1, multikill: 1, dry: 1, draw: 1, pin: 1, reload_out: 1, reload_in: 1,
  pickup_ammo: 1, pickup_med: 1,
  streak_uav: 1, streak_airstrike: 1, streak_sentry: 1, sentry_shot: 1, munitions: 1, munitions_resupply: 1,
  mantle: 1, step_crouch: 1,
  armory_upgrade: 1, door_unlock: 1, weapon_buy: 1, player_down: 1, player_revive: 1,
  powerup_nuke: 1, powerup_ammo: 1, powerup_double: 1, powerup_instakill: 1,
  claymore_plant: 1, breath_hold: 1, breath_gasp: 1, exhausted: 1, slide_cancel: 1,
  impact_metal: 1, impact_wood: 1, impact_glass: 1, impact_ground: 1,
  sniper_bolt: 1, streak_ready: 1, field_ready: 1,
  second_wind: 1, objective_complete: 1, draw_heavy: 1, draw_light: 1,
  bullet_whiz: 1, reload_bolt: 1, low_ammo: 1, heartbeat: 1, eshot_elite: 1,
  shot_suppressed: 1, smg_suppressed: 1, br_suppressed: 1, sniper_suppressed: 1,
  plate_insert: 1, plate_lock: 1, tinnitus: 1,
  melee_hit: 1, melee_backstab: 1, hit_cover: 1, step_tac: 1, land_heavy: 1,
  jump_slide: 1, chamber_empty: 1, enemy_hit: 1, enemy_hit_heavy: 1,
  shield_deflect: 1, helmet_hit: 1,
  estep_heavy: 1, reload_heavy_out: 1, reload_heavy_in: 1, reload_smg_out: 1, reload_smg_in: 1, melee_hit_metal: 1,
  dry_heavy: 1, melee_heavy: 1, explosion_heavy: 1,
  scope_heavy_in: 1, scope_heavy_out: 1, casing_heavy: 1, kill_heavy: 1
};

function recipeDuration(recipe) {
  let d = 0;
  for (let i = 0; i < recipe.length; i++) {
    const L = recipe[i];
    d = Math.max(d, L[0] === 'noise' ? L[1] : L[4]);
  }
  return d + 0.05;
}

// Build one recipe into `ctx` at time `t`, connected to `out`. Shared by the live
// path and the offline render, so the two cannot drift apart.
function buildSound(ctx, recipe, out, t, noise) {
  function env(g0, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    return g;
  }
  for (let i = 0; i < recipe.length; i++) {
    const L = recipe[i];
    if (L[0] === 'osc') {
      const o = ctx.createOscillator();
      o.type = L[1]; o.frequency.setValueAtTime(L[2], t);
      if (L[3]) o.frequency.exponentialRampToValueAtTime(L[3], t + L[4]);
      o.connect(env(L[5], L[4]));
      o.start(t); o.stop(t + L[4] + 0.02);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = L[3]; f.Q.value = L[4] || 1;
      src.connect(f); f.connect(env(L[2], L[1]));
      src.start(t); src.stop(t + L[1] + 0.02);
    }
  }
}

// ---- Pre-rendered one-shots ------------------------------------------------
// Synthesising a gunshot per trigger was the largest single cost in fireShot
// (0.116 ms of a 0.263 ms budget), because every shot allocated and connected
// five WebAudio nodes. Rendering each recipe once through an OfflineAudioContext
// turns playback into a single BufferSource.
const _sndBuffers = Object.create(null);
const _sndRendering = Object.create(null);
function renderSoundBuffer(name) {
  if (_sndBuffers[name] || _sndRendering[name]) return;
  const ctx = audioCtx();
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!ctx || !OAC || !SOUND_RECIPES[name]) return;
  _sndRendering[name] = true;
  try {
    const rate = ctx.sampleRate;
    const off = new OAC(1, Math.ceil(recipeDuration(SOUND_RECIPES[name]) * rate), rate);
    buildSound(off, SOUND_RECIPES[name], off.destination, 0, noiseBuffer(off));
    const done = off.startRendering();
    // Older Safari resolves through oncomplete rather than the returned promise.
    if (done && done.then) {
      done.then(function (buf) { _sndBuffers[name] = buf; },
                function () { _sndRendering[name] = false; });
    } else {
      off.oncomplete = function (e) { _sndBuffers[name] = e.renderedBuffer; };
    }
  } catch (e) { _sndRendering[name] = false; }
}
// Called once the audio context exists, so even the first shot is already cheap.
function prerenderSounds() {
  for (const name in SOUND_RECIPES) renderSoundBuffer(name);
}

function playSound(name, dest, skipThrottle) {
  const ctx = audioCtx();
  if (!ctx) return;
  if (!skipThrottle && soundThrottled(name)) return;
  const out = dest || audioMaster() || ctx.destination;
  const buf = _sndBuffers[name];
  if (buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (SOUND_VARIED[name]) src.playbackRate.value = CORE.soundPlaybackRate(1, Math.random());
    src.connect(out);
    src.start(ctx.currentTime);
    return;
  }
  const recipe = SOUND_RECIPES[name];
  if (!recipe) return;
  if (!noiseBuf) noiseBuf = noiseBuffer(ctx);
  buildSound(ctx, recipe, out, ctx.currentTime, noiseBuf);
  renderSoundBuffer(name);   // pay the synthesis cost once, not on every trigger
}

// Positional enemy audio: distance attenuation + stereo pan relative to player facing.
// maxDist sounds fade to nothing; pan -1 (full left) .. +1 (full right).
// A distance-scaled lowpass filter simulates high-frequency air absorption:
// nearby sounds are full-spectrum; distant sounds become progressively muffled.
const _spatialAudioOut = { dist: 0, pan: 0, vol: 0, cutoff: 0, audible: false };

function playSound3D(name, x, y, z, maxDist) {
  const ctx = audioCtx();
  if (!ctx) return;
  if (!player || !player.pos) return;
  const dx = x - player.pos.x, dz = z - player.pos.z;
  if (!CORE.isSpatialAudioInRange(dx, dz, maxDist)) return;
  if (soundThrottled(name)) return;
  const spatial = CORE.spatialAudioParams(dx, dz, player.yaw, maxDist, _spatialAudioOut);
  if (!spatial.audible) return;
  // Muffle what a wall stands between (ear to a point a little above the source,
  // so ground-level sounds do not clip the floor).
  const blocked = spatial.dist > 1.5 && CORE.segmentBlocked(player.pos.x, player.pos.y, player.pos.z,
    x, y + 0.4, z, colliders, 0.1);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = CORE.occludedCutoff(spatial.cutoff, blocked);
  lp.Q.value = CORE.AIR_ABSORPTION_Q;
  const g = ctx.createGain();
  g.gain.value = spatial.vol * CORE.occludedGain(blocked);
  g.connect(lp);
  let p = null;
  if (ctx.createStereoPanner) {
    p = ctx.createStereoPanner();
    p.pan.value = spatial.pan;
    lp.connect(p); p.connect(audioMaster() || ctx.destination);
  } else lp.connect(audioMaster() || ctx.destination);
  playSound(name, g, true);
  setTimeout(() => {
    try {
      if (p) p.disconnect();
      lp.disconnect();
      g.disconnect();
    } catch (e) {}
  }, 800);
}

// footstep timing
let stepT = 0;
function updateFootsteps(dt) {
  const hs = Math.hypot(player.vel.x, player.vel.z);
  if (CORE.shouldPlayFootstep(player.onGround, hs)) {
    const isTac = !!(player.sprinting && player.tacT > 0);
    const cadence = CORE.footstepCadence(player.sprinting, isTac, player.crouching);
    stepT -= dt * cadence;
    if (stepT <= 0) {
      playSound(CORE.playerFootstepSound(player.crouching, isTac));
      stepT = 1;
    }
  }
  // landing
  if (player.onGround && !wasGround) {
    if (!player._heavyLanded) playSound(CORE.landingSound(false));
    player._heavyLanded = false;
  }
  wasGround = player.onGround;
}
let wasGround = true;

// ============ ADAPTIVE MUSIC ============
// Everything here is synthesised, like the rest of the audio — no asset bytes.
//
// A look-ahead sequencer: each frame schedules the sixteenth steps that fall in
// the next ~0.2 s on the audio clock, so timing is sample-accurate whatever the
// frame rate. What to play comes from CORE (chart, layer levels, patterns); this
// file only voices it. Layers sit on their own gain nodes and are faded with
// setTargetAtTime, never written per frame, so intensity changes cannot click.
// A layer whose level is ~0 schedules nothing, which keeps calm stretches cheap.
const MUSIC = {
  built: false, ctx: null, bus: null, comp: null, verb: null, layers: null,
  intensity: 0, running: false, step: 0, nextT: 0
};
const MUSIC_LOOKAHEAD = 0.2;

// Two seconds of decaying stereo noise: a cheap hall that glues the layers.
function musicImpulse(ctx) {
  const len = Math.floor(ctx.sampleRate * 2.0);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return buf;
}

function buildMusicGraph() {
  const ctx = audioCtx();
  if (!ctx || MUSIC.built) return MUSIC.built;
  const master = audioMaster();
  if (!master) return false;
  if (!noiseBuf) noiseBuf = noiseBuffer(ctx);

  MUSIC.ctx = ctx;
  MUSIC.bus = ctx.createGain();
  MUSIC.bus.gain.value = 0;             // faded in by updateMusic
  MUSIC.comp = ctx.createDynamicsCompressor();
  MUSIC.comp.threshold.value = -18; MUSIC.comp.ratio.value = 3;
  MUSIC.comp.attack.value = 0.01; MUSIC.comp.release.value = 0.25;
  MUSIC.bus.connect(MUSIC.comp); MUSIC.comp.connect(master);

  MUSIC.verb = ctx.createConvolver();
  MUSIC.verb.buffer = musicImpulse(ctx);
  const wet = ctx.createGain(); wet.gain.value = 0.5;
  MUSIC.verb.connect(wet); wet.connect(MUSIC.bus);

  // reverb send per layer: drums and bass stay mostly dry so they keep their punch
  const SENDS = { pad: 0.55, drums: 0.12, bass: 0.05, horn: 0.35, arp: 0.3 };
  MUSIC.layers = {};
  Object.keys(SENDS).forEach(function (k) {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(MUSIC.bus);
    const send = ctx.createGain(); send.gain.value = SENDS[k];
    g.connect(send); send.connect(MUSIC.verb);
    MUSIC.layers[k] = g;
  });
  MUSIC.built = true;
  return true;
}

// ---- voices ----
// Each takes the audio-clock time to start at and the layer node to play into.
function musOsc(ctx, type, hz, detune) {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = hz;
  if (detune) o.detune.value = detune;
  return o;
}
function musEnv(ctx, t, peak, attack, hold, release, out) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  g.connect(out);
  return g;
}
function musNoise(ctx, t, dur, type, hz, q, peak, out) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = hz; f.Q.value = q;
  const g = musEnv(ctx, t, peak, 0.002, 0, dur, out);
  src.connect(f); f.connect(g);
  src.start(t, Math.random() * 0.3); src.stop(t + dur + 0.05);
}

// Warm string pad: two detuned saws per chord tone plus a sine sub, darkened.
function musPad(ctx, t, chord, dur, out) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.5;
  const g = musEnv(ctx, t, 0.11, 0.9, Math.max(0.1, dur - 0.9), 1.4, out);
  lp.connect(g);
  const end = t + dur + 1.5;
  chord.notes.forEach(function (n) {
    const hz = CORE.midiToHz(n);
    [-7, 7].forEach(function (cents) {
      const o = musOsc(ctx, 'sawtooth', hz, cents);
      o.connect(lp); o.start(t); o.stop(end);
    });
  });
  const sub = musOsc(ctx, 'sine', CORE.midiToHz(chord.root + 12), 0);
  const sg = ctx.createGain(); sg.gain.value = 1.6;
  sub.connect(sg); sg.connect(lp); sub.start(t); sub.stop(end);
}
function musBass(ctx, t, note, out) {
  const o = musOsc(ctx, 'sawtooth', CORE.midiToHz(note), 0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 6;
  lp.frequency.setValueAtTime(1400, t);
  lp.frequency.exponentialRampToValueAtTime(160, t + 0.16);
  const g = musEnv(ctx, t, 0.22, 0.005, 0.06, 0.12, out);
  o.connect(lp); lp.connect(g);
  o.start(t); o.stop(t + 0.25);
}
function musArp(ctx, t, note, out) {
  const hz = CORE.midiToHz(note);
  const g = musEnv(ctx, t, 0.05, 0.004, 0, 0.22, out);
  const o1 = musOsc(ctx, 'triangle', hz, 0), o2 = musOsc(ctx, 'sawtooth', hz, 4);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2600;
  o1.connect(g); o2.connect(lp); lp.connect(g);
  o1.start(t); o2.start(t); o1.stop(t + 0.3); o2.stop(t + 0.3);
}
// Brass swell on each chord change: root and fifth an octave up, filter opening.
function musHorn(ctx, t, chord, dur, out) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 1.5;
  lp.frequency.setValueAtTime(300, t);
  lp.frequency.exponentialRampToValueAtTime(1900, t + 0.5);
  lp.frequency.exponentialRampToValueAtTime(700, t + dur);
  const g = musEnv(ctx, t, 0.09, 0.35, Math.max(0.1, dur - 0.6), 0.5, out);
  lp.connect(g);
  [chord.root + 24, chord.root + 31].forEach(function (n) {
    [-5, 5].forEach(function (cents) {
      const o = musOsc(ctx, 'sawtooth', CORE.midiToHz(n), cents);
      o.connect(lp); o.start(t); o.stop(t + dur + 0.6);
    });
  });
}
function musDrum(ctx, t, kind, vel, out) {
  if (kind === 'kick' || kind === 'boom' || kind === 'tom') {
    const f0 = kind === 'kick' ? 150 : kind === 'boom' ? 95 : 190;
    const f1 = kind === 'kick' ? 42 : kind === 'boom' ? 48 : 105;
    const dur = kind === 'kick' ? 0.32 : kind === 'boom' ? 0.9 : 0.35;
    const o = musOsc(ctx, 'sine', f0, 0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.4);
    const g = musEnv(ctx, t, 0.5 * vel, 0.003, 0, dur, out);
    o.connect(g); o.start(t); o.stop(t + dur + 0.05);
    if (kind !== 'kick') musNoise(ctx, t, dur * 0.35, 'lowpass', 260, 0.7, 0.18 * vel, out);
    else musNoise(ctx, t, 0.02, 'highpass', 2500, 0.7, 0.05 * vel, out);   // beater click
  } else if (kind === 'snare') {
    musNoise(ctx, t, 0.17, 'bandpass', 1900, 0.8, 0.32 * vel, out);
    const o = musOsc(ctx, 'triangle', 190, 0);
    const g = musEnv(ctx, t, 0.16 * vel, 0.002, 0, 0.08, out);
    o.connect(g); o.start(t); o.stop(t + 0.12);
  } else if (kind === 'hat') {
    musNoise(ctx, t, 0.035, 'highpass', 7500, 0.7, 0.12 * vel, out);
  }
}

function scheduleMusicStep(ctx, n, t, gains) {
  const L = MUSIC.layers;
  const i = MUSIC.intensity;
  const bar = Math.floor(n / CORE.MUSIC_STEPS_PER_BAR);
  const chord = CORE.musicChordAt(bar);
  if (CORE.musicChordChanges(n)) {
    const dur = CORE.musicStepSeconds() * CORE.MUSIC_STEPS_PER_BAR * CORE.MUSIC_BARS_PER_CHORD;
    musPad(ctx, t, chord, dur, L.pad);
    if (gains.horn > 0.02) musHorn(ctx, t, chord, dur * 0.5, L.horn);
  }
  if (gains.bass > 0.02) {
    const b = CORE.musicBassNote(n, i);
    if (b >= 0) musBass(ctx, t, b, L.bass);
  }
  if (gains.arp > 0.02) musArp(ctx, t, CORE.musicArpNote(n), L.arp);
  const h = CORE.musicDrumHits(n, i);
  if (h.boom) musDrum(ctx, t, 'boom', h.boom, L.drums);
  if (h.kick) musDrum(ctx, t, 'kick', h.kick, L.drums);
  if (h.snare) musDrum(ctx, t, 'snare', h.snare, L.drums);
  if (h.tom) musDrum(ctx, t, 'tom', h.tom, L.drums);
  if (h.hat) musDrum(ctx, t, 'hat', h.hat, L.drums);
}

function startMusic() {
  if (!buildMusicGraph()) return;
  if (!MUSIC.running) {
    // start at the top of a phrase, just ahead of now
    MUSIC.step = 0;
    MUSIC.nextT = MUSIC.ctx.currentTime + 0.08;
  }
  MUSIC.running = true;
}
function stopMusic() {
  MUSIC.running = false;
  if (MUSIC.bus) {
    const t = MUSIC.ctx.currentTime;
    MUSIC.bus.gain.cancelScheduledValues(t);
    MUSIC.bus.gain.setTargetAtTime(0, t, 0.05);   // fast, but not a click
  }
}

// Called every frame while playing.
function updateMusic(dt, state) {
  if (!MUSIC.built || !MUSIC.running) return;
  const ctx = MUSIC.ctx;
  const now = ctx.currentTime;
  const vol = getSetting('muted') ? 0 : getSetting('musicVolume');
  const target = CORE.combatIntensity(state);
  MUSIC.intensity = CORE.stepMusicIntensity(MUSIC.intensity, target, dt);
  const i = MUSIC.intensity;
  const gains = CORE.musicLayerGains(i);

  MUSIC.bus.gain.setTargetAtTime(CORE.musicBusGain(vol, i), now, 0.15);
  for (const k in MUSIC.layers) MUSIC.layers[k].gain.setTargetAtTime(gains[k], now, 0.35);

  // After a pause or a hidden tab the clock has run on without us: rejoin on the
  // next step instead of firing the whole backlog at once.
  if (MUSIC.nextT < now - 0.05) MUSIC.nextT = now + 0.05;
  if (vol <= 0) {            // muted: keep time, schedule nothing
    const st = CORE.musicStepSeconds();
    while (MUSIC.nextT < now + MUSIC_LOOKAHEAD) { MUSIC.nextT += st; MUSIC.step++; }
    return;
  }
  const st = CORE.musicStepSeconds();
  while (MUSIC.nextT < now + MUSIC_LOOKAHEAD) {
    scheduleMusicStep(ctx, MUSIC.step, MUSIC.nextT, gains);
    MUSIC.nextT += st;
    MUSIC.step++;
  }
}
