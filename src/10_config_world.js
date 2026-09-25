// ============ CONFIG, RENDERER & WORLD BUILD ============
'use strict';
// IS_TOUCH, SETTINGS and QUALITY are declared in 07_settings.js
const CFG = {
  player: { height: 1.7, crouchHeight: 1.05, radius: 0.35, speed: 5.4, sprintMul: 1.65, crouchMul: 0.55, accel: 16, decel: 38, jumpVel: 5.6, gravity: 16, health: 100, armor: 50, regenDelay: 3.5, regenRate: 12, maxStamina: 3.2 },
  world: { size: 90, fogColor: 0x5d5a6a, skyColor: 0x5a6a90 },
  wave: { baseCount: 5, growth: 2.5, maxActive: 14, spawnInterval: [1.2, 3.0], startDelay: 3.5, victoryWave: 15 },
  weapons: [
    { name: 'M4 Carbine', type: 'AR', dmg: 26, rpm: 750, mag: 30, reserveMax: 150, reload: 2.1, spread: 0.014, adsSpread: 0.004, recoilV: 0.014, recoilH: 0.006, range: 120, auto: true },
    { name: 'MK18 Mod1', type: 'SMG', dmg: 18, rpm: 900, mag: 32, reserveMax: 160, reload: 1.9, spread: 0.020, adsSpread: 0.008, recoilV: 0.009, recoilH: 0.005, range: 80, auto: true },
    { name: 'SCAR-H', type: 'BR', dmg: 42, rpm: 620, mag: 20, reserveMax: 100, reload: 2.4, spread: 0.011, adsSpread: 0.003, recoilV: 0.020, recoilH: 0.008, range: 140, auto: true },
    { name: 'SV-98 Marksman', type: 'SR', dmg: 120, rpm: 45, mag: 5, reserveMax: 35, reload: 3.4, spread: 0.055, adsSpread: 0.0006, recoilV: 0.055, recoilH: 0.012, range: 260, auto: false }
  ],
  ai: { speed: 3.2, chaseSpeed: 4.9, rangedSpeed: 2.8, attackRange: 2.1, meleeDamage: 18, meleeCd: 1.1, rangedRange: 44, rangedDamage: 8, rangedROF: 1.35, rangedAccuracy: 0.5, maxHealth: 100, headshotMul: 1.8, giveUpDist: 70, accPerWave: 0.035, accMax: 0.75 },
  grenade: { dmg: 120, radius: 7, fuse: 2.2, count: 2, speed: 9.5, bounce: 0.45, countPerWaves: 1 },
  score: { kill: 100, headshot: 50, waveClear: 250, multikill: 60 },
  assist: { angle: 0.14, strength: 2.2, bulletAngle: 0.03, swayAmp: 0.0042, steadyMul: 0.14 }
};
const $id = (i) => document.getElementById(i);

// ---- Renderer / scene ----
const canvas = $id('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !QUALITY.postfx, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxPR));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = QUALITY.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
for (let i = 0; i < TEX_ALL.length; i++) TEX_ALL[i].anisotropy = QUALITY.detail >= 1 ? MAX_ANISO : 2;

const scene = new THREE.Scene();
scene.background = new THREE.Color(CFG.world.skyColor);
scene.fog = new THREE.FogExp2(CFG.world.fogColor, 0.0115);

const camera = new THREE.PerspectiveCamera(SETTINGS.fov, innerWidth / innerHeight, 0.05, 400);
// The first-person viewmodel lives in its own scene, drawn after the world with a
// cleared depth buffer and a tight near plane: the gun can never clip into walls
// or be cut by the world camera's near plane.
const gunScene = new THREE.Scene();
const gunCamera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.01, 10);
gunScene.add(gunCamera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  gunCamera.aspect = innerWidth / innerHeight; gunCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (typeof postfxResize === 'function') postfxResize();
});

