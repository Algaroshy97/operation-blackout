// ============ PLAYER CONTROLLER ============
'use strict';
const keys = Object.create(null);
const pressed = Object.create(null);
let paused = false, started = false, pointerLocked = false;
let mouse1Down = false;
let mouseX = 0, mouseY = 0;
let lastInputDevice = IS_TOUCH ? 'touch' : 'mouse';   // 'mouse' | 'touch' | 'pad' (aim assist + prompts)

// Raw (unaccelerated) mouse input where supported, with a plain fallback.
function lockPointer() {
  if (lastInputDevice === 'pad' || IS_TOUCH) return;
  try {
    const p = SETTINGS.rawInput ? canvas.requestPointerLock({ unadjustedMovement: true }) : canvas.requestPointerLock();
    if (p && p.catch) p.catch(function () { try { canvas.requestPointerLock(); } catch (e) { /* ignore */ } });
  } catch (e) { try { canvas.requestPointerLock(); } catch (e2) { /* ignore */ } }
}

addEventListener('keydown', function (e) {
  if (e.repeat) return;
  lastInputDevice = 'mouse';
  keys[e.code] = true; pressed[e.code] = true;
  if (['Space','ArrowUp','ArrowDown','KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE'].indexOf(e.code) >= 0) e.preventDefault();
  if ((e.code === 'Escape' || e.code === 'KeyP') && started && !paused && !perkMenuOpen()) pauseGame();
  // toggle options: C/Ctrl flips a crouch latch, which the controller reads like a held key
  if (SETTINGS.crouchToggle && (e.code === 'KeyC' || e.code === 'ControlLeft')) player.crouchLatch = !player.crouchLatch;
});
addEventListener('keyup', function (e) { keys[e.code] = false; });

canvas.addEventListener('mousedown', function (e) {
  if (!started || paused || player.dead) return;
  lastInputDevice = 'mouse';
  if (!pointerLocked) { lockPointer(); return; }
  if (e.button === 0) mouse1Down = true;
  if (e.button === 2) { if (SETTINGS.adsToggle) keys['Mouse2'] = !keys['Mouse2']; else keys['Mouse2'] = true; }
});
addEventListener('mouseup', function (e) {
  if (e.button === 0) mouse1Down = false;
  if (e.button === 2 && !SETTINGS.adsToggle) keys['Mouse2'] = false;
});
function clearInputState() {
  mouse1Down = false; mouseX = 0; mouseY = 0;
  for (const k in keys) delete keys[k];
  for (const k in pressed) delete pressed[k];
  if (typeof touchState !== 'undefined') {
    touchState.moveX = 0; touchState.moveZ = 0; touchState.firing = false;
    touchState.tapFiring = false; touchState.ads = false; touchState.lookX = 0; touchState.lookY = 0;
  }
  if (typeof player !== 'undefined') { player.crouchLatch = false; player.leanTarget = 0; }
  window.__analogMove = null;
}
addEventListener('blur', clearInputState);
document.addEventListener('visibilitychange', function () { if (document.hidden) clearInputState(); });
addEventListener('contextmenu', function (e) { e.preventDefault(); });
canvas.addEventListener('wheel', function (e) {
  if (!started || paused || player.dead) return;
  if (curW().zooms && adsAmount > 0.6) { cycleScopeZoom(); return; }   // wheel zooms the scope
  switchWeapon(curWeapon + (e.deltaY > 0 ? 1 : -1));
}, { passive: true });

