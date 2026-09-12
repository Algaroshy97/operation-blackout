// ============ ENEMIES & AI ============
'use strict';
// Simple humanoid: body box + head box + limbs, tinted materials, ragdoll-lite death.
const enemies = [];
let meleeHits = [];   // timestamps of landed melee hits (global damage cap)
// Set true by a runtime probe when the GPU/driver fails to paint skinned meshes
// (world renders, soldiers don't). Once true, all enemies use the simple mesh.
let GLB_SOLDIER_BROKEN = false;

const EMAT = {
  skin: new THREE.MeshStandardMaterial({ color: 0x9c7a5e, roughness: 0.9 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0x4a5240, roughness: 0.95 }),
  cloth2: new THREE.MeshStandardMaterial({ color: 0x3d4450, roughness: 0.95 }),
  vest: new THREE.MeshStandardMaterial({ color: 0x2a2e26, roughness: 0.9 }),
  head: new THREE.MeshStandardMaterial({ color: 0x9c7a5e, roughness: 0.9 }),
  helmet: new THREE.MeshStandardMaterial({ color: 0x394134, roughness: 0.85, metalness: 0.1 }),
  gun: new THREE.MeshStandardMaterial({ color: 0x1f2126, roughness: 0.6, metalness: 0.4 }),
  eye: new THREE.MeshBasicMaterial({ color: 0xff2222 })
};

// Enemy body proportions (meters)
const E_DIM = {
  bodyW: 0.5, bodyH: 0.62, bodyD: 0.3,
  pelvisH: 0.95, // hip height
  headS: 0.26,
  legH: 0.9, legR: 0.09,
  armH: 0.68, armR: 0.06
};

function makeEnemyMesh(kind) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.BoxGeometry(E_DIM.bodyW, E_DIM.bodyH, E_DIM.bodyD), kind === 1 ? EMAT.cloth2 : EMAT.cloth);
  torso.position.y = E_DIM.pelvisH + E_DIM.bodyH / 2;
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.42, 0.36), EMAT.vest);
  vest.position.y = E_DIM.pelvisH + 0.42;
  const head = new THREE.Mesh(new THREE.BoxGeometry(E_DIM.headS, E_DIM.headS, E_DIM.headS), EMAT.head);
  head.position.y = E_DIM.pelvisH + E_DIM.bodyH + E_DIM.headS / 2 + 0.03;
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.3), EMAT.helmet);
  helmet.position.y = E_DIM.pelvisH + E_DIM.bodyH + 0.26;
  // eyes (glow, creepy at dusk)
  const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.02), EMAT.eye);
  eyeL.position.set(-0.06, E_DIM.pelvisH + E_DIM.bodyH + 0.07, -E_DIM.headS / 2 - 0.005);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.06;
  // arms (static swing groups)
  const armL = new THREE.Group(); armL.position.set(-(E_DIM.bodyW / 2 + E_DIM.armR), E_DIM.pelvisH + E_DIM.bodyH - 0.05, 0);
  const armR = new THREE.Group(); armR.position.set(E_DIM.bodyW / 2 + E_DIM.armR, E_DIM.pelvisH + E_DIM.bodyH - 0.05, 0);
  for (const a of [armL, armR]) {
    const upper = new THREE.Mesh(new THREE.BoxGeometry(E_DIM.armR * 2, E_DIM.armH / 2, E_DIM.armR * 2), EMAT.cloth);
    upper.position.y = -E_DIM.armH / 4;
    a.add(upper);
    g.add ? null : null;
  }
  // legs
  const legL = new THREE.Group(); legL.position.set(-0.12, E_DIM.pelvisH, 0);
  const legR = new THREE.Group(); legR.position.set(0.12, E_DIM.pelvisH, 0);
  for (const l of [legL, legR]) {
    const upper = new THREE.Mesh(new THREE.BoxGeometry(E_DIM.legR * 2, E_DIM.legH / 2, E_DIM.legR * 2), EMAT.cloth2);
    upper.position.y = -E_DIM.legH / 4;
    l.add(upper);
  }
  // enemy rifle (simple)
  const egun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.5), EMAT.gun);
  egun.position.set(0.18, E_DIM.pelvisH + 0.35, -0.25);
  // hitboxes (invisible, slightly larger)
  const hbMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitBody = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.05, 0.5), hbMat);
  hitBody.position.y = E_DIM.pelvisH + 0.5;
  const hitHead = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), hbMat);
  hitHead.position.y = E_DIM.pelvisH + E_DIM.bodyH + 0.16;

  for (const m of [torso, vest, head, helmet, eyeL, eyeR, egun]) { m.castShadow = true; }
  armL.children[0].castShadow = true; armR.children[0].castShadow = true;
  legL.children[0].castShadow = true; legR.children[0].castShadow = true;

  body.add(torso); body.add(vest); body.add(head); body.add(helmet); body.add(eyeL); body.add(eyeR);
  body.add(armL); body.add(armR); body.add(legL); body.add(legR); body.add(egun);
  g.add(body); g.add(hitBody); g.add(hitHead);
  return { group: g, body: body, torso: torso, head: head, armL: armL, armR: armR, legL: legL, legR: legR, hitBody: hitBody, hitHead: hitHead };
}

