'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/25_touch.js'), 'utf8');
const head = fs.readFileSync(path.join(__dirname, '../src/00_head.html'), 'utf8');
const CORE = require('../src/01_core.js');

// Minimal event/DOM host: execute the production touch listeners, not copies of their rules.
function host(touch = true) {
  const elements = new Map(), timers = new Map();
  let clock = 0, timerId = 0;
  class Element {
    constructor(id = '') {
      this.id = id; this.listeners = {}; this.style = {}; this.dataset = {}; this.attrs = {};
      this.classes = new Set();
      this.classList = { add: (...c) => c.forEach(x => this.classes.add(x)), remove: (...c) => c.forEach(x => this.classes.delete(x)), contains: c => this.classes.has(c), toggle: (c, on) => on ? this.classes.add(c) : this.classes.delete(c) };
    }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<(?:div|button|span|input)[^>]*id="([^"]+)"[^>]*>/g)) {
        const el = new Element(match[1]);
        for (const a of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) el.attrs[a[1]] = a[2];
        el.textContent = (html.slice(match.index + match[0].length).match(/^([^<]*)/) || [,''])[1];
        elements.set(el.id, el);
      }
    }
    get innerHTML() { return this.html; }
    appendChild(el) { elements.set(el.id, el); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    getBoundingClientRect() { return { left: 20, top: 100, width: 112, height: 112 }; }
    querySelector(selector) { return elements.get(selector.slice(1)); }
    remove() { elements.delete(this.id); }
    emit(type, touches = []) {
      const e = { type, changedTouches: touches, currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} };
      for (const fn of [...(this.listeners[type] || [])]) fn(e);
    }
  }
  const win = new Element(), document = new Element(); document.body = new Element();
  document.createElement = () => new Element(); document.getElementById = id => elements.get(id) || null;
  document.querySelectorAll = () => [...elements.values()].filter(el => el.id.startsWith('tbtn-') || el.id === 'joy-base');
  const settings = { touchSensitivity: 1, fireLook: true, fireMode: 'fire only' };
  const ctx = vm.createContext({ IS_TOUCH: touch, CORE, document, window: win, innerWidth: 800, innerHeight: 400,
    addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => clock }, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, at: clock + ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    getSetting: k => settings[k], playSound() {}, cycleWeapon() {}, pauseGame() {}, buildSettingsUI() {},
    keys: {}, pressed: {}, mouse1Down: false, mouseX: 0, mouseY: 0, started: true, paused: false, player: undefined,
    clearInputState() { ctx.mouse1Down = false; for (const k in ctx.keys) delete ctx.keys[k]; for (const k in ctx.pressed) delete ctx.pressed[k]; }
  });
  vm.runInContext(source, ctx);
  return { ctx, elements, win, document, settings, run: code => vm.runInContext(code, ctx),
    advance(ms) { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); } } };
}
const finger = (identifier, clientX = 80, clientY = 160) => ({ identifier, clientX, clientY });

test('transparent controls have no expensive paint effects and keep minimum hitboxes', () => {
  const css = head.slice(head.indexOf('/* ---- Touch UI'), head.indexOf('/* Right-hand cluster.'));
  assert.match(css, /\.tbtn\{[^}]*background:transparent/);
  assert.match(css, /\.tbtn\{[^}]*min-width:44px;min-height:44px/);
  assert.match(css, /\.tbtn::before\{[^}]*content:''/);
  assert.doesNotMatch(head.slice(head.indexOf('/* ---- Touch UI'), head.indexOf('body.touch #score-hud')), /(?:box-shadow|backdrop-filter|filter):/);
});

test('generated PNG atlas is embedded byte-for-byte and every action keeps an accessible label', () => {
  const atlas = head.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  assert.ok(atlas, 'generated atlas must be embedded for offline play');
  assert.deepEqual(Buffer.from(atlas[1], 'base64'), fs.readFileSync(path.join(__dirname, '../assets/ui/mobile/controls-atlas.png')));
  const h = host();
  for (const el of h.elements.values()) if (el.id.startsWith('tbtn-')) {
    assert.ok(el.getAttribute('aria-label'), `${el.id} needs an accessible name`);
    assert.equal(el.getAttribute('role'), 'button');
    assert.match(head, new RegExp('body\\.touch #' + el.id + '::before\\{background-position:'));
    el.textContent = 'NEW HUD STATE'; // pseudo-elements survive existing HUD/settings writers
  }
});

test('quick fire tap is sampled once, while cancellation produces no shot', () => {
  const h = host(), el = h.elements.get('tbtn-fire');
  el.emit('touchstart', [finger(1)]); el.emit('touchend', [finger(1)]);
  h.run('applyTouchInput()'); assert.equal(h.ctx.mouse1Down, true);
  h.run('applyTouchInput()'); assert.equal(h.ctx.mouse1Down, false);
  el.emit('touchstart', [finger(2)]); el.emit('touchcancel', [finger(2)]);
  h.run('applyTouchInput()'); assert.equal(h.ctx.mouse1Down, false);
});

