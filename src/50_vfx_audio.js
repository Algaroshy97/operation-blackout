// ============ VFX & AUDIO ============
'use strict';
// Sparks, dust, blood and smoke are GPU particles (48_particles.js). This module
// owns the mesh-based effects: travelling tracers, decals, shell casings, muzzle light.
const vfx = { tracers: [] };
const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
// HDR colours (>1) so tracers bloom in the post-FX pass.
const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe2a0).multiplyScalar(4), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const tracerMatE = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a30).multiplyScalar(5), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const tracerMatS = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff4e0).multiplyScalar(9), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const casingGeo = new THREE.CylinderGeometry(0.0065, 0.0065, 0.032, 8);
const casingMat = new THREE.MeshStandardMaterial({ color: 0xd9a94a, roughness: 0.3, metalness: 0.9 });
const shellGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.06, 8);
const shellMat = new THREE.MeshStandardMaterial({ color: 0xa8231c, roughness: 0.5, metalness: 0.2 });

// Mesh pools
const tracerPool = [];
const casingPool = [];
function warmupVfx() {
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(tracerGeo, tracerMat);
    m.userData.vfx = true; m.visible = false; m.renderOrder = 30;
    tracerPool.push(m);
  }
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(casingGeo, casingMat);
    m.userData.vfx = true; m.visible = false; m.castShadow = false;
    casingPool.push(m);
  }
}
warmupVfx();

function getTracerMesh(mat) {
  const m = tracerPool.length > 0 ? tracerPool.pop() : new THREE.Mesh(tracerGeo, mat || tracerMat);
  m.material = mat || tracerMat;
  m.userData.vfx = true; m.visible = true; m.renderOrder = 30;
  return m;
}
function getCasingMesh() {
  const m = casingPool.length > 0 ? casingPool.pop() : new THREE.Mesh(casingGeo, casingMat);
  m.userData.vfx = true; m.visible = true;
  return m;
}

// Tracers travel from muzzle to impact (the hit itself is resolved instantly);
// enemy tracers fly slower and glow red so incoming fire reads clearly.
const _trDir = new THREE.Vector3();
function spawnTracer(from, to, mat) {
  const enemy = mat === 0xff8844 || mat === tracerMatE;
  const sniper = mat === 'sniper';
  const m = getTracerMesh(enemy ? tracerMatE : sniper ? tracerMatS : tracerMat);
  const len = from.distanceTo(to);
  if (len < 0.5) { m.visible = false; tracerPool.push(m); return; }
  m.position.copy(from);
  m.lookAt(to);
  scene.add(m);
  vfx.tracers.push({
    m: m, from: from.clone(), dir: _trDir.copy(to).sub(from).normalize().clone(), len: len,
    d: 0, speed: enemy ? 140 : sniper ? 950 : 420, seg: enemy ? 3.5 : sniper ? 14 : 5, w: enemy ? 0.035 : sniper ? 0.03 : 0.022
  });
}
function releaseTracer(t) { scene.remove(t.m); t.m.visible = false; tracerPool.push(t.m); }

// ---- Decals: bullet holes, blood splats, blast scorch (pooled FIFO) ----
// Decal meshes are not in raycastColliders, so AI LOS never sees them; vfx-tagged
// so every scene-wide raycast skips them.
function makeDecalPool(tex, max, color, opacity) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex, color: color, transparent: true, opacity: opacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
  });
  return { max: max, live: [], pool: [], mat: mat, geo: new THREE.PlaneGeometry(1, 1) };
}
const DECAL = makeDecalPool(TEX.bulletHole, 64, 0xffffff, 0.95);
const BLOOD_DECAL = makeDecalPool(TEX.bloodSplat, 24, 0xffffff, 0.9);
const SCORCH_DECAL = makeDecalPool(TEX.scorch, 10, 0xffffff, 0.92);
const _tmpD = new THREE.Vector3();
const _tmpD2 = new THREE.Vector3();
function placeDecal(P, point, worldNormal, size) {
  let d;
  if (P.pool.length) { d = P.pool.pop(); d.m.visible = true; }
  else if (P.live.length >= P.max) { d = P.live.shift(); }
  else {
    const m = new THREE.Mesh(P.geo, P.mat);
    m.userData.vfx = true;
    m.userData.decal = true;
    m.renderOrder = 1;
    scene.add(m);
    d = { m: m };
  }
  P.live.push(d);
  d.m.position.copy(point).addScaledVector(worldNormal, 0.012);
  _tmpD2.copy(d.m.position).add(worldNormal);
  d.m.lookAt(_tmpD2);
  d.m.rotateZ(Math.random() * Math.PI * 2);
  d.m.scale.set(size, size, 1);
  d.t = gameT;
  return d;
}
// normal is the raycast face normal (object space); transformed here.
function spawnDecal(point, normal, obj) {
  _tmpD.copy(normal);
  if (obj && obj.matrixWorld) _tmpD.transformDirection(obj.matrixWorld).normalize();
  placeDecal(DECAL, point, _tmpD, 0.12 + Math.random() * 0.04);
}
function spawnBloodDecal(point, worldNormal, size) { placeDecal(BLOOD_DECAL, point, worldNormal, size); }
const _up = new THREE.Vector3(0, 1, 0);
function spawnScorch(x, z, size) { _tmpD.set(x, 0.015, z); placeDecal(SCORCH_DECAL, _tmpD, _up, size); }
function clearDecals() {
  for (const P of [DECAL, BLOOD_DECAL, SCORCH_DECAL]) {
    for (let i = 0; i < P.live.length; i++) { P.live[i].m.visible = false; P.pool.push(P.live[i]); }
    P.live.length = 0;
  }
}

