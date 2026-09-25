// ============ ENEMIES & AI ============
'use strict';
// Soldiers: animated GLB on desktop, a detailed procedural "box-man" everywhere else.
// Kinds: 0 runner (melee, lunges) · 1 rifleman (cover, bursts) · 2 heavy (armoured,
// charges) · 3 grenadier (keeps distance, lobs grenades). All ranged fire is real
// hitscan against the world, so cover and crouching genuinely protect the player.
const enemies = [];
let meleeHits = [];   // timestamps of landed melee hits (global damage cap)
// Set true by a runtime probe when the GPU/driver fails to paint skinned meshes
// (world renders, soldiers don't). Once true, all enemies use the simple mesh.
let GLB_SOLDIER_BROKEN = false;

function kitMat(color, map) {
  return new THREE.MeshStandardMaterial({ color: color, map: map || null, normalMap: map ? TEX.camo.normalMap : null, roughness: 0.92 });
}
// per-kind uniform kits (shared materials)
const KITS = [
  { cloth: kitMat(0x9a9c80, TEX.camo.map), cloth2: kitMat(0x4a4e3c), vest: kitMat(0x2e3228), helmet: kitMat(0x3c4434) },   // runner
  { cloth: kitMat(0x8a94a8, TEX.camo.map), cloth2: kitMat(0x30353e), vest: kitMat(0x24282e), helmet: kitMat(0x2c3036) },   // rifleman
  { cloth: kitMat(0x585858, TEX.camo.map), cloth2: kitMat(0x202022), vest: kitMat(0x3a3a3a), helmet: kitMat(0x161618) },   // heavy
  { cloth: kitMat(0xb0a47a, TEX.camo.map), cloth2: kitMat(0x4c4834), vest: kitMat(0x3e3a2a), helmet: kitMat(0x4c4832) }    // grenadier
];
const EMAT = {
  skin: new THREE.MeshStandardMaterial({ color: 0x9c7a5e, roughness: 0.9 }),
  mask: new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.95 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x1e1c1a, roughness: 0.8 }),
  boot: new THREE.MeshStandardMaterial({ color: 0x151412, roughness: 0.7 }),
  pouch: new THREE.MeshStandardMaterial({ color: 0x3a3a2c, roughness: 0.9 }),
  gun: new THREE.MeshStandardMaterial({ color: 0x1f2126, roughness: 0.5, metalness: 0.6 }),
  plate: new THREE.MeshStandardMaterial({ color: 0x2c2e30, roughness: 0.5, metalness: 0.6 }),
  visor: new THREE.MeshStandardMaterial({ color: 0x080a0c, roughness: 0.05, metalness: 1.0 }),
  nvg: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1, 0.3).multiplyScalar(2.5) }),
  slit: new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.1, 0.05).multiplyScalar(3) }),
  nade: new THREE.MeshStandardMaterial({ color: 0x3a4a2e, roughness: 0.6, metalness: 0.3 })
};
// flash materials swapped in for a few frames when hit (skinned variant for GLBs)
const HIT_FLASH = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.35, 0.3).multiplyScalar(1.6) });
const HIT_FLASH_SKIN = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.35, 0.3).multiplyScalar(1.6), skinning: true });

// Enemy body proportions (meters)
const E_DIM = {
  bodyW: 0.5, bodyH: 0.62, bodyD: 0.3,
  pelvisH: 0.95, // hip height
  headS: 0.26,
  legH: 0.9, legR: 0.09,
  armH: 0.68, armR: 0.06
};

