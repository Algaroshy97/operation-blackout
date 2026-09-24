// Behavioural tests for src/01_core.js — run with:  node --test tests/
//
// These replace source-text greps with assertions that actually execute the rules.
// Each regression test names the audit ID it guards (see AUDIT_AND_ROADMAP.md), so
// reintroducing the original defect fails here rather than shipping.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = require(path.join(__dirname, '..', 'src', '01_core.js'));

// The real arena geometry, rebuilt from the same numbers 10_config_world.js uses,
// so nav tests run against the map players actually play.
function buildArenaColliders() {
  const out = [];
  const box = (x, y, z, w, h, d) => out.push({
    min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 }
  });
  const S = 90;
  // perimeter
  box(0, 3, -S / 2, S + 4, 6, 1); box(0, 3, S / 2, S + 4, 6, 1);
  box(-S / 2, 3, 0, 1, 6, S + 4); box(S / 2, 3, 0, 1, 6, S + 4);
  // central building ground floor (doors on every side)
  [[-5.5, -7], [5.5, -7], [-5.5, 7], [5.5, 7]].forEach(p => box(p[0], 1.7, p[1], 7, 3.4, 0.8));
  [[-9, -4.5], [-9, 4.5], [9, -4.5], [9, 4.5]].forEach(p => box(p[0], 1.7, p[1], 0.8, 3.4, 5));
  box(0, 3.9, 0, 18.6, 0.5, 14.6);    // 2nd-floor slab
  box(0, 6.65, 0, 18, 0.5, 14);       // roof
  [[-6, -4], [6, -4], [-6, 4], [6, 4]].forEach(p => box(p[0], 1.7, p[1], 1.2, 3.4, 1.2));
  [[-5.4, -7.0], [5.4, -7.0], [-5.4, 7.0], [5.4, 7.0]].forEach(p => box(p[0], 4.55, p[1], 7.2, 0.9, 0.8));
  box(-9.0, 4.55, 0, 0.8, 0.9, 14); box(9.0, 4.55, 0, 0.8, 0.9, 14);
  for (let i = 0; i < 10; i++) {
    const top = (i + 1) * 0.4;
    box(0, top / 2, 13.6 - i * 0.8, 3.2, top, 0.82);
    box(0, top / 2, -13.6 + i * 0.8, 3.2, top, 0.82);
  }
  // corner districts (the big blockers that break naive seek)
  box(28, 2.5, -28, 16, 5, 12); box(-28, 2, 28, 12, 4, 12); box(26, 3, 30, 10, 6, 10);
  box(-28, 1.5, -28, 14, 3, 1); box(-33.5, 1.5, -22, 1, 3, 13); box(-24, 1.5, -30, 8, 3, 1);
  return out;
}

const ARENA = buildArenaColliders();
const STEP_H = 0.6;

// ---------------------------------------------------------------- BUG-02
test('BUG-02: horizontal distance ignores the 1.7 m eye-height offset', () => {
  // Enemy feet at (0,0,0); player eye vector at (0,1.7,0) — same ground spot.
  // The old 3-D check read 1.7 m of pure height as separation and let the enemy
  // stand inside the player. Horizontal distance must report ~0.
  const d = CORE.horizDist(0, 0, 0, 0);
  assert.strictEqual(d, 0);
});

test('rifleman movement keeps elite, special-wave, and status multipliers in ranged orbit', () => {
  const cfg = { speed: 3.2, chaseSpeed: 4.9, rangedSpeed: 2.8 };
  const speed = CORE.enemyMoveSpeed(1, 'strafe', 12, 44, 2.0, cfg);
  assert.strictEqual(speed, 5.6, 'ranged speed must retain the full multiplier stack');
  assert.strictEqual(CORE.enemyMoveSpeed(0, 'chase', 12, 44, 1.25, cfg), 6.125);
});

test('melee windup requires the same vertical reach as impact', () => {
  assert.strictEqual(CORE.withinReach(1.5, 0, 2.5), true);
  assert.strictEqual(CORE.withinReach(1.5, 3.65, 2.5), false,
    'an enemy below the player must not begin a melee swing through a slab');
});

test('BUG-02: an enemy at melee reach is inside the stop radius, not outside it', () => {
  const STOP = 1.9;
  // Enemy 1.0 m away on the ground, player anchored at eye height 1.7.
  const horizontal = CORE.horizDist(1.0, 0, 0, 0);
  const naive3D = Math.sqrt(1.0 * 1.0 + 1.7 * 1.7);
  assert.ok(horizontal < STOP, 'horizontal check correctly triggers the stop');
  assert.ok(naive3D > STOP, 'the old 3-D check would have failed to trigger it');
});

// ---------------------------------------------------------------- BUG-03
test('BUG-03: movement is sub-stepped so no substep exceeds the thinnest wall', () => {
  const THINNEST_WALL = 0.8;
  const MAX_STEP = 0.3;
  const sprint = 8.91;                 // speed * sprintMul
  const n = CORE.subStepCount(sprint, 0.1, MAX_STEP);
  assert.ok(n > 1, 'a 0.1 s frame at sprint speed must be split');
  assert.ok((sprint * 0.1) / n < THINNEST_WALL,
    `per-substep travel ${(sprint * 0.1) / n} must stay under ${THINNEST_WALL} m`);
});

test('BUG-03: normal frames are not sub-stepped', () => {
  assert.strictEqual(CORE.subStepCount(8.91, 1 / 60, 0.3), 1);
  assert.strictEqual(CORE.subStepCount(0, 0.1, 0.3), 1);
});

test('BUG-03: substep count is capped so a pathological dt cannot stall the frame', () => {
  assert.ok(CORE.subStepCount(1e6, 1, 0.3) <= CORE.MAX_SUBSTEPS);
});

// ---------------------------------------------------------------- PERFORMANCE TELEMETRY
// Capture is opt-in and bounded so benchmark instrumentation cannot change normal
// gameplay memory use or frame work unless a caller explicitly enables it.
test('performance telemetry is disabled by default and ignores samples until enabled', () => {
  const telemetry = CORE.createFrameTimeTelemetry();
  assert.strictEqual(telemetry.enabled, false);
  assert.strictEqual(telemetry.record(16.7), false);
  assert.deepStrictEqual(telemetry.summary(), {
    count: 0, capacity: 300, min: null, max: null, p50: null, p95: null
  });
});

test('performance telemetry keeps a bounded recent window and computes percentiles', () => {
  const telemetry = CORE.createFrameTimeTelemetry({ enabled: true, maxSamples: 4 });
  [1, 2, 3, 4, 5].forEach(sample => assert.strictEqual(telemetry.record(sample), true));
  assert.deepStrictEqual(telemetry.samples(), [2, 3, 4, 5]);
  assert.deepStrictEqual(telemetry.summary(), {
    count: 4, capacity: 4, min: 2, max: 5, p50: 3.5, p95: 4.85
  });
});

test('performance telemetry rejects invalid frame times and protects sample storage', () => {
  const telemetry = CORE.createFrameTimeTelemetry({ enabled: true, maxSamples: 2 });
  assert.strictEqual(telemetry.record(-1), false);
  assert.strictEqual(telemetry.record(Infinity), false);
  assert.strictEqual(telemetry.record('16'), false);
  assert.strictEqual(telemetry.record(16), true);
  const copy = telemetry.samples();
  copy[0] = 99;
  assert.deepStrictEqual(telemetry.samples(), [16]);
});

test('runtime telemetry is opt-in, bounded, and exposes an exportable snapshot', () => {
  assert.strictEqual(typeof CORE.createRuntimeTelemetry, 'function');
  const telemetry = CORE.createRuntimeTelemetry();
  assert.strictEqual(telemetry.enabled, false);
  assert.strictEqual(telemetry.record(16.7), false);
  assert.deepStrictEqual(telemetry.snapshot(), {
    enabled: false,
    summary: { count: 0, capacity: 300, min: null, max: null, p50: null, p95: null },
    samples: []
  });
});

// ---------------------------------------------------------------- FRAME-RATE / PHYSICS
// A render stall must catch up scheduled automatic shots instead of silently
// lowering the weapon's effective RPM.
test('automatic-fire schedule catches up every missed shot deadline', () => {
  const interval = 60 / 600;
  const schedule = CORE.advanceShotSchedule(0.35, 0.05, interval);
  assert.strictEqual(schedule.shots, 4);
  assert.ok(Math.abs(schedule.nextShot - 0.45) < 1e-12);
});

test('automatic-fire catch-up caps shots after a long render stall', () => {
  const interval = 60 / 600;
  const schedule = CORE.advanceShotSchedule(5.05, 0.05, interval, 4);
  assert.strictEqual(schedule.shots, 4, 'one stalled frame must not fire an unbounded burst');
  assert.ok(Math.abs(schedule.nextShot - 0.45) < 1e-12,
    'capping work must preserve the next missed deadline for a later frame');
});

test('fire clock bounds a render stall without bounding gameplay physics policy', () => {
  assert.strictEqual(CORE.fireClockStep(5, 0.5), 0.5);
  assert.strictEqual(CORE.fireClockStep(0.2, 0.5), 0.2);
  assert.strictEqual(CORE.fireClockStep(-1, 0.5), 0);
});

test('armory upgrade keeps every base weapon runtime field while changing upgrade stats', () => {
  const base = {
    name: 'Test Rifle', type: 'AR', dmg: 26, rpm: 750, mag: 30, reserveMax: 150,
    reload: 2.1, spread: 0.014, adsSpread: 0.004, recoilV: 0.014, recoilH: 0.006,
    range: 120, auto: true, penetration: 1.25, sway: 0.8
  };
  const upgraded = CORE.armoryUpgrade(base);
  const effective = CORE.applyAttachments(upgraded, {});
  for (const key of ['rpm', 'reload', 'spread', 'adsSpread', 'recoilV', 'recoilH', 'range', 'auto', 'type', 'penetration', 'sway']) {
    assert.strictEqual(effective[key], base[key], key + ' must survive armory construction');
  }
  assert.strictEqual(effective.dmg, base.dmg * 1.8);
  assert.strictEqual(upgraded.mag, 45);
  assert.strictEqual(upgraded.reserveMax, 225);
  assert.strictEqual(upgraded.upgraded, true);
});

test('inactive automatic-fire time resets the schedule instead of banking deadlines', () => {
  assert.strictEqual(CORE.shotScheduleAfterInactive(12.5), 0);
});

test('landing impact sampling includes velocity on the landing substep', () => {
  assert.strictEqual(CORE.landingImpactSpeed(0, -12), 12);
  assert.strictEqual(CORE.landingImpactSpeed(8, -6), 8);
});

// ---------------------------------------------------------------- GRENADE COLLISION
function grenadeBox(x, y, z, w, h, d) {
  return {
    min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 }
  };
}

test('fast grenade sweep catches a thin vertical obstacle between frames', () => {
  const wall = grenadeBox(0, 1, 0, 0.08, 2, 4);
  const hit = CORE.sweepGrenade({ x: -1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, 0.11, [wall]);
  assert.ok(hit, 'the grenade must collide even when its endpoint is past the wall');
  assert.ok(hit.t > 0 && hit.t < 1, `expected an in-flight hit, got t=${hit && hit.t}`);
  assert.deepStrictEqual(hit.normal, { x: -1, y: 0, z: 0 });
});

test('grenade sweep ignores obstacles outside the segment', () => {
  const wall = grenadeBox(0, 1, 0, 0.08, 2, 4);
  assert.strictEqual(CORE.sweepGrenade({ x: -1, y: 1, z: 5 }, { x: 1, y: 1, z: 5 }, 0.11, [wall]), null);
});

test('grenade sweep resolves an initial overlap with the outward face normal', () => {
  const collider = grenadeBox(0, 1, 0, 2, 2, 2);
  const hit = CORE.sweepGrenade({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, 0.11, [collider]);
  assert.ok(hit, 'an overlapped grenade must still produce a collision');
  assert.strictEqual(hit.t, 0, 'initial overlap is resolved immediately');
  assert.deepStrictEqual(hit.normal, { x: 1, y: 0, z: 0 },
    'outward movement must use the exit face, not a fallback Z normal');
  assert.ok(hit.initialOverlap);
  assert.ok(hit.pushOut > 0);
});

test('grenade bounce continues through the remaining frame after a wall impact', () => {
  const wall = grenadeBox(0, 1, 0, 0.1, 2, 4);
  const state = { position: { x: -1, y: 1, z: 0 }, velocity: { x: 10, y: 0, z: 0 } };
  CORE.stepGrenadeMotion(state, 0.2, [wall], { bounce: 0.5 });
  assert.ok(state.position.x < -0.1, 'the grenade should be on the reflected side of the wall');
  assert.ok(state.position.x > -1, 'the reflected grenade must travel during the leftover time');
  assert.ok(state.velocity.x < 0, 'wall impact must reflect horizontal velocity');
});

test('grenade motion handles multiple contacts in one frame without looping', () => {
  const left = grenadeBox(-1, 1, 0, 0.1, 2, 4);
  const right = grenadeBox(1, 1, 0, 0.1, 2, 4);
  const state = { position: { x: 0, y: 1, z: 0 }, velocity: { x: 20, y: 0, z: 0 } };
  const result = CORE.stepGrenadeMotion(state, 0.25, [left, right], { bounce: 0.5, maxContacts: 4 });
  assert.ok(result.contacts >= 2, 'one frame should be able to resolve both walls');
  assert.ok(result.contacts <= 4, 'contact handling must be bounded');
  assert.ok(Number.isFinite(state.position.x) && Number.isFinite(state.velocity.x));
});

// ---------------------------------------------------------------- BUG-07
test('BUG-07: damage falloff ramps smoothly instead of cliffing', () => {
  const range = 120;
  assert.strictEqual(CORE.distanceFalloff(10, range), 1);
  assert.strictEqual(CORE.distanceFalloff(72, range), 1);          // knee
  const justPast = CORE.distanceFalloff(73, range);
  assert.ok(justPast < 1 && justPast > 0.98,
    `one metre past the knee must barely change damage, got ${justPast}`);
  assert.ok(Math.abs(CORE.distanceFalloff(120, range) - 0.65) < 1e-9);
  assert.ok(Math.abs(CORE.distanceFalloff(200, range) - 0.65) < 1e-9);
});

test('BUG-07: falloff is monotonically non-increasing', () => {
  let prev = Infinity;
  for (let d = 0; d <= 140; d += 1) {
    const m = CORE.distanceFalloff(d, 120);
    assert.ok(m <= prev + 1e-12, `falloff increased at ${d} m`);
    prev = m;
  }
});

// ---------------------------------------------------------------- BUG-09
test('BUG-09: spawn validation rejects points inside solid geometry', () => {
  // Dead centre of the NE warehouse block.
  assert.strictEqual(CORE.isSpawnValid(28, -28, ARENA, STEP_H, 1.8), false);
  // Open ground near the south edge.
  assert.strictEqual(CORE.isSpawnValid(0, 38, ARENA, STEP_H, 1.8), true);
});

test('BUG-09: low cover is steppable, so it never invalidates a spawn', () => {
  const lowCrate = [{ min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 0.4, z: 1 } }];
  assert.strictEqual(CORE.isSpawnValid(0, 0, lowCrate, STEP_H, 1.8), true);
  const tallCrate = [{ min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1.5, z: 1 } }];
  assert.strictEqual(CORE.isSpawnValid(0, 0, tallCrate, STEP_H, 1.8), false);
});

// ---------------------------------------------------------------- BUG-01
test('BUG-01: nav grid marks walls blocked and open ground walkable', () => {
  const nav = CORE.buildNavGrid(ARENA, { stepH: STEP_H });
  const wall = CORE.worldToCell(nav, 9, 4.5);      // central building east wall
  const open = CORE.worldToCell(nav, 0, 20);       // open courtyard
  assert.strictEqual(CORE.isWalkable(nav, wall), false);
  assert.strictEqual(CORE.isWalkable(nav, open), true);
});

test('BUG-01: the 2nd-floor slab does not block the ground floor beneath it', () => {
  const nav = CORE.buildNavGrid(ARENA, { stepH: STEP_H });
  // (0,0) is inside the building footprint, under the slab at y 3.65-4.15.
  assert.strictEqual(CORE.isWalkable(nav, CORE.worldToCell(nav, 0, 0)), true);
});

test('BUG-01: every ring spawn point can reach a player inside the central building', () => {
  const nav = CORE.buildNavGrid(ARENA, { stepH: STEP_H });
  CORE.computeFlowField(nav, 0, 0);                // player at building centre
  const R = 90 / 2 - 6 - 6;
  const unreachable = [];
  for (let a = 0; a < 12; a++) {
    const ang = a / 12 * Math.PI * 2;
    const x = Math.cos(ang) * R, z = Math.sin(ang) * R;
    if (CORE.navDistanceAt(nav, x, z) === CORE.UNREACHABLE) unreachable.push([+x.toFixed(1), +z.toFixed(1)]);
  }
  assert.deepStrictEqual(unreachable, [],
    'these spawn points cannot path to the player: ' + JSON.stringify(unreachable));
});

test('BUG-01: flow direction always reduces distance-to-goal', () => {
  const nav = CORE.buildNavGrid(ARENA, { stepH: STEP_H });
  CORE.computeFlowField(nav, 0, 0);
  const dir = { x: 0, z: 0 };
  // The corner that used to wedge enemies against the building's outside face.
  let x = 25, z = 25, steps = 0;
  let d = CORE.navDistanceAt(nav, x, z);
  assert.notStrictEqual(d, CORE.UNREACHABLE);
  while (d > 0 && steps < 400) {
    const got = CORE.flowDirAt(nav, x, z, dir);
    assert.ok(got, `flow field gave no direction at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    x += dir.x * 0.5; z += dir.z * 0.5;
    const nd = CORE.navDistanceAt(nav, x, z);
    assert.ok(nd <= d, `distance increased from ${d} to ${nd}`);
    d = nd; steps++;
  }
  assert.ok(d === 0, `never arrived; stalled at distance ${d} after ${steps} steps`);
});

test('BUG-01: an agent walking the flow field reaches the player from every ring point', () => {
  const nav = CORE.buildNavGrid(ARENA, { stepH: STEP_H });
  const goal = { x: 0, z: 0 };
  CORE.computeFlowField(nav, goal.x, goal.z);
  const dir = { x: 0, z: 0 };
  const R = 33;
  const failures = [];
  for (let a = 0; a < 12; a++) {
    const ang = a / 12 * Math.PI * 2;
    let x = Math.cos(ang) * R, z = Math.sin(ang) * R;
    let t = 0;
    // 4.9 m/s chase speed, 60 Hz, 30 s budget.
    while (t < 30 && CORE.horizDist(x, z, goal.x, goal.z) > 2.0) {
      const got = CORE.flowDirAt(nav, x, z, dir);
      if (!got) break;
      x += dir.x * 4.9 / 60; z += dir.z * 4.9 / 60;
      t += 1 / 60;
    }
    if (CORE.horizDist(x, z, goal.x, goal.z) > 2.0) {
      failures.push({ from: [+(Math.cos(ang) * R).toFixed(1), +(Math.sin(ang) * R).toFixed(1)], stalledAt: [+x.toFixed(1), +z.toFixed(1)] });
    }
  }
  assert.deepStrictEqual(failures, [],
    'agents failed to reach the player: ' + JSON.stringify(failures));
});

test('BUG-01: flow field recompute is fast enough to run several times a second', () => {
  const nav = CORE.buildNavGrid(ARENA, { stepH: STEP_H });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) CORE.computeFlowField(nav, (i % 20) - 10, (i % 14) - 7);
  const msPerFlood = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  assert.ok(msPerFlood < 3, `flood took ${msPerFlood.toFixed(3)} ms, budget is 3 ms`);
});

// ---------------------------------------------------------------- BUG-04
test('BUG-04: the external staircase is not a walkable AI route', () => {
  const nav = CORE.buildNavGrid(ARENA, { stepH: STEP_H });
  // Mid-staircase, where enemies used to climb to y=3.2 and wedge forever.
  assert.strictEqual(CORE.isWalkable(nav, CORE.worldToCell(nav, 0, 9.5)), false);
  // The bottom step is only 0.4 m and stays steppable for the player.
  assert.strictEqual(CORE.blocksWalker({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0.4, z: 1 } }, STEP_H, 1.8), false);
});

// ---------------------------------------------------------------- stuck detector
test('stuck detector escalates repath then teleport, and resets on movement', () => {
  const s = {};
  assert.strictEqual(CORE.updateStuck(s, 0, 0, 0.1), 'ok');       // first call anchors
  let sawRepath = false;
  for (let i = 0; i < 30; i++) {                                   // 3 s pinned
    if (CORE.updateStuck(s, 0, 0, 0.1) === 'repath') sawRepath = true;
  }
  assert.ok(sawRepath, 'should have asked for a repath by 3 s');
  let sawTeleport = false;
  for (let i = 0; i < 60; i++) {
    if (CORE.updateStuck(s, 0, 0, 0.1) === 'teleport') sawTeleport = true;
  }
  assert.ok(sawTeleport, 'should have escalated to teleport by 8 s');
  assert.strictEqual(CORE.updateStuck(s, 5, 5, 0.1), 'ok');        // moved: reset
  assert.strictEqual(s.stuckT, 0);
});

test('stall tracking is gated off once an enemy has arrived', () => {
  // Regression: an enemy holding at its stop distance is stationary ON PURPOSE.
  // Feeding that to the stall detector classed every arrived attacker as stuck and
  // teleported it away, so waves never resolved (observed: 80 relocations in 240 s).
  assert.strictEqual(CORE.isClosingDistance('chase', 25, 1.9), true);
  assert.strictEqual(CORE.isClosingDistance('chase', 1.85, 1.9), false, 'arrived and holding');
  assert.strictEqual(CORE.isClosingDistance('chase', 3.0, 1.9), false, 'inside the slack band');
  assert.strictEqual(CORE.isClosingDistance('strafe', 25, 1.9), false, 'riflemen hold angles on purpose');
  assert.strictEqual(CORE.isClosingDistance('idle', 25, 1.9), false);
  assert.strictEqual(CORE.isClosingDistance('chase', 25, 2.6), true, 'tank stop distance');
});

test('stuck detector does not fire for a moving enemy', () => {
  const s = {};
  let x = 0;
  for (let i = 0; i < 200; i++) {
    x += 4.9 / 60;
    assert.strictEqual(CORE.updateStuck(s, x, 0, 1 / 60), 'ok');
  }
});

// ---------------------------------------------------------------- wave scaling
test('wave scaling matches the shipped curve', () => {
  assert.strictEqual(CORE.waveEnemyCount(1, 5, 2.5), 5);
  assert.strictEqual(CORE.waveEnemyCount(15, 5, 2.5), 40);
  assert.ok(Math.abs(CORE.waveHpMultiplier(1) - 1) < 1e-9);
  assert.ok(Math.abs(CORE.waveHpMultiplier(15) - 1.84) < 1e-9);
  assert.strictEqual(CORE.waveHpMultiplier(100), 2.2);             // capped
  assert.ok(Math.abs(CORE.waveRangedAccuracy(1, 0.5, 0.035, 0.75) - 0.535) < 1e-9);
  assert.strictEqual(CORE.waveRangedAccuracy(50, 0.5, 0.035, 0.75), 0.75);
});

// ---------------------------------------------------------------- PERF-02
test('ray grid returns every item the ray actually crosses', () => {
  const grid = CORE.buildRayGrid({ cell: 8, halfExtent: 56 });
  // three boxes strung along +x at z = 0
  CORE.rayGridInsert(grid, 0, 9, -1, 11, 1);
  CORE.rayGridInsert(grid, 1, 29, -1, 31, 1);
  CORE.rayGridInsert(grid, 2, 49, -1, 51, 1);
  CORE.rayGridInsert(grid, 3, 9, 39, 11, 41);      // far off-axis, must NOT be returned
  const out = [];
  CORE.rayGridQuery(grid, -50, 0, 1, 0, 120, out);
  const got = out.slice().sort();
  assert.deepStrictEqual(got, [0, 1, 2], 'on-axis boxes hit, off-axis box excluded');
});

test('ray grid never misses a box a brute-force scan would hit', () => {
  // Randomised cross-check against the ground truth the grid is meant to accelerate.
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boxes = [];
  const grid = CORE.buildRayGrid({ cell: 8, halfExtent: 56 });
  for (let i = 0; i < 150; i++) {
    const x = rand() * 90 - 45, z = rand() * 90 - 45;
    const w = 1 + rand() * 6, d = 1 + rand() * 6;
    const b = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
    boxes.push(b);
    CORE.rayGridInsert(grid, i, b.minX, b.minZ, b.maxX, b.maxZ);
  }
  // 2-D slab test: does the ray segment cross this box's XZ footprint?
  function segmentHitsBox(ox, oz, dx, dz, maxDist, b) {
    let t0 = 0, t1 = maxDist;
    for (const [o, d, lo, hi] of [[ox, dx, b.minX, b.maxX], [oz, dz, b.minZ, b.maxZ]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return false; continue; }
      let a = (lo - o) / d, c = (hi - o) / d;
      if (a > c) { const tmp = a; a = c; c = tmp; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, c);
      if (t0 > t1) return false;
    }
    return true;
  }
  const out = [];
  let checked = 0, totalCandidates = 0;
  for (let r = 0; r < 300; r++) {
    const ox = rand() * 90 - 45, oz = rand() * 90 - 45;
    const ang = rand() * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const maxDist = 120;
    CORE.rayGridQuery(grid, ox, oz, dx, dz, maxDist, out);
    const candidates = new Set(out);
    totalCandidates += out.length; checked++;
    for (let i = 0; i < boxes.length; i++) {
      if (segmentHitsBox(ox, oz, dx, dz, maxDist, boxes[i])) {
        assert.ok(candidates.has(i),
          `ray ${r} truly crosses box ${i} but the grid did not return it`);
      }
    }
  }
  // and it must actually narrow things down, or it is pointless
  const avg = totalCandidates / checked;
  assert.ok(avg < boxes.length * 0.6,
    `grid returned ${avg.toFixed(1)} of ${boxes.length} candidates on average — not narrowing enough`);
});

test('ray grid handles axis-aligned and degenerate rays without hanging', () => {
  const grid = CORE.buildRayGrid({ cell: 8, halfExtent: 56 });
  CORE.rayGridInsert(grid, 0, -1, -1, 1, 1);
  const out = [];
  CORE.rayGridQuery(grid, 0, -50, 0, 1, 120, out);      // straight +z
  assert.ok(out.includes(0));
  CORE.rayGridQuery(grid, -50, 0, 1, 0, 120, out);      // straight +x
  assert.ok(out.includes(0));
  CORE.rayGridQuery(grid, 0, 0, 0, 0, 120, out);        // zero direction: must terminate
  assert.ok(Array.isArray(out));
});

// ---------------------------------------------------------------- GAP-01 / GAP-02
test('settings fall back to defaults when storage is empty or junk', () => {
  const d = CORE.defaultSettings();
  assert.deepStrictEqual(CORE.sanitizeSettings(null), d);
  assert.deepStrictEqual(CORE.sanitizeSettings('not an object'), d);
  assert.deepStrictEqual(CORE.sanitizeSettings({}), d);
});

test('settings reject out-of-range and hostile stored values', () => {
  // localStorage is user-editable and survives across versions: a bad number here
  // would silently break aiming or blow out the audio bus.
  const s = CORE.sanitizeSettings({
    sensitivity: 9999, fov: -1, masterVolume: 12, quality: 'ultra',
    invertY: 'yes', muted: 'true', unknownKey: 'ignored'
  });
  assert.strictEqual(s.sensitivity, 4.0, 'clamped to max');
  assert.strictEqual(s.fov, 60, 'clamped to min');
  assert.strictEqual(s.masterVolume, 1, 'clamped to max');
  assert.strictEqual(s.quality, 'auto', 'unknown enum falls back to default');
  assert.strictEqual(s.invertY, false, 'non-boolean string falls back to default');
  assert.strictEqual(s.muted, true, '"true" is accepted');
  assert.ok(!('unknownKey' in s), 'unknown keys are dropped');
});

test('settings survive a save/load round trip through JSON', () => {
  const chosen = CORE.sanitizeSettings({ sensitivity: 1.75, fov: 95, muted: true, quality: 'low' });
  const round = CORE.sanitizeSettings(JSON.parse(JSON.stringify(chosen)));
  assert.deepStrictEqual(round, chosen);
});

test('quality auto restores adaptive pixel ratio and shadow settings after low', () => {
  const low = CORE.qualityRenderSettings('low', 2, false);
  const auto = CORE.qualityRenderSettings('auto', 2, false);
  assert.strictEqual(low.shadowEnabled, false);
  assert.strictEqual(auto.shadowEnabled, true);
  assert.strictEqual(auto.shadowType, 'PCFSoftShadowMap');
  assert.strictEqual(auto.pixelRatio, 1.5);
});

test('NaN and Infinity never reach a setting', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, {}, []]) {
    const s = CORE.sanitizeSettings({ sensitivity: bad, fov: bad, masterVolume: bad });
    assert.ok(isFinite(s.sensitivity) && s.sensitivity > 0, `sensitivity from ${String(bad)}`);
    assert.ok(isFinite(s.fov) && s.fov >= 60, `fov from ${String(bad)}`);
    assert.ok(isFinite(s.masterVolume) && s.masterVolume >= 0, `volume from ${String(bad)}`);
  }
});

test('look sensitivity scales with the setting and tightens while aiming', () => {
  const hip = CORE.lookSensitivity(1.0, 0);
  assert.ok(Math.abs(hip - CORE.BASE_SENSITIVITY) < 1e-12, 'default setting matches the original feel');
  assert.ok(Math.abs(CORE.lookSensitivity(2.0, 0) - hip * 2) < 1e-12, 'doubling the setting doubles it');
  assert.ok(CORE.lookSensitivity(1.0, 1) < hip, 'ADS is slower than the hip');
});

test('career stats record personal bests and report what was beaten', () => {
  let s = CORE.defaultStats();
  let r = CORE.mergeRunIntoStats(s, { score: 5000, wave: 7, accuracy: 41, kills: 60 });
  // `beat.rank` joined the contract when XP landed; the three records are what this
  // test is about, so assert on them by name rather than on the object's shape.
  assert.strictEqual(r.beat.score, true);
  assert.strictEqual(r.beat.wave, true);
  assert.strictEqual(r.beat.accuracy, true);
  assert.strictEqual(r.stats.bestScore, 5000);
  assert.strictEqual(r.stats.runs, 1);
  // a worse run must not regress any record, but still counts as a run
  r = CORE.mergeRunIntoStats(r.stats, { score: 100, wave: 2, accuracy: 12, kills: 5 });
  assert.strictEqual(r.beat.score, false);
  assert.strictEqual(r.beat.wave, false);
  assert.strictEqual(r.beat.accuracy, false);
  assert.strictEqual(r.stats.bestScore, 5000);
  assert.strictEqual(r.stats.bestWave, 7);
  assert.strictEqual(r.stats.runs, 2);
  assert.strictEqual(r.stats.totalKills, 65);
  // one record can fall without the others
  r = CORE.mergeRunIntoStats(r.stats, { score: 200, wave: 9, accuracy: 10, kills: 1 });
  assert.strictEqual(r.beat.score, false);
  assert.strictEqual(r.beat.wave, true);
  assert.strictEqual(r.beat.accuracy, false);
});

test('corrupt stored stats never produce a negative or NaN record', () => {
  const s = CORE.sanitizeStats({ bestScore: -50, bestWave: 'abc', bestAccuracy: NaN, runs: Infinity });
  assert.strictEqual(s.bestScore, 0);
  assert.strictEqual(s.bestWave, 0);
  assert.strictEqual(s.bestAccuracy, 0);
  assert.ok(isFinite(s.runs));
});

// ---------------------------------------------------------------- GAP-03 / GAP-04
test('behaviour unlocks escalate past the wave-8 accuracy cap', () => {
  // The old curve capped rifleman accuracy at wave 8, so waves 9-15 were the same
  // fight with more bodies. Difficulty past that point must come from behaviour.
  assert.deepStrictEqual(CORE.behavioursAtWave(1), {});
  assert.ok(CORE.behavioursAtWave(8).flanking, 'flanking by wave 8');
  assert.ok(CORE.behavioursAtWave(10).burstFire, 'bursts by wave 10');
  assert.ok(CORE.behavioursAtWave(12).enemyNades, 'grenades by wave 12');
  // strictly additive — a later wave never loses a behaviour
  let prev = 0;
  for (let w = 1; w <= 20; w++) {
    const n = Object.keys(CORE.behavioursAtWave(w)).length;
    assert.ok(n >= prev, `wave ${w} lost a behaviour`);
    prev = n;
  }
});

test('each behaviour is announced exactly once', () => {
  const seen = {};
  for (let w = 1; w <= 30; w++) {
    CORE.newBehavioursAtWave(w).forEach(b => {
      assert.ok(!seen[b.key], `${b.key} announced twice (wave ${w})`);
      seen[b.key] = true;
    });
  }
  assert.strictEqual(Object.keys(seen).length, CORE.BEHAVIOUR_UNLOCKS.length);
});

const kindsAt = (w) => {
  const s = new Set();
  for (let i = 0; i < 4000; i++) s.add(CORE.pickEnemyKind(w, i / 4000));
  return s;
};

test('enemy composition introduces kinds at the right waves and never earlier', () => {
  assert.deepStrictEqual([...kindsAt(1)].sort(), [0], 'wave 1 is runners only');
  assert.ok(kindsAt(2).has(1), 'riflemen from wave 2');
  assert.ok(!kindsAt(2).has(4), 'no scouts before wave 3');
  assert.ok(kindsAt(3).has(4), 'scouts from wave 3');
  assert.ok(!kindsAt(3).has(2), 'no tanks before wave 4');
  assert.ok(kindsAt(4).has(2), 'tanks from wave 4');
  assert.ok(!kindsAt(5).has(5), 'no grenadiers before wave 6');
  assert.ok(kindsAt(6).has(5), 'grenadiers from wave 6');
  assert.ok(!kindsAt(8).has(3), 'no shielded before wave 9');
  assert.ok(kindsAt(9).has(3), 'shielded from wave 9');
});

test('every unlocked enemy kind actually gets rolled, none is starved', () => {
  // Weights rather than nested thresholds specifically so adding a kind cannot
  // silently squeeze an existing one out of the distribution.
  for (const wave of [1, 3, 4, 6, 9, 15, 30]) {
    const expected = CORE.enemyKindsAtWave(wave).map(e => e.kind).sort();
    const got = [...kindsAt(wave)].sort();
    assert.deepStrictEqual(got, expected,
      `wave ${wave} should roll exactly ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }
});

test('enemy kind distribution is sane: runners stay common, specials stay rare', () => {
  const counts = {};
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const k = CORE.pickEnemyKind(12, i / N);
    counts[k] = (counts[k] || 0) + 1;
  }
  const frac = (k) => (counts[k] || 0) / N;
  assert.ok(frac(0) > 0.2, 'runners remain the backbone');
  assert.ok(frac(3) < 0.25, 'shielded units stay a minority');
  assert.ok(frac(2) < 0.2, 'tanks stay rare');
  for (const e of CORE.enemyKindsAtWave(12)) {
    assert.ok(frac(e.kind) > 0.03, `${e.name} is too rare to ever be seen (${frac(e.kind)})`);
  }
});

test('each enemy kind is announced exactly once, and never at wave 1', () => {
  const seen = {};
  for (let w = 1; w <= 30; w++) {
    CORE.newEnemyKindsAtWave(w).forEach(e => {
      assert.ok(!seen[e.kind], `${e.name} announced twice`);
      assert.ok(w > 1, 'wave 1 introduces nothing — it is the baseline');
      seen[e.kind] = true;
    });
  }
  assert.strictEqual(Object.keys(seen).length, CORE.ENEMY_KIND_UNLOCK.length - 1);
});

test('pickEnemyKind tolerates out-of-range rolls', () => {
  for (const r of [-1, 0, 0.999999, 1, 2, NaN]) {
    const k = CORE.pickEnemyKind(12, r);
    assert.ok(CORE.enemyKindsAtWave(12).some(e => e.kind === k), `roll ${r} gave kind ${k}`);
  }
});

test('difficulty presets are ordered and never zero out a multiplier', () => {
  const r = CORE.difficulty('recruit'), n = CORE.difficulty('regular'), v = CORE.difficulty('veteran');
  assert.ok(r.dmg < n.dmg && n.dmg < v.dmg, 'damage rises with difficulty');
  assert.ok(r.hp < n.hp && n.hp < v.hp, 'enemy health rises with difficulty');
  assert.ok(r.regen > n.regen && n.regen > v.regen, 'regen falls as difficulty rises');
  for (const d of [r, n, v]) {
    for (const k of ['hp', 'dmg', 'count', 'regen']) assert.ok(d[k] > 0, `${k} must stay positive`);
  }
  assert.strictEqual(CORE.difficulty('nonsense').label, 'REGULAR', 'unknown key falls back');
});