// Read a centered framebuffer sample. The diagnostic camera aims the soldier at
// the center, so comparing this sample before and after spawning it avoids
// guessing sky/fog colours or confusing WebGL's bottom-left pixel origin.
function readProbePixels(gl, width, height, size) {
  const pixels = new Uint8Array(size * size * 4);
  const x = Math.max(0, Math.floor(width / 2 - size / 2));
  const y = Math.max(0, Math.floor(height / 2 - size / 2));
  gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

// One-time GPU probe: some desktop drivers render static meshes fine but
// silently drop skinned ones. Compare the same rendered pixels with and without
// a soldier; if it does not paint enough pixels, use the simple mesh everywhere.
function probeSkinnedSoldier() {
  if (!GLB_PARSED.SOLDIER) return;
  // Asset decoding is asynchronous and can finish after a player has begun a wave.
  // Snapshot state so the invisible diagnostic never changes the live match.
  const playerState = {
    pos: player.pos.clone(), vel: player.vel.clone(), yaw: player.yaw, pitch: player.pitch,
    recoilP: player.recoilP, recoilY: player.recoilY
  };
  const cameraState = {
    position: camera.position.clone(), rotation: camera.rotation.clone(),
    fov: camera.fov, aspect: camera.aspect
  };
  let probe = null;
  try {
    camera.position.set(0, 1.7, -31);
    camera.lookAt(0, 1.0, -35);
    camera.updateMatrixWorld(true);
    camera.aspect = renderer.domElement.width / renderer.domElement.height;
    camera.updateProjectionMatrix();
    const gl = renderer.getContext();
    const width = renderer.domElement.width, height = renderer.domElement.height;
    const sampleSize = 32;
    renderer.render(scene, camera);
    const before = readProbePixels(gl, width, height, sampleSize);
    probe = spawnEnemy(0, 0, -35);
    renderer.render(scene, camera);
    const after = readProbePixels(gl, width, height, sampleSize);
    let painted = 0;
    for (let i = 0; i < after.length; i += 4) {
      const difference = Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2]);
      if (difference > 30) painted++;
    }
    GLB_SOLDIER_BROKEN = !(painted > before.length / 16);
    if (GLB_SOLDIER_BROKEN) console.warn('Skinned soldier failed GPU paint test — using simple enemy models.');
  } catch (err) {
    GLB_SOLDIER_BROKEN = true;
    console.warn('Soldier probe threw, using simple enemy models.', err);
  } finally {
    if (probe) {
      scene.remove(probe.parts.group);
      const idx = enemies.indexOf(probe);
      if (idx >= 0) enemies.splice(idx, 1);
      disposeEnemyGeometry(probe);
    }
    player.pos.copy(playerState.pos);
    player.vel.copy(playerState.vel);
    player.yaw = playerState.yaw; player.pitch = playerState.pitch;
    player.recoilP = playerState.recoilP; player.recoilY = playerState.recoilY;
    camera.position.copy(cameraState.position);
    camera.rotation.copy(cameraState.rotation);
    camera.fov = cameraState.fov; camera.aspect = cameraState.aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }
}

