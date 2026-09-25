// ============ GAMEPAD (standard mapping: Xbox / PlayStation) ============
'use strict';
// LS move · RS look · RT fire · LT aim · A jump/mantle · B crouch/slide (hold)
// X reload · Y swap weapon · LB grenade (hold to cook the arc) · RB melee
// L3 sprint · D-pad ◀ ▶ lean · Start pause. Menus: D-pad/LS to move focus, A select, B back.
const PAD = { index: -1, prev: [], sprintLatch: false, moving: false, navT: 0, lastLeanSet: false };
const PAD_BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
addEventListener('gamepadconnected', function (e) { PAD.index = e.gamepad.index; });
addEventListener('gamepaddisconnected', function (e) { if (PAD.index === e.gamepad.index) PAD.index = -1; });
function getPad() {
  if (!navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  if (PAD.index >= 0 && pads[PAD.index]) return pads[PAD.index];
  for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { PAD.index = i; return pads[i]; }
  return null;
}
function padBtn(p, i) { const b = p.buttons[i]; return !!b && (b.pressed || b.value > 0.4); }
function padEdge(p, i) { return padBtn(p, i) && !PAD.prev[i]; }
// radial deadzone + power response curve (fine aim near the centre, fast at the edge)
function padStick(x, y, dz, power) {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz));
  const c = Math.pow(k, power);
  return [x / m * c, y / m * c, c];
}
const _padAim = new THREE.Vector3(), _padTo = new THREE.Vector3();
// Aim friction: slow the stick while the crosshair sits on an enemy.
function padAimFriction() {
  _padAim.set(0, 0, -1).applyQuaternion(camera.quaternion);
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (en.dead) continue;
    _padTo.set(en.pos.x, en.pos.y + 1.2, en.pos.z).sub(camera.position);
    const d = _padTo.length();
    if (d > 60) continue;
    if (_padAim.angleTo(_padTo.normalize()) < Math.max(0.02, 0.9 / d)) return 0.45;
  }
  return 1;
}
function applyGamepadInput(dt) {
  const p = getPad();
  if (!p) return;
  const any = p.buttons.some(function (b) { return b.pressed; }) || p.axes.some(function (a) { return Math.abs(a) > 0.3; });
  if (any) lastInputDevice = 'pad';
  if (lastInputDevice !== 'pad') { PAD.prev = p.buttons.map(function (b) { return b.pressed || b.value > 0.4; }); return; }
  // move
  const mv = padStick(p.axes[0] || 0, p.axes[1] || 0, 0.16, 1.2);
  if (mv[2] > 0) {
    window.__analogMove = { x: mv[0], z: -mv[1] };
    keys['KeyW'] = -mv[1] > 0.15; keys['KeyS'] = -mv[1] < -0.15;
    keys['KeyD'] = mv[0] > 0.15; keys['KeyA'] = mv[0] < -0.15;
    PAD.moving = true;
  } else if (PAD.moving) {
    window.__analogMove = null;
    keys['KeyW'] = keys['KeyS'] = keys['KeyA'] = keys['KeyD'] = false;
    PAD.moving = false; PAD.sprintLatch = false;
  }
  if (padEdge(p, PAD_BTN.L3)) PAD.sprintLatch = !PAD.sprintLatch;
  if (-mv[1] < 0.3) PAD.sprintLatch = false;
  keys['ShiftLeft'] = PAD.sprintLatch;
  // look (radians/sec, converted into the mouse accumulators the controller reads)
  const lk = padStick(p.axes[2] || 0, p.axes[3] || 0, 0.12, 1.9);
  const friction = adsAmount > 0.5 || mouse1Down ? padAimFriction() : 1;
  const rate = 3.4 * SETTINGS.padSens * friction;
  const sens = 0.0022 * SETTINGS.sens;
  mouseX += lk[0] * rate * dt / sens;
  mouseY += lk[1] * rate * 0.72 * dt / sens;
  // buttons
  mouse1Down = padBtn(p, PAD_BTN.RT);
  keys['Mouse2'] = padBtn(p, PAD_BTN.LT);
  if (padEdge(p, PAD_BTN.A)) pressed['Space'] = true;
  keys['KeyC'] = padBtn(p, PAD_BTN.B);
  if (padEdge(p, PAD_BTN.X)) pressed['KeyR'] = true;
  if (padEdge(p, PAD_BTN.Y)) switchWeapon(curWeapon + 1);
  keys['KeyG'] = padBtn(p, PAD_BTN.LB);
  if (padEdge(p, PAD_BTN.RB) || padEdge(p, PAD_BTN.R3)) pressed['KeyV'] = true;
  player.leanTarget = padBtn(p, PAD_BTN.LEFT) ? -1 : padBtn(p, PAD_BTN.RIGHT) ? 1 : 0;
  if (padEdge(p, PAD_BTN.UP)) cycleScopeZoom();
  if (padEdge(p, PAD_BTN.START) && started && !paused) pauseGame();
  PAD.prev = p.buttons.map(function (b) { return b.pressed || b.value > 0.4; });
}
// Menu navigation runs every frame (also while paused / in menus).
function pollGamepadMenus(dt) {
  const p = getPad();
  if (!p) return;
  const inGame = started && !paused && !player.dead && !gameEnded && !perkMenuOpen();
  if (inGame) return;
  const pressedNow = p.buttons.map(function (b) { return b.pressed || b.value > 0.4; });
  const edge = function (i) { return pressedNow[i] && !PAD.prev[i]; };
  if (pressedNow.some(Boolean)) lastInputDevice = 'pad';
  const items = Array.prototype.filter.call(document.querySelectorAll('.menu-btn, .gun-card, .perk-card, .set-row input, .set-row select'), function (el) {
    return el.offsetParent !== null && !el.classList.contains('disabled');
  });
  PAD.navT -= dt;
  const ay = p.axes[1] || 0, ax = p.axes[0] || 0;
  let step = 0;
  if (edge(PAD_BTN.DOWN) || edge(PAD_BTN.RIGHT)) step = 1;
  if (edge(PAD_BTN.UP) || edge(PAD_BTN.LEFT)) step = -1;
  if (!step && PAD.navT <= 0 && (Math.abs(ay) > 0.6 || Math.abs(ax) > 0.6)) { step = (ay > 0.6 || ax > 0.6) ? 1 : -1; PAD.navT = 0.22; }
  if (step && items.length) {
    const cur = items.indexOf(document.activeElement);
    const next = items[(cur + step + items.length) % items.length];
    next.focus();
  }
  if (edge(PAD_BTN.A) && document.activeElement && items.indexOf(document.activeElement) >= 0) document.activeElement.click();
  if (edge(PAD_BTN.START) || edge(PAD_BTN.B)) {
    if (paused && $id('settings-menu').style.display !== 'flex') resumeGame();
    else if ($id('settings-menu').style.display === 'flex') closeSettings();
  }
  PAD.prev = pressedNow;
}
