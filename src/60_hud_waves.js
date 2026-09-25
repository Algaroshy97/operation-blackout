// ============ HUD & WAVES ============
'use strict';
// ---- HUD refs ----
const hud = {
  healthBar: $id('health-bar'), healthGhost: $id('health-ghost'), healthNum: $id('health-num'), armorBar: $id('armor-bar'),
  staminaBar: $id('stamina-bar'), staminaWrap: $id('stamina-container'),
  ammoMag: $id('ammo-mag'), ammoRes: $id('ammo-res'), ammoPips: $id('ammo-pips'), weaponName: $id('weapon-name'),
  weaponSlots: $id('weapon-slots'), grenadeIcons: $id('grenade-icons'),
  reloadHint: $id('reload-hint'), scoreVal: $id('score-val'), bestVal: $id('best-val'),
  waveNum: $id('wave-num'), enemiesLeft: $id('enemies-left'), waveProg: $id('wave-progress-fill'),
  waveBig: $id('wb-big'), waveSub: $id('wb-sub'), waveBanner: $id('wave-banner'),
  centerMsg: $id('center-msg'), killfeed: $id('killfeed'), streak: $id('streak-msg'),
  dmgVig: $id('damage-vignette'), flash: $id('flash-overlay'),
  hitmark: document.querySelector('#crosshair .hitmark'),
  crosshair: $id('crosshair'), chLines: document.querySelectorAll('#crosshair .c-line'),
  hitDir: $id('hit-dir-container'), nadeWarn: $id('nade-warn'),
  sprintInd: $id('sprint-ind'), fps: $id('fps-counter'),
  minimap: $id('minimap-canvas'), compass: $id('compass-canvas'),
  dmgNums: $id('dmg-numbers'),
  grenadeCharge: $id('grenade-charge'),
  grenadeChargeTxt: $id('grenade-charge-txt'),
  grenadeChargeFill: $id('grenade-charge-fill')
};

function updateHudGrenadeCharge(visible, pct, speed) {
  if (!hud.grenadeCharge) return;
  if (!visible) {
    hud.grenadeCharge.style.opacity = '0';
    return;
  }
  hud.grenadeCharge.style.opacity = '1';
  if (hud.grenadeChargeFill) hud.grenadeChargeFill.style.width = pct + '%';
  if (hud.grenadeChargeTxt) hud.grenadeChargeTxt.textContent = 'GRENADE ' + Math.round(speed || 0) + ' M/S (' + pct + '%)';
}

