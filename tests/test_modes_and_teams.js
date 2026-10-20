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
    this.children = [];
    this.userData = {};
  }
  add(child) { this.children.push(child); }
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
