// ============ PLAYER CONTROLLER ============
'use strict';
const keys = Object.create(null);
const pressed = Object.create(null);
let paused = false, started = false, pointerLocked = false;
let mouse1Down = false;
let mouseX = 0, mouseY = 0;

addEventListener('keydown', function (e) {
  if (e.repeat) return;
  keys[e.code] = true; pressed[e.code] = true;
  if (['Space','ArrowUp','ArrowDown','KeyW','KeyA','KeyS','KeyD'].indexOf(e.code) >= 0) e.preventDefault();
  if ((e.code === 'Escape' || e.code === 'KeyP') && started && !paused) pauseGame();
});
addEventListener('keyup', function (e) { keys[e.code] = false; });

canvas.addEventListener('mousedown', function (e) {
  if (!started || paused || player.dead) return;
  if (!pointerLocked) { canvas.requestPointerLock(); return; }
  if (e.button === 0) mouse1Down = true;
  if (e.button === 2) keys['Mouse2'] = true;
});
addEventListener('mouseup', function (e) {
  if (e.button === 0) mouse1Down = false;
  if (e.button === 2) keys['Mouse2'] = false;
});
function clearInputState() {
  mouse1Down = false; mouseX = 0; mouseY = 0;
  for (const k in keys) delete keys[k];
  for (const k in pressed) delete pressed[k];
  if (typeof touchState !== 'undefined') {
    touchState.moveX = 0; touchState.moveZ = 0; touchState.firing = false;
    touchState.tapFiring = false; touchState.ads = false; touchState.lookX = 0; touchState.lookY = 0;
  }
  window.__analogMove = null;
}
addEventListener('blur', clearInputState);
document.addEventListener('visibilitychange', function () { if (document.hidden) clearInputState(); });
addEventListener('contextmenu', function (e) { e.preventDefault(); });
canvas.addEventListener('wheel', function (e) {
  if (started && !paused && !player.dead) switchWeapon(curWeapon + (e.deltaY > 0 ? 1 : -1));
}, { passive: true });

document.addEventListener('pointerlockchange', function () {
  pointerLocked = document.pointerLockElement === canvas;
  if (!pointerLocked && started && !paused && !player.dead && !gameEnded) pauseGame();
});
const MAX_MOUSE_EVENT_DELTA = 80; // reject pointer-lock spikes after a lost/stalled frame
addEventListener('mousemove', function (e) {
  if (!pointerLocked || paused) return;
  mouseX += Math.max(-MAX_MOUSE_EVENT_DELTA, Math.min(MAX_MOUSE_EVENT_DELTA, e.movementX));
  mouseY += Math.max(-MAX_MOUSE_EVENT_DELTA, Math.min(MAX_MOUSE_EVENT_DELTA, e.movementY));
});

// ---- Player state ----
const player = {
  pos: new THREE.Vector3(0, CFG.player.height, 24),
  vel: new THREE.Vector3(),
  yaw: Math.PI, pitch: 0,
  onGround: false, crouching: false, sprinting: false, exhausted: false,
  health: CFG.player.health, armor: CFG.player.armor,
  stamina: CFG.player.maxStamina,
  lastDamageT: -99, dead: false,
  bobPhase: 0, bobAmp: 0,
  recoilP: 0, recoilY: 0,   // accumulated recoil offsets (decayed)
  // slide state
  sliding: false, slideT: 0, slideDir: new THREE.Vector3(),
  // jump feel
  coyoteT: 0, jumpBufT: 0, lastGroundT: 0,
  // mantle (see tryMantle) and tactical-sprint burst
  mantleT: 0, mantleFrom: new THREE.Vector3(), mantleTo: new THREE.Vector3(),
  tacT: 0,
  // fall damage: peak downward speed while airborne, and the landing recovery
  airSpeedY: 0, landStunT: 0,
  // last stand: alive, but on the floor and bleeding out
  downed: false
};

// Juggernaut raises the ceiling, so nothing may compare against the raw config
// number any more or the perk silently caps itself away.
function playerMaxHealth() { return CORE.perkMaxHealth(CFG.player.health, perks); }