// Health: bar + a trailing "ghost" that drains after the hit (shows how much you just lost)
let ghostHp = 100, lastHudHp = -1, lastHudArmor = -1;
function updateHudHealth() {
  const hp = Math.max(0, Math.round(player.health));
  if (hp !== lastHudHp) {
    hud.healthBar.style.width = hp + '%';
    hud.healthNum.textContent = hp;
    hud.healthBar.classList.toggle('low', hp <= 30);
    lastHudHp = hp;
  }
  const ar = Math.round(Math.max(0, player.armor / maxArmor() * 100));
  if (ar !== lastHudArmor) { hud.armorBar.style.width = ar + '%'; lastHudArmor = ar; }
}
function updateHudTick(dt) {
  ghostHp = ghostHp > player.health ? Math.max(player.health, ghostHp - dt * (gameT - player.lastDamageT > 0.6 ? 60 : 0)) : player.health;
  hud.healthGhost.style.width = Math.max(0, ghostHp) + '%';
  const st = player.stamina / (CFG.player.maxStamina * perkMul('stamina'));
  hud.staminaBar.style.width = Math.round(st * 100) + '%';
  hud.staminaWrap.style.opacity = st < 0.99 ? '1' : '0';
  hud.staminaWrap.classList.toggle('exhausted', player.exhausted);
}
function updateHudAmmo() {
  const s = curS();
  if (!s) { hud.ammoMag.textContent = '—'; hud.ammoRes.textContent = ''; return; }
  const w = curW();
  hud.ammoMag.textContent = s.ammo;
  hud.ammoRes.textContent = '/ ' + s.reserve;
  hud.ammoMag.classList.toggle('low', s.ammo <= magSize(w) * 0.25);
  hud.weaponName.textContent = w.name;
  // magazine pips (capped so the LMG does not draw 100 of them)
  const cap = magSize(w), shown = Math.min(cap, 40);
  const full = Math.round(s.ammo / Math.max(1, cap) * shown);
  if (hud.ammoPips._n !== shown || hud.ammoPips._f !== full) {
    let h = '';
    for (let i = 0; i < shown; i++) h += '<i' + (i < full ? '' : ' class="e"') + '></i>';
    hud.ammoPips.innerHTML = h;
    hud.ammoPips._n = shown; hud.ammoPips._f = full;
  }
  hud.ammoPips.className = shown > 20 ? 'dense' : '';
  // weapon slots + grenades
  let slots = '';
  for (let i = 0; i < 2; i++) {
    const gi = weaponsOwned[i];
    if (gi < 0) continue;
    slots += '<span class="' + (i === curWeapon ? 'on' : '') + '"><b>' + (i + 1) + '</b>' + CFG.weapons[gi].name.split(' ')[0] + '</span>';
  }
  hud.weaponSlots.innerHTML = slots;
  let g = '';
  for (let i = 0; i < maxGrenades(); i++) g += '<i' + (i < grenades.count ? '' : ' class="e"') + '></i>';
  hud.grenadeIcons.innerHTML = g;
  // Distinguish an empty reserve from an ordinary reload on both input paths.
  const empty = s.ammo === 0 && s.reserve === 0;
  hud.reloadHint.textContent = s.reloading ? 'RELOADING' : empty ? 'OUT OF AMMO — FIND PICKUPS' : (s.ammo <= magSize(w) * 0.2 && s.reserve > 0 ? 'PRESS R TO RELOAD' : '');
  hud.reloadHint.style.opacity = hud.reloadHint.textContent ? 1 : 0;
}

