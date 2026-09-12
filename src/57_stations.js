// ============ STATIONS: WALL BUYS, ARMORY, PERKS, PLATES ============
'use strict';
// Phase 9 gave the player credits and nothing to spend them on. A station is a
// fixed point in the arena the player walks to and holds USE at. The hold exists
// because these sit in the middle of a firefight: a purchase must never happen
// from a stray tap while strafing past one.
//
// Housings are built through addBox() during buildArena(), so they join the
// existing static batches and their colliders come for free. Nothing here draws
// its own mesh or its own text — the prompt is HUD, and the minimap marks them,
// which is what makes them findable without a single extra draw call for labels.

const stations = [];

// Positions were chosen to pull the player OUT of the central building, which is
// otherwise the whole game: one wall buy per corner district, perks on the
// approaches, and the armory out on the north face where it is genuinely exposed.
const STATION_LAYOUT = [
  { kind: 'wall', x: -37, z:  30, weapon: 1 },   // MK18
  { kind: 'wall', x:  34, z:  30, weapon: 0 },   // M4
  { kind: 'wall', x: -30, z: -32, weapon: 2 },   // SCAR-H
  { kind: 'wall', x:  31, z: -37, weapon: 3 },   // SV-98
  { kind: 'armory', x: 0, z: -22 },
  { kind: 'plate',  x: 0, z:  20 },
  { kind: 'perk', x: -21, z:  10, perk: 'jugg' },
  { kind: 'perk', x:  21, z:  10, perk: 'reload' },
  { kind: 'perk', x: -21, z: -10, perk: 'steady' },
  { kind: 'perk', x:  21, z: -10, perk: 'scav' },
  { kind: 'perk', x:   0, z:  34, perk: 'wind' },
  // Equipment: one board cycles lethal variants, one cycles tacticals. Two boards
  // rather than a menu, because a shop UI mid-firefight is a worse answer than
  // walking to the thing you want.
  { kind: 'lethal',   x: -12, z:  20 },
  { kind: 'tactical', x:  12, z:  20 }
];

const STATION_COLOR = {
  wall: 0x2f6f4f, armory: 0x8a6a1f, perk: 0x2f4f78, plate: 0x5a6068,
  lethal: 0x7a3a2a, tactical: 0x2a6a7a
};
// Which variant each equipment board currently offers. Cycles on purchase, so one
// board can sell the whole list without a menu.
let lethalIdx = 1;      // index 0 is the free frag; the board sells the rest
let tacticalIdx = 0;

function buildStations() {
  for (let i = 0; i < STATION_LAYOUT.length; i++) {
    const def = STATION_LAYOUT[i];
    const mat = new THREE.MeshStandardMaterial({
      color: STATION_COLOR[def.kind] || 0x555555, roughness: 0.7, metalness: 0.25
    });
    // Housing plus a bright lip, so a station reads as interactive at a distance
    // without needing a label mesh.
    addBox(def.x, 0.9, def.z, 1.4, 1.8, 0.45, mat, { pen: 'metal' });
    addBox(def.x, 1.86, def.z, 1.5, 0.12, 0.55, MAT.accent, { noCollide: true, pen: 'metal' });
    stations.push({
      kind: def.kind, x: def.x, z: def.z,
      weapon: def.weapon === undefined ? -1 : def.weapon,
      perk: def.perk || null,
      holdT: 0
    });
  }
  reportUnreachableStations();
}

// Two of these were originally placed inside corner-district geometry, with zero
// clear stand-points — a shop sign painted on a solid wall. Hand-checking
// coordinates against a 140-collider arena does not scale, so check it at load.
// Exposed on `window` so scripts/probe_live.py can assert on it.
function unreachableStations() {
  const bad = [];
  const ring = CORE.BUY_RADIUS - 0.4;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    let clear = 0;
    for (let a = 0; a < 12; a++) {
      const ang = a * Math.PI / 6;
      const x = st.x + Math.sin(ang) * ring, z = st.z + Math.cos(ang) * ring;
      if (Math.abs(x) > mapBounds || Math.abs(z) > mapBounds) continue;
      if (CORE.isSpawnValid(x, z, colliders, 0.6, 1.8, CFG.player.radius + 0.05)) clear++;
    }
    if (clear === 0) bad.push(st.kind + '@' + st.x + ',' + st.z);
  }
  return bad;
}
function reportUnreachableStations() {
  const bad = unreachableStations();
  if (bad.length) console.warn('UNREACHABLE STATIONS:', bad.join(' '));
  window.__unreachableStations = bad;
}

