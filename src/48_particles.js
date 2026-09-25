// ============ GPU PARTICLES & DYNAMIC LIGHTS ============
'use strict';
// Two THREE.Points layers (additive for fire/sparks/flashes, alpha-blended for
// smoke/dust/blood). Particle state lives in typed arrays; one draw call per layer
// regardless of particle count. Colours are linear (like material colours).
const PFX_MAX = 3000;
const PF_BOUNCE = 1, PF_STICK = 2, PF_RISE = 4;
let pfxPointMax = 256;
function makePfxLayer(additive, tex) {
  const L = {
    cap: 0,
    pos: new Float32Array(PFX_MAX * 3), vel: new Float32Array(PFX_MAX * 3),
    col: new Float32Array(PFX_MAX * 3), c0: new Float32Array(PFX_MAX * 3), c1: new Float32Array(PFX_MAX * 3),
    alpha: new Float32Array(PFX_MAX), a0: new Float32Array(PFX_MAX),
    size: new Float32Array(PFX_MAX), s0: new Float32Array(PFX_MAX), s1: new Float32Array(PFX_MAX),
    rot: new Float32Array(PFX_MAX), rotV: new Float32Array(PFX_MAX),
    life: new Float32Array(PFX_MAX), maxLife: new Float32Array(PFX_MAX),
    drag: new Float32Array(PFX_MAX), grav: new Float32Array(PFX_MAX), flags: new Uint8Array(PFX_MAX),
    cursor: 0, alive: 0, additive: additive
  };
  const geo = new THREE.BufferGeometry();
  const attr = function (arr, n) { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  geo.setAttribute('position', attr(L.pos, 3));
  geo.setAttribute('color', attr(L.col, 3));
  geo.setAttribute('alpha', attr(L.alpha, 1));
  geo.setAttribute('size', attr(L.size, 1));
  geo.setAttribute('rot', attr(L.rot, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);   // never culled
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      map: { value: tex }, scale: { value: 500 }, maxPt: { value: 256 },
      fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }
    },
    vertexShader: [
      'attribute float size; attribute float alpha; attribute float rot; attribute vec3 color;',
      'uniform float scale, maxPt, fogDensity;',
      'varying vec4 vC; varying float vRot; varying float vFog;',
      'void main(){',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = alpha > 0.0 ? min(maxPt, size * scale / max(0.05, -mv.z)) : 0.0;',
      '  vC = vec4(color, alpha); vRot = rot;',
      '  float fd = fogDensity * -mv.z; vFog = 1.0 - exp(-fd * fd);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D map; uniform vec3 fogColor;',
      'varying vec4 vC; varying float vRot; varying float vFog;',
      'void main(){',
      '  vec2 uv = gl_PointCoord - 0.5; float c = cos(vRot), s = sin(vRot);',
      '  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;',
      '  vec4 t = texture2D(map, uv);',
      '  gl_FragColor = vec4(vC.rgb * t.rgb, vC.a * t.a);',
      '  #include <tonemapping_fragment>',
      '  #include <encodings_fragment>',
      additive ? '  gl_FragColor.rgb *= 1.0 - vFog;' : '  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, vFog);',
      '}'
    ].join('\n')
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = additive ? 20 : 10;
  pts.userData.vfx = true;
  L.points = pts; L.geo = geo; L.mat = mat;
  scene.add(pts);
  return L;
}
const PFX_ADD = makePfxLayer(true, TEX.softDot);
const PFX_SMOKE = makePfxLayer(false, TEX.smoke);
function setParticleBudget(total) {
  PFX_ADD.cap = Math.min(PFX_MAX, Math.round(total * 0.45));
  PFX_SMOKE.cap = Math.min(PFX_MAX, Math.round(total * 0.55));
  for (const L of [PFX_ADD, PFX_SMOKE]) { L.geo.setDrawRange(0, L.cap); L.cursor = 0; }
}
setParticleBudget(QUALITY.particles);
try {
  const gl = renderer.getContext();
  const r = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  if (r && r[1]) pfxPointMax = Math.min(512, r[1]);
} catch (e) { /* keep default */ }

