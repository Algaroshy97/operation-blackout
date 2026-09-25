// ============ ENEMIES & AI ============
'use strict';
// Soldiers are articulated procedural rigs (38_soldier.js) on every platform.
// Kinds: 0 runner (melee, lunges) · 1 rifleman (cover, bursts) · 2 heavy (armoured,
// charges) · 3 grenadier (keeps distance, lobs grenades). All ranged fire is real
// hitscan against the world, so cover and crouching genuinely protect the player.
const enemies = [];
let meleeHits = [];   // timestamps of landed melee hits (global damage cap)
// flash material swapped in for a few frames when hit
const HIT_FLASH = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.35, 0.3).multiplyScalar(1.6) });
const _upV = new THREE.Vector3(0, 1, 0);

function spawnEnemy(kind, x, z) {
  const parts = buildSoldier(kind);
  const scale = kind === 2 ? 1.2 : 1;
  parts.group.scale.set(scale, scale, scale);
  const baseHp = kind === 0 ? CFG.ai.maxHealth : kind === 1 ? CFG.ai.maxHealth * 1.35 : kind === 3 ? CFG.ai.maxHealth * 1.1 : 320;
  const curWave = typeof getWaveNum === 'function' ? getWaveNum() : (typeof waveNum !== 'undefined' ? waveNum : 1);
  const waveMul = Math.min(2.2, 1 + 0.06 * (Math.max(1, curWave) - 1));
  const hp = Math.round(baseHp * waveMul * diff().hp);
  const dx = player.pos.x - x, dz = player.pos.z - z;
  const initYaw = (dx !== 0 || dz !== 0) ? Math.atan2(dx, dz) : 0;
  const en = {
    kind: kind,               // 0=runner(melee), 1=rifleman, 2=heavy, 3=grenadier
    scale: scale,
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(),
    knock: new THREE.Vector3(),   // external impulse velocity (bullets, blasts)
    yaw: initYaw, bodyYaw: initYaw,
    health: hp, maxHealth: hp,
    dead: false, deathT: 0,
    parts: parts,
    state: 'spawn',
    stateT: 0,
    nextShot: 0, burst: 0, aimT: 0, suppress: 0, alerted: false,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    strafeT: 0,
    speedMul: 0.85 + Math.random() * 0.3,
    attackT: 0,
    flashT: 0, staggerT: 0, crouch: 0, cover: null, peekT: 0,
    grenadeT: 4 + Math.random() * 4, chargeT: 0, chargeCd: 3 + Math.random() * 3, lungeT: 0, lungeCd: 0,
    zig: Math.random() * 10, lastShotT: -9, seenT: -9, fleeT: 0,
    hitBody: parts.hitBody,
    hitHead: parts.hitHead
  };
  // every visible mesh resolves bullet hits to this enemy; hitboxes mark head / legs
  parts.group.traverse(function (o) {
    if (o.isMesh) o.userData = { enemyRef: en, isHead: false, enemyFlesh: true };
  });
  parts.hitBody.userData = { enemyRef: en, isHead: false };
  parts.hitHead.userData = { enemyRef: en, isHead: true };
  parts.hitLegs.userData = { enemyRef: en, isHead: false, isLegs: true };
  // Place the mesh immediately; otherwise it renders and raycasts at the world origin for its first frame.
  parts.group.position.set(x, 0, z);
  parts.group.rotation.y = initYaw;
  scene.add(parts.group);
  parts.group.updateMatrixWorld(true);
  enemies.push(en);
  return en;
}

// Geometry and materials are shared with the per-kind template: nothing to free
// except the ragdoll container a dead soldier's parts were moved into.
function disposeEnemyGeometry(en) {
  if (!en) return;
  disposeRagdoll(en);
}

