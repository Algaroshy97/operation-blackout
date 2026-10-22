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
  constructor() {
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

function createFullMatchContext(overrides = {}) {
  const docElements = new Map();
  const doc = {
    getElementById: id => {
      if (!docElements.has(id)) {
        docElements.set(id, {
          id,
          style: { display: '' },
          textContent: '',
          innerHTML: '',
          dataset: {},
          classList: { add: noop, remove: noop, contains: () => false },
          addEventListener: noop,
          removeEventListener: noop,
          click: function () {
            if (id === 'btn-match-restart' && typeof c.restartMatch === 'function') c.restartMatch();
            if (id === 'btn-match-quit' && typeof c.quitMatchToMenu === 'function') c.quitMatchToMenu();
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
      addEventListener: noop,
      removeEventListener: noop,
      appendChild: noop,
      setAttribute: noop
    }),
    querySelectorAll: () => [],
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
    updateStatusEffects: noop,
    updateFlowField: noop,
    updateEnemyShadowBudget: noop,
    flushStaticBatches: noop,
    rebuildWorldRayGrid: noop,
    rebuildNavGrid: noop,
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
    addBox: noop,
    scene: { add: noop, remove: noop },
    colliders: [],
    smokeVolumes: () => [],
    spawnPoints: [
      [0, 10], [5, 10], [10, 10], [15, 10], [20, 10], [25, 10],
      [0, -10], [5, -10], [10, -10], [15, -10], [20, -10], [25, -10]
    ],
    openSpawnPoints: () => [
      [0, 10], [5, 10], [10, 10], [15, 10], [20, 10], [25, 10],
      [0, -10], [5, -10], [10, -10], [15, -10], [20, -10], [25, -10]
    ],
    perks: [],
    godMode: false,
    startMusic: noop,
    stopMusic: noop,
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
    kills: 0,
    headshots: 0,
    score: 0,
    credits: 0,
    shotsFired: 0,
    shotsHit: 0,
    waveNum: 0,
    runStreaksEarned: 0,
    settlementSnapshot: null,
    captureRunState: () => ({}),
    saveCheckpoint: cp => { c._checkpoint = cp; },
    clearCheckpoint: () => { c._checkpoint = null; },
    recordRun: () => ({}),
    spawnRagdoll: noop,
    disposeEnemyGeometry: noop,
    addScore: noop,
    addCredits: noop,
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
    loadCheckpoint: () => c._checkpoint || null,
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
      player: { height: 1.7, health: 100, armor: 50, maxStamina: 100, radius: 0.4 },
      score: { kill: 100, headshot: 50 },
      wave: { startDelay: 3 },
      ai: { speed: 3.2, chaseSpeed: 4.9, rangedSpeed: 2.8, attackRange: 2.1, meleeDamage: 18, meleeCd: 1.1, rangedRange: 44, rangedDamage: 8, rangedROF: 1.35, rangedAccuracy: 0.5, maxHealth: 100, headshotMul: 1.8, giveUpDist: 70, accPerWave: 0.035, accMax: 0.75 },
      grenade: { radius: 6, dmg: 120 },
      weapons: [{ mag: 30, reserveMax: 90 }]
    },
    dummyParts
  }, overrides));

  vm.runInContext(source('20_player.js'), c);
  vm.runInContext(source('57_stations.js'), c);
  vm.runInContext(source('35_modes.js'), c);
  vm.runInContext(source('40_enemies.js'), c);
  const mainSrc = source('70_main.js');
  const mainSlice = mainSrc.slice(0, mainSrc.indexOf('applyAllSettings();'));
  vm.runInContext(mainSlice, c);
  vm.runInContext('assetsReady = true;', c);

  c.player = vm.runInContext('player', c);
  c.enemies = vm.runInContext('enemies', c);
  c.modeRespawnQueue = vm.runInContext('modeRespawnQueue', c);
  c.MODES = vm.runInContext('MODES', c);
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
