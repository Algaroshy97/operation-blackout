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
  assert.deepStrictEqual(r.beat, { score: true, wave: true, accuracy: true });
  assert.strictEqual(r.stats.bestScore, 5000);
  assert.strictEqual(r.stats.runs, 1);
  // a worse run must not regress any record, but still counts as a run
  r = CORE.mergeRunIntoStats(r.stats, { score: 100, wave: 2, accuracy: 12, kills: 5 });
  assert.deepStrictEqual(r.beat, { score: false, wave: false, accuracy: false });
  assert.strictEqual(r.stats.bestScore, 5000);
  assert.strictEqual(r.stats.bestWave, 7);
  assert.strictEqual(r.stats.runs, 2);
  assert.strictEqual(r.stats.totalKills, 65);
  // one record can fall without the others
  r = CORE.mergeRunIntoStats(r.stats, { score: 200, wave: 9, accuracy: 10, kills: 1 });
  assert.deepStrictEqual(r.beat, { score: false, wave: true, accuracy: false });
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

// ---------------------------------------------------------------- GAP-02 (save)
test('a checkpoint round-trips through JSON', () => {
  const cp = CORE.makeCheckpoint({
    wave: 7, score: 12000, kills: 90, headshots: 20, shotsFired: 400, shotsHit: 180,
    health: 64, armor: 30, grenades: 2, difficulty: 'veteran', endless: false,
    weapons: [{ gi: 0, ammo: 12, reserve: 90 }, { gi: 1, ammo: 32, reserve: 160 }], savedAt: 123
  });
  const back = CORE.validateCheckpoint(JSON.parse(JSON.stringify(cp)), 4);
  assert.strictEqual(back.wave, 7);
  assert.strictEqual(back.difficulty, 'veteran');
  assert.strictEqual(back.weapons[1].reserve, 160);
  assert.strictEqual(back.health, 64);
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