// Hit flash: swap every visible mesh to a bright material for a few frames.
function setHitFlash(en, on) {
  en.parts.group.traverse(function (o) {
    if (!o.isMesh || o === en.hitBody || o === en.hitHead || o === en.parts.hitLegs) return;
    if (on) { if (!o.userData.baseMat) o.userData.baseMat = o.material; o.material = HIT_FLASH; }
    else if (o.userData.baseMat) { o.material = o.userData.baseMat; o.userData.baseMat = null; }
  });
}
// dmg already includes weapon/range/head multipliers. dir = bullet direction (optional).
function damageEnemy(en, dmg, point, isHead, dir, explosive) {
  if (en.dead) return;
  // armour: heavies shrug off part of body damage
  let d = dmg;
  if (en.kind === 2 && !isHead && !explosive) d *= 0.7;
  en.health -= d;
  const kill = en.health <= 0;
  showHitmarker(isHead, kill);
  spawnBlood(point, isHead, dir);
  spawnDamageNumber(point, d, isHead, kill);
  if (!en.flashT) setHitFlash(en, true);
  en.flashT = 0.07;
  en.alerted = true;
  // impulse: bullets nudge, big hits stagger, the torso/head physically recoil
  const imp = en.hitImpulse || Math.min(3, d / 30);
  if (dir) en.knock.addScaledVector(dir, Math.min(3, imp * 0.35) * (en.kind === 2 ? 0.3 : 1));
  if (en.blastImpulse) { en.knock.x += en.blastImpulse.x; en.knock.z += en.blastImpulse.z; }
  if (d > 45 || isHead) en.staggerT = Math.max(en.staggerT, en.kind === 2 ? 0.15 : 0.35);
  soldierHitReact(en, dir, d / 45, isHead);
  en.hitDir = dir ? dir.clone() : null;
  en.hitPoint = point ? point.clone() : null;
  en.lastImpulse = imp;
  if (kill) killEnemy(en, isHead, explosive);
  else {
    en.stateT = 0;
    if (en.state === 'idle') en.state = 'chase';
    if (en.kind === 1 && en.health < en.maxHealth * 0.5 && !en.cover) en.wantCover = true;
  }
  en.blastImpulse = null;
  en.hitImpulse = 0;
}

function killEnemy(en, isHead, explosive) {
  en.dead = true; en.deathT = 0;
  if (en.flashT) { setHitFlash(en, false); en.flashT = 0; }
  const bonus = en.kind === 2 ? 80 : en.kind === 3 ? 40 : en.kind === 1 ? 20 : 0;
  addScore(CFG.score.kill + bonus + (isHead ? CFG.score.headshot : 0), (isHead ? 'Headshot · ' : '') + ['Runner', 'Rifleman', 'Heavy', 'Grenadier'][en.kind] + ' down');
  if (typeof bulletCtx !== 'undefined' && bulletCtx.wallbang) addScore(60, 'WALLBANG');
  registerKillT();   // multi-kill streak bonus (2+ kills within 4 s)
  kills++;
  if (isHead) headshots++;
  dropPickup(en.pos);
  playSound('kill');
  const dist = Math.hypot(en.pos.x - player.pos.x, en.pos.z - player.pos.z);
  if (isHead && !explosive && curW().type === 'SR' && dist > 18) triggerSlowmo(0.35);
  // the weapon falls as a physics object
  const p = en.parts;
  p.group.updateMatrixWorld(true);
  if (p.gun && p.gun.parent) {
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    p.gun.matrixWorld.decompose(wp, wq, ws);
    p.gun.parent.remove(p.gun);
    const gun = p.gun;   // geometry stays shared with the template (debris never disposes it)
    gun.quaternion.copy(wq); gun.scale.copy(ws);
    gun.traverse(function (o) { if (o.isMesh) o.userData = { vfx: true }; });
    const dir = en.hitDir || new THREE.Vector3();
    spawnDebris(gun, wp, new THREE.Vector3(dir.x * 2 + (Math.random() - 0.5), 1.5 + Math.random() * 1.5, dir.z * 2 + (Math.random() - 0.5)), 0.15, 8);
  }
  // hand over to the Verlet ragdoll (impulse at the particle nearest the killing hit)
  const dir = en.hitDir || new THREE.Vector3(en.pos.x - player.pos.x, 0.1, en.pos.z - player.pos.z).normalize();
  startRagdoll(en, dir, 2.5 + (en.lastImpulse || 2) * 0.9 + (isHead ? 1 : 0), en.hitPoint, explosive);
  p.hitBody.userData.enemyRef = null; p.hitHead.userData.enemyRef = null; p.hitLegs.userData.enemyRef = null;
}

