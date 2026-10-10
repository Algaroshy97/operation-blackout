'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/25_touch.js'), 'utf8');
const head = fs.readFileSync(path.join(__dirname, '../src/00_head.html'), 'utf8');
const CORE = require('../src/01_core.js');

test('portrait play requests fullscreen and landscape lock without a rotate-phone gate', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/70_main.js'), 'utf8');
  assert.doesNotMatch(head, /landscape-required|Rotate your device to landscape/);
  assert.match(main, /requestFullscreen/);
  assert.match(main, /orientation\.lock\('landscape'\)/);
});

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

test('v126 mobile UI polish: downed control states, touch editor selection, and streak HUD safe area insets', () => {
  const h = host();
  h.ctx.player = {
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    dead: false,
    downed: true,
    sliding: false,
    crouching: true,
    sprinting: false,
    onGround: true,
    mantleT: 0,
    landStunT: 0
  };
  h.run('applyTouchInput()');
  const slide = h.elements.get('tbtn-slide');
  assert.equal(slide.classList.contains('locked'), true);
  assert.equal(slide.textContent, 'CRAWL');

  const jump = h.elements.get('tbtn-jump');
  assert.equal(jump.classList.contains('locked'), true);
  assert.equal(jump.textContent, 'LOCK');

  const melee = h.elements.get('tbtn-melee');
  assert.equal(melee.classList.contains('locked'), true);
  assert.equal(melee.textContent, 'LOCKED');

  // Touch layout editor selection highlight
  h.run('openTouchLayoutEditor()');
  const fire = h.elements.get('tbtn-fire');
  const ads = h.elements.get('tbtn-ads');
  fire.emit('touchstart', [finger(1)]);
  assert.equal(fire.classList.contains('selected'), true);
  assert.equal(ads.classList.contains('selected'), false);

  ads.emit('touchstart', [finger(2)]);
  assert.equal(ads.classList.contains('selected'), true);
  assert.equal(fire.classList.contains('selected'), false);

  // CSS safe area definitions for streak HUD
  assert.match(head, /body\.touch\s+#streak-hud\{[^}]*var\(--sa-r\)/);
  assert.match(head, /body\.touch-layout-left\s+#streak-hud\{[^}]*var\(--sa-l\)/);
});

test('v131 mobile UI polish: downed equipment, streaks, and station lockout gating rules', () => {
  // Pure player capability gating during downed state
  assert.equal(CORE.canPlayerThrowEquipment(false, true, 2, 0), false);
  assert.equal(CORE.canPlayerThrowEquipment(false, false, 2, 0), true);
  assert.equal(CORE.canPlayerThrowEquipment(false, false, 0, 0), false);
  assert.equal(CORE.canPlayerThrowEquipment(false, false, 2, 1.5), false);
  assert.equal(CORE.canPlayerThrowEquipment(true, false, 2, 0), false);

  assert.equal(CORE.canPlayerUseStreak(false, true, 1), false);
  assert.equal(CORE.canPlayerUseStreak(false, false, 1), true);
  assert.equal(CORE.canPlayerUseStreak(false, false, 0), false);
  assert.equal(CORE.canPlayerUseStreak(true, false, 1), false);

  assert.equal(CORE.canPlayerUseFieldUpgrade(false, true, 100, 100), false);
  assert.equal(CORE.canPlayerUseFieldUpgrade(false, false, 100, 100), true);
  assert.equal(CORE.canPlayerUseFieldUpgrade(false, false, 50, 100), false);

  assert.equal(CORE.canPlayerInteractStation(false, true, true), false);
  assert.equal(CORE.canPlayerInteractStation(false, false, true), true);
  assert.equal(CORE.canPlayerInteractStation(false, false, false), false);

  // Mobile touch equipment button state & label
  assert.equal(CORE.touchEquipmentState(2, false, true), 'locked');
  assert.equal(CORE.touchEquipmentState(2, true, true), 'locked');
  assert.equal(CORE.touchEquipmentState(2, false, false), 'ready');
  assert.equal(CORE.touchEquipmentState(0, false, false), 'empty');
  assert.equal(CORE.touchEquipmentState(2, true, false), 'charging');

  assert.equal(CORE.touchLethalLabel('frag', 2, false, true), 'LOCKED');
  assert.equal(CORE.touchLethalLabel('frag', 2, false, false), 'FRAG');
  assert.equal(CORE.touchTacticalLabel('flash', 2, true), 'LOCKED');
  assert.equal(CORE.touchTacticalLabel('flash', 2, false), 'FLASH');

  // Mobile touch streak button state & label
  assert.equal(CORE.touchStreakState(true, false, true), 'locked');
  assert.equal(CORE.touchStreakState(false, true, true), 'locked');
  assert.equal(CORE.touchStreakState(true, false, false), 'streak');
  assert.equal(CORE.touchStreakState(false, true, false), 'field');
  assert.equal(CORE.touchStreakState(false, false, false), 'empty');

  assert.equal(CORE.touchStreakLabel('uav', false, 0, true), 'LOCKED');
  assert.equal(CORE.touchStreakLabel('uav', false, 0, false), 'UAV');
  assert.equal(CORE.touchStreakLabel(null, true, 0, false), 'BOX');

  // Mobile touch station USE button state & label
  assert.equal(CORE.touchUseState(true, true, false, true), 'locked');
  assert.equal(CORE.touchUseState(true, true, false, false), 'ready');
  assert.equal(CORE.touchUseLabel(true, true, false, 'armory', 'upgrade', true), 'LOCKED');
  assert.equal(CORE.touchUseLabel(true, true, false, 'armory', 'upgrade', false), 'UPGRADE');

  // Change detection for touch USE button with isDowned
  const useInit = { nearStation: null, canAfford: null, isHolding: null, stationKind: null, action: null, isDowned: null };
  assert.equal(CORE.touchUseChanged(useInit, true, true, false, 'wall', 'buy', true), true);
  CORE.syncTouchUseState(useInit, true, true, false, 'wall', 'buy', true);
  assert.equal(useInit.isDowned, true);
  assert.equal(CORE.touchUseChanged(useInit, true, true, false, 'wall', 'buy', true), false);
  assert.equal(CORE.touchUseChanged(useInit, true, true, false, 'wall', 'buy', false), true);

  // CSS locked state definitions in head.html
  assert.match(head, /body\.touch\s+#tbtn-nade\.locked/);
  assert.match(head, /body\.touch\s+#tbtn-tactical\.locked/);
  assert.match(head, /body\.touch\s+#tbtn-streak\.locked/);
  assert.match(head, /body\.touch\s+#tbtn-use\.locked/);
});

test('v136 mobile UI polish: downed weapon swap, ADS lockout gating, and reload state rules', () => {
  // 1. Pure player capability gating
  assert.equal(CORE.canPlayerSwitchWeapon(false, false, false), true);
  assert.equal(CORE.canPlayerSwitchWeapon(true, false, false), false);
  assert.equal(CORE.canPlayerSwitchWeapon(false, true, false), false);
  assert.equal(CORE.canPlayerSwitchWeapon(false, false, true), false);

  assert.equal(CORE.canPlayerAds(false, false, false), true);
  assert.equal(CORE.canPlayerAds(true, false, false), false);
  assert.equal(CORE.canPlayerAds(false, true, false), false);
  assert.equal(CORE.canPlayerAds(false, false, true), false);

  // 2. Mobile touch weapon swap button state & label
  const wList = [{ type: 'AR' }, { type: 'SMG' }];
  assert.equal(CORE.touchSwapState(0, [0, 1], false, true), 'locked');
  assert.equal(CORE.touchSwapState(0, [0, 1], false, false), 'ready');
  assert.equal(CORE.touchSwapState(0, [0, -1], false, false), 'empty');
  assert.equal(CORE.touchSwapState(0, [0, 1], true, false), 'switching');

  assert.equal(CORE.touchSwapLabel(0, [0, 1], wList, false, true), 'LOCKED');
  assert.equal(CORE.touchSwapLabel(0, [0, 1], wList, false, false), 'SMG');
  assert.equal(CORE.touchSwapLabel(0, [0, 1], wList, true, false), 'DRAW');
  assert.equal(CORE.touchSwapLabel(0, [0, -1], wList, false, false), 'SWAP');

  // 3. Mobile touch ADS button state & label
  assert.equal(CORE.touchAdsState(1.0, 'AR', 0.82, false, true), 'locked');
  assert.equal(CORE.touchAdsState(1.0, 'AR', 0.82, false, false), 'active');
  assert.equal(CORE.touchAdsState(1.0, 'SR', 0.82, false, false), 'scoped');
  assert.equal(CORE.touchAdsState(1.0, 'SR', 0.82, true, false), 'steady');
  assert.equal(CORE.touchAdsState(0, 'AR', 0.82, false, false), '');

  assert.equal(CORE.touchAdsLabel('locked', 'AR', 0, true), 'LOCKED');
  assert.equal(CORE.touchAdsLabel('active', 'AR', 0, false), 'AIM');
  assert.equal(CORE.touchAdsLabel('scoped', 'SR', 2.0, false), 'SCOPE');
  assert.equal(CORE.touchAdsLabel('scoped', 'SR', 0, false), 'WAIT');
  assert.equal(CORE.touchAdsLabel('steady', 'SR', 2.0, false), 'STEADY');
  assert.equal(CORE.touchAdsLabel('', 'AR', 0, false), 'ADS');

  // 4. Mobile touch reload button state rules
  assert.equal(CORE.touchReloadState(0, 0, false), '');
  assert.equal(CORE.touchReloadState(0, 60, false), 'urgent');
  assert.equal(CORE.touchReloadState(15, 60, true), 'reloading');
  assert.equal(CORE.touchReloadState(30, 60, false), '');

  // 5. CSS locked state definitions in head.html
  assert.match(head, /body\.touch\s+#tbtn-swap\.locked/);
  assert.match(head, /body\.touch\s+#tbtn-ads\.locked/);
});