// Dynamic crosshair: line gap follows the real spread cone in pixels.
let chGapShown = 8;
function updateCrosshair(opacity, spreadRad) {
  const px = spreadRad * (innerHeight / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const gap = Math.max(4, Math.min(80, px));
  chGapShown += (gap - chGapShown) * 0.35;
  const g = chGapShown.toFixed(1);
  const L = hud.chLines;
  if (L.length === 4) {
    L[0].style.transform = 'translate(-50%, calc(-100% - ' + g + 'px))';
    L[1].style.transform = 'translate(-50%, ' + g + 'px)';
    L[2].style.transform = 'translate(calc(-100% - ' + g + 'px), -50%)';
    L[3].style.transform = 'translate(' + g + 'px, -50%)';
  }
  hud.crosshair.style.opacity = opacity;
}

function showHitmarker(isHead, kill) {
  const hm = hud.hitmark;
  hm.classList.remove('kill', 'head');
  if (kill) hm.classList.add('kill'); else if (isHead) hm.classList.add('head');
  hm.style.opacity = 1;
  hm.style.transform = 'translate(-50%,-50%) rotate(45deg) scale(' + (kill ? 1.7 : isHead ? 1.35 : 1) + ')';
  clearTimeout(hm._t);
  hm._t = setTimeout(function () { hm.style.opacity = 0; }, kill ? 260 : 110);
  if (!kill) playSound(isHead ? 'headshot' : 'hit');
}

// Floating damage numbers (world-anchored, pooled DOM nodes)
const dmgNumPool = [], dmgNumLive = [];
const _dnV = new THREE.Vector3();
function spawnDamageNumber(point, dmg, isHead, kill) {
  if (!SETTINGS.damageNumbers) return;
  const el = dmgNumPool.pop() || (function () { const d = document.createElement('div'); d.className = 'dmg-num'; hud.dmgNums.appendChild(d); return d; })();
  el.textContent = Math.round(dmg);
  el.className = 'dmg-num' + (isHead ? ' head' : '') + (kill ? ' kill' : '');
  el.style.display = 'block';
  dmgNumLive.push({ el: el, p: point.clone(), t: 0, vx: (Math.random() - 0.5) * 0.6 });
}
function updateDamageNumbers(dt) {
  for (let i = dmgNumLive.length - 1; i >= 0; i--) {
    const d = dmgNumLive[i];
    d.t += dt;
    if (d.t > 0.9) { d.el.style.display = 'none'; dmgNumPool.push(d.el); dmgNumLive.splice(i, 1); continue; }
    _dnV.copy(d.p); _dnV.y += d.t * 0.9; _dnV.x += d.vx * d.t;
    _dnV.project(camera);
    if (_dnV.z > 1) { d.el.style.opacity = 0; continue; }
    d.el.style.opacity = String(Math.min(1, (0.9 - d.t) * 3));
    d.el.style.transform = 'translate(' + ((_dnV.x * 0.5 + 0.5) * innerWidth).toFixed(1) + 'px,' + ((-_dnV.y * 0.5 + 0.5) * innerHeight).toFixed(1) + 'px) translate(-50%,-50%) scale(' + (1 + Math.max(0, 0.15 - d.t) * 3).toFixed(2) + ')';
  }
}
function clearDamageNumbers() {
  for (const d of dmgNumLive) { d.el.style.display = 'none'; dmgNumPool.push(d.el); }
  dmgNumLive.length = 0;
}

function showDamageFx(dirDeg, amount) {
  // vignette pulse (the post-FX pass adds a stronger shader version)
  hud.dmgVig.style.boxShadow = 'inset 0 0 120px 40px rgba(180,0,0,' + Math.min(0.85, 0.25 + amount / 30) + ')';
  clearTimeout(hud.dmgVig._t);
  hud.dmgVig._t = setTimeout(function () { hud.dmgVig.style.boxShadow = 'inset 0 0 120px 40px rgba(180,0,0,0)'; }, 220);
  // directional indicator: dirDeg = world bearing of attacker relative to player facing
  if (dirDeg !== undefined) {
    const rel = (dirDeg - (player.yaw * 180 / Math.PI) + 360) % 360;
    // yaw 0 faces -z (north). dirDeg 0 = attacker at +z (south) = behind.
    const screenDeg = (180 - rel + 360) % 360;
    const el = document.createElement('div');
    el.className = 'hit-dir';
    el.style.transform = 'rotate(' + screenDeg + 'deg)';
    el.innerHTML = '<div class="arc"></div>';
    hud.hitDir.appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = '0.9'; });
    setTimeout(function () { el.style.opacity = '0'; }, 600);
    setTimeout(function () { el.remove(); }, 700);
  }
  playSound('hurt');
}
// Incoming enemy grenade warning: an icon on a ring pointing at the grenade.
function updateGrenadeWarning() {
  let best = null, bestD = 9;
  for (let i = 0; i < liveGrenades.length; i++) {
    const g = liveGrenades[i];
    if (!g.enemy) continue;
    const d = Math.hypot(g.m.position.x - player.pos.x, g.m.position.z - player.pos.z);
    if (d < bestD) { bestD = d; best = g; }
  }
  if (!best) { hud.nadeWarn.style.opacity = 0; return; }
  const bearing = Math.atan2(best.m.position.x - player.pos.x, best.m.position.z - player.pos.z) * 180 / Math.PI;
  const rel = (bearing - (player.yaw * 180 / Math.PI) + 720) % 360;
  const screenDeg = (180 - rel + 360) % 360;
  hud.nadeWarn.style.opacity = 1;
  hud.nadeWarn.style.transform = 'translate(-50%,-50%) rotate(' + screenDeg + 'deg)';
  hud.nadeWarn.classList.toggle('close', bestD < CFG.grenade.radius);
}