const _tmpN = new THREE.Vector3();
function spawnImpact(point, normal, obj) {
  _tmpN.set(0, 1, 0);
  if (normal) { _tmpN.copy(normal); if (obj && obj.matrixWorld) _tmpN.transformDirection(obj.matrixWorld).normalize(); }
  const surf = surfaceOf(obj);
  fxImpact(point, _tmpN, surf);
  playSound(surf === 'metal' ? 'impact_metal' : surf === 'wood' ? 'impact_wood' : surf === 'glass' ? 'impact_glass' : 'impact');
}

// Blood: particles plus a splat on the wall behind the target or the ground below.
const _bloodRay = new THREE.Raycaster();
const _bloodDir = new THREE.Vector3();
function spawnBlood(point, isHead, dir) {
  if (dir) _bloodDir.copy(dir); else _bloodDir.copy(point).sub(camera.position).normalize();
  fxBlood(point, _bloodDir, isHead);
  if (Math.random() < (isHead ? 0.9 : 0.5)) {
    _bloodRay.set(point, _bloodDir); _bloodRay.far = 2.6;
    const hits = _bloodRay.intersectObjects(raycastColliders, true);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.object === ground || !h.face) continue;
      _tmpD.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      spawnBloodDecal(h.point, _tmpD, 0.5 + Math.random() * 0.5);
      return;
    }
    _tmpD.set(point.x + _bloodDir.x * 0.6, 0.012, point.z + _bloodDir.z * 0.6);
    spawnBloodDecal(_tmpD, _up, 0.6 + Math.random() * 0.6);
  }
}

// ---- Shell casings: eject on every shot, bounce on whatever floor is below ----
let casingSndT = 0;   // last tink (ms) — throttle so full-auto doesn't spam
const casings = [];
const _casingRight = new THREE.Vector3();
const _casingUp = new THREE.Vector3();
const _casingFwd = new THREE.Vector3();
function spawnCasing(camPos, camQ, shotgun) {
  if (casings.length > 24) {
    const old = casings.shift();
    scene.remove(old.m);
    old.m.visible = false;
    casingPool.push(old.m);
  }
  const m = getCasingMesh();
  m.geometry = shotgun ? shellGeo : casingGeo;
  m.material = shotgun ? shellMat : casingMat;
  m.position.copy(camPos);
  _casingRight.set(1, 0, 0).applyQuaternion(camQ);
  _casingUp.set(0, 1, 0).applyQuaternion(camQ);
  _casingFwd.set(0, 0, -1).applyQuaternion(camQ);
  m.position.addScaledVector(_casingRight, 0.18).addScaledVector(_casingUp, -0.1);
  m.position.addScaledVector(_casingFwd, 0.35);
  const v = new THREE.Vector3().copy(_casingRight).multiplyScalar(2.2 + Math.random() * 1.2);
  v.addScaledVector(_casingFwd, 0.4 + Math.random() * 0.6);
  v.y += 1.6 + Math.random();
  const spin = new THREE.Vector3(Math.random() * 30 - 15, Math.random() * 30 - 15, Math.random() * 30 - 15);
  scene.add(m);
  const floor = floorHeightAt(m.position.x, m.position.z, m.position.y) + 0.008;
  casings.push({ m: m, v: v, spin: spin, life: 3.5, rest: false, floor: floor, shotgun: !!shotgun });
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
      if (c.m.position.y <= c.floor) {
        c.m.position.y = c.floor;
        if (c.v.y < -0.5) {
          c.v.y = -c.v.y * 0.35; c.v.x *= 0.5; c.v.z *= 0.5; c.spin.multiplyScalar(0.4);
          const now = performance.now();
          if (now - casingSndT > 90) { playSound3D(c.shotgun ? 'shell' : 'casing', c.m.position.x, c.m.position.y, c.m.position.z); casingSndT = now; }  // tink (max ~11/s)
          if (Math.abs(c.v.y) < 0.6) c.rest = true;
        }
        else c.rest = true;
        if (c.rest) { c.m.rotation.x = Math.PI / 2; c.m.rotation.z = 0; }   // lie flat
      }
    }
  }
}

