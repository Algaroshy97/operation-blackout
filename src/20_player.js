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
  coyoteT: 0, jumpBufT: 0, lastGroundT: 0
};

function eyeHeight() { return player.crouching ? CFG.player.crouchHeight : CFG.player.height; }

// Ground/step height for horizontal collision: we can step onto ledges up to 0.60m
const STEP_H = 0.60;

// Horizontal AABB resolve with step-up allowance
function resolveXZ(pos, r) {
  const feet = pos.y - eyeHeight();
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.min.y >= pos.y + 0.2) continue;            // collider is entirely above the player's head
    if (c.max.y <= feet + STEP_H) continue;         // low obstacle can be stepped onto; vertical resolver lifts us
    if (feet >= c.max.y - 0.001) continue;         // standing above it
    const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
    const ex = (c.max.x - c.min.x) * 0.5 + r, ez = (c.max.z - c.min.z) * 0.5 + r;
    const dx = pos.x - cx, dz = pos.z - cz;
    if (Math.abs(dx) > ex || Math.abs(dz) > ez) continue;
    const px = ex - Math.abs(dx), pz = ez - Math.abs(dz);
    if (px < pz) { pos.x = cx + (dx >= 0 ? ex : -ex); player.vel.x = 0; }
    else { pos.z = cz + (dz >= 0 ? ez : -ez); player.vel.z = 0; }
  }
  // arena bounds
  pos.x = Math.max(-mapBounds, Math.min(mapBounds, pos.x));
  pos.z = Math.max(-mapBounds, Math.min(mapBounds, pos.z));
}

// Vertical resolve: find highest floor below feet+step, lowest ceiling above head
function resolveVertical(pos, r) {
  const feet = pos.y - eyeHeight();
  let floorY = GROUND;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
    const ex = (c.max.x - c.min.x) * 0.5 + r, ez = (c.max.z - c.min.z) * 0.5 + r;
    const dx = pos.x - cx, dz = pos.z - cz;
    if (Math.abs(dx) > ex || Math.abs(dz) > ez) continue;   // not above/below this collider footprint
    if (c.max.y <= feet + STEP_H && c.max.y > floorY) floorY = c.max.y;   // stand-on candidate
    if (c.min.y > feet && c.min.y < (pos.y + 0.2)) {                     // ceiling candidate
      if (pos.y + 0.2 > c.min.y && player.vel.y > 0) player.vel.y = 0;    // bonk head
    }
  }
  const target = floorY + eyeHeight();
  if (pos.y <= target + 0.001 && player.vel.y <= 0) {
    pos.y = target; player.vel.y = 0; player.onGround = true;
  } else {
    player.onGround = false;
  }
}