document.addEventListener('pointerlockchange', function () {
  pointerLocked = document.pointerLockElement === canvas;
  if (!pointerLocked && started && !paused && !player.dead && !gameEnded && !perkMenuOpen() && lastInputDevice !== 'pad') pauseGame();
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
  recoilP: 0, recoilY: 0,   // camera recoil offsets (springs toward recoilTP/TY)
  recoilTP: 0, recoilTY: 0, recoilVP: 0, recoilVY: 0,
  // slide state
  sliding: false, slideT: 0, slideDir: new THREE.Vector3(),
  // jump feel
  coyoteT: 0, jumpBufT: 0, lastGroundT: 0,
  // smooth stance, lean, mantle, landing
  eyeH: CFG.player.height, crouchLatch: false,
  lean: 0, leanTarget: 0, leanOffset: new THREE.Vector3(),
  mantle: null, landDip: 0, landVel: 0, lastLandSpeed: 0,
  groundSurface: 'ground',
  lookDX: 0, lookDY: 0     // this frame's look input (viewmodel sway)
};

function eyeHeight() { return player.eyeH; }
// Where enemies aim: the eye, shifted by the current lean.
const _aimPt = new THREE.Vector3();
function playerAimPoint() { return _aimPt.copy(player.pos).add(player.leanOffset); }

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

// Vertical resolve: find highest floor below feet+step, lowest ceiling above head.
// Grounded players "stick" down small drops (stairs, crouching) instead of
// becoming airborne for a frame, which also keeps landing sounds honest.
function resolveVertical(pos, r) {
  const feet = pos.y - eyeHeight();
  let floorY = GROUND, floorSurf = 'ground';
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
    const ex = (c.max.x - c.min.x) * 0.5 + r, ez = (c.max.z - c.min.z) * 0.5 + r;
    const dx = pos.x - cx, dz = pos.z - cz;
    if (Math.abs(dx) > ex || Math.abs(dz) > ez) continue;   // not above/below this collider footprint
    if (c.max.y <= feet + STEP_H && c.max.y > floorY) { floorY = c.max.y; floorSurf = c.surface || 'concrete'; }   // stand-on candidate
    if (c.min.y > feet && c.min.y < (pos.y + 0.2)) {                     // ceiling candidate
      if (pos.y + 0.2 > c.min.y && player.vel.y > 0) player.vel.y = 0;    // bonk head
    }
  }
  const target = floorY + eyeHeight();
  const wasGround = player.onGround;
  if (pos.y <= target + 0.001 && player.vel.y <= 0) {
    if (!wasGround) player.lastLandSpeed = -player.vel.y;
    pos.y = target; player.vel.y = 0; player.onGround = true;
  } else if (wasGround && player.vel.y <= 0 && pos.y - target < STEP_H + 0.05) {
    pos.y = target; player.vel.y = 0; player.onGround = true;       // ground stick
  } else {
    player.onGround = false;
  }
  player.groundSurface = floorSurf;
}

// ---- Mantle / vault: climb any ledge up to ~2 m in front of the player ----
function colliderAt(x, z, pad) {
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (x >= c.min.x - pad && x <= c.max.x + pad && z >= c.min.z - pad && z <= c.max.z + pad) return true;
  }
  return false;
}
function findLedge(minRise, maxRise) {
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const feet = player.pos.y - eyeHeight();
  for (const reach of [0.55, 0.9]) {
    const px = player.pos.x + fx * reach, pz = player.pos.z + fz * reach;
    let top = -Infinity;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (px < c.min.x || px > c.max.x || pz < c.min.z || pz > c.max.z) continue;
      if (c.max.y > feet + minRise && c.max.y <= feet + maxRise && c.max.y > top) top = c.max.y;
    }
    if (top === -Infinity) continue;
    const lx = player.pos.x + fx * (reach + 0.35), lz = player.pos.z + fz * (reach + 0.35);
    if (Math.abs(lx) > mapBounds || Math.abs(lz) > mapBounds) continue;
    // clearance to at least crouch on the ledge
    let blocked = false;
    for (let i = 0; i < colliders.length && !blocked; i++) {
      const c = colliders[i];
      if (lx < c.min.x - 0.3 || lx > c.max.x + 0.3 || lz < c.min.z - 0.3 || lz > c.max.z + 0.3) continue;
      if (c.min.y < top + 1.1 && c.max.y > top + 0.02) blocked = true;
    }
    if (blocked) continue;
    return { x: lx, z: lz, top: top };
  }
  return null;
}
function startMantle(ledge) {
  const rise = ledge.top - (player.pos.y - eyeHeight());
  player.mantle = {
    t: 0, dur: 0.22 + rise * 0.16,
    fx: player.pos.x, fy: player.pos.y, fz: player.pos.z,
    tx: ledge.x, ty: ledge.top + eyeHeight(), tz: ledge.z
  };
  player.sliding = false;
  player.vel.set(0, 0, 0);
  player.stamina = Math.max(0, player.stamina - 0.25);
  playSound('mantle');
}
function updateMantle(dt) {
  const m = player.mantle;
  m.t += dt;
  const k = Math.min(1, m.t / m.dur);
  const ky = k < 0.65 ? 1 - Math.pow(1 - k / 0.65, 2) : 1;          // up first...
  const kx = k < 0.3 ? 0 : (k - 0.3) / 0.7, kxz = kx * kx * (3 - 2 * kx);   // ...then over
  player.pos.set(m.fx + (m.tx - m.fx) * kxz, m.fy + (m.ty - m.fy) * ky, m.fz + (m.tz - m.fz) * kxz);
  if (k >= 1) {
    player.mantle = null;
    player.vel.set(-Math.sin(player.yaw) * 1.5, 0, -Math.cos(player.yaw) * 1.5);
    player.onGround = true;
    player.landDip = Math.min(0.12, player.landDip + 0.06);
  }
}