function spawnEnemy(kind, x, z) {
  let parts = null;
  let mixer = null;
  let actions = null;
  // Animated GLB soldier on desktop. Mobile uses the reliable lightweight mesh to
  // avoid skinned-model/WebGL memory failures when an HTML file is opened locally.
  const mobileSafe = typeof IS_TOUCH !== 'undefined' && IS_TOUCH;
  // Kenney mini-soldier GLB raw height is ~0.84 m — scale it to human height.
  // Hitboxes remain outside the scaled root so their world dimensions stay stable.
  const GLB_SOLDIER_SCALE = 1.85 / 0.84;
  if (GLB_PARSED.SOLDIER && !mobileSafe && !GLB_SOLDIER_BROKEN) {
    const gltf = GLB_PARSED.SOLDIER;
    const root = gltf.scene.clone(true);
    root.scale.setScalar(GLB_SOLDIER_SCALE);
    // Animated skinned bounds can become stale on some GPUs, causing false culling.
    root.traverse(function (o) { if (o.isSkinnedMesh) o.frustumCulled = false; });
    // procedural hitboxes for consistent aim behavior
    const hbMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitBody = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.05, 0.5), hbMat);
    hitBody.position.y = 0.95;
    const hitHead = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), hbMat);
    hitHead.position.y = 1.85;
    const g = new THREE.Group();
    g.add(root); g.add(hitBody); g.add(hitHead);
    parts = { group: g, body: root, torso: root, head: root, armL: root, armR: root, legL: root, legR: root, hitBody: hitBody, hitHead: hitHead, glb: true };
    // mark every visible mesh as enemy-flesh so bullets treat them as body hits (not walls)
    g.traverse(function (o) {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true;
        o.userData.vfx = false;
        o.userData.gun = false;
        o.userData.sky = false;
      }
    });
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(root);
      actions = {};
      gltf.animations.forEach(function (clip) { actions[clip.name] = mixer.clipAction(clip); });
    }
  } else {
    parts = makeEnemyMesh(kind);
  }
  const scale = kind === 2 ? 1.25 : 1;
  parts.group.scale.set(scale, scale, scale);
  const hp = kind === 0 ? CFG.ai.maxHealth : kind === 1 ? CFG.ai.maxHealth * 1.35 : CFG.ai.maxHealth * 2.6;
  const en = {
    kind: kind,               // 0=runner(melee), 1=rifleman, 2=tank(slow heavy)
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(),
    yaw: 0,
    health: hp, maxHealth: hp,
    dead: false, deathT: 0,
    parts: parts,
    mixer: mixer,
    actions: actions,
    animCur: '',
    state: 'spawn',
    stateT: 0,
    nextShot: 0,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    strafeT: 0,
    walkPhase: Math.random() * 10,
    speedMul: 0.85 + Math.random() * 0.3,
    attackT: 0,
    hitBody: parts.hitBody,
    hitHead: parts.hitHead
  };
  parts.hitBody.userData = { enemyRef: en, isHead: false };
  parts.hitHead.userData = { enemyRef: en, isHead: true };
  // tag ALL visible meshes with the enemy ref too, so raycast world-hits resolve as enemy body hits
  parts.group.traverse(function (o) {
    if (o.isMesh && o !== parts.hitBody && o !== parts.hitHead) {
      o.userData = { enemyRef: en, isHead: false, enemyFlesh: true };
    }
  });
  // Place the mesh immediately; otherwise it renders and raycasts at the world origin for its first frame.
  parts.group.position.set(x, 0, z);
  scene.add(parts.group);
  enemies.push(en);
  return en;
}

function disposeEnemyGeometry(en) {
  if (!en) return;
  if (en.parts.glb) {
    // GLB model geometry is shared, but each enemy owns its two hitboxes.
    en.hitBody.geometry.dispose(); en.hitHead.geometry.dispose();
  } else en.parts.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
}

