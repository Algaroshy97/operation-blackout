// ============ CONFIG, RENDERER & WORLD BUILD ============
'use strict';
const CFG = {
  player: { height: 1.7, crouchHeight: 1.05, radius: 0.35, speed: 5.4, sprintMul: 1.65, crouchMul: 0.55, accel: 16, jumpVel: 5.6, gravity: 16, health: 100, armor: 50, regenDelay: 3.5, regenRate: 12, maxStamina: 3.2 },
  world: { size: 90, fogColor: 0x1a1f2b, skyColor: 0x8aa4c8 },
  wave: { baseCount: 5, growth: 2.5, maxActive: 14, spawnInterval: [1.2, 3.0], startDelay: 3.5, victoryWave: 15 },
  weapons: [
    { name: 'M4 Carbine', type: 'AR', dmg: 26, rpm: 750, mag: 30, reserveMax: 150, reload: 2.1, spread: 0.014, adsSpread: 0.004, recoilV: 0.014, recoilH: 0.006, range: 120, auto: true },
    { name: 'MK18 Mod1', type: 'SMG', dmg: 18, rpm: 900, mag: 32, reserveMax: 160, reload: 1.9, spread: 0.020, adsSpread: 0.008, recoilV: 0.009, recoilH: 0.005, range: 80, auto: true },
    { name: 'SCAR-H', type: 'BR', dmg: 42, rpm: 620, mag: 20, reserveMax: 100, reload: 2.4, spread: 0.011, adsSpread: 0.003, recoilV: 0.020, recoilH: 0.008, range: 140, auto: true },
    { name: 'SV-98 Marksman', type: 'SR', dmg: 120, rpm: 45, mag: 5, reserveMax: 35, reload: 3.4, spread: 0.055, adsSpread: 0.0006, recoilV: 0.055, recoilH: 0.012, range: 260, auto: false }
  ],
  ai: { speed: 3.2, chaseSpeed: 4.9, rangedSpeed: 2.8, attackRange: 2.1, meleeDamage: 18, meleeCd: 1.1, rangedRange: 44, rangedDamage: 8, rangedROF: 1.35, rangedAccuracy: 0.5, maxHealth: 100, headshotMul: 2.2, giveUpDist: 70, accPerWave: 0.035, accMax: 0.75 },
  grenade: { dmg: 120, radius: 7, fuse: 2.2, count: 2, speed: 9.5, bounce: 0.45, countPerWaves: 1 },
  score: { kill: 100, headshot: 50, waveClear: 250, multikill: 60 },
  assist: { angle: 0.14, strength: 2.2, bulletAngle: 0.03, swayAmp: 0.0042, steadyMul: 0.14 }
};
const $id = (i) => document.getElementById(i);

// ---- Renderer / scene ----
const canvas = $id('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
scene.background = new THREE.Color(CFG.world.skyColor);
scene.fog = new THREE.Fog(CFG.world.fogColor, 12, 150);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 400);
const gunCamera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 10);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  gunCamera.aspect = innerWidth / innerHeight; gunCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- Lighting ----
const sun = new THREE.DirectionalLight(0xffd9b0, 1.35);
sun.position.set(45, 55, -30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
sun.shadow.bias = -0.0004;
scene.add(sun); scene.add(sun.target);
scene.add(new THREE.HemisphereLight(0x99b3d6, 0x3a3a46, 0.55));
scene.add(new THREE.AmbientLight(0x606070, 0.35));

// ---- Sky gradient dome + sun disc + horizon haze (graphics pass) ----
(function makeSky() {
  const skyGeo = new THREE.SphereGeometry(320, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x4a76b0) }, mid: { value: new THREE.Color(0x8aa4c8) }, low: { value: new THREE.Color(0xd8956a) } },
    vertexShader: 'varying vec3 vW; void main(){ vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vW; uniform vec3 top; uniform vec3 mid; uniform vec3 low; void main(){ float h = normalize(vW).y; vec3 c = h > 0.25 ? top : (h > 0.02 ? mix(mid, top, (h-0.02)/0.23) : mix(low, mid, max(0.0,(h+0.15)/0.17))); gl_FragColor = vec4(c, 1.0); }'
  });
  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.userData.sky = true;
  scene.add(skyDome);
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(14, 24), new THREE.MeshBasicMaterial({ color: 0xfff2c8, fog: false }));
  sunDisc.position.set(150, 170, -100);
  sunDisc.lookAt(0, 0, 0);
  sunDisc.userData.sky = true;
  scene.add(sunDisc);
  const sunGlow = new THREE.Mesh(new THREE.CircleGeometry(34, 24), new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.22, fog: false }));
  sunGlow.position.copy(sunDisc.position).multiplyScalar(0.985);
  sunGlow.lookAt(0, 0, 0);
  sunGlow.userData.sky = true;
  scene.add(sunGlow);
})();
// horizon haze band
(function makeHaze() {
  const haze = new THREE.Mesh(
    new THREE.CylinderGeometry(200, 200, 30, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xc9a37a, transparent: true, opacity: 0.28, side: THREE.BackSide, fog: false })
  );
  haze.position.y = 8; haze.userData.sky = true;
  scene.add(haze);
})();