// ---- Run state ----
// Perks are per-run, not a saved setting: they are bought with credits earned in
// the run and lost with it.
let perks = [];
let plates = 0;
let plateT = 0;          // plate-insert animation / lockout
let activeStation = -1;
let stationHoldT = 0;
let lastBuyMsgT = -99;

function resetStations() {
  perks = [];
  plates = 0;
  plateT = 0;
  activeStation = -1;
  stationHoldT = 0;
  lethalIdx = 1;
  tacticalIdx = 0;
  for (let i = 0; i < stations.length; i++) stations[i].holdT = 0;
}

// ---- Offers -----------------------------------------------------------------
// One function decides both what a station says and what it costs, so the prompt
// can never advertise a price the purchase does not charge.
function stationOffer(st) {
  if (st.kind === 'wall') {
    const w = CFG.weapons[st.weapon];
    const held = weaponsOwned.indexOf(st.weapon);
    const s = held >= 0 ? wState[held] : null;
    const reserve = s ? s.reserve : 0;
    const reserveMax = s && s.up ? s.up.reserveMax : w.reserveMax;
    const offer = CORE.wallBuyOffer(weaponsOwned, st.weapon, w.type, reserve, reserveMax);
    if (offer.action === 'full') return { label: w.name.toUpperCase() + ' — FULL', price: 0, ok: false };
    if (offer.action === 'ammo') return { label: 'AMMO · ' + w.name.toUpperCase(), price: offer.price, ok: true };
    return { label: w.name.toUpperCase(), price: offer.price, ok: true };
  }
  if (st.kind === 'armory') {
    if (!CORE.armoryAvailable(waveNum)) {
      return { label: 'ARMORY — LOCKED UNTIL WAVE ' + CORE.ARMORY_WAVE, price: 0, ok: false };
    }
    const s = curS();
    if (!s) return { label: 'ARMORY', price: 0, ok: false };
    if (s.up) return { label: curW().name.toUpperCase() + ' — ALREADY UPGRADED', price: 0, ok: false };
    return { label: 'UPGRADE ' + curW().name.toUpperCase(), price: CORE.ARMORY_PRICE, ok: true };
  }
  if (st.kind === 'plate') {
    if (plates >= CORE.PLATE_MAX) return { label: 'PLATES — FULL', price: 0, ok: false };
    return { label: 'ARMOR PLATE (' + plates + '/' + CORE.PLATE_MAX + ')', price: CORE.PLATE_PRICE, ok: true };
  }
  if (st.kind === 'lethal') {
    const d = CORE.LETHALS[lethalIdx];
    if (d.key === equippedLethal) {
      return { label: d.name + ' — EQUIPPED  (USE TO CYCLE)', price: 0, ok: true, cycle: true };
    }
    return { label: d.name + '  (TAP TO CYCLE)', price: d.price, ok: true };
  }
  if (st.kind === 'tactical') {
    const d = CORE.TACTICALS[tacticalIdx];
    if (d.key === equippedTactical && tacticalCount >= TACTICAL_MAX) {
      return { label: d.name + ' — FULL  (USE TO CYCLE)', price: 0, ok: true, cycle: true };
    }
    const refill = d.key === equippedTactical;
    return { label: (refill ? 'RESUPPLY ' : '') + d.name, price: refill ? Math.round(d.price / 2) : d.price, ok: true };
  }
  const p = CORE.perkByKey(st.perk);
  if (!p) return { label: 'PERK', price: 0, ok: false };
  const blocker = CORE.perkBuyBlocker(perks, st.perk, credits);
  if (blocker) return { label: p.name + ' — ' + blocker, price: p.price, ok: false };
  return { label: p.name + ' · ' + p.blurb.toUpperCase(), price: p.price, ok: true };
}

