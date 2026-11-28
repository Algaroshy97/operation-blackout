// ============ LAN DUEL — host-authoritative 1v1 over the local relay =========
// Loaded last so the whole game is already defined. `tools/lan-host.mjs` serves
// this build and relays frames; this module is the game half:
//
//   host tab   owns both fighters: its own player plus a net actor for the guest,
//              integrates the guest's inputs, owns damage, score and respawns.
//   guest tab  renders the host, predicts its own movement, sends input + shots,
//              and mirrors the host's health and score back onto the screen.
//
// Guests never decide hits or kills. Their shot messages are re-tested here with a
// ray-vs-capsule plus a wall check, so "I hit you" from a client is only a claim.
//
// No internet, no accounts: the relay is on the same LAN and the protocol is JSON.

const LAN = {
  role: null,                // 'host' | 'guest'
  ws: null,
  slot: 0,
  guestSlot: 0,
  tick: 0,
  connected: false,
  guestActor: null,          // host: the actor that stands in for the guest
  hostAvatar: null,          // guest: visual proxy of the host player
  input: null,               // host: latest sanitised guest input
  lastInputAt: 0,
  seq: 0,
  sendAcc: 0,
  snapAcc: 0,
  target: 10,
  over: false,
  winner: null,
  status: 'idle',
  shots: 0,
  shotWinT: 0,
  corrections: 0,
  joinAddr: '',
  autoStart: false
};

const LAN_INPUT_INTERVAL = 1 / 30;
const LAN_SNAPSHOT_INTERVAL = 1 / 20;
const LAN_MAX_SHOT_RATE = 25;      // frames/second per guest, hard ceiling
const LAN_SNAP_DISTANCE = 2.0;     // metres of disagreement before rubber-banding
const LAN_BTN_SPRINT = 1, LAN_BTN_CROUCH = 2, LAN_BTN_JUMP = 4, LAN_BTN_FIRE = 8;

function lanEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }

function lanSetStatus(text, tone) {
  const el = lanEl('lan-status');
  if (el) {
    el.textContent = text;
    el.className = 'lan-status' + (tone ? ' ' + tone : '');
  }
  LAN.status = text;
}

function lanShowScreen(kind) {
  const screen = lanEl('lan-screen');
  if (!screen) return;
  screen.style.display = kind ? 'flex' : 'none';
  screen.setAttribute('data-kind', kind || '');
  const hostPane = lanEl('lan-host-pane');
  const joinPane = lanEl('lan-join-pane');
  const waitPane = lanEl('lan-wait-pane');
  if (hostPane) hostPane.style.display = kind === 'host' ? 'block' : 'none';
  if (joinPane) joinPane.style.display = kind === 'join' ? 'block' : 'none';
  if (waitPane) waitPane.style.display = (kind === 'host' || kind === 'join') ? 'block' : 'none';
}

function lanAddressField() {
  const el = lanEl('lan-address');
  return el ? String(el.value || '').trim() : '';
}

function lanWsUrl(slot) {
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss://' : 'ws://';
  return proto + location.host + '/ws?slot=' + slot;
}

