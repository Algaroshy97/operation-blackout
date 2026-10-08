'use strict';
// Execute the shipped combat functions with deterministic headless rendering/audio
// boundaries. CORE, stance transitions, LOS, attack scheduling and grenade creation
// are real; this is not a second implementation of the combat rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CORE = require('../src/01_core.js');
const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
function section(text, from, to) {
  const start = text.indexOf(from);
  const end = to ? text.indexOf(to, start) : text.length;
  assert.ok(start >= 0 && end > start, `source section ${from}`);
  return text.slice(start, end);
}
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
  normalize() { const l = Math.sqrt(this.lengthSq()) || 1; return this.set(this.x / l, this.y / l, this.z / l); }
  applyQuaternion() { return this; } // camera's identity quaternion
  addScaledVector(v, s) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
}
class Mesh {
  constructor() { this.position = new Vector3(); this.children = []; }
  add(child) { this.children.push(child); }
}
const noop = () => {};
function context(extra) {
  const math = Object.create(Math); math.random = () => 0.5;
  return vm.createContext({ CORE, Math: math, THREE: { Vector3, Mesh }, ...extra });
}
function weaponHarness() {
  const weapon = { type: 'AR', rpm: 600, range: 80, spread: 0.02, adsSpread: 0.002, recoilV: 0.014, recoilH: 0.006 };
  const state = { ammo: 30, nextShot: 0 };
  const c = context({ player: { pos: new Vector3(), vel: new Vector3(8, 0, 0), slideDir: new Vector3(), yaw: 0,
    onGround: true, crouching: false, sliding: false, recoilP: 0, recoilY: 0 },
    curS: () => state, curW: () => weapon, shotsFired: 0, shotsHit: 0, fireClockT: 10, gameT: 10,
    adsDown: () => false, perks: [], bloom: 0, hSpeedForSpread: 0, recoilShot: 0, lastShotT: -99, shotKick: 0,
    camera: { position: new Vector3(), quaternion: {}, getWorldPosition: v => v.set(0, 1.8, 0) },
    _from: new Vector3(), _shootDir: new Vector3(), enemies: [], colliders: [],
    raycaster: { set: noop, intersectObjects: () => [] }, worldRayTargets: () => [], magnetizeBullet: d => d,
    spawnTracer: noop, spawnCasing: noop, playSound: noop, triggerMuzzleFlash: noop,
    flashMuzzleLight: noop, kickViewmodel: noop, vmTune: {}, muzzleFlash: false, updateHudAmmo: noop,
    tmpV: new Vector3(), spawnSlideDust: noop, crouchKey: true, CFG: { player: { radius: 0.3, height: 1.8 } }
  });
  const weapons = source('30_weapons.js');
  vm.runInContext(section(weapons, 'const _shotTargets =', '// ---- Melee ----'), c);
  const movement = source('20_player.js');
  vm.runInContext(section(movement, 'function startSlide()'), c);
  c.applyStance = () => vm.runInContext(`(() => { ${section(movement, '  // stance\n', '  // stamina & sprint')} })()`, c);
  return { c, state, weapon };
}
function shotKickFor(crouching, sliding, onGround) {
  const h = weaponHarness();
  Object.assign(h.c.player, { crouching, sliding, onGround });
  h.c.fireShot();
  return h.c.player;
}
function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

function enemyHarness() {
  const c = context({ player: { pos: new Vector3(10, 1.8, 0), dead: false }, enemies: [], gameT: 10,
    CFG: { ai: { rangedRange: 60, attackRange: 2.1, meleeDamage: 10, rangedROF: 1.35 }, grenade: { fuse: 3 } },
    E_DIM: { pelvisH: 0.95 }, waveBehaviours: { enemyNades: true }, waveNum: 12,
    liveGrenades: [], colliders: [], smokeVolumes: () => [],
    updateFlowField: noop, updateEnemyShadowBudget: noop, moveEnemy: noop, animateEnemy: noop,
    distToPlayer: en => Math.hypot(c.player.pos.x - en.pos.x, c.player.pos.z - en.pos.z),
    vertGapToPlayer: en => Math.abs(c.player.pos.y - 1.8 - en.pos.y),
    nextEstepT: Infinity, playSound3D: noop, pushKillfeed: noop,
    grenadeGeo: {}, grenadeMat: {}, fuseBlinkGeo: {}, fuseLightMat: {},
    scene: { added: [], add(m) { this.added.push(m); } },
    diff: () => ({ dmg: 1 }), dirToDeg: () => 0, meleeHits: [], damage: [],
    damagePlayer: damage => c.damage.push(damage), shots: [], enemyShoot: en => c.shots.push(en),
    _enemyStateOut: {}, _pushoutOut: {}, _sepOut: {}
  });
  const text = source('40_enemies.js');
  vm.runInContext(section(text, 'const _losFrom =', 'const tmpV2 ='), c);
  vm.runInContext(section(text, 'function updateStatusEffects(', '// Last-resort unstick:'), c);
  vm.runInContext(section(text, 'const _enemyGrenadeVelOut =', 'let _shieldMsgT ='), c);
  c.addEnemy = (kind, extra = {}) => {
    const en = { kind, pos: new Vector3(), state: 'spawn', stateT: 0, dead: false,
      speedMul: 1, yaw: 0, strafeDir: 1, nextShot: Infinity, ...extra };
    c.enemies.push(en); return en;
  };
  return c;
}

