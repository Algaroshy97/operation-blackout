// ============ VIEWMODELS: PROCEDURAL GUNS, ARMS, ANIMATION ============
'use strict';
// Every weapon is assembled from primitives at runtime (no model files): receivers,
// rails, optics with glowing reticles, magazines and bolts that animate, gloved
// hands and camo sleeves. The gunsmith loadout shows on the model: optic, barrel,
// underbarrel, magazine and stock each have a visible part.
//
// The gun lives in its own small scene, drawn by gunCamera after the world with a
// cleared depth buffer (see renderFrame in 65_postfx.js). That keeps it depth
// tested against itself — a hand in front of a grip, a scope over a receiver —
// which the old depthTest:false boxes could not do, while it still never clips
// into walls. gunCamera sits at the origin, so gun space IS view space.
function vmMat(params) {
  // Hex goes to the shader as-is, like every other colour in the game (colour
  // management is off; see 10_config_world.js).
  const m = new THREE.MeshStandardMaterial(params);
  if (SKY_ENV) { m.envMap = SKY_ENV; if (params.envMapIntensity === undefined) m.envMapIntensity = 0.45; }
  return m;
}
const VMAT = {
  polymer: vmMat({ color: 0x1b1c1f, roughness: 0.62, metalness: 0.1, normalMap: TEX.gunNoise.normalMap, normalScale: new THREE.Vector2(0.5, 0.5) }),
  metal: vmMat({ color: 0x26282c, roughness: 0.36, metalness: 0.85, normalMap: TEX.gunNoise.normalMap, normalScale: new THREE.Vector2(0.3, 0.3) }),
  steel: vmMat({ color: 0x5c6066, roughness: 0.26, metalness: 0.95 }),
  tube: vmMat({ color: 0x222428, roughness: 0.4, metalness: 0.8, side: THREE.DoubleSide }),
  fde: vmMat({ color: 0x8c7654, roughness: 0.6, metalness: 0.08, normalMap: TEX.gunNoise.normalMap, normalScale: new THREE.Vector2(0.5, 0.5) }),
  olive: vmMat({ color: 0x46503a, roughness: 0.8, metalness: 0.05, normalMap: TEX.camo.normalMap }),
  glove: vmMat({ color: 0x2c2926, roughness: 0.82, metalness: 0.02, normalMap: TEX.gunNoise.normalMap, envMapIntensity: 0.25 }),
  knuckle: vmMat({ color: 0x1a1918, roughness: 0.6, metalness: 0.1 }),
  sleeve: vmMat({ color: 0xc8c8c0, map: TEX.camo.map, normalMap: TEX.camo.normalMap, roughness: 0.95, envMapIntensity: 0.2 }),
  lens: vmMat({ color: 0x0b1420, roughness: 0.04, metalness: 1.0, envMapIntensity: 1.6 }),
  glass: vmMat({ color: 0x6a8aa8, roughness: 0.02, metalness: 0.6, transparent: true, opacity: 0.18, depthWrite: false }),
  brass: vmMat({ color: 0xd8a848, roughness: 0.3, metalness: 0.95 }),
  blade: vmMat({ color: 0x9aa0a8, roughness: 0.18, metalness: 1.0, envMapIntensity: 1.2 })
};
const VM_DOT = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.08, 0.05).multiplyScalar(14), toneMapped: false });
const VM_TRITIUM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1, 0.35).multiplyScalar(3) });
const VM_LASER = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.1, 0.06).multiplyScalar(6), toneMapped: false });
const VM_FLASH = new THREE.MeshBasicMaterial({ map: TEX.flash, color: new THREE.Color(1, 0.8, 0.5).multiplyScalar(6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

// ---- the gun's own little world ----
const gunScene = new THREE.Scene();
gunScene.add(gunCamera);
const gunKey = new THREE.DirectionalLight(0xffc49a, 1.2 * LIGHT_COMPAT);
const gunFill = new THREE.HemisphereLight(0x8a9ac0, 0x2a2420, 0.55 * LIGHT_COMPAT);
gunScene.add(gunKey); gunScene.add(gunKey.target); gunScene.add(gunFill);
const _gunInvQ = new THREE.Quaternion();
// The key light follows the real sun direction in view space, so turning away
// from the sun puts the gun in its own shade.
function updateGunLighting() {
  _gunInvQ.copy(camera.quaternion).invert();
  gunKey.position.copy(SUN_SKY_DIR).applyQuaternion(_gunInvQ).multiplyScalar(5);
  gunKey.target.position.set(0, 0, 0);
}

// ---- primitive helpers ----
function vmBox(parent, w, h, d, x, y, z, mat, rx, ry, rz) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
  parent.add(m);
  return m;
}
// cylinder along z by default; r2 tapers it
function vmCyl(parent, r, len, x, y, z, mat, seg, r2, axis, open) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2 === undefined ? r : r2, r, len, seg || 14, 1, !!open), mat);
  if (axis === 'y') { /* native */ } else if (axis === 'x') m.rotation.z = Math.PI / 2; else m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
