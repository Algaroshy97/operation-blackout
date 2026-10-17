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

test('v129 tactical damage-type armor mitigation, fall-damage bypass, and weapon handling integration', () => {
  // Test damage resolution across damage types
  const bulletRes = CORE.resolveArmorDamage(24, 40, undefined, 'bullet');
  assert.equal(bulletRes.absorbed, 24 * 0.65);
  assert.equal(bulletRes.absorbedDamage, 24 * 0.65);
  assert.equal(bulletRes.healthDamage, 24 * 0.35);

  const blastRes = CORE.resolveArmorDamage(40, 50, undefined, 'blast');
  assert.equal(blastRes.absorbed, 30);
  assert.equal(blastRes.absorbedDamage, 30);
  assert.equal(blastRes.healthDamage, 10);

  const meleeRes = CORE.resolveArmorDamage(30, 50, undefined, 'melee');
  assert.equal(meleeRes.absorbed, 15);
  assert.equal(meleeRes.absorbedDamage, 15);
  assert.equal(meleeRes.healthDamage, 15);

  const fallRes = CORE.resolveArmorDamage(25, 50, undefined, 'fall');
  assert.equal(fallRes.absorbed, 0);
  assert.equal(fallRes.absorbedDamage, 0);
  assert.equal(fallRes.healthDamage, 25);
  assert.equal(fallRes.remainingArmor, 50);

  // Weapon switch speeds
  assert.equal(CORE.weaponSwitchSpeed('SMG', false), 4.6);
  assert.equal(CORE.weaponSwitchSpeed('AR', false), 3.6);
  assert.equal(CORE.weaponSwitchSpeed('BR', false), 3.0);
  assert.equal(CORE.weaponSwitchSpeed('SR', false), 2.4);
  assert.equal(CORE.weaponSwitchSpeed('SMG', true), 4.6 * 1.35);

  // Weapon ADS speeds
  assert.equal(CORE.weaponAdsSpeed('SMG'), 1.25);
  assert.equal(CORE.weaponAdsSpeed('AR'), 1.00);
  assert.equal(CORE.weaponAdsSpeed('BR'), 0.88);
  assert.equal(CORE.weaponAdsSpeed('SR'), 0.70);
});

test('v132 tactical detonation visual effects and headshot ballistic impact integration', () => {
  // Tactical detonation flash light parameters
  const blindLight = CORE.tacticalFlashLightParams('blind');
  assert.equal(blindLight.color, 0xffffff);
  assert.equal(blindLight.intensity, 18.0);
  assert.equal(blindLight.distance, 24.0);
  assert.equal(blindLight.duration, 0.30);

  const stunLight = CORE.tacticalFlashLightParams('stun');
  assert.equal(stunLight.color, 0x60b0ff);
  assert.equal(stunLight.intensity, 12.0);
  assert.equal(stunLight.distance, 18.0);
  assert.equal(stunLight.duration, 0.20);

  const smokeLight = CORE.tacticalFlashLightParams('smoke');
  assert.equal(smokeLight.intensity, 0);

  // Tactical particle parameters
  const blindPfx = CORE.tacticalParticleParams('blind');
  assert.equal(blindPfx.flashCount, 16);
  assert.equal(blindPfx.sparkCount, 22);
  assert.equal(blindPfx.smokeCount, 14);

  const stunPfx = CORE.tacticalParticleParams('stun');
  assert.equal(stunPfx.flashCount, 10);
  assert.equal(stunPfx.sparkCount, 18);
  assert.equal(stunPfx.smokeCount, 10);

  assert.equal(CORE.tacticalParticleParams('smoke'), null);

  // Enemy helmet identification
  assert.equal(CORE.enemyHasHelmet('rifleman'), true);
  assert.equal(CORE.enemyHasHelmet('tank'), true);
  assert.equal(CORE.enemyHasHelmet('shielded'), true);
  assert.equal(CORE.enemyHasHelmet('grenadier'), true);
  assert.equal(CORE.enemyHasHelmet('runner'), false);
  assert.equal(CORE.enemyHasHelmet('scout'), false);
  assert.equal(CORE.enemyHasHelmet('other'), false);

  // Headshot VFX parameters
  const helmetVfx = CORE.headshotVfxParams(true);
  assert.equal(helmetVfx.sparks, 6);
  assert.equal(helmetVfx.blood, 8);

  const bareVfx = CORE.headshotVfxParams(false);
  assert.equal(bareVfx.sparks, 0);
  assert.equal(bareVfx.blood, 14);
});

test('v133 tactical combat and locomotion acoustics integration', () => {
  // 1. Slide-jump kinetic momentum boost acoustics
  assert.equal(CORE.JUMP_SLIDE_SOUND, 'jump_slide');
  assert.equal(CORE.JUMP_SOUND, 'jump');
  assert.equal(CORE.jumpSound(true), 'jump_slide');
  assert.equal(CORE.jumpSound(false), 'jump');
  assert.equal(CORE.jumpSound(), 'jump');

  // 2. Empty magazine slide-lock / chamber-empty acoustics
  assert.equal(CORE.CHAMBER_EMPTY_SOUND, 'chamber_empty');
  assert.equal(CORE.chamberEmptySound(0), 'chamber_empty');
  assert.equal(CORE.chamberEmptySound(1), null);
  assert.equal(CORE.chamberEmptySound(-1), null);
  assert.equal(CORE.chamberEmptySound(undefined), null);

  // 3. Grenade cook and throw release acoustics
  assert.equal(CORE.GRENADE_COOK_SOUND, 'pin');
  assert.equal(CORE.grenadeCookSound(), 'pin');
  assert.equal(CORE.grenadeThrowSound(true, 'lethal', 'frag'), 'draw');
  assert.equal(CORE.grenadeThrowSound(false, 'lethal', 'frag'), 'pin');
  assert.equal(CORE.grenadeThrowSound(false, 'proximity', 'claymore'), 'claymore_plant');

  // 4. Hostile melee strike impact acoustics
  assert.equal(CORE.ENEMY_HIT_SOUND, 'enemy_hit');
  assert.equal(CORE.ENEMY_HIT_HEAVY_SOUND, 'enemy_hit_heavy');
  assert.equal(CORE.enemyMeleeHitSound(true, false), 'enemy_hit_heavy');
  assert.equal(CORE.enemyMeleeHitSound(false, true), 'enemy_hit_heavy');
  assert.equal(CORE.enemyMeleeHitSound(false, false), 'enemy_hit');
  assert.equal(CORE.enemyMeleeHitSound(), 'enemy_hit');
});

