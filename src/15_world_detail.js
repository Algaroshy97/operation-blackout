// ============ WORLD DETAIL: SET DRESSING, COVER, SKYLINE ============
'use strict';
// Static geometry sharing a material is merged into one mesh (one draw call).
// Anything that acts as cover gets an AABB collider + raycast mesh.
const _mm = new THREE.Matrix4(), _mq = new THREE.Quaternion(), _ms = new THREE.Vector3(), _mp = new THREE.Vector3(), _me = new THREE.Euler();
function xform(x, y, z, rx, ry, rz, sx, sy, sz) {
  _mp.set(x, y, z); _me.set(rx || 0, ry || 0, rz || 0); _mq.setFromEuler(_me); _ms.set(sx || 1, sy || 1, sz || 1);
  return new THREE.Matrix4().compose(_mp, _mq, _ms);
}
// Merge [{geo, m}] into a single non-indexed BufferGeometry (position/normal/uv).
function mergeGeos(parts) {
  let count = 0;
  const flat = parts.map(function (p) {
    const g = (p.geo.index ? p.geo.toNonIndexed() : p.geo.clone());
    g.applyMatrix4(p.m);
    count += g.attributes.position.count;
    return g;
  });
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of flat) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}
function addMerged(parts, mat, opts) {
  if (!parts.length) return null;
  opts = opts || {};
  const m = new THREE.Mesh(mergeGeos(parts), mat);
  m.castShadow = opts.shadow !== false; m.receiveShadow = true;
  scene.add(m);
  if (opts.raycast) raycastColliders.push(m);
  return m;
}
// UV-scaled box piece for merging
function boxPart(w, h, d, x, y, z, ry, texSize) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (texSize) boxWorldUV(g, w, h, d, texSize, (x * 31 + z * 17) | 0);
  return { geo: g, m: xform(x, y, z, 0, ry || 0, 0) };
}