// ---- Lighting: low dusk sun, cool sky fill ----
const SUN_DIR = new THREE.Vector3(-0.62, 0.36, -0.7).normalize();   // toward the sun
const sun = new THREE.DirectionalLight(0xffb784, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(QUALITY.shadowSize, QUALITY.shadowSize);
// Shadow frustum follows the player (updateSunShadow) so texels stay dense.
const SUN_SHADOW_EXTENT = 38;
sun.shadow.camera.left = -SUN_SHADOW_EXTENT; sun.shadow.camera.right = SUN_SHADOW_EXTENT;
sun.shadow.camera.top = SUN_SHADOW_EXTENT; sun.shadow.camera.bottom = -SUN_SHADOW_EXTENT;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
sun.position.copy(SUN_DIR).multiplyScalar(100);
scene.add(sun); scene.add(sun.target);
const hemi = new THREE.HemisphereLight(0x9aa6c8, 0x5a4a40, 1.15);
scene.add(hemi);
const _sunSnap = new THREE.Vector3();
function updateSunShadow(focus) {
  // snap the shadow camera to its texel grid so shadows do not shimmer while moving
  const texel = (SUN_SHADOW_EXTENT * 2) / QUALITY.shadowSize;
  _sunSnap.set(Math.round(focus.x / texel) * texel, 0, Math.round(focus.z / texel) * texel);
  sun.target.position.copy(_sunSnap);
  sun.position.copy(_sunSnap).addScaledVector(SUN_DIR, 100);
  sun.target.updateMatrixWorld();
}
function setShadowQuality(size, soft) {
  renderer.shadowMap.type = soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  sun.shadow.mapSize.set(size, size);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  scene.traverse(function (o) { if (o.material && o.material.isMaterial) o.material.needsUpdate = true; });
}

// ---- Sky: gradient dome, sun glow, procedural drifting clouds, faint stars ----
// sky colours are authored in sRGB; the shader works in linear light
const SKY_UNIFORMS = {
  top: { value: new THREE.Color(0x1a2542).convertSRGBToLinear() }, mid: { value: new THREE.Color(0x56628c).convertSRGBToLinear() },
  horizon: { value: new THREE.Color(0xe39463).convertSRGBToLinear() }, low: { value: new THREE.Color(0x3a3442).convertSRGBToLinear() },
  sunDir: { value: SUN_DIR.clone() }, time: { value: 0 }
};
function makeSkyMaterial(withClouds) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    defines: withClouds ? { CLOUDS: 1 } : {},
    uniforms: SKY_UNIFORMS,
    vertexShader: 'varying vec3 vW; void main(){ vW = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: [
      'varying vec3 vW; uniform vec3 top, mid, horizon, low, sunDir; uniform float time;',
      'float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }',
      'float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
      '  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }',
      'float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*vn(p); p*=2.03; a*=0.5; } return s; }',
      'void main(){',
      '  vec3 d = normalize(vW); float h = d.y;',
      '  vec3 c = h > 0.0 ? mix(horizon, mid, smoothstep(0.0, 0.22, h)) : mix(horizon, low, smoothstep(0.0, 0.12, -h));',
      '  c = mix(c, top, smoothstep(0.2, 0.75, h));',
      '  float sd = max(dot(d, sunDir), 0.0);',
      '  c += vec3(1.0,0.62,0.35) * (pow(sd, 6.0) * 0.45 + pow(sd, 64.0) * 0.9);',
      '  c += vec3(1.0,0.92,0.8) * smoothstep(0.9988, 0.9995, sd) * 6.0;',   // sun disc (HDR, blooms)
      '#ifdef CLOUDS',
      '  if (h > 0.0) {',
      '    vec2 uv = d.xz / (h + 0.12) * 1.3 + vec2(time * 0.006, time * 0.002);',
      '    float n = fbm(uv * 1.6);',
      '    float cl = smoothstep(0.52, 0.8, n) * smoothstep(0.0, 0.15, h);',
      '    vec3 cc = mix(vec3(0.22,0.2,0.26), vec3(1.0,0.66,0.45), pow(sd, 3.0) * 0.8 + 0.15 * (1.0 - h));',
      '    c = mix(c, cc, cl * 0.85);',
      '  }',
      '#endif',
      '  if (h > 0.3) { float st = step(0.9985, h21(floor(d.xz / h * 70.0))) * smoothstep(0.4, 0.85, h); c += vec3(st * 0.7); }',
      '  gl_FragColor = vec4(c, 1.0);',
      '  #include <tonemapping_fragment>',
      '  #include <encodings_fragment>',
      '}'
    ].join('\n')
  });
}
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 16), makeSkyMaterial(QUALITY.clouds));
skyDome.userData.sky = true;
skyDome.frustumCulled = false;
skyDome.renderOrder = -10;
scene.add(skyDome);
// horizon haze band: blends the arena walls / skyline into the sky gradient
(function makeHaze() {
  const hazeMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, side: THREE.BackSide,
    uniforms: { col: { value: new THREE.Color(0xb88068) } },
    vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying float vY; uniform vec3 col; void main(){ gl_FragColor = vec4(col, (1.0 - vY) * 0.55 * smoothstep(0.0, 0.25, vY));\n#include <tonemapping_fragment>\n#include <encodings_fragment>\n}'
  });
  hazeMat.uniforms.col.value.convertSRGBToLinear();
  const haze = new THREE.Mesh(new THREE.CylinderGeometry(200, 200, 40, 48, 1, true), hazeMat);
  haze.position.y = 12; haze.userData.sky = true;
  scene.add(haze);
})();
// Image-based lighting from the sky (reflections on metal, glass, puddles).
function buildEnvironment() {
  if (!QUALITY.envMap) { scene.environment = null; gunScene.environment = null; return; }
  try {
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), makeSkyMaterial(false)));
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(envScene, 0.04);
    scene.environment = rt.texture;
    gunScene.environment = rt.texture;
    pmrem.dispose();
  } catch (e) { console.warn('environment map unavailable', e); }
}
buildEnvironment();