// ---------------------------------------------------------------- GAP-05
test('endless mode keeps scaling past the victory wave instead of stopping', () => {
  const V = 15;
  assert.strictEqual(CORE.endlessHpMultiplier(10, V), CORE.waveHpMultiplier(10), 'unchanged below the cap');
  const at15 = CORE.endlessHpMultiplier(15, V);
  const at20 = CORE.endlessHpMultiplier(20, V);
  const at30 = CORE.endlessHpMultiplier(30, V);
  assert.ok(at20 > at15 && at30 > at20, 'keeps rising past the victory wave');
});

test('endless enemy count is capped so a wave cannot become unplayable', () => {
  const c = CORE.endlessEnemyCount(200, 5, 2.5, 15, 60);
  assert.strictEqual(c, 60);
  assert.ok(CORE.endlessEnemyCount(5, 5, 2.5, 15, 60) < 60);
});

test('victory checkpoint resume remains a settled victory until endless is chosen', () => {
  assert.deepStrictEqual(CORE.resumeCheckpointState('victory'), {
    phase: 'victory', gameEnded: true, showVictory: true
  });
  assert.deepStrictEqual(CORE.resumeCheckpointState('endless'), {
    phase: 'endless', gameEnded: false, showVictory: false
  });
});

test('endless settlement separates incremental rewards from absolute records', () => {
  const snapshot = { score: 1000, kills: 10, headshots: 2, streaks: 1 };
  const settled = CORE.settlementAccounting(snapshot, {
    score: 3400, wave: 19, accuracy: 73, kills: 15, headshots: 3, streaks: 2
  });
  assert.deepStrictEqual(settled.rewards, {
    score: 2400, wave: 0, accuracy: 0, kills: 5, headshots: 1, streaks: 1
  });
  assert.deepStrictEqual(settled.records, { score: 3400, wave: 19, accuracy: 73 });

  const first = CORE.mergeRunIntoStats(CORE.defaultStats(), {
    score: 1000, wave: 15, accuracy: 50, kills: 10, headshots: 2, victory: true
  });
  const second = CORE.mergeRunIntoStats(first.stats, Object.assign({}, settled.rewards, {
    recordScore: settled.records.score, recordWave: settled.records.wave,
    recordAccuracy: settled.records.accuracy,
    countRun: false, victory: false
  }));
  assert.strictEqual(second.stats.runs, 1);
  assert.strictEqual(second.stats.totalKills, 15);
  assert.ok(second.stats.bestWave >= 19, 'endless progress updates best wave');
  assert.ok(second.stats.bestAccuracy >= 73, 'endless progress updates best accuracy');
  assert.ok(second.stats.xp > first.stats.xp, 'new endless kills/rewards can earn XP');
});

test('re-settling an unchanged endless checkpoint is idempotent', () => {
  const accounting = CORE.settlementAccounting(
    { score: 1000, kills: 10, headshots: 2, streaks: 1 },
    { score: 1000, wave: 15, accuracy: 50, kills: 10, headshots: 2, streaks: 1 }
  );
  assert.deepStrictEqual(accounting.rewards, {
    score: 0, wave: 0, accuracy: 0, kills: 0, headshots: 0, streaks: 0
  });
});

// ---------------------------------------------------------------- GAP-02 (save)
test('checkpoint persists settlement phase, baseline, and streak progress', () => {
  const cp = CORE.makeCheckpoint({
    wave: 15, score: 12000, kills: 90, headshots: 20, shotsFired: 400, shotsHit: 180,
    health: 64, armor: 30, grenades: 2, difficulty: 'veteran', endless: true,
    runPhase: 'endless', settlementSnapshot: { kills: 90, headshots: 20, streaks: 4 },
    streakKills: 7, runStreaksEarned: 4,
    weapons: [{ gi: 0, ammo: 12, reserve: 90 }]
  });
  const back = CORE.validateCheckpoint(JSON.parse(JSON.stringify(cp)), 4);
  assert.strictEqual(back.runPhase, 'endless');
  assert.deepStrictEqual(back.settlementSnapshot, { kills: 90, headshots: 20, streaks: 4 });
  assert.strictEqual(back.streakKills, 7);
  assert.strictEqual(back.runStreaksEarned, 4);
});

test('a checkpoint round-trips through JSON', () => {
  const cp = CORE.makeCheckpoint({
    wave: 7, score: 12000, kills: 90, headshots: 20, shotsFired: 400, shotsHit: 180,
    health: 64, armor: 30, grenades: 2, difficulty: 'veteran', endless: false,
    weapons: [{ gi: 0, ammo: 12, reserve: 90, up: { dmg: 46.8, mag: 35, reserveMax: 240, name: 'M4 UPGRADED', upgraded: true } }, { gi: 1, ammo: 32, reserve: 160 }],
    openDistricts: ['ne'], equipment: { lethal: 'semtex', tactical: 'flash', tacticalCount: 2, fieldCharge: 50, streakBank: ['uav'] }, savedAt: 123
  });
  const back = CORE.validateCheckpoint(JSON.parse(JSON.stringify(cp)), 4);
  assert.strictEqual(back.wave, 7);
  assert.strictEqual(back.difficulty, 'veteran');
  assert.strictEqual(back.weapons[1].reserve, 160);
  assert.strictEqual(back.weapons[0].up.dmg, 46.8);
  assert.deepStrictEqual(back.openDistricts, ['ne']);
  assert.strictEqual(back.equipment.tacticalCount, 2);
  assert.deepStrictEqual(back.equipment.streakBank, ['uav']);
  assert.strictEqual(back.health, 64);
});

test('restored purchased weapons rebuild every authoritative runtime field from config', () => {
  const weaponConfig = [
    { name: 'M4 Carbine', type: 'AR', dmg: 26, rpm: 750, mag: 30, reserveMax: 150,
      reload: 2.1, spread: 0.014, adsSpread: 0.004, recoilV: 0.014, recoilH: 0.006,
      range: 120, auto: true },
    { name: 'MK18 Mod1', type: 'SMG', dmg: 18, rpm: 900, mag: 32, reserveMax: 160,
      reload: 1.9, spread: 0.020, adsSpread: 0.008, recoilV: 0.009, recoilH: 0.005,
      range: 80, auto: true }
  ];
  const raw = {
    v: CORE.SAVE_VERSION, wave: 4,
    weapons: [{ gi: 1, ammo: 7, reserve: 41,
      up: { dmg: 32.4, mag: 48, reserveMax: 240, name: 'MK18 MODDED', upgraded: true } }]
  };
  const back = CORE.validateCheckpoint(JSON.parse(JSON.stringify(raw)), weaponConfig);
  const restored = back.weapons[0].up;
  assert.strictEqual(restored.type, 'SMG');
  assert.strictEqual(restored.rpm, 900);
  assert.strictEqual(restored.reload, 1.9);
  assert.strictEqual(restored.spread, 0.020);
  assert.strictEqual(restored.auto, true);
  assert.strictEqual(restored.dmg, 32.4);
  assert.strictEqual(restored.mag, 48);
  assert.strictEqual(restored.reserveMax, 240);
});

test('a corrupt, hostile or stale checkpoint is rejected rather than loaded', () => {
  assert.strictEqual(CORE.validateCheckpoint(null, 4), null);
  assert.strictEqual(CORE.validateCheckpoint('nope', 4), null);
  assert.strictEqual(CORE.validateCheckpoint({}, 4), null, 'no version');
  assert.strictEqual(CORE.validateCheckpoint({ v: 1, wave: 3, weapons: [{ gi: 0 }] }, 4), null, 'old version dropped');
  assert.strictEqual(CORE.validateCheckpoint({ v: CORE.SAVE_VERSION, wave: 3 }, 4), null, 'no weapons');
  assert.strictEqual(CORE.validateCheckpoint({ v: CORE.SAVE_VERSION, wave: 3, weapons: [] }, 4), null, 'empty weapons');
  assert.strictEqual(CORE.validateCheckpoint({ v: CORE.SAVE_VERSION, wave: 3, weapons: [null] }, 4), null, 'no primary');
});

test('checkpoint preserves health above base max when Juggernaut is persisted', () => {
  const cp = CORE.makeCheckpoint({
    wave: 4, health: 150, perks: ['jugg'], weapons: [{ gi: 0, ammo: 12, reserve: 90 }]
  });
  const back = CORE.validateCheckpoint(JSON.parse(JSON.stringify(cp)), 4, 100);
  assert.strictEqual(back.health, CORE.perkMaxHealth(100, ['jugg']));
});

test('checkpoint values are clamped, so an edited save cannot break a run', () => {
  const cp = CORE.validateCheckpoint({
    v: CORE.SAVE_VERSION, wave: 9e9, score: -5, health: 9999, armor: -3, grenades: 999,
    difficulty: 'godmode', weapons: [{ gi: 99, ammo: -10, reserve: 1e9 }]
  }, 4);
  assert.ok(cp, 'a clampable save still loads');
  assert.ok(cp.wave <= 999 && cp.wave >= 1);
  assert.strictEqual(cp.score, 0);
  assert.strictEqual(cp.health, 100);
  assert.strictEqual(cp.armor, 0);
  assert.ok(cp.grenades <= 9);
  assert.strictEqual(cp.difficulty, 'regular', 'unknown difficulty falls back');
  assert.ok(cp.weapons[0].gi <= 3, 'weapon index clamped to the roster');
  assert.strictEqual(cp.weapons[0].ammo, 0);
});

test('BUG-02 regression: every enemy kind has a stop distance, none can reach the player', () => {
  // A grenadier archetype added in phase 4 was left out of the hand-maintained
  // stop-and-hold list and walked straight into the player (1146 frames inside
  // the body in a 150 s run). The rule is now table-driven and covers every kind.
  for (const e of CORE.ENEMY_KIND_UNLOCK) {
    const d = CORE.enemyStopDistance(e.kind);
    assert.ok(d >= 1.5, `${e.name} stop distance ${d} is too small to keep it out of the player`);
  }
  assert.ok(CORE.enemyStopDistance(2) > CORE.enemyStopDistance(0), 'tanks hold further out than runners');
  assert.ok(CORE.enemyStopDistance(999) >= 1.5, 'an unknown kind still gets a safe default');
});

test('grenadiers prefer range and everyone else closes', () => {
  assert.ok(CORE.enemyPreferredRange(5) > 10, 'grenadiers hold a throwing distance');
  for (const e of CORE.ENEMY_KIND_UNLOCK) {
    if (e.kind === 5) continue;
    assert.strictEqual(CORE.enemyPreferredRange(e.kind), 0, `${e.name} should close, not hold range`);
  }
});

test('flank bias tapers to zero on approach so flankers commit instead of orbiting', () => {
  // A hard cutoff left a ring at the cutoff radius where a scout circled forever
  // (observed: one of six stalled at 9.6 m for 40 s).
  assert.strictEqual(CORE.flankBias(30), 1, 'full bias at long range');
  assert.strictEqual(CORE.flankBias(4), 0, 'no bias once close');
  assert.strictEqual(CORE.flankBias(6), 0, 'zero exactly at the inner edge');
  const mid = CORE.flankBias(12);
  assert.ok(mid > 0 && mid < 1, 'partial bias in between');
  // monotonic, so there is no radius where turning away is favoured
  let prev = -1;
  for (let d = 0; d <= 30; d += 0.5) {
    const b = CORE.flankBias(d);
    assert.ok(b >= prev - 1e-12, `bias dipped at ${d} m`);
    prev = b;
  }
});

test('flanking is time-boxed so a fast agent cannot orbit forever', () => {
  // Scouts always flank, and with a permanent bias only 75% of them ever reached
  // the player. The window forces a commit.
  assert.ok(CORE.flankWindow(0) >= CORE.FLANK_WINDOW[0]);
  assert.ok(CORE.flankWindow(1) <= CORE.FLANK_WINDOW[1]);
  assert.ok(CORE.FLANK_WINDOW[0] > 0 && CORE.FLANK_WINDOW[1] > CORE.FLANK_WINDOW[0]);
  // while the window is open, bias follows distance
  assert.strictEqual(CORE.flankBiasNow(3, 30), 1);
  assert.strictEqual(CORE.flankBiasNow(3, 4), 0, 'still zero when close');
  // once it expires, no bias at any distance
  for (const d of [4, 10, 30, 100]) {
    assert.strictEqual(CORE.flankBiasNow(0, d), 0, `expired window still biased at ${d} m`);
    assert.strictEqual(CORE.flankBiasNow(-2, d), 0);
  }
});

// ---------------------------------------------------------------- GAP-07
test('combat intensity is silent out of combat and rises with pressure', () => {
  assert.strictEqual(CORE.combatIntensity({ inCombat: false, aliveEnemies: 9 }), 0,
    'between waves the score must settle, not keep pounding');
  assert.strictEqual(CORE.combatIntensity(null), 0);
  const calm = CORE.combatIntensity({ inCombat: true, aliveEnemies: 1, nearestEnemy: 30, health: 100 });
  const busy = CORE.combatIntensity({ inCombat: true, aliveEnemies: 6, nearestEnemy: 30, health: 100 });
  const close = CORE.combatIntensity({ inCombat: true, aliveEnemies: 6, nearestEnemy: 5, health: 100 });
  const dying = CORE.combatIntensity({ inCombat: true, aliveEnemies: 6, nearestEnemy: 5, health: 15 });
  assert.ok(busy > calm, 'more enemies is more intense');
  assert.ok(close > busy, 'closer enemies is more intense');
  assert.ok(dying > close, 'being hurt is more intense');
});

test('combat intensity stays in 0..1 for any input, including nonsense', () => {
  const cases = [
    { inCombat: true, aliveEnemies: 9999, nearestEnemy: -50, health: -100 },
    { inCombat: true, aliveEnemies: 0, nearestEnemy: 1e9, health: 1e9 },
    { inCombat: true },
    { inCombat: true, aliveEnemies: NaN, nearestEnemy: NaN, health: NaN }
  ];
  for (const c of cases) {
    const v = CORE.combatIntensity(c);
    assert.ok(v >= 0 && v <= 1 && isFinite(v), `intensity ${v} out of range for ${JSON.stringify(c)}`);
  }
});

// ---------------------------------------------------------------- ammo economy
test('ammo drops are guaranteed once the player is effectively dry', () => {
  // A flat 30% roll soft-locked runs: empty both weapons, and you can no longer
  // get the kills that produce drops, nor reach the wave clear that resupplies.
  assert.strictEqual(CORE.ammoDropChance(0, 30), 1, 'completely dry must always drop');
  assert.strictEqual(CORE.ammoDropChance(15, 30), 1, 'half a magazine is dry enough');
  assert.ok(CORE.ammoDropChance(90, 30) <= 0.31, 'three magazines is comfortable: base odds');
  assert.ok(CORE.ammoDropChance(400, 30) <= 0.31, 'plenty of ammo does not inflate drops');
});

test('ammo drop chance rises monotonically as the player runs dry', () => {
  let prev = 0;
  for (let rounds = 180; rounds >= 0; rounds -= 5) {
    const c = CORE.ammoDropChance(rounds, 30);
    assert.ok(c >= prev - 1e-12, `chance dipped at ${rounds} rounds (${c} < ${prev})`);
    assert.ok(c >= 0 && c <= 1, `chance ${c} out of range`);
    prev = c;
  }
});

test('ammo drop chance handles odd magazine sizes and junk input', () => {
  assert.strictEqual(CORE.ammoDropChance(0, 5), 1, 'sniper: 0 rounds still guarantees');
  assert.ok(CORE.ammoDropChance(35, 5) <= 0.31, 'seven sniper magazines is comfortable');
  for (const mag of [0, -1, undefined, NaN]) {
    const c = CORE.ammoDropChance(10, mag);
    assert.ok(isFinite(c) && c >= 0 && c <= 1, `bad mag size ${mag} gave ${c}`);
  }
});

test('progress tracking catches an agent that circles without ever arriving', () => {
  // updateStuck only catches an agent that stops moving. One that orbits the
  // player moves constantly while never closing, and the wave waits on it forever.
  const s = {};
  assert.strictEqual(CORE.updateProgress(s, 30, 0.1), 'ok', 'first sample anchors');
  // closing steadily: never flagged
  for (let d = 29; d > 3; d -= 0.5) {
    assert.strictEqual(CORE.updateProgress(s, d, 0.1), 'ok', `flagged while closing at ${d}`);
  }
  // now orbit at a fixed distance
  const orbit = {};
  CORE.updateProgress(orbit, 12, 0.1);
  let flagged = false;
  for (let i = 0; i < 200; i++) {
    if (CORE.updateProgress(orbit, 12 + Math.sin(i) * 0.4, 0.1) === 'reposition') flagged = true;
  }
  assert.ok(flagged, 'an orbiting agent must eventually be repositioned');
});

test('progress tracking does not fire for slow but real progress', () => {
  const s = {};
  CORE.updateProgress(s, 40, 1 / 60);
  let flagged = false;
  // 0.25 m/s toward the player — slow, but genuinely arriving
  for (let d = 40; d > 2; d -= 0.25 / 60) {
    if (CORE.updateProgress(s, d, 1 / 60) === 'reposition') flagged = true;
  }
  assert.ok(!flagged, 'steady approach must never be treated as a stall');
});

// ---------------------------------------------------------------- LOS occlusion
test('segment occlusion detects a wall between two points', () => {
  const wall = [{ min: { x: -5, y: 0, z: -0.4 }, max: { x: 5, y: 4, z: 0.4 } }];
  // straight through the wall
  assert.strictEqual(CORE.segmentBlocked(0, 1.5, -6, 0, 1.5, 6, wall), true);
  // around the end of it
  assert.strictEqual(CORE.segmentBlocked(9, 1.5, -6, 9, 1.5, 6, wall), false);
  // over the top
  assert.strictEqual(CORE.segmentBlocked(0, 6, -6, 0, 6, 6, wall), false);
  // parallel to it, never crossing
  assert.strictEqual(CORE.segmentBlocked(-6, 1.5, 3, 6, 1.5, 3, wall), false);
});

test('segment occlusion agrees with the real arena geometry', () => {
  // Through the central building from one side to the other: blocked.
  assert.strictEqual(CORE.segmentBlocked(0, 1.5, -25, 0, 1.5, 25, ARENA), true);
  // Open ground well away from anything: clear.
  assert.strictEqual(CORE.segmentBlocked(-40, 1.5, 15, -40, 1.5, 25, ARENA), false);
});

test('segment occlusion ignores geometry beyond the endpoint', () => {
  const farWall = [{ min: { x: -5, y: 0, z: 20 }, max: { x: 5, y: 4, z: 21 } }];
  // target stops short of the wall
  assert.strictEqual(CORE.segmentBlocked(0, 1.5, 0, 0, 1.5, 10, farWall), false);
  // target past it
  assert.strictEqual(CORE.segmentBlocked(0, 1.5, 0, 0, 1.5, 30, farWall), true);
});

test('segment occlusion handles degenerate and axis-aligned rays', () => {
  const box = [{ min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } }];
  assert.strictEqual(CORE.segmentBlocked(0, 1, 0, 0, 1, 0, box), false, 'zero-length segment');
  assert.strictEqual(CORE.segmentBlocked(0, 1, -5, 0, 1, 5, box), true, 'straight +z');
  assert.strictEqual(CORE.segmentBlocked(-5, 1, 0, 5, 1, 0, box), true, 'straight +x');
  assert.strictEqual(CORE.segmentBlocked(0, -5, 0, 0, 5, 0, box), true, 'straight +y');
  assert.strictEqual(CORE.segmentBlocked(0, 9, -5, 0, 9, 5, box), false, 'passes above');
});


// ---- BUG-11: ceiling resolve -------------------------------------------------
// The old resolveVertical() zeroed upward velocity on a head bonk but never moved
// the head back out of the slab, so a long frame or a boosted jump could carry it
// through. These pin the replacement's contract.

test('BUG-11 nothing overhead leaves the eye untouched', () => {
  assert.strictEqual(CORE.ceilingClamp(2.5, 0, Infinity, 1.7, 0.2), 2.5);
});

test('BUG-11 a head below the ceiling is not pulled down', () => {
  // eye 2.5 -> head 2.7, slab starts at 3.65: clear, leave it alone.
  assert.strictEqual(CORE.ceilingClamp(2.5, 0, 3.65, 1.7, 0.2), 2.5);
});

test('BUG-11 a head inside the ceiling is pushed back under it', () => {
  // eye 3.6 -> head 3.8, slab bottom 3.65. Clamp the eye to 3.45 so the head
  // sits exactly at the slab, instead of merely stopping the velocity.
  assert.ok(Math.abs(CORE.ceilingClamp(3.6, 0, 3.65, 1.7, 0.2) - 3.45) < 1e-9);
});

test('BUG-11 a head already past the ceiling is pulled back, not left through', () => {
  // This is the actual bug: one big dt puts the eye above the slab entirely.
  // Zeroing velocity there would strand the player inside the geometry.
  const out = CORE.ceilingClamp(5.0, 0, 3.65, 1.7, 0.2);
  assert.ok(Math.abs(out - 3.45) < 1e-9);
  assert.ok(out + 0.2 <= 3.65 + 1e-9, 'head must end up at or below the slab');
});

test('BUG-11 standing on the floor beats clearing the ceiling', () => {
  // A crawlspace shorter than the player: clamping to clear the slab would put
  // the eye at 0.8 - 0.2 = 0.6, below the 1.7 the floor demands. Sinking the
  // camera into the ground is worse than a head in a slab, so the floor wins.
  assert.strictEqual(CORE.ceilingClamp(1.7, 0, 0.8, 1.7, 0.2), 1.7);
});

test('BUG-11 the clamp is relative to the floor being stood on', () => {
  // Standing on a 2 m crate under a 5 m slab: eye 5.2 -> clamp to 4.8.
  assert.strictEqual(CORE.ceilingClamp(5.2, 2, 5.0, 1.7, 0.2), 4.8);
  // Same crate, slab too low to fit under: hold at the crate top + eye height.
  assert.strictEqual(CORE.ceilingClamp(3.7, 2, 3.0, 1.7, 0.2), 3.7);
});

test('BUG-11 crouching changes the clearance the clamp allows', () => {
  // Crouched eye height 1.1: a 2.0 m slab is passable standing? No - clamp to 1.8.
  assert.strictEqual(CORE.ceilingClamp(2.4, 0, 2.0, 1.1, 0.2), 1.8);
});


// ---- Shadow budget -----------------------------------------------------------
// Each casting enemy is drawn twice (colour pass + shadow pass), so at a wave-15
// load the soldiers cost more draw calls than the entire static arena.

test('shadow budget keeps everything when the roster fits', () => {
  const pos = [{ x: 0, z: 0 }, { x: 5, z: 5 }, { x: 9, z: 1 }];
  const keep = CORE.shadowCasters(pos, 0, 0, 8);
  assert.strictEqual(keep.length, 3);
  assert.deepStrictEqual(keep.slice().sort(), [0, 1, 2]);
});

test('shadow budget keeps the nearest enemies, not the first ones', () => {
  //                       far        near       mid
  const pos = [{ x: 40, z: 0 }, { x: 2, z: 0 }, { x: 10, z: 0 }];
  const keep = CORE.shadowCasters(pos, 0, 0, 2);
  assert.deepStrictEqual(keep, [1, 2], 'nearest first, far one dropped');
});

test('shadow budget never returns more than the budget', () => {
  const pos = [];
  for (let i = 0; i < 14; i++) pos.push({ x: i * 3, z: 0 });
  assert.strictEqual(CORE.shadowCasters(pos, 0, 0, 4).length, 4);
  assert.strictEqual(CORE.shadowCasters(pos, 0, 0, 8).length, 8);
});

test('shadow budget measures horizontally, like every other gameplay radius', () => {
  // y is ignored: an enemy on a rooftop directly overhead is NEAR, not far.
  const pos = [{ x: 0, y: 12, z: 1 }, { x: 30, y: 0, z: 0 }];
  assert.deepStrictEqual(CORE.shadowCasters(pos, 0, 0, 1), [0]);
});

test('shadow budget handles an empty roster', () => {
  assert.deepStrictEqual(CORE.shadowCasters([], 0, 0, 8), []);
});

// ============================================================================
// Phase 9 — gunfeel
// ============================================================================

// ---- Recoil patterns (GUN-01) ----
// The point of a pattern is that it can be LEARNED. The shipped model was
// zero-mean random horizontally, so these tests would have been impossible to
// write against it — which is the defect stated as a test.
test('recoil pattern is deterministic with no jitter', () => {
  const a = [], b = [];
  for (let i = 0; i < 12; i++) {
    a.push(CORE.recoilAt('ar', i, 0, 0));
    b.push(CORE.recoilAt('ar', i, 0, 0));
  }
  assert.deepStrictEqual(a, b, 'the same burst must trace the same shape');
});

test('recoil pattern holds at its last entry instead of wrapping', () => {
  const p = CORE.RECOIL_PATTERNS.ar;
  const last = CORE.recoilAt('ar', p.length - 1, 0, 0);
  for (const i of [p.length, p.length + 5, 400]) {
    assert.deepStrictEqual(CORE.recoilAt('ar', i, 0, 0), last,
      'a long burst must settle into a steady drift, not wrap to shot 1');
  }
});

test('recoil pattern climbs before it drifts', () => {
  // The M4 shape: nearly straight up for the first few, leaning right later.
  const early = CORE.recoilAt('ar', 1, 0, 0);
  const late = CORE.recoilAt('ar', 8, 0, 0);
  assert.ok(Math.abs(early.x) < 0.2, 'early shots are near-vertical');
  assert.ok(late.x > 0.5, 'late shots lean right');
  assert.ok(late.y < early.y, 'vertical kick eases off as the drift takes over');
});

test('recoil jitter stays inside the declared band', () => {
  for (let i = 0; i < CORE.RECOIL_PATTERNS.smg.length; i++) {
    const base = CORE.recoilAt('smg', i, 0, 0);
    for (const j of [-1, -0.5, 0.5, 1]) {
      const k = CORE.recoilAt('smg', i, j, j);
      assert.ok(Math.abs(k.y - base.y) <= Math.abs(base.y) * CORE.RECOIL_JITTER + 1e-9);
      assert.ok(Math.abs(k.x - base.x) <= Math.abs(base.x) * CORE.RECOIL_JITTER + 1e-9);
    }
  }
});

test('recoil index resets between bursts but not inside one', () => {
  assert.strictEqual(CORE.recoilShotIndex(6, 0.08), 7, 'inside a burst the index advances');
  assert.strictEqual(CORE.recoilShotIndex(6, 0.9), 0, 'after a gap, shot 1 is shot 1 again');
  assert.strictEqual(CORE.recoilShotIndex(6, CORE.RECOIL_RESET), 0, 'boundary resets');
});

test('every weapon type maps to a real pattern', () => {
  for (const t of ['AR', 'SMG', 'BR', 'SR']) {
    const key = CORE.recoilPatternFor(t);
    assert.ok(CORE.RECOIL_PATTERNS[key], t + ' must have a pattern');
  }
  assert.strictEqual(CORE.recoilPatternFor('nonsense'), 'ar', 'unknown types fall back, never crash');
});

// ---- Recoil absorption (GUN-01, second half) ----
test('pulling down against recoil cancels it instead of stacking', () => {
  const r = CORE.absorbRecoil(0.05, -0.02);
  assert.ok(Math.abs(r.offset - 0.03) < 1e-9, 'the kick shrinks by what the player pulled');
  assert.strictEqual(r.delta, 0, 'and none of that pull reaches the real aim');
});

test('over-compensating passes the remainder through to the aim', () => {
  const r = CORE.absorbRecoil(0.02, -0.05);
  assert.strictEqual(r.offset, 0, 'the kick is fully cancelled');
  assert.ok(Math.abs(r.delta - -0.03) < 1e-9, 'the excess still moves the aim');
});

test('same-sign input is never absorbed', () => {
  // Looking further UP while the gun is kicking up is the player choosing to;
  // absorbing it would fight their input.
  const r = CORE.absorbRecoil(0.05, 0.02);
  assert.strictEqual(r.offset, 0.05);
  assert.strictEqual(r.delta, 0.02);
});

test('recoil absorption works in both directions', () => {
  const r = CORE.absorbRecoil(-0.04, 0.03);
  assert.ok(Math.abs(r.offset - -0.01) < 1e-9);
  assert.strictEqual(r.delta, 0);
});

// ---- Bloom (GUN-02) ----
test('bloom grows per shot and stops at the cap', () => {
  const bp = CORE.bloomParams(0.014, 0.004, false);
  let b = 0;
  for (let i = 0; i < 200; i++) b = CORE.bloomAfterShot(b, bp.perShot, bp.cap);
  assert.ok(Math.abs(b - bp.cap) < 1e-12, 'sustained fire reaches the ceiling and stays there');
});

test('bloom recovers to zero off the trigger', () => {
  const bp = CORE.bloomParams(0.014, 0.004, false);
  let b = bp.cap;
  for (let i = 0; i < 600; i++) b = CORE.bloomDecay(b, 1 / 60, bp.recover);
  assert.strictEqual(b, 0, 'and never goes negative');
});

test('tap-firing is more accurate than holding', () => {
  // The defect stated as a test: before bloom existed these two were identical.
  const bp = CORE.bloomParams(0.014, 0.004, false);
  let held = 0, tapped = 0;
  for (let i = 0; i < 10; i++) {
    held = CORE.bloomAfterShot(held, bp.perShot, bp.cap);
    tapped = CORE.bloomAfterShot(tapped, bp.perShot, bp.cap);
    tapped = CORE.bloomDecay(tapped, 0.25, bp.recover);   // pause between taps
  }
  assert.ok(tapped < held, 'a tapped burst must end tighter than a held one');
  assert.ok(CORE.effectiveSpread(0.014, tapped, 0, false) <
            CORE.effectiveSpread(0.014, held, 0, false));
});

test('ADS caps bloom far tighter than hipfire', () => {
  const hip = CORE.bloomParams(0.014, 0.004, false);
  const ads = CORE.bloomParams(0.014, 0.004, true);
  assert.ok(ads.cap < hip.cap * 0.2, 'aiming is the accurate option, not just the zoomed one');
});

test('movement and airborne still widen the cone', () => {
  const still = CORE.effectiveSpread(0.014, 0, 0, false);
  assert.ok(CORE.effectiveSpread(0.014, 0, 6, false) > still, 'running widens it');
  assert.ok(CORE.effectiveSpread(0.014, 0, 0, true) > still, 'jumping widens it');
});

// ---- Penetration (GUN-03) ----
function box(x, y, z, w, h, d, mat) {
  return { min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
           max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 }, mat: mat };
}

test('plywood and concrete are no longer the same cover', () => {
  const wood = [box(0, 1, 5, 4, 2, 0.8, 'wood')];
  const conc = [box(0, 1, 5, 4, 2, 0.8, 'concrete')];
  const power = CORE.penetrationPower('AR');
  const w = CORE.penetrationWalk(0, 1, 0, 0, 0, 1, 60, wood, power);
  const c = CORE.penetrationWalk(0, 1, 0, 0, 0, 1, 60, conc, power);
  assert.ok(CORE.penetrationMulAt(w, 10) > 0, 'an AR punches plywood');
  assert.strictEqual(CORE.penetrationMulAt(c, 10), 0, 'and is stopped by concrete');
});

test('a wallbang always does less damage than a clean shot', () => {
  const boxes = [box(0, 1, 5, 4, 2, 0.8, 'wood')];
  const walk = CORE.penetrationWalk(0, 1, 0, 0, 0, 1, 60, boxes, CORE.penetrationPower('AR'));
  const through = CORE.penetrationMulAt(walk, 10);
  assert.ok(through > 0 && through < 1,
    'shooting through cover must be a real option and never the better one');
  assert.strictEqual(CORE.penetrationMulAt(walk, 2), 1, 'a target in front of the wall is unaffected');
});

test('penetration budget scales with weapon class', () => {
  const boxes = [box(0, 1, 5, 4, 2, 0.8, 'wood'), box(0, 1, 10, 4, 2, 0.8, 'concrete')];
  const at = (t) => CORE.penetrationMulAt(
    CORE.penetrationWalk(0, 1, 0, 0, 0, 1, 60, boxes, CORE.penetrationPower(t)), 20);
  assert.strictEqual(at('SMG'), 0, 'an SMG does not get through wood AND concrete');
  assert.strictEqual(at('AR'), 0);
  assert.ok(at('SR') > 0, 'a marksman round does');
});

test('penetration stops at the declared surface limit', () => {
  const boxes = [];
  for (let i = 1; i <= 6; i++) boxes.push(box(0, 1, i * 3, 4, 2, 0.2, 'glass'));
  const walk = CORE.penetrationWalk(0, 1, 0, 0, 0, 1, 60, boxes, 99);
  assert.strictEqual(walk.tiers.length, CORE.MAX_PENETRATIONS,
    'budget alone must not allow unlimited pass-through');
  assert.strictEqual(CORE.penetrationMulAt(walk, 50), 0);
});

test('an unobstructed shot is untouched by the penetration path', () => {
  const walk = CORE.penetrationWalk(0, 1, 0, 0, 0, 1, 60, [], CORE.penetrationPower('AR'));
  assert.strictEqual(CORE.penetrationMulAt(walk, 40), 1);
  assert.strictEqual(walk.tiers.length, 0);
});

test('an untagged collider defaults to concrete, not to free passage', () => {
  const boxes = [box(0, 1, 5, 4, 2, 0.8, undefined)];
  const walk = CORE.penetrationWalk(0, 1, 0, 0, 0, 1, 60, boxes, CORE.penetrationPower('AR'));
  assert.strictEqual(CORE.penetrationMulAt(walk, 10), 0,
    'the conservative default keeps pre-feature behaviour for anything untagged');
});

// ---- Melee (GUN-04) ----
test('melee picks the nearest target inside the cone, not the nearest overall', () => {
  const targets = [
    { x: 0.4, z: -1.0, dead: false },   // closer, but behind the player
    { x: 0, z: 1.8, dead: false }       // in front
  ];
  const i = CORE.meleeTarget(targets, 0, 0, 0, 1, CORE.MELEE_REACH, CORE.MELEE_CONE);
  assert.strictEqual(i, 1, 'the knife goes where the player is looking');
});

test('melee respects reach and ignores the dead', () => {
  assert.strictEqual(
    CORE.meleeTarget([{ x: 0, z: 3.5, dead: false }], 0, 0, 0, 1, CORE.MELEE_REACH, CORE.MELEE_CONE),
    -1, 'out of reach');
  assert.strictEqual(
    CORE.meleeTarget([{ x: 0, z: 1.5, dead: true }], 0, 0, 0, 1, CORE.MELEE_REACH, CORE.MELEE_CONE),
    -1, 'already down');
  assert.strictEqual(CORE.meleeTarget([], 0, 0, 0, 1, CORE.MELEE_REACH, CORE.MELEE_CONE), -1);
});

test('melee one-shots a base runner but not a tank', () => {
  // Runner base health is 100, tank 320: the knife has to answer the rusher that
  // closed inside the stop distance without trivialising the heavy.
  assert.ok(CORE.MELEE_DAMAGE >= 100, 'a runner dies to one knife');
  assert.ok(CORE.MELEE_DAMAGE < 320, 'a tank does not');
});

// ---- Mantle (MOV-01) ----
test('a crate above step height becomes climbable', () => {
  const t = CORE.mantleTarget(0, 0, 0, 0, 1, [box(0, 0.5, 1, 2, 1, 2, 'wood')]);
  assert.ok(t, 'a 1 m crate is a route, not scenery');
  assert.ok(Math.abs(t.y - 1) < 1e-9, 'and the player lands on top of it');
});

test('mantle refuses a ledge with no headroom above it', () => {
  const boxes = [box(0, 0.5, 1, 2, 1, 2, 'wood'), box(0, 1.6, 1, 2, 0.4, 2, 'concrete')];
  assert.strictEqual(CORE.mantleTarget(0, 0, 0, 0, 1, boxes), null,
    'mantling into the underside of a slab is worse than not mantling');
});

test('mantle clearance uses standing headroom at the ledge and along the transition', () => {
  const ledge = box(0, 0.5, 1, 2, 1, 2, 'wood');
  const lowCeiling = box(0, 2.575, 1, 2, 0.35, 2, 'concrete');
  assert.ok(CORE.mantleTarget(0, 0, 0, 0, 1, [ledge, lowCeiling], { headroom: 1.3 }),
    'the synthetic opening is large enough only for crouch clearance');
  assert.strictEqual(CORE.mantleTarget(0, 0, 0, 0, 1, [ledge, lowCeiling]), null,
    'a standing player cannot mantle beneath the low ceiling');

  const transitionLedge = box(0, 0.5, 1, 2, 1, 2, 'wood');
  const transitionBeam = box(0, 2.575, 0.3, 2, 0.35, 0.2, 'concrete');
  assert.strictEqual(CORE.mantleTarget(0, 0, 0, 0, 1, [transitionLedge, transitionBeam]), null,
    'standing clearance must hold across the whole mantle transition, not only at its endpoint');
});

