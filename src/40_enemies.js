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
  const hitBody = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.60, 0.5), hbMat);
  hitBody.position.y = 1.24;
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

// Read a centered sample from an off-screen render target.
//
// This used to read the DEFAULT framebuffer, which is undefined to sample once the
// browser has composited the frame (the drawing buffer is cleared unless
// preserveDrawingBuffer is set). At startup, when compositing is busiest, both
// samples came back identical — a difference of exactly 0 — so a perfectly good
// GPU was reported as broken and every desktop player was silently downgraded to
// the fallback box-man. An FBO has well-defined read semantics.
const PROBE_SIZE = 32;
function readProbePixels(target, size) {
  const pixels = new Uint8Array(size * size * 4);
  const x = Math.max(0, Math.floor(target.width / 2 - size / 2));
  const y = Math.max(0, Math.floor(target.height / 2 - size / 2));
  renderer.readRenderTargetPixels(target, x, y, size, size, pixels);
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
  let probeTarget = null;
  try {
    if (typeof gunGroup !== 'undefined') gunGroup.visible = false;
    camera.position.set(0, 1.7, -31);
    camera.lookAt(0, 1.0, -35);
    camera.updateMatrixWorld(true);
    camera.aspect = renderer.domElement.width / renderer.domElement.height;
    camera.updateProjectionMatrix();
    probeTarget = new THREE.WebGLRenderTarget(256, 256);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    // Warm the renderer first: this runs on the session's very first frames, when
    // every material still needs compiling.
    renderer.setRenderTarget(probeTarget);
    renderer.render(scene, camera);
    const before = readProbePixels(probeTarget, PROBE_SIZE);

    probe = spawnEnemy(0, 0, -35);
    renderer.render(scene, camera);
    const after = readProbePixels(probeTarget, PROBE_SIZE);
    renderer.setRenderTarget(null);

    let painted = 0;
    for (let i = 0; i < after.length; i += 4) {
      const difference = Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2]);
      if (difference > 30) painted++;
    }
    const threshold = before.length / 16;
    GLB_SOLDIER_BROKEN = !(painted > threshold);
    if (GLB_SOLDIER_BROKEN) console.warn('Skinned soldier failed GPU paint test — using simple enemy models. (painted ' + painted + ' / need >' + threshold + ')');
    else console.log('soldier paint probe OK (' + painted + ' px)');
  } catch (err) {
    GLB_SOLDIER_BROKEN = true;
    console.warn('Soldier probe threw, using simple enemy models.', err);
  } finally {
    renderer.setRenderTarget(null);
    if (probeTarget) probeTarget.dispose();
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

function spawnEnemy(kind, x, z, opts) {
  const spawnOpts = opts || {};
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
    // Calibrated against the scaled model: total height 1.84 m. The head box used
    // to span 1.68-2.02, floating 0.18 m of hittable air above the soldier's head
    // while leaving a 0.21 m gap over the body box. Chest 0.45-1.52, head 1.52-1.84.
    const hbMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitBody = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.07, 0.5), hbMat);
    hitBody.position.y = 0.985;
    const hitHead = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.32, 0.30), hbMat);
    hitHead.position.y = 1.68;
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
  const scale = kind === 2 ? 1.25 : kind === 3 ? 1.1 : kind === 4 ? 0.88 : 1;
  parts.group.scale.set(scale, scale, scale);
  const baseHp = kind === 0 ? CFG.ai.maxHealth
    : kind === 1 ? CFG.ai.maxHealth * 1.35
    : kind === 3 ? CFG.ai.maxHealth * 2.2      // shielded advancer
    : kind === 4 ? CFG.ai.maxHealth * 0.55     // scout: fast and fragile
    : kind === 5 ? CFG.ai.maxHealth * 1.2      // grenadier
    : 320;
  const curWave = typeof getWaveNum === 'function' ? getWaveNum() : (typeof waveNum !== 'undefined' ? waveNum : 1);
  const waveMul = CORE.endlessHpMultiplier(Math.max(1, curWave), CFG.wave.victoryWave);
  // Special waves and elite rolls both scale the same base rather than adding a
  // parallel stat path: an Ironclad elite tank is one multiply, not a special case.
  const specialHp = (typeof waveSpecial !== 'undefined' && waveSpecial && waveSpecial.hpMul)
    ? waveSpecial.hpMul : 1;
  const isElite = !!spawnOpts.elite;
  const hp = Math.round(baseHp * waveMul * diff().hp * specialHp * (isElite ? CORE.ELITE.hpMul : 1));
  const dx = player.pos.x - x, dz = player.pos.z - z;
  const initYaw = (dx !== 0 || dz !== 0) ? Math.atan2(dx, dz) : 0;
  const en = {
    blindT: 0, stunT: 0,      // flashbang / stun grenade timers
    elite: isElite,
    kind: kind,
    eliteRing: null,               // 0=runner(melee), 1=rifleman, 2=tank(slow heavy)
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(),
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
    nextShot: 0,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    // Set at spawn from the wave's unlocked behaviours; shielded units never flank
    // (their whole point is a frontal push you have to get around).
    // Scouts flank by definition — that is their whole job. Shielded units and
    // grenadiers never do. Everyone else flanks once the wave-8 behaviour unlocks.
    flanker: kind === 4 ? true
      : (kind === 3 || kind === 5) ? false
      : !!(typeof waveBehaviours !== 'undefined' && waveBehaviours.flanking) && Math.random() < 0.45,
    // Flank for a while, then commit. Without a window a fast flanker orbits forever.
    flankT: CORE.flankWindow(Math.random()),
    strafeT: 0,
    walkPhase: Math.random() * 10,
    // speedMul is the single knob every movement state multiplies through, so a
    // Blitz wave and an elite roll stack here rather than as new cases in moveEnemy.
    speedMul: (0.85 + Math.random() * 0.3) * (isElite ? CORE.ELITE.speedMul : 1)
      * ((typeof waveSpecial !== 'undefined' && waveSpecial && waveSpecial.speedMul) ? waveSpecial.speedMul : 1),
    attackT: 0,
    hitBody: parts.hitBody,
    hitHead: parts.hitHead
  };
  // Visual tell: the shielded unit is steel-blue and slightly larger, so a player
  // knows to flank before they have wasted a magazine on the plate.
  const KIND_TINT = { 3: 0x4a6fa5, 4: 0x8fd66a, 5: 0xd6a24a };
  if (KIND_TINT[kind] !== undefined) {
    const tint = new THREE.Color(KIND_TINT[kind]);
    parts.group.traverse(function (o) {
      if (o.isMesh && o !== parts.hitBody && o !== parts.hitHead && o.material) {
        o.material = o.material.clone();
        if (o.material.color) o.material.color.lerp(tint, 0.55);
        o.userData.clonedTint = true;
      }
    });
  }
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
  // Tinted shielded units own cloned materials; everything else shares them.
  en.parts.group.traverse(function (o) {
    if (o.userData && o.userData.clonedTint && o.material && o.material.dispose) o.material.dispose();
  });
  if (en.parts.glb) {
    // GLB model geometry is shared, but each enemy owns its two hitboxes.
    en.hitBody.geometry.dispose(); en.hitHead.geometry.dispose();
  } else en.parts.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
}

