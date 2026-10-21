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
    actor.downed = false;
    actor.crouching = false;
    actor.sprinting = false;
    actor.sliding = false;
    actor.downedBy = null;
    actor.lastAttacker = null;
    if (actor.vel && typeof actor.vel.set === 'function') actor.vel.set(0, 0, 0);
    actor.health = (typeof CFG !== 'undefined' && CFG.player) ? CFG.player.health : 100;
    actor.spawnProtectionT = duration;
    if (typeof document !== 'undefined') {
      const ds = document.getElementById('death-screen');
      if (ds) ds.style.display = 'none';
    }
    if (typeof updateHudHealth === 'function') updateHudHealth();
    if (typeof updateHudAmmo === 'function') updateHudAmmo();
    if (typeof pointerLocked !== 'undefined' && !pointerLocked && typeof started !== 'undefined' && started && typeof paused !== 'undefined' && !paused) {
      if (typeof canvas !== 'undefined' && canvas && typeof canvas.requestPointerLock === 'function' && typeof isTouchDevice !== 'undefined' && !isTouchDevice) {
        try { canvas.requestPointerLock(); } catch (e) {}
      }
    }
  } else {
    if (pt && actor.pos) actor.pos.set(pt[0], 0, pt[1]);
    actor.dead = false;
    actor.health = actor.maxHealth || 100;
    actor.spawnProtectionT = duration;
    actor.state = 'idle';
    actor.stateT = 0;
    actor.attackT = 0;
    actor.target = null;
    if (actor.vel && typeof actor.vel.set === 'function') actor.vel.set(0, 0, 0);
    if (actor.parts && actor.parts.group) {
      if (actor.pos && actor.parts.group.position && typeof actor.parts.group.position.copy === 'function') {
        actor.parts.group.position.copy(actor.pos);
      }
      if (typeof scene !== 'undefined' && scene && scene.add && !actor.parts.group.parent) scene.add(actor.parts.group);
    }
    // Re-enter lexical enemies roster
    if (typeof enemies !== 'undefined' && Array.isArray(enemies)) {
      if (!enemies.includes(actor)) {
        enemies.push(actor);
      }
    }
  }
}