test('mantle ignores anything step-up already handles or nothing can reach', () => {
  assert.strictEqual(CORE.mantleTarget(0, 0, 0, 0, 1, [box(0, 0.15, 1, 2, 0.3, 2, 'wood')]), null,
    'a kerb is step-up territory');
  assert.strictEqual(CORE.mantleTarget(0, 0, 0, 0, 1, [box(0, 2.5, 1, 2, 5, 2, 'concrete')]), null,
    'a wall is a wall');
  assert.strictEqual(CORE.mantleTarget(0, 0, 0, 0, 1, []), null);
});

test('mantle picks the highest qualifying ledge under the probe', () => {
  const boxes = [box(0, 0.35, 1, 2, 0.7, 2, 'wood'), box(0, 0.6, 1, 2, 1.2, 2, 'wood')];
  const t = CORE.mantleTarget(0, 0, 0, 0, 1, boxes);
  assert.ok(Math.abs(t.y - 1.2) < 1e-9, 'stacked cover mantles to the top, not the first hit');
});

// ============================================================================
// Phase 10 — economy
// ============================================================================

test('credits reward precision over volume', () => {
  assert.ok(CORE.creditsForDamage(true, true) > CORE.creditsForDamage(true, false),
    'a headshot kill pays more than a body kill');
  assert.ok(CORE.creditsForDamage(true, false) > CORE.creditsForDamage(false, false),
    'a kill pays more than a hit');
  assert.ok(CORE.creditsForDamage(false, true) === CORE.creditsForDamage(false, false),
    'a non-lethal headshot is still just a hit');
});

test('wave credits scale with the wave', () => {
  assert.ok(CORE.creditsForWave(10) > CORE.creditsForWave(1));
  assert.strictEqual(CORE.creditsForWave(0), CORE.creditsForWave(1), 'never zero or negative');
  assert.strictEqual(CORE.creditsForWave(-5), CORE.creditsForWave(1));
});

test('power-up table covers the whole roll range and is stable at the edges', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(CORE.pickPowerUp(i / 1000).key);
  assert.strictEqual(seen.size, CORE.POWERUPS.length, 'every power-up must be reachable');
  assert.ok(CORE.pickPowerUp(0).key, 'roll 0 returns something');
  assert.ok(CORE.pickPowerUp(1).key, 'roll 1 does not fall off the end');
  assert.ok(CORE.pickPowerUp(-3).key && CORE.pickPowerUp(9).key, 'out-of-range rolls are clamped');
});

test('MAX AMMO is the common drop and NUKE is rare', () => {
  const count = {};
  for (let i = 0; i < 10000; i++) {
    const k = CORE.pickPowerUp(i / 10000).key;
    count[k] = (count[k] || 0) + 1;
  }
  assert.ok(count.maxammo > count.nuke * 3,
    'the drop that answers the ammo economy has to be the one you actually see');
});

test('power-ups are a rare drop, not a routine one', () => {
  assert.ok(CORE.POWERUP_CHANCE > 0 && CORE.POWERUP_CHANCE < 0.1);
  assert.strictEqual(CORE.powerUpDropped(0.9), false);
  assert.strictEqual(CORE.powerUpDropped(0.001), true);
});

test('timed power-ups declare a duration and instant ones do not', () => {
  for (const p of CORE.POWERUPS) {
    assert.ok(typeof p.label === 'string' && p.label.length, p.key + ' needs a banner label');
    assert.ok(p.dur >= 0, p.key + ' duration must not be negative');
  }
  const byKey = {};
  CORE.POWERUPS.forEach((p) => { byKey[p.key] = p; });
  assert.strictEqual(byKey.maxammo.dur, 0, 'MAX AMMO is instant');
  assert.ok(byKey.double.dur > 0, 'DOUBLE POINTS is timed');
  assert.ok(byKey.instakill.dur > 0, 'INSTA-KILL is timed');
});

test('a checkpoint carries credits across a resume', () => {
  const cp = CORE.makeCheckpoint({
    wave: 6, score: 4200, kills: 40, headshots: 9, shotsFired: 300, shotsHit: 150,
    health: 80, armor: 20, grenades: 2, credits: 3175,
    difficulty: 'veteran', endless: false, weapons: [{ gi: 0, ammo: 12, reserve: 90 }, null]
  });
  assert.strictEqual(CORE.validateCheckpoint(cp).credits, 3175,
    'resuming must neither refund nor confiscate what the player banked');
});

test('a corrupt credit field is clamped, not trusted', () => {
  const good = CORE.makeCheckpoint({
    wave: 3, score: 100, kills: 5, headshots: 1, shotsFired: 30, shotsHit: 12,
    health: 90, armor: 10, grenades: 1, credits: 500,
    difficulty: 'regular', endless: false, weapons: [{ gi: 0, ammo: 30, reserve: 60 }, null]
  });
  for (const bad of ['lots', -500, NaN, Infinity, null, undefined, {}]) {
    const raw = Object.assign({}, good, { credits: bad });
    const out = CORE.validateCheckpoint(raw);
    assert.ok(out, 'a bad credit value must not reject an otherwise valid save');
    assert.strictEqual(out.credits, 0, 'it is clamped to zero instead of trusted: ' + String(bad));
  }
});

// ============================================================================
// Phase 10 — the economy
// ============================================================================

// ---- Stations (SYS-01) ----
test('the nearest station in range wins, and out of range means none', () => {
  const st = [{ x: 0, z: 0 }, { x: 1.5, z: 0 }];
  assert.strictEqual(CORE.nearestStation(st, 1.4, 0, CORE.BUY_RADIUS), 1);
  assert.strictEqual(CORE.nearestStation(st, -0.2, 0, CORE.BUY_RADIUS), 0);
  assert.strictEqual(CORE.nearestStation(st, 40, 40, CORE.BUY_RADIUS), -1);
  assert.strictEqual(CORE.nearestStation([], 0, 0, CORE.BUY_RADIUS), -1);
});

test('station range is horizontal, not 3-D', () => {
  // player.pos is anchored at eye height (1.7 m). A 3-D test would read that as
  // separation — the same class of bug as BUG-02, which put enemies inside the
  // player's body. nearestStation takes no Y at all, which is the fix.
  assert.strictEqual(CORE.nearestStation.length, 4, 'signature is (stations, px, pz, radius)');
  assert.strictEqual(CORE.nearestStation([{ x: 0, z: 0 }], 0, 2.5, CORE.BUY_RADIUS), 0);
});

test('a disabled station is never offered', () => {
  assert.strictEqual(CORE.nearestStation([{ x: 0, z: 0, disabled: true }], 0, 0, CORE.BUY_RADIUS), -1);
});

// ---- Wall buys (SYS-02) ----
test('wall buy offers a purchase, a refill, or nothing', () => {
  assert.strictEqual(CORE.wallBuyOffer([2, -1], 0, 'AR', 0, 150).action, 'buy');
  assert.strictEqual(CORE.wallBuyOffer([0, -1], 0, 'AR', 20, 150).action, 'ammo');
  assert.strictEqual(CORE.wallBuyOffer([0, -1], 0, 'AR', 150, 150).action, 'full');
  assert.strictEqual(CORE.wallBuyOffer([-1, 0], 0, 'AR', 20, 150).action, 'ammo',
    'the weapon counts as held in either slot');
});

test('refilling is always cheaper than re-buying', () => {
  for (const t of ['SMG', 'AR', 'BR', 'SR']) {
    assert.ok(CORE.ammoRefillPrice(t) < CORE.wallBuyPrice(t),
      t + ': a player who owns the wall weapon should top it up, not re-buy it');
    assert.ok(CORE.ammoRefillPrice(t) > 0);
  }
});

test('wall buy prices track weapon class', () => {
  assert.ok(CORE.wallBuyPrice('SR') > CORE.wallBuyPrice('BR'));
  assert.ok(CORE.wallBuyPrice('BR') > CORE.wallBuyPrice('AR'));
  assert.ok(CORE.wallBuyPrice('AR') > CORE.wallBuyPrice('SMG'));
});

test('an unknown weapon class still has a price', () => {
  // A station with an undefined price would be an unbuyable dead object in the
  // arena, which is worse than a wrong number.
  assert.ok(CORE.wallBuyPrice('railgun') > 0);
  assert.ok(CORE.wallBuyPrice(undefined) > 0);
});

// ---- Armory (SYS-02) ----
test('the armory is locked until its wave', () => {
  assert.strictEqual(CORE.armoryAvailable(CORE.ARMORY_WAVE - 1), false);
  assert.strictEqual(CORE.armoryAvailable(CORE.ARMORY_WAVE), true);
  assert.strictEqual(CORE.armoryAvailable(30), true);
});

test('an armory upgrade raises damage, magazine and reserve', () => {
  const base = { dmg: 26, mag: 30, reserveMax: 150, name: 'M4 Carbine', type: 'AR' };
  const up = CORE.armoryUpgrade(base);
  assert.ok(up.dmg > base.dmg);
  assert.ok(up.mag > base.mag);
  assert.ok(up.reserveMax > base.reserveMax);
  assert.ok(/M4 Carbine/.test(up.name) && up.name !== base.name, 'the player must see it changed');
  assert.strictEqual(up.upgraded, true);
});

test('the armory never mutates the shared weapon config', () => {
  // CFG.weapons is shared across runs; upgrading in place would leak into the next.
  const base = { dmg: 26, mag: 30, reserveMax: 150, name: 'M4 Carbine' };
  const snapshot = JSON.stringify(base);
  CORE.armoryUpgrade(base);
  assert.strictEqual(JSON.stringify(base), snapshot);
});

test('integer stats stay integers after an upgrade', () => {
  // The SV-98's 5-round magazine and 35-round reserve are the cases that expose a
  // missing round(): 5 x 1.5 = 7.5 and 35 x 1.5 = 52.5.
  for (const base of [{ dmg: 120, mag: 5, reserveMax: 35, name: 'SV-98' },
                      { dmg: 18, mag: 32, reserveMax: 160, name: 'MK18' },
                      { dmg: 42, mag: 20, reserveMax: 100, name: 'SCAR-H' }]) {
    const up = CORE.armoryUpgrade(base);
    assert.strictEqual(up.mag, Math.round(up.mag),
      base.name + ': a magazine of 7.5 rounds is not a thing');
    assert.strictEqual(up.reserveMax, Math.round(up.reserveMax), base.name + ' reserve');
  }
});

// ---- Perks (SYS-05) ----
test('a blocked perk purchase always says why', () => {
  assert.strictEqual(CORE.perkBuyBlocker([], 'jugg', 99999), '', 'affordable and free slot');
  assert.match(CORE.perkBuyBlocker([], 'jugg', 0), /NEED/);
  assert.match(CORE.perkBuyBlocker(['jugg'], 'jugg', 99999), /ALREADY/);
  assert.match(CORE.perkBuyBlocker(['a', 'b', 'c'], 'jugg', 99999), /SLOTS FULL/);
  assert.match(CORE.perkBuyBlocker([], 'nonsense', 99999), /UNKNOWN/);
});

test('the slot limit is enforced at exactly the declared count', () => {
  const owned = [];
  for (let i = 0; i < CORE.PERK_SLOTS; i++) owned.push(CORE.PERKS[i].key);
  assert.match(CORE.perkBuyBlocker(owned, CORE.PERKS[CORE.PERK_SLOTS].key, 99999), /SLOTS FULL/);
  owned.pop();
  assert.strictEqual(CORE.perkBuyBlocker(owned, CORE.PERKS[CORE.PERK_SLOTS].key, 99999), '');
});

test('every perk has a price, a name and a blurb', () => {
  for (const p of CORE.PERKS) {
    assert.ok(p.price > 0, p.key + ' needs a price');
    assert.ok(p.name && p.name.length, p.key + ' needs a name');
    assert.ok(p.blurb && p.blurb.length, p.key + ' needs a blurb the player can read');
    // The HUD chip used to slice the name to four characters, which produced
    // "JUGG SPEE STEA". A short code is authored, not derived.
    assert.ok(p.short && p.short.length <= 3, p.key + ' needs a short HUD code');
    assert.strictEqual(CORE.perkByKey(p.key), p);
  }
  assert.strictEqual(CORE.perkByKey('nope'), null);
});

test('perks do nothing until owned, and something once owned', () => {
  assert.strictEqual(CORE.perkMaxHealth(100, []), 100);
  assert.ok(CORE.perkMaxHealth(100, ['jugg']) > 100);
  assert.strictEqual(CORE.perkReloadMul([]), 1);
  assert.ok(CORE.perkReloadMul(['reload']) < 1, 'SPEED RELOAD must shorten a reload');
  assert.strictEqual(CORE.perkBloomMul([]), 1);
  assert.ok(CORE.perkBloomMul(['steady']) < 1, 'STEADY AIM must tighten bloom');
  assert.ok(CORE.perkAdsMul(['steady']) > 1, 'and speed up the ADS lerp');
  assert.strictEqual(CORE.perkPickupMul([]), 1);
  assert.ok(CORE.perkPickupMul(['scav']) > 1);
});

test('perk lookups tolerate a missing list', () => {
  assert.strictEqual(CORE.hasPerk(null, 'jugg'), false);
  assert.strictEqual(CORE.hasPerk(undefined, 'jugg'), false);
});

// ---- Plates (SYS-05) ----
test('plating refills the buffer and spends exactly one plate', () => {
  const r = CORE.plateApply(0, 50, 3);
  assert.strictEqual(r.armor, 50);
  assert.strictEqual(r.plates, 2);
});

test('plating refuses when it would do nothing', () => {
  assert.strictEqual(CORE.plateApply(50, 50, 3), null, 'already full');
  assert.strictEqual(CORE.plateApply(0, 50, 0), null, 'no plates carried');
});

test('plate purchases stop at the carry limit', () => {
  assert.strictEqual(CORE.platesAffordable(99999, CORE.PLATE_MAX), 0);
  assert.strictEqual(CORE.platesAffordable(0, 0), 0);
  assert.strictEqual(CORE.platesAffordable(CORE.PLATE_PRICE * 99, 0), CORE.PLATE_MAX);
  assert.strictEqual(CORE.platesAffordable(CORE.PLATE_PRICE, 0), 1);
  assert.strictEqual(CORE.platesAffordable(CORE.PLATE_PRICE * 99, CORE.PLATE_MAX - 1), 1,
    'one slot of room buys exactly one plate');
  // A carry count ABOVE the limit is the case that matters: the room calculation
  // goes negative there, and "you can afford -2 plates" is not a sentence.
  assert.strictEqual(CORE.platesAffordable(99999, CORE.PLATE_MAX + 5), 0);
});

// ---- Last stand (SYS-07) ----
test('a lethal hit downs the player instead of ending the run', () => {
  assert.strictEqual(CORE.lethalOutcome([], false).outcome, 'down');
});

test('Second Wind converts the first down into a revive and is spent doing it', () => {
  const r = CORE.lethalOutcome(['wind'], false);
  assert.strictEqual(r.outcome, 'revive');
  assert.strictEqual(r.consume, 'wind', 'it must be consumed, or it answers every mistake');
});

test('a lethal hit while already down is death', () => {
  assert.strictEqual(CORE.lethalOutcome([], true).outcome, 'dead');
  assert.strictEqual(CORE.lethalOutcome(['wind'], true).outcome, 'dead',
    'Second Wind cannot save a player who is already bleeding out');
});

test('the bleed-out clock runs down and stops at zero', () => {
  assert.strictEqual(CORE.bleedOutRemaining(0), CORE.DOWN_TIME);
  assert.ok(CORE.bleedOutRemaining(CORE.DOWN_TIME / 2) > 0);
  assert.strictEqual(CORE.bleedOutRemaining(CORE.DOWN_TIME), 0);
  assert.strictEqual(CORE.bleedOutRemaining(CORE.DOWN_TIME + 99), 0, 'never negative');
});

test('being downed is a real penalty', () => {
  assert.ok(CORE.DOWN_SPEED_MUL < 0.5, 'a downed player must not simply walk away');
  assert.ok(CORE.DOWN_REVIVE_HEALTH > 0 && CORE.DOWN_REVIVE_HEALTH < 100,
    'coming back up is a second chance, not a reset');
});

// ---- Checkpoint round-trip ----
test('a checkpoint carries perks and plates', () => {
  const cp = CORE.makeCheckpoint({
    wave: 9, score: 9000, kills: 80, headshots: 20, shotsFired: 500, shotsHit: 300,
    health: 120, armor: 50, grenades: 2, credits: 4000,
    perks: ['jugg', 'reload'], plates: 2,
    difficulty: 'veteran', endless: false, weapons: [{ gi: 0, ammo: 30, reserve: 150 }, null]
  });
  const v = CORE.validateCheckpoint(cp);
  assert.deepStrictEqual(v.perks, ['jugg', 'reload']);
  assert.strictEqual(v.plates, 2);
});

test('a perk key that no longer exists does not resurrect on load', () => {
  const cp = CORE.makeCheckpoint({
    wave: 9, score: 1, kills: 1, headshots: 0, shotsFired: 1, shotsHit: 1,
    health: 50, armor: 0, grenades: 0, credits: 0,
    perks: ['jugg', 'removed_in_a_later_version', 'reload'], plates: 0,
    difficulty: 'regular', endless: false, weapons: [{ gi: 0, ammo: 1, reserve: 1 }, null]
  });
  assert.deepStrictEqual(CORE.validateCheckpoint(cp).perks, ['jugg', 'reload']);
});

test('a corrupt perk or plate field is clamped, not trusted', () => {
  const good = CORE.makeCheckpoint({
    wave: 3, score: 1, kills: 1, headshots: 0, shotsFired: 1, shotsHit: 1,
    health: 50, armor: 0, grenades: 0, credits: 0, perks: [], plates: 0,
    difficulty: 'regular', endless: false, weapons: [{ gi: 0, ammo: 1, reserve: 1 }, null]
  });
  for (const bad of ['jugg', 7, null, { jugg: true }]) {
    const v = CORE.validateCheckpoint(Object.assign({}, good, { perks: bad }));
    assert.ok(v, 'a bad perk list must not reject an otherwise valid save');
    assert.deepStrictEqual(v.perks, [], 'perks: ' + JSON.stringify(bad));
  }
  for (const bad of [-3, 99, 'three', NaN]) {
    const v = CORE.validateCheckpoint(Object.assign({}, good, { plates: bad }));
    assert.ok(v.plates >= 0 && v.plates <= CORE.PLATE_MAX, 'plates: ' + String(bad));
  }
});

test('a save can never carry more perks than there are slots', () => {
  const good = CORE.makeCheckpoint({
    wave: 3, score: 1, kills: 1, headshots: 0, shotsFired: 1, shotsHit: 1,
    health: 50, armor: 0, grenades: 0, credits: 0,
    perks: CORE.PERKS.map((p) => p.key), plates: 0,
    difficulty: 'regular', endless: false, weapons: [{ gi: 0, ammo: 1, reserve: 1 }, null]
  });
  assert.ok(CORE.validateCheckpoint(good).perks.length <= CORE.PERK_SLOTS);
});

// ============================================================================
// Phase 11 — equipment and streaks
// ============================================================================

// ---- Equipment table (SYS-03) ----
test('every payload declares the fields the projectile loop branches on', () => {
  for (const d of CORE.LETHALS.concat(CORE.TACTICALS)) {
    assert.ok(d.key && d.name, 'needs a key and a display name');
    assert.ok(['timed', 'burn', 'proximity', 'tactical'].indexOf(d.mode) >= 0,
      d.key + ': mode must be one the loop knows: ' + d.mode);
    assert.ok(d.price >= 0, d.key + ' needs a price');
    assert.strictEqual(CORE.equipmentByKey(d.key), d);
  }
  assert.strictEqual(CORE.equipmentByKey('rocket'), null);
});

test('the default lethal is free and everything else is not', () => {
  assert.strictEqual(CORE.LETHALS[0].key, 'frag');
  assert.strictEqual(CORE.LETHALS[0].price, 0, 'the starting frag must never cost credits');
  for (let i = 1; i < CORE.LETHALS.length; i++) {
    assert.ok(CORE.LETHALS[i].price > 0, CORE.LETHALS[i].key + ' must be bought');
  }
});

test('sticky payloads do not bounce, and bouncing ones do', () => {
  for (const d of CORE.LETHALS) {
    if (d.sticky) assert.strictEqual(d.bounce, 0, d.key + ' sticks, so it cannot bounce');
  }
  assert.ok(CORE.equipmentByKey('frag').bounce > 0);
  assert.strictEqual(CORE.equipmentByKey('semtex').bounce, 0);
});

test('a claymore is armed and directional, not a slow frag', () => {
  const c = CORE.equipmentByKey('claymore');
  assert.strictEqual(c.mode, 'proximity');
  assert.ok(c.arm > 0, 'it must not trigger the instant it lands');
  assert.ok(c.trigger > 0);
  assert.ok(c.arc > 0 && c.arc < 1, 'a cone, not a sphere — placement has to matter');
});

test('thermite trades burst damage for area denial', () => {
  const t = CORE.equipmentByKey('thermite');
  assert.strictEqual(t.mode, 'burn');
  assert.ok(t.burnTime > 1 && t.burnRadius > 0 && t.burnDps > 0);
  assert.ok(t.fuse < CORE.equipmentByKey('frag').fuse, 'it detonates on contact, not on a cook');
});

// ---- Flashbang falloff ----
test('a flashbang is strongest looking straight at it and weakest far away', () => {
  const r = 14;
  const near = CORE.flashStrength(1, r, 1);
  const far = CORE.flashStrength(13, r, 1);
  assert.ok(near > far, 'distance must matter');
  assert.strictEqual(CORE.flashStrength(r, r, 1), 0, 'nothing at the edge');
  assert.strictEqual(CORE.flashStrength(99, r, 1), 0, 'nothing beyond it');
});

test('looking away reduces a flash but does not cancel it', () => {
  const r = 14;
  const facing = CORE.flashStrength(3, r, 1);
  const side = CORE.flashStrength(3, r, 0);
  const away = CORE.flashStrength(3, r, -1);
  assert.ok(facing > side && side > away, 'angle must grade it, not gate it');
  assert.ok(side > 0, 'it still went off next to them');
  assert.strictEqual(away, 0, 'directly away from it is the one case that is free');
});

test('flash duration scales with strength and never exceeds the declared maximum', () => {
  const d = CORE.equipmentByKey('flash');
  assert.strictEqual(CORE.flashDuration(0, d.dur), 0);
  assert.ok(CORE.flashDuration(1, d.dur) <= d.dur + 1e-9);
  assert.ok(CORE.flashDuration(0.5, d.dur) < CORE.flashDuration(1, d.dur));
});

// ---- Smoke as a line-of-sight volume ----
test('smoke blocks a sight line that passes through it', () => {
  assert.strictEqual(
    CORE.smokeBlocks(0, 1.5, 0, 0, 1.5, 20, [{ x: 0, y: 1.5, z: 10, r: 6 }]), true);
});

test('smoke does not block a line that misses it', () => {
  assert.strictEqual(
    CORE.smokeBlocks(0, 1.5, 0, 0, 1.5, 20, [{ x: 30, y: 1.5, z: 10, r: 6 }]), false,
    'beside the line');
  assert.strictEqual(
    CORE.smokeBlocks(0, 1.5, 0, 0, 1.5, 20, [{ x: 0, y: 40, z: 10, r: 6 }]), false,
    'far above the line — the test is 3-D, not a floor plan');
});

test('smoke beyond the end of the sight line does not block it', () => {
  // The classic bug in this shape of test: using the infinite line instead of the
  // segment, so a cloud behind the SHOOTER or past the TARGET blocks the shot.
  assert.strictEqual(
    CORE.smokeBlocks(0, 1.5, 0, 0, 1.5, 4, [{ x: 0, y: 1.5, z: 40, r: 6 }]), false,
    'past the target');
  assert.strictEqual(
    CORE.smokeBlocks(0, 1.5, 0, 0, 1.5, 20, [{ x: 0, y: 1.5, z: -40, r: 6 }]), false,
    'behind the shooter');
});

test('a degenerate sight line still answers correctly', () => {
  assert.strictEqual(CORE.smokeBlocks(5, 1, 5, 5, 1, 5, [{ x: 5, y: 1, z: 5, r: 2 }]), true);
  assert.strictEqual(CORE.smokeBlocks(5, 1, 5, 5, 1, 5, [{ x: 50, y: 1, z: 5, r: 2 }]), false);
});

test('no clouds means no blocking, and a missing list is not a crash', () => {
  assert.strictEqual(CORE.smokeBlocks(0, 1, 0, 0, 1, 20, []), false);
  assert.strictEqual(CORE.smokeBlocks(0, 1, 0, 0, 1, 20, null), false);
  assert.strictEqual(CORE.smokeBlocks(0, 1, 0, 0, 1, 20, undefined), false);
});

test('the sphere test uses the closest point on the segment', () => {
  // A cloud beside the midpoint blocks; the same cloud beside an endpoint does not.
  assert.strictEqual(CORE.segmentHitsSphere(0, 0, 0, 0, 0, 10, 3, 0, 5, 3.5), true);
  assert.strictEqual(CORE.segmentHitsSphere(0, 0, 0, 0, 0, 10, 3, 0, 5, 2), false);
});

// ---- Scorestreaks (SYS-04) ----
test('a streak is earned at exactly its threshold, not on every kill past it', () => {
  assert.deepStrictEqual(CORE.streaksEarnedAt(8).map((s) => s.key), ['uav']);
  assert.strictEqual(CORE.streaksEarnedAt(9).length, 0,
    'banking it again on kill 9 would hand out an unlimited supply');
  assert.strictEqual(CORE.streaksEarnedAt(0).length, 0);
});

test('every streak threshold grants something exactly once', () => {
  const counts = {};
  for (let n = 0; n <= 100; n++) {
    for (const s of CORE.streaksEarnedAt(n)) counts[s.key] = (counts[s.key] || 0) + 1;
  }
  for (const s of CORE.STREAKS) {
    assert.strictEqual(counts[s.key], 1, s.key + ' must be granted exactly once across a run');
  }
});

test('streak thresholds ascend, so the HUD goal always moves forward', () => {
  for (let i = 1; i < CORE.STREAKS.length; i++) {
    assert.ok(CORE.STREAKS[i].kills > CORE.STREAKS[i - 1].kills);
  }
  assert.strictEqual(CORE.nextStreak(0).key, CORE.STREAKS[0].key);
  assert.strictEqual(CORE.nextStreak(CORE.STREAKS[0].kills).key, CORE.STREAKS[1].key);
  assert.strictEqual(CORE.nextStreak(9999), null, 'no goal once everything is earned');
});

test('every streak has a name and a HUD code', () => {
  for (const s of CORE.STREAKS) {
    assert.ok(s.name && s.name.length);
    assert.ok(s.short && s.short.length <= 3, s.key + ' needs a short HUD code');
    assert.strictEqual(CORE.streakByKey(s.key), s);
  }
  assert.strictEqual(CORE.streakByKey('nuke_from_orbit'), null);
});

// ---- Field upgrade ----
test('the field upgrade charges on damage and caps at its requirement', () => {
  const need = CORE.FIELD_UPGRADE.charge;
  assert.strictEqual(CORE.fieldReady(0), false);
  let c = 0;
  for (let i = 0; i < 5; i++) c = CORE.fieldChargeAfter(c, need / 4);
  assert.strictEqual(c, need, 'it must not bank overflow toward the next one');
  assert.strictEqual(CORE.fieldReady(c), true);
});

test('a single huge hit cannot overcharge the field upgrade', () => {
  assert.strictEqual(CORE.fieldChargeAfter(0, 1e9), CORE.FIELD_UPGRADE.charge);
});

test('the claymore cone is 60 degrees, whatever length the facing arrives at', () => {
  const c = CORE.equipmentByKey('claymore');
  const at = (deg, len) => {
    const a = deg * Math.PI / 180;
    return CORE.coneHit(0, 0, Math.sin(a) * 2, Math.cos(a) * 2, 0, len, c.trigger, c.arc);
  };
  for (const len of [1, 6.7, 0.01]) {
    assert.strictEqual(at(0, len), true, 'dead ahead, |face| = ' + len);
    assert.strictEqual(at(55, len), true, 'inside the cone, |face| = ' + len);
    assert.strictEqual(at(75, len), false,
      '75 degrees is outside a 60-degree cone — this is the case an unnormalised ' +
      'facing let through, |face| = ' + len);
    assert.strictEqual(at(180, len), false, 'behind it, |face| = ' + len);
  }
});

test('the cone respects its trigger range and degenerate inputs', () => {
  const c = CORE.equipmentByKey('claymore');
  assert.strictEqual(CORE.coneHit(0, 0, 0, c.trigger + 1, 0, 1, c.trigger, c.arc), false);
  assert.strictEqual(CORE.coneHit(0, 0, 0, 0, 0, 1, c.trigger, c.arc), false, 'on top of it');
  assert.strictEqual(CORE.coneHit(0, 0, 0, 2, 0, 0, c.trigger, c.arc), false, 'no facing at all');
});

// ============================================================================
// Phase 12 — wave and map design
// ============================================================================

// ---- Special waves (SYS-06) ----
test('a special wave lands on every fifth wave and nowhere else', () => {
  for (let n = 1; n <= 60; n++) {
    const sp = CORE.specialWaveAt(n);
    if (n >= CORE.SPECIAL_EVERY && n % CORE.SPECIAL_EVERY === 0) {
      assert.ok(sp, 'wave ' + n + ' must be special');
    } else {
      assert.strictEqual(sp, null, 'wave ' + n + ' must not be');
    }
  }
});

test('the special cycle is deterministic, so it can be learned', () => {
  // A player should be able to know wave 15 is Ironclad and bring a flank plan.
  const first = [5, 10, 15, 20].map((n) => CORE.specialWaveAt(n).key);
  const second = [25, 30, 35, 40].map((n) => CORE.specialWaveAt(n).key);
  assert.deepStrictEqual(second, first, 'the cycle must repeat, not randomise');
  assert.strictEqual(new Set(first).size, CORE.SPECIAL_WAVES.length,
    'every modifier must appear before any repeats');
});

test('every special wave declares a name and a blurb the player can act on', () => {
  for (const sp of CORE.SPECIAL_WAVES) {
    assert.ok(sp.key && sp.name, sp.key + ' needs a name');
    assert.ok(sp.blurb && sp.blurb.length > 8, sp.key + ' needs a blurb, not a label');
    if (sp.countMul !== undefined) assert.ok(sp.countMul > 0);
    if (sp.hpMul !== undefined) assert.ok(sp.hpMul > 0);
  }
});

test('a special wave only draws kinds the wave has actually unlocked', () => {
  // Ironclad is tanks and shielded advancers; the shielded advancer unlocks at
  // wave 9. An Ironclad wave before then must not conjure one.
  const ironclad = CORE.SPECIAL_WAVES.filter((s) => s.key === 'ironclad')[0];
  const early = [];
  for (let i = 0; i < 200; i++) early.push(CORE.specialKind(ironclad, 4, i / 200));
  assert.ok(early.indexOf(3) < 0, 'no shielded advancer before wave 9');
  assert.ok(early.indexOf(2) >= 0, 'tanks are available at wave 4, so it uses those');
  const late = [];
  for (let i = 0; i < 200; i++) late.push(CORE.specialKind(ironclad, 15, i / 200));
  assert.ok(late.indexOf(3) >= 0 && late.indexOf(2) >= 0, 'both by wave 15');
});

test('a special wave with no unlocked kinds falls back rather than spawning nothing', () => {
  const impossible = { key: 'x', name: 'X', blurb: 'nothing here', kinds: [99] };
  assert.strictEqual(CORE.specialKind(impossible, 15, 0.5), null,
    'null tells the caller to use the normal table');
  assert.strictEqual(CORE.specialKind(null, 15, 0.5), null);
  assert.strictEqual(CORE.specialKind({ key: 'y' }, 15, 0.5), null, 'no kind list at all');
});

// ---- Wave queue size ----
test('the queue cap is applied after every multiplier, not before', () => {
  // The bug this encodes: endlessEnemyCount capped the raw curve at 60, and a
  // Blitz wave then doubled the capped number. Wave 25 queued 120 bodies against
  // a ceiling meant to be 60.
  const blitz = CORE.specialWaveAt(25);
  assert.ok(blitz.countMul > 1, 'this test is pointless unless Blitz multiplies');
  for (const d of [0.8, 1.0, 1.2]) {
    for (const n of [5, 15, 25, 30, 45, 99]) {
      const q = CORE.waveQueueSize(n, 5, 2.5, 15, d, CORE.specialWaveAt(n));
      assert.ok(q <= CORE.WAVE_QUEUE_CAP,
        'wave ' + n + ' at difficulty ' + d + ' queued ' + q);
    }
  }
});

test('a wave always queues at least one hostile', () => {
  // A wave that queues nothing can never be cleared, which is a softlock. The
  // floor has to hold for values the shipped difficulties never produce, because
  // the guard is there for the ones a future tuning pass might.
  for (const d of [0.001, 0.05, 0.1, 0.8, 1]) {
    for (let n = 1; n <= 30; n++) {
      const q = CORE.waveQueueSize(n, 5, 2.5, 15, d, CORE.specialWaveAt(n));
      assert.ok(q >= 1, 'wave ' + n + ' at count multiplier ' + d + ' queued ' + q);
    }
  }
  assert.strictEqual(CORE.waveQueueSize(1, 1, 1, 15, 0, null), 1,
    'even a zero multiplier must still field one hostile');
});

test('special multipliers still change the queue below the cap', () => {
  const plain = CORE.waveQueueSize(14, 5, 2.5, 15, 1, null);
  const ironclad = CORE.waveQueueSize(15, 5, 2.5, 15, 1, CORE.specialWaveAt(15));
  assert.ok(ironclad < plain, 'Ironclad fields fewer, heavier bodies');
});

// ---- Elites (SYS-06) ----
test('elites do not appear before their wave and are capped after it', () => {
  for (let n = 1; n < CORE.ELITE_FROM_WAVE; n++) {
    assert.strictEqual(CORE.eliteChance(n), 0, 'wave ' + n);
    assert.strictEqual(CORE.rollElite(n, 0), false, 'not even on a zero roll');
  }
  assert.ok(CORE.eliteChance(CORE.ELITE_FROM_WAVE) > 0);
  let prev = 0;
  for (let n = CORE.ELITE_FROM_WAVE; n <= 60; n++) {
    const c = CORE.eliteChance(n);
    assert.ok(c >= prev, 'the chance must not fall as waves climb');
    assert.ok(c <= 0.3, 'wave ' + n + ' at ' + c + ' — elites must stay rare');
    prev = c;
  }
});

test('an elite is worth more than it costs to kill', () => {
  assert.ok(CORE.ELITE.hpMul > 1, 'it has to take longer');
  assert.ok(CORE.ELITE.scoreMul > 1 && CORE.ELITE.creditMul > 1,
    'and pay for the time, or it is just a bullet sponge');
  assert.ok(CORE.ELITE.scoreMul >= CORE.ELITE.hpMul * 0.8,
    'the reward must roughly track the extra health');
});

test('the elite roll respects its own chance', () => {
  const c = CORE.eliteChance(20);
  assert.strictEqual(CORE.rollElite(20, c - 0.0001), true);
  assert.strictEqual(CORE.rollElite(20, c), false, 'the boundary is exclusive');
  assert.strictEqual(CORE.rollElite(20, 0.99), false);
});

// ---- Gated districts (SYS-01, SYS-06) ----
test('a district contains its own bounds and nothing else', () => {
  for (const d of CORE.DISTRICTS) {
    assert.ok(d.price > 0, d.key + ' needs a price');
    assert.ok(d.name && d.name.length, d.key + ' needs a name');
    assert.ok(d.maxX > d.minX && d.maxZ > d.minZ, d.key + ' has inverted bounds');
    assert.strictEqual(CORE.districtByKey(d.key), d);
    assert.strictEqual(CORE.insideDistrict(d, (d.minX + d.maxX) / 2, (d.minZ + d.maxZ) / 2), true);
    assert.strictEqual(CORE.insideDistrict(d, 0, 0), false, 'the arena centre is never gated');
    // Pin BOTH axes. A bounds test that only checks X seals a whole stripe of the
    // arena, and the centre check above would not notice.
    const midX = (d.minX + d.maxX) / 2, midZ = (d.minZ + d.maxZ) / 2;
    assert.strictEqual(CORE.insideDistrict(d, midX, d.maxZ + 20), false,
      d.key + ': right X, far Z must be outside');
    assert.strictEqual(CORE.insideDistrict(d, midX, d.minZ - 20), false,
      d.key + ': right X, far -Z must be outside');
    assert.strictEqual(CORE.insideDistrict(d, d.maxX + 20, midZ), false,
      d.key + ': right Z, far X must be outside');
  }
  assert.strictEqual(CORE.districtByKey('atlantis'), null);
});

test('the two districts do not overlap each other', () => {
  const [a, b] = CORE.DISTRICTS;
  const overlap = a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
  assert.strictEqual(overlap, false, 'one door must never half-open the other district');
});

