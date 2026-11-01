// ==UserScript==
// @name         YouTube Deband (mpv / libplacebo)
// @namespace    youtube-deband
// @version      1.13.1
// @description  Debands YouTube video in WebGPU or WebGL using a port of mpv's deband shaders (vo=gpu-next / libplacebo and legacy vo=gpu), with mpv's parameters.
// @match        *://*.youtube.com/*
// @match        *://www.youtube-nocookie.com/*
// @exclude      *://music.youtube.com/*
// @license      LGPL-2.1-or-later
// @homepageURL  https://github.com/Pagal3/youtube-deband
// @downloadURL  https://raw.githubusercontent.com/Pagal3/youtube-deband/main/youtube-deband.user.js
// @updateURL    https://raw.githubusercontent.com/Pagal3/youtube-deband/main/youtube-deband.user.js
// @grant        none
// @inject-into  content
// @run-at       document-start
// ==/UserScript==

/*
 * How it works
 *
 * mpv debands the decoded planes (Y and the subsampled CbCr) before any color
 * conversion. A browser only hands out RGB, so this script reverses the
 * browser's YCbCr->RGB conversion, rebuilds a full-res Y plane and a half-res
 * CbCr plane, debands each plane at its own resolution exactly like mpv does
 * (so the chroma radius is in chroma pixels and the PRNG is seeded per plane
 * pixel), then converts back to RGB and draws onto a canvas laid over the
 * <video>. Luma is debanded inside that final pass to save a render target.
 * Optionally the browser's chroma upscaling is replaced with Chroma from
 * Luma prediction on the rebuilt planes.
 *
 * Renders with WebGPU where the browser has it, otherwise WebGL2, otherwise
 * WebGL1. WebGPU imports the video frame as an external texture instead of
 * uploading a copy of it.
 *
 * Shaders:
 *   gpu-next: libplacebo src/shaders/sampling.c pl_shader_deband() with
 *             mpv's option mapping from video/out/vo_gpu_next.c
 *   gpu:      mpv video/out/gpu/video_shaders.c pass_sample_deband()
 *   fast:     gpu-next cut down to one pass over the RGB frame, for weak GPUs
 *   fastest:  fast worked out at half resolution, for integrated GPUs
 *   CfL:      CfL_Prediction.glsl and CfL_Prediction_Lite.glsl from
 *             github.com/Artoriuz/glsl-chroma-from-luma-prediction (MIT,
 *             notice with the port)
 *
 * Hotkeys (default): Ctrl+Alt+D toggles debanding, Ctrl+Alt+B opens the
 * settings panel; both can be re-recorded in the panel. The DB button in the
 * player's control bar also opens the panel.
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'yt-deband-settings';
    const PRESETS_KEY = 'yt-deband-presets'; // the user's own presets, apart so Reset keeps them
    const PANEL_POS_KEY = 'yt-deband-panel-pos'; // where the panel was dragged to, apart so Reset keeps it
    const VERSION = '1.13.1'; // keep in sync with @version

    // Option ranges match mpv's deband_conf (video/out/gpu/video_shaders.c)
    const DEFAULTS = {
        enabled: true,
        algo: 'gpu-next',   // 'gpu-next' (libplacebo) | 'gpu' (legacy mpv shader) | 'fast' (single pass) | 'fastest' (half resolution)
        iterations: 1,      // --deband-iterations=<0..16>
        threshold: 48,      // --deband-threshold=<0..4096>
        range: 16,          // --deband-range=<1..64>
        grain: 32,          // --deband-grain=<0..4096>
        preset: 'Default',  // preset picked last, shown while the four values above still match it
        chroma: 'browser',  // chroma upscaling: 'browser' (keep its) | 'cfl' | 'cfl-lite' (Chroma from Luma)
        matrix: '709',      // YCbCr matrix the browser used to make RGB
        snap: true,         // round the recovered luma to the 8-bit code grid
        dither: true,       // dither the output down to 8 bits like mpv does
        precision: 'byte',  // video upload format: 'byte' (RGBA8) | 'half' (RGBA16F); WebGL2 and WebGPU copies.
                            // Browsers hand over the frame as 8-bit RGB, so RGBA16F gains nothing
        backend: 'auto',    // 'auto' | 'webgpu' | 'webgl2' | 'webgl1'
        hotkeyToggle: 'Ctrl+Alt+d',
        hotkeyPanel: 'Ctrl+Alt+b',
        split: false,       // left half original, right half debanded
        revision: 1,        // of the saved settings, for one-time migrations in loadSettings
    };
    const LIMITS = {
        iterations: [0, 16],
        threshold: [0, 4096],
        range: [1, 64],
        grain: [0, 4096],
    };
    const MATRICES = { '709': [0.2126, 0.0722], '601': [0.299, 0.114] };

    // A preset sets the four deband parameters; the mode and the rest stay
    const PRESET_KEYS = ['iterations', 'threshold', 'range', 'grain'];
    const FACTORY_PRESETS = [
        { name: 'Default', iterations: 1, threshold: 48, range: 16, grain: 32,
          about: 'mpv\'s defaults: a light touch that keeps fine detail.' },
        { name: 'Subtle', iterations: 1, threshold: 32, range: 16, grain: 16,
          about: 'Only the faintest steps, with little grain. For high bitrate 1080p and up.' },
        { name: 'Animation', iterations: 4, threshold: 35, range: 16, grain: 4,
          about: 'Four gentle passes and almost no grain, which would show on the flat colors of anime and cartoons.' },
        { name: 'Strong', iterations: 4, threshold: 64, range: 20, grain: 32,
          about: 'Four wide passes: smooths broad bands in skies, fog and gradients.' },
        { name: 'Aggressive', iterations: 4, threshold: 100, range: 8, grain: 32,
          about: 'A high threshold over a short reach: flattens hard, close-set steps like blocky dark scenes. Softens fine texture.' },
        { name: 'Low bitrate', iterations: 4, threshold: 128, range: 16, grain: 48,
          about: 'For 480p and below or heavily compressed uploads: smooths hard and adds grain to hide the rest. Loses fine texture.' },
    ];

    const settings = loadSettings();
    let customPresets = loadPresets();
    console.info(`[yt-deband] ${VERSION} running; ${settings.hotkeyPanel} or the DB player button opens the settings`);

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            // Before revision 1 Half float was the default upload format, so
            // nearly every saved copy holds it; it gains nothing, so move off it
            if (!(saved.revision >= 1))
                saved.precision = 'byte';
            return Object.assign({}, DEFAULTS, saved, { revision: DEFAULTS.revision });
        } catch (e) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) { /* storage blocked, keep in memory */ }
    }

    // The user's presets: [{ name, iterations, threshold, range, grain }]
    function loadPresets() {
        try {
            const saved = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
            return saved.filter((p) => p && typeof p.name === 'string' &&
                                       PRESET_KEYS.every((k) => typeof p[k] === 'number'));
        } catch (e) {
            return [];
        }
    }

    function savePresets() {
        try {
            localStorage.setItem(PRESETS_KEY, JSON.stringify(customPresets));
        } catch (e) { /* storage blocked, keep in memory */ }
    }

    // Pick up presets saved or deleted in another tab
    window.addEventListener('storage', (e) => {
        if (e.key === PRESETS_KEY) {
            customPresets = loadPresets();
            refreshPanel();
        }
    });

    // ------------------------------------------------------------------
    // Shaders
    //
    // Written in the common subset of GLSL ES 1.00 and 3.00 so the same code
    // runs on WebGL2 and on WebGL1 (Tor/Mullvad Browser disable WebGL2 and
    // hide extensions). Differences are handled with these defines:
    //   TEX/FRAG   texture lookup and fragment output
    //   PACKED     planes are stored as 16-bit fixed point split over two
    //              8-bit channels, for contexts without float render targets
    //   UINT_PRNG  integer pcg3d; otherwise an exact emulation with floats
    // ------------------------------------------------------------------

    const VS1 = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;
    const VS2 = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

    function fsHeader(caps) {
        return (caps.webgl2
            ? '#version 300 es\nprecision highp float;\nprecision highp int;\nout vec4 o_frag;\n#define FRAG o_frag\n#define TEX texture\n'
            : 'precision highp float;\n#define FRAG gl_FragColor\n#define TEX texture2D\n')
            + (caps.packed ? '#define PACKED 1\n' : '')
            + (caps.uintPrng ? '#define UINT_PRNG 1\n' : '')
            + PLANE_IO;
    }

    const PLANE_IO = `
vec2 pack16(float v) {
    float q = floor(clamp(v, 0.0, 1.0) * 65535.0 + 0.5);
    float hi = floor(q / 256.0);
    return vec2(hi, q - hi * 256.0) / 255.0;
}
float unpack16(vec2 e) {
    e = floor(e * 255.0 + 0.5);
    return (e.x * 256.0 + e.y) / 65535.0;
}

// A plane has up to two components (Y, or Cb and Cr)
vec4 storePlane(vec2 v) {
#ifdef PACKED
    return vec4(pack16(v.x), pack16(v.y));
#else
    return vec4(v, 0.0, 1.0);
#endif
}
vec2 loadPlane(sampler2D t, vec2 uv) {
    vec4 c = TEX(t, uv);
#ifdef PACKED
    return vec2(unpack16(c.rg), unpack16(c.ba));
#else
    return c.rg;
#endif
}
// Packed planes can't hold negative values, so changes are stored offset
#ifdef PACKED
#define DELTA_BIAS 0.5
#else
#define DELTA_BIAS 0.0
#endif
// Bilinear sampling, done by hand when the plane is packed
vec2 loadPlaneLinear(sampler2D t, vec2 uv, vec2 size) {
#ifdef PACKED
    vec2 p = uv * size - 0.5;
    vec2 f = fract(p);
    vec2 b = (floor(p) + 0.5) / size;
    vec2 d = 1.0 / size;
    return mix(mix(loadPlane(t, b),                   loadPlane(t, b + vec2(d.x, 0.0)), f.x),
               mix(loadPlane(t, b + vec2(0.0, d.y)), loadPlane(t, b + d),              f.x), f.y);
#else
    return TEX(t, uv).rg;
#endif
}
`;

    // Limited range YCbCr, normalized the way libplacebo sees an 8-bit plane
    // (code value / 255)
    const YCC = `
uniform vec2 u_k; // Kr, Kb
vec3 rgb2ycc(vec3 c) {
    float kr = u_k.x, kb = u_k.y, kg = 1.0 - kr - kb;
    float y = kr * c.r + kg * c.g + kb * c.b;
    return vec3(16.0  + 219.0 * y,
                128.0 + 224.0 * (c.b - y) / (2.0 - 2.0 * kb),
                128.0 + 224.0 * (c.r - y) / (2.0 - 2.0 * kr)) / 255.0;
}
// RGB change for a YCbCr change (the linear part of YCbCr -> RGB)
vec3 dycc2rgb(vec3 d) {
    float kr = u_k.x, kb = u_k.y, kg = 1.0 - kr - kb;
    float y  = d.x * 255.0 / 219.0;
    float cb = d.y * 255.0 / 224.0;
    float cr = d.z * 255.0 / 224.0;
    float r = y + (2.0 - 2.0 * kr) * cr;
    float b = y + (2.0 - 2.0 * kb) * cb;
    return vec3(r, (y - kr * r - kb * b) / kg, b);
}`;

    // Full resolution luma plane
    const FS_PREP_Y = YCC + `
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform bool u_snap;
void main() {
    float y = rgb2ycc(TEX(u_src, gl_FragCoord.xy / u_srcSize).rgb).x;
    if (u_snap)
        y = floor(y * 255.0 + 0.5) / 255.0;
    FRAG = storePlane(vec2(y, 0.0));
}`;

    // Half resolution (4:2:0) chroma plane, center sited: the average of each
    // 2x2 block. YCbCr is linear in RGB, so one bilinear fetch from the
    // block's middle averages it (clamping to the edge for odd sizes).
    // With u_luma it makes luma at that resolution instead, for CfL Lite
    // (libplacebo samples its LUMA there bilinearly, which is the same).
    const FS_PREP_C = YCC + `
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform bool u_luma;
void main() {
    vec2 mid = floor(gl_FragCoord.xy) * 2.0 + 1.0;
    vec3 c = rgb2ycc(TEX(u_src, mid / u_srcSize).rgb);
    FRAG = storePlane(u_luma ? vec2(c.x, 0.0) : c.yz);
}`;

    // Luma at chroma resolution for the full CfL: the 4x4 luma pixels
    // around each chroma pixel weighted by its Hermite kernel,
    // smoothstep(1 - d) at d = 0.75 and 0.25 chroma pixels, i.e. 0.078 0.422
    // 0.422 0.078 on each axis. Each pair is one bilinear fetch, 0.65625
    // pixels either side of the middle.
    const FS_PREP_YL = YCC + `
uniform sampler2D u_src;
uniform vec2 u_srcSize;
void main() {
    vec2 mid = floor(gl_FragCoord.xy) * 2.0 + 1.0;
    vec3 rgb = TEX(u_src, (mid + vec2(-0.65625, -0.65625)) / u_srcSize).rgb
             + TEX(u_src, (mid + vec2( 0.65625, -0.65625)) / u_srcSize).rgb
             + TEX(u_src, (mid + vec2(-0.65625,  0.65625)) / u_srcSize).rgb
             + TEX(u_src, (mid + vec2( 0.65625,  0.65625)) / u_srcSize).rgb;
    FRAG = storePlane(vec2(rgb2ycc(0.25 * rgb).x, 0.0));
}`;

    // libplacebo sh_prng(): pcg3d (http://jcgt.org/published/0009/03/02/),
    // result made from the 24 high bits
    const PRNG = `
#ifdef UINT_PRNG
#define PRNG_STATE uvec3 state
#define PRNG_INIT(xy, idx) state = uvec3(uvec2(xy), uint(idx))
#define RAND prng(state)
vec3 prng(inout uvec3 s) {
    s = 1664525u * s + uvec3(1013904223u);
    s.x += s.y * s.z;
    s.y += s.z * s.x;
    s.z += s.x * s.y;
    s ^= s >> 16u;
    s.x += s.y * s.z;
    s.y += s.z * s.x;
    s.z += s.x * s.y;
    return vec3(s >> 8u) * (1.0/16777216.0);
}
#else
// The same generator without integers: each uint32 is four 8-bit limbs
// (least significant first) held in floats, which stay exact below 2^24
#define PRNG_STATE vec4 sx, sy, sz
#define PRNG_INIT(xy, idx) sx = u32(xy.x); sy = u32(xy.y); sz = u32(idx)
#define RAND prng(sx, sy, sz)
vec4 u32(float v) {
    vec4 b;
    b.x = mod(v, 256.0); v = floor(v / 256.0);
    b.y = mod(v, 256.0); v = floor(v / 256.0);
    b.z = mod(v, 256.0); v = floor(v / 256.0);
    b.w = mod(v, 256.0);
    return b;
}
vec4 carry(vec4 v) {
    float c;
    c = floor(v.x / 256.0); v.x -= c * 256.0; v.y += c;
    c = floor(v.y / 256.0); v.y -= c * 256.0; v.z += c;
    c = floor(v.z / 256.0); v.z -= c * 256.0; v.w += c;
    v.w = mod(v.w, 256.0);
    return v;
}
vec4 mul32(vec4 a, vec4 b) {
    return carry(vec4(a.x * b.x,
                      a.x * b.y + a.y * b.x,
                      a.x * b.z + a.y * b.y + a.z * b.x,
                      a.x * b.w + a.y * b.z + a.z * b.y + a.w * b.x));
}
// 256x256 lookup texture of a ^ b; ~5x faster than looping over the bits
uniform sampler2D u_xor;
float xor8(float a, float b) {
    return floor(TEX(u_xor, (vec2(a, b) + 0.5) / 256.0).r * 255.0 + 0.5);
}
vec4 xorshift16(vec4 s) { return vec4(xor8(s.x, s.z), xor8(s.y, s.w), s.z, s.w); }
float top24(vec4 s) { return (s.y + s.z * 256.0 + s.w * 65536.0) * (1.0/16777216.0); }
vec3 prng(inout vec4 x, inout vec4 y, inout vec4 z) {
    const vec4 A = vec4(13.0, 102.0, 25.0, 0.0);   // 1664525
    const vec4 C = vec4(95.0, 243.0, 110.0, 60.0); // 1013904223
    x = carry(mul32(A, x) + C);
    y = carry(mul32(A, y) + C);
    z = carry(mul32(A, z) + C);
    x = carry(x + mul32(y, z));
    y = carry(y + mul32(z, x));
    z = carry(z + mul32(x, y));
    x = xorshift16(x);
    y = xorshift16(y);
    z = xorshift16(z);
    x = carry(x + mul32(y, z));
    y = carry(y + mul32(z, x));
    z = carry(z + mul32(x, y));
    return vec3(top24(x), top24(y), top24(z));
}
#endif
`;

    // libplacebo pl_shader_deband() on the plane pixel px, NC = number of
    // plane components. Returns the change it makes to the pixel.
    const debandNext = (nc) => `
#define NC ${nc}
#if NC == 1
#define T float
#define SW x
#define GREATER(a, b) float((a) > (b))
#else
#define T vec2
#define SW xy
#define GREATER(a, b) vec2(greaterThan(a, b))
#endif
uniform sampler2D u_tex;
uniform vec2 u_texSize;
uniform float u_frame;
uniform int u_iter;
uniform float u_radius, u_threshold, u_grain;
uniform vec2 u_neutral;
${PRNG}
T deband(vec2 px) {
    vec2 pt = 1.0 / u_texSize;
    vec2 pos = (px + 0.5) * pt;
    PRNG_STATE;
    PRNG_INIT(px, u_frame);
#define GET(X, Y) (loadPlane(u_tex, pos + pt * vec2(X, Y)).SW)
    T avg, diff, bound;
    T orig = GET(0.0, 0.0);
    T res = orig;
    vec2 d;

    // For each iteration, compute the average at a given distance and
    // pick it instead of the color if the difference is below the threshold.
    for (int i = 1; i <= 16; i++) {
        if (i > u_iter)
            break;
        d = RAND.xy * vec2(float(i) * u_radius, 6.283185);
        d = d.x * vec2(cos(d.y), sin(d.y));
        avg = T(0.0);
        avg += GET(+d.x, +d.y);
        avg += GET(-d.x, +d.y);
        avg += GET(-d.x, -d.y);
        avg += GET(+d.x, -d.y);
        avg *= 0.25;
        diff = abs(res - avg);
        bound = T(u_threshold / float(i));
        res = mix(avg, res, GREATER(diff, bound));
    }

    // Add some random noise to smooth out residual differences, avoiding
    // grain near true black
    if (u_grain > 0.0) {
        bound = T(u_neutral);
        T strength = min(abs(res - bound), T(u_grain));
        res += strength * (T(RAND) - T(0.5));
    }
    return res - orig;
}`;

    // mpv vo=gpu pass_sample_deband() on the plane pixel px. mpv works on
    // vec4s; only the plane's own components matter, so this uses vec2.
    // Returns the change it makes to the pixel.
    const DEBAND_LEGACY = `
uniform sampler2D u_tex;
uniform vec2 u_texSize;
uniform float u_random;
uniform int u_iter;
uniform float u_range, u_threshold, u_gain;

float mod289(float x)  { return x - floor(x * 1.0/289.0) * 289.0; }
float permute(float x) { return mod289( mod289(34.0*x + 1.0) * (fract(x) + 1.0) ); }
float rand(float x)    { return fract(x * 1.0/41.0); }

vec2 pos, pt;
vec2 texOff(vec2 off) { return loadPlaneLinear(u_tex, pos + pt * off, u_texSize); }

// Stochastic approximation of the avg color around a pixel
vec2 average(float range, inout float h) {
    float dist = rand(h) * range;     h = permute(h);
    float dir  = rand(h) * 6.2831853; h = permute(h);
    vec2 off = dist * vec2(cos(dir), sin(dir));
    vec2 ref0 = texOff(vec2( off.x,  off.y));
    vec2 ref1 = texOff(vec2(-off.y,  off.x));
    vec2 ref2 = texOff(vec2(-off.x, -off.y));
    vec2 ref3 = texOff(vec2( off.y, -off.x));
    return (ref0 + ref1 + ref2 + ref3)*0.25;
}

vec2 deband(vec2 px) {
    pt = 1.0 / u_texSize;
    pos = (px + 0.5) * pt;
    vec3 _m = vec3(pos, u_random) + vec3(1.0);
    float h = permute(permute(permute(_m.x)+_m.y)+_m.z);

    vec2 orig = loadPlaneLinear(u_tex, pos, u_texSize);
    vec2 color = orig;
    vec2 avg, diff;
    for (int i = 1; i <= 16; i++) {
        if (i > u_iter)
            break;
        avg = average(float(i) * u_range, h);
        diff = abs(color - avg);
        color = mix(avg, color, vec2(greaterThan(diff, vec2(u_threshold / (float(i) * 16384.0)))));
    }

    vec3 noise;
    noise.x = rand(h); h = permute(h);
    noise.y = rand(h); h = permute(h);
    noise.z = rand(h); h = permute(h);
    color += u_gain * (noise.xy - vec2(0.5));
    return color - orig;
}`;

    // Chroma pass: stores the change debanding makes to each chroma pixel
    const fsChroma = (deband) => deband + `
void main() {
    FRAG = storePlane(deband(floor(gl_FragCoord.xy)) + DELTA_BIAS);
}`;

    // The canvas pixel: dithered to 8 bits if asked, clamped, opaque
    const FINISH = `
uniform bool u_dither;
vec4 finish(vec3 rgb) {
    if (u_dither) {
        float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        rgb = floor(rgb * 255.0 + n) / 255.0;
    }
    return vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

    // Deband luma at this pixel (the luma pass is folded in here, saving a
    // full resolution render target), add the chroma change, convert the
    // change to RGB, dither, flip onto the canvas. Only the change is added on
    // top of the source pixel, so the lossy RGB -> 4:2:0 -> RGB round trip
    // never shows up where nothing was debanded (e.g. sharp colored edges).
    // lumaDelta is the expression for the luma change at plane pixel p.
    // upscale is code for chroma upscaling that replaces the browser's (see
    // UPSCALE_CFL), or empty.
    const fsFinal = (deband, lumaDelta, upscale) => YCC + deband + FINISH + `
