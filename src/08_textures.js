// ============ PROCEDURAL TEXTURES (canvas-generated, zero asset bytes) ============
'use strict';
// Every surface texture is painted at startup onto canvases: a colour map plus a
// height field that is converted to a tangent-space normal map. Seeded RNG keeps
// the look identical between runs, and none of it costs a byte of the size budget.
//
// Colour maps are left in NoColorSpace on purpose. 10_config_world.js disables
// colour management so hex colours reach the shader as-is (the palette was tuned
// that way); tagging these canvases sRGB would decode them to linear and render
// every textured surface far darker than the untextured ones beside it.
const TEX_ALL = [];   // registry: anisotropy is applied once the renderer exists
function texRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function texCanvas(size, h) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h || size;
  return { c: c, g: c.getContext('2d') };
}
// Draw fn(x, y) at every wrapped copy so features cross the seam and the texture tiles.
function wrapDraw(size, x, y, r, fn) {
  for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
    const px = x + ox * size, py = y + oy * size;
    if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
    fn(px, py);
  }
}
function blob(g, size, x, y, r, rgba) {
  wrapDraw(size, x, y, r, function (px, py) {
    const gr = g.createRadialGradient(px, py, 0, px, py, r);
    gr.addColorStop(0, rgba); gr.addColorStop(1, rgba.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = gr; g.fillRect(px - r, py - r, r * 2, r * 2);
  });
}
function speckle(g, size, rnd, n, minR, maxR, colorFn) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colorFn(rnd);
    const r = minR + rnd() * (maxR - minR);
    g.fillRect(rnd() * size, rnd() * size, r, r);
  }
}
// Random-walk crack, painted identically into colour + height contexts.
function crack(gs, size, rnd, x, y, len, widths, styles) {
  let a = rnd() * Math.PI * 2;
  const pts = [[x, y]];
  for (let i = 0; i < len; i++) {
    a += (rnd() - 0.5) * 0.9;
    x += Math.cos(a) * 6; y += Math.sin(a) * 6;
    pts.push([x, y]);
  }
  for (let k = 0; k < gs.length; k++) {
    const g = gs[k];
    g.strokeStyle = styles[k]; g.lineWidth = widths[k]; g.lineCap = 'round';
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const px = pts[i][0] + ox * size, py = pts[i][1] + oy * size;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
  }
}
// Height canvas (grayscale, bright = raised) -> tangent-space normal map canvas.
function heightToNormal(hc, strength) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = texCanvas(w, h);
  const img = out.g.createImageData(w, h);
  const d = img.data;
  function H(x, y) { x = (x + w) % w; y = (y + h) % h; return src[(y * w + x) * 4] / 255; }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  out.g.putImageData(img, 0, 0);
  return out.c;
}
function toTex(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  TEX_ALL.push(t);
  return t;
}
// Returns { map, normalMap } painted by draw(colourCtx, heightCtx, size, rnd).
function makeSurface(size, seed, normalStrength, draw) {
  const col = texCanvas(size), hgt = texCanvas(size);
  hgt.g.fillStyle = '#808080'; hgt.g.fillRect(0, 0, size, size);
  draw(col.g, hgt.g, size, texRng(seed));
  return { map: toTex(col.c), normalMap: toTex(heightToNormal(hgt.c, normalStrength)) };
}