test('a sealed district is excluded from the spawn ring and an open one is not', () => {
  const d = CORE.DISTRICTS[0];
  const cx = (d.minX + d.maxX) / 2, cz = (d.minZ + d.maxZ) / 2;
  assert.strictEqual(CORE.spawnPointSealed(cx, cz, []), true);
  assert.strictEqual(CORE.spawnPointSealed(cx, cz, [d.key]), false);
  assert.strictEqual(CORE.spawnPointSealed(0, 0, []), false, 'the centre is always open');
});

test('the spawn ring always keeps usable points, sealed or not', () => {
  // A wave that cannot spawn can never be cleared, which is a softlock — the same
  // class of failure as the ammo drought Phase 5 found.
  const ring = [];
  for (let a = 0; a < 12; a++) {
    const g = a / 12 * Math.PI * 2;
    ring.push([Math.cos(g) * 33, Math.sin(g) * 33]);
  }
  const sealed = CORE.usableSpawnPoints(ring, []);
  const open = CORE.usableSpawnPoints(ring, CORE.DISTRICTS.map((d) => d.key));
  assert.ok(sealed.length > 0, 'the ring must survive both districts being sealed');
  assert.strictEqual(open.length, ring.length, 'opening everything restores the whole ring');
  assert.ok(sealed.length < ring.length, 'and sealing must actually remove some');
  for (const p of sealed) {
    assert.strictEqual(CORE.spawnPointSealed(p[0], p[1], []), false);
  }
});

test('an empty ring does not crash the filter', () => {
  assert.deepStrictEqual(CORE.usableSpawnPoints([], []), []);
});

// ============================================================================
// Ragdolls and fall damage
// ============================================================================

function settle(rag, boxes, seconds) {
  const n = Math.round((seconds === undefined ? 5 : seconds) * 60);
  for (let i = 0; i < n; i++) CORE.ragdollStep(rag, 1 / 60, boxes || [], 0);
  return rag;
}
function nodeYs(rag) { return rag.order.map((p) => p.y); }

test('a ragdoll has one node per rig bone and links them all', () => {
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  assert.strictEqual(rag.order.length, CORE.RAGDOLL_NODES.length);
  assert.strictEqual(rag.links.length, CORE.RAGDOLL_LINKS.length);
  for (const d of CORE.RAGDOLL_NODES) {
    assert.ok(rag.nodes[d.key], d.key + ' must exist');
    assert.ok(rag.nodes[d.key].inv > 0, d.key + ' needs a mass');
  }
  // Every link must join nodes that exist, or the solver silently skips it.
  for (const L of CORE.RAGDOLL_LINKS) {
    assert.ok(rag.nodes[L[0]] && rag.nodes[L[1]], 'link ' + L[0] + '-' + L[1]);
    assert.ok(L[2] > 0 && L[2] <= 1, 'stiffness out of range on ' + L[0] + '-' + L[1]);
  }
});

test('a ragdoll starts standing and ends up lying down', () => {
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  assert.ok(rag.nodes.head.y > 1.5, 'starts in a standing pose');
  settle(rag);
  assert.ok(rag.nodes.head.y < 0.5, 'the head ends on the floor');
  assert.ok(Math.max.apply(null, nodeYs(rag)) < 0.6, 'nothing is left standing');
});

test('a ragdoll never sinks through the ground', () => {
  const rag = CORE.makeRagdoll(0, 3, 0, 0);
  CORE.ragdollImpulse(rag, 'chest', 0, -0.4, 0);   // slammed downward
  settle(rag, [], 6);
  for (const p of rag.order) {
    assert.ok(p.y >= -1e-6, 'node ' + p.key + ' at y=' + p.y);
  }
});

test('a ragdoll comes to rest and reports it', () => {
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  assert.strictEqual(rag.settled, false, 'not settled the instant it is made');
  settle(rag);
  assert.strictEqual(rag.settled, true);
  assert.ok(CORE.ragdollEnergy(rag) < 1e-3, 'and it actually stopped moving');
});

test('the impulse direction decides which way the body falls', () => {
  // This is the whole reason a ragdoll beats a death clip: the same enemy has to
  // fall differently depending on where it was shot from.
  const forward = CORE.makeRagdoll(0, 0, 0, 0);
  CORE.ragdollImpulse(forward, 'chest', 0, 0.02, 0.06);
  settle(forward);
  const back = CORE.makeRagdoll(0, 0, 0, 0);
  CORE.ragdollImpulse(back, 'chest', 0, 0.02, -0.06);
  settle(back);
  assert.ok(forward.nodes.pelvis.z > 0.2, 'pushed +z, fell +z');
  assert.ok(back.nodes.pelvis.z < -0.2, 'pushed -z, fell -z');
  const side = CORE.makeRagdoll(0, 0, 0, 0);
  CORE.ragdollImpulse(side, 'chest', 0.06, 0.02, 0);
  settle(side);
  assert.ok(side.nodes.pelvis.x > 0.2, 'pushed +x, fell +x');
});

test('a harder hit throws the body further', () => {
  const light = CORE.makeRagdoll(0, 0, 0, 0);
  CORE.ragdollImpulse(light, 'chest', 0, 0.01, 0.02);
  settle(light);
  const heavy = CORE.makeRagdoll(0, 0, 0, 0);
  CORE.ragdollImpulse(heavy, 'chest', 0, 0.01, 0.08);
  settle(heavy);
  assert.ok(Math.abs(heavy.nodes.pelvis.z) > Math.abs(light.nodes.pelvis.z),
    'impulse magnitude has to matter or every death looks the same again');
});

test('the impulse is weighted by inverse mass', () => {
  // A headshot should whip the head harder than the pelvis. Equal treatment would
  // make the body translate rigidly, which is a shove, not a ragdoll.
  // Compare two nodes that are BOTH unstruck, so the only thing separating them is
  // mass. Comparing the struck node against an unstruck one proves nothing: the
  // spread factor already differentiates those.
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  const h0 = rag.nodes.head.z, p0 = rag.nodes.pelvis.z;
  CORE.ragdollImpulse(rag, 'chest', 0, 0, 0.05, 0.5);
  CORE.ragdollStep(rag, 1 / 60, [], -50);   // no ground, isolate the impulse
  const head = rag.nodes.head.z - h0, pelvis = rag.nodes.pelvis.z - p0;
  assert.ok(head > pelvis * 1.2,
    'a light head must take more of the same impulse than a heavy pelvis: ' +
    head.toFixed(5) + ' vs ' + pelvis.toFixed(5));
});

test('the rest pose rotates with the agent facing', () => {
  const a = CORE.makeRagdoll(0, 0, 0, 0);
  const b = CORE.makeRagdoll(0, 0, 0, Math.PI / 2);
  // armL sits to one side; a quarter turn must move it to a different axis.
  assert.ok(Math.abs(a.nodes.armL.x) > 0.1 && Math.abs(a.nodes.armL.z) < 0.1);
  assert.ok(Math.abs(b.nodes.armL.z) > 0.1 && Math.abs(b.nodes.armL.x) < 0.1);
  assert.ok(Math.abs(a.nodes.head.y - b.nodes.head.y) < 1e-9, 'height is unchanged');
});

test('a ragdoll rests on top of a box instead of inside it', () => {
  const crate = { min: { x: -1.5, y: 0, z: -1.5 }, max: { x: 1.5, y: 1.5, z: 1.5 } };
  const rag = CORE.makeRagdoll(0, 1.5, 0, 0);
  settle(rag, [crate], 6);
  for (const p of rag.order) {
    const inside = p.x > crate.min.x && p.x < crate.max.x &&
                   p.z > crate.min.z && p.z < crate.max.z &&
                   p.y < crate.max.y - 0.05 && p.y > crate.min.y;
    assert.strictEqual(inside, false, p.key + ' ended up inside the crate');
  }
});

test('a ragdoll keeps its skeleton roughly intact', () => {
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  CORE.ragdollImpulse(rag, 'chest', 0.05, 0.03, 0.05);
  settle(rag, [], 6);
  for (const L of rag.links) {
    const d = CORE.dist3(L.a, L.b);
    assert.ok(d < L.rest * 2.0 + 0.2,
      L.a.key + '-' + L.b.key + ' stretched to ' + d.toFixed(2) + ' from ' + L.rest.toFixed(2));
  }
  // And it must not collapse to a point either.
  const xs = rag.order.map((p) => p.x), zs = rag.order.map((p) => p.z);
  const spread = Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs),
                          Math.max.apply(null, zs) - Math.min.apply(null, zs));
  assert.ok(spread > 0.6, 'a body lying down is longer than it is wide: ' + spread.toFixed(2));
});

test('a ragdoll with no impulse still falls over', () => {
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  settle(rag);
  assert.ok(rag.nodes.head.y < 0.5, 'gravity alone must be enough');
});

// ---- Fall damage ----
test('short drops are free and long ones are not', () => {
  assert.strictEqual(CORE.fallDamage(0), 0);
  assert.strictEqual(CORE.fallDamage(CORE.FALL_SAFE_SPEED), 0, 'the safe speed is safe');
  // The curve is quadratic, so a drop barely over the threshold rounds to zero
  // rather than chipping a point off. That soft shoulder is the point — BUG-07 was
  // a damage cliff, and putting one back here would be the same mistake.
  assert.strictEqual(CORE.fallDamage(CORE.FALL_SAFE_SPEED + 0.1), 0, 'no cliff at the edge');
  assert.ok(CORE.fallDamage(CORE.FALL_SAFE_SPEED * 1.3) > 0, 'but a real overshoot hurts');
  assert.strictEqual(CORE.fallDamage(CORE.FALL_LETHAL_SPEED), 100);
  assert.strictEqual(CORE.fallDamage(999), 100, 'and never more than 100');
});

test('fall damage rises with impact speed and never goes backwards', () => {
  let prev = -1;
  for (let v = 0; v <= 30; v += 0.5) {
    const d = CORE.fallDamage(v);
    assert.ok(d >= prev, 'damage fell between ' + (v - 0.5) + ' and ' + v);
    prev = d;
  }
});

test('a jump off a crate is survivable and a drop off the roof is not', () => {
  // Impact speed for a free fall from h is sqrt(2 g h) with the game's gravity.
  const g = 16;
  const speedFrom = (h) => Math.sqrt(2 * g * h);
  assert.strictEqual(CORE.fallDamage(speedFrom(1.5)), 0, 'stepping off a crate');
  assert.strictEqual(CORE.fallDamage(speedFrom(2.8)), 0, 'off a container');
  assert.ok(CORE.fallDamage(speedFrom(6.9)) > 0, 'off the central building roof');
  assert.ok(CORE.fallDamage(speedFrom(6.9)) < 100, 'but it should not be an instant kill');
});

test('a hard landing costs speed, a soft one does not', () => {
  assert.strictEqual(CORE.landingSpeedMul(CORE.FALL_SAFE_SPEED), 1);
  assert.ok(CORE.landingSpeedMul(CORE.FALL_SAFE_SPEED * 1.5) < 1);
  assert.ok(CORE.landingSpeedMul(99) > 0, 'never zero, never negative');
  let prev = 2;
  for (let v = 0; v <= 40; v += 1) {
    const m = CORE.landingSpeedMul(v);
    assert.ok(m <= prev + 1e-9, 'the penalty must not ease off as the drop grows');
    prev = m;
  }
});

// ============================================================================
// Phase 13 — meta progression
// ============================================================================

test('rank thresholds ascend and rank 1 is free', () => {
  assert.strictEqual(CORE.xpForRank(1), 0, 'a new player starts at rank 1');
  assert.strictEqual(CORE.xpForRank(0), 0, 'and no rank below it costs anything');
  for (let r = 2; r <= CORE.MAX_RANK; r++) {
    assert.ok(CORE.xpForRank(r) > CORE.xpForRank(r - 1), 'rank ' + r + ' must cost more');
  }
});

test('later ranks cost more than earlier ones', () => {
  // A flat curve makes rank 19 feel the same as rank 2. "Never decreases" is not
  // enough to catch that — a straight line satisfies it — so require the last step
  // to be meaningfully larger than the first.
  let prevStep = 0;
  const steps = [];
  for (let r = 2; r <= CORE.MAX_RANK; r++) {
    const step = CORE.xpForRank(r) - CORE.xpForRank(r - 1);
    assert.ok(step >= prevStep, 'the curve flattened at rank ' + r);
    steps.push(step);
    prevStep = step;
  }
  assert.ok(steps[steps.length - 1] > steps[0] * 2,
    'the last rank must cost far more than the first: ' +
    steps[0] + ' -> ' + steps[steps.length - 1]);
});

test('rank is derived from XP, so a corrupt rank cannot exist', () => {
  assert.strictEqual(CORE.rankForXp(0), 1);
  assert.strictEqual(CORE.rankForXp(-9999), 1, 'negative XP is still rank 1');
  assert.strictEqual(CORE.rankForXp(CORE.xpForRank(5)), 5, 'exactly on a threshold ranks up');
  assert.strictEqual(CORE.rankForXp(CORE.xpForRank(5) - 1), 4, 'one short does not');
  assert.strictEqual(CORE.rankForXp(1e12), CORE.MAX_RANK, 'and it caps');
});

test('the rank bar is full at max rank, not empty', () => {
  const mid = CORE.rankProgress(CORE.xpForRank(3));
  assert.strictEqual(mid.rank, 3);
  assert.strictEqual(mid.max, false);
  assert.ok(mid.pct >= 0 && mid.pct < 1);
  const max = CORE.rankProgress(1e12);
  assert.strictEqual(max.max, true);
  assert.strictEqual(max.pct, 1, 'a maxed bar reading empty looks like a bug');
});

test('rank progress never divides by zero or reports nonsense', () => {
  for (const xp of [0, 1, 500, 5000, 50000, 1e9]) {
    const p = CORE.rankProgress(xp);
    assert.ok(isFinite(p.pct) && p.pct >= 0 && p.pct <= 1, 'xp ' + xp + ' gave pct ' + p.pct);
    assert.ok(p.rank >= 1 && p.rank <= CORE.MAX_RANK);
  }
});

test('XP rewards difficulty rather than duration', () => {
  const base = { kills: 100, headshots: 0, wave: 5, accuracy: 20 };
  const moreHeads = Object.assign({}, base, { headshots: 40 });
  const deeper = Object.assign({}, base, { wave: 10 });
  const sharper = Object.assign({}, base, { accuracy: 70 });
  assert.ok(CORE.runXp(moreHeads) > CORE.runXp(base), 'headshots are worth more');
  assert.ok(CORE.runXp(deeper) > CORE.runXp(base), 'getting further is worth more');
  assert.ok(CORE.runXp(sharper) > CORE.runXp(base), 'accuracy is worth more');
});

test('wave value accelerates, so progress beats repetition', () => {
  // Comparing one deep run against fourteen shallow ones proves nothing — fourteen
  // runs bank fourteen runs' worth of kills. The property that actually matters is
  // that each wave is worth MORE than the one before, so pushing deeper pays better
  // per run than restarting.
  assert.ok(CORE.runXp({ wave: 10 }) > CORE.runXp({ wave: 5 }) * 2,
    'wave value must accelerate, not stay linear');
  let prevStep = 0;
  for (let w = 2; w <= 20; w++) {
    const step = CORE.runXp({ wave: w }) - CORE.runXp({ wave: w - 1 });
    assert.ok(step >= prevStep, 'wave ' + w + ' is worth less than the step before it');
    prevStep = step;
  }
  // And with kills held equal, the deeper run wins outright.
  const deep = CORE.runXp({ kills: 50, headshots: 0, wave: 14, accuracy: 30 });
  const shallow = CORE.runXp({ kills: 50, headshots: 0, wave: 1, accuracy: 30 });
  assert.ok(deep > shallow * 3, 'same kills, far deeper: ' + deep + ' vs ' + shallow);
});

test('a victory is worth more than dying on the last wave', () => {
  const run = { kills: 300, headshots: 60, wave: 15, accuracy: 45 };
  assert.ok(CORE.runXp(Object.assign({}, run, { victory: true })) > CORE.runXp(run));
});

test('XP is never negative and tolerates a missing or junk run', () => {
  assert.strictEqual(CORE.runXp(null), 0);
  assert.strictEqual(CORE.runXp(undefined), 0);
  assert.strictEqual(CORE.runXp({}), 0);
  assert.ok(CORE.runXp({ kills: -50, headshots: -9, wave: -3, accuracy: -100 }) >= 0);
  assert.ok(isFinite(CORE.runXp({ kills: 1e9, wave: 1e9, accuracy: 1e9 })));
});

test('accuracy is clamped, so a bogus 900% does not mint XP', () => {
  const fair = CORE.runXp({ kills: 10, headshots: 0, wave: 1, accuracy: 100 });
  const bogus = CORE.runXp({ kills: 10, headshots: 0, wave: 1, accuracy: 900 });
  assert.strictEqual(bogus, fair);
});

// ---- Weapon unlocks ----
test('two weapons are available at rank 1 and the rest are earned', () => {
  const atOne = [0, 1, 2, 3].filter((i) => CORE.weaponUnlocked(i, 1));
  assert.strictEqual(atOne.length, 2, 'a new player still needs a choice on deploy');
  const atMax = [0, 1, 2, 3].filter((i) => CORE.weaponUnlocked(i, CORE.MAX_RANK));
  assert.strictEqual(atMax.length, 4, 'everything unlocks eventually');
});

test('a weapon unlock never un-unlocks as rank climbs', () => {
  for (let i = 0; i < 4; i++) {
    let seen = false;
    for (let r = 1; r <= CORE.MAX_RANK; r++) {
      const u = CORE.weaponUnlocked(i, r);
      if (seen) assert.strictEqual(u, true, 'weapon ' + i + ' re-locked at rank ' + r);
      if (u) seen = true;
    }
    assert.strictEqual(seen, true, 'weapon ' + i + ' never unlocks at all');
  }
});

test('an unknown weapon index is unlocked rather than unreachable', () => {
  // A weapon added to CFG without a rank entry must be usable, not a dead card.
  assert.strictEqual(CORE.weaponUnlocked(99, 1), true);
  assert.strictEqual(CORE.weaponUnlockRank(99), 1);
});

test('every unlock rank is reachable', () => {
  for (let i = 0; i < CORE.WEAPON_UNLOCK_RANK.length; i++) {
    assert.ok(CORE.weaponUnlockRank(i) <= CORE.MAX_RANK,
      'weapon ' + i + ' needs rank ' + CORE.weaponUnlockRank(i) + ' but max is ' + CORE.MAX_RANK);
  }
});

// ---- Challenges ----
test('every challenge names a stat the store actually has', () => {
  const stats = CORE.defaultStats();
  for (const c of CORE.CHALLENGES) {
    assert.ok(Object.prototype.hasOwnProperty.call(stats, c.stat),
      c.key + ' tracks "' + c.stat + '", which is not a stat');
    assert.ok(c.target > 0, c.key + ' needs a target');
    assert.ok(c.name && c.blurb, c.key + ' needs a name and a blurb');
  }
});