test('updateEnemies cannot create a seventh grenade or animate a rejected throw', () => {
  const c = enemyHarness();
  c.liveGrenades.push(...Array.from({ length: 5 }, () => ({ fromEnemy: false })));
  const a = c.addEnemy(5); const b = c.addEnemy(5, { pos: new Vector3(-5, 0, 0) });
  c.updateEnemies(1 / 60);
  assert.equal(c.liveGrenades.length, 6, 'one remaining slot, even with two attackers in the same tick');
  assert.equal(c.scene.added.length, 1);
  assert.equal([a, b].filter(en => en.throwT === 0.5).length, 1);
  const blocked = { pos: new Vector3(), throwT: 0 };
  c.throwEnemyGrenade(blocked);
  assert.equal(c.liveGrenades.length, 6);
  assert.equal(blocked.throwT, 0, 'cap rejection must not start throwing animation');
});

test('fireShot uses slide recoil after the real slide transition also crouches the player', () => {
  const standing = shotKickFor(false, false, true);
  const h = weaponHarness();
  h.c.startSlide(); h.c.applyStance();
  assert.equal(h.c.player.sliding, true);
  assert.equal(h.c.player.crouching, true, 'actual movement deliberately overlaps slide and crouch');
  h.c.fireShot();
  close(h.c.player.recoilP, standing.recoilP * 0.85, 'slide pitch');
  close(h.c.player.recoilY, standing.recoilY * 0.85, 'slide yaw');
  assert.equal(h.state.ammo, 29);
  close(h.state.nextShot, 10.1, 'fire schedule preserved');
});

test('fireShot preserves standing recoil and applies crouch and airborne priority on both axes', () => {
  const base = shotKickFor(false, false, true);
  const pattern = CORE.recoilAt(CORE.recoilPatternFor('AR'), CORE.recoilShotIndex(0, 109), 0, 0);
  close(base.recoilP, 0.014 * pattern.y, 'unchanged standing pitch');
  close(base.recoilY, 0.006 * pattern.x, 'unchanged standing yaw');
  for (const [crouch, slide, ground, ratio] of [
    [true, false, true, 0.8], [false, false, false, 1.25],
    [true, false, false, 1.25], [true, true, false, 1.25]
  ]) {
    const p = shotKickFor(crouch, slide, ground);
    close(p.recoilP, base.recoilP * ratio, 'stance pitch');
    close(p.recoilY, base.recoilY * ratio, 'stance yaw');
  }
  const h = weaponHarness();
  h.c.startSlide(); h.c.applyStance();
  h.c.player.sliding = false; h.c.applyStance();
  h.c.fireShot();
  close(h.c.player.recoilP, base.recoilP * 0.8, 'held crouch after slide');
  h.c.player.onGround = false;
  const before = h.c.player.recoilP;
  assert.equal(h.c.recoilShot, 0, 'first shot starts the pattern at zero');
  const nextPattern = CORE.recoilAt(CORE.recoilPatternFor('AR'), 1, 0, 0);
  h.c.fireShot();
  assert.equal(h.c.recoilShot, 1, 'follow-up advances exactly one pattern slot');
  close(h.c.player.recoilP - before, 0.014 * nextPattern.y * 1.25, 'airborne follow-up preserves burst progression');
});

