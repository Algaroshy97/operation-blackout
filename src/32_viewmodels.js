// ============ VIEWMODELS: PROCEDURAL GUNS, ARMS, ANIMATION ============
'use strict';
// Every weapon is assembled from primitives at runtime (no model files): receivers,
// rails, optics with emissive reticles, magazines, bolts/pumps/slides that animate,
// plus gloved hands and camo sleeves. Rendered in gunScene by gunCamera (own pass).
function vmMat(params) {
  const m = new THREE.MeshStandardMaterial(params);
  if (!params.map) m.color.convertSRGBToLinear();   // authored in sRGB (see smat in 38_soldier.js)
  m.userData.shared = true;
  return m;
}
const VMAT = {
  polymer: vmMat({ color: 0x1b1c1f, roughness: 0.62, metalness: 0.1, normalMap: TEX.gunNoise.normalMap, normalScale: new THREE.Vector2(0.5, 0.5) }),
  metal: vmMat({ color: 0x26282c, roughness: 0.36, metalness: 0.85, normalMap: TEX.gunNoise.normalMap, normalScale: new THREE.Vector2(0.3, 0.3) }),
  steel: vmMat({ color: 0x5c6066, roughness: 0.26, metalness: 0.95 }),
  tube: vmMat({ color: 0x222428, roughness: 0.4, metalness: 0.8, side: THREE.DoubleSide }),
  fde: vmMat({ color: 0x8c7654, roughness: 0.6, metalness: 0.08, normalMap: TEX.gunNoise.normalMap, normalScale: new THREE.Vector2(0.5, 0.5) }),
  wood: vmMat({ color: 0xb07a4c, map: TEX.wood.map, roughness: 0.5, metalness: 0.05 }),
  olive: vmMat({ color: 0x46503a, roughness: 0.8, metalness: 0.05, normalMap: TEX.camo.normalMap }),
  glove: vmMat({ color: 0x2c2926, roughness: 0.82, metalness: 0.02, normalMap: TEX.gunNoise.normalMap }),
  knuckle: vmMat({ color: 0x1a1918, roughness: 0.6, metalness: 0.1 }),
  sleeve: vmMat({ color: 0xc8c8c0, map: TEX.camo.map, normalMap: TEX.camo.normalMap, roughness: 0.95 }),
  lens: vmMat({ color: 0x0b1420, roughness: 0.04, metalness: 1.0, envMapIntensity: 1.6 }),
  glass: vmMat({ color: 0x6a8aa8, roughness: 0.02, metalness: 0.6, transparent: true, opacity: 0.18, depthWrite: false }),
  brass: vmMat({ color: 0xd8a848, roughness: 0.3, metalness: 0.95 }),
  shell: vmMat({ color: 0xa8231c, roughness: 0.5, metalness: 0.15 }),
  blade: vmMat({ color: 0x9aa0a8, roughness: 0.18, metalness: 1.0 })
};
const VM_DOT = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.08, 0.05).multiplyScalar(14), toneMapped: false });
VM_DOT.userData.shared = true;
const VM_TRITIUM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1, 0.35).multiplyScalar(3) });
VM_TRITIUM.userData.shared = true;
const FLASH_MAT = new THREE.MeshBasicMaterial({ map: TEX.flash, color: new THREE.Color(1, 0.8, 0.5).multiplyScalar(6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
FLASH_MAT.userData.shared = true;

// ---- primitive helpers ----
function B(parent, w, h, d, x, y, z, mat, rx, ry, rz) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
  parent.add(m);
  return m;
}
// cylinder along z (default) — r2 for tapered
function C(parent, r, len, x, y, z, mat, seg, r2, axis, open) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2 === undefined ? r : r2, r, len, seg || 14, 1, !!open), mat);
  if (axis === 'y') { /* native */ } else if (axis === 'x') m.rotation.z = Math.PI / 2; else m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
const _lA = new THREE.Vector3(), _lB = new THREE.Vector3(), _lY = new THREE.Vector3(0, 1, 0);
// cylinder spanning two points (forearms)
function limb(parent, ax, ay, az, bx, by, bz, r0, r1, mat) {
  _lA.set(ax, ay, az); _lB.set(bx, by, bz);
  const len = _lA.distanceTo(_lB);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 12), mat);
  m.position.copy(_lA).add(_lB).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_lY, _lB.sub(_lA).normalize());
  parent.add(m);
  return m;
}
function rail(parent, len, x, y, z) {
  B(parent, 0.024, 0.008, len, x, y, z, VMAT.metal);
  const n = Math.floor(len / 0.012);
  for (let i = 0; i < n; i++) B(parent, 0.028, 0.006, 0.005, x, y + 0.006, z - len / 2 + (i + 0.5) * (len / n), VMAT.metal);
}
// Gloved hand gripping around a vertical-ish grip. side: 1 right, -1 left
function hand(parent, x, y, z, side, rx, rz) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.set(rx || 0, 0, rz || 0);
  B(g, 0.03, 0.075, 0.07, side * 0.028, 0, 0.005, VMAT.glove);              // palm (outer side)
  for (let i = 0; i < 4; i++) {                                              // fingers wrapped around the front
    B(g, 0.05, 0.016, 0.022, -side * 0.004, 0.027 - i * 0.018, -0.038, VMAT.glove);
    B(g, 0.012, 0.014, 0.018, -side * 0.028, 0.027 - i * 0.018, -0.03, VMAT.knuckle);
  }
  B(g, 0.02, 0.02, 0.05, -side * 0.028, 0.035, 0.012, VMAT.glove, 0.4, 0, 0);    // thumb
  B(g, 0.05, 0.035, 0.05, side * 0.012, -0.045, 0.03, VMAT.glove);              // wrist cuff
  parent.add(g);
  return g;
}
function forearm(parent, wx, wy, wz, ex, ey, ez) {
  limb(parent, wx, wy, wz, ex, ey, ez, 0.034, 0.042, VMAT.sleeve);
  limb(parent, wx, wy, wz, wx + (ex - wx) * 0.12, wy + (ey - wy) * 0.12, wz + (ez - wz) * 0.12, 0.036, 0.036, VMAT.glove);
}
function muzzleFlashGroup(parent, z, y) {
  const g = new THREE.Group();
  g.position.set(0, y, z);
  const pg = new THREE.PlaneGeometry(0.16, 0.34);
  for (let i = 0; i < 2; i++) {
    const p = new THREE.Mesh(pg, FLASH_MAT);
    p.rotation.set(Math.PI / 2, 0, i * Math.PI / 2);
    p.rotation.order = 'ZXY';
    p.position.z = -0.14;
    g.add(p);
  }
  const front = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), FLASH_MAT);
  g.add(front);
  g.visible = false;
  parent.add(g);
  return g;
}
// Magazine: curved stack of segments inside a group whose origin is the mag well
function curvedMag(parent, x, y, z, w, segs, segH, depth, curve, mat) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  for (let i = 0; i < segs; i++) {
    const s = B(g, w, segH + 0.004, depth, 0, -segH / 2 - i * segH, -i * curve * 0.5, mat);
    s.rotation.x = -i * curve;
  }
  B(g, w + 0.006, 0.012, depth + 0.006, 0, -segs * segH - 0.004, -(segs - 1) * curve * 0.5, mat);   // base plate
  parent.add(g);
  return g;
}