function eBox(parent, w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}
function makeEnemyMesh(kind) {
  const K = KITS[kind] || KITS[0];
  const g = new THREE.Group();
  const body = new THREE.Group();
  const P = E_DIM.pelvisH;
  // torso + webbing
  const torso = eBox(body, E_DIM.bodyW, E_DIM.bodyH, E_DIM.bodyD, 0, P + E_DIM.bodyH / 2, 0, K.cloth);
  eBox(body, 0.42, 0.14, 0.26, 0, P + 0.02, 0, K.cloth2);                          // pelvis / belt
  eBox(body, 0.54, 0.42, 0.36, 0, P + 0.42, 0, kind === 2 ? EMAT.plate : K.vest);   // plate carrier
  for (let i = -1; i <= 1; i++) eBox(body, 0.12, 0.12, 0.06, i * 0.14, P + 0.3, -0.2, EMAT.pouch);   // mag pouches
  eBox(body, 0.08, 0.14, 0.06, 0.2, P + 0.56, -0.19, EMAT.pouch);                  // radio
  if (kind === 2) {                                                               // heavy: pauldrons + groin plate
    eBox(body, 0.2, 0.08, 0.3, -0.33, P + E_DIM.bodyH - 0.02, 0, EMAT.plate);
    eBox(body, 0.2, 0.08, 0.3, 0.33, P + E_DIM.bodyH - 0.02, 0, EMAT.plate);
    eBox(body, 0.26, 0.22, 0.06, 0, P - 0.06, -0.19, EMAT.plate);
  }
  if (kind === 3) {                                                               // grenadier: backpack + bandolier
    eBox(body, 0.36, 0.4, 0.18, 0, P + 0.38, 0.25, K.cloth2);
    for (let i = 0; i < 4; i++) { const n = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), EMAT.nade); n.position.set(-0.18 + i * 0.1, P + 0.5 - i * 0.07, -0.2); body.add(n); }
  }
  // head: balaclava, helmet, NVG (glowing tubes) or heavy visor
  const head = eBox(body, E_DIM.headS, E_DIM.headS, E_DIM.headS, 0, P + E_DIM.bodyH + E_DIM.headS / 2 + 0.03, 0, kind === 0 ? EMAT.skin : EMAT.mask);
  const helmet = eBox(body, 0.3, 0.14, 0.3, 0, P + E_DIM.bodyH + 0.26, 0, K.helmet);
  eBox(body, 0.32, 0.03, 0.34, 0, P + E_DIM.bodyH + 0.19, -0.01, K.helmet);        // brim
  if (kind === 2) {
    eBox(body, 0.27, 0.12, 0.03, 0, P + E_DIM.bodyH + 0.1, -0.145, EMAT.visor);
    eBox(body, 0.18, 0.012, 0.01, 0, P + E_DIM.bodyH + 0.11, -0.162, EMAT.slit);
  } else {
    const hy = P + E_DIM.bodyH + 0.1;
    for (const sx of [-0.05, 0.05]) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.06, 8), EMAT.gun);
      t.rotation.x = Math.PI / 2; t.position.set(sx, hy, -0.16); body.add(t);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.018, 10), EMAT.nvg);
      lens.position.set(sx, hy, -0.192); lens.rotation.y = Math.PI; body.add(lens);
    }
  }
  // arms: shoulder -> elbow -> glove
  function arm(side) {
    const a = new THREE.Group(); a.position.set(side * (E_DIM.bodyW / 2 + E_DIM.armR), P + E_DIM.bodyH - 0.05, 0);
    eBox(a, E_DIM.armR * 2.1, E_DIM.armH / 2, E_DIM.armR * 2.1, 0, -E_DIM.armH / 4, 0, K.cloth);
    const f = new THREE.Group(); f.position.y = -E_DIM.armH / 2; a.add(f);
    eBox(f, E_DIM.armR * 1.9, E_DIM.armH / 2, E_DIM.armR * 1.9, 0, -E_DIM.armH / 4, 0, K.cloth);
    eBox(f, 0.09, 0.1, 0.1, 0, -E_DIM.armH / 2 - 0.03, 0, EMAT.glove);
    body.add(a);
    return { a: a, f: f };
  }
  const aL = arm(-1), aR = arm(1);
  // legs: hip -> knee -> boot
  function leg(side) {
    const l = new THREE.Group(); l.position.set(side * 0.12, P, 0);
    eBox(l, E_DIM.legR * 2.3, E_DIM.legH / 2, E_DIM.legR * 2.3, 0, -E_DIM.legH / 4, 0, K.cloth);
    const k = new THREE.Group(); k.position.y = -E_DIM.legH / 2; l.add(k);
    eBox(k, E_DIM.legR * 2.1, E_DIM.legH / 2 - 0.08, E_DIM.legR * 2.1, 0, -E_DIM.legH / 4 + 0.04, 0, K.cloth2);
    eBox(k, E_DIM.legR * 2.3, 0.1, 0.26, 0, -E_DIM.legH / 2 + 0.05, -0.04, EMAT.boot);
    if (kind === 2) eBox(k, E_DIM.legR * 2.5, 0.16, 0.05, 0, -0.08, -0.1, EMAT.plate);   // knee pad
    body.add(l);
    return { l: l, k: k };
  }
  const lL = leg(-1), lR = leg(1);
  // weapon held at the chest (runner: knife in the right hand)
  let egun;
  if (kind === 0) {
    egun = new THREE.Group();
    eBox(egun, 0.02, 0.03, 0.26, 0, 0, -0.12, EMAT.plate);
    eBox(egun, 0.03, 0.04, 0.1, 0, 0, 0.04, EMAT.gun);
    egun.position.set(0, -E_DIM.armH / 2 - 0.05, -0.02);
    aR.f.add(egun);
  } else {
    egun = new THREE.Group();
    eBox(egun, 0.06, 0.1, 0.5, 0, 0, 0, EMAT.gun);
    eBox(egun, 0.03, 0.03, 0.22, 0, 0.02, -0.34, EMAT.gun);
    eBox(egun, 0.05, 0.14, 0.07, 0, -0.1, -0.06, EMAT.gun);
    eBox(egun, 0.05, 0.1, 0.16, 0, -0.01, 0.3, EMAT.gun);
    if (kind === 2) eBox(egun, 0.08, 0.08, 0.3, 0, -0.08, -0.2, EMAT.gun);        // heavy: drum / shotgun tube
    egun.position.set(0.14, P + 0.4, -0.3);
    body.add(egun);
  }
  // hitboxes (invisible, slightly larger)
  const hbMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitBody = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.60, 0.5), hbMat);
  hitBody.position.y = 1.24;
  const hitHead = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), hbMat);
  hitHead.position.y = E_DIM.pelvisH + E_DIM.bodyH + 0.16;
  // lower-body hitbox so leg shots register (reduced damage)
  const hitLegs = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.9, 0.4), hbMat);
  hitLegs.position.y = 0.47;

  g.add(body); g.add(hitBody); g.add(hitHead); g.add(hitLegs);
  return { group: g, body: body, torso: torso, head: head, helmet: helmet, armL: aL.a, armR: aR.a, foreL: aL.f, foreR: aR.f,
    legL: lL.l, legR: lR.l, kneeL: lL.k, kneeR: lR.k, gun: egun, hitBody: hitBody, hitHead: hitHead, hitLegs: hitLegs };
}

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
  const gunVisible = typeof gunGroup !== 'undefined' ? gunGroup.visible : true;
  let probe = null;
  try {
    if (typeof gunGroup !== 'undefined') gunGroup.visible = false;
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
    if (typeof gunGroup !== 'undefined') gunGroup.visible = gunVisible;
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

function skClone(source) {
  const lookup = new Map();
  const clone = source.clone(true);
  const skeletons = [];
  (function parallel(a, b) {
    lookup.set(a, b);
    for (let i = 0; i < a.children.length; i++) parallel(a.children[i], b.children[i]);
  })(source, clone);
  clone.traverse(function (node) {
    if (node.isSkinnedMesh && node.skeleton) {
      const bones = node.skeleton.bones.map(function (b) { return lookup.get(b) || b; });
      node.bind(new THREE.Skeleton(bones, node.skeleton.boneInverses), node.bindMatrix);
      skeletons.push(node.skeleton);
    }
  });
  clone.userData.skeletons = skeletons;
  return clone;
}

// per-kind tinted copies of the GLB soldier's materials (cached)
const GLB_KIT_TINT = [null, 0x9aa8c8, 0x6a6a6e, 0xd8c890];
const glbKitMats = {};
function glbKitMaterial(mat, kind) {
  if (!GLB_KIT_TINT[kind]) return mat;
  const key = kind + ':' + mat.uuid;
  if (!glbKitMats[key]) { const m = mat.clone(); m.color.multiply(new THREE.Color(GLB_KIT_TINT[kind])); glbKitMats[key] = m; }
  return glbKitMats[key];
}

function spawnEnemy(kind, x, z) {
  let parts = null;
  let mixer = null;
  let actions = null;
  let glbSkeletons = [];
  // Animated GLB soldier on desktop. Mobile uses the reliable lightweight mesh to
  // avoid skinned-model/WebGL memory failures when an HTML file is opened locally.
  const mobileSafe = typeof IS_TOUCH !== 'undefined' && IS_TOUCH;
  // Kenney mini-soldier GLB raw height is ~0.84 m — scale it to human height.
  // Hitboxes remain outside the scaled root so their world dimensions stay stable.
  const GLB_SOLDIER_SCALE = 1.85 / 0.84;
  if (GLB_PARSED.SOLDIER && !mobileSafe && !GLB_SOLDIER_BROKEN) {
    const gltf = GLB_PARSED.SOLDIER;
    const root = skClone(gltf.scene);
    if (root.userData.skeletons) glbSkeletons = root.userData.skeletons.slice();
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
        if (o !== hitBody && o !== hitHead && o.material) o.material = glbKitMaterial(o.material, kind);
      }
    });
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(root);
      actions = {};
      gltf.animations.forEach(function (clip) { actions[clip.name] = mixer.clipAction(clip); });
      if (actions.die) { actions.die.setLoop(THREE.LoopOnce); actions.die.clampWhenFinished = true; }
    }
  } else {
    parts = makeEnemyMesh(kind);
  }
  const scale = kind === 2 ? 1.25 : 1;
  parts.group.scale.set(scale, scale, scale);
  const baseHp = kind === 0 ? CFG.ai.maxHealth : kind === 1 ? CFG.ai.maxHealth * 1.35 : kind === 3 ? CFG.ai.maxHealth * 1.1 : 320;
  const curWave = typeof getWaveNum === 'function' ? getWaveNum() : (typeof waveNum !== 'undefined' ? waveNum : 1);
  const waveMul = Math.min(2.2, 1 + 0.06 * (Math.max(1, curWave) - 1));
  const hp = Math.round(baseHp * waveMul * diff().hp);
  const dx = player.pos.x - x, dz = player.pos.z - z;
  const initYaw = (dx !== 0 || dz !== 0) ? Math.atan2(dx, dz) : 0;
  const en = {
    kind: kind,               // 0=runner(melee), 1=rifleman, 2=heavy, 3=grenadier
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(),
    knock: new THREE.Vector3(),   // external impulse velocity (bullets, blasts)
    yaw: initYaw,
    health: hp, maxHealth: hp,
    dead: false, deathT: 0,
    parts: parts,
    glbSkeletons: glbSkeletons,
    mixer: mixer,
    actions: actions,
    animCur: '',
    state: 'spawn',
    stateT: 0,
    nextShot: 0, burst: 0, aimT: 0, suppress: 0, alerted: false,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    strafeT: 0,
    walkPhase: Math.random() * 10,
    speedMul: 0.85 + Math.random() * 0.3,
    attackT: 0,
    flashT: 0, staggerT: 0, crouch: 0, cover: null, peekT: 0,
    grenadeT: 4 + Math.random() * 4, chargeT: 0, chargeCd: 3 + Math.random() * 3, lungeT: 0, lungeCd: 0,
    zig: Math.random() * 10, lastShotT: -9, seenT: -9, fleeT: 0,
    hitBody: parts.hitBody,
    hitHead: parts.hitHead
  };
  parts.hitBody.userData = { enemyRef: en, isHead: false };
  parts.hitHead.userData = { enemyRef: en, isHead: true };
  if (parts.hitLegs) parts.hitLegs.userData = { enemyRef: en, isHead: false, isLegs: true };
  // tag ALL visible meshes with the enemy ref too, so raycast world-hits resolve as enemy body hits
  parts.group.traverse(function (o) {
    if (o.isMesh && o !== parts.hitBody && o !== parts.hitHead && o !== parts.hitLegs) {
      o.userData = { enemyRef: en, isHead: false, enemyFlesh: true };
    }
  });
  // Place the mesh immediately; otherwise it renders and raycasts at the world origin for its first frame.
  parts.group.position.set(x, 0, z);
  parts.group.rotation.y = parts.glb ? initYaw : (initYaw + Math.PI);
  scene.add(parts.group);
  enemies.push(en);
  return en;
}

