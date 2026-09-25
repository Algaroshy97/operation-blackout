// ============ SETTINGS MENU ============
'use strict';
const SETTING_ROWS = [
  { key: 'sens', label: 'Mouse / touch sensitivity', type: 'range', min: 0.2, max: 3, step: 0.05 },
  { key: 'adsSens', label: 'Aim-down-sights sensitivity', type: 'range', min: 0.3, max: 1.5, step: 0.05 },
  { key: 'padSens', label: 'Controller look speed', type: 'range', min: 0.3, max: 2.5, step: 0.05 },
  { key: 'fov', label: 'Field of view', type: 'range', min: 65, max: 100, step: 1 },
  { key: 'invertY', label: 'Invert look Y', type: 'check' },
  { key: 'adsToggle', label: 'Toggle aim (instead of hold)', type: 'check' },
  { key: 'crouchToggle', label: 'Toggle crouch (instead of hold)', type: 'check' },
  { key: 'rawInput', label: 'Raw mouse input', type: 'check' },
  { key: 'quality', label: 'Graphics quality', type: 'select', options: [['low', 'Low (mobile)'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'volume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'difficulty', label: 'Difficulty (next deploy)', type: 'select', options: [['recruit', 'Recruit'], ['regular', 'Regular'], ['veteran', 'Veteran · x1.5 score']] },
  { key: 'damageNumbers', label: 'Damage numbers', type: 'check' },
  { key: 'showFps', label: 'Show FPS', type: 'check' }
];
let settingsReturnTo = null;
function fmtSetting(row, v) {
  if (row.key === 'volume') return Math.round(v * 100) + '%';
  if (row.key === 'fov') return v + '°';
  return (+v).toFixed(2);
}
function buildSettingsPanel() {
  const panel = $id('settings-panel');
  panel.innerHTML = '';
  SETTING_ROWS.forEach(function (row) {
    const r = document.createElement('label');
    r.className = 'set-row';
    const name = document.createElement('span'); name.textContent = row.label; r.appendChild(name);
    const right = document.createElement('span');
    let input;
    if (row.type === 'range') {
      input = document.createElement('input'); input.type = 'range';
      input.min = row.min; input.max = row.max; input.step = row.step; input.value = SETTINGS[row.key];
      const val = document.createElement('span'); val.className = 'val'; val.textContent = fmtSetting(row, SETTINGS[row.key]);
      input.addEventListener('input', function () { applySetting(row.key, parseFloat(input.value)); val.textContent = fmtSetting(row, SETTINGS[row.key]); });
      right.appendChild(input); right.appendChild(val);
    } else if (row.type === 'check') {
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!SETTINGS[row.key];
      input.addEventListener('change', function () { applySetting(row.key, input.checked); });
      right.appendChild(input);
    } else {
      input = document.createElement('select');
      row.options.forEach(function (o) { const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; input.appendChild(op); });
      input.value = SETTINGS[row.key];
      input.addEventListener('change', function () { applySetting(row.key, input.value); });
      right.appendChild(input);
    }
    r.appendChild(right);
    panel.appendChild(r);
  });
  const note = document.createElement('div');
  note.className = 'set-note';
  note.textContent = 'Graphics quality applies instantly (lights and set-dressing density refresh on reload). Settings are saved in this browser.';
  panel.appendChild(note);
}
function applySetting(key, value) {
  SETTINGS[key] = value;
  saveSettings();
  if (key === 'volume') setMasterVolume(value);
  if (key === 'showFps') hud.fps.style.display = value ? '' : 'none';
  if (key === 'quality') applyQuality(value);
  if (key === 'crouchToggle') player.crouchLatch = false;
  if (key === 'adsToggle') keys['Mouse2'] = false;
}
// Live render-quality switch (world geometry built at load is kept).
function applyQuality(q) {
  const p = QUALITY_PRESETS[q];
  if (!p) return;
  const shadowChanged = p.shadowSize !== QUALITY.shadowSize || p.softShadows !== QUALITY.softShadows;
  const envChanged = p.envMap !== QUALITY.envMap;
  const cloudsChanged = p.clouds !== QUALITY.clouds;
  Object.assign(QUALITY, p);
  QUALITY.detail = BUILD_DETAIL;
  QUALITY.pointLights = FLASH_LIGHTS.length > 0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxPR));
  if (shadowChanged) setShadowQuality(QUALITY.shadowSize, QUALITY.softShadows);
  if (envChanged) { buildEnvironment(); scene.traverse(function (o) { if (o.material && o.material.isMaterial) o.material.needsUpdate = true; }); }
  if (cloudsChanged) { skyDome.material.dispose(); skyDome.material = makeSkyMaterial(QUALITY.clouds); }
  setParticleBudget(QUALITY.particles);
  POST.failed = false;
  initPostfx();
  postfxResize();
}
function openSettings(from) {
  settingsReturnTo = from;
  buildSettingsPanel();
  $id('settings-menu').style.display = 'flex';
  if (from) $id(from).style.display = 'none';
  const first = document.querySelector('#settings-panel input, #settings-panel select');
  if (first && lastInputDevice === 'pad') first.focus();
}
function closeSettings() {
  $id('settings-menu').style.display = 'none';
  if (settingsReturnTo) $id(settingsReturnTo).style.display = 'flex';
  settingsReturnTo = null;
}
hud.fps.style.display = SETTINGS.showFps ? '' : 'none';