// ---- Weapon models. Each returns tuning: sightY/Z, muzzle Z, hip pose, arm anchors ----
function buildAR(g, P, fde) {
  const R = fde ? VMAT.fde : VMAT.polymer;
  B(g, 0.05, 0.05, 0.27, 0, 0.032, -0.07, VMAT.metal);                      // upper receiver
  B(g, 0.046, 0.045, 0.2, 0, -0.012, -0.03, R);                             // lower receiver
  B(g, 0.012, 0.03, 0.05, 0.028, 0.03, -0.05, VMAT.metal);                  // ejection port cover
  B(g, 0.02, 0.018, 0.035, 0.03, 0.04, 0.03, VMAT.steel);                   // forward assist
  rail(g, 0.25, 0, 0.061, -0.08);
  // handguard with vent slots
  B(g, 0.056, 0.056, 0.25, 0, 0.028, -0.33, R);
  for (let i = 0; i < 5; i++) for (const sx of [-1, 1]) B(g, 0.004, 0.012, 0.03, sx * 0.029, 0.03, -0.25 - i * 0.045, VMAT.knuckle);
  rail(g, 0.22, 0, 0.061, -0.33);
  C(g, 0.009, 0.16, 0, 0.03, -0.53, VMAT.steel);                           // barrel
  C(g, 0.014, 0.012, 0, 0.03, -0.47, VMAT.metal);                          // gas block
  C(g, 0.013, 0.055, 0, 0.03, -0.625, VMAT.metal, 8);                       // flash hider
  for (let i = 0; i < 4; i++) B(g, 0.004, 0.028, 0.03, 0, 0.03, -0.63, VMAT.knuckle, 0, 0, i * Math.PI / 4);
  // stock: buffer tube + collapsible stock
  C(g, 0.015, 0.14, 0, 0.022, 0.13, VMAT.metal);
  B(g, 0.042, 0.075, 0.13, 0, 0.0, 0.2, R);
  B(g, 0.046, 0.085, 0.02, 0, -0.002, 0.27, VMAT.knuckle);
  // pistol grip + trigger guard
  B(g, 0.032, 0.095, 0.042, 0, -0.075, 0.04, R, 0.28);
  B(g, 0.008, 0.006, 0.07, 0, -0.045, -0.01, VMAT.metal);
  B(g, 0.004, 0.02, 0.006, 0, -0.03, -0.012, VMAT.steel, 0.3);              // trigger
  P.mag = curvedMag(g, 0, -0.035, -0.07, 0.034, 5, 0.03, 0.06, 0.07, VMAT.metal);
  P.bolt = B(g, 0.04, 0.012, 0.03, 0, 0.055, 0.06, VMAT.metal);              // charging handle
  P.boltRest = 0.06;
  // red dot optic
  B(g, 0.03, 0.014, 0.05, 0, 0.072, -0.05, VMAT.metal);
  C(g, 0.019, 0.05, 0, 0.1, -0.05, VMAT.tube, 16, undefined, 'z', true);
  const glassM = C(g, 0.017, 0.002, 0, 0.1, -0.074, VMAT.glass, 16);
  glassM.renderOrder = 5;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0008, 8, 6), VM_DOT);
  dot.position.set(0, 0.1, -0.07);
  g.add(dot);
  B(g, 0.012, 0.012, 0.012, 0.022, 0.1, -0.05, VMAT.metal);                 // turret
  // arms: right on grip, left on handguard
  P.handR = hand(g, 0, -0.07, 0.04, 1, 0.28);
  forearm(g, 0.02, -0.12, 0.07, 0.1, -0.24, 0.38);
  P.handL = new THREE.Group(); g.add(P.handL);
  hand(P.handL, -0.005, -0.012, -0.34, -1, 1.2, 0.1);
  forearm(P.handL, -0.03, -0.05, -0.31, -0.13, -0.34, -0.04);
  return { sightY: 0.1, sightZ: -0.05, muzzleZ: -0.66, muzzleY: 0.03, hip: [0.15, -0.14, -0.36], kick: 0.9 };
}
function buildSMG(g, P) {
  const R = VMAT.polymer;
  B(g, 0.048, 0.075, 0.26, 0, 0.02, -0.08, R);                              // boxy upper
  B(g, 0.046, 0.08, 0.12, 0, -0.035, -0.11, R, -0.35);                      // angled lower (Super V)
  rail(g, 0.24, 0, 0.061, -0.09);
  C(g, 0.02, 0.18, 0, 0.03, -0.3, VMAT.metal, 16);                         // suppressor
  C(g, 0.021, 0.02, 0, 0.03, -0.39, VMAT.steel, 16);
  C(g, 0.015, 0.12, 0, 0.022, 0.1, VMAT.metal);                             // folding stock tube
  B(g, 0.03, 0.07, 0.1, 0, 0.0, 0.17, R);
  B(g, 0.03, 0.09, 0.04, 0, -0.07, 0.03, R, 0.22);                          // grip
  B(g, 0.03, 0.02, 0.07, 0, -0.03, -0.2, R);                                // front grip mount
  B(g, 0.022, 0.07, 0.03, 0, -0.07, -0.21, R, -0.2);                        // vertical grip
  P.mag = curvedMag(g, 0, -0.06, -0.03, 0.03, 4, 0.03, 0.045, 0.0, VMAT.polymer);
  P.bolt = B(g, 0.012, 0.018, 0.03, -0.028, 0.035, 0.0, VMAT.steel); P.boltRest = 0.0;
  // holographic sight: open window + reticle ring and dot
  B(g, 0.04, 0.012, 0.07, 0, 0.068, -0.07, VMAT.metal);
  B(g, 0.006, 0.04, 0.07, 0.022, 0.092, -0.07, VMAT.metal); B(g, 0.006, 0.04, 0.07, -0.022, 0.092, -0.07, VMAT.metal);
  B(g, 0.05, 0.006, 0.07, 0, 0.114, -0.07, VMAT.metal);
  const gl = B(g, 0.038, 0.034, 0.002, 0, 0.093, -0.09, VMAT.glass); gl.renderOrder = 5;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0006, 4, 24), VM_DOT);
  ring.scale.setScalar(0.3); ring.position.set(0, 0.093, -0.088); g.add(ring);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.00035, 6, 4), VM_DOT); dot.position.set(0, 0.093, -0.088); g.add(dot);
  P.handR = hand(g, 0, -0.065, 0.03, 1, 0.22);
  forearm(g, 0.02, -0.115, 0.06, 0.1, -0.24, 0.38);
  P.handL = new THREE.Group(); g.add(P.handL);
  hand(P.handL, 0, -0.07, -0.21, -1, 0.2, 0);
  forearm(P.handL, -0.01, -0.12, -0.19, -0.12, -0.36, 0.0);
  return { sightY: 0.093, sightZ: -0.07, muzzleZ: -0.4, muzzleY: 0.03, hip: [0.14, -0.13, -0.33], kick: 0.6 };
}
function buildBR(g, P) {
  const t = buildAR(g, P, true);
  // longer barrel + big muzzle brake, remove red dot for an ACOG
  g.children.slice().forEach(function (o) {
    if (o.material === VM_DOT || o.material === VMAT.glass || (o.position.y > 0.085 && o.position.z > -0.12 && o.position.z < 0.0)) { g.remove(o); if (o.geometry) o.geometry.dispose(); }
  });
  C(g, 0.01, 0.12, 0, 0.03, -0.68, VMAT.steel);
  C(g, 0.017, 0.07, 0, 0.03, -0.76, VMAT.metal, 8);
  // ACOG: body, objective bell, ocular, fibre on top, chevron reticle
  C(g, 0.02, 0.13, 0, 0.1, -0.07, VMAT.tube, 16, undefined, 'z', true);
  C(g, 0.026, 0.04, 0, 0.1, -0.15, VMAT.tube, 16, 0.02, 'z', true);
  C(g, 0.022, 0.03, 0, 0.1, 0.005, VMAT.tube, 16, undefined, 'z', true);
  const lens = C(g, 0.024, 0.002, 0, 0.1, -0.17, VMAT.glass, 16); lens.renderOrder = 5;
  B(g, 0.03, 0.022, 0.08, 0, 0.078, -0.07, VMAT.metal);
  B(g, 0.008, 0.008, 0.06, 0, 0.124, -0.07, VM_TRITIUM);
  const chev = new THREE.Mesh(new THREE.ConeGeometry(0.0022, 0.004, 3), VM_DOT);
  chev.scale.setScalar(0.5); chev.position.set(0, 0.0993, -0.12); g.add(chev);
  t.sightY = 0.1; t.sightZ = 0.005; t.muzzleZ = -0.8; t.kick = 1.3;
  return t;
}
function buildSR(g, P) {
  // chassis stock: fore-end with M-LOK slots, grip, adjustable cheek riser, butt spacers
  B(g, 0.056, 0.06, 0.42, 0, -0.008, -0.3, VMAT.olive);                     // fore-end
  for (let i = 0; i < 5; i++) for (const sx of [-1, 1]) B(g, 0.003, 0.012, 0.035, sx * 0.0285, -0.01, -0.18 - i * 0.055, VMAT.knuckle);
  B(g, 0.024, 0.008, 0.2, 0, -0.042, -0.33, VMAT.metal);                    // bottom accessory rail
  B(g, 0.05, 0.04, 0.2, 0, -0.018, -0.02, VMAT.olive);                      // action bed
  B(g, 0.034, 0.1, 0.05, 0, -0.085, 0.05, VMAT.olive, 0.35);                // grip
  for (let i = 0; i < 4; i++) B(g, 0.036, 0.004, 0.052, 0, -0.06 - i * 0.02, 0.058 + i * 0.006, VMAT.knuckle, 0.35);
  B(g, 0.008, 0.006, 0.07, 0, -0.045, -0.005, VMAT.metal);                  // trigger guard
  B(g, 0.004, 0.018, 0.006, 0, -0.032, -0.01, VMAT.steel, 0.3);             // trigger
  B(g, 0.046, 0.075, 0.2, 0, -0.03, 0.18, VMAT.olive);                      // butt
  B(g, 0.03, 0.03, 0.06, 0, -0.012, 0.08, VMAT.metal);                      // stock hinge block
  B(g, 0.044, 0.028, 0.13, 0, 0.034, 0.17, VMAT.olive);                     // cheek riser
  for (const z of [0.13, 0.21]) C(g, 0.005, 0.03, 0, 0.014, z, VMAT.steel, 8, undefined, 'y');   // riser posts
  C(g, 0.007, 0.012, 0.026, 0.02, 0.17, VMAT.steel, 8, undefined, 'x');     // riser knob
  B(g, 0.05, 0.1, 0.012, 0, -0.035, 0.286, VMAT.metal);                     // spacers
  B(g, 0.052, 0.105, 0.02, 0, -0.035, 0.302, VMAT.knuckle);                 // recoil pad
  C(g, 0.006, 0.01, 0, -0.07, 0.24, VMAT.steel, 8, undefined, 'x');         // sling swivels
  C(g, 0.006, 0.01, 0, -0.045, -0.46, VMAT.steel, 8, undefined, 'x');
  // round receiver + bolt shroud
  C(g, 0.02, 0.22, 0, 0.03, -0.06, VMAT.metal, 18);
  C(g, 0.017, 0.035, 0, 0.03, 0.065, VMAT.metal, 16);
  B(g, 0.012, 0.022, 0.06, 0.02, 0.036, -0.05, VMAT.knuckle);               // ejection port
  rail(g, 0.2, 0, 0.056, -0.07);
  // fluted barrel + ported muzzle brake
  C(g, 0.012, 0.46, 0, 0.03, -0.4, VMAT.metal, 16, 0.0095);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    B(g, 0.003, 0.003, 0.3, Math.cos(a) * 0.0105, 0.03 + Math.sin(a) * 0.0105, -0.44, VMAT.knuckle);
  }
  C(g, 0.017, 0.08, 0, 0.03, -0.67, VMAT.metal, 8);
  for (let i = 0; i < 3; i++) for (const sx of [-1, 1]) B(g, 0.004, 0.012, 0.012, sx * 0.016, 0.03, -0.645 - i * 0.02, VMAT.knuckle);
  // detachable magazine
  P.mag = new THREE.Group(); P.mag.position.set(0, -0.04, -0.05); g.add(P.mag);
  B(P.mag, 0.036, 0.05, 0.08, 0, -0.025, 0, VMAT.metal);
  B(P.mag, 0.04, 0.008, 0.086, 0, -0.052, 0, VMAT.polymer);
  // bolt: body slides in the receiver, handle rotates up
  P.bolt = new THREE.Group(); P.bolt.position.set(0.02, 0.03, 0.02); g.add(P.bolt);
  C(P.bolt, 0.006, 0.05, 0.022, 0, 0, VMAT.steel, 8, 0.006, 'x');
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.018, 10), VMAT.polymer);
  knob.rotation.z = Math.PI / 2; knob.position.set(0.048, -0.004, 0); P.bolt.add(knob);
  C(P.bolt, 0.01, 0.05, -0.02, 0.0, -0.02, VMAT.steel, 12);                 // bolt body (visible in the port)
  P.boltRest = 0.02;
  // scope: tube, objective bell + sunshade, eyepiece, turrets, parallax knob, rings, flip caps
  C(g, 0.017, 0.26, 0, 0.1, -0.09, VMAT.metal, 20);
  C(g, 0.03, 0.07, 0, 0.1, -0.265, VMAT.metal, 20, 0.017);
  C(g, 0.03, 0.06, 0, 0.1, -0.33, VMAT.metal, 20);
  const lensF = C(g, 0.027, 0.003, 0, 0.1, -0.36, VMAT.lens, 20); lensF.renderOrder = 4;
  C(g, 0.021, 0.05, 0, 0.1, 0.06, VMAT.metal, 18, 0.017);
  C(g, 0.024, 0.03, 0, 0.1, 0.095, VMAT.polymer, 18);                       // diopter ring
  const lensR = C(g, 0.021, 0.002, 0, 0.1, 0.11, VMAT.lens, 18); lensR.renderOrder = 4;
  C(g, 0.012, 0.032, 0, 0.132, -0.1, VMAT.metal, 16, undefined, 'y');       // elevation turret
  C(g, 0.0125, 0.008, 0, 0.143, -0.1, VMAT.knuckle, 16, undefined, 'y');
  C(g, 0.012, 0.032, 0.032, 0.1, -0.1, VMAT.metal, 16, undefined, 'x');     // windage
  C(g, 0.011, 0.026, -0.03, 0.1, -0.1, VMAT.metal, 16, undefined, 'x');     // parallax knob
  for (const z of [-0.02, -0.18]) {
    C(g, 0.021, 0.018, 0, 0.1, z, VMAT.metal, 18);                          // ring
    B(g, 0.02, 0.05, 0.018, 0, 0.068, z, VMAT.metal);                       // ring base
    C(g, 0.003, 0.012, 0.024, 0.1, z, VMAT.steel, 6, undefined, 'x');       // ring screws
  }
  const capF = B(g, 0.06, 0.004, 0.06, 0, 0.132, -0.362, VMAT.polymer, 1.3); capF.position.y = 0.14;   // flip caps (open)
  B(g, 0.045, 0.004, 0.045, 0.032, 0.12, 0.112, VMAT.polymer, 0, 0, 1.2);
  // folded bipod on the front sling stud
  B(g, 0.03, 0.02, 0.04, 0, -0.05, -0.48, VMAT.metal);
  B(g, 0.01, 0.01, 0.18, -0.016, -0.058, -0.39, VMAT.metal); B(g, 0.01, 0.01, 0.18, 0.016, -0.058, -0.39, VMAT.metal);
  B(g, 0.014, 0.01, 0.02, -0.016, -0.058, -0.3, VMAT.knuckle); B(g, 0.014, 0.01, 0.02, 0.016, -0.058, -0.3, VMAT.knuckle);
  P.handR = hand(g, 0, -0.082, 0.05, 1, 0.35);
  forearm(g, 0.02, -0.13, 0.08, 0.1, -0.25, 0.38);
  P.handL = new THREE.Group(); g.add(P.handL);
  hand(P.handL, 0, -0.04, -0.32, -1, 1.1, 0.05);
  forearm(P.handL, -0.02, -0.08, -0.29, -0.13, -0.36, -0.03);
  return { sightY: 0.1, sightZ: 0.11, muzzleZ: -0.72, muzzleY: 0.03, hip: [0.16, -0.15, -0.38], kick: 2.2 };
}
function buildSG(g, P) {
  B(g, 0.05, 0.065, 0.2, 0, 0.02, -0.04, VMAT.metal);                       // receiver
  B(g, 0.012, 0.03, 0.06, 0.026, 0.025, -0.05, VMAT.knuckle);               // ejection port
  C(g, 0.013, 0.5, 0, 0.038, -0.39, VMAT.metal);                            // barrel
  C(g, 0.012, 0.42, 0, 0.004, -0.36, VMAT.metal);                           // magazine tube
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), VM_TRITIUM); bead.position.set(0, 0.056, -0.62); g.add(bead);
  B(g, 0.03, 0.004, 0.03, 0, 0.054, 0.04, VMAT.metal);                      // receiver top groove (bead-only sight)
  B(g, 0.046, 0.075, 0.24, 0, -0.03, 0.17, VMAT.wood, -0.1);                // stock
  B(g, 0.048, 0.1, 0.02, 0, -0.045, 0.29, VMAT.knuckle, -0.1);
  B(g, 0.034, 0.05, 0.08, 0, -0.03, 0.06, VMAT.wood, 0.25);                 // wrist
  B(g, 0.008, 0.006, 0.06, 0, -0.022, -0.03, VMAT.metal);
  // pump: forend + left arm ride together
  P.pump = new THREE.Group(); g.add(P.pump);
  B(P.pump, 0.05, 0.045, 0.14, 0, 0.004, -0.3, VMAT.wood);
  for (let i = 0; i < 5; i++) B(P.pump, 0.052, 0.004, 0.006, 0, 0.004, -0.25 - i * 0.022, VMAT.knuckle);
  P.handL = new THREE.Group(); P.pump.add(P.handL);
  hand(P.handL, 0, -0.018, -0.3, -1, 1.25, 0.05);
  forearm(P.handL, -0.02, -0.05, -0.27, -0.13, -0.34, -0.03);
  P.mag = null;
  P.handR = hand(g, 0, -0.045, 0.06, 1, 0.3);
  forearm(g, 0.02, -0.095, 0.09, 0.1, -0.23, 0.4);
  return { sightY: 0.058, sightZ: 0.04, muzzleZ: -0.65, muzzleY: 0.038, hip: [0.15, -0.14, -0.36], kick: 2.6 };
}
function buildLMG(g, P) {
  B(g, 0.07, 0.08, 0.34, 0, 0.02, -0.06, VMAT.metal);                       // receiver
  P.lid = new THREE.Group(); P.lid.position.set(0, 0.062, 0.07); g.add(P.lid);   // feed cover hinges at the rear
  B(P.lid, 0.068, 0.018, 0.2, 0, 0, -0.1, VMAT.metal);
  rail(P.lid, 0.12, 0, 0.012, -0.1);
  B(g, 0.07, 0.06, 0.26, 0, 0.02, -0.34, VMAT.polymer);                     // heat shield / handguard
  for (let i = 0; i < 6; i++) B(g, 0.072, 0.004, 0.02, 0, 0.045, -0.24 - i * 0.04, VMAT.knuckle);
  C(g, 0.012, 0.36, 0, 0.02, -0.6, VMAT.metal);
  C(g, 0.017, 0.05, 0, 0.02, -0.79, VMAT.metal, 8);
  B(g, 0.02, 0.05, 0.1, 0, 0.1, -0.2, VMAT.metal);                          // carry handle
  B(g, 0.02, 0.03, 0.02, 0, 0.075, -0.15, VMAT.metal); B(g, 0.02, 0.03, 0.02, 0, 0.075, -0.25, VMAT.metal);
  B(g, 0.05, 0.08, 0.18, 0, 0.0, 0.2, VMAT.polymer);                        // stock
  B(g, 0.034, 0.1, 0.045, 0, -0.08, 0.04, VMAT.polymer, 0.28);              // grip
  // box magazine (soft pouch) hanging on the left, belt feeding in
  P.mag = new THREE.Group(); P.mag.position.set(-0.07, -0.02, -0.08); g.add(P.mag);
  B(P.mag, 0.07, 0.11, 0.12, -0.02, -0.05, 0, VMAT.olive);
  for (let i = 0; i < 6; i++) { const r = C(P.mag, 0.004, 0.035, 0.03, 0.02 + i * 0.004, -0.04 + i * 0.016, VMAT.brass, 6, 0.003, 'x'); r.rotation.y = 0.2; }
  // folded bipod
  B(g, 0.012, 0.012, 0.2, -0.018, -0.02, -0.52, VMAT.metal); B(g, 0.012, 0.012, 0.2, 0.018, -0.02, -0.52, VMAT.metal);
  // red dot on the feed cover rail
  C(P.lid, 0.017, 0.045, 0, 0.042, -0.1, VMAT.tube, 14, undefined, 'z', true);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0005, 6, 4), VM_DOT); dot.position.set(0, 0.042, -0.12); P.lid.add(dot);
  P.bolt = B(g, 0.02, 0.02, 0.05, 0.04, 0.02, -0.12, VMAT.steel); P.boltRest = -0.12;
  P.handR = hand(g, 0, -0.075, 0.04, 1, 0.28);
  forearm(g, 0.02, -0.125, 0.07, 0.1, -0.25, 0.38);
  P.handL = new THREE.Group(); g.add(P.handL);
  hand(P.handL, 0, -0.02, -0.34, -1, 1.2, 0.1);
  forearm(P.handL, -0.03, -0.06, -0.31, -0.13, -0.35, -0.04);
  return { sightY: 0.104, sightZ: -0.03, muzzleZ: -0.82, muzzleY: 0.02, hip: [0.16, -0.16, -0.36], kick: 0.9 };
}
function buildPST(g, P) {
  P.slide = new THREE.Group(); g.add(P.slide);
  B(P.slide, 0.03, 0.034, 0.19, 0, 0.03, -0.075, VMAT.metal);
  for (let i = 0; i < 6; i++) B(P.slide, 0.032, 0.022, 0.003, 0, 0.03, 0.005 - i * 0.007, VMAT.knuckle);   // serrations
  B(P.slide, 0.004, 0.012, 0.006, 0, 0.049, -0.16, VMAT.metal);             // front sight
  const fdot = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 6, 4), VM_TRITIUM); fdot.position.set(0, 0.0545, -0.164); P.slide.add(fdot);
  B(P.slide, 0.008, 0.012, 0.008, -0.0075, 0.052, 0.012, VMAT.metal);       // rear sight: two posts,
  B(P.slide, 0.008, 0.012, 0.008, 0.0075, 0.052, 0.012, VMAT.metal);        // front post shows in the notch
  C(g, 0.007, 0.02, 0, 0.03, -0.172, VMAT.steel);
  B(g, 0.028, 0.02, 0.15, 0, 0.004, -0.07, VMAT.polymer);                   // frame / dust cover
  B(g, 0.03, 0.1, 0.045, 0, -0.05, 0.005, VMAT.polymer, 0.22);              // grip
  B(g, 0.006, 0.02, 0.045, 0, -0.012, -0.035, VMAT.polymer);                // trigger guard
  P.mag = new THREE.Group(); P.mag.position.set(0, -0.09, 0.012); g.add(P.mag);
  B(P.mag, 0.024, 0.02, 0.036, 0, -0.01, 0, VMAT.metal, 0.22);
  P.handR = hand(g, 0, -0.045, 0.01, 1, 0.22);
  forearm(g, 0.02, -0.095, 0.04, 0.09, -0.24, 0.36);
  P.handL = new THREE.Group(); g.add(P.handL);
  hand(P.handL, -0.02, -0.055, 0.002, -1, 0.22, -0.35);                    // support hand wraps the right
  forearm(P.handL, -0.03, -0.1, 0.03, -0.17, -0.26, 0.3);
  P.bolt = null;
  return { sightY: 0.054, sightZ: 0.012, muzzleZ: -0.185, muzzleY: 0.03, hip: [0.13, -0.13, -0.34], kick: 1.3 };
}
// Knife (melee) — its own arm, shown only while slashing
let knifeGroup = null;
function buildKnife() {
  knifeGroup = new THREE.Group();
  const k = new THREE.Group(); knifeGroup.add(k);
  B(k, 0.004, 0.028, 0.16, 0, 0.0, -0.12, VMAT.blade);
  B(k, 0.005, 0.012, 0.05, 0, 0.012, -0.23, VMAT.blade, -0.35);
  B(k, 0.03, 0.012, 0.012, 0, 0, -0.035, VMAT.metal);                       // guard
  B(k, 0.022, 0.026, 0.1, 0, -0.002, 0.02, VMAT.polymer);                   // handle
  hand(k, 0, -0.005, 0.02, 1, 1.35);
  forearm(k, 0.01, -0.04, 0.06, 0.09, -0.2, 0.34);
  knifeGroup.visible = false;
  knifeGroup.traverse(function (o) { o.userData.gun = true; });
  gunCamera.add(knifeGroup);
}