const _lA = new THREE.Vector3(), _lB = new THREE.Vector3(), _lY = new THREE.Vector3(0, 1, 0);
function vmLimb(parent, ax, ay, az, bx, by, bz, r0, r1, mat) {
  _lA.set(ax, ay, az); _lB.set(bx, by, bz);
  const len = _lA.distanceTo(_lB);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 12), mat);
  m.position.copy(_lA).add(_lB).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_lY, _lB.sub(_lA).normalize());
  parent.add(m);
  return m;
}
function vmRail(parent, len, x, y, z) {
  vmBox(parent, 0.024, 0.008, len, x, y, z, VMAT.metal);
  const n = Math.floor(len / 0.012);
  for (let i = 0; i < n; i++) vmBox(parent, 0.028, 0.006, 0.005, x, y + 0.006, z - len / 2 + (i + 0.5) * (len / n), VMAT.metal);
}
// Gloved hand gripping around a vertical-ish grip. side: 1 right, -1 left
function vmHand(parent, x, y, z, side, rx, rz) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.set(rx || 0, 0, rz || 0);
  vmBox(g, 0.03, 0.075, 0.07, side * 0.028, 0, 0.005, VMAT.glove);
  for (let i = 0; i < 4; i++) {
    vmBox(g, 0.05, 0.016, 0.022, -side * 0.004, 0.027 - i * 0.018, -0.038, VMAT.glove);
    vmBox(g, 0.012, 0.014, 0.018, -side * 0.028, 0.027 - i * 0.018, -0.03, VMAT.knuckle);
  }
  vmBox(g, 0.02, 0.02, 0.05, -side * 0.028, 0.035, 0.012, VMAT.glove, 0.4, 0, 0);
  vmBox(g, 0.05, 0.035, 0.05, side * 0.012, -0.045, 0.03, VMAT.glove);
  parent.add(g);
  return g;
}
function vmForearm(parent, wx, wy, wz, ex, ey, ez) {
  vmLimb(parent, wx, wy, wz, ex, ey, ez, 0.034, 0.042, VMAT.sleeve);
  vmLimb(parent, wx, wy, wz, wx + (ex - wx) * 0.12, wy + (ey - wy) * 0.12, wz + (ez - wz) * 0.12, 0.036, 0.036, VMAT.glove);
}
function vmFlash(parent, z, y) {
  const g = new THREE.Group();
  g.position.set(0, y, z);
  const pg = new THREE.PlaneGeometry(0.16, 0.34);
  for (let i = 0; i < 2; i++) {
    const p = new THREE.Mesh(pg, VM_FLASH);
    p.rotation.set(Math.PI / 2, 0, i * Math.PI / 2);
    p.rotation.order = 'ZXY';
    p.position.z = -0.14;
    g.add(p);
  }
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), VM_FLASH));
  g.visible = false;
  parent.add(g);
  return g;
}
// Magazine: a curved stack of segments inside a group whose origin is the mag well.
function vmCurvedMag(parent, x, y, z, w, segs, segH, depth, curve, mat) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  for (let i = 0; i < segs; i++) {
    const s = vmBox(g, w, segH + 0.004, depth, 0, -segH / 2 - i * segH, -i * curve * 0.5, mat);
    s.rotation.x = -i * curve;
  }
  vmBox(g, w + 0.006, 0.012, depth + 0.006, 0, -segs * segH - 0.004, -(segs - 1) * curve * 0.5, mat);
  parent.add(g);
  return g;
}

// ---- optics (return the sight line: y and the eye-relief z of the rear aperture) ----
function vmIrons(g, frontZ, rearZ, railY) {
  vmBox(g, 0.014, 0.03, 0.014, 0, railY + 0.02, frontZ, VMAT.metal);           // front sight tower
  vmBox(g, 0.003, 0.012, 0.003, 0, railY + 0.041, frontZ, VMAT.metal);          // post
  const tri = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 6, 4), VM_TRITIUM);
  tri.position.set(0, railY + 0.047, frontZ); g.add(tri);
  vmBox(g, 0.03, 0.026, 0.018, 0, railY + 0.018, rearZ, VMAT.metal);            // rear aperture housing
  vmBox(g, 0.008, 0.014, 0.02, -0.008, railY + 0.036, rearZ, VMAT.metal);
  vmBox(g, 0.008, 0.014, 0.02, 0.008, railY + 0.036, rearZ, VMAT.metal);
  return { y: railY + 0.047, z: rearZ };
}
function vmRedDot(g, z, railY) {
  vmBox(g, 0.03, 0.014, 0.05, 0, railY + 0.012, z, VMAT.metal);
  vmCyl(g, 0.019, 0.05, 0, railY + 0.04, z, VMAT.tube, 16, undefined, 'z', true);
  const glassM = vmCyl(g, 0.017, 0.002, 0, railY + 0.04, z - 0.024, VMAT.glass, 16);
  glassM.renderOrder = 5;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0008, 8, 6), VM_DOT);
  dot.position.set(0, railY + 0.04, z - 0.02); g.add(dot);
  vmBox(g, 0.012, 0.012, 0.012, 0.022, railY + 0.04, z, VMAT.metal);
  return { y: railY + 0.04, z: z + 0.025 };
}
function vmAcog(g, z, railY) {
  const y = railY + 0.04;
  vmCyl(g, 0.02, 0.13, 0, y, z, VMAT.tube, 16, undefined, 'z', true);
  vmCyl(g, 0.026, 0.04, 0, y, z - 0.08, VMAT.tube, 16, 0.02, 'z', true);
  vmCyl(g, 0.022, 0.03, 0, y, z + 0.075, VMAT.tube, 16, undefined, 'z', true);
  const lens = vmCyl(g, 0.024, 0.002, 0, y, z - 0.1, VMAT.glass, 16); lens.renderOrder = 5;
  vmBox(g, 0.03, 0.022, 0.08, 0, railY + 0.017, z, VMAT.metal);
  vmBox(g, 0.008, 0.008, 0.06, 0, y + 0.024, z, VM_TRITIUM);                     // fibre on top
  const chev = new THREE.Mesh(new THREE.ConeGeometry(0.0022, 0.004, 3), VM_DOT);
  chev.scale.setScalar(0.5); chev.position.set(0, y - 0.0007, z - 0.05); g.add(chev);
  return { y: y, z: z + 0.075 };
}
// ---- barrel / underbarrel / stock / magazine attachments ----
function vmMuzzleDevice(g, att, z, y, baseLen) {
  if (att.barrel === 'suppressor') {
    vmCyl(g, 0.02, 0.17, 0, y, z - 0.085, VMAT.metal, 16);
    vmCyl(g, 0.021, 0.015, 0, y, z - 0.172, VMAT.steel, 16);
    return z - 0.18;
  }
  const extra = att.barrel === 'longbarrel' ? 0.1 : 0;
  if (extra) vmCyl(g, 0.009, extra, 0, y, z - extra / 2, VMAT.steel);
  const hz = z - extra;
  vmCyl(g, 0.013, baseLen, 0, y, hz - baseLen / 2, VMAT.metal, 8);
  for (let i = 0; i < 4; i++) vmBox(g, 0.004, 0.028, 0.03, 0, y, hz - baseLen / 2, VMAT.knuckle, 0, 0, i * Math.PI / 4);
  return hz - baseLen;
}
function vmUnder(g, P, att, z, y) {
  if (att.under === 'foregrip') {
    vmBox(g, 0.024, 0.075, 0.03, 0, y - 0.04, z, VMAT.polymer, -0.15);
    return { gripZ: z, gripY: y - 0.05 };
  }
  if (att.under === 'laser') {
    vmBox(g, 0.026, 0.024, 0.05, 0.03, y + 0.004, z, VMAT.polymer);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0009, 0.0009, 6, 5, 1, true), VM_LASER);
    beam.rotation.x = Math.PI / 2; beam.position.set(0.03, y + 0.004, z - 3.03);
    g.add(beam);
    const emit = new THREE.Mesh(new THREE.SphereGeometry(0.003, 8, 6), VM_LASER);
    emit.position.set(0.03, y + 0.004, z - 0.026); g.add(emit);
    P.laser = beam;
  }
  return null;
}

