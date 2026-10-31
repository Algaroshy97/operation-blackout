'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CORE = require('../src/01_core.js');

const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
  normalize() { const l = Math.sqrt(this.lengthSq()) || 1; return this.set(this.x / l, this.y / l, this.z / l); }
  applyQuaternion() { return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
  crossVectors(a, b) { const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x; return this.set(x, y, z); }
}

class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material || {};
    this.position = new Vector3();
    this.rotation = { x: 0, y: 0, z: 0 };
    this.scale = new Vector3(1, 1, 1);
    this.children = [];
    this.userData = {};
  }
  add(child) { this.children.push(child); }
  clone() {
    const m = new Mesh();
    m.position.copy(this.position);
    m.rotation = Object.assign({}, this.rotation);
    m.scale.copy(this.scale);
    m.userData = Object.assign({}, this.userData);
    return m;
  }
  traverse(fn) {
    fn(this);
    for (const c of this.children) if (c && c.traverse) c.traverse(fn);
  }
}

class Group extends Mesh {}
class Material {
  constructor(opts) { Object.assign(this, opts); }
  clone() { return new Material(this); }
  dispose() {}
}
class Geometry {
  dispose() {}
}

const noop = () => {};

test('CORE team hostility and threat selection rules', () => {
  // 1. isHostile rules
  assert.equal(typeof CORE.isHostile, 'function', 'CORE.isHostile must be defined');
  const friendlyA = { team: 'friendly', dead: false };
  const friendlyB = { team: 'friendly', dead: false };
  const enemyA = { team: 'enemy', dead: false };
  const enemyB = { team: 'enemy', dead: false };
  const deadEnemy = { team: 'enemy', dead: true };

  assert.equal(CORE.isHostile(friendlyA, friendlyA), false, 'self is never hostile');
  assert.equal(CORE.isHostile(friendlyA, friendlyB), false, 'teammates are never hostile (friendly fire off)');
  assert.equal(CORE.isHostile(enemyA, enemyB), false, 'enemy teammates are never hostile');
  assert.equal(CORE.isHostile(friendlyA, enemyA), true, 'opposing teams are hostile');
  assert.equal(CORE.isHostile(enemyA, friendlyA), true, 'hostility is mutual');
  assert.equal(CORE.isHostile(friendlyA, deadEnemy), false, 'dead actor cannot be hostile');
  assert.equal(CORE.isHostile(null, enemyA), false);

  // Default team resolution when team property is omitted
  const defaultPlayer = { isPlayer: true, dead: false };
  const defaultEnemy = { dead: false };
  assert.equal(CORE.isHostile(defaultPlayer, defaultEnemy), true, 'default player and enemy are hostile');
  assert.equal(CORE.isHostile(defaultPlayer, defaultPlayer), false);

  // 2. pickNearestHostile rules
  assert.equal(typeof CORE.pickNearestHostile, 'function', 'CORE.pickNearestHostile must be defined');
  const actor = { team: 'enemy', pos: new Vector3(0, 0, 0), dead: false };
  const allyClose = { team: 'enemy', pos: new Vector3(2, 0, 0), dead: false };
  const hostileNear = { team: 'friendly', pos: new Vector3(10, 0, 0), dead: false };
  const hostileFar = { team: 'friendly', pos: new Vector3(25, 0, 0), dead: false };
  const deadHostile = { team: 'friendly', pos: new Vector3(1, 0, 0), dead: true };

  const candidates = [allyClose, deadHostile, hostileFar, hostileNear];
  const picked = CORE.pickNearestHostile(actor, candidates);
  assert.equal(picked, hostileNear, 'picks nearest alive hostile, ignoring closer allies and dead hostiles');

  // Max range bounding
  assert.equal(CORE.pickNearestHostile(actor, [hostileFar], 20), null, 'ignores hostiles outside maxRange');
  assert.equal(CORE.pickNearestHostile(actor, [hostileNear], 20), hostileNear, 'selects hostile within maxRange');
  assert.equal(CORE.pickNearestHostile(actor, [allyClose]), null, 'returns null when no hostiles present');
});

test('CORE mode framework: scoreboard data and match lifecycle completion', () => {
  assert.equal(typeof CORE.modeScoreboardData, 'function');
  assert.equal(typeof CORE.isModeOver, 'function');

  const survivalStats = { wave: 5, score: 12500, kills: 42, headshots: 18, credits: 3400 };
  const sb = CORE.modeScoreboardData('survival', survivalStats);
  assert.equal(sb.mode, 'survival');
  assert.equal(sb.wave, 5);
  assert.equal(sb.score, 12500);
  assert.equal(sb.kills, 42);
  assert.equal(sb.headshots, 18);
  assert.equal(sb.credits, 3400);

  // Survival isOver logic
  assert.equal(CORE.isModeOver('survival', { gameEnded: false, playerDead: false, playerDowned: false }), false);
  assert.equal(CORE.isModeOver('survival', { gameEnded: true, playerDead: false, playerDowned: false }), true);
  assert.equal(CORE.isModeOver('survival', { gameEnded: false, playerDead: true, playerDowned: false }), true);
  assert.equal(CORE.isModeOver('survival', { gameEnded: false, playerDead: true, playerDowned: true }), false, 'downed player can still revive');
});

test('MODES registry exists and registers unchanged Survival interface', () => {
  const modesSrc = source('35_modes.js');
  const c = vm.createContext({
    CORE,
    player: { dead: false, downed: false },
    gameEnded: false,
    waveNum: 0,
    waveQueue: 0,
    waveActive: false,
    betweenWaveT: 0,
    score: 0,
    kills: 0,
    headshots: 0,
    credits: 0,
    CFG: { wave: { startDelay: 3 } },
    updateWaves: noop
  });
  vm.runInContext(modesSrc, c);

  assert.ok(c.MODES, 'MODES registry must be exported');
  assert.ok(c.MODES.survival, 'MODES.survival must be registered');
  assert.equal(typeof c.getActiveMode, 'function');
  assert.equal(c.getActiveMode(), c.MODES.survival, 'Survival is the active mode by default');

  const surv = c.MODES.survival;
  assert.equal(typeof surv.setup, 'function');
  assert.equal(typeof surv.onKill, 'function');
  assert.equal(typeof surv.onDeath, 'function');
  assert.equal(typeof surv.update, 'function');
  assert.equal(typeof surv.scoreboard, 'function');
  assert.equal(typeof surv.isOver, 'function');

  // Verify setup resets wave parameters
  c.waveNum = 10;
  c.waveActive = true;
  surv.setup();
  assert.equal(c.waveNum, 0);
  assert.equal(c.waveActive, false);
  assert.equal(c.betweenWaveT, 3);

  // Verify scoreboard and isOver reflection
  c.score = 5000;
  c.kills = 20;
  const board = surv.scoreboard();
  assert.equal(board.mode, 'survival');
  assert.equal(board.score, 5000);
  assert.equal(board.kills, 20);

  assert.equal(surv.isOver(), false);
  c.player.dead = true;
  assert.equal(surv.isOver(), true);
});

test('real team-aware AI hostility and targeting: hostile priority over closer teammates', () => {
  const THREE = {
    Vector3,
    Mesh,
    Group,
    MeshStandardMaterial: Material,
    MeshBasicMaterial: Material,
    BoxGeometry: Geometry,
    CylinderGeometry: Geometry,
    SphereGeometry: Geometry,
    Raycaster: function () { return { set: noop, intersectObjects: () => [] }; },
    Color: function (c) { this.c = c; this.lerp = noop; }
  };

  const c = vm.createContext({
    CORE,
    IS_TOUCH: false,
    Math: Object.create(Math),
    THREE,
    navGrid: null,
    mapBounds: 50,
    player: { pos: new Vector3(15, 1.8, 0), dead: false, team: 'friendly', isPlayer: true },
    enemies: [],
    gameT: 10,
    CFG: { ai: { rangedRange: 60, attackRange: 2.1, meleeDamage: 10, rangedROF: 1.35 }, grenade: { fuse: 3 } },
    E_DIM: { pelvisH: 0.95 },
    waveBehaviours: { enemyNades: true },
    waveNum: 1,
    liveGrenades: [],
    colliders: [],
    smokeVolumes: () => [],
    smokeVolumes: () => [],
    updateFlowField: noop,
    updateEnemyShadowBudget: noop,
    moveEnemy: noop,
    animateEnemy: noop,
    distToPlayer: en => Math.hypot(c.player.pos.x - en.pos.x, c.player.pos.z - en.pos.z),
    vertGapToPlayer: en => Math.abs(c.player.pos.y - 1.8 - en.pos.y),
    nextEstepT: Infinity,
    playSound3D: noop,
    pushKillfeed: noop,
    grenadeGeo: {},
    grenadeMat: {},
    fuseBlinkGeo: {},
    fuseLightMat: {},
    scene: { added: [], add(m) { this.added.push(m); } },
    diff: () => ({ dmg: 1 }),
    dirToDeg: () => 0,
    meleeHits: [],
    damagePlayer: noop,
    shots: [],
    enemyShoot: (en, dist, target) => c.shots.push({ en, dist, target }),
    _enemyStateOut: {},
    _pushoutOut: {},
    _sepOut: {}
  });

  const text = source('40_enemies.js');
  vm.runInContext(text, c);

  const dummyParts = () => ({
    group: new Group(),
    legL: new Mesh(),
    legR: new Mesh(),
    armL: new Mesh(),
    armR: new Mesh(),
    body: new Mesh()
  });

  // Create an attacker enemy on team 'enemy'
  const attacker = {
    kind: 1,
    team: 'enemy',
    pos: new Vector3(0, 0, 0),
    vel: new Vector3(),
    parts: dummyParts(),
    state: 'strafe',
    stateT: 0,
    dead: false,
    speedMul: 1,
    yaw: 0,
    strafeDir: 1,
    nextShot: 0
  };

  // Closer teammate on same team 'enemy' at distance 3m
  const teammate = {
    kind: 0,
    team: 'enemy',
    pos: new Vector3(3, 0, 0),
    vel: new Vector3(),
    parts: dummyParts(),
    state: 'chase',
    stateT: 0,
    dead: false,
    speedMul: 1,
    yaw: 0
  };

  // Friendly bot (hostile to attacker) at distance 8m
  const friendlyBot = {
    kind: 1,
    team: 'friendly',
    pos: new Vector3(8, 0, 0),
    vel: new Vector3(),
    parts: dummyParts(),
    state: 'strafe',
    stateT: 0,
    dead: false,
    speedMul: 1,
    yaw: 0
  };

  c.attacker = attacker;
  c.teammate = teammate;
  c.friendlyBot = friendlyBot;
  vm.runInContext('enemies.length = 0; enemies.push(attacker, teammate, friendlyBot);', c);

  // Target acquisition: attacker must target friendlyBot (8m), NOT teammate (3m), and NOT player (15m)
  assert.equal(typeof c.findHostileTarget, 'function', 'findHostileTarget must be implemented');
  const target = c.findHostileTarget(attacker);
  assert.equal(target, friendlyBot, 'attacker prioritizes nearest hostile over closer teammate');

  // When friendlyBot is dead, attacker retargets player
  friendlyBot.dead = true;
  const nextTarget = c.findHostileTarget(attacker);
  assert.equal(nextTarget, c.player, 'attacker retargets surviving hostile (player)');

  // When player also dies, attacker has no hostiles and goes idle
  c.player.dead = true;
  const noTarget = c.findHostileTarget(attacker);
  assert.equal(noTarget, null, 'no hostile targets available when all hostiles dead');

  c.updateEnemies(1 / 60);
  assert.equal(attacker.state, 'idle', 'attacker transitions to idle when all hostiles are dead');
});

function createCombatContext(overrides = {}) {
  const THREE = {
    Vector3,
    Mesh,
    Group,
    MeshStandardMaterial: Material,
    MeshBasicMaterial: Material,
    BoxGeometry: Geometry,
    CylinderGeometry: Geometry,
    SphereGeometry: Geometry,
    Raycaster: function () { return { set: noop, intersectObjects: () => [] }; },
    Color: function (c) { this.c = c; this.lerp = noop; }
  };

  const dummyParts = () => ({
    group: new Group(),
    legL: new Mesh(),
    legR: new Mesh(),
    armL: new Mesh(),
    armR: new Mesh(),
    body: new Mesh()
  });

  const c = vm.createContext(Object.assign({
    CORE,
    IS_TOUCH: false,
    Math: Object.create(Math),
    THREE,
    navGrid: null,
    mapBounds: 50,
    GROUND: 0,
    eyeHeight: () => 1.7,
    player: { pos: new Vector3(0, 1.7, 0), vel: new Vector3(), dead: false, team: 'friendly', isPlayer: true },
    enemies: [],
    gameT: 10,
    CFG: {
      score: { kill: 100, headshot: 50 },
      ai: {
        speed: 3.2,
        chaseSpeed: 4.9,
        rangedSpeed: 2.8,
        attackRange: 2.1,
        meleeDamage: 18,
        meleeCd: 1.1,
        rangedRange: 44,
        rangedDamage: 8,
        rangedROF: 1.35,
        rangedAccuracy: 0.5,
        maxHealth: 100,
        headshotMul: 1.8,
        giveUpDist: 70,
        accPerWave: 0.035,
        accMax: 0.75
      },
      grenade: { fuse: 3 }
    },
    E_DIM: { pelvisH: 0.95 },
    waveBehaviours: {},
    waveNum: 1,
    liveGrenades: [],
    colliders: [],
    smokeVolumes: () => [],
    smokeVolumes: () => [],
    nextEstepT: Infinity,
    playSound3D: noop,
    playSound: noop,
    pushKillfeed: noop,
    diff: () => ({ dmg: 1 }),
    dirToDeg: () => 0,
    meleeHits: [],
    damagePlayer: noop,
    showDamageFx: noop,
    showHitmarker: noop,
    spawnBlood: noop,
    spawnImpact: noop,
    addFieldCharge: noop,
    playerRank: () => 1,
    updateHudHealth: noop,
    spawnBlood: noop,
    showHitmarker: noop,
    addCredits: noop,
    addFieldCharge: noop,
    showCenterMsgThrottled: noop,
    spawnImpact: noop,
    spawnRagdoll: noop,
    addScore: noop,
    registerKillT: noop,
    dropPowerUp: noop,
    dropPickup: noop,
    registerStreakKill: noop,
    spawnTracer: noop,
    noteNearMiss: noop,
    kills: 0,
    headshots: 0,
    score: 0,
    credits: 0,
    started: true,
    paused: false,
    runId: 1,
    activeModeId: 'survival',
    getActiveMode: () => (c.MODES && c.MODES[c.activeModeId]) || (c.MODES && c.MODES.survival) || null,
    MODES: {
      survival: {
        id: 'survival',
        isOver: () => CORE.isModeOver('survival', { gameEnded: c.gameEnded, playerDead: !!(c.player && c.player.dead), playerDowned: !!(c.player && c.player.downed) }),
        onKill: noop
      }
    },
    dummyParts,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
  }, overrides));

  const text = source('40_enemies.js');
  vm.runInContext(text, c);
  c.enemies = vm.runInContext('enemies', c);
  return c;
}

// Load intact production function ranges; only rendering/audio dependencies are stubs.
function loadGrenadeLifecycle(c) {
  const text = source('55_grenades.js');
  const range = (start, end) => text.slice(text.indexOf(start), text.indexOf(end));
  Object.assign(c, {
    scene: { add: noop, remove: noop }, grenadeGeo: {}, grenadeMat: {},
    fuseBlinkGeo: {}, fuseLightMat: {}, blastFlashGeo: {}, blastFlashMat: {},
    blastFlashPool: [], vfx: { impacts: [] }, fxExplosion: noop, noteBlast: noop,
    postKick: noop, spawnScorch: noop, shotKick: 0,
    grenades: { count: 2, cd: 0 }, tacticalCount: 0, pressed: {}, keys: {},
    grenadeCharging: false, hidePreviewDots: noop, updateEquipmentEffects: noop,
    _grenadeMotion: { position: {}, velocity: null },
    _blastFrom: new Vector3(), _blastTarget: new Vector3(), _blastPlayerTarget: new Vector3(),
    grenadeHasLineOfSight: () => true, refreshGrenadeTargets: noop,
    getBlastRing: () => ({ position: new Vector3(), material: {} }), releaseBlastRing: noop
  });
  c.player.pos.distanceTo = p => Math.hypot(c.player.pos.x - p.x, c.player.pos.y - p.y, c.player.pos.z - p.z);
  Object.assign(c.CFG.grenade, { radius: 6, dmg: 150, bounce: 0.4 });
  c.enemies = vm.runInContext('enemies', c);
  vm.runInContext(range('const _grenadePool = []', '// ---- Equipment'), c);
  vm.runInContext(range('function updateGrenades(dt)', '// ---- Tactical payloads'), c);
  vm.runInContext(range('function explodeGrenade(pos', '// ---- Pickups:'), c);
}

test('generator blast damage requires hostile owner, range and line of sight', () => {
  const c = createCombatContext();
  loadGrenadeLifecycle(c);
  c.player.pos.set(40, 1.7, 40);
  const target = { team: 'friendly', pos: new Vector3(1, 0.9, 0), health: 500, dead: false, isObjectiveTarget: true };
  c.objective = { type: 'defend', target, done: false, failed: false };
  const hostile = { team: 'enemy' };
  c.grenadeLosDir = new Vector3();
  c.grenadeLosDir.length = function () { return Math.sqrt(this.lengthSq()); };
  c.grenadeLosDir.multiplyScalar = function (s) { return this.set(this.x * s, this.y * s, this.z * s); };
  c.grenadeTargets = [];
  c._grenadeLosHits = [];
  c.ground = {};
  let covered = true;
  c.grenadeLosRay = { set: noop, intersectObjects: (objects, recursive, hits) => {
    if (covered) hits.push({ distance: 0.2, object: { userData: {} } });
  } };
  const src = source('55_grenades.js');
  vm.runInContext(src.slice(src.indexOf('function grenadeHasLineOfSight('), src.indexOf('// One blast can query')), c);
  c.explodeGrenade(new Vector3(), 1, hostile);
  assert.equal(target.health, 500, 'cover blocks hostile blast');
  covered = false;
  c.explodeGrenade(new Vector3(), 1, c.player);
  assert.equal(target.health, 500, 'player blast must not damage friendly generator');
  c.explodeGrenade(new Vector3(20, 0, 0), 1, hostile);
  assert.equal(target.health, 500, 'outside blast radius');
  c.explodeGrenade(new Vector3(), 1, hostile);
  assert.ok(target.health < 500, 'hostile blast must damage generator');
});

for (const ownerTeam of ['friendly', 'enemy', 'player']) {
  test(`grenade lifecycle attributes ${ownerTeam} blast kills without leaking player rewards`, () => {
    const reports = [];
    const c = createCombatContext({
      addScore: s => { c.score += s; }, addCredits: s => { c.credits += s; },
      addFieldCharge: () => { c.fieldAwards++; }, fieldAwards: 0
    });
    loadGrenadeLifecycle(c);
    c.MODES.survival.onKill = (victim, head, killer) => reports.push({ victim, killer });
    c.Math.random = () => 0.5;
    c.player.pos.set(40, 1.7, 40);
    const owner = ownerTeam === 'player' ? c.player : { team: ownerTeam, pos: new Vector3(0, 0, 0), dead: false };
    const victim = { team: ownerTeam === 'enemy' ? 'friendly' : 'enemy', pos: new Vector3(1, 0, 0), health: 1, kind: 0, parts: c.dummyParts(), dead: false };
    c.enemies.push(victim);
    if (ownerTeam === 'player') {
      // Same pooled record constructor used by throwGrenade, after a bot record
      // has been returned to the pool: ownership must not survive recycling.
      c.throwEnemyGrenade({ team: 'enemy', pos: new Vector3(), dead: false }, victim);
      c.releaseLiveGrenadeRecord(c.liveGrenades.pop());
      c.liveGrenades.push(c.getLiveGrenadeRecord(new Mesh(), 0, 0, 0, 0.01, new Mesh(), CORE.LETHALS[0], 0, 0, false));
    } else {
      c.throwEnemyGrenade(owner, victim);
      c.liveGrenades[0].fuse = 0.01;
    }
    c.updateGrenades(0.02);
    assert.equal(victim.dead, true, 'real fuse/physics/detonation path must kill victim');
    assert.equal(c.liveGrenades.length, 0, 'detonated projectile must be recycled');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].killer, owner, 'mode hook must receive grenade owner, not default player');
    assert.equal(c.kills, ownerTeam === 'player' ? 1 : 0);
    assert.equal(c.score > 0, ownerTeam === 'player');
    assert.equal(c.credits > 0, ownerTeam === 'player');
    assert.equal(c.fieldAwards > 0, ownerTeam === 'player');
  });
}

for (const team of ['friendly', 'enemy']) {
  test(`full ${team} bot AI reaches hostile behind a wall without teleporting`, () => {
    const c = createCombatContext();
    c.enemies = vm.runInContext('enemies', c);
    c.player.dead = true;
    c.player.pos.set(-20, 1.7, -20);
    const wall = { min: { x: 4, y: 0, z: -4 }, max: { x: 5, y: 3, z: 4 } };
    c.colliders = [wall];
    c.navGrid = CORE.buildNavGrid(c.colliders, { halfExtent: 30, cell: 1 });
    function actor(actorTeam, x) {
      return { team: actorTeam, kind: 0, pos: new Vector3(x, 0, 0), vel: new Vector3(),
        state: 'chase', stateT: 0, speedMul: 1, dead: false, health: 1e6,
        parts: c.dummyParts(), strafeDir: 1, nextShot: Infinity, nextNade: Infinity, stepT: 100 };
    }
    const runner = actor(team, 0);
    const target = actor(team === 'friendly' ? 'enemy' : 'friendly', 8);
    target.speedMul = 0;
    target.state = 'spawn'; target.stateT = -1e6;
    c.enemies.push(runner, target);
    let teleports = 0;
    c.relocateStuckEnemy = () => { teleports++; };
    const sharedDistances = () => Array.from(c.navGrid.dist);
    c.updateFlowField(0);
    const playerField = sharedDistances();
    let closest = Infinity;
    for (let i = 0; i < 400; i++) {
      c.gameT += 0.05;
      c.updateEnemies(0.05);
      closest = Math.min(closest, CORE.horizDist(runner.pos.x, runner.pos.z, target.pos.x, target.pos.z));
    }
    assert.equal(runner.target, target, 'real selector must retain the living hostile target');
    assert.ok(closest < 2, `must route around wall to melee range; closest=${closest}, final=${runner.pos.x},${runner.pos.z}`);
    assert.equal(teleports, 0, 'routing must work without stuck recovery relocation');
    assert.deepEqual(sharedDistances(), playerField, 'bot routing must not overwrite the shared player flood');
  });
}

test('target-aware navigation routes toward selected bot target, not player flow field', () => {
  const c = createCombatContext();
  const navGrid = CORE.buildNavGrid([], { bounds: 50, cell: 2 });
  c.navGrid = navGrid;

  // Player at x = -15, z = 0
  c.player.pos.set(-15, 1.7, 0);
  CORE.computeFlowField(navGrid, c.player.pos.x, c.player.pos.z);

  // Friendly bot at x = 15, z = 0
  const friendlyBot = {
    kind: 0,
    team: 'friendly',
    pos: new Vector3(15, 0, 0),
    vel: new Vector3(),
    parts: c.dummyParts(),
    state: 'idle',
    stateT: 0,
    dead: false,
    speedMul: 1,
    yaw: 0
  };

  // Attacker at x = 0, z = 0 (between player and friendly bot; opposing sides)
  const attacker = {
    kind: 0,
    team: 'enemy',
    pos: new Vector3(0, 0, 0),
    vel: new Vector3(),
    parts: c.dummyParts(),
    state: 'chase',
    stateT: 0,
    dead: false,
    speedMul: 1,
    yaw: 0,
    target: friendlyBot
  };

  // Navigating toward bot target friendlyBot at x = 15 must move along +x
  c.moveEnemy(attacker, 0.1, 15);
  assert.ok(attacker.vel.x > 0, `attacker vel.x (${attacker.vel.x}) must be > 0 toward bot target at x=15, not toward player at x=-15`);
  assert.ok(attacker.pos.x > 0, `attacker pos.x (${attacker.pos.x}) must advance toward bot target (+x)`);

  // When targeting player, chase navigation retains flow field toward player (-x)
  attacker.pos.set(0, 0, 0);
  attacker.target = c.player;
  c.moveEnemy(attacker, 0.1, 15);
  assert.ok(attacker.vel.x < 0, `attacker vel.x (${attacker.vel.x}) must be < 0 toward player at x=-15`);
  assert.ok(attacker.pos.x < 0, `attacker pos.x (${attacker.pos.x}) must advance toward player (-x)`);
});

test('kill attribution and reward isolation: enemy-kills-friendly, friendly-kills-enemy, and player-kills-enemy', () => {
  let reportedKill = null;
  const c = createCombatContext({
    kills: 10,
    headshots: 2,
    score: 1000,
    credits: 500,
    addScore: (s) => { c.score += s; },
    addCredits: (cr) => { c.credits += cr; }
  });
  c.MODES.survival.onKill = (victim, isHead, killer) => {
    reportedKill = { victim, isHead, killer };
  };

  // 1. Enemy kills friendly bot
  const enemyAttacker = { team: 'enemy', pos: new Vector3(0, 0, 0), dead: false, kind: 1 };
  const friendlyVictim = { team: 'friendly', pos: new Vector3(2, 0, 0), dead: false, health: 10, kind: 0, parts: c.dummyParts() };
  c.damageEnemy(friendlyVictim, 50, friendlyVictim.pos, false, false, 'MELEE', enemyAttacker);

  assert.equal(friendlyVictim.dead, true, 'friendly victim must be dead');
  assert.ok(reportedKill, 'onKill hook must be called');
  assert.equal(reportedKill.victim, friendlyVictim, 'victim must be friendlyVictim');
  assert.equal(reportedKill.killer, enemyAttacker, 'killer must be enemyAttacker, NOT player');
  assert.equal(c.kills, 10, 'enemy-kills-friendly must not increment player kills');
  assert.equal(c.headshots, 2, 'enemy-kills-friendly must not increment player headshots');
  assert.equal(c.score, 1000, 'enemy-kills-friendly must not award player score');
  assert.equal(c.credits, 500, 'enemy-kills-friendly must not award player credits');

  // 2. Friendly bot kills enemy bot
  reportedKill = null;
  const friendlyAttacker = { team: 'friendly', pos: new Vector3(0, 0, 0), dead: false, kind: 1 };
  const enemyVictim = { team: 'enemy', pos: new Vector3(2, 0, 0), dead: false, health: 10, kind: 0, parts: c.dummyParts() };
  c.damageEnemy(enemyVictim, 50, enemyVictim.pos, false, false, 'MELEE', friendlyAttacker);

  assert.equal(enemyVictim.dead, true, 'enemy victim must be dead');
  assert.ok(reportedKill, 'onKill hook must be called');
  assert.equal(reportedKill.victim, enemyVictim, 'victim must be enemyVictim');
  assert.equal(reportedKill.killer, friendlyAttacker, 'killer must be friendlyAttacker, NOT player');
  assert.equal(c.kills, 10, 'friendly-kills-enemy must not increment player kills');
  assert.equal(c.score, 1000, 'friendly-kills-enemy must not award player score');
  assert.equal(c.credits, 500, 'friendly-kills-enemy must not award player credits');

  // 3. Player kills enemy bot (qualifying player kill)
  reportedKill = null;
  const enemyVictim2 = { team: 'enemy', pos: new Vector3(2, 0, 0), dead: false, health: 10, kind: 0, parts: c.dummyParts() };
  c.damageEnemy(enemyVictim2, 50, enemyVictim2.pos, true, false, 'AR', c.player);

  assert.equal(enemyVictim2.dead, true, 'enemy victim 2 must be dead');
  assert.ok(reportedKill, 'onKill hook must be called');
  assert.equal(reportedKill.victim, enemyVictim2, 'victim must be enemyVictim2');
  assert.equal(reportedKill.killer, c.player, 'killer must be player');
  assert.equal(c.kills, 11, 'player kill must increment player kills');
  assert.equal(c.headshots, 3, 'player headshot must increment player headshots');
  assert.ok(c.score > 1000, 'player kill must award score');
  assert.ok(c.credits > 500, 'player kill must award credits');

  // 4. Player kills friendly bot (non-qualifying kill: no player rewards, player reported as killer)
  reportedKill = null;
  const scoreBefore = c.score;
  const creditsBefore = c.credits;
  const friendlyVictim2 = { team: 'friendly', pos: new Vector3(2, 0, 0), dead: false, health: 10, kind: 0, parts: c.dummyParts(), friendlyFire: true };
  c.damageEnemy(friendlyVictim2, 50, friendlyVictim2.pos, false, false, 'MELEE', c.player);

  assert.equal(friendlyVictim2.dead, true, 'friendly victim 2 must be dead');
  assert.ok(reportedKill, 'onKill hook must be called');
  assert.equal(reportedKill.victim, friendlyVictim2, 'victim must be friendlyVictim2');
  assert.equal(reportedKill.killer, c.player, 'killer must be player');
  assert.equal(c.kills, 11, 'killing a friendly bot must NOT increment player kills');
  assert.equal(c.headshots, 3, 'killing a friendly bot must NOT increment player headshots');
  assert.equal(c.score, scoreBefore, 'killing a friendly bot must NOT award player score');
  assert.equal(c.credits, creditsBefore, 'killing a friendly bot must NOT award player credits');
});

test('enemyShoot and breacherShoot delayed impacts gate on paused game state', async () => {
  const c = createCombatContext();
  c.Math.random = () => 0.1; // deterministic hit rolls

  // 1. enemyShoot against friendly bot with paused = true between shot and impact
  const shooter = {
    kind: 1,
    team: 'enemy',
    pos: new Vector3(0, 0, 0),
    vel: new Vector3(),
    parts: c.dummyParts(),
    dead: false,
    speedMul: 1,
    yaw: 0,
    nextShot: 0
  };
  const friendlyTarget = {
    kind: 0,
    team: 'friendly',
    pos: new Vector3(5, 0, 0),
    vel: new Vector3(),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  c.started = true;
  c.paused = false;
  c.enemyShoot(shooter, 5, friendlyTarget);
  // Pause gameplay immediately after firing
  c.paused = true;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(friendlyTarget.health, 100, 'damage must NOT be delivered when game is paused between firing and impact');

  // Now test with paused = false: damage must land
  c.paused = false;
  c.enemyShoot(shooter, 5, friendlyTarget);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(friendlyTarget.health < 100, `damage must be delivered when game is unpaused (health=${friendlyTarget.health})`);

  // 2. breacherShoot against friendly bot with paused = true between shot and impact
  const breacher = {
    kind: 6,
    team: 'enemy',
    pos: new Vector3(0, 0, 0),
    vel: new Vector3(),
    parts: c.dummyParts(),
    dead: false,
    speedMul: 1,
    yaw: 0,
    nextShot: 0
  };
  const friendlyTarget2 = {
    kind: 0,
    team: 'friendly',
    pos: new Vector3(4, 0, 0),
    vel: new Vector3(),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  c.paused = false;
  c.breacherShoot(breacher, 4, friendlyTarget2);
  // Pause gameplay immediately after firing
  c.paused = true;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(friendlyTarget2.health, 100, 'breacher damage must NOT be delivered when game is paused between firing and impact');

  // Now test with paused = false: damage must land
  c.paused = false;
  c.breacherShoot(breacher, 4, friendlyTarget2);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(friendlyTarget2.health < 100, `breacher damage must be delivered when unpaused (health=${friendlyTarget2.health})`);
});

test('enemyShoot cover re-check at impact handles through-floor, staircase cover, and open line-of-fire reliably', async () => {
  const c = createCombatContext();
  c.Math.random = () => 0.1; // deterministic hit rolls

  // Setup arena colliders: 2nd floor slab and central staircase
  c.colliders = [
    // 2nd floor slab: x in [-9.3, 9.3], y in [3.65, 4.15], z in [-7.3, 7.3]
    { min: new Vector3(-9.3, 3.65, -7.3), max: new Vector3(9.3, 4.15, 7.3), mat: 'concrete' },
    // central staircase: x in [-1.6, 1.6], y in [0, 4.0], z in [5.99, 6.81]
    { min: new Vector3(-1.6, 0, 5.99), max: new Vector3(1.6, 4.0, 6.81), mat: 'concrete' }
  ];

  let hits = 0;
  c.damagePlayer = () => { hits++; };
  c.player.health = 100;
  c.player.dead = false;
  c.player.pos.set(0, 1.7, 0);

  const shooter = {
    kind: 1,
    team: 'enemy',
    pos: new Vector3(0, 0, 5),
    vel: new Vector3(),
    parts: c.dummyParts(),
    dead: false,
    speedMul: 1,
    yaw: 0,
    nextShot: 0
  };

  // 1. Through-floor: shot fired while player is on ground, but player climbs upstairs to SLAB_EYE (5.85) before impact
  c.enemyShoot(shooter, 5, c.player);
  c.player.pos.set(0, 4.15 + 1.7, 0); // climb behind slab
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(hits, 0, 'bullet must be blocked by slab when player climbs upstairs before impact');

  // 2. Open line of fire: player on ground, shooter at (0, 0, 5) in open
  c.player.pos.set(0, 1.7, 0);
  shooter.pos.set(0, 0, 5);
  hits = 0;
  c.enemyShoot(shooter, 5, c.player);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(hits, 1, 'bullet must land on player when line of fire is in the open');

  // 3. Cover blocking: shooter behind staircase at (0, 0, 7)
  shooter.pos.set(0, 0, 7);
  hits = 0;
  c.enemyShoot(shooter, 5, c.player);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(hits, 0, 'bullet must be blocked when shooter is behind the staircase');

  // 4. Repositioning shooter into the open restores successful hit delivery
  shooter.pos.set(0, 0, 5);
  hits = 0;
  c.enemyShoot(shooter, 5, c.player);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(hits, 1, 'bullet must land once shooter is repositioned into the open');
});

test('active bot-to-bot combat execution: full target acquisition, engagement, and attribution', () => {
  let reportedKill = null;
  const c = createCombatContext({
    kills: 0,
    score: 0,
    credits: 0
  });
  c.MODES.survival.onKill = (victim, isHead, killer) => {
    reportedKill = { victim, isHead, killer };
  };

  // Player is far away at (100, 0, 100)
  c.player.pos.set(100, 1.7, 100);

  // Friendly bot at (0, 0, 0)
  const friendlyBot = {
    kind: 0,
    team: 'friendly',
    pos: new Vector3(0, 0, 0),
    vel: new Vector3(),
    parts: c.dummyParts(),
    state: 'chase',
    stateT: 0,
    dead: false,
    health: 15,
    maxHealth: 15,
    speedMul: 1,
    yaw: 0,
    attackReadyT: 0
  };

  // Enemy melee runner at (1.5, 0, 0)
  const enemyRunner = {
    kind: 0,
    team: 'enemy',
    pos: new Vector3(1.5, 0, 0),
    vel: new Vector3(),
    parts: c.dummyParts(),
    state: 'chase',
    stateT: 0,
    dead: false,
    health: 50,
    maxHealth: 50,
    speedMul: 1,
    yaw: 0,
    attackReadyT: 0
  };

  c.friendlyBot = friendlyBot;
  c.enemyRunner = enemyRunner;
  vm.runInContext('enemies.length = 0; enemies.push(friendlyBot, enemyRunner);', c);

  // Run multiple frames: enemyRunner must target friendlyBot, wind up melee, land hit, kill friendlyBot
  // and attribute kill to enemyRunner without touching player stats
  for (let frame = 0; frame < 60; frame++) {
    c.gameT += 1 / 60;
    c.updateEnemies(1 / 60);
    if (friendlyBot.dead) break;
  }

  assert.equal(friendlyBot.dead, true, 'friendly bot should take lethal melee damage from enemyRunner');
  assert.ok(reportedKill, 'onKill hook should have been called upon friendly bot death');
  assert.equal(reportedKill.victim, friendlyBot, 'victim in hook must be friendlyBot');
  assert.equal(reportedKill.killer, enemyRunner, 'killer in hook must be enemyRunner');
  assert.equal(c.kills, 0, 'player kills must not increment when bots kill each other');
  assert.equal(c.score, 0, 'player score must not increment when bots kill each other');
});

test('friendly fire immunity: players, bots, and grenades do not damage teammates', () => {
  const c = createCombatContext({
    kills: 0,
    score: 0,
    credits: 0
  });

  const friendlyBotA = {
    team: 'friendly',
    pos: new Vector3(5, 0, 0),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  const friendlyBotB = {
    team: 'friendly',
    pos: new Vector3(8, 0, 0),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  const enemyBot = {
    team: 'enemy',
    pos: new Vector3(15, 0, 0),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  // 1. Player shoots friendly bot: must be immune (friendly fire off)
  c.damageEnemy(friendlyBotA, 40, friendlyBotA.pos, false, false, 'AR', c.player);
  assert.equal(friendlyBotA.health, 100, 'friendly bot must not take damage from player (friendly fire is off)');
  assert.equal(c.kills, 0, 'player kills must not change on friendly hit');
  assert.equal(c.credits, 0, 'player credits must not change on friendly hit');

  // 2. Friendly bot shoots friendly bot: must be immune
  c.damageEnemy(friendlyBotB, 30, friendlyBotB.pos, false, false, 'AR', friendlyBotA);
  assert.equal(friendlyBotB.health, 100, 'friendly bot must not take damage from friendly ally bot');

  // 3. Enemy shoots friendly bot: takes full damage
  c.damageEnemy(friendlyBotA, 35, friendlyBotA.pos, false, false, 'AR', enemyBot);
  assert.equal(friendlyBotA.health, 65, 'friendly bot must take normal damage from enemy bot');

  // 4. Player shoots enemy bot: enemy takes damage
  c.damageEnemy(enemyBot, 45, enemyBot.pos, false, false, 'AR', c.player);
  assert.equal(enemyBot.health, 55, 'enemy bot must take normal damage from player');

  // 5. Grenade blast from friendly owner does not damage friendly bots
  loadGrenadeLifecycle(c);
  const friendlyInBlast = {
    team: 'friendly',
    pos: new Vector3(0, 0, 2),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };
  const hostileInBlast = {
    team: 'enemy',
    pos: new Vector3(0, 0, 2),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };
  c.enemies.length = 0;
  c.enemies.push(friendlyInBlast, hostileInBlast);
  c.colliders = [];
  c.player.pos.set(50, 0, 50); // player far away
  c.throwEnemyGrenade(c.player, friendlyInBlast);
  c.liveGrenades[0].m.position.set(0, 0, 0);
  c.liveGrenades[0].fuse = 0.01;
  c.updateGrenades(0.02);
  assert.equal(friendlyInBlast.health, 100, 'friendly bot in friendly grenade blast must take 0 damage');
  assert.ok(hostileInBlast.health < 100, 'hostile bot in grenade blast must take damage');

  // 6. Grenade blast from friendly bot does not damage player
  const playerText = source('20_player.js');
  const dmgPlayerSlice = playerText.slice(playerText.indexOf('function damagePlayer('));
  const endFn = dmgPlayerSlice.indexOf('\n}\n');
  vm.runInContext(dmgPlayerSlice.slice(0, endFn + 3), c);
  c.godMode = false;
  c.player.pos.set(0, 0, 0);
  c.player.health = 100;
  c.player.armor = 0;
  c.explodeGrenade(new Vector3(0, 0, 0), 1, friendlyInBlast);
  assert.equal(c.player.health, 100, 'player must not take damage from friendly bot grenade');
});

test('grenade owner propagation into player friendly-fire guard: allied, hostile, and self-owned explosions', () => {
  const c = createCombatContext();
  loadGrenadeLifecycle(c);

  const playerText = source('20_player.js');
  const dmgPlayerSlice = playerText.slice(playerText.indexOf('function damagePlayer('));
  const endFn = dmgPlayerSlice.indexOf('\n}\n');
  vm.runInContext(dmgPlayerSlice.slice(0, endFn + 3), c);

  c.player.dead = false;
  c.player.armor = 0;
  c.godMode = false;

  const friendlyBot = { team: 'friendly', isPlayer: false, pos: new Vector3(0, 0, 0), dead: false };
  const hostileBot = { team: 'enemy', isPlayer: false, pos: new Vector3(0, 0, 0), dead: false };

  // 1. Allied grenade explosion at player position: player must be immune when friendly fire is disabled
  c.player.pos.set(0, 0, 0);
  c.player.health = 100;
  c.explodeGrenade(new Vector3(0, 0, 0), 1, friendlyBot);
  assert.equal(c.player.health, 100, 'player must take 0 damage from friendly bot grenade explosion');

  // 2. Hostile grenade explosion at player position: player must take damage
  c.player.health = 100;
  c.explodeGrenade(new Vector3(0, 0, 0), 1, hostileBot);
  assert.ok(c.player.health < 100, 'player must take damage from hostile bot grenade explosion');

  // 3. Self-owned explosion (owner === player): intentional self-damage must be preserved
  c.player.health = 100;
  c.explodeGrenade(new Vector3(0, 0, 0), 1, c.player);
  assert.ok(c.player.health < 100, 'player must take intentional self-damage from player-owned grenade explosion');

  // 4. Self-owned explosion (owner with isPlayer: true): intentional self-damage must be preserved
  c.player.health = 100;
  c.explodeGrenade(new Vector3(0, 0, 0), 1, { isPlayer: true, team: 'friendly' });
  assert.ok(c.player.health < 100, 'player must take intentional self-damage from isPlayer grenade owner');

  // 5. Unowned/default explosion (owner is undefined): self-damage preserved
  c.player.health = 100;
  c.explodeGrenade(new Vector3(0, 0, 0), 1);
  assert.ok(c.player.health < 100, 'player must take self-damage from unowned grenade explosion');

  // 6. When friendlyFire is enabled in CFG, allied grenade damages player
  c.CFG.friendlyFire = true;
  c.player.health = 100;
  c.explodeGrenade(new Vector3(0, 0, 0), 1, friendlyBot);
  assert.ok(c.player.health < 100, 'player must take damage from friendly bot grenade when friendly fire is enabled');
});

test('spawn protection and respawn scoring integration: damage immunity and hostile sightline avoidance', () => {
  const c = createCombatContext();

  const protectedTarget = {
    team: 'friendly',
    pos: new Vector3(0, 0, 0),
    health: 100,
    maxHealth: 100,
    dead: false,
    spawnProtectionT: 2.0,
    parts: c.dummyParts()
  };

  const enemyAttacker = {
    team: 'enemy',
    pos: new Vector3(5, 0, 0),
    dead: false
  };

  // 1. Target with active spawn protection is immune to enemy fire
  c.damageEnemy(protectedTarget, 50, protectedTarget.pos, false, false, 'AR', enemyAttacker);
  assert.equal(protectedTarget.health, 100, 'target with spawn protection must take 0 damage');

  // 2. Dissipate spawn protection
  protectedTarget.spawnProtectionT = 0;
  c.damageEnemy(protectedTarget, 50, protectedTarget.pos, false, false, 'AR', enemyAttacker);
  assert.equal(protectedTarget.health, 50, 'target without spawn protection must take normal damage');

  // 3. Respawn scoring away from hostile sight lines
  const enemyFacingNorth = { pos: { x: 0, z: 0 }, yaw: 0, dead: false };
  const inSightNorth = [0, 20];
  const outOfSightSouth = [0, -20];
  const scoredNorth = CORE.scoreSpawnPoint(inSightNorth, [enemyFacingNorth]);
  const scoredSouth = CORE.scoreSpawnPoint(outOfSightSouth, [enemyFacingNorth]);
  assert.ok(scoredSouth > scoredNorth, 'out of sight spawn point must score higher than point in direct hostile sight line');

  const picked = CORE.pickBestSpawnPoint([inSightNorth, outOfSightSouth], [enemyFacingNorth]);
  assert.deepStrictEqual(picked, outOfSightSouth, 'pickBestSpawnPoint chooses point away from hostile sight line');
});

test('friendly bot visual kits and IFF marker: spawnEnemy and makeEnemyMesh team integration', () => {
  const c = createCombatContext();

  // 1. makeEnemyMesh with team = 'friendly'
  const friendlyParts = c.makeEnemyMesh(1, 'friendly');
  assert.ok(friendlyParts.group.userData.iff, 'friendly bot mesh must have IFF marker');
  assert.equal(friendlyParts.group.userData.iff.name, 'iffMarker');

  // 2. makeEnemyMesh with team = 'enemy'
  const enemyParts = c.makeEnemyMesh(1, 'enemy');
  assert.equal(enemyParts.group.userData.iff, undefined, 'enemy bot mesh must NOT have IFF marker');

  // 3. spawnEnemy with team = 'friendly'
  const friendlyBot = c.spawnEnemy(1, 10, 20, { team: 'friendly' });
  assert.equal(friendlyBot.team, 'friendly');
  assert.equal(CORE.minimapActorColor(friendlyBot), '#4da6ff');
  assert.ok(friendlyBot.parts.group.userData.iff, 'friendly bot spawned must have IFF marker');

  // 4. spawnEnemy default (team = 'enemy')
  const defaultEnemy = c.spawnEnemy(1, -10, -20);
  assert.equal(defaultEnemy.team, 'enemy');
  assert.equal(CORE.minimapActorColor(defaultEnemy), '#ff4030');
  assert.equal(defaultEnemy.parts.group.userData.iff, undefined);
});

test('mode respawn queue and timer lifecycle in 35_modes.js', () => {
  const modesSrc = source('35_modes.js');
  const c = vm.createContext({
    CORE,
    player: { dead: false, downed: false },
    gameEnded: false,
    waveNum: 0,
    waveQueue: 0,
    waveActive: false,
    betweenWaveT: 0,
    score: 0,
    kills: 0,
    headshots: 0,
    credits: 0,
    CFG: { wave: { startDelay: 3 } },
    updateWaves: noop
  });
  vm.runInContext(modesSrc, c);

  assert.equal(typeof c.queueModeRespawn, 'function');
  assert.equal(typeof c.clearModeRespawns, 'function');
  assert.equal(typeof c.updateModeRespawns, 'function');

  const deadActor = { id: 'bot1', dead: true, pos: new Vector3(0, 0, 0) };
  c.queueModeRespawn(deadActor, 3.0);
  assert.equal(c.modeRespawnQueue.length, 1);
  assert.equal(c.modeRespawnQueue[0].timer, 3.0);

  // Step 1 second: timer decrements to 2.0, actor does not respawn yet
  let respawned = null;
  c.updateModeRespawns(1.0, [[10, 10]], [], [], (actor, pt) => { respawned = { actor, pt }; });
  assert.equal(c.modeRespawnQueue.length, 1);
  assert.equal(c.modeRespawnQueue[0].timer, 2.0);
  assert.equal(respawned, null);

  // Step remaining 2 seconds: actor respawns and queue clears
  c.updateModeRespawns(2.0, [[10, 10]], [], [], (actor, pt) => { respawned = { actor, pt }; });
  assert.equal(c.modeRespawnQueue.length, 0);
  assert.ok(respawned);
  assert.equal(respawned.actor, deadActor);
  assert.deepStrictEqual(respawned.pt, [10, 10]);

  // Survival setup clears any pending respawns
  c.queueModeRespawn(deadActor, 3.0);
  assert.equal(c.modeRespawnQueue.length, 1);
  c.MODES.survival.setup();
  assert.equal(c.modeRespawnQueue.length, 0, 'Survival setup must clear pending respawns');
});

test('damageEnemy and damagePlayer apply damage regardless of dead attacker status or omitted attacker', () => {
  const c = createCombatContext();

  const enemyVictim = {
    team: 'enemy',
    pos: new Vector3(10, 0, 10),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  // 1. When player is dead, damageEnemy with no attacker passed (environment, sentry, or probe check 8) must still deal damage
  c.player.dead = true;
  c.damageEnemy(enemyVictim, 40, enemyVictim.pos, false);
  assert.equal(enemyVictim.health, 60, 'enemy must take damage when attacker is omitted even if player is dead');

  // 2. When player is dead, damageEnemy with player as attacker must still deal damage to hostiles (posthumous bullet/grenade)
  c.damageEnemy(enemyVictim, 40, enemyVictim.pos, false, false, 'AR', c.player);
  assert.equal(enemyVictim.health, 20, 'enemy must take damage from hostile player even if player is dead');

  // 3. When hostile bot dies, its shot in flight must still damage living enemy
  const hostileDeadAttacker = { team: 'friendly', dead: true, pos: new Vector3(0, 0, 0) };
  c.damageEnemy(enemyVictim, 25, enemyVictim.pos, false, false, 'AR', hostileDeadAttacker);
  assert.equal(enemyVictim.dead, true, 'lethal damage from dead hostile attacker must kill enemy');

  // 4. Same for damagePlayer: enemy dies, its projectile in flight hits living player
  const playerText = source('20_player.js');
  const dmgPlayerSlice = playerText.slice(playerText.indexOf('function damagePlayer('));
  const endFn = dmgPlayerSlice.indexOf('\n}\n');
  vm.runInContext(dmgPlayerSlice.slice(0, endFn + 3), c);
  c.player.dead = false;
  c.player.health = 100;
  c.player.armor = 0;
  c.godMode = false;
  const deadEnemyAttacker = { team: 'enemy', dead: true, pos: new Vector3(5, 0, 0) };
  c.damagePlayer(30, 0, 'bullet', deadEnemyAttacker);
  assert.equal(c.player.health, 70, 'player must take damage from opposing enemy even if enemy died while round was in flight');
});

test('friendly fire enforcement with production weapon callers and omitted attacker', () => {
  const c = createCombatContext();

  const friendlyBot = {
    team: 'friendly',
    pos: new Vector3(5, 0, 5),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  // 1. Production player bullet caller signature (src/30_weapons.js:475) omits attacker:
  // damageEnemy(en, dmg, hit.point, isHead, penMul < 1, w ? w.type : 'AR');
  c.damageEnemy(friendlyBot, 40, friendlyBot.pos, false, false, 'AR');
  assert.strictEqual(friendlyBot.health, 100, 'production bullet call without explicit attacker must NOT damage friendly bot when friendly fire disabled');

  // 2. Production player melee caller signature (src/30_weapons.js:566) omits attacker:
  // damageEnemy(en, meleeDmg, _meleePoint, isBackstab);
  c.damageEnemy(friendlyBot, 35, friendlyBot.pos, false);
  assert.strictEqual(friendlyBot.health, 100, 'production melee call without explicit attacker must NOT damage friendly bot');

  // 3. Explicit attacker caller with player
  c.damageEnemy(friendlyBot, 40, friendlyBot.pos, false, false, 'AR', c.player);
  assert.strictEqual(friendlyBot.health, 100, 'explicit player attacker must NOT damage friendly bot');

  // 4. Hostile enemy must take damage from production caller signatures
  const enemyVictim = {
    team: 'enemy',
    pos: new Vector3(10, 0, 10),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };
  c.damageEnemy(enemyVictim, 40, enemyVictim.pos, false, false, 'AR');
  assert.strictEqual(enemyVictim.health, 60, 'hostile enemy must take damage from production bullet call');
});

test('attack-triggered spawn protection cancellation for players and bots', () => {
  const c = createCombatContext();

  // 1. Bot ranged attack (enemyShoot) clears spawn protection
  const shooterBot = {
    team: 'enemy',
    pos: new Vector3(0, 0, 0),
    health: 100,
    dead: false,
    blindT: 0,
    spawnProtectionT: 2.0,
    parts: c.dummyParts()
  };
  const target = {
    team: 'friendly',
    pos: new Vector3(0, 0, 10),
    health: 100,
    dead: false,
    isPlayer: true
  };
  c.enemyShoot(shooterBot, 10, target);
  assert.strictEqual(shooterBot.spawnProtectionT, 0, 'enemyShoot must immediately cancel spawn protection on firing');

  // 2. Bot shotgun attack (breacherShoot) clears spawn protection
  const breacherBot = {
    team: 'enemy',
    pos: new Vector3(0, 0, 0),
    health: 100,
    dead: false,
    blindT: 0,
    spawnProtectionT: 2.0,
    parts: c.dummyParts()
  };
  c.breacherShoot(breacherBot, 8, target);
  assert.strictEqual(breacherBot.spawnProtectionT, 0, 'breacherShoot must immediately cancel spawn protection on firing');

  // 3. Bot melee attack clears spawn protection
  const runnerBot = c.spawnEnemy(0, 0, 1.5);
  runnerBot.spawnProtectionT = 2.0;
  runnerBot.state = 'chase';
  runnerBot.attackReadyT = 0;
  c.player.pos.set(0, 1.7, 0);
  c.updateEnemies(0.016);
  assert.strictEqual(runnerBot.spawnProtectionT, 0, 'bot melee initiation must cancel spawn protection');

  // 4. Player gun attack (fireShot) and melee (doMelee)
  const THREE = c.THREE;
  const wepContext = vm.createContext({
    CORE,
    THREE,
    Math: Object.create(Math),
    CFG: Object.assign({}, c.CFG, {
      weapons: [{ type: 'AR', rpm: 600, range: 100, spread: 0.02, adsSpread: 0.01, pellets: 1, dmg: 30, mag: 30, reserveMax: 120, recoilV: 0.01, recoilH: 0.005 }],
      assist: { bulletAngle: 0.05 },
      ai: { attackRange: 2.1, headshotMul: 1.8 }
    }),
    player: {
      pos: new Vector3(0, 1.7, 0),
      vel: new Vector3(),
      yaw: 0,
      pitch: 0,
      dead: false,
      crouching: false,
      sliding: false,
      sprinting: false,
      tacT: 0,
      onGround: true,
      spawnProtectionT: 2.0,
      team: 'friendly',
      isPlayer: true,
      recoilP: 0
    },
    enemies: [],
    colliders: [],
    smokeVolumes: () => [],
    camera: {
      position: new Vector3(0, 1.7, 0),
      quaternion: { set: noop },
      getWorldPosition: (v) => v.set(0, 1.7, 0)
    },
    gunGroup: null,
    wState: [{ ammo: 30, nextShot: 0, heat: 0 }],
    getLoadout: () => null,
    keys: {},
    curWeapon: 0,
    curW: () => ({ rpm: 600, range: 100, spread: 0.02, adsSpread: 0.01, type: 'AR', pellets: 1, dmg: 30, recoilV: 0.01, recoilH: 0.005 }),
    curS: () => wepContext.wState[0],
    shotsFired: 0,
    shotsHit: 0,
    fireClockT: 0,
    gameT: 10,
    adsDown: () => false,
    perks: [],
    bloom: 0,
    hSpeedForSpread: 0,
    spawnCasing: noop,
    spawnTracer: noop,
    playSound: noop,
    flashMuzzleLight: noop,
    kickViewmodel: noop,
    updateHudAmmo: noop,
    vmTune: {},
    muzzleFlash: false,
    started: true,
    paused: false,
    runId: 1,
    worldRayTargets: () => []
  });
  const wepText = source('30_weapons.js');
  vm.runInContext(wepText, wepContext);
  wepContext.freshWeaponState(0);

  // Player fireShot clears player spawn protection
  assert.strictEqual(wepContext.player.spawnProtectionT, 2.0);
  wepContext.fireShot(false);
  assert.strictEqual(wepContext.player.spawnProtectionT, 0, 'fireShot must cancel player spawn protection');

  // Player doMelee clears player spawn protection
  wepContext.player.spawnProtectionT = 2.0;
  wepContext.doMelee();
  assert.strictEqual(wepContext.player.spawnProtectionT, 0, 'doMelee must cancel player spawn protection');
});

test('posthumous player rewards dead-source gate: damage applies but rewards are withheld', () => {
  let hitmarkers = 0;
  let creditsGranted = 0;
  let fieldChargeGranted = 0;
  let scoreGranted = 0;
  let streaksRegistered = 0;
  let powerUpsDropped = 0;
  let pickupsDropped = 0;
  let killBonusCalls = 0;

  const c = createCombatContext({
    showHitmarker: () => { hitmarkers++; },
    addCredits: (n) => { creditsGranted += n; },
    addFieldCharge: (n) => { fieldChargeGranted += n; },
    addScore: (n) => { scoreGranted += n; },
    registerStreakKill: () => { streaksRegistered++; },
    registerKillT: () => { killBonusCalls++; },
    dropPowerUp: () => { powerUpsDropped++; },
    dropPickup: () => { pickupsDropped++; }
  });

  const enemy = {
    team: 'enemy',
    pos: new Vector3(5, 0, 5),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };

  // 1. Posthumous non-lethal damage (e.g. projectile or tick after player died)
  c.player.dead = true;
  c.damageEnemy(enemy, 30, enemy.pos, false, false, 'AR', c.player);
  assert.strictEqual(enemy.health, 70, 'damage must apply to enemy health even when attacker is dead');
  assert.strictEqual(hitmarkers, 0, 'dead attacker must not receive hitmarker');
  assert.strictEqual(creditsGranted, 0, 'dead attacker must not receive credits');
  assert.strictEqual(fieldChargeGranted, 0, 'dead attacker must not receive field charge');

  // 2. Posthumous lethal blow (e.g. grenade explosion or burn kill after player died)
  c.damageEnemy(enemy, 80, enemy.pos, false, false, 'AR', c.player);
  assert.strictEqual(enemy.health <= 0, true, 'lethal damage must reduce enemy to <= 0 health');
  assert.strictEqual(enemy.dead, true, 'kill must resolve in world state (dead flag)');
  assert.strictEqual(hitmarkers, 0, 'dead killer must not receive hitmarker');
  assert.strictEqual(creditsGranted, 0, 'dead killer must not receive credits');
  assert.strictEqual(fieldChargeGranted, 0, 'dead killer must not receive field charge');
  assert.strictEqual(scoreGranted, 0, 'dead killer must not receive score');
  assert.strictEqual(c.kills, 0, 'dead killer must not increment kills counter');
  assert.strictEqual(c.headshots, 0, 'dead killer must not increment headshot counter');
  assert.strictEqual(streaksRegistered, 0, 'dead killer must not register killstreak');
  assert.strictEqual(killBonusCalls, 0, 'dead killer must not trigger multi-kill streak bonus');
  assert.strictEqual(powerUpsDropped, 0, 'dead killer must not trigger power-up drops');
  assert.strictEqual(pickupsDropped, 0, 'dead killer must not trigger pickup drops');

  // 3. Omitted attacker fallback with dead player also withholds rewards
  const enemy2 = {
    team: 'enemy',
    pos: new Vector3(5, 0, 5),
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };
  c.damageEnemy(enemy2, 100, enemy2.pos, false);
  assert.strictEqual(enemy2.dead, true);
  assert.strictEqual(c.kills, 0, 'omitted attacker with dead player fallback must not increment kills');
  assert.strictEqual(scoreGranted, 0, 'omitted attacker with dead player fallback must not grant score');

  // 4. Living player DOES receive all rewards
  c.player.dead = false;
  const enemy3 = {
    team: 'enemy',
    pos: new Vector3(5, 0, 5),
    health: 50,
    maxHealth: 100,
    dead: false,
    parts: c.dummyParts()
  };
  c.damageEnemy(enemy3, 60, enemy3.pos, false, false, 'AR', c.player);
  assert.strictEqual(enemy3.dead, true);
  assert.strictEqual(hitmarkers > 0, true, 'living player must receive hitmarker');
  assert.strictEqual(creditsGranted > 0, true, 'living player must receive credits');
  assert.strictEqual(scoreGranted > 0, true, 'living player must receive score');
  assert.strictEqual(c.kills, 1, 'living player must increment kill counter');
});

test('CORE.isFriendlyFire heuristic: unknown and team-less hostiles are not treated as friendly', () => {
  // Actors with undefined team and undefined kind must NOT be treated as friendly
  const teamlessHostile = { dead: false };
  const teamlessAttacker = { dead: false, hostile: true };
  const enemyBot = { team: 'enemy', kind: 1, dead: false };
  const friendlyBot = { team: 'friendly', kind: 1, dead: false };
  const playerActor = { team: 'friendly', isPlayer: true, dead: false };

  // A team-less hostile attacking an enemy must NOT trigger friendly fire
  assert.strictEqual(CORE.isFriendlyFire(teamlessHostile, enemyBot), false, 'teamless hostile attacking enemy is not friendly fire');
  assert.strictEqual(CORE.isFriendlyFire(teamlessAttacker, enemyBot), false, 'explicit hostile flag attacking enemy is not friendly fire');

  // A team-less hostile attacking a friendly bot must NOT trigger friendly fire
  assert.strictEqual(CORE.isFriendlyFire(teamlessHostile, friendlyBot), false, 'teamless hostile attacking friendly is not friendly fire');
  assert.strictEqual(CORE.isFriendlyFire(teamlessAttacker, friendlyBot), false, 'explicit hostile flag attacking friendly is not friendly fire');

  // Two team-less actors cannot be confirmed on same team
  assert.strictEqual(CORE.isFriendlyFire(teamlessHostile, teamlessAttacker), false, 'unidentified actors do not trigger friendly fire');

  // Friendly-fire only triggers when both actors are on the same identified team
  assert.strictEqual(CORE.isFriendlyFire(playerActor, friendlyBot), true, 'both friendly triggers friendly fire');
  assert.strictEqual(CORE.isFriendlyFire(enemyBot, { team: 'enemy', dead: false }), true, 'both enemy triggers friendly fire');
  assert.strictEqual(CORE.isFriendlyFire(playerActor, enemyBot), false, 'friendly vs enemy is not friendly fire');
});

test('spawn protection reachable on production deploy and wave spawn paths', () => {
  // 1. Production player definition in 20_player.js must initialize spawnProtectionT = 0 (Survival deploy contract: no match immunity)
  const playerSrc = source('20_player.js');
  const pContext = vm.createContext({
    CORE,
    CFG: { player: { height: 1.7, health: 100, armor: 50, maxStamina: 100, radius: 0.4 } },
    THREE: { Vector3 },
    canvas: { addEventListener: noop },
    addEventListener: noop,
    document: { addEventListener: noop },
    window: {}
  });
  const playerObj = vm.runInContext(playerSrc + '; player;', pContext);
  assert.strictEqual(playerObj.spawnProtectionT, 0, 'player must have 0 spawn protection on Survival deploy');

  // 2. Wave enemy spawn caller in 60_hud_waves.js must NOT pass spawnProtection: true
  const hudWavesSrc = source('60_hud_waves.js');
  assert.ok(
    !hudWavesSrc.includes('spawnProtection: true'),
    'spawnEnemy caller in 60_hud_waves.js must NOT pass spawnProtection: true (Survival wave enemies have no spawn immunity)'
  );

  // 3. Survival deploy contract: player has zero spawn immunity and hostile damage applies immediately,
  // while match spawn protection check stays intact when spawnProtectionT > 0.
  const c = createCombatContext();
  const playerText = source('20_player.js');
  const dmgPlayerSlice = playerText.slice(playerText.indexOf('function damagePlayer('));
  const endFn = dmgPlayerSlice.indexOf('\n}\n');
  vm.runInContext(dmgPlayerSlice.slice(0, endFn + 3), c);
  c.godMode = false;
  c.player.dead = false;
  c.player.health = 100;
  c.player.armor = 0;
  c.player.spawnProtectionT = 0; // Fresh Survival deploy contract
  const hostileAttacker = { team: 'enemy', dead: false, pos: new Vector3(5, 0, 0) };
  c.damagePlayer(25, 0, 'bullet', hostileAttacker);
  assert.strictEqual(c.player.health, 75, 'freshly deployed Survival player without spawn protection must take hostile damage');

  // Negative control: match protection check in damagePlayer stays intact when spawnProtectionT > 0
  c.player.spawnProtectionT = 2.0;
  c.damagePlayer(25, 0, 'bullet', hostileAttacker);
  assert.strictEqual(c.player.health, 75, 'damagePlayer must not damage player while spawnProtectionT > 0');

  // 4. scripts/probe_live.py survival deploy check must align with contract: require zero spawnProtectionT, not active protection
  const probeSrc = fs.readFileSync(path.join(__dirname, '../scripts/probe_live.py'), 'utf8');
  assert.ok(
    !probeSrc.includes("protActive = typeof player !== 'undefined' && player && player.spawnProtectionT > 0;"),
    'scripts/probe_live.py must not require active spawn protection on Survival deploy'
  );
  assert.match(
    probeSrc,
    /zeroProtection\s*=\s*typeof player !== ['"]undefined['"] && player && player\.spawnProtectionT === 0;/,
    'scripts/probe_live.py survival deploy check must assert zero spawnProtectionT'
  );
});

test('dead bot removed by updateEnemies must reenter actual lexical enemies on respawn with original identity/mesh/position and no duplicates', () => {
  const c = createCombatContext();
  const modesSrc = source('35_modes.js');
  vm.runInContext(modesSrc, c);

  const botGroup = new Group();
  const bot = {
    id: 'test_enemy_1',
    team: 'enemy',
    kind: 1,
    pos: new Vector3(10, 0, 10),
    vel: new Vector3(0, 0, 0),
    yaw: 0,
    health: 100,
    maxHealth: 100,
    dead: false,
    parts: Object.assign(c.dummyParts(), { group: botGroup })
  };
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  c.enemies.length = 0;
  c.enemies.push(bot);
  assert.strictEqual(c.enemies.length, 1);
  assert.strictEqual(c.enemies.includes(bot), true);

  c.killEnemy(bot, false, c.player);
  assert.strictEqual(bot.dead, true);
  assert.strictEqual(c.modeRespawnQueue.length, 1);

  // updateEnemies drops dead bot from enemies roster
  c.updateEnemies(1 / 60);
  assert.strictEqual(c.enemies.includes(bot), false, 'dead bot must be spliced out of enemies by updateEnemies');
  assert.strictEqual(c.enemies.length, 0);

  // Step TDM update until respawn timer expires (3s)
  c.spawnPoints = [[15, 25]];
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.1);

  // Assertions for revived bot:
  assert.strictEqual(c.modeRespawnQueue.length, 0, 'queue must be drained');
  assert.strictEqual(bot.dead, false, 'bot.dead must be cleared');
  assert.strictEqual(c.enemies.includes(bot), true, 'revived bot MUST reenter lexical enemies array');
  assert.strictEqual(c.enemies.length, 1, 'enemies array must have length 1');
  assert.strictEqual(bot.pos.x, 15, 'position x must be restored to spawn point');
  assert.strictEqual(bot.pos.z, 25, 'position z must be restored to spawn point');
  assert.strictEqual(botGroup.position.x, 15, 'group mesh x must be restored to spawn point');
  assert.strictEqual(botGroup.position.z, 25, 'group mesh z must be restored to spawn point');
  assert.strictEqual(bot.health, 100, 'bot health must be restored to maxHealth');

  // Prove it can target and be targeted
  const target = c.findNearestHostileActor(bot);
  assert.strictEqual(target, c.player, 'revived bot must be able to target player');
  const enemyForPlayer = c.findNearestHostileActor(c.player);
  assert.strictEqual(enemyForPlayer, bot, 'player must be able to target revived bot in enemies');

  // Prove it can fight (updateEnemies runs without error on it)
  c.updateEnemies(0.1);
  assert.strictEqual(bot.dead, false);

  // Break spawn protection and prove it can take damage again
  bot.spawnProtectionT = 0;
  c.damageEnemy(bot, 30, bot.pos, false, false, 'AR', c.player);
  assert.strictEqual(bot.health, 70, 'revived bot must be able to take damage again');

  // Prove repeated deaths produce no duplicate entries
  c.killEnemy(bot, false, c.player);
  assert.strictEqual(bot.dead, true);
  c.updateEnemies(1 / 60);
  assert.strictEqual(c.enemies.includes(bot), false, 'dead bot must be dropped again');
  assert.strictEqual(c.enemies.length, 0);

  // Respawn again
  c.MODES.tdm.update(3.1);
  assert.strictEqual(bot.dead, false);
  assert.strictEqual(c.enemies.includes(bot), true, 'bot re-enters enemies on second respawn');
  assert.strictEqual(c.enemies.length, 1, 'must have exactly one entry in enemies, no duplicates');
});

test('checkpoint serialization and defensive resume boundary: only Survival supports checkpoints, no match respawn stubs', () => {
  // 1. Serialization via makeCheckpoint: modeRespawnQueue must NOT be serialized
  const state = {
    wave: 3, score: 1000, kills: 10, headshots: 2,
    shotsFired: 50, shotsHit: 30,
    health: 100, armor: 50, grenades: 2, credits: 500,
    weapons: [{ gi: 0, ammo: 30, reserve: 90, up: null }],
    spawnProtectionT: 0,
    modeRespawnQueue: [
      { timer: 2.5, actor: { id: 'bot1', team: 'friendly', kind: 1 } }
    ]
  };

  const cp = CORE.makeCheckpoint(state);
  assert.strictEqual(cp.modeRespawnQueue, undefined, 'makeCheckpoint must NOT serialize modeRespawnQueue');

  // 2. Validation via validateCheckpoint: no modeRespawnQueue returned
  const valid = CORE.validateCheckpoint(cp);
  assert.ok(valid);
  assert.strictEqual(valid.modeRespawnQueue, undefined, 'validateCheckpoint must NOT return modeRespawnQueue');

  // 3. Defensive loading for legacy checkpoint with detached modeRespawnQueue
  const legacyRaw = {
    v: 3,
    wave: 2, score: 500, kills: 5, headshots: 1,
    shotsFired: 20, shotsHit: 10,
    health: 100, armor: 0, grenades: 2, credits: 100,
    weapons: [{ gi: 0, ammo: 30, reserve: 60, up: null }],
    modeRespawnQueue: [{ timer: 2.5, actor: { id: 'stub', team: 'friendly' } }]
  };
  const legacyLoaded = CORE.validateCheckpoint(legacyRaw);
  assert.ok(legacyLoaded);
  assert.strictEqual(legacyLoaded.modeRespawnQueue, undefined, 'legacy checkpoint must drop detached modeRespawnQueue');
});

test('TDM production setup, settings schema, 6v6 roster, match HUD, Tab scoreboard, and player death respawn', () => {
  // Settings defaults
  const defSettings = CORE.defaultSettings();
  assert.strictEqual(defSettings.gameMode, 'survival', 'default gameMode setting must be survival');
  assert.strictEqual(defSettings.tdmScoreLimit, 75, 'default tdmScoreLimit setting must be 75');
  assert.strictEqual(defSettings.tdmTeamSize, 6, 'default tdmTeamSize setting must be 6');

  // TDM default rules
  const c = createCombatContext();
  const modesSrc = source('35_modes.js');
  vm.runInContext(modesSrc, c);

  assert.strictEqual(c.MODES.tdm.targetScore, 75, 'TDM targetScore must default to 75');
  assert.strictEqual(c.MODES.tdm.matchDuration, 600, 'TDM matchDuration must default to 600');

  // 6v6 roster setup (player + 5 friendly vs 6 enemies)
  c.spawnPoints = [
    [0, 10], [5, 10], [10, 10], [15, 10], [20, 10], [25, 10],
    [0, -10], [5, -10], [10, -10], [15, -10], [20, -10], [25, -10]
  ];
  c.MODES.tdm.setup();
  const friendlies = c.enemies.filter(e => e.team === 'friendly');
  const enemies = c.enemies.filter(e => e.team === 'enemy');
  assert.strictEqual(friendlies.length, 5, 'TDM setup must spawn 5 friendly bots (with player = 6 friendly)');
  assert.strictEqual(enemies.length, 6, 'TDM setup must spawn 6 enemy bots (6v6 total)');

  // Scoreboard structure for Tab K/D
  const sb = c.MODES.tdm.scoreboard();
  assert.ok(sb.friendlyTeam && Array.isArray(sb.friendlyTeam.members), 'scoreboard must have friendly team members');
  assert.ok(sb.enemyTeam && Array.isArray(sb.enemyTeam.members), 'scoreboard must have enemy team members');
  assert.strictEqual(sb.friendlyTeam.members.length, 6, 'friendly team scoreboard must have 6 members');
  assert.strictEqual(sb.enemyTeam.members.length, 6, 'enemy team scoreboard must have 6 members');
  assert.strictEqual(typeof sb.friendlyTeam.members[0].kills, 'number', 'member must have numeric kills');
  assert.strictEqual(typeof sb.friendlyTeam.members[0].deaths, 'number', 'member must have numeric deaths');

  // Player death in TDM queues respawn rather than gameover
  c.MODES.tdm.onDeath(c.player, null);
  assert.strictEqual(c.modeRespawnQueue.some(e => e.actor === c.player), true, 'player death in TDM must queue respawn');

  // Match completes when target score reached
  c.MODES.tdm.friendlyScore = 75;
  assert.strictEqual(c.MODES.tdm.isOver(), true, 'isOver must return true when target score reached');
});

test('TDM lifecycle: score limit selection, spawn immunity wait/expire before kill, end match update, and cleanup', () => {
  const c = createCombatContext();
  const modesSrc = source('35_modes.js');
  vm.runInContext(modesSrc, c);

  // 1. Selected score control produces short 2-kill match vs normal 75
  let savedSettings = { tdmScoreLimit: 2, tdmTeamSize: 6, gameMode: 'tdm' };
  c.getSetting = key => savedSettings[key];
  c.setSetting = (key, val) => { savedSettings[key] = val; };

  c.spawnPoints = [
    [0, 10], [5, 10], [10, 10], [15, 10], [20, 10], [25, 10],
    [0, -10], [5, -10], [10, -10], [15, -10], [20, -10], [25, -10]
  ];

  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  assert.strictEqual(c.MODES.tdm.targetScore, 2, 'TDM targetScore must be 2 when score limit 2 is selected');

  const hostiles = c.enemies.filter(e => e.team === 'enemy');
  const targetHostile = hostiles[0];
  assert.ok(targetHostile, 'must have enemy bot');
  assert.strictEqual(targetHostile.spawnProtectionT > 0, true, 'hostile must spawn with active spawn protection');

  // 2. Default spawn immunity: damage dealt while protected is ignored
  const initialHp = targetHostile.health;
  c.damageEnemy(targetHostile, 45, targetHostile.pos, false, false, 'AR', c.player);
  assert.strictEqual(targetHostile.health, initialHp, 'hostile with spawn protection must take zero damage');
  assert.strictEqual(targetHostile.dead, false, 'hostile must not die while spawn protection is active');

  // 3. Protection must wait/expire (via updateEnemies dt or hostile attack) before killing
  c.updateEnemies(1.0);
  c.updateEnemies(1.1);
  assert.strictEqual(targetHostile.spawnProtectionT, 0, 'spawn protection must expire over time');

  // 4. Once protection expired, lethal damage kills hostile
  c.damageEnemy(targetHostile, 300, targetHostile.pos, false, false, 'AR', c.player);
  assert.strictEqual(targetHostile.dead, true, 'hostile must die after spawn protection has expired');

  // 5. updateEnemies drops corpse from enemies array and queues respawn
  c.updateEnemies(1 / 60);
  assert.strictEqual(c.enemies.includes(targetHostile), false, 'dead hostile must be dropped from enemies array');
  assert.strictEqual(c.modeRespawnQueue.some(e => e.actor === targetHostile), true, 'dead hostile must enter modeRespawnQueue');
  assert.strictEqual(c.MODES.tdm.friendlyScore, 1, 'friendlyScore must increment to 1');
  assert.strictEqual(c.MODES.tdm.isOver(), false, 'match must not be over at 1 kill when target is 2');

  // 6. Step respawn timer and revive actor back into lexical enemies
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.1);
  assert.strictEqual(targetHostile.dead, false, 'hostile must be revived on respawn');
  assert.strictEqual(c.enemies.includes(targetHostile), true, 'revived hostile must re-enter enemies array');
  assert.strictEqual(targetHostile.spawnProtectionT > 0, true, 'revived hostile must receive fresh spawn protection');

  // Expire fresh protection
  c.updateEnemies(2.1);
  assert.strictEqual(targetHostile.spawnProtectionT, 0, 'fresh spawn protection must expire');

  // 7. Kill 2 reaches targetScore (2), match completes
  let endMatchCalled = false;
  c.MODES.tdm.endMatch = () => { endMatchCalled = true; c.gameEnded = true; };

  c.damageEnemy(targetHostile, 300, targetHostile.pos, false, false, 'AR', c.player);
  assert.strictEqual(c.MODES.tdm.friendlyScore, 2, 'friendlyScore must reach target score 2');
  assert.strictEqual(c.MODES.tdm.isOver(), true, 'isOver must return true when friendlyScore reaches targetScore');
  assert.strictEqual(endMatchCalled, true, 'endMatch must be triggered on reaching target score');

  // Negative control: verify normal 75 would NOT be over at 2 kills
  c.MODES.tdm.targetScore = 75;
  assert.strictEqual(c.MODES.tdm.isOver(), false, 'match must not be over at 2 kills with normal 75 target score');
  c.MODES.tdm.targetScore = 2;

  // 8. Normal update loop respects ended state
  c.MODES.tdm.update(1 / 60);
  assert.strictEqual(c.gameEnded, true, 'gameEnded must be true');

  // 9. Standard settings restored on cleanup
  c.setSetting('tdmScoreLimit', 75);
  c.setSetting('tdmTeamSize', 6);
  c.setSetting('gameMode', 'survival');
  c.MODES.tdm.targetScore = 75;
  c.MODES.tdm.teamSize = 6;
  c.setActiveMode('survival');

  assert.strictEqual(c.getSetting('tdmScoreLimit'), 75, 'tdmScoreLimit must restore to 75');
  assert.strictEqual(c.getSetting('tdmTeamSize'), 6, 'tdmTeamSize must restore to 6');
  assert.strictEqual(c.getSetting('gameMode'), 'survival', 'gameMode must restore to survival');
  assert.strictEqual(c.getActiveMode().id, 'survival', 'activeMode must restore to survival');
});

test('production UI menu quit and reset lifecycle: exits pointer lock and cleans started state', () => {
  const mainSrc = source('70_main.js');

  // 1. quitMatchToMenu must exit pointer lock and clear body.started
  assert.match(mainSrc, /function quitMatchToMenu\(\)\s*\{[^}]*document\.exitPointerLock\(\)/s,
    'quitMatchToMenu must defensively exit pointer lock when returning to menu');
  assert.match(mainSrc, /function quitMatchToMenu\(\)\s*\{[^}]*document\.body\.classList\.remove\(['"]started['"]\)/s,
    'quitMatchToMenu must remove started class from body');

  // 2. Pause quit, death quit, victory quit must exit pointer lock and remove started class
  assert.match(mainSrc, /\$id\(['"]btn-quit['"]\)\.addEventListener\(['"]click['"],\s*function\s*\(\)\s*\{[^}]*document\.exitPointerLock\(\)/s,
    'btn-quit must exit pointer lock');
  assert.match(mainSrc, /\$id\(['"]btn-quit['"]\)\.addEventListener\(['"]click['"],\s*function\s*\(\)\s*\{[^}]*document\.body\.classList\.remove\(['"]started['"]\)/s,
    'btn-quit must remove started class from body');

  assert.match(mainSrc, /\$id\(['"]btn-death-quit['"]\)\.addEventListener\(['"]click['"],\s*function\s*\(\)\s*\{[^}]*document\.exitPointerLock\(\)/s,
    'btn-death-quit must exit pointer lock');
  assert.match(mainSrc, /\$id\(['"]btn-death-quit['"]\)\.addEventListener\(['"]click['"],\s*function\s*\(\)\s*\{[^}]*document\.body\.classList\.remove\(['"]started['"]\)/s,
    'btn-death-quit must remove started class from body');

  assert.match(mainSrc, /\$id\(['"]btn-v-quit['"]\)\.addEventListener\(['"]click['"],\s*function\s*\(\)\s*\{[^}]*document\.exitPointerLock\(\)/s,
    'btn-v-quit must exit pointer lock');
  assert.match(mainSrc, /\$id\(['"]btn-v-quit['"]\)\.addEventListener\(['"]click['"],\s*function\s*\(\)\s*\{[^}]*document\.body\.classList\.remove\(['"]started['"]\)/s,
    'btn-v-quit must remove started class from body');
});

function createTextureCanvas(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  let fillStyle = '#000000';
  let strokeStyle = '#000000';
  let path = [];
  function parseColor(str) {
    if (typeof str !== 'string') return [128, 128, 128, 255];
    if (str.startsWith('#')) {
      const hex = str.slice(1);
      if (hex.length === 6) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
      if (hex.length === 3) return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 255];
    }
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m) {
      const a = m[4] !== undefined ? Math.round(parseFloat(m[4]) * 255) : 255;
      return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), a];
    }
    return [128, 128, 128, 255];
  }
  const ctx = {
    get fillStyle() { return fillStyle; },
    set fillStyle(v) { fillStyle = v; },
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(v) { strokeStyle = v; },
    font: '', textAlign: '', textBaseline: '', lineCap: '', lineWidth: 1,
    fillRect(x, y, rw, rh) {
      const col = parseColor(fillStyle);
      const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(w, Math.ceil(x + rw));
      const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(h, Math.ceil(y + rh));
      for (let cy = y0; cy < y1; cy++) {
        for (let cx = x0; cx < x1; cx++) {
          const idx = (cy * w + cx) * 4;
          data[idx] = col[0]; data[idx + 1] = col[1]; data[idx + 2] = col[2]; data[idx + 3] = col[3];
        }
      }
    },
    strokeRect: noop, fillText: noop,
    beginPath() { path = []; }, closePath: noop, moveTo: noop, lineTo: noop, stroke: noop,
    quadraticCurveTo: noop, rotate: noop, translate: noop,
    arc(x, y, r) { path.push({ type: 'ellipse', x, y, rx: r, ry: r, rot: 0 }); },
    ellipse(x, y, rx, ry, rot) { path.push({ type: 'ellipse', x, y, rx, ry, rot }); },
    fill() {
      const col = parseColor(fillStyle);
      for (const item of path) {
        if (item.type === 'ellipse') {
          const { x, y, rx, ry, rot } = item;
          const maxR = Math.max(rx, ry);
          const x0 = Math.max(0, Math.floor(x - maxR)), x1 = Math.min(w, Math.ceil(x + maxR));
          const y0 = Math.max(0, Math.floor(y - maxR)), y1 = Math.min(h, Math.ceil(y + maxR));
          const cos = Math.cos(-rot), sin = Math.sin(-rot);
          for (let cy = y0; cy < y1; cy++) {
            for (let cx = x0; cx < x1; cx++) {
              const dx = cx - x, dy = cy - y;
              const ex = dx * cos - dy * sin;
              const ey = dx * sin + dy * cos;
              if ((ex / rx) ** 2 + (ey / ry) ** 2 <= 1) {
                const idx = (cy * w + cx) * 4;
                data[idx] = col[0]; data[idx + 1] = col[1]; data[idx + 2] = col[2]; data[idx + 3] = col[3];
              }
            }
          }
        }
      }
    },
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: (x, y, sw, sh) => ({ data }),
    createImageData: (sw, sh) => ({ data: new Uint8ClampedArray(sw * sh * 4) }),
    putImageData(img) { data.set(img.data); }
  };
  return { width: w, height: h, getContext: () => ctx, _data: data };
}

let _cachedProductionTex = null;
function getProductionTex() {
  if (!_cachedProductionTex) {
    const texContext = vm.createContext({
      document: {
        createElement: (tag) => tag === 'canvas' ? createTextureCanvas(512, 512) : {}
      },
      THREE: {
        CanvasTexture: function (c) {
          this.image = c;
          this.repeat = { set: (x, y) => { this.repeatX = x; this.repeatY = y; } };
        },
        RepeatWrapping: 1000
      },
      Math
    });
    vm.runInContext(source('08_textures.js'), texContext);
    _cachedProductionTex = vm.runInContext('TEX', texContext);
  }
  return _cachedProductionTex;
}

function createFullMatchContext(overrides = {}) {
  const docElements = new Map();
  const doc = {
    getElementById: id => {
      if (!docElements.has(id)) {
        docElements.set(id, {
          id,
          style: { display: '' },
          getContext: () => ({ clearRect: noop, drawImage: noop, fillStyle: '', strokeStyle: '', lineWidth: 1, beginPath: noop, arc: noop, fill: noop, stroke: noop, rotate: noop }),
          textContent: '',
          innerHTML: '',
          dataset: {},
          classList: { add: noop, remove: noop, contains: () => false },
          querySelector: () => null,
          querySelectorAll: () => [],
          _listeners: {},
          addEventListener: function (type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
          },
          removeEventListener: noop,
          click: function () {
            const cbs = this._listeners['click'] || [];
            if (cbs.length > 0) {
              for (let i = 0; i < cbs.length; i++) cbs[i].call(this);
            } else {
              if (id === 'btn-match-restart' && typeof c.restartMatch === 'function') c.restartMatch();
              if (id === 'btn-match-quit' && typeof c.quitMatchToMenu === 'function') c.quitMatchToMenu();
            }
          },
          appendChild: function (child) {
            this.children = this.children || [];
            this.children.push(child);
            if (child && child.id) docElements.set(child.id, child);
          }
        });
      }
      return docElements.get(id);
    },
    createElement: tag => ({
      tagName: tag,
      id: '',
      className: '',
      innerHTML: '',
      textContent: '',
      style: { display: '' },
      classList: { add: noop, remove: noop, contains: () => false },
      _listeners: {},
      addEventListener: function (type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      },
      removeEventListener: noop,
      click: function () {
        const cbs = this._listeners['click'] || [];
        for (let i = 0; i < cbs.length; i++) cbs[i].call(this);
      },
      appendChild: noop,
      setAttribute: noop,
      querySelector: () => ({ textContent: '', style: {}, classList: { add: noop, remove: noop } })
    }),
    querySelectorAll: () => [],
    querySelector: () => ({ textContent: '' }),
    body: { classList: { remove: noop, add: noop, contains: () => false } },
    addEventListener: noop,
    removeEventListener: noop,
    exitPointerLock: noop,
    pointerLockElement: null
  };

  const dummyParts = () => ({
    group: new Group(),
    legL: new Mesh(),
    legR: new Mesh(),
    armL: new Mesh(),
    armR: new Mesh(),
    body: new Mesh()
  });

  const c = vm.createContext(Object.assign({
    CORE,
    IS_TOUCH: false,
    assetsReady: true,
    Math: Object.create(Math),
    performance: { now: () => Date.now() },
    THREE: {
      Vector3,
      Group,
      Mesh,
      MeshStandardMaterial: Material,
      MeshBasicMaterial: Material,
      BoxGeometry: Geometry,
      CylinderGeometry: Geometry,
      SphereGeometry: Geometry,
      RingGeometry: Geometry,
      DoubleSide: 2,
      Raycaster: function () { return { set: noop, intersectObjects: () => [] }; },
      Color: function (col) { this.c = col; this.lerp = noop; }
    },
    MAT: { accent: new Material() },
    mapBounds: 50,
    GROUND: 0,
    navGrid: null,
    raycastColliders: [],
    waveBehaviours: {},
    E_DIM: { pelvisH: 0.95 },
    losFrame: 0,
    nextEstepT: 0,
    updateStatusEffects: noop,
    updateFlowField: noop,
    updateEnemyShadowBudget: noop,
    flushStaticBatches: noop,
    rebuildWorldRayGrid: function () {
      c.worldRayGrid = CORE.buildRayGrid({ cell: 8, halfExtent: 50 });
      return c.worldRayGrid;
    },
    rebuildNavGrid: function () {
      c.navGrid = CORE.buildNavGrid(c.colliders, { cell: 1, halfExtent: 50, stepH: 0.6, walkerHeight: 1.8, agentRadius: 0.5 });
      return c.navGrid;
    },
    document: doc,
    $id: id => doc.getElementById(id),
    canvas: { addEventListener: noop, requestPointerLock: noop },
    window: {},
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: (fn, ms) => 1,
    clearTimeout: noop,
    requestAnimationFrame: () => 1,
    playSound: noop,
    playSound3D: noop,
    diff: () => ({ dmg: 1, speed: 1, hp: 1 }),
    stopMusic: noop,
    showDamageFx: noop,
    showHitmarker: noop,
    spawnBlood: noop,
    spawnImpact: noop,
    addFieldCharge: noop,
    playerRank: () => 1,
    updateHudHealth: noop,
    updateHudAmmo: noop,
    updateHudStreaks: noop,
    updateHudPerks: noop,
    applyTouchInput: noop,
    showCenterMsg: noop,
    showCenterMsgThrottled: noop,
    killfeedMessages: [],
    pushKillfeed: function (msg) { c.killfeedMessages.push(msg); },
    breakStreak: noop,
    addBox: function (x, y, z, w, h, d, mat) {
      c.colliders.push({
        min: new Vector3(x - w/2, y - h/2, z - d/2),
        max: new Vector3(x + w/2, y + h/2, z + d/2),
        mat: 'concrete'
      });
    },
    scene: {
      add: noop,
      remove: noop,
      background: { hex: 0, setHex: function (h) { this.hex = h; return this; } },
      fog: { color: { hex: 0, setHex: function (h) { this.hex = h; return this; } } }
    },
    colliders: [],
    smokeVolumes: () => [],
    activeMapId: 'urban',
    get TEX() { return getProductionTex(); },
    groundMat: {
      map: null,
      normalMap: null,
      color: { hex: 0, setHex: function (h) { this.hex = h; return this; } },
      roughness: 0.92,
      needsUpdate: false
    },
    SKY_UNIFORMS: {
      top: { value: { hex: 0, setHex: function (h) { this.hex = h; return this; }, convertSRGBToLinear: function () { return this; } } },
      mid: { value: { hex: 0, setHex: function (h) { this.hex = h; return this; }, convertSRGBToLinear: function () { return this; } } },
      horizon: { value: { hex: 0, setHex: function (h) { this.hex = h; return this; }, convertSRGBToLinear: function () { return this; } } },
      low: { value: { hex: 0, setHex: function (h) { this.hex = h; return this; }, convertSRGBToLinear: function () { return this; } } },
      sunDir: { value: { x: 0, y: 0, z: 0, set: function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, normalize: function () { return this; } } }
    },
    sun: {
      color: { hex: 0, setHex: function (h) { this.hex = h; return this; } },
      position: { x: 0, y: 0, z: 0, set: function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
    },
    SUN_OFFSET: { x: 0, y: 0, z: 0, set: function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; } },
    MAPS: {
      urban: {
        id: 'urban',
        name: 'Urban District',
        get playerSpawn() { return CORE.getMapDef('urban').playerSpawn; },
        get spawnPoints() { return CORE.getMapDef('urban').spawnPoints; },
        get stationLayout() { return (typeof c !== 'undefined' && c.STATION_LAYOUT) ? c.STATION_LAYOUT : CORE.getMapDef('urban').stationLayout; },
        get dominationFlags() { return CORE.getMapDef('urban').dominationFlags; },
        get districts() { return CORE.getMapDef('urban').districts; },
        get barriers() { return CORE.getMapDef('urban').barriers; },
        build: noop
      },
      snowy: {
        id: 'snowy',
        name: 'Snowy Compound',
        get playerSpawn() { return CORE.getMapDef('snowy').playerSpawn; },
        get spawnPoints() { return CORE.getMapDef('snowy').spawnPoints; },
        get stationLayout() { return CORE.getMapDef('snowy').stationLayout; },
        get dominationFlags() { return CORE.getMapDef('snowy').dominationFlags; },
        get districts() { return CORE.getMapDef('snowy').districts; },
        get barriers() { return CORE.getMapDef('snowy').barriers; },
        build: noop
      }
    },
    getActiveMap: function () { return (c && c.MAPS) ? (c.MAPS[c.activeMapId] || c.MAPS.urban) : null; },
    setActiveMap: function (id, force) {
      const safe = (typeof CORE !== 'undefined' && CORE.sanitizeMapId) ? CORE.sanitizeMapId(id) : 'urban';
      if (c) {
        const changed = (c.activeMapId !== safe);
        c.activeMapId = safe;
        c.activeMap = c.MAPS[safe] || c.MAPS.urban;
        if (changed || force) {
          const def = CORE.getMapDef(safe);
          c.colliders.length = 0;
          if (def && def.colliders) {
            for (let i = 0; i < def.colliders.length; i++) c.colliders.push(def.colliders[i]);
          }
          if (typeof c.buildStations === 'function') c.buildStations();
          if (typeof c.buildDistrictBarriers === 'function') c.buildDistrictBarriers();
          if (typeof c.applyMapSkyPreset === 'function') c.applyMapSkyPreset(safe);
          if (typeof c.rebuildNavGrid === 'function') c.rebuildNavGrid();
          if (typeof c.rebuildWorldRayGrid === 'function') c.rebuildWorldRayGrid();
        }
        return c.activeMap;
      }
      return null;
    },
    spawnPoints: [
      [0, 10], [5, 10], [10, 10], [15, 10], [20, 10], [25, 10],
      [0, -10], [5, -10], [10, -10], [15, -10], [20, -10], [25, -10]
    ],
    openSpawnPoints: function () {
      const cur = (c && typeof c.getActiveMap === 'function') ? c.getActiveMap() : null;
      return (cur && cur.spawnPoints && cur.spawnPoints.length) ? cur.spawnPoints : c.spawnPoints;
    },
    perks: [],
    godMode: false,
    startMusic: noop,
    stopMusic: noop,
    runDifficulty: 'regular',
    endlessMode: false,
    runPhase: 'active',
    weaponsOwned: [0, -1],
    wState: [{ ammo: 30, reserve: 90 }, {}],
    initWeapons: noop,
    refreshWeaponStats: noop,
    openDistrict: noop,
    equippedLethal: 'frag',
    equippedTactical: 'smoke',
    tacticalCount: 2,
    fieldCharge: 0,
    streakBank: [],
    streakKills: 0,
    curWeapon: 0,
    buildViewmodel: noop,
    showWaveBanner: noop,
    updateWaves: dt => {
      if (typeof c.updateObjective === 'function') c.updateObjective(dt);
      if (c.waveActive && c.enemies.length === 0 && (c.waveQueue || 0) === 0) {
        c.waveActive = false;
        if (c.objective && !c.objective.done && c.objective.type === 'defend' && !c.objective.failed && c.objective.target && !c.objective.target.dead) {
          if (typeof c.completeObjective === 'function') c.completeObjective('Generator defended');
        }
        if (typeof c.saveCheckpoint === 'function' && typeof c.captureRunState === 'function') {
          c.saveCheckpoint(c.captureRunState());
        }
        if (typeof c.clearObjective === 'function') c.clearObjective();
      }
      if (c.betweenWaveT > 0) {
        c.betweenWaveT -= dt;
        if (c.betweenWaveT <= 0) {
          if (typeof c.startWave === 'function') c.startWave(c.waveNum + 1);
          else c.waveActive = true;
        }
      }
    },
    waveActive: false,
    betweenWaveT: 3,
    plates: 0,
    gameT: 0,
    kills: 0,
    headshots: 0,
    score: 0,
    credits: 0,
    shotsFired: 0,
    shotsHit: 0,
    waveNum: 0,
    runStreaksEarned: 0,
    settlementSnapshot: null,
    captureRunState: () => ({
      wave: c.waveNum,
      score: c.score,
      difficulty: c.runDifficulty,
      endless: c.endlessMode,
      mapId: c.activeMapId || 'urban',
      weapons: [{ gi: 0, ammo: 30, reserve: 90 }],
      openDistricts: (c.openDistricts || []).slice(),
      objectivesCompleted: c.objectivesCompleted || 0,
      objectiveState: c.objective ? Object.assign({ type: c.objective.type, done: !!c.objective.done, failed: !!c.objective.failed }, (c.objective.type === 'defend' && c.objective.target && typeof c.objective.target.health === 'number') ? { hp: c.objective.target.health } : null) : null,
      equipment: { lethal: c.equippedLethal, tactical: c.equippedTactical, streakBank: (c.streakBank || []).slice() }
    }),
    saveCheckpoint: state => {
      if (typeof c.activeModeId !== 'undefined' && c.activeModeId !== 'survival') return false;
      c._checkpoint = CORE.makeCheckpoint(state);
      return true;
    },
    clearCheckpoint: () => { c._checkpoint = null; },
    loadCheckpoint: () => (c._checkpoint ? CORE.validateCheckpoint(c._checkpoint, c.CFG.weapons, c.CFG.player.health) : null),
    STATS: CORE.defaultStats(),
    recordRun: function (run) {
      const merged = CORE.mergeRunIntoStats(c.STATS || CORE.defaultStats(), run);
      c.STATS = merged.stats;
      return merged.beat;
    },
    spawnRagdoll: noop,
    disposeEnemyGeometry: noop,
    addScore: function (pts) { c.score = (c.score || 0) + pts; },
    addCredits: function (amt) { c.credits = (c.credits || 0) + (amt || 0); },
    registerKillT: noop,
    registerStreakKill: noop,
    dropPowerUp: noop,
    dropPickup: noop,
    pickups: [],
    liveGrenades: [],
    vfx: { tracers: [], impacts: [], blood: [] },
    tracerPool: [],
    impactPool: [],
    bloodPool: [],
    sparkPool: [],
    dustPool: [],
    casingPool: [],
    casings: [],
    keys: {},
    curW: () => null,
    adsDown: () => false,
    clearParticles: noop,
    clearBloodPools: noop,
    clearInputState: noop,
    clearDecals: noop,
    resetEquipment: noop,
    resetStreaks: noop,
    resetDistricts: noop,
    resetRagdolls: noop,
    clearObjective: noop,
    applySpecialLighting: noop,
    clearDowned: noop,
    resetStations: noop,
    updateHudPlates: noop,
    openDistricts: [],
    DISTRICT_BARRIERS: {},
    doorMeshes: {},
    doorColliders: {},
    loadCheckpoint: () => (c._checkpoint ? CORE.validateCheckpoint(c._checkpoint, c.CFG.weapons, c.CFG.player.health) : null),
    hud: {
      waveNum: { textContent: '' },
      scoreVal: { textContent: '' },
      credits: { textContent: '' }
    },
    grenades: { count: 2, cd: 0 },
    powerUntil: { double: -99, instakill: -99 },
    runId: 0,
    STEADY_MAX: 5,
    _settings: null,
    getSetting: k => {
      if (c && c._settings && k in c._settings) return c._settings[k];
      if (k === 'tdmTeamSize') return 6;
      if (k === 'tdmScoreLimit') return 75;
      if (k === 'muted') return false;
      if (k === 'musicVolume') return 0.5;
      if (k === 'masterVolume') return 0.9;
      return 1;
    },
    setSetting: (k, v) => {
      if (!c._settings) c._settings = {};
      c._settings[k] = v;
    },
    adsAmount: 0,
    statsSummaryHtml: () => '',
    rankBarHtml: () => '',
    challengesHtml: () => '',
    applyAimAssist: d => d,
    suppression: 0,
    started: true,
    paused: false,
    gameEnded: false,
    pointerLocked: true,
    CFG: {
      player: { height: 1.7, crouchHeight: 1.05, health: 100, armor: 50, maxStamina: 100, radius: 0.4 },
      score: { kill: 100, headshot: 50 },
      wave: { startDelay: 3 },
      ai: { speed: 3.2, chaseSpeed: 4.9, rangedSpeed: 2.8, attackRange: 2.1, meleeDamage: 18, meleeCd: 1.1, rangedRange: 44, rangedDamage: 8, rangedROF: 1.35, rangedAccuracy: 0.5, maxHealth: 100, headshotMul: 1.8, giveUpDist: 70, accPerWave: 0.035, accMax: 0.75 },
      grenade: { radius: 6, dmg: 120 },
      weapons: [{ name: 'M4 Carbine', type: 'AR', dmg: 26, rpm: 750, mag: 30, reserveMax: 90 }]
    },
    dummyParts
  }, overrides));

  vm.runInContext(source('20_player.js'), c);
  vm.runInContext(source('57_stations.js'), c);
  vm.runInContext(source('35_modes.js'), c);
  vm.runInContext(source('40_enemies.js'), c);
  const streaksSrc = source('58_streaks.js');
  const streakSlice = streaksSrc.slice(
    streaksSrc.indexOf('function awardFreeStreak('),
    streaksSrc.indexOf('// ---- Using')
  );
  vm.runInContext(streakSlice, c);

  const wavesSrc = source('60_hud_waves.js');
  const startIdx = wavesSrc.indexOf('function captureObjectiveState()') !== -1
    ? wavesSrc.indexOf('function captureObjectiveState()')
    : wavesSrc.indexOf('function captureRunState()');
  const objSlice = wavesSrc.slice(
    startIdx,
    wavesSrc.indexOf('function updateWaves(')
  );
  vm.runInContext('let objective = null; let objectivesCompleted = 0; var extraction = null;', c);
  vm.runInContext(objSlice, c);
  const mainSrc = source('70_main.js');
  const mainSlice = mainSrc.slice(0, mainSrc.indexOf('applyAllSettings();'));
  vm.runInContext(mainSlice, c);
  const worldSrc = source('10_config_world.js');
  const skyPresetSlice = worldSrc.slice(
    worldSrc.indexOf('function applyMapSkyPreset('),
    worldSrc.indexOf('function clearMapGeometry(')
  );
  vm.runInContext(skyPresetSlice, c);
  vm.runInContext('assetsReady = true;', c);

  c.player = vm.runInContext('player', c);
  c.enemies = vm.runInContext('enemies', c);
  c.modeRespawnQueue = vm.runInContext('modeRespawnQueue', c);
  c.MODES = vm.runInContext('MODES', c);
  c.applyMapSkyPreset = vm.runInContext('applyMapSkyPreset', c);
  ['paused', 'started', 'pointerLocked'].forEach(prop => {
    Object.defineProperty(c, prop, {
      get: () => vm.runInContext(prop, c),
      set: v => { vm.runInContext(prop + ' = ' + JSON.stringify(v), c); },
      configurable: true
    });
  });
  Object.defineProperty(c, 'perks', {
    get: () => vm.runInContext('perks', c),
    set: v => { vm.runInContext('perks = ' + JSON.stringify(v), c); },
    configurable: true
  });
  c.stations = vm.runInContext('stations', c);
  c.doorMeshes = vm.runInContext('doorMeshes', c);
  c.doorColliders = vm.runInContext('doorColliders', c);
  c.openDistrict = vm.runInContext('openDistrict', c);
  c.resetDistricts = vm.runInContext('resetDistricts', c);
  c.buildStations = vm.runInContext('buildStations', c);
  c.buildDistrictBarriers = vm.runInContext('buildDistrictBarriers', c);
  c.openDistricts = vm.runInContext('openDistricts', c);
  c.matchSpawnPointAt = vm.runInContext('matchSpawnPointAt', c);
  c.ground = { material: c.groundMat };
  vm.runInContext('ground = { material: groundMat }; penMaterialFor = () => "concrete";', c);
  const pfxSrc = source('48_particles.js');
  const fxSurfaceSlice = pfxSrc.slice(
    pfxSrc.indexOf('function fxSurfaceFor('),
    pfxSrc.indexOf('function fxImpact(')
  );
  vm.runInContext(fxSurfaceSlice, c);
  c.fxSurfaceFor = vm.runInContext('fxSurfaceFor', c);

  const audioSrc = source('50_vfx_audio.js');
  const footstepsSlice = audioSrc.slice(
    audioSrc.indexOf('let stepT = 0;'),
    audioSrc.indexOf('// ============ ADAPTIVE MUSIC ============')
  );
  vm.runInContext(footstepsSlice, c);
  c.updateFootsteps = vm.runInContext('updateFootsteps', c);
  Object.defineProperty(c, 'stepT', {
    get: () => vm.runInContext('stepT', c),
    set: v => { vm.runInContext('stepT = ' + JSON.stringify(v), c); },
    configurable: true
  });
  c.activeMap = c.MAPS.urban;
  c.applyMapSkyPreset(c.activeMapId);
  c.buildStations();
  c.buildDistrictBarriers();
  c.startObjective = vm.runInContext('startObjective', c);
  c.updateObjective = vm.runInContext('updateObjective', c);
  c.clearObjective = vm.runInContext('clearObjective', c);
  c.completeObjective = vm.runInContext('completeObjective', c);
  c.awardFreeStreak = vm.runInContext('awardFreeStreak', c);
  c.damageObjectiveTarget = vm.runInContext('damageObjectiveTarget', c);
  c.findNearestHostileActor = vm.runInContext('findNearestHostileActor', c);
  c.restoreObjective = vm.runInContext('restoreObjective', c);
  const _realCapture = vm.runInContext('captureRunState', c);
  c.captureRunState = function () {
    const raw = _realCapture();
    return raw ? JSON.parse(JSON.stringify(raw)) : raw;
  };
  c.objMeshes = vm.runInContext('objMeshes', c);
  Object.defineProperty(c, 'objRing', { get: () => vm.runInContext('objRing', c), configurable: true });
  Object.defineProperty(c, 'objPillar', { get: () => vm.runInContext('objPillar', c), configurable: true });
  c.startWave = function (n) {
    c.waveNum = n;
    c.waveActive = true;
    c.startObjective(n);
  };
  Object.defineProperty(c, 'objective', {
    get: () => vm.runInContext('objective', c),
    set: v => {
      c._objRef = v;
      vm.runInContext('objective = _objRef;', c);
    },
    configurable: true
  });
  Object.defineProperty(c, 'objectivesCompleted', {
    get: () => vm.runInContext('objectivesCompleted', c),
    set: v => { vm.runInContext('objectivesCompleted = ' + v + ';', c); },
    configurable: true
  });

  return c;
}

test('TDM player death lifecycle: hostile lethal -> downed -> finishing kill records authoritative killer, enemy score, stats, killfeed, and respawn', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  const p = c.player;
  p.spawnProtectionT = 0; // Fresh match spawn protection has expired

  const hostile = c.enemies.find(e => e.team === 'enemy');
  assert.ok(hostile, 'hostile bot must be present in TDM enemies roster');
  assert.strictEqual(c.MODES.tdm.enemyScore, 0, 'initial enemy score must be 0');
  assert.strictEqual(hostile.kills, 0, 'initial hostile kills must be 0');
  assert.strictEqual(p.deaths, 0, 'initial player deaths must be 0');

  // Lethal hit 1: Player goes down
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(p.downed, true, 'lethal hit 1 must down player');
  assert.strictEqual(p.dead, false, 'player must not be dead while downed');
  assert.strictEqual(c.MODES.tdm.enemyScore, 0, 'downing player must not award kill score yet');
  assert.strictEqual(hostile.kills, 0, 'downing player must not award kill count yet');
  assert.strictEqual(p.deaths, 0, 'downing player must not award death count yet');

  // Lethal hit 2: Finishing kill while down
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(p.dead, true, 'finishing hit must kill player');
  assert.strictEqual(p.downed, false, 'dead player downed state must be cleared');

  // Authoritative kill attribution
  assert.strictEqual(c.MODES.tdm.enemyScore, 1, 'finishing player kill must award 1 point to enemy team score');
  assert.strictEqual(hostile.kills, 1, 'finishing player kill must award 1 kill to hostile killer');
  assert.strictEqual(p.deaths, 1, 'finishing player kill must record 1 death for player');

  // Killfeed receives event
  const kf = c.killfeedMessages;
  assert.ok(kf.length > 0, 'killfeed must receive kill message');
  const lastKf = kf[kf.length - 1];
  assert.ok(lastKf.includes('eliminated') && lastKf.includes('YOU'), 'killfeed must show killer eliminated YOU');

  // Mode respawn queue receives player
  assert.strictEqual(c.modeRespawnQueue.some(e => e.actor === p), true, 'player must enter modeRespawnQueue');

  // Scoreboard Tab data retains player deaths and killer kills
  const sb = c.MODES.tdm.scoreboard();
  assert.strictEqual(sb.enemyScore, 1, 'scoreboard enemyScore must be 1');
  const sbHostile = sb.enemyTeam.members.find(m => m.id === hostile.id);
  assert.ok(sbHostile, 'hostile killer must appear in scoreboard');
  assert.strictEqual(sbHostile.kills, 1, 'hostile kills in scoreboard must be 1');
  const sbPlayer = sb.friendlyTeam.members.find(m => m.isPlayer);
  assert.ok(sbPlayer, 'player must appear in friendly scoreboard');
  assert.strictEqual(sbPlayer.deaths, 1, 'player deaths in scoreboard must be 1');
});

test('TDM player death lifecycle: hostile down -> bleedout death attributes killer and increments enemy score', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  const p = c.player;
  p.spawnProtectionT = 0;

  const hostile = c.enemies.find(e => e.team === 'enemy');
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(p.downed, true, 'hostile lethal damage must down player');

  // Bleedout timer runs out (DOWN_TIME is 10s)
  c.updateDowned(10.1);
  assert.strictEqual(p.dead, true, 'bleedout expiration must kill player');
  assert.strictEqual(p.downed, false, 'bleedout death must clear downed state');

  // Killer must be preserved as the hostile who downed the player
  assert.strictEqual(c.MODES.tdm.enemyScore, 1, 'bleedout after hostile down must credit hostile team score');
  assert.strictEqual(hostile.kills, 1, 'bleedout after hostile down must credit hostile killer');
  assert.strictEqual(p.deaths, 1, 'bleedout death must increment player deaths');
});

test('TDM player death lifecycle: repeated damage calls on dead player do not duplicate score or death events', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  const p = c.player;
  p.spawnProtectionT = 0;
  const hostile = c.enemies.find(e => e.team === 'enemy');

  c.damagePlayer(10000, 0, 'bullet', hostile);
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(p.dead, true);
  assert.strictEqual(c.MODES.tdm.enemyScore, 1);
  assert.strictEqual(hostile.kills, 1);
  assert.strictEqual(p.deaths, 1);
  assert.strictEqual(c.modeRespawnQueue.filter(e => e.actor === p).length, 1);

  // Subsequent damage while dead must be ignored
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(c.MODES.tdm.enemyScore, 1, 'enemy score must not increment on dead player hit');
  assert.strictEqual(hostile.kills, 1, 'hostile kills must not increment on dead player hit');
  assert.strictEqual(p.deaths, 1, 'player deaths must not increment on dead player hit');
  assert.strictEqual(c.modeRespawnQueue.filter(e => e.actor === p).length, 1, 'modeRespawnQueue must not duplicate player entry');
});

test('TDM player death reaching score limit ends match and never subsequently respawns', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  c.MODES.tdm.targetScore = 1;

  const p = c.player;
  p.spawnProtectionT = 0;
  const hostile = c.enemies.find(e => e.team === 'enemy');

  c.damagePlayer(10000, 0, 'bullet', hostile);
  c.damagePlayer(10000, 0, 'bullet', hostile);

  assert.strictEqual(c.MODES.tdm.enemyScore, 1, 'enemyScore must reach targetScore (1)');
  assert.strictEqual(c.MODES.tdm.isOver(), true, 'isOver must be true when enemy reaches targetScore');
  assert.strictEqual(c.gameEnded, true, 'gameEnded must be true on match completion');
  assert.strictEqual(c.modeRespawnQueue.some(e => e.actor === p), false, 'modeRespawnQueue must not queue player into ended match');

  // Update mode respawns over time: player must NEVER respawn
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.1);
  assert.strictEqual(p.dead, true, 'player must remain dead after match end and never subsequently respawn');
});

test('TDM attribution: grenade owner, environmental fall, and self deaths are deterministic without spurious credit', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  const p = c.player;
  p.spawnProtectionT = 0;

  // 1. Fall damage (attacker absent/null)
  c.damagePlayer(10000, undefined, 'fall', null);
  c.damagePlayer(10000, undefined, 'fall', null);
  assert.strictEqual(p.dead, true);
  assert.strictEqual(p.deaths, 1, 'fall death must increment player death count');
  assert.strictEqual(c.MODES.tdm.enemyScore, 0, 'fall death must NOT award enemy team score');
  assert.strictEqual(c.MODES.tdm.friendlyScore, 0, 'fall death must NOT award friendly team score');

  // Respawn player
  p.dead = false;
  p.health = 100;
  p.spawnProtectionT = 0;

  // 2. Self grenade damage (owner is player)
  c.damagePlayer(10000, 0, 'blast', p);
  c.damagePlayer(10000, 0, 'blast', p);
  assert.strictEqual(p.dead, true);
  assert.strictEqual(p.deaths, 2, 'suicide death must increment player death count');
  assert.strictEqual(c.MODES.tdm.enemyScore, 0, 'self blast must NOT award enemy team score');
  assert.strictEqual(c.MODES.tdm.friendlyScore, 0, 'self blast must NOT award friendly team score');

  // Respawn player
  p.dead = false;
  p.health = 100;
  p.spawnProtectionT = 0;

  // 3. Enemy grenade blast (owner is hostile)
  const hostile = c.enemies.find(e => e.team === 'enemy');
  c.damagePlayer(10000, 0, 'blast', hostile);
  c.damagePlayer(10000, 0, 'blast', hostile);
  assert.strictEqual(p.dead, true);
  assert.strictEqual(p.deaths, 3, 'hostile grenade death must increment player deaths');
  assert.strictEqual(c.MODES.tdm.enemyScore, 1, 'hostile grenade death must increment enemy score');
  assert.strictEqual(hostile.kills, 1, 'hostile grenade death must increment killer kills');
});

test('TDM stable match roster and scoreboard retains participants through death and respawn without duplicate or lost rows', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  const initialSb = c.MODES.tdm.scoreboard();
  assert.strictEqual(initialSb.friendlyTeam.members.length, 6, 'friendly roster must start with 6 members (player + 5 bots)');
  assert.strictEqual(initialSb.enemyTeam.members.length, 6, 'enemy roster must start with 6 members');

  // Kill an enemy bot
  const hostileBot = c.enemies.find(e => e.team === 'enemy');
  hostileBot.spawnProtectionT = 0;
  c.damageEnemy(hostileBot, 300, hostileBot.pos, false, false, 'AR', c.player);
  assert.strictEqual(hostileBot.dead, true);

  // updateEnemies drops corpse from enemies array
  c.updateEnemies(1 / 60);
  assert.strictEqual(c.enemies.includes(hostileBot), false, 'dead hostile must be dropped from lexical enemies');

  // Scoreboard requirement: dead bot removed by updateEnemies must STILL appear on scoreboard!
  const midSb = c.MODES.tdm.scoreboard();
  assert.strictEqual(midSb.enemyTeam.members.length, 6, 'dead bot must NOT be lost from scoreboard while waiting to respawn');
  const deadRow = midSb.enemyTeam.members.find(m => m.id === hostileBot.id);
  assert.ok(deadRow, 'dead hostile row must still exist in scoreboard');
  assert.strictEqual(deadRow.deaths, 1, 'dead hostile row must show 1 death');

  // Respawn bot
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.0);
  c.MODES.tdm.update(1.1);
  assert.strictEqual(hostileBot.dead, false, 'hostile must be revived');
  assert.strictEqual(c.enemies.includes(hostileBot), true, 'revived hostile must reenter enemies');

  // Scoreboard after respawn: exact same roster size, no duplicate row
  const postSb = c.MODES.tdm.scoreboard();
  assert.strictEqual(postSb.enemyTeam.members.length, 6, 'scoreboard must retain exactly 6 enemies, no duplicate row');
  const postRows = postSb.enemyTeam.members.filter(m => m.id === hostileBot.id);
  assert.strictEqual(postRows.length, 1, 'hostile bot must appear exactly once in scoreboard');

  // Reset / quit to menu clears match roster
  c.quitMatchToMenu();
  assert.strictEqual(c.MODES.tdm.roster.length, 0, 'match roster must clear on menu return');
});

test('Survival mode lifecycle remains completely intact without match immunities or score leakage', () => {
  const c = createFullMatchContext();
  c.setActiveMode('survival');
  c.MODES.survival.setup();

  const p = c.player;
  assert.strictEqual(p.spawnProtectionT, 0, 'player must have 0 spawn protection in Survival deploy');

  // Second Wind perk allows revive
  c.perks.push('wind');
  c.damagePlayer(10000, 0, 'bullet', { team: 'enemy' });
  assert.strictEqual(p.downed, false, 'second wind consumes perk and revives player');
  assert.strictEqual(p.health, CORE.DOWN_REVIVE_HEALTH, 'revived health must be DOWN_REVIVE_HEALTH');
  assert.strictEqual(c.perks.includes('wind'), false, 'second wind must be consumed');

  // Next lethal hit downs player
  c.damagePlayer(10000, 0, 'bullet', { team: 'enemy' });
  assert.strictEqual(p.downed, true, 'lethal hit without second wind downs player');

  // Wave clear revives from down
  c.reviveFromDown();
  assert.strictEqual(p.downed, false, 'reviveFromDown clears down');
  assert.strictEqual(p.health, CORE.DOWN_REVIVE_HEALTH);

  // Lethal hit and bleedout in Survival
  c.damagePlayer(10000, 0, 'bullet', { team: 'enemy' });
  assert.strictEqual(p.downed, true);
  c.updateDowned(10.1);
  assert.strictEqual(p.dead, true, 'bleedout in survival kills player');
  assert.strictEqual(c.modeRespawnQueue.length, 0, 'survival player death must NOT queue mode respawn');
  assert.strictEqual(c.MODES.survival.scoreboard().wave, 0, 'survival scoreboard reflects survival stats');
});

test('pause safety: match timer, respawn queue, and spawn protection do not elapse while paused', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  const p = c.player;
  p.spawnProtectionT = 2.0;
  const initialTime = c.MODES.tdm.timeLeft;

  const dummyActor = { id: 'bot_test', dead: true };
  c.queueModeRespawn(dummyActor, 3.0);
  assert.strictEqual(c.modeRespawnQueue.length, 1);

  // Pause game
  c.paused = true;

  // Step while paused
  c.MODES.tdm.update(1.0);
  c.updateModeRespawns(1.0, c.spawnPoints, c.enemies, c.colliders);
  c.updatePlayer(1.0);

  assert.strictEqual(c.MODES.tdm.timeLeft, initialTime, 'timeLeft must NOT decrement while paused');
  assert.strictEqual(c.modeRespawnQueue[0].timer, 3.0, 'respawn timer must NOT decrement while paused');
  assert.strictEqual(p.spawnProtectionT, 2.0, 'spawn protection must NOT decrement while paused');
});

test('reset attribution across respawn, restart, and mode switch', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  const p = c.player;
  p.spawnProtectionT = 0;
  const hostile = c.enemies.find(e => e.team === 'enemy');

  // Take non-lethal hit from hostile
  c.damagePlayer(25, 0, 'bullet', hostile);
  assert.strictEqual(p.lastAttacker, hostile, 'damagePlayer must record lastAttacker');

  // Restart match clears attribution
  c.restartMatch();
  assert.strictEqual(p.lastAttacker, null, 'restartMatch must reset player lastAttacker');
  assert.strictEqual(p.downedBy, null, 'restartMatch must reset player downedBy');

  // Switch to Survival and back
  c.setActiveMode('survival');
  c.MODES.survival.setup();
  assert.strictEqual(p.lastAttacker, null, 'survival setup must reset player lastAttacker');
  assert.strictEqual(p.downedBy, null, 'survival setup must reset player downedBy');
});

function createRealRigContext() {
  const ctx = {
    console, Math, Float32Array,
    TEX: { camo: { map: null, normalMap: null }, paint: { map: null }, bloodSplat: null },
    runDifficulty: 'regular',
    endlessMode: false,
    runPhase: 'active',
    weaponsOwned: [0, -1],
    wState: [{}, {}],
    initWeapons: noop,
    refreshWeaponStats: noop,
    openDistrict: noop,
    equippedLethal: 'frag',
    equippedTactical: 'smoke',
    tacticalCount: 2,
    fieldCharge: 0,
    streakBank: [],
    streakKills: 0,
    curWeapon: 0,
    buildViewmodel: noop,
    showWaveBanner: noop,
    updateWaves: dt => {
      if (c.betweenWaveT > 0) {
        c.betweenWaveT -= dt;
        if (c.betweenWaveT <= 0) c.waveActive = true;
      }
    },
    waveActive: false,
    betweenWaveT: 3,
    plates: 0,
    gameT: 0,
    IS_TOUCH: false,
    SETTINGS: {},
    CFG: {
      grenade: { radius: 6 },
      player: { height: 1.7 },
      score: { kill: 100, headshot: 50 },
      wave: { startDelay: 3 },
      ai: { maxHealth: 100 }
    },
    player: { pos: { x: 0, y: 1.7, z: 0 }, team: 'friendly' },
    colliders: [],
    enemies: [],
    CORE: CORE,
    diff: () => ({ hp: 1 }),
    eyeHeight: () => 1.7
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../vendor/three-bundle.min.js'), 'utf8'), ctx);
  ctx.scene = new ctx.THREE.Scene();
  vm.runInContext(source('01_core.js'), ctx);
  vm.runInContext(source('38_soldier.js'), ctx);
  vm.runInContext(source('40_enemies.js'), ctx);
  vm.runInContext(source('45_ragdoll.js'), ctx);
  vm.runInContext(source('35_modes.js'), ctx);
  return ctx;
}

test('regression [P1]: bot respawn rebuilds live rig and isolates from ragdoll retirement for detailed and simple models', () => {
  const c = createRealRigContext();

  // 1. Detailed soldier model
  const sd = c.buildSoldier(1, 'enemy');
  const detailedBot = {
    kind: 1,
    team: 'enemy',
    maxHealth: 100,
    health: 100,
    dead: false,
    pos: new c.THREE.Vector3(0, 0, 10),
    vel: new c.THREE.Vector3(0, 0, 0),
    parts: {
      group: sd.group, body: sd.group, J: sd.J,
      hitBody: sd.hitBody, hitHead: sd.hitHead, hitLegs: sd.hitLegs,
      soldier: true, gun: sd.gun, iff: sd.iff
    }
  };
  detailedBot.hitBody = sd.hitBody;
  detailedBot.hitHead = sd.hitHead;
  detailedBot.hitBody.userData = { enemyRef: detailedBot, isHead: false };
  detailedBot.hitHead.userData = { enemyRef: detailedBot, isHead: true };
  c.scene.add(detailedBot.parts.group);

  let detailedMeshesBefore = 0;
  let detailedSkinnedBefore = 0;
  detailedBot.parts.group.traverse(o => {
    if (o.isMesh) detailedMeshesBefore++;
    if (o.isSkinnedMesh) detailedSkinnedBefore++;
  });
  assert.strictEqual(detailedMeshesBefore, 17, 'detailed soldier must start with 17 meshes');
  assert.strictEqual(detailedSkinnedBefore, 14, 'detailed soldier must start with 14 skinned meshes');
  assert.strictEqual(detailedBot.parts.group.getObjectByName('hitBody') !== undefined, true, 'hitBody must be under group before death');

  // Trigger death and ragdoll
  c.spawnRagdoll(detailedBot, { node: 'chest', x: 0, y: 1, z: 2 });
  detailedBot.dead = true;
  let detailedMeshesAfterDeath = 0;
  detailedBot.parts.group.traverse(o => { if (o.isMesh) detailedMeshesAfterDeath++; });
  assert.strictEqual(detailedMeshesAfterDeath, 0, 'bones and skinned meshes reparented to corpse container leaving 0 in group');
  assert.strictEqual(detailedBot.parts.group.getObjectByName('hitBody') !== undefined, false, 'hitBody no longer under group during death');

  // Respawn detailed bot
  c.defaultOnRespawn(detailedBot, [5, 15]);
  assert.strictEqual(detailedBot.dead, false, 'bot.dead must be cleared on respawn');

  let detailedMeshesAfterRespawn = 0;
  let detailedSkinnedAfterRespawn = 0;
  detailedBot.parts.group.traverse(o => {
    if (o.isMesh) detailedMeshesAfterRespawn++;
    if (o.isSkinnedMesh) detailedSkinnedAfterRespawn++;
  });
  assert.strictEqual(detailedMeshesAfterRespawn, 17, 'respawned bot must have live rig rebuilt with 17 meshes');
  assert.strictEqual(detailedSkinnedAfterRespawn, 14, 'respawned bot must have 14 skinned meshes');
  assert.strictEqual(detailedBot.parts.group.getObjectByName('hitBody') !== undefined, true, 'hitBody must be restored under group');
  assert.strictEqual(detailedBot.hitBody.userData.enemyRef, detailedBot, 'hitBody userData must point to respawned bot');
  assert.strictEqual(detailedBot.parts.group.parent, c.scene, 'rebuilt rig must be in scene');

  // Subsequent corpse cleanup must NOT remove or dispose the respawned bot's group
  c.resetRagdolls();
  assert.strictEqual(detailedBot.parts.group.parent, c.scene, 'corpse retirement must NOT remove live respawned bot from scene');
  let meshesAfterCorpseCleanup = 0;
  detailedBot.parts.group.traverse(o => { if (o.isMesh) meshesAfterCorpseCleanup++; });
  assert.strictEqual(meshesAfterCorpseCleanup, 17, 'corpse retirement must leave respawned bot meshes intact');

  // 2. Simple box-man model
  const simpleParts = c.makeEnemyMesh(1, 'enemy');
  const simpleBot = {
    kind: 1,
    team: 'enemy',
    maxHealth: 100,
    health: 100,
    dead: false,
    pos: new c.THREE.Vector3(0, 0, 10),
    vel: new c.THREE.Vector3(0, 0, 0),
    parts: simpleParts
  };
  simpleBot.hitBody = simpleParts.hitBody;
  simpleBot.hitHead = simpleParts.hitHead;
  simpleBot.hitBody.userData = { enemyRef: simpleBot, isHead: false };
  simpleBot.hitHead.userData = { enemyRef: simpleBot, isHead: true };
  c.scene.add(simpleBot.parts.group);

  let simpleMeshesBefore = 0;
  simpleBot.parts.group.traverse(o => { if (o.isMesh) simpleMeshesBefore++; });
  assert.ok(simpleMeshesBefore > 0);

  c.spawnRagdoll(simpleBot, { node: 'chest', x: 0, y: 1, z: 2 });
  simpleBot.dead = true;

  c.defaultOnRespawn(simpleBot, [-5, 20]);
  assert.strictEqual(simpleBot.dead, false);

  let simpleMeshesAfterRespawn = 0;
  simpleBot.parts.group.traverse(o => { if (o.isMesh) simpleMeshesAfterRespawn++; });
  assert.strictEqual(simpleMeshesAfterRespawn, simpleMeshesBefore, 'simple bot must restore all meshes after respawn');
  assert.strictEqual(simpleBot.parts.group.parent, c.scene, 'simple bot rig must be in scene');

  c.resetRagdolls();
  assert.strictEqual(simpleBot.parts.group.parent, c.scene, 'simple bot rig must remain in scene after corpse cleanup');
});

test('regression [P1]: restartMatch initializes TDM once and is idempotent without duplicate bots or roster desync', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  // First restart
  c.restartMatch();
  assert.strictEqual(c.enemies.length, 11, 'enemies roster must contain exactly 11 bots after first restart');
  const friendlyCount1 = c.enemies.filter(e => e.team === 'friendly').length;
  const enemyCount1 = c.enemies.filter(e => e.team === 'enemy').length;
  assert.strictEqual(friendlyCount1, 5, 'must have exactly 5 friendly bots');
  assert.strictEqual(enemyCount1, 6, 'must have exactly 6 enemy bots');

  const sb1 = c.MODES.tdm.scoreboard();
  assert.strictEqual(sb1.friendlyTeam.members.length, 6, 'scoreboard must have 6 friendly members');
  assert.strictEqual(sb1.enemyTeam.members.length, 6, 'scoreboard must have 6 enemy members');

  // Repeated restarts must NOT duplicate bots (Chromium reproduced 22 active bots)
  c.restartMatch();
  c.restartMatch();
  assert.strictEqual(c.enemies.length, 11, 'enemies roster must remain exactly 11 bots after repeated restarts');
  const friendlyCountRepeated = c.enemies.filter(e => e.team === 'friendly').length;
  const enemyCountRepeated = c.enemies.filter(e => e.team === 'enemy').length;
  assert.strictEqual(friendlyCountRepeated, 5, 'must maintain exactly 5 friendly bots after repeated restarts');
  assert.strictEqual(enemyCountRepeated, 6, 'must maintain exactly 6 enemy bots after repeated restarts');

  // Actor identity correspondence: every bot in enemies must exist in scoreboard roster
  const sbRepeated = c.MODES.tdm.scoreboard();
  assert.strictEqual(sbRepeated.friendlyTeam.members.length, 6);
  assert.strictEqual(sbRepeated.enemyTeam.members.length, 6);
  for (const bot of c.enemies) {
    const list = (bot.team === 'friendly') ? sbRepeated.friendlyTeam.members : sbRepeated.enemyTeam.members;
    assert.ok(list.some(m => m.id === bot.id), 'bot ' + bot.id + ' must correspond to scoreboard roster row');
  }
});

test('regression [P1]: match completion freezes match combat and rejects late damage/kill callbacks after settlement', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  c.MODES.tdm.targetScore = 1;

  const hostile = c.enemies.find(e => e.team === 'enemy');
  const ally = c.enemies.find(e => e.team === 'friendly');
  hostile.spawnProtectionT = 0;
  ally.spawnProtectionT = 0;
  c.player.spawnProtectionT = 0;

  // Player scores the winning kill (1-0 VICTORY)
  c.damageEnemy(hostile, 200, hostile.pos, false, false, 'AR', c.player);
  assert.strictEqual(c.MODES.tdm.friendlyScore, 1, 'friendly score must reach 1');
  assert.strictEqual(c.MODES.tdm.enemyScore, 0, 'enemy score must be 0');
  assert.strictEqual(c.gameEnded, true, 'gameEnded must be true after match victory');

  const titleEl = c.$id('match-end-title');
  assert.strictEqual(titleEl.textContent, 'VICTORY', 'end screen title must be VICTORY');

  // Subsequent frame updates must freeze combat systems
  if (typeof c.updateFrame === 'function') {
    c.updateFrame(100);
    c.updateFrame(200);
  }

  // Late delayed impact: another hostile attacks ally and player after settlement
  const anotherHostile = c.enemies.find(e => e.team === 'enemy' && !e.dead);
  c.damagePlayer(500, 0, 'blast', anotherHostile);
  assert.strictEqual(c.player.dead, false, 'late damage to player after settlement must be rejected');

  c.damageEnemy(ally, 500, ally.pos, false, false, 'AR', anotherHostile);
  assert.strictEqual(ally.dead, false, 'late damage to ally after settlement must be rejected');

  // Direct late call to onKill must be rejected
  c.MODES.tdm.onKill(ally, false, anotherHostile);
  assert.strictEqual(c.MODES.tdm.enemyScore, 0, 'late onKill must NOT increment enemy score');
  assert.strictEqual(c.MODES.tdm.friendlyScore, 1, 'friendly score must remain 1');
  assert.strictEqual(titleEl.textContent, 'VICTORY', 'end screen title must NOT change to DRAW or DEFEAT');
});

test('regression [P1]: resumeRun selects Survival before resetGame across menu mode switch, including victory and endless checkpoints', () => {
  const c = createFullMatchContext();

  // 1. Regular Survival wave 3 checkpoint
  c.saveCheckpoint({
    wave: 2,
    score: 6400,
    kills: 10,
    headshots: 5,
    shotsFired: 50,
    shotsHit: 30,
    health: 100,
    armor: 50,
    grenades: 2,
    difficulty: 1,
    endless: false,
    runPhase: 'active',
    weapons: [{ gi: 0, ammo: 30, reserve: 90 }],
    equipment: { lethal: 'frag', tactical: 'smoke', tacticalCount: 2, fieldCharge: 0, streakBank: [] }
  });

  // Player enters loadout menu, selects TDM
  c.setActiveMode('tdm');
  assert.strictEqual(c.activeModeId, 'tdm');

  // Player backs out and clicks RESUME
  c.resumeRun();
  assert.strictEqual(c.activeModeId, 'survival', 'resumeRun must select Survival before resetGame');
  assert.strictEqual(c.enemies.length, 0, 'Survival run must have 0 initial TDM bots');
  assert.strictEqual(c.MODES.tdm.roster.length, 0, 'TDM roster must be cleared on resume');
  assert.strictEqual(c.score, 6400, 'score must be restored from checkpoint');

  // Waves must advance
  c.betweenWaveT = 0.1;
  c.MODES.survival.update(0.2);
  assert.strictEqual(c.waveActive, true, 'Survival wave must advance after resume');

  // 2. Victory checkpoint
  c.saveCheckpoint({
    wave: 14,
    score: 35000,
    kills: 50,
    headshots: 25,
    shotsFired: 200,
    shotsHit: 120,
    health: 100,
    armor: 50,
    grenades: 2,
    difficulty: 1,
    endless: false,
    runPhase: 'victory',
    settlementSnapshot: {},
    weapons: [{ gi: 0, ammo: 30, reserve: 90 }],
    equipment: { lethal: 'frag', tactical: 'smoke', tacticalCount: 2, fieldCharge: 0, streakBank: [] }
  });
  c.setActiveMode('tdm');
  c.resumeRun();
  assert.strictEqual(c.activeModeId, 'survival', 'victory checkpoint resume must select Survival');
  assert.strictEqual(c.gameEnded, true, 'victory checkpoint resume must preserve settled gameEnded');
  assert.strictEqual(c.enemies.length, 0, 'victory checkpoint resume must not spawn TDM bots');

  // 3. Endless checkpoint
  c.saveCheckpoint({
    wave: 18,
    score: 55000,
    kills: 70,
    headshots: 35,
    shotsFired: 300,
    shotsHit: 180,
    health: 100,
    armor: 50,
    grenades: 2,
    difficulty: 1,
    endless: true,
    runPhase: 'endless',
    weapons: [{ gi: 0, ammo: 30, reserve: 90 }],
    equipment: { lethal: 'frag', tactical: 'smoke', tacticalCount: 2, fieldCharge: 0, streakBank: [] }
  });
  c.setActiveMode('tdm');
  c.resumeRun();
  assert.strictEqual(c.activeModeId, 'survival', 'endless checkpoint resume must select Survival');
  assert.strictEqual(c.endlessMode, true, 'endlessMode must be restored');
  assert.strictEqual(c.enemies.length, 0, 'endless checkpoint resume must not spawn TDM bots');
});

test('regression [P2]: sentry targets nearest hostile and ignores closer friendly teammates', () => {
  const c = createFullMatchContext();
  c.spawnTracer = noop;
  c.playSound3D = noop;
  c.fxMuzzle = noop;
  c.flashLight = noop;
  vm.runInContext(source('58_streaks.js'), c);

  c.deploySentry();
  const sentries = vm.runInContext('sentries', c);
  assert.strictEqual(sentries.length, 1, 'sentry must be deployed');
  const sentry = sentries[0];
  sentry.m.position.set(0, 0, 0);

  // Friendly ally closer at z = 5
  const ally = {
    team: 'friendly',
    dead: false,
    health: 100,
    maxHealth: 100,
    pos: new Vector3(0, 0, 5),
    yaw: 0,
    kind: 0
  };
  // Hostile further away at z = 10
  const hostile = {
    team: 'enemy',
    dead: false,
    health: 135,
    maxHealth: 135,
    pos: new Vector3(0, 0, 10),
    yaw: 0,
    kind: 1
  };
  c.enemies.length = 0;
  c.enemies.push(ally, hostile);

  // Update sentry
  sentry.cd = 0;
  c.updateSentries(0.1);

  // Hostile must take damage; ally must NOT take damage
  assert.strictEqual(ally.health, 100, 'closer ally must NOT take sentry damage or block sentry');
  assert.strictEqual(hostile.health, 113, 'hostile must take sentry damage from 135 to 113');
});

test('regression [P2]: respawn scoring builds per-entry candidate list of opponents and includes live player when hostile', () => {
  const c = createFullMatchContext();

  const spawnPoints = [[0, 15], [0, -15]];
  const hostile = {
    team: 'enemy',
    dead: false,
    pos: new Vector3(0, 0, 0),
    yaw: 0 // facing towards [0, 15]
  };
  const ally = {
    team: 'friendly',
    dead: false,
    pos: new Vector3(0, 0, -10),
    yaw: 0
  };
  c.enemies.length = 0;
  c.enemies.push(hostile, ally);

  // 1. Friendly bot respawn: hostile facing [0, 15] gives sightline penalty, ally behind must not repel [0, -15]
  const respawningAlly = {
    id: 'ally_test',
    team: 'friendly',
    dead: true,
    pos: new Vector3(0, 0, 0)
  };
  c.clearModeRespawns();
  c.queueModeRespawn(respawningAlly, 0);

  let chosenPointAlly = null;
  c.updateModeRespawns(0.1, spawnPoints, c.enemies, c.colliders, (actor, pt) => {
    chosenPointAlly = pt;
  });

  assert.ok(chosenPointAlly, 'spawn point must be chosen');
  assert.deepStrictEqual(chosenPointAlly, [0, -15], 'friendly bot must select safe point [0, -15] scoring 35 over sightline point [0, 15]');

  // 2. Enemy bot respawn: live player facing [0, 15] must be included in scoring candidates
  const enemyAlly = {
    team: 'enemy',
    dead: false,
    pos: new Vector3(0, 0, -10),
    yaw: 0
  };
  c.enemies.length = 0;
  c.enemies.push(enemyAlly);

  c.player.team = 'friendly';
  c.player.dead = false;
  c.player.pos.set(0, 1.7, 0);
  c.player.yaw = 0; // facing towards [0, 15]

  const respawningEnemy = {
    id: 'enemy_test',
    team: 'enemy',
    dead: true,
    pos: new Vector3(0, 0, 0)
  };
  c.clearModeRespawns();
  c.queueModeRespawn(respawningEnemy, 0);

  let chosenPointEnemy = null;
  c.updateModeRespawns(0.1, spawnPoints, c.enemies, c.colliders, (actor, pt) => {
    chosenPointEnemy = pt;
  });

  assert.ok(chosenPointEnemy, 'spawn point must be chosen for enemy');
  assert.deepStrictEqual(chosenPointEnemy, [0, -15], 'enemy bot must include hostile player and select [0, -15]');
});

test('regression [P2]: saved gameMode restores into activeModeId and survives reload/deploy', () => {
  const c = createFullMatchContext();
  vm.runInContext(source('02_settings.js'), c);

  // 1. Saved gameMode = 'tdm'
  vm.runInContext('SETTINGS.gameMode = "tdm"', c);
  c.applySetting('gameMode');
  assert.strictEqual(c.activeModeId, 'tdm', 'activeModeId must be restored to tdm when saved');

  // Build mode picker row
  c.buildModePickerRow();
  const tdmBtn = c.$id('mode-btn-tdm');
  assert.ok(tdmBtn && tdmBtn.className.includes('on'), 'TDM button must have on class when saved mode is tdm');

  // 2. applySetting must NOT switch mode unexpectedly while match is active
  c.started = true;
  c.gameEnded = false;
  vm.runInContext('SETTINGS.gameMode = "survival"', c);
  c.applySetting('gameMode');
  assert.strictEqual(c.activeModeId, 'tdm', 'applySetting must not change activeModeId while match is actively playing');

  // 3. Saved gameMode = 'survival'
  c.started = false;
  c.applySetting('gameMode');
  assert.strictEqual(c.activeModeId, 'survival', 'activeModeId must switch to survival when not actively playing');
  c.buildModePickerRow();
  const survBtn = c.$id('mode-btn-survival');
  assert.ok(survBtn && survBtn.className.includes('on'), 'Survival button must have on class when saved mode is survival');
});

test('regression [P0]: corpse and live-rig resource ownership isolates lifecycles across respawn, budget retirement, and repeated cycles', () => {
  const c = createRealRigContext();

  // Test Case 1: Simple body with cloned-tint material (kind 3 shielded hostile)
  // Death -> respawn before corpse retirement -> corpse retirement releases OLD private resources exactly once
  // Shared template resources stay alive, live actor meshes/hitboxes remain in scene intact.
  const parts1 = c.makeEnemyMesh(3, 'enemy');
  const tint = new c.THREE.Color(0x4a6fa5);
  parts1.group.traverse(o => {
    if (o.isMesh && o !== parts1.hitBody && o !== parts1.hitHead && o.material) {
      o.material = o.material.clone();
      o.material.color.lerp(tint, 0.55);
      o.userData.clonedTint = true;
    }
  });

  const oldGeos1 = new Set();
  let oldGeoDisposes1 = 0;
  const oldMats1 = new Set();
  let oldMatDisposes1 = 0;
  parts1.group.traverse(o => {
    if (o.geometry) oldGeos1.add(o.geometry);
    if (o.userData && o.userData.clonedTint && o.material) oldMats1.add(o.material);
  });
  assert.strictEqual(oldGeos1.size, 12, 'simple bot must have 12 unique geometries');
  assert.ok(oldMats1.size > 0, 'tinted bot must have cloned materials');
  for (const g of oldGeos1) g.addEventListener('dispose', () => oldGeoDisposes1++);
  for (const m of oldMats1) m.addEventListener('dispose', () => oldMatDisposes1++);

  const bot1 = {
    kind: 3, team: 'enemy', maxHealth: 100, health: 100, dead: false,
    pos: new c.THREE.Vector3(0, 0, 10), vel: new c.THREE.Vector3(),
    parts: parts1, hitBody: parts1.hitBody, hitHead: parts1.hitHead
  };
  c.scene.add(parts1.group);

  // Bot dies -> ragdoll spawned
  c.spawnRagdoll(bot1, { node: 'chest', x: 0, y: 1, z: 2 });
  bot1.dead = true;

  // Respawn before corpse retirement
  c.defaultOnRespawn(bot1, [5, 15]);
  assert.strictEqual(bot1.dead, false, 'bot must be alive after respawn');
  const liveParts1 = bot1.parts;
  assert.notStrictEqual(liveParts1, parts1, 'respawned bot must have a new rig, not the old rig');
  assert.strictEqual(liveParts1.group.parent, c.scene, 'new live rig must be in scene');

  const liveGeos1 = new Set();
  let liveGeoDisposes1 = 0;
  const liveMats1 = new Set();
  let liveMatDisposes1 = 0;
  liveParts1.group.traverse(o => {
    if (o.geometry) liveGeos1.add(o.geometry);
    if (o.userData && o.userData.clonedTint && o.material) liveMats1.add(o.material);
  });
  for (const g of liveGeos1) g.addEventListener('dispose', () => liveGeoDisposes1++);
  for (const m of liveMats1) m.addEventListener('dispose', () => liveMatDisposes1++);

  // Verify that live and old resources do NOT overlap
  for (const g of liveGeos1) {
    assert.strictEqual(oldGeos1.has(g), false, 'live geometry must not be part of old geometries');
  }

  // Now corpse retires via resetRagdolls (or budget)
  c.resetRagdolls();

  // OLD private resources must be released exactly once
  assert.strictEqual(oldGeoDisposes1, oldGeos1.size, 'all 12 old geometries must be disposed exactly once on corpse retirement');
  assert.strictEqual(oldMatDisposes1, oldMats1.size, 'all old cloned materials must be disposed on corpse retirement');

  // NEW live resources must NOT be disposed, reparented, or removed
  assert.strictEqual(liveGeoDisposes1, 0, 'new live geometries must NOT be disposed');
  assert.strictEqual(liveMatDisposes1, 0, 'new live materials must NOT be disposed');
  assert.strictEqual(liveParts1.group.parent, c.scene, 'live rig must remain in scene');
  assert.ok(liveParts1.hitBody && liveParts1.hitBody.parent, 'live hitBody must remain in rig');
  assert.ok(liveParts1.hitHead && liveParts1.hitHead.parent, 'live hitHead must remain in rig');

  // Test Case 2: Detailed soldier bot
  // Skeletons are privately owned per-clone; template geometries and materials are shared
  const sd = c.buildSoldier(1, 'enemy');
  const oldSkeletons = (sd.group.userData.skeletons || []).slice();
  assert.ok(oldSkeletons.length > 0, 'detailed soldier must have per-clone skeletons');
  let oldSkeletonDisposes = 0;
  for (const sk of oldSkeletons) {
    const origDispose = sk.dispose;
    sk.dispose = function () {
      oldSkeletonDisposes++;
      return origDispose.apply(this, arguments);
    };
  }
  const detailedBot = {
    kind: 1, team: 'enemy', maxHealth: 100, health: 100, dead: false,
    pos: new c.THREE.Vector3(0, 0, 10), vel: new c.THREE.Vector3(),
    parts: {
      group: sd.group, body: sd.group, J: sd.J,
      hitBody: sd.hitBody, hitHead: sd.hitHead, hitLegs: sd.hitLegs,
      soldier: true, gun: sd.gun, iff: sd.iff
    }
  };
  c.scene.add(detailedBot.parts.group);

  // Template buffer geometries must NOT be disposed
  const templateGeos = new Set();
  let templateGeoDisposes = 0;
  detailedBot.parts.group.traverse(o => { if (o.isSkinnedMesh && o.geometry) templateGeos.add(o.geometry); });
  for (const g of templateGeos) g.addEventListener('dispose', () => templateGeoDisposes++);

  c.spawnRagdoll(detailedBot, { node: 'chest', x: 0, y: 1, z: 2 });
  detailedBot.dead = true;

  c.defaultOnRespawn(detailedBot, [5, 15]);
  const liveDetailedParts = detailedBot.parts;
  const liveSkeletons = (liveDetailedParts.group.userData.skeletons || []).slice();
  let liveSkeletonDisposes = 0;
  for (const sk of liveSkeletons) {
    const origDispose = sk.dispose;
    sk.dispose = function () {
      liveSkeletonDisposes++;
      return origDispose.apply(this, arguments);
    };
  }

  c.resetRagdolls();

  assert.strictEqual(oldSkeletonDisposes, oldSkeletons.length, 'old per-clone skeletons must be disposed exactly once');
  assert.strictEqual(templateGeoDisposes, 0, 'shared template geometries must NOT be disposed');
  assert.strictEqual(liveSkeletonDisposes, 0, 'new live skeletons must NOT be disposed');
  assert.strictEqual(liveDetailedParts.group.parent, c.scene, 'live detailed rig must remain in scene');

  // Test Case 3: Corpse retirement BEFORE respawn
  // Bot dies -> corpse settles and is retired -> then bot respawns
  const parts3 = c.makeEnemyMesh(1, 'enemy');
  const bot3 = {
    kind: 1, team: 'enemy', maxHealth: 100, health: 100, dead: false,
    pos: new c.THREE.Vector3(0, 0, 10), vel: new c.THREE.Vector3(),
    parts: parts3, hitBody: parts3.hitBody, hitHead: parts3.hitHead
  };
  c.scene.add(parts3.group);
  const geos3 = new Set();
  let geo3Disposes = 0;
  parts3.group.traverse(o => { if (o.geometry) geos3.add(o.geometry); });
  for (const g of geos3) g.addEventListener('dispose', () => geo3Disposes++);

  c.spawnRagdoll(bot3, { node: 'chest', x: 0, y: 1, z: 2 });
  bot3.dead = true;

  // Corpse retires BEFORE bot respawns
  c.resetRagdolls();
  assert.strictEqual(geo3Disposes, geos3.size, 'old corpse geometries must be disposed when corpse retires before respawn');

  // Bot now respawns
  c.defaultOnRespawn(bot3, [10, 10]);
  assert.strictEqual(bot3.dead, false);
  assert.ok(bot3.parts && bot3.parts.group, 'respawned bot must have rebuilt rig even after early corpse retirement');
  assert.strictEqual(bot3.parts.group.parent, c.scene, 'rebuilt rig must be added to scene');
  let meshesInScene3 = 0;
  bot3.parts.group.traverse(o => {
    if (o.isMesh) {
      meshesInScene3++;
      assert.strictEqual(geos3.has(o.geometry), false, 'mesh must not use disposed old geometry');
    }
  });
  assert.ok(meshesInScene3 > 0, 'respawned rig must contain meshes');

  // Test Case 4: Repeated death and respawn cycles (5 cycles)
  // Low-quality resource counts must remain strictly bounded without monotonic leaks
  const cyclicBot = {
    kind: 1, team: 'enemy', maxHealth: 100, health: 100, dead: false,
    pos: new c.THREE.Vector3(0, 0, 10), vel: new c.THREE.Vector3(),
    parts: c.makeEnemyMesh(1, 'enemy')
  };
  cyclicBot.hitBody = cyclicBot.parts.hitBody;
  cyclicBot.hitHead = cyclicBot.parts.hitHead;
  c.scene.add(cyclicBot.parts.group);

  let totalOldGeosCollected = 0;
  let totalOldGeosDisposed = 0;

  for (let cycle = 0; cycle < 5; cycle++) {
    const cycleGeos = new Set();
    cyclicBot.parts.group.traverse(o => { if (o.geometry) cycleGeos.add(o.geometry); });
    totalOldGeosCollected += cycleGeos.size;
    for (const g of cycleGeos) g.addEventListener('dispose', () => totalOldGeosDisposed++);

    c.spawnRagdoll(cyclicBot, { node: 'chest', x: 0, y: 1, z: 2 });
    cyclicBot.dead = true;

    c.defaultOnRespawn(cyclicBot, [cycle * 2, 0]);
    assert.strictEqual(cyclicBot.dead, false);
    assert.strictEqual(cyclicBot.parts.group.parent, c.scene);

    c.resetRagdolls();
  }

  assert.strictEqual(totalOldGeosDisposed, totalOldGeosCollected, 'all old cycle geometries must be disposed exactly once');
  assert.strictEqual(cyclicBot.parts.group.parent, c.scene, 'cyclic bot live rig must be in scene after 5 cycles');
});

test('regression [P1]: actual showMatchEndScreen and restartMatch lifecycle restarts audio consistently with settings and preserves TDM correctness', () => {
  const c = createFullMatchContext();
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();

  let musicStops = 0;
  let musicStarts = 0;
  let resets = 0;
  c.stopMusic = () => { musicStops++; };
  c.startMusic = () => { musicStarts++; };
  const origResetGame = c.resetGame;
  c.resetGame = function () {
    resets++;
    return origResetGame.apply(this, arguments);
  };

  // Complete a match (friendly victory 75 - 60)
  c.MODES.tdm.friendlyScore = 75;
  c.MODES.tdm.enemyScore = 60;
  c.gameEnded = true;

  // 1. showMatchEndScreen lifecycle: stops music and opens end screen
  c.showMatchEndScreen(c.MODES.tdm);
  assert.strictEqual(musicStops, 1, 'showMatchEndScreen must stop music');
  assert.strictEqual(musicStarts, 0, 'showMatchEndScreen must not start music');
  assert.strictEqual(resets, 0, 'showMatchEndScreen must not reset game');
  assert.strictEqual(c.$id('match-end-screen').style.display, 'flex', 'match-end-screen must be displayed');
  assert.strictEqual(c.$id('match-end-title').textContent, 'VICTORY', 'end screen title must be VICTORY');

  // 2. restartMatch lifecycle: restarts gameplay and restarts audio when enabled
  c.restartMatch();
  assert.strictEqual(musicStops, 1, 'music stops must remain 1 after restart');
  assert.strictEqual(resets, 1, 'game resets must be 1 after restart');
  assert.strictEqual(musicStarts, 1, 'end-screen restart must restart music when audio is enabled');
  assert.strictEqual(c.$id('match-end-screen').style.display, 'none', 'match-end-screen must be hidden');
  assert.strictEqual(c.started, true, 'started must be true after restart');
  assert.strictEqual(c.gameEnded, false, 'gameEnded must be false after restart');
  assert.strictEqual(c.paused, false, 'paused must be false after restart');

  // Roster and score correctness
  assert.strictEqual(c.getActiveMode().id, 'tdm', 'activeMode must remain tdm');
  assert.strictEqual(c.MODES.tdm.friendlyScore, 0, 'friendlyScore must reset to 0');
  assert.strictEqual(c.MODES.tdm.enemyScore, 0, 'enemyScore must reset to 0');
  assert.strictEqual(c.enemies.length, 11, 'enemies roster must have exactly 11 bots');
  assert.strictEqual(c.enemies.filter(e => e.team === 'friendly').length, 5, 'must have exactly 5 friendly bots');
  assert.strictEqual(c.enemies.filter(e => e.team === 'enemy').length, 6, 'must have exactly 6 enemy bots');
  assert.strictEqual(c.player.dead, false, 'player must not be dead');
  assert.strictEqual(c.player.lastAttacker, null, 'player lastAttacker must be null');
  assert.strictEqual(c.player.downedBy, null, 'player downedBy must be null');
  const sb = c.MODES.tdm.scoreboard();
  assert.strictEqual(sb.friendlyTeam.members.length, 6, 'scoreboard must have 6 friendly members');
  assert.strictEqual(sb.enemyTeam.members.length, 6, 'scoreboard must have 6 enemy members');

  // 3. Audio settings gating: avoid audio starting when disabled/muted
  // 3a. Muted audio
  musicStarts = 0;
  musicStops = 0;
  resets = 0;
  c.setSetting('muted', true);
  c.showMatchEndScreen(c.MODES.tdm);
  assert.strictEqual(musicStops, 1);
  c.restartMatch();
  assert.strictEqual(resets, 1);
  assert.strictEqual(musicStarts, 0, 'restartMatch must NOT start audio when muted is true');

  // 3b. Zero music volume
  musicStarts = 0;
  musicStops = 0;
  resets = 0;
  c.setSetting('muted', false);
  c.setSetting('musicVolume', 0);
  c.showMatchEndScreen(c.MODES.tdm);
  assert.strictEqual(musicStops, 1);
  c.restartMatch();
  assert.strictEqual(resets, 1);
  assert.strictEqual(musicStarts, 0, 'restartMatch must NOT start audio when musicVolume is 0');

  // 3c. Zero master volume
  musicStarts = 0;
  musicStops = 0;
  resets = 0;
  c.setSetting('musicVolume', 0.5);
  c.setSetting('masterVolume', 0);
  c.showMatchEndScreen(c.MODES.tdm);
  assert.strictEqual(musicStops, 1);
  c.restartMatch();
  assert.strictEqual(resets, 1);
  assert.strictEqual(musicStarts, 0, 'restartMatch must NOT start audio when masterVolume is 0');

  // 3d. Audio re-enabled
  musicStarts = 0;
  musicStops = 0;
  resets = 0;
  c.setSetting('masterVolume', 0.9);
  c.showMatchEndScreen(c.MODES.tdm);
  assert.strictEqual(musicStops, 1);
  c.restartMatch();
  assert.strictEqual(resets, 1);
  assert.strictEqual(musicStarts, 1, 'restartMatch must restart music when audio settings are enabled');

  // 4. Button click integration: clicking btn-match-restart invokes real restartMatch
  musicStarts = 0;
  musicStops = 0;
  resets = 0;
  c.showMatchEndScreen(c.MODES.tdm);
  assert.strictEqual(musicStops, 1);
  c.$id('btn-match-restart').click();
  assert.strictEqual(resets, 1, 'clicking btn-match-restart must reset game');
  assert.strictEqual(musicStarts, 1, 'clicking btn-match-restart must restart music');
  assert.strictEqual(c.$id('match-end-screen').style.display, 'none');

  // 5. Idempotent restarts preserve mode and roster stability
  c.restartMatch();
  c.restartMatch();
  assert.strictEqual(c.getActiveMode().id, 'tdm');
  assert.strictEqual(c.enemies.length, 11, 'repeated restarts must not duplicate bots');
  assert.strictEqual(c.enemies.filter(e => e.team === 'friendly').length, 5);
  assert.strictEqual(c.enemies.filter(e => e.team === 'enemy').length, 6);
});

test('regression [P0]: combat damage and probe corpse lifecycle apply in Survival when player is dead and freeze only when match is settled', () => {
  const c = createRealRigContext();
  c.player.pos = new c.THREE.Vector3(0, 1.7, 0);
  c.player.dead = true;
  c.player.downed = false;
  c.player.health = 0;
  c.godMode = true;

  c.showHitmarker = noop;
  c.addCredits = noop;
  c.addFieldCharge = noop;
  c.spawnBlood = noop;
  c.playSound = noop;
  c.playSound3D = noop;
  c.addScore = noop;
  c.registerKillT = noop;
  c.registerStreakKill = noop;
  c.dropPowerUp = noop;
  c.dropPickup = noop;
  c.kills = 0;
  c.headshots = 0;
  c.navGrid = null;
  c.updateStatusEffects = noop;
  c.updateEnemyShadowBudget = noop;
  c.losFrame = 0;

  // 1. Survival mode with player dead: probe check 8 lifecycle (spawn 12 bots, damage each, updateEnemies)
  const step = 1 / 60;
  vm.runInContext(`
    for (const e of enemies) e.dead = true;
    enemies.length = 0;
    resetRagdolls();
    godMode = true;
    player.pos.set(0, CFG.player.height, 24);
    for (let i = 0; i < 12; i++) {
      spawnEnemy(1, -8 + i * 1.4, 30);
      const en = enemies[enemies.length - 1];
      en.pos.set(-8 + i * 1.4, 0, 30);
      en.parts.group.position.copy(en.pos);
      en.health = 1;
      damageEnemy(en, 200, new THREE.Vector3(en.pos.x, 1.2, en.pos.z + 0.3), false);
    }
  `, c);

  const enemies = vm.runInContext('enemies', c);
  assert.strictEqual(enemies.length, 12, '12 enemies must be spawned');
  for (let i = 0; i < 12; i++) {
    assert.strictEqual(enemies[i].dead, true, `enemy ${i} must be dead after damageEnemy even with player.dead=true`);
  }

  c.updateEnemies(step);
  const spawned = c.ragdollCount();
  const aiListCleared = vm.runInContext('enemies.length', c);
  const ragdollMax = vm.runInContext('RAGDOLL_MAX', c);
  assert.strictEqual(spawned, ragdollMax, 'ragdoll corpses must be capped at RAGDOLL_MAX');
  assert.strictEqual(aiListCleared, 0, 'all dead enemies must leave the AI list in updateEnemies');

  // 2. TDM match settlement: damage is rejected when match is settled/ended, but allowed while match is active
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  c.MODES.tdm.targetScore = 75;
  c.MODES.tdm.friendlyScore = 10;
  c.player.dead = false;

  const tdmEnemies = vm.runInContext('enemies', c);
  const tdmHostile = tdmEnemies.find(e => e.team === 'enemy');
  tdmHostile.spawnProtectionT = 0;
  const hpBefore = tdmHostile.health;
  c.damageEnemy(tdmHostile, 20, tdmHostile.pos, false, false, 'AR', c.player);
  assert.strictEqual(tdmHostile.health, hpBefore - 20, 'damage applies while TDM match is active');

  // When TDM is over (targetScore reached)
  c.MODES.tdm.friendlyScore = 75;
  assert.strictEqual(c.MODES.tdm.isOver(), true, 'TDM mode must be over when target score reached');
  c.damageEnemy(tdmHostile, 20, tdmHostile.pos, false, false, 'AR', c.player);
  assert.strictEqual(tdmHostile.health, hpBefore - 20, 'late damage must be rejected once TDM match is over');

  // When gameEnded is true
  c.setActiveMode('survival');
  c.gameEnded = true;
  const survEnemy = { team: 'enemy', pos: new c.THREE.Vector3(0, 0, 0), health: 100, dead: false, parts: { group: { position: { copy: noop } } } };
  c.damageEnemy(survEnemy, 20, survEnemy.pos, false);
  assert.strictEqual(survEnemy.health, 100, 'damage must be rejected when gameEnded is true');
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRealRigContext };
}








// ---- Milestone 2 review regressions: ally-aware assist targeting and match audio lifecycle ----

// Loads the intact production aim-assist/magnetism block from 30_weapons.js so the
// real candidate-selection loops run against the real CORE predicates.
function createWeaponsAssistContext(overrides = {}) {
  const weaponsSrc = source('30_weapons.js');
  const start = weaponsSrc.indexOf('const _aimTgt = new THREE.Vector3();');
  const end = weaponsSrc.indexOf('const _shotTargets = [];');
  assert.ok(start > -1 && end > start, '30_weapons.js assist range anchors must exist');
  const c = vm.createContext(Object.assign({
    CORE,
    THREE: { Vector3 },
    keys: {},
    player: { isPlayer: true, team: 'friendly', pos: new Vector3(0, 1.7, 0), dead: false },
    enemies: [],
    adsAmount: 1,
    steadyActive: false,
    CFG: { assist: { angle: 0.14, strength: 2.2, bulletAngle: 0.03, swayAmp: 0.0042, steadyMul: 0.14 } },
    curW: () => null,
    playSound: noop,
    Math: Object.create(Math)
  }, overrides));
  vm.runInContext(weaponsSrc.slice(start, end), c);
  // The sliced block declares adsAmount/steadyActive lexically, so set them after load.
  vm.runInContext('adsAmount = 1; steadyActive = false;', c);
  return c;
}

test('regression [P2]: aim assist and bullet magnetism never attract to friendly bots (ally-only and mixed candidate sets)', () => {
  const c = createWeaponsAssistContext();
  const from = new Vector3(0, 1.7, 0);
  const dir = new Vector3(0, 0, -1);

  // --- Ally-only candidate set: both systems must return the untouched direction ---
  const allyAssist = { id: 'allyA', team: 'friendly', kind: 1, dead: false, pos: new Vector3(-0.3, 0.7, -10) };
  c.enemies = [allyAssist];
  const assistAllyOnly = c.applyAimAssist(new Vector3(0, 0, -1), from);
  assert.strictEqual(assistAllyOnly.x, dir.x, 'ally-only aim assist must not pull the crosshair off-axis (x)');
  assert.strictEqual(assistAllyOnly.y, dir.y, 'ally-only aim assist must not pull the crosshair off-axis (y)');
  assert.strictEqual(assistAllyOnly.z, dir.z, 'ally-only aim assist must not pull the crosshair off-axis (z)');

  const allyMagnet = { id: 'allyM', team: 'friendly', kind: 1, dead: false, pos: new Vector3(-0.05, 0.6, -10) };
  c.enemies = [allyMagnet];
  const magnetDir = new Vector3(0, 0, -1);
  const magnetAllyOnly = c.magnetizeBullet(magnetDir, from);
  assert.strictEqual(magnetAllyOnly, magnetDir, 'ally-only bullet magnetism must return the original direction object unchanged');

  // --- Mixed candidate set: teammate is closer to the axis, hostile is the only legal target ---
  const allyMixed = { id: 'allyX', team: 'friendly', kind: 1, dead: false, pos: new Vector3(-0.3, 0.7, -10) };
  const hostileMixed = { id: 'hostileX', team: 'enemy', kind: 1, dead: false, pos: new Vector3(-1.5, 0.7, -30) };
  c.enemies = [allyMixed, hostileMixed];
  const toHostileChest = new Vector3(hostileMixed.pos.x, hostileMixed.pos.y + CORE.AIM_ASSIST_CHEST_OFFSET, hostileMixed.pos.z)
    .sub(from).normalize();
  const baseChestDot = dir.x * toHostileChest.x + dir.y * toHostileChest.y + dir.z * toHostileChest.z;
  const assisted = c.applyAimAssist(new Vector3(0, 0, -1), from);
  const assistedChestDot = assisted.x * toHostileChest.x + assisted.y * toHostileChest.y + assisted.z * toHostileChest.z;
  assert.ok(assistedChestDot > baseChestDot,
    'mixed ally/hostile aim assist must pull toward the hostile, not the closer teammate (dot ' + assistedChestDot.toFixed(6) + ' > ' + baseChestDot.toFixed(6) + ')');

  // Magnet cone is much tighter: teammate sits closer to the axis, hostile is the only legal target.
  const allyMagnetMixed = { id: 'allyMM', team: 'friendly', kind: 1, dead: false, pos: new Vector3(-0.02, 0.6, -10) };
  const hostileMagnetMixed = { id: 'hostileMM', team: 'enemy', kind: 1, dead: false, pos: new Vector3(-0.1, 0.6, -30) };
  c.enemies = [allyMagnetMixed, hostileMagnetMixed];
  const expectedMagnet = new Vector3(hostileMagnetMixed.pos.x, hostileMagnetMixed.pos.y + CORE.BULLET_MAGNET_Y_OFFSET, hostileMagnetMixed.pos.z)
    .sub(from).normalize();
  const magnetMixed = c.magnetizeBullet(new Vector3(0, 0, -1), from);
  assert.ok(Math.abs(magnetMixed.x - expectedMagnet.x) < 1e-9 && Math.abs(magnetMixed.y - expectedMagnet.y) < 1e-9 && Math.abs(magnetMixed.z - expectedMagnet.z) < 1e-9,
    'mixed ally/hostile bullet magnetism must snap to the hostile, not the closer teammate');

  // --- Dead teammates and dead hostiles remain inert ---
  c.enemies = [{ id: 'deadHostile', team: 'enemy', kind: 1, dead: true, pos: new Vector3(-0.05, 0.6, -10) }];
  const deadDir = new Vector3(0, 0, -1);
  assert.strictEqual(c.magnetizeBullet(deadDir, from), deadDir, 'dead actors must not attract bullet magnetism');
});

// Loads the real production soundtrack control block from 50_vfx_audio.js on top of the
// full match context, so killPlayer/respawn run against real startMusic/stopMusic.
function createMatchAudioContext(settings) {
  const audioSrc = source('50_vfx_audio.js');
  const start = audioSrc.indexOf('function startMusic()');
  const end = audioSrc.indexOf('function updateMusic');
  assert.ok(start > -1 && end > start, '50_vfx_audio.js music control anchors must exist');
  const s = Object.assign({ tdmTeamSize: 6, tdmScoreLimit: 75, muted: false, musicVolume: 0.5, masterVolume: 0.9 }, settings);
  const c = createFullMatchContext({
    MUSIC: { running: false, ctx: { currentTime: 0 }, bus: { gain: { cancelScheduledValues: noop, setTargetAtTime: noop } } },
    buildMusicGraph: () => true,
    getSetting: k => (k in s ? s[k] : 1)
  });
  vm.runInContext(audioSrc.slice(start, end), c);
  assert.strictEqual(vm.runInContext('typeof startMusic', c), 'function', 'real startMusic must be installed in the context');
  assert.strictEqual(vm.runInContext('typeof stopMusic', c), 'function', 'real stopMusic must be installed in the context');
  return c;
}

test('regression [P2]: match music survives a nonterminal TDM death and is restored on respawn, while terminal settlement still silences it', () => {
  const c = createMatchAudioContext({});
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  c.startMusic();
  assert.strictEqual(c.MUSIC.running, true, 'deploy must start the soundtrack');

  const p = c.player;
  p.spawnProtectionT = 0;
  const hostile = c.enemies.find(e => e.team === 'enemy');
  assert.ok(hostile, 'hostile bot must exist for the death lifecycle');

  c.damagePlayer(10000, 0, 'bullet', hostile);
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(p.dead, true, 'lethal hits must kill the player in TDM');
  assert.strictEqual(c.MODES.tdm.isOver(), false, 'this death must be nonterminal for the match');
  assert.strictEqual(c.MUSIC.running, true, 'nonterminal TDM death must not silence the match soundtrack');

  c.MODES.tdm.update(20);
  assert.strictEqual(p.dead, false, 'player must return alive through the production TDM respawn path');
  assert.strictEqual(c.MUSIC.running, true, 'soundtrack must be playing after a nonterminal respawn');

  // Terminal match death: reaching the enemy score limit ends the match and stops music.
  const c2 = createMatchAudioContext({});
  c2.setActiveMode('tdm');
  c2.MODES.tdm.setup();
  c2.startMusic();
  c2.MODES.tdm.enemyScore = 74;
  c2.player.spawnProtectionT = 0;
  const hostile2 = c2.enemies.find(e => e.team === 'enemy');
  c2.damagePlayer(10000, 0, 'bullet', hostile2);
  c2.damagePlayer(10000, 0, 'bullet', hostile2);
  assert.strictEqual(c2.MODES.tdm.isOver(), true, 'score limit must settle the match');
  assert.strictEqual(c2.MUSIC.running, false, 'a terminal settled death must still silence the soundtrack');
});

test('regression [P2]: muted settings keep match music silent across a nonterminal respawn', () => {
  const c = createMatchAudioContext({ muted: true });
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  c.player.spawnProtectionT = 0;
  const hostile = c.enemies.find(e => e.team === 'enemy');
  c.damagePlayer(10000, 0, 'bullet', hostile);
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(c.player.dead, true, 'player must die for the muted lifecycle check');
  c.MODES.tdm.update(20);
  assert.strictEqual(c.player.dead, false, 'muted player must still respawn');
  assert.strictEqual(c.MUSIC.running, false, 'mute must keep the soundtrack silent after respawn');

  const c2 = createMatchAudioContext({ muted: false, musicVolume: 0 });
  c2.setActiveMode('tdm');
  c2.MODES.tdm.setup();
  c2.player.spawnProtectionT = 0;
  const hostile2 = c2.enemies.find(e => e.team === 'enemy');
  c2.damagePlayer(10000, 0, 'bullet', hostile2);
  c2.damagePlayer(10000, 0, 'bullet', hostile2);
  c2.MODES.tdm.update(20);
  assert.strictEqual(c2.MUSIC.running, false, 'zero music volume must keep the soundtrack silent after respawn');
});


// ===================== MILESTONE 2 FINAL MODES (FFA / DOMINATION / GUN GAME) ====
// Real lifecycle regressions for the remaining ROADMAP milestone-2 modes. These
// drive the production setup/update/damage/kill/respawn paths (not helper
// simulations) so a missing or hollow implementation fails here first.

function modeSettings(c, over) {
  c._settings = Object.assign({
    tdmTeamSize: 6, tdmScoreLimit: 75,
    ffaActorCount: 8, ffaScoreLimit: 30,
    dominationScoreLimit: 200, gunGameActorCount: 8,
    muted: false, musicVolume: 0.5, masterVolume: 0.9
  }, over || {});
}

function ffaBots(c) {
  return c.enemies.filter(e => e && typeof e.team === 'string' && e.team.indexOf('ffa_') === 0 && !e.isPlayer);
}

function clearSpawnProtection(c) {
  c.player.spawnProtectionT = 0;
  c.enemies.forEach(e => { e.spawnProtectionT = 0; });
}

function addProductionWeapons(c) {
  const real = [
    { name: 'M4 Carbine', dmg: 26, mag: 30, reserveMax: 150 },
    { name: 'MK18 Mod1', dmg: 18, mag: 32, reserveMax: 160 },
    { name: 'SCAR-H', dmg: 42, mag: 20, reserveMax: 100 },
    { name: 'SV-98 Marksman', dmg: 120, mag: 5, reserveMax: 35 },
    { name: 'M870 Express', dmg: 16, mag: 6, reserveMax: 36 },
    { name: 'M249 SAW', dmg: 24, mag: 100, reserveMax: 300 },
    { name: 'M1911', dmg: 34, mag: 8, reserveMax: 56 }
  ];
  for (let i = 0; i < real.length; i++) c.CFG.weapons[i] = Object.assign({}, real[i]);
}

test('milestone2 [rules]: mode ids, settings schema and shared match-mode primitives are complete', () => {
  assert.deepStrictEqual(Array.from(CORE.MATCH_MODE_IDS), ['tdm', 'ffa', 'domination', 'gun-game'],
    'shared match-mode list must cover every non-Survival match mode');
  ['tdm', 'ffa', 'domination', 'gun-game'].forEach(id => assert.strictEqual(CORE.isMatchModeId(id), true, id + ' must be a match mode'));
  assert.strictEqual(CORE.isMatchModeId('survival'), false, 'Survival is not a match mode');

  // Settlement is shared: every match mode obeys score/time settlement, Survival obeys only the player lifecycle.
  ['tdm', 'ffa', 'domination', 'gun-game'].forEach(id => {
    assert.strictEqual(CORE.isModeOver(id, { targetScore: 10, friendlyScore: 10, gameEnded: false }), true, id + ' must settle on its score limit');
    assert.strictEqual(CORE.isModeOver(id, { targetScore: 10, enemyScore: 10, gameEnded: false }), true, id + ' must settle on the opposing score limit');
    assert.strictEqual(CORE.isModeOver(id, { targetScore: 10, friendlyScore: 1, timeLeft: 0 }), true, id + ' must settle on the clock');
    assert.strictEqual(CORE.isModeOver(id, { targetScore: 10, friendlyScore: 1, timeLeft: 30 }), false, id + ' must stay live below the limit');
    assert.strictEqual(CORE.isModeOver(id, { gameEnded: true }), true, id + ' must honour the explicit settlement flag');
  });
  assert.strictEqual(CORE.isModeOver('survival', { playerDead: true, playerDowned: false }), true, 'Survival settlement tracks the player');
  assert.strictEqual(CORE.isModeOver('survival', { playerDead: true, playerDowned: true }), false, 'a downed player is not a settled Survival run');

  // Deployment settings: persisted mode enum plus one meaningful option per new mode.
  assert.ok(CORE.SETTINGS_SCHEMA.gameMode.values.indexOf('ffa') > -1, 'gameMode enum must persist FFA');
  assert.ok(CORE.SETTINGS_SCHEMA.gameMode.values.indexOf('domination') > -1, 'gameMode enum must persist Domination');
  assert.ok(CORE.SETTINGS_SCHEMA.gameMode.values.indexOf('gun-game') > -1, 'gameMode enum must persist Gun Game');
  assert.strictEqual(CORE.clampSetting('gameMode', 'gun-game'), 'gun-game', 'saved match mode must round-trip');
  assert.strictEqual(CORE.clampSetting('gameMode', 'not-a-mode'), 'survival', 'unregistered modes must fall back to the schema default');
  assert.strictEqual(CORE.defaultSettings().ffaActorCount, 8, 'FFA default actor budget is 8');
  assert.strictEqual(CORE.defaultSettings().ffaScoreLimit, 30, 'FFA default score limit is 30 kills');
  assert.strictEqual(CORE.defaultSettings().dominationScoreLimit, 200, 'Domination default score limit is 200');
  assert.strictEqual(CORE.defaultSettings().gunGameActorCount, 8, 'Gun Game default actor budget is 8');
  assert.strictEqual(CORE.clampSetting('ffaActorCount', 99), CORE.FREE_FOR_ALL_MAX_ACTORS, 'actor budget must be capped');
  assert.strictEqual(CORE.clampSetting('dominationScoreLimit', 5000), 500, 'domination limit must be clamped');
});

test('regression [PR7 FFA picker]: a saved two-kill limit survives schema validation', () => {
  assert.strictEqual(CORE.clampSetting('ffaScoreLimit', 2), 2);
  assert.strictEqual(CORE.sanitizeSettings({ ffaScoreLimit: 2 }).ffaScoreLimit, 2);
  assert.strictEqual(CORE.SETTINGS_SCHEMA.ffaScoreLimit.min, 2);
  assert.strictEqual(CORE.SETTINGS_SCHEMA.ffaScoreLimit.step, 1);
});

test('regression [PR7 FFA deploy]: two kills settle the configured real actor lifecycle', () => {
  const c = createFullMatchContext();
  modeSettings(c, { ffaScoreLimit: 2 });
  c.setActiveMode('ffa');
  c.MODES.ffa.setup();
  const mode = c.MODES.ffa;
  assert.strictEqual(mode.targetScore, 2, 'deploy must not fall back to 30');
  assert.strictEqual(mode.roster.filter(a => a === c.player).length, 1);
  clearSpawnProtection(c);
  const victim = ffaBots(c)[0];
  c.damageEnemy(victim, victim.health + 1, victim.pos, false, false, 'AR', c.player);
  assert.strictEqual(mode.playerScore(), 1);
  assert.strictEqual(victim.dead, true);
  assert.strictEqual(c.modeRespawnQueue.some(e => e.actor === victim), true);
  mode.update(4);
  assert.strictEqual(victim.dead, false);
  assert.strictEqual(mode.roster.filter(a => a === victim).length, 1);
  assert.strictEqual(c.enemies.filter(a => a === victim).length, 1);
  clearSpawnProtection(c);
  c.damageEnemy(victim, victim.health + 1, victim.pos, false, false, 'AR', c.player);
  assert.strictEqual(mode.playerScore(), 2);
  assert.strictEqual(mode.isOver(), true);
  assert.strictEqual(c.$id('match-end-title').textContent, 'VICTORY');
});

test('regression [PR7 Gun Game integration]: real weapon initialization preserves every earned loadout', () => {
  const c = createWeaponsContext();
  vm.runInContext(source('35_modes.js'), c);
  c.buildViewmodel = () => {};
  c.updateHudAmmo = () => {};
  for (let tier = 0; tier < CORE.GUN_GAME_TIER_COUNT; tier++) {
    c.player.tier = tier;
    c.MODES['gun-game'].onRespawn(c.player);
    const owned = vm.runInContext('Array.from(weaponsOwned)', c);
    const expected = [CORE.gunGameTierWeapon(tier), -1, -1, -1];
    assert.deepStrictEqual(Array.from(owned), expected, 'only the earned tier weapon at tier ' + tier);
    assert.deepStrictEqual(Array.from(vm.runInContext('wState.map(s => !!s)', c)),
      expected.map(i => i >= 0), 'empty firearm slots must have no weapon state');
    if (tier === 19) assert.strictEqual(c.curW().type, 'MELEE', 'knife sentinel remains usable');
  }
  c.initWeapons();
  assert.ok(vm.runInContext('weaponsOwned[SIDEARM_SLOT] >= 0 && weaponsOwned[MARKSMAN_SLOT] >= 0', c),
    'ordinary Survival/TDM initialization must still restore bonus slots');
});

test('milestone2 [domination rules]: capture, contestation and scoring are explicit and fractional-frame invariant', () => {
  assert.strictEqual(CORE.DOMINATION_CAPTURE_SECONDS, 5, 'capture time must be 5 seconds');
  assert.strictEqual(CORE.DOMINATION_FLAG_RADIUS, 4, 'capture radius must be 4 metres');
  assert.strictEqual(CORE.DOMINATION_POINTS_PER_FLAG_SEC, 1, 'each owned flag must tick 1 point per second');
  assert.deepStrictEqual(CORE.DOMINATION_FLAG_NAMES, ['A', 'B', 'C'], 'three fixed flags A/B/C');
  assert.strictEqual(CORE.DOMINATION_FLAG_POINTS.length, 3, 'three fixed arena flag positions');

  // One attacker alone captures in exactly 5 s and never overshoots the limit.
  let cap = 0;
  for (let i = 0; i < 60; i++) cap = CORE.flagCaptureStep(cap, 0.1, true, false);
  assert.strictEqual(cap, 5, '5 s of uncontested presence must complete the capture');

  // Fractional-frame invariance: one 1 s step equals ten 0.1 s steps.
  let single = CORE.flagCaptureStep(0, 1, true, false);
  let stepped = 0;
  for (let i = 0; i < 10; i++) stepped = CORE.flagCaptureStep(stepped, 0.1, true, false);
  assert.strictEqual(single, stepped, 'capture progress must not depend on the frame size');

  // Contested presence pauses progress and never rewinds existing ownership progress.
  const pausedAt = CORE.flagCaptureStep(3.2, 5, true, true);
  assert.strictEqual(pausedAt, 3.2, 'a contested flag must pause capture where it stood');

  // Nobody on the flag decays the partial capture without touching ownership.
  assert.strictEqual(CORE.flagCaptureStep(3.2, 5, false, false), 0, 'an abandoned capture decays away');

  // Score ticking: whole points only, remainder preserved across frames.
  let acc = 0, points = 0;
  for (let i = 0; i < 10; i++) { const step = CORE.flagScoreStep(acc, 2, 0.1); points += step.points; acc = step.acc; }
  assert.strictEqual(points, 2, 'two owned flags tick 2 points over one second');
  const whole = CORE.flagScoreStep(0, 2, 1);
  assert.strictEqual(whole.points, 2, 'frame size must not change awarded points');
  const remainder = CORE.flagScoreStep(0, 1, 0.25);
  assert.strictEqual(remainder.points, 0, 'fractional ticks must not award partial points');
  assert.ok(Math.abs(remainder.acc - 0.25) < 1e-9, 'fractional points must carry over');
  assert.strictEqual(CORE.flagScoreStep(0, 0, 5).points, 0, 'unowned flags tick nothing');
});

test('milestone2 [gun game rules]: explicit 20-tier ladder ends with the knife and never overflows', () => {
  assert.strictEqual(CORE.GUN_GAME_TIER_COUNT, 20, 'Gun Game must ship 20 progression tiers');
  assert.strictEqual(CORE.GUN_GAME_LADDER.length, 20, 'the authoritative ladder must list all 20 tiers');
  for (let t = 0; t < 19; t++) {
    assert.ok(CORE.GUN_GAME_LADDER[t] >= 0, 'tier ' + (t + 1) + ' must be a real weapon');
    assert.strictEqual(CORE.gunGameIsKnifeTier(t), false, 'tier ' + (t + 1) + ' must not be the knife');
  }
  assert.strictEqual(CORE.GUN_GAME_LADDER[19], CORE.GUN_GAME_KNIFE, 'the final tier must be the Knife');
  assert.strictEqual(CORE.gunGameIsKnifeTier(19), true, 'tier 20 is the knife tier');
  assert.strictEqual(CORE.gunGameIsKnifeTier(CORE.gunGameTierWeapon(19)), true, 'the knife tier resolves to the knife entry');
  assert.strictEqual(CORE.gunGameTierWeapon(0), CORE.GUN_GAME_LADDER[0], 'the first tier must resolve to its advertised weapon');

  // Progression is monotonic, clamped at both ends, and never overflows the ladder.
  assert.strictEqual(CORE.gunGameAdvance(0, 1), 1, 'a credited kill advances a tier');
  assert.strictEqual(CORE.gunGameAdvance(0, -1), 0, 'a demotion never goes below the first tier');
  assert.strictEqual(CORE.gunGameAdvance(19, 1), 19, 'the ladder must never overflow past the knife');
  assert.strictEqual(CORE.gunGameAdvance(5, 0), 5, 'memory of the tier survives an empty step');

  // Only genuinely credited weapon kills count; grenades, sentries and environment kills do not.
  assert.strictEqual(CORE.gunGameCreditedKill('AR'), true, 'rifle kills count');
  assert.strictEqual(CORE.gunGameCreditedKill('MELEE'), true, 'knife kills count');
  assert.strictEqual(CORE.gunGameCreditedKill(undefined), false, 'unowned/area damage (grenades) must not grant a tier');
  assert.strictEqual(CORE.gunGameCreditedKill('SENTRY'), false, 'sentry kills must not grant a tier');
  assert.strictEqual(CORE.gunGameCreditedKill('FRAG'), false, 'grenade kills must not grant a tier');
  assert.strictEqual(CORE.gunGameMeleeKill('MELEE'), true, 'melee damage type is the knife');
  assert.strictEqual(CORE.gunGameMeleeKill('AR'), false, 'gunfire is not a knife kill');

  // Bot loadouts: the tier's weapon decides how hard its attacks land.
  assert.strictEqual(CORE.gunGameBotDamageMul(26, 26), 1, 'the baseline weapon must not change bot damage');
  assert.ok(CORE.gunGameBotDamageMul(120, 26) > 1, 'a marksman tier must hit harder than the baseline');
  assert.ok(CORE.gunGameBotDamageMul(16, 26) < 1, 'a shotgun tier must hit softer than the baseline');
  assert.ok(CORE.gunGameBotDamageMul(120, 26) <= 1.6 && CORE.gunGameBotDamageMul(16, 26) >= 0.6, 'bot damage multipliers stay balanced');
  assert.strictEqual(CORE.gunGameBotDamageMul(undefined, 26), 1, 'an unknown weapon must not change damage');
});

test('milestone2 [FFA]: setup deploys 8 independent factions and the score limit ends the match', () => {
  const c = createFullMatchContext();
  modeSettings(c);
  assert.ok(c.MODES['ffa'], 'ffa mode must be registered in the modes registry');
  c.setActiveMode('ffa');
  c.MODES.ffa.setup();

  assert.strictEqual(c.MODES.ffa.targetScore, 30, 'FFA defaults to 30 kills');
  assert.strictEqual(c.MODES.ffa.timeLeft, 600, 'FFA match clock is 10 minutes');
  assert.strictEqual(c.MODES.ffa.roster.length, 8, 'FFA must deploy 8 actors (player + 7 bots)');
  assert.strictEqual(c.player.team, 'ffa_you', 'the player is its own faction in FFA');
  const bots = ffaBots(c);
  assert.strictEqual(bots.length, 7, 'FFA must deploy 7 bots');
  const factions = new Set(c.MODES.ffa.roster.map(a => a.team));
  assert.strictEqual(factions.size, 8, 'every FFA actor must fight for itself');
  assert.strictEqual(CORE.isHostile(c.player, bots[0]), true, 'every bot is hostile to the player');
  assert.strictEqual(CORE.isHostile(bots[0], bots[1]), true, 'FFA bots must be hostile to each other');
  assert.strictEqual(CORE.isFriendlyFire(c.player, bots[0]), false, 'no actor is friendly in FFA');

  // Deployment settings shape the actor budget and stay capped.
  const capped = createFullMatchContext();
  modeSettings(capped, { ffaActorCount: 4 });
  capped.setActiveMode('ffa');
  capped.MODES.ffa.setup();
  assert.strictEqual(capped.MODES.ffa.roster.length, 4, 'the FFA actor setting must limit the roster');

  // Real lethal damage through the production path scores the kill and settles the match.
  c.MODES.ffa.targetScore = 3;
  clearSpawnProtection(c);
  for (let i = 0; i < 3; i++) {
    const bot = ffaBots(c)[i];
    c.damageEnemy(bot, 10000, bot.pos, false, false, 'AR', c.player);
  }
  assert.strictEqual(c.MODES.ffa.playerScore(), 3, 'the player must be credited with three kills');
  assert.strictEqual(c.MODES.ffa.leaderKills(), 3, 'the player must lead the lobby');
  assert.strictEqual(c.MODES.ffa.isOver(), true, 'reaching the kill limit must settle the match');
  assert.strictEqual(c.$id('match-end-screen').style.display, 'flex', 'the end screen must appear');
  assert.strictEqual(c.$id('match-end-title').textContent, 'VICTORY', 'the leading player must be told they won');
  const board = c.MODES.ffa.scoreboard();
  assert.strictEqual(board.mode, 'ffa', 'the FFA scoreboard must be labelled');
  assert.strictEqual(board.members.length, 8, 'every FFA actor must appear on the board');
  assert.strictEqual(board.members[0].kills, 3, 'the scoreboard must be sorted by kills');
});

test('milestone2 [FFA]: deaths respawn into the roster exactly once and never duplicate actors', () => {
  const c = createFullMatchContext();
  modeSettings(c, { ffaScoreLimit: 100 });
  assert.ok(c.MODES['ffa'], 'ffa mode must be registered in the modes registry');
  c.setActiveMode('ffa');
  c.MODES.ffa.setup();
  clearSpawnProtection(c);

  const victim = ffaBots(c)[2];
  const before = c.enemies.length;
  c.damageEnemy(victim, 10000, victim.pos, false, false, 'AR', c.player);
  assert.strictEqual(victim.dead, true, 'a lethal hit must kill the bot');
  assert.strictEqual(c.MODES.ffa.roster.includes(victim), true, 'the dead bot stays on the roster while it waits to respawn');
  assert.strictEqual(victim.deaths, 1, 'the death must be recorded once');

  c.MODES.ffa.update(4);
  assert.strictEqual(victim.dead, false, 'the queue timer must bring the bot back');
  assert.strictEqual(c.enemies.filter(e => e === victim).length, 1, 'respawn must not duplicate the bot in the AI roster');
  assert.strictEqual(c.enemies.length, before, 'respawn must keep the roster size stable');
  assert.strictEqual(c.MODES.ffa.roster.filter(a => a === victim).length, 1, 'respawn must not duplicate the roster entry');

  // The player death path is nonterminal and re-enters the match as well.
  const hostileBot = ffaBots(c)[4];
  hostileBot.spawnProtectionT = 0;
  c.damagePlayer(10000, 0, 'bullet', hostileBot);
  c.damagePlayer(10000, 0, 'bullet', hostileBot);
  assert.strictEqual(c.player.dead, true, 'two lethal hits must kill the player');
  assert.strictEqual(hostileBot.kills, 1, 'the killing bot must be credited');
  assert.strictEqual(c.player.deaths, 1, 'the player death must be recorded');
  assert.strictEqual(c.modeRespawnQueue.some(e => e.actor === c.player), true, 'a nonterminal FFA death must queue a respawn');
  c.MODES.ffa.update(4);
  assert.strictEqual(c.player.dead, false, 'the player must return alive in FFA');
  assert.strictEqual(c.player.team, 'ffa_you', 'respawn must keep the player faction stable');
});

test('milestone2 [Domination]: flags capture, contest, score one point per owned flag per second and win at the limit', () => {
  const c = createFullMatchContext();
  modeSettings(c);
  assert.ok(c.MODES['domination'], 'domination mode must be registered in the modes registry');
  c.setActiveMode('domination');
  c.MODES.domination.setup();

  const mode = c.MODES.domination;
  assert.strictEqual(mode.targetScore, 200, 'Domination defaults to 200 points');
  assert.strictEqual(mode.timeLeft, 600, 'Domination match clock is 10 minutes');
  assert.deepStrictEqual(Array.from(mode.flags, f => f.name), ['A', 'B', 'C'], 'three fixed flags');
  mode.flags.forEach(f => assert.strictEqual(f.owner, 'neutral', 'flags start neutral'));
  assert.strictEqual(mode.roster.length, 12, 'Domination defaults to 6v6 (player + 11 bots)');
  assert.strictEqual(mode.roster.filter(a => a.team === 'friendly').length, 6, 'six friendly actors');
  assert.strictEqual(mode.roster.filter(a => a.team === 'enemy').length, 6, 'six hostile actors');

  // Park every bot far from the flags, then stand on A: exactly 5 s of presence captures it.
  c.enemies.forEach((e, i) => e.pos.set(38 + i, 0, 38));
  const flagA = mode.flags[0];
  c.player.pos.set(flagA.x, 1.7, flagA.z);
  for (let i = 0; i < 50; i++) mode.updateFlags(0.1);
  assert.strictEqual(flagA.owner, 'friendly', 'uncontested presence must capture the flag after 5 s');

  // An owning team is not required to keep standing there: ownership alone ticks score.
  c.player.pos.set(flagA.x, 1.7, flagA.z + 25);
  mode.friendlyScore = 0;
  mode._scoreAcc = { friendly: 0, enemy: 0 };
  mode.update(1);
  assert.strictEqual(mode.friendlyScore, 1, 'one owned flag must tick one point per second even while empty');

  // Fractional frames must award exactly the same points.
  mode.friendlyScore = 0;
  mode._scoreAcc = { friendly: 0, enemy: 0 };
  for (let i = 0; i < 20; i++) mode.update(0.05);
  assert.strictEqual(mode.friendlyScore, 1, 'frame size must not change domination scoring');

  // Contested presence pauses capture without changing ownership.
  const flagB = mode.flags[1];
  c.player.pos.set(flagB.x, 1.7, flagB.z);
  const hostile = c.enemies.find(e => e.team === 'enemy');
  hostile.pos.set(flagB.x + 1, 0, flagB.z);
  for (let i = 0; i < 30; i++) mode.updateFlags(0.1);
  assert.strictEqual(flagB.owner, 'neutral', 'a contested flag must not fall to either side');
  assert.strictEqual(flagB.capture, 0, 'contested presence must not build capture progress');
  assert.strictEqual(mode.hudModel().note.indexOf('B') > -1, true, 'the HUD must report flag ownership');

  // Winning: the production tick settles the match when the team limit is met.
  mode.targetScore = 2;
  mode.friendlyScore = 1;
  mode._scoreAcc = { friendly: 0, enemy: 0 };
  mode.update(1);
  assert.strictEqual(mode.isOver(), true, 'the team score limit must settle the match');
  assert.strictEqual(c.$id('match-end-screen').style.display, 'flex', 'the domination end screen must appear');
  const outcome = mode.outcome();
  assert.strictEqual(outcome.title, 'VICTORY', 'the winning team must be told they won');
  const board = mode.scoreboard();
  assert.strictEqual(board.mode, 'domination', 'the domination scoreboard must be labelled');
  assert.strictEqual(board.flags.length, 3, 'the scoreboard must report every flag');
});

test('milestone2 [Domination]: attacking and defending bots steer to real flag destinations', () => {
  const c = createFullMatchContext({ nextEstepT: Infinity });
  modeSettings(c);
  assert.ok(c.MODES['domination'], 'domination mode must be registered in the modes registry');
  c.setActiveMode('domination');
  c.MODES.domination.setup();
  const mode = c.MODES.domination;

  // Neutral flags: an attacker's objective is a flag its side does not hold.
  c.enemies.forEach((e, i) => e.pos.set(38 + i, 0, 38));
  c.player.pos.set(0, 1.7, 0);
  const attacker = c.enemies.find(e => e.team === 'enemy');
  const attackOrder = mode.objectiveFor(attacker);
  assert.strictEqual(attackOrder.role, 'attack', 'an un-owned flag must be attacked');
  assert.ok(mode.flags.some(f => f.name === attackOrder.name), 'the objective must name a real flag');
  assert.strictEqual(attackOrder.point.length, 2, 'the objective must give a real destination');

  // Owned flag with hostiles standing on it: the owning side defends that flag.
  const owned = mode.flags[2];
  owned.owner = 'enemy';
  owned.capture = 0;
  c.player.pos.set(owned.x, 1.7, owned.z);
  const defender = c.enemies.find(e => e.team === 'enemy');
  defender.pos.set(owned.x + 2, 0, owned.z + 2);
  assert.strictEqual(mode.flagHostileCount(owned, 'enemy', CORE.DOMINATION_DEFEND_RADIUS) > 0, true,
    'the threatened flag must register hostile presence');
  const defendOrder = mode.objectiveFor(defender);
  assert.strictEqual(defendOrder.role, 'defend', 'hostiles on an owned flag must pull defenders to it');
  assert.strictEqual(defendOrder.name, 'C', 'the defender must be sent to the threatened flag');

  // The AI uses that destination for real navigation, not as a display-only tag.
  c.player.pos.set(owned.x, 1.7, owned.z);
  c.enemies.forEach((e, i) => { e.pos.set(80 + i * 40, 0, 80 + i * 40); });
  const walker = c.enemies.find(e => e.team === 'enemy');
  const startDist = Math.hypot(walker.pos.x - owned.x, walker.pos.z - owned.z);
  c.updateEnemies(0.1);
  assert.ok(walker.objectiveTarget && walker.objectiveTarget.objectiveRole === 'defend',
    'an actor with no fight nearby must walk its flag order (got ' + (walker.objectiveTarget && walker.objectiveTarget.objectiveRole) + ')');
  assert.ok(Math.abs(walker.objectiveTarget.pos.x - owned.x) < 1e-6 && Math.abs(walker.objectiveTarget.pos.z - owned.z) < 1e-6,
    'the navigation destination must be the objective flag itself');
  assert.strictEqual(walker.target, null, 'the walked order must not stay assigned as an aim target');
  for (let i = 0; i < 60; i++) c.updateEnemies(0.1);
  const endDist = Math.hypot(walker.pos.x - owned.x, walker.pos.z - owned.z);
  assert.ok(endDist < startDist, 'the bot must actually close distance on the flag (' + endDist.toFixed(2) + ' < ' + startDist.toFixed(2) + ')');
});

test('milestone2 [Gun Game]: 20-tier ladder advances real credited kills, demotes knife victims, and the knife kill wins', () => {
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  assert.ok(c.MODES['gun-game'], 'gun-game mode must be registered in the modes registry');
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];

  assert.strictEqual(mode.roster.length, 8, 'Gun Game deploys 8 free-for-all actors');
  assert.strictEqual(mode.roster.filter(a => a.team === 'ffa_you').length, 1, 'exactly one actor is the player');
  assert.strictEqual(c.enemies.filter(e => e.team.indexOf('ffa_') === 0).length, 7, 'seven ladder bots');
  assert.strictEqual(mode.tierOf(c.player), 0, 'everyone starts on the first tier');
  assert.strictEqual(mode.tierOf(c.enemies.find(e => e.team === 'ffa_1')), 0, 'bots start on the first tier too');
  assert.strictEqual(c.weaponsOwned[0], CORE.GUN_GAME_LADDER[0], 'the player must be issued the first tier weapon');
  assert.strictEqual(mode.hudModel().left, 'TIER 1/20', 'the HUD must advertise the current tier');

  clearSpawnProtection(c);
  const bots = ffaBots(c);

  // A credited gun kill advances only the killer.
  const victimA = bots[0];
  c.damageEnemy(victimA, 10000, victimA.pos, false, false, 'AR', c.player);
  assert.strictEqual(mode.tierOf(c.player), 1, 'a credited kill must advance the killer');
  assert.strictEqual(mode.tierOf(victimA), 0, 'the victim must not advance');
  assert.strictEqual(c.weaponsOwned[0], CORE.GUN_GAME_LADDER[1], 'the new tier weapon must be equipped immediately');

  // A grenade kill (unowned area damage) grants nothing.
  const victimB = bots[1];
  victimB.spawnProtectionT = 0;
  c.damageEnemy(victimB, 10000, victimB.pos, false, false, undefined, c.player);
  assert.strictEqual(mode.tierOf(c.player), 1, 'a grenade kill must not grant a ladder step');

  // Self kills and same-faction kills grant nothing.
  const victimC = bots[2];
  mode.onKill(victimC, false, victimC, 'AR');
  assert.strictEqual(mode.tierOf(victimC), 0, 'a self kill must not grant a ladder step');
  assert.strictEqual(mode.tierOf(c.player), 1, 'a self kill elsewhere must not advance the player');
  const allyVictim = bots[1];
  const allyKiller = bots[4];
  const savedAllyTeam = allyKiller.team;
  allyKiller.team = allyVictim.team;
  mode.onKill(allyVictim, false, allyKiller, 'AR');
  allyKiller.team = savedAllyTeam;
  assert.strictEqual(mode.tierOf(allyKiller), 0, 'a same-faction kill must not grant a ladder step');
  assert.strictEqual(mode.tierOf(c.player), 1, 'an ally kill must not advance the observing player');

  // Bots advance from their own credited kills.
  const botKiller = bots[3];
  const botVictim = bots[4];
  botVictim.spawnProtectionT = 0;
  c.damageEnemy(botVictim, 10000, botVictim.pos, false, false, 'AR', botKiller);
  assert.strictEqual(mode.tierOf(botKiller), 1, 'a bot credited kill must advance that bot');
  assert.strictEqual(mode.tierOf(botVictim), 0, 'the killed bot must not advance');

  // The knife demotes the victim one tier, never below the first.
  const demoteVictim = bots[2];
  mode.setTier(demoteVictim, 3);
  demoteVictim.spawnProtectionT = 0;
  c.damageEnemy(demoteVictim, 10000, demoteVictim.pos, false, false, 'MELEE', c.player);
  assert.strictEqual(mode.tierOf(demoteVictim), 2, 'a knife kill must demote the victim one tier');
  const floorBot = bots[3];
  mode.setTier(floorBot, 0);
  floorBot.spawnProtectionT = 0;
  c.damageEnemy(floorBot, 10000, floorBot.pos, false, false, 'MELEE', c.player);
  assert.strictEqual(mode.tierOf(floorBot), 0, 'a knife demotion must never drop below the first tier');

  // Bot loadout follows the tier: the weapon decides how hard the bot hits.
  const heavyBot = bots[6];
  const baselineMul = heavyBot.dmgMul;
  mode.setTier(heavyBot, 4);
  assert.ok(heavyBot.dmgMul > baselineMul, 'a heavier rung must raise a bot\'s damage output');
  assert.strictEqual(heavyBot.ggWeapon, CORE.GUN_GAME_LADDER[4], 'the bot loadout must track its tier weapon');
  assert.strictEqual(heavyBot.dmgMul,
    CORE.gunGameBotDamageMul(c.CFG.weapons[CORE.GUN_GAME_LADDER[4]].dmg, c.CFG.weapons[0].dmg),
    'the damage multiplier must come from the tier weapon itself');
  mode.setTier(heavyBot, 5);
  assert.ok(heavyBot.dmgMul < baselineMul, 'a lighter rung must soften a bot\'s attacks');

  // Reaching the knife tier is not enough — the knife kill itself wins, without overflowing.
  const finisher = createFullMatchContext();
  addProductionWeapons(finisher);
  modeSettings(finisher);
  finisher.setActiveMode('gun-game');
  finisher.MODES['gun-game'].setup();
  const fm = finisher.MODES['gun-game'];
  clearSpawnProtection(finisher);
  fm.setTier(finisher.player, 19);
  assert.strictEqual(fm.tierOf(finisher.player), 19, 'the knife tier is the last rung');
  assert.strictEqual(fm.isOver(), false, 'holding the knife must not settle the match on its own');
  const prey = ffaBots(finisher)[0];
  prey.spawnProtectionT = 0;
  finisher.damageEnemy(prey, 10000, prey.pos, false, false, 'MELEE', finisher.player);
  assert.strictEqual(fm.tierOf(finisher.player), 19, 'the ladder must never overflow past the knife');
  assert.strictEqual(fm.isOver(), true, 'the final knife kill must win the match');
  assert.strictEqual(finisher.$id('match-end-title').textContent, 'VICTORY', 'the knife winner must be told they won');
  assert.strictEqual(finisher.$id('match-end-screen').style.display, 'flex', 'the Gun Game end screen must appear');
});

test('milestone2 [Gun Game]: respawn restores the earned tier loadout and exit cleans the roster', () => {
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  assert.ok(c.MODES['gun-game'], 'gun-game mode must be registered in the modes registry');
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];
  clearSpawnProtection(c);

  const firstBlood = ffaBots(c)[0];
  c.damageEnemy(firstBlood, 10000, firstBlood.pos, false, false, 'AR', c.player);
  const secondBlood = ffaBots(c)[1];
  secondBlood.spawnProtectionT = 0;
  c.damageEnemy(secondBlood, 10000, secondBlood.pos, false, false, 'AR', c.player);
  assert.strictEqual(mode.tierOf(c.player), 2, 'two credited kills must advance two tiers');
  const earned = c.weaponsOwned[0];
  assert.strictEqual(earned, CORE.GUN_GAME_LADDER[2], 'the earned weapon must be equipped');

  const hostile = ffaBots(c)[3];
  hostile.spawnProtectionT = 0;
  c.damagePlayer(10000, 0, 'bullet', hostile);
  c.damagePlayer(10000, 0, 'bullet', hostile);
  assert.strictEqual(c.player.dead, true, 'the player can be killed in Gun Game');
  assert.strictEqual(mode.tierOf(c.player), 2, 'dying to a bullet must not demote the player');
  c.MODES['gun-game'].update(4);
  assert.strictEqual(c.player.dead, false, 'the player respawns into the match');
  assert.strictEqual(mode.tierOf(c.player), 2, 'the earned tier must survive the respawn');
  assert.strictEqual(c.weaponsOwned[0], CORE.GUN_GAME_LADDER[2], 'respawn must re-issue the earned tier weapon, not the deploy pick');

  const board = mode.scoreboard();
  assert.strictEqual(board.mode, 'gun-game', 'the ladder scoreboard must be labelled');
  assert.strictEqual(board.members.length, 8, 'every ladder actor must appear on the board');
  assert.strictEqual(board.members.every(m => typeof m.tier === 'number'), true, 'the board must report ladder progress');

  c.quitMatchToMenu();
  assert.strictEqual(mode.roster.length, 0, 'leaving the match must clear the Gun Game roster');
  assert.strictEqual(c.activeModeId, 'survival', 'leaving a match returns to Survival deployment');
  assert.strictEqual(c.enemies.filter(e => typeof e.team === 'string' && e.team.indexOf('ffa_') === 0).length, 0,
    'leaving the match must remove every ladder bot from the AI roster');
});

test('milestone2 [settlement]: every match mode freezes post-settlement damage while Survival keeps posthumous damage alive', () => {
  const freezeCases = ['ffa', 'domination', 'gun-game'];
  freezeCases.forEach(id => {
    const c = createFullMatchContext();
    if (id === 'gun-game') addProductionWeapons(c);
    modeSettings(c);
    assert.ok(c.MODES[id], id + ' mode must be registered in the modes registry');
    c.setActiveMode(id);
    c.MODES[id].setup();
    clearSpawnProtection(c);
    const mode = c.MODES[id];
    const victim = c.enemies.find(e => e.team !== 'friendly');
    victim.spawnProtectionT = 0;
    const healthBefore = victim.health;
    mode.endMatch();
    assert.strictEqual(mode.isOver(), true, id + ' must be settled after its end screen');
    c.damageEnemy(victim, 5000, victim.pos, false, false, 'AR', c.player);
    assert.strictEqual(victim.health, healthBefore, id + ' must reject damage after settlement');
    assert.strictEqual(victim.dead, false, id + ' must not kill a bot after settlement');
    const settledFrames = c.MODES[id].timeLeft;
    c.MODES[id].update(5);
    assert.strictEqual(c.MODES[id].timeLeft, settledFrames, id + ' timers must stop once settled');
  });

  // Survival: a dead player must never suppress posthumous damage or corpse retirement.
  const s = createFullMatchContext();
  modeSettings(s);
  s.setActiveMode('survival');
  s.MODES.survival.setup();
  clearSpawnProtection(s);
  const target = s.spawnEnemy(0, 6, 6, { team: 'enemy', spawnProtection: false });
  assert.ok(target, 'the Survival scenario needs a real hostile');
  target.spawnProtectionT = 0;
  s.player.dead = true;
  const before = target.health;
  s.damageEnemy(target, 25, target.pos, false, false, 'AR', s.player);
  assert.strictEqual(target.health < before, true, 'a dead player must still be able to damage a hostile');
  s.MODES.survival.update(0.1);
  assert.strictEqual(s.MODES.survival.isOver(), true, 'Survival is still settled for the run itself');
});

test('milestone2 [deploy UI]: every mode is selectable with its own options and the HUD/scoreboard are shared', () => {
  const c = createFullMatchContext();
  modeSettings(c);
  c.buildModePickerRow();
  ['survival', 'tdm', 'ffa', 'domination', 'gun-game'].forEach(id => {
    assert.ok(c.$id('mode-btn-' + id), 'the deploy screen must offer ' + id);
  });

  assert.ok(c.MODES['ffa'], 'ffa mode must be registered in the modes registry');

  c.setActiveMode('ffa');
  c.buildTdmSettingsRow();
  assert.strictEqual(c.$id('tdm-settings-row').style.display, 'flex', 'FFA must expose its deploy options');
  assert.ok(c.$id('ffa-score-30'), 'FFA must offer a kill limit choice');
  assert.ok(c.$id('ffa-actors-8'), 'FFA must offer an actor budget choice');
  assert.strictEqual(c.$id('diff-row').style.display, 'none', 'match modes must not offer an unrelated difficulty row');

  assert.ok(c.MODES['domination'], 'domination mode must be registered in the modes registry');

  c.setActiveMode('domination');
  c.buildTdmSettingsRow();
  assert.ok(c.$id('domination-score-200'), 'Domination must offer a point limit choice');

  assert.ok(c.MODES['gun-game'], 'gun-game mode must be registered in the modes registry');

  c.setActiveMode('gun-game');
  c.buildTdmSettingsRow();
  assert.ok(c.$id('gg-actors-8'), 'Gun Game must offer an actor budget choice');

  c.setActiveMode('survival');
  c.buildTdmSettingsRow();
  assert.strictEqual(c.$id('tdm-settings-row').style.display, 'none', 'Survival must not show match options');

  // Shared HUD: timer, score bar and ownership note for every match mode.
  ['tdm', 'ffa', 'domination', 'gun-game'].forEach(id => {
    const ctx = createFullMatchContext();
    addProductionWeapons(ctx);
    modeSettings(ctx);
    assert.ok(ctx.MODES[id], id + ' mode must be registered in the modes registry');
    ctx.setActiveMode(id);
    ctx.MODES[id].setup();
    if (typeof ctx.MODES[id].hudModel === 'function') {
      const view = ctx.MODES[id].hudModel();
      assert.ok(view && typeof view.left !== 'undefined' && typeof view.right !== 'undefined', id + ' must expose a HUD model');
    }
    assert.strictEqual(ctx.$id('match-hud').style.display, 'block', id + ' must show the shared match HUD');
    assert.strictEqual(ctx.$id('match-timer').textContent, '10:00', id + ' must render the match clock');
    assert.ok(ctx.$id('match-score-friendly').textContent.length > 0, id + ' must render its score bar');
    if (typeof ctx.MODES[id].outcome === 'function') {
      assert.ok(typeof ctx.MODES[id].outcome().title === 'string', id + ' must describe its outcome');
    }

    // Shared scoreboard renderer accepts every match mode.
    ctx.updateScoreboard();
    assert.ok(ctx.$id('match-scoreboard').innerHTML.length > 0, id + ' must render a scoreboard');

    // Restart keeps the same mode and cleans its roster.
    ctx.restartMatch();
    assert.strictEqual(ctx.activeModeId, id, id + ' restart must stay in the same mode');
    assert.strictEqual(ctx.MODES[id].isOver(), false, id + ' restart must clear the settled state');
    assert.strictEqual(ctx.MODES[id].roster.length > 0, true, id + ' restart must redeploy the roster');
    ctx.quitMatchToMenu();
    assert.strictEqual(ctx.MODES[id].roster.length, 0, id + ' exit must clear the roster');
    assert.strictEqual(ctx.enemies.filter(e => e.team !== 'enemy').length, 0, id + ' exit must remove every non-Survival bot');
  });
});

test('milestone2 [settings]: the saved match mode survives a reload and restores into the live registry', () => {
  const c = createFullMatchContext();
  modeSettings(c, { gameMode: 'gun-game' });
  c.setSetting('gameMode', 'gun-game');
  assert.strictEqual(c._settings.gameMode, 'gun-game', 'the mode must persist through the settings layer');
  assert.strictEqual(CORE.clampSetting('gameMode', c._settings.gameMode), 'gun-game', 'a persisted match mode must validate');
  c.buildModePickerRow();
  assert.strictEqual(c.activeModeId, 'gun-game', 'the saved mode must restore into the live registry on the menu');

  ['tdm', 'ffa', 'domination'].forEach(id => {
    c.setSetting('gameMode', id);
    c.buildModePickerRow();
    assert.strictEqual(c.activeModeId, id, id + ' must restore into the live registry when the menu is open');
  });

  // An unknown saved value must never restore a mode that does not exist.
  c.setSetting('gameMode', 'not-a-mode');
  c.buildModePickerRow();
  assert.strictEqual(c.activeModeId, 'survival', 'an unknown saved mode must fall back to Survival');
});

// ---------------------------------------------------------------------------
// Regression: buildViewmodel knife-tier crash (CI failure PR7)
// ---------------------------------------------------------------------------
// These tests exercise the exact lifecycle that crashed in production:
//   setTier(actor, 19) -> onRespawn -> applyGunGamePlayerLoadout ->
//   buildViewmodel with weaponsOwned[0] === -1 -> CFG.weapons[-1] undefined
//   -> TypeError: Cannot read properties of undefined (reading 'cls')
// ---------------------------------------------------------------------------

// Helper: create a minimal VM context that has just enough to run
// 30_weapons.js (curW / buildViewmodel) with full CFG.weapons.
function createWeaponsContext(overrideWeapons) {
  const weapons = overrideWeapons || [
    { name: 'M4 Carbine', type: 'AR', cls: undefined, dmg: 26, rpm: 750, mag: 30, reserveMax: 150, reload: 2.1, spread: 0.014, adsSpread: 0.004, recoilV: 0.014, recoilH: 0.006, range: 120, auto: true },
    { name: 'MK18 Mod1',  type: 'SMG', dmg: 18, rpm: 900, mag: 32, reserveMax: 160, reload: 1.9, spread: 0.020, adsSpread: 0.008, recoilV: 0.009, recoilH: 0.005, range: 80, auto: true },
    { name: 'SCAR-H',     type: 'BR',  dmg: 42, rpm: 620, mag: 20, reserveMax: 100, reload: 2.4, spread: 0.011, adsSpread: 0.003, recoilV: 0.020, recoilH: 0.008, range: 140, auto: true },
    { name: 'SV-98 Marksman', type: 'SR', dmg: 120, rpm: 45, mag: 5, reserveMax: 35, reload: 3.4, spread: 0.055, adsSpread: 0.0006, recoilV: 0.055, recoilH: 0.012, range: 260, auto: false },
    { name: 'M870 Express', type: 'AR', cls: 'SG', dmg: 16, pellets: 8, rpm: 68, mag: 6, reserveMax: 36, reload: 0.5, spread: 0.02, adsSpread: 0.01, recoilV: 0.05, recoilH: 0.014, range: 32, auto: false },
    { name: 'M249 SAW',    type: 'AR', cls: 'LMG', dmg: 24, rpm: 760, mag: 100, reserveMax: 300, reload: 5.4, spread: 0.024, adsSpread: 0.006, recoilV: 0.0105, recoilH: 0.0075, range: 120, auto: true },
    { name: 'M1911',       type: 'SMG', cls: 'PST', sidearm: true, dmg: 34, rpm: 420, mag: 8, reserveMax: 56, reload: 1.5, spread: 0.016, adsSpread: 0.005, recoilV: 0.02, recoilH: 0.006, range: 60, auto: false }
  ];

  // Minimal THREE stubs required by 30_weapons.js for its module-level
  // declarations and by buildViewmodel().
  const builtModels = [];
  const removedGroups = [];
  const gunCameraChildren = [];
  const fakeGunCamera = {
    add: g => gunCameraChildren.push(g),
    remove: g => { const i = gunCameraChildren.indexOf(g); if (i >= 0) gunCameraChildren.splice(i, 1); removedGroups.push(g); }
  };
  let knifeGroupBuilt = false;

  const ctx = vm.createContext({
    CORE,
    Math: Object.create(Math),
    THREE: {
      Group: Group,
      Vector3: Vector3,
      Raycaster: function () { return { set: noop, intersectObjects: () => [] }; }
    },
    CFG: {
      weapons: weapons,
      assist: { swayAmp: 0.001, steadyMul: 0.14 },
      player: { height: 1.7 }
    },
    gunCamera: fakeGunCamera,
    // Stubs for the functions buildViewmodel calls from 32_viewmodels.js —
    // we only run 30_weapons.js here, so these must be injected manually.
    buildGunModel: function (g, P, type) {
      builtModels.push(type);
      return { muzzleZ: -0.5, muzzleY: 0.05, kick: 1 };
    },
    disposeGunModel: function (g) { /* no-op in tests */ },
    vmFlash: function () { return { visible: false }; },
    // buildKnife is in 32_viewmodels.js; inject a spy so the knife-tier path
    // verifies it is called exactly once to initialise knifeGroup.
    buildKnife: function () { knifeGroupBuilt = true; },
    knifeGroup: null,
    // Stubs for everything else 30_weapons.js touches at module level.
    player: { dead: false, sprinting: false, crouching: false, sliding: false, downed: false, onGround: true, recoilP: 0, recoilY: 0, yaw: 0, pitch: 0, tacT: 0, landStunT: 0, bobPhase: 0, bobAmp: 0 },
    perks: [],
    started: false,
    paused: false,
    adsDown: () => false,
    mouse1Down: false,
    bloom: 0,
    hSpeedForSpread: 0,
    adsAmount: 0,
    gunSwitchT: 1,
    flashT: 0,
    swayX: 0,
    swayY: 0,
    swayPhase: 0,
    steadyActive: false,
    steadyT: 0,
    _wasSteadyActive: false,
    plateT: 0,
    grenadeCharging: false,
    dryPlayed: false,
    shotsFired: 0,
    fireClockT: 0,
    playSound: noop,
    playSound3D: noop,
    updateHudAmmo: noop,
    updateHudHealth: noop,
    getLoadout: () => ({}),
    $id: () => null,
    keys: {},
    pressed: {},
    STEADY_MAX: 3,
    STEADY_RECOVER: 1,
    IS_TOUCH: false,
    getSetting: () => false,
    _test_builtModels: builtModels,
    _test_removedGroups: removedGroups,
    _test_gunCameraChildren: gunCameraChildren,
    _test_knifeGroupBuilt: () => knifeGroupBuilt
  });
  vm.runInContext(source('30_weapons.js'), ctx);
  return ctx;
}

test('regression [knife tier]: curW() returns a safe sentinel object (type MELEE, all numerics zero) when weaponsOwned slot is -1', () => {
  const ctx = createWeaponsContext();
  // Arm the knife tier: slot 0 = -1, curWeapon = 0.
  vm.runInContext('weaponsOwned[0] = -1; curWeapon = 0; wState[0] = null;', ctx);
  const w = vm.runInContext('curW()', ctx);
  assert.ok(w !== undefined && w !== null, 'curW() must never return undefined or null on knife tier');
  assert.strictEqual(w.type, 'MELEE', 'sentinel type must be MELEE');
  assert.strictEqual(w.mag, 0, 'sentinel mag must be 0 (no ammo to display)');
  assert.strictEqual(w.reserveMax, 0, 'sentinel reserveMax must be 0');
  assert.strictEqual(w.rpm, 0, 'sentinel rpm must be 0 (no auto fire)');
  assert.strictEqual(w.spread, 0, 'sentinel spread must be 0');
  assert.strictEqual(w.adsSpread, 0, 'sentinel adsSpread must be 0');
  assert.strictEqual(w.name, 'Knife', 'sentinel name must identify the weapon');
  // Confirm it is frozen so callers cannot accidentally mutate the shared sentinel.
  assert.strictEqual(Object.isFrozen(w), true, 'the knife sentinel must be frozen');
});

test('regression [knife tier]: buildViewmodel does not crash and clears the gun group when weaponsOwned[0] === -1', () => {
  const ctx = createWeaponsContext();
  // First, build a normal viewmodel so gunGroup is non-null.
  vm.runInContext('weaponsOwned[0] = 0; curWeapon = 0; wState[0] = { ammo: 30, reserve: 150, reloading: false, reloadT: 0, nextShot: 0 };', ctx);
  vm.runInContext('buildViewmodel();', ctx);
  const afterFirstBuild = ctx._test_builtModels.length;
  assert.strictEqual(afterFirstBuild, 1, 'first buildViewmodel must call buildGunModel once');
  assert.strictEqual(ctx._test_gunCameraChildren.length, 1, 'gun group must be attached to gunCamera after first build');

  // Now switch to knife tier (weaponsOwned[0] = -1).
  vm.runInContext('weaponsOwned[0] = -1; curWeapon = 0; wState[0] = null;', ctx);
  // This must not throw.
  assert.doesNotThrow(() => {
    vm.runInContext('buildViewmodel();', ctx);
  }, 'buildViewmodel must not throw on the knife tier');

  // The gun group must have been removed from the gun camera.
  assert.strictEqual(ctx._test_removedGroups.length, 1, 'the previous gun group must be removed from gunCamera');
  assert.strictEqual(ctx._test_gunCameraChildren.length, 0, 'gunCamera must have no children on the knife tier');

  // buildGunModel must NOT have been called a second time (no gun for knife).
  assert.strictEqual(ctx._test_builtModels.length, 1, 'buildGunModel must not be called for the knife tier');

  // buildKnife must have been called to initialise the knife mesh.
  assert.strictEqual(ctx._test_knifeGroupBuilt(), true, 'buildKnife must be called when the knifeGroup is uninitialised');
});

test('regression [knife tier]: buildViewmodel is idempotent on repeated calls at knife tier', () => {
  const ctx = createWeaponsContext();
  vm.runInContext('weaponsOwned[0] = -1; curWeapon = 0; wState[0] = null; knifeGroup = {}; /* already built */', ctx);
  // Three consecutive knife-tier builds must never crash and must not attach anything.
  for (let i = 0; i < 3; i++) {
    assert.doesNotThrow(() => vm.runInContext('buildViewmodel();', ctx),
      'buildViewmodel must be idempotent on the knife tier (call ' + (i + 1) + ')');
  }
  assert.strictEqual(ctx._test_builtModels.length, 0, 'no gun model must be built across all knife-tier calls');
  assert.strictEqual(ctx._test_gunCameraChildren.length, 0, 'gunCamera must stay empty across all knife-tier calls');
});

test('regression [knife tier]: transitioning gun→knife→gun round-trips the viewmodel without crash or leak', () => {
  const ctx = createWeaponsContext();

  // Gun tier: build the model.
  vm.runInContext('weaponsOwned[0] = 0; curWeapon = 0; wState[0] = { ammo: 30, reserve: 150, reloading: false, reloadT: 0, nextShot: 0 }; buildViewmodel();', ctx);
  assert.strictEqual(ctx._test_builtModels.length, 1, 'gun tier must call buildGunModel once');
  assert.strictEqual(ctx._test_gunCameraChildren.length, 1, 'gun group must be in gunCamera');

  // Knife tier: clear the model.
  vm.runInContext('weaponsOwned[0] = -1; wState[0] = null; buildViewmodel();', ctx);
  assert.strictEqual(ctx._test_builtModels.length, 1, 'knife tier must not call buildGunModel again');
  assert.strictEqual(ctx._test_gunCameraChildren.length, 0, 'gunCamera must be empty on knife tier');
  assert.strictEqual(ctx._test_removedGroups.length, 1, 'old gun group must be detached');

  // Back to a gun tier.
  vm.runInContext('weaponsOwned[0] = 1; wState[0] = { ammo: 32, reserve: 160, reloading: false, reloadT: 0, nextShot: 0 }; buildViewmodel();', ctx);
  assert.strictEqual(ctx._test_builtModels.length, 2, 'returning to a gun tier must call buildGunModel again');
  assert.strictEqual(ctx._test_gunCameraChildren.length, 1, 'gun group must be back in gunCamera');
});

test('regression [knife tier]: all 20 Gun Game tiers produce valid weaponsOwned entries and correct sentinel/weapon for curW()', () => {
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];

  for (let tier = 0; tier < 20; tier++) {
    // Force the player to each tier.
    mode.setTier(c.player, tier);
    const ladder = CORE.GUN_GAME_LADDER[tier];
    if (ladder === CORE.GUN_GAME_KNIFE) {
      // Knife tier: slot 0 must be -1 and weaponsOwned must hold no firearm.
      assert.strictEqual(c.weaponsOwned[0], -1,
        'tier ' + (tier + 1) + ' (knife) must set weaponsOwned[0] to -1');
    } else {
      // Gun tier: slot 0 must hold the correct CFG.weapons index.
      assert.strictEqual(c.weaponsOwned[0], ladder,
        'tier ' + (tier + 1) + ' must equip weapon index ' + ladder);
      assert.ok(c.CFG.weapons[ladder],
        'tier ' + (tier + 1) + ' weapon index must resolve to a real CFG entry');
    }
  }
});

test('regression [knife tier]: all 20 bot tiers produce valid ggWeapon and sane dmgMul', () => {
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];
  const bot = c.enemies.find(e => e.team && e.team.indexOf('ffa_') === 0);
  assert.ok(bot, 'a bot must be present in the Gun Game roster');

  for (let tier = 0; tier < 20; tier++) {
    assert.doesNotThrow(() => mode.setTier(bot, tier),
      'setTier must not throw for bot at tier ' + (tier + 1));
    if (CORE.GUN_GAME_LADDER[tier] === CORE.GUN_GAME_KNIFE) {
      // Knife tier for bots: ggWeapon must be the knife sentinel value.
      assert.strictEqual(bot.ggWeapon, CORE.GUN_GAME_KNIFE,
        'bot at knife tier must carry the knife sentinel weapon');
      // At the knife tier bots receive GUN_GAME_KNIFE_DAMAGE_MUL (the design
      // intent: a knife-tier bot is unusually dangerous in close quarters).
      assert.strictEqual(bot.dmgMul, CORE.GUN_GAME_KNIFE_DAMAGE_MUL,
        'bot dmgMul must equal GUN_GAME_KNIFE_DAMAGE_MUL at the knife tier');
    } else {
      // Gun tier for bots: ggWeapon must match the ladder entry and the
      // weapon must exist in CFG.
      assert.strictEqual(bot.ggWeapon, CORE.GUN_GAME_LADDER[tier],
        'bot ggWeapon must match the ladder at tier ' + (tier + 1));
      assert.ok(c.CFG.weapons[bot.ggWeapon],
        'bot ggWeapon at tier ' + (tier + 1) + ' must resolve to a real CFG entry');
      assert.ok(typeof bot.dmgMul === 'number' && bot.dmgMul > 0,
        'bot dmgMul must be a positive number at gun tier ' + (tier + 1));
    }
  }
});

test('regression [knife tier]: repeated knife→gun→knife transitions never leave stale weaponsOwned entries', () => {
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];

  const KNIFE_TIER = 19;
  const GUN_TIER   = 5;

  for (let round = 0; round < 4; round++) {
    mode.setTier(c.player, KNIFE_TIER);
    assert.strictEqual(c.weaponsOwned[0], -1, 'knife tier (round ' + round + ') must clear slot 0');

    mode.setTier(c.player, GUN_TIER);
    assert.strictEqual(c.weaponsOwned[0], CORE.GUN_GAME_LADDER[GUN_TIER],
      'gun tier (round ' + round + ') must restore the correct weapon');
    assert.notStrictEqual(c.weaponsOwned[0], -1, 'slot 0 must not remain -1 after returning to a gun tier');
  }
});

test('regression [knife tier]: knife demotion at tier 0 stays at tier 0, not knife tier', () => {
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];
  clearSpawnProtection(c);

  const floorBot = c.enemies.find(e => e.team && e.team.indexOf('ffa_') === 0);
  floorBot.spawnProtectionT = 0;
  mode.setTier(floorBot, 0);
  // Knife kill: demote victim from tier 0 — must stay at tier 0, never go negative.
  c.damageEnemy(floorBot, 10000, floorBot.pos, false, false, 'MELEE', c.player);
  assert.strictEqual(mode.tierOf(floorBot), 0,
    'demotion at tier 0 must clamp at tier 0, never produce a negative tier');
  assert.notStrictEqual(mode.tierOf(floorBot), CORE.GUN_GAME_KNIFE,
    'demotion at tier 0 must never map to the knife sentinel value (-1)');
});

test('regression [knife tier]: terminal knife kill wins the match, not a gun-only kill at tier 19', () => {
  // Reaching the knife tier is not enough; only a MELEE kill while holding the
  // knife wins.  A gun kill (impossible in practice: no gun) or a grenade kill
  // must not settle the match.
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];
  clearSpawnProtection(c);

  const bots = c.enemies.filter(e => e.team && e.team.indexOf('ffa_') === 0);
  const prey = bots[0];
  prey.spawnProtectionT = 0;

  // Advance the player to tier 19 (knife).
  mode.setTier(c.player, 19);
  assert.strictEqual(mode.isOver(), false, 'being on the knife tier alone must not end the match');

  // A non-credited (grenade) kill must not advance and must not win.
  // Use prey[0] for the uncredited kill (bot dies, respawns with protection).
  c.damageEnemy(prey, 10000, prey.pos, false, false, undefined, c.player);
  assert.strictEqual(mode.tierOf(c.player), 19, 'an uncredited kill at knife tier must not overflow the ladder');
  assert.strictEqual(mode.isOver(), false, 'an uncredited kill at knife tier must not settle the match');

  // The melee (knife) kill wins — use a DIFFERENT bot (prey[0] is now dead/respawning).
  const prey2 = bots[1];
  prey2.spawnProtectionT = 0;
  c.damageEnemy(prey2, 10000, prey2.pos, false, false, 'MELEE', c.player);
  assert.strictEqual(mode.tierOf(c.player), 19, 'the ladder must never overflow past tier 19');
  assert.strictEqual(mode.isOver(), true, 'a credited melee kill at tier 19 must win the match');
});

test('review R2: production bot update consumes earned gun cadence, damage and knife-only reach', () => {
  const pending = [], traces = [];
  const c = createFullMatchContext({ setTimeout: fn => pending.push(fn), spawnTracer: (...args) => traces.push(args), flashLight: noop });
  addProductionWeapons(c);
  c.CFG.weapons = vm.runInNewContext(source('10_config_world.js').match(/weapons:\s*(\[[\s\S]*?\n  \]),/)[1]);
  modeSettings(c); c.setActiveMode('gun-game');
  const m = c.MODES['gun-game']; m.setup(); clearSpawnProtection(c);
  const [bot, target] = ffaBots(c);
  for (const b of ffaBots(c)) if (b !== bot && b !== target) b.dead = true;
  c.nextEstepT = Infinity; c.started = true; c.paused = false;
  c.player.pos.set(45, 1.7, 45);
  target.pos.set(0, 0, 10); target.health = 10000; target.nextShot = Infinity;
  bot.pos.set(0, 0, 0); bot.state = 'strafe'; bot._losCache = true; bot.nextShot = 0;
  c.Math.random = () => 0;
  m.setTier(bot, 4);
  c.gameT = 10; c.updateEnemies(0.016);
  assert.equal(traces.length, 1, 'earned firearm must fire through production update ' + JSON.stringify({kind:bot.kind,state:bot.state,next:bot.nextShot,range:c.CFG.ai.rangedRange,los:bot._losCache}));
  const w = c.CFG.weapons[bot.ggWeapon];
  assert.ok(Math.abs(bot.nextShot - (10 + 60 / w.rpm)) < 1e-8, 'earned weapon RPM sets cadence');
  const hp = target.health; pending.splice(0).forEach(fn => fn());
  assert.equal(hp - target.health, w.dmg * (w.pellets || 1), 'earned weapon damage is applied, not archetype damage');
  bot.nextShot = 0; bot.state = 'strafe';
  c.gameT = 11; c.updateEnemies(0.016);
  assert.equal(pending.length, 1, 'production gun shot must retain an in-flight impact');
  m.setTier(bot, 19); bot.kind = 1; bot.nextShot = 0; bot.state = 'strafe';
  target.health = 1; pending.splice(0).forEach(fn => fn());
  assert.equal(target.dead, true);
  assert.equal(m.winner, null, 'real delayed firearm impact cannot become terminal melee');
  target.dead = false; target.health = 10000; target.respawnT = Infinity;
  target.spawnProtectionT = 0;
  const shotsBeforeKnife = traces.length;
  c.gameT = 20; c.updateEnemies(0.016);
  assert.equal(traces.length, shotsBeforeKnife, 'knife tier must never fire');
  assert.equal(pending.length, 0, 'knife tier must not queue projectile damage');
  assert.equal(bot.state, 'chase', 'knife bot must close distance rather than strafe at rifle range');
  target.pos.set(bot.pos.x, bot.pos.y, bot.pos.z + 1.5); target.health = 1;
  c.gameT = 21; c.updateEnemies(0.016);
  c.gameT = 22; c.updateEnemies(0.5);
  assert.equal(target.dead, true, 'knife bot must land actual close-range melee damage');
  assert.equal(m.winner, bot, 'production melee kill must credit terminal win');
});

test('review R3: bot terminal knife win defeats player tied at tier 19', () => {
  const c = createFullMatchContext(); addProductionWeapons(c); modeSettings(c); c.setActiveMode('gun-game');
  const m = c.MODES['gun-game']; m.setup(); clearSpawnProtection(c);
  const [killer, victim] = ffaBots(c); m.setTier(c.player, 19); m.setTier(killer, 19);
  c.damageEnemy(victim, 10000, victim.pos, false, false, 'MELEE', killer);
  assert.equal(m.winner, killer); assert.equal(m.isOver(), true);
  assert.equal(m.outcome().title, 'DEFEAT');
  assert.equal(c.$id('match-end-title').textContent, 'DEFEAT');
});

test('review R4: real knife pose updates without a gun and clears on transitions/death', () => {
  const c = createWeaponsContext();
  // Real animation module, with renderer-only material/mesh dependencies stubbed.
  c.TEX = { gunNoise: {}, camo: {} }; c.SKY_ENV = null;
  c.THREE.MeshStandardMaterial = function(p) { Object.assign(this,p); };
  c.THREE.Vector2 = Vector3;
  c.THREE.Color = function() { this.multiplyScalar = () => this; };
  c.THREE.MeshBasicMaterial = c.THREE.MeshStandardMaterial;
  c.THREE.Scene = Group; c.THREE.DirectionalLight = c.THREE.HemisphereLight = Group;
  c.THREE.Quaternion = function() {}; c.LIGHT_COMPAT = 1;
  const buildGun = c.buildGunModel, disposeGun = c.disposeGunModel, flash = c.vmFlash;
  vm.runInContext(source('32_viewmodels.js'), c);
  c.buildGunModel = buildGun; c.disposeGunModel = disposeGun; c.vmFlash = flash;
  c._knife = new Group(); c._knife.visible = false;
  c._knife.rotation.set = function(x,y,z) { Object.assign(this,{x,y,z}); };
  vm.runInContext('knifeGroup=_knife; weaponsOwned[0]=-1; curWeapon=0; wState[0]=null; buildViewmodel(); meleeSwing=0.7;', c);
  // Execute the real frame, not just the viewmodel helper: its gunGroup gate
  // previously prevented the knife-only pose from ever being updated.
  Object.assign(c, { requestAnimationFrame: noop, lastT: 0, contextLost: false,
    runtimeTelemetry: { enabled: false }, fpsAcc: 0, fpsN: 0,
    pressed: {}, started: true, paused: true, slideFov: 0,
    renderer: {}, renderFrame: noop, _camPosOut: {}, swayX: 0,
    window: { innerWidth: 1280, innerHeight: 720 },
    getSetting: key => key === 'fov' ? 90 : false });
  c.camera = { position: new Vector3(), fov: 90, rotation: {}, updateProjectionMatrix: noop };
  Object.assign(c.player, { pos: new Vector3(), bobPhase: 0, bobAmp: 0, yaw: 0, pitch: 0, recoilY: 0 });
  const main = source('70_main.js');
  vm.runInContext(main.slice(main.indexOf('function frame(now)'), main.indexOf('\napplyAllSettings();')), c);
  const rendered = [];
  c.scene = {}; c.POST = { enabled: false, kick: 0 };
  Object.assign(c.renderer, { setRenderTarget: noop, clearDepth: noop,
    render: scene => rendered.push(scene) });
  const postfx = source('65_postfx.js');
  vm.runInContext(postfx.slice(postfx.indexOf('function renderWorld()')), c);
  c.frame(16);
  assert.equal(c._knife.visible, true, 'actual knife must be visible without gunGroup');
  assert.ok(rendered.includes(vm.runInContext('gunScene', c)), 'real renderer must draw knife-only viewmodel scene');
  const before = c._knife.position.x;
  vm.runInContext('meleeSwing=0.4;', c); c.updateViewmodel(1/60);
  assert.notEqual(c._knife.position.x, before, 'actual knife pose must animate');
  c.player.dead = true; c.frame(32); assert.equal(c._knife.visible, false);
  c.player.dead = false;
  vm.runInContext('meleeSwing=0; weaponsOwned[0]=0; buildViewmodel();', c);
  assert.equal(c._knife.visible, false, 'gun rebuild must not retain stale visible knife');
  vm.runInContext('weaponsOwned[0]=-1; buildViewmodel();', c); c.updateViewmodel(1/60);
  assert.equal(c._knife.visible, false, 'idle knife must not retain previous swing');
});

test('review R5: rebuilt real FFA menu selects persisted two-kill limit', () => {
  const c = createFullMatchContext(), nodes = [];
  const create = c.document.createElement;
  c.document.createElement = tag => { const n = create(tag); nodes.push(n); return n; };
  modeSettings(c, { ffaScoreLimit: 2 }); c.setActiveMode('ffa');
  c.buildTdmSettingsRow(); c.buildTdmSettingsRow();
  const picks = nodes.filter(n => n.id === 'ffa-score-2');
  assert.equal(picks.length, 2, 'each rebuilt menu must contain the persisted option');
  assert.ok(picks.every(n => n.className.split(' ').includes('on')), 'saved limit must be visibly selected');
  assert.equal(c.getSetting('ffaScoreLimit'), 2);
});

test('review R1: terminal tier rejects firearm and delayed firearm kills', () => {
  for (const type of ['AR', 'bullet', undefined]) {
    const pending = [];
    const c = createFullMatchContext({ setTimeout: fn => pending.push(fn) });
    addProductionWeapons(c); modeSettings(c); c.setActiveMode('gun-game');
    const m = c.MODES['gun-game']; m.setup(); clearSpawnProtection(c);
    const victim = ffaBots(c)[0];
    // A shot already in flight must retain its firearm identity at impact.
    c.setTimeout(() => c.damageEnemy(victim, 10000, victim.pos, false, false, type, c.player));
    m.setTier(c.player, 19);
    pending.shift()();
    assert.equal(victim.dead, true);
    assert.equal(m.isOver(), false, String(type) + ' must not win the knife tier');
    assert.equal(m.winner, null);
    const next = ffaBots(c).find(b => !b.dead);
    c.damageEnemy(next, 10000, next.pos, false, false, 'MELEE', c.player);
    assert.equal(m.winner, c.player);
    assert.equal(c.$id('match-end-title').textContent, 'VICTORY');
  }
});

test('regression [knife tier]: match settlement freeze persists after knife-tier terminal kill', () => {
  const c = createFullMatchContext();
  addProductionWeapons(c);
  modeSettings(c);
  c.setActiveMode('gun-game');
  c.MODES['gun-game'].setup();
  const mode = c.MODES['gun-game'];
  clearSpawnProtection(c);

  mode.setTier(c.player, 19);
  const prey = c.enemies.find(e => e.team && e.team.indexOf('ffa_') === 0);
  prey.spawnProtectionT = 0;
  c.damageEnemy(prey, 10000, prey.pos, false, false, 'MELEE', c.player);
  assert.strictEqual(mode.isOver(), true, 'match must be settled');

  // Any further damage must be ignored.
  const prey2 = c.enemies.find(e => e.team && e.team.indexOf('ffa_') === 0 && e !== prey);
  if (prey2) {
    prey2.spawnProtectionT = 0;
    const healthBefore = prey2.health;
    c.damageEnemy(prey2, 5000, prey2.pos, false, false, 'MELEE', c.player);
    assert.strictEqual(prey2.health, healthBefore, 'damage must be frozen after terminal knife kill');
    assert.strictEqual(prey2.dead, false, 'settled match must not allow further kills');
  }

  // Timer must stop.
  const timeBefore = mode.timeLeft;
  mode.update(5);
  assert.strictEqual(mode.timeLeft, timeBefore, 'the timer must freeze after settlement');
});

// ---------------------------------------------------------------- Milestone 3: Map Registry
test('milestone 3: runtime MAPS registry and activeMap switching', () => {
  const c = createFullMatchContext();
  assert.ok(c.MAPS, 'c.MAPS registry must exist');
  assert.ok(c.MAPS.urban, 'c.MAPS.urban must be registered');
  assert.ok(c.MAPS.snowy, 'c.MAPS.snowy must be registered');
  assert.strictEqual(typeof c.getActiveMap, 'function');
  assert.strictEqual(typeof c.setActiveMap, 'function');

  // Initial active map defaults to urban
  assert.strictEqual(c.getActiveMap().id, 'urban');

  // Switch to snowy
  const snowy = c.setActiveMap('snowy');
  assert.strictEqual(snowy.id, 'snowy');
  assert.strictEqual(c.getActiveMap().id, 'snowy');

  // Switch back to urban
  const urban = c.setActiveMap('urban');
  assert.strictEqual(urban.id, 'urban');
  assert.strictEqual(c.getActiveMap().id, 'urban');

  // Invalid map falls back to urban
  const fallback = c.setActiveMap('nonexistent');
  assert.strictEqual(fallback.id, 'urban');
});

test('milestone 3: Survival checkpoint preserves mapId and resumes under activeMap safely', () => {
  const c = createFullMatchContext();
  c.setActiveMap('urban');
  c.waveNum = 5;
  c.score = 1200;

  const cp = c.captureRunState();
  assert.ok(cp, 'checkpoint must be captured');
  assert.strictEqual(cp.mapId, 'urban', 'checkpoint must record active mapId');

  // Resume checkpoint
  c.loadCheckpoint = () => cp;
  c.resumeRun();
  assert.strictEqual(c.getActiveMap().id, 'urban', 'resumed run must maintain urban map');
  assert.strictEqual(c.activeModeId, 'survival', 'resumed run must maintain survival mode');

  // Checkpoint with snowy map
  const cpSnowy = Object.assign({}, cp, { mapId: 'snowy' });
  c.loadCheckpoint = () => cpSnowy;
  c.resumeRun();
  assert.strictEqual(c.getActiveMap().id, 'snowy', 'resumed run must restore snowy map');

  // Legacy checkpoint without mapId restores urban
  const cpLegacy = Object.assign({}, cp);
  delete cpLegacy.mapId;
  c.loadCheckpoint = () => cpLegacy;
  c.resumeRun();
  assert.strictEqual(c.getActiveMap().id, 'urban', 'legacy checkpoint must default to urban map');
});

test('milestone 3: Domination flags and openSpawnPoints source from activeMap', () => {
  const c = createFullMatchContext();
  c.setActiveMap('urban');
  const urbanFlags = c.buildDominationFlags();
  assert.strictEqual(urbanFlags.length, 3);
  assert.deepStrictEqual([urbanFlags[0].x, urbanFlags[0].z], [-18, 0]);

  c.setActiveMap('snowy');
  const snowyFlags = c.buildDominationFlags();
  assert.strictEqual(snowyFlags.length, 3);
  const snowyDef = CORE.getMapDef('snowy');
  assert.deepStrictEqual([snowyFlags[0].x, snowyFlags[0].z], [snowyDef.dominationFlags[0].x, snowyDef.dominationFlags[0].z]);

  // Spawns
  const spawns = c.openSpawnPoints();
  assert.ok(Array.isArray(spawns) && spawns.length >= 12);
  assert.deepStrictEqual(spawns[0], snowyDef.spawnPoints[0]);
});

test('regression [P1]: map-switch lifecycle rebuilds geometry, stations, barriers, nav in both directions and team deployment', () => {
  const c = createFullMatchContext();
  c.setActiveMap('urban', true);

  // Initially on urban
  assert.strictEqual(c.getActiveMap().id, 'urban');
  assert.strictEqual(c.stations.length, 17, 'stations must exist');
  assert.ok(c.stations.some(s => s.district === 'ne'), 'urban stations include ne door station');

  // Switch urban -> snowy
  c.setActiveMap('snowy');
  assert.strictEqual(c.getActiveMap().id, 'snowy');
  assert.strictEqual(c.stations.length, 17, 'snowy station layout must have 17 stations');
  const hangarStation = c.stations.find(s => s.district === 'hangar');
  const depotStation = c.stations.find(s => s.district === 'depot');
  assert.ok(hangarStation, 'snowy stations must preserve hangar district identifier');
  assert.ok(depotStation, 'snowy stations must preserve depot district identifier');

  // Verify snowy barriers and colliders rebuilt
  const snowyDef = CORE.getMapDef('snowy');
  const urbanDef = CORE.getMapDef('urban');
  // Check colliders reflect snowy, not urban: snowy anchor center slab at (0, -4)
  assert.ok(c.colliders.some(b => Math.abs((b.min.x + b.max.x) / 2 - 0) < 0.1 && Math.abs((b.min.z + b.max.z) / 2 - (-4)) < 0.1 && (b.max.x - b.min.x) > 15),
    'colliders must include snowy anchor center slab at (0, -4)');
  // Check urban warehouse at (28, -28) is NOT in colliders
  assert.ok(!c.colliders.some(b => Math.abs((b.min.x + b.max.x) / 2 - 28) < 0.1 && Math.abs((b.min.z + b.max.z) / 2 - (-28)) < 0.1 && (b.max.x - b.min.x) > 10),
    'colliders must not retain urban warehouse after switching to snowy');

  // Team-mode deployment under snowy (TDM)
  c.setActiveMode('tdm');
  c.MODES.tdm.setup();
  assert.ok(c.MODES.tdm.roster.length > 0, 'tdm roster must be populated');
  // Spawns used by bots must come from snowy
  const snowySpawns = snowyDef.spawnPoints;
  const botSpawn = c.matchSpawnPointAt(0);
  assert.deepStrictEqual(botSpawn, snowySpawns[0], 'bot spawn must match snowy spawn point');

  // Team-mode deployment under snowy (Domination)
  c.setActiveMode('domination');
  c.MODES.domination.setup();
  assert.strictEqual(c.MODES.domination.flags.length, 3, 'domination must have 3 flags');
  assert.deepStrictEqual([c.MODES.domination.flags[0].x, c.MODES.domination.flags[0].z], [snowyDef.dominationFlags[0].x, snowyDef.dominationFlags[0].z]);
  assert.deepStrictEqual([c.MODES.domination.flags[1].x, c.MODES.domination.flags[1].z], [snowyDef.dominationFlags[1].x, snowyDef.dominationFlags[1].z]);
  assert.deepStrictEqual([c.MODES.domination.flags[2].x, c.MODES.domination.flags[2].z], [snowyDef.dominationFlags[2].x, snowyDef.dominationFlags[2].z]);

  // Switch snowy -> urban
  c.setActiveMap('urban');
  assert.strictEqual(c.getActiveMap().id, 'urban');
  assert.strictEqual(c.stations.length, 17, 'urban station layout must have 17 stations');
  assert.ok(c.stations.some(s => s.district === 'ne'), 'urban stations restored');
  assert.ok(!c.stations.some(s => s.district === 'hangar'), 'snowy hangar station removed');

  // Verify urban colliders restored
  assert.ok(c.colliders.some(b => Math.abs((b.min.x + b.max.x) / 2 - 28) < 0.1 && Math.abs((b.min.z + b.max.z) / 2 - (-28)) < 0.1 && (b.max.x - b.min.x) > 10),
    'colliders must restore urban warehouse when switching back to urban');
  assert.ok(!c.colliders.some(b => Math.abs((b.min.x + b.max.x) / 2 - 0) < 0.1 && Math.abs((b.min.z + b.max.z) / 2 - (-4)) < 0.1 && (b.max.x - b.min.x) > 15),
    'snowy anchor slab must not exist in urban colliders');
});

test('regression [P1]: snowy district barriers wire into purchase, opening, resetting with real colliders and navigation', () => {
  const c = createFullMatchContext();
  c.setActiveMap('snowy');

  // Verify hangar and depot stations exist with district tags
  const hangarSt = c.stations.find(s => s.district === 'hangar');
  const depotSt = c.stations.find(s => s.district === 'depot');
  assert.ok(hangarSt && depotSt, 'both hangar and depot stations must exist');

  // Initial state: districts are closed
  assert.ok(c.doorMeshes['hangar'], 'hangar door mesh must exist');
  assert.ok(c.doorMeshes['depot'], 'depot door mesh must exist');
  assert.ok(c.doorColliders['hangar'], 'hangar door collider must exist');
  assert.ok(c.doorColliders['depot'], 'depot door collider must exist');

  // Navigation into hangar and depot is blocked when closed
  const nav1 = c.rebuildNavGrid();
  CORE.computeFlowField(nav1, 0, -4);
  const dHangarClosed = CORE.navDistanceAt(nav1, 26, -26);
  assert.strictEqual(dHangarClosed, CORE.UNREACHABLE, 'hangar interior must be unreachable when door is closed');
  const dDepotClosed = CORE.navDistanceAt(nav1, -26, 21);
  assert.strictEqual(dDepotClosed, CORE.UNREACHABLE, 'depot interior must be unreachable when door is closed');

  // Purchase/open hangar
  c.openDistrict('hangar');
  assert.ok(c.openDistricts.includes('hangar'), 'hangar is open');
  assert.ok(!c.colliders.includes(c.doorColliders['hangar']), 'hangar door collider removed from colliders');

  // Navigation into hangar is now reachable
  const nav2 = c.rebuildNavGrid();
  CORE.computeFlowField(nav2, 0, -4);
  const dHangarOpen = CORE.navDistanceAt(nav2, 26, -26);
  assert.ok(dHangarOpen > 0 && dHangarOpen < 1000, 'hangar interior must be reachable when door is open');
  assert.strictEqual(CORE.navDistanceAt(nav2, -26, 21), CORE.UNREACHABLE, 'depot must still be unreachable');

  // Purchase/open depot
  c.openDistrict('depot');
  assert.ok(c.openDistricts.includes('depot'), 'depot is open');
  assert.ok(!c.colliders.includes(c.doorColliders['depot']), 'depot door collider removed from colliders');

  // Navigation into depot is now reachable
  const nav3 = c.rebuildNavGrid();
  CORE.computeFlowField(nav3, 0, -4);
  const dDepotOpen = CORE.navDistanceAt(nav3, -26, 21);
  assert.ok(dDepotOpen > 0 && dDepotOpen < 1000, 'depot interior must be reachable when door is open');

  // Reset districts: both doors restored and nav blocked again
  c.resetDistricts();
  assert.strictEqual(c.openDistricts.length, 0, 'openDistricts cleared on reset');
  assert.ok(c.colliders.includes(c.doorColliders['hangar']), 'hangar door collider restored to colliders');
  assert.ok(c.colliders.includes(c.doorColliders['depot']), 'depot door collider restored to colliders');
  const nav4 = c.rebuildNavGrid();
  CORE.computeFlowField(nav4, 0, -4);
  assert.strictEqual(CORE.navDistanceAt(nav4, 26, -26), CORE.UNREACHABLE, 'hangar interior blocked again after reset');
  assert.strictEqual(CORE.navDistanceAt(nav4, -26, 21), CORE.UNREACHABLE, 'depot interior blocked again after reset');
});

test('regression [P1]: Survival checkpoint save/load/resume restores snowy arena and purchased districts', () => {
  const c = createFullMatchContext();
  c.setActiveMap('snowy');
  c.openDistrict('hangar');
  c.waveNum = 6;
  c.score = 2500;

  const cp = c.captureRunState();
  assert.strictEqual(cp.mapId, 'snowy', 'captured state mapId must be snowy');
  assert.ok(cp.openDistricts.includes('hangar'), 'captured state openDistricts must include hangar');

  // Simulate starting from fresh urban environment and resuming checkpoint
  const c2 = createFullMatchContext();
  assert.strictEqual(c2.getActiveMap().id, 'urban', 'fresh context starts at urban');

  c2.loadCheckpoint = () => cp;
  c2.resumeRun();

  assert.strictEqual(c2.getActiveMap().id, 'snowy', 'resumed run must restore snowy map');
  assert.ok(c2.openDistricts.includes('hangar'), 'resumed run must restore openDistricts with hangar');
  // Check physical arena restoration: Snowy anchor slab present, urban warehouse absent
  assert.ok(c2.colliders.some(b => Math.abs((b.min.x + b.max.x) / 2 - 0) < 0.1 && Math.abs((b.min.z + b.max.z) / 2 - (-4)) < 0.1 && (b.max.x - b.min.x) > 15),
    'resumed run must restore snowy anchor slab in colliders');
  assert.ok(!c2.colliders.some(b => Math.abs((b.min.x + b.max.x) / 2 - 28) < 0.1 && Math.abs((b.min.z + b.max.z) / 2 - (-28)) < 0.1 && (b.max.x - b.min.x) > 10),
    'resumed run must not retain urban warehouse in colliders');
  // Check that hangar door collider is open (not in colliders)
  assert.ok(c2.doorColliders['hangar'], 'hangar door collider definition exists');
  assert.ok(!c2.colliders.includes(c2.doorColliders['hangar']), 'hangar door collider must be open in real colliders');
  // Check nav grid reachable into hangar
  const nav = c2.rebuildNavGrid();
  CORE.computeFlowField(nav, 0, -4);
  const dHangar = CORE.navDistanceAt(nav, 26, -26);
  assert.ok(dHangar > 0 && dHangar < 1000, 'hangar interior must be reachable in resumed snowy run');
});

test('milestone 3: deploy-screen map selector UI, activeMap switching, and per-map best score display', () => {
  const c = createFullMatchContext();

  // 1. Initial state defaults to urban
  assert.strictEqual(c.activeMapId, 'urban');

  // Verify buildMapPickerRow is implemented and creates map buttons
  assert.strictEqual(typeof c.buildMapPickerRow, 'function', 'buildMapPickerRow must be implemented');
  c.buildMapPickerRow();

  const urbanBtn = c.$id('map-btn-urban');
  const snowyBtn = c.$id('map-btn-snowy');
  assert.ok(urbanBtn, 'map-btn-urban must exist');
  assert.ok(snowyBtn, 'map-btn-snowy must exist');

  // Urban button is highlighted
  assert.ok(urbanBtn.className.includes('on'), 'urban button must have on class initially');
  assert.ok(!snowyBtn.className.includes('on'), 'snowy button must not have on class initially');

  // 2. Click snowy button to switch map
  snowyBtn.click();
  assert.strictEqual(c.activeMapId, 'snowy', 'activeMapId must switch to snowy');
  assert.strictEqual(c.getActiveMap().id, 'snowy', 'getActiveMap must return snowy');
  assert.strictEqual(c._settings.gameMap, 'snowy', 'gameMap setting must be updated to snowy');

  // UI state after switch
  c.buildMapPickerRow();
  assert.ok(!c.$id('map-btn-urban').className.includes('on'), 'urban button must no longer have on class');
  assert.ok(c.$id('map-btn-snowy').className.includes('on'), 'snowy button must have on class');

  // 3. Subtitle displays per-map best score when career stats exist
  c.STATS = {
    bestScore: 5000,
    runs: 5,
    mapStats: {
      snowy: { bestScore: 3400, bestWave: 8 },
      urban: { bestScore: 5000, bestWave: 12 }
    }
  };
  c.buildMapPickerRow();
  assert.ok(c.$id('map-btn-snowy').innerHTML.includes('3400'), 'snowy button must show snowy best score in subtitle');
  assert.ok(c.$id('map-btn-urban').innerHTML.includes('5000'), 'urban button must show urban best score in subtitle');

  // 4. Secondary weapon selection hides map-row
  c.buildGunSelect(0);
  assert.strictEqual(c.$id('map-row').style.display, 'flex', 'map-row must be visible when selecting primary');
  c.buildGunSelect(1);
  assert.strictEqual(c.$id('map-row').style.display, 'none', 'map-row must be hidden when selecting secondary');
});

test('milestone 3: procedural snowy textures and sky preset application on activeMap switch', () => {
  const c = createFullMatchContext();

  // 1. Verify production texture implementations generated from src/08_textures.js
  assert.ok(c.TEX.snow, 'TEX.snow must exist');
  assert.ok(c.TEX.snow.map && c.TEX.snow.map.image, 'TEX.snow.map with canvas image must exist');
  assert.ok(c.TEX.snow.normalMap && c.TEX.snow.normalMap.image, 'TEX.snow.normalMap with canvas image must exist');
  assert.ok(c.TEX.frostedMetal && c.TEX.frostedMetal.map, 'TEX.frostedMetal must exist');
  assert.ok(c.TEX.frostedWood && c.TEX.frostedWood.map, 'TEX.frostedWood must exist');
  assert.ok(c.TEX.asphalt && c.TEX.asphalt.map, 'TEX.asphalt must exist');

  // Verify snow footprint generation in height data
  assert.ok(c.TEX.snow.heightCanvas, 'TEX.snow must expose generated height canvas');
  const hData = c.TEX.snow.heightCanvas.getContext('2d').getImageData(0, 0, 512, 512).data;
  let footprintPixels = 0;
  for (let i = 0; i < hData.length; i += 4) {
    if (hData[i] === 0x68) footprintPixels++; // #686868 = 104
  }
  assert.ok(footprintPixels > 500, `TEX.snow height data must contain footprint depression pixels (#686868), got ${footprintPixels}`);

  // Check normal map generated from height field
  const normalData = c.TEX.snow.normalMap.image.getContext('2d').getImageData(0, 0, 512, 512).data;
  let normalDeviations = 0;
  for (let i = 0; i < normalData.length; i += 4) {
    if (Math.abs(normalData[i] - 128) > 10 || Math.abs(normalData[i + 1] - 128) > 10) normalDeviations++;
  }
  assert.ok(normalDeviations > 1000, `TEX.snow normal map must reflect surface variations, got ${normalDeviations}`);

  // 2. Exercise production applyMapSkyPreset from src/10_config_world.js in snowy direction
  assert.strictEqual(typeof c.applyMapSkyPreset, 'function', 'applyMapSkyPreset must be defined');
  const snowyDef = CORE.getMapDef('snowy');
  const urbanDef = CORE.getMapDef('urban');

  c.applyMapSkyPreset('snowy');
  // Ground material
  assert.strictEqual(c.groundMat.map, c.TEX.snow.map, 'snowy ground must use TEX.snow.map');
  assert.strictEqual(c.groundMat.normalMap, c.TEX.snow.normalMap, 'snowy ground must use TEX.snow.normalMap');
  assert.strictEqual(c.groundMat.color.hex, 0xe8f0f8, 'snowy ground color must be tuned');
  assert.strictEqual(c.groundMat.roughness, 0.88, 'snowy ground roughness must be tuned');
  assert.strictEqual(c.groundMat.needsUpdate, true);
  // Sky uniforms
  assert.strictEqual(c.SKY_UNIFORMS.top.value.hex, snowyDef.sky.top, 'snowy sky top uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.mid.value.hex, snowyDef.sky.mid, 'snowy sky mid uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.horizon.value.hex, snowyDef.sky.horizon, 'snowy sky horizon uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.low.value.hex, snowyDef.sky.low, 'snowy sky low uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.sunDir.value.x, snowyDef.sky.sunDir[0]);
  assert.strictEqual(c.SKY_UNIFORMS.sunDir.value.y, snowyDef.sky.sunDir[1]);
  assert.strictEqual(c.SKY_UNIFORMS.sunDir.value.z, snowyDef.sky.sunDir[2]);
  // Background and Fog
  assert.strictEqual(c.scene.background.hex, snowyDef.sky.skyColor, 'snowy scene background must match skyColor');
  assert.strictEqual(c.scene.fog.color.hex, snowyDef.sky.fogColor, 'snowy fog color must match fogColor');
  // Sun and SUN_OFFSET
  assert.strictEqual(c.sun.color.hex, snowyDef.sky.sunColor, 'snowy sun color must match sunColor');
  assert.strictEqual(c.sun.position.x, snowyDef.sky.sunPos[0], 'snowy sun position x must match sunPos');
  assert.strictEqual(c.sun.position.y, snowyDef.sky.sunPos[1], 'snowy sun position y must match sunPos');
  assert.strictEqual(c.sun.position.z, snowyDef.sky.sunPos[2], 'snowy sun position z must match sunPos');
  assert.strictEqual(c.SUN_OFFSET.x, snowyDef.sky.sunPos[0], 'snowy SUN_OFFSET x must match sunPos');
  assert.strictEqual(c.SUN_OFFSET.y, snowyDef.sky.sunPos[1], 'snowy SUN_OFFSET y must match sunPos');
  assert.strictEqual(c.SUN_OFFSET.z, snowyDef.sky.sunPos[2], 'snowy SUN_OFFSET z must match sunPos');

  // 3. Exercise production applyMapSkyPreset from src/10_config_world.js in urban direction
  c.applyMapSkyPreset('urban');
  // Ground material
  assert.strictEqual(c.groundMat.map, c.TEX.asphalt.map, 'urban ground must restore TEX.asphalt.map');
  assert.strictEqual(c.groundMat.normalMap, c.TEX.asphalt.normalMap, 'urban ground must restore TEX.asphalt.normalMap');
  assert.strictEqual(c.groundMat.color.hex, 0x767c8e, 'urban ground color must be restored');
  assert.strictEqual(c.groundMat.roughness, 0.92, 'urban ground roughness must be restored');
  assert.strictEqual(c.groundMat.needsUpdate, true);
  // Sky uniforms
  assert.strictEqual(c.SKY_UNIFORMS.top.value.hex, urbanDef.sky.top, 'urban sky top uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.mid.value.hex, urbanDef.sky.mid, 'urban sky mid uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.horizon.value.hex, urbanDef.sky.horizon, 'urban sky horizon uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.low.value.hex, urbanDef.sky.low, 'urban sky low uniform must match map definition');
  assert.strictEqual(c.SKY_UNIFORMS.sunDir.value.x, urbanDef.sky.sunDir[0]);
  assert.strictEqual(c.SKY_UNIFORMS.sunDir.value.y, urbanDef.sky.sunDir[1]);
  assert.strictEqual(c.SKY_UNIFORMS.sunDir.value.z, urbanDef.sky.sunDir[2]);
  // Background and Fog
  assert.strictEqual(c.scene.background.hex, urbanDef.sky.skyColor, 'urban scene background must match skyColor');
  assert.strictEqual(c.scene.fog.color.hex, urbanDef.sky.fogColor, 'urban fog color must match fogColor');
  // Sun and SUN_OFFSET
  assert.strictEqual(c.sun.color.hex, urbanDef.sky.sunColor, 'urban sun color must match sunColor');
  assert.strictEqual(c.sun.position.x, urbanDef.sky.sunPos[0], 'urban sun position x must match sunPos');
  assert.strictEqual(c.sun.position.y, urbanDef.sky.sunPos[1], 'urban sun position y must match sunPos');
  assert.strictEqual(c.sun.position.z, urbanDef.sky.sunPos[2], 'urban sun position z must match sunPos');
  assert.strictEqual(c.SUN_OFFSET.x, urbanDef.sky.sunPos[0], 'urban SUN_OFFSET x must match sunPos');
  assert.strictEqual(c.SUN_OFFSET.y, urbanDef.sky.sunPos[1], 'urban SUN_OFFSET y must match sunPos');
  assert.strictEqual(c.SUN_OFFSET.z, urbanDef.sky.sunPos[2], 'urban SUN_OFFSET z must match sunPos');
});

test('regression [P2]: src/08_textures.js snow footprint generation draws on height canvas and produces depression height data', () => {
  const c = createFullMatchContext();
  assert.ok(c.TEX.snow, 'TEX.snow must exist');
  assert.ok(c.TEX.snow.heightCanvas, 'TEX.snow.heightCanvas must exist');
  const hData = c.TEX.snow.heightCanvas.getContext('2d').getImageData(0, 0, 512, 512).data;
  let count104 = 0;
  for (let i = 0; i < hData.length; i += 4) {
    if (hData[i] === 0x68) count104++; // #686868
  }
  assert.ok(count104 > 500, `Footprint depressions (#686868) must reach height field, found ${count104}`);
});

test('milestone 3: full Survival gameplay lifecycle on Snowy Compound with active combat, enemies, and per-map stat recording', () => {
  const c = createFullMatchContext();
  c.setActiveMap('snowy');
  c.setActiveMode('survival');
  c.resetGame();

  // Player must spawn at Snowy spawn coordinates
  const snowyDef = CORE.getMapDef('snowy');
  assert.strictEqual(c.player.pos.x, snowyDef.playerSpawn.x);
  assert.strictEqual(c.player.pos.z, snowyDef.playerSpawn.z);

  // Spawn enemy and verify active combat
  const enemy = {
    id: 'snowy_enemy_1',
    team: 'enemy',
    kind: 0,
    health: 100,
    maxHealth: 100,
    dead: false,
    speedMul: 1,
    pos: new Vector3(snowyDef.playerSpawn.x + 5, 0.9, snowyDef.playerSpawn.z),
    vel: new Vector3(),
    yaw: 0,
    parts: c.dummyParts()
  };
  c.enemies.push(enemy);

  // Hostile engagement: enemy detects player, has LOS, and attacks
  c.updateEnemies(0.1);
  assert.ok(enemy.target === c.player, 'enemy must acquire player as target on Snowy Compound');

  // Player damages enemy on Snowy Compound
  c.damageEnemy(enemy, 50, enemy.pos, false, false, 'AR', c.player);
  assert.strictEqual(enemy.health, 50);

  // Eliminate enemy
  c.damageEnemy(enemy, 60, enemy.pos, false, false, 'AR', c.player);
  assert.strictEqual(enemy.dead, true);
  assert.strictEqual(c.kills, 1);
  assert.ok(c.score > 0);

  // Record run on Snowy Compound and verify map-specific career stats
  c.recordRun({
    mapId: 'snowy',
    score: 1800,
    wave: 4,
    kills: 1,
    accuracy: 60
  });

  assert.strictEqual(c.STATS.mapStats.snowy.bestScore, 1800, 'recordRun must store score under snowy mapStats');
  assert.strictEqual(c.STATS.mapStats.snowy.bestWave, 4, 'recordRun must store wave under snowy mapStats');
});

test('milestone 3: Snowy atmospheric VFX, viewmodel breath mist, and ice-patch slide lifecycle in match context', () => {
  const c = createFullMatchContext();
  c.setActiveMap('snowy');

  // 1. Surface resolution on Snowy vs Urban
  assert.strictEqual(c.fxSurfaceFor(c.ground), 'snow', 'ground must resolve to snow surface on Snowy Compound');
  c.setActiveMap('urban');
  assert.strictEqual(c.fxSurfaceFor(c.ground), 'ground', 'ground must resolve to ground surface on Urban District');
  c.setActiveMap('snowy');

  // 2. Ice patch detection and extended slide lifecycle
  const snowyDef = CORE.getMapDef('snowy');
  const patch = snowyDef.icePatches[0];
  const midX = (patch.minX + patch.maxX) / 2;
  const midZ = (patch.minZ + patch.maxZ) / 2;

  // Move player to ice patch
  c.player.pos.set(midX, 0.9, midZ);
  c.player.vel.set(8.0, 0, 0);
  c.player.onGround = true;
  c.player.sliding = true;
  c.player.slideT = 1.05; // beyond standard 0.9s duration

  const onIce = CORE.isPositionOnIce(c.player.pos.x, c.player.pos.z, c.getActiveMap().id);
  assert.strictEqual(onIce, true, 'player position must be detected on ice patch');

  const standardExpired = CORE.isSlideExpired(c.player.slideT, true, true, CORE.SLIDE_TIMEOUT_T, CORE.SLIDE_STOP_MIN_T);
  const iceExpired = CORE.isSlideExpired(c.player.slideT, true, true, CORE.slideTimeout(onIce), CORE.SLIDE_STOP_MIN_T);
  assert.strictEqual(standardExpired, true, 'slide at 1.05s must be expired under standard timeout');
  assert.strictEqual(iceExpired, false, 'slide at 1.05s must NOT be expired under ice timeout');

  // 3. Footstep audio dispatch on ice vs snow vs urban
  c.lastPlayedSound = null;
  c.playSound = function(name) { c.lastPlayedSound = name; };

  // Footstep on ice
  c.stepT = 0;
  c.updateFootsteps(0.1);
  assert.strictEqual(c.lastPlayedSound, 'step_ice', 'footstep on ice patch must play step_ice');

  // Footstep on snow (outside ice patch)
  c.player.pos.set(0, 0.9, -4);
  c.stepT = 0;
  c.updateFootsteps(0.1);
  assert.strictEqual(c.lastPlayedSound, 'step_snow', 'footstep on snow ground must play step_snow');

  // Footstep on urban
  c.setActiveMap('urban');
  c.player.pos.set(0, 0.9, 0);
  c.stepT = 0;
  c.updateFootsteps(0.1);
  assert.strictEqual(c.lastPlayedSound, 'step', 'footstep on urban ground must play step');

  // 4. Bullet impact acoustics on snow and ice surfaces (src/50_vfx_audio.js:199)
  // Ordinary bullet impacts (src/30_weapons.js:518, 522) pass soundOverride = null to spawnImpact,
  // which routes sound selection through CORE.surfaceImpactSound(surface).
  c.setActiveMap('snowy');
  assert.strictEqual(CORE.surfaceImpactSound(c.fxSurfaceFor(c.ground)), 'impact_snow',
    'bullet impact on snowy ground must select impact_snow');
  const iceObject = { material: c.MAT.ice };
  assert.strictEqual(CORE.surfaceImpactSound(c.fxSurfaceFor(iceObject)), 'impact_ice',
    'bullet impact on ice patch object must select impact_ice');
  c.setActiveMap('urban');
  assert.strictEqual(CORE.surfaceImpactSound(c.fxSurfaceFor(c.ground)), 'impact_ground',
    'bullet impact on urban ground must select impact_ground');
});

test('milestone 4: Survival lifecycle and team-hostility interaction with Defend objective generator', () => {
  const c = useProductionWaveLifecycle(createFullMatchContext());
  // Wire required audio/VFX and streak hooks
  c.streakBank = [];
  c.credits = 0;
  c.score = 0;
  c.lastCenterMsg = null;
  c.showCenterMsg = function(m) { c.lastCenterMsg = m; };

  // 1. Objective wave 4 initiates Defend objective
  c.startWave(4);
  assert.ok(c.objective, 'wave 4 must spawn an objective');
  assert.strictEqual(c.objective.type, 'defend', 'wave 4 objective must be defend');
  assert.ok(c.objective.target, 'defend objective must have a target entity');
  assert.strictEqual(c.objective.target.team, 'friendly', 'defend target must belong to friendly team');
  assert.strictEqual(c.objective.target.health, 500, 'defend target must have 500 HP');
  assert.strictEqual(c.objective.target.isObjectiveTarget, true);

  // 2. Team-hostility: hostile enemy targets generator when closer than player
  const targetPos = c.objective.target.pos;
  c.player.pos.set(targetPos.x + 40, 0, targetPos.z + 40); // player far away
  const bot = { kind: 0, team: 'enemy', pos: new c.THREE.Vector3(targetPos.x + 3, 0, targetPos.z + 3), health: 100, maxHealth: 100, dead: false, parts: c.dummyParts() };
  bot.pos.set(targetPos.x + 3, 0, targetPos.z + 3); // enemy close to generator
  c.enemies.push(bot);

  const hostileTarget = c.findNearestHostileActor(bot);
  assert.strictEqual(hostileTarget, c.objective.target, 'enemy must target the generator when closer than player');

  // 3. Enemy attacks generator, generator takes damage
  const hpBefore = c.objective.target.health;
  c.damageObjectiveTarget(c.objective.target, 50, bot);
  assert.strictEqual(c.objective.target.health, hpBefore - 50, 'generator must take damage from enemy attack');

  // 4. If generator health reaches 0: generator destroyed, objective fails, but game does NOT end
  c.damageObjectiveTarget(c.objective.target, 500, bot);
  assert.strictEqual(c.objective.target.dead, true, 'generator must be dead at 0 HP');
  assert.strictEqual(c.objective.failed, true, 'defend objective must be marked failed');
  assert.strictEqual(c.gameEnded, false, 'destruction of generator must not end the Survival run');

  // 5. Conversely: when generator survives and wave clears, awards credits + free scorestreak
  const c2 = useProductionWaveLifecycle(createFullMatchContext());
  c2.streakBank = [];
  c2.credits = 0;
  c2.score = 0;
  c2.startWave(4);
  assert.strictEqual(c2.objective.type, 'defend');
  assert.strictEqual(c2.streakBank.length, 0);

  // Clear all living enemies so wave clears
  c2.waveQueue = 0;
  c2.enemies.length = 0;
  c2.updateWaves(0.1);

  assert.strictEqual(c2.objectivesCompleted, 1, 'defend objective must complete upon wave clear');
  assert.ok(c2.credits >= CORE.OBJECTIVE_CREDITS, 'completion must award bonus credits');
  assert.strictEqual(c2.streakBank.length, 1, 'completion must award one free scorestreak');
});

test('milestone 4: Survival lifecycle with Retrieve and Demolition objectives', () => {
  // 1. Retrieve objective
  const c = useProductionWaveLifecycle(createFullMatchContext());
  c.streakBank = [];
  c.credits = 0;
  c.startWave(8); // wave 8 rotates to retrieve
  assert.ok(c.objective && c.objective.type === 'retrieve', 'wave 8 must be retrieve objective');
  assert.ok(c.objective.intel, 'retrieve objective must have an intel case');
  assert.ok(c.objective.dropoff, 'retrieve objective must have a dropoff location');
  assert.strictEqual(c.objective.intel.pickedUp, false);

  // Move player to intel location: picks it up
  c.player.pos.set(c.objective.intel.x, 0, c.objective.intel.z);
  c.updateObjective(0.1);
  assert.strictEqual(c.objective.intel.pickedUp, true, 'player touching intel must pick it up');

  // Move player to dropoff location: delivers it
  c.player.pos.set(c.objective.dropoff.x, 0, c.objective.dropoff.z);
  c.updateObjective(0.1);
  assert.strictEqual(c.objective.done, true, 'player reaching dropoff with intel must complete retrieve objective');
  assert.strictEqual(c.streakBank.length, 1, 'retrieve completion must award free scorestreak');

  // 2. Demolition objective
  const c2 = useProductionWaveLifecycle(createFullMatchContext());
  c2.streakBank = [];
  c2.credits = 0;
  c2.startWave(12); // wave 12 rotates to demolition
  assert.ok(c2.objective && c2.objective.type === 'demolition', 'wave 12 must be demolition objective');
  assert.strictEqual(c2.objective.sites.length, 2, 'demolition objective must have 2 mortar sites');
  assert.strictEqual(c2.objective.sites[0].planted, false);
  assert.strictEqual(c2.objective.sites[1].planted, false);

  // Plant site 0
  c2.player.pos.set(c2.objective.sites[0].x, 0, c2.objective.sites[0].z);
  c2.updateObjective(3.5); // plant time is 3.0s
  assert.strictEqual(c2.objective.sites[0].planted, true, 'site 0 must be planted');
  assert.strictEqual(c2.objective.done, false, 'demolition requires both sites');

  // Plant site 1
  c2.player.pos.set(c2.objective.sites[1].x, 0, c2.objective.sites[1].z);
  c2.updateObjective(3.5);
  assert.strictEqual(c2.objective.sites[1].planted, true, 'site 1 must be planted');
  assert.strictEqual(c2.objective.done, true, 'all sites planted must complete demolition');
  assert.strictEqual(c2.streakBank.length, 1, 'demolition completion must award free scorestreak');
});

test('ground objectives do not interact through an upper floor', () => {
  const c = useProductionWaveLifecycle(createFullMatchContext());
  const groundY = c.CFG.player.height;
  c.startObjective(8, 'retrieve');
  let pos = c.objective.intel;
  c.player.pos.set(pos.x, groundY + 4, pos.z);
  c.updateObjective(1);
  assert.equal(c.objective.intel.pickedUp, false, 'upper floor cannot pick up intel');
  c.player.pos.y = groundY;
  c.updateObjective(1);
  assert.equal(c.objective.intel.pickedUp, true, 'same floor can pick up intel');
  pos = c.objective.dropoff;
  c.player.pos.set(pos.x, groundY + 4, pos.z);
  c.updateObjective(1);
  assert.equal(c.objective.done, false, 'upper floor cannot deliver intel');
  c.player.pos.y = groundY;
  c.updateObjective(1);
  assert.equal(c.objective.done, true, 'same floor can deliver intel');
  c.startObjective(12, 'demolition');
  pos = c.objective.sites[0];
  c.player.pos.set(pos.x, groundY + 4, pos.z);
  c.updateObjective(3.1);
  assert.equal(pos.planted, false, 'upper floor cannot plant');
  c.player.pos.y = groundY;
  c.updateObjective(3.1);
  assert.equal(pos.planted, true, 'same floor can plant');
  c.startObjective(14, 'hold');
  pos = c.objective;
  c.player.pos.set(pos.x, groundY + 4, pos.z);
  c.updateObjective(1);
  assert.equal(pos.t, 0, 'upper floor cannot hold ground zone');
  c.player.pos.y = groundY;
  c.updateObjective(1);
  assert.ok(pos.t > 0, 'same floor can hold ground zone');
});

test('fresh reset clears the previous run objective count', () => {
  const c = createFullMatchContext();
  c.objectivesCompleted = 2;
  c.resetGame();
  assert.strictEqual(c.objectivesCompleted, 0);
});

function useProductionWaveLifecycle(c) {
  const src = source('60_hud_waves.js');
  vm.runInContext(src.slice(src.indexOf('function settleClearedWave()'), src.indexOf('// Zero ammo means zero kills')), c);
  vm.runInContext(src.slice(src.indexOf('function startWave(n)'), src.indexOf('// Blackout drops')), c);
  vm.runInContext(src.slice(src.indexOf('function spawnFromQueue()'), src.indexOf('function resupply()')), c);
  const settings = source('02_settings.js');
  const storage = new Map();
  c.STORE_KEY_SAVE = 'checkpoint';
  c.storageSet = (key, value) => { storage.set(key, JSON.stringify(value)); return true; };
  c.storageGet = key => storage.has(key) ? JSON.parse(storage.get(key)) : null;
  vm.runInContext(settings.slice(settings.indexOf('function saveCheckpoint(state)'), settings.indexOf('function statsSummaryHtml()')), c);
  c.aliveEnemies = () => c.enemies.filter(e => !e.dead).length;
  c.reviveFromDown = () => {};
  c.unlockSecondary = () => {};
  c.resupply = () => {};
  c.updateWaveCountdown = () => {};
  c.CFG.wave.victoryWave = 15;
  c.CFG.wave.baseCount = 3;
  c.CFG.wave.growth = 1;
  c.CFG.score.waveClear = 100;
  c.hud.enemiesLeft = { textContent: '' };
  c.diff = () => ({ count: 1 });
  return c;
}

test('production wave clear does not revive unfinished objectives on resume', () => {
  for (const map of ['urban', 'snowy']) {
    for (const type of ['retrieve', 'demolition', 'hold']) {
      const c = useProductionWaveLifecycle(createFullMatchContext());
      c.setActiveMap(map, true);
      c.startWave(4);
      c.startObjective(4, type);
      c.waveQueue = 0;
      c.updateWaves(0);
      assert.ok(c.loadCheckpoint(), `${map}/${type} must persist a checkpoint`);
      c.resumeRun();
      assert.ok(!c.objective || c.objective.done || c.objective.failed, `${map}/${type} must not resume active`);
      const completed = c.objectivesCompleted;
      c.updateWaves(4);
      assert.equal(c.waveNum, 5, `${map}/${type} advances through production startWave`);
      assert.equal(c.objectivesCompleted, completed, `${map}/${type} must not earn a late completion`);
    }
  }
});

test('legacy between-wave checkpoint cannot reactivate an unfinished objective', () => {
  const c = useProductionWaveLifecycle(createFullMatchContext());
  c.startWave(8);
  c.saveCheckpoint(c.captureRunState());
  c.resumeRun();
  assert.ok(!c.objective || c.objective.done || c.objective.failed);
});

test('wave 14 starts Hold in a finite run on both maps', () => {
  for (const map of ['urban', 'snowy']) {
    const c = useProductionWaveLifecycle(createFullMatchContext());
    c.setActiveMap(map, true);
    c.startWave(14);
    assert.equal(c.objective.type, 'hold');
  }
});

test('destroyed generator stays failed across real wave clear and resume on both maps', () => {
  for (const map of ['urban', 'snowy']) {
    const c = useProductionWaveLifecycle(createFullMatchContext());
    c.setActiveMap(map, true);
    c.startWave(4);
    c.damageObjectiveTarget(c.objective.target, 1000, { team: 'enemy' });
    assert.equal(c.objective.failed, true);
    c.waveQueue = 0;
    c.updateWaves(0);
    assert.equal(c.loadCheckpoint().objectiveState.failed, true);
    c.resumeRun();
    assert.equal(c.objective.failed, true);
    c.updateWaves(4);
    assert.equal(c.waveNum, 5);
    assert.equal(c.objectivesCompleted, 0);
    assert.equal(c.streakBank.length, 0);
  }
});

test('milestone 4: Survival checkpoint save and resume preserves objective state and completed stats', () => {
  const c = createFullMatchContext();
  c.waveNum = 4;
  c.objectivesCompleted = 1;
  c.objective = { type: 'defend', done: true, failed: false };

  const state = c.captureRunState();
  assert.strictEqual(state.objectivesCompleted, 1);
  assert.deepStrictEqual(state.objectiveState, { type: 'defend', done: true, failed: false });

  const saved = c.saveCheckpoint(state);
  assert.strictEqual(saved, true);
  const loaded = c.loadCheckpoint();
  assert.strictEqual(loaded.objectivesCompleted, 1);
  assert.deepStrictEqual(loaded.objectiveState, { type: 'defend', done: true, failed: false });

  // 1. Resume completed objective checkpoint via resumeRun
  c.objectivesCompleted = 0;
  c.objective = null;
  c.resumeRun();
  assert.strictEqual(c.objectivesCompleted, 1, 'resumeRun must restore objectivesCompleted');
  assert.ok(c.objective, 'resumeRun must restore objective into live run');
  assert.strictEqual(c.objective.type, 'defend');
  assert.strictEqual(c.objective.done, true);
  assert.strictEqual(c.objective.failed, false);

  // 2. Legacy unfinished wave-boundary data is historical, not active on resume.
  const activeState = Object.assign({}, state, {
    objectiveState: { type: 'defend', done: false, failed: false, hp: 350 }
  });
  c.saveCheckpoint(activeState);
  c.objective = null;
  c.resumeRun();
  assert.ok(c.objective, 'resumeRun must retain historical objective data');
  assert.strictEqual(c.objective.type, 'defend');
  assert.strictEqual(c.objective.done, true);
  assert.strictEqual(c.objective.failed, true);

  // 3. Real gameplay wave-clear checkpoint save captures objectiveState before clearing
  const cLive = useProductionWaveLifecycle(createFullMatchContext());
  cLive.streakBank = [];
  cLive.credits = 0;
  cLive.score = 0;
  cLive.startWave(4);
  assert.strictEqual(cLive.objective.type, 'defend');
  cLive.waveQueue = 0;
  cLive.enemies.length = 0;
  cLive.updateWaves(0.1);

  const liveCp = cLive.loadCheckpoint();
  assert.ok(liveCp, 'gameplay wave clear must save a checkpoint');
  assert.strictEqual(liveCp.objectivesCompleted, 1, 'gameplay checkpoint must record objectivesCompleted');
  assert.ok(liveCp.objectiveState, 'gameplay checkpoint must capture objectiveState before clearing');
  assert.strictEqual(liveCp.objectiveState.type, 'defend');
  assert.strictEqual(liveCp.objectiveState.done, true);
});

test('milestone 4 PR12: integration regressions for objective checkpoint round-trip, position fidelity, planted/pickedUp state, and wave-clear order across urban and snowy maps', () => {
  // 1. Defend objective: round-trip must preserve target position, HP, and visual mesh on Urban map
  const cDef = useProductionWaveLifecycle(createFullMatchContext());
  cDef.startWave(4);
  assert.strictEqual(cDef.objective.type, 'defend');
  const defendOrigX = cDef.objective.x;
  const defendOrigZ = cDef.objective.z;
  const defendOrigHp = cDef.objective.target.health;
  assert.strictEqual(defendOrigHp, 500);

  // Damage generator
  cDef.damageObjectiveTarget(cDef.objective.target, 120, { pos: new Vector3(0, 0, 0) });
  assert.strictEqual(cDef.objective.target.health, 380);

  // Capture production state & round-trip via makeCheckpoint / validateCheckpoint
  const defState = cDef.captureRunState();
  assert.strictEqual(defState.objectiveState.type, 'defend');
  assert.strictEqual(defState.objectiveState.x, defendOrigX, 'defState must record defend target x');
  assert.strictEqual(defState.objectiveState.z, defendOrigZ, 'defState must record defend target z');
  assert.strictEqual(defState.objectiveState.hp, 380, 'defState must record defend target hp');

  const defSaved = cDef.saveCheckpoint(defState);
  assert.strictEqual(defSaved, true);
  const defLoaded = cDef.loadCheckpoint();
  assert.strictEqual(defLoaded.objectiveState.x, defendOrigX, 'loaded defend checkpoint must retain x');
  assert.strictEqual(defLoaded.objectiveState.z, defendOrigZ, 'loaded defend checkpoint must retain z');
  assert.strictEqual(defLoaded.objectiveState.hp, 380, 'loaded defend checkpoint must retain hp');

  // Exercise rehydration directly: checkpoints are otherwise resumed between waves only.
  cDef.player.pos.set(90, 0, -80);
  cDef.objective = null;
  cDef.resumeRun();
  cDef.restoreObjective(defLoaded.objectiveState);
  assert.ok(cDef.objective, 'resumed run must have objective');
  assert.strictEqual(cDef.objective.type, 'defend');
  assert.strictEqual(cDef.objective.x, defendOrigX, 'resumed defend objective must match original x');
  assert.strictEqual(cDef.objective.z, defendOrigZ, 'resumed defend objective must match original z');
  assert.strictEqual(cDef.objective.target.pos.x, defendOrigX, 'resumed defend target pos.x must match');
  assert.strictEqual(cDef.objective.target.pos.z, defendOrigZ, 'resumed defend target pos.z must match');
  assert.strictEqual(cDef.objective.target.health, 380, 'resumed defend target health must match');
  assert.strictEqual(cDef.objMeshes.length, 1, 'resumed defend must have exactly 1 visual mesh');
  assert.strictEqual(cDef.objMeshes[0].position.x, defendOrigX, 'defend mesh must match original x');

  // 2. Retrieve objective: round-trip must preserve intel position, dropoff position, and pickedUp flag on Snowy map
  const cRet = useProductionWaveLifecycle(createFullMatchContext());
  cRet.setActiveMap('snowy', true);
  cRet.startWave(8);
  assert.strictEqual(cRet.objective.type, 'retrieve');
  const retIntelX = cRet.objective.intel.x;
  const retIntelZ = cRet.objective.intel.z;
  const retDropX = cRet.objective.dropoff.x;
  const retDropZ = cRet.objective.dropoff.z;
  assert.strictEqual(cRet.objective.intel.pickedUp, false);
  assert.strictEqual(cRet.objMeshes.length, 1, 'intel mesh must be spawned in scene initially');

  // Player secures intel
  cRet.player.pos.set(retIntelX, 0, retIntelZ);
  cRet.updateObjective(0.1);
  assert.strictEqual(cRet.objective.intel.pickedUp, true, 'intel must be picked up');
  assert.strictEqual(cRet.objMeshes.length, 0, 'intel mesh must be removed from scene on pickup');

  // Capture & validate checkpoint with pickedUp = true
  const retState = cRet.captureRunState();
  assert.strictEqual(retState.objectiveState.type, 'retrieve');
  assert.strictEqual(retState.objectiveState.intel.pickedUp, true, 'retState must record pickedUp=true');
  assert.strictEqual(retState.objectiveState.intel.x, retIntelX, 'retState must record intel x');
  assert.strictEqual(retState.objectiveState.dropoff.x, retDropX, 'retState must record dropoff x');

  cRet.saveCheckpoint(retState);
  const retLoaded = cRet.loadCheckpoint();
  assert.strictEqual(retLoaded.objectiveState.intel.pickedUp, true, 'loaded checkpoint must preserve pickedUp=true');
  assert.strictEqual(retLoaded.objectiveState.intel.x, retIntelX);
  assert.strictEqual(retLoaded.objectiveState.dropoff.x, retDropX);

  // Direct rehydration: pickedUp remains true without regenerating a ground mesh.
  cRet.player.pos.set(50, 0, 50);
  cRet.objective = null;
  cRet.resumeRun();
  cRet.restoreObjective(retLoaded.objectiveState);
  assert.strictEqual(cRet.objective.type, 'retrieve');
  assert.strictEqual(cRet.objective.intel.pickedUp, true, 'resumed retrieve must have pickedUp=true');
  assert.strictEqual(cRet.objective.intel.x, retIntelX, 'resumed intel x matches');
  assert.strictEqual(cRet.objective.dropoff.x, retDropX, 'resumed dropoff x matches');
  assert.strictEqual(cRet.objMeshes.length, 0, 'resumed retrieve with pickedUp=true must not spawn ground mesh');

  // Deliver intel to dropoff: exactly-once reward
  const retCreditsBefore = cRet.credits;
  cRet.player.pos.set(retDropX, 0, retDropZ);
  cRet.updateObjective(0.1);
  assert.strictEqual(cRet.objective.done, true, 'reaching dropoff must complete retrieve objective');
  assert.strictEqual(cRet.credits, retCreditsBefore + 900, 'must award 900 credits');
  assert.strictEqual(cRet.objectivesCompleted, 1, 'must increment objectivesCompleted');
  assert.strictEqual(cRet.streakBank.length, 1, 'must award free streak');

  // Subsequent update must not award reward again
  cRet.updateObjective(0.1);
  assert.strictEqual(cRet.credits, retCreditsBefore + 900, 'credits must not increase again');
  assert.strictEqual(cRet.objectivesCompleted, 1, 'objectivesCompleted must not increase again');

  // 3. Demolition objective: round-trip must preserve both site positions, planted flags, and progress
  const cDemo = useProductionWaveLifecycle(createFullMatchContext());
  cDemo.startWave(12);
  assert.strictEqual(cDemo.objective.type, 'demolition');
  assert.strictEqual(cDemo.objective.sites.length, 2);
  const site0x = cDemo.objective.sites[0].x;
  const site0z = cDemo.objective.sites[0].z;
  const site1x = cDemo.objective.sites[1].x;
  const site1z = cDemo.objective.sites[1].z;
  assert.strictEqual(cDemo.objMeshes.length, 2, 'both mortar sites must have meshes initially');

  // Plant site 0
  cDemo.player.pos.set(site0x, 0, site0z);
  cDemo.updateObjective(3.1);
  assert.strictEqual(cDemo.objective.sites[0].planted, true, 'site 0 must be planted');
  assert.strictEqual(cDemo.objective.sites[1].planted, false, 'site 1 must not be planted');

  // Partial plant progress on site 1
  cDemo.player.pos.set(site1x, 0, site1z);
  cDemo.updateObjective(1.5);
  assert.ok(cDemo.objective.sites[1].t >= 1.4 && cDemo.objective.sites[1].t <= 1.6, 'site 1 timer ~1.5s');

  // Checkpoint round-trip
  const demoState = cDemo.captureRunState();
  assert.strictEqual(demoState.objectiveState.type, 'demolition');
  assert.strictEqual(demoState.objectiveState.sites[0].planted, true, 'demoState preserves site 0 planted');
  assert.strictEqual(demoState.objectiveState.sites[0].x, site0x);
  assert.strictEqual(demoState.objectiveState.sites[1].planted, false);
  assert.strictEqual(demoState.objectiveState.sites[1].x, site1x);
  assert.ok(demoState.objectiveState.sites[1].t >= 1.4, 'demoState preserves site 1 timer');

  cDemo.saveCheckpoint(demoState);
  const demoLoaded = cDemo.loadCheckpoint();
  assert.strictEqual(demoLoaded.objectiveState.sites[0].planted, true);
  assert.strictEqual(demoLoaded.objectiveState.sites[0].x, site0x);
  assert.strictEqual(demoLoaded.objectiveState.sites[1].planted, false);
  assert.strictEqual(demoLoaded.objectiveState.sites[1].x, site1x);
  assert.ok(demoLoaded.objectiveState.sites[1].t >= 1.4);

  // Direct rehydration: site 0 remains planted and site 1 timer is preserved.
  cDemo.player.pos.set(0, 0, 0);
  cDemo.objective = null;
  cDemo.resumeRun();
  cDemo.restoreObjective(demoLoaded.objectiveState);
  assert.strictEqual(cDemo.objective.type, 'demolition');
  assert.strictEqual(cDemo.objective.sites[0].planted, true, 'resumed site 0 must be planted');
  assert.strictEqual(cDemo.objective.sites[0].x, site0x);
  assert.strictEqual(cDemo.objective.sites[1].planted, false, 'resumed site 1 must be unplanted');
  assert.strictEqual(cDemo.objective.sites[1].x, site1x);
  assert.ok(cDemo.objective.sites[1].t >= 1.4, 'resumed site 1 timer preserved');
  const activeMortars = cDemo.objMeshes.filter(m => m !== null);
  assert.strictEqual(activeMortars.length, 1, 'only unplanted site must have a visual mesh');
  assert.strictEqual(activeMortars[0].position.x, site1x, 'visual mesh must be at site 1 position');

  // Finish planting site 1
  cDemo.player.pos.set(site1x, 0, site1z);
  cDemo.updateObjective(1.6);
  assert.strictEqual(cDemo.objective.sites[1].planted, true, 'site 1 must now be planted');
  assert.strictEqual(cDemo.objective.done, true, 'both sites planted completes demolition');

  // 4. Hold objective: round-trip must preserve zone position and progress timer t
  const cHold = useProductionWaveLifecycle(createFullMatchContext());
  cHold.startWave(16);
  assert.strictEqual(cHold.objective.type, 'hold');
  const holdX = cHold.objective.x;
  const holdZ = cHold.objective.z;

  cHold.player.pos.set(holdX, 0, holdZ);
  cHold.updateObjective(25.0);
  assert.strictEqual(cHold.objective.t, 25.0, 'hold progress must reach 25s');

  const holdState = cHold.captureRunState();
  assert.strictEqual(holdState.objectiveState.type, 'hold');
  assert.strictEqual(holdState.objectiveState.x, holdX);
  assert.strictEqual(holdState.objectiveState.z, holdZ);
  assert.strictEqual(holdState.objectiveState.t, 25.0);

  cHold.saveCheckpoint(holdState);
  const holdLoaded = cHold.loadCheckpoint();
  assert.strictEqual(holdLoaded.objectiveState.x, holdX);
  assert.strictEqual(holdLoaded.objectiveState.z, holdZ);
  assert.strictEqual(holdLoaded.objectiveState.t, 25.0);

  cHold.player.pos.set(80, 0, 80);
  cHold.objective = null;
  cHold.resumeRun();
  cHold.restoreObjective(holdLoaded.objectiveState);
  assert.strictEqual(cHold.objective.type, 'hold');
  assert.strictEqual(cHold.objective.x, holdX, 'resumed hold x matches');
  assert.strictEqual(cHold.objective.z, holdZ, 'resumed hold z matches');
  assert.strictEqual(cHold.objective.t, 25.0, 'resumed hold timer matches');
  assert.ok(cHold.objRing, 'resumed hold must have objRing');
  assert.strictEqual(cHold.objRing.position.x, holdX);

  // Finish holding remaining 35s
  cHold.player.pos.set(holdX, 0, holdZ);
  cHold.updateObjective(35.0);
  assert.strictEqual(cHold.objective.done, true, 'hold completes at 60s');

  // 5. Wave clear checkpoint ordering, next-wave resume, and no double reward
  const cWave = useProductionWaveLifecycle(createFullMatchContext());
  cWave.startWave(4);
  cWave.waveQueue = 0;
  cWave.enemies.length = 0;
  cWave.updateWaves(0.1); // clears wave 4!

  assert.strictEqual(cWave.waveActive, false, 'wave must clear');
  assert.strictEqual(cWave.objectivesCompleted, 1, 'defend completed on wave clear');
  assert.strictEqual(cWave.objective, null, 'objective cleared from live run');

  const waveCp = cWave.loadCheckpoint();
  assert.strictEqual(waveCp.wave, 4, 'checkpoint recorded wave 4');
  assert.strictEqual(waveCp.objectivesCompleted, 1);
  assert.strictEqual(waveCp.objectiveState.done, true);
  const savedCredits = waveCp.credits;

  // Resuming wave 4 clear checkpoint: must not replay or double reward
  cWave.resumeRun();
  assert.strictEqual(cWave.waveNum, 4, 'resumed waveNum is 4');
  assert.strictEqual(cWave.waveActive, false, 'waiting for wave 5');
  assert.strictEqual(cWave.objectivesCompleted, 1, 'objectivesCompleted must remain 1');
  assert.strictEqual(cWave.credits, savedCredits, 'credits must not change');
  assert.strictEqual(cWave.objMeshes.length, 0, 'no meshes for completed objective');

  // Countdown elapses -> wave 5 starts cleanly without objective
  cWave.updateWaves(cWave.betweenWaveT + 0.5);
  assert.strictEqual(cWave.waveActive, true, 'wave 5 must be active');
  assert.strictEqual(cWave.waveNum, 5, 'waveNum must be 5');
  assert.strictEqual(cWave.objectivesCompleted, 1, 'objectivesCompleted remains 1');
  assert.strictEqual(cWave.objective, null, 'wave 5 has no objective');

  // 6. Match checkpoint rejection & legacy/invalid state sanitization
  const cTdm = createFullMatchContext();
  cTdm.setActiveMode('tdm');
  assert.strictEqual(cTdm.saveCheckpoint({ wave: 1 }), false, 'TDM mode must reject saving checkpoint');

  const corruptCp = {
    v: 3, wave: 4, weapons: [{ gi: 0, ammo: 30, reserve: 90 }],
    objectiveState: { type: 'corrupted_unknown', x: 'bad', hp: -99 }
  };
  const validatedCorrupt = CORE.validateCheckpoint(corruptCp, 4, 100);
  assert.ok(validatedCorrupt);
  assert.strictEqual(validatedCorrupt.objectiveState, null, 'unknown objective type must be rejected to null');
});

for (const [index, entry] of CORE.ENEMY_KIND_UNLOCK.entries()) {
  test(`PR13 R5 production spawn queue creates ${entry.name} in surge and normal waves`, () => {
    const c = useProductionWaveLifecycle(createFullMatchContext());
    c.startWave(15);
    // A special wave must not override the surge roster.
    c.waveSpecial = { kinds: [0] };
    c.Math.random = () => (index + 0.5) / CORE.ENEMY_KIND_UNLOCK.length;
    c.spawnFromQueue();
    let enemy = c.enemies[c.enemies.length - 1];
    assert.equal(enemy.kind, entry.kind, `surge must create ${entry.name}`);
    assert.equal(enemy.hitBody.userData.enemyRef, enemy, 'production spawnEnemy initializes hitboxes');
    assert.ok(Number.isFinite(enemy.health) && enemy.health > 0);

    c.extraction = null;
    c.waveSpecial = null;
    const roster = CORE.enemyKindsAtWave(15);
    const total = roster.reduce((sum, e) => sum + e.weight, 0);
    const before = roster.slice(0, index).reduce((sum, e) => sum + e.weight, 0);
    c.Math.random = () => (before + entry.weight / 2) / total;
    c.spawnFromQueue();
    enemy = c.enemies[c.enemies.length - 1];
    assert.equal(enemy.kind, entry.kind, `normal wave must create ${entry.name}`);
    assert.equal(enemy.hitBody.userData.enemyRef, enemy);
    assert.ok(Number.isFinite(enemy.health) && enemy.health > 0);
  });
}

test('milestone 4: Survival Wave 15 extraction finale lifecycle with surge, all archetypes, LZ arrival, rotor wash, and victory cinematic', () => {
  const c = useProductionWaveLifecycle(createFullMatchContext());
  c.streakBank = [];
  c.credits = 0;
  c.score = 0;
  c.lastCenterMsg = null;
  c.showCenterMsg = function(m) { c.lastCenterMsg = m; };

  // 1. Wave 15 triggers Extraction protocol
  c.startWave(15);
  assert.ok(c.extraction, 'Wave 15 in survival must initialize extraction');
  assert.strictEqual(c.extraction.phase, 'surge', 'initial extraction phase must be surge');
  assert.strictEqual(c.extraction.surgeTimer, CORE.EXTRACTION_SURGE_TIME, 'surgeTimer must start at 90s');
  assert.ok(c.extraction.lz, 'extraction must define LZ location');
  assert.strictEqual(typeof c.extraction.lz.x, 'number');
  assert.strictEqual(typeof c.extraction.lz.z, 'number');
  assert.ok(c.extraction.helicopter, 'helicopter mesh must be created');
  assert.ok(c.extraction.smokeMarker, 'LZ smoke marker must be created');

  // 2. Surge spawns draw across the production roster.
  const kindsSpawned = new Set();
  const roster = CORE.ENEMY_KIND_UNLOCK;
  for (let i = 0; i < roster.length; i++) {
    c.Math.random = () => (i + 0.5) / roster.length;
    c.spawnFromQueue();
    const lastSpawned = c.enemies[c.enemies.length - 1];
    if (lastSpawned) kindsSpawned.add(lastSpawned.kind);
  }
  for (const entry of roster) {
    assert.ok(kindsSpawned.has(entry.kind), 'surge must spawn ' + entry.name + ' (' + entry.kind + ')');
  }

  // 3. 90s surge countdown in updateWaves
  c.updateWaves(45.0);
  assert.strictEqual(c.extraction.phase, 'surge');
  assert.strictEqual(c.extraction.surgeTimer, 45.0);

  // Complete surge
  c.updateWaves(45.1);
  assert.strictEqual(c.extraction.phase, 'lz', 'surge completion must transition to lz phase');
  // Helicopter descends to ground level
  c.updateWaves(5.0);
  assert.ok(c.extraction.helicopter.position.y <= 1.5, 'helicopter must land at LZ');

  // 4. Player reaches LZ
  c.player.pos.set(c.extraction.lz.x + 2.0, 0, c.extraction.lz.z + 2.0); // within 5m
  c.updateWaves(0.1);
  assert.strictEqual(c.extraction.phase, 'cinematic', 'player reaching LZ must transition to cinematic phase');
  assert.strictEqual(c.player.invulnerable, true, 'player must be invulnerable during extraction cinematic');

  // 5. Cinematic advances and triggers victory
  c.updateWaves(1.5);
  assert.strictEqual(c.gameEnded, false, 'cinematic still playing at 1.5s');
  c.updateWaves(1.6);
  assert.strictEqual(c.gameEnded, true, 'cinematic completing must end game with victory');
  assert.strictEqual(c.extraction, null, 'extraction state cleared after victory');

  // 6. Checkpoint records settled victory
  const cp = c.loadCheckpoint();
  assert.ok(cp, 'victory must save checkpoint');
  assert.strictEqual(cp.runPhase, 'victory');

  // 7. Clicking endless mode transitions into endless wave 16
  c.document.getElementById('btn-endless').click();
  assert.strictEqual(c.endlessMode, true, 'endlessMode must be true after clicking endless button');
});

function extractionReviewContext() {
  const c = createFullMatchContext();
  const revive = c.reviveFromDown;
  useProductionWaveLifecycle(c);
  c.reviveFromDown = revive;
  const waves = source('60_hud_waves.js');
  vm.runInContext(waves.slice(waves.indexOf('function resupply()'), waves.indexOf('// ---- Secondary weapon unlock')), c);
  c.CFG.grenade.count = 3;
  c.CFG.grenade.countPerWaves = 1;
  c.wState[1] = null;
  c.Math.random = () => 0.5;
  c.startWave(15);
  return c;
}

test('PR13 R4 production minimap tracks extraction direction throughout lifecycle and clears it', () => {
  for (const end of ['restart', 'reset', 'victory']) {
    const c = extractionReviewContext(), calls = [];
    const ctx = new Proxy({}, { get(target, key) {
      return key in target ? target[key] : (...args) => calls.push([key, ...args]);
    } });
    c.hud.minimap = { getContext: () => ctx };
    c.hud.compass = { getContext: () => ctx };
    c.document.createElement = () => ({ getContext: () => ctx });
    c.uavActive = () => false;
    c.getSetting = () => false;
    c.CFG.world = { size: 90 };
    c.stations = []; c.enemies = [];
    c.colliders = [{min: {x: -100, y: 0, z: -10}, max: {x: 0, y: 20, z: 10}}];
    c.extraction.smokeMarker.visible = false;
    const waves = source('60_hud_waves.js');
    vm.runInContext(waves.slice(waves.indexOf('const mmCtx =')), c);
    const marker = () => {
      calls.length = 0; c.drawMinimap();
      return calls.filter(call => call[0] === 'fillText' && call[1] === 'LZ');
    };
    c.player.pos.set(c.extraction.lz.x - 200, 1.7, c.extraction.lz.z);
    c.player.yaw = 0;
    let m = marker();
    assert.equal(m.length, 1, 'surge must show a labelled LZ even beyond minimap range');
    assert.ok(m[0][2] > 75 && Math.hypot(m[0][2] - 75, m[0][3] - 75) < 72, 'distant LZ is clamped inside the map in the correct direction');
    c.player.yaw = Math.PI / 2;
    m = marker();
    assert.ok(m[0][3] > 75 && Math.abs(m[0][2] - 75) < 0.01, 'marker rotates with the map');
    c.updateWaves(90);
    assert.equal(c.extraction.phase, 'lz');
    assert.equal(marker().length, 1, 'LZ remains visible during landing');
    c.player.pos.set(c.extraction.lz.x + 10, 1.7, c.extraction.lz.z);
    c.player.yaw = 0;
    m = marker();
    assert.ok(Math.abs(m[0][2] - (75 - 10 * CORE.minimapScale(75, 90, 8))) < 0.01 && m[0][3] === 75, 'nearby LZ uses its actual relative position');
    if (end === 'restart') {
      c.startExtraction({x: 30, z: 10});
      m = marker();
      assert.equal(m.length, 1, 'replacement has one marker');
      assert.ok(m[0][2] > 75 && m[0][3] > 75, 'replacement follows the new LZ');
      c.clearExtractionVisuals();
    } else if (end === 'reset') {
      c.resetGame();
    } else {
      c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
      c.extraction.helicopter.position.y = 1; c.updateWaves(0.1);
      assert.equal(c.extraction.phase, 'cinematic');
      c.updateWaves(3.1);
    }
    assert.equal(marker().length, 0, `${end} removes the marker`);
    c.setActiveMode('tdm');
    assert.equal(marker().length, 0, 'other modes have no extraction marker');
  }
});

test('PR13 extraction waits for landing with player already at LZ', () => {
  const c = extractionReviewContext();
  c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
  c.updateWaves(90);
  c.updateWaves(0.1);
  assert.equal(c.extraction.phase, 'lz');
  c.updateWaves(5);
  assert.equal(c.extraction.phase, 'cinematic');
});

test('PR13 extraction HUD keeps precedence when hostile counts change', () => {
  const c = extractionReviewContext();
  c.CFG.wave.maxActive = 0;
  c.updateWaves(1);
  assert.equal(c.hud.enemiesLeft.textContent, CORE.extractionHudLabel('surge', 89));
  c.updateWaves(89);
  c.player.pos.set(c.extraction.lz.x + 20, 1.7, c.extraction.lz.z);
  c.waveQueue += 1;
  c.updateWaves(0.1);
  assert.equal(c.hud.enemiesLeft.textContent, CORE.extractionHudLabel('lz', 0, 20));
});

test('PR13 extraction signal uses production particle emitter green colors', () => {
  const c = extractionReviewContext();
  c.THREE.Color = function () { this.setHex = function (hex) {
    this.r = ((hex >> 16) & 255) / 255; this.g = ((hex >> 8) & 255) / 255; this.b = (hex & 255) / 255; return this;
  }; };
  const pfx = source('48_particles.js');
  vm.runInContext('const PF_RISE = 4; const PFX_SMOKE = {cap: 1, cursor: 0, additive: false, pos: [], vel: [], c0: [], c1: [], life: [], maxLife: [], s0: [], s1: [], a0: [], drag: [], grav: [], flags: [], rot: [], rotV: [], size: [], alpha: []};' + pfx.slice(pfx.indexOf('const _pc ='), pfx.indexOf('function updatePfxLayer')), c);
  c.player.pos.set(c.extraction.lz.x + 20, 1.7, c.extraction.lz.z);
  c.updateWaves(90);
  c.updateWaves(0.1);
  const colors = vm.runInContext('[PFX_SMOKE.c0, PFX_SMOKE.c1]', c);
  for (const color of colors) assert.ok(color[1] > color[0] && color[1] > color[2], 'signal smoke must be green');
});

test('PR13 downed extraction survives cinematic frame bleedout', () => {
  const c = extractionReviewContext();
  c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
  c.updateWaves(90);
  c.extraction.helicopter.position.y = 1;
  c.damagePlayer(10000, 0, 'bullet');
  c.updateDowned(CORE.DOWN_TIME - 0.1);
  c.updateWaves(0.2);
  c.updateDowned(0.2);
  assert.equal(c.player.dead, false);
  assert.equal(c.player.downed, false);
});

test('PR13 direct endless continuation removes cinematic damage immunity', () => {
  const c = extractionReviewContext();
  c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
  c.updateWaves(90);
  c.extraction.helicopter.position.y = 1;
  c.updateWaves(0.1);
  c.updateWaves(3.1);
  c.document.getElementById('btn-endless').click();
  c.player.armor = 0;
  const health = c.player.health;
  c.damagePlayer(10, 0, 'bullet');
  assert.ok(c.player.health < health);
});

test('PR13 finale settles and both endless continuation paths take damage and start wave 16', () => {
  for (const resume of [false, true]) {
    const c = extractionReviewContext();
    c.score = 0; c.credits = 0;
    c.wState[0].reserve = 0;
    c.player.armor = 0;
    c.spawnFromQueue();
    assert.ok(c.enemies.length);
    c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
    c.updateWaves(90);
    c.extraction.helicopter.position.y = 1;
    c.updateWaves(0.1);
    c.updateWaves(3.1);
    assert.equal(c.score, CORE.waveClearScore(c.CFG.score.waveClear, 15, CORE.WAVE_SCORE_PER_WAVE));
    assert.equal(c.credits, CORE.creditsForWave(15));
    assert.equal(c.player.armor, c.CFG.player.armor);
    assert.ok(c.wState[0].reserve > 0, 'wave clear resupplies ammunition');
    assert.equal(c.enemies.length, 0);
    const cp = c.loadCheckpoint();
    assert.equal(cp.score, c.score);
    assert.equal(cp.credits, c.credits);
    assert.equal(cp.weapons[0].reserve, c.wState[0].reserve);
    if (resume) c.resumeRun();
    c.document.getElementById('btn-endless').click();
    c.player.armor = 0;
    const health = c.player.health;
    c.damagePlayer(10, 0, 'bullet');
    assert.ok(c.player.health < health, 'endless player must take damage');
    c.updateWaves(c.CFG.wave.startDelay + 0.1);
    assert.equal(c.waveNum, 16);
    assert.equal(c.waveActive, true);
  }
});

for (const continuation of ['direct', 'resumed', 'reset']) {
  test(`PR13 R3 real ordnance and effects are settled on ${continuation}`, () => {
    const c = extractionReviewContext();
    loadGrenadeLifecycle(c);
    const objects = new Set();
    c.scene.add = o => objects.add(o);
    c.scene.remove = o => objects.delete(o);
    c.THREE.RingGeometry = Geometry;
    c.THREE.SphereGeometry = Geometry;
    c.THREE.MeshBasicMaterial = Material;
    c.THREE.Mesh = class extends Mesh {
      constructor(...args) { super(...args); this.scale.setScalar = s => this.scale.set(s, s, s); }
    };
    const src = source('55_grenades.js');
    const range = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
    vm.runInContext(range('const blastRingGeo', '// ---- Live grenade pooling'), c);
    vm.runInContext(range('const burnPatches', '// ---- Blast scorch decals'), c);
    c.clearScorches = noop; c.updateScorches = noop;
    c._burnHitPoint = new Vector3();
    vm.runInContext(range('let playerFlashT = 0', 'const grenadeLosRay'), c);
    const burn = CORE.equipmentByKey('thermite');
    const smoke = CORE.equipmentByKey('smoke');
    c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
    c.updateWaves(90); c.extraction.helicopter.position.y = 1;
    const enemy = {team: 'enemy', pos: new Vector3(c.player.pos.x, 0, c.player.pos.z), dead: false};
    c.CFG.grenade.fuse = 3;
    c.throwEnemyGrenade(enemy, c.player);
    const g = c.liveGrenades[0], mesh = g.m;
    g.fuse = 0.01; g.stuck = true;
    g.ring = c.getBlastRing(); c.scene.add(g.ring);
    const ring = g.ring;
    c.addBurnPatch(c.player.pos.x, c.player.pos.z, burn);
    c.addSmokeCloud(c.player.pos.x, 1, c.player.pos.z, smoke);
    const burnMesh = vm.runInContext('burnPatches[0].m', c);
    const smokeMesh = vm.runInContext('smokeClouds[0].m', c);
    c.equippedLethal = 'thermite'; c.equippedTactical = 'smoke'; c.tacticalCount = 1;
    if (continuation === 'reset') c.resetGame();
    else {
      c.updateWaves(0.1);
      assert.equal(c.extraction.phase, 'cinematic');
      assert.equal(c.liveGrenades.length, 0, 'ordnance is cleared at boarding');
      assert.equal(vm.runInContext('burnPatches.length + smokeClouds.length', c), 0, 'effects are cleared at boarding');
      assert.equal(c.equippedLethal, 'thermite');
      assert.equal(c.equippedTactical, 'smoke');
      assert.equal(c.tacticalCount, 1);
      c.updateWaves(3.1);
      if (continuation === 'resumed') c.resumeRun();
      c.document.getElementById('btn-endless').click();
    }
    assert.equal(c.liveGrenades.length, 0, 'no frozen hostile grenade');
    assert.equal(vm.runInContext('burnPatches.length + smokeClouds.length', c), 0, 'no frozen ground effects');
    for (const o of [mesh, ring, burnMesh, smokeMesh]) assert.equal(objects.has(o), false, 'owned mesh removed');
    assert.equal(g.owner, null, 'pooled record releases owner');
    c.testGrenade = g;
    assert.equal(vm.runInContext('_grenadePool.filter(x => x === testGrenade).length', c), 1);
    c.testRing = ring; c.testBurn = burnMesh; c.testSmoke = smokeMesh;
    assert.equal(vm.runInContext('blastRingPool.filter(x => x === testRing).length', c), 1);
    assert.equal(vm.runInContext('burnPatchPool.filter(x => x === testBurn).length', c), 1);
    assert.equal(vm.runInContext('smokeCloudPool.filter(x => x === testSmoke).length', c), 1);
    c.player.armor = 0;
    const health = c.player.health;
    c.updateGrenades(0.1);
    assert.equal(c.player.health, health, 'old grenade cannot explode after continuation');
  });
}

test('PR13 R2 landing footprint clears both production arenas and scattered props', () => {
  for (const map of ['urban', 'snowy']) {
    const c = extractionReviewContext();
    c.activeMapId = map; c.startExtraction();
    const {x, z} = c.extraction.lz;
    const boxes = [];
    const addCollider = (x, y, z, w, h, d) => boxes.push({min: {x:x-w/2,y:y-h/2,z:z-d/2}, max: {x:x+w/2,y:y+h/2,z:z+d/2}});
    class Geo { clone() { return new Geo(); } applyMatrix4() {} }
    class Matrix { compose() {} }
    class Quat { setFromEuler() { return this; } }
    class Prop { constructor() { this.position = new Vector3(); this.rotation = {}; this.scale = {setScalar: noop}; } traverse() {} }
    const world = vm.createContext({CORE, CFG: {world: {size: 90}}, MAT: new Proxy({}, {get: () => ({})}),
      THREE: {Mesh, PlaneGeometry: Geo, CylinderGeometry: Geo, Matrix4: Matrix, Quaternion: Quat, Euler: Vector3, Vector3, MeshStandardMaterial: Material},
      addBox: (x,y,z,w,h,d,mat,opts) => { if (!opts || !opts.noCollide) addCollider(x,y,z,w,h,d); }, addCollider,
      withSkyEnv: m => m, queueStatic: noop, districtSignAccentMat: {}, scene: {add: noop}, raycastColliders: [],
      GLB_PARSED: {}, graphicsAtBoot: () => ({sceneryDetailed: false}), IS_TOUCH: false, makeMobileProp: () => new Prop(),
      colliders: boxes, batchScatteredProps: noop, rebuildNavGrid: noop, rebuildWorldRayGrid: noop});
    const src = source('10_config_world.js');
    vm.runInContext(src.slice(src.indexOf('function buildUrbanArena()'), src.indexOf('// ---- Map Registry ----')), world);
    vm.runInContext(src.slice(src.indexOf('function scatterProps()'), src.indexOf('\n}', src.indexOf('// 48 GLB clones')) + 2), world);
    world[map === 'urban' ? 'buildUrbanArena' : 'buildSnowyArena']();
    world.scatterProps();
    const blocked = boxes.filter(b => b.max.y > 0.05 && b.min.y < 38 &&
      b.max.x > x - 3.75 && b.min.x < x + 3.75 && b.max.z > z - 6 && b.min.z < z + 3.75);
    assert.equal(blocked.length, 0, `${map} helicopter footprint intersects map collision`);
    const nav = CORE.buildNavGrid(boxes, {cell: 1, halfExtent: 45});
    CORE.computeFlowField(nav, x, z);
    const spawn = CORE.getMapDef(map).playerSpawn;
    assert.notEqual(nav.dist[CORE.worldToCell(nav, spawn.x, spawn.z)], CORE.UNREACHABLE, `${map} LZ reachable from spawn`);
  }
});

test('PR13 R2 boarding requires ground level and carries player with helicopter', () => {
  for (const map of ['urban', 'snowy']) {
    const c = extractionReviewContext();
    c.activeMapId = map; c.startExtraction();
    c.updateWaves(90); c.extraction.helicopter.position.y = 1;
    c.player.pos.set(c.extraction.lz.x, 6, c.extraction.lz.z);
    c.updateWaves(0.1);
    assert.equal(c.extraction.phase, 'lz', `${map} upper floor cannot board`);
    c.player.pos.y = 1.7; c.updateWaves(0.1);
    assert.equal(c.extraction.phase, 'cinematic');
    const y = c.player.pos.y, hy = c.extraction.helicopter.position.y;
    c.updateWaves(0.5);
    assert.equal(c.player.pos.y - y, c.extraction.helicopter.position.y - hy, 'player ascends with helicopter');
  }
});

test('PR13 R2 resources dispose once on restart, death reset, and victory without shared metal', () => {
  for (const end of ['restart', 'death reset', 'victory']) {
    const c = extractionReviewContext();
    const shared = c.MAT.metal = new Material(); let sharedCount = 0;
    shared.dispose = () => sharedCount++;
    c.startExtraction();
    const resources = new Set();
    for (const root of [c.extraction.helicopter, c.extraction.lzRing, c.extraction.smokeMarker]) {
      root.traverse(o => { if (o.geometry) resources.add(o.geometry); if (o.material && o.material !== shared && o.geometry) resources.add(o.material); });
    }
    const counts = new Map();
    for (const r of resources) r.dispose = () => counts.set(r, (counts.get(r) || 0) + 1);
    if (end === 'restart') c.startExtraction();
    else if (end === 'death reset') { c.killPlayer(); c.resetGame(); }
    else { c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z); c.updateWaves(90); c.extraction.helicopter.position.y = 1; c.updateWaves(0.1); c.updateWaves(3.1); }
    for (const r of resources) assert.equal(counts.get(r), 1, `${end} must dispose each owned resource once`);
    assert.equal(sharedCount, 0, 'shared map material must survive');
  }
});

test('PR13 R2 cinematic frame gates movement weapons enemies and combat systems', () => {
  const c = extractionReviewContext();
  c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
  c.updateWaves(90); c.extraction.helicopter.position.y = 1; c.updateWaves(0.1);
  const calls = [];
  for (const name of ['updatePlayer', 'updateWeapons', 'updateEnemies', 'updateGrenades', 'updatePickups', 'updateAmmoRelief', 'updateStations', 'updateDowned', 'updateStreaks']) c[name] = () => calls.push(name);
  Object.assign(c, {started: true, paused: false, gameT: 0, fireClockT: 0, wallDt: 0.016, dt: 0.016, FIRE_CLOCK_MAX_STEP: 1, SKY_UNIFORMS: {time: {value: 0}}, updateSway: noop, updateVfx: noop, getActiveMode: () => ({id: 'survival', update: noop}), matchSettled: () => false});
  const main = source('70_main.js');
  const start = main.indexOf('  if (started && !paused) {', main.indexOf('function frame(now)'));
  const end = main.indexOf('    updateRagdolls(dt);', start);
  vm.runInContext(main.slice(start, end) + '\n}', c);
  assert.deepEqual(calls, [], 'cinematic must not advance gameplay or combat');
});

test('PR13 R2 fallback helicopter material is disposed over repeated reset cycles', () => {
  const c = extractionReviewContext();
  delete c.MAT.metal;
  for (let i = 0; i < 3; i++) {
    c.startExtraction();
    const material = c.extraction.helicopter.children[0].material;
    let disposed = 0; material.dispose = () => disposed++;
    c.resetGame();
    c.clearExtractionVisuals();
    assert.equal(disposed, 1);
  }
});

test('PR13 R2 queued airstrike cannot detonate during cinematic or after victory', () => {
  const c = extractionReviewContext(), pending = [];
  c.started = true;
  c.setTimeout = fn => pending.push(fn);
  let blasts = 0; c.explodeGrenade = () => blasts++;
  const src = source('58_streaks.js');
  vm.runInContext(src.slice(src.indexOf('const _airstrikeCoordOut'), src.indexOf('// ---- Sentry gun')), c);
  c.callAirstrike();
  assert.ok(pending.length);
  c.player.pos.set(c.extraction.lz.x, 1.7, c.extraction.lz.z);
  c.updateWaves(90); c.extraction.helicopter.position.y = 1; c.updateWaves(0.1);
  pending.shift()();
  c.updateWaves(3.1);
  for (const fn of pending) fn();
  assert.equal(blasts, 0, 'queued combat must not continue during or after extraction');
});




