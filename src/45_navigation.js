// ============ NAVIGATION: GRID + FLOW FIELD ============
'use strict';
// A 1 m grid over the arena is rasterised from the colliders; a Dijkstra flow
// field toward the player is rebuilt a few times per second. Every enemy then
// reads the field at its cell (O(1)) — dozens of agents route around walls,
// through doorways and up the stairs for the price of one search.
const NAV = {
  size: 1, half: CFG.world.size / 2, n: CFG.world.size,
  blocked: null, cost: null, dist: null, dirty: true,
  goalCell: -1, t: 0, heap: null, stairs: []
};
NAV.blocked = new Uint8Array(NAV.n * NAV.n);
NAV.cost = new Float32Array(NAV.n * NAV.n);
NAV.dist = new Float32Array(NAV.n * NAV.n);
function markNavDirty() { NAV.dirty = true; }
function navCell(x, z) {
  const i = Math.floor((x + NAV.half) / NAV.size), j = Math.floor((z + NAV.half) / NAV.size);
  if (i < 0 || j < 0 || i >= NAV.n || j >= NAV.n) return -1;
  return j * NAV.n + i;
}
function navCellCenter(c, out) {
  out.x = (c % NAV.n + 0.5) * NAV.size - NAV.half;
  out.z = (Math.floor(c / NAV.n) + 0.5) * NAV.size - NAV.half;
  return out;
}
// staircase steps are thin 3.2 x 0.82 slabs: walkable in sequence
function isStairStep(c) {
  return Math.abs((c.max.x - c.min.x) - 3.2) < 0.01 && Math.abs((c.max.z - c.min.z) - 0.82) < 0.01;
}
function buildNavGrid() {
  const N = NAV.n, r = 0.42;
  NAV.blocked.fill(0);
  NAV.stairs.length = 0;
  for (let k = 0; k < colliders.length; k++) {
    const c = colliders[k];
    // stair steps block ground routing like any wall; climbing them is direct steering
    if (isStairStep(c)) NAV.stairs.push(c);
    // blocks a walking body at ground level? (not steppable, not overhead)
    if (c.max.y <= 0.55 || c.min.y > 1.7) continue;
    const i0 = Math.max(0, Math.floor((c.min.x - r + NAV.half) / NAV.size));
    const i1 = Math.min(N - 1, Math.floor((c.max.x + r + NAV.half) / NAV.size));
    const j0 = Math.max(0, Math.floor((c.min.z - r + NAV.half) / NAV.size));
    const j1 = Math.min(N - 1, Math.floor((c.max.z + r + NAV.half) / NAV.size));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) NAV.blocked[j * N + i] = 1;
  }
  // arena edge
  for (let i = 0; i < N; i++) { NAV.blocked[i] = NAV.blocked[(N - 1) * N + i] = NAV.blocked[i * N] = NAV.blocked[i * N + N - 1] = 1; }
  // wall-hugging penalty: cells next to obstacles cost more, so paths keep a margin
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = j * N + i;
    if (NAV.blocked[c]) { NAV.cost[c] = Infinity; continue; }
    let near = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < N && jj < N && NAV.blocked[jj * N + ii]) near = 1;
    }
    NAV.cost[c] = near ? 1.6 : 1;
  }
  NAV.dirty = false;
  NAV.goalCell = -1;
}
// binary min-heap keyed on NAV.dist
function navHeapPush(h, c) {
  h.push(c);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (NAV.dist[h[p]] <= NAV.dist[h[i]]) break;
    const t = h[p]; h[p] = h[i]; h[i] = t; i = p;
  }
}
function navHeapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && NAV.dist[h[l]] < NAV.dist[h[m]]) m = l;
      if (r < h.length && NAV.dist[h[r]] < NAV.dist[h[m]]) m = r;
      if (m === i) break;
      const t = h[m]; h[m] = h[i]; h[i] = t; i = m;
    }
  }
  return top;
}
const NAV_NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
function computeFlow(goals) {
  const N = NAV.n;
  NAV.dist.fill(Infinity);
  const h = [];
  for (const g of goals) { if (g >= 0 && !NAV.blocked[g]) { NAV.dist[g] = 0; navHeapPush(h, g); } }
  while (h.length) {
    const c = navHeapPop(h);
    const i = c % N, j = (c - i) / N, dc = NAV.dist[c];
    for (let k = 0; k < 8; k++) {
      const ii = i + NAV_NB[k][0], jj = j + NAV_NB[k][1];
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
      const n = jj * N + ii;
      if (NAV.blocked[n]) continue;
      // no corner cutting on diagonals
      if (k >= 4 && (NAV.blocked[j * N + ii] || NAV.blocked[jj * N + i])) continue;
      const nd = dc + NAV_NB[k][2] * NAV.cost[n];
      if (nd < NAV.dist[n]) { NAV.dist[n] = nd; navHeapPush(h, n); }
    }
  }
}
// Player on an upper level: route everyone to the foot of the nearest staircase.
function playerElevated() { return player.pos.y - eyeHeight() > 2.2; }
const STAIR_FEET = [[0, 14.8], [0, -14.8]];
function updateNav(dt) {
  if (NAV.dirty) buildNavGrid();
  NAV.t -= dt;
  let goals;
  if (playerElevated()) {
    goals = STAIR_FEET.map(function (s) { return navCell(s[0], s[1]); });
  } else {
    // nearest free cell to the player (they may stand on a crate edge)
    let g = navCell(player.pos.x, player.pos.z);
    if (g >= 0 && NAV.blocked[g]) {
      const N = NAV.n, gi = g % N, gj = (g - gi) / N;
      let best = -1, bd = 1e9;
      for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
        const ii = gi + di, jj = gj + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const c = jj * N + ii;
        if (!NAV.blocked[c] && di * di + dj * dj < bd) { bd = di * di + dj * dj; best = c; }
      }
      g = best;
    }
    goals = [g];
  }
  const key = goals.join(',');
  if (key !== NAV.goalKey || NAV.t <= 0) {
    NAV.goalKey = key; NAV.t = 0.35;
    computeFlow(goals);
  }
}
// Desired unit direction (xz) from (x, z) along the flow; false when no path is known.
const _navC = { x: 0, z: 0 };
function navDirTo(x, z, out) {
  const c = navCell(x, z);
  if (c < 0) return false;
  const N = NAV.n, i = c % N, j = (c - i) / N;
  let best = -1, bd = NAV.blocked[c] ? Infinity : NAV.dist[c];
  if (bd === Infinity) {
    // inside an obstacle's margin: step to any neighbour that has a path
    for (let k = 0; k < 8; k++) {
      const ii = i + NAV_NB[k][0], jj = j + NAV_NB[k][1];
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
      const n = jj * N + ii;
      if (!NAV.blocked[n] && NAV.dist[n] < bd) { bd = NAV.dist[n]; best = n; }
    }
  } else {
    for (let k = 0; k < 8; k++) {
      const ii = i + NAV_NB[k][0], jj = j + NAV_NB[k][1];
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
      const n = jj * N + ii;
      if (NAV.blocked[n]) continue;
      if (k >= 4 && (NAV.blocked[j * N + ii] || NAV.blocked[jj * N + i])) continue;
      if (NAV.dist[n] < bd) { bd = NAV.dist[n]; best = n; }
    }
  }
  if (best < 0 || bd === Infinity) return false;
  navCellCenter(best, _navC);
  const dx = _navC.x - x, dz = _navC.z - z, l = Math.hypot(dx, dz) || 1;
  out.x = dx / l; out.z = dz / l;
  return true;
}
function navReachable(x, z) {
  const c = navCell(x, z);
  return c >= 0 && !NAV.blocked[c] && NAV.dist[c] < Infinity;
}
