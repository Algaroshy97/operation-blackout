// ============ SETTINGS & CAREER STATS (persistence layer) ============
'use strict';
// The rules live in CORE (schema, clamping, stat merging) so they are testable
// headless; this file is only the browser plumbing — localStorage plus the
// side-effects each setting has on the live game.
//
// Every read is defensive: localStorage throws in some privacy modes, can hold a
// value written by an older build, and is user-editable.

const STORE_KEY_SETTINGS = 'blackout.settings.v1';
const STORE_KEY_STATS = 'blackout.stats.v1';
const STORE_KEY_SAVE = 'blackout.save.v1';

function storageGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { return false; }   // private mode / quota: settings just stay session-only
}

let SETTINGS = CORE.sanitizeSettings(storageGet(STORE_KEY_SETTINGS));
let STATS = CORE.sanitizeStats(storageGet(STORE_KEY_STATS));

function saveSettings() { storageSet(STORE_KEY_SETTINGS, SETTINGS); }
function saveStats() { storageSet(STORE_KEY_STATS, STATS); }

// Respect the OS-level accessibility preference the first time we ever run, but
// never override an explicit choice the player has already saved.
(function adoptSystemPreferences() {
  if (storageGet(STORE_KEY_SETTINGS)) return;
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) SETTINGS.reducedMotion = true;
  } catch (e) { /* matchMedia unavailable */ }
})();

function getSetting(key) { return SETTINGS[key]; }
function setSetting(key, value) {
  const v = CORE.clampSetting(key, value);
  if (v === undefined) return;
  SETTINGS[key] = v;
  applySetting(key);
  saveSettings();
}
function resetSettings() {
  SETTINGS = CORE.defaultSettings();
  applyAllSettings();
  saveSettings();
}

// ---- Side-effects -----------------------------------------------------------
function applySetting(key) {
  switch (key) {
    case 'musicVolume':
      break;   // read live by updateMusic each frame
    case 'masterVolume':
    case 'muted':
      if (typeof setMasterVolume === 'function') {
        setMasterVolume(SETTINGS.muted ? 0 : SETTINGS.masterVolume);
      }
      break;
    case 'quality':
      applyQuality();
      break;
    case 'showFps': {
      const el = $id('fps-counter');
      if (el) el.style.display = SETTINGS.showFps ? '' : 'none';
      break;
    }
    case 'colorblindMarkers':
      document.body.classList.toggle('cb-markers', SETTINGS.colorblindMarkers);
      break;
    case 'reducedMotion':
      document.body.classList.toggle('reduced-motion', SETTINGS.reducedMotion);
      break;
    // sensitivity, invertY and fov are read live by the player/camera code
  }
}
function applyAllSettings() {
  for (const k in CORE.SETTINGS_SCHEMA) applySetting(k);
}

// 'auto' keeps the existing adaptive pixel-ratio behaviour; the explicit presets
// pin it so a player who knows their hardware is not second-guessed every 4.5 s.
function qualityIsAuto() { return SETTINGS.quality === 'auto'; }
function applyQuality() {
  const q = SETTINGS.quality;
  if (q === 'auto') return;   // frame() keeps adapting
  const cap = Math.min(window.devicePixelRatio, 1.75);
  if (q === 'low') {
    renderer.setPixelRatio(Math.min(cap, 0.7));
    renderer.shadowMap.enabled = false;
  } else if (q === 'medium') {
    renderer.setPixelRatio(Math.min(cap, 1.0));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  } else {
    renderer.setPixelRatio(cap);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = IS_TOUCH ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  }
  renderer.shadowMap.needsUpdate = true;
}

// ---- Career stats -----------------------------------------------------------
// Called once when a run ends (death or victory).
function recordRun(run) {
  const merged = CORE.mergeRunIntoStats(STATS, run);
  STATS = merged.stats;
  saveStats();
  return merged.beat;
}
function getStats() { return STATS; }

// ---- Checkpoint --------------------------------------------------------------
// Saved between waves only: mid-combat there is no clean state to restore to.
function saveCheckpoint(state) {
  state.savedAt = Date.now();
  return storageSet(STORE_KEY_SAVE, CORE.makeCheckpoint(state));
}
function loadCheckpoint() {
  return CORE.validateCheckpoint(storageGet(STORE_KEY_SAVE), CFG.weapons.length);
}
function clearCheckpoint() {
  try { localStorage.removeItem(STORE_KEY_SAVE); } catch (e) { /* ignore */ }
}
function hasCheckpoint() { return !!loadCheckpoint(); }
function statsSummaryHtml() {
  if (!STATS.runs) return '';
  return 'Best score <b>' + STATS.bestScore + '</b> &nbsp;·&nbsp; Best wave <b>' + STATS.bestWave +
    '</b> &nbsp;·&nbsp; Best accuracy <b>' + Math.round(STATS.bestAccuracy) + '%</b><br>' +
    '<span style="opacity:.65">' + STATS.runs + ' deployment' + (STATS.runs === 1 ? '' : 's') +
    ' · ' + STATS.totalKills + ' total kills</span>';
}