uniform sampler2D u_c, u_src;
uniform vec2 u_size, u_csize;
uniform float u_split;
${upscale}
void main() {
    vec2 p = vec2(floor(gl_FragCoord.x), u_size.y - 1.0 - floor(gl_FragCoord.y));
    vec2 uv = (p + 0.5) / u_size;
    vec3 rgb = TEX(u_src, uv).rgb;
    if (p.x >= u_split * u_size.x) {
        vec2 cuv = (p + 0.5) / (2.0 * u_csize);
        vec2 dc = loadPlaneLinear(u_c, cuv, u_csize) - DELTA_BIAS;
#ifdef UPSCALE_CHROMA
        // The change from the browser's upscaled chroma is a chroma change too
        vec3 ycc = rgb2ycc(rgb);
        dc += upscaleChroma(p, uv, ycc.x) - ycc.yz;
#endif
        rgb += dycc2rgb(vec3(${lumaDelta}, dc));
    }
    FRAG = finish(rgb);
}`;

    // Fast mode for weak GPUs: one pass straight from the RGB frame, with no
    // render targets, float textures or extensions, and 1 + 4 * iterations
    // texture fetches per pixel (the other modes make four passes). Same
    // algorithm and parameters as gpu-next, with three shortcuts: chroma is
    // debanded at full resolution with the same samples as luma, luma isn't
    // snapped, and the random numbers come from a cheap float hash instead of
    // pcg3d. YCbCr is linear in RGB, so averaging RGB averages YCbCr.
    const FAST = `
uniform sampler2D u_src;
uniform vec2 u_texSize;
uniform float u_frame;
uniform int u_iter;
uniform float u_radius, u_threshold, u_grain;

// A few multiply-adds and fracts: no integers (slow or missing on old GPUs
// and WebGL1) and no trig. Inputs up to a few thousand, outputs ~9 bits.
vec3 rand3(vec3 p) {
    p = fract(p * vec3(0.1347, 0.1593, 0.1771) + p.yzx * vec3(0.0719, 0.0547, 0.0613));
    p += dot(p, p.zxy + 19.19);
    return fract((p + p.yzx) * p.zxy * 3.71);
}

float fastSeed() { return mod(u_frame, 256.0) * 17.0; }

// The frame debanded at texture coordinate pos, whose YCbCr is orig, with
// the random numbers of pixel p
vec3 fastDeband(vec2 p, vec2 pos, vec3 orig) {
    vec2 pt = 1.0 / u_texSize;
    vec3 res = orig;
    for (int i = 1; i <= 16; i++) {
        if (i > u_iter)
            break;
        vec2 d = rand3(vec3(p, fastSeed() + float(i))).xy * vec2(float(i) * u_radius, 6.283185);
        d = d.x * vec2(cos(d.y), sin(d.y)) * pt;
        vec3 avg = rgb2ycc(0.25 * (TEX(u_src, pos + d).rgb +
                                   TEX(u_src, pos + vec2(-d.x, d.y)).rgb +
                                   TEX(u_src, pos - d).rgb +
                                   TEX(u_src, pos + vec2(d.x, -d.y)).rgb));
        res = mix(avg, res, vec3(greaterThan(abs(res - avg), vec3(u_threshold / float(i)))));
    }
    return res;
}

// The grain to add at pixel p to the debanded YCbCr res
vec3 fastGrain(vec2 p, vec3 res) {
    vec3 strength = min(abs(res - vec3(16.0, 128.0, 128.0) / 255.0), vec3(u_grain));
    return strength * (rand3(vec3(p, fastSeed())) - 0.5);
}
`;
    const FS_FAST = YCC + FAST + FINISH + `
uniform float u_split;
void main() {
    vec2 p = vec2(floor(gl_FragCoord.x), u_texSize.y - 1.0 - floor(gl_FragCoord.y));
    vec2 pos = (p + 0.5) / u_texSize;
    vec3 rgb = TEX(u_src, pos).rgb;
    if (p.x >= u_split * u_texSize.x) {
        vec3 orig = rgb2ycc(rgb);
        vec3 res = fastDeband(p, pos, orig);
        if (u_grain > 0.0)
            res += fastGrain(p, res);
        rgb += dycc2rgb(res - orig);
    }
    FRAG = finish(rgb);
}`;

    // Fastest mode: Fast debanding the middle of each 2x2 block of the frame,
    // a quarter of the pixels, and its change upscaled onto the frame. Most
    // of Fast's cost is the scattered fetches, which miss the small caches of
    // integrated GPUs. The change is at most the threshold per iteration, and
    // none at edges, which differ by more, so upscaling it loses little: the
    // debanding noise comes out softer and pixel-wide streaks stay. Grain and
    // dither stay per pixel.
    //
    // The half resolution pass starts from the block's average and stores
    // the change in RGB, scaled and offset into an 8-bit texture (see
    // fastestDeltaScale()). It samples the frame nearest like Fast: bilinear
    // samples at the scattered positions would each touch up to four times
    // the cache lines.
    const FS_FASTEST_DELTA = YCC + FAST + `
uniform float u_deltaScale;
void main() {
    vec2 q = floor(gl_FragCoord.xy);
    vec2 pt = 1.0 / u_texSize;
    vec2 pos = (2.0 * q + 1.0) * pt;
    vec3 orig = rgb2ycc(0.25 * (TEX(u_src, pos - 0.5 * pt).rgb +
                                TEX(u_src, pos + vec2(0.5, -0.5) * pt).rgb +
                                TEX(u_src, pos + vec2(-0.5, 0.5) * pt).rgb +
                                TEX(u_src, pos + 0.5 * pt).rgb));
    FRAG = vec4(dycc2rgb(fastDeband(q, pos, orig) - orig) * u_deltaScale + 128.0 / 255.0, 1.0);
}`;
    // The frame plus the upscaled change, then grain on the result (YCbCr is
    // affine in RGB, so converting it gives the debanded YCbCr)
    const FS_FASTEST_FINAL = YCC + FAST + FINISH + `
uniform sampler2D u_delta;
uniform vec2 u_csize;
uniform float u_deltaScale;
uniform float u_split;
void main() {
    vec2 p = vec2(floor(gl_FragCoord.x), u_texSize.y - 1.0 - floor(gl_FragCoord.y));
    vec3 rgb = TEX(u_src, (p + 0.5) / u_texSize).rgb;
    if (p.x >= u_split * u_texSize.x) {
        rgb += (TEX(u_delta, (p + 0.5) / (2.0 * u_csize)).rgb - 128.0 / 255.0) / u_deltaScale;
        if (u_grain > 0.0)
            rgb += dycc2rgb(fastGrain(p, rgb2ycc(rgb)));
    }
    FRAG = finish(rgb);
}`;

    // ------------------------------------------------------------------
    // Chroma from Luma (CfL) prediction, ported from CfL_Prediction.glsl and
    // CfL_Prediction_Lite.glsl of
    // https://github.com/Artoriuz/glsl-chroma-from-luma-prediction in their
    // default configuration, under this notice:
    //
    // MIT License
    //
    // Copyright (c) 2023 João Chrisóstomo
    //
    // Permission is hereby granted, free of charge, to any person obtaining a copy
    // of this software and associated documentation files (the "Software"), to deal
    // in the Software without restriction, including without limitation the rights
    // to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    // copies of the Software, and to permit persons to whom the Software is
    // furnished to do so, subject to the following conditions:
    //
    // The above copyright notice and this permission notice shall be included in all
    // copies or substantial portions of the Software.
    //
    // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    // IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    // FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    // AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    // LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    // OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    // SOFTWARE.
    //
    // Least squares fits of chroma to luma over the chroma pixels around a
    // pixel predict its chroma from its own luma, and the prediction is mixed
    // into a spatial interpolation by how well luma and chroma correlate
    // there. mpv runs it on the debanded planes; here it runs on the planes
    // before debanding and the final pass adds the deband change on top, so
    // luma needn't be debanded into a plane of its own first.
    // ------------------------------------------------------------------

    // CfL on the 4:2:0 planes: luma u_yl and chroma u_cl, both at chroma
    // resolution u_csize (declared by the including shader). cfl(p, y) is the
    // chroma at the full resolution pixel p, whose luma is y. Written without
    // arrays, which GLSL ES 1.00 can only index by loop counters.
    const CFL = `
uniform sampler2D u_yl, u_cl;

vec2 lowUv(vec2 t) {
    return (clamp(t, vec2(0.0), u_csize - 1.0) + 0.5) / u_csize;
}

// Sums for a least squares fit of chroma to luma over n samples, each
// taken relative to a reference sample to keep float precision
struct Fit { float n, y, yy; vec2 c, cc, yc; };

Fit fitAdd(Fit a, Fit b) {
    return Fit(a.n + b.n, a.y + b.y, a.yy + b.yy, a.c + b.c, a.cc + b.cc, a.yc + b.yc);
}

// Chroma the fit predicts for luma y; (y0, c0) is the reference sample
vec2 fitPredict(Fit f, float y, float y0, vec2 c0) {
    float yvar = max(f.yy - f.y * f.y / f.n, 0.0);
    vec2 alpha = (f.yc - f.y * f.c / f.n) / max(yvar, 1e-6);
    return clamp(c0 + f.c / f.n + alpha * (y - y0 - f.y / f.n), 0.0, 1.0);
}

// Correlation of luma and chroma over the fit's samples
vec2 fitCorr(Fit f) {
    float yvar = max(f.yy - f.y * f.y / f.n, 0.0);
    vec2 cvar = max(f.cc - f.c * f.c / f.n, 0.0);
    return clamp(abs(f.yc - f.y * f.c / f.n) / max(sqrt(yvar * cvar), 1e-6), 0.0, 1.0);
}

// Weight in the spatial interpolation of a chroma pixel v chroma pixels away
float cflWeight(vec2 v) {
#ifdef CFL_LITE
    float d2 = min(dot(v, v), 4.0);
    float d4 = d2 * d2;
    return (d4 - 8.0 * d2 + 16.0) * (d4 - 5.0 * d2 + 4.0);
#else
    float d = min(length(v), 2.0);
    float d2 = d * d;
    float d3 = d2 * d;
    return d < 1.0 ? 1.25 * d3 - 2.25 * d2 + 1.0 : -0.75 * d3 + 3.75 * d2 - 6.0 * d + 3.0;
#endif
}

vec2 cfl(vec2 p, float y) {
    // The chroma pixel up-left of p, and p's position from it
    vec2 pp = (p + 0.5) * 0.5 - 0.5;
    vec2 fp = floor(pp);
    pp -= fp;

    // Over the 4x4 chroma pixels around p: the spatial interpolation, the
    // chroma range of the inner 2x2 to limit its ringing, the luma range,
    // and fits over the inner 2x2 (fi), above and below it (fv) and either
    // side of it (fh). The corners only count in the full variant's
    // interpolation.
    float y0 = loadPlane(u_yl, lowUv(fp)).x;
    vec2 c0 = loadPlane(u_cl, lowUv(fp));
    float ymin = y0, ymax = y0, wt = 0.0;
    vec2 cmin = c0, cmax = c0, ct = vec2(0.0);
    Fit fi = Fit(0.0, 0.0, 0.0, vec2(0.0), vec2(0.0), vec2(0.0));
    Fit fv = fi, fh = fi;
    for (int j = -1; j <= 2; j++) {
        for (int i = -1; i <= 2; i++) {
            bool inx = i == 0 || i == 1, iny = j == 0 || j == 1;
            bool corner = !inx && !iny;
#ifdef CFL_LITE
            if (corner)
                continue;
#endif
            vec2 o = vec2(float(i), float(j));
            vec2 uv = lowUv(fp + o);
            vec2 c = loadPlane(u_cl, uv);
            float w = cflWeight(o - pp);
            wt += w;
            ct += w * c;
            if (corner)
                continue;
            float yl = loadPlane(u_yl, uv).x;
            ymin = min(ymin, yl);
            ymax = max(ymax, yl);
            float dy = yl - y0;
            vec2 dc = c - c0;
            Fit s = Fit(1.0, dy, dy * dy, dc, dc * dc, dy * dc);
            if (inx && iny) {
                cmin = min(cmin, c);
                cmax = max(cmax, c);
                fi = fitAdd(fi, s);
            } else if (inx) {
                fv = fitAdd(fv, s);
            } else {
                fh = fitAdd(fh, s);
            }
        }
    }
    vec2 spatial = ct / wt;
    spatial = clamp(mix(spatial, clamp(spatial, cmin, cmax), 0.8), 0.0, 1.0);

    // Mix in the prediction by the correlation over all 12, less where y is
    // far outside their luma range
    Fit f12 = fitAdd(fitAdd(fi, fv), fh);
    vec2 corr = fitCorr(f12);
    corr *= corr;
    float extrapolation = max(max(y - ymax, ymin - y), 0.0) / max(ymax - ymin, 1e-6);
    vec2 mixCoeff = 0.8 * corr * corr * clamp((8.0 - extrapolation) / 4.0, 0.0, 1.0);
#ifdef CFL_LITE
    vec2 pred = fitPredict(f12, y, y0, c0);
#else
    vec2 pred8 = mix(fitPredict(fitAdd(fi, fv), y, y0, c0), fitPredict(fitAdd(fi, fh), y, y0, c0), 0.5);
    vec2 pred = mix(fitPredict(f12, y, y0, c0), pred8, 0.5);
#endif
    return clamp(mix(spatial, pred, mixCoeff), 0.0, 1.0);
}
`;

    // The full CfL's prediction at each full resolution pixel. It gets a pass
    // of its own because its last step (UPSCALE_CFL) needs the neighbors'.
    const FS_CFL = YCC + `
