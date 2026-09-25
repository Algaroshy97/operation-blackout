// ============ HUD & WAVES ============
'use strict';
// ---- HUD refs ----
const hud = {
  healthBar: $id('health-bar'), healthNum: $id('health-num'), armorBar: $id('armor-bar'),
  ammoMag: $id('ammo-mag'), ammoRes: $id('ammo-res'), weaponName: $id('weapon-name'),
  reloadHint: $id('reload-hint'), scoreVal: $id('score-val'),
  waveNum: $id('wave-num'), enemiesLeft: $id('enemies-left'),
  waveBig: $id('wb-big'), waveSub: $id('wb-sub'), waveBanner: $id('wave-banner'),
  centerMsg: $id('center-msg'), killfeed: $id('killfeed'),
  dmgVig: $id('damage-vignette'), critVig: $id('critical-vignette'), flash: $id('flash-overlay'),
  hitmark: document.querySelector('#crosshair .hitmark'),
  hitDir: $id('hit-dir-container'),
  sprintInd: $id('sprint-ind'), fps: $id('fps-counter'),
  minimap: $id('minimap-canvas'), compass: $id('compass-canvas'),
  credits: $id('credit-val'),
  streaks: $id('streak-hud'),
  powerBanner: $id('power-banner'),
  grenadeCharge: $id('grenade-charge'),
  grenadeChargeTxt: $id('grenade-charge-txt'),
  grenadeChargeFill: $id('grenade-charge-fill')
};

function updateHudGrenadeCharge(visible, pct, speed) {
  if (!hud.grenadeCharge) {
    hud.grenadeCharge = $id('grenade-charge');
    hud.grenadeChargeTxt = $id('grenade-charge-txt');
    hud.grenadeChargeFill = $id('grenade-charge-fill');
    if (!hud.grenadeCharge) return;
  }
  if (!visible) {
    hud.grenadeCharge.style.opacity = '0';
    return;
  }
  hud.grenadeCharge.style.opacity = '1';
  if (hud.grenadeChargeFill) hud.grenadeChargeFill.style.width = pct + '%';
  if (hud.grenadeChargeTxt) hud.grenadeChargeTxt.textContent = 'GRENADE ' + Math.round(speed || 0) + ' M/S (' + pct + '%)';
}

// Change-driven: this runs every animation frame (60 Hz). A single flat diff on five
// primitives costs one comparison each and returns on the first mismatch, which is far
// cheaper than the DOM writes, class-list toggles, and touch-plate text checks that the
// full body performs. Force-flush callers (resupply, deploy, reset) pass force=true.
const _hudHealthState = { hp: -1, maxHp: -1, armor: -1, plates: -1, plateInserting: null };
function updateHudHealth(force) {
  const hp = Math.max(0, Math.round(player.health));
  const maxHp = typeof playerMaxHealth === 'function' ? playerMaxHealth() : CFG.player.health;
  const maxArmor = (typeof CFG !== 'undefined' && CFG.player && CFG.player.armor) ? CFG.player.armor : 50;
  const armor = Math.round(Math.max(0, player.armor / maxArmor * 100));
  const curPlates = typeof plates !== 'undefined' ? plates : 0;
  const isIns = typeof plateT !== 'undefined' && plateT > 0;
  if (!force && !CORE.healthHudChanged(_hudHealthState, hp, maxHp, armor, curPlates, isIns)) {
    updateHudMobility();
    return;
  }
  CORE.syncHealthHudState(_hudHealthState, hp, maxHp, armor, curPlates, isIns);
  const pct = Math.round(Math.max(0, hp / maxHp * 100));
  hud.healthBar.style.width = pct + '%';
  hud.healthNum.textContent = hp;
  const isLow = CORE.isHealthLow(hp, maxHp);
  const isCrit = CORE.isHealthCritical(hp, maxHp);
  hud.healthBar.classList.toggle('low', isLow);
  hud.healthNum.classList.toggle('low', isLow);
  hud.healthBar.classList.toggle('critical', isCrit);
  hud.healthNum.classList.toggle('critical', isCrit);
  if (hud.healthBar.parentElement) {
    hud.healthBar.parentElement.classList.toggle('critical', isCrit);
  }
  const critVig = hud.critVig || (hud.critVig = $id('critical-vignette'));
  if (critVig) {
    critVig.classList.toggle('active', isCrit);
  }
  const armorPct = armor;
  hud.armorBar.style.width = armorPct + '%';
  const isArmorLow = CORE.isArmorLow(player.armor, maxArmor);
  const isArmorEmpty = CORE.isArmorEmpty(player.armor);
  hud.armorBar.classList.toggle('low', isArmorLow);
  if (hud.armorBar.parentElement) {
    hud.armorBar.parentElement.classList.toggle('empty', isArmorEmpty);
  }
  const isTouch = typeof IS_TOUCH !== 'undefined' && !!IS_TOUCH;
  if (isTouch) {
    const tbtnPlate = hud.tbtnPlate || (hud.tbtnPlate = $id('tbtn-plate'));
    if (tbtnPlate) {
      const plateState = CORE.touchPlateState(curPlates, player.armor, maxArmor, isIns);
      tbtnPlate.classList.toggle('empty', plateState === 'empty');
      tbtnPlate.classList.toggle('inserting', plateState === 'inserting');
      tbtnPlate.classList.toggle('urgent', plateState === 'urgent');
      tbtnPlate.classList.toggle('ready', plateState === 'ready');
      const plateLabel = CORE.touchPlateLabel(curPlates, isIns);
      if (tbtnPlate.textContent !== plateLabel) tbtnPlate.textContent = plateLabel;
    }
  }
  updateHudMobility();
}

