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
    nextEstepT: Infinity,
    playSound3D: noop,
    playSound: noop,
    pushKillfeed: noop,
    diff: () => ({ dmg: 1 }),
    dirToDeg: () => 0,
    meleeHits: [],
    damagePlayer: noop,
    showDamageFx: noop,
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
    getActiveMode: () => c.MODES.survival,
    MODES: {
      survival: {
        id: 'survival',
        onKill: noop
      }
    },
    dummyParts,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
  }, overrides));

  const text = source('40_enemies.js');
  vm.runInContext(text, c);
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
  c.enemies = [friendlyInBlast];
  c.colliders = [];
  c.player.pos.set(50, 0, 50); // player far away
  c.throwEnemyGrenade(c.player, friendlyInBlast);
  c.liveGrenades[0].m.position.set(0, 0, 0);
  c.liveGrenades[0].fuse = 0.01;
  c.updateGrenades(0.02);
  assert.equal(friendlyInBlast.health, 100, 'friendly bot in friendly grenade blast must take 0 damage');
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