test('v134 tactical combat balance integration: ADS strafe mobility, empty reload penalty, bloom recovery, and enemy melee tuning', () => {
  // 1. Weapon-archetype ADS strafe mobility balance
  assert.equal(CORE.WEAPON_ADS_MOVE_SMG, 1.20);
  assert.equal(CORE.WEAPON_ADS_MOVE_AR, 1.00);
  assert.equal(CORE.WEAPON_ADS_MOVE_BR, 0.88);
  assert.equal(CORE.WEAPON_ADS_MOVE_SR, 0.70);
  assert.equal(CORE.weaponAdsMoveMultiplier('SMG'), 1.20);
  assert.equal(CORE.weaponAdsMoveMultiplier('AR'), 1.00);
  assert.equal(CORE.weaponAdsMoveMultiplier('BR'), 0.88);
  assert.equal(CORE.weaponAdsMoveMultiplier('SR'), 0.70);
  assert.equal(CORE.weaponAdsMoveMultiplier('AR', 1.45), 1.45);
  assert.equal(CORE.weaponAdsMoveMultiplier('custom'), 1.00);

  // 2. Empty magazine reload duration penalty
  assert.equal(CORE.EMPTY_RELOAD_TIME_MUL, 1.15);
  assert.ok(Math.abs(CORE.effectiveReloadDuration(2.0, 1.0, true) - 2.30) < 1e-4);
  assert.ok(Math.abs(CORE.effectiveReloadDuration(2.0, 1.0, false) - 2.00) < 1e-4);
  assert.ok(Math.abs(CORE.effectiveReloadDuration(2.0, 1.0) - 2.00) < 1e-4);

  // 3. Weapon bloom recovery agility
  assert.equal(CORE.BLOOM_RECOVER_SMG, 1.30);
  assert.equal(CORE.BLOOM_RECOVER_AR, 1.00);
  assert.equal(CORE.BLOOM_RECOVER_BR, 0.85);
  assert.equal(CORE.BLOOM_RECOVER_SR, 0.65);
  assert.equal(CORE.weaponBloomRecoveryMultiplier('SMG'), 1.30);
  assert.equal(CORE.weaponBloomRecoveryMultiplier('AR'), 1.00);
  assert.equal(CORE.weaponBloomRecoveryMultiplier('BR'), 0.85);
  assert.equal(CORE.weaponBloomRecoveryMultiplier('SR'), 0.65);
  assert.equal(CORE.weaponBloomRecoveryMultiplier('other'), 1.00);
  const smgBloom = CORE.bloomParams(0.02, 0.008, false, 'SMG');
  assert.ok(Math.abs(smgBloom.recover - (0.02 * CORE.BLOOM_RECOVER * 1.30)) < 1e-6);

  // 4. Enemy archetype melee damage calibration
  assert.equal(CORE.ENEMY_MELEE_TANK_BONUS, 10);
  assert.equal(CORE.ENEMY_MELEE_SHIELD_BONUS, 5);
  assert.equal(CORE.ENEMY_MELEE_SCOUT_PENALTY, -4);
  assert.ok(Math.abs(CORE.enemyMeleeDamage(18, 2, 1, 1, false) - 28.4) < 1e-4);
  assert.ok(Math.abs(CORE.enemyMeleeDamage(18, 3, 1, 1, false) - 23.4) < 1e-4);
  assert.ok(Math.abs(CORE.enemyMeleeDamage(18, 4, 1, 1, false) - 14.4) < 1e-4);
  assert.ok(Math.abs(CORE.enemyMeleeDamage(18, 0, 1, 1, false) - 18.4) < 1e-4);
  assert.ok(Math.abs(CORE.enemyMeleeDamage(18, true, 1, 1, false) - 28.4) < 1e-4);
  assert.ok(Math.abs(CORE.enemyMeleeDamage(18, false, 1, 1, false) - 18.4) < 1e-4);
});

test('v137 visual polish integration: ballistic shield deflection, helmet headshot detection, and landing dust puff rules', () => {
  // 1. Dual-signature helmet headshot detection
  assert.equal(CORE.enemyHasHelmet(1), true);
  assert.equal(CORE.enemyHasHelmet(2), true);
  assert.equal(CORE.enemyHasHelmet(3), true);
  assert.equal(CORE.enemyHasHelmet(5), true);
  assert.equal(CORE.enemyHasHelmet(0), false);
  assert.equal(CORE.enemyHasHelmet(4), false);
  assert.equal(CORE.enemyHasHelmet('rifleman'), true);
  assert.equal(CORE.enemyHasHelmet('tank'), true);
  assert.equal(CORE.enemyHasHelmet('shielded'), true);
  assert.equal(CORE.enemyHasHelmet('grenadier'), true);
  assert.equal(CORE.enemyHasHelmet('runner'), false);
  assert.equal(CORE.enemyHasHelmet('scout'), false);

  // 2. Ballistic shield deflection normal & VFX parameters
  const out = { x: 0, y: 0, z: 0 };
  const res = CORE.shieldDeflectNormal(0, out);
  assert.equal(res, out);
  assert.ok(Math.abs(out.x) < 1e-6);
  assert.equal(out.y, 0);
  assert.ok(Math.abs(out.z - 1.0) < 1e-6);

  CORE.shieldDeflectNormal(Math.PI / 2, out);
  assert.ok(Math.abs(out.x - 1.0) < 1e-6);
  assert.equal(out.y, 0);
  assert.ok(Math.abs(out.z) < 1e-6);

  assert.equal(CORE.SHIELD_DEFLECT_SPARK_COUNT, 12);
  assert.equal(CORE.SHIELD_DEFLECT_SPARK_COLOR0, 0x90e0ff);
  assert.equal(CORE.SHIELD_DEFLECT_SPARK_COLOR1, 0xffa040);
  assert.equal(CORE.SHIELD_DEFLECT_LIGHT_COLOR, 0x60b0ff);
  assert.equal(CORE.SHIELD_DEFLECT_LIGHT_INTENSITY, 2.4);
  assert.equal(CORE.SHIELD_DEFLECT_LIGHT_DIST, 4.5);
  assert.equal(CORE.SHIELD_DEFLECT_LIGHT_DUR, 0.05);

  const vfx = CORE.shieldDeflectVfxParams(0.5);
  assert.equal(vfx.sparks, 12);
  assert.equal(vfx.sparkColor0, 0x90e0ff);
  assert.equal(vfx.sparkColor1, 0xffa040);
  assert.equal(vfx.lightColor, 0x60b0ff);
  assert.equal(vfx.lightIntensity, 2.4);
  assert.equal(vfx.lightDist, 4.5);
  assert.equal(vfx.lightDur, 0.05);

  // 3. Heavy landing concussive ground impact dust puff rules
  assert.equal(CORE.LANDING_DUST_HEAVY_COUNT, 12);
  assert.equal(CORE.LANDING_DUST_LIGHT_COUNT, 5);
  assert.equal(CORE.LANDING_DUST_COLOR, 0x8a8076);

  const hDust = CORE.landingDustParams(12.0);
  assert.ok(hDust !== null);
  assert.equal(hDust.count, 12);
  assert.equal(hDust.spread, 2.0);
  assert.equal(hDust.color, 0x8a8076);

  const lDust = CORE.landingDustParams(7.5);
  assert.ok(lDust !== null);
  assert.equal(lDust.count, 5);
  assert.equal(lDust.spread, 1.0);
  assert.equal(lDust.color, 0x8a8076);

  assert.equal(CORE.landingDustParams(5.0), null);
  assert.equal(CORE.landingDustParams(0), null);
  assert.equal(CORE.landingDustParams(-1), null);
  assert.equal(CORE.landingDustParams(), null);
});

