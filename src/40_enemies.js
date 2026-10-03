// ============ ENEMIES & AI ============
'use strict';
// Simple humanoid: body box + head box + limbs, tinted materials, ragdoll-lite death.
const enemies = [];
let meleeHits = [];   // timestamps of landed melee hits (global damage cap)

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

function spawnEnemy(kind, x, z, opts) {
  const spawnOpts = opts || {};
  let parts = null;
  // Auto uses lightweight touch geometry; explicit detailed uses the articulated
  // procedural soldier on any device. Detail is page-latched to avoid mixing
  // actor/resource layouts mid-combat; input and enemy behavior are unchanged.
  const detail = typeof graphicsAtBoot === 'function'
    ? graphicsAtBoot(IS_TOUCH).enemyDetailed
    : CORE.graphicsSettings({}, typeof IS_TOUCH !== 'undefined' && IS_TOUCH).enemyDetailed;
  if (detail) {
    const sd = buildSoldier(kind);
    parts = { group: sd.group, body: sd.group, J: sd.J, hitBody: sd.hitBody, hitHead: sd.hitHead, soldier: true };
  } else {
    parts = makeEnemyMesh(kind);
  }
  const scale = CORE.enemyScale(kind);
  parts.group.scale.set(scale, scale, scale);
  const curWave = typeof getWaveNum === 'function' ? getWaveNum() : (typeof waveNum !== 'undefined' ? waveNum : 1);
  const specialHp = (typeof waveSpecial !== 'undefined' && waveSpecial && waveSpecial.hpMul)
    ? waveSpecial.hpMul : 1;
  const isElite = !!spawnOpts.elite;
  const hp = CORE.enemyMaxHealth(kind, CFG.ai.maxHealth, curWave, CFG.wave.victoryWave, diff().hp, specialHp, isElite);
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
    state: 'spawn',
    stateT: 0,
    nextShot: 0,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    // Set at spawn from the wave's unlocked behaviours; shielded units never flank
    // (their whole point is a frontal push you have to get around).
    // Scouts flank by definition — that is their whole job. Shielded units and
    // grenadiers never do. Everyone else flanks once the wave-8 behaviour unlocks.
    flanker: CORE.isEnemyFlanker(kind, typeof waveBehaviours !== 'undefined' && waveBehaviours.flanking, Math.random()),
    // Flank for a while, then commit. Without a window a fast flanker orbits forever.
    flankT: CORE.flankWindow(Math.random()),
    strafeT: 0,
    walkPhase: Math.random() * 10,
    // speedMul is the single knob every movement state multiplies through, so a
    // Blitz wave and an elite roll stack here rather than as new cases in moveEnemy.
    speedMul: CORE.enemySpawnSpeedMultiplier(Math.random(), isElite,
      (typeof waveSpecial !== 'undefined' && waveSpecial && waveSpecial.speedMul) ? waveSpecial.speedMul : 1),
    attackT: 0,
    hitBody: parts.hitBody,
    hitHead: parts.hitHead
  };
  // Visual tell: the shielded unit is steel-blue and slightly larger, so a player
  // knows to flank before they have wasted a magazine on the plate.
  // (The soldiers carry the same tells in their kit colours.)
  const KIND_TINT = { 3: 0x4a6fa5, 4: 0x8fd66a, 5: 0xd6a24a };
  if (KIND_TINT[kind] !== undefined && !parts.soldier) {
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
  // tag ALL visible meshes with the enemy ref too, so raycast world-hits resolve as
  // enemy body hits. Anything on a soldier's head joint (helmet, NVGs) is the head.
  const headJ = parts.J ? parts.J.head : null;
  parts.group.traverse(function (o) {
    if (o.isMesh && o !== parts.hitBody && o !== parts.hitHead) {
      let onHead = false;
      for (let q = o.parent; headJ && q; q = q.parent) if (q === headJ) { onHead = true; break; }
      o.userData = { enemyRef: en, isHead: onHead, enemyFlesh: true };
    }
  });
  // Place the mesh immediately; otherwise it renders and raycasts at the world origin for its first frame.
  parts.group.position.set(x, 0, z);
  parts.group.rotation.y = parts.soldier ? initYaw : (initYaw + Math.PI);
  scene.add(parts.group);
  enemies.push(en);
  return en;
}