let _lastMobilityState = null;
function updateHudMobility() {
  const isTac = typeof player !== 'undefined' && player.tacT > 0;
  const isSlide = typeof player !== 'undefined' && !!player.sliding;
  const isExh = typeof player !== 'undefined' && !!player.exhausted;
  const state = CORE.sprintIndicatorState(isTac, isSlide, isExh);
  if (state === _lastMobilityState) return;
  _lastMobilityState = state;
  const el = hud.sprintInd || (hud.sprintInd = $id('sprint-ind'));
  if (!el) return;
  const label = CORE.sprintIndicatorLabel(state);
  el.textContent = label;
  el.style.opacity = label ? '1' : '0';
  el.classList.toggle('tac', state === 'tac');
  el.classList.toggle('slide', state === 'slide');
  el.classList.toggle('exhausted', state === 'exhausted');
}
// Change-driven: updateHudAmmo is called every frame from updateWeapons, and DOM writes
// cost significantly more than the primitive equality checks that skip them.
const _hudAmmoState = {
  ammo: -1, reserve: -1, reloading: null, isLow: null, isEmpty: null,
  prompt: null, weaponName: null, lethalCount: -1, tacCount: -1, isCharging: false
};
function updateHudAmmo(force) {
  const s = curS();
  if (!s) {
    if (_hudAmmoState.ammo !== null) {
      hud.ammoMag.textContent = '—';
      hud.ammoRes.textContent = '';
      _hudAmmoState.ammo = null;
    }
    return;
  }
  const w = curW();
  const wName = w ? w.name : '';
  const isLow = CORE.isAmmoLow(s.ammo, w ? w.mag : 30);
  const isEmpty = CORE.isAmmoEmpty(s.ammo);
  const isTouch = typeof IS_TOUCH !== 'undefined' && !!IS_TOUCH;
  const prompt = CORE.reloadPrompt(s.reloading, s.ammo, s.reserve, isTouch);
  const nadeCount = typeof grenades !== 'undefined' && grenades ? grenades.count : 0;
  const tacCount = typeof tacticalCount !== 'undefined' ? tacticalCount : 0;
  const isChg = typeof grenadeCharging !== 'undefined' && !!grenadeCharging;

  if (!force && !CORE.ammoHudChanged(_hudAmmoState, s.ammo, s.reserve, s.reloading, isLow, isEmpty, prompt, wName, nadeCount, tacCount, isChg)) {
    return;
  }
  CORE.syncAmmoHudState(_hudAmmoState, s.ammo, s.reserve, s.reloading, isLow, isEmpty, prompt, wName, nadeCount, tacCount, isChg);

  hud.ammoMag.textContent = s.ammo;
  const lname = (CORE.equipmentByKey(equippedLethal) || CORE.LETHALS[0]).name;
  let eq = nadeCount + ' ' + lname;
  if (equippedTactical) {
    eq += '  ·  ' + tacCount + ' ' + (CORE.equipmentByKey(equippedTactical) || {}).name;
  }
  hud.ammoRes.textContent = '/ ' + s.reserve + '  ·  ' + eq;
  hud.ammoMag.classList.toggle('low', isLow);
  hud.ammoMag.classList.toggle('empty', isEmpty);
  hud.weaponName.textContent = wName;
  hud.reloadHint.textContent = prompt;
  hud.reloadHint.style.opacity = prompt ? 1 : 0;
  hud.reloadHint.classList.toggle('urgent', isEmpty && !s.reloading);
  if (isTouch) {
    const isAdsFire = (typeof getSetting === 'function' ? getSetting('fireMode') : (typeof SETTINGS !== 'undefined' ? SETTINGS.fireMode : 'fire')) === 'ads + fire';
    const tbtnFire = hud.tbtnFire || (hud.tbtnFire = $id('tbtn-fire'));
    if (tbtnFire) {
      const fireState = CORE.touchFireState(s.ammo, s.reserve, s.reloading);
      tbtnFire.classList.toggle('empty', fireState === 'empty');
      tbtnFire.classList.toggle('dry', fireState === 'dry');
      tbtnFire.classList.toggle('reloading', fireState === 'reloading');
      const fireLabel = CORE.touchFireLabel(s.ammo, s.reserve, s.reloading, isAdsFire);
      if (tbtnFire.textContent !== fireLabel) tbtnFire.textContent = fireLabel;
    }
    const tbtnReload = hud.tbtnReload || (hud.tbtnReload = $id('tbtn-reload'));
    if (tbtnReload) {
      const reloadState = CORE.touchReloadState(s.ammo, s.reserve, s.reloading);
      tbtnReload.classList.toggle('urgent', reloadState === 'urgent');
      tbtnReload.classList.toggle('reloading', reloadState === 'reloading');
      tbtnReload.classList.toggle('empty', s.ammo <= 0 && s.reserve <= 0);
      const reloadLabel = CORE.touchReloadLabel(s.ammo, s.reserve, s.reloading);
      if (tbtnReload.textContent !== reloadLabel) tbtnReload.textContent = reloadLabel;
    }
    const tbtnNade = hud.tbtnNade || (hud.tbtnNade = $id('tbtn-nade'));
    if (tbtnNade) {
      const nadeState = CORE.touchEquipmentState(nadeCount, isChg);
      tbtnNade.classList.toggle('empty', nadeState === 'empty');
      tbtnNade.classList.toggle('charging', nadeState === 'charging');
      tbtnNade.classList.toggle('ready', nadeState === 'ready');
      const nadeLabel = CORE.touchLethalLabel(equippedLethal, nadeCount, isChg);
      if (tbtnNade.textContent !== nadeLabel) tbtnNade.textContent = nadeLabel;
    }
    const tbtnTac = hud.tbtnTac || (hud.tbtnTac = $id('tbtn-tactical'));
    if (tbtnTac) {
      const tacState = CORE.touchEquipmentState(tacCount, false);
      tbtnTac.classList.toggle('empty', tacState === 'empty');
      tbtnTac.classList.toggle('ready', tacState === 'ready');
      const tacLabel = CORE.touchTacticalLabel(equippedTactical, tacCount);
      if (tbtnTac.textContent !== tacLabel) tbtnTac.textContent = tacLabel;
    }
    const tbtnSwap = hud.tbtnSwap || (hud.tbtnSwap = $id('tbtn-swap'));
    if (tbtnSwap && typeof weaponsOwned !== 'undefined' && typeof CFG !== 'undefined') {
      // SWAP cycles every owned slot (the marksman rifle rides in slot 3), so the
      // state and label follow the weapon it will actually bring up.
      let nextSlot = -1;
      for (let k = 1; k < weaponsOwned.length; k++) {
        const ns = (curWeapon + k) % weaponsOwned.length;
        if (weaponsOwned[ns] >= 0) { nextSlot = ns; break; }
      }
      const swapState = nextSlot >= 0 ? 'ready' : 'empty';
      tbtnSwap.classList.toggle('empty', swapState === 'empty');
      tbtnSwap.classList.toggle('ready', swapState === 'ready');
      const swapLabel = nextSlot >= 0 ? CFG.weapons[weaponsOwned[nextSlot]].type : 'SWAP';
      if (tbtnSwap.textContent !== swapLabel) tbtnSwap.textContent = swapLabel;
    }
  }
}

