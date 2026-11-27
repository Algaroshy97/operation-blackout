'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const CORE = require('../src/01_core.js');

function loadGame(...files) {
  const listeners = {};
  const noop = () => {};
  const settings = CORE.defaultSettings();
  const ctx = vm.createContext({
    CORE, console, settings, getSetting: key => settings[key],
    CFG: { player: {
      height: 1.7, crouchHeight: 1.05, radius: 0.35, speed: 5.4, sprintMul: 1.65,
      crouchMul: 0.55, accel: 16, decel: 38, jumpVel: 5.6, gravity: 16,
      health: 100, armor: 0, maxStamina: 5, regenDelay: 5,
    }},
    document: { addEventListener: noop }, canvas: { addEventListener: noop },
    addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); },
    sendInput: (type, code) => listeners[type].forEach(handler => handler({code, preventDefault: noop})),
    perks: [], mapBounds: 80, GROUND: 0, colliders: [], enemies: [], gameT: 1, gameEnded: false,
    applyTouchInput: noop, adsDown: () => false, playSound: noop, spawnSlideDust: noop,
    curW: () => null,
  });
  ctx.window = ctx;
  const run = code => vm.runInContext(code, ctx);
  for (const file of ['vendor/three-bundle.min.js', ...files]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  }
  return run;
}

test('released crouch edge starts a longer steerable slide that finishes crouched', () => {
  const run = loadGame('src/20_player.js');
  run(`let adsAmount = 0;
    started = true; player.onGround = true;
    sendInput('keydown', 'KeyW'); sendInput('keydown', 'ShiftLeft');
    updatePlayer(0.016);
    delete pressed.ShiftLeft;
    sendInput('keydown', 'KeyC'); sendInput('keyup', 'KeyC');
    updatePlayer(0.016);`);
  assert.equal(run('player.sliding && player.crouching && !keys.KeyC'), true);
  run('delete pressed.KeyC; sendInput("keydown", "KeyD"); for (let i = 0; i < 30; i++) updatePlayer(0.016)');
  assert.equal(run('player.sliding && Math.abs(player.slideDir.x) > 0.1'), true, 'slide continues and steers past 0.5s');
  run('for (let i = 0; i < 60; i++) updatePlayer(0.016)');
  assert.equal(run('!player.sliding && player.crouching'), true, 'slide finishes crouched even in hold mode');
  run('sendInput("keydown", "KeyC"); sendInput("keyup", "KeyC"); updatePlayer(0.016); delete pressed.KeyC;');
  assert.equal(run('player.crouching'), false, 'pressing and releasing crouch stands back up');
});

test('crouch settings default to hold, support toggle and overhead clearance, and reset on lifecycle', () => {
  const defaults = CORE.sanitizeSettings({});
  assert.equal(defaults.keyboardCrouch, 'hold');
  assert.equal(defaults.touchCrouch, 'hold');
  assert.equal(CORE.sanitizeSettings({ keyboardCrouch: 'toggle', touchCrouch: 'toggle' }).keyboardCrouch, 'toggle');
  assert.equal(CORE.sanitizeSettings({ touchCrouch: 'bad' }).touchCrouch, 'hold');

  // Toggle crouch survives key release, blocks standing under low ceiling, stands once clear, and resets on blur
  const run = loadGame('src/20_player.js');
  run(`let adsAmount = 0;
    started = true; player.onGround = true;
    settings.keyboardCrouch = 'toggle';
    colliders.push({ min: { x: -2, y: 1.35, z: 22 }, max: { x: 2, y: 2.5, z: 26 } });
    sendInput('keydown', 'KeyC'); sendInput('keyup', 'KeyC');
    updatePlayer(0.016); delete pressed.KeyC;`);
  assert.equal(run('player.crouching'), true);
  // Attempt to toggle stand while under low slab -> blocked by overhead clearance
  run("sendInput('keydown', 'KeyC'); sendInput('keyup', 'KeyC'); updatePlayer(0.016); delete pressed.KeyC;");
  assert.equal(run('player.crouching'), true, 'overhead clearance blocks standing');
  // Move clear of overhead slab -> stands up cleanly
  run("colliders.length = 0; updatePlayer(0.016);");
  assert.equal(run('player.crouching'), false);
  // Re-crouch toggle and blur -> resets crouch toggle cleanly
  run("sendInput('keydown', 'KeyC'); sendInput('keyup', 'KeyC'); updatePlayer(0.016); delete pressed.KeyC;");
  assert.equal(run('player.crouching'), true);
  run("sendInput('blur'); updatePlayer(0.016);");
  assert.equal(run('player.crouching || keyboardCrouch.toggled'), false);
});