function disposeEnemyGeometry(en) {
  if (!en) return;
  // Soldier geometry is shared by every clone of its template; only the per-clone
  // skeleton (its bone texture) is freed.
  if (en.parts.soldier) {
    const sk = en.parts.group.userData.skeletons || [];
    for (let i = 0; i < sk.length; i++) sk[i].dispose();
    return;
  }
  // Tinted shielded units own cloned materials; everything else shares them.
  en.parts.group.traverse(function (o) {
    if (o.userData && o.userData.clonedTint && o.material && o.material.dispose) o.material.dispose();
  });
  en.parts.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
}

// Shielded advancers (kind 3) carry a frontal plate: shots into the front arc are
// mostly absorbed, so they have to be flanked, headshot or grenaded. This is the
// wave-9+ answer to "the back half is the same fight with more bodies".
function shieldMultiplier(en, point) {
  if (en.kind !== 3 || !point) return 1;
  return CORE.shieldMultiplier(en.kind, en.pos.x, en.pos.z, en.yaw, point.x, point.z);
}

const _hitDir = new THREE.Vector3();
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
  const isKill = en.health <= 0;
  const tier = CORE.hitmarkerTier(shield, throughCover, isKill);
  showHitmarker(isHead, tier);
  addCredits(CORE.creditsForDamage(isKill, isHead));
  addFieldCharge(lethal ? dmg : dmg * shield);
  spawnBlood(point, isHead);
  if (en.parts.soldier && point) {
    // flinch: the torso (or head) springs away from the round
    _hitDir.set(point.x - player.pos.x, 0, point.z - player.pos.z).normalize();
    soldierHitReact(en, _hitDir, Math.min(1.5, dmg / 40), isHead);
  }
  if (isKill) killEnemy(en, isHead);
  else {
    // flinch + alert
    en.stateT = 0;
    if (en.state === 'idle' || en.state === 'patrol') en.state = 'chase';
  }
}

const _killImpulseOut = { force: 0, y: 0 };