// ---------------------------------------------------------------- connection --
function lanConnect(asHost) {
  if (LAN.ws) { try { LAN.ws.close(); } catch (e) { /* already gone */ } LAN.ws = null; }
  let ws;
  try { ws = new WebSocket(lanWsUrl(asHost ? 0 : 1)); }
  catch (e) { lanSetStatus('CANNOT REACH RELAY — ' + e.message, 'bad'); return; }
  LAN.ws = ws;
  LAN.connected = false;
  lanSetStatus(asHost ? 'WAITING FOR THE RELAY…' : 'CONNECTING…');

  ws.onopen = function () {
    LAN.connected = true;
    LAN.role = asHost ? 'host' : 'guest';
    lanSetStatus(asHost ? 'LISTENING FOR A CHALLENGER…' : 'HANDSHAKE…');
  };
  ws.onerror = function () { lanSetStatus('RELAY ERROR', 'bad'); };
  ws.onclose = function () {
    const wasLive = LAN.connected;
    LAN.connected = false;
    if (LAN.role && wasLive && !LAN.over) lanSetStatus('CONNECTION LOST', 'bad');
  };
  ws.onmessage = function (ev) {
    let outer;
    try { outer = JSON.parse(ev.data); } catch (e) { return; }
    // Relay envelopes: a guest frame arrives as {from, msg}; a host frame as {msg}.
    const fromSlot = (typeof outer.from === 'number') ? outer.from : null;
    let inner = outer;
    if (typeof outer.msg === 'string') {
      try { inner = JSON.parse(outer.msg); } catch (e) { return; }
    }
    lanOnMessage(inner, fromSlot);
  };
}

function lanOnMessage(msg, fromSlot) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'welcome') {
    LAN.slot = msg.slot | 0;
    if (LAN.role === 'guest') {
      lanGuestHello();
      // The arena only goes live once the relay has accepted us: a failed
      // connection leaves the menu intact instead of a playable empty match.
      if (typeof started === 'undefined' || !started) lanStartMatch();
    }
    return;
  }
  if (msg.type === 'peer') {
    if (LAN.role !== 'host') return;
    if (msg.kind === 'join') { LAN.guestSlot = msg.slot | 0; lanSpawnGuest(); }
    else if (msg.kind === 'leave') lanGuestLeft();
    return;
  }
  if (LAN.role === 'host') {
    if (msg.type === 'input') {
      const clean = CORE.lanSanitizeInput(msg);
      if (LAN.input && clean.seq <= LAN.input.seq) return;
      LAN.input = clean;
      LAN.lastInputAt = (typeof gameT === 'number') ? gameT : 0;
    } else if (msg.type === 'shot') {
      lanHostGuestShot(msg);
    } else if (msg.type === 'hello') {
      if (LAN.guestActor && LAN.guestActor.name !== msg.name) LAN.guestActor.name = 'CHALLENGER';
    }
    return;
  }
  if (LAN.role === 'guest') {
    if (msg.type === 'state') {
      const snap = CORE.lanValidSnapshot(msg);
      if (snap) lanApplySnapshot(snap);
    } else if (msg.type === 'bye') {
      lanSetStatus('HOST ENDED THE MATCH — ' + (msg.reason || 'closed'), 'bad');
    }
  }
}

