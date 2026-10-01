'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CORE = require('../src/01_core.js');
const source = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('cell centres reuse caller-owned steering output without changing legacy allocating API', () => {
  const nav = CORE.buildNavGrid([], { cell: 2, halfExtent: 10 });
  const out = { x: 99, z: 99 };
  const expected = CORE.cellCenter(nav, 17);
  assert.equal(CORE.cellCenter(nav, 17, out), out);
  assert.deepEqual(out, expected);
  assert.notEqual(CORE.cellCenter(nav, 17), CORE.cellCenter(nav, 17));
});

function flowHarness() {
  let floods = 0;
  const context = vm.createContext({
    CORE: { ...CORE, computeFlowField(...args) { floods++; return CORE.computeFlowField(...args); } },
    player: { pos: { x: 0.1, z: 0.1 } }, navGrid: CORE.buildNavGrid([], { halfExtent: 46 })
  });
  const text = source('40_enemies.js');
  vm.runInContext(text.slice(text.indexOf('let flowT ='), text.indexOf('// Reusable output object')), context);
  return { context, step: dt => context.updateFlowField(dt), floods: () => floods };
}

test('stationary/sub-cell movement reuses identical navigation flood while cell crossing and grid rebuild refresh immediately', () => {
  const h = flowHarness();
  h.step(0.016);
  const initial = Array.from(h.context.navGrid.dist);
  for (let i = 0; i < 120; i++) {
    h.context.player.pos.x = 0.1 + (i % 8) * 0.1;
    h.step(1 / 60);
  }
  assert.equal(h.floods(), 1, 'unchanged target cell should not repeat full-grid BFS');
  assert.deepEqual(Array.from(h.context.navGrid.dist), initial);
  h.context.player.pos.x = 1.1;
  h.step(1 / 60);
  assert.equal(h.floods(), 2);
  const reference = CORE.buildNavGrid([], { halfExtent: 46 });
  CORE.computeFlowField(reference, 1.1, 0.1);
  assert.deepEqual(Array.from(h.context.navGrid.dist), Array.from(reference.dist));
  h.context.navGrid = CORE.buildNavGrid([], { halfExtent: 46 });
  h.step(1 / 60);
  assert.equal(h.floods(), 3, 'new walkability grid must invalidate even before cadence expires');
  vm.runInContext('flowCellX = -9999; flowT = 0;', h.context);
  h.step(1 / 60);
  assert.equal(h.floods(), 4, 'existing stuck recovery must still force a refresh');
});

test('flow cache keys real grid cells for non-default origins and cell sizes', () => {
  const h = flowHarness();
  h.context.navGrid = CORE.buildNavGrid([], { cell: 2, halfExtent: 10 });
  h.step(1 / 60);
  h.context.player.pos.x = 1.9;
  h.step(1 / 60);
  assert.equal(h.floods(), 1, 'crossing a world metre is not crossing this two-metre cell');
  h.context.player.pos.x = 2.01;
  h.step(1 / 60);
  assert.equal(h.floods(), 2);
});

function minimapHarness() {
  const contexts = [];
  function canvas() {
    const calls = [];
    const ctx = new Proxy({ calls }, { get(target, key) {
      if (key in target) return target[key];
      return (...args) => calls.push([key, ...args]);
    } });
    contexts.push(ctx);
    return { width: 150, height: 150, getContext: () => ctx };
  }
  let visibilityChecks = 0;
  const context = vm.createContext({
    CORE: { ...CORE, isMinimapBlockVisible(...args) { visibilityChecks++; return CORE.isMinimapBlockVisible(...args); } },
    hud: { minimap: canvas(), compass: canvas() }, document: { createElement: canvas },
    CFG: { world: { size: 90 } }, player: { pos: { x: 0, z: 0 }, yaw: 0 },
    colliders: [{ min: { x: 1, y: 0, z: 1 }, max: { x: 3, y: 2, z: 3 } }],
    objective: null, stations: [], enemies: [], MM_KIND_COLOR: {}, uavActive: () => false,
    getSetting: () => false
  });
  const text = source('60_hud_waves.js');
  vm.runInContext(text.slice(text.indexOf('const mmCtx =')), context);
  return { context, contexts, checks: () => visibilityChecks };
}

test('minimap caches static block raster only for exact unchanged pose and redraws dynamic markers', () => {
  const h = minimapHarness();
  h.context.drawMinimap();
  assert.equal(h.checks(), 1);
  assert.equal(h.contexts.length, 2, 'moving/first frames must draw directly, without an extra canvas');
  h.context.enemies.push({ pos: { x: 4, z: 4 }, kind: 0, dead: false });
  h.context.drawMinimap();
  assert.equal(h.checks(), 2, 'first unchanged tick prepares the stationary-only cache');
  h.context.drawMinimap();
  assert.equal(h.checks(), 2, 'subsequent unchanged ticks reuse static raster');
  assert.equal(h.contexts[0].calls.filter(c => c[0] === 'arc').length, 2, 'new enemy is drawn immediately');
  h.context.player.yaw = 0.001;
  h.context.drawMinimap();
  assert.equal(h.checks(), 3, 'even tiny turns must preserve exact visual geometry');
  h.context.player.pos.x = 0.001;
  h.context.drawMinimap();
  assert.equal(h.checks(), 4);
  h.context.CFG.world.size = 100;
  h.context.drawMinimap();
  assert.equal(h.checks(), 5);
  h.context.invalidateMinimapBlocks();
  h.context.drawMinimap();
  assert.equal(h.checks(), 6, 'run/reset invalidates raster');
});

test('desktop streak HUD writes only on visible change and follows replacement elements', () => {
  let writes = 0, value = '';
  let element = { get innerHTML() { return value; }, set innerHTML(s) { value = s; writes++; } };
  const context = vm.createContext({ CORE, $id: () => element, streakBank: [], fieldCharge: 0, streakKills: 0, IS_TOUCH: false });
  const text = source('58_streaks.js');
  vm.runInContext(text.slice(text.indexOf('let _touchStreakCache')), context);
  for (let i = 0; i < 100; i++) {
    context.fieldCharge = i;
    context.updateHudStreaks();
  }
  assert.equal(writes, 1, 'damage below readiness should not rebuild identical DOM');
  context.streakKills = 1;
  context.updateHudStreaks();
  assert.equal(writes, 2);
  element = { set innerHTML(s) { value = s; writes++; } };
  context.updateHudStreaks();
  assert.equal(writes, 3, 'replacement DOM target must receive the cached content');
  context.fieldCharge = CORE.FIELD_UPGRADE.charge;
  context.updateHudStreaks();
  assert.equal(writes, 4);
  assert.match(value, /FLD/);
  context.streakBank.push('uav');
  context.updateHudStreaks();
  assert.equal(writes, 5);
  assert.match(value, /ready/);
});