const TEX = {};
// ---- Concrete: formwork panels, tie holes, stains, hairline cracks ----
TEX.concrete = makeSurface(512, 11, 3.0, function (g, h, S, rnd) {
  g.fillStyle = '#8c8c90'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) blob(g, S, rnd() * S, rnd() * S, 30 + rnd() * 90, 'rgba(' + (rnd() < 0.5 ? '60,60,64' : '170,168,160') + ',' + (0.05 + rnd() * 0.1) + ')');
  speckle(g, S, rnd, 5000, 1, 2.5, function (r) { const v = 90 + r() * 90 | 0; return 'rgba(' + v + ',' + v + ',' + (v + 4) + ',0.35)'; });
  speckle(h, S, rnd, 3000, 1, 2.5, function (r) { const v = 100 + r() * 60 | 0; return 'rgb(' + v + ',' + v + ',' + v + ')'; });
  // rain streaks from the top of panels
  for (let i = 0; i < 40; i++) {
    const x = rnd() * S, y = rnd() * S * 0.3, len = 60 + rnd() * 200;
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, 'rgba(40,40,44,0.18)'); gr.addColorStop(1, 'rgba(40,40,44,0)');
    g.fillStyle = gr; g.fillRect(x, y, 2 + rnd() * 5, len);
  }
  // formwork seams (grooves) on a 2x2 panel grid
  for (let k = 0; k <= 2; k++) {
    const p = k * S / 2;
    g.fillStyle = 'rgba(50,50,55,0.55)'; g.fillRect(p - 2, 0, 3, S); g.fillRect(0, p - 2, S, 3);
    h.fillStyle = '#303030'; h.fillRect(p - 2, 0, 4, S); h.fillRect(0, p - 2, S, 4);
  }
  // tie holes
  for (let px = 0; px < 2; px++) for (let py = 0; py < 2; py++) for (let k = 0; k < 4; k++) {
    const x = px * S / 2 + (k % 2 ? 0.25 : 0.75) * S / 2, y = py * S / 2 + (k < 2 ? 0.25 : 0.75) * S / 2;
    g.fillStyle = 'rgba(30,30,34,0.7)'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
    h.fillStyle = '#202020'; h.beginPath(); h.arc(x, y, 5, 0, 7); h.fill();
  }
  for (let i = 0; i < 7; i++) crack([g, h], S, rnd, rnd() * S, rnd() * S, 10 + rnd() * 25, [1.2, 2], ['rgba(35,35,38,0.6)', '#404040']);
});
// ---- Brick: running bond, per-brick colour, recessed mortar ----
TEX.brick = makeSurface(512, 23, 4.0, function (g, h, S, rnd) {
  g.fillStyle = '#a49a8c'; g.fillRect(0, 0, S, S);   // mortar
  h.fillStyle = '#383838'; h.fillRect(0, 0, S, S);
  const rows = 8, cols = 4, bh = S / rows, bw = S / cols, m = 5;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw / 2;
    for (let c = -1; c <= cols; c++) {
      const x = c * bw + off, y = r * bh;
      const base = [118 + rnd() * 40, 62 + rnd() * 22, 44 + rnd() * 16];
      if (rnd() < 0.12) { base[0] *= 0.7; base[1] *= 0.7; base[2] *= 0.75; }   // burnt brick
      g.fillStyle = 'rgb(' + (base[0] | 0) + ',' + (base[1] | 0) + ',' + (base[2] | 0) + ')';
      g.fillRect(x + m / 2, y + m / 2, bw - m, bh - m);
      const hv = 170 + rnd() * 40 | 0;
      h.fillStyle = 'rgb(' + hv + ',' + hv + ',' + hv + ')';
      h.fillRect(x + m / 2 + 1, y + m / 2 + 1, bw - m - 2, bh - m - 2);
      // chipped corner
      if (rnd() < 0.25) { h.fillStyle = '#707070'; h.fillRect(x + m / 2 + (rnd() < 0.5 ? 0 : bw - m - 12), y + m / 2, 12, 8); }
    }
  }
  speckle(g, S, rnd, 6000, 1, 2, function (r) { return 'rgba(' + (r() < 0.5 ? '40,25,20' : '200,170,150') + ',' + (0.15 + r() * 0.2) + ')'; });
  for (let i = 0; i < 25; i++) blob(g, S, rnd() * S, rnd() * S, 40 + rnd() * 80, 'rgba(30,26,24,' + (0.06 + rnd() * 0.12) + ')');
});
// ---- Corrugated sheet metal with rust runs ----
TEX.metal = makeSurface(256, 37, 6.0, function (g, h, S, rnd) {
  for (let x = 0; x < S; x++) {
    const s = Math.sin(x / S * Math.PI * 2 * 12);
    const v = 92 + s * 18 | 0;
    g.fillStyle = 'rgb(' + (v - 4) + ',' + (v + 2) + ',' + (v + 8) + ')'; g.fillRect(x, 0, 1, S);
    const hv = 128 + s * 110 | 0;
    h.fillStyle = 'rgb(' + hv + ',' + hv + ',' + hv + ')'; h.fillRect(x, 0, 1, S);
  }
  for (let i = 0; i < 30; i++) {
    const x = rnd() * S, y = rnd() * S * 0.6, len = 30 + rnd() * 140;
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, 'rgba(120,58,26,0.55)'); gr.addColorStop(1, 'rgba(120,58,26,0)');
    g.fillStyle = gr; g.fillRect(x, y, 2 + rnd() * 6, len);
  }
  for (let i = 0; i < 16; i++) blob(g, S, rnd() * S, rnd() * S, 10 + rnd() * 30, 'rgba(110,55,25,' + (0.2 + rnd() * 0.3) + ')');
  speckle(g, S, rnd, 1500, 1, 2, function (r) { return 'rgba(30,30,30,' + (0.1 + r() * 0.2) + ')'; });
  // horizontal sheet seam with rivets
  g.fillStyle = 'rgba(30,32,36,0.6)'; g.fillRect(0, S - 4, S, 3);
  h.fillStyle = '#404040'; h.fillRect(0, S - 4, S, 3);
  for (let x = 8; x < S; x += 21) { h.fillStyle = '#f0f0f0'; h.beginPath(); h.arc(x, S - 10, 2.5, 0, 7); h.fill(); }
});
// ---- Wood planks ----
TEX.wood = makeSurface(256, 41, 3.0, function (g, h, S, rnd) {
  const planks = 4, ph = S / planks;
  for (let p = 0; p < planks; p++) {
    const base = [120 + rnd() * 30, 86 + rnd() * 20, 52 + rnd() * 14];
    g.fillStyle = 'rgb(' + (base[0] | 0) + ',' + (base[1] | 0) + ',' + (base[2] | 0) + ')';
    g.fillRect(0, p * ph, S, ph);
    for (let i = 0; i < 40; i++) {
      const y = p * ph + rnd() * ph;
      g.strokeStyle = 'rgba(60,38,20,' + (0.08 + rnd() * 0.2) + ')'; g.lineWidth = 1 + rnd() * 1.5;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= S; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 2);
      g.stroke();
    }
    // knot
    if (rnd() < 0.7) {
      const kx = rnd() * S, ky = p * ph + ph / 2;
      g.fillStyle = 'rgba(60,36,18,0.6)'; g.beginPath(); g.ellipse(kx, ky, 7, 4, 0, 0, 7); g.fill();
    }
    g.fillStyle = 'rgba(30,20,10,0.8)'; g.fillRect(0, p * ph, S, 2);
    h.fillStyle = '#303030'; h.fillRect(0, p * ph, S, 3);
    // nails
    for (const nx of [10, S / 2 + 6]) { g.fillStyle = '#3a3a3a'; g.fillRect(nx, p * ph + 8, 3, 3); g.fillRect(nx, p * ph + ph - 11, 3, 3); }
  }
});
// ---- Asphalt ground: aggregate, patches, cracks ----
TEX.asphalt = makeSurface(512, 53, 2.5, function (g, h, S, rnd) {
  g.fillStyle = '#3b3d42'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 60; i++) blob(g, S, rnd() * S, rnd() * S, 30 + rnd() * 110, 'rgba(' + (rnd() < 0.5 ? '25,26,30' : '80,78,74') + ',' + (0.06 + rnd() * 0.12) + ')');
  speckle(g, S, rnd, 16000, 1, 2.2, function (r) { const v = 40 + r() * 90 | 0; return 'rgba(' + v + ',' + v + ',' + (v + 3) + ',0.55)'; });
  speckle(h, S, rnd, 9000, 1, 2.2, function (r) { const v = 110 + r() * 110 | 0; return 'rgb(' + v + ',' + v + ',' + v + ')'; });
  // repaired patches
  for (let i = 0; i < 4; i++) {
    const x = rnd() * S, y = rnd() * S, w = 50 + rnd() * 110, hh = 40 + rnd() * 80;
    g.fillStyle = 'rgba(28,29,33,0.3)'; g.fillRect(x, y, w, hh);
    g.strokeStyle = 'rgba(20,20,22,0.4)'; g.lineWidth = 2; g.strokeRect(x, y, w, hh);
  }
  for (let i = 0; i < 10; i++) crack([g, h], S, rnd, rnd() * S, rnd() * S, 12 + rnd() * 30, [1.5, 2.5], ['rgba(15,15,18,0.75)', '#383838']);
});
// ---- Red hazard barrel (cylinder UV: u = around, v = height) ----
TEX.barrel = (function () {
  const S = 256, col = texCanvas(S), hgt = texCanvas(S), rnd = texRng(61);
  const g = col.g, h = hgt.g;
  g.fillStyle = '#9a2a20'; g.fillRect(0, 0, S, S);
  h.fillStyle = '#808080'; h.fillRect(0, 0, S, S);
  for (const y of [S * 0.18, S * 0.5, S * 0.82]) {   // rolling hoops
    g.fillStyle = 'rgba(40,10,8,0.45)'; g.fillRect(0, y - 5, S, 10);
    h.fillStyle = '#e0e0e0'; h.fillRect(0, y - 4, S, 8);
  }
  // hazard label: yellow diamond with flame
  for (const cx of [S * 0.25, S * 0.75]) {
    const cy = S * 0.34;
    g.fillStyle = '#e8b21c'; g.beginPath(); g.moveTo(cx, cy - 26); g.lineTo(cx + 26, cy); g.lineTo(cx, cy + 26); g.lineTo(cx - 26, cy); g.closePath(); g.fill();
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#1a1a1a'; g.beginPath();
    g.moveTo(cx, cy - 14); g.quadraticCurveTo(cx + 12, cy, cx + 6, cy + 12); g.lineTo(cx - 6, cy + 12); g.quadraticCurveTo(cx - 12, cy, cx, cy - 14); g.fill();
  }
  g.fillStyle = '#f1efe6'; g.font = 'bold 18px Arial'; g.textAlign = 'center';
  g.fillText('FLAMMABLE', S * 0.25, S * 0.66); g.fillText('FLAMMABLE', S * 0.75, S * 0.66);
  for (let i = 0; i < 80; i++) {   // scratches + rust
    g.strokeStyle = 'rgba(' + (rnd() < 0.5 ? '60,30,20' : '200,190,180') + ',' + (0.1 + rnd() * 0.25) + ')';
    g.lineWidth = 1; g.beginPath(); const x = rnd() * S, y = rnd() * S; g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 30, y + (rnd() - 0.5) * 8); g.stroke();
  }
  for (let i = 0; i < 18; i++) blob(g, S, rnd() * S, rnd() * S, 6 + rnd() * 22, 'rgba(90,45,20,' + (0.25 + rnd() * 0.3) + ')');
  return { map: toTex(col.c), normalMap: toTex(heightToNormal(hgt.c, 3)) };
})();
// ---- Painted steel (containers, fuel tanks, cars) — generic scuffed paint ----
TEX.paint = makeSurface(256, 71, 1.5, function (g, h, S, rnd) {
  g.fillStyle = '#b8b8b8'; g.fillRect(0, 0, S, S);   // neutral: tinted by material colour
  for (let i = 0; i < 30; i++) blob(g, S, rnd() * S, rnd() * S, 10 + rnd() * 40, 'rgba(70,60,50,' + (0.1 + rnd() * 0.2) + ')');
  for (let i = 0; i < 120; i++) {
    g.strokeStyle = 'rgba(' + (rnd() < 0.6 ? '240,240,240' : '60,50,40') + ',' + (0.1 + rnd() * 0.3) + ')';
    g.lineWidth = 1; g.beginPath(); const x = rnd() * S, y = rnd() * S; g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 24, y + (rnd() - 0.5) * 24); g.stroke();
  }
  speckle(g, S, rnd, 1200, 1, 2, function (r) { return 'rgba(80,70,60,' + (0.1 + r() * 0.2) + ')'; });
  speckle(h, S, rnd, 800, 1, 2, function (r) { const v = 100 + r() * 60 | 0; return 'rgb(' + v + ',' + v + ',' + v + ')'; });
});
// ---- Sandbag weave ----
TEX.sandbag = makeSurface(128, 83, 2.5, function (g, h, S, rnd) {
  g.fillStyle = '#8a7c5c'; g.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 3) { g.fillStyle = 'rgba(60,50,30,0.18)'; g.fillRect(0, y, S, 1); h.fillStyle = '#606060'; h.fillRect(0, y, S, 1); }
  for (let x = 0; x < S; x += 3) { g.fillStyle = 'rgba(60,50,30,0.12)'; g.fillRect(x, 0, 1, S); h.fillStyle = '#707070'; h.fillRect(x, 0, 1, S); }
  for (let i = 0; i < 12; i++) blob(g, S, rnd() * S, rnd() * S, 8 + rnd() * 24, 'rgba(50,40,25,' + (0.12 + rnd() * 0.2) + ')');
});
// ---- Small gun-finish noise (cerakote / polymer) normal ----
TEX.gunNoise = makeSurface(128, 97, 1.2, function (g, h, S, rnd) {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  speckle(g, S, rnd, 900, 1, 2, function (r) { return 'rgba(0,0,0,' + (0.04 + r() * 0.08) + ')'; });
  speckle(h, S, rnd, 2500, 1, 2, function (r) { const v = 90 + r() * 90 | 0; return 'rgb(' + v + ',' + v + ',' + v + ')'; });
});
// ---- Camo cloth (sleeves / enemy uniforms) ----
TEX.camo = makeSurface(256, 101, 2.0, function (g, h, S, rnd) {
  g.fillStyle = '#6a6b52'; g.fillRect(0, 0, S, S);
  const cols = ['rgba(84,74,52,0.9)', 'rgba(46,52,38,0.9)', 'rgba(118,112,84,0.8)'];
  for (let i = 0; i < 60; i++) {
    const x = rnd() * S, y = rnd() * S, r = 10 + rnd() * 26, c = cols[i % 3];
    wrapDraw(S, x, y, r * 1.6, function (px, py) {
      g.fillStyle = c; g.beginPath(); g.ellipse(px, py, r * (1 + rnd() * 0.6), r * (0.5 + rnd() * 0.4), rnd() * 3, 0, 7); g.fill();
    });
  }
  for (let y = 0; y < S; y += 2) { g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(0, y, S, 1); h.fillStyle = '#707070'; h.fillRect(0, y, S, 1); }
});
// ---- City skyline windows (mostly dark: it is a blackout) ----
TEX.skyline = (function () {
  const W = 256, H = 256, cv = texCanvas(W, H), g = cv.g, rnd = texRng(113);
  g.fillStyle = '#17191e'; g.fillRect(0, 0, W, H);
  for (let y = 6; y < H - 4; y += 12) for (let x = 5; x < W - 4; x += 10) {
    const r = rnd();
    g.fillStyle = r < 0.035 ? 'rgb(255,196,120)' : r < 0.05 ? 'rgb(170,200,255)' : 'rgb(20,22,27)';
    g.fillRect(x, y, 6, 7);
  }
  return toTex(cv.c);
})();