// Feedback tiers: leverages CORE.hitmarkerParams to provide distinct visual feedback
// for regular impacts, surface penetration, shield deflection, and fatal kill confirmation.
function showHitmarker(isHead, tier) {
  const p = CORE.hitmarkerParams(isHead, tier);
  hud.hitmark.style.opacity = 1;
  hud.hitmark.style.transform = 'rotate(45deg) scale(' + p.scale + ')';
  hud.hitmark.classList.toggle('kill', p.tier === 'kill');
  const marks = hud.hitmark.children;
  for (let i = 0; i < marks.length; i++) marks[i].style.background = p.color;
  clearTimeout(hud.hitmark._t);
  hud.hitmark._t = setTimeout(function () {
    hud.hitmark.style.opacity = 0;
    hud.hitmark.classList.remove('kill');
  }, p.duration);
  if (p.tier !== 'kill') {
    playSound(p.tier === 'block' ? 'block' : isHead ? 'headshot' : 'hit');
  }
}

function showDamageFx(dirDeg, amount, healthDmg, absorbedDmg) {
  const isArmorOnly = (healthDmg !== undefined && healthDmg <= 0 && absorbedDmg > 0);
  const alpha = CORE.damageVignetteAlpha(amount);
  hud.dmgVig.style.boxShadow = CORE.damageVignetteStyle(alpha, isArmorOnly);
  clearTimeout(hud.dmgVig._t);
  hud.dmgVig._t = setTimeout(function () {
    hud.dmgVig.style.boxShadow = CORE.damageVignetteStyle(0, false);
  }, 220);
  // directional indicator: dirDeg = world bearing of attacker relative to player facing
  if (dirDeg !== undefined) {
    const screenDeg = CORE.screenHitAngle(dirDeg, player.yaw);
    showHitArc(screenDeg, isArmorOnly);
  }
  playSound('hurt');
}

// ---- Pooled hit-direction arcs ----
// Every hit taken used to create a <div> plus two setTimeouts. Under sustained
// fire that took the document from ~150 to ~630 elements with hundreds of pending
// timers. Fixed pool, recycled by age, no timers.
const HIT_ARC_POOL = 8, HIT_ARC_LIFE = CORE.HIT_ARC_LIFE;
const hitArcs = [];
(function buildHitArcs() {
  for (let i = 0; i < HIT_ARC_POOL; i++) {
    const el = document.createElement('div');
    el.className = 'hit-dir';
    el.innerHTML = '<div class="arc"></div>';
    el.style.opacity = '0';
    hud.hitDir.appendChild(el);
    hitArcs.push({ el: el, t: -99 });
  }
})();
let hitArcNext = 0;
function showHitArc(screenDeg, isArmor) {
  const a = hitArcs[hitArcNext];
  hitArcNext = (hitArcNext + 1) % HIT_ARC_POOL;
  a.el.style.transform = 'rotate(' + screenDeg + 'deg)';
  a.el.classList.toggle('armor', !!isArmor);
  a.el.style.opacity = '0.9';
  a.t = gameT;
}
function updateHitArcs() {
  for (let i = 0; i < hitArcs.length; i++) {
    const a = hitArcs[i];
    if (a.t < 0) continue;
    const age = gameT - a.t;
    const op = CORE.hitArcOpacity(age, HIT_ARC_LIFE, 0.6, 0.9);
    if (op <= 0) {
      a.el.style.opacity = '0';
      a.el.classList.remove('armor');
      a.t = -99;
    } else {
      a.el.style.opacity = op.toFixed(3);
    }
  }
}

function addScore(pts, label) {
  score += pts;
  hud.scoreVal.textContent = score;
  if (label) pushKillfeed(label + ' <span class="xp">+' + pts + '</span>');
}

// ---- Credits ----------------------------------------------------------------
// Score only ever went up, and nothing in the game ever read it back, so a
// 30-minute run had no shape. Credits are earned in parallel and are SPENT. Score
// stays the leaderboard number so career bests remain comparable across versions.
let credits = 0;
function addCredits(n) {
  credits += Math.round(n * (powerActive('double') ? 2 : 1));
  if (hud.credits) hud.credits.textContent = credits;
}
function spendCredits(n) {
  if (credits < n) return false;
  credits -= n;
  if (hud.credits) hud.credits.textContent = credits;
  return true;
}

