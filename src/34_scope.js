// ============ SNIPER SCOPE: RETICLE, PARALLAX, RANGEFINDER, ZOOM, SWAY ============
'use strict';
// The scope is drawn on its own canvas: a black surround with a soft circular
// aperture (it shifts with look/move/recoil like a real eye box), a mil-dot
// reticle with an illuminated centre, zoom and range readouts and a breath gauge.
// Scoped sway is applied to the real aim direction (bullets follow the reticle).
const scopeCanvas = document.createElement('canvas');
scopeCanvas.id = 'scope-canvas';
scopeCanvas.className = 'hud';
scopeCanvas.style.cssText = 'top:0;left:0;width:100%;height:100%;z-index:4;display:none';
document.body.insertBefore(scopeCanvas, document.getElementById('slide-vignette'));
const scx = scopeCanvas.getContext('2d');
const SCOPE = { range: 0, rangeT: 0, zoomIdx: 0, boltOff: 0, gaspT: 0, swayX: 0, swayY: 0, zoomFlash: 0 };
function sizeScopeCanvas() {
  const pr = Math.min(window.devicePixelRatio || 1, 1.5);
  scopeCanvas.width = Math.round(innerWidth * pr); scopeCanvas.height = Math.round(innerHeight * pr);
}
sizeScopeCanvas();
addEventListener('resize', sizeScopeCanvas);

// Zoom: SV-98 has two magnifications (wheel / Z / d-pad up while scoped).
function currentAdsZoom() {
  const w = curW();
  if (w.zooms) return w.zooms[SCOPE.zoomIdx % w.zooms.length];
  return w.adsZoom || 0.75;
}
function sniperScopedAmount() { return curW().type === 'SR' ? adsAmount : 0; }
function cycleScopeZoom() {
  const w = curW();
  if (!w.zooms || adsAmount < 0.6) return false;
  SCOPE.zoomIdx = (SCOPE.zoomIdx + 1) % w.zooms.length;
  SCOPE.zoomFlash = 1;
  playSound('scope_in');
  return true;
}
addEventListener('keydown', function (e) { if (e.code === 'KeyZ' && started && !paused) cycleScopeZoom(); });

// Breathing sway (radians), applied to the camera while scoped. Hold Shift to steady;
// run out of breath and the sway gets worse for a moment.
function updateScopeSway(dt) {
  const w = curW();
  const k = w.type === 'SR' ? adsAmount : 0;
  if (steadyT <= 0.01 && steadyActive) SCOPE.gaspT = 1.6;
  SCOPE.gaspT = Math.max(0, SCOPE.gaspT - dt);
  const move = Math.min(1, Math.hypot(player.vel.x, player.vel.z) / 4);
  const tired = player.exhausted ? 1.8 : 1;
  const hurt = player.health < 35 ? 1.4 : 1;
  let amp = 0.0024 * (1 + move * 2.2) * tired * hurt * (player.crouching ? 0.6 : 1) * (1 + SCOPE.gaspT * 1.2);
  if (steadyActive) amp *= 0.12;
  const t = swayPhase;
  // figure-eight drift + slow breathing heave + a little heartbeat
  const tx = (Math.sin(t * 0.9) * 0.8 + Math.sin(t * 2.1 + 1.3) * 0.25) * amp;
  const ty = (Math.sin(t * 1.8 + 0.4) * 0.45 + Math.sin(t * 0.55) * 0.6) * amp + Math.max(0, Math.sin(t * 7.5)) * amp * 0.12 * hurt;
  SCOPE.swayX += (tx * k - SCOPE.swayX) * Math.min(1, dt * 8);
  SCOPE.swayY += (ty * k - SCOPE.swayY) * Math.min(1, dt * 8);
}

// Rangefinder: what is under the reticle (throttled raycast).
const _rfRay = new THREE.Raycaster(), _rfDir = new THREE.Vector3(), _rfTargets = [];
function updateRangefinder(dt) {
  SCOPE.rangeT -= dt;
  if (SCOPE.rangeT > 0) return;
  SCOPE.rangeT = 0.12;
  camera.getWorldDirection(_rfDir);
  _rfRay.set(camera.position, _rfDir); _rfRay.far = 450;
  _rfTargets.length = 0;
  for (let i = 0; i < raycastColliders.length; i++) _rfTargets.push(raycastColliders[i]);
  for (let i = 0; i < enemies.length; i++) if (!enemies[i].dead) _rfTargets.push(enemies[i].parts.group);
  const h = _rfRay.intersectObjects(_rfTargets, true);
  SCOPE.range = h.length ? h[0].distance : 0;
  SCOPE.rangeEnemy = h.length && h[0].object.userData.enemyRef && !h[0].object.userData.enemyRef.dead;
}