// Shielded advancers (kind 3) carry a frontal plate: shots into the front arc are
// mostly absorbed, so they have to be flanked, headshot or grenaded. This is the
// wave-9+ answer to "the back half is the same fight with more bodies".
const SHIELD_ARC = Math.cos(Math.PI / 3);   // 60 degrees either side of facing
function shieldMultiplier(en, point) {
  if (en.kind !== 3 || !point) return 1;
  const fx = Math.sin(en.yaw), fz = Math.cos(en.yaw);      // facing the player
  const dx = point.x - en.pos.x, dz = point.z - en.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const facing = (dx / len) * fx + (dz / len) * fz;
  return facing > SHIELD_ARC ? 0.15 : 1;                   // 85% absorbed head-on
}

function damageEnemy(en, dmg, point, isHead, throughCover) {
  if (en.dead) return;
  // Remember where this shot came from and what it struck. If it turns out to be
  // the killing blow, the ragdoll is launched along it.
  en._lastHitNode = isHead ? 'head' : 'chest';
  if (point) {
    const hx = point.x - en.pos.x, hz = point.z - en.pos.z;
    const hl = Math.hypot(hx, hz) || 1;
    en._lastHitDirX = hx / hl;
    en._lastHitDirZ = hz / hl;
  }
  en._lastHitForce = dmg;
  const shield = isHead ? 1 : shieldMultiplier(en, point);
  if (shield < 1) { spawnImpact(point, null, null); showCenterMsgThrottled('SHIELDED — FLANK IT'); }
  // INSTA-KILL turns any connecting shot lethal, including one that a shield
  // would otherwise have absorbed.
  const lethal = typeof powerActive === 'function' && powerActive('instakill');
  en.health -= lethal ? en.health + 1 : dmg * shield;
  // Feedback tiers: a blocked shot used to give the identical ping to a clean body
  // hit, so the shield mechanic was invisible unless you read the patch notes.
  showHitmarker(isHead, shield < 1 ? 'block' : throughCover ? 'cover' : null);
  addCredits(CORE.creditsForDamage(en.health <= 0, isHead));
  addFieldCharge(lethal ? dmg : dmg * shield);
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
  // Physics, not a clip. Impulse magnitude is capped so a heavy hit tumbles a body
  // rather than firing it across the arena.
  const force = Math.min(0.085, 0.012 + (en._lastHitForce || 20) * 0.00035);
  spawnRagdoll(en, {
    node: en._lastHitNode || 'chest',
    x: (en._lastHitDirX || 0) * force,
    y: (isHead ? 0.030 : 0.016) + Math.random() * 0.008,
    z: (en._lastHitDirZ || 0) * force,
    spread: 0.3
  });
  const eliteMul = en.elite ? CORE.ELITE.scoreMul : 1;
  addScore((CFG.score.kill + (isHead ? CFG.score.headshot : 0)) * eliteMul,
    en.elite ? 'ELITE DOWN' : isHead ? 'Headshot kill' : 'Hostile down');
  if (en.elite) addCredits(CORE.creditsForDamage(true, isHead) * (CORE.ELITE.creditMul - 1));
  registerKillT();   // multi-kill streak bonus (2+ kills within 4 s)
  kills++;
  if (isHead) headshots++;
  // Power-ups roll before the ordinary ammo/med table: a MAX AMMO that also
  // dropped a magazine would waste the drop.
  if (CORE.powerUpDropped(Math.random())) dropPowerUp(en.pos);
  else dropPickup(en.pos);
  registerStreakKill();
  playSound('kill');
}