// ---- Slide / landing dust ----
function spawnSlideDust(pos) { fxDust({ x: pos.x, z: pos.z }, 6, 1); }

// ---- Muzzle light (point light flash at the gun) ----
// Created up-front (a light appearing mid-game forces every material to recompile).
let muzzleLight = null;
if (QUALITY.pointLights) {
  muzzleLight = new THREE.PointLight(0xffc080, 0, 10, 2);
  muzzleLight.userData.vfx = true;
  scene.add(muzzleLight);
}
function flashMuzzleLight() {
  if (!muzzleLight) return;
  muzzleLight.position.copy(camera.position);
  _casingFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  muzzleLight.position.addScaledVector(_casingFwd, 0.8);
  muzzleLight.intensity = 4;
}
function updateMuzzleLight(dt) {
  if (muzzleLight && muzzleLight.intensity > 0) {
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 40);
  }
}
function updateVfx(dt) {
  for (let i = vfx.tracers.length - 1; i >= 0; i--) {
    const t = vfx.tracers[i];
    t.d += t.speed * dt;
    const head = Math.min(t.d, t.len), tail = Math.max(0, t.d - t.seg);
    if (tail >= t.len) { releaseTracer(t); vfx.tracers.splice(i, 1); continue; }
    const mid = (head + tail) * 0.5;
    t.m.position.copy(t.from).addScaledVector(t.dir, mid);
    t.m.scale.set(t.w, t.w, Math.max(0.01, head - tail));
  }
  updateParticles(dt);
  updateFlashLights(dt);
}

