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
      return { shots: 0, nextShot: nextShot };
    }
    if (now < nextShot) return { shots: 0, nextShot: nextShot };
    const due = Math.floor((now - nextShot) / interval + 1e-9) + 1;
    const limit = isFinite(maxShots) ? Math.max(0, Math.floor(maxShots)) : due;
    const shots = Math.min(due, limit);
    return { shots: shots, nextShot: nextShot + shots * interval };
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
    if (typeof moveX !== 'number' || !isFinite(moveX)) return false;
    if (typeof moveZ !== 'number' || !isFinite(moveZ)) return false;
    return moveZ > JOYSTICK_SPRINT_FORWARD && Math.hypot(moveX, moveZ) > JOYSTICK_SPRINT_MAGNITUDE;
  }

  // Mobile virtual joystick coordinate and deadzone resolution. Clamps touch
  // displacement within the base radius and maps screen delta to yaw-relative
  // movement axes (negative dy = forward = +z). Inputs within the deadzone are
  // zeroed to prevent drift while keeping visual stick displacement responsive.
  const JOYSTICK_RADIUS = 56;
  const JOYSTICK_DEADZONE = 0.12;
  function joystickInput(dx, dy, radius, deadzone) {
    if (typeof dx !== 'number' || !isFinite(dx) || typeof dy !== 'number' || !isFinite(dy)) {
      return { clampedX: 0, clampedY: 0, moveX: 0, moveZ: 0 };
    }
    const r = typeof radius === 'number' && isFinite(radius) && radius > 0 ? radius : JOYSTICK_RADIUS;
    const dz = typeof deadzone === 'number' && isFinite(deadzone) && deadzone >= 0 ? deadzone : JOYSTICK_DEADZONE;
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
    return { clampedX: cx, clampedY: cy, moveX: moveX, moveZ: moveZ };
  }

  // Mobile virtual joystick discrete movement key resolution. Maps analog movement axes
  // to digital WASD keys based on directional threshold, avoiding allocation churn via
  // an optional reusable output object.
  const JOYSTICK_MOVE_THRESHOLD = 0.15;
  function touchMovementKeys(moveX, moveZ, threshold, out) {
    const th = typeof threshold === 'number' && isFinite(threshold) && threshold >= 0 ? threshold : JOYSTICK_MOVE_THRESHOLD;
    const mx = typeof moveX === 'number' && isFinite(moveX) ? moveX : 0;
    const mz = typeof moveZ === 'number' && isFinite(moveZ) ? moveZ : 0;
    const res = out && typeof out === 'object' ? out : { w: false, s: false, a: false, d: false };
    res.w = mz > th;
    res.s = mz < -th;
    res.d = mx > th;
    res.a = mx < -th;
    return res;
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
    const base = (typeof baseScore === 'number' && isFinite(baseScore) && baseScore >= 0) ? baseScore : 0;
    const w = (typeof waveNum === 'number' && isFinite(waveNum) && waveNum >= 0) ? Math.floor(waveNum) : 0;
    const p = (typeof perWave === 'number' && isFinite(perWave) && perWave >= 0) ? perWave : WAVE_SCORE_PER_WAVE;
    return base + w * p;
  }

  // ---- Wave resupply ammo recovery -------------------------------------------
  // Each wave clear tops up reserves by `RESUPPLY_MAG_RATIO` mags, capped at the
  // weapon's reserveMax. The ratio is extracted here so it can be referenced in
  // tests and tuned in one place without touching the HUD module.
  const RESUPPLY_MAG_RATIO = 2.5;
  function waveResupplyAmmo(currentReserve, reserveMax, magSize, ratio) {
    const cur = (typeof currentReserve === 'number' && isFinite(currentReserve) && currentReserve >= 0) ? currentReserve : 0;
    const max = (typeof reserveMax === 'number' && isFinite(reserveMax) && reserveMax >= 0) ? reserveMax : 0;
    const mag = (typeof magSize === 'number' && isFinite(magSize) && magSize > 0) ? magSize : 0;
    const r = (typeof ratio === 'number' && isFinite(ratio) && ratio > 0) ? ratio : RESUPPLY_MAG_RATIO;
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
    const rad = (typeof r === 'number' && isFinite(r) && r > 0) ? r : 0;
    if (x <= c.min.x - rad || x >= c.max.x + rad || z <= c.min.z - rad || z >= c.max.z + rad) return null;
    const cx = (c.min.x + c.max.x) * 0.5;
    const cz = (c.min.z + c.max.z) * 0.5;
    const px = x >= cx ? (c.max.x + rad - x) : (x - (c.min.x - rad));
    const pz = z >= cz ? (c.max.z + rad - z) : (z - (c.min.z - rad));
    const axis = px < pz ? 'x' : 'z';
    const val = px < pz ? (x >= cx ? c.max.x + rad : c.min.x - rad) : (z >= cz ? c.max.z + rad : c.min.z - rad);
    if (out && typeof out === 'object') {
      out.axis = axis;
      out.val = val;
      return out;
    }
    return { axis: axis, val: val };
  }
  // Vertical collider query: scans colliders overlapping (x, z) with radius r.
  // Finds the highest floor surface below feet + stepH, and the lowest ceiling slab above feet.
  // When out is provided, mutates and returns out without heap allocation;
  // otherwise returns a new { floorY, ceilY } object.
  function resolveVerticalBounds(x, z, r, colliders, feet, stepH, groundY, out) {
    let floorY = (typeof groundY === 'number' && isFinite(groundY)) ? groundY : 0;
    let ceilY = Infinity;
    if (!colliders || !colliders.length) {
      if (out && typeof out === 'object') { out.floorY = floorY; out.ceilY = ceilY; return out; }
      return { floorY: floorY, ceilY: ceilY };
    }
    const rad = (typeof r === 'number' && isFinite(r) && r > 0) ? r : 0;
    const maxStepY = feet + (typeof stepH === 'number' ? stepH : 0.6);
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c || !c.min || !c.max) continue;
      if (x <= c.min.x - rad || x >= c.max.x + rad || z <= c.min.z - rad || z >= c.max.z + rad) continue;
      if (c.max.y <= maxStepY && c.max.y > floorY) floorY = c.max.y;
      if (c.min.y > feet && c.min.y < ceilY) ceilY = c.min.y;
    }
    if (out && typeof out === 'object') {
      out.floorY = floorY;
      out.ceilY = ceilY;
      return out;
    }
    return { floorY: floorY, ceilY: ceilY };
  }
  // Fast floor-only resolver for grounding agents without tracking ceiling clearance.
  function findFloorY(x, z, r, colliders, feet, stepH, groundY) {
    let floorY = (typeof groundY === 'number' && isFinite(groundY)) ? groundY : 0;
    if (!colliders || !colliders.length) return floorY;
    const rad = (typeof r === 'number' && isFinite(r) && r > 0) ? r : 0;
    const maxStepY = feet + (typeof stepH === 'number' ? stepH : 0.6);
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
    if (typeof cMinY !== 'number' || typeof cMaxY !== 'number' || !isFinite(cMinY) || !isFinite(cMaxY)) return false;
    const step = (typeof stepH === 'number' && isFinite(stepH) && stepH >= 0) ? stepH : 0.6;
    const feet = (typeof feetY === 'number' && isFinite(feetY)) ? feetY : 0;
    const head = (typeof headY === 'number' && isFinite(headY)) ? headY : feet + 1.8;
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
    showFps: { type: 'bool', def: true, label: 'Show FPS counter' }
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
    const opts = options && typeof options === 'object' ? options : {};
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
      if (!values.length) return { count: 0, capacity: capacity, min: null, max: null, p50: null, p95: null };
      const sorted = values.slice().sort(function (a, b) { return a - b; });
      return {
        count: sorted.length,
        capacity: capacity,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95)
      };
    }
    return { enabled: enabled, capacity: capacity, record: record, samples: samples, summary: summary };
  }

  // Runtime wrapper keeps the capture opt-in while allowing the main loop to
  // expose a safe, read-only snapshot for probes and local performance checks.
  function createRuntimeTelemetry(options) {
    const opts = options && typeof options === 'object' ? options : {};
    let active = opts.enabled === true;
    const capture = createFrameTimeTelemetry({ enabled: true, maxSamples: opts.maxSamples });
    function record(frameTimeMs) { return active && capture.record(frameTimeMs); }
    function setEnabled(value) { active = value === true; return active; }
    function snapshot() {
      return { enabled: active, summary: capture.summary(), samples: capture.samples() };
    }
    return { get enabled() { return active; }, capacity: capture.capacity,
      record: record, setEnabled: setEnabled, snapshot: snapshot };
  }

  // Pure continuous swept-sphere motion for grenade regressions and runtime use.
  // A bounded contact loop consumes the unspent fraction after every impact.
  function stepGrenadeMotion(state, dt, boxes, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const bounce = Number.isFinite(opts.bounce) ? Math.max(0, Math.min(1, opts.bounce)) : 0.35;
    const maxContacts = Number.isFinite(opts.maxContacts) ? Math.max(1, Math.floor(opts.maxContacts)) : 4;
    let remaining = Math.max(0, Number(dt) || 0), contacts = 0;
    const p = state.position, v = state.velocity;
    while (remaining > 1e-7 && contacts < maxContacts) {
      const end = { x: p.x + v.x * remaining, y: p.y + v.y * remaining, z: p.z + v.z * remaining };
      const hit = sweepGrenade(p, end, opts.radius === undefined ? 0.11 : opts.radius, boxes || []);
      if (!hit) { p.x = end.x; p.y = end.y; p.z = end.z; break; }
      const t = Math.max(0, Math.min(1, hit.t));
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
    return { contacts: contacts, remaining: remaining };
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
    const base = (typeof baseRate === 'number' && isFinite(baseRate)) ? baseRate : 1.0;
    const r = (typeof rand === 'number' && isFinite(rand)) ? rand : Math.random();
    return base + (r - 0.5) * SOUND_VARIED_RANGE;
  }

  // ---- Positional spatial audio -----------------------------------------------
  // Pure distance attenuation and stereo panning relative to player orientation.
  // Panning projects sound vector onto player right vector: cos(yaw), -sin(yaw).
  const SPATIAL_AUDIO_MAX_DIST = 55;
  const SPATIAL_AUDIO_PAN_BOOST = 1.4;
  const SPATIAL_AUDIO_MIN_VOL = 0.15;

  function spatialAudioPan(dx, dz, playerYaw, dist, panBoost) {
    const yaw = (typeof playerYaw === 'number' && isFinite(playerYaw)) ? playerYaw : 0;
    const d = (typeof dist === 'number' && isFinite(dist) && dist > 0) ? dist : Math.hypot(dx, dz);
    if (d < 1e-6) return 0;
    const boost = (typeof panBoost === 'number' && isFinite(panBoost)) ? panBoost : SPATIAL_AUDIO_PAN_BOOST;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const raw = ((dx * rx + dz * rz) / d) * boost;
    return Math.max(-1, Math.min(1, raw));
  }

  function spatialAudioVolume(dist, maxDist, minVol) {
    const maxD = (typeof maxDist === 'number' && isFinite(maxDist) && maxDist > 0) ? maxDist : SPATIAL_AUDIO_MAX_DIST;
    const minV = (typeof minVol === 'number' && isFinite(minVol)) ? minVol : SPATIAL_AUDIO_MIN_VOL;
    const d = (typeof dist === 'number' && isFinite(dist) && dist >= 0) ? dist : 0;
    if (d >= maxD) return 0;
    const norm = 1 - (d / maxD);
    return minV + (1 - minV) * norm * norm;
  }

  const AIR_ABSORPTION_MAX_FREQ = 8000;
  const AIR_ABSORPTION_MIN_FREQ = 500;
  const AIR_ABSORPTION_Q = 0.5;

  function spatialAudioCutoff(dist, maxDist, maxFreq, minFreq) {
    const maxD = (typeof maxDist === 'number' && isFinite(maxDist) && maxDist > 0) ? maxDist : SPATIAL_AUDIO_MAX_DIST;
    const hi = (typeof maxFreq === 'number' && isFinite(maxFreq) && maxFreq > 0) ? maxFreq : AIR_ABSORPTION_MAX_FREQ;
    const lo = (typeof minFreq === 'number' && isFinite(minFreq) && minFreq >= 0) ? minFreq : AIR_ABSORPTION_MIN_FREQ;
    const d = (typeof dist === 'number' && isFinite(dist) && dist >= 0) ? dist : 0;
    const ratio = Math.max(0, Math.min(1, d / maxD));
    return hi - (hi - lo) * ratio;
  }

  function spatialAudioParams(dx, dz, playerYaw, maxDist) {
    const maxD = (typeof maxDist === 'number' && isFinite(maxDist) && maxDist > 0) ? maxDist : SPATIAL_AUDIO_MAX_DIST;
    const dist = Math.hypot(dx, dz);
    if (dist > maxD) return { dist: dist, pan: 0, vol: 0, cutoff: AIR_ABSORPTION_MIN_FREQ, audible: false };
    const pan = spatialAudioPan(dx, dz, playerYaw, dist);
    const vol = spatialAudioVolume(dist, maxD);
    const cutoff = spatialAudioCutoff(dist, maxD);
    return { dist: dist, pan: pan, vol: vol, cutoff: cutoff, audible: true };
  }

  const SPATIAL_EXPLOSION_MAX_DIST = 85;

  function spatialExplosionParams(dx, dz, playerYaw) {
    return spatialAudioParams(dx, dz, playerYaw, SPATIAL_EXPLOSION_MAX_DIST);
  }

  function tacticalDetonationSound(effect) {
    if (effect === 'smoke') return 'explosion';
    if (effect === 'blind') return 'headshot';
    return 'pin';
  }

  function grenadeContactSound(sticky, velY) {
    if (sticky) return 'pin';
    const vy = (typeof velY === 'number' && isFinite(velY)) ? Math.abs(velY) : 0;
    if (vy > 1) return 'bounce';
    return null;
  }

  function weaponFireSound(weaponType) {
    if (weaponType === 'SR') return 'sniper';
    if (weaponType === 'SMG') return 'smg';
    if (weaponType === 'BR') return 'br';
    return 'shot';
  }

  function armorDamageSound(initialArmor, remainingArmor) {
    const init = (typeof initialArmor === 'number' && isFinite(initialArmor)) ? initialArmor : 0;
    const rem = (typeof remainingArmor === 'number' && isFinite(remainingArmor)) ? remainingArmor : 0;
    if (init <= 0) return null;
    if (rem <= 0) return 'armor_break';
    return 'block';
  }

  function killConfirmationSound(isHead, isElite) {
    if (isElite) return 'kill_elite';
    if (isHead) return 'kill_headshot';
    return 'kill';
  }

  // Multi-kill streak window (seconds) and cap
  const MK_WINDOW = 4;
  const MK_MAX_STREAK = 5;

  function advanceKillStreak(streak, lastKillTime, now, windowSec) {
    const w = (typeof windowSec === 'number' && isFinite(windowSec) && windowSec > 0) ? windowSec : MK_WINDOW;
    const cur = (typeof streak === 'number' && isFinite(streak) && streak >= 0) ? Math.floor(streak) : 0;
    const last = (typeof lastKillTime === 'number' && isFinite(lastKillTime)) ? lastKillTime : -99;
    const t = (typeof now === 'number' && isFinite(now)) ? now : 0;
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

  function playerFootstepSound(isCrouching) {
    return isCrouching ? 'step_crouch' : 'step';
  }

  function shouldPlayFootstep(onGround, horizontalSpeed, minSpeed) {
    const minSpd = (typeof minSpeed === 'number' && isFinite(minSpeed) && minSpeed >= 0)
      ? minSpeed : FOOTSTEP_MIN_SPEED;
    const spd = (typeof horizontalSpeed === 'number' && isFinite(horizontalSpeed))
      ? horizontalSpeed : 0;
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
    return { phase: phase, gameEnded: phase === 'victory', showVictory: phase === 'victory' };
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
      }, records: records };
    }
    return { rewards: {
      score: Math.max(0, records.score - (snapshot.score || 0)), wave: 0, accuracy: 0,
      kills: Math.max(0, (run.kills || 0) - (snapshot.kills || 0)),
      headshots: Math.max(0, (run.headshots || 0) - (snapshot.headshots || 0)),
      streaks: Math.max(0, (run.streaks || 0) - (snapshot.streaks || 0))
    }, records: records };
  }
  function mergeRunIntoStats(stats, run) {
    const next = sanitizeStats(stats);
    const beat = { score: false, wave: false, accuracy: false };
    const recordScore = typeof run.recordScore === 'number' ? run.recordScore : run.score;
    const recordWave = typeof run.recordWave === 'number' ? run.recordWave : run.wave;
    const recordAccuracy = typeof run.recordAccuracy === 'number' ? run.recordAccuracy : run.accuracy;
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
    return { stats: next, beat: beat, xpGained: gained, rank: rankAfter, rankBefore: rankBefore };
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
    if (rank >= MAX_RANK) return { rank: rank, into: 1, need: 1, pct: 1, max: true };
    const base = xpForRank(rank), next = xpForRank(rank + 1);
    const into = Math.max(0, xp - base), need = next - base;
    return { rank: rank, into: into, need: need, pct: need > 0 ? into / need : 1, max: false };
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
  const WEAPON_UNLOCK_RANK = [1, 1, 3, 6];
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
             have: have, target: def.target,
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
  //   3 shielded   wave 9    frontal plate, must be flanked
  // Weights rather than nested thresholds, so adding a kind cannot silently
  // starve an existing one.
  const ENEMY_KIND_UNLOCK = [
    { kind: 0, wave: 1, weight: 1.0,  name: 'Runner' },
    { kind: 1, wave: 2, weight: 0.9,  name: 'Rifleman' },
    { kind: 4, wave: 3, weight: 0.45, name: 'Scout' },
    { kind: 2, wave: 4, weight: 0.3,  name: 'Tank' },
    { kind: 5, wave: 6, weight: 0.35, name: 'Grenadier' },
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
  const FLANK_WINDOW = [5, 9];   // seconds, randomised per agent
  function flankWindow(rand) { return FLANK_WINDOW[0] + (rand || 0) * (FLANK_WINDOW[1] - FLANK_WINDOW[0]); }
  function flankBiasNow(flankT, dist) {
    if (!(flankT > 0)) return 0;
    return flankBias(dist);
  }

  function flankBias(dist, full, none) {
    const f = full === undefined ? 18 : full;    // full bias at/beyond this range
    const n = none === undefined ? 6 : none;     // no bias inside this range
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
    if (magsLeft <= 0.5) return 1;              // effectively dry: always drop
    if (magsLeft >= 3) return base;             // comfortable: normal odds
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
    const mul = (typeof perkMul === 'number' && isFinite(perkMul) && perkMul > 0) ? perkMul : 1;
    const max = (typeof maxHealth === 'number' && isFinite(maxHealth) && maxHealth > 0) ? maxHealth : 100;
    const hp = (typeof health === 'number' && isFinite(health)) ? health : max;
    const frac = Math.max(0, Math.min(1, hp / max));
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
    if (typeof roll !== 'number' || !isFinite(roll) || roll < 0) return null;
    const a = (typeof ammoChance === 'number' && isFinite(ammoChance)) ? Math.max(0, ammoChance) : 0;
    const m = (typeof medChance === 'number' && isFinite(medChance)) ? Math.max(0, medChance) : 0;
    if (roll < a) return 'ammo';
    if (roll < a + m) return 'med';
    return null;
  }

  // ---- Armor damage absorption & bleed-through -------------------------------
  // In tactical combat, body armor absorbs the majority of incoming damage while
  // letting a calculated bleed-through fraction pass to health. This rewards picking
  // up armor and inserting plates without creating full invulnerability.
  const ARMOR_ABSORB_RATIO = 0.65;
  function resolveArmorDamage(amount, currentArmor, absorbRatio) {
    const amt = typeof amount === 'number' && isFinite(amount) ? Math.max(0, amount) : 0;
    const armor = typeof currentArmor === 'number' && isFinite(currentArmor) ? Math.max(0, currentArmor) : 0;
    if (amt <= 0 || armor <= 0) {
      return { absorbed: 0, healthDamage: amt, remainingArmor: armor };
    }
    const ratio = typeof absorbRatio === 'number' && isFinite(absorbRatio) && absorbRatio >= 0 && absorbRatio <= 1
      ? absorbRatio
      : ARMOR_ABSORB_RATIO;
    const absorbed = Math.min(armor, amt * ratio);
    return {
      absorbed: absorbed,
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
      weapons: state.weapons,            // [{gi, ammo, reserve, up}, ...]
      openDistricts: (state.openDistricts || []).slice(),
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
    if (raw.v !== SAVE_VERSION) return null;          // old saves are dropped, not guessed at
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
      if (w.up && typeof w.up === 'object') {
        const base = weaponDefs && weaponDefs[gi] && typeof weaponDefs[gi] === 'object'
          ? weaponDefs[gi] : null;
        up = base ? Object.assign({}, base) : {};
        up.dmg = num(w.up.dmg, 0, 1e5, base ? base.dmg : 0);
        up.mag = Math.round(num(w.up.mag, 1, 999, base ? base.mag : 1));
        up.reserveMax = Math.round(num(w.up.reserveMax, 0, 9999, base ? base.reserveMax : 0));
        up.name = typeof w.up.name === 'string'
          ? w.up.name.slice(0, 80) : (base && typeof base.name === 'string' ? base.name : '');
        up.upgraded = true;
      }
      weapons.push({ gi: gi, ammo: Math.round(num(w.ammo, 0, 999, 0)), reserve: Math.round(num(w.reserve, 0, 9999, 0)), up: up });
    }
    if (!weapons.length || !weapons[0]) return null;   // a run needs a primary
    const phase = raw.runPhase === 'victory' || raw.runPhase === 'endless' ? raw.runPhase : 'active';
    const snap = raw.settlementSnapshot && typeof raw.settlementSnapshot === 'object' ? {
      kills: Math.round(num(raw.settlementSnapshot.kills, 0, 1e6, 0)),
      headshots: Math.round(num(raw.settlementSnapshot.headshots, 0, 1e6, 0)),
      streaks: Math.round(num(raw.settlementSnapshot.streaks, 0, 1e6, 0))
    } : null;
    const perks = (Array.isArray(raw.perks) ? raw.perks : [])
      .filter(function (k) { return !!perkByKey(k); }).slice(0, PERK_SLOTS);
    const maxHealth = perkMaxHealth(
      typeof baseHealth === 'number' && isFinite(baseHealth) && baseHealth > 0 ? baseHealth : 100,
      perks
    );
    return {
      v: SAVE_VERSION, wave: wave,
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
      perks: perks,
      plates: num(raw.plates, 0, PLATE_MAX, 0),
      grenades: Math.round(num(raw.grenades, 0, 9, 0)),
      difficulty: DIFFICULTIES[raw.difficulty] ? raw.difficulty : 'regular',
      endless: !!raw.endless,
      runPhase: phase,
      settlementSnapshot: snap,
      streakKills: Math.round(num(raw.streakKills, 0, 1e6, 0)),
      runStreaksEarned: Math.round(num(raw.runStreaksEarned, 0, 1e6, 0)),
      weapons: weapons,
      openDistricts: (Array.isArray(raw.openDistricts) ? raw.openDistricts : [])
        .filter(function (k) { return k === 'ne' || k === 'sw'; }),
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
          best = { t: 0, normal: normal, box: b, initialOverlap: true,
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
      best = { t: enter, normal: normal, box: b };
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
    return { cell: cell, half: half, dim: dim, buckets: buckets, stamp: new Int32Array(0), stampId: 0, count: 0, maxId: -1 };
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
        break;   // left the grid for good
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
      cell: cell, half: half, dim: dim, blocked: blocked,
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
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;   // ring only
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
    queue[tail++] = goal;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % dim, cz = (cur / dim) | 0;
      const nd = dist[cur] + 1;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NEIGHBOUR_DX[k], nz = cz + NEIGHBOUR_DZ[k];
        if (nx < 0 || nz < 0 || nx >= dim || nz >= dim) continue;
        const ni = nz * dim + nx;
        if (blocked[ni] || dist[ni] !== UNREACHABLE) continue;
        // No corner cutting: a diagonal step needs both orthogonal neighbours open,
        // otherwise agents shave through the corner of a wall they cannot fit past.
        if (k >= 4 && (blocked[cz * dim + nx] || blocked[nz * dim + cx])) continue;
        dist[ni] = nd;
        queue[tail++] = ni;
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
    if (nav.dist[i] === 0) return null;   // already at the goal cell
    const dim = nav.dim, cx = i % dim, cz = (i / dim) | 0;
    let best = nav.dist[i], bestIdx = -1;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NEIGHBOUR_DX[k], nz = cz + NEIGHBOUR_DZ[k];
      if (nx < 0 || nz < 0 || nx >= dim || nz >= dim) continue;
      const ni = nz * dim + nx;
      if (nav.blocked[ni]) continue;
      const d = nav.dist[ni];
      if (d === UNREACHABLE) continue;
      if (k >= 4 && (nav.blocked[cz * dim + nx] || nav.blocked[nz * dim + cx])) continue;
      if (d < best) { best = d; bestIdx = ni; }
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
  const RECOIL_JITTER = 0.15;   // +/- 15%: learnable, but not robotic
  const RECOIL_RESET = 0.35;    // seconds off the trigger before shot 1 is shot 1
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
    if (out && typeof out === 'object') {
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
    if (out && typeof out === 'object') {
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
  const BLOOM_PER_SHOT = 0.18;   // base spreads added per shot
  const BLOOM_CAP_HIP = 1.6;     // hipfire ceiling, in base spreads
  const BLOOM_CAP_ADS = 0.35;    // ADS ceiling — far tighter, which is the point
  const BLOOM_RECOVER = 2.2;     // base spreads per second once the trigger is up
  function bloomParams(baseSpread, adsSpread, ads) {
    const base = ads ? adsSpread : baseSpread;
    return {
      perShot: base * BLOOM_PER_SHOT,
      cap: base * (ads ? BLOOM_CAP_ADS : BLOOM_CAP_HIP),
      recover: base * BLOOM_RECOVER
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
  const STANCE_SPREAD_AIRBORNE_PENALTY = 0.80;

  function stanceSpreadMultiplier(isCrouching, isSliding) {
    if (isSliding) return STANCE_SPREAD_SLIDE;
    if (isCrouching) return STANCE_SPREAD_CROUCH;
    return 1.0;
  }

  function effectiveSpread(base, bloom, speed, airborne, stanceMul) {
    const stance = (typeof stanceMul === 'number' && isFinite(stanceMul) && stanceMul > 0) ? stanceMul : 1.0;
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
      if (t >= 0) hits.push({ t: t, box: boxes[i] });
    }
    hits.sort(function (a, b) { return a.t - b.t; });
    const tiers = [];
    let left = power, crossed = 0;
    for (let i = 0; i < hits.length; i++) {
      if (crossed >= MAX_PENETRATIONS) return { stopAt: hits[i].t, tiers: tiers };
      const next = penetrate(left, hits[i].box.mat);
      if (next <= 0) return { stopAt: hits[i].t, tiers: tiers };
      left = next; crossed++;
      tiers.push({ at: hits[i].t, mul: penetrationDamageMul(left, power) });
    }
    return { stopAt: maxDist, tiers: tiers };
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
      const tx = (t.pos && typeof t.pos.x === 'number') ? t.pos.x : t.x;
      const tz = (t.pos && typeof t.pos.z === 'number') ? t.pos.z : t.z;
      const dx = tx - px, dz = tz - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > reach || d < 1e-6) continue;
      if ((dx * dirX + dz * dirZ) / d < cosHalfAngle) continue;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  const MELEE_REACH = 2.2;
  const MELEE_CONE = Math.cos(Math.PI / 4);   // 45 degrees either side
  const MELEE_DAMAGE = 150;
  const MELEE_COOLDOWN = 0.9;

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
  const WALL_BUY_PRICE = { smg: 1000, ar: 1200, br: 1500, sr: 2000 };
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
  function wallBuyOffer(owned, weaponIndex, type, reserve, reserveMax) {
    const held = owned.indexOf(weaponIndex);
    if (held < 0) return { action: 'buy', price: wallBuyPrice(type) };
    if (reserve >= reserveMax) return { action: 'full', price: 0 };
    return { action: 'ammo', price: ammoRefillPrice(type) };
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
    const max = (maxHealth && maxHealth > 0) ? maxHealth : 100;
    return typeof health === 'number' && isFinite(health) && health <= max * HEALTH_LOW_THRESHOLD;
  }
  const HEALTH_CRITICAL_RATIO = 0.25;
  const CRITICAL_VIGNETTE_BASE_BLUR = 90;
  const CRITICAL_VIGNETTE_MAX_BLUR = 140;
  const CRITICAL_VIGNETTE_BASE_SPREAD = 30;
  const CRITICAL_VIGNETTE_MAX_SPREAD = 55;

  // Evaluates whether current health is in the critical danger zone (positive health <= 25% max).
  function isHealthCritical(health, maxHealth, ratio) {
    if (typeof health !== 'number' || !isFinite(health) || health <= 0) return false;
    const r = (typeof ratio === 'number' && isFinite(ratio) && ratio > 0) ? ratio : HEALTH_CRITICAL_RATIO;
    const max = (typeof maxHealth === 'number' && isFinite(maxHealth) && maxHealth > 0) ? maxHealth : 100;
    return health <= max * r;
  }

  // Calculates normalized danger intensity [0.0, 1.0] as health drops from the critical threshold down to 0.
  // Returns 0 if health is outside the critical window or dead.
  function criticalHealthIntensity(health, maxHealth, ratio) {
    if (typeof health !== 'number' || !isFinite(health) || health <= 0) return 0;
    const r = (typeof ratio === 'number' && isFinite(ratio) && ratio > 0) ? ratio : HEALTH_CRITICAL_RATIO;
    const max = (typeof maxHealth === 'number' && isFinite(maxHealth) && maxHealth > 0) ? maxHealth : 100;
    const thresh = max * r;
    if (health > thresh) return 0;
    return Math.max(0, Math.min(1, (thresh - health) / thresh));
  }

  // Returns tactical health status: 'dead', 'critical', 'low', or 'nominal'.
  function healthDangerState(health, maxHealth, critRatio, lowRatio) {
    if (typeof health !== 'number' || !isFinite(health) || health <= 0) return 'dead';
    if (isHealthCritical(health, maxHealth, critRatio)) return 'critical';
    if (isHealthLow(health, maxHealth)) return 'low';
    return 'nominal';
  }

  // Computes CSS box-shadow styling for the critical near-death perimeter vignette.
  function criticalVignetteStyle(intensity, isReducedMotion) {
    const clamped = (typeof intensity === 'number' && isFinite(intensity)) ? Math.max(0, Math.min(1, intensity)) : 0;
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
    const clamped = (typeof intensity === 'number' && isFinite(intensity)) ? Math.max(0, Math.min(1, intensity)) : 0;
    if (clamped <= 0) return 0;
    if (isReducedMotion) return 0.5 * clamped;
    const t = (typeof timeSec === 'number' && isFinite(timeSec)) ? timeSec : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.35);
    return Math.min(1, (0.35 + 0.50 * pulse) * clamped);
  }
  const ARMOR_LOW_RATIO = 0.25;
  function isArmorLow(armor, maxArmor) {
    if (typeof armor !== 'number' || !isFinite(armor)) return false;
    const max = (typeof maxArmor === 'number' && isFinite(maxArmor) && maxArmor > 0) ? maxArmor : 50;
    return armor > 0 && armor <= max * ARMOR_LOW_RATIO;
  }
  function isArmorEmpty(armor) {
    if (typeof armor !== 'number' || !isFinite(armor)) return true;
    return armor <= 0;
  }
  const AMMO_LOW_RATIO = 0.25;
  function isAmmoLow(ammo, mag) {
    if (typeof ammo !== 'number' || !isFinite(ammo)) return false;
    if (typeof mag !== 'number' || !isFinite(mag) || mag <= 0) return false;
    return ammo <= mag * AMMO_LOW_RATIO;
  }
  function isAmmoEmpty(ammo) {
    if (typeof ammo !== 'number' || !isFinite(ammo)) return false;
    return ammo <= 0;
  }
  function reloadPrompt(reloading, ammo, reserve, isTouch) {
    if (reloading) return 'RELOADING';
    if (typeof ammo !== 'number' || !isFinite(ammo)) return '';
    if (ammo > 0) return '';
    const res = typeof reserve === 'number' && isFinite(reserve) ? reserve : 0;
    if (res <= 0) return 'OUT OF AMMO — FIND PICKUPS';
    return isTouch ? 'RELOAD' : 'RELOAD [R]';
  }
  // Mobile touch reload button feedback state. Returns 'urgent' when magazine is empty
  // with reserves available and not already reloading; 'reloading' when reloading; and
  // '' during normal combat or complete ammo exhaustion.
  function touchReloadState(ammo, reserve, reloading) {
    if (reloading) return 'reloading';
    if (typeof ammo !== 'number' || !isFinite(ammo) || ammo > 0) return '';
    const res = typeof reserve === 'number' && isFinite(reserve) ? reserve : 0;
    if (res <= 0) return '';
    return 'urgent';
  }
  // Mobile touch plate button feedback state: returns 'inserting' during plate application,
  // 'empty' when plate inventory is 0, 'urgent' when plates are held and armor is depleted
  // or critically low (<= 25% max), 'ready' when armor is damaged and can accept a plate,
  // or '' when armor is already at full capacity.
  function touchPlateState(plates, armor, armorMax, inserting) {
    if (inserting) return 'inserting';
    if (typeof plates !== 'number' || !isFinite(plates) || plates <= 0) return 'empty';
    const curA = typeof armor === 'number' && isFinite(armor) ? armor : 0;
    const maxA = typeof armorMax === 'number' && isFinite(armorMax) ? armorMax : 50;
    if (curA <= 0 || isArmorLow(curA, maxA)) return 'urgent';
    if (curA < maxA) return 'ready';
    return '';
  }
  // Mobile touch equipment button state (frag grenades, tactical equipment): returns 'charging'
  // while holding throw, 'empty' when stock is exhausted, or 'ready' when items remain.
  function touchEquipmentState(count, isCharging) {
    if (isCharging) return 'charging';
    if (typeof count !== 'number' || !isFinite(count) || count <= 0) return 'empty';
    return 'ready';
  }
  // Mobile touch scorestreak/field upgrade button state: returns 'streak' when a banked
  // streak is ready, 'field' when field upgrade is ready, or 'empty' when neither is charged.
  function touchStreakState(hasStreak, fieldReady) {
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
    const slot = typeof curSlot === 'number' && isFinite(curSlot) ? ((curSlot % n) + n) % n : 0;
    for (let k = 1; k < n; k++) {
      const ns = (slot + k) % n;
      const wid = weaponsOwned[ns];
      if (typeof wid === 'number' && isFinite(wid) && wid >= 0) return ns;
    }
    return -1;
  }
  // Mobile touch weapon swap button state: returns 'switching' while weapon is raising,
  // 'empty' when no secondary weapon is available, or 'ready' when a reserve weapon is owned
  // and can be switched to.
  // Backwards-compatible: behaves identically to previous versions when isSwitching is omitted or falsy.
  // Pure: no side effects, no DOM, no THREE.
  function touchSwapState(curSlot, weaponsOwned, isSwitching) {
    if (touchSwapNextSlot(curSlot, weaponsOwned) < 0) return 'empty';
    if (isSwitching) return 'switching';
    return 'ready';
  }
  // Mobile touch weapon swap button label: returns 'DRAW' while weapon is raising, the weapon type
  // of the reserve weapon (e.g. 'AR', 'SMG', 'BR', 'SR') when secondary is owned,
  // or 'SWAP' when empty/unowned.
  // Backwards-compatible: behaves identically to previous versions when isSwitching is omitted or falsy.
  // Pure: no side effects, no DOM, no THREE.
  function touchSwapLabel(curSlot, weaponsOwned, weaponsList, isSwitching) {
    const nextSlot = touchSwapNextSlot(curSlot, weaponsOwned);
    if (nextSlot < 0) return 'SWAP';
    if (isSwitching) return 'DRAW';
    const wid = weaponsOwned[nextSlot];
    if (Array.isArray(weaponsList) && weaponsList[wid] && typeof weaponsList[wid].type === 'string') {
      return weaponsList[wid].type;
    }
    return 'SWAP';
  }
  // Station interaction buy prompt prefix: generates 'HOLD USE — ' on mobile touch devices
  // or 'HOLD F — ' on desktop when interactive purchase is available.
  function buyPromptPrefix(isTouch, ok) {
    if (!ok) return '';
    return isTouch ? 'HOLD USE — ' : 'HOLD F — ';
  }
  // Mobile touch station USE button state: returns 'holding' when actively holding interaction,
  // 'ready' when in range of an affordable station, 'blocked' when near an unaffordable station,
  // or 'empty' when out of range of any interactive station.
  function touchUseState(nearStation, canAfford, isHolding) {
    if (!nearStation) return 'empty';
    if (isHolding) return 'holding';
    if (canAfford) return 'ready';
    return 'blocked';
  }
  // Mobile touch station USE button contextual label: displays 'HOLD' while purchasing,
  // 'LOCK' when blocked, 'UPGRADE' / 'OPEN' / 'AMMO' / 'BUY' / 'PLATE' / 'PERK' / 'CYCLE'
  // when available, or 'USE' when idle/empty.
  function touchUseLabel(nearStation, canAfford, isHolding, stationKind, action) {
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
  function touchUseChanged(lastState, nearStation, canAfford, isHolding, stationKind, action) {
    if (!lastState || typeof lastState !== 'object') return true;
    return lastState.nearStation !== nearStation ||
           lastState.canAfford !== canAfford ||
           lastState.isHolding !== isHolding ||
           lastState.stationKind !== stationKind ||
           lastState.action !== action;
  }
  function syncTouchUseState(lastState, nearStation, canAfford, isHolding, stationKind, action) {
    const target = lastState && typeof lastState === 'object' ? lastState : {};
    target.nearStation = nearStation;
    target.canAfford = canAfford;
    target.isHolding = isHolding;
    target.stationKind = stationKind;
    target.action = action;
    return target;
  }
  // Mobile touch stance/slide button state: returns 'sliding' during an active slide,
  // 'crouch' while crouching, 'sprint' when forward sprint momentum is ready to slide,
  // or '' during standard movement.
  function touchSlideState(sliding, crouching, isSprint) {
    if (sliding) return 'sliding';
    if (crouching) return 'crouch';
    if (isSprint) return 'sprint';
    return '';
  }
  // Mobile touch stance/slide button label: returns 'STAND' when crouched, or 'SLIDE' otherwise.
  function touchSlideLabel(sliding, crouching) {
    if (sliding) return 'SLIDE';
    if (crouching) return 'STAND';
    return 'SLIDE';
  }
  // Mobile touch plate button label: returns 'ARMOR' while inserting, 'PLT ' + count
  // when plates are available, or 'EMPTY' when inventory is 0.
  function touchPlateLabel(plates, inserting) {
    if (inserting) return 'ARMOR';
    if (typeof plates !== 'number' || !isFinite(plates) || plates <= 0) return 'EMPTY';
    return 'PLT ' + plates;
  }
  // Mobile touch tactical equipment button label: displays 'FLASH', 'STUN', 'SMOKE'
  // based on active ordnance key, 'EMPTY' when depleted, or 'TAC' fallback.
  function touchTacticalLabel(equippedKey, count) {
    if (typeof count !== 'number' || !isFinite(count) || count <= 0) return 'EMPTY';
    if (equippedKey === 'flash') return 'FLASH';
    if (equippedKey === 'stun') return 'STUN';
    if (equippedKey === 'smoke') return 'SMOKE';
    return 'TAC';
  }
  // Mobile touch lethal equipment button label: displays 'HOLD' while charging, 'FRAG',
  // 'SMTX', 'CLAY' based on active explosive key, 'EMPTY' when depleted, or 'NADE' fallback.
  function touchLethalLabel(equippedKey, count, isCharging) {
    if (isCharging) return 'HOLD';
    if (typeof count !== 'number' || !isFinite(count) || count <= 0) return 'EMPTY';
    if (equippedKey === 'semtex') return 'SMTX';
    if (equippedKey === 'claymore') return 'CLAY';
    if (equippedKey === 'frag') return 'FRAG';
    return 'NADE';
  }
  // Mobile touch scorestreak / field upgrade button label: displays 'UAV', 'AIR', 'TUR'
  // for active banked streaks, 'BOX' when munitions field upgrade is ready, a charge
  // percentage (e.g. '73%') when field is charging and no streak is banked, or 'STRK'
  // fallback. Optional third argument fieldChargePct (0–100) enables the progress label;
  // omitting it preserves the previous two-argument behaviour exactly.
  function touchStreakLabel(topStreakKey, fieldReady, fieldChargePct) {
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
    if (typeof fieldChargePct === 'number' && isFinite(fieldChargePct) && fieldChargePct >= 5) {
      return Math.min(99, Math.floor(fieldChargePct)) + '%';
    }
    return 'STRK';
  }
  // Mobile touch melee button state: returns 'cooldown' while melee swing recovers,
  // 'ready' when an enemy is within blade strike reach and cone, or '' when neutral.
  function touchMeleeState(hasTarget, cooldownRemaining) {
    const cd = typeof cooldownRemaining === 'number' && isFinite(cooldownRemaining) ? cooldownRemaining : 0;
    if (cd > 0) return 'cooldown';
    if (hasTarget) return 'ready';
    return '';
  }
  // Mobile touch melee button label: returns 'WAIT' during swing recovery,
  // 'STRIKE' when an enemy is within blade strike range, or 'KNIFE' default.
  function touchMeleeLabel(hasTarget, cooldownRemaining) {
    const cd = typeof cooldownRemaining === 'number' && isFinite(cooldownRemaining) ? cooldownRemaining : 0;
    if (cd > 0) return 'WAIT';
    if (hasTarget) return 'STRIKE';
    return 'KNIFE';
  }
  // Mobile touch ADS button state: returns 'steady' when sniper breath hold is engaged,
  // 'scoped' when optical scope is locked in (SR/BR >= threshold),
  // 'active' when aiming down sights, or '' at hip fire.
  // Backwards-compatible: behaves identically to previous versions when isSteadyActive is omitted/falsy.
  // Pure: no side effects, no DOM, no THREE.
  function touchAdsState(adsAmount, weaponType, scopeLockedThreshold, isSteadyActive) {
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? adsAmount : 0;
    const thr = typeof scopeLockedThreshold === 'number' && isFinite(scopeLockedThreshold) ? scopeLockedThreshold : 0.82;
    if (ads <= 0) return '';
    if ((weaponType === 'SR' || weaponType === 'BR') && ads >= thr) {
      return isSteadyActive ? 'steady' : 'scoped';
    }
    return 'active';
  }
  // Mobile touch ADS button contextual label: displays 'STEADY' while holding breath,
  // 'WAIT' when sniper breath is exhausted, 'SCOPE' when optical scope is engaged,
  // 'AIM' when aiming standard sights, or 'ADS' default.
  // Pure: no side effects, no DOM, no THREE.
  function touchAdsLabel(adsState, weaponType, steadyT) {
    if (adsState === 'steady') return 'STEADY';
    if (adsState === 'scoped') {
      if (typeof steadyT === 'number' && isFinite(steadyT) && steadyT <= 0) return 'WAIT';
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
    if (!lastState) return { adsState: adsState, adsLabel: adsLabel };
    lastState.adsState = adsState;
    lastState.adsLabel = adsLabel;
    return lastState;
  }
  // Mobile touch jump button state: returns 'locked' when downed or stunned,
  // 'mantle' during ledge mantle climbing, 'boost' during kinetic slide momentum,
  // 'airborne' when off the ground, or '' when grounded and jump-ready.
  // Backwards-compatible: single boolean onGround returns '' or 'airborne'.
  // Pure: no side effects, no DOM, no THREE.
  function touchJumpState(onGround, isSliding, isMantling, isDowned, isStunned) {
    if (isDowned || isStunned) return 'locked';
    if (isMantling) return 'mantle';
    if (isSliding) return 'boost';
    return onGround ? '' : 'airborne';
  }
  // Mobile touch jump button contextual label: displays 'LOCK' when disabled,
  // 'CLIMB' when mantling, 'BOOST' during kinetic slide, 'AIR' when airborne,
  // 'STAND' when crouched, or 'JUMP' default.
  // Pure: no side effects, no DOM, no THREE.
  function touchJumpLabel(jumpState, isCrouching) {
    if (jumpState === 'locked') return 'LOCK';
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
    if (!lastState) return { jumpState: jumpState, jumpLabel: jumpLabel };
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
    if (!lastState) return { slideState: slideState, slideLabel: slideLabel };
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
    if (!lastState) return { meleeState: meleeState, meleeLabel: meleeLabel };
    lastState.meleeState = meleeState;
    lastState.meleeLabel = meleeLabel;
    return lastState;
  }
  // Evaluates whether a mobile touch player has engaged sniper steady-aim by holding
  // ADS while stationary in marksman scope.
  // Pure: no side effects, no DOM, no THREE.
  function isMobileSteadyAim(isAdsTouch, adsAmount, weaponType, moveX, moveZ) {
    if (!isAdsTouch || weaponType !== 'SR') return false;
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? adsAmount : 0;
    if (ads < ADS_SCOPE_THRESHOLD) return false;
    const mx = typeof moveX === 'number' && isFinite(moveX) ? Math.abs(moveX) : 0;
    const mz = typeof moveZ === 'number' && isFinite(moveZ) ? Math.abs(moveZ) : 0;
    return mx < 0.05 && mz < 0.05;
  }
  // Mobile touch fire button feedback state: returns 'reloading' during reload cycle,
  // 'empty' when all ammo is completely exhausted (ammo <= 0 and reserve <= 0),
  // 'dry' when magazine is empty but reserve is available (ammo <= 0 and reserve > 0),
  // or 'ready' when ammunition is chambered and weapon can fire.
  // Pure: no side effects, no DOM, no THREE.
  function touchFireState(ammo, reserve, reloading) {
    if (reloading) return 'reloading';
    const a = typeof ammo === 'number' && isFinite(ammo) ? ammo : 0;
    const r = typeof reserve === 'number' && isFinite(reserve) ? reserve : 0;
    if (a <= 0 && r <= 0) return 'empty';
    if (a <= 0 && r > 0) return 'dry';
    return 'ready';
  }
  // Mobile touch fire button contextual label: returns 'RELOAD' when reloading or dry,
  // 'EMPTY' when all ammo is exhausted, or 'ADS+FIRE' / 'FIRE' when ready.
  // Pure: no side effects, no DOM, no THREE.
  function touchFireLabel(ammo, reserve, reloading, isAdsFire) {
    if (reloading) return 'RELOAD';
    const a = typeof ammo === 'number' && isFinite(ammo) ? ammo : 0;
    const r = typeof reserve === 'number' && isFinite(reserve) ? reserve : 0;
    if (a <= 0 && r <= 0) return 'EMPTY';
    if (a <= 0 && r > 0) return 'RELOAD';
    return isAdsFire ? 'ADS+FIRE' : 'FIRE';
  }
  // Mobile touch reload button contextual label: returns 'WAIT' during reload cycle,
  // 'RELOAD' when urgent reload is required (ammo <= 0 and reserve > 0),
  // 'EMPTY' when all ammo is exhausted, or 'RLD' standard default.
  // Pure: no side effects, no DOM, no THREE.
  function touchReloadLabel(ammo, reserve, reloading) {
    if (reloading) return 'WAIT';
    const a = typeof ammo === 'number' && isFinite(ammo) ? ammo : 0;
    const r = typeof reserve === 'number' && isFinite(reserve) ? reserve : 0;
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
    if (typeof size === 'number' && isFinite(size) && size > 0) {
      return name + ' (' + Math.round(size) + 'px)';
    }
    return name;
  }

  // Clamps mobile touch layout editor positioning coordinates to viewport boundaries [0, maxPct].
  // Pure: no side effects, no DOM, no THREE.
  function touchLayoutClampPercent(clientCoord, elementDim, viewportSpan) {
    const span = typeof viewportSpan === 'number' && viewportSpan > 0 ? viewportSpan : 1;
    const dim = typeof elementDim === 'number' && isFinite(elementDim) ? elementDim : 0;
    const coord = typeof clientCoord === 'number' && isFinite(clientCoord) ? clientCoord : 0;
    const maxPct = Math.max(0, 100 - (dim / span * 100));
    const targetPct = (coord - dim / 2) / span * 100;
    return Math.max(0, Math.min(maxPct, targetPct));
  }

  // Change-detection for mobile touch fire button to prevent redundant DOM updates.
  function touchFireChanged(lastState, fireState, fireLabel) {
    if (!lastState) return true;
    return lastState.fireState !== fireState || lastState.fireLabel !== fireLabel;
  }
  // In-place cache synchronizer for mobile touch fire button state.
  function syncTouchFireState(lastState, fireState, fireLabel) {
    if (!lastState) return { fireState: fireState, fireLabel: fireLabel };
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
    if (!lastState) return { reloadState: reloadState, reloadLabel: reloadLabel };
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
    if (!lastState) return { plateState: plateState, plateLabel: plateLabel };
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
    if (!lastState) return { eqState: eqState, eqLabel: eqLabel };
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
    if (!lastState) return { streakState: streakState, streakLabel: streakLabel };
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
    if (!lastState) return { swapState: swapState, swapLabel: swapLabel };
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
  const PLATE_MAX = 3;
  const PLATE_PRICE = 250;
  const PLATE_TIME = 1.1;
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
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > range || d < 1e-6) return false;
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
  function enemyMeleeDamage(baseDmg, isTank, wave, diffMul, isElite) {
    const base = typeof baseDmg === 'number' && isFinite(baseDmg) && baseDmg > 0 ? baseDmg : 18;
    const tankBonus = isTank ? 10 : 0;
    const w = typeof wave === 'number' && isFinite(wave) && wave > 0 ? wave : 1;
    const diff = typeof diffMul === 'number' && isFinite(diffMul) && diffMul > 0 ? diffMul : 1;
    const elite = isElite ? ELITE.dmgMul : 1;
    return (base + tankBonus + w * 0.4) * diff * elite;
  }

  function enemyRangedDamage(baseDmg, wave, diffMul, isElite) {
    const base = typeof baseDmg === 'number' && isFinite(baseDmg) && baseDmg > 0 ? baseDmg : 8;
    const w = typeof wave === 'number' && isFinite(wave) && wave > 0 ? wave : 1;
    const diff = typeof diffMul === 'number' && isFinite(diffMul) && diffMul > 0 ? diffMul : 1;
    const elite = isElite ? ELITE.dmgMul : 1;
    return (base + w * 0.35) * diff * elite;
  }

  // Archetype base health scaling multipliers relative to CFG.ai.maxHealth.
  // Standardizes kind 2 (Tank) from a hardcoded 320 to 3.2x base health.
  const ENEMY_HEALTH_SCALE = {
    0: 1.0,   // runner
    1: 1.35,  // rifleman
    2: 3.2,   // tank
    3: 2.2,   // shielded advancer
    4: 0.55,  // scout
    5: 1.2    // grenadier
  };

  const SHIELD_ARC_COS = 0.5;          // Math.cos(Math.PI / 3) = 0.5 (60 degrees either side of facing)
  const SHIELD_ABSORB_RATIO = 0.85;    // 85% absorbed head-on (0.15 damage multiplier)

  function enemyBaseHealth(kind, baseMaxHealth) {
    const base = typeof baseMaxHealth === 'number' && isFinite(baseMaxHealth) && baseMaxHealth > 0 ? baseMaxHealth : 100;
    const mul = ENEMY_HEALTH_SCALE[kind] !== undefined ? ENEMY_HEALTH_SCALE[kind] : 1.0;
    return Math.round(base * mul);
  }

  function enemyMaxHealth(kind, baseMaxHealth, wave, victoryWave, diffHp, specialHp, isElite) {
    const baseHp = enemyBaseHealth(kind, baseMaxHealth);
    const curWave = typeof wave === 'number' && isFinite(wave) && wave > 0 ? wave : 1;
    const vWave = typeof victoryWave === 'number' && isFinite(victoryWave) ? victoryWave : 15;
    const waveMul = endlessHpMultiplier(curWave, vWave);
    const dHp = typeof diffHp === 'number' && isFinite(diffHp) && diffHp > 0 ? diffHp : 1.0;
    const sHp = typeof specialHp === 'number' && isFinite(specialHp) && specialHp > 0 ? specialHp : 1.0;
    const eliteMul = isElite ? ELITE.hpMul : 1.0;
    return Math.max(1, Math.round(baseHp * waveMul * dHp * sHp * eliteMul));
  }

  function enemyAccuracy(baseAcc, accPerWave, wave, maxAcc, accBonus) {
    const base = typeof baseAcc === 'number' && isFinite(baseAcc) ? baseAcc : 0.5;
    const perWave = typeof accPerWave === 'number' && isFinite(accPerWave) ? accPerWave : 0.035;
    const w = typeof wave === 'number' && isFinite(wave) && wave > 0 ? wave : 1;
    const cap = typeof maxAcc === 'number' && isFinite(maxAcc) ? maxAcc : 0.75;
    const bonus = typeof accBonus === 'number' && isFinite(accBonus) ? accBonus : 0;
    const raw = base + w * perWave + bonus;
    return Math.max(0, Math.min(cap + bonus, raw));
  }

  function playerBulletDamage(baseDmg, isHead, headshotMul, dist, range, penMul) {
    const base = typeof baseDmg === 'number' && isFinite(baseDmg) && baseDmg > 0 ? baseDmg : 20;
    const hs = isHead ? (typeof headshotMul === 'number' && isFinite(headshotMul) && headshotMul > 0 ? headshotMul : 1.8) : 1.0;
    const d = typeof dist === 'number' && isFinite(dist) && dist >= 0 ? dist : 0;
    const r = typeof range === 'number' && isFinite(range) && range > 0 ? range : 100;
    const falloff = distanceFalloff(d, r);
    const pen = typeof penMul === 'number' && isFinite(penMul) && penMul >= 0 ? penMul : 1.0;
    return base * hs * falloff * pen;
  }

  function shieldMultiplier(kind, enX, enZ, enYaw, hitX, hitZ) {
    if (kind !== 3 || hitX === undefined || hitZ === undefined ||
        !isFinite(hitX) || !isFinite(hitZ) || !isFinite(enX) || !isFinite(enZ) || !isFinite(enYaw)) return 1.0;
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
    if (typeof shieldMul === 'number' && isFinite(shieldMul) && shieldMul < 1.0) return 'block';
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
    return { scale: scale, color: color, duration: duration, tier: t };
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
    if (typeof kind !== 'number' || !isFinite(kind)) return 0.85;
    return ENEMY_SEPARATION_RADIUS[kind] !== undefined ? ENEMY_SEPARATION_RADIUS[kind] : 0.85;
  }

  // Pure separation displacement resolution between two cylindrical agent footprints.
  // Performs fast early-axis boundary rejection before evaluating quadratic distance.
  // Writes push displacement vectors to reusable `out` without heap allocations.
  function resolveSeparationPush(ax, az, ar, bx, bz, br, out) {
    const radA = (typeof ar === 'number' && isFinite(ar) && ar > 0) ? ar : 0.85;
    const radB = (typeof br === 'number' && isFinite(br) && br > 0) ? br : 0.85;
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
    const win = (typeof windowSec === 'number' && isFinite(windowSec) && windowSec > 0) ? windowSec : MELEE_CAP_WINDOW;
    let write = 0;
    for (let i = 0; i < hits.length; i++) {
      if (typeof hits[i] === 'number' && isFinite(hits[i]) && (now - hits[i]) < win) {
        if (write !== i) hits[write] = hits[i];
        write++;
      }
    }
    hits.length = write;
    return write;
  }

  function canRegisterHit(hits, now, windowSec, maxHits) {
    const active = pruneHitTimestamps(hits, now, windowSec);
    const limit = (typeof maxHits === 'number' && isFinite(maxHits) && maxHits > 0) ? maxHits : MELEE_CAP_MAX_HITS;
    return active < limit;
  }

  // Snaps world coordinates to shadow texel boundaries to prevent shadow shimmering
  // and throttle redundant directional light matrix updates when standing still.
  function snapToTexel(coord, texelSize) {
    if (typeof coord !== 'number' || !isFinite(coord)) return 0;
    if (typeof texelSize !== 'number' || !isFinite(texelSize) || texelSize <= 0) return coord;
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
  function spawnPointSealed(x, z, openKeys) {
    for (let i = 0; i < DISTRICTS.length; i++) {
      const d = DISTRICTS[i];
      if (openKeys && openKeys.indexOf(d.key) >= 0) continue;
      if (insideDistrict(d, x, z)) return true;
    }
    return false;
  }
  // At least one spawn point must always survive the filter, or a wave can never
  // start. Callers pass the ring; this is the assertion that it is still usable.
  function usableSpawnPoints(points, openKeys) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (!spawnPointSealed(points[i][0], points[i][1], openKeys)) out.push(points[i]);
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
      links.push({ a: a, b: b, rest: dist3(a, b), k: L[2] });
    }
    return { nodes: nodes, order: order, links: links, settled: false, t: 0 };
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
  const FALL_SAFE_SPEED = 9.5;      // m/s: about a 4.6 m drop, survivable
  const FALL_LETHAL_SPEED = 22;     // terminal for these purposes
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
    if (typeof out.mag === 'number') out.mag = Math.max(1, Math.round(out.mag));
    if (typeof out.reserveMax === 'number') out.reserveMax = Math.max(0, Math.round(out.reserveMax));
    out.attachments = keys.slice();
    return out;
  }
  // What the gunsmith screen shows under a candidate attachment: the fields it moves
  // and which way, so a trade-off is legible before it is chosen.
  function attachmentDelta(a) {
    const up = [], down = [];
    if (!a) return { up: up, down: down };
    // Lower is better for these, so the arrow has to be flipped.
    const lowerIsBetter = { spread: 1, adsSpread: 1, recoilV: 1, recoilH: 1, reload: 1, sway: 1 };
    for (const field in a.mods) {
      const mul = a.mods[field];
      if (mul === 1) continue;
      const better = lowerIsBetter[field] ? mul < 1 : mul > 1;
      const pct = Math.round(Math.abs(mul - 1) * 100);
      (better ? up : down).push({ field: field, pct: pct });
    }
    return { up: up, down: down };
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
  const OBJECTIVE_HOLD = 25;        // seconds of occupancy to complete
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
    if (typeof dist !== 'number' || !isFinite(dist) || dist < 0) return 0;
    if (typeof radius !== 'number' || !isFinite(radius) || radius <= 0) return 0;
    if (dist >= radius) return 0;
    const base = typeof baseDmg === 'number' && isFinite(baseDmg) ? baseDmg : 120;
    const sc = typeof scale === 'number' && isFinite(scale) ? scale : 1;
    const falloff = 1 - dist / radius;
    return base * (GRENADE_DAMAGE_FLOOR + (1 - GRENADE_DAMAGE_FLOOR) * falloff) * sc;
  }

  function grenadeSelfDamage(dist, radius, maxDmg) {
    if (typeof dist !== 'number' || !isFinite(dist) || dist < 0) return 0;
    if (typeof radius !== 'number' || !isFinite(radius) || radius <= 0) return 0;
    const dangerRadius = radius * GRENADE_SELF_RADIUS_RATIO;
    if (dist >= dangerRadius) return 0;
    const maxVal = typeof maxDmg === 'number' && isFinite(maxDmg) ? maxDmg : GRENADE_SELF_DAMAGE_MAX;
    const falloff = 1 - dist / dangerRadius;
    return Math.round(maxVal * falloff);
  }

  function grenadeChargedSpeed(chargeT, minSpeed, maxSpeed, rampDuration) {
    const t = typeof chargeT === 'number' && isFinite(chargeT) ? Math.max(0, chargeT) : 0;
    const minS = typeof minSpeed === 'number' && isFinite(minSpeed) ? minSpeed : GRENADE_MIN_SPEED;
    const maxS = typeof maxSpeed === 'number' && isFinite(maxSpeed) ? maxSpeed : GRENADE_MAX_SPEED;
    const ramp = typeof rampDuration === 'number' && isFinite(rampDuration) && rampDuration > 0 ? rampDuration : GRENADE_RAMP_DURATION;
    const ratio = Math.min(1, t / ramp);
    return minS + ratio * (maxS - minS);
  }

  function grenadeThrowSpeed(chargeT, tapDefaultSpeed, minSpeed, maxSpeed, rampDuration, tapThreshold) {
    const t = typeof chargeT === 'number' && isFinite(chargeT) ? Math.max(0, chargeT) : 0;
    const th = typeof tapThreshold === 'number' && isFinite(tapThreshold) ? tapThreshold : GRENADE_TAP_THRESHOLD;
    const tapSpd = typeof tapDefaultSpeed === 'number' && isFinite(tapDefaultSpeed) ? tapDefaultSpeed : 9.5;
    if (t <= th) return tapSpd;
    return grenadeChargedSpeed(t, minSpeed, maxSpeed, rampDuration);
  }

  // ---- Enemy melee attack reach and cadence balance ----
  function canEnemyMelee(kind) {
    return kind === 0 || kind === 2 || kind === 3 || kind === 4;
  }

  function enemyMeleeReach(kind, baseAttackRange) {
    const base = typeof baseAttackRange === 'number' && isFinite(baseAttackRange) ? baseAttackRange : 2.1;
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
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) return 0;
    const b = typeof baseAlpha === 'number' && isFinite(baseAlpha) ? baseAlpha : VIGNETTE_BASE_ALPHA;
    const m = typeof maxAlpha === 'number' && isFinite(maxAlpha) ? maxAlpha : VIGNETTE_MAX_ALPHA;
    const d = typeof divisor === 'number' && isFinite(divisor) && divisor > 0 ? divisor : VIGNETTE_SCALE_DIVISOR;
    return Math.min(m, b + amount / d);
  }

  function damageVignetteStyle(alpha, isArmorOnly) {
    if (typeof alpha !== 'number' || !isFinite(alpha) || alpha <= 0) {
      return 'inset 0 0 120px 40px rgba(180,0,0,0)';
    }
    const color = isArmorOnly ? 'rgba(79,163,216,' : 'rgba(180,0,0,';
    return 'inset 0 0 120px 40px ' + color + alpha.toFixed(3) + ')';
  }

  function worldBearing(fromX, fromZ, toX, toZ) {
    if (typeof fromX !== 'number' || !isFinite(fromX) ||
        typeof fromZ !== 'number' || !isFinite(fromZ) ||
        typeof toX !== 'number' || !isFinite(toX) ||
        typeof toZ !== 'number' || !isFinite(toZ)) return 0;
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    if (dx === 0 && dz === 0) return 0;
    return (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
  }

  function screenHitAngle(worldBearingDeg, playerYawRad) {
    if (typeof worldBearingDeg !== 'number' || !isFinite(worldBearingDeg) ||
        typeof playerYawRad !== 'number' || !isFinite(playerYawRad)) return 0;
    // Bearing where 0 = +z. Player forward = yaw.
    // Screen angle: 0 = attacker straight ahead, 90 = right, 180 = behind, 270 = left.
    const rel = ((worldBearingDeg - (playerYawRad * 180 / Math.PI)) % 360 + 360) % 360;
    return ((180 - rel) % 360 + 360) % 360;
  }

  function hitArcOpacity(age, life, fadeStartRatio, maxOpacity) {
    const l = typeof life === 'number' && isFinite(life) && life > 0 ? life : HIT_ARC_LIFE;
    const f = typeof fadeStartRatio === 'number' && isFinite(fadeStartRatio) ? fadeStartRatio : HIT_ARC_FADE_START;
    const maxOp = typeof maxOpacity === 'number' && isFinite(maxOpacity) ? maxOpacity : HIT_ARC_MAX_OPACITY;
    if (typeof age !== 'number' || !isFinite(age) || age < 0 || age >= l) return 0;
    const fadeT = l * f;
    if (age <= fadeT) return maxOp;
    const dur = l - fadeT;
    if (dur <= 0) return 0;
    return Math.max(0, maxOp * (1 - (age - fadeT) / dur));
  }

  // ---- Particle physics integration and change-driven HUD performance rules ----
  function stepParticlePhysics(x, y, z, vx, vy, vz, grav, dt, minY, out) {
    const target = out || { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };
    const stepDt = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    const g = typeof grav === 'number' && isFinite(grav) ? grav : 9.8;
    const floor = typeof minY === 'number' && isFinite(minY) ? minY : 0.02;
    const curVx = typeof vx === 'number' && isFinite(vx) ? vx : 0;
    const curVy = typeof vy === 'number' && isFinite(vy) ? vy : 0;
    const curVz = typeof vz === 'number' && isFinite(vz) ? vz : 0;
    const curX = typeof x === 'number' && isFinite(x) ? x : 0;
    const curY = typeof y === 'number' && isFinite(y) ? y : 0;
    const curZ = typeof z === 'number' && isFinite(z) ? z : 0;

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
    const target = lastState && typeof lastState === 'object' ? lastState : {};
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
    const target = lastState && typeof lastState === 'object' ? lastState : {};
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
    const dur = typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : SLIDE_DURATION;
    const t = typeof slideT === 'number' && isFinite(slideT) ? Math.max(0, Math.min(1, slideT / dur)) : 0;
    const sm = typeof startMul === 'number' && isFinite(startMul) ? startMul : SLIDE_START_MUL;
    const em = typeof endMul === 'number' && isFinite(endMul) ? endMul : SLIDE_END_MUL;
    const sprintSpd = typeof baseSprintSpeed === 'number' && isFinite(baseSprintSpeed) ? baseSprintSpeed : 8.1;
    const crouchSpd = typeof baseCrouchSpeed === 'number' && isFinite(baseCrouchSpeed) ? baseCrouchSpeed : (sprintSpd * (em / sm));
    const startSpd = sprintSpd * sm;
    const endSpd = crouchSpd;
    return startSpd + (endSpd - startSpd) * t;
  }

  function slideJumpBoost(horizontalSpeed, maxSprintSpeed, maxBoost, scale) {
    const spd = typeof horizontalSpeed === 'number' && isFinite(horizontalSpeed) ? Math.max(0, horizontalSpeed) : 0;
    const sprint = typeof maxSprintSpeed === 'number' && isFinite(maxSprintSpeed) && maxSprintSpeed > 0 ? maxSprintSpeed : 8.1;
    const mb = typeof maxBoost === 'number' && isFinite(maxBoost) ? maxBoost : SLIDE_BOOST_MAX;
    const sc = typeof scale === 'number' && isFinite(scale) ? scale : SLIDE_BOOST_SCALE;
    return Math.min(mb, 1 + (spd / sprint) * sc);
  }

  const STAMINA_RECOVER_RATE = 0.7;
  const STAMINA_EXHAUST_RECOVER_RATIO = 0.35;

  function stepPlayerStamina(stamina, maxStamina, isSprinting, isTacSprint, dt, drainRate, tacDrainMul, recoverRate) {
    const s = typeof stamina === 'number' && isFinite(stamina) ? stamina : 0;
    const max = typeof maxStamina === 'number' && isFinite(maxStamina) && maxStamina > 0 ? maxStamina : 5;
    const d = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    if (isSprinting) {
      const drain = typeof drainRate === 'number' && isFinite(drainRate) && drainRate > 0 ? drainRate : 1;
      const tacMul = typeof tacDrainMul === 'number' && isFinite(tacDrainMul) && tacDrainMul > 0 ? tacDrainMul : 2.2;
      const burn = d * (isTacSprint ? tacMul : drain);
      return Math.max(0, s - burn);
    }
    const rec = typeof recoverRate === 'number' && isFinite(recoverRate) && recoverRate > 0 ? recoverRate : STAMINA_RECOVER_RATE;
    return Math.min(max, s + d * rec);
  }

  function isPlayerExhausted(stamina, wasExhausted, maxStamina, recoverRatio) {
    const s = typeof stamina === 'number' && isFinite(stamina) ? stamina : 0;
    if (s <= 0) return true;
    if (!wasExhausted) return false;
    const max = typeof maxStamina === 'number' && isFinite(maxStamina) && maxStamina > 0 ? maxStamina : 5;
    const ratio = typeof recoverRatio === 'number' && isFinite(recoverRatio) && recoverRatio >= 0 ? recoverRatio : STAMINA_EXHAUST_RECOVER_RATIO;
    return s <= max * ratio;
  }

  function canRegenHealth(downed, timeSinceDamage, regenDelay, health, maxHealth) {
    if (downed) return false;
    const since = typeof timeSinceDamage === 'number' && isFinite(timeSinceDamage) ? timeSinceDamage : -1;
    const delay = typeof regenDelay === 'number' && isFinite(regenDelay) ? regenDelay : 4.0;
    if (since <= delay) return false;
    const hp = typeof health === 'number' && isFinite(health) ? health : 0;
    const max = typeof maxHealth === 'number' && isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 100;
    return hp < max && hp > 0;
  }

  function stepHealthRegen(currentHealth, maxHealth, regenRate, diffRegenMul, dt) {
    const hp = typeof currentHealth === 'number' && isFinite(currentHealth) ? currentHealth : 0;
    const max = typeof maxHealth === 'number' && isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 100;
    const rate = typeof regenRate === 'number' && isFinite(regenRate) && regenRate > 0 ? regenRate : 20;
    const diffMul = typeof diffRegenMul === 'number' && isFinite(diffRegenMul) && diffRegenMul > 0 ? diffRegenMul : 1;
    const d = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    return Math.min(max, hp + rate * diffMul * d);
  }

  const AMMO_PICKUP_MAG_RATIO = 1.5;
  const MEDKIT_HEAL_BASE = 35;
  const MEDKIT_ARMOR_BASE = 15;

  function ammoPickupRestore(currentReserve, reserveMax, magSize, perkMul) {
    const res = typeof currentReserve === 'number' && isFinite(currentReserve) ? Math.max(0, currentReserve) : 0;
    const max = typeof reserveMax === 'number' && isFinite(reserveMax) && reserveMax > 0 ? reserveMax : 120;
    const mag = typeof magSize === 'number' && isFinite(magSize) && magSize > 0 ? magSize : 30;
    const mul = typeof perkMul === 'number' && isFinite(perkMul) && perkMul > 0 ? perkMul : 1;
    const gained = Math.round(mag * AMMO_PICKUP_MAG_RATIO * mul);
    return Math.min(max, res + gained);
  }

  function medkitPickupRestore(currentHealth, maxHealth, currentArmor, maxArmor, perkMul, out) {
    const o = out || { health: 0, armor: 0 };
    const hp = typeof currentHealth === 'number' && isFinite(currentHealth) ? Math.max(0, currentHealth) : 0;
    const maxHp = typeof maxHealth === 'number' && isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 100;
    const arm = typeof currentArmor === 'number' && isFinite(currentArmor) ? Math.max(0, currentArmor) : 0;
    const maxArm = typeof maxArmor === 'number' && isFinite(maxArmor) && maxArmor > 0 ? maxArmor : 50;
    const mul = typeof perkMul === 'number' && isFinite(perkMul) && perkMul > 0 ? perkMul : 1;
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
    const hFloor = typeof minHeight === 'number' && isFinite(minHeight) ? minHeight : 0.6;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c || !c.min || !c.max) continue;
      if (typeof c.max.y !== 'number' || c.max.y < hFloor) continue;
      const minX = c.min.x, minZ = c.min.z;
      const maxX = c.max.x, maxZ = c.max.z;
      if (!isFinite(minX) || !isFinite(minZ) || !isFinite(maxX) || !isFinite(maxZ)) continue;
      out.push({
        minX: minX,
        minZ: minZ,
        w: maxX - minX,
        d: maxZ - minZ
      });
    }
    return out;
  }

  function isMinimapBlockVisible(minX, minZ, w, d, px, pz, scale, maxDistSq) {
    if (!isFinite(minX) || !isFinite(minZ) || !isFinite(px) || !isFinite(pz) || !isFinite(scale)) return false;
    const x = (minX - px) * scale, z = (minZ - pz) * scale;
    const limit = (typeof maxDistSq === 'number' && isFinite(maxDistSq)) ? maxDistSq : Infinity;
    return (x * x + z * z) <= limit;
  }

  function compassHeading(yawRad) {
    if (typeof yawRad !== 'number' || !isFinite(yawRad)) return 0;
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
    if (typeof deg !== 'number' || !isFinite(deg)) return null;
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
    if (out && typeof out === 'object') {
      out.aliveCount = aliveCount;
      out.nearestEnemy = nearest;
      return out;
    }
    return { aliveCount: aliveCount, nearestEnemy: nearest };
  }

  // ---- Sniper Marksman Sway, Steady Aim, Recoil Recovery, and Aim Assist Balance ----
  const STEADY_MAX = 2.2;
  const STEADY_RECOVER = 2.2;
  const ADS_SCOPE_THRESHOLD = 0.8;
  const SCOPE_LOCKED_THRESHOLD = 0.82;
  const RECOIL_DECAY_RATE = 0.02;

  function isSteadyActive(weaponType, adsAmount, isHoldingShift, steadyT) {
    if (weaponType !== 'SR') return false;
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? adsAmount : 0;
    const t = typeof steadyT === 'number' && isFinite(steadyT) ? steadyT : 0;
    return ads > ADS_SCOPE_THRESHOLD && Boolean(isHoldingShift) && t > 0;
  }

  function stepSteadyAim(steadyT, steadyActive, dt, maxTime, recoverRate) {
    const t = typeof steadyT === 'number' && isFinite(steadyT) ? steadyT : 0;
    const d = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    const max = typeof maxTime === 'number' && isFinite(maxTime) && maxTime > 0 ? maxTime : STEADY_MAX;
    const rec = typeof recoverRate === 'number' && isFinite(recoverRate) && recoverRate > 0 ? recoverRate : STEADY_RECOVER;
    if (steadyActive) {
      return Math.max(0, t - d);
    }
    return Math.min(max, t + d * rec);
  }

  function swayAmplitude(baseAmp, steadyActive, steadyMul, weaponSwayMul) {
    const base = typeof baseAmp === 'number' && isFinite(baseAmp) ? baseAmp : 0.0042;
    const sm = steadyActive ? (typeof steadyMul === 'number' && isFinite(steadyMul) ? steadyMul : 0.14) : 1.0;
    const wSway = typeof weaponSwayMul === 'number' && isFinite(weaponSwayMul) && weaponSwayMul > 0 ? weaponSwayMul : 1.0;
    return base * sm * wSway;
  }

  function swayOffsets(phase, amp, out) {
    const p = typeof phase === 'number' && isFinite(phase) ? phase : 0;
    const a = typeof amp === 'number' && isFinite(amp) ? amp : 0;
    const x = Math.sin(p * 1.7) * a + Math.sin(p * 0.9) * a * 0.6;
    const y = Math.sin(p * 1.3 + 1.2) * a * 0.8;
    if (out && typeof out === 'object') {
      out.x = x;
      out.y = y;
      return out;
    }
    return { x: x, y: y };
  }

  function isScoped(adsAmount, weaponType) {
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? adsAmount : 0;
    return ads > SCOPE_LOCKED_THRESHOLD && weaponType === 'SR';
  }

  function recoilDecay(recoilVal, dt, baseDecayRate) {
    const val = typeof recoilVal === 'number' && isFinite(recoilVal) ? recoilVal : 0;
    const d = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    const rate = typeof baseDecayRate === 'number' && isFinite(baseDecayRate) && baseDecayRate > 0 ? baseDecayRate : RECOIL_DECAY_RATE;
    return val * Math.pow(rate, d);
  }

  function aimAssistAngle(baseAngle, isSteady, steadyBonusMul) {
    const base = typeof baseAngle === 'number' && isFinite(baseAngle) ? baseAngle : 0.14;
    const bonus = typeof steadyBonusMul === 'number' && isFinite(steadyBonusMul) ? steadyBonusMul : 1.6;
    return base * (isSteady ? bonus : 1.0);
  }

  function aimAssistPull(baseStrength, pullRatio) {
    const base = typeof baseStrength === 'number' && isFinite(baseStrength) ? baseStrength : 2.2;
    const ratio = typeof pullRatio === 'number' && isFinite(pullRatio) ? pullRatio : 0.25;
    return Math.min(1.0, base * ratio);
  }

  const CROSSHAIR_MIN_GAP_OFFSET = 0;
  const CROSSHAIR_MAX_GAP_OFFSET = 24;

  function crosshairGapOffset(spread, adsAmount, isReducedMotion) {
    if (isReducedMotion) return 0;
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    if (ads > 0) {
      return -Math.round(ads * 6);
    }
    const s = typeof spread === 'number' && isFinite(spread) ? Math.max(0, spread) : 0;
    const offset = Math.round((s - 0.010) * 220);
    return Math.max(CROSSHAIR_MIN_GAP_OFFSET, Math.min(CROSSHAIR_MAX_GAP_OFFSET, offset));
  }

  function crosshairOpacity(adsAmount, isScopedWeapon, isDead) {
    if (isDead) return 0;
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    if (isScopedWeapon) {
      if (ads >= 0.75) return 0;
      if (ads <= 0.30) return 1;
      return Math.max(0, Math.min(1, 1 - (ads - 0.30) / 0.45));
    }
    if (ads >= 0.70) return 0;
    return Math.max(0, Math.min(1, 1 - ads / 0.70));
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
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? adsAmount : 0;
    if (ads > 0.5) return 0;
    if (isSliding) return SLIDE_FOV_BOOST;
    if (isTacSprint) return TAC_SPRINT_FOV_BOOST;
    return 0;
  }

  function targetCameraFov(baseSettingFov, adsAmount, weaponZoom, mobilityBoost) {
    const fov = typeof baseSettingFov === 'number' && isFinite(baseSettingFov) ? baseSettingFov : 75;
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    const zoom = typeof weaponZoom === 'number' && isFinite(weaponZoom) ? weaponZoom : DEFAULT_ADS_ZOOM;
    const boost = typeof mobilityBoost === 'number' && isFinite(mobilityBoost) ? mobilityBoost : 0;
    const target = fov - ads * zoom + boost;
    return Math.max(CAMERA_MIN_FOV, Math.min(CAMERA_MAX_FOV, target));
  }

  function strafeDirection(keyA, keyD, analogX) {
    if (typeof analogX === 'number' && isFinite(analogX) && Math.abs(analogX) > 0.15) {
      return analogX < 0 ? -1 : 1;
    }
    const a = !!keyA, d = !!keyD;
    if (a && !d) return -1;
    if (d && !a) return 1;
    return 0;
  }

  function cameraRoll(bobPhase, bobAmp, slideBlend, strafeDir, isReducedMotion, swayX, isScoped) {
    const motionMul = isReducedMotion ? 0 : 1;
    const phase = typeof bobPhase === 'number' && isFinite(bobPhase) ? bobPhase : 0;
    const amp = typeof bobAmp === 'number' && isFinite(bobAmp) ? bobAmp : 0;
    const slide = typeof slideBlend === 'number' && isFinite(slideBlend) ? Math.max(0, Math.min(1, slideBlend)) : 0;
    const strafe = typeof strafeDir === 'number' && isFinite(strafeDir) ? Math.max(-1, Math.min(1, strafeDir)) : 0;
    const bobRoll = Math.sin(phase) * amp * CAMERA_BOB_ROLL_SCALE;
    const slideRoll = slide * CAMERA_SLIDE_ROLL;
    const strafeRoll = strafe * CAMERA_STRAFE_ROLL_SCALE;
    const motionRoll = (bobRoll + slideRoll + strafeRoll) * motionMul;
    const sx = typeof swayX === 'number' && isFinite(swayX) ? swayX : 0;
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
    const phase = typeof bobPhase === 'number' && isFinite(bobPhase) ? bobPhase : 0;
    const amp = typeof bobAmp === 'number' && isFinite(bobAmp) ? bobAmp : 0;
    const slide = typeof slideBlend === 'number' && isFinite(slideBlend) ? Math.max(0, Math.min(1, slideBlend)) : 0;
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
  const SNIPER_UNSCOPE_FACTOR = 0.45;
  const SHOT_KICK_IMPULSE = 0.5;
  const SHOT_KICK_MAX = 1.4;
  const SHOT_KICK_DECAY_BASE = 0.001;

  function playerMoveSpeed(baseSpeed, analogMag, isSprinting, isTacSprint, isDowned, isLandStun, isCrouching, isAds, sprintMul, crouchMul, weaponMoveMul) {
    const base = typeof baseSpeed === 'number' && isFinite(baseSpeed) ? Math.max(0, baseSpeed) : 5.4;
    const mag = typeof analogMag === 'number' && isFinite(analogMag) ? Math.max(0, Math.min(1, analogMag)) : 1;
    let spd = base * mag;
    const sMul = typeof sprintMul === 'number' && isFinite(sprintMul) ? sprintMul : 1.65;
    const cMul = typeof crouchMul === 'number' && isFinite(crouchMul) ? crouchMul : 0.55;
    const wMul = typeof weaponMoveMul === 'number' && isFinite(weaponMoveMul) ? Math.max(0.1, weaponMoveMul) : 1;

    if (isSprinting) spd *= sMul * (isTacSprint ? TAC_SPRINT_SPEED_MUL : 1);
    if (isDowned) spd *= DOWN_SPEED_MUL;
    if (isLandStun) spd *= LAND_STUN_SPEED_MUL;
    if (isCrouching) spd *= cMul;
    if (isAds) spd *= ADS_MOVE_SPEED_MUL * wMul;
    return Math.max(0, spd);
  }

  function movementAccelRate(onGround, isSliding, hasInput, groundAccel, groundDecel) {
    if (!onGround) return isSliding ? AIR_SLIDE_ACCEL_RATE : AIR_MOVE_ACCEL_RATE;
    const accel = typeof groundAccel === 'number' && isFinite(groundAccel) ? groundAccel : 16;
    const decel = typeof groundDecel === 'number' && isFinite(groundDecel) ? groundDecel : GROUND_DECEL_DEFAULT;
    return hasInput ? accel : decel;
  }

  function stepHorizontalVelocity(currentVx, currentVz, targetVx, targetVz, rate, dt, onGround, hasInput, out) {
    const o = out || { x: 0, z: 0 };
    const cvx = typeof currentVx === 'number' && isFinite(currentVx) ? currentVx : 0;
    const cvz = typeof currentVz === 'number' && isFinite(currentVz) ? currentVz : 0;
    const tvx = typeof targetVx === 'number' && isFinite(targetVx) ? targetVx : 0;
    const tvz = typeof targetVz === 'number' && isFinite(targetVz) ? targetVz : 0;
    const r = typeof rate === 'number' && isFinite(rate) ? Math.max(0, rate) : 16;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
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
    const p = typeof bobPhase === 'number' && isFinite(bobPhase) ? bobPhase : 0;
    const a = typeof bobAmp === 'number' && isFinite(bobAmp) ? Math.max(0, Math.min(1, bobAmp)) : 0;
    const spd = typeof horizontalSpeed === 'number' && isFinite(horizontalSpeed) ? Math.max(0, horizontalSpeed) : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;

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
    const mul = typeof landingSpeedMul === 'number' && isFinite(landingSpeedMul)
      ? Math.max(0, Math.min(1, landingSpeedMul)) : 1;
    return LAND_STUN_BASE_TIME + (1 - mul) * LAND_STUN_SCALE;
  }

  function stepJumpTimers(coyoteT, jumpBufT, onGround, jumpPressed, dt, out) {
    const o = out || { coyoteT: 0, jumpBufT: 0 };
    const cT = typeof coyoteT === 'number' && isFinite(coyoteT) ? Math.max(0, coyoteT) : 0;
    const jT = typeof jumpBufT === 'number' && isFinite(jumpBufT) ? Math.max(0, jumpBufT) : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;

    o.coyoteT = onGround ? COYOTE_TIME : Math.max(0, cT - delta);
    o.jumpBufT = jumpPressed ? JUMP_BUFFER_TIME : Math.max(0, jT - delta);
    return o;
  }

  function canInitiateJump(jumpBufT, coyoteT, isCrouching, isSliding, isDowned, landStunT) {
    const jb = typeof jumpBufT === 'number' && isFinite(jumpBufT) ? jumpBufT : 0;
    const ct = typeof coyoteT === 'number' && isFinite(coyoteT) ? coyoteT : 0;
    const ls = typeof landStunT === 'number' && isFinite(landStunT) ? landStunT : 0;
    return jb > 0 && ct > 0 && !isCrouching && !isSliding && !isDowned && ls <= 0;
  }

  function stepAdsTransition(currentAds, wantAds, dt, perkMul, weaponAdsSpeed) {
    const cur = typeof currentAds === 'number' && isFinite(currentAds) ? Math.max(0, Math.min(1, currentAds)) : 0;
    const target = wantAds ? 1 : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const pMul = typeof perkMul === 'number' && isFinite(perkMul) ? Math.max(0.1, perkMul) : 1;
    const wSpeed = typeof weaponAdsSpeed === 'number' && isFinite(weaponAdsSpeed) ? Math.max(0.1, weaponAdsSpeed) : 1;
    const rate = ADS_BASE_SPEED * pMul * wSpeed;
    return cur + (target - cur) * Math.min(1, rate * delta);
  }

  function stepGunSwitch(currentSwitchT, dt, speed) {
    const cur = typeof currentSwitchT === 'number' && isFinite(currentSwitchT) ? Math.max(0, Math.min(1, currentSwitchT)) : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const spd = typeof speed === 'number' && isFinite(speed) ? Math.max(0.1, speed) : GUN_SWITCH_SPEED;
    return Math.min(1, cur + delta * spd);
  }

  function applyShotKick(currentKick, impulse, maxKick) {
    const cur = typeof currentKick === 'number' && isFinite(currentKick) ? Math.max(0, currentKick) : 0;
    const imp = typeof impulse === 'number' && isFinite(impulse) ? impulse : SHOT_KICK_IMPULSE;
    const mx = typeof maxKick === 'number' && isFinite(maxKick) ? maxKick : SHOT_KICK_MAX;
    return Math.min(cur + imp, mx);
  }

  function decayShotKick(currentKick, dt, decayBase) {
    const cur = typeof currentKick === 'number' && isFinite(currentKick) ? Math.max(0, currentKick) : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const base = typeof decayBase === 'number' && isFinite(decayBase) && decayBase > 0 ? decayBase : SHOT_KICK_DECAY_BASE;
    return cur * Math.pow(base, delta);
  }

  function sniperUnscopeAds(adsAmount, factor) {
    const cur = typeof adsAmount === 'number' && isFinite(adsAmount) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    const f = typeof factor === 'number' && isFinite(factor) ? factor : SNIPER_UNSCOPE_FACTOR;
    return cur * f;
  }

  // ---- HUD Churn & Overlay Performance Rules (v90) ---------------------------
  const SLIDE_VIGNETTE_RATE = 14;
  const SLIDE_VIGNETTE_MAX_ALPHA = 0.55;

  function stepSlideVignette(curOpacity, wantSlide, dt, rate) {
    const cur = typeof curOpacity === 'number' && !isNaN(curOpacity) ? Math.max(0, Math.min(1, curOpacity)) : 0;
    const target = wantSlide ? 1 : 0;
    if (cur === target) return target;
    const r = typeof rate === 'number' && rate > 0 ? rate : SLIDE_VIGNETTE_RATE;
    const delta = typeof dt === 'number' && dt > 0 ? dt : 0;
    const step = Math.min(1, r * delta);
    const next = cur + (target - cur) * step;
    if (Math.abs(next - target) < 0.005) return target;
    return Math.max(0, Math.min(1, next));
  }

  function slideVignetteStyle(opacity, maxAlpha) {
    const op = typeof opacity === 'number' && !isNaN(opacity) ? Math.max(0, Math.min(1, opacity)) : 0;
    const ma = typeof maxAlpha === 'number' && maxAlpha >= 0 ? maxAlpha : SLIDE_VIGNETTE_MAX_ALPHA;
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
    const ads = typeof adsAmount === 'number' ? adsAmount : 0;
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
    const ads = typeof adsAmount === 'number' ? adsAmount : 0;
    return type === 'SR' && ads > 0.8;
  }

  function steadyIndicatorLabel(steadyActive, steadyT) {
    if (steadyActive) {
      const t = Math.max(0, typeof steadyT === 'number' ? steadyT : 0);
      return 'STEADY · ' + (Math.ceil(t * 10) / 10) + 's';
    }
    const t = typeof steadyT === 'number' ? steadyT : 0;
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
  const MUSIC_TENSION_THRESHOLD = 0.25;
  const MUSIC_TENSION_MAX_GAIN = 0.16;
  const MUSIC_BASE_CUTOFF = 200;
  const MUSIC_MAX_CUTOFF_SCALE = 900;
  const MUSIC_BASE_BPM = 46;
  const MUSIC_MAX_BPM_SCALE = 86;
  const MUSIC_PULSE_BASE_GAIN = 0.05;
  const MUSIC_PULSE_MAX_GAIN_SCALE = 0.5;
  const MUSIC_PULSE_EXPONENT = 6;

  function stepMusicIntensity(currentIntensity, targetIntensity, dt, riseRate, fallRate) {
    const cur = (typeof currentIntensity === 'number' && isFinite(currentIntensity)) ? currentIntensity : 0;
    const tgt = (typeof targetIntensity === 'number' && isFinite(targetIntensity)) ? Math.max(0, Math.min(1, targetIntensity)) : 0;
    const d = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 0;
    const rRise = (typeof riseRate === 'number' && isFinite(riseRate) && riseRate > 0) ? riseRate : MUSIC_RISE_RATE;
    const rFall = (typeof fallRate === 'number' && isFinite(fallRate) && fallRate > 0) ? fallRate : MUSIC_FALL_RATE;
    const rate = tgt > cur ? rRise : rFall;
    const blend = rate * d;
    if (blend >= 1) return tgt;
    const next = cur + (tgt - cur) * blend;
    return Math.max(0, Math.min(1, next));
  }

  function musicBusGain(volumeSetting, intensity) {
    const vol = (typeof volumeSetting === 'number' && isFinite(volumeSetting)) ? Math.max(0, Math.min(1, volumeSetting)) : 0;
    const i = (typeof intensity === 'number' && isFinite(intensity)) ? Math.max(0, Math.min(1, intensity)) : 0;
    return vol * (MUSIC_BASE_BUS_GAIN + i * MUSIC_INTENSITY_BUS_SCALE);
  }

  function musicTensionGain(intensity) {
    const i = (typeof intensity === 'number' && isFinite(intensity)) ? Math.max(0, Math.min(1, intensity)) : 0;
    if (i <= MUSIC_TENSION_THRESHOLD) return 0;
    return Math.min(MUSIC_TENSION_MAX_GAIN, ((i - MUSIC_TENSION_THRESHOLD) / (1 - MUSIC_TENSION_THRESHOLD)) * MUSIC_TENSION_MAX_GAIN);
  }

  function musicFilterCutoff(intensity) {
    const i = (typeof intensity === 'number' && isFinite(intensity)) ? Math.max(0, Math.min(1, intensity)) : 0;
    return MUSIC_BASE_CUTOFF + i * MUSIC_MAX_CUTOFF_SCALE;
  }

  function musicPulseBpm(intensity) {
    const i = (typeof intensity === 'number' && isFinite(intensity)) ? Math.max(0, Math.min(1, intensity)) : 0;
    return MUSIC_BASE_BPM + i * MUSIC_MAX_BPM_SCALE;
  }

  function stepMusicPulsePhase(phase, dt, bpm) {
    const p = (typeof phase === 'number' && isFinite(phase)) ? phase : 0;
    const d = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 0;
    const b = (typeof bpm === 'number' && isFinite(bpm) && bpm > 0) ? bpm : MUSIC_BASE_BPM;
    let next = p + d * (b / 60);
    next = next - Math.floor(next);
    return next;
  }

  function musicPulseEnvelope(phase) {
    const p = (typeof phase === 'number' && isFinite(phase)) ? Math.max(0, Math.min(1, phase)) : 0;
    return Math.pow(1 - p, MUSIC_PULSE_EXPONENT);
  }

  function musicPulseGain(envelope, intensity) {
    const env = (typeof envelope === 'number' && isFinite(envelope)) ? Math.max(0, Math.min(1, envelope)) : 0;
    const i = (typeof intensity === 'number' && isFinite(intensity)) ? Math.max(0, Math.min(1, intensity)) : 0;
    return env * (MUSIC_PULSE_BASE_GAIN + i * MUSIC_PULSE_MAX_GAIN_SCALE);
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
    const dur = typeof reloadDuration === 'number' && isFinite(reloadDuration) && reloadDuration > 0 ? reloadDuration : 1;
    const t = typeof reloadT === 'number' && isFinite(reloadT) ? reloadT : -1;
    if (t < 0 || t >= dur) {
      o.dip = 0;
      o.rot = 0;
      o.magY = VIEWMODEL_MAG_REST_Y;
      return o;
    }
    const p = Math.max(0, Math.min(1, t / dur));
    const bump = Math.sin(p * Math.PI);
    o.dip = bump * VIEWMODEL_RELOAD_DIP;
    o.rot = bump * VIEWMODEL_RELOAD_ROT;
    const magDrop = p < 0.4 ? p * VIEWMODEL_MAG_DROP_SCALE : Math.max(0, 0.55 - p) * VIEWMODEL_MAG_INSERT_SCALE;
    o.magY = VIEWMODEL_MAG_REST_Y - magDrop;
    return o;
  }

  function viewmodelBoltOffset(shotKick) {
    const kick = typeof shotKick === 'number' && isFinite(shotKick) ? Math.max(0, shotKick) : 0;
    return VIEWMODEL_BOLT_REST_Z + Math.min(VIEWMODEL_BOLT_KICK_MAX, kick * VIEWMODEL_BOLT_KICK_SCALE);
  }

  function viewmodelPose(adsAmount, stance, shotKick, swayX, swayY, bobPhase, bobAmp, isSniper, gunSwitchT, reloadDip, reloadRot, pitch, aspect, isReducedMotion, out) {
    const o = out || { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    const hipFactor = 1 - ads;

    let px = VIEWMODEL_HIP_X + (VIEWMODEL_ADS_X - VIEWMODEL_HIP_X) * ads;
    let py = VIEWMODEL_HIP_Y + (VIEWMODEL_ADS_Y - VIEWMODEL_HIP_Y) * ads;
    let pz = VIEWMODEL_HIP_Z + (VIEWMODEL_ADS_Z - VIEWMODEL_HIP_Z) * ads;

    const st = VIEWMODEL_STANCE_OFFSETS[stance] || VIEWMODEL_STANCE_OFFSETS.idle;
    px += st.posX * hipFactor;
    py += st.posY * hipFactor;
    pz += st.posZ * hipFactor;

    const kick = Math.max(0, typeof shotKick === 'number' && isFinite(shotKick) ? shotKick : 0) * VIEWMODEL_KICK_Z_SCALE;
    pz += kick;
    py += kick * VIEWMODEL_KICK_Y_SCALE;

    if (isSniper) {
      const sx = typeof swayX === 'number' && isFinite(swayX) ? swayX : 0;
      const sy = typeof swayY === 'number' && isFinite(swayY) ? swayY : 0;
      py += ads * 0.062;
      pz += ads * 0.16;
      px += sx * (1 - ads * 0.5);
      py += sy * (1 - ads * 0.5);
    }

    const sw = typeof gunSwitchT === 'number' && isFinite(gunSwitchT) ? Math.max(0, Math.min(1, gunSwitchT)) : 1;
    const raise = (1 - sw) * VIEWMODEL_SWITCH_RAISE_DISTANCE;
    const dip = typeof reloadDip === 'number' && isFinite(reloadDip) ? reloadDip : 0;
    py -= (dip + raise);

    const motion = isReducedMotion ? 0 : 1;
    const bAmp = typeof bobAmp === 'number' && isFinite(bobAmp) ? bobAmp : 0;
    const bPhase = typeof bobPhase === 'number' && isFinite(bobPhase) ? bobPhase : 0;
    const bob = bAmp * VIEWMODEL_BOB_SCALE * motion;
    const swayX2 = Math.sin(bPhase) * bob;
    const swayY2 = Math.abs(Math.cos(bPhase)) * bob;
    px += swayX2 * hipFactor;
    py -= swayY2 * hipFactor;

    const asp = typeof aspect === 'number' && isFinite(aspect) && aspect > 0 ? aspect : 1;
    const narrow = Math.max(0, Math.min(1, (1.2 - asp) / 0.7));
    px -= px * 0.75 * narrow;
    py += 0.05 * narrow;

    const rot = typeof reloadRot === 'number' && isFinite(reloadRot) ? reloadRot : 0;
    const pAngle = typeof pitch === 'number' && isFinite(pitch) ? pitch : 0;
    const rx = -rot * 0.6 - pAngle * 0.03 + st.rotX * hipFactor;
    const ry = (0.06 + st.rotY) * hipFactor;
    const rz = st.rotZ * hipFactor;

    o.posX = px; o.posY = py; o.posZ = pz;
    o.rotX = rx; o.rotY = ry; o.rotZ = rz;
    return o;
  }

  function stepMuzzleFlash(flashT, dt, decayRate) {
    const cur = typeof flashT === 'number' && isFinite(flashT) ? Math.max(0, flashT) : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const rate = typeof decayRate === 'number' && isFinite(decayRate) ? Math.max(0, decayRate) : VIEWMODEL_MUZZLE_FLASH_DECAY;
    return Math.max(0, cur - delta * rate);
  }

  function stepMuzzleLight(intensity, dt, decayRate, lightCompat) {
    const cur = typeof intensity === 'number' && isFinite(intensity) ? Math.max(0, intensity) : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const rate = typeof decayRate === 'number' && isFinite(decayRate) ? Math.max(0, decayRate) : VIEWMODEL_MUZZLE_LIGHT_DECAY_RATE;
    const compat = typeof lightCompat === 'number' && isFinite(lightCompat) ? Math.max(0, lightCompat) : 1;
    return Math.max(0, cur - delta * rate * compat * 4);
  }

  function impactVfxScale(life, maxLife) {
    const maxL = typeof maxLife === 'number' && isFinite(maxLife) && maxLife > 0 ? maxLife : IMPACT_VFX_LIFETIME;
    const curL = typeof life === 'number' && isFinite(life) ? Math.max(0, Math.min(maxL, life)) : 0;
    if (curL <= 0) return 0.001;
    const expansion = 1 + (maxL - curL) * IMPACT_VFX_EXPANSION_RATE;
    return Math.max(0.001, expansion * (curL / maxL));
  }

  // ---- Particle Upload Optimization, Marksman Scope & Spring Physics (v94) ----
  const PFX_DEFAULT_MAX = 3000;
  const SCOPE_PARALLAX_MAX = 40;
  const SCOPE_PARALLAX_SCALE = 900;
  const SCOPE_RANGE_MAX = 400;
  const SCOPE_RANGE_INTERVAL = 0.1;
  const POST_KICK_DECAY_RATE = 1.6;

  function pfxNeedsUpload(currentAlive, previousAlive) {
    const cur = typeof currentAlive === 'number' && isFinite(currentAlive) ? currentAlive : 0;
    const prev = typeof previousAlive === 'number' && isFinite(previousAlive) ? previousAlive : 0;
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
    const maxVal = typeof maxOffset === 'number' && isFinite(maxOffset) && maxOffset > 0 ? maxOffset : SCOPE_PARALLAX_MAX;
    const s = typeof scale === 'number' && isFinite(scale) ? scale : SCOPE_PARALLAX_SCALE;
    const sx = typeof swayX === 'number' && isFinite(swayX) ? swayX : 0;
    const sy = typeof swayY === 'number' && isFinite(swayY) ? swayY : 0;
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
    const d = typeof distance === 'number' && isFinite(distance) ? distance : Infinity;
    if (!isFinite(d)) return 'RNG ---';
    const tag = isHostile ? 'TGT ' : 'RNG ';
    return tag + Math.round(d) + 'm';
  }

  function isHostileTarget(enemyDist, worldDist, tolerance) {
    const ed = typeof enemyDist === 'number' && isFinite(enemyDist) ? enemyDist : Infinity;
    if (!isFinite(ed)) return false;
    const wd = typeof worldDist === 'number' && isFinite(worldDist) ? worldDist : Infinity;
    const tol = typeof tolerance === 'number' && isFinite(tolerance) ? tolerance : 0.5;
    return ed < (wd + tol);
  }

  function stepRangefinderTimer(timer, dt, interval) {
    const t = typeof timer === 'number' && isFinite(timer) ? timer : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const next = t - delta;
    if (next <= 0) {
      const inv = typeof interval === 'number' && isFinite(interval) && interval > 0 ? interval : SCOPE_RANGE_INTERVAL;
      return { ready: true, timer: inv };
    }
    return { ready: false, timer: next };
  }

  function stepSpring(x, v, target, k, c, dt, out) {
    const o = out || [0, 0];
    const tgt = typeof target === 'number' && isFinite(target) ? target : 0;
    let curX = typeof x === 'number' && isFinite(x) ? x : tgt;
    let curV = typeof v === 'number' && isFinite(v) ? v : 0;
    const stiff = typeof k === 'number' && isFinite(k) && k > 0 ? k : 90;
    const damp = typeof c === 'number' && isFinite(c) && c >= 0 ? c : 11;
    const delta = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;

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
    const start = typeof a === 'number' && isFinite(a) ? a : 0;
    const end = typeof b === 'number' && isFinite(b) ? b : 1;
    const val = typeof x === 'number' && isFinite(x) ? x : start;
    if (end === start) return val >= end ? 1 : 0;
    const t = Math.max(0, Math.min(1, (val - start) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function vmBump(a, b, x) {
    const start = typeof a === 'number' && isFinite(a) ? a : 0;
    const end = typeof b === 'number' && isFinite(b) ? b : 1;
    const val = typeof x === 'number' && isFinite(x) ? x : start;
    if (val <= start || val >= end || start === end) return 0;
    return Math.sin((val - start) / (end - start) * Math.PI);
  }

  function wrapAngle(a) {
    let ang = typeof a === 'number' && isFinite(a) ? a : 0;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang < -Math.PI) ang += Math.PI * 2;
    return ang;
  }

  function stepPostKick(currentKick, dt, decayRate) {
    const cur = typeof currentKick === 'number' && isFinite(currentKick) ? Math.max(0, currentKick) : 0;
    const delta = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const rate = typeof decayRate === 'number' && isFinite(decayRate) && decayRate > 0 ? decayRate : POST_KICK_DECAY_RATE;
    return Math.max(0, cur - delta * rate);
  }

  function postFringe(kick, isReducedMotion) {
    if (isReducedMotion) return 0;
    return typeof kick === 'number' && isFinite(kick) ? Math.max(0, kick) : 0;
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
    const a = typeof ammo === 'number' && isFinite(ammo) ? ammo : 0;
    const m = typeof magSize === 'number' && isFinite(magSize) ? magSize : 0;
    const r = typeof reserve === 'number' && isFinite(reserve) ? reserve : 0;
    if (m <= 0 || r <= 0) return false;
    return a < m;
  }

  function effectiveReloadDuration(baseReload, perkMul) {
    const base = typeof baseReload === 'number' && isFinite(baseReload) && baseReload >= 0 ? baseReload : 2.0;
    const mul = typeof perkMul === 'number' && isFinite(perkMul) && perkMul >= 0 ? perkMul : 1.0;
    return Math.max(CAN_RELOAD_MIN_DURATION, base * mul);
  }

  function isReloadComplete(reloadT, duration) {
    return typeof reloadT === 'number' && isFinite(reloadT) &&
           typeof duration === 'number' && isFinite(duration) &&
           reloadT >= duration;
  }

  function completeReload(ammo, magSize, reserve, out) {
    const curAmmo = typeof ammo === 'number' && isFinite(ammo) ? Math.max(0, ammo) : 0;
    const curMag = typeof magSize === 'number' && isFinite(magSize) ? Math.max(0, magSize) : 0;
    const curReserve = typeof reserve === 'number' && isFinite(reserve) ? Math.max(0, reserve) : 0;
    const need = Math.max(0, curMag - curAmmo);
    const take = Math.min(need, curReserve);
    const res = out || { ammo: 0, reserve: 0, take: 0 };
    res.ammo = curAmmo + take;
    res.reserve = curReserve - take;
    res.take = take;
    return res;
  }

  function munitionsAmmoRestore(currentReserve, reserveMax, magSize, ratio) {
    const r = typeof ratio === 'number' && isFinite(ratio) && ratio >= 0 ? ratio : MUNITIONS_MAG_RATIO;
    const curRes = typeof currentReserve === 'number' && isFinite(currentReserve) ? Math.max(0, currentReserve) : 0;
    const maxRes = typeof reserveMax === 'number' && isFinite(reserveMax) ? Math.max(0, reserveMax) : curRes;
    const mag = typeof magSize === 'number' && isFinite(magSize) ? Math.max(0, magSize) : 0;
    return Math.min(maxRes, curRes + Math.round(mag * r));
  }

  function airstrikeDelay(index, baseDelay, stepDelay) {
    const b = typeof baseDelay === 'number' && isFinite(baseDelay) ? baseDelay : AIRSTRIKE_BASE_DELAY;
    const s = typeof stepDelay === 'number' && isFinite(stepDelay) ? stepDelay : AIRSTRIKE_STEP_DELAY;
    const i = typeof index === 'number' && isFinite(index) ? Math.max(0, index) : 0;
    return b + i * s;
  }

  function airstrikeBombCoord(playerX, playerZ, dirX, dirZ, index, leadDist, spacing, jitterX, jitterZ, out) {
    const px = typeof playerX === 'number' && isFinite(playerX) ? playerX : 0;
    const pz = typeof playerZ === 'number' && isFinite(playerZ) ? playerZ : 0;
    const dx = typeof dirX === 'number' && isFinite(dirX) ? dirX : 0;
    const dz = typeof dirZ === 'number' && isFinite(dirZ) ? dirZ : 0;
    const lead = typeof leadDist === 'number' && isFinite(leadDist) ? leadDist : AIRSTRIKE_LEAD_DIST;
    const sp = typeof spacing === 'number' && isFinite(spacing) ? spacing : AIRSTRIKE_SPACING;
    const i = typeof index === 'number' && isFinite(index) ? Math.max(0, index) : 0;
    const jx = typeof jitterX === 'number' && isFinite(jitterX) ? jitterX : 0;
    const jz = typeof jitterZ === 'number' && isFinite(jitterZ) ? jitterZ : 0;
    const ox = px + dx * lead;
    const oz = pz + dz * lead;
    const res = out || { x: 0, z: 0 };
    res.x = ox + dx * i * sp + jx;
    res.z = oz + dz * i * sp + jz;
    return res;
  }

  function enemyGrenadeSpeed(distance) {
    const d = typeof distance === 'number' && isFinite(distance) ? Math.max(0, distance) : 0;
    return Math.min(ENEMY_GRENADE_MAX_SPEED, ENEMY_GRENADE_MIN_SPEED + d * ENEMY_GRENADE_SPEED_DIST_SCALE);
  }

  function enemyGrenadeFuse(baseFuse, bonus) {
    const base = typeof baseFuse === 'number' && isFinite(baseFuse) ? Math.max(0.5, baseFuse) : 2.5;
    const b = typeof bonus === 'number' && isFinite(bonus) ? bonus : ENEMY_GRENADE_FUSE_BONUS;
    return base + b;
  }

  function enemyGrenadeCooldown(isGrenadier, currentT, randomVal) {
    const t = typeof currentT === 'number' && isFinite(currentT) ? currentT : 0;
    const r = typeof randomVal === 'number' && isFinite(randomVal) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    if (isGrenadier) {
      return t + 5.5 + r * 4;
    }
    return t + 11 + r * 9;
  }

  function enemyBurstInterval(burstRemaining, rof, randomVal) {
    if (typeof burstRemaining === 'number' && isFinite(burstRemaining) && burstRemaining > 0) return 0.12;
    const baseRof = typeof rof === 'number' && isFinite(rof) && rof > 0 ? rof : 0.4;
    const r = typeof randomVal === 'number' && isFinite(randomVal) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    return baseRof * 1.6 * (0.8 + r * 0.4);
  }

  function pickupBobHeight(t, isPower) {
    const time = typeof t === 'number' && isFinite(t) ? t : 0;
    const baseY = isPower ? 0.55 : 0.3;
    const amp = isPower ? 0.12 : 0.06;
    return baseY + Math.sin(time * 3) * amp;
  }

  function isPickupVisible(t, blinkStart, maxLife) {
    const time = typeof t === 'number' && isFinite(t) ? t : 0;
    const life = typeof maxLife === 'number' && isFinite(maxLife) ? maxLife : PICKUP_LIFE;
    if (time > life) return false;
    const blink = typeof blinkStart === 'number' && isFinite(blinkStart) ? blinkStart : PICKUP_BLINK_START;
    if (time > blink) return (time * 6 % 2) < 1.4;
    return true;
  }

  // Smooth pickup despawn fade: pulsing opacity during the blink window instead of
  // a binary on/off toggle. Returns a value in [0,1].
  //   - Before blinkStart: 1.0 (fully opaque).
  //   - In the blink window: sin²-based pulse that accelerates as the pickup nears
  //     expiry so the urgency is legible without being harsh.
  //   - At or past maxLife: 0 (invisible).
  function pickupBlinkOpacity(t, blinkStart, maxLife) {
    const time = typeof t === 'number' && isFinite(t) ? t : 0;
    const life = typeof maxLife === 'number' && isFinite(maxLife) ? maxLife : PICKUP_LIFE;
    if (time >= life) return 0;
    const blink = typeof blinkStart === 'number' && isFinite(blinkStart) ? blinkStart : PICKUP_BLINK_START;
    if (time <= blink) return 1;
    // Ramp up blink frequency linearly from 3 Hz at blinkStart to 7 Hz at maxLife.
    const progress = (time - blink) / Math.max(0.001, life - blink); // 0→1
    const freq = 3 + progress * 4;                                   // 3→7 Hz
    const phase = (time - blink) * freq * Math.PI * 2;
    const s = Math.sin(phase);
    // sin² gives a smooth "on-dip-on" pattern; minimum opacity 0.08 so the pickup
    // never vanishes completely (still visible as a faint ghost, not a pop-out).
    return Math.max(0.08, s * s);
  }

  function canCollectPickup(pickupX, pickupZ, playerX, playerZ, radius) {
    if (typeof pickupX !== 'number' || !isFinite(pickupX) ||
        typeof pickupZ !== 'number' || !isFinite(pickupZ) ||
        typeof playerX !== 'number' || !isFinite(playerX) ||
        typeof playerZ !== 'number' || !isFinite(playerZ)) return false;
    const rad = typeof radius === 'number' && isFinite(radius) && radius > 0 ? radius : PICKUP_COLLECT_RADIUS;
    const dx = pickupX - playerX, dz = pickupZ - playerZ;
    return (dx * dx + dz * dz) < rad * rad;
  }

  function grenadeBlinkVisible(fuse, armT, requiredArm) {
    if (typeof fuse === 'number' && isFinite(fuse)) {
      return Math.sin(fuse * (20 - fuse * 4) * 2) > 0;
    }
    const t = typeof armT === 'number' && isFinite(armT) ? armT : 0;
    const req = typeof requiredArm === 'number' && isFinite(requiredArm) ? requiredArm : 0;
    return t >= req;
  }

  function flashOverlayOpacity(flashT, durScale, maxAlpha) {
    if (typeof flashT !== 'number' || !isFinite(flashT) || flashT <= 0) return 0;
    const scale = typeof durScale === 'number' && isFinite(durScale) && durScale > 0 ? durScale : FLASH_OVERLAY_DURATION_SCALE;
    const alpha = typeof maxAlpha === 'number' && isFinite(maxAlpha) ? maxAlpha : FLASH_OVERLAY_MAX_ALPHA;
    return Math.min(alpha, flashT / scale);
  }

  function smokeCloudScale(elapsedT, radius, growDuration) {
    const elapsed = typeof elapsedT === 'number' && isFinite(elapsedT) ? Math.max(0, elapsedT) : 0;
    const dur = typeof growDuration === 'number' && isFinite(growDuration) && growDuration > 0 ? growDuration : 1.0;
    const grow = Math.min(1, elapsed / dur);
    const r = typeof radius === 'number' && isFinite(radius) ? radius : 1.0;
    return r * (0.25 + 0.75 * grow);
  }

  function smokeCloudOpacity(remainingT, fadeDuration, maxOpacity) {
    if (!isFinite(remainingT) || remainingT <= 0) return 0;
    const fade = typeof fadeDuration === 'number' && isFinite(fadeDuration) && fadeDuration > 0 ? fadeDuration : 1.5;
    const maxO = typeof maxOpacity === 'number' && isFinite(maxOpacity) ? maxOpacity : 0.62;
    return maxO * Math.min(1, Math.max(0, remainingT / fade));
  }

  function burnPatchOpacity(remainingT, totalLife, maxOpacity) {
    if (!isFinite(remainingT) || remainingT <= 0) return 0;
    const life = typeof totalLife === 'number' && isFinite(totalLife) && totalLife > 0 ? totalLife : 1.0;
    const maxO = typeof maxOpacity === 'number' && isFinite(maxOpacity) ? maxOpacity : 0.5;
    return maxO * Math.max(0, Math.min(1, remainingT / life));
  }

  // ---- Shell Casings Dynamics & Tactical Viewmodel Kinematics (v98) ----
  const CASING_MAX = 24;
  const CASING_LIFETIME = 2.2;
  const CASING_FADE_DURATION = 0.35;
  const CASING_FLOOR_Y = 0.02;
  const CASING_GRAVITY = 12;
  const CASING_BOUNCE = 0.35;
  const CASING_FRICTION = 0.5;
  const CASING_SPIN_DAMP = 0.4;
  const CASING_REST_SPEED = 0.6;
  const CASING_SND_GAP = 0.09;
  const VIEWMODEL_MANTLE_IN_RATE = 8;
  const VIEWMODEL_MANTLE_OUT_RATE = 5;

  function casingScale(life, maxLife, fadeDur) {
    const dur = typeof fadeDur === 'number' && isFinite(fadeDur) && fadeDur > 0 ? fadeDur : CASING_FADE_DURATION;
    if (typeof life !== 'number' || !isFinite(life) || life <= 0) return 0.001;
    if (life >= dur) return 1.0;
    const t = Math.max(0, Math.min(1, life / dur));
    return Math.max(0.001, t * t * (3 - 2 * t));
  }

  function casingEjectVelocity(rightX, rightY, rightZ, randMul, randY, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const rMul = typeof randMul === 'number' && isFinite(randMul) ? randMul : 0;
    const rY = typeof randY === 'number' && isFinite(randY) ? randY : 0;
    const speed = 1.6 + rMul;
    const rx = typeof rightX === 'number' && isFinite(rightX) ? rightX : 0;
    const ry = typeof rightY === 'number' && isFinite(rightY) ? rightY : 0;
    const rz = typeof rightZ === 'number' && isFinite(rightZ) ? rightZ : 0;
    o.x = rx * speed;
    o.y = ry * speed + 1.4 + rY;
    o.z = rz * speed;
    return o;
  }

  function stepCasingPhysics(posX, posY, posZ, vx, vy, vz, spinX, spinY, spinZ, dt, grav, bounce, fric, spinDamp, floorY, restSpd, out) {
    const o = out || { x: posX, y: posY, z: posZ, vx: vx, vy: vy, vz: vz, spinX: spinX, spinY: spinY, spinZ: spinZ, rest: false, bounced: false };
    const delta = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    const g = typeof grav === 'number' && isFinite(grav) ? grav : CASING_GRAVITY;
    const b = typeof bounce === 'number' && isFinite(bounce) ? bounce : CASING_BOUNCE;
    const f = typeof fric === 'number' && isFinite(fric) ? fric : CASING_FRICTION;
    const sd = typeof spinDamp === 'number' && isFinite(spinDamp) ? spinDamp : CASING_SPIN_DAMP;
    const flY = typeof floorY === 'number' && isFinite(floorY) ? floorY : CASING_FLOOR_Y;
    const rSpd = typeof restSpd === 'number' && isFinite(restSpd) ? restSpd : CASING_REST_SPEED;

    let x = typeof posX === 'number' && isFinite(posX) ? posX : 0;
    let y = typeof posY === 'number' && isFinite(posY) ? posY : 0;
    let z = typeof posZ === 'number' && isFinite(posZ) ? posZ : 0;
    let velX = typeof vx === 'number' && isFinite(vx) ? vx : 0;
    let velY = typeof vy === 'number' && isFinite(vy) ? vy : 0;
    let velZ = typeof vz === 'number' && isFinite(vz) ? vz : 0;
    let spX = typeof spinX === 'number' && isFinite(spinX) ? spinX : 0;
    let spY = typeof spinY === 'number' && isFinite(spinY) ? spinY : 0;
    let spZ = typeof spinZ === 'number' && isFinite(spinZ) ? spinZ : 0;

    velY -= g * delta;
    x += velX * delta;
    y += velY * delta;
    z += velZ * delta;

    let bounced = false;
    let rest = false;

    if (y <= flY) {
      y = flY;
      if (velY < -0.5) {
        velY = -velY * b;
        velX *= f;
        velZ *= f;
        spX *= sd;
        spY *= sd;
        spZ *= sd;
        bounced = true;
        if (Math.abs(velY) < rSpd) {
          rest = true;
          velX = 0; velY = 0; velZ = 0;
          spX = 0; spY = 0; spZ = 0;
        }
      } else {
        rest = true;
        velX = 0; velY = 0; velZ = 0;
        spX = 0; spY = 0; spZ = 0;
      }
    }

    o.x = x; o.y = y; o.z = z;
    o.vx = velX; o.vy = velY; o.vz = velZ;
    o.spinX = spX; o.spinY = spY; o.spinZ = spZ;
    o.bounced = bounced;
    o.rest = rest;
    return o;
  }

  function casingRestRotation(rotX, rotY, rotZ, out) {
    const o = out || { rotX: 0, rotY: 0, rotZ: 0 };
    const ry = typeof rotY === 'number' && isFinite(rotY) ? rotY : 0;
    o.rotX = Math.PI * 0.5;
    o.rotY = ry;
    o.rotZ = 0;
    return o;
  }

  function stepMeleeKnifePose(progress, out) {
    const o = out || { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };
    const p = typeof progress === 'number' && isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const sw = vmSmooth(0.1, 0.45, p);
    const bump = vmBump(0, 1, p);
    o.posX = 0.22 - sw * 0.36;
    o.posY = -0.12 + bump * 0.06;
    o.posZ = -0.3;
    o.rotX = -0.2;
    o.rotY = 0.9 - sw * 1.6;
    o.rotZ = -0.9 + sw * 0.9;
    return o;
  }

  function meleeGunDodgeOffsets(progress, out) {
    const o = out || { posY: 0, rotX: 0, rotZ: 0 };
    const p = typeof progress === 'number' && isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const gunOut = p > 0 && p < 1 ? vmBump(0, 1, p) : 0;
    o.posY = gunOut !== 0 ? -gunOut * 0.25 : 0;
    o.rotX = gunOut !== 0 ? -gunOut * 0.5 : 0;
    o.rotZ = gunOut !== 0 ? gunOut * 0.4 : 0;
    return o;
  }

  function stepViewmodelMantle(currentMantle, isMantling, dt, inRate, outRate) {
    const cur = typeof currentMantle === 'number' && isFinite(currentMantle) ? currentMantle : 0;
    const delta = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    const inR = typeof inRate === 'number' && isFinite(inRate) && inRate > 0 ? inRate : VIEWMODEL_MANTLE_IN_RATE;
    const outR = typeof outRate === 'number' && isFinite(outRate) && outRate > 0 ? outRate : VIEWMODEL_MANTLE_OUT_RATE;
    if (isMantling) return Math.min(1, cur + delta * inR);
    return Math.max(0, cur - delta * outR);
  }

  function viewmodelMantleOffsets(mantleAmount, out) {
    const o = out || { posY: 0, rotX: 0, rotZ: 0 };
    const m = typeof mantleAmount === 'number' && isFinite(mantleAmount) ? Math.max(0, Math.min(1, mantleAmount)) : 0;
    o.posY = m !== 0 ? -m * 0.18 : 0;
    o.rotX = m !== 0 ? -m * 0.3 : 0;
    o.rotZ = m !== 0 ? m * 0.5 : 0;
    return o;
  }

  function reloadHandOffsets(progress, targetX, targetY, targetZ, restX, restY, restZ, out) {
    const o = out || { posX: 0, posY: 0, posZ: 0 };
    const p = typeof progress === 'number' && isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const hk = vmBump(0.08, 0.72, p);
    const tx = typeof targetX === 'number' && isFinite(targetX) ? targetX : 0;
    const tz = typeof targetZ === 'number' && isFinite(targetZ) ? targetZ : 0;
    const rx = typeof restX === 'number' && isFinite(restX) ? restX : 0;
    const rz = typeof restZ === 'number' && isFinite(restZ) ? restZ : 0;
    o.posX = hk !== 0 ? (tx - rx - 0.01) * hk * 0.9 : 0;
    o.posY = hk !== 0 ? -0.12 * hk : 0;
    o.posZ = hk !== 0 ? (tz - rz + 0.15) * hk * 0.9 : 0;
    return o;
  }

  function viewmodelLateralSpeed(velX, velZ, yaw) {
    const vx = typeof velX === 'number' && isFinite(velX) ? velX : 0;
    const vz = typeof velZ === 'number' && isFinite(velZ) ? velZ : 0;
    const y = typeof yaw === 'number' && isFinite(yaw) ? yaw : 0;
    return vx * Math.cos(y) - vz * Math.sin(y);
  }

  function stepViewmodelTilt(currentTilt, lateralVel, adsAmount, motionScale, dt) {
    const cur = typeof currentTilt === 'number' && isFinite(currentTilt) ? currentTilt : 0;
    const latV = typeof lateralVel === 'number' && isFinite(lateralVel) ? lateralVel : 0;
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    const motion = typeof motionScale === 'number' && isFinite(motionScale) ? motionScale : 1;
    const delta = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
    const target = -latV * 0.012 * (1 - ads * 0.7) * motion;
    const blend = Math.min(1, 8 * delta);
    return cur + (target - cur) * blend;
  }

  function viewmodelLookInertiaTarget(lookDelta, isPitch, adsAmount, motionScale) {
    const d = typeof lookDelta === 'number' && isFinite(lookDelta) ? lookDelta : 0;
    const sign = isPitch ? -1 : 1;
    const ads = typeof adsAmount === 'number' && isFinite(adsAmount) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    const motion = typeof motionScale === 'number' && isFinite(motionScale) ? motionScale : 1;
    const clamped = Math.max(-0.05, Math.min(0.05, sign * d * 1.6));
    return clamped * (1 - ads * 0.75) * motion;
  }

  // ---- Station Buy Prompt Performance Rules ----
  const BUY_PROMPT_DEFAULT_COLOR = '#ffd24a';
  const BUY_PROMPT_DIM_COLOR = 'rgba(255,255,255,.55)';

  function buyPromptLabel(label, price, prefix) {
    const lbl = (typeof label === 'string') ? label : '';
    const prc = (typeof price === 'number' && isFinite(price) && price > 0) ? ('  ·  ' + price + ' CR') : '';
    const pfx = (typeof prefix === 'string') ? prefix : '';
    return pfx + lbl + prc;
  }

  function buyPromptFillPct(holdT, maxHold) {
    const t = (typeof holdT === 'number' && isFinite(holdT)) ? holdT : 0;
    const maxT = (typeof maxHold === 'number' && isFinite(maxHold) && maxHold > 0) ? maxHold : 1;
    return Math.round(Math.min(1, Math.max(0, t / maxT)) * 100);
  }

  function buyPromptColor(dim) {
    return dim ? BUY_PROMPT_DIM_COLOR : BUY_PROMPT_DEFAULT_COLOR;
  }

  function buyPromptChanged(lastState, visible, text, fillPct, dim) {
    if (!lastState) return true;
    return lastState.visible !== !!visible ||
           lastState.text !== (text || '') ||
           lastState.fillPct !== fillPct ||
           lastState.dim !== !!dim;
  }

  function syncBuyPromptState(lastState, visible, text, fillPct, dim) {
    if (!lastState) return { visible: !!visible, text: text || '', fillPct: fillPct || 0, dim: !!dim };
    lastState.visible = !!visible;
    lastState.text = text || '';
    lastState.fillPct = fillPct || 0;
    lastState.dim = !!dim;
    return lastState;
  }

  // ---- Minimap & Compass 2D Canvas Gating & Projection ----
  const COMPASS_YAW_THRESHOLD = 0.002; // ~0.11 degrees

  function compassNeedsRedraw(lastYaw, currentYaw, threshold) {
    if (typeof lastYaw !== 'number' || !isFinite(lastYaw)) return true;
    if (typeof currentYaw !== 'number' || !isFinite(currentYaw)) return false;
    const limit = (typeof threshold === 'number' && isFinite(threshold)) ? threshold : COMPASS_YAW_THRESHOLD;
    return Math.abs(currentYaw - lastYaw) >= limit;
  }

  function minimapScale(canvasRadius, worldSize, margin) {
    const r = (typeof canvasRadius === 'number' && isFinite(canvasRadius)) ? canvasRadius : 75;
    const ws = (typeof worldSize === 'number' && isFinite(worldSize)) ? worldSize : 90;
    const m = (typeof margin === 'number' && isFinite(margin)) ? margin : 8;
    return r / (ws / 2 + m);
  }

  function minimapDetectRadiusSq(uavActive, canvasRadius, baseDetect, scale) {
    const r = (typeof canvasRadius === 'number' && isFinite(canvasRadius)) ? canvasRadius : 75;
    if (uavActive) return r * r;
    const bd = (typeof baseDetect === 'number' && isFinite(baseDetect)) ? baseDetect : 26;
    const s = (typeof scale === 'number' && isFinite(scale)) ? scale : 1;
    const dist = bd * s;
    return dist * dist;
  }

  function minimapBlipOffset(worldX, worldZ, playerX, playerZ, scale, out) {
    const o = out || { x: 0, z: 0 };
    const s = (typeof scale === 'number' && isFinite(scale)) ? scale : 1;
    o.x = ((typeof worldX === 'number' && isFinite(worldX) ? worldX : 0) - (typeof playerX === 'number' && isFinite(playerX) ? playerX : 0)) * s;
    o.z = ((typeof worldZ === 'number' && isFinite(worldZ) ? worldZ : 0) - (typeof playerZ === 'number' && isFinite(playerZ) ? playerZ : 0)) * s;
    return o;
  }

  function isMinimapBlipVisible(offsetX, offsetZ, maxRadiusSq) {
    if (!isFinite(offsetX) || !isFinite(offsetZ)) return false;
    const limit = (typeof maxRadiusSq === 'number' && isFinite(maxRadiusSq)) ? maxRadiusSq : Infinity;
    return (offsetX * offsetX + offsetZ * offsetZ) <= limit;
  }

  function minimapEnemyRadius(kind) {
    if (kind === 2 || kind === 3) return 4;
    if (kind === 4) return 2.5;
    return 3;
  }

  function compassTickAngle(heading, offset) {
    const h = (typeof heading === 'number' && isFinite(heading)) ? heading : 0;
    const off = (typeof offset === 'number' && isFinite(offset)) ? offset : 0;
    return (h + off + 360) % 360;
  }

  function compassSnapAngle(deg, step) {
    const d = (typeof deg === 'number' && isFinite(deg)) ? deg : 0;
    const s = (typeof step === 'number' && isFinite(step) && step > 0) ? step : 5;
    return Math.round(d / s) * s;
  }

  function compassTickVisible(offset, maxSpan) {
    if (!isFinite(offset)) return false;
    const span = (typeof maxSpan === 'number' && isFinite(maxSpan)) ? maxSpan : 45;
    return Math.abs(offset) <= span;
  }

  function compassTickStyle(isMajor) {
    return isMajor ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
  }

  // ---- Ragdoll Settling, Sinking & Despawn Lifecycle ----
  const RAGDOLL_SINK_DELAY = 3.5;
  const RAGDOLL_SINK_RATE = 0.6;
  const RAGDOLL_SINK_MAX = 1.6;
  const RAGDOLL_DROP_SCALE = 0.02;

  function isRagdollSinkReady(isSettled, age, delay) {
    if (!isSettled) return false;
    const a = (typeof age === 'number' && isFinite(age)) ? age : 0;
    const d = (typeof delay === 'number' && isFinite(delay)) ? delay : RAGDOLL_SINK_DELAY;
    return a > d;
  }

  function stepRagdollSink(currentSunk, dt, rate) {
    const s = (typeof currentSunk === 'number' && isFinite(currentSunk)) ? currentSunk : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    const r = (typeof rate === 'number' && isFinite(rate)) ? rate : RAGDOLL_SINK_RATE;
    return s + delta * r;
  }

  function ragdollDropOffsetY(sunk, scale) {
    const s = (typeof sunk === 'number' && isFinite(sunk)) ? sunk : 0;
    const sc = (typeof scale === 'number' && isFinite(scale)) ? scale : RAGDOLL_DROP_SCALE;
    return s * sc;
  }

  function isRagdollExpired(sunk, maxSunk) {
    const s = (typeof sunk === 'number' && isFinite(sunk)) ? sunk : 0;
    const m = (typeof maxSunk === 'number' && isFinite(maxSunk)) ? maxSunk : RAGDOLL_SINK_MAX;
    return s > m;
  }

  // ---- Procedural Box-Man Enemy Animation Kinematics ----
  const ENEMY_PROC_WALK_THRESHOLD = 0.3;
  const ENEMY_PROC_BASE_FREQ = 9;

  function enemyProcWalkSpeed(moveSpeed, kind, threshold) {
    const spd = (typeof moveSpeed === 'number' && isFinite(moveSpeed)) ? moveSpeed : 0;
    const th = (typeof threshold === 'number' && isFinite(threshold)) ? threshold : ENEMY_PROC_WALK_THRESHOLD;
    if (spd <= th) return 0;
    const runnerMul = kind === 0 ? 1.5 : 1;
    return ENEMY_PROC_BASE_FREQ * (spd / 3.2) * runnerMul;
  }

  function stepEnemyProcWalkPhase(phase, speed, dt) {
    const p = (typeof phase === 'number' && isFinite(phase)) ? phase : 0;
    const s = (typeof speed === 'number' && isFinite(speed)) ? speed : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    return p + s * delta;
  }

  function enemyProcLimbSwing(phase, isMoving) {
    const p = (typeof phase === 'number' && isFinite(phase)) ? phase : 0;
    const amp = isMoving ? 0.55 : 0.06;
    return Math.sin(p) * amp;
  }

  function enemyProcPitchTrack(playerEyeY, enemyY, dist) {
    const py = (typeof playerEyeY === 'number' && isFinite(playerEyeY)) ? playerEyeY : 0;
    const ey = (typeof enemyY === 'number' && isFinite(enemyY)) ? enemyY : 0;
    const d = (typeof dist === 'number' && isFinite(dist)) ? Math.max(0.1, dist) : 1;
    return Math.atan2(py - (ey + 1.5), d);
  }

  function enemyProcPose(phase, moveSpeed, kind, dist, playerEyeY, enemyY, out) {
    const o = out || { legLRotX: 0, legRRotX: 0, armLRotX: 0, armRRotX: 0, bodyRotX: 0, bodyPosY: 0, moving: false };
    const spd = (typeof moveSpeed === 'number' && isFinite(moveSpeed)) ? moveSpeed : 0;
    const moving = spd > ENEMY_PROC_WALK_THRESHOLD;
    const p = (typeof phase === 'number' && isFinite(phase)) ? phase : 0;
    const swing = enemyProcLimbSwing(p, moving);
    o.moving = moving;
    o.legLRotX = swing;
    o.legRRotX = -swing;
    o.armLRotX = -swing * 0.7;
    o.armRRotX = swing * 0.7 - (kind === 1 ? 0.5 : 0);
    const pitch = enemyProcPitchTrack(playerEyeY, enemyY, dist);
    let bRotX = kind === 1 ? -pitch * 0.25 : 0;
    if (kind === 0) bRotX += 0.12;
    o.bodyRotX = bRotX;
    o.bodyPosY = moving ? Math.abs(Math.cos(p)) * 0.03 : 0;
    return o;
  }

  // ---- Combat Balance & Wave Pacing Dynamics ----
  const WAVE_SPAWN_PRESSURE_QUEUE = 18;
  const WAVE_SPAWN_SWEET_SPOT = 26;
  const WAVE_SPAWN_JITTER = 6;
  const AMMO_RELIEF_DRY_THRESHOLD = 5;
  const AMMO_RELIEF_COOLDOWN = 18;
  const ENEMY_BULLET_DELAY_FACTOR = 2.2;
  const ENEMY_BULLET_MAX_DELAY_MS = 300;
  const ENEMY_MELEE_WINDUP_BASE = 0.25;
  const ENEMY_MELEE_WINDUP_RANGE = 0.45;
  const ENEMY_MELEE_FOLLOW_REACH_PADDING = 0.35;
  const ENEMY_STUN_SPEED_MUL = 0.35;
  const ENEMY_BLIND_YAW_RATE = 1.6;
  const ENEMY_FALL_SPEED = 6;
  const SLIDE_CANCEL_MIN_T = 0.12;
  const SLIDE_TIMEOUT_T = 0.9;
  const SLIDE_STOP_MIN_T = 0.25;
  const STATION_HOLD_DECAY_RATE = 3;

  function waveSpawnPressure(waveQueue, queueThreshold) {
    const q = (typeof waveQueue === 'number' && isFinite(waveQueue)) ? Math.max(0, waveQueue) : 0;
    const thresh = (typeof queueThreshold === 'number' && isFinite(queueThreshold)) ? Math.max(1, queueThreshold) : WAVE_SPAWN_PRESSURE_QUEUE;
    return Math.min(1, q / thresh);
  }

  function waveSpawnBurstCount(waveQueue, canSpawn, pressure, randomVal) {
    const q = (typeof waveQueue === 'number' && isFinite(waveQueue)) ? Math.max(0, waveQueue) : 0;
    const maxCan = (typeof canSpawn === 'number' && isFinite(canSpawn)) ? Math.max(0, canSpawn) : 0;
    const press = (typeof pressure === 'number' && isFinite(pressure)) ? Math.max(0, Math.min(1, pressure)) : 0;
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    const randBase = Math.floor(Math.min(0.9999, r) * 2);
    const burstSize = randBase + 3 + Math.round(press * 3);
    return Math.min(burstSize, q, maxCan);
  }

  function waveSpawnDelay(pressure, randomVal) {
    const press = (typeof pressure === 'number' && isFinite(pressure)) ? Math.max(0, Math.min(1, pressure)) : 0;
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    return (2.5 - press * 1.4) + r * 1.2;
  }

  function spawnCandidateScore(dist, sweetSpot, randomVal) {
    const d = (typeof dist === 'number' && isFinite(dist)) ? dist : 0;
    const target = (typeof sweetSpot === 'number' && isFinite(sweetSpot)) ? sweetSpot : WAVE_SPAWN_SWEET_SPOT;
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    const res = -Math.abs(d - target) - r * WAVE_SPAWN_JITTER;
    return res === 0 ? 0 : res;
  }

  function stepAmmoReliefTimer(dryT, dt, hasAmmo) {
    if (hasAmmo) return 0;
    const cur = (typeof dryT === 'number' && isFinite(dryT)) ? Math.max(0, dryT) : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? Math.max(0, dt) : 0;
    return cur + delta;
  }

  function isAmmoReliefNeeded(waveActive, isDead, dryT, gameT, nextCacheT, threshold) {
    if (!waveActive || isDead) return false;
    const t = (typeof dryT === 'number' && isFinite(dryT)) ? dryT : 0;
    const th = (typeof threshold === 'number' && isFinite(threshold)) ? threshold : AMMO_RELIEF_DRY_THRESHOLD;
    const gT = (typeof gameT === 'number' && isFinite(gameT)) ? gameT : 0;
    const nextT = (typeof nextCacheT === 'number' && isFinite(nextCacheT)) ? nextCacheT : 0;
    return t > th && gT > nextT;
  }

  function enemyBulletTravelDelay(dist, factor, maxDelay) {
    const d = (typeof dist === 'number' && isFinite(dist)) ? Math.max(0, dist) : 0;
    const f = (typeof factor === 'number' && isFinite(factor)) ? factor : ENEMY_BULLET_DELAY_FACTOR;
    const cap = (typeof maxDelay === 'number' && isFinite(maxDelay)) ? maxDelay : ENEMY_BULLET_MAX_DELAY_MS;
    return Math.min(cap, d * f);
  }

  function enemyRangedNextShot(currentT, rangedRof, randomVal) {
    const t = (typeof currentT === 'number' && isFinite(currentT)) ? currentT : 0;
    const rof = (typeof rangedRof === 'number' && isFinite(rangedRof)) ? rangedRof : 1.35;
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    return t + rof * (0.75 + r * 0.5);
  }

  function enemyMeleeWindup(randomVal) {
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    return ENEMY_MELEE_WINDUP_BASE + r * ENEMY_MELEE_WINDUP_RANGE;
  }

  function enemyAttackReadyTime(currentT, baseCooldown, randomVal) {
    const t = (typeof currentT === 'number' && isFinite(currentT)) ? currentT : 0;
    const cd = (typeof baseCooldown === 'number' && isFinite(baseCooldown)) ? baseCooldown : 1.1;
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    return t + cd + r * 0.5;
  }

  function enemyKillImpulse(lastHitForce, isHead, randomVal, out) {
    const o = out || { force: 0, y: 0 };
    const forceVal = (typeof lastHitForce === 'number' && isFinite(lastHitForce)) ? Math.max(0, lastHitForce) : 20;
    o.force = Math.min(0.085, 0.012 + forceVal * 0.00035);
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? Math.max(0, Math.min(1, randomVal)) : 0.5;
    o.y = (isHead ? 0.030 : 0.016) + r * 0.008;
    return o;
  }

  function enemyStunSpeedMultiplier(baseSpeedMul, isStunned) {
    const base = (typeof baseSpeedMul === 'number' && isFinite(baseSpeedMul)) ? baseSpeedMul : 1;
    return isStunned ? base * ENEMY_STUN_SPEED_MUL : base;
  }

  function stepEnemyBlindYaw(yaw, dt, rate) {
    const y = (typeof yaw === 'number' && isFinite(yaw)) ? yaw : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    const r = (typeof rate === 'number' && isFinite(rate)) ? rate : ENEMY_BLIND_YAW_RATE;
    return y + delta * r;
  }

  function stepEnemyFallY(currentY, floorY, dt, fallSpeed, stepH) {
    const cy = (typeof currentY === 'number' && isFinite(currentY)) ? currentY : 0;
    const fy = (typeof floorY === 'number' && isFinite(floorY)) ? floorY : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    const spd = (typeof fallSpeed === 'number' && isFinite(fallSpeed)) ? fallSpeed : ENEMY_FALL_SPEED;
    const step = (typeof stepH === 'number' && isFinite(stepH)) ? stepH : 0.60;
    if (fy < cy) {
      const needed = cy - fy;
      return cy - Math.min(needed, delta * spd);
    } else if (fy > cy && (fy - cy) <= step) {
      const needed = fy - cy;
      return cy + Math.min(needed, delta * spd);
    }
    return cy;
  }

  function canSlideCancel(slideT, minDuration) {
    const t = (typeof slideT === 'number' && isFinite(slideT)) ? slideT : 0;
    const minT = (typeof minDuration === 'number' && isFinite(minDuration)) ? minDuration : SLIDE_CANCEL_MIN_T;
    return t > minT;
  }

  function isSlideExpired(slideT, isCrouchHeld, hasMoveInput, maxDuration, minMoveDuration) {
    const t = (typeof slideT === 'number' && isFinite(slideT)) ? slideT : 0;
    const maxT = (typeof maxDuration === 'number' && isFinite(maxDuration)) ? maxDuration : SLIDE_TIMEOUT_T;
    const minMoveT = (typeof minMoveDuration === 'number' && isFinite(minMoveDuration)) ? minMoveDuration : SLIDE_STOP_MIN_T;
    if (t > maxT) return true;
    if (!isCrouchHeld) return true;
    if (!hasMoveInput && t > minMoveT) return true;
    return false;
  }

  function stepStationHold(holdT, isHolding, dt, decayRate, buyHold) {
    const cur = (typeof holdT === 'number' && isFinite(holdT)) ? Math.max(0, holdT) : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    const maxHold = (typeof buyHold === 'number' && isFinite(buyHold)) ? buyHold : BUY_HOLD;
    if (isHolding) {
      return Math.min(maxHold, cur + delta);
    }
    const dec = (typeof decayRate === 'number' && isFinite(decayRate)) ? decayRate : STATION_HOLD_DECAY_RATE;
    return Math.max(0, cur - delta * dec);
  }

  function weaponFireInterval(rpm) {
    const r = (typeof rpm === 'number' && isFinite(rpm) && rpm > 0) ? rpm : 600;
    return 60 / r;
  }

  // ---- Ballistic surface impact and tactical weapon acoustics (v101) ----
  const SPATIAL_IMPACT_MAX_DIST = 55;
  const SNIPER_BOLT_DELAY_MS = 280;

  function surfaceImpactSound(surface) {
    if (surface === 'metal') return 'impact_metal';
    if (surface === 'wood') return 'impact_wood';
    if (surface === 'glass') return 'impact_glass';
    if (surface === 'ground') return 'impact_ground';
    return 'impact';
  }

  function sniperBoltSound() {
    return 'sniper_bolt';
  }

  function streakReadySound(key) {
    return 'streak_ready';
  }

  function fieldUpgradeReadySound() {
    return 'field_ready';
  }

  function secondWindSound() {
    return 'second_wind';
  }

  function objectiveCompleteSound() {
    return 'objective_complete';
  }

  function weaponDrawSound(weaponType) {
    if (weaponType === 'SR' || weaponType === 'BR') return 'draw_heavy';
    if (weaponType === 'SMG') return 'draw_light';
    return 'draw';
  }

  // ---- Ballistic bullet hole decals, viewmodel muzzle flash dynamics, and tracer kinematics (v103) ----
  const DECAL_MAX = 48;
  const DECAL_LIFETIME = 25;
  const DECAL_FADE_DURATION = 3.5;
  const DECAL_BASE_RADIUS = 0.075;
  const DECAL_STANDOFF = 0.012;
  const MUZZLE_FLASH_SUPPRESSED_SCALE = 0.22;
  const TRACER_LIFETIME = 0.065;

  function decalCaliberScale(weaponType) {
    if (weaponType === 'SMG') return 0.72;
    if (weaponType === 'BR') return 1.25;
    if (weaponType === 'SR') return 1.5;
    return 1.0;
  }

  function decalSurfaceMultiplier(surface) {
    if (surface === 'glass') return 1.25;
    if (surface === 'wood') return 1.1;
    if (surface === 'metal') return 0.82;
    return 1.0;
  }

  function decalScale(weaponType, surface, life, maxLife, fadeDuration) {
    const cal = decalCaliberScale(weaponType);
    const surf = decalSurfaceMultiplier(surface);
    const base = cal * surf;
    const maxL = (typeof maxLife === 'number' && isFinite(maxLife) && maxLife > 0) ? maxLife : DECAL_LIFETIME;
    const curL = (typeof life === 'number' && isFinite(life)) ? Math.max(0, Math.min(maxL, life)) : 0;
    const fade = (typeof fadeDuration === 'number' && isFinite(fadeDuration) && fadeDuration > 0) ? fadeDuration : DECAL_FADE_DURATION;
    if (curL <= 0) return 0.001;
    if (curL < fade) {
      const t = curL / fade;
      const decay = 1 - (1 - t) * (1 - t) * (1 - t);
      return Math.max(0.001, base * decay);
    }
    return base;
  }

  function decalRotationAngle(randomVal) {
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? randomVal : 0;
    return (r % 1) * Math.PI * 2;
  }

  function stepDecalLife(life, dt) {
    const cur = (typeof life === 'number' && isFinite(life)) ? life : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    return Math.max(0, cur - delta);
  }

  function isDecalExpired(life) {
    return !(typeof life === 'number' && isFinite(life) && life > 0);
  }

  function muzzleFlashRotation(randomVal) {
    const r = (typeof randomVal === 'number' && isFinite(randomVal)) ? randomVal : 0;
    return (r % 1) * Math.PI;
  }

  function muzzleFlashBaseScale(weaponType, isSuppressed, randK, randZ, out) {
    const rk = (typeof randK === 'number' && isFinite(randK)) ? randK : 0.5;
    const rz = (typeof randZ === 'number' && isFinite(randZ)) ? randZ : 0.5;
    const res = out || { k: 1, z: 1 };
    if (isSuppressed) {
      res.k = MUZZLE_FLASH_SUPPRESSED_SCALE * (0.8 + rk * 0.4);
      res.z = MUZZLE_FLASH_SUPPRESSED_SCALE * (0.8 + rz * 0.4);
      return res;
    }
    if (weaponType === 'SMG') {
      res.k = 0.65 + rk * 0.25;
      res.z = 0.60 + rz * 0.30;
    } else if (weaponType === 'BR') {
      res.k = 1.15 + rk * 0.45;
      res.z = 1.10 + rz * 0.50;
    } else if (weaponType === 'SR') {
      res.k = 1.50 + rk * 0.50;
      res.z = 1.40 + rz * 0.60;
    } else {
      res.k = 0.85 + rk * 0.35;
      res.z = 0.80 + rz * 0.40;
    }
    return res;
  }

  function stepMuzzleFlashScale(baseK, baseZ, flashT, out) {
    const res = out || { x: 1, y: 1, z: 1 };
    const ft = (typeof flashT === 'number' && isFinite(flashT)) ? Math.max(0, Math.min(1, flashT)) : 0;
    const kMul = Math.min(1, ft * 1.25);
    const zMul = Math.min(1, ft * 1.1);
    const bk = (typeof baseK === 'number' && isFinite(baseK)) ? baseK : 1;
    const bz = (typeof baseZ === 'number' && isFinite(baseZ)) ? baseZ : 1;
    res.x = bk * kMul;
    res.y = bk * kMul;
    res.z = bz * zMul;
    return res;
  }

  function tracerThicknessScale(life, maxLife) {
    const maxL = (typeof maxLife === 'number' && isFinite(maxLife) && maxLife > 0) ? maxLife : TRACER_LIFETIME;
    const curL = (typeof life === 'number' && isFinite(life)) ? Math.max(0, Math.min(maxL, life)) : 0;
    const t = curL / maxL;
    return Math.max(0.1, t);
  }

  function tracerColor(isEnemy) {
    return isEnemy ? 0xff8844 : 0xffe9a0;
  }

  // ---- Locomotion velocity synthesis & collision relevance (perf win) --------
  function movementTargetVelocity(ix, iz, yaw, speed, out) {
    const inputX = (typeof ix === 'number' && isFinite(ix)) ? ix : 0;
    const inputZ = (typeof iz === 'number' && isFinite(iz)) ? iz : 0;
    const y = (typeof yaw === 'number' && isFinite(yaw)) ? yaw : 0;
    const spd = (typeof speed === 'number' && isFinite(speed) && speed >= 0) ? speed : 0;
    const sy = Math.sin(y), cy = Math.cos(y);
    const vx = (inputX * cy - inputZ * sy) * spd;
    const vz = (-inputX * sy - inputZ * cy) * spd;
    if (out && typeof out === 'object') {
      out.x = vx;
      out.z = vz;
      return out;
    }
    return { x: vx, z: vz };
  }

  // ---- HUD canvas redraw throttling & alive enemy counting (perf win) --------
  const HUD_REDRAW_INTERVAL = 0.05;      // 20 Hz base throttle
  const HUD_FLICK_YAW_THRESHOLD = 0.15;   // ~8.6 degrees rotation flick trigger
  const HUD_FLICK_COOLDOWN = 0.12;       // minimum interval between flick-forced redraws

  function shouldRedrawHudCanvas(elapsedT, yawMoved, flickElapsed, interval, flickThreshold, flickCooldown) {
    const elapsed = (typeof elapsedT === 'number' && isFinite(elapsedT)) ? elapsedT : 0;
    const ym = (typeof yawMoved === 'number' && isFinite(yawMoved)) ? Math.abs(yawMoved) : 0;
    const fe = (typeof flickElapsed === 'number' && isFinite(flickElapsed)) ? flickElapsed : 0;
    const int = (typeof interval === 'number' && isFinite(interval) && interval > 0) ? interval : HUD_REDRAW_INTERVAL;
    const th = (typeof flickThreshold === 'number' && isFinite(flickThreshold) && flickThreshold > 0) ? flickThreshold : HUD_FLICK_YAW_THRESHOLD;
    const cd = (typeof flickCooldown === 'number' && isFinite(flickCooldown) && flickCooldown > 0) ? flickCooldown : HUD_FLICK_COOLDOWN;
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
    const n = (typeof count === 'number' && isFinite(count) && count >= 0) ? Math.floor(count) : 0;
    return n + ' HOSTILE' + (n === 1 ? '' : 'S');
  }

  // ---- Viewmodel optics FOV & responsive narrow-screen centering (perf win) ---
  function gunCameraFov(adsAmount, weaponType) {
    const ads = (typeof adsAmount === 'number' && isFinite(adsAmount)) ? Math.max(0, Math.min(1, adsAmount)) : 0;
    const isSr = weaponType === 'SR';
    return 58 - ads * (isSr ? 18 : 12);
  }

  function viewmodelNarrowOffset(aspectRatio, posX, hipK) {
    const asp = (typeof aspectRatio === 'number' && isFinite(aspectRatio) && aspectRatio > 0) ? aspectRatio : 1.0;
    const px = (typeof posX === 'number' && isFinite(posX)) ? posX : 0;
    const hk = (typeof hipK === 'number' && isFinite(hipK)) ? Math.max(0, Math.min(1, hipK)) : 1.0;
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
    const y = (typeof posY === 'number' && isFinite(posY)) ? posY : 0;
    return y + (kind === 2 ? 2.3 : 1.85);
  }

  function enemySpawnSpeedMultiplier(rand, isElite, specialSpeedMul) {
    const r = (typeof rand === 'number' && isFinite(rand)) ? Math.max(0, Math.min(1, rand)) : 0.5;
    const base = 0.85 + r * 0.3;
    const eliteK = isElite ? ELITE.speedMul : 1.0;
    const specK = (typeof specialSpeedMul === 'number' && isFinite(specialSpeedMul) && specialSpeedMul > 0) ? specialSpeedMul : 1.0;
    return base * eliteK * specK;
  }

  function isEnemyFlanker(kind, waveFlanking, rand) {
    if (kind === 4) return true;
    if (kind === 3 || kind === 5) return false;
    const r = (typeof rand === 'number' && isFinite(rand)) ? Math.max(0, Math.min(1, rand)) : 0.5;
    return !!waveFlanking && r < 0.45;
  }

  function enemyFallbackVelocity(toX, toZ, strafeDir, out) {
    const tx = (typeof toX === 'number' && isFinite(toX)) ? toX : 0;
    const tz = (typeof toZ === 'number' && isFinite(toZ)) ? toZ : 0;
    const sDir = (typeof strafeDir === 'number' && strafeDir < 0) ? -1 : 1;
    const vx = -tx * 0.8 - tz * 0.6 * sDir;
    const vz = -tz * 0.8 + tx * 0.6 * sDir;
    const l = Math.hypot(vx, vz) || 1;
    const target = (out && typeof out === 'object') ? out : { x: 0, z: 0 };
    target.x = vx / l;
    target.z = vz / l;
    return target;
  }

  function enemyStrafeVelocity(toX, toZ, strafeDir, out) {
    const tx = (typeof toX === 'number' && isFinite(toX)) ? toX : 0;
    const tz = (typeof toZ === 'number' && isFinite(toZ)) ? toZ : 0;
    const sDir = (typeof strafeDir === 'number' && strafeDir < 0) ? -1 : 1;
    const vx = -tz * sDir;
    const vz = tx * sDir;
    const l = Math.hypot(vx, vz) || 1;
    const target = (out && typeof out === 'object') ? out : { x: 0, z: 0 };
    target.x = vx / l;
    target.z = vz / l;
    return target;
  }

  function enemyStrafeDuration(rand) {
    const r = (typeof rand === 'number' && isFinite(rand)) ? Math.max(0, Math.min(1, rand)) : 0.5;
    return 1.5 + r * 2.0;
  }

  function canEnemyThrowGrenade(kind, dist, isPlayerDead) {
    if (isPlayerDead) return false;
    const d = (typeof dist === 'number' && isFinite(dist)) ? dist : 0;
    if (kind === 5) return d > 9 && d < 36;
    if (kind === 1) return d > 8 && d < 32;
    return false;
  }

  function enemyFootstepRate(kind) {
    return kind === 0 ? 1.7 : kind === 2 ? 0.9 : 1.1;
  }

  function enemyFootstepInterval(speedMul) {
    const mul = (typeof speedMul === 'number' && isFinite(speedMul) && speedMul > 0.05) ? speedMul : 1.0;
    return 0.55 / mul;
  }

  function relocateFacingAlignment(toX, toZ, fwdX, fwdZ, rad) {
    const tx = (typeof toX === 'number' && isFinite(toX)) ? toX : 0;
    const tz = (typeof toZ === 'number' && isFinite(toZ)) ? toZ : 0;
    const fx = (typeof fwdX === 'number' && isFinite(fwdX)) ? fwdX : 0;
    const fz = (typeof fwdZ === 'number' && isFinite(fwdZ)) ? fwdZ : 0;
    const r = (typeof rad === 'number' && isFinite(rad) && rad > 0) ? rad : 1;
    return -(tx * fx + tz * fz) / r;
  }

  function relocateCandidateScore(rad, behindAlignment) {
    const r = (typeof rad === 'number' && isFinite(rad)) ? rad : 20;
    const b = (typeof behindAlignment === 'number' && isFinite(behindAlignment)) ? behindAlignment : 0;
    return -Math.abs(r - 20) + b * 5;
  }

  function stepSlideSteering(dirX, dirZ, inputX, yaw, dt, steerRate, out) {
    const dx = (typeof dirX === 'number' && isFinite(dirX)) ? dirX : 0;
    const dz = (typeof dirZ === 'number' && isFinite(dirZ)) ? dirZ : 0;
    const target = (out && typeof out === 'object') ? out : { x: dx, z: dz };
    const ix = (typeof inputX === 'number' && isFinite(inputX)) ? inputX : 0;
    const deltaT = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    if (!ix || deltaT <= 0) {
      target.x = dx;
      target.z = dz;
      return target;
    }
    const rate = (typeof steerRate === 'number' && isFinite(steerRate) && steerRate > 0) ? steerRate : SLIDE_STEER_RATE;
    const y = (typeof yaw === 'number' && isFinite(yaw)) ? yaw : 0;
    const sy = Math.sin(y), cy = Math.cos(y);
    const wx = ix * cy, wz = -ix * sy;
    let nx = dx + wx * rate * deltaT;
    let nz = dz + wz * rate * deltaT;
    const l = Math.hypot(nx, nz) || 1;
    target.x = nx / l;
    target.z = nz / l;
    return target;
  }

  function isTacSprintTriggered(gameT, lastSprintTap, isExhausted, windowSec) {
    const gt = (typeof gameT === 'number' && isFinite(gameT)) ? gameT : 0;
    const lst = (typeof lastSprintTap === 'number' && isFinite(lastSprintTap)) ? lastSprintTap : -99;
    const w = (typeof windowSec === 'number' && isFinite(windowSec) && windowSec > 0) ? windowSec : TAC_TAP_WINDOW;
    return (gt - lst) < w && !isExhausted;
  }

  function stepGrenadeBounceVelocity(vx, vy, vz, bounce, groundedCount, out) {
    const x = (typeof vx === 'number' && isFinite(vx)) ? vx : 0;
    const y = (typeof vy === 'number' && isFinite(vy)) ? vy : 0;
    const z = (typeof vz === 'number' && isFinite(vz)) ? vz : 0;
    const b = (typeof bounce === 'number' && isFinite(bounce) && bounce >= 0) ? bounce : 0.45;
    const gCount = (typeof groundedCount === 'number' && isFinite(groundedCount)) ? groundedCount : 0;
    const target = (out && typeof out === 'object') ? out : { x: x, y: y, z: z };
    target.y = -y * b;
    let latDamp = GRENADE_BOUNCE_LAT_DAMP;
    if (gCount > 1) latDamp *= GRENADE_ROLL_LAT_DAMP;
    target.x = x * latDamp;
    target.z = z * latDamp;
    return target;
  }

  function isGrenadeAtRest(hSpeedSq, vy, posY, groundedCount) {
    const hs = (typeof hSpeedSq === 'number' && isFinite(hSpeedSq)) ? hSpeedSq : 0;
    const yVel = (typeof vy === 'number' && isFinite(vy)) ? vy : 0;
    const yPos = (typeof posY === 'number' && isFinite(posY)) ? posY : 0;
    const gCount = (typeof groundedCount === 'number' && isFinite(groundedCount)) ? groundedCount : 0;
    return gCount > 1 && hs < 0.1 && Math.abs(yVel) < 0.2 && yPos <= 0.12;
  }

  function downBleedoutLabel(remainingSec) {
    const left = Math.max(0, (typeof remainingSec === 'number' && isFinite(remainingSec)) ? remainingSec : 0);
    return 'BLEEDING OUT — ' + left.toFixed(1) + 's';
  }

  function multikillBonus(baseBonus, killStreak) {
    const ks = (typeof killStreak === 'number' && isFinite(killStreak)) ? Math.floor(killStreak) : 0;
    if (ks < 2) return 0;
    const b = (typeof baseBonus === 'number' && isFinite(baseBonus) && baseBonus > 0) ? baseBonus : 60;
    return b * (ks - 1);
  }

  function waveCountdownLabel(waveNum, betweenWaveT) {
    const wn = (typeof waveNum === 'number' && isFinite(waveNum)) ? waveNum : 0;
    const t = (typeof betweenWaveT === 'number' && isFinite(betweenWaveT)) ? betweenWaveT : 0;
    const n = Math.max(1, Math.ceil(t));
    return (wn === 0) ? ('COMBAT IN ' + n) : ('NEXT WAVE IN ' + n);
  }

  function waveBannerLabels(waveNum, isCleared, victoryWave) {
    const n = (typeof waveNum === 'number' && isFinite(waveNum)) ? waveNum : 0;
    const vic = (typeof victoryWave === 'number' && isFinite(victoryWave)) ? victoryWave : 15;
    if (n === 0) {
      return { big: 'GET READY', sub: '' };
    }
    if (isCleared) {
      return { big: 'WAVE ' + n + ' CLEARED', sub: '' };
    }
    return {
      big: 'WAVE ' + n,
      sub: n === vic ? 'FINAL WAVE' : 'HOSTILES INBOUND'
    };
  }

  // ---- Ballistic tracer & impact lifecycle, sentry kinematics, thermite burn (perf win) ----
  const SENTRY_AIM_Y_OFFSET = 1.1;
  const BURN_TICK_INTERVAL = 0.25;

  function stepTracerLife(life, dt) {
    const cur = (typeof life === 'number' && isFinite(life)) ? life : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    return Math.max(0, cur - delta);
  }

  function isTracerExpired(life) {
    return !(typeof life === 'number' && isFinite(life) && life > 0);
  }

  function stepImpactLife(life, dt) {
    const cur = (typeof life === 'number' && isFinite(life)) ? life : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    return Math.max(0, cur - delta);
  }

  function isImpactExpired(life) {
    return !(typeof life === 'number' && isFinite(life) && life > 0);
  }

  function sentryTargetYaw(dx, dz) {
    const x = (typeof dx === 'number' && isFinite(dx)) ? dx : 0;
    const z = (typeof dz === 'number' && isFinite(dz)) ? dz : 0;
    return Math.atan2(x, z) + Math.PI;
  }

  function stepSentryTimers(t, cd, dt, out) {
    const res = out || { t: 0, cd: 0, expired: false, readyToFire: false };
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    const curT = (typeof t === 'number' && isFinite(t)) ? t - delta : 0;
    const curCd = (typeof cd === 'number' && isFinite(cd)) ? cd - delta : 0;
    res.t = curT;
    res.cd = curCd;
    res.expired = curT <= 0;
    res.readyToFire = curCd <= 0;
    return res;
  }

  function sentryAimTargetY(enemyY, offset) {
    const base = (typeof enemyY === 'number' && isFinite(enemyY)) ? enemyY : 0;
    const off = (typeof offset === 'number' && isFinite(offset)) ? offset : SENTRY_AIM_Y_OFFSET;
    return base + off;
  }

  function burnTickDamage(dps, interval) {
    const d = (typeof dps === 'number' && isFinite(dps)) ? Math.max(0, dps) : 0;
    const i = (typeof interval === 'number' && isFinite(interval)) ? Math.max(0, interval) : BURN_TICK_INTERVAL;
    return d * i;
  }

  function isPointInBurnRadius(px, pz, bx, bz, radius) {
    const r = (typeof radius === 'number' && isFinite(radius)) ? radius : 0;
    if (r <= 0) return false;
    return horizDist(px, pz, bx, bz) < r;
  }

  // ---- Ballistic spread, aim assist dynamics, enemy AI state kinetics, mantle & grenade loft balance rules (v110 balance tuning) ----
  const SPREAD_LONGITUDINAL_SCALE = 0.3;
  const AIM_ASSIST_HEAD_THRESHOLD = 0.55;
  const AIM_ASSIST_HEAD_PRIORITY = 1.8;
  const AIM_ASSIST_PULL_WEIGHT = 0.25;
  const AIM_ASSIST_TRACK_RATE = 3.5;
  const AIM_ASSIST_CHEST_OFFSET = 1.0;
  const AIM_ASSIST_HEAD_OFFSET = 1.68;
  const BULLET_MAGNET_Y_OFFSET = 1.1;
  const ENEMY_SPAWN_DURATION = 0.5;
  const ENEMY_STRAFE_MAX_T = 6.0;
  const GRENADIER_STRAFE_RANGE = 34;
  const GRENADIER_STRAFE_DURATION = 2.5;
  const RIFLEMAN_STRAFE_DURATION = 2.0;
  const RIFLEMAN_LOS_RETRY_DELAY = 0.4;
  const FLANK_STEER_WEIGHT = 0.45;
  const ENEMY_OVERLAP_MIN_DIST = 0.05;
  const ENEMY_SHOT_CHEST_Y_OFFSET = 0.2;
  const MANTLE_DURATION = 0.35;
  const MANTLE_COYOTE_GRACE = 0.12;
  const GRENADE_PITCH_LOFT = 0.45;
  const GRENADE_COOLDOWN = 0.8;
  const TACTICAL_SPEED_MUL = 1.15;
  const PLAYER_FLASH_SELF_MUL = 0.6;

  function ballisticSpreadVector(dirX, dirY, dirZ, spread, randX, randY, randZ, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const s = typeof spread === 'number' && isFinite(spread) ? Math.max(0, spread) : 0;
    const rx = typeof randX === 'number' && isFinite(randX) ? randX : 0.5;
    const ry = typeof randY === 'number' && isFinite(randY) ? randY : 0.5;
    const rz = typeof randZ === 'number' && isFinite(randZ) ? randZ : 0.5;
    const jx = (rx - 0.5) * 2 * s;
    const jy = (ry - 0.5) * 2 * s;
    const jz = (rz - 0.5) * 2 * s * SPREAD_LONGITUDINAL_SCALE;
    const x = (typeof dirX === 'number' && isFinite(dirX) ? dirX : 0) + jx;
    const y = (typeof dirY === 'number' && isFinite(dirY) ? dirY : 0) + jy;
    const z = (typeof dirZ === 'number' && isFinite(dirZ) ? dirZ : -1) + jz;
    const len = Math.hypot(x, y, z) || 1;
    o.x = x / len;
    o.y = y / len;
    o.z = z / len;
    return o;
  }

  function bulletPenetrationPower(weaponType, weaponPenModifier) {
    const base = penetrationPower(weaponType);
    const mul = typeof weaponPenModifier === 'number' && isFinite(weaponPenModifier) && weaponPenModifier > 0
      ? weaponPenModifier : 1;
    return base * mul;
  }

  function isAimAssistHeadCandidate(headAngle, bestAngle, threshold) {
    const ha = typeof headAngle === 'number' && isFinite(headAngle) ? headAngle : Infinity;
    const ba = typeof bestAngle === 'number' && isFinite(bestAngle) ? bestAngle : 0;
    const th = typeof threshold === 'number' && isFinite(threshold) ? threshold : AIM_ASSIST_HEAD_THRESHOLD;
    return ha < ba * th;
  }

  function aimAssistAngularDeltas(targetFwdX, targetFwdY, targetFwdZ, curFwdX, curFwdY, curFwdZ, out) {
    const o = out || { yawDelta: 0, pitchDelta: 0 };
    const tx = typeof targetFwdX === 'number' && isFinite(targetFwdX) ? targetFwdX : 0;
    const ty = typeof targetFwdY === 'number' && isFinite(targetFwdY) ? targetFwdY : 0;
    const tz = typeof targetFwdZ === 'number' && isFinite(targetFwdZ) ? targetFwdZ : -1;
    const cx = typeof curFwdX === 'number' && isFinite(curFwdX) ? curFwdX : 0;
    const cy = typeof curFwdY === 'number' && isFinite(curFwdY) ? curFwdY : 0;
    const cz = typeof curFwdZ === 'number' && isFinite(curFwdZ) ? curFwdZ : -1;
    let dyaw = Math.atan2(-tx, -tz) - Math.atan2(-cx, -cz);
    const dpitch = Math.asin(Math.max(-1, Math.min(1, ty))) - Math.asin(Math.max(-1, Math.min(1, cy)));
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    o.yawDelta = dyaw;
    o.pitchDelta = dpitch;
    return o;
  }

  function stepAimAssistLook(yaw, pitch, yawDelta, pitchDelta, dt, trackRate, out) {
    const o = out || { yaw: 0, pitch: 0 };
    const rate = typeof trackRate === 'number' && isFinite(trackRate) ? trackRate : AIM_ASSIST_TRACK_RATE;
    const dSec = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const y = typeof yaw === 'number' && isFinite(yaw) ? yaw : 0;
    const p = typeof pitch === 'number' && isFinite(pitch) ? pitch : 0;
    const yd = typeof yawDelta === 'number' && isFinite(yawDelta) ? yawDelta : 0;
    const pd = typeof pitchDelta === 'number' && isFinite(pitchDelta) ? pitchDelta : 0;
    o.yaw = y + yd * rate * dSec;
    o.pitch = Math.max(-1.45, Math.min(1.45, p + pd * rate * dSec));
    return o;
  }

  function enemyAiNextState(kind, curState, stateT, dist, hasLOS, rangedRange, preferredRange, out) {
    const o = out || { state: 'chase', stateT: 0, strafeT: 0, resetStateT: false };
    const k = typeof kind === 'number' ? kind : 0;
    const s = curState || 'chase';
    const st = typeof stateT === 'number' && isFinite(stateT) ? stateT : 0;
    const d = typeof dist === 'number' && isFinite(dist) ? dist : 0;
    const los = !!hasLOS;
    const rr = typeof rangedRange === 'number' && isFinite(rangedRange) ? rangedRange : 44;
    const pr = typeof preferredRange === 'number' && isFinite(preferredRange) ? preferredRange : 16;

    o.state = s;
    o.strafeT = 0;
    o.resetStateT = false;

    if (s === 'spawn') {
      if (st > ENEMY_SPAWN_DURATION) {
        o.state = 'chase';
        o.resetStateT = true;
      }
    } else if (k === 1) {
      if (d < rr && los) {
        if (s !== 'strafe' && s !== 'shoot') {
          o.state = 'strafe';
          o.strafeT = RIFLEMAN_STRAFE_DURATION;
        }
      } else if (s !== 'chase') {
        o.state = 'chase';
      }
      if (o.state === 'strafe' && st > ENEMY_STRAFE_MAX_T) {
        o.state = 'chase';
        o.resetStateT = true;
      }
    } else if (k === 5) {
      if (d < pr) {
        o.state = 'fallback';
      } else if (d < GRENADIER_STRAFE_RANGE && los) {
        if (s !== 'strafe') {
          o.state = 'strafe';
          o.strafeT = GRENADIER_STRAFE_DURATION;
        }
      } else {
        o.state = 'chase';
      }
    } else {
      o.state = 'chase';
    }
    return o;
  }

  function stepFlankVelocity(mvx, mvz, strafeDir, bias, out) {
    const o = out || { x: 0, z: 0 };
    const rawBias = typeof bias === 'number' && isFinite(bias) ? bias : 0;
    const b = Math.max(0, Math.min(1, rawBias * FLANK_STEER_WEIGHT));
    const vx = typeof mvx === 'number' && isFinite(mvx) ? mvx : 0;
    const vz = typeof mvz === 'number' && isFinite(mvz) ? mvz : 0;
    if (b <= 0.001) {
      o.x = vx;
      o.z = vz;
      return o;
    }
    const sDir = strafeDir === -1 ? -1 : 1;
    const px = -vz * sDir;
    const pz = vx * sDir;
    const nx = vx * (1 - b) + px * b;
    const nz = vz * (1 - b) + pz * b;
    const len = Math.hypot(nx, nz) || 1;
    o.x = nx / len;
    o.z = nz / len;
    return o;
  }

  function playerPushoutOffset(enemyX, enemyZ, playerX, playerZ, enemyYaw, dist, stopDist, out) {
    const o = out || { pushX: 0, pushZ: 0, applied: false };
    const d = typeof dist === 'number' && isFinite(dist) ? dist : 0;
    const sd = typeof stopDist === 'number' && isFinite(stopDist) ? stopDist : 1.9;
    const overlap = sd - d;
    if (overlap <= 0) {
      o.pushX = 0;
      o.pushZ = 0;
      o.applied = false;
      return o;
    }
    let nx, nz;
    if (d > ENEMY_OVERLAP_MIN_DIST) {
      nx = (enemyX - playerX) / d;
      nz = (enemyZ - playerZ) / d;
    } else {
      const yaw = typeof enemyYaw === 'number' && isFinite(enemyYaw) ? enemyYaw : 0;
      nx = -Math.sin(yaw);
      nz = -Math.cos(yaw);
    }
    o.pushX = nx * overlap;
    o.pushZ = nz * overlap;
    o.applied = true;
    return o;
  }

  function enemyAimTargetY(playerPosY, chestOffset) {
    const py = typeof playerPosY === 'number' && isFinite(playerPosY) ? playerPosY : 1.7;
    const off = typeof chestOffset === 'number' && isFinite(chestOffset) ? chestOffset : ENEMY_SHOT_CHEST_Y_OFFSET;
    return py - off;
  }

  function stepMantleProgress(mantleT, dt, duration) {
    const dur = typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : MANTLE_DURATION;
    const t = typeof mantleT === 'number' && isFinite(mantleT) ? mantleT : dur;
    const d = typeof dt === 'number' && isFinite(dt) ? Math.max(0, dt) : 0;
    const remaining = Math.max(0, t - d);
    const k = Math.max(0, Math.min(1, 1 - remaining / dur));
    return { remainingT: remaining, progressK: k, completed: remaining === 0 };
  }

  function grenadeThrowVelocity(fwdX, fwdY, fwdZ, speed, loft, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const l = typeof loft === 'number' && isFinite(loft) ? loft : GRENADE_PITCH_LOFT;
    const spd = typeof speed === 'number' && isFinite(speed) ? Math.max(0, speed) : 9.5;
    const vx = typeof fwdX === 'number' && isFinite(fwdX) ? fwdX : 0;
    const vy = (typeof fwdY === 'number' && isFinite(fwdY) ? fwdY : 0) + l;
    const vz = typeof fwdZ === 'number' && isFinite(fwdZ) ? fwdZ : -1;
    const len = Math.hypot(vx, vy, vz) || 1;
    o.x = (vx / len) * spd;
    o.y = (vy / len) * spd;
    o.z = (vz / len) * spd;
    return o;
  }

  function playerSelfFlashDuration(flashStrength, baseDur, selfMultiplier) {
    const mul = typeof selfMultiplier === 'number' && isFinite(selfMultiplier) ? selfMultiplier : PLAYER_FLASH_SELF_MUL;
    const dur = typeof baseDur === 'number' && isFinite(baseDur) ? baseDur * mul : 2.5 * mul;
    return flashDuration(flashStrength, dur);
  }

  // ---- Tactical Minimap Deployables & Drops, Dynamic Grenade Danger Ring & Thermite Burn VFX (v112 Visual Polish) ----
  const GRENADE_RING_BASE_OPACITY = 0.32;
  const GRENADE_RING_MAX_OPACITY = 0.78;
  const MINIMAP_SENTRY_COLOR = '#50b4ff';
  const MINIMAP_MUNITIONS_COLOR = '#8fd66a';
  const MINIMAP_PICKUP_AMMO_COLOR = '#ffd24a';
  const MINIMAP_PICKUP_MED_COLOR = '#4fd08a';
  const MINIMAP_PICKUP_POWER_COLOR = '#d070ff';
  const MINIMAP_SENTRY_RADIUS = 3.2;
  const MINIMAP_MUNITIONS_SIZE = 4.5;
  const MINIMAP_PICKUP_BASE_RADIUS = 2.2;
  const BURN_PATCH_HEAT_FLICKER_FREQ = 12;

  function grenadeDangerRingOpacity(fuse, restFuse) {
    if (typeof fuse !== 'number' || !isFinite(fuse) || fuse <= 0) return 0;
    if (fuse > 1.6) return GRENADE_RING_BASE_OPACITY;
    const urgency = 1 - Math.max(0, fuse / 1.6);
    const freq = 4 + urgency * 6;
    const pulse = Math.sin((1.6 - fuse) * freq * Math.PI * 2) * 0.5 + 0.5;
    const dynamicPeak = GRENADE_RING_BASE_OPACITY + (GRENADE_RING_MAX_OPACITY - GRENADE_RING_BASE_OPACITY) * urgency;
    return Math.max(0.12, GRENADE_RING_BASE_OPACITY + (dynamicPeak - GRENADE_RING_BASE_OPACITY) * pulse);
  }

  function burnPatchPulsingOpacity(remainingT, totalLife, maxOpacity) {
    if (typeof remainingT !== 'number' || !isFinite(remainingT) || remainingT <= 0) return 0;
    const life = typeof totalLife === 'number' && isFinite(totalLife) && totalLife > 0 ? totalLife : 1.0;
    const maxO = typeof maxOpacity === 'number' && isFinite(maxOpacity) ? maxOpacity : 0.5;
    const baseDecay = Math.max(0, Math.min(1, remainingT / life));
    const shimmer = Math.sin(remainingT * BURN_PATCH_HEAT_FLICKER_FREQ) * 0.08 + Math.cos(remainingT * 19) * 0.05;
    return Math.max(0, Math.min(1, maxO * (baseDecay + shimmer * baseDecay)));
  }

  function burnPatchFlameStrength(remainingT, totalLife) {
    if (typeof remainingT !== 'number' || !isFinite(remainingT) || remainingT <= 0) return 0;
    const life = typeof totalLife === 'number' && isFinite(totalLife) && totalLife > 0 ? totalLife : 1.0;
    return Math.max(0, Math.min(1, remainingT / life));
  }

  function minimapPickupColor(kind) {
    if (kind === 'ammo') return MINIMAP_PICKUP_AMMO_COLOR;
    if (kind === 'med') return MINIMAP_PICKUP_MED_COLOR;
    if (kind === 'power') return MINIMAP_PICKUP_POWER_COLOR;
    return MINIMAP_PICKUP_AMMO_COLOR;
  }

  function pickupMinimapPulse(t, blinkStart, maxLife, baseRadius) {
    const baseR = typeof baseRadius === 'number' && isFinite(baseRadius) && baseRadius > 0 ? baseRadius : MINIMAP_PICKUP_BASE_RADIUS;
    const curT = typeof t === 'number' && isFinite(t) ? t : 0;
    const bStart = typeof blinkStart === 'number' && isFinite(blinkStart) ? blinkStart : PICKUP_BLINK_START;
    const mL = typeof maxLife === 'number' && isFinite(maxLife) ? maxLife : PICKUP_LIFE;
    if (curT >= mL) return 0;
    if (curT <= bStart) return baseR;
    const progress = (curT - bStart) / Math.max(0.001, mL - bStart);
    const freq = 3 + progress * 4;
    const wave = Math.sin((curT - bStart) * freq * Math.PI * 2) * 0.5 + 0.5;
    return baseR * (0.6 + 0.8 * wave);
  }

  function sentryMinimapPointer(bx, bz, sentryYaw, length, out) {
    const o = out || { x: 0, z: 0 };
    const len = typeof length === 'number' && isFinite(length) ? length : 5.5;
    const yaw = typeof sentryYaw === 'number' && isFinite(sentryYaw) ? sentryYaw : 0;
    o.x = bx - Math.sin(yaw) * len;
    o.z = bz - Math.cos(yaw) * len;
    return o;
  }

  // ---- Tactical Battlefield & Weapon Audio Polish (v113 Audio Polish) ----
  const BULLET_WHIZ_MAX_DIST = 3.6;
  const BULLET_WHIZ_MIN_OFFSET = 0.75;
  const LOW_AMMO_THRESHOLD_AR = 5;
  const LOW_AMMO_THRESHOLD_SMG = 6;
  const LOW_AMMO_THRESHOLD_BR = 4;
  const LOW_AMMO_THRESHOLD_SR = 1;

  function bulletWhizSound() {
    return 'bullet_whiz';
  }

  function isBulletNearMiss(dist, maxDist) {
    if (typeof dist !== 'number' || !isFinite(dist) || dist <= 0) return false;
    const maxD = typeof maxDist === 'number' && isFinite(maxDist) && maxDist > 0 ? maxDist : BULLET_WHIZ_MAX_DIST;
    return dist <= maxD;
  }

  function bulletNearMissOffset(seedX, seedY, minOffset, maxOffset, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const minO = typeof minOffset === 'number' && isFinite(minOffset) && minOffset >= 0 ? minOffset : BULLET_WHIZ_MIN_OFFSET;
    const maxO = typeof maxOffset === 'number' && isFinite(maxOffset) && maxOffset > minO ? maxOffset : BULLET_WHIZ_MAX_DIST;
    const sx = typeof seedX === 'number' && isFinite(seedX) ? seedX : 0.5;
    const sy = typeof seedY === 'number' && isFinite(seedY) ? seedY : 0.5;
    const signX = sx < 0 ? -1 : 1;
    const signY = sy < 0 ? -1 : 1;
    const magX = minO + Math.abs(sx) * (maxO - minO);
    const magY = (minO * 0.4) + Math.abs(sy) * (maxO * 0.5 - minO * 0.4);
    o.x = signX * Math.max(minO, Math.min(maxO, magX));
    o.y = signY * Math.max(minO * 0.4, Math.min(maxO * 0.5, magY));
    o.z = 0;
    return o;
  }

  function bulletWhizVolume(dist, maxDist) {
    if (typeof dist !== 'number' || !isFinite(dist) || dist <= 0) return 0;
    const maxD = typeof maxDist === 'number' && isFinite(maxDist) && maxDist > 0 ? maxDist : BULLET_WHIZ_MAX_DIST;
    if (dist >= maxD) return 0;
    return Math.max(0, Math.min(1, 1 - dist / maxD));
  }

  function lowAmmoThreshold(weaponType) {
    if (weaponType === 'SR') return LOW_AMMO_THRESHOLD_SR;
    if (weaponType === 'SMG') return LOW_AMMO_THRESHOLD_SMG;
    if (weaponType === 'BR') return LOW_AMMO_THRESHOLD_BR;
    return LOW_AMMO_THRESHOLD_AR;
  }

  function isLowAmmo(ammo, weaponType) {
    if (typeof ammo !== 'number' || !isFinite(ammo) || ammo <= 0) return false;
    return ammo <= lowAmmoThreshold(weaponType);
  }

  function lowAmmoSound(ammo, weaponType) {
    return isLowAmmo(ammo, weaponType) ? 'low_ammo' : null;
  }

  function reloadBoltSound(weaponType) {
    return weaponType === 'SR' ? 'sniper_bolt' : 'reload_bolt';
  }

  function isEmptyReload(ammo) {
    return typeof ammo === 'number' && isFinite(ammo) && ammo <= 0;
  }

  // ---- Tactical Stance Weapon Recoil Stability & Enemy Grenade/LOS Combat Balance (v114 Balance Tuning) ----
  const STANCE_RECOIL_CROUCH = 0.80;
  const STANCE_RECOIL_SLIDE = 0.85;
  const STANCE_RECOIL_AIRBORNE = 1.25;
  const ENEMY_GRENADE_ARM_DURATION = 0.5;
  const ENEMY_LIVE_GRENADES_CAP = 6;
  const GRENADIER_INITIAL_NADE_DELAY = 3.0;
  const RIFLEMAN_INITIAL_NADE_DELAY = 6.0;
  const ENEMY_EYE_OFFSET_Y = 0.5;
  const ENEMY_LOS_JITTER = 0.3;
  const ENEMY_MELEE_COOLDOWN_SENTINEL = -1.0;
  const ENEMY_MELEE_RESET_MARGIN = 0.01;

  function stanceRecoilMultiplier(isCrouching, isSliding, isAirborne) {
    if (isAirborne) return STANCE_RECOIL_AIRBORNE;
    // Movement sets crouching during a slide; the active slide takes precedence.
    if (isSliding) return STANCE_RECOIL_SLIDE;
    if (isCrouching) return STANCE_RECOIL_CROUCH;
    return 1.0;
  }

  function effectiveRecoilKick(recoilV, recoilH, patternX, patternY, stanceMultiplier, out) {
    const o = out || { pitchKick: 0, yawKick: 0 };
    const sm = typeof stanceMultiplier === 'number' && isFinite(stanceMultiplier) && stanceMultiplier > 0 ? stanceMultiplier : 1.0;
    const rv = typeof recoilV === 'number' && isFinite(recoilV) ? recoilV : 0;
    const rh = typeof recoilH === 'number' && isFinite(recoilH) ? recoilH : 0;
    const py = typeof patternY === 'number' && isFinite(patternY) ? patternY : 0;
    const px = typeof patternX === 'number' && isFinite(patternX) ? patternX : 0;
    o.pitchKick = rv * py * sm;
    o.yawKick = rh * px * sm;
    return o;
  }

  function enemyInitialGrenadeDelay(kind) {
    if (kind === 5) return GRENADIER_INITIAL_NADE_DELAY;
    if (kind === 1) return RIFLEMAN_INITIAL_NADE_DELAY;
    return Infinity;
  }

  function canSpawnEnemyGrenade(liveGrenadesCount, cap) {
    const c = typeof cap === 'number' && isFinite(cap) && cap > 0 ? cap : ENEMY_LIVE_GRENADES_CAP;
    const count = typeof liveGrenadesCount === 'number' && isFinite(liveGrenadesCount) ? liveGrenadesCount : 0;
    return count < c;
  }

  function enemyGrenadeVelocity(dx, dz, dist, speed, arcY, randX, randZ, jitter, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const d = typeof dist === 'number' && isFinite(dist) && dist > 0 ? dist : (Math.hypot(dx, dz) || 1);
    const spd = typeof speed === 'number' && isFinite(speed) && speed > 0 ? speed : 10;
    const ay = typeof arcY === 'number' && isFinite(arcY) ? arcY : ENEMY_GRENADE_ARC_Y;
    const jit = typeof jitter === 'number' && isFinite(jitter) ? jitter : ENEMY_GRENADE_JITTER;
    const rx = typeof randX === 'number' && isFinite(randX) ? (randX - 0.5) : 0;
    const rz = typeof randZ === 'number' && isFinite(randZ) ? (randZ - 0.5) : 0;
    const nx = dx / d;
    const nz = dz / d;
    const len = Math.hypot(nx, ay, nz) || 1;
    o.x = (nx / len) * spd + rx * jit;
    o.y = (ay / len) * spd;
    o.z = (nz / len) * spd + rz * jit;
    return o;
  }

  function enemyEyeHeight(posY, kind, pelvisH, eyeOffset) {
    const py = typeof posY === 'number' && isFinite(posY) ? posY : 0;
    const pel = typeof pelvisH === 'number' && isFinite(pelvisH) ? pelvisH : 0.95;
    const off = typeof eyeOffset === 'number' && isFinite(eyeOffset) ? eyeOffset : ENEMY_EYE_OFFSET_Y;
    const scale = kind === 2 ? 1.25 : 1.0;
    return py + pel * scale + off;
  }

  function enemyLosTargetCoord(coord, randVal, jitter) {
    const c = typeof coord === 'number' && isFinite(coord) ? coord : 0;
    const rv = typeof randVal === 'number' && isFinite(randVal) ? (randVal - 0.5) : 0;
    const jit = typeof jitter === 'number' && isFinite(jitter) ? jitter : ENEMY_LOS_JITTER;
    return c + rv * jit;
  }

  function isEnemyMeleeReset(swinging, sentinel, margin) {
    if (typeof swinging !== 'number' || !isFinite(swinging)) return false;
    const s = typeof sentinel === 'number' && isFinite(sentinel) ? sentinel : ENEMY_MELEE_COOLDOWN_SENTINEL;
    const m = typeof margin === 'number' && isFinite(margin) ? margin : ENEMY_MELEE_RESET_MARGIN;
    return swinging <= s - m;
  }

  // ---- Zero-Alloc Raycast Hit Pooling, GPU Particle Update Throttling & Core Perf Rules (v115 Perf Win) ----
  function shouldUpdatePfxLayer(alive, prevAlive, hasNew) {
    const cur = typeof alive === 'number' && isFinite(alive) ? alive : 0;
    const prev = typeof prevAlive === 'number' && isFinite(prevAlive) ? prevAlive : 0;
    return cur > 0 || prev > 0 || !!hasNew;
  }

  function isGrenadeLosBlocker(isGround, isVfx, isGun, isSky, isPickup) {
    return !isGround && !isVfx && !isGun && !isSky && !isPickup;
  }

  function enemyToPlayerDir(dx, dz, dist, out) {
    const o = out || { x: 0, z: 0 };
    const d = typeof dist === 'number' && isFinite(dist) ? dist : Math.hypot(dx, dz);
    if (d > 0.01) {
      o.x = dx / d;
      o.z = dz / d;
    } else {
      o.x = 0;
      o.z = 0;
    }
    return o;
  }

  function totalPlayerRounds(wState, weaponsOwned) {
    if (!Array.isArray(wState) || !Array.isArray(weaponsOwned)) return 0;
    let rounds = 0;
    for (let i = 0; i < wState.length; i++) {
      if (!wState[i] || weaponsOwned[i] < 0) continue;
      const ammo = typeof wState[i].ammo === 'number' && isFinite(wState[i].ammo) ? wState[i].ammo : 0;
      const res = typeof wState[i].reserve === 'number' && isFinite(wState[i].reserve) ? wState[i].reserve : 0;
      rounds += Math.max(0, ammo) + Math.max(0, res);
    }
    return rounds;
  }

  function hasPlayerRounds(wState, weaponsOwned) {
    return totalPlayerRounds(wState, weaponsOwned) > 0;
  }

  // ---- Blast Scorch & Enemy Muzzle Flash Visual Rules (v117 Visual Polish) ----
  const SCORCH_MAX = 16;
  const SCORCH_LIFETIME = 24.0;
  const SCORCH_FADE_DURATION = 4.0;
  const SCORCH_BASE_RADIUS = 2.5;
  const SCORCH_BASE_OPACITY = 0.88;
  const SCORCH_STANDOFF = 0.016;
  const SCORCH_EXPANSION_DURATION = 0.10;
  const ENEMY_MUZZLE_LIGHT_COLOR = 0xff9944;
  const ENEMY_MUZZLE_LIGHT_INTENSITY = 3.2;
  const ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY = 4.5;
  const ENEMY_MUZZLE_LIGHT_DIST = 9.0;
  const ENEMY_MUZZLE_LIGHT_DUR = 0.08;

  function scorchScale(dmgScale, jitter) {
    const s = typeof dmgScale === 'number' && isFinite(dmgScale) ? Math.max(0.65, Math.min(1.6, dmgScale)) : 1.0;
    const j = typeof jitter === 'number' && isFinite(jitter) ? 1.0 + (jitter - 0.5) * 0.2 : 1.0;
    return SCORCH_BASE_RADIUS * s * j;
  }

  function scorchScaleProgress(baseScale, elapsed, duration) {
    const b = typeof baseScale === 'number' && isFinite(baseScale) ? baseScale : SCORCH_BASE_RADIUS;
    const dur = typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : SCORCH_EXPANSION_DURATION;
    const el = typeof elapsed === 'number' && isFinite(elapsed) ? Math.max(0, elapsed) : dur;
    if (el >= dur) return b;
    const t = el / dur;
    const progress = 1 - (1 - t) * (1 - t);
    return b * (0.45 + 0.55 * progress);
  }

  function scorchOpacity(life, fadeDuration, maxOpacity) {
    if (typeof life !== 'number' || !isFinite(life) || life <= 0) return 0;
    const maxOp = typeof maxOpacity === 'number' && isFinite(maxOpacity) ? maxOpacity : SCORCH_BASE_OPACITY;
    const fade = typeof fadeDuration === 'number' && isFinite(fadeDuration) && fadeDuration > 0 ? fadeDuration : SCORCH_FADE_DURATION;
    if (life >= fade) return maxOp;
    const t = Math.max(0, Math.min(1, life / fade));
    return maxOp * t * t;
  }

  function stepScorchLife(life, dt) {
    if (typeof life !== 'number' || !isFinite(life)) return 0;
    const step = typeof dt === 'number' && isFinite(dt) ? dt : 0;
    return Math.max(0, life - step);
  }

  function isScorchExpired(life) {
    return typeof life !== 'number' || !isFinite(life) || life <= 0;
  }

  function scorchRotation(rand) {
    const r = typeof rand === 'number' && isFinite(rand) ? rand : 0;
    return (r % 1) * Math.PI * 2;
  }

  function scorchElevation(blastY, floorY, standoff) {
    const so = typeof standoff === 'number' && isFinite(standoff) ? standoff : SCORCH_STANDOFF;
    const f = (typeof floorY === 'number' && isFinite(floorY)) ? floorY : 0;
    return f + so;
  }

  function enemyMuzzleLightParams(isElite) {
    return {
      color: ENEMY_MUZZLE_LIGHT_COLOR,
      intensity: isElite ? ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY : ENEMY_MUZZLE_LIGHT_INTENSITY,
      distance: isElite ? 11.0 : ENEMY_MUZZLE_LIGHT_DIST,
      duration: ENEMY_MUZZLE_LIGHT_DUR
    };
  }

  // ---- Critical Heartbeat, Elite Gunfire & Air Absorption Audio (v118 Audio Polish) ----
  const HEARTBEAT_BPM_MIN = 72;
  const HEARTBEAT_BPM_MAX = 136;

  function heartbeatBpm(health, maxHealth, ratio) {
    const intensity = criticalHealthIntensity(health, maxHealth, ratio);
    return HEARTBEAT_BPM_MIN + intensity * (HEARTBEAT_BPM_MAX - HEARTBEAT_BPM_MIN);
  }

  function heartbeatInterval(bpm) {
    const b = (typeof bpm === 'number' && isFinite(bpm) && bpm > 0) ? bpm : HEARTBEAT_BPM_MIN;
    return 60 / b;
  }

  function stepHeartbeatTimer(timer, dt, bpm) {
    const t = (typeof timer === 'number' && isFinite(timer)) ? timer : 0;
    const d = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 0;
    const interval = heartbeatInterval(bpm);
    const next = t - d;
    if (next <= 0) {
      return { ready: true, nextTimer: interval };
    }
    return { ready: false, nextTimer: next };
  }

  function shouldPlayHeartbeat(isDead, isDowned, isCritical) {
    if (isDead || isDowned) return false;
    return !!isCritical;
  }

  function heartbeatSound() {
    return 'heartbeat';
  }

  function enemyGunfireSound(isElite) {
    return isElite ? 'eshot_elite' : 'eshot';
  }

  // ---- Tactical Stance Spread, Blast Camera Shake & Combat Accuracy (v119 Balance Tuning) ----
  const EXPLOSION_KICK_MAX_DIST = 20.0;
  const EXPLOSION_POST_KICK_MAX = 0.80;
  const EXPLOSION_SHOT_KICK_MAX = 1.4;
  const EXPLOSION_SHOT_KICK_CAP = 2.0;

  const HEADSHOT_MUL_SR = 2.4;
  const HEADSHOT_MUL_BR = 2.0;
  const HEADSHOT_MUL_AR = 1.8;
  const HEADSHOT_MUL_SMG = 1.5;

  const ENEMY_ACCURACY_FALLOFF_DIST = 16.0;
  const ENEMY_ACCURACY_MIN_FACTOR = 0.55;

  function explosionKickIntensity(dist, maxDist) {
    const d = (typeof dist === 'number' && isFinite(dist)) ? Math.max(0, dist) : Infinity;
    const max = (typeof maxDist === 'number' && isFinite(maxDist) && maxDist > 0) ? maxDist : EXPLOSION_KICK_MAX_DIST;
    if (d >= max) return 0;
    return Math.max(0, Math.min(1, 1 - d / max));
  }

  function explosionPostKick(dist, maxDist, maxKick) {
    const k = (typeof maxKick === 'number' && isFinite(maxKick) && maxKick > 0) ? maxKick : EXPLOSION_POST_KICK_MAX;
    return explosionKickIntensity(dist, maxDist) * k;
  }

  function explosionShotKick(dist, maxDist, maxKick) {
    const k = (typeof maxKick === 'number' && isFinite(maxKick) && maxKick > 0) ? maxKick : EXPLOSION_SHOT_KICK_MAX;
    return explosionKickIntensity(dist, maxDist) * k;
  }

  function applyExplosionShotKick(currentKick, addedKick, maxCap) {
    const cur = (typeof currentKick === 'number' && isFinite(currentKick) && currentKick >= 0) ? currentKick : 0;
    const add = (typeof addedKick === 'number' && isFinite(addedKick) && addedKick >= 0) ? addedKick : 0;
    const cap = (typeof maxCap === 'number' && isFinite(maxCap) && maxCap > 0) ? maxCap : EXPLOSION_SHOT_KICK_CAP;
    return Math.min(cap, cur + add);
  }

  function weaponHeadshotMultiplier(weaponType, defaultMul) {
    const def = (typeof defaultMul === 'number' && isFinite(defaultMul) && defaultMul > 0) ? defaultMul : 1.8;
    const t = String(weaponType || '').toUpperCase();
    if (t === 'SR') return HEADSHOT_MUL_SR;
    if (t === 'BR') return HEADSHOT_MUL_BR;
    if (t === 'AR') return HEADSHOT_MUL_AR;
    if (t === 'SMG') return HEADSHOT_MUL_SMG;
    return def;
  }

  function enemyDistanceAccuracy(baseAcc, dist, nominalDist, maxDist, minFactor) {
    const acc = (typeof baseAcc === 'number' && isFinite(baseAcc) && baseAcc >= 0) ? baseAcc : 0.5;
    const d = (typeof dist === 'number' && isFinite(dist) && dist >= 0) ? dist : 0;
    const nom = (typeof nominalDist === 'number' && isFinite(nominalDist) && nominalDist > 0) ? nominalDist : ENEMY_ACCURACY_FALLOFF_DIST;
    const max = (typeof maxDist === 'number' && isFinite(maxDist) && maxDist > nom) ? maxDist : 44.0;
    const minF = (typeof minFactor === 'number' && isFinite(minFactor) && minFactor >= 0 && minFactor <= 1) ? minFactor : ENEMY_ACCURACY_MIN_FACTOR;
    if (d <= nom) return acc;
    if (d >= max) return acc * minF;
    const t = (d - nom) / (max - nom);
    return acc * (1 - (1 - minF) * t);
  }

  // ---- Dynamic Point Light & Flash VFX, Sentry Rangefinding, Shadow Caster Mask & Pickup Opacity Rules (v120 Perf Win) ----
  const FLASH_LIGHT_DECAY_EXPONENT = 2;
  const SENTRY_TARGET_ACQUIRE_EPSILON = 1e-4;

  function stepFlashLightLife(life, dt) {
    const l = (typeof life === 'number' && isFinite(life)) ? life : 0;
    const delta = (typeof dt === 'number' && isFinite(dt)) ? dt : 0;
    return Math.max(0, l - delta);
  }

  function flashLightIntensity(life, maxLife, peakIntensity) {
    if (typeof life !== 'number' || !isFinite(life) || life <= 0) return 0;
    if (typeof maxLife !== 'number' || !isFinite(maxLife) || maxLife <= 0) return 0;
    const peak = (typeof peakIntensity === 'number' && isFinite(peakIntensity)) ? peakIntensity : 0;
    const t = Math.max(0, Math.min(1, life / maxLife));
    return peak * t * t;
  }

  function particlePerspectiveScale(screenHeight, fovDeg) {
    const h = (typeof screenHeight === 'number' && isFinite(screenHeight) && screenHeight > 0) ? screenHeight : 720;
    const fov = (typeof fovDeg === 'number' && isFinite(fovDeg) && fovDeg > 0) ? fovDeg : 60;
    const rad = (fov * Math.PI) / 180;
    return h / (2 * Math.tan(rad / 2));
  }

  function isSentryTargetInRange(dx, dz, maxRangeSq) {
    const x = (typeof dx === 'number' && isFinite(dx)) ? dx : 0;
    const z = (typeof dz === 'number' && isFinite(dz)) ? dz : 0;
    const maxSq = (typeof maxRangeSq === 'number' && isFinite(maxRangeSq)) ? maxRangeSq : 0;
    return (x * x + z * z) < maxSq;
  }

  function buildShadowCasterMask(casterIndices, totalCount, maskOut) {
    const count = (typeof totalCount === 'number' && isFinite(totalCount)) ? Math.max(0, totalCount) : 0;
    const mask = maskOut || new Array(count);
    mask.length = count;
    for (let i = 0; i < count; i++) mask[i] = false;
    if (Array.isArray(casterIndices)) {
      for (let i = 0; i < casterIndices.length; i++) {
        const idx = casterIndices[i];
        if (idx >= 0 && idx < count) mask[idx] = true;
      }
    }
    return mask;
  }

  function planarFacingDirection(dirX, dirZ, out) {
    const o = out || { x: 0, z: 0 };
    const x = (typeof dirX === 'number' && isFinite(dirX)) ? dirX : 0;
    const z = (typeof dirZ === 'number' && isFinite(dirZ)) ? dirZ : 0;
    const len = Math.hypot(x, z) || 1;
    o.x = x / len;
    o.z = z / len;
    return o;
  }

  function shouldUpdatePickupOpacity(t, blinkStart, lastOp, curOp) {
    if (lastOp === undefined || lastOp === null) return true;
    const time = (typeof t === 'number' && isFinite(t)) ? t : 0;
    const start = (typeof blinkStart === 'number' && isFinite(blinkStart)) ? blinkStart : 20;
    if (time < start) return false;
    const last = (typeof lastOp === 'number' && isFinite(lastOp)) ? lastOp : 1;
    const cur = (typeof curOp === 'number' && isFinite(curOp)) ? curOp : 1;
    return Math.abs(cur - last) >= 0.005;
  }

  return {
    horizDist: horizDist,
    horizDistSq: horizDistSq,
    subStepCount: subStepCount,
    ceilingClamp: ceilingClamp,
    shadowCasters: shadowCasters,
    MAX_SUBSTEPS: MAX_SUBSTEPS,
    advanceShotSchedule: advanceShotSchedule,
    fireClockStep: fireClockStep,
    shotScheduleAfterInactive: shotScheduleAfterInactive,
    distanceFalloff: distanceFalloff,
    waveEnemyCount: waveEnemyCount,
    waveHpMultiplier: waveHpMultiplier,
    waveRangedAccuracy: waveRangedAccuracy,
    WAVE_SCORE_PER_WAVE: WAVE_SCORE_PER_WAVE,
    waveClearScore: waveClearScore,
    RESUPPLY_MAG_RATIO: RESUPPLY_MAG_RATIO,
    waveResupplyAmmo: waveResupplyAmmo,
    aabbOverlapsXZ: aabbOverlapsXZ,
    blocksWalker: blocksWalker,
    isSpawnValid: isSpawnValid,
    SETTINGS_SCHEMA: SETTINGS_SCHEMA,
    defaultSettings: defaultSettings,
    clampSetting: clampSetting,
    sanitizeSettings: sanitizeSettings,
    qualityRenderSettings: qualityRenderSettings, graphicsSettings,
    createFrameTimeTelemetry: createFrameTimeTelemetry,
    createRuntimeTelemetry: createRuntimeTelemetry,
    stepGrenadeMotion: stepGrenadeMotion,
    lookSensitivity: lookSensitivity,
    combatIntensity: combatIntensity,
    BASE_SENSITIVITY: BASE_SENSITIVITY,
    defaultStats: defaultStats,
    sanitizeStats: sanitizeStats,
    resumeCheckpointState: resumeCheckpointState,
    settlementAccounting: settlementAccounting,
    mergeRunIntoStats: mergeRunIntoStats,
    DIFFICULTIES: DIFFICULTIES,
    difficulty: difficulty,
    BEHAVIOUR_UNLOCKS: BEHAVIOUR_UNLOCKS,
    behavioursAtWave: behavioursAtWave,
    newBehavioursAtWave: newBehavioursAtWave,
    pickEnemyKind: pickEnemyKind,
    enemyStopDistance: enemyStopDistance,
    enemyMoveSpeed: enemyMoveSpeed,
    flankBias: flankBias,
    flankWindow: flankWindow,
    flankBiasNow: flankBiasNow,
    FLANK_WINDOW: FLANK_WINDOW,
    enemyPreferredRange: enemyPreferredRange,
    ENEMY_KIND_UNLOCK: ENEMY_KIND_UNLOCK,
    enemyKindsAtWave: enemyKindsAtWave,
    newEnemyKindsAtWave: newEnemyKindsAtWave,
    endlessHpMultiplier: endlessHpMultiplier,
    endlessEnemyCount: endlessEnemyCount,
    SAVE_VERSION: SAVE_VERSION,
    ammoDropChance: ammoDropChance,
    MED_DROP_BASE: MED_DROP_BASE,
    MED_DROP_CRITICAL: MED_DROP_CRITICAL,
    medDropChance: medDropChance,
    pickupDropKind: pickupDropKind,
    makeCheckpoint: makeCheckpoint,
    validateCheckpoint: validateCheckpoint,
    regionKey: regionKey,
    planStaticBatches: planStaticBatches,
    segmentHitsBox: segmentHitsBox,
    segmentBlocked: segmentBlocked,
    buildRayGrid: buildRayGrid,
    rayGridClear: rayGridClear,
    rayGridInsert: rayGridInsert,
    rayGridQuery: rayGridQuery,
    buildNavGrid: buildNavGrid,
    computeFlowField: computeFlowField,
    worldToCell: worldToCell,
    cellCenter: cellCenter,
    isWalkable: isWalkable,
    nearestWalkable: nearestWalkable,
    navDistanceAt: navDistanceAt,
    flowDirAt: flowDirAt,
    updateStuck: updateStuck,
    updateProgress: updateProgress,
    isClosingDistance: isClosingDistance,
    RECOIL_PATTERNS: RECOIL_PATTERNS,
    RECOIL_JITTER: RECOIL_JITTER,
    RECOIL_RESET: RECOIL_RESET,
    recoilPatternFor: recoilPatternFor,
    recoilAt: recoilAt,
    recoilShotIndex: recoilShotIndex,
    absorbRecoil: absorbRecoil,
    BLOOM_PER_SHOT: BLOOM_PER_SHOT,
    BLOOM_CAP_HIP: BLOOM_CAP_HIP,
    BLOOM_CAP_ADS: BLOOM_CAP_ADS,
    BLOOM_RECOVER: BLOOM_RECOVER,
    bloomParams: bloomParams,
    bloomAfterShot: bloomAfterShot,
    bloomDecay: bloomDecay,
    effectiveSpread: effectiveSpread,
    PENETRATION_COST: PENETRATION_COST,
    MAX_PENETRATIONS: MAX_PENETRATIONS,
    penetrationCost: penetrationCost,
    penetrationPower: penetrationPower,
    penetrate: penetrate,
    penetrationDamageMul: penetrationDamageMul,
    meleeTarget: meleeTarget,
    MELEE_REACH: MELEE_REACH,
    MELEE_CONE: MELEE_CONE,
    MELEE_DAMAGE: MELEE_DAMAGE,
    MELEE_COOLDOWN: MELEE_COOLDOWN,
    mantleTarget: mantleTarget,
    CREDITS: CREDITS,
    creditsForDamage: creditsForDamage,
    creditsForWave: creditsForWave,
    POWERUPS: POWERUPS,
    POWERUP_CHANCE: POWERUP_CHANCE,
    powerUpDropped: powerUpDropped,
    pickPowerUp: pickPowerUp,
    rayBoxEntry: rayBoxEntry,
    sweepGrenade: sweepGrenade,
    penetrationWalk: penetrationWalk,
    penetrationMulAt: penetrationMulAt,
    BUY_RADIUS: BUY_RADIUS,
    BUY_HOLD: BUY_HOLD,
    nearestStation: nearestStation,
    WALL_BUY_PRICE: WALL_BUY_PRICE,
    wallBuyPrice: wallBuyPrice,
    ammoRefillPrice: ammoRefillPrice,
    wallBuyOffer: wallBuyOffer,
    ARMORY_WAVE: ARMORY_WAVE,
    ARMORY_PRICE: ARMORY_PRICE,
    armoryAvailable: armoryAvailable,
    armoryUpgrade: armoryUpgrade,
    PERK_SLOTS: PERK_SLOTS,
    PERKS: PERKS,
    perkByKey: perkByKey,
    perkBuyBlocker: perkBuyBlocker,
    hasPerk: hasPerk,
    perkMaxHealth: perkMaxHealth,
    HEALTH_LOW_THRESHOLD: HEALTH_LOW_THRESHOLD,
    isHealthLow: isHealthLow,
    ARMOR_LOW_RATIO: ARMOR_LOW_RATIO,
    isArmorLow: isArmorLow,
    isArmorEmpty: isArmorEmpty,
    AMMO_LOW_RATIO: AMMO_LOW_RATIO,
    isAmmoLow: isAmmoLow,
    isAmmoEmpty: isAmmoEmpty,
    reloadPrompt: reloadPrompt,
    perkReloadMul: perkReloadMul,
    perkBloomMul: perkBloomMul,
    perkAdsMul: perkAdsMul,
    perkPickupMul: perkPickupMul,
    PLATE_MAX: PLATE_MAX,
    PLATE_PRICE: PLATE_PRICE,
    PLATE_TIME: PLATE_TIME,
    plateApply: plateApply,
    platesAffordable: platesAffordable,
    DOWN_TIME: DOWN_TIME,
    DOWN_REVIVE_HEALTH: DOWN_REVIVE_HEALTH,
    DOWN_SPEED_MUL: DOWN_SPEED_MUL,
    lethalOutcome: lethalOutcome,
    bleedOutRemaining: bleedOutRemaining,
    LETHALS: LETHALS,
    TACTICALS: TACTICALS,
    equipmentByKey: equipmentByKey,
    flashStrength: flashStrength,
    flashDuration: flashDuration,
    segmentHitsSphere: segmentHitsSphere,
    smokeBlocks: smokeBlocks,
    STREAKS: STREAKS,
    streakByKey: streakByKey,
    streaksEarnedAt: streaksEarnedAt,
    nextStreak: nextStreak,
    FIELD_UPGRADE: FIELD_UPGRADE,
    fieldChargeAfter: fieldChargeAfter,
    fieldReady: fieldReady,
    coneHit: coneHit,
    SPECIAL_WAVES: SPECIAL_WAVES,
    SPECIAL_EVERY: SPECIAL_EVERY,
    specialWaveAt: specialWaveAt,
    specialKind: specialKind,
    ELITE_FROM_WAVE: ELITE_FROM_WAVE,
    ELITE: ELITE,
    eliteChance: eliteChance,
    rollElite: rollElite,
    DISTRICTS: DISTRICTS,
    districtByKey: districtByKey,
    insideDistrict: insideDistrict,
    spawnPointSealed: spawnPointSealed,
    usableSpawnPoints: usableSpawnPoints,
    WAVE_QUEUE_CAP: WAVE_QUEUE_CAP,
    waveQueueSize: waveQueueSize,
    RAGDOLL_NODES: RAGDOLL_NODES,
    RAGDOLL_LINKS: RAGDOLL_LINKS,
    RAGDOLL_ITERATIONS: RAGDOLL_ITERATIONS,
    makeRagdoll: makeRagdoll,
    ragdollStep: ragdollStep,
    ragdollImpulse: ragdollImpulse,
    ragdollCollide: ragdollCollide,
    ragdollEnergy: ragdollEnergy,
    dist3: dist3,
    FALL_SAFE_SPEED: FALL_SAFE_SPEED,
    FALL_LETHAL_SPEED: FALL_LETHAL_SPEED,
    fallDamage: fallDamage,
    landingImpactSpeed: landingImpactSpeed,
    landingSpeedMul: landingSpeedMul,
    MAX_RANK: MAX_RANK,
    xpForRank: xpForRank,
    rankForXp: rankForXp,
    rankProgress: rankProgress,
    XP_PER: XP_PER,
    runXp: runXp,
    WEAPON_UNLOCK_RANK: WEAPON_UNLOCK_RANK,
    weaponUnlockRank: weaponUnlockRank,
    weaponUnlocked: weaponUnlocked,
    CHALLENGES: CHALLENGES,
    challengeProgress: challengeProgress,
    challengesDone: challengesDone,
    ATTACH_SLOTS: ATTACH_SLOTS,
    ATTACH_SLOT_NAME: ATTACH_SLOT_NAME,
    ATTACHMENTS: ATTACHMENTS,
    attachmentByKey: attachmentByKey,
    attachmentsForSlot: attachmentsForSlot,
    attachmentUnlocked: attachmentUnlocked,
    sanitizeLoadout: sanitizeLoadout,
    applyAttachments: applyAttachments,
    attachmentDelta: attachmentDelta,
    OBJECTIVE_EVERY: OBJECTIVE_EVERY,
    OBJECTIVE_HOLD: OBJECTIVE_HOLD,
    OBJECTIVE_RADIUS: OBJECTIVE_RADIUS,
    OBJECTIVE_CREDITS: OBJECTIVE_CREDITS,
    objectiveWaveAt: objectiveWaveAt,
    objectiveProgress: objectiveProgress,
    objectiveComplete: objectiveComplete,
    pickObjectiveSpot: pickObjectiveSpot,
    REACH_MAX_VERT: REACH_MAX_VERT,
    withinReach: withinReach,
    UNREACHABLE: UNREACHABLE,
    SOUND_VARIED_RANGE: SOUND_VARIED_RANGE,
    soundPlaybackRate: soundPlaybackRate,
    SPATIAL_AUDIO_MAX_DIST: SPATIAL_AUDIO_MAX_DIST,
    SPATIAL_AUDIO_PAN_BOOST: SPATIAL_AUDIO_PAN_BOOST,
    SPATIAL_AUDIO_MIN_VOL: SPATIAL_AUDIO_MIN_VOL,
    spatialAudioPan: spatialAudioPan,
    spatialAudioVolume: spatialAudioVolume,
    spatialAudioParams: spatialAudioParams,
    JOYSTICK_SPRINT_FORWARD: JOYSTICK_SPRINT_FORWARD,
    JOYSTICK_SPRINT_MAGNITUDE: JOYSTICK_SPRINT_MAGNITUDE,
    isAutoSprint: isAutoSprint,
    JOYSTICK_RADIUS: JOYSTICK_RADIUS,
    JOYSTICK_DEADZONE: JOYSTICK_DEADZONE,
    joystickInput: joystickInput,
    resolveAabbXZ: resolveAabbXZ,
    ARMOR_ABSORB_RATIO: ARMOR_ABSORB_RATIO,
    resolveArmorDamage: resolveArmorDamage,
    enemyMeleeDamage: enemyMeleeDamage,
    enemyRangedDamage: enemyRangedDamage,
    resolveVerticalBounds: resolveVerticalBounds,
    findFloorY: findFloorY,
    hasCrouchHeadroom: hasCrouchHeadroom,
    SPATIAL_EXPLOSION_MAX_DIST: SPATIAL_EXPLOSION_MAX_DIST,
    spatialExplosionParams: spatialExplosionParams,
    tacticalDetonationSound: tacticalDetonationSound,
    grenadeContactSound: grenadeContactSound,
    JOYSTICK_MOVE_THRESHOLD: JOYSTICK_MOVE_THRESHOLD,
    touchMovementKeys: touchMovementKeys,
    touchReloadState: touchReloadState,
    ENEMY_HEALTH_SCALE: ENEMY_HEALTH_SCALE,
    SHIELD_ARC_COS: SHIELD_ARC_COS,
    SHIELD_ABSORB_RATIO: SHIELD_ABSORB_RATIO,
    enemyBaseHealth: enemyBaseHealth,
    enemyMaxHealth: enemyMaxHealth,
    enemyAccuracy: enemyAccuracy,
    playerBulletDamage: playerBulletDamage,
    shieldMultiplier: shieldMultiplier,
    HITMARK_COLOR: HITMARK_COLOR,
    hitmarkerTier: hitmarkerTier,
    hitmarkerParams: hitmarkerParams,
    ENEMY_SEPARATION_RADIUS: ENEMY_SEPARATION_RADIUS,
    enemySeparationRadius: enemySeparationRadius,
    resolveSeparationPush: resolveSeparationPush,
    MELEE_CAP_WINDOW: MELEE_CAP_WINDOW,
    MELEE_CAP_MAX_HITS: MELEE_CAP_MAX_HITS,
    pruneHitTimestamps: pruneHitTimestamps,
    canRegisterHit: canRegisterHit,
    snapToTexel: snapToTexel,
    weaponFireSound: weaponFireSound,
    armorDamageSound: armorDamageSound,
    touchPlateState: touchPlateState,
    touchEquipmentState: touchEquipmentState,
    touchStreakState: touchStreakState,
    touchSwapState: touchSwapState,
    touchSwapLabel: touchSwapLabel,
    buyPromptPrefix: buyPromptPrefix,
    touchUseState: touchUseState,
    touchSlideState: touchSlideState,
    touchSlideLabel: touchSlideLabel,
    touchPlateLabel: touchPlateLabel,
    touchTacticalLabel: touchTacticalLabel,
    touchLethalLabel: touchLethalLabel,
    touchStreakLabel: touchStreakLabel,
    touchMeleeState: touchMeleeState,
    touchMeleeLabel: touchMeleeLabel,
    GRENADE_DAMAGE_FLOOR: GRENADE_DAMAGE_FLOOR,
    GRENADE_SELF_DAMAGE_MAX: GRENADE_SELF_DAMAGE_MAX,
    GRENADE_SELF_RADIUS_RATIO: GRENADE_SELF_RADIUS_RATIO,
    GRENADE_MIN_SPEED: GRENADE_MIN_SPEED,
    GRENADE_MAX_SPEED: GRENADE_MAX_SPEED,
    GRENADE_RAMP_DURATION: GRENADE_RAMP_DURATION,
    GRENADE_TAP_THRESHOLD: GRENADE_TAP_THRESHOLD,
    grenadeBlastDamage: grenadeBlastDamage,
    grenadeSelfDamage: grenadeSelfDamage,
    grenadeChargedSpeed: grenadeChargedSpeed,
    grenadeThrowSpeed: grenadeThrowSpeed,
    canEnemyMelee: canEnemyMelee,
    enemyMeleeReach: enemyMeleeReach,
    enemyAttackCooldown: enemyAttackCooldown,
    VIGNETTE_MAX_ALPHA: VIGNETTE_MAX_ALPHA,
    VIGNETTE_BASE_ALPHA: VIGNETTE_BASE_ALPHA,
    VIGNETTE_SCALE_DIVISOR: VIGNETTE_SCALE_DIVISOR,
    HIT_ARC_LIFE: HIT_ARC_LIFE,
    HIT_ARC_FADE_START: HIT_ARC_FADE_START,
    HIT_ARC_MAX_OPACITY: HIT_ARC_MAX_OPACITY,
    damageVignetteAlpha: damageVignetteAlpha,
    damageVignetteStyle: damageVignetteStyle,
    worldBearing: worldBearing,
    screenHitAngle: screenHitAngle,
    hitArcOpacity: hitArcOpacity,
    stepParticlePhysics: stepParticlePhysics,
    ammoHudChanged: ammoHudChanged,
    syncAmmoHudState: syncAmmoHudState,
    healthHudChanged: healthHudChanged,
    syncHealthHudState: syncHealthHudState,
    killConfirmationSound: killConfirmationSound,
    MK_WINDOW: MK_WINDOW,
    MK_MAX_STREAK: MK_MAX_STREAK,
    advanceKillStreak: advanceKillStreak,
    multikillLabel: multikillLabel,
    multikillSound: multikillSound,
    SLIDE_DURATION: SLIDE_DURATION,
    SLIDE_START_MUL: SLIDE_START_MUL,
    SLIDE_END_MUL: SLIDE_END_MUL,
    SLIDE_BOOST_MAX: SLIDE_BOOST_MAX,
    SLIDE_BOOST_SCALE: SLIDE_BOOST_SCALE,
    SLIDE_JUMP_Y_MUL: SLIDE_JUMP_Y_MUL,
    slideSpeedAt: slideSpeedAt,
    slideJumpBoost: slideJumpBoost,
    STAMINA_RECOVER_RATE: STAMINA_RECOVER_RATE,
    STAMINA_EXHAUST_RECOVER_RATIO: STAMINA_EXHAUST_RECOVER_RATIO,
    stepPlayerStamina: stepPlayerStamina,
    isPlayerExhausted: isPlayerExhausted,
    canRegenHealth: canRegenHealth,
    stepHealthRegen: stepHealthRegen,
    AMMO_PICKUP_MAG_RATIO: AMMO_PICKUP_MAG_RATIO,
    MEDKIT_HEAL_BASE: MEDKIT_HEAL_BASE,
    MEDKIT_ARMOR_BASE: MEDKIT_ARMOR_BASE,
    ammoPickupRestore: ammoPickupRestore,
    medkitPickupRestore: medkitPickupRestore,
    HEALTH_CRITICAL_RATIO: HEALTH_CRITICAL_RATIO,
    CRITICAL_VIGNETTE_BASE_BLUR: CRITICAL_VIGNETTE_BASE_BLUR,
    CRITICAL_VIGNETTE_MAX_BLUR: CRITICAL_VIGNETTE_MAX_BLUR,
    CRITICAL_VIGNETTE_BASE_SPREAD: CRITICAL_VIGNETTE_BASE_SPREAD,
    CRITICAL_VIGNETTE_MAX_SPREAD: CRITICAL_VIGNETTE_MAX_SPREAD,
    isHealthCritical: isHealthCritical,
    criticalHealthIntensity: criticalHealthIntensity,
    healthDangerState: healthDangerState,
    criticalVignetteStyle: criticalVignetteStyle,
    criticalPulseAlpha: criticalPulseAlpha,
    filterMinimapColliders: filterMinimapColliders,
    isMinimapBlockVisible: isMinimapBlockVisible,
    compassHeading: compassHeading,
    compassTickOffset: compassTickOffset,
    compassCardinalLabel: compassCardinalLabel,
    evaluateCombatEnemies: evaluateCombatEnemies,
    SENTRY_AUDIO_MAX_DIST: SENTRY_AUDIO_MAX_DIST,
    streakActivationSound: streakActivationSound,
    fieldUpgradeSound: fieldUpgradeSound,
    sentryFireSound: sentryFireSound,
    canMunitionsResupply: canMunitionsResupply,
    STEADY_MAX: STEADY_MAX,
    STEADY_RECOVER: STEADY_RECOVER,
    ADS_SCOPE_THRESHOLD: ADS_SCOPE_THRESHOLD,
    SCOPE_LOCKED_THRESHOLD: SCOPE_LOCKED_THRESHOLD,
    RECOIL_DECAY_RATE: RECOIL_DECAY_RATE,
    isSteadyActive: isSteadyActive,
    stepSteadyAim: stepSteadyAim,
    swayAmplitude: swayAmplitude,
    swayOffsets: swayOffsets,
    isScoped: isScoped,
    recoilDecay: recoilDecay,
    aimAssistAngle: aimAssistAngle,
    aimAssistPull: aimAssistPull,
    CROSSHAIR_MIN_GAP_OFFSET: CROSSHAIR_MIN_GAP_OFFSET,
    CROSSHAIR_MAX_GAP_OFFSET: CROSSHAIR_MAX_GAP_OFFSET,
    crosshairGapOffset: crosshairGapOffset,
    crosshairOpacity: crosshairOpacity,
    sprintIndicatorState: sprintIndicatorState,
    sprintIndicatorLabel: sprintIndicatorLabel,
    touchAdsState: touchAdsState,
    touchAdsLabel: touchAdsLabel,
    touchAdsChanged: touchAdsChanged,
    syncTouchAdsState: syncTouchAdsState,
    touchJumpState: touchJumpState,
    touchJumpLabel: touchJumpLabel,
    touchJumpChanged: touchJumpChanged,
    syncTouchJumpState: syncTouchJumpState,
    touchSlideChanged: touchSlideChanged,
    syncTouchSlideState: syncTouchSlideState,
    touchMeleeChanged: touchMeleeChanged,
    syncTouchMeleeState: syncTouchMeleeState,
    isMobileSteadyAim: isMobileSteadyAim,
    touchFireState: touchFireState,
    touchFireLabel: touchFireLabel,
    touchReloadLabel: touchReloadLabel,
    TOUCH_BUTTON_DEFAULT_SIZE: TOUCH_BUTTON_DEFAULT_SIZE,
    TOUCH_FIRE_DEFAULT_SIZE: TOUCH_FIRE_DEFAULT_SIZE,
    TOUCH_PAUSE_DEFAULT_SIZE: TOUCH_PAUSE_DEFAULT_SIZE,
    touchControlName: touchControlName,
    touchEditorControlLabel: touchEditorControlLabel,
    touchLayoutClampPercent: touchLayoutClampPercent,
    touchFireChanged: touchFireChanged,
    syncTouchFireState: syncTouchFireState,
    touchReloadChanged: touchReloadChanged,
    syncTouchReloadState: syncTouchReloadState,
    touchPlateChanged: touchPlateChanged,
    syncTouchPlateState: syncTouchPlateState,
    touchEquipmentChanged: touchEquipmentChanged,
    syncTouchEquipmentState: syncTouchEquipmentState,
    touchStreakChanged: touchStreakChanged,
    syncTouchStreakState: syncTouchStreakState,
    touchSwapChanged: touchSwapChanged,
    syncTouchSwapState: syncTouchSwapState,
    touchSwapNextSlot: touchSwapNextSlot,
    FOOTSTEP_BASE_CADENCE: FOOTSTEP_BASE_CADENCE,
    FOOTSTEP_SPRINT_CADENCE: FOOTSTEP_SPRINT_CADENCE,
    FOOTSTEP_TAC_SPRINT_CADENCE: FOOTSTEP_TAC_SPRINT_CADENCE,
    FOOTSTEP_CROUCH_CADENCE: FOOTSTEP_CROUCH_CADENCE,
    FOOTSTEP_MIN_SPEED: FOOTSTEP_MIN_SPEED,
    mantleSound: mantleSound,
    slideStartSound: slideStartSound,
    footstepCadence: footstepCadence,
    playerFootstepSound: playerFootstepSound,
    shouldPlayFootstep: shouldPlayFootstep,
    SNIPER_ADS_ZOOM: SNIPER_ADS_ZOOM,
    DEFAULT_ADS_ZOOM: DEFAULT_ADS_ZOOM,
    SLIDE_FOV_BOOST: SLIDE_FOV_BOOST,
    TAC_SPRINT_FOV_BOOST: TAC_SPRINT_FOV_BOOST,
    CAMERA_MIN_FOV: CAMERA_MIN_FOV,
    CAMERA_MAX_FOV: CAMERA_MAX_FOV,
    CAMERA_BOB_X_SCALE: CAMERA_BOB_X_SCALE,
    CAMERA_BOB_Y_SCALE: CAMERA_BOB_Y_SCALE,
    CAMERA_SLIDE_DIP: CAMERA_SLIDE_DIP,
    CAMERA_BOB_ROLL_SCALE: CAMERA_BOB_ROLL_SCALE,
    CAMERA_SLIDE_ROLL: CAMERA_SLIDE_ROLL,
    CAMERA_STRAFE_ROLL_SCALE: CAMERA_STRAFE_ROLL_SCALE,
    weaponAdsZoom: weaponAdsZoom,
    mobilityFovBoost: mobilityFovBoost,
    targetCameraFov: targetCameraFov,
    strafeDirection: strafeDirection,
    cameraRoll: cameraRoll,
    cameraPositionOffsets: cameraPositionOffsets,
    TAC_SPRINT_SPEED_MUL: TAC_SPRINT_SPEED_MUL,
    LAND_STUN_SPEED_MUL: LAND_STUN_SPEED_MUL,
    ADS_MOVE_SPEED_MUL: ADS_MOVE_SPEED_MUL,
    AIR_SLIDE_ACCEL_RATE: AIR_SLIDE_ACCEL_RATE,
    AIR_MOVE_ACCEL_RATE: AIR_MOVE_ACCEL_RATE,
    GROUND_DECEL_DEFAULT: GROUND_DECEL_DEFAULT,
    VELOCITY_SNAP_THRESHOLD: VELOCITY_SNAP_THRESHOLD,
    BOB_SPEED_THRESHOLD: BOB_SPEED_THRESHOLD,
    BOB_FREQ_SPRINT: BOB_FREQ_SPRINT,
    BOB_FREQ_WALK: BOB_FREQ_WALK,
    BOB_SPEED_SCALE: BOB_SPEED_SCALE,
    BOB_GROW_RATE: BOB_GROW_RATE,
    BOB_DECAY_RATE: BOB_DECAY_RATE,
    LAND_STUN_BASE_TIME: LAND_STUN_BASE_TIME,
    LAND_STUN_SCALE: LAND_STUN_SCALE,
    COYOTE_TIME: COYOTE_TIME,
    JUMP_BUFFER_TIME: JUMP_BUFFER_TIME,
    ADS_BASE_SPEED: ADS_BASE_SPEED,
    GUN_SWITCH_SPEED: GUN_SWITCH_SPEED,
    SNIPER_UNSCOPE_FACTOR: SNIPER_UNSCOPE_FACTOR,
    SHOT_KICK_IMPULSE: SHOT_KICK_IMPULSE,
    SHOT_KICK_MAX: SHOT_KICK_MAX,
    SHOT_KICK_DECAY_BASE: SHOT_KICK_DECAY_BASE,
    playerMoveSpeed: playerMoveSpeed,
    movementAccelRate: movementAccelRate,
    stepHorizontalVelocity: stepHorizontalVelocity,
    stepHeadBob: stepHeadBob,
    landingStunDuration: landingStunDuration,
    stepJumpTimers: stepJumpTimers,
    canInitiateJump: canInitiateJump,
    stepAdsTransition: stepAdsTransition,
    stepGunSwitch: stepGunSwitch,
    applyShotKick: applyShotKick,
    decayShotKick: decayShotKick,
    sniperUnscopeAds: sniperUnscopeAds,
    SLIDE_VIGNETTE_RATE: SLIDE_VIGNETTE_RATE,
    SLIDE_VIGNETTE_MAX_ALPHA: SLIDE_VIGNETTE_MAX_ALPHA,
    stepSlideVignette: stepSlideVignette,
    slideVignetteStyle: slideVignetteStyle,
    objectiveLabel: objectiveLabel,
    objectiveHudChanged: objectiveHudChanged,
    syncObjectiveHudState: syncObjectiveHudState,
    isScopeOverlayActive: isScopeOverlayActive,
    scopeOverlayChanged: scopeOverlayChanged,
    syncScopeOverlayState: syncScopeOverlayState,
    isSteadyIndicatorVisible: isSteadyIndicatorVisible,
    steadyIndicatorLabel: steadyIndicatorLabel,
    steadyIndicatorChanged: steadyIndicatorChanged,
    syncSteadyIndicatorState: syncSteadyIndicatorState,
    MUSIC_RISE_RATE: MUSIC_RISE_RATE,
    MUSIC_FALL_RATE: MUSIC_FALL_RATE,
    MUSIC_BASE_BUS_GAIN: MUSIC_BASE_BUS_GAIN,
    MUSIC_INTENSITY_BUS_SCALE: MUSIC_INTENSITY_BUS_SCALE,
    MUSIC_TENSION_THRESHOLD: MUSIC_TENSION_THRESHOLD,
    MUSIC_TENSION_MAX_GAIN: MUSIC_TENSION_MAX_GAIN,
    MUSIC_BASE_CUTOFF: MUSIC_BASE_CUTOFF,
    MUSIC_MAX_CUTOFF_SCALE: MUSIC_MAX_CUTOFF_SCALE,
    MUSIC_BASE_BPM: MUSIC_BASE_BPM,
    MUSIC_MAX_BPM_SCALE: MUSIC_MAX_BPM_SCALE,
    MUSIC_PULSE_BASE_GAIN: MUSIC_PULSE_BASE_GAIN,
    MUSIC_PULSE_MAX_GAIN_SCALE: MUSIC_PULSE_MAX_GAIN_SCALE,
    MUSIC_PULSE_EXPONENT: MUSIC_PULSE_EXPONENT,
    stepMusicIntensity: stepMusicIntensity,
    musicBusGain: musicBusGain,
    musicTensionGain: musicTensionGain,
    musicFilterCutoff: musicFilterCutoff,
    musicPulseBpm: musicPulseBpm,
    stepMusicPulsePhase: stepMusicPulsePhase,
    musicPulseEnvelope: musicPulseEnvelope,
    musicPulseGain: musicPulseGain,
    stationPurchaseSound: stationPurchaseSound,
    playerDownSound: playerDownSound,
    playerReviveSound: playerReviveSound,
    touchUseLabel: touchUseLabel,
    touchUseChanged: touchUseChanged,
    syncTouchUseState: syncTouchUseState,
    VIEWMODEL_HIP_X: VIEWMODEL_HIP_X,
    VIEWMODEL_HIP_Y: VIEWMODEL_HIP_Y,
    VIEWMODEL_HIP_Z: VIEWMODEL_HIP_Z,
    VIEWMODEL_ADS_X: VIEWMODEL_ADS_X,
    VIEWMODEL_ADS_Y: VIEWMODEL_ADS_Y,
    VIEWMODEL_ADS_Z: VIEWMODEL_ADS_Z,
    VIEWMODEL_BOB_SCALE: VIEWMODEL_BOB_SCALE,
    VIEWMODEL_KICK_Z_SCALE: VIEWMODEL_KICK_Z_SCALE,
    VIEWMODEL_KICK_Y_SCALE: VIEWMODEL_KICK_Y_SCALE,
    VIEWMODEL_BOLT_REST_Z: VIEWMODEL_BOLT_REST_Z,
    VIEWMODEL_BOLT_KICK_SCALE: VIEWMODEL_BOLT_KICK_SCALE,
    VIEWMODEL_BOLT_KICK_MAX: VIEWMODEL_BOLT_KICK_MAX,
    VIEWMODEL_MAG_REST_Y: VIEWMODEL_MAG_REST_Y,
    VIEWMODEL_MAG_DROP_SCALE: VIEWMODEL_MAG_DROP_SCALE,
    VIEWMODEL_MAG_INSERT_SCALE: VIEWMODEL_MAG_INSERT_SCALE,
    VIEWMODEL_RELOAD_DIP: VIEWMODEL_RELOAD_DIP,
    VIEWMODEL_RELOAD_ROT: VIEWMODEL_RELOAD_ROT,
    VIEWMODEL_SWITCH_RAISE_DISTANCE: VIEWMODEL_SWITCH_RAISE_DISTANCE,
    VIEWMODEL_MUZZLE_FLASH_DECAY: VIEWMODEL_MUZZLE_FLASH_DECAY,
    VIEWMODEL_MUZZLE_LIGHT_BASE_INTENSITY: VIEWMODEL_MUZZLE_LIGHT_BASE_INTENSITY,
    VIEWMODEL_MUZZLE_LIGHT_DECAY_RATE: VIEWMODEL_MUZZLE_LIGHT_DECAY_RATE,
    IMPACT_VFX_LIFETIME: IMPACT_VFX_LIFETIME,
    IMPACT_VFX_EXPANSION_RATE: IMPACT_VFX_EXPANSION_RATE,
    VIEWMODEL_STANCE_OFFSETS: VIEWMODEL_STANCE_OFFSETS,
    viewmodelStance: viewmodelStance,
    viewmodelStanceOffsets: viewmodelStanceOffsets,
    reloadAnimationOffsets: reloadAnimationOffsets,
    viewmodelBoltOffset: viewmodelBoltOffset,
    viewmodelPose: viewmodelPose,
    stepMuzzleFlash: stepMuzzleFlash,
    stepMuzzleLight: stepMuzzleLight,
    impactVfxScale: impactVfxScale,
    PFX_DEFAULT_MAX: PFX_DEFAULT_MAX,
    SCOPE_PARALLAX_MAX: SCOPE_PARALLAX_MAX,
    SCOPE_PARALLAX_SCALE: SCOPE_PARALLAX_SCALE,
    SCOPE_RANGE_MAX: SCOPE_RANGE_MAX,
    SCOPE_RANGE_INTERVAL: SCOPE_RANGE_INTERVAL,
    POST_KICK_DECAY_RATE: POST_KICK_DECAY_RATE,
    pfxNeedsUpload: pfxNeedsUpload,
    scopeParallaxOffset: scopeParallaxOffset,
    scopeParallaxChanged: scopeParallaxChanged,
    rangefinderLabel: rangefinderLabel,
    isHostileTarget: isHostileTarget,
    stepRangefinderTimer: stepRangefinderTimer,
    stepSpring: stepSpring,
    vmSmooth: vmSmooth,
    vmBump: vmBump,
    wrapAngle: wrapAngle,
    stepPostKick: stepPostKick,
    postFringe: postFringe,
    isPostfxWanted: isPostfxWanted,
    CAN_RELOAD_MIN_DURATION: CAN_RELOAD_MIN_DURATION,
    MUNITIONS_MAG_RATIO: MUNITIONS_MAG_RATIO,
    SENTRY_RANGE: SENTRY_RANGE,
    SENTRY_ROF: SENTRY_ROF,
    SENTRY_DMG: SENTRY_DMG,
    SENTRY_DEPLOY_OFFSET: SENTRY_DEPLOY_OFFSET,
    MUNITIONS_DEPLOY_OFFSET: MUNITIONS_DEPLOY_OFFSET,
    AIRSTRIKE_LEAD_DIST: AIRSTRIKE_LEAD_DIST,
    AIRSTRIKE_BOMB_COUNT: AIRSTRIKE_BOMB_COUNT,
    AIRSTRIKE_SPACING: AIRSTRIKE_SPACING,
    AIRSTRIKE_BASE_DELAY: AIRSTRIKE_BASE_DELAY,
    AIRSTRIKE_STEP_DELAY: AIRSTRIKE_STEP_DELAY,
    AIRSTRIKE_JITTER: AIRSTRIKE_JITTER,
    ENEMY_GRENADE_MIN_SPEED: ENEMY_GRENADE_MIN_SPEED,
    ENEMY_GRENADE_MAX_SPEED: ENEMY_GRENADE_MAX_SPEED,
    ENEMY_GRENADE_SPEED_DIST_SCALE: ENEMY_GRENADE_SPEED_DIST_SCALE,
    ENEMY_GRENADE_ARC_Y: ENEMY_GRENADE_ARC_Y,
    ENEMY_GRENADE_FUSE_BONUS: ENEMY_GRENADE_FUSE_BONUS,
    ENEMY_GRENADE_JITTER: ENEMY_GRENADE_JITTER,
    PICKUP_LIFE: PICKUP_LIFE,
    PICKUP_BLINK_START: PICKUP_BLINK_START,
    PICKUP_COLLECT_RADIUS: PICKUP_COLLECT_RADIUS,
    PICKUP_POWER_ROT_SPEED: PICKUP_POWER_ROT_SPEED,
    PICKUP_STANDARD_ROT_SPEED: PICKUP_STANDARD_ROT_SPEED,
    FLASH_OVERLAY_MAX_ALPHA: FLASH_OVERLAY_MAX_ALPHA,
    FLASH_OVERLAY_DURATION_SCALE: FLASH_OVERLAY_DURATION_SCALE,
    canReload: canReload,
    effectiveReloadDuration: effectiveReloadDuration,
    isReloadComplete: isReloadComplete,
    completeReload: completeReload,
    munitionsAmmoRestore: munitionsAmmoRestore,
    airstrikeDelay: airstrikeDelay,
    airstrikeBombCoord: airstrikeBombCoord,
    enemyGrenadeSpeed: enemyGrenadeSpeed,
    enemyGrenadeFuse: enemyGrenadeFuse,
    enemyGrenadeCooldown: enemyGrenadeCooldown,
    enemyBurstInterval: enemyBurstInterval,
    pickupBobHeight: pickupBobHeight,
    isPickupVisible: isPickupVisible,
    pickupBlinkOpacity: pickupBlinkOpacity,
    canCollectPickup: canCollectPickup,
    grenadeBlinkVisible: grenadeBlinkVisible,
    flashOverlayOpacity: flashOverlayOpacity,
    smokeCloudScale: smokeCloudScale,
    smokeCloudOpacity: smokeCloudOpacity,
    burnPatchOpacity: burnPatchOpacity,
    powerupSound: powerupSound,
    equipmentDeploySound: equipmentDeploySound,
    steadyAimBreathEvent: steadyAimBreathEvent,
    exhaustionSound: exhaustionSound,
    slideCancelSound: slideCancelSound,
    CASING_MAX: CASING_MAX,
    CASING_LIFETIME: CASING_LIFETIME,
    CASING_FADE_DURATION: CASING_FADE_DURATION,
    CASING_FLOOR_Y: CASING_FLOOR_Y,
    CASING_GRAVITY: CASING_GRAVITY,
    CASING_BOUNCE: CASING_BOUNCE,
    CASING_FRICTION: CASING_FRICTION,
    CASING_SPIN_DAMP: CASING_SPIN_DAMP,
    CASING_REST_SPEED: CASING_REST_SPEED,
    CASING_SND_GAP: CASING_SND_GAP,
    VIEWMODEL_MANTLE_IN_RATE: VIEWMODEL_MANTLE_IN_RATE,
    VIEWMODEL_MANTLE_OUT_RATE: VIEWMODEL_MANTLE_OUT_RATE,
    casingScale: casingScale,
    casingEjectVelocity: casingEjectVelocity,
    stepCasingPhysics: stepCasingPhysics,
    casingRestRotation: casingRestRotation,
    stepMeleeKnifePose: stepMeleeKnifePose,
    meleeGunDodgeOffsets: meleeGunDodgeOffsets,
    stepViewmodelMantle: stepViewmodelMantle,
    viewmodelMantleOffsets: viewmodelMantleOffsets,
    reloadHandOffsets: reloadHandOffsets,
    viewmodelLateralSpeed: viewmodelLateralSpeed,
    stepViewmodelTilt: stepViewmodelTilt,
    viewmodelLookInertiaTarget: viewmodelLookInertiaTarget,
    BUY_PROMPT_DEFAULT_COLOR: BUY_PROMPT_DEFAULT_COLOR,
    BUY_PROMPT_DIM_COLOR: BUY_PROMPT_DIM_COLOR,
    buyPromptLabel: buyPromptLabel,
    buyPromptFillPct: buyPromptFillPct,
    buyPromptColor: buyPromptColor,
    buyPromptChanged: buyPromptChanged,
    syncBuyPromptState: syncBuyPromptState,
    COMPASS_YAW_THRESHOLD: COMPASS_YAW_THRESHOLD,
    compassNeedsRedraw: compassNeedsRedraw,
    minimapScale: minimapScale,
    minimapDetectRadiusSq: minimapDetectRadiusSq,
    minimapBlipOffset: minimapBlipOffset,
    isMinimapBlipVisible: isMinimapBlipVisible,
    minimapEnemyRadius: minimapEnemyRadius,
    compassTickAngle: compassTickAngle,
    compassSnapAngle: compassSnapAngle,
    compassTickVisible: compassTickVisible,
    compassTickStyle: compassTickStyle,
    RAGDOLL_SINK_DELAY: RAGDOLL_SINK_DELAY,
    RAGDOLL_SINK_RATE: RAGDOLL_SINK_RATE,
    RAGDOLL_SINK_MAX: RAGDOLL_SINK_MAX,
    RAGDOLL_DROP_SCALE: RAGDOLL_DROP_SCALE,
    isRagdollSinkReady: isRagdollSinkReady,
    stepRagdollSink: stepRagdollSink,
    ragdollDropOffsetY: ragdollDropOffsetY,
    isRagdollExpired: isRagdollExpired,
    ENEMY_PROC_WALK_THRESHOLD: ENEMY_PROC_WALK_THRESHOLD,
    ENEMY_PROC_BASE_FREQ: ENEMY_PROC_BASE_FREQ,
    enemyProcWalkSpeed: enemyProcWalkSpeed,
    stepEnemyProcWalkPhase: stepEnemyProcWalkPhase,
    enemyProcLimbSwing: enemyProcLimbSwing,
    enemyProcPitchTrack: enemyProcPitchTrack,
    enemyProcPose: enemyProcPose,
    WAVE_SPAWN_PRESSURE_QUEUE: WAVE_SPAWN_PRESSURE_QUEUE,
    WAVE_SPAWN_SWEET_SPOT: WAVE_SPAWN_SWEET_SPOT,
    WAVE_SPAWN_JITTER: WAVE_SPAWN_JITTER,
    AMMO_RELIEF_DRY_THRESHOLD: AMMO_RELIEF_DRY_THRESHOLD,
    AMMO_RELIEF_COOLDOWN: AMMO_RELIEF_COOLDOWN,
    ENEMY_BULLET_DELAY_FACTOR: ENEMY_BULLET_DELAY_FACTOR,
    ENEMY_BULLET_MAX_DELAY_MS: ENEMY_BULLET_MAX_DELAY_MS,
    ENEMY_MELEE_WINDUP_BASE: ENEMY_MELEE_WINDUP_BASE,
    ENEMY_MELEE_WINDUP_RANGE: ENEMY_MELEE_WINDUP_RANGE,
    ENEMY_MELEE_FOLLOW_REACH_PADDING: ENEMY_MELEE_FOLLOW_REACH_PADDING,
    ENEMY_STUN_SPEED_MUL: ENEMY_STUN_SPEED_MUL,
    ENEMY_BLIND_YAW_RATE: ENEMY_BLIND_YAW_RATE,
    ENEMY_FALL_SPEED: ENEMY_FALL_SPEED,
    SLIDE_CANCEL_MIN_T: SLIDE_CANCEL_MIN_T,
    SLIDE_TIMEOUT_T: SLIDE_TIMEOUT_T,
    SLIDE_STOP_MIN_T: SLIDE_STOP_MIN_T,
    STATION_HOLD_DECAY_RATE: STATION_HOLD_DECAY_RATE,
    waveSpawnPressure: waveSpawnPressure,
    waveSpawnBurstCount: waveSpawnBurstCount,
    waveSpawnDelay: waveSpawnDelay,
    spawnCandidateScore: spawnCandidateScore,
    stepAmmoReliefTimer: stepAmmoReliefTimer,
    isAmmoReliefNeeded: isAmmoReliefNeeded,
    enemyBulletTravelDelay: enemyBulletTravelDelay,
    enemyRangedNextShot: enemyRangedNextShot,
    enemyMeleeWindup: enemyMeleeWindup,
    enemyAttackReadyTime: enemyAttackReadyTime,
    enemyKillImpulse: enemyKillImpulse,
    enemyStunSpeedMultiplier: enemyStunSpeedMultiplier,
    stepEnemyBlindYaw: stepEnemyBlindYaw,
    stepEnemyFallY: stepEnemyFallY,
    canSlideCancel: canSlideCancel,
    isSlideExpired: isSlideExpired,
    stepStationHold: stepStationHold,
    weaponFireInterval: weaponFireInterval,
    SPATIAL_IMPACT_MAX_DIST: SPATIAL_IMPACT_MAX_DIST,
    SNIPER_BOLT_DELAY_MS: SNIPER_BOLT_DELAY_MS,
    surfaceImpactSound: surfaceImpactSound,
    sniperBoltSound: sniperBoltSound,
    streakReadySound: streakReadySound,
    fieldUpgradeReadySound: fieldUpgradeReadySound,
    secondWindSound: secondWindSound,
    objectiveCompleteSound: objectiveCompleteSound,
    weaponDrawSound: weaponDrawSound,
    DECAL_MAX: DECAL_MAX,
    DECAL_LIFETIME: DECAL_LIFETIME,
    DECAL_FADE_DURATION: DECAL_FADE_DURATION,
    DECAL_BASE_RADIUS: DECAL_BASE_RADIUS,
    DECAL_STANDOFF: DECAL_STANDOFF,
    MUZZLE_FLASH_SUPPRESSED_SCALE: MUZZLE_FLASH_SUPPRESSED_SCALE,
    TRACER_LIFETIME: TRACER_LIFETIME,
    decalCaliberScale: decalCaliberScale,
    decalSurfaceMultiplier: decalSurfaceMultiplier,
    decalScale: decalScale,
    decalRotationAngle: decalRotationAngle,
    stepDecalLife: stepDecalLife,
    isDecalExpired: isDecalExpired,
    muzzleFlashRotation: muzzleFlashRotation,
    muzzleFlashBaseScale: muzzleFlashBaseScale,
    stepMuzzleFlashScale: stepMuzzleFlashScale,
    tracerThicknessScale: tracerThicknessScale,
    tracerColor: tracerColor,
    isColliderRelevantXZ: isColliderRelevantXZ,
    movementTargetVelocity: movementTargetVelocity,
    HUD_REDRAW_INTERVAL: HUD_REDRAW_INTERVAL,
    HUD_FLICK_YAW_THRESHOLD: HUD_FLICK_YAW_THRESHOLD,
    HUD_FLICK_COOLDOWN: HUD_FLICK_COOLDOWN,
    shouldRedrawHudCanvas: shouldRedrawHudCanvas,
    countAliveEnemies: countAliveEnemies,
    hostilesRemainingLabel: hostilesRemainingLabel,
    gunCameraFov: gunCameraFov,
    viewmodelNarrowOffset: viewmodelNarrowOffset,
    STEP_HEIGHT: STEP_HEIGHT,
    SLIDE_STEER_RATE: SLIDE_STEER_RATE,
    TAC_TAP_WINDOW: TAC_TAP_WINDOW,
    TAC_DURATION: TAC_DURATION,
    GRENADE_BOUNCE_LAT_DAMP: GRENADE_BOUNCE_LAT_DAMP,
    GRENADE_ROLL_LAT_DAMP: GRENADE_ROLL_LAT_DAMP,
    enemyScale: enemyScale,
    enemyColliderRadius: enemyColliderRadius,
    enemyHeadHeight: enemyHeadHeight,
    enemySpawnSpeedMultiplier: enemySpawnSpeedMultiplier,
    isEnemyFlanker: isEnemyFlanker,
    enemyFallbackVelocity: enemyFallbackVelocity,
    enemyStrafeVelocity: enemyStrafeVelocity,
    enemyStrafeDuration: enemyStrafeDuration,
    canEnemyThrowGrenade: canEnemyThrowGrenade,
    enemyFootstepRate: enemyFootstepRate,
    enemyFootstepInterval: enemyFootstepInterval,
    relocateFacingAlignment: relocateFacingAlignment,
    relocateCandidateScore: relocateCandidateScore,
    stepSlideSteering: stepSlideSteering,
    isTacSprintTriggered: isTacSprintTriggered,
    stepGrenadeBounceVelocity: stepGrenadeBounceVelocity,
    isGrenadeAtRest: isGrenadeAtRest,
    downBleedoutLabel: downBleedoutLabel,
    multikillBonus: multikillBonus,
    waveCountdownLabel: waveCountdownLabel,
    waveBannerLabels: waveBannerLabels,
    SENTRY_AIM_Y_OFFSET: SENTRY_AIM_Y_OFFSET,
    BURN_TICK_INTERVAL: BURN_TICK_INTERVAL,
    stepTracerLife: stepTracerLife,
    isTracerExpired: isTracerExpired,
    stepImpactLife: stepImpactLife,
    isImpactExpired: isImpactExpired,
    sentryTargetYaw: sentryTargetYaw,
    stepSentryTimers: stepSentryTimers,
    sentryAimTargetY: sentryAimTargetY,
    burnTickDamage: burnTickDamage,
    isPointInBurnRadius: isPointInBurnRadius,
    SPREAD_LONGITUDINAL_SCALE: SPREAD_LONGITUDINAL_SCALE,
    AIM_ASSIST_HEAD_THRESHOLD: AIM_ASSIST_HEAD_THRESHOLD,
    AIM_ASSIST_HEAD_PRIORITY: AIM_ASSIST_HEAD_PRIORITY,
    AIM_ASSIST_PULL_WEIGHT: AIM_ASSIST_PULL_WEIGHT,
    AIM_ASSIST_TRACK_RATE: AIM_ASSIST_TRACK_RATE,
    AIM_ASSIST_CHEST_OFFSET: AIM_ASSIST_CHEST_OFFSET,
    AIM_ASSIST_HEAD_OFFSET: AIM_ASSIST_HEAD_OFFSET,
    BULLET_MAGNET_Y_OFFSET: BULLET_MAGNET_Y_OFFSET,
    ENEMY_SPAWN_DURATION: ENEMY_SPAWN_DURATION,
    ENEMY_STRAFE_MAX_T: ENEMY_STRAFE_MAX_T,
    GRENADIER_STRAFE_RANGE: GRENADIER_STRAFE_RANGE,
    GRENADIER_STRAFE_DURATION: GRENADIER_STRAFE_DURATION,
    RIFLEMAN_STRAFE_DURATION: RIFLEMAN_STRAFE_DURATION,
    RIFLEMAN_LOS_RETRY_DELAY: RIFLEMAN_LOS_RETRY_DELAY,
    FLANK_STEER_WEIGHT: FLANK_STEER_WEIGHT,
    ENEMY_OVERLAP_MIN_DIST: ENEMY_OVERLAP_MIN_DIST,
    ENEMY_SHOT_CHEST_Y_OFFSET: ENEMY_SHOT_CHEST_Y_OFFSET,
    MANTLE_DURATION: MANTLE_DURATION,
    MANTLE_COYOTE_GRACE: MANTLE_COYOTE_GRACE,
    GRENADE_PITCH_LOFT: GRENADE_PITCH_LOFT,
    GRENADE_COOLDOWN: GRENADE_COOLDOWN,
    TACTICAL_SPEED_MUL: TACTICAL_SPEED_MUL,
    PLAYER_FLASH_SELF_MUL: PLAYER_FLASH_SELF_MUL,
    ballisticSpreadVector: ballisticSpreadVector,
    bulletPenetrationPower: bulletPenetrationPower,
    isAimAssistHeadCandidate: isAimAssistHeadCandidate,
    aimAssistAngularDeltas: aimAssistAngularDeltas,
    stepAimAssistLook: stepAimAssistLook,
    enemyAiNextState: enemyAiNextState,
    stepFlankVelocity: stepFlankVelocity,
    playerPushoutOffset: playerPushoutOffset,
    enemyAimTargetY: enemyAimTargetY,
    stepMantleProgress: stepMantleProgress,
    grenadeThrowVelocity: grenadeThrowVelocity,
    playerSelfFlashDuration: playerSelfFlashDuration,
    GRENADE_RING_BASE_OPACITY: GRENADE_RING_BASE_OPACITY,
    GRENADE_RING_MAX_OPACITY: GRENADE_RING_MAX_OPACITY,
    MINIMAP_SENTRY_COLOR: MINIMAP_SENTRY_COLOR,
    MINIMAP_MUNITIONS_COLOR: MINIMAP_MUNITIONS_COLOR,
    MINIMAP_PICKUP_AMMO_COLOR: MINIMAP_PICKUP_AMMO_COLOR,
    MINIMAP_PICKUP_MED_COLOR: MINIMAP_PICKUP_MED_COLOR,
    MINIMAP_PICKUP_POWER_COLOR: MINIMAP_PICKUP_POWER_COLOR,
    MINIMAP_SENTRY_RADIUS: MINIMAP_SENTRY_RADIUS,
    MINIMAP_MUNITIONS_SIZE: MINIMAP_MUNITIONS_SIZE,
    MINIMAP_PICKUP_BASE_RADIUS: MINIMAP_PICKUP_BASE_RADIUS,
    BURN_PATCH_HEAT_FLICKER_FREQ: BURN_PATCH_HEAT_FLICKER_FREQ,
    grenadeDangerRingOpacity: grenadeDangerRingOpacity,
    burnPatchPulsingOpacity: burnPatchPulsingOpacity,
    burnPatchFlameStrength: burnPatchFlameStrength,
    minimapPickupColor: minimapPickupColor,
    pickupMinimapPulse: pickupMinimapPulse,
    sentryMinimapPointer: sentryMinimapPointer,
    BULLET_WHIZ_MAX_DIST: BULLET_WHIZ_MAX_DIST,
    BULLET_WHIZ_MIN_OFFSET: BULLET_WHIZ_MIN_OFFSET,
    LOW_AMMO_THRESHOLD_AR: LOW_AMMO_THRESHOLD_AR,
    LOW_AMMO_THRESHOLD_SMG: LOW_AMMO_THRESHOLD_SMG,
    LOW_AMMO_THRESHOLD_BR: LOW_AMMO_THRESHOLD_BR,
    LOW_AMMO_THRESHOLD_SR: LOW_AMMO_THRESHOLD_SR,
    bulletWhizSound: bulletWhizSound,
    isBulletNearMiss: isBulletNearMiss,
    bulletNearMissOffset: bulletNearMissOffset,
    bulletWhizVolume: bulletWhizVolume,
    lowAmmoThreshold: lowAmmoThreshold,
    isLowAmmo: isLowAmmo,
    lowAmmoSound: lowAmmoSound,
    reloadBoltSound: reloadBoltSound,
    isEmptyReload: isEmptyReload,
    STANCE_RECOIL_CROUCH: STANCE_RECOIL_CROUCH,
    STANCE_RECOIL_SLIDE: STANCE_RECOIL_SLIDE,
    STANCE_RECOIL_AIRBORNE: STANCE_RECOIL_AIRBORNE,
    ENEMY_GRENADE_ARM_DURATION: ENEMY_GRENADE_ARM_DURATION,
    ENEMY_LIVE_GRENADES_CAP: ENEMY_LIVE_GRENADES_CAP,
    GRENADIER_INITIAL_NADE_DELAY: GRENADIER_INITIAL_NADE_DELAY,
    RIFLEMAN_INITIAL_NADE_DELAY: RIFLEMAN_INITIAL_NADE_DELAY,
    ENEMY_EYE_OFFSET_Y: ENEMY_EYE_OFFSET_Y,
    ENEMY_LOS_JITTER: ENEMY_LOS_JITTER,
    ENEMY_MELEE_COOLDOWN_SENTINEL: ENEMY_MELEE_COOLDOWN_SENTINEL,
    ENEMY_MELEE_RESET_MARGIN: ENEMY_MELEE_RESET_MARGIN,
    stanceRecoilMultiplier: stanceRecoilMultiplier,
    effectiveRecoilKick: effectiveRecoilKick,
    enemyInitialGrenadeDelay: enemyInitialGrenadeDelay,
    canSpawnEnemyGrenade: canSpawnEnemyGrenade,
    enemyGrenadeVelocity: enemyGrenadeVelocity,
    enemyEyeHeight: enemyEyeHeight,
    enemyLosTargetCoord: enemyLosTargetCoord,
    isEnemyMeleeReset: isEnemyMeleeReset,
    shouldUpdatePfxLayer: shouldUpdatePfxLayer,
    isGrenadeLosBlocker: isGrenadeLosBlocker,
    enemyToPlayerDir: enemyToPlayerDir,
    totalPlayerRounds: totalPlayerRounds,
    hasPlayerRounds: hasPlayerRounds,
    SCORCH_MAX: SCORCH_MAX,
    SCORCH_LIFETIME: SCORCH_LIFETIME,
    SCORCH_FADE_DURATION: SCORCH_FADE_DURATION,
    SCORCH_BASE_RADIUS: SCORCH_BASE_RADIUS,
    SCORCH_BASE_OPACITY: SCORCH_BASE_OPACITY,
    SCORCH_STANDOFF: SCORCH_STANDOFF,
    SCORCH_EXPANSION_DURATION: SCORCH_EXPANSION_DURATION,
    ENEMY_MUZZLE_LIGHT_COLOR: ENEMY_MUZZLE_LIGHT_COLOR,
    ENEMY_MUZZLE_LIGHT_INTENSITY: ENEMY_MUZZLE_LIGHT_INTENSITY,
    ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY: ENEMY_MUZZLE_LIGHT_ELITE_INTENSITY,
    ENEMY_MUZZLE_LIGHT_DIST: ENEMY_MUZZLE_LIGHT_DIST,
    ENEMY_MUZZLE_LIGHT_DUR: ENEMY_MUZZLE_LIGHT_DUR,
    scorchScale: scorchScale,
    scorchScaleProgress: scorchScaleProgress,
    scorchOpacity: scorchOpacity,
    stepScorchLife: stepScorchLife,
    isScorchExpired: isScorchExpired,
    scorchRotation: scorchRotation,
    scorchElevation: scorchElevation,
    enemyMuzzleLightParams: enemyMuzzleLightParams,
    AIR_ABSORPTION_MAX_FREQ: AIR_ABSORPTION_MAX_FREQ,
    AIR_ABSORPTION_MIN_FREQ: AIR_ABSORPTION_MIN_FREQ,
    AIR_ABSORPTION_Q: AIR_ABSORPTION_Q,
    spatialAudioCutoff: spatialAudioCutoff,
    HEARTBEAT_BPM_MIN: HEARTBEAT_BPM_MIN,
    HEARTBEAT_BPM_MAX: HEARTBEAT_BPM_MAX,
    heartbeatBpm: heartbeatBpm,
    heartbeatInterval: heartbeatInterval,
    stepHeartbeatTimer: stepHeartbeatTimer,
    shouldPlayHeartbeat: shouldPlayHeartbeat,
    heartbeatSound: heartbeatSound,
    enemyGunfireSound: enemyGunfireSound,
    STANCE_SPREAD_CROUCH: STANCE_SPREAD_CROUCH,
    STANCE_SPREAD_SLIDE: STANCE_SPREAD_SLIDE,
    STANCE_SPREAD_AIRBORNE_PENALTY: STANCE_SPREAD_AIRBORNE_PENALTY,
    stanceSpreadMultiplier: stanceSpreadMultiplier,
    EXPLOSION_KICK_MAX_DIST: EXPLOSION_KICK_MAX_DIST,
    EXPLOSION_POST_KICK_MAX: EXPLOSION_POST_KICK_MAX,
    EXPLOSION_SHOT_KICK_MAX: EXPLOSION_SHOT_KICK_MAX,
    EXPLOSION_SHOT_KICK_CAP: EXPLOSION_SHOT_KICK_CAP,
    HEADSHOT_MUL_SR: HEADSHOT_MUL_SR,
    HEADSHOT_MUL_BR: HEADSHOT_MUL_BR,
    HEADSHOT_MUL_AR: HEADSHOT_MUL_AR,
    HEADSHOT_MUL_SMG: HEADSHOT_MUL_SMG,
    ENEMY_ACCURACY_FALLOFF_DIST: ENEMY_ACCURACY_FALLOFF_DIST,
    ENEMY_ACCURACY_MIN_FACTOR: ENEMY_ACCURACY_MIN_FACTOR,
    explosionKickIntensity: explosionKickIntensity,
    explosionPostKick: explosionPostKick,
    explosionShotKick: explosionShotKick,
    applyExplosionShotKick: applyExplosionShotKick,
    weaponHeadshotMultiplier: weaponHeadshotMultiplier,
    enemyDistanceAccuracy: enemyDistanceAccuracy,
    FLASH_LIGHT_DECAY_EXPONENT: FLASH_LIGHT_DECAY_EXPONENT,
    SENTRY_TARGET_ACQUIRE_EPSILON: SENTRY_TARGET_ACQUIRE_EPSILON,
    stepFlashLightLife: stepFlashLightLife,
    flashLightIntensity: flashLightIntensity,
    particlePerspectiveScale: particlePerspectiveScale,
    isSentryTargetInRange: isSentryTargetInRange,
    buildShadowCasterMask: buildShadowCasterMask,
    planarFacingDirection: planarFacingDirection,
    shouldUpdatePickupOpacity: shouldUpdatePickupOpacity
  };
})();

// Node (tests) picks the namespace up here; in the browser build this is a no-op.
if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
