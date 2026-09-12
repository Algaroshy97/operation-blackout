// ============ VFX & AUDIO ============
'use strict';
// ---- Pooled VFX ----
const vfx = { tracers: [], impacts: [], blood: [], muzzleLights: [] };
const tracerGeo = new THREE.BoxGeometry(0.025, 0.025, 1);
const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe9a0 });
const tracerMatE = new THREE.MeshBasicMaterial({ color: 0xff8844 });
const impactGeo = new THREE.SphereGeometry(0.06, 6, 4);
const impactMat = new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85 });
const sparkGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffaa33 });
const bloodGeo = new THREE.SphereGeometry(0.05, 5, 4);
const bloodMat = new THREE.MeshBasicMaterial({ color: 0xa11212 });
const casingGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6);
const casingMat = new THREE.MeshStandardMaterial({ color: 0xd9a94a, roughness: 0.35, metalness: 0.85 });

// Mesh pools
const tracerPool = [];
const impactPool = [];
const sparkPool = [];
const bloodPool = [];
const casingPool = [];

function warmupVfx() {
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(tracerGeo, tracerMat);
    m.userData.vfx = true; m.visible = false;
    tracerPool.push(m);
  }
  for (let i = 0; i < 25; i++) {
    const m = new THREE.Mesh(impactGeo, impactMat);
    m.userData.vfx = true; m.visible = false;
    impactPool.push(m);
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
}
warmupVfx();

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
function getCasingMesh() {
  const m = casingPool.length > 0 ? casingPool.pop() : new THREE.Mesh(casingGeo, casingMat);
  m.userData.vfx = true; m.visible = true;
  return m;
}

function spawnTracer(from, to, mat) {
  const mMat = (mat === 0xff8844 || mat === tracerMatE) ? tracerMatE : (mat || tracerMat);
  const m = getTracerMesh(mMat);
  const len = from.distanceTo(to);
  m.scale.set(1, 1, len);
  m.position.copy(from).add(to).multiplyScalar(0.5);
  m.lookAt(to);
  scene.add(m);
  vfx.tracers.push({ m: m, life: 0.06 });
}

const _tmpN = new THREE.Vector3();
function spawnImpact(point, normal, obj) {
  // flash sphere + spark lines + decal-ish quad
  const m = getImpactMesh();
  m.position.copy(point);
  m.scale.set(1, 1, 1);
  scene.add(m);
  vfx.impacts.push({ m: m, life: 0.25 });
  // sparks
  for (let i = 0; i < 4; i++) {
    const s = getSparkMesh();
    s.position.copy(point);
    const v = new THREE.Vector3((Math.random() - 0.5), Math.random() * 0.9, (Math.random() - 0.5)).normalize().multiplyScalar(2 + Math.random() * 3);
    if (normal) v.add(_tmpN.copy(normal).multiplyScalar(2));
    scene.add(s);
    vfx.blood.push({ m: s, v: v, life: 0.35, grav: 9, isSpark: true });
  }
  playSound('impact');
}

