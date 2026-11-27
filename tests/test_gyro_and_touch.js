'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = require('../src/01_core.js');
const touchSrc = fs.readFileSync(path.join(__dirname, '../src/25_touch.js'), 'utf8');

function touchHost(opts = {}) {
  const elements = new Map();
  const winListeners = {};
  const docListeners = {};
  const timers = new Map();
  let timerId = 0;
  let nowMs = 1000;

  class Element {
    constructor(id = '') {
      this.id = id; this.listeners = {}; this.style = {}; this.dataset = {}; this.attrs = {};
      this.classes = new Set();
      this.classList = {
        add: (...c) => c.forEach(x => this.classes.add(x)),
        remove: (...c) => c.forEach(x => this.classes.delete(x)),
        contains: c => this.classes.has(c),
        toggle: (c, on) => (on === undefined ? (this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c)) : (on ? this.classes.add(c) : this.classes.delete(c)))
      };
    }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<(?:div|button|span|input)[^>]*id="([^"]+)"[^>]*>/g)) {
        const el = new Element(match[1]);
        for (const a of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) el.attrs[a[1]] = a[2];
        el.textContent = (html.slice(match.index + match[0].length).match(/^([^<]*)/) || [, ''])[1];
        elements.set(el.id, el);
      }
    }
    get innerHTML() { return this.html; }
    appendChild(el) { elements.set(el.id, el); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    getBoundingClientRect() { return { left: 20, top: 100, width: 112, height: 112 }; }
    querySelector(sel) { return elements.get(sel.slice(1)); }
    emit(type, payload = {}) {
      const e = Object.assign({ type, changedTouches: [], currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, payload);
      for (const fn of [...(this.listeners[type] || [])]) fn(e);
    }
  }

  const orientationListeners = [];
  const orientationObj = {
    angle: opts.angle ?? 90,
    addEventListener(type, fn) { if (type === 'change') orientationListeners.push(fn); },
    removeEventListener(type, fn) {
      const idx = orientationListeners.indexOf(fn);
      if (idx >= 0) orientationListeners.splice(idx, 1);
    },
    emitChange(newAngle) {
      orientationObj.angle = newAngle;
      for (const fn of [...orientationListeners]) fn();
    }
  };

  const win = {
    isSecureContext: opts.secure !== false,
    screen: { orientation: orientationObj },
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter(f => f !== fn); },
    emit(type, payload = {}) {
      const e = Object.assign({ type, changedTouches: [], preventDefault() {} }, payload);
      for (const fn of [...(winListeners[type] || [])]) fn(e);
    }
  };
  if (opts.hasDeviceOrientation !== false) {
    function DeviceOrientationEvent() {}
    if (opts.requestPermission) DeviceOrientationEvent.requestPermission = opts.requestPermission;
    win.DeviceOrientationEvent = DeviceOrientationEvent;
  }

  const doc = new Element();
  doc.body = new Element();
  doc.hidden = false;
  doc.createElement = () => new Element();
  doc.getElementById = id => elements.get(id) || null;
  doc.querySelectorAll = () => [...elements.values()].filter(el => el.id.startsWith('tbtn-') || el.id === 'joy-base');
  doc.addEventListener = (t, fn) => { (docListeners[t] ||= []).push(fn); };
  doc.emit = (t) => { for (const fn of [...(docListeners[t] || [])]) fn({ type: t }); };

  const settings = Object.assign({
    touchSensitivity: 1,
    fireLook: true,
    fireMode: 'fire',
    gyroAim: 'off',
    gyroSensitivity: 1.0,
    gyroAdsSensitivity: 0.5,
  }, opts.settings || {});

  const ctx = vm.createContext({
    IS_TOUCH: opts.touch !== false,
    CORE,
    document: doc,
    window: win,
    DeviceOrientationEvent: win.DeviceOrientationEvent,
    innerWidth: 800,
    innerHeight: 360,
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => nowMs },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, at: nowMs + ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    getSetting: k => settings[k],
    playSound() {},
    cycleWeapon() {},
    pauseGame() { ctx.paused = true; },
    buildSettingsUI() {},
    updateGyroStatusUI() {},
    keys: {},
    pressed: {},
    mouse1Down: false,
    mouseX: 0,
    mouseY: 0,
    started: true,
    paused: false,
    player: { pos: { x: 0, y: 1.7, z: 0 }, yaw: 0, dead: false, downed: false, crouching: false, sliding: false, onGround: true, mantleT: 0, landStunT: 0 },
    clearInputState() { ctx.mouse1Down = false; for (const k in ctx.keys) delete ctx.keys[k]; for (const k in ctx.pressed) delete ctx.pressed[k]; }
  });
  vm.runInContext(touchSrc, ctx);
  return {
    ctx, elements, win, doc, settings, orientationObj,
    run: code => vm.runInContext(code, ctx),
    advance(ms) { nowMs += ms; for (const [id, t] of [...timers]) if (t.at <= nowMs) { timers.delete(id); t.fn(); } },
    setNow(ms) { nowMs = ms; }
  };
}