// ---- Ground: tiled asphalt with a world-space macro variation to hide tiling ----
const GROUND = 0;
TEX.asphalt.map.repeat.set(55, 55); TEX.asphalt.normalMap.repeat.set(55, 55);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: TEX.asphalt.map, normalMap: TEX.asphalt.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.92, envMapIntensity: 0.4 });
groundMat.onBeforeCompile = function (shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vGroundW;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vGroundW;\nfloat gh(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }\nfloat gn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(gh(i),gh(i+vec2(1,0)),f.x), mix(gh(i+vec2(0,1)),gh(i+vec2(1,1)),f.x), f.y); }')
    .replace('#include <map_fragment>', '#include <map_fragment>\nfloat gv = gn(vGroundW.xz * 0.06) * 0.6 + gn(vGroundW.xz * 0.21) * 0.4;\ndiffuseColor.rgb *= mix(0.72, 1.18, gv);');
};
// ---- Collision data ----
const colliders = [];   // static AABBs {min,max}
const raycastColliders = []; // world geometry meshes for scoped raycasting
const mapBounds = CFG.world.size / 2 - 2;

const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
raycastColliders.push(ground);
function addCollider(x, y, z, w, h, d) {
  colliders.push({ min: new THREE.Vector3(x - w/2, y - h/2, z - d/2), max: new THREE.Vector3(x + w/2, y + h/2, z + d/2) });
}
// Highest collider top at (x, z) that is not above maxY (ground when none).
function floorHeightAt(x, z, maxY) {
  let f = GROUND;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) continue;
    if (c.max.y <= maxY + 0.05 && c.max.y > f) f = c.max.y;
  }
  return f;
}
function addBox(x, y, z, w, h, d, mat, opts) {
  opts = opts || {};
  const geo = new THREE.BoxGeometry(w, h, d);
  if (mat.userData.texSize) boxWorldUV(geo, w, h, d, mat.userData.texSize, (x * 73 + z * 131 + y * 17) | 0);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = opts.noShadow ? false : true;
  m.receiveShadow = true;
  scene.add(m);
  raycastColliders.push(m);
  if (!opts.noCollide) addCollider(x, y, z, w, h, d);
  return m;
}

