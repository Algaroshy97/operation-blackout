// ============ GAME MODES REGISTRY & FRAMEWORK ============
'use strict';

var MODES = Object.create(null);
// Every match-mode id the registry can restore from persisted settings.
var MATCH_MODE_IDS = (typeof CORE !== 'undefined' && CORE.MATCH_MODE_IDS) ? CORE.MATCH_MODE_IDS : ['tdm', 'ffa', 'domination', 'gun-game'];

function isKnownModeId(id) {
  return id === 'survival' || MATCH_MODE_IDS.indexOf(id) >= 0;
}

// A match mode is any registered mode that is not the Survival run. The shared
// HUD, settlement and scoreboard code keys off this instead of one hard-coded id.
function isMatchMode(mode) {
  return !!(mode && mode.id && mode.id !== 'survival');
}

// Single settlement answer for freezing combat: an explicitly ended match, or a
// match mode whose own win condition is met. Survival keeps its own lifecycle.
function matchSettled() {
  if (typeof gameEnded !== 'undefined' && gameEnded) return true;
  const active = (typeof getActiveMode === 'function') ? getActiveMode() : null;
  if (!isMatchMode(active)) return false;
  return (typeof active.isOver === 'function') ? !!active.isOver() : false;
}

function matchHudView(mode) {
  if (!isMatchMode(mode)) return null;
  if (typeof mode.hudModel === 'function') return mode.hudModel();
  return {
    time: (typeof mode.timeLeft === 'number') ? mode.timeLeft : 0,
    left: mode.friendlyScore || 0,
    right: mode.enemyScore || 0,
    note: ''
  };
}

// Deployment options are read through one clamped accessor so a stub or a saved
// value outside the schema range can never inflate a match budget.
function modeSettingNum(key, fallback, min, max) {
  if (typeof getSetting !== 'function') return fallback;
  const v = getSetting(key);
  if (typeof v !== 'number' || !isFinite(v) || v < min || v > max) return fallback;
  return v;
}

var activeModeId = (typeof getSetting === 'function' && isKnownModeId(getSetting('gameMode')))
  ? getSetting('gameMode')
  : 'survival';

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
  const view = matchHudView(mode);
  if (!view) {
    matchHud.style.display = 'none';
    if (waveHud) waveHud.style.display = '';
    return;
  }
  matchHud.style.display = 'block';
  if (waveHud) waveHud.style.display = 'none';
  const timerEl = (typeof $id === 'function') ? $id('match-timer') : document.getElementById('match-timer');
  const fScoreEl = (typeof $id === 'function') ? $id('match-score-friendly') : document.getElementById('match-score-friendly');
  const eScoreEl = (typeof $id === 'function') ? $id('match-score-enemy') : document.getElementById('match-score-enemy');
  const noteEl = (typeof $id === 'function') ? $id('match-hud-note') : document.getElementById('match-hud-note');
  if (timerEl) {
    const t = Math.max(0, view.time || 0);
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    timerEl.textContent = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
  }
  if (fScoreEl) fScoreEl.textContent = String(view.left);
  if (eScoreEl) eScoreEl.textContent = String(view.right);
  if (noteEl) noteEl.textContent = String(view.note || '');
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

function rebuildEnemyRig(actor) {
  if (!actor) return;
  let hasRagdoll = false;
  if (typeof ragdolls !== 'undefined' && Array.isArray(ragdolls)) {
    for (let i = 0; i < ragdolls.length; i++) {
      const rd = ragdolls[i];
      if (rd && (rd.en === actor || (rd.sd && rd.sd.en === actor))) {
        if (!rd.retiredParts && actor.parts) {
          rd.retiredParts = actor.parts;
        }
        rd.en = null;
        if (rd.sd) rd.sd.en = null;
        hasRagdoll = true;
      }
    }
  }
  const isSoldier = (actor.soldier !== undefined) ? !!actor.soldier : !!(actor.parts && actor.parts.soldier);
  actor.soldier = isSoldier;
  const isEmptied = isSoldier && (
    !actor.parts.group ||
    actor.parts.group.children.length === 0 ||
    !actor.hitBody ||
    !actor.parts.group.getObjectByName('hitBody')
  );
  const wasRagdolled = !!(actor.parts && (actor.parts._ragdolled || actor.parts._geometryDisposed));
  if (!hasRagdoll && !isEmptied && !wasRagdolled) {
    return;
  }
  if (actor.parts && actor.parts.group && actor.parts.group.parent) {
    actor.parts.group.parent.remove(actor.parts.group);
  }
  const kind = (actor.kind !== undefined) ? actor.kind : 0;
  const team = actor.team || 'enemy';
  let newParts = null;
  if (isSoldier && typeof buildSoldier === 'function') {
    const sd = buildSoldier(kind, team);
    if (sd) {
      newParts = {
        group: sd.group,
        body: sd.group,
        J: sd.J,
        hitBody: sd.hitBody,
        hitHead: sd.hitHead,
        hitLegs: sd.hitLegs,
        soldier: true,
        iff: sd.iff,
        gun: sd.gun
      };
    }
  }
  if (!newParts && typeof makeEnemyMesh === 'function') {
    newParts = makeEnemyMesh(kind, team);
  }
  if (newParts) {
    const scale = (typeof CORE !== 'undefined' && typeof CORE.enemyScale === 'function') ? CORE.enemyScale(kind) : 1;
    if (newParts.group && newParts.group.scale && typeof newParts.group.scale.set === 'function') {
      newParts.group.scale.set(scale, scale, scale);
    }
    const KIND_TINT = { 3: 0x4a6fa5, 4: 0x8fd66a, 5: 0xd6a24a, 6: 0xb83a30 };
    if (KIND_TINT[kind] !== undefined && !newParts.soldier && newParts.group) {
      if (typeof THREE !== 'undefined' && THREE.Color) {
        const tint = new THREE.Color(KIND_TINT[kind]);
        newParts.group.traverse(function (o) {
          if (o.isMesh && o !== newParts.hitBody && o !== newParts.hitHead && o.material) {
            o.material = o.material.clone();
            if (o.material.color && typeof o.material.color.lerp === 'function') {
              o.material.color.lerp(tint, 0.55);
            } else if (o.material.color) {
              o.material.color.copy(tint);
            }
            o.userData.clonedTint = true;
          }
        });
      }
    }
    actor.parts = newParts;
    actor.hitBody = newParts.hitBody;
    actor.hitHead = newParts.hitHead;
    if (newParts.hitBody) newParts.hitBody.userData = { enemyRef: actor, isHead: false };
    if (newParts.hitHead) newParts.hitHead.userData = { enemyRef: actor, isHead: true };
    if (newParts.hitLegs) newParts.hitLegs.userData = { enemyRef: actor, isHead: false, isLegs: true };
  }
}

