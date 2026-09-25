// ============ SUPPLY DROPS: PERKS BETWEEN WAVES ============
'use strict';
// After waves 2, 5, 8, 11 and 14 a supply drop offers three random upgrades.
// The between-wave countdown is frozen while the choice is open.
const PERKS = [
  { id: 'fastHands', name: 'QUICKDRAW', desc: 'Reload 30% faster · weapon swap 40% faster', icon: '⟳' },
  { id: 'extMags', name: 'EXTENDED MAGS', desc: '+35% magazine capacity on every weapon', icon: '▮' },
  { id: 'hollow', name: 'HOLLOW POINTS', desc: '+15% bullet damage', icon: '✸' },
  { id: 'plates', name: 'CERAMIC PLATES', desc: '+50% max armor, refilled now', icon: '⛨' },
  { id: 'stim', name: 'STIM REGEN', desc: 'Health regen starts 40% sooner, 60% faster', icon: '✚' },
  { id: 'grenadier', name: 'GRENADIER', desc: '+1 frag capacity, refilled now', icon: '●' },
  { id: 'marathon', name: 'MARATHON', desc: '+50% stamina · +7% move speed', icon: '»' },
  { id: 'steady', name: 'STEADY AIM', desc: '-25% spread and recoil', icon: '⌖' },
  { id: 'scavenger', name: 'SCAVENGER', desc: '+60% ammo / medkit drop chance', icon: '⚑' },
  { id: 'blastShield', name: 'BLAST SHIELD', desc: '-50% damage from explosions and fire', icon: '◈' },
  { id: 'armory', name: 'ARMORY', desc: 'Swap your sidearm for a second primary', icon: '⚔' }
];
const ownedPerks = Object.create(null);
function hasPerk(id) { return !!ownedPerks[id]; }
// Multipliers consumed across the game code.
function perkMul(kind) {
  switch (kind) {
    case 'move': return hasPerk('marathon') ? 1.07 : 1;
    case 'stamina': return hasPerk('marathon') ? 1.5 : 1;
    case 'regen': return hasPerk('stim') ? 1.6 : 1;
    case 'regenDelay': return hasPerk('stim') ? 0.6 : 1;
    case 'reload': return hasPerk('fastHands') ? 0.7 : 1;       // time multiplier
    case 'swap': return hasPerk('fastHands') ? 1.4 : 1;         // speed multiplier
    case 'mag': return hasPerk('extMags') ? 1.35 : 1;
    case 'damage': return hasPerk('hollow') ? 1.15 : 1;
    case 'spread': return hasPerk('steady') ? 0.75 : 1;
    case 'recoil': return hasPerk('steady') ? 0.75 : 1;
    case 'armor': return hasPerk('plates') ? 1.5 : 1;
    case 'drops': return hasPerk('scavenger') ? 1.6 : 1;
    case 'blast': return hasPerk('blastShield') ? 0.5 : 1;
  }
  return 1;
}
function maxArmor() { return CFG.player.armor * perkMul('armor'); }
function maxGrenades() { return CFG.grenade.count + (hasPerk('grenadier') ? 1 : 0); }