const tmpV = new THREE.Vector3();
const _assistFrom = new THREE.Vector3();
const _assistDir = new THREE.Vector3();
function updatePlayer(dt) {
  if (player.dead) return;
  // mobile: joystick axes -> keys/look accumulators
  applyTouchInput();
  // look
  const sens = 0.0022 * (adsAmount > 0.5 ? 0.6 : 1);
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
  player.yaw -= (mouseX - assistYaw * 0) * sens;   // base look
  player.yaw += assistYaw * 3.5 * dt;              // assist pull (per-second rate)
  player.pitch -= mouseY * sens;
  player.pitch += assistPitch * 3.5 * dt;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
  mouseX = 0; mouseY = 0;
  // recoil decay
  player.recoilP *= Math.pow(0.02, dt); player.recoilY *= Math.pow(0.02, dt);

  // ---- Slide (C/Ctrl while sprinting on ground) ----
  const crouchKey = !!(keys['KeyC'] || keys['ControlLeft'] || keys['ControlRight']);
  const movingInput = !!(keys['KeyW'] || keys['KeyA'] || keys['KeyS'] || keys['KeyD']);
  if (!player.sliding && crouchKey && player.sprinting && player.onGround && movingInput && !adsDown() && !player.exhausted) {
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
    const t = Math.min(1, player.slideT / 0.9);
    const startSpd = CFG.player.speed * CFG.player.sprintMul * 1.2;
    const endSpd = CFG.player.speed * 0.5;
    const slideSpeed = startSpd + (endSpd - startSpd) * t;
    player.vel.x = player.slideDir.x * slideSpeed;
    player.vel.z = player.slideDir.z * slideSpeed;
    // slide ends: timeout, released crouch, or stopped
    if (player.slideT > 0.9 || !crouchKey || (movingInput === false && player.slideT > 0.25)) {
      player.sliding = false;
      player.crouching = crouchKey;  // hold-to-crouch out of slide
      spawnSlideDust(player.pos);
      playSound('slide');
    }
    // slide-jump: convert momentum into a boost jump
    if (pressed['Space'] && player.onGround) {
      player.sliding = false;
      const spd = Math.hypot(player.vel.x, player.vel.z);
      const boost = Math.min(1.35, 1 + spd / (CFG.player.speed * CFG.player.sprintMul) * 0.3);
      player.vel.x *= boost; player.vel.z *= boost;
      player.vel.y = CFG.player.jumpVel * 1.08;
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
      // check headroom before standing
      let blocked = false;
      const feet = player.pos.y - CFG.player.height;
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        if (c.min.y < player.pos.y + 0.15 && c.max.y > feet + 0.2) {
          const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
          const ex = (c.max.x - c.min.x) * 0.5 + CFG.player.radius, ez = (c.max.z - c.min.z) * 0.5 + CFG.player.radius;
          if (Math.abs(player.pos.x - cx) <= ex && Math.abs(player.pos.z - cz) <= ez) { blocked = true; break; }
        }
      }
      if (!blocked) player.crouching = false;
    } else player.crouching = true;
  }

  // stamina & sprint (movingInput already declared in slide block above)
  const wantSprint = !!keys['ShiftLeft'] && movingInput && !player.crouching && !adsDown();
  if (wantSprint && !player.exhausted) {
    player.sprinting = true;
    player.stamina -= dt;
    if (player.stamina <= 0) { player.stamina = 0; player.exhausted = true; player.sprinting = false; }
  } else {
    player.sprinting = false;
    player.stamina = Math.min(CFG.player.maxStamina, player.stamina + dt * 0.7);
    if (player.exhausted && player.stamina > CFG.player.maxStamina * 0.35) player.exhausted = false;
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
  let speed = CFG.player.speed * (window.__analogMag || 1);
  if (player.sprinting) speed *= CFG.player.sprintMul;
  if (player.crouching) speed *= CFG.player.crouchMul;
  if (adsDown()) speed *= 0.65;
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  // forward = (-sin yaw, 0, -cos yaw); right = (cos yaw, 0, -sin yaw)
  // ix=+1 (D) -> right; iz=+1 (W) -> forward
  const wx = ix * cy + iz * (-sy);
  const wz = ix * (-sy) + iz * (-cy);
  const targetVX = wx * speed, targetVZ = wz * speed;
  // air control: partial authority while airborne (not while sliding)
  let rate;
  if (!player.onGround) {
    rate = player.sliding ? 4 : 7;
  } else {
    // ground: tighten deceleration when movement keys are released to stop in ~0.1s without snappy acceleration
    rate = len > 0 ? CFG.player.accel : (CFG.player.decel || 38);
  }
  if (!player.sliding) {
    player.vel.x += (targetVX - player.vel.x) * Math.min(1, rate * dt);
    player.vel.z += (targetVZ - player.vel.z) * Math.min(1, rate * dt);
    if (player.onGround && len === 0 && Math.hypot(player.vel.x, player.vel.z) < 0.05) {
      player.vel.x = 0; player.vel.z = 0;
    }
  }

  // jump: coyote time (0.12s grace after leaving ground) + jump buffering (0.15s)
  if (player.onGround) { player.coyoteT = 0.12; player.lastGroundT = gameT; }
  else player.coyoteT = Math.max(0, player.coyoteT - dt);
  if (pressed['Space']) player.jumpBufT = 0.15;
  else player.jumpBufT = Math.max(0, player.jumpBufT - dt);
  if (player.jumpBufT > 0 && player.coyoteT > 0 && !player.crouching && !player.sliding) {
    player.vel.y = CFG.player.jumpVel;
    player.onGround = false; player.coyoteT = 0; player.jumpBufT = 0;
    playSound('jump');
  }

  // gravity + integrate
  player.vel.y -= CFG.player.gravity * dt;
  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  player.pos.y += player.vel.y * dt;
  resolveXZ(player.pos, CFG.player.radius);
  resolveVertical(player.pos, CFG.player.radius);

  // health regen
  if (gameT - player.lastDamageT > CFG.player.regenDelay && player.health < CFG.player.health) {
    player.health = Math.min(CFG.player.health, player.health + CFG.player.regenRate * dt);
  }

  // head bob
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hSpeed > 0.5) {
    player.bobPhase += dt * (player.sprinting ? 13 : 9);
    player.bobAmp += (Math.min(1, hSpeed / 6) - player.bobAmp) * Math.min(1, 6 * dt);
  } else {
    player.bobAmp += (0 - player.bobAmp) * Math.min(1, 8 * dt);
  }

  // fall damage: none (arena is flat) — reset out-of-bounds safety
  if (player.pos.y < -5) { player.pos.set(0, CFG.player.height, 24); player.vel.set(0, 0, 0); }
}

// damage entry point (called by enemies/projectiles)
function damagePlayer(amount, dirDeg) {
  if (player.dead || godMode) return;
  let amt = amount;
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, amt * 0.6);
    player.armor -= absorbed;
    amt -= absorbed;
  }
  player.health -= amt;
  player.lastDamageT = gameT;
  showDamageFx(dirDeg, amount);
  updateHudHealth();
  if (player.health <= 0) { player.health = 0; killPlayer(); }
}

let godMode = false;

// ---- Slide helpers ----
function startSlide() {
  player.sliding = true;
  player.slideT = 0;
  // slide in current movement direction (momentum dir if moving)
  const hv = tmpV.set(player.vel.x, 0, player.vel.z);
  if (hv.lengthSq() > 1) hv.normalize(); else hv.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  player.slideDir.copy(hv);
  playSound('jump');   // soft whoosh
  spawnSlideDust(player.pos);
}