test('updateEnemies preserves grenade delay, cooldown and real throw trajectory and fuse', () => {
  const c = enemyHarness(); const en = c.addEnemy(5);
  c.gameT = 3; c.updateEnemies(1 / 60);
  assert.equal(c.liveGrenades.length, 0, 'initial run-time delay boundary is strict');
  c.gameT = 3.01; c.updateEnemies(1 / 60);
  assert.equal(c.liveGrenades.length, 1);
  assert.equal(en.throwT, 0.5);
  const g = c.liveGrenades[0];
  assert.equal(g.fromEnemy, true); assert.equal(g.atRest, false); assert.equal(g.ring, null);
  close(g.fuse, CORE.enemyGrenadeFuse(3, CORE.ENEMY_GRENADE_FUSE_BONUS), 'fuse');
  close(g.restFuse, 3, 'rest fuse');
  close(g.m.position.y, 1.2, 'release height');
  close(g.blink.position.y, 0.1, 'fuse light height');
  assert.equal(g.m.children[0], g.blink);
  const speed = CORE.enemyGrenadeSpeed(10), len = Math.hypot(1, CORE.ENEMY_GRENADE_ARC_Y);
  close(g.vel.x, speed / len, 'original normalized lob velocity');
  close(g.vel.y, speed * CORE.ENEMY_GRENADE_ARC_Y / len, 'original loft');
  close(g.vel.z, 0, 'zero deterministic lateral jitter');
  const ready = en.nextNade;
  assert.ok(ready > c.gameT);
  c.gameT = ready; c.updateEnemies(1 / 60);
  assert.equal(c.liveGrenades.length, 1, 'no second throw at cooldown boundary');
  c.gameT = ready + 0.01; c.updateEnemies(1 / 60);
  assert.equal(c.liveGrenades.length, 2);
  assert.notEqual(c.liveGrenades[0].vel, c.liveGrenades[1].vel, 'scratch output cannot alias live physics vectors');
});

test('rifleman cover flush uses real LOS and remains wave-gated while grenadier ignores cover', () => {
  const wall = { min: { x: 4, y: -1, z: -2 }, max: { x: 5, y: 4, z: 2 } };
  for (const [kind, covered, unlocked, expected] of [
    [1, false, true, 0], [1, true, false, 0], [1, true, true, 1], [5, true, false, 1]
  ]) {
    const c = enemyHarness();
    if (covered) c.colliders.push(wall);
    c.waveBehaviours.enemyNades = unlocked;
    const en = c.addEnemy(kind, { state: 'strafe', _losSkip: 1 });
    c.updateEnemies(1 / 60);
    assert.equal(en._losCache, !covered, 'analytic LOS samples the actual wall');
    assert.equal(c.liveGrenades.length, expected, `kind ${kind}, cover ${covered}, unlock ${unlocked}`);
  }
});

test('updateEnemies stops grenade and melee attacks for a dead player and removes dead enemies', () => {
  const c = enemyHarness(); c.player.dead = true;
  const en = c.addEnemy(5, { state: 'chase', swinging: 0.01 });
  c.addEnemy(5, { dead: true });
  c.updateEnemies(1 / 60);
  assert.equal(c.enemies.length, 1); assert.equal(en.state, 'idle');
  assert.equal(en.swinging, undefined);
  assert.equal(c.liveGrenades.length, 0); assert.equal(c.damage.length, 0);
});

test('updateEnemies lands melee once, resets its sentinel over small ticks and honors attack cooldown', () => {
  const c = enemyHarness(); c.player.pos.set(2, 1.8, 0);
  const en = c.addEnemy(0, { state: 'chase', swinging: 0.005 });
  c.updateEnemies(0.006);
  assert.equal(c.damage.length, 1); assert.equal(en.swinging, -1);
  const ready = en.attackReadyT;
  for (let i = 0; i < 4; i++) { c.gameT += 0.004; c.updateEnemies(0.004); }
  assert.equal(en.swinging, undefined); assert.equal(c.damage.length, 1);
  c.gameT = ready; c.updateEnemies(0.004);
  assert.equal(en.swinging, undefined, 'cannot wind up at cooldown boundary');
  c.gameT = ready + 0.01; c.updateEnemies(0.004);
  assert.ok(en.swinging > 0, 'attack can resume after cooldown');
  assert.equal(c.damage.length, 1, 'windup itself causes no damage');
});