const DETAIL = { lamps: [], wires: null };
(function buildWorldDetail() {
  const S = CFG.world.size;
  const concreteParts = [], darkMetal = [], railParts = [];

  // ---- Perimeter walls: concrete coping and pilasters ----
  for (const sgn of [-1, 1]) {
    concreteParts.push(boxPart(S + 4.4, 0.3, 1.4, 0, 6.15, sgn * S / 2, 0, 3));
    concreteParts.push(boxPart(1.4, 0.3, S + 4.4, sgn * S / 2, 6.15, 0, 0, 3));
    for (let k = -4; k <= 4; k++) {
      const t = k * 10;
      concreteParts.push(boxPart(1.1, 6, 0.5, t, 3, sgn * (S / 2 - 0.7), 0, 3));
      concreteParts.push(boxPart(0.5, 6, 1.1, sgn * (S / 2 - 0.7), 3, t, 0, 3));
    }
  }
  // ---- Central building: roof clutter (silhouette only; roof is not reachable) ----
  concreteParts.push(boxPart(18.4, 0.5, 0.4, 0, 7.15, -7.1, 0, 3), boxPart(18.4, 0.5, 0.4, 0, 7.15, 7.1, 0, 3));
  concreteParts.push(boxPart(0.4, 0.5, 14.2, -9.1, 7.15, 0, 0, 3), boxPart(0.4, 0.5, 14.2, 9.1, 7.15, 0, 0, 3));
  darkMetal.push(boxPart(1.8, 1.0, 1.3, -4, 7.4, -2.5), boxPart(1.8, 1.0, 1.3, 3.5, 7.4, 3), boxPart(1.2, 0.8, 1.2, 6, 7.3, -4.5));
  darkMetal.push(boxPart(0.08, 4.5, 0.08, 7, 9.1, 4.8), boxPart(1.2, 0.05, 0.05, 7, 10.8, 4.8), boxPart(0.9, 0.05, 0.05, 7, 11.2, 4.8));
  {
    const tank = new THREE.CylinderGeometry(1.0, 1.0, 1.7, 16);
    darkMetal.push({ geo: tank, m: xform(-6, 8.35, 4, 0, 0, 0) });
    for (const o of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) darkMetal.push(boxPart(0.1, 0.8, 0.1, -6 + o[0], 7.3, 4 + o[1]));
  }
  // ---- Stair railings (visual; rise 4.0 m over 8 m of run) ----
  for (const dir of [-1, 1]) {
    for (const side of [-1.72, 1.72]) {
      const z0 = dir * 14.0, z1 = dir * 6.4;
      const len = Math.hypot(z0 - z1, 4.0);
      const ang = Math.atan2(4.0, Math.abs(z0 - z1)) * dir;
      railParts.push({ geo: new THREE.BoxGeometry(0.06, 0.06, len), m: xform(side, 2.0 + 1.0, (z0 + z1) / 2, ang, 0, 0) });
      for (let i = 0; i <= 5; i++) {
        const z = z0 + (z1 - z0) * i / 5, y = 4.0 * i / 5;
        railParts.push(boxPart(0.05, 1.0, 0.05, side, y + 0.5, z));
      }
    }
  }
  // ---- Power poles + sagging cables along the north and west walls ----
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 9, 8);
  const polePts = [];
  for (let k = -3; k <= 3; k++) { polePts.push([-42.2, k * 13]); }
  const poleParts = [];
  for (const p of polePts) {
    poleParts.push({ geo: poleGeo, m: xform(p[0], 4.5, p[1]) });
    poleParts.push(boxPart(2.2, 0.14, 0.16, p[0], 8.4, p[1]));
    addCollider(p[0], 4.5, p[1], 0.32, 9, 0.32, 'wood');
  }
  addMerged(poleParts, MAT.wood, { raycast: true });
  {
    const pts = [];
    for (let i = 0; i < polePts.length - 1; i++) {
      for (const off of [-0.9, 0, 0.9]) {
        const a = polePts[i], b = polePts[i + 1];
        for (let s = 0; s < 12; s++) {
          const t0 = s / 12, t1 = (s + 1) / 12;
          const sag0 = Math.sin(t0 * Math.PI) * 1.1, sag1 = Math.sin(t1 * Math.PI) * 1.1;
          pts.push(a[0] + off, 8.45 - sag0, a[1] + (b[1] - a[1]) * t0, a[0] + off, 8.45 - sag1, a[1] + (b[1] - a[1]) * t1);
        }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const wires = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x0c0c0e }));
    wires.userData.vfx = true;
    scene.add(wires);
    DETAIL.wires = wires;
  }
  // ---- Street lamps (the grid is down: dead heads, one flickering) ----
  const lampSpots = [[-12, 27, 0], [12, 27, Math.PI], [-26.5, -3, -Math.PI / 2], [26.5, 3, Math.PI / 2], [12, -27, Math.PI], [-12, -27, 0]];
  const lampParts = [];
  const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.4 });
  for (let i = 0; i < lampSpots.length; i++) {
    const L = lampSpots[i];
    lampParts.push({ geo: new THREE.CylinderGeometry(0.07, 0.11, 6, 8), m: xform(L[0], 3, L[1]) });
    const ax = Math.cos(L[2]) * 0.9, az = -Math.sin(L[2]) * 0.9;
    lampParts.push({ geo: new THREE.BoxGeometry(1.8, 0.07, 0.07), m: xform(L[0] + ax * 0.5, 5.95, L[1] + az * 0.5, 0, L[2], 0) });
    addCollider(L[0], 3, L[1], 0.24, 6, 0.24);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.3), lampHeadMat.clone());
    head.position.set(L[0] + ax, 5.88, L[1] + az); head.rotation.y = L[2];
    head.castShadow = true;
    scene.add(head);
    DETAIL.lamps.push({ head: head, live: i === 1 || i === 4, phase: i * 1.7 });
  }
  addMerged(lampParts, MAT.dark, { raycast: true });

  addMerged(concreteParts, MAT.concrete2, { raycast: true });
  addMerged(darkMetal, MAT.dark, {});
  addMerged(railParts, MAT.dark, { shadow: false });

  // ---- Jersey barriers: extruded profile, low cover ----
  {
    const sh = new THREE.Shape();
    sh.moveTo(-0.3, 0); sh.lineTo(0.3, 0); sh.lineTo(0.3, 0.08); sh.lineTo(0.12, 0.3); sh.lineTo(0.08, 0.82); sh.lineTo(-0.08, 0.82); sh.lineTo(-0.12, 0.3); sh.lineTo(-0.3, 0.08); sh.closePath();
    const jg = new THREE.ExtrudeGeometry(sh, { depth: 3.0, bevelEnabled: false });
    jg.translate(0, 0, -1.5);
    // extrude UVs are in shape units; scale for the concrete tile
    const uv = jg.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.35, uv.getY(i) * 0.35);
    const spots = [[-4, 16.5, 0], [4, 16.5, 0], [-4, -16.5, 0], [4, -16.5, 0], [21.5, 4.5, 1], [21.5, -4.5, 1], [-21.5, 4.5, 1], [-21.5, -4.5, 1]];
    const parts = [];
    for (const s of spots) {
      // extruded along z: rotate 90° for barriers that should run along x
      parts.push({ geo: jg, m: xform(s[0], 0, s[1], 0, s[2] ? 0 : Math.PI / 2, 0) });
      if (s[2]) addCollider(s[0], 0.41, s[1], 0.6, 0.82, 3.0);
      else addCollider(s[0], 0.41, s[1], 3.0, 0.82, 0.6);
    }
    addMerged(parts, MAT.concrete, { raycast: true });
  }
  // ---- Sandbag nests flanking the central building ----
  {
    const bag = new THREE.SphereGeometry(1, 10, 6);
    const bagMat = surfMat({ color: 0xd8ccb0, map: TEX.sandbag.map, normalMap: TEX.sandbag.normalMap, roughness: 1 }, 'ground');
    const parts = [];
    for (const nest of [[-14.5, 0, 1], [14.5, 0, -1]]) {
      const cx = nest[0], cz = nest[1], face = nest[2];   // opening faces the building
      for (let row = 0; row < 3; row++) {
        const n = 7 - (row === 2 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const a = (-0.5 + (i + (row % 2) * 0.5) / (n - 0.5)) * Math.PI * 0.95;
          const r = 1.9;
          const x = cx - face * Math.cos(a) * r, z = cz + Math.sin(a) * r;
          parts.push({ geo: bag, m: xform(x, 0.16 + row * 0.27, z, 0, -a * face, 0, 0.2, 0.15, 0.36) });
        }
      }
      // three AABBs approximate the arc
      addCollider(cx - face * 1.85, 0.43, cz, 0.55, 0.86, 2.2);
      addCollider(cx - face * 1.05, 0.43, cz - 1.55, 1.3, 0.86, 0.55);
      addCollider(cx - face * 1.05, 0.43, cz + 1.55, 1.3, 0.86, 0.55);
    }
    const m = addMerged(parts, bagMat, { raycast: true });
    if (m) m.userData.surface = 'ground';
  }
  // ---- Burnt-out cars ----
  {
    const bodyMats = [0x3a3430, 0x4a2a24, 0x2e3438, 0x45402c].map(function (c) { return surfMat({ color: c, map: TEX.paint.map, normalMap: TEX.paint.normalMap, roughness: 0.75, metalness: 0.5, envMapIntensity: 0.6 }, 'metal'); });
    const glassMat = surfMat({ color: 0x0c1016, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.2 }, 'glass');
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
    const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14);
    const cars = [[9, 37, 0, 0], [-9, 38.5, 0, 1], [38.5, -4, 1, 2], [-38.5, 3, 1, 3]];
    for (const c of cars) {
      const g = new THREE.Group();
      const rot = c[2] ? Math.PI / 2 : 0;
      const body = new THREE.Mesh(boxWorldUV(new THREE.BoxGeometry(4.3, 0.75, 1.85), 4.3, 0.75, 1.85, 2, 5), bodyMats[c[3]]);
      body.position.y = 0.72;
      const hood = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 1.8), bodyMats[c[3]]);
      hood.position.set(1.55, 1.12, 0); hood.rotation.z = -0.08;
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 1.7), bodyMats[c[3]]);
      cabin.position.set(-0.3, 1.36, 0);
      const winF = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 1.6), glassMat);
      winF.position.set(0.82, 1.36, 0); winF.rotation.z = 0.45;
      const winS = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.36, 1.72), glassMat);
      winS.position.set(-0.3, 1.4, 0);
      g.add(body, hood, cabin, winF, winS);
      for (const w of [[1.35, 0.93], [-1.35, 0.93], [1.35, -0.93], [-1.35, -0.93]]) {
        if (c[3] === 2 && w[0] < 0 && w[1] > 0) continue;   // one car sits on its rim
        const wh = new THREE.Mesh(wheelGeo, tyreMat);
        wh.rotation.x = Math.PI / 2; wh.position.set(w[0], 0.36, w[1]);
        g.add(wh);
      }
      if (c[3] === 2) g.rotation.x = 0.04;
      g.position.set(c[0], 0, c[1]); g.rotation.y = rot + (c[3] === 1 ? 0.06 : 0);
      g.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.userData.surface = 'metal';
      scene.add(g);
      raycastColliders.push(g);
      const w = c[2] ? 1.9 : 4.3, d = c[2] ? 4.3 : 1.9;
      addCollider(c[0], 0.55, c[1], w, 1.1, d, 'metal');
      addCollider(c[0], 1.4, c[1], c[2] ? 1.7 : 2.4, 0.6, c[2] ? 2.4 : 1.7, 'metal');
    }
  }
  // ---- Rubble in the NW ruins and at the construction site ----
  {
    const rng = texRng(907);
    const rock = new THREE.DodecahedronGeometry(1, 0);
    const parts = [];
    const piles = [[-25, -25, 3.5, 26], [-31, -24, 2.5, 14], [24, 33, 2.5, 14], [-20, -30.8, 2, 10]];
    for (const p of piles) {
      for (let i = 0; i < p[3]; i++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * p[2], s = 0.12 + rng() * 0.35 * (1 - r / p[2] * 0.6);
        parts.push({ geo: rock, m: xform(p[0] + Math.cos(a) * r, s * 0.5, p[1] + Math.sin(a) * r, rng() * 3, rng() * 3, rng() * 3, s, s * 0.7, s * 1.2) });
      }
    }
    // tilted slabs
    parts.push(boxPart(2.6, 0.25, 1.6, -29.5, 0.45, -26, 0.3));
    parts[parts.length - 1].m = xform(-29.5, 0.45, -26, 0.35, 0.3, 0.1);
    addMerged(parts, MAT.concrete2, { raycast: false });
  }
  // ---- Puddles (mirror the dusk sky via the environment map) ----
  {
    const pm = surfMat({ color: 0x14161c, roughness: 0.04, metalness: 1.0, envMapIntensity: 1.3, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, 'ground');
    const rng = texRng(311);
    const parts = [];
    const spots = [[3, 20], [-6, 26], [16, -2], [-17, 10], [8, -24], [-3, -33], [30, 12], [-30, -12], [20, 30], [-26, 20]];
    for (const s of spots) {
      const circ = new THREE.CircleGeometry(1, 20);
      const pa = circ.attributes.position;
      for (let i = 1; i < pa.count; i++) {   // wobble the rim
        const k = 0.75 + rng() * 0.4;
        pa.setXY(i, pa.getX(i) * k, pa.getY(i) * k);
      }
      parts.push({ geo: circ, m: xform(s[0], 0.012, s[1], -Math.PI / 2, 0, rng() * 3, 1.1 + rng() * 1.6, 0.7 + rng() * 0.8, 1) });
    }
    addMerged(parts, pm, { shadow: false }).renderOrder = 2;
  }
  // ---- Road markings on the east-west avenue ----
  {
    const paintY = surfMat({ color: 0xb8942c, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }, 'ground');
    const paintW = surfMat({ color: 0xb0b0aa, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }, 'ground');
    const plane = new THREE.PlaneGeometry(1, 1);
    const yel = [], wht = [];
    for (const sgn of [-1, 1]) {
      for (let x = 12; x < 43; x += 3) yel.push({ geo: plane, m: xform(sgn * (x + 0.6), 0.008, 0, -Math.PI / 2, 0, 0, 1.3, 0.14, 1) });
      wht.push({ geo: plane, m: xform(sgn * 27.5, 0.008, 4.6, -Math.PI / 2, 0, 0, 31, 0.12, 1) });
      wht.push({ geo: plane, m: xform(sgn * 27.5, 0.008, -4.6, -Math.PI / 2, 0, 0, 31, 0.12, 1) });
      for (let i = 0; i < 7; i++) wht.push({ geo: plane, m: xform(sgn * 11, 0.008, -3.6 + i * 1.2, -Math.PI / 2, 0, 0, 2.2, 0.5, 1) });   // crosswalk
    }
    addMerged(yel, paintY, { shadow: false });
    addMerged(wht, paintW, { shadow: false });
  }
  // ---- Stencilled signage on the perimeter walls ----
  {
    function signTex(lines, bg, fg) {
      const cv = texCanvas(256, 128), g = cv.g;
      g.fillStyle = bg; g.fillRect(0, 0, 256, 128);
      g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(8, 8, 240, 112);
      g.fillStyle = fg; g.textAlign = 'center'; g.font = 'bold 34px Arial';
      lines.forEach(function (l, i) { g.fillText(l, 128, 56 + i * 40 - (lines.length - 1) * 14); });
      const t = new THREE.CanvasTexture(cv.c); t.encoding = THREE.sRGBEncoding; return t;
    }
    const signs = [
      [['RESTRICTED', 'AREA'], '#c9a227', '#141414', 0, 2.6, -44.45, 0],
      [['BLACKOUT', 'CURFEW 1900'], '#a8261c', '#f0e8d8', 44.45, 2.4, 10, -Math.PI / 2],
      [['NO ENTRY'], '#d8d4c8', '#a8261c', -44.45, 2.2, -20, Math.PI / 2],
      [['SECTOR 7', 'EVAC ROUTE'], '#2a4a7a', '#f0f0f0', -10, 2.5, 44.45, Math.PI]
    ];
    for (const s of signs) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), new THREE.MeshStandardMaterial({ map: signTex(s[0], s[1], s[2]), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.position.set(s[3], s[4], s[5]); m.rotation.y = s[6];
      m.userData.vfx = true;
      scene.add(m);
    }
  }
  // ---- Distant skyline: dark towers with scattered lit windows ----
  {
    const rng = texRng(1201);
    const parts = [];
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + rng() * 0.08;
      const r = 105 + rng() * 60;
      const w = 12 + rng() * 16, d = 12 + rng() * 16, h = 14 + rng() * (BUILD_DETAIL >= 1 ? 50 : 32);
      const g = new THREE.BoxGeometry(w, h, d);
      boxWorldUV(g, w, h, d, 24, i * 7);
      parts.push({ geo: g, m: xform(Math.cos(a) * r, h / 2 - 0.5, Math.sin(a) * r, 0, rng() * Math.PI, 0) });
    }
    const skyMat = new THREE.MeshStandardMaterial({ color: 0x2a2c34, map: TEX.skyline, emissiveMap: TEX.skyline, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.9, fog: true });
    addMerged(parts, skyMat, { shadow: false });
  }
})();

function updateWorldDetail(t) {
  for (let i = 0; i < DETAIL.lamps.length; i++) {
    const L = DETAIL.lamps[i];
    if (!L.live) continue;
    // failing ballast: mostly on, with irregular stutters
    const f = Math.sin(t * 2.3 + L.phase) + Math.sin(t * 7.9 + L.phase * 3) * 0.6;
    L.head.material.emissiveIntensity = f > 0.9 ? 0.2 : 3.2;
  }
}