function purchase(st) {
  const offer = stationOffer(st);
  if (!offer.ok) return false;
  if (offer.cycle) {
    // Cycling the board costs nothing and buys nothing.
    if (st.kind === 'lethal') lethalIdx = (lethalIdx + 1) % CORE.LETHALS.length;
    else if (st.kind === 'tactical') tacticalIdx = (tacticalIdx + 1) % CORE.TACTICALS.length;
    playSound('draw');
    return true;
  }
  if (!spendCredits(offer.price)) {
    showCenterMsg('NEED ' + (offer.price - credits) + ' MORE CREDITS');
    return false;
  }
  if (st.kind === 'wall') {
    const held = weaponsOwned.indexOf(st.weapon);
    if (held >= 0) {
      const s = wState[held];
      s.reserve = s.up ? s.up.reserveMax : CFG.weapons[st.weapon].reserveMax;
      showCenterMsg('+ AMMO');
    } else {
      // Replace the weapon in the CURRENT slot. Replacing the other one would
      // silently discard whatever the player was holding.
      const w = CFG.weapons[st.weapon];
      weaponsOwned[curWeapon] = st.weapon;
      wState[curWeapon] = { ammo: w.mag, reserve: w.reserveMax, reloading: false, reloadT: 0, nextShot: 0 };
      buildViewmodel();
      showCenterMsg(w.name.toUpperCase() + ' ACQUIRED');
    }
    updateHudAmmo();
  } else if (st.kind === 'armory') {
    const s = curS();
    s.up = CORE.armoryUpgrade(CFG.weapons[weaponsOwned[curWeapon]]);
    s.ammo = s.up.mag;
    s.reserve = s.up.reserveMax;
    showCenterMsg(s.up.name.toUpperCase());
    updateHudAmmo();
  } else if (st.kind === 'plate') {
    plates = Math.min(CORE.PLATE_MAX, plates + 1);
    updateHudPlates();
    showCenterMsg('PLATE ' + plates + '/' + CORE.PLATE_MAX);
  } else if (st.kind === 'lethal') {
    if (offer.cycle) { lethalIdx = (lethalIdx + 1) % CORE.LETHALS.length; return true; }
    equippedLethal = CORE.LETHALS[lethalIdx].key;
    grenades.count = CFG.grenade.count;
    updateHudAmmo();
    showCenterMsg(CORE.LETHALS[lethalIdx].name + ' EQUIPPED');
  } else if (st.kind === 'tactical') {
    if (offer.cycle) { tacticalIdx = (tacticalIdx + 1) % CORE.TACTICALS.length; return true; }
    equippedTactical = CORE.TACTICALS[tacticalIdx].key;
    tacticalCount = TACTICAL_MAX;
    updateHudAmmo();
    showCenterMsg(CORE.TACTICALS[tacticalIdx].name + ' EQUIPPED');
  } else {
    perks.push(st.perk);
    const p = CORE.perkByKey(st.perk);
    // Juggernaut raises the ceiling; give the health with it, or the perk does
    // nothing visible until the next med pickup.
    if (st.perk === 'jugg') player.health += 50;
    updateHudHealth();
    updateHudPerks();
    showCenterMsg(p.name + ' ACQUIRED');
  }
  playSound('powerup');
  return true;
}

// ---- Per-frame --------------------------------------------------------------
function updateStations(dt) {
  if (!started || paused || player.dead) { setBuyPrompt(null, 0); return; }
  // Plating runs to completion once started; it is a commitment, like a reload.
  if (plateT > 0) {
    plateT = Math.max(0, plateT - dt);
    if (plateT === 0) {
      const r = CORE.plateApply(player.armor, CFG.player.armor, plates);
      if (r) { player.armor = r.armor; plates = r.plates; updateHudHealth(); updateHudPlates(); }
    }
    setBuyPrompt('INSERTING PLATE', 1 - plateT / CORE.PLATE_TIME);
    return;
  }
  if (pressed['KeyX'] || pressed['__plate']) usePlate();

  const idx = CORE.nearestStation(stations, player.pos.x, player.pos.z, CORE.BUY_RADIUS);
  if (idx !== activeStation) { activeStation = idx; stationHoldT = 0; }
  if (idx < 0) { setBuyPrompt(null, 0); return; }
  const st = stations[idx];
  const offer = stationOffer(st);
  const holding = !!(keys['KeyF'] || keys['__use']) && offer.ok;
  if (holding) {
    stationHoldT += dt;
    if (stationHoldT >= CORE.BUY_HOLD) {
      stationHoldT = 0;
      purchase(st);
    }
  } else if (stationHoldT > 0) {
    stationHoldT = Math.max(0, stationHoldT - dt * 3);
  }
  const text = offer.price > 0
    ? offer.label + '  ·  ' + offer.price + ' CR'
    : offer.label;
  setBuyPrompt((offer.ok ? 'HOLD F — ' : '') + text, stationHoldT / CORE.BUY_HOLD, !offer.ok);
}

