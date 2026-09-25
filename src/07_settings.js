// ============ SETTINGS & QUALITY PRESETS ============
'use strict';
const IS_TOUCH = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) && matchMedia('(pointer: coarse)').matches;

// Persisted player options. Storage can throw (private mode, file:// quirks),
// so every access is guarded and the game always runs on the defaults.
const SETTINGS_KEY = 'operation-blackout.settings.v2';
const SETTINGS_DEFAULTS = {
  sens: 1.0,            // mouse / touch look multiplier
  adsSens: 0.65,        // extra multiplier while aiming
  padSens: 1.0,         // gamepad look multiplier
  fov: 78,              // hip-fire vertical FOV
  invertY: false,
  volume: 0.8,
  quality: IS_TOUCH ? 'low' : 'high',
  difficulty: 'regular',
  showFps: true,
  damageNumbers: true,
  adsToggle: false,
  crouchToggle: false,
  rawInput: true
};
const SETTINGS = Object.assign({}, SETTINGS_DEFAULTS);
(function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k in SETTINGS_DEFAULTS) {
      if (saved && typeof saved[k] === typeof SETTINGS_DEFAULTS[k]) SETTINGS[k] = saved[k];
    }
  } catch (e) { /* defaults */ }
})();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) { /* ignore */ }
}

// Graphics presets. Everything render-cost related reads from QUALITY.
const QUALITY_PRESETS = {
  low:    { postfx: false, msaa: false, bloom: false, shadowSize: 1024, softShadows: false, envMap: false, clouds: false, particles: 700,  maxPR: 1.0,  pointLights: false, detail: 0 },
  medium: { postfx: true,  msaa: false, bloom: true,  shadowSize: 2048, softShadows: false, envMap: true,  clouds: true,  particles: 1600, maxPR: 1.25, pointLights: true,  detail: 1 },
  high:   { postfx: true,  msaa: true,  bloom: true,  shadowSize: 2048, softShadows: true,  envMap: true,  clouds: true,  particles: 3000, maxPR: 1.75, pointLights: true,  detail: 2 }
};
if (!QUALITY_PRESETS[SETTINGS.quality]) SETTINGS.quality = SETTINGS_DEFAULTS.quality;
// World-building quality is fixed for the page's lifetime (props are built once);
// render-cost toggles (post-FX, shadows, particles) can change live.
const QUALITY = Object.assign({}, QUALITY_PRESETS[SETTINGS.quality]);
const BUILD_DETAIL = QUALITY.detail;

// Difficulty scales incoming damage, enemy accuracy/health and the score multiplier.
const DIFFICULTY = {
  recruit: { label: 'RECRUIT', dmg: 0.6,  acc: 0.75, hp: 0.85, score: 0.75 },
  regular: { label: 'REGULAR', dmg: 1.0,  acc: 1.0,  hp: 1.0,  score: 1.0 },
  veteran: { label: 'VETERAN', dmg: 1.35, acc: 1.2,  hp: 1.15, score: 1.5 }
};
function diff() { return DIFFICULTY[SETTINGS.difficulty] || DIFFICULTY.regular; }

// Best score per difficulty
const BEST_KEY = 'operation-blackout.best.v1';
function loadBest() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function recordBest(score, wave) {
  const best = loadBest();
  const cur = best[SETTINGS.difficulty];
  const isNew = !cur || score > cur.score;
  if (isNew) {
    best[SETTINGS.difficulty] = { score: score, wave: wave };
    try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch (e) { /* ignore */ }
  }
  return { isNew: isNew, best: isNew ? best[SETTINGS.difficulty] : cur };
}
