'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const CORE = require('../src/01_core.js');
const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
// Only browser/input/audio boundaries are stand-ins. Run the entire shipped
// controller with real config, CORE movement, collision and stamina lifecycle.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, {x, y, z}); return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
}
function harness() {
  const noop = () => {};
  const c = vm.createContext({CORE, THREE: {Vector3}, window: {},
    addEventListener: noop, document: {addEventListener: noop}, canvas: {addEventListener: noop},
    applyTouchInput: noop, getSetting: () => 1, adsAmount: 0, adsDown: () => false,
    enemies: [], colliders: [], mapBounds: 10000, GROUND: 0, gameT: 0,
    curW: () => null, perks: [], playSound: noop, diff: () => ({regen: 1})});
  const config = source('10_config_world.js');
  vm.runInContext(config.slice(config.indexOf('const CFG ='), config.indexOf('const $id =')), c);
  vm.runInContext(source('20_player.js'), c);
  const run = code => vm.runInContext(code, c);
  run('player.onGround = true; keys.KeyW = true; keys.ShiftLeft = true;');
  return {run, step(n, dt = .01) { for (let i = 0; i < n; i++) run(`gameT += ${dt}; updatePlayer(${dt});`); },
    state: () => run('({stamina: player.stamina, exhausted: player.exhausted, sprinting: player.sprinting, tacT: player.tacT, speed: Math.hypot(player.vel.x, player.vel.z)})')};
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }

test('real updatePlayer fully recovers empty stamina in four seconds without overflow', () => {
  const h = harness();
  h.run('player.stamina = 0; player.exhausted = true; keys.ShiftLeft = false;');
  h.step(399);
  near(h.state().stamina, 7.98);
  h.step(1);
  near(h.state().stamina, 8);
  h.step(300);
  near(h.state().stamina, 8);
});

test('held sprint respects exhaustion until twenty percent recovered then resumes next frame', () => {
  const h = harness();
  h.run('player.stamina = 0; player.exhausted = true;');
  h.step(79);
  near(h.state().stamina, 1.58);
  assert.equal(h.state().exhausted, true);
  assert.equal(h.state().sprinting, false);
  h.step(1);
  near(h.state().stamina, 1.6);
  assert.equal(h.state().exhausted, false);
  assert.equal(h.state().sprinting, false, 'recovery frame must not also drain');
  h.step(1);
  assert.equal(h.state().sprinting, true);
  near(h.state().stamina, 1.59);
});

test('tactical sprint retains its burst, speed and 2.2x drain', () => {
  const normal = harness();
  const tac = harness();
  tac.run('lastSprintTap = gameT - .1; pressed.ShiftLeft = true;');
  tac.step(1);
  tac.run('delete pressed.ShiftLeft;');
  tac.step(49);
  normal.step(50);
  near(normal.state().stamina, 7.5);
  near(tac.state().stamina, 6.9);
  near(tac.state().tacT, 2);
  assert.ok(tac.state().speed > normal.state().speed);
  assert.ok(Math.abs(normal.state().speed - 5.4 * 1.65) < .002);
  assert.ok(Math.abs(tac.state().speed - 5.4 * 1.65 * 1.25) < .002);
  tac.step(201);
  near(tac.state().tacT, 0);
  tac.step(50);
  assert.ok(Math.abs(tac.state().speed - normal.state().speed) < .002);
});

test('held sprint repeatedly exhausts and recovers with bounded stamina', () => {
  const h = harness();
  let transitions = 0, previous = false;
  for (let i = 0; i < 4000; i++) {
    h.step(1);
    const s = h.state();
    assert.ok(s.stamina >= 0 && s.stamina <= 8);
    if (s.exhausted && !previous) transitions++;
    previous = s.exhausted;
  }
  assert.ok(transitions >= 3, 'exercise repeated held-key recovery, not only depletion');
});

test('real updatePlayer sustains normal sprint for eight seconds', () => {
  const h = harness();
  h.step(790);
  near(h.state().stamina, .1);
  assert.equal(h.state().sprinting, true);
  assert.equal(h.state().exhausted, false);
  // Floating-point subtraction can shift zero by one frame; allow one timestep.
  h.step(11);
  assert.equal(h.state().sprinting, false);
  assert.equal(h.state().exhausted, true);
});