test('v138 audio polish integration: ballistic shield deflection, helmet headshot acoustics, and heavy landing dual-signature rules', () => {
  // 1. Ballistic shield deflection acoustics
  assert.equal(CORE.SHIELD_DEFLECT_SOUND, 'shield_deflect');
  assert.equal(CORE.shieldDeflectSound(true), 'shield_deflect');
  assert.equal(CORE.shieldDeflectSound(), 'shield_deflect');
  assert.equal(CORE.shieldDeflectSound(false), null);

  // 2. Armored enemy helmet headshot acoustics
  assert.equal(CORE.HELMET_HIT_SOUND, 'helmet_hit');
  assert.equal(CORE.helmetHitSound(true), 'helmet_hit');
  assert.equal(CORE.helmetHitSound(), 'helmet_hit');
  assert.equal(CORE.helmetHitSound(false), null);

  // 3. Heavy landing acoustics dual-signature support
  assert.equal(CORE.LAND_HEAVY_SOUND, 'land_heavy');
  assert.equal(CORE.LAND_SOUND, 'land');
  assert.equal(CORE.landingSound(true), 'land_heavy');
  assert.equal(CORE.landingSound(false), 'land');
  assert.equal(CORE.landingSound(14.0), 'land_heavy');
  assert.equal(CORE.landingSound(11.0), 'land_heavy');
  assert.equal(CORE.landingSound(8.0), 'land');
  assert.equal(CORE.landingSound(0), 'land');

  // 4. Enemy grenadier throw acoustics
  assert.equal(CORE.enemyGrenadeThrowSound(), 'pin');
});

test('v139 tactical combat balance integration: weapon bloom per-shot accumulation, tactical sprint melee momentum & armor plate action gating', () => {
  // 1. Weapon-archetype hipfire bloom per-shot accumulation agility
  assert.equal(CORE.BLOOM_PER_SHOT_SMG, 0.75);
  assert.equal(CORE.BLOOM_PER_SHOT_AR, 1.00);
  assert.equal(CORE.BLOOM_PER_SHOT_BR, 1.25);
  assert.equal(CORE.BLOOM_PER_SHOT_SR, 1.60);
  assert.equal(CORE.weaponBloomPerShotMultiplier('SMG'), 0.75);
  assert.equal(CORE.weaponBloomPerShotMultiplier('AR'), 1.00);
  assert.equal(CORE.weaponBloomPerShotMultiplier('BR'), 1.25);
  assert.equal(CORE.weaponBloomPerShotMultiplier('SR'), 1.60);
  assert.equal(CORE.weaponBloomPerShotMultiplier('other'), 1.00);

  const smgBloom = CORE.bloomParams(0.020, 0.008, false, 'SMG');
  assert.ok(Math.abs(smgBloom.perShot - (0.020 * CORE.BLOOM_PER_SHOT * 0.75)) < 1e-6);
  const arBloom = CORE.bloomParams(0.014, 0.004, false, 'AR');
  assert.ok(Math.abs(arBloom.perShot - (0.014 * CORE.BLOOM_PER_SHOT * 1.00)) < 1e-6);
  const brBloom = CORE.bloomParams(0.011, 0.003, false, 'BR');
  assert.ok(Math.abs(brBloom.perShot - (0.011 * CORE.BLOOM_PER_SHOT * 1.25)) < 1e-6);
  const srBloom = CORE.bloomParams(0.055, 0.0006, false, 'SR');
  assert.ok(Math.abs(srBloom.perShot - (0.055 * CORE.BLOOM_PER_SHOT * 1.60)) < 1e-6);

  // 2. Tactical sprint kinetic melee momentum strike balance
  assert.equal(CORE.MELEE_TAC_SPRINT_MOMENTUM_MUL, 1.28);
  assert.equal(CORE.playerMeleeDamage(150, false, false, false, true), 192);
  assert.equal(CORE.playerMeleeDamage(150, false, false, true, false), 172.5);
  assert.equal(CORE.playerMeleeDamage(150, false, true, false, false), 195);
  assert.equal(CORE.playerMeleeDamage(150, true, false, false, false), 360);
  assert.equal(CORE.playerMeleeDamage(150, false, false, false, false), 150);
  assert.ok(Math.abs(CORE.playerMeleeDamage(100, false, false, false, true) - 128) < 1e-4);
  assert.ok(Math.abs(CORE.playerMeleeDamage(100, false, false, true, false) - 115) < 1e-4);

  // 3. Armor plate tactical insertion action gating & eligibility
  assert.equal(CORE.canPlayerUsePlate(false, false, 2, 20, 50, false), true);
  assert.equal(CORE.canPlayerUsePlate(true, false, 2, 20, 50, false), false);
  assert.equal(CORE.canPlayerUsePlate(false, true, 2, 20, 50, false), false);
  assert.equal(CORE.canPlayerUsePlate(false, false, 0, 20, 50, false), false);
  assert.equal(CORE.canPlayerUsePlate(false, false, 2, 50, 50, false), false);
  assert.equal(CORE.canPlayerUsePlate(false, false, 2, 20, 50, true), false);
});

