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
  function shadowCasters(positions, px, pz, budget) {
    const n = positions.length;
    const out = [];
    for (let i = 0; i < n; i++) out.push(i);
    if (n <= budget) return out;
    const d = new Array(n);
    for (let i = 0; i < n; i++) d[i] = horizDistSq(positions[i].x, positions[i].z, px, pz);
    out.sort(function (a, b) { return d[a] - d[b]; });
    out.length = budget;
    return out;
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

  // ---- AABB helpers ----------------------------------------------------------
  function aabbOverlapsXZ(c, x, z, r) {
    return x > c.min.x - r && x < c.max.x + r && z > c.min.z - r && z < c.max.z + r;
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

  // ---- Settings ---------------------------------------------------------------
  // Schema-driven so the UI, the persistence layer and the validator cannot drift
  // apart. Stored values are never trusted: localStorage is editable, survives
  // across versions, and a bad number here would silently break aiming or audio.
  const SETTINGS_SCHEMA = {
    sensitivity: { type: 'number', def: 1.0, min: 0.2, max: 4.0, step: 0.05, label: 'Mouse sensitivity' },
    invertY: { type: 'bool', def: false, label: 'Invert vertical look' },
    fov: { type: 'number', def: 72, min: 60, max: 100, step: 1, label: 'Field of view' },
    masterVolume: { type: 'number', def: 0.9, min: 0, max: 1, step: 0.05, label: 'Master volume' },
    musicVolume: { type: 'number', def: 0.5, min: 0, max: 1, step: 0.05, label: 'Music & ambience' },
    muted: { type: 'bool', def: false, label: 'Mute all audio' },
    quality: { type: 'enum', def: 'auto', values: ['low', 'medium', 'high', 'auto'], label: 'Graphics quality' },
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
  function mergeRunIntoStats(stats, run) {
    const next = sanitizeStats(stats);
    const beat = { score: false, wave: false, accuracy: false };
    if (run.score > next.bestScore) { next.bestScore = run.score; beat.score = true; }
    if (run.wave > next.bestWave) { next.bestWave = run.wave; beat.wave = true; }
    if (run.accuracy > next.bestAccuracy) { next.bestAccuracy = run.accuracy; beat.accuracy = true; }
    next.runs = next.runs + 1;
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

  // ---- Checkpoint save --------------------------------------------------------
  // A full run is ~341 enemies across 15 waves — 25-40 minutes. Losing that to a
  // closed tab was the single worst quality-of-life problem left. Saved between
  // waves only, so it can never capture a half-resolved combat state.
  const SAVE_VERSION = 2;
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
      weapons: state.weapons,            // [{gi, ammo, reserve}, ...]
      savedAt: state.savedAt || 0
    };
  }
  // Returns a usable checkpoint or null. Never throws on malformed input.
  function validateCheckpoint(raw, weaponCount) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.v !== SAVE_VERSION) return null;          // old saves are dropped, not guessed at
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
      const gi = Math.round(num(w.gi, -1, (weaponCount || 4) - 1, -1));
      if (gi < 0) { weapons.push(null); continue; }
      weapons.push({ gi: gi, ammo: Math.round(num(w.ammo, 0, 999, 0)), reserve: Math.round(num(w.reserve, 0, 9999, 0)) });
    }
    if (!weapons.length || !weapons[0]) return null;   // a run needs a primary
    return {
      v: SAVE_VERSION, wave: wave,
      score: Math.round(num(raw.score, 0, 1e9, 0)),
      kills: Math.round(num(raw.kills, 0, 1e6, 0)),
      headshots: Math.round(num(raw.headshots, 0, 1e6, 0)),
      shotsFired: Math.round(num(raw.shotsFired, 0, 1e7, 0)),
      shotsHit: Math.round(num(raw.shotsHit, 0, 1e7, 0)),
      health: num(raw.health, 1, 100, 100),
      armor: num(raw.armor, 0, 200, 0),
      credits: num(raw.credits, 0, 1e9, 0),
      // Only keys that still exist survive a reload: a perk renamed or removed
      // between versions must not resurrect as an unknown string.
      perks: (Array.isArray(raw.perks) ? raw.perks : [])
        .filter(function (k) { return !!perkByKey(k); }).slice(0, PERK_SLOTS),
      plates: num(raw.plates, 0, PLATE_MAX, 0),
      grenades: Math.round(num(raw.grenades, 0, 9, 0)),
      difficulty: DIFFICULTIES[raw.difficulty] ? raw.difficulty : 'regular',
      endless: !!raw.endless,
      weapons: weapons,
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
  function cellCenter(nav, index) {
    const gx = index % nav.dim, gz = (index / nav.dim) | 0;
    return { x: nav.originX + (gx + 0.5) * nav.cell, z: nav.originZ + (gz + 0.5) * nav.cell };
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
    const target = cellCenter(nav, bestIdx);
    const dx = target.x - x, dz = target.z - z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return null;
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
  function recoilAt(pattern, shotIndex, jx, jy) {
    const p = RECOIL_PATTERNS[pattern] || RECOIL_PATTERNS.ar;
    let i = Math.floor(shotIndex);
    if (!(i >= 0)) i = 0;
    if (i >= p.length) i = p.length - 1;
    const ax = jx === undefined ? 0 : jx, ay = jy === undefined ? 0 : jy;
    return {
      x: p[i][0] * (1 + ax * RECOIL_JITTER),
      y: p[i][1] * (1 + ay * RECOIL_JITTER)
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
  function absorbRecoil(offset, lookDelta) {
    if (offset > 0 && lookDelta < 0) {
      const used = Math.min(offset, -lookDelta);
      return { offset: offset - used, delta: lookDelta + used };
    }
    if (offset < 0 && lookDelta > 0) {
      const used = Math.min(-offset, lookDelta);
      return { offset: offset + used, delta: lookDelta - used };
    }
    return { offset: offset, delta: lookDelta };
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
  function effectiveSpread(base, bloom, speed, airborne) {
    const moveMul = 1 + Math.min(1.2, speed * 0.25) + (airborne ? 0.8 : 0);
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
  // `targets` is [{ x, z, dead }]; dirX/dirZ is the player's forward on XZ.
  function meleeTarget(targets, px, pz, dirX, dirZ, reach, cosHalfAngle) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.dead) continue;
      const dx = t.x - px, dz = t.z - pz;
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
    const headroom = o.headroom === undefined ? 1.3 : o.headroom;
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
    return {
      dmg: w.dmg * ARMORY_DMG,
      mag: Math.round(w.mag * ARMORY_MAG),
      reserveMax: Math.round(w.reserveMax * ARMORY_MAG),
      name: 'MK2 ' + w.name,
      upgraded: true
    };
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

  return {
    horizDist: horizDist,
    horizDistSq: horizDistSq,
    subStepCount: subStepCount,
    ceilingClamp: ceilingClamp,
    shadowCasters: shadowCasters,
    MAX_SUBSTEPS: MAX_SUBSTEPS,
    distanceFalloff: distanceFalloff,
    waveEnemyCount: waveEnemyCount,
    waveHpMultiplier: waveHpMultiplier,
    waveRangedAccuracy: waveRangedAccuracy,
    aabbOverlapsXZ: aabbOverlapsXZ,
    blocksWalker: blocksWalker,
    isSpawnValid: isSpawnValid,
    SETTINGS_SCHEMA: SETTINGS_SCHEMA,
    defaultSettings: defaultSettings,
    clampSetting: clampSetting,
    sanitizeSettings: sanitizeSettings,
    lookSensitivity: lookSensitivity,
    combatIntensity: combatIntensity,
    BASE_SENSITIVITY: BASE_SENSITIVITY,
    defaultStats: defaultStats,
    sanitizeStats: sanitizeStats,
    mergeRunIntoStats: mergeRunIntoStats,
    DIFFICULTIES: DIFFICULTIES,
    difficulty: difficulty,
    BEHAVIOUR_UNLOCKS: BEHAVIOUR_UNLOCKS,
    behavioursAtWave: behavioursAtWave,
    newBehavioursAtWave: newBehavioursAtWave,
    pickEnemyKind: pickEnemyKind,
    enemyStopDistance: enemyStopDistance,
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
    UNREACHABLE: UNREACHABLE
  };
})();

// Node (tests) picks the namespace up here; in the browser build this is a no-op.
if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