test('slide animation produces pronounced smooth camera and weapon motion', () => {
  const run = loadGame('src/20_player.js');
  run(`const SKY_ENV = null, TEX = {gunNoise: {normalMap: null}, camo: {map: null, normalMap: null}, flash: null};
    const LIGHT_COMPAT = 1, gunCamera = new THREE.PerspectiveCamera();
    const camera = new THREE.PerspectiveCamera(75, 1.5);
    const SUN_SKY_DIR = new THREE.Vector3(1, 1, 0);
    let adsAmount = 0, gunSwitchT = 1, meleeSwing = 0, shotKick = 0, swayX = 0, swayY = 0;`);
  run(fs.readFileSync(path.join(__dirname, '../src/32_viewmodels.js'), 'utf8'));
  const anim = run(`(() => {
    const model = new THREE.Group(), parts = {};
    const tune = buildGunModel(model, parts, 'AR', {});
    const weapon = { type: 'AR', cls: 'AR', reload: 2 };
    player.slideBlend = 0;
    poseViewmodel(0.016, model, parts, tune, weapon, { ammo: 10 }, false);
    const hipRz = model.rotation.z, hipPy = model.position.y;
    player.slideBlend = 1;
    poseViewmodel(0.016, model, parts, tune, weapon, { ammo: 10 }, false);
    const slideRz = model.rotation.z, slidePy = model.position.y;
    const camPos = CORE.cameraPositionOffsets(0, 0, 1, false);
    const camRoll = CORE.cameraRoll(0, 0, 1, 0, false, 0, false);
    const camFov = CORE.mobilityFovBoost(true, false, 0, false, true);
    return { dRz: Math.abs(slideRz - hipRz), dPy: hipPy - slidePy, dip: -camPos.y, camRoll, camFov };
  })()`);
  assert.ok(anim.dRz >= 0.40, 'pronounced weapon slide roll cant');
  assert.ok(anim.dPy >= 0.07, 'pronounced weapon slide vertical tuck');
  assert.ok(anim.dip >= 0.45 && anim.camRoll >= 0.16 && anim.camFov >= 6, 'pronounced camera slide animation');
});

test('keyboard toggle survives release, supports tactical double tap and clears on blur', () => {
  const run = loadGame('src/20_player.js');
  run(`let adsAmount = 0;
    started = true; player.onGround = true;
    settings.keyboardSprint = 'toggle';
    sendInput('keydown', 'KeyW');
    const tap = () => { sendInput('keydown', 'ShiftLeft'); sendInput('keyup', 'ShiftLeft'); };
    tap(); updatePlayer(0.016);`);
  assert.equal(run('player.sprinting'), true);
  run('gameT += 0.12; tap(); updatePlayer(0.016)');
  assert.equal(run('player.sprinting && player.tacT > 0'), true);
  run('gameT += 0.5; tap(); updatePlayer(0.016)');
  assert.equal(run('player.sprinting'), false);
  run("gameT += 0.5; tap(); updatePlayer(0.016); sendInput('blur'); sendInput('keydown', 'KeyW'); updatePlayer(0.016)");
  assert.equal(run('player.sprinting || player.tacT > 0'), false);
});

test('sprint settings default independently to hold and round-trip valid values', () => {
  const defaults = CORE.sanitizeSettings({});
  assert.equal(defaults.keyboardSprint, 'hold');
  assert.equal(defaults.touchSprint, 'hold');
  const loaded = CORE.sanitizeSettings(JSON.parse(JSON.stringify({
    keyboardSprint: 'toggle', touchSprint: 'hold',
  })));
  assert.equal(loaded.keyboardSprint, 'toggle');
  assert.equal(loaded.touchSprint, 'hold');
  assert.equal(CORE.sanitizeSettings({touchSprint: 'invalid'}).touchSprint, 'hold');
});