function addScore(pts, label) {
  pts = Math.round(pts * diff().score);
  score += pts;
  hud.scoreVal.textContent = score;
  if (label) notify(label, pts);
}
function notify(label, pts) {
  const li = document.createElement('div');
  li.className = 'killfeed-item';
  li.innerHTML = label + (pts ? ' <span class="xp">+' + pts + '</span>' : '');
  hud.killfeed.appendChild(li);
  while (hud.killfeed.children.length > 6) hud.killfeed.firstChild.remove();
  setTimeout(function () { li.remove(); }, 4200);
}
function addKill(isHead) { kills++; if (isHead) headshots++; }
// ---- Multi-kill streak bonus ----
// A kill within MK_WINDOW of the previous one extends a streak. 2+ kills in a
// row award an escalating bonus (x2, x3, ... capped at x5); the window resets
// after the cap or on a >4 s gap. resetGame() clears the streak state.
const MK_WINDOW = 4;          // seconds between kills to keep the streak alive
let killStreak = 0, lastKillT = -99;
function registerKillT() {
  if (gameT - lastKillT <= MK_WINDOW) killStreak++;
  else killStreak = 1;
  lastKillT = gameT;
  if (killStreak >= 2 && killStreak <= 5) {
    const label = killStreak === 2 ? 'DOUBLE KILL' : killStreak === 3 ? 'TRIPLE KILL' : killStreak === 4 ? 'QUAD KILL' : 'RAMPAGE';
    addScore(CFG.score.multikill * (killStreak - 1), label + ' x' + killStreak);
    hud.streak.textContent = label;
    hud.streak.classList.remove('pop'); void hud.streak.offsetWidth; hud.streak.classList.add('pop');
  }
  if (killStreak > 5) killStreak = 0;   // RAMPAGE cap reached — restart the streak
}

// ---- Wave system ----
let waveNum = 0, score = 0, kills = 0, headshots = 0;
let shotsFired = 0, shotsHit = 0;
let waveQueue = 0, spawnTimer = 0, waveActive = false, gameEnded = false, gameT = 0;
let betweenWaveT = 0, waveTotal = 1;
let nextEstepT = 0;   // global throttle for positional enemy footsteps

function getWaveNum() { return waveNum; }

function startWave(n) {
  waveNum = n;
  waveQueue = Math.round(CFG.wave.baseCount + (n - 1) * CFG.wave.growth);
  waveTotal = waveQueue;
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
          const burstSize = Math.floor(Math.random() * 2) + 3; // 3 or 4 enemies
          const count = Math.min(burstSize, waveQueue, canSpawn);
          for (let i = 0; i < count; i++) {
            spawnFromQueue();
          }
          spawnTimer = 2.5 + Math.random() * 1.5; // short pause between bursts
        } else {
          spawnTimer = 0.5;
        }
      }
    } else if (aliveEnemies() === 0) {
      // wave cleared
      waveActive = false;
      betweenWaveT = 5;
      addScore(CFG.score.waveClear + waveNum * 50, 'Wave ' + waveNum + ' cleared');
      resupply();
      respawnBarrels();
      if (waveNum >= CFG.wave.victoryWave) { victory(); return; }
      showWaveBanner(waveNum, true);   // cleared banner stays up through the countdown
      if (perkWaveDue(waveNum)) openPerkMenu();
    }
  } else if (!perkMenuOpen()) {
    betweenWaveT -= dt;
    updateWaveCountdown();
    if (betweenWaveT <= 0) startWave(waveNum + 1);
  }
  const left = waveQueue + aliveEnemies();
  hud.enemiesLeft.textContent = left + ' HOSTILE' + (left === 1 ? '' : 'S');
  hud.waveProg.style.width = (waveActive ? Math.round((1 - left / Math.max(1, waveTotal)) * 100) : 100) + '%';
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
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < spawnPoints.length; i++) {
    const d = Math.hypot(spawnPoints[i][0] - player.pos.x, spawnPoints[i][1] - player.pos.z);
    // sweet spot: 18-35m from player
    const sc = -Math.abs(d - 26) - Math.random() * 6;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  const sp = spawnPoints[best];
  const x = sp[0] + (Math.random() - 0.5) * 6;
  const z = sp[1] + (Math.random() - 0.5) * 6;
  // kind distribution: runners early, riflemen from w2, heavies from w4, grenadiers from w5
  const roll = Math.random();
  let kind = 0;
  if (waveNum >= 4 && roll < 0.12 + Math.min(0.15, waveNum * 0.01)) kind = 2;
  else if (waveNum >= 5 && roll < 0.24 + Math.min(0.08, waveNum * 0.006)) kind = 3;
  else if (waveNum >= 2 && roll < 0.55) kind = 1;
  spawnEnemy(kind, x, z);
}

