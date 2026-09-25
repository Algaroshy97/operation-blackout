// ============ POST-PROCESSING: HDR, BLOOM, GRADING ============
'use strict';
// The world renders into an MSAA half-float target; a bright pass feeds a
// two-level gaussian bloom; the composite applies the same ACES curve and
// exposure the renderer would have used, a light colour grade, vignette, lens
// fringing and grain, then encodes to sRGB itself.
//
// r152+ skips tone mapping and the output colour-space transform whenever a
// render target is bound, so nothing about the materials changes between the
// two paths: they write linear HDR into the target and the composite finishes
// the job. The one exception is fog, which three blends AFTER the output
// transform — on the direct path in display space, here in linear space — so
// its colour is converted to match while post-FX is on.
//
// Falls back to plain rendering on low quality, on phones unless the player
// picks HIGH, and permanently after any GPU error.
const FOG_BASE = CFG.world.fogColor;
const POST = {
  enabled: false, hdr: false, failed: false,
  rt: null, bright: null, a1: null, b1: null, a2: null, b2: null,
  quad: null, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), scene: new THREE.Scene(),
  mats: {}, kick: 0, size: new THREE.Vector2()
};
const PFX_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
function postMat(frag, uniforms) {
  return new THREE.ShaderMaterial({ vertexShader: PFX_VERT, fragmentShader: frag, uniforms: uniforms, depthTest: false, depthWrite: false, toneMapped: false });
}
(function buildPostMaterials() {
  // one fullscreen triangle
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
    'uniform sampler2D tScene, tBloom1, tBloom2; uniform float bloom, exposure, time, fringe; uniform vec2 res;',
    'varying vec2 vUv;',
    // three's ACESFilmicToneMapping, verbatim, so both paths share one curve
    'vec3 pfxRRTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }',
    'vec3 pfxAces(vec3 c){',
    '  const mat3 IM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);',
    '  const mat3 OM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);',
    '  c *= exposure / 0.6; c = IM * c; c = pfxRRTFit(c); c = OM * c; return clamp(c, 0.0, 1.0); }',
    'vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c)); }',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main(){',
    '  vec2 d = vUv - 0.5; float r2 = dot(d, d);',
    '  float ca = (0.0010 + fringe * 0.010) * r2 * 4.0;',
    '  vec3 c;',
    '  c.r = texture2D(tScene, vUv + d * ca).r; c.g = texture2D(tScene, vUv).g; c.b = texture2D(tScene, vUv - d * ca).b;',
    '  c += (texture2D(tBloom1, vUv).rgb * 0.55 + texture2D(tBloom2, vUv).rgb * 0.8) * bloom;',
    '  c = pfxAces(c);',
    // grade: cool the shadows, warm the highlights, a touch more saturation and contrast
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(c, c * vec3(0.94, 1.0, 1.06), (1.0 - smoothstep(0.0, 0.35, l)) * 0.6);',
    '  c = mix(c, c * vec3(1.04, 1.0, 0.95), smoothstep(0.45, 1.0, l) * 0.5);',
    '  c = mix(vec3(l), c, 1.08);',
    '  c = clamp((c - 0.5) * 1.05 + 0.5, 0.0, 1.0);',
    '  c *= mix(0.7, 1.0, 1.0 - smoothstep(0.2, 0.85, r2));',
    '  c = toSRGB(c);',
    '  c += (hash(vUv * res + time) - 0.5) * 0.025;',   // grain, post-encode so it also dithers banding
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n'), {
    tScene: { value: null }, tBloom1: { value: null }, tBloom2: { value: null },
    bloom: { value: 0.7 }, exposure: { value: 0.9 }, time: { value: 0 }, fringe: { value: 0 },
    res: { value: new THREE.Vector2(1, 1) }
  });
})();