// ---- Build / rebuild for the current weapon ----
let muzzleFlash = null;
let gunParts = {};
let vmTune = null;
function buildViewmodel() {
  disposeViewmodel();
  gunGroup = new THREE.Group();
  const w = CFG.weapons[weaponsOwned[curWeapon]];
  const P = { mag: null, bolt: null, pump: null, slide: null, lid: null, handL: null, handR: null };
  const builders = { AR: buildAR, SMG: buildSMG, BR: buildBR, SR: buildSR, SG: buildSG, LMG: buildLMG, PST: buildPST };
  vmTune = (builders[w.type] || buildAR)(gunGroup, P);
  P.magRest = P.mag ? P.mag.position.clone() : null;
  P.pumpRest = P.pump ? P.pump.position.z : 0;
  P.handLRest = P.handL ? P.handL.position.clone() : null;
  P.muzzle = new THREE.Object3D();
  P.muzzle.position.set(0, vmTune.muzzleY, vmTune.muzzleZ);
  gunGroup.add(P.muzzle);
  muzzleFlash = w.suppressed ? null : muzzleFlashGroup(gunGroup, vmTune.muzzleZ, vmTune.muzzleY);
  gunParts = P;
  gunGroup.traverse(function (o) { o.userData.gun = true; if (o.isMesh) o.castShadow = false; });
  gunCamera.add(gunGroup);
  if (!knifeGroup) buildKnife();
}

