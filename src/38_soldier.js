// ============ SOLDIER RIG: MODEL, PROCEDURAL ANIMATION, VERLET RAGDOLL ============
'use strict';
// Enemies are articulated soldiers built from smooth lathed shapes (rounded limbs,
// shaped torso, helmets, plate carriers, NVGs, boots, rifles). One template per
// archetype is built and merged per joint/material, then cloned for each enemy
// (shared geometry). Joints are animated procedurally (stride-synced gait, aim
// poses, melee, throws, hit-reaction springs). On death the joints hand over to a
// 15-particle Verlet ragdoll with elbow/knee hinges, anatomical limits and world
// collisions, run inside 45_ragdoll.js's budget and cleanup.
//
// Kinds follow 40_enemies.js: 0 runner, 1 rifleman, 2 tank, 3 shielded advancer,
// 4 scout, 5 grenadier. Each keeps the colour tell the archetype is known by.

// ---- materials ----
function sdMat(color, map, rough, metal, extra) {
  return new THREE.MeshStandardMaterial(Object.assign({ color: color, map: map || null, normalMap: map === TEX.camo.map ? TEX.camo.normalMap : null, roughness: rough === undefined ? 0.9 : rough, metalness: metal || 0 }, extra || {}));
}
const SDM = {
  skin: sdMat(0xa07a60, null, 0.75),
  mask: sdMat(0x1c1c1f, null, 0.95),
  glove: sdMat(0x23211f, null, 0.8),
  boot: sdMat(0x1a1714, null, 0.65),
  sole: sdMat(0x0c0c0c, null, 0.9),
  pouch: sdMat(0x3a3b2e, null, 0.92),
  strap: sdMat(0x262620, null, 0.9),
  gun: sdMat(0x1c1e22, null, 0.5, 0.55),
  gunMetal: sdMat(0x34373c, null, 0.3, 0.9),
  plate: sdMat(0x2c2f33, TEX.paint.map, 0.45, 0.6),
  visor: sdMat(0x07090c, null, 0.04, 1.0, { envMapIntensity: 1.4 }),
  lens: sdMat(0x0a0f14, null, 0.05, 1.0),
  nvg: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1, 0.3).multiplyScalar(2.6) }),
  slit: new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.12, 0.05).multiplyScalar(3.2) }),
  nade: sdMat(0x3a4a2e, null, 0.55, 0.3),
  blade: sdMat(0x9aa0a8, null, 0.2, 1.0)
};
// Indexed by enemy kind. The shielded, scout and grenadier kits carry the
// steel-blue / green / amber tells the callouts already teach.
const SOLDIER_KITS = [
  { name: 'runner', cloth: sdMat(0x9a9c80, TEX.camo.map), pants: sdMat(0x4a4e3c, TEX.camo.map), vest: sdMat(0x2e3228), helmet: null, cap: sdMat(0x2a2c24) },
  { name: 'rifleman', cloth: sdMat(0x8a94a8, TEX.camo.map), pants: sdMat(0x5a6272, TEX.camo.map), vest: sdMat(0x252a30), helmet: sdMat(0x2c3137, null, 0.7) },
  { name: 'tank', cloth: sdMat(0x585858, TEX.camo.map), pants: sdMat(0x3a3a3c, TEX.camo.map), vest: SDM.plate, helmet: sdMat(0x18191b, null, 0.55, 0.4) },
  { name: 'shielded', cloth: sdMat(0x7890c0, TEX.camo.map), pants: sdMat(0x3c4a66, TEX.camo.map), vest: sdMat(0x2a3448), helmet: sdMat(0x3a5480, null, 0.6, 0.3) },
  { name: 'scout', cloth: sdMat(0xa8d888, TEX.camo.map), pants: sdMat(0x5a7a44, TEX.camo.map), vest: sdMat(0x33422a), helmet: null, cap: sdMat(0x4a6a34) },
  { name: 'grenadier', cloth: sdMat(0xe0b070, TEX.camo.map), pants: sdMat(0x8a6e40, TEX.camo.map), vest: sdMat(0x4a3a22), helmet: sdMat(0x7a5a2a, null, 0.8) }
];
const SDM_SHIELD = sdMat(0x2a3446, TEX.paint.map, 0.5, 0.55);
const SDM_SHIELD_GLASS = sdMat(0x0a1420, null, 0.05, 0.9, { transparent: true, opacity: 0.65 });