test('challenge keys are unique', () => {
  const keys = CORE.CHALLENGES.map((c) => c.key);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('nothing is complete on a fresh save and progress is reported honestly', () => {
  const fresh = CORE.defaultStats();
  assert.strictEqual(CORE.challengesDone(fresh), 0);
  for (const c of CORE.CHALLENGES) {
    const p = CORE.challengeProgress(fresh, c);
    assert.strictEqual(p.done, false);
    assert.strictEqual(p.pct, 0);
  }
});

test('a challenge completes exactly at its target and stays complete', () => {
  const def = CORE.CHALLENGES.filter((c) => c.stat === 'totalKills')[0];
  const just = CORE.challengeProgress({ totalKills: def.target }, def);
  assert.strictEqual(just.done, true);
  assert.strictEqual(just.pct, 1);
  const short = CORE.challengeProgress({ totalKills: def.target - 1 }, def);
  assert.strictEqual(short.done, false);
  const over = CORE.challengeProgress({ totalKills: def.target * 10 }, def);
  assert.strictEqual(over.done, true);
  assert.strictEqual(over.pct, 1, 'the bar must not overflow past full');
});

test('challenge progress survives corrupt stats', () => {
  for (const bad of [null, undefined, 'nope', { totalKills: 'lots' }, { totalKills: NaN }]) {
    const p = CORE.challengeProgress(bad, CORE.CHALLENGES[0]);
    assert.ok(isFinite(p.pct) && p.pct >= 0 && p.pct <= 1, JSON.stringify(bad));
    assert.strictEqual(p.done, false);
  }
});

// ---- The run -> stats -> rank round trip ----
test('a run banks XP, headshots and streaks into the career store', () => {
  const run = { score: 9000, wave: 12, accuracy: 50, kills: 150, headshots: 40, streaks: 3 };
  const r = CORE.mergeRunIntoStats(CORE.defaultStats(), run);
  assert.strictEqual(r.stats.totalKills, 150);
  assert.strictEqual(r.stats.totalHeadshots, 40);
  assert.strictEqual(r.stats.totalStreaks, 3);
  assert.strictEqual(r.stats.xp, CORE.runXp(run));
  assert.strictEqual(r.xpGained, CORE.runXp(run));
  assert.strictEqual(r.rank, CORE.rankForXp(r.stats.xp));
});

test('ranking up is reported once, on the run that does it', () => {
  let stats = CORE.defaultStats();
  const tiny = { score: 1, wave: 1, accuracy: 0, kills: 1, headshots: 0, streaks: 0 };
  let sawRankUp = 0, ranks = [1];
  for (let i = 0; i < 12; i++) {
    const r = CORE.mergeRunIntoStats(stats, tiny);
    stats = r.stats;
    if (r.beat.rank) sawRankUp++;
    ranks.push(r.rank);
  }
  const distinct = new Set(ranks).size - 1;
  assert.strictEqual(sawRankUp, distinct,
    'a rank-up must be announced exactly as often as the rank actually changes');
});

test('a run with no XP does not rank anyone up', () => {
  const r = CORE.mergeRunIntoStats(CORE.defaultStats(), {});
  assert.strictEqual(r.xpGained, 0);
  assert.strictEqual(r.beat.rank, false);
  assert.strictEqual(r.rank, 1);
});

test('career XP accumulates across runs rather than replacing', () => {
  const run = { score: 1, wave: 4, accuracy: 20, kills: 30, headshots: 5 };
  const a = CORE.mergeRunIntoStats(CORE.defaultStats(), run);
  const b = CORE.mergeRunIntoStats(a.stats, run);
  assert.strictEqual(b.stats.xp, a.stats.xp * 2);
  assert.strictEqual(b.stats.runs, 2);
});

test('a corrupt XP total is clamped, not trusted', () => {
  for (const bad of [-5000, NaN, Infinity, 'loads', null]) {
    const s = CORE.sanitizeStats({ xp: bad });
    assert.ok(isFinite(s.xp) && s.xp >= 0, 'xp: ' + String(bad));
    assert.ok(CORE.rankForXp(s.xp) >= 1);
  }
});

// ============================================================================
// Attachments (13.3) and objective waves (12.4)
// ============================================================================

const M4 = { name: 'M4 Carbine', type: 'AR', dmg: 26, rpm: 750, mag: 30, reserveMax: 150,
             reload: 2.1, spread: 0.014, adsSpread: 0.004, recoilV: 0.014, recoilH: 0.006,
             range: 120, auto: true };

test('every attachment declares a real slot, a rank and a trade', () => {
  for (const a of CORE.ATTACHMENTS) {
    assert.ok(CORE.ATTACH_SLOTS.indexOf(a.slot) >= 0, a.key + ' has slot "' + a.slot + '"');
    assert.ok(a.rank >= 1, a.key + ' needs an unlock rank');
    assert.ok(a.name && a.blurb, a.key + ' needs a name and a blurb');
    assert.ok(Object.keys(a.mods).length > 0, a.key + ' modifies nothing');
    assert.strictEqual(CORE.attachmentByKey(a.key), a);
  }
  assert.strictEqual(CORE.attachmentByKey('laser_sight_9000'), null);
});

test('nothing is strictly better than an empty slot', () => {
  // If an attachment is all upside, the "choice" is a checklist.
  for (const a of CORE.ATTACHMENTS) {
    const d = CORE.attachmentDelta(a);
    assert.ok(d.down.length > 0, a.key + ' has no downside, so it is not a trade');
    assert.ok(d.up.length > 0, a.key + ' has no upside, so nobody would take it');
  }
});

test('every slot has something in it, and every attachment is reachable', () => {
  for (const slot of CORE.ATTACH_SLOTS) {
    assert.ok(CORE.attachmentsForSlot(slot).length > 0, slot + ' is empty');
    assert.ok(CORE.ATTACH_SLOT_NAME[slot], slot + ' has no display name');
  }
  for (const a of CORE.ATTACHMENTS) {
    assert.ok(a.rank <= CORE.MAX_RANK, a.key + ' needs rank ' + a.rank + ' but max is ' + CORE.MAX_RANK);
  }
  const keys = CORE.ATTACHMENTS.map((a) => a.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate attachment key');
});

test('attachments multiply the fields they name and leave the rest alone', () => {
  const eff = CORE.applyAttachments(M4, { mag: 'extmag' });
  const ext = CORE.attachmentByKey('extmag');
  assert.strictEqual(eff.mag, Math.round(M4.mag * ext.mods.mag));
  assert.ok(Math.abs(eff.reload - M4.reload * ext.mods.reload) < 1e-9);
  assert.strictEqual(eff.dmg, M4.dmg, 'an untouched field must not move');
  assert.strictEqual(eff.name, M4.name);
});

test('applying attachments never mutates the base weapon', () => {
  // CFG.weapons is shared across runs; an in-place modify leaks into the next one.
  const snapshot = JSON.stringify(M4);
  CORE.applyAttachments(M4, { mag: 'extmag', barrel: 'longbarrel', under: 'foregrip' });
  assert.strictEqual(JSON.stringify(M4), snapshot);
});

test('a full loadout composes, one slot at a time', () => {
  const full = { optic: 'reddot', barrel: 'longbarrel', under: 'foregrip',
                 mag: 'extmag', stock: 'heavystock' };
  const eff = CORE.applyAttachments(M4, full);
  let expectedRecoilV = M4.recoilV;
  for (const key of ['reddot', 'longbarrel', 'foregrip', 'extmag', 'heavystock']) {
    const m = CORE.attachmentByKey(key).mods.recoilV;
    if (m !== undefined) expectedRecoilV *= m;
  }
  assert.ok(Math.abs(eff.recoilV - expectedRecoilV) < 1e-12, 'recoil must compose across slots');
  assert.strictEqual(eff.attachments.length, 5);
});

test('magazine and reserve stay whole numbers', () => {
  for (const w of [M4, { mag: 5, reserveMax: 35, dmg: 120 }, { mag: 32, reserveMax: 160, dmg: 18 }]) {
    const eff = CORE.applyAttachments(w, { mag: 'extmag' });
    assert.strictEqual(eff.mag, Math.round(eff.mag), 'a magazine of 7.5 rounds is not a thing');
    assert.strictEqual(eff.reserveMax, Math.round(eff.reserveMax));
    assert.ok(eff.mag >= 1, 'a magazine can never round down to zero');
  }
  // Even a shrinking magazine must leave at least one round. mag 1 x 0.85 rounds
  // back to 1, so the case that actually exercises the floor is a zero.
  assert.ok(CORE.applyAttachments({ mag: 1, reserveMax: 0 }, { mag: 'fastmag' }).mag >= 1);
  assert.ok(CORE.applyAttachments({ mag: 0, reserveMax: 0 }, { mag: 'fastmag' }).mag >= 1,
    'a weapon can never end up unable to hold a round');
  assert.ok(CORE.applyAttachments({ mag: 0, reserveMax: 0 }, {}).mag >= 1);
});

test('a non-numeric weapon field is left alone rather than turned into NaN', () => {
  // applyAttachments walks a fixed field list, so the only thing standing between a
  // malformed weapon and a NaN magazine is the type guard.
  // '30' and null both COERCE to numbers, so they prove nothing — the values that
  // expose a missing type guard are the ones that coerce to NaN.
  const weird = { mag: 'thirty', reserveMax: undefined, reload: 2.1, dmg: 26 };
  const eff = CORE.applyAttachments(weird, { mag: 'extmag' });
  assert.ok(!Number.isNaN(eff.reserveMax), 'reserveMax must not become NaN');
  assert.ok(!Number.isNaN(eff.mag), 'mag must not become NaN, it must be left as it was');
  assert.strictEqual(eff.mag, 'thirty', 'a non-numeric field is left untouched');
  assert.ok(Math.abs(eff.reload - 2.1 * CORE.attachmentByKey('extmag').mods.reload) < 1e-9,
    'and the fields that ARE numeric still apply');
});

test('fields the base weapon lacks get a neutral default', () => {
  const eff = CORE.applyAttachments(M4, {});
  assert.strictEqual(eff.adsSpeed, 1);
  assert.strictEqual(eff.penetration, 1);
  assert.strictEqual(eff.sway, 1);
  assert.strictEqual(eff.moveMul, 1);
});

test('a loadout is sanitised against slot, existence and rank', () => {
  assert.deepStrictEqual(CORE.sanitizeLoadout({ optic: 'foregrip' }, 99), {},
    'a foregrip is not an optic');
  assert.deepStrictEqual(CORE.sanitizeLoadout({ optic: 'not_a_thing' }, 99), {});
  assert.deepStrictEqual(CORE.sanitizeLoadout({ optic: 'reddot' }, 1), {},
    'rank 1 cannot equip a rank 2 optic');
  assert.deepStrictEqual(CORE.sanitizeLoadout({ optic: 'reddot' }, 99), { optic: 'reddot' });
  assert.deepStrictEqual(CORE.sanitizeLoadout(null, 99), {});
  assert.deepStrictEqual(CORE.sanitizeLoadout('nope', 99), {});
});

test('a loadout can never stack two attachments in one slot', () => {
  const lo = CORE.sanitizeLoadout({ optic: 'reddot', barrel: 'longbarrel' }, 99);
  assert.strictEqual(Object.keys(lo).length, 2);
  for (const slot in lo) {
    assert.strictEqual(CORE.attachmentByKey(lo[slot]).slot, slot);
  }
});

test('an unsanitised loadout cannot smuggle a locked attachment through', () => {
  // applyAttachments trusts its input, so the rank gate lives in sanitizeLoadout and
  // every read path has to go through it.
  const gated = CORE.sanitizeLoadout({ optic: 'scope4x' }, 1);
  assert.deepStrictEqual(gated, {});
  const eff = CORE.applyAttachments(M4, gated);
  assert.strictEqual(eff.adsSpread, M4.adsSpread, 'nothing should have been applied');
});

test('the delta flips the arrow for stats where lower is better', () => {
  const grip = CORE.attachmentDelta(CORE.attachmentByKey('foregrip'));
  const fields = grip.up.map((x) => x.field);
  assert.ok(fields.indexOf('recoilV') >= 0, 'less recoil has to read as an upside');
  assert.ok(grip.down.map((x) => x.field).indexOf('adsSpeed') >= 0, 'slower ADS is a downside');
  const ext = CORE.attachmentDelta(CORE.attachmentByKey('extmag'));
  assert.ok(ext.down.map((x) => x.field).indexOf('reload') >= 0, 'a longer reload is a downside');
  assert.deepStrictEqual(CORE.attachmentDelta(null), { up: [], down: [] });
});

// ---- Objective waves ----
test('objective waves land on their cadence and never on a special', () => {
  for (let n = 1; n <= 60; n++) {
    const obj = CORE.objectiveWaveAt(n);
    if (CORE.specialWaveAt(n)) {
      assert.strictEqual(obj, false,
        'wave ' + n + ' is already a special — two announced modifiers reads as noise');
    } else if (n >= CORE.OBJECTIVE_EVERY && n % CORE.OBJECTIVE_EVERY === 0) {
      assert.strictEqual(obj, true, 'wave ' + n);
    } else {
      assert.strictEqual(obj, false, 'wave ' + n);
    }
  }
});

test('early waves carry no objective', () => {
  for (let n = 1; n < CORE.OBJECTIVE_EVERY; n++) {
    assert.strictEqual(CORE.objectiveWaveAt(n), false);
  }
});

test('holding builds progress and leaving drains it', () => {
  // "Stand here once" is not a hold. Leaving has to cost something.
  let t = 0;
  for (let i = 0; i < 60 * 5; i++) t = CORE.objectiveProgress(t, 1 / 60, true);
  assert.ok(Math.abs(t - 5) < 0.05, 'five seconds inside is five seconds of progress');
  const peak = t;
  for (let i = 0; i < 60 * 4; i++) t = CORE.objectiveProgress(t, 1 / 60, false);
  assert.ok(t < peak, 'leaving must drain');
  assert.ok(t > 0, 'but not instantly wipe it');
});

test('progress never goes negative or past the requirement', () => {
  let t = 0;
  for (let i = 0; i < 60 * 30; i++) t = CORE.objectiveProgress(t, 1 / 60, false);
  assert.strictEqual(t, 0, 'draining bottoms out at zero');
  for (let i = 0; i < 60 * 120; i++) t = CORE.objectiveProgress(t, 1 / 60, true);
  assert.strictEqual(t, CORE.OBJECTIVE_HOLD, 'and banking stops at the requirement');
  assert.strictEqual(CORE.objectiveComplete(t), true);
});

test('an objective completes only at the full hold', () => {
  assert.strictEqual(CORE.objectiveComplete(CORE.OBJECTIVE_HOLD - 0.01), false);
  assert.strictEqual(CORE.objectiveComplete(CORE.OBJECTIVE_HOLD), true);
  assert.strictEqual(CORE.objectiveComplete(0), false);
});

test('the zone is placed away from the player', () => {
  const ring = [];
  for (let a = 0; a < 12; a++) {
    const g = a / 12 * Math.PI * 2;
    ring.push([Math.cos(g) * 33, Math.sin(g) * 33]);
  }
  const i = CORE.pickObjectiveSpot(ring, 0, 24, 18);
  assert.ok(i >= 0);
  const d = Math.hypot(ring[i][0] - 0, ring[i][1] - 24);
  assert.ok(d >= 18, 'the objective must be a move, not a stand-still: ' + d.toFixed(1));
});

test('a zone is still placed when nothing is far enough away', () => {
  // Refusing to place one would silently drop the objective for that wave.
  const cramped = [[0, 0], [1, 0], [0, 1]];
  const i = CORE.pickObjectiveSpot(cramped, 0, 0, 50);
  assert.ok(i >= 0 && i < cramped.length, 'it must fall back to the furthest option');
});

test('the minimum distance is a hard floor, not just a preference', () => {
  // The scoring prefers roughly min+8, which USUALLY excludes near points on its
  // own. This is the arrangement where it does not: a point just inside the floor
  // scores better than the only qualifying one, so only the explicit guard keeps
  // the objective from spawning on top of the player.
  const candidates = [[0, 17], [0, 60]];
  const i = CORE.pickObjectiveSpot(candidates, 0, 0, 18);
  assert.strictEqual(i, 1,
    'the 17 m option is inside the floor and must be rejected even though it scores better');
});

// ============================================================================
// Reach needs a vertical gate, and ragdoll collision needs a broad phase
// ============================================================================

test('reach requires being close horizontally AND on the same level', () => {
  // BUG-02 made every gameplay radius horizontal, which was right: player.pos sits
  // at eye height and a 3-D distance read 1.7 m of pure height as separation. But
  // horizontal-only makes a whole storey invisible — an agent on the ground floor
  // measured zero distance from a player on the slab 5.85 m above it and swung
  // through the concrete.
  assert.strictEqual(CORE.withinReach(1.5, 0, 2.5), true, 'beside each other');
  assert.strictEqual(CORE.withinReach(0, 5.85, 2.5), false, 'directly below, one storey');
  assert.strictEqual(CORE.withinReach(0, -5.85, 2.5), false, 'directly above, one storey');
  assert.strictEqual(CORE.withinReach(9, 0, 2.5), false, 'same level, far away');
});

test('the vertical allowance is generous enough for a crate', () => {
  // An agent standing on a crate or a step must still reach a player beside it.
  // Only a whole storey should break contact.
  assert.strictEqual(CORE.withinReach(1.5, 1.2, 2.5), true, 'on a knee-high crate');
  assert.strictEqual(CORE.withinReach(1.5, -1.2, 2.5), true, 'player on the crate');
  assert.ok(CORE.REACH_MAX_VERT >= 1.8, 'a step up must not break melee');
  assert.ok(CORE.REACH_MAX_VERT < 3.4, 'but a floor must');
});

test('the vertical gate is symmetric and respects its own boundary', () => {
  const v = CORE.REACH_MAX_VERT;
  assert.strictEqual(CORE.withinReach(1, v, 2.5), true, 'exactly at the limit is in');
  assert.strictEqual(CORE.withinReach(1, -v, 2.5), true);
  assert.strictEqual(CORE.withinReach(1, v + 0.01, 2.5), false, 'just past it is out');
  assert.strictEqual(CORE.withinReach(1, -v - 0.01, 2.5), false);
});

test('reach respects the horizontal boundary too, and rejects junk', () => {
  assert.strictEqual(CORE.withinReach(2.5, 0, 2.5), true, 'exactly at reach is in');
  assert.strictEqual(CORE.withinReach(2.51, 0, 2.5), false);
  assert.strictEqual(CORE.withinReach(NaN, 0, 2.5), false, 'NaN must not read as in reach');
  assert.strictEqual(CORE.withinReach(1, NaN, 2.5), false);
});

test('a caller can tighten the vertical allowance but not lose it', () => {
  assert.strictEqual(CORE.withinReach(1, 1.5, 2.5, 1.0), false, 'explicit tighter limit');
  assert.strictEqual(CORE.withinReach(1, 0.5, 2.5, 1.0), true);
  assert.strictEqual(CORE.withinReach(1, 1.5, 2.5, undefined), true, 'undefined uses the default');
});

// ---- Ragdoll broad phase ----
// Named ragBox, not box: the penetration tests already declare a top-level ragBox(),
// and a second one silently replaced it — those tests then ran against untagged
// colliders and failed. Same shared-scope hazard as ENG-05, in the test file.
function ragBox(x, y, z, w, h, d) {
  return { min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
           max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 } };
}

test('narrowing the collider list does not change where a body ends up', () => {
  // The broad phase is an optimisation, so it has to be invisible in the result.
  const near = ragBox(0, 0.75, 0, 3, 1.5, 3);
  const far = [];
  for (let i = 0; i < 200; i++) far.push(ragBox(200 + i * 5, 2, 200, 4, 4, 4));
  const withFar = CORE.makeRagdoll(0, 1.5, 0, 0);
  const withoutFar = CORE.makeRagdoll(0, 1.5, 0, 0);
  for (let i = 0; i < 400; i++) {
    CORE.ragdollStep(withFar, 1 / 60, [near].concat(far), 0);
    CORE.ragdollStep(withoutFar, 1 / 60, [near], 0);
  }
  for (const k in withFar.nodes) {
    assert.ok(Math.abs(withFar.nodes[k].y - withoutFar.nodes[k].y) < 1e-9,
      k + ' moved differently once distant boxes were in the list');
  }
});

test('a body still lands on the box under it after narrowing', () => {
  const crate = ragBox(0, 0.75, 0, 3, 1.5, 3);
  const rag = CORE.makeRagdoll(0, 1.5, 0, 0);
  for (let i = 0; i < 500; i++) CORE.ragdollStep(rag, 1 / 60, [crate], 0);
  for (const p of rag.order) {
    const inside = p.x > crate.min.x && p.x < crate.max.x &&
                   p.z > crate.min.z && p.z < crate.max.z &&
                   p.y < crate.max.y - 0.05 && p.y > crate.min.y;
    assert.strictEqual(inside, false, p.key + ' sank into the crate');
  }
});

test('a body thrown at a wall does not pass through it', () => {
  const wall = ragBox(0, 2, 3, 10, 4, 0.8);
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  CORE.ragdollImpulse(rag, 'chest', 0, 0.02, 0.12);   // hurled at the wall
  for (let i = 0; i < 500; i++) CORE.ragdollStep(rag, 1 / 60, [wall], 0);
  for (const p of rag.order) {
    assert.ok(p.z <= wall.max.z + 0.01,
      p.key + ' ended past the wall at z=' + p.z.toFixed(2));
  }
});

test('collision runs on the iterations that matter', () => {
  // Constraint solving is what pushes nodes into geometry, so resolving has to come
  // after it. Running on zero iterations would let bodies settle inside walls.
  assert.ok(CORE.RAGDOLL_ITERATIONS >= 3, 'too few iterations and the skeleton folds');
  const floor = ragBox(0, -0.5, 0, 40, 1, 40);
  const rag = CORE.makeRagdoll(0, 0, 0, 0);
  for (let i = 0; i < 400; i++) CORE.ragdollStep(rag, 1 / 60, [floor], -99);
  for (const p of rag.order) {
    assert.ok(p.y >= floor.max.y - 0.01,
      p.key + ' at y=' + p.y.toFixed(2) + ' sank into a floor box with no ground plane');
  }
});

test('a box standing on the ground never pushes a corpse under the world', () => {
  // The bottom face of a ground-level crate is usually the SHALLOWEST exit for a
  // node resting inside it, so the push-out chose it and drove legs to
  // b.min.y - radius. Measured at y = -0.11 on the crates at z = 30, and the ground
  // clamp cannot save it because that runs earlier in the same call.
  const crate = ragBox(0, 0.75, 0, 3, 1.5, 3);   // sits ON the ground, y 0..1.5
  const rag = CORE.makeRagdoll(0, 0, 0, 0);      // spawned standing inside it
  for (let i = 0; i < 600; i++) {
    CORE.ragdollStep(rag, 1 / 60, [crate], 0);
    for (const p of rag.order) {
      assert.ok(p.y >= -1e-6, p.key + ' went under the world at y=' + p.y.toFixed(3));
    }
  }
});

test('a box floating above the ground can still push downward', () => {
  // The fix must only block the downward exit when it would breach the ground, not
  // disable it outright - a node under an overhang has to be pushed clear.
  const shelf = ragBox(0, 3, 0, 4, 1, 4);        // y 2.5..3.5, well clear
  // Sitting below the shelf's mid-height, so DOWN is the shallower exit: 0.55 m out
  // versus 0.75 m up. Accepting either direction would not notice the downward exit
  // being disabled outright, which is the mutation this pins.
  const p = { x: 0, y: 2.9, z: 0, px: 0, py: 2.9, pz: 0, r: 0.15, key: 'test' };
  CORE.ragdollCollide(p, [shelf], 0);
  assert.ok(Math.abs(p.y - (shelf.min.y - p.r)) < 1e-9,
    'it must take the shallower downward exit, not be forced up: y=' + p.y.toFixed(3));
  assert.ok(p.y > 0, 'and it must still be above the ground');
});

test('isHealthLow reports true at or below threshold and false above', () => {
  assert.strictEqual(CORE.HEALTH_LOW_THRESHOLD, 0.30);
  assert.strictEqual(CORE.isHealthLow(30, 100), true);
  assert.strictEqual(CORE.isHealthLow(29, 100), true);
  assert.strictEqual(CORE.isHealthLow(0, 100), true);
  assert.strictEqual(CORE.isHealthLow(31, 100), false);
  assert.strictEqual(CORE.isHealthLow(100, 100), false);
  // Scales with Juggernaut max HP (150)
  assert.strictEqual(CORE.isHealthLow(45, 150), true);
  assert.strictEqual(CORE.isHealthLow(46, 150), false);
  // Default max HP fallback when omitted
  assert.strictEqual(CORE.isHealthLow(30), true);
  assert.strictEqual(CORE.isHealthLow(31), false);
  // Rejects invalid/non-numeric/NaN/Infinity inputs safely
  assert.strictEqual(CORE.isHealthLow(NaN, 100), false);
  assert.strictEqual(CORE.isHealthLow(Infinity, 100), false);
  assert.strictEqual(CORE.isHealthLow('30', 100), false);
  assert.strictEqual(CORE.isHealthLow(undefined, 100), false);
});

test('soundPlaybackRate applies ±3% jitter around base rate', () => {
  assert.strictEqual(CORE.SOUND_VARIED_RANGE, 0.06);
  assert.strictEqual(CORE.soundPlaybackRate(1, 0.5), 1.0);
  assert.strictEqual(Math.round(CORE.soundPlaybackRate(1, 0) * 100) / 100, 0.97);
  assert.strictEqual(Math.round(CORE.soundPlaybackRate(1, 1) * 100) / 100, 1.03);
  // Custom base rate
  assert.strictEqual(CORE.soundPlaybackRate(1.5, 0.5), 1.5);
  // Default fallbacks for missing/invalid inputs
  assert.strictEqual(CORE.soundPlaybackRate(undefined, 0.5), 1.0);
  assert.strictEqual(CORE.soundPlaybackRate(NaN, 0.5), 1.0);
  assert.strictEqual(CORE.soundPlaybackRate('1', 0.5), 1.0);
  const randSample = CORE.soundPlaybackRate(1);
  assert.ok(randSample >= 0.97 && randSample <= 1.03, 'random sample stays within ±3%');
});

test('isAutoSprint triggers on forward joystick tilt above threshold without ADS', () => {
  assert.strictEqual(CORE.JOYSTICK_SPRINT_FORWARD, 0.72);
  assert.strictEqual(CORE.JOYSTICK_SPRINT_MAGNITUDE, 0.82);
  // Full forward push (moveX: 0, moveZ: 1.0, ads: false) -> sprints
  assert.strictEqual(CORE.isAutoSprint(0, 1.0, false), true);
  // Forward-right diagonal (moveX: 0.45, moveZ: 0.75, magnitude = 0.875) -> sprints
  assert.strictEqual(CORE.isAutoSprint(0.45, 0.75, false), true);
  // ADS blocks sprint regardless of joystick deflection
  assert.strictEqual(CORE.isAutoSprint(0, 1.0, true), false);
  assert.strictEqual(CORE.isAutoSprint(0.45, 0.75, true), false);
  // Deflection below forward threshold fails even if magnitude is large (e.g. side-strafe)
  assert.strictEqual(CORE.isAutoSprint(0.85, 0.5, false), false);
  // Deflection below magnitude threshold fails even with forward tilt
  assert.strictEqual(CORE.isAutoSprint(0, 0.75, false), false);
  // Neutral/center stick fails
  assert.strictEqual(CORE.isAutoSprint(0, 0, false), false);
  // Backward tilt fails
  assert.strictEqual(CORE.isAutoSprint(0, -1.0, false), false);
  // Rejects invalid/non-numeric/NaN/Infinity inputs safely
  assert.strictEqual(CORE.isAutoSprint(NaN, 1.0, false), false);
  assert.strictEqual(CORE.isAutoSprint(0, Infinity, false), false);
  assert.strictEqual(CORE.isAutoSprint('0', 1.0, false), false);
  assert.strictEqual(CORE.isAutoSprint(undefined, 1.0, false), false);
});

test('joystickInput clamps radius, maps screen delta to movement axes, and gates deadzone', () => {
  assert.strictEqual(CORE.JOYSTICK_RADIUS, 56);
  assert.strictEqual(CORE.JOYSTICK_DEADZONE, 0.12);

  // Full forward push (up on screen is negative dy = -56) -> clamped (0, -56), moveX 0, moveZ +1.0
  const fwd = CORE.joystickInput(0, -56, 56, 0.12);
  assert.strictEqual(fwd.clampedX, 0);
  assert.strictEqual(fwd.clampedY, -56);
  assert.strictEqual(fwd.moveX, 0);
  assert.strictEqual(fwd.moveZ, 1.0);

  // Over-displacement (> radius): clamps stick displacement to radius (56)
  const over = CORE.joystickInput(0, -112, 56, 0.12);
  assert.strictEqual(over.clampedX, 0);
  assert.strictEqual(over.clampedY, -56);
  assert.strictEqual(over.moveX, 0);
  assert.strictEqual(over.moveZ, 1.0);

  // Strafe right (positive dx = +56, dy = 0) -> clamped (56, 0), moveX +1.0, moveZ 0
  const right = CORE.joystickInput(56, 0, 56, 0.12);
  assert.strictEqual(right.clampedX, 56);
  assert.strictEqual(right.clampedY, 0);
  assert.strictEqual(right.moveX, 1.0);
  assert.strictEqual(right.moveZ, 0);

  // Backward push (positive dy = +56) -> clamped (0, 56), moveX 0, moveZ -1.0
  const back = CORE.joystickInput(0, 56, 56, 0.12);
  assert.strictEqual(back.clampedX, 0);
  assert.strictEqual(back.clampedY, 56);
  assert.strictEqual(back.moveX, 0);
  assert.strictEqual(back.moveZ, -1.0);

  // Inside deadzone (< 0.12 * 56 = 6.72 px): visual stick tracks displacement, movement zeroed
  const dead = CORE.joystickInput(4, -4, 56, 0.12);
  assert.strictEqual(dead.clampedX, 4);
  assert.strictEqual(dead.clampedY, -4);
  assert.strictEqual(dead.moveX, 0);
  assert.strictEqual(dead.moveZ, 0);

  // Uses default constants when parameters are omitted
  const def = CORE.joystickInput(0, -56);
  assert.strictEqual(def.clampedY, -56);
  assert.strictEqual(def.moveZ, 1.0);

  // Rejects invalid/non-numeric inputs safely
  const invalid = CORE.joystickInput(NaN, 0);
  assert.strictEqual(invalid.clampedX, 0);
  assert.strictEqual(invalid.clampedY, 0);
  assert.strictEqual(invalid.moveX, 0);
  assert.strictEqual(invalid.moveZ, 0);
});

test('medDropChance scales smoothly with health deficit without binary cliffing', () => {
  assert.strictEqual(CORE.MED_DROP_BASE, 0.15);
  assert.strictEqual(CORE.MED_DROP_CRITICAL, 0.50);
  // Comfortable health (>= 75% max HP) produces base chance
  assert.strictEqual(CORE.medDropChance(100, 100), 0.15);
  assert.strictEqual(CORE.medDropChance(75, 100), 0.15);
  // Critical health (0 HP) yields peak emergency chance
  assert.strictEqual(CORE.medDropChance(0, 100), 0.50);
  // Mid health (50 HP) ramps smoothly (~0.189) rather than jumping to 0.70+
  const mid = CORE.medDropChance(50, 100);
  assert.ok(mid > 0.15 && mid < 0.25, `mid chance ${mid} should be smoothly elevated above base`);
  // Low health (25 HP) ramps higher (~0.305)
  const low = CORE.medDropChance(25, 100);
  assert.ok(low > mid && low < 0.40, `low chance ${low} should exceed mid chance`);
  // Monotonically non-decreasing as health decreases from 100 to 0
  let prev = 0;
  for (let hp = 100; hp >= 0; hp -= 2) {
    const c = CORE.medDropChance(hp, 100);
    assert.ok(c >= prev - 1e-12, `chance dipped at ${hp} HP (${c} < ${prev})`);
    assert.ok(c >= 0 && c <= 1, `chance ${c} out of [0, 1] range`);
    prev = c;
  }
  // Scavenger perk multiplier scales both base and critical chances
  assert.strictEqual(Math.round(CORE.medDropChance(100, 100, 1.6) * 100) / 100, 0.24);
  assert.strictEqual(Math.round(CORE.medDropChance(0, 100, 1.6) * 100) / 100, 0.80);
  // Tolerates invalid/NaN/omitted inputs safely
  assert.strictEqual(CORE.medDropChance(undefined), 0.15);
  assert.strictEqual(CORE.medDropChance(NaN, 100), 0.15);
  assert.strictEqual(CORE.medDropChance('50', 100), 0.15);
});

test('pickupDropKind resolves ammo, medkit, and empty drops deterministically', () => {
  // ammoChance priority: roll < ammoChance gives ammo
  assert.strictEqual(CORE.pickupDropKind(0.10, 0.30, 0.20), 'ammo');
  assert.strictEqual(CORE.pickupDropKind(0.29, 0.30, 0.20), 'ammo');
  // medChance: roll between ammoChance and ammoChance + medChance gives med
  assert.strictEqual(CORE.pickupDropKind(0.30, 0.30, 0.20), 'med');
  assert.strictEqual(CORE.pickupDropKind(0.45, 0.30, 0.20), 'med');
  // roll above total chance drops nothing
  assert.strictEqual(CORE.pickupDropKind(0.50, 0.30, 0.20), null);
  assert.strictEqual(CORE.pickupDropKind(0.95, 0.30, 0.20), null);
  // Complete ammo exhaustion (ammoChance = 1.0) guarantees ammo drop
  assert.strictEqual(CORE.pickupDropKind(0.99, 1.0, 0.50), 'ammo');
  // Degenerate/invalid input handling
  assert.strictEqual(CORE.pickupDropKind(-0.1, 0.30, 0.20), null);
  assert.strictEqual(CORE.pickupDropKind(NaN, 0.30, 0.20), null);
  assert.strictEqual(CORE.pickupDropKind(0.50, NaN, 0.20), null);
  assert.strictEqual(CORE.pickupDropKind(undefined, 0.30, 0.20), null);
});

test('isAmmoLow and isAmmoEmpty detect low and exhausted ammunition states', () => {
  assert.strictEqual(CORE.AMMO_LOW_RATIO, 0.25);
  // 30 round mag: low at <= 7.5 (i.e. <= 7 rounds)
  assert.strictEqual(CORE.isAmmoLow(7, 30), true);
  assert.strictEqual(CORE.isAmmoLow(8, 30), false);
  assert.strictEqual(CORE.isAmmoLow(0, 30), true);
  assert.strictEqual(CORE.isAmmoLow(30, 30), false);
  // 20 round mag (e.g. SCAR-H): low at <= 5 rounds
  assert.strictEqual(CORE.isAmmoLow(5, 20), true);
  assert.strictEqual(CORE.isAmmoLow(6, 20), false);
  // isAmmoEmpty
  assert.strictEqual(CORE.isAmmoEmpty(0), true);
  assert.strictEqual(CORE.isAmmoEmpty(-1), true);
  assert.strictEqual(CORE.isAmmoEmpty(1), false);
  // Tolerates invalid/NaN/omitted inputs safely
  assert.strictEqual(CORE.isAmmoLow(NaN, 30), false);
  assert.strictEqual(CORE.isAmmoLow(5, NaN), false);
  assert.strictEqual(CORE.isAmmoLow(5, 0), false);
  assert.strictEqual(CORE.isAmmoLow(5, -10), false);
  assert.strictEqual(CORE.isAmmoLow('5', 30), false);
  assert.strictEqual(CORE.isAmmoLow(undefined, 30), false);
  assert.strictEqual(CORE.isAmmoEmpty(NaN), false);
  assert.strictEqual(CORE.isAmmoEmpty('0'), false);
  assert.strictEqual(CORE.isAmmoEmpty(undefined), false);
});

test('reloadPrompt generates contextual prompts for desktop, mobile touch, and dry states', () => {
  // Active reloading takes precedence over ammo counts
  assert.strictEqual(CORE.reloadPrompt(true, 0, 60, false), 'RELOADING');
  assert.strictEqual(CORE.reloadPrompt(true, 15, 60, false), 'RELOADING');
  assert.strictEqual(CORE.reloadPrompt(true, 0, 0, false), 'RELOADING');
  assert.strictEqual(CORE.reloadPrompt(true, 0, 60, true), 'RELOADING');

  // Sufficient ammo in magazine requires no prompt
  assert.strictEqual(CORE.reloadPrompt(false, 30, 60, false), '');
  assert.strictEqual(CORE.reloadPrompt(false, 1, 60, false), '');
  assert.strictEqual(CORE.reloadPrompt(false, 5, 0, false), '');

  // Magazine empty with reserve available: desktop gets key hint, touch gets tap prompt
  assert.strictEqual(CORE.reloadPrompt(false, 0, 60, false), 'RELOAD [R]');
  assert.strictEqual(CORE.reloadPrompt(false, 0, 60, true), 'RELOAD');

  // Both magazine and reserve exhausted: pickup prompt
  assert.strictEqual(CORE.reloadPrompt(false, 0, 0, false), 'OUT OF AMMO — FIND PICKUPS');
  assert.strictEqual(CORE.reloadPrompt(false, 0, 0, true), 'OUT OF AMMO — FIND PICKUPS');
  assert.strictEqual(CORE.reloadPrompt(false, 0, -5, false), 'OUT OF AMMO — FIND PICKUPS');

  // Handles invalid/missing inputs gracefully
  assert.strictEqual(CORE.reloadPrompt(false, NaN, 60, false), '');
  assert.strictEqual(CORE.reloadPrompt(false, undefined, 60, false), '');
  assert.strictEqual(CORE.reloadPrompt(false, '0', 60, false), '');
});

test('resolveAabbXZ detects overlap, calculates minimum pushout axis and coordinate, and mutates out without allocations', () => {
  const box = { min: { x: -5, y: 0, z: -10 }, max: { x: 5, y: 2, z: 10 } };
  const r = 0.5;

  // Fully outside bounds on each axis
  assert.strictEqual(CORE.resolveAabbXZ(6.0, 0, r, box), null, 'outside +x');
  assert.strictEqual(CORE.resolveAabbXZ(-6.0, 0, r, box), null, 'outside -x');
  assert.strictEqual(CORE.resolveAabbXZ(0, 11.0, r, box), null, 'outside +z');
  assert.strictEqual(CORE.resolveAabbXZ(0, -11.0, r, box), null, 'outside -z');

  // Exact boundary edge is outside / non-colliding
  assert.strictEqual(CORE.resolveAabbXZ(5.5, 0, r, box), null, 'on +x boundary');
  assert.strictEqual(CORE.resolveAabbXZ(-5.5, 0, r, box), null, 'on -x boundary');

  // Penetrating near +x face: center is at x=0, z=0. Point at x=5.2, z=0.
  // x overlap px = 5 + 0.5 - 5.2 = 0.3. z overlap pz = 10 + 0.5 - 0 = 10.5.
  // px < pz, so push along x to +5.5.
  const hitXPlus = CORE.resolveAabbXZ(5.2, 0, r, box);
  assert.ok(hitXPlus !== null);
  assert.strictEqual(hitXPlus.axis, 'x');
  assert.strictEqual(hitXPlus.val, 5.5);

  // Penetrating near -x face: point at x=-5.2, z=0 -> push to -5.5
  const hitXMinus = CORE.resolveAabbXZ(-5.2, 0, r, box);
  assert.ok(hitXMinus !== null);
  assert.strictEqual(hitXMinus.axis, 'x');
  assert.strictEqual(hitXMinus.val, -5.5);

  // Penetrating near +z face: point at x=0, z=10.2 -> push to +10.5
  const hitZPlus = CORE.resolveAabbXZ(0, 10.2, r, box);
  assert.ok(hitZPlus !== null);
  assert.strictEqual(hitZPlus.axis, 'z');
  assert.strictEqual(hitZPlus.val, 10.5);

  // Penetrating near -z face: point at x=0, z=-10.2 -> push to -10.5
  const hitZMinus = CORE.resolveAabbXZ(0, -10.2, r, box);
  assert.ok(hitZMinus !== null);
  assert.strictEqual(hitZMinus.axis, 'z');
  assert.strictEqual(hitZMinus.val, -10.5);

  // Reusing output descriptor object
  const reusable = { axis: '', val: 0 };
  const res = CORE.resolveAabbXZ(5.1, 0, r, box, reusable);
  assert.strictEqual(res, reusable, 'must return the same object reference');
  assert.strictEqual(reusable.axis, 'x');
  assert.strictEqual(reusable.val, 5.5);

  // Tolerates invalid/missing inputs
  assert.strictEqual(CORE.resolveAabbXZ(0, 0, r, null), null);
  assert.strictEqual(CORE.resolveAabbXZ(0, 0, r, {}), null);
  assert.strictEqual(CORE.resolveAabbXZ(0, 0, -1, box).axis, 'x');
});

test('spatial audio stereo panning reflects angle relative to player orientation', () => {
  assert.strictEqual(CORE.SPATIAL_AUDIO_MAX_DIST, 55);
  assert.strictEqual(CORE.SPATIAL_AUDIO_PAN_BOOST, 1.4);
  assert.strictEqual(CORE.SPATIAL_AUDIO_MIN_VOL, 0.15);

  // Player facing forward (yaw = 0): right is +X, forward is -Z
  // Directly right (dx: 10, dz: 0) -> +1.0 (clamped)
  assert.strictEqual(CORE.spatialAudioPan(10, 0, 0), 1.0);
  // Directly left (dx: -10, dz: 0) -> -1.0 (clamped)
  assert.strictEqual(CORE.spatialAudioPan(-10, 0, 0), -1.0);
  // Directly in front (dx: 0, dz: -10) -> 0.0
  assert.strictEqual(CORE.spatialAudioPan(0, -10, 0), 0);
  // Directly behind (dx: 0, dz: 10) -> 0.0
  assert.strictEqual(CORE.spatialAudioPan(0, 10, 0), 0);

  // Player turned 90 deg right (yaw = -Math.PI / 2): facing +X, right is +Z
  const yawRight = -Math.PI / 2;
  assert.ok(Math.abs(CORE.spatialAudioPan(0, 10, yawRight) - 1.0) < 1e-4);
  assert.ok(Math.abs(CORE.spatialAudioPan(0, -10, yawRight) - (-1.0)) < 1e-4);

  // Degenerate inputs
  assert.strictEqual(CORE.spatialAudioPan(0, 0, 0), 0);
  assert.strictEqual(CORE.spatialAudioPan(10, 0, 'invalid'), 1.0);
});

test('spatial audio distance attenuation scales quadratically to zero at max distance', () => {
  // At zero distance: full volume (1.0)
  assert.strictEqual(CORE.spatialAudioVolume(0, 55, 0.15), 1.0);
  // At max distance: 0 (inaudible)
  assert.strictEqual(CORE.spatialAudioVolume(55, 55, 0.15), 0);
  // Beyond max distance: 0
  assert.strictEqual(CORE.spatialAudioVolume(60, 55, 0.15), 0);
  // Mid distance (27.5 m): 0.15 + 0.85 * 0.25 = 0.3625
  assert.ok(Math.abs(CORE.spatialAudioVolume(27.5, 55, 0.15) - 0.3625) < 1e-4);
  // Default values
  assert.strictEqual(CORE.spatialAudioVolume(0), 1.0);
  assert.strictEqual(CORE.spatialAudioVolume(55), 0);
});

test('spatialAudioParams composes distance, pan, volume and audibility flag', () => {
  // Nearby sound to the right
  const nearRight = CORE.spatialAudioParams(10, 0, 0);
  assert.strictEqual(nearRight.dist, 10);
  assert.strictEqual(nearRight.pan, 1.0);
  assert.strictEqual(nearRight.audible, true);
  assert.ok(nearRight.vol > 0.6 && nearRight.vol < 1.0);

  // Distant sound beyond max distance (60 m > 55 m)
  const distant = CORE.spatialAudioParams(60, 0, 0);
  assert.strictEqual(distant.audible, false);
  assert.strictEqual(distant.vol, 0);
});

test('resolveArmorDamage absorbs damage, protects health, and tracks armor depletion', () => {
  assert.strictEqual(CORE.ARMOR_ABSORB_RATIO, 0.65);

  // Normal absorption with comfortable armor (50 armor, 20 incoming damage)
  // 65% of 20 = 13 absorbed by armor, 7 penetrates to health, 37 armor remaining
  const r1 = CORE.resolveArmorDamage(20, 50);
  assert.strictEqual(r1.absorbed, 13);
  assert.strictEqual(r1.healthDamage, 7);
  assert.strictEqual(r1.remainingArmor, 37);

  // Partial armor depletion when damage exceeds available armor
  // 20 damage at 0.65 wanted 13 armor, but only 8 armor is available
  // absorbed = 8, health takes 20 - 8 = 12, armor is reduced to 0
  const r2 = CORE.resolveArmorDamage(20, 8);
  assert.strictEqual(r2.absorbed, 8);
  assert.strictEqual(r2.healthDamage, 12);
  assert.strictEqual(r2.remainingArmor, 0);

  // Zero armor: full damage passes to health
  const r3 = CORE.resolveArmorDamage(25, 0);
  assert.strictEqual(r3.absorbed, 0);
  assert.strictEqual(r3.healthDamage, 25);
  assert.strictEqual(r3.remainingArmor, 0);

  // Custom absorption ratio override
  const r4 = CORE.resolveArmorDamage(30, 50, 0.80);
  assert.strictEqual(r4.absorbed, 24);
  assert.strictEqual(r4.healthDamage, 6);
  assert.strictEqual(r4.remainingArmor, 26);

  // Degenerate, zero, negative, and invalid inputs
  const zeroDmg = CORE.resolveArmorDamage(0, 50);
  assert.strictEqual(zeroDmg.absorbed, 0);
  assert.strictEqual(zeroDmg.healthDamage, 0);
  assert.strictEqual(zeroDmg.remainingArmor, 50);

  const negDmg = CORE.resolveArmorDamage(-10, 50);
  assert.strictEqual(negDmg.absorbed, 0);
  assert.strictEqual(negDmg.healthDamage, 0);
  assert.strictEqual(negDmg.remainingArmor, 50);

  const nanDmg = CORE.resolveArmorDamage(NaN, 50);
  assert.strictEqual(nanDmg.absorbed, 0);
  assert.strictEqual(nanDmg.healthDamage, 0);
  assert.strictEqual(nanDmg.remainingArmor, 50);

  const nanArmor = CORE.resolveArmorDamage(20, NaN);
  assert.strictEqual(nanArmor.absorbed, 0);
  assert.strictEqual(nanArmor.healthDamage, 20);
  assert.strictEqual(nanArmor.remainingArmor, 0);
});

test('enemyMeleeDamage scales with archetype, wave progression, difficulty, and elite status', () => {
  // Wave 1 standard runner (base 18, diff 1.0, not elite): 18 + 0.4 = 18.4
  const runnerW1 = CORE.enemyMeleeDamage(18, false, 1, 1.0, false);
  assert.ok(Math.abs(runnerW1 - 18.4) < 1e-6);

  // Wave 1 heavy tank (base 18 + 10 tank bonus, diff 1.0): 28 + 0.4 = 28.4
  const tankW1 = CORE.enemyMeleeDamage(18, true, 1, 1.0, false);
  assert.ok(Math.abs(tankW1 - 28.4) < 1e-6);

  // Wave 10 runner with difficulty multiplier 1.25: (18 + 4.0) * 1.25 = 27.5
  const runnerW10 = CORE.enemyMeleeDamage(18, false, 10, 1.25, false);
  assert.ok(Math.abs(runnerW10 - 27.5) < 1e-6);

  // Elite runner at wave 12: (18 + 4.8) * 1.0 * 1.35 = 30.78
  const eliteRunner = CORE.enemyMeleeDamage(18, false, 12, 1.0, true);
  assert.ok(Math.abs(eliteRunner - (22.8 * 1.35)) < 1e-6);

  // Elite tank at wave 12: (18 + 10 + 4.8) * 1.0 * 1.35 = 44.28
  const eliteTank = CORE.enemyMeleeDamage(18, true, 12, 1.0, true);
  assert.ok(Math.abs(eliteTank - (32.8 * 1.35)) < 1e-6);

  // Safe fallbacks for missing/invalid arguments
  const fallback = CORE.enemyMeleeDamage();
  assert.ok(fallback > 0);
});

test('enemyRangedDamage scales with wave progression, difficulty, and elite status', () => {
  // Wave 1 rifleman (base 8, diff 1.0, not elite): 8 + 0.35 = 8.35
  const rifleW1 = CORE.enemyRangedDamage(8, 1, 1.0, false);
  assert.ok(Math.abs(rifleW1 - 8.35) < 1e-6);

  // Wave 10 rifleman with difficulty multiplier 1.3: (8 + 3.5) * 1.3 = 14.95
  const rifleW10 = CORE.enemyRangedDamage(8, 10, 1.3, false);
  assert.ok(Math.abs(rifleW10 - 14.95) < 1e-6);

  // Elite rifleman at wave 12: (8 + 4.2) * 1.0 * 1.35 = 16.47
  const eliteRifle = CORE.enemyRangedDamage(8, 12, 1.0, true);
  assert.ok(Math.abs(eliteRifle - (12.2 * 1.35)) < 1e-6);

  // Safe fallbacks for missing/invalid arguments
  const fallback = CORE.enemyRangedDamage();
  assert.ok(fallback > 0);
});

test('isArmorLow and isArmorEmpty detect low and depleted armor states', () => {
  // Constants check
  assert.strictEqual(CORE.ARMOR_LOW_RATIO, 0.25);

  // Healthy armor (50 max)
  assert.strictEqual(CORE.isArmorLow(50, 50), false);
  assert.strictEqual(CORE.isArmorLow(25, 50), false);
  assert.strictEqual(CORE.isArmorEmpty(50), false);

  // Exactly at the 25% threshold (12.5 / 50)
  assert.strictEqual(CORE.isArmorLow(12.5, 50), true);
  assert.strictEqual(CORE.isArmorEmpty(12.5), false);

  // Below the threshold
  assert.strictEqual(CORE.isArmorLow(10, 50), true);
  assert.strictEqual(CORE.isArmorLow(5, 50), true);
  assert.strictEqual(CORE.isArmorLow(1, 50), true);

  // Just above the threshold
  assert.strictEqual(CORE.isArmorLow(12.6, 50), false);

  // Depleted / zero armor
  assert.strictEqual(CORE.isArmorLow(0, 50), false, 'zero armor is empty, not low');
  assert.strictEqual(CORE.isArmorEmpty(0), true);
  assert.strictEqual(CORE.isArmorEmpty(-5), true);

  // Default max armor (50)
  assert.strictEqual(CORE.isArmorLow(10), true);
  assert.strictEqual(CORE.isArmorLow(30), false);

  // Non-numeric / invalid inputs
  assert.strictEqual(CORE.isArmorLow(NaN, 50), false);
  assert.strictEqual(CORE.isArmorLow(undefined, 50), false);
  assert.strictEqual(CORE.isArmorLow('20', 50), false);
  assert.strictEqual(CORE.isArmorEmpty(NaN), true);
  assert.strictEqual(CORE.isArmorEmpty(undefined), true);
});

test('resolveVerticalBounds, findFloorY, and hasCrouchHeadroom resolve vertical collision queries correctly', () => {
  const colliders = [
    { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 1.5, z: 5 } },
    { min: { x: -5, y: 4.0, z: -5 }, max: { x: 5, y: 5.0, z: 5 } },
    { min: { x: 20, y: 0, z: 20 }, max: { x: 25, y: 2.0, z: 25 } }
  ];

  // Stand-on candidate within step height (feet = 1.0, stepH = 0.6 -> maxStep = 1.6, box top = 1.5)
  // Ceiling overhead (feet = 1.0, ceiling slab bottom = 4.0)
  const out = { floorY: 0, ceilY: 0 };
  const bounds = CORE.resolveVerticalBounds(0, 0, 0.4, colliders, 1.0, 0.6, 0, out);
  assert.strictEqual(bounds, out, 'mutates and returns provided out reference');
  assert.strictEqual(out.floorY, 1.5, 'detects highest stand-on floor');
  assert.strictEqual(out.ceilY, 4.0, 'detects lowest ceiling slab overhead');

  // Obstacle too high to step onto (feet = 0.5, stepH = 0.6 -> maxStep = 1.1 < 1.5)
  const boundsHigh = CORE.resolveVerticalBounds(0, 0, 0.4, colliders, 0.5, 0.6, 0);
  assert.strictEqual(boundsHigh.floorY, 0, 'floor remains at ground when obstacle exceeds step height');
  assert.strictEqual(boundsHigh.ceilY, 4.0, 'ceiling is still detected');

  // Completely outside any collider
  const boundsOut = CORE.resolveVerticalBounds(50, 50, 0.4, colliders, 0, 0.6, -1);
  assert.strictEqual(boundsOut.floorY, -1, 'preserves custom groundY when no colliders overlap');
  assert.strictEqual(boundsOut.ceilY, Infinity, 'ceiling is Infinity when nothing is overhead');

  // Empty / null colliders fallback
  const emptyBounds = CORE.resolveVerticalBounds(0, 0, 0.4, [], 0, 0.6, 0);
  assert.strictEqual(emptyBounds.floorY, 0);
  assert.strictEqual(emptyBounds.ceilY, Infinity);

  // findFloorY fast-path
  const f1 = CORE.findFloorY(0, 0, 0.4, colliders, 1.0, 0.6, 0);
  assert.strictEqual(f1, 1.5);
  const f2 = CORE.findFloorY(0, 0, 0.4, colliders, 0.5, 0.6, 0);
  assert.strictEqual(f2, 0);
  const fOutside = CORE.findFloorY(50, 50, 0.4, colliders, 0, 0.6, 0);
  assert.strictEqual(fOutside, 0);

  // hasCrouchHeadroom
  const lowSlab = [{ min: { x: -2, y: 1.0, z: -2 }, max: { x: 2, y: 2.0, z: 2 } }];
  // Slab overlaps top (1.35 > min 1.0) and bottom (-0.3 < max 2.0) -> blocked
  assert.strictEqual(CORE.hasCrouchHeadroom(0, 0, 0.4, 1.2, 1.7, lowSlab), false);
  // Clear position outside the slab
  assert.strictEqual(CORE.hasCrouchHeadroom(10, 10, 0.4, 1.2, 1.7, lowSlab), true);
  // High slab entirely above head (min 4.0 > top 1.35)
  const highSlab = [{ min: { x: -2, y: 4.0, z: -2 }, max: { x: 2, y: 5.0, z: 2 } }];
  assert.strictEqual(CORE.hasCrouchHeadroom(0, 0, 0.4, 1.2, 1.7, highSlab), true);
});

test('spatialExplosionParams, tacticalDetonationSound, and grenadeContactSound resolve ordnance audio correctly', () => {
  // Constant verification
  assert.strictEqual(CORE.SPATIAL_EXPLOSION_MAX_DIST, 85);

  // Distant explosion at 70m: within 85m range -> audible
  const distant = CORE.spatialExplosionParams(70, 0, 0);
  assert.strictEqual(distant.audible, true);
  assert.ok(distant.vol > 0);
  assert.strictEqual(distant.pan, 1.0, 'explosion to the right pans full right');

  // Explosion beyond 85m range -> not audible
  const outOfRange = CORE.spatialExplosionParams(90, 0, 0);
  assert.strictEqual(outOfRange.audible, false);
  assert.strictEqual(outOfRange.vol, 0);

  // Centered close explosion at (0, 0) -> full volume, centered pan
  const close = CORE.spatialExplosionParams(0, 0, 0);
  assert.strictEqual(close.audible, true);
  assert.strictEqual(close.pan, 0);
  assert.strictEqual(close.vol, 1.0);

  // Explosion to the left
  const left = CORE.spatialExplosionParams(-30, 0, 0);
  assert.strictEqual(left.audible, true);
  assert.strictEqual(left.pan, -1.0);

  // tacticalDetonationSound mappings
  assert.strictEqual(CORE.tacticalDetonationSound('smoke'), 'explosion');
  assert.strictEqual(CORE.tacticalDetonationSound('blind'), 'headshot');
  assert.strictEqual(CORE.tacticalDetonationSound('stun'), 'pin');
  assert.strictEqual(CORE.tacticalDetonationSound(), 'pin');
  assert.strictEqual(CORE.tacticalDetonationSound('unknown'), 'pin');

  // grenadeContactSound mappings
  assert.strictEqual(CORE.grenadeContactSound(true, 0), 'pin', 'sticky grenade contact clicks pin');
  assert.strictEqual(CORE.grenadeContactSound(true, -5), 'pin', 'sticky grenade ignores velocity');
  assert.strictEqual(CORE.grenadeContactSound(false, -2.5), 'bounce', 'high downward velocity plays bounce');
  assert.strictEqual(CORE.grenadeContactSound(false, 1.5), 'bounce', 'high upward bounce velocity plays bounce');
  assert.strictEqual(CORE.grenadeContactSound(false, 0.5), null, 'low velocity rolling produces no bounce sound');
  assert.strictEqual(CORE.grenadeContactSound(false, 0), null);
  assert.strictEqual(CORE.grenadeContactSound(false, NaN), null);
});

test('touchMovementKeys, JOYSTICK_MOVE_THRESHOLD, and touchReloadState resolve mobile touch input and reload feedback', () => {
  // Constant verification
  assert.strictEqual(CORE.JOYSTICK_MOVE_THRESHOLD, 0.15);

  // Discrete movement key resolution
  const forward = CORE.touchMovementKeys(0, 0.5);
  assert.deepStrictEqual(forward, { w: true, s: false, a: false, d: false });

  const backward = CORE.touchMovementKeys(0, -0.5);
  assert.deepStrictEqual(backward, { w: false, s: true, a: false, d: false });

  const right = CORE.touchMovementKeys(0.5, 0);
  assert.deepStrictEqual(right, { w: false, s: false, a: false, d: true });

  const left = CORE.touchMovementKeys(-0.5, 0);
  assert.deepStrictEqual(left, { w: false, s: false, a: true, d: false });

  // Diagonal movement
  const diag = CORE.touchMovementKeys(0.4, -0.4);
  assert.deepStrictEqual(diag, { w: false, s: true, a: false, d: true });

  // Sub-threshold deadzone deflection
  const dead = CORE.touchMovementKeys(0.1, -0.1);
  assert.deepStrictEqual(dead, { w: false, s: false, a: false, d: false });

  // Custom threshold parameter
  const custom = CORE.touchMovementKeys(0.3, 0.3, 0.4);
  assert.deepStrictEqual(custom, { w: false, s: false, a: false, d: false });

  // Reusable output object avoids garbage collection allocation
  const reusableOut = { w: false, s: false, a: false, d: false };
  const res = CORE.touchMovementKeys(0.6, 0.7, 0.15, reusableOut);
  assert.strictEqual(res, reusableOut);
  assert.strictEqual(reusableOut.w, true);
  assert.strictEqual(reusableOut.d, true);

  // Corrupt / non-numeric input handling
  const junk = CORE.touchMovementKeys('bad', NaN);
  assert.deepStrictEqual(junk, { w: false, s: false, a: false, d: false });

  // touchReloadState: urgent when magazine is empty with reserves and not reloading
  assert.strictEqual(CORE.touchReloadState(0, 30, false), 'urgent');
  assert.strictEqual(CORE.touchReloadState(-1, 5, false), 'urgent');

  // Reloading state overrides empty status
  assert.strictEqual(CORE.touchReloadState(0, 30, true), 'reloading');
  assert.strictEqual(CORE.touchReloadState(15, 30, true), 'reloading');

  // Normal / non-urgent states
  assert.strictEqual(CORE.touchReloadState(15, 30, false), '', 'ammo in magazine is not urgent');
  assert.strictEqual(CORE.touchReloadState(1, 30, false), '', 'last round in magazine is not yet urgent');
  assert.strictEqual(CORE.touchReloadState(0, 0, false), '', 'depleted reserve has no ammo to reload');
  assert.strictEqual(CORE.touchReloadState(0, -5, false), '', 'negative reserve has no ammo to reload');
  assert.strictEqual(CORE.touchReloadState(NaN, 30, false), '', 'corrupt ammo returns non-urgent default');
});

test('enemyBaseHealth and enemyMaxHealth scale archetype, wave progression, difficulty, and elite status', () => {
  // Verify scale constants
  assert.strictEqual(CORE.ENEMY_HEALTH_SCALE[0], 1.0, 'runner scale');
  assert.strictEqual(CORE.ENEMY_HEALTH_SCALE[1], 1.35, 'rifleman scale');
  assert.strictEqual(CORE.ENEMY_HEALTH_SCALE[2], 3.2, 'tank scale standardizes 320 HP');
  assert.strictEqual(CORE.ENEMY_HEALTH_SCALE[3], 2.2, 'shielded advancer scale');
  assert.strictEqual(CORE.ENEMY_HEALTH_SCALE[4], 0.55, 'scout scale');
  assert.strictEqual(CORE.ENEMY_HEALTH_SCALE[5], 1.2, 'grenadier scale');

  // Base health resolution
  assert.strictEqual(CORE.enemyBaseHealth(0, 100), 100);
  assert.strictEqual(CORE.enemyBaseHealth(1, 100), 135);
  assert.strictEqual(CORE.enemyBaseHealth(2, 100), 320);
  assert.strictEqual(CORE.enemyBaseHealth(3, 100), 220);
  assert.strictEqual(CORE.enemyBaseHealth(4, 100), 55);
  assert.strictEqual(CORE.enemyBaseHealth(5, 100), 120);
  assert.strictEqual(CORE.enemyBaseHealth(99, 100), 100, 'unrecognized kind falls back to 1.0x');

  // Wave 1 regular difficulty: waveHpMultiplier(1) = 1.0, diffHp = 1.0, not elite
  assert.strictEqual(CORE.enemyMaxHealth(0, 100, 1, 15, 1.0, 1.0, false), 100);
  assert.strictEqual(CORE.enemyMaxHealth(2, 100, 1, 15, 1.0, 1.0, false), 320);

  // Wave 5 scaling: waveHpMultiplier(5) = 1 + 0.06 * 4 = 1.24 -> 100 * 1.24 = 124
  const w5Runner = CORE.enemyMaxHealth(0, 100, 5, 15, 1.0, 1.0, false);
  assert.strictEqual(w5Runner, 124);

  // Veteran difficulty (1.25x HP multiplier)
  const vetTank = CORE.enemyMaxHealth(2, 100, 1, 15, 1.25, 1.0, false);
  assert.strictEqual(vetTank, 400); // 320 * 1.25 = 400

  // Special wave modifier (e.g. Ironclad 1.5x)
  const specialScout = CORE.enemyMaxHealth(4, 100, 1, 15, 1.0, 1.5, false);
  assert.strictEqual(specialScout, Math.round(55 * 1.5)); // 83

  // Elite multiplier (CORE.ELITE.hpMul = 2.2)
  const eliteTank = CORE.enemyMaxHealth(2, 100, 1, 15, 1.0, 1.0, true);
  assert.strictEqual(eliteTank, Math.round(320 * 2.2)); // 704

  // Fallbacks for missing/corrupt values
  assert.ok(CORE.enemyMaxHealth(0) > 0);
  assert.ok(CORE.enemyMaxHealth() > 0);
});

test('enemyAccuracy computes wave-scaled rifleman accuracy and obeys caps and special bonuses', () => {
  // Wave 1 base accuracy: 0.5 + 1 * 0.035 = 0.535
  const w1Acc = CORE.enemyAccuracy(0.5, 0.035, 1, 0.75, 0);
  assert.ok(Math.abs(w1Acc - 0.535) < 1e-6);

  // Wave 5 accuracy: 0.5 + 5 * 0.035 = 0.675
  const w5Acc = CORE.enemyAccuracy(0.5, 0.035, 5, 0.75, 0);
  assert.ok(Math.abs(w5Acc - 0.675) < 1e-6);

  // Wave 10 accuracy: 0.5 + 10 * 0.035 = 0.85 -> capped at 0.75
  const w10Acc = CORE.enemyAccuracy(0.5, 0.035, 10, 0.75, 0);
  assert.strictEqual(w10Acc, 0.75);

  // Special wave accuracy bonus (e.g. Deadeye +0.10) raises cap and accuracy
  const bonusAcc = CORE.enemyAccuracy(0.5, 0.035, 10, 0.75, 0.10);
  assert.strictEqual(bonusAcc, 0.85);

  // Safe defaults and corrupt input handling
  const fallback = CORE.enemyAccuracy();
  assert.ok(fallback >= 0 && fallback <= 1);
});

test('playerBulletDamage computes ballistic damage with headshots, distance falloff, and surface penetration', () => {
  // Point-blank body shot (no falloff, no penetration loss)
  const bodyClose = CORE.playerBulletDamage(26, false, 1.8, 10, 120, 1.0);
  assert.strictEqual(bodyClose, 26);

  // Point-blank headshot: 26 * 1.8 = 46.8
  const headClose = CORE.playerBulletDamage(26, true, 1.8, 10, 120, 1.0);
  assert.ok(Math.abs(headClose - 46.8) < 1e-6);

  // Falloff at max range: minMul = 0.65 -> 26 * 0.65 = 16.9
  const bodyFar = CORE.playerBulletDamage(26, false, 1.8, 120, 120, 1.0);
  assert.ok(Math.abs(bodyFar - 16.9) < 1e-6);

  // Through cover penetration (50% power remaining)
  const bodyPen = CORE.playerBulletDamage(26, false, 1.8, 10, 120, 0.5);
  assert.strictEqual(bodyPen, 13);

  // Safe defaults
  const fallback = CORE.playerBulletDamage();
  assert.ok(fallback > 0);
});

test('shieldMultiplier calculates frontal damage absorption and permits rear or flank hits', () => {
  assert.strictEqual(CORE.SHIELD_ARC_COS, 0.5);
  assert.strictEqual(CORE.SHIELD_ABSORB_RATIO, 0.85);

  // Non-shielded enemies take 100% damage regardless of hit angle
  assert.strictEqual(CORE.shieldMultiplier(0, 0, 0, 0, 0, 5), 1.0);
  assert.strictEqual(CORE.shieldMultiplier(1, 0, 0, 0, 0, 5), 1.0);
  assert.strictEqual(CORE.shieldMultiplier(2, 0, 0, 0, 0, 5), 1.0);

  // Shielded advancer (kind 3) facing +Z (yaw = 0):
  // Facing vector: fx = sin(0) = 0, fz = cos(0) = 1
  // Head-on hit from front (0, 5): dx = 0, dz = 5 -> facing dot = 1.0 > 0.5 -> 0.15
  const frontHit = CORE.shieldMultiplier(3, 0, 0, 0, 0, 5);
  assert.ok(Math.abs(frontHit - 0.15) < 1e-6, 'head-on shot absorbed to 15%');

  // Rear hit from back (0, -5): dx = 0, dz = -5 -> facing dot = -1.0 <= 0.5 -> 1.0
  const rearHit = CORE.shieldMultiplier(3, 0, 0, 0, 0, -5);
  assert.strictEqual(rearHit, 1.0, 'rear shot fully connects');

  // Flank hit from side (5, 0): dx = 5, dz = 0 -> facing dot = 0.0 <= 0.5 -> 1.0
  const flankHit = CORE.shieldMultiplier(3, 0, 0, 0, 5, 0);
  assert.strictEqual(flankHit, 1.0, 'flank shot fully connects');

  // Missing or non-finite parameters safely return 1.0
  assert.strictEqual(CORE.shieldMultiplier(3, 0, 0, 0, undefined, undefined), 1.0);
  assert.strictEqual(CORE.shieldMultiplier(3, NaN, 0, 0, 5, 0), 1.0);
});

test('hitmarkerTier resolves kill, shield block, cover penetration, and standard hit feedback tiers', () => {
  // Lethal kill hits always resolve to 'kill' regardless of shield or cover
  assert.strictEqual(CORE.hitmarkerTier(1.0, false, true), 'kill');
  assert.strictEqual(CORE.hitmarkerTier(0.15, false, true), 'kill');
  assert.strictEqual(CORE.hitmarkerTier(1.0, true, true), 'kill');
  assert.strictEqual(CORE.hitmarkerTier(0.15, true, true), 'kill');

  // Non-lethal hits prioritize shield deflection over cover penetration
  assert.strictEqual(CORE.hitmarkerTier(0.15, false, false), 'block');
  assert.strictEqual(CORE.hitmarkerTier(0.85, false, false), 'block');
  assert.strictEqual(CORE.hitmarkerTier(0.15, true, false), 'block');

  // Through-cover penetration without shield deflection
  assert.strictEqual(CORE.hitmarkerTier(1.0, true, false), 'cover');

  // Standard impact
  assert.strictEqual(CORE.hitmarkerTier(1.0, false, false), 'hit');
  assert.strictEqual(CORE.hitmarkerTier(), 'hit');
});

test('hitmarkerParams returns visual feedback scale, color, duration, and tier parameters', () => {
  assert.strictEqual(CORE.HITMARK_COLOR.kill, '#ff2a1a');
  assert.strictEqual(CORE.HITMARK_COLOR.block, '#6fa8ff');
  assert.strictEqual(CORE.HITMARK_COLOR.cover, '#ffd24a');
  assert.strictEqual(CORE.HITMARK_COLOR.hit, '#ff4a3d');

  // Kill confirmation: high-impact crimson indicator with expanded scale and persistence
  const bodyKill = CORE.hitmarkerParams(false, 'kill');
  assert.strictEqual(bodyKill.tier, 'kill');
  assert.strictEqual(bodyKill.scale, 1.45);
  assert.strictEqual(bodyKill.color, '#ff2a1a');
  assert.strictEqual(bodyKill.duration, 130);

  const headKill = CORE.hitmarkerParams(true, 'kill');
  assert.strictEqual(headKill.tier, 'kill');
  assert.strictEqual(headKill.scale, 1.9);
  assert.strictEqual(headKill.color, '#ff2a1a');
  assert.strictEqual(headKill.duration, 130);

  // Shield block: contracted scale and distinct tactical blue
  const bodyBlock = CORE.hitmarkerParams(false, 'block');
  assert.strictEqual(bodyBlock.tier, 'block');
  assert.strictEqual(bodyBlock.scale, 0.75);
  assert.strictEqual(bodyBlock.color, '#6fa8ff');
  assert.strictEqual(bodyBlock.duration, 80);

  // Surface penetration: amber caution indicator
  const bodyCover = CORE.hitmarkerParams(false, 'cover');
  assert.strictEqual(bodyCover.tier, 'cover');
  assert.strictEqual(bodyCover.scale, 1.0);
  assert.strictEqual(bodyCover.color, '#ffd24a');
  assert.strictEqual(bodyCover.duration, 90);

  const headCover = CORE.hitmarkerParams(true, 'cover');
  assert.strictEqual(headCover.scale, 1.6);
  assert.strictEqual(headCover.color, '#ffd24a');

  // Standard body and headshot hits
  const bodyHit = CORE.hitmarkerParams(false, 'hit');
  assert.strictEqual(bodyHit.tier, 'hit');
  assert.strictEqual(bodyHit.scale, 1.0);
  assert.strictEqual(bodyHit.color, '#ff4a3d');
  assert.strictEqual(bodyHit.duration, 90);

  const headHit = CORE.hitmarkerParams(true, 'hit');
  assert.strictEqual(headHit.tier, 'hit');
  assert.strictEqual(headHit.scale, 1.6);
  assert.strictEqual(headHit.color, '#ff4a3d');
  assert.strictEqual(headHit.duration, 110);

  // Safe defaults
  const fallback = CORE.hitmarkerParams();
  assert.strictEqual(fallback.tier, 'hit');
  assert.strictEqual(fallback.scale, 1.0);
  assert.strictEqual(fallback.color, '#ff4a3d');
});

// ---------------------------------------------------------------- AGENT SEPARATION & PERFORMANCE RULES
test('enemySeparationRadius returns pre-computed radii for agent archetypes', () => {
  assert.strictEqual(CORE.ENEMY_SEPARATION_RADIUS[0], 0.85);
  assert.strictEqual(CORE.ENEMY_SEPARATION_RADIUS[1], 0.85);
  assert.strictEqual(CORE.ENEMY_SEPARATION_RADIUS[2], 1.1);
  assert.strictEqual(CORE.ENEMY_SEPARATION_RADIUS[3], 0.85);
  assert.strictEqual(CORE.ENEMY_SEPARATION_RADIUS[4], 0.85);
  assert.strictEqual(CORE.ENEMY_SEPARATION_RADIUS[5], 0.85);

  assert.strictEqual(CORE.enemySeparationRadius(0), 0.85);
  assert.strictEqual(CORE.enemySeparationRadius(1), 0.85);
  assert.strictEqual(CORE.enemySeparationRadius(2), 1.1);
  assert.strictEqual(CORE.enemySeparationRadius(3), 0.85);
  assert.strictEqual(CORE.enemySeparationRadius(4), 0.85);
  assert.strictEqual(CORE.enemySeparationRadius(5), 0.85);
  assert.strictEqual(CORE.enemySeparationRadius(99), 0.85);
  assert.strictEqual(CORE.enemySeparationRadius(), 0.85);
});

test('resolveSeparationPush computes zero-allocation push displacement with early rejection', () => {
  const out = { pushX: 0, pushZ: 0, applied: false };

  // 1) Fast axis rejection: separated along X
  const rejectedX = CORE.resolveSeparationPush(0, 0, 0.85, 2.0, 0, 0.85, out);
  assert.strictEqual(rejectedX, false);
  assert.strictEqual(out.applied, false);
  assert.strictEqual(out.pushX, 0);

  // 2) Fast axis rejection: separated along Z
  const rejectedZ = CORE.resolveSeparationPush(0, 0, 0.85, 0, 1.8, 0.85, out);
  assert.strictEqual(rejectedZ, false);
  assert.strictEqual(out.applied, false);

  // 3) Diagonal corner rejection (within AABB box but outside circular radius)
  // dx = 1.3, dz = 1.3 => rr = 1.7. dx < rr, dz < rr, but dx^2 + dz^2 = 3.38 > 2.89
  const rejectedDiag = CORE.resolveSeparationPush(0, 0, 0.85, 1.3, 1.3, 0.85, out);
  assert.strictEqual(rejectedDiag, false);
  assert.strictEqual(out.applied, false);

  // 4) Coincident/near-zero guard (distance <= 1e-4) to prevent NaN/Infinity normal
  const coincident = CORE.resolveSeparationPush(5, 5, 0.85, 5, 5, 0.85, out);
  assert.strictEqual(coincident, false);
  assert.strictEqual(out.applied, false);

  // 5) Pure 1D overlap along X: ax=0, bx=1.0, ar=0.85, br=0.85 => rr=1.7, d=1.0
  // push = (1.7 - 1.0) * 0.5 = 0.35. normal = (1, 0)
  const pushed1D = CORE.resolveSeparationPush(0, 0, 0.85, 1.0, 0, 0.85, out);
  assert.strictEqual(pushed1D, true);
  assert.strictEqual(out.applied, true);
  assert.ok(Math.abs(out.pushX - 0.35) < 1e-6);
  assert.strictEqual(out.pushZ, 0);

  // 6) Diagonal 2D overlap: dx=0.6, dz=0.8 => d=1.0. ar=0.85, br=1.1 (tank) => rr=1.95
  // push = (1.95 - 1.0) * 0.5 = 0.475. nx = 0.6, nz = 0.8
  const pushed2D = CORE.resolveSeparationPush(0, 0, 0.85, 0.6, 0.8, 1.1, out);
  assert.strictEqual(pushed2D, true);
  assert.strictEqual(out.applied, true);
  assert.ok(Math.abs(out.pushX - 0.6 * 0.475) < 1e-6);
  assert.ok(Math.abs(out.pushZ - 0.8 * 0.475) < 1e-6);
});

test('pruneHitTimestamps and canRegisterHit enforce sliding window rate limit without allocations', () => {
  assert.strictEqual(CORE.MELEE_CAP_WINDOW, 0.8);
  assert.strictEqual(CORE.MELEE_CAP_MAX_HITS, 2);

  // In-place pruning of expired timestamps
  const hits = [10.0, 10.3, 10.8];
  // At now = 11.0 with 0.8s window: hits >= 10.2 remain (10.3, 10.8)
  const remaining = CORE.pruneHitTimestamps(hits, 11.0, 0.8);
  assert.strictEqual(remaining, 2);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0], 10.3);
  assert.strictEqual(hits[1], 10.8);

  // Pruning when all are expired
  const allExpired = [1.0, 2.0];
  const countZero = CORE.pruneHitTimestamps(allExpired, 10.0, 0.8);
  assert.strictEqual(countZero, 0);
  assert.strictEqual(allExpired.length, 0);

  // Non-array safety
  assert.strictEqual(CORE.pruneHitTimestamps(null, 10.0), 0);

  // canRegisterHit rate gating
  const activeHits = [10.4, 10.7];
  assert.strictEqual(CORE.canRegisterHit(activeHits, 11.0, 0.8, 2), false, '2 active hits reach cap');
  assert.strictEqual(CORE.canRegisterHit([10.7], 11.0, 0.8, 2), true, '1 active hit allows hit');
  assert.strictEqual(CORE.canRegisterHit([], 11.0, 0.8, 2), true, 'empty history allows hit');
});