test('gyro settings schema supports Off / ADS only / Always on with separate hip and ADS sensitivities and legacy migration', () => {
  const def = CORE.defaultSettings();
  assert.equal(def.gyroAim, 'off');
  assert.deepEqual(CORE.SETTINGS_SCHEMA.gyroAim.values, ['off', 'ads', 'always']);
  assert.equal(def.gyroSensitivity, 1.0);
  assert.ok(def.gyroAdsSensitivity > 0 && def.gyroAdsSensitivity < def.gyroSensitivity);

  // Old boolean saves migrate cleanly
  assert.equal(CORE.sanitizeSettings({ gyroAim: true }).gyroAim, 'always');
  assert.equal(CORE.sanitizeSettings({ gyroAim: 'true' }).gyroAim, 'always');
  assert.equal(CORE.sanitizeSettings({ gyroAim: false }).gyroAim, 'off');
  assert.equal(CORE.sanitizeSettings({ gyroAim: 'ads' }).gyroAim, 'ads');

  // Legacy single gyroSensitivity migrates into both hip and proportional ADS sensitivity when ADS key absent
  const migrated = CORE.sanitizeSettings({ gyroAim: true, gyroSensitivity: 2.0 });
  assert.equal(migrated.gyroAim, 'always');
  assert.equal(migrated.gyroSensitivity, 2.0);
  assert.ok(Math.abs(migrated.gyroAdsSensitivity - 1.3) < 1e-6);

  // Explicit saved gyroAdsSensitivity is preserved independently of gyroSensitivity
  const explicit = CORE.sanitizeSettings({ gyroAim: 'ads', gyroSensitivity: 2.5, gyroAdsSensitivity: 0.4 });
  assert.equal(explicit.gyroSensitivity, 2.5);
  assert.equal(explicit.gyroAdsSensitivity, 0.4);
});

test('gyro ADS-only vs Always-on, separate sensitivities, both landscape orientations, and rebaseline after inactive/rotation', async () => {
  const h = touchHost({ angle: 90, settings: { gyroAim: 'ads', gyroSensitivity: 2.0, gyroAdsSensitivity: 0.5 } });
  h.run("setGyroAimEnabled('ads')");
  await Promise.resolve();
  assert.equal(h.run('gyroEnabled'), true);

  // Hipfire in ADS-only mode: orientation events must not move camera
  h.win.emit('deviceorientation', { beta: 10, gamma: 20 });
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 15, gamma: 30 });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0);
  assert.equal(h.ctx.mouseY, 0);

  // Enter ADS: first event after inactive period MUST rebaseline (no jump!)
  h.elements.get('tbtn-ads').emit('touchstart', { changedTouches: [{ identifier: 1, clientX: 600, clientY: 200 }] });
  h.run('applyTouchInput()');
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 45, gamma: 60 }); // huge jump from 15,30 -> must be baseline!
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0, 'first sample after entering ADS must rebaseline without jump');
  assert.equal(h.ctx.mouseY, 0);

  // Next sample moves using gyroAdsSensitivity (0.5), NOT hipfire sensitivity (2.0)
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 47, gamma: 64 });
  h.run('applyTouchInput()');
  assert.ok(Math.abs(h.ctx.mouseX - (-2 * 0.5 * 7)) < 1e-4);
  assert.ok(Math.abs(h.ctx.mouseY - (-4 * 0.5 * 7)) < 1e-4);

  // Release ADS, tilt phone, re-enter ADS -> rebaseline prevents jump
  h.ctx.mouseX = 0; h.ctx.mouseY = 0;
  h.elements.get('tbtn-ads').emit('touchend', { changedTouches: [{ identifier: 1, clientX: 600, clientY: 200 }] });
  h.run('applyTouchInput()');
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 80, gamma: 90 });
  h.elements.get('tbtn-ads').emit('touchstart', { changedTouches: [{ identifier: 2, clientX: 600, clientY: 200 }] });
  h.run('applyTouchInput()');
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 10, gamma: 10 });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0, 're-entering ADS must rebaseline');

  // Switch to Always on and verify hip sensitivity (2.0), then rotate 90 -> 270 and verify rebaseline + flipped landscape axis
  h.elements.get('tbtn-ads').emit('touchend', { changedTouches: [{ identifier: 2, clientX: 600, clientY: 200 }] });
  h.settings.gyroAim = 'always';
  h.run("setGyroAimEnabled('always')");
  await Promise.resolve();
  h.run('applyTouchInput()');
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 10, gamma: 10 });
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 12, gamma: 14 });
  h.run('applyTouchInput()');
  assert.ok(Math.abs(h.ctx.mouseX - (-2 * 2.0 * 7)) < 1e-4);
  assert.ok(Math.abs(h.ctx.mouseY - (-4 * 2.0 * 7)) < 1e-4);

  // Rotate from 90 to 270: first event after rotation must rebaseline, next event uses 270 orientation sign
  h.ctx.mouseX = 0; h.ctx.mouseY = 0;
  h.orientationObj.emitChange(270);
  h.advance(16);
  h.win.emit('deviceorientation', { beta: -12, gamma: -14 });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0, 'rotation between 90 and 270 must rebaseline');
  h.advance(16);
  h.win.emit('deviceorientation', { beta: -10, gamma: -10 }); // betaDelta=+2, gammaDelta=+4
  h.run('applyTouchInput()');
  assert.ok(Math.abs(h.ctx.mouseX - (2 * 2.0 * 7)) < 1e-4);
  assert.ok(Math.abs(h.ctx.mouseY - (4 * 2.0 * 7)) < 1e-4);
});

