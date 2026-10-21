// ============ GAME MODES REGISTRY & FRAMEWORK ============
'use strict';

var MODES = Object.create(null);
var activeModeId = 'survival';

function registerMode(id, def) {
  if (id && def) MODES[id] = def;
}

function getActiveMode() {
  return MODES[activeModeId] || MODES.survival;
}

function setActiveMode(id) {
  if (MODES[id]) activeModeId = id;
}

var modeRespawnQueue = [];

function queueModeRespawn(actor, timer) {
  if (actor) {
    modeRespawnQueue.push({
      actor: actor,
      timer: (typeof timer === 'number') ? timer : (typeof CORE !== 'undefined' ? CORE.RESPAWN_DELAY : 3.0)
    });
  }
}

function clearModeRespawns() {
  modeRespawnQueue.length = 0;
}

function updateModeRespawns(dt, spawnPoints, hostiles, colliders, onRespawn) {
  if (modeRespawnQueue.length === 0) return;
  for (let i = modeRespawnQueue.length - 1; i >= 0; i--) {
    const entry = modeRespawnQueue[i];
    entry.timer = (typeof CORE !== 'undefined' && typeof CORE.stepRespawnTimer === 'function')
      ? CORE.stepRespawnTimer(entry.timer, dt)
      : Math.max(0, entry.timer - dt);
    const ready = (typeof CORE !== 'undefined' && typeof CORE.canRespawn === 'function')
      ? CORE.canRespawn(entry.timer)
      : (entry.timer <= 0);
    if (ready) {
      modeRespawnQueue.splice(i, 1);
      const pt = (typeof CORE !== 'undefined' && typeof CORE.pickBestSpawnPoint === 'function')
        ? CORE.pickBestSpawnPoint(spawnPoints, hostiles, colliders)
        : (spawnPoints && spawnPoints[0] ? spawnPoints[0] : null);
      if (typeof onRespawn === 'function') {
        onRespawn(entry.actor, pt);
      }
    }
  }
}

// Survival mode implementation: wraps wave management and survival lifecycle behind the MODES contract
MODES.survival = {
  id: 'survival',
  name: 'Survival',
  setup: function () {
    clearModeRespawns();
    if (typeof waveNum !== 'undefined') waveNum = 0;
    if (typeof waveQueue !== 'undefined') waveQueue = 0;
    if (typeof waveActive !== 'undefined') waveActive = false;
    if (typeof betweenWaveT !== 'undefined') {
      betweenWaveT = (typeof CFG !== 'undefined' && CFG.wave && CFG.wave.startDelay) ? CFG.wave.startDelay : 3;
    }
    if (typeof gameEnded !== 'undefined') gameEnded = false;
  },
  onKill: function (victim, isHead, killer) {
    // Survival kill event hook: score, credits, streaks and drop rules remain centralized in killEnemy
  },
  onDeath: function (victim, killer) {
    // Survival death event hook: player death lifecycle
  },
  update: function (dt) {
    if (typeof updateWaves === 'function') updateWaves(dt);
  },
  scoreboard: function () {
    return CORE.modeScoreboardData('survival', {
      wave: typeof waveNum !== 'undefined' ? waveNum : 0,
      score: typeof score !== 'undefined' ? score : 0,
      kills: typeof kills !== 'undefined' ? kills : 0,
      headshots: typeof headshots !== 'undefined' ? headshots : 0,
      credits: typeof credits !== 'undefined' ? credits : 0
    });
  },
  isOver: function () {
    return CORE.isModeOver('survival', {
      gameEnded: typeof gameEnded !== 'undefined' ? !!gameEnded : false,
      playerDead: (typeof player !== 'undefined' && player) ? !!player.dead : false,
      playerDowned: (typeof player !== 'undefined' && player) ? !!player.downed : false
    });
  }
};