function getHostilesForActor(actor, candidateList, livePlayer) {
  const actorTeam = (actor && actor.team) ? actor.team : (actor && actor.isPlayer ? 'friendly' : 'enemy');
  const result = [];
  const p = livePlayer !== undefined ? livePlayer : (typeof player !== 'undefined' ? player : null);
  if (p && !p.dead && p !== actor) {
    const pTeam = p.team || 'friendly';
    if (pTeam !== actorTeam) {
      result.push(p);
    }
  }
  const list = candidateList || (typeof enemies !== 'undefined' ? enemies : []);
  for (let j = 0; j < list.length; j++) {
    const act = list[j];
    if (!act || act.dead || act === actor || act === p) continue;
    const actTeam = act.team || (act.isPlayer ? 'friendly' : 'enemy');
    if (actTeam !== actorTeam) {
      result.push(act);
    }
  }
  return result;
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
    // Nonterminal respawns keep the match soundtrack alive; restore it if it went silent.
    if (typeof ensureMusicPlaying === 'function') ensureMusicPlaying();
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
    rebuildEnemyRig(actor);
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
      const actorHostiles = getHostilesForActor(entry.actor, hostiles);
      const pt = (typeof CORE !== 'undefined' && typeof CORE.pickBestSpawnPoint === 'function')
        ? CORE.pickBestSpawnPoint(spawnPoints, actorHostiles, colliders)
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
    this._ended = false;
    this._settled = false;
    if (Array.isArray(this.roster)) {
      for (let i = 0; i < this.roster.length; i++) {
        const act = this.roster[i];
        if (act && !act.isPlayer) {
          if (act.parts && act.parts.group && typeof scene !== 'undefined' && scene && scene.remove) {
            scene.remove(act.parts.group);
          }
          if (typeof disposeEnemyGeometry === 'function') disposeEnemyGeometry(act);
        }
      }
    }
    if (typeof enemies !== 'undefined' && Array.isArray(enemies)) {
      for (let i = enemies.length - 1; i >= 0; i--) {
        const en = enemies[i];
        if (en && (en.team === 'friendly' || (this.roster && this.roster.includes(en)))) {
          if (en.parts && en.parts.group && typeof scene !== 'undefined' && scene && scene.remove) {
            scene.remove(en.parts.group);
          }
          if (typeof disposeEnemyGeometry === 'function') disposeEnemyGeometry(en);
          enemies.splice(i, 1);
        }
      }
    }
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
    if (this._settled || (typeof gameEnded !== 'undefined' && gameEnded) || this.isOver()) return;
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
    if (this._ended) return;
    this._ended = true;
    this._settled = true;
    if (typeof gameEnded !== 'undefined') gameEnded = true;
    clearModeRespawns();
    if (typeof showMatchEndScreen === 'function') showMatchEndScreen(this);
  }
};


// ============ SHARED MATCH-ROSTER HELPERS (FFA / DOMINATION / GUN GAME) ============
// One purge and one spawner keep every non-Survival mode honest about resource
// ownership: actors are disposed and removed from the live AI roster, and the match
// roster is rebuilt from scratch, so a restart can never duplicate bots.
function purgeMatchBots(mode, prefix) {
  if (!mode) return;
  const roster = Array.isArray(mode.roster) ? mode.roster : [];
  for (let i = 0; i < roster.length; i++) {
    const act = roster[i];
    if (act && !act.isPlayer) {
      if (act.parts && act.parts.group && typeof scene !== 'undefined' && scene && scene.remove) scene.remove(act.parts.group);
      if (typeof disposeEnemyGeometry === 'function') disposeEnemyGeometry(act);
    }
  }
  if (typeof enemies !== 'undefined' && Array.isArray(enemies)) {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const en = enemies[i];
      if (!en) continue;
      const inRoster = roster.indexOf(en) >= 0;
      const prefixed = prefix && typeof en.team === 'string' && en.team.indexOf(prefix) === 0;
      const strayFriendly = (!prefix && en.team === 'friendly') || (typeof en.team === 'string' && en.team.indexOf('ffa_') === 0);
      if (inRoster || prefixed || strayFriendly) {
        if (en.parts && en.parts.group && typeof scene !== 'undefined' && scene && scene.remove) scene.remove(en.parts.group);
        if (typeof disposeEnemyGeometry === 'function') disposeEnemyGeometry(en);
        enemies.splice(i, 1);
      }
    }
  }
  mode.roster = [];
}