test('snapToTexel rounds world coordinates to shadow texel increments', () => {
  const texel = 0.037109375; // 76 / 2048
  assert.strictEqual(CORE.snapToTexel(0, texel), 0);
  assert.strictEqual(CORE.snapToTexel(0.037, texel), texel);
  assert.strictEqual(CORE.snapToTexel(0.01, texel), 0);
  assert.strictEqual(CORE.snapToTexel(1.234, 0.05), 1.25);
  assert.strictEqual(CORE.snapToTexel(-1.234, 0.05), -1.25);

  // Non-finite or invalid fallback
  assert.strictEqual(CORE.snapToTexel(NaN, 0.05), 0);
  assert.strictEqual(CORE.snapToTexel(5.5, 0), 5.5);
  assert.strictEqual(CORE.snapToTexel(5.5, -1), 5.5);
});

// ---------------------------------------------------------------- WEAPON FIRE & ARMOR AUDIO RULES
test('weaponFireSound resolves distinct acoustic sound identifiers for weapon classes', () => {
  assert.strictEqual(CORE.weaponFireSound('SR'), 'sniper', 'sniper rifle maps to sniper sound');
  assert.strictEqual(CORE.weaponFireSound('SMG'), 'smg', 'submachine gun maps to smg sound');
  assert.strictEqual(CORE.weaponFireSound('BR'), 'br', 'battle rifle maps to br sound');
  assert.strictEqual(CORE.weaponFireSound('AR'), 'shot', 'assault rifle maps to standard shot sound');

  // Fallbacks and safe defaults
  assert.strictEqual(CORE.weaponFireSound(''), 'shot');
  assert.strictEqual(CORE.weaponFireSound(null), 'shot');
  assert.strictEqual(CORE.weaponFireSound(undefined), 'shot');
  assert.strictEqual(CORE.weaponFireSound('UNKNOWN'), 'shot');
});

test('armorDamageSound resolves acoustic block and shatter feedback states', () => {
  // Armor absorbs damage and persists -> block
  assert.strictEqual(CORE.armorDamageSound(50, 30), 'block', 'active armor absorbs damage');
  assert.strictEqual(CORE.armorDamageSound(10, 0.5), 'block', 'partial armor absorbs damage');

  // Armor completely broken down to 0 -> armor_break
  assert.strictEqual(CORE.armorDamageSound(50, 0), 'armor_break', 'depleted armor triggers break sound');
  assert.strictEqual(CORE.armorDamageSound(15, -5), 'armor_break', 'overkilled armor triggers break sound');

  // No initial armor -> null (flesh hit only)
  assert.strictEqual(CORE.armorDamageSound(0, 0), null, 'unarmored player has no armor sound');
  assert.strictEqual(CORE.armorDamageSound(-10, 0), null, 'negative initial armor yields null');
  assert.strictEqual(CORE.armorDamageSound(null, 0), null, 'non-numeric initial armor yields null');
  assert.strictEqual(CORE.armorDamageSound(undefined, undefined), null, 'undefined yields null');
});

// ---------------------------------------------------------------- TOUCH UTILITY & EQUIPMENT RULES
test('touchPlateState resolves inserting, empty, urgent, and ready feedback states', () => {
  // Inserting active animation / lockout takes precedence
  assert.strictEqual(CORE.touchPlateState(3, 50, 50, true), 'inserting');
  assert.strictEqual(CORE.touchPlateState(0, 0, 50, true), 'inserting');

  // No plates held
  assert.strictEqual(CORE.touchPlateState(0, 50, 50, false), 'empty');
  assert.strictEqual(CORE.touchPlateState(-1, 50, 50, false), 'empty');
  assert.strictEqual(CORE.touchPlateState(null, 50, 50, false), 'empty');
  assert.strictEqual(CORE.touchPlateState(undefined, 50, 50, false), 'empty');
  assert.strictEqual(CORE.touchPlateState(NaN, 50, 50, false), 'empty');

  // Plates held and armor depleted or critically low (<= 25% max) -> urgent
  assert.strictEqual(CORE.touchPlateState(2, 0, 50, false), 'urgent', 'depleted armor triggers urgent plating prompt');
  assert.strictEqual(CORE.touchPlateState(1, 10, 50, false), 'urgent', 'critically low armor triggers urgent plating prompt');
  assert.strictEqual(CORE.touchPlateState(3, 12.5, 50, false), 'urgent', 'exact 25% threshold triggers urgent plating prompt');

  // Plates held and armor damaged (> 25% and < max) -> ready
  assert.strictEqual(CORE.touchPlateState(2, 13, 50, false), 'ready', 'damaged armor allows plating');
  assert.strictEqual(CORE.touchPlateState(1, 45, 50, false), 'ready', 'slightly damaged armor allows plating');

  // Plates held and armor at 100% capacity -> '' (full)
  assert.strictEqual(CORE.touchPlateState(3, 50, 50, false), '', 'full armor requires no plating');
  assert.strictEqual(CORE.touchPlateState(1, 55, 50, false), '', 'over-capped armor requires no plating');
});

test('touchEquipmentState resolves charging, empty, and ready equipment feedback', () => {
  // Charging state while holding throw
  assert.strictEqual(CORE.touchEquipmentState(2, true), 'charging');
  assert.strictEqual(CORE.touchEquipmentState(0, true), 'charging');

  // Empty equipment inventory
  assert.strictEqual(CORE.touchEquipmentState(0, false), 'empty');
  assert.strictEqual(CORE.touchEquipmentState(-1, false), 'empty');
  assert.strictEqual(CORE.touchEquipmentState(null, false), 'empty');
  assert.strictEqual(CORE.touchEquipmentState(undefined, false), 'empty');

  // Ready equipment available
  assert.strictEqual(CORE.touchEquipmentState(1, false), 'ready');
  assert.strictEqual(CORE.touchEquipmentState(2, false), 'ready');
});

test('touchStreakState resolves scorestreak, field upgrade, and empty feedback states', () => {
  // Banked scorestreak takes precedence
  assert.strictEqual(CORE.touchStreakState(true, false), 'streak');
  assert.strictEqual(CORE.touchStreakState(true, true), 'streak');

  // Field upgrade ready when no scorestreak is banked
  assert.strictEqual(CORE.touchStreakState(false, true), 'field');

  // Neither ready
  assert.strictEqual(CORE.touchStreakState(false, false), 'empty');
});

// ---------------------------------------------------------------- ORDNANCE & MELEE BALANCE RULES
test('grenadeBlastDamage computes explosive damage with floor and linear distance falloff', () => {
  // Ground zero (dist = 0): 100% damage (120)
  assert.strictEqual(CORE.grenadeBlastDamage(0, 7, 120, 1.0), 120);

  // Half-distance (dist = 3.5): 0.35 + 0.65 * 0.5 = 0.675 -> 120 * 0.675 = 81
  assert.ok(Math.abs(CORE.grenadeBlastDamage(3.5, 7, 120, 1.0) - 81) < 1e-6);

  // Scaled damage (e.g. thermite scale 0.45): 120 * 1.0 * 0.45 = 54
  assert.ok(Math.abs(CORE.grenadeBlastDamage(0, 7, 120, 0.45) - 54) < 1e-6);

  // Exactly at boundary or beyond -> 0
  assert.strictEqual(CORE.grenadeBlastDamage(7, 7, 120, 1.0), 0);
  assert.strictEqual(CORE.grenadeBlastDamage(10, 7, 120, 1.0), 0);

  // Edge cases and fallbacks
  assert.strictEqual(CORE.grenadeBlastDamage(-1, 7, 120), 0);
  assert.strictEqual(CORE.grenadeBlastDamage(2, 0, 120), 0);
  assert.strictEqual(CORE.grenadeBlastDamage(NaN, 7, 120), 0);
  assert.strictEqual(CORE.grenadeBlastDamage(0, NaN, 120), 0);
});

test('grenadeSelfDamage computes player explosive self-damage within danger radius', () => {
  // Danger radius = 7 * 0.8 = 5.6 m
  // Ground zero (dist = 0): 55 HP self damage
  assert.strictEqual(CORE.grenadeSelfDamage(0, 7, 55), 55);

  // Half danger radius (dist = 2.8): 55 * (1 - 2.8 / 5.6) = 27.5 -> rounded 28
  assert.strictEqual(CORE.grenadeSelfDamage(2.8, 7, 55), 28);

  // Quarter danger radius (dist = 1.4): 55 * (1 - 1.4 / 5.6) = 55 * 0.75 = 41.25 -> rounded 41
  assert.strictEqual(CORE.grenadeSelfDamage(1.4, 7, 55), 41);

  // At or beyond danger radius -> 0
  assert.strictEqual(CORE.grenadeSelfDamage(5.6, 7, 55), 0);
  assert.strictEqual(CORE.grenadeSelfDamage(6.0, 7, 55), 0);

  // Edge cases
  assert.strictEqual(CORE.grenadeSelfDamage(-1, 7, 55), 0);
  assert.strictEqual(CORE.grenadeSelfDamage(1, 0, 55), 0);
  assert.strictEqual(CORE.grenadeSelfDamage(NaN, 7, 55), 0);
});

test('grenadeChargedSpeed and grenadeThrowSpeed resolve lob velocities and tap thresholds', () => {
  // Ramp duration 1.0s, min speed 6.0 m/s, max speed 13.0 m/s
  assert.strictEqual(CORE.grenadeChargedSpeed(0), 6.0);
  assert.strictEqual(CORE.grenadeChargedSpeed(0.5), 9.5);
  assert.strictEqual(CORE.grenadeChargedSpeed(1.0), 13.0);
  assert.strictEqual(CORE.grenadeChargedSpeed(2.5), 13.0, 'overshooting ramp clamps to max speed');
  assert.strictEqual(CORE.grenadeChargedSpeed(-0.5), 6.0, 'negative charge clamps to min speed');

  // Tap vs hold throw speed (tap threshold 0.22s)
  assert.strictEqual(CORE.grenadeThrowSpeed(0.1, 9.5), 9.5, 'tap throw uses configured default speed');
  assert.strictEqual(CORE.grenadeThrowSpeed(0.22, 9.5), 9.5, 'tap threshold boundary uses default speed');
  assert.strictEqual(CORE.grenadeThrowSpeed(0.5, 9.5), 9.5, 'charged throw at 0.5s resolves charged speed');
  assert.strictEqual(CORE.grenadeThrowSpeed(1.0, 9.5), 13.0, 'charged throw at 1.0s reaches max speed');
});

test('canEnemyMelee, enemyMeleeReach, and enemyAttackCooldown configure archetype melee attributes', () => {
  // Archetypes that can melee: 0 (runner), 2 (tank), 3 (shielded), 4 (scout)
  assert.strictEqual(CORE.canEnemyMelee(0), true, 'runner can melee');
  assert.strictEqual(CORE.canEnemyMelee(2), true, 'tank can melee');
  assert.strictEqual(CORE.canEnemyMelee(3), true, 'shielded can melee');
  assert.strictEqual(CORE.canEnemyMelee(4), true, 'scout can melee');
  assert.strictEqual(CORE.canEnemyMelee(1), false, 'rifleman does not melee');
  assert.strictEqual(CORE.canEnemyMelee(5), false, 'grenadier does not melee');

  // Melee reach: Tank has +0.9m reach, others have +0.4m
  assert.strictEqual(CORE.enemyMeleeReach(2, 2.1), 3.0, 'tank melee reach is extended');
  assert.strictEqual(CORE.enemyMeleeReach(0, 2.1), 2.5, 'standard melee reach');
  assert.strictEqual(CORE.enemyMeleeReach(3, 2.1), 2.5);

  // Melee attack cooldown: Tank has 2.4s recovery, others have 1.6s
  assert.strictEqual(CORE.enemyAttackCooldown(2), 2.4, 'tank has longer melee recovery');
  assert.strictEqual(CORE.enemyAttackCooldown(0), 1.6, 'standard melee recovery');
  assert.strictEqual(CORE.enemyAttackCooldown(4), 1.6);
});

// ---------------------------------------------------------------- DIRECTIONAL DAMAGE & VIGNETTE FEEDBACK RULES
test('damageVignetteAlpha calculates clamped damage vignette pulse intensity', () => {
  // Amount 0 or negative -> 0
  assert.strictEqual(CORE.damageVignetteAlpha(0), 0);
  assert.strictEqual(CORE.damageVignetteAlpha(-10), 0);
  assert.strictEqual(CORE.damageVignetteAlpha(NaN), 0);
  assert.strictEqual(CORE.damageVignetteAlpha(null), 0);

  // Nominal scaling: 0.25 + amount / 30
  // Amount = 15 -> 0.25 + 0.5 = 0.75
  assert.ok(Math.abs(CORE.damageVignetteAlpha(15) - 0.75) < 1e-6);
  // Amount = 7.5 -> 0.25 + 0.25 = 0.50
  assert.ok(Math.abs(CORE.damageVignetteAlpha(7.5) - 0.50) < 1e-6);

  // Large damage caps at maxAlpha (0.85)
  assert.strictEqual(CORE.damageVignetteAlpha(60), 0.85);
  assert.strictEqual(CORE.damageVignetteAlpha(120), 0.85);
});

test('damageVignetteStyle produces box-shadow styling with flesh and armor differentiation', () => {
  // 0 or negative alpha produces invisible vignette
  assert.strictEqual(CORE.damageVignetteStyle(0, false), 'inset 0 0 120px 40px rgba(180,0,0,0)');
  assert.strictEqual(CORE.damageVignetteStyle(-1, true), 'inset 0 0 120px 40px rgba(180,0,0,0)');
  assert.strictEqual(CORE.damageVignetteStyle(NaN, false), 'inset 0 0 120px 40px rgba(180,0,0,0)');

  // Flesh hit produces crimson blood vignette
  assert.strictEqual(CORE.damageVignetteStyle(0.75, false), 'inset 0 0 120px 40px rgba(180,0,0,0.750)');

  // Armor absorption produces tactical blue/cyan vignette
  assert.strictEqual(CORE.damageVignetteStyle(0.75, true), 'inset 0 0 120px 40px rgba(79,163,216,0.750)');
});

test('worldBearing computes compass bearing from source to target coordinates', () => {
  // (0,0) to south (0, 10): 0 deg
  assert.strictEqual(CORE.worldBearing(0, 0, 0, 10), 0);
  // (0,0) to east (10, 0): 90 deg
  assert.strictEqual(CORE.worldBearing(0, 0, 10, 0), 90);
  // (0,0) to north (0, -10): 180 deg
  assert.strictEqual(CORE.worldBearing(0, 0, 0, -10), 180);
  // (0,0) to west (-10, 0): 270 deg
  assert.strictEqual(CORE.worldBearing(0, 0, -10, 0), 270);

  // Coincident points or non-finite inputs return 0
  assert.strictEqual(CORE.worldBearing(5, 5, 5, 5), 0);
  assert.strictEqual(CORE.worldBearing(NaN, 0, 10, 0), 0);
});