function damageEnemy(en, dmg, point, isHead) {
  if (en.dead) return;
  en.health -= dmg;
  showHitmarker(isHead);
  spawnBlood(point, isHead);
  if (en.health <= 0) killEnemy(en, isHead);
  else {
    // flinch + alert
    en.stateT = 0;
    if (en.state === 'idle' || en.state === 'patrol') en.state = 'chase';
  }
}

function killEnemy(en, isHead) {
  en.dead = true; en.deathT = 0;
  addScore(CFG.score.kill + (isHead ? CFG.score.headshot : 0), isHead ? 'Headshot kill' : 'Hostile down');
  registerKillT();   // multi-kill streak bonus (2+ kills within 4 s)
  kills++;
  if (isHead) headshots++;
  dropPickup(en.pos);
  playSound('kill');
}

// Simple steering: move toward player with obstacle pushout (same resolve as player)
function moveEnemy(en, dt) {
  const cfg = CFG.ai;
  const toPlayer = tmpV2.copy(player.pos).sub(en.pos); toPlayer.y = 0;
  const dist = toPlayer.length();
  let speed = 0;
  if (en.state === 'chase') speed = (en.kind === 0 ? cfg.chaseSpeed : en.kind === 2 ? 2.2 : cfg.speed) * en.speedMul;
  else if (en.state === 'strafe') speed = cfg.rangedSpeed * en.speedMul;
  else speed = cfg.speed * 0.5 * en.speedMul;
  if (en.kind === 1 && dist < cfg.rangedRange && en.state !== 'idle') speed = cfg.rangedSpeed;
  // desired velocity
  if (dist > 0.01) toPlayer.normalize();
  let mvx = toPlayer.x, mvz = toPlayer.z;
  if (en.state === 'strafe') {
    // circle-strafe the player
    mvx = -toPlayer.z * en.strafeDir; mvz = toPlayer.x * en.strafeDir;
    en.strafeT -= dt;
    if (en.strafeT <= 0) { en.strafeDir *= -1; en.strafeT = 1.5 + Math.random() * 2; }
  }
  en.vel.x = mvx * speed;
  en.vel.z = mvz * speed;
  en.pos.x += en.vel.x * dt;
  en.pos.z += en.vel.z * dt;
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
    if (px < pz) en.pos.x = cx + (dx >= 0 ? ex : -ex);
    else en.pos.z = cz + (dz >= 0 ? ez : -ez);
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

// LOS check: ray from enemy eye to player eye against static world
const losRay = new THREE.Raycaster();
const _losFrom = new THREE.Vector3();
const _losTo = new THREE.Vector3();
let losFrame = 0;   // round-robin: each enemy checks LOS at most every 3 frames
function hasLOS(en) {
  // throttle: max 1/3 of enemies per frame do the raycast
  if (en._losSkip === undefined) en._losSkip = 0;
  if (losFrame % 3 !== en._losSkip) { if (en._losCache === undefined) return true; return en._losCache; }
  _losFrom.set(en.pos.x, en.pos.y + E_DIM.pelvisH * (en.kind === 2 ? 1.25 : 1) + 0.5, en.pos.z);
  _losTo.copy(player.pos);
  _losTo.x += (Math.random() - 0.5) * 0.3; _losTo.z += (Math.random() - 0.5) * 0.3;
  losRay.set(_losFrom, _losTo.sub(_losFrom).normalize());
  losRay.far = _losFrom.distanceTo(player.pos);
  const hits = losRay.intersectObjects(raycastColliders, true);
  let blocked = false;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].distance < losRay.far - 0.2) { blocked = true; break; }
  }
  en._losCache = !blocked;
  return !blocked;
}
const tmpV2 = new THREE.Vector3();