// Leaving a match must not leave match bots in the live AI roster, whichever mode
// was running. Kept as a single brace-free call site for quitMatchToMenu.
function clearAllMatchRosters() {
  if (typeof MODES === 'undefined') return;
  for (const id in MODES) {
    const m = MODES[id];
    if (!m || !Array.isArray(m.roster) || m.roster.length === 0) continue;
    purgeMatchBots(m, null);
  }
}

function matchSpawnPointAt(idx) {
  const sp = (typeof openSpawnPoints === 'function') ? openSpawnPoints()
    : ((typeof spawnPoints !== 'undefined' && Array.isArray(spawnPoints)) ? spawnPoints : []);
  if (sp && sp.length > 0) return sp[idx % sp.length];
  return [(idx % 4) * 6 - 9, ((idx / 4) | 0) * 6 + 10];
}

function ffaFactionTeam(index) {
  return 'ffa_' + index;
}

// Free-for-all deployment: every bot is its own faction, which makes the shared IFF
// (CORE.isHostile), bot targeting and hostiles-only aim assist work as-is.
function spawnFreeForAllRoster(mode, count) {
  if (typeof spawnEnemy !== 'function') return;
  const total = Math.max(2, Math.min(CORE.FREE_FOR_ALL_MAX_ACTORS, count | 0));
  for (let i = 1; i < total; i++) {
    const pt = matchSpawnPointAt(i - 1);
    const kind = (i % 3 === 0) ? 1 : ((i % 3 === 1) ? 2 : 0);
    const bot = spawnEnemy(kind, pt[0], pt[1], { team: ffaFactionTeam(i), spawnProtection: true });
    if (bot) {
      bot.id = ffaFactionTeam(i);
      bot.name = 'RIVAL ' + (i + 1);
      bot.kills = 0;
      bot.deaths = 0;
      bot.tier = 0;
      mode.roster.push(bot);
    }
  }
}

function actorTeamOf(actor) {
  if (!actor) return 'enemy';
  if (actor.team) return actor.team;
  return actor.isPlayer ? 'friendly' : 'enemy';
}

function liveActors() {
  const out = [];
  const p = (typeof player !== 'undefined') ? player : null;
  if (p && !p.dead) out.push(p);
  const list = (typeof enemies !== 'undefined' && Array.isArray(enemies)) ? enemies : [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e && !e.dead && e !== p) out.push(e);
  }
  return out;
}

function actorInsideFlag(actor, flag, radius) {
  if (!actor || !actor.pos || !flag) return false;
  const dx = actor.pos.x - flag.x;
  const dz = actor.pos.z - flag.z;
  const r = (typeof radius === 'number') ? radius : CORE.DOMINATION_FLAG_RADIUS;
  return (dx * dx + dz * dz) <= r * r;
}

function hideMatchOverlays() {
  if (typeof document === 'undefined') return;
  const endScreen = document.getElementById('match-end-screen');
  if (endScreen) endScreen.style.display = 'none';
  const deathScreen = document.getElementById('death-screen');
  if (deathScreen) deathScreen.style.display = 'none';
}

// ============ FREE-FOR-ALL BASE (shared by FFA and Gun Game) ============
// Both modes are free-for-all: identical roster, death/respawn, settlement and HUD
// plumbing. They differ only in their win condition and ladder bookkeeping, which is
// where a wrong local copy would hide, so the shared half lives in one place.
function ffaDeploy(mode, def) {
  clearModeRespawns();
  mode._ended = false;
  mode._settled = false;
  mode.winner = null;
  purgeMatchBots(mode, 'ffa_');
  if (def.scoreKey) mode.targetScore = modeSettingNum(def.scoreKey, mode.targetScore, def.scoreMin, def.scoreMax);
  mode.actors = modeSettingNum(def.actorsKey, CORE.FREE_FOR_ALL_MAX_ACTORS, 2, CORE.FREE_FOR_ALL_MAX_ACTORS);
  mode.timeLeft = mode.matchDuration;
  if (typeof gameEnded !== 'undefined') gameEnded = false;
  const p = (typeof player !== 'undefined') ? player : null;
  if (p) {
    p.team = 'ffa_you';
    p.isPlayer = true;
    p.kills = 0;
    p.deaths = 0;
    p.downed = false;
    p.downedBy = null;
    p.lastAttacker = null;
    p.spawnProtectionT = CORE.SPAWN_PROTECTION_DURATION;
    if (def.prepareActor) def.prepareActor(p);
    mode.roster.push(p);
  }
  spawnFreeForAllRoster(mode, mode.actors);
  const roster = mode.roster;
  for (let i = 0; i < roster.length; i++) {
    const a = roster[i];
    if (a && !a.isPlayer && def.prepareActor) def.prepareActor(a);
  }
  hideMatchOverlays();
  updateMatchHud(mode);
}

