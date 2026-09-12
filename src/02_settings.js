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
  // The caller wants the XP and rank too, so the end screen can say what the run
  // earned rather than only what it beat.
  merged.beat.xpGained = merged.xpGained;
  merged.beat.rank = merged.beat.rank;
  merged.beat.rankNow = merged.rank;
  merged.beat.rankBefore = merged.rankBefore;
  return merged.beat;
}
function getStats() { return STATS; }
function playerRank() { return CORE.rankForXp(CORE.sanitizeStats(STATS).xp); }

// ---- Gunsmith loadouts --------------------------------------------------------
// One attachment loadout per weapon index, persisted like settings. Kept out of the
// checkpoint on purpose: a loadout is a career choice, not run state, and a resumed
// run should use whatever the player has configured since.
const STORE_KEY_LOADOUTS = 'ob_loadouts_v1';
let LOADOUTS = (function () {
  const raw = storageGet(STORE_KEY_LOADOUTS);
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const k in raw) out[k] = CORE.sanitizeLoadout(raw[k]);
  }
  return out;
})();
function getLoadout(weaponIndex) {
  // Sanitised against the CURRENT rank on every read, so a loadout saved at a higher
  // rank cannot be carried by a wiped career, and a removed attachment cannot
  // resurrect.
  return CORE.sanitizeLoadout(LOADOUTS[weaponIndex] || {}, playerRank());
}
function setAttachment(weaponIndex, slot, key) {
  const cur = LOADOUTS[weaponIndex] || {};
  const next = {};
  for (const k in cur) next[k] = cur[k];
  if (key) next[slot] = key; else delete next[slot];
  LOADOUTS[weaponIndex] = CORE.sanitizeLoadout(next, playerRank());
  storageSet(STORE_KEY_LOADOUTS, LOADOUTS);
  return LOADOUTS[weaponIndex];
}

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

// Rank bar for the main menu. Rank is derived from XP rather than stored, so there
// is no such thing as a corrupt rank — only a corrupt XP total, which is clamped.
function rankBarHtml() {
  const p = CORE.rankProgress(CORE.sanitizeStats(STATS).xp);
  const pct = Math.round(p.pct * 100);
  const label = p.max ? 'RANK ' + p.rank + ' — MAX'
    : 'RANK ' + p.rank + '  ·  ' + Math.round(p.into) + ' / ' + Math.round(p.need) + ' XP';
  return '<div class="rank-row"><span class="rank-label">' + label + '</span>' +
    '<span class="rank-bar"><i style="width:' + pct + '%"></i></span></div>';
}

function challengesHtml() {
  const stats = CORE.sanitizeStats(STATS);
  let out = '';
  for (let i = 0; i < CORE.CHALLENGES.length; i++) {
    const c = CORE.challengeProgress(stats, CORE.CHALLENGES[i]);
    out += '<div class="chal' + (c.done ? ' done' : '') + '">' +
      '<b>' + c.name + '</b><span>' + c.blurb + '</span>' +
      '<i>' + (c.done ? 'COMPLETE' : Math.floor(c.have) + ' / ' + c.target) + '</i></div>';
  }
  return out;
}
