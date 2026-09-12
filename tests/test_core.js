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
