// ============ POST-PROCESSING: HDR, BLOOM, GRADING ============
'use strict';
// World + viewmodel render into an (MSAA) HDR target; a bright-pass feeds a
// two-level gaussian bloom; the composite pass applies ACES tone mapping,
// colour grading, vignette, chromatic aberration, grain and damage effects,
// then encodes to sRGB. Falls back to plain rendering when unsupported/disabled.
const FOG_BASE = CFG.world.fogColor;
const POST = {
  enabled: false, hdr: false, rt: null, bright: null, a1: null, b1: null, a2: null, b2: null,
  quad: null, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), scene: new THREE.Scene(),
  mats: {}, damage: 0, aberration: 0, lowHealth: 0, flash: 0, failed: false
};
const PFX_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
function postMat(frag, uniforms, defines) {
  return new THREE.ShaderMaterial({ vertexShader: PFX_VERT, fragmentShader: frag, uniforms: uniforms, defines: defines || {}, depthTest: false, depthWrite: false });
}
(function buildPostMaterials() {
  // fullscreen triangle
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  POST.quad = new THREE.Mesh(g, null);
  POST.quad.frustumCulled = false;
  POST.scene.add(POST.quad);
  POST.mats.bright = postMat([
    'uniform sampler2D tSrc; uniform float threshold; varying vec2 vUv;',
    'void main(){ vec3 c = texture2D(tSrc, vUv).rgb; float br = max(c.r, max(c.g, c.b));',
    '  float w = smoothstep(threshold, threshold * 1.8, br); gl_FragColor = vec4(min(c * w, vec3(24.0)), 1.0); }'
  ].join('\n'), { tSrc: { value: null }, threshold: { value: 1.0 } });
  POST.mats.blur = postMat([
    'uniform sampler2D tSrc; uniform vec2 dir; varying vec2 vUv;',
    'void main(){',
    '  vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;',
    '  s += texture2D(tSrc, vUv + dir * 1.3846153).rgb * 0.3162162; s += texture2D(tSrc, vUv - dir * 1.3846153).rgb * 0.3162162;',
    '  s += texture2D(tSrc, vUv + dir * 3.2307692).rgb * 0.0702703; s += texture2D(tSrc, vUv - dir * 3.2307692).rgb * 0.0702703;',
    '  gl_FragColor = vec4(s, 1.0); }'
  ].join('\n'), { tSrc: { value: null }, dir: { value: new THREE.Vector2() } });
  POST.mats.copy = postMat('uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }', { tSrc: { value: null } });
  POST.mats.composite = postMat([
    'uniform sampler2D tScene, tBloom1, tBloom2; uniform float bloom, exposure, time, damage, aberration, lowHealth, flash, vignette; uniform vec2 res;',
    'varying vec2 vUv;',
    'vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }',
    'vec3 aces(vec3 c){',
    '  const mat3 IM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);',
    '  const mat3 OM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);',
    '  c *= exposure / 0.6; c = IM * c; c = RRTAndODTFit(c); c = OM * c; return clamp(c, 0.0, 1.0); }',
    'vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c)); }',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main(){',
    '  vec2 d = vUv - 0.5; float r2 = dot(d, d);',
    '  float ca = (0.0012 + aberration * 0.012) * r2 * 4.0;',
    '  vec3 c;',
    '  c.r = texture2D(tScene, vUv + d * ca).r; c.g = texture2D(tScene, vUv).g; c.b = texture2D(tScene, vUv - d * ca).b;',
    '  c += (texture2D(tBloom1, vUv).rgb * 0.55 + texture2D(tBloom2, vUv).rgb * 0.8) * bloom;',
    '#ifdef HDR',
    '  c = aces(c);',
    '#endif',
    '  // grading: gentle contrast S-curve, teal shadows / warm highlights',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(c, c * vec3(0.93, 1.0, 1.07), (1.0 - smoothstep(0.0, 0.35, l)) * 0.6);',
    '  c = mix(c, c * vec3(1.05, 1.0, 0.94), smoothstep(0.45, 1.0, l) * 0.5);',
    '  c = mix(vec3(l), c, 1.08 - lowHealth * 0.75);',
    '  c = clamp((c - 0.5) * 1.06 + 0.5, 0.0, 1.0);',
    '  // vignette + damage/low-health red edge',
    '  float vig = 1.0 - smoothstep(0.2, 0.85, r2 * vignette);',
    '  c *= mix(0.62, 1.0, vig);',
    '  float edge = smoothstep(0.08, 0.45, r2);',
    '  c = mix(c, vec3(0.5, 0.02, 0.01), edge * clamp(damage * 0.8 + lowHealth * 0.45, 0.0, 0.85));',
    '  c = mix(c, vec3(1.0, 0.96, 0.9), flash);',
    '  c = toSRGB(c);',
    '  c += (hash(vUv * res + time) - 0.5) * 0.035;',   // film grain (post-encode: dithers banding too)
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n'), {
    tScene: { value: null }, tBloom1: { value: null }, tBloom2: { value: null },
    bloom: { value: 0.9 }, exposure: { value: 1.0 }, time: { value: 0 }, damage: { value: 0 },
    aberration: { value: 0 }, lowHealth: { value: 0 }, flash: { value: 0 }, vignette: { value: 1.0 },
    res: { value: new THREE.Vector2(1, 1) }
  });
})();

function disposePostTargets() {
  for (const k of ['rt', 'bright', 'a1', 'b1', 'a2', 'b2']) { if (POST[k]) { POST[k].dispose(); POST[k] = null; } }
}
function makeRT(w, h, type, msaa) {
  const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: type, depthBuffer: true };
  if (msaa && THREE.WebGLMultisampleRenderTarget) {
    const rt = new THREE.WebGLMultisampleRenderTarget(w, h, opts);
    rt.samples = 4;
    return rt;
  }
  return new THREE.WebGLRenderTarget(w, h, opts);
}
function initPostfx() {
  disposePostTargets();
  POST.enabled = false;
  if (!QUALITY.postfx || POST.failed) { applyToneMappingMode(false); return; }
  const caps = renderer.capabilities;
  const ext = renderer.extensions;
  const floatOK = caps.isWebGL2 && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
  POST.hdr = !!floatOK;
  const type = POST.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(1, size.x), h = Math.max(1, size.y);
  try {
    POST.rt = makeRT(w, h, type, QUALITY.msaa && caps.isWebGL2);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1), qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    POST.bright = makeRT(hw, hh, type);
    POST.a1 = makeRT(qw, qh, type); POST.b1 = makeRT(qw, qh, type);
    POST.a2 = makeRT(Math.max(1, w >> 3), Math.max(1, h >> 3), type); POST.b2 = makeRT(Math.max(1, w >> 3), Math.max(1, h >> 3), type);
    for (const k of ['bright', 'a1', 'b1', 'a2', 'b2']) POST[k].depthBuffer = false;
    POST.mats.composite.defines = POST.hdr ? { HDR: 1 } : {};
    POST.mats.composite.needsUpdate = true;
    POST.mats.composite.uniforms.res.value.set(w, h);
    POST.mats.bright.uniforms.threshold.value = POST.hdr ? 1.0 : 0.82;
    POST.enabled = true;
  } catch (e) {
    console.warn('post-processing unavailable, rendering directly', e);
    disposePostTargets();
    POST.failed = true;
  }
  applyToneMappingMode(POST.enabled && POST.hdr);
}
// HDR path: materials write linear HDR (no tone mapping), composite applies ACES.
// Fog is blended after tone mapping inside materials, so its colour must match
// the space the material writes into.
function applyToneMappingMode(hdr) {
  const tm = hdr ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  if (renderer.toneMapping !== tm) {
    renderer.toneMapping = tm;
    scene.traverse(function (o) { if (o.material && o.material.isMaterial) o.material.needsUpdate = true; });
    gunScene.traverse(function (o) { if (o.material && o.material.isMaterial) o.material.needsUpdate = true; });
  }
  scene.fog.color.setHex(FOG_BASE);
  if (POST.enabled) scene.fog.color.convertSRGBToLinear();
}
function postfxResize() {
  if (!POST.enabled) return;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(1, size.x), h = Math.max(1, size.y);
  POST.rt.setSize(w, h);
  POST.bright.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  POST.a1.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2)); POST.b1.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  POST.a2.setSize(Math.max(1, w >> 3), Math.max(1, h >> 3)); POST.b2.setSize(Math.max(1, w >> 3), Math.max(1, h >> 3));
  POST.mats.composite.uniforms.res.value.set(w, h);
}
function postPass(mat, target) {
  POST.quad.material = mat;
  renderer.setRenderTarget(target);
  renderer.render(POST.scene, POST.cam);
}
function blurPass(src, tmp, w, h) {
  const b = POST.mats.blur;
  b.uniforms.tSrc.value = src.texture; b.uniforms.dir.value.set(1 / w, 0); postPass(b, tmp);
  b.uniforms.tSrc.value = tmp.texture; b.uniforms.dir.value.set(0, 1 / h); postPass(b, src);
}
// Effect intensities decay here; gameplay code bumps them (damage, explosions).
function postKick(kind, amount) {
  if (kind === 'damage') POST.damage = Math.min(1, POST.damage + amount);
  else if (kind === 'aberration') POST.aberration = Math.min(1, POST.aberration + amount);
  else if (kind === 'flash') POST.flash = Math.min(0.9, POST.flash + amount);
}
function renderWorld(showGun) {
  renderer.render(scene, camera);
  if (showGun) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(gunScene, gunCamera);
    renderer.autoClear = true;
  }
}
function renderFrame(dt, showGun) {
  POST.damage = Math.max(0, POST.damage - dt * 2.2);
  POST.aberration = Math.max(0, POST.aberration - dt * 1.6);
  POST.flash = Math.max(0, POST.flash - dt * 3.5);
  const hpFrac = started && !player.dead ? player.health / CFG.player.health : 1;
  POST.lowHealth += ((hpFrac < 0.35 ? (0.35 - hpFrac) / 0.35 : 0) - POST.lowHealth) * Math.min(1, dt * 3);
  renderer.autoClear = true;
  if (!POST.enabled) {
    renderer.setRenderTarget(null);
    renderWorld(showGun);
    // DOM fallbacks for the shader-driven effects
    hud.flash.style.opacity = POST.flash > 0.01 ? String(POST.flash) : '0';
    return;
  }
  try {
    renderer.setRenderTarget(POST.rt);
    renderer.clear();
    renderWorld(showGun);
    POST.mats.bright.uniforms.tSrc.value = POST.rt.texture;
    postPass(POST.mats.bright, POST.bright);
    // level 1 (1/4 res) and level 2 (1/8 res) blur pyramids
    POST.mats.copy.uniforms.tSrc.value = POST.bright.texture; postPass(POST.mats.copy, POST.a1);
    blurPass(POST.a1, POST.b1, POST.a1.width, POST.a1.height);
    POST.mats.copy.uniforms.tSrc.value = POST.a1.texture; postPass(POST.mats.copy, POST.a2);
    blurPass(POST.a2, POST.b2, POST.a2.width, POST.a2.height);
    blurPass(POST.a2, POST.b2, POST.a2.width, POST.a2.height);
    const u = POST.mats.composite.uniforms;
    u.tScene.value = POST.rt.texture; u.tBloom1.value = POST.a1.texture; u.tBloom2.value = POST.a2.texture;
    u.bloom.value = QUALITY.bloom ? (POST.hdr ? 0.75 : 0.5) : 0;
    u.time.value = (u.time.value + dt * 60) % 1000;
    u.damage.value = POST.damage; u.aberration.value = POST.aberration; u.lowHealth.value = POST.lowHealth; u.flash.value = POST.flash;
    postPass(POST.mats.composite, null);
    hud.flash.style.opacity = '0';
  } catch (e) {
    console.warn('post-processing failed, disabling', e);
    POST.failed = true; disposePostTargets(); POST.enabled = false; applyToneMappingMode(false);
    renderer.setRenderTarget(null);
    renderWorld(showGun);
  }
}
initPostfx();