function usePlate() {
  if (plateT > 0) return;
  if (plates <= 0) { showCenterMsg('NO PLATES'); return; }
  if (player.armor >= CFG.player.armor) return;   // never burn a plate for nothing
  plateT = CORE.PLATE_TIME;
  playSound('reload_out');
}

// ---- Last stand -------------------------------------------------------------
let downT = 0;
function downPlayer() {
  const r = CORE.lethalOutcome(perks, player.downed);
  if (r.outcome === 'dead') { killPlayer(); return; }
  if (r.outcome === 'revive') {
    // Second Wind is spent, not kept: it answers exactly one mistake per run.
    perks.splice(perks.indexOf(r.consume), 1);
    player.health = CORE.DOWN_REVIVE_HEALTH;
    player.armor = 0;
    updateHudHealth();
    updateHudPerks();
    showCenterMsg('SECOND WIND');
    playSound('powerup');
    return;
  }
  player.downed = true;
  downT = 0;
  breakStreak();   // the streak is what going down costs you
  player.health = 1;
  player.crouching = true;
  player.sprinting = false;
  player.sliding = false;
  showCenterMsg('DOWN — HOLD OUT');
  playSound('hurt');
  updateHudHealth();
}

function updateDowned(dt) {
  if (!player.downed || player.dead) return;
  downT += dt;
  const left = CORE.bleedOutRemaining(downT);
  const el = $id('down-timer');
  if (el) {
    el.style.opacity = '1';
    el.textContent = 'BLEEDING OUT — ' + left.toFixed(1) + 's';
  }
  if (left <= 0) { clearDowned(); killPlayer(); }
}

// Clearing the wave is the other way out, wired from updateWaves().
function reviveFromDown() {
  if (!player.downed) return;
  clearDowned();
  player.health = CORE.DOWN_REVIVE_HEALTH;
  updateHudHealth();
  showCenterMsg('BACK IN THE FIGHT');
  playSound('powerup');
}

function clearDowned() {
  player.downed = false;
  downT = 0;
  const el = $id('down-timer');
  if (el) el.style.opacity = '0';
}

// ---- HUD --------------------------------------------------------------------
let _promptTxt = null;
function setBuyPrompt(text, fill, dim) {
  const el = $id('buy-prompt');
  if (!el) return;
  if (!text) {
    if (_promptTxt !== null) { el.style.opacity = '0'; _promptTxt = null; }
    return;
  }
  if (text !== _promptTxt) {
    $id('buy-prompt-txt').textContent = text;
    _promptTxt = text;
  }
  el.style.opacity = '1';
  el.style.color = dim ? 'rgba(255,255,255,.55)' : '#ffd24a';
  const bar = $id('buy-prompt-fill');
  if (bar) bar.style.width = Math.round(Math.min(1, Math.max(0, fill)) * 100) + '%';
}

function updateHudPlates() {
  const el = $id('plate-hud');
  if (!el) return;
  let s = '';
  for (let i = 0; i < CORE.PLATE_MAX; i++) s += '<i class="' + (i < plates ? 'on' : '') + '"></i>';
  el.innerHTML = s;
}

function updateHudPerks() {
  const el = $id('perk-hud');
  if (!el) return;
  let s = '';
  for (let i = 0; i < perks.length; i++) {
    const p = CORE.perkByKey(perks[i]);
    if (p) s += '<span title="' + p.name + '">' + p.short + '</span>';
  }
  el.innerHTML = s;
}

// ---- Bootstrap ---------------------------------------------------------------
// Built HERE and not from buildArena(), which would read better. Every module is
// concatenated into ONE script scope, and STATION_LAYOUT is a top-level `const` in
// this module — so a call from module 10 runs before this module's declarations
// and dies in the temporal dead zone with "Cannot access 'STATION_LAYOUT' before
// initialization". That is the ENG-05 hazard the audit logged, and it killed the
// whole file when it fired: one throw takes out every module after it.
//
// Queue the housings, flush them into the static batches, then rebuild the two
// indices that are derived from colliders[] — the ray broad-phase and the AI nav
// grid — because stations are solid and the AI has to path around them.
buildStations();
flushStaticBatches();
rebuildWorldRayGrid();
rebuildNavGrid();