// ---- weapon models. Each returns tuning: sight line, muzzle, hip pose, kick ----
function vmBuildAR(g, P, att, fde) {
  const R = fde ? VMAT.fde : VMAT.polymer;
  vmBox(g, 0.05, 0.05, 0.27, 0, 0.032, -0.07, VMAT.metal);                    // upper receiver
  vmBox(g, 0.046, 0.045, 0.2, 0, -0.012, -0.03, R);                           // lower receiver
  vmBox(g, 0.012, 0.03, 0.05, 0.028, 0.03, -0.05, VMAT.metal);                // ejection port cover
  vmBox(g, 0.02, 0.018, 0.035, 0.03, 0.04, 0.03, VMAT.steel);                 // forward assist
  vmRail(g, 0.25, 0, 0.061, -0.08);
  vmBox(g, 0.056, 0.056, 0.25, 0, 0.028, -0.33, R);                           // handguard
  for (let i = 0; i < 5; i++) for (const sx of [-1, 1]) vmBox(g, 0.004, 0.012, 0.03, sx * 0.029, 0.03, -0.25 - i * 0.045, VMAT.knuckle);
  vmRail(g, 0.22, 0, 0.061, -0.33);
  vmCyl(g, 0.009, 0.16, 0, 0.03, -0.53, VMAT.steel);                          // barrel
  vmCyl(g, 0.014, 0.012, 0, 0.03, -0.47, VMAT.metal);                         // gas block
  const muzzleZ = vmMuzzleDevice(g, att, -0.61, 0.03, 0.055);
  // stock: buffer tube + collapsible stock (heavy = padded, light = skeleton)
  vmCyl(g, 0.015, 0.14, 0, 0.022, 0.13, VMAT.metal);
  if (att.stock === 'lightstock') {
    vmBox(g, 0.01, 0.07, 0.11, 0, -0.002, 0.2, R);
    vmBox(g, 0.042, 0.012, 0.11, 0, 0.03, 0.2, R);
  } else {
    vmBox(g, 0.042, 0.075, 0.13, 0, 0.0, 0.2, R);
    if (att.stock === 'heavystock') vmBox(g, 0.046, 0.03, 0.12, 0, 0.05, 0.2, VMAT.olive);   // cheek riser
  }
  vmBox(g, 0.046, 0.085, 0.02, 0, -0.002, 0.27, VMAT.knuckle);
  vmBox(g, 0.032, 0.095, 0.042, 0, -0.075, 0.04, R, 0.28);                    // pistol grip
  vmBox(g, 0.008, 0.006, 0.07, 0, -0.045, -0.01, VMAT.metal);                 // trigger guard
  vmBox(g, 0.004, 0.02, 0.006, 0, -0.03, -0.012, VMAT.steel, 0.3);            // trigger
  const segs = att.mag === 'extmag' ? 7 : att.mag === 'fastmag' ? 4 : 5;
  P.mag = vmCurvedMag(g, 0, -0.035, -0.07, 0.034, segs, 0.03, 0.06, 0.07, VMAT.metal);
  if (att.mag === 'fastmag') vmBox(P.mag, 0.012, 0.03, 0.02, 0, -segs * 0.03 - 0.02, 0, VMAT.olive);   // pull tab
  P.bolt = vmBox(g, 0.04, 0.012, 0.03, 0, 0.055, 0.06, VMAT.metal);            // charging handle
  P.boltRest = 0.06;
  let sight;
  if (att.optic === 'reddot') sight = vmRedDot(g, -0.05, 0.061);
  else if (att.optic === 'scope4x') sight = vmAcog(g, -0.07, 0.061);
  else sight = vmIrons(g, -0.43, 0.02, 0.061);
  const grip = vmUnder(g, P, att, -0.33, 0.0);
  P.handR = vmHand(g, 0, -0.07, 0.04, 1, 0.28);
  vmForearm(g, 0.02, -0.12, 0.07, 0.1, -0.24, 0.38);
  P.handL = new THREE.Group(); g.add(P.handL);
  if (grip) {
    vmHand(P.handL, 0, grip.gripY, grip.gripZ + 0.01, -1, 0.15, 0);
    vmForearm(P.handL, -0.01, grip.gripY - 0.05, grip.gripZ + 0.03, -0.12, -0.34, -0.02);
  } else {
    vmHand(P.handL, -0.005, -0.012, -0.34, -1, 1.2, 0.1);
    vmForearm(P.handL, -0.03, -0.05, -0.31, -0.13, -0.34, -0.04);
  }
  return { sightY: sight.y, sightZ: sight.z, muzzleZ: muzzleZ, muzzleY: 0.03, hip: [0.15, -0.14, -0.36], kick: 0.9 };
}
function vmBuildSMG(g, P, att) {
  const R = VMAT.polymer;
  vmBox(g, 0.048, 0.075, 0.26, 0, 0.02, -0.08, R);                            // boxy upper
  vmBox(g, 0.046, 0.08, 0.12, 0, -0.035, -0.11, R, -0.35);                    // angled lower
  vmRail(g, 0.24, 0, 0.061, -0.09);
  vmCyl(g, 0.012, 0.06, 0, 0.03, -0.24, VMAT.metal, 12);                      // barrel shroud
  const muzzleZ = att.barrel === 'suppressor' ? vmMuzzleDevice(g, att, -0.27, 0.03, 0.04)
    : vmMuzzleDevice(g, att, -0.27, 0.03, 0.04);
  vmCyl(g, 0.015, 0.12, 0, 0.022, 0.1, VMAT.metal);                           // folding stock tube
  if (att.stock !== 'lightstock') vmBox(g, 0.03, 0.07, 0.1, 0, 0.0, 0.17, R);
  else vmBox(g, 0.012, 0.06, 0.08, 0, 0.0, 0.17, R);
  if (att.stock === 'heavystock') vmBox(g, 0.034, 0.028, 0.09, 0, 0.045, 0.17, VMAT.olive);
  vmBox(g, 0.03, 0.09, 0.04, 0, -0.07, 0.03, R, 0.22);                        // grip
  vmBox(g, 0.03, 0.02, 0.07, 0, -0.03, -0.2, R);                              // front grip mount
  const segs = att.mag === 'extmag' ? 6 : att.mag === 'fastmag' ? 3 : 4;
  P.mag = vmCurvedMag(g, 0, -0.06, -0.03, 0.03, segs, 0.03, 0.045, 0.0, VMAT.polymer);
  P.bolt = vmBox(g, 0.012, 0.018, 0.03, -0.028, 0.035, 0.0, VMAT.steel); P.boltRest = 0.0;
  let sight;
  if (att.optic === 'scope4x') sight = vmAcog(g, -0.08, 0.061);
  else if (att.optic === 'reddot') {
    // holographic: open window, ring + dot
    vmBox(g, 0.04, 0.012, 0.07, 0, 0.068, -0.07, VMAT.metal);
    vmBox(g, 0.006, 0.04, 0.07, 0.022, 0.092, -0.07, VMAT.metal); vmBox(g, 0.006, 0.04, 0.07, -0.022, 0.092, -0.07, VMAT.metal);
    vmBox(g, 0.05, 0.006, 0.07, 0, 0.114, -0.07, VMAT.metal);
    const gl = vmBox(g, 0.038, 0.034, 0.002, 0, 0.093, -0.09, VMAT.glass); gl.renderOrder = 5;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0006, 4, 24), VM_DOT);
    ring.scale.setScalar(0.3); ring.position.set(0, 0.093, -0.088); g.add(ring);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.00035, 6, 4), VM_DOT); dot.position.set(0, 0.093, -0.088); g.add(dot);
    sight = { y: 0.093, z: -0.035 };
  } else sight = vmIrons(g, -0.2, 0.03, 0.061);
  const grip = vmUnder(g, P, att, -0.21, -0.03) || { gripZ: -0.21, gripY: -0.07 };
  if (att.under !== 'foregrip') vmBox(g, 0.022, 0.07, 0.03, 0, -0.07, -0.21, R, -0.2);   // stock vertical grip
  P.handR = vmHand(g, 0, -0.065, 0.03, 1, 0.22);
  vmForearm(g, 0.02, -0.115, 0.06, 0.1, -0.24, 0.38);
  P.handL = new THREE.Group(); g.add(P.handL);
  vmHand(P.handL, 0, grip.gripY, grip.gripZ, -1, 0.2, 0);
  vmForearm(P.handL, -0.01, grip.gripY - 0.05, grip.gripZ + 0.02, -0.12, -0.36, 0.0);
  return { sightY: sight.y, sightZ: sight.z, muzzleZ: muzzleZ, muzzleY: 0.03, hip: [0.14, -0.13, -0.33], kick: 0.6 };
}
function vmBuildBR(g, P, att) {
  // an FDE battle rifle on the AR chassis: longer barrel, big brake, ACOG by default
  const opt = att.optic === 'reddot' ? 'reddot' : 'scope4x';
  const a2 = Object.assign({}, att, { optic: opt, barrel: att.barrel === 'suppressor' ? 'suppressor' : 'none' });
  const t = vmBuildAR(g, P, a2, true);
  if (att.barrel !== 'suppressor') {
    const extra = att.barrel === 'longbarrel' ? 0.2 : 0.1;
    vmCyl(g, 0.01, extra, 0, 0.03, t.muzzleZ - extra / 2, VMAT.steel);
    vmCyl(g, 0.017, 0.07, 0, 0.03, t.muzzleZ - extra - 0.035, VMAT.metal, 8);
    for (let i = 0; i < 3; i++) for (const sx of [-1, 1]) vmBox(g, 0.004, 0.012, 0.012, sx * 0.016, 0.03, t.muzzleZ - extra - 0.02 - i * 0.017, VMAT.knuckle);
    t.muzzleZ -= extra + 0.07;
  }
  t.kick = 1.3;
  return t;
}
function vmBuildSR(g, P, att) {
  // chassis stock: fore-end with M-LOK slots, grip, adjustable cheek riser, butt spacers
  vmBox(g, 0.056, 0.06, 0.42, 0, -0.008, -0.3, VMAT.olive);
  for (let i = 0; i < 5; i++) for (const sx of [-1, 1]) vmBox(g, 0.003, 0.012, 0.035, sx * 0.0285, -0.01, -0.18 - i * 0.055, VMAT.knuckle);
  vmBox(g, 0.024, 0.008, 0.2, 0, -0.042, -0.33, VMAT.metal);
  vmBox(g, 0.05, 0.04, 0.2, 0, -0.018, -0.02, VMAT.olive);
  vmBox(g, 0.034, 0.1, 0.05, 0, -0.085, 0.05, VMAT.olive, 0.35);
  for (let i = 0; i < 4; i++) vmBox(g, 0.036, 0.004, 0.052, 0, -0.06 - i * 0.02, 0.058 + i * 0.006, VMAT.knuckle, 0.35);
  vmBox(g, 0.008, 0.006, 0.07, 0, -0.045, -0.005, VMAT.metal);
  vmBox(g, 0.004, 0.018, 0.006, 0, -0.032, -0.01, VMAT.steel, 0.3);
  vmBox(g, 0.046, 0.075, 0.2, 0, -0.03, 0.18, VMAT.olive);
  vmBox(g, 0.03, 0.03, 0.06, 0, -0.012, 0.08, VMAT.metal);
  vmBox(g, 0.044, att.stock === 'heavystock' ? 0.04 : 0.028, 0.13, 0, 0.034, 0.17, VMAT.olive);
  for (const z of [0.13, 0.21]) vmCyl(g, 0.005, 0.03, 0, 0.014, z, VMAT.steel, 8, undefined, 'y');
  vmCyl(g, 0.007, 0.012, 0.026, 0.02, 0.17, VMAT.steel, 8, undefined, 'x');
  vmBox(g, 0.05, 0.1, 0.012, 0, -0.035, 0.286, VMAT.metal);
  vmBox(g, 0.052, 0.105, 0.02, 0, -0.035, 0.302, VMAT.knuckle);
  vmCyl(g, 0.006, 0.01, 0, -0.07, 0.24, VMAT.steel, 8, undefined, 'x');
  vmCyl(g, 0.006, 0.01, 0, -0.045, -0.46, VMAT.steel, 8, undefined, 'x');
  // round receiver + bolt shroud
  vmCyl(g, 0.02, 0.22, 0, 0.03, -0.06, VMAT.metal, 18);
  vmCyl(g, 0.017, 0.035, 0, 0.03, 0.065, VMAT.metal, 16);
  vmBox(g, 0.012, 0.022, 0.06, 0.02, 0.036, -0.05, VMAT.knuckle);
  vmRail(g, 0.2, 0, 0.056, -0.07);
  // fluted barrel + ported brake (or a can)
  const bl = att.barrel === 'longbarrel' ? 0.56 : 0.46;
  vmCyl(g, 0.012, bl, 0, 0.03, -0.17 - bl / 2, VMAT.metal, 16, 0.0095);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    vmBox(g, 0.003, 0.003, bl * 0.65, Math.cos(a) * 0.0105, 0.03 + Math.sin(a) * 0.0105, -0.21 - bl * 0.5, VMAT.knuckle);
  }
  let muzzleZ = -0.17 - bl;
  if (att.barrel === 'suppressor') {
    vmCyl(g, 0.022, 0.2, 0, 0.03, muzzleZ - 0.1, VMAT.metal, 16);
    muzzleZ -= 0.2;
  } else {
    vmCyl(g, 0.017, 0.08, 0, 0.03, muzzleZ - 0.04, VMAT.metal, 8);
    for (let i = 0; i < 3; i++) for (const sx of [-1, 1]) vmBox(g, 0.004, 0.012, 0.012, sx * 0.016, 0.03, muzzleZ - 0.015 - i * 0.02, VMAT.knuckle);
    muzzleZ -= 0.08;
  }
  // detachable magazine
  P.mag = new THREE.Group(); P.mag.position.set(0, -0.04, -0.05); g.add(P.mag);
  vmBox(P.mag, 0.036, att.mag === 'extmag' ? 0.075 : 0.05, 0.08, 0, att.mag === 'extmag' ? -0.037 : -0.025, 0, VMAT.metal);
  vmBox(P.mag, 0.04, 0.008, 0.086, 0, att.mag === 'extmag' ? -0.077 : -0.052, 0, VMAT.polymer);
  // bolt: handle lifts, body slides back
  P.bolt = new THREE.Group(); P.bolt.position.set(0.02, 0.03, 0.02); g.add(P.bolt);
  vmCyl(P.bolt, 0.006, 0.05, 0.022, 0, 0, VMAT.steel, 8, 0.006, 'x');
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.018, 10), VMAT.polymer);
  knob.rotation.z = Math.PI / 2; knob.position.set(0.048, -0.004, 0); P.bolt.add(knob);
  vmCyl(P.bolt, 0.01, 0.05, -0.02, 0.0, -0.02, VMAT.steel, 12);
  P.boltRest = 0.02;
  // scope: tube, bell + sunshade, eyepiece, turrets, parallax knob, rings, flip caps
  vmCyl(g, 0.017, 0.26, 0, 0.1, -0.09, VMAT.metal, 20);
  vmCyl(g, 0.03, 0.07, 0, 0.1, -0.265, VMAT.metal, 20, 0.017);
  vmCyl(g, 0.03, 0.06, 0, 0.1, -0.33, VMAT.metal, 20);
  const lensF = vmCyl(g, 0.027, 0.003, 0, 0.1, -0.36, VMAT.lens, 20); lensF.renderOrder = 4;
  vmCyl(g, 0.021, 0.05, 0, 0.1, 0.06, VMAT.metal, 18, 0.017);
  vmCyl(g, 0.024, 0.03, 0, 0.1, 0.095, VMAT.polymer, 18);
  const lensR = vmCyl(g, 0.021, 0.002, 0, 0.1, 0.11, VMAT.lens, 18); lensR.renderOrder = 4;
  vmCyl(g, 0.012, 0.032, 0, 0.132, -0.1, VMAT.metal, 16, undefined, 'y');
  vmCyl(g, 0.0125, 0.008, 0, 0.143, -0.1, VMAT.knuckle, 16, undefined, 'y');
  vmCyl(g, 0.012, 0.032, 0.032, 0.1, -0.1, VMAT.metal, 16, undefined, 'x');
  vmCyl(g, 0.011, 0.026, -0.03, 0.1, -0.1, VMAT.metal, 16, undefined, 'x');
  for (const z of [-0.02, -0.18]) {
    vmCyl(g, 0.021, 0.018, 0, 0.1, z, VMAT.metal, 18);
    vmBox(g, 0.02, 0.05, 0.018, 0, 0.068, z, VMAT.metal);
    vmCyl(g, 0.003, 0.012, 0.024, 0.1, z, VMAT.steel, 6, undefined, 'x');
  }
  const capF = vmBox(g, 0.06, 0.004, 0.06, 0, 0.132, -0.362, VMAT.polymer, 1.3); capF.position.y = 0.14;
  vmBox(g, 0.045, 0.004, 0.045, 0.032, 0.12, 0.112, VMAT.polymer, 0, 0, 1.2);
  // folded bipod
  vmBox(g, 0.03, 0.02, 0.04, 0, -0.05, -0.48, VMAT.metal);
  vmBox(g, 0.01, 0.01, 0.18, -0.016, -0.058, -0.39, VMAT.metal); vmBox(g, 0.01, 0.01, 0.18, 0.016, -0.058, -0.39, VMAT.metal);
  vmUnder(g, P, att.under === 'laser' ? att : {}, -0.3, -0.01);
  P.handR = vmHand(g, 0, -0.082, 0.05, 1, 0.35);
  vmForearm(g, 0.02, -0.13, 0.08, 0.1, -0.25, 0.38);
  P.handL = new THREE.Group(); g.add(P.handL);
  vmHand(P.handL, 0, -0.04, -0.32, -1, 1.1, 0.05);
  vmForearm(P.handL, -0.02, -0.08, -0.29, -0.13, -0.36, -0.03);
  return { sightY: 0.1, sightZ: 0.11, muzzleZ: muzzleZ, muzzleY: 0.03, hip: [0.16, -0.15, -0.38], kick: 2.2 };
}
// Knife (melee): its own arm, shown only while slashing.
let knifeGroup = null;
function buildKnife() {
  knifeGroup = new THREE.Group();
  const k = new THREE.Group(); knifeGroup.add(k);
  vmBox(k, 0.004, 0.028, 0.16, 0, 0.0, -0.12, VMAT.blade);
  vmBox(k, 0.005, 0.012, 0.05, 0, 0.012, -0.23, VMAT.blade, -0.35);
  vmBox(k, 0.03, 0.012, 0.012, 0, 0, -0.035, VMAT.metal);
  vmBox(k, 0.022, 0.026, 0.1, 0, -0.002, 0.02, VMAT.polymer);
  vmHand(k, 0, -0.005, 0.02, 1, 1.35);
  vmForearm(k, 0.01, -0.04, 0.06, 0.09, -0.2, 0.34);
  knifeGroup.visible = false;
  gunCamera.add(knifeGroup);
}