function lanSend(obj) {
  if (!LAN.ws || LAN.ws.readyState !== 1) return false;
  try { LAN.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

// --------------------------------------------------------------------- host ---
function lanHostStart() {
  if (typeof assetsReady !== 'undefined' && !assetsReady) { lanSetStatus('ASSETS NOT READY YET…', 'wait'); return; }
  LAN.role = 'host';
  LAN.over = false; LAN.winner = null; LAN.guestActor = null;
  LAN.input = null;
  lanPrepareDuel();
  lanShowScreen('host');
  lanSetStatus('STARTING THE DUEL…');
  lanStartMatch();
  lanConnect(true);
  const addrs = lanEl('lan-host-hint');
  if (addrs) addrs.textContent = location.host;
}

function lanPrepareDuel() {
  if (typeof MODES === 'undefined' || !MODES.ffa) return;
  MODES.ffa.lanDuel = true;
  MODES.ffa.targetScore = LAN.target;
  MODES.ffa.matchDuration = 600;
  if (typeof setActiveMode === 'function') setActiveMode('ffa');
  if (typeof setSetting === 'function') setSetting('gameMode', 'ffa');
}

// Duel spawns: both fighters start on opposite sides of the arena instead of the
// menu's default spawn, so a match never opens with one player inside the other.
function lanPlacePlayer(pt) {
  if (!pt || typeof player === 'undefined' || !player) return;
  player.pos.set(pt[0], (typeof CFG !== 'undefined' && CFG.player ? CFG.player.height : 1.7), pt[1]);
  player.vel.set(0, 0, 0);
  const p = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : [];
  if (p.length) {
    const centre = p.reduce(function (a, b) { return [a[0] + b[0] / p.length, a[1] + b[1] / p.length]; }, [0, 0]);
    player.yaw = Math.atan2(-(centre[0] - pt[0]), -(centre[1] - pt[1]));
  }
  player.pitch = 0;
}

function lanStartMatch() {
  const start = lanEl('btn-start');
  if (typeof startGame !== 'function') return;
  if (start && start.classList.contains('disabled')) start.classList.remove('disabled');
  const menu = lanEl('start-screen');
  if (menu) menu.style.display = 'none';
  startGame();
  const spawns = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : [];
  if (spawns.length) lanPlacePlayer(spawns[0]);
  lanShowScreen(LAN.role === 'guest' ? 'join' : 'host');
}

function lanFarSpawn(avoidX, avoidZ) {
  const list = (typeof openSpawnPoints === 'function') ? openSpawnPoints() : [];
  if (!list || !list.length) return [0, 0];
  let best = list[0], bestD = -1;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const d = Math.hypot(p[0] - avoidX, p[1] - avoidZ);
    if (d > bestD) { bestD = d; best = p; }
  }
  return best;
}

function lanSpawnGuest() {
  if (LAN.role !== 'host' || typeof spawnEnemy !== 'function') return;
  if (LAN.guestActor) return;
  const pt = lanFarSpawn(player.pos.x, player.pos.z);
  // No spawn protection in a duel: the two spawns are on opposite sides, and the
  // guest's health is already the host's decision alone.
  const actor = spawnEnemy(1, pt[0], pt[1], { team: 'ffa_guest', spawnProtection: false });
  if (!actor) return;
  actor.netActor = true;
  actor.id = 'ffa_guest';
  actor.name = 'CHALLENGER';
  actor.kills = 0;
  actor.deaths = 0;
  actor.tier = 0;
  actor.health = 100;
  actor.maxHealth = 100;
  LAN.guestActor = actor;
  const mode = (typeof getActiveMode === 'function') ? getActiveMode() : null;
  if (mode && Array.isArray(mode.roster) && mode.roster.indexOf(actor) < 0) mode.roster.push(actor);
  lanSetStatus('CHALLENGER CONNECTED — FIRST TO ' + LAN.target, 'good');
  lanSend({ t: 's', type: 'state', tick: 0, target: LAN.target, actors: lanHostActors(), over: false, winner: null });
}

function lanGuestLeft() {
  if (LAN.guestActor) {
    if (typeof scene !== 'undefined' && scene && LAN.guestActor.parts && LAN.guestActor.parts.group) {
      scene.remove(LAN.guestActor.parts.group);
    }
    if (typeof disposeEnemyGeometry === 'function') disposeEnemyGeometry(LAN.guestActor);
    const mode = (typeof getActiveMode === 'function') ? getActiveMode() : null;
    if (mode && Array.isArray(mode.roster)) {
      const i = mode.roster.indexOf(LAN.guestActor);
      if (i >= 0) mode.roster.splice(i, 1);
    }
    LAN.guestActor = null;
  }
  LAN.input = null;
  if (!LAN.over) lanSetStatus('CHALLENGER LEFT — WAITING FOR A NEW ONE…', 'wait');
}

function lanHostActors() {
  const out = [];
  if (typeof player !== 'undefined' && player) {
    out.push({
      slot: 0,
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch,
      hp: Math.max(0, Math.round(player.health)),
      alive: !player.dead,
      kills: player.kills || 0
    });
  }
  const g = LAN.guestActor;
  if (g) {
    out.push({
      slot: LAN.guestSlot,
      x: g.pos.x, y: g.pos.y + 1.7, z: g.pos.z,
      yaw: g.yaw, pitch: (g.netPitch || 0),
      hp: Math.max(0, Math.round(g.health)),
      alive: !g.dead,
      kills: g.kills || 0
    });
  }
  return out;
}

// The host walks the guest's actor with the guest's own input, against the same
// colliders the host plays in, so a guest cannot walk through a wall by editing
// the position it reports.
function lanHostStepGuest(dt) {
  const g = LAN.guestActor;
  if (!g || g.dead) return;
  const inp = LAN.input || { mx: 0, mz: 0, yaw: g.yaw, pitch: 0, buttons: 0 };
  g.netPitch = inp.pitch;
  g.yaw = inp.yaw;
  const speed = (typeof CFG !== 'undefined' && CFG.player) ? CFG.player.speed : 5.2;
  const sprintMul = (typeof CFG !== 'undefined' && CFG.player) ? CFG.player.sprintMul : 1.6;
  const step = CORE.lanStepActor({ x: g.pos.x, z: g.pos.z, y: 0, yaw: g.yaw }, inp, dt, { speed: speed, sprintMul: sprintMul });
  const feetY = g.pos.y;
  const headY = feetY + 1.8;
  const radius = (typeof CFG !== 'undefined' && CFG.player) ? CFG.player.radius : 0.35;
  const resolved = CORE.lanResolveMove(g.pos.x, g.pos.z, step.x, step.z, radius, feetY, headY,
    (typeof colliders !== 'undefined') ? colliders : [], (typeof CORE !== 'undefined') ? CORE.STEP_HEIGHT : 0.6);
  // A guest whose reported position disagrees badly is pulled back onto the
  // authority's copy instead of being allowed to drift away from it.
  if (inp.px !== null && _lanDistance(inp.px, inp.pz, resolved.x, resolved.z) > LAN_SNAP_DISTANCE * 2) {
    LAN.corrections++;
  }
  g.pos.x = resolved.x;
  g.pos.z = resolved.z;
  g.vel.x = step.vx;
  g.vel.z = step.vz;
  g.speedMul = 1;
  if (step.moved > 0.0005 && g.state !== 'chase') { g.state = 'chase'; g.stateT = 0; }
  if (step.moved <= 0.0005 && g.state !== 'idle') { g.state = 'idle'; g.stateT = 0; }
}

function _lanDistance(ax, az, bx, bz) {
  if (typeof ax !== 'number' || typeof az !== 'number') return 0;
  return Math.hypot(ax - bx, az - bz);
}

// A guest shot is a claim. Re-test it here: ray vs the host's body, then a wall
// check so a shot through a container does not land.
function lanHostGuestShot(msg) {
  const g = LAN.guestActor;
  if (!g || g.dead || !msg || !msg.o || !msg.d) return;
  const now = (typeof gameT === 'number') ? gameT : 0;
  if (now - LAN.shotWinT > 1) { LAN.shotWinT = now; LAN.shots = 0; }
  if (LAN.shots >= LAN_MAX_SHOT_RATE) return;
  LAN.shots++;
  if (player.dead || player.spawnProtectionT > 0) return;
  const ox = +msg.o[0], oy = +msg.o[1], oz = +msg.o[2];
  const dx = +msg.d[0], dy = +msg.d[1], dz = +msg.d[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / len, ny = dy / len, nz = dz / len;
  const feetY = player.pos.y - (typeof eyeHeight === 'function' ? eyeHeight() : 1.7);
  const headY = feetY + 1.85;
  const t = CORE.lanRayCapsule(ox, oy, oz, nx, ny, nz, 120, player.pos.x, player.pos.z, feetY, headY, 0.38);
  if (t < 0) return;
  const wall = lanWallDistance(ox, oy, oz, nx, ny, nz, t);
  if (wall >= 0 && wall < t - 0.05) return;
  const hitY = oy + ny * t;
  const isHead = hitY > feetY + 1.45;
  const base = (typeof msg.dmg === 'number' && isFinite(msg.dmg)) ? Math.max(1, Math.min(60, msg.dmg)) : 24;
  const dmg = base * (isHead ? 2.0 : 1.0);
  const dirDeg = Math.atan2(ox - player.pos.x, oz - player.pos.z) * 180 / Math.PI;
  damagePlayer(dmg, dirDeg, 'AR', g);
  if (typeof spawnBlood === 'function') spawnBlood({ x: player.pos.x, y: hitY, z: player.pos.z }, isHead, 'AR');
}

// Slab test against the arena AABBs; returns the nearest wall distance or -1.
function lanWallDistance(ox, oy, oz, dx, dy, dz, maxDist) {
  const list = (typeof colliders !== 'undefined' && Array.isArray(colliders)) ? colliders : [];
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || !c.min || !c.max) continue;
    let tmin = 0, tmax = maxDist;
    let ok = true;
    const axes = [[ox, dx, c.min.x, c.max.x], [oy, dy, c.min.y, c.max.y], [oz, dz, c.min.z, c.max.z]];
    for (let a = 0; a < 3 && ok; a++) {
      const p = axes[a][0], d = axes[a][1], lo = axes[a][2], hi = axes[a][3];
      if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) ok = false; continue; }
      let t0 = (lo - p) / d, t1 = (hi - p) / d;
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
      if (t0 > tmin) tmin = t0;
      if (t1 < tmax) tmax = t1;
      if (tmin > tmax) ok = false;
    }
    if (ok && tmin > 0.01 && tmin <= maxDist && (best < 0 || tmin < best)) best = tmin;
  }
  return best;
}