function ffaStep(mode, dt) {
  if (typeof paused !== 'undefined' && paused) return;
  if (mode.isOver()) {
    if (typeof gameEnded !== 'undefined' && !gameEnded) mode.endMatch();
    return;
  }
  if (mode.timeLeft > 0) mode.timeLeft = Math.max(0, mode.timeLeft - dt);
  if (typeof mode.tickExtra === 'function') mode.tickExtra(dt);
  const sp = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : (typeof spawnPoints !== 'undefined' ? spawnPoints : []);
  updateModeRespawns(dt, sp, (typeof enemies !== 'undefined') ? enemies : [], (typeof colliders !== 'undefined') ? colliders : []);
  updateMatchHud(mode);
  if (mode.isOver()) mode.endMatch();
}

function ffaOnDeath(mode, victim) {
  if (mode.isOver() || (typeof gameEnded !== 'undefined' && gameEnded)) return;
  if (victim) queueModeRespawn(victim, CORE.RESPAWN_DELAY);
}

function ffaSettle(mode) {
  if (mode._ended) return;
  mode._ended = true;
  mode._settled = true;
  if (typeof gameEnded !== 'undefined') gameEnded = true;
  clearModeRespawns();
  if (typeof showMatchEndScreen === 'function') showMatchEndScreen(mode);
}

function ffaPlayer() {
  return (typeof player !== 'undefined') ? player : null;
}

function ffaPlayerKills() {
  const p = ffaPlayer();
  return (p && typeof p.kills === 'number') ? p.kills : 0;
}

function ffaLeaderKills(mode) {
  let best = 0;
  const roster = Array.isArray(mode.roster) ? mode.roster : [];
  for (let i = 0; i < roster.length; i++) {
    const k = roster[i] && typeof roster[i].kills === 'number' ? roster[i].kills : 0;
    if (k > best) best = k;
  }
  return best;
}

// Shared kill accounting: deaths always count, only a hostile weapon kill credits the
// killer, and the killfeed never invents a name for an actor that has none.
function matchCreditKill(mode, victim, isHead, killer, damageType, victimsLabel, killerLabel) {
  if (victim) victim.deaths = (victim.deaths || 0) + 1;
  const p = ffaPlayer();
  const isPlayerKiller = !!(killer && (killer.isPlayer || killer === p));
  const isPlayerVictim = !!(victim && (victim.isPlayer || victim === p));
  const victimTeam = actorTeamOf(victim);
  const killerTeam = killer ? actorTeamOf(killer) : null;
  const isSelfKill = !!(killer && victim && (killer === victim || (killer.id && victim.id && killer.id === victim.id) || (isPlayerKiller && isPlayerVictim)));
  const isHostileKill = !!(killer && !isSelfKill && killerTeam && killerTeam !== victimTeam);
  if (isHostileKill) killer.kills = (killer.kills || 0) + 1;
  if (typeof pushKillfeed === 'function') {
    const killerName = isPlayerKiller ? 'YOU' : ((killer && killer.name) ? killer.name : (killerLabel || 'RIVAL'));
    const victimName = isPlayerVictim ? 'YOU' : ((victim && victim.name) ? victim.name : (victimsLabel || 'RIVAL'));
    if (isHostileKill) {
      const color = (typeof matchKillfeedColor === 'function') ? matchKillfeedColor(killerTeam) : '#ff4030';
      pushKillfeed('<span style="color:' + color + '">' + killerName + '</span> eliminated ' + victimName + (isHead ? ' (HEADSHOT)' : ''));
    } else if (isSelfKill) {
      pushKillfeed('<span style="color:#ffdf8a">' + victimName + '</span> eliminated themselves');
    } else {
      pushKillfeed('<span style="color:#ffdf8a">' + victimName + '</span> died');
    }
  }
  const creditedType = (typeof damageType === 'string') ? damageType : victim && victim.lastDamageType;
  return {
    killer: killer,
    victim: victim,
    killerTeam: killerTeam,
    victimTeam: victimTeam,
    isSelfKill: isSelfKill,
    isHostileKill: isHostileKill,
    isPlayerKiller: isPlayerKiller,
    credited: isHostileKill && CORE.gunGameCreditedKill(creditedType),
    damageType: creditedType
  };
}

function matchKillfeedColor(team) {
  return (team === 'friendly' || team === 'ffa_you') ? '#38b6ff' : '#ff4030';
}

function ffaMembers(mode, gunGame) {
  const p = ffaPlayer();
  const roster = Array.isArray(mode.roster) ? mode.roster : [];
  const members = [];
  for (let i = 0; i < roster.length; i++) {
    const actor = roster[i];
    if (!actor) continue;
    const isYou = !!(actor.isPlayer || actor === p);
    const m = {
      id: isYou ? 'player' : (actor.id || ('ffa_' + i)),
      name: isYou ? 'YOU' : (actor.name || ('RIVAL ' + (i + 1))),
      isPlayer: isYou,
      team: isYou ? 'ffa_you' : actorTeamOf(actor),
      kills: actor.kills || 0,
      deaths: actor.deaths || 0
    };
    if (gunGame) {
      m.tier = mode.tierOf(actor);
      m.weapon = CORE.gunGameTierWeapon(m.tier);
    }
    members.push(m);
  }
  members.sort(function (a, b) {
    return (gunGame ? (b.tier - a.tier || b.kills - a.kills) : (b.kills - a.kills));
  });
  return members;
}