function drawScope(dt) {
  const k0 = sniperScopedAmount();
  // iris: the aperture opens as the scope comes up to the eye
  const k = Math.max(0, Math.min(1, (k0 - 0.45) / 0.5));
  if (k <= 0 || player.dead) { if (scopeCanvas.style.display !== 'none') scopeCanvas.style.display = 'none'; return; }
  scopeCanvas.style.display = 'block';
  updateRangefinder(dt);
  SCOPE.zoomFlash = Math.max(0, SCOPE.zoomFlash - dt * 2);
  const W = scopeCanvas.width, H = scopeCanvas.height, pr = W / innerWidth;
  const cx = W / 2, cy = H / 2;
  const s = curS(), w = curW();
  // bolt cycle: the scope dips away and comes back
  const boltK = s && s.cycleT > 0 && w.bolt ? Math.sin((1 - s.cycleT / w.bolt) * Math.PI) : 0;
  SCOPE.boltOff += (boltK - SCOPE.boltOff) * Math.min(1, dt * 14);
  // eye-box parallax: the tube shadow lags the look input, bob and recoil
  const ox = (vmSpring.sx * 2.6 + Math.sin(player.bobPhase) * player.bobAmp * 0.012 - player.recoilVY * 0.02) * H + SCOPE.boltOff * H * 0.05;
  const oy = (-vmSpring.sy * 2.6 + Math.abs(Math.cos(player.bobPhase)) * player.bobAmp * 0.012 + player.recoilVP * 0.03) * H + SCOPE.boltOff * H * 0.12;
  const R = Math.min(W, H) * 0.47 * (0.55 + 0.45 * k);
  const ax = cx + ox, ay = cy + oy;
  const g = scx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  g.globalAlpha = Math.min(1, k * 1.4);
  // black surround with a feathered hole
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out';
  const hole = g.createRadialGradient(ax, ay, R * 0.93, ax, ay, R);
  hole.addColorStop(0, 'rgba(0,0,0,1)'); hole.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = hole;
  g.beginPath(); g.arc(ax, ay, R, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'source-over';
  // inner lens shadow + faint tint
  const ring = g.createRadialGradient(ax, ay, R * 0.62, ax, ay, R);
  ring.addColorStop(0, 'rgba(0,0,0,0)'); ring.addColorStop(0.8, 'rgba(0,0,0,0.25)'); ring.addColorStop(1, 'rgba(0,0,0,0.85)');
  g.fillStyle = ring;
  g.beginPath(); g.arc(ax, ay, R, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(40,90,120,0.05)';
  g.beginPath(); g.arc(ax, ay, R, 0, Math.PI * 2); g.fill();
  // chromatic fringe on the rim
  g.lineWidth = 2 * pr;
  g.strokeStyle = 'rgba(80,140,255,0.35)'; g.beginPath(); g.arc(ax - pr, ay, R * 0.965, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,90,60,0.25)'; g.beginPath(); g.arc(ax + pr, ay, R * 0.965, 0, Math.PI * 2); g.stroke();
  // ---- reticle (fixed to the bore = screen centre), clipped to the aperture ----
  g.save();
  g.beginPath(); g.arc(ax, ay, R * 0.97, 0, Math.PI * 2); g.clip();
  const u = R / 14;   // one mil
  g.fillStyle = 'rgba(8,8,8,0.92)';
  // heavy posts
  const post = 4 * pr, gap = 5 * u;
  g.fillRect(cx - R, cy - post / 2, R - gap, post);
  g.fillRect(cx + gap, cy - post / 2, R - gap, post);
  g.fillRect(cx - post / 2, cy + gap, post, R - gap);
  g.fillRect(cx - post / 2, cy - R, post, R - gap);
  // fine crosshair
  const thin = Math.max(1, 1.2 * pr);
  g.fillRect(cx - gap, cy - thin / 2, gap * 2, thin);
  g.fillRect(cx - thin / 2, cy - gap, thin, gap * 2);
  // mil dots
  for (let i = 1; i <= 4; i++) {
    for (const [dx, dy] of [[i, 0], [-i, 0], [0, i], [0, -i]]) {
      g.beginPath(); g.ellipse(cx + dx * u, cy + dy * u, 2.2 * pr, 2.2 * pr, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // holdover hashes below centre
  for (let i = 1; i <= 4; i++) g.fillRect(cx - (u * 0.6) * (1 - i * 0.1), cy + i * u + u * 0.5 - thin / 2, u * 1.2 * (1 - i * 0.1), thin);
  // illuminated centre (brighter on a target)
  g.fillStyle = SCOPE.rangeEnemy ? 'rgba(255,40,30,1)' : 'rgba(255,60,40,0.85)';
  g.shadowColor = 'rgba(255,40,20,0.9)'; g.shadowBlur = 6 * pr;
  g.beginPath(); g.arc(cx, cy, 1.8 * pr, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.restore();
  // ---- readouts inside the aperture ----
  g.font = 'bold ' + Math.round(12 * pr) + 'px Segoe UI, Arial';
  g.textAlign = 'left';
  const zoom = Math.round(1 / currentAdsZoom());
  g.fillStyle = 'rgba(255,210,74,' + (0.75 + SCOPE.zoomFlash * 0.25) + ')';
  g.fillText(zoom + 'x' + (w.zooms && w.zooms.length > 1 ? '  [Z]' : ''), ax - R * 0.62, ay + R * 0.66);
  g.textAlign = 'right';
  g.fillStyle = SCOPE.rangeEnemy ? 'rgba(255,90,70,0.95)' : 'rgba(200,230,255,0.8)';
  g.fillText(SCOPE.range ? 'RNG ' + Math.round(SCOPE.range) + ' m' : 'RNG ---', ax + R * 0.62, ay + R * 0.66);
  // breath gauge arc
  const br = steadyT / STEADY_MAX;
  g.lineWidth = 3 * pr;
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  g.beginPath(); g.arc(ax, ay, R * 0.9, Math.PI * 0.62, Math.PI * 0.88); g.stroke();
  g.strokeStyle = steadyActive ? 'rgba(126,224,138,0.9)' : SCOPE.gaspT > 0 ? 'rgba(255,90,60,0.9)' : 'rgba(255,255,255,0.55)';
  g.beginPath(); g.arc(ax, ay, R * 0.9, Math.PI * 0.88 - Math.PI * 0.26 * br, Math.PI * 0.88); g.stroke();
  g.globalAlpha = 1;
}