test('gyro reports permission denial, unavailable sensor, and no-sensor timeout gracefully without crashing', async () => {
  // Permission denied
  const denied = touchHost({
    requestPermission: () => Promise.resolve('denied'),
    settings: { gyroAim: 'always' }
  });
  denied.run("setGyroAimEnabled('always')");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(denied.run('gyroEnabled'), false);
  assert.equal(denied.run('gyroStatus'), 'denied');

  // Missing DeviceOrientationEvent
  const noApi = touchHost({ hasDeviceOrientation: false, settings: { gyroAim: 'always' } });
  noApi.run("setGyroAimEnabled('always')");
  assert.equal(noApi.run('gyroEnabled'), false);
  assert.equal(noApi.run('gyroStatus'), 'unsupported');

  // Permission granted, but hardware sends zero events -> transitions to no-sensor
  const silent = touchHost({ settings: { gyroAim: 'always' } });
  silent.run("setGyroAimEnabled('always')");
  await Promise.resolve();
  assert.equal(silent.run('gyroStatus'), 'waiting');
  silent.advance(1600);
  assert.equal(silent.run('gyroStatus'), 'no-sensor');
});

test('gyro independent X/Y multipliers, inversion, and zero-lag jitter/drift/lifecycle suppression', async () => {
  const def = CORE.defaultSettings();
  assert.equal(def.gyroSensitivityX, 1.0);
  assert.equal(def.gyroSensitivityY, 1.0);
  assert.equal(def.gyroInvertX, false);
  assert.equal(def.gyroInvertY, false);
  assert.equal(CORE.settingTab('gyroSensitivityX'), 'touch');
  assert.equal(CORE.settingTab('gyroInvertY'), 'touch');

  const h = touchHost({
    angle: 90,
    settings: {
      gyroAim: 'always',
      gyroSensitivity: 1.0,
      gyroSensitivityX: 1.5,
      gyroSensitivityY: 0.5,
      gyroInvertX: true,
      gyroInvertY: true,
    }
  });
  h.run("setGyroAimEnabled('always')");
  await Promise.resolve();

  // Baseline sample
  h.win.emit('deviceorientation', { beta: 30, gamma: 40 });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0);
  assert.equal(h.ctx.mouseY, 0);

  // Micro-jitter (+/-0.02 deg) produces zero output
  h.advance(16); h.win.emit('deviceorientation', { beta: 30.02, gamma: 39.98 });
  h.advance(16); h.win.emit('deviceorientation', { beta: 29.99, gamma: 40.02 });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0);
  assert.equal(h.ctx.mouseY, 0);

  // Slow steady drift (0.005 deg over 16ms = 0.31 deg/s) is absorbed without accumulating into a tick
  for (let i = 1; i <= 10; i++) {
    h.advance(16);
    h.win.emit('deviceorientation', { beta: 30 + i * 0.005, gamma: 40 + i * 0.005 });
  }
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0);
  assert.equal(h.ctx.mouseY, 0);

  // Real movement passes through 1:1 with zero lag, independent X/Y scaling and inversion
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 32.05, gamma: 44.05 }); // +2.0 deg beta, +4.0 deg gamma from absorbed 30.05/40.05
  h.run('applyTouchInput()');
  assert.ok(Math.abs(h.ctx.mouseX - (2 * 1.5 * 7)) < 1e-3, 'X multiplier + invertX flipped sign and scaled 1.5x');
  assert.ok(Math.abs(h.ctx.mouseY - (4 * 0.5 * 7)) < 1e-3, 'Y multiplier + invertY flipped sign and scaled 0.5x');

  // Lifecycle blur rebaselines cleanly with zero synthetic movement
  h.ctx.mouseX = 0; h.ctx.mouseY = 0;
  h.win.emit('blur');
  h.advance(16);
  h.win.emit('deviceorientation', { beta: 10, gamma: 10 });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 0);
  assert.equal(h.ctx.mouseY, 0);
});