// ---- geometry helpers ----
// Rounded capsule hanging down (-y) from the joint: radius r0 at the top, r1 at the bottom.
function sdCapsule(r0, r1, len, seg) {
  const pts = [], n = 4;
  for (let i = n; i >= 0; i--) { const a = i / n * Math.PI / 2; pts.push(new THREE.Vector2(Math.sin(a) * r1 + 1e-4, -len - Math.cos(a) * r1 * 0.7)); }
  for (let i = 0; i <= n; i++) { const a = Math.PI / 2 - i / n * Math.PI / 2; pts.push(new THREE.Vector2(Math.sin(a) * r0 + 1e-4, Math.cos(a) * r0 * 0.7)); }
  pts.sort(function (p, q) { return p.y - q.y; });
  return new THREE.LatheGeometry(pts, seg || 14);
}
function sdLathe(profile, seg) {   // profile: [[radius, y], ...] bottom -> top
  return new THREE.LatheGeometry(profile.map(function (p) { return new THREE.Vector2(p[0] + 1e-4, p[1]); }), seg || 14);
}
const _sdBoxCache = {};
function sdBoxG(w, h, d) { const k = w + ',' + h + ',' + d; return _sdBoxCache[k] || (_sdBoxCache[k] = new THREE.BoxGeometry(w, h, d)); }
function sdPiece(parent, geo, mat, x, y, z, rx, ry, rz, sx, sy, sz) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x || 0, y || 0, z || 0);
  m.rotation.set(rx || 0, ry || 0, rz || 0);
  if (sx) m.scale.set(sx, sy || sx, sz || sx);
  parent.add(m);
  return m;
}
// Joints are bones: the finished template is rigidly skinned to them.
function sdJoint(parent, name, x, y, z) {
  const g = new THREE.Bone();
  g.name = name; g.position.set(x, y, z);
  parent.add(g);
  return g;
}
// Rigid skinning: every piece is baked into template space and weighted 100% to
// the joint it hangs from, then merged per material into one SkinnedMesh. A
// soldier is one draw call per material instead of one per piece per joint (37
// meshes -> about 9), and the joints still animate and ragdoll exactly as before.
function sdMergeSkinGeo(list) {
  let vCount = 0, iCount = 0;
  for (let i = 0; i < list.length; i++) {
    const g = list[i].g;
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2);
  const si = new Uint16Array(vCount * 4), sw = new Float32Array(vCount * 4);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (let k = 0; k < list.length; k++) {
    const g = list[k].g, n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    for (let i = 0; i < n; i++) { si[(vo + i) * 4] = list[k].bone; sw[(vo + i) * 4] = 1; }
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; }
    else { for (let i = 0; i < n; i++) idx[io + i] = vo + i; io += n; }
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
function sdSkinRig(root) {
  root.updateMatrixWorld(true);
  const bones = [], boneIdx = new Map(), pieces = [];
  root.traverse(function (o) {
    if (o.isBone) { boneIdx.set(o, bones.length); bones.push(o); }
    else if (o.isMesh && !o.userData.keep) pieces.push(o);
  });
  const byMat = new Map();
  for (let i = 0; i < pieces.length; i++) {
    const c = pieces[i];
    const g = c.geometry.clone().applyMatrix4(c.matrixWorld);   // root sits at the origin
    if (!byMat.has(c.material)) byMat.set(c.material, []);
    byMat.get(c.material).push({ g: g, bone: boneIdx.has(c.parent) ? boneIdx.get(c.parent) : 0 });
    c.parent.remove(c);
  }
  const skeleton = new THREE.Skeleton(bones);   // inverses from this rest pose
  byMat.forEach(function (list, mat) {
    const sm = new THREE.SkinnedMesh(sdMergeSkinGeo(list), mat);
    sm.frustumCulled = false;   // bind-pose bounds go stale as soon as it moves
    sm.castShadow = true; sm.receiveShadow = true;
    root.add(sm);
    sm.bind(skeleton, new THREE.Matrix4());
  });
}
function sdNoRaycast() { /* visuals never take hits; the joint hitboxes do */ }
// Object3D.clone() keeps a SkinnedMesh pointing at the TEMPLATE's skeleton; rebind
// each clone to its own bones (by name) with the shared inverse bind matrices.
function sdCloneRig(template) {
  const clone = template.clone(true);
  const byName = {};
  clone.traverse(function (o) { if (o.isBone) byName[o.name] = o; });
  const skeletons = [];
  let skel = null;
  clone.traverse(function (o) {
    if (!o.isSkinnedMesh) return;
    if (!skel) {
      skel = new THREE.Skeleton(o.skeleton.bones.map(function (b) { return byName[b.name]; }), o.skeleton.boneInverses);
      skeletons.push(skel);
    }
    o.bind(skel, o.bindMatrix);
    o.raycast = sdNoRaycast;
  });
  clone.userData.skeletons = skeletons;
  return clone;
}

// ---- the model (faces +z; character-left is +x) ----
function buildSoldierTemplate(kind) {
  const K = SOLDIER_KITS[kind];
  const heavy = kind === 2;
  const root = new THREE.Group(); root.name = 'root';
  const hips = sdJoint(root, 'hips', 0, 0.97, 0);
  // pelvis + belt with holster and pouches
  sdPiece(hips, sdLathe([[0.13, -0.1], [0.165, -0.04], [0.16, 0.06], [0.14, 0.12]]), K.pants, 0, 0, 0, 0, 0, 0, 1, 1, 0.72);
  sdPiece(hips, sdLathe([[0.172, 0.0], [0.172, 0.055]], 16), SDM.strap, 0, 0, 0, 0, 0, 0, 1, 1, 0.74);
  sdPiece(hips, sdBoxG(0.07, 0.11, 0.05), SDM.pouch, -0.17, -0.03, 0.02);
  sdPiece(hips, sdBoxG(0.08, 0.08, 0.05), SDM.pouch, 0.1, 0.0, -0.1);
  const spine = sdJoint(hips, 'spine', 0, 0.1, 0);
  // shaped torso (oval cross-section: wide shoulders, narrow waist)
  sdPiece(spine, sdLathe([[0.14, -0.04], [0.145, 0.1], [0.17, 0.28], [0.2, 0.4], [0.19, 0.47], [0.11, 0.52], [0.04, 0.54]], 16), K.cloth, 0, 0, 0, 0, 0, 0, 1, 1, 0.66);
  // plate carrier + front mag pouches + radio + side plates
  const vestS = heavy ? 1.12 : 1;
  sdPiece(spine, sdLathe([[0.19, 0.12], [0.205, 0.26], [0.215, 0.4], [0.2, 0.46]], 16), K.vest, 0, 0, 0, 0, 0, 0, vestS, 1, 0.74 * vestS);
  sdPiece(spine, sdBoxG(0.3, 0.3, 0.04), K.vest, 0, 0.3, 0.155 * vestS);
  for (let i = -1; i <= 1; i++) {
    sdPiece(spine, sdBoxG(0.085, 0.12, 0.06), SDM.pouch, i * 0.095, 0.22, 0.185 * vestS);
    sdPiece(spine, sdBoxG(0.086, 0.02, 0.064), SDM.strap, i * 0.095, 0.27, 0.186 * vestS);
  }
  sdPiece(spine, sdBoxG(0.06, 0.13, 0.05), SDM.pouch, 0.15, 0.4, 0.12);
  sdPiece(spine, sdCapsule(0.008, 0.008, 0.14, 5), SDM.gunMetal, 0.16, 0.6, 0.12);   // radio antenna
  sdPiece(spine, sdBoxG(0.3, 0.28, 0.05), K.vest, 0, 0.3, -0.15 * vestS);             // back plate
  if (heavy) {
    // bulky pauldrons, collar, groin plate
    for (const sx of [-1, 1]) sdPiece(spine, sdLathe([[0.02, -0.05], [0.12, 0.0], [0.11, 0.05], [0.02, 0.08]], 12), SDM.plate, sx * 0.25, 0.44, 0, 0, 0, sx * 0.4, 1, 1, 1.1);
    sdPiece(spine, sdLathe([[0.14, 0.44], [0.13, 0.52], [0.1, 0.56]], 14), SDM.plate, 0, 0, 0, 0, 0, 0, 1, 1, 0.9);
    sdPiece(hips, sdBoxG(0.22, 0.2, 0.05), SDM.plate, 0, -0.08, 0.14);
  }
  if (kind === 5) {
    // grenadier: assault pack + bandolier of frags
    sdPiece(spine, sdBoxG(0.3, 0.36, 0.16), K.pants, 0, 0.32, -0.23);
    sdPiece(spine, sdBoxG(0.26, 0.08, 0.14), SDM.strap, 0, 0.12, -0.22);
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      sdPiece(spine, new THREE.SphereGeometry(0.042, 10, 8), SDM.nade, -0.13 + t * 0.26, 0.42 - t * 0.28, 0.2);
    }
  }
  if (kind === 0 || kind === 4) sdPiece(spine, sdLathe([[0.2, 0.3], [0.21, 0.36]], 16), SDM.strap, 0, 0, 0, 0, 0, 0, 1, 1, 0.72);   // chest rig strap only
  // neck + head
  const neck = sdJoint(spine, 'neck', 0, 0.5, 0.0);
  const bare = !K.helmet;
  sdPiece(neck, sdCapsule(0.05, 0.055, 0.09, 8), bare ? SDM.skin : SDM.mask, 0, 0.09, 0, Math.PI, 0, 0);
  const head = sdJoint(neck, 'head', 0, 0.09, 0.01);
  sdPiece(head, new THREE.SphereGeometry(1, 16, 12), bare ? SDM.skin : SDM.mask, 0, 0.1, 0.01, 0, 0, 0, 0.1, 0.125, 0.115);
  sdPiece(head, new THREE.SphereGeometry(1, 12, 8), SDM.mask, 0, 0.06, 0.08, 0, 0, 0, 0.07, 0.06, 0.05);   // jaw / lower face
  if (K.helmet) {
    // helmet shell (open hemisphere), rim, ear cups, NVG or visor
    const shell = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
    sdPiece(head, shell, K.helmet, 0, 0.12, 0.0, 0, 0, 0, 0.135, 0.13, 0.145);
    sdPiece(head, new THREE.TorusGeometry(1, 0.08, 6, 20), K.helmet, 0, 0.1, 0, Math.PI / 2, 0, 0, 0.13, 0.14, 0.13);
    for (const sx of [-1, 1]) sdPiece(head, new THREE.CylinderGeometry(0.045, 0.045, 0.035, 12), SDM.strap, sx * 0.118, 0.09, 0, 0, 0, Math.PI / 2);
    if (heavy) {
      sdPiece(head, new THREE.SphereGeometry(1, 14, 8, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.35, Math.PI * 0.35), SDM.visor, 0, 0.09, 0.0, 0, 0, 0, 0.14, 0.14, 0.15);
      const slit = sdPiece(head, sdBoxG(0.16, 0.012, 0.01), SDM.slit, 0, 0.115, 0.148);
      slit.userData.keep = false;
    } else {
      sdPiece(head, sdBoxG(0.05, 0.035, 0.04), SDM.gunMetal, 0, 0.19, 0.135);        // NVG mount
      for (const sx of [-0.035, 0.035]) {
        sdPiece(head, new THREE.CylinderGeometry(0.02, 0.024, 0.07, 10), SDM.gun, sx, 0.15, 0.17, Math.PI / 2 - 0.2, 0, 0);
        sdPiece(head, new THREE.CircleGeometry(0.018, 12), SDM.nvg, sx, 0.158, 0.206, -0.2, 0, 0);
      }
      if (kind === 5 || kind === 3) sdPiece(head, sdBoxG(0.2, 0.05, 0.02), SDM.lens, 0, 0.12, 0.118);   // goggles
    }
  } else {
    // runner: balaclava with an eye slot, soft cap with a brim
    sdPiece(head, new THREE.SphereGeometry(1, 16, 12), SDM.mask, 0, 0.1, 0.01, 0, 0, 0, 0.104, 0.128, 0.118);
    sdPiece(head, sdBoxG(0.12, 0.032, 0.03), SDM.skin, 0, 0.115, 0.112);
    sdPiece(head, new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), K.cap, 0, 0.14, 0, 0, 0, 0, 0.112, 0.09, 0.124);
    sdPiece(head, new THREE.CylinderGeometry(0.075, 0.075, 0.012, 14, 1, false, -Math.PI / 2, Math.PI), K.cap, 0, 0.145, 0.08, 0, Math.PI / 2, 0, 1, 1, 0.9);
  }
  // arms: shoulder -> elbow -> hand (character left = +x)
  for (const side of [1, -1]) {
    const S = side > 0 ? 'L' : 'R';
    const sh = sdJoint(spine, 'sh' + S, side * 0.2, 0.44, 0);
    sdPiece(sh, sdCapsule(0.062, 0.05, 0.27, 10), K.cloth, 0, 0, 0);
    if (!heavy) sdPiece(sh, sdCapsule(0.066, 0.062, 0.06, 10), K.vest, 0, 0.0, 0);    // shoulder pad
    const el = sdJoint(sh, 'el' + S, 0, -0.29, 0);
    sdPiece(el, sdCapsule(0.048, 0.042, 0.24, 10), K.cloth, 0, 0, 0);
    if (heavy) sdPiece(el, sdCapsule(0.056, 0.05, 0.14, 10), SDM.plate, 0, -0.02, 0.01);
    const ha = sdJoint(el, 'ha' + S, 0, -0.26, 0);
    sdPiece(ha, sdCapsule(0.042, 0.036, 0.07, 8), SDM.glove, 0, 0.02, 0, 0, 0, 0, 1, 1, 0.8);
    sdPiece(ha, sdBoxG(0.06, 0.05, 0.035), SDM.glove, 0, -0.07, 0.015);             // fingers
    const m = new THREE.Object3D(); m.name = 'mHand' + S; m.position.set(0, -0.06, 0); ha.add(m);
  }
  // legs: hip -> knee -> ankle
  for (const side of [1, -1]) {
    const S = side > 0 ? 'L' : 'R';
    const hp = sdJoint(hips, 'hip' + S, side * 0.1, -0.05, 0);
    sdPiece(hp, sdCapsule(0.085, 0.064, 0.4, 10), K.pants, 0, 0, 0);
    sdPiece(hp, sdBoxG(0.05, 0.12, 0.09), K.pants, side * 0.085, -0.2, 0.0);       // cargo pocket
    sdPiece(hp, sdBoxG(0.012, 0.03, 0.12), SDM.strap, side * 0.075, -0.12, 0.0);   // thigh strap
    const kn = sdJoint(hp, 'kn' + S, 0, -0.43, 0);
    sdPiece(kn, sdCapsule(0.062, 0.05, 0.36, 10), K.pants, 0, 0, 0);
    sdPiece(kn, sdLathe([[0.02, -0.05], [0.07, -0.02], [0.07, 0.05], [0.02, 0.08]], 10), heavy ? SDM.plate : SDM.strap, 0, -0.02, 0.045, 0, 0, 0, 1, 1, 0.6);   // knee pad
    const an = sdJoint(kn, 'an' + S, 0, -0.41, 0);
    sdPiece(an, sdCapsule(0.055, 0.05, 0.1, 10), SDM.boot, 0, 0.08, 0);          // boot shaft
    sdPiece(an, sdBoxG(0.1, 0.07, 0.24), SDM.boot, 0, -0.01, 0.055);
    sdPiece(an, sdBoxG(0.105, 0.025, 0.25), SDM.sole, 0, -0.05, 0.057);
    const m = new THREE.Object3D(); m.name = 'mFoot' + S; m.position.set(0, -0.03, 0.04); an.add(m);
  }
  // weapon on the right shoulder (right = -x)
  const gun = sdJoint(spine, 'gun', -0.12, 0.34, 0.22);
  if (kind === 0 || kind === 4) {
    // runner / scout: combat knife in the right hand instead
    gun.position.set(0, 0, 0);
    const knife = sdJoint(root.getObjectByName('haR'), 'knife', 0, -0.07, 0.04);
    sdPiece(knife, sdBoxG(0.012, 0.035, 0.2), SDM.blade, 0, 0, 0.1);
    sdPiece(knife, sdBoxG(0.025, 0.04, 0.09), SDM.gun, 0, 0, -0.03);
  } else {
    const lmg = heavy;
    sdPiece(gun, sdBoxG(0.055, 0.09, 0.38), SDM.gun, 0, 0, 0.05);                    // receiver
    sdPiece(gun, sdBoxG(0.05, 0.05, 0.22), SDM.gun, 0, 0.012, 0.32);                  // handguard
    sdPiece(gun, sdCapsule(0.012, 0.012, 0.22, 8), SDM.gunMetal, 0, 0.015, 0.43, Math.PI / 2, 0, 0);   // barrel
    sdPiece(gun, sdBoxG(0.045, 0.08, 0.2), SDM.gun, 0, -0.01, -0.22);                 // stock
    sdPiece(gun, sdBoxG(0.035, 0.1, 0.045), SDM.gun, 0, -0.08, -0.02, -0.3, 0, 0);    // grip
    sdPiece(gun, lmg ? sdBoxG(0.1, 0.12, 0.12) : sdBoxG(0.04, 0.13, 0.07), lmg ? SDM.pouch : SDM.gun, lmg ? 0.05 : 0, -0.1, 0.12, lmg ? 0 : 0.15, 0, 0);   // mag / box
    sdPiece(gun, sdCapsule(0.02, 0.02, 0.06, 10), SDM.gun, 0, 0.075, 0.06, Math.PI / 2, 0, 0);   // optic
    sdPiece(gun, new THREE.CircleGeometry(0.018, 10), SDM.lens, 0, 0.075, 0.121);
  }
  if (kind === 3) {
    // ballistic shield carried square in front of the chest, with a viewport
    const shd = sdJoint(spine, 'shield', 0.02, 0.22, 0.36);
    sdPiece(shd, sdBoxG(0.56, 0.95, 0.035), SDM_SHIELD, 0, 0, 0);
    sdPiece(shd, sdBoxG(0.6, 0.04, 0.05), SDM.strap, 0, 0.47, 0);
    sdPiece(shd, sdBoxG(0.6, 0.04, 0.05), SDM.strap, 0, -0.47, 0);
    sdPiece(shd, sdBoxG(0.3, 0.09, 0.04), SDM_SHIELD_GLASS, 0, 0.3, 0.004);
    sdPiece(shd, sdBoxG(0.08, 0.03, 0.04), SDM.slit, 0.2, 0.4, 0.01);            // strobe
  }
  // hit boxes follow the joints (invisible)
  const hbMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitHead = sdPiece(head, sdBoxG(0.3, 0.3, 0.3), hbMat, 0, 0.11, 0.02); hitHead.name = 'hitHead'; hitHead.userData.keep = true;
  const hitBody = sdPiece(spine, sdBoxG(0.5, 0.56, 0.38), hbMat, 0, 0.26, 0); hitBody.name = 'hitBody'; hitBody.userData.keep = true;
  const hitLegs = sdPiece(hips, sdBoxG(0.44, 0.9, 0.34), hbMat, 0, -0.46, 0.02); hitLegs.name = 'hitLegs'; hitLegs.userData.keep = true;
  const mh = new THREE.Object3D(); mh.name = 'mHead'; mh.position.set(0, 0.1, 0.01); head.add(mh);
  sdSkinRig(root);
  root.traverse(function (o) { if (o.isMesh && !o.userData.keep) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}
const SOLDIER_TEMPLATES = [];
const RIG_JOINTS = ['hips', 'spine', 'neck', 'head', 'shL', 'elL', 'haL', 'shR', 'elR', 'haR', 'hipL', 'knL', 'anL', 'hipR', 'knR', 'anR', 'gun'];
function buildSoldier(kind) {
  if (!SOLDIER_TEMPLATES[kind]) SOLDIER_TEMPLATES[kind] = buildSoldierTemplate(kind);
  const root = sdCloneRig(SOLDIER_TEMPLATES[kind]);
  const J = {};
  root.traverse(function (o) { if (o.name) J[o.name] = o; });
  return { group: root, J: J, hitBody: J.hitBody, hitHead: J.hitHead, hitLegs: J.hitLegs, gun: (kind === 0 || kind === 4) ? J.knife : J.gun };
}

// ---- procedural animation ----
function sdSpring(s, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
  for (let i = 0; i < n; i++) {
    s.vx += (-s.x * k - s.vx * c) * h; s.x += s.vx * h;
    s.vz += (-s.z * k - s.vz * c) * h; s.z += s.vz * h;
  }
}
// Hit reaction: push the torso/head spring away from the bullet (called from damageEnemy).
function soldierHitReact(en, dir, strength, isHead) {
  if (!en.react) return;
  const fx = Math.sin(en.bodyYaw || en.yaw), fz = Math.cos(en.bodyYaw || en.yaw);
  const along = dir ? dir.x * fx + dir.z * fz : -1;          // + = pushed toward the back? (dir points away from shooter)
  const side = dir ? dir.x * fz - dir.z * fx : 0;
  const s = Math.min(1.5, strength);
  (isHead ? en.reactHead : en.react).vx += along * 9 * s;
  en.react.vz += -side * 6 * s;
}
function animateSoldier(en, dt, dist) {
  const p = en.parts, J = p.J;
  if (!en.react) { en.react = { x: 0, z: 0, vx: 0, vz: 0 }; en.reactHead = { x: 0, z: 0, vx: 0, vz: 0 }; en.gait = Math.random() * 6; en.bodyYaw = en.yaw; }
  p.group.position.set(en.pos.x, en.pos.y, en.pos.z);
  // body yaw lags the aim yaw a little (turning weight); the chest carries the rest
  let dy = en.yaw - en.bodyYaw;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  en.bodyYaw += dy * Math.min(1, dt * 6);
  p.group.rotation.y = en.bodyYaw;
  const twist = Math.max(-0.9, Math.min(0.9, dy));
  // local velocity (forward / left) drives the gait
  const fx = Math.sin(en.bodyYaw), fz = Math.cos(en.bodyYaw);
  const vf = en.vel.x * fx + en.vel.z * fz, vl = en.vel.x * fz - en.vel.z * fx;
  const speed = Math.hypot(en.vel.x, en.vel.z);
  const run = Math.min(1, Math.max(0, (speed - 2.2) / 3));
  const moveK = Math.min(1, speed / 1.2);
  // stride-synced phase: one full cycle covers two steps, stride grows with speed (no foot sliding)
  const stride = 0.75 + speed * 0.13;
  en.gait += (speed / stride) * Math.PI * dt;
  const ph = en.gait;
  const sgn = vf >= -0.3 ? 1 : -1;
  const latK = speed > 0.1 ? Math.max(-1, Math.min(1, vl / speed)) : 0;
  const fwdK = speed > 0.1 ? Math.abs(vf) / speed : 0;
  const A = (0.42 + run * 0.35) * moveK;
  const cr = en.crouch || 0;
  sdSpring(en.react, 140, 13, dt);
  sdSpring(en.reactHead, 180, 14, dt);
  // ---- legs ----
  for (const side of [1, -1]) {
    const S = side > 0 ? 'L' : 'R';
    const pp = ph + (side > 0 ? 0 : Math.PI);
    const swing = Math.sin(pp);
    J['hip' + S].rotation.x = -swing * A * fwdK * sgn - cr * 1.25 - run * 0.1;
    J['hip' + S].rotation.z = side * (swing * A * 0.6 * latK * side) + side * 0.03;
    J['kn' + S].rotation.x = Math.max(0, Math.sin(pp + 1.2)) * (0.55 + run * 0.9) * moveK + cr * 2.1 + 0.05;
    J['an' + S].rotation.x = -Math.max(0, Math.sin(pp + 0.4)) * 0.3 * moveK - cr * 0.8;
  }
  // pelvis: bob twice per cycle, sway side to side, drop when crouched
  J.hips.position.y = 0.97 - cr * 0.4 - Math.abs(Math.cos(ph)) * 0.035 * moveK * (1 + run) + 0.015 * moveK;
  J.hips.rotation.z = Math.sin(ph) * 0.05 * moveK;
  J.hips.rotation.y = Math.sin(ph) * 0.12 * moveK * fwdK;
  // ---- upper body ----
  // riflemen shoulder the weapon while trading shots; the tank hip-fires up close
  const aiming = (en.kind === 1 && en.state === 'strafe') || (en.kind === 2 && dist < 22) || (en.kind === 5 && en.state === 'strafe');
  const pitch = Math.atan2(player.pos.y - (en.pos.y + 1.45), Math.max(0.5, dist));
  let lean = 0.08 * moveK + run * 0.2 + cr * 0.25 + ((en.kind === 0 || en.kind === 4) && en.state === 'chase' ? 0.15 : 0);
  if (en.kind === 3) lean += 0.12;   // shoulder into the shield
  J.spine.rotation.set(lean + en.react.x - (aiming ? pitch * 0.45 : 0), twist * 0.7 - J.hips.rotation.y, en.react.z + Math.sin(ph + 0.5) * 0.03 * moveK);
  J.neck.rotation.set(-(aiming ? pitch * 0.4 : pitch * 0.2) - lean * 0.5, twist * 0.3, 0);
  J.head.rotation.set(en.reactHead.x, 0, en.reactHead.z * 0.5);
  // breathing
  J.spine.scale.setScalar(1 + Math.sin(gameT * 2.2 + en.walkPhase) * 0.006);
  // ---- arms ----
  const shL = J.shL, shR = J.shR, elL = J.elL, elR = J.elR;
  const armSwing = Math.sin(ph) * (0.35 + run * 0.4) * moveK;
  // en.swinging counts the telegraphed windup down to 0, then sits at -1 while the
  // attack recovers (40_enemies.js). Remember the windup length to scale the pose.
  if (en.swinging !== undefined && en.swinging > 0 && !(en.swingDur >= en.swinging)) en.swingDur = en.swinging;
  if (en.swinging === undefined) en.swingDur = 0;
  if (en.throwT > 0) en.throwT = Math.max(0, en.throwT - dt);
  if (en.swinging !== undefined && en.swinging > -1) {
    // melee: wind up high, strike through
    const k = en.swinging > 0 ? 1 - en.swinging / (en.swingDur || 0.5) : 1 + Math.min(1, -en.swinging * 4);
    shR.rotation.set(k <= 1 ? -2.6 * k : -2.6 + (k - 1) * 3.0, 0, -0.2);
    elR.rotation.set(-0.5, 0, 0);
    shL.rotation.set(-0.6, 0, 0.2); elL.rotation.set(-0.8, 0, 0);
  } else if (en.throwT > 0) {
    const k = 1 - en.throwT / 0.5;
    shR.rotation.set(-2.8 + k * 2.4, 0, -0.3); elR.rotation.set(-0.9 + k * 0.6, 0, 0);
    shL.rotation.set(-1.2, 0, 0.3); elL.rotation.set(-0.3, 0, 0);
  } else if (en.kind === 3) {
    // shield braced on the left forearm, carbine low in the right
    shL.rotation.set(-1.2, 0, -0.35); elL.rotation.set(-0.55, 0, 0);
    shR.rotation.set(-0.5 + armSwing * 0.1, 0, 0.1); elR.rotation.set(-0.9, 0, 0);
    if (J.gun) { J.gun.position.set(-0.16, 0.22, 0.12); J.gun.rotation.set(0.5, 0.3, 0.2); }
  } else if (en.kind === 0 || en.kind === 4) {
    // runner: arms pump, knife hand leads
    shL.rotation.set(-armSwing * 1.3 - 0.2 - run * 0.3, 0, 0.12); elL.rotation.set(-0.6 - run * 0.8, 0, 0);
    shR.rotation.set(armSwing * 1.3 - 0.3 - run * 0.3, 0, -0.12); elR.rotation.set(-0.7 - run * 0.8, 0, 0);
  } else {
    // rifle carriers: shouldered when aiming, low-ready when moving
    const ready = aiming ? 1 : 0.55;
    en.readyK = (en.readyK || 0) + (ready - (en.readyK || 0)) * Math.min(1, dt * 8);
    const r = en.readyK;
    shR.rotation.set(-0.45 - r * 0.75 + armSwing * 0.15 * (1 - r), 0, 0.28 * r);
    elR.rotation.set(-0.5 - r * 0.95, 0, 0);
    shL.rotation.set(-0.7 - r * 0.85, 0, -0.5 * r);
    elL.rotation.set(-0.25 - (1 - r) * 0.6, 0, 0);
    if (J.gun) {
      J.gun.position.set(-0.12 + (1 - r) * 0.08, 0.3 + r * 0.06, 0.2 + r * 0.04);
      J.gun.rotation.set((1 - r) * 0.55, (1 - r) * 0.5, (1 - r) * 0.3);
      // recoil kick on shots
      const kick = Math.max(0, 0.12 - (gameT - (en.lastShotT || -9))) * 3;
      J.gun.position.z -= kick * 0.12; J.gun.rotation.x -= kick * 0.5;
    }
  }
  // hit boxes track the body but are only raycast (never drawn)
}

// ---- Verlet ragdoll ----
const RD_MARK = ['hips', 'neck', 'mHead', 'shL', 'elL', 'mHandL', 'shR', 'elR', 'mHandR', 'hipL', 'knL', 'mFootL', 'hipR', 'knR', 'mFootR'];
const RD_RAD = [0.15, 0.13, 0.13, 0.07, 0.055, 0.05, 0.07, 0.055, 0.05, 0.09, 0.07, 0.07, 0.09, 0.07, 0.07];
const RD_BONES = [[0, 1], [1, 2], [1, 3], [1, 6], [3, 4], [4, 5], [6, 7], [7, 8], [0, 9], [0, 12], [9, 10], [10, 11], [12, 13], [13, 14]];
const RD_BRACES = [[3, 6], [9, 12], [3, 0], [6, 0], [9, 1], [12, 1], [3, 9], [6, 12], [2, 3], [2, 6]];
const RD_MIN = [[5, 1, 0.16], [8, 1, 0.16], [11, 0, 0.45], [14, 0, 0.45], [2, 0, 0.55], [11, 9, 0.36], [14, 12, 0.36], [5, 3, 0.18], [8, 6, 0.18], [5, 8, 0.1], [11, 14, 0.12]];
// [joint group, particle a, particle b, frame reference: 0 = hips axis, 1 = shoulder axis]
const RD_PARTS = [['hips', 0, 1, 0], ['spine', 0, 1, 1], ['neck', 1, 2, 1], ['head', 1, 2, 1], ['shL', 3, 4, 1], ['elL', 4, 5, 1], ['haL', 4, 5, 1],
  ['shR', 6, 7, 1], ['elR', 7, 8, 1], ['haR', 7, 8, 1], ['hipL', 9, 10, 0], ['knL', 10, 11, 0], ['anL', 10, 11, 0], ['hipR', 12, 13, 0], ['knR', 13, 14, 0], ['anR', 13, 14, 0]];
const RD_H = 1 / 60, RD_G = 16;
const _sa = new THREE.Vector3(), _sb = new THREE.Vector3(), _sr = new THREE.Vector3(), _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sz = new THREE.Vector3();
function sdGet(P, i, out) { return out.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); }
function sdFrame(P, a, b, refUpper, out) {
  sdGet(P, a, _sa); sdGet(P, b, _sb);
  _sy.copy(_sb).sub(_sa).normalize();
  const r0 = refUpper ? 3 : 9, r1 = refUpper ? 6 : 12;
  _sr.set(P[r1 * 3] - P[r0 * 3], P[r1 * 3 + 1] - P[r0 * 3 + 1], P[r1 * 3 + 2] - P[r0 * 3 + 2]);
  _sx.copy(_sr).addScaledVector(_sy, -_sr.dot(_sy));
  if (_sx.lengthSq() < 1e-8) _sx.set(1, 0, 0);
  _sx.normalize();
  _sz.crossVectors(_sx, _sy);
  out.makeBasis(_sx, _sy, _sz);
  out.setPosition(_sa);
  return out;
}
// Hand a dead soldier's joints to the simulation. impulseDir/impulse (m/s) is the
// killing shot along its travel direction; blastPos, when set, throws the body
// away from and up out of an explosion instead.
// `settled` and `order` mirror CORE.makeRagdoll's shape, so the corpse budget and
// the live probe treat both kinds of ragdoll alike.
function sdStartRagdoll(en, impulseDir, impulse, hitPoint, blastPos) {
  const p = en.parts, J = p.J;
  p.group.updateMatrixWorld(true);
  const R = { P: new Float32Array(45), Q: new Float32Array(45), rest: [], min: RD_MIN, cols: [], colT: 0, sleepT: 0, asleep: false, pooled: false, container: new THREE.Group(), parts: [],
    settled: false, order: [] };
  for (let i = 0; i < 15; i++) R.order.push({ x: 0, y: 0, z: 0 });
  const explosive = !!blastPos;
  const knock = { x: 0, z: 0 };
  if (explosive) {
    const kx = en.pos.x - blastPos.x, kz = en.pos.z - blastPos.z, kl = Math.hypot(kx, kz) || 1;
    const kf = Math.max(2, 9 - kl);
    knock.x = kx / kl * kf; knock.z = kz / kl * kf;
  }
  // most of the running momentum carries into the fall; the kill shot then wins
  const v = new THREE.Vector3(en.vel.x * 0.55 + knock.x, 0, en.vel.z * 0.55 + knock.z);
  for (let i = 0; i < 15; i++) {
    const o = J[RD_MARK[i]];
    o.getWorldPosition(_sa);
    R.P[i * 3] = _sa.x; R.P[i * 3 + 1] = _sa.y; R.P[i * 3 + 2] = _sa.z;
  }
  // rest lengths from the pose at the moment of death
  const all = RD_BONES.concat(RD_BRACES);
  for (let i = 0; i < all.length; i++) {
    const a = all[i][0], b = all[i][1];
    R.rest.push([a, b, Math.hypot(R.P[a * 3] - R.P[b * 3], R.P[a * 3 + 1] - R.P[b * 3 + 1], R.P[a * 3 + 2] - R.P[b * 3 + 2]), i < RD_BONES.length ? 1 : 0.6]);
  }
  // initial velocities: body momentum + the killing blow at the nearest particle
  let hitIdx = 1, best = Infinity;
  if (hitPoint) for (let i = 0; i < 15; i++) {
    const d = Math.hypot(R.P[i * 3] - hitPoint.x, R.P[i * 3 + 1] - hitPoint.y, R.P[i * 3 + 2] - hitPoint.z);
    if (d < best) { best = d; hitIdx = i; }
  }
  for (let i = 0; i < 15; i++) {
    let vx = v.x, vy = 0, vz = v.z;
    if (explosive) { vx += knock.x * 0.6 * (0.8 + Math.random() * 0.4); vy += 3.5 + Math.random() * 2.5 + (i === 2 ? 1 : 0); vz += knock.z * 0.6 * (0.8 + Math.random() * 0.4); }
    if (impulseDir) {
      const near = i === hitIdx ? 1 : RD_BONES.some(function (bn) { return (bn[0] === i && bn[1] === hitIdx) || (bn[1] === i && bn[0] === hitIdx); }) ? 0.7 : 0.45;
      vx += impulseDir.x * impulse * near; vy += impulseDir.y * impulse * near + impulse * 0.08 * near; vz += impulseDir.z * impulse * near;
    }
    R.Q[i * 3] = R.P[i * 3] - vx * RD_H; R.Q[i * 3 + 1] = R.P[i * 3 + 1] - vy * RD_H; R.Q[i * 3 + 2] = R.P[i * 3 + 2] - vz * RD_H;
  }
  // hand the visual parts over: record each part relative to its bone frame
  scene.add(R.container);
  const F0 = new THREE.Matrix4(), inv = new THREE.Matrix4();
  for (let i = 0; i < RD_PARTS.length; i++) {
    const d = RD_PARTS[i], g = J[d[0]];
    if (!g) continue;
    g.updateMatrixWorld(true);
    sdFrame(R.P, d[1], d[2], d[3], F0);
    const rel = inv.copy(F0).invert().multiply(g.matrixWorld).clone();
    R.parts.push({ g: g, a: d[1], b: d[2], ref: d[3], rel: rel });
  }
  for (let i = 0; i < R.parts.length; i++) {
    const g = R.parts[i].g;
    R.container.add(g);
    g.matrixAutoUpdate = false;
  }
  // the skinned bodies follow their bones wherever they live; keep them drawn
  const skins = [];
  p.group.traverse(function (o) { if (o.isSkinnedMesh) skins.push(o); });
  for (let i = 0; i < skins.length; i++) R.container.add(skins[i]);
  scene.remove(p.group);
  sdRefreshCols(R);
  sdApplyParts(R);
  sdSyncOrder(R);
  return R;
}
function sdSyncOrder(R) {
  for (let i = 0; i < 15; i++) { const o = R.order[i]; o.x = R.P[i * 3]; o.y = R.P[i * 3 + 1]; o.z = R.P[i * 3 + 2]; }
}
function sdRefreshCols(R) {
  R.cols.length = 0;
  const x = R.P[0], y = R.P[1], z = R.P[2];
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (x < c.min.x - 3 || x > c.max.x + 3 || z < c.min.z - 3 || z > c.max.z + 3 || y < c.min.y - 3 || y > c.max.y + 4) continue;
    R.cols.push(c);
  }
}
function sdSatisfy(P, a, b, len, stiff, minOnly) {
  const ax = a * 3, bx = b * 3;
  const dx = P[bx] - P[ax], dy = P[bx + 1] - P[ax + 1], dz = P[bx + 2] - P[ax + 2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
  if (minOnly && d >= len) return;
  const k = (d - len) / d * 0.5 * stiff;
  P[ax] += dx * k; P[ax + 1] += dy * k; P[ax + 2] += dz * k;
  P[bx] -= dx * k; P[bx + 1] -= dy * k; P[bx + 2] -= dz * k;
}
// knees bend forward, elbows backward (relative to the torso facing)
const _sf = new THREE.Vector3(), _su = new THREE.Vector3();
function sdHinge(P, h, m, e, sign) {
  const hx = P[h * 3], hy = P[h * 3 + 1], hz = P[h * 3 + 2];
  const ex = P[e * 3] - hx, ey = P[e * 3 + 1] - hy, ez = P[e * 3 + 2] - hz;
  const l2 = ex * ex + ey * ey + ez * ez || 1e-6;
  const mx = P[m * 3] - hx, my = P[m * 3 + 1] - hy, mz = P[m * 3 + 2] - hz;
  const t = (mx * ex + my * ey + mz * ez) / l2;
  const ox = mx - ex * t, oy = my - ey * t, oz = mz - ez * t;
  const s = (ox * _sf.x + oy * _sf.y + oz * _sf.z) * sign;
  if (s < 0.015) {
    const push = (0.015 - s) * sign;
    P[m * 3] += _sf.x * push * 0.6; P[m * 3 + 1] += _sf.y * push * 0.6; P[m * 3 + 2] += _sf.z * push * 0.6;
    P[h * 3] -= _sf.x * push * 0.2; P[h * 3 + 1] -= _sf.y * push * 0.2; P[h * 3 + 2] -= _sf.z * push * 0.2;
    P[e * 3] -= _sf.x * push * 0.2; P[e * 3 + 1] -= _sf.y * push * 0.2; P[e * 3 + 2] -= _sf.z * push * 0.2;
  }
}
function sdCollide(R) {
  const P = R.P, Q = R.Q;
  for (let i = 0; i < 15; i++) {
    const r = RD_RAD[i], ix = i * 3;
    let x = P[ix], y = P[ix + 1], z = P[ix + 2];
    let hit = false;
    if (y < GROUND + r) { y = GROUND + r; hit = true; }
    for (let k = 0; k < R.cols.length; k++) {
      const c = R.cols[k];
      if (x < c.min.x - r || x > c.max.x + r || y < c.min.y - r || y > c.max.y + r || z < c.min.z - r || z > c.max.z + r) continue;
      const qx = Math.max(c.min.x, Math.min(c.max.x, x)), qy = Math.max(c.min.y, Math.min(c.max.y, y)), qz = Math.max(c.min.z, Math.min(c.max.z, z));
      let dx = x - qx, dy = y - qy, dz = z - qz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r * r) continue;
      if (d2 < 1e-10) {
        // inside: exit through the top if near it, else the nearest side
        const pens = [x - c.min.x, c.max.x - x, c.max.y - y, z - c.min.z, c.max.z - z];
        let m = 0; for (let j = 1; j < 5; j++) if (pens[j] < pens[m]) m = j;
        if (m === 0) x = c.min.x - r; else if (m === 1) x = c.max.x + r; else if (m === 2) y = c.max.y + r; else if (m === 3) z = c.min.z - r; else z = c.max.z + r;
      } else {
        const d = Math.sqrt(d2), s = (r - d) / d;
        x += dx * s; y += dy * s; z += dz * s;
      }
      hit = true;
    }
    if (hit) {
      P[ix] = x; P[ix + 1] = y; P[ix + 2] = z;
      // contact friction: bleed off most of the sliding velocity
      Q[ix] = x - (x - Q[ix]) * 0.55; Q[ix + 2] = z - (z - Q[ix + 2]) * 0.55;
      if (Q[ix + 1] < y - 0.2) Q[ix + 1] = y;
    }
  }
}
function sdStepRagdoll(R) {
  const P = R.P, Q = R.Q;
  let maxMove = 0;
  for (let i = 0; i < 45; i += 3) {
    const vx = (P[i] - Q[i]) * 0.995, vy = (P[i + 1] - Q[i + 1]) * 0.995, vz = (P[i + 2] - Q[i + 2]) * 0.995;
    Q[i] = P[i]; Q[i + 1] = P[i + 1]; Q[i + 2] = P[i + 2];
    P[i] += vx; P[i + 1] += vy - RD_G * RD_H * RD_H; P[i + 2] += vz;
    maxMove = Math.max(maxMove, Math.abs(vx) + Math.abs(vy) + Math.abs(vz));
  }
  for (let it = 0; it < 8; it++) {
    for (let i = 0; i < R.rest.length; i++) { const c = R.rest[i]; sdSatisfy(P, c[0], c[1], c[2], c[3], false); }
    for (let i = 0; i < R.min.length; i++) { const c = R.min[i]; sdSatisfy(P, c[0], c[1], c[2], 1, true); }
    if (it % 2 === 1) {
      // torso facing for the hinge limits: up x (right side - left side)
      _su.set(P[3] - P[0], P[4] - P[1], P[5] - P[2]);
      _sr.set(P[36] - P[27], P[37] - P[28], P[38] - P[29]);
      _sf.crossVectors(_su, _sr).normalize();
      sdHinge(P, 9, 10, 11, 1); sdHinge(P, 12, 13, 14, 1);
      sdHinge(P, 3, 4, 5, -1); sdHinge(P, 6, 7, 8, -1);
    }
    if (it === 3 || it === 7) sdCollide(R);
  }
  return maxMove;
}
const _sdM = new THREE.Matrix4();
function sdApplyParts(R) {
  for (let i = 0; i < R.parts.length; i++) {
    const pt = R.parts[i];
    sdFrame(R.P, pt.a, pt.b, pt.ref, _sdM);
    pt.g.matrix.multiplyMatrices(_sdM, pt.rel);
    pt.g.matrixWorldNeedsUpdate = true;
  }
}
// Step one soldier ragdoll. Fixed 1/60 s substeps; a body that has stopped moving
// for 0.8 s goes to sleep and costs nothing until a blast wakes it.
function sdUpdateRagdoll(R, dt) {
  R.colT -= dt;
  if (R.colT <= 0) { R.colT = 0.4; sdRefreshCols(R); }
  if (!R.asleep) {
    R.acc = Math.min(0.1, (R.acc || 0) + dt);
    let moved = 0;
    while (R.acc >= RD_H) { moved = Math.max(moved, sdStepRagdoll(R)); R.acc -= RD_H; }
    sdApplyParts(R);
    sdSyncOrder(R);
    R.age = (R.age || 0) + dt;
    if (moved < 0.004) R.sleepT += dt; else R.sleepT = 0;
    // Asleep once still for half a second; a body still creeping after 4.5 s
    // (a limb caught on an edge) is put down rather than simulated forever.
    if (R.sleepT > 0.5 || (R.age > 4.5 && moved < 0.03)) R.asleep = true;
  }
  R.settled = R.asleep;
  if (R.asleep && !R.pooled) {
    R.pooled = true;
    if (R.P[4] < 0.6) spawnBloodPool(R.P[3], R.P[5], 1.2 + Math.random() * 0.6);
  }
}
function sdWake(R) { R.asleep = false; R.settled = false; R.sleepT = 0; R.age = 0; }
// Blast: shove every soldier corpse particle inside the radius.
function sdRagdollBlast(pos, radius, force) {
  for (let i = 0; i < ragdolls.length; i++) {
    const R = ragdolls[i].sd;
    if (!R) continue;
    let touched = false;
    for (let k = 0; k < 15; k++) {
      const dx = R.P[k * 3] - pos.x, dy = R.P[k * 3 + 1] - pos.y, dz = R.P[k * 3 + 2] - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const f = force * (1 - d / radius) * RD_H / (d || 1);
      R.Q[k * 3] -= dx * f; R.Q[k * 3 + 1] -= (Math.abs(dy) + 0.8) * f; R.Q[k * 3 + 2] -= dz * f;
      touched = true;
    }
    if (touched) sdWake(R);
  }
}

// ---- blood pools under settled corpses (small FIFO pool, one shared material) ----
const BLOOD_POOL = { max: 10, live: [] };
const bloodPoolMat = new THREE.MeshBasicMaterial({ map: TEX.bloodSplat, transparent: true, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
const bloodPoolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
function spawnBloodPool(x, z, size) {
  let m;
  if (BLOOD_POOL.live.length >= BLOOD_POOL.max) m = BLOOD_POOL.live.shift();
  else { m = new THREE.Mesh(bloodPoolGeo, bloodPoolMat); m.userData.vfx = true; m.renderOrder = 1; scene.add(m); }
  m.visible = true;
  m.position.set(x, 0.012, z);
  m.rotation.y = Math.random() * Math.PI * 2;
  m.scale.set(size, 1, size);
  BLOOD_POOL.live.push(m);
}
function clearBloodPools() {
  for (let i = 0; i < BLOOD_POOL.live.length; i++) scene.remove(BLOOD_POOL.live[i]);
  BLOOD_POOL.live.length = 0;
}