let perkOpen = false, perkChoices = [];
function perkMenuOpen() { return perkOpen; }
function perkWaveDue(n) { return n >= 2 && (n - 2) % 3 === 0 && n < CFG.wave.victoryWave; }
const perkEl = (function () {
  const el = document.createElement('div');
  el.id = 'perk-menu';
  el.innerHTML = '<h2>SUPPLY DROP</h2><div class="perk-sub">Choose one upgrade · keys 1 / 2 / 3</div><div id="perk-cards"></div>';
  document.body.appendChild(el);
  return el;
})();
function openPerkMenu() {
  const pool = PERKS.filter(function (p) {
    if (ownedPerks[p.id]) return false;
    if (p.id === 'armory' && !CFG.weapons[weaponsOwned[SIDE_SLOT]].sidearm) return false;
    return true;
  });
  if (!pool.length) return false;
  perkChoices = [];
  while (perkChoices.length < 3 && pool.length) perkChoices.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const armoryGun = armoryWeapon();
  const wrap = $id('perk-cards');
  wrap.innerHTML = '';
  perkChoices.forEach(function (p, i) {
    const card = document.createElement('div');
    card.className = 'perk-card';
    enableMenuKeyboard(card);
    const desc = p.id === 'armory' && armoryGun >= 0 ? 'Swap your sidearm for the ' + CFG.weapons[armoryGun].name : p.desc;
    card.innerHTML = '<div class="pk-key">' + (i + 1) + '</div><div class="pk-icon">' + p.icon + '</div><div class="pk-name">' + p.name + '</div><div class="pk-desc">' + desc + '</div>';
    card.addEventListener('click', function () { pickPerk(i); });
    wrap.appendChild(card);
  });
  perkOpen = true;
  mouse1Down = false; clearInputState();
  if (typeof cancelGrenadeCharge === 'function') cancelGrenadeCharge();
  perkEl.style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
  playSound('perk');
  const first = wrap.querySelector('.perk-card');
  if (first && lastInputDevice === 'pad') first.focus();
  return true;
}
function armoryWeapon() {
  const options = [];
  for (let i = 0; i < CFG.weapons.length; i++) if (!CFG.weapons[i].sidearm && !CFG.weapons[i].carried && i !== weaponsOwned[0]) options.push(i);
  if (!options.length) return -1;
  if (armoryWeapon.pick === undefined || options.indexOf(armoryWeapon.pick) < 0) armoryWeapon.pick = options[Math.floor(Math.random() * options.length)];
  return armoryWeapon.pick;
}
function pickPerk(i) {
  if (!perkOpen || !perkChoices[i]) return;
  const p = perkChoices[i];
  ownedPerks[p.id] = true;
  if (p.id === 'plates') player.armor = maxArmor();
  if (p.id === 'grenadier') grenades.count = maxGrenades();
  if (p.id === 'armory') {
    const gi = armoryWeapon();
    if (gi >= 0) {
      weaponsOwned[SIDE_SLOT] = gi;
      wState[SIDE_SLOT] = newWeaponState(CFG.weapons[gi]);
      if (curWeapon === SIDE_SLOT) { buildViewmodel(); }
    }
    armoryWeapon.pick = undefined;
  }
  // magazine perk applies immediately to the loaded mags
  if (p.id === 'extMags') for (let s = 0; s < wState.length; s++) if (wState[s]) wState[s].ammo = Math.min(magSize(CFG.weapons[weaponsOwned[s]]), Math.round(wState[s].ammo * 1.35));
  perkOpen = false;
  perkEl.style.display = 'none';
  addScore(0, 'SUPPLY: ' + p.name);
  updatePerkHud(); updateHudAmmo(); updateHudHealth();
  playSound('pickup_med');
  lockPointer();
}
addEventListener('keydown', function (e) {
  if (!perkOpen) return;
  const k = e.code === 'Digit1' ? 0 : e.code === 'Digit2' ? 1 : e.code === 'Digit3' ? 2 : -1;
  if (k >= 0) { e.preventDefault(); pickPerk(k); }
});
function updatePerkHud() {
  let el = $id('perk-hud');
  if (!el) { el = document.createElement('div'); el.id = 'perk-hud'; el.className = 'hud'; document.body.appendChild(el); }
  el.innerHTML = PERKS.filter(function (p) { return ownedPerks[p.id]; }).map(function (p) { return '<span title="' + p.name + '">' + p.icon + '</span>'; }).join('');
}
function resetPerks() {
  for (const k in ownedPerks) delete ownedPerks[k];
  perkOpen = false; perkEl.style.display = 'none';
  armoryWeapon.pick = undefined;
  updatePerkHud();
}