test('all firearm families and the knife build shaped grips with connected wrists during posing', () => {
  const run = loadGame('src/20_player.js');
  run(`const SKY_ENV = null, TEX = {gunNoise: {normalMap: null}, camo: {map: null, normalMap: null}, flash: null};
    const LIGHT_COMPAT = 1, gunCamera = new THREE.PerspectiveCamera();
    const camera = new THREE.PerspectiveCamera(75, 1.5);
    const SUN_SKY_DIR = new THREE.Vector3(1, 1, 0);
    let adsAmount = 0, gunSwitchT = 1, meleeSwing = 0, shotKick = 0, swayX = 0, swayY = 0;`);
  // Load the real model and pose functions into the controller's context.
  run(fs.readFileSync(path.join(__dirname, '../src/32_viewmodels.js'), 'utf8'));
  for (const family of ['AR', 'SMG', 'BR', 'SR', 'SG', 'LMG', 'PST']) {
    const result = run(`(() => {
      const model = new THREE.Group(), parts = {};
      const tune = buildGunModel(model, parts, '${family}', {});
      const weapon = { type: '${family}', cls: '${family}', reload: 2 };
      const pose = state => poseViewmodel(0.016, model, parts, tune, weapon, state, false);
      pose({ ammo: 4 });
      const before = parts.handL.position.clone();
      pose({ ammo: 4, reloadT: 0.7, reloading: true });
      model.updateMatrixWorld(true);
      const grips = [parts.handR, parts.handL.children.find(o => o.name === 'support grip')];
      return {
        shaped: grips.every(hand => hand?.children[0]?.geometry.type === 'SphereGeometry'),
        connected: grips.every(hand => {
          const forearm = hand?.forearm;
          if (!forearm) return false;
          const wrist = forearm.mesh.localToWorld(new THREE.Vector3(0, 0.5, 0));
          return wrist.distanceTo(hand.localToWorld(forearm.wrist.clone())) < 0.0001;
        }),
        moved: parts.handL.position.distanceTo(before) > 0.04,
      };
    })()`);
    assert.equal(result.shaped, true, family + ' shaped palms');
    assert.equal(result.connected, true, family + ' wrists meet the sleeves');
    assert.equal(result.moved, true, family + ' support hand moves during reload');
  }
  assert.equal(run(`knifeGroup.getObjectByName('knife grip')?.children[0].geometry.type`), 'SphereGeometry');
});

test('knife commits one contact at the strike pose and skips allies, cover and other floors', () => {
  const run = loadGame('src/20_player.js', 'src/30_weapons.js');
  run(`const camera = new THREE.PerspectiveCamera();
    const hits = [], surfaces = [];
    const target = (team, x, y, z) => ({team, kind: 1, pos: new THREE.Vector3(x, y, z), yaw: Math.PI});
    const ally = target('friendly', 0, 0, -0.6);
    const blocked = target('enemy', 0, 0, -1.3);
    const overhead = target('enemy', 0, 3, -0.9);
    const outOfRange = target('enemy', 0, 0, -2.3);
    const exposed = target('enemy', 0.85, 0, -1.5);
    enemies.push(ally, blocked, overhead, outOfRange, exposed);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3, 0.1), new THREE.MeshBasicMaterial());
    wall.position.set(0, 1.5, -1);
    wall.updateMatrixWorld(true);
    const worldRayTargets = () => [wall];
    const damageEnemy = (enemy, damage) => hits.push({enemy, damage});
    const fxSurfaceFor = () => 'concrete';
    const spawnImpact = (...args) => surfaces.push(args);
    player.pos.set(0, 1.7, 0); camera.position.copy(player.pos); player.yaw = 0;
    pressed.KeyV = true;
    updateWeapons(0.016);
    delete pressed.KeyV;`);
  assert.equal(run('hits.length'), 0, 'wind-up does not damage');
  run('updateWeapons(0.19)');
  assert.equal(run('hits.length'), 0, 'pre-contact does not damage');
  run('updateWeapons(0.09)');
  assert.equal(run('hits.length === 1 && hits[0].enemy === exposed'), true);
  run('updateWeapons(0.5)');
  assert.equal(run('hits.length'), 1, 'a swing resolves only once');
  run(`enemies.length = 0;
    enemies.push(blocked, ally, overhead, outOfRange);
    updateWeapons(0.3);
    doMelee(); updateWeapons(0.3);`);
  assert.equal(run('hits.length'), 1);
  assert.equal(run('surfaces.length'), 1, 'wall receives a world impact');
  run('updateWeapons(0.9); doMelee(); player.downed = true; updateWeapons(0.3)');
  assert.equal(run('surfaces.length'), 1, 'downing cancels pending contact');
});

