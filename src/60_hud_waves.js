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
  dmgVig: $id('damage-vignette'), flash: $id('flash-overlay'),
  hitmark: document.querySelector('#crosshair .hitmark'),
  hitDir: $id('hit-dir-container'),
  sprintInd: $id('sprint-ind'), fps: $id('fps-counter'),
  minimap: $id('minimap-canvas'), compass: $id('compass-canvas'),
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

// Change-driven: this is called every frame, and each style write on an element
// the compositor is already tracking costs more than the comparison that skips it.
let _hudHp = -1, _hudArmor = -1;
function updateHudHealth() {
  const hp = Math.max(0, Math.round(player.health));
  const armor = Math.round(Math.max(0, player.armor / CFG.player.armor * 100));
  if (hp !== _hudHp) {
    _hudHp = hp;
    hud.healthBar.style.width = hp + '%';
    hud.healthNum.textContent = hp;
  }
  if (armor !== _hudArmor) {
    _hudArmor = armor;
    hud.armorBar.style.width = armor + '%';
  }
}
function updateHudAmmo() {
  const s = curS();
  if (!s) { hud.ammoMag.textContent = '—'; hud.ammoRes.textContent = ''; return; }
  hud.ammoMag.textContent = s.ammo;
  hud.ammoRes.textContent = '/ ' + s.reserve + '  ·  ' + grenades.count + ' Frag';
  hud.ammoMag.classList.toggle('low', s.ammo <= curW().mag * 0.25);
  hud.weaponName.textContent = curW().name;
  // Distinguish an empty reserve from an ordinary reload on both input paths.
  const empty = s.ammo === 0 && s.reserve === 0;
  hud.reloadHint.textContent = s.reloading ? 'RELOADING' : empty ? 'OUT OF AMMO — FIND PICKUPS' : '';
  hud.reloadHint.style.opacity = s.reloading || empty ? 1 : 0;
}

function showHitmarker(isHead) {
  hud.hitmark.style.opacity = 1;
  hud.hitmark.style.transform = 'rotate(45deg) scale(' + (isHead ? 1.6 : 1) + ')';
  clearTimeout(hud.hitmark._t);
  hud.hitmark._t = setTimeout(function () { hud.hitmark.style.opacity = 0; }, 90);
  playSound(isHead ? 'headshot' : 'hit');
}

function showDamageFx(dirDeg, amount) {
  // vignette pulse
  hud.dmgVig.style.boxShadow = 'inset 0 0 120px 40px rgba(180,0,0,' + Math.min(0.85, 0.25 + amount / 30) + ')';
  clearTimeout(hud.dmgVig._t);
  hud.dmgVig._t = setTimeout(function () { hud.dmgVig.style.boxShadow = 'inset 0 0 120px 40px rgba(180,0,0,0)'; }, 220);
  // directional indicator: dirDeg = world bearing of attacker relative to player facing
  if (dirDeg !== undefined) {
    // dirToDeg gives bearing where 0 = +z. Player forward = yaw.
    // Screen angle: 0 = attacker straight ahead, 90 = right.
    const rel = (dirDeg - (player.yaw * 180 / Math.PI) + 360) % 360;
    // yaw 0 faces -z (north). dirDeg 0 = attacker at +z (south) = behind.
    // Convert: screenDeg = 180 - rel so that attacker ahead shows at top (0deg = up arc)
    const screenDeg = (180 - rel + 360) % 360;
    showHitArc(screenDeg);
  }
  playSound('hurt');
}

// ---- Pooled hit-direction arcs ----
// Every hit taken used to create a <div> plus two setTimeouts. Under sustained
// fire that took the document from ~150 to ~630 elements with hundreds of pending
// timers. Fixed pool, recycled by age, no timers.
const HIT_ARC_POOL = 8, HIT_ARC_LIFE = 0.7;
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
function showHitArc(screenDeg) {
  const a = hitArcs[hitArcNext];
  hitArcNext = (hitArcNext + 1) % HIT_ARC_POOL;
  a.el.style.transform = 'rotate(' + screenDeg + 'deg)';
  a.el.style.opacity = '0.9';
  a.t = gameT;
}
function updateHitArcs() {
  for (let i = 0; i < hitArcs.length; i++) {
    const a = hitArcs[i];
    if (a.t < 0) continue;
    const age = gameT - a.t;
    if (age >= HIT_ARC_LIFE) { a.el.style.opacity = '0'; a.t = -99; }
    else if (age > HIT_ARC_LIFE * 0.6) a.el.style.opacity = String(0.9 * (1 - (age - HIT_ARC_LIFE * 0.6) / (HIT_ARC_LIFE * 0.4)));
  }
}

