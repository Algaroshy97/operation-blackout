'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CORE = require('../src/01_core.js');
const source = name => fs.readFileSync(`${__dirname}/../src/${name}`, 'utf8');
const keys = ['enemyDetail', 'sceneryDetail', 'effects', 'ragdollQuality', 'shadowQuality', 'postProcessing'];

test('graphics settings sanitize old/invalid saves, persist explicit overrides and reset to auto', () => {
  for (const k of keys) {
    assert.equal(CORE.defaultSettings()[k], 'auto', k);
    assert.equal(CORE.sanitizeSettings({ [k]: 'invalid' })[k], 'auto');
    const choice = CORE.SETTINGS_SCHEMA[k].values.at(-1);
    assert.equal(CORE.sanitizeSettings(JSON.parse(JSON.stringify({ [k]: choice })))[k], choice);
  }
  assert.deepEqual(CORE.sanitizeSettings(null), CORE.defaultSettings());
  assert.equal(CORE.sanitizeSettings({ quality: 'high' }).enemyDetail, 'auto');
});

test('auto retains desktop/touch baselines; explicit settings override all graphics touch limits', () => {
  const desktop = CORE.graphicsSettings({}, false);
  const mobile = CORE.graphicsSettings({}, true);
  assert.equal(desktop.enemyDetailed, true); assert.equal(mobile.enemyDetailed, false);
  assert.equal(desktop.sceneryDetailed, true); assert.equal(mobile.sceneryDetailed, false);
  assert.equal(desktop.particles, 2600); assert.equal(mobile.particles, 900);
  assert.equal(desktop.ragdollMax, 6); assert.equal(mobile.ragdollMax, 3);
  assert.equal(desktop.shadowSize, 2048); assert.equal(mobile.shadowSize, 1024);
  assert.equal(desktop.shadowExtent, 38); assert.equal(mobile.shadowExtent, 26);
  assert.equal(desktop.shadowEnemies, 8); assert.equal(mobile.shadowEnemies, 4);
  assert.equal(desktop.anisotropy, 8); assert.equal(mobile.anisotropy, 4);
  const full = CORE.graphicsSettings({enemyDetail:'detailed', sceneryDetail:'detailed', effects:'full',
    ragdollQuality:'full', shadowQuality:'high', postProcessing:'on', quality:'high'}, true);
  assert.equal(full.enemyDetailed, true); assert.equal(full.sceneryDetailed, true);
  assert.equal(full.particles, 2600); assert.equal(full.flashLights, true);
  assert.equal(full.ragdollMax, 6); assert.equal(full.ragdollSimulation, 10);
  assert.equal(full.shadowSize, 2048); assert.equal(full.shadowEnemies, 8);
  assert.equal(full.shadowType, 'PCFSoftShadowMap'); assert.equal(full.anisotropy, 8);
  assert.equal(full.postfx, true);
  assert.equal(CORE.qualityRenderSettings('high', 3, true).shadowType, 'PCFSoftShadowMap');
  const off = CORE.graphicsSettings({effects:'off',ragdollQuality:'off',shadowQuality:'off',postProcessing:'off'}, false);
  assert.equal(off.particles, 0); assert.equal(off.flashLights, false);
  assert.equal(off.ragdollMax, 0); assert.equal(off.shadowEnabled, false); assert.equal(off.postfx, false);
  assert.equal(CORE.graphicsSettings({quality:'low',shadowQuality:'high',postProcessing:'on'}, true).postfx, true);
});

function particleHarness() {
  const layer = () => ({ cap: 0, life: new Float32Array(3000), alpha: new Float32Array(3000), size: new Float32Array(3000),
    cursor: 0, alive: 0, prevAlive: 0, hasNew: false, geo: { attributes: {alpha: {}, size:{}}, setDrawRange(_, n) { this.count = n; } } });
  const c = vm.createContext({PFX_MAX:3000, PFX_ADD:layer(), PFX_SMOKE:layer()});
  const text = source('48_particles.js');
  vm.runInContext(text.slice(text.indexOf('function setParticleBudget('), text.indexOf('// Storage stays')), c);
  return c;
}
test('real particle budget switching retires hidden slots and cannot resurrect stale particles on growth', () => {
  const c = particleHarness(); c.setParticleBudget(2600);
  for (const L of [c.PFX_ADD, c.PFX_SMOKE]) {
    L.life.fill(2); L.alpha.fill(1); L.size.fill(3); L.alive = L.cap; L.prevAlive = L.cap; L.cursor = L.cap - 1;
  }
  c.setParticleBudget(900);
  for (const L of [c.PFX_ADD, c.PFX_SMOKE]) {
    assert.equal(L.geo.count, L.cap); assert.ok(L.cursor < L.cap);
    assert.equal(L.life[L.cap], 0); assert.equal(L.alpha[L.cap], 0); assert.equal(L.size[L.cap], 0);
    assert.ok(L.alive <= L.cap); assert.equal(L.geo.attributes.alpha.needsUpdate, true);
  }
  c.setParticleBudget(2600); assert.equal(c.PFX_SMOKE.life[700], 0);
  c.setParticleBudget(0);
  for (const L of [c.PFX_ADD, c.PFX_SMOKE]) {
    assert.equal(L.life.some(x => x > 0), false); assert.equal(L.alive, 0); assert.equal(L.geo.count, 0);
  }
});