function updateEnemies(dt) {
  losFrame++;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const en = enemies[i];
    if (en._losSkip === undefined) en._losSkip = i % 3;
    if (en.dead) {
      // death animation: GLB die clip or fall-over for box-man, then sink+remove
      en.deathT += dt;
      const p = en.parts;
      if (!en.actions) p.group.rotation.z = Math.min(Math.PI / 2, en.deathT * 4);
      p.group.position.y = en.pos.y - Math.max(0, en.deathT - 1.2) * 0.6;
      if (en.deathT > 4) {
        scene.remove(p.group);
        disposeEnemyGeometry(en);
        enemies.splice(i, 1);
      }
      continue;
    }
    // DEAD PLAYER: stop all AI activity — enemies wander/idle, never attack a corpse
    const playerGone = player.dead;
    en.stateT += dt;
    const dist = en.pos.distanceTo(player.pos);
    // state machine
    if (playerGone) {
      if (en.state !== 'idle') { en.state = 'idle'; en.stateT = 0; en.swinging = undefined; }
      animateEnemy(en, dt, dist);
      continue;
    }
    if (en.state === 'spawn') {
      if (en.stateT > 0.5) { en.state = 'chase'; en.stateT = 0; }
    } else if (en.kind === 0) {
      // runner: always chase + melee
      en.state = 'chase';
    } else if (en.kind === 1) {
      // rifleman: chase until in range & LOS, then strafe-shoot
      if (dist < CFG.ai.rangedRange && hasLOS(en)) {
        if (en.state !== 'strafe' && en.state !== 'shoot') { en.state = 'strafe'; en.strafeT = 2; }
      } else if (en.state !== 'chase') { en.state = 'chase'; }
      if (en.state === 'strafe' && en.stateT > 6) { en.state = 'chase'; en.stateT = 0; }
    } else {
      // tank: slow chase always
      en.state = 'chase';
    }
    moveEnemy(en, dt);
    // positional enemy footsteps: cadence scales with enemy speed, throttled globally
    if (en.state !== 'spawn' && dist < 30 && en.stepT === undefined) en.stepT = Math.random() * 0.5;
    if (en.state !== 'spawn' && dist < 30 && !en.dead) {
      en.stepT -= dt * (en.kind === 0 ? 1.7 : en.kind === 2 ? 0.9 : 1.1);
      if (en.stepT <= 0) {
        if (gameT > nextEstepT) { playSound3D('estep', en.pos.x, en.pos.y, en.pos.z); nextEstepT = gameT + 0.08; }
        en.stepT = 0.55 / (en.speedMul || 1);
      }
    }
    // face player
    const dx = player.pos.x - en.pos.x, dz = player.pos.z - en.pos.z;
    en.yaw = Math.atan2(dx, dz);
    // keep enemies out of the player's body: stop-and-hold at melee distance
    const stopDist = en.kind === 2 ? 2.6 : 1.9;
    if (dist < stopDist && (en.kind === 0 || en.kind === 2)) {
      // back off slightly if overlapping the player capsule
      const overlap = stopDist - dist;
      if (overlap > 0) {
        const nx = (en.pos.x - player.pos.x) / (dist || 1), nz = (en.pos.z - player.pos.z) / (dist || 1);
        en.pos.x += nx * overlap; en.pos.z += nz * overlap;
      }
    }
    // melee attack (runners + tanks): staggered windup, damage cap, real cooldown
    const canMelee = en.kind === 0 || en.kind === 2;
    const reach = en.kind === 2 ? CFG.ai.attackRange + 0.9 : CFG.ai.attackRange + 0.4;
    if (canMelee && dist < reach && en.swinging === undefined && gameT > (en.attackReadyT || 0)) {
      // stagger windups so a pack doesn't land one synced nuke
      const stagger = 0.25 + Math.random() * 0.45;
      en.swinging = stagger;                   // windup (telegraphed)
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
            damagePlayer(CFG.ai.meleeDamage + (en.kind === 2 ? 10 : 0) + waveNum * 0.4, dirToDeg(en));
            playSound('melee');
            meleeHits.push(now);
          }
        }
        en.swinging = -1;                        // cooldown marker
        en.attackReadyT = gameT + (en.kind === 2 ? 2.4 : 1.6) + Math.random() * 0.5;
      }
      if (en.swinging <= -1 - 0.01) en.swinging = undefined;
    }
    // ranged attack (rifleman)
    if (en.kind === 1 && en.state === 'strafe' && dist < CFG.ai.rangedRange && gameT > en.nextShot) {
      if (hasLOS(en)) {
        en.nextShot = gameT + CFG.ai.rangedROF * (0.75 + Math.random() * 0.5);
        enemyShoot(en, dist);
      } else {
        en.nextShot = gameT + 0.4;
      }
    }
    // animate
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