// ---- Power-ups --------------------------------------------------------------
// Timers run on gameT, which does not advance while paused, so a DOUBLE POINTS
// window cannot be burned by opening the pause menu.
const powerUntil = { double: -99, instakill: -99 };
function powerActive(key) { return gameT < powerUntil[key]; }
function activatePowerUp(def) {
  if (def.dur > 0) powerUntil[def.key] = gameT + def.dur;
  if (def.key === 'maxammo') {
    for (let i = 0; i < wState.length; i++) {
      if (!wState[i] || weaponsOwned[i] < 0) continue;
      const cw = CFG.weapons[weaponsOwned[i]];
      wState[i].ammo = cw.mag;
      wState[i].reserve = cw.reserveMax;
    }
    grenades.count = Math.max(grenades.count, CFG.grenade.count);
    updateHudAmmo();
  } else if (def.key === 'nuke') {
    // Everything currently alive, credited as kills so the wave still completes
    // through the normal path rather than being force-cleared.
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (!enemies[i].dead) killEnemy(enemies[i], false);
    }
  }
  showPowerBanner(def.label);
  playSound('powerup');
}
function showPowerBanner(txt) {
  if (!hud.powerBanner) return;
  hud.powerBanner.textContent = txt;
  hud.powerBanner.style.opacity = '1';
  clearTimeout(hud.powerBanner._t);
  hud.powerBanner._t = setTimeout(function () {
    if (hud.powerBanner) hud.powerBanner.style.opacity = '0';
  }, 1800);
}

// ---- Bounded killfeed ----
// One <div> + one setTimeout per kill was unbounded under a multi-kill streak.
// Cap the list and drop the oldest instead; the CSS animation still fades it out.
const KILLFEED_MAX = 5;
function pushKillfeed(html) {
  const li = document.createElement('div');
  li.className = 'killfeed-item';
  li.innerHTML = html;
  hud.killfeed.appendChild(li);
  while (hud.killfeed.childElementCount > KILLFEED_MAX) hud.killfeed.removeChild(hud.killfeed.firstElementChild);
  setTimeout(function () { if (li.parentNode) li.remove(); }, 4200);
}
// ---- Multi-kill streak bonus (wires the previously dead CFG.score.multikill) ----
// A kill within MK_WINDOW of the previous one extends a streak. 2+ kills in a
// row award an escalating bonus (x2, x3, ... capped at x5); the window resets
// after the cap or on a >4 s gap. resetGame() clears the streak state.
// Minimap colours, one per archetype, so a glance tells you what is coming.
const MM_KIND_COLOR = { 0: '#ff4030', 1: '#ff6050', 2: '#ff8830', 3: '#6fa8ff', 4: '#8fd66a', 5: '#ffd24a' };
const MK_WINDOW = CORE.MK_WINDOW || 4;          // seconds between kills to keep the streak alive
let killStreak = 0, lastKillT = -99;
function registerKillT() {
  killStreak = CORE.advanceKillStreak(killStreak, lastKillT, gameT, MK_WINDOW);
  lastKillT = gameT;
  const label = CORE.multikillLabel(killStreak);
  if (label) {
    addScore(CFG.score.multikill * (killStreak - 1), label + ' x' + killStreak);
    const s = CORE.multikillSound(killStreak);
    if (s) playSound(s);
  }
}

// ---- Wave system ----
let waveNum = 0, score = 0, kills = 0, headshots = 0;
let shotsFired = 0, shotsHit = 0;
let waveQueue = 0, spawnTimer = 0, waveActive = false, gameEnded = false, gameT = 0;
let betweenWaveT = 0;
let nextEstepT = 0;   // global throttle for positional enemy footsteps
// Bumped by resetGame(). Anything scheduled with setTimeout captures the value at
// schedule time and drops itself if the run has changed since.
let runId = 0;
// Per-run, chosen at deploy — not a saved setting.
let runDifficulty = 'regular';
let endlessMode = false;
function diff() { return CORE.difficulty(runDifficulty); }
// Behaviour unlocks replace the accuracy ramp that capped out at wave 8.
let waveBehaviours = {};
// The wave-15 boss was dropped in favour of spreading variety across the curve.
// This is that decision carried through: every fifth wave is an announced modifier.
let waveSpecial = null;
// Task 12.4, held back until special waves proved the mechanism. A held zone on some
// waves, borrowed from Hardpoint: it works here for the same reason it works there —
// it pulls the player off whatever corner they have decided is safe.
let objective = null;
// Districts the player has paid to open. Per-run, like credits.
let openDistricts = [];

function getWaveNum() { return waveNum; }

// Snapshot of everything a resumed run needs. Only ever called between waves.
function captureRunState() {
  const weapons = [];
  for (let i = 0; i < weaponsOwned.length; i++) {
    const gi = weaponsOwned[i];
    if (gi < 0 || !wState[i]) { weapons.push(null); continue; }
    weapons.push({ gi: gi, ammo: wState[i].ammo, reserve: wState[i].reserve,
      up: wState[i].up ? Object.assign({}, wState[i].up) : null });
  }
  return {
    wave: waveNum, score: score, kills: kills, headshots: headshots,
    shotsFired: shotsFired, shotsHit: shotsHit,
    health: player.health, armor: player.armor, grenades: grenades.count,
    credits: credits, perks: perks.slice(), plates: plates,
    difficulty: runDifficulty, endless: endlessMode, weapons: weapons,
    runPhase: typeof runPhase !== 'undefined' ? runPhase : (endlessMode ? 'endless' : 'active'),
    settlementSnapshot: typeof settlementSnapshot !== 'undefined' ? settlementSnapshot : null,
    streakKills: streakKills,
    runStreaksEarned: runStreaksEarned,
    openDistricts: openDistricts,
    equipment: { lethal: equippedLethal, tactical: equippedTactical,
      tacticalCount: tacticalCount, fieldCharge: fieldCharge, streakBank: streakBank }
  };
}