// ---- Steering: flow field / direct pursuit / tactical goals + obstacle pushout ----
const _steer = { x: 0, z: 0 };
function moveEnemy(en, dt, desiredX, desiredZ, speed) {
  // accelerate toward the desired velocity (no instant turns), plus impulses
  const acc = en.kind === 2 ? 6 : 10;
  en.vel.x += (desiredX * speed - en.vel.x) * Math.min(1, acc * dt);
  en.vel.z += (desiredZ * speed - en.vel.z) * Math.min(1, acc * dt);
  en.knock.multiplyScalar(Math.exp(-6 * dt));
  en.pos.x += (en.vel.x + en.knock.x) * dt;
  en.pos.z += (en.vel.z + en.knock.z) * dt;
  // obstacle pushout (AABB vs point with radius) + step-up allowance
  const r = 0.4 * (en.kind === 2 ? 1.4 : 1);
  const stepH = 0.60;
  const feet = en.pos.y;
  const head = en.pos.y + (en.kind === 2 ? 2.3 : 1.85);
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.min.y >= head + 0.2) continue;
    if (c.max.y <= feet + stepH) continue;
    if (feet >= c.max.y - 0.001) continue;
    const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
    const ex = (c.max.x - c.min.x) * 0.5 + r, ez = (c.max.z - c.min.z) * 0.5 + r;
    const dx = en.pos.x - cx, dz = en.pos.z - cz;
    if (Math.abs(dx) > ex || Math.abs(dz) > ez) continue;
    const px = ex - Math.abs(dx), pz = ez - Math.abs(dz);
    if (px < pz) { en.pos.x = cx + (dx >= 0 ? ex : -ex); en.vel.x *= 0.3; en.bumped = true; }
    else { en.pos.z = cz + (dz >= 0 ? ez : -ez); en.vel.z *= 0.3; en.bumped = true; }
  }
  en.pos.x = Math.max(-mapBounds, Math.min(mapBounds, en.pos.x));
  en.pos.z = Math.max(-mapBounds, Math.min(mapBounds, en.pos.z));

  // Vertical resolve: find highest floor below feet + stepH
  let floorY = GROUND;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
    const ex = (c.max.x - c.min.x) * 0.5, ez = (c.max.z - c.min.z) * 0.5;
    const dx = en.pos.x - cx, dz = en.pos.z - cz;
    if (Math.abs(dx) > ex || Math.abs(dz) > ez) continue;
    if (c.max.y <= feet + stepH && c.max.y > floorY) floorY = c.max.y;
  }
  const fallSpeed = 6;
  if (floorY < en.pos.y) {
    const needed = en.pos.y - floorY;
    en.pos.y -= Math.min(needed, dt * fallSpeed);
  } else if (floorY > en.pos.y && (floorY - en.pos.y) <= stepH) {
    const needed = floorY - en.pos.y;
    en.pos.y += Math.min(needed, dt * fallSpeed);
  }
}
// direction toward a goal: flow field when routing to the player, else straight line
function steerToPlayer(en, out) {
  const tp = playerAimPoint();
  const dx = tp.x - en.pos.x, dz = tp.z - en.pos.z, d = Math.hypot(dx, dz) || 1;
  const sameLevel = Math.abs((player.pos.y - eyeHeight()) - en.pos.y) < 1.2;
  const elevated = en.pos.y > 2.2;
  // close and in sight (or both upstairs): go straight; otherwise follow the flow field
  if ((sameLevel && d < 7 && en._losCache) || elevated || (playerElevated() && isOnStairs(en))) { out.x = dx / d; out.z = dz / d; return d; }
  if (!navDirTo(en.pos.x, en.pos.z, out)) { out.x = dx / d; out.z = dz / d; }
  return d;
}
function isOnStairs(en) { return Math.abs(en.pos.x) < 2.2 && Math.abs(en.pos.z) > 6 && Math.abs(en.pos.z) < 16; }
function steerToPoint(en, x, z, out) {
  const dx = x - en.pos.x, dz = z - en.pos.z, d = Math.hypot(dx, dz) || 1;
  out.x = dx / d; out.z = dz / d;
  return d;
}

// LOS check: ray from enemy eye to player eye against static world
const losRay = new THREE.Raycaster();
const _losFrom = new THREE.Vector3();
const _losTo = new THREE.Vector3();
let losFrame = 0;   // round-robin: each enemy checks LOS at most every 3 frames
function enemyEye(en, out) {
  return out.set(en.pos.x, en.pos.y + (1.55 - en.crouch * 0.4) * (en.scale || 1), en.pos.z);
}
function hasLOS(en) {
  // throttle: max 1/3 of enemies per frame do the raycast
  if (en._losSkip === undefined) en._losSkip = 0;
  if (losFrame % 3 !== en._losSkip) { if (en._losCache === undefined) return false; return en._losCache; }
  enemyEye(en, _losFrom);
  _losTo.copy(playerAimPoint());
  _losTo.x += (Math.random() - 0.5) * 0.3; _losTo.z += (Math.random() - 0.5) * 0.3;
  const far = _losFrom.distanceTo(_losTo);
  losRay.set(_losFrom, _losTo.sub(_losFrom).normalize());
  losRay.far = far;
  const hits = losRay.intersectObjects(raycastColliders, true);
  let blocked = false;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].distance < losRay.far - 0.2 && surfaceOf(hits[i].object) !== 'glass') { blocked = true; break; }
  }
  en._losCache = !blocked;
  if (!blocked) en.seenT = gameT;
  return !blocked;
}
const tmpV2 = new THREE.Vector3();

