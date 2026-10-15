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

test('shadow caster pooling, sentry target range check, and pickup opacity throttling eliminate runtime heap churn', () => {
  // 1. Shadow caster pool reuse
  const pos = [{ x: 50, z: 0 }, { x: 5, z: 0 }, { x: 15, z: 0 }, { x: 1, z: 0 }];
  const outPool = [];
  const distPool = [];
  const keep = CORE.shadowCasters(pos, 0, 0, 2, outPool, distPool);
  assert.equal(keep, outPool);
  assert.deepEqual(keep, [3, 1]); // indices 3 (dist 1) and 1 (dist 5)

  const maskPool = [];
  const mask = CORE.buildShadowCasterMask(keep, pos.length, maskPool);
  assert.equal(mask, maskPool);
  assert.deepEqual(mask, [false, true, false, true]);

  // 2. Sentry target range checking with squared distance
  const maxRange = 25;
  const maxRangeSq = maxRange * maxRange;
  assert.equal(CORE.isSentryTargetInRange(15, 15, maxRangeSq), true); // 225+225 = 450 < 625
  assert.equal(CORE.isSentryTargetInRange(20, 20, maxRangeSq), false); // 400+400 = 800 >= 625

  // 3. Flashlight intensity stepping
  assert.equal(CORE.stepFlashLightLife(0.05, 0.1), 0);
  assert.equal(CORE.flashLightIntensity(0, 1.0, 5.0), 0);

  // 4. Pickup opacity throttling
  assert.equal(CORE.shouldUpdatePickupOpacity(10, 20, 1.0, 1.0), false);
  assert.equal(CORE.shouldUpdatePickupOpacity(22, 20, 1.0, 0.75), true);
});

test('v125 audio range culling, aim assist forward gating, enemy separation overlap pre-check, and grenade/offer pooling', () => {
  // 1. Spatial audio range and reusable output
  assert.equal(CORE.isSpatialAudioInRange(10, 10, 50), true);
  assert.equal(CORE.isSpatialAudioInRange(40, 40, 50), false); // 1600+1600 = 3200 > 2500
  const outObj = { dist: 0, pan: 0, vol: 0, cutoff: 0, audible: false };
  const res = CORE.spatialAudioParams(20, 0, 0, 50, outObj);
  assert.equal(res, outObj);
  assert.equal(res.audible, true);
  assert.equal(res.dist, 20);

  // 2. Aim assist forward sector pruning
  // Target in front
  assert.equal(CORE.isAimCandidateInForwardSector(0, -1, 0, -5), true);
  // Target behind
  assert.equal(CORE.isAimCandidateInForwardSector(0, -1, 0, 5), false);
  // Target 90 degrees
  assert.equal(CORE.isAimCandidateInForwardSector(0, -1, 5, 0), false);

  // 3. Enemy separation pre-check
  assert.equal(CORE.canEnemiesOverlap(0, 0, 0.85, 0.5, 0.5, 0.85), true);
  assert.equal(CORE.canEnemiesOverlap(0, 0, 0.85, 2.5, 0.5, 0.85), false);
  assert.equal(CORE.canEnemiesOverlap(0, 0, 0.85, 0.5, 2.5, 0.85), false);

  // 4. Grenade pooling predicate
  assert.equal(CORE.GRENADE_POOL_MAX, 12);
  assert.equal(CORE.canRecycleGrenade(0, false), true);
  assert.equal(CORE.canRecycleGrenade(2.0, false), false);
  assert.equal(CORE.canRecycleGrenade(2.0, true), true);
  assert.equal(CORE.canRecycleGrenade(11, CORE.GRENADE_POOL_MAX), true);
  assert.equal(CORE.canRecycleGrenade(12, CORE.GRENADE_POOL_MAX), false);

  // 5. Station offer pooling
  const offerOut = { action: '', price: 0 };
  const offer = CORE.wallBuyOffer([0, 1], 1, 'smg', 30, 120, offerOut);
  assert.equal(offer, offerOut);
  assert.equal(offer.action, 'ammo');
  assert.equal(offer.price, CORE.ammoRefillPrice('smg'));
});