function startWave(n) {
  waveNum = n;
  waveBehaviours = CORE.behavioursAtWave(n);
  waveSpecial = CORE.specialWaveAt(n);
  applySpecialLighting(waveSpecial);
  startObjective(n);
  waveQueue = CORE.waveQueueSize(n, CFG.wave.baseCount, CFG.wave.growth,
    CFG.wave.victoryWave, diff().count, waveSpecial);
  if (waveSpecial) {
    setTimeout(function () {
      showCenterMsg(waveSpecial.name);
      pushKillfeed('<span class="xp">' + waveSpecial.name + '</span> — ' + waveSpecial.blurb);
    }, 700);
  }
  // Announce what changed, so escalation is legible instead of just "more of them".
  CORE.newBehavioursAtWave(n).forEach(function (b) {
    setTimeout(function () { showCenterMsg(b.label.toUpperCase()); }, 1400);
  });
  CORE.newEnemyKindsAtWave(n).forEach(function (e) {
    setTimeout(function () { showCenterMsg('NEW HOSTILE: ' + e.name.toUpperCase()); }, 2600);
  });
  spawnTimer = 0.5;
  waveActive = true;
  hud.waveNum.textContent = n;
  showWaveBanner(n);
  playSound('wave');
}

// Blackout drops the scene lights instead of adding an enemy type: the wave is
// harder because the player cannot see, not because there is more of it. Saved and
// restored rather than recomputed, so a retune of the lighting never desynchronises
// from this.
let _lightBackup = null;
let _fogBackup = null;
function applySpecialLighting(special) {
  const dark = !!(special && special.dark);
  if (dark && !_lightBackup) {
    // Only `sun` is a named binding; the hemisphere and ambient lights were added
    // anonymously, so collect every light in the scene rather than naming them and
    // leaving a future third light silently un-dimmed.
    _lightBackup = [];
    scene.traverse(function (o) {
      if (o.isLight) { _lightBackup.push({ l: o, i: o.intensity }); o.intensity *= 0.10; }
    });
    if (scene.fog) { _fogBackup = scene.fog.far; scene.fog.far = 42; }
  } else if (!dark && _lightBackup) {
    for (let i = 0; i < _lightBackup.length; i++) {
      _lightBackup[i].l.intensity = _lightBackup[i].i;
    }
    _lightBackup = null;
    if (scene.fog && _fogBackup !== null) { scene.fog.far = _fogBackup; _fogBackup = null; }
  }
}