// Horizontal distance from an enemy to the player.
//
// player.pos is anchored at EYE height (1.7 m) while en.pos is anchored at the
// feet (y = 0), so a 3-D distance reads 1.7 m of pure height as separation. Every
// gameplay radius — melee reach, stop distance, ranged range — is horizontal, so
// they must all be measured horizontally or enemies walk into the player's body.
function distToPlayer(en) {
  return CORE.horizDist(en.pos.x, en.pos.z, player.pos.x, player.pos.z);
}

// Feet-to-feet vertical separation. distToPlayer is horizontal by design (BUG-02),
// which makes a whole storey invisible to it: an agent on the ground floor measures
// zero distance from a player on the slab above. Anything that means "can touch"
// has to consult this as well.
function vertGapToPlayer(en) {
  return (player.pos.y - eyeHeight()) - en.pos.y;
}

// ---- Shared flow field ------------------------------------------------------
// One breadth-first flood from the player's cell serves every enemy, so pathing
// cost is independent of enemy count. Recomputed on a fixed cadence, or
// immediately when the player crosses into a different cell.
let flowT = 0, flowCellX = -9999, flowCellZ = -9999;
const FLOW_INTERVAL = 0.25;
const _flowDir = { x: 0, z: 0 };
function updateFlowField(dt) {
  if (!navGrid) return;
  flowT -= dt;
  const cx = Math.floor(player.pos.x), cz = Math.floor(player.pos.z);
  if (flowT > 0 && cx === flowCellX && cz === flowCellZ) return;
  flowT = FLOW_INTERVAL;
  flowCellX = cx; flowCellZ = cz;
  CORE.computeFlowField(navGrid, player.pos.x, player.pos.z);
}