// ---- Springs: sway (look inertia), recoil ----
const vmSpring = { sx: 0, sy: 0, vx: 0, vy: 0, kz: 0, kvz: 0, kr: 0, kvr: 0, roll: 0, vroll: 0, tilt: 0 };
function kickViewmodel(w) {
  const k = (vmTune ? vmTune.kick : 1) * (adsAmount > 0.5 ? 0.6 : 1) * perkMul('recoil');
  vmSpring.kvz += 2.2 * k;
  vmSpring.kvr += 7.5 * k;
  vmSpring.vroll += (Math.random() - 0.5) * 6 * k;
  if (gunParts.slide) gunParts.slideKick = 1;
  if (gunParts.bolt && !w.bolt) gunParts.boltKick = 1;
}
// Semi-implicit Euler in fixed 1/120 s substeps: stiff springs stay stable even
// when a hitch hands us the 0.1 s maximum frame step.
function stepSpring(x, v, target, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
  for (let i = 0; i < n; i++) {
    v += ((target - x) * k - v * c) * h;
    x += v * h;
  }
  if (!isFinite(x) || !isFinite(v)) return [target, 0];
  return [x, v];
}
function smooth01(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function bump(a, b, x) { return x <= a || x >= b ? 0 : Math.sin((x - a) / (b - a) * Math.PI); }

// per-frame viewmodel pose
let flashT = 0;
const _gunInvQ = new THREE.Quaternion();
const gunKey = new THREE.DirectionalLight(0xffc49a, 1.5);
const gunFill = new THREE.HemisphereLight(0x8a9ac0, 0x2a2420, 0.55);
gunScene.add(gunKey); gunScene.add(gunKey.target); gunScene.add(gunFill);
// the key light tracks the real sun direction in view space
function updateGunLighting() {
  _gunInvQ.copy(camera.quaternion).invert();
  gunKey.position.copy(SUN_DIR).applyQuaternion(_gunInvQ).multiplyScalar(5);
  gunKey.target.position.set(0, 0, 0);
}
function updateViewmodel(dt) {
  if (!gunGroup || !vmTune) return;
  const w = curW(), s = curS(), P = gunParts;
  // the bolt is worked without leaving the scope (see drawScope's bolt dip)
  const aimAds = adsDown() && gunSwitchT >= 1 && !(s && s.reloading);
  const adsRate = w.type === 'LMG' ? 7 : w.type === 'SR' ? 9 : w.type === 'PST' ? 16 : 12;
  adsAmount += ((aimAds ? 1 : 0) - adsAmount) * Math.min(1, adsRate * dt);
  gunSwitchT = Math.min(1, gunSwitchT + dt * 3.5 * perkMul('swap'));
  const ads = adsAmount * adsAmount * (3 - 2 * adsAmount);
  const hipK = 1 - ads;
  const t = gameT;
  // --- base pose: hip -> sight aligned to the screen centre ---
  const adsZ = -0.16 - vmTune.sightZ;
  let px = vmTune.hip[0] * hipK;
  let py = vmTune.hip[1] + (-vmTune.sightY - vmTune.hip[1]) * ads;
  let pz = vmTune.hip[2] + (adsZ - vmTune.hip[2]) * ads;
  let rx = 0, ry = -0.02 * hipK, rz = 0;
  // --- look sway (inertia spring) ---
  const tx = Math.max(-0.05, Math.min(0.05, -player.lookDX * 1.6)) * (1 - ads * 0.75);
  const ty = Math.max(-0.05, Math.min(0.05, player.lookDY * 1.6)) * (1 - ads * 0.75);
  let r = stepSpring(vmSpring.sx, vmSpring.vx, tx, 90, 11, dt); vmSpring.sx = r[0]; vmSpring.vx = r[1];
  r = stepSpring(vmSpring.sy, vmSpring.vy, ty, 90, 11, dt); vmSpring.sy = r[0]; vmSpring.vy = r[1];
  px += vmSpring.sx * 0.6; py += vmSpring.sy * 0.5;
  ry += vmSpring.sx * 1.6; rx += vmSpring.sy * 1.4;
  // --- movement bob (figure eight), strafe tilt, breathing ---
  const bob = player.bobAmp * (player.sprinting ? 1.6 : 1) * (1 - ads * 0.88);
  px += Math.sin(player.bobPhase) * 0.012 * bob;
  py += -Math.abs(Math.cos(player.bobPhase)) * 0.012 * bob;
  rz += Math.sin(player.bobPhase) * 0.02 * bob;
  const latV = player.vel.x * Math.cos(player.yaw) - player.vel.z * Math.sin(player.yaw);
  vmSpring.tilt += (-latV * 0.012 * (1 - ads * 0.7) - vmSpring.tilt) * Math.min(1, 8 * dt);
  rz += vmSpring.tilt;
  py += Math.sin(t * 1.7) * 0.0022 * hipK;
  rx += Math.sin(t * 1.3) * 0.004 * hipK;
  // sniper breath sway while scoped
  if (w.type === 'SR') { px += swayX * (1 - ads * 0.5); py += swayY * (1 - ads * 0.5); }
  // landing / crouch / lean
  py += player.landDip * 0.35;
  rz -= player.lean * 0.12;
  // --- sprint pose ---
  const sprint = player.sprinting && !player.sliding ? 1 : 0;
  vmSpring.sprint = (vmSpring.sprint || 0) + (sprint - (vmSpring.sprint || 0)) * Math.min(1, 9 * dt);
  const sp = vmSpring.sprint * hipK;
  if (w.type === 'PST') { py -= 0.05 * sp; rx += -0.7 * sp; }
  else { px += 0.04 * sp; py -= 0.05 * sp; ry += 0.55 * sp; rz += 0.3 * sp; rx += -0.12 * sp; }
  // --- recoil spring ---
  r = stepSpring(vmSpring.kz, vmSpring.kvz, 0, 260, 20, dt); vmSpring.kz = r[0]; vmSpring.kvz = r[1];
  r = stepSpring(vmSpring.kr, vmSpring.kvr, 0, 220, 17, dt); vmSpring.kr = r[0]; vmSpring.kvr = r[1];
  r = stepSpring(vmSpring.roll, vmSpring.vroll, 0, 160, 14, dt); vmSpring.roll = r[0]; vmSpring.vroll = r[1];
  pz += vmSpring.kz * 0.05; py += vmSpring.kr * 0.004; rx += vmSpring.kr * 0.05; rz += vmSpring.roll * 0.03;
  // --- weapon switch raise ---
  const raise = 1 - gunSwitchT;
  py -= raise * raise * 0.3; rx -= raise * 0.6;
  // --- mantle: gun tucked away ---
  if (player.mantle) { vmSpring.mantle = Math.min(1, (vmSpring.mantle || 0) + dt * 8); }
  else vmSpring.mantle = Math.max(0, (vmSpring.mantle || 0) - dt * 5);
  py -= vmSpring.mantle * 0.18; rz += vmSpring.mantle * 0.5; rx -= vmSpring.mantle * 0.3;

  // --- reload choreography ---
  if (P.mag && P.magRest) { P.mag.position.copy(P.magRest); P.mag.visible = true; }
  if (P.handL && P.handLRest) { P.handL.position.copy(P.handLRest); P.handL.rotation.set(0, 0, 0); }
  if (P.lid) P.lid.rotation.x = 0;
  let boltBack = 0, boltLift = 0;
  if (s && s.reloading) {
    if (s.reloadKind === 'shell') {
      // tilt the gun, left hand shuttles shells into the loading port
      const k = Math.min(1, s.reloadT / 0.3);
      rz += 0.5 * k; rx += 0.12 * k; py -= 0.03 * k; px -= 0.02 * k;
      const cyc = 1 - Math.max(0, s.shellT) / (w.reload * perkMul('reload'));
      if (P.handL) { P.handL.position.y -= bump(0, 1, cyc) * 0.09; P.handL.position.z += bump(0, 1, cyc) * 0.2; P.handL.position.x += bump(0, 1, cyc) * 0.02; }
    } else {
      const p = s.reloadT / s.reloadDur;
      const k = bump(0, 1, p);
      rz += 0.42 * k; rx += 0.18 * k; py -= 0.05 * k; px -= 0.02 * k;
      if (P.mag && P.magRest) {
        // out: 0.1–0.3, gone: 0.3–0.45, in: 0.45–0.65
        const out = smooth01(0.1, 0.3, p), inn = smooth01(0.45, 0.65, p);
        const off = p < 0.45 ? out : 1 - inn;
        P.mag.position.y -= off * 0.28; P.mag.position.z += off * 0.04;
        P.mag.visible = !(p > 0.3 && p < 0.45);
      }
      if (P.handL && P.handLRest && w.type !== 'PST') {
        const hk = bump(0.08, 0.72, p);
        const target = P.magRest ? P.magRest : P.handLRest;
        P.handL.position.x += (target.x - P.handLRest.x - 0.01) * hk * 0.9;
        P.handL.position.y += (-0.12) * hk;
        P.handL.position.z += (target.z - P.handLRest.z + 0.15) * hk * 0.9;
      }
      if (P.lid) P.lid.rotation.x = -1.1 * (smooth01(0.1, 0.22, p) - smooth01(0.75, 0.88, p));
      if (s.reloadKind === 'empty') boltBack = bump(0.78, 0.94, p);
      if (w.type === 'SR' && s.reloadKind === 'empty') boltLift = bump(0.74, 0.98, p);
    }
  }
  // bolt-action cycle / pump / pistol slide
  if (s && s.cycleT > 0 && w.bolt) {
    const k = 1 - s.cycleT / w.bolt;
    boltLift = Math.max(boltLift, smooth01(0.0, 0.2, k) - smooth01(0.75, 0.95, k));
    boltBack = Math.max(boltBack, smooth01(0.2, 0.45, k) - smooth01(0.5, 0.75, k));
    rz += bump(0, 1, k) * 0.12; py -= bump(0, 1, k) * 0.02;
  }
  if (P.bolt) {
    if (w.type === 'SR') { P.bolt.rotation.x = 0; P.bolt.rotation.z = boltLift * 1.1; P.bolt.position.z = P.boltRest + boltBack * 0.08; }
    else {
      gunParts.boltKick = Math.max(0, (gunParts.boltKick || 0) - dt * 14);
      P.bolt.position.z = P.boltRest + boltBack * 0.07 + (gunParts.boltKick || 0) * 0.02;
    }
  }
  if (P.pump) {
    const k = s && s.cycleT > 0 && w.pump ? 1 - s.cycleT / w.pump : 1;
    P.pump.position.z = P.pumpRest + (smooth01(0.05, 0.4, k) - smooth01(0.45, 0.85, k)) * 0.1;
  }
  if (P.slide) {
    gunParts.slideKick = Math.max(0, (gunParts.slideKick || 0) - dt * 16);
    const locked = s && s.ammo === 0 && !(s.reloading && s.reloadT / s.reloadDur > 0.85);
    P.slide.position.z = locked ? 0.035 : (gunParts.slideKick || 0) * 0.035;
  }
  // --- melee: gun ducks out, knife slashes across ---
  const mk = meleeT > 0 ? 1 - meleeT / MELEE_DUR : 0;
  const gunOut = meleeT > 0 ? bump(0, 1, mk) : 0;
  py -= gunOut * 0.25; rx -= gunOut * 0.5; rz += gunOut * 0.4;
  if (knifeGroup) {
    knifeGroup.visible = meleeT > 0;
    if (meleeT > 0) {
      const sw = smooth01(0.1, 0.45, mk);
      knifeGroup.position.set(0.22 - sw * 0.36, -0.12 + bump(0, 1, mk) * 0.06, -0.3);
      knifeGroup.rotation.set(-0.2, 0.9 - sw * 1.6, -0.9 + sw * 0.9);
    }
  }
  gunGroup.position.set(px, py, pz);
  gunGroup.rotation.set(rx, ry, rz);
  // --- muzzle flash decay ---
  if (muzzleFlash && muzzleFlash.visible) {
    flashT -= dt * 22;
    if (flashT <= 0) muzzleFlash.visible = false;
  }
  // viewmodel FOV narrows slightly when aiming (magnified feel)
  const gunFov = 58 - ads * (w.type === 'SR' ? 18 : 12);
  if (Math.abs(gunCamera.fov - gunFov) > 0.05) { gunCamera.fov = gunFov; gunCamera.updateProjectionMatrix(); }
  // --- optics overlays ---
  const scoped = w.type === 'SR' && adsAmount > 0.82;
  const scopeOv = $id('scoping-overlay');
  // ACOG vignette; the sniper scope is drawn by 34_scope.js
  const wantScope = adsAmount > 0.75 && w.type === 'BR';
  scopeOv.style.opacity = wantScope ? 1 : 0;
  gunGroup.visible = !scoped;
  updateCrosshair(adsAmount > 0.6 || meleeT > 0 || (s && s.reloading) || player.sprinting ? 0 : 1, currentSpread());
  // steady indicator
  const steadyInd = $id('steady-ind');
  if (steadyInd) {
    steadyInd.style.opacity = (w.type === 'SR' && adsAmount > 0.8) ? 1 : 0;
    steadyInd.textContent = steadyActive ? 'STEADY · ' + Math.ceil(steadyT * 10) / 10 + 's' : (steadyT < 0.25 ? 'CATCH YOUR BREATH' : 'HOLD SHIFT TO STEADY');
    steadyInd.classList.toggle('steady-on', steadyActive);
  }
}
function triggerMuzzleFlash() {
  if (!muzzleFlash) return;
  muzzleFlash.visible = true;
  muzzleFlash.rotation.z = Math.random() * Math.PI;
  const s = 0.8 + Math.random() * 0.5;
  muzzleFlash.scale.set(s, s, 0.8 + Math.random() * 0.6);
  flashT = 1;
}
// Muzzle position in world space: the viewmodel is drawn with its own FOV, so
// rescale its view-space offset into the world camera's frustum before transforming.
const _mzV = new THREE.Vector3();
function muzzleWorldPos(out) {
  if (!gunParts.muzzle || !gunGroup) return out.copy(camera.position);
  gunGroup.updateMatrixWorld(true);
  gunParts.muzzle.getWorldPosition(_mzV);
  const k = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(gunCamera.fov) / 2);
  _mzV.x *= k; _mzV.y *= k;
  return out.copy(_mzV).applyMatrix4(camera.matrixWorld);
}