test('v130 performance optimization rules: countdown and downed timer change-gating, blast distance-squared culling, and ragdoll momentum rules', () => {
  // 1. Between-wave countdown change detection
  const cdState = { waveNum: -1, displaySec: -1 };
  assert.equal(CORE.waveCountdownChanged(cdState, 1, 3.8), true);
  CORE.syncWaveCountdownState(cdState, 1, 3.8);
  assert.equal(cdState.waveNum, 1);
  assert.equal(cdState.displaySec, 4);
  // Same second ceil: 3.8 -> 3.2 (both ceil to 4) should NOT trigger DOM update
  assert.equal(CORE.waveCountdownChanged(cdState, 1, 3.2), false);
  // Cross to next second: 2.9 (ceil to 3) triggers change
  assert.equal(CORE.waveCountdownChanged(cdState, 1, 2.9), true);
  CORE.syncWaveCountdownState(cdState, 1, 2.9);
  assert.equal(cdState.displaySec, 3);
  // Next wave number triggers change
  assert.equal(CORE.waveCountdownChanged(cdState, 2, 2.9), true);

  // Dual-signature compatibility: boolean active + remainingSec (used by probe acceptance and HUD status)
  const cdInit = { active: false, sec: -1 };
  const cdChg1 = CORE.waveCountdownChanged(cdInit, true, 5);
  const cdSync1 = CORE.syncWaveCountdownState(cdInit, true, 5);
  const cdChg2 = CORE.waveCountdownChanged(cdInit, true, 5);
  const cdChg3 = CORE.waveCountdownChanged(cdInit, true, 4);
  assert.equal(cdChg1, true);
  assert.equal(cdSync1.active, true);
  assert.equal(cdSync1.sec, 5);
  assert.equal(cdChg2, false);
  assert.equal(cdChg3, true);

  // 2. Downed bleedout timer change detection
  const downState = { downed: false, tenths: -1 };
  assert.equal(CORE.downedTimerChanged(downState, true, 14.24), true);
  CORE.syncDownedTimerState(downState, true, 14.24);
  assert.equal(downState.downed, true);
  assert.equal(downState.tenths, 142);
  // Sub-tenth delta: 14.24 -> 14.21 (both round to 142) should NOT trigger change
  assert.equal(CORE.downedTimerChanged(downState, true, 14.21), false);
  // Tenth decrement: 14.14 (rounds to 141) triggers change
  assert.equal(CORE.downedTimerChanged(downState, true, 14.14), true);
  CORE.syncDownedTimerState(downState, true, 14.14);
  assert.equal(downState.tenths, 141);
  // Revived/cleared: downed transitions to false
  assert.equal(CORE.downedTimerChanged(downState, false, 0), true);
  CORE.syncDownedTimerState(downState, false, 0);
  assert.equal(downState.downed, false);
  assert.equal(CORE.downedTimerChanged(downState, false, 0), false);

  // 3. Flash overlay change detection
  assert.equal(CORE.flashOverlayChanged(undefined, 0.5), true);
  assert.equal(CORE.flashOverlayChanged(0.5, 0.502, 0.008), false);
  assert.equal(CORE.flashOverlayChanged(0.5, 0.515, 0.008), true);
  assert.equal(CORE.flashOverlayChanged(0.01, 0.0, 0.008), true);

  // 4. Explosive blast radial spatial culling
  const blastRadSq = 7.5 * 7.5; // 56.25
  // Hostile 4m away: 16 + 0 + 9 = 25 < 56.25
  assert.equal(CORE.isTargetInBlastRadius(4, 0, 3, blastRadSq), true);
  // Hostile 10m away: 64 + 0 + 36 = 100 >= 56.25
  assert.equal(CORE.isTargetInBlastRadius(8, 0, 6, blastRadSq), false);
  // Invalid/degenerate radius
  assert.equal(CORE.isTargetInBlastRadius(1, 0, 1, 0), false);

  // 5. Thermite burn patch distance-squared optimization
  assert.equal(CORE.isPointInBurnRadius(2, 2, 0, 0, 3), true); // 4+4=8 < 9
  assert.equal(CORE.isPointInBurnRadius(3, 3, 0, 0, 3), false); // 9+9=18 >= 9

  // 6. Soldier ragdoll knockback & momentum pooling
  assert.equal(CORE.SOLDIER_RAGDOLL_MOMENTUM_SCALE, 0.55);
  assert.equal(CORE.SOLDIER_RAGDOLL_KNOCK_BASE, 9.0);
  assert.equal(CORE.SOLDIER_RAGDOLL_KNOCK_MIN, 2.0);
  const knockOut = { x: 0, z: 0 };
  const resKnock = CORE.soldierRagdollKnockback(10, 10, 7, 6, knockOut);
  assert.equal(resKnock, knockOut);
  // dist = hypot(3, 4) = 5. kf = max(2, 9 - 5) = 4. ox = 3/5*4 = 2.4, oz = 4/5*4 = 3.2
  assert.ok(Math.abs(resKnock.x - 2.4) < 1e-4);
  assert.ok(Math.abs(resKnock.z - 3.2) < 1e-4);

  const momOut = { x: 0, y: 0, z: 0 };
  const resMom = CORE.soldierRagdollMomentum(4.0, 6.0, 2.4, 3.2, 0.55, momOut);
  assert.equal(resMom, momOut);
  assert.ok(Math.abs(resMom.x - (4.0 * 0.55 + 2.4)) < 1e-4);
  assert.ok(Math.abs(resMom.z - (6.0 * 0.55 + 3.2)) < 1e-4);
  assert.equal(resMom.y, 0);
});