test('mobile combined ADS+Fire sniper defaults to hold-aim/release-once with hold setting and lifecycle safety', () => {
  const def = CORE.defaultSettings();
  assert.equal(def.sniperAdsFire, 'release');
  assert.deepEqual(CORE.SETTINGS_SCHEMA.sniperAdsFire.values, ['release', 'hold']);
  assert.equal(CORE.settingTab('sniperAdsFire'), 'touch');

  const h = touchHost({ settings: { fireMode: 'ads + fire', sniperAdsFire: 'release' } });
  h.run("var curWeaponType = 'SR'; function curW() { return { type: curWeaponType }; } var adsAmount = 0; function resetTouchWeaponSwitch() { if (typeof cancelTouchSniperFire === 'function') cancelTouchSniperFire(); }");
  const fireBtn = h.elements.get('tbtn-fire');

  // 1) Hold aim -> does NOT fire while held, sets ADS
  fireBtn.emit('touchstart', { changedTouches: [{ identifier: 1, clientX: 700, clientY: 250 }] });
  h.run('applyTouchInput()');
  assert.equal(h.run('touchState.ads && !!keys.Mouse2'), true);
  assert.equal(h.ctx.mouse1Down, false, 'holding ADS+FIRE on sniper must not fire while held');

  // Release -> fires ONCE with ADS active on the release frame
  fireBtn.emit('touchend', { changedTouches: [{ identifier: 1, clientX: 700, clientY: 250 }] });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, true, 'release triggers one shot');
  assert.equal(h.run('!!keys.Mouse2'), true, 'release shot preserves ADS for accurate sniper spread');
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, false, 'only one shot on release');

  // 2) Quick tap before scoped -> still fires once on release
  fireBtn.emit('touchstart', { changedTouches: [{ identifier: 2, clientX: 700, clientY: 250 }] });
  fireBtn.emit('touchend', { changedTouches: [{ identifier: 2, clientX: 700, clientY: 250 }] });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, true, 'quick tap before scoped still fires once on release');
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, false);

  // 3) touchcancel, blur, pause, death, and weapon switch cannot ghost fire
  for (const abortAction of [
    () => fireBtn.emit('touchcancel', { changedTouches: [{ identifier: 3, clientX: 700, clientY: 250 }] }),
    () => h.win.emit('blur'),
    () => h.run('clearInputState()'),
    () => { h.run('player.dead = true; clearInputState(); player.dead = false;'); },
    () => { h.run("curWeaponType = 'AR'; cancelTouchSniperFire();"); fireBtn.emit('touchend', { changedTouches: [{ identifier: 3, clientX: 700, clientY: 250 }] }); h.run("curWeaponType = 'SR'"); }
  ]) {
    fireBtn.emit('touchstart', { changedTouches: [{ identifier: 3, clientX: 700, clientY: 250 }] });
    abortAction();
    h.run('applyTouchInput()');
    assert.equal(h.ctx.mouse1Down, false, 'cancelled/interrupted ADS+FIRE must not ghost fire');
  }

  // 4) Other weapon classes unaffected (AR fires immediately on press in ads+fire mode)
  h.run("curWeaponType = 'AR'");
  fireBtn.emit('touchstart', { changedTouches: [{ identifier: 4, clientX: 700, clientY: 250 }] });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, true, 'AR still fires immediately in ads+fire mode');
  fireBtn.emit('touchend', { changedTouches: [{ identifier: 4, clientX: 700, clientY: 250 }] });

  // 5) sniperAdsFire='hold' retains immediate hold-fire for sniper; fireMode='fire' unaffected
  h.run("curWeaponType = 'SR'");
  h.settings.sniperAdsFire = 'hold';
  fireBtn.emit('touchstart', { changedTouches: [{ identifier: 5, clientX: 700, clientY: 250 }] });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, true, 'sniperAdsFire=hold retains hold-fire');
  fireBtn.emit('touchend', { changedTouches: [{ identifier: 5, clientX: 700, clientY: 250 }] });

  h.settings.sniperAdsFire = 'release';
  h.settings.fireMode = 'fire';
  fireBtn.emit('touchstart', { changedTouches: [{ identifier: 6, clientX: 700, clientY: 250 }] });
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, true, 'standalone FIRE mode unaffected');
});