function disposeEnemyGeometry(en) {
  if (!en) return;
  if (en.glbSkeletons && en.glbSkeletons.length) {
    for (let i = 0; i < en.glbSkeletons.length; i++) {
      if (en.glbSkeletons[i] && typeof en.glbSkeletons[i].dispose === 'function') {
        en.glbSkeletons[i].dispose();
      }
    }
    en.glbSkeletons.length = 0;
  }
  if (en.parts.glb) {
    // GLB model geometry is shared, but each enemy owns its two hitboxes.
    en.hitBody.geometry.dispose(); en.hitHead.geometry.dispose();
  } else en.parts.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
}

// Hit flash: swap every visible mesh to a bright material for a few frames.
function setHitFlash(en, on) {
  en.parts.group.traverse(function (o) {
    if (!o.isMesh || o === en.hitBody || o === en.hitHead || o === en.parts.hitLegs) return;
    if (on) { if (!o.userData.baseMat) o.userData.baseMat = o.material; o.material = o.isSkinnedMesh ? HIT_FLASH_SKIN : HIT_FLASH; }
    else if (o.userData.baseMat) { o.material = o.userData.baseMat; o.userData.baseMat = null; }
  });
}
// dmg already includes weapon/range/head multipliers. dir = bullet direction (optional).
function damageEnemy(en, dmg, point, isHead, dir, explosive) {
  if (en.dead) return;
  // armour: heavies shrug off part of body damage; leg hits do less
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
  // impulse: bullets nudge, big hits stagger
  if (dir) en.knock.addScaledVector(dir, Math.min(3, d / 30) * (en.kind === 2 ? 0.3 : 1));
  if (en.blastImpulse) { en.knock.x += en.blastImpulse.x; en.knock.z += en.blastImpulse.z; }
  if (d > 45 || isHead) en.staggerT = Math.max(en.staggerT, en.kind === 2 ? 0.15 : 0.35);
  en.hitDir = dir ? dir.clone() : null;
  if (kill) killEnemy(en, isHead, explosive);
  else {
    en.stateT = 0;
    if (en.state === 'idle') en.state = 'chase';
    if (en.kind === 1 && en.health < en.maxHealth * 0.5 && !en.cover) en.wantCover = true;
  }
  en.blastImpulse = null;
}

