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
