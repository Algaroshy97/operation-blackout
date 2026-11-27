'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = require('../src/01_core.js');

test('minimap inverse coordinate projection accurately inverts rotating minimap and rejects out-of-range/invalid targets', () => {
  const R = 75;
  const scale = CORE.minimapScale(R, 90, 8);
  const px = 12.5, pz = -8.25;
  const worldX = 28.0, worldZ = 14.0;
  for (const yaw of [0, 0.72, Math.PI, -1.35, 2.4]) {
    const blip = CORE.minimapBlipOffset(worldX, worldZ, px, pz, scale);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const canvasX = R + (blip.x * cos - blip.z * sin);
    const canvasY = R + (blip.x * sin + blip.z * cos);
    const inv = CORE.minimapScreenToWorld(canvasX, canvasY, R, px, pz, yaw, scale);
    assert.ok(Math.abs(inv.x - worldX) < 1e-6, `yaw=${yaw} worldX round-trip`);
    assert.ok(Math.abs(inv.z - worldZ) < 1e-6, `yaw=${yaw} worldZ round-trip`);
  }

  // Validation: inside disc + within maxRange + within mapBounds -> valid
  const ok = CORE.validateAirstrikeTarget(10, 10, 0, 0, 0.2, 45, 43);
  assert.equal(ok.valid, true);

  // Outside circular minimap corners (discNormSq > 1) -> invalid
  const corner = CORE.validateAirstrikeTarget(10, 10, 0, 0, 1.15, 45, 43);
  assert.equal(corner.valid, false);

  // Out of airstrike range (> maxRange) -> invalid
  const tooFar = CORE.validateAirstrikeTarget(40, 40, -20, -20, 0.5, 45, 43);
  assert.equal(tooFar.valid, false);

  // Outside arena bounds (> mapBounds) -> invalid
  const outBounds = CORE.validateAirstrikeTarget(45, 0, 40, 0, 0.1, 45, 43);
  assert.equal(outBounds.valid, false);
});