// Whoever tops the board alone takes it; a shared top score is a draw.
function ffaSoleLeader(mode, gunGame) {
  const p = ffaPlayer();
  const roster = Array.isArray(mode.roster) ? mode.roster : [];
  let best = 0;
  let count = 0;
  let playerBest = false;
  for (let i = 0; i < roster.length; i++) {
    const a = roster[i];
    if (!a) continue;
    const v = gunGame ? mode.tierOf(a) : (a.kills || 0);
    const isP = !!(a.isPlayer || a === p);
    if (v > best) { best = v; count = 1; playerBest = isP; }
    else if (v === best) { count++; if (isP) playerBest = true; }
  }
  return best > 0 && count === 1 && playerBest;
}

function ffaOutcome(mode, gunGame) {
  const mine = gunGame ? mode.playerTier() : ffaPlayerKills();
  const best = gunGame ? mode.leaderTier() : ffaLeaderKills(mode);
  const p = ffaPlayer();
  let title = 'DEFEAT';
  if (gunGame && mode.winner && (mode.winner.isPlayer || mode.winner === p)) title = 'VICTORY';
  else if (mine > best) title = 'VICTORY';
  else if (mine === best && best > 0) title = ffaSoleLeader(mode, gunGame) ? 'VICTORY' : 'DRAW';
  return {
    title: title,
    leftLabel: 'YOU',
    leftScore: gunGame ? ('TIER ' + (mine + 1)) : mine,
    rightLabel: 'LEADER',
    rightScore: gunGame ? ('TIER ' + (best + 1)) : best,
    note: gunGame ? ('Knife take-all: final tier ' + CORE.GUN_GAME_TIER_COUNT)
      : ('First to ' + mode.targetScore + ' kills')
  };
}

MODES.ffa = {
  id: 'ffa',
  name: 'Free-for-All',
  targetScore: 30,
  matchDuration: 600,
  timeLeft: 600,
  actors: 8,
  roster: [],
  setup: function () {
    ffaDeploy(this, { scoreKey: 'ffaScoreLimit', scoreMin: 2, scoreMax: 100, actorsKey: 'ffaActorCount' });
  },
  playerScore: ffaPlayerKills,
  leaderKills: function () { return ffaLeaderKills(this); },
  leaders: function () {
    const best = ffaLeaderKills(this);
    return (Array.isArray(this.roster) ? this.roster : []).filter(function (a) { return a && (a.kills || 0) === best && best > 0; });
  },
  onKill: function (victim, isHead, killer, damageType) {
    if (this._settled || (typeof gameEnded !== 'undefined' && gameEnded) || this.isOver()) return;
    matchCreditKill(this, victim, isHead, killer, damageType, 'RIVAL', 'RIVAL');
    updateMatchHud(this);
    if (this.isOver()) this.endMatch();
  },
  onDeath: function (victim) { ffaOnDeath(this, victim); },
  update: function (dt) { ffaStep(this, dt); },
  scoreboard: function () {
    return {
      mode: 'ffa',
      targetScore: this.targetScore,
      timeLeft: this.timeLeft,
      playerScore: ffaPlayerKills(),
      leaderKills: ffaLeaderKills(this),
      members: ffaMembers(this, false)
    };
  },
  isOver: function () {
    if (this._settled || this._ended) return true;
    return ffaLeaderKills(this) >= this.targetScore || this.timeLeft <= 0;
  },
  endMatch: function () { ffaSettle(this); },
  hudModel: function () {
    return {
      time: this.timeLeft,
      left: 'YOU ' + ffaPlayerKills(),
      right: 'LEADER ' + ffaLeaderKills(this),
      note: 'FIRST TO ' + this.targetScore + ' KILLS'
    };
  },
  outcome: function () { return ffaOutcome(this, false); }
};

// ============ DOMINATION ============
function buildDominationFlags() {
  const flags = (typeof getActiveMap === 'function' && getActiveMap().dominationFlags) ||
                (typeof CORE !== 'undefined' && CORE.getMapDef && CORE.getMapDef('urban').dominationFlags) ||
                [{ name: 'A', x: -18, z: 0 }, { name: 'B', x: 0, z: 18 }, { name: 'C', x: 18, z: 0 }];
  return flags.map(function (f) {
    return { name: f.name, x: f.x, z: f.z, owner: 'neutral', capture: 0, radius: CORE.DOMINATION_FLAG_RADIUS };
  });
}