test('v142 visual polish integration: tactical melee strike execution VFX, blade slash kinematics, and weapon muzzle light suppressor visual attenuation', () => {
  // 1. Tactical melee strike visual kinematics & arterial execution VFX
  assert.equal(CORE.MELEE_SLASH_SPARK_COUNT, 4);
  assert.equal(CORE.MELEE_SLASH_BACKSTAB_SPARKS, 10);
  assert.equal(CORE.MELEE_SLASH_MIST_COUNT, 6);
  assert.equal(CORE.MELEE_SLASH_BACKSTAB_MIST, 14);
  assert.equal(CORE.MELEE_SLASH_LIGHT_COLOR, 0xff2010);
  assert.equal(CORE.MELEE_SLASH_LIGHT_INTENSITY, 2.4);
  assert.equal(CORE.MELEE_SLASH_LIGHT_DIST, 4.2);
  assert.equal(CORE.MELEE_SLASH_LIGHT_DUR, 0.05);

  const backstabVfx = CORE.meleeSlashVfxParams(true);
  assert.equal(backstabVfx.sparks, 10);
  assert.equal(backstabVfx.mist, 14);
  assert.equal(backstabVfx.lightColor, 0xff2010);
  assert.equal(backstabVfx.lightIntensity, 2.4);
  assert.equal(backstabVfx.lightDist, 4.2);
  assert.equal(backstabVfx.lightDur, 0.05);

  const standardVfx = CORE.meleeSlashVfxParams(false);
  assert.equal(standardVfx.sparks, 4);
  assert.equal(standardVfx.mist, 6);
  assert.equal(standardVfx.lightColor, 0);
  assert.equal(standardVfx.lightIntensity, 0);
  assert.equal(standardVfx.lightDist, 0);
  assert.equal(standardVfx.lightDur, 0);

  const normOut = { x: 0, y: 0, z: 0 };
  CORE.meleeSlashNormal(0, normOut);
  assert.ok(Math.abs(normOut.x - 1) < 1e-6);
  assert.equal(normOut.y, 0);
  assert.ok(Math.abs(normOut.z - 0) < 1e-6);

  CORE.meleeSlashNormal(Math.PI / 2, normOut);
  assert.ok(Math.abs(normOut.x - 0) < 1e-6);
  assert.equal(normOut.y, 0);
  assert.ok(Math.abs(normOut.z - (-1)) < 1e-6);

  // 2. Weapon muzzle light & suppressor visual attenuation
  assert.equal(CORE.MUZZLE_LIGHT_COLOR_STANDARD, 0xffcc88);
  assert.equal(CORE.MUZZLE_LIGHT_COLOR_SUPPRESSED, 0xffaa55);
  assert.equal(CORE.MUZZLE_LIGHT_DIST_STANDARD, 9.0);
  assert.equal(CORE.MUZZLE_LIGHT_DIST_SUPPRESSED, 4.0);
  assert.equal(CORE.MUZZLE_LIGHT_DIST_HEAVY, 12.0);
  assert.equal(CORE.MUZZLE_LIGHT_DIST_SMG, 7.5);

  const suppLight = CORE.muzzleFlashLightParams('AR', true);
  assert.equal(suppLight.color, 0xffaa55);
  assert.equal(suppLight.distance, 4.0);
  assert.ok(Math.abs(suppLight.intensityMul - 0.3) < 1e-6);

  const srLight = CORE.muzzleFlashLightParams('SR', false);
  assert.equal(srLight.color, 0xffcc88);
  assert.equal(srLight.distance, 12.0);
  assert.ok(Math.abs(srLight.intensityMul - 1.45) < 1e-6);

  const brLight = CORE.muzzleFlashLightParams('BR', false);
  assert.equal(brLight.color, 0xffcc88);
  assert.equal(brLight.distance, 10.5);
  assert.ok(Math.abs(brLight.intensityMul - 1.25) < 1e-6);

  const smgLight = CORE.muzzleFlashLightParams('SMG', false);
  assert.equal(smgLight.color, 0xffcc88);
  assert.equal(smgLight.distance, 7.5);
  assert.ok(Math.abs(smgLight.intensityMul - 0.8) < 1e-6);

  const arLight = CORE.muzzleFlashLightParams('AR', false);
  assert.equal(arLight.color, 0xffcc88);
  assert.equal(arLight.distance, 9.0);
  assert.ok(Math.abs(arLight.intensityMul - 1.0) < 1e-6);

  // 3. Muzzle smoke/spark particle parameters
  const suppVfx = CORE.muzzleVfxParams('AR', true);
  assert.equal(suppVfx.smokeCount, 1);
  assert.equal(suppVfx.sparkCount, 0);
  assert.equal(suppVfx.smokeScale, 0.4);

  const srVfx = CORE.muzzleVfxParams('SR', false);
  assert.equal(srVfx.smokeCount, 5);
  assert.equal(srVfx.sparkCount, 7);
  assert.equal(srVfx.smokeScale, 1.0);

  const arVfx = CORE.muzzleVfxParams('AR', false);
  assert.equal(arVfx.smokeCount, 3);
  assert.equal(arVfx.sparkCount, 4);
  assert.equal(arVfx.smokeScale, 0.75);
});

test('v143 audio polish integration: enemy archetype footsteps, reload magazine acoustics, and melee surface strike rules', () => {
  // 1. Enemy archetype & Elite footstep acoustics
  assert.equal(CORE.ENEMY_STEP_SOUND, 'estep');
  assert.equal(CORE.ENEMY_STEP_HEAVY_SOUND, 'estep_heavy');
  assert.equal(CORE.enemyFootstepSound(0, false), 'estep');
  assert.equal(CORE.enemyFootstepSound(1, false), 'estep');
  assert.equal(CORE.enemyFootstepSound(2, false), 'estep_heavy');
  assert.equal(CORE.enemyFootstepSound('tank', false), 'estep_heavy');
  assert.equal(CORE.enemyFootstepSound(3, false), 'estep');
  assert.equal(CORE.enemyFootstepSound(4, false), 'estep');
  assert.equal(CORE.enemyFootstepSound(5, false), 'estep');
  assert.equal(CORE.enemyFootstepSound(0, true), 'estep_heavy');
  assert.equal(CORE.enemyFootstepSound(1, true), 'estep_heavy');
  assert.equal(CORE.enemyFootstepSound(2, true), 'estep_heavy');

  // 2. Weapon magazine reload acoustics
  assert.equal(CORE.RELOAD_OUT_SOUND, 'reload_out');
  assert.equal(CORE.RELOAD_IN_SOUND, 'reload_in');
  assert.equal(CORE.RELOAD_HEAVY_OUT_SOUND, 'reload_heavy_out');
  assert.equal(CORE.RELOAD_HEAVY_IN_SOUND, 'reload_heavy_in');
  assert.equal(CORE.RELOAD_SMG_OUT_SOUND, 'reload_smg_out');
  assert.equal(CORE.RELOAD_SMG_IN_SOUND, 'reload_smg_in');

  assert.equal(CORE.reloadMagazineOutSound('SMG'), 'reload_smg_out');
  assert.equal(CORE.reloadMagazineInSound('SMG'), 'reload_smg_in');
  assert.equal(CORE.reloadMagazineOutSound('SR'), 'reload_heavy_out');
  assert.equal(CORE.reloadMagazineInSound('SR'), 'reload_heavy_in');
  assert.equal(CORE.reloadMagazineOutSound('BR'), 'reload_heavy_out');
  assert.equal(CORE.reloadMagazineInSound('BR'), 'reload_heavy_in');
  assert.equal(CORE.reloadMagazineOutSound('AR'), 'reload_out');
  assert.equal(CORE.reloadMagazineInSound('AR'), 'reload_in');
  assert.equal(CORE.reloadMagazineOutSound(''), 'reload_out');
  assert.equal(CORE.reloadMagazineInSound(''), 'reload_in');

  // 3. Melee surface strike knife clank acoustics
  assert.equal(CORE.MELEE_SURFACE_METAL_SOUND, 'melee_hit_metal');
  assert.equal(CORE.MELEE_SURFACE_WOOD_SOUND, 'impact_wood');
  assert.equal(CORE.MELEE_SURFACE_GLASS_SOUND, 'impact_glass');
  assert.equal(CORE.MELEE_SURFACE_GROUND_SOUND, 'impact_ground');
  assert.equal(CORE.MELEE_SURFACE_DEFAULT_SOUND, 'impact');

  assert.equal(CORE.meleeSurfaceSound('metal'), 'melee_hit_metal');
  assert.equal(CORE.meleeSurfaceSound('wood'), 'impact_wood');
  assert.equal(CORE.meleeSurfaceSound('glass'), 'impact_glass');
  assert.equal(CORE.meleeSurfaceSound('ground'), 'impact_ground');
  assert.equal(CORE.meleeSurfaceSound('concrete'), 'impact');
  assert.equal(CORE.meleeSurfaceSound('brick'), 'impact');
  assert.equal(CORE.meleeSurfaceSound(), 'impact');
});