// ---- Bullet-hole decals (v41): persistent marks on world hits ----
// One shared material + a fixed pool of 48 quads, FIFO-recycled when full:
// zero per-shot allocations, zero per-decal clones. Not in raycastColliders,
// so the scoped AI-LOS raycast can never see them; vfx-tagged for scene-wide rays.
const decalGeo = new THREE.CircleGeometry(0.075, 8);   // 15 cm hole — reads at 15–40 m engagement range
const decalMat = new THREE.MeshBasicMaterial({
  color: 0x14161a, transparent: true, opacity: 0.9,
  depthWrite: false,                                  // draw like a decal, not a solid
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4   // beat z-fighting on the wall face
});
const DECAL = { max: 48, live: [], pool: [] };
const _tmpD = new THREE.Vector3();
const _tmpD2 = new THREE.Vector3();
function spawnDecal(point, normal, obj) {
  let d;
  if (DECAL.pool.length) { d = DECAL.pool.pop(); d.m.visible = true; }
  else if (DECAL.live.length >= DECAL.max) { d = DECAL.live.shift(); }
  else {
    const m = new THREE.Mesh(decalGeo, decalMat);
    m.userData.vfx = true;    // bullets / grenade LOS pass through every hole
    m.userData.decal = true;
    m.renderOrder = 1;
    scene.add(m);
    d = { m: m };
  }
  DECAL.live.push(d);
  _tmpD.copy(normal);
  if (obj && obj.matrixWorld) _tmpD.transformDirection(obj.matrixWorld).normalize();
  d.m.position.copy(point).addScaledVector(_tmpD, 0.012);
  _tmpD2.copy(point).add(_tmpD);
  d.m.lookAt(_tmpD2);
  d.t = gameT;
}
function clearDecals() {
  for (let i = 0; i < DECAL.live.length; i++) { DECAL.live[i].m.visible = false; DECAL.pool.push(DECAL.live[i]); }
  DECAL.live.length = 0;
}

function spawnBlood(point, isHead) {
  const n = isHead ? 10 : 6;
  for (let i = 0; i < n; i++) {
    const b = getBloodMesh();
    b.position.copy(point);
    const v = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2).multiplyScalar(1.5 + Math.random() * 2.5);
    scene.add(b);
    vfx.blood.push({ m: b, v: v, life: 0.5, grav: 12, isBlood: true });
  }
}

// ---- Shell casings (eject on every shot) ----
let casingSndT = 0;   // last tink (ms) — throttle so full-auto doesn't spam
const casings = [];
function spawnCasing(camPos, camQ) {
  if (casings.length > 24) {
    const old = casings.shift();
    scene.remove(old.m);
    old.m.visible = false;
    casingPool.push(old.m);
  }
  const m = getCasingMesh();
  m.position.copy(camPos);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camQ);
  m.position.addScaledVector(right, 0.25).addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(camQ), -0.15);
  m.position.addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(camQ), 0.3);
  const v = right.clone().multiplyScalar(1.6 + Math.random()).add(new THREE.Vector3(0, 1.4 + Math.random(), 0));
  const spin = new THREE.Vector3(Math.random() * 14 - 7, Math.random() * 14 - 7, Math.random() * 14 - 7);
  scene.add(m);
  casings.push({ m: m, v: v, spin: spin, life: 2.2, rest: false, ry: 0 });
}
function updateCasings(dt) {
  for (let i = casings.length - 1; i >= 0; i--) {
    const c = casings[i];
    c.life -= dt;
    if (c.life <= 0) {
      scene.remove(c.m);
      c.m.visible = false;
      casingPool.push(c.m);
      casings.splice(i, 1);
      continue;
    }
    if (!c.rest) {
      c.v.y -= 12 * dt;
      c.m.position.addScaledVector(c.v, dt);
      c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt; c.m.rotation.z += c.spin.z * dt;
      if (c.m.position.y <= 0.02) {
        c.m.position.y = 0.02;
        if (c.v.y < -0.5) {
          c.v.y = -c.v.y * 0.35; c.v.x *= 0.5; c.v.z *= 0.5; c.spin.multiplyScalar(0.4);
          const now = performance.now();
          if (now - casingSndT > 90) { playSound('casing'); casingSndT = now; }  // tink (max ~11/s)
          if (Math.abs(c.v.y) < 0.6) c.rest = true;
        }
        else c.rest = true;
      }
    }
  }
}

// ---- Slide dust ----
const dustGeo = new THREE.SphereGeometry(0.14, 6, 5);
const dustMat = new THREE.MeshBasicMaterial({ color: 0xb9a98c, transparent: true, opacity: 0.5 });
function spawnSlideDust(pos) {
  // Share dustMat across puffs (unmutated per particle) to avoid leaking GPU materials on slide
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(dustGeo, dustMat);
    m.position.set(pos.x + (Math.random() - 0.5) * 0.7, 0.15 + Math.random() * 0.15, pos.z + (Math.random() - 0.5) * 0.7);
    m.userData.vfx = true;
    scene.add(m);
    vfx.blood.push({ m: m, v: new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2), life: 0.55, grav: 2.5, dust: true });
  }
}