MODES.domination = {
  id: 'domination',
  name: 'Domination',
  targetScore: 200,
  matchDuration: 600,
  timeLeft: 600,
  teamSize: 6,
  friendlyScore: 0,
  enemyScore: 0,
  flags: [],
  roster: [],
  setup: function () {
    clearModeRespawns();
    this._ended = false;
    this._settled = false;
    purgeMatchBots(this, null);
    this.teamSize = 6;
    this.targetScore = modeSettingNum('dominationScoreLimit', 200, 50, 500);
    this.friendlyScore = 0;
    this.enemyScore = 0;
    this._scoreAcc = { friendly: 0, enemy: 0 };
    this.timeLeft = this.matchDuration;
    this.flags = buildDominationFlags();
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
      p.spawnProtectionT = CORE.SPAWN_PROTECTION_DURATION;
      this.roster.push(p);
    }
    if (typeof spawnEnemy === 'function') {
      const count = this.teamSize;
      const sides = [{ team: 'friendly', n: count - 1, tag: 'ALLY', prefix: 'ally_' }, { team: 'enemy', n: count, tag: 'HOSTILE', prefix: 'enemy_' }];
      for (let s = 0; s < sides.length; s++) {
        const side = sides[s];
        for (let i = 0; i < side.n; i++) {
          const pt = matchSpawnPointAt(s === 0 ? i : i + count);
          const kind = (i % 3 === 0) ? 1 : ((i % 3 === 1) ? 2 : 0);
          const bot = spawnEnemy(kind, pt[0], pt[1], { team: side.team, spawnProtection: true });
          if (bot) {
            bot.id = side.prefix + (i + 1);
            bot.name = side.tag + ' ' + (i + 1);
            bot.kills = 0;
            bot.deaths = 0;
            this.roster.push(bot);
          }
        }
      }
    }
    hideMatchOverlays();
    updateMatchHud(this);
  },
  flagHostileCount: function (flag, team, radius) {
    let n = 0;
    const actors = liveActors();
    for (let i = 0; i < actors.length; i++) {
      if (actorTeamOf(actors[i]) !== team && actorInsideFlag(actors[i], flag, radius)) n++;
    }
    return n;
  },
  flagDistance: function (actor, flag) {
    if (!actor || !actor.pos || !flag) return Infinity;
    const dx = actor.pos.x - flag.x;
    const dz = actor.pos.z - flag.z;
    return Math.sqrt(dx * dx + dz * dz);
  },
  // Attack the nearest flag the side does not hold, defend one hostiles are taking,
  // otherwise hold. The bot AI and the HUD read the same order.
  objectiveFor: function (actor) {
    const team = actorTeamOf(actor);
    const flags = Array.isArray(this.flags) ? this.flags : [];
    let best = null;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f.owner === team && this.flagHostileCount(f, team, CORE.DOMINATION_DEFEND_RADIUS) > 0) {
        const d = this.flagDistance(actor, f);
        if (!best || d < best.d) best = { f: f, d: d, role: 'defend' };
      }
    }
    if (!best) {
      for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        if (f.owner === team) continue;
        const d = this.flagDistance(actor, f);
        if (!best || d < best.d) best = { f: f, d: d, role: 'attack' };
      }
    }
    if (!best) {
      for (let i = 0; i < flags.length; i++) {
        const d = this.flagDistance(actor, flags[i]);
        if (!best || d < best.d) best = { f: flags[i], d: d, role: 'hold' };
      }
    }
    if (!best) return null;
    return { name: best.f.name, point: [best.f.x, best.f.z], role: best.role };
  },
  updateFlags: function (dt) {
    const flags = Array.isArray(this.flags) ? this.flags : [];
    const actors = liveActors();
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      let friendly = 0;
      let enemy = 0;
      for (let j = 0; j < actors.length; j++) {
        if (!actorInsideFlag(actors[j], f, CORE.DOMINATION_FLAG_RADIUS)) continue;
        if (actorTeamOf(actors[j]) === 'friendly') friendly++;
        else enemy++;
      }
      const contested = friendly > 0 && enemy > 0;
      const attacker = contested ? null : (friendly > 0 ? 'friendly' : (enemy > 0 ? 'enemy' : null));
      if (contested) {
        f.capture = CORE.flagCaptureStep(f.capture, dt, true, true);
      } else if (!attacker || attacker === f.owner) {
        // Nobody on it, or the owner standing on its own flag: partial progress decays.
        f.capture = CORE.flagCaptureStep(f.capture, dt, false, false);
      } else {
        f.capture = CORE.flagCaptureStep(f.capture, dt, true, false);
        if (f.capture >= CORE.DOMINATION_CAPTURE_SECONDS) {
          f.owner = attacker;
          f.capture = 0;
        }
      }
    }
  },
  // Ownership scores, not occupation: whole points are awarded per owned flag per
  // second and the fractional remainder carries across frames.
  updateScore: function (dt) {
    const flags = Array.isArray(this.flags) ? this.flags : [];
    if (!this._scoreAcc) this._scoreAcc = { friendly: 0, enemy: 0 };
    const owned = { friendly: 0, enemy: 0 };
    for (let i = 0; i < flags.length; i++) {
      if (owned[flags[i].owner] !== undefined) owned[flags[i].owner]++;
    }
    const fStep = CORE.flagScoreStep(this._scoreAcc.friendly, owned.friendly, dt);
    this.friendlyScore += fStep.points;
    this._scoreAcc.friendly = fStep.acc;
    const eStep = CORE.flagScoreStep(this._scoreAcc.enemy, owned.enemy, dt);
    this.enemyScore += eStep.points;
    this._scoreAcc.enemy = eStep.acc;
  },
  onKill: function (victim, isHead, killer, damageType) {
    if (this._settled || (typeof gameEnded !== 'undefined' && gameEnded) || this.isOver()) return;
    matchCreditKill(this, victim, isHead, killer, damageType, 'ALLY BOT', 'HOSTILE BOT');
    updateMatchHud(this);
  },
  onDeath: function (victim) { ffaOnDeath(this, victim); },
  update: function (dt) {
    if (typeof paused !== 'undefined' && paused) return;
    if (this.isOver()) {
      if (typeof gameEnded !== 'undefined' && !gameEnded) this.endMatch();
      return;
    }
    if (this.timeLeft > 0) this.timeLeft = Math.max(0, this.timeLeft - dt);
    this.updateFlags(dt);
    this.updateScore(dt);
    const sp = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : (typeof spawnPoints !== 'undefined' ? spawnPoints : []);
    updateModeRespawns(dt, sp, (typeof enemies !== 'undefined') ? enemies : [], (typeof colliders !== 'undefined') ? colliders : []);
    updateMatchHud(this);
    if (this.isOver()) this.endMatch();
  },
  flagStatus: function () {
    const flags = Array.isArray(this.flags) ? this.flags : [];
    const label = { friendly: 'FRIENDLY', enemy: 'HOSTILE', neutral: 'NEUTRAL' };
    const parts = [];
    for (let i = 0; i < flags.length; i++) parts.push(flags[i].name + ' ' + (label[flags[i].owner] || 'NEUTRAL'));
    return parts.join(' · ');
  },
  scoreboard: function () {
    const p = (typeof player !== 'undefined') ? player : null;
    const roster = Array.isArray(this.roster) ? this.roster : [];
    const sides = { friendly: [], enemy: [] };
    const seen = {};
    for (let i = 0; i < roster.length; i++) {
      const actor = roster[i];
      if (!actor) continue;
      const isYou = !!(actor.isPlayer || actor === p);
      const actorId = isYou ? 'player' : (actor.id || ('bot_' + i));
      if (seen[actorId]) continue;
      seen[actorId] = true;
      const team = (isYou || actorTeamOf(actor) === 'friendly') ? 'friendly' : 'enemy';
      sides[team].push({
        id: actorId,
        name: isYou ? 'YOU' : (actor.name || (team === 'friendly' ? ('ALLY BOT ' + (i + 1)) : ('HOSTILE BOT ' + (i + 1)))),
        isPlayer: isYou,
        team: team,
        kills: actor.kills || 0,
        deaths: actor.deaths || 0
      });
    }
    sides.friendly.sort(function (a, b) { return b.kills - a.kills; });
    sides.enemy.sort(function (a, b) { return b.kills - a.kills; });
    const flags = Array.isArray(this.flags) ? this.flags : [];
    const flagRows = [];
    for (let i = 0; i < flags.length; i++) flagRows.push({ name: flags[i].name, owner: flags[i].owner, capture: flags[i].capture });
    return {
      mode: 'domination',
      friendlyScore: this.friendlyScore,
      enemyScore: this.enemyScore,
      targetScore: this.targetScore,
      timeLeft: this.timeLeft,
      flags: flagRows,
      friendlyTeam: { name: 'FRIENDLY', score: this.friendlyScore, members: sides.friendly },
      enemyTeam: { name: 'ENEMY', score: this.enemyScore, members: sides.enemy }
    };
  },
  isOver: function () {
    if (this._settled || this._ended) return true;
    return (this.friendlyScore >= this.targetScore) || (this.enemyScore >= this.targetScore) || (this.timeLeft <= 0);
  },
  endMatch: function () { ffaSettle(this); },
  hudModel: function () {
    return {
      time: this.timeLeft,
      left: this.friendlyScore,
      right: this.enemyScore,
      note: this.flagStatus() + ' · FIRST TO ' + this.targetScore
    };
  },
  outcome: function () {
    const draw = this.friendlyScore === this.enemyScore;
    return {
      title: draw ? 'DRAW' : (this.friendlyScore > this.enemyScore ? 'VICTORY' : 'DEFEAT'),
      leftLabel: 'FRIENDLY',
      leftScore: this.friendlyScore,
      rightLabel: 'ENEMY',
      rightScore: this.enemyScore,
      note: this.flagStatus()
    };
  }
};