// ---- Materials ----
// userData.surface drives impact effects, footsteps and bullet penetration;
// userData.texSize is the world size (m) of one texture tile for boxWorldUV.
function surfMat(params, surface, texSize) {
  const m = new THREE.MeshStandardMaterial(params);
  m.userData.surface = surface;
  if (texSize) m.userData.texSize = texSize;
  return m;
}
const MAT = {
  concrete: surfMat({ color: 0xc9c7c4, map: TEX.concrete.map, normalMap: TEX.concrete.normalMap, roughness: 0.9, envMapIntensity: 0.2 }, 'concrete', 4),
  concrete2: surfMat({ color: 0xa4a6ac, map: TEX.concrete.map, normalMap: TEX.concrete.normalMap, roughness: 0.93, envMapIntensity: 0.2 }, 'concrete', 3),
  brick: surfMat({ color: 0xffffff, map: TEX.brick.map, normalMap: TEX.brick.normalMap, roughness: 0.92, envMapIntensity: 0.3 }, 'brick', 2.4),
  metal: surfMat({ color: 0x9aa3ad, map: TEX.metal.map, normalMap: TEX.metal.normalMap, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.9 }, 'metal', 3),
  wood: surfMat({ color: 0xffffff, map: TEX.wood.map, normalMap: TEX.wood.normalMap, roughness: 0.85, envMapIntensity: 0.25 }, 'wood', 1.5),
  dark: surfMat({ color: 0x3a3e46, map: TEX.paint.map, normalMap: TEX.paint.normalMap, roughness: 0.75, envMapIntensity: 0.4 }, 'metal', 2),
  accent: surfMat({ color: 0xc9a227, map: TEX.paint.map, roughness: 0.5, metalness: 0.3 }, 'metal', 2),
  red: surfMat({ color: 0xa33a2c, map: TEX.paint.map, normalMap: TEX.paint.normalMap, roughness: 0.55, metalness: 0.35, envMapIntensity: 0.8 }, 'metal', 3),
  container: surfMat({ color: 0x46627a, map: TEX.metal.map, normalMap: TEX.metal.normalMap, roughness: 0.55, metalness: 0.55, envMapIntensity: 0.8 }, 'metal', 2.5)
};
// Surface lookup for a raycast hit (props and GLBs default by tag / name).
function surfaceOf(obj) {
  if (!obj) return 'concrete';
  if (obj === ground) return 'ground';
  const m = obj.material;
  if (m && m.userData && m.userData.surface) return m.userData.surface;
  if (obj.userData && obj.userData.surface) return obj.userData.surface;
  let p = obj;
  while (p) { if (p.userData && p.userData.surface) return p.userData.surface; p = p.parent; }
  return 'concrete';
}