const _pc = new THREE.Color(), _pc2 = new THREE.Color();
// Positional args (no per-particle object allocation on hot paths).
function pfxEmit(L, x, y, z, vx, vy, vz, life, s0, s1, c0, c1, a0, drag, grav, flags) {
  if (!L.cap) return;
  const i = L.cursor;
  L.cursor = (L.cursor + 1) % L.cap;
  const i3 = i * 3;
  L.pos[i3] = x; L.pos[i3 + 1] = y; L.pos[i3 + 2] = z;
  L.vel[i3] = vx; L.vel[i3 + 1] = vy; L.vel[i3 + 2] = vz;
  _pc.setHex(c0); _pc2.setHex(c1 === undefined || c1 === null ? c0 : c1);
  L.c0[i3] = _pc.r; L.c0[i3 + 1] = _pc.g; L.c0[i3 + 2] = _pc.b;
  L.c1[i3] = _pc2.r; L.c1[i3 + 1] = _pc2.g; L.c1[i3 + 2] = _pc2.b;
  L.life[i] = life; L.maxLife[i] = life;
  L.s0[i] = s0; L.s1[i] = s1; L.a0[i] = a0;
  L.drag[i] = drag || 0; L.grav[i] = grav || 0; L.flags[i] = flags || 0;
  L.rot[i] = Math.random() * 6.283; L.rotV[i] = (Math.random() - 0.5) * (L.additive ? 0 : 1.2);
  L.size[i] = s0; L.alpha[i] = L.additive ? a0 : 0.0001;
}
function updatePfxLayer(L, dt) {
  let alive = 0;
  for (let i = 0; i < L.cap; i++) {
    if (L.life[i] <= 0) { if (L.alpha[i] !== 0) { L.alpha[i] = 0; L.size[i] = 0; } continue; }
    L.life[i] -= dt;
    if (L.life[i] <= 0) { L.alpha[i] = 0; L.size[i] = 0; continue; }
    alive++;
    const i3 = i * 3;
    const f = L.flags[i];
    const damp = Math.exp(-L.drag[i] * dt);
    L.vel[i3] *= damp; L.vel[i3 + 1] *= damp; L.vel[i3 + 2] *= damp;
    L.vel[i3 + 1] -= L.grav[i] * dt;
    L.pos[i3] += L.vel[i3] * dt; L.pos[i3 + 1] += L.vel[i3 + 1] * dt; L.pos[i3 + 2] += L.vel[i3 + 2] * dt;
    if (L.pos[i3 + 1] < 0.03 && (f & (PF_BOUNCE | PF_STICK))) {
      L.pos[i3 + 1] = 0.03;
      if (f & PF_STICK) { L.vel[i3] = L.vel[i3 + 1] = L.vel[i3 + 2] = 0; }
      else { L.vel[i3 + 1] = -L.vel[i3 + 1] * 0.35; L.vel[i3] *= 0.55; L.vel[i3 + 2] *= 0.55; }
    }
    const t = 1 - L.life[i] / L.maxLife[i];
    const te = 1 - (1 - t) * (1 - t);   // ease-out growth
    L.size[i] = L.s0[i] + (L.s1[i] - L.s0[i]) * te;
    L.col[i3] = L.c0[i3] + (L.c1[i3] - L.c0[i3]) * t;
    L.col[i3 + 1] = L.c0[i3 + 1] + (L.c1[i3 + 1] - L.c0[i3 + 1]) * t;
    L.col[i3 + 2] = L.c0[i3 + 2] + (L.c1[i3 + 2] - L.c0[i3 + 2]) * t;
    L.alpha[i] = L.additive ? L.a0[i] * (1 - t) * (1 - t) : L.a0[i] * Math.min(1, t * 10) * (1 - t);
    L.rot[i] += L.rotV[i] * dt;
  }
  L.alive = alive;
  const a = L.geo.attributes;
  a.position.needsUpdate = true; a.color.needsUpdate = true; a.alpha.needsUpdate = true; a.size.needsUpdate = true; a.rot.needsUpdate = true;
}
function updateParticles(dt) {
  const h = renderer.getDrawingBufferSize(_pfxBuf).y;
  const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  for (const L of [PFX_ADD, PFX_SMOKE]) {
    L.mat.uniforms.scale.value = scale;
    L.mat.uniforms.maxPt.value = pfxPointMax;
    L.mat.uniforms.fogDensity.value = scene.fog ? scene.fog.density : 0;
    if (scene.fog) L.mat.uniforms.fogColor.value.copy(scene.fog.color);
    updatePfxLayer(L, dt);
  }
}
const _pfxBuf = new THREE.Vector2();
function clearParticles() {
  for (const L of [PFX_ADD, PFX_SMOKE]) {
    L.life.fill(0); L.alpha.fill(0); L.size.fill(0); L.cursor = 0; L.alive = 0;
    const a = L.geo.attributes; a.alpha.needsUpdate = true; a.size.needsUpdate = true;
  }
}