test('v135 performance optimization: grenade charge HUD change-gating, tactical distance-squared culling, bullet magnetism dot-product selection, and cone range pre-check', () => {
  // 1. Grenade charge HUD change detection and state synchronization
  const chargeState = { visible: false, pct: -1, speed: -1 };
  assert.equal(CORE.grenadeChargeHudChanged(chargeState, false, 0, 0), false); // already hidden
  assert.equal(CORE.grenadeChargeHudChanged(chargeState, true, 45, 12), true); // show charge
  CORE.syncGrenadeChargeHudState(chargeState, true, 45, 12);
  assert.equal(chargeState.visible, true);
  assert.equal(chargeState.pct, 45);
  assert.equal(chargeState.speed, 12);
  // Unchanged progress/speed does not trigger DOM update
  assert.equal(CORE.grenadeChargeHudChanged(chargeState, true, 45, 12.1), false);
  // Integer progress increment triggers update
  assert.equal(CORE.grenadeChargeHudChanged(chargeState, true, 46, 12.1), true);
  CORE.syncGrenadeChargeHudState(chargeState, true, 46, 12.1);
  assert.equal(chargeState.pct, 46);
  // Hiding charge triggers update once
  assert.equal(CORE.grenadeChargeHudChanged(chargeState, false, 0, 0), true);
  CORE.syncGrenadeChargeHudState(chargeState, false, 0, 0);
  assert.equal(chargeState.visible, false);
  // Consecutive hidden frames skip DOM writes completely
  assert.equal(CORE.grenadeChargeHudChanged(chargeState, false, 0, 0), false);
  assert.equal(CORE.grenadeChargeLabel(15, 60), 'GRENADE 15 M/S (60%)');

  // 2. Tactical equipment radial distance-squared spatial culling
  const radSq = 8 * 8; // 64
  assert.equal(CORE.isTargetInTacticalRadius(4, 4, radSq), true);  // 16 + 16 = 32 < 64
  assert.equal(CORE.isTargetInTacticalRadius(6, 6, radSq), false); // 36 + 36 = 72 >= 64
  assert.equal(CORE.isTargetInTacticalRadius(0, 0, 0), false);

  // 3. Fast bullet magnetism unit-vector dot product selection
  const maxAng = 0.08; // ~4.58 deg
  const minCos = CORE.bulletMagnetMinCos(maxAng);
  assert.ok(Math.abs(minCos - Math.cos(maxAng)) < 1e-6);
  // Closer angle has higher cosine (closer to 1.0)
  assert.equal(CORE.isMagnetCandidateCloser(0.999, minCos), true);
  assert.equal(CORE.isMagnetCandidateCloser(0.990, minCos), false);
  assert.equal(CORE.isMagnetCandidateCloser(0.998, 0.995), true);
  assert.equal(CORE.isMagnetCandidateCloser(0.992, 0.995), false);

  // 4. Proximity ordnance cone range pre-check
  const coneRangeSq = 6 * 6; // 36
  assert.equal(CORE.isTargetInConeRange(3, 4, coneRangeSq), true);  // 9 + 16 = 25 <= 36
  assert.equal(CORE.isTargetInConeRange(5, 5, coneRangeSq), false); // 25 + 25 = 50 > 36
  assert.equal(CORE.isTargetInConeRange(0, 0, coneRangeSq), false); // degenerate distance < 1e-6
});