// ---- Build urban arena ----
function buildArena() {
  const S = CFG.world.size;
  // perimeter walls
  addBox(0, 3, -S/2, S+4, 6, 1, MAT.brick);
  addBox(0, 3, S/2, S+4, 6, 1, MAT.brick);
  addBox(-S/2, 3, 0, 1, 6, S+4, MAT.brick);
  addBox(S/2, 3, 0, 1, 6, S+4, MAT.brick);

  // ---- Central 2-story building with an open, enterable ground floor ----
  // Ground-floor perimeter walls are segmented to leave doors on every side.
  [[-5.5,-7],[5.5,-7],[-5.5,7],[5.5,7]].forEach(function(p) { addBox(p[0], 1.7, p[1], 7, 3.4, 0.8, MAT.concrete); });
  [[-9,-4.5],[-9,4.5],[9,-4.5],[9,4.5]].forEach(function(p) { addBox(p[0], 1.7, p[1], 0.8, 3.4, 5, MAT.concrete); });
  addBox(0, 3.9, 0, 18.6, 0.5, 14.6, MAT.concrete2);           // 2nd-floor slab
  addBox(0, 6.65, 0, 18, 0.5, 14, MAT.concrete2);              // roof
  // 1st floor pillars
  [[-6,-4],[6,-4],[-6,4],[6,4]].forEach(function(p) { addBox(p[0], 1.7, p[1], 1.2, 3.4, 1.2, MAT.concrete2); });
  // 2nd floor parapets
  // Split north/south parapets so each staircase has a landing opening.
  [[-5.4,-7.0],[5.4,-7.0],[-5.4,7.0],[5.4,7.0]].forEach(function(p) { addBox(p[0], 4.55, p[1], 7.2, 0.9, 0.8, MAT.concrete2); });
  addBox(-9.0, 4.55, 0, 0.8, 0.9, 14, MAT.concrete2);
  addBox(9.0, 4.55, 0, 0.8, 0.9, 14, MAT.concrete2);
  // Walkable external stairs: 0.4m rises stay below the controller's 0.55m step limit.
  for (let i = 0; i < 10; i++) {
    const top = (i + 1) * 0.4;
    addBox(0, top / 2, 13.6 - i * 0.8, 3.2, top, 0.82, MAT.concrete2);
    addBox(0, top / 2, -13.6 + i * 0.8, 3.2, top, 0.82, MAT.concrete2);
  }

  // ---- Four corner districts ----
  // NE district: warehouse
  addBox(28, 2.5, -28, 16, 5, 12, MAT.metal);
  addBox(28, 5.6, -28, 16.4, 0.4, 12.4, MAT.metal);
  addBox(20.2, 1, -22, 1.4, 2, 8, MAT.brick);      // side wall w/ gap
  addBox(28, 1, -34, 6, 2, 1.4, MAT.brick);
  addBox(34, 1.1, -20.5, 2.2, 2.2, 2.2, MAT.wood);  // crates
  addBox(34, 3.3, -20.5, 2.2, 2.2, 2.2, MAT.wood, {noShadow:false});
  addBox(31.5, 1.1, -18, 2.2, 2.2, 2.2, MAT.wood);
  addBox(36, 1.6, -33, 3.2, 3.2, 3.2, MAT.container);   // container

  // NW district: ruins
  addBox(-28, 1.5, -28, 14, 3, 1, MAT.brick);
  addBox(-33.5, 1.5, -22, 1, 3, 13, MAT.brick);
  addBox(-24, 1.5, -30, 8, 3, 1, MAT.brick);
  addBox(-26, 0.6, -24, 4, 1.2, 4, MAT.concrete2);
  addBox(-20, 0.75, -33, 1.5, 1.5, 1.5, MAT.wood);
  addBox(-18.5, 0.75, -33, 1.5, 1.5, 1.4, MAT.wood);
  addBox(-36, 1, -34, 2, 2, 2, MAT.concrete2);
  addBox(-36, 3, -34, 2, 2, 2, MAT.concrete2);

  // SW district: fuel depot
  addBox(-28, 2, 28, 12, 4, 12, MAT.metal);
  addBox(-28, 4.4, 28, 12.4, 0.5, 12.4, MAT.metal);
  for (let i = 0; i < 3; i++) {
    addBox(-33 + i * 5, 1.5, 22, 3, 3, 3, MAT.red);   // fuel tanks
    addBox(-33 + i * 5, 4.5, 22, 3, 3, 3, MAT.red);
  }
  addBox(-20, 0.7, 34, 1.4, 1.4, 1.4, MAT.wood);
  addBox(-22.5, 0.7, 34, 1.4, 1.4, 1.4, MAT.wood);

  // SE district: construction site
  addBox(26, 3, 30, 10, 6, 10, MAT.concrete);
  addBox(26, 6.4, 30, 10.5, 0.4, 10.5, MAT.concrete2);
  addBox(33, 2, 24, 1.4, 4, 1.4, MAT.wood);          // scaffold legs
  addBox(33, 2, 26.5, 1.4, 4, 1.4, MAT.wood);
  addBox(33, 4.05, 25.25, 1.6, 0.2, 4, MAT.wood);    // scaffold platform
  addBox(26, 1, 38, 4, 2, 1.5, MAT.brick);
  addBox(21, 0.75, 36, 1.5, 1.5, 1.5, MAT.wood);
  addBox(31, 0.75, 37, 1.5, 1.5, 1.5, MAT.wood);
  addBox(31, 2.25, 37, 1.5, 1.5, 1.5, MAT.wood);

  // ---- Central building windows (dark glass, dusk reflection) ----
  (function makeWindows() {
    const winMat = surfMat({ color: 0x31465f, roughness: 0.06, metalness: 0.9, emissive: 0x141c2a, emissiveIntensity: 0.6, envMapIntensity: 1.4 }, 'glass');
    const winGeoE = new THREE.PlaneGeometry(1.6, 1.1);
    const winGeoS = new THREE.PlaneGeometry(1.3, 1.1);
    function winRow(x, z, ry, n, geo, y) {
      for (let i = 0; i < n; i++) {
        const m = new THREE.Mesh(geo, winMat);
        m.position.set(x, y, z);
        if (ry === 0) m.position.x = x + i * 3.1 - (n - 1) * 1.55;
        else m.position.z = z + i * 3.1 - (n - 1) * 1.55;
        m.rotation.y = ry;
        scene.add(m);
        raycastColliders.push(m);
      }
    }
    // east + west faces (two floors)
    winRow(9.05, -3, Math.PI / 2, 4, winGeoE, 1.7);
    winRow(9.05, 3, Math.PI / 2, 4, winGeoE, 1.7);
    winRow(-9.05, -3, -Math.PI / 2, 4, winGeoE, 1.7);
    winRow(-9.05, 3, -Math.PI / 2, 4, winGeoE, 1.7);
    // north + south faces (above ground floor slab edge)
    winRow(-3, -7.05, Math.PI, 4, winGeoS, 1.7);
    winRow(3, -7.05, Math.PI, 4, winGeoS, 1.7);
    winRow(-3, 7.05, 0, 4, winGeoS, 1.7);
    winRow(3, 7.05, 0, 4, winGeoS, 1.7);
  })();

  // ---- Scattered cover throughout ----
  addBox(14, 1, 14, 2.4, 2, 2.4, MAT.concrete2);
  addBox(-14, 1, 14, 2.4, 2, 2.4, MAT.concrete2);
  addBox(14, 1, -14, 2.4, 2, 2.4, MAT.concrete2);
  addBox(-14, 1, -14, 2.4, 2, 2.2, MAT.concrete2);
  addBox(0, 0.75, 30, 3, 1.5, 1.5, MAT.wood);         // south barricade
  addBox(4, 0.75, 30, 3, 1.5, 1.5, MAT.wood);
  addBox(2, 2.25, 30, 3, 1.5, 1.5, MAT.wood);
  addBox(0, 0.75, -30, 3, 1.5, 1.5, MAT.wood);  // north barricade
  addBox(4, 0.75, -30, 3, 1.5, 1.5, MAT.wood);
  addBox(2, 2.25, -30, 3, 1.5, 1.5, MAT.wood);
  addBox(30, 0.75, 8, 1.5, 1.5, 1.5, MAT.wood);
  addBox(-30, 0.75, 8, 1.5, 1.5, 1.5, MAT.wood);
  addBox(30, 0.75, -8, 1.5, 1.5, 1.6, MAT.wood);
  addBox(-30, 0.75, -8, 1.5, 1.5, 1.6, MAT.wood);
  addBox(40, 0.75, 18, 1.5, 1.5, 1.5, MAT.wood);
  addBox(-40, 0.75, 18, 1.5, 1.5, 1.5, MAT.wood);
  addBox(40, 0.75, -18, 1.5, 1.6, 1.5, MAT.wood);
  addBox(-40, 0.75, -18, 1.5, 1.5, 1.5, MAT.wood);
  // barrels (procedural cylinders at build time; desktop swaps in the CC0 Kenney
  // survival-kit GLB later in scatterProps(), once the async GLB parse is done)
  function barrel(x, z) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.5, 12), MAT.red);
    m.position.set(x, 0.75, z); m.castShadow = true; m.receiveShadow = true;
    m.userData.oldBarrel = true;
    scene.add(m);
    raycastColliders.push(m);
    addCollider(x, 0.75, z, 1.1, 1.5, 1.1);
  }
  barrel(11, 22); barrel(12.2, 22.6); barrel(-11, 22); barrel(-12.2, 22.6);
  barrel(11, -22); barrel(12.2, -22.6); barrel(-11, -22); barrel(-12.2, -22.6);
  barrel(22, 12); barrel(-22, 12); barrel(22, -12); barrel(-22, -12);
  barrel(35, 18); barrel(-35, 18); barrel(35, -18); barrel(-35, -18);
}
buildArena();

