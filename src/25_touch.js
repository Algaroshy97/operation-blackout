// ============ MOBILE TOUCH CONTROLS ============
'use strict';
// IS_TOUCH is declared in 10_config_world.js

let touchState = { active: false, moveX: 0, moveZ: 0, firing: false, tapFiring: false, ads: false, lookX: 0, lookY: 0 };
let gyroEnabled = false;
let gyroLast = null;
const gyroDelta = { yaw: 0, pitch: 0 };
function setGyroAimEnabled(enabled) {
  if (!enabled) {
    gyroEnabled = false; gyroLast = null;
    if (typeof window !== 'undefined') window.removeEventListener('deviceorientation', onGyroOrientation);
    return;
  }
  if (!IS_TOUCH || !window.isSecureContext || !('DeviceOrientationEvent' in window)) {
    return;
  }
  if (gyroEnabled) return;
  let request;
  try {
    request = typeof DeviceOrientationEvent.requestPermission === 'function'
      ? DeviceOrientationEvent.requestPermission() : Promise.resolve('granted');
  } catch (e) { return; } // iOS requires a trusted user gesture; retry on the next tap.
  request.then(function (permission) {
    if (permission !== 'granted') throw new Error('orientation permission denied');
    gyroEnabled = true; gyroLast = null;
    window.addEventListener('deviceorientation', onGyroOrientation, { passive: true });
  }).catch(function () {
    gyroEnabled = false; gyroLast = null;
  });
}
if (typeof window !== 'undefined') window.addEventListener('click', function () {
  if (typeof getSetting === 'function' && getSetting('gyroAim') && !gyroEnabled) setGyroAimEnabled(true);
}, { passive: true });
function onGyroOrientation(event) {
  if (!gyroEnabled || !touchState.active || !touchGameplayEnabled() ||
      typeof event.beta !== 'number' || typeof event.gamma !== 'number') return;
  if (!gyroLast) { gyroLast = { beta: event.beta, gamma: event.gamma }; return; }
  const betaDelta = ((event.beta - gyroLast.beta + 540) % 360) - 180;
  const gammaDelta = ((event.gamma - gyroLast.gamma + 540) % 360) - 180;
  gyroLast.beta = event.beta; gyroLast.gamma = event.gamma;
  CORE.gyroLookDelta(betaDelta, gammaDelta, getSetting('touchSensitivity') * 7, gyroDelta);
  touchState.lookX += gyroDelta.yaw;
  touchState.lookY += gyroDelta.pitch;
}
let joyBaseEl = null;
let resetTouchControls = function () {};
function touchGameplayEnabled() {
  const isEditing = typeof document !== 'undefined' && document.body && document.body.classList.contains('touch-editing');
  const isDead = typeof player !== 'undefined' && !!(player && player.dead);
  return (typeof CORE !== 'undefined' && typeof CORE.isTouchGameplayEnabled === 'function')
    ? CORE.isTouchGameplayEnabled(started, paused, isDead, isEditing)
    : (started && !paused && !isDead && !isEditing);
}

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
    <div id="tbtn-fire" role="button" aria-label="Fire (drag to aim when enabled)" class="tbtn">FIRE</div>
    <div id="tbtn-ads" role="button" aria-label="Aim down sights" class="tbtn tbtn-sm">ADS</div>
    <div id="tbtn-jump" role="button" aria-label="Jump / climb" class="tbtn tbtn-sm">JUMP</div>
    <div id="tbtn-slide" role="button" aria-label="Slide / crouch" class="tbtn tbtn-sm">SLIDE</div>
    <div id="tbtn-reload" role="button" aria-label="Reload" class="tbtn tbtn-sm">RLD</div>
    <div id="tbtn-nade" role="button" aria-label="Hold grenade" class="tbtn tbtn-sm">NADE</div>
    <div id="tbtn-swap" role="button" aria-label="Swap weapon" class="tbtn tbtn-sm">SWAP</div>
    <div id="tbtn-melee" role="button" aria-label="Melee attack" class="tbtn tbtn-sm">KNIFE</div>
    <div id="tbtn-use" role="button" aria-label="Hold to interact / buy" class="tbtn tbtn-sm">USE</div>
    <div id="tbtn-plate" role="button" aria-label="Insert armor plate" class="tbtn tbtn-sm">PLATE</div>
    <div id="tbtn-tactical" role="button" aria-label="Tactical equipment" class="tbtn tbtn-sm">TAC</div>
    <div id="tbtn-streak" role="button" aria-label="Streak / field upgrade" class="tbtn tbtn-sm">STRK</div>
    <div id="tbtn-pause" role="button" aria-label="Pause game" class="tbtn tbtn-sm">II</div>
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
    if (!touchGameplayEnabled()) return;
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
  let fireId = null, lastFX = 0, lastFY = 0, adsHeld = false;
  const holdResets = [];
  function syncAds() { touchState.ads = adsHeld || (touchState.firing && getSetting('fireMode') === 'ads + fire'); }
  addEventListener('touchmove', function (e) {
    if (!touchGameplayEnabled()) { resetTouchControls(); return; }
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
        fireId = null; touchState.firing = false; mouse1Down = false;
        if (e.type === 'touchcancel') touchState.tapFiring = false;
        syncAds();
        document.getElementById('tbtn-fire').classList.remove('on');
      }
    }
  }
  addEventListener('touchend', releaseTouches);
  addEventListener('touchcancel', releaseTouches);

  // ---- look zone (drag to aim) ----
  let lookId = null, lastLX = 0, lastLY = 0;
  resetTouchControls = function () {
    joyId = null; lookId = null; fireId = null; adsHeld = false;
    touchState.moveX = touchState.moveZ = touchState.lookX = touchState.lookY = 0;
    touchState.firing = touchState.tapFiring = touchState.ads = false;
    mouse1Down = false; mouseX = mouseY = 0;
    window.__analogMove = null;
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft', 'Mouse2', 'KeyC', 'KeyG', '__use']) keys[k] = false;
    for (const k of ['Space', 'KeyR', '__melee', '__plate', '__tactical', '__streak', '__field']) delete pressed[k];
    joyBase.classList.remove('on', 'sprint', 'crawl');
    joyStick.style.transform = 'translate(0,0)';
    document.getElementById('tbtn-fire').classList.remove('on');
    for (const reset of holdResets) reset();
  };
  // Compose with the existing pause/death/settings reset without changing desktop input.
  const originalClearInputState = clearInputState;
  clearInputState = function () { originalClearInputState(); resetTouchControls(); };
  addEventListener('blur', resetTouchControls);
  addEventListener('pagehide', resetTouchControls);
  document.addEventListener('visibilitychange', function () { if (document.hidden) resetTouchControls(); });
  lookZone.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (!touchGameplayEnabled()) return;
    const t = e.changedTouches[0];
    if (lookId !== null) return;
    lookId = t.identifier; lastLX = t.clientX; lastLY = t.clientY;
  }, { passive: false });
  function lookMove(t) {
    const factor = getSetting('touchSensitivity') || 1;
    const dx = (typeof CORE !== 'undefined' && typeof CORE.touchLookDelta === 'function')
      ? CORE.touchLookDelta(t.clientX, lastLX, factor)
      : (t.clientX - lastLX) * factor;
    const dy = (typeof CORE !== 'undefined' && typeof CORE.touchLookDelta === 'function')
      ? CORE.touchLookDelta(t.clientY, lastLY, factor)
      : (t.clientY - lastLY) * factor;
    touchState.lookX += dx;
    touchState.lookY += dy;
    lastLX = t.clientX; lastLY = t.clientY;
  }
  function fireLookMove(t) {
    if (!getSetting('fireLook')) { lastFX = t.clientX; lastFY = t.clientY; return; }
    const factor = getSetting('touchSensitivity') || 1;
    const dx = (typeof CORE !== 'undefined' && typeof CORE.touchLookDelta === 'function')
      ? CORE.touchLookDelta(t.clientX, lastFX, factor)
      : (t.clientX - lastFX) * factor;
    const dy = (typeof CORE !== 'undefined' && typeof CORE.touchLookDelta === 'function')
      ? CORE.touchLookDelta(t.clientY, lastFY, factor)
      : (t.clientY - lastFY) * factor;
    touchState.lookX += dx;
    touchState.lookY += dy;
    lastFX = t.clientX; lastFY = t.clientY;
  }



  // ---- hold buttons ----
  function holdBtn(id, on, off) {
    const el = document.getElementById(id);
    const fingers = new Set();
    function reset() { fingers.clear(); el.classList.remove('on'); off(); }
    holdResets.push(reset);
    function release(e) {
      let owned = false;
      for (const t of e.changedTouches) if (fingers.delete(t.identifier)) owned = true;
      if (!owned) return;
      e.preventDefault();
      if (!fingers.size) reset();
    }
    el.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (!touchGameplayEnabled()) return;
      const wasHeld = fingers.size > 0;
      for (const t of e.changedTouches) fingers.add(t.identifier);
      if (!wasHeld && fingers.size) { el.classList.add('on'); on(); playSound('click'); }
    }, { passive: false });
    // Window listeners also handle a finger drifting off its original hitbox.
    addEventListener('touchend', release, { passive: false });
    addEventListener('touchcancel', release, { passive: false });
    el.addEventListener('touchend', release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
  }
  // COD-style right fire: the same finger can hold FIRE and rotate the camera.
  const fireBtn = document.getElementById('tbtn-fire');
  fireBtn.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (!touchGameplayEnabled() || fireId !== null) return;
    const t = e.changedTouches[0];
    fireId = t.identifier; lastFX = t.clientX; lastFY = t.clientY;
    touchState.firing = true;
    touchState.tapFiring = true; // retain taps shorter than one render frame, not cancelled touches
    syncAds();
    fireBtn.classList.add('on'); playSound('click');
  }, { passive: false });
  fireBtn.addEventListener('touchend', releaseTouches, { passive: false });
  fireBtn.addEventListener('touchcancel', releaseTouches, { passive: false });
  holdBtn('tbtn-ads', function () { adsHeld = true; syncAds(); }, function () { adsHeld = false; syncAds(); });
  holdBtn('tbtn-jump', function () { pressed['Space'] = true; }, function () {});
  holdBtn('tbtn-slide', function () {
    // No delayed key writes: releasing/cancelling immediately releases crouch.
    keys['KeyC'] = true;
  }, function () { keys['KeyC'] = false; });
  holdBtn('tbtn-reload', function () { pressed['KeyR'] = true; }, function () {});
  holdBtn('tbtn-nade', function () { keys['KeyG'] = true; }, function () { keys['KeyG'] = false; });
  holdBtn('tbtn-swap', function () { cycleWeapon(1); }, function () {});
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
    const isEditing = typeof document !== 'undefined' && document.body && document.body.classList.contains('touch-editing');
    const isDead = typeof player !== 'undefined' && !!(player && player.dead);
    const canPause = (typeof CORE !== 'undefined' && typeof CORE.canTouchPause === 'function')
      ? CORE.canTouchPause(started, paused, isDead, isEditing)
      : (!isEditing && started && !paused && !isDead);
    if (canPause) { resetTouchControls(); pauseGame(); }
  }, { passive: false });
})();

