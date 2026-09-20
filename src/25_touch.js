// ============ MOBILE TOUCH CONTROLS ============
'use strict';
// IS_TOUCH is declared in 10_config_world.js

let touchState = { active: false, moveX: 0, moveZ: 0, firing: false, tapFiring: false, ads: false, lookX: 0, lookY: 0 };
let joyBaseEl = null;

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
    <div id="tbtn-tactical" class="tbtn tbtn-sm">TAC</div>
    <div id="tbtn-streak" class="tbtn tbtn-sm">STRK</div>
    <div id="tbtn-pause" class="tbtn tbtn-sm">II</div>
  `;
  document.body.appendChild(ui);

  const joyBase = document.getElementById('joy-base');
  const joyStick = document.getElementById('joy-stick');
  const lookZone = document.getElementById('look-zone');
  joyBaseEl = joyBase;
  const R = CORE.JOYSTICK_RADIUS || 56;

  // ---- virtual joystick ----
  let joyId = null, joyCX = 0, joyCY = 0;
  joyBase.addEventListener('touchstart', function (e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (joyId !== null) return;
    joyId = t.identifier;
    joyBase.classList.add('on');
    const r = joyBase.getBoundingClientRect();
    joyCX = r.left + r.width / 2; joyCY = r.top + r.height / 2;
    joyMove(t);
  }, { passive: false });
  function joyMove(t) {
    const res = CORE.joystickInput(t.clientX - joyCX, t.clientY - joyCY, R, CORE.JOYSTICK_DEADZONE);
    joyStick.style.transform = 'translate(' + res.clampedX + 'px,' + res.clampedY + 'px)';
    touchState.moveZ = res.moveZ;   // up on stick = forward
    touchState.moveX = res.moveX;
  }
  let fireId = null, lastFX = 0, lastFY = 0;
  addEventListener('touchmove', function (e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { joyMove(t); e.preventDefault(); }
      else if (t.identifier === lookId) { lookMove(t); e.preventDefault(); }
      else if (t.identifier === fireId) { fireLookMove(t); e.preventDefault(); }
    }
  }, { passive: false });
  function releaseTouches(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        joyId = null;
        joyBase.classList.remove('on');
        joyBase.classList.remove('sprint');
        touchState.moveX = 0; touchState.moveZ = 0;
        joyStick.style.transform = 'translate(0,0)';
      }
      if (t.identifier === lookId) lookId = null;
      if (t.identifier === fireId) {
        fireId = null; touchState.firing = false; touchState.ads = false; mouse1Down = false;
        document.getElementById('tbtn-fire').classList.remove('on');
      }
    }
  }
  addEventListener('touchend', releaseTouches);
  addEventListener('touchcancel', releaseTouches);

  // ---- look zone (drag to aim) ----
  let lookId = null, lastLX = 0, lastLY = 0;
  addEventListener('blur', function () {
    joyId = null; lookId = null; fireId = null;
    touchState.firing = false; mouse1Down = false;
    joyBase.classList.remove('on');
    joyBase.classList.remove('sprint');
    joyStick.style.transform = 'translate(0,0)';
  });
  lookZone.addEventListener('touchstart', function (e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (lookId !== null) return;
    lookId = t.identifier; lastLX = t.clientX; lastLY = t.clientY;
  }, { passive: false });
  function lookMove(t) {
    const factor = getSetting('touchSensitivity') || 1;
    touchState.lookX += (t.clientX - lastLX) * factor;
    touchState.lookY += (t.clientY - lastLY) * factor;
    lastLX = t.clientX; lastLY = t.clientY;
  }
  function fireLookMove(t) {
    if (!getSetting('fireLook')) { lastFX = t.clientX; lastFY = t.clientY; return; }
    const factor = getSetting('touchSensitivity') || 1;
    touchState.lookX += (t.clientX - lastFX) * factor;
    touchState.lookY += (t.clientY - lastFY) * factor;
    lastFX = t.clientX; lastFY = t.clientY;
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
  // COD-style right fire: the same finger can hold FIRE and rotate the camera.
  const fireBtn = document.getElementById('tbtn-fire');
  fireBtn.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (fireId !== null) return;
    const t = e.changedTouches[0];
    fireId = t.identifier; lastFX = t.clientX; lastFY = t.clientY;
    touchState.firing = true;
    if (getSetting('fireMode') === 'ads + fire') touchState.ads = true;
    fireBtn.classList.add('on'); playSound('click');
  }, { passive: false });
  fireBtn.addEventListener('touchend', releaseTouches, { passive: false });
  fireBtn.addEventListener('touchcancel', releaseTouches, { passive: false });
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
  holdBtn('tbtn-tactical', function () { pressed['__tactical'] = true; }, function () {});
  // One control for both: a banked streak first, the field upgrade otherwise.
  // Two more buttons would not have fitted the cluster without a tray.
  holdBtn('tbtn-streak', function () { pressed['__streak'] = true; pressed['__field'] = true; }, function () {});
  document.getElementById('tbtn-pause').addEventListener('touchstart', function (e) {
    e.preventDefault();
    playSound('click');
    if (started && !paused) pauseGame();
  }, { passive: false });
})();

// Player-defined mobile layout. Positions are viewport percentages so they remain
// usable when the phone rotates or the browser chrome changes the viewport height.
const TOUCH_LAYOUT_KEY = 'blackout.touch-layout.v1';
let touchLayoutPositions = {};
function loadTouchLayoutPositions() {
  try { touchLayoutPositions = JSON.parse(localStorage.getItem(TOUCH_LAYOUT_KEY) || '{}') || {}; }
  catch (e) { touchLayoutPositions = {}; }
}
function applyTouchLayoutPositions() {
  if (!IS_TOUCH) return;
  loadTouchLayoutPositions();
  for (const id in touchLayoutPositions) {
    const el = document.getElementById(id);
    const p = touchLayoutPositions[id];
    if (!el || !p) continue;
    if (Number.isFinite(p.left)) { el.style.left = p.left + '%'; el.style.right = 'auto'; }
    if (Number.isFinite(p.top)) { el.style.top = p.top + '%'; el.style.bottom = 'auto'; }
    if (Number.isFinite(p.size)) { el.style.width = p.size + 'px'; el.style.height = p.size + 'px'; }
  }
}
function openTouchLayoutEditor() {
  if (!IS_TOUCH) return;
  const settings = document.getElementById('settings-screen');
  if (settings) settings.style.display = 'none';
  const ui = document.getElementById('touch-ui');
  if (!ui) return;
  applyTouchLayoutPositions();
  document.body.classList.add('touch-editing');
  let bar = document.getElementById('touch-editor-bar');
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'touch-editor-bar';
    bar.innerHTML = '<b>DRAG BUTTONS TO POSITION</b><span id="touch-editor-name">Select a button</span><input id="touch-editor-size" type="range" min="44" max="150" value="72"><button id="touch-editor-reset">RESET</button><button id="touch-editor-done">DONE</button>';
    document.body.appendChild(bar);
    bar.querySelector('#touch-editor-reset').addEventListener('click', function () {
      touchLayoutPositions = {};
      document.querySelectorAll('#touch-ui .tbtn, #touch-ui #joy-base').forEach(function (el) { el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; el.style.width = ''; el.style.height = ''; });
      applyTouchLayoutPositions();
    });
    bar.querySelector('#touch-editor-done').addEventListener('click', function () {
      localStorage.setItem(TOUCH_LAYOUT_KEY, JSON.stringify(touchLayoutPositions));
      document.body.classList.remove('touch-editing'); bar.remove();
      if (settings) { settings.style.display = 'flex'; buildSettingsUI(); }
    });
    bar.querySelector('#touch-editor-size').addEventListener('input', function (e) {
      const id = bar.dataset.selected; const el = id && document.getElementById(id);
      if (!el) return; const size = Number(e.target.value); el.style.width = size + 'px'; el.style.height = size + 'px';
      touchLayoutPositions[id] = touchLayoutPositions[id] || {}; touchLayoutPositions[id].size = size;
    });
  }
  const size = bar.querySelector('#touch-editor-size');
  const selectable = document.querySelectorAll('#touch-ui .tbtn, #touch-ui #joy-base');
  selectable.forEach(function (el) {
    el.addEventListener('touchstart', touchEditorStart, { capture: true, passive: false });
  });
  function touchEditorStart(e) {
    if (!document.body.classList.contains('touch-editing')) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget, t = e.changedTouches[0], r = el.getBoundingClientRect();
    bar.dataset.selected = el.id; bar.querySelector('#touch-editor-name').textContent = el.id.replace('tbtn-', '').toUpperCase();
    size.value = (touchLayoutPositions[el.id] && touchLayoutPositions[el.id].size) || Math.round(r.width);
    const move = function (ev) {
      for (const mt of ev.changedTouches) if (mt.identifier === t.identifier) {
        ev.preventDefault();
        const left = Math.max(0, Math.min(100 - (r.width / innerWidth * 100), (mt.clientX - r.width / 2) / innerWidth * 100));
        const top = Math.max(0, Math.min(100 - (r.height / innerHeight * 100), (mt.clientY - r.height / 2) / innerHeight * 100));
        el.style.left = left + '%'; el.style.top = top + '%'; el.style.right = 'auto'; el.style.bottom = 'auto';
        touchLayoutPositions[el.id] = touchLayoutPositions[el.id] || {}; touchLayoutPositions[el.id].left = left; touchLayoutPositions[el.id].top = top;
      }
    };
    const end = function (ev) { for (const et of ev.changedTouches) if (et.identifier === t.identifier) { removeEventListener('touchmove', move, true); removeEventListener('touchend', end, true); } };
    addEventListener('touchmove', move, { capture: true, passive: false }); addEventListener('touchend', end, true);
  }
}
applyTouchLayoutPositions();

// Feed touch state into the keyboard-driven player controller each frame.
// Called from updatePlayer BEFORE movement intent is read.
const _touchMoveKeys = { w: false, s: false, a: false, d: false };
function applyTouchInput() {
  if (!touchState.active) return;
  // movement: joystick axes emulate WASD as analog
  if (touchState.moveX || touchState.moveZ) {
    CORE.touchMovementKeys(touchState.moveX, touchState.moveZ, CORE.JOYSTICK_MOVE_THRESHOLD, _touchMoveKeys);
    keys['KeyW'] = _touchMoveKeys.w;
    keys['KeyS'] = _touchMoveKeys.s;
    keys['KeyD'] = _touchMoveKeys.d;
    keys['KeyA'] = _touchMoveKeys.a;
    window.__analogMove = { x: touchState.moveX, z: touchState.moveZ };
    // Full forward stick automatically sprints; ease the stick back to walk.
    const isSprint = CORE.isAutoSprint(touchState.moveX, touchState.moveZ, touchState.ads);
    keys['ShiftLeft'] = isSprint;
    if (joyBaseEl) joyBaseEl.classList.toggle('sprint', isSprint);
  } else {
    // Explicitly clear derived keys so a released/interrupted joystick cannot keep moving.
    keys['KeyW'] = keys['KeyS'] = keys['KeyA'] = keys['KeyD'] = false;
    keys['ShiftLeft'] = false;
    if (joyBaseEl) joyBaseEl.classList.remove('sprint');
    window.__analogMove = null;
  }
  // firing: mirror the touch button every frame so release cannot latch automatic fire
  mouse1Down = touchState.firing || touchState.tapFiring;
  // ADS
  keys['Mouse2'] = touchState.ads || (touchState.firing && getSetting('fireMode') === 'ads + fire');
  // look: drag deltas feed the same accumulators the mouse uses
  mouseX += touchState.lookX; mouseY += touchState.lookY;
  touchState.lookX = 0; touchState.lookY = 0;

  // Stance / slide button tactical feedback
  updateTouchSlideBtn();
}

let tbtnSlideEl = null;
function updateTouchSlideBtn() {
  if (!tbtnSlideEl) tbtnSlideEl = document.getElementById('tbtn-slide');
  if (!tbtnSlideEl || typeof player === 'undefined') return;
  const isSprint = !!keys['ShiftLeft'];
  const slideState = CORE.touchSlideState(!!player.sliding, !!player.crouching, isSprint);
  tbtnSlideEl.classList.toggle('sliding', slideState === 'sliding');
  tbtnSlideEl.classList.toggle('crouch', slideState === 'crouch');
  tbtnSlideEl.classList.toggle('sprint', slideState === 'sprint');
  const slideLabel = CORE.touchSlideLabel(!!player.sliding, !!player.crouching);
  if (tbtnSlideEl.textContent !== slideLabel) tbtnSlideEl.textContent = slideLabel;
}