// ---- Audio (WebAudio, all synthesized — no assets) ----
// Bus: sounds -> master gain (volume setting) -> compressor -> speakers,
// with a convolution "outdoor slapback" reverb send for shots and blasts.
let AC = null, masterGain = null, reverbSend = null, noiseBuf = null;
function audioCtx() {
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      const comp = AC.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.18;
      comp.connect(AC.destination);
      masterGain = AC.createGain();
      masterGain.gain.value = SETTINGS.volume;
      masterGain.connect(comp);
      // generated impulse response: decaying stereo noise with early reflections
      const len = Math.floor(AC.sampleRate * 1.6);
      const ir = AC.createBuffer(2, len, AC.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const t = i / AC.sampleRate;
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) * (t < 0.09 && (i % 1500 < 40) ? 1.8 : 0.55);
        }
      }
      const conv = AC.createConvolver();
      conv.buffer = ir;
      reverbSend = AC.createGain();
      reverbSend.gain.value = 0.32;
      reverbSend.connect(conv); conv.connect(masterGain);
      const nlen = AC.sampleRate * 2;
      noiseBuf = AC.createBuffer(1, nlen, AC.sampleRate);
      const nd = noiseBuf.getChannelData(0);
      for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
    } catch (e) { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function setMasterVolume(v) { if (masterGain) masterGain.gain.value = v; }
// Sounds that also feed the reverb bus
const REVERB_SOUNDS = { sniper_echo: 1, shot_AR: 1, shot_SMG: 1, shot_BR: 1, shot_SR: 1, shot_SG: 1, shot_LMG: 1, shot_PST: 1, sniper: 1, eshot: 1, explosion: 1, barrel_boom: 1, thunder: 1 };
function playSound(name, dest) {
  const ctx = audioCtx();
  if (!ctx || !masterGain) return;
  const out = dest || masterGain;
  const t = ctx.currentTime;
  const wet = REVERB_SOUNDS[name] ? reverbSend : null;
  function env(g0, dur, delay) {
    const g = ctx.createGain();
    const t0 = t + (delay || 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.setValueAtTime(g0, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(out);
    if (wet) g.connect(wet);
    return g;
  }
  function osc(type, f0, f1, dur, g0, delay) {
    const o = ctx.createOscillator();
    const t0 = t + (delay || 0);
    o.type = type; o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    o.connect(env(g0, dur, delay));
    o.start(t0); o.stop(t0 + dur + 0.02);
    return o;
  }
  function noise(dur, g0, freq, q, type, freqEnd, delay) {
    const src = ctx.createBufferSource();
    const t0 = t + (delay || 0);
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type || 'bandpass'; f.frequency.setValueAtTime(freq, t0); f.Q.value = q || 1;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    src.connect(f); f.connect(env(g0, dur, delay));
    src.start(t0, Math.random() * 1.2); src.stop(t0 + dur + 0.02);
  }
  // Layered gunshot: transient crack + mid body + low thump + filtered tail.
  function gun(crack, body, bodyF, thump, thumpF, tail, tailDur) {
    noise(0.018, crack, 3800, 0.7, 'highpass');
    noise(0.07 + body * 0.1, body, bodyF, 0.8);
    osc('sine', thumpF, 38, 0.12 + thump * 0.15, thump);
    noise(tailDur, tail, 900, 0.5, 'lowpass', 180);
  }
  switch (name) {
    case 'shot': case 'shot_AR': gun(0.5, 0.45, 1100, 0.45, 150, 0.2, 0.35); break;
    case 'shot_SMG':  gun(0.4, 0.35, 1500, 0.3, 190, 0.14, 0.25); break;
    case 'shot_BR':   gun(0.6, 0.55, 850, 0.6, 130, 0.26, 0.5); break;
    case 'shot_LMG':  gun(0.55, 0.5, 950, 0.55, 140, 0.22, 0.45); break;
    case 'shot_PST':  gun(0.45, 0.4, 1600, 0.3, 210, 0.12, 0.25); break;
    case 'shot_SG':   gun(0.6, 0.7, 600, 0.8, 110, 0.35, 0.7); break;
    case 'shot_SR': case 'sniper': gun(0.85, 0.7, 650, 1.0, 110, 0.5, 1.1); noise(0.03, 0.5, 5200, 0.8, 'highpass'); osc('sine', 55, 28, 0.5, 0.6); break;
    case 'sniper_echo': noise(1.6, 0.16, 500, 0.6, 'lowpass', 90); noise(0.9, 0.08, 1200, 1, 'bandpass', 300, 0.35); break;
    case 'scope_in':  osc('sine', 900, 1300, 0.09, 0.08); break;
    case 'scope_out': osc('sine', 1300, 800, 0.09, 0.08); break;
    case 'slide':     noise(0.25, 0.3, 420, 0.5); noise(0.18, 0.2, 150, 0.4); break;
    case 'casing':    osc('triangle', 3200 + Math.random() * 800, 2600, 0.05, 0.05); osc('triangle', 4100, 3500, 0.04, 0.03, 0.06); break;
    case 'shell':     osc('triangle', 900, 700, 0.06, 0.06); noise(0.03, 0.05, 1200, 2); break;
    case 'eshot':     noise(0.015, 0.25, 3000, 0.7, 'highpass'); noise(0.11, 0.28, 650, 0.8); osc('sine', 140, 45, 0.12, 0.18); noise(0.35, 0.12, 700, 0.5, 'lowpass', 160); break;
    case 'impact':    noise(0.05, 0.2, 2400, 2); noise(0.08, 0.12, 500, 1); break;
    case 'impact_metal': osc('triangle', 1800 + Math.random() * 1200, 900, 0.12, 0.08); noise(0.04, 0.16, 4000, 3); break;
    case 'impact_wood': noise(0.06, 0.22, 700, 1.5); osc('sine', 260, 140, 0.05, 0.1); break;
    case 'impact_glass': noise(0.12, 0.2, 5200, 2); osc('sine', 3400, 2800, 0.1, 0.05); break;
    case 'ricochet':  osc('sine', 2600 + Math.random() * 1400, 700, 0.28, 0.06); break;
    case 'whizz':     noise(0.16, 0.22, 4200, 4, 'bandpass', 900); break;
    case 'explosion': noise(1.4, 0.7, 1200, 0.5, 'lowpass', 90); osc('sine', 75, 22, 1.1, 0.8); noise(0.35, 0.35, 2600, 0.6); noise(0.9, 0.16, 3000, 1, 'bandpass', 1200, 0.25); break;
    case 'barrel_boom': noise(1.6, 0.75, 1400, 0.5, 'lowpass', 80); osc('sine', 62, 20, 1.3, 0.85); noise(0.5, 0.3, 1800, 0.5); break;
    case 'ignite':    noise(0.5, 0.28, 300, 0.6, 'bandpass', 1400); break;
    case 'crackle':   for (let i = 0; i < 4; i++) noise(0.02, 0.1 + Math.random() * 0.1, 1500 + Math.random() * 2500, 3, 'bandpass', null, Math.random() * 0.3); break;
    case 'bounce':    osc('sine', 500, 350, 0.04, 0.1); noise(0.03, 0.08, 2000, 2); break;
    case 'pin':       noise(0.05, 0.15, 2000, 3); osc('triangle', 2400, 2200, 0.08, 0.05, 0.05); break;
    case 'reload_out': noise(0.06, 0.2, 1300, 3); osc('square', 220, 140, 0.05, 0.06); break;
    case 'reload_in': noise(0.05, 0.22, 1600, 3); osc('square', 300, 200, 0.04, 0.07); break;
    case 'charge':    noise(0.05, 0.2, 2200, 3); noise(0.05, 0.22, 1400, 3, 'bandpass', null, 0.12); break;
    case 'bolt':      noise(0.04, 0.2, 1800, 3); osc('square', 400, 260, 0.03, 0.05); noise(0.04, 0.22, 1300, 3, 'bandpass', null, 0.18); break;
    case 'pump':      noise(0.06, 0.26, 900, 2); osc('square', 180, 120, 0.05, 0.06); noise(0.06, 0.3, 1200, 2, 'bandpass', null, 0.14); break;
    case 'shell_in':  noise(0.04, 0.2, 1500, 3); osc('square', 330, 250, 0.03, 0.05); break;
    case 'dry':       osc('square', 900, 700, 0.03, 0.1); break;
    case 'draw':      noise(0.05, 0.15, 1800, 2); noise(0.08, 0.08, 600, 1, 'bandpass', null, 0.05); break;
    case 'knife':     noise(0.16, 0.25, 1800, 1.5, 'bandpass', 5000); break;
    case 'knife_hit': noise(0.08, 0.3, 500, 1); osc('sine', 160, 70, 0.1, 0.2); break;
    case 'melee':     noise(0.12, 0.3, 300, 0.6); osc('sawtooth', 90, 45, 0.11, 0.2); break;
    case 'hit':       osc('sine', 1150, 900, 0.05, 0.16); noise(0.02, 0.08, 3000, 2); break;
    case 'headshot':  osc('sine', 1500, 1150, 0.07, 0.2); osc('sine', 750, 600, 0.07, 0.12); noise(0.03, 0.12, 4500, 2); break;
    case 'kill':      osc('sine', 600, 400, 0.09, 0.14); osc('sine', 900, 700, 0.07, 0.08, 0.05); break;
    case 'armor_break': noise(0.2, 0.3, 3000, 1, 'bandpass', 800); osc('triangle', 1200, 400, 0.2, 0.1); break;
    case 'hurt':      osc('sawtooth', 180, 90, 0.16, 0.22); noise(0.14, 0.16, 400, 0.7); break;
    case 'heartbeat': osc('sine', 60, 40, 0.12, 0.45); osc('sine', 55, 38, 0.12, 0.35, 0.22); break;
    case 'wave':      osc('sine', 220, 0, 0.5, 0.2); osc('sine', 330, 0, 0.5, 0.14); osc('sine', 440, 0, 0.7, 0.1); break;
    case 'death':     osc('sawtooth', 200, 30, 1.2, 0.3); noise(0.8, 0.2, 200, 0.5); break;
    case 'victory':   osc('sine', 523, 0, 0.3, 0.18); osc('sine', 659, 0, 0.3, 0.18); osc('sine', 784, 0, 0.6, 0.2); break;
    case 'perk':      osc('sine', 660, 990, 0.15, 0.12); osc('sine', 990, 1320, 0.2, 0.1, 0.08); osc('sine', 1320, 1760, 0.3, 0.08, 0.16); break;
    case 'step':      noise(0.045, 0.06, 450 + Math.random() * 150, 1); break;
    case 'step_metal': noise(0.04, 0.05, 1200, 2); osc('triangle', 500 + Math.random() * 200, 300, 0.05, 0.03); break;
    case 'step_wood': noise(0.05, 0.07, 300, 1.2); break;
    case 'jump':      noise(0.06, 0.06, 700, 1); break;
    case 'land':      noise(0.08, 0.12, 300, 0.8); break;
    case 'land_heavy': noise(0.14, 0.3, 200, 0.8); osc('sine', 90, 40, 0.15, 0.25); break;
    case 'mantle':    noise(0.18, 0.12, 600, 0.8); noise(0.1, 0.1, 250, 0.8, 'bandpass', null, 0.15); break;
    case 'click':     osc('square', 1000, 800, 0.02, 0.08); break;
    case 'estep':     noise(0.05, 0.06, 320, 1); break;   // enemy footstep: deeper/thud-ier than player step
    case 'grenade_warn': osc('square', 1800, 1800, 0.05, 0.05); osc('square', 1800, 1800, 0.05, 0.05, 0.12); break;
    case 'roar':      osc('sawtooth', 110, 70, 0.6, 0.18); noise(0.6, 0.2, 350, 0.7, 'bandpass', 180); break;
    case 'thunder':   noise(2.5, 0.22, 400, 0.5, 'lowpass', 60); osc('sine', 45, 25, 2.0, 0.2); break;
    case 'pickup_ammo': osc('square', 520, 780, 0.09, 0.12); noise(0.04, 0.10, 2400, 2); break;  // metallic ammo-box rattle
    case 'pickup_med':  osc('sine', 660, 990, 0.12, 0.12); osc('sine', 990, 1320, 0.14, 0.08); break;  // bright medkit chime
  }
}
// Positional audio: distance attenuation, air absorption (low-pass with distance),
// optional occlusion muffling, and stereo pan relative to the player's facing.
function playSound3D(name, x, y, z, occluded, maxDist) {
  const ctx = audioCtx();
  if (!ctx || !masterGain) return;
  maxDist = maxDist || 55;
  const dx = x - player.pos.x, dz = z - player.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > maxDist) return;
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  const pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / (dist || 1) * 1.2));
  const vol = (0.15 + 0.85 * Math.pow(1 - dist / maxDist, 2)) * (occluded ? 0.55 : 1);
  const g = ctx.createGain();
  g.gain.value = vol;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = (occluded ? 900 : 18000) * Math.pow(1 - dist / maxDist, 1.5) + 500;
  g.connect(lp);
  let p = null;
  if (ctx.createStereoPanner) {
    p = ctx.createStereoPanner();
    p.pan.value = pan;
    lp.connect(p); p.connect(masterGain);
  } else lp.connect(masterGain);
  playSound(name, g);
  setTimeout(() => {
    try {
      if (p) p.disconnect();
      lp.disconnect();
      g.disconnect();
    } catch (e) {}
  }, 2600);
}