uniform sampler2D u_src;
uniform vec2 u_size, u_csize;
` + CFL + `
void main() {
    vec2 p = floor(gl_FragCoord.xy);
    FRAG = storePlane(cfl(p, rgb2ycc(TEX(u_src, (p + 0.5) / u_size).rgb).x));
}`;

    // Chroma upscaling in the final pass (see fsFinal): upscaleChroma(p, uv, y)
    // is the chroma at plane pixel p, at texture coordinate uv, with luma y.
    // The full CfL's last step: a 3x3 joint bilateral filter over its
    // prediction u_pred, weighted by distance and luma difference with the
    // default distance_coeff (2) and intensity_coeff (128). u_tex is the
    // deband code's luma plane.
    const UPSCALE_CFL = `
uniform sampler2D u_pred;
#define UPSCALE_CHROMA
vec2 upscaleChroma(vec2 p, vec2 uv, float y) {
    vec2 d = 1.0 / u_size;
    float y0 = loadPlane(u_tex, uv).x;
    float wt = 0.0;
    vec2 ct = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            float dy = y0 - loadPlane(u_tex, uv + o * d).x;
            float w = max(100.0 * exp(-2.0 * dot(o, o) - 128.0 * dy * dy), 1e-32);
            wt += w;
            ct += w * loadPlane(u_pred, uv + o * d);
        }
    }
    return clamp(ct / wt, 0.0, 1.0);
}`;
    // CfL Lite has no such step, so it runs in the final pass
    const UPSCALE_CFL_LITE = '#define CFL_LITE\n' + CFL + `
#define UPSCALE_CHROMA
vec2 upscaleChroma(vec2 p, vec2 uv, float y) { return cfl(p, y); }`;

    // Fragment shader of each program. They are compiled on first use, so a
    // weak GPU only compiles the mode it runs.
    const PROGRAMS = {
        prepY: FS_PREP_Y,
        prepC: FS_PREP_C,
        prepYL: FS_PREP_YL,
        cfl: FS_CFL,
        nextC: fsChroma(debandNext(2)),
        nextFinal: fsFinal(debandNext(1), 'deband(p)', ''),
        nextFinalCfl: fsFinal(debandNext(1), 'deband(p)', UPSCALE_CFL),
        nextFinalCflLite: fsFinal(debandNext(1), 'deband(p)', UPSCALE_CFL_LITE),
        legacyC: fsChroma(DEBAND_LEGACY),
        legacyFinal: fsFinal(DEBAND_LEGACY, 'deband(p).x', ''),
        legacyFinalCfl: fsFinal(DEBAND_LEGACY, 'deband(p).x', UPSCALE_CFL),
        legacyFinalCflLite: fsFinal(DEBAND_LEGACY, 'deband(p).x', UPSCALE_CFL_LITE),
        fast: FS_FAST,
        fastestDelta: FS_FASTEST_DELTA,
        fastestFinal: FS_FASTEST_FINAL,
    };
    // Final pass program suffix per chroma upscaling
    const FINAL_CHROMA = { browser: '', cfl: 'Cfl', 'cfl-lite': 'CflLite' };
    // Renderer description suffix per chroma upscaling
    const CHROMA_DESCRIPTION = { browser: '', cfl: ', CfL chroma', 'cfl-lite': ', CfL Lite chroma' };

    // ------------------------------------------------------------------
    // WGSL shaders (WebGPU)
    //
    // Ports of the shaders above. WebGPU always has float render targets and
    // integers, so there is no PACKED or float PRNG variant, and its
    // framebuffer origin is top left like the video's, so nothing is flipped.
    // Passes read the video through srcPixel() and srcLinear(): from an
    // external texture (the browser's frame, imported without a copy), or
    // from a copy where the browser can't import video.
    // ------------------------------------------------------------------

    // The uniforms every pass gets, as [name, components, type], in WGSL
    // layout order (the vec2s first, so nothing is padded)
    const WGSL_PARAMS = [
        ['k', 2], ['srcSize', 2], ['texSize', 2], ['size', 2], ['csize', 2], ['neutral', 2],
        ['frame', 1], ['iter', 1, 'i32'], ['radius', 1], ['threshold', 1], ['grain', 1],
        ['random', 1], ['range', 1], ['gain', 1], ['split', 1], ['deltaScale', 1],
        ['snap', 1, 'u32'], ['luma', 1, 'u32'], ['dither', 1, 'u32'],
    ];
    // Rounded up to the struct's alignment, that of a vec2
    const PARAMS_SIZE = Math.ceil(WGSL_PARAMS.reduce((n, [, c]) => n + 4 * c, 0) / 8) * 8;
    const PARAMS_STRIDE = 256; // the largest minUniformBufferOffsetAlignment

    const WGSL_COMMON = `
struct Params {
${WGSL_PARAMS.map(([name, c, type]) => `    ${name}: ${c > 1 ? 'vec2f' : type || 'f32'},`).join('\n')}
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var s_near: sampler;
@group(0) @binding(2) var s_lin: sampler;

// One triangle covering the viewport
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    return vec4f(vec2f(f32(i & 1u), f32(i >> 1u)) * 4.0 - 1.0, 0.0, 1.0);
}

// A plane has up to two components (Y, or Cb and Cr)
fn plane(t: texture_2d<f32>, uv: vec2f) -> vec2f {
    return textureSampleLevel(t, s_near, uv, 0.0).rg;
}
fn planeLinear(t: texture_2d<f32>, uv: vec2f) -> vec2f {
    return textureSampleLevel(t, s_lin, uv, 0.0).rg;
}

// As in YCC
fn rgb2ycc(c: vec3f) -> vec3f {
    let kr = P.k.x;
    let kb = P.k.y;
    let kg = 1.0 - kr - kb;
    let y = kr * c.r + kg * c.g + kb * c.b;
    return vec3f(16.0  + 219.0 * y,
                 128.0 + 224.0 * (c.b - y) / (2.0 - 2.0 * kb),
                 128.0 + 224.0 * (c.r - y) / (2.0 - 2.0 * kr)) / 255.0;
}
fn dycc2rgb(d: vec3f) -> vec3f {
    let kr = P.k.x;
    let kb = P.k.y;
    let kg = 1.0 - kr - kb;
    let y  = d.x * 255.0 / 219.0;
    let cb = d.y * 255.0 / 224.0;
    let cr = d.z * 255.0 / 224.0;
    let r = y + (2.0 - 2.0 * kr) * cr;
    let b = y + (2.0 - 2.0 * kb) * cb;
    return vec3f(r, (y - kr * r - kb * b) / kg, b);
}