// -------------------------------------------------------------------- guest ---
function lanGuestHello() {
  lanSetStatus('JOINED AS SLOT ' + LAN.slot + ' — WAITING FOR THE HOST…');
  lanSend({ type: 'hello', v: CORE.LAN_PROTOCOL_VERSION, name: 'CHALLENGER', slot: LAN.slot });
}

function lanGuestStart() {
  if (typeof assetsReady !== 'undefined' && !assetsReady) { lanSetStatus('ASSETS NOT READY YET…', 'wait'); return; }
  LAN.role = 'guest';
  LAN.over = false; LAN.winner = null;
  lanPrepareDuel();
  lanShowScreen('join');
  lanSetStatus('CONNECTING…');
  lanConnect(false);
}

// Guest-side proxy of the host: it takes hit feedback but never health, because
// the host owns damage. A snapshot moves it.
function lanSpawnHostAvatar() {
  if (LAN.hostAvatar || typeof spawnEnemy !== 'function') return;
  const pt = lanFarSpawn(player.pos.x, player.pos.z);
  const avatar = spawnEnemy(1, pt[0], pt[1], { team: 'ffa_host', spawnProtection: false });
  if (!avatar) return;
  avatar.netActor = true;
  avatar.netProxy = true;
  avatar.id = 'ffa_host';
  avatar.name = 'HOST';
  avatar.health = 100;
  avatar.maxHealth = 100;
  LAN.hostAvatar = avatar;
}