// ---- CC0 Kenney props (trees / crates / broken columns) scattered as cover ----
// Uses embedded GLBs (embedded in 05_assets.js). Each prop gets an AABB collider
// so it blocks movement, bullets, grenade bounce, enemy LOS, and shows on the minimap.
// Sizes are the GLB natural bounds x scale (tree 0.65x1.92 -> x2.5 etc).
// Lightweight mobile-safe stand-ins ensure cover remains visible even when a phone
// cannot decode/render the embedded GLBs from a local file.
const mobilePropMats = {
  bark: new THREE.MeshStandardMaterial({ color: 0x59452f, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x3f5a3c, roughness: 1 }),
  crate: new THREE.MeshStandardMaterial({ color: 0x806443, roughness: 0.9 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x77756e, roughness: 1 })
};
function makeMobileProp(kind) {
  const g = new THREE.Group();
  if (kind === 'TREE') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 2.2, 6), mobilePropMats.bark);
    trunk.position.y = 1.1;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.8, 7), mobilePropMats.leaf);
    crown.position.y = 3.1; g.add(trunk, crown);
  } else if (kind === 'CRATE') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), mobilePropMats.crate);
    box.position.y = 0.275; g.add(box);
  } else {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.38, 0.75, 7), mobilePropMats.stone);
    col.position.y = 0.375; g.add(col);
  }
  g.traverse(function (o) { if (o.isMesh) { o.userData.prop = true; o.castShadow = false; o.receiveShadow = true; } });
  return g;
}