test('fire-and-look, separate look and movement coexist and unrelated releases do not interrupt them', () => {
  const h = host();
  h.elements.get('joy-base').emit('touchstart', [finger(1, 76, 106)]);
  h.elements.get('look-zone').emit('touchstart', [finger(2, 300, 160)]);
  h.elements.get('tbtn-fire').emit('touchstart', [finger(3, 700, 160)]);
  h.win.emit('touchmove', [finger(2, 310, 163), finger(3, 720, 167)]);
  h.win.emit('touchend', [finger(99)]);
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, true); assert.equal(h.ctx.mouseX, 30); assert.equal(h.ctx.mouseY, 10);
  assert.equal(h.ctx.keys.KeyW, true);
  h.win.emit('touchend', [finger(1), finger(2), finger(3)]); h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, false); assert.equal(h.ctx.keys.KeyW, false);
  h.settings.fireLook = false;
  h.elements.get('tbtn-fire').emit('touchstart', [finger(4, 600, 100)]);
  h.win.emit('touchmove', [finger(4, 650, 150)]); h.run('applyTouchInput()');
  assert.equal(h.ctx.mouseX, 30); assert.equal(h.ctx.mouseY, 10);
});

test('dedicated ADS remains held when ADS+fire is released, and fire ADS survives dedicated release', () => {
  const h = host(); h.settings.fireMode = 'ads + fire';
  const ads = h.elements.get('tbtn-ads'), fire = h.elements.get('tbtn-fire');
  ads.emit('touchstart', [finger(1)]); fire.emit('touchstart', [finger(2)]);
  h.run('applyTouchInput()'); h.advance(60); fire.emit('touchend', [finger(2)]);
  h.run('applyTouchInput()'); assert.equal(h.ctx.keys.Mouse2, true);
  fire.emit('touchstart', [finger(3)]); ads.emit('touchend', [finger(1)]);
  h.run('applyTouchInput()'); assert.equal(h.ctx.keys.Mouse2, true);
  fire.emit('touchend', [finger(3)]); h.run('applyTouchInput()'); assert.equal(h.ctx.keys.Mouse2, false);
});

test('quick ADS+fire tap retains ADS for its sampled shot only', () => {
  const h = host(); h.settings.fireMode = 'ads + fire';
  const fire = h.elements.get('tbtn-fire');
  fire.emit('touchstart', [finger(1)]); fire.emit('touchend', [finger(1)]);
  h.run('applyTouchInput()'); assert.equal(h.ctx.mouse1Down, true); assert.equal(h.ctx.keys.Mouse2, true);
  h.run('applyTouchInput()'); assert.equal(h.ctx.mouse1Down, false); assert.equal(h.ctx.keys.Mouse2, false);
});

test('hold keys have multi-finger ownership and cancel immediately without minimum-hold timers', () => {
  const h = host(), el = h.elements.get('tbtn-slide');
  el.emit('touchstart', [finger(1), finger(2)]);
  el.emit('touchend', [finger(1)]); assert.equal(h.ctx.keys.KeyC, true);
  el.emit('touchcancel', [finger(2)]); assert.equal(h.ctx.keys.KeyC, false);
  el.emit('touchstart', [finger(3)]); el.emit('touchend', [finger(3)]); assert.equal(h.ctx.keys.KeyC, false);
  h.advance(100); assert.equal(h.ctx.keys.KeyC, false);
});