// ---- Cover: a spot behind an obstacle relative to the player, reachable on the grid ----
const _covP = new THREE.Vector3(), _covTo = new THREE.Vector3();
function findCover(en) {
  let best = null, bestScore = Infinity;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const h = c.max.y - c.min.y;
    if (c.min.y > 0.3 || c.max.y < 0.8 || h > 7 || c.barrel) continue;
    const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
    const dEn = Math.hypot(cx - en.pos.x, cz - en.pos.z);
    if (dEn > 14) continue;
    // stand on the far side of the box from the player
    let ax = cx - player.pos.x, az = cz - player.pos.z; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    const ext = Math.abs(ax) * (c.max.x - c.min.x) * 0.5 + Math.abs(az) * (c.max.z - c.min.z) * 0.5;
    const px = cx + ax * (ext + 0.75), pz = cz + az * (ext + 0.75);
    if (!navReachable(px, pz)) continue;
    const dPl = Math.hypot(px - player.pos.x, pz - player.pos.z);
    if (dPl < 8 || dPl > 34) continue;
    // hidden from the player's eye at crouch height?
    _covP.set(px, 0.9, pz); _covTo.copy(player.pos).sub(_covP);
    const far = _covTo.length(); _covTo.normalize();
    losRay.set(_covP, _covTo); losRay.far = far;
    const hits = losRay.intersectObjects(raycastColliders, true);
    if (!hits.length || hits[0].distance > far - 0.3) continue;
    const score = dEn + Math.abs(dPl - 20) * 0.4 + (c.max.y < 1.3 ? -2 : 0);   // prefer low cover (peek over)
    if (score < bestScore) { bestScore = score; best = { x: px, z: pz, low: c.max.y < 1.4 }; }
  }
  return best;
}

// Suppression + hearing hooks called by the player's weapon.
function bulletNearMiss(from, dir, endDist, suppressed) {
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    tmpV2.set(en.pos.x - from.x, en.pos.y + 1.3 - from.y, en.pos.z - from.z);
    const t = tmpV2.dot(dir);
    if (t < 0 || t > endDist + 1) continue;
    const d2 = tmpV2.lengthSq() - t * t;
    if (d2 < 2.2 * 2.2) { en.suppress = Math.min(1, en.suppress + (suppressed ? 0.15 : 0.3)); en.alerted = true; }
  }
}
function alertEnemiesTo(pos, radius) {
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (!en.dead && Math.hypot(en.pos.x - pos.x, en.pos.z - pos.z) < radius) en.alerted = true;
  }
}