// The canvas pixel at fc: dithered to 8 bits if asked, clamped, opaque
fn finish(fc: vec2f, rgb: vec3f) -> vec4f {
    var c = rgb;
    if (P.dither != 0u) {
        let n = fract(52.9829189 * fract(dot(fc, vec2f(0.06711056, 0.00583715))));
        c = floor(c * 255.0 + n) / 255.0;
    }
    return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

    // The video as an external texture. The browser may hand it over as the
    // decoder's YCbCr planes, which are converted per sample, so a pixel is
    // read bilinearly at its center: that is exact for luma (and for RGB)
    // and upscales chroma the way the browser does for display. Nearest
    // sampling would upscale chroma blockily.
    const WGSL_SRC_EXTERNAL = `
@group(0) @binding(3) var u_src: texture_external;
fn srcPixel(uv: vec2f) -> vec3f {
    let size = vec2f(textureDimensions(u_src));
    return textureSampleBaseClampToEdge(u_src, s_lin, (floor(uv * size) + 0.5) / size).rgb;
}
fn srcLinear(uv: vec2f) -> vec3f {
    return textureSampleBaseClampToEdge(u_src, s_lin, uv).rgb;
}`;
    // The video copied into an RGBA texture
    const WGSL_SRC_COPY = `
@group(0) @binding(3) var u_src: texture_2d<f32>;
fn srcPixel(uv: vec2f) -> vec3f {
    return textureSampleLevel(u_src, s_near, uv, 0.0).rgb;
}
fn srcLinear(uv: vec2f) -> vec3f {
    return textureSampleLevel(u_src, s_lin, uv, 0.0).rgb;
}`;

    // As FS_PREP_Y, FS_PREP_C and FS_PREP_YL
    const WGSL_PREP_Y = `
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    var y = rgb2ycc(srcPixel(fc.xy / P.srcSize)).x;
    if (P.snap != 0u) {
        y = floor(y * 255.0 + 0.5) / 255.0;
    }
    return vec4f(y, 0.0, 0.0, 1.0);
}`;
    const WGSL_PREP_C = `
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    let mid = floor(fc.xy) * 2.0 + 1.0;
    let c = rgb2ycc(srcLinear(mid / P.srcSize));
    if (P.luma != 0u) {
        return vec4f(c.x, 0.0, 0.0, 1.0);
    }
    return vec4f(c.yz, 0.0, 1.0);
}`;
    const WGSL_PREP_YL = `
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    let mid = floor(fc.xy) * 2.0 + 1.0;
    let rgb = srcLinear((mid + vec2f(-0.65625, -0.65625)) / P.srcSize)
            + srcLinear((mid + vec2f( 0.65625, -0.65625)) / P.srcSize)
            + srcLinear((mid + vec2f(-0.65625,  0.65625)) / P.srcSize)
            + srcLinear((mid + vec2f( 0.65625,  0.65625)) / P.srcSize);
    return vec4f(rgb2ycc(0.25 * rgb).x, 0.0, 0.0, 1.0);
}`;

    // pcg3d as in PRNG
    const WGSL_PRNG = `
var<private> state: vec3u;
fn prng() -> vec3f {
    var s = 1664525u * state + vec3u(1013904223u);
    s.x += s.y * s.z;
    s.y += s.z * s.x;
    s.z += s.x * s.y;
    s ^= s >> vec3u(16u);
    s.x += s.y * s.z;
    s.y += s.z * s.x;
    s.z += s.x * s.y;
    state = s;
    return vec3f(s >> vec3u(8u)) * (1.0 / 16777216.0);
}`;

    // pl_shader_deband() as in debandNext, always on two components: luma
    // only uses the first, which comes out the same
    const WGSL_DEBAND_NEXT = WGSL_PRNG + `
@group(0) @binding(4) var u_tex: texture_2d<f32>;
fn deband(px: vec2f) -> vec2f {
    let pt = 1.0 / P.texSize;
    let pos = (px + 0.5) * pt;
    state = vec3u(vec2u(px), u32(P.frame));
    let orig = plane(u_tex, pos);
    var res = orig;

    // For each iteration, compute the average at a given distance and
    // pick it instead of the color if the difference is below the threshold.
    for (var i = 1; i <= P.iter; i++) {
        var d = prng().xy * vec2f(f32(i) * P.radius, 6.283185);
        d = d.x * vec2f(cos(d.y), sin(d.y));
        let avg = 0.25 * (plane(u_tex, pos + pt * vec2f( d.x,  d.y)) +
                          plane(u_tex, pos + pt * vec2f(-d.x,  d.y)) +
                          plane(u_tex, pos + pt * vec2f(-d.x, -d.y)) +
                          plane(u_tex, pos + pt * vec2f( d.x, -d.y)));
        res = select(avg, res, abs(res - avg) > vec2f(P.threshold / f32(i)));
    }

    // Add some random noise to smooth out residual differences, avoiding
    // grain near true black
    if (P.grain > 0.0) {
        let strength = min(abs(res - P.neutral), vec2f(P.grain));
        res += strength * (prng().xy - 0.5);
    }
    return res - orig;
}`;

    // pass_sample_deband() as in DEBAND_LEGACY
    const WGSL_DEBAND_LEGACY = `
@group(0) @binding(4) var u_tex: texture_2d<f32>;
fn mod289(x: f32) -> f32 { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute(x: f32) -> f32 { return mod289(mod289(34.0 * x + 1.0) * (fract(x) + 1.0)); }
fn rand(x: f32) -> f32 { return fract(x * (1.0 / 41.0)); }

// Stochastic approximation of the avg color around a pixel
fn average(pos: vec2f, pt: vec2f, range: f32, h: ptr<function, f32>) -> vec2f {
    let dist = rand(*h) * range;     *h = permute(*h);
    let dir  = rand(*h) * 6.2831853; *h = permute(*h);
    let off = dist * vec2f(cos(dir), sin(dir));
    let ref0 = planeLinear(u_tex, pos + pt * vec2f( off.x,  off.y));
    let ref1 = planeLinear(u_tex, pos + pt * vec2f(-off.y,  off.x));
    let ref2 = planeLinear(u_tex, pos + pt * vec2f(-off.x, -off.y));
    let ref3 = planeLinear(u_tex, pos + pt * vec2f( off.y, -off.x));
    return (ref0 + ref1 + ref2 + ref3) * 0.25;
}

fn deband(px: vec2f) -> vec2f {
    let pt = 1.0 / P.texSize;
    let pos = (px + 0.5) * pt;
    let m = vec3f(pos, P.random) + vec3f(1.0);
    var h = permute(permute(permute(m.x) + m.y) + m.z);

    let orig = planeLinear(u_tex, pos);
    var color = orig;
    for (var i = 1; i <= P.iter; i++) {
        let avg = average(pos, pt, f32(i) * P.range, &h);
        let diff = abs(color - avg);
        color = select(avg, color, diff > vec2f(P.threshold / (f32(i) * 16384.0)));
    }

    let noise = vec2f(rand(h), rand(permute(h)));
    color += P.gain * (noise - vec2f(0.5));
    return color - orig;
}`;

    // As fsChroma
    const wgslChroma = (deband) => deband + `
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    return vec4f(deband(floor(fc.xy)), 0.0, 1.0);
}`;

    // As fsFinal; upscale defines UPSCALE_CHROMA and upscaleChroma()
    const wgslFinal = (deband, upscale) => deband + upscale + `
@group(0) @binding(5) var u_c: texture_2d<f32>;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    let p = floor(fc.xy);
    let uv = (p + 0.5) / P.size;
    var rgb = srcPixel(uv);
    if (p.x >= P.split * P.size.x) {
        var dc = planeLinear(u_c, (p + 0.5) / (2.0 * P.csize));
        if (UPSCALE_CHROMA) {
            // The change from the browser's upscaled chroma is a chroma change too
            let ycc = rgb2ycc(rgb);
            dc += upscaleChroma(p, uv, ycc.x) - ycc.yz;
        }
        rgb += dycc2rgb(vec3f(deband(p).x, dc));
    }
    return finish(fc.xy, rgb);
}`;

    // As FAST
    const WGSL_FAST_COMMON = `
fn rand3(q: vec3f) -> vec3f {
    var p = fract(q * vec3f(0.1347, 0.1593, 0.1771) + q.yzx * vec3f(0.0719, 0.0547, 0.0613));
    p += dot(p, p.zxy + 19.19);
    return fract((p + p.yzx) * p.zxy * 3.71);
}

fn fastSeed() -> f32 { return (P.frame % 256.0) * 17.0; }

fn fastDeband(p: vec2f, pos: vec2f, orig: vec3f) -> vec3f {
    let pt = 1.0 / P.texSize;
    var res = orig;
    for (var i = 1; i <= P.iter; i++) {
        var d = rand3(vec3f(p, fastSeed() + f32(i))).xy * vec2f(f32(i) * P.radius, 6.283185);
        d = d.x * vec2f(cos(d.y), sin(d.y)) * pt;
        let avg = rgb2ycc(0.25 * (srcPixel(pos + d) +
                                  srcPixel(pos + vec2f(-d.x, d.y)) +
                                  srcPixel(pos - d) +
                                  srcPixel(pos + vec2f(d.x, -d.y))));
        res = select(avg, res, abs(res - avg) > vec3f(P.threshold / f32(i)));
    }
    return res;
}

fn fastGrain(p: vec2f, res: vec3f) -> vec3f {
    let strength = min(abs(res - vec3f(16.0, 128.0, 128.0) / 255.0), vec3f(P.grain));
    return strength * (rand3(vec3f(p, fastSeed())) - 0.5);
}
`;

    // As FS_FAST
    const WGSL_FAST = WGSL_FAST_COMMON + `
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    let p = floor(fc.xy);
    let pos = (p + 0.5) / P.texSize;
    var rgb = srcPixel(pos);
    if (p.x >= P.split * P.texSize.x) {
        let orig = rgb2ycc(rgb);
        var res = fastDeband(p, pos, orig);
        if (P.grain > 0.0) {
            res += fastGrain(p, res);
        }
        rgb += dycc2rgb(res - orig);
    }
    return finish(fc.xy, rgb);
}`;

    // As FS_FASTEST_DELTA and FS_FASTEST_FINAL; one bilinear fetch takes the
    // block's average
    const WGSL_FASTEST_DELTA = WGSL_FAST_COMMON + `
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    let q = floor(fc.xy);
    let pos = (2.0 * q + 1.0) / P.texSize;
    let orig = rgb2ycc(srcLinear(pos));
    return vec4f(dycc2rgb(fastDeband(q, pos, orig) - orig) * P.deltaScale + 128.0 / 255.0, 1.0);
}`;
    const WGSL_FASTEST_FINAL = WGSL_FAST_COMMON + `
@group(0) @binding(4) var u_delta: texture_2d<f32>;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    let p = floor(fc.xy);
    var rgb = srcPixel((p + 0.5) / P.texSize);
    if (p.x >= P.split * P.texSize.x) {
        let delta = textureSampleLevel(u_delta, s_lin, (p + 0.5) / (2.0 * P.csize), 0.0).rgb;
        rgb += (delta - 128.0 / 255.0) / P.deltaScale;
        if (P.grain > 0.0) {
            rgb += dycc2rgb(fastGrain(p, rgb2ycc(rgb)));
        }
    }
    return finish(fc.xy, rgb);
}`;

    // CFL ported to WGSL (same notice), the lite variant if lite
    const wgslCfl = (lite) => `
const CFL_LITE = ${lite};
@group(0) @binding(6) var u_yl: texture_2d<f32>;
@group(0) @binding(7) var u_cl: texture_2d<f32>;

fn lowUv(t: vec2f) -> vec2f {
    return (clamp(t, vec2f(0.0), P.csize - 1.0) + 0.5) / P.csize;
}

struct Fit { n: f32, y: f32, yy: f32, c: vec2f, cc: vec2f, yc: vec2f }

fn fitAdd(a: Fit, b: Fit) -> Fit {
    return Fit(a.n + b.n, a.y + b.y, a.yy + b.yy, a.c + b.c, a.cc + b.cc, a.yc + b.yc);
}

fn fitPredict(f: Fit, y: f32, y0: f32, c0: vec2f) -> vec2f {
    let yvar = max(f.yy - f.y * f.y / f.n, 0.0);
    let alpha = (f.yc - f.y * f.c / f.n) / max(yvar, 1e-6);
    return clamp(c0 + f.c / f.n + alpha * (y - y0 - f.y / f.n), vec2f(0.0), vec2f(1.0));
}

fn fitCorr(f: Fit) -> vec2f {
    let yvar = max(f.yy - f.y * f.y / f.n, 0.0);
    let cvar = max(f.cc - f.c * f.c / f.n, vec2f(0.0));
    return clamp(abs(f.yc - f.y * f.c / f.n) / max(sqrt(yvar * cvar), vec2f(1e-6)), vec2f(0.0), vec2f(1.0));
}

fn cflWeight(v: vec2f) -> f32 {
    if (CFL_LITE) {
        let d2 = min(dot(v, v), 4.0);
        let d4 = d2 * d2;
        return (d4 - 8.0 * d2 + 16.0) * (d4 - 5.0 * d2 + 4.0);
    }
    let d = min(length(v), 2.0);
    let d2 = d * d;
    let d3 = d2 * d;
    return select(-0.75 * d3 + 3.75 * d2 - 6.0 * d + 3.0, 1.25 * d3 - 2.25 * d2 + 1.0, d < 1.0);
}

fn cfl(p: vec2f, y: f32) -> vec2f {
    var pp = (p + 0.5) * 0.5 - 0.5;
    let fp = floor(pp);
    pp -= fp;

    let y0 = plane(u_yl, lowUv(fp)).x;
    let c0 = plane(u_cl, lowUv(fp));
    var ymin = y0;
    var ymax = y0;
    var wt = 0.0;
    var cmin = c0;
    var cmax = c0;
    var ct = vec2f(0.0);
    var fi = Fit();
    var fv = Fit();
    var fh = Fit();
    for (var j = -1; j <= 2; j++) {
        for (var i = -1; i <= 2; i++) {
            let inx = i == 0 || i == 1;
            let iny = j == 0 || j == 1;
            let corner = !inx && !iny;
            if (CFL_LITE && corner) {
                continue;
            }
            let o = vec2f(f32(i), f32(j));
            let uv = lowUv(fp + o);
            let c = plane(u_cl, uv);
            let w = cflWeight(o - pp);
            wt += w;
            ct += w * c;
            if (corner) {
                continue;
            }
            let yl = plane(u_yl, uv).x;
            ymin = min(ymin, yl);
            ymax = max(ymax, yl);
            let dy = yl - y0;
            let dc = c - c0;
            let s = Fit(1.0, dy, dy * dy, dc, dc * dc, dy * dc);
            if (inx && iny) {
                cmin = min(cmin, c);
                cmax = max(cmax, c);
                fi = fitAdd(fi, s);
            } else if (inx) {
                fv = fitAdd(fv, s);
            } else {
                fh = fitAdd(fh, s);
            }
        }
    }
    var spatial = ct / wt;
    spatial = clamp(mix(spatial, clamp(spatial, cmin, cmax), vec2f(0.8)), vec2f(0.0), vec2f(1.0));

    let f12 = fitAdd(fitAdd(fi, fv), fh);
    var corr = fitCorr(f12);
    corr *= corr;
    let extrapolation = max(max(y - ymax, ymin - y), 0.0) / max(ymax - ymin, 1e-6);
    let mixCoeff = 0.8 * corr * corr * clamp((8.0 - extrapolation) / 4.0, 0.0, 1.0);
    var pred = fitPredict(f12, y, y0, c0);
    if (!CFL_LITE) {
        let pred8 = mix(fitPredict(fitAdd(fi, fv), y, y0, c0), fitPredict(fitAdd(fi, fh), y, y0, c0), vec2f(0.5));
        pred = mix(pred, pred8, vec2f(0.5));
    }
    return clamp(mix(spatial, pred, mixCoeff), vec2f(0.0), vec2f(1.0));
}
`;

    // As FS_CFL
    const WGSL_CFL_PASS = `
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
    let p = floor(fc.xy);
    return vec4f(cfl(p, rgb2ycc(srcPixel((p + 0.5) / P.size)).x), 0.0, 1.0);
}`;

    // As UPSCALE_CFL and UPSCALE_CFL_LITE, and the browser's upscaling
    const WGSL_UPSCALE_NONE = `
const UPSCALE_CHROMA = false;
fn upscaleChroma(p: vec2f, uv: vec2f, y: f32) -> vec2f { return vec2f(0.0); }`;
    const WGSL_UPSCALE_CFL = `
@group(0) @binding(8) var u_pred: texture_2d<f32>;
const UPSCALE_CHROMA = true;
fn upscaleChroma(p: vec2f, uv: vec2f, y: f32) -> vec2f {
    let d = 1.0 / P.size;
    let y0 = plane(u_tex, uv).x;
    var wt = 0.0;
    var ct = vec2f(0.0);
    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            let o = vec2f(f32(i), f32(j));
            let dy = y0 - plane(u_tex, uv + o * d).x;
            let w = max(100.0 * exp(-2.0 * dot(o, o) - 128.0 * dy * dy), 1e-32);
            wt += w;
            ct += w * plane(u_pred, uv + o * d);
        }
    }
    return clamp(ct / wt, vec2f(0.0), vec2f(1.0));
}`;
    const WGSL_UPSCALE_CFL_LITE = wgslCfl(true) + `
const UPSCALE_CHROMA = true;
fn upscaleChroma(p: vec2f, uv: vec2f, y: f32) -> vec2f { return cfl(p, y); }`;

    // The fragment shader of each program, by the names of PROGRAMS
    const WGSL_PROGRAMS = {
        prepY: WGSL_PREP_Y,
        prepC: WGSL_PREP_C,
        prepYL: WGSL_PREP_YL,
        cfl: wgslCfl(false) + WGSL_CFL_PASS,
        nextC: wgslChroma(WGSL_DEBAND_NEXT),
        nextFinal: wgslFinal(WGSL_DEBAND_NEXT, WGSL_UPSCALE_NONE),
        nextFinalCfl: wgslFinal(WGSL_DEBAND_NEXT, WGSL_UPSCALE_CFL),
        nextFinalCflLite: wgslFinal(WGSL_DEBAND_NEXT, WGSL_UPSCALE_CFL_LITE),
        legacyC: wgslChroma(WGSL_DEBAND_LEGACY),
        legacyFinal: wgslFinal(WGSL_DEBAND_LEGACY, WGSL_UPSCALE_NONE),
        legacyFinalCfl: wgslFinal(WGSL_DEBAND_LEGACY, WGSL_UPSCALE_CFL),
        legacyFinalCflLite: wgslFinal(WGSL_DEBAND_LEGACY, WGSL_UPSCALE_CFL_LITE),
        fast: WGSL_FAST,
        fastestDelta: WGSL_FASTEST_DELTA,
        fastestFinal: WGSL_FASTEST_FINAL,
    };

    // Fastest stores the change its half resolution pass makes in an 8-bit
    // texture, as change * scale + 128/255. Iteration i changes each YCbCr
    // component by at most threshold / i, which changes RGB by at most 3.3
    // times as much (blue, through Cb), so the scale fits that into the 127
    // levels either side. Defaults leave steps of 1/50 of a code value, and
    // no change is stored exactly.
    function fastestDeltaScale(s) {
        let bound = 0;
        for (let i = 1; i <= s.iterations; i++)
            bound += s.threshold / 16.384 / 1000 / i;
        return (127 / 255) / Math.max(3.3 * bound, 1e-4);
    }

    // ------------------------------------------------------------------
    // WebGL renderer
    // ------------------------------------------------------------------

    class WebGLDebander {
        // backend: 'auto' | 'webgl2' | 'webgl1'
        constructor(canvas, backend) {
            this.canvas = canvas;
            this.frame = 0;
            this.w = 0;
            this.h = 0;
            this.uploadFormat = null;
            this.fast = false;
            this.fastest = false;
            this.chroma = 'browser';
            this.textures = [];
            this.fbos = [];
            this.init(backend);
        }

        init(backend) {
            const attrs = {
                alpha: false, antialias: false, depth: false, stencil: false,
                premultipliedAlpha: false, preserveDrawingBuffer: false,
                powerPreference: 'high-performance',
            };
            let gl = backend !== 'webgl1' ? this.canvas.getContext('webgl2', attrs) : null;
            const webgl2 = !!gl;
            if (!gl && backend !== 'webgl2')
                gl = this.canvas.getContext('webgl', attrs);
            if (!gl)
                throw new Error(backend === 'webgl2' ? 'WebGL2 is not available'
                    : 'WebGL is not available (disabled by the browser, a security level or NoScript?)');
            if (!webgl2) {
                const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
                if (!hp || hp.precision < 23)
                    throw new Error('The GPU has no highp float in fragment shaders');
            }
            this.gl = gl;
            this.webgl2 = webgl2;
            // Fingerprinting protection (Tor/Mullvad) reports minimum limits,
            // e.g. 2048px textures
            this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
            if (webgl2) {
                this.packed = !gl.getExtension('EXT_color_buffer_float');
            } else {
                // WebGL1 can still render to half float textures through
                // extensions; fall back to packing planes into RGBA8 without them
                const half = gl.getExtension('OES_texture_half_float');
                this.halfType = half && half.HALF_FLOAT_OES;
                this.packed = !(half && gl.getExtension('OES_texture_half_float_linear') &&
                                gl.getExtension('EXT_color_buffer_half_float') && this.halfTargetsWork());
            }
            const caps = { webgl2, packed: this.packed, uintPrng: webgl2 };

            this.vs = webgl2 ? VS2 : VS1;
            this.fsHeader = fsHeader(caps);
            this.progs = {};

            if (!caps.uintPrng) {
                const lut = new Uint8Array(256 * 256);
                for (let b = 0; b < 256; b++)
                    for (let a = 0; a < 256; a++)
                        lut[b * 256 + a] = a ^ b;
                this.xorLut = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, this.xorLut);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 256, 256, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, lut);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            }

            // One triangle covering the viewport
            this.vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        }

        get description() {
            return `${this.webgl2 ? 'WebGL2' : 'WebGL1'}, ` +
                   `${this.fastest ? 'half resolution pass' : this.fast ? 'single pass' : (this.packed ? 'packed 16-bit' : 'float') + ' planes'}, ` +
                   `${this.uploadFormat === 'half' ? 'RGBA16F' : 'RGBA8'} upload` + CHROMA_DESCRIPTION[this.chroma];
        }

        prog(name) {
            return this.progs[name] || (this.progs[name] = this.program(this.vs, this.fsHeader + PROGRAMS[name]));
        }

        program(vsSrc, fsSrc) {
            const gl = this.gl;
            const compile = (type, src) => {
                const sh = gl.createShader(type);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
                    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
                return sh;
            };
            const prog = gl.createProgram();
            gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
            gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
            gl.bindAttribLocation(prog, 0, 'a_pos');
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
                throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
            const loc = {};
            const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < n; i++) {
                const name = gl.getActiveUniform(prog, i).name;
                loc[name] = gl.getUniformLocation(prog, name);
            }
            return { prog, loc };
        }

        // Some drivers expose the extensions but can't render to the format
        halfTargetsWork() {
            const gl = this.gl;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, this.halfType, null);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(tex);
            return ok;
        }

        // format is a WebGL2 sized format; on WebGL1, float picks half float
        // RGBA instead of RGBA8
        texture(w, h, format, float) {
            const gl = this.gl;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            if (this.webgl2)
                gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
            else
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, float ? this.halfType : gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            this.textures.push(tex);
            return tex;
        }

        // A null floatFormat makes an RGBA8 target
        target(w, h, floatFormat) {
            const gl = this.gl;
            const byte = this.packed || !floatFormat;
            const tex = this.texture(w, h, byte ? gl.RGBA8 : floatFormat, !byte);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
                throw new Error('Framebuffer incomplete');
            this.fbos.push(fbo);
            return { tex, fbo, w, h };
        }

        resize(w, h, s) {
            const gl = this.gl;
            const fastest = s.algo === 'fastest';
            const fast = s.algo === 'fast' || fastest;
            // The Fast modes take the cheapest upload
            const precision = this.webgl2 && !fast ? s.precision : 'byte';
            // Snapped luma is exactly on the 8-bit grid, so an 8-bit plane
            // holds it losslessly with half the memory traffic. Not for the
            // legacy shader: it filters luma bilinearly, and 8-bit textures
            // aren't guaranteed to filter with more than 8 bits of precision.
            // The Fast modes have no planes.
            const yFormat = fast ? null : s.snap && s.algo !== 'gpu' ? gl.R8 : gl.R16F;
            // CfL works on the planes, which the Fast modes don't make
            const chroma = !fast && (s.chroma === 'cfl' || s.chroma === 'cfl-lite') ? s.chroma : 'browser';
            if (w === this.w && h === this.h && precision === this.uploadFormat && yFormat === this.yFormat &&
                chroma === this.chroma && fastest === this.fastest)
                return;
            for (const t of this.textures) gl.deleteTexture(t);
            for (const f of this.fbos) gl.deleteFramebuffer(f);
            this.textures = [];
            this.fbos = [];

            const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
            this.src = this.texture(w, h, precision === 'half' ? gl.RGBA16F : gl.RGBA8);
            this.srcAllocated = false;
            if (!fast) {
                this.yPrep = this.target(w, h, yFormat);
                this.cPrep = this.target(cw, ch, gl.RG16F);
                this.cDelta = this.target(cw, ch, gl.RG16F);
            }
            // CfL's luma at chroma resolution, and the full CfL's prediction
            // before its last step
            if (chroma !== 'browser')
                this.yLow = this.target(cw, ch, gl.R16F);
            if (chroma === 'cfl')
                this.cPred = this.target(w, h, gl.RG16F);
            // Fastest's change at half resolution
            if (fastest)
                this.fastDelta = this.target(cw, ch, null);

            this.canvas.width = w;
            this.canvas.height = h;
            this.w = w;
            this.h = h;
            this.uploadFormat = precision;
            this.yFormat = yFormat;
            this.fast = fast;
            this.fastest = fastest;
            this.chroma = chroma;
            this.checkUpload = true;
        }

        upload(video) {
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, this.src);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            if (this.webgl2) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA,
                                 this.uploadFormat === 'half' ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, video);
            } else if (this.srcAllocated) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
                this.srcAllocated = true;
            }
        }

        // inputs: [uniform name, texture, linear filtering]
        pass(p, out, inputs, setUniforms) {
            const gl = this.gl;
            gl.useProgram(p.prog);
            gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
            gl.viewport(0, 0, out ? out.w : this.w, out ? out.h : this.h);
            inputs.forEach(([name, tex, linear], unit) => {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                const filter = linear ? gl.LINEAR : gl.NEAREST;
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
                gl.uniform1i(p.loc[name], unit);
            });
            if (setUniforms)
                setUniforms(p.loc);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        render(video, s) {
            const gl = this.gl;
            this.resize(video.videoWidth, video.videoHeight, s);
            this.upload(video);
            if (this.checkUpload) {
                this.checkUpload = false;
                const err = gl.getError();
                if (err !== gl.NO_ERROR) {
                    if (this.uploadFormat === 'half') {
                        // Fall back to an 8-bit upload
                        s.precision = 'byte';
                        return this.render(video, s);
                    }
                    throw new Error('Video upload failed (GL error ' + err + ')');
                }
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

            // Hardware filtering only works on unpacked float planes
            const linear = !this.packed;
            const k = MATRICES[s.matrix] || MATRICES['709'];
            this.frame = (this.frame + 1) % 16777216;
            const legacy = s.algo === 'gpu';
            const random = Math.random();
            // Inputs and uniforms of the deband code for a plane
            const debandInputs = (plane) => {
                // The legacy shader samples bilinearly, gpu-next the nearest pixel
                const inputs = [['u_tex', plane.tex, legacy && linear]];
                if (this.xorLut && !legacy)
                    inputs.push(['u_xor', this.xorLut, false]);
                return inputs;
            };
            const setDeband = (loc, plane, neutral) => {
                gl.uniform2f(loc.u_texSize, plane.w, plane.h);
                gl.uniform1i(loc.u_iter, s.iterations);
                if (legacy) {
                    gl.uniform1f(loc.u_random, random);
                    gl.uniform1f(loc.u_range, s.range);
                    gl.uniform1f(loc.u_threshold, s.threshold);
                    gl.uniform1f(loc.u_gain, s.grain / 8192.0);
                } else {
                    // Option mapping from mpv's vo_gpu_next.c, then the /1000
                    // (8-bit sources have a normalization scale of 1) from
                    // libplacebo's pl_shader_deband()
                    gl.uniform1f(loc.u_frame, this.frame);
                    gl.uniform1f(loc.u_radius, s.range);
                    gl.uniform1f(loc.u_threshold, s.threshold / 16.384 / 1000);
                    gl.uniform1f(loc.u_grain, s.grain / 8.192 / 1000);
                    gl.uniform2f(loc.u_neutral, neutral, neutral);
                }
            };
            const setOutput = (loc) => {
                gl.uniform2f(loc.u_k, k[0], k[1]);
                gl.uniform1i(loc.u_dither, s.dither ? 1 : 0);
                gl.uniform1f(loc.u_split, s.split ? 0.5 : -1.0);
            };

            if (this.fast) {
                const setFast = (loc) => {
                    setDeband(loc, this, 0); // the frame is the plane; neutral is set in the shader
                    setOutput(loc);
                    if (this.fastest) {
                        gl.uniform1f(loc.u_deltaScale, fastestDeltaScale(s));
                        gl.uniform2f(loc.u_csize, this.fastDelta.w, this.fastDelta.h);
                    }
                };
                if (this.fastest) {
                    this.pass(this.prog('fastestDelta'), this.fastDelta, [['u_src', this.src, false]], setFast);
                    this.pass(this.prog('fastestFinal'), null, [
                        ['u_src', this.src, false],
                        ['u_delta', this.fastDelta.tex, true],
                    ], setFast);
                } else {
                    this.pass(this.prog('fast'), null, [['u_src', this.src, false]], setFast);
                }
                return;
            }

            const setSrc = (loc) => {
                gl.uniform2f(loc.u_k, k[0], k[1]);
                gl.uniform2f(loc.u_srcSize, this.w, this.h);
            };
            this.pass(this.prog('prepY'), this.yPrep, [['u_src', this.src, false]], (loc) => {
                setSrc(loc);
                gl.uniform1i(loc.u_snap, s.snap ? 1 : 0);
            });
            // The 2x2 average needs bilinear filtering of the source
            const prepLow = (out, luma) => this.pass(this.prog('prepC'), out, [['u_src', this.src, true]], (loc) => {
                setSrc(loc);
                gl.uniform1i(loc.u_luma, luma ? 1 : 0);
            });
            prepLow(this.cPrep, false);

            // CfL Lite finishes in the final pass, the full CfL before it
            let upscaleInputs = [];
            if (this.chroma === 'cfl-lite') {
                prepLow(this.yLow, true);
                upscaleInputs = [['u_yl', this.yLow.tex, false], ['u_cl', this.cPrep.tex, false]];
            } else if (this.chroma === 'cfl') {
                this.pass(this.prog('prepYL'), this.yLow, [['u_src', this.src, true]], setSrc);
                this.pass(this.prog('cfl'), this.cPred, [
                    ['u_yl', this.yLow.tex, false],
                    ['u_cl', this.cPrep.tex, false],
                    ['u_src', this.src, false],
                ], (loc) => {
                    gl.uniform2f(loc.u_k, k[0], k[1]);
                    gl.uniform2f(loc.u_size, this.w, this.h);
                    gl.uniform2f(loc.u_csize, this.cPrep.w, this.cPrep.h);
                });
                upscaleInputs = [['u_pred', this.cPred.tex, false]];
            }

            this.pass(this.prog(legacy ? 'legacyC' : 'nextC'), this.cDelta,
                      debandInputs(this.cPrep), (loc) => setDeband(loc, this.cPrep, 128 / 255));

            this.pass(this.prog((legacy ? 'legacyFinal' : 'nextFinal') + FINAL_CHROMA[this.chroma]), null, [
                ...debandInputs(this.yPrep),
                ['u_c', this.cDelta.tex, linear],
                ['u_src', this.src, false],
                ...upscaleInputs,
            ], (loc) => {
                setDeband(loc, this.yPrep, 16 / 255);
                setOutput(loc);
                gl.uniform2f(loc.u_size, this.w, this.h);
                gl.uniform2f(loc.u_csize, this.cDelta.w, this.cDelta.h);
            });
        }
    }

    // ------------------------------------------------------------------
    // WebGPU renderer: the WebGL renderer's passes in WGSL, recorded into one
    // command buffer per frame
    // ------------------------------------------------------------------

    class WebGPUDebander {
        static async create(canvas) {
            if (!navigator.gpu)
                throw new Error('WebGPU is not available');
            // The default adapter: on laptops with two GPUs, usually the one
            // decoding the video
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter)
                throw new Error('WebGPU has no adapter (GPU blocklisted or disabled?)');
            return new WebGPUDebander(canvas, await adapter.requestDevice());
        }

        constructor(canvas, device) {
            this.canvas = canvas;
            this.device = device;
            this.frame = 0;
            this.w = 0;
            this.h = 0;
            this.copyFormat = null;
            this.fast = false;
            this.fastest = false;
            this.chroma = 'browser';
            this.textures = [];
            this.pipelines = {};
            this.maxSize = device.limits.maxTextureDimension2D;
            // Video is imported as an external texture until the browser
            // turns that down
            this.external = typeof device.importExternalTexture === 'function';
            this.near = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
            this.lin = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
            // A slot of uniforms per pass, written in one go each frame
            const maxPasses = 6;
            this.params = device.createBuffer({
                size: PARAMS_STRIDE * maxPasses, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.paramData = new DataView(new ArrayBuffer(PARAMS_STRIDE * maxPasses));
            this.format = navigator.gpu.getPreferredCanvasFormat();
            this.context = canvas.getContext('webgpu');
            if (!this.context) {
                device.destroy();
                throw new Error('The canvas has no WebGPU context');
            }
            this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
        }

        get description() {
            return `WebGPU, ${this.fastest ? 'half resolution pass' : this.fast ? 'single pass' : 'float planes'}, ` +
                   (this.external ? 'imported video' : `${this.copyFormat === 'rgba16float' ? 'RGBA16F' : 'RGBA8'} copy`) +
                   CHROMA_DESCRIPTION[this.chroma];
        }

        destroy() {
            this.device.destroy();
        }

        // The program name rendering to format. Its bind group layout comes
        // from the bindings the code declares, used or not.
        pipeline(name, format) {
            const key = name + ' ' + format;
            if (this.pipelines[key])
                return this.pipelines[key];
            const device = this.device;
            const code = WGSL_COMMON + (this.external ? WGSL_SRC_EXTERNAL : WGSL_SRC_COPY) + WGSL_PROGRAMS[name];
            const module = device.createShaderModule({ code });
            module.getCompilationInfo().then((info) => {
                for (const m of info.messages) {
                    if (m.type === 'error')
                        console.error(`[yt-deband] WGSL ${name} ${m.lineNum}:${m.linePos}: ${m.message}`);
                }
            });
            const bindings = [...code.matchAll(/@binding\((\d+)\) var(<uniform>)? (\w+): (\w+)/g)]
                .map(([, binding, uniform, name, type]) => ({ binding: +binding, name, type: uniform ? 'uniform' : type }));
            const layout = device.createBindGroupLayout({
                entries: bindings.map(({ binding, type }) => Object.assign({ binding, visibility: GPUShaderStage.FRAGMENT },
                    type === 'uniform' ? { buffer: {} }
                        : type === 'sampler' ? { sampler: {} }
                            : type === 'texture_external' ? { externalTexture: {} } : { texture: {} })),
            });
            const pipeline = device.createRenderPipeline({
                layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format }] },
            });
            return (this.pipelines[key] = { pipeline, layout, bindings });
        }

        texture(w, h, format, copyDst) {
            const tex = this.device.createTexture({
                size: [w, h], format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
                       (copyDst ? GPUTextureUsage.COPY_DST : 0),
            });
            this.textures.push(tex);
            return { tex, view: tex.createView(), format, w, h };
        }

        // Formats as in WebGLDebander.resize()
        resize(w, h, s) {
            const fastest = s.algo === 'fastest';
            const fast = s.algo === 'fast' || fastest;
            // A copied frame is uploaded as in WebGL2
            const copyFormat = this.external ? null : s.precision === 'half' && !fast ? 'rgba16float' : 'rgba8unorm';
            const yFormat = fast ? null : s.snap && s.algo !== 'gpu' ? 'r8unorm' : 'r16float';
            const chroma = !fast && (s.chroma === 'cfl' || s.chroma === 'cfl-lite') ? s.chroma : 'browser';
            if (w === this.w && h === this.h && copyFormat === this.copyFormat && yFormat === this.yFormat &&
                chroma === this.chroma && fastest === this.fastest)
                return;
            for (const t of this.textures)
                t.destroy();
            this.textures = [];

            const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
            this.src = copyFormat && this.texture(w, h, copyFormat, true);
            if (!fast) {
                this.yPrep = this.texture(w, h, yFormat);
                this.cPrep = this.texture(cw, ch, 'rg16float');
                this.cDelta = this.texture(cw, ch, 'rg16float');
            }
            if (chroma !== 'browser')
                this.yLow = this.texture(cw, ch, 'r16float');
            if (chroma === 'cfl')
                this.cPred = this.texture(w, h, 'rg16float');
            if (fastest)
                this.fastDelta = this.texture(cw, ch, 'rgba8unorm');

            this.canvas.width = w;
            this.canvas.height = h;
            this.w = w;
            this.h = h;
            this.copyFormat = copyFormat;
            this.yFormat = yFormat;
            this.fast = fast;
            this.fastest = fastest;
            this.chroma = chroma;
        }

        // Params into the uniform slot at offset, in WGSL_PARAMS layout;
        // missing ones are 0
        writeParams(offset, params) {
            const view = this.paramData;
            for (const [name, n, type] of WGSL_PARAMS) {
                const v = params[name];
                for (let i = 0; i < n; i++, offset += 4) {
                    const x = v === undefined ? 0 : n > 1 ? v[i] : v;
                    if (type === 'i32')
                        view.setInt32(offset, x, true);
                    else if (type === 'u32')
                        view.setUint32(offset, x, true);
                    else
                        view.setFloat32(offset, x, true);
                }
            }
        }

        render(video, s) {
            const device = this.device;
            this.resize(video.videoWidth, video.videoHeight, s);
            let src;
            if (this.external) {
                try {
                    src = device.importExternalTexture({ source: video });
                } catch (e) {
                    console.info('[yt-deband] WebGPU can\'t import the video, copying it instead:', e.message);
                    this.external = false;
                    this.pipelines = {};
                    return this.render(video, s);
                }
            } else {
                device.queue.copyExternalImageToTexture({ source: video }, { texture: this.src.tex }, [this.w, this.h]);
                src = this.src.view;
            }

            const k = MATRICES[s.matrix] || MATRICES['709'];
            this.frame = (this.frame + 1) % 16777216;
            const legacy = s.algo === 'gpu';
            const random = Math.random();
            const encoder = device.createCommandEncoder();
            let slots = 0;
            // Draws program name into target (null for the canvas) with
            // params and the textures in inputs, by binding name
            const pass = (name, target, inputs, params) => {
                const p = this.pipeline(name, target ? target.format : this.format);
                const offset = PARAMS_STRIDE * slots++;
                this.writeParams(offset, params);
                const resources = Object.assign({
                    P: { buffer: this.params, offset, size: PARAMS_SIZE },
                    s_near: this.near, s_lin: this.lin, u_src: src,
                }, inputs);
                const group = device.createBindGroup({
                    layout: p.layout,
                    entries: p.bindings.map(({ binding, name }) => ({ binding, resource: resources[name] })),
                });
                const rp = encoder.beginRenderPass({
                    colorAttachments: [{
                        view: target ? target.view : this.context.getCurrentTexture().createView(),
                        loadOp: 'clear', storeOp: 'store',
                    }],
                });
                rp.setPipeline(p.pipeline);
                rp.setBindGroup(0, group);
                rp.draw(3);
                rp.end();
            };
            // Deband params for a plane, mapped as in WebGLDebander.render()
            const deband = (plane, neutral) => Object.assign({ texSize: [plane.w, plane.h], iter: s.iterations }, legacy
                ? { random, range: s.range, threshold: s.threshold, gain: s.grain / 8192.0 }
                : { frame: this.frame, radius: s.range, threshold: s.threshold / 16.384 / 1000,
                    grain: s.grain / 8.192 / 1000, neutral: [neutral, neutral] });
            const output = { k, dither: s.dither ? 1 : 0, split: s.split ? 0.5 : -1.0 };

            if (this.fastest) {
                const params = Object.assign(deband(this, 0), output,
                                             { csize: [this.fastDelta.w, this.fastDelta.h], deltaScale: fastestDeltaScale(s) });
                pass('fastestDelta', this.fastDelta, {}, params);
                pass('fastestFinal', null, { u_delta: this.fastDelta.view }, params);
            } else if (this.fast) {
                pass('fast', null, {}, Object.assign(deband(this, 0), output));
            } else {
                const srcParams = { k, srcSize: [this.w, this.h] };
                pass('prepY', this.yPrep, {}, Object.assign({ snap: s.snap ? 1 : 0 }, srcParams));
                pass('prepC', this.cPrep, {}, srcParams);

                let upscaleInputs = {};
                if (this.chroma === 'cfl-lite') {
                    pass('prepC', this.yLow, {}, Object.assign({ luma: 1 }, srcParams));
                    upscaleInputs = { u_yl: this.yLow.view, u_cl: this.cPrep.view };
                } else if (this.chroma === 'cfl') {
                    pass('prepYL', this.yLow, {}, srcParams);
                    pass('cfl', this.cPred, { u_yl: this.yLow.view, u_cl: this.cPrep.view },
                         { k, size: [this.w, this.h], csize: [this.cPrep.w, this.cPrep.h] });
                    upscaleInputs = { u_pred: this.cPred.view };
                }

                pass(legacy ? 'legacyC' : 'nextC', this.cDelta, { u_tex: this.cPrep.view },
                     deband(this.cPrep, 128 / 255));
                pass((legacy ? 'legacyFinal' : 'nextFinal') + FINAL_CHROMA[this.chroma], null,
                     Object.assign({ u_tex: this.yPrep.view, u_c: this.cDelta.view }, upscaleInputs),
                     Object.assign(deband(this.yPrep, 16 / 255), output,
                                   { size: [this.w, this.h], csize: [this.cDelta.w, this.cDelta.h] }));
            }
            device.queue.writeBuffer(this.params, 0, this.paramData.buffer, 0, PARAMS_STRIDE * slots);
            device.queue.submit([encoder.finish()]);
        }
    }

    // ------------------------------------------------------------------
    // Attaching to the YouTube player
    // ------------------------------------------------------------------

    let video = null;
    let canvas = null;
    let debander = null;
    let frameCallbackId = null;
    let rafId = null;
    let boxObservers = [];
    // Render per animation frame instead of per video frame callback
    let perDisplayFrame = false;
    // Video frame callbacks are available and watched for throttling
    let watchFrames = false;
    let lastPresented = -1;

    // Fingerprinting protection (Tor/Mullvad Browser) rounds timers to whole
    // 60 Hz frames (16.7 ms) and throttles video frame callbacks with them;
    // normal browsers step in well under a millisecond. Spins until three
    // timer steps are seen, at most a few dozen ms, once.
    const coarseTimers = (() => {
        const steps = [];
        let a = performance.now();
        for (let i = 0; i < 5e6 && steps.length < 3; i++) {
            const b = performance.now();
            if (b !== a) {
                steps.push(b - a);
                a = b;
            }
        }
        return steps.length > 0 && steps.every((d) => d >= 10);
    })();
    // Device pixels per CSS pixel, or null until known. The same protection
    // reports devicePixelRatio as 2 whatever the screen's scaling, which
    // would put the canvas's edges between device pixels where Firefox draws
    // it a pixel narrower than the video. A ResizeObserver's device-pixel
    // size isn't spoofed; a probe a million pixels wide makes that rounded
    // size exact enough.
    let devicePixels = null;
    (() => {
        const probe = document.createElement('div'), inner = document.createElement('div');
        probe.style.cssText = 'position: fixed; left: 0; top: 0; width: 0; height: 0; overflow: hidden; visibility: hidden; pointer-events: none';
        inner.style.cssText = 'width: 1000000px; height: 0';
        probe.append(inner);
        try {
            new ResizeObserver(([entry]) => {
                const size = entry.devicePixelContentBoxSize?.[0]?.inlineSize;
                if (!size)
                    return;
                devicePixels = size / 1e6;
                syncBox();
            }).observe(inner, { box: 'device-pixel-content-box' });
        } catch {
            return;
        }
        document.documentElement.append(probe);
    })();
    // Firefox on Windows shows video through a DirectComposition overlay
    // scaled to an even number of device pixels each way (NV12 needs it):
    // one more than the rounded picture when that's odd, the extra cut off
    // by the box's edge (DCSurfaceVideo::CalculateSwapChainSize). The canvas
    // follows, or the picture's right or bottom edge moves when toggling.
    const evenVideoOverlay = /Windows/.test(navigator.userAgent) && /Firefox\//.test(navigator.userAgent);
    // Video frame callbacks in the current second and how many saw
    // presentedFrames skip ahead, and seconds in a row that called for the
    // other render mode
    let frameWindow = { since: -1, callbacks: 0, skips: 0 };
    let modeStreak = 0;
    let status = '';
    // Render rate and CPU time, summarized once a second in the panel
    const stats = { count: 0, cpu: 0, since: performance.now() };

    function setStatus(text) {
        status = text;
        if (panel)
            panel.showStatus(text);
        if (text.startsWith('Error') && !(panel && panel.root.style.display !== 'none'))
            showNotice('YouTube Deband: ' + text);
    }

    // Short-lived message so failures are noticed without opening the panel
    function showNotice(text) {
        const n = document.createElement('div');
        n.textContent = text;
        Object.assign(n.style, {
            position: 'fixed', bottom: '24px', left: '24px', zIndex: '2147483647', maxWidth: '480px',
            background: 'rgba(120,20,20,0.95)', color: '#fff', padding: '8px 12px', borderRadius: '6px',
            font: '13px/1.4 system-ui, sans-serif', pointerEvents: 'none',
        });
        (document.body || document.documentElement).append(n);
        setTimeout(() => n.remove(), 8000);
    }

    function attach(v) {
        detach();
        video = v;
        canvas = document.createElement('canvas');
        canvas.className = 'yt-deband-canvas';
        Object.assign(canvas.style, {
            position: 'absolute', pointerEvents: 'none', display: 'none',
        });
        v.after(canvas);
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            debander = null;
            setStatus('WebGL context lost');
        });
        canvas.addEventListener('webglcontextrestored', () => {
            createDebander();
            requestRender();
        });
        for (const ev of ['seeked', 'loadeddata', 'resize'])
            v.addEventListener(ev, requestRender);
        // While paused nothing redraws, so follow the video's box separately
        // (theater mode and fullscreen resize and move it; YouTube sets
        // left/top in its inline style)
        const resize = new ResizeObserver(syncBox);
        resize.observe(v);
        const style = new MutationObserver(syncBox);
        style.observe(v, { attributes: true, attributeFilter: ['style', 'class'] });
        boxObservers = [resize, style];
        watchFrames = !!v.requestVideoFrameCallback && !coarseTimers;
        perDisplayFrame = !watchFrames;
        lastPresented = -1;
        frameWindow = { since: -1, callbacks: 0, skips: 0 };
        modeStreak = 0;
        createDebander();
        schedule();
    }

    function detach() {
        if (!video)
            return;
        for (const ev of ['seeked', 'loadeddata', 'resize'])
            video.removeEventListener(ev, requestRender);
        if (frameCallbackId !== null && video.cancelVideoFrameCallback)
            video.cancelVideoFrameCallback(frameCallbackId);
        if (rafId !== null)
            cancelAnimationFrame(rafId);
        frameCallbackId = rafId = null;
        for (const o of boxObservers)
            o.disconnect();
        boxObservers = [];
        canvas.remove();
        if (debander && debander.destroy)
            debander.destroy();
        video = canvas = debander = creating = null;
    }

    // WebGPU failed on this page, so Auto uses WebGL until it reloads
    let webgpuBroken = false;
    // Token of the renderer being set up, while it is (WebGPU sets up
    // asynchronously)
    let creating = null;

    // Auto tries WebGPU first, then WebGL2, then WebGL1
    async function makeDebander(c, backend) {
        if (backend === 'webgpu' || (backend === 'auto' && !webgpuBroken)) {
            try {
                return await WebGPUDebander.create(c);
            } catch (e) {
                if (backend === 'webgpu')
                    throw e;
                console.info('[yt-deband] WebGPU unavailable, using WebGL:', e.message);
            }
        }
        return new WebGLDebander(c, backend);
    }

    function createDebander() {
        const token = creating = {};
        makeDebander(canvas, settings.backend).then((d) => {
            if (creating !== token) {
                // Detached or replaced meanwhile
                if (d.destroy)
                    d.destroy();
                return;
            }
            creating = null;
            debander = d;
            if (d.device)
                watchDevice(d);
            setStatus('Ready: ' + d.description);
            requestRender();
        }, (e) => {
            if (creating !== token)
                return;
            creating = null;
            debander = null;
            setStatus('Error: ' + e.message);
            console.error('[yt-deband]', e);
        });
    }

    // A lost device (driver reset, GPU process crash) is set up again on a new
    // canvas, so WebGL can take over if WebGPU doesn't come back; an error
    // fails over
    function watchDevice(d) {
        d.device.lost.then((info) => {
            if (debander !== d || info.reason === 'destroyed')
                return;
            console.warn('[yt-deband] WebGPU device lost:', info.message);
            attach(video);
        });
        d.device.addEventListener('uncapturederror', (e) => {
            if (debander === d)
                webgpuFailed(e.error.message);
        });
    }

    // WebGPU broke while rendering. Auto carries on with WebGL, on a new
    // canvas since a canvas keeps its first context type.
    function webgpuFailed(message) {
        console.error('[yt-deband] WebGPU:', message);
        if (settings.backend === 'auto') {
            webgpuBroken = true;
            attach(video);
            return;
        }
        canvas.style.display = 'none';
        setStatus('Error: WebGPU: ' + message);
        debander.destroy();
        debander = null;
    }

    // Render on every new video frame with requestVideoFrameCallback.
    // Fingerprinting protection (Tor/Mullvad Browser) throttles those
    // callbacks to ~20 Hz while the video keeps playing at its full rate, so
    // presentedFrames skips frames. That is detected up front from coarse
    // timers; then render on every animation frame while playing instead
    // (each upload takes whatever frame is current). currentTime can't detect
    // new frames either, as it is rounded the same way.
    //
    // As a fallback the callbacks are watched for skips, and keep being
    // watched while rendering per display frame. Throttling skips steadily,
    // while page loads, seeks and quality switches stall the page in bursts,
    // so the mode only changes after 3 seconds in a row that call for it,
    // either way. A wrong switch is costly: on a high refresh rate display it
    // uploads and debands each video frame several times.
    function schedule() {
        if (!video)
            return;
        if (watchFrames && frameCallbackId === null)
            frameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
        if (perDisplayFrame && rafId === null) {
            let lastTime = -1;
            const tick = () => {
                rafId = requestAnimationFrame(tick);
                if (video && (!video.paused || video.currentTime !== lastTime)) {
                    lastTime = video.currentTime;
                    draw();
                }
            };
            rafId = requestAnimationFrame(tick);
        }
    }

    function onVideoFrame(now, meta) {
        frameCallbackId = null;
        if (lastPresented >= 0) {
            frameWindow.callbacks++;
            if (meta.presentedFrames - lastPresented > 1)
                frameWindow.skips++;
        }
        lastPresented = meta.presentedFrames;
        if (frameWindow.since < 0)
            frameWindow.since = now;
        // Seconds with few callbacks (low frame rate, paused) say nothing
        if (now - frameWindow.since >= 1000) {
            if (frameWindow.callbacks >= 10) {
                // At 20 Hz, 24 fps video skips in 1 callback of 5, 60 fps in all
                const throttled = frameWindow.skips * 6 >= frameWindow.callbacks;
                modeStreak = throttled !== perDisplayFrame ? modeStreak + 1 : 0;
                if (modeStreak >= 3) {
                    modeStreak = 0;
                    perDisplayFrame = throttled;
                    if (!throttled) {
                        cancelAnimationFrame(rafId);
                        rafId = null;
                    }
                    console.info(throttled
                        ? '[yt-deband] video frame callbacks are throttled; rendering per display frame'
                        : '[yt-deband] video frame callbacks keep up again; rendering per video frame');
                }
            }
            frameWindow = { since: now, callbacks: 0, skips: 0 };
        }
        if (!perDisplayFrame)
            draw();
        schedule();
    }

    // Lay the canvas over exactly where the browser draws the video's picture.
    // YouTube positions the video element with inline styles, sized to the
    // aspect ratio of the video's top resolution, and each stream is fitted
    // into that box with object-fit (contain or cover), so streams whose
    // rounded size is off that ratio don't fill it exactly. Browsers draw the
    // picture with its edges rounded to device pixels, but Firefox only
    // rounds a canvas's origin and keeps its fractional size, so a canvas
    // given the same object-fit came out a fraction of a pixel larger,
    // shifting the picture toward the right or bottom edge. So the picture's
    // rect is worked out here and rounded like the video's, and the canvas
    // fills it (clipped to the box where cover crops). Fractions of a CSS
    // pixel matter throughout, so nothing goes through offsetWidth and the
    // like, which round to whole pixels.
    function syncBox() {
        if (!video || !canvas)
            return;
        const cs = getComputedStyle(video);
        const box = video.getBoundingClientRect();
        const vw = video.videoWidth, vh = video.videoHeight;
        let w = box.width, h = box.height;
        if (vw && vh && cs.objectFit !== 'fill') {
            const fit = cs.objectFit === 'cover' ? Math.max : Math.min;
            let scale = cs.objectFit === 'none' ? 1 : fit(box.width / vw, box.height / vh);
            if (cs.objectFit === 'scale-down')
                scale = Math.min(1, scale);
            w = vw * scale;
            h = vh * scale;
        }
        // object-position computes to "<x> <y>" in percentages or pixels
        const [px, py] = cs.objectPosition.split(' ');
        const offset = (v, free) => (v && v.endsWith('%') ? free * parseFloat(v) / 100
            : v && v.endsWith('px') ? parseFloat(v) : free / 2);
        const dpr = devicePixels || window.devicePixelRatio || 1;
        const device = (v) => Math.round(v * dpr);
        const snap = (v) => device(v) / dpr;
        const x = box.left + offset(px, box.width - w), y = box.top + offset(py, box.height - h);
        const [l, t, r, b] = [x, y, x + w, y + h].map(device);
        const left = l / dpr, top = t / dpr;
        const right = (evenVideoOverlay ? r + (r - l) % 2 : r) / dpr;
        const bottom = (evenVideoOverlay ? b + (b - t) % 2 : b) / dpr;
        // Where the box is, in the coordinates the canvas is positioned in
        const boxLeft = cs.left.endsWith('px') ? parseFloat(cs.left) : video.offsetLeft;
        const boxTop = cs.top.endsWith('px') ? parseFloat(cs.top) : video.offsetTop;
        // The box clips the picture where cover crops; that edge is rounded too
        const clip = [snap(box.top) - top, right - snap(box.right), bottom - snap(box.bottom), snap(box.left) - left]
            .map((v) => Math.max(0, v));
        Object.assign(canvas.style, {
            left: boxLeft + left - box.left + 'px',
            top: boxTop + top - box.top + 'px',
            width: right - left + 'px',
            height: bottom - top + 'px',
            clipPath: clip.some((v) => v > 0) ? `inset(${clip.map((v) => v + 'px').join(' ')})` : '',
        });
    }
    document.addEventListener('fullscreenchange', syncBox);

    // Redraw the current frame (settings changed, seeked while paused...)
    function requestRender() {
        requestAnimationFrame(draw);
    }

    // Why the current video can't be debanded, or null
    function skipReason() {
        // EME protected video uploads as black (or not at all)
        if (video.mediaKeys)
            return 'protected (DRM) video, which browsers do not let WebGL or WebGPU read.';
        if (video.videoWidth > debander.maxSize || video.videoHeight > debander.maxSize)
            return `${video.videoWidth}x${video.videoHeight} video exceeds this browser's ` +
                   `${debander.maxSize}px texture limit (fingerprinting protection). Use 1080p or lower.`;
        if (hdrStream())
            return 'HDR video (PQ/HLG or BT.2020); only SDR BT.709/BT.601 is supported.';
        return null;
    }

    // YouTube only serves HDR streams to HDR displays. The stream's color
    // space comes from a WebCodecs VideoFrame, probed once per stream and
    // resolution; without WebCodecs it is assumed to be SDR.
    let hdrProbe = { key: null, hdr: false };
    function hdrStream() {
        const key = `${video.currentSrc} ${video.videoWidth}x${video.videoHeight}`;
        if (hdrProbe.key === key || typeof VideoFrame === 'undefined')
            return hdrProbe.hdr;
        let hdr = false;
        try {
            const frame = new VideoFrame(video);
            const cs = frame.colorSpace;
            frame.close();
            hdr = cs.transfer === 'pq' || cs.transfer === 'hlg' ||
                  cs.primaries === 'bt2020' || cs.matrix === 'bt2020-ncl';
        } catch (e) {
            return false; // no frame yet, retry on the next draw
        }
        hdrProbe = { key, hdr };
        return hdr;
    }

    function draw() {
        if (!video || !canvas)
            return;
        const ready = settings.enabled && debander && video.readyState >= 2 && video.videoWidth > 0;
        if (!ready) {
            canvas.style.display = 'none';
            return;
        }
        // Video this script can't handle: play it undebanded and pick up again
        // when that changes (not an error that stops retrying)
        const skip = skipReason();
        if (skip) {
            canvas.style.display = 'none';
            const msg = 'Skipped: ' + skip;
            if (status !== msg) {
                setStatus(msg);
                showNotice('YouTube Deband: ' + msg);
            }
            return;
        }
        syncBox();
        canvas.style.display = 'block';
        try {
            const t0 = performance.now();
            debander.render(video, settings);
            const t1 = performance.now();
            stats.count++;
            stats.cpu += t1 - t0;
            if (t1 - stats.since >= 1000) {
                if (panel && panel.root.style.display !== 'none') {
                    const rate = stats.count * 1000 / (t1 - stats.since);
                    const gap = stats.count > 1 ? (t1 - stats.since) / stats.count : 0;
                    setStatus(`${debander.w}x${debander.h}, ${debander.description}, ` +
                              `${perDisplayFrame ? 'per display frame' : 'per video frame'}: ` +
                              `${rate.toFixed(1)} renders/s, ${(stats.cpu / stats.count).toFixed(2)} ms CPU each, ` +
                              `${gap.toFixed(1)} ms apart`);
                }
                stats.count = 0;
                stats.cpu = 0;
                stats.since = t1;
            }
        } catch (e) {
            if (debander.device)
                return webgpuFailed(e.message);
            canvas.style.display = 'none';
            setStatus('Error: ' + e.message);
            console.error('[yt-deband]', e);
            debander = null;
        }
    }

    // "DB" button in the player's control bar that opens the settings panel
    function ensurePlayerButton() {
        const controls = document.querySelector('#movie_player .ytp-right-controls');
        if (!controls || controls.querySelector('.yt-deband-button'))
            return;
        const button = document.createElement('button');
        button.className = 'ytp-button yt-deband-button';
        button.title = 'Deband settings';
        button.textContent = 'DB';
        Object.assign(button.style, {
            font: 'bold 13px system-ui, sans-serif', textAlign: 'center', verticalAlign: 'top',
        });
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePanel();
        });
        controls.prepend(button);
    }

    // YouTube is a single page app and may swap the <video> element
    setInterval(() => {
        ensurePlayerButton();
        const v = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
        if (v !== video) {
            if (v)
                attach(v);
            else
                detach();
        } else if (video && !debander && !creating && settings.enabled && !status.startsWith('Error')) {
            createDebander();
        }
    }, 1000);

    // ------------------------------------------------------------------
    // Settings panel (built with DOM calls: YouTube enforces Trusted Types,
    // so innerHTML is not allowed)
    // ------------------------------------------------------------------

    let panel = null;

    function el(tag, props, ...children) {
        const e = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (k === 'style')
                    Object.assign(e.style, v);
                else if (k.startsWith('on'))
                    e.addEventListener(k.slice(2), v);
                else if (k === 'role' || k.startsWith('aria-'))
                    e.setAttribute(k, v);
                else
                    e[k] = v;
            }
        }
        for (const c of children)
            e.append(c);
        return e;
    }

    function applySetting(key, value) {
        applySettings({ [key]: value });
    }

    function applySettings(values) {
        Object.assign(settings, values);
        saveSettings();
        refreshPanel();
        // A canvas keeps its first context type, so a backend switch needs a
        // new one. Picking a renderer also gives WebGPU another chance.
        if ('backend' in values) {
            webgpuBroken = false;
            if (video)
                attach(video);
        }
        requestRender();
    }

    const presetValues = (s) => Object.fromEntries(PRESET_KEYS.map((k) => [k, s[k]]));
    const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

    // The preset the deband parameters come from: the one picked last while
    // they still match it, otherwise the first that matches, or null
    function activePreset() {
        const all = FACTORY_PRESETS.concat(customPresets);
        const matches = (p) => PRESET_KEYS.every((k) => p[k] === settings[k]);
        return all.find((p) => p.name === settings.preset && matches(p)) || all.find(matches) || null;
    }

    function applyPreset(name) {
        const p = FACTORY_PRESETS.concat(customPresets).find((q) => q.name === name);
        if (p)
            applySettings(Object.assign({ preset: p.name }, presetValues(p)));
    }

    // Saves the current deband parameters as one of the user's presets,
    // replacing theirs with the same name in any case. Returns whether it did.
    function savePreset(name) {
        const preset = Object.assign({ name }, presetValues(settings));
        const i = customPresets.findIndex((p) => sameName(p.name, name));
        if (i >= 0)
            customPresets[i] = preset;
        else
            customPresets.push(preset);
        savePresets();
        applySettings({ preset: name });
        return i >= 0;
    }

    function deletePreset(name) {
        customPresets = customPresets.filter((p) => p.name !== name);
        savePresets();
        refreshPanel();
    }

    // One line of mpv.conf as [[option, value or null]], following mpv's
    // options/parse_configfile.c: # starts a comment outside quotes, values
    // may be "quoted", 'quoted' or %length%quoted. A line of command line
    // flags ("--deband-threshold=35 --deband-grain=16") gives each of them.
    function mpvLineOptions(line) {
        line = line.trim();
        if (/^--\S+\s+--/.test(line))
            return line.split(/\s+(?=--)/).flatMap(mpvLineOptions);
        const m = /^(?:--)?([\w-]+)\s*(?:=\s*(?:"([^"]*)"\s*(?:#.*)?|'([^']*)'\s*(?:#.*)?|%(\d+)%(.*)|(.*))|(?:#.*)?)$/.exec(line);
        if (!m)
            return []; // blank, a comment or not an option
        let value = m[2] ?? m[3] ?? null;
        if (m[4] !== undefined)
            value = m[5].slice(0, +m[4]);
        else if (m[6] !== undefined)
            value = m[6].split('#')[0].trim(); // unquoted: up to the comment
        return [[m[1], value]];
    }

    // Applies mpv.conf text or command line flags the way mpv would at
    // startup: deband=yes, the four deband-* values, vo (gpu or gpu-next as the
    // mode; Fast and Fastest count as gpu-next and stay) and glsl-shaders
    // (a CfL shader as the chroma upscaling). Profiles only count where a
    // top-level profile=<name> applies them; auto profiles are skipped, as
    // their conditions can't be checked here. Options the text doesn't set
    // keep their values. Returns a summary for the status line.
    function parseMpvOptions(text) {
        const top = [];
        const profiles = new Map();
        let section = top;
        for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
            const header = /^\s*\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
            if (header) {
                const name = header[1];
                section = name === 'default' ? top : profiles.get(name) || [];
                if (name !== 'default')
                    profiles.set(name, section);
            } else {
                section.push(...mpvLineOptions(line));
            }
        }

        const values = {};
        let shaders = null; // the glsl-shaders list, once the text touches it
        const used = new Set();
        const run = (options, depth) => {
            for (let [name, value] of options) {
                // Flags take no-name for name=no
                if (name.startsWith('no-') && value === null) {
                    name = name.slice(3);
                    value = 'no';
                }
                const param = /^deband-(iterations|threshold|range|grain)$/.exec(name);
                if (name === 'deband') {
                    if (value === null || value === 'yes' || value === 'no')
                        values.enabled = value !== 'no';
                } else if (param && isFinite(parseFloat(value))) {
                    const [lo, hi] = LIMITS[param[1]];
                    const v = Math.min(hi, Math.max(lo, parseFloat(value)));
                    values[param[1]] = param[1] === 'iterations' ? Math.round(v) : v;
                } else if (name === 'vo' && value !== null) {
                    values.vo = value.split(',')[0].trim();
                } else if (name === 'glsl-shaders' && value !== null) {
                    // Paths are separated by ; on Windows and : elsewhere
                    shaders = value.split(/;|:(?![\\/])/).map((s) => s.trim()).filter(Boolean);
                } else if (/^glsl-shaders?(-append|-add)?$/.test(name) && value !== null) {
                    shaders = (shaders || []).concat(value);
                } else if (name === 'glsl-shaders-pre' && value !== null) {
                    shaders = [value].concat(shaders || []);
                } else if (name === 'glsl-shaders-clr') {
                    shaders = [];
                } else if (name === 'glsl-shaders-remove' && value !== null) {
                    shaders = (shaders || []).filter((s) => s !== value);
                } else if (name === 'glsl-shaders-toggle' && value !== null) {
                    shaders = (shaders || []).includes(value) ? shaders.filter((s) => s !== value) : (shaders || []).concat(value);
                } else if (name === 'profile' && value !== null && depth < 10) {
                    // Built-in profiles (high-quality, fast...) don't touch these
                    for (const p of value.split(',').map((s) => s.trim())) {
                        if (profiles.has(p)) {
                            used.add(p);
                            run(profiles.get(p), depth + 1);
                        }
                    }
                }
            }
        };
        run(top, 0);

        const applied = [];
        const changes = {};
        // deband=no is ignored: an mpv.conf often has it at the top with an
        // auto profile turning debanding back on for some videos (streams,
        // say), which can't be told apart here
        if (values.enabled) {
            changes.enabled = true;
            applied.push('deband=yes');
        }
        for (const k of PRESET_KEYS) {
            if (k in values) {
                changes[k] = values[k];
                applied.push(`deband-${k}=${values[k]}`);
            }
        }
        if (values.vo === 'gpu' || values.vo === 'gpu-next') {
            const nextLike = settings.algo === 'fast' || settings.algo === 'fastest';
            changes.algo = values.vo === 'gpu' ? 'gpu' : nextLike ? settings.algo : 'gpu-next';
            applied.push('vo=' + values.vo);
        }
        if (shaders) {
            const cfl = shaders.map((s) => /CfL_Prediction(_Lite)?\.glsl$/i.exec(s)).find(Boolean);
            changes.chroma = !cfl ? 'browser' : cfl[1] ? 'cfl-lite' : 'cfl';
            applied.push(cfl ? (cfl[1] ? 'CfL Lite' : 'CfL') + ' shader' : 'browser chroma (no CfL shader)');
        }
        applySettings(changes);

        const skipped = profiles.size - used.size;
        return (applied.length ? 'Applied ' + applied.join(', ') : 'Found no deband, vo or shader options') +
               (used.size ? ` (with profile ${[...used].join(', ')})` : '') +
               (values.enabled === false ? '; ignored deband=no' : '') +
               (skipped ? `; skipped ${skipped} profile${skipped === 1 ? '' : 's'} not applied at the top level` : '');
    }

    // The panel lives in a shadow root, so YouTube's styles don't reach it and
    // these don't leak out. YouTube sets no style-src, so a <style> is allowed.
    const PANEL_CSS = `
:host { all: initial; color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel {
    --line: rgba(255, 255, 255, 0.1); --field: rgba(0, 0, 0, 0.35); --raised: rgba(255, 255, 255, 0.08);
    --hover: rgba(255, 255, 255, 0.14); --text: #f1f1f1; --muted: #aaa; --accent: #3ea6ff;
    --ok: #2ba640; --warn: #f2a33a; --error: #ff6b63;
    display: flex; flex-direction: column; width: 340px; max-width: calc(100vw - 32px); max-height: calc(100vh - 88px);
    overflow: hidden; background: rgba(28, 28, 28, 0.97); color: var(--text);
    border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
    font: 13px/1.4 Roboto, Arial, system-ui, sans-serif;
}
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.head { display: flex; align-items: center; gap: 10px; padding: 12px 10px 10px 14px; cursor: move; user-select: none; touch-action: none; }
.logo {
    flex: none; width: 22px; height: 22px; border-radius: 6px;
    background: linear-gradient(#8ccbff 0 25%, #4fadff 25% 50%, #2584e6 50% 75%, #1660bd 75%) left / 50% 100% no-repeat,
                linear-gradient(#8ccbff, #1660bd) right / 50% 100% no-repeat;
}
.title { flex: 1; min-width: 0; font-size: 15px; font-weight: 500; white-space: nowrap; }
.version { margin-left: 6px; color: var(--muted); font-size: 11px; font-weight: 400; }
.state { min-width: 22px; color: var(--muted); font-size: 12px; text-align: right; }
.icon {
    display: grid; place-items: center; flex: none; width: 30px; height: 30px; padding: 0;
    border: 0; border-radius: 50%; background: transparent; color: var(--muted); cursor: pointer;
}
.icon:hover { background: var(--hover); color: var(--text); }
.icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.tabs { display: flex; padding: 0 8px; border-bottom: 1px solid var(--line); }
.tab {
    flex: 1; padding: 8px 0 9px; margin-bottom: -1px; border: 0; border-bottom: 2px solid transparent;
    background: none; color: var(--muted); font-weight: 500; cursor: pointer;
}
.tab:hover { color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }

.body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 14px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent; }
.group { padding: 12px 0; border-bottom: 1px solid var(--line); }
.group:last-child { border-bottom: 0; }
.label { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 8px; font-weight: 500; }
.about { min-height: 2.8em; margin-top: 8px; color: var(--muted); font-size: 12px; }
.only { display: none; color: var(--warn); font-size: 11px; font-weight: 400; }
.fast .full-only { opacity: 0.55; }
.fast .only { display: inline; }

.seg { display: flex; gap: 3px; padding: 3px; background: var(--field); border: 1px solid var(--line); border-radius: 9px; }
.seg button {
    flex: 1; min-width: 0; padding: 6px 4px; border: 0; border-radius: 6px; background: transparent;
    white-space: nowrap; cursor: pointer; transition: background 0.15s, color 0.15s;
}
.seg button:hover { background: var(--hover); }
.seg button[aria-checked="true"] { background: var(--accent); color: #0f0f0f; font-weight: 500; }

input[type="text"], input[type="number"], select, textarea {
    min-width: 0; padding: 6px 9px; background: var(--field); border: 1px solid var(--line); border-radius: 8px;
    outline: none; transition: border-color 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
::placeholder { color: #777; }
select {
    appearance: none; padding-right: 28px; cursor: pointer;
    background: var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%23aaa' stroke-width='1.5'/%3E%3C/svg%3E") right 9px center / 12px no-repeat;
}
option, optgroup { background: #282828; }
textarea { width: 100%; resize: vertical; font: 12px/1.5 ui-monospace, Consolas, monospace; }

.btn {
    flex: none; padding: 6px 14px; border: 0; border-radius: 18px; background: var(--raised);
    font-weight: 500; white-space: nowrap; cursor: pointer; transition: background 0.15s;
}
.btn:hover { background: var(--hover); }
.btn.primary { background: var(--accent); color: #0f0f0f; }
.btn.primary:hover { background: #65b8ff; }
.btn.danger { color: var(--error); }
.btn.danger.armed { background: var(--error); color: #fff; }

.row { display: flex; align-items: center; gap: 8px; }
.row > select, .row > input { flex: 1; }
.end { justify-content: flex-end; margin-top: 8px; }

.param { display: grid; grid-template-columns: 70px 1fr 56px; align-items: center; gap: 10px; margin: 4px 0; }
.param input[type="number"] { width: 100%; padding: 4px 6px; text-align: right; appearance: textfield; -moz-appearance: textfield; }
.param.over { --accent: var(--warn); }
.param.over input[type="number"] { border-color: var(--warn); color: var(--warn); }
.advice { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: rgba(242, 163, 58, 0.1); color: var(--warn); font-size: 12px; }
.advice div + div { margin-top: 4px; }
.param input::-webkit-inner-spin-button, .param input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
input[type="range"] { width: 100%; height: 20px; margin: 0; background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none; }
input[type="range"]::-webkit-slider-runnable-track {
    height: 4px; border-radius: 2px;
    background: linear-gradient(to right, var(--accent) calc(7px + var(--f, 0) * (100% - 14px)), rgba(255, 255, 255, 0.2) 0);
}
input[type="range"]::-webkit-slider-thumb {
    width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); transition: transform 0.1s; -webkit-appearance: none;
}
input[type="range"]::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.2); }
input[type="range"]::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--accent); }
input[type="range"]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
input[type="range"]:hover::-webkit-slider-thumb { transform: scale(1.15); }

.line { display: flex; align-items: center; gap: 12px; padding: 7px 0; cursor: pointer; }
.line + .line { margin-top: 4px; }
.text { flex: 1; min-width: 0; }
.desc { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.switch {
    position: relative; flex: none; width: 36px; height: 20px; padding: 0; border: 0; border-radius: 10px;
    background: rgba(255, 255, 255, 0.25); cursor: pointer; transition: background 0.15s;
}
.switch::after {
    content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); transition: transform 0.15s;
}
.switch[aria-checked="true"] { background: var(--accent); }
.switch[aria-checked="true"]::after { transform: translateX(16px); }
.key { flex: none; width: 128px; text-align: center; font-weight: 500; cursor: pointer; caret-color: transparent; }
.key:focus { color: var(--accent); }

.status {
    display: flex; align-items: flex-start; gap: 8px; padding: 9px 14px; border-top: 1px solid var(--line);
    background: rgba(0, 0, 0, 0.25); color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere;
}
.dot { flex: none; width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; background: #717171; }
.status.ok .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.status.warn .dot { background: var(--warn); }
.status.warn { color: var(--warn); }
.status.error .dot { background: var(--error); }
.status.error { color: var(--error); }
`;

    // Upper ends of the sliders where mpv's range is far wider than useful;
    // the number fields still take the full range
    const SLIDER_TOP = { iterations: 8, threshold: 256, grain: 128 };
    // Values past the point of diminishing returns (mpv's manual), flagged
    // with why; no preset trips these
    const PARAM_ADVICE = [
        ['iterations', (s) => s.iterations > 4, 'Past 4 iterations each step adds almost nothing but still costs GPU time.'],
        ['threshold', (s) => s.threshold > 128, 'Thresholds past 128 erase fine detail along with the banding.'],
        ['grain', (s) => s.grain > 64, 'Grain past 64 shows as visible noise.'],
        ['range', (s) => s.iterations > 1 && s.range > 24, 'The radius grows with each iteration, so with several a lower range usually works better.'],
    ];

    // "Ctrl+Alt+d" as "Ctrl + Alt + D"
    const formatCombo = (combo) => (combo.match(/[^+]+|\+$/g) || [])
        .map((p) => (p.length === 1 ? p.toUpperCase() : p)).join(' + ');

    function buildPanel() {
        const svg = (d) => {
            const NS = 'http://www.w3.org/2000/svg';
            const s = document.createElementNS(NS, 'svg');
            s.setAttribute('viewBox', '0 0 24 24');
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            s.append(path);
            return s;
        };
        const iconButton = (d, title, onclick) => el('button', { type: 'button', className: 'icon', title, 'aria-label': title, onclick }, svg(d));
        const button = (text, onclick, kind) => el('button', {
            type: 'button', className: kind ? 'btn ' + kind : 'btn', textContent: text, onclick,
        });
        // A titled block of the panel. Settings Fast and Fastest ignore are
        // dimmed while one of them is picked.
        const group = (title, fullOnly, ...content) => el('div', { className: fullOnly ? 'group full-only' : 'group' },
            ...(title ? [el('div', { className: 'label' },
                el('span', { textContent: title }),
                ...(fullOnly ? [el('span', { className: 'only', textContent: 'Not used by Fast and Fastest' })] : []))] : []),
            ...content);
        // A setting with its description on the left and its control on the
        // right; clicking anywhere on it works the control
        const line = (title, desc, control, fullOnly) => el('label', { className: fullOnly ? 'line full-only' : 'line' },
            el('span', { className: 'text' },
                el('span', { textContent: title }),
                ...(fullOnly ? [el('span', { className: 'only', textContent: ' · Not used by Fast and Fastest' })] : []),
                el('span', { className: 'desc', textContent: desc })),
            control);

        const toggle = (key) => {
            const sw = el('button', {
                type: 'button', className: 'switch', role: 'switch',
                onclick: () => applySetting(key, !settings[key]),
            });
            sw.refresh = (on) => sw.setAttribute('aria-checked', !!on);
            return sw;
        };
        // A slider and a number field for one deband parameter
        const param = (key, title) => {
            const [lo, hi] = LIMITS[key];
            const top = Math.min(hi, SLIDER_TOP[key] || hi);
            const clamp = (v) => Math.min(hi, Math.max(lo, key === 'iterations' ? Math.round(v) : v));
            const slider = el('input', {
                type: 'range', min: lo, max: top, step: 1, 'aria-label': title,
                oninput: (e) => applySetting(key, clamp(parseFloat(e.target.value))),
            });
            const number = el('input', {
                type: 'number', min: lo, max: hi, step: 1, 'aria-label': title,
                onchange: (e) => {
                    const v = parseFloat(e.target.value);
                    applySetting(key, clamp(isFinite(v) ? v : DEFAULTS[key]));
                },
            });
            const row = el('div', { className: 'param', title: `--deband-${key}=<${lo}..${hi}> (default ${DEFAULTS[key]})` },
                el('span', { textContent: title }), slider, number);
            row.refresh = (v) => {
                const s = Math.min(v, top);
                slider.value = s;
                slider.style.setProperty('--f', (s - lo) / (top - lo));
                number.value = v;
                row.classList.toggle('over', PARAM_ADVICE.some(([k, over]) => k === key && over(settings)));
            };
            return row;
        };
        // Why the values flagged above aren't worth it
        const advice = el('div', { className: 'advice' });
        advice.refresh = () => {
            const notes = PARAM_ADVICE.filter(([, over]) => over(settings));
            advice.replaceChildren(...notes.map(([, , text]) => el('div', { textContent: text })));
            advice.hidden = !notes.length;
        };
        // Click, then press the combination; Escape cancels
        const hotkey = (key) => {
            const input = el('input', {
                type: 'text', readOnly: true, className: 'key',
                onfocus: (e) => { e.target.value = 'Press keys…'; },
                onblur: () => refreshPanel(),
                onkeydown: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        e.target.blur();
                        return;
                    }
                    const combo = comboFromEvent(e);
                    if (!combo)
                        return;
                    e.target.blur();
                    applySetting(key, combo);
                },
            });
            input.refresh = (combo) => {
                if (input.getRootNode().activeElement !== input)
                    input.value = formatCombo(combo);
            };
            return input;
        };
        // A button per option, the selected one highlighted, with what it
        // does written underneath
        const choice = (key, options) => {
            const buttons = options.map(([v, text, about]) => el('button', {
                type: 'button', role: 'radio', textContent: text, title: about,
                onclick: () => applySetting(key, v),
            }));
            const about = el('div', { className: 'about' });
            const root = el('div', null, el('div', { className: 'seg', role: 'radiogroup' }, ...buttons), about);
            root.refresh = (value) => options.forEach(([v, , text], i) => {
                buttons[i].setAttribute('aria-checked', v === value);
                if (v === value)
                    about.textContent = text;
            });
            return root;
        };
        // The preset list, with Delete for the user's own presets and what the
        // picked one is for written underneath. Values that match no preset
        // show as Custom.
        const presetPicker = () => {
            const select = el('select', {
                'aria-label': 'Preset',
                onchange: (e) => applyPreset(e.target.value),
            });
            const del = iconButton('M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3', 'Delete this preset', () => {
                const active = activePreset();
                if (customPresets.includes(active)) {
                    deletePreset(active.name);
                    setStatus(`Deleted preset ${active.name}`);
                }
            });
            const about = el('div', { className: 'about' });
            const root = el('div', null, el('div', { className: 'row' }, select, del), about);
            root.refresh = () => {
                const active = activePreset();
                const own = customPresets.includes(active);
                const option = (p) => el('option', { value: p.name, textContent: p.name });
                select.replaceChildren(
                    el('option', { value: '', textContent: 'Custom', hidden: true, disabled: true }),
                    el('optgroup', { label: 'Built-in' }, ...FACTORY_PRESETS.map(option)),
                    ...(customPresets.length ? [el('optgroup', { label: 'Yours' }, ...customPresets.map(option))] : []));
                select.value = active ? active.name : '';
                about.textContent = !active ? 'These values aren\'t a preset. Name them below and click Save to keep them.'
                    : own ? 'One of your presets.' : active.about;
                del.hidden = !own;
            };
            return root;
        };

        const enabled = toggle('enabled');
        const state = el('span', { className: 'state' });
        const refreshEnabled = enabled.refresh;
        enabled.refresh = (on) => {
            refreshEnabled(on);
            state.textContent = on ? 'On' : 'Off';
            enabled.title = `Turn debanding ${on ? 'off' : 'on'} (${formatCombo(settings.hotkeyToggle)})`;
        };

        const inputs = {
            enabled,
            algo: choice('algo', [
                ['gpu-next', 'gpu-next', 'mpv\'s default: vo=gpu-next debanding (libplacebo).'],
                ['gpu', 'gpu', 'mpv\'s older vo=gpu debanding shader.'],
                ['fast', 'Fast', 'For weak GPUs: gpu-next in a single pass, a fraction of the GPU work, nearly the same result.'],
                ['fastest', 'Fastest', 'For integrated graphics: Fast worked out at half resolution, a quarter to a third of its debanding work. Leaves the finest streaks.'],
            ]),
            preset: presetPicker(),
            iterations: param('iterations', 'Iterations'),
            threshold: param('threshold', 'Threshold'),
            range: param('range', 'Range'),
            grain: param('grain', 'Grain'),
            split: toggle('split'),
            chroma: choice('chroma', [
                ['browser', 'Browser', 'The browser\'s own chroma upscaling, usually bilinear: color bleeds a little over sharp edges.'],
                ['cfl', 'CfL', 'Chroma from Luma prediction: sharper color edges, as with mpv\'s CfL_Prediction.glsl.'],
                ['cfl-lite', 'CfL Lite', 'CfL_Prediction_Lite.glsl: fewer samples and no smoothing pass. A bit cheaper.'],
            ]),
            matrix: choice('matrix', [
                ['709', 'BT.709', 'The matrix of HD video, and of most video on YouTube.'],
                ['601', 'BT.601', 'For SD videos encoded as BT.601, which need it for exact colors.'],
            ]),
            snap: toggle('snap'),
            dither: toggle('dither'),
            backend: choice('backend', [
                ['auto', 'Auto', 'WebGPU where the browser has it, otherwise WebGL2, otherwise WebGL1.'],
                ['webgpu', 'WebGPU', 'Imports the video frame directly instead of uploading a copy of it.'],
                ['webgl2', 'WebGL2', 'Uploads a copy of each frame. Pick it if WebGPU misbehaves.'],
                ['webgl1', 'WebGL1', 'For browsers without WebGL2, such as Tor Browser and Mullvad Browser.'],
            ]),
            precision: choice('precision', [
                ['byte', '8-bit', 'RGBA8: the cheapest upload. Browsers already hand over the frame as 8-bit RGB, so it loses nothing.'],
                ['half', 'Half float', 'RGBA16F: more memory traffic for no gain, since the frame arrives as 8-bit RGB. In Firefox it even rounds luma slightly worse.'],
            ]),
            hotkeyToggle: hotkey('hotkeyToggle'),
            hotkeyPanel: hotkey('hotkeyPanel'),
        };

        const presetName = el('input', {
            type: 'text', maxLength: 40, placeholder: 'Name these values',
            onkeydown: (e) => {
                if (e.key === 'Enter')
                    saveAsPreset();
            },
        });
        const saveAsPreset = () => {
            const name = presetName.value.trim();
            if (!name)
                return setStatus('Type a name for the preset first');
            if (FACTORY_PRESETS.some((p) => sameName(p.name, name)))
                return setStatus(`${name} is a built-in preset; pick another name`);
            const replaced = savePreset(name);
            presetName.value = '';
            setStatus(`${replaced ? 'Updated' : 'Saved'} preset ${name}`);
        };
        const saveButton = button('Save', saveAsPreset);
        saveButton.title = 'Save the four values above as a preset; an existing name of yours is updated';

        const mpvText = el('textarea', {
            rows: 3, spellcheck: false, 'aria-label': 'mpv options',
            placeholder: 'deband-iterations=2\ndeband-threshold=35\nglsl-shaders=~~/CfL_Prediction.glsl',
        });

        // Reset asks for a second click, since it can't be undone
        let disarm = null;
        const reset = button('Reset all settings', () => {
            if (!disarm) {
                reset.classList.add('armed');
                reset.textContent = 'Click again to reset';
                const timer = setTimeout(() => disarm(), 3000);
                disarm = () => {
                    clearTimeout(timer);
                    disarm = null;
                    reset.classList.remove('armed');
                    reset.textContent = 'Reset all settings';
                };
                return;
            }
            disarm();
            applySettings(Object.assign({}, DEFAULTS));
        }, 'danger');
        reset.title = 'Every setting back to its default; your presets and the panel\'s position stay';

        const pages = {
            deband: el('div', null,
                group('Mode', false, inputs.algo),
                group('Preset', false, inputs.preset),
                group('Parameters', false,
                    inputs.iterations, inputs.threshold, inputs.range, inputs.grain, advice,
                    el('div', { className: 'row', style: { marginTop: '10px' } }, presetName, saveButton)),
                group(null, false,
                    line('Split compare', 'Left half original, right half debanded', inputs.split))),
            picture: el('div', null,
                group('Chroma upscaling', true, inputs.chroma),
                group('YCbCr matrix', false, inputs.matrix),
                group(null, false,
                    line('Snap luma', 'Round recovered luma to the 8-bit code grid, undoing the browser\'s RGB rounding.', inputs.snap, true),
                    line('Dither', 'Dither the output down to 8 bits, as mpv does.', inputs.dither))),
            advanced: el('div', null,
                group('Renderer', false, inputs.backend),
                group('Upload format', true, inputs.precision),
                group('Shortcuts', false,
                    line('Toggle debanding', 'Turns debanding on and off', inputs.hotkeyToggle),
                    line('Open this panel', 'Shows and hides these settings', inputs.hotkeyPanel),
                    el('div', { className: 'desc', textContent: 'Click a shortcut, then press the new keys; Esc cancels.' })),
                group('Import from mpv', false,
                    mpvText,
                    el('div', { className: 'row end' },
                        el('span', { className: 'desc', style: { flex: '1', marginTop: '0' }, textContent: 'Paste your whole mpv.conf, some lines or flags.' }),
                        button('Apply', () => setStatus(parseMpvOptions(mpvText.value)), 'primary'))),
                group(null, false, el('div', { className: 'row' }, reset)),
                group('About', false,
                    el('div', { className: 'desc', style: { marginTop: '0' } },
                        `YouTube Deband ${VERSION} by Pagal3 · `,
                        el('a', { href: 'https://github.com/Pagal3/youtube-deband', target: '_blank', rel: 'noopener', textContent: 'GitHub' })))),
        };
        const tabNames = [['deband', 'Deband'], ['picture', 'Picture'], ['advanced', 'Advanced']];
        const tabs = tabNames.map(([id, text]) => el('button', {
            type: 'button', className: 'tab', role: 'tab', textContent: text,
            onclick: () => showTab(id),
        }));
        const body = el('div', { className: 'body' }, ...Object.values(pages));
        const showTab = (id) => {
            tabNames.forEach(([t], i) => {
                tabs[i].setAttribute('aria-selected', t === id);
                pages[t].hidden = t !== id;
            });
            body.scrollTop = 0;
        };
        showTab('deband');

        const statusText = el('span');
        const statusEl = el('div', { className: 'status' }, el('span', { className: 'dot' }), statusText);
        const showStatus = (text) => {
            statusText.textContent = text || 'Waiting for a video';
            statusEl.className = 'status ' + (text.startsWith('Error') ? 'error' : text.startsWith('Skipped') ? 'warn'
                : settings.enabled && debander ? 'ok' : '');
        };

        const box = el('div', { className: 'panel' },
            el('div', {
                className: 'head',
                title: 'Drag to move the panel; double-click to put it back',
                onpointerdown: startPanelDrag,
                ondblclick: (e) => {
                    if (e.target.closest('button'))
                        return;
                    savePanelPos(null);
                    placePanel();
                },
            },
                el('span', { className: 'logo' }),
                el('span', { className: 'title' }, 'Deband', el('span', { className: 'version', textContent: 'v' + VERSION })),
                state, enabled,
                iconButton('M6 6l12 12M18 6L6 18', 'Close', () => togglePanel(false))),
            el('div', { className: 'tabs', role: 'tablist' }, ...tabs),
            body,
            statusEl);

        const root = el('div', {
            className: 'yt-deband-panel',
            style: { position: 'fixed', top: '72px', right: '16px', zIndex: '2147483647', display: 'none' },
            // Keep YouTube's hotkeys from reacting while typing in the panel
            onkeydown: (e) => {
                e.stopPropagation();
                if (e.key === 'Escape')
                    togglePanel(false);
            },
        });
        root.attachShadow({ mode: 'open' }).append(el('style', { textContent: PANEL_CSS }), box);
        document.body.append(root);
        return { root, box, inputs, advice, showStatus };
    }

    function refreshPanel() {
        if (!panel)
            return;
        for (const [key, input] of Object.entries(panel.inputs))
            input.refresh(settings[key]);
        panel.advice.refresh();
        panel.box.classList.toggle('fast', settings.algo === 'fast' || settings.algo === 'fastest');
        panel.showStatus(status);
    }

    function togglePanel(show) {
        try {
            showPanel(show);
        } catch (e) {
            console.error('[yt-deband]', e);
            showNotice('YouTube Deband: settings panel failed: ' + e.message);
        }
    }

    function showPanel(show) {
        if (!panel)
            panel = buildPanel();
        const visible = show !== undefined ? show : panel.root.style.display === 'none';
        // In fullscreen only the fullscreen element is drawn, so the panel has to live inside it
        const host = document.fullscreenElement || document.body;
        if (panel.root.parentNode !== host)
            host.append(panel.root);
        panel.root.style.display = visible ? 'block' : 'none';
        refreshPanel();
        if (visible)
            placePanel();
    }

    // The dragged-to position as { left, top } in px, or null for the default
    // top right corner
    function loadPanelPos() {
        try {
            const p = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
            return p && isFinite(p.left) && isFinite(p.top) ? p : null;
        } catch (e) {
            return null;
        }
    }

    function savePanelPos(p) {
        try {
            if (p)
                localStorage.setItem(PANEL_POS_KEY, JSON.stringify(p));
            else
                localStorage.removeItem(PANEL_POS_KEY);
        } catch (e) { /* storage blocked, the position lasts until reload */ }
    }

    // Moves the panel to (left, top), kept wholly inside the window so it
    // can't be lost off screen; returns where it ended up
    function movePanel(left, top) {
        const r = panel.root.getBoundingClientRect();
        left = Math.round(Math.max(0, Math.min(left, window.innerWidth - r.width)));
        top = Math.round(Math.max(0, Math.min(top, window.innerHeight - r.height)));
        Object.assign(panel.root.style, { left: left + 'px', top: top + 'px', right: 'auto' });
        return { left, top };
    }

    // Puts the panel at its saved position, or the default one
    function placePanel() {
        if (!panel || panel.root.style.display === 'none')
            return;
        const p = loadPanelPos();
        if (p)
            movePanel(p.left, p.top);
        else
            Object.assign(panel.root.style, { left: 'auto', top: '72px', right: '16px' });
    }

    // Dragging by the header; the position is saved when the drag ends
    function startPanelDrag(e) {
        if (e.button !== 0 || e.target.closest('button'))
            return;
        e.preventDefault();
        const header = e.currentTarget;
        const r = panel.root.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        let pos = null;
        header.setPointerCapture(e.pointerId);
        const move = (ev) => { pos = movePanel(ev.clientX - dx, ev.clientY - dy); };
        const end = () => {
            header.removeEventListener('pointermove', move);
            header.removeEventListener('pointerup', end);
            header.removeEventListener('pointercancel', end);
            if (pos)
                savePanelPos(pos);
        };
        header.addEventListener('pointermove', move);
        header.addEventListener('pointerup', end);
        header.addEventListener('pointercancel', end);
    }

    // Keep the panel on screen when the window shrinks or goes fullscreen
    window.addEventListener('resize', () => placePanel());

    // Hotkeys are stored as the combination the browser reports, e.g.
    // "Ctrl+Alt+d". Matching what was recorded keeps them working where e.key
    // is an AltGr character (Ctrl+Alt is AltGr on many Windows layouts) and
    // e.code is blanked (fingerprinting protection in Tor/Mullvad Browser).
    function comboFromEvent(e) {
        if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(e.key))
            return null;
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Meta');
        parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
        return parts.join('+');
    }

    function isEditable(target) {
        return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''));
    }

    // Registered at document-start so it runs before YouTube's own key
    // handlers, which can stop the event from reaching later listeners.
    window.addEventListener('keydown', (e) => {
        // The panel's hotkey fields record keys themselves
        if (panel && e.target && panel.root.contains(e.target))
            return;
        const combo = comboFromEvent(e);
        if (!combo)
            return;
        // A hotkey without Ctrl/Alt/Meta must not fire while typing
        if (!(e.ctrlKey || e.altKey || e.metaKey) && isEditable(e.target))
            return;
        if (combo === settings.hotkeyToggle) {
            applySetting('enabled', !settings.enabled);
        } else if (combo === settings.hotkeyPanel) {
            togglePanel();
        } else {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
    }, true);
})();