test('v144 combat balance integration: weapon archetype recoil decay, empty swap agility, and tactical slide momentum', () => {
  // 1. Recoil decay rates and stance stabilization
  assert.equal(CORE.RECOIL_DECAY_SMG, 0.006);
  assert.equal(CORE.RECOIL_DECAY_AR, 0.02);
  assert.equal(CORE.RECOIL_DECAY_BR, 0.05);
  assert.equal(CORE.RECOIL_DECAY_SR, 0.10);
  assert.equal(CORE.RECOIL_DECAY_CROUCH_MUL, 0.65);
  assert.equal(CORE.RECOIL_DECAY_SLIDE_MUL, 0.85);

  const smgRate = CORE.weaponRecoilDecayRate('SMG', false, false);
  const srRate = CORE.weaponRecoilDecayRate('SR', false, false);
  assert.equal(smgRate, 0.006);
  assert.equal(srRate, 0.10);

  // Over 0.1s dt, SMG recoil decays to ~0.598, whereas SR recoil decays to ~0.794 (SMG recenters much faster)
  const smgDecay = CORE.recoilDecay(0.1, 0.1, smgRate);
  const srDecay = CORE.recoilDecay(0.1, 0.1, srRate);
  assert.ok(smgDecay < srDecay, 'SMG recoil should decay faster than SR');

  // Crouching braces the recoil: faster recentering
  const crouchRate = CORE.weaponRecoilDecayRate('AR', true, false);
  assert.ok(Math.abs(crouchRate - (0.02 * 0.65)) < 1e-6);
  assert.ok(CORE.recoilDecay(0.1, 0.1, crouchRate) < CORE.recoilDecay(0.1, 0.1, 0.02), 'crouching should speed up recoil recovery');

  // 2. Empty swap agility
  assert.equal(CORE.EMPTY_SWAP_SPEED_MUL, 1.25);
  const arNormalSwitch = CORE.weaponSwitchSpeed('AR', false, false);
  const arEmptySwitch = CORE.weaponSwitchSpeed('AR', false, true);
  assert.ok(Math.abs(arEmptySwitch - (arNormalSwitch * 1.25)) < 1e-6);

  // 3. Tactical sprint slide kinetic momentum
  const baseSprint = CORE.slideBaseSprintSpeed(5.4, 1.65, false);
  const tacSprint = CORE.slideBaseSprintSpeed(5.4, 1.65, true);
  assert.ok(Math.abs(baseSprint - 8.91) < 1e-6);
  assert.ok(Math.abs(tacSprint - (8.91 * CORE.TAC_SPRINT_SPEED_MUL)) < 1e-6);
  assert.ok(tacSprint > baseSprint);
});

test('v147 visual polish integration: ordnance explosion VFX, marksman sniper vapor trail, and enemy muzzle flash rules', () => {
  // 1. Ordnance explosion VFX particle counts & dynamic point light scaling
  assert.equal(CORE.EXPLOSION_FIREBALL_BASE_COUNT, 18);
  assert.equal(CORE.EXPLOSION_SPARK_BASE_COUNT, 40);
  assert.equal(CORE.EXPLOSION_SMOKE_BASE_COUNT, 22);
  assert.equal(CORE.EXPLOSION_DUST_BASE_COUNT, 16);
  assert.equal(CORE.EXPLOSION_DEBRIS_BASE_COUNT, 14);
  assert.equal(CORE.EXPLOSION_LIGHT_COLOR, 0xff9040);
  assert.equal(CORE.EXPLOSION_LIGHT_BASE_INTENSITY, 14.0);
  assert.equal(CORE.EXPLOSION_LIGHT_BASE_DIST, 22.0);
  assert.equal(CORE.EXPLOSION_LIGHT_DUR, 0.45);

  const exp1 = CORE.explosionVfxParams(1.0);
  assert.equal(exp1.fireballCount, 18);
  assert.equal(exp1.sparkCount, 40);
  assert.equal(exp1.smokeCount, 22);
  assert.equal(exp1.dustCount, 16);
  assert.equal(exp1.debrisCount, 14);
  assert.equal(exp1.fireballColor0, 0xfff0c0);
  assert.equal(exp1.fireballColor1, 0xff3808);
  assert.equal(exp1.sparkColor0, 0xffe0a0);
  assert.equal(exp1.sparkColor1, 0xff4010);
  assert.equal(exp1.smokeColor0, 0x3a3230);
  assert.equal(exp1.smokeColor1, 0x1c1a1a);
  assert.equal(exp1.dustColor0, 0x7a6e62);
  assert.equal(exp1.dustColor1, 0x4a443e);
  assert.equal(exp1.debrisColor0, 0x2a2624);
  assert.equal(exp1.debrisColor1, 0x1a1816);

  const expScaled = CORE.explosionVfxParams(1.4);
  assert.equal(expScaled.fireballCount, 25);
  assert.equal(expScaled.sparkCount, 56);
  assert.equal(expScaled.smokeCount, 31);
  assert.equal(expScaled.dustCount, 22);
  assert.equal(expScaled.debrisCount, 20);

  const light1 = CORE.explosionLightParams(1.0);
  assert.equal(light1.color, 0xff9040);
  assert.equal(light1.intensity, 14.0);
  assert.equal(light1.distance, 22.0);
  assert.equal(light1.duration, 0.45);

  const lightScaled = CORE.explosionLightParams(1.4);
  assert.ok(Math.abs(lightScaled.intensity - (14.0 * 1.4)) < 1e-4);
  assert.ok(Math.abs(lightScaled.distance - (22.0 * 1.4)) < 1e-4);

  // 2. Marksman sniper vapor trail kinematics & aesthetics
  assert.equal(CORE.SNIPER_TRAIL_STEP, 1.4);
  assert.equal(CORE.SNIPER_TRAIL_MAX_PUFFS, 45);
  assert.equal(CORE.SNIPER_TRAIL_COLOR0, 0xc8ccd0);
  assert.equal(CORE.SNIPER_TRAIL_COLOR1, 0x8a8e94);
  assert.equal(CORE.SNIPER_TRAIL_BASE_SIZE, 0.05);
  assert.equal(CORE.SNIPER_TRAIL_END_SIZE, 0.35);
  assert.equal(CORE.SNIPER_TRAIL_ALPHA, 0.16);

  assert.equal(CORE.sniperTrailPuffCount(28.0), 20);
  assert.equal(CORE.sniperTrailPuffCount(0), 0);
  assert.equal(CORE.sniperTrailPuffCount(100.0), 45); // clamped to max puffs

  const trailParams = CORE.sniperTrailParams(28.0);
  assert.equal(trailParams.count, 20);
  assert.equal(trailParams.color0, 0xc8ccd0);
  assert.equal(trailParams.color1, 0x8a8e94);
  assert.equal(trailParams.baseSize, 0.05);
  assert.equal(trailParams.endSize, 0.35);
  assert.equal(trailParams.alpha, 0.16);

  // 3. Enemy archetype weapon muzzle flash & tracer dispatch
  assert.equal(CORE.enemyWeaponType(1, false), 'AR'); // Rifleman
  assert.equal(CORE.enemyWeaponType(2, false), 'BR'); // Tank (heavy)
  assert.equal(CORE.enemyWeaponType(3, false), 'SMG'); // Shielded advancer (carbine)
  assert.equal(CORE.enemyWeaponType(5, false), 'AR'); // Grenadier
  assert.equal(CORE.enemyWeaponType(1, true), 'BR'); // Elite Rifleman
  assert.equal(CORE.tracerColor(true), 0xff8844);
  assert.equal(CORE.tracerColor(false), 0xffe9a0);
});

