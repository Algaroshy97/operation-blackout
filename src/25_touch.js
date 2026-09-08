// ============ MOBILE TOUCH CONTROLS ============
'use strict';
// Detect touch device once
const IS_TOUCH = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) && matchMedia('(pointer: coarse)').matches;

let touchState = { active: false, moveX: 0, moveZ: 0, firing: false, tapFiring: false, ads: false, lookX: 0, lookY: 0 };

(function initTouchUI() {
  if (!IS_TOUCH) return;
  touchState.active = true;
  document.body.classList.add('touch');

  // ---- layout: left = joystick, right = look zone + buttons ----
  const ui = document.createElement('div');
  ui.id = 'touch-ui';
  ui.innerHTML = `
    <div id="joy-base"><div id="joy-stick"></div></div>
    <div id="look-zone"></div>
    <div id="tbtn-fire" class="tbtn">FIRE</div>
    <div id="tbtn-ads" class="tbtn tbtn-sm">ADS</div>
    <div id="tbtn-jump" class="tbtn tbtn-sm">JUMP</div>
    <div id="tbtn-slide" class="tbtn tbtn-sm">SLIDE</div>
    <div id="tbtn-reload" class="tbtn tbtn-sm">RLD</div>
    <div id="tbtn-nade" class="tbtn tbtn-sm">NADE</div>
    <div id="tbtn-swap" class="tbtn tbtn-sm">SWAP</div>
    <div id="tbtn-pause" class="tbtn tbtn-sm">II</div>
  `;
  document.body.appendChild(ui);

  const joyBase = document.getElementById('joy-base');
  const joyStick = document.getElementById('joy-stick');
  const lookZone = document.getElementById('look-zone');
  const R = 56;

  // ---- virtual joystick ----
  let joyId = null, joyCX = 0, joyCY = 0;
  joyBase.addEventListener('touchstart', function (e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (joyId !== null) return;
    joyId = t.identifier;
    const r = joyBase.getBoundingClientRect();
    joyCX = r.left + r.width / 2; joyCY = r.top + r.height / 2;
    joyMove(t);
  }, { passive: false });
  function joyMove(t) {
    let dx = t.clientX - joyCX, dy = t.clientY - joyCY;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx = dx / d * R; dy = dy / d * R; }
    joyStick.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    const nx = dx / R, ny = dy / R;
    // screen: up = forward (iz+1), right = strafe right (ix+1)
    touchState.moveZ = -ny;   // up on stick = forward
    touchState.moveX = nx;
    // deadzone
    if (Math.abs(touchState.moveX) < 0.12) touchState.moveX = 0;
    if (Math.abs(touchState.moveZ) < 0.12) touchState.moveZ = 0;
  }
  addEventListener('touchmove', function (e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { joyMove(t); e.preventDefault(); }
      else if (t.identifier === lookId) { lookMove(t); e.preventDefault(); }
    }
  }, { passive: false });
  function releaseTouches(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { joyId = null; touchState.moveX = 0; touchState.moveZ = 0; joyStick.style.transform = 'translate(0,0)'; }
      if (t.identifier === lookId) lookId = null;
    }
  }
  addEventListener('touchend', releaseTouches);
  addEventListener('touchcancel', releaseTouches);

  // ---- look zone (drag to aim) ----
  let lookId = null, lastLX = 0, lastLY = 0;
  addEventListener('blur', function () { joyId = null; lookId = null; joyStick.style.transform = 'translate(0,0)'; });
  lookZone.addEventListener('touchstart', function (e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (lookId !== null) return;
    lookId = t.identifier; lastLX = t.clientX; lastLY = t.clientY;
  }, { passive: false });
  function lookMove(t) {
    touchState.lookX += (t.clientX - lastLX);
    touchState.lookY += (t.clientY - lastLY);
    lastLX = t.clientX; lastLY = t.clientY;
  }

  // ---- tap-to-fire on look zone (short tap = single shot) ----
  lookZone.addEventListener('touchstart', function (e) {
    const t = e.changedTouches[0];
    window.__tapT = performance.now();
    window.__tapX = t.clientX; window.__tapY = t.clientY;
  });
  lookZone.addEventListener('touchend', function (e) {
    const t = e.changedTouches[0];
    if (performance.now() - (window.__tapT || 0) < 200 &&
        Math.hypot(t.clientX - (window.__tapX || 0), t.clientY - (window.__tapY || 0)) < 12) {
      touchState.tapFiring = true;
      setTimeout(function () { touchState.tapFiring = false; }, 60);
    }
  });

  // ---- hold buttons ----
  function holdBtn(id, on, off) {
    const el = document.getElementById(id);
    const fingers = new Set();
    function release(e) {
      e.preventDefault(); for (const t of e.changedTouches) fingers.delete(t.identifier);
      if (!fingers.size) { el.classList.remove('on'); off(); }
    }
    el.addEventListener('touchstart', function (e) {
      e.preventDefault(); for (const t of e.changedTouches) fingers.add(t.identifier);
      el.classList.add('on'); on(); playSound('click');
    }, { passive: false });
    addEventListener('blur', function () { fingers.clear(); el.classList.remove('on'); off(); });
    el.addEventListener('touchend', release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
  }
  holdBtn('tbtn-fire', function () { touchState.firing = true; }, function () { touchState.firing = false; mouse1Down = false; });
  holdBtn('tbtn-ads', function () { touchState.ads = true; }, function () { touchState.ads = false; });
  holdBtn('tbtn-jump', function () { pressed['Space'] = true; }, function () {});
  holdBtn('tbtn-slide', function () {
    // No delayed key writes: releasing/cancelling immediately releases crouch.
    keys['KeyC'] = true;
  }, function () { keys['KeyC'] = false; });
  holdBtn('tbtn-reload', function () { pressed['KeyR'] = true; }, function () {});
  holdBtn('tbtn-nade', function () { pressed['KeyG'] = true; }, function () {});
  holdBtn('tbtn-swap', function () { switchWeapon(curWeapon === 0 ? 1 : 0); }, function () {});
  document.getElementById('tbtn-pause').addEventListener('touchstart', function (e) {
    e.preventDefault();
    playSound('click');
    if (started && !paused) pauseGame();
  }, { passive: false });
})();