function updateModeRespawns(dt, spawnPoints, hostiles, colliders, onRespawn) {
  if (typeof paused !== 'undefined' && paused) return;
  const activeMode = typeof getActiveMode === 'function' ? getActiveMode() : null;
  if ((activeMode && typeof activeMode.isOver === 'function' && activeMode.isOver()) || (typeof gameEnded !== 'undefined' && gameEnded)) {
    clearModeRespawns();
    return;
  }
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
    if (typeof MODES !== 'undefined' && MODES.tdm && Array.isArray(MODES.tdm.roster)) MODES.tdm.roster.length = 0;
    if (typeof player !== 'undefined' && player) {
      player.lastAttacker = null;
      player.downedBy = null;
    }
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
  targetScore: 75,
  matchDuration: 600,
  friendlyScore: 0,
  enemyScore: 0,
  timeLeft: 600,
  teamSize: 6,
  roster: [],
  setup: function () {
    clearModeRespawns();
    this.roster = [];
    if (typeof getSetting === 'function') {
      const sl = getSetting('tdmScoreLimit');
      if (typeof sl === 'number' && sl > 0) this.targetScore = sl;
      const ts = getSetting('tdmTeamSize');
      if (typeof ts === 'number' && ts > 0) this.teamSize = ts;
    }
    this.friendlyScore = 0;
    this.enemyScore = 0;
    this.timeLeft = this.matchDuration;
    if (typeof gameEnded !== 'undefined') gameEnded = false;
    const p = (typeof player !== 'undefined') ? player : null;
    if (p) {
      p.team = 'friendly';
      p.isPlayer = true;
      p.kills = 0;
      p.deaths = 0;
      p.downed = false;
      p.downedBy = null;
      p.lastAttacker = null;
      p.spawnProtectionT = (typeof CORE !== 'undefined' && CORE.SPAWN_PROTECTION_DURATION) ? CORE.SPAWN_PROTECTION_DURATION : 2.0;
      this.roster.push(p);
    }
    // Production 6v6 setup: player + (teamSize - 1) friendly bots vs teamSize enemy bots
    const count = this.teamSize || 6;
    const sp = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : ((typeof spawnPoints !== 'undefined' && Array.isArray(spawnPoints)) ? spawnPoints : []);
    const getSpawnPt = function (idx) {
      if (sp && sp.length > 0) return sp[idx % sp.length];
      return [(idx % 4) * 6 - 9, ((idx / 4) | 0) * 6 + 10];
    };
    if (typeof spawnEnemy === 'function') {
      for (let i = 0; i < count - 1; i++) {
        const pt = getSpawnPt(i);
        const kind = (i % 3 === 0) ? 1 : ((i % 3 === 1) ? 2 : 0);
        const bot = spawnEnemy(kind, pt[0], pt[1], { team: 'friendly', spawnProtection: true });
        if (bot) {
          bot.id = 'ally_' + (i + 1);
          bot.name = 'ALLY ' + (i + 1);
          bot.kills = 0;
          bot.deaths = 0;
          this.roster.push(bot);
        }
      }
      for (let i = 0; i < count; i++) {
        const pt = getSpawnPt(i + count);
        const kind = (i % 3 === 0) ? 1 : ((i % 3 === 1) ? 2 : 0);
        const bot = spawnEnemy(kind, pt[0], pt[1], { team: 'enemy', spawnProtection: true });
        if (bot) {
          bot.id = 'enemy_' + (i + 1);
          bot.name = 'HOSTILE ' + (i + 1);
          bot.kills = 0;
          bot.deaths = 0;
          this.roster.push(bot);
        }
      }
    }
    if (typeof document !== 'undefined') {
      const endScreen = document.getElementById('match-end-screen');
      if (endScreen) endScreen.style.display = 'none';
      const deathScreen = document.getElementById('death-screen');
      if (deathScreen) deathScreen.style.display = 'none';
    }
    updateMatchHud(this);
  },
  onKill: function (victim, isHead, killer) {
    if (victim) victim.deaths = (victim.deaths || 0) + 1;
    const p = (typeof player !== 'undefined') ? player : null;
    const isPlayerKiller = !!(killer && (killer.isPlayer || killer === p));
    const isPlayerVictim = !!(victim && (victim.isPlayer || victim === p));
    const victimTeam = (victim && victim.team) ? victim.team : (isPlayerVictim ? 'friendly' : 'enemy');
    const killerTeam = (killer && killer.team) ? killer.team : (isPlayerKiller ? 'friendly' : null);
    const isSelfKill = !!(killer && victim && (killer === victim || (isPlayerKiller && isPlayerVictim) || (killer.id && victim.id && killer.id === victim.id)));
    const isHostileKill = killer && !isSelfKill && killerTeam && (killerTeam !== victimTeam);

    if (isHostileKill) {
      killer.kills = (killer.kills || 0) + 1;
      if (killerTeam === 'friendly') {
        this.friendlyScore++;
      } else if (killerTeam === 'enemy') {
        this.enemyScore++;
      }
    }

    if (typeof pushKillfeed === 'function') {
      const killerName = isPlayerKiller ? 'YOU' : ((killer && killer.name) ? killer.name : ((killerTeam === 'friendly') ? 'ALLY BOT' : 'HOSTILE BOT'));
      const victimName = isPlayerVictim ? 'YOU' : ((victim && victim.name) ? victim.name : ((victimTeam === 'friendly') ? 'ALLY BOT' : 'HOSTILE BOT'));
      if (isHostileKill) {
        const color = (killerTeam === 'friendly') ? '#38b6ff' : '#ff4030';
        pushKillfeed('<span style="color:' + color + '">' + killerName + '</span> eliminated ' + victimName + (isHead ? ' (HEADSHOT)' : ''));
      } else if (isSelfKill) {
        pushKillfeed('<span style="color:#ffdf8a">' + victimName + '</span> eliminated themselves');
      } else {
        pushKillfeed('<span style="color:#ffdf8a">' + victimName + '</span> died');
      }
    }
    updateMatchHud(this);
    if (this.isOver()) {
      this.endMatch();
    }
  },
  onDeath: function (victim, killer) {
    if (this.isOver() || (typeof gameEnded !== 'undefined' && gameEnded)) return;
    if (victim) {
      queueModeRespawn(victim, (typeof CORE !== 'undefined' && CORE.RESPAWN_DELAY) ? CORE.RESPAWN_DELAY : 3.0);
    }
  },
  update: function (dt) {
    if (typeof paused !== 'undefined' && paused) return;
    if (this.isOver()) {
      if (typeof gameEnded !== 'undefined' && !gameEnded) this.endMatch();
      return;
    }
    if (this.timeLeft > 0) {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
    }
    const sp = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : (typeof spawnPoints !== 'undefined' ? spawnPoints : []);
    const hostiles = (typeof enemies !== 'undefined') ? enemies : [];
    const cols = (typeof colliders !== 'undefined') ? colliders : [];
    updateModeRespawns(dt, sp, hostiles, cols);
    updateMatchHud(this);
    if (this.isOver()) {
      this.endMatch();
    }
  },
  scoreboard: function () {
    const p = (typeof player !== 'undefined') ? player : null;
    const rosterList = (Array.isArray(this.roster) && this.roster.length > 0)
      ? this.roster
      : (p ? [p, ...(typeof enemies !== 'undefined' && Array.isArray(enemies) ? enemies : [])] : (typeof enemies !== 'undefined' && Array.isArray(enemies) ? enemies : []));
    const friendlyMembers = [];
    const enemyMembers = [];
    const seenIds = new Set();
    for (let i = 0; i < rosterList.length; i++) {
      const actor = rosterList[i];
      if (!actor) continue;
      const isYou = !!(actor.isPlayer || actor === p);
      const actorId = isYou ? 'player' : (actor.id || ('bot_' + i));
      if (seenIds.has(actorId)) continue;
      seenIds.add(actorId);
      const entry = {
        id: actorId,
        name: isYou ? 'YOU' : (actor.name || (actor.team === 'friendly' ? ('ALLY BOT ' + (i + 1)) : ('HOSTILE BOT ' + (i + 1)))),
        isPlayer: isYou,
        team: isYou ? 'friendly' : (actor.team || 'enemy'),
        kills: isYou ? (actor.kills || (typeof kills !== 'undefined' ? kills : 0)) : (actor.kills || 0),
        deaths: actor.deaths || 0
      };
      if (entry.team === 'friendly') friendlyMembers.push(entry);
      else enemyMembers.push(entry);
    }
    friendlyMembers.sort(function (a, b) { return b.kills - a.kills; });
    enemyMembers.sort(function (a, b) { return b.kills - a.kills; });
    return {
      mode: 'tdm',
      friendlyScore: this.friendlyScore,
      enemyScore: this.enemyScore,
      targetScore: this.targetScore,
      timeLeft: this.timeLeft,
      friendlyTeam: { name: 'FRIENDLY', score: this.friendlyScore, members: friendlyMembers },
      enemyTeam: { name: 'ENEMY', score: this.enemyScore, members: enemyMembers }
    };
  },
  isOver: function () {
    return (this.friendlyScore >= this.targetScore) || (this.enemyScore >= this.targetScore) || (this.timeLeft <= 0);
  },
  endMatch: function () {
    if (typeof gameEnded !== 'undefined') gameEnded = true;
    clearModeRespawns();
    if (typeof showMatchEndScreen === 'function') showMatchEndScreen(this);
  }
};