// ---- Lean (Q / E): peek around cover, blocked by walls ----
const _leanR = new THREE.Vector3();
function leanBlocked(x, y, z) {
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (x > c.min.x - 0.18 && x < c.max.x + 0.18 && z > c.min.z - 0.18 && z < c.max.z + 0.18 && y > c.min.y - 0.1 && y < c.max.y + 0.1) return true;
  }
  return false;
}
function updateLean(dt) {
  let want = 0;
  if (!player.sprinting && !player.sliding && !player.mantle) {
    if (keys['KeyQ']) want -= 1;
    if (keys['KeyE']) want += 1;
    if (player.leanTarget) want = player.leanTarget;   // gamepad d-pad
  }
  player.lean += (want - player.lean) * Math.min(1, 10 * dt);
  _leanR.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  // shrink the lean until the eye is not inside geometry
  let amt = player.lean * 0.42;
  for (let i = 0; i < 4 && Math.abs(amt) > 0.01; i++) {
    if (!leanBlocked(player.pos.x + _leanR.x * amt, player.pos.y, player.pos.z + _leanR.z * amt)) break;
    amt *= 0.5;
  }
  player.leanOffset.set(_leanR.x * amt, -Math.abs(amt) * 0.12, _leanR.z * amt);
}

const tmpV = new THREE.Vector3();
const _assistFrom = new THREE.Vector3();
const _assistDir = new THREE.Vector3();
function updatePlayer(dt) {
  if (player.dead) return;
  // mobile: joystick axes -> keys/look accumulators; gamepad likewise
  applyTouchInput();
  if (typeof applyGamepadInput === 'function') applyGamepadInput(dt);
  // look: sensitivity scales with the zoom ratio so ADS / scopes feel consistent
  const zoom = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(SETTINGS.fov) / 2);
  const adsK = 1 + (zoom * SETTINGS.adsSens / 0.65 - 1) * Math.min(1, adsAmount);
  const sens = 0.0022 * SETTINGS.sens * adsK;
  // aim assist (touch / gamepad only): when ADS near an enemy, add a gentle pull toward chest
  let assistYaw = 0, assistPitch = 0;
  const assistOn = lastInputDevice !== 'mouse';
  if (assistOn && adsAmount > 0.8 && enemies.length) {
    camera.getWorldPosition(_assistFrom);
    _assistDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const nudged = applyAimAssist(_assistDir, _assistFrom);
    assistYaw = (Math.atan2(-nudged.x, -nudged.z) - Math.atan2(-_assistDir.x, -_assistDir.z));
    assistPitch = (Math.asin(nudged.y) - Math.asin(_assistDir.y));
    if (assistYaw > Math.PI) assistYaw -= Math.PI * 2;
    if (assistYaw < -Math.PI) assistYaw += Math.PI * 2;
  }
  const dYaw = -mouseX * sens, dPitch = -mouseY * sens * (SETTINGS.invertY ? -1 : 1);
  player.yaw += dYaw;
  player.yaw += assistYaw * 3.5 * dt;              // assist pull (per-second rate)
  player.pitch += dPitch;
  player.pitch += assistPitch * 3.5 * dt;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
  player.lookDX = dYaw; player.lookDY = dPitch;
  mouseX = 0; mouseY = 0;
  // recoil decay
  updateRecoilSpring(dt);

  if (player.mantle) {
    updateMantle(dt);
    updateLean(dt);
    player.bobAmp *= Math.exp(-8 * dt);
    return;
  }

  // ---- Slide (C/Ctrl while sprinting on ground) ----
  const crouchKey = !!(keys['KeyC'] || keys['ControlLeft'] || keys['ControlRight'] || player.crouchLatch);
  const movingInput = !!(keys['KeyW'] || keys['KeyA'] || keys['KeyS'] || keys['KeyD'] || window.__analogMove);
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
    const startSpd = CFG.player.speed * CFG.player.sprintMul * 1.2 * perkMul('move');
    const endSpd = CFG.player.speed * 0.5;
    const slideSpeed = startSpd + (endSpd - startSpd) * t;
    player.vel.x = player.slideDir.x * slideSpeed;
    player.vel.z = player.slideDir.z * slideSpeed;
    if (Math.random() < dt * 20) fxDust(player.pos, 1, 0.5);
    // slide ends: timeout, released crouch, or stopped
    if (player.slideT > 0.9 || !crouchKey || (movingInput === false && player.slideT > 0.25)) {
      player.sliding = false;
      player.crouching = crouchKey;  // hold-to-crouch out of slide
      if (SETTINGS.crouchToggle) player.crouchLatch = false;
      spawnSlideDust(player.pos);
      playSound('slide');
    }
    // slide-jump: convert momentum into a boost jump
    if (pressed['Space'] && player.onGround) {
      player.sliding = false;
      if (SETTINGS.crouchToggle) player.crouchLatch = false;
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
      const feet = player.pos.y - player.eyeH;
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        if (c.min.y < feet + CFG.player.height + 0.15 && c.max.y > feet + 0.2) {
          const cx = (c.min.x + c.max.x) * 0.5, cz = (c.min.z + c.max.z) * 0.5;
          const ex = (c.max.x - c.min.x) * 0.5 + CFG.player.radius, ez = (c.max.z - c.min.z) * 0.5 + CFG.player.radius;
          if (Math.abs(player.pos.x - cx) <= ex && Math.abs(player.pos.z - cz) <= ez) { blocked = true; break; }
        }
      }
      if (!blocked) player.crouching = false;
    } else player.crouching = true;
  }
  // smooth eye height (the vertical resolver carries the body with it)
  const targetEye = player.sliding ? 0.95 : player.crouching ? CFG.player.crouchHeight : CFG.player.height;
  const prevEye = player.eyeH;
  player.eyeH += (targetEye - player.eyeH) * Math.min(1, 12 * dt);
  if (!player.onGround) player.pos.y += player.eyeH - prevEye;   // tuck in the air: feet rise, eyes stay

  // stamina & sprint (movingInput already declared in slide block above)
  const wantSprint = !!keys['ShiftLeft'] && movingInput && !player.crouching && !adsDown() && gameT >= fireSprintBlockUntil && meleeT <= 0;
  if (wantSprint && !player.exhausted) {
    player.sprinting = true;
    player.stamina -= dt;
    if (player.stamina <= 0) { player.stamina = 0; player.exhausted = true; player.sprinting = false; }
  } else {
    player.sprinting = false;
    player.stamina = Math.min(CFG.player.maxStamina * perkMul('stamina'), player.stamina + dt * 0.7);
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
  let speed = CFG.player.speed * (window.__analogMag || 1) * perkMul('move');
  if (player.sprinting) speed *= CFG.player.sprintMul;
  if (player.crouching) speed *= CFG.player.crouchMul;
  if (adsDown()) speed *= 0.65;
  speed *= curW().moveMul || 1;
  if (Math.abs(player.lean) > 0.3) speed *= 0.7;
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  // forward = (-sin yaw, 0, -cos yaw); right = (cos yaw, 0, -sin yaw)
  // ix=+1 (D) -> right; iz=+1 (W) -> forward
  const wx = ix * cy + iz * (-sy);
  const wz = ix * (-sy) + iz * (-cy);
  const targetVX = wx * speed, targetVZ = wz * speed;
  // air control: partial authority while airborne (not while sliding)
  let rate;
  if (!player.onGround) {
    rate = player.sliding ? 4 : 3.5;
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
  // mantle takes priority over jumping when a climbable ledge is in front
  if (player.jumpBufT > 0 && !player.sliding) {
    const ledge = findLedge(player.onGround ? 0.7 : 0.1, player.onGround ? 2.05 : 1.5);
    if (ledge && (player.onGround || iz > 0.3)) {
      player.jumpBufT = 0; player.coyoteT = 0;
      startMantle(ledge);
      return;
    }
  }
  // airborne + pushing forward into a ledge at chest height: auto-mantle
  if (!player.onGround && iz > 0.5 && player.vel.y < 2.5 && !player.sliding) {
    const ledge = findLedge(0.25, 1.3);
    if (ledge) { startMantle(ledge); return; }
  }
  if (player.jumpBufT > 0 && player.coyoteT > 0 && !player.crouching && !player.sliding) {
    player.vel.y = CFG.player.jumpVel;
    player.onGround = false; player.coyoteT = 0; player.jumpBufT = 0;
    player.stamina = Math.max(0, player.stamina - 0.3);
    playSound('jump');
  }

  // gravity + integrate
  player.vel.y -= CFG.player.gravity * dt;
  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  player.pos.y += player.vel.y * dt;
  const airborne = !player.onGround;
  resolveXZ(player.pos, CFG.player.radius);
  resolveVertical(player.pos, CFG.player.radius);
  if (airborne && player.onGround) onLanded(player.lastLandSpeed);
  updateLean(dt);

  // health regen
  const regenDelay = CFG.player.regenDelay * perkMul('regenDelay');
  if (gameT - player.lastDamageT > regenDelay && player.health < CFG.player.health) {
    player.health = Math.min(CFG.player.health, player.health + CFG.player.regenRate * perkMul('regen') * dt);
  }

  // head bob
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hSpeed > 0.5) {
    player.bobPhase += dt * (player.sprinting ? 13 : player.crouching ? 7 : 9);
    player.bobAmp += (Math.min(1, hSpeed / 6) - player.bobAmp) * Math.min(1, 6 * dt);
  } else {
    player.bobAmp += (0 - player.bobAmp) * Math.min(1, 8 * dt);
  }

  // out-of-bounds safety
  if (player.pos.y < -5) { player.pos.set(0, CFG.player.height, 24); player.vel.set(0, 0, 0); }
}