// ---- Objective zone ----------------------------------------------------------
const objRingGeo = new THREE.RingGeometry(CORE.OBJECTIVE_RADIUS - 0.25, CORE.OBJECTIVE_RADIUS, 48);
const objRingMat = new THREE.MeshBasicMaterial({ color: 0x4fd08a, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
const objPillarGeo = new THREE.BoxGeometry(0.5, 4, 0.5);
const objPillarMat = new THREE.MeshBasicMaterial({ color: 0x4fd08a, transparent: true, opacity: 0.3 });
let objRing = null, objPillar = null;

function startObjective(n) {
  clearObjective();
  if (!CORE.objectiveWaveAt(n)) return;
  // Reuse the spawn ring as candidate spots: they are already validated open ground,
  // already excluded from sealed districts, and already spread around the arena.
  const ring = openSpawnPoints();
  const idx = CORE.pickObjectiveSpot(ring, player.pos.x, player.pos.z);
  if (idx < 0) return;
  const spot = ring[idx];
  objective = { x: spot[0], z: spot[1], t: 0, done: false };
  objRing = new THREE.Mesh(objRingGeo, objRingMat);
  objRing.rotation.x = -Math.PI / 2;
  objRing.position.set(spot[0], 0.05, spot[1]);
  scene.add(objRing);
  objPillar = new THREE.Mesh(objPillarGeo, objPillarMat);
  objPillar.position.set(spot[0], 2, spot[1]);
  scene.add(objPillar);
  setTimeout(function () { showCenterMsg('HOLD THE ZONE'); }, 1900);
}

const _objHudState = { visible: false, inside: false, pct: -1 };
let _objEl = null, _objBarEl = null, _objTxtEl = null;
function getObjEls() {
  if (!_objEl) {
    _objEl = $id('objective-hud');
    _objBarEl = $id('objective-fill');
    _objTxtEl = $id('objective-txt');
  }
  return _objEl;
}
function resetObjectiveHudCache() {
  _objHudState.visible = false;
  _objHudState.inside = false;
  _objHudState.pct = -1;
  if (getObjEls()) _objEl.style.opacity = '0';
}

function clearObjective() {
  objective = null;
  if (objRing) { scene.remove(objRing); objRing = null; }
  if (objPillar) { scene.remove(objPillar); objPillar = null; }
  if (_objHudState.visible) {
    _objHudState.visible = false;
    _objHudState.inside = false;
    _objHudState.pct = -1;
    if (getObjEls()) _objEl.style.opacity = '0';
  }
}

function updateObjective(dt) {
  if (!objective || objective.done || player.dead) {
    if (_objHudState.visible) {
      _objHudState.visible = false;
      _objHudState.inside = false;
      _objHudState.pct = -1;
      if (getObjEls()) _objEl.style.opacity = '0';
    }
    return;
  }
  const inside = CORE.horizDist(player.pos.x, player.pos.z, objective.x, objective.z) < CORE.OBJECTIVE_RADIUS;
  objective.t = CORE.objectiveProgress(objective.t, dt, inside);
  const pct = Math.round(objective.t / CORE.OBJECTIVE_HOLD * 100);
  if (CORE.objectiveHudChanged(_objHudState, true, inside, pct)) {
    CORE.syncObjectiveHudState(_objHudState, true, inside, pct);
    if (getObjEls()) {
      _objEl.style.opacity = '1';
      if (_objBarEl) _objBarEl.style.width = pct + '%';
      if (_objTxtEl) _objTxtEl.textContent = CORE.objectiveLabel(inside, pct);
    }
  }
  if (objRing) objRing.material.opacity = inside ? 0.85 : 0.4;
  if (CORE.objectiveComplete(objective.t)) {
    objective.done = true;
    addCredits(CORE.OBJECTIVE_CREDITS);
    addScore(CORE.OBJECTIVE_CREDITS, 'Zone held');
    showCenterMsg('ZONE SECURED');
    playSound('powerup');
    clearObjective();
  }
}

function updateWaves(dt) {
  updateObjective(dt);
  if (gameEnded || player.dead) return;
  if (waveActive) {
    // spawn queue drains in bursts of 3-4 enemies, respecting max active
    if (waveQueue > 0) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        const canSpawn = Math.max(0, CFG.wave.maxActive - aliveEnemies());
        if (canSpawn > 0) {
          // Burst size and cadence scale with how much of the wave is still
          // queued: wave 15 used to need ~37 s of pure spawn gating before kill
          // time, which read as slow rather than climactic.
          const pressure = Math.min(1, waveQueue / 18);
          const burstSize = Math.floor(Math.random() * 2) + 3 + Math.round(pressure * 3);
          const count = Math.min(burstSize, waveQueue, canSpawn);
          for (let i = 0; i < count; i++) {
            spawnFromQueue();
          }
          spawnTimer = (2.5 - pressure * 1.4) + Math.random() * 1.2;
        } else {
          spawnTimer = 0.5;
        }
      }
    } else if (aliveEnemies() === 0) {
      // wave cleared
      waveActive = false;
      betweenWaveT = 4;
      addScore(CORE.waveClearScore(CFG.score.waveClear, waveNum, CORE.WAVE_SCORE_PER_WAVE), 'Wave ' + waveNum + ' cleared');
      addCredits(CORE.creditsForWave(waveNum));
      clearObjective();   // the zone belongs to the wave that spawned it
      reviveFromDown();   // holding out to the wave clear is the other way back up
      unlockSecondary();
      resupply();
      if (!endlessMode && waveNum >= CFG.wave.victoryWave) { victory(); return; }
      saveCheckpoint(captureRunState());   // between waves = the only safe save point
      showWaveBanner(waveNum, true);   // cleared banner stays up through the countdown
    }
  } else {
    betweenWaveT -= dt;
    updateWaveCountdown();
    if (betweenWaveT <= 0) startWave(waveNum + 1);
  }
  let left = waveQueue + aliveEnemies();
  // Between waves the queue is empty; show what is coming, not "0 HOSTILES".
  if (!waveActive && left === 0) left = CORE.waveEnemyCount(waveNum + 1, CFG.wave.baseCount, CFG.wave.growth);
  if (left !== _hudEnemiesLeft) {
    _hudEnemiesLeft = left;
    hud.enemiesLeft.textContent = left + ' HOSTILE' + (left === 1 ? '' : 'S');
  }
}
let _hudEnemiesLeft = -1;
// Zero ammo means zero kills, which means zero drops, which means the run can
// never recover — measured at wave 2 with a fixed-skill bot: 0 rounds, 0 pickups,
// enemies still alive. Drop a cache directly when the player has been dry for a
// few seconds, so the floor does not depend on getting a kill first.
let dryT = 0, nextCacheT = -99;
function updateAmmoRelief(dt) {
  if (!waveActive || player.dead) { dryT = 0; return; }
  let rounds = 0;
  for (let i = 0; i < wState.length; i++) {
    if (!wState[i] || weaponsOwned[i] < 0) continue;
    rounds += wState[i].ammo + wState[i].reserve;
  }
  if (rounds > 0) { dryT = 0; return; }
  dryT += dt;
  if (dryT > 5 && gameT > nextCacheT) {
    nextCacheT = gameT + 18;
    // just in front of the player, never inside geometry
    for (let a = 0; a < 8; a++) {
      const ang = player.yaw + Math.PI + a * 0.8;
      const x = player.pos.x + Math.sin(ang) * 4, z = player.pos.z + Math.cos(ang) * 4;
      if (Math.abs(x) > mapBounds || Math.abs(z) > mapBounds) continue;
      if (!CORE.isSpawnValid(x, z, colliders, 0.6, 1.8, 0.4)) continue;
      forceAmmoPickup(x, z);
      showCenterMsg('AMMO CACHE DROPPED');
      return;
    }
  }
}

function aliveEnemies() {
  let n = 0;
  for (let i = 0; i < enemies.length; i++) if (!enemies[i].dead) n++;
  return n;
}