test('v140 performance optimization: aim assist range culling & cosine cone gating, and hit arc HUD change-detection rules', () => {
  // 1. Aim assist spatial distance-squared culling
  assert.equal(CORE.AIM_ASSIST_MAX_DIST, 48.0);
  const assistDistSq = CORE.AIM_ASSIST_MAX_DIST * CORE.AIM_ASSIST_MAX_DIST; // 2304
  assert.equal(CORE.isTargetInAimAssistRange(20, 20, assistDistSq), true);  // 400 + 400 = 800 <= 2304
  assert.equal(CORE.isTargetInAimAssistRange(35, 35, assistDistSq), false); // 1225 + 1225 = 2450 > 2304
  assert.equal(CORE.isTargetInAimAssistRange(48, 0), true);                 // default maxDistSq fallback
  assert.equal(CORE.isTargetInAimAssistRange(49, 0), false);
  assert.equal(CORE.isTargetInAimAssistRange(NaN, 0), false);

  // 2. Fast aim assist cosine threshold and candidate selection
  const minCosStandard = CORE.aimAssistMinCos(0.14, false, 1.6);
  assert.ok(Math.abs(minCosStandard - Math.cos(0.14)) < 1e-6);
  const minCosSteady = CORE.aimAssistMinCos(0.14, true, 1.6);
  assert.ok(Math.abs(minCosSteady - Math.cos(0.224)) < 1e-6);
  assert.equal(CORE.isAimAssistCandidateCloser(0.998, 0.995), true);
  assert.equal(CORE.isAimAssistCandidateCloser(0.990, 0.995), false);
  assert.equal(CORE.isAimAssistCandidateCloser(NaN, 0.995), false);

  // 3. Aim assist nudge projection skip check
  const baseDir = { x: 0, y: 0, z: -1 };
  const nudgedDir = { x: 0.05, y: 0, z: -0.99 };
  assert.equal(CORE.hasAimAssistNudge(nudgedDir, baseDir), true);
  assert.equal(CORE.hasAimAssistNudge(baseDir, baseDir), false);
  assert.equal(CORE.hasAimAssistNudge(null, baseDir), false);

  // 4. Hit arc active-state and opacity change detection
  assert.equal(CORE.hasActiveHitArcs(0), false);
  assert.equal(CORE.hasActiveHitArcs(2), true);
  assert.equal(CORE.hasActiveHitArcs(-1), false);

  assert.equal(CORE.hitArcOpacityChanged(undefined, 0.9), true);
  assert.equal(CORE.hitArcOpacityChanged(null, 0.9), true);
  assert.equal(CORE.hitArcOpacityChanged(0.9, 0.89, 0.015), false); // small delta within epsilon
  assert.equal(CORE.hitArcOpacityChanged(0.9, 0.85, 0.015), true);  // significant delta
  assert.equal(CORE.hitArcOpacityChanged(0.05, 0.0, 0.015), true);  // expired arc cleanup write
  assert.equal(CORE.hitArcOpacityChanged(0.0, 0.0, 0.015), false); // already expired

  const arcState = { lastOp: null };
  CORE.syncHitArcOpacity(arcState, 0.85);
  assert.equal(arcState.lastOp, 0.85);
  assert.equal(CORE.hitArcOpacityChanged(arcState.lastOp, 0.85), false);
});