// ============ GUN GAME ============
// A bot's tier weapon decides how hard it hits; the knife tier fights up close.
function gunGameBaselineDamage() {
  if (typeof CFG === 'undefined' || !CFG || !Array.isArray(CFG.weapons) || !CFG.weapons[0]) return 26;
  const dmg = CFG.weapons[0].dmg;
  return (typeof dmg === 'number' && dmg > 0) ? dmg : 26;
}

function applyGunGameBotLoadout(actor) {
  if (!actor) return;
  const tier = (typeof actor.tier === 'number') ? actor.tier : 0;
  const weapon = CORE.gunGameTierWeapon(tier);
  actor.ggWeapon = weapon;
  if (weapon < 0) {
    actor.dmgMul = CORE.GUN_GAME_KNIFE_DAMAGE_MUL;
    return;
  }
  const w = (typeof CFG !== 'undefined' && CFG && Array.isArray(CFG.weapons)) ? CFG.weapons[weapon] : null;
  actor.dmgMul = CORE.gunGameBotDamageMul(w ? w.dmg : undefined, gunGameBaselineDamage());
}

// The player's only weapon is the ladder weapon for the earned tier: at the knife
// tier every firearm slot is emptied and the melee knife is what remains.
function applyGunGamePlayerLoadout(mode) {
  if (typeof weaponsOwned === 'undefined' || !Array.isArray(weaponsOwned)) return;
  const p = (typeof player !== 'undefined') ? player : null;
  const weapon = CORE.gunGameTierWeapon((p && typeof p.tier === 'number') ? p.tier : 0);
  for (let i = 0; i < weaponsOwned.length; i++) weaponsOwned[i] = -1;
  if (weapon >= 0 && weaponsOwned.length > 0) weaponsOwned[0] = weapon;
  if (typeof curWeapon !== 'undefined') curWeapon = 0;
  if (typeof pendingSecondary !== 'undefined') pendingSecondary = -1;
  if (typeof initWeapons === 'function') initWeapons({ restrictedSlots: true });
  if (typeof buildViewmodel === 'function') buildViewmodel();
  if (typeof updateHudAmmo === 'function') updateHudAmmo();
}