function eyeHeight() { return player.crouching ? CFG.player.crouchHeight : CFG.player.height; }

// Ground/step height for horizontal collision: we can step onto ledges up to 0.60m
const STEP_H = 0.60;
// Mantle: step-up alone caps at STEP_H, so a 1 m crate was scenery rather than a
// route and the arena's scattered cover could not be used as one.
const MANTLE_TIME = 0.35;
const MANTLE_REACH = 0.9;
const MANTLE_MAX_RISE = 1.7;
// Tactical sprint: a short burst at higher speed, paid for with a faster stamina
// burn. Sprint was one speed, which made every rotation feel the same length.
const TAC_TAP_WINDOW = 0.32;
const TAC_DURATION = 2.5;
const TAC_MUL = CORE.TAC_SPRINT_SPEED_MUL;
const TAC_DRAIN = 2.2;
let lastSprintTap = -99;
// Distance from the eye to the top of the head. The ceiling resolve keeps this
// much space between the camera and any slab overhead.
const HEAD_CLEARANCE = 0.20;
// Collision is discrete AABB overlap, not swept, so one long frame can teleport
// straight through a wall. The thinnest collidable wall in the arena is 0.8 m and
// dt is clamped at 0.1 s, which at sprint speed is 0.89 m of travel — enough to
// pass clean through. Cap per-substep travel well under that.
const MAX_MOVE_STEP = 0.30;

// Horizontal AABB resolve with step-up allowance
const _resolveOut = { axis: 'x', val: 0 };
function resolveXZ(pos, r) {
  const feet = pos.y - eyeHeight();
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.min.y >= pos.y + 0.2) continue;            // collider is entirely above the player's head
    if (c.max.y <= feet + STEP_H) continue;         // low obstacle can be stepped onto; vertical resolver lifts us
    if (feet >= c.max.y - 0.001) continue;         // standing above it
    if (CORE.resolveAabbXZ(pos.x, pos.z, r, c, _resolveOut)) {
      if (_resolveOut.axis === 'x') { pos.x = _resolveOut.val; player.vel.x = 0; }
      else { pos.z = _resolveOut.val; player.vel.z = 0; }
    }
  }
  // arena bounds
  pos.x = Math.max(-mapBounds, Math.min(mapBounds, pos.x));
  pos.z = Math.max(-mapBounds, Math.min(mapBounds, pos.z));
}

// Vertical resolve: find highest floor below feet+step, lowest ceiling above head
const _vertBoundsOut = { floorY: 0, ceilY: Infinity };
function resolveVertical(pos, r) {
  const feet = pos.y - eyeHeight();
  const bounds = CORE.resolveVerticalBounds(pos.x, pos.z, r, colliders, feet, STEP_H, GROUND, _vertBoundsOut);
  const floorY = bounds.floorY;
  const ceilY = bounds.ceilY;
  const target = floorY + eyeHeight();
  if (pos.y <= target + 0.001 && player.vel.y <= 0) {
    pos.y = target; player.vel.y = 0; player.onGround = true;
  } else {
    player.onGround = false;
  }
  const clamped = CORE.ceilingClamp(pos.y, floorY, ceilY, eyeHeight(), HEAD_CLEARANCE);
  if (clamped < pos.y) {
    pos.y = clamped;
    if (player.vel.y > 0) player.vel.y = 0;   // bonk head
  }
}

