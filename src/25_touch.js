// ============ MOBILE TOUCH CONTROLS ============
'use strict';
// IS_TOUCH is declared in 10_config_world.js

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
    <div id="tbtn-melee" class="tbtn tbtn-sm">KNIFE</div>
    <div id="tbtn-use" class="tbtn tbtn-sm">USE</div>
    <div id="tbtn-plate" class="tbtn tbtn-sm">PLATE</div>
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



  // ---- hold buttons ----
  function holdBtn(id, on, off) {
    const el = document.getElementById(id);
    const fingers = new Set();
    let startTime = 0;
    let pendingTimer = null;
    function release(e) {
      e.preventDefault(); for (const t of e.changedTouches) fingers.delete(t.identifier);
      if (!fingers.size) {
        const elapsed = performance.now() - startTime;
        if (elapsed < 40) {
          if (pendingTimer) clearTimeout(pendingTimer);
          pendingTimer = setTimeout(function () {
            pendingTimer = null;
            if (!fingers.size) {
              el.classList.remove('on');
              off();
            }
          }, 40 - elapsed);
        } else {
          if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
          el.classList.remove('on');
          off();
        }
      }
    }
    el.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      if (!fingers.size) startTime = performance.now();
      for (const t of e.changedTouches) fingers.add(t.identifier);
      el.classList.add('on'); on(); playSound('click');
    }, { passive: false });
    addEventListener('blur', function () {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      fingers.clear(); el.classList.remove('on'); off();
    });
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
  holdBtn('tbtn-nade', function () { keys['KeyG'] = true; }, function () { keys['KeyG'] = false; });
  holdBtn('tbtn-swap', function () { switchWeapon(curWeapon === 0 ? 1 : 0); }, function () {});
  holdBtn('tbtn-melee', function () { pressed['__melee'] = true; }, function () {});
  // USE is a HOLD, matching the keyboard: a purchase must never fire from a stray tap.
  holdBtn('tbtn-use', function () { keys['__use'] = true; }, function () { keys['__use'] = false; });
  holdBtn('tbtn-plate', function () { pressed['__plate'] = true; }, function () {});
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