function resupply() {
  for (let i = 0; i < wState.length; i++) {
    if (!wState[i]) continue;
    const w = CFG.weapons[weaponsOwned[i]];
    wState[i].reserve = Math.min(w.reserveMax, wState[i].reserve + Math.round(w.mag * 2.5));
  }
  player.armor = maxArmor();
  grenades.count = Math.min(maxGrenades(), grenades.count + CFG.grenade.countPerWaves);
  updateHudAmmo(); updateHudHealth();
}

function showWaveBanner(n, cleared) {
  // n = wave number; cleared = shown after clearing wave n (stays up for the countdown);
  // n = 0 = pre-battle "GET READY" banner at deploy (stays up until wave 1 starts).
  hud.waveBig.textContent = n === 0 ? 'GET READY' : (cleared ? 'WAVE ' + n + ' CLEARED' : 'WAVE ' + n);
  hud.waveSub.textContent = (cleared || n === 0) ? '' : (n === CFG.wave.victoryWave ? 'FINAL WAVE' : 'HOSTILES INBOUND');
  hud.waveBanner.style.opacity = 1;
  clearTimeout(hud.waveBanner._t);
  if (n >= 1 && !cleared) hud.waveBanner._t = setTimeout(function () { hud.waveBanner.style.opacity = 0; }, 2200);
}
// Live "NEXT WAVE IN N" countdown during the between-wave gap.
function updateWaveCountdown() {
  const n = Math.max(1, Math.ceil(betweenWaveT));
  if (waveNum === 0) hud.waveSub.textContent = 'COMBAT IN ' + n;
  else hud.waveSub.textContent = 'NEXT WAVE IN ' + n;
}
function showCenterMsg(txt) {
  hud.centerMsg.textContent = txt;
  hud.centerMsg.style.opacity = 1;
  clearTimeout(hud.centerMsg._t);
  hud.centerMsg._t = setTimeout(function () { hud.centerMsg.style.opacity = 0; }, 1800);
}

// ---- Minimap + compass ----
const mmCtx = hud.minimap.getContext('2d');
const cpCtx = hud.compass.getContext('2d');
function drawMinimap() {
  const W = 150, R = 75, scale = R / 34;   // ~34 m radius visible
  mmCtx.clearRect(0, 0, W, W);
  mmCtx.save();
  mmCtx.translate(R, R);
  // rotate so up = facing
  mmCtx.rotate(player.yaw);
  const px = player.pos.x, pz = player.pos.z;
  // colliders as blocks (upper-floor-only geometry dimmed)
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.max.y < 0.6) continue;
    const x = (c.min.x - px) * scale, z = (c.min.z - pz) * scale;
    const w = (c.max.x - c.min.x) * scale, h = (c.max.z - c.min.z) * scale;
    if (x > R * 1.5 || z > R * 1.5 || x + w < -R * 1.5 || z + h < -R * 1.5) continue;
    mmCtx.fillStyle = c.barrel ? 'rgba(255,120,60,0.9)' : c.min.y > 2 ? 'rgba(140,150,165,0.25)' : 'rgba(170,180,195,0.55)';
    mmCtx.fillRect(x, z, w, h);
  }
  // pickups
  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    const x = (p.m.position.x - px) * scale, z = (p.m.position.z - pz) * scale;
    if (x * x + z * z > R * R) continue;
    mmCtx.fillStyle = p.kind === 'ammo' ? '#ffd24a' : '#7ee08a';
    mmCtx.fillRect(x - 2, z - 2, 4, 4);
  }
  // enemies: only those that are close, firing, or recently spotted show up
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    const x = (e.pos.x - px) * scale, z = (e.pos.z - pz) * scale;
    if (x * x + z * z > R * R) continue;
    const vis = (gameT - (e.lastShotT || -9) < 2.5) || Math.hypot(e.pos.x - px, e.pos.z - pz) < 16 || (gameT - (e.seenT || -9) < 1.5);
    if (!vis) continue;
    mmCtx.fillStyle = e.kind === 2 ? '#ff8830' : e.kind === 3 ? '#ffcc30' : '#ff4030';
    mmCtx.beginPath(); mmCtx.arc(x, z, e.kind === 2 ? 4 : 3, 0, 7); mmCtx.fill();
  }
  // live enemy grenades
  for (let i = 0; i < liveGrenades.length; i++) {
    const g = liveGrenades[i];
    const x = (g.m.position.x - px) * scale, z = (g.m.position.z - pz) * scale;
    mmCtx.strokeStyle = g.enemy ? '#ff4030' : '#ffd24a'; mmCtx.lineWidth = 1.5;
    mmCtx.beginPath(); mmCtx.arc(x, z, CFG.grenade.radius * scale, 0, 7); mmCtx.stroke();
  }
  mmCtx.restore();
  // view cone + player arrow (center, up)
  const grad = mmCtx.createRadialGradient(R, R, 0, R, R, R);
  grad.addColorStop(0, 'rgba(126,224,138,0.28)'); grad.addColorStop(1, 'rgba(126,224,138,0)');
  mmCtx.fillStyle = grad;
  const half = THREE.MathUtils.degToRad(camera.fov * camera.aspect) / 2;
  mmCtx.beginPath(); mmCtx.moveTo(R, R); mmCtx.arc(R, R, R, -Math.PI / 2 - half, -Math.PI / 2 + half); mmCtx.closePath(); mmCtx.fill();
  mmCtx.fillStyle = '#7ee08a';
  mmCtx.beginPath();
  mmCtx.moveTo(R, R - 7); mmCtx.lineTo(R - 5, R + 5); mmCtx.lineTo(R + 5, R + 5);
  mmCtx.closePath(); mmCtx.fill();
}