function updateEnemies(dt) {
  losFrame++;
  updateNav(dt);
  for (let i = enemies.length - 1; i >= 0; i--) {
    const en = enemies[i];
    if (en._losSkip === undefined) en._losSkip = i % 3;
    if (en.flashT > 0) { en.flashT -= dt; if (en.flashT <= 0) { en.flashT = 0; setHitFlash(en, false); } }
    if (en.dead) {
      en.deathT += dt;
      updateRagdoll(en, dt);
      if (en.deathT > 11) {
        disposeEnemyGeometry(en);
        enemies.splice(i, 1);
      }
      continue;
    }
    // DEAD PLAYER: stop all AI activity — enemies idle, never attack a corpse
    en.stateT += dt;
    const dist = en.pos.distanceTo(player.pos);
    if (player.dead) {
      if (en.state !== 'idle') { en.state = 'idle'; en.stateT = 0; en.swinging = undefined; }
      moveEnemy(en, dt, 0, 0, 0);
      animateEnemy(en, dt, dist);
      continue;
    }
    en.suppress = Math.max(0, en.suppress - dt * 0.35);
    en.staggerT = Math.max(0, en.staggerT - dt);
    const los = hasLOS(en);
    en.aimT = los ? Math.min(1.5, en.aimT + dt * (en.alerted ? 1.4 : 0.9)) : Math.max(0, en.aimT - dt * 1.5);
    let dirX = 0, dirZ = 0, speed = 0;
    const toP = steerToPlayer(en, _steer);
    const px = _steer.x, pz = _steer.z;
    // flee live player grenades that are about to go off
    let fleeing = false;
    for (let k = 0; k < liveGrenades.length; k++) {
      const g = liveGrenades[k];
      if (g.enemy) continue;
      const gx = en.pos.x - g.m.position.x, gz = en.pos.z - g.m.position.z, gd = Math.hypot(gx, gz);
      if (gd < CFG.grenade.radius + 1 && g.fuse < 1.8 && en.kind !== 2) { dirX = gx / (gd || 1); dirZ = gz / (gd || 1); speed = CFG.ai.chaseSpeed; fleeing = true; break; }
    }
    if (en.state === 'spawn') {
      if (en.stateT > 0.5) { en.state = 'chase'; en.stateT = 0; }
    } else if (!fleeing) {
      if (en.kind === 0) {
        // runner: zig-zag approach, lunge from mid range
        en.state = 'chase';
        en.zig += dt * 2.2;
        const zz = dist > 6 && dist < 26 ? Math.sin(en.zig) * 0.55 : 0;
        dirX = px - pz * zz; dirZ = pz + px * zz;
        const l = Math.hypot(dirX, dirZ) || 1; dirX /= l; dirZ /= l;
        speed = CFG.ai.chaseSpeed * en.speedMul;
        en.lungeCd = Math.max(0, en.lungeCd - dt);
        if (en.lungeT > 0) { en.lungeT -= dt; speed = 9.5; }
        else if (dist > 3.2 && dist < 6 && los && en.lungeCd <= 0) { en.lungeT = 0.35; en.lungeCd = 3; playSound3D('melee', en.pos.x, 1, en.pos.z); }
      } else if (en.kind === 2) {
        // heavy: slow advance; roar, wind up, then a straight-line charge
        en.chargeCd = Math.max(0, en.chargeCd - dt);
        if (en.state === 'windup') {
          speed = 0;
          if (en.stateT > 0.8) { en.state = 'charge'; en.stateT = 0; en.chargeDir = { x: px, z: pz }; }
        } else if (en.state === 'charge') {
          dirX = en.chargeDir.x; dirZ = en.chargeDir.z; speed = 8.5;
          if (dist < 1.9) {
            // slam
            damagePlayer((30 + waveNum * 0.6) * diff().dmg, dirToDeg(en));
            player.vel.x += dirX * 9; player.vel.z += dirZ * 9; player.vel.y = 3;
            addTrauma(0.55); playSound('melee');
            en.state = 'chase'; en.stateT = 0; en.chargeCd = 7;
          } else if (en.bumped && en.stateT > 0.15) {
            en.staggerT = 1.3; en.state = 'chase'; en.stateT = 0; en.chargeCd = 6; addTrauma(Math.max(0, 0.3 - dist * 0.01));
          } else if (en.stateT > 1.6) { en.state = 'chase'; en.stateT = 0; en.chargeCd = 5; }
        } else {
          en.state = 'chase';
          dirX = px; dirZ = pz; speed = 2.3 * en.speedMul;
          if (los && dist > 6 && dist < 15 && en.chargeCd <= 0 && Math.abs(player.pos.y - eyeHeight() - en.pos.y) < 0.8) {
            en.state = 'windup'; en.stateT = 0; playSound3D('roar', en.pos.x, 1.5, en.pos.z, false, 60);
          }
        }
      } else {
        // rifleman / grenadier: advance -> engage (burst fire) -> reposition / take cover
        const band = en.kind === 3 ? [14, 26] : [10, 30];
        if (en.wantCover || (en.suppress > 0.6 && !en.cover && en.kind === 1)) {
          en.wantCover = false;
          if (gameT - (en.coverSearchT || -9) > 2) { en.coverSearchT = gameT; const c = findCover(en); if (c) { en.cover = c; en.state = 'tocover'; en.stateT = 0; } }
        }
        if (en.state === 'tocover' && en.cover) {
          const d = steerToPoint(en, en.cover.x, en.cover.z, _steer);
          dirX = _steer.x; dirZ = _steer.z; speed = CFG.ai.chaseSpeed * 0.95;
          if (d < 0.5) { en.state = 'incover'; en.stateT = 0; en.peekT = 1 + Math.random(); }
          if (en.stateT > 5) { en.cover = null; en.state = 'chase'; }
        } else if (en.state === 'incover' && en.cover) {
          // crouch behind cover, periodically pop up / lean out to fire
          en.peekT -= dt;
          const peeking = en.peekT < 0;
          if (en.peekT < -1.8) en.peekT = 1.2 + Math.random() * 1.5;
          en.crouchTarget = peeking ? (en.cover.low ? 0 : 0.2) : 1;
          if (peeking && !en.cover.low) { dirX = -pz * en.strafeDir; dirZ = px * en.strafeDir; speed = 1.4; }
          else { steerToPoint(en, en.cover.x, en.cover.z, _steer); const cd = Math.hypot(en.cover.x - en.pos.x, en.cover.z - en.pos.z); if (cd > 0.3) { dirX = _steer.x; dirZ = _steer.z; speed = 1.5; } }
          if (en.stateT > 9 || dist < 6) { en.cover = null; en.state = 'chase'; en.stateT = 0; }
        } else if (los && dist < band[1] && Math.abs(player.pos.y - eyeHeight() - en.pos.y) < 6) {
          if (en.state !== 'engage') { en.state = 'engage'; en.stateT = 0; en.strafeT = 1 + Math.random() * 2; }
          // hold the band: back off if too close, strafe otherwise
          en.strafeT -= dt;
          if (en.strafeT <= 0) { en.strafeDir *= -1; en.strafeT = 1.2 + Math.random() * 2; en.crouchTarget = Math.random() < 0.4 ? 1 : 0; }
          const away = dist < band[0] ? -0.8 : 0;
          dirX = -pz * en.strafeDir * 0.8 + px * away; dirZ = px * en.strafeDir * 0.8 + pz * away;
          speed = CFG.ai.rangedSpeed * (en.crouchTarget ? 0.5 : 1) * (en.suppress > 0.5 ? 0.6 : 1);
          if (en.stateT > 7 && en.kind === 1 && Math.random() < dt * 0.4) en.wantCover = true;
        } else {
          en.state = 'chase'; en.crouchTarget = 0;
          dirX = px; dirZ = pz; speed = CFG.ai.speed * en.speedMul;
        }
      }
    }
    if (en.staggerT > 0) speed *= 0.15;
    const l = Math.hypot(dirX, dirZ);
    if (l > 1e-3) { dirX /= l; dirZ /= l; }
    en.bumped = false;
    moveEnemy(en, dt, dirX, dirZ, speed);
    en.crouch += ((en.crouchTarget || 0) - en.crouch) * Math.min(1, 6 * dt);
    // positional enemy footsteps: cadence scales with enemy speed, throttled globally
    const vsp = Math.hypot(en.vel.x, en.vel.z);
    if (en.state !== 'spawn' && dist < 30 && vsp > 0.6) {
      if (en.stepT === undefined) en.stepT = Math.random() * 0.5;
      en.stepT -= dt * vsp / 2.6;
      if (en.stepT <= 0) {
        if (gameT > nextEstepT) { playSound3D('estep', en.pos.x, en.pos.y, en.pos.z, !los); nextEstepT = gameT + 0.08; }
        en.stepT = 0.55;
      }
    }
    // face the player (charging heavies face their charge direction)
    const tp = playerAimPoint();
    const fdx = en.state === 'charge' ? en.chargeDir.x : tp.x - en.pos.x, fdz = en.state === 'charge' ? en.chargeDir.z : tp.z - en.pos.z;
    const targetYaw = Math.atan2(fdx, fdz);
    let dyaw = targetYaw - en.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    en.yaw += dyaw * Math.min(1, (en.kind === 2 ? 5 : 10) * dt);
    // keep enemies out of the player's body: stop-and-hold at melee distance
    const stopDist = en.kind === 2 ? 2.6 : 1.9;
    if (dist < stopDist && (en.kind === 0 || en.kind === 2)) {
      const overlap = stopDist - dist;
      if (overlap > 0) {
        const nx = (en.pos.x - player.pos.x) / (dist || 1), nz = (en.pos.z - player.pos.z) / (dist || 1);
        en.pos.x += nx * overlap; en.pos.z += nz * overlap;
      }
    }
    // melee attack (runners + heavies): staggered windup, damage cap, real cooldown
    const canMelee = (en.kind === 0 || en.kind === 2) && en.state !== 'charge' && en.state !== 'windup' && en.staggerT <= 0;
    const reach = en.kind === 2 ? CFG.ai.attackRange + 0.9 : CFG.ai.attackRange + 0.4;
    if (canMelee && dist < reach && en.swinging === undefined && gameT > (en.attackReadyT || 0)) {
      // stagger windups so a pack doesn't land one synced nuke
      const stagger = 0.25 + Math.random() * 0.45;
      en.swinging = stagger;                   // windup (telegraphed)
      en.swingDur = stagger;
    }
    if (en.swinging !== undefined) {
      en.swinging -= dt;
      if (en.swinging <= 0 && en.swinging > -1) {
        // swing lands — only if still in reach and player alive
        if (dist < reach + 0.35 && !player.dead) {
          // global melee damage cap: max 2 melee hits landing within any 0.8s window
          const now = gameT;
          meleeHits = meleeHits.filter(t => now - t < 0.8);
          if (meleeHits.length < 2) {
            damagePlayer((CFG.ai.meleeDamage + (en.kind === 2 ? 10 : 0) + waveNum * 0.4) * diff().dmg, dirToDeg(en));
            playSound('melee');
            addTrauma(0.25);
            meleeHits.push(now);
          }
        }
        en.swinging = -1;                        // cooldown marker
        en.attackReadyT = gameT + (en.kind === 2 ? 2.4 : 1.6) + Math.random() * 0.5;
      }
      if (en.swinging <= -1 - 0.01) en.swinging = undefined;
    }
    // ranged attack: riflemen fire bursts; grenadiers fire single shots and lob grenades
    if ((en.kind === 1 || en.kind === 3) && en.staggerT <= 0) {
      const canSee = los && (en.state === 'engage' || (en.state === 'incover' && en.peekT < 0));
      if (canSee && dist < CFG.ai.rangedRange && gameT > en.nextShot && en.aimT > 0.35) {
        enemyShoot(en, dist);
        en.burst = (en.burst || 0) + 1;
        const burstLen = en.kind === 1 ? 3 : 1;
        if (en.burst >= burstLen) { en.burst = 0; en.nextShot = gameT + CFG.ai.rangedROF * (0.8 + Math.random() * 0.6) * (1 + en.suppress); }
        else en.nextShot = gameT + 0.11;
      }
      if (en.kind === 3) {
        en.grenadeT -= dt;
        if (en.grenadeT <= 0 && dist > 7 && dist < 30 && (los || en.alerted)) {
          throwEnemyGrenade(en);
          en.grenadeT = 7 + Math.random() * 4;
        }
      }
    }
    animateEnemy(en, dt, dist);
  }
  // enemy-vs-enemy separation AFTER movement so clumps actually resolve
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i];
    if (a.dead) continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j];
      if (b.dead) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const rr = (a.kind === 2 ? 1.1 : 0.85) + (b.kind === 2 ? 1.1 : 0.85);
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2), push = (rr - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
      }
    }
  }
}

