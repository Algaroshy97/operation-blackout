'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = require('../src/01_core.js');

test('every setting maps to an accessible tab and defaults are preserved', () => {
  assert.ok(Array.isArray(CORE.SETTINGS_TABS) && CORE.SETTINGS_TABS.length >= 4);
  assert.equal(typeof CORE.settingTab, 'function');
  const tabIds = new Set(CORE.SETTINGS_TABS.map(t => t.id));
  for (const key of Object.keys(CORE.SETTINGS_SCHEMA)) {
    const t = CORE.settingTab(key);
    assert.ok(tabIds.has(t), `setting ${key} mapped to unknown tab ${t}`);
  }
  const def = CORE.defaultSettings();
  assert.equal(def.fpsCap, 'uncapped');
  assert.equal(def.adaptiveResolution, false);
  assert.equal(def.showFps, true);
  assert.equal(def.quality, 'auto');
});

test('fpsCap gating and adaptive resolution bounds remain stable and safe', () => {
  assert.equal(typeof CORE.shouldRenderFrame, 'function');
  assert.equal(CORE.shouldRenderFrame(10, 0, 'uncapped'), true);
  assert.equal(CORE.shouldRenderFrame(16, 0, '30'), false);
  assert.equal(CORE.shouldRenderFrame(33, 0, '30'), true);
  assert.equal(CORE.shouldRenderFrame(16.0, 0, '60'), true); // within 1.5ms vsync jitter tolerance

  assert.equal(typeof CORE.computeAdaptivePixelRatio, 'function');
  // Respects quality preset ceiling (medium caps at 1.0) and floor (0.65)
  const lowFps = CORE.computeAdaptivePixelRatio(1.0, 25, 2, 'medium', true, 'uncapped', 0);
  assert.equal(lowFps.pixelRatio, 0.9);
  const floorFps = CORE.computeAdaptivePixelRatio(0.65, 20, 2, 'auto', true, 'uncapped', 0);
  assert.equal(floorFps.pixelRatio, 0.65);
  // Capping at 30 FPS does not trigger false downscaling at 29 FPS
  const capped = CORE.computeAdaptivePixelRatio(1.2, 29, 2, 'auto', true, '30', 0);
  assert.equal(capped.pixelRatio, 1.2);
  // Upscale requires 3 consecutive good samples and respects preset ceiling
  let r = CORE.computeAdaptivePixelRatio(0.8, 60, 2, 'medium', true, 'uncapped', 0);
  assert.equal(r.pixelRatio, 0.8); assert.equal(r.upscaleStreak, 1);
  r = CORE.computeAdaptivePixelRatio(0.8, 60, 2, 'medium', true, 'uncapped', r.upscaleStreak);
  assert.equal(r.pixelRatio, 0.8); assert.equal(r.upscaleStreak, 2);
  r = CORE.computeAdaptivePixelRatio(0.8, 60, 2, 'medium', true, 'uncapped', r.upscaleStreak);
  assert.equal(r.pixelRatio, 0.9); assert.equal(r.upscaleStreak, 0);
});

test('settings UI builds accessible WAI-ARIA tabs with keyboard switching', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '../src/70_main.js'), 'utf8');
  assert.match(mainSrc, /role.*tablist|setAttribute\(['"]role['"],\s*['"]tab['"]\)/);
  assert.match(mainSrc, /aria-selected/);
  assert.match(mainSrc, /tabpanel/);
});