// Steering: follow the flow field when closing distance, fall back to a direct
// vector when the field has nothing for this cell (e.g. an enemy shoved outside
// the walkable set by the separation pass).
function moveEnemy(en, dt) {
  const cfg = CFG.ai;
  const toPlayer = tmpV2.set(player.pos.x - en.pos.x, 0, player.pos.z - en.pos.z);
  const dist = toPlayer.length();
  let speed = 0;
  if (en.state === 'fallback') speed = cfg.rangedSpeed * 1.25 * en.speedMul;
  else if (en.state === 'chase') speed = (en.kind === 0 ? cfg.chaseSpeed
    : en.kind === 2 ? 2.2
    : en.kind === 3 ? 2.0
    : en.kind === 4 ? cfg.chaseSpeed * 1.35    // scout
    : en.kind === 5 ? 2.6                      // grenadier repositions slowly
    : cfg.speed) * en.speedMul;
  else if (en.state === 'strafe') speed = cfg.rangedSpeed * en.speedMul;
  else speed = cfg.speed * 0.5 * en.speedMul;
  if (en.kind === 1 && dist < cfg.rangedRange && en.state !== 'idle') speed = cfg.rangedSpeed;
  // desired velocity
  if (dist > 0.01) toPlayer.normalize();
  let mvx = toPlayer.x, mvz = toPlayer.z;
  if (en.state === 'chase') {
    // Straight-line seek wedges on every wall corner in this arena; route instead.
    // Close in, steer directly so the final approach does not snap to cell centres.
    const routed = dist > 3 && navGrid ? CORE.flowDirAt(navGrid, en.pos.x, en.pos.z, _flowDir) : null;
    if (routed) { mvx = routed.x; mvz = routed.z; }
    // Flankers (wave 8+) bias sideways until they are close, so a pack stops
    // arriving as one clump down a single corridor.
    if (en.flanker) {
      en.flankT -= dt;
      const bias = CORE.flankBiasNow(en.flankT, dist) * 0.45;
      if (bias > 0.001) {
        const px = -mvz * en.strafeDir, pz = mvx * en.strafeDir;
        mvx = mvx * (1 - bias) + px * bias; mvz = mvz * (1 - bias) + pz * bias;
        const l = Math.hypot(mvx, mvz) || 1; mvx /= l; mvz /= l;
      }
    }
  } else if (en.state === 'fallback') {
    // straight back, with a sideways bias so it does not reverse into a corner
    mvx = -toPlayer.x * 0.8 - toPlayer.z * 0.6 * en.strafeDir;
    mvz = -toPlayer.z * 0.8 + toPlayer.x * 0.6 * en.strafeDir;
    const l = Math.hypot(mvx, mvz) || 1; mvx /= l; mvz /= l;
  } else if (en.state === 'strafe') {
    // circle-strafe the player
    mvx = -toPlayer.z * en.strafeDir; mvz = toPlayer.x * en.strafeDir;
    en.strafeT -= dt;
    if (en.strafeT <= 0) { en.strafeDir *= -1; en.strafeT = 1.5 + Math.random() * 2; }
  }
  en.vel.x = mvx * speed;
  en.vel.z = mvz * speed;
  // obstacle pushout (AABB vs point with radius) + step-up allowance
  const r = 0.4 * (en.kind === 2 ? 1.4 : 1);
  const stepH = 0.60;
  const head = en.pos.y + (en.kind === 2 ? 2.3 : 1.85);
  // Sub-stepped for the same reason the player is: a 0.1 s frame at chase speed
  // is half a metre of travel against 0.8 m walls.
  const nSteps = CORE.subStepCount(speed, dt, 0.3);
  const sdt = dt / nSteps;
  for (let s = 0; s < nSteps; s++) {
    en.pos.x += en.vel.x * sdt;
    en.pos.z += en.vel.z * sdt;
    const feet = en.pos.y;
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
  }
  en.pos.x = Math.max(-mapBounds, Math.min(mapBounds, en.pos.x));
  en.pos.z = Math.max(-mapBounds, Math.min(mapBounds, en.pos.z));

  // Vertical resolve: find highest floor below feet + stepH
  const feet = en.pos.y;
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
  if (losFrame % 3 !== en._losSkip) { if (en._losCache === undefined) return false; return en._losCache; }
  // Riflemen ask twice on their own frame — once in the state machine, once in the
  // ranged-attack block. The old throttle only cached on SKIPPED frames, so the
  // second call redid a full-scene raycast. Cache per tick, not just per skip.
  if (en._losTick === losFrame) return en._losCache;
  en._losTick = losFrame;
  _losFrom.set(en.pos.x, en.pos.y + E_DIM.pelvisH * (en.kind === 2 ? 1.25 : 1) + 0.5, en.pos.z);
  _losTo.copy(player.pos);
  _losTo.x += (Math.random() - 0.5) * 0.3; _losTo.z += (Math.random() - 0.5) * 0.3;
  // Analytic slab test against the collider AABBs rather than a mesh raycast.
  // Once static geometry was merged into a few large batches, the mesh version
  // cost 1.37 ms per frame because three walks every triangle of every candidate;
  // "is a wall in the way" does not need triangle precision.
  const blocked = CORE.segmentBlocked(
    _losFrom.x, _losFrom.y, _losFrom.z,
    _losTo.x, _losTo.y, _losTo.z, colliders, 0.25)
    // Smoke is one sphere test on a path that is already analytic, which is the
    // only reason it is affordable — a second mesh raycast per enemy per tick
    // would not have been.
    || CORE.smokeBlocks(_losFrom.x, _losFrom.y, _losFrom.z,
        _losTo.x, _losTo.y, _losTo.z, smokeVolumes());
  en._losCache = !blocked;
  return !blocked;
}
const tmpV2 = new THREE.Vector3();

