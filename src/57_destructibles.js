// ============ DESTRUCTIBLES: EXPLOSIVE BARRELS, FIRES ============
'use strict';
// Red hazard barrels take bullet / blast damage. At 0 HP they ignite, hiss for a
// short fuse (shoot again to cut it short), then explode: blast damage + knockback,
// debris, a scorch mark and a burning pool that damages anyone standing in it.
// Nearby barrels chain-react. Destroyed barrels respawn when a wave is cleared.
const BARREL_R = 0.42, BARREL_H = 1.25, BARREL_HP = 45;
const barrelSideMat = surfMat({ map: TEX.barrel.map, normalMap: TEX.barrel.normalMap, roughness: 0.5, metalness: 0.45, envMapIntensity: 0.8 }, 'metal');
const barrelCapMat = surfMat({ color: 0x6a2018, map: TEX.paint.map, roughness: 0.55, metalness: 0.5 }, 'metal');
const barrelGeo = new THREE.CylinderGeometry(BARREL_R, BARREL_R, BARREL_H, 22, 1);
const barrelRimGeo = new THREE.TorusGeometry(BARREL_R - 0.01, 0.018, 6, 22);
const barrels = [];
const BARREL_SPOTS = [
  [11, 22], [12.2, 22.6], [-11, 22], [-12.2, 22.6], [11, -22], [12.2, -22.6], [-11, -22], [-12.2, -22.6],
  [22, 12], [-22, 12], [22, -12], [-22, -12], [35, 18], [-35, 18], [35, -18], [-35, -18]
];
function makeBarrelMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(barrelGeo, [barrelSideMat, barrelCapMat, barrelCapMat]);
  body.position.y = BARREL_H / 2;
  g.add(body);
  for (const y of [0.02, BARREL_H - 0.02]) {
    const rim = new THREE.Mesh(barrelRimGeo, barrelCapMat);
    rim.rotation.x = Math.PI / 2; rim.position.y = y;
    g.add(rim);
  }
  g.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