function scatterProps() {
  const spots = [
    // [asset, x, z, scale, yaw]
    ['TREE', 8, 20, 2.6, 0.5], ['TREE', -8, 18, 2.5, -0.4], ['TREE', 18, -4, 2.4, 0.9],
    ['TREE', -20, 6, 2.6, 0.2], ['TREE', 6, -18, 2.5, -0.7], ['TREE', -6, -22, 2.4, 1.2],
    ['CRATE', 16, 8, 2.0, 0.3], ['CRATE', -16, -8, 2.0, -0.2], ['CRATE', 12, -10, 1.9, 0.5],
    ['COLUMN', 24, 14, 2.2, 0.1], ['COLUMN', -24, -14, 2.2, 0.8], ['COLUMN', 20, -20, 2.1, -0.3], ['COLUMN', -20, 20, 2.2, 1.6]
  ];
  // collider footprints (w,h,d) in world units, roughly matching scaled meshes
  const dims = { TREE: [1.7, 5.0, 1.7], CRATE: [1.1, 1.1, 1.1], COLUMN: [1.3, 1.6, 1.3] };
  let placed = 0;
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const gltf = GLB_PARSED[s[0]];
    const mobileSafe = typeof IS_TOUCH !== 'undefined' && IS_TOUCH;
    // A failed GLB parse must not remove gameplay cover on desktop: use the
    // same lightweight, visible stand-in already proven on mobile.
    const useSimpleProp = mobileSafe || !gltf;
    const m = useSimpleProp ? makeMobileProp(s[0]) : gltf.scene.clone(true);
    m.position.set(s[1], 0, s[2]);
    m.userData.surface = s[0] === 'COLUMN' ? 'concrete' : 'wood';
    m.rotation.y = s[4];
    m.scale.setScalar(s[3]);
    m.traverse(function (o) {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.prop = true; }
    });
    scene.add(m);
    raycastColliders.push(m);
    const d = dims[s[0]];
    addCollider(s[1], d[1] / 2, s[2], d[0], d[1], d[2]);
    placed++;
  }
  // one stacked-crate cluster (two base + one top) for 2m-high cover
  const mobileSafe = typeof IS_TOUCH !== 'undefined' && IS_TOUCH;
  // Keep stacked cover even when the crate asset did not parse.
  const useSimpleCrate = mobileSafe || !GLB_PARSED.CRATE;
  [[15, -24, 0, 0], [16.2, -24.4, 0, 0.2], [15.6, -24.2, 1.0, -0.1]].forEach(function (c) {
      const m = useSimpleCrate ? makeMobileProp('CRATE') : GLB_PARSED.CRATE.scene.clone(true);
      m.userData.surface = 'wood';
      m.position.set(c[0], c[2], c[1]);
      m.rotation.y = c[3];
      m.scale.setScalar(2.0);
      m.traverse(function (o) {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.prop = true; }
      });
      scene.add(m);
      raycastColliders.push(m);
      addCollider(c[0], c[2] + 0.55, c[1], 1.1, 1.1, 1.1);
  });
  placed += 3;
  // ---- Desktop barrel upgrade: swap the 16 procedural red cylinders for the
  // CC0 Kenney survival-kit GLB barrel (natural bounds ~0.24x0.34x0.24 m ->
  // scale 4.4 = ~1.06x1.5x1.06 m, matching the existing 1.1x1.5x1.1 collider).
  // Mobile keeps the lightweight cylinders (GPU/memory budget).
  if (!IS_TOUCH && GLB_PARSED.BARREL) {
    // collect first, THEN remove: mutating scene.children during traverse()
    // shifts the live array and silently skips every other sibling
    const oldBarrels = [];
    scene.traverse(function (o) { if (o.userData && o.userData.oldBarrel) oldBarrels.push(o); });
    for (let i = 0; i < oldBarrels.length; i++) {
      const p = oldBarrels[i].position;
      scene.remove(oldBarrels[i]);
      const oldIdx = raycastColliders.indexOf(oldBarrels[i]);
      if (oldIdx !== -1) raycastColliders.splice(oldIdx, 1);
      const b = GLB_PARSED.BARREL.scene.clone(true);
      b.scale.setScalar(4.4);
      b.position.set(p.x, 0, p.z);
      b.rotation.y = (p.x * 3.7 + p.z * 1.3) % (Math.PI * 2);  // varied, deterministic
      b.castShadow = true; b.receiveShadow = true;
      b.traverse(function (m) { if (m.isMesh) { m.userData.prop = true; m.castShadow = true; m.receiveShadow = true; } });
      scene.add(b);
      raycastColliders.push(b);
    }
    if (oldBarrels.length) console.log('GLB barrels placed:', oldBarrels.length);
  }
  return placed;
}