// ---- Ambient bed: wind + distant rumbles (the city is in blackout) ----
let ambient = null;
function startAmbient() {
  const ctx = audioCtx();
  if (!ctx || !masterGain || ambient) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 0.6;
  const g = ctx.createGain(); g.gain.value = 0.05;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
  const lfoG = ctx.createGain(); lfoG.gain.value = 0.03;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  src.connect(f); f.connect(g); g.connect(masterGain);
  src.start(); lfo.start();
  ambient = { src: src, lfo: lfo, g: g, nextRumble: 8 };
}
function updateAmbient(dt) {
  if (!ambient) return;
  ambient.nextRumble -= dt;
  if (ambient.nextRumble <= 0) {
    ambient.nextRumble = 14 + Math.random() * 22;
    const a = Math.random() * Math.PI * 2;
    playSound3D('thunder', player.pos.x + Math.cos(a) * 50, 0, player.pos.z + Math.sin(a) * 50, true, 60);
  }
}

// footstep timing: steps are driven by the head-bob phase so sound matches camera motion
let stepT = 0;
let lastBobStep = 0;
function updateFootsteps(dt) {
  const hs = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hs > 1.5 && !player.sliding) {
    const stepIdx = Math.floor(player.bobPhase / Math.PI);
    if (stepIdx !== lastBobStep) {
      lastBobStep = stepIdx;
      const surf = player.groundSurface || 'concrete';
      playSound(surf === 'metal' ? 'step_metal' : surf === 'wood' ? 'step_wood' : 'step');
    }
  }
  // landing
  if (player.onGround && !wasGround) {
    const impact = player.lastLandSpeed || 0;
    playSound(impact > 9 ? 'land_heavy' : 'land');
    if (impact > 6) fxDust(player.pos, 5, 0.8);
  }
  wasGround = player.onGround;
}
let wasGround = true;