// ---- Pooled dynamic point lights (explosions, muzzle, impacts) ----
// Light count must stay constant or every material recompiles; lights are
// created once and parked at intensity 0.
const FLASH_LIGHTS = [];
(function () {
  if (!QUALITY.pointLights) return;
  for (let i = 0; i < 2; i++) {
    const l = new THREE.PointLight(0xffa050, 0, 14, 2);
    l.userData.vfx = true; l.userData.life = 0; l.userData.max = 1; l.userData.peak = 0;
    scene.add(l);
    FLASH_LIGHTS.push(l);
  }
})();
function flashLight(pos, color, intensity, distance, life) {
  if (!FLASH_LIGHTS.length) return;
  let best = FLASH_LIGHTS[0];
  for (let i = 1; i < FLASH_LIGHTS.length; i++) if (FLASH_LIGHTS[i].userData.life < best.userData.life) best = FLASH_LIGHTS[i];
  best.position.copy(pos);
  best.color.setHex(color);
  best.distance = distance;
  best.userData.life = life; best.userData.max = life; best.userData.peak = intensity;
  best.intensity = intensity;
}
function updateFlashLights(dt) {
  for (let i = 0; i < FLASH_LIGHTS.length; i++) {
    const l = FLASH_LIGHTS[i], u = l.userData;
    if (u.life <= 0) { l.intensity = 0; continue; }
    u.life -= dt;
    const t = Math.max(0, u.life / u.max);
    l.intensity = u.peak * t * t;
  }
}

