// ============ PURE CORE LOGIC (engine-free, headless-testable) ============
'use strict';
// Everything in this file is a pure function of its arguments: no THREE, no DOM,
// no reads of game globals. That is the whole point — it runs unchanged inside the
// single-file browser build AND under `node --test` (see tests/test_core.js), so
// gameplay rules can have real behavioural regression tests instead of the
// source-text greps that used to stand in for them.
//
// Colliders are plain AABBs: { min: {x,y,z}, max: {x,y,z} }. THREE.Vector3 already
// satisfies that shape, so the live `colliders[]` array can be passed in directly.
const CORE = (function () {
  function _isNum(v) { return typeof v === 'number' && isFinite(v); }
  function _isPos(v) { return typeof v === 'number' && v > 0 && isFinite(v); }
  function _isNonNeg(v) { return typeof v === 'number' && v >= 0 && isFinite(v); }
  function _isObj(o) { return Boolean(o && typeof o === 'object'); }
  function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // ---- Distances -------------------------------------------------------------
  // The player's position vector is anchored at EYE height (1.7 m) while enemies
  // are anchored at their feet (y = 0). Comparing a 3-D distance against a
  // horizontal stop/reach radius therefore reads ~1.7 m of pure height as though
  // it were separation, which let enemies walk into the player's body. Every
  // gameplay radius check must use horizontal distance.
  function horizDist(ax, az, bx, bz) {
    const dx = ax - bx, dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
  }
  function horizDistSq(ax, az, bx, bz) {
    const dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }

  // ---- Reach --------------------------------------------------------------------
  // BUG-02 made every gameplay radius HORIZONTAL, because player.pos sits at eye
  // height and a 3-D distance read 1.7 m of pure height as separation, letting
  // enemies stand inside the player. That fix was right and is still right for the
  // push-out.
  //
  // It is only half the answer for REACH. Horizontal-only means vertical separation
  // is invisible, so an agent standing on the ground floor is "in melee range" of a
  // player on the second-floor slab 5.85 m above it — measured — and swings through
  // the concrete with no line of sight involved at all. Reach needs both: close
  // horizontally AND on roughly the same level.
  //
  // The vertical allowance is deliberately generous. An agent on a crate or a step
  // must still be able to hit a player beside it; only a whole storey should break
  // contact.
  const REACH_MAX_VERT = 2.0;
  function withinReach(horizDist, vertGap, reach, maxVert) {
    if (!(horizDist <= reach)) return false;
    const v = maxVert === undefined ? REACH_MAX_VERT : maxVert;
    return Math.abs(vertGap) <= v;
  }

  // ---- Movement integration --------------------------------------------------
  // Collision is discrete AABB overlap, not swept, so a single large step can
  // teleport straight through a thin wall. Splitting the step keeps per-substep
  // travel below `maxStep`, which must stay under the thinnest collidable wall
  // (0.8 m in this arena).
  function subStepCount(speed, dt, maxStep) {
    const travel = Math.abs(speed) * dt;
    if (!(travel > maxStep)) return 1;
    const n = Math.ceil(travel / maxStep);
    return n > MAX_SUBSTEPS ? MAX_SUBSTEPS : n;
  }
  const MAX_SUBSTEPS = 8;

  // Return how many automatic-fire deadlines are due and the next deadline after
  // them. Keeping this pure makes the schedule testable without a browser frame.
  function advanceShotSchedule(now, nextShot, interval, maxShots) {
    if (!(isFinite(now) && isFinite(nextShot) && isFinite(interval) && interval > 0)) {
      return { shots: 0, nextShot };
    }
    if (now < nextShot) return { shots: 0, nextShot };
    const due = Math.floor((now - nextShot) / interval + 1e-9) + 1;
    const limit = isFinite(maxShots) ? Math.max(0, Math.floor(maxShots)) : due;
    const shots = Math.min(due, limit);
    return { shots, nextShot: nextShot + shots * interval };
  }

  // Render time may jump by seconds when a tab is backgrounded or the GPU stalls.
  // Keep the fire clock responsive without feeding the physics loop that wall time.
  function fireClockStep(dt, maxStep) {
    if (!(isFinite(dt) && isFinite(maxStep) && maxStep > 0)) return 0;
    return Math.min(Math.max(0, dt), maxStep);
  }

  // A released trigger, reload, or weapon switch is inactive time, not a render
  // stall. The next held-fire burst must begin with its normal immediate shot.
  function shotScheduleAfterInactive() { return 0; }

  // Mobile virtual joystick auto-sprint threshold. Full forward tilt automatically
  // sprints when moving fast enough; ease the stick back to walk.
  const JOYSTICK_SPRINT_FORWARD = 0.72;
  const JOYSTICK_SPRINT_MAGNITUDE = 0.82;
  function isAutoSprint(moveX, moveZ, ads) {
    if (ads) return false;
    if (!_isNum(moveX) || !_isNum(moveZ)) return false;
    return moveZ > JOYSTICK_SPRINT_FORWARD && Math.hypot(moveX, moveZ) > JOYSTICK_SPRINT_MAGNITUDE;
  }

  // Mobile virtual joystick coordinate and deadzone resolution. Clamps touch
  // displacement within the base radius and maps screen delta to yaw-relative
  // movement axes (negative dy = forward = +z). Inputs within the deadzone are
  // zeroed to prevent drift while keeping visual stick displacement responsive.
  const JOYSTICK_RADIUS = 56;
  const JOYSTICK_DEADZONE = 0.12;
  function joystickInput(dx, dy, radius, deadzone) {
    if (!_isNum(dx) || !_isNum(dy)) {
      return { clampedX: 0, clampedY: 0, moveX: 0, moveZ: 0 };
    }
    const r = _isPos(radius) ? radius : JOYSTICK_RADIUS;
    const dz = _isNonNeg(deadzone) ? deadzone : JOYSTICK_DEADZONE;
    const d = Math.hypot(dx, dy);
    let cx = dx, cy = dy;
    if (d > r && d > 0) {
      cx = (dx / d) * r;
      cy = (dy / d) * r;
    }
    const nx = cx / r;
    const ny = cy / r;
    let moveX = nx;
    let moveZ = -ny;
    if (Math.abs(moveX) < dz) moveX = 0;
    if (Math.abs(moveZ) < dz) moveZ = 0;
    return { clampedX: cx, clampedY: cy, moveX, moveZ };
  }

  // Mobile virtual joystick discrete movement key resolution. Maps analog movement axes
  // to digital WASD keys based on directional threshold, avoiding allocation churn via
  // an optional reusable output object.
  const JOYSTICK_MOVE_THRESHOLD = 0.15;
  function touchMovementKeys(moveX, moveZ, threshold, out) {
    const th = _isNonNeg(threshold) ? threshold : JOYSTICK_MOVE_THRESHOLD;
    const mx = _isNum(moveX) ? moveX : 0;
    const mz = _isNum(moveZ) ? moveZ : 0;
    const res = _isObj(out) ? out : { w: false, s: false, a: false, d: false };
    res.w = mz > th;
    res.s = mz < -th;
    res.d = mx > th;
    res.a = mx < -th;
    return res;
  }

  function gyroLookDelta(betaDelta, gammaDelta, sensitivity, out) {
    const b = _isNum(betaDelta) ? betaDelta : 0;
    const g = _isNum(gammaDelta) ? gammaDelta : 0;
    const s = _isNum(sensitivity) ? sensitivity : 1;
    const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
    const result = _isObj(out) ? out : {};
    result.yaw = -wrap(g) * s;
    result.pitch = -wrap(b) * s;
    return result;
  }
  function gyroScreenLookDelta(betaDelta, gammaDelta, screenAngle, sensitivity, out) {
    const angle = ((Number(screenAngle) || 0) % 360 + 360) % 360;
    if (angle >= 45 && angle < 135) return gyroLookDelta(gammaDelta, betaDelta, sensitivity, out);
    if (angle >= 225 && angle < 315) return gyroLookDelta(-gammaDelta, -betaDelta, sensitivity, out);
    if (angle >= 135 && angle < 225) return gyroLookDelta(-betaDelta, -gammaDelta, sensitivity, out);
    return gyroLookDelta(betaDelta, gammaDelta, sensitivity, out);
  }

  // Ceiling resolve. The old code zeroed upward velocity on a head bonk but never
  // repositioned, so the head stayed inside the slab: a big enough dt or a boosted
  // slide-jump would carry it through (BUG-11). Clamp the eye down so the head sits
  // under the ceiling — but never below where the floor puts it, or a gap shorter
  // than the player would sink the camera into the ground. Standing wins over
  // clearing. `ceilY` is Infinity when nothing is overhead.
  function ceilingClamp(eyeY, floorY, ceilY, eyeH, headClear) {
    if (!isFinite(ceilY)) return eyeY;
    const maxEye = ceilY - headClear;
    const floorEye = floorY + eyeH;
    return Math.min(eyeY, Math.max(maxEye, floorEye));
  }

  // ---- Shadow budget ---------------------------------------------------------
  // Every shadow-casting enemy is drawn a second time in the shadow pass, so at a
  // wave-15 load the soldiers alone cost ~28 extra draw calls — more than the whole
  // static arena. A soldier 40 m away casts a shadow a few pixels across, so the
  // pass is budgeted to the nearest few and the rest are dropped. Returns the
  // indices that should cast, nearest first.
  function shadowCasters(positions, px, pz, budget, out, distsOut) {
    const n = positions ? positions.length : 0;
    const res = out || [];
    res.length = 0;
    if (n === 0 || budget <= 0) return res;
    for (let i = 0; i < n; i++) res.push(i);
    if (n <= budget) return res;
    const d = distsOut || new Array(n);
    for (let i = 0; i < n; i++) d[i] = horizDistSq(positions[i].x, positions[i].z, px, pz);
    res.sort(function (a, b) { return d[a] - d[b]; });
    res.length = budget;
    return res;
  }

  // ---- Ballistics ------------------------------------------------------------
  // Smooth ramp instead of the old binary cliff, which dropped an M4 from 26 to
  // 16.9 damage across a single metre at 0.6 x range with no feedback.
  function distanceFalloff(dist, range, minMul, kneeFrac) {
    const knee = (kneeFrac === undefined ? 0.6 : kneeFrac) * range;
    const floor = minMul === undefined ? 0.65 : minMul;
    if (dist <= knee) return 1;
    if (dist >= range) return floor;
    const t = (dist - knee) / (range - knee);
    return 1 + (floor - 1) * t;
  }

  const FALLOFF_SMG_KNEE = 0.38;
  const FALLOFF_SMG_MIN_MUL = 0.45;
  const FALLOFF_AR_KNEE = 0.58;
  const FALLOFF_AR_MIN_MUL = 0.65;
  const FALLOFF_BR_KNEE = 0.72;
  const FALLOFF_BR_MIN_MUL = 0.78;
  const FALLOFF_SR_KNEE = 0.85;
  const FALLOFF_SR_MIN_MUL = 0.90;

  function weaponFalloffParams(weaponType) {
    const t = String(weaponType || '').toUpperCase();
    if (t === 'SMG') return { kneeFrac: FALLOFF_SMG_KNEE, minMul: FALLOFF_SMG_MIN_MUL };
    if (t === 'AR') return { kneeFrac: FALLOFF_AR_KNEE, minMul: FALLOFF_AR_MIN_MUL };
    if (t === 'BR') return { kneeFrac: FALLOFF_BR_KNEE, minMul: FALLOFF_BR_MIN_MUL };
    if (t === 'SR') return { kneeFrac: FALLOFF_SR_KNEE, minMul: FALLOFF_SR_MIN_MUL };
    return { kneeFrac: 0.6, minMul: 0.65 };
  }

  function weaponDistanceFalloff(weaponType, dist, range) {
    const p = weaponFalloffParams(weaponType);
    return distanceFalloff(dist, range, p.minMul, p.kneeFrac);
  }


  // ---- Wave scaling ----------------------------------------------------------
  function waveEnemyCount(n, baseCount, growth) {
    return Math.round(baseCount + (n - 1) * growth);
  }
  function waveHpMultiplier(n, perWave, cap) {
    const p = perWave === undefined ? 0.06 : perWave;
    const c = cap === undefined ? 2.2 : cap;
    return Math.min(c, 1 + p * (Math.max(1, n) - 1));
  }
  function waveRangedAccuracy(n, base, perWave, max) {
    return Math.min(max, base + n * perWave);
  }

  // ---- Wave-clear score bonus -------------------------------------------------
  // The flat `CFG.score.waveClear` rewards clearing any wave. The per-wave ramp
  // (`waveNum * WAVE_SCORE_PER_WAVE`) increases the reward for surviving deeper
  // into the run, giving the score curve a meaningful slope without compressing
  // early waves. Magic number extracted here so the test suite can pin it.
  const WAVE_SCORE_PER_WAVE = 50;
  function waveClearScore(baseScore, waveNum, perWave) {
    const base = _isNonNeg(baseScore) ? baseScore : 0;
    const w = _isNonNeg(waveNum) ? Math.floor(waveNum) : 0;
    const p = _isNonNeg(perWave) ? perWave : WAVE_SCORE_PER_WAVE;
    return base + w * p;
  }

  // ---- Wave resupply ammo recovery -------------------------------------------
  // Each wave clear tops up reserves by `RESUPPLY_MAG_RATIO` mags, capped at the
  // weapon's reserveMax. The ratio is extracted here so it can be referenced in
  // tests and tuned in one place without touching the HUD module.
  const RESUPPLY_MAG_RATIO = 2.5;
  function waveResupplyAmmo(currentReserve, reserveMax, magSize, ratio) {
    const cur = _isNonNeg(currentReserve) ? currentReserve : 0;
    const max = _isNonNeg(reserveMax) ? reserveMax : 0;
    const mag = _isPos(magSize) ? magSize : 0;
    const r = _isPos(ratio) ? ratio : RESUPPLY_MAG_RATIO;
    return Math.min(max, cur + Math.round(mag * r));
  }

  // ---- AABB helpers ----------------------------------------------------------
  function aabbOverlapsXZ(c, x, z, r) {
    return x > c.min.x - r && x < c.max.x + r && z > c.min.z - r && z < c.max.z + r;
  }
  // Fast horizontal AABB resolve: tests if position (x, z) with radius r overlaps
  // collider c, and resolves the minimum pushout along the x or z axis.
  // When out is provided, mutates and returns out without allocating memory;
  // otherwise returns a new { axis, val } descriptor, or null if no overlap.
  function resolveAabbXZ(x, z, r, c, out) {
    if (!c || !c.min || !c.max) return null;
    const rad = _isPos(r) ? r : 0;
    if (x <= c.min.x - rad || x >= c.max.x + rad || z <= c.min.z - rad || z >= c.max.z + rad) return null;
    const cx = (c.min.x + c.max.x) * 0.5;
    const cz = (c.min.z + c.max.z) * 0.5;
    const px = x >= cx ? (c.max.x + rad - x) : (x - (c.min.x - rad));
    const pz = z >= cz ? (c.max.z + rad - z) : (z - (c.min.z - rad));
    const axis = px < pz ? 'x' : 'z';
    const val = px < pz ? (x >= cx ? c.max.x + rad : c.min.x - rad) : (z >= cz ? c.max.z + rad : c.min.z - rad);
    if (_isObj(out)) {
      out.axis = axis;
      out.val = val;
      return out;
    }
    return { axis, val };
  }
  // Vertical collider query: scans colliders overlapping (x, z) with radius r.
  // Finds the highest floor surface below feet + stepH, and the lowest ceiling slab above feet.
  // When out is provided, mutates and returns out without heap allocation;
  // otherwise returns a new { floorY, ceilY } object.
  function resolveVerticalBounds(x, z, r, colliders, feet, stepH, groundY, out) {
    let floorY = (_isNum(groundY)) ? groundY : 0;
    let ceilY = Infinity;
    if (!colliders || !colliders.length) {
      if (_isObj(out)) { out.floorY = floorY; out.ceilY = ceilY; return out; }
      return { floorY, ceilY };
    }
    const rad = _isPos(r) ? r : 0;
    const maxStepY = feet + (_isNum(stepH) ? stepH : 0.6);
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c || !c.min || !c.max) continue;
      if (x <= c.min.x - rad || x >= c.max.x + rad || z <= c.min.z - rad || z >= c.max.z + rad) continue;
      if (c.max.y <= maxStepY && c.max.y > floorY) floorY = c.max.y;
      if (c.min.y > feet && c.min.y < ceilY) ceilY = c.min.y;
    }
    if (_isObj(out)) {
      out.floorY = floorY;
      out.ceilY = ceilY;
      return out;
    }
    return { floorY, ceilY };
  }
  // Fast floor-only resolver for grounding agents without tracking ceiling clearance.
  function findFloorY(x, z, r, colliders, feet, stepH, groundY) {
    let floorY = (_isNum(groundY)) ? groundY : 0;
    if (!colliders || !colliders.length) return floorY;
    const rad = _isPos(r) ? r : 0;
    const maxStepY = feet + (_isNum(stepH) ? stepH : 0.6);
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c || !c.min || !c.max) continue;
      if (x <= c.min.x - rad || x >= c.max.x + rad || z <= c.min.z - rad || z >= c.max.z + rad) continue;
      if (c.max.y <= maxStepY && c.max.y > floorY) floorY = c.max.y;
    }
    return floorY;
  }
  // Headroom check before standing up from a crouch: ensures no obstacle slab sits between
  // the player's crouched eye level and standing height.
  function hasCrouchHeadroom(x, z, r, eyeY, standHeight, colliders) {
    if (!colliders || !colliders.length) return true;
    const feet = eyeY - standHeight;
    const top = eyeY + 0.15;
    const bottom = feet + 0.2;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c || !c.min || !c.max) continue;
      if (c.min.y < top && c.max.y > bottom) {
        if (aabbOverlapsXZ(c, x, z, r)) return false;
      }
    }
    return true;
  }
  // True when an AABB blocks a ground-bound walker of the given height: it must
  // rise above what the walker can step onto, and start below the walker's head.
  function blocksWalker(c, stepH, walkerHeight) {
    return c.max.y > stepH && c.min.y < walkerHeight;
  }
  // A spawn point is valid when nothing solid occupies it.
  function isSpawnValid(x, z, colliders, stepH, walkerHeight, clearance) {
    const r = clearance === undefined ? 0.5 : clearance;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!blocksWalker(c, stepH, walkerHeight)) continue;
      if (aabbOverlapsXZ(c, x, z, r)) return false;
    }
    return true;
  }

  // True when an obstacle AABB is relevant for horizontal collision resolution.
  // Rejects colliders entirely above head height, low curbs below step-up height,
  // or slabs underneath feet.
  function isColliderRelevantXZ(cMinY, cMaxY, feetY, headY, stepH) {
    if (!_isNum(cMinY) || !_isNum(cMaxY)) return false;
    const step = _isNonNeg(stepH) ? stepH : 0.6;
    const feet = _isNum(feetY) ? feetY : 0;
    const head = _isNum(headY) ? headY : feet + 1.8;
    if (cMinY >= head + 0.2) return false;
    if (cMaxY <= feet + step) return false;
    if (feet >= cMaxY - 0.001) return false;
    return true;
  }

  // ---- Settings ---------------------------------------------------------------
  // Schema-driven so the UI, the persistence layer and the validator cannot drift
  // apart. Stored values are never trusted: localStorage is editable, survives
  // across versions, and a bad number here would silently break aiming or audio.
  const SETTINGS_SCHEMA = {
    sensitivity: { type: 'number', def: 1.0, min: 0.2, max: 4.0, step: 0.05, label: 'Mouse sensitivity' },
    touchSensitivity: { type: 'number', def: 1.0, min: 0.4, max: 3.0, step: 0.1, label: 'Touch look sensitivity' },
    gyroSensitivity: { type: 'number', def: 1.0, min: 0.2, max: 4.0, step: 0.1, label: 'Gyroscope sensitivity', help: 'Adjusts phone-tilt aiming independently of touch look.' },
    gyroAim: { type: 'bool', def: false, label: 'Gyroscope aiming', help: 'Turn your phone to aim. Enable on this device; sensor access may require permission.' },
    touchLayout: { type: 'enum', def: 'standard', values: ['standard', 'left-handed', 'large buttons'], label: 'Mobile button layout' },
    fireMode: { type: 'enum', def: 'fire', values: ['fire', 'ads + fire'], label: 'FIRE button mode' },
    fireLook: { type: 'bool', def: true, label: 'ADS button for rotation' },
    invertY: { type: 'bool', def: false, label: 'Invert vertical look' },
    fov: { type: 'number', def: 72, min: 60, max: 100, step: 1, label: 'Field of view' },
    masterVolume: { type: 'number', def: 0.9, min: 0, max: 1, step: 0.05, label: 'Master volume' },
    musicVolume: { type: 'number', def: 0.5, min: 0, max: 1, step: 0.05, label: 'Music & ambience' },
    muted: { type: 'bool', def: false, label: 'Mute all audio' },
    quality: { type: 'enum', def: 'auto', values: ['low', 'medium', 'high', 'auto'], label: 'Graphics quality' },
    enemyDetail: { type: 'enum', def: 'auto', values: ['auto', 'simple', 'detailed'], label: 'Enemy detail (reload page)', help: 'Detailed soldiers cost more draw calls. Reload the page to apply; current enemies are not rebuilt.' },
    sceneryDetail: { type: 'enum', def: 'auto', values: ['auto', 'simple', 'detailed'], label: 'Scenery detail (reload page)', help: 'Detailed GLB props use more GPU memory and draw calls. Reload the page to apply; cover and collisions stay the same.' },
    effects: { type: 'enum', def: 'auto', values: ['auto', 'off', 'reduced', 'full'], label: 'Particles & effect lights', help: 'Applies now. Full enables 2600 particle slots and two flash lights; reduced uses 900 slots without lights. Off hides decorative particles, not gameplay smoke or fire hazards.' },
    ragdollQuality: { type: 'enum', def: 'auto', values: ['auto', 'off', 'reduced', 'full'], label: 'Ragdoll budget', help: 'Applies now; lowering retires the oldest corpses. Reduced keeps 3 corpses, full 6; physics and draw calls cost CPU/GPU time.' },
    shadowQuality: { type: 'enum', def: 'auto', values: ['auto', 'off', 'reduced', 'high'], label: 'Shadow quality', help: 'Applies now. High uses a 2048 map, filtered shadows and 8 enemy casters; reduced uses 1024 and 4. Auto follows quality and device defaults.' },
    postProcessing: { type: 'enum', def: 'auto', values: ['auto', 'off', 'on'], label: 'Bloom & colour grading', help: 'Applies now. On enables extra fullscreen GPU passes even on touch devices or low quality. Off frees render targets.' },
    reducedMotion: { type: 'bool', def: false, label: 'Reduce camera motion' },
    colorblindMarkers: { type: 'bool', def: false, label: 'High-contrast enemy markers' },
    showFps: { type: 'bool', def: true, label: 'Show FPS counter' },
    gameMode: { type: 'enum', def: 'survival', values: ['survival', 'tdm', 'ffa', 'domination', 'gun-game'], label: 'Game mode' },
    gameMap: { type: 'enum', def: 'urban', values: ['urban', 'snowy'], label: 'Arena map' },
    tdmTeamSize: { type: 'number', def: 6, min: 2, max: 8, step: 1, label: 'TDM team size' },
    tdmScoreLimit: { type: 'number', def: 75, min: 2, max: 200, step: 1, label: 'TDM score limit' },
    ffaActorCount: { type: 'number', def: 8, min: 2, max: 8, step: 1, label: 'FFA actors' },
    ffaScoreLimit: { type: 'number', def: 30, min: 2, max: 100, step: 1, label: 'FFA score limit' },
    dominationScoreLimit: { type: 'number', def: 200, min: 50, max: 500, step: 25, label: 'Domination score limit' },
    gunGameActorCount: { type: 'number', def: 8, min: 2, max: 8, step: 1, label: 'Gun Game actors' }
  };

  function defaultSettings() {
    const out = {};
    for (const k in SETTINGS_SCHEMA) out[k] = SETTINGS_SCHEMA[k].def;
    return out;
  }

  function clampSetting(key, value) {
    const spec = SETTINGS_SCHEMA[key];
    if (!spec) return undefined;
    if (spec.type === 'bool') {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return spec.def;
    }
    if (spec.type === 'enum') {
      return spec.values.indexOf(value) >= 0 ? value : spec.def;
    }
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(n)) return spec.def;
    return Math.min(spec.max, Math.max(spec.min, n));
  }

  // Merge stored values over the defaults, dropping anything unknown or invalid.
  function sanitizeSettings(stored) {
    const out = defaultSettings();
    if (!stored || typeof stored !== 'object') return out;
    for (const k in SETTINGS_SCHEMA) {
      if (Object.prototype.hasOwnProperty.call(stored, k)) out[k] = clampSetting(k, stored[k]);
    }
    return out;
  }

  // Resolve the renderer state for a quality preset without touching browser or
  // THREE globals. `auto` deliberately has a concrete baseline: switching from
  // low must restore shadows before the adaptive frame loop starts sampling FPS.
  function qualityRenderSettings(quality, devicePixelRatio, isTouch) {
    const dpr = isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const q = SETTINGS_SCHEMA.quality.values.indexOf(quality) >= 0 ? quality : 'auto';
    if (q === 'low') return { pixelRatio: Math.min(dpr, 0.7), shadowEnabled: false, shadowType: null };
    if (q === 'medium') return { pixelRatio: Math.min(dpr, 1.0), shadowEnabled: true, shadowType: 'PCFShadowMap' };
    if (q === 'high') return { pixelRatio: Math.min(dpr, 1.75), shadowEnabled: true, shadowType: 'PCFSoftShadowMap' };
    return { pixelRatio: Math.min(dpr, 1.5), shadowEnabled: true, shadowType: isTouch ? 'PCFShadowMap' : 'PCFSoftShadowMap' };
  }

  // Device detection only supplies automatic defaults; explicit graphics choices
  // never depend on the input device. Model detail is latched by browser plumbing.
  function graphicsSettings(settings, isTouch) {
    const s = sanitizeSettings(settings);
    const render = qualityRenderSettings(s.quality, 1, isTouch);
    const effects = s.effects === 'auto' ? (isTouch ? 'reduced' : 'full') : s.effects;
    const ragdoll = s.ragdollQuality === 'auto' ? (isTouch ? 'reduced' : 'full') : s.ragdollQuality;
    const shadow = s.shadowQuality === 'auto'
      ? (!render.shadowEnabled ? 'off' : (isTouch ? 'reduced' : 'high')) : s.shadowQuality;
    return {
      enemyDetailed: s.enemyDetail === 'detailed' || (s.enemyDetail === 'auto' && !isTouch),
      sceneryDetailed: s.sceneryDetail === 'detailed' || (s.sceneryDetail === 'auto' && !isTouch),
      particles: effects === 'off' ? 0 : effects === 'full' ? 2600 : 900,
      flashLights: effects === 'full',
      ragdollMax: ragdoll === 'off' ? 0 : ragdoll === 'full' ? 6 : 3,
      ragdollSimulation: ragdoll === 'off' ? 0 : ragdoll === 'full' ? 10 : 4,
      shadowEnabled: shadow !== 'off',
      shadowSize: shadow === 'high' ? 2048 : 1024,
      shadowExtent: shadow === 'high' ? 38 : 26,
      shadowEnemies: shadow === 'off' ? 0 : shadow === 'high' ? 8 : 4,
      shadowType: s.shadowQuality === 'auto' ? render.shadowType
        : shadow === 'high' ? 'PCFSoftShadowMap' : 'PCFShadowMap',
      anisotropy: s.quality === 'high' || !isTouch ? 8 : 4,
      postfx: s.postProcessing === 'on' || (s.postProcessing === 'auto' && isPostfxWanted(s.quality, isTouch))
    };
  }

  // Pure, opt-in frame-time capture for repeatable benchmarks. It is intentionally
  // not wired into frame(): normal gameplay allocates no samples and does no sort.
  // Samples are milliseconds and the window retains only the most recent values.
  function createFrameTimeTelemetry(options) {
    const opts = _isObj(options) ? options : {};
    const requestedCapacity = Number.isFinite(opts.maxSamples) ? Math.floor(opts.maxSamples) : 300;
    const capacity = Math.max(1, Math.min(10000, requestedCapacity));
    const enabled = opts.enabled === true;
    const values = [];

    function record(frameTimeMs) {
      if (!enabled || typeof frameTimeMs !== 'number' || !Number.isFinite(frameTimeMs)
          || frameTimeMs < 0) return false;
      if (values.length === capacity) values.shift();
      values.push(frameTimeMs);
      return true;
    }
    function samples() { return values.slice(); }
    function percentile(sorted, fraction) {
      if (!sorted.length) return null;
      const index = (sorted.length - 1) * fraction;
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      if (lower === upper) return sorted[lower];
      return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
    }
    function summary() {
      if (!values.length) return { count: 0, capacity, min: null, max: null, p50: null, p95: null };
      const sorted = values.slice().sort(function (a, b) { return a - b; });
      return {
        count: sorted.length,
        capacity,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95)
      };
    }
    return { enabled, capacity, record, samples, summary };
  }

  // Runtime wrapper keeps the capture opt-in while allowing the main loop to
  // expose a safe, read-only snapshot for probes and local performance checks.
  function createRuntimeTelemetry(options) {
    const opts = _isObj(options) ? options : {};
    let active = opts.enabled === true;
    const capture = createFrameTimeTelemetry({ enabled: true, maxSamples: opts.maxSamples });
    function record(frameTimeMs) { return active && capture.record(frameTimeMs); }
    function setEnabled(value) { active = value === true; return active; }
    function snapshot() {
      return { enabled: active, summary: capture.summary(), samples: capture.samples() };
    }
    return { get enabled() { return active; }, capacity: capture.capacity,
      record, setEnabled, snapshot };
  }

  // Pure continuous swept-sphere motion for grenade regressions and runtime use.
  // A bounded contact loop consumes the unspent fraction after every impact.
  function stepGrenadeMotion(state, dt, boxes, options) {
    const opts = _isObj(options) ? options : {};
    const bounce = Number.isFinite(opts.bounce) ? _clamp01(opts.bounce) : 0.35;
    const maxContacts = Number.isFinite(opts.maxContacts) ? Math.max(1, Math.floor(opts.maxContacts)) : 4;
    let remaining = Math.max(0, Number(dt) || 0), contacts = 0;
    const p = state.position, v = state.velocity;
    while (remaining > 1e-7 && contacts < maxContacts) {
      const end = { x: p.x + v.x * remaining, y: p.y + v.y * remaining, z: p.z + v.z * remaining };
      const hit = sweepGrenade(p, end, opts.radius === undefined ? 0.11 : opts.radius, boxes || []);
      if (!hit) { p.x = end.x; p.y = end.y; p.z = end.z; break; }
      const t = _clamp01(hit.t);
      p.x += (end.x - p.x) * t; p.y += (end.y - p.y) * t; p.z += (end.z - p.z) * t;
      const push = (hit.initialOverlap ? hit.pushOut : 0) + 0.001;
      p.x += hit.normal.x * push; p.y += hit.normal.y * push; p.z += hit.normal.z * push;
      const vn = v.x * hit.normal.x + v.y * hit.normal.y + v.z * hit.normal.z;
      if (vn < 0) {
        const impulse = (1 + bounce) * vn;
        v.x -= impulse * hit.normal.x; v.y -= impulse * hit.normal.y; v.z -= impulse * hit.normal.z;
      }
      remaining *= (1 - t);
      contacts++;
      if (t < 1e-7) remaining = Math.max(0, remaining - 1e-6);
    }
    return { contacts, remaining };
  }

  // Effective look sensitivity in radians per pixel of mouse movement.
  const BASE_SENSITIVITY = 0.0022;
  function lookSensitivity(settingsSensitivity, adsAmount) {
    const ads = adsAmount > 0.5 ? 0.6 : 1;
    return BASE_SENSITIVITY * settingsSensitivity * ads;
  }

  // ---- Adaptive music -----------------------------------------------------
  // One number, 0..1, describing how much trouble the player is in. The audio
  // layer maps it to filter cutoff, pulse tempo and tension-voice gain, so the
  // soundtrack follows the fight instead of looping regardless of it.
  function combatIntensity(state) {
    if (!state || !state.inCombat) return 0;
    // Sanitise first: Math.min/Math.max propagate NaN rather than clamping it, and
    // a NaN here would silently pin the music gain to NaN for the rest of the run.
    const num = function (v, def) {
      const n = typeof v === 'number' ? v : parseFloat(v);
      return isFinite(n) ? n : def;
    };
    const clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
    const enemyLoad = clamp01(num(state.aliveEnemies, 0) / 8);
    const proximity = state.nearestEnemy === undefined ? 0
      : clamp01(1 - (num(state.nearestEnemy, 99) - 4) / 26);
    const hurt = 1 - clamp01(num(state.health, 100) / 100);
    // Enemy pressure dominates; being hurt or crowded pushes it to the top.
    return clamp01(enemyLoad * 0.55 + proximity * 0.3 + hurt * 0.35);
  }

  // ---- Sound playback variation -----------------------------------------------
  // ±3% playback rate jitter for percussive sounds that repeat constantly.
  // Breaks up robotic bit-identical repetition across repeated triggers.
  const SOUND_VARIED_RANGE = 0.06;
  function soundPlaybackRate(baseRate, rand) {
    const base = _isNum(baseRate) ? baseRate : 1.0;
    const r = _isNum(rand) ? rand : Math.random();
    return base + (r - 0.5) * SOUND_VARIED_RANGE;
  }

  // ---- Positional spatial audio -----------------------------------------------
  // Pure distance attenuation and stereo panning relative to player orientation.
  // Panning projects sound vector onto player right vector: cos(yaw), -sin(yaw).
  const SPATIAL_AUDIO_MAX_DIST = 55;
  const SPATIAL_AUDIO_PAN_BOOST = 1.4;
  const SPATIAL_AUDIO_MIN_VOL = 0.15;

  function spatialAudioPan(dx, dz, playerYaw, dist, panBoost) {
    const yaw = _isNum(playerYaw) ? playerYaw : 0;
    const d = _isPos(dist) ? dist : Math.hypot(dx, dz);
    if (d < 1e-6) return 0;
    const boost = _isNum(panBoost) ? panBoost : SPATIAL_AUDIO_PAN_BOOST;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const raw = ((dx * rx + dz * rz) / d) * boost;
    return Math.max(-1, Math.min(1, raw));
  }

  function spatialAudioVolume(dist, maxDist, minVol) {
    const maxD = _isPos(maxDist) ? maxDist : SPATIAL_AUDIO_MAX_DIST;
    const minV = _isNum(minVol) ? minVol : SPATIAL_AUDIO_MIN_VOL;
    const d = _isNonNeg(dist) ? dist : 0;
    if (d >= maxD) return 0;
    const norm = 1 - (d / maxD);
    return minV + (1 - minV) * norm * norm;
  }

  const AIR_ABSORPTION_MAX_FREQ = 8000;
  const AIR_ABSORPTION_MIN_FREQ = 500;
  const AIR_ABSORPTION_Q = 0.5;

  function spatialAudioCutoff(dist, maxDist, maxFreq, minFreq) {
    const maxD = _isPos(maxDist) ? maxDist : SPATIAL_AUDIO_MAX_DIST;
    const hi = _isPos(maxFreq) ? maxFreq : AIR_ABSORPTION_MAX_FREQ;
    const lo = _isNonNeg(minFreq) ? minFreq : AIR_ABSORPTION_MIN_FREQ;
    const d = _isNonNeg(dist) ? dist : 0;
    const ratio = _clamp01(d / maxD);
    return hi - (hi - lo) * ratio;
  }

  function isSpatialAudioInRange(dx, dz, maxDist) {
    const maxD = _isPos(maxDist) ? maxDist : SPATIAL_AUDIO_MAX_DIST;
    return (dx * dx + dz * dz) <= (maxD * maxD);
  }

  function spatialAudioParams(dx, dz, playerYaw, maxDist, out) {
    const maxD = _isPos(maxDist) ? maxDist : SPATIAL_AUDIO_MAX_DIST;
    const dSq = dx * dx + dz * dz;
    const maxDSq = maxD * maxD;
    if (dSq > maxDSq) {
      const dist = Math.sqrt(dSq);
      if (_isObj(out)) {
        out.dist = dist; out.pan = 0; out.vol = 0; out.cutoff = AIR_ABSORPTION_MIN_FREQ; out.audible = false;
        return out;
      }
      return { dist, pan: 0, vol: 0, cutoff: AIR_ABSORPTION_MIN_FREQ, audible: false };
    }
    const dist = Math.sqrt(dSq);
    const pan = spatialAudioPan(dx, dz, playerYaw, dist);
    const vol = spatialAudioVolume(dist, maxD);
    const cutoff = spatialAudioCutoff(dist, maxD);
    if (_isObj(out)) {
      out.dist = dist; out.pan = pan; out.vol = vol; out.cutoff = cutoff; out.audible = true;
      return out;
    }
    return { dist, pan, vol, cutoff, audible: true };
  }

  const SPATIAL_EXPLOSION_MAX_DIST = 85;
  const TACTICAL_DETONATION_MAX_DIST_BLIND = 65, TACTICAL_DETONATION_MAX_DIST_SMOKE = 85;

  function spatialExplosionParams(dx, dz, playerYaw) {
    return spatialAudioParams(dx, dz, playerYaw, SPATIAL_EXPLOSION_MAX_DIST);
  }

  function tacticalDetonationSound(effect) {
    if (effect === 'smoke') return 'explosion';
    if (effect === 'blind') return 'headshot';
    return 'pin';
  }

  function tacticalDetonationMaxDist(effect) {
    if (effect === 'smoke') return TACTICAL_DETONATION_MAX_DIST_SMOKE;
    if (effect === 'blind') return TACTICAL_DETONATION_MAX_DIST_BLIND;
    return 45;
  }

  function grenadeContactSound(sticky, velY) {
    if (sticky) return 'pin';
    const vy = (_isNum(velY)) ? Math.abs(velY) : 0;
    if (vy > 1) return 'bounce';
    return null;
  }

  function weaponFireSound(weaponType, isSuppressed) {
    if (isSuppressed) {
      if (weaponType === 'SR') return 'sniper_suppressed';
      if (weaponType === 'SMG') return 'smg_suppressed';
      if (weaponType === 'BR') return 'br_suppressed';
      return 'shot_suppressed';
    }
    if (weaponType === 'SR') return 'sniper';
    if (weaponType === 'SMG') return 'smg';
    if (weaponType === 'BR') return 'br';
    return 'shot';
  }

  function plateInsertSound() {
    return 'plate_insert';
  }

  function plateLockSound() {
    return 'plate_lock';
  }

  const TINNITUS_MIN_THRESHOLD = 0.4;
  const TINNITUS_MAX_DURATION = 4.0;
  const TINNITUS_BASE_GAIN = 0.15;

  function tinnitusSound() {
    return 'tinnitus';
  }

  function shouldTriggerTinnitus(flashT, prevFlashT, minThreshold) {
    const cur = _isNum(flashT) ? flashT : 0;
    const prev = _isNum(prevFlashT) ? prevFlashT : 0;
    const thresh = (_isNum(minThreshold)) ? minThreshold : TINNITUS_MIN_THRESHOLD;
    return prev <= 0 && cur >= thresh;
  }

  function tinnitusVolume(flashT, maxDur, baseGain) {
    const t = _isNum(flashT) ? flashT : 0;
    const maxD = _isPos(maxDur) ? maxDur : TINNITUS_MAX_DURATION;
    const bg = _isNum(baseGain) ? baseGain : TINNITUS_BASE_GAIN;
    if (t <= 0) return 0;
    const ratio = _clamp01(t / maxD);
    return bg * ratio;
  }

  function shouldPlayFleshHurt(healthDamage) {
    if (healthDamage === undefined || healthDamage === null) return true;
    const hd = _isNum(healthDamage) ? healthDamage : 0;
    return hd > 0;
  }

  function playerDamageAcoustics(healthDamage, armorSnd) {
    const playHurt = shouldPlayFleshHurt(healthDamage);
    return {
      armorSound: armorSnd || null,
      playHurt: playHurt
    };
  }

  function armorDamageSound(initialArmor, remainingArmor, absorbedDamage) {
    const init = _isNum(initialArmor) ? initialArmor : 0;
    const rem = _isNum(remainingArmor) ? remainingArmor : 0;
    if (init <= 0) return null;
    if (absorbedDamage !== undefined && _isNum(absorbedDamage) && absorbedDamage <= 0) return null;
    if (rem <= 0) return 'armor_break';
    return 'block';
  }

  function killConfirmationSound(isHead, isElite, isTank) {
    if (isElite) return KILL_ELITE_SOUND;
    if (isTank) return KILL_HEAVY_SOUND;
    if (isHead) return KILL_HEADSHOT_SOUND;
    return KILL_SOUND;
  }

  // Multi-kill streak window (seconds) and cap
  const MK_WINDOW = 4;
  const MK_MAX_STREAK = 5;

  function advanceKillStreak(streak, lastKillTime, now, windowSec) {
    const w = _isPos(windowSec) ? windowSec : MK_WINDOW;
    const cur = _isNonNeg(streak) ? Math.floor(streak) : 0;
    const last = _isNum(lastKillTime) ? lastKillTime : -99;
    const t = _isNum(now) ? now : 0;
    let next = (t - last <= w) ? cur + 1 : 1;
    if (next > MK_MAX_STREAK) next = 0;
    return next;
  }

  function multikillLabel(streak) {
    if (streak === 2) return 'DOUBLE KILL';
    if (streak === 3) return 'TRIPLE KILL';
    if (streak === 4) return 'QUAD KILL';
    if (streak === 5) return 'RAMPAGE';
    return null;
  }

  function multikillSound(streak) {
    if (streak >= 2 && streak <= 5) return 'multikill';
    return null;
  }

  // Scorestreak & Field Upgrade Audio
  const SENTRY_AUDIO_MAX_DIST = 65;

  function streakActivationSound(streakKey) {
    if (streakKey === 'uav') return 'streak_uav';
    if (streakKey === 'airstrike') return 'streak_airstrike';
    if (streakKey === 'sentry') return 'streak_sentry';
    return 'wave';
  }

  function fieldUpgradeSound(isDeploy) {
    return isDeploy ? 'munitions' : 'munitions_resupply';
  }

  function sentryFireSound() {
    return 'sentry_shot';
  }

  function canMunitionsResupply(hasAmmoNeed, hasGrenadeNeed, hasTacticalNeed) {
    return !!(hasAmmoNeed || hasGrenadeNeed || hasTacticalNeed);
  }

  // Tactical Mobility & Movement Audio
  const FOOTSTEP_BASE_CADENCE = 1.0;
  const FOOTSTEP_SPRINT_CADENCE = 1.6;
  const FOOTSTEP_TAC_SPRINT_CADENCE = 2.0;
  const FOOTSTEP_CROUCH_CADENCE = 0.65;
  const FOOTSTEP_MIN_SPEED = 1.5;

  function mantleSound() {
    return 'mantle';
  }

  function slideStartSound() {
    return 'slide';
  }

  function footstepCadence(isSprinting, isTacSprint, isCrouching) {
    if (isCrouching) return FOOTSTEP_CROUCH_CADENCE;
    if (isTacSprint) return FOOTSTEP_TAC_SPRINT_CADENCE;
    if (isSprinting) return FOOTSTEP_SPRINT_CADENCE;
    return FOOTSTEP_BASE_CADENCE;
  }

  function playerFootstepSound(isCrouching, isTacSprint) {
    if (Boolean(isCrouching)) return 'step_crouch';
    if (Boolean(isTacSprint)) return 'step_tac';
    return 'step';
  }

  function shouldPlayFootstep(onGround, horizontalSpeed, minSpeed) {
    const minSpd = _isNonNeg(minSpeed) ? minSpeed : FOOTSTEP_MIN_SPEED;
    const spd = _isNum(horizontalSpeed) ? horizontalSpeed : 0;
    return Boolean(onGround && spd > minSpd);
  }

  // ---- Persistent career stats ------------------------------------------------
  function defaultStats() {
    return { bestScore: 0, bestWave: 0, bestAccuracy: 0, runs: 0, totalKills: 0,
             xp: 0, totalHeadshots: 0, totalStreaks: 0 };
  }
  function sanitizeStats(stored) {
    const out = defaultStats();
    if (!stored || typeof stored !== 'object') return out;
    for (const k in out) {
      const n = typeof stored[k] === 'number' ? stored[k] : parseFloat(stored[k]);
      if (isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  }
  // Returns the updated stats plus which records were beaten, so the UI can say so.
  function resumeCheckpointState(runPhase) {
    const phase = runPhase === 'victory' || runPhase === 'endless' ? runPhase : 'active';
    return { phase, gameEnded: phase === 'victory', showVictory: phase === 'victory' };
  }
  // Separate one-time rewards from the current run's absolute record candidates.
  // Endless continuation must not re-award the settled finite victory, but its later
  // wave and accuracy still need to compete for career records.
  function settlementAccounting(snapshot, current) {
    const run = current || {};
    const records = {
      score: run.score || 0, wave: run.wave || 0, accuracy: run.accuracy || 0
    };
    if (!snapshot || typeof snapshot !== 'object') {
      return { rewards: {
        score: records.score, wave: records.wave, accuracy: records.accuracy,
        kills: run.kills || 0, headshots: run.headshots || 0, streaks: run.streaks || 0
      }, records };
    }
    return { rewards: {
      score: Math.max(0, records.score - (snapshot.score || 0)), wave: 0, accuracy: 0,
      kills: Math.max(0, (run.kills || 0) - (snapshot.kills || 0)),
      headshots: Math.max(0, (run.headshots || 0) - (snapshot.headshots || 0)),
      streaks: Math.max(0, (run.streaks || 0) - (snapshot.streaks || 0))
    }, records };
  }
  function mergeRunIntoStats(stats, run) {
    const next = sanitizeStats(stats);
    const beat = { score: false, wave: false, accuracy: false };
    const recordScore = _isNum(run.recordScore) ? run.recordScore : run.score;
    const recordWave = _isNum(run.recordWave) ? run.recordWave : run.wave;
    const recordAccuracy = _isNum(run.recordAccuracy) ? run.recordAccuracy : run.accuracy;
    if (recordScore > next.bestScore) { next.bestScore = recordScore; beat.score = true; }
    if (recordWave > next.bestWave) { next.bestWave = recordWave; beat.wave = true; }
    if (recordAccuracy > next.bestAccuracy) { next.bestAccuracy = recordAccuracy; beat.accuracy = true; }
    // Endless continuation is still the same career run; callers mark its
    // incremental settlement with countRun:false to avoid double-counting it.
    if (run.countRun !== false) next.runs = next.runs + 1;
    next.totalKills = next.totalKills + (run.kills || 0);
    next.totalHeadshots = next.totalHeadshots + (run.headshots || 0);
    next.totalStreaks = next.totalStreaks + (run.streaks || 0);
    // Rank is derived from XP rather than stored, so a corrupted rank cannot exist.
    const rankBefore = rankForXp(next.xp);
    const gained = runXp(run);
    next.xp = next.xp + gained;
    const rankAfter = rankForXp(next.xp);
    beat.rank = rankAfter > rankBefore;
    return { stats: next, beat, xpGained: gained, rank: rankAfter, rankBefore };
  }

  // ---- Meta progression: XP, rank and unlocks -----------------------------------
  // Career stats already survived a reload; nothing was ever unlocked by them, so a
  // second run started exactly like the first. XP is earned from the things the run
  // already counts, and rank gates the weapon roster.
  //
  // A quadratic curve rather than a flat one: early ranks arrive fast enough to be
  // felt in the first two runs, and the last ones take long enough to still mean
  // something.
  const MAX_RANK = 20;
  const XP_BASE = 900;
  function xpForRank(rank) {
    if (rank <= 1) return 0;
    const r = rank - 1;
    return Math.round(XP_BASE * r * (1 + r * 0.22));
  }
  function rankForXp(xp) {
    const x = xp > 0 ? xp : 0;
    let r = 1;
    while (r < MAX_RANK && x >= xpForRank(r + 1)) r++;
    return r;
  }
  // Progress toward the NEXT rank, for the bar on the menu. At max rank the bar is
  // full rather than empty, which is the difference between "done" and "broken".
  function rankProgress(xp) {
    const rank = rankForXp(xp);
    if (rank >= MAX_RANK) return { rank, into: 1, need: 1, pct: 1, max: true };
    const base = xpForRank(rank), next = xpForRank(rank + 1);
    const into = Math.max(0, xp - base), need = next - base;
    return { rank, into, need, pct: need > 0 ? into / need : 1, max: false };
  }
  // XP from one run. Weighted toward the things that are hard rather than the things
  // that are long: a headshot is worth more than a body shot, and reaching a wave is
  // worth more than farming an early one.
  const XP_PER = { kill: 12, headshot: 8, wave: 90, victory: 900, accuracyBonus: 600 };
  function runXp(run) {
    if (!run) return 0;
    const kills = Math.max(0, run.kills || 0);
    const heads = Math.max(0, run.headshots || 0);
    const wave = Math.max(0, run.wave || 0);
    const acc = Math.max(0, Math.min(100, run.accuracy || 0));
    let xp = kills * XP_PER.kill + heads * XP_PER.headshot;
    // Waves are worth progressively more, so wave 14 is not wave 1 fourteen times.
    xp += XP_PER.wave * wave * (1 + wave * 0.06);
    if (run.victory) xp += XP_PER.victory;
    xp += Math.round(XP_PER.accuracyBonus * (acc / 100) * (acc / 100));
    return Math.round(xp);
  }

  // Weapons unlock by rank. Index matches CFG.weapons; the first two are always
  // available so a new player still has a choice on their first deploy.
  const WEAPON_UNLOCK_RANK = [1, 1, 3, 6, 2, 4, 1];
  function weaponUnlockRank(index) {
    const r = WEAPON_UNLOCK_RANK[index];
    return r === undefined ? 1 : r;
  }
  function weaponUnlocked(index, rank) { return rank >= weaponUnlockRank(index); }

  // ---- Challenges ----------------------------------------------------------------
  // Cheap retention that rides the stats store rather than adding one. Each is a
  // counter with a target; nothing here needs to know how the counter is produced.
  const CHALLENGES = [
    { key: 'kills100',   stat: 'totalKills',   target: 100,  name: 'BODY COUNT',   blurb: '100 hostiles eliminated' },
    { key: 'kills1000',  stat: 'totalKills',   target: 1000, name: 'ATTRITION',    blurb: '1000 hostiles eliminated' },
    { key: 'heads100',   stat: 'totalHeadshots', target: 100, name: 'MARKSMAN',    blurb: '100 headshots' },
    { key: 'wave10',     stat: 'bestWave',     target: 10,   name: 'DUG IN',       blurb: 'Reach wave 10' },
    { key: 'wave15',     stat: 'bestWave',     target: 15,   name: 'AREA SECURED', blurb: 'Clear all 15 waves' },
    { key: 'acc50',      stat: 'bestAccuracy', target: 50,   name: 'DISCIPLINED',  blurb: '50% accuracy in a run' },
    { key: 'runs25',     stat: 'runs',         target: 25,   name: 'VETERAN',      blurb: '25 deployments' },
    { key: 'streaks10',  stat: 'totalStreaks', target: 10,   name: 'AIR SUPPORT',  blurb: '10 scorestreaks earned' }
  ];
  function challengeProgress(stats, def) {
    const s = sanitizeStats(stats);
    const have = s[def.stat] || 0;
    return { key: def.key, name: def.name, blurb: def.blurb,
             have, target: def.target,
             done: have >= def.target,
             pct: Math.min(1, def.target > 0 ? have / def.target : 1) };
  }
  function challengesDone(stats) {
    let n = 0;
    for (let i = 0; i < CHALLENGES.length; i++) {
      if (challengeProgress(stats, CHALLENGES[i]).done) n++;
    }
    return n;
  }

  // ---- Difficulty -------------------------------------------------------------
  // A run-time choice, not a saved setting: picked at deploy, fixed for the run.
  const DIFFICULTIES = {
    recruit:  { label: 'RECRUIT',  hp: 0.8,  dmg: 0.65, count: 0.8, regen: 1.4, blurb: 'Learn the map' },
    regular:  { label: 'REGULAR',  hp: 1.0,  dmg: 1.0,  count: 1.0, regen: 1.0, blurb: 'As designed' },
    veteran:  { label: 'VETERAN',  hp: 1.25, dmg: 1.35, count: 1.2, regen: 0.6, blurb: 'Cover matters' }
  };
  function difficulty(key) { return DIFFICULTIES[key] || DIFFICULTIES.regular; }

  // ---- Wave scaling past the old cap -----------------------------------------
  // The shipped curve flattened hard: rifleman accuracy hit its cap at wave 8, so
  // waves 9-15 were the same fight with more bodies. Difficulty past that point now
  // comes from BEHAVIOUR unlocks and composition, not from a bigger accuracy number.
  const BEHAVIOUR_UNLOCKS = [
    { wave: 5,  key: 'strafeFire',  label: 'Hostiles now fire while moving' },
    { wave: 8,  key: 'flanking',    label: 'Hostiles are flanking' },
    { wave: 10, key: 'burstFire',   label: 'Hostiles firing in bursts' },
    { wave: 12, key: 'enemyNades',  label: 'Hostiles are throwing grenades' }
  ];
  function behavioursAtWave(n) {
    const out = {};
    for (let i = 0; i < BEHAVIOUR_UNLOCKS.length; i++) {
      if (n >= BEHAVIOUR_UNLOCKS[i].wave) out[BEHAVIOUR_UNLOCKS[i].key] = true;
    }
    return out;
  }
  function newBehavioursAtWave(n) {
    return BEHAVIOUR_UNLOCKS.filter(function (b) { return b.wave === n; });
  }

  // Enemy roster, introduced across the whole curve so every wave band plays
  // differently rather than one wave being a set-piece:
  //   0 runner     always    rushes and melees
  //   1 rifleman   wave 2    strafes and shoots
  //   4 scout      wave 3    fast, fragile, always flanks — punishes tunnel vision
  //   2 tank       wave 4    slow, heavy, huge health pool
  //   5 grenadier  wave 6    lobs frags from range — has to be pushed or avoided
  //   6 breacher   wave 7    charges with a shotgun — lethal close, harmless far
  //   3 shielded   wave 9    frontal plate, must be flanked
  // Weights rather than nested thresholds, so adding a kind cannot silently
  // starve an existing one.
  const ENEMY_KIND_UNLOCK = [
    { kind: 0, wave: 1, weight: 1.0,  name: 'Runner' },
    { kind: 1, wave: 2, weight: 0.9,  name: 'Rifleman' },
    { kind: 4, wave: 3, weight: 0.45, name: 'Scout' },
    { kind: 2, wave: 4, weight: 0.3,  name: 'Tank' },
    { kind: 5, wave: 6, weight: 0.35, name: 'Grenadier' },
    { kind: 6, wave: 7, weight: 0.4,  name: 'Breacher' },
    { kind: 3, wave: 9, weight: 0.5,  name: 'Shielded advancer' }
  ];
  // Every ground kind must hold a stop distance. player.pos sits at eye height, so
  // anything that closes without a hold ends up standing inside the player's body
  // (BUG-02). Ranged kinds that orbit are the only ones exempt from *melee*, but
  // none is exempt from the push-out.
  const ENEMY_STOP_DIST = { 0: 1.9, 1: 1.9, 2: 2.6, 3: 1.9, 4: 1.9, 5: 2.4 };
  function enemyStopDistance(kind) {
    return ENEMY_STOP_DIST[kind] === undefined ? 1.9 : ENEMY_STOP_DIST[kind];
  }
  // Grenadiers are useless in your face — they back off to a throwing distance.
  function enemyPreferredRange(kind) { return kind === 5 ? 16 : 0; }

  // Compose movement speed in one place. Riflemen still use their ranged speed
  // inside the firing band, but retain wave, elite and status multipliers.
  function enemyMoveSpeed(kind, state, dist, rangedRange, speedMul, cfg) {
    cfg = cfg || { speed: 3.2, chaseSpeed: 4.9, rangedSpeed: 2.8 };
    const mul = Number.isFinite(speedMul) ? speedMul : 1;
    let speed;
    if (state === 'fallback') speed = cfg.rangedSpeed * 1.25;
    else if (state === 'chase') speed = (kind === 0 ? cfg.chaseSpeed
      : kind === 2 ? 2.2
      : kind === 3 ? 2.0
      : kind === 4 ? cfg.chaseSpeed * 1.35
      : kind === 5 ? 2.6
      : kind === 6 ? cfg.speed * 1.2
      : cfg.speed);
    else if (state === 'strafe') speed = cfg.rangedSpeed;
    else speed = cfg.speed * 0.5;
    if (kind === 1 && dist < rangedRange && state !== 'idle') speed = cfg.rangedSpeed;
    return speed * mul;
  }

  // How much a flanker steers sideways instead of straight at the player.
  // Must taper to zero on approach: a hard cutoff leaves a ring at the cutoff
  // radius where the agent circles forever instead of committing.
  // Flanking has to END. A permanent sideways bias makes a fast agent arc around
  // the player indefinitely — measured at only 75% of scouts ever arriving. Give
  // every flanker a window, then commit straight in.
  // seconds, randomised per agent
  const FLANK_WINDOW = [5, 9];
  function flankWindow(rand) { return FLANK_WINDOW[0] + (rand || 0) * (FLANK_WINDOW[1] - FLANK_WINDOW[0]); }
  function flankBiasNow(flankT, dist) {
    if (!(flankT > 0)) return 0;
    return flankBias(dist);
  }

  function flankBias(dist, full, none) {
    // full bias at/beyond this range
    const f = full === undefined ? 18 : full;
    // no bias inside this range
    const n = none === undefined ? 6 : none;
    if (dist <= n) return 0;
    if (dist >= f) return 1;
    return (dist - n) / (f - n);
  }

  function enemyKindsAtWave(n) {
    return ENEMY_KIND_UNLOCK.filter(function (e) { return n >= e.wave; });
  }
  function newEnemyKindsAtWave(n) {
    return ENEMY_KIND_UNLOCK.filter(function (e) { return e.wave === n && e.wave > 1; });
  }
  // Returns a kind for a roll in [0,1).
  function pickEnemyKind(waveNum, roll) {
    const avail = enemyKindsAtWave(waveNum);
    let total = 0;
    for (let i = 0; i < avail.length; i++) total += avail[i].weight;
    const target = Math.max(0, Math.min(0.999999, roll)) * total;
    let acc = 0;
    for (let i = 0; i < avail.length; i++) {
      acc += avail[i].weight;
      if (target < acc) return avail[i].kind;
    }
    return 0;
  }

  // Endless mode: past the victory wave, keep scaling instead of stopping dead.
  function endlessHpMultiplier(n, victoryWave) {
    if (n <= victoryWave) return waveHpMultiplier(n);
    const base = waveHpMultiplier(victoryWave);
    return base * (1 + 0.08 * (n - victoryWave));
  }
  function endlessEnemyCount(n, baseCount, growth, victoryWave, maxCount) {
    const raw = waveEnemyCount(n, baseCount, growth);
    return Math.min(maxCount === undefined ? 60 : maxCount, raw);
  }

  // ---- Pickup drops -----------------------------------------------------------
  // Ammo drops were a flat 30% roll, which can soft-lock a run: a player with poor
  // accuracy empties both weapons, cannot get kills, so cannot get drops, and
  // resupply only fires on a wave CLEAR they can no longer reach. Measured at
  // wave 2 with a fixed-skill bot — 0 ammo, 0 reserve, 0 pickups, two enemies left.
  //
  // So: the drop roll gets a floor that rises as the player runs dry, reaching a
  // guarantee when they are nearly empty.
  function ammoDropChance(roundsLeft, magSize, baseChance) {
    const base = baseChance === undefined ? 0.30 : baseChance;
    const mag = magSize > 0 ? magSize : 30;
    const magsLeft = roundsLeft / mag;
    // effectively dry: always drop
    if (magsLeft <= 0.5) return 1;
    // comfortable: normal odds
    if (magsLeft >= 3) return base;
    // ramp between
    const t = (3 - magsLeft) / 2.5;
    return Math.min(1, base + (1 - base) * t * t);
  }

  // Medkit drops balance combat recovery. Rather than an abrupt binary cliff
  // where dropping below 50% HP suddenly forced 100% of non-ammo kills to spawn
  // medkits (bypassing Scavenger and flooding the arena), the medkit drop chance
  // smoothly scales as player health declines, rewarding tactical play while
  // giving wounded players reliable recovery opportunities.
  const MED_DROP_BASE = 0.15;
  const MED_DROP_CRITICAL = 0.50;
  function medDropChance(health, maxHealth, perkMul) {
    const mul = _isPos(perkMul) ? perkMul : 1;
    const max = _isPos(maxHealth) ? maxHealth : 100;
    const hp = _isNum(health) ? health : max;
    const frac = _clamp01(hp / max);
    const base = MED_DROP_BASE * mul;
    const peak = Math.min(1, MED_DROP_CRITICAL * mul);
    if (frac >= 0.75) return Math.min(1, base);
    // Smooth quadratic ramp between 75% health and 0% health
    const t = (0.75 - frac) / 0.75;
    return Math.min(1, base + (peak - base) * t * t);
  }

  // Resolves whether an ammo box, medkit, or nothing drops from a defeated enemy.
  // Prioritizes ammunition when critically dry, followed by medical supplies when injured.
  function pickupDropKind(roll, ammoChance, medChance) {
    if (!_isNum(roll) || roll < 0) return null;
    const a = _isNum(ammoChance) ? Math.max(0, ammoChance) : 0;
    const m = _isNum(medChance) ? Math.max(0, medChance) : 0;
    if (roll < a) return 'ammo';
    if (roll < a + m) return 'med';
    return null;
  }

  // ---- Armor damage absorption & bleed-through -------------------------------
  // In tactical combat, body armor absorbs the majority of incoming damage while
  // letting a calculated bleed-through fraction pass to health. This rewards picking
  // up armor and inserting plates without creating full invulnerability.
  const ARMOR_ABSORB_RATIO = 0.65;
  const ARMOR_ABSORB_RATIO_BULLET = 0.65;
  const ARMOR_ABSORB_RATIO_BLAST = 0.75;
  const ARMOR_ABSORB_RATIO_MELEE = 0.50;
  const ARMOR_ABSORB_RATIO_FALL = 0.00;

  function armorAbsorbRatioForType(damageType) {
    if (damageType === 'fall') return ARMOR_ABSORB_RATIO_FALL;
    if (damageType === 'melee') return ARMOR_ABSORB_RATIO_MELEE;
    if (damageType === 'blast' || damageType === 'explosion') return ARMOR_ABSORB_RATIO_BLAST;
    if (damageType === 'bullet') return ARMOR_ABSORB_RATIO_BULLET;
    return ARMOR_ABSORB_RATIO_BULLET;
  }

  function resolveArmorDamage(amount, currentArmor, absorbRatio, damageType) {
    const amt = _isNum(amount) ? Math.max(0, amount) : 0;
    const armor = _isNum(currentArmor) ? Math.max(0, currentArmor) : 0;
    if (amt <= 0 || armor <= 0) {
      return { absorbed: 0, absorbedDamage: 0, healthDamage: amt, remainingArmor: armor };
    }
    const ratio = _isNum(absorbRatio) && absorbRatio >= 0 && absorbRatio <= 1
      ? absorbRatio
      : armorAbsorbRatioForType(damageType);
    const absorbed = Math.min(armor, amt * ratio);
    return {
      absorbed,
      absorbedDamage: absorbed,
      healthDamage: amt - absorbed,
      remainingArmor: armor - absorbed
    };
  }

  // ---- Checkpoint save --------------------------------------------------------
  // A full run is ~341 enemies across 15 waves — 25-40 minutes. Losing that to a
  // closed tab was the single worst quality-of-life problem left. Saved between
  // waves only, so it can never capture a half-resolved combat state.
  const SAVE_VERSION = 3;
  function makeCheckpoint(state) {
    return {
      v: SAVE_VERSION,
      wave: state.wave, score: state.score, kills: state.kills, headshots: state.headshots,
      shotsFired: state.shotsFired, shotsHit: state.shotsHit,
      health: state.health, armor: state.armor, grenades: state.grenades,
      credits: state.credits || 0,
      perks: (state.perks || []).slice(),
      plates: state.plates || 0,
      difficulty: state.difficulty, endless: !!state.endless,
      runPhase: state.runPhase || (state.endless ? 'endless' : 'active'),
      settlementSnapshot: state.settlementSnapshot ? {
        kills: state.settlementSnapshot.kills,
        headshots: state.settlementSnapshot.headshots,
        streaks: state.settlementSnapshot.streaks
      } : null,
      streakKills: state.streakKills || 0,
      runStreaksEarned: state.runStreaksEarned || 0,
      // [{gi, ammo, reserve, up}, ...]
      weapons: state.weapons,
      openDistricts: (state.openDistricts || []).slice(),
      spawnProtectionT: _isNum(state.spawnProtectionT) ? state.spawnProtectionT : (_isNum(state.playerSpawnProtectionT) ? state.playerSpawnProtectionT : 0),
      equipment: {
        lethal: state.equipment && state.equipment.lethal || 'frag',
        tactical: state.equipment && state.equipment.tactical || null,
        tacticalCount: state.equipment && state.equipment.tacticalCount || 0,
        fieldCharge: state.equipment && state.equipment.fieldCharge || 0,
        streakBank: (state.equipment && state.equipment.streakBank || []).slice()
      },
      savedAt: state.savedAt || 0
    };
  }
  // Returns a usable checkpoint or null. Never throws on malformed input.
  function validateCheckpoint(raw, weaponCount, baseHealth) {
    if (!raw || typeof raw !== 'object') return null;
    // old saves are dropped, not guessed at
    if (raw.v !== SAVE_VERSION) return null;
    // The browser passes CFG.weapons here. Keep accepting a numeric count for
    // headless callers and older tests, but when definitions are available the
    // saved upgrade is only a delta: every runtime field comes from the current
    // authoritative config rather than from a partial/legacy save object.
    const weaponDefs = Array.isArray(weaponCount) ? weaponCount : null;
    const maxWeaponCount = weaponDefs ? weaponDefs.length : (weaponCount || 4);
    const num = function (v, lo, hi, def) {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (!isFinite(n)) return def;
      return Math.min(hi, Math.max(lo, n));
    };
    const wave = Math.round(num(raw.wave, 1, 999, 1));
    if (!(wave >= 1)) return null;
    if (!Array.isArray(raw.weapons) || !raw.weapons.length) return null;
    const weapons = [];
    for (let i = 0; i < raw.weapons.length && i < 2; i++) {
      const w = raw.weapons[i];
      if (!w || typeof w !== 'object') continue;
      const gi = Math.round(num(w.gi, -1, maxWeaponCount - 1, -1));
      if (gi < 0) { weapons.push(null); continue; }
      let up = null;
      if (_isObj(w.up)) {
        const base = weaponDefs && _isObj(weaponDefs[gi])
          ? weaponDefs[gi] : null;
        up = base ? Object.assign({}, base) : {};
        up.dmg = num(w.up.dmg, 0, 1e5, base ? base.dmg : 0);
        up.mag = Math.round(num(w.up.mag, 1, 999, base ? base.mag : 1));
        up.reserveMax = Math.round(num(w.up.reserveMax, 0, 9999, base ? base.reserveMax : 0));
        up.name = typeof w.up.name === 'string'
          ? w.up.name.slice(0, 80) : (base && typeof base.name === 'string' ? base.name : '');
        up.upgraded = true;
      }
      weapons.push({ gi, ammo: Math.round(num(w.ammo, 0, 999, 0)), reserve: Math.round(num(w.reserve, 0, 9999, 0)), up });
    }
    // a run needs a primary
    if (!weapons.length || !weapons[0]) return null;
    const phase = raw.runPhase === 'victory' || raw.runPhase === 'endless' ? raw.runPhase : 'active';
    const snap = _isObj(raw.settlementSnapshot) ? {
      kills: Math.round(num(raw.settlementSnapshot.kills, 0, 1e6, 0)),
      headshots: Math.round(num(raw.settlementSnapshot.headshots, 0, 1e6, 0)),
      streaks: Math.round(num(raw.settlementSnapshot.streaks, 0, 1e6, 0))
    } : null;
    const perks = (Array.isArray(raw.perks) ? raw.perks : [])
      .filter(function (k) { return !!perkByKey(k); }).slice(0, PERK_SLOTS);
    const maxHealth = perkMaxHealth(
      _isPos(baseHealth) ? baseHealth : 100,
      perks
    );
    return {
      v: SAVE_VERSION, wave,
      score: Math.round(num(raw.score, 0, 1e9, 0)),
      kills: Math.round(num(raw.kills, 0, 1e6, 0)),
      headshots: Math.round(num(raw.headshots, 0, 1e6, 0)),
      shotsFired: Math.round(num(raw.shotsFired, 0, 1e7, 0)),
      shotsHit: Math.round(num(raw.shotsHit, 0, 1e7, 0)),
      health: num(raw.health, 1, maxHealth, maxHealth),
      armor: num(raw.armor, 0, 200, 0),
      credits: num(raw.credits, 0, 1e9, 0),
      // Only keys that still exist survive a reload: a perk renamed or removed
      // between versions must not resurrect as an unknown string.
      perks,
      plates: num(raw.plates, 0, PLATE_MAX, 0),
      grenades: Math.round(num(raw.grenades, 0, 9, 0)),
      difficulty: DIFFICULTIES[raw.difficulty] ? raw.difficulty : 'regular',
      endless: !!raw.endless,
      runPhase: phase,
      settlementSnapshot: snap,
      streakKills: Math.round(num(raw.streakKills, 0, 1e6, 0)),
      runStreaksEarned: Math.round(num(raw.runStreaksEarned, 0, 1e6, 0)),
      weapons,
      openDistricts: (Array.isArray(raw.openDistricts) ? raw.openDistricts : [])
        .filter(function (k) { return k === 'ne' || k === 'sw'; }),
      spawnProtectionT: num(raw.spawnProtectionT, 0, 60, 0),
      equipment: {
        lethal: typeof raw.equipment?.lethal === 'string' && equipmentByKey(raw.equipment.lethal) ? raw.equipment.lethal : 'frag',
        tactical: typeof raw.equipment?.tactical === 'string' && equipmentByKey(raw.equipment.tactical) ? raw.equipment.tactical : null,
        tacticalCount: Math.round(num(raw.equipment?.tacticalCount, 0, 2, 0)),
        fieldCharge: num(raw.equipment?.fieldCharge, 0, 100, 0),
        streakBank: (Array.isArray(raw.equipment?.streakBank) ? raw.equipment.streakBank : [])
          .filter(function (k) { return !!streakByKey(k); }).slice(0, 20)
      },
      savedAt: num(raw.savedAt, 0, 8.64e15, 0)
    };
  }

  // ---- Static geometry batching ----------------------------------------------
  // The arena was one Mesh per box: ~200 draw calls for ~15k triangles from only
  // 8 materials. Merging by material alone would collapse that to ~8 calls, but it
  // would also destroy per-object culling — and, in r128 (no BVH), make every
  // bullet raycast test every triangle in the arena instead of early-rejecting
  // most of it by bounding sphere.
  //
  // So batch by material AND by spatial region. Draw calls drop by roughly an
  // order of magnitude while frustum culling and raycast bounding-sphere rejection
  // both keep working.
  function regionKey(x, z, regionSize) {
    return Math.floor(x / regionSize) + '|' + Math.floor(z / regionSize);
  }
  // items: [{ x, z, mat }] where `mat` is any stable per-material key.
  // Returns Map<batchKey, number[]> of indices into `items`.
  function planStaticBatches(items, regionSize) {
    const batches = new Map();
    for (let i = 0; i < items.length; i++) {
      const key = items[i].mat + '#' + regionKey(items[i].x, items[i].z, regionSize);
      let list = batches.get(key);
      if (!list) { list = []; batches.set(key, list); }
      list.push(i);
    }
    return batches;
  }

  // ---- Analytic segment-vs-AABB occlusion ------------------------------------
  // AI line of sight only needs to know whether something solid is in the way, not
  // exactly which triangle. Testing meshes cost 1.37 ms per frame once static
  // geometry was merged into a few large batches, because three walks every
  // triangle of every candidate. A slab test against the collider AABBs answers
  // the same question in a few operations per box.
  function segmentHitsBox(ox, oy, oz, dx, dy, dz, maxDist, box) {
    let t0 = 0, t1 = maxDist;
    // x
    if (dx * dx < 1e-12) { if (ox < box.min.x || ox > box.max.x) return false; }
    else {
      const inv = 1 / dx;
      let a = (box.min.x - ox) * inv, b = (box.max.x - ox) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    // y
    if (dy * dy < 1e-12) { if (oy < box.min.y || oy > box.max.y) return false; }
    else {
      const inv = 1 / dy;
      let a = (box.min.y - oy) * inv, b = (box.max.y - oy) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    // z
    if (dz * dz < 1e-12) { if (oz < box.min.z || oz > box.max.z) return false; }
    else {
      const inv = 1 / dz;
      let a = (box.min.z - oz) * inv, b = (box.max.z - oz) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    return t1 >= 0 && t0 <= maxDist;
  }
  // True when any collider blocks the segment. `slack` pulls both ends in so a box
  // the endpoints are standing on/next to does not self-occlude.
  function segmentBlocked(ax, ay, az, bx, by, bz, boxes, slack) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return false;
    dx /= len; dy /= len; dz /= len;
    const s = slack === undefined ? 0.2 : slack;
    const maxDist = len - s;
    if (maxDist <= 0) return false;
    for (let i = 0; i < boxes.length; i++) {
      if (segmentHitsBox(ax, ay, az, dx, dy, dz, maxDist, boxes[i])) return true;
    }
    return false;
  }

  // Swept sphere versus AABBs. Expanding each box by the grenade radius turns
  // projectile collision into a segment/slab test, so a fast grenade cannot jump
  // from one side of a thin wall to the other between rendered frames.
  function sweepGrenade(start, end, radius, boxes) {
    const r = Math.max(0, Number(radius) || 0);
    const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
    let best = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const minX = b.min.x - r, maxX = b.max.x + r;
      const minY = b.min.y - r, maxY = b.max.y + r;
      const minZ = b.min.z - r, maxZ = b.max.z + r;
      // Resolve a spawn already inside the expanded collider with the face it is
      // moving toward. This avoids axis=-1 and the old fallback Z normal.
      const inside = start.x >= minX && start.x <= maxX &&
        start.y >= minY && start.y <= maxY && start.z >= minZ && start.z <= maxZ;
      if (inside) {
        const qs = [[start.x, dx, minX, maxX], [start.y, dy, minY, maxY], [start.z, dz, minZ, maxZ]];
        let overlapAxis = -1, travelToFace = Infinity, pushOut = 0, outward = 1;
        for (let a = 0; a < qs.length; a++) {
          const q = qs[a];
          if (Math.abs(q[1]) <= 1e-12) continue;
          const distance = q[1] > 0 ? q[3] - q[0] : q[0] - q[2];
          const travel = distance / Math.abs(q[1]);
          if (travel < travelToFace) {
            travelToFace = travel; pushOut = distance; overlapAxis = a; outward = q[1] > 0 ? 1 : -1;
          }
        }
        if (overlapAxis < 0) {
          pushOut = Infinity;
          for (let a = 0; a < qs.length; a++) {
            const q = qs[a], lo = q[0] - q[2], hi = q[3] - q[0];
            if (Math.min(lo, hi) < pushOut) {
              pushOut = Math.min(lo, hi); overlapAxis = a; outward = lo <= hi ? -1 : 1;
            }
          }
        }
        if (overlapAxis >= 0 && (!best || best.t > 0)) {
          const normal = { x: 0, y: 0, z: 0 };
          normal[overlapAxis === 0 ? 'x' : overlapAxis === 1 ? 'y' : 'z'] = outward;
          best = { t: 0, normal, box: b, initialOverlap: true,
            pushOut: Math.max(0, pushOut) };
        }
        continue;
      }
      let enter = 0, exit = 1, axis = -1;
      const axes = [
        [start.x, dx, minX, maxX],
        [start.y, dy, minY, maxY],
        [start.z, dz, minZ, maxZ]
      ];
      let miss = false;
      for (let a = 0; a < axes.length; a++) {
        const q = axes[a];
        if (Math.abs(q[1]) < 1e-12) {
          if (q[0] < q[2] || q[0] > q[3]) { miss = true; break; }
          continue;
        }
        let t0 = (q[2] - q[0]) / q[1], t1 = (q[3] - q[0]) / q[1];
        if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
        if (t0 > enter) { enter = t0; axis = a; }
        if (t1 < exit) exit = t1;
        if (enter > exit) { miss = true; break; }
      }
      if (miss || enter < 0 || enter > 1 || (best && enter >= best.t)) continue;
      const dir = axis === 0 ? dx : axis === 1 ? dy : dz;
      const normal = { x: 0, y: 0, z: 0 };
      normal[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'] = dir > 0 ? -1 : 1;
      best = { t: enter, normal, box: b };
    }
    return best;
  }

  // ---- Ray broad-phase grid --------------------------------------------------
  // r128 has no BVH, so intersectObjects() walks every root's triangles once its
  // bounding sphere passes. Bullets and AI line-of-sight both fire rays through a
  // 90 m arena many times a second; this narrows the candidate set to the meshes
  // whose footprint the ray actually crosses, using a 2-D XZ uniform grid and an
  // Amanatides-Woo DDA traversal.
  function buildRayGrid(opts) {
    opts = opts || {};
    const cell = opts.cell || 8;
    const half = opts.halfExtent || 56;
    const dim = Math.ceil((half * 2) / cell);
    const buckets = new Array(dim * dim);
    for (let i = 0; i < buckets.length; i++) buckets[i] = [];
    return { cell, half, dim, buckets, stamp: new Int32Array(0), stampId: 0, count: 0, maxId: -1 };
  }
  function rayGridClear(grid) {
    for (let i = 0; i < grid.buckets.length; i++) grid.buckets[i].length = 0;
    grid.count = 0; grid.maxId = -1;
  }
  // Register item `id` under every cell its XZ footprint overlaps.
  function rayGridInsert(grid, id, minX, minZ, maxX, maxZ) {
    const c = grid.cell, h = grid.half, dim = grid.dim;
    const x0 = Math.max(0, Math.floor((minX + h) / c)), x1 = Math.min(dim - 1, Math.floor((maxX + h) / c));
    const z0 = Math.max(0, Math.floor((minZ + h) / c)), z1 = Math.min(dim - 1, Math.floor((maxZ + h) / c));
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) grid.buckets[gz * dim + gx].push(id);
    }
    grid.count++;
    if (id > grid.maxId) grid.maxId = id;
  }
  // Unique ids whose cells the ray crosses, in no particular order.
  function rayGridQuery(grid, ox, oz, dx, dz, maxDist, out) {
    out.length = 0;
    if (grid.stamp.length <= grid.maxId) grid.stamp = new Int32Array(grid.maxId + 1);
    grid.stampId++;
    const stamp = grid.stamp, id = grid.stampId;
    const c = grid.cell, h = grid.half, dim = grid.dim;
    let gx = Math.floor((ox + h) / c), gz = Math.floor((oz + h) / c);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const invX = dx !== 0 ? 1 / dx : Infinity;
    const invZ = dz !== 0 ? 1 / dz : Infinity;
    // distance to the first cell boundary on each axis, then the per-cell delta
    let tMaxX = dx !== 0 ? ((gx + (stepX > 0 ? 1 : 0)) * c - h - ox) * invX : Infinity;
    let tMaxZ = dz !== 0 ? ((gz + (stepZ > 0 ? 1 : 0)) * c - h - oz) * invZ : Infinity;
    const tDeltaX = dx !== 0 ? Math.abs(c * invX) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(c * invZ) : Infinity;
    let t = 0, guard = 0;
    while (t <= maxDist && guard++ < 4096) {
      if (gx >= 0 && gz >= 0 && gx < dim && gz < dim) {
        const b = grid.buckets[gz * dim + gx];
        for (let i = 0; i < b.length; i++) {
          const v = b[i];
          if (stamp[v] !== id) { stamp[v] = id; out.push(v); }
        }
      } else if (t > 0) {
        // left the grid for good
        break;
      }
      if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tDeltaX; gx += stepX; }
      else { t = tMaxZ; tMaxZ += tDeltaZ; gz += stepZ; }
      if (stepX === 0 && stepZ === 0) break;
    }
    return out;
  }

  // ---- Navigation grid + flow field -----------------------------------------
  // The arena is static, so walkability is baked once at load. Pathing is a single
  // breadth-first flood from the player's cell shared by every enemy (one BFS per
  // recompute, not one per agent), which is why this can run several times a second
  // for 14+ agents without showing up in a frame budget.
  const UNREACHABLE = -1;

  function buildNavGrid(colliders, opts) {
    opts = opts || {};
    const cell = opts.cell || 1;
    const half = opts.halfExtent || 46;
    const stepH = opts.stepH === undefined ? 0.6 : opts.stepH;
    const walkerHeight = opts.walkerHeight === undefined ? 1.8 : opts.walkerHeight;
    // Inflating obstacles by the agent radius keeps path cells far enough from
    // walls that a 0.4-0.56 m radius body does not clip a corner it was routed
    // through. The arena's doorways are 4 m wide, so a 0.5 m inflation still
    // leaves 3 m of opening.
    const inflate = opts.agentRadius === undefined ? 0.5 : opts.agentRadius;
    const dim = Math.ceil((half * 2) / cell);
    const blocked = new Uint8Array(dim * dim);

    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!blocksWalker(c, stepH, walkerHeight)) continue;
      const x0 = Math.floor((c.min.x - inflate + half) / cell);
      const x1 = Math.floor((c.max.x + inflate + half) / cell);
      const z0 = Math.floor((c.min.z - inflate + half) / cell);
      const z1 = Math.floor((c.max.z + inflate + half) / cell);
      for (let gz = Math.max(0, z0); gz <= Math.min(dim - 1, z1); gz++) {
        const row = gz * dim;
        for (let gx = Math.max(0, x0); gx <= Math.min(dim - 1, x1); gx++) blocked[row + gx] = 1;
      }
    }
    return {
      cell, half, dim, blocked,
      dist: new Int32Array(dim * dim).fill(UNREACHABLE),
      queue: new Int32Array(dim * dim),
      originX: -half, originZ: -half,
      goalIndex: -1
    };
  }

  function worldToCell(nav, x, z) {
    const gx = Math.floor((x - nav.originX) / nav.cell);
    const gz = Math.floor((z - nav.originZ) / nav.cell);
    if (gx < 0 || gz < 0 || gx >= nav.dim || gz >= nav.dim) return -1;
    return gz * nav.dim + gx;
  }
  function cellCenter(nav, index, out) {
    const gx = index % nav.dim, gz = (index / nav.dim) | 0;
    out = out || { x: 0, z: 0 };
    out.x = nav.originX + (gx + 0.5) * nav.cell;
    out.z = nav.originZ + (gz + 0.5) * nav.cell;
    return out;
  }
  function isWalkable(nav, index) {
    return index >= 0 && nav.blocked[index] === 0;
  }

  // Nearest walkable cell, spiralling outward. Used when the goal (or an agent)
  // ends up inside inflated geometry — which happens legitimately, e.g. a player
  // standing in a doorway whose cell was inflated shut.
  function nearestWalkable(nav, index, maxRadius) {
    if (isWalkable(nav, index)) return index;
    if (index < 0) return -1;
    const gx = index % nav.dim, gz = (index / nav.dim) | 0;
    const lim = maxRadius === undefined ? 6 : maxRadius;
    for (let r = 1; r <= lim; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          // ring only
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const nx = gx + dx, nz = gz + dz;
          if (nx < 0 || nz < 0 || nx >= nav.dim || nz >= nav.dim) continue;
          const ni = nz * nav.dim + nx;
          if (nav.blocked[ni] === 0) return ni;
        }
      }
    }
    return -1;
  }

  // 8-connected BFS flood from the goal. Uniform cost: at 1 m resolution the
  // resulting Chebyshev field produces perfectly serviceable flow directions once
  // the agent steers toward the cell centre.
  const FLOW_FIELD_QUEUE_MASK = 0xffff;
  const FLOW_FIELD_QUEUE_SHIFT = 16;
  function packNavCell(cx, cz) {
    return (((cz | 0) & 0xffff) << 16) | ((cx | 0) & 0xffff);
  }
  function unpackNavCell(packed) {
    return { cx: (packed & 0xffff), cz: (packed >> 16) };
  }
  function isNavDiagonalWalkable(blocked, hIndex, vIndex) {
    return !blocked[hIndex] && !blocked[vIndex];
  }

  const NEIGHBOUR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const NEIGHBOUR_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
  function computeFlowField(nav, goalX, goalZ) {
    let goal = nearestWalkable(nav, worldToCell(nav, goalX, goalZ));
    nav.goalIndex = goal;
    nav.dist.fill(UNREACHABLE);
    if (goal < 0) return nav;
    const dist = nav.dist, blocked = nav.blocked, queue = nav.queue, dim = nav.dim;
    let head = 0, tail = 0;
    dist[goal] = 0;
    const gx = goal % dim, gz = (goal / dim) | 0;
    queue[tail++] = (gz << 16) | gx;

    const maxCoord = dim - 1;
    while (head < tail) {
      const packed = queue[head++];
      const cz = packed >> 16, cx = packed & 0xffff;
      const cur = cz * dim + cx;
      const nd = dist[cur] + 1;

      const canRight = cx < maxCoord;
      const canLeft = cx > 0;
      const canDown = cz < maxCoord;
      const canUp = cz > 0;

      const r = cur + 1;
      const l = cur - 1;
      const d = cur + dim;
      const u = cur - dim;

      if (canRight && !blocked[r] && dist[r] === UNREACHABLE) {
        dist[r] = nd; queue[tail++] = (cz << 16) | (cx + 1);
      }
      if (canLeft && !blocked[l] && dist[l] === UNREACHABLE) {
        dist[l] = nd; queue[tail++] = (cz << 16) | (cx - 1);
      }
      if (canDown && !blocked[d] && dist[d] === UNREACHABLE) {
        dist[d] = nd; queue[tail++] = ((cz + 1) << 16) | cx;
      }
      if (canUp && !blocked[u] && dist[u] === UNREACHABLE) {
        dist[u] = nd; queue[tail++] = ((cz - 1) << 16) | cx;
      }

      if (canRight && canDown) {
        const rd = d + 1;
        if (!blocked[rd] && dist[rd] === UNREACHABLE && isNavDiagonalWalkable(blocked, r, d)) {
          dist[rd] = nd; queue[tail++] = ((cz + 1) << 16) | (cx + 1);
        }
      }
      if (canRight && canUp) {
        const ru = u + 1;
        if (!blocked[ru] && dist[ru] === UNREACHABLE && isNavDiagonalWalkable(blocked, r, u)) {
          dist[ru] = nd; queue[tail++] = ((cz - 1) << 16) | (cx + 1);
        }
      }
      if (canLeft && canDown) {
        const ld = d - 1;
        if (!blocked[ld] && dist[ld] === UNREACHABLE && isNavDiagonalWalkable(blocked, l, d)) {
          dist[ld] = nd; queue[tail++] = ((cz + 1) << 16) | (cx - 1);
        }
      }
      if (canLeft && canUp) {
        const lu = u - 1;
        if (!blocked[lu] && dist[lu] === UNREACHABLE && isNavDiagonalWalkable(blocked, l, u)) {
          dist[lu] = nd; queue[tail++] = ((cz - 1) << 16) | (cx - 1);
        }
      }
    }
    return nav;
  }

  function navDistanceAt(nav, x, z) {
    const i = worldToCell(nav, x, z);
    if (i < 0) return UNREACHABLE;
    if (nav.blocked[i]) {
      const n = nearestWalkable(nav, i);
      return n < 0 ? UNREACHABLE : nav.dist[n];
    }
    return nav.dist[i];
  }

  // Unit direction toward the neighbouring cell with the lowest flood distance,
  // or null when the agent is somewhere the flood never reached (caller falls
  // back to direct seek).
  function flowDirAt(nav, x, z, out) {
    out = out || { x: 0, z: 0 };
    out.x = 0; out.z = 0;
    let i = worldToCell(nav, x, z);
    if (i < 0) return null;
    if (nav.blocked[i] || nav.dist[i] === UNREACHABLE) {
      i = nearestWalkable(nav, i);
      if (i < 0 || nav.dist[i] === UNREACHABLE) return null;
    }
    // already at the goal cell
    if (nav.dist[i] === 0) return null;
    const dim = nav.dim, cx = i % dim, cz = (i / dim) | 0;
    let best = nav.dist[i], bestIdx = -1;

    const canRight = cx < dim - 1;
    const canLeft = cx > 0;
    const canDown = cz < dim - 1;
    const canUp = cz > 0;

    const r = i + 1, l = i - 1, d = i + dim, u = i - dim;

    if (canRight && !nav.blocked[r] && nav.dist[r] < best) { best = nav.dist[r]; bestIdx = r; }
    if (canLeft && !nav.blocked[l] && nav.dist[l] < best) { best = nav.dist[l]; bestIdx = l; }
    if (canDown && !nav.blocked[d] && nav.dist[d] < best) { best = nav.dist[d]; bestIdx = d; }
    if (canUp && !nav.blocked[u] && nav.dist[u] < best) { best = nav.dist[u]; bestIdx = u; }

    if (canRight && canDown) {
      const rd = d + 1;
      if (!nav.blocked[rd] && isNavDiagonalWalkable(nav.blocked, r, d) && nav.dist[rd] < best) { best = nav.dist[rd]; bestIdx = rd; }
    }
    if (canRight && canUp) {
      const ru = u + 1;
      if (!nav.blocked[ru] && isNavDiagonalWalkable(nav.blocked, r, u) && nav.dist[ru] < best) { best = nav.dist[ru]; bestIdx = ru; }
    }
    if (canLeft && canDown) {
      const ld = d - 1;
      if (!nav.blocked[ld] && isNavDiagonalWalkable(nav.blocked, l, d) && nav.dist[ld] < best) { best = nav.dist[ld]; bestIdx = ld; }
    }
    if (canLeft && canUp) {
      const lu = u - 1;
      if (!nav.blocked[lu] && isNavDiagonalWalkable(nav.blocked, l, u) && nav.dist[lu] < best) { best = nav.dist[lu]; bestIdx = lu; }
    }

    if (bestIdx < 0) return null;
    // `out` is already caller-owned; use it for the intermediate centre too.
    // Routed enemies previously allocated another {x,z} on every movement tick.
    const target = cellCenter(nav, bestIdx, out);
    const dx = target.x - x, dz = target.z - z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) { out.x = 0; out.z = 0; return null; }
    out.x = dx / len; out.z = dz / len;
    return out;
  }

  // ---- Stuck detection -------------------------------------------------------
  // Pure bookkeeping so it can be tested without a scene. `state` is owned by the
  // caller (one per enemy); returns 'ok' | 'repath' | 'teleport'.
  // Gate for updateStuck. An agent that has ARRIVED and is holding at its stop
  // distance is stationary on purpose — feeding that to the stall detector
  // teleports arrived attackers away and the wave never resolves. Only track a
  // stall while the agent is genuinely still trying to close.
  function isClosingDistance(state, dist, stopDist, slack) {
    if (state !== 'chase') return false;
    return dist > stopDist + (slack === undefined ? 1.5 : slack);
  }

  // A second, complementary stall detector. updateStuck only catches an agent that
  // is not MOVING; an agent that circles the player forever moves plenty while
  // never arriving, and a wave that is waiting on it never ends. Track the best
  // approach so far: if it has not improved in a while, the agent is not making
  // progress no matter how busy it looks.
  function updateProgress(state, dist, dt, opts) {
    opts = opts || {};
    const improveEps = opts.improveEps === undefined ? 1.0 : opts.improveEps;
    const giveUpAfter = opts.giveUpAfter === undefined ? 16 : opts.giveUpAfter;
    if (state.best === undefined || dist < state.best - improveEps) {
      state.best = dist;
      state.sinceImproved = 0;
      return 'ok';
    }
    state.sinceImproved = (state.sinceImproved || 0) + dt;
    if (state.sinceImproved >= giveUpAfter) {
      state.sinceImproved = 0;
      state.best = dist;
      return 'reposition';
    }
    return 'ok';
  }

  function updateStuck(state, x, z, dt, opts) {
    opts = opts || {};
    const moveEps = opts.moveEps === undefined ? 0.3 : opts.moveEps;
    const repathAfter = opts.repathAfter === undefined ? 3 : opts.repathAfter;
    const teleportAfter = opts.teleportAfter === undefined ? 8 : opts.teleportAfter;
    if (state.anchorX === undefined) {
      state.anchorX = x; state.anchorZ = z; state.stuckT = 0; state.repathed = false;
      return 'ok';
    }
    if (horizDist(x, z, state.anchorX, state.anchorZ) > moveEps) {
      state.anchorX = x; state.anchorZ = z; state.stuckT = 0; state.repathed = false;
      return 'ok';
    }
    state.stuckT += dt;
    if (state.stuckT >= teleportAfter) {
      state.stuckT = 0; state.repathed = false;
      state.anchorX = x; state.anchorZ = z;
      return 'teleport';
    }
    if (!state.repathed && state.stuckT >= repathAfter) {
      state.repathed = true;
      return 'repath';
    }
    return 'ok';
  }

  // ---- Recoil ----------------------------------------------------------------
  // The shipped model was `recoilV * (0.8 + rand * 0.4)` vertically and
  // `(rand - 0.5) * 2 * recoilH` horizontally. The horizontal term had zero mean
  // and no memory, so there was no shape to pull against: sustained fire was a
  // dice roll rather than a skill, and no amount of practice could improve it.
  //
  // A pattern is a list of [x, y] kicks walked one shot at a time and HELD at the
  // last entry, so a long burst settles into a steady drift instead of wandering
  // forever. Entries are multipliers on the weapon's own recoilH / recoilV, so
  // magnitude still comes from CFG and only the shape lives here.
  const RECOIL_PATTERNS = {
    // M4: climbs nearly straight for six, then leans right and holds.
    ar:  [[0, 1], [0.05, 1.05], [-0.05, 1.10], [0.10, 1.05], [0.20, 1.00],
          [0.35, 0.95], [0.55, 0.90], [0.70, 0.85], [0.80, 0.80], [0.90, 0.75]],
    // MK18: shallower climb, wide alternating wander — controllable, never still.
    smg: [[0, 0.85], [-0.25, 0.90], [0.30, 0.95], [-0.45, 0.90], [0.55, 0.85],
          [-0.60, 0.80], [0.65, 0.80], [-0.70, 0.75]],
    // SCAR-H: hard vertical, very little lateral. Punishes holding the trigger.
    br:  [[0, 1.15], [0.08, 1.20], [-0.06, 1.25], [0.12, 1.20], [0.10, 1.15],
          [-0.10, 1.10], [0.15, 1.05]],
    // SV-98: one heavy kick. There is no second shot inside the recovery window,
    // so there is no pattern to learn and none is invented.
    sr:  [[0, 1]]
  };
  // +/- 15%: learnable, but not robotic
  const RECOIL_JITTER = 0.15;
  // seconds off the trigger before shot 1 is shot 1
  const RECOIL_RESET = 0.35;
  function recoilPatternFor(type) {
    const k = String(type || '').toLowerCase();
    return RECOIL_PATTERNS[k] ? k : 'ar';
  }
  // jx / jy are in [-1, 1]; pass 0 for a deterministic trace.
  // When out is provided, mutates and returns out without heap allocation.
  function recoilAt(pattern, shotIndex, jx, jy, out) {
    const p = RECOIL_PATTERNS[pattern] || RECOIL_PATTERNS.ar;
    let i = Math.floor(shotIndex);
    if (!(i >= 0)) i = 0;
    if (i >= p.length) i = p.length - 1;
    const ax = jx === undefined ? 0 : jx, ay = jy === undefined ? 0 : jy;
    const rx = p[i][0] * (1 + ax * RECOIL_JITTER);
    const ry = p[i][1] * (1 + ay * RECOIL_JITTER);
    if (_isObj(out)) {
      out.x = rx;
      out.y = ry;
      return out;
    }
    return {
      x: rx,
      y: ry
    };
  }
  // The pattern only means anything if the index resets between bursts: a player
  // who releases the trigger, re-centres and fires again expects shot 1 to behave
  // like shot 1.
  function recoilShotIndex(prevIndex, sinceLastShot, resetAfter) {
    const gap = resetAfter === undefined ? RECOIL_RESET : resetAfter;
    if (!(sinceLastShot < gap)) return 0;
    return prevIndex + 1;
  }
  // Pulling down while the view is kicked up should CANCEL the kick, not stack
  // with it. Recoil is an additive camera offset that decays back to zero, so a
  // player who compensated kept the compensation in their real pitch and finished
  // the burst aiming at the floor — the recoil went away, their correction did
  // not. Spend counter-input against the outstanding offset first and pass only
  // the remainder through to the aim. Same-sign input is the player choosing to
  // move and is never absorbed.
  // When out is provided, mutates and returns out without heap allocation.
  function absorbRecoil(offset, lookDelta, out) {
    let off = offset, del = lookDelta;
    if (offset > 0 && lookDelta < 0) {
      const used = Math.min(offset, -lookDelta);
      off = offset - used;
      del = lookDelta + used;
    } else if (offset < 0 && lookDelta > 0) {
      const used = Math.min(-offset, lookDelta);
      off = offset + used;
      del = lookDelta - used;
    }
    if (_isObj(out)) {
      out.offset = off;
      out.delta = del;
      return out;
    }
    return { offset: off, delta: del };
  }

  // ---- Hipfire bloom ----------------------------------------------------------
  // Spread was `ads ? adsSpread : spread` scaled by movement and airborne state
  // only. It did not grow under sustained fire and did not recover, so holding the
  // trigger at range cost nothing and tap-firing bought nothing. Bloom is carried
  // in the same units as the base spread and simply adds to it.
  //
  // Parameters are derived from each weapon's own spread rather than stored as
  // four more CFG columns: the ratios are what make a weapon feel controllable,
  // and deriving them means a spread retune cannot leave a stale bloom cap behind.
  // base spreads added per shot
  const BLOOM_PER_SHOT = 0.18;
  // hipfire ceiling, in base spreads
  const BLOOM_CAP_HIP = 1.6;
  // ADS ceiling — far tighter, which is the point
  const BLOOM_CAP_ADS = 0.35;
  // base spreads per second once the trigger is up
  const BLOOM_RECOVER = 2.2;
  const BLOOM_RECOVER_SMG = 1.30;
  const BLOOM_RECOVER_AR = 1.00;
  const BLOOM_RECOVER_BR = 0.85;
  const BLOOM_RECOVER_SR = 0.65;
  const BLOOM_PER_SHOT_SMG = 0.75;
  const BLOOM_PER_SHOT_AR = 1.00;
  const BLOOM_PER_SHOT_BR = 1.25;
  const BLOOM_PER_SHOT_SR = 1.60;
  function weaponBloomPerShotMultiplier(weaponType) {
    const t = String(weaponType || '').toUpperCase();
    if (t === 'SMG') return BLOOM_PER_SHOT_SMG;
    if (t === 'BR') return BLOOM_PER_SHOT_BR;
    if (t === 'SR') return BLOOM_PER_SHOT_SR;
    return BLOOM_PER_SHOT_AR;
  }
  function weaponBloomRecoveryMultiplier(weaponType) {
    if (weaponType === 'SMG') return BLOOM_RECOVER_SMG;
    if (weaponType === 'AR') return BLOOM_RECOVER_AR;
    if (weaponType === 'BR') return BLOOM_RECOVER_BR;
    if (weaponType === 'SR') return BLOOM_RECOVER_SR;
    return BLOOM_RECOVER_AR;
  }
  function bloomParams(baseSpread, adsSpread, ads, weaponType) {
    const base = ads ? adsSpread : baseSpread;
    const recMul = weaponBloomRecoveryMultiplier(weaponType);
    const shotMul = weaponBloomPerShotMultiplier(weaponType);
    return {
      perShot: base * BLOOM_PER_SHOT * shotMul,
      cap: base * (ads ? BLOOM_CAP_ADS : BLOOM_CAP_HIP),
      recover: base * BLOOM_RECOVER * recMul
    };
  }
  function bloomAfterShot(bloom, perShot, cap) {
    const b = bloom + perShot;
    return b > cap ? cap : b;
  }
  function bloomDecay(bloom, dt, recover) {
    const b = bloom - recover * dt;
    return b < 0 ? 0 : b;
  }
  const STANCE_SPREAD_CROUCH = 0.80;
  const STANCE_SPREAD_SLIDE = 1.25;
  const STANCE_SPREAD_SPRINT = 1.35;
  const STANCE_SPREAD_TAC_SPRINT = 1.60;
  const STANCE_SPREAD_AIRBORNE_PENALTY = 0.80;

  function stanceSpreadMultiplier(isCrouching, isSliding, isSprinting, isTacSprint) {
    if (isSliding) return STANCE_SPREAD_SLIDE;
    if (isTacSprint) return STANCE_SPREAD_TAC_SPRINT;
    if (isSprinting) return STANCE_SPREAD_SPRINT;
    if (isCrouching) return STANCE_SPREAD_CROUCH;
    return 1.0;
  }

  function effectiveSpread(base, bloom, speed, airborne, stanceMul) {
    const stance = _isPos(stanceMul) ? stanceMul : 1.0;
    const moveMul = (1 + Math.min(1.2, speed * 0.25) + (airborne ? STANCE_SPREAD_AIRBORNE_PENALTY : 0)) * stance;
    return base * moveMul + (bloom > 0 ? bloom : 0);
  }

  // ---- Penetration ------------------------------------------------------------
  // Every surface in the arena stopped a bullet identically: plywood was cover in
  // exactly the way concrete was. Each material spends part of the round's
  // penetration budget; a round with budget left continues and does proportionally
  // less damage on the far side.
  const PENETRATION_COST = { concrete: 1.0, metal: 0.7, wood: 0.3, glass: 0.1 };
  const PENETRATION_DEFAULT = 1.0;
  const MAX_PENETRATIONS = 2;
  // Budget by weapon class: a .308 marksman round goes through what an SMG will not.
  const PENETRATION_POWER = { sr: 1.6, br: 1.0, ar: 0.75, smg: 0.4 };
  function penetrationCost(material) {
    const c = PENETRATION_COST[material];
    return c === undefined ? PENETRATION_DEFAULT : c;
  }
  function penetrationPower(type) {
    const p = PENETRATION_POWER[String(type || '').toLowerCase()];
    return p === undefined ? PENETRATION_POWER.ar : p;
  }
  // Returns the budget remaining after passing through `material`, or 0 if the
  // round stops there.
  function penetrate(power, material) {
    const left = power - penetrationCost(material);
    return left > 0 ? left : 0;
  }
  // Damage surviving a penetration, as a fraction of the budget still unspent.
  // Never a full-damage wallbang: shooting through cover should be a real option
  // and never the better one.
  function penetrationDamageMul(powerLeft, powerStart) {
    if (!(powerStart > 0)) return 0;
    const f = powerLeft / powerStart;
    return f <= 0 ? 0 : 0.35 + 0.4 * Math.min(1, f);
  }

  // Entry distance of a ray into a box, or -1 for a miss inside maxDist. Same slab
  // test as segmentHitsBox, but it reports WHERE rather than WHETHER, which is
  // what ordering penetrations needs.
  function rayBoxEntry(ox, oy, oz, dx, dy, dz, maxDist, box) {
    let t0 = 0, t1 = maxDist;
    if (dx * dx < 1e-12) { if (ox < box.min.x || ox > box.max.x) return -1; }
    else {
      const inv = 1 / dx;
      let a = (box.min.x - ox) * inv, b = (box.max.x - ox) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    if (dy * dy < 1e-12) { if (oy < box.min.y || oy > box.max.y) return -1; }
    else {
      const inv = 1 / dy;
      let a = (box.min.y - oy) * inv, b = (box.max.y - oy) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    if (dz * dz < 1e-12) { if (oz < box.min.z || oz > box.max.z) return -1; }
    else {
      const inv = 1 / dz;
      let a = (box.min.z - oz) * inv, b = (box.max.z - oz) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    if (t1 < 0 || t0 > maxDist) return -1;
    return t0 < 0 ? 0 : t0;
  }

  // Ordered walk of the surfaces a round crosses.
  //
  // Analytic against the collider AABBs rather than the rendered meshes, and
  // deliberately so: the static arena is merged into a few batched meshes (Phase 2),
  // so a mesh raycast reports the entry AND exit faces of every box in a batch and
  // cannot tell one wall from two. The colliders are exactly one entry per box and
  // are where the material tag lives.
  //
  // Returns { stopAt, tiers }. `tiers` is [{ at, mul }]: a target beyond `at` takes
  // `mul` damage. A target nearer than the first entry takes full damage.
  function penetrationWalk(ox, oy, oz, dx, dy, dz, maxDist, boxes, power) {
    const hits = [];
    for (let i = 0; i < boxes.length; i++) {
      const t = rayBoxEntry(ox, oy, oz, dx, dy, dz, maxDist, boxes[i]);
      if (t >= 0) hits.push({ t, box: boxes[i] });
    }
    hits.sort(function (a, b) { return a.t - b.t; });
    const tiers = [];
    let left = power, crossed = 0;
    for (let i = 0; i < hits.length; i++) {
      if (crossed >= MAX_PENETRATIONS) return { stopAt: hits[i].t, tiers };
      const next = penetrate(left, hits[i].box.mat);
      if (next <= 0) return { stopAt: hits[i].t, tiers };
      left = next; crossed++;
      tiers.push({ at: hits[i].t, mul: penetrationDamageMul(left, power) });
    }
    return { stopAt: maxDist, tiers };
  }
  // Damage multiplier for a target at `dist` given a walk. 0 means blocked.
  function penetrationMulAt(walk, dist) {
    if (dist > walk.stopAt) return 0;
    let mul = 1;
    for (let i = 0; i < walk.tiers.length; i++) {
      if (dist >= walk.tiers[i].at) mul = walk.tiers[i].mul; else break;
    }
    return mul;
  }

  // ---- Melee ------------------------------------------------------------------
  // A runner inside its 1.9 m stop distance had no counter but backpedalling.
  // Pick the nearest target inside a forward cone rather than the nearest target
  // outright, so the knife goes where the player is looking.
  // `targets` is either [{ x, z, dead }] or agents with .pos ({ pos: {x,z}, dead }); dirX/dirZ is the player's forward on XZ.
  function meleeTarget(targets, px, pz, dirX, dirZ, reach, cosHalfAngle) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.dead) continue;
      const tx = (t.pos && _isNum(t.pos.x)) ? t.pos.x : t.x;
      const tz = (t.pos && _isNum(t.pos.z)) ? t.pos.z : t.z;
      const dx = tx - px, dz = tz - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > reach || d < 1e-6) continue;
      if ((dx * dirX + dz * dirZ) / d < cosHalfAngle) continue;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  const MELEE_REACH = 2.2;
  // 45 degrees either side
  const MELEE_CONE = Math.cos(Math.PI / 4);
  const MELEE_DAMAGE = 150;
  const MELEE_COOLDOWN = 0.9;
  const MELEE_BACKSTAB_MUL = 2.4;
  const MELEE_SLIDE_MOMENTUM_MUL = 1.30;
  const MELEE_SPRINT_MOMENTUM_MUL = 1.15;
  const MELEE_TAC_SPRINT_MOMENTUM_MUL = 1.28;
  const MELEE_BACKSTAB_COS_THRESHOLD = 0.50;

  function isMeleeBackstab(playerDirX, playerDirZ, enYaw, px, pz, enX, enZ, cosThreshold) {
    if (!_isNum(playerDirX) || !_isNum(playerDirZ) || !_isNum(enYaw) ||
        !_isNum(px) || !_isNum(pz) || !_isNum(enX) || !_isNum(enZ)) return false;
    const thresh = (_isNum(cosThreshold)) ? cosThreshold : MELEE_BACKSTAB_COS_THRESHOLD;
    const enFwdX = Math.sin(enYaw), enFwdZ = Math.cos(enYaw);
    const toPlayerX = px - enX, toPlayerZ = pz - enZ;
    const behind = (toPlayerX * enFwdX + toPlayerZ * enFwdZ) < 0;
    if (!behind) return false;
    const pLen = Math.hypot(playerDirX, playerDirZ);
    if (pLen < 1e-6) return false;
    const facingDot = (playerDirX / pLen) * enFwdX + (playerDirZ / pLen) * enFwdZ;
    return facingDot > thresh;
  }

  function playerMeleeDamage(baseDmg, isBackstab, isSliding, isSprinting, isTacSprint) {
    const base = _isPos(baseDmg) ? baseDmg : MELEE_DAMAGE;
    if (isBackstab) return base * MELEE_BACKSTAB_MUL;
    if (isSliding) return base * MELEE_SLIDE_MOMENTUM_MUL;
    if (isTacSprint) return base * MELEE_TAC_SPRINT_MOMENTUM_MUL;
    if (isSprinting) return base * MELEE_SPRINT_MOMENTUM_MUL;
    return base;
  }


  // ---- Mantle -----------------------------------------------------------------
  // Step-up capped at STEP_H = 0.60 m, so a 1 m crate was scenery rather than a
  // route. The probe is analytic against the collider AABBs — no raycast — and
  // returns the ledge to lerp onto, or null.
  function mantleTarget(feetY, px, pz, dirX, dirZ, boxes, opts) {
    const o = opts || {};
    const reach = o.reach === undefined ? 0.85 : o.reach;
    const minRise = o.minRise === undefined ? 0.45 : o.minRise;
    const maxRise = o.maxRise === undefined ? 1.7 : o.maxRise;
    const headroom = o.headroom === undefined ? 1.7 : o.headroom;
    const radius = o.radius === undefined ? 0.35 : o.radius;
    const tx = px + dirX * reach, tz = pz + dirZ * reach;
    let ledge = -Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (tx < b.min.x - radius || tx > b.max.x + radius) continue;
      if (tz < b.min.z - radius || tz > b.max.z + radius) continue;
      const rise = b.max.y - feetY;
      if (rise < minRise || rise > maxRise) continue;
      if (b.max.y > ledge) ledge = b.max.y;
    }
    if (ledge === -Infinity) return null;
    // Nothing may occupy the volume the player would stand in — mantling into the
    // underside of a slab is worse than not mantling at all.
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (tx < b.min.x - radius || tx > b.max.x + radius) continue;
      if (tz < b.min.z - radius || tz > b.max.z + radius) continue;
      if (b.max.y > ledge + 0.02 && b.min.y < ledge + headroom) return null;
    }
    // The animation travels from the current feet position to the ledge. Check
    // standing headroom over that whole horizontal segment, not just at the end.
    const pathDX = tx - px, pathDZ = tz - pz;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.max.y <= ledge + 0.02 || b.min.y >= ledge + headroom) continue;
      let enter = 0, exit = 1;
      const pathAxes = [[px, pathDX, b.min.x - radius, b.max.x + radius],
        [pz, pathDZ, b.min.z - radius, b.max.z + radius]];
      for (let a = 0; a < pathAxes.length; a++) {
        const q = pathAxes[a];
        if (Math.abs(q[1]) < 1e-12) {
          if (q[0] < q[2] || q[0] > q[3]) { enter = 1; exit = 0; break; }
          continue;
        }
        let t0 = (q[2] - q[0]) / q[1], t1 = (q[3] - q[0]) / q[1];
        if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
        if (t0 > enter) enter = t0;
        if (t1 < exit) exit = t1;
      }
      if (enter <= exit && exit >= 0 && enter <= 1) return null;
    }
    return { x: tx, z: tz, y: ledge };
  }

  // ---- Interactables: wall buys, the armory, perk stations --------------------
  // Credits earned in Phase 9 had nothing to buy. A station is a fixed point the
  // player walks to and holds a key at; the hold exists so a purchase can never be
  // made by a stray tap while fighting next to one.
  const BUY_RADIUS = 2.8;
  const BUY_HOLD = 0.45;
  // Returns the index of the nearest station in range, or -1. Horizontal distance:
  // player.pos is anchored at eye height, so a 3-D test would read 1.7 m of pure
  // height as separation (the same class of bug as BUG-02).
  function nearestStation(stations, px, pz, radius) {
    const r = radius === undefined ? BUY_RADIUS : radius;
    let best = -1, bestD = r * r;
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      if (!s || s.disabled) continue;
      const d = horizDistSq(s.x, s.z, px, pz);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Wall buys. Priced by class rather than per weapon, so adding a weapon cannot
  // leave a station with an undefined price.
  const WALL_BUY_PRICE = { smg: 1000, ar: 1200, br: 1500, sr: 2000, sg: 900, lmg: 1800 };
  const AMMO_REFILL_DIVISOR = 3;
  function wallBuyPrice(type) {
    const p = WALL_BUY_PRICE[String(type || '').toLowerCase()];
    return p === undefined ? WALL_BUY_PRICE.ar : p;
  }
  // Refilling is always the cheap option: a player who already owns the wall weapon
  // should be topping it up, not re-buying it.
  function ammoRefillPrice(type) {
    return Math.round(wallBuyPrice(type) / AMMO_REFILL_DIVISOR);
  }
  // What a station offers depends on whether the player already holds that weapon.
  // `owned` is the weaponsOwned array; -1 entries are empty slots.
  function wallBuyOffer(owned, weaponIndex, type, reserve, reserveMax, out) {
    const held = owned ? owned.indexOf(weaponIndex) : -1;
    let action, price;
    if (held < 0) { action = 'buy'; price = wallBuyPrice(type); }
    else if (reserve >= reserveMax) { action = 'full'; price = 0; }
    else { action = 'ammo'; price = ammoRefillPrice(type); }
    if (_isObj(out)) {
      out.action = action;
      out.price = price;
      return out;
    }
    return { action, price };
  }

  // ---- The armory (Pack-a-Punch) ----------------------------------------------
  // One station, late and expensive, so the back half of a run has a goal that is
  // not just survival.
  const ARMORY_WAVE = 8;
  const ARMORY_PRICE = 5000;
  const ARMORY_DMG = 1.8;
  const ARMORY_MAG = 1.5;
  function armoryAvailable(wave) { return wave >= ARMORY_WAVE; }
  // Returns the upgraded stat block for a weapon. Never mutates the input: CFG is
  // shared, and upgrading in place would leak across runs.
  function armoryUpgrade(w) {
    return Object.assign({}, w, {
      dmg: w.dmg * ARMORY_DMG,
      mag: Math.round(w.mag * ARMORY_MAG),
      reserveMax: Math.round(w.reserveMax * ARMORY_MAG),
      name: 'MK2 ' + w.name,
      upgraded: true
    });
  }

  // ---- Perks -------------------------------------------------------------------
  // Every perk is a multiplier on a number that already exists, which is why this
  // is a table and not five systems.
  const PERK_SLOTS = 3;
  const PERKS = [
    { key: 'jugg',   short: 'JUG', name: 'JUGGERNAUT',   price: 2500, blurb: '+50 max health' },
    { key: 'reload', short: 'SPD', name: 'SPEED RELOAD', price: 1500, blurb: 'Reload 40% faster' },
    { key: 'steady', short: 'AIM', name: 'STEADY AIM',   price: 1750, blurb: 'Less bloom, faster ADS' },
    { key: 'scav',   short: 'SCV', name: 'SCAVENGER',    price: 1250, blurb: 'Richer pickups' },
    { key: 'wind',   short: 'WND', name: 'SECOND WIND',  price: 3000, blurb: 'One self-revive' }
  ];
  function perkByKey(key) {
    for (let i = 0; i < PERKS.length; i++) if (PERKS[i].key === key) return PERKS[i];
    return null;
  }
  // Returns '' when the purchase is allowed, otherwise the reason to show the
  // player. Never returns a bare boolean: "you can't" with no reason is the thing
  // that makes a shop feel broken.
  function perkBuyBlocker(owned, key, credits) {
    const p = perkByKey(key);
    if (!p) return 'UNKNOWN';
    if (owned.indexOf(key) >= 0) return 'ALREADY OWNED';
    if (owned.length >= PERK_SLOTS) return 'ALL ' + PERK_SLOTS + ' SLOTS FULL';
    if (credits < p.price) return 'NEED ' + (p.price - credits) + ' MORE';
    return '';
  }
  function hasPerk(owned, key) { return !!owned && owned.indexOf(key) >= 0; }
  function perkMaxHealth(base, owned) { return hasPerk(owned, 'jugg') ? base + 50 : base; }
  const HEALTH_LOW_THRESHOLD = 0.30;
  function isHealthLow(health, maxHealth) {
    const max = _isPos(maxHealth) ? maxHealth : 100;
    return _isNum(health) && health <= max * HEALTH_LOW_THRESHOLD;
  }
  const HEALTH_CRITICAL_RATIO = 0.25;
  const CRITICAL_VIGNETTE_BASE_BLUR = 90;
  const CRITICAL_VIGNETTE_MAX_BLUR = 140;
  const CRITICAL_VIGNETTE_BASE_SPREAD = 30;
  const CRITICAL_VIGNETTE_MAX_SPREAD = 55;

  // Evaluates whether current health is in the critical danger zone (positive health <= 25% max).
  function isHealthCritical(health, maxHealth, ratio) {
    if (!_isPos(health)) return false;
    const r = _isPos(ratio) ? ratio : HEALTH_CRITICAL_RATIO;
    const max = _isPos(maxHealth) ? maxHealth : 100;
    return health <= max * r;
  }

  // Calculates normalized danger intensity [0.0, 1.0] as health drops from the critical threshold down to 0.
  // Returns 0 if health is outside the critical window or dead.
  function criticalHealthIntensity(health, maxHealth, ratio) {
    if (!_isPos(health)) return 0;
    const r = _isPos(ratio) ? ratio : HEALTH_CRITICAL_RATIO;
    const max = _isPos(maxHealth) ? maxHealth : 100;
    const thresh = max * r;
    if (health > thresh) return 0;
    return Math.max(0, Math.min(1, (thresh - health) / thresh));
  }

  // Returns tactical health status: 'dead', 'critical', 'low', or 'nominal'.
  function healthDangerState(health, maxHealth, critRatio, lowRatio) {
    if (!_isPos(health)) return 'dead';
    if (isHealthCritical(health, maxHealth, critRatio)) return 'critical';
    if (isHealthLow(health, maxHealth)) return 'low';
    return 'nominal';
  }

  // Computes CSS box-shadow styling for the critical near-death perimeter vignette.
  function criticalVignetteStyle(intensity, isReducedMotion) {
    const clamped = _isNum(intensity) ? _clamp01(intensity) : 0;
    if (clamped <= 0) return 'inset 0 0 90px 30px rgba(180,15,15,0)';
    const blur = Math.round(CRITICAL_VIGNETTE_BASE_BLUR + clamped * (CRITICAL_VIGNETTE_MAX_BLUR - CRITICAL_VIGNETTE_BASE_BLUR));
    const spread = Math.round(CRITICAL_VIGNETTE_BASE_SPREAD + clamped * (CRITICAL_VIGNETTE_MAX_SPREAD - CRITICAL_VIGNETTE_BASE_SPREAD));
    const alpha = isReducedMotion
      ? (0.35 + clamped * 0.25).toFixed(3)
      : (0.45 + clamped * 0.35).toFixed(3);
    return 'inset 0 0 ' + blur + 'px ' + spread + 'px rgba(180,15,15,' + alpha + ')';
  }

  // Evaluates smooth sine heartbeat pulse alpha (1.35 Hz) for near-death danger alert.
  function criticalPulseAlpha(intensity, timeSec, isReducedMotion) {
    const clamped = _isNum(intensity) ? _clamp01(intensity) : 0;
    if (clamped <= 0) return 0;
    if (isReducedMotion) return 0.5 * clamped;
    const t = _isNum(timeSec) ? timeSec : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.35);
    return Math.min(1, (0.35 + 0.50 * pulse) * clamped);
  }
  const ARMOR_LOW_RATIO = 0.25;
  function isArmorLow(armor, maxArmor) {
    if (!_isNum(armor)) return false;
    const max = _isPos(maxArmor) ? maxArmor : 50;
    return armor > 0 && armor <= max * ARMOR_LOW_RATIO;
  }
  function isArmorEmpty(armor) {
    if (!_isNum(armor)) return true;
    return armor <= 0;
  }
  const AMMO_LOW_RATIO = 0.25;
  function isAmmoLow(ammo, mag) {
    if (!_isNum(ammo)) return false;
    if (!_isPos(mag)) return false;
    return ammo <= mag * AMMO_LOW_RATIO;
  }
  function isAmmoEmpty(ammo) {
    if (!_isNum(ammo)) return false;
    return ammo <= 0;
  }
  function reloadPrompt(reloading, ammo, reserve, isTouch) {
    if (reloading) return 'RELOADING';
    if (!_isNum(ammo)) return '';
    if (ammo > 0) return '';
    const res = _isNum(reserve) ? reserve : 0;
    if (res <= 0) return 'OUT OF AMMO — FIND PICKUPS';
    return isTouch ? 'RELOAD' : 'RELOAD [R]';
  }
  // Mobile touch reload button feedback state. Returns 'urgent' when magazine is empty
  // with reserves available and not already reloading; 'reloading' when reloading; and
  // '' during normal combat or complete ammo exhaustion.
  function touchReloadState(ammo, reserve, reloading, isDead) {
    if (isDead) return 'locked';
    if (reloading) return 'reloading';
    if (!_isNum(ammo) || ammo > 0) return '';
    const res = _isNum(reserve) ? reserve : 0;
    if (res <= 0) return '';
    return 'urgent';
  }
  // Mobile touch plate button feedback state: returns 'inserting' during plate application,
  // 'empty' when plate inventory is 0, 'urgent' when plates are held and armor is depleted
  // Mobile touch plate button state: returns 'locked' while downed, 'inserting' while actively plating,
  // 'empty' when out of plates, 'urgent' when armor is broken (0)
  // or critically low (<= 25% max), 'ready' when armor is damaged and can accept a plate,
  // or '' when armor is already at full capacity.
  function touchPlateState(plates, armor, armorMax, inserting, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    if (inserting) return 'inserting';
    if (!_isPos(plates)) return 'empty';
    const curA = _isNum(armor) ? armor : 0;
    const maxA = _isPos(armorMax) ? armorMax : 50;
    if (curA <= 0 || isArmorLow(curA, maxA)) return 'urgent';
    if (curA < maxA) return 'ready';
    return '';
  }
  // Mobile touch equipment button state (frag grenades, tactical equipment): returns 'locked'
  // while downed or dead, 'charging' while holding throw, 'empty' when stock is exhausted, or 'ready' when items remain.
  function touchEquipmentState(count, isCharging, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    if (isCharging) return 'charging';
    if (!_isPos(count)) return 'empty';
    return 'ready';
  }
  // Mobile touch scorestreak/field upgrade button state: returns 'locked' while downed or dead,
  // 'streak' when a banked streak is ready, 'field' when field upgrade is ready, or 'empty' when neither is charged.
  function touchStreakState(hasStreak, fieldReady, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    if (hasStreak) return 'streak';
    if (fieldReady) return 'field';
    return 'empty';
  }
  // Evaluates the next owned weapon slot index in cycle order, skipping negative/unowned slots.
  // Returns -1 if no alternate weapon is owned.
  // Pure: no side effects, no DOM, no THREE.
  function touchSwapNextSlot(curSlot, weaponsOwned) {
    if (!Array.isArray(weaponsOwned) || weaponsOwned.length < 2) return -1;
    const n = weaponsOwned.length;
    const slot = _isNum(curSlot) ? ((curSlot % n) + n) % n : 0;
    for (let k = 1; k < n; k++) {
      const ns = (slot + k) % n;
      const wid = weaponsOwned[ns];
      if (_isNonNeg(wid)) return ns;
    }
    return -1;
  }
  // Mobile touch weapon swap button state: returns 'locked' while downed or dead, 'switching' while weapon is raising,
  // 'empty' when no secondary weapon is available, or 'ready' when a reserve weapon is owned
  // and can be switched to.
  function touchSwapState(curSlot, weaponsOwned, isSwitching, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    if (touchSwapNextSlot(curSlot, weaponsOwned) < 0) return 'empty';
    if (isSwitching) return 'switching';
    return 'ready';
  }
  // Mobile touch weapon swap button label: returns 'LOCKED' while downed or dead, 'DRAW' while weapon is raising, the weapon type
  // of the reserve weapon (e.g. 'AR', 'SMG', 'BR', 'SR') when secondary is owned,
  // or 'SWAP' when empty/unowned.
  function touchSwapLabel(curSlot, weaponsOwned, weaponsList, isSwitching, isDowned, isDead) {
    if (isDead || isDowned) return 'LOCKED';
    const nextSlot = touchSwapNextSlot(curSlot, weaponsOwned);
    if (nextSlot < 0) return 'SWAP';
    if (isSwitching) return 'DRAW';
    const wid = weaponsOwned[nextSlot];
    if (Array.isArray(weaponsList) && weaponsList[wid] && typeof weaponsList[wid].type === 'string') {
      return typeof weaponsList[wid].cls === 'string' ? weaponsList[wid].cls : weaponsList[wid].type;
    }
    return 'SWAP';
  }
  // Station interaction buy prompt prefix: generates 'HOLD USE — ' on mobile touch devices
  // or 'HOLD F — ' on desktop when interactive purchase is available.
  function buyPromptPrefix(isTouch, ok) {
    if (!ok) return '';
    return isTouch ? 'HOLD USE — ' : 'HOLD F — ';
  }
  // Mobile touch station USE button state: returns 'locked' while downed or dead, 'holding' when actively holding interaction,
  // 'ready' when in range of an affordable station, 'blocked' when near an unaffordable station,
  // or 'empty' when out of range of any interactive station.
  function touchUseState(nearStation, canAfford, isHolding, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    if (!nearStation) return 'empty';
    if (isHolding) return 'holding';
    if (canAfford) return 'ready';
    return 'blocked';
  }
  // Mobile touch station USE button contextual label: displays 'LOCKED' while downed or dead, 'HOLD' while purchasing,
  // 'LOCK' when blocked, 'UPGRADE' / 'OPEN' / 'AMMO' / 'BUY' / 'PLATE' / 'PERK' / 'CYCLE'
  // when available, or 'USE' when idle/empty.
  function touchUseLabel(nearStation, canAfford, isHolding, stationKind, action, isDowned, isDead) {
    if (isDead || isDowned) return 'LOCKED';
    if (!nearStation) return 'USE';
    if (isHolding) return 'HOLD';
    if (!canAfford) return 'LOCK';
    if (action === 'cycle') return 'CYCLE';
    if (stationKind === 'armory') return 'UPGRADE';
    if (stationKind === 'door') return 'OPEN';
    if (stationKind === 'plate') return 'PLATE';
    if (stationKind === 'perk') return 'PERK';
    if (stationKind === 'wall') return action === 'ammo' ? 'AMMO' : 'BUY';
    return 'BUY';
  }
  // Change-detection for mobile touch station USE button to prevent redundant DOM updates.
  function touchUseChanged(lastState, nearStation, canAfford, isHolding, stationKind, action, isDowned, isDead) {
    if (!lastState || typeof lastState !== 'object') return true;
    const downedVal = !!isDowned;
    const lastDowned = !!lastState.isDowned;
    const deadVal = !!isDead;
    const lastDead = !!lastState.isDead;
    return lastState.nearStation !== nearStation ||
           lastState.canAfford !== canAfford ||
           lastState.isHolding !== isHolding ||
           lastState.stationKind !== stationKind ||
           lastState.action !== action ||
           (isDowned !== undefined ? lastDowned !== downedVal : false) ||
           (isDead !== undefined ? lastDead !== deadVal : false);
  }
  function syncTouchUseState(lastState, nearStation, canAfford, isHolding, stationKind, action, isDowned, isDead) {
    const target = _isObj(lastState) ? lastState : {};
    target.nearStation = nearStation;
    target.canAfford = canAfford;
    target.isHolding = isHolding;
    target.stationKind = stationKind;
    target.action = action;
    target.isDowned = !!isDowned;
    target.isDead = !!isDead;
    return target;
  }
  // Mobile touch stance/slide button state: returns 'locked' while downed, 'sliding' during an active slide,
  // 'crouch' while crouching, 'sprint' when forward sprint momentum is ready to slide,
  // or '' during standard movement.
  function touchSlideState(sliding, crouching, isSprint, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    if (sliding) return 'sliding';
    if (crouching) return 'crouch';
    if (isSprint) return 'sprint';
    return '';
  }
  // Mobile touch stance/slide button label: returns 'LOCK' when dead, 'CRAWL' when downed, 'STAND' when crouched, or 'SLIDE' otherwise.
  function touchSlideLabel(sliding, crouching, isDowned, isDead) {
    if (isDead) return 'LOCK';
    if (isDowned) return 'CRAWL';
    if (sliding) return 'SLIDE';
    if (crouching) return 'STAND';
    return 'SLIDE';
  }
  // Mobile touch plate button label: returns 'LOCKED' when downed or dead, 'ARMOR' while inserting, 'PLT ' + count
  // when plates are available, or 'EMPTY' when inventory is 0.
  function touchPlateLabel(plates, inserting, isDowned, isDead) {
    if (isDead || isDowned) return 'LOCKED';
    if (inserting) return 'ARMOR';
    if (!_isPos(plates)) return 'EMPTY';
    return 'PLT ' + plates;
  }
  // Mobile touch tactical equipment button label: displays 'LOCKED' while downed or dead, 'FLASH', 'STUN', 'SMOKE'
  // based on active ordnance key, 'EMPTY' when depleted, or 'TAC' fallback.
  function touchTacticalLabel(equippedKey, count, isDowned, isDead) {
    if (isDead || isDowned) return 'LOCKED';
    if (!_isPos(count)) return 'EMPTY';
    if (equippedKey === 'flash') return 'FLASH';
    if (equippedKey === 'stun') return 'STUN';
    if (equippedKey === 'smoke') return 'SMOKE';
    return 'TAC';
  }
  // Mobile touch lethal equipment button label: displays 'LOCKED' while downed or dead, 'HOLD' while charging, 'FRAG',
  // 'SMTX', 'CLAY' based on active explosive key, 'EMPTY' when depleted, or 'NADE' fallback.
  function touchLethalLabel(equippedKey, count, isCharging, isDowned, isDead) {
    if (isDead || isDowned) return 'LOCKED';
    if (isCharging) return 'HOLD';
    if (!_isPos(count)) return 'EMPTY';
    if (equippedKey === 'semtex') return 'SMTX';
    if (equippedKey === 'claymore') return 'CLAY';
    if (equippedKey === 'frag') return 'FRAG';
    return 'NADE';
  }
  // Mobile touch scorestreak / field upgrade button label: displays 'LOCKED' while downed or dead, 'UAV', 'AIR', 'TUR'
  // for active banked streaks, 'BOX' when munitions field upgrade is ready, a charge
  // percentage (e.g. '73%') when field is charging and no streak is banked, or 'STRK'
  // fallback. Optional third argument fieldChargePct (0–100) enables the progress label;
  // omitting it preserves the previous two-argument behaviour exactly.
  function touchStreakLabel(topStreakKey, fieldReady, fieldChargePct, isDowned, isDead) {
    if (isDead || isDowned) return 'LOCKED';
    if (topStreakKey) {
      if (topStreakKey === 'uav') return 'UAV';
      if (topStreakKey === 'airstrike') return 'AIR';
      if (topStreakKey === 'sentry') return 'TUR';
      const d = streakByKey(topStreakKey);
      if (d && typeof d.short === 'string') return d.short;
      return 'STRK';
    }
    if (fieldReady) return 'BOX';
    // Show charge progress when the field upgrade is actively charging (>5%) so
    // mobile players can see how close they are without looking at the streak HUD.
    if (_isNum(fieldChargePct) && fieldChargePct >= 5) {
      return Math.min(99, Math.floor(fieldChargePct)) + '%';
    }
    return 'STRK';
  }
  // Evaluates player eligibility to initiate a blade melee attack.
  function canPlayerMelee(isDead, isDowned, cooldownRemaining) {
    const cd = _isNum(cooldownRemaining) ? cooldownRemaining : 0;
    return !isDead && !isDowned && cd <= 0;
  }
  // Evaluates player eligibility to throw lethal or tactical ordnance.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerThrowEquipment(isDead, isDowned, count, cooldownRemaining) {
    const cd = _isNum(cooldownRemaining) ? cooldownRemaining : 0;
    const cnt = _isNum(count) ? count : 0;
    return !isDead && !isDowned && cnt > 0 && cd <= 0;
  }
  // Evaluates player eligibility to call in an earned scorestreak.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerUseStreak(isDead, isDowned, streakCount) {
    const cnt = _isNum(streakCount) ? streakCount : 0;
    return !isDead && !isDowned && cnt > 0;
  }
  // Evaluates player eligibility to deploy a munitions field upgrade.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerUseFieldUpgrade(isDead, isDowned, currentCharge, requiredCharge) {
    const cur = _isNum(currentCharge) ? currentCharge : 0;
    const req = _isNum(requiredCharge) ? requiredCharge : 100;
    return !isDead && !isDowned && cur >= req;
  }
  // Evaluates player eligibility to interact with stations, doors, and wall buys.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerInteractStation(isDead, isDowned, nearStation) {
    return !isDead && !isDowned && !!nearStation;
  }
  // Evaluates player eligibility to cycle or switch weapon slots.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerSwitchWeapon(isDead, isDowned, isSwitching) {
    return !isDead && !isDowned && !isSwitching;
  }
  // Evaluates player eligibility to aim down sights (ADS).
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerAds(isDead, isDowned, isSprinting) {
    return !isDead && !isDowned && !isSprinting;
  }
  // Evaluates player eligibility to insert an armor plate.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerUsePlate(isDead, isDowned, plates, currentArmor, maxArmor, isInserting) {
    const cnt = _isNum(plates) ? plates : 0;
    const curA = _isNum(currentArmor) ? currentArmor : 0;
    const maxA = _isPos(maxArmor) ? maxArmor : 50;
    return !isDead && !isDowned && cnt > 0 && curA < maxA && !isInserting;
  }
  // Evaluates player eligibility to fire a weapon round.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerFire(isDead, isReloading, isSwitching, ammo, isPlating) {
    if (isPlating) return false;
    const a = _isNum(ammo) ? ammo : 0;
    return !isDead && !isReloading && !isSwitching && a > 0;
  }
  // Evaluates player eligibility to initiate a weapon reload.
  // Pure: no side effects, no DOM, no THREE.
  function canPlayerReload(isDead, isReloading, ammo, magSize, reserve, isPlating) {
    if (isDead || isReloading || isPlating) return false;
    const a = _isNum(ammo) ? ammo : 0;
    const m = _isNum(magSize) ? magSize : 0;
    const r = _isNum(reserve) ? reserve : 0;
    return m > 0 && r > 0 && a < m;
  }
  // Mobile touch melee button state: returns 'locked' while downed or dead, 'cooldown' while melee swing recovers,
  // 'ready' when an enemy is within blade strike reach and cone, or '' when neutral.
  function touchMeleeState(hasTarget, cooldownRemaining, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    const cd = _isNum(cooldownRemaining) ? cooldownRemaining : 0;
    if (cd > 0) return 'cooldown';
    if (hasTarget) return 'ready';
    return '';
  }
  // Mobile touch melee button label: returns 'LOCKED' while downed or dead, 'WAIT' during swing recovery,
  // 'STRIKE' when an enemy is within blade strike range, or 'KNIFE' default.
  function touchMeleeLabel(hasTarget, cooldownRemaining, isDowned, isDead) {
    if (isDead || isDowned) return 'LOCKED';
    const cd = _isNum(cooldownRemaining) ? cooldownRemaining : 0;
    if (cd > 0) return 'WAIT';
    if (hasTarget) return 'STRIKE';
    return 'KNIFE';
  }
  // Mobile touch ADS button state: returns 'locked' while downed or dead, 'steady' when sniper breath hold is engaged,
  // 'scoped' when optical scope is locked in (SR/BR >= threshold),
  // 'active' when aiming down sights, or '' at hip fire.
  function touchAdsState(adsAmount, weaponType, scopeLockedThreshold, isSteadyActive, isDowned, isDead) {
    if (isDead || isDowned) return 'locked';
    const ads = _isNum(adsAmount) ? adsAmount : 0;
    const thr = _isNum(scopeLockedThreshold) ? scopeLockedThreshold : 0.82;
    if (ads <= 0) return '';
    if ((weaponType === 'SR' || weaponType === 'BR') && ads >= thr) {
      return isSteadyActive ? 'steady' : 'scoped';
    }
    return 'active';
  }
  // Mobile touch ADS button contextual label: displays 'LOCKED' while downed or dead, 'STEADY' while holding breath,
  // 'WAIT' when sniper breath is exhausted, 'SCOPE' when optical scope is engaged,
  // 'AIM' when aiming standard sights, or 'ADS' default.
  function touchAdsLabel(adsState, weaponType, steadyT, isDowned, isDead) {
    if (isDead || isDowned || adsState === 'locked') return 'LOCKED';
    if (adsState === 'steady') return 'STEADY';
    if (adsState === 'scoped') {
      if (_isNum(steadyT) && steadyT <= 0) return 'WAIT';
      return 'SCOPE';
    }
    if (adsState === 'active') return 'AIM';
    return 'ADS';
  }
  // Change-detection for mobile touch ADS button to prevent redundant DOM updates.
  function touchAdsChanged(lastState, adsState, adsLabel) {
    if (!lastState) return true;
    return lastState.adsState !== adsState || lastState.adsLabel !== adsLabel;
  }
  // In-place cache synchronizer for mobile touch ADS button state.
  function syncTouchAdsState(lastState, adsState, adsLabel) {
    if (!lastState) return { adsState, adsLabel };
    lastState.adsState = adsState;
    lastState.adsLabel = adsLabel;
    return lastState;
  }
  // Mobile touch jump button state: returns 'locked' when downed, stunned, or dead,
  // 'mantle' during ledge mantle climbing, 'boost' during kinetic slide momentum,
  // 'airborne' when off the ground, or '' when grounded and jump-ready.
  // Backwards-compatible: single boolean onGround returns '' or 'airborne'.
  // Pure: no side effects, no DOM, no THREE.
  function touchJumpState(onGround, isSliding, isMantling, isDowned, isStunned, isDead) {
    if (isDead || isDowned || isStunned) return 'locked';
    if (isMantling) return 'mantle';
    if (isSliding) return 'boost';
    return onGround ? '' : 'airborne';
  }
  // Mobile touch jump button contextual label: displays 'LOCK' when disabled or dead,
  // 'CLIMB' when mantling, 'BOOST' during kinetic slide, 'AIR' when airborne,
  // 'STAND' when crouched, or 'JUMP' default.
  // Pure: no side effects, no DOM, no THREE.
  function touchJumpLabel(jumpState, isCrouching, isDead) {
    if (isDead || jumpState === 'locked') return 'LOCK';
    if (jumpState === 'mantle') return 'CLIMB';
    if (jumpState === 'boost') return 'BOOST';
    if (jumpState === 'airborne') return 'AIR';
    return isCrouching ? 'STAND' : 'JUMP';
  }
  // Change-detection for mobile touch jump button to prevent redundant DOM updates.
  function touchJumpChanged(lastState, jumpState, jumpLabel) {
    if (!lastState) return true;
    return lastState.jumpState !== jumpState || lastState.jumpLabel !== jumpLabel;
  }
  // In-place cache synchronizer for mobile touch jump button state.
  function syncTouchJumpState(lastState, jumpState, jumpLabel) {
    if (!lastState) return { jumpState, jumpLabel };
    lastState.jumpState = jumpState;
    lastState.jumpLabel = jumpLabel;
    return lastState;
  }
  // Change-detection for mobile touch slide button to prevent redundant DOM updates.
  function touchSlideChanged(lastState, slideState, slideLabel) {
    if (!lastState) return true;
    return lastState.slideState !== slideState || lastState.slideLabel !== slideLabel;
  }
  // In-place cache synchronizer for mobile touch slide button state.
  function syncTouchSlideState(lastState, slideState, slideLabel) {
    if (!lastState) return { slideState, slideLabel };
    lastState.slideState = slideState;
    lastState.slideLabel = slideLabel;
    return lastState;
  }
  // Change-detection for mobile touch melee button to prevent redundant DOM updates.
  function touchMeleeChanged(lastState, meleeState, meleeLabel) {
    if (!lastState) return true;
    return lastState.meleeState !== meleeState || lastState.meleeLabel !== meleeLabel;
  }
  // In-place cache synchronizer for mobile touch melee button state.
  function syncTouchMeleeState(lastState, meleeState, meleeLabel) {
    if (!lastState) return { meleeState, meleeLabel };
    lastState.meleeState = meleeState;
    lastState.meleeLabel = meleeLabel;
    return lastState;
  }
  // Evaluates whether a mobile touch player has engaged sniper steady-aim by holding
  // ADS while stationary in marksman scope.
  // Pure: no side effects, no DOM, no THREE.
  function isMobileSteadyAim(isAdsTouch, adsAmount, weaponType, moveX, moveZ) {
    if (!isAdsTouch || weaponType !== 'SR') return false;
    const ads = _isNum(adsAmount) ? adsAmount : 0;
    if (ads < ADS_SCOPE_THRESHOLD) return false;
    const mx = _isNum(moveX) ? Math.abs(moveX) : 0;
    const mz = _isNum(moveZ) ? Math.abs(moveZ) : 0;
    return mx < 0.05 && mz < 0.05;
  }
  // Mobile touch fire button feedback state: returns 'reloading' during reload cycle,
  // 'empty' when all ammo is completely exhausted (ammo <= 0 and reserve <= 0),
  // 'dry' when magazine is empty but reserve is available (ammo <= 0 and reserve > 0),
  // or 'ready' when ammunition is chambered and weapon can fire.
  // Pure: no side effects, no DOM, no THREE.
  function touchFireState(ammo, reserve, reloading, isDead) {
    if (isDead) return 'locked';
    if (reloading) return 'reloading';
    const a = _isNum(ammo) ? ammo : 0;
    const r = _isNum(reserve) ? reserve : 0;
    if (a <= 0 && r <= 0) return 'empty';
    if (a <= 0 && r > 0) return 'dry';
    return 'ready';
  }
  // Mobile touch fire button contextual label: returns 'LOCKED' when dead, 'RELOAD' when reloading or dry,
  // 'EMPTY' when all ammo is exhausted, or 'ADS+FIRE' / 'FIRE' when ready.
  // Pure: no side effects, no DOM, no THREE.
  function touchFireLabel(ammo, reserve, reloading, isAdsFire, isDead) {
    if (isDead) return 'LOCKED';
    if (reloading) return 'RELOAD';
    const a = _isNum(ammo) ? ammo : 0;
    const r = _isNum(reserve) ? reserve : 0;
    if (a <= 0 && r <= 0) return 'EMPTY';
    if (a <= 0 && r > 0) return 'RELOAD';
    return isAdsFire ? 'ADS+FIRE' : 'FIRE';
  }
  // Mobile touch reload button contextual label: returns 'LOCKED' when dead, 'WAIT' during reload cycle,
  // 'RELOAD' when urgent reload is required (ammo <= 0 and reserve > 0),
  // 'EMPTY' when all ammo is exhausted, or 'RLD' standard default.
  // Pure: no side effects, no DOM, no THREE.
  function touchReloadLabel(ammo, reserve, reloading, isDead) {
    if (isDead) return 'LOCKED';
    if (reloading) return 'WAIT';
    const a = _isNum(ammo) ? ammo : 0;
    const r = _isNum(reserve) ? reserve : 0;
    if (a <= 0 && r <= 0) return 'EMPTY';
    if (a <= 0 && r > 0) return 'RELOAD';
    return 'RLD';
  }

  const TOUCH_BUTTON_DEFAULT_SIZE = 56;
  const TOUCH_FIRE_DEFAULT_SIZE = 84;
  const TOUCH_PAUSE_DEFAULT_SIZE = 44;

  const TOUCH_CONTROL_NAMES = {
    'tbtn-fire': 'FIRE',
    'tbtn-ads': 'ADS',
    'tbtn-jump': 'JUMP',
    'tbtn-slide': 'SLIDE',
    'tbtn-reload': 'RELOAD',
    'tbtn-nade': 'LETHAL',
    'tbtn-swap': 'SWAP',
    'tbtn-melee': 'MELEE',
    'tbtn-use': 'USE',
    'tbtn-plate': 'ARMOR',
    'tbtn-tactical': 'TACTICAL',
    'tbtn-streak': 'STREAK',
    'tbtn-pause': 'PAUSE',
    'joy-base': 'JOYSTICK'
  };

  // Maps a touch control element identifier to a human-readable uppercase label for the layout editor.
  // Pure: no side effects, no DOM, no THREE.
  function touchControlName(elementId) {
    if (typeof elementId !== 'string') return 'CONTROL';
    if (TOUCH_CONTROL_NAMES[elementId]) return TOUCH_CONTROL_NAMES[elementId];
    return elementId.replace(/^tbtn-/, '').toUpperCase();
  }

  // Formats human-readable control name and optional size dimension for mobile layout editor.
  // Returns 'Select a button' when elementId is omitted or falsy.
  // Pure: no side effects, no DOM, no THREE.
  function touchEditorControlLabel(elementId, size) {
    if (!elementId || typeof elementId !== 'string') return 'Select a button';
    const name = touchControlName(elementId);
    if (_isPos(size)) {
      return name + ' (' + Math.round(size) + 'px)';
    }
    return name;
  }

  // Clamps mobile touch layout editor positioning coordinates to viewport boundaries [0, maxPct].
  // Pure: no side effects, no DOM, no THREE.
  function touchLayoutClampPercent(clientCoord, elementDim, viewportSpan) {
    const span = _isPos(viewportSpan) ? viewportSpan : 1;
    const dim = _isNum(elementDim) ? elementDim : 0;
    const coord = _isNum(clientCoord) ? clientCoord : 0;
    const maxPct = Math.max(0, 100 - (dim / span * 100));
    const targetPct = (coord - dim / 2) / span * 100;
    return Math.max(0, Math.min(maxPct, targetPct));
  }

  // Mobile touch control size bounds and look delta threshold constants.
  const TOUCH_MIN_CONTROL_SIZE = 44;
  const TOUCH_MAX_CONTROL_SIZE = 150;
  const TOUCH_DEFAULT_CONTROL_SIZE = 72;
  const TOUCH_MAX_LOOK_DELTA = 180;

  // Clamps mobile touch control size dimension [minSize, maxSize] in pixels.
  // Pure: no side effects, no DOM, no THREE.
  function clampTouchControlSize(size, minSize, maxSize) {
    const min = _isPos(minSize) ? minSize : TOUCH_MIN_CONTROL_SIZE;
    const max = (_isNum(maxSize) && maxSize >= min) ? maxSize : TOUCH_MAX_CONTROL_SIZE;
    if (!_isNum(size)) return TOUCH_DEFAULT_CONTROL_SIZE;
    return Math.max(min, Math.min(max, Math.round(size)));
  }

  // Clamps mobile touch layout percentage coordinate [0, maxPct].
  // Pure: no side effects, no DOM, no THREE.
  function clampTouchLayoutCoord(coordPct, maxPct) {
    if (!_isNum(coordPct)) return 0;
    const max = _isNonNeg(maxPct) ? maxPct : 100;
    return Math.max(0, Math.min(max, Number(coordPct.toFixed(2))));
  }

  // Sanitizes a single touch layout entry { left, top, size }.
  // Pure: no side effects, no DOM, no THREE.
  function sanitizeTouchLayoutPosition(entry, minSize, maxSize) {
    if (!entry || typeof entry !== 'object') return null;
    const out = {};
    if (_isNum(entry.left)) {
      out.left = clampTouchLayoutCoord(entry.left, 100);
    }
    if (_isNum(entry.top)) {
      out.top = clampTouchLayoutCoord(entry.top, 100);
    }
    if (_isNum(entry.size)) {
      out.size = clampTouchControlSize(entry.size, minSize, maxSize);
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  // Sanitizes a full touch layout dictionary, validating control IDs and clamping positions.
  // Pure: no side effects, no DOM, no THREE.
  function sanitizeTouchLayout(rawLayout, minSize, maxSize) {
    if (!rawLayout || typeof rawLayout !== 'object') return {};
    const clean = {};
    for (const id in rawLayout) {
      if (typeof id !== 'string') continue;
      if (!TOUCH_CONTROL_NAMES[id] && !id.startsWith('tbtn-') && id !== 'joy-base') continue;
      const sanitized = sanitizeTouchLayoutPosition(rawLayout[id], minSize, maxSize);
      if (sanitized) clean[id] = sanitized;
    }
    return clean;
  }

  // Pure rule governing whether mobile touch gameplay input should be sampled.
  // Gated when game is not started, paused, player is dead, or touch layout editor is active.
  function isTouchGameplayEnabled(started, paused, isDead, isEditing) {
    return Boolean(started && !paused && !isDead && !isEditing);
  }

  // Pure rule governing whether mobile pause menu can be opened via the touch button.
  function canTouchPause(started, paused, isDead, isEditing) {
    return Boolean(!isEditing && started && !paused && !isDead);
  }

  // Computes clamped mobile look delta with sensitivity scaling and boundary clamping.
  // Prevents runaway camera acceleration from device edge-swipes or touch jumps.
  function touchLookDelta(clientCoord, lastCoord, sensitivity, maxDelta) {
    if (!_isNum(clientCoord) || !_isNum(lastCoord)) return 0;
    const factor = _isPos(sensitivity) ? sensitivity : 1;
    const rawDelta = (clientCoord - lastCoord) * factor;
    const max = _isPos(maxDelta) ? maxDelta : TOUCH_MAX_LOOK_DELTA;
    return Math.max(-max, Math.min(max, rawDelta));
  }

  // Evaluates whether a touch button state represents a depleted or unavailable action.
  function isTouchControlEmpty(state) {
    return state === 'empty' || state === 'cooldown' || state === 'locked';
  }

  // Mobile touch pause button state: returns 'editing' during layout customization,
  // 'empty' when game is not started, 'dead' on player death, 'paused' when paused,
  // or 'ready' during active gameplay.
  function touchPauseState(started, paused, isDead, isEditing) {
    if (isEditing) return 'editing';
    if (!started) return 'empty';
    if (isDead) return 'dead';
    if (paused) return 'paused';
    return 'ready';
  }

  // Mobile touch pause button label: returns 'PLAY' while paused, 'EDIT' during touch
  // layout customization, '--' when dead/empty, or 'II' during active gameplay.
  function touchPauseLabel(state) {
    if (state === 'paused') return 'PLAY';
    if (state === 'editing') return 'EDIT';
    if (state === 'dead' || state === 'empty') return '--';
    return 'II';
  }

  // Change-detection for mobile touch pause button to gate DOM updates.
  function touchPauseChanged(lastState, state, label) {
    if (!lastState) return true;
    return lastState.state !== state || lastState.label !== label;
  }

  // Synchronizes mobile touch pause button cache in-place without heap allocations.
  function syncTouchPauseState(lastState, state, label) {
    if (lastState) {
      lastState.state = state;
      lastState.label = label;
    }
    return lastState;
  }

  // Evaluates whether a touch control element is actively selected in the layout editor.
  function isTouchControlSelected(controlId, selectedId) {
    return typeof controlId === 'string' && controlId.length > 0 && controlId === selectedId;
  }

  // Evaluates scorestreak HUD positioning and safe area insets for mobile landscape viewports.
  function streakHudPosition(isTouch, isLeftLayout) {
    if (!isTouch) return { top: '134px', side: 'right', inset: '30px' };
    return {
      top: 'calc(96px + var(--sa-t))',
      side: isLeftLayout ? 'left' : 'right',
      inset: isLeftLayout ? 'calc(16px + var(--sa-l))' : 'calc(16px + var(--sa-r))'
    };
  }

  // Resolves locomotion velocity tier for mobile virtual joystick visual indicator.
  function joystickMoveSpeedTier(moveX, moveZ, isSprint, isDowned, isDead) {
    if (typeof moveZ === 'boolean') {
      if (isSprint === true) return 'locked';
      if (moveZ) return 'crawl';
      const d = _isNum(moveX) ? Math.abs(moveX) : 0;
      if (d >= 0.75) return 'sprint';
      if (d > JOYSTICK_MOVE_THRESHOLD) return 'walk';
      return 'idle';
    }
    if (isDead) return 'locked';
    if (isDowned) return 'crawl';
    if (isSprint) return 'sprint';
    const mag = Math.hypot(_isNum(moveX) ? moveX : 0, _isNum(moveZ) ? moveZ : 0);
    if (mag > JOYSTICK_MOVE_THRESHOLD) return 'walk';
    return 'idle';
  }

  // Maps locomotion velocity tier to CSS class modifier.
  function joystickIndicatorClass(tier) {
    if (tier === 'locked') return 'locked';
    if (tier === 'crawl') return 'crawl';
    if (tier === 'sprint') return 'sprint';
    if (tier === 'walk') return 'walk';
    return '';
  }

  // Change-detection for mobile virtual joystick visual indicator to gate DOM updates.
  function touchJoystickChanged(lastState, sprint, tier) {
    if (!lastState) return true;
    return lastState.sprint !== sprint || lastState.tier !== tier;
  }

  // Synchronizes mobile virtual joystick cache in-place without heap allocations.
  function syncTouchJoystickState(lastState, sprint, tier) {
    if (lastState) {
      lastState.sprint = Boolean(sprint);
      lastState.tier = String(tier || '');
    }
    return lastState;
  }

  // Evaluates universal mobile touch control locked state based on player lifecycle state.
  function touchControlLocked(controlId, isDead, isDowned) {
    if (isDead) return true;
    if (!isDowned) return false;
    return controlId !== 'tbtn-fire' && controlId !== 'tbtn-reload' && controlId !== 'tbtn-pause';
  }

  // Change-detection for mobile touch fire button to prevent redundant DOM updates.
  function touchFireChanged(lastState, fireState, fireLabel) {
    if (!lastState) return true;
    return lastState.fireState !== fireState || lastState.fireLabel !== fireLabel;
  }
  // In-place cache synchronizer for mobile touch fire button state.
  function syncTouchFireState(lastState, fireState, fireLabel) {
    if (!lastState) return { fireState, fireLabel };
    lastState.fireState = fireState;
    lastState.fireLabel = fireLabel;
    return lastState;
  }

  // Change-detection for mobile touch reload button to prevent redundant DOM updates.
  function touchReloadChanged(lastState, reloadState, reloadLabel) {
    if (!lastState) return true;
    return lastState.reloadState !== reloadState || lastState.reloadLabel !== reloadLabel;
  }
  // In-place cache synchronizer for mobile touch reload button state.
  function syncTouchReloadState(lastState, reloadState, reloadLabel) {
    if (!lastState) return { reloadState, reloadLabel };
    lastState.reloadState = reloadState;
    lastState.reloadLabel = reloadLabel;
    return lastState;
  }

  // Change-detection for mobile touch plate button to prevent redundant DOM updates.
  function touchPlateChanged(lastState, plateState, plateLabel) {
    if (!lastState) return true;
    return lastState.plateState !== plateState || lastState.plateLabel !== plateLabel;
  }
  // In-place cache synchronizer for mobile touch plate button state.
  function syncTouchPlateState(lastState, plateState, plateLabel) {
    if (!lastState) return { plateState, plateLabel };
    lastState.plateState = plateState;
    lastState.plateLabel = plateLabel;
    return lastState;
  }

  // Change-detection for mobile touch equipment buttons (lethal and tactical).
  function touchEquipmentChanged(lastState, eqState, eqLabel) {
    if (!lastState) return true;
    return lastState.eqState !== eqState || lastState.eqLabel !== eqLabel;
  }
  // In-place cache synchronizer for mobile touch equipment button state.
  function syncTouchEquipmentState(lastState, eqState, eqLabel) {
    if (!lastState) return { eqState, eqLabel };
    lastState.eqState = eqState;
    lastState.eqLabel = eqLabel;
    return lastState;
  }

  // Change-detection for mobile touch scorestreak / field upgrade button.
  function touchStreakChanged(lastState, streakState, streakLabel) {
    if (!lastState) return true;
    return lastState.streakState !== streakState || lastState.streakLabel !== streakLabel;
  }
  // In-place cache synchronizer for mobile touch scorestreak button state.
  function syncTouchStreakState(lastState, streakState, streakLabel) {
    if (!lastState) return { streakState, streakLabel };
    lastState.streakState = streakState;
    lastState.streakLabel = streakLabel;
    return lastState;
  }

  // Change-detection for mobile touch weapon swap button.
  function touchSwapChanged(lastState, swapState, swapLabel) {
    if (!lastState) return true;
    return lastState.swapState !== swapState || lastState.swapLabel !== swapLabel;
  }
  // In-place cache synchronizer for mobile touch weapon swap button state.
  function syncTouchSwapState(lastState, swapState, swapLabel) {
    if (!lastState) return { swapState, swapLabel };
    lastState.swapState = swapState;
    lastState.swapLabel = swapLabel;
    return lastState;
  }
  function perkReloadMul(owned) { return hasPerk(owned, 'reload') ? 0.6 : 1; }
  function perkBloomMul(owned) { return hasPerk(owned, 'steady') ? 0.55 : 1; }
  function perkAdsMul(owned) { return hasPerk(owned, 'steady') ? 1.5 : 1; }
  function perkPickupMul(owned) { return hasPerk(owned, 'scav') ? 1.6 : 1; }

  // ---- Armor plates ------------------------------------------------------------
  // Armor was a 50-point buffer handed out once at deploy and topped up +15 by a
  // med pickup: in practice a wave-1 resource that was gone by wave 4. Plates make
  // it a between-wave decision instead.
  const PLATE_MAX = 3, PLATE_PRICE = 250, PLATE_TIME = 1.1, FAST_HANDS_PLATE_MUL = 0.80;
  function plateApplyDuration(hasFastHands) { return hasFastHands ? PLATE_TIME * FAST_HANDS_PLATE_MUL : PLATE_TIME; }
  // Returns null when plating would do nothing, so the caller never burns a plate
  // or a second of animation for no gain.
  function plateApply(armor, armorMax, plates) {
    if (plates <= 0 || armor >= armorMax) return null;
    return { armor: armorMax, plates: plates - 1 };
  }
  function platesAffordable(credits, plates) {
    const room = PLATE_MAX - plates;
    if (room <= 0) return 0;
    const n = Math.min(room, Math.floor(credits / PLATE_PRICE));
    return n > 0 ? n : 0;
  }

  // ---- Last stand --------------------------------------------------------------
  // A run is 25-40 minutes and a death ended it outright; the between-wave
  // checkpoint only ever protected against a closed tab. Going down turns that into
  // a tense ten seconds with an out.
  const DOWN_TIME = 10;
  const DOWN_REVIVE_HEALTH = 35;
  const DOWN_SPEED_MUL = 0.35;
  // What a lethal hit does. Second Wind is spent, not kept, so it answers exactly
  // one mistake per run.
  function lethalOutcome(perks, alreadyDowned) {
    if (alreadyDowned) return { outcome: 'dead' };
    if (hasPerk(perks, 'wind')) return { outcome: 'revive', consume: 'wind' };
    return { outcome: 'down' };
  }
  function bleedOutRemaining(downT) {
    const left = DOWN_TIME - downT;
    return left > 0 ? left : 0;
  }

  // ---- Equipment ---------------------------------------------------------------
  // The grenade was the most reusable system in the project and the only thing
  // mounted on it was a single frag. Charge-throw, the trajectory preview, bounce
  // physics and blast line-of-sight are all payload-agnostic, so every entry below
  // is a different payload on machinery that already exists and is already tested.
  //
  // `mode` is what updateGrenades has to branch on, and nothing else:
  //   timed      - fuse runs down, then it detonates (frag, semtex)
  //   burn       - detonates on fuse, then leaves burning ground for `burnTime`
  //   proximity  - arms on rest, then detonates when something enters `trigger`
  //   tactical   - fuse runs down, then applies an effect instead of damage
  const LETHALS = [
    { key: 'frag',     name: 'FRAG',     price: 0,   fuse: 2.2, sticky: false, mode: 'timed',     bounce: 0.45 },
    { key: 'semtex',   name: 'SEMTEX',   price: 750, fuse: 1.4, sticky: true,  mode: 'timed',     bounce: 0 },
    { key: 'thermite', name: 'THERMITE', price: 900, fuse: 0.5, sticky: true,  mode: 'burn',      bounce: 0,
      burnTime: 6, burnRadius: 3.2, burnDps: 55 },
    { key: 'claymore', name: 'CLAYMORE', price: 800, fuse: 0,   sticky: false, mode: 'proximity', bounce: 0.1,
      arm: 0.8, trigger: 4.0, arc: Math.cos(Math.PI / 3) }
  ];
  const TACTICALS = [
    { key: 'flash', name: 'FLASHBANG', price: 600, fuse: 1.4, mode: 'tactical',
      effect: 'blind', dur: 4.5, radius: 14 },
    { key: 'stun',  name: 'STUN',      price: 600, fuse: 1.2, mode: 'tactical',
      effect: 'slow',  dur: 4.0, radius: 9 },
    { key: 'smoke', name: 'SMOKE',     price: 500, fuse: 1.0, mode: 'tactical',
      effect: 'smoke', dur: 12,  radius: 6 }
  ];
  function equipmentByKey(key) {
    for (let i = 0; i < LETHALS.length; i++) if (LETHALS[i].key === key) return LETHALS[i];
    for (let i = 0; i < TACTICALS.length; i++) if (TACTICALS[i].key === key) return TACTICALS[i];
    return null;
  }
  // A flashbang only blinds what is actually looking at it, and only for as long as
  // the angle and distance deserve. A full-strength blind from behind a wall or from
  // 30 m away is the thing that makes flashbangs feel arbitrary.
  // `facing` is the dot of the target's forward with the direction TO the flash.
  function flashStrength(dist, radius, facing) {
    if (dist >= radius) return 0;
    const d = 1 - dist / radius;
    // Looking away still counts for something — it went off next to them.
    const f = facing > 0 ? 0.35 + 0.65 * facing : 0.35 * (1 + facing);
    return f <= 0 ? 0 : d * f;
  }
  function flashDuration(strength, maxDur) {
    return strength <= 0 ? 0 : strength * maxDur;
  }

  // Directional trigger, used by the claymore. The facing is normalised HERE
  // rather than trusted from the caller: the first version stored it after
  // `dir.multiplyScalar(speed)` had already mutated the vector, so the dot product
  // carried a magnitude of ~6.7 and `dot/d >= 0.5` became `cos >= 0.075` — an
  // 86-degree half-angle instead of 60, which is most of a hemisphere.
  function coneHit(ox, oz, tx, tz, faceX, faceZ, range, cosArc) {
    const dx = tx - ox, dz = tz - oz;
    const dSq = dx * dx + dz * dz;
    const r = (_isNum(range)) ? range : 0;
    if (dSq > r * r || dSq < 1e-12) return false;
    const d = Math.sqrt(dSq);
    const f = Math.sqrt(faceX * faceX + faceZ * faceZ);
    if (f < 1e-6) return false;
    return (dx * faceX + dz * faceZ) / (d * f) >= cosArc;
  }

  // ---- Smoke: a volume that blocks line of sight ---------------------------------
  // Enemy LOS is an analytic slab test against collider AABBs (Phase 6), never a
  // mesh raycast, so adding a sphere to it costs a few operations rather than a
  // second raycast pass. That is the only reason smoke is affordable here.
  function segmentHitsSphere(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-12) {
      const ex = ax - cx, ey = ay - cy, ez = az - cz;
      return ex * ex + ey * ey + ez * ez <= r * r;
    }
    // Closest approach of the SEGMENT (not the infinite line) to the centre.
    let t = ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = ax + dx * t, py = ay + dy * t, pz = az + dz * t;
    const ex = px - cx, ey = py - cy, ez = pz - cz;
    return ex * ex + ey * ey + ez * ez <= r * r;
  }
  // `clouds` is [{ x, y, z, r }]. Expired clouds must be removed by the caller.
  function smokeBlocks(ax, ay, az, bx, by, bz, clouds) {
    if (!clouds) return false;
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      if (segmentHitsSphere(ax, ay, az, bx, by, bz, c.x, c.y, c.z, c.r)) return true;
    }
    return false;
  }

  // ---- Scorestreaks --------------------------------------------------------------
  // registerKillT() already tracked a 4-second multi-kill window and did nothing
  // with it but print RAMPAGE. This is the other streak — consecutive kills without
  // going down — which is the one CoD is actually known for.
  const STREAKS = [
    { key: 'uav',       short: 'UAV', name: 'UAV',                 kills: 8,  dur: 30 },
    { key: 'airstrike', short: 'AIR', name: 'PRECISION AIRSTRIKE', kills: 12, dur: 0 },
    { key: 'sentry',    short: 'SEN', name: 'SENTRY GUN',          kills: 16, dur: 45 }
  ];
  function streakByKey(key) {
    for (let i = 0; i < STREAKS.length; i++) if (STREAKS[i].key === key) return STREAKS[i];
    return null;
  }
  // Earned at EXACTLY this count, so a streak is banked once and not re-granted on
  // every subsequent kill.
  function streaksEarnedAt(n) {
    const out = [];
    for (let i = 0; i < STREAKS.length; i++) if (STREAKS[i].kills === n) out.push(STREAKS[i]);
    return out;
  }
  // What the HUD shows as the next goal. Returns null once everything is earned.
  function nextStreak(n) {
    for (let i = 0; i < STREAKS.length; i++) if (STREAKS[i].kills > n) return STREAKS[i];
    return null;
  }

  // ---- Field upgrade -------------------------------------------------------------
  // One, charged by damage dealt rather than by time, so it rewards fighting instead
  // of waiting. Munitions Box over Deployable Cover: the ammo economy is the thing
  // the player actually runs out of.
  const FIELD_UPGRADE = { key: 'munitions', name: 'MUNITIONS BOX', charge: 3000, dur: 25, radius: 3 };
  function fieldChargeAfter(current, damage, needed) {
    const c = current + damage;
    const n = needed === undefined ? FIELD_UPGRADE.charge : needed;
    return c > n ? n : c;
  }
  function fieldReady(current, needed) {
    return current >= (needed === undefined ? FIELD_UPGRADE.charge : needed);
  }

  // ---- Special waves -----------------------------------------------------------
  // The wave-15 boss was dropped by an explicit product decision in favour of
  // spreading variety across the curve. This is that decision carried through: every
  // fifth wave is an announced modifier, so the back half poses different problems
  // rather than larger ones.
  //
  // The cycle is deterministic, not random. A player should be able to learn that
  // wave 15 is Ironclad and bring a flank plan, which is the whole point.
  const SPECIAL_WAVES = [
    { key: 'blitz', name: 'BLITZ', blurb: 'Fast movers — half health, twice the bodies',
      kinds: [0, 4], countMul: 2.0, hpMul: 0.5, speedMul: 1.15 },
    { key: 'blackout', name: 'BLACKOUT', blurb: 'Lights out — tracers and muzzle flash only',
      dark: true, countMul: 0.9 },
    { key: 'ironclad', name: 'IRONCLAD', blurb: 'Armour up front — flank it',
      kinds: [2, 3], countMul: 0.6, hpMul: 1.15 },
    { key: 'marksman', name: 'MARKSMAN', blurb: 'Long-range fire — use cover',
      kinds: [1], countMul: 0.8, accBonus: 0.12 }
  ];
  const SPECIAL_EVERY = 5;
  const WAVE_QUEUE_CAP = 60;
  // The enemy count has three multipliers on it - endless scaling, difficulty and
  // the special wave - and the cap has to come LAST. Applied inside
  // endlessEnemyCount it bounded the raw curve and then a Blitz wave doubled the
  // bounded number: wave 25 queued 120 bodies against a ceiling meant to be 60.
  function waveQueueSize(n, baseCount, growth, victoryWave, diffCount, special) {
    const raw = endlessEnemyCount(n, baseCount, growth, victoryWave, WAVE_QUEUE_CAP);
    const mul = (diffCount === undefined ? 1 : diffCount)
      * (special && special.countMul ? special.countMul : 1);
    const out = Math.round(raw * mul);
    if (out < 1) return 1;
    return out > WAVE_QUEUE_CAP ? WAVE_QUEUE_CAP : out;
  }
  function specialWaveAt(n) {
    if (n < SPECIAL_EVERY || n % SPECIAL_EVERY !== 0) return null;
    return SPECIAL_WAVES[(n / SPECIAL_EVERY - 1) % SPECIAL_WAVES.length];
  }
  // A special wave picks from its own kind list, but only from kinds the wave has
  // actually unlocked — an Ironclad wave before the shielded advancer exists must
  // not spawn one.
  function specialKind(special, waveNum, roll) {
    if (!special || !special.kinds) return null;
    const avail = [];
    const unlocked = enemyKindsAtWave(waveNum);
    for (let i = 0; i < special.kinds.length; i++) {
      for (let j = 0; j < unlocked.length; j++) {
        if (unlocked[j].kind === special.kinds[i]) { avail.push(special.kinds[i]); break; }
      }
    }
    if (!avail.length) return null;
    const idx = Math.floor(Math.max(0, Math.min(0.999999, roll)) * avail.length);
    return avail[idx];
  }

  // ---- Elite variants ------------------------------------------------------------
  // Rare high-wave rolls on kinds that already exist: variety without a new AI, and
  // without the set-piece the boss would have been.
  const ELITE_FROM_WAVE = 11;
  const ELITE_BASE_CHANCE = 0.06;
  const ELITE_MAX_CHANCE = 0.28;
  const ELITE = { hpMul: 2.2, dmgMul: 1.35, speedMul: 1.12, scoreMul: 3, creditMul: 3 };
  function eliteChance(waveNum) {
    if (waveNum < ELITE_FROM_WAVE) return 0;
    const c = ELITE_BASE_CHANCE + (waveNum - ELITE_FROM_WAVE) * 0.02;
    return c > ELITE_MAX_CHANCE ? ELITE_MAX_CHANCE : c;
  }
  function rollElite(waveNum, roll) { return roll < eliteChance(waveNum); }

  // ---- Enemy combat damage scaling ------------------------------------------
  // Pure calculations for enemy melee and ranged attack damage.
  // Combines base weapon/attack damage, archetype bonuses (e.g. heavy tank melee),
  // wave progression, difficulty multipliers, and elite status multipliers (ELITE.dmgMul).
  const ENEMY_MELEE_TANK_BONUS = 10;
  const ENEMY_MELEE_SHIELD_BONUS = 5;
  const ENEMY_MELEE_SCOUT_PENALTY = -4;
  function enemyMeleeDamage(baseDmg, isTankOrKind, wave, diffMul, isElite) {
    const base = _isPos(baseDmg) ? baseDmg : 18;
    let bonus = 0;
    if (typeof isTankOrKind === 'boolean') {
      bonus = isTankOrKind ? ENEMY_MELEE_TANK_BONUS : 0;
    } else if (typeof isTankOrKind === 'number') {
      if (isTankOrKind === 2) bonus = ENEMY_MELEE_TANK_BONUS;
      else if (isTankOrKind === 3) bonus = ENEMY_MELEE_SHIELD_BONUS;
      else if (isTankOrKind === 4) bonus = ENEMY_MELEE_SCOUT_PENALTY;
    }
    const w = _isPos(wave) ? wave : 1;
    const diff = _isPos(diffMul) ? diffMul : 1;
    const elite = isElite ? ELITE.dmgMul : 1;
    return (base + bonus + w * 0.4) * diff * elite;
  }

  const ENEMY_RANGED_TANK_BONUS = 3, ENEMY_RANGED_SHIELD_PENALTY = -2, ENEMY_RANGED_SCOUT_PENALTY = -1;
  function enemyRangedDamage(baseDmg, wave, diffMul, isElite, kind) {
    const base = _isPos(baseDmg) ? baseDmg : 8;
    let bonus = 0;
    if (kind === 2 || kind === 'tank') bonus = ENEMY_RANGED_TANK_BONUS;
    else if (kind === 3 || kind === 'shielded') bonus = ENEMY_RANGED_SHIELD_PENALTY;
    else if (kind === 4 || kind === 'scout') bonus = ENEMY_RANGED_SCOUT_PENALTY;
    const w = _isPos(wave) ? wave : 1;
    const diff = _isPos(diffMul) ? diffMul : 1;
    const elite = isElite ? ELITE.dmgMul : 1;
    return (base + bonus + w * 0.35) * diff * elite;
  }

  // Archetype base health scaling multipliers relative to CFG.ai.maxHealth.
  // Standardizes kind 2 (Tank) from a hardcoded 320 to 3.2x base health.
  const ENEMY_HEALTH_SCALE = {
    // runner
    0: 1.0,
    // rifleman
    1: 1.35,
    // tank
    2: 3.2,
    // shielded advancer
    3: 2.2,
    // scout
    4: 0.55,
    // grenadier
    5: 1.2,
    // breacher
    6: 1.5
  };

  // Math.cos(Math.PI / 3) = 0.5 (60 degrees either side of facing)
  const SHIELD_ARC_COS = 0.5;
  // 85% absorbed head-on (0.15 damage multiplier)
  const SHIELD_ABSORB_RATIO = 0.85;

  function enemyBaseHealth(kind, baseMaxHealth) {
    const base = _isPos(baseMaxHealth) ? baseMaxHealth : 100;
    const mul = ENEMY_HEALTH_SCALE[kind] !== undefined ? ENEMY_HEALTH_SCALE[kind] : 1.0;
    return Math.round(base * mul);
  }

  function enemyMaxHealth(kind, baseMaxHealth, wave, victoryWave, diffHp, specialHp, isElite) {
    const baseHp = enemyBaseHealth(kind, baseMaxHealth);
    const curWave = _isPos(wave) ? wave : 1;
    const vWave = _isNum(victoryWave) ? victoryWave : 15;
    const waveMul = endlessHpMultiplier(curWave, vWave);
    const dHp = _isPos(diffHp) ? diffHp : 1.0;
    const sHp = _isPos(specialHp) ? specialHp : 1.0;
    const eliteMul = isElite ? ELITE.hpMul : 1.0;
    return Math.max(1, Math.round(baseHp * waveMul * dHp * sHp * eliteMul));
  }

  function enemyAccuracy(baseAcc, accPerWave, wave, maxAcc, accBonus) {
    const base = _isNum(baseAcc) ? baseAcc : 0.5;
    const perWave = _isNum(accPerWave) ? accPerWave : 0.035;
    const w = _isPos(wave) ? wave : 1;
    const cap = _isNum(maxAcc) ? maxAcc : 0.75;
    const bonus = _isNum(accBonus) ? accBonus : 0;
    const raw = base + w * perWave + bonus;
    return Math.max(0, Math.min(cap + bonus, raw));
  }

  function playerBulletDamage(baseDmg, isHead, headshotMul, dist, range, penMul, weaponType) {
    const base = _isPos(baseDmg) ? baseDmg : 20;
    const hs = isHead ? (_isPos(headshotMul) ? headshotMul : 1.8) : 1.0;
    const d = _isNonNeg(dist) ? dist : 0;
    const r = _isPos(range) ? range : 100;
    const falloff = weaponType ? weaponDistanceFalloff(weaponType, d, r) : distanceFalloff(d, r);
    const pen = _isNonNeg(penMul) ? penMul : 1.0;
    return base * hs * falloff * pen;
  }


  function shieldMultiplier(kind, enX, enZ, enYaw, hitX, hitZ) {
    if (kind !== 3 || !_isNum(hitX) || !_isNum(hitZ) || !_isNum(enX) || !_isNum(enZ) || !_isNum(enYaw)) return 1.0;
    const fx = Math.sin(enYaw), fz = Math.cos(enYaw);
    const dx = hitX - enX, dz = hitZ - enZ;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return 1.0;
    const facing = (dx / len) * fx + (dz / len) * fz;
    return facing > SHIELD_ARC_COS ? (1 - SHIELD_ABSORB_RATIO) : 1.0;
  }

  // ---- Hitmarker visual feedback tiers -------------------------------------------
  // Standard tactical shooter feedback: differentiates regular hits from absorbed shield hits,
  // wall penetration, and critical kill confirmations.
  const HITMARK_COLOR = {
    block: '#6fa8ff',
    cover: '#ffd24a',
    kill: '#ff2a1a',
    hit: '#ff4a3d'
  };

  function hitmarkerTier(shieldMul, throughCover, isKill) {
    if (isKill) return 'kill';
    if (_isNum(shieldMul) && shieldMul < 1.0) return 'block';
    if (throughCover) return 'cover';
    return 'hit';
  }

  function hitmarkerParams(isHead, tier) {
    const t = tier || 'hit';
    let scale = 1.0;
    let duration = 90;
    if (t === 'block') {
      scale = 0.75;
      duration = 80;
    } else if (t === 'kill') {
      scale = isHead ? 1.9 : 1.45;
      duration = 130;
    } else if (isHead) {
      scale = 1.6;
      duration = 110;
    } else {
      scale = 1.0;
      duration = 90;
    }
    const color = HITMARK_COLOR[t] || HITMARK_COLOR.hit;
    return { scale, color, duration, tier: t };
  }

  // ---- AI agent separation & physics performance rules -------------------------
  // Pre-computed enemy collision radii for agent-vs-agent separation: runners, riflemen,
  // scouts, shielded advancers, and grenadiers share 0.85 m; heavy tanks use 1.1 m.
  const ENEMY_SEPARATION_RADIUS = Object.freeze({
    0: 0.85,
    1: 0.85,
    2: 1.1,
    3: 0.85,
    4: 0.85,
    5: 0.85
  });

  function enemySeparationRadius(kind) {
    if (!_isNum(kind)) return 0.85;
    return ENEMY_SEPARATION_RADIUS[kind] !== undefined ? ENEMY_SEPARATION_RADIUS[kind] : 0.85;
  }

  function canEnemiesOverlap(ax, az, ar, bx, bz, br) {
    const radA = _isPos(ar) ? ar : 0.85;
    const radB = _isPos(br) ? br : 0.85;
    const rr = radA + radB;
    return Math.abs(bx - ax) < rr && Math.abs(bz - az) < rr;
  }

  // Pure separation displacement resolution between two cylindrical agent footprints.
  // Performs fast early-axis boundary rejection before evaluating quadratic distance.
  // Writes push displacement vectors to reusable `out` without heap allocations.
  function resolveSeparationPush(ax, az, ar, bx, bz, br, out) {
    const radA = _isPos(ar) ? ar : 0.85;
    const radB = _isPos(br) ? br : 0.85;
    const rr = radA + radB;
    const dx = bx - ax, dz = bz - az;
    if (Math.abs(dx) >= rr || Math.abs(dz) >= rr) {
      if (out) { out.pushX = 0; out.pushZ = 0; out.applied = false; }
      return false;
    }
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr || d2 <= 1e-4) {
      if (out) { out.pushX = 0; out.pushZ = 0; out.applied = false; }
      return false;
    }
    const d = Math.sqrt(d2);
    const push = (rr - d) * 0.5;
    const nx = dx / d, nz = dz / d;
    if (out) {
      out.pushX = nx * push;
      out.pushZ = nz * push;
      out.applied = true;
    }
    return true;
  }

  // Sliding window hit cap: prevents instant simultaneous damage spikes from multiple
  // melee attacks while avoiding heap allocation churn from repeated array filtering.
  const MELEE_CAP_WINDOW = 0.8;
  const MELEE_CAP_MAX_HITS = 2;

  function pruneHitTimestamps(hits, now, windowSec) {
    if (!Array.isArray(hits)) return 0;
    const win = _isPos(windowSec) ? windowSec : MELEE_CAP_WINDOW;
    let write = 0;
    for (let i = 0; i < hits.length; i++) {
      if (_isNum(hits[i]) && (now - hits[i]) < win) {
        if (write !== i) hits[write] = hits[i];
        write++;
      }
    }
    hits.length = write;
    return write;
  }

  function canRegisterHit(hits, now, windowSec, maxHits) {
    const active = pruneHitTimestamps(hits, now, windowSec);
    const limit = _isPos(maxHits) ? maxHits : MELEE_CAP_MAX_HITS;
    return active < limit;
  }

  // Snaps world coordinates to shadow texel boundaries to prevent shadow shimmering
  // and throttle redundant directional light matrix updates when standing still.
  function snapToTexel(coord, texelSize) {
    if (!_isNum(coord)) return 0;
    if (!_isPos(texelSize)) return coord;
    return Math.round(coord / texelSize) * texelSize;
  }

  // ---- Gated districts -----------------------------------------------------------
  // A second sink for credits that also paces the run: the 90x90 arena reveals
  // itself instead of arriving all at once.
  //
  // Bounds are half-open AABBs on XZ. A sealed district must also be excluded from
  // the spawn ring, or a wave queues bodies into a space nothing can path out of —
  // which is BUG-01 by another route.
  const DISTRICTS = [
    { key: 'ne', name: 'NORTH-EAST DISTRICT', price: 1500,
      minX: 18, maxX: 46, minZ: -46, maxZ: -15 },
    { key: 'sw', name: 'SOUTH-WEST DISTRICT', price: 750,
      minX: -46, maxX: -18, minZ: 15, maxZ: 46 }
  ];
  function districtByKey(key) {
    for (let i = 0; i < DISTRICTS.length; i++) if (DISTRICTS[i].key === key) return DISTRICTS[i];
    return null;
  }
  function insideDistrict(d, x, z) {
    return x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ;
  }
  // `openKeys` is the list of districts already bought.
  function spawnPointSealed(x, z, openKeys, districts) {
    const list = Array.isArray(districts) ? districts : DISTRICTS;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (openKeys && openKeys.indexOf(d.key) >= 0) continue;
      if (insideDistrict(d, x, z)) return true;
    }
    return false;
  }
  // At least one spawn point must always survive the filter, or a wave can never
  // start. Callers pass the ring; this is the assertion that it is still usable.
  function usableSpawnPoints(points, openKeys, districts) {
    const list = Array.isArray(districts) ? districts : DISTRICTS;
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (!spawnPointSealed(points[i][0], points[i][1], openKeys, list)) out.push(points[i]);
    }
    return out;
  }

  // ---- Ragdoll: verlet particles with distance constraints -----------------------
  // Death was a canned animation: the GLB 'die' clip, or a flat 90-degree rotation
  // for the box-man, followed by sinking through the floor. Every corpse fell the
  // same way regardless of where it was shot, what it was standing on, or which way
  // it was facing.
  //
  // Verlet rather than force/velocity integration, because position-based dynamics
  // is unconditionally stable under the stiff constraints a skeleton needs — a
  // spring-damper stiff enough to look like a bone explodes at 60 Hz.
  //
  // A particle is { x, y, z, px, py, pz, r } where p* is the PREVIOUS position;
  // velocity is implied by (x - px), so an impulse is applied by moving px.
  const RAGDOLL_GRAVITY = 18;
  const RAGDOLL_DAMPING = 0.985;
  // Six constraint iterations with a full collision pass inside each meant
  // 6 x 7 nodes x every collider in the arena — about 6,200 box tests per corpse per
  // frame, and ten corpses could be simulating at once. Four iterations hold the
  // skeleton just as well, and collision only needs to run on the last two: the
  // constraint solve is what moves nodes into geometry, so resolving after it is
  // what matters.
  const RAGDOLL_ITERATIONS = 4;
  const RAGDOLL_COLLIDE_LAST = 2;
  // Boxes are narrowed to those near the body before the solve, not re-scanned
  // inside it. A corpse occupies about a metre; the arena has ~150 colliders and
  // typically three or four are anywhere near one.
  const RAGDOLL_BROAD_PAD = 1.2;
  const RAGDOLL_FRICTION = 0.72;
  const RAGDOLL_RESTITUTION = 0.18;

  // The GLB soldier rig is seven bones and the box-man has the same seven parts, so
  // one topology drives both. `at` is the rest offset from the feet, in metres.
  const RAGDOLL_NODES = [
    { key: 'pelvis', at: [0, 0.95, 0], r: 0.16, mass: 1.6 },
    { key: 'chest',  at: [0, 1.42, 0], r: 0.17, mass: 1.4 },
    { key: 'head',   at: [0, 1.72, 0], r: 0.13, mass: 0.9 },
    { key: 'armL',   at: [-0.24, 1.28, 0.02], r: 0.09, mass: 0.5 },
    { key: 'armR',   at: [0.24, 1.28, 0.02], r: 0.09, mass: 0.5 },
    { key: 'legL',   at: [-0.13, 0.48, 0], r: 0.11, mass: 0.8 },
    { key: 'legR',   at: [0.13, 0.48, 0], r: 0.11, mass: 0.8 }
  ];
  // Bone links come first; the cross-braces after them are what stop a seven-point
  // skeleton folding flat into a puddle, which is what a naive chain does.
  const RAGDOLL_LINKS = [
    ['pelvis', 'chest', 1],
    ['chest', 'head', 1],
    ['chest', 'armL', 0.8],
    ['chest', 'armR', 0.8],
    ['pelvis', 'legL', 0.9],
    ['pelvis', 'legR', 0.9],
    // Braces. These were too soft on the first pass and the corpses splayed into a
    // starfish: a seven-point chain with weak cross-links has nothing resisting the
    // limbs swinging out flat. Stiff enough to hold a silhouette, slack enough that
    // the body still drapes over what it lands on.
    ['pelvis', 'head', 0.55],
    ['armL', 'armR', 0.5],
    ['legL', 'legR', 0.5],
    ['chest', 'legL', 0.45],
    ['chest', 'legR', 0.45],
    ['pelvis', 'armL', 0.4],
    ['pelvis', 'armR', 0.4]
  ];

  function makeRagdoll(x, y, z, yaw) {
    const sy = Math.sin(yaw || 0), cy = Math.cos(yaw || 0);
    const nodes = {};
    const order = [];
    for (let i = 0; i < RAGDOLL_NODES.length; i++) {
      const d = RAGDOLL_NODES[i];
      // Rotate the rest pose into the agent's facing so a corpse falls the way it
      // was standing, not the way the table was authored.
      const ox = d.at[0] * cy - d.at[2] * sy;
      const oz = d.at[0] * sy + d.at[2] * cy;
      const p = { key: d.key, x: x + ox, y: y + d.at[1], z: z + oz,
                  px: x + ox, py: y + d.at[1], pz: z + oz,
                  r: d.r, mass: d.mass, inv: 1 / d.mass };
      nodes[d.key] = p;
      order.push(p);
    }
    const links = [];
    for (let i = 0; i < RAGDOLL_LINKS.length; i++) {
      const L = RAGDOLL_LINKS[i];
      const a = nodes[L[0]], b = nodes[L[1]];
      links.push({ a, b, rest: dist3(a, b), k: L[2] });
    }
    return { nodes, order, links, settled: false, t: 0 };
  }

  function dist3(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Impulses move the PREVIOUS position, which is how velocity is expressed in a
  // verlet integrator. Scaled by inverse mass, so a head takes more of a headshot
  // than the pelvis does.
  function ragdollImpulse(rag, key, ix, iy, iz, spread) {
    const s = spread === undefined ? 0.35 : spread;
    const hit = rag.nodes[key] || rag.nodes.chest;
    for (let i = 0; i < rag.order.length; i++) {
      const p = rag.order[i];
      const w = (p === hit ? 1 : s) * p.inv;
      p.px -= ix * w;
      p.py -= iy * w;
      p.pz -= iz * w;
    }
  }

  // Axis-aligned bounds of the whole skeleton, padded. Recomputed per step because
  // it is seven comparisons, which is far cheaper than the collision pass it saves.
  function ragdollNearbyBoxes(rag, boxes, out) {
    out.length = 0;
    if (!boxes || !boxes.length) return out;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < rag.order.length; i++) {
      const p = rag.order[i];
      if (p.x - p.r < minX) minX = p.x - p.r;
      if (p.y - p.r < minY) minY = p.y - p.r;
      if (p.z - p.r < minZ) minZ = p.z - p.r;
      if (p.x + p.r > maxX) maxX = p.x + p.r;
      if (p.y + p.r > maxY) maxY = p.y + p.r;
      if (p.z + p.r > maxZ) maxZ = p.z + p.r;
    }
    minX -= RAGDOLL_BROAD_PAD; minY -= RAGDOLL_BROAD_PAD; minZ -= RAGDOLL_BROAD_PAD;
    maxX += RAGDOLL_BROAD_PAD; maxY += RAGDOLL_BROAD_PAD; maxZ += RAGDOLL_BROAD_PAD;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.max.x < minX || b.min.x > maxX) continue;
      if (b.max.y < minY || b.min.y > maxY) continue;
      if (b.max.z < minZ || b.min.z > maxZ) continue;
      out.push(b);
    }
    return out;
  }
  const _ragNear = [];

  function ragdollStep(rag, dt, boxes, groundY) {
    const g = groundY === undefined ? 0 : groundY;
    const near = ragdollNearbyBoxes(rag, boxes, _ragNear);
    for (let i = 0; i < rag.order.length; i++) {
      const p = rag.order[i];
      const vx = (p.x - p.px) * RAGDOLL_DAMPING;
      const vy = (p.y - p.py) * RAGDOLL_DAMPING;
      const vz = (p.z - p.pz) * RAGDOLL_DAMPING;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += vx;
      p.y += vy - RAGDOLL_GRAVITY * dt * dt;
      p.z += vz;
    }
    for (let it = 0; it < RAGDOLL_ITERATIONS; it++) {
      for (let i = 0; i < rag.links.length; i++) {
        const L = rag.links[i];
        const a = L.a, b = L.b;
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) continue;
        const diff = (d - L.rest) / d * L.k;
        const wa = a.inv / (a.inv + b.inv), wb = b.inv / (a.inv + b.inv);
        dx *= diff; dy *= diff; dz *= diff;
        a.x += dx * wa; a.y += dy * wa; a.z += dz * wa;
        b.x -= dx * wb; b.y -= dy * wb; b.z -= dz * wb;
      }
      if (it >= RAGDOLL_ITERATIONS - RAGDOLL_COLLIDE_LAST) {
        for (let i = 0; i < rag.order.length; i++) {
          ragdollCollide(rag.order[i], near, g);
        }
      }
    }
    rag.t += dt;
    rag.settled = ragdollEnergy(rag) < 0.0006 && rag.t > 0.6;
    return rag;
  }

  // Ground plane plus the world AABBs, so a corpse lands ON a crate instead of
  // inside it. Friction is applied by dragging the previous position toward the
  // current one along the contact plane.
  function ragdollCollide(p, boxes, groundY) {
    if (p.y - p.r < groundY) {
      p.y = groundY + p.r;
      const vy = p.y - p.py;
      if (vy < 0) p.py = p.y + vy * RAGDOLL_RESTITUTION;
      p.px += (p.x - p.px) * RAGDOLL_FRICTION;
      p.pz += (p.z - p.pz) * RAGDOLL_FRICTION;
    }
    if (!boxes) return;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (p.x + p.r < b.min.x || p.x - p.r > b.max.x) continue;
      if (p.y + p.r < b.min.y || p.y - p.r > b.max.y) continue;
      if (p.z + p.r < b.min.z || p.z - p.r > b.max.z) continue;
      // Push out along the shallowest axis — the same resolution the player
      // controller uses, so corpses and players agree about where a wall is.
      const dxp = b.max.x + p.r - p.x, dxn = p.x - (b.min.x - p.r);
      let dyp = b.max.y + p.r - p.y, dyn = p.y - (b.min.y - p.r);
      const dzp = b.max.z + p.r - p.z, dzn = p.z - (b.min.z - p.r);
      // Downward is not an exit if it would put the node under the world. For a box
      // standing ON the ground the bottom face is usually the SHALLOWEST way out, so
      // without this a leg resting inside a crate gets shoved to b.min.y - r and ends
      // up below zero — measured at y = -0.11 on the crates at z = 30. The ground
      // clamp above cannot save it, because it has already run this call.
      if (b.min.y - p.r < groundY) dyn = Infinity;
      const mx = Math.min(dxp, dxn), my = Math.min(dyp, dyn), mz = Math.min(dzp, dzn);
      if (my <= mx && my <= mz) {
        if (dyp <= dyn) { p.y = b.max.y + p.r; p.px += (p.x - p.px) * RAGDOLL_FRICTION;
                          p.pz += (p.z - p.pz) * RAGDOLL_FRICTION; }
        else p.y = b.min.y - p.r;
        const vy = p.y - p.py;
        if ((dyp <= dyn) === (vy < 0)) p.py = p.y + vy * RAGDOLL_RESTITUTION;
      } else if (mx <= mz) {
        p.x = dxp < dxn ? b.max.x + p.r : b.min.x - p.r;
        p.px = p.x + (p.x - p.px) * RAGDOLL_RESTITUTION;
      } else {
        p.z = dzp < dzn ? b.max.z + p.r : b.min.z - p.r;
        p.pz = p.z + (p.z - p.pz) * RAGDOLL_RESTITUTION;
      }
    }
  }

  function ragdollEnergy(rag) {
    let e = 0;
    for (let i = 0; i < rag.order.length; i++) {
      const p = rag.order[i];
      const dx = p.x - p.px, dy = p.y - p.py, dz = p.z - p.pz;
      e += dx * dx + dy * dy + dz * dz;
    }
    return e;
  }

  // ---- Fall damage ---------------------------------------------------------------
  // The arena is flat, so the original code said "fall damage: none". It stopped
  // being flat the moment mantling let the player onto crates and roofs, and a
  // 6.9 m drop off the central building costing nothing is the kind of thing that
  // makes a world feel like a diagram.
  // m/s: about a 4.6 m drop, survivable
  const FALL_SAFE_SPEED = 9.5;
  // terminal for these purposes
  const FALL_LETHAL_SPEED = 22;
  function fallDamage(impactSpeed) {
    if (impactSpeed <= FALL_SAFE_SPEED) return 0;
    const t = (impactSpeed - FALL_SAFE_SPEED) / (FALL_LETHAL_SPEED - FALL_SAFE_SPEED);
    return Math.min(100, Math.round(100 * t * t));
  }
  // The resolver zeroes vertical velocity on contact. Sample both the peak fall
  // speed and the velocity from the landing substep before that happens.
  function landingImpactSpeed(peakSpeed, verticalVelocity) {
    const peak = isFinite(peakSpeed) && peakSpeed > 0 ? peakSpeed : 0;
    const instant = isFinite(verticalVelocity) && verticalVelocity < 0 ? -verticalVelocity : 0;
    return Math.max(peak, instant);
  }
  // A hard landing costs momentum and a moment of control, which is what makes a
  // drop a decision rather than a shortcut.
  function landingSpeedMul(impactSpeed) {
    if (impactSpeed <= FALL_SAFE_SPEED) return 1;
    const over = Math.min(1, (impactSpeed - FALL_SAFE_SPEED) / FALL_SAFE_SPEED);
    return 1 - 0.65 * over;
  }

  // ---- Attachments ---------------------------------------------------------------
  // The deepest feature in the roadmap, and deliberately the last: an attachment that
  // modifies a RANDOM recoil value modifies nothing a player can perceive. It only
  // became worth building once Phase 9 gave recoil a learnable shape, bloom a cap and
  // rounds a penetration budget — those are the things these actually move.
  //
  // Every mod is a MULTIPLIER on a named weapon field, so nothing here needs to know
  // what a weapon is. Fields the base weapon does not carry (adsSpeed, penetration,
  // sway, moveMul) default to 1 and are read by the engine as `w.field || 1`.
  const ATTACH_SLOTS = ['optic', 'barrel', 'under', 'mag', 'stock'];
  const ATTACH_SLOT_NAME = {
    optic: 'OPTIC', barrel: 'BARREL', under: 'UNDERBARREL', mag: 'MAGAZINE', stock: 'STOCK'
  };
  // Every entry is a trade: nothing here is strictly better than the empty slot, or
  // the "choice" is just a checklist.
  const ATTACHMENTS = [
    // optic
    { key: 'reddot', slot: 'optic', rank: 2, name: 'RED DOT',
      blurb: 'Faster aim, tighter sights', mods: { adsSpeed: 1.18, adsSpread: 0.85, spread: 1.06 } },
    { key: 'scope4x', slot: 'optic', rank: 7, name: '4x SCOPE',
      blurb: 'Precision at range, slow to raise', mods: { adsSpread: 0.55, range: 1.15, adsSpeed: 0.72, sway: 1.2 } },
    // barrel
    { key: 'longbarrel', slot: 'barrel', rank: 3, name: 'LONG BARREL',
      blurb: 'More range and punch, heavier', mods: { range: 1.25, penetration: 1.3, adsSpeed: 0.85, recoilV: 1.08 } },
    { key: 'suppressor', slot: 'barrel', rank: 9, name: 'SUPPRESSOR',
      blurb: 'Quiet and steady, shorter reach', mods: { recoilV: 0.85, recoilH: 0.8, range: 0.82, dmg: 0.94 } },
    // underbarrel
    { key: 'foregrip', slot: 'under', rank: 4, name: 'FOREGRIP',
      blurb: 'Controls climb, slower to swing', mods: { recoilV: 0.78, recoilH: 0.7, adsSpeed: 0.92 } },
    { key: 'laser', slot: 'under', rank: 8, name: 'LASER',
      blurb: 'Tight from the hip, visible', mods: { spread: 0.7, adsSpread: 1.08 } },
    // magazine
    { key: 'extmag', slot: 'mag', rank: 5, name: 'EXTENDED MAG',
      blurb: 'More rounds, slower reload', mods: { mag: 1.4, reserveMax: 1.2, reload: 1.22 } },
    { key: 'fastmag', slot: 'mag', rank: 6, name: 'FAST MAG',
      blurb: 'Quick reloads, fewer rounds', mods: { reload: 0.68, mag: 0.85 } },
    // stock
    { key: 'lightstock', slot: 'stock', rank: 5, name: 'LIGHT STOCK',
      blurb: 'Mobile while aiming, less steady', mods: { moveMul: 1.2, adsSpeed: 1.1, recoilH: 1.18 } },
    { key: 'heavystock', slot: 'stock', rank: 10, name: 'HEAVY STOCK',
      blurb: 'Rock steady, slow to move', mods: { recoilV: 0.82, sway: 0.6, moveMul: 0.85 } }
  ];
  function attachmentByKey(key) {
    for (let i = 0; i < ATTACHMENTS.length; i++) if (ATTACHMENTS[i].key === key) return ATTACHMENTS[i];
    return null;
  }
  function attachmentsForSlot(slot) {
    return ATTACHMENTS.filter(function (a) { return a.slot === slot; });
  }
  function attachmentUnlocked(key, rank) {
    const a = attachmentByKey(key);
    return !!a && rank >= a.rank;
  }
  // Fields an attachment may multiply. Anything outside this list is ignored rather
  // than silently written, so a typo in the table cannot invent a stat.
  const ATTACH_FIELDS = ['dmg', 'rpm', 'mag', 'reserveMax', 'reload', 'spread', 'adsSpread',
                         'recoilV', 'recoilH', 'range', 'adsSpeed', 'penetration', 'sway', 'moveMul'];
  const ATTACH_DEFAULTS = { adsSpeed: 1, penetration: 1, sway: 1, moveMul: 1 };
  // One loadout is at most one attachment per slot; anything else is a corrupt save
  // or a UI bug, and is dropped rather than stacked.
  function sanitizeLoadout(raw, rank) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (let i = 0; i < ATTACH_SLOTS.length; i++) {
      const slot = ATTACH_SLOTS[i];
      const key = raw[slot];
      const a = attachmentByKey(key);
      if (!a || a.slot !== slot) continue;
      if (rank !== undefined && !attachmentUnlocked(key, rank)) continue;
      out[slot] = key;
    }
    return out;
  }
  // Returns a NEW stat block. The base is never mutated: CFG.weapons is shared across
  // runs, and an in-place modify would leak into the next one — the same trap the
  // armory upgrade had to avoid.
  function applyAttachments(base, loadout) {
    const out = {};
    for (const k in base) out[k] = base[k];
    for (const k in ATTACH_DEFAULTS) if (out[k] === undefined) out[k] = ATTACH_DEFAULTS[k];
    const keys = [];
    for (let i = 0; i < ATTACH_SLOTS.length; i++) {
      const key = loadout && loadout[ATTACH_SLOTS[i]];
      if (key) keys.push(key);
    }
    for (let i = 0; i < keys.length; i++) {
      const a = attachmentByKey(keys[i]);
      if (!a) continue;
      for (let f = 0; f < ATTACH_FIELDS.length; f++) {
        const field = ATTACH_FIELDS[f];
        const mul = a.mods[field];
        if (mul === undefined || typeof out[field] !== 'number') continue;
        out[field] = out[field] * mul;
      }
    }
    // Magazine and reserve are counts, not ratios.
    if (_isNum(out.mag)) out.mag = Math.max(1, Math.round(out.mag));
    if (_isNum(out.reserveMax)) out.reserveMax = Math.max(0, Math.round(out.reserveMax));
    out.attachments = keys.slice();
    return out;
  }
  // What the gunsmith screen shows under a candidate attachment: the fields it moves
  // and which way, so a trade-off is legible before it is chosen.
  function attachmentDelta(a) {
    const up = [], down = [];
    if (!a) return { up, down };
    // Lower is better for these, so the arrow has to be flipped.
    const lowerIsBetter = { spread: 1, adsSpread: 1, recoilV: 1, recoilH: 1, reload: 1, sway: 1 };
    for (const field in a.mods) {
      const mul = a.mods[field];
      if (mul === 1) continue;
      const better = lowerIsBetter[field] ? mul < 1 : mul > 1;
      const pct = Math.round(Math.abs(mul - 1) * 100);
      (better ? up : down).push({ field, pct });
    }
    return { up, down };
  }

  // ---- Objective waves -------------------------------------------------------------
  // Task 12.4, held back until special waves proved the mechanism. A secondary goal on
  // some waves: hold a marked zone while the wave runs. Borrowed from Hardpoint, and it
  // works here for the same reason it works there — it pulls the player off whatever
  // corner they have decided is safe.
  //
  // Never on a special wave: two announced modifiers at once reads as noise, and the
  // player would not know which one killed them.
  const OBJECTIVE_EVERY = 4;
  // seconds of occupancy to complete
  const OBJECTIVE_HOLD = 25;
  const OBJECTIVE_RADIUS = 5.5;
  const OBJECTIVE_CREDITS = 900;
  function objectiveWaveAt(n) {
    if (n < OBJECTIVE_EVERY || n % OBJECTIVE_EVERY !== 0) return false;
    if (specialWaveAt(n)) return false;
    return true;
  }
  // Progress only moves while the player is inside, and it DRAINS when they leave —
  // otherwise the objective is "stand here once", which is not a hold.
  function objectiveProgress(current, dt, inside, holdTime) {
    const need = holdTime === undefined ? OBJECTIVE_HOLD : holdTime;
    const next = inside ? current + dt : current - dt * 0.5;
    if (next < 0) return 0;
    return next > need ? need : next;
  }
  function objectiveComplete(current, holdTime) {
    return current >= (holdTime === undefined ? OBJECTIVE_HOLD : holdTime);
  }
  // Placed away from the player's spawn and away from the arena centre, so it is
  // always a move rather than a stand-still.
  function pickObjectiveSpot(candidates, px, pz, minDist) {
    const min = minDist === undefined ? 18 : minDist;
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const d = horizDist(c[0], c[1], px, pz);
      if (d < min) continue;
      const score = -Math.abs(d - (min + 8));
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) {
      // Nothing far enough: take the furthest rather than refusing to place one.
      let far = -1, farD = -1;
      for (let i = 0; i < candidates.length; i++) {
        const d = horizDist(candidates[i][0], candidates[i][1], px, pz);
        if (d > farD) { farD = d; far = i; }
      }
      return far;
    }
    return best;
  }

  // ---- Credits ----------------------------------------------------------------
  // Score only ever went up and nothing in the game read it back, so a 30-minute
  // run had no shape. Credits are earned in parallel and SPENT. Score stays the
  // leaderboard number so career bests remain comparable across versions.
  const CREDITS = { hit: 10, kill: 60, headshotKill: 100, waveClear: 250 };
  function creditsForDamage(isKill, isHead) {
    if (!isKill) return CREDITS.hit;
    return isHead ? CREDITS.headshotKill : CREDITS.kill;
  }
  function creditsForWave(n) { return CREDITS.waveClear * Math.max(1, n); }

  // ---- Power-ups --------------------------------------------------------------
  // Weighted so MAX AMMO — the one that answers the ammo economy directly — is the
  // common drop and NUKE is a genuine event rather than a routine one.
  const POWERUPS = [
    { key: 'maxammo',   weight: 1.00, label: 'MAX AMMO',      dur: 0 },
    { key: 'double',    weight: 0.75, label: 'DOUBLE POINTS', dur: 30 },
    { key: 'instakill', weight: 0.55, label: 'INSTA-KILL',    dur: 10 },
    { key: 'nuke',      weight: 0.22, label: 'NUKE',          dur: 0 }
  ];
  const POWERUP_CHANCE = 0.035;
  function powerUpDropped(roll, chance) {
    return roll < (chance === undefined ? POWERUP_CHANCE : chance);
  }
  function pickPowerUp(roll) {
    let total = 0;
    for (let i = 0; i < POWERUPS.length; i++) total += POWERUPS[i].weight;
    const target = Math.max(0, Math.min(0.999999, roll)) * total;
    let acc = 0;
    for (let i = 0; i < POWERUPS.length; i++) {
      acc += POWERUPS[i].weight;
      if (target < acc) return POWERUPS[i];
    }
    return POWERUPS[0];
  }

  // ---- Ordnance explosive damage, blast falloff, and throw velocity balance ----
  const GRENADE_DAMAGE_FLOOR = 0.35;
  const GRENADE_SELF_DAMAGE_MAX = 55;
  const GRENADE_SELF_RADIUS_RATIO = 0.8;
  const GRENADE_MIN_SPEED = 6.0;
  const GRENADE_MAX_SPEED = 13.0;
  const GRENADE_RAMP_DURATION = 1.0;
  const GRENADE_TAP_THRESHOLD = 0.22;

  function grenadeBlastDamage(dist, radius, baseDmg, scale) {
    if (!_isNum(dist) || dist < 0) return 0;
    if (!_isPos(radius)) return 0;
    if (dist >= radius) return 0;
    const base = _isNum(baseDmg) ? baseDmg : 120;
    const sc = _isNum(scale) ? scale : 1;
    const falloff = 1 - dist / radius;
    return base * (GRENADE_DAMAGE_FLOOR + (1 - GRENADE_DAMAGE_FLOOR) * falloff) * sc;
  }

  function grenadeSelfDamage(dist, radius, maxDmg) {
    if (!_isNum(dist) || dist < 0) return 0;
    if (!_isPos(radius)) return 0;
    const dangerRadius = radius * GRENADE_SELF_RADIUS_RATIO;
    if (dist >= dangerRadius) return 0;
    const maxVal = _isNum(maxDmg) ? maxDmg : GRENADE_SELF_DAMAGE_MAX;
    const falloff = 1 - dist / dangerRadius;
    return Math.round(maxVal * falloff);
  }

  function grenadeChargedSpeed(chargeT, minSpeed, maxSpeed, rampDuration) {
    const t = _isNum(chargeT) ? Math.max(0, chargeT) : 0;
    const minS = _isNum(minSpeed) ? minSpeed : GRENADE_MIN_SPEED;
    const maxS = _isNum(maxSpeed) ? maxSpeed : GRENADE_MAX_SPEED;
    const ramp = _isPos(rampDuration) ? rampDuration : GRENADE_RAMP_DURATION;
    const ratio = Math.min(1, t / ramp);
    return minS + ratio * (maxS - minS);
  }

  function grenadeThrowSpeed(chargeT, tapDefaultSpeed, minSpeed, maxSpeed, rampDuration, tapThreshold) {
    const t = _isNum(chargeT) ? Math.max(0, chargeT) : 0;
    const th = _isNum(tapThreshold) ? tapThreshold : GRENADE_TAP_THRESHOLD;
    const tapSpd = _isNum(tapDefaultSpeed) ? tapDefaultSpeed : 9.5;
    if (t <= th) return tapSpd;
    return grenadeChargedSpeed(t, minSpeed, maxSpeed, rampDuration);
  }

  // ---- Enemy melee attack reach and cadence balance ----
  function canEnemyMelee(kind) {
    return kind === 0 || kind === 2 || kind === 3 || kind === 4;
  }

  function enemyMeleeReach(kind, baseAttackRange) {
    const base = _isNum(baseAttackRange) ? baseAttackRange : 2.1;
    return base + (kind === 2 ? 0.9 : 0.4);
  }

  function enemyAttackCooldown(kind) {
    return kind === 2 ? 2.4 : 1.6;
  }

  // ---- Directional damage indicators, damage vignette, and hit feedback rules ----
  const VIGNETTE_MAX_ALPHA = 0.85;
  const VIGNETTE_BASE_ALPHA = 0.25;
  const VIGNETTE_SCALE_DIVISOR = 30;
  const HIT_ARC_LIFE = 0.7;
  const HIT_ARC_FADE_START = 0.6;
  const HIT_ARC_MAX_OPACITY = 0.9;

  function damageVignetteAlpha(amount, baseAlpha, maxAlpha, divisor) {
    if (!_isPos(amount)) return 0;
    const b = _isNum(baseAlpha) ? baseAlpha : VIGNETTE_BASE_ALPHA;
    const m = _isNum(maxAlpha) ? maxAlpha : VIGNETTE_MAX_ALPHA;
    const d = _isPos(divisor) ? divisor : VIGNETTE_SCALE_DIVISOR;
    return Math.min(m, b + amount / d);
  }

  function damageVignetteStyle(alpha, isArmorOnly) {
    if (!_isPos(alpha)) {
      return 'inset 0 0 120px 40px rgba(180,0,0,0)';
    }
    const color = isArmorOnly ? 'rgba(79,163,216,' : 'rgba(180,0,0,';
    return 'inset 0 0 120px 40px ' + color + alpha.toFixed(3) + ')';
  }

  function worldBearing(fromX, fromZ, toX, toZ) {
    if (!_isNum(fromX) || !_isNum(fromZ) || !_isNum(toX) || !_isNum(toZ)) return 0;
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    if (dx === 0 && dz === 0) return 0;
    return (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
  }

  function screenHitAngle(worldBearingDeg, playerYawRad) {
    if (!_isNum(worldBearingDeg) || !_isNum(playerYawRad)) return 0;
    // Bearing where 0 = +z. Player forward = yaw.
    // Screen angle: 0 = attacker straight ahead, 90 = right, 180 = behind, 270 = left.
    const rel = ((worldBearingDeg - (playerYawRad * 180 / Math.PI)) % 360 + 360) % 360;
    return ((180 - rel) % 360 + 360) % 360;
  }

  function hitArcOpacity(age, life, fadeStartRatio, maxOpacity) {
    const l = _isPos(life) ? life : HIT_ARC_LIFE;
    const f = _isNum(fadeStartRatio) ? fadeStartRatio : HIT_ARC_FADE_START;
    const maxOp = _isNum(maxOpacity) ? maxOpacity : HIT_ARC_MAX_OPACITY;
    if (!_isNum(age) || age < 0 || age >= l) return 0;
    const fadeT = l * f;
    if (age <= fadeT) return maxOp;
    const dur = l - fadeT;
    if (dur <= 0) return 0;
    return Math.max(0, maxOp * (1 - (age - fadeT) / dur));
  }

  function hasActiveHitArcs(activeCount) {
    return _isNum(activeCount) && activeCount > 0;
  }

  function hitArcOpacityChanged(lastOpacity, curOpacity, epsilon) {
    if (!_isNum(lastOpacity)) return true;
    if (curOpacity <= 0 && lastOpacity > 0) return true;
    const eps = _isNum(epsilon) ? epsilon : 0.015;
    return Math.abs(curOpacity - lastOpacity) >= eps;
  }

  function syncHitArcOpacity(arcState, curOpacity) {
    if (_isObj(arcState)) {
      arcState.lastOp = _isNum(curOpacity) ? curOpacity : 0;
    }
  }

  // ---- Particle physics integration and change-driven HUD performance rules ----
  function stepParticlePhysics(x, y, z, vx, vy, vz, grav, dt, minY, out) {
    const target = out || { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };
    const stepDt = _isPos(dt) ? dt : 0;
    const g = _isNum(grav) ? grav : 9.8;
    const floor = _isNum(minY) ? minY : 0.02;
    const curVx = _isNum(vx) ? vx : 0;
    const curVy = _isNum(vy) ? vy : 0;
    const curVz = _isNum(vz) ? vz : 0;
    const curX = _isNum(x) ? x : 0;
    const curY = _isNum(y) ? y : 0;
    const curZ = _isNum(z) ? z : 0;

    let nvy = curVy - g * stepDt;
    let ny = curY + nvy * stepDt;
    let nvx = curVx;
    let nvz = curVz;
    let grounded = false;

    if (ny <= floor) {
      ny = floor;
      nvx = 0;
      nvy = 0;
      nvz = 0;
      grounded = true;
    }

    target.x = curX + nvx * stepDt;
    target.y = ny;
    target.z = curZ + nvz * stepDt;
    target.vx = nvx;
    target.vy = nvy;
    target.vz = nvz;
    target.grounded = grounded;
    return target;
  }

  function ammoHudChanged(lastState, ammo, reserve, reloading, isLow, isEmpty, prompt, weaponName, lethalCount, tacCount, isCharging) {
    if (!lastState || typeof lastState !== 'object') return true;
    return lastState.ammo !== ammo ||
           lastState.reserve !== reserve ||
           lastState.reloading !== reloading ||
           lastState.isLow !== isLow ||
           lastState.isEmpty !== isEmpty ||
           lastState.prompt !== prompt ||
           lastState.weaponName !== weaponName ||
           lastState.lethalCount !== lethalCount ||
           lastState.tacCount !== tacCount ||
           (isCharging !== undefined && lastState.isCharging !== isCharging);
  }

  function syncAmmoHudState(lastState, ammo, reserve, reloading, isLow, isEmpty, prompt, weaponName, lethalCount, tacCount, isCharging) {
    const target = _isObj(lastState) ? lastState : {};
    target.ammo = ammo;
    target.reserve = reserve;
    target.reloading = reloading;
    target.isLow = isLow;
    target.isEmpty = isEmpty;
    target.prompt = prompt;
    target.weaponName = weaponName;
    target.lethalCount = lethalCount;
    target.tacCount = tacCount;
    if (isCharging !== undefined) target.isCharging = isCharging;
    return target;
  }

  // ---- Health HUD change-detection rules ----
  // Pure diff and sync for the health/armor/plate HUD. updateHudHealth() runs every
  // animation frame (60 Hz); the vast majority of frames see no state change. A flat
  // equality check here costs one integer comparison per field and returns false
  // immediately on the first mismatch — far cheaper than repeating all DOM writes.
  // plates and plateInserting are included so the touch-plate button is also gated.
  function healthHudChanged(lastState, hp, maxHp, armor, plates, plateInserting) {
    if (!lastState || typeof lastState !== 'object') return true;
    return lastState.hp !== hp ||
           lastState.maxHp !== maxHp ||
           lastState.armor !== armor ||
           lastState.plates !== plates ||
           lastState.plateInserting !== plateInserting;
  }

  function syncHealthHudState(lastState, hp, maxHp, armor, plates, plateInserting) {
    const target = _isObj(lastState) ? lastState : {};
    target.hp = hp;
    target.maxHp = maxHp;
    target.armor = armor;
    target.plates = plates;
    target.plateInserting = plateInserting;
    return target;
  }

  // ---- Player Mobility, Stamina, Health Regen, and Resource Pickup Balance ----
  const SLIDE_DURATION = 0.9;
  const SLIDE_START_MUL = 1.2;
  const SLIDE_END_MUL = 0.5;
  const SLIDE_BOOST_MAX = 1.35;
  const SLIDE_BOOST_SCALE = 0.3;
  const SLIDE_JUMP_Y_MUL = 1.08;

  function slideSpeedAt(slideT, baseSprintSpeed, baseCrouchSpeed, duration, startMul, endMul) {
    const dur = _isPos(duration) ? duration : SLIDE_DURATION;
    const t = _isNum(slideT) ? _clamp01(slideT / dur) : 0;
    const sm = _isNum(startMul) ? startMul : SLIDE_START_MUL;
    const em = _isNum(endMul) ? endMul : SLIDE_END_MUL;
    const sprintSpd = _isNum(baseSprintSpeed) ? baseSprintSpeed : 8.1;
    const crouchSpd = _isNum(baseCrouchSpeed) ? baseCrouchSpeed : (sprintSpd * (em / sm));
    const startSpd = sprintSpd * sm;
    const endSpd = crouchSpd;
    return startSpd + (endSpd - startSpd) * t;
  }

  function slideJumpBoost(horizontalSpeed, maxSprintSpeed, maxBoost, scale) {
    const spd = _isNum(horizontalSpeed) ? Math.max(0, horizontalSpeed) : 0;
    const sprint = _isPos(maxSprintSpeed) ? maxSprintSpeed : 8.1;
    const mb = _isNum(maxBoost) ? maxBoost : SLIDE_BOOST_MAX;
    const sc = _isNum(scale) ? scale : SLIDE_BOOST_SCALE;
    return Math.min(mb, 1 + (spd / sprint) * sc);
  }

  function slideBaseSprintSpeed(baseSpeed, sprintMul, isTacSprint) {
    const base = _isPos(baseSpeed) ? baseSpeed : 5.4;
    const sMul = _isPos(sprintMul) ? sprintMul : 1.65;
    return base * sMul * (Boolean(isTacSprint) ? TAC_SPRINT_SPEED_MUL : 1.0);
  }

  const STAMINA_RECOVER_RATE = 2;
  const STAMINA_EXHAUST_RECOVER_RATIO = 0.2;

  function stepPlayerStamina(stamina, maxStamina, isSprinting, isTacSprint, dt, drainRate, tacDrainMul, recoverRate) {
    const s = _isNum(stamina) ? stamina : 0;
    const max = _isPos(maxStamina) ? maxStamina : 5;
    const d = _isPos(dt) ? dt : 0;
    if (isSprinting) {
      const drain = _isPos(drainRate) ? drainRate : 1;
      const tacMul = _isPos(tacDrainMul) ? tacDrainMul : 2.2;
      const burn = d * (isTacSprint ? tacMul : drain);
      return Math.max(0, s - burn);
    }
    const rec = _isPos(recoverRate) ? recoverRate : STAMINA_RECOVER_RATE;
    return Math.min(max, s + d * rec);
  }

  function isPlayerExhausted(stamina, wasExhausted, maxStamina, recoverRatio) {
    const s = _isNum(stamina) ? stamina : 0;
    if (s <= 0) return true;
    if (!wasExhausted) return false;
    const max = _isPos(maxStamina) ? maxStamina : 5;
    const ratio = _isNonNeg(recoverRatio) ? recoverRatio : STAMINA_EXHAUST_RECOVER_RATIO;
    return s <= max * ratio;
  }

  function canRegenHealth(downed, timeSinceDamage, regenDelay, health, maxHealth) {
    if (downed) return false;
    const since = _isNum(timeSinceDamage) ? timeSinceDamage : -1;
    const delay = _isPos(regenDelay) ? regenDelay : 4.0;
    if (since <= delay) return false;
    const hp = _isNum(health) ? health : 0;
    const max = _isPos(maxHealth) ? maxHealth : 100;
    return hp < max && hp > 0;
  }

  function stepHealthRegen(currentHealth, maxHealth, regenRate, diffRegenMul, dt) {
    const hp = _isNum(currentHealth) ? currentHealth : 0;
    const max = _isPos(maxHealth) ? maxHealth : 100;
    const rate = _isPos(regenRate) ? regenRate : 20;
    const diffMul = _isPos(diffRegenMul) ? diffRegenMul : 1;
    const d = _isPos(dt) ? dt : 0;
    return Math.min(max, hp + rate * diffMul * d);
  }

  const AMMO_PICKUP_MAG_RATIO = 1.5;
  const MEDKIT_HEAL_BASE = 35;
  const MEDKIT_ARMOR_BASE = 15;

  function ammoPickupRestore(currentReserve, reserveMax, magSize, perkMul) {
    const res = _isNum(currentReserve) ? Math.max(0, currentReserve) : 0;
    const max = _isPos(reserveMax) ? reserveMax : 120;
    const mag = _isPos(magSize) ? magSize : 30;
    const mul = _isPos(perkMul) ? perkMul : 1;
    const gained = Math.round(mag * AMMO_PICKUP_MAG_RATIO * mul);
    return Math.min(max, res + gained);
  }

  function medkitPickupRestore(currentHealth, maxHealth, currentArmor, maxArmor, perkMul, out) {
    const o = out || { health: 0, armor: 0 };
    const hp = _isNum(currentHealth) ? Math.max(0, currentHealth) : 0;
    const maxHp = _isPos(maxHealth) ? maxHealth : 100;
    const arm = _isNum(currentArmor) ? Math.max(0, currentArmor) : 0;
    const maxArm = _isPos(maxArmor) ? maxArmor : 50;
    const mul = _isPos(perkMul) ? perkMul : 1;
    const heal = Math.round(MEDKIT_HEAL_BASE * mul);
    const armorHeal = Math.round(MEDKIT_ARMOR_BASE * mul);
    o.health = Math.min(maxHp, hp + heal);
    o.armor = Math.min(maxArm, arm + armorHeal);
    return o;
  }

  // ---- Minimap & Compass 2D Canvas Performance ----
  function filterMinimapColliders(colliders, minHeight) {
    const out = [];
    if (!colliders || !colliders.length) return out;
    const hFloor = _isNum(minHeight) ? minHeight : 0.6;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c || !c.min || !c.max) continue;
      if (typeof c.max.y !== 'number' || c.max.y < hFloor) continue;
      const minX = c.min.x, minZ = c.min.z;
      const maxX = c.max.x, maxZ = c.max.z;
      if (!isFinite(minX) || !isFinite(minZ) || !isFinite(maxX) || !isFinite(maxZ)) continue;
      out.push({
        minX,
        minZ,
        w: maxX - minX,
        d: maxZ - minZ
      });
    }
    return out;
  }

  function isMinimapBlockVisible(minX, minZ, w, d, px, pz, scale, maxDistSq) {
    if (!isFinite(minX) || !isFinite(minZ) || !isFinite(px) || !isFinite(pz) || !isFinite(scale)) return false;
    const x = (minX - px) * scale, z = (minZ - pz) * scale;
    const limit = (_isNum(maxDistSq)) ? maxDistSq : Infinity;
    return (x * x + z * z) <= limit;
  }

  function compassHeading(yawRad) {
    if (!_isNum(yawRad)) return 0;
    return ((-yawRad * 180 / Math.PI) % 360 + 360) % 360;
  }

  function compassTickOffset(dispDeg, heading) {
    if (!isFinite(dispDeg) || !isFinite(heading)) return 0;
    return (dispDeg - heading + 540) % 360 - 180;
  }

  const COMPASS_CARDINALS = {
    0: 'N',
    45: 'NE',
    90: 'E',
    135: 'SE',
    180: 'S',
    225: 'SW',
    270: 'W',
    315: 'NW'
  };
  function compassCardinalLabel(deg) {
    if (!_isNum(deg)) return null;
    const norm = ((Math.round(deg) % 360) + 360) % 360;
    return COMPASS_CARDINALS[norm] || null;
  }

  // ---- Combat Enemies Evaluation ----
  function evaluateCombatEnemies(enemies, px, pz, out) {
    let aliveCount = 0;
    let nearestSq = Infinity;
    if (enemies && enemies.length) {
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e || e.dead || !e.pos) continue;
        aliveCount++;
        const dx = e.pos.x - px, dz = e.pos.z - pz;
        const dSq = dx * dx + dz * dz;
        if (dSq < nearestSq) nearestSq = dSq;
      }
    }
    const nearest = isFinite(nearestSq) ? Math.sqrt(nearestSq) : undefined;
    if (_isObj(out)) {
      out.aliveCount = aliveCount;
      out.nearestEnemy = nearest;
      return out;
    }
    return { aliveCount, nearestEnemy: nearest };
  }

  // ---- Sniper Marksman Sway, Steady Aim, Recoil Recovery, and Aim Assist Balance ----
  const STEADY_MAX = 2.2;
  const STEADY_RECOVER = 2.2;
  const ADS_SCOPE_THRESHOLD = 0.8;
  const SCOPE_LOCKED_THRESHOLD = 0.82;
  const RECOIL_DECAY_RATE = 0.02;

  function isSteadyActive(weaponType, adsAmount, isHoldingShift, steadyT) {
    if (weaponType !== 'SR') return false;
    const ads = _isNum(adsAmount) ? adsAmount : 0;
    const t = _isNum(steadyT) ? steadyT : 0;
    return ads > ADS_SCOPE_THRESHOLD && Boolean(isHoldingShift) && t > 0;
  }

  function stepSteadyAim(steadyT, steadyActive, dt, maxTime, recoverRate) {
    const t = _isNum(steadyT) ? steadyT : 0;
    const d = _isPos(dt) ? dt : 0;
    const max = _isPos(maxTime) ? maxTime : STEADY_MAX;
    const rec = _isPos(recoverRate) ? recoverRate : STEADY_RECOVER;
    if (steadyActive) {
      return Math.max(0, t - d);
    }
    return Math.min(max, t + d * rec);
  }

  function swayAmplitude(baseAmp, steadyActive, steadyMul, weaponSwayMul) {
    const base = _isNum(baseAmp) ? baseAmp : 0.0042;
    const sm = steadyActive ? (_isNum(steadyMul) ? steadyMul : 0.14) : 1.0;
    const wSway = _isPos(weaponSwayMul) ? weaponSwayMul : 1.0;
    return base * sm * wSway;
  }

  function swayOffsets(phase, amp, out) {
    const p = _isNum(phase) ? phase : 0;
    const a = _isNum(amp) ? amp : 0;
    const x = Math.sin(p * 1.7) * a + Math.sin(p * 0.9) * a * 0.6;
    const y = Math.sin(p * 1.3 + 1.2) * a * 0.8;
    if (_isObj(out)) {
      out.x = x;
      out.y = y;
      return out;
    }
    return { x, y };
  }

  function isScoped(adsAmount, weaponType) {
    const ads = _isNum(adsAmount) ? adsAmount : 0;
    return ads > SCOPE_LOCKED_THRESHOLD && weaponType === 'SR';
  }

  function recoilDecay(recoilVal, dt, baseDecayRate) {
    const val = _isNum(recoilVal) ? recoilVal : 0;
    const d = _isPos(dt) ? dt : 0;
    const rate = _isPos(baseDecayRate) ? baseDecayRate : RECOIL_DECAY_RATE;
    return val * Math.pow(rate, d);
  }

  function aimAssistAngle(baseAngle, isSteady, steadyBonusMul) {
    const base = _isNum(baseAngle) ? baseAngle : 0.14;
    const bonus = _isNum(steadyBonusMul) ? steadyBonusMul : 1.6;
    return base * (isSteady ? bonus : 1.0);
  }

  function aimAssistPull(baseStrength, pullRatio) {
    const base = _isNum(baseStrength) ? baseStrength : 2.2;
    const ratio = _isNum(pullRatio) ? pullRatio : 0.25;
    return Math.min(1.0, base * ratio);
  }

  const AIM_ASSIST_FORWARD_MIN_DOT = 0.0;

  function isAimCandidateInForwardSector(dirX, dirZ, toX, toZ, minDot) {
    const threshold = (_isNum(minDot)) ? minDot : AIM_ASSIST_FORWARD_MIN_DOT;
    return (dirX * toX + dirZ * toZ) > threshold;
  }

  function isAngleWithinThreshold(dotProduct, maxAngleCos) {
    return dotProduct > maxAngleCos;
  }

  const AIM_ASSIST_MAX_DIST = 48.0;

  function isTargetInAimAssistRange(toX, toZ, maxDistSq) {
    if (!_isNum(toX) || !_isNum(toZ)) return false;
    const limitSq = _isPos(maxDistSq)
      ? maxDistSq : (AIM_ASSIST_MAX_DIST * AIM_ASSIST_MAX_DIST);
    return (toX * toX + toZ * toZ) <= limitSq;
  }

  function aimAssistMinCos(baseAngle, isSteady, steadyBonusMul) {
    return Math.cos(aimAssistAngle(baseAngle, isSteady, steadyBonusMul));
  }

  function isAimAssistCandidateCloser(candidateCos, currentBestCos) {
    return (_isNum(candidateCos)) && candidateCos > currentBestCos;
  }

  function hasAimAssistNudge(nudgedDir, baseDir) {
    if (!nudgedDir || !baseDir) return false;
    return nudgedDir !== baseDir;
  }

  const ENEMY_RAY_BOUNDING_RADIUS = 1.8, ENEMY_RAY_CENTER_OFFSET_Y = 0.9;
  function isEnemyRayCandidate(fromX, fromY, fromZ, dirX, dirY, dirZ, maxDist, enX, enY, enZ, boundRadius, centerOffsetY) {
    if (!_isNum(fromX) || !_isNum(fromY) || !_isNum(fromZ) ||
        !_isNum(dirX) || !_isNum(dirY) || !_isNum(dirZ) ||
        !_isNum(enX) || !_isNum(enY) || !_isNum(enZ)) return false;
    const maxD = _isPos(maxDist) ? maxDist : 0;
    if (maxD <= 0) return false;
    const r = _isPos(boundRadius) ? boundRadius : ENEMY_RAY_BOUNDING_RADIUS;
    const cy = _isNum(centerOffsetY) ? centerOffsetY : ENEMY_RAY_CENTER_OFFSET_Y;
    const dx = enX - fromX, dy = (enY + cy) - fromY, dz = enZ - fromZ;
    const proj = dx * dirX + dy * dirY + dz * dirZ;
    if (proj < -r || proj > maxD + r) return false;
    const perpSq = (dx * dx + dy * dy + dz * dz) - (proj * proj);
    return perpSq <= r * r;
  }

  const CROSSHAIR_MIN_GAP_OFFSET = 0;
  const CROSSHAIR_MAX_GAP_OFFSET = 24;

  function crosshairGapOffset(spread, adsAmount, isReducedMotion) {
    if (isReducedMotion) return 0;
    const ads = _isNum(adsAmount) ? _clamp01(adsAmount) : 0;
    if (ads > 0) {
      return -Math.round(ads * 6);
    }
    const s = _isNum(spread) ? Math.max(0, spread) : 0;
    const offset = Math.round((s - 0.010) * 220);
    return Math.max(CROSSHAIR_MIN_GAP_OFFSET, Math.min(CROSSHAIR_MAX_GAP_OFFSET, offset));
  }

  function crosshairOpacity(adsAmount, isScopedWeapon, isDead) {
    if (isDead) return 0;
    const ads = _isNum(adsAmount) ? _clamp01(adsAmount) : 0;
    if (isScopedWeapon) {
      if (ads >= 0.75) return 0;
      if (ads <= 0.30) return 1;
      return Math.max(0, Math.min(1, 1 - (ads - 0.30) / 0.45));
    }
    if (ads >= 0.70) return 0;
    return _clamp01(1 - ads / 0.70);
  }

  function sprintIndicatorState(isTacSprint, isSliding, isExhausted) {
    if (isExhausted) return 'exhausted';
    if (isSliding) return 'slide';
    if (isTacSprint) return 'tac';
    return '';
  }

  function sprintIndicatorLabel(state) {
    if (state === 'exhausted') return 'EXHAUSTED';
    if (state === 'slide') return 'SLIDE';
    if (state === 'tac') return 'TAC SPRINT';
    return '';
  }

  // Tactical camera dynamics, dynamic FOV scaling, and procedural roll rules
  const SNIPER_ADS_ZOOM = 52;
  const DEFAULT_ADS_ZOOM = 24;
  const SLIDE_FOV_BOOST = 6;
  const TAC_SPRINT_FOV_BOOST = 4;
  const CAMERA_MIN_FOV = 20;
  const CAMERA_MAX_FOV = 130;
  const CAMERA_BOB_X_SCALE = 0.025;
  const CAMERA_BOB_Y_SCALE = 0.05;
  const CAMERA_SLIDE_DIP = 0.45;
  const CAMERA_BOB_ROLL_SCALE = 0.008;
  const CAMERA_SLIDE_ROLL = 0.16;
  const CAMERA_STRAFE_ROLL_SCALE = 0.012;

  function weaponAdsZoom(weaponType) {
    return weaponType === 'SR' ? SNIPER_ADS_ZOOM : DEFAULT_ADS_ZOOM;
  }

  function mobilityFovBoost(isSliding, isTacSprint, adsAmount, isReducedMotion) {
    if (isReducedMotion) return 0;
    const ads = _isNum(adsAmount) ? adsAmount : 0;
    if (ads > 0.5) return 0;
    if (isSliding) return SLIDE_FOV_BOOST;
    if (isTacSprint) return TAC_SPRINT_FOV_BOOST;
    return 0;
  }

  function targetCameraFov(baseSettingFov, adsAmount, weaponZoom, mobilityBoost) {
    const fov = _isNum(baseSettingFov) ? baseSettingFov : 75;
    const ads = _isNum(adsAmount) ? _clamp01(adsAmount) : 0;
    const zoom = _isNum(weaponZoom) ? weaponZoom : DEFAULT_ADS_ZOOM;
    const boost = _isNum(mobilityBoost) ? mobilityBoost : 0;
    const target = fov - ads * zoom + boost;
    return Math.max(CAMERA_MIN_FOV, Math.min(CAMERA_MAX_FOV, target));
  }

  function strafeDirection(keyA, keyD, analogX) {
    if (_isNum(analogX) && Math.abs(analogX) > 0.15) {
      return analogX < 0 ? -1 : 1;
    }
    const a = !!keyA, d = !!keyD;
    if (a && !d) return -1;
    if (d && !a) return 1;
    return 0;
  }

  function cameraRoll(bobPhase, bobAmp, slideBlend, strafeDir, isReducedMotion, swayX, isScoped) {
    const motionMul = isReducedMotion ? 0 : 1;
    const phase = _isNum(bobPhase) ? bobPhase : 0;
    const amp = _isNum(bobAmp) ? bobAmp : 0;
    const slide = _isNum(slideBlend) ? _clamp01(slideBlend) : 0;
    const strafe = _isNum(strafeDir) ? Math.max(-1, Math.min(1, strafeDir)) : 0;
    const bobRoll = Math.sin(phase) * amp * CAMERA_BOB_ROLL_SCALE;
    const slideRoll = slide * CAMERA_SLIDE_ROLL;
    const strafeRoll = strafe * CAMERA_STRAFE_ROLL_SCALE;
    const motionRoll = (bobRoll + slideRoll + strafeRoll) * motionMul;
    const sx = _isNum(swayX) ? swayX : 0;
    const swayRoll = isScoped ? sx * 0.5 : 0;
    return motionRoll + swayRoll;
  }

  function cameraPositionOffsets(bobPhase, bobAmp, slideBlend, isReducedMotion, out) {
    const o = out || { x: 0, y: 0 };
    if (isReducedMotion) {
      o.x = 0;
      o.y = 0;
      return o;
    }
    const phase = _isNum(bobPhase) ? bobPhase : 0;
    const amp = _isNum(bobAmp) ? bobAmp : 0;
    const slide = _isNum(slideBlend) ? _clamp01(slideBlend) : 0;
    o.x = Math.sin(phase) * amp * CAMERA_BOB_X_SCALE;
    o.y = Math.abs(Math.sin(phase)) * amp * CAMERA_BOB_Y_SCALE - slide * CAMERA_SLIDE_DIP;
    return o;
  }

  // Locomotion balance, air control physics, jump grace timing, head-bob step physics, and weapon recoil/ADS balance rules
  const TAC_SPRINT_SPEED_MUL = 1.25;
  const LAND_STUN_SPEED_MUL = 0.55;
  const ADS_MOVE_SPEED_MUL = 0.65;
  const AIR_SLIDE_ACCEL_RATE = 4;
  const AIR_MOVE_ACCEL_RATE = 7;
  const GROUND_DECEL_DEFAULT = 38;
  const VELOCITY_SNAP_THRESHOLD = 0.05;
  const BOB_SPEED_THRESHOLD = 0.5;
  const BOB_FREQ_SPRINT = 13;
  const BOB_FREQ_WALK = 9;
  const BOB_SPEED_SCALE = 6;
  const BOB_GROW_RATE = 6;
  const BOB_DECAY_RATE = 8;
  const LAND_STUN_BASE_TIME = 0.25;
  const LAND_STUN_SCALE = 0.5;
  const COYOTE_TIME = 0.12;
  const JUMP_BUFFER_TIME = 0.15;
  const ADS_BASE_SPEED = 12;
  const GUN_SWITCH_SPEED = 3.5;
  const WEAPON_SWITCH_SPEED_SMG = 4.6;
  const WEAPON_SWITCH_SPEED_AR = 3.6;
  const WEAPON_SWITCH_SPEED_BR = 3.0;
  const WEAPON_SWITCH_SPEED_SR = 2.4;
  const FAST_HANDS_SWITCH_MUL = 1.35, EMPTY_SWAP_SPEED_MUL = 1.25;
  const WEAPON_STF_SMG = 0.12, WEAPON_STF_AR = 0.18, WEAPON_STF_BR = 0.24, WEAPON_STF_SR = 0.32;
  const TAC_SPRINT_STF_MUL = 1.45, FAST_HANDS_STF_MUL = 0.80;
  const PLATE_MOVE_SPEED_MUL = 0.78;
  const WEAPON_ADS_SPEED_SMG = 1.25;
  const WEAPON_ADS_SPEED_AR = 1.00;
  const WEAPON_ADS_SPEED_BR = 0.88;
  const WEAPON_ADS_SPEED_SR = 0.70;
  const WEAPON_ADS_MOVE_SMG = 1.20;
  const WEAPON_ADS_MOVE_AR = 1.00;
  const WEAPON_ADS_MOVE_BR = 0.88;
  const WEAPON_ADS_MOVE_SR = 0.70;
  const SNIPER_UNSCOPE_FACTOR = 0.45;
  const SHOT_KICK_IMPULSE = 0.5;
  const SHOT_KICK_MAX = 1.4;
  const SHOT_KICK_DECAY_BASE = 0.001;

  function playerMoveSpeed(baseSpeed, analogMag, isSprinting, isTacSprint, isDowned, isLandStun, isCrouching, isAds, sprintMul, crouchMul, weaponMoveMul, isPlating) {
    const base = _isNum(baseSpeed) ? Math.max(0, baseSpeed) : 5.4;
    const mag = _isNum(analogMag) ? _clamp01(analogMag) : 1;
    let spd = base * mag;
    const sMul = _isNum(sprintMul) ? sprintMul : 1.65;
    const cMul = _isNum(crouchMul) ? crouchMul : 0.55;
    const wMul = _isNum(weaponMoveMul) ? Math.max(0.1, weaponMoveMul) : 1;

    if (isSprinting) spd *= sMul * (isTacSprint ? TAC_SPRINT_SPEED_MUL : 1);
    if (isDowned) spd *= DOWN_SPEED_MUL;
    if (isLandStun) spd *= LAND_STUN_SPEED_MUL;
    if (isCrouching) spd *= cMul;
    if (isAds) spd *= ADS_MOVE_SPEED_MUL * wMul;
    if (isPlating) spd *= PLATE_MOVE_SPEED_MUL;
    return Math.max(0, spd);
  }

  function movementAccelRate(onGround, isSliding, hasInput, groundAccel, groundDecel) {
    if (!onGround) return isSliding ? AIR_SLIDE_ACCEL_RATE : AIR_MOVE_ACCEL_RATE;
    const accel = _isNum(groundAccel) ? groundAccel : 16;
    const decel = _isNum(groundDecel) ? groundDecel : GROUND_DECEL_DEFAULT;
    return hasInput ? accel : decel;
  }

  function stepHorizontalVelocity(currentVx, currentVz, targetVx, targetVz, rate, dt, onGround, hasInput, out) {
    const o = out || { x: 0, z: 0 };
    const cvx = _isNum(currentVx) ? currentVx : 0;
    const cvz = _isNum(currentVz) ? currentVz : 0;
    const tvx = _isNum(targetVx) ? targetVx : 0;
    const tvz = _isNum(targetVz) ? targetVz : 0;
    const r = _isNum(rate) ? Math.max(0, rate) : 16;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const blend = Math.min(1, r * delta);

    let vx = cvx + (tvx - cvx) * blend;
    let vz = cvz + (tvz - cvz) * blend;
    if (onGround && !hasInput && Math.hypot(vx, vz) < VELOCITY_SNAP_THRESHOLD) {
      vx = 0;
      vz = 0;
    }
    o.x = vx;
    o.z = vz;
    return o;
  }

  function stepHeadBob(bobPhase, bobAmp, onGround, horizontalSpeed, isSprinting, dt, out) {
    const o = out || { phase: 0, amp: 0 };
    const p = _isNum(bobPhase) ? bobPhase : 0;
    const a = _isNum(bobAmp) ? _clamp01(bobAmp) : 0;
    const spd = _isNum(horizontalSpeed) ? Math.max(0, horizontalSpeed) : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;

    if (onGround && spd > BOB_SPEED_THRESHOLD) {
      const freq = isSprinting ? BOB_FREQ_SPRINT : BOB_FREQ_WALK;
      o.phase = p + delta * freq;
      const targetAmp = Math.min(1, spd / BOB_SPEED_SCALE);
      o.amp = a + (targetAmp - a) * Math.min(1, BOB_GROW_RATE * delta);
    } else {
      o.phase = p;
      o.amp = a + (0 - a) * Math.min(1, BOB_DECAY_RATE * delta);
    }
    return o;
  }

  function landingStunDuration(landingSpeedMul) {
    const mul = _isNum(landingSpeedMul) ? _clamp01(landingSpeedMul) : 1;
    return LAND_STUN_BASE_TIME + (1 - mul) * LAND_STUN_SCALE;
  }

  function stepJumpTimers(coyoteT, jumpBufT, onGround, jumpPressed, dt, out) {
    const o = out || { coyoteT: 0, jumpBufT: 0 };
    const cT = _isNum(coyoteT) ? Math.max(0, coyoteT) : 0;
    const jT = _isNum(jumpBufT) ? Math.max(0, jumpBufT) : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;

    o.coyoteT = onGround ? COYOTE_TIME : Math.max(0, cT - delta);
    o.jumpBufT = jumpPressed ? JUMP_BUFFER_TIME : Math.max(0, jT - delta);
    return o;
  }

  function canInitiateJump(jumpBufT, coyoteT, isCrouching, isSliding, isDowned, landStunT) {
    const jb = _isNum(jumpBufT) ? jumpBufT : 0;
    const ct = _isNum(coyoteT) ? coyoteT : 0;
    const ls = _isNum(landStunT) ? landStunT : 0;
    return jb > 0 && ct > 0 && !isCrouching && !isSliding && !isDowned && ls <= 0;
  }

  function stepAdsTransition(currentAds, wantAds, dt, perkMul, weaponAdsSpeed) {
    const cur = _isNum(currentAds) ? _clamp01(currentAds) : 0;
    const target = wantAds ? 1 : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const pMul = _isNum(perkMul) ? Math.max(0.1, perkMul) : 1;
    const wSpeed = _isNum(weaponAdsSpeed) ? Math.max(0.1, weaponAdsSpeed) : 1;
    const rate = ADS_BASE_SPEED * pMul * wSpeed;
    return cur + (target - cur) * Math.min(1, rate * delta);
  }

  function stepGunSwitch(currentSwitchT, dt, speed) {
    const cur = _isNum(currentSwitchT) ? _clamp01(currentSwitchT) : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const spd = _isNum(speed) ? Math.max(0.1, speed) : GUN_SWITCH_SPEED;
    return Math.min(1, cur + delta * spd);
  }

  function weaponSwitchSpeed(weaponType, hasFastHands, isEmpty) {
    let base = GUN_SWITCH_SPEED;
    if (weaponType === 'SMG') base = WEAPON_SWITCH_SPEED_SMG;
    else if (weaponType === 'AR') base = WEAPON_SWITCH_SPEED_AR;
    else if (weaponType === 'BR') base = WEAPON_SWITCH_SPEED_BR;
    else if (weaponType === 'SR') base = WEAPON_SWITCH_SPEED_SR;
    let spd = hasFastHands ? base * FAST_HANDS_SWITCH_MUL : base;
    if (isEmpty) spd *= EMPTY_SWAP_SPEED_MUL;
    return spd;
  }

  function weaponSprintToFireTime(weaponType, isTacSprint, hasFastHands) {
    let base = WEAPON_STF_AR;
    if (weaponType === 'SMG') base = WEAPON_STF_SMG;
    else if (weaponType === 'BR') base = WEAPON_STF_BR;
    else if (weaponType === 'SR') base = WEAPON_STF_SR;
    let stf = isTacSprint ? base * TAC_SPRINT_STF_MUL : base;
    if (hasFastHands) stf *= FAST_HANDS_STF_MUL;
    return stf;
  }

  const STANCE_ADS_CROUCH_MUL = 1.15, STANCE_ADS_SLIDE_MUL = 0.80;
  function stanceAdsSpeedMultiplier(isCrouching, isSliding) {
    if (isSliding) return STANCE_ADS_SLIDE_MUL;
    if (isCrouching) return STANCE_ADS_CROUCH_MUL;
    return 1.0;
  }

  function weaponAdsSpeed(weaponType, customSpeed, stanceMul) {
    let base = WEAPON_ADS_SPEED_AR;
    if (_isPos(customSpeed)) base = customSpeed;
    else if (weaponType === 'SMG') base = WEAPON_ADS_SPEED_SMG;
    else if (weaponType === 'AR') base = WEAPON_ADS_SPEED_AR;
    else if (weaponType === 'BR') base = WEAPON_ADS_SPEED_BR;
    else if (weaponType === 'SR') base = WEAPON_ADS_SPEED_SR;
    const sm = _isPos(stanceMul) ? stanceMul : 1.0;
    return base * sm;
  }

  function weaponAdsMoveMultiplier(weaponType, customMultiplier) {
    if (_isPos(customMultiplier)) return customMultiplier;
    if (weaponType === 'SMG') return WEAPON_ADS_MOVE_SMG;
    if (weaponType === 'AR') return WEAPON_ADS_MOVE_AR;
    if (weaponType === 'BR') return WEAPON_ADS_MOVE_BR;
    if (weaponType === 'SR') return WEAPON_ADS_MOVE_SR;
    return WEAPON_ADS_MOVE_AR;
  }

  function applyShotKick(currentKick, impulse, maxKick) {
    const cur = _isNum(currentKick) ? Math.max(0, currentKick) : 0;
    const imp = _isNum(impulse) ? impulse : SHOT_KICK_IMPULSE;
    const mx = _isNum(maxKick) ? maxKick : SHOT_KICK_MAX;
    return Math.min(cur + imp, mx);
  }

  function decayShotKick(currentKick, dt, decayBase) {
    const cur = _isNum(currentKick) ? Math.max(0, currentKick) : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const base = _isPos(decayBase) ? decayBase : SHOT_KICK_DECAY_BASE;
    return cur * Math.pow(base, delta);
  }

  function sniperUnscopeAds(adsAmount, factor) {
    const cur = _isNum(adsAmount) ? _clamp01(adsAmount) : 0;
    const f = _isNum(factor) ? factor : SNIPER_UNSCOPE_FACTOR;
    return cur * f;
  }

  // ---- HUD Churn & Overlay Performance Rules (v90) ---------------------------
  const SLIDE_VIGNETTE_RATE = 14;
  const SLIDE_VIGNETTE_MAX_ALPHA = 0.55;

  function stepSlideVignette(curOpacity, wantSlide, dt, rate) {
    const cur = _isNum(curOpacity) ? _clamp01(curOpacity) : 0;
    const target = wantSlide ? 1 : 0;
    if (cur === target) return target;
    const r = _isPos(rate) ? rate : SLIDE_VIGNETTE_RATE;
    const delta = _isPos(dt) ? dt : 0;
    const step = Math.min(1, r * delta);
    const next = cur + (target - cur) * step;
    if (Math.abs(next - target) < 0.005) return target;
    return _clamp01(next);
  }

  function slideVignetteStyle(opacity, maxAlpha) {
    const op = _isNum(opacity) ? _clamp01(opacity) : 0;
    const ma = _isNonNeg(maxAlpha) ? maxAlpha : SLIDE_VIGNETTE_MAX_ALPHA;
    const a = Math.round((op * ma) * 1000) / 1000;
    return 'inset 0 0 90px 30px rgba(0,0,0,' + a + ')';
  }

  function objectiveLabel(inside, pct) {
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    return inside ? 'HOLDING — ' + p + '%' : 'RETURN TO THE ZONE — ' + p + '%';
  }

  function objectiveHudChanged(lastState, visible, inside, pct) {
    if (!lastState) return true;
    const vis = !!visible;
    if (lastState.visible !== vis) return true;
    if (!vis) return false;
    const ins = !!inside;
    const p = Math.round(pct || 0);
    return lastState.inside !== ins || lastState.pct !== p;
  }

  function syncObjectiveHudState(lastState, visible, inside, pct) {
    if (!lastState) return;
    lastState.visible = !!visible;
    lastState.inside = !!inside;
    lastState.pct = Math.round(pct || 0);
  }

  function isScopeOverlayActive(adsAmount, weaponType) {
    const ads = _isNum(adsAmount) ? adsAmount : 0;
    const type = String(weaponType || '').toUpperCase();
    return ads > 0.75 && (type === 'BR' || type === 'SR');
  }

  function scopeOverlayChanged(lastState, wantScope, isSniper) {
    if (!lastState) return true;
    const want = !!wantScope;
    if (lastState.active !== want) return true;
    if (!want) return false;
    return lastState.isSniper !== !!isSniper;
  }

  function syncScopeOverlayState(lastState, wantScope, isSniper) {
    if (!lastState) return;
    lastState.active = !!wantScope;
    lastState.isSniper = !!isSniper;
  }

  function isSteadyIndicatorVisible(weaponType, adsAmount) {
    const type = String(weaponType || '').toUpperCase();
    const ads = _isNum(adsAmount) ? adsAmount : 0;
    return type === 'SR' && ads > 0.8;
  }

  function steadyIndicatorLabel(steadyActive, steadyT) {
    if (steadyActive) {
      const t = Math.max(0, _isNum(steadyT) ? steadyT : 0);
      return 'STEADY · ' + (Math.ceil(t * 10) / 10) + 's';
    }
    const t = _isNum(steadyT) ? steadyT : 0;
    return t < 0.25 ? 'CATCH YOUR BREATH' : 'HOLD SHIFT TO STEADY';
  }

  function steadyIndicatorChanged(lastState, visible, steadyActive, label) {
    if (!lastState) return true;
    const vis = !!visible;
    if (lastState.visible !== vis) return true;
    if (!vis) return false;
    return lastState.steadyActive !== !!steadyActive || lastState.label !== label;
  }

  function syncSteadyIndicatorState(lastState, visible, steadyActive, label) {
    if (!lastState) return;
    lastState.visible = !!visible;
    lastState.steadyActive = !!steadyActive;
    lastState.label = label;
  }

  // ---- Adaptive music parameter dynamics ----
  const MUSIC_RISE_RATE = 1.6;
  const MUSIC_FALL_RATE = 0.5;
  const MUSIC_BASE_BUS_GAIN = 0.22;
  const MUSIC_INTENSITY_BUS_SCALE = 0.5;

  function stepMusicIntensity(currentIntensity, targetIntensity, dt, riseRate, fallRate) {
    const cur = (_isNum(currentIntensity)) ? currentIntensity : 0;
    const tgt = (_isNum(targetIntensity)) ? _clamp01(targetIntensity) : 0;
    const d = _isPos(dt) ? dt : 0;
    const rRise = _isPos(riseRate) ? riseRate : MUSIC_RISE_RATE;
    const rFall = _isPos(fallRate) ? fallRate : MUSIC_FALL_RATE;
    const rate = tgt > cur ? rRise : rFall;
    const blend = rate * d;
    if (blend >= 1) return tgt;
    const next = cur + (tgt - cur) * blend;
    return _clamp01(next);
  }

  function musicBusGain(volumeSetting, intensity) {
    const vol = (_isNum(volumeSetting)) ? _clamp01(volumeSetting) : 0;
    const i = (_isNum(intensity)) ? _clamp01(intensity) : 0;
    return vol * (MUSIC_BASE_BUS_GAIN + i * MUSIC_INTENSITY_BUS_SCALE);
  }

  // ---- Adaptive score: chart, layers and patterns ----
  // The old score was a sawtooth drone held on one chord plus a noise "heartbeat"
  // gated per frame (which crackled at low frame rates). This is a real cue: a
  // i-VI-iv-V progression in D minor, built in layers that enter with the fight.
  // Calm is a pad and a distant boom; combat adds bass ostinato, drums, brass
  // swells and finally a sixteenth-note string arpeggio. Everything here is pure
  // data and rules; 50_vfx_audio.js turns it into scheduled notes.
  const MUSIC_BPM = 104;
  const MUSIC_STEPS_PER_BAR = 16;
  const MUSIC_BARS_PER_CHORD = 2;
  const MUSIC_CHART = [
    { name: 'Dm', root: 38, notes: [50, 53, 57] },
    { name: 'Bb', root: 34, notes: [46, 50, 53] },
    { name: 'Gm', root: 31, notes: [43, 46, 50] },
    // major V: the C# pulls back home
    { name: 'A',  root: 33, notes: [45, 49, 52] }
  ];
  const MUSIC_PHRASE_BARS = MUSIC_CHART.length * MUSIC_BARS_PER_CHORD;
  const MUSIC_ARP_SHAPE = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 2, 3];

  function musicClamp01(v) {
    return (typeof v === 'number' && isFinite(v)) ? Math.max(0, Math.min(1, v)) : 0;
  }
  function musicSmooth(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
  function musicStepSeconds(bpm) {
    const b = (typeof bpm === 'number' && isFinite(bpm) && bpm > 0) ? bpm : MUSIC_BPM;
    return 60 / b / 4;
  }
  function midiToHz(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }
  function musicChordAt(bar) {
    const b = (typeof bar === 'number' && isFinite(bar) && bar > 0) ? Math.floor(bar) : 0;
    return MUSIC_CHART[Math.floor(b / MUSIC_BARS_PER_CHORD) % MUSIC_CHART.length];
  }
  function musicChordChanges(step) {
    const s = (typeof step === 'number' && isFinite(step) && step > 0) ? Math.floor(step) : 0;
    return s % (MUSIC_STEPS_PER_BAR * MUSIC_BARS_PER_CHORD) === 0;
  }

  // Layer levels by intensity. The pad never leaves (silence between waves reads
  // as a bug), but steps back as the rhythm section comes in.
  function musicLayerGains(intensity) {
    const i = musicClamp01(intensity);
    return {
      pad: 0.55 - 0.2 * i,
      drums: 0.35 + 0.65 * musicSmooth(0.05, 0.5, i),
      bass: musicSmooth(0.15, 0.45, i),
      horn: musicSmooth(0.45, 0.8, i),
      arp: musicSmooth(0.6, 0.95, i)
    };
  }

  // Drum hits for one sixteenth step, as velocities 0..1 (0 = silent). Density is
  // tiered so the groove changes character rather than just getting louder.
  function musicDrumHits(step, intensity) {
    const n = (typeof step === 'number' && isFinite(step) && step > 0) ? Math.floor(step) : 0;
    const i = musicClamp01(intensity);
    const s = n % MUSIC_STEPS_PER_BAR;
    const bar = Math.floor(n / MUSIC_STEPS_PER_BAR);
    const hits = { boom: 0, kick: 0, snare: 0, hat: 0, tom: 0 };
    // distant taiko on the downbeat, heavier where the chord changes
    if (s === 0) hits.boom = musicChordChanges(n) ? 0.9 : 0.55;
    if (i < 0.15) {
      if (s === 10) hits.boom = 0.35;
      return hits;
    }
    if (s === 0 || s === 8) hits.kick = 0.9;
    if (s % 4 === 2) hits.hat = 0.35;
    if (i >= 0.45) {
      if (s === 4 || s === 12) hits.snare = 0.85;
      if (s === 7 || s === 10) hits.kick = 0.6;
      if (s % 2 === 0) hits.hat = s % 4 === 2 ? 0.5 : 0.3;
    }
    if (i >= 0.75) {
      hits.hat = Math.max(hits.hat, s % 2 ? 0.22 : 0.45);
      if (s === 14) hits.kick = 0.55;
      // fill into the top of the phrase
      if (bar % MUSIC_PHRASE_BARS === MUSIC_PHRASE_BARS - 1 && s >= 12) {
        hits.tom = 0.6 + (s - 12) * 0.1;
        hits.snare = s === 15 ? 0.9 : 0;
        hits.hat = 0;
      }
    }
    return hits;
  }

  // Bass ostinato on the chord root: a driving 3-3-2 figure, filled to straight
  // eighths with octave jumps once the fight is at full tilt. -1 = rest.
  function musicBassNote(step, intensity) {
    const n = (typeof step === 'number' && isFinite(step) && step > 0) ? Math.floor(step) : 0;
    const i = musicClamp01(intensity);
    const s = n % MUSIC_STEPS_PER_BAR;
    const root = musicChordAt(Math.floor(n / MUSIC_STEPS_PER_BAR)).root;
    if (i >= 0.7) {
      if (s % 2) return -1;
      return (s % 4 === 2) ? root + 12 : root;
    }
    if (s === 0 || s === 3 || s === 6 || s === 8 || s === 11) return root;
    if (s === 14) return root + 12;
    return -1;
  }

  // String arpeggio: chord tones climbing through two octaves, every sixteenth.
  function musicArpNote(step) {
    const n = (typeof step === 'number' && isFinite(step) && step > 0) ? Math.floor(step) : 0;
    const chord = musicChordAt(Math.floor(n / MUSIC_STEPS_PER_BAR));
    const k = MUSIC_ARP_SHAPE[n % MUSIC_ARP_SHAPE.length];
    const tones = chord.notes.length;
    return chord.notes[k % tones] + 12 * (1 + Math.floor(k / tones));
  }

  // ---- Station purchases & tactical audio cues ----
  function stationPurchaseSound(stationKind, isWallAmmo) {
    if (stationKind === 'armory') return 'armory_upgrade';
    if (stationKind === 'door') return 'door_unlock';
    if (stationKind === 'wall') return isWallAmmo ? 'pickup_ammo' : 'weapon_buy';
    if (stationKind === 'plate') return 'pickup_ammo';
    if (stationKind === 'lethal' || stationKind === 'tactical') return 'draw';
    return 'powerup';
  }

  function playerDownSound() {
    return 'player_down';
  }

  function playerReviveSound() {
    return 'player_revive';
  }

  // ---- Tactical Power-ups, Ordnance Deployment, Steady Aim, & Locomotion Acoustics (v96) ----
  function powerupSound(key) {
    if (key === 'nuke') return 'powerup_nuke';
    if (key === 'maxammo') return 'powerup_ammo';
    if (key === 'double') return 'powerup_double';
    if (key === 'instakill') return 'powerup_instakill';
    return 'powerup';
  }

  function equipmentDeploySound(mode, key) {
    if (mode === 'proximity' || key === 'claymore') return 'claymore_plant';
    return 'pin';
  }

  function steadyAimBreathEvent(isSteadyActive, wasSteadyActive, steadyT) {
    const cur = !!isSteadyActive;
    const was = !!wasSteadyActive;
    if (cur && !was) return 'breath_hold';
    if (!cur && was) return 'breath_gasp';
    return null;
  }

  function exhaustionSound(isExhausted, wasExhausted) {
    if (isExhausted && !wasExhausted) return 'exhausted';
    return null;
  }

  function slideCancelSound() {
    return 'slide_cancel';
  }

  // ---- Viewmodel Procedural Dynamics & Tactical Stance Rules (v93) -----------
  const VIEWMODEL_HIP_X = 0.22;
  const VIEWMODEL_HIP_Y = -0.20;
  const VIEWMODEL_HIP_Z = -0.05;
  const VIEWMODEL_ADS_X = 0.0;
  const VIEWMODEL_ADS_Y = -0.148;
  const VIEWMODEL_ADS_Z = 0.02;
  const VIEWMODEL_BOB_SCALE = 0.014;
  const VIEWMODEL_KICK_Z_SCALE = 0.045;
  const VIEWMODEL_KICK_Y_SCALE = 0.3;
  const VIEWMODEL_BOLT_REST_Z = -0.02;
  const VIEWMODEL_BOLT_KICK_SCALE = 0.05;
  const VIEWMODEL_BOLT_KICK_MAX = 0.06;
  const VIEWMODEL_MAG_REST_Y = -0.13;
  const VIEWMODEL_MAG_DROP_SCALE = 0.3;
  const VIEWMODEL_MAG_INSERT_SCALE = 0.45;
  const VIEWMODEL_RELOAD_DIP = 0.09;
  const VIEWMODEL_RELOAD_ROT = 0.5;
  const VIEWMODEL_SWITCH_RAISE_DISTANCE = 0.25;
  const VIEWMODEL_MUZZLE_FLASH_DECAY = 12;
  const VIEWMODEL_MUZZLE_LIGHT_BASE_INTENSITY = 3.2;
  const VIEWMODEL_MUZZLE_LIGHT_DECAY_RATE = 26;
  const IMPACT_VFX_LIFETIME = 0.25;
  const IMPACT_VFX_EXPANSION_RATE = 6;

  const VIEWMODEL_STANCE_OFFSETS = {
    idle: { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 },
    ads: { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 },
    sprint: { posX: 0.08, posY: -0.06, posZ: 0, rotX: 0, rotY: -0.35, rotZ: 0.30 },
    tac_sprint: { posX: -0.04, posY: 0.06, posZ: -0.04, rotX: 0.28, rotY: -0.18, rotZ: 0.38 },
    slide: { posX: 0.05, posY: -0.08, posZ: 0.02, rotX: -0.12, rotY: -0.20, rotZ: 0.22 }
  };

  function viewmodelStance(isSprinting, isTacSprint, isSliding, isAds) {
    if (isAds) return 'ads';
    if (isSliding) return 'slide';
    if (isTacSprint) return 'tac_sprint';
    if (isSprinting) return 'sprint';
    return 'idle';
  }

  function viewmodelStanceOffsets(stance, out) {
    const o = out || { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };
    const src = VIEWMODEL_STANCE_OFFSETS[stance] || VIEWMODEL_STANCE_OFFSETS.idle;
    o.posX = src.posX; o.posY = src.posY; o.posZ = src.posZ;
    o.rotX = src.rotX; o.rotY = src.rotY; o.rotZ = src.rotZ;
    return o;
  }

  function reloadAnimationOffsets(reloadT, reloadDuration, out) {
    const o = out || { dip: 0, rot: 0, magY: VIEWMODEL_MAG_REST_Y };
    const dur = _isPos(reloadDuration) ? reloadDuration : 1;
    const t = _isNum(reloadT) ? reloadT : -1;
    if (t < 0 || t >= dur) {
      o.dip = 0;
      o.rot = 0;
      o.magY = VIEWMODEL_MAG_REST_Y;
      return o;
    }
    const p = _clamp01(t / dur);
    const bump = Math.sin(p * Math.PI);
    o.dip = bump * VIEWMODEL_RELOAD_DIP;
    o.rot = bump * VIEWMODEL_RELOAD_ROT;
    const magDrop = p < 0.4 ? p * VIEWMODEL_MAG_DROP_SCALE : Math.max(0, 0.55 - p) * VIEWMODEL_MAG_INSERT_SCALE;
    o.magY = VIEWMODEL_MAG_REST_Y - magDrop;
    return o;
  }

  function viewmodelBoltOffset(shotKick) {
    const kick = _isNum(shotKick) ? Math.max(0, shotKick) : 0;
    return VIEWMODEL_BOLT_REST_Z + Math.min(VIEWMODEL_BOLT_KICK_MAX, kick * VIEWMODEL_BOLT_KICK_SCALE);
  }

  function viewmodelPose(adsAmount, stance, shotKick, swayX, swayY, bobPhase, bobAmp, isSniper, gunSwitchT, reloadDip, reloadRot, pitch, aspect, isReducedMotion, out) {
    const o = out || { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };
    const ads = _isNum(adsAmount) ? _clamp01(adsAmount) : 0;
    const hipFactor = 1 - ads;

    let px = VIEWMODEL_HIP_X + (VIEWMODEL_ADS_X - VIEWMODEL_HIP_X) * ads;
    let py = VIEWMODEL_HIP_Y + (VIEWMODEL_ADS_Y - VIEWMODEL_HIP_Y) * ads;
    let pz = VIEWMODEL_HIP_Z + (VIEWMODEL_ADS_Z - VIEWMODEL_HIP_Z) * ads;

    const st = VIEWMODEL_STANCE_OFFSETS[stance] || VIEWMODEL_STANCE_OFFSETS.idle;
    px += st.posX * hipFactor;
    py += st.posY * hipFactor;
    pz += st.posZ * hipFactor;

    const kick = Math.max(0, _isNum(shotKick) ? shotKick : 0) * VIEWMODEL_KICK_Z_SCALE;
    pz += kick;
    py += kick * VIEWMODEL_KICK_Y_SCALE;

    if (isSniper) {
      const sx = _isNum(swayX) ? swayX : 0;
      const sy = _isNum(swayY) ? swayY : 0;
      py += ads * 0.062;
      pz += ads * 0.16;
      px += sx * (1 - ads * 0.5);
      py += sy * (1 - ads * 0.5);
    }

    const sw = _isNum(gunSwitchT) ? _clamp01(gunSwitchT) : 1;
    const raise = (1 - sw) * VIEWMODEL_SWITCH_RAISE_DISTANCE;
    const dip = _isNum(reloadDip) ? reloadDip : 0;
    py -= (dip + raise);

    const motion = isReducedMotion ? 0 : 1;
    const bAmp = _isNum(bobAmp) ? bobAmp : 0;
    const bPhase = _isNum(bobPhase) ? bobPhase : 0;
    const bob = bAmp * VIEWMODEL_BOB_SCALE * motion;
    const swayX2 = Math.sin(bPhase) * bob;
    const swayY2 = Math.abs(Math.cos(bPhase)) * bob;
    px += swayX2 * hipFactor;
    py -= swayY2 * hipFactor;

    const asp = _isPos(aspect) ? aspect : 1;
    const narrow = Math.max(0, Math.min(1, (1.2 - asp) / 0.7));
    px -= px * 0.75 * narrow;
    py += 0.05 * narrow;

    const rot = _isNum(reloadRot) ? reloadRot : 0;
    const pAngle = _isNum(pitch) ? pitch : 0;
    const rx = -rot * 0.6 - pAngle * 0.03 + st.rotX * hipFactor;
    const ry = (0.06 + st.rotY) * hipFactor;
    const rz = st.rotZ * hipFactor;

    o.posX = px; o.posY = py; o.posZ = pz;
    o.rotX = rx; o.rotY = ry; o.rotZ = rz;
    return o;
  }

  function stepMuzzleFlash(flashT, dt, decayRate) {
    const cur = _isNum(flashT) ? Math.max(0, flashT) : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const rate = _isNum(decayRate) ? Math.max(0, decayRate) : VIEWMODEL_MUZZLE_FLASH_DECAY;
    return Math.max(0, cur - delta * rate);
  }

  function stepMuzzleLight(intensity, dt, decayRate, lightCompat) {
    const cur = _isNum(intensity) ? Math.max(0, intensity) : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const rate = _isNum(decayRate) ? Math.max(0, decayRate) : VIEWMODEL_MUZZLE_LIGHT_DECAY_RATE;
    const compat = _isNum(lightCompat) ? Math.max(0, lightCompat) : 1;
    return Math.max(0, cur - delta * rate * compat * 4);
  }

  function impactVfxScale(life, maxLife, caliberScale) {
    const maxL = _isPos(maxLife) ? maxLife : IMPACT_VFX_LIFETIME, curL = _isNum(life) ? Math.max(0, Math.min(maxL, life)) : 0;
    if (curL <= 0) return 0.001;
    const cal = _isPos(caliberScale) ? caliberScale : 1.0, expansion = 1 + (maxL - curL) * IMPACT_VFX_EXPANSION_RATE;
    return Math.max(0.001, expansion * (curL / maxL) * cal);
  }

  // ---- Particle Upload Optimization, Marksman Scope & Spring Physics (v94) ----
  const PFX_DEFAULT_MAX = 3000;
  const SCOPE_PARALLAX_MAX = 40;
  const SCOPE_PARALLAX_SCALE = 900;
  const SCOPE_RANGE_MAX = 400;
  const SCOPE_RANGE_INTERVAL = 0.1;
  const POST_KICK_DECAY_RATE = 1.6;

  function pfxNeedsUpload(currentAlive, previousAlive) {
    const cur = _isNum(currentAlive) ? currentAlive : 0;
    const prev = _isNum(previousAlive) ? previousAlive : 0;
    return cur > 0 || prev > 0;
  }

  function scopeParallaxOffset(swayX, swayY, isReducedMotion, maxOffset, scale, out) {
    const o = out || { x: 0, y: 0, sx: '0.0px', sy: '0.0px' };
    if (isReducedMotion) {
      o.x = 0;
      o.y = 0;
      o.sx = '0.0px';
      o.sy = '0.0px';
      return o;
    }
    const maxVal = _isPos(maxOffset) ? maxOffset : SCOPE_PARALLAX_MAX;
    const s = _isNum(scale) ? scale : SCOPE_PARALLAX_SCALE;
    const sx = _isNum(swayX) ? swayX : 0;
    const sy = _isNum(swayY) ? swayY : 0;
    const px = Math.max(-maxVal, Math.min(maxVal, -sx * s));
    const py = Math.max(-maxVal, Math.min(maxVal, sy * s));
    o.x = px;
    o.y = py;
    o.sx = px.toFixed(1) + 'px';
    o.sy = py.toFixed(1) + 'px';
    return o;
  }

  function scopeParallaxChanged(lastSx, lastSy, newSx, newSy) {
    return lastSx !== newSx || lastSy !== newSy;
  }

  function rangefinderLabel(distance, isHostile) {
    const d = _isNum(distance) ? distance : Infinity;
    if (!isFinite(d)) return 'RNG ---';
    const tag = isHostile ? 'TGT ' : 'RNG ';
    return tag + Math.round(d) + 'm';
  }

  function isHostileTarget(enemyDist, worldDist, tolerance) {
    const ed = _isNum(enemyDist) ? enemyDist : Infinity;
    if (!isFinite(ed)) return false;
    const wd = _isNum(worldDist) ? worldDist : Infinity;
    const tol = _isNum(tolerance) ? tolerance : 0.5;
    return ed < (wd + tol);
  }

  function stepRangefinderTimer(timer, dt, interval) {
    const t = _isNum(timer) ? timer : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const next = t - delta;
    if (next <= 0) {
      const inv = _isPos(interval) ? interval : SCOPE_RANGE_INTERVAL;
      return { ready: true, timer: inv };
    }
    return { ready: false, timer: next };
  }

  function stepSpring(x, v, target, k, c, dt, out) {
    const o = out || [0, 0];
    const tgt = _isNum(target) ? target : 0;
    let curX = _isNum(x) ? x : tgt;
    let curV = _isNum(v) ? v : 0;
    const stiff = _isPos(k) ? k : 90;
    const damp = _isNonNeg(c) ? c : 11;
    const delta = _isPos(dt) ? dt : 0;

    const n = Math.max(1, Math.ceil(delta * 120)), h = delta / n;
    for (let i = 0; i < n; i++) {
      curV += ((tgt - curX) * stiff - curV * damp) * h;
      curX += curV * h;
    }
    if (!isFinite(curX) || !isFinite(curV)) { curX = tgt; curV = 0; }
    o[0] = curX; o[1] = curV;
    return o;
  }

  function vmSmooth(a, b, x) {
    const start = _isNum(a) ? a : 0;
    const end = _isNum(b) ? b : 1;
    const val = _isNum(x) ? x : start;
    if (end === start) return val >= end ? 1 : 0;
    const t = Math.max(0, Math.min(1, (val - start) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function vmBump(a, b, x) {
    const start = _isNum(a) ? a : 0;
    const end = _isNum(b) ? b : 1;
    const val = _isNum(x) ? x : start;
    if (val <= start || val >= end || start === end) return 0;
    return Math.sin((val - start) / (end - start) * Math.PI);
  }

  function wrapAngle(a) {
    let ang = _isNum(a) ? a : 0;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang < -Math.PI) ang += Math.PI * 2;
    return ang;
  }

  function stepPostKick(currentKick, dt, decayRate) {
    const cur = _isNum(currentKick) ? Math.max(0, currentKick) : 0;
    const delta = _isNum(dt) ? Math.max(0, dt) : 0;
    const rate = _isPos(decayRate) ? decayRate : POST_KICK_DECAY_RATE;
    return Math.max(0, cur - delta * rate);
  }

  function postFringe(kick, isReducedMotion) {
    if (isReducedMotion) return 0;
    return _isNum(kick) ? Math.max(0, kick) : 0;
  }

  function isPostfxWanted(quality, isTouch) {
    const q = String(quality || 'high').toLowerCase();
    if (q === 'low') return false;
    if (isTouch) return q === 'high';
    return true;
  }

  // ---- Combat Ordnance, Weapon Reload, and Lifecycle Balance Rules ----
  const CAN_RELOAD_MIN_DURATION = 0.05;
  const MUNITIONS_MAG_RATIO = 0.5;
  const SENTRY_RANGE = 26;
  const SENTRY_ROF = 0.22;
  const SENTRY_DMG = 22;
  const SENTRY_DEPLOY_OFFSET = 2.2;
  const MUNITIONS_DEPLOY_OFFSET = 1.8;
  const AIRSTRIKE_LEAD_DIST = 14;
  const AIRSTRIKE_BOMB_COUNT = 6;
  const AIRSTRIKE_SPACING = 5;
  const AIRSTRIKE_BASE_DELAY = 700;
  const AIRSTRIKE_STEP_DELAY = 260;
  const AIRSTRIKE_JITTER = 6;
  const ENEMY_GRENADE_MIN_SPEED = 6;
  const ENEMY_GRENADE_MAX_SPEED = 13;
  const ENEMY_GRENADE_SPEED_DIST_SCALE = 0.32;
  const ENEMY_GRENADE_ARC_Y = 0.62;
  const ENEMY_GRENADE_FUSE_BONUS = 0.4;
  const ENEMY_GRENADE_JITTER = 1.2;
  const PICKUP_LIFE = 25;
  const PICKUP_BLINK_START = 20;
  const PICKUP_COLLECT_RADIUS = 1.3;
  const PICKUP_POWER_ROT_SPEED = 4;
  const PICKUP_STANDARD_ROT_SPEED = 2;
  const FLASH_OVERLAY_MAX_ALPHA = 0.92;
  const FLASH_OVERLAY_DURATION_SCALE = 1.5;

  function canReload(ammo, magSize, reserve, isReloading) {
    if (isReloading) return false;
    const a = _isNum(ammo) ? ammo : 0;
    const m = _isNum(magSize) ? magSize : 0;
    const r = _isNum(reserve) ? reserve : 0;
    if (m <= 0 || r <= 0) return false;
    return a < m;
  }

  const EMPTY_RELOAD_TIME_SMG = 1.10, EMPTY_RELOAD_TIME_AR = 1.15, EMPTY_RELOAD_TIME_BR = 1.22, EMPTY_RELOAD_TIME_SR = 1.30;
  const EMPTY_RELOAD_TIME_MUL = 1.15;
  function weaponEmptyReloadMultiplier(weaponType) {
    return weaponType === 'SMG' ? EMPTY_RELOAD_TIME_SMG : (weaponType === 'BR' ? EMPTY_RELOAD_TIME_BR : (weaponType === 'SR' ? EMPTY_RELOAD_TIME_SR : EMPTY_RELOAD_TIME_AR));
  }
  function effectiveReloadDuration(baseReload, perkMul, isEmpty, weaponType) {
    const base = _isNonNeg(baseReload) ? baseReload : 2.0;
    const mul = _isNonNeg(perkMul) ? perkMul : 1.0;
    const emptyMul = isEmpty ? weaponEmptyReloadMultiplier(weaponType) : 1.0;
    return Math.max(CAN_RELOAD_MIN_DURATION, base * mul * emptyMul);
  }

  function isReloadComplete(reloadT, duration) {
    return _isNum(reloadT) && _isNum(duration) && reloadT >= duration;
  }

  function completeReload(ammo, magSize, reserve, out) {
    const curAmmo = _isNum(ammo) ? Math.max(0, ammo) : 0, curMag = _isNum(magSize) ? Math.max(0, magSize) : 0, curReserve = _isNum(reserve) ? Math.max(0, reserve) : 0;
    const take = Math.min(Math.max(0, curMag - curAmmo), curReserve), res = out || { ammo: 0, reserve: 0, take: 0 };
    res.ammo = curAmmo + take; res.reserve = curReserve - take; res.take = take; return res;
  }

  function munitionsAmmoRestore(currentReserve, reserveMax, magSize, ratio) {
    const r = _isNonNeg(ratio) ? ratio : MUNITIONS_MAG_RATIO, curRes = _isNum(currentReserve) ? Math.max(0, currentReserve) : 0;
    return Math.min(_isNum(reserveMax) ? Math.max(0, reserveMax) : curRes, curRes + Math.round((_isNum(magSize) ? Math.max(0, magSize) : 0) * r));
  }

  function airstrikeDelay(index, baseDelay, stepDelay) {
    return (_isNum(baseDelay) ? baseDelay : AIRSTRIKE_BASE_DELAY) + (_isNum(index) ? Math.max(0, index) : 0) * (_isNum(stepDelay) ? stepDelay : AIRSTRIKE_STEP_DELAY);
  }

  function airstrikeBombCoord(playerX, playerZ, dirX, dirZ, index, leadDist, spacing, jitterX, jitterZ, out) {
    const px = _isNum(playerX) ? playerX : 0, pz = _isNum(playerZ) ? playerZ : 0, dx = _isNum(dirX) ? dirX : 0, dz = _isNum(dirZ) ? dirZ : 0;
    const lead = _isNum(leadDist) ? leadDist : AIRSTRIKE_LEAD_DIST, sp = _isNum(spacing) ? spacing : AIRSTRIKE_SPACING, i = _isNum(index) ? Math.max(0, index) : 0;
    const res = out || { x: 0, z: 0 };
    res.x = px + dx * lead + dx * i * sp + (_isNum(jitterX) ? jitterX : 0);
    res.z = pz + dz * lead + dz * i * sp + (_isNum(jitterZ) ? jitterZ : 0);
    return res;
  }

  function enemyGrenadeSpeed(distance) {
    return Math.min(ENEMY_GRENADE_MAX_SPEED, ENEMY_GRENADE_MIN_SPEED + (_isNum(distance) ? Math.max(0, distance) : 0) * ENEMY_GRENADE_SPEED_DIST_SCALE);
  }

  function enemyGrenadeFuse(baseFuse, bonus) {
    return (_isNum(baseFuse) ? Math.max(0.5, baseFuse) : 2.5) + (_isNum(bonus) ? bonus : ENEMY_GRENADE_FUSE_BONUS);
  }

  function enemyGrenadeCooldown(isGrenadier, currentT, randomVal) {
    const t = _isNum(currentT) ? currentT : 0, r = _isNum(randomVal) ? _clamp01(randomVal) : 0.5;
    return isGrenadier ? (t + 5.5 + r * 4) : (t + 11 + r * 9);
  }

  function enemyBurstInterval(burstRemaining, rof, randomVal) {
    if (_isPos(burstRemaining)) return 0.12;
    return (_isPos(rof) ? rof : 0.4) * 1.6 * (0.8 + (_isNum(randomVal) ? _clamp01(randomVal) : 0.5) * 0.4);
  }

  function pickupBobHeight(t, isPower) {
    return (isPower ? 0.55 : 0.3) + Math.sin((_isNum(t) ? t : 0) * 3) * (isPower ? 0.12 : 0.06);
  }

  function isPickupVisible(t, blinkStart, maxLife) {
    const time = _isNum(t) ? t : 0;
    if (time > (_isNum(maxLife) ? maxLife : PICKUP_LIFE)) return false;
    const blink = _isNum(blinkStart) ? blinkStart : PICKUP_BLINK_START;
    return time <= blink || (time * 6 % 2) < 1.4;
  }

  // Smooth pickup despawn fade: pulsing opacity during the blink window instead of
  // a binary on/off toggle. Returns a value in [0,1].
  //   - Before blinkStart: 1.0 (fully opaque).
  //   - In the blink window: sin²-based pulse that accelerates as the pickup nears
  //     expiry so the urgency is legible without being harsh.
  //   - At or past maxLife: 0 (invisible).
  function pickupBlinkOpacity(t, blinkStart, maxLife) {
    const time = _isNum(t) ? t : 0, life = _isNum(maxLife) ? maxLife : PICKUP_LIFE;
    if (time >= life) return 0;
    const blink = _isNum(blinkStart) ? blinkStart : PICKUP_BLINK_START;
    if (time <= blink) return 1;
    const progress = (time - blink) / Math.max(0.001, life - blink), freq = 3 + progress * 4;
    const phase = (time - blink) * freq * Math.PI * 2, s = Math.sin(phase);
    return Math.max(0.08, s * s);
  }

  function canCollectPickup(pickupX, pickupZ, playerX, playerZ, radius) {
    if (!_isNum(pickupX) || !_isNum(pickupZ) || !_isNum(playerX) || !_isNum(playerZ)) return false;
    const rad = _isPos(radius) ? radius : PICKUP_COLLECT_RADIUS, dx = pickupX - playerX, dz = pickupZ - playerZ;
    return (dx * dx + dz * dz) < rad * rad;
  }


  function grenadeBlinkVisible(fuse, armT, requiredArm) {
    if (_isNum(fuse)) {
      return Math.sin(fuse * (20 - fuse * 4) * 2) > 0;
    }
    const t = _isNum(armT) ? armT : 0;
    const req = _isNum(requiredArm) ? requiredArm : 0;
    return t >= req;
  }

  function flashOverlayOpacity(flashT, durScale, maxAlpha) {
    if (!_isPos(flashT)) return 0;
    const scale = _isPos(durScale) ? durScale : FLASH_OVERLAY_DURATION_SCALE;
    const alpha = _isNum(maxAlpha) ? maxAlpha : FLASH_OVERLAY_MAX_ALPHA;
    return Math.min(alpha, flashT / scale);
  }

  function smokeCloudScale(elapsedT, radius, growDuration) {
    const elapsed = _isNum(elapsedT) ? Math.max(0, elapsedT) : 0;
    const dur = _isPos(growDuration) ? growDuration : 1.0;
    const grow = Math.min(1, elapsed / dur);
    const r = _isNum(radius) ? radius : 1.0;
    return r * (0.25 + 0.75 * grow);
  }

  function smokeCloudOpacity(remainingT, fadeDuration, maxOpacity) {
    if (!_isPos(remainingT)) return 0;
    const fade = _isPos(fadeDuration) ? fadeDuration : 1.5;
    const maxO = _isNum(maxOpacity) ? maxOpacity : 0.62;
    return maxO * Math.min(1, Math.max(0, remainingT / fade));
  }

  function burnPatchOpacity(remainingT, totalLife, maxOpacity) {
    if (!_isPos(remainingT)) return 0;
    const life = _isPos(totalLife) ? totalLife : 1.0;
    const maxO = _isNum(maxOpacity) ? maxOpacity : 0.5;
    return maxO * _clamp01(remainingT / life);
  }

  // ---- Shell Casings Dynamics & Tactical Viewmodel Kinematics (v98) ----
  const CASING_MAX = 24, CASING_LIFETIME = 2.2, CASING_FADE_DURATION = 0.35, CASING_FLOOR_Y = 0.02, CASING_GRAVITY = 12, CASING_BOUNCE = 0.35, CASING_FRICTION = 0.5, CASING_SPIN_DAMP = 0.4, CASING_REST_SPEED = 0.6, CASING_SND_GAP = 0.09, VIEWMODEL_MANTLE_IN_RATE = 8, VIEWMODEL_MANTLE_OUT_RATE = 5;

  function casingScale(life, maxLife, fadeDur, caliberScale) {
    const dur = _isPos(fadeDur) ? fadeDur : CASING_FADE_DURATION, cal = _isPos(caliberScale) ? caliberScale : 1.0;
    if (!_isPos(life)) return 0.001 * cal;
    if (life >= dur) return cal;
    const t = _clamp01(life / dur);
    return Math.max(0.001 * cal, t * t * (3 - 2 * t) * cal);
  }

  function casingEjectVelocity(rightX, rightY, rightZ, randMul, randY, impulseMulOrOut, out) {
    const hasMul = typeof impulseMulOrOut === 'number', o = hasMul ? (out || { x: 0, y: 0, z: 0 }) : (impulseMulOrOut || { x: 0, y: 0, z: 0 });
    const mul = hasMul ? impulseMulOrOut : 1.0, speed = (1.6 + (_isNum(randMul) ? randMul : 0)) * mul;
    o.x = (_isNum(rightX) ? rightX : 0) * speed;
    o.y = (_isNum(rightY) ? rightY : 0) * speed + 1.4 + (_isNum(randY) ? randY : 0);
    o.z = (_isNum(rightZ) ? rightZ : 0) * speed;
    return o;
  }

  function stepCasingPhysics(posX, posY, posZ, vx, vy, vz, spinX, spinY, spinZ, dt, grav, bounce, fric, spinDamp, floorY, restSpd, out) {
    const o = out || { x: posX, y: posY, z: posZ, vx, vy, vz, spinX, spinY, spinZ, rest: false, bounced: false };
    const delta = _isPos(dt) ? dt : 0, g = _isNum(grav) ? grav : CASING_GRAVITY, b = _isNum(bounce) ? bounce : CASING_BOUNCE;
    const f = _isNum(fric) ? fric : CASING_FRICTION, sd = _isNum(spinDamp) ? spinDamp : CASING_SPIN_DAMP, flY = _isNum(floorY) ? floorY : CASING_FLOOR_Y, rSpd = _isNum(restSpd) ? restSpd : CASING_REST_SPEED;

    let x = _isNum(posX) ? posX : 0, y = _isNum(posY) ? posY : 0, z = _isNum(posZ) ? posZ : 0;
    let velX = _isNum(vx) ? vx : 0, velY = (_isNum(vy) ? vy : 0) - g * delta, velZ = _isNum(vz) ? vz : 0;
    let spX = _isNum(spinX) ? spinX : 0, spY = _isNum(spinY) ? spinY : 0, spZ = _isNum(spinZ) ? spinZ : 0;

    x += velX * delta; y += velY * delta; z += velZ * delta;
    let bounced = false, rest = false;
    if (y <= flY) {
      y = flY;
      if (velY < -0.5) {
        velY = -velY * b; velX *= f; velZ *= f; spX *= sd; spY *= sd; spZ *= sd; bounced = true;
        if (Math.abs(velY) < rSpd) { rest = true; velX = 0; velY = 0; velZ = 0; spX = 0; spY = 0; spZ = 0; }
      } else {
        rest = true; velX = 0; velY = 0; velZ = 0; spX = 0; spY = 0; spZ = 0;
      }
    }
    o.x = x; o.y = y; o.z = z; o.vx = velX; o.vy = velY; o.vz = velZ; o.spinX = spX; o.spinY = spY; o.spinZ = spZ; o.bounced = bounced; o.rest = rest;
    return o;
  }

  function casingRestRotation(rotX, rotY, rotZ, out) {
    const o = out || { rotX: 0, rotY: 0, rotZ: 0 };
    o.rotX = Math.PI * 0.5; o.rotY = _isNum(rotY) ? rotY : 0; o.rotZ = 0;
    return o;
  }


  function stepMeleeKnifePose(progress, out) {
    const o = out || { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 }, p = _isNum(progress) ? _clamp01(progress) : 0, sw = vmSmooth(0.1, 0.45, p);
    o.posX = 0.22 - sw * 0.36; o.posY = -0.12 + vmBump(0, 1, p) * 0.06; o.posZ = -0.3; o.rotX = -0.2; o.rotY = 0.9 - sw * 1.6; o.rotZ = -0.9 + sw * 0.9;
    return o;
  }

  function meleeGunDodgeOffsets(progress, out) {
    const o = out || { posY: 0, rotX: 0, rotZ: 0 }, p = _isNum(progress) ? _clamp01(progress) : 0, gunOut = p > 0 && p < 1 ? vmBump(0, 1, p) : 0;
    o.posY = gunOut !== 0 ? -gunOut * 0.25 : 0; o.rotX = gunOut !== 0 ? -gunOut * 0.5 : 0; o.rotZ = gunOut !== 0 ? gunOut * 0.4 : 0;
    return o;
  }

  function stepViewmodelMantle(currentMantle, isMantling, dt, inRate, outRate) {
    const cur = _isNum(currentMantle) ? currentMantle : 0, delta = _isPos(dt) ? dt : 0;
    return isMantling ? Math.min(1, cur + delta * (_isPos(inRate) ? inRate : VIEWMODEL_MANTLE_IN_RATE)) : Math.max(0, cur - delta * (_isPos(outRate) ? outRate : VIEWMODEL_MANTLE_OUT_RATE));
  }

  function viewmodelMantleOffsets(mantleAmount, out) {
    const o = out || { posY: 0, rotX: 0, rotZ: 0 }, m = _isNum(mantleAmount) ? _clamp01(mantleAmount) : 0;
    o.posY = m !== 0 ? -m * 0.18 : 0; o.rotX = m !== 0 ? -m * 0.3 : 0; o.rotZ = m !== 0 ? m * 0.5 : 0;
    return o;
  }

  function reloadHandOffsets(progress, targetX, targetY, targetZ, restX, restY, restZ, out) {
    const o = out || { posX: 0, posY: 0, posZ: 0 }, p = _isNum(progress) ? _clamp01(progress) : 0, hk = vmBump(0.08, 0.72, p);
    o.posX = hk !== 0 ? ((_isNum(targetX) ? targetX : 0) - (_isNum(restX) ? restX : 0) - 0.01) * hk * 0.9 : 0;
    o.posY = hk !== 0 ? -0.12 * hk : 0;
    o.posZ = hk !== 0 ? ((_isNum(targetZ) ? targetZ : 0) - (_isNum(restZ) ? restZ : 0) + 0.15) * hk * 0.9 : 0;
    return o;
  }

  function viewmodelLateralSpeed(velX, velZ, yaw) {
    const y = _isNum(yaw) ? yaw : 0;
    return (_isNum(velX) ? velX : 0) * Math.cos(y) - (_isNum(velZ) ? velZ : 0) * Math.sin(y);
  }

  function stepViewmodelTilt(currentTilt, lateralVel, adsAmount, motionScale, dt) {
    const cur = _isNum(currentTilt) ? currentTilt : 0, target = -(_isNum(lateralVel) ? lateralVel : 0) * 0.012 * (1 - (_isNum(adsAmount) ? _clamp01(adsAmount) : 0) * 0.7) * (_isNum(motionScale) ? motionScale : 1);
    return cur + (target - cur) * Math.min(1, 8 * (_isPos(dt) ? dt : 0));
  }

  function viewmodelLookInertiaTarget(lookDelta, isPitch, adsAmount, motionScale) {
    const clamped = Math.max(-0.05, Math.min(0.05, (isPitch ? -1 : 1) * (_isNum(lookDelta) ? lookDelta : 0) * 1.6));
    return clamped * (1 - (_isNum(adsAmount) ? _clamp01(adsAmount) : 0) * 0.75) * (_isNum(motionScale) ? motionScale : 1);
  }

  // ---- Station Buy Prompt Performance Rules ----
  const BUY_PROMPT_DEFAULT_COLOR = '#ffd24a', BUY_PROMPT_DIM_COLOR = 'rgba(255,255,255,.55)';
  function buyPromptLabel(label, price, prefix) {
    return ((typeof prefix === 'string') ? prefix : '') + ((typeof label === 'string') ? label : '') + (_isPos(price) ? ('  ·  ' + price + ' CR') : '');
  }
  function buyPromptFillPct(holdT, maxHold) {
    return Math.round(Math.min(1, Math.max(0, (_isNum(holdT) ? holdT : 0) / (_isPos(maxHold) ? maxHold : 1))) * 100);
  }
  function buyPromptColor(dim) { return dim ? BUY_PROMPT_DIM_COLOR : BUY_PROMPT_DEFAULT_COLOR; }
  function buyPromptChanged(lastState, visible, text, fillPct, dim) {
    if (!lastState) return true;
    return lastState.visible !== !!visible || lastState.text !== (text || '') || lastState.fillPct !== fillPct || lastState.dim !== !!dim;
  }
  function syncBuyPromptState(lastState, visible, text, fillPct, dim) {
    if (!lastState) return { visible: !!visible, text: text || '', fillPct: fillPct || 0, dim: !!dim };
    lastState.visible = !!visible; lastState.text = text || ''; lastState.fillPct = fillPct || 0; lastState.dim = !!dim; return lastState;
  }

  // ---- Minimap & Compass 2D Canvas Gating & Projection ----
  const COMPASS_YAW_THRESHOLD = 0.002;
  function compassNeedsRedraw(lastYaw, currentYaw, threshold) {
    return !_isNum(lastYaw) || (_isNum(currentYaw) && Math.abs(currentYaw - lastYaw) >= (_isNum(threshold) ? threshold : COMPASS_YAW_THRESHOLD));
  }
  function minimapScale(canvasRadius, worldSize, margin) {
    return (_isNum(canvasRadius) ? canvasRadius : 75) / (((_isNum(worldSize) ? worldSize : 90) / 2) + (_isNum(margin) ? margin : 8));
  }
  function minimapDetectRadiusSq(uavActive, canvasRadius, baseDetect, scale) {
    const r = _isNum(canvasRadius) ? canvasRadius : 75;
    if (uavActive) return r * r;
    const dist = (_isNum(baseDetect) ? baseDetect : 26) * (_isNum(scale) ? scale : 1);
    return dist * dist;
  }
  function minimapBlipOffset(worldX, worldZ, playerX, playerZ, scale, out) {
    const o = out || { x: 0, z: 0 }, s = _isNum(scale) ? scale : 1;
    o.x = ((_isNum(worldX) ? worldX : 0) - (_isNum(playerX) ? playerX : 0)) * s;
    o.z = ((_isNum(worldZ) ? worldZ : 0) - (_isNum(playerZ) ? playerZ : 0)) * s;
    return o;
  }
  function isMinimapBlipVisible(offsetX, offsetZ, maxRadiusSq) {
    return isFinite(offsetX) && isFinite(offsetZ) && (offsetX * offsetX + offsetZ * offsetZ) <= (_isNum(maxRadiusSq) ? maxRadiusSq : Infinity);
  }
  function minimapEnemyRadius(kind) { return (kind === 2 || kind === 3) ? 4 : (kind === 4 ? 2.5 : 3); }
  function compassTickAngle(heading, offset) { return (((_isNum(heading) ? heading : 0) + ((_isNum(offset) ? offset : 0)) + 360) % 360); }
  function compassSnapAngle(deg, step) { const s = _isPos(step) ? step : 5; return Math.round((_isNum(deg) ? deg : 0) / s) * s; }
  function compassTickVisible(offset, maxSpan) { return isFinite(offset) && Math.abs(offset) <= (_isNum(maxSpan) ? maxSpan : 45); }
  function compassTickStyle(isMajor) { return isMajor ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)'; }

  // ---- Ragdoll Settling, Sinking & Despawn Lifecycle ----
  const RAGDOLL_SINK_DELAY = 3.5, RAGDOLL_SINK_RATE = 0.6, RAGDOLL_SINK_MAX = 1.6, RAGDOLL_DROP_SCALE = 0.02;

  function isRagdollSinkReady(isSettled, age, delay) {
    if (!isSettled) return false;
    const a = _isNum(age) ? age : 0;
    const d = _isNum(delay) ? delay : RAGDOLL_SINK_DELAY;
    return a > d;
  }

  function stepRagdollSink(currentSunk, dt, rate) {
    return (_isNum(currentSunk) ? currentSunk : 0) + (_isNum(dt) ? dt : 0) * (_isNum(rate) ? rate : RAGDOLL_SINK_RATE);
  }
  function ragdollDropOffsetY(sunk, scale) { return (_isNum(sunk) ? sunk : 0) * (_isNum(scale) ? scale : RAGDOLL_DROP_SCALE); }
  function isRagdollExpired(sunk, maxSunk) { return (_isNum(sunk) ? sunk : 0) > (_isNum(maxSunk) ? maxSunk : RAGDOLL_SINK_MAX); }

  // ---- Procedural Box-Man Enemy Animation Kinematics ----
  const ENEMY_PROC_WALK_THRESHOLD = 0.3, ENEMY_PROC_BASE_FREQ = 9;
  function enemyProcWalkSpeed(moveSpeed, kind, threshold) {
    const spd = _isNum(moveSpeed) ? moveSpeed : 0;
    return spd <= (_isNum(threshold) ? threshold : ENEMY_PROC_WALK_THRESHOLD) ? 0 : ENEMY_PROC_BASE_FREQ * (spd / 3.2) * (kind === 0 ? 1.5 : 1);
  }
  function stepEnemyProcWalkPhase(phase, speed, dt) { return (_isNum(phase) ? phase : 0) + (_isNum(speed) ? speed : 0) * (_isNum(dt) ? dt : 0); }
  function enemyProcLimbSwing(phase, isMoving) { return Math.sin((_isNum(phase)) ? phase : 0) * (isMoving ? 0.55 : 0.06); }
  function enemyProcPitchTrack(playerEyeY, enemyY, dist) { return Math.atan2(((_isNum(playerEyeY)) ? playerEyeY : 0) - (((_isNum(enemyY)) ? enemyY : 0) + 1.5), (_isNum(dist)) ? Math.max(0.1, dist) : 1); }
  function enemyProcPose(phase, moveSpeed, kind, dist, playerEyeY, enemyY, out) {
    const o = out || { legLRotX: 0, legRRotX: 0, armLRotX: 0, armRRotX: 0, bodyRotX: 0, bodyPosY: 0, moving: false };
    const spd = (_isNum(moveSpeed)) ? moveSpeed : 0, moving = spd > ENEMY_PROC_WALK_THRESHOLD, p = (_isNum(phase)) ? phase : 0, swing = enemyProcLimbSwing(p, moving);
    o.moving = moving; o.legLRotX = swing; o.legRRotX = -swing; o.armLRotX = -swing * 0.7; o.armRRotX = swing * 0.7 - (kind === 1 ? 0.5 : 0);
    const pitch = enemyProcPitchTrack(playerEyeY, enemyY, dist);
    let bRotX = kind === 1 ? -pitch * 0.25 : 0; if (kind === 0) bRotX += 0.12;
    o.bodyRotX = bRotX; o.bodyPosY = moving ? Math.abs(Math.cos(p)) * 0.03 : 0; return o;
  }

  // ---- Combat Balance & Wave Pacing Dynamics ----
  const WAVE_SPAWN_PRESSURE_QUEUE = 18, WAVE_SPAWN_SWEET_SPOT = 26, WAVE_SPAWN_JITTER = 6, AMMO_RELIEF_DRY_THRESHOLD = 5, AMMO_RELIEF_COOLDOWN = 18;
  const ENEMY_BULLET_DELAY_FACTOR = 2.2, ENEMY_BULLET_MAX_DELAY_MS = 300, ENEMY_MELEE_WINDUP_BASE = 0.25, ENEMY_MELEE_WINDUP_RANGE = 0.45;
  const ENEMY_MELEE_FOLLOW_REACH_PADDING = 0.35, ENEMY_STUN_SPEED_MUL = 0.35, ENEMY_BLIND_YAW_RATE = 1.6, ENEMY_FALL_SPEED = 6;
  const SLIDE_CANCEL_MIN_T = 0.12, SLIDE_TIMEOUT_T = 0.9, SLIDE_STOP_MIN_T = 0.25, STATION_HOLD_DECAY_RATE = 3;

  function waveSpawnPressure(waveQueue, queueThreshold) {
    const q = _isNum(waveQueue) ? Math.max(0, waveQueue) : 0, thresh = _isNum(queueThreshold) ? Math.max(1, queueThreshold) : WAVE_SPAWN_PRESSURE_QUEUE;
    return Math.min(1, q / thresh);
  }
  function waveSpawnBurstCount(waveQueue, canSpawn, pressure, randomVal) {
    const q = _isNum(waveQueue) ? Math.max(0, waveQueue) : 0, maxCan = _isNum(canSpawn) ? Math.max(0, canSpawn) : 0, press = _isNum(pressure) ? _clamp01(pressure) : 0, r = _isNum(randomVal) ? _clamp01(randomVal) : 0.5;
    return Math.min(Math.floor(Math.min(0.9999, r) * 2) + 3 + Math.round(press * 3), q, maxCan);
  }

  function waveSpawnDelay(pressure, randomVal) {
    const press = _isNum(pressure) ? _clamp01(pressure) : 0, r = _isNum(randomVal) ? _clamp01(randomVal) : 0.5;
    return (2.5 - press * 1.4) + r * 1.2;
  }
  function spawnCandidateScore(dist, sweetSpot, randomVal) {
    const d = _isNum(dist) ? dist : 0, target = _isNum(sweetSpot) ? sweetSpot : WAVE_SPAWN_SWEET_SPOT, r = _isNum(randomVal) ? _clamp01(randomVal) : 0.5, res = -Math.abs(d - target) - r * WAVE_SPAWN_JITTER;
    return res === 0 ? 0 : res;
  }
  function stepAmmoReliefTimer(dryT, dt, hasAmmo) {
    return hasAmmo ? 0 : (_isNum(dryT) ? Math.max(0, dryT) : 0) + (_isNum(dt) ? Math.max(0, dt) : 0);
  }
  function isAmmoReliefNeeded(waveActive, isDead, dryT, gameT, nextCacheT, threshold) {
    return !!waveActive && !isDead && ((_isNum(dryT) ? dryT : 0) > (_isNum(threshold) ? threshold : AMMO_RELIEF_DRY_THRESHOLD)) && ((_isNum(gameT) ? gameT : 0) > (_isNum(nextCacheT) ? nextCacheT : 0));
  }
  function enemyBulletTravelDelay(dist, factor, maxDelay) {
    return Math.min(_isNum(maxDelay) ? maxDelay : ENEMY_BULLET_MAX_DELAY_MS, (_isNum(dist) ? Math.max(0, dist) : 0) * (_isNum(factor) ? factor : ENEMY_BULLET_DELAY_FACTOR));
  }
  function enemyRangedNextShot(currentT, rangedRof, randomVal) {
    return (_isNum(currentT) ? currentT : 0) + (_isNum(rangedRof) ? rangedRof : 1.35) * (0.75 + (_isNum(randomVal) ? _clamp01(randomVal) : 0.5) * 0.5);
  }
  function enemyMeleeWindup(randomVal) {
    return ENEMY_MELEE_WINDUP_BASE + (_isNum(randomVal) ? _clamp01(randomVal) : 0.5) * ENEMY_MELEE_WINDUP_RANGE;
  }
  function enemyAttackReadyTime(currentT, baseCooldown, randomVal) {
    return (_isNum(currentT) ? currentT : 0) + (_isNum(baseCooldown) ? baseCooldown : 1.1) + (_isNum(randomVal) ? _clamp01(randomVal) : 0.5) * 0.5;
  }
  function enemyKillImpulse(lastHitForce, isHead, randomVal, out) {
    const o = out || { force: 0, y: 0 }, forceVal = _isNum(lastHitForce) ? Math.max(0, lastHitForce) : 20, r = _isNum(randomVal) ? _clamp01(randomVal) : 0.5;
    o.force = Math.min(0.085, 0.012 + forceVal * 0.00035); o.y = (isHead ? 0.030 : 0.016) + r * 0.008; return o;
  }
  function enemyStunSpeedMultiplier(baseSpeedMul, isStunned) {
    const base = _isNum(baseSpeedMul) ? baseSpeedMul : 1; return isStunned ? base * ENEMY_STUN_SPEED_MUL : base;
  }
  function stepEnemyBlindYaw(yaw, dt, rate) {
    return (_isNum(yaw) ? yaw : 0) + (_isNum(dt) ? Math.max(0, dt) : 0) * (_isNum(rate) ? rate : ENEMY_BLIND_YAW_RATE);
  }
  function stepEnemyFallY(currentY, floorY, dt, fallSpeed, stepH) {
    const cy = _isNum(currentY) ? currentY : 0, fy = _isNum(floorY) ? floorY : 0, delta = _isNum(dt) ? Math.max(0, dt) : 0, spd = _isNum(fallSpeed) ? fallSpeed : ENEMY_FALL_SPEED, step = _isNum(stepH) ? stepH : 0.60;
    if (fy < cy) return cy - Math.min(cy - fy, delta * spd);
    if (fy > cy && (fy - cy) <= step) return cy + Math.min(fy - cy, delta * spd);
    return cy;
  }
  function canSlideCancel(slideT, minDuration) {
    return (_isNum(slideT) ? slideT : 0) > (_isNum(minDuration) ? minDuration : SLIDE_CANCEL_MIN_T);
  }

  function isSlideExpired(slideT, isCrouchHeld, hasMoveInput, maxDuration, minMoveDuration) {
    const t = (_isNum(slideT)) ? slideT : 0;
    return t > ((_isNum(maxDuration)) ? maxDuration : SLIDE_TIMEOUT_T) || !isCrouchHeld || (!hasMoveInput && t > ((_isNum(minMoveDuration)) ? minMoveDuration : SLIDE_STOP_MIN_T));
  }
  function stepStationHold(holdT, isHolding, dt, decayRate, buyHold) {
    const cur = (_isNum(holdT)) ? Math.max(0, holdT) : 0, delta = (_isNum(dt)) ? dt : 0;
    return isHolding ? Math.min((_isNum(buyHold)) ? buyHold : BUY_HOLD, cur + delta) : Math.max(0, cur - delta * ((_isNum(decayRate)) ? decayRate : STATION_HOLD_DECAY_RATE));
  }
  function weaponFireInterval(rpm) { return 60 / (_isPos(rpm) ? rpm : 600); }

  // ---- Ballistic surface impact and tactical weapon acoustics (v101) ----
  const SPATIAL_IMPACT_MAX_DIST = 55, SNIPER_BOLT_DELAY_MS = 280;
  function surfaceImpactSound(surface) {
    return surface === 'metal' ? 'impact_metal' : (surface === 'wood' ? 'impact_wood' : (surface === 'glass' ? 'impact_glass' : (surface === 'ground' ? 'impact_ground' : 'impact')));
  }
  function sniperBoltSound() { return 'sniper_bolt'; }
  function streakReadySound(key) { return 'streak_ready'; }
  function fieldUpgradeReadySound() { return 'field_ready'; }
  function secondWindSound() { return 'second_wind'; }
  function objectiveCompleteSound() { return 'objective_complete'; }
  function weaponDrawSound(weaponType) {
    return (weaponType === 'SR' || weaponType === 'BR') ? 'draw_heavy' : (weaponType === 'SMG' ? 'draw_light' : 'draw');
  }

  // ---- Ballistic bullet hole decals, viewmodel muzzle flash dynamics, and tracer kinematics (v103) ----
  const DECAL_MAX = 48, DECAL_LIFETIME = 25, DECAL_FADE_DURATION = 3.5, DECAL_BASE_RADIUS = 0.075, DECAL_STANDOFF = 0.012, MUZZLE_FLASH_SUPPRESSED_SCALE = 0.22, TRACER_LIFETIME = 0.065;
  function decalCaliberScale(weaponType) {
    return weaponType === 'SMG' ? 0.72 : (weaponType === 'BR' ? 1.25 : (weaponType === 'SR' ? 1.5 : 1.0));
  }
  function decalSurfaceMultiplier(surface) {
    return surface === 'glass' ? 1.25 : (surface === 'wood' ? 1.1 : (surface === 'metal' ? 0.82 : 1.0));
  }

  function decalScale(weaponType, surface, life, maxLife, fadeDuration) {
    const cal = decalCaliberScale(weaponType);
    const surf = decalSurfaceMultiplier(surface);
    const base = cal * surf;
    const maxL = _isPos(maxLife) ? maxLife : DECAL_LIFETIME;
    const curL = _isNum(life) ? Math.max(0, Math.min(maxL, life)) : 0;
    const fade = _isPos(fadeDuration) ? fadeDuration : DECAL_FADE_DURATION;
    if (curL <= 0) return 0.001;
    if (curL < fade) {
      const t = curL / fade;
      const decay = 1 - (1 - t) * (1 - t) * (1 - t);
      return Math.max(0.001, base * decay);
    }
    return base;
  }

  function decalRotationAngle(randomVal) { return ((_isNum(randomVal) ? randomVal : 0) % 1) * Math.PI * 2; }
  function stepDecalLife(life, dt) { return Math.max(0, (_isNum(life) ? life : 0) - (_isNum(dt) ? dt : 0)); }
  function isDecalExpired(life) { return !_isPos(life); }
  function muzzleFlashRotation(randomVal) { return ((_isNum(randomVal) ? randomVal : 0) % 1) * Math.PI; }

  function muzzleFlashBaseScale(weaponType, isSuppressed, randK, randZ, out) {
    const rk = _isNum(randK) ? randK : 0.5, rz = _isNum(randZ) ? randZ : 0.5, res = out || { k: 1, z: 1 };
    if (isSuppressed) { res.k = MUZZLE_FLASH_SUPPRESSED_SCALE * (0.8 + rk * 0.4); res.z = MUZZLE_FLASH_SUPPRESSED_SCALE * (0.8 + rz * 0.4); return res; }
    const wt = weaponType === 'SMG' ? [0.65, 0.25, 0.60, 0.30] : (weaponType === 'BR' ? [1.15, 0.45, 1.10, 0.50] : (weaponType === 'SR' ? [1.50, 0.50, 1.40, 0.60] : [0.85, 0.35, 0.80, 0.40]));
    res.k = wt[0] + rk * wt[1]; res.z = wt[2] + rz * wt[3]; return res;
  }

  function stepMuzzleFlashScale(baseK, baseZ, flashT, out) {
    const res = out || { x: 1, y: 1, z: 1 }, ft = _isNum(flashT) ? _clamp01(flashT) : 0, km = Math.min(1, ft * 1.25), zm = Math.min(1, ft * 1.1);
    res.x = (_isNum(baseK) ? baseK : 1) * km; res.y = res.x; res.z = (_isNum(baseZ) ? baseZ : 1) * zm; return res;
  }

  function tracerThicknessScale(life, maxLife, caliberScale) {
    const maxL = _isPos(maxLife) ? maxLife : TRACER_LIFETIME, curL = _isNum(life) ? Math.max(0, Math.min(maxL, life)) : 0;
    const cal = _isPos(caliberScale) ? caliberScale : 1.0;
    return Math.max(0.1, (curL / maxL) * cal);
  }

  function tracerColor(isEnemy) { return isEnemy ? 0xff8844 : 0xffe9a0; }

  // ---- Locomotion velocity synthesis & collision relevance (perf win) --------
  function movementTargetVelocity(ix, iz, yaw, speed, out) {
    const y = _isNum(yaw) ? yaw : 0, spd = _isNonNeg(speed) ? speed : 0, sy = Math.sin(y), cy = Math.cos(y);
    const vx = ((_isNum(ix) ? ix : 0) * cy - (_isNum(iz) ? iz : 0) * sy) * spd, vz = (-(_isNum(ix) ? ix : 0) * sy - (_isNum(iz) ? iz : 0) * cy) * spd;
    const target = _isObj(out) ? out : { x: 0, z: 0 };
    target.x = vx; target.z = vz; return target;
  }

  // ---- HUD canvas redraw throttling & alive enemy counting (perf win) --------
  // 20 Hz base throttle
  const HUD_REDRAW_INTERVAL = 0.05;
  // ~8.6 degrees rotation flick trigger
  const HUD_FLICK_YAW_THRESHOLD = 0.15;
  // minimum interval between flick-forced redraws
  const HUD_FLICK_COOLDOWN = 0.12;

  function shouldRedrawHudCanvas(elapsedT, yawMoved, flickElapsed, interval, flickThreshold, flickCooldown) {
    const elapsed = _isNum(elapsedT) ? elapsedT : 0;
    const ym = _isNum(yawMoved) ? Math.abs(yawMoved) : 0;
    const fe = _isNum(flickElapsed) ? flickElapsed : 0;
    const int = _isPos(interval) ? interval : HUD_REDRAW_INTERVAL;
    const th = _isPos(flickThreshold) ? flickThreshold : HUD_FLICK_YAW_THRESHOLD;
    const cd = _isPos(flickCooldown) ? flickCooldown : HUD_FLICK_COOLDOWN;
    return (elapsed >= int) || (ym > th && fe > cd);
  }

  function countAliveEnemies(enemies) {
    if (!enemies || !enemies.length) return 0;
    let n = 0;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e && !e.dead) n++;
    }
    return n;
  }

  function hostilesRemainingLabel(count) {
    const n = _isNonNeg(count) ? Math.floor(count) : 0;
    return n + ' HOSTILE' + (n === 1 ? '' : 'S');
  }

  function enemiesRemainingChanged(lastCount, curCount) {
    return lastCount !== curCount;
  }

  function syncEnemiesRemaining(curCount) {
    return _isNum(curCount) ? curCount : 0;
  }

  // ---- Viewmodel optics FOV & responsive narrow-screen centering (perf win) ---
  function gunCameraFov(adsAmount, weaponType) {
    const ads = _isNum(adsAmount) ? _clamp01(adsAmount) : 0;
    const isSr = weaponType === 'SR';
    return 58 - ads * (isSr ? 18 : 12);
  }

  function viewmodelNarrowOffset(aspectRatio, posX, hipK) {
    const asp = _isPos(aspectRatio) ? aspectRatio : 1.0;
    const px = _isNum(posX) ? posX : 0;
    const hk = _isNum(hipK) ? _clamp01(hipK) : 1.0;
    const narrow = Math.max(0, Math.min(1, (1.2 - asp) / 0.7));
    return px * 0.6 * narrow * hk;
  }

  // ---- Combat kinematics & balance rules (balance tuning) ---------------------
  const STEP_HEIGHT = 0.60;
  const SLIDE_STEER_RATE = 2.2;
  const TAC_TAP_WINDOW = 0.32;
  const TAC_DURATION = 2.5;
  const GRENADE_BOUNCE_LAT_DAMP = 0.55;
  const GRENADE_ROLL_LAT_DAMP = 0.30;

  function enemyScale(kind) {
    return kind === 2 ? 1.25 : kind === 3 ? 1.1 : kind === 4 ? 0.88 : 1.0;
  }

  function enemyColliderRadius(kind) {
    return 0.4 * (kind === 2 ? 1.4 : 1.0);
  }

  function enemyHeadHeight(posY, kind) {
    const y = _isNum(posY) ? posY : 0;
    return y + (kind === 2 ? 2.3 : 1.85);
  }

  function enemySpawnSpeedMultiplier(rand, isElite, specialSpeedMul) {
    const r = _isNum(rand) ? _clamp01(rand) : 0.5;
    const base = 0.85 + r * 0.3;
    const eliteK = isElite ? ELITE.speedMul : 1.0;
    const specK = _isPos(specialSpeedMul) ? specialSpeedMul : 1.0;
    return base * eliteK * specK;
  }

  function isEnemyFlanker(kind, waveFlanking, rand) {
    if (kind === 4) return true;
    if (kind === 3 || kind === 5 || kind === 6) return false;
    const r = _isNum(rand) ? _clamp01(rand) : 0.5;
    return !!waveFlanking && r < 0.45;
  }

  function enemyFallbackVelocity(toX, toZ, strafeDir, out) {
    const tx = _isNum(toX) ? toX : 0, tz = _isNum(toZ) ? toZ : 0, sDir = (_isNum(strafeDir) && strafeDir < 0) ? -1 : 1;
    const vx = -tx * 0.8 - tz * 0.6 * sDir, vz = -tz * 0.8 + tx * 0.6 * sDir, l = Math.hypot(vx, vz) || 1, target = (_isObj(out)) ? out : { x: 0, z: 0 };
    target.x = vx / l; target.z = vz / l; return target;
  }

  function enemyStrafeVelocity(toX, toZ, strafeDir, out) {
    const tx = _isNum(toX) ? toX : 0, tz = _isNum(toZ) ? toZ : 0, sDir = (_isNum(strafeDir) && strafeDir < 0) ? -1 : 1;
    const vx = -tz * sDir, vz = tx * sDir, l = Math.hypot(vx, vz) || 1, target = (_isObj(out)) ? out : { x: 0, z: 0 };
    target.x = vx / l; target.z = vz / l; return target;
  }


  function enemyStrafeDuration(rand) {
    const r = _isNum(rand) ? _clamp01(rand) : 0.5;
    return 1.5 + r * 2.0;
  }

  function canEnemyThrowGrenade(kind, dist, isPlayerDead) {
    if (isPlayerDead) return false;
    const d = _isNum(dist) ? dist : 0;
    if (kind === 5) return d > 9 && d < 36;
    if (kind === 1) return d > 8 && d < 32;
    return false;
  }

  function enemyFootstepRate(kind) {
    return kind === 0 ? 1.7 : kind === 2 ? 0.9 : 1.1;
  }

  function enemyFootstepInterval(speedMul) {
    const mul = (_isNum(speedMul) && speedMul > 0.05) ? speedMul : 1.0;
    return 0.55 / mul;
  }

  const ENEMY_FOOTSTEP_MAX_DIST = 30.0;
  function isTargetInFootstepRange(dist, maxDist) {
    const d = _isNum(dist) ? dist : Infinity;
    const max = _isPos(maxDist) ? maxDist : ENEMY_FOOTSTEP_MAX_DIST;
    return d < max;
  }

  function relocateFacingAlignment(toX, toZ, fwdX, fwdZ, rad) {
    const tx = _isNum(toX) ? toX : 0, tz = _isNum(toZ) ? toZ : 0, fx = _isNum(fwdX) ? fwdX : 0, fz = _isNum(fwdZ) ? fwdZ : 0, r = _isPos(rad) ? rad : 1;
    return -(tx * fx + tz * fz) / r;
  }
  function relocateCandidateScore(rad, behindAlignment) {
    return -Math.abs((_isNum(rad) ? rad : 20) - 20) + (_isNum(behindAlignment) ? behindAlignment : 0) * 5;
  }


  function stepSlideSteering(dirX, dirZ, inputX, yaw, dt, steerRate, out) {
    const dx = _isNum(dirX) ? dirX : 0, dz = _isNum(dirZ) ? dirZ : 0, target = _isObj(out) ? out : { x: dx, z: dz };
    const ix = _isNum(inputX) ? inputX : 0, deltaT = _isNum(dt) ? dt : 0;
    if (!ix || deltaT <= 0) { target.x = dx; target.z = dz; return target; }
    const rate = _isPos(steerRate) ? steerRate : SLIDE_STEER_RATE, y = _isNum(yaw) ? yaw : 0;
    const nx = dx + (ix * Math.cos(y)) * rate * deltaT, nz = dz - (ix * Math.sin(y)) * rate * deltaT, l = Math.hypot(nx, nz) || 1;
    target.x = nx / l; target.z = nz / l; return target;
  }

  function isTacSprintTriggered(gameT, lastSprintTap, isExhausted, windowSec) {
    return ((_isNum(gameT) ? gameT : 0) - (_isNum(lastSprintTap) ? lastSprintTap : -99)) < (_isPos(windowSec) ? windowSec : TAC_TAP_WINDOW) && !isExhausted;
  }

  function stepGrenadeBounceVelocity(vx, vy, vz, bounce, groundedCount, out) {
    const target = _isObj(out) ? out : { x: 0, y: 0, z: 0 }, gCount = _isNum(groundedCount) ? groundedCount : 0;
    const latDamp = GRENADE_BOUNCE_LAT_DAMP * (gCount > 1 ? GRENADE_ROLL_LAT_DAMP : 1);
    target.x = (_isNum(vx) ? vx : 0) * latDamp; target.y = -(_isNum(vy) ? vy : 0) * (_isNonNeg(bounce) ? bounce : 0.45); target.z = (_isNum(vz) ? vz : 0) * latDamp; return target;
  }
  function isGrenadeAtRest(hSpeedSq, vy, posY, groundedCount) {
    return (_isNum(groundedCount) ? groundedCount : 0) > 1 && (_isNum(hSpeedSq) ? hSpeedSq : 0) < 0.1 && Math.abs(_isNum(vy) ? vy : 0) < 0.2 && (_isNum(posY) ? posY : 0) <= 0.12;
  }
  function downBleedoutLabel(remainingSec) {
    return 'BLEEDING OUT — ' + Math.max(0, _isNum(remainingSec) ? remainingSec : 0).toFixed(1) + 's';
  }
  function multikillBonus(baseBonus, killStreak) {
    const ks = _isNum(killStreak) ? Math.floor(killStreak) : 0;
    return ks < 2 ? 0 : (_isPos(baseBonus) ? baseBonus : 60) * (ks - 1);
  }
  function waveCountdownLabel(waveNum, betweenWaveT) {
    const wn = _isNum(waveNum) ? waveNum : 0, n = Math.max(1, Math.ceil(_isNum(betweenWaveT) ? betweenWaveT : 0));
    return (wn === 0) ? ('COMBAT IN ' + n) : ('NEXT WAVE IN ' + n);
  }
  function waveBannerLabels(waveNum, isCleared, victoryWave) {
    const n = _isNum(waveNum) ? waveNum : 0;
    return n === 0 ? { big: 'GET READY', sub: '' } : (isCleared ? { big: 'WAVE ' + n + ' CLEARED', sub: '' } : { big: 'WAVE ' + n, sub: n === (_isNum(victoryWave) ? victoryWave : 15) ? 'FINAL WAVE' : 'HOSTILES INBOUND' });
  }

  // ---- Ballistic tracer & impact lifecycle, sentry kinematics, thermite burn (perf win) ----
  const SENTRY_AIM_Y_OFFSET = 1.1;
  const BURN_TICK_INTERVAL = 0.25;

  function stepTracerLife(life, dt) { return Math.max(0, ((_isNum(life)) ? life : 0) - ((_isNum(dt)) ? dt : 0)); }
  function isTracerExpired(life) { return !_isPos(life); }
  function stepImpactLife(life, dt) { return Math.max(0, ((_isNum(life)) ? life : 0) - ((_isNum(dt)) ? dt : 0)); }
  function isImpactExpired(life) { return !_isPos(life); }
  function sentryTargetYaw(dx, dz) { return Math.atan2((_isNum(dx)) ? dx : 0, (_isNum(dz)) ? dz : 0) + Math.PI; }
  function stepSentryTimers(t, cd, dt, out) {
    const res = out || { t: 0, cd: 0, expired: false, readyToFire: false }, delta = _isNum(dt) ? dt : 0;
    const curT = _isNum(t) ? t - delta : 0, curCd = _isNum(cd) ? cd - delta : 0;
    res.t = curT; res.cd = curCd; res.expired = curT <= 0; res.readyToFire = curCd <= 0; return res;
  }
  function sentryAimTargetY(enemyY, offset) { return ((_isNum(enemyY)) ? enemyY : 0) + ((_isNum(offset)) ? offset : SENTRY_AIM_Y_OFFSET); }
  function burnTickDamage(dps, interval) { return (_isNum(dps) ? Math.max(0, dps) : 0) * (_isNum(interval) ? Math.max(0, interval) : BURN_TICK_INTERVAL); }
  function isPointInBurnRadius(px, pz, bx, bz, radius) {
    const r = _isNum(radius) ? radius : 0;
    return r > 0 && (((px - bx) * (px - bx) + (pz - bz) * (pz - bz)) < (r * r));
  }
  const GRENADE_POOL_MAX = 12;
  function canRecycleGrenade(fuseOrCount, atRestOrMax) {
    if (typeof atRestOrMax === 'boolean') return ((_isNum(fuseOrCount)) ? fuseOrCount : 0) <= 0 || atRestOrMax;
    return ((_isNum(fuseOrCount)) ? fuseOrCount : 0) < (_isPos(atRestOrMax) ? atRestOrMax : GRENADE_POOL_MAX);
  }

  // ---- Ballistic spread, aim assist dynamics, enemy AI state kinetics, mantle & grenade loft balance rules (v110 balance tuning) ----
  const SPREAD_LONGITUDINAL_SCALE = 0.3, AIM_ASSIST_HEAD_THRESHOLD = 0.55, AIM_ASSIST_HEAD_PRIORITY = 1.8, AIM_ASSIST_PULL_WEIGHT = 0.25, AIM_ASSIST_TRACK_RATE = 3.5, AIM_ASSIST_CHEST_OFFSET = 1.0, AIM_ASSIST_HEAD_OFFSET = 1.68, BULLET_MAGNET_Y_OFFSET = 1.1;
  const ENEMY_SPAWN_DURATION = 0.5, ENEMY_STRAFE_MAX_T = 6.0, GRENADIER_STRAFE_RANGE = 34, GRENADIER_STRAFE_DURATION = 2.5, RIFLEMAN_STRAFE_DURATION = 2.0, RIFLEMAN_LOS_RETRY_DELAY = 0.4, FLANK_STEER_WEIGHT = 0.45, ENEMY_OVERLAP_MIN_DIST = 0.05, ENEMY_SHOT_CHEST_Y_OFFSET = 0.2;
  const MANTLE_DURATION = 0.35, MANTLE_COYOTE_GRACE = 0.12, GRENADE_PITCH_LOFT = 0.45, GRENADE_COOLDOWN = 0.8, TACTICAL_SPEED_MUL = 1.15, PLAYER_FLASH_SELF_MUL = 0.6;

  function ballisticSpreadVector(dirX, dirY, dirZ, spread, randX, randY, randZ, out) {
    const o = out || { x: 0, y: 0, z: 0 }, s = _isNum(spread) ? Math.max(0, spread) : 0;
    const x = (_isNum(dirX) ? dirX : 0) + ((_isNum(randX) ? randX : 0.5) - 0.5) * 2 * s, y = (_isNum(dirY) ? dirY : 0) + ((_isNum(randY) ? randY : 0.5) - 0.5) * 2 * s;
    const z = (_isNum(dirZ) ? dirZ : -1) + ((_isNum(randZ) ? randZ : 0.5) - 0.5) * 2 * s * SPREAD_LONGITUDINAL_SCALE, l = Math.hypot(x, y, z) || 1;
    o.x = x / l; o.y = y / l; o.z = z / l; return o;
  }
  function bulletPenetrationPower(weaponType, weaponPenModifier) {
    return penetrationPower(weaponType) * (_isPos(weaponPenModifier) ? weaponPenModifier : 1);
  }
  function isAimAssistHeadCandidate(headAngle, bestAngle, threshold) {
    return ((_isNum(headAngle)) ? headAngle : Infinity) < ((_isNum(bestAngle)) ? bestAngle : 0) * (_isNum(threshold) ? threshold : AIM_ASSIST_HEAD_THRESHOLD);
  }
  function aimAssistAngularDeltas(targetFwdX, targetFwdY, targetFwdZ, curFwdX, curFwdY, curFwdZ, out) {
    const o = out || { yawDelta: 0, pitchDelta: 0 };
    const tx = _isNum(targetFwdX) ? targetFwdX : 0, ty = _isNum(targetFwdY) ? targetFwdY : 0, tz = _isNum(targetFwdZ) ? targetFwdZ : -1;
    const cx = _isNum(curFwdX) ? curFwdX : 0, cy = _isNum(curFwdY) ? curFwdY : 0, cz = _isNum(curFwdZ) ? curFwdZ : -1;
    let dyaw = Math.atan2(-tx, -tz) - Math.atan2(-cx, -cz);
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    o.yawDelta = dyaw; o.pitchDelta = Math.asin(Math.max(-1, Math.min(1, ty))) - Math.asin(Math.max(-1, Math.min(1, cy))); return o;
  }
  function stepAimAssistLook(yaw, pitch, yawDelta, pitchDelta, dt, trackRate, out) {
    const o = out || { yaw: 0, pitch: 0 }, r = (_isNum(trackRate) ? trackRate : AIM_ASSIST_TRACK_RATE) * (_isNum(dt) ? Math.max(0, dt) : 0);
    o.yaw = ((_isNum(yaw)) ? yaw : 0) + ((_isNum(yawDelta)) ? yawDelta : 0) * r;
    o.pitch = Math.max(-1.45, Math.min(1.45, ((_isNum(pitch)) ? pitch : 0) + ((_isNum(pitchDelta)) ? pitchDelta : 0) * r)); return o;
  }
  function enemyAiNextState(kind, curState, stateT, dist, hasLOS, rangedRange, preferredRange, out) {
    const o = out || { state: 'chase', stateT: 0, strafeT: 0, resetStateT: false };
    const k = _isNum(kind) ? kind : 0, s = curState || 'chase', st = _isNum(stateT) ? stateT : 0, d = _isNum(dist) ? dist : 0;
    const los = !!hasLOS, rr = _isNum(rangedRange) ? rangedRange : 44, pr = _isNum(preferredRange) ? preferredRange : 16;
    o.state = s; o.strafeT = 0; o.resetStateT = false;
    if (s === 'spawn') { if (st > ENEMY_SPAWN_DURATION) { o.state = 'chase'; o.resetStateT = true; } }
    else if (k === 1) {
      if (d < rr && los) { if (s !== 'strafe' && s !== 'shoot') { o.state = 'strafe'; o.strafeT = RIFLEMAN_STRAFE_DURATION; } }
      else if (s !== 'chase') o.state = 'chase';
      if (o.state === 'strafe' && st > ENEMY_STRAFE_MAX_T) { o.state = 'chase'; o.resetStateT = true; }
    } else if (k === 5) {
      if (d < pr) o.state = 'fallback';
      else if (d < GRENADIER_STRAFE_RANGE && los) { if (s !== 'strafe') { o.state = 'strafe'; o.strafeT = GRENADIER_STRAFE_DURATION; } }
      else o.state = 'chase';
    } else o.state = 'chase';
    return o;
  }
  function stepFlankVelocity(mvx, mvz, strafeDir, bias, out) {
    const o = out || { x: 0, z: 0 }, b = _clamp01((_isNum(bias) ? bias : 0) * FLANK_STEER_WEIGHT), vx = _isNum(mvx) ? mvx : 0, vz = _isNum(mvz) ? mvz : 0;
    if (b <= 0.001) { o.x = vx; o.z = vz; return o; }
    const s = strafeDir === -1 ? -1 : 1, nx = vx * (1 - b) - vz * s * b, nz = vz * (1 - b) + vx * s * b, l = Math.hypot(nx, nz) || 1;
    o.x = nx / l; o.z = nz / l; return o;
  }
  function playerPushoutOffset(enemyX, enemyZ, playerX, playerZ, enemyYaw, dist, stopDist, out) {
    const o = out || { pushX: 0, pushZ: 0, applied: false }, d = _isNum(dist) ? dist : 0, overlap = (_isNum(stopDist) ? stopDist : 1.9) - d;
    if (overlap <= 0) { o.pushX = 0; o.pushZ = 0; o.applied = false; return o; }
    const yaw = _isNum(enemyYaw) ? enemyYaw : 0, nx = d > ENEMY_OVERLAP_MIN_DIST ? (enemyX - playerX) / d : -Math.sin(yaw), nz = d > ENEMY_OVERLAP_MIN_DIST ? (enemyZ - playerZ) / d : -Math.cos(yaw);
    o.pushX = nx * overlap; o.pushZ = nz * overlap; o.applied = true; return o;
  }

  function enemyAimTargetY(playerPosY, chestOffset) {
    return ((_isNum(playerPosY)) ? playerPosY : 1.7) - ((_isNum(chestOffset)) ? chestOffset : ENEMY_SHOT_CHEST_Y_OFFSET);
  }
  function stepMantleProgress(mantleT, dt, duration) {
    const dur = _isPos(duration) ? duration : MANTLE_DURATION, remaining = Math.max(0, ((_isNum(mantleT)) ? mantleT : dur) - ((_isNum(dt)) ? Math.max(0, dt) : 0));
    return { remainingT: remaining, progressK: _clamp01(1 - remaining / dur), completed: remaining === 0 };
  }
  function grenadeThrowVelocity(fwdX, fwdY, fwdZ, speed, loft, out) {
    const o = out || { x: 0, y: 0, z: 0 }, spd = _isNum(speed) ? Math.max(0, speed) : 9.5;
    const vx = _isNum(fwdX) ? fwdX : 0, vy = (_isNum(fwdY) ? fwdY : 0) + (_isNum(loft) ? loft : GRENADE_PITCH_LOFT), vz = _isNum(fwdZ) ? fwdZ : -1, l = Math.hypot(vx, vy, vz) || 1;
    o.x = (vx / l) * spd; o.y = (vy / l) * spd; o.z = (vz / l) * spd; return o;
  }
  function playerSelfFlashDuration(flashStrength, baseDur, selfMultiplier) {
    const mul = _isNum(selfMultiplier) ? selfMultiplier : PLAYER_FLASH_SELF_MUL;
    return flashDuration(flashStrength, (_isNum(baseDur) ? baseDur : 2.5) * mul);
  }

  // ---- Tactical Minimap Deployables & Drops, Dynamic Grenade Danger Ring & Thermite Burn VFX (v112 Visual Polish) ----
  const GRENADE_RING_BASE_OPACITY = 0.32, GRENADE_RING_MAX_OPACITY = 0.78, MINIMAP_SENTRY_COLOR = '#50b4ff', MINIMAP_MUNITIONS_COLOR = '#8fd66a';
  const MINIMAP_PICKUP_AMMO_COLOR = '#ffd24a', MINIMAP_PICKUP_MED_COLOR = '#4fd08a', MINIMAP_PICKUP_POWER_COLOR = '#d070ff', MINIMAP_SENTRY_RADIUS = 3.2, MINIMAP_MUNITIONS_SIZE = 4.5, MINIMAP_PICKUP_BASE_RADIUS = 2.2, BURN_PATCH_HEAT_FLICKER_FREQ = 12;
  function grenadeDangerRingOpacity(fuse, restFuse) {
    if (!_isPos(fuse)) return 0;
    if (fuse > 1.6) return GRENADE_RING_BASE_OPACITY;
    const urgency = 1 - Math.max(0, fuse / 1.6), pulse = Math.sin((1.6 - fuse) * (4 + urgency * 6) * Math.PI * 2) * 0.5 + 0.5, peak = GRENADE_RING_BASE_OPACITY + (GRENADE_RING_MAX_OPACITY - GRENADE_RING_BASE_OPACITY) * urgency;
    return Math.max(0.12, GRENADE_RING_BASE_OPACITY + (peak - GRENADE_RING_BASE_OPACITY) * pulse);
  }
  function burnPatchPulsingOpacity(remainingT, totalLife, maxOpacity) {
    if (!_isPos(remainingT)) return 0;
    const b = _clamp01(remainingT / (_isPos(totalLife) ? totalLife : 1.0)), sh = Math.sin(remainingT * BURN_PATCH_HEAT_FLICKER_FREQ) * 0.08 + Math.cos(remainingT * 19) * 0.05;
    return Math.max(0, Math.min(1, (_isNum(maxOpacity) ? maxOpacity : 0.5) * (b + sh * b)));
  }
  function burnPatchFlameStrength(remainingT, totalLife) { return !_isPos(remainingT) ? 0 : _clamp01(remainingT / (_isPos(totalLife) ? totalLife : 1.0)); }
  function minimapPickupColor(kind) { return kind === 'med' ? MINIMAP_PICKUP_MED_COLOR : (kind === 'power' ? MINIMAP_PICKUP_POWER_COLOR : MINIMAP_PICKUP_AMMO_COLOR); }
  function pickupMinimapPulse(t, blinkStart, maxLife, baseRadius) {
    const b = _isPos(baseRadius) ? baseRadius : MINIMAP_PICKUP_BASE_RADIUS, curT = _isNum(t) ? t : 0, bStart = _isNum(blinkStart) ? blinkStart : PICKUP_BLINK_START, mL = _isNum(maxLife) ? maxLife : PICKUP_LIFE;
    if (curT >= mL) return 0;
    if (curT <= bStart) return b;
    const prog = (curT - bStart) / Math.max(0.001, mL - bStart);
    return b * (0.6 + 0.8 * (Math.sin((curT - bStart) * (3 + prog * 4) * Math.PI * 2) * 0.5 + 0.5));
  }
  function sentryMinimapPointer(bx, bz, sentryYaw, length, out) {
    const o = out || { x: 0, z: 0 }, len = _isNum(length) ? length : 5.5, y = _isNum(sentryYaw) ? sentryYaw : 0;
    o.x = bx - Math.sin(y) * len; o.z = bz - Math.cos(y) * len; return o;
  }

  // ---- Tactical Battlefield & Weapon Audio Polish (v113 Audio Polish) ----
  const BULLET_WHIZ_MAX_DIST = 3.6, BULLET_WHIZ_MIN_OFFSET = 0.75, LOW_AMMO_THRESHOLD_AR = 5, LOW_AMMO_THRESHOLD_SMG = 6, LOW_AMMO_THRESHOLD_BR = 4, LOW_AMMO_THRESHOLD_SR = 1;
  function bulletWhizSound() { return 'bullet_whiz'; }
  function isBulletNearMiss(dist, maxDist) { return _isPos(dist) && dist <= (_isPos(maxDist) ? maxDist : BULLET_WHIZ_MAX_DIST); }
  function bulletNearMissOffset(seedX, seedY, minOffset, maxOffset, out) {
    const o = out || { x: 0, y: 0, z: 0 }, minO = _isNonNeg(minOffset) ? minOffset : BULLET_WHIZ_MIN_OFFSET, maxO = _isNum(maxOffset) && maxOffset > minO ? maxOffset : BULLET_WHIZ_MAX_DIST;
    const sx = _isNum(seedX) ? seedX : 0.5, sy = _isNum(seedY) ? seedY : 0.5;
    const magX = minO + Math.abs(sx) * (maxO - minO), magY = (minO * 0.4) + Math.abs(sy) * (maxO * 0.5 - minO * 0.4);
    o.x = (sx < 0 ? -1 : 1) * Math.max(minO, Math.min(maxO, magX));
    o.y = (sy < 0 ? -1 : 1) * Math.max(minO * 0.4, Math.min(maxO * 0.5, magY));
    o.z = 0; return o;
  }
  function bulletWhizVolume(dist, maxDist) {
    if (!_isPos(dist)) return 0;
    const maxD = _isPos(maxDist) ? maxDist : BULLET_WHIZ_MAX_DIST;
    return dist >= maxD ? 0 : _clamp01(1 - dist / maxD);
  }
  function lowAmmoThreshold(weaponType) {
    return weaponType === 'SR' ? LOW_AMMO_THRESHOLD_SR : (weaponType === 'SMG' ? LOW_AMMO_THRESHOLD_SMG : (weaponType === 'BR' ? LOW_AMMO_THRESHOLD_BR : LOW_AMMO_THRESHOLD_AR));
  }
  function isLowAmmo(ammo, weaponType) { return _isPos(ammo) && ammo <= lowAmmoThreshold(weaponType); }
  function lowAmmoSound(ammo, weaponType) { return isLowAmmo(ammo, weaponType) ? 'low_ammo' : null; }
  function reloadBoltSound(weaponType) { return weaponType === 'SR' ? 'sniper_bolt' : 'reload_bolt'; }
  function isEmptyReload(ammo) { return _isNum(ammo) && ammo <= 0; }

  // ---- Tactical Stance Weapon Recoil Stability & Enemy Grenade/LOS Combat Balance (v114 Balance Tuning) ----
  const STANCE_RECOIL_CROUCH = 0.80, STANCE_RECOIL_SLIDE = 0.85, STANCE_RECOIL_AIRBORNE = 1.25;
  const ENEMY_GRENADE_ARM_DURATION = 0.5, ENEMY_LIVE_GRENADES_CAP = 6, GRENADIER_INITIAL_NADE_DELAY = 3.0, RIFLEMAN_INITIAL_NADE_DELAY = 6.0;
  const ENEMY_EYE_OFFSET_Y = 0.5, ENEMY_LOS_JITTER = 0.3, ENEMY_MELEE_COOLDOWN_SENTINEL = -1.0, ENEMY_MELEE_RESET_MARGIN = 0.01;
  function stanceRecoilMultiplier(isCrouching, isSliding, isAirborne) {
    return isAirborne ? STANCE_RECOIL_AIRBORNE : (isSliding ? STANCE_RECOIL_SLIDE : (isCrouching ? STANCE_RECOIL_CROUCH : 1.0));
  }
  function effectiveRecoilKick(recoilV, recoilH, patternX, patternY, stanceMultiplier, out) {
    const o = out || { pitchKick: 0, yawKick: 0 }, sm = _isPos(stanceMultiplier) ? stanceMultiplier : 1.0;
    o.pitchKick = (_isNum(recoilV) ? recoilV : 0) * (_isNum(patternY) ? patternY : 0) * sm;
    o.yawKick = (_isNum(recoilH) ? recoilH : 0) * (_isNum(patternX) ? patternX : 0) * sm; return o;
  }
  function enemyInitialGrenadeDelay(kind) { return kind === 5 ? GRENADIER_INITIAL_NADE_DELAY : (kind === 1 ? RIFLEMAN_INITIAL_NADE_DELAY : Infinity); }
  function canSpawnEnemyGrenade(liveGrenadesCount, cap) { return (_isNum(liveGrenadesCount) ? liveGrenadesCount : 0) < (_isPos(cap) ? cap : ENEMY_LIVE_GRENADES_CAP); }
  function enemyGrenadeVelocity(dx, dz, dist, speed, arcY, randX, randZ, jitter, out) {
    const o = out || { x: 0, y: 0, z: 0 }, d = _isPos(dist) ? dist : (Math.hypot(dx, dz) || 1), spd = _isPos(speed) ? speed : 10;
    const ay = _isNum(arcY) ? arcY : ENEMY_GRENADE_ARC_Y, jit = _isNum(jitter) ? jitter : ENEMY_GRENADE_JITTER;
    const nx = dx / d, nz = dz / d, len = Math.hypot(nx, ay, nz) || 1;
    o.x = (nx / len) * spd + (_isNum(randX) ? randX - 0.5 : 0) * jit; o.y = (ay / len) * spd; o.z = (nz / len) * spd + (_isNum(randZ) ? randZ - 0.5 : 0) * jit; return o;
  }
  function enemyEyeHeight(posY, kind, pelvisH, eyeOffset) { return ((_isNum(posY)) ? posY : 0) + ((_isNum(pelvisH)) ? pelvisH : 0.95) * (kind === 2 ? 1.25 : 1.0) + ((_isNum(eyeOffset)) ? eyeOffset : ENEMY_EYE_OFFSET_Y); }
  function enemyLosTargetCoord(coord, randVal, jitter) { return ((_isNum(coord)) ? coord : 0) + ((_isNum(randVal)) ? (randVal - 0.5) : 0) * ((_isNum(jitter)) ? jitter : ENEMY_LOS_JITTER); }
  function isEnemyMeleeReset(swinging, sentinel, margin) { return typeof swinging === 'number' && isFinite(swinging) && swinging <= ((_isNum(sentinel)) ? sentinel : ENEMY_MELEE_COOLDOWN_SENTINEL) - ((_isNum(margin)) ? margin : ENEMY_MELEE_RESET_MARGIN); }

  // ---- Zero-Alloc Raycast Hit Pooling, GPU Particle Update Throttling & Core Perf Rules (v115 Perf Win) ----
  function shouldUpdatePfxLayer(alive, prevAlive, hasNew) {
    return ((_isNum(alive)) ? alive : 0) > 0 || ((_isNum(prevAlive)) ? prevAlive : 0) > 0 || !!hasNew;
  }
  function isGrenadeLosBlocker(isGround, isVfx, isGun, isSky, isPickup) {
    return !isGround && !isVfx && !isGun && !isSky && !isPickup;
  }
  function enemyToPlayerDir(dx, dz, dist, out) {
    const o = out || { x: 0, z: 0 }, d = _isNum(dist) ? dist : Math.hypot(dx, dz);
    o.x = d > 0.01 ? dx / d : 0; o.z = d > 0.01 ? dz / d : 0; return o;
  }
  function totalPlayerRounds(wState, weaponsOwned) {
    if (!Array.isArray(wState) || !Array.isArray(weaponsOwned)) return 0;
    let rounds = 0;
    for (let i = 0; i < wState.length; i++) {
      if (!wState[i] || weaponsOwned[i] < 0) continue;
      rounds += Math.max(0, (_isNum(wState[i].ammo) ? wState[i].ammo : 0)) + Math.max(0, (_isNum(wState[i].reserve) ? wState[i].reserve : 0));
    }
    return rounds;
  }
  function hasPlayerRounds(wState, weaponsOwned) {
    return totalPlayerRounds(wState, weaponsOwned) > 0;
  }

  // ---- Blast Scorch & Enemy Muzzle Flash Visual Rules (v117 Visual Polish) ----
  const SCORCH_MAX = 16, SCORCH_LIFETIME = 24.0, SCORCH_FADE_DURATION = 4.0, SCORCH_BASE_RADIUS = 2.5, SCORCH_BASE_OPACITY = 0.88, SCORCH_STANDOFF = 0.016, SCORCH_EXPANSION_DURATION = 0.10;
  const ENEMY_MUZZLE_LIGHT_COLOR = 0xff9944, ENEMY_MUZZLE_LIGHT_INTENSITY = 3.2, ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY = 4.5, ENEMY_MUZZLE_LIGHT_DIST = 9.0, ENEMY_MUZZLE_LIGHT_DUR = 0.08;
  function scorchScale(dmgScale, jitter) {
    return SCORCH_BASE_RADIUS * (_isNum(dmgScale) ? Math.max(0.65, Math.min(1.6, dmgScale)) : 1.0) * (_isNum(jitter) ? 1.0 + (jitter - 0.5) * 0.2 : 1.0);
  }
  function scorchScaleProgress(baseScale, elapsed, duration) {
    const b = _isNum(baseScale) ? baseScale : SCORCH_BASE_RADIUS, dur = _isPos(duration) ? duration : SCORCH_EXPANSION_DURATION, el = _isNum(elapsed) ? Math.max(0, elapsed) : dur;
    if (el >= dur) return b;
    const t = el / dur; return b * (0.45 + 0.55 * (1 - (1 - t) * (1 - t)));
  }
  function scorchOpacity(life, fadeDuration, maxOpacity) {
    if (!_isPos(life)) return 0;
    const maxOp = _isNum(maxOpacity) ? maxOpacity : SCORCH_BASE_OPACITY, fade = _isPos(fadeDuration) ? fadeDuration : SCORCH_FADE_DURATION;
    if (life >= fade) return maxOp;
    const t = _clamp01(life / fade); return maxOp * t * t;
  }
  function stepScorchLife(life, dt) { return _isNum(life) ? Math.max(0, life - (_isNum(dt) ? dt : 0)) : 0; }
  function isScorchExpired(life) { return !_isPos(life); }
  function scorchRotation(rand) { return ((_isNum(rand) ? rand : 0) % 1) * Math.PI * 2; }
  function scorchElevation(blastY, floorY, standoff) { return ((_isNum(floorY)) ? floorY : 0) + (_isNum(standoff) ? standoff : SCORCH_STANDOFF); }
  function enemyMuzzleLightParams(isElite) {
    return { color: ENEMY_MUZZLE_LIGHT_COLOR, intensity: isElite ? ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY : ENEMY_MUZZLE_LIGHT_INTENSITY, distance: isElite ? 11.0 : ENEMY_MUZZLE_LIGHT_DIST, duration: ENEMY_MUZZLE_LIGHT_DUR };
  }

  // ---- Critical Heartbeat, Elite Gunfire & Air Absorption Audio (v118 Audio Polish) ----
  const HEARTBEAT_BPM_MIN = 72, HEARTBEAT_BPM_MAX = 136;
  function heartbeatBpm(health, maxHealth, ratio) { return HEARTBEAT_BPM_MIN + criticalHealthIntensity(health, maxHealth, ratio) * (HEARTBEAT_BPM_MAX - HEARTBEAT_BPM_MIN); }
  function heartbeatInterval(bpm) { return 60 / (_isPos(bpm) ? bpm : HEARTBEAT_BPM_MIN); }
  function stepHeartbeatTimer(timer, dt, bpm) {
    const interval = heartbeatInterval(bpm), next = ((_isNum(timer)) ? timer : 0) - (_isPos(dt) ? dt : 0);
    return next <= 0 ? { ready: true, nextTimer: interval } : { ready: false, nextTimer: next };
  }
  function shouldPlayHeartbeat(isDead, isDowned, isCritical) { return !isDead && !isDowned && !!isCritical; }
  function heartbeatSound() { return 'heartbeat'; }
  function enemyGunfireSound(isElite, kind) { return (Boolean(isElite) || kind === 2 || kind === 'tank') ? 'eshot_elite' : 'eshot'; }

  // ---- Tactical Stance Spread, Blast Camera Shake & Combat Accuracy (v119 Balance Tuning) ----
  const EXPLOSION_KICK_MAX_DIST = 20.0, EXPLOSION_POST_KICK_MAX = 0.80, EXPLOSION_SHOT_KICK_MAX = 1.4, EXPLOSION_SHOT_KICK_CAP = 2.0;
  const HEADSHOT_MUL_SR = 2.4, HEADSHOT_MUL_BR = 2.0, HEADSHOT_MUL_AR = 1.8, HEADSHOT_MUL_SMG = 1.5;
  const ENEMY_ACCURACY_FALLOFF_DIST = 16.0, ENEMY_ACCURACY_MIN_FACTOR = 0.55;
  function explosionKickIntensity(dist, maxDist) {
    const d = (_isNum(dist)) ? Math.max(0, dist) : Infinity, max = _isPos(maxDist) ? maxDist : EXPLOSION_KICK_MAX_DIST;
    return d >= max ? 0 : _clamp01(1 - d / max);
  }
  function explosionPostKick(dist, maxDist, maxKick) { return explosionKickIntensity(dist, maxDist) * (_isPos(maxKick) ? maxKick : EXPLOSION_POST_KICK_MAX); }
  function explosionShotKick(dist, maxDist, maxKick) { return explosionKickIntensity(dist, maxDist) * (_isPos(maxKick) ? maxKick : EXPLOSION_SHOT_KICK_MAX); }
  function applyExplosionShotKick(currentKick, addedKick, maxCap) {
    return Math.min(_isPos(maxCap) ? maxCap : EXPLOSION_SHOT_KICK_CAP, (_isNonNeg(currentKick) ? currentKick : 0) + (_isNonNeg(addedKick) ? addedKick : 0));
  }
  function weaponHeadshotMultiplier(weaponType, defaultMul) {
    const t = String(weaponType || '').toUpperCase();
    return t === 'SR' ? HEADSHOT_MUL_SR : (t === 'BR' ? HEADSHOT_MUL_BR : (t === 'AR' ? HEADSHOT_MUL_AR : (t === 'SMG' ? HEADSHOT_MUL_SMG : (_isPos(defaultMul) ? defaultMul : 1.8))));
  }
  function enemyDistanceAccuracy(baseAcc, dist, nominalDist, maxDist, minFactor) {
    const acc = _isNonNeg(baseAcc) ? baseAcc : 0.5, d = _isNonNeg(dist) ? dist : 0, nom = _isPos(nominalDist) ? nominalDist : ENEMY_ACCURACY_FALLOFF_DIST;
    const max = (_isNum(maxDist) && maxDist > nom) ? maxDist : 44.0, minF = (_isNum(minFactor) && minFactor >= 0 && minFactor <= 1) ? minFactor : ENEMY_ACCURACY_MIN_FACTOR;
    return d <= nom ? acc : (d >= max ? acc * minF : acc * (1 - (1 - minF) * ((d - nom) / (max - nom))));
  }

  // ---- Target Movement & Stance Evasion on Enemy Accuracy (v124 Balance Tuning) ----
  const ENEMY_EVASION_SPRINT_MUL = 0.82, ENEMY_EVASION_TAC_SPRINT_MUL = 0.70, ENEMY_EVASION_SLIDE_MUL = 0.75, ENEMY_EVASION_CROUCH_MUL = 0.85, ENEMY_EVASION_AIRBORNE_MUL = 0.80;
  function enemyTargetEvasionMultiplier(isSprinting, isTacSprint, isSliding, isCrouching, isAirborne) {
    return isSliding ? ENEMY_EVASION_SLIDE_MUL : (isTacSprint ? ENEMY_EVASION_TAC_SPRINT_MUL : (isSprinting ? ENEMY_EVASION_SPRINT_MUL : (isAirborne ? ENEMY_EVASION_AIRBORNE_MUL : (isCrouching ? ENEMY_EVASION_CROUCH_MUL : 1.0))));
  }
  function enemyEffectiveAccuracy(distanceAcc, evasionMul) {
    return _clamp01((_isNonNeg(distanceAcc) ? distanceAcc : 0.5) * (_isNonNeg(evasionMul) ? evasionMul : 1.0));
  }

  // ---- Dynamic Point Light & Flash VFX, Sentry Rangefinding, Shadow Caster Mask & Pickup Opacity Rules (v120 Perf Win) ----
  const FLASH_LIGHT_DECAY_EXPONENT = 2, SENTRY_TARGET_ACQUIRE_EPSILON = 1e-4;
  function stepFlashLightLife(life, dt) { return Math.max(0, ((_isNum(life)) ? life : 0) - ((_isNum(dt)) ? dt : 0)); }
  function flashLightIntensity(life, maxLife, peakIntensity) {
    if (!_isPos(life) || !_isPos(maxLife)) return 0;
    const t = _clamp01(life / maxLife);
    return ((_isNum(peakIntensity)) ? peakIntensity : 0) * t * t;
  }
  function particlePerspectiveScale(screenHeight, fovDeg) {
    const h = _isPos(screenHeight) ? screenHeight : 720, fov = _isPos(fovDeg) ? fovDeg : 60, rad = (fov * Math.PI) / 180;
    return h / (2 * Math.tan(rad / 2));
  }
  function isSentryTargetInRange(dx, dz, maxRangeSq) {
    const x = (_isNum(dx)) ? dx : 0, z = (_isNum(dz)) ? dz : 0;
    return (x * x + z * z) < ((_isNum(maxRangeSq)) ? maxRangeSq : 0);
  }
  function buildShadowCasterMask(casterIndices, totalCount, maskOut) {
    const count = (_isNum(totalCount)) ? Math.max(0, totalCount) : 0, mask = maskOut || new Array(count);
    mask.length = count; mask.fill(false);
    if (Array.isArray(casterIndices)) for (let i = 0; i < casterIndices.length; i++) { const idx = casterIndices[i]; if (idx >= 0 && idx < count) mask[idx] = true; }
    return mask;
  }
  function planarFacingDirection(dirX, dirZ, out) {
    const o = out || { x: 0, z: 0 }, x = (_isNum(dirX)) ? dirX : 0, z = (_isNum(dirZ)) ? dirZ : 0, len = Math.hypot(x, z) || 1;
    o.x = x / len; o.z = z / len; return o;
  }
  function shouldUpdatePickupOpacity(t, blinkStart, lastOp, curOp) {
    if (lastOp === undefined || lastOp === null) return true;
    if (((_isNum(t)) ? t : 0) < ((_isNum(blinkStart)) ? blinkStart : 20)) return false;
    return Math.abs(((_isNum(curOp)) ? curOp : 1) - ((_isNum(lastOp)) ? lastOp : 1)) >= 0.005;
  }

  // ---- Blood Pool Seep & Gore Visual Rules (v122 Visual Polish) ----
  const BLOOD_POOL_MAX = 16, BLOOD_POOL_LIFETIME = 24.0, BLOOD_POOL_FADE_DURATION = 4.0, BLOOD_POOL_BASE_SIZE = 1.35, BLOOD_POOL_HEAD_MUL = 1.35, BLOOD_POOL_BASE_OPACITY = 0.88, BLOOD_POOL_STANDOFF = 0.012, BLOOD_POOL_EXPANSION_DURATION = 1.2, BLOOD_POOL_SPAWN_MAX_DIST = 60.0;
  function bloodPoolScale(isHead, jitter) {
    return BLOOD_POOL_BASE_SIZE * (isHead ? BLOOD_POOL_HEAD_MUL : 1.0) * (_isNum(jitter) ? 1.0 + (jitter - 0.5) * 0.25 : 1.0);
  }
  function bloodPoolScaleProgress(baseScale, elapsed, duration) {
    const b = _isNum(baseScale) ? baseScale : BLOOD_POOL_BASE_SIZE, dur = _isPos(duration) ? duration : BLOOD_POOL_EXPANSION_DURATION, el = _isNum(elapsed) ? Math.max(0, elapsed) : dur;
    if (el >= dur) return b;
    const t = el / dur; return b * (0.25 + 0.75 * (1 - (1 - t) * (1 - t) * (1 - t)));
  }
  function bloodPoolOpacity(life, fadeDuration, maxOpacity) {
    if (!_isPos(life)) return 0;
    const maxOp = _isNum(maxOpacity) ? maxOpacity : BLOOD_POOL_BASE_OPACITY, fade = _isPos(fadeDuration) ? fadeDuration : BLOOD_POOL_FADE_DURATION;
    if (life >= fade) return maxOp;
    const t = _clamp01(life / fade); return maxOp * t * t;
  }
  function stepBloodPoolLife(life, dt) { return _isNum(life) ? Math.max(0, life - (_isNum(dt) ? dt : 0)) : 0; }
  function isBloodPoolExpired(life) { return !_isPos(life); }
  function bloodPoolRotation(rand) { return ((_isNum(rand) ? rand : 0) % 1) * Math.PI * 2; }
  function bloodPoolElevation(floorY, standoff) { return ((_isNum(floorY)) ? floorY : 0) + (_isNum(standoff) ? standoff : BLOOD_POOL_STANDOFF); }
  function canSpawnBloodPool(settled, alreadySpawned, distToPlayer, maxDist) {
    if (!settled || alreadySpawned) return false;
    return !(_isNum(distToPlayer) && distToPlayer > (_isNum(maxDist) ? maxDist : BLOOD_POOL_SPAWN_MAX_DIST));
  }

  // ---- Sentry Muzzle Kinematics, Flashlight Dynamics & Combat Penetration / Strike (v127) ----
  const SENTRY_MUZZLE_FORWARD_OFFSET = 0.85, SENTRY_MUZZLE_HEIGHT_OFFSET = 0.60;
  const SENTRY_MUZZLE_LIGHT_COLOR = 0xffaa44, SENTRY_MUZZLE_LIGHT_INTENSITY = 2.8, SENTRY_MUZZLE_LIGHT_DIST = 8.0, SENTRY_MUZZLE_LIGHT_DUR = 0.06;

  function sentryMuzzlePosition(posX, posY, posZ, yaw, forwardOffset, heightOffset, out) {
    const o = out || { x: 0, y: 0, z: 0 }, fwd = (_isNum(forwardOffset)) ? forwardOffset : SENTRY_MUZZLE_FORWARD_OFFSET, h = (_isNum(heightOffset)) ? heightOffset : SENTRY_MUZZLE_HEIGHT_OFFSET, y = (_isNum(yaw)) ? yaw : 0;
    o.x = ((_isNum(posX)) ? posX : 0) - Math.sin(y) * fwd; o.y = ((_isNum(posY)) ? posY : 0) + h; o.z = ((_isNum(posZ)) ? posZ : 0) - Math.cos(y) * fwd;
    return o;
  }
  function sentryShootDirection(fromX, fromY, fromZ, toX, toY, toZ, out) {
    const o = out || { x: 0, y: 0, z: 0 }, dx = ((_isNum(toX)) ? toX : 0) - ((_isNum(fromX)) ? fromX : 0), dy = ((_isNum(toY)) ? toY : 0) - ((_isNum(fromY)) ? fromY : 0), dz = ((_isNum(toZ)) ? toZ : 0) - ((_isNum(fromZ)) ? fromZ : 0), len = Math.hypot(dx, dy, dz) || 1;
    o.x = dx / len; o.y = dy / len; o.z = dz / len; return o;
  }
  function sentryMuzzleLightParams() {
    return { color: SENTRY_MUZZLE_LIGHT_COLOR, intensity: SENTRY_MUZZLE_LIGHT_INTENSITY, distance: SENTRY_MUZZLE_LIGHT_DIST, duration: SENTRY_MUZZLE_LIGHT_DUR };
  }
  function shouldSpawnPenetrationCoverVfx(penMul, worldHitDist, enemyHitDist) {
    return _isNum(penMul) && penMul > 0 && penMul < 1 && _isNum(worldHitDist) && _isNum(enemyHitDist) && worldHitDist < enemyHitDist;
  }
  function canMeleeStrikeWorld(enemyTargetIdx, worldHitDist, meleeReach) {
    const reach = _isPos(meleeReach) ? meleeReach : MELEE_REACH;
    return (typeof enemyTargetIdx !== 'number' || enemyTargetIdx < 0) && _isNum(worldHitDist) && worldHitDist > 0 && worldHitDist <= reach;
  }

  // ---- Melee Combat Impact, Penetration Hitmarker & Landing Shock Acoustics (v128 Audio Polish) ----
  const MELEE_HIT_SOUND = 'melee_hit', MELEE_BACKSTAB_SOUND = 'melee_backstab';
  function meleeHitSound(isBackstab) { return isBackstab ? MELEE_BACKSTAB_SOUND : MELEE_HIT_SOUND; }
  function hitmarkerSound(tier, isHead) {
    return tier === 'kill' ? null : (tier === 'block' ? 'block' : (tier === 'cover' ? (isHead ? 'headshot' : 'hit_cover') : (isHead ? 'headshot' : 'hit')));
  }
  function landingSound(hasFallDamageOrImpactSpeed) {
    return (_isNum(hasFallDamageOrImpactSpeed) ? hasFallDamageOrImpactSpeed > FALL_SAFE_SPEED : Boolean(hasFallDamageOrImpactSpeed)) ? LAND_HEAVY_SOUND : LAND_SOUND;
  }

  // ---- Performance Optimization: Countdown & Downed Timer Change-Gating, Blast Spatial Culling & Ragdoll Momentum (v130) ----
  function waveCountdownChanged(lastState, waveNumOrActive, countdownSec) {
    if (!lastState || typeof lastState !== 'object') return true;
    const n = Math.max(1, Math.ceil((_isNum(countdownSec)) ? countdownSec : 0));
    if (typeof waveNumOrActive === 'boolean') {
      const curSec = _isNum(lastState.sec) ? lastState.sec : lastState.displaySec;
      return lastState.active !== waveNumOrActive || curSec !== n;
    }
    const curSec = _isNum(lastState.displaySec) ? lastState.displaySec : lastState.sec;
    return lastState.waveNum !== ((_isNum(waveNumOrActive)) ? waveNumOrActive : 0) || curSec !== n;
  }
  function syncWaveCountdownState(lastState, waveNumOrActive, countdownSec) {
    if (!lastState || typeof lastState !== 'object') return lastState;
    const n = Math.max(1, Math.ceil((_isNum(countdownSec)) ? countdownSec : 0)), isB = typeof waveNumOrActive === 'boolean';
    lastState.sec = n; lastState.displaySec = n;
    if (isB) { lastState.active = waveNumOrActive; if (lastState.waveNum === undefined) lastState.waveNum = waveNumOrActive ? 1 : 0; }
    else { const wn = (_isNum(waveNumOrActive)) ? waveNumOrActive : 0; lastState.waveNum = wn; lastState.active = wn > 0; }
    return lastState;
  }
  function downedTimerChanged(lastState, isDowned, leftSec) {
    if (!lastState || typeof lastState !== 'object') return true;
    const downed = !!isDowned;
    return lastState.downed !== downed || (downed && lastState.tenths !== Math.round(Math.max(0, (_isNum(leftSec)) ? leftSec : 0) * 10));
  }
  function syncDownedTimerState(lastState, isDowned, leftSec) {
    if (!lastState || typeof lastState !== 'object') return lastState;
    const downed = !!isDowned;
    lastState.downed = downed;
    lastState.tenths = downed ? Math.round(Math.max(0, (_isNum(leftSec)) ? leftSec : 0) * 10) : -1;
    return lastState;
  }
  function flashOverlayChanged(lastOpacity, curOpacity, epsilon) {
    if (!_isNum(lastOpacity)) return true;
    return Math.abs(((_isNum(curOpacity)) ? curOpacity : 0) - lastOpacity) >= (_isPos(epsilon) ? epsilon : 0.008);
  }

  function isTargetInBlastRadius(dx, dy, dz, maxRadiusSq) {
    const limSq = _isPos(maxRadiusSq) ? maxRadiusSq : 0;
    return limSq > 0 && (dx * dx + dy * dy + dz * dz) < limSq;
  }

  function blastTargetDistance(dx, dy, dz) {
    return (!_isNum(dx) || !_isNum(dy) || !_isNum(dz)) ? 0 : Math.hypot(dx, dy, dz);
  }

  const SOLDIER_RAGDOLL_MOMENTUM_SCALE = 0.55, SOLDIER_RAGDOLL_KNOCK_BASE = 9.0, SOLDIER_RAGDOLL_KNOCK_MIN = 2.0;

  function soldierRagdollKnockback(enX, enZ, blastX, blastZ, out) {
    const kx = enX - blastX, kz = enZ - blastZ, kl = Math.hypot(kx, kz) || 1, kf = Math.max(SOLDIER_RAGDOLL_KNOCK_MIN, SOLDIER_RAGDOLL_KNOCK_BASE - kl);
    const o = _isObj(out) ? out : { x: 0, z: 0 };
    o.x = (kx / kl) * kf; o.z = (kz / kl) * kf; return o;
  }

  function soldierRagdollMomentum(velX, velZ, knockX, knockZ, momentumScale, out) {
    const ms = (_isNum(momentumScale)) ? momentumScale : SOLDIER_RAGDOLL_MOMENTUM_SCALE, o = _isObj(out) ? out : { x: 0, y: 0, z: 0 };
    o.x = velX * ms + ((_isNum(knockX)) ? knockX : 0); o.y = 0; o.z = velZ * ms + ((_isNum(knockZ)) ? knockZ : 0); return o;
  }

  // ---- Tactical Detonation VFX & Headshot Ballistic Impact Visual Polish (v132) ----
  const TACTICAL_FLASH_LIGHT_BLIND_COLOR = 0xffffff, TACTICAL_FLASH_LIGHT_BLIND_INTENSITY = 18.0, TACTICAL_FLASH_LIGHT_BLIND_DIST = 24.0, TACTICAL_FLASH_LIGHT_BLIND_DUR = 0.30;
  const TACTICAL_FLASH_LIGHT_STUN_COLOR = 0x60b0ff, TACTICAL_FLASH_LIGHT_STUN_INTENSITY = 12.0, TACTICAL_FLASH_LIGHT_STUN_DIST = 18.0, TACTICAL_FLASH_LIGHT_STUN_DUR = 0.20;
  const HEADSHOT_SPARK_COUNT_HELMET = 6, HEADSHOT_SPARK_COUNT_BARE = 0, HEADSHOT_BLOOD_MIST_HELMET = 8, HEADSHOT_BLOOD_MIST_BARE = 14;

  function tacticalFlashLightParams(effect) {
    if (effect === 'blind') return { color: TACTICAL_FLASH_LIGHT_BLIND_COLOR, intensity: TACTICAL_FLASH_LIGHT_BLIND_INTENSITY, distance: TACTICAL_FLASH_LIGHT_BLIND_DIST, duration: TACTICAL_FLASH_LIGHT_BLIND_DUR };
    if (effect === 'stun') return { color: TACTICAL_FLASH_LIGHT_STUN_COLOR, intensity: TACTICAL_FLASH_LIGHT_STUN_INTENSITY, distance: TACTICAL_FLASH_LIGHT_STUN_DIST, duration: TACTICAL_FLASH_LIGHT_STUN_DUR };
    return { color: 0, intensity: 0, distance: 0, duration: 0 };
  }

  function tacticalParticleParams(effect) {
    if (effect === 'blind') return { coreColor0: 0xffffff, coreColor1: 0xfff0c0, sparkColor0: 0xffffff, sparkColor1: 0xffc860, smokeColor: 0xe8e8ea, flashCount: 16, sparkCount: 22, smokeCount: 14 };
    if (effect === 'stun') return { coreColor0: 0x80d8ff, coreColor1: 0x3060ff, sparkColor0: 0x90e0ff, sparkColor1: 0x2050e0, smokeColor: 0x8a98a8, flashCount: 10, sparkCount: 18, smokeCount: 10 };
    return null;
  }

  function enemyHasHelmet(kind) {
    if (_isNum(kind)) return kind === 1 || kind === 2 || kind === 3 || kind === 5 || kind === 6;
    return kind === 'rifleman' || kind === 'tank' || kind === 'shielded' || kind === 'grenadier' || kind === 'breacher';
  }

  function headshotVfxParams(hasHelmet) {
    return { sparks: hasHelmet ? HEADSHOT_SPARK_COUNT_HELMET : HEADSHOT_SPARK_COUNT_BARE, blood: hasHelmet ? HEADSHOT_BLOOD_MIST_HELMET : HEADSHOT_BLOOD_MIST_BARE, sparkColor: 0xffe080 };
  }

  // ---- Tactical Combat & Locomotion Acoustics (v133 Audio Polish) ----
  const JUMP_SLIDE_SOUND = 'jump_slide', JUMP_SOUND = 'jump', CHAMBER_EMPTY_SOUND = 'chamber_empty', GRENADE_COOK_SOUND = 'pin', ENEMY_HIT_SOUND = 'enemy_hit', ENEMY_HIT_HEAVY_SOUND = 'enemy_hit_heavy';
  function jumpSound(isSlideJump) { return Boolean(isSlideJump) ? JUMP_SLIDE_SOUND : JUMP_SOUND; }
  function chamberEmptySound(ammoAfterShot, weaponType) { return (_isNum(ammoAfterShot) && ammoAfterShot === 0) ? ((weaponType === 'SR' || weaponType === 'BR') ? 'dry_heavy' : CHAMBER_EMPTY_SOUND) : null; }
  function grenadeCookSound() { return GRENADE_COOK_SOUND; }
  function grenadeThrowSound(wasCooked, mode, key) { return Boolean(wasCooked) ? 'draw' : equipmentDeploySound(mode, key); }
  function enemyMeleeHitSound(isTank, isElite) { return Boolean(isTank || isElite) ? ENEMY_HIT_HEAVY_SOUND : ENEMY_HIT_SOUND; }

  // ---- Performance Optimization: Grenade Charge HUD Gating, Tactical Radial Culling, Bullet Magnet Cosine Selection & Cone Range Pre-check (v135) ----
  function grenadeChargeHudChanged(lastState, visible, pct, speed) {
    if (!lastState || typeof lastState !== 'object') return true;
    const vis = Boolean(visible);
    return lastState.visible !== vis || (vis && (lastState.pct !== Math.max(0, Math.min(100, (_isNum(pct)) ? Math.round(pct) : 0)) || lastState.speed !== Math.max(0, (_isNum(speed)) ? Math.round(speed) : 0)));
  }
  function syncGrenadeChargeHudState(lastState, visible, pct, speed) {
    if (!lastState || typeof lastState !== 'object') return lastState;
    const vis = Boolean(visible);
    lastState.visible = vis;
    lastState.pct = vis ? Math.max(0, Math.min(100, (_isNum(pct)) ? Math.round(pct) : 0)) : 0;
    lastState.speed = vis ? Math.max(0, (_isNum(speed)) ? Math.round(speed) : 0) : 0;
    return lastState;
  }
  function grenadeChargeLabel(speed, pct) {
    return 'GRENADE ' + Math.max(0, (_isNum(speed)) ? Math.round(speed) : 0) + ' M/S (' + Math.max(0, Math.min(100, (_isNum(pct)) ? Math.round(pct) : 0)) + '%)';
  }

  function isTargetInTacticalRadius(dx, dz, maxRadiusSq) {
    const limSq = _isPos(maxRadiusSq) ? maxRadiusSq : 0;
    if (limSq <= 0) return false;
    return (dx * dx + dz * dz) < limSq;
  }

  function bulletMagnetMinCos(angleRad) { return Math.cos((_isNum(angleRad)) ? angleRad : 0); }
  function isMagnetCandidateCloser(dotVal, bestCos) { return _isNum(dotVal) && _isNum(bestCos) && dotVal > bestCos; }
  function isTargetInConeRange(dx, dz, rangeSq) {
    const rSq = _isPos(rangeSq) ? rangeSq : 0;
    if (rSq <= 0) return false;
    const dSq = dx * dx + dz * dz;
    return dSq <= rSq && dSq >= 1e-12;
  }

  // ---- Ballistic Shield Deflection & Concussive Landing Dust (v137 Visual Polish) ----
  const SHIELD_DEFLECT_SPARK_COUNT = 12, SHIELD_DEFLECT_SPARK_COLOR0 = 0x90e0ff, SHIELD_DEFLECT_SPARK_COLOR1 = 0xffa040, SHIELD_DEFLECT_LIGHT_COLOR = 0x60b0ff, SHIELD_DEFLECT_LIGHT_INTENSITY = 2.4, SHIELD_DEFLECT_LIGHT_DIST = 4.5, SHIELD_DEFLECT_LIGHT_DUR = 0.05;
  const LANDING_DUST_HEAVY_COUNT = 12, LANDING_DUST_LIGHT_COUNT = 5, LANDING_DUST_COLOR = 0x8a8076;

  function shieldDeflectNormal(enYaw, out) {
    const o = out || { x: 0, y: 0, z: 0 }, yaw = (_isNum(enYaw)) ? enYaw : 0;
    o.x = Math.sin(yaw); o.y = 0; o.z = Math.cos(yaw); return o;
  }
  function shieldDeflectVfxParams(shieldMul) {
    return { sparks: SHIELD_DEFLECT_SPARK_COUNT, sparkColor0: SHIELD_DEFLECT_SPARK_COLOR0, sparkColor1: SHIELD_DEFLECT_SPARK_COLOR1, lightColor: SHIELD_DEFLECT_LIGHT_COLOR, lightIntensity: SHIELD_DEFLECT_LIGHT_INTENSITY, lightDist: SHIELD_DEFLECT_LIGHT_DIST, lightDur: SHIELD_DEFLECT_LIGHT_DUR };
  }
  function landingDustParams(impactSpeed) {
    if (!_isNum(impactSpeed)) return null;
    if (impactSpeed > FALL_SAFE_SPEED) return { count: LANDING_DUST_HEAVY_COUNT, spread: 2.0, color: LANDING_DUST_COLOR };
    if (impactSpeed > 6.0) return { count: LANDING_DUST_LIGHT_COUNT, spread: 1.0, color: LANDING_DUST_COLOR };
    return null;
  }

  // ---- Ballistic Shield Deflection, Helmet Headshot & Heavy Landing Acoustics (v138 Audio Polish) ----
  const SHIELD_DEFLECT_SOUND = 'shield_deflect', HELMET_HIT_SOUND = 'helmet_hit', LAND_HEAVY_SOUND = 'land_heavy', LAND_SOUND = 'land';
  function shieldDeflectSound(isShielded) { return (isShielded === undefined || Boolean(isShielded)) ? SHIELD_DEFLECT_SOUND : null; }
  function helmetHitSound(hasHelmet) { return (hasHelmet === undefined || Boolean(hasHelmet)) ? HELMET_HIT_SOUND : null; }
  function enemyGrenadeThrowSound() { return GRENADE_COOK_SOUND; }

  // ---- Tactical Melee Slash Execution & Weapon Muzzle Light Polish (v142 Visual Polish) ----
  const MELEE_SLASH_SPARK_COUNT = 4, MELEE_SLASH_BACKSTAB_SPARKS = 10, MELEE_SLASH_MIST_COUNT = 6, MELEE_SLASH_BACKSTAB_MIST = 14;
  const MELEE_SLASH_LIGHT_COLOR = 0xff2010, MELEE_SLASH_LIGHT_INTENSITY = 2.4, MELEE_SLASH_LIGHT_DIST = 4.2, MELEE_SLASH_LIGHT_DUR = 0.05;
  function meleeSlashVfxParams(isBackstab) {
    const b = Boolean(isBackstab);
    return { sparks: b ? MELEE_SLASH_BACKSTAB_SPARKS : MELEE_SLASH_SPARK_COUNT, mist: b ? MELEE_SLASH_BACKSTAB_MIST : MELEE_SLASH_MIST_COUNT, lightColor: b ? MELEE_SLASH_LIGHT_COLOR : 0, lightIntensity: b ? MELEE_SLASH_LIGHT_INTENSITY : 0, lightDist: b ? MELEE_SLASH_LIGHT_DIST : 0, lightDur: b ? MELEE_SLASH_LIGHT_DUR : 0 };
  }
  function meleeSlashNormal(playerYaw, out) {
    const o = out || { x: 0, y: 0, z: 0 }, y = (_isNum(playerYaw)) ? playerYaw : 0;
    o.x = Math.cos(y); o.y = 0; o.z = -Math.sin(y); return o;
  }
  const MUZZLE_LIGHT_COLOR_STANDARD = 0xffcc88, MUZZLE_LIGHT_COLOR_SUPPRESSED = 0xffaa55;
  const MUZZLE_LIGHT_DIST_STANDARD = 9.0, MUZZLE_LIGHT_DIST_SUPPRESSED = 4.0, MUZZLE_LIGHT_DIST_HEAVY = 12.0, MUZZLE_LIGHT_DIST_SMG = 7.5;
  function muzzleFlashLightParams(weaponType, isSuppressed) {
    if (isSuppressed) return { color: MUZZLE_LIGHT_COLOR_SUPPRESSED, distance: MUZZLE_LIGHT_DIST_SUPPRESSED, intensityMul: 0.3 };
    const d = weaponType === 'SR' ? MUZZLE_LIGHT_DIST_HEAVY : (weaponType === 'BR' ? 10.5 : (weaponType === 'SMG' ? MUZZLE_LIGHT_DIST_SMG : MUZZLE_LIGHT_DIST_STANDARD));
    const m = weaponType === 'SR' ? 1.45 : (weaponType === 'BR' ? 1.25 : (weaponType === 'SMG' ? 0.8 : 1.0));
    return { color: MUZZLE_LIGHT_COLOR_STANDARD, distance: d, intensityMul: m };
  }
  function muzzleVfxParams(weaponType, isSuppressed) {
    if (isSuppressed) return { smokeCount: 1, sparkCount: 0, smokeScale: 0.4 };
    const wt = weaponType;
    return { smokeCount: wt === 'SR' ? 5 : (wt === 'BR' ? 4 : (wt === 'SMG' ? 2 : 3)), sparkCount: wt === 'SR' ? 7 : (wt === 'BR' ? 5 : (wt === 'SMG' ? 3 : 4)), smokeScale: wt === 'SR' ? 1.0 : (wt === 'BR' ? 0.9 : (wt === 'SMG' ? 0.6 : 0.75)) };
  }

  // ---- Tactical Locomotion Acoustics, Weapon Reload Audio & Melee Blade Surface Polish (v143 Audio Polish) ----
  const ENEMY_STEP_SOUND = 'estep', ENEMY_STEP_HEAVY_SOUND = 'estep_heavy';
  function enemyFootstepSound(kind, isElite) { return (Boolean(isElite) || kind === 2 || kind === 'tank') ? ENEMY_STEP_HEAVY_SOUND : ENEMY_STEP_SOUND; }
  const RELOAD_OUT_SOUND = 'reload_out', RELOAD_IN_SOUND = 'reload_in', RELOAD_HEAVY_OUT_SOUND = 'reload_heavy_out', RELOAD_HEAVY_IN_SOUND = 'reload_heavy_in', RELOAD_SMG_OUT_SOUND = 'reload_smg_out', RELOAD_SMG_IN_SOUND = 'reload_smg_in';
  function reloadMagazineOutSound(weaponType) { return weaponType === 'SMG' ? RELOAD_SMG_OUT_SOUND : ((weaponType === 'SR' || weaponType === 'BR') ? RELOAD_HEAVY_OUT_SOUND : RELOAD_OUT_SOUND); }
  function reloadMagazineInSound(weaponType) { return weaponType === 'SMG' ? RELOAD_SMG_IN_SOUND : ((weaponType === 'SR' || weaponType === 'BR') ? RELOAD_HEAVY_IN_SOUND : RELOAD_IN_SOUND); }
  const MELEE_SURFACE_METAL_SOUND = 'melee_hit_metal', MELEE_SURFACE_WOOD_SOUND = 'impact_wood', MELEE_SURFACE_GLASS_SOUND = 'impact_glass', MELEE_SURFACE_GROUND_SOUND = 'impact_ground', MELEE_SURFACE_DEFAULT_SOUND = 'impact';
  function meleeSurfaceSound(surface) { return surface === 'metal' ? MELEE_SURFACE_METAL_SOUND : (surface === 'wood' ? MELEE_SURFACE_WOOD_SOUND : (surface === 'glass' ? MELEE_SURFACE_GLASS_SOUND : (surface === 'ground' ? MELEE_SURFACE_GROUND_SOUND : MELEE_SURFACE_DEFAULT_SOUND))); }

  // ---- Tactical Weapon Recoil Decay Agility & Stance Stabilization (v144 Balance Tuning) ----
  const RECOIL_DECAY_SMG = 0.006, RECOIL_DECAY_AR = 0.02, RECOIL_DECAY_BR = 0.05, RECOIL_DECAY_SR = 0.10, RECOIL_DECAY_CROUCH_MUL = 0.65, RECOIL_DECAY_SLIDE_MUL = 0.85;
  function weaponRecoilDecayRate(weaponType, isCrouching, isSliding) {
    const t = String(weaponType || '').toUpperCase(), base = t === 'SMG' ? RECOIL_DECAY_SMG : (t === 'BR' ? RECOIL_DECAY_BR : (t === 'SR' ? RECOIL_DECAY_SR : RECOIL_DECAY_AR));
    return base * (isSliding ? RECOIL_DECAY_SLIDE_MUL : (isCrouching ? RECOIL_DECAY_CROUCH_MUL : 1.0));
  }

  // ---- Bullet Magnetism, Munitions Box & Tactical Zone Objective Optimization (v145 Performance Win) ----
  const BULLET_MAGNET_MAX_DIST = 45.0, OBJECTIVE_RING_OPACITY_INSIDE = 0.85, OBJECTIVE_RING_OPACITY_OUTSIDE = 0.40;
  function isTargetInMagnetRange(toX, toZ, maxDistSq) {
    return _isNum(toX) && _isNum(toZ) && ((toX * toX + toZ * toZ) <= (_isPos(maxDistSq) ? maxDistSq : (BULLET_MAGNET_MAX_DIST * BULLET_MAGNET_MAX_DIST)));
  }
  function isTargetInMunitionsRadius(px, pz, mx, mz, radiusSq) {
    return _isNum(px) && _isNum(pz) && _isNum(mx) && _isNum(mz) && (((px - mx) * (px - mx) + (pz - mz) * (pz - mz)) < (_isPos(radiusSq) ? radiusSq : (FIELD_UPGRADE.radius * FIELD_UPGRADE.radius)));
  }
  function stepMunitionsTimers(life, tick, dt, out) {
    const o = out || { t: 0, tick: 0, expired: false, readyToResupply: false }, l = _isNum(life) ? Math.max(0, life) : 0, tk = _isNum(tick) ? tick : 0, d = _isNum(dt) ? Math.max(0, dt) : 0;
    const nextL = Math.max(0, l - d), nextTk = tk - d;
    o.t = nextL; o.expired = nextL <= 0; o.readyToResupply = nextTk <= 0; o.tick = nextTk <= 0 ? 1.0 : nextTk;
    return o;
  }
  function isPlayerInObjectiveZone(px, pz, ox, oz, radiusSq) {
    return _isNum(px) && _isNum(pz) && _isNum(ox) && _isNum(oz) && (((px - ox) * (px - ox) + (pz - oz) * (pz - oz)) < (_isPos(radiusSq) ? radiusSq : (OBJECTIVE_RADIUS * OBJECTIVE_RADIUS)));
  }
  function objectiveRingOpacityChanged(lastInside, inside) { return lastInside !== !!inside; }
  function objectiveRingOpacity(inside) { return inside ? OBJECTIVE_RING_OPACITY_INSIDE : OBJECTIVE_RING_OPACITY_OUTSIDE; }

  // ---- Ordnance Explosion VFX, Sniper Vapor Trail & Enemy Muzzle Flash Rules (v147 Visual Polish) ----
  const EXPLOSION_FIREBALL_BASE_COUNT = 18, EXPLOSION_SPARK_BASE_COUNT = 40, EXPLOSION_SMOKE_BASE_COUNT = 22, EXPLOSION_DUST_BASE_COUNT = 16, EXPLOSION_DEBRIS_BASE_COUNT = 14;
  const EXPLOSION_LIGHT_COLOR = 0xff9040, EXPLOSION_LIGHT_BASE_INTENSITY = 14.0, EXPLOSION_LIGHT_BASE_DIST = 22.0, EXPLOSION_LIGHT_DUR = 0.45;
  function explosionVfxParams(scale) {
    const s = _isPos(scale) ? Math.max(0.4, Math.min(2.5, scale)) : 1.0;
    return { fireballCount: Math.round(EXPLOSION_FIREBALL_BASE_COUNT * s), sparkCount: Math.round(EXPLOSION_SPARK_BASE_COUNT * s), smokeCount: Math.round(EXPLOSION_SMOKE_BASE_COUNT * s), dustCount: Math.round(EXPLOSION_DUST_BASE_COUNT * s), debrisCount: Math.round(EXPLOSION_DEBRIS_BASE_COUNT * s), fireballColor0: 0xfff0c0, fireballColor1: 0xff3808, sparkColor0: 0xffe0a0, sparkColor1: 0xff4010, smokeColor0: 0x3a3230, smokeColor1: 0x1c1a1a, dustColor0: 0x7a6e62, dustColor1: 0x4a443e, debrisColor0: 0x2a2624, debrisColor1: 0x1a1816 };
  }
  function explosionLightParams(scale) {
    const s = _isPos(scale) ? Math.max(0.4, Math.min(2.5, scale)) : 1.0;
    return { color: EXPLOSION_LIGHT_COLOR, intensity: EXPLOSION_LIGHT_BASE_INTENSITY * s, distance: EXPLOSION_LIGHT_BASE_DIST * s, duration: EXPLOSION_LIGHT_DUR };
  }
  const SNIPER_TRAIL_STEP = 1.4, SNIPER_TRAIL_MAX_PUFFS = 45;
  const SNIPER_TRAIL_COLOR0 = 0xc8ccd0, SNIPER_TRAIL_COLOR1 = 0x8a8e94, SNIPER_TRAIL_BASE_SIZE = 0.05, SNIPER_TRAIL_END_SIZE = 0.35, SNIPER_TRAIL_ALPHA = 0.16;
  function sniperTrailPuffCount(dist, step, maxPuffs) {
    const d = _isNum(dist) ? Math.max(0, dist) : 0, st = _isPos(step) ? step : SNIPER_TRAIL_STEP, mp = _isPos(maxPuffs) ? maxPuffs : SNIPER_TRAIL_MAX_PUFFS;
    return Math.min(mp, Math.floor(d / st));
  }
  function sniperTrailParams(dist) {
    return { count: sniperTrailPuffCount(dist, SNIPER_TRAIL_STEP, SNIPER_TRAIL_MAX_PUFFS), color0: SNIPER_TRAIL_COLOR0, color1: SNIPER_TRAIL_COLOR1, baseSize: SNIPER_TRAIL_BASE_SIZE, endSize: SNIPER_TRAIL_END_SIZE, alpha: SNIPER_TRAIL_ALPHA };
  }
  function enemyWeaponType(kind, isElite) {
    if (kind === 2 || kind === 'tank') return 'BR';
    if (kind === 3 || kind === 'shielded' || kind === 4 || kind === 'scout') return 'SMG';
    if (Boolean(isElite)) return 'BR';
    return 'AR';
  }

  // ---- Tactical Audio Polish: Weapon Dry Fire, Resource Pickups, Athletic Melee Swing, and Ordnance Explosions (v148 Audio Polish) ----
  const DRY_FIRE_SOUND = 'dry', DRY_FIRE_HEAVY_SOUND = 'dry_heavy';
  function dryFireSound(weaponType) { return (weaponType === 'SR' || weaponType === 'BR') ? DRY_FIRE_HEAVY_SOUND : DRY_FIRE_SOUND; }
  const PICKUP_AMMO_SOUND = 'pickup_ammo', PICKUP_MED_SOUND = 'pickup_med', PICKUP_POWER_SOUND = 'powerup';
  function pickupSound(kind, powerKey) {
    if (kind === 'med' || kind === 'health') return PICKUP_MED_SOUND;
    if (kind === 'power') {
      const k = powerKey === 'ammo' ? 'maxammo' : powerKey;
      return (k && typeof powerupSound === 'function' ? powerupSound(k) : null) || PICKUP_POWER_SOUND;
    }
    return PICKUP_AMMO_SOUND;
  }
  const MELEE_SWING_SOUND = 'melee', MELEE_SWING_HEAVY_SOUND = 'melee_heavy';
  function meleeSwingSound(isTacSprint, isSliding) { return (Boolean(isTacSprint) || Boolean(isSliding)) ? MELEE_SWING_HEAVY_SOUND : MELEE_SWING_SOUND; }
  const EXPLOSION_SOUND = 'explosion', EXPLOSION_HEAVY_SOUND = 'explosion_heavy';
  function explosionSound(scale) { return (_isNum(scale) && scale >= 1.2) ? EXPLOSION_HEAVY_SOUND : EXPLOSION_SOUND; }

  // ---- Ballistic Surface Impact VFX, Dynamic Light & Blood Spatter Kinematics (v152 Visual Polish) ----
  const SURFACE_IMPACT_DUST_BASE = 3, SURFACE_IMPACT_CHIP_BASE = 5, SURFACE_IMPACT_SPARK_METAL = 8, SURFACE_IMPACT_SPARK_CONCRETE = 1;
  const SURFACE_IMPACT_LIGHT_COLOR_METAL = 0xffb060, SURFACE_IMPACT_LIGHT_COLOR_HEAVY = 0xffd090;
  const BLOOD_DROPLET_BASE_BODY = 6, BLOOD_DROPLET_BASE_HEAD = 10, BLOOD_MIST_BASE_BODY = 2, BLOOD_MIST_BASE_HEAD = 4;
  const _SURFACE_DEFS = {
    concrete: { dust0: 0x8f8a84, dust1: 0x5e5a56, chips: 0xb0aca4, sparks: 1 }, brick: { dust0: 0x9a6a52, dust1: 0x5a3e32, chips: 0x8a4a34, sparks: 0 },
    metal: { dust0: 0x6a6a70, dust1: 0x404048, chips: 0, sparks: 8 }, wood: { dust0: 0x8a6a48, dust1: 0x5a4430, chips: 0x9a7448, sparks: 0 },
    glass: { dust0: 0xa8b8c8, dust1: 0x6a7888, chips: 0xc0d8f0, sparks: 0 }, ground: { dust0: 0x6a625a, dust1: 0x403a36, chips: 0x3a3632, sparks: 1 }
  };
  function surfaceImpactVfxParams(surface, weaponType) {
    const srf = _SURFACE_DEFS[surface] || _SURFACE_DEFS.concrete, wt = weaponType || 'AR', cMul = wt === 'SR' ? 1.4 : (wt === 'BR' ? 1.2 : (wt === 'SMG' ? 0.8 : 1.0));
    return { dustCount: wt === 'SR' ? 5 : (wt === 'BR' ? 4 : (wt === 'SMG' ? 2 : 3)), dustScale: cMul, chipCount: srf.chips ? Math.round(SURFACE_IMPACT_CHIP_BASE * cMul) : 0, sparkCount: srf.sparks ? Math.round(srf.sparks * (wt === 'SR' ? 1.75 : (wt === 'BR' ? 1.35 : (wt === 'SMG' ? 0.65 : 1.0)))) : 0, dustColor0: srf.dust0, dustColor1: srf.dust1, chipColor: srf.chips };
  }
  function surfaceImpactLightParams(surface, weaponType) {
    const s = surface || 'concrete', wt = weaponType || 'AR';
    if (s === 'metal') return wt === 'SR' ? { color: 0xffc070, intensity: 2.2, distance: 5.5, duration: 0.08 } : (wt === 'BR' ? { color: 0xffb060, intensity: 1.6, distance: 4.8, duration: 0.07 } : (wt === 'SMG' ? { color: 0xffa050, intensity: 0.8, distance: 3.2, duration: 0.05 } : { color: 0xffb060, intensity: 1.2, distance: 4.0, duration: 0.06 }));
    if (s === 'concrete' || s === 'brick' || s === 'ground') {
      if (wt === 'SR') return { color: SURFACE_IMPACT_LIGHT_COLOR_HEAVY, intensity: 1.0, distance: 4.0, duration: 0.05 };
      if (wt === 'BR') return { color: 0xffc880, intensity: 0.6, distance: 3.0, duration: 0.04 };
    }
    return { color: 0, intensity: 0, distance: 0, duration: 0 };
  }
  function bloodImpactVfxParams(isHead, weaponType) {
    const h = Boolean(isHead), wt = weaponType || 'AR';
    return { dropletCount: wt === 'SR' ? (h ? 16 : 10) : (wt === 'BR' ? (h ? 13 : 8) : (wt === 'SMG' ? (h ? 7 : 4) : (h ? 10 : 6))), mistCount: wt === 'SR' ? (h ? 6 : 3) : (wt === 'BR' ? (h ? 5 : 2) : (wt === 'SMG' ? (h ? 3 : 1) : (h ? 4 : 2))), mistScale: wt === 'SR' ? (h ? 1.1 : 0.7) : (wt === 'BR' ? (h ? 0.95 : 0.6) : (wt === 'SMG' ? (h ? 0.65 : 0.4) : (h ? 0.8 : 0.5))), dropletColor0: 0x5a0404, dropletColor1: 0x2a0202, mistColor0: 0x6a0808, mistColor1: 0x3a0404 };
  }

  // ---- Tactical Scope Acoustics, Ballistic Casing Bounce & Sound Differentiation (v153 Audio Polish) ----
  const SCOPE_IN_THRESHOLD = 0.8, SCOPE_OUT_THRESHOLD = 0.5;
  const SCOPE_IN_SOUND = 'scope_in', SCOPE_OUT_SOUND = 'scope_out';
  const SCOPE_HEAVY_IN_SOUND = 'scope_heavy_in', SCOPE_HEAVY_OUT_SOUND = 'scope_heavy_out';
  const CASING_SOUND = 'casing', CASING_HEAVY_SOUND = 'casing_heavy';
  const KILL_SOUND = 'kill', KILL_HEADSHOT_SOUND = 'kill_headshot', KILL_ELITE_SOUND = 'kill_elite', KILL_HEAVY_SOUND = 'kill_heavy';
  const SECONDARY_UNLOCK_SOUND = 'draw', STATION_CYCLE_SOUND = 'draw_light';

  function isWeaponScopeType(weaponType) { return weaponType === 'SR' || weaponType === 'BR'; }
  function weaponScopeSound(weaponType, isScoped) { return isScoped ? (weaponType === 'SR' ? SCOPE_HEAVY_IN_SOUND : SCOPE_IN_SOUND) : (weaponType === 'SR' ? SCOPE_HEAVY_OUT_SOUND : SCOPE_OUT_SOUND); }
  function scopeTransitionState(adsAmount, wasScoped) {
    const a = _isNum(adsAmount) ? adsAmount : 0;
    return (!wasScoped && a > SCOPE_IN_THRESHOLD) ? 1 : ((wasScoped && a < SCOPE_OUT_THRESHOLD) ? -1 : 0);
  }
  function casingBounceSound(weaponType) { return (weaponType === 'SR' || weaponType === 'BR') ? CASING_HEAVY_SOUND : CASING_SOUND; }
  function secondaryUnlockSound(weaponType) { return weaponDrawSound(weaponType); }
  function stationCycleSound(stationKind) { return STATION_CYCLE_SOUND; }

  // ---- Tactical Weapon Shot Kick Impulses & Suppressor Dampening (v154 Combat Balance) ----
  const WEAPON_SHOT_KICK_SMG = 0.35, WEAPON_SHOT_KICK_AR = 0.50, WEAPON_SHOT_KICK_BR = 0.70, WEAPON_SHOT_KICK_SR = 1.10;
  const SUPPRESSOR_KICK_MUL = 0.85;
  function weaponShotKickImpulse(weaponType, isSuppressed) {
    const base = weaponType === 'SMG' ? WEAPON_SHOT_KICK_SMG : (weaponType === 'BR' ? WEAPON_SHOT_KICK_BR : (weaponType === 'SR' ? WEAPON_SHOT_KICK_SR : WEAPON_SHOT_KICK_AR));
    return isSuppressed ? base * SUPPRESSOR_KICK_MUL : base;
  }

  // ---- Ragdoll Blast Spatial Pre-Culling & Impulse Scaling, and Aim Assist Cosine Rules (v155 Performance Optimization) ----
  const RAGDOLL_BLAST_BOUNDING_RADIUS = 2.4;

  function isRagdollInBlastRadius(pelvisX, pelvisY, pelvisZ, blastX, blastY, blastZ, blastRadius, maxExtent) {
    if (!_isNum(pelvisX) || !_isNum(pelvisZ) || !_isNum(blastX) || !_isNum(blastZ)) return false;
    const py = _isNum(pelvisY) ? pelvisY : 0, by = _isNum(blastY) ? blastY : 0;
    const maxR = (_isPos(blastRadius) ? blastRadius : 7.0) + (_isPos(maxExtent) ? maxExtent : RAGDOLL_BLAST_BOUNDING_RADIUS);
    const dx = pelvisX - blastX, dy = py - by, dz = pelvisZ - blastZ;
    return (dx * dx + dy * dy + dz * dz) <= (maxR * maxR);
  }

  function isRagdollParticleInBlast(dx, dy, dz, radiusSq) {
    if (!_isNum(dx) || !_isNum(dy) || !_isNum(dz)) return false;
    return (dx * dx + dy * dy + dz * dz) <= (_isPos(radiusSq) ? radiusSq : 49.0);
  }

  function ragdollBlastImpulse(dist, radius, force, dtSubstep) {
    if (!_isNum(dist) || dist < 0) return 0;
    const r = _isPos(radius) ? radius : 7.0;
    return dist > r ? 0 : (_isPos(force) ? force : 40.0) * (1 - dist / r) * (_isPos(dtSubstep) ? dtSubstep : 1 / 60) / (dist || 1);
  }
  function nearestRagdollParticle(P, hitX, hitY, hitZ) {
    if (!P || P.length < 45 || !_isNum(hitX) || !_isNum(hitY) || !_isNum(hitZ)) return 1;
    let hitIdx = 1, bestSq = Infinity;
    for (let i = 0; i < 15; i++) {
      const dx = P[i * 3] - hitX, dy = P[i * 3 + 1] - hitY, dz = P[i * 3 + 2] - hitZ, dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < bestSq) { bestSq = dSq; hitIdx = i; }
    }
    return hitIdx;
  }
  function isAimAssistHeadCandidateCos(headDot, bestCos, thresholdAngleCos, priorityMul) {
    if (!_isNum(headDot) || !_isNum(bestCos)) return false;
    const thCos = _isNum(thresholdAngleCos) ? thresholdAngleCos : 0.99, pri = _isPos(priorityMul) ? priorityMul : 0.85;
    return headDot >= thCos && (headDot >= bestCos * pri || headDot > bestCos);
  }

  // ---- Touch Control Activation Gating, Downed Key Sanitization, and Pointer-Events Rules (v156 Mobile UI Polish) ----
  function canTouchControlActivate(controlId, started, paused, isDead, isDowned, isEditing) {
    if (!started || isEditing || isDead) return false;
    if (controlId === 'tbtn-pause') return !paused;
    return !paused && (controlId === 'joy-base' || !touchControlLocked(controlId, false, isDowned));
  }
  function isActionKeyLockedWhileDowned(keyCode) {
    return keyCode === 'Space' || keyCode === 'KeyC' || keyCode === 'Mouse2' || keyCode === 'KeyG' || keyCode === '__use' || keyCode === '__melee' || keyCode === '__plate' || keyCode === '__tactical' || keyCode === '__streak' || keyCode === '__field';
  }
  function sanitizeDownedInputKeys(keys, pressed) {
    let cleared = 0;
    if (keys) { const kl = ['KeyC', 'Mouse2', 'KeyG', '__use']; for (let i = 0; i < kl.length; i++) if (keys[kl[i]]) { keys[kl[i]] = false; cleared++; } }
    if (pressed) { const pl = ['Space', '__melee', '__plate', '__tactical', '__streak', '__field']; for (let i = 0; i < pl.length; i++) if (pressed[pl[i]]) { delete pressed[pl[i]]; cleared++; } }
    return cleared;
  }

  // ---- Ballistic Casing Caliber Dimensions, Eject Kinematics & Tactical Slide Dust Puff Scaling (v157 Visual Polish) ----
  const CASING_CALIBER_SCALE_SMG = 0.75, CASING_CALIBER_SCALE_AR = 1.0, CASING_CALIBER_SCALE_BR = 1.25, CASING_CALIBER_SCALE_SR = 1.60;
  const CASING_EJECT_IMPULSE_SMG = 1.15, CASING_EJECT_IMPULSE_AR = 1.0, CASING_EJECT_IMPULSE_BR = 0.90, CASING_EJECT_IMPULSE_SR = 0.75;
  const SLIDE_DUST_COLOR0 = 0x8a8076, SLIDE_DUST_COLOR1 = 0x5a544e;
  function casingCaliberScale(weaponType) {
    return weaponType === 'SMG' ? CASING_CALIBER_SCALE_SMG : (weaponType === 'BR' ? CASING_CALIBER_SCALE_BR : (weaponType === 'SR' ? CASING_CALIBER_SCALE_SR : CASING_CALIBER_SCALE_AR));
  }
  function casingEjectImpulse(weaponType) {
    return weaponType === 'SMG' ? CASING_EJECT_IMPULSE_SMG : (weaponType === 'BR' ? CASING_EJECT_IMPULSE_BR : (weaponType === 'SR' ? CASING_EJECT_IMPULSE_SR : CASING_EJECT_IMPULSE_AR));
  }
  function slideDustVfxParams(actionType, speed) {
    const act = actionType || 'start', spd = _isNum(speed) ? Math.max(0, speed) : 0;
    const count = act === 'jump' ? 9 : (act === 'start' ? 7 : (act === 'cancel' ? 5 : (act === 'mantle' ? 6 : 4))), spread = act === 'jump' ? 1.35 : (act === 'start' ? 1.15 : (act === 'cancel' ? 0.90 : (act === 'mantle' ? 1.00 : 0.75))), scale = act === 'jump' ? 1.25 : (act === 'start' ? 1.05 : (act === 'cancel' ? 0.85 : (act === 'mantle' ? 0.95 : 0.75))), speedMul = spd > 0 ? Math.min(1.5, Math.max(0.6, spd / 6.0)) : 1.0;
    return { count: Math.round(count * speedMul), spread: spread * speedMul, scale: scale * (0.85 + speedMul * 0.15), color0: SLIDE_DUST_COLOR0, color1: SLIDE_DUST_COLOR1 };
  }

  // ---- Mobile Optical Look Sensitivity Scaling & Touch Action Availability Rules (v161 Mobile UI Polish) ----
  const TOUCH_ADS_SENSITIVITY_MUL = 0.65, TOUCH_SCOPED_SENSITIVITY_MUL = 0.40, TOUCH_STEADY_SENSITIVITY_MUL = 0.25;
  function touchLookSensitivity(baseSensitivity, isAds, isScoped, isSteady) {
    const base = _isPos(baseSensitivity) ? baseSensitivity : 1;
    return isSteady ? base * TOUCH_STEADY_SENSITIVITY_MUL : (isScoped ? base * TOUCH_SCOPED_SENSITIVITY_MUL : (isAds ? base * TOUCH_ADS_SENSITIVITY_MUL : base));
  }
  function isTouchActionAvailable(actionState) { return !isTouchControlEmpty(actionState); }

  // ---- Ballistic Tracer & Impact Flash Caliber Scaling (v162 Visual Polish) ----
  const TRACER_CALIBER_SCALE_SMG = 0.80, TRACER_CALIBER_SCALE_AR = 1.00, TRACER_CALIBER_SCALE_BR = 1.30, TRACER_CALIBER_SCALE_SR = 1.75;
  function tracerCaliberScale(weaponType) {
    const t = String(weaponType || '').toUpperCase();
    return t === 'SMG' ? TRACER_CALIBER_SCALE_SMG : (t === 'BR' ? TRACER_CALIBER_SCALE_BR : (t === 'SR' ? TRACER_CALIBER_SCALE_SR : TRACER_CALIBER_SCALE_AR));
  }
  const IMPACT_FLASH_SCALE_SMG = 0.75, IMPACT_FLASH_SCALE_AR = 1.00, IMPACT_FLASH_SCALE_BR = 1.25, IMPACT_FLASH_SCALE_SR = 1.60;
  function impactFlashCaliberScale(weaponType) {
    const t = String(weaponType || '').toUpperCase();
    return t === 'SMG' ? IMPACT_FLASH_SCALE_SMG : (t === 'BR' ? IMPACT_FLASH_SCALE_BR : (t === 'SR' ? IMPACT_FLASH_SCALE_SR : IMPACT_FLASH_SCALE_AR));
  }


  // ---- Live-grenade proximity warning ----
  // The fuse blink and the ground ring are both easy to miss: a frag that rolls in
  // behind you, or under a car, gives no warning at all. The HUD marker shows while
  // you are inside the blast plus a margin, so stepping clear is the cue to stop.
  // Only timed payloads warn: a claymore is a placed trap and thermite a fire, and
  // the player's own throw stays quiet until it lands, or it would flash every toss.
  const GRENADE_WARN_MARGIN = 1.3;
  const GRENADE_WARN_FLOOR = 0.2;

  function grenadeWarnUrgency(dist, radius, fuse, fullFuse, mode, ownInFlight) {
    if (mode !== 'timed' || ownInFlight) return 0;
    if (typeof dist !== 'number' || !isFinite(dist) || dist < 0) return 0;
    if (typeof radius !== 'number' || !isFinite(radius) || radius <= 0) return 0;
    if (typeof fuse !== 'number' || !isFinite(fuse) || fuse <= 0) return 0;
    const reach = radius * GRENADE_WARN_MARGIN;
    if (dist >= reach) return 0;
    const full = typeof fullFuse === 'number' && isFinite(fullFuse) && fullFuse > 0 ? fullFuse : fuse;
    const close = 1 - dist / reach;
    const late = 1 - Math.min(1, fuse / full);
    return Math.max(GRENADE_WARN_FLOOR, Math.min(1, Math.max(close, late)));
  }

  // ---- Suppression from near misses ----
  // A near miss already cracks past the player (bulletWhizSound), but nothing on
  // screen changed, so a crowd that keeps missing read as nobody shooting. Each
  // near miss stacks a little suppression; it holds briefly after the last one and
  // then bleeds off, so a sustained burst builds and a stray shot barely registers.
  const SUPPRESS_PER_MISS = 0.22;
  const SUPPRESS_HOLD = 0.6;
  const SUPPRESS_DECAY = 0.9;

  function suppressionAdd(level) {
    const l = typeof level === 'number' && isFinite(level) ? Math.max(0, level) : 0;
    return Math.min(1, l + SUPPRESS_PER_MISS);
  }

  function suppressionDecay(level, dt, sinceLastMiss) {
    if (typeof level !== 'number' || !isFinite(level) || level <= 0) return 0;
    if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) return Math.min(1, level);
    if (typeof sinceLastMiss === 'number' && sinceLastMiss < SUPPRESS_HOLD) return Math.min(1, level);
    return Math.max(0, Math.min(1, level) - SUPPRESS_DECAY * dt);
  }

  // ---- Wall occlusion for positional audio ----
  // Air absorption already dulls distant sounds, but a shot behind a wall sounded
  // exactly like one in the open, so hearing someone was no help in finding them.
  // A blocked source loses most of its top end and some level on top of that.
  const OCCLUDED_CUTOFF = 700;
  const OCCLUDED_GAIN = 0.55;

  function occludedCutoff(cutoff, blocked) {
    const c = typeof cutoff === 'number' && isFinite(cutoff) && cutoff > 0 ? cutoff : AIR_ABSORPTION_MAX_FREQ;
    return blocked ? Math.min(c, OCCLUDED_CUTOFF) : c;
  }

  function occludedGain(blocked) {
    return blocked ? OCCLUDED_GAIN : 1;
  }


  // ---- Weapon classes beyond the rifle family (M1) ----
  // New guns keep an existing `type` ('AR'/'SMG'), so the forty-odd type switches
  // above (falloff, bloom, sounds, casings, tracers...) give them sane rifle or
  // SMG behaviour, and add a `cls` that drives what is genuinely new about them.
  // Shotgun: a fixed pellet cone around the aim point. Hipfire bloom still widens
  // it a little, ADS tightens it, and magnetism is skipped per pellet.
  const PELLET_ADS_TIGHTEN = 0.75;
  const PELLET_BLOOM_SHARE = 0.5;
  const SHOTGUN_PUMP_DELAY_MS = 240;

  function pelletConeSpread(pelletSpread, baseSpread, ads) {
    const p = _isPos(pelletSpread) ? pelletSpread : 0;
    const b = _isPos(baseSpread) ? baseSpread : 0;
    return p * (ads ? PELLET_ADS_TIGHTEN : 1) + b * PELLET_BLOOM_SHARE;
  }

  // One shell into the tube. `done` once the tube is full or the reserve is dry.
  function loadShell(ammo, mag, reserve, out) {
    const o = out || { ammo: 0, reserve: 0, loaded: false, done: false };
    const a = _isNum(ammo) ? Math.max(0, ammo) : 0;
    const m = _isPos(mag) ? mag : 0;
    const r = _isNum(reserve) ? Math.max(0, reserve) : 0;
    o.loaded = a < m && r > 0;
    o.ammo = o.loaded ? a + 1 : a;
    o.reserve = o.loaded ? r - 1 : r;
    o.done = o.ammo >= m || o.reserve <= 0;
    return o;
  }

  // LMG: a barrel that heats with sustained fire. Heat widens the cone and the
  // kick (quadratically, so the first second of a burst is clean) and bleeds off
  // once the trigger has been off for a moment. Bursts beat a held trigger.
  const LMG_HEAT_HOLD = 0.35;
  const LMG_HEAT_DECAY = 0.5;
  const LMG_HEAT_SPREAD = 1.4;
  const LMG_HEAT_RECOIL = 0.7;

  function lmgHeatAfterShot(heat, perShot) {
    const h = _isNum(heat) ? Math.max(0, heat) : 0;
    return Math.min(1, h + (_isPos(perShot) ? perShot : 0));
  }
  function lmgHeatDecay(heat, dt, sinceShot) {
    if (!_isNum(heat) || heat <= 0) return 0;
    if (!_isPos(dt) || (_isNum(sinceShot) && sinceShot < LMG_HEAT_HOLD)) return Math.min(1, heat);
    return Math.max(0, Math.min(1, heat) - LMG_HEAT_DECAY * dt);
  }
  function lmgHeatSpreadMul(heat) {
    const h = _isNum(heat) ? _clamp01(heat) : 0;
    return 1 + LMG_HEAT_SPREAD * h * h;
  }
  function lmgHeatRecoilMul(heat) {
    const h = _isNum(heat) ? _clamp01(heat) : 0;
    return 1 + LMG_HEAT_RECOIL * h * h;
  }

  // Sidearm: the trigger on a completely dry gun (mag and reserve) draws the
  // pistol instead of clicking. A gun with reserve left still auto-reloads, and
  // the sidearm itself never swaps away from itself.
  // gunSwitchT head start: about half the raise
  const SIDEARM_QUICK_DRAW = 0.5;

  function shouldQuickDrawSidearm(ammo, reserve, curSlot, sidearmSlot, sidearmOwned) {
    if (!sidearmOwned || curSlot === sidearmSlot) return false;
    return _isNum(ammo) && _isNum(reserve) && ammo <= 0 && reserve <= 0;
  }

  // Breacher (enemy kind 6): charges and fires a shotgun only inside its range.
  // Each blast is BREACHER_PELLETS independent pellets whose hit chance falls with
  // distance, so it is deadly at a doorway and a nuisance at 10 m: the answer is
  // to keep it at range or kill it on the way in.
  const BREACHER_RANGE = 12;
  const BREACHER_ROF = 1.6;
  const BREACHER_PELLETS = 8;
  // of the rifleman's per-round damage
  const BREACHER_PELLET_SHARE = 0.6;

  function breacherPelletHitChance(dist) {
    const d = _isNum(dist) ? Math.max(0, dist) : BREACHER_RANGE;
    if (d >= BREACHER_RANGE) return 0;
    return Math.max(0.05, Math.min(0.9, 0.9 - (d - 3) * 0.08));
  }
  function canBreacherFire(dist, hasLos, isPlayerDead) {
    return !isPlayerDead && !!hasLos && _isNum(dist) && dist < BREACHER_RANGE;
  }
  // rolls: an array (or array-like) of BREACHER_PELLETS values in [0,1)
  function breacherPelletHits(dist, rolls) {
    const p = breacherPelletHitChance(dist);
    let n = 0;
    for (let i = 0; i < BREACHER_PELLETS; i++) if (rolls && _isNum(rolls[i]) && rolls[i] < p) n++;
    return n;
  }

  function weaponClassFireSound(cls, weaponType, isSuppressed) {
    if (cls === 'SG') return isSuppressed ? 'shot_suppressed' : 'shotgun';
    if (cls === 'LMG') return isSuppressed ? 'br_suppressed' : 'lmg';
    if (cls === 'PST') return isSuppressed ? 'smg_suppressed' : 'pistol';
    return weaponFireSound(weaponType, isSuppressed);
  }

  function isHostile(actorA, actorB) {
    if (!actorA || !actorB || actorA === actorB) return false;
    if (actorA.dead || actorB.dead) return false;
    const isPlayerA = !!(actorA.isPlayer || actorA.team === 'friendly' || (actorA.kind === undefined && actorB.kind !== undefined));
    const isPlayerB = !!(actorB.isPlayer || actorB.team === 'friendly' || (actorB.kind === undefined && actorA.kind !== undefined));
    const teamA = actorA.team || (isPlayerA ? 'friendly' : 'enemy');
    const teamB = actorB.team || (isPlayerB ? 'friendly' : 'enemy');
    return teamA !== teamB;
  }

  function pickNearestHostile(actor, candidates, maxRange) {
    if (!actor || !Array.isArray(candidates) || candidates.length === 0) return null;
    let best = null, bestDistSq = Infinity;
    const ax = (actor.pos && _isNum(actor.pos.x)) ? actor.pos.x : 0;
    const az = (actor.pos && _isNum(actor.pos.z)) ? actor.pos.z : 0;
    const maxDistSq = (_isNum(maxRange) && maxRange > 0) ? (maxRange * maxRange) : Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c || c === actor || c.dead) continue;
      if (!isHostile(actor, c)) continue;
      const cx = (c.pos && _isNum(c.pos.x)) ? c.pos.x : 0;
      const cz = (c.pos && _isNum(c.pos.z)) ? c.pos.z : 0;
      const dx = ax - cx, dz = az - cz;
      const dSq = dx * dx + dz * dz;
      if (dSq <= maxDistSq && dSq < bestDistSq) {
        bestDistSq = dSq;
        best = c;
      }
    }
    return best;
  }

  function modeScoreboardData(modeId, stats) {
    const s = stats || {};
    return {
      mode: modeId || 'survival',
      wave: _isNum(s.wave) ? s.wave : 0,
      score: _isNum(s.score) ? s.score : 0,
      kills: _isNum(s.kills) ? s.kills : 0,
      headshots: _isNum(s.headshots) ? s.headshots : 0,
      credits: _isNum(s.credits) ? s.credits : 0,
      friendlyScore: _isNum(s.friendlyScore) ? s.friendlyScore : 0,
      enemyScore: _isNum(s.enemyScore) ? s.enemyScore : 0,
      targetScore: _isNum(s.targetScore) ? s.targetScore : 25,
      timeLeft: _isNum(s.timeLeft) ? s.timeLeft : 0
    };
  }

  // Shared settlement rule for every match mode (TDM/FFA/Domination/Gun Game),
  // so nothing has to special-case one mode id. Survival keeps its own lifecycle
  // answer: only a finished run counts, and a downed player is not yet finished.
  const MATCH_MODE_IDS = ['tdm', 'ffa', 'domination', 'gun-game'];
  function isMatchModeId(modeId) {
    return MATCH_MODE_IDS.indexOf(modeId) >= 0;
  }

  function isModeOver(modeId, state) {
    const s = state || {};
    if (s.gameEnded) return true;
    if (isMatchModeId(modeId)) {
      const target = _isNum(s.targetScore) ? s.targetScore : 25;
      if ((_isNum(s.friendlyScore) && s.friendlyScore >= target) ||
          (_isNum(s.enemyScore) && s.enemyScore >= target)) return true;
      if (_isNum(s.timeLeft) && s.timeLeft <= 0) return true;
      return false;
    }
    if (modeId === 'survival' || !modeId) {
      return !!(s.playerDead && !s.playerDowned);
    }
    return false;
  }

  // ---- Domination rules -----------------------------------------------------
  // Three fixed arena flags, 5 s to capture, 4 m capture radius, and one point
  // per owned flag per second. Ownership, not continuous occupation, scores.
  const DOMINATION_FLAG_NAMES = ['A', 'B', 'C'];
  const DOMINATION_FLAG_POINTS = [[-18, 0], [0, 18], [18, 0]];
  const DOMINATION_CAPTURE_SECONDS = 5;
  const DOMINATION_FLAG_RADIUS = 4;
  const DOMINATION_POINTS_PER_FLAG_SEC = 1;
  const DOMINATION_DEFEND_RADIUS = 12;

  function flagCaptureStep(capture, dt, present, contested, seconds) {
    const c = _isNum(capture) ? capture : 0;
    const d = _isNum(dt) ? dt : 0;
    const limit = _isNum(seconds) ? seconds : DOMINATION_CAPTURE_SECONDS;
    // Millisecond quantisation keeps the result identical however the frame was
    // sliced: one 1 s step and twenty 0.05 s steps must agree exactly.
    const q = function (v) { return Math.round(v * 1000) / 1000; };
    // A contested flag pauses where it stands: neither side gains or loses ground.
    if (contested) return Math.min(limit, Math.max(0, c));
    // abandoned: the partial capture decays
    if (!present) return q(Math.max(0, c - d));
    return Math.min(limit, q(c + d));
  }

  // Whole points only, with the fractional remainder carried into the next frame,
  // so a 1 s tick and twenty 0.05 s ticks award exactly the same score.
  function flagScoreStep(acc, ownedCount, dt, perSecond) {
    const a = _isNum(acc) ? acc : 0;
    const n = _isNum(ownedCount) ? ownedCount : 0;
    const d = _isNum(dt) ? dt : 0;
    const per = _isNum(perSecond) ? perSecond : DOMINATION_POINTS_PER_FLAG_SEC;
    const total = a + n * per * d;
    const points = Math.floor(total);
    return { points: points, acc: total - points };
  }

  // ---- Gun Game rules -------------------------------------------------------
  // Explicit, visible 20-tier ladder: tiers 1-19 walk the arsenal in ascending
  // unlock order (starters first, marksman last), tier 20 is the Knife. The
  // ladder is data, so the UI, the loadout code and the tests read one truth.
  const GUN_GAME_KNIFE = -1;
  const GUN_GAME_TIER_COUNT = 20;
  // Ascending unlock rank (WEAPON_UNLOCK_RANK: 0,1,4 unlock first, then the
  // sidearm, then SCAR-H, M249, and the marksman rifle last), then the Knife.
  const GUN_GAME_LADDER = [
    0, 1, 4, 6, 2, 5, 3,
    0, 1, 4, 6, 2, 5, 3,
    3, 5, 2, 3, 5,
    GUN_GAME_KNIFE
  ];
  const GUN_GAME_BOT_DAMAGE_MIN = 0.6;
  const GUN_GAME_BOT_DAMAGE_MAX = 1.6;
  const GUN_GAME_KNIFE_DAMAGE_MUL = 1.6;
  const FREE_FOR_ALL_MAX_ACTORS = 8;

  function gunGameTierWeapon(tier) {
    const t = _isNum(tier) ? Math.floor(tier) : 0;
    if (t <= 0) return GUN_GAME_LADDER[0];
    if (t >= GUN_GAME_LADDER.length) return GUN_GAME_LADDER[GUN_GAME_LADDER.length - 1];
    return GUN_GAME_LADDER[t];
  }

  function gunGameIsKnifeTier(tier) {
    const t = _isNum(tier) ? Math.floor(tier) : -1;
    // Both the ladder index of the knife tier and the knife ladder value answer yes.
    if (t === GUN_GAME_KNIFE) return true;
    return gunGameTierWeapon(t) === GUN_GAME_KNIFE;
  }

  function gunGameAdvance(tier, delta) {
    const t = _isNum(tier) ? Math.floor(tier) : 0;
    const d = _isNum(delta) ? Math.floor(delta) : 0;
    return Math.max(0, Math.min(GUN_GAME_TIER_COUNT - 1, t + d));
  }

  // Credited kills only: a grenade, sentry, burn or environment kill carries no
  // weapon type and must never move a player up (or down) the ladder.
  function gunGameCreditedKill(damageType) {
    if (typeof damageType !== 'string' || !damageType) return false;
    return !/GRENADE|FRAG|EXPLOSION|SENTRY|FIRE|BURN|FALL|ENV/i.test(damageType);
  }

  function gunGameMeleeKill(damageType) {
    return typeof damageType === 'string' && damageType.toUpperCase() === 'MELEE';
  }

  // A bot's tier weapon decides how hard it hits: damage relative to the baseline
  // rifle, clamped so the ladder stays readable and never becomes a one-shot.
  function gunGameBotDamageMul(weaponDmg, baselineDmg) {
    if (!_isNum(weaponDmg) || weaponDmg <= 0) return 1;
    if (!_isNum(baselineDmg) || baselineDmg <= 0) return 1;
    const raw = weaponDmg / baselineDmg;
    return Math.min(GUN_GAME_BOT_DAMAGE_MAX, Math.max(GUN_GAME_BOT_DAMAGE_MIN, Math.round(raw * 100) / 100));
  }

  const RESPAWN_DELAY = 3.0;
  const SPAWN_PROTECTION_DURATION = 2.0;
  const FRIENDLY_IFF_COLOR = 0x38b6ff;
  const FRIENDLY_KIT_TINT = 0x3880c8;
  const MINIMAP_FRIENDLY_COLOR = '#4da6ff';

  function stepRespawnTimer(timer, dt) {
    const t = _isNum(timer) ? timer : 0;
    const d = _isNum(dt) ? dt : 0;
    return Math.max(0, t - d);
  }

  function canRespawn(timer) {
    return (_isNum(timer) ? timer : 0) <= 0;
  }

  function stepSpawnProtection(protectionT, dt) {
    const p = _isNum(protectionT) ? protectionT : 0;
    const d = _isNum(dt) ? dt : 0;
    return Math.max(0, p - d);
  }

  function isSpawnProtected(protectionT) {
    return (_isNum(protectionT) ? protectionT : 0) > 0;
  }

  // Friendly fire applies only when both actors are genuinely on the same identified team.
  // Unknown or team-less actors (no team property, not player) are never assumed friendly.
  function isFriendlyFire(attacker, target) {
    if (!attacker || !target || attacker === target) return false;
    const teamA = (typeof attacker.team === 'string' && attacker.team.length > 0)
      ? attacker.team
      : (attacker.isPlayer ? 'friendly' : null);
    const teamB = (typeof target.team === 'string' && target.team.length > 0)
      ? target.team
      : (target.isPlayer ? 'friendly' : null);
    if (!teamA || !teamB) return false;
    return teamA === teamB;
  }

  function teamKitColor(team) {
    return (team === 'friendly') ? FRIENDLY_KIT_TINT : null;
  }

  function teamIffColor(team) {
    return (team === 'friendly') ? FRIENDLY_IFF_COLOR : null;
  }

  function minimapActorColor(actor) {
    if (!actor) return '#ff4030';
    if (actor.team === 'friendly' || actor.isPlayer) return MINIMAP_FRIENDLY_COLOR;
    if (typeof MM_KIND_COLOR !== 'undefined' && actor.kind !== undefined && MM_KIND_COLOR[actor.kind]) {
      return MM_KIND_COLOR[actor.kind];
    }
    return '#ff4030';
  }

  function scoreSpawnPoint(point, hostiles, colliders, opts) {
    if (!point) return -Infinity;
    const px = Array.isArray(point) ? point[0] : (point.x || 0);
    const py = Array.isArray(point) ? (point.length >= 3 ? point[1] : 0) : (_isNum(point.y) ? point.y : 0);
    const pz = Array.isArray(point) ? (point.length >= 3 ? point[2] : point[1]) : (point.z || 0);
    const options = opts || {};
    const sweetSpot = _isNum(options.sweetSpot) ? options.sweetSpot : 25;
    const minSafeDist = _isNum(options.minSafeDist) ? options.minSafeDist : 10;
    const maxSafeDist = _isNum(options.maxSafeDist) ? options.maxSafeDist : 60;

    if (!Array.isArray(hostiles) || hostiles.length === 0) return 100;

    let minHostileDist = Infinity;
    let sightLinePenalty = 0;
    let activeHostiles = 0;

    for (let i = 0; i < hostiles.length; i++) {
      const h = hostiles[i];
      if (!h || h.dead) continue;
      activeHostiles++;
      const hx = (h.pos && _isNum(h.pos.x)) ? h.pos.x : 0;
      const hz = (h.pos && _isNum(h.pos.z)) ? h.pos.z : 0;
      const dx = px - hx, dz = pz - hz;
      const dist = Math.hypot(dx, dz) || 0.001;
      if (dist < minHostileDist) minHostileDist = dist;

      const hyaw = _isNum(h.yaw) ? h.yaw : 0;
      const dirX = Math.sin(hyaw), dirZ = Math.cos(hyaw);
      const toSpawnX = dx / dist, toSpawnZ = dz / dist;
      const dot = dirX * toSpawnX + dirZ * toSpawnZ;

      if (dot > 0.25 && dist < maxSafeDist) {
        let blocked = false;
        if (Array.isArray(colliders) && colliders.length > 0) {
          const hy = h.isPlayer
            ? ((h.pos && _isNum(h.pos.y)) ? h.pos.y : 1.6)
            : enemyEyeHeight((h.pos && _isNum(h.pos.y)) ? h.pos.y : 0, h.kind);
          const spawnEyeY = py + 1.5;
          blocked = segmentBlocked(hx, hy, hz, px, spawnEyeY, pz, colliders, 0.25);
        }
        if (!blocked) {
          const directness = Math.max(0, dot);
          const proxFactor = Math.max(0.1, 1 - (dist / maxSafeDist));
          sightLinePenalty += directness * proxFactor * 100;
        }
      }
    }

    if (activeHostiles === 0) return 100;

    let proxScore = 0;
    if (minHostileDist < minSafeDist) {
      proxScore = -200 * (1 - (minHostileDist / minSafeDist));
    } else {
      proxScore = 50 - Math.abs(minHostileDist - sweetSpot) * 1.5;
    }

    return proxScore - sightLinePenalty;
  }

  function pickBestSpawnPoint(spawnPoints, hostiles, colliders, opts) {
    if (!Array.isArray(spawnPoints) || spawnPoints.length === 0) return null;
    if (spawnPoints.length === 1) return spawnPoints[0];

    let bestPoint = spawnPoints[0];
    let bestScore = -Infinity;

    for (let i = 0; i < spawnPoints.length; i++) {
      const pt = spawnPoints[i];
      const score = scoreSpawnPoint(pt, hostiles, colliders, opts);
      if (score > bestScore) {
        bestScore = score;
        bestPoint = pt;
      }
    }

    return bestPoint;
  }

  // ---- Map Registry & Per-Map Data -------------------------------------------
  const _MAP_MATS = ['concrete', 'brick', 'metal', 'wood', 'concrete2'];
  function _bDef(x, y, z, w, h, d, m) {
    return {
      min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
      max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 },
      mat: typeof m === 'number' ? _MAP_MATS[m] : (m || 'concrete')
    };
  }

  function _unpackBoxes(arr) {
    const out = [];
    for (let i = 0; i < arr.length; i += 7) {
      out.push(_bDef(arr[i], arr[i + 1], arr[i + 2], arr[i + 3], arr[i + 4], arr[i + 5], arr[i + 6]));
    }
    return out;
  }

  function _addPerimeter(out) {
    out.push(_bDef(0, 3, -45, 94, 6, 1, 1), _bDef(0, 3, 45, 94, 6, 1, 1),
             _bDef(-45, 3, 0, 1, 6, 94, 1), _bDef(45, 3, 0, 1, 6, 94, 1));
  }

  function _addCenterPillars(out, zOff, m) {
    out.push(_bDef(0, 3.9, zOff, 18.6, 0.5, 14.6, m), _bDef(0, 6.65, zOff, 18, 0.5, 14, m),
             _bDef(-9, 4.55, zOff, 0.8, 0.9, 14, m), _bDef(9, 4.55, zOff, 0.8, 0.9, 14, m));
    [[-5.5, -7], [5.5, -7], [-5.5, 7], [5.5, 7]].forEach(p => out.push(_bDef(p[0], 1.7, p[1] + zOff, 7, 3.4, 0.8, m)));
    [[-9, -4.5], [-9, 4.5], [9, -4.5], [9, 4.5]].forEach(p => out.push(_bDef(p[0], 1.7, p[1] + zOff, 0.8, 3.4, 5, m)));
    [[-6, -4], [6, -4], [-6, 4], [6, 4]].forEach(p => out.push(_bDef(p[0], 1.7, p[1] + zOff, 1.2, 3.4, 1.2, m)));
    [[-5.4, -7], [5.4, -7], [-5.4, 7], [5.4, 7]].forEach(p => out.push(_bDef(p[0], 4.55, p[1] + zOff, 7.2, 0.9, 0.8, m)));
    for (let i = 0; i < 10; i++) {
      const top = (i + 1) * 0.4;
      out.push(_bDef(0, top / 2, zOff + 13.6 - i * 0.8, 3.2, top, 0.82, m),
               _bDef(0, top / 2, zOff - 13.6 + i * 0.8, 3.2, top, 0.82, m));
    }
  }

  function buildUrbanColliders() {
    const out = [];
    _addPerimeter(out);
    _addCenterPillars(out, 0, 4);
    _unpackBoxes([
      28, 2.5, -28, 16, 5, 12, 2, -28, 2, 28, 12, 4, 12, 2, 26, 3, 30, 10, 6, 10, 0,
      -28, 1.5, -28, 14, 3, 1, 1, -33.5, 1.5, -22, 1, 3, 13, 1, -24, 1.5, -30, 8, 3, 1, 1
    ]).forEach(b => out.push(b));
    return out;
  }

  function buildSnowyColliders() {
    const out = [];
    _addPerimeter(out);
    _addCenterPillars(out, -4, 0);
    _unpackBoxes([
      26, 3, -33, 16, 6, 1, 2, 34, 3, -26, 1, 6, 14, 2, 18, 3, -26, 1, 6, 14, 2,
      20, 3, -19, 4, 6, 1, 2, 32, 3, -19, 4, 6, 1, 2, 26, 6.2, -26, 17, 0.4, 15, 2, 26, 2.8, -31.5, 15, 0.3, 2, 2,
      -28, 4.1, -28, 6, 0.3, 6, 3, -28, 4.6, -30.8, 5.8, 0.8, 0.4, 3, -28, 4.6, -25.2, 5.8, 0.8, 0.4, 3,
      -30.8, 4.6, -28, 0.4, 0.8, 5.8, 3, -25.2, 4.6, -28, 0.4, 0.8, 5.8, 3,
      -25, 0.75, 32, 18, 1.5, 0.8, 0, -35, 0.75, 26, 0.8, 1.5, 12, 0,
      22, 0.6, 22, 8, 1.2, 0.8, 3, 30, 0.6, 28, 0.8, 1.2, 10, 3,
      22, 0.6, 34, 8, 1.2, 0.8, 3, 18, 0.6, 28, 0.8, 1.2, 10, 3, -12, 1.5, 12, 2, 3, 2, 2
    ]).forEach(b => out.push(b));
    [[-30, -30], [-26, -30], [-30, -26], [-26, -26]].forEach(p => out.push(_bDef(p[0], 2, p[1], 0.8, 4, 0.8, 3)));
    [[-31, 26], [-25, 26], [-19, 26]].forEach(p => out.push(_bDef(p[0], 2, p[1], 4, 4, 4, 2)));
    [[14, 10], [-14, -14], [14, -14], [-14, 14]].forEach(p => out.push(_bDef(p[0], 0.75, p[1], 2.4, 1.5, 2.4, 0)));
    return out;
  }

  function _ringSpawns(r) {
    const pts = [];
    for (let a = 0; a < 12; a++) {
      const ang = a * Math.PI / 6;
      pts.push([Math.round(Math.cos(ang) * r * 10) / 10, Math.round(Math.sin(ang) * r * 10) / 10]);
    }
    return pts;
  }
  const URBAN_SPAWN_POINTS = _ringSpawns(33);
  const SNOWY_SPAWN_POINTS = _ringSpawns(32);

  function _st(k, x, z, w, p, d) { return { kind: k, x: x, z: z, weapon: w !== undefined ? w : -1, perk: p || null, district: d || null }; }
  const URBAN_STATION_LAYOUT = [
    _st('wall', -37, 30, 1), _st('wall', 34, 30, 0), _st('wall', -30, -32, 2), _st('wall', 31, -37, 3),
    _st('wall', -40, -4, 4), _st('wall', 40, 4, 5), _st('armory', 0, -22), _st('plate', 0, 20),
    _st('perk', -21, 10, -1, 'jugg'), _st('perk', 21, 10, -1, 'reload'), _st('perk', -21, -10, -1, 'steady'),
    _st('perk', 21, -10, -1, 'scav'), _st('perk', 0, 34, -1, 'wind'), _st('lethal', -12, 20), _st('tactical', 12, 20),
    _st('door', 31, -11, -1, null, 'ne'), _st('door', -31, 11, -1, null, 'sw')
  ];
  const SNOWY_STATION_LAYOUT = [
    _st('wall', -38, 0, 1), _st('wall', 38, 0, 0), _st('wall', 0, -38, 2), _st('wall', -28, -20, 3),
    _st('wall', 14, -26, 4), _st('wall', 26, 16, 5), _st('armory', 0, -14), _st('plate', 0, 6),
    _st('perk', -16, 6, -1, 'jugg'), _st('perk', 16, 6, -1, 'reload'), _st('perk', -16, -14, -1, 'steady'),
    _st('perk', 16, -14, -1, 'scav'), _st('perk', 0, 20, -1, 'wind'), _st('lethal', -8, 6), _st('tactical', 8, 6),
    _st('door', 18, -27, -1, null, 'hangar'), _st('door', -26, 18, -1, null, 'depot')
  ];

  const URBAN_DOMINATION_FLAGS = [
    { name: 'A', x: -18, z: 0 },
    { name: 'B', x: 0, z: 18 },
    { name: 'C', x: 18, z: 0 }
  ];

  const SNOWY_DOMINATION_FLAGS = [
    { name: 'A', x: 0, z: -4 },
    { name: 'B', x: 26, z: -24 },
    { name: 'C', x: -20, z: 14 }
  ];

  const MAP_DEFS = {
    urban: {
      id: 'urban',
      name: 'Urban District',
      worldSize: 90,
      playerSpawn: { x: 0, y: 0.9, z: 0 },
      spawnPoints: URBAN_SPAWN_POINTS,
      stationLayout: URBAN_STATION_LAYOUT,
      dominationFlags: URBAN_DOMINATION_FLAGS,
      districts: DISTRICTS,
      colliders: buildUrbanColliders()
    },
    snowy: {
      id: 'snowy',
      name: 'Snowy Compound',
      worldSize: 90,
      playerSpawn: { x: 0, y: 0.9, z: -4 },
      spawnPoints: SNOWY_SPAWN_POINTS,
      stationLayout: SNOWY_STATION_LAYOUT,
      dominationFlags: SNOWY_DOMINATION_FLAGS,
      districts: [
        { key: 'hangar', name: 'VEHICLE HANGAR', price: 1500, minX: 18, maxX: 36, minZ: -36, maxZ: -18 },
        { key: 'depot', name: 'FUEL DEPOT', price: 750, minX: -36, maxX: -16, minZ: 18, maxZ: 36 }
      ],
      colliders: buildSnowyColliders()
    }
  };

  const MAP_IDS = ['urban', 'snowy'];
  const DEFAULT_MAP_ID = 'urban';

  function sanitizeMapId(id) {
    return (typeof id === 'string' && MAP_IDS.indexOf(id) >= 0) ? id : DEFAULT_MAP_ID;
  }

  function getMapDef(id) {
    const safe = sanitizeMapId(id);
    return MAP_DEFS[safe] || MAP_DEFS.urban;
  }

  return {
    horizDist, horizDistSq, subStepCount, ceilingClamp, shadowCasters, MAX_SUBSTEPS,
    advanceShotSchedule, fireClockStep, shotScheduleAfterInactive, distanceFalloff,
    waveEnemyCount, waveHpMultiplier, waveRangedAccuracy, WAVE_SCORE_PER_WAVE, waveClearScore,
    RESUPPLY_MAG_RATIO, waveResupplyAmmo, aabbOverlapsXZ, blocksWalker, isSpawnValid,
    SETTINGS_SCHEMA, defaultSettings, clampSetting, sanitizeSettings,
    qualityRenderSettings, graphicsSettings, createFrameTimeTelemetry, createRuntimeTelemetry,
    stepGrenadeMotion, lookSensitivity, combatIntensity, BASE_SENSITIVITY, defaultStats,
    sanitizeStats, resumeCheckpointState, settlementAccounting, mergeRunIntoStats,
    DIFFICULTIES, difficulty, BEHAVIOUR_UNLOCKS, behavioursAtWave, newBehavioursAtWave,
    pickEnemyKind, enemyStopDistance, enemyMoveSpeed, flankBias, flankWindow, flankBiasNow,
    FLANK_WINDOW, enemyPreferredRange, ENEMY_KIND_UNLOCK, enemyKindsAtWave, newEnemyKindsAtWave,
    endlessHpMultiplier, endlessEnemyCount, SAVE_VERSION, ammoDropChance, MED_DROP_BASE,
    MED_DROP_CRITICAL, medDropChance,
    pickupDropKind, makeCheckpoint, validateCheckpoint, regionKey, planStaticBatches,
    segmentHitsBox, segmentBlocked, buildRayGrid, rayGridClear, rayGridInsert,
    rayGridQuery, buildNavGrid, computeFlowField, worldToCell, cellCenter,
    isWalkable, nearestWalkable, navDistanceAt, flowDirAt, updateStuck,
    updateProgress, isClosingDistance,
    RECOIL_PATTERNS, RECOIL_JITTER, RECOIL_RESET, recoilPatternFor, recoilAt,
    recoilShotIndex, absorbRecoil, BLOOM_PER_SHOT, BLOOM_CAP_HIP, BLOOM_CAP_ADS,
    BLOOM_RECOVER, bloomParams, bloomAfterShot, bloomDecay, effectiveSpread,
    PENETRATION_COST, MAX_PENETRATIONS, penetrationCost, penetrationPower,
    penetrate, penetrationDamageMul, meleeTarget, MELEE_REACH, MELEE_CONE,
    MELEE_DAMAGE, MELEE_COOLDOWN, mantleTarget, CREDITS, creditsForDamage,
    creditsForWave, POWERUPS, POWERUP_CHANCE, powerUpDropped, pickPowerUp,
    rayBoxEntry, sweepGrenade, penetrationWalk, penetrationMulAt, BUY_RADIUS,
    BUY_HOLD, nearestStation,
    WALL_BUY_PRICE, wallBuyPrice, ammoRefillPrice, wallBuyOffer,
    ARMORY_WAVE, ARMORY_PRICE, armoryAvailable, armoryUpgrade,
    PERK_SLOTS, PERKS, perkByKey, perkBuyBlocker, hasPerk, perkMaxHealth,
    HEALTH_LOW_THRESHOLD, isHealthLow, ARMOR_LOW_RATIO, isArmorLow, isArmorEmpty,
    AMMO_LOW_RATIO, isAmmoLow, isAmmoEmpty, reloadPrompt, perkReloadMul,
    perkBloomMul, perkAdsMul, perkPickupMul, PLATE_MAX, PLATE_PRICE, PLATE_TIME,
    plateApply, platesAffordable, DOWN_TIME, DOWN_REVIVE_HEALTH, DOWN_SPEED_MUL,
    lethalOutcome, bleedOutRemaining, LETHALS, TACTICALS, equipmentByKey,
    flashStrength, flashDuration, segmentHitsSphere, smokeBlocks,
    STREAKS, streakByKey, streaksEarnedAt, nextStreak, FIELD_UPGRADE,
    fieldChargeAfter, fieldReady, coneHit, SPECIAL_WAVES, SPECIAL_EVERY,
    specialWaveAt, specialKind, ELITE_FROM_WAVE, ELITE, eliteChance, rollElite,
    DISTRICTS, districtByKey, insideDistrict, spawnPointSealed, usableSpawnPoints,
    WAVE_QUEUE_CAP, waveQueueSize, RAGDOLL_NODES, RAGDOLL_LINKS, RAGDOLL_ITERATIONS,
    makeRagdoll, ragdollStep, ragdollImpulse, ragdollCollide, ragdollEnergy, dist3,
    FALL_SAFE_SPEED, FALL_LETHAL_SPEED, fallDamage, landingImpactSpeed,
    landingSpeedMul, MAX_RANK, xpForRank, rankForXp, rankProgress, XP_PER, runXp,
    WEAPON_UNLOCK_RANK, weaponUnlockRank, weaponUnlocked, CHALLENGES, challengeProgress,
    challengesDone, ATTACH_SLOTS, ATTACH_SLOT_NAME, ATTACHMENTS, attachmentByKey,
    attachmentsForSlot, attachmentUnlocked, sanitizeLoadout, applyAttachments,
    attachmentDelta, OBJECTIVE_EVERY, OBJECTIVE_HOLD, OBJECTIVE_RADIUS, OBJECTIVE_CREDITS,
    objectiveWaveAt, objectiveProgress, objectiveComplete, pickObjectiveSpot,
    REACH_MAX_VERT, withinReach, UNREACHABLE, SOUND_VARIED_RANGE, soundPlaybackRate,
    SPATIAL_AUDIO_MAX_DIST, SPATIAL_AUDIO_PAN_BOOST, SPATIAL_AUDIO_MIN_VOL,
    spatialAudioPan, spatialAudioVolume, spatialAudioParams, JOYSTICK_SPRINT_FORWARD,
    JOYSTICK_SPRINT_MAGNITUDE, isAutoSprint, JOYSTICK_RADIUS, JOYSTICK_DEADZONE,
    joystickInput, resolveAabbXZ, ARMOR_ABSORB_RATIO, resolveArmorDamage,
    enemyMeleeDamage, enemyRangedDamage, resolveVerticalBounds, findFloorY,
    hasCrouchHeadroom, SPATIAL_EXPLOSION_MAX_DIST, spatialExplosionParams,
    tacticalDetonationSound, grenadeContactSound, JOYSTICK_MOVE_THRESHOLD,
    touchMovementKeys,
    gyroLookDelta, gyroScreenLookDelta, touchReloadState, ENEMY_HEALTH_SCALE,
    SHIELD_ARC_COS, SHIELD_ABSORB_RATIO, enemyBaseHealth, enemyMaxHealth,
    enemyAccuracy, playerBulletDamage, shieldMultiplier, HITMARK_COLOR,
    hitmarkerTier, hitmarkerParams, ENEMY_SEPARATION_RADIUS, enemySeparationRadius,
    resolveSeparationPush, MELEE_CAP_WINDOW, MELEE_CAP_MAX_HITS, pruneHitTimestamps,
    canRegisterHit, snapToTexel, weaponFireSound, armorDamageSound,
    touchPlateState, touchEquipmentState, touchStreakState, touchSwapState,
    touchSwapLabel, buyPromptPrefix, touchUseState, touchSlideState,
    touchSlideLabel, touchPlateLabel, touchTacticalLabel, touchLethalLabel,
    touchStreakLabel, touchMeleeState, touchMeleeLabel,
    GRENADE_DAMAGE_FLOOR, GRENADE_SELF_DAMAGE_MAX, GRENADE_SELF_RADIUS_RATIO,
    GRENADE_MIN_SPEED, GRENADE_MAX_SPEED, GRENADE_RAMP_DURATION, GRENADE_TAP_THRESHOLD,
    grenadeBlastDamage, grenadeSelfDamage, grenadeChargedSpeed, grenadeThrowSpeed,
    canEnemyMelee, enemyMeleeReach, enemyAttackCooldown,
    VIGNETTE_MAX_ALPHA, VIGNETTE_BASE_ALPHA, VIGNETTE_SCALE_DIVISOR,
    HIT_ARC_LIFE, HIT_ARC_FADE_START, HIT_ARC_MAX_OPACITY,
    damageVignetteAlpha, damageVignetteStyle, worldBearing, screenHitAngle,
    hitArcOpacity, stepParticlePhysics, ammoHudChanged, syncAmmoHudState,
    healthHudChanged, syncHealthHudState, killConfirmationSound,
    MK_WINDOW, MK_MAX_STREAK, advanceKillStreak, multikillLabel, multikillSound,
    SLIDE_DURATION, SLIDE_START_MUL, SLIDE_END_MUL, SLIDE_BOOST_MAX,
    SLIDE_BOOST_SCALE, SLIDE_JUMP_Y_MUL, slideSpeedAt, slideJumpBoost,
    STAMINA_RECOVER_RATE, STAMINA_EXHAUST_RECOVER_RATIO, stepPlayerStamina,
    isPlayerExhausted, canRegenHealth, stepHealthRegen,
    AMMO_PICKUP_MAG_RATIO, MEDKIT_HEAL_BASE, MEDKIT_ARMOR_BASE,
    ammoPickupRestore, medkitPickupRestore,
    HEALTH_CRITICAL_RATIO, CRITICAL_VIGNETTE_BASE_BLUR, CRITICAL_VIGNETTE_MAX_BLUR,
    CRITICAL_VIGNETTE_BASE_SPREAD, CRITICAL_VIGNETTE_MAX_SPREAD,
    isHealthCritical, criticalHealthIntensity, healthDangerState,
    criticalVignetteStyle, criticalPulseAlpha,
    filterMinimapColliders, isMinimapBlockVisible, compassHeading,
    compassTickOffset, compassCardinalLabel, evaluateCombatEnemies,
    SENTRY_AUDIO_MAX_DIST, streakActivationSound, fieldUpgradeSound, sentryFireSound,
    canMunitionsResupply,
    STEADY_MAX, STEADY_RECOVER, ADS_SCOPE_THRESHOLD, SCOPE_LOCKED_THRESHOLD, RECOIL_DECAY_RATE,
    isSteadyActive, stepSteadyAim, swayAmplitude, swayOffsets, isScoped, recoilDecay, aimAssistAngle, aimAssistPull,
    CROSSHAIR_MIN_GAP_OFFSET, CROSSHAIR_MAX_GAP_OFFSET, crosshairGapOffset, crosshairOpacity,
    sprintIndicatorState, sprintIndicatorLabel,
    touchAdsState, touchAdsLabel, touchAdsChanged, syncTouchAdsState,
    touchJumpState, touchJumpLabel, touchJumpChanged, syncTouchJumpState,
    touchSlideChanged, syncTouchSlideState, touchMeleeChanged, syncTouchMeleeState,
    isMobileSteadyAim, touchFireState, touchFireLabel, touchReloadLabel,
    TOUCH_BUTTON_DEFAULT_SIZE, TOUCH_FIRE_DEFAULT_SIZE, TOUCH_PAUSE_DEFAULT_SIZE, touchControlName,
    touchEditorControlLabel, touchLayoutClampPercent, touchFireChanged, syncTouchFireState, touchReloadChanged,
    syncTouchReloadState, touchPlateChanged, syncTouchPlateState, touchEquipmentChanged, syncTouchEquipmentState,
    touchStreakChanged, syncTouchStreakState, touchSwapChanged, syncTouchSwapState, touchSwapNextSlot,
    FOOTSTEP_BASE_CADENCE, FOOTSTEP_SPRINT_CADENCE, FOOTSTEP_TAC_SPRINT_CADENCE, FOOTSTEP_CROUCH_CADENCE,
    FOOTSTEP_MIN_SPEED, mantleSound, slideStartSound, footstepCadence, playerFootstepSound, shouldPlayFootstep,
    SNIPER_ADS_ZOOM, DEFAULT_ADS_ZOOM, SLIDE_FOV_BOOST, TAC_SPRINT_FOV_BOOST, CAMERA_MIN_FOV, CAMERA_MAX_FOV,
    CAMERA_BOB_X_SCALE, CAMERA_BOB_Y_SCALE, CAMERA_SLIDE_DIP, CAMERA_BOB_ROLL_SCALE, CAMERA_SLIDE_ROLL, CAMERA_STRAFE_ROLL_SCALE,
    weaponAdsZoom, mobilityFovBoost, targetCameraFov, strafeDirection, cameraRoll, cameraPositionOffsets,
    TAC_SPRINT_SPEED_MUL, LAND_STUN_SPEED_MUL, ADS_MOVE_SPEED_MUL, AIR_SLIDE_ACCEL_RATE, AIR_MOVE_ACCEL_RATE,
    GROUND_DECEL_DEFAULT, VELOCITY_SNAP_THRESHOLD, BOB_SPEED_THRESHOLD, BOB_FREQ_SPRINT, BOB_FREQ_WALK, BOB_SPEED_SCALE,
    BOB_GROW_RATE, BOB_DECAY_RATE, LAND_STUN_BASE_TIME, LAND_STUN_SCALE, COYOTE_TIME, JUMP_BUFFER_TIME, ADS_BASE_SPEED,
    GUN_SWITCH_SPEED, SNIPER_UNSCOPE_FACTOR, SHOT_KICK_IMPULSE, SHOT_KICK_MAX, SHOT_KICK_DECAY_BASE,
    playerMoveSpeed, movementAccelRate, stepHorizontalVelocity, stepHeadBob, landingStunDuration,
    stepJumpTimers, canInitiateJump, stepAdsTransition, stepGunSwitch, applyShotKick, decayShotKick,
    sniperUnscopeAds, SLIDE_VIGNETTE_RATE, SLIDE_VIGNETTE_MAX_ALPHA, stepSlideVignette, slideVignetteStyle,
    objectiveLabel, objectiveHudChanged, syncObjectiveHudState, isScopeOverlayActive, scopeOverlayChanged,
    syncScopeOverlayState, isSteadyIndicatorVisible, steadyIndicatorLabel, steadyIndicatorChanged,
    syncSteadyIndicatorState, MUSIC_RISE_RATE, MUSIC_FALL_RATE, MUSIC_BASE_BUS_GAIN, MUSIC_INTENSITY_BUS_SCALE,
    MUSIC_BPM, MUSIC_STEPS_PER_BAR, MUSIC_BARS_PER_CHORD, MUSIC_PHRASE_BARS, MUSIC_CHART,
    stepMusicIntensity, musicBusGain, musicStepSeconds, midiToHz, musicChordAt, musicChordChanges,
    musicLayerGains, musicDrumHits, musicBassNote, musicArpNote, stationPurchaseSound,
    playerDownSound, playerReviveSound, touchUseLabel, touchUseChanged, syncTouchUseState,
    VIEWMODEL_HIP_X, VIEWMODEL_HIP_Y, VIEWMODEL_HIP_Z, VIEWMODEL_ADS_X, VIEWMODEL_ADS_Y, VIEWMODEL_ADS_Z,
    VIEWMODEL_BOB_SCALE, VIEWMODEL_KICK_Z_SCALE, VIEWMODEL_KICK_Y_SCALE, VIEWMODEL_BOLT_REST_Z,
    VIEWMODEL_BOLT_KICK_SCALE, VIEWMODEL_BOLT_KICK_MAX, VIEWMODEL_MAG_REST_Y, VIEWMODEL_MAG_DROP_SCALE,
    VIEWMODEL_MAG_INSERT_SCALE, VIEWMODEL_RELOAD_DIP, VIEWMODEL_RELOAD_ROT, VIEWMODEL_SWITCH_RAISE_DISTANCE,
    VIEWMODEL_MUZZLE_FLASH_DECAY, VIEWMODEL_MUZZLE_LIGHT_BASE_INTENSITY, VIEWMODEL_MUZZLE_LIGHT_DECAY_RATE,
    IMPACT_VFX_LIFETIME, IMPACT_VFX_EXPANSION_RATE, VIEWMODEL_STANCE_OFFSETS, viewmodelStance,
    viewmodelStanceOffsets, reloadAnimationOffsets, viewmodelBoltOffset, viewmodelPose, stepMuzzleFlash,
    stepMuzzleLight, impactVfxScale, PFX_DEFAULT_MAX, SCOPE_PARALLAX_MAX, SCOPE_PARALLAX_SCALE,
    SCOPE_RANGE_MAX, SCOPE_RANGE_INTERVAL, POST_KICK_DECAY_RATE, pfxNeedsUpload, scopeParallaxOffset,
    scopeParallaxChanged, rangefinderLabel, isHostileTarget, stepRangefinderTimer, stepSpring, vmSmooth,
    vmBump, wrapAngle, stepPostKick, postFringe, isPostfxWanted, CAN_RELOAD_MIN_DURATION, MUNITIONS_MAG_RATIO,
    SENTRY_RANGE, SENTRY_ROF, SENTRY_DMG, SENTRY_DEPLOY_OFFSET, MUNITIONS_DEPLOY_OFFSET, AIRSTRIKE_LEAD_DIST,
    AIRSTRIKE_BOMB_COUNT, AIRSTRIKE_SPACING, AIRSTRIKE_BASE_DELAY, AIRSTRIKE_STEP_DELAY, AIRSTRIKE_JITTER,
    ENEMY_GRENADE_MIN_SPEED, ENEMY_GRENADE_MAX_SPEED, ENEMY_GRENADE_SPEED_DIST_SCALE, ENEMY_GRENADE_ARC_Y,
    ENEMY_GRENADE_FUSE_BONUS, ENEMY_GRENADE_JITTER, PICKUP_LIFE, PICKUP_BLINK_START, PICKUP_COLLECT_RADIUS,
    PICKUP_POWER_ROT_SPEED, PICKUP_STANDARD_ROT_SPEED, FLASH_OVERLAY_MAX_ALPHA, FLASH_OVERLAY_DURATION_SCALE,
    canReload, effectiveReloadDuration, isReloadComplete, completeReload, munitionsAmmoRestore, airstrikeDelay,
    airstrikeBombCoord, enemyGrenadeSpeed, enemyGrenadeFuse, enemyGrenadeCooldown, enemyBurstInterval,
    pickupBobHeight, isPickupVisible, pickupBlinkOpacity, canCollectPickup, grenadeBlinkVisible,
    flashOverlayOpacity, smokeCloudScale, smokeCloudOpacity, burnPatchOpacity, powerupSound,
    equipmentDeploySound, steadyAimBreathEvent, exhaustionSound, slideCancelSound, CASING_MAX,
    CASING_LIFETIME, CASING_FADE_DURATION,
    CASING_FLOOR_Y, CASING_GRAVITY, CASING_BOUNCE, CASING_FRICTION, CASING_SPIN_DAMP,
    CASING_REST_SPEED, CASING_SND_GAP, VIEWMODEL_MANTLE_IN_RATE, VIEWMODEL_MANTLE_OUT_RATE,
    casingScale, casingEjectVelocity, stepCasingPhysics, casingRestRotation,
    stepMeleeKnifePose, meleeGunDodgeOffsets, stepViewmodelMantle, viewmodelMantleOffsets,
    reloadHandOffsets, viewmodelLateralSpeed, stepViewmodelTilt, viewmodelLookInertiaTarget,
    BUY_PROMPT_DEFAULT_COLOR, BUY_PROMPT_DIM_COLOR, buyPromptLabel, buyPromptFillPct,
    buyPromptColor, buyPromptChanged, syncBuyPromptState, COMPASS_YAW_THRESHOLD,
    compassNeedsRedraw, minimapScale, minimapDetectRadiusSq, minimapBlipOffset,
    isMinimapBlipVisible, minimapEnemyRadius, compassTickAngle, compassSnapAngle,
    compassTickVisible, compassTickStyle, RAGDOLL_SINK_DELAY, RAGDOLL_SINK_RATE,
    RAGDOLL_SINK_MAX, RAGDOLL_DROP_SCALE, isRagdollSinkReady, stepRagdollSink,
    ragdollDropOffsetY, isRagdollExpired, ENEMY_PROC_WALK_THRESHOLD, ENEMY_PROC_BASE_FREQ,
    enemyProcWalkSpeed,
    stepEnemyProcWalkPhase, enemyProcLimbSwing, enemyProcPitchTrack, enemyProcPose,
    WAVE_SPAWN_PRESSURE_QUEUE, WAVE_SPAWN_SWEET_SPOT, WAVE_SPAWN_JITTER,
    AMMO_RELIEF_DRY_THRESHOLD, AMMO_RELIEF_COOLDOWN,
    ENEMY_BULLET_DELAY_FACTOR, ENEMY_BULLET_MAX_DELAY_MS,
    ENEMY_MELEE_WINDUP_BASE, ENEMY_MELEE_WINDUP_RANGE, ENEMY_MELEE_FOLLOW_REACH_PADDING,
    ENEMY_STUN_SPEED_MUL, ENEMY_BLIND_YAW_RATE, ENEMY_FALL_SPEED,
    SLIDE_CANCEL_MIN_T, SLIDE_TIMEOUT_T, SLIDE_STOP_MIN_T, STATION_HOLD_DECAY_RATE,
    waveSpawnPressure, waveSpawnBurstCount, waveSpawnDelay, spawnCandidateScore,
    stepAmmoReliefTimer, isAmmoReliefNeeded, enemyBulletTravelDelay, enemyRangedNextShot,
    enemyMeleeWindup, enemyAttackReadyTime, enemyKillImpulse, enemyStunSpeedMultiplier,
    stepEnemyBlindYaw, stepEnemyFallY, canSlideCancel, isSlideExpired, stepStationHold,
    weaponFireInterval, SPATIAL_IMPACT_MAX_DIST, SNIPER_BOLT_DELAY_MS,
    surfaceImpactSound, sniperBoltSound, streakReadySound, fieldUpgradeReadySound,
    secondWindSound, objectiveCompleteSound, weaponDrawSound,
    DECAL_MAX, DECAL_LIFETIME, DECAL_FADE_DURATION, DECAL_BASE_RADIUS,
    DECAL_STANDOFF, MUZZLE_FLASH_SUPPRESSED_SCALE, TRACER_LIFETIME,
    decalCaliberScale, decalSurfaceMultiplier, decalScale, decalRotationAngle, stepDecalLife, isDecalExpired,
    muzzleFlashRotation, muzzleFlashBaseScale, stepMuzzleFlashScale, tracerThicknessScale, tracerColor,
    isColliderRelevantXZ, movementTargetVelocity, HUD_REDRAW_INTERVAL, HUD_FLICK_YAW_THRESHOLD, HUD_FLICK_COOLDOWN,
    shouldRedrawHudCanvas, countAliveEnemies, hostilesRemainingLabel, gunCameraFov, viewmodelNarrowOffset,
    STEP_HEIGHT, SLIDE_STEER_RATE, TAC_TAP_WINDOW, TAC_DURATION, GRENADE_BOUNCE_LAT_DAMP, GRENADE_ROLL_LAT_DAMP,
    enemyScale, enemyColliderRadius, enemyHeadHeight, enemySpawnSpeedMultiplier, isEnemyFlanker,
    enemyFallbackVelocity, enemyStrafeVelocity, enemyStrafeDuration, canEnemyThrowGrenade, enemyFootstepRate,
    enemyFootstepInterval, relocateFacingAlignment, relocateCandidateScore, stepSlideSteering, isTacSprintTriggered,
    stepGrenadeBounceVelocity, isGrenadeAtRest, downBleedoutLabel, multikillBonus, waveCountdownLabel, waveBannerLabels,
    SENTRY_AIM_Y_OFFSET, BURN_TICK_INTERVAL, stepTracerLife, isTracerExpired, stepImpactLife, isImpactExpired,
    sentryTargetYaw, stepSentryTimers, sentryAimTargetY, burnTickDamage, isPointInBurnRadius,
    SPREAD_LONGITUDINAL_SCALE, AIM_ASSIST_HEAD_THRESHOLD, AIM_ASSIST_HEAD_PRIORITY, AIM_ASSIST_PULL_WEIGHT,
    AIM_ASSIST_TRACK_RATE, AIM_ASSIST_CHEST_OFFSET, AIM_ASSIST_HEAD_OFFSET, BULLET_MAGNET_Y_OFFSET,
    ENEMY_SPAWN_DURATION, ENEMY_STRAFE_MAX_T, GRENADIER_STRAFE_RANGE, GRENADIER_STRAFE_DURATION,
    RIFLEMAN_STRAFE_DURATION, RIFLEMAN_LOS_RETRY_DELAY, FLANK_STEER_WEIGHT, ENEMY_OVERLAP_MIN_DIST,
    ENEMY_SHOT_CHEST_Y_OFFSET, MANTLE_DURATION, MANTLE_COYOTE_GRACE, GRENADE_PITCH_LOFT, GRENADE_COOLDOWN,
    TACTICAL_SPEED_MUL, PLAYER_FLASH_SELF_MUL, ballisticSpreadVector, bulletPenetrationPower,
    isAimAssistHeadCandidate, aimAssistAngularDeltas, stepAimAssistLook, enemyAiNextState, stepFlankVelocity,
    playerPushoutOffset, enemyAimTargetY, stepMantleProgress, grenadeThrowVelocity, playerSelfFlashDuration,
    GRENADE_RING_BASE_OPACITY, GRENADE_RING_MAX_OPACITY, MINIMAP_SENTRY_COLOR, MINIMAP_MUNITIONS_COLOR,
    MINIMAP_PICKUP_AMMO_COLOR, MINIMAP_PICKUP_MED_COLOR, MINIMAP_PICKUP_POWER_COLOR, MINIMAP_SENTRY_RADIUS,
    MINIMAP_MUNITIONS_SIZE, MINIMAP_PICKUP_BASE_RADIUS, BURN_PATCH_HEAT_FLICKER_FREQ, grenadeDangerRingOpacity,
    burnPatchPulsingOpacity, burnPatchFlameStrength, minimapPickupColor, pickupMinimapPulse, sentryMinimapPointer,
    BULLET_WHIZ_MAX_DIST, BULLET_WHIZ_MIN_OFFSET, LOW_AMMO_THRESHOLD_AR, LOW_AMMO_THRESHOLD_SMG,
    LOW_AMMO_THRESHOLD_BR, LOW_AMMO_THRESHOLD_SR, bulletWhizSound, isBulletNearMiss, bulletNearMissOffset,
    bulletWhizVolume, lowAmmoThreshold, isLowAmmo, lowAmmoSound, reloadBoltSound, isEmptyReload,
    STANCE_RECOIL_CROUCH, STANCE_RECOIL_SLIDE, STANCE_RECOIL_AIRBORNE, ENEMY_GRENADE_ARM_DURATION,
    ENEMY_LIVE_GRENADES_CAP, GRENADIER_INITIAL_NADE_DELAY, RIFLEMAN_INITIAL_NADE_DELAY, ENEMY_EYE_OFFSET_Y,
    ENEMY_LOS_JITTER, ENEMY_MELEE_COOLDOWN_SENTINEL, ENEMY_MELEE_RESET_MARGIN, stanceRecoilMultiplier,
    effectiveRecoilKick, enemyInitialGrenadeDelay, canSpawnEnemyGrenade, enemyGrenadeVelocity, enemyEyeHeight,
    enemyLosTargetCoord, isEnemyMeleeReset, shouldUpdatePfxLayer, isGrenadeLosBlocker, enemyToPlayerDir,
    totalPlayerRounds, hasPlayerRounds,
    SCORCH_MAX, SCORCH_LIFETIME, SCORCH_FADE_DURATION, SCORCH_BASE_RADIUS, SCORCH_BASE_OPACITY, SCORCH_STANDOFF, SCORCH_EXPANSION_DURATION,
    ENEMY_MUZZLE_LIGHT_COLOR, ENEMY_MUZZLE_LIGHT_INTENSITY, ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY, ENEMY_MUZZLE_LIGHT_DIST, ENEMY_MUZZLE_LIGHT_DUR,
    scorchScale, scorchScaleProgress, scorchOpacity, stepScorchLife, isScorchExpired, scorchRotation, scorchElevation, enemyMuzzleLightParams,
    AIR_ABSORPTION_MAX_FREQ, AIR_ABSORPTION_MIN_FREQ, AIR_ABSORPTION_Q, spatialAudioCutoff,
    HEARTBEAT_BPM_MIN, HEARTBEAT_BPM_MAX, heartbeatBpm, heartbeatInterval, stepHeartbeatTimer,
    shouldPlayHeartbeat, heartbeatSound, enemyGunfireSound,
    STANCE_SPREAD_CROUCH, STANCE_SPREAD_SLIDE, STANCE_SPREAD_AIRBORNE_PENALTY, stanceSpreadMultiplier,
    EXPLOSION_KICK_MAX_DIST, EXPLOSION_POST_KICK_MAX, EXPLOSION_SHOT_KICK_MAX, EXPLOSION_SHOT_KICK_CAP,
    HEADSHOT_MUL_SR, HEADSHOT_MUL_BR, HEADSHOT_MUL_AR, HEADSHOT_MUL_SMG,
    ENEMY_ACCURACY_FALLOFF_DIST, ENEMY_ACCURACY_MIN_FACTOR,
    explosionKickIntensity, explosionPostKick, explosionShotKick, applyExplosionShotKick,
    weaponHeadshotMultiplier, enemyDistanceAccuracy, FLASH_LIGHT_DECAY_EXPONENT, SENTRY_TARGET_ACQUIRE_EPSILON,
    stepFlashLightLife, flashLightIntensity, particlePerspectiveScale, isSentryTargetInRange,
    buildShadowCasterMask, planarFacingDirection, shouldUpdatePickupOpacity,
    TOUCH_MIN_CONTROL_SIZE, TOUCH_MAX_CONTROL_SIZE, TOUCH_DEFAULT_CONTROL_SIZE, TOUCH_MAX_LOOK_DELTA,
    clampTouchControlSize, clampTouchLayoutCoord, sanitizeTouchLayoutPosition, sanitizeTouchLayout, isTouchGameplayEnabled,
    canTouchPause, touchLookDelta, isTouchControlEmpty,
    BLOOD_POOL_MAX, BLOOD_POOL_LIFETIME, BLOOD_POOL_FADE_DURATION, BLOOD_POOL_BASE_SIZE, BLOOD_POOL_HEAD_MUL, BLOOD_POOL_BASE_OPACITY, BLOOD_POOL_STANDOFF, BLOOD_POOL_EXPANSION_DURATION, BLOOD_POOL_SPAWN_MAX_DIST,
    bloodPoolScale, bloodPoolScaleProgress, bloodPoolOpacity, stepBloodPoolLife, isBloodPoolExpired, bloodPoolRotation, bloodPoolElevation, canSpawnBloodPool,
    TINNITUS_MIN_THRESHOLD, TINNITUS_MAX_DURATION, TINNITUS_BASE_GAIN,
    plateInsertSound, plateLockSound, tinnitusSound, shouldTriggerTinnitus, tinnitusVolume, shouldPlayFleshHurt, playerDamageAcoustics,
    FALLOFF_SMG_KNEE, FALLOFF_SMG_MIN_MUL, FALLOFF_AR_KNEE, FALLOFF_AR_MIN_MUL, FALLOFF_BR_KNEE, FALLOFF_BR_MIN_MUL, FALLOFF_SR_KNEE, FALLOFF_SR_MIN_MUL,
    weaponFalloffParams, weaponDistanceFalloff,
    MELEE_BACKSTAB_MUL, MELEE_SLIDE_MOMENTUM_MUL, MELEE_SPRINT_MOMENTUM_MUL, MELEE_BACKSTAB_COS_THRESHOLD, isMeleeBackstab, playerMeleeDamage,
    ENEMY_EVASION_SPRINT_MUL, ENEMY_EVASION_TAC_SPRINT_MUL, ENEMY_EVASION_SLIDE_MUL, ENEMY_EVASION_CROUCH_MUL, ENEMY_EVASION_AIRBORNE_MUL,
    enemyTargetEvasionMultiplier, enemyEffectiveAccuracy, isSpatialAudioInRange,
    AIM_ASSIST_FORWARD_MIN_DOT, isAimCandidateInForwardSector, isAngleWithinThreshold, canEnemiesOverlap,
    GRENADE_POOL_MAX, canRecycleGrenade, canPlayerMelee,
    touchPauseState, touchPauseLabel, touchPauseChanged, syncTouchPauseState, isTouchControlSelected,
    streakHudPosition, joystickMoveSpeedTier, joystickIndicatorClass,
    touchJoystickChanged, syncTouchJoystickState, touchControlLocked,
    SENTRY_MUZZLE_FORWARD_OFFSET, SENTRY_MUZZLE_HEIGHT_OFFSET, SENTRY_MUZZLE_LIGHT_COLOR, SENTRY_MUZZLE_LIGHT_INTENSITY, SENTRY_MUZZLE_LIGHT_DIST, SENTRY_MUZZLE_LIGHT_DUR,
    sentryMuzzlePosition, sentryShootDirection, sentryMuzzleLightParams, shouldSpawnPenetrationCoverVfx, canMeleeStrikeWorld,
    MELEE_HIT_SOUND, MELEE_BACKSTAB_SOUND, meleeHitSound, hitmarkerSound, landingSound,
    ARMOR_ABSORB_RATIO_BULLET, ARMOR_ABSORB_RATIO_BLAST, ARMOR_ABSORB_RATIO_MELEE, ARMOR_ABSORB_RATIO_FALL, armorAbsorbRatioForType,
    WEAPON_SWITCH_SPEED_SMG, WEAPON_SWITCH_SPEED_AR, WEAPON_SWITCH_SPEED_BR, WEAPON_SWITCH_SPEED_SR, FAST_HANDS_SWITCH_MUL, weaponSwitchSpeed,
    WEAPON_ADS_SPEED_SMG, WEAPON_ADS_SPEED_AR, WEAPON_ADS_SPEED_BR, WEAPON_ADS_SPEED_SR, weaponAdsSpeed,
    waveCountdownChanged, syncWaveCountdownState, downedTimerChanged, syncDownedTimerState, flashOverlayChanged, isTargetInBlastRadius,
    SOLDIER_RAGDOLL_MOMENTUM_SCALE, SOLDIER_RAGDOLL_KNOCK_BASE, SOLDIER_RAGDOLL_KNOCK_MIN, soldierRagdollKnockback, soldierRagdollMomentum,
    canPlayerThrowEquipment, canPlayerUseStreak, canPlayerUseFieldUpgrade, canPlayerInteractStation,
    canPlayerSwitchWeapon, canPlayerAds,
    TACTICAL_FLASH_LIGHT_BLIND_COLOR, TACTICAL_FLASH_LIGHT_BLIND_INTENSITY, TACTICAL_FLASH_LIGHT_BLIND_DIST, TACTICAL_FLASH_LIGHT_BLIND_DUR,
    TACTICAL_FLASH_LIGHT_STUN_COLOR, TACTICAL_FLASH_LIGHT_STUN_INTENSITY, TACTICAL_FLASH_LIGHT_STUN_DIST, TACTICAL_FLASH_LIGHT_STUN_DUR,
    tacticalFlashLightParams, tacticalParticleParams,
    HEADSHOT_SPARK_COUNT_HELMET, HEADSHOT_SPARK_COUNT_BARE, HEADSHOT_BLOOD_MIST_HELMET, HEADSHOT_BLOOD_MIST_BARE,
    enemyHasHelmet, headshotVfxParams,
    JUMP_SLIDE_SOUND, JUMP_SOUND, jumpSound,
    CHAMBER_EMPTY_SOUND, chamberEmptySound,
    GRENADE_COOK_SOUND, grenadeCookSound, grenadeThrowSound,
    ENEMY_HIT_SOUND, ENEMY_HIT_HEAVY_SOUND, enemyMeleeHitSound,
    WEAPON_ADS_MOVE_SMG, WEAPON_ADS_MOVE_AR, WEAPON_ADS_MOVE_BR, WEAPON_ADS_MOVE_SR, weaponAdsMoveMultiplier,
    EMPTY_RELOAD_TIME_MUL,
    BLOOM_RECOVER_SMG, BLOOM_RECOVER_AR, BLOOM_RECOVER_BR, BLOOM_RECOVER_SR, weaponBloomRecoveryMultiplier,
    ENEMY_MELEE_TANK_BONUS, ENEMY_MELEE_SHIELD_BONUS, ENEMY_MELEE_SCOUT_PENALTY,
    grenadeChargeHudChanged, syncGrenadeChargeHudState, grenadeChargeLabel,
    isTargetInTacticalRadius, bulletMagnetMinCos, isMagnetCandidateCloser, isTargetInConeRange,
    SHIELD_DEFLECT_SPARK_COUNT, SHIELD_DEFLECT_SPARK_COLOR0, SHIELD_DEFLECT_SPARK_COLOR1,
    SHIELD_DEFLECT_LIGHT_COLOR, SHIELD_DEFLECT_LIGHT_INTENSITY, SHIELD_DEFLECT_LIGHT_DIST, SHIELD_DEFLECT_LIGHT_DUR,
    LANDING_DUST_HEAVY_COUNT, LANDING_DUST_LIGHT_COUNT, LANDING_DUST_COLOR,
    shieldDeflectNormal, shieldDeflectVfxParams, landingDustParams,
    SHIELD_DEFLECT_SOUND, HELMET_HIT_SOUND, LAND_HEAVY_SOUND, LAND_SOUND,
    shieldDeflectSound, helmetHitSound, enemyGrenadeThrowSound,
    BLOOM_PER_SHOT_SMG, BLOOM_PER_SHOT_AR, BLOOM_PER_SHOT_BR, BLOOM_PER_SHOT_SR,
    weaponBloomPerShotMultiplier, MELEE_TAC_SPRINT_MOMENTUM_MUL, canPlayerUsePlate,
    AIM_ASSIST_MAX_DIST, isTargetInAimAssistRange, aimAssistMinCos, isAimAssistCandidateCloser, hasAimAssistNudge,
    hasActiveHitArcs, hitArcOpacityChanged, syncHitArcOpacity, canPlayerFire, canPlayerReload,
    MELEE_SLASH_SPARK_COUNT, MELEE_SLASH_BACKSTAB_SPARKS, MELEE_SLASH_MIST_COUNT, MELEE_SLASH_BACKSTAB_MIST,
    MELEE_SLASH_LIGHT_COLOR, MELEE_SLASH_LIGHT_INTENSITY, MELEE_SLASH_LIGHT_DIST, MELEE_SLASH_LIGHT_DUR,
    meleeSlashVfxParams, meleeSlashNormal,
    MUZZLE_LIGHT_COLOR_STANDARD, MUZZLE_LIGHT_COLOR_SUPPRESSED, MUZZLE_LIGHT_DIST_STANDARD, MUZZLE_LIGHT_DIST_SUPPRESSED,
    MUZZLE_LIGHT_DIST_HEAVY, MUZZLE_LIGHT_DIST_SMG, muzzleFlashLightParams, muzzleVfxParams,
    ENEMY_STEP_SOUND, ENEMY_STEP_HEAVY_SOUND, enemyFootstepSound,
    RELOAD_OUT_SOUND, RELOAD_IN_SOUND, RELOAD_HEAVY_OUT_SOUND, RELOAD_HEAVY_IN_SOUND,
    RELOAD_SMG_OUT_SOUND, RELOAD_SMG_IN_SOUND, reloadMagazineOutSound, reloadMagazineInSound,
    MELEE_SURFACE_METAL_SOUND, MELEE_SURFACE_WOOD_SOUND, MELEE_SURFACE_GLASS_SOUND,
    MELEE_SURFACE_GROUND_SOUND, MELEE_SURFACE_DEFAULT_SOUND, meleeSurfaceSound,
    EMPTY_SWAP_SPEED_MUL, slideBaseSprintSpeed,
    RECOIL_DECAY_SMG, RECOIL_DECAY_AR, RECOIL_DECAY_BR, RECOIL_DECAY_SR,
    RECOIL_DECAY_CROUCH_MUL, RECOIL_DECAY_SLIDE_MUL, weaponRecoilDecayRate,
    BULLET_MAGNET_MAX_DIST, OBJECTIVE_RING_OPACITY_INSIDE, OBJECTIVE_RING_OPACITY_OUTSIDE,
    isTargetInMagnetRange, isTargetInMunitionsRadius, stepMunitionsTimers,
    isPlayerInObjectiveZone, objectiveRingOpacityChanged, objectiveRingOpacity,
    EXPLOSION_FIREBALL_BASE_COUNT, EXPLOSION_SPARK_BASE_COUNT, EXPLOSION_SMOKE_BASE_COUNT,
    EXPLOSION_DUST_BASE_COUNT, EXPLOSION_DEBRIS_BASE_COUNT,
    EXPLOSION_LIGHT_COLOR, EXPLOSION_LIGHT_BASE_INTENSITY, EXPLOSION_LIGHT_BASE_DIST, EXPLOSION_LIGHT_DUR,
    explosionVfxParams, explosionLightParams,
    SNIPER_TRAIL_STEP, SNIPER_TRAIL_MAX_PUFFS,
    SNIPER_TRAIL_COLOR0, SNIPER_TRAIL_COLOR1,
    SNIPER_TRAIL_BASE_SIZE, SNIPER_TRAIL_END_SIZE, SNIPER_TRAIL_ALPHA,
    sniperTrailPuffCount, sniperTrailParams, enemyWeaponType,
    DRY_FIRE_SOUND, DRY_FIRE_HEAVY_SOUND, dryFireSound,
    PICKUP_AMMO_SOUND, PICKUP_MED_SOUND, PICKUP_POWER_SOUND, pickupSound,
    MELEE_SWING_SOUND, MELEE_SWING_HEAVY_SOUND, meleeSwingSound,
    EXPLOSION_SOUND, EXPLOSION_HEAVY_SOUND, explosionSound,
    WEAPON_STF_SMG, WEAPON_STF_AR, WEAPON_STF_BR, WEAPON_STF_SR,
    TAC_SPRINT_STF_MUL, FAST_HANDS_STF_MUL, weaponSprintToFireTime,
    STANCE_SPREAD_SPRINT, STANCE_SPREAD_TAC_SPRINT, PLATE_MOVE_SPEED_MUL,
    FLOW_FIELD_QUEUE_MASK, FLOW_FIELD_QUEUE_SHIFT, packNavCell, unpackNavCell, isNavDiagonalWalkable,
    ENEMY_FOOTSTEP_MAX_DIST, isTargetInFootstepRange, enemiesRemainingChanged, syncEnemiesRemaining,
    SURFACE_IMPACT_DUST_BASE, SURFACE_IMPACT_CHIP_BASE,
    SURFACE_IMPACT_SPARK_METAL, SURFACE_IMPACT_SPARK_CONCRETE,
    SURFACE_IMPACT_LIGHT_COLOR_METAL, SURFACE_IMPACT_LIGHT_COLOR_HEAVY,
    surfaceImpactVfxParams, surfaceImpactLightParams,
    BLOOD_DROPLET_BASE_BODY, BLOOD_DROPLET_BASE_HEAD,
    BLOOD_MIST_BASE_BODY, BLOOD_MIST_BASE_HEAD,
    bloodImpactVfxParams,
    SCOPE_IN_THRESHOLD, SCOPE_OUT_THRESHOLD,
    SCOPE_IN_SOUND, SCOPE_OUT_SOUND,
    SCOPE_HEAVY_IN_SOUND, SCOPE_HEAVY_OUT_SOUND,
    CASING_SOUND, CASING_HEAVY_SOUND,
    KILL_SOUND, KILL_HEADSHOT_SOUND, KILL_ELITE_SOUND, KILL_HEAVY_SOUND,
    SECONDARY_UNLOCK_SOUND, STATION_CYCLE_SOUND,
    isWeaponScopeType, weaponScopeSound, scopeTransitionState,
    casingBounceSound, secondaryUnlockSound, stationCycleSound,
    WEAPON_SHOT_KICK_SMG, WEAPON_SHOT_KICK_AR, WEAPON_SHOT_KICK_BR, WEAPON_SHOT_KICK_SR,
    SUPPRESSOR_KICK_MUL, weaponShotKickImpulse,
    STANCE_ADS_CROUCH_MUL, STANCE_ADS_SLIDE_MUL, stanceAdsSpeedMultiplier,
    ENEMY_RANGED_TANK_BONUS, ENEMY_RANGED_SHIELD_PENALTY,
    RAGDOLL_BLAST_BOUNDING_RADIUS, isRagdollInBlastRadius, isRagdollParticleInBlast, ragdollBlastImpulse, nearestRagdollParticle, isAimAssistHeadCandidateCos,
    canTouchControlActivate, isActionKeyLockedWhileDowned, sanitizeDownedInputKeys,
    CASING_CALIBER_SCALE_SMG, CASING_CALIBER_SCALE_AR, CASING_CALIBER_SCALE_BR, CASING_CALIBER_SCALE_SR,
    CASING_EJECT_IMPULSE_SMG, CASING_EJECT_IMPULSE_AR, CASING_EJECT_IMPULSE_BR, CASING_EJECT_IMPULSE_SR,
    SLIDE_DUST_COLOR0, SLIDE_DUST_COLOR1,
    casingCaliberScale, casingEjectImpulse, slideDustVfxParams,
    TACTICAL_DETONATION_MAX_DIST_BLIND, TACTICAL_DETONATION_MAX_DIST_SMOKE, tacticalDetonationMaxDist,
    EMPTY_RELOAD_TIME_SMG, EMPTY_RELOAD_TIME_AR, EMPTY_RELOAD_TIME_BR, EMPTY_RELOAD_TIME_SR,
    weaponEmptyReloadMultiplier, ENEMY_RANGED_SCOUT_PENALTY, FAST_HANDS_PLATE_MUL, plateApplyDuration,
    ENEMY_RAY_BOUNDING_RADIUS, ENEMY_RAY_CENTER_OFFSET_Y, isEnemyRayCandidate, blastTargetDistance,
    TOUCH_ADS_SENSITIVITY_MUL, TOUCH_SCOPED_SENSITIVITY_MUL, TOUCH_STEADY_SENSITIVITY_MUL,
    touchLookSensitivity, isTouchActionAvailable,
    TRACER_CALIBER_SCALE_SMG, TRACER_CALIBER_SCALE_AR, TRACER_CALIBER_SCALE_BR, TRACER_CALIBER_SCALE_SR,
    tracerCaliberScale,
    IMPACT_FLASH_SCALE_SMG, IMPACT_FLASH_SCALE_AR, IMPACT_FLASH_SCALE_BR, IMPACT_FLASH_SCALE_SR,
    impactFlashCaliberScale,
    GRENADE_WARN_MARGIN, grenadeWarnUrgency,
    SUPPRESS_HOLD, suppressionAdd, suppressionDecay,
    OCCLUDED_CUTOFF, OCCLUDED_GAIN, occludedCutoff, occludedGain,
    PELLET_ADS_TIGHTEN, SHOTGUN_PUMP_DELAY_MS, pelletConeSpread, loadShell, weaponClassFireSound,
    LMG_HEAT_HOLD, lmgHeatAfterShot, lmgHeatDecay, lmgHeatSpreadMul, lmgHeatRecoilMul,
    SIDEARM_QUICK_DRAW, shouldQuickDrawSidearm,
    BREACHER_RANGE, BREACHER_ROF, BREACHER_PELLETS, BREACHER_PELLET_SHARE,
    breacherPelletHitChance, canBreacherFire, breacherPelletHits,
    isHostile, pickNearestHostile, modeScoreboardData, isModeOver, MATCH_MODE_IDS, isMatchModeId,
    DOMINATION_FLAG_NAMES, DOMINATION_FLAG_POINTS, DOMINATION_CAPTURE_SECONDS, DOMINATION_FLAG_RADIUS,
    DOMINATION_POINTS_PER_FLAG_SEC, DOMINATION_DEFEND_RADIUS, flagCaptureStep, flagScoreStep,
    GUN_GAME_KNIFE, GUN_GAME_TIER_COUNT, GUN_GAME_LADDER, GUN_GAME_BOT_DAMAGE_MIN,
    GUN_GAME_BOT_DAMAGE_MAX, GUN_GAME_KNIFE_DAMAGE_MUL, FREE_FOR_ALL_MAX_ACTORS, gunGameTierWeapon,
    gunGameIsKnifeTier, gunGameAdvance, gunGameCreditedKill, gunGameMeleeKill, gunGameBotDamageMul,
    RESPAWN_DELAY, SPAWN_PROTECTION_DURATION, FRIENDLY_IFF_COLOR, FRIENDLY_KIT_TINT, MINIMAP_FRIENDLY_COLOR,
    stepRespawnTimer, canRespawn, stepSpawnProtection, isSpawnProtected, isFriendlyFire,
    teamKitColor, teamIffColor, minimapActorColor, scoreSpawnPoint, pickBestSpawnPoint,
    MAP_IDS, DEFAULT_MAP_ID, sanitizeMapId, getMapDef, MAP_DEFS
  };


})();

// Node (tests) picks the namespace up here; in the browser build this is a no-op.
if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
