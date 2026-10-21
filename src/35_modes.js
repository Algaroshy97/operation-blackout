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

function updateMatchHud(mode) {
  if (typeof document === 'undefined') return;
  const matchHud = (typeof $id === 'function') ? $id('match-hud') : document.getElementById('match-hud');
  const waveHud = (typeof $id === 'function') ? $id('wave-hud') : document.getElementById('wave-hud');
  if (!matchHud) return;
  if (!mode || mode.id !== 'tdm') {
    matchHud.style.display = 'none';
    if (waveHud) waveHud.style.display = '';
    return;
  }
  matchHud.style.display = 'block';
  if (waveHud) waveHud.style.display = 'none';
  const timerEl = (typeof $id === 'function') ? $id('match-timer') : document.getElementById('match-timer');
  const fScoreEl = (typeof $id === 'function') ? $id('match-score-friendly') : document.getElementById('match-score-friendly');
  const eScoreEl = (typeof $id === 'function') ? $id('match-score-enemy') : document.getElementById('match-score-enemy');
  if (timerEl) {
    const t = Math.max(0, mode.timeLeft || 0);
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    timerEl.textContent = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
  }
  if (fScoreEl) fScoreEl.textContent = String(mode.friendlyScore || 0);
  if (eScoreEl) eScoreEl.textContent = String(mode.enemyScore || 0);
}

function setActiveMode(id) {
  if (MODES[id]) {
    activeModeId = id;
    updateMatchHud(MODES[id]);
  }
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

function defaultOnRespawn(actor, pt) {
  if (!actor) return;
  const duration = (typeof CORE !== 'undefined' && CORE.SPAWN_PROTECTION_DURATION) ? CORE.SPAWN_PROTECTION_DURATION : 2.0;
  if (actor.isPlayer) {
    if (pt && actor.pos) actor.pos.set(pt[0], (typeof CFG !== 'undefined' && CFG.player) ? CFG.player.height : 1.7, pt[1]);
    actor.dead = false;
    actor.health = (typeof CFG !== 'undefined' && CFG.player) ? CFG.player.health : 100;
    actor.spawnProtectionT = duration;
  } else {
    if (pt && actor.pos) actor.pos.set(pt[0], 0, pt[1]);
    actor.dead = false;
    actor.health = actor.maxHealth || 100;
    actor.spawnProtectionT = duration;
    if (actor.parts && actor.parts.group) {
      if (actor.pos) actor.parts.group.position.copy(actor.pos);
      if (typeof scene !== 'undefined' && scene.add && !actor.parts.group.parent) scene.add(actor.parts.group);
    }
  }
}

function updateModeRespawns(dt, spawnPoints, hostiles, colliders, onRespawn) {
  if (modeRespawnQueue.length === 0) return;
  const cb = (typeof onRespawn === 'function') ? onRespawn : defaultOnRespawn;
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
      cb(entry.actor, pt);
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
    updateMatchHud(this);
  },
  onKill: function (victim, isHead, killer) {
    // Survival kill event hook: score, credits, streaks and drop rules remain centralized in killEnemy
  },
  onDeath: function (victim, killer) {
    if (victim && victim.team === 'friendly' && !victim.isPlayer) {
      queueModeRespawn(victim, (typeof CORE !== 'undefined' && CORE.RESPAWN_DELAY) ? CORE.RESPAWN_DELAY : 3.0);
    }
  },
  update: function (dt) {
    if (typeof updateWaves === 'function') updateWaves(dt);
    if (typeof updateModeRespawns === 'function') {
      const sp = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : (typeof spawnPoints !== 'undefined' ? spawnPoints : []);
      const hostiles = (typeof enemies !== 'undefined') ? enemies : [];
      const cols = (typeof colliders !== 'undefined') ? colliders : [];
      updateModeRespawns(dt, sp, hostiles, cols);
    }
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

MODES.tdm = {
  id: 'tdm',
  name: 'Team Deathmatch',
  targetScore: 25,
  matchDuration: 300,
  friendlyScore: 0,
  enemyScore: 0,
  timeLeft: 300,
  setup: function () {
    clearModeRespawns();
    this.friendlyScore = 0;
    this.enemyScore = 0;
    this.timeLeft = this.matchDuration;
    if (typeof gameEnded !== 'undefined') gameEnded = false;
    updateMatchHud(this);
  },
  onKill: function (victim, isHead, killer) {
    const killerTeam = (killer && killer.team) ? killer.team : ((killer && (killer.isPlayer || killer === (typeof player !== 'undefined' ? player : null))) ? 'friendly' : 'enemy');
    if (killerTeam === 'friendly') {
      this.friendlyScore++;
    } else {
      this.enemyScore++;
    }
    if (typeof pushKillfeed === 'function') {
      const killerName = (killer && (killer.isPlayer || killer === (typeof player !== 'undefined' ? player : null))) ? 'YOU' : ((killerTeam === 'friendly') ? 'ALLY BOT' : 'HOSTILE BOT');
      const victimName = (victim && (victim.isPlayer || victim === (typeof player !== 'undefined' ? player : null))) ? 'YOU' : ((victim && victim.team === 'friendly') ? 'ALLY BOT' : 'HOSTILE BOT');
      const color = (killerTeam === 'friendly') ? '#38b6ff' : '#ff4030';
      pushKillfeed('<span style="color:' + color + '">' + killerName + '</span> eliminated ' + victimName + (isHead ? ' (HEADSHOT)' : ''));
    }
    updateMatchHud(this);
    if (this.isOver() && typeof gameEnded !== 'undefined') {
      gameEnded = true;
    }
  },
  onDeath: function (victim, killer) {
    if (victim) {
      queueModeRespawn(victim, (typeof CORE !== 'undefined' && CORE.RESPAWN_DELAY) ? CORE.RESPAWN_DELAY : 3.0);
    }
  },
  update: function (dt) {
    if (this.timeLeft > 0) {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
    }
    const sp = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : (typeof spawnPoints !== 'undefined' ? spawnPoints : []);
    const hostiles = (typeof enemies !== 'undefined') ? enemies : [];
    const cols = (typeof colliders !== 'undefined') ? colliders : [];
    updateModeRespawns(dt, sp, hostiles, cols);
    updateMatchHud(this);
    if (this.isOver() && typeof gameEnded !== 'undefined') {
      gameEnded = true;
    }
  },
  scoreboard: function () {
    return CORE.modeScoreboardData('tdm', {
      friendlyScore: this.friendlyScore,
      enemyScore: this.enemyScore,
      targetScore: this.targetScore,
      timeLeft: this.timeLeft,
      score: typeof score !== 'undefined' ? score : 0,
      kills: typeof kills !== 'undefined' ? kills : 0,
      headshots: typeof headshots !== 'undefined' ? headshots : 0
    });
  },
  isOver: function () {
    return CORE.isModeOver('tdm', {
      friendlyScore: this.friendlyScore,
      enemyScore: this.enemyScore,
      targetScore: this.targetScore,
      timeLeft: this.timeLeft,
      gameEnded: typeof gameEnded !== 'undefined' ? !!gameEnded : false
    });
  }
};