// ---- Effect library ----
function rnd(a, b) { return a + Math.random() * (b - a); }
function fxMuzzle(p, d, big) {
  const n = big ? 5 : 2;
  for (let i = 0; i < n; i++) {
    const s = rnd(0.4, 1.2);
    pfxEmit(PFX_SMOKE, p.x, p.y, p.z, d.x * s + rnd(-0.2, 0.2), d.y * s + rnd(0.1, 0.4), d.z * s + rnd(-0.2, 0.2),
      rnd(0.5, 1.0), 0.08, big ? 0.9 : 0.5, 0x9a948c, 0x6a6660, 0.22, 2.2, -0.5, 0);
  }
  for (let i = 0; i < (big ? 6 : 3); i++) {
    const s = rnd(6, 14);
    pfxEmit(PFX_ADD, p.x, p.y, p.z, d.x * s + rnd(-1, 1), d.y * s + rnd(-1, 1), d.z * s + rnd(-1, 1),
      rnd(0.04, 0.1), 0.03, 0.01, 0xffd890, 0xff7020, 2.5, 4, 0, 0);
  }
}
const SURFACE_FX = {
  concrete: { dust: 0x8f8a84, dust2: 0x5e5a56, sparks: 1, chips: 0xb0aca4 },
  brick:    { dust: 0x9a6a52, dust2: 0x5a3e32, sparks: 0, chips: 0x8a4a34 },
  metal:    { dust: 0x6a6a70, dust2: 0x404048, sparks: 8, chips: 0 },
  wood:     { dust: 0x8a6a48, dust2: 0x5a4430, sparks: 0, chips: 0x9a7448 },
  glass:    { dust: 0xa8b8c8, dust2: 0x6a7888, sparks: 0, chips: 0xc0d8f0 },
  ground:   { dust: 0x6a625a, dust2: 0x403a36, sparks: 1, chips: 0x3a3632 }
};
function fxImpact(p, n, surface) {
  const S = SURFACE_FX[surface] || SURFACE_FX.concrete;
  const nx = n ? n.x : 0, ny = n ? n.y : 1, nz = n ? n.z : 0;
  // dust puff along the normal
  for (let i = 0; i < 3; i++) {
    const s = rnd(0.6, 1.8);
    pfxEmit(PFX_SMOKE, p.x + nx * 0.05, p.y + ny * 0.05, p.z + nz * 0.05,
      nx * s + rnd(-0.4, 0.4), ny * s + rnd(0, 0.5), nz * s + rnd(-0.4, 0.4),
      rnd(0.6, 1.3), 0.1, rnd(0.5, 0.9), S.dust, S.dust2, 0.55, 3, -0.2, 0);
  }
  // chips / splinters (small, heavy, bouncing)
  if (S.chips) for (let i = 0; i < 5; i++) {
    const s = rnd(2, 4.5);
    pfxEmit(PFX_SMOKE, p.x, p.y, p.z, nx * s + rnd(-1.5, 1.5), ny * s + rnd(0.5, 2.5), nz * s + rnd(-1.5, 1.5),
      rnd(0.5, 0.9), 0.035, 0.03, S.chips, S.chips, 1.0, 0.5, 11, PF_BOUNCE);
  }
  // sparks: bright, fast, gravity-bound, bounce on the ground
  for (let i = 0; i < S.sparks; i++) {
    const s = rnd(3, 8);
    pfxEmit(PFX_ADD, p.x, p.y, p.z, nx * s + rnd(-3, 3), ny * s + rnd(0, 3), nz * s + rnd(-3, 3),
      rnd(0.15, 0.4), 0.035, 0.015, 0xfff0b0, 0xff6010, 3, 1.5, 12, PF_BOUNCE);
  }
  if (S.sparks > 2 && QUALITY.pointLights) flashLight(p, 0xffb060, 1.2, 4, 0.06);
}
function fxBlood(p, dir, isHead) {
  const n = isHead ? 10 : 6;
  for (let i = 0; i < n; i++) {
    const s = rnd(1, 3.5);
    pfxEmit(PFX_SMOKE, p.x, p.y, p.z, dir.x * s + rnd(-1, 1), dir.y * s + rnd(-0.2, 1.4), dir.z * s + rnd(-1, 1),
      rnd(0.4, 0.8), 0.06, 0.04, 0x5a0404, 0x2a0202, 1.0, 1, 12, PF_STICK);
  }
  for (let i = 0; i < (isHead ? 4 : 2); i++) {
    pfxEmit(PFX_SMOKE, p.x, p.y, p.z, dir.x * 0.8 + rnd(-0.3, 0.3), rnd(0, 0.4), dir.z * 0.8 + rnd(-0.3, 0.3),
      rnd(0.3, 0.6), 0.12, isHead ? 0.8 : 0.5, 0x6a0808, 0x3a0404, 0.5, 4, 0.5, 0);
  }
}
function fxDust(p, n, spread, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, s = rnd(0.4, 1.4) * (spread || 1);
    pfxEmit(PFX_SMOKE, p.x + Math.cos(a) * 0.3, 0.12, p.z + Math.sin(a) * 0.3, Math.cos(a) * s, rnd(0.2, 0.7), Math.sin(a) * s,
      rnd(0.6, 1.2), 0.25, rnd(0.8, 1.4), color || 0x8a8076, 0x5a544e, 0.4, 2.5, -0.1, 0);
  }
}
function fxExplosion(p, scale) {
  scale = scale || 1;
  // fireball core
  for (let i = 0; i < 18 * scale; i++) {
    const a = Math.random() * 6.283, b = Math.random() * 3.1416, s = rnd(2, 7) * scale;
    pfxEmit(PFX_ADD, p.x, p.y + 0.3, p.z, Math.cos(a) * Math.sin(b) * s, Math.abs(Math.cos(b)) * s * 0.9 + 1, Math.sin(a) * Math.sin(b) * s,
      rnd(0.25, 0.55), rnd(0.8, 1.4) * scale, rnd(2.2, 3.4) * scale, 0xfff0c0, 0xff3808, 4.0, 5, -2, 0);
  }
  // sparks / embers
  for (let i = 0; i < 40 * scale; i++) {
    const a = Math.random() * 6.283, s = rnd(5, 16);
    pfxEmit(PFX_ADD, p.x, p.y + 0.3, p.z, Math.cos(a) * s, rnd(3, 12), Math.sin(a) * s,
      rnd(0.6, 1.6), 0.07, 0.03, 0xffe0a0, 0xff4010, 3, 1.2, 14, PF_BOUNCE);
  }
  // rolling black smoke column
  for (let i = 0; i < 22 * scale; i++) {
    const a = Math.random() * 6.283, r = rnd(0, 1.5) * scale;
    pfxEmit(PFX_SMOKE, p.x + Math.cos(a) * r, p.y + rnd(0.3, 1.6), p.z + Math.sin(a) * r,
      Math.cos(a) * rnd(0.5, 2.5), rnd(1.2, 3.5), Math.sin(a) * rnd(0.5, 2.5),
      rnd(2.5, 4.5), rnd(1.0, 1.8) * scale, rnd(4, 6.5) * scale, 0x3a3230, 0x1c1a1a, 0.75, 0.9, -0.35, 0);
  }
  // ground dust ring
  for (let i = 0; i < 16 * scale; i++) {
    const a = i / (16 * scale) * 6.283, s = rnd(6, 10);
    pfxEmit(PFX_SMOKE, p.x, 0.25, p.z, Math.cos(a) * s, rnd(0.2, 0.8), Math.sin(a) * s,
      rnd(1.2, 2.0), 0.5, rnd(2, 3), 0x7a6e62, 0x4a443e, 0.5, 2.2, 0, 0);
  }
  // debris chunks
  for (let i = 0; i < 14 * scale; i++) {
    const a = Math.random() * 6.283, s = rnd(4, 10);
    pfxEmit(PFX_SMOKE, p.x, p.y + 0.3, p.z, Math.cos(a) * s, rnd(4, 11), Math.sin(a) * s,
      rnd(1.2, 2.2), 0.09, 0.07, 0x2a2624, 0x1a1816, 1.0, 0.2, 15, PF_BOUNCE);
  }
  flashLight(p, 0xff9040, 14 * scale, 22 * scale, 0.45);
}
// Sniper vapour trail: a thin line of slow-fading haze along the bullet path.
function sniperTrail(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  const n = Math.min(45, Math.floor(len / 1.4));
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    pfxEmit(PFX_SMOKE, from.x + dx * t, from.y + dy * t, from.z + dz * t, rnd(-0.08, 0.08), rnd(0.05, 0.2), rnd(-0.08, 0.08),
      rnd(1.2, 2.2), 0.05, 0.35 + t * 0.2, 0xc8ccd0, 0x8a8e94, 0.16, 1.2, -0.05, 0);
  }
}
// Continuous fire (called per frame by burning props / barrels)
function fxFire(p, strength, dt) {
  const rate = 40 * strength * dt;
  let n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
  while (n-- > 0) {
    pfxEmit(PFX_ADD, p.x + rnd(-0.22, 0.22) * strength, p.y, p.z + rnd(-0.22, 0.22) * strength,
      rnd(-0.3, 0.3), rnd(1.4, 2.6) * (0.6 + strength * 0.4), rnd(-0.3, 0.3),
      rnd(0.35, 0.7), rnd(0.35, 0.6) * strength, 0.06, 0xffc070, 0xc01804, 2.4, 0.8, -1.2, 0);
    if (Math.random() < 0.35) pfxEmit(PFX_SMOKE, p.x + rnd(-0.2, 0.2), p.y + 0.8 * strength, p.z + rnd(-0.2, 0.2),
      rnd(-0.2, 0.2), rnd(1.0, 1.8), rnd(-0.2, 0.2), rnd(1.8, 3.2), 0.4 * strength, rnd(1.6, 2.6) * strength, 0x2e2a28, 0x1a1818, 0.45, 0.4, -0.4, 0);
    if (Math.random() < 0.08) pfxEmit(PFX_ADD, p.x, p.y + 0.3, p.z, rnd(-0.8, 0.8), rnd(2, 4), rnd(-0.8, 0.8),
      rnd(0.8, 1.5), 0.04, 0.02, 0xffd080, 0xff5010, 3, 0.4, 1.5, 0);
  }
}