// Feed touch state into the keyboard-driven player controller each frame.
// Called from updatePlayer BEFORE movement intent is read.
function applyTouchInput() {
  if (!touchState.active) return;
  // movement: joystick axes emulate WASD as analog
  if (touchState.moveX || touchState.moveZ) {
    keys['KeyW'] = touchState.moveZ > 0.15;
    keys['KeyS'] = touchState.moveZ < -0.15;
    keys['KeyD'] = touchState.moveX > 0.15;
    keys['KeyA'] = touchState.moveX < -0.15;
    window.__analogMove = { x: touchState.moveX, z: touchState.moveZ };
    // Full forward stick automatically sprints; ease the stick back to walk.
    keys['ShiftLeft'] = touchState.moveZ > 0.72 && Math.hypot(touchState.moveX, touchState.moveZ) > 0.82 && !touchState.ads;
  } else {
    // Explicitly clear derived keys so a released/interrupted joystick cannot keep moving.
    keys['KeyW'] = keys['KeyS'] = keys['KeyA'] = keys['KeyD'] = false;
    keys['ShiftLeft'] = false;
    window.__analogMove = null;
  }
  // firing: mirror the touch button every frame so release cannot latch automatic fire
  mouse1Down = touchState.firing || touchState.tapFiring;
  // ADS
  keys['Mouse2'] = touchState.ads;
  // look: drag deltas feed the same accumulators the mouse uses
  mouseX += touchState.lookX; mouseY += touchState.lookY;
  touchState.lookX = 0; touchState.lookY = 0;
}