test('big enemy keeps larger collision without excess buffer and knife hits at reachable body edge while preserving rules', () => {
  const run = loadGame('src/20_player.js', 'src/30_weapons.js');
  const tankStop = CORE.enemyStopDistance(2);
  const runnerStop = CORE.enemyStopDistance(0);
  assert.ok(tankStop > runnerStop, 'tank keeps bigger collision stop distance than normal enemy');
  assert.ok(tankStop <= CORE.MELEE_REACH, 'tank stop distance has no excess invisible buffer beyond knife reach');

  const counts = run(`const camera = new THREE.PerspectiveCamera();
    const hits = [];
    let targets = [];
    const worldRayTargets = () => targets;
    const damageEnemy = (enemy, damage) => hits.push({enemy, damage});
    const fxSurfaceFor = () => 'concrete';
    const spawnImpact = () => {};
    player.pos.set(0, 1.7, 0); camera.position.copy(player.pos); player.yaw = 0;

    // Tank at reachable body edge (2.30m center, 2.14m edge <= 2.2m) hits reliably
    enemies.push({ team: 'enemy', kind: 2, pos: new THREE.Vector3(0, 0, -2.30), yaw: Math.PI });
    doMelee(); updateWeapons(0.3);
    const hitEdge = hits.length;

    // Tank beyond reachable body edge (2.45m center, 2.29m edge > 2.2m) misses
    hits.length = 0; meleeT = 0; enemies.length = 0;
    enemies.push({ team: 'enemy', kind: 2, pos: new THREE.Vector3(0, 0, -2.45), yaw: Math.PI });
    doMelee(); updateWeapons(0.3);
    const hitBeyond = hits.length;

    // Normal enemy at 2.30m still misses (normal enemy reach preserved)
    meleeT = 0; enemies.length = 0;
    enemies.push({ team: 'enemy', kind: 1, pos: new THREE.Vector3(0, 0, -2.30), yaw: Math.PI });
    doMelee(); updateWeapons(0.3);
    const hitNormal = hits.length;

    // Friendly Tank at close range is skipped (friendly-fire preserved)
    meleeT = 0; enemies.length = 0;
    enemies.push({ team: 'friendly', kind: 2, pos: new THREE.Vector3(0, 0, -1.8), yaw: Math.PI });
    doMelee(); updateWeapons(0.3);
    const hitAlly = hits.length;

    // Tank behind player is skipped (facing preserved)
    meleeT = 0; enemies.length = 0;
    enemies.push({ team: 'enemy', kind: 2, pos: new THREE.Vector3(0, 0, 2.0), yaw: 0 });
    doMelee(); updateWeapons(0.3);
    const hitBehind = hits.length;
    ({ hitEdge, hitBeyond, hitNormal, hitAlly, hitBehind });
  `);
  assert.equal(counts.hitEdge, 1);
  assert.equal(counts.hitBeyond, 0);
  assert.equal(counts.hitNormal, 0);
  assert.equal(counts.hitAlly, 0);
  assert.equal(counts.hitBehind, 0);

  // Tank behind wall is skipped (occlusion preserved)
  run(`hits.length = 0; meleeT = 0; enemies.length = 0;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.2), new THREE.MeshBasicMaterial());
    wall.position.set(0, 1.5, -1.0); wall.updateMatrixWorld(true);
    targets = [wall];
    enemies.push({ team: 'enemy', kind: 2, pos: new THREE.Vector3(0, 0, -2.1), yaw: Math.PI });
    doMelee(); updateWeapons(0.3);`);
  assert.equal(run('hits.length'), 0, 'wall occlusion blocks knife against tank');
});