function lanGuestInput() {
  const mx = (Number(!!keys.KeyD) - Number(!!keys.KeyA));
  const mz = (Number(!!keys.KeyW) - Number(!!keys.KeyS));
  let buttons = 0;
  if (keys.ShiftLeft) buttons |= LAN_BTN_SPRINT;
  if (keys.KeyC || keys.ControlLeft) buttons |= LAN_BTN_CROUCH;
  if (keys.Space) buttons |= LAN_BTN_JUMP;
  if (typeof mouse1Down !== 'undefined' && mouse1Down) buttons |= LAN_BTN_FIRE;
  return {
    type: 'input',
    seq: ++LAN.seq,
    mx: mx, mz: mz,
    yaw: player.yaw, pitch: player.pitch,
    buttons: buttons,
    px: player.pos.x, pz: player.pos.z
  };
}

// Hooked from finishShot: the guest tells the host what it just fired. The host
// decides whether it landed.
function lanOnShot(w) {
  if (LAN.role !== 'guest' || !LAN.connected) return;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  lanSend({
    type: 'shot',
    o: [camera.position.x, camera.position.y, camera.position.z],
    d: [dir.x, dir.y, dir.z],
    dmg: (w && typeof w.dmg === 'number') ? w.dmg : 24,
    seq: LAN.seq
  });
}