// ---- Ground ----
const GROUND = 0;
const groundMat = new THREE.MeshStandardMaterial({ color: 0x333a47, roughness: 0.95 });
(function makeGroundTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#39404e'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = 'rgba(' + (30 + Math.random() * 40 | 0) + ',' + (34 + Math.random() * 40 | 0) + ',' + (44 + Math.random() * 40 | 0) + ',0.6)';
    g.fillRect(Math.random() * 256, Math.random() *256, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(30, 30);
  groundMat.map = tex; groundMat.needsUpdate = true;
})();
const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---- Collision data ----
const colliders = [];   // static AABBs {min,max}
const mapBounds = CFG.world.size / 2 - 2;
function addCollider(x, y, z, w, h, d) {
  colliders.push({ min: new THREE.Vector3(x - w/2, y - h/2, z - d/2), max: new THREE.Vector3(x + w/2, y + h/2, z + d/2) });
}
function addBox(x, y, z, w, h, d, mat, opts) {
  opts = opts || {};
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = opts.noShadow ? false : true;
  m.receiveShadow = true;
  scene.add(m);
  if (!opts.noCollide) addCollider(x, y, z, w, h, d);
  return m;
}

// ---- Materials ----
const MAT = {
  concrete: new THREE.MeshStandardMaterial({ color: 0x8f8f96, roughness: 0.9 }),
  concrete2: new THREE.MeshStandardMaterial({ color: 0x6b6f78, roughness: 0.95 }),
  brick: new THREE.MeshStandardMaterial({ color: 0x7a4f3a, roughness: 0.95 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.45, metalness: 0.75 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7d5a36, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2f333c, roughness: 0.8 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.5, metalness: 0.3 }),
  red: new THREE.MeshStandardMaterial({ color: 0x8a2f2f, roughness: 0.8 })
};

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
  addBox(9.0, 4.4, 0, 0.8, 0.6, 14, MAT.concrete2);
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
  addBox(36, 1.6, -33, 3.2, 3.2, 3.2, MAT.metal);   // container

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
    const winMat = new THREE.MeshStandardMaterial({ color: 0x2b3d55, roughness: 0.15, metalness: 0.6, emissive: 0x1a2436, emissiveIntensity: 0.5 });
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
    if (!gltf && !mobileSafe) continue;
    const m = mobileSafe ? makeMobileProp(s[0]) : gltf.scene.clone(true);
    m.position.set(s[1], 0, s[2]);
    m.rotation.y = s[4];
    m.scale.setScalar(s[3]);
    m.traverse(function (o) {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.prop = true; }
    });
    scene.add(m);
    const d = dims[s[0]];
    addCollider(s[1], d[1] / 2, s[2], d[0], d[1], d[2]);
    placed++;
  }
  // one stacked-crate cluster (two base + one top) for 2m-high cover
  const mobileSafe = typeof IS_TOUCH !== 'undefined' && IS_TOUCH;
  if (GLB_PARSED.CRATE || mobileSafe) {
    // entries: [x, z, y, yaw]; y is the base height (0 on ground, 1.0 stacked)
    [[15, -24, 0, 0], [16.2, -24.4, 0, 0.2], [15.6, -24.2, 1.0, -0.1]].forEach(function (c) {
      const m = mobileSafe ? makeMobileProp('CRATE') : GLB_PARSED.CRATE.scene.clone(true);
      m.position.set(c[0], c[2], c[1]);
      m.rotation.y = c[3];
      m.scale.setScalar(2.0);
      m.traverse(function (o) {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.prop = true; }
      });
      scene.add(m);
      addCollider(c[0], c[2] + 0.55, c[1], 1.1, 1.1, 1.1);
    });
    placed += 3;
  }
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
      const b = GLB_PARSED.BARREL.scene.clone(true);
      b.scale.setScalar(4.4);
      b.position.set(p.x, 0, p.z);
      b.rotation.y = (p.x * 3.7 + p.z * 1.3) % (Math.PI * 2);  // varied, deterministic
      b.castShadow = true; b.receiveShadow = true;
      b.traverse(function (m) { if (m.isMesh) { m.userData.prop = true; m.castShadow = true; m.receiveShadow = true; } });
      scene.add(b);
    }
    if (oldBarrels.length) console.log('GLB barrels placed:', oldBarrels.length);
  }
  return placed;
}