// Player-defined mobile layout. Positions are viewport percentages so they remain
// usable when the phone rotates or the browser chrome changes the viewport height.
const TOUCH_LAYOUT_KEY = 'blackout.touch-layout.v1';
let touchLayoutPositions = {};
function loadTouchLayoutPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOUCH_LAYOUT_KEY) || '{}');
    touchLayoutPositions = (typeof CORE !== 'undefined' && typeof CORE.sanitizeTouchLayout === 'function')
      ? CORE.sanitizeTouchLayout(raw)
      : (raw && typeof raw === 'object' ? raw : {});
  }
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
    if (Number.isFinite(p.size)) {
      const sz = (typeof CORE !== 'undefined' && typeof CORE.clampTouchControlSize === 'function')
        ? CORE.clampTouchControlSize(p.size)
        : p.size;
      el.style.width = sz + 'px'; el.style.height = sz + 'px';
    }
  }
}
function openTouchLayoutEditor() {
  if (!IS_TOUCH) return;
  resetTouchControls();
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
      try { localStorage.removeItem(TOUCH_LAYOUT_KEY); } catch (e) {}
      document.querySelectorAll('#touch-ui .tbtn, #touch-ui #joy-base').forEach(function (el) { el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; el.style.width = ''; el.style.height = ''; el.classList.remove('selected'); });
      bar.dataset.selected = '';
      bar.querySelector('#touch-editor-name').textContent = (typeof CORE !== 'undefined' && typeof CORE.touchEditorControlLabel === 'function')
        ? CORE.touchEditorControlLabel(null)
        : 'Select a button';
      applyTouchLayoutPositions();
    });
    bar.querySelector('#touch-editor-done').addEventListener('click', function () {
      localStorage.setItem(TOUCH_LAYOUT_KEY, JSON.stringify(touchLayoutPositions));
      document.body.classList.remove('touch-editing');
      document.querySelectorAll('#touch-ui .tbtn, #touch-ui #joy-base').forEach(function (el) { el.classList.remove('selected'); });
      bar.remove();
      if (settings) { settings.style.display = 'flex'; buildSettingsUI(); }
    });
    bar.querySelector('#touch-editor-size').addEventListener('input', function (e) {
      const id = bar.dataset.selected; const el = id && document.getElementById(id);
      if (!el) return;
      const rawVal = Number(e.target.value);
      const sizeVal = (typeof CORE !== 'undefined' && typeof CORE.clampTouchControlSize === 'function')
        ? CORE.clampTouchControlSize(rawVal)
        : rawVal;
      el.style.width = sizeVal + 'px'; el.style.height = sizeVal + 'px';
      touchLayoutPositions[id] = touchLayoutPositions[id] || {}; touchLayoutPositions[id].size = sizeVal;
      const nameEl = bar.querySelector('#touch-editor-name');
      if (nameEl) {
        nameEl.textContent = (typeof CORE !== 'undefined' && typeof CORE.touchEditorControlLabel === 'function')
          ? CORE.touchEditorControlLabel(id, sizeVal)
          : id.replace('tbtn-', '').toUpperCase() + ' (' + sizeVal + 'px)';
      }
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
    bar.dataset.selected = el.id;
    selectable.forEach(function (btn) {
      const isSel = (typeof CORE !== 'undefined' && typeof CORE.isTouchControlSelected === 'function')
        ? CORE.isTouchControlSelected(btn.id, el.id)
        : btn.id === el.id;
      btn.classList.toggle('selected', isSel);
    });
    const baseW = Math.round(r.width);
    const curSize = (touchLayoutPositions[el.id] && touchLayoutPositions[el.id].size)
      || ((typeof CORE !== 'undefined' && typeof CORE.clampTouchControlSize === 'function')
        ? CORE.clampTouchControlSize(baseW)
        : baseW);
    size.value = curSize;
    bar.querySelector('#touch-editor-name').textContent = (typeof CORE !== 'undefined' && typeof CORE.touchEditorControlLabel === 'function')
      ? CORE.touchEditorControlLabel(el.id, curSize)
      : (typeof CORE !== 'undefined' && typeof CORE.touchControlName === 'function')
        ? CORE.touchControlName(el.id) + ' (' + curSize + 'px)'
        : el.id.replace('tbtn-', '').toUpperCase() + ' (' + curSize + 'px)';
    const move = function (ev) {
      for (const mt of ev.changedTouches) if (mt.identifier === t.identifier) {
        ev.preventDefault();
        const rawLeft = (typeof CORE !== 'undefined' && typeof CORE.touchLayoutClampPercent === 'function')
          ? CORE.touchLayoutClampPercent(mt.clientX, r.width, innerWidth)
          : Math.max(0, Math.min(100 - (r.width / innerWidth * 100), (mt.clientX - r.width / 2) / innerWidth * 100));
        const rawTop = (typeof CORE !== 'undefined' && typeof CORE.touchLayoutClampPercent === 'function')
          ? CORE.touchLayoutClampPercent(mt.clientY, r.height, innerHeight)
          : Math.max(0, Math.min(100 - (r.height / innerHeight * 100), (mt.clientY - r.height / 2) / innerHeight * 100));
        const left = (typeof CORE !== 'undefined' && typeof CORE.clampTouchLayoutCoord === 'function')
          ? CORE.clampTouchLayoutCoord(rawLeft)
          : rawLeft;
        const top = (typeof CORE !== 'undefined' && typeof CORE.clampTouchLayoutCoord === 'function')
          ? CORE.clampTouchLayoutCoord(rawTop)
          : rawTop;
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
const _touchAnalogMove = { x: 0, z: 0 };
function applyTouchInput() {
  if (!touchState.active) return;
  if (!touchGameplayEnabled()) { resetTouchControls(); return; }
  // movement: joystick axes emulate WASD as analog
  if (touchState.moveX || touchState.moveZ) {
    CORE.touchMovementKeys(touchState.moveX, touchState.moveZ, CORE.JOYSTICK_MOVE_THRESHOLD, _touchMoveKeys);
    keys['KeyW'] = _touchMoveKeys.w;
    keys['KeyS'] = _touchMoveKeys.s;
    keys['KeyD'] = _touchMoveKeys.d;
    keys['KeyA'] = _touchMoveKeys.a;
    _touchAnalogMove.x = touchState.moveX; _touchAnalogMove.z = touchState.moveZ;
    window.__analogMove = _touchAnalogMove;
    // Full forward stick automatically sprints; ease the stick back to walk.
    const isSprint = CORE.isAutoSprint(touchState.moveX, touchState.moveZ, touchState.ads);
    keys['ShiftLeft'] = isSprint;
    const isDowned = typeof player !== 'undefined' && !!player.downed;
    const joyTier = (typeof CORE !== 'undefined' && typeof CORE.joystickMoveSpeedTier === 'function')
      ? CORE.joystickMoveSpeedTier(touchState.moveX, touchState.moveZ, isSprint, isDowned)
      : (isSprint ? 'sprint' : 'walk');
    if (joyBaseEl) {
      joyBaseEl.classList.toggle('sprint', isSprint);
      joyBaseEl.classList.toggle('crawl', joyTier === 'crawl');
    }
  } else {
    // Explicitly clear derived keys so a released/interrupted joystick cannot keep moving.
    keys['KeyW'] = keys['KeyS'] = keys['KeyA'] = keys['KeyD'] = false;
    const w = (typeof curW === 'function') ? curW() : null;
    const wType = w ? w.type : '';
    const adsVal = typeof adsAmount === 'number' ? adsAmount : 0;
    const isSteady = CORE.isMobileSteadyAim(touchState.ads, adsVal, wType, touchState.moveX, touchState.moveZ);
    keys['ShiftLeft'] = isSteady;
    if (joyBaseEl) {
      joyBaseEl.classList.remove('sprint');
      joyBaseEl.classList.remove('crawl');
    }
    window.__analogMove = null;
  }
  // firing: mirror the touch button every frame so release cannot latch automatic fire
  mouse1Down = touchState.firing || touchState.tapFiring;
  touchState.tapFiring = false;
  // ADS
  keys['Mouse2'] = touchState.ads || (mouse1Down && getSetting('fireMode') === 'ads + fire');
  // look: drag deltas feed the same accumulators the mouse uses
  mouseX += touchState.lookX; mouseY += touchState.lookY;
  touchState.lookX = 0; touchState.lookY = 0;

  // Stance / slide button tactical feedback
  updateTouchSlideBtn();
  // Melee strike readiness and cooldown feedback
  updateTouchMeleeBtn();
  // ADS / scoped optical indicator
  updateTouchAdsBtn();
  // Jump airborne availability indicator
  updateTouchJumpBtn();
  // Pause button feedback and state
  updateTouchPauseBtn();
}

let tbtnSlideEl = null;
let _touchSlideCache = { slideState: '', slideLabel: 'SLIDE' };
function updateTouchSlideBtn() {
  if (!tbtnSlideEl) tbtnSlideEl = document.getElementById('tbtn-slide');
  if (!tbtnSlideEl || typeof player === 'undefined') return;
  const isSprint = CORE.isAutoSprint(touchState.moveX, touchState.moveZ, touchState.ads);
  const isDowned = !!player.downed;
  const slideState = CORE.touchSlideState(!!player.sliding, !!player.crouching, isSprint, isDowned);
  const slideLabel = CORE.touchSlideLabel(!!player.sliding, !!player.crouching, isDowned);
  if (!CORE.touchSlideChanged(_touchSlideCache, slideState, slideLabel)) return;
  CORE.syncTouchSlideState(_touchSlideCache, slideState, slideLabel);

  tbtnSlideEl.classList.toggle('sliding', slideState === 'sliding');
  tbtnSlideEl.classList.toggle('crouch', slideState === 'crouch');
  tbtnSlideEl.classList.toggle('sprint', slideState === 'sprint');
  tbtnSlideEl.classList.toggle('locked', slideState === 'locked');
  if (tbtnSlideEl.textContent !== slideLabel) tbtnSlideEl.textContent = slideLabel;
}

let tbtnMeleeEl = null;
let _touchMeleeCache = { meleeState: '', meleeLabel: 'KNIFE' };
function updateTouchMeleeBtn() {
  if (!tbtnMeleeEl) tbtnMeleeEl = document.getElementById('tbtn-melee');
  if (!tbtnMeleeEl || typeof player === 'undefined') return;
  const dirX = -Math.sin(player.yaw), dirZ = -Math.cos(player.yaw);
  const targetIdx = (typeof enemies !== 'undefined' && typeof CORE.meleeTarget === 'function')
    ? CORE.meleeTarget(enemies, player.pos.x, player.pos.z, dirX, dirZ, CORE.MELEE_REACH, CORE.MELEE_CONE)
    : -1;
  const cd = typeof meleeT !== 'undefined' ? meleeT : 0;
  const isDowned = !!player.downed;
  const mState = CORE.touchMeleeState(targetIdx >= 0, cd, isDowned);
  const mLabel = CORE.touchMeleeLabel(targetIdx >= 0, cd, isDowned);
  if (!CORE.touchMeleeChanged(_touchMeleeCache, mState, mLabel)) return;
  CORE.syncTouchMeleeState(_touchMeleeCache, mState, mLabel);

  tbtnMeleeEl.classList.toggle('ready', mState === 'ready');
  tbtnMeleeEl.classList.toggle('cooldown', mState === 'cooldown');
  tbtnMeleeEl.classList.toggle('locked', mState === 'locked');
  if (tbtnMeleeEl.textContent !== mLabel) tbtnMeleeEl.textContent = mLabel;
}

let tbtnPauseEl = null;
let _touchPauseCache = { state: '', label: 'II' };
function updateTouchPauseBtn() {
  if (!tbtnPauseEl) tbtnPauseEl = document.getElementById('tbtn-pause');
  if (!tbtnPauseEl) return;
  const isEditing = typeof document !== 'undefined' && document.body && document.body.classList.contains('touch-editing');
  const isDead = typeof player !== 'undefined' && !!(player && player.dead);
  const pState = (typeof CORE !== 'undefined' && typeof CORE.touchPauseState === 'function')
    ? CORE.touchPauseState(started, paused, isDead, isEditing)
    : (isEditing ? 'editing' : (paused ? 'paused' : 'ready'));
  const pLabel = (typeof CORE !== 'undefined' && typeof CORE.touchPauseLabel === 'function')
    ? CORE.touchPauseLabel(pState)
    : 'II';
  if (typeof CORE !== 'undefined' && typeof CORE.touchPauseChanged === 'function') {
    if (!CORE.touchPauseChanged(_touchPauseCache, pState, pLabel)) return;
    CORE.syncTouchPauseState(_touchPauseCache, pState, pLabel);
  }
  tbtnPauseEl.classList.toggle('paused', pState === 'paused');
  tbtnPauseEl.classList.toggle('editing', pState === 'editing');
  tbtnPauseEl.classList.toggle('empty', pState === 'empty' || pState === 'dead');
  tbtnPauseEl.classList.toggle('ready', pState === 'ready');
  if (tbtnPauseEl.textContent !== pLabel) tbtnPauseEl.textContent = pLabel;
}

// ADS button: cyan active glow while aiming, bright scoped ring when sniper/BR scope is locked in,
// golden breath-hold pulse while steadying aim.
let tbtnAdsEl = null;
let _touchAdsCache = { adsState: '', adsLabel: 'ADS' };
function updateTouchAdsBtn() {
  if (!tbtnAdsEl) tbtnAdsEl = document.getElementById('tbtn-ads');
  if (!tbtnAdsEl || typeof adsAmount === 'undefined' || typeof player === 'undefined') return;
  const w = (typeof curW === 'function') ? curW() : null;
  const wType = w ? w.type : '';
  const isSteady = typeof steadyActive === 'boolean' ? steadyActive : false;
  const sT = typeof steadyT === 'number' ? steadyT : 0;
  const adsState = CORE.touchAdsState(adsAmount, wType, CORE.SCOPE_LOCKED_THRESHOLD, isSteady);
  const adsLabel = CORE.touchAdsLabel(adsState, wType, sT);
  if (!CORE.touchAdsChanged(_touchAdsCache, adsState, adsLabel)) return;
  CORE.syncTouchAdsState(_touchAdsCache, adsState, adsLabel);

  tbtnAdsEl.classList.toggle('active', adsState === 'active');
  tbtnAdsEl.classList.toggle('scoped', adsState === 'scoped');
  tbtnAdsEl.classList.toggle('steady', adsState === 'steady');
  if (tbtnAdsEl.textContent !== adsLabel) tbtnAdsEl.textContent = adsLabel;
}

// Jump button: signals kinetic slide-jump BOOST, ledge CLIMB, airborne lockout, or ground JUMP.
let tbtnJumpEl = null;
let _touchJumpCache = { jumpState: '', jumpLabel: 'JUMP' };
function updateTouchJumpBtn() {
  if (!tbtnJumpEl) tbtnJumpEl = document.getElementById('tbtn-jump');
  if (!tbtnJumpEl || typeof player === 'undefined') return;
  const isMantle = typeof player.mantleT === 'number' && player.mantleT > 0;
  const isSliding = !!player.sliding;
  const isDowned = !!player.downed;
  const isStunned = typeof player.landStunT === 'number' && player.landStunT > 0;
  const isCrouch = !!player.crouching;
  const jState = CORE.touchJumpState(!!player.onGround, isSliding, isMantle, isDowned, isStunned);
  const jLabel = CORE.touchJumpLabel(jState, isCrouch);
  if (!CORE.touchJumpChanged(_touchJumpCache, jState, jLabel)) return;
  CORE.syncTouchJumpState(_touchJumpCache, jState, jLabel);

  tbtnJumpEl.classList.toggle('airborne', jState === 'airborne');
  tbtnJumpEl.classList.toggle('boost', jState === 'boost');
  tbtnJumpEl.classList.toggle('mantle', jState === 'mantle');
  tbtnJumpEl.classList.toggle('locked', jState === 'locked');
  if (tbtnJumpEl.textContent !== jLabel) tbtnJumpEl.textContent = jLabel;
}