// spawn points ring the arena; pick far from player
const spawnPoints = [];
(function () {
  const R = CFG.world.size / 2 - 6;
  for (let a = 0; a < 12; a++) {
    const ang = a / 12 * Math.PI * 2;
    spawnPoints.push([Math.cos(ang) * (R - 6), Math.sin(ang) * (R - 6)]);
  }
})();
function spawnFromQueue() {
  waveQueue--;
  // pick spawn point far from player but capped so waves arrive quickly
  // A sealed district is excluded from the ring. Spawning into one queues bodies
  // in a space nothing can path out of, which is BUG-01 by another route.
  const ring = openSpawnPoints();
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - player.pos.x, ring[i][1] - player.pos.z);
    // sweet spot: 18-35m from player
    const score = -Math.abs(d - 26) - Math.random() * 6;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const sp = ring[best];
  // Jitter, but never into a wall: ~2% of raw jittered points land inside solid
  // geometry, which is roughly 7 enemies per full run spawning clipped in a crate.
  // Resample, then fall back to the unjittered ring point.
  let x = sp[0], z = sp[1];
  for (let attempt = 0; attempt < 8; attempt++) {
    const jx = sp[0] + (Math.random() - 0.5) * 6;
    const jz = sp[1] + (Math.random() - 0.5) * 6;
    if (CORE.isSpawnValid(jx, jz, colliders, 0.6, 1.8)) { x = jx; z = jz; break; }
  }
  // A special wave draws from its own kind list, falling back to the normal table
  // when none of its kinds has unlocked yet.
  let kind = null;
  if (waveSpecial) kind = CORE.specialKind(waveSpecial, waveNum, Math.random());
  if (kind === null) kind = CORE.pickEnemyKind(waveNum, Math.random());
  const elite = CORE.rollElite(waveNum, Math.random());
  spawnEnemy(kind, x, z, { elite: elite });
}

// A sealed district must be excluded from the spawn ring. `usableSpawnPoints`
// guarantees at least one point survives, but fall back to the full ring anyway —
// a wave that cannot start is worse than a wave that starts somewhere awkward.
function openSpawnPoints() {
  const usable = CORE.usableSpawnPoints(spawnPoints, openDistricts);
  return usable.length ? usable : spawnPoints;
}

function resupply() {
  for (let i = 0; i < wState.length; i++) {
    if (!wState[i]) continue;
    wState[i].reserve = CORE.waveResupplyAmmo(wState[i].reserve, CFG.weapons[weaponsOwned[i]].reserveMax, CFG.weapons[weaponsOwned[i]].mag, CORE.RESUPPLY_MAG_RATIO);
  }
  player.armor = CFG.player.armor;
  grenades.count = Math.min(CFG.grenade.count, grenades.count + CFG.grenade.countPerWaves);
  updateHudAmmo(); updateHudHealth(true);
}

// ---- Secondary weapon unlock ----
// Slot 2 starts empty every deploy (pickGun clears it); the SWAP button, Digit2
// and the mouse wheel were all dead controls pointing at that empty slot.
// Clearing a wave now grants the next roster weapon into slot 2. Idempotent:
// once the slot is filled it never fires again for the rest of the run.
function unlockSecondary() {
  if (weaponsOwned[1] >= 0) return false;
  // The player's deploy-time pick, not an arbitrary roster neighbour.
  let gi = (typeof pendingSecondary !== 'undefined' && pendingSecondary >= 0)
    ? pendingSecondary : (weaponsOwned[0] + 1) % CFG.weapons.length;
  if (gi === weaponsOwned[0]) gi = (gi + 1) % CFG.weapons.length;
  weaponsOwned[1] = gi;
  // Build slot-1 state directly — initWeapons() would also reset slot 0's
  // live ammo/reserve, a hidden free refill mid-run.
  wState[1] = { ammo: CFG.weapons[gi].mag, reserve: CFG.weapons[gi].reserveMax, reloading: false, reloadT: 0, nextShot: 0 };
  refreshWeaponStats(1);
  wState[1].ammo = wState[1].eff ? wState[1].eff.mag : wState[1].ammo;
  wState[1].reserve = wState[1].eff ? wState[1].eff.reserveMax : wState[1].reserve;
  syncMarksmanSlot();   // a marksman secondary frees slot 3
  const w = CFG.weapons[gi];
  pushKillfeed('SECONDARY UNLOCKED: <span class="xp">' + w.name.toUpperCase() + '</span>');
  playSound('draw');
  return true;
}

function showWaveBanner(n, cleared) {
  // n = wave number; cleared = shown after clearing wave n (stays up for the countdown);
  // n = 0 = pre-battle "GET READY" banner at deploy (stays up until wave 1 starts).
  hud.waveBig.textContent = n === 0 ? 'GET READY' : (cleared ? 'WAVE ' + n + ' CLEARED' : 'WAVE ' + n);
  hud.waveSub.textContent = (cleared || n === 0) ? '' : (n === CFG.wave.victoryWave ? 'FINAL WAVE' : 'HOSTILES INBOUND');
  hud.waveBanner.style.opacity = 1;
  clearTimeout(hud.waveBanner._t);
  // cleared/ready banners stay visible; the countdown (updateWaveCountdown) ticks
  // the sub text and the next startWave() replaces and auto-hides the banner.
  if (n >= 1 && !cleared) hud.waveBanner._t = setTimeout(function () { hud.waveBanner.style.opacity = 0; }, 2200);
}
// Live "NEXT WAVE IN N" countdown during the between-wave gap (was a dead 4 s
// pause with no feedback). Runs from updateWaves only while playing.
function updateWaveCountdown() {
  const n = Math.max(1, Math.ceil(betweenWaveT));
  if (waveNum === 0) hud.waveSub.textContent = 'COMBAT IN ' + n;
  else hud.waveSub.textContent = 'NEXT WAVE IN ' + n;
}
function showCenterMsg(txt) {
  hud.centerMsg.textContent = txt;
  hud.centerMsg.style.opacity = 1;
  setTimeout(function () { hud.centerMsg.style.opacity = 0; }, 1800);
}