function lanApplySnapshot(snap) {
  LAN.tick = snap.tick;
  LAN.target = snap.target;
  const avatar = LAN.hostAvatar;
  for (let i = 0; i < snap.actors.length; i++) {
    const a = snap.actors[i];
    if (a.slot === LAN.slot) {
      // Own body: mirror the host's health, and pull back if the two copies of
      // this fight disagree about where the guest is standing.
      if (!a.alive && !player.dead) { if (typeof killPlayer === 'function') killPlayer(avatar); }
      if (a.alive && player.dead && !LAN.over) {
        player.dead = false;
        player.health = Math.max(1, a.hp);
        const screen = lanEl('death-screen');
        if (screen) screen.style.display = 'none';
      }
      if (a.alive && !player.dead) {
        if (a.hp !== LAN.localHp && LAN.localHp !== null && a.hp < LAN.localHp) updateHudHealth();
        player.health = Math.min(playerMaxHealth(), a.hp);
        const d = _lanDistance(player.pos.x, player.pos.z, a.x, a.z);
        if (d > LAN_SNAP_DISTANCE) {
          player.pos.x = a.x;
          player.pos.z = a.z;
          player.vel.set(0, 0, 0);
          LAN.corrections++;
        }
      }
      LAN.localHp = a.hp;
      if (typeof a.kills === 'number') player.kills = a.kills;
    } else if (avatar) {
      if (snap.tick > 0) {
        const d = _lanDistance(avatar.pos.x, avatar.pos.z, a.x, a.z);
        if (d > 6) { avatar.pos.x = a.x; avatar.pos.z = a.z; }
        else {
          avatar.pos.x += (a.x - avatar.pos.x) * 0.55;
          avatar.pos.z += (a.z - avatar.pos.z) * 0.55;
        }
      }
      avatar.pos.y = Math.max(0, a.y - 1.7);
      avatar.yaw = a.yaw;
      avatar.health = Math.max(1, a.hp);
      avatar.dead = !a.alive;
      if (typeof a.kills === 'number') avatar.kills = a.kills;
    }
  }
  if (snap.over && !LAN.over) lanShowResult(snap.winner);
}

// ---------------------------------------------------------------------- tick --
function lanFrame(dt) {
  if (!LAN.role || !LAN.connected) return;
  if (LAN.role === 'host') {
    if (LAN.guestActor) lanHostStepGuest(dt);
    LAN.snapAcc += dt;
    if (LAN.snapAcc >= LAN_SNAPSHOT_INTERVAL) {
      LAN.snapAcc = 0;
      const hostKills = (typeof player !== 'undefined' && player) ? (player.kills || 0) : 0;
      const guestKills = LAN.guestActor ? (LAN.guestActor.kills || 0) : 0;
      const result = CORE.lanDuelResult(hostKills, guestKills, LAN.target);
      if (result && !LAN.over) {
        LAN.over = true;
        LAN.winner = result;
        lanShowResult(result);
      }
      lanSend({
        t: 's',
        type: 'state',
        tick: ++LAN.tick,
        target: LAN.target,
        actors: lanHostActors(),
        over: LAN.over,
        winner: LAN.winner
      });
    }
  } else {
    LAN.sendAcc += dt;
    if (LAN.sendAcc >= LAN_INPUT_INTERVAL && !player.dead) {
      LAN.sendAcc = 0;
      lanSend(lanGuestInput());
    }
    if (!LAN.hostAvatar) lanSpawnHostAvatar();
  }
}