test('v145 performance optimization: bullet magnetism distance-squared culling, munitions box timers & spatial culling, and tactical objective zone culling & ring opacity gating', () => {
  // 1. Bullet magnetism spatial range culling
  assert.equal(CORE.BULLET_MAGNET_MAX_DIST, 45.0);
  const magnetDistSq = CORE.BULLET_MAGNET_MAX_DIST * CORE.BULLET_MAGNET_MAX_DIST; // 2025
  assert.equal(CORE.isTargetInMagnetRange(20, 20, magnetDistSq), true);  // 400 + 400 = 800 <= 2025
  assert.equal(CORE.isTargetInMagnetRange(35, 35, magnetDistSq), false); // 1225 + 1225 = 2450 > 2025
  assert.equal(CORE.isTargetInMagnetRange(45, 0), true);                 // default fallback
  assert.equal(CORE.isTargetInMagnetRange(46, 0), false);
  assert.equal(CORE.isTargetInMagnetRange(NaN, 0), false);

  // 2. Munitions box resupply timers & spatial distance-squared culling
  const munRadSq = 4 * 4; // 16
  assert.equal(CORE.isTargetInMunitionsRadius(10, 10, 12, 12, munRadSq), true);  // 4 + 4 = 8 < 16
  assert.equal(CORE.isTargetInMunitionsRadius(10, 10, 14, 14, munRadSq), false); // 16 + 16 = 32 >= 16
  assert.equal(CORE.isTargetInMunitionsRadius(NaN, 10, 10, 10), false);

  const mTimerOut = { t: 0, tick: 0, expired: false, readyToResupply: false };
  CORE.stepMunitionsTimers(25.0, 0.8, 0.1, mTimerOut);
  assert.ok(Math.abs(mTimerOut.t - 24.9) < 1e-6);
  assert.ok(Math.abs(mTimerOut.tick - 0.7) < 1e-6);
  assert.equal(mTimerOut.expired, false);
  assert.equal(mTimerOut.readyToResupply, false);

  // Ready to resupply on cooldown expiration (resets tick to 1.0)
  CORE.stepMunitionsTimers(20.0, 0.05, 0.1, mTimerOut);
  assert.ok(Math.abs(mTimerOut.t - 19.9) < 1e-6);
  assert.equal(mTimerOut.tick, 1.0);
  assert.equal(mTimerOut.readyToResupply, true);
  assert.equal(mTimerOut.expired, false);

  // Box expiration
  CORE.stepMunitionsTimers(0.05, 0.5, 0.1, mTimerOut);
  assert.equal(mTimerOut.t, 0);
  assert.equal(mTimerOut.expired, true);

  // 3. Tactical Zone Objective spatial culling and ring opacity gating
  const objRadSq = 6 * 6; // 36
  assert.equal(CORE.isPlayerInObjectiveZone(0, 0, 4, 4, objRadSq), true);  // 16 + 16 = 32 < 36
  assert.equal(CORE.isPlayerInObjectiveZone(0, 0, 5, 5, objRadSq), false); // 25 + 25 = 50 >= 36
  assert.equal(CORE.isPlayerInObjectiveZone(NaN, 0, 0, 0), false);

  assert.equal(CORE.OBJECTIVE_RING_OPACITY_INSIDE, 0.85);
  assert.equal(CORE.OBJECTIVE_RING_OPACITY_OUTSIDE, 0.40);
  assert.equal(CORE.objectiveRingOpacity(true), 0.85);
  assert.equal(CORE.objectiveRingOpacity(false), 0.40);

  assert.equal(CORE.objectiveRingOpacityChanged(null, true), true);
  assert.equal(CORE.objectiveRingOpacityChanged(false, true), true);
  assert.equal(CORE.objectiveRingOpacityChanged(true, true), false);
  assert.equal(CORE.objectiveRingOpacityChanged(true, false), true);
  assert.equal(CORE.objectiveRingOpacityChanged(false, false), false);
});

test('v150 performance optimization: flow field coordinate packing, diagonal walkability, and enemy footstep/hostiles culling rules', () => {
  // 1. Flow field coordinate packing & unpacking constants and rules
  assert.equal(CORE.FLOW_FIELD_QUEUE_MASK, 0xffff);
  assert.equal(CORE.FLOW_FIELD_QUEUE_SHIFT, 16);
  assert.equal(CORE.packNavCell(15, 27), (27 << 16) | 15);
  assert.deepEqual(CORE.unpackNavCell((27 << 16) | 15), { cx: 15, cz: 27 });
  assert.equal(CORE.packNavCell(0, 0), 0);
  assert.deepEqual(CORE.unpackNavCell(0), { cx: 0, cz: 0 });
  assert.equal(CORE.packNavCell(91, 91), (91 << 16) | 91);
  assert.deepEqual(CORE.unpackNavCell((91 << 16) | 91), { cx: 91, cz: 91 });

  // 2. Navigation diagonal step corner-cutting rule
  const blockedArr = [0, 1, 0, 0];
  assert.equal(CORE.isNavDiagonalWalkable(blockedArr, 0, 2), true);
  assert.equal(CORE.isNavDiagonalWalkable(blockedArr, 0, 1), false);
  assert.equal(CORE.isNavDiagonalWalkable(blockedArr, 1, 2), false);

  // 3. Enemy footstep spatial range culling
  assert.equal(CORE.ENEMY_FOOTSTEP_MAX_DIST, 30.0);
  assert.equal(CORE.isTargetInFootstepRange(15.0, 30.0), true);
  assert.equal(CORE.isTargetInFootstepRange(30.0, 30.0), false);
  assert.equal(CORE.isTargetInFootstepRange(35.0, 30.0), false);
  assert.equal(CORE.isTargetInFootstepRange(10.0), true);
  assert.equal(CORE.isTargetInFootstepRange(32.0), false);
  assert.equal(CORE.isTargetInFootstepRange(NaN), false);

  // 4. Hostiles remaining HUD change-gating
  assert.equal(CORE.enemiesRemainingChanged(10, 9), true);
  assert.equal(CORE.enemiesRemainingChanged(5, 5), false);
  assert.equal(CORE.enemiesRemainingChanged(-1, 12), true);
  assert.equal(CORE.syncEnemiesRemaining(8), 8);
  assert.equal(CORE.syncEnemiesRemaining(NaN), 0);
});