// ---- Particle sprites (alpha in the red channel is unnecessary: RGBA canvases) ----
function spriteTex(size, draw) {
  const cv = texCanvas(size); draw(cv.g, size);
  const t = new THREE.CanvasTexture(cv.c);
  return t;
}
TEX.softDot = spriteTex(64, function (g, S) {
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
});
TEX.smoke = spriteTex(128, function (g, S) {
  const rnd = texRng(7);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * S * 0.22;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d, r = S * (0.14 + rnd() * 0.16);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const v = 200 + rnd() * 55 | 0;
    gr.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',0.35)'); gr.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
});
TEX.flash = spriteTex(128, function (g, S) {
  g.translate(S / 2, S / 2);
  for (let i = 0; i < 6; i++) {
    g.rotate(Math.PI / 3);
    const gr = g.createLinearGradient(0, 0, S / 2, 0);
    gr.addColorStop(0, 'rgba(255,240,200,1)'); gr.addColorStop(1, 'rgba(255,160,60,0)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, -S * 0.06); g.lineTo(S / 2, 0); g.lineTo(0, S * 0.06); g.fill();
  }
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.3);
  gr.addColorStop(0, 'rgba(255,255,240,1)'); gr.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = gr; g.fillRect(-S / 2, -S / 2, S, S);
});
// Decals: blood splat and blast scorch (alpha-blended)
TEX.bloodSplat = spriteTex(128, function (g, S) {
  const rnd = texRng(131);
  g.fillStyle = 'rgba(90,6,6,0.9)';
  for (let i = 0; i < 14; i++) {
    const a = rnd() * 7, d = rnd() * S * 0.3, r = S * (0.04 + rnd() * 0.12);
    g.beginPath(); g.arc(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, r, 0, 7); g.fill();
  }
  for (let i = 0; i < 20; i++) {
    const a = rnd() * 7, d = S * (0.3 + rnd() * 0.18);
    g.beginPath(); g.arc(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, 1 + rnd() * 3, 0, 7); g.fill();
  }
});
TEX.scorch = spriteTex(256, function (g, S) {
  const rnd = texRng(137);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(8,6,5,0.95)'); gr.addColorStop(0.45, 'rgba(15,12,10,0.8)'); gr.addColorStop(1, 'rgba(20,18,16,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(5,4,3,0.6)';
  for (let i = 0; i < 40; i++) {
    const a = rnd() * 7; g.lineWidth = 1 + rnd() * 3;
    g.beginPath(); g.moveTo(S / 2 + Math.cos(a) * S * 0.15, S / 2 + Math.sin(a) * S * 0.15);
    g.lineTo(S / 2 + Math.cos(a) * S * (0.3 + rnd() * 0.2), S / 2 + Math.sin(a) * S * (0.3 + rnd() * 0.2)); g.stroke();
  }
});
TEX.bulletHole = spriteTex(64, function (g, S) {
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(5,5,6,1)'); gr.addColorStop(0.28, 'rgba(10,10,12,0.95)'); gr.addColorStop(0.4, 'rgba(60,58,55,0.55)'); gr.addColorStop(1, 'rgba(60,58,55,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
});

// Scale a BoxGeometry's per-face UVs by its real dimensions so textures keep a
// constant world size (bricks do not stretch on long walls). texSize = metres per tile.
// BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each).
function boxWorldUV(geo, w, h, d, texSize, seed) {
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const r = texRng(seed || 1);
  for (let f = 0; f < 6; f++) {
    const ou = r(), ov = f === 2 || f === 3 ? r() : 0;   // vertical faces keep v anchored at ground (soot bands)
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0] / texSize + ou, uv.getY(i) * dims[f][1] / texSize + ov);
    }
  }
  uv.needsUpdate = true;
  return geo;
}