function lanShowResult(winner) {
  LAN.over = true;
  LAN.winner = winner;
  const el = lanEl('lan-result');
  if (!el) return;
  const me = (LAN.role === 'guest') ? 'guest' : 'host';
  let title = 'DRAW';
  if (winner === me) title = 'VICTORY';
  else if (winner === 'host' || winner === 'guest') title = 'DEFEAT';
  el.style.display = 'flex';
  const h = lanEl('lan-result-title');
  if (h) h.textContent = title;
  const s = lanEl('lan-result-score');
  if (s) s.textContent = 'FIRST TO ' + LAN.target;
}

function lanQuit() {
  if (LAN.role === 'host' && LAN.ws) lanSend({ type: 'bye', reason: 'host left' });
  if (LAN.ws) { try { LAN.ws.close(); } catch (e) { /* closing */ } }
  LAN.ws = null;
  LAN.role = null;
  LAN.connected = false;
  LAN.over = false;
  LAN.input = null;
  LAN.guestActor = null;
  LAN.hostAvatar = null;
  lanShowScreen(null);
  const res = lanEl('lan-result');
  if (res) res.style.display = 'none';
  if (typeof quitMatchToMenu === 'function') quitMatchToMenu();
}

// ----------------------------------------------------------------------- boot --
// ?lan=host starts a duel immediately and waits for a challenger; ?lan=join is
// what the host script prints for the other machine.
function lanBootFromUrl() {
  if (typeof location === 'undefined' || !location.search) return false;
  const mode = new URLSearchParams(location.search).get('lan');
  if (mode !== 'host' && mode !== 'join') return false;
  const arm = function () {
    if (typeof assetsReady === 'undefined' || !assetsReady) { setTimeout(arm, 250); return; }
    if (mode === 'host') lanHostStart(); else lanGuestStart();
  };
  setTimeout(arm, 0);
  return true;
}

if (typeof document !== 'undefined') {
  // The acceptance probe drives the real UI; these handles only read state and
  // fire the same shot path the mouse uses.
  if (typeof window !== 'undefined') {
    window.__obLan = LAN;
    window.__obLanApi = { hostStart: lanHostStart, guestStart: lanGuestStart, shot: lanOnShot, frame: lanFrame, settle: CORE.lanDuelResult, pressFire: function (on) { mouse1Down = !!on; } };
    // Read-only handles for the acceptance probe. Getters, not copies, so the probe
    // always looks at the live objects the render loop is using.
    window.__obLanGame = {
      get player() { return player; },
      get enemies() { return enemies; },
      get started() { return started; },
      get camera() { return camera; },
      CORE: CORE
    };
  }
  const wire = function (id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  };
  wire('btn-lan-host', function () { lanHostStart(); });
  wire('btn-lan-join', function () {
    lanShowScreen('join');
    lanSetStatus('ENTER THE HOST ADDRESS, OR CONNECT TO THIS ONE');
    const field = lanEl('lan-address');
    if (field) { field.value = lanAddressField(); field.focus({ preventScroll: true }); }
  });
  wire('btn-lan-connect', function () {
    const addr = lanAddressField();
    if (addr && addr !== location.host) {
      const target = (addr.indexOf('://') >= 0 ? addr : ('http://' + addr));
      location.href = target.replace(/\/+$/, '') + '/?lan=join';
      return;
    }
    lanGuestStart();
  });
  wire('btn-lan-close', function () { lanShowScreen(null); });
  wire('btn-lan-quit', lanQuit);
  wire('btn-lan-quit-result', lanQuit);
  wire('btn-lan-rematch', function () { location.reload(); });
  lanBootFromUrl();
}