function killEnemy(en, isHead, explosive) {
  en.dead = true; en.deathT = 0;
  if (en.flashT) { setHitFlash(en, false); en.flashT = 0; }
  const bonus = en.kind === 2 ? 80 : en.kind === 3 ? 40 : en.kind === 1 ? 20 : 0;
  addScore(CFG.score.kill + bonus + (isHead ? CFG.score.headshot : 0), (isHead ? 'Headshot · ' : '') + ['Runner', 'Rifleman', 'Heavy', 'Grenadier'][en.kind] + ' down');
  registerKillT();   // multi-kill streak bonus (2+ kills within 4 s)
  kills++;
  if (isHead) headshots++;
  dropPickup(en.pos);
  playSound('kill');
  // ragdoll-lite: a rigid body toppling about its feet in the direction it was hit,
  // or launched and tumbling if a blast killed it
  const dir = en.hitDir || new THREE.Vector3(en.pos.x - player.pos.x, 0, en.pos.z - player.pos.z).normalize();
  const fall = new THREE.Vector3(dir.x, 0, dir.z);
  if (fall.lengthSq() < 1e-4) fall.set(Math.sin(en.yaw), 0, Math.cos(en.yaw)).negate();
  fall.normalize();
  en.corpse = {
    fall: fall, axis: new THREE.Vector3(fall.z, 0, -fall.x),    // rotation axis = up x fall
    theta: 0.05, omega: 1.2 + Math.min(3.5, en.knock.length() * 0.9) + (isHead ? 1.0 : 0),
    vel: explosive ? new THREE.Vector3(en.knock.x * 0.8, 3.5 + Math.random() * 2.5, en.knock.z * 0.8) : new THREE.Vector3(en.knock.x * 0.3, 0, en.knock.z * 0.3),
    y: en.pos.y, landed: !explosive, bounced: false, pooled: false,
    limbs: [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]
  };
  if (explosive) en.corpse.omega += 4;
  // drop the weapon (box-man): it falls as a physics object
  const p = en.parts;
  if (!p.glb && p.gun && p.gun.parent) {
    p.gun.updateMatrixWorld(true);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion();
    p.gun.getWorldPosition(wp); p.gun.getWorldQuaternion(wq);
    p.gun.parent.remove(p.gun);
    p.gun.quaternion.copy(wq);
    p.gun.traverse(function (o) { if (o.isMesh) o.userData = { vfx: true }; });
    spawnDebris(p.gun, wp, new THREE.Vector3(fall.x * 2 + (Math.random() - 0.5), 2 + Math.random(), fall.z * 2 + (Math.random() - 0.5)), 0.15, 6.5);
  }
  // hitboxes no longer collide with bullets
  p.hitBody.userData.enemyRef = null; p.hitHead.userData.enemyRef = null;
}
const _corpseQ = new THREE.Quaternion(), _yawQ = new THREE.Quaternion(), _upV = new THREE.Vector3(0, 1, 0);
function updateCorpse(en, dt) {
  const c = en.corpse, p = en.parts;
  // translational (blast launch / slide) with ground contact
  c.vel.y -= c.landed ? 0 : 16 * dt;
  en.pos.x += c.vel.x * dt; en.pos.z += c.vel.z * dt;
  if (!c.landed) {
    c.y += c.vel.y * dt;
    if (c.y <= en.pos.y) { c.y = en.pos.y; c.landed = true; c.vel.multiplyScalar(0.3); c.vel.y = 0; }
  } else { c.vel.multiplyScalar(Math.exp(-5 * dt)); }
  // topple: inverted pendulum about the feet, theta'' = (3g / 2L) sin(theta)
  if (c.theta < Math.PI / 2 || !c.bounced) {
    c.omega += (3 * 16 / (2 * 1.8)) * Math.sin(c.theta) * dt;
    c.theta += c.omega * dt;
    if (c.theta >= Math.PI / 2) {
      c.theta = Math.PI / 2;
      if (!c.bounced && c.omega > 1.5) { c.omega = -c.omega * 0.22; c.bounced = true; playSound3D('land', en.pos.x, 0, en.pos.z); }
      else { c.omega = 0; c.bounced = true; }
    }
  }
  const yawOff = p.glb ? en.yaw : en.yaw + Math.PI;
  _yawQ.setFromAxisAngle(_upV, yawOff);
  _corpseQ.setFromAxisAngle(c.axis, c.theta);
  if (!p.glb || !en.actions || !en.actions.die) p.group.quaternion.copy(_corpseQ).multiply(_yawQ);
  else p.group.quaternion.copy(_yawQ);
  p.group.position.set(en.pos.x, c.y - Math.max(0, en.deathT - 4.5) * 0.4, en.pos.z);
  // limbs go slack (box-man)
  if (!p.glb && p.legL) {
    const k = Math.min(1, en.deathT * 3);
    p.armL.rotation.x = (-1.2 + c.limbs[0]) * k; p.armR.rotation.x = (-1.4 + c.limbs[1]) * k;
    p.armL.rotation.z = -0.6 * k; p.armR.rotation.z = 0.6 * k;
    p.legL.rotation.x = c.limbs[2] * 0.6 * k; p.legR.rotation.x = c.limbs[3] * 0.6 * k;
    p.kneeL.rotation.x = 0.5 * k; p.kneeR.rotation.x = 0.3 * k;
  }
  if (c.landed && c.theta >= Math.PI / 2 - 0.01 && !c.pooled && en.deathT > 0.8) {
    c.pooled = true;
    _tmpBloodP.set(en.pos.x + c.fall.x * 0.9, en.pos.y + 0.013, en.pos.z + c.fall.z * 0.9);
    spawnBloodDecal(_tmpBloodP, _upV, 1.4 + Math.random() * 0.6);
  }
}
const _tmpBloodP = new THREE.Vector3();

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
  return out.set(en.pos.x, en.pos.y + (E_DIM.pelvisH + 0.5) * (en.kind === 2 ? 1.25 : 1) - en.crouch * 0.4, en.pos.z);
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
      if (en.actions && en.actions.die) { setEnemyAnim(en, 'die', 0.08); if (en.mixer) en.mixer.update(dt); }
      if (en.corpse) updateCorpse(en, dt);
      if (en.deathT > 6.5) {
        scene.remove(en.parts.group);
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
    if (en.parts.glb) en.crouchTarget = 0;   // the GLB rig has no crouch pose
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

// pick + drive the right GLB clip; fall back to procedural limb animation for the box-man
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
  p.group.rotation.y = p.glb ? en.yaw : (en.yaw + Math.PI);
  if (en.mixer) en.mixer.update(dt);
  const moving = Math.hypot(en.vel.x, en.vel.z);
  en.throwT = Math.max(0, (en.throwT || 0) - dt);
  if (en.actions) {
    // GLB soldier: pick clip by state
    let clip = 'idle';
    if (en.swinging !== undefined && en.swinging > 0) clip = 'attack-melee-right';
    else if (en.state === 'charge' || moving > 4.5) clip = 'sprint';
    else if (moving > 0.5) clip = (en.kind === 1 || en.kind === 3) && en.state === 'engage' ? 'holding-right' : 'walk';
    else if (en.state === 'engage' || en.state === 'incover') clip = gameT - en.lastShotT < 0.3 ? 'holding-right-shoot' : 'holding-right';
    if (en.throwT > 0 && en.actions['attack-melee-right']) clip = 'attack-melee-right';
    if (!en.actions[clip]) clip = 'idle';
    setEnemyAnim(en, clip, 0.12);
    if (en.actions[en.animCur]) {
      const isMove = en.animCur === 'walk' || en.animCur === 'sprint' || en.animCur === 'holding-right' || en.animCur === 'holding-right-shoot';
      if (isMove && moving > 0.1) {
        const refSpeed = 3.2; // reference speed matching walk stride
        en.actions[en.animCur].setEffectiveTimeScale(moving / refSpeed);
      } else {
        en.actions[en.animCur].setEffectiveTimeScale(1.0);
      }
    }
    return;
  }
  // ---- procedural box-man: walk cycle with knees, aim pose, melee swing, crouch, flinch ----
  const spd = moving > 0.3 ? 9 * (moving / 3.2) : 0;
  en.walkPhase += spd * dt;
  const amp = moving > 0.3 ? Math.min(0.75, 0.35 + moving * 0.08) : 0;
  const swing = Math.sin(en.walkPhase) * amp;
  const cr = en.crouch;
  p.legL.rotation.x = swing - cr * 1.1;
  p.legR.rotation.x = -swing - cr * 1.1;
  p.kneeL.rotation.x = Math.max(0, -Math.sin(en.walkPhase - 0.6)) * amp * 1.4 + cr * 2.0;
  p.kneeR.rotation.x = Math.max(0, Math.sin(en.walkPhase - 0.6)) * amp * 1.4 + cr * 2.0;
  const aiming = (en.kind === 1 || en.kind === 3) && (en.state === 'engage' || en.state === 'incover' || en.aimT > 0.4);
  if (en.swinging !== undefined && en.swinging > -1) {
    // wind-up raises the arm, the strike swings it down
    const k = en.swinging > 0 ? 1 - en.swinging / (en.swingDur || 0.5) : 1 + Math.min(1, -en.swinging * 4);
    p.armR.rotation.x = k <= 1 ? -2.4 * k : -2.4 + (k - 1) * 3.2;
    p.foreR.rotation.x = -0.4;
    p.armL.rotation.x = -0.5;
  } else if (en.throwT > 0) {
    p.armR.rotation.x = -2.6 + (0.5 - en.throwT) * 5; p.foreR.rotation.x = -0.6;
  } else if (aiming) {
    p.armR.rotation.x = -1.25; p.foreR.rotation.x = -0.35; p.armR.rotation.z = 0.15;
    p.armL.rotation.x = -1.35; p.foreL.rotation.x = -0.5; p.armL.rotation.z = -0.45;
  } else {
    p.armL.rotation.x = -swing * 0.7 - (en.kind === 0 ? 0.4 : 0.2); p.armL.rotation.z = 0;
    p.armR.rotation.x = swing * 0.7 - (en.kind === 0 ? 0.4 : 0.6); p.armR.rotation.z = 0;
    p.foreL.rotation.x = -0.35; p.foreR.rotation.x = -0.5;
  }
  // torso: lean into runs, pitch toward the player when aiming, flinch when hit
  const pitch = Math.atan2(player.pos.y - (en.pos.y + 1.5), dist);
  p.body.rotation.x = (aiming ? -pitch * 0.35 : 0) + (en.kind === 0 || en.state === 'charge' ? 0.18 : 0) + en.staggerT * 0.6 + (en.state === 'windup' ? -0.25 : 0);
  p.body.rotation.z = en.staggerT * 0.4 * Math.sin(en.walkPhase * 3);
  // crouch lowers the whole body (hitboxes follow)
  const bodyDrop = cr * 0.42;
  p.body.position.y = (moving > 0.3 ? Math.abs(Math.cos(en.walkPhase)) * 0.03 : Math.sin(gameT * 1.8 + en.zig) * 0.008) - bodyDrop;
  p.hitBody.position.y = 1.24 - bodyDrop; p.hitHead.position.y = E_DIM.pelvisH + E_DIM.bodyH + 0.16 - bodyDrop;
}