for (const event of ['blur', 'pagehide', 'visibilitychange']) test(`${event} clears all touch channels and ownership`, () => {
  const h = host();
  h.elements.get('joy-base').emit('touchstart', [finger(1, 76, 106)]);
  h.elements.get('tbtn-fire').emit('touchstart', [finger(2)]);
  h.elements.get('tbtn-ads').emit('touchstart', [finger(3)]);
  h.elements.get('tbtn-nade').emit('touchstart', [finger(4)]);
  h.elements.get('look-zone').emit('touchstart', [finger(5)]);
  h.win.emit('touchmove', [finger(5, 90, 170)]);
  if (event === 'visibilitychange') { h.document.hidden = true; h.document.emit(event); } else h.win.emit(event);
  h.run('applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, false); assert.equal(h.ctx.keys.Mouse2, false);
  assert.equal(h.ctx.keys.KeyW, false); assert.equal(h.ctx.keys.KeyG, false);
  assert.equal(h.ctx.mouseX, 0); assert.equal(h.ctx.mouseY, 0);
  assert.equal(h.elements.get('tbtn-fire').classList.contains('on'), false);
  h.elements.get('tbtn-fire').emit('touchstart', [finger(10)]); assert.equal(h.run('touchState.firing'), true);
});

test('paused gameplay and layout editing cannot start gameplay controls', () => {
  const h = host();
  for (const editing of [false, true]) {
    h.ctx.paused = !editing; h.document.body.classList.toggle('touch-editing', editing);
    h.elements.get('tbtn-fire').emit('touchstart', [finger(1)]);
    h.elements.get('joy-base').emit('touchstart', [finger(2, 76, 106)]);
    h.elements.get('tbtn-nade').emit('touchstart', [finger(3)]);
    assert.equal(h.run('touchState.firing'), false); assert.equal(h.run('touchState.moveZ'), 0);
    assert.notEqual(h.ctx.keys.KeyG, true);
  }
});

test('movement updates reuse the analog vector instead of allocating per frame', () => {
  const h = host(); h.elements.get('joy-base').emit('touchstart', [finger(1, 76, 106)]);
  h.run('applyTouchInput()'); const vector = h.win.__analogMove;
  h.win.emit('touchmove', [finger(1, 96, 116)]); h.run('applyTouchInput()');
  assert.equal(h.win.__analogMove, vector); assert.ok(vector.x > 0);
});

test('existing clearInputState resets ownership as well as keys, permitting a fresh fire touch', () => {
  const h = host();
  h.elements.get('tbtn-fire').emit('touchstart', [finger(1)]);
  h.elements.get('tbtn-jump').emit('touchstart', [finger(2)]);
  h.run('clearInputState(); applyTouchInput()');
  assert.equal(h.ctx.mouse1Down, false); assert.notEqual(h.ctx.pressed.Space, true);
  h.elements.get('tbtn-fire').emit('touchstart', [finger(3)]);
  assert.equal(h.run('touchState.firing'), true);
});

test('stored positions and sizes apply without changing persistence schema; editor resets held controls', () => {
  const h = host();
  h.ctx.localStorage.getItem = key => {
    assert.equal(key, 'blackout.touch-layout.v1');
    return JSON.stringify({ 'tbtn-fire': { left: 60, top: 30, size: 90 } });
  };
  h.run('applyTouchLayoutPositions()');
  const fire = h.elements.get('tbtn-fire');
  assert.equal(fire.style.left, '60%'); assert.equal(fire.style.top, '30%'); assert.equal(fire.style.width, '90px');
  fire.emit('touchstart', [finger(1)]); h.run('openTouchLayoutEditor()');
  assert.equal(h.run('touchState.firing'), false); assert.equal(h.document.body.classList.contains('touch-editing'), true);
});

test('desktop path installs no touch UI and does not overwrite desktop input', () => {
  const h = host(false); h.ctx.keys.KeyW = true; h.ctx.mouse1Down = true;
  h.run('applyTouchInput()'); assert.equal(h.elements.size, 0); assert.equal(h.ctx.keys.KeyW, true); assert.equal(h.ctx.mouse1Down, true);
});

test('mobile touch layout sanitization clamps invalid sizes, bounds coordinates, and limits look delta jumps', () => {
  const h = host();
  // Corrupted layout data: size too large, negative left, top > 100%, unknown controls
  h.ctx.localStorage.getItem = key => {
    assert.equal(key, 'blackout.touch-layout.v1');
    return JSON.stringify({
      'tbtn-fire': { left: -25, top: 125, size: 300 },
      'tbtn-ads': { left: 45.678, top: 55.432, size: 20 },
      'malicious-script': { left: 50, top: 50, size: 72 }
    });
  };
  h.run('applyTouchLayoutPositions()');
  const fire = h.elements.get('tbtn-fire');
  assert.equal(fire.style.left, '0%');
  assert.equal(fire.style.top, '100%');
  assert.equal(fire.style.width, '150px'); // clamped to max 150px

  const ads = h.elements.get('tbtn-ads');
  assert.equal(ads.style.left, '45.68%');
  assert.equal(ads.style.top, '55.43%');
  assert.equal(ads.style.width, '44px');  // clamped to min 44px

  // Look delta clamping
  assert.equal(CORE.touchLookDelta(200, 0, 1, 180), 180);
  assert.equal(CORE.touchLookDelta(-300, 0, 1, 180), -180);
  assert.equal(CORE.touchLookDelta(50, 0, 1.5, 180), 75);

  // Gameplay enabled and pause gating
  assert.equal(CORE.isTouchGameplayEnabled(true, false, false, false), true);
  assert.equal(CORE.isTouchGameplayEnabled(false, false, false, false), false);
  assert.equal(CORE.isTouchGameplayEnabled(true, true, false, false), false);
  assert.equal(CORE.isTouchGameplayEnabled(true, false, true, false), false);
  assert.equal(CORE.isTouchGameplayEnabled(true, false, false, true), false);

  assert.equal(CORE.canTouchPause(true, false, false, false), true);
  assert.equal(CORE.canTouchPause(true, false, false, true), false);
  assert.equal(CORE.canTouchPause(true, true, false, false), false);
  assert.equal(CORE.canTouchPause(true, false, true, false), false);
});