test('v148 audio polish integration: weapon dry fire, resource pickups, athletic melee swing, and ordnance explosion acoustics rules', () => {
  // 1. Weapon dry fire empty chamber hammer strike acoustics
  assert.equal(CORE.DRY_FIRE_SOUND, 'dry');
  assert.equal(CORE.DRY_FIRE_HEAVY_SOUND, 'dry_heavy');
  assert.equal(CORE.dryFireSound('SR'), 'dry_heavy');
  assert.equal(CORE.dryFireSound('BR'), 'dry_heavy');
  assert.equal(CORE.dryFireSound('SMG'), 'dry');
  assert.equal(CORE.dryFireSound('AR'), 'dry');
  assert.equal(CORE.dryFireSound(''), 'dry');
  assert.equal(CORE.dryFireSound(), 'dry');

  // 2. Resource pickup acoustic differentiation
  assert.equal(CORE.PICKUP_AMMO_SOUND, 'pickup_ammo');
  assert.equal(CORE.PICKUP_MED_SOUND, 'pickup_med');
  assert.equal(CORE.PICKUP_POWER_SOUND, 'powerup');
  assert.equal(CORE.pickupSound('ammo'), 'pickup_ammo');
  assert.equal(CORE.pickupSound('med'), 'pickup_med');
  assert.equal(CORE.pickupSound('health'), 'pickup_med');
  assert.equal(CORE.pickupSound('power', 'nuke'), 'powerup_nuke');
  assert.equal(CORE.pickupSound('power', 'ammo'), 'powerup_ammo');
  assert.equal(CORE.pickupSound('power', 'unknown'), 'powerup');
  assert.equal(CORE.pickupSound(), 'pickup_ammo');

  // 3. Athletic melee swing kinetic whoosh acoustics
  assert.equal(CORE.MELEE_SWING_SOUND, 'melee');
  assert.equal(CORE.MELEE_SWING_HEAVY_SOUND, 'melee_heavy');
  assert.equal(CORE.meleeSwingSound(true, false), 'melee_heavy');
  assert.equal(CORE.meleeSwingSound(false, true), 'melee_heavy');
  assert.equal(CORE.meleeSwingSound(true, true), 'melee_heavy');
  assert.equal(CORE.meleeSwingSound(false, false), 'melee');
  assert.equal(CORE.meleeSwingSound(), 'melee');

  // 4. Ordnance explosion acoustic scale differentiation
  assert.equal(CORE.EXPLOSION_SOUND, 'explosion');
  assert.equal(CORE.EXPLOSION_HEAVY_SOUND, 'explosion_heavy');
  assert.equal(CORE.explosionSound(1.0), 'explosion');
  assert.equal(CORE.explosionSound(1.2), 'explosion_heavy');
  assert.equal(CORE.explosionSound(1.5), 'explosion_heavy');
  assert.equal(CORE.explosionSound(0.45), 'explosion');
  assert.equal(CORE.explosionSound(), 'explosion');
});

test('v149 combat balance integration: weapon sprint-to-fire agility, sprint stance spread, and armor plate action gating rules', () => {
  // 1. Weapon sprint-to-fire agility constants and transition delay
  assert.equal(CORE.WEAPON_STF_SMG, 0.12);
  assert.equal(CORE.WEAPON_STF_AR, 0.18);
  assert.equal(CORE.WEAPON_STF_BR, 0.24);
  assert.equal(CORE.WEAPON_STF_SR, 0.32);
  assert.equal(CORE.TAC_SPRINT_STF_MUL, 1.45);
  assert.equal(CORE.FAST_HANDS_STF_MUL, 0.80);

  assert.equal(CORE.weaponSprintToFireTime('SMG', false, false), 0.12);
  assert.ok(Math.abs(CORE.weaponSprintToFireTime('SMG', true, false) - (0.12 * 1.45)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponSprintToFireTime('SMG', false, true) - (0.12 * 0.80)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponSprintToFireTime('SMG', true, true) - (0.12 * 1.45 * 0.80)) < 1e-4);
  assert.equal(CORE.weaponSprintToFireTime('AR', false, false), 0.18);
  assert.equal(CORE.weaponSprintToFireTime('BR', false, false), 0.24);
  assert.equal(CORE.weaponSprintToFireTime('SR', false, false), 0.32);
  assert.equal(CORE.weaponSprintToFireTime('', false, false), 0.18);
  assert.equal(CORE.weaponSprintToFireTime(undefined, false, false), 0.18);

  // 2. Stance spread multiplier sprint & tactical sprint penalties
  assert.equal(CORE.STANCE_SPREAD_SPRINT, 1.35);
  assert.equal(CORE.STANCE_SPREAD_TAC_SPRINT, 1.60);
  assert.equal(CORE.stanceSpreadMultiplier(false, false, false, false), 1.0);
  assert.equal(CORE.stanceSpreadMultiplier(true, false, false, false), 0.80);
  assert.equal(CORE.stanceSpreadMultiplier(false, true, false, false), 1.25);
  assert.equal(CORE.stanceSpreadMultiplier(false, false, true, false), 1.35);
  assert.equal(CORE.stanceSpreadMultiplier(false, false, true, true), 1.60);
  assert.equal(CORE.stanceSpreadMultiplier(false, false, false, true), 1.60);
  assert.equal(CORE.stanceSpreadMultiplier(true, false, true, false), 1.35);
  assert.equal(CORE.stanceSpreadMultiplier(false, true, true, false), 1.25);

  // 3. Armor plate insertion action gating and deliberate mobility
  assert.equal(CORE.PLATE_MOVE_SPEED_MUL, 0.78);
  assert.equal(CORE.canPlayerFire(false, false, false, 30, true), false);
  assert.equal(CORE.canPlayerFire(false, false, false, 30, false), true);
  assert.equal(CORE.canPlayerFire(false, false, false, 30), true);
  assert.equal(CORE.canPlayerReload(false, false, 10, 30, 90, true), false);
  assert.equal(CORE.canPlayerReload(false, false, 10, 30, 90, false), true);
  assert.equal(CORE.canPlayerReload(false, false, 10, 30, 90), true);

  const baseSpeed = 5.4;
  const normalMove = CORE.playerMoveSpeed(baseSpeed, 1, false, false, false, false, false, false, 1.65, 0.55, 1, false);
  const platingMove = CORE.playerMoveSpeed(baseSpeed, 1, false, false, false, false, false, false, 1.65, 0.55, 1, true);
  assert.equal(normalMove, 5.4);
  assert.ok(Math.abs(platingMove - (5.4 * 0.78)) < 1e-4);
});

