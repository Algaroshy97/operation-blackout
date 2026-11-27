'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = require('../src/01_core.js');
const touchSrc = fs.readFileSync(path.join(__dirname, '../src/25_touch.js'), 'utf8');

test('touch layout opacity and viewport/safe-area rect clamping rules', () => {
  assert.equal(typeof CORE.clampTouchControlOpacity, 'function');
  assert.equal(CORE.clampTouchControlOpacity(0.1), 0.25);
  assert.equal(CORE.clampTouchControlOpacity(1.5), 1);
  assert.equal(CORE.clampTouchControlOpacity(0.65), 0.65);
  assert.equal(CORE.clampTouchControlOpacity('bad'), 1);

  const sanitized = CORE.sanitizeTouchLayout({
    'tbtn-fire': { left: 85, top: 80, size: 120, opacity: 0.4 },
    'tbtn-ads': { left: 50, top: 50, size: 60, opacity: 0.05 }
  });
  assert.equal(sanitized['tbtn-fire'].opacity, 0.4);
  assert.equal(sanitized['tbtn-ads'].opacity, 0.25);

  assert.equal(typeof CORE.clampTouchControlRect, 'function');
  // 800x360 viewport with left cutout 44px, bottom gesture bar 24px, top 10px, right 16px
  const insets = { top: 10, right: 16, bottom: 24, left: 44 };
  // Control 100x100 pushed to top-left (0%, 0%) -> clamped into left=44px (5.5%), top=10px (2.78%)
  const tl = CORE.clampTouchControlRect(0, 0, 100, 100, 800, 360, insets);
  assert.ok(Math.abs(tl.left - 5.5) < 0.05);
  assert.ok(Math.abs(tl.top - 2.78) < 0.05);

  // Control 100x100 pushed to bottom-right (99%, 99%) -> clamped to maxX=800-16-100=684px (85.5%), maxY=360-24-100=236px (65.56%)
  const br = CORE.clampTouchControlRect(99, 99, 100, 100, 800, 360, insets);
  assert.ok(Math.abs(br.left - 85.5) < 0.05);
  assert.ok(Math.abs(br.top - 65.56) < 0.05);
});

test('touch HUD editor supports per-control opacity, resize re-clamping, safe-area bounds, reset, and persistence', () => {
  const elements = new Map();
  const storage = new Map();
  const winListeners = {};
  class Element {
    constructor(id = '') {
      this.id = id; this.listeners = {}; this.style = {}; this.dataset = {}; this.attrs = {};
      this.classes = new Set();
      this.classList = {
        add: (...c) => c.forEach(x => this.classes.add(x)),
        remove: (...c) => c.forEach(x => this.classes.delete(x)),
        contains: c => this.classes.has(c),
        toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c))
      };
    }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<(?:div|button|span|input)[^>]*id="([^"]+)"[^>]*>/g)) {
        const el = new Element(match[1]);
        for (const a of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) el.attrs[a[1]] = a[2];
        elements.set(el.id, el);
      }
    }
    get innerHTML() { return this.html; }
    appendChild(el) { elements.set(el.id, el); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    getBoundingClientRect() {
      const w = parseFloat(this.style.width) || 84;
      const h = parseFloat(this.style.height) || 84;
      const l = this.style.left && this.style.left.endsWith('%') ? (parseFloat(this.style.left) / 100) * 800 : 680;
      const t = this.style.top && this.style.top.endsWith('%') ? (parseFloat(this.style.top) / 100) * 360 : 240;
      return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h };
    }
    querySelector(sel) { return elements.get(sel.slice(1)); }
    remove() { elements.delete(this.id); }
    emit(type, payload = {}) {
      const e = Object.assign({ type, changedTouches: [], currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, payload);
      for (const fn of [...(this.listeners[type] || [])]) fn(e);
    }
  }
  const doc = new Element();
  doc.body = new Element();
  doc.documentElement = new Element();
  doc.createElement = () => new Element();
  doc.getElementById = id => elements.get(id) || null;
  doc.querySelectorAll = () => [...elements.values()].filter(el => el.id.startsWith('tbtn-') || el.id === 'joy-base');

  const ctx = vm.createContext({
    IS_TOUCH: true,
    CORE,
    document: doc,
    window: { addEventListener: (t, f) => (winListeners[t] ||= []).push(f), removeEventListener() {} },
    innerWidth: 800,
    innerHeight: 360,
    getComputedStyle: () => ({ getPropertyValue: k => ({ '--sa-l': '40px', '--sa-r': '20px', '--sa-t': '8px', '--sa-b': '16px' }[k] || '0px') }),
    addEventListener: (t, f) => (winListeners[t] ||= []).push(f),
    removeEventListener: (t, f) => { winListeners[t] = (winListeners[t] || []).filter(x => x !== f); },
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    performance: { now: () => 0 },
    setTimeout() { return 1; },
    clearTimeout() {},
    getSetting: () => 1,
    playSound() {},
    cycleWeapon() {},
    pauseGame() {},
    buildSettingsUI() {},
    keys: {}, pressed: {}, mouse1Down: false, mouseX: 0, mouseY: 0, started: true, paused: false,
    clearInputState() {}, touchSprint: {}, resetSprintInput() {}
  });
  vm.runInContext(touchSrc, ctx);

  vm.runInContext('openTouchLayoutEditor()', ctx);
  const opInput = elements.get('touch-editor-opacity');
  assert.ok(opInput, 'editor must render per-control opacity slider');

  const fire = elements.get('tbtn-fire');
  fire.emit('touchstart', { changedTouches: [{ identifier: 1, clientX: 700, clientY: 260 }] });
  // Drag outside left safe area (clientX=0) -> clamped inside left inset 40px (5%)
  for (const fn of [...(winListeners.touchmove || [])]) fn({ changedTouches: [{ identifier: 1, clientX: 0, clientY: 0 }], preventDefault() {} });
  for (const fn of [...(winListeners.touchend || [])]) fn({ changedTouches: [{ identifier: 1 }], preventDefault() {} });
  assert.ok(parseFloat(fire.style.left) >= 5, `left ${fire.style.left} must respect safe-area inset 40px (5%)`);
  assert.ok(parseFloat(fire.style.top) >= 2.2, `top ${fire.style.top} must respect safe-area inset 8px (2.22%)`);

  // Set opacity to 0.55 and save
  opInput.value = '0.55';
  opInput.emit('input', { target: opInput });
  assert.equal(fire.style.opacity, '0.55');
  elements.get('touch-editor-done').emit('click');

  const saved = JSON.parse(storage.get('blackout.touch-layout.v1'));
  assert.equal(saved['tbtn-fire'].opacity, 0.55);

  // Reset clears opacity too
  vm.runInContext('openTouchLayoutEditor()', ctx);
  elements.get('touch-editor-reset').emit('click');
  assert.equal(fire.style.opacity, '');
  assert.equal(storage.has('blackout.touch-layout.v1'), false);
});