// Camera recoil: the kick target decays (recovery) while the view follows it on a
// near-critically damped spring, so shots rise and settle smoothly instead of snapping.
function updateRecoilSpring(dt) {
  const w = curW();
  const recover = w && w.type === 'SR' ? 3.2 : 7;
  const k = Math.exp(-recover * dt);
  player.recoilTP *= k; player.recoilTY *= k;
  const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n, om = 38, c = 2 * 0.82 * om;
  for (let i = 0; i < n; i++) {
    player.recoilVP += ((player.recoilTP - player.recoilP) * om * om - player.recoilVP * c) * h;
    player.recoilVY += ((player.recoilTY - player.recoilY) * om * om - player.recoilVY * c) * h;
    player.recoilP += player.recoilVP * h; player.recoilY += player.recoilVY * h;
  }
}
// Landing: camera dip spring, dust, and fall damage past ~2.5 m drops.
function onLanded(speed) {
  player.landVel -= Math.min(2.2, speed * 0.14);
  if (speed > 12) {
    const dmg = Math.round((speed - 12) * 7);
    damagePlayer(dmg, undefined, true);
    addTrauma(Math.min(0.6, (speed - 12) * 0.12));
  }
}
function updateLandSpring(dt) {
  // critically-damped-ish spring pulling the dip back to 0
  player.landVel += (-player.landDip * 140 - player.landVel * 16) * dt;
  player.landDip += player.landVel * dt;
  player.landDip = Math.max(-0.3, Math.min(0.2, player.landDip));
}

