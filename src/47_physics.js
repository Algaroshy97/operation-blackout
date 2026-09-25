// ============ LIGHTWEIGHT RIGID-BODY PHYSICS ============
'use strict';
// Sphere-vs-world collision (ground plane + every static AABB) with restitution
// and Coulomb-style friction. Shared by grenades, their trajectory preview, and
// debris chunks so everything that bounces obeys the same rules — and lands on
// roofs and ledges instead of only on the ground plane.
const _phN = new THREE.Vector3();
// Returns the largest upward contact-normal component this step (0 = airborne),
// so callers can tell "resting on something" from "bouncing off a wall".
function sphereVsWorld(p, v, r, restitution, friction) {
  let groundN = 0;
  if (p.y < GROUND + r) {
    p.y = GROUND + r;
    if (v.y < 0) {
      v.y = -v.y * restitution;
      v.x *= 1 - friction; v.z *= 1 - friction;
    }
    groundN = 1;
  }
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (p.x < c.min.x - r || p.x > c.max.x + r || p.y < c.min.y - r || p.y > c.max.y + r || p.z < c.min.z - r || p.z > c.max.z + r) continue;
    const qx = Math.max(c.min.x, Math.min(c.max.x, p.x));
    const qy = Math.max(c.min.y, Math.min(c.max.y, p.y));
    const qz = Math.max(c.min.z, Math.min(c.max.z, p.z));
    let dx = p.x - qx, dy = p.y - qy, dz = p.z - qz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r * r) continue;
    let pen;
    if (d2 < 1e-10) {
      // centre inside the box: exit through the nearest face
      const pens = [p.x - c.min.x, c.max.x - p.x, p.y - c.min.y, c.max.y - p.y, p.z - c.min.z, c.max.z - p.z];
      let k = 0;
      for (let j = 1; j < 6; j++) if (pens[j] < pens[k]) k = j;
      _phN.set(k === 0 ? -1 : k === 1 ? 1 : 0, k === 2 ? -1 : k === 3 ? 1 : 0, k === 4 ? -1 : k === 5 ? 1 : 0);
      pen = pens[k] + r;
    } else {
      const d = Math.sqrt(d2);
      _phN.set(dx / d, dy / d, dz / d);
      pen = r - d;
    }
    p.addScaledVector(_phN, pen);
    const vn = v.dot(_phN);
    if (vn < 0) {
      // split into normal + tangential parts: bounce the first, rub the second
      v.addScaledVector(_phN, -vn);               // tangential only
      v.multiplyScalar(1 - friction);
      v.addScaledVector(_phN, -vn * restitution);  // reflected normal
    }
    if (_phN.y > groundN) groundN = _phN.y;
  }
  return groundN;
}

// ---- Debris: short-lived tumbling chunks (barrel shrapnel, lids, rubble) ----
const debris = [];
const DEBRIS_MAX = 36;
const _dbAxis = new THREE.Vector3();
const _dbQ = new THREE.Quaternion();
function spawnDebris(mesh, pos, vel, radius, life) {
  if (debris.length >= DEBRIS_MAX) removeDebris(0);
  mesh.position.copy(pos);
  mesh.castShadow = true;
  mesh.userData.vfx = true;
  scene.add(mesh);
  debris.push({
    m: mesh, v: vel.clone(), r: radius || 0.12, life: life || 7, sleep: false,
    w: new THREE.Vector3((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16)
  });
}
function removeDebris(i) {
  const d = debris[i];
  scene.remove(d.m);
  if (d.m.userData.ownsGeometry && d.m.geometry) d.m.geometry.dispose();
  debris.splice(i, 1);
}
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    if (d.life <= 0) { removeDebris(i); continue; }
    if (d.life < 1) d.m.position.y -= dt * 0.25;   // sink out instead of popping
    if (d.sleep) continue;
    d.v.y -= 15 * dt;
    d.m.position.addScaledVector(d.v, dt);
    const g = sphereVsWorld(d.m.position, d.v, d.r, 0.3, 0.25);
    if (g > 0.6) d.w.multiplyScalar(Math.exp(-6 * dt));
    const wl = d.w.length();
    if (wl > 1e-3) {
      _dbAxis.copy(d.w).multiplyScalar(1 / wl);
      _dbQ.setFromAxisAngle(_dbAxis, wl * dt);
      d.m.quaternion.premultiply(_dbQ);
    }
    if (g > 0.6 && d.v.lengthSq() < 0.05 && wl < 0.5) d.sleep = true;
  }
}
function clearDebris() { while (debris.length) removeDebris(debris.length - 1); }