function enemyShoot(en, dist) {
  // visible tracer from enemy, damage applied probabilistically (accuracy scales with wave)
  playSound3D('eshot', en.pos.x, en.pos.y, en.pos.z);
  const from = new THREE.Vector3(en.pos.x, en.pos.y + E_DIM.pelvisH + 0.55, en.pos.z);
  const to = player.pos.clone();
  to.y -= 0.2;
  spawnTracer(from, to, 0xff8844);
  const acc = Math.min(CFG.ai.accMax, CFG.ai.rangedAccuracy + waveNum * CFG.ai.accPerWave);
  if (Math.random() < acc) {
    const dmg = CFG.ai.rangedDamage + waveNum * 0.35;
    setTimeout(function () { if (!player.dead && started && !paused) damagePlayer(dmg, dirToDeg(en)); }, Math.min(300, dist * 2.2));
  }
}

function dirToDeg(en) {
  // Bearing from player to attacker; showDamageFx converts this to screen-relative rotation.
  return (Math.atan2(en.pos.x - player.pos.x, en.pos.z - player.pos.z) * 180 / Math.PI + 360) % 360;
}

// pick + drive the right GLB clip; fall back to procedural limb swing for the box-man
function setEnemyAnim(en, name, fade) {
  if (!en.actions || !en.actions[name] || en.animCur === name) return;
  const next = en.actions[name];
  if (en.animCur && en.actions[en.animCur]) en.actions[en.animCur].fadeOut(fade || 0.15);
  next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade || 0.15).play();
  en.animCur = name;
}
function animateEnemy(en, dt, dist) {
  const p = en.parts;
  p.group.position.set(en.pos.x, en.pos.y, en.pos.z);
  p.group.rotation.y = en.yaw + Math.PI;
  if (en.mixer) en.mixer.update(dt);
  if (en.dead) {
    if (en.actions) setEnemyAnim(en, 'die', 0.1);
    return;
  }
  if (en.actions) {
    // GLB soldier: pick clip by state
    const moving = Math.hypot(en.vel.x, en.vel.z);
    let clip = 'idle';
    if (en.swinging !== undefined && en.swinging > 0) clip = en.kind === 1 ? 'holding-right-shoot' : 'attack-melee-right';
    else if (moving > 4.5) clip = 'sprint';
    else if (moving > 0.5) clip = 'walk';
    else if (en.state === 'strafe') clip = 'walk';
    if (en.kind === 1 && en.state === 'strafe') clip = moving > 0.5 ? 'holding-right-shoot' : 'holding-right';
    if (en.kind === 1) clip = en.swinging !== undefined && en.swinging > 0 ? 'holding-right-shoot' : (moving > 0.5 ? 'holding-right' : 'idle');
    setEnemyAnim(en, clip, 0.12);
    return;
  }
  // ---- procedural fallback (box-man) ----
  if (en.dead) return;
  const moving = Math.hypot(en.vel.x, en.vel.z) > 0.3;
  const spd = moving ? 9 * (en.kind === 0 ? 1.5 : 1) : 0;
  en.walkPhase += spd * dt;
  const swing = Math.sin(en.walkPhase) * (moving ? 0.55 : 0.06);
  p.legL.rotation.x = swing;
  p.legR.rotation.x = -swing;
  p.armL.rotation.x = -swing * 0.7;
  p.armR.rotation.x = swing * 0.7 - (en.kind === 1 ? 0.5 : 0);
  // head slightly track pitch to player
  const pitch = Math.atan2(player.pos.y - (en.pos.y + 1.5), dist);
  p.body.rotation.x = en.kind === 1 ? -pitch * 0.25 : 0;
  // runner lean
  p.body.rotation.x += en.kind === 0 ? 0.12 : 0;
  // idle bob
  p.body.position.y = moving ? Math.abs(Math.cos(en.walkPhase)) * 0.03 : 0;
}