// damage entry point (called by enemies/projectiles). pierce = ignores armor (falls, fire).
function damagePlayer(amount, dirDeg, pierce) {
  if (player.dead || godMode) return;
  let amt = amount;
  if (player.armor > 0 && !pierce) {
    const absorbed = Math.min(player.armor, amt * 0.6);
    const had = player.armor;
    player.armor -= absorbed;
    amt -= absorbed;
    if (had > 0 && player.armor <= 0.01) { player.armor = 0; playSound('armor_break'); }
  }
  player.health -= amt;
  player.lastDamageT = gameT;
  showDamageFx(dirDeg, amount);
  postKick('damage', Math.min(0.8, 0.15 + amount / 40));
  addTrauma(Math.min(0.35, amount / 60));
  updateHudHealth();
  if (player.health <= 0) { player.health = 0; killPlayer(); }
}

let godMode = false;

// ---- Camera shake (trauma model: offset = trauma^2 * smooth noise) ----
let camTrauma = 0;
function addTrauma(a) { camTrauma = Math.min(1, camTrauma + a); }
const camShake = { yaw: 0, pitch: 0, roll: 0 };
function updateCameraShake(dt, t) {
  camTrauma = Math.max(0, camTrauma - dt * 1.3);
  const s = camTrauma * camTrauma;
  // sum of incommensurate sines = cheap, smooth, non-repeating noise
  camShake.yaw = s * 0.05 * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 23.7 + 1.3) * 0.4);
  camShake.pitch = s * 0.05 * (Math.sin(t * 31.3 + 2.1) * 0.6 + Math.sin(t * 19.9 + 0.7) * 0.4);
  camShake.roll = s * 0.08 * (Math.sin(t * 27.9 + 4.2) * 0.6 + Math.sin(t * 15.1 + 2.9) * 0.4);
}

// ---- Slide helpers ----
function startSlide() {
  player.sliding = true;
  player.slideT = 0;
  // slide in current movement direction (momentum dir if moving)
  const hv = tmpV.set(player.vel.x, 0, player.vel.z);
  if (hv.lengthSq() > 1) hv.normalize(); else hv.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  player.slideDir.copy(hv);
  playSound('slide');
  spawnSlideDust(player.pos);
}