test('melee backstab execution bypasses shields and awards critical momentum damage; target evasion scales AI accuracy', () => {
  // Test doMelee with backstab detection and momentum
  const enBack = { pos: new Vector3(0, 0, 1), yaw: 0, dead: false, kind: 3 }; // facing +Z, in front of player
  const enFront = { pos: new Vector3(0, 0, 1), yaw: Math.PI, dead: false, kind: 3 }; // facing -Z, looking at player

  // Player at (0, 0, 0), facing +Z (dirX = 0, dirZ = 1)
  const dirX = 0, dirZ = 1;
  const isBack = CORE.isMeleeBackstab(dirX, dirZ, enBack.yaw, 0, 0, enBack.pos.x, enBack.pos.z);
  assert.equal(isBack, true, 'clean rear strike into enemy back');

  const isFront = CORE.isMeleeBackstab(dirX, dirZ, enFront.yaw, 0, 0, enFront.pos.x, enFront.pos.z);
  assert.equal(isFront, false, 'frontal strike is not a backstab');

  const backstabDmg = CORE.playerMeleeDamage(150, true, false, false);
  assert.equal(backstabDmg, 360);

  const slideDmg = CORE.playerMeleeDamage(150, false, true, false);
  assert.equal(slideDmg, 195);

  const sprintDmg = CORE.playerMeleeDamage(150, false, false, true);
  assert.equal(sprintDmg, 172.5);

  // Evasion accuracy scaling
  const baseAcc = 0.60;
  const slideAcc = CORE.enemyEffectiveAccuracy(baseAcc, CORE.enemyTargetEvasionMultiplier(false, false, true, false, false));
  assert.equal(slideAcc, baseAcc * 0.75);

  const tacSprintAcc = CORE.enemyEffectiveAccuracy(baseAcc, CORE.enemyTargetEvasionMultiplier(true, true, false, false, false));
  assert.equal(tacSprintAcc, baseAcc * 0.70);

  const crouchAcc = CORE.enemyEffectiveAccuracy(baseAcc, CORE.enemyTargetEvasionMultiplier(false, false, false, true, false));
  assert.equal(crouchAcc, baseAcc * 0.85);

  const standAcc = CORE.enemyEffectiveAccuracy(baseAcc, CORE.enemyTargetEvasionMultiplier(false, false, false, false, false));
  assert.equal(standAcc, baseAcc);
});

test('v127 sentry muzzle kinematics, penetration cover impact gating, and melee surface strike integration', () => {
  // Sentry muzzle position in front of rotated sentry
  const sentryPos = { x: 4, y: 0, z: 8 };
  const yaw = 0; // facing north (-Z)
  const muzzlePos = CORE.sentryMuzzlePosition(sentryPos.x, sentryPos.y, sentryPos.z, yaw);
  assert.equal(muzzlePos.x, 4);
  assert.equal(muzzlePos.y, 0.60);
  assert.equal(muzzlePos.z, 8 - 0.85);

  // Shoot direction to enemy target at (4, 1.2, -2)
  const targetPos = { x: 4, y: 1.2, z: -2 };
  const shootDir = CORE.sentryShootDirection(muzzlePos.x, muzzlePos.y, muzzlePos.z, targetPos.x, targetPos.y, targetPos.z);
  const expectedLen = Math.hypot(0, 1.2 - 0.60, -2 - (8 - 0.85));
  assert.equal(shootDir.x, 0);
  assert.ok(Math.abs(shootDir.y - (0.6 / expectedLen)) < 1e-4);
  assert.ok(Math.abs(shootDir.z - (-9.15 / expectedLen)) < 1e-4);

  // Penetration cover VFX gating
  assert.equal(CORE.shouldSpawnPenetrationCoverVfx(0.65, 3.2, 8.5), true);
  assert.equal(CORE.shouldSpawnPenetrationCoverVfx(1.0, 3.2, 8.5), false);
  assert.equal(CORE.shouldSpawnPenetrationCoverVfx(0.65, 10.0, 8.5), false);

  // Melee world strike gating
  assert.equal(CORE.canMeleeStrikeWorld(-1, 1.8, 2.2), true);
  assert.equal(CORE.canMeleeStrikeWorld(0, 1.8, 2.2), false); // hit enemy, not world
  assert.equal(CORE.canMeleeStrikeWorld(-1, 2.6, 2.2), false); // out of reach
});

test('v128 melee combat impact acoustics, penetration hitmarker sound, and locomotion audio integration', () => {
  // Melee impact sound resolution
  assert.equal(CORE.meleeHitSound(true), 'melee_backstab');
  assert.equal(CORE.meleeHitSound(false), 'melee_hit');

  // Through-cover penetration hitmarker sound
  assert.equal(CORE.hitmarkerSound('cover', false), 'hit_cover');
  assert.equal(CORE.hitmarkerSound('cover', true), 'headshot');
  assert.equal(CORE.hitmarkerSound('block', false), 'block');
  assert.equal(CORE.hitmarkerSound('kill', false), null);

  // Locomotion and landing audio rules
  assert.equal(CORE.playerFootstepSound(false, true), 'step_tac');
  assert.equal(CORE.playerFootstepSound(true, true), 'step_crouch');
  assert.equal(CORE.playerFootstepSound(false, false), 'step');
  assert.equal(CORE.landingSound(true), 'land_heavy');
  assert.equal(CORE.landingSound(false), 'land');
});