function addScore(pts, label) {
  score += pts;
  hud.scoreVal.textContent = score;
  if (label) pushKillfeed(label + ' <span class="xp">+' + pts + '</span>');
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
const MK_WINDOW = 4;          // seconds between kills to keep the streak alive
let killStreak = 0, lastKillT = -99;
function registerKillT() {
  if (gameT - lastKillT <= MK_WINDOW) killStreak++;
  else killStreak = 1;
  lastKillT = gameT;
  if (killStreak >= 2 && killStreak <= 5) {
    const label = killStreak === 2 ? 'DOUBLE KILL' : killStreak === 3 ? 'TRIPLE KILL' : killStreak === 4 ? 'QUAD KILL' : 'RAMPAGE';
    addScore(CFG.score.multikill * (killStreak - 1), label + ' x' + killStreak);
  }
  if (killStreak > 5) killStreak = 0;   // RAMPAGE cap reached — restart the streak
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

function getWaveNum() { return waveNum; }

// Snapshot of everything a resumed run needs. Only ever called between waves.
function captureRunState() {
  const weapons = [];
  for (let i = 0; i < 2; i++) {
    const gi = weaponsOwned[i];
    if (gi < 0 || !wState[i]) { weapons.push(null); continue; }
    weapons.push({ gi: gi, ammo: wState[i].ammo, reserve: wState[i].reserve });
  }
  return {
    wave: waveNum, score: score, kills: kills, headshots: headshots,
    shotsFired: shotsFired, shotsHit: shotsHit,
    health: player.health, armor: player.armor, grenades: grenades.count,
    difficulty: runDifficulty, endless: endlessMode, weapons: weapons
  };
}

function startWave(n) {
  waveNum = n;
  waveBehaviours = CORE.behavioursAtWave(n);
  waveQueue = Math.max(1, Math.round(
    CORE.endlessEnemyCount(n, CFG.wave.baseCount, CFG.wave.growth, CFG.wave.victoryWave, 60) * diff().count));
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

function updateWaves(dt) {
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
      addScore(CFG.score.waveClear + waveNum * 50, 'Wave ' + waveNum + ' cleared');
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
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < spawnPoints.length; i++) {
    const d = Math.hypot(spawnPoints[i][0] - player.pos.x, spawnPoints[i][1] - player.pos.z);
    // sweet spot: 18-35m from player
    const score = -Math.abs(d - 26) - Math.random() * 6;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const sp = spawnPoints[best];
  // Jitter, but never into a wall: ~2% of raw jittered points land inside solid
  // geometry, which is roughly 7 enemies per full run spawning clipped in a crate.
  // Resample, then fall back to the unjittered ring point.
  let x = sp[0], z = sp[1];
  for (let attempt = 0; attempt < 8; attempt++) {
    const jx = sp[0] + (Math.random() - 0.5) * 6;
    const jz = sp[1] + (Math.random() - 0.5) * 6;
    if (CORE.isSpawnValid(jx, jz, colliders, 0.6, 1.8)) { x = jx; z = jz; break; }
  }
  // kind distribution by wave: runners early, riflemen from w2, tanks from w4
  spawnEnemy(CORE.pickEnemyKind(waveNum, Math.random()), x, z);
}

function resupply() {
  for (let i = 0; i < wState.length; i++) {
    if (!wState[i]) continue;
    wState[i].reserve = Math.min(CFG.weapons[weaponsOwned[i]].reserveMax, wState[i].reserve + Math.round(CFG.weapons[weaponsOwned[i]].mag * 2.5));
  }
  player.armor = CFG.player.armor;
  grenades.count = Math.min(CFG.grenade.count, grenades.count + CFG.grenade.countPerWaves);
  updateHudAmmo(); updateHudHealth();
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
function drawMinimap() {
  const W = 150, R = 75, scale = R / (CFG.world.size / 2 + 8);
  mmCtx.clearRect(0, 0, W, W);
  mmCtx.save();
  mmCtx.translate(R, R);
  // rotate so up = facing
  mmCtx.rotate(player.yaw);
  const px = player.pos.x, pz = player.pos.z;
  // colliders as blocks
  mmCtx.fillStyle = 'rgba(160,170,185,0.5)';
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.max.y < 0.6) continue;
    const x = (c.min.x - px) * scale, z = (c.min.z - pz) * scale;
    const w = (c.max.x - c.min.x) * scale, h = (c.max.z - c.min.z) * scale;
    if (x * x + z * z > R * R * 2.4) continue;
    mmCtx.fillRect(x, z, w, h);
  }
  // enemies
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const x = (e.pos.x - px) * scale, z = (e.pos.z - pz) * scale;
    if (x * x + z * z > R * R) continue;
    mmCtx.fillStyle = MM_KIND_COLOR[e.kind] || '#ff4030';
    mmCtx.beginPath(); mmCtx.arc(x, z, (e.kind === 2 || e.kind === 3) ? 4 : e.kind === 4 ? 2.5 : 3, 0, 7); mmCtx.fill();
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
  // heading degrees: 0 = north (-z). yaw 0 faces -z? our forward = (-sin yaw, -cos yaw); yaw=0 -> (0,-1) = north
  const heading = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
  // draw ticks every 15deg within +/- 60 of heading
  const pxPerDeg = w / 90;   // 90 degrees of heading across the visible strip
  for (let d = -60; d <= 60; d += 5) {
    const deg = (heading + d + 360) % 360;
    // snap to 5-degree marks
    const base = Math.round(deg / 5) * 5;
    const dispDeg = base;
    const off = (dispDeg - heading + 540) % 360 - 180;
    if (Math.abs(off) > 45) continue;
    const x = cx + off * pxPerDeg;
    const isMajor = dispDeg % 45 === 0;
    cpCtx.fillStyle = isMajor ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
    if (dispDeg % 15 === 0) cpCtx.fillRect(x - 1, 12, 2, 6);
    if (isMajor) {
      const lbl = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[dispDeg];
      if (lbl) cpCtx.fillText(lbl, x, 10);
      else cpCtx.fillText(String(dispDeg), x, 10);
    }
  }
}