test('v152 visual polish integration: ballistic surface impact VFX, dynamic light, and blood spatter kinematics rules', () => {
  // 1. Surface impact constants
  assert.equal(CORE.SURFACE_IMPACT_DUST_BASE, 3);
  assert.equal(CORE.SURFACE_IMPACT_CHIP_BASE, 5);
  assert.equal(CORE.SURFACE_IMPACT_SPARK_METAL, 8);
  assert.equal(CORE.SURFACE_IMPACT_SPARK_CONCRETE, 1);
  assert.equal(CORE.SURFACE_IMPACT_LIGHT_COLOR_METAL, 0xffb060);
  assert.equal(CORE.SURFACE_IMPACT_LIGHT_COLOR_HEAVY, 0xffd090);

  // 2. Ballistic surface impact VFX params across weapon calibers
  const srfConcreteSR = CORE.surfaceImpactVfxParams('concrete', 'SR');
  assert.equal(srfConcreteSR.dustCount, 5);
  assert.equal(srfConcreteSR.dustScale, 1.4);
  assert.equal(srfConcreteSR.chipCount, 7);
  assert.equal(srfConcreteSR.sparkCount, 2);
  assert.equal(srfConcreteSR.dustColor0, 0x8f8a84);
  assert.equal(srfConcreteSR.dustColor1, 0x5e5a56);
  assert.equal(srfConcreteSR.chipColor, 0xb0aca4);

  const srfConcreteBR = CORE.surfaceImpactVfxParams('concrete', 'BR');
  assert.equal(srfConcreteBR.dustCount, 4);
  assert.equal(srfConcreteBR.dustScale, 1.2);
  assert.equal(srfConcreteBR.chipCount, 6);
  assert.equal(srfConcreteBR.sparkCount, 1);

  const srfConcreteAR = CORE.surfaceImpactVfxParams('concrete', 'AR');
  assert.equal(srfConcreteAR.dustCount, 3);
  assert.equal(srfConcreteAR.dustScale, 1.0);
  assert.equal(srfConcreteAR.chipCount, 5);
  assert.equal(srfConcreteAR.sparkCount, 1);

  const srfConcreteSMG = CORE.surfaceImpactVfxParams('concrete', 'SMG');
  assert.equal(srfConcreteSMG.dustCount, 2);
  assert.equal(srfConcreteSMG.dustScale, 0.8);
  assert.equal(srfConcreteSMG.chipCount, 4);
  assert.equal(srfConcreteSMG.sparkCount, 1);

  const srfMetalSR = CORE.surfaceImpactVfxParams('metal', 'SR');
  assert.equal(srfMetalSR.dustCount, 5);
  assert.equal(srfMetalSR.chipCount, 0);
  assert.equal(srfMetalSR.sparkCount, 14);

  const srfMetalSMG = CORE.surfaceImpactVfxParams('metal', 'SMG');
  assert.equal(srfMetalSMG.dustCount, 2);
  assert.equal(srfMetalSMG.chipCount, 0);
  assert.equal(srfMetalSMG.sparkCount, 5);

  const srfWoodAR = CORE.surfaceImpactVfxParams('wood', 'AR');
  assert.equal(srfWoodAR.sparkCount, 0);
  assert.equal(srfWoodAR.chipCount, 5);
  assert.equal(srfWoodAR.chipColor, 0x9a7448);

  // 3. Dynamic point light impact parameters
  const lightMetalSR = CORE.surfaceImpactLightParams('metal', 'SR');
  assert.equal(lightMetalSR.color, 0xffc070);
  assert.equal(lightMetalSR.intensity, 2.2);
  assert.equal(lightMetalSR.distance, 5.5);
  assert.equal(lightMetalSR.duration, 0.08);

  const lightMetalAR = CORE.surfaceImpactLightParams('metal', 'AR');
  assert.equal(lightMetalAR.color, 0xffb060);
  assert.equal(lightMetalAR.intensity, 1.2);
  assert.equal(lightMetalAR.distance, 4.0);

  const lightConcreteSR = CORE.surfaceImpactLightParams('concrete', 'SR');
  assert.equal(lightConcreteSR.color, 0xffd090);
  assert.equal(lightConcreteSR.intensity, 1.0);
  assert.equal(lightConcreteSR.distance, 4.0);
  assert.equal(lightConcreteSR.duration, 0.05);

  const lightConcreteAR = CORE.surfaceImpactLightParams('concrete', 'AR');
  assert.equal(lightConcreteAR.intensity, 0);

  const lightWoodSR = CORE.surfaceImpactLightParams('wood', 'SR');
  assert.equal(lightWoodSR.intensity, 0);

  // 4. Ballistic blood impact VFX params
  assert.equal(CORE.BLOOD_DROPLET_BASE_BODY, 6);
  assert.equal(CORE.BLOOD_DROPLET_BASE_HEAD, 10);
  assert.equal(CORE.BLOOD_MIST_BASE_BODY, 2);
  assert.equal(CORE.BLOOD_MIST_BASE_HEAD, 4);

  const bSRHead = CORE.bloodImpactVfxParams(true, 'SR');
  assert.equal(bSRHead.dropletCount, 16);
  assert.equal(bSRHead.mistCount, 6);
  assert.equal(bSRHead.mistScale, 1.1);
  assert.equal(bSRHead.dropletColor0, 0x5a0404);
  assert.equal(bSRHead.mistColor0, 0x6a0808);

  const bARHead = CORE.bloodImpactVfxParams(true, 'AR');
  assert.equal(bARHead.dropletCount, 10);
  assert.equal(bARHead.mistCount, 4);
  assert.equal(bARHead.mistScale, 0.8);

  const bSMGBody = CORE.bloodImpactVfxParams(false, 'SMG');
  assert.equal(bSMGBody.dropletCount, 4);
  assert.equal(bSMGBody.mistCount, 1);
  assert.equal(bSMGBody.mistScale, 0.4);
});