// ---- Minimap + compass ----
const mmCtx = hud.minimap.getContext('2d');
const cpCtx = hud.compass.getContext('2d');
const MM_STATION_COLOR = {
  wall: '#4fd08a', armory: '#ffd24a', perk: '#6fa8ff', plate: '#cfd6dd',
  lethal: '#ff8a6a', tactical: '#6fd8e8', door: '#e8c46a'
};
// Metres of unaided detection. The UAV lifts this to the whole minimap.
const MM_BASE_DETECT = 26;
var _minimapBlocks = null;
function getMinimapBlocks() {
  if (!_minimapBlocks && typeof colliders !== 'undefined' && colliders && colliders.length) {
    _minimapBlocks = CORE.filterMinimapColliders(colliders, 0.6);
  }
  return _minimapBlocks || [];
}
function invalidateMinimapBlocks() {
  _minimapBlocks = null;
}

function drawMinimap() {
  const W = 150, R = 75, scale = R / (CFG.world.size / 2 + 8);
  mmCtx.clearRect(0, 0, W, W);
  mmCtx.save();
  mmCtx.translate(R, R);
  // rotate so up = facing
  mmCtx.rotate(player.yaw);
  const px = player.pos.x, pz = player.pos.z;
  // colliders as blocks (pre-filtered static obstacle geometry)
  mmCtx.fillStyle = 'rgba(160,170,185,0.5)';
  const blocks = getMinimapBlocks();
  const maxBlockDistSq = R * R * 2.4;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!CORE.isMinimapBlockVisible(b.minX, b.minZ, b.w, b.d, px, pz, scale, maxBlockDistSq)) continue;
    mmCtx.fillRect((b.minX - px) * scale, (b.minZ - pz) * scale, b.w * scale, b.d * scale);
  }
  // Baseline detection is near-only; the UAV reveals the whole arena. That split
  // is what gives the minimap — and the streak — any meaning at all.
  const detect = uavActive() ? R * R : MM_BASE_DETECT * MM_BASE_DETECT * scale * scale;
  if (objective && !objective.done) {
    const ox = (objective.x - px) * scale, oz = (objective.z - pz) * scale;
    mmCtx.strokeStyle = '#4fd08a';
    mmCtx.lineWidth = 2;
    mmCtx.beginPath();
    mmCtx.arc(ox, oz, CORE.OBJECTIVE_RADIUS * scale, 0, 7);
    mmCtx.stroke();
  }
  // Stations. Drawn under the enemies: a hostile marker must never be hidden by
  // a shop marker.
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const x = (st.x - px) * scale, z = (st.z - pz) * scale;
    if (x * x + z * z > R * R) continue;
    mmCtx.fillStyle = MM_STATION_COLOR[st.kind] || '#ffffff';
    mmCtx.fillRect(x - 2.5, z - 2.5, 5, 5);
    mmCtx.strokeStyle = 'rgba(0,0,0,.6)';
    mmCtx.lineWidth = 1;
    mmCtx.strokeRect(x - 2.5, z - 2.5, 5, 5);
  }
  // enemies
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const x = (e.pos.x - px) * scale, z = (e.pos.z - pz) * scale;
    if (x * x + z * z > Math.min(R * R, detect)) continue;
    mmCtx.fillStyle = MM_KIND_COLOR[e.kind] || '#ff4030';
    const rad = (e.kind === 2 || e.kind === 3) ? 4 : e.kind === 4 ? 2.5 : 3;
    mmCtx.beginPath(); mmCtx.arc(x, z, rad, 0, 7); mmCtx.fill();
    if (e.elite) {
      mmCtx.strokeStyle = '#ffd24a'; mmCtx.lineWidth = 1.5;
      mmCtx.beginPath(); mmCtx.arc(x, z, rad + 2.5, 0, 7); mmCtx.stroke();
    }
    // GAP-08: colourblind players get a shape cue, not just a hue cue.
    if (getSetting('colorblindMarkers') && e.kind !== 0) {
      mmCtx.strokeStyle = '#fff'; mmCtx.lineWidth = 1.2;
      mmCtx.beginPath(); mmCtx.arc(x, z, 6, 0, 7); mmCtx.stroke();
    }
  }
  mmCtx.restore();
  // player arrow (center, up)
  mmCtx.fillStyle = '#7ee08a';
  mmCtx.beginPath();
  mmCtx.moveTo(R, R - 7); mmCtx.lineTo(R - 5, R + 5); mmCtx.lineTo(R + 5, R + 5);
  mmCtx.closePath(); mmCtx.fill();
}

// UI-02: the canvas was 560 px wide inside a 280 px overflow:hidden strip with no
// CSS width, so drawCompass centred the heading at x=280 — the strip's RIGHT clip
// edge — while the yellow index line sits at the centre. The compass read ~45 deg
// off with half its ticks invisible. Derive every offset from the real canvas size.
function drawCompass() {
  const w = hud.compass.width, h = hud.compass.height;
  const cx = w / 2;
  cpCtx.clearRect(0, 0, w, h);
  cpCtx.font = 'bold 11px Segoe UI';
  cpCtx.textAlign = 'center';
  const heading = CORE.compassHeading(player.yaw);
  // draw ticks every 15deg within +/- 60 of heading
  const pxPerDeg = w / 90;   // 90 degrees of heading across the visible strip
  for (let d = -60; d <= 60; d += 5) {
    const deg = (heading + d + 360) % 360;
    // snap to 5-degree marks
    const dispDeg = Math.round(deg / 5) * 5;
    const off = CORE.compassTickOffset(dispDeg, heading);
    if (Math.abs(off) > 45) continue;
    const x = cx + off * pxPerDeg;
    const isMajor = dispDeg % 45 === 0;
    cpCtx.fillStyle = isMajor ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
    if (dispDeg % 15 === 0) cpCtx.fillRect(x - 1, 12, 2, 6);
    if (isMajor) {
      const lbl = CORE.compassCardinalLabel(dispDeg);
      if (lbl) cpCtx.fillText(lbl, x, 10);
      else cpCtx.fillText(String(dispDeg), x, 10);
    }
  }
}