// Build the model for a weapon type and loadout into `g`; P collects the parts
// that animate. Returns the tuning block the pose code reads.
function buildGunModel(g, P, type, att) {
  const builders = { AR: vmBuildAR, SMG: vmBuildSMG, BR: vmBuildBR, SR: vmBuildSR };
  const tune = (builders[type] || vmBuildAR)(g, P, att || {}, false);
  P.magRest = P.mag ? P.mag.position.clone() : null;
  P.handLRest = P.handL ? P.handL.position.clone() : null;
  P.muzzle = new THREE.Object3D();
  P.muzzle.position.set(0, tune.muzzleY, tune.muzzleZ);
  g.add(P.muzzle);
  if (!knifeGroup) buildKnife();
  return tune;
}
function disposeGunModel(g) {
  // Materials are module-level and shared by every model; only geometry is per-build.
  g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
}

// ---- springs: look inertia, recoil ----
const vmSpring = { sx: 0, sy: 0, vx: 0, vy: 0, kz: 0, kvz: 0, kr: 0, kvr: 0, roll: 0, vroll: 0, tilt: 0, sprint: 0, tac: 0, slide: 0, mantle: 0, lastYaw: null, lastPitch: 0, boltT: 0, boltDur: 0 };
function kickViewmodel(w, tune) {
  const k = (tune ? tune.kick : 1) * (adsAmount > 0.5 ? 0.6 : 1) * Math.max(0.6, Math.min(1.3, w.recoilV / 0.014 * 0.5 + 0.5));
  vmSpring.kvz += 2.2 * k;
  vmSpring.kvr += 7.5 * k;
  vmSpring.vroll += (Math.random() - 0.5) * 6 * k;
  if (w.type === 'SR') { vmSpring.boltDur = Math.min(0.95, 60 / w.rpm * 0.75); vmSpring.boltT = vmSpring.boltDur + 0.12; }
}
// Semi-implicit Euler in fixed 1/120 s substeps: stiff springs stay stable even
// when a hitch hands over the 0.1 s maximum frame step. Pure implementation in CORE.
const _springOut = [0, 0];
function stepSpring(x, v, target, k, c, dt) {
  return CORE.stepSpring(x, v, target, k, c, dt, _springOut);
}
function vmSmooth(a, b, x) { return CORE.vmSmooth(a, b, x); }
function vmBump(a, b, x) { return CORE.vmBump(a, b, x); }
function wrapAngle(a) { return CORE.wrapAngle(a); }