test('minimap airstrike freezes target in world coords, does not spend on cancel/reject, and integrates touch/desktop flow', () => {
  const streaksSrc = fs.readFileSync(path.join(__dirname, '../src/58_streaks.js'), 'utf8');
  const elements = new Map();
  const makeEl = (id) => {
    const el = {
      id, style: {}, classList: new Set(), listeners: {}, textContent: '', innerHTML: '',
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      setAttribute() {}, getBoundingClientRect: () => ({ left: 20, top: 20, width: 150, height: 150 })
    };
    el.classList = {
      _s: el.classList,
      add: (...c) => c.forEach(x => el.classList._s.add(x)),
      remove: (...c) => c.forEach(x => el.classList._s.delete(x)),
      toggle: (c, on) => (on === undefined ? (el.classList._s.has(c) ? el.classList._s.delete(c) : el.classList._s.add(c)) : (on ? el.classList._s.add(c) : el.classList._s.delete(c))),
      contains: c => el.classList._s.has(c)
    };
    elements.set(id, el);
    return el;
  };
  ['streak-hud', 'minimap', 'minimap-canvas', 'airstrike-prompt', 'tbtn-streak'].forEach(makeEl);

  const blasts = [];
  const added = [];
  const removed = [];
  const ctx = vm.createContext({
    CORE,
    THREE: {
      Vector3: class Vector3 { constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;} set(x,y,z){this.x=x;this.y=y;this.z=z;return this;} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;} },
      BoxGeometry: class {}, CylinderGeometry: class {}, RingGeometry: class {}, CircleGeometry: class {},
      MeshStandardMaterial: class { constructor(o={}){Object.assign(this,o);} },
      MeshBasicMaterial: class { constructor(o={}){Object.assign(this,o);} },
      Mesh: class { constructor(){ this.position={set(){},copy(){}}; this.rotation={x:0,y:0,z:0}; this.scale={set(){},setScalar(){}}; this.material={opacity:1}; this.visible=true; } },
      Group: class { constructor(){ this.children=[]; this.position={set(){},copy(){}}; this.rotation={y:0}; this.scale={set(){}}; } add(c){this.children.push(c);} },
      DoubleSide: 2
    },
    CFG: { world: { size: 90 } },
    IS_TOUCH: false,
    document: {
      getElementById: id => elements.get(id) || null,
      body: { classList: { toggle() {}, contains: () => false } },
      pointerLockElement: null,
      exitPointerLock() { ctx.pointerLocked = false; }
    },
    canvas: { requestPointerLock() { ctx.pointerLocked = true; } },
    $id: id => elements.get(id) || null,
    scene: { add(m) { added.push(m); }, remove(m) { removed.push(m); } },
    player: { pos: { x: 0, y: 1.7, z: 0 }, yaw: 0.8, dead: false, downed: false, team: 'friendly' },
    enemies: [], colliders: [], pressed: {}, keys: {},
    started: true, paused: false, pointerLocked: true, gameT: 10, runId: 1, mapBounds: 43,
    showCenterMsg() {}, playSound() {}, explodeGrenade(pos) { blasts.push({ x: pos.x, y: pos.y, z: pos.z }); },
    drawMinimap() {}
  });
  vm.runInContext(streaksSrc, ctx);

  // Give player an airstrike
  ctx.awardFreeStreak('airstrike');
  assert.equal(vm.runInContext('streakBank.length', ctx), 1);

  // Activating opens minimap targeting WITHOUT spending streak
  assert.equal(ctx.useStreak(), true);
  assert.equal(ctx.isAirstrikeTargeting(), true);
  assert.equal(vm.runInContext('streakBank.length', ctx), 1, 'airstrike must NOT be spent before target confirmation');
  assert.equal(ctx.pointerLocked, false, 'desktop pointer lock released for minimap click');

  // Cancelling keeps streak unspent
  ctx.cancelAirstrikeTargeting();
  assert.equal(ctx.isAirstrikeTargeting(), false);
  assert.equal(vm.runInContext('streakBank.length', ctx), 1, 'cancelling must not spend airstrike');

  // Re-open, reject out-of-range click (outside minimap circle corner clientX=22, clientY=22)
  ctx.useStreak();
  assert.equal(ctx.confirmAirstrikeMinimapPoint(2, 2, 150, 150), false);
  assert.equal(ctx.isAirstrikeTargeting(), true, 'rejected target keeps targeting open');
  assert.equal(vm.runInContext('streakBank.length', ctx), 1, 'rejected target does not spend streak');

  // Confirm valid target on rotating minimap -> compute exact screen point for world (12, -16) at yaw=0.8
  const scale = CORE.minimapScale(75, 90, 8);
  const blip = CORE.minimapBlipOffset(12, -16, 0, 0, scale);
  const cos = Math.cos(0.8), sin = Math.sin(0.8);
  const cx = 75 + (blip.x * cos - blip.z * sin);
  const cy = 75 + (blip.x * sin + blip.z * cos);
  assert.equal(ctx.confirmAirstrikeMinimapPoint(cx, cy, 150, 150), true);
  assert.equal(ctx.isAirstrikeTargeting(), false);
  assert.equal(vm.runInContext('streakBank.length', ctx), 0, 'confirmed strike spends streak once');

  // Player runs away and turns around AFTER confirmation -> target MUST remain frozen at (12, -16)
  ctx.player.pos.x = -30; ctx.player.pos.z = 30; ctx.player.yaw = -2.1;
  for (let i = 0; i < 40; i++) ctx.updateStreaks(0.1);
  assert.equal(blasts.length, CORE.AIRSTRIKE_BOMB_COUNT);
  const avgX = blasts.reduce((s, b) => s + b.x, 0) / blasts.length;
  const avgZ = blasts.reduce((s, b) => s + b.z, 0) / blasts.length;
  assert.ok(Math.hypot(avgX - 12, avgZ - (-16)) < 8, `bombs landed near frozen world target (12,-16), got (${avgX.toFixed(1)},${avgZ.toFixed(1)})`);
  assert.ok(removed.length > 0, 'telegraph/ordnance meshes cleaned up after completion');
});