test('screenHitAngle maps world bearing and player yaw to on-screen indicator rotation', () => {
  // Player yaw 0 (facing north, -Z)
  // Attacker at north (world bearing 180) -> straight ahead (0 deg)
  assert.strictEqual(CORE.screenHitAngle(180, 0), 0);
  // Attacker at east (world bearing 90) -> right (90 deg)
  assert.strictEqual(CORE.screenHitAngle(90, 0), 90);
  // Attacker at south (world bearing 0) -> behind (180 deg)
  assert.strictEqual(CORE.screenHitAngle(0, 0), 180);
  // Attacker at west (world bearing 270) -> left (270 deg)
  assert.strictEqual(CORE.screenHitAngle(270, 0), 270);

  // Player yaw PI/2 (facing west, -X)
  // Attacker at west (world bearing 270) -> straight ahead (0 deg)
  assert.strictEqual(CORE.screenHitAngle(270, Math.PI / 2), 0);

  // Non-finite fallbacks
  assert.strictEqual(CORE.screenHitAngle(NaN, 0), 0);
  assert.strictEqual(CORE.screenHitAngle(0, NaN), 0);
});

test('hitArcOpacity computes linear fade curve for directional hit indicators', () => {
  // At creation (age 0), full opacity (0.9)
  assert.strictEqual(CORE.hitArcOpacity(0), 0.9);
  // Within fade start window (age <= 0.7 * 0.6 = 0.42), still full opacity
  assert.strictEqual(CORE.hitArcOpacity(0.2), 0.9);
  assert.strictEqual(CORE.hitArcOpacity(0.42), 0.9);

  // Mid-fade (age 0.56): 0.9 * (1 - 0.14 / 0.28) = 0.45
  assert.ok(Math.abs(CORE.hitArcOpacity(0.56) - 0.45) < 1e-6);

  // Expired at or past lifetime (0.7s) -> 0
  assert.strictEqual(CORE.hitArcOpacity(0.7), 0);
  assert.strictEqual(CORE.hitArcOpacity(1.0), 0);

  // Negative age or invalid -> 0
  assert.strictEqual(CORE.hitArcOpacity(-0.1), 0);
  assert.strictEqual(CORE.hitArcOpacity(NaN), 0);
});

test('stepParticlePhysics integrates ballistic motion and clamps to ground with zero allocations', () => {
  const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };

  // Free flight step in mid-air: y = 1.0, vy = 2.0, grav = 9.8, dt = 0.1
  // nvy = 2.0 - 0.98 = 1.02, ny = 1.0 + 1.02 * 0.1 = 1.102
  const step1 = CORE.stepParticlePhysics(0, 1.0, 0, 1.0, 2.0, 0, 9.8, 0.1, 0.02, out);
  assert.strictEqual(step1, out, 'must mutate and return the passed out object');
  assert.ok(Math.abs(out.x - 0.1) < 1e-6);
  assert.ok(Math.abs(out.y - 1.102) < 1e-6);
  assert.ok(Math.abs(out.vy - 1.02) < 1e-6);
  assert.strictEqual(out.grounded, false);

  // Landing step: particle descending below floor (y = 0.03, vy = -2.0, dt = 0.1 -> ny < 0.02)
  CORE.stepParticlePhysics(out.x, 0.03, 0, 1.0, -2.0, 0, 9.8, 0.1, 0.02, out);
  assert.strictEqual(out.y, 0.02, 'must clamp to ground level 0.02');
  assert.strictEqual(out.vx, 0, 'landing must zero horizontal velocity');
  assert.strictEqual(out.vy, 0, 'landing must zero vertical velocity');
  assert.strictEqual(out.vz, 0);
  assert.strictEqual(out.grounded, true);

  // Default parameters and allocation when out is omitted
  const fresh = CORE.stepParticlePhysics(5, 2, 5, 0, 0, 0, 9.8, 0.05);
  assert.ok(fresh.y < 2.0);
  assert.strictEqual(fresh.grounded, false);
});

test('ammoHudChanged and syncAmmoHudState track HUD state and eliminate redundant DOM updates', () => {
  const cache = {
    ammo: 30, reserve: 90, reloading: false, isLow: false, isEmpty: false,
    prompt: '', weaponName: 'M4A1', lethalCount: 2, tacCount: 1, isCharging: false
  };

  // Identical state reports no change
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, false, false, '', 'M4A1', 2, 1, false), false);

  // Any state modification triggers change detection
  assert.strictEqual(CORE.ammoHudChanged(cache, 29, 90, false, false, false, '', 'M4A1', 2, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 60, false, false, false, '', 'M4A1', 2, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, true, false, false, '', 'M4A1', 2, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, true, false, '', 'M4A1', 2, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, false, true, '', 'M4A1', 2, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, false, false, 'RELOAD [R]', 'M4A1', 2, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, false, false, '', 'MP5', 2, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, false, false, '', 'M4A1', 1, 1, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, false, false, '', 'M4A1', 2, 0, false), true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 30, 90, false, false, false, '', 'M4A1', 2, 1, true), true);

  // Missing cache always reports change
  assert.strictEqual(CORE.ammoHudChanged(null, 30, 90, false, false, false, '', 'M4A1', 2, 1, false), true);

  // syncAmmoHudState synchronizes the cache object
  const synced = CORE.syncAmmoHudState(cache, 25, 80, true, false, false, 'RELOADING', 'MP5', 1, 0, true);
  assert.strictEqual(synced, cache);
  assert.strictEqual(cache.ammo, 25);
  assert.strictEqual(cache.reserve, 80);
  assert.strictEqual(cache.reloading, true);
  assert.strictEqual(cache.prompt, 'RELOADING');
  assert.strictEqual(cache.weaponName, 'MP5');
  assert.strictEqual(cache.lethalCount, 1);
  assert.strictEqual(cache.tacCount, 0);
  assert.strictEqual(cache.isCharging, true);
  assert.strictEqual(CORE.ammoHudChanged(cache, 25, 80, true, false, false, 'RELOADING', 'MP5', 1, 0, true), false);
});

test('meleeTarget directly supports game entity agents with .pos coordinates', () => {
  const agents = [
    { pos: { x: 0, z: 1.5 }, dead: false },
    { pos: { x: 3.0, z: 0 }, dead: false },
    { pos: { x: 0, z: 1.0 }, dead: true }
  ];

  // Facing forward (+z): agent 0 is within reach (1.5m <= 2.2m) and inside cone; agent 2 is dead
  const idx = CORE.meleeTarget(agents, 0, 0, 0, 1, CORE.MELEE_REACH, CORE.MELEE_CONE);
  assert.strictEqual(idx, 0, 'should select alive agent directly via .pos without intermediate allocations');

  // Facing right (+x): agent 1 is outside reach (3.0m > 2.2m)
  const idxRight = CORE.meleeTarget(agents, 0, 0, 1, 0, CORE.MELEE_REACH, CORE.MELEE_CONE);
  assert.strictEqual(idxRight, -1);
});

test('killConfirmationSound differentiates standard, headshot, and elite kills', () => {
  // Standard body kill on non-elite
  assert.strictEqual(CORE.killConfirmationSound(false, false), 'kill');
  assert.strictEqual(CORE.killConfirmationSound(0, false), 'kill');

  // Precision headshot kill on non-elite
  assert.strictEqual(CORE.killConfirmationSound(true, false), 'kill_headshot');
  assert.strictEqual(CORE.killConfirmationSound(1, false), 'kill_headshot');

  // Elite kill prioritizes authoritative elite audio
  assert.strictEqual(CORE.killConfirmationSound(false, true), 'kill_elite');
  assert.strictEqual(CORE.killConfirmationSound(true, true), 'kill_elite');

  // Fallbacks on missing or invalid inputs
  assert.strictEqual(CORE.killConfirmationSound(), 'kill');
  assert.strictEqual(CORE.killConfirmationSound(null, undefined), 'kill');
});

test('advanceKillStreak, multikillLabel, and multikillSound manage multikill milestones and audio', () => {
  // Window constant
  assert.strictEqual(CORE.MK_WINDOW, 4);
  assert.strictEqual(CORE.MK_MAX_STREAK, 5);

  // Initial kill from cold start
  assert.strictEqual(CORE.advanceKillStreak(0, -99, 10, 4), 1);
  assert.strictEqual(CORE.multikillLabel(1), null);
  assert.strictEqual(CORE.multikillSound(1), null);

  // Chained kills within 4-second window
  assert.strictEqual(CORE.advanceKillStreak(1, 10, 12, 4), 2);
  assert.strictEqual(CORE.multikillLabel(2), 'DOUBLE KILL');
  assert.strictEqual(CORE.multikillSound(2), 'multikill');

  assert.strictEqual(CORE.advanceKillStreak(2, 12, 14.5, 4), 3);
  assert.strictEqual(CORE.multikillLabel(3), 'TRIPLE KILL');
  assert.strictEqual(CORE.multikillSound(3), 'multikill');

  assert.strictEqual(CORE.advanceKillStreak(3, 14.5, 17, 4), 4);
  assert.strictEqual(CORE.multikillLabel(4), 'QUAD KILL');
  assert.strictEqual(CORE.multikillSound(4), 'multikill');

  assert.strictEqual(CORE.advanceKillStreak(4, 17, 20.9, 4), 5);
  assert.strictEqual(CORE.multikillLabel(5), 'RAMPAGE');
  assert.strictEqual(CORE.multikillSound(5), 'multikill');

  // Hitting cap resets streak to 0 so next kill restarts cycle cleanly
  assert.strictEqual(CORE.advanceKillStreak(5, 20.9, 22, 4), 0);
  assert.strictEqual(CORE.multikillLabel(0), null);
  assert.strictEqual(CORE.multikillSound(0), null);

  // Next kill starts fresh streak at 1
  assert.strictEqual(CORE.advanceKillStreak(0, 22, 23, 4), 1);

  // Kill beyond window duration resets to 1
  assert.strictEqual(CORE.advanceKillStreak(3, 10, 15, 4), 1, 'kill after 5s must reset to 1');
  assert.strictEqual(CORE.advanceKillStreak(4, 10, 14.01, 4), 1);

  // Exact boundary edge
  assert.strictEqual(CORE.advanceKillStreak(1, 10, 14.0, 4), 2, 'exact window boundary must count as streak');

  // Input sanitization
  assert.strictEqual(CORE.advanceKillStreak(null, undefined, 5), 1);
  assert.strictEqual(CORE.multikillLabel(6), null);
  assert.strictEqual(CORE.multikillLabel(-1), null);
  assert.strictEqual(CORE.multikillSound(6), null);
});

test('touchSwapState and touchSwapLabel resolve weapon switch feedback and reserve archetype indicator', () => {
  const mockWeapons = [
    { name: 'M4 Carbine', type: 'AR' },
    { name: 'MK18 Mod1', type: 'SMG' },
    { name: 'SCAR-H', type: 'BR' },
    { name: 'SV-98 Marksman', type: 'SR' }
  ];

  // Single weapon owned (secondary slot empty)
  assert.strictEqual(CORE.touchSwapState(0, [0, -1]), 'empty');
  assert.strictEqual(CORE.touchSwapLabel(0, [0, -1], mockWeapons), 'SWAP');

  // Both weapons owned, holding slot 0 (swapping would give weapon in slot 1)
  assert.strictEqual(CORE.touchSwapState(0, [0, 3]), 'ready');
  assert.strictEqual(CORE.touchSwapLabel(0, [0, 3], mockWeapons), 'SR');

  // Both weapons owned, holding slot 1 (swapping would give weapon in slot 0)
  assert.strictEqual(CORE.touchSwapState(1, [0, 3]), 'ready');
  assert.strictEqual(CORE.touchSwapLabel(1, [0, 3], mockWeapons), 'AR');

  // Swap to SMG
  assert.strictEqual(CORE.touchSwapState(0, [2, 1]), 'ready');
  assert.strictEqual(CORE.touchSwapLabel(0, [2, 1], mockWeapons), 'SMG');

  // Defensive handling of null/undefined/malformed structures
  assert.strictEqual(CORE.touchSwapState(0, null), 'empty');
  assert.strictEqual(CORE.touchSwapState(0, []), 'empty');
  assert.strictEqual(CORE.touchSwapState(0, [0]), 'empty');
  assert.strictEqual(CORE.touchSwapState(1, [-1, 2]), 'empty');
  assert.strictEqual(CORE.touchSwapLabel(0, null, mockWeapons), 'SWAP');
  assert.strictEqual(CORE.touchSwapLabel(0, [0, 99], mockWeapons), 'SWAP');
});

test('buyPromptPrefix and touchUseState provide platform-accurate station prompts and interaction states', () => {
  // buyPromptPrefix generates mobile touch vs desktop keyboard action text
  assert.strictEqual(CORE.buyPromptPrefix(true, true), 'HOLD USE — ');
  assert.strictEqual(CORE.buyPromptPrefix(false, true), 'HOLD F — ');
  assert.strictEqual(CORE.buyPromptPrefix(true, false), '');
  assert.strictEqual(CORE.buyPromptPrefix(false, false), '');

  // touchUseState resolves feedback states
  // Out of range: empty
  assert.strictEqual(CORE.touchUseState(false, true, false), 'empty');
  assert.strictEqual(CORE.touchUseState(false, false, false), 'empty');

  // In range and affordable: ready
  assert.strictEqual(CORE.touchUseState(true, true, false), 'ready');

  // In range and holding interaction: holding
  assert.strictEqual(CORE.touchUseState(true, true, true), 'holding');

  // In range but unaffordable / blocked: blocked
  assert.strictEqual(CORE.touchUseState(true, false, false), 'blocked');
});

test('touchSlideState and touchSlideLabel reflect stance, kinetic slide, and sprint momentum', () => {
  // Active slide takes top precedence
  assert.strictEqual(CORE.touchSlideState(true, false, false), 'sliding');
  assert.strictEqual(CORE.touchSlideState(true, true, true), 'sliding');
  assert.strictEqual(CORE.touchSlideLabel(true, false), 'SLIDE');

  // Crouch stance
  assert.strictEqual(CORE.touchSlideState(false, true, false), 'crouch');
  assert.strictEqual(CORE.touchSlideLabel(false, true), 'STAND');

  // Sprint momentum ready to slide
  assert.strictEqual(CORE.touchSlideState(false, false, true), 'sprint');
  assert.strictEqual(CORE.touchSlideLabel(false, false), 'SLIDE');

  // Idle / normal walk
  assert.strictEqual(CORE.touchSlideState(false, false, false), '');
  assert.strictEqual(CORE.touchSlideLabel(false, false), 'SLIDE');
});

test('slideSpeedAt and slideJumpBoost govern kinetic slide momentum and jump transfer', () => {
  const sprintSpd = 5.4 * 1.5; // 8.1 m/s
  const crouchSpd = 5.4 * 0.5; // 2.7 m/s

  // At start of slide (t = 0): 1.2x sprint speed = 9.72 m/s
  const startSpeed = CORE.slideSpeedAt(0, sprintSpd, crouchSpd, 0.9, 1.2, 0.5);
  assert.ok(Math.abs(startSpeed - 9.72) < 1e-4);

  // At end of slide (t = 0.9): crouch speed = 2.7 m/s
  const endSpeed = CORE.slideSpeedAt(0.9, sprintSpd, crouchSpd, 0.9, 1.2, 0.5);
  assert.ok(Math.abs(endSpeed - 2.7) < 1e-4);

  // Halfway through slide (t = 0.45): exact midpoint = 6.21 m/s
  const midSpeed = CORE.slideSpeedAt(0.45, sprintSpd, crouchSpd, 0.9, 1.2, 0.5);
  assert.ok(Math.abs(midSpeed - 6.21) < 1e-4);

  // Clamping outside bounds
  assert.ok(Math.abs(CORE.slideSpeedAt(-0.5, sprintSpd, crouchSpd, 0.9, 1.2, 0.5) - 9.72) < 1e-4);
  assert.ok(Math.abs(CORE.slideSpeedAt(2.0, sprintSpd, crouchSpd, 0.9, 1.2, 0.5) - 2.7) < 1e-4);

  // Jump boost transfer
  assert.strictEqual(CORE.slideJumpBoost(0, sprintSpd, 1.35, 0.3), 1.0);
  const sprintBoost = CORE.slideJumpBoost(sprintSpd, sprintSpd, 1.35, 0.3);
  assert.ok(Math.abs(sprintBoost - 1.30) < 1e-4);

  // Max boost clamping
  const cappedBoost = CORE.slideJumpBoost(sprintSpd * 2, sprintSpd, 1.35, 0.3);
  assert.strictEqual(cappedBoost, 1.35);
});

test('stepPlayerStamina and isPlayerExhausted govern stamina depletion, recovery, and exhaustion gates', () => {
  const maxStamina = 5.0;

  // Base sprint drain (1.0/s)
  const drained = CORE.stepPlayerStamina(5.0, maxStamina, true, false, 1.0, 1.0, 2.2, 0.7);
  assert.ok(Math.abs(drained - 4.0) < 1e-4);

  // Tactical sprint drain (2.2/s)
  const tacDrained = CORE.stepPlayerStamina(5.0, maxStamina, true, true, 1.0, 1.0, 2.2, 0.7);
  assert.ok(Math.abs(tacDrained - 2.8) < 1e-4);

  // Drain clamping to 0
  const empty = CORE.stepPlayerStamina(1.0, maxStamina, true, true, 2.0, 1.0, 2.2, 0.7);
  assert.strictEqual(empty, 0);

  // Recovery (0.7/s)
  const recovered = CORE.stepPlayerStamina(0, maxStamina, false, false, 2.0, 1.0, 2.2, 0.7);
  assert.ok(Math.abs(recovered - 1.4) < 1e-4);

  // Recovery clamping to maxStamina
  const full = CORE.stepPlayerStamina(4.8, maxStamina, false, false, 1.0, 1.0, 2.2, 0.7);
  assert.strictEqual(full, 5.0);

  // Exhaustion state gates
  // Zero stamina triggers exhaustion
  assert.strictEqual(CORE.isPlayerExhausted(0, false, maxStamina, 0.35), true);

  // Stays exhausted until recovering past 35% threshold (1.75)
  assert.strictEqual(CORE.isPlayerExhausted(1.5, true, maxStamina, 0.35), true);
  assert.strictEqual(CORE.isPlayerExhausted(1.75, true, maxStamina, 0.35), true);
  assert.strictEqual(CORE.isPlayerExhausted(1.8, true, maxStamina, 0.35), false);

  // Non-exhausted player is not exhausted while stamina remains positive
  assert.strictEqual(CORE.isPlayerExhausted(1.0, false, maxStamina, 0.35), false);
});

test('canRegenHealth and stepHealthRegen govern natural combat recovery', () => {
  const maxHp = 100;
  const regenDelay = 4.0;

  // Downed player cannot regenerate
  assert.strictEqual(CORE.canRegenHealth(true, 5.0, regenDelay, 50, maxHp), false);

  // Damage delay lockout
  assert.strictEqual(CORE.canRegenHealth(false, 3.5, regenDelay, 50, maxHp), false);

  // Full health needs no regeneration
  assert.strictEqual(CORE.canRegenHealth(false, 5.0, regenDelay, 100, maxHp), false);

  // Bleeding out / dead cannot regenerate
  assert.strictEqual(CORE.canRegenHealth(false, 5.0, regenDelay, 0, maxHp), false);

  // Valid regen conditions
  assert.strictEqual(CORE.canRegenHealth(false, 5.0, regenDelay, 60, maxHp), true);

  // Step health regen calculation
  const healed = CORE.stepHealthRegen(60, maxHp, 20, 1.0, 0.5);
  assert.ok(Math.abs(healed - 70) < 1e-4);

  // Step health regen with difficulty multiplier
  const hardHealed = CORE.stepHealthRegen(60, maxHp, 20, 0.8, 0.5);
  assert.ok(Math.abs(hardHealed - 68) < 1e-4);

  // Clamped at maxHealth
  const cappedHeal = CORE.stepHealthRegen(95, maxHp, 20, 1.0, 1.0);
  assert.strictEqual(cappedHeal, 100);
});

test('ammoPickupRestore and medkitPickupRestore calculate resource replenishment and perk scaling', () => {
  // Ammo pickup: 1.5x mag size (30 * 1.5 = 45 rounds)
  const ammoRes = CORE.ammoPickupRestore(30, 120, 30, 1.0);
  assert.strictEqual(ammoRes, 75);

  // Ammo pickup with Scavenger perk (1.6x -> 72 rounds)
  const scavAmmo = CORE.ammoPickupRestore(30, 120, 30, 1.6);
  assert.strictEqual(scavAmmo, 102);

  // Ammo pickup reserve cap
  const cappedAmmo = CORE.ammoPickupRestore(100, 120, 30, 1.6);
  assert.strictEqual(cappedAmmo, 120);

  // Medkit pickup: base 35 HP + 15 Armor
  const medkitRes = CORE.medkitPickupRestore(50, 100, 10, 50, 1.0);
  assert.strictEqual(medkitRes.health, 85);
  assert.strictEqual(medkitRes.armor, 25);

  // Medkit pickup with Scavenger perk (35 * 1.6 = 56 HP, 15 * 1.6 = 24 Armor)
  const scavMedkit = CORE.medkitPickupRestore(50, 100, 10, 50, 1.6);
  assert.strictEqual(scavMedkit.health, 100); // capped from 106
  assert.strictEqual(scavMedkit.armor, 34);

  // Medkit pickup clamping at full health/armor
  const fullMedkit = CORE.medkitPickupRestore(95, 100, 45, 50, 1.0);
  assert.strictEqual(fullMedkit.health, 100);
  assert.strictEqual(fullMedkit.armor, 50);
});

test('isHealthCritical, criticalHealthIntensity, and healthDangerState govern near-death danger alert thresholds', () => {
  const maxHp = 100;

  // Full health
  assert.strictEqual(CORE.isHealthCritical(100, maxHp), false);
  assert.strictEqual(CORE.criticalHealthIntensity(100, maxHp), 0);
  assert.strictEqual(CORE.healthDangerState(100, maxHp), 'nominal');

  // Low health (28 HP) is low (<= 30%) but not critical (> 25%)
  assert.strictEqual(CORE.isHealthLow(28, maxHp), true);
  assert.strictEqual(CORE.isHealthCritical(28, maxHp), false);
  assert.strictEqual(CORE.criticalHealthIntensity(28, maxHp), 0);
  assert.strictEqual(CORE.healthDangerState(28, maxHp), 'low');

  // Critical boundary (25 HP)
  assert.strictEqual(CORE.isHealthCritical(25, maxHp), true);
  assert.strictEqual(CORE.criticalHealthIntensity(25, maxHp), 0);
  assert.strictEqual(CORE.healthDangerState(25, maxHp), 'critical');

  // Mid-critical health (12.5 HP) -> 50% danger intensity
  assert.strictEqual(CORE.isHealthCritical(12.5, maxHp), true);
  assert.ok(Math.abs(CORE.criticalHealthIntensity(12.5, maxHp) - 0.5) < 1e-4);
  assert.strictEqual(CORE.healthDangerState(12.5, maxHp), 'critical');

  // Near death (2.5 HP) -> 90% danger intensity
  assert.strictEqual(CORE.isHealthCritical(2.5, maxHp), true);
  assert.ok(Math.abs(CORE.criticalHealthIntensity(2.5, maxHp) - 0.9) < 1e-4);
  assert.strictEqual(CORE.healthDangerState(2.5, maxHp), 'critical');

  // Custom maxHealth (e.g. Juggernaut 150 HP, threshold 37.5 HP)
  assert.strictEqual(CORE.isHealthCritical(35, 150), true);
  assert.strictEqual(CORE.isHealthCritical(40, 150), false);

  // Dead, downed, or invalid inputs
  assert.strictEqual(CORE.isHealthCritical(0, maxHp), false);
  assert.strictEqual(CORE.isHealthCritical(-10, maxHp), false);
  assert.strictEqual(CORE.isHealthCritical(null, maxHp), false);
  assert.strictEqual(CORE.isHealthCritical(undefined, maxHp), false);
  assert.strictEqual(CORE.criticalHealthIntensity(0, maxHp), 0);
  assert.strictEqual(CORE.criticalHealthIntensity(-5, maxHp), 0);
  assert.strictEqual(CORE.healthDangerState(0, maxHp), 'dead');
  assert.strictEqual(CORE.healthDangerState(-10, maxHp), 'dead');
});

test('criticalVignetteStyle and criticalPulseAlpha compute near-death feedback dynamics and reduced-motion fallbacks', () => {
  // Zero intensity returns inert transparent box-shadow
  assert.strictEqual(CORE.criticalVignetteStyle(0, false), 'inset 0 0 90px 30px rgba(180,15,15,0)');
  assert.strictEqual(CORE.criticalVignetteStyle(-0.5, false), 'inset 0 0 90px 30px rgba(180,15,15,0)');

  // Full intensity standard motion styling
  const fullStyle = CORE.criticalVignetteStyle(1.0, false);
  assert.strictEqual(fullStyle, 'inset 0 0 140px 55px rgba(180,15,15,0.800)');

  // Mid intensity standard motion styling
  const midStyle = CORE.criticalVignetteStyle(0.5, false);
  assert.strictEqual(midStyle, 'inset 0 0 115px 43px rgba(180,15,15,0.625)');

  // Reduced motion styling provides steady moderate opacity
  const reducedStyle = CORE.criticalVignetteStyle(1.0, true);
  assert.strictEqual(reducedStyle, 'inset 0 0 140px 55px rgba(180,15,15,0.600)');

  // Pulse alpha dynamics
  assert.strictEqual(CORE.criticalPulseAlpha(0, 0, false), 0);
  assert.strictEqual(CORE.criticalPulseAlpha(1.0, 0, true), 0.5); // reduced motion steady

  // Sine modulation peaks and troughs at heartbeat frequency
  const peakAlpha = CORE.criticalPulseAlpha(1.0, 1 / (4 * 1.35), false); // sin(pi/2) = 1
  assert.ok(Math.abs(peakAlpha - 0.85) < 1e-4);
  const troughAlpha = CORE.criticalPulseAlpha(1.0, 3 / (4 * 1.35), false); // sin(3pi/2) = -1
  assert.ok(Math.abs(troughAlpha - 0.35) < 1e-4);
});

test('filterMinimapColliders and isMinimapBlockVisible extract static obstacles and cull off-screen blocks', () => {
  const colliders = [
    { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 0.4, z: 10 } }, // ground/curb (max.y 0.4 < 0.6) -> excluded
    { min: { x: 4, y: 0, z: 8 }, max: { x: 8, y: 3.5, z: 15 } },      // building (max.y 3.5 >= 0.6) -> included
    { min: { x: -20, y: 0, z: -30 }, max: { x: -15, y: 2.0, z: -25 } }, // obstacle -> included
    null,
    { min: null, max: null }
  ];

  const filtered = CORE.filterMinimapColliders(colliders, 0.6);
  assert.strictEqual(filtered.length, 2);
  assert.deepStrictEqual(filtered[0], { minX: 4, minZ: 8, w: 4, d: 7 });
  assert.deepStrictEqual(filtered[1], { minX: -20, minZ: -30, w: 5, d: 5 });

  // Empty or invalid input handling
  assert.deepStrictEqual(CORE.filterMinimapColliders([], 0.6), []);
  assert.deepStrictEqual(CORE.filterMinimapColliders(null, 0.6), []);

  // Minimap block visibility culling
  const scale = 75 / 53; // typical minimap scale
  const maxDistSq = 75 * 75 * 2.4; // R * R * 2.4

  // Block near player (px = 4, pz = 8) -> visible
  assert.strictEqual(CORE.isMinimapBlockVisible(4, 8, 4, 7, 4, 8, scale, maxDistSq), true);

  // Block far outside minimap range (px = 4, pz = 8, block at minX = 200, minZ = 200) -> culled
  assert.strictEqual(CORE.isMinimapBlockVisible(200, 200, 4, 7, 4, 8, scale, maxDistSq), false);

  // Invalid parameters return false safely
  assert.strictEqual(CORE.isMinimapBlockVisible(NaN, 0, 1, 1, 0, 0, 1, 100), false);
});

test('compassHeading, compassTickOffset, and compassCardinalLabel resolve heading and tick labels accurately', () => {
  // Compass heading from yaw radians
  assert.strictEqual(CORE.compassHeading(0), 0);
  assert.strictEqual(CORE.compassHeading(Math.PI), 180);
  assert.strictEqual(CORE.compassHeading(Math.PI / 2), 270);
  assert.strictEqual(CORE.compassHeading(-Math.PI / 2), 90);
  assert.strictEqual(CORE.compassHeading(2 * Math.PI), 0);
  assert.strictEqual(CORE.compassHeading(null), 0);

  // Tick angular offsets
  assert.strictEqual(CORE.compassTickOffset(0, 0), 0);
  assert.strictEqual(CORE.compassTickOffset(15, 0), 15);
  assert.strictEqual(CORE.compassTickOffset(350, 0), -10); // wrapped delta
  assert.strictEqual(CORE.compassTickOffset(0, 350), 10);
  assert.strictEqual(CORE.compassTickOffset(180, 0), -180);

  // Cardinal point labels
  assert.strictEqual(CORE.compassCardinalLabel(0), 'N');
  assert.strictEqual(CORE.compassCardinalLabel(45), 'NE');
  assert.strictEqual(CORE.compassCardinalLabel(90), 'E');
  assert.strictEqual(CORE.compassCardinalLabel(135), 'SE');
  assert.strictEqual(CORE.compassCardinalLabel(180), 'S');
  assert.strictEqual(CORE.compassCardinalLabel(225), 'SW');
  assert.strictEqual(CORE.compassCardinalLabel(270), 'W');
  assert.strictEqual(CORE.compassCardinalLabel(315), 'NW');
  assert.strictEqual(CORE.compassCardinalLabel(360), 'N');
  assert.strictEqual(CORE.compassCardinalLabel(-90), 'W');
  assert.strictEqual(CORE.compassCardinalLabel(15), null);
  assert.strictEqual(CORE.compassCardinalLabel(60), null);
  assert.strictEqual(CORE.compassCardinalLabel(NaN), null);
});

test('evaluateCombatEnemies calculates living hostiles and nearest distance with zero allocations', () => {
  const enemies = [
    { pos: { x: 10, y: 0, z: 0 }, dead: false },
    { pos: { x: 0, y: 0, z: 6 }, dead: false },
    { pos: { x: 1, y: 0, z: 1 }, dead: true }, // dead corpse ignored
    null
  ];

  const result = CORE.evaluateCombatEnemies(enemies, 0, 0);
  assert.strictEqual(result.aliveCount, 2);
  assert.strictEqual(result.nearestEnemy, 6);

  // Reusable output object mutation
  const out = { aliveCount: 0, nearestEnemy: undefined };
  const mutated = CORE.evaluateCombatEnemies(enemies, 0, 0, out);
  assert.strictEqual(mutated, out);
  assert.strictEqual(out.aliveCount, 2);
  assert.strictEqual(out.nearestEnemy, 6);

  // No alive enemies returns nearest undefined
  const noEnemies = [
    { pos: { x: 10, y: 0, z: 0 }, dead: true }
  ];
  const emptyRes = CORE.evaluateCombatEnemies(noEnemies, 0, 0);
  assert.strictEqual(emptyRes.aliveCount, 0);
  assert.strictEqual(emptyRes.nearestEnemy, undefined);
  assert.strictEqual(CORE.evaluateCombatEnemies([], 0, 0).aliveCount, 0);
  assert.strictEqual(CORE.evaluateCombatEnemies(null, 0, 0).aliveCount, 0);
});

test('streakActivationSound, fieldUpgradeSound, sentryFireSound, and canMunitionsResupply govern scorestreak audio', () => {
  // Sentry spatial audio distance limit
  assert.strictEqual(CORE.SENTRY_AUDIO_MAX_DIST, 65);

  // Scorestreak activation sound mapping
  assert.strictEqual(CORE.streakActivationSound('uav'), 'streak_uav');
  assert.strictEqual(CORE.streakActivationSound('airstrike'), 'streak_airstrike');
  assert.strictEqual(CORE.streakActivationSound('sentry'), 'streak_sentry');
  assert.strictEqual(CORE.streakActivationSound('unknown'), 'wave');
  assert.strictEqual(CORE.streakActivationSound(null), 'wave');
  assert.strictEqual(CORE.streakActivationSound(undefined), 'wave');

  // Field upgrade deploy and resupply sounds
  assert.strictEqual(CORE.fieldUpgradeSound(true), 'munitions');
  assert.strictEqual(CORE.fieldUpgradeSound(false), 'munitions_resupply');

  // Sentry fire sound
  assert.strictEqual(CORE.sentryFireSound(), 'sentry_shot');

  // Munitions resupply gating
  assert.strictEqual(CORE.canMunitionsResupply(true, false, false), true);
  assert.strictEqual(CORE.canMunitionsResupply(false, true, false), true);
  assert.strictEqual(CORE.canMunitionsResupply(false, false, true), true);
  assert.strictEqual(CORE.canMunitionsResupply(true, true, true), true);
  assert.strictEqual(CORE.canMunitionsResupply(false, false, false), false);
  assert.strictEqual(CORE.canMunitionsResupply(null, undefined, 0), false);
});

test('touchPlateLabel, touchTacticalLabel, touchLethalLabel, touchStreakLabel, touchMeleeState, and touchMeleeLabel govern mobile tactical feedback', () => {
  // touchPlateLabel
  assert.strictEqual(CORE.touchPlateLabel(2, true), 'ARMOR');
  assert.strictEqual(CORE.touchPlateLabel(0, true), 'ARMOR');
  assert.strictEqual(CORE.touchPlateLabel(3, false), 'PLT 3');
  assert.strictEqual(CORE.touchPlateLabel(1, false), 'PLT 1');
  assert.strictEqual(CORE.touchPlateLabel(0, false), 'EMPTY');
  assert.strictEqual(CORE.touchPlateLabel(-1, false), 'EMPTY');
  assert.strictEqual(CORE.touchPlateLabel(null, false), 'EMPTY');
  assert.strictEqual(CORE.touchPlateLabel(undefined, false), 'EMPTY');

  // touchTacticalLabel
  assert.strictEqual(CORE.touchTacticalLabel('flash', 2), 'FLASH');
  assert.strictEqual(CORE.touchTacticalLabel('stun', 1), 'STUN');
  assert.strictEqual(CORE.touchTacticalLabel('smoke', 2), 'SMOKE');
  assert.strictEqual(CORE.touchTacticalLabel('other', 1), 'TAC');
  assert.strictEqual(CORE.touchTacticalLabel(null, 1), 'TAC');
  assert.strictEqual(CORE.touchTacticalLabel('flash', 0), 'EMPTY');
  assert.strictEqual(CORE.touchTacticalLabel('stun', -1), 'EMPTY');
  assert.strictEqual(CORE.touchTacticalLabel('smoke', null), 'EMPTY');

  // touchLethalLabel
  assert.strictEqual(CORE.touchLethalLabel('frag', 2, true), 'HOLD');
  assert.strictEqual(CORE.touchLethalLabel('frag', 2, false), 'FRAG');
  assert.strictEqual(CORE.touchLethalLabel('semtex', 1, false), 'SMTX');
  assert.strictEqual(CORE.touchLethalLabel('claymore', 1, false), 'CLAY');
  assert.strictEqual(CORE.touchLethalLabel('unknown', 1, false), 'NADE');
  assert.strictEqual(CORE.touchLethalLabel(null, 1, false), 'NADE');
  assert.strictEqual(CORE.touchLethalLabel('frag', 0, false), 'EMPTY');
  assert.strictEqual(CORE.touchLethalLabel('semtex', -1, false), 'EMPTY');
  assert.strictEqual(CORE.touchLethalLabel('claymore', null, false), 'EMPTY');

  // touchStreakLabel
  assert.strictEqual(CORE.touchStreakLabel('uav', false), 'UAV');
  assert.strictEqual(CORE.touchStreakLabel('airstrike', false), 'AIR');
  assert.strictEqual(CORE.touchStreakLabel('sentry', false), 'TUR');
  assert.strictEqual(CORE.touchStreakLabel(null, true), 'BOX');
  assert.strictEqual(CORE.touchStreakLabel(undefined, true), 'BOX');
  assert.strictEqual(CORE.touchStreakLabel(null, false), 'STRK');
  assert.strictEqual(CORE.touchStreakLabel(undefined, false), 'STRK');

  // touchMeleeState
  assert.strictEqual(CORE.touchMeleeState(true, 0), 'ready');
  assert.strictEqual(CORE.touchMeleeState(false, 0), '');
  assert.strictEqual(CORE.touchMeleeState(true, 0.4), 'cooldown');
  assert.strictEqual(CORE.touchMeleeState(false, 0.4), 'cooldown');

  // touchMeleeLabel
  assert.strictEqual(CORE.touchMeleeLabel(true, 0), 'STRIKE');
  assert.strictEqual(CORE.touchMeleeLabel(false, 0), 'KNIFE');
  assert.strictEqual(CORE.touchMeleeLabel(true, 0.4), 'WAIT');
  assert.strictEqual(CORE.touchMeleeLabel(false, 0.4), 'WAIT');
});