// Pose the gun for this frame. Inputs are the game's live state; output is the
// gunGroup transform plus the animated parts.
function poseViewmodel(dt, g, P, tune, w, s, reducedMotion) {
  const ads = adsAmount * adsAmount * (3 - 2 * adsAmount);
  const hipK = 1 - ads;
  const motion = reducedMotion ? 0.35 : 1;
  // base pose: hip -> sight line on the screen centre
  const adsZ = -0.16 - tune.sightZ;
  let px = tune.hip[0] * hipK;
  let py = tune.hip[1] + (-tune.sightY - tune.hip[1]) * ads;
  let pz = tune.hip[2] + (adsZ - tune.hip[2]) * ads;
  let rx = 0, ry = -0.02 * hipK, rz = 0;
  // look inertia: the gun lags the view, normalised to a 60 Hz frame
  if (vmSpring.lastYaw === null) { vmSpring.lastYaw = player.yaw; vmSpring.lastPitch = player.pitch; }
  const norm = dt > 0 ? (1 / 60) / dt : 0;
  const lookDX = wrapAngle(player.yaw - vmSpring.lastYaw) * norm;
  const lookDY = (player.pitch - vmSpring.lastPitch) * norm;
  vmSpring.lastYaw = player.yaw; vmSpring.lastPitch = player.pitch;
  const tx = Math.max(-0.05, Math.min(0.05, lookDX * 1.6)) * (1 - ads * 0.75) * motion;
  const ty = Math.max(-0.05, Math.min(0.05, -lookDY * 1.6)) * (1 - ads * 0.75) * motion;
  let r = stepSpring(vmSpring.sx, vmSpring.vx, tx, 90, 11, dt); vmSpring.sx = r[0]; vmSpring.vx = r[1];
  r = stepSpring(vmSpring.sy, vmSpring.vy, ty, 90, 11, dt); vmSpring.sy = r[0]; vmSpring.vy = r[1];
  px += vmSpring.sx * 0.6; py += vmSpring.sy * 0.5;
  ry += vmSpring.sx * 1.6; rx += vmSpring.sy * 1.4;
  // movement bob (figure eight), strafe tilt, idle breathing
  const bob = player.bobAmp * (player.sprinting ? 1.6 : 1) * (1 - ads * 0.88) * motion;
  px += Math.sin(player.bobPhase) * 0.012 * bob;
  py += -Math.abs(Math.cos(player.bobPhase)) * 0.012 * bob;
  rz += Math.sin(player.bobPhase) * 0.02 * bob;
  const latV = player.vel.x * Math.cos(player.yaw) - player.vel.z * Math.sin(player.yaw);
  vmSpring.tilt += (-latV * 0.012 * (1 - ads * 0.7) * motion - vmSpring.tilt) * Math.min(1, 8 * dt);
  rz += vmSpring.tilt;
  py += Math.sin(gameT * 1.7) * 0.0022 * hipK * motion;
  rx += Math.sin(gameT * 1.3) * 0.004 * hipK * motion;
  // marksman breath sway rides the scope
  if (w.type === 'SR') { px += swayX * (1 - ads * 0.5); py += swayY * (1 - ads * 0.5); }
  // sprint / tactical sprint (high ready, muzzle up) / slide cant
  const tac = player.tacT > 0 && !player.sliding ? 1 : 0;
  const sprint = player.sprinting && !player.sliding && !tac ? 1 : 0;
  vmSpring.sprint += (sprint - vmSpring.sprint) * Math.min(1, 9 * dt);
  vmSpring.tac += (tac - vmSpring.tac) * Math.min(1, 10 * dt);
  vmSpring.slide += ((player.sliding ? 1 : 0) - vmSpring.slide) * Math.min(1, 10 * dt);
  const sp = vmSpring.sprint * hipK, tk = vmSpring.tac * hipK, sl = vmSpring.slide * hipK;
  px += 0.04 * sp; py -= 0.05 * sp; ry += 0.55 * sp; rz += 0.3 * sp; rx += -0.12 * sp;
  px -= 0.05 * tk; py += 0.03 * tk; pz += 0.04 * tk; rx += 0.95 * tk; rz -= 0.25 * tk; ry += 0.2 * tk;
  px -= 0.03 * sl; py -= 0.02 * sl; rz += 0.35 * sl;
  // recoil springs
  r = stepSpring(vmSpring.kz, vmSpring.kvz, 0, 260, 20, dt); vmSpring.kz = r[0]; vmSpring.kvz = r[1];
  r = stepSpring(vmSpring.kr, vmSpring.kvr, 0, 220, 17, dt); vmSpring.kr = r[0]; vmSpring.kvr = r[1];
  r = stepSpring(vmSpring.roll, vmSpring.vroll, 0, 160, 14, dt); vmSpring.roll = r[0]; vmSpring.vroll = r[1];
  pz += vmSpring.kz * 0.05; py += vmSpring.kr * 0.004; rx += vmSpring.kr * 0.05; rz += vmSpring.roll * 0.03;
  // weapon raise after a switch
  const raise = 1 - gunSwitchT;
  py -= raise * raise * 0.3; rx -= raise * 0.6;
  // mantle: gun tucked away while climbing
  vmSpring.mantle = player.mantleT > 0 ? Math.min(1, vmSpring.mantle + dt * 8) : Math.max(0, vmSpring.mantle - dt * 5);
  py -= vmSpring.mantle * 0.18; rz += vmSpring.mantle * 0.5; rx -= vmSpring.mantle * 0.3;

  // reload choreography: tilt, mag out / in, support hand fetches the fresh one
  if (P.mag && P.magRest) { P.mag.position.copy(P.magRest); P.mag.visible = true; }
  if (P.handL && P.handLRest) { P.handL.position.copy(P.handLRest); P.handL.rotation.set(0, 0, 0); }
  let boltBack = 0, boltLift = 0;
  if (s && s.reloading) {
    const dur = w.reload * CORE.perkReloadMul(perks);
    const p = Math.max(0, Math.min(1, s.reloadT / dur));
    const k = vmBump(0, 1, p);
    rz += 0.42 * k; rx += 0.18 * k; py -= 0.05 * k; px -= 0.02 * k;
    if (P.mag && P.magRest) {
      const out = vmSmooth(0.1, 0.3, p), inn = vmSmooth(0.45, 0.65, p);
      const off = p < 0.45 ? out : 1 - inn;
      P.mag.position.y -= off * 0.28; P.mag.position.z += off * 0.04;
      P.mag.visible = !(p > 0.3 && p < 0.45);
    }
    if (P.handL && P.handLRest) {
      const hk = vmBump(0.08, 0.72, p);
      const target = P.magRest ? P.magRest : P.handLRest;
      P.handL.position.x += (target.x - P.handLRest.x - 0.01) * hk * 0.9;
      P.handL.position.y += -0.12 * hk;
      P.handL.position.z += (target.z - P.handLRest.z + 0.15) * hk * 0.9;
    }
    if (s.ammo === 0) {
      boltBack = vmBump(0.78, 0.94, p);
      if (w.type === 'SR') boltLift = vmBump(0.74, 0.98, p);
    }
  }
  // marksman bolt cycle after each shot: lift, back, forward, down
  if (vmSpring.boltT > 0) {
    vmSpring.boltT = Math.max(0, vmSpring.boltT - dt);
    if (vmSpring.boltT < vmSpring.boltDur) {
      const k = 1 - vmSpring.boltT / vmSpring.boltDur;
      boltLift = Math.max(boltLift, vmSmooth(0.0, 0.2, k) - vmSmooth(0.75, 0.95, k));
      boltBack = Math.max(boltBack, vmSmooth(0.2, 0.45, k) - vmSmooth(0.5, 0.75, k));
      rz += vmBump(0, 1, k) * 0.12 * hipK; py -= vmBump(0, 1, k) * 0.02;
    }
  }
  if (P.bolt) {
    if (w.type === 'SR') { P.bolt.rotation.z = boltLift * 1.1; P.bolt.position.z = P.boltRest + boltBack * 0.08; }
    else P.bolt.position.z = P.boltRest + boltBack * 0.07 + Math.min(1, shotKick) * 0.02;
  }
  // melee: gun ducks out, knife slashes across
  const mk = meleeSwing > 0 ? 1 - meleeSwing : 0;
  const gunOut = meleeSwing > 0 ? vmBump(0, 1, mk) : 0;
  py -= gunOut * 0.25; rx -= gunOut * 0.5; rz += gunOut * 0.4;
  if (knifeGroup) {
    knifeGroup.visible = meleeSwing > 0 && !player.dead;
    if (knifeGroup.visible) {
      const sw = vmSmooth(0.1, 0.45, mk);
      knifeGroup.position.set(0.22 - sw * 0.36, -0.12 + vmBump(0, 1, mk) * 0.06, -0.3);
      knifeGroup.rotation.set(-0.2, 0.9 - sw * 1.6, -0.9 + sw * 0.9);
    }
  }
  // narrow screens: pull the hip pose toward the centre so the gun stays on screen
  const asp = camera.aspect || 1;
  const narrow = Math.max(0, Math.min(1, (1.2 - asp) / 0.7));
  px -= px * 0.6 * narrow * hipK;
  g.position.set(px, py, pz);
  g.rotation.set(rx, ry, rz);
  if (P.laser) P.laser.visible = ads < 0.5;
  // the gun's lens narrows while aiming, for a magnified feel
  const gunFov = 58 - ads * (w.type === 'SR' ? 18 : 12);
  if (Math.abs(gunCamera.fov - gunFov) > 0.05) { gunCamera.fov = gunFov; gunCamera.updateProjectionMatrix(); }
  updateGunLighting();
}

// Muzzle position in world space. The gun is drawn by gunCamera with its own FOV,
// so its view-space offset is rescaled into the world camera's frustum first.
const _mzV = new THREE.Vector3();
function muzzleWorldPos(out) {
  if (!gunParts.muzzle || !gunGroup) return out.copy(camera.position);
  gunGroup.updateMatrixWorld(true);
  gunParts.muzzle.getWorldPosition(_mzV);
  const k = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(gunCamera.fov) / 2);
  _mzV.x *= k; _mzV.y *= k;
  camera.updateMatrixWorld();
  return out.copy(_mzV).applyMatrix4(camera.matrixWorld);
}