const tmpV = new THREE.Vector3();
const _assistFrom = new THREE.Vector3();
const _assistDir = new THREE.Vector3();
const _velOut = { x: 0, z: 0 };
const _bobStepOut = { phase: 0, amp: 0 };
const _jumpTimersOut = { coyoteT: 0, jumpBufT: 0 };
function updatePlayer(dt) {
  if (player.dead) return;
  // mobile: joystick axes -> keys/look accumulators
  applyTouchInput();
  // look
  const sens = CORE.lookSensitivity(getSetting('sensitivity'), adsAmount);
  const invertY = getSetting('invertY') ? -1 : 1;
  // aim assist: when ADS/scoped and near an enemy, add a gentle pull toward chest
  let assistYaw = 0, assistPitch = 0;
  if (adsAmount > 0.8 && enemies.length) {
    camera.getWorldPosition(_assistFrom);
    _assistDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const nudged = applyAimAssist(_assistDir, _assistFrom);
    // convert nudge into small yaw/pitch deltas (applied as look rotation offset, not permanent)
    assistYaw = (Math.atan2(-nudged.x, -nudged.z) - Math.atan2(-_assistDir.x, -_assistDir.z));
    assistPitch = (Math.asin(nudged.y) - Math.asin(_assistDir.y));
    // wrap
    if (assistYaw > Math.PI) assistYaw -= Math.PI * 2;
    if (assistYaw < -Math.PI) assistYaw += Math.PI * 2;
  }
  // Counter-input spends the outstanding recoil BEFORE it moves the real aim.
  // Recoil is an additive camera offset that decays back to zero, so a player who
  // pulled down used to keep the correction in player.pitch and finish the burst
  // aiming at the floor: the kick went away, their compensation did not.
  const yawDelta = -mouseX * sens;
  const pitchDelta = -mouseY * sens * invertY;
  const absY = CORE.absorbRecoil(player.recoilY, yawDelta);
  const absP = CORE.absorbRecoil(player.recoilP, pitchDelta);
  player.recoilY = absY.offset;
  player.recoilP = absP.offset;
  player.yaw += absY.delta;
  player.yaw += assistYaw * 3.5 * dt;              // assist pull (per-second rate)
  player.pitch += absP.delta;
  player.pitch += assistPitch * 3.5 * dt;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
  mouseX = 0; mouseY = 0;
  // recoil decay — now only what the player did NOT compensate for
  player.recoilP = CORE.recoilDecay(player.recoilP, dt, CORE.RECOIL_DECAY_RATE);
  player.recoilY = CORE.recoilDecay(player.recoilY, dt, CORE.RECOIL_DECAY_RATE);

  // A mantle owns movement while it runs. Looking around stays live, which is why
  // this sits after the look block rather than at the top of the function.
  if (player.mantleT > 0) {
    player.mantleT = Math.max(0, player.mantleT - dt);
    const k = 1 - player.mantleT / MANTLE_TIME;
    player.pos.lerpVectors(player.mantleFrom, player.mantleTo, k < 1 ? k : 1);
    player.vel.set(0, 0, 0);
    if (player.mantleT === 0) { player.onGround = true; player.coyoteT = 0.12; }
    return;
  }

  // ---- Slide (C/Ctrl while sprinting on ground) ----
  const crouchKey = !!(keys['KeyC'] || keys['ControlLeft'] || keys['ControlRight']);
  const movingInput = !!(keys['KeyW'] || keys['KeyA'] || keys['KeyS'] || keys['KeyD']);
  if (!player.sliding && crouchKey && player.sprinting && player.onGround && movingInput && !adsDown() && !player.exhausted && !player.downed) {
    startSlide();
  }
  if (player.sliding) {
    player.slideT += dt;
    // steering: A/D curve the slide
    const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
    let ix = 0;
    if (keys['KeyA']) ix -= 1;
    if (keys['KeyD']) ix += 1;
    if (ix) {
      const wx = ix * cy, wz = -ix * sy;
      player.slideDir.x += wx * 2.2 * dt;
      player.slideDir.z += wz * 2.2 * dt;
      player.slideDir.normalize();
    }
    // slide keeps momentum from sprint: 1.2x sprint speed decaying to crouch speed over 0.9s
    const sprintBase = CFG.player.speed * CFG.player.sprintMul;
    const crouchBase = CFG.player.speed * CORE.SLIDE_END_MUL;
    const slideSpeed = CORE.slideSpeedAt(player.slideT, sprintBase, crouchBase, CORE.SLIDE_DURATION, CORE.SLIDE_START_MUL, CORE.SLIDE_END_MUL);
    player.vel.x = player.slideDir.x * slideSpeed;
    player.vel.z = player.slideDir.z * slideSpeed;
    // Slide cancel. The slide used to commit for a full 0.9 s with no early-out
    // except releasing crouch, which removed the one piece of movement tech that
    // rewards practice. Guarded past 0.12 s so the press that STARTED the slide
    // cannot also cancel it on the same frame.
    if (player.slideT > 0.12 && (pressed['KeyC'] || pressed['ControlLeft'] || pressed['ControlRight'])) {
      player.sliding = false;
      player.crouching = !!crouchKey;
      spawnSlideDust(player.pos);
    }
    // slide ends: timeout, released crouch, or stopped
    if (player.slideT > 0.9 || !crouchKey || (movingInput === false && player.slideT > 0.25)) {
      player.sliding = false;
      player.crouching = crouchKey;  // hold-to-crouch out of slide
      spawnSlideDust(player.pos);
    }
    // slide-jump: convert momentum into a boost jump
    if (pressed['Space'] && player.onGround) {
      player.sliding = false;
      const spd = Math.hypot(player.vel.x, player.vel.z);
      const boost = CORE.slideJumpBoost(spd, sprintBase, CORE.SLIDE_BOOST_MAX, CORE.SLIDE_BOOST_SCALE);
      player.vel.x *= boost; player.vel.z *= boost;
      player.vel.y = CFG.player.jumpVel * CORE.SLIDE_JUMP_Y_MUL;
      player.onGround = false;
      player.jumpBufT = 0;
      player.coyoteT = 0;
      playSound('jump');
      spawnSlideDust(player.pos);
    }
  }

  // stance
  const wantCrouch = player.sliding ? true : crouchKey;
  if (wantCrouch !== player.crouching) {
    if (!wantCrouch) {
      if (CORE.hasCrouchHeadroom(player.pos.x, player.pos.z, CFG.player.radius, player.pos.y, CFG.player.height, colliders)) {
        player.crouching = false;
      }
    } else player.crouching = true;
  }

  // stamina & sprint (movingInput already declared in slide block above)
  // Tactical sprint: a double-tap inside TAC_TAP_WINDOW opens a short burst.
  if (pressed['ShiftLeft'] || pressed['__tacsprint']) {
    if (gameT - lastSprintTap < TAC_TAP_WINDOW && !player.exhausted) player.tacT = TAC_DURATION;
    lastSprintTap = gameT;
  }
  const wantSprint = !!keys['ShiftLeft'] && movingInput && !player.crouching && !adsDown()
    && !player.downed && player.landStunT <= 0;
  if (player.tacT > 0 && (!wantSprint || player.exhausted)) player.tacT = 0;
  else if (player.tacT > 0) player.tacT = Math.max(0, player.tacT - dt);
  if (wantSprint && !player.exhausted) {
    player.sprinting = true;
    player.stamina = CORE.stepPlayerStamina(player.stamina, CFG.player.maxStamina, true, player.tacT > 0, dt, 1, TAC_DRAIN, CORE.STAMINA_RECOVER_RATE);
    player.exhausted = CORE.isPlayerExhausted(player.stamina, player.exhausted, CFG.player.maxStamina, CORE.STAMINA_EXHAUST_RECOVER_RATIO);
    if (player.exhausted) player.sprinting = false;
  } else {
    player.sprinting = false;
    player.stamina = CORE.stepPlayerStamina(player.stamina, CFG.player.maxStamina, false, false, dt, 1, TAC_DRAIN, CORE.STAMINA_RECOVER_RATE);
    player.exhausted = CORE.isPlayerExhausted(player.stamina, player.exhausted, CFG.player.maxStamina, CORE.STAMINA_EXHAUST_RECOVER_RATIO);
  }

  // movement intent (yaw-relative). iz: +1 = forward (W), -1 = back (S)
  let ix = 0, iz = 0;
  if (window.__analogMove) {
    ix = window.__analogMove.x;
    iz = window.__analogMove.z;
  } else {
    if (keys['KeyW']) iz += 1;
    if (keys['KeyS']) iz -= 1;
    if (keys['KeyA']) ix -= 1;
    if (keys['KeyD']) ix += 1;
  }
  if (window.__analogMove) {
    // analog: keep direction from joystick, skip normalization beyond magnitude 1
    const m = Math.hypot(ix, iz);
    if (m > 1) { ix /= m; iz /= m; }
    // scale walk speed by magnitude for analog walking
    window.__analogMag = Math.min(1, m);
  } else window.__analogMag = 1;
  const len = Math.hypot(ix, iz);
  if (len > 0) { ix /= len; iz /= len; }
  const cw = curW();
  const speed = CORE.playerMoveSpeed(
    CFG.player.speed,
    window.__analogMag || 1,
    player.sprinting,
    player.tacT > 0,
    player.downed,
    player.landStunT > 0,
    player.crouching,
    adsDown(),
    CFG.player.sprintMul,
    CFG.player.crouchMul,
    cw ? cw.moveMul : 1
  );
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  // forward = (-sin yaw, 0, -cos yaw); right = (cos yaw, 0, -sin yaw)
  // ix=+1 (D) -> right; iz=+1 (W) -> forward
  const wx = ix * cy + iz * (-sy);
  const wz = ix * (-sy) + iz * (-cy);
  const targetVX = wx * speed, targetVZ = wz * speed;
  // air control: partial authority while airborne (not while sliding)
  const rate = CORE.movementAccelRate(player.onGround, player.sliding, len > 0, CFG.player.accel, CFG.player.decel);
  if (!player.sliding) {
    CORE.stepHorizontalVelocity(player.vel.x, player.vel.z, targetVX, targetVZ, rate, dt, player.onGround, len > 0, _velOut);
    player.vel.x = _velOut.x;
    player.vel.z = _velOut.z;
  }

  // jump: coyote time (0.12s grace after leaving ground) + jump buffering (0.15s)
  CORE.stepJumpTimers(player.coyoteT, player.jumpBufT, player.onGround, !!pressed['Space'], dt, _jumpTimersOut);
  player.coyoteT = _jumpTimersOut.coyoteT;
  player.jumpBufT = _jumpTimersOut.jumpBufT;
  if (player.onGround) player.lastGroundT = gameT;
  // A mantle beats a jump: if there is a ledge in front, climbing it is what the
  // player meant. Anything under STEP_H is already handled by step-up.
  if (player.downed || player.landStunT > 0) player.jumpBufT = 0;
  if (player.jumpBufT > 0 && !player.sliding && tryMantle()) {
    player.jumpBufT = 0;
  } else if (CORE.canInitiateJump(player.jumpBufT, player.coyoteT, player.crouching, player.sliding, player.downed, player.landStunT)) {
    player.vel.y = CFG.player.jumpVel;
    player.onGround = false; player.coyoteT = 0; player.jumpBufT = 0;
    playSound('jump');
  }

  // gravity + integrate, sub-stepped so a long frame cannot tunnel a thin wall
  const moveSpeedNow = Math.max(Math.hypot(player.vel.x, player.vel.z), Math.abs(player.vel.y));
  const steps = CORE.subStepCount(moveSpeedNow, dt, MAX_MOVE_STEP);
  const sdt = dt / steps;
  for (let s = 0; s < steps; s++) {
    player.vel.y -= CFG.player.gravity * sdt;
    // Capture the landing substep's downward velocity before resolveVertical()
    // zeroes it, rather than waiting for the next render frame.
    if (!player.onGround) player.airSpeedY = CORE.landingImpactSpeed(player.airSpeedY, player.vel.y);
    player.pos.x += player.vel.x * sdt;
    player.pos.z += player.vel.z * sdt;
    player.pos.y += player.vel.y * sdt;
    resolveXZ(player.pos, CFG.player.radius);
    resolveVertical(player.pos, CFG.player.radius);
  }

  // health regen
  // A downed player does not regenerate: the bleed-out has to mean something.
  const timeSinceDmg = gameT - player.lastDamageT;
  const maxHp = playerMaxHealth();
  if (CORE.canRegenHealth(player.downed, timeSinceDmg, CFG.player.regenDelay, player.health, maxHp)) {
    player.health = CORE.stepHealthRegen(player.health, maxHp, CFG.player.regenRate, diff().regen, dt);
  }

  // head bob
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  CORE.stepHeadBob(player.bobPhase, player.bobAmp, player.onGround, hSpeed, player.sprinting, dt, _bobStepOut);
  player.bobPhase = _bobStepOut.phase;
  player.bobAmp = _bobStepOut.amp;

  // Fall damage. The original code said "none (arena is flat)", which stopped being
  // true the moment mantling put the player on crates, containers and the roof. The
  // impact speed is sampled BEFORE the resolver zeroes it, on the frame the player
  // regains ground contact.
  if (!player.onGround) {
    player.airSpeedY = Math.max(player.airSpeedY, -player.vel.y);
  } else if (player.airSpeedY > 0) {
    const impact = player.airSpeedY;
    player.airSpeedY = 0;
    const dmg = CORE.fallDamage(impact);
    if (dmg > 0) {
      const mul = CORE.landingSpeedMul(impact);
      player.vel.x *= mul;
      player.vel.z *= mul;
      player.landStunT = CORE.landingStunDuration(mul);
      damagePlayer(dmg, undefined);
      playSound('hurt');
    }
  }
  // A hard landing costs a moment of control: no sprint, no jump, reduced speed.
  if (player.landStunT > 0) player.landStunT = Math.max(0, player.landStunT - dt);
  // out-of-bounds safety
  if (player.pos.y < -5) { player.pos.set(0, CFG.player.height, 24); player.vel.set(0, 0, 0); }
}