test('isSteadyActive, stepSteadyAim, swayAmplitude, swayOffsets, isScoped, recoilDecay, aimAssistAngle, and aimAssistPull govern marksman precision balance', () => {
  // isSteadyActive
  assert.strictEqual(CORE.isSteadyActive('SR', 0.85, true, 2.0), true);
  assert.strictEqual(CORE.isSteadyActive('SR', 0.85, false, 2.0), false);
  assert.strictEqual(CORE.isSteadyActive('SR', 0.75, true, 2.0), false);
  assert.strictEqual(CORE.isSteadyActive('SR', 0.85, true, 0), false);
  assert.strictEqual(CORE.isSteadyActive('AR', 0.85, true, 2.0), false);
  assert.strictEqual(CORE.isSteadyActive('SMG', 0.85, true, 2.0), false);
  assert.strictEqual(CORE.isSteadyActive('BR', 0.85, true, 2.0), false);

  // stepSteadyAim
  assert.ok(Math.abs(CORE.stepSteadyAim(2.0, true, 0.5, 2.2, 2.2) - 1.5) < 1e-4);
  assert.ok(Math.abs(CORE.stepSteadyAim(0.3, true, 0.5, 2.2, 2.2) - 0.0) < 1e-4);
  assert.ok(Math.abs(CORE.stepSteadyAim(1.0, false, 0.5, 2.2, 2.2) - 2.1) < 1e-4);
  assert.ok(Math.abs(CORE.stepSteadyAim(2.0, false, 0.5, 2.2, 2.2) - 2.2) < 1e-4);

  // swayAmplitude
  assert.ok(Math.abs(CORE.swayAmplitude(0.0042, false, 0.14, 1.0) - 0.0042) < 1e-6);
  assert.ok(Math.abs(CORE.swayAmplitude(0.0042, true, 0.14, 1.0) - 0.0042 * 0.14) < 1e-6);
  assert.ok(Math.abs(CORE.swayAmplitude(0.0042, false, 0.14, 1.5) - 0.0042 * 1.5) < 1e-6);

  // swayOffsets
  const s1 = CORE.swayOffsets(0, 0.01);
  assert.ok(Math.abs(s1.x - 0) < 1e-6);
  assert.ok(Math.abs(s1.y - (Math.sin(1.2) * 0.01 * 0.8)) < 1e-6);
  const reuse = { x: 0, y: 0 };
  const s2 = CORE.swayOffsets(1.0, 0.005, reuse);
  assert.strictEqual(s2, reuse);
  assert.ok(Math.abs(reuse.x - (Math.sin(1.7) * 0.005 + Math.sin(0.9) * 0.005 * 0.6)) < 1e-6);

  // isScoped
  assert.strictEqual(CORE.isScoped(0.85, 'SR'), true);
  assert.strictEqual(CORE.isScoped(0.80, 'SR'), false);
  assert.strictEqual(CORE.isScoped(0.85, 'AR'), false);
  assert.strictEqual(CORE.isScoped(0.85, 'SMG'), false);

  // recoilDecay
  assert.ok(Math.abs(CORE.recoilDecay(1.0, 0, 0.02) - 1.0) < 1e-4);
  assert.ok(Math.abs(CORE.recoilDecay(1.0, 1.0, 0.02) - 0.02) < 1e-4);
  assert.ok(Math.abs(CORE.recoilDecay(0.5, 0.5, 0.04) - 0.1) < 1e-4);

  // aimAssistAngle
  assert.ok(Math.abs(CORE.aimAssistAngle(0.14, false, 1.6) - 0.14) < 1e-4);
  assert.ok(Math.abs(CORE.aimAssistAngle(0.14, true, 1.6) - 0.224) < 1e-4);

  // aimAssistPull
  assert.ok(Math.abs(CORE.aimAssistPull(2.2, 0.25) - 0.55) < 1e-4);
  assert.ok(Math.abs(CORE.aimAssistPull(5.0, 0.5) - 1.0) < 1e-4);
});

test('crosshairGapOffset, crosshairOpacity, sprintIndicatorState, and sprintIndicatorLabel govern dynamic crosshair and mobility visuals', () => {
  // crosshairGapOffset
  assert.strictEqual(CORE.crosshairGapOffset(0.05, 0, true), 0);
  assert.strictEqual(CORE.crosshairGapOffset(0.010, 0, false), 0);
  assert.strictEqual(CORE.crosshairGapOffset(0.020, 0, false), 2);
  assert.strictEqual(CORE.crosshairGapOffset(0.065, 0, false), 12);
  assert.strictEqual(CORE.crosshairGapOffset(0.200, 0, false), 24);
  assert.strictEqual(CORE.crosshairGapOffset(0.014, 0.5, false), -3);
  assert.strictEqual(CORE.crosshairGapOffset(0.014, 1.0, false), -6);

  // crosshairOpacity
  assert.strictEqual(CORE.crosshairOpacity(0, false, true), 0);
  // scoped weapon (SR/BR)
  assert.strictEqual(CORE.crosshairOpacity(0, true, false), 1);
  assert.strictEqual(CORE.crosshairOpacity(0.2, true, false), 1);
  assert.ok(Math.abs(CORE.crosshairOpacity(0.525, true, false) - 0.5) < 1e-4);
  assert.strictEqual(CORE.crosshairOpacity(0.75, true, false), 0);
  assert.strictEqual(CORE.crosshairOpacity(1.0, true, false), 0);
  // non-scoped weapon (AR/SMG)
  assert.strictEqual(CORE.crosshairOpacity(0, false, false), 1);
  assert.ok(Math.abs(CORE.crosshairOpacity(0.35, false, false) - 0.5) < 1e-4);
  assert.strictEqual(CORE.crosshairOpacity(0.70, false, false), 0);
  assert.strictEqual(CORE.crosshairOpacity(1.0, false, false), 0);

  // sprintIndicatorState
  assert.strictEqual(CORE.sprintIndicatorState(true, true, true), 'exhausted');
  assert.strictEqual(CORE.sprintIndicatorState(false, true, false), 'slide');
  assert.strictEqual(CORE.sprintIndicatorState(true, false, false), 'tac');
  assert.strictEqual(CORE.sprintIndicatorState(false, false, false), '');

  // sprintIndicatorLabel
  assert.strictEqual(CORE.sprintIndicatorLabel('exhausted'), 'EXHAUSTED');
  assert.strictEqual(CORE.sprintIndicatorLabel('slide'), 'SLIDE');
  assert.strictEqual(CORE.sprintIndicatorLabel('tac'), 'TAC SPRINT');
  assert.strictEqual(CORE.sprintIndicatorLabel(''), '');
});

test('touchAdsState and touchJumpState resolve mobile ADS scoped feedback and jump airborne indicator', () => {
  // touchAdsState: '' at hip-fire regardless of weapon type
  assert.strictEqual(CORE.touchAdsState(0, 'SR', 0.82), '');
  assert.strictEqual(CORE.touchAdsState(0, 'AR', 0.82), '');
  assert.strictEqual(CORE.touchAdsState(-1, 'SR', 0.82), '');   // invalid clamped to 0

  // touchAdsState: 'active' for any weapon type during partial ADS below scope threshold
  assert.strictEqual(CORE.touchAdsState(0.5, 'AR', 0.82), 'active');
  assert.strictEqual(CORE.touchAdsState(0.5, 'SMG', 0.82), 'active');
  assert.strictEqual(CORE.touchAdsState(0.5, 'SG', 0.82), 'active');
  assert.strictEqual(CORE.touchAdsState(0.5, 'BR', 0.82), 'active');  // below threshold
  assert.strictEqual(CORE.touchAdsState(0.5, 'SR', 0.82), 'active');  // below threshold

  // touchAdsState: 'scoped' only for SR or BR at or above scope locked threshold
  assert.strictEqual(CORE.touchAdsState(0.82, 'SR', 0.82), 'scoped');
  assert.strictEqual(CORE.touchAdsState(1.0, 'SR', 0.82), 'scoped');
  assert.strictEqual(CORE.touchAdsState(0.82, 'BR', 0.82), 'scoped');
  assert.strictEqual(CORE.touchAdsState(1.0, 'BR', 0.82), 'scoped');

  // touchAdsState: 'active' (not 'scoped') for non-optic weapons even at full ADS
  assert.strictEqual(CORE.touchAdsState(1.0, 'AR', 0.82), 'active');
  assert.strictEqual(CORE.touchAdsState(1.0, 'SMG', 0.82), 'active');
  assert.strictEqual(CORE.touchAdsState(1.0, 'SG', 0.82), 'active');

  // touchAdsState: default threshold 0.82 when scopeLockedThreshold is not a number
  assert.strictEqual(CORE.touchAdsState(0.9, 'SR', undefined), 'scoped');
  assert.strictEqual(CORE.touchAdsState(0.9, 'SR', NaN), 'scoped');

  // touchJumpState: '' when grounded
  assert.strictEqual(CORE.touchJumpState(true), '');

  // touchJumpState: 'airborne' when off the ground
  assert.strictEqual(CORE.touchJumpState(false), 'airborne');
});

test('waveClearScore and waveResupplyAmmo govern wave progression score bonus and ammo resupply balance', () => {
  // WAVE_SCORE_PER_WAVE is the per-wave ramp constant (50 pts/wave)
  assert.strictEqual(CORE.WAVE_SCORE_PER_WAVE, 50);

  // waveClearScore: flat base plus progressive ramp
  // wave 1 clear: 250 + 1 * 50 = 300
  assert.strictEqual(CORE.waveClearScore(250, 1, 50), 300);
  // wave 5 clear: 250 + 5 * 50 = 500
  assert.strictEqual(CORE.waveClearScore(250, 5, 50), 500);
  // wave 15 (victory): 250 + 15 * 50 = 1000
  assert.strictEqual(CORE.waveClearScore(250, 15, 50), 1000);
  // uses WAVE_SCORE_PER_WAVE as default when perWave omitted or non-numeric
  assert.strictEqual(CORE.waveClearScore(250, 1, undefined), 300);
  assert.strictEqual(CORE.waveClearScore(250, 1, NaN), 300);
  // negative or non-numeric inputs clamp to zero-safe defaults
  assert.strictEqual(CORE.waveClearScore(-10, 5, 50), 250);   // base clamped to 0
  assert.strictEqual(CORE.waveClearScore(250, -2, 50), 250);  // wave clamped to 0
  assert.strictEqual(CORE.waveClearScore(undefined, 3, 50), 150);  // base defaults to 0
  // fractional wave numbers are floored (cannot clear half a wave)
  assert.strictEqual(CORE.waveClearScore(250, 3.9, 50), 400);  // floor(3.9) = 3

  // RESUPPLY_MAG_RATIO: 2.5 mags refilled per wave clear
  assert.strictEqual(CORE.RESUPPLY_MAG_RATIO, 2.5);

  // waveResupplyAmmo: tops up reserve by ratio mags, capped at reserveMax
  // M4 Carbine: mag=30, reserveMax=150. At 0 reserve: 0 + round(30 * 2.5) = 75
  assert.strictEqual(CORE.waveResupplyAmmo(0, 150, 30, 2.5), 75);
  // At 100 reserve: 100 + 75 = 175, capped at 150
  assert.strictEqual(CORE.waveResupplyAmmo(100, 150, 30, 2.5), 150);
  // At 80 reserve: 80 + 75 = 155, capped at 150
  assert.strictEqual(CORE.waveResupplyAmmo(80, 150, 30, 2.5), 150);
  // uses RESUPPLY_MAG_RATIO as default when ratio omitted
  assert.strictEqual(CORE.waveResupplyAmmo(0, 150, 30, undefined), 75);
  assert.strictEqual(CORE.waveResupplyAmmo(0, 150, 30, NaN), 75);
  // SV-98: mag=5, reserveMax=35. At 0: 0 + round(5 * 2.5) = 13
  assert.strictEqual(CORE.waveResupplyAmmo(0, 35, 5, 2.5), 13);
  // negative reserve is treated as 0
  assert.strictEqual(CORE.waveResupplyAmmo(-5, 35, 5, 2.5), 13);
  // zero magSize yields no refill (gun with no mag size is invalid)
  assert.strictEqual(CORE.waveResupplyAmmo(0, 35, 0, 2.5), 0);
  // already at max: no change
  assert.strictEqual(CORE.waveResupplyAmmo(35, 35, 5, 2.5), 35);
});

test('healthHudChanged and syncHealthHudState govern change-driven health HUD updates', () => {
  // null / non-object lastState always triggers a redraw (fresh init)
  assert.strictEqual(CORE.healthHudChanged(null, 100, 100, 100, 0, false), true);
  assert.strictEqual(CORE.healthHudChanged(undefined, 100, 100, 100, 0, false), true);
  assert.strictEqual(CORE.healthHudChanged('stale', 100, 100, 100, 0, false), true);

  // syncHealthHudState initialises a fresh cache object when given null
  const state = CORE.syncHealthHudState(null, 80, 100, 60, 2, false);
  assert.strictEqual(state.hp, 80);
  assert.strictEqual(state.maxHp, 100);
  assert.strictEqual(state.armor, 60);
  assert.strictEqual(state.plates, 2);
  assert.strictEqual(state.plateInserting, false);

  // identical values: no change
  assert.strictEqual(CORE.healthHudChanged(state, 80, 100, 60, 2, false), false);

  // each field individually triggers a change
  assert.strictEqual(CORE.healthHudChanged(state, 79, 100, 60, 2, false), true);   // hp changed
  assert.strictEqual(CORE.healthHudChanged(state, 80, 120, 60, 2, false), true);   // maxHp changed
  assert.strictEqual(CORE.healthHudChanged(state, 80, 100, 59, 2, false), true);   // armor changed
  assert.strictEqual(CORE.healthHudChanged(state, 80, 100, 60, 1, false), true);   // plates changed
  assert.strictEqual(CORE.healthHudChanged(state, 80, 100, 60, 2, true), true);    // plateInserting changed

  // sync mutates the same object in place and returns it
  const same = CORE.syncHealthHudState(state, 50, 100, 0, 0, true);
  assert.strictEqual(same, state);  // mutates in place
  assert.strictEqual(state.hp, 50);
  assert.strictEqual(state.armor, 0);
  assert.strictEqual(state.plates, 0);
  assert.strictEqual(state.plateInserting, true);

  // after sync, same values produce no change
  assert.strictEqual(CORE.healthHudChanged(state, 50, 100, 0, 0, true), false);

  // zero health (dead player) is valid and detected
  CORE.syncHealthHudState(state, 0, 100, 0, 0, false);
  assert.strictEqual(CORE.healthHudChanged(state, 0, 100, 0, 0, false), false);
  assert.strictEqual(CORE.healthHudChanged(state, 1, 100, 0, 0, false), true);

  // plateInserting false → true is a state change (plate animation started)
  CORE.syncHealthHudState(state, 100, 100, 50, 3, false);
  assert.strictEqual(CORE.healthHudChanged(state, 100, 100, 50, 3, true), true);
});

test('mantleSound, slideStartSound, footstepCadence, playerFootstepSound, and shouldPlayFootstep govern tactical mobility audio', () => {
  // Sound keys
  assert.strictEqual(CORE.mantleSound(), 'mantle');
  assert.strictEqual(CORE.slideStartSound(), 'slide');

  // Footstep sound resolution
  assert.strictEqual(CORE.playerFootstepSound(false), 'step');
  assert.strictEqual(CORE.playerFootstepSound(true), 'step_crouch');
  assert.strictEqual(CORE.playerFootstepSound(0), 'step');
  assert.strictEqual(CORE.playerFootstepSound(1), 'step_crouch');

  // Cadence constants
  assert.strictEqual(CORE.FOOTSTEP_BASE_CADENCE, 1.0);
  assert.strictEqual(CORE.FOOTSTEP_SPRINT_CADENCE, 1.6);
  assert.strictEqual(CORE.FOOTSTEP_TAC_SPRINT_CADENCE, 2.0);
  assert.strictEqual(CORE.FOOTSTEP_CROUCH_CADENCE, 0.65);

  // Normal walking (no sprint, no tac, no crouch)
  assert.strictEqual(CORE.footstepCadence(false, false, false), 1.0);

  // Standard sprint
  assert.strictEqual(CORE.footstepCadence(true, false, false), 1.6);

  // Tactical sprint (faster cadence)
  assert.strictEqual(CORE.footstepCadence(true, true, false), 2.0);

  // Crouch walking (stealth: slower cadence)
  assert.strictEqual(CORE.footstepCadence(false, false, true), 0.65);

  // Crouch overrides sprint keys
  assert.strictEqual(CORE.footstepCadence(true, false, true), 0.65);
  assert.strictEqual(CORE.footstepCadence(true, true, true), 0.65);

  // shouldPlayFootstep: requires grounded AND horizontal speed > threshold
  assert.strictEqual(CORE.FOOTSTEP_MIN_SPEED, 1.5);
  assert.strictEqual(CORE.shouldPlayFootstep(true, 2.5), true);
  assert.strictEqual(CORE.shouldPlayFootstep(true, 1.5), false);
  assert.strictEqual(CORE.shouldPlayFootstep(true, 1.2), false);
  assert.strictEqual(CORE.shouldPlayFootstep(true, 0), false);
  assert.strictEqual(CORE.shouldPlayFootstep(false, 5.0), false); // airborne
  assert.strictEqual(CORE.shouldPlayFootstep(false, 0), false);

  // Custom minSpeed override
  assert.strictEqual(CORE.shouldPlayFootstep(true, 2.0, 1.0), true);
  assert.strictEqual(CORE.shouldPlayFootstep(true, 2.0, 3.0), false);

  // Edge cases: non-numbers / undefined
  assert.strictEqual(CORE.shouldPlayFootstep(true, NaN), false);
  assert.strictEqual(CORE.shouldPlayFootstep(true, undefined), false);
  assert.strictEqual(CORE.shouldPlayFootstep(false, 10), false);
});

test('touchFireState, touchFireLabel, and touchReloadLabel govern mobile combat action button feedback', () => {
  // touchFireState:
  // ready when ammo in mag
  assert.strictEqual(CORE.touchFireState(30, 90, false), 'ready');
  assert.strictEqual(CORE.touchFireState(1, 0, false), 'ready');
  // dry when mag is empty but reserve is available
  assert.strictEqual(CORE.touchFireState(0, 90, false), 'dry');
  assert.strictEqual(CORE.touchFireState(-1, 30, false), 'dry');
  // reloading when reloading regardless of ammo
  assert.strictEqual(CORE.touchFireState(0, 90, true), 'reloading');
  assert.strictEqual(CORE.touchFireState(30, 90, true), 'reloading');
  // empty when both mag and reserve are exhausted
  assert.strictEqual(CORE.touchFireState(0, 0, false), 'empty');
  assert.strictEqual(CORE.touchFireState(-1, 0, false), 'empty');
  assert.strictEqual(CORE.touchFireState(0, -5, false), 'empty');
  assert.strictEqual(CORE.touchFireState(NaN, 0, false), 'empty');

  // touchFireLabel:
  // standard ready
  assert.strictEqual(CORE.touchFireLabel(30, 90, false, false), 'FIRE');
  assert.strictEqual(CORE.touchFireLabel(1, 0, false, false), 'FIRE');
  // ADS+FIRE mode ready
  assert.strictEqual(CORE.touchFireLabel(30, 90, false, true), 'ADS+FIRE');
  // dry (needs reload)
  assert.strictEqual(CORE.touchFireLabel(0, 90, false, false), 'RELOAD');
  assert.strictEqual(CORE.touchFireLabel(0, 90, false, true), 'RELOAD');
  // reloading
  assert.strictEqual(CORE.touchFireLabel(0, 90, true, false), 'RELOAD');
  assert.strictEqual(CORE.touchFireLabel(15, 90, true, true), 'RELOAD');
  // empty
  assert.strictEqual(CORE.touchFireLabel(0, 0, false, false), 'EMPTY');
  assert.strictEqual(CORE.touchFireLabel(0, 0, false, true), 'EMPTY');

  // touchReloadLabel:
  // standard ready with ammo in mag
  assert.strictEqual(CORE.touchReloadLabel(30, 90, false), 'RLD');
  assert.strictEqual(CORE.touchReloadLabel(1, 90, false), 'RLD');
  // urgent reload when mag empty and reserve available
  assert.strictEqual(CORE.touchReloadLabel(0, 90, false), 'RELOAD');
  assert.strictEqual(CORE.touchReloadLabel(-1, 30, false), 'RELOAD');
  // reloading in progress
  assert.strictEqual(CORE.touchReloadLabel(0, 90, true), 'WAIT');
  assert.strictEqual(CORE.touchReloadLabel(15, 90, true), 'WAIT');
  // empty reserve and empty mag
  assert.strictEqual(CORE.touchReloadLabel(0, 0, false), 'EMPTY');
  assert.strictEqual(CORE.touchReloadLabel(0, -5, false), 'EMPTY');
  assert.strictEqual(CORE.touchReloadLabel(NaN, 0, false), 'EMPTY');
});

test('weaponAdsZoom, mobilityFovBoost, targetCameraFov, strafeDirection, cameraRoll, and cameraPositionOffsets govern tactical camera dynamics', () => {
  // Constants
  assert.strictEqual(CORE.SNIPER_ADS_ZOOM, 52);
  assert.strictEqual(CORE.DEFAULT_ADS_ZOOM, 24);
  assert.strictEqual(CORE.SLIDE_FOV_BOOST, 6);
  assert.strictEqual(CORE.TAC_SPRINT_FOV_BOOST, 4);
  assert.strictEqual(CORE.CAMERA_MIN_FOV, 20);
  assert.strictEqual(CORE.CAMERA_MAX_FOV, 130);
  assert.strictEqual(CORE.CAMERA_BOB_X_SCALE, 0.025);
  assert.strictEqual(CORE.CAMERA_BOB_Y_SCALE, 0.05);
  assert.strictEqual(CORE.CAMERA_SLIDE_DIP, 0.45);
  assert.strictEqual(CORE.CAMERA_BOB_ROLL_SCALE, 0.008);
  assert.strictEqual(CORE.CAMERA_SLIDE_ROLL, 0.16);
  assert.strictEqual(CORE.CAMERA_STRAFE_ROLL_SCALE, 0.012);

  // weaponAdsZoom
  assert.strictEqual(CORE.weaponAdsZoom('SR'), 52);
  assert.strictEqual(CORE.weaponAdsZoom('AR'), 24);
  assert.strictEqual(CORE.weaponAdsZoom('SMG'), 24);
  assert.strictEqual(CORE.weaponAdsZoom('SG'), 24);
  assert.strictEqual(CORE.weaponAdsZoom('BR'), 24);
  assert.strictEqual(CORE.weaponAdsZoom(''), 24);
  assert.strictEqual(CORE.weaponAdsZoom(undefined), 24);

  // mobilityFovBoost
  // Nominal standing/running
  assert.strictEqual(CORE.mobilityFovBoost(false, false, 0, false), 0);
  // Slide boost (+6 deg)
  assert.strictEqual(CORE.mobilityFovBoost(true, false, 0, false), 6);
  // Tactical sprint boost (+4 deg)
  assert.strictEqual(CORE.mobilityFovBoost(false, true, 0, false), 4);
  // Slide takes precedence over tac sprint
  assert.strictEqual(CORE.mobilityFovBoost(true, true, 0, false), 6);
  // Reduced motion suppresses mobility FOV boosts
  assert.strictEqual(CORE.mobilityFovBoost(true, false, 0, true), 0);
  assert.strictEqual(CORE.mobilityFovBoost(false, true, 0, true), 0);
  // ADS suppresses mobility FOV boosts to prioritize sight alignment
  assert.strictEqual(CORE.mobilityFovBoost(true, false, 0.8, false), 0);
  assert.strictEqual(CORE.mobilityFovBoost(false, true, 0.6, false), 0);
  assert.strictEqual(CORE.mobilityFovBoost(true, false, 0.4, false), 6);

  // targetCameraFov
  // Base hip-fire
  assert.strictEqual(CORE.targetCameraFov(75, 0, 24, 0), 75);
  // Standard weapon ADS zoom
  assert.strictEqual(CORE.targetCameraFov(75, 1, 24, 0), 51);
  // Sniper rifle ADS zoom
  assert.strictEqual(CORE.targetCameraFov(75, 1, 52, 0), 23);
  // Partial ADS zoom
  assert.strictEqual(CORE.targetCameraFov(75, 0.5, 24, 0), 63);
  // Slide FOV kick
  assert.strictEqual(CORE.targetCameraFov(75, 0, 24, 6), 81);
  // Tactical sprint FOV kick
  assert.strictEqual(CORE.targetCameraFov(75, 0, 24, 4), 79);
  // Bounds clamping
  assert.strictEqual(CORE.targetCameraFov(150, 0, 24, 0), 130);
  assert.strictEqual(CORE.targetCameraFov(10, 1, 52, 0), 20);
  // Fallbacks for corrupt input
  assert.strictEqual(CORE.targetCameraFov(NaN, 0, 24, 0), 75);
  assert.strictEqual(CORE.targetCameraFov(75, NaN, 24, 0), 75);
  assert.strictEqual(CORE.targetCameraFov(75, 0, NaN, 0), 75);

  // strafeDirection
  // Neutral
  assert.strictEqual(CORE.strafeDirection(false, false, 0), 0);
  // Keyboard keys
  assert.strictEqual(CORE.strafeDirection(true, false, 0), -1);
  assert.strictEqual(CORE.strafeDirection(false, true, 0), 1);
  assert.strictEqual(CORE.strafeDirection(true, true, 0), 0);
  // Analog stick
  assert.strictEqual(CORE.strafeDirection(false, false, -0.7), -1);
  assert.strictEqual(CORE.strafeDirection(false, false, 0.8), 1);
  // Analog deadzone (<= 0.15)
  assert.strictEqual(CORE.strafeDirection(false, false, 0.10), 0);
  assert.strictEqual(CORE.strafeDirection(false, false, -0.12), 0);
  // Analog overrides keys if active
  assert.strictEqual(CORE.strafeDirection(true, false, 0.5), 1);

  // cameraRoll
  // Reduced motion suppresses motion roll
  assert.strictEqual(CORE.cameraRoll(1.5, 1.0, 1.0, 1, true, 0, false), 0);
  // Scoped sway roll is preserved even under reduced motion
  assert.strictEqual(CORE.cameraRoll(1.5, 1.0, 1.0, 1, true, 0.08, true), 0.04);
  // Strafe banking roll: left is negative, right is positive
  const rollLeft = CORE.cameraRoll(0, 0, 0, -1, false, 0, false);
  const rollRight = CORE.cameraRoll(0, 0, 0, 1, false, 0, false);
  assert.strictEqual(rollLeft, -0.012);
  assert.strictEqual(rollRight, 0.012);
  // Slide roll tilt (+0.16)
  assert.strictEqual(CORE.cameraRoll(0, 0, 1, 0, false, 0, false), 0.16);
  // Bob roll
  const bobR = CORE.cameraRoll(Math.PI / 2, 1, 0, 0, false, 0, false);
  assert.ok(Math.abs(bobR - 0.008) < 1e-4);

  // cameraPositionOffsets
  const posOut = { x: 0, y: 0 };
  // Reduced motion zeroes position offsets
  CORE.cameraPositionOffsets(1.5, 1.0, 1.0, true, posOut);
  assert.strictEqual(posOut.x, 0);
  assert.strictEqual(posOut.y, 0);
  // Slide dip (-0.45 m)
  CORE.cameraPositionOffsets(0, 0, 1.0, false, posOut);
  assert.strictEqual(posOut.x, 0);
  assert.strictEqual(posOut.y, -0.45);
  // Bob oscillation
  CORE.cameraPositionOffsets(Math.PI / 2, 1.0, 0, false, posOut);
  assert.ok(Math.abs(posOut.x - 0.025) < 1e-4);
  assert.ok(Math.abs(posOut.y - 0.05) < 1e-4);
  // Return new object if not passed
  const freshOut = CORE.cameraPositionOffsets(0, 0, 0, false);
  assert.strictEqual(freshOut.x, 0);
  assert.strictEqual(freshOut.y, 0);
});

test('playerMoveSpeed, movementAccelRate, stepHorizontalVelocity, stepHeadBob, landingStunDuration, stepJumpTimers, canInitiateJump, stepAdsTransition, stepGunSwitch, applyShotKick, decayShotKick, and sniperUnscopeAds govern mobility and combat balance', () => {
  // Constants
  assert.strictEqual(CORE.TAC_SPRINT_SPEED_MUL, 1.25);
  assert.strictEqual(CORE.LAND_STUN_SPEED_MUL, 0.55);
  assert.strictEqual(CORE.ADS_MOVE_SPEED_MUL, 0.65);
  assert.strictEqual(CORE.AIR_SLIDE_ACCEL_RATE, 4);
  assert.strictEqual(CORE.AIR_MOVE_ACCEL_RATE, 7);
  assert.strictEqual(CORE.GROUND_DECEL_DEFAULT, 38);
  assert.strictEqual(CORE.VELOCITY_SNAP_THRESHOLD, 0.05);
  assert.strictEqual(CORE.BOB_SPEED_THRESHOLD, 0.5);
  assert.strictEqual(CORE.BOB_FREQ_SPRINT, 13);
  assert.strictEqual(CORE.BOB_FREQ_WALK, 9);
  assert.strictEqual(CORE.BOB_SPEED_SCALE, 6);
  assert.strictEqual(CORE.BOB_GROW_RATE, 6);
  assert.strictEqual(CORE.BOB_DECAY_RATE, 8);
  assert.strictEqual(CORE.LAND_STUN_BASE_TIME, 0.25);
  assert.strictEqual(CORE.LAND_STUN_SCALE, 0.5);
  assert.strictEqual(CORE.COYOTE_TIME, 0.12);
  assert.strictEqual(CORE.JUMP_BUFFER_TIME, 0.15);
  assert.strictEqual(CORE.ADS_BASE_SPEED, 12);
  assert.strictEqual(CORE.GUN_SWITCH_SPEED, 3.5);
  assert.strictEqual(CORE.SNIPER_UNSCOPE_FACTOR, 0.45);
  assert.strictEqual(CORE.SHOT_KICK_IMPULSE, 0.5);
  assert.strictEqual(CORE.SHOT_KICK_MAX, 1.4);
  assert.strictEqual(CORE.SHOT_KICK_DECAY_BASE, 0.001);

  // playerMoveSpeed:
  // Base walking speed
  assert.strictEqual(CORE.playerMoveSpeed(5.4, 1, false, false, false, false, false, false, 1.65, 0.55, 1), 5.4);
  // Analog partial tilt (0.5x)
  assert.strictEqual(CORE.playerMoveSpeed(5.4, 0.5, false, false, false, false, false, false, 1.65, 0.55, 1), 2.7);
  // Standard sprint (5.4 * 1.65 = 8.91)
  assert.ok(Math.abs(CORE.playerMoveSpeed(5.4, 1, true, false, false, false, false, false, 1.65, 0.55, 1) - 8.91) < 1e-4);
  // Tactical sprint burst (5.4 * 1.65 * 1.25 = 11.1375)
  assert.ok(Math.abs(CORE.playerMoveSpeed(5.4, 1, true, true, false, false, false, false, 1.65, 0.55, 1) - 11.1375) < 1e-4);
  // Downed penalty (5.4 * 0.35 = 1.89)
  assert.ok(Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, true, false, false, false, 1.65, 0.55, 1) - 1.89) < 1e-4);
  // Hard landing stun penalty (5.4 * 0.55 = 2.97)
  assert.ok(Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, true, false, false, 1.65, 0.55, 1) - 2.97) < 1e-4);
  // Crouch walk (5.4 * 0.55 = 2.97)
  assert.ok(Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, false, true, false, 1.65, 0.55, 1) - 2.97) < 1e-4);
  // Aiming down sights (5.4 * 0.65 = 3.51)
  assert.ok(Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, false, false, true, 1.65, 0.55, 1) - 3.51) < 1e-4);
  // ADS with lightweight stock attachment (+15% mobility -> moveMul 1.15)
  assert.ok(Math.abs(CORE.playerMoveSpeed(5.4, 1, false, false, false, false, false, true, 1.65, 0.55, 1.15) - (5.4 * 0.65 * 1.15)) < 1e-4);

  // movementAccelRate:
  assert.strictEqual(CORE.movementAccelRate(true, false, true, 16, 38), 16);
  assert.strictEqual(CORE.movementAccelRate(true, false, false, 16, 38), 38);
  assert.strictEqual(CORE.movementAccelRate(false, false, true, 16, 38), 7);
  assert.strictEqual(CORE.movementAccelRate(false, true, true, 16, 38), 4);

  // stepHorizontalVelocity:
  const vOut = { x: 0, z: 0 };
  CORE.stepHorizontalVelocity(0, 0, 10, 0, 16, 0.05, true, true, vOut);
  // blend = min(1, 16 * 0.05) = 0.8 -> vx = 8
  assert.ok(Math.abs(vOut.x - 8.0) < 1e-4);
  assert.strictEqual(vOut.z, 0);
  // Stop snap to 0 below threshold (0.05 m/s) when on ground with no input
  CORE.stepHorizontalVelocity(0.03, 0.02, 0, 0, 38, 0.05, true, false, vOut);
  assert.strictEqual(vOut.x, 0);
  assert.strictEqual(vOut.z, 0);

  // stepHeadBob:
  const bobOut = { phase: 0, amp: 0 };
  // Stationary on ground -> decays amplitude
  CORE.stepHeadBob(1.0, 0.8, true, 0.2, false, 0.05, bobOut);
  assert.strictEqual(bobOut.phase, 1.0);
  assert.ok(bobOut.amp < 0.8);
  // Walking -> advances phase by 9 rad/s
  CORE.stepHeadBob(0, 0, true, 3.0, false, 0.1, bobOut);
  assert.ok(Math.abs(bobOut.phase - 0.9) < 1e-4);
  assert.ok(bobOut.amp > 0);
  // Sprinting -> advances phase by 13 rad/s
  CORE.stepHeadBob(0, 0, true, 8.0, true, 0.1, bobOut);
  assert.ok(Math.abs(bobOut.phase - 1.3) < 1e-4);

  // landingStunDuration:
  assert.strictEqual(CORE.landingStunDuration(1.0), 0.25);
  assert.strictEqual(CORE.landingStunDuration(0.5), 0.50);
  assert.strictEqual(CORE.landingStunDuration(0.0), 0.75);

  // stepJumpTimers:
  const jOut = { coyoteT: 0, jumpBufT: 0 };
  // On ground refreshes coyote timer to 0.12s
  CORE.stepJumpTimers(0, 0, true, false, 0.016, jOut);
  assert.strictEqual(jOut.coyoteT, 0.12);
  assert.strictEqual(jOut.jumpBufT, 0);
  // Space pressed registers buffer timer to 0.15s
  CORE.stepJumpTimers(0.1, 0, false, true, 0.016, jOut);
  assert.strictEqual(jOut.jumpBufT, 0.15);
  assert.ok(Math.abs(jOut.coyoteT - (0.1 - 0.016)) < 1e-4);

  // canInitiateJump:
  assert.strictEqual(CORE.canInitiateJump(0.15, 0.12, false, false, false, 0), true);
  // Blocked if no jump buffered
  assert.strictEqual(CORE.canInitiateJump(0, 0.12, false, false, false, 0), false);
  // Blocked if coyote expired
  assert.strictEqual(CORE.canInitiateJump(0.15, 0, false, false, false, 0), false);
  // Blocked if crouching
  assert.strictEqual(CORE.canInitiateJump(0.15, 0.12, true, false, false, 0), false);
  // Blocked if sliding
  assert.strictEqual(CORE.canInitiateJump(0.15, 0.12, false, true, false, 0), false);
  // Blocked if downed
  assert.strictEqual(CORE.canInitiateJump(0.15, 0.12, false, false, true, 0), false);
  // Blocked if stunned by hard landing
  assert.strictEqual(CORE.canInitiateJump(0.15, 0.12, false, false, false, 0.2), false);

  // stepAdsTransition & stepGunSwitch:
  // ADS transition in
  const adsIn = CORE.stepAdsTransition(0, true, 0.05, 1, 1);
  assert.ok(Math.abs(adsIn - (12 * 0.05)) < 1e-4);
  // ADS transition out
  const adsOut = CORE.stepAdsTransition(1, false, 0.05, 1, 1);
  assert.ok(Math.abs(adsOut - (1 - 12 * 0.05)) < 1e-4);
  // Gun switch step
  const switchStep = CORE.stepGunSwitch(0.2, 0.1);
  assert.ok(Math.abs(switchStep - (0.2 + 0.1 * 3.5)) < 1e-4);
  assert.strictEqual(CORE.stepGunSwitch(0.95, 0.1), 1.0);

  // applyShotKick, decayShotKick, sniperUnscopeAds:
  assert.strictEqual(CORE.applyShotKick(0), 0.5);
  assert.strictEqual(CORE.applyShotKick(1.2), 1.4);
  const decayedKick = CORE.decayShotKick(1.0, 0.05);
  assert.ok(decayedKick < 1.0 && decayedKick > 0);
  assert.ok(Math.abs(CORE.sniperUnscopeAds(1.0) - 0.45) < 1e-4);
});