function killEnemy(en, isHead) {
  en.dead = true; en.deathT = 0;
  // Physics, not a clip. Impulse magnitude is capped so a heavy hit tumbles a body
  // rather than firing it across the arena.
  const impulse = CORE.enemyKillImpulse(en._lastHitForce, isHead, Math.random(), _killImpulseOut);
  spawnRagdoll(en, {
    node: en._lastHitNode || 'chest',
    x: (en._lastHitDirX || 0) * impulse.force,
    y: impulse.y,
    z: (en._lastHitDirZ || 0) * impulse.force,
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
  playSound(CORE.killConfirmationSound(isHead, en.elite));
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
// cost is independent of enemy count. Static walkability + the same target cell
// produce exactly the same field, so retain it until either input changes. Stuck
// recovery still forces a refresh by resetting flowCellX below.
let flowT = 0, flowCellX = -9999, flowCellZ = -9999;
let _flowGrid = null;
const FLOW_INTERVAL = 0.25;
const _flowDir = { x: 0, z: 0 };
function updateFlowField(dt) {
  if (!navGrid) return;
  flowT -= dt;
  const cx = Math.floor((player.pos.x - navGrid.originX) / navGrid.cell);
  const cz = Math.floor((player.pos.z - navGrid.originZ) / navGrid.cell);
  if (navGrid === _flowGrid && cx === flowCellX && cz === flowCellZ) return;
  flowT = FLOW_INTERVAL;
  _flowGrid = navGrid;
  flowCellX = cx; flowCellZ = cz;
  CORE.computeFlowField(navGrid, player.pos.x, player.pos.z);
}

// Reusable output object for CORE.resolveAabbXZ to eliminate per-step GC allocations
const _enResolveOut = { axis: 'x', val: 0 };
// Reusable output object for CORE.resolveSeparationPush to eliminate per-frame GC allocations
const _sepOut = { pushX: 0, pushZ: 0, applied: false };
const _fallbackOut = { x: 0, z: 0 };
const _strafeOut = { x: 0, z: 0 };
const _flankOut = { x: 0, z: 0 };
const _enemyStateOut = { state: 'chase', stateT: 0, strafeT: 0, resetStateT: false };
const _pushoutOut = { pushX: 0, pushZ: 0, applied: false };
const _toPlayerDirOut = { x: 0, z: 0 };

// Steering: follow the flow field when closing distance, fall back to a direct
// vector when the field has nothing for this cell (e.g. an enemy shoved outside
// the walkable set by the separation pass).
function moveEnemy(en, dt, dist) {
  const cfg = CFG.ai;
  const d = typeof dist === 'number' && isFinite(dist) ? dist : CORE.horizDist(en.pos.x, en.pos.z, player.pos.x, player.pos.z);
  CORE.enemyToPlayerDir(player.pos.x - en.pos.x, player.pos.z - en.pos.z, d, _toPlayerDirOut);
  const toPlayer = _toPlayerDirOut;
  const speed = CORE.enemyMoveSpeed(en.kind, en.state, d, cfg.rangedRange, en.speedMul, cfg);
  let mvx = toPlayer.x, mvz = toPlayer.z;
  if (en.state === 'chase') {
    // Straight-line seek wedges on every wall corner in this arena; route instead.
    // Close in, steer directly so the final approach does not snap to cell centres.
    const routed = d > 3 && navGrid ? CORE.flowDirAt(navGrid, en.pos.x, en.pos.z, _flowDir) : null;
    if (routed) { mvx = routed.x; mvz = routed.z; }
    // Flankers (wave 8+) bias sideways until they are close, so a pack stops
    // arriving as one clump down a single corridor.
    if (en.flanker) {
      en.flankT -= dt;
      const bias = CORE.flankBiasNow(en.flankT, d);
      CORE.stepFlankVelocity(mvx, mvz, en.strafeDir, bias, _flankOut);
      mvx = _flankOut.x; mvz = _flankOut.z;
    }
  } else if (en.state === 'fallback') {
    // straight back, with a sideways bias so it does not reverse into a corner
    const fv = CORE.enemyFallbackVelocity(toPlayer.x, toPlayer.z, en.strafeDir, _fallbackOut);
    mvx = fv.x; mvz = fv.z;
  } else if (en.state === 'strafe') {
    // circle-strafe the player
    const sv = CORE.enemyStrafeVelocity(toPlayer.x, toPlayer.z, en.strafeDir, _strafeOut);
    mvx = sv.x; mvz = sv.z;
    en.strafeT -= dt;
    if (en.strafeT <= 0) { en.strafeDir *= -1; en.strafeT = CORE.enemyStrafeDuration(Math.random()); }
  }
  en.vel.x = mvx * speed;
  en.vel.z = mvz * speed;
  // obstacle pushout (AABB vs point with radius) + step-up allowance
  const r = CORE.enemyColliderRadius(en.kind);
  const stepH = CORE.STEP_HEIGHT;
  const head = CORE.enemyHeadHeight(en.pos.y, en.kind);
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
      if (!CORE.isColliderRelevantXZ(c.min.y, c.max.y, feet, head, stepH)) continue;
      if (CORE.resolveAabbXZ(en.pos.x, en.pos.z, r, c, _enResolveOut)) {
        if (_enResolveOut.axis === 'x') en.pos.x = _enResolveOut.val;
        else en.pos.z = _enResolveOut.val;
      }
    }
  }
  en.pos.x = Math.max(-mapBounds, Math.min(mapBounds, en.pos.x));
  en.pos.z = Math.max(-mapBounds, Math.min(mapBounds, en.pos.z));

  // Vertical resolve: find highest floor below feet + stepH
  const floorY = CORE.findFloorY(en.pos.x, en.pos.z, 0, colliders, en.pos.y, stepH, GROUND);
  en.pos.y = CORE.stepEnemyFallY(en.pos.y, floorY, dt, CORE.ENEMY_FALL_SPEED, stepH);
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
  _losFrom.set(en.pos.x, CORE.enemyEyeHeight(en.pos.y, en.kind, E_DIM.pelvisH, CORE.ENEMY_EYE_OFFSET_Y), en.pos.z);
  _losTo.copy(player.pos);
  _losTo.x = CORE.enemyLosTargetCoord(player.pos.x, Math.random(), CORE.ENEMY_LOS_JITTER);
  _losTo.z = CORE.enemyLosTargetCoord(player.pos.z, Math.random(), CORE.ENEMY_LOS_JITTER);
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
let SHADOW_ENEMY_BUDGET = CORE.graphicsSettings({}, IS_TOUCH).shadowEnemies;
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
  if (typeof graphicsNow === 'function') SHADOW_ENEMY_BUDGET = graphicsNow().shadowEnemies;
  shadowBudgetT -= dt;
  if (shadowBudgetT > 0) return;
  shadowBudgetT = 0.25;
  _shadowPos.length = 0;
  for (let i = 0; i < enemies.length; i++) _shadowPos.push(enemies[i].pos);
  const keep = CORE.shadowCasters(_shadowPos, player.pos.x, player.pos.z, SHADOW_ENEMY_BUDGET);
  for (let i = 0; i < enemies.length; i++) {
    setEnemyCastShadow(enemies[i], keep.indexOf(i) >= 0);
  }
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
      en.speedMul = CORE.enemyStunSpeedMultiplier(en.baseSpeedMul, true);
    } else if (en.baseSpeedMul !== undefined) {
      en.speedMul = en.baseSpeedMul;
      en.baseSpeedMul = undefined;
    }
    if (en.blindT > 0) {
      en.blindT = Math.max(0, en.blindT - dt);
      en.yaw = CORE.stepEnemyBlindYaw(en.yaw, dt, CORE.ENEMY_BLIND_YAW_RATE);
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
    const nxt = CORE.enemyAiNextState(en.kind, en.state, en.stateT, dist, hasLOS(en), CFG.ai.rangedRange, CORE.enemyPreferredRange(en.kind), _enemyStateOut);
    en.state = nxt.state;
    if (nxt.strafeT > 0) en.strafeT = nxt.strafeT;
    if (nxt.resetStateT) en.stateT = 0;
    moveEnemy(en, dt, dist);
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
      en.stepT -= dt * CORE.enemyFootstepRate(en.kind);
      if (en.stepT <= 0) {
        if (gameT > nextEstepT) { playSound3D('estep', en.pos.x, en.pos.y, en.pos.z); nextEstepT = gameT + 0.08; }
        en.stepT = CORE.enemyFootstepInterval(en.speedMul);
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
      if (CORE.playerPushoutOffset(en.pos.x, en.pos.z, player.pos.x, player.pos.z, en.yaw, dist, stopDist, _pushoutOut).applied) {
        en.pos.x += _pushoutOut.pushX;
        en.pos.z += _pushoutOut.pushZ;
      }
    }
    // melee attack (runners + tanks): staggered windup, damage cap, real cooldown
    const canMelee = CORE.canEnemyMelee(en.kind);
    const reach = CORE.enemyMeleeReach(en.kind, CFG.ai.attackRange);
    if (canMelee && CORE.withinReach(dist, vertGapToPlayer(en), reach)
        && en.swinging === undefined && gameT > (en.attackReadyT || 0)) {
      // stagger windups so a pack doesn't land one synced nuke
      en.swinging = CORE.enemyMeleeWindup(Math.random());
    }
    if (en.swinging !== undefined) {
      en.swinging -= dt;
      if (en.swinging <= 0 && en.swinging > -1) {
        // swing lands — only if still in reach and player alive
        if (CORE.withinReach(dist, vertGapToPlayer(en), reach + CORE.ENEMY_MELEE_FOLLOW_REACH_PADDING) && !player.dead) {
          // global melee damage cap: max 2 melee hits landing within any 0.8s window
          if (CORE.canRegisterHit(meleeHits, gameT, CORE.MELEE_CAP_WINDOW, CORE.MELEE_CAP_MAX_HITS)) {
            const meleeDmg = CORE.enemyMeleeDamage(CFG.ai.meleeDamage, en.kind === 2, waveNum, diff().dmg, en.elite);
            damagePlayer(meleeDmg, dirToDeg(en));
            playSound3D('melee', en.pos.x, en.pos.y, en.pos.z);
            meleeHits.push(gameT);
          }
        }
        en.swinging = CORE.ENEMY_MELEE_COOLDOWN_SENTINEL;                        // cooldown marker
        en.attackReadyT = CORE.enemyAttackReadyTime(gameT, CORE.enemyAttackCooldown(en.kind), Math.random());
      }
      if (CORE.isEnemyMeleeReset(en.swinging, CORE.ENEMY_MELEE_COOLDOWN_SENTINEL, CORE.ENEMY_MELEE_RESET_MARGIN)) en.swinging = undefined;
    }
    // ranged attack (rifleman)
    if (en.kind === 1 && en.state === 'strafe' && dist < CFG.ai.rangedRange && gameT > en.nextShot) {
      if (hasLOS(en)) {
        if (waveBehaviours.burstFire) {
          // Bursts of 3 with a longer recovery: same average output, far more
          // pressure to break line of sight instead of trading in the open.
          if (en.burst === undefined || en.burst <= 0) en.burst = 3;
          en.burst--;
          en.nextShot = gameT + CORE.enemyBurstInterval(en.burst, CFG.ai.rangedROF, Math.random());
        } else {
          en.nextShot = CORE.enemyRangedNextShot(gameT, CFG.ai.rangedROF, Math.random());
        }
        enemyShoot(en, dist);
      } else {
        en.nextShot = gameT + CORE.RIFLEMAN_LOS_RETRY_DELAY;
        en.burst = 0;
      }
    }
    // Grenadiers (wave 6+) throw as their primary attack, with or without LOS —
    // that is the point of the unit: it denies a position rather than duelling.
    if (en.kind === 5 && CORE.canEnemyThrowGrenade(5, dist, player.dead) && gameT > (en.nextNade || CORE.enemyInitialGrenadeDelay(5))) {
      en.nextNade = CORE.enemyGrenadeCooldown(true, gameT, Math.random());
      throwEnemyGrenade(en);
    }
    // Riflemen pick it up too once the wave-12 behaviour unlocks, but only to
    // flush a player who is actually behind cover.
    if (waveBehaviours.enemyNades && en.kind === 1 && CORE.canEnemyThrowGrenade(1, dist, player.dead) &&
        gameT > (en.nextNade || CORE.enemyInitialGrenadeDelay(1))) {
      en.nextNade = CORE.enemyGrenadeCooldown(false, gameT, Math.random());
      if (!hasLOS(en)) throwEnemyGrenade(en);   // only when the player IS in cover
    }
    // animate
    animateEnemy(en, dt, dist);
  }
  // enemy-vs-enemy separation AFTER movement so clumps actually resolve
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i];
    if (a.dead) continue;
    const ar = CORE.enemySeparationRadius(a.kind);
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j];
      if (b.dead) continue;
      const br = CORE.enemySeparationRadius(b.kind);
      if (CORE.resolveSeparationPush(a.pos.x, a.pos.z, ar, b.pos.x, b.pos.z, br, _sepOut)) {
        a.pos.x -= _sepOut.pushX; a.pos.z -= _sepOut.pushZ;
        b.pos.x += _sepOut.pushX; b.pos.z += _sepOut.pushZ;
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
      const behind = CORE.relocateFacingAlignment(toX, toZ, fwdX, fwdZ, rad);
      const score = CORE.relocateCandidateScore(rad, behind);
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
const _enemyGrenadeVelOut = { x: 0, y: 0, z: 0 };
function throwEnemyGrenade(en) {
  if (typeof liveGrenades === 'undefined' || !CORE.canSpawnEnemyGrenade(liveGrenades.length, CORE.ENEMY_LIVE_GRENADES_CAP)) return;
  en.throwT = CORE.ENEMY_GRENADE_ARM_DURATION;   // throwing arm pose (38_soldier.js)
  const m = new THREE.Mesh(grenadeGeo, grenadeMat);
  const blink = new THREE.Mesh(fuseBlinkGeo, fuseLightMat);
  blink.position.y = 0.1; m.add(blink);
  m.position.set(en.pos.x, en.pos.y + 1.2, en.pos.z);
  const dx = player.pos.x - en.pos.x, dz = player.pos.z - en.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  // lobbed, deliberately imprecise — it is a flush, not a snipe
  const speed = CORE.enemyGrenadeSpeed(d);
  CORE.enemyGrenadeVelocity(dx, dz, d, speed, CORE.ENEMY_GRENADE_ARC_Y, Math.random(), Math.random(), CORE.ENEMY_GRENADE_JITTER, _enemyGrenadeVelOut);
  const vel = new THREE.Vector3(_enemyGrenadeVelOut.x, _enemyGrenadeVelOut.y, _enemyGrenadeVelOut.z);
  liveGrenades.push({ m: m, vel: vel, fuse: CORE.enemyGrenadeFuse(CFG.grenade.fuse, CORE.ENEMY_GRENADE_FUSE_BONUS), blink: blink,
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
const _eshotDir = new THREE.Vector3();
const _bulletMissOffset = { x: 0, y: 0, z: 0 };
function enemyShoot(en, dist) {
  if (en.blindT > 0) return;   // cannot aim at what it cannot see
  // visible tracer from enemy, damage applied probabilistically (accuracy scales with wave)
  playSound3D(CORE.enemyGunfireSound(en.elite), en.pos.x, en.pos.y, en.pos.z);
  en.lastShotT = gameT;
  const from = _eshotFrom.set(en.pos.x, en.pos.y + E_DIM.pelvisH + 0.55, en.pos.z);
  _eshotDir.set(player.pos.x - from.x, player.pos.y - from.y, player.pos.z - from.z).normalize();
  if (en.parts && en.parts.soldier && en.parts.J && en.parts.J.gun) {
    // out of the actual muzzle, with a flash the player can read the shooter by
    en.parts.J.gun.localToWorld(from.set(0, 0.015, 0.56));
    _eshotDir.set(player.pos.x - from.x, player.pos.y - from.y, player.pos.z - from.z).normalize();
  }
  if (typeof fxMuzzle === 'function') fxMuzzle(from, _eshotDir, false);
  if (typeof flashLight === 'function') {
    const elp = CORE.enemyMuzzleLightParams(en.elite);
    flashLight(from, elp.color, elp.intensity, elp.distance, elp.duration);
  }
  const accBonus = (typeof waveSpecial !== 'undefined' && waveSpecial && waveSpecial.accBonus)
    ? waveSpecial.accBonus : 0;
  const baseAcc = CORE.enemyAccuracy(CFG.ai.rangedAccuracy, CFG.ai.accPerWave, waveNum, CFG.ai.accMax, accBonus);
  const acc = CORE.enemyDistanceAccuracy(baseAcc, dist, CORE.ENEMY_ACCURACY_FALLOFF_DIST, CFG.ai.rangedRange, CORE.ENEMY_ACCURACY_MIN_FACTOR);
  const isHit = Math.random() < acc;
  const to = _eshotTo.copy(player.pos);
  to.y = CORE.enemyAimTargetY(player.pos.y, CORE.ENEMY_SHOT_CHEST_Y_OFFSET);
  if (!isHit) {
    CORE.bulletNearMissOffset(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      CORE.BULLET_WHIZ_MIN_OFFSET,
      CORE.BULLET_WHIZ_MAX_DIST,
      _bulletMissOffset
    );
    to.x += _bulletMissOffset.x;
    to.y += _bulletMissOffset.y;
    to.z += _bulletMissOffset.z;
  }
  spawnTracer(from, to, 0xff8844);
  const travelDelay = CORE.enemyBulletTravelDelay(dist, CORE.ENEMY_BULLET_DELAY_FACTOR, CORE.ENEMY_BULLET_MAX_DELAY_MS);
  const firedInRun = runId;
  const ox = from.x, oy = from.y, oz = from.z;
  const hitDeg = dirToDeg(en);
  if (isHit) {
    const dmg = CORE.enemyRangedDamage(CFG.ai.rangedDamage, waveNum, diff().dmg, en.elite);
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
    }, travelDelay);
  } else {
    const missX = to.x, missY = to.y, missZ = to.z;
    setTimeout(function () {
      if (runId !== firedInRun) return;
      if (player.dead || !started || paused) return;
      playSound3D(CORE.bulletWhizSound(), missX, missY, missZ, CORE.BULLET_WHIZ_MAX_DIST * 2);
    }, travelDelay);
  }
}

function dirToDeg(en) {
  // Bearing from player to attacker; showDamageFx converts this to screen-relative rotation.
  return CORE.worldBearing(player.pos.x, player.pos.z, en.pos.x, en.pos.z);
}

const _enemyProcPoseOut = { legLRotX: 0, legRRotX: 0, armLRotX: 0, armRRotX: 0, bodyRotX: 0, bodyPosY: 0, moving: false };

function animateEnemy(en, dt, dist) {
  const p = en.parts;
  if (p.soldier) { if (!en.dead) animateSoldier(en, dt, dist); return; }
  p.group.position.set(en.pos.x, en.pos.y, en.pos.z);
  p.group.rotation.y = en.yaw + Math.PI;
  // ---- procedural fallback (box-man) ----
  if (en.dead) return;
  const moveSpd = Math.hypot(en.vel.x, en.vel.z);
  const spd = CORE.enemyProcWalkSpeed(moveSpd, en.kind, CORE.ENEMY_PROC_WALK_THRESHOLD);
  en.walkPhase = CORE.stepEnemyProcWalkPhase(en.walkPhase, spd, dt);
  const pose = CORE.enemyProcPose(en.walkPhase, moveSpd, en.kind, dist, player.pos.y, en.pos.y, _enemyProcPoseOut);
  p.legL.rotation.x = pose.legLRotX;
  p.legR.rotation.x = pose.legRRotX;
  p.armL.rotation.x = pose.armLRotX;
  p.armR.rotation.x = pose.armRRotX;
  p.body.rotation.x = pose.bodyRotX;
  p.body.position.y = pose.bodyPosY;
}