// Nearest-N shadow budget. Recomputed a few times a second rather than per frame:
// the set barely changes between frames and toggling castShadow is not free.
const SHADOW_ENEMY_BUDGET = IS_TOUCH ? 4 : 8;
let shadowBudgetT = 0;
const _shadowPos = [];
function enemyShadowMeshes(en) {
  if (!en._shadowMeshes) {
    const list = [];
    en.parts.group.traverse(function (o) { if (o.isMesh) list.push(o); });
    en._shadowMeshes = list;
  }
  return en._shadowMeshes;
}
function setEnemyCastShadow(en, on) {
  if (en._castsShadow === on) return;
  en._castsShadow = on;
  const list = enemyShadowMeshes(en);
  for (let i = 0; i < list.length; i++) list[i].castShadow = on;
}
function updateEnemyShadowBudget(dt) {
  shadowBudgetT -= dt;
  if (shadowBudgetT > 0) return;
  shadowBudgetT = 0.25;
  _shadowPos.length = 0;
  for (let i = 0; i < enemies.length; i++) _shadowPos.push(enemies[i].pos);
  const keep = CORE.shadowCasters(_shadowPos, player.pos.x, player.pos.z, SHADOW_ENEMY_BUDGET);
  for (let i = 0; i < enemies.length; i++) setEnemyCastShadow(enemies[i], false);
  for (let k = 0; k < keep.length; k++) setEnemyCastShadow(enemies[keep[k]], true);
}

// A stun slows; a flash stops the agent shooting and scrambles its facing. Both
// are read by moveEnemy (speedMul) and enemyShoot (blindT) rather than by a new
// state, so no archetype needs to know they exist.
function updateStatusEffects(dt) {
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    if (en.stunT > 0) {
      en.stunT = Math.max(0, en.stunT - dt);
      en.speedMul = en.baseSpeedMul === undefined ? (en.speedMul || 1) : en.baseSpeedMul;
      if (en.baseSpeedMul === undefined) en.baseSpeedMul = en.speedMul;
      en.speedMul = en.baseSpeedMul * 0.35;
    } else if (en.baseSpeedMul !== undefined) {
      en.speedMul = en.baseSpeedMul;
      en.baseSpeedMul = undefined;
    }
    if (en.blindT > 0) {
      en.blindT = Math.max(0, en.blindT - dt);
      en.yaw += dt * 1.6;          // wanders instead of holding an aim
    }
  }
}