// Compass: 560x36 canvas drawn at 2x and shown at 280x18 CSS px (crisp on hi-dpi).
const COMPASS_W = 560, COMPASS_H = 36;
function drawCompass() {
  const w = COMPASS_W, h = COMPASS_H, cx = w / 2;
  cpCtx.clearRect(0, 0, w, h);
  cpCtx.font = 'bold 20px Segoe UI, Arial';
  cpCtx.textAlign = 'center';
  // heading: 0 = north (-z). forward = (-sin yaw, -cos yaw), so yaw 0 faces north.
  const heading = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const pxPerDeg = w / 110;   // ~110 degrees across the strip
  const start = Math.floor((heading - 60) / 5) * 5;
  for (let d = start; d <= heading + 60; d += 5) {
    const deg = ((d % 360) + 360) % 360;
    const x = cx + (d - heading) * pxPerDeg;
    const major = deg % 45 === 0;
    const fade = 1 - Math.abs(d - heading) / 60;
    cpCtx.fillStyle = 'rgba(255,255,255,' + (major ? 0.95 : 0.45) * fade + ')';
    cpCtx.fillRect(x - 1, major ? 22 : 28, 2, major ? 14 : 8);
    if (major) {
      const lbl = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[deg];
      cpCtx.fillStyle = deg === 0 ? 'rgba(255,210,74,' + fade + ')' : 'rgba(255,255,255,' + fade + ')';
      cpCtx.fillText(lbl, x, 18);
    } else if (deg % 15 === 0) {
      cpCtx.font = '14px Segoe UI, Arial';
      cpCtx.fillStyle = 'rgba(255,255,255,' + 0.5 * fade + ')';
      cpCtx.fillText(String(deg), x, 18);
      cpCtx.font = 'bold 20px Segoe UI, Arial';
    }
  }
  // enemy fire markers on the compass
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead || gameT - (e.lastShotT || -9) > 1.5) continue;
    const b = ((Math.atan2(-(e.pos.x - player.pos.x), -(e.pos.z - player.pos.z)) * -180 / Math.PI) % 360 + 360) % 360;
    let off = ((b - heading + 540) % 360) - 180;
    if (Math.abs(off) > 55) off = Math.sign(off) * 55;
    cpCtx.fillStyle = 'rgba(255,64,48,0.95)';
    cpCtx.beginPath(); const x = cx + off * pxPerDeg; cpCtx.moveTo(x, 0); cpCtx.lineTo(x - 6, 8); cpCtx.lineTo(x + 6, 8); cpCtx.fill();
  }
}