// ---- Muzzle light (point light flash at gun) ----
let muzzleLight = null;
function flashMuzzleLight() {
  if (!muzzleLight) {
    muzzleLight = new THREE.PointLight(0xffcc88, 0, 9, 2);
    muzzleLight.userData.vfx = true;
    scene.add(muzzleLight);
  }
  muzzleLight.position.copy(camera.position);
  muzzleLight.intensity = 3.2;
}
function updateMuzzleLight(dt) {
  if (muzzleLight && muzzleLight.intensity > 0) {
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 26);
  }
}
function updateVfx(dt) {
  for (let i = vfx.tracers.length - 1; i >= 0; i--) {
    const t = vfx.tracers[i];
    t.life -= dt;
    if (t.life <= 0) {
      scene.remove(t.m);
      t.m.visible = false;
      tracerPool.push(t.m);
      vfx.tracers.splice(i, 1);
    }
  }
  for (let i = vfx.impacts.length - 1; i >= 0; i--) {
    const im = vfx.impacts[i];
    im.life -= dt;
    im.m.scale.setScalar(Math.max(0.001, (1 + (0.25 - Math.max(0, im.life)) * 6) * (im.life / 0.25)));
    if (im.life <= 0) {
      scene.remove(im.m);
      im.m.visible = false;
      impactPool.push(im.m);
      vfx.impacts.splice(i, 1);
    }
  }
  for (let i = vfx.blood.length - 1; i >= 0; i--) {
    const b = vfx.blood[i];
    b.life -= dt;
    b.v.y -= b.grav * dt;
    b.m.position.addScaledVector(b.v, dt);
    if (b.m.position.y < 0.02) { b.m.position.y = 0.02; b.v.set(0, 0, 0); }
    if (b.life <= 0) {
      scene.remove(b.m);
      b.m.visible = false;
      if (b.isSpark) sparkPool.push(b.m);
      else if (b.isBlood) bloodPool.push(b.m);
      vfx.blood.splice(i, 1);
    }
  }
}