function updateEnemies(dt) {
  updateStatusEffects(dt);
  losFrame++;
  updateFlowField(dt);
  updateEnemyShadowBudget(dt);
  for (let i = enemies.length - 1; i >= 0; i--) {
    const en = enemies[i];
    if (en._losSkip === undefined) en._losSkip = i % 3;
    if (en.dead) {
      // The corpse belongs to the ragdoll simulation from here; drop it from the
      // AI list immediately so nothing pathfinds, shoots or collides on its behalf.
      enemies.splice(i, 1);
      continue;
    }
    // DEAD PLAYER: stop all AI activity — enemies wander/idle, never attack a corpse
    const playerGone = player.dead;
    en.stateT += dt;
    const dist = distToPlayer(en);
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
    } else if (en.kind === 3) {
      // shielded advancer: walks straight at you, plate forward, never strafes
      en.state = 'chase';
    } else if (en.kind === 4) {
      // scout: pure rusher, but flanks the whole way in
      en.state = 'chase';
    } else if (en.kind === 5) {
      // grenadier: holds a throwing distance and lobs. Push it and it RETREATS —
      // it must never close, or it ends up standing on top of the player.
      if (dist < CORE.enemyPreferredRange(5)) en.state = 'fallback';
      else if (dist < 34 && hasLOS(en)) { if (en.state !== 'strafe') { en.state = 'strafe'; en.strafeT = 2.5; } }
      else en.state = 'chase';
    } else {
      // tank: slow chase always
      en.state = 'chase';
    }
    moveEnemy(en, dt);
    // Stuck detection: no navmesh is perfect, and an enemy shoved into a corner by
    // the separation pass can still pin itself. Repath first; if it is still pinned
    // well past that, relocate it to a valid ring point rather than leaving a
    // hostile the wave counter is waiting on parked against a wall forever.
    // Only while actually trying to CLOSE distance. An enemy holding at melee
    // range, or a rifleman holding an angle with line of sight, is stationary on
    // purpose — treating that as stuck teleports arrived attackers away and the
    // wave never resolves.
    const closing = CORE.isClosingDistance(en.state, dist, en.kind === 2 ? 2.6 : 1.9);
    if (closing) {
      if (!en.stuck) en.stuck = {};
      const verdict = CORE.updateStuck(en.stuck, en.pos.x, en.pos.z, dt);
      if (verdict === 'repath') {
        flowT = 0; flowCellX = -9999;              // force a fresh flood next tick
        en.strafeDir *= -1;
      } else if (verdict === 'teleport') {
        relocateStuckEnemy(en);
      }
    } else if (en.stuck) {
      en.stuck = null;                             // arrived: forget the stall history
    }
    // Catches the other failure mode: an enemy that circles busily but never gets
    // closer, leaving a wave permanently one kill short.
    if (closing) {
      if (!en.progress) en.progress = {};
      if (CORE.updateProgress(en.progress, dist, dt) === 'reposition') relocateStuckEnemy(en);
    } else if (en.progress) {
      en.progress = null;
    }
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
    // Applies to every kind, not a hand-kept list: anything that can reach the
    // player must be pushed back out, or it occupies the player's position.
    const stopDist = CORE.enemyStopDistance(en.kind);
    // Only hold and push out against a player on the same level. Without the
    // vertical gate a player upstairs shoves agents around on the floor below —
    // measured at 1.83 m of displacement through a concrete slab.
    if (CORE.withinReach(dist, vertGapToPlayer(en), stopDist)) {
      // back off slightly if overlapping the player capsule
      const overlap = stopDist - dist;
      if (overlap > 0) {
        // dist is horizontal, so a body-overlap really is a near-zero separation:
        // fall back to the enemy's own facing rather than dividing by ~0 and
        // producing a garbage normal that leaves it standing inside the player.
        let nx, nz;
        if (dist > 0.05) { nx = (en.pos.x - player.pos.x) / dist; nz = (en.pos.z - player.pos.z) / dist; }
        else { nx = -Math.sin(en.yaw); nz = -Math.cos(en.yaw); }
        en.pos.x += nx * overlap; en.pos.z += nz * overlap;
      }
    }
    // melee attack (runners + tanks): staggered windup, damage cap, real cooldown
    const canMelee = en.kind === 0 || en.kind === 2 || en.kind === 3 || en.kind === 4;
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
        if (CORE.withinReach(dist, vertGapToPlayer(en), reach + 0.35) && !player.dead) {
          // global melee damage cap: max 2 melee hits landing within any 0.8s window
          const now = gameT;
          meleeHits = meleeHits.filter(t => now - t < 0.8);
          if (meleeHits.length < 2) {
            damagePlayer((CFG.ai.meleeDamage + (en.kind === 2 ? 10 : 0) + waveNum * 0.4) * diff().dmg, dirToDeg(en));
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
        if (waveBehaviours.burstFire) {
          // Bursts of 3 with a longer recovery: same average output, far more
          // pressure to break line of sight instead of trading in the open.
          if (en.burst === undefined || en.burst <= 0) en.burst = 3;
          en.burst--;
          en.nextShot = gameT + (en.burst > 0 ? 0.12 : CFG.ai.rangedROF * 1.6 * (0.8 + Math.random() * 0.4));
        } else {
          en.nextShot = gameT + CFG.ai.rangedROF * (0.75 + Math.random() * 0.5);
        }
        enemyShoot(en, dist);
      } else {
        en.nextShot = gameT + 0.4;
        en.burst = 0;
      }
    }
    // Grenadiers (wave 6+) throw as their primary attack, with or without LOS —
    // that is the point of the unit: it denies a position rather than duelling.
    if (en.kind === 5 && !player.dead && dist > 9 && dist < 36 && gameT > (en.nextNade || 3)) {
      en.nextNade = gameT + 5.5 + Math.random() * 4;
      throwEnemyGrenade(en);
    }
    // Riflemen pick it up too once the wave-12 behaviour unlocks, but only to
    // flush a player who is actually behind cover.
    if (waveBehaviours.enemyNades && en.kind === 1 && !player.dead &&
        dist > 8 && dist < 32 && gameT > (en.nextNade || 6)) {
      en.nextNade = gameT + 11 + Math.random() * 9;
      if (!hasLOS(en)) throwEnemyGrenade(en);   // only when the player IS in cover
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

// Last-resort unstick: drop the enemy on the nearest walkable cell that can
// actually reach the player, preferring somewhere off-screen behind them.
function relocateStuckEnemy(en) {
  if (!navGrid) return;
  let best = null, bestScore = -Infinity;
  for (let a = 0; a < 16; a++) {
    const ang = a / 16 * Math.PI * 2;
    for (let rad = 14; rad <= 30; rad += 4) {
      const x = player.pos.x + Math.cos(ang) * rad;
      const z = player.pos.z + Math.sin(ang) * rad;
      if (Math.abs(x) > mapBounds || Math.abs(z) > mapBounds) continue;
      if (CORE.navDistanceAt(navGrid, x, z) === CORE.UNREACHABLE) continue;
      // prefer roughly 20 m out, and behind the player's current facing
      const toX = x - player.pos.x, toZ = z - player.pos.z;
      const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
      const behind = -(toX * fwdX + toZ * fwdZ) / (rad || 1);
      const score = -Math.abs(rad - 20) + behind * 5;
      if (score > bestScore) { bestScore = score; best = [x, z]; }
    }
  }
  if (!best) return;
  en.pos.set(best[0], 0, best[1]);
  en.vel.set(0, 0, 0);
  en.stuck = {};
  en.state = 'chase';
  en.stateT = 0;
}

// Enemy frag: reuses the player's grenade physics and blast, with its own mesh so
// the existing pickup/HUD accounting is untouched.
function throwEnemyGrenade(en) {
  if (typeof liveGrenades === 'undefined' || liveGrenades.length > 6) return;
  const m = new THREE.Mesh(grenadeGeo, grenadeMat);
  const blink = new THREE.Mesh(fuseBlinkGeo, fuseLightMat);
  blink.position.y = 0.1; m.add(blink);
  m.position.set(en.pos.x, en.pos.y + 1.2, en.pos.z);
  const dx = player.pos.x - en.pos.x, dz = player.pos.z - en.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  // lobbed, deliberately imprecise — it is a flush, not a snipe
  const speed = Math.min(13, 6 + d * 0.32);
  const vel = new THREE.Vector3(dx / d, 0.62, dz / d).normalize().multiplyScalar(speed);
  vel.x += (Math.random() - 0.5) * 1.2; vel.z += (Math.random() - 0.5) * 1.2;
  liveGrenades.push({ m: m, vel: vel, fuse: CFG.grenade.fuse + 0.4, blink: blink,
    atRest: false, ring: null, restFuse: CFG.grenade.fuse, fromEnemy: true });
  scene.add(m);
  playSound3D('pin', en.pos.x, en.pos.y, en.pos.z);
  pushKillfeed('<span class="xp">INCOMING GRENADE</span>');
}

let _shieldMsgT = -99;
function showCenterMsgThrottled(txt) {
  if (gameT - _shieldMsgT < 3) return;
  _shieldMsgT = gameT;
  showCenterMsg(txt);
}

const _eshotFrom = new THREE.Vector3();
const _eshotTo = new THREE.Vector3();
function enemyShoot(en, dist) {
  if (en.blindT > 0) return;   // cannot aim at what it cannot see
  const eliteDmg = en.elite ? CORE.ELITE.dmgMul : 1;
  // visible tracer from enemy, damage applied probabilistically (accuracy scales with wave)
  playSound3D('eshot', en.pos.x, en.pos.y, en.pos.z);
  const from = _eshotFrom.set(en.pos.x, en.pos.y + E_DIM.pelvisH + 0.55, en.pos.z);
  const to = _eshotTo.copy(player.pos);
  to.y -= 0.2;
  spawnTracer(from, to, 0xff8844);
  const accBonus = (typeof waveSpecial !== 'undefined' && waveSpecial && waveSpecial.accBonus)
    ? waveSpecial.accBonus : 0;
  const acc = Math.min(CFG.ai.accMax + accBonus,
    CFG.ai.rangedAccuracy + waveNum * CFG.ai.accPerWave + accBonus);
  if (Math.random() < acc) {
    const dmg = (CFG.ai.rangedDamage + waveNum * 0.35) * diff().dmg * eliteDmg;
    // Tagged with the run id: REDEPLOY leaves `started` true, so without this a
    // bullet fired in the previous run could land in the first 300 ms of the next.
    const firedInRun = runId;
    // `from` is a shared scratch vector that the next shot overwrites, so capture
    // scalars. Same for the hit direction: the shooter may have moved by impact.
    const ox = from.x, oy = from.y, oz = from.z;
    const hitDeg = dirToDeg(en);
    setTimeout(function () {
      if (runId !== firedInRun) return;
      if (player.dead || !started || paused) return;
      // Re-check cover at IMPACT, not only at the trigger pull. The shot is
      // delayed by up to 300 ms for feel, and a sprinting player covers ~2.7 m in
      // that time — enough to climb the stairs and get behind the second-floor
      // slab. Without this, rounds fired a moment ago land through the floor the
      // player has already reached, which reads as being shot through the ceiling.
      if (CORE.segmentBlocked(ox, oy, oz,
          player.pos.x, player.pos.y, player.pos.z, colliders, 0.25)) return;
      if (CORE.smokeBlocks(ox, oy, oz,
          player.pos.x, player.pos.y, player.pos.z, smokeVolumes())) return;
      damagePlayer(dmg, hitDeg);
    }, Math.min(300, dist * 2.2));
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
  p.group.rotation.y = p.glb ? en.yaw : (en.yaw + Math.PI);
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
    if (en.actions[en.animCur]) {
      const isMove = en.animCur === 'walk' || en.animCur === 'sprint' || en.animCur === 'holding-right' || en.animCur === 'holding-right-shoot';
      if (isMove && moving > 0.1) {
        const refSpeed = 3.2; // reference speed matching walk stride
        const timeScale = moving / refSpeed;
        en.actions[en.animCur].setEffectiveTimeScale(timeScale);
      } else {
        en.actions[en.animCur].setEffectiveTimeScale(1.0);
      }
    }
    return;
  }
  // ---- procedural fallback (box-man) ----
  if (en.dead) return;
  const moveSpd = Math.hypot(en.vel.x, en.vel.z);
  const moving = moveSpd > 0.3;
  const spd = moving ? 9 * (moveSpd / 3.2) * (en.kind === 0 ? 1.5 : 1) : 0;
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