function placeBarrel(b) {
  b.mesh = makeBarrelMesh();
  b.mesh.position.set(b.x, 0, b.z);
  b.mesh.rotation.y = (b.x * 3.7 + b.z * 1.3) % (Math.PI * 2);
  b.mesh.traverse(function (o) { if (o.isMesh) { o.userData.barrelRef = b; o.userData.surface = 'metal'; } });
  scene.add(b.mesh);
  raycastColliders.push(b.mesh);
  b.collider = { min: new THREE.Vector3(b.x - BARREL_R, 0, b.z - BARREL_R), max: new THREE.Vector3(b.x + BARREL_R, BARREL_H, b.z + BARREL_R), barrel: true, surface: 'metal' };
  colliders.push(b.collider);
  b.hp = BARREL_HP; b.state = 'ok'; b.fuse = 0; b.hiss = 0;
}
function removeBarrelWorld(b) {
  scene.remove(b.mesh);
  const ri = raycastColliders.indexOf(b.mesh); if (ri >= 0) raycastColliders.splice(ri, 1);
  const ci = colliders.indexOf(b.collider); if (ci >= 0) colliders.splice(ci, 1);
  b.mesh = null; b.collider = null;
}
(function buildBarrels() {
  for (const s of BARREL_SPOTS) {
    const b = { x: s[0], z: s[1] };
    placeBarrel(b);
    barrels.push(b);
  }
})();
const _barrelPos = new THREE.Vector3();
function igniteBarrel(b, fuse) {
  if (b.state === 'gone') return;
  if (b.state === 'ok') {
    b.state = 'burning';
    b.fuse = fuse;
    playSound3D('ignite', b.x, 1, b.z);
  } else b.fuse = Math.min(b.fuse, fuse);
}
function damageBarrel(b, dmg) {
  if (!b || b.state === 'gone') return;
  b.hp -= dmg;
  if (b.state === 'burning') { b.fuse -= dmg * 0.012; return; }   // shooting a lit barrel speeds it up
  if (b.hp <= 0) igniteBarrel(b, 1.1 + Math.random() * 0.6);
}
function damageBarrelsInRadius(pos, R, dmg) {
  for (let i = 0; i < barrels.length; i++) {
    const b = barrels[i];
    if (b.state === 'gone') continue;
    const d = Math.hypot(b.x - pos.x, 0.6 - pos.y, b.z - pos.z);
    if (d < 0.2 || d > R) continue;
    const hit = dmg * (1 - d / R);
    if (hit > 35) igniteBarrel(b, 0.12 + d * 0.05);   // chain reaction ripple
    else damageBarrel(b, hit);
  }
}
const firePools = [];
const shrapnelMat = new THREE.MeshStandardMaterial({ color: 0x7a2418, roughness: 0.6, metalness: 0.5 });
const shrapnelGeo = new THREE.BoxGeometry(0.22, 0.03, 0.16);
const lidGeo = new THREE.CylinderGeometry(BARREL_R, BARREL_R, 0.04, 16);
function explodeBarrel(b) {
  _barrelPos.set(b.x, 0.6, b.z);
  removeBarrelWorld(b);
  b.state = 'gone';
  applyExplosion(_barrelPos, { radius: 6.5, dmg: 170, playerDmg: 75, scale: 1.35, sound: 'barrel_boom' });
  // lid rockets upward, shrapnel scatters
  spawnDebris(new THREE.Mesh(lidGeo, barrelCapMat), _barrelPos, new THREE.Vector3((Math.random() - 0.5) * 3, 13 + Math.random() * 4, (Math.random() - 0.5) * 3), 0.2, 8);
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2, s = 5 + Math.random() * 6;
    spawnDebris(new THREE.Mesh(shrapnelGeo, shrapnelMat), _barrelPos, new THREE.Vector3(Math.cos(a) * s, 3 + Math.random() * 6, Math.sin(a) * s), 0.1, 6 + Math.random() * 2);
  }
  firePools.push({ x: b.x, z: b.z, t: 7, r: 1.7 });
}
function updateBarrels(dt) {
  for (let i = 0; i < barrels.length; i++) {
    const b = barrels[i];
    if (b.state !== 'burning') continue;
    b.fuse -= dt;
    _barrelPos.set(b.x, BARREL_H, b.z);
    fxFire(_barrelPos, 0.8, dt);
    b.hiss -= dt;
    if (b.hiss <= 0) { b.hiss = 0.35; playSound3D('crackle', b.x, 1, b.z); }
    if (b.fuse <= 0) explodeBarrel(b);
  }
  // burning pools: area denial for a few seconds
  for (let i = firePools.length - 1; i >= 0; i--) {
    const f = firePools[i];
    f.t -= dt;
    if (f.t <= 0) { firePools.splice(i, 1); continue; }
    const k = Math.min(1, f.t / 3);
    _barrelPos.set(f.x + (Math.random() - 0.5) * f.r, 0.05, f.z + (Math.random() - 0.5) * f.r);
    fxFire(_barrelPos, 0.9 * k, dt);
    if (Math.hypot(player.pos.x - f.x, player.pos.z - f.z) < f.r && player.pos.y - eyeHeight() < 0.4) {
      f.hurtT = (f.hurtT || 0) - dt;
      if (f.hurtT <= 0) { f.hurtT = 0.35; damagePlayer(5 * k * perkMul('blast'), undefined, true); }
    }
    for (let j = 0; j < enemies.length; j++) {
      const en = enemies[j];
      if (!en.dead && Math.hypot(en.pos.x - f.x, en.pos.z - f.z) < f.r && en.pos.y < 0.4) {
        en.burnT = (en.burnT || 0) - dt;
        if (en.burnT <= 0) { en.burnT = 0.35; damageEnemy(en, 9 * k, en.pos.clone().setY(en.pos.y + 1), false, null, true); }
      }
    }
  }
}
function respawnBarrels() {
  for (let i = 0; i < barrels.length; i++) {
    const b = barrels[i];
    if (b.state !== 'gone') continue;
    if (Math.hypot(player.pos.x - b.x, player.pos.z - b.z) < 3) continue;
    placeBarrel(b);
  }
  if (typeof markNavDirty === 'function') markNavDirty();
}
function resetBarrels() {
  for (let i = 0; i < barrels.length; i++) {
    const b = barrels[i];
    if (b.state === 'gone') placeBarrel(b);
    else { b.hp = BARREL_HP; b.state = 'ok'; b.fuse = 0; }
  }
  firePools.length = 0;
}