// ---- Enemy gunfire: real hitscan with aim error, cover blocks it, near misses whizz ----
const eShotRay = new THREE.Raycaster();
const _eFrom = new THREE.Vector3(), _eAim = new THREE.Vector3(), _eDir = new THREE.Vector3(), _eEnd = new THREE.Vector3();
const _pSeg = new THREE.Vector3();
// distance from a ray to the player's vertical capsule axis; returns t along the ray or -1
function rayHitsPlayer(from, dir, maxT, radius) {
  const feet = player.pos.y - eyeHeight() + 0.2, top = player.pos.y + 0.12;
  const cx = player.pos.x + player.leanOffset.x, cz = player.pos.z + player.leanOffset.z;
  // closest approach in xz, then check height at that t
  const ox = from.x - cx, oz = from.z - cz;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a < 1e-6) return -1;
  const t = -(ox * dir.x + oz * dir.z) / a;
  if (t < 0 || t > maxT) return -1;
  const qx = ox + dir.x * t, qz = oz + dir.z * t;
  if (qx * qx + qz * qz > radius * radius) return -1;
  const y = from.y + dir.y * t;
  if (y < feet || y > top) return -1;
  return t;
}
function enemyShoot(en, dist) {
  en.lastShotT = gameT;
  playSound3D('eshot', en.pos.x, en.pos.y, en.pos.z, !en._losCache, 90);
  enemyEye(en, _eFrom); _eFrom.y -= 0.2;
  // aim error: shrinks as the enemy settles its aim, grows with player speed and suppression
  const pSpeed = Math.hypot(player.vel.x, player.vel.z);
  const acc = Math.min(CFG.ai.accMax, CFG.ai.rangedAccuracy + waveNum * CFG.ai.accPerWave) * diff().acc;
  const err = (0.06 * (1 - acc) + 0.01) * (1.6 - Math.min(1, en.aimT)) * (1 + pSpeed * 0.12) * (1 + en.suppress * 1.5) * (player.crouching ? 0.9 : 1);
  _eAim.copy(playerAimPoint()); _eAim.y -= 0.35 + Math.random() * 0.5;
  _eDir.copy(_eAim).sub(_eFrom).normalize();
  _eDir.x += (Math.random() - 0.5) * 2 * err; _eDir.y += (Math.random() - 0.5) * 2 * err * 0.7; _eDir.z += (Math.random() - 0.5) * 2 * err;
  _eDir.normalize();
  const range = 120;
  eShotRay.set(_eFrom, _eDir); eShotRay.far = range;
  const hits = eShotRay.intersectObjects(raycastColliders, true);
  let worldT = range, wh = null;
  for (let i = 0; i < hits.length; i++) { if (surfaceOf(hits[i].object) === 'glass') continue; worldT = hits[i].distance; wh = hits[i]; break; }
  const pt = rayHitsPlayer(_eFrom, _eDir, worldT, 0.32);
  if (pt >= 0) {
    _eEnd.copy(_eFrom).addScaledVector(_eDir, pt);
    const dmg = (CFG.ai.rangedDamage + waveNum * 0.35) * (en.kind === 3 ? 0.8 : 1) * diff().dmg;
    damagePlayer(dmg, dirToDeg(en));
  } else {
    _eEnd.copy(_eFrom).addScaledVector(_eDir, worldT);
    if (wh) {
      spawnImpact(wh.point, wh.face ? wh.face.normal : null, wh.object);
      if (wh.object.userData.barrelRef) damageBarrel(wh.object.userData.barrelRef, 12);
      if (wh.face && surfaceOf(wh.object) !== 'glass') spawnDecal(wh.point, wh.face.normal, wh.object);
    }
    // near miss: crack past the player's head
    _pSeg.copy(player.pos).sub(_eFrom);
    const tt = _pSeg.dot(_eDir);
    if (tt > 0 && tt < worldT) {
      const miss2 = _pSeg.lengthSq() - tt * tt;
      if (miss2 < 2.5 * 2.5) {
        _pSeg.copy(_eFrom).addScaledVector(_eDir, tt);
        playSound3D('whizz', _pSeg.x, _pSeg.y, _pSeg.z, false, 10);
        postKick('aberration', 0.12);
        addTrauma(0.05);
      }
    }
  }
  spawnTracer(_eFrom, _eEnd, 0xff8844);
  fxMuzzle(_eFrom, _eDir, false);
  flashLight(_eFrom, 0xffb060, 1.5, 6, 0.05);
}
// Grenadier lob: solve a ballistic arc (g = 14) that lands near the player.
function throwEnemyGrenade(en) {
  const from = new THREE.Vector3(en.pos.x, en.pos.y + 1.6, en.pos.z);
  const tx = player.pos.x + (Math.random() - 0.5) * 3 + player.vel.x * 0.6;
  const tz = player.pos.z + (Math.random() - 0.5) * 3 + player.vel.z * 0.6;
  const ty = player.pos.y - eyeHeight() + 0.1;
  const dx = tx - from.x, dz = tz - from.z, d = Math.hypot(dx, dz);
  const T = Math.max(0.9, Math.min(1.9, d / 11));
  const vel = new THREE.Vector3(dx / T, (ty - from.y + 0.5 * 14 * T * T) / T, dz / T);
  spawnLiveGrenade(from, vel, 2.6, true);
  en.swinging = undefined; en.throwT = 0.5;
  playSound3D('pin', en.pos.x, 1.5, en.pos.z, false, 25);
  playSound('grenade_warn');
}

function dirToDeg(en) {
  // Bearing from player to attacker; showDamageFx converts this to screen-relative rotation.
  return (Math.atan2(en.pos.x - player.pos.x, en.pos.z - player.pos.z) * 180 / Math.PI + 360) % 360;
}

function animateEnemy(en, dt, dist) {
  en.throwT = Math.max(0, (en.throwT || 0) - dt);
  animateSoldier(en, dt, dist);
}