// ---- Audio (WebAudio, all synthesized — no assets) ----
let AC = null;
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
function playSound(name, dest) {
  const ctx = audioCtx();
  if (!ctx) return;
  if (!noiseBuf) noiseBuf = noiseBuffer(ctx);
  const t = ctx.currentTime;
  function env(g0, dur) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(dest || ctx.destination);
    return g;
  }
  function osc(type, f0, f1, dur, g0) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.connect(env(g0, dur));
    o.start(t); o.stop(t + dur + 0.02);
    return o;
  }
  function noise(dur, g0, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
    src.connect(f); f.connect(env(g0, dur));
    src.start(t); src.stop(t + dur + 0.02);
  }
  switch (name) {
    case 'shot':      noise(0.09, 0.5, 900, 0.7); osc('square', 190, 70, 0.07, 0.28); break;
    case 'sniper':    noise(0.16, 0.6, 700, 0.6); osc('sine', 150, 40, 0.22, 0.4); noise(0.5, 0.25, 220, 0.4); break;
    case 'scope_in':  osc('sine', 900, 1300, 0.09, 0.08); break;
    case 'scope_out': osc('sine', 1300, 800, 0.09, 0.08); break;
    case 'slide':     noise(0.25, 0.3, 420, 0.5); noise(0.18, 0.2, 150, 0.4); break;
    case 'casing':    osc('square', 2400, 1800, 0.03, 0.04); break;
    case 'eshot':     noise(0.11, 0.24, 500, 0.8); osc('sawtooth', 140, 55, 0.09, 0.14); break;
    case 'impact':    noise(0.05, 0.18, 2400, 2); break;
    case 'explosion': noise(0.6, 0.55, 180, 0.5); osc('sine', 120, 25, 0.5, 0.4); noise(0.3, 0.3, 700, 0.6); break;
    case 'bounce':    osc('sine', 500, 350, 0.04, 0.1); break;
    case 'pin':       noise(0.05, 0.15, 2000, 3); break;
    case 'reload_out': noise(0.06, 0.2, 1300, 3); osc('square', 220, 140, 0.05, 0.06); break;
    case 'reload_in': noise(0.05, 0.22, 1600, 3); osc('square', 300, 200, 0.04, 0.07); break;
    case 'dry':       osc('square', 900, 700, 0.03, 0.1); break;
    case 'draw':      noise(0.05, 0.15, 1800, 2); break;
    case 'melee':     noise(0.12, 0.3, 300, 0.6); osc('sawtooth', 90, 45, 0.11, 0.2); break;
    case 'hit':       osc('sine', 1150, 900, 0.05, 0.16); break;
    case 'headshot':  osc('sine', 1500, 1150, 0.07, 0.2); osc('sine', 750, 600, 0.07, 0.12); break;
    case 'kill':      osc('sine', 600, 400, 0.09, 0.14); break;
    case 'hurt':      osc('sawtooth', 180, 90, 0.16, 0.22); noise(0.14, 0.16, 400, 0.7); break;
    case 'wave':      osc('sine', 220, 0, 0.5, 0.2); osc('sine', 330, 0, 0.5, 0.14); osc('sine', 440, 0, 0.7, 0.1); break;
    case 'death':     osc('sawtooth', 200, 30, 1.2, 0.3); noise(0.8, 0.2, 200, 0.5); break;
    case 'victory':   osc('sine', 523, 0, 0.3, 0.18); osc('sine', 659, 0, 0.3, 0.18); osc('sine', 784, 0, 0.6, 0.2); break;
    case 'step':      noise(0.04, 0.05, 500, 1); break;
    case 'jump':      noise(0.06, 0.06, 700, 1); break;
    case 'land':      noise(0.08, 0.12, 300, 0.8); break;
    case 'click':     osc('square', 1000, 800, 0.02, 0.08); break;
    case 'estep':     noise(0.05, 0.06, 320, 1); break;   // enemy footstep: deeper/thud-ier than player step
    case 'pickup_ammo': osc('square', 520, 780, 0.09, 0.12); noise(0.04, 0.10, 2400, 2); break;  // metallic ammo-box rattle
    case 'pickup_med':  osc('sine', 660, 990, 0.12, 0.12); osc('sine', 990, 1320, 0.14, 0.08); break;  // bright medkit chime
  }
}
// Positional enemy audio: distance attenuation + stereo pan relative to player facing.
// maxDist sounds fade to nothing; pan -1 (full left) .. +1 (full right).
function playSound3D(name, x, y, z) {
  const ctx = audioCtx();
  if (!ctx) return;
  const maxDist = 55;
  const dx = x - player.pos.x, dz = z - player.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > maxDist) return;
  // stereo pan: project enemy offset onto player right vector (cos yaw, -sin yaw)
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  const pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / (dist || 1) * 1.4)); // -1..1, boosted for audibility
  // distance attenuation: full volume close, ~0 at maxDist
  const vol = 0.15 + 0.85 * Math.pow(1 - dist / maxDist, 2);
  const g = ctx.createGain();
  g.gain.value = vol;
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p); p.connect(ctx.destination);
  } else g.connect(ctx.destination);
  playSound(name, g);
}

// footstep timing
let stepT = 0;
function updateFootsteps(dt) {
  const hs = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hs > 1.5) {
    stepT -= dt * (player.sprinting ? 1.6 : 1);
    if (stepT <= 0) { playSound('step'); stepT = 1; }
  }
  // landing
  if (player.onGround && !wasGround && hs >= 0) playSound('land');
  wasGround = player.onGround;
}
let wasGround = true;