test('v153 audio polish integration: scope acoustics, casing bounce, and kill sound differentiation', () => {
  // 1. Weapon scope in/out sound mappings
  assert.equal(CORE.weaponScopeSound('SR', true), 'scope_heavy_in');
  assert.equal(CORE.weaponScopeSound('SR', false), 'scope_heavy_out');
  assert.equal(CORE.weaponScopeSound('BR', true), 'scope_in');
  assert.equal(CORE.weaponScopeSound('BR', false), 'scope_out');

  // 2. Spent casing bounce acoustic caliber differentiation
  assert.equal(CORE.casingBounceSound('SR'), 'casing_heavy');
  assert.equal(CORE.casingBounceSound('BR'), 'casing_heavy');
  assert.equal(CORE.casingBounceSound('AR'), 'casing');
  assert.equal(CORE.casingBounceSound('SMG'), 'casing');

  // 3. Tank enemy kill confirmation acoustics
  assert.equal(CORE.killConfirmationSound(false, false, true), 'kill_heavy');
  assert.equal(CORE.killConfirmationSound(false, false, false), 'kill');
  assert.equal(CORE.killConfirmationSound(true, false, false), 'kill_headshot');
  assert.equal(CORE.killConfirmationSound(false, true, false), 'kill_elite');

  // 4. Secondary unlock and station cycling acoustics
  assert.equal(CORE.secondaryUnlockSound('SR'), 'draw_heavy');
  assert.equal(CORE.secondaryUnlockSound('SMG'), 'draw_light');
  assert.equal(CORE.stationCycleSound('lethal'), 'draw_light');
});

test('v154 combat balance integration: weapon shot kick impulses, stance ADS agility, and enemy ranged damage scaling rules', () => {
  // 1. Weapon shot kick impulse constants & function with suppressor dampening
  assert.equal(CORE.WEAPON_SHOT_KICK_SMG, 0.35);
  assert.equal(CORE.WEAPON_SHOT_KICK_AR, 0.50);
  assert.equal(CORE.WEAPON_SHOT_KICK_BR, 0.70);
  assert.equal(CORE.WEAPON_SHOT_KICK_SR, 1.10);
  assert.equal(CORE.SUPPRESSOR_KICK_MUL, 0.85);

  assert.equal(CORE.weaponShotKickImpulse('SMG', false), 0.35);
  assert.equal(CORE.weaponShotKickImpulse('AR', false), 0.50);
  assert.equal(CORE.weaponShotKickImpulse('BR', false), 0.70);
  assert.equal(CORE.weaponShotKickImpulse('SR', false), 1.10);
  assert.equal(CORE.weaponShotKickImpulse('', false), 0.50);
  assert.equal(CORE.weaponShotKickImpulse(undefined, false), 0.50);

  assert.ok(Math.abs(CORE.weaponShotKickImpulse('SMG', true) - (0.35 * 0.85)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponShotKickImpulse('AR', true) - (0.50 * 0.85)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponShotKickImpulse('BR', true) - (0.70 * 0.85)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponShotKickImpulse('SR', true) - (1.10 * 0.85)) < 1e-4);

  // 2. Stance ADS transition agility multiplier rules
  assert.equal(CORE.STANCE_ADS_CROUCH_MUL, 1.15);
  assert.equal(CORE.STANCE_ADS_SLIDE_MUL, 0.80);

  assert.equal(CORE.stanceAdsSpeedMultiplier(false, false), 1.0);
  assert.equal(CORE.stanceAdsSpeedMultiplier(true, false), 1.15);
  assert.equal(CORE.stanceAdsSpeedMultiplier(false, true), 0.80);
  assert.equal(CORE.stanceAdsSpeedMultiplier(true, true), 0.80); // sliding takes precedence over crouch

  assert.equal(CORE.weaponAdsSpeed('SMG'), CORE.WEAPON_ADS_SPEED_SMG);
  assert.ok(Math.abs(CORE.weaponAdsSpeed('SMG', undefined, 1.15) - (CORE.WEAPON_ADS_SPEED_SMG * 1.15)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponAdsSpeed('SMG', undefined, 0.80) - (CORE.WEAPON_ADS_SPEED_SMG * 0.80)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponAdsSpeed('AR', undefined, 1.15) - (CORE.WEAPON_ADS_SPEED_AR * 1.15)) < 1e-4);
  assert.ok(Math.abs(CORE.weaponAdsSpeed('AR', 1.5, 1.15) - (1.5 * 1.15)) < 1e-4);

  // 3. Enemy archetype ranged weapon ballistic scaling rules
  assert.equal(CORE.ENEMY_RANGED_TANK_BONUS, 3);
  assert.equal(CORE.ENEMY_RANGED_SHIELD_PENALTY, -2);

  // Default / Rifleman: base 8 + wave 1 * 0.35 = 8.35
  const baseDmg = 8, wave = 1, diff = 1.0, isElite = false;
  const dmgDefault = CORE.enemyRangedDamage(baseDmg, wave, diff, isElite);
  assert.ok(Math.abs(dmgDefault - 8.35) < 1e-4);

  // Tank (kind 2 or 'tank'): (8 + 3 + 1 * 0.35) = 11.35
  const dmgTankNum = CORE.enemyRangedDamage(baseDmg, wave, diff, isElite, 2);
  const dmgTankStr = CORE.enemyRangedDamage(baseDmg, wave, diff, isElite, 'tank');
  assert.ok(Math.abs(dmgTankNum - 11.35) < 1e-4);
  assert.ok(Math.abs(dmgTankStr - 11.35) < 1e-4);

  // Shielded (kind 3 or 'shielded'): (8 - 2 + 1 * 0.35) = 6.35
  const dmgShieldNum = CORE.enemyRangedDamage(baseDmg, wave, diff, isElite, 3);
  const dmgShieldStr = CORE.enemyRangedDamage(baseDmg, wave, diff, isElite, 'shielded');
  assert.ok(Math.abs(dmgShieldNum - 6.35) < 1e-4);
  assert.ok(Math.abs(dmgShieldStr - 6.35) < 1e-4);

  // Elite multiplier still applies on top
  const dmgTankElite = CORE.enemyRangedDamage(baseDmg, wave, diff, true, 2);
  assert.ok(Math.abs(dmgTankElite - (11.35 * CORE.ELITE.dmgMul)) < 1e-4);
});