test('runtime shadow filtering maps retired soft filter to supported modern PCF', () => {
  const c=vm.createContext({CORE, THREE:{REVISION:'184', PCFShadowMap:1, PCFSoftShadowMap:2}});
  const s=source('02_settings.js'); const a=s.indexOf('function graphicsShadowType(');
  assert.ok(a>=0,'runtime compatibility helper exists');
  vm.runInContext(s.slice(a,s.indexOf('function applyQuality(',a)),c);
  assert.equal(c.graphicsShadowType('PCFSoftShadowMap'),1);
  c.THREE.REVISION='165'; assert.equal(c.graphicsShadowType('PCFSoftShadowMap'),2);
});

test('desktop presets preserve their original anisotropy', () => {
  for (const quality of ['auto','medium','high','low']) {
    assert.equal(CORE.graphicsSettings({quality},false).anisotropy,8);
  }
});

test('real ragdoll budgets retire oldest bodies, clean scene/geometry and suppress new corpses when off', () => {
  let disposed = 0; const removed = [];
  const c = vm.createContext({CORE, IS_TOUCH:true, SETTINGS:{ragdollQuality:'full'},
    scene:{remove:o=>removed.push(o)}, disposeEnemyGeometry(){disposed++;}});
  const text = source('45_ragdoll.js');
  const helper = text.slice(text.indexOf('function applyRagdollBudget('), text.indexOf('function spawnRagdoll('));
  assert.ok(helper.includes('RAGDOLL_MAX'), 'runtime budget helper exists');
  vm.runInContext('let RAGDOLL_MAX=6, RAGDOLL_BUDGET=10; const ragdolls=[];',c);
  vm.runInContext(helper + text.slice(text.indexOf('function removeRagdoll(')),c);
  vm.runInContext('for(let i=0;i<6;i++)ragdolls.push({en:{parts:{group:{i,add(){}}}},boxParts:[{obj:{i}}]});',c);
  c.SETTINGS.ragdollQuality='reduced'; c.applyRagdollBudget(); assert.equal(c.ragdollCount(),3);
  assert.equal(disposed,3); assert.equal(removed.length,6);
  c.SETTINGS.ragdollQuality='off'; c.applyRagdollBudget(); assert.equal(c.ragdollCount(),0);
  assert.equal(disposed,6); assert.equal(removed.length,12);
  c.SETTINGS.ragdollQuality='full'; c.applyRagdollBudget(); assert.equal(c.ragdollCount(),0);
  c.resetRagdolls(); assert.equal(disposed,6);
});

test('retiring simple ragdolls disposes geometry reparented outside the enemy group', () => {
  let disposed=0;
  const geometry={dispose(){disposed++;}};
  const root={children:[],userData:{},add(o){this.children.push(o);},traverse(fn){fn(this);for(const o of this.children)o.traverse(fn);}};
  const limb={geometry,userData:{},traverse(fn){fn(this);}};
  const c=vm.createContext({scene:{remove(){}},CORE,IS_TOUCH:true});
  const enemySource=source('40_enemies.js');
  vm.runInContext(enemySource.slice(enemySource.indexOf('function disposeEnemyGeometry('),enemySource.indexOf('// Shielded advancers')),c);
  const ragSource=source('45_ragdoll.js');
  vm.runInContext(ragSource.slice(ragSource.indexOf('function removeRagdoll('),ragSource.indexOf('function resetRagdolls(')),c);
  c.removeRagdoll({en:{parts:{group:root}},boxParts:[{obj:limb}]});
  assert.equal(disposed,1,'detached limb geometry is owned by the retired corpse and must be freed');
});

function settingsRuntimeHarness() {
  const calls = {ratio:0, world:0, enemies:0, post:0};
  const c = vm.createContext({CORE, IS_TOUCH:true, localStorage:{getItem:()=>null,setItem(){}},
    matchMedia:()=>({matches:false}), window:{devicePixelRatio:2},
    document:{body:{classList:{toggle(){}}},getElementById:()=>null}, $id:()=>null,
    THREE:{REVISION:'184',PCFShadowMap:1}, renderer:{shadowMap:{},setPixelRatio(){calls.ratio++;}},
    applyWorldGraphics(){calls.world++;}, updateEnemyShadowBudget(){calls.enemies++;},
    initPostfx(){calls.post++;}});
  vm.runInContext(source('02_settings.js'),c);
  return {c,calls};
}

test('independent shadow/post controls preserve adaptive resolution and unrelated GPU resources', () => {
  const {c,calls}=settingsRuntimeHarness();
  c.setSetting('shadowQuality','high');
  assert.deepEqual(calls,{ratio:0,world:1,enemies:1,post:0});
  c.setSetting('postProcessing','on');
  assert.deepEqual(calls,{ratio:0,world:1,enemies:1,post:1});
  c.setSetting('quality','high');
  assert.deepEqual(calls,{ratio:1,world:2,enemies:2,post:2});
});

test('reset applies combined renderer settings once rather than reallocating targets three times', () => {
  const {c,calls}=settingsRuntimeHarness(); c.resetSettings();
  assert.deepEqual(calls,{ratio:1,world:1,enemies:1,post:1});
});

test('settings storage unavailable still accepts session choices and reset; model detail remains boot-latched', () => {
  const c = vm.createContext({ CORE, localStorage: {getItem(){throw Error('blocked');}, setItem(){throw Error('blocked');}},
    matchMedia: () => ({matches:false}), document: {body:{classList:{toggle(){}}},getElementById:()=>null},
    $id:()=>null, applyQuality(){}, IS_TOUCH:true });
  vm.runInContext(source('02_settings.js'), c);
  vm.runInContext('applyQuality = function() {};', c);
  c.setSetting('enemyDetail','detailed'); assert.equal(c.getSetting('enemyDetail'), 'detailed');
  assert.equal(c.graphicsAtBoot(true).enemyDetailed, false);
  c.resetSettings(); assert.equal(c.getSetting('enemyDetail'), 'auto');
});