// damage entry point (called by enemies/projectiles)
function damagePlayer(amount, dirDeg) {
  if (player.dead || godMode) return;
  const res = CORE.resolveArmorDamage(amount, player.armor);
  const armorSnd = CORE.armorDamageSound(player.armor, res.remainingArmor);
  player.armor = res.remainingArmor;
  player.health -= res.healthDamage;
  player.lastDamageT = gameT;
  if (armorSnd) playSound(armorSnd);
  showDamageFx(dirDeg, amount, res.healthDamage, res.absorbedDamage);
  updateHudHealth();
  // A lethal hit no longer ends the run outright: losing 30-40 minutes to one
  // mistake was the worst moment the game had. downPlayer() decides between a
  // Second Wind, a bleed-out, and death.
  if (player.health <= 0) { player.health = 0; downPlayer(); }
}

let godMode = false;

// ---- Mantle ----
function tryMantle() {
  if (player.mantleT > 0) return false;
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  const feet = player.pos.y - eyeHeight();
  const t = CORE.mantleTarget(feet, player.pos.x, player.pos.z, dirX, dirZ, colliders, {
    reach: MANTLE_REACH,
    minRise: STEP_H,
    maxRise: MANTLE_MAX_RISE,
    headroom: CFG.player.height,
    radius: CFG.player.radius
  });
  if (!t) return false;
  player.mantleT = MANTLE_TIME;
  player.mantleFrom.set(player.pos.x, player.pos.y, player.pos.z);
  player.mantleTo.set(t.x, t.y + CFG.player.height, t.z);
  player.sliding = false;
  player.onGround = false;
  playSound(CORE.mantleSound());
  spawnSlideDust(player.pos);
  return true;
}

// ---- Slide helpers ----
function startSlide() {
  player.sliding = true;
  player.slideT = 0;
  // slide in current movement direction (momentum dir if moving)
  const hv = tmpV.set(player.vel.x, 0, player.vel.z);
  if (hv.lengthSq() > 1) hv.normalize(); else hv.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  player.slideDir.copy(hv);
  playSound(CORE.slideStartSound());
  spawnSlideDust(player.pos);
}