// ---- Burning oil drums (permanent light sources) + distant city fires ----
const fireDrums = [];
const drumMat = surfMat({ color: 0x4a3a30, map: TEX.metal.map, normalMap: TEX.metal.normalMap, roughness: 0.8, metalness: 0.5 }, 'metal');
const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff7a2a).multiplyScalar(3), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
(function buildFireDrums() {
  const spots = [[5.5, 28.5], [-25, 1.5], [25.5, -12.5], [-31, -30.5], [38.5, 35]];
  const drumGeo = new THREE.CylinderGeometry(0.34, 0.3, 0.9, 16, 1, true);
  const glowGeo = new THREE.CircleGeometry(0.3, 16);
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const m = new THREE.Mesh(drumGeo, drumMat);
    m.material.side = THREE.DoubleSide;
    m.position.set(s[0], 0.45, s[1]); m.castShadow = true; m.receiveShadow = true;
    scene.add(m); raycastColliders.push(m);
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2; glow.position.set(s[0], 0.82, s[1]);
    glow.userData.vfx = true;
    scene.add(glow);
    addCollider(s[0], 0.45, s[1], 0.68, 0.9, 0.68, 'metal');
    let light = null;
    if (QUALITY.pointLights && i < 2) {
      light = new THREE.PointLight(0xff8a3a, 2.2, 11, 2);
      light.position.set(s[0], 1.5, s[1]);
      light.userData.vfx = true;
      scene.add(light);
    }
    fireDrums.push({ x: s[0], z: s[1], light: light, glow: glow, crackT: Math.random() * 2, phase: Math.random() * 10 });
  }
})();
const CITY_FIRES = [[-75, -95], [110, -40], [60, 105]];
const _fdPos = new THREE.Vector3();
let cityFireT = 0;
function updateFires(dt, t) {
  for (let i = 0; i < fireDrums.length; i++) {
    const f = fireDrums[i];
    const flick = 0.75 + Math.sin(t * 13 + f.phase) * 0.12 + Math.sin(t * 29.7 + f.phase * 2) * 0.08 + Math.random() * 0.08;
    if (f.light) f.light.intensity = 2.2 * flick;
    f.glow.material.opacity = 0.7 + flick * 0.25;
    const d = Math.hypot(player.pos.x - f.x, player.pos.z - f.z);
    if (d < 60) { _fdPos.set(f.x, 0.85, f.z); fxFire(_fdPos, 0.55, dt); }
    f.crackT -= dt;
    if (f.crackT <= 0) { f.crackT = 0.6 + Math.random() * 1.2; if (d < 14) playSound3D('crackle', f.x, 1, f.z, false, 14); }
  }
  // huge slow smoke plumes from burning blocks beyond the walls
  cityFireT -= dt;
  if (cityFireT <= 0) {
    cityFireT = 0.35;
    for (const c of CITY_FIRES) {
      pfxEmit(PFX_SMOKE, c[0] + (Math.random() - 0.5) * 6, 18, c[1] + (Math.random() - 0.5) * 6,
        1.5 + Math.random(), 4 + Math.random() * 2, 0.5, 16, 8, 26, 0x2a2626, 0x3a3434, 0.55, 0.05, -0.05, 0);
      pfxEmit(PFX_ADD, c[0] + (Math.random() - 0.5) * 5, 14, c[1] + (Math.random() - 0.5) * 5,
        0, 3, 0, 1.4, 6, 3, 0xff8a3a, 0x801800, 0.9, 0.2, 0, 0);
    }
  }
}
function updateDestructibles(dt) {
  updateBarrels(dt);
  updateFires(dt, gameT);
  updateDebris(dt);
}