MODES['gun-game'] = {
  id: 'gun-game',
  name: 'Gun Game',
  matchDuration: 600,
  timeLeft: 600,
  actors: 8,
  tierCount: 20,
  winner: null,
  roster: [],
  setup: function () {
    ffaDeploy(this, {
      actorsKey: 'gunGameActorCount',
      prepareActor: function (actor) { actor.tier = 0; }
    });
    const p = ffaPlayer();
    if (p) applyGunGamePlayerLoadout(this);
    const roster = Array.isArray(this.roster) ? this.roster : [];
    for (let i = 0; i < roster.length; i++) {
      if (roster[i] && !roster[i].isPlayer) applyGunGameBotLoadout(roster[i]);
    }
    updateMatchHud(this);
  },
  tierOf: function (actor) {
    return (actor && typeof actor.tier === 'number') ? actor.tier : 0;
  },
  setTier: function (actor, tier) {
    if (!actor) return 0;
    actor.tier = CORE.gunGameAdvance(tier, 0);
    this.onRespawn(actor);
    updateMatchHud(this);
    return actor.tier;
  },
  playerTier: function () { return this.tierOf(ffaPlayer()); },
  leaderTier: function () {
    let best = 0;
    const roster = Array.isArray(this.roster) ? this.roster : [];
    for (let i = 0; i < roster.length; i++) {
      const t = this.tierOf(roster[i]);
      if (t > best) best = t;
    }
    return best;
  },
  // The ladder only moves on genuine hostile weapon kills. Grenades, self kills and
  // same-faction kills leave every rung untouched; the knife demotes its victim.
  onKill: function (victim, isHead, killer, damageType) {
    if (this._settled || (typeof gameEnded !== 'undefined' && gameEnded)) return;
    const r = matchCreditKill(this, victim, isHead, killer, damageType, 'RIVAL', 'RIVAL');
    let won = false;
    if (r.isHostileKill && victim && CORE.gunGameMeleeKill(r.damageType)) {
      const before = this.tierOf(victim);
      const after = CORE.gunGameAdvance(before, -1);
      if (after !== before) {
        victim.tier = after;
        this.onRespawn(victim);
      }
    }
    if (r.credited && killer) {
      if (CORE.gunGameIsKnifeTier(this.tierOf(killer))) {
        won = r.isHostileKill && CORE.gunGameMeleeKill(r.damageType);
      } else {
        killer.tier = CORE.gunGameAdvance(this.tierOf(killer), 1);
        this.onRespawn(killer);
      }
    }
    updateMatchHud(this);
    if (won) {
      this.winner = killer;
      this.endMatch();
      return;
    }
    if (this.isOver()) this.endMatch();
  },
  onDeath: function (victim) { ffaOnDeath(this, victim); },
  // Respawning must not reset progress: re-issue the loadout for the earned tier.
  onRespawn: function (actor) {
    if (!actor) return;
    const p = ffaPlayer();
    if (actor.isPlayer || actor === p) applyGunGamePlayerLoadout(this);
    else applyGunGameBotLoadout(actor);
  },
  update: function (dt) { ffaStep(this, dt); },
  scoreboard: function () {
    return {
      mode: 'gun-game',
      tierCount: CORE.GUN_GAME_TIER_COUNT,
      timeLeft: this.timeLeft,
      playerTier: this.playerTier(),
      leaderTier: this.leaderTier(),
      members: ffaMembers(this, true)
    };
  },
  isOver: function () {
    if (this._settled || this._ended) return true;
    return !!this.winner || this.timeLeft <= 0;
  },
  endMatch: function () { ffaSettle(this); },
  hudModel: function () {
    const total = CORE.GUN_GAME_TIER_COUNT;
    return {
      time: this.timeLeft,
      left: 'TIER ' + (this.playerTier() + 1) + '/' + total,
      right: 'LEADER ' + (this.leaderTier() + 1) + '/' + total,
      note: 'FINAL TIER IS THE KNIFE'
    };
  },
  outcome: function () {
    const result = ffaOutcome(this, true);
    if (this.winner) result.title = this.winner === ffaPlayer() || this.winner.isPlayer ? 'VICTORY' : 'DEFEAT';
    return result;
  }
};