function postfxWanted() {
  const q = getSetting('quality');
  if (q === 'low') return false;
  if (IS_TOUCH) return q === 'high';
  return true;
}
function disposePostTargets() {
  ['rt', 'bright', 'a1', 'b1', 'a2', 'b2'].forEach(function (k) { if (POST[k]) { POST[k].dispose(); POST[k] = null; } });
}
function makeRT(w, h, type, samples, depth) {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: type,
    depthBuffer: !!depth, samples: samples || 0
  });
}
function applyPostFog() {
  scene.fog.color.setHex(FOG_BASE);
  if (POST.enabled) scene.fog.color.convertSRGBToLinear();
}
function initPostfx() {
  disposePostTargets();
  POST.enabled = false;
  if (postfxWanted() && !POST.failed) {
    const ext = renderer.extensions;
    POST.hdr = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    // Without a float target the HDR range above 1.0 is clipped before the tone
    // map, which would flatten every highlight: better to not post-process at all.
    if (POST.hdr) {
      try {
        const size = renderer.getDrawingBufferSize(POST.size);
        const w = Math.max(1, size.x), h = Math.max(1, size.y);
        const samples = getSetting('quality') === 'medium' ? 0 : 4;
        POST.rt = makeRT(w, h, THREE.HalfFloatType, samples, true);
        POST.bright = makeRT(1, 1, THREE.HalfFloatType);
        POST.a1 = makeRT(1, 1, THREE.HalfFloatType); POST.b1 = makeRT(1, 1, THREE.HalfFloatType);
        POST.a2 = makeRT(1, 1, THREE.HalfFloatType); POST.b2 = makeRT(1, 1, THREE.HalfFloatType);
        POST.enabled = true;
        postfxResize(w, h);
      } catch (e) {
        console.warn('post-processing unavailable, rendering directly', e);
        disposePostTargets();
        POST.failed = true;
      }
    }
  }
  applyPostFog();
}
function postfxResize(w, h) {
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
function blurPass(src, tmp) {
  const b = POST.mats.blur;
  b.uniforms.tSrc.value = src.texture; b.uniforms.dir.value.set(1 / src.width, 0); postPass(b, tmp);
  b.uniforms.tSrc.value = tmp.texture; b.uniforms.dir.value.set(0, 1 / src.height); postPass(b, src);
}
// Gameplay nudges the lens (explosions, heavy hits); it relaxes on its own.
function postKick(amount) { POST.kick = Math.min(1, POST.kick + amount); }
function renderFrame(dt) {
  // frame() can hand over a negative step (rAF stamps trail performance.now()).
  if (!(dt > 0)) dt = 0;
  POST.kick = Math.max(0, POST.kick - dt * 1.6);
  if (!POST.enabled) {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return;
  }
  try {
    // The adaptive-resolution loop changes the pixel ratio under us: follow it.
    const size = renderer.getDrawingBufferSize(POST.size);
    if (size.x !== POST.rt.width || size.y !== POST.rt.height) postfxResize(Math.max(1, size.x), Math.max(1, size.y));
    renderer.setRenderTarget(POST.rt);
    renderer.render(scene, camera);
    POST.mats.bright.uniforms.tSrc.value = POST.rt.texture;
    postPass(POST.mats.bright, POST.bright);
    // 1/4 and 1/8 resolution blur levels: a tight core plus a wide glow
    POST.mats.copy.uniforms.tSrc.value = POST.bright.texture; postPass(POST.mats.copy, POST.a1);
    blurPass(POST.a1, POST.b1);
    POST.mats.copy.uniforms.tSrc.value = POST.a1.texture; postPass(POST.mats.copy, POST.a2);
    blurPass(POST.a2, POST.b2);
    blurPass(POST.a2, POST.b2);
    const u = POST.mats.composite.uniforms;
    u.tScene.value = POST.rt.texture; u.tBloom1.value = POST.a1.texture; u.tBloom2.value = POST.a2.texture;
    u.exposure.value = renderer.toneMappingExposure;
    u.time.value = (u.time.value + dt * 60) % 1000;
    u.fringe.value = getSetting('reducedMotion') ? 0 : POST.kick;
    postPass(POST.mats.composite, null);
  } catch (e) {
    console.warn('post-processing failed, disabling', e);
    POST.failed = true; disposePostTargets(); POST.enabled = false; applyPostFog();
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
}
