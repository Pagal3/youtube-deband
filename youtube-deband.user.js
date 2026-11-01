// ==UserScript==
// @name         YouTube Deband (mpv / libplacebo)
// @namespace    youtube-deband
// @version      1.10.1
// @description  Debands YouTube video in WebGL2 using a port of mpv's deband shaders (vo=gpu-next / libplacebo and legacy vo=gpu), with mpv's parameters.
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
 * Shaders:
 *   gpu-next: libplacebo src/shaders/sampling.c pl_shader_deband() with
 *             mpv's option mapping from video/out/vo_gpu_next.c
 *   gpu:      mpv video/out/gpu/video_shaders.c pass_sample_deband()
 *   fast:     gpu-next cut down to one pass over the RGB frame, for weak GPUs
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
    const VERSION = '1.10.1'; // keep in sync with @version

    // Option ranges match mpv's deband_conf (video/out/gpu/video_shaders.c)
    const DEFAULTS = {
        enabled: true,
        algo: 'gpu-next',   // 'gpu-next' (libplacebo) | 'gpu' (legacy mpv shader) | 'fast' (single pass)
        iterations: 1,      // --deband-iterations=<0..16>
        threshold: 48,      // --deband-threshold=<0..4096>
        range: 16,          // --deband-range=<1..64>
        grain: 32,          // --deband-grain=<0..4096>
        preset: 'Default',  // preset picked last, shown while the four values above still match it
        chroma: 'browser',  // chroma upscaling: 'browser' (keep its) | 'cfl' | 'cfl-lite' (Chroma from Luma)
        matrix: '709',      // YCbCr matrix the browser used to make RGB
        snap: true,         // round the recovered luma to the 8-bit code grid
        dither: true,       // dither the output down to 8 bits like mpv does
        precision: 'half',  // video upload format: 'half' (RGBA16F) | 'byte' (RGBA8), WebGL2 only
        backend: 'auto',    // 'auto' | 'webgl2' | 'webgl1'
        hotkeyToggle: 'Ctrl+Alt+d',
        hotkeyPanel: 'Ctrl+Alt+b',
        split: false,       // left half original, right half debanded
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
            return Object.assign({}, DEFAULTS, saved);
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

    // Deband luma at this pixel (the luma pass is folded in here, saving a
    // full resolution render target), add the chroma change, convert the
    // change to RGB, dither, flip onto the canvas. Only the change is added on
    // top of the source pixel, so the lossy RGB -> 4:2:0 -> RGB round trip
    // never shows up where nothing was debanded (e.g. sharp colored edges).
    // lumaDelta is the expression for the luma change at plane pixel p.
    // upscale is code for chroma upscaling that replaces the browser's (see
    // UPSCALE_CFL), or empty.
    const fsFinal = (deband, lumaDelta, upscale) => YCC + deband + `
uniform sampler2D u_c, u_src;
uniform vec2 u_size, u_csize;
uniform bool u_dither;
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
    if (u_dither) {
        float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        rgb = floor(rgb * 255.0 + n) / 255.0;
    }
    FRAG = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

    // Fast mode for weak GPUs: one pass straight from the RGB frame, with no
    // render targets, float textures or extensions, and 1 + 4 * iterations
    // texture fetches per pixel (the other modes make four passes). Same
    // algorithm and parameters as gpu-next, with three shortcuts: chroma is
    // debanded at full resolution with the same samples as luma, luma isn't
    // snapped, and the random numbers come from a cheap float hash instead of
    // pcg3d. YCbCr is linear in RGB, so averaging RGB averages YCbCr.
    const FS_FAST = YCC + `
uniform sampler2D u_src;
uniform vec2 u_texSize;
uniform float u_frame;
uniform int u_iter;
uniform float u_radius, u_threshold, u_grain;
uniform bool u_dither;
uniform float u_split;

// A few multiply-adds and fracts: no integers (slow or missing on old GPUs
// and WebGL1) and no trig. Inputs up to a few thousand, outputs ~9 bits.
vec3 rand3(vec3 p) {
    p = fract(p * vec3(0.1347, 0.1593, 0.1771) + p.yzx * vec3(0.0719, 0.0547, 0.0613));
    p += dot(p, p.zxy + 19.19);
    return fract((p + p.yzx) * p.zxy * 3.71);
}

void main() {
    vec2 p = vec2(floor(gl_FragCoord.x), u_texSize.y - 1.0 - floor(gl_FragCoord.y));
    vec2 pt = 1.0 / u_texSize;
    vec2 pos = (p + 0.5) * pt;
    vec3 rgb = TEX(u_src, pos).rgb;
    if (p.x >= u_split * u_texSize.x) {
        float seed = mod(u_frame, 256.0) * 17.0;
        vec3 orig = rgb2ycc(rgb);
        vec3 res = orig;
        for (int i = 1; i <= 16; i++) {
            if (i > u_iter)
                break;
            vec2 d = rand3(vec3(p, seed + float(i))).xy * vec2(float(i) * u_radius, 6.283185);
            d = d.x * vec2(cos(d.y), sin(d.y)) * pt;
            vec3 avg = rgb2ycc(0.25 * (TEX(u_src, pos + d).rgb +
                                       TEX(u_src, pos + vec2(-d.x, d.y)).rgb +
                                       TEX(u_src, pos - d).rgb +
                                       TEX(u_src, pos + vec2(d.x, -d.y)).rgb));
            res = mix(avg, res, vec3(greaterThan(abs(res - avg), vec3(u_threshold / float(i)))));
        }
        if (u_grain > 0.0) {
            vec3 strength = min(abs(res - vec3(16.0, 128.0, 128.0) / 255.0), vec3(u_grain));
            res += strength * (rand3(vec3(p, seed)) - 0.5);
        }
        rgb += dycc2rgb(res - orig);
    }
    if (u_dither) {
        float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        rgb = floor(rgb * 255.0 + n) / 255.0;
    }
    FRAG = vec4(clamp(rgb, 0.0, 1.0), 1.0);
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
    };
    // Final pass program suffix per chroma upscaling
    const FINAL_CHROMA = { browser: '', cfl: 'Cfl', 'cfl-lite': 'CflLite' };

    // ------------------------------------------------------------------
    // WebGL renderer
    // ------------------------------------------------------------------

    class Debander {
        // backend: 'auto' | 'webgl2' | 'webgl1'
        constructor(canvas, backend) {
            this.canvas = canvas;
            this.frame = 0;
            this.w = 0;
            this.h = 0;
            this.uploadFormat = null;
            this.fast = false;
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
                   `${this.fast ? 'single pass' : (this.packed ? 'packed 16-bit' : 'float') + ' planes'}, ` +
                   `${this.uploadFormat === 'half' ? 'RGBA16F' : 'RGBA8'} upload` +
                   (this.chroma === 'cfl' ? ', CfL chroma' : this.chroma === 'cfl-lite' ? ', CfL Lite chroma' : '');
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

        target(w, h, floatFormat) {
            const gl = this.gl;
            const tex = this.texture(w, h, this.packed ? gl.RGBA8 : floatFormat, !this.packed);
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
            const fast = s.algo === 'fast';
            // Fast mode takes the cheapest upload
            const precision = this.webgl2 && !fast ? s.precision : 'byte';
            // Snapped luma is exactly on the 8-bit grid, so an 8-bit plane
            // holds it losslessly with half the memory traffic. Not for the
            // legacy shader: it filters luma bilinearly, and 8-bit textures
            // aren't guaranteed to filter with more than 8 bits of precision.
            // Fast mode has no planes.
            const yFormat = fast ? null : s.snap && s.algo !== 'gpu' ? gl.R8 : gl.R16F;
            // CfL works on the planes, which Fast mode doesn't make
            const chroma = !fast && (s.chroma === 'cfl' || s.chroma === 'cfl-lite') ? s.chroma : 'browser';
            if (w === this.w && h === this.h && precision === this.uploadFormat && yFormat === this.yFormat &&
                chroma === this.chroma)
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

            this.canvas.width = w;
            this.canvas.height = h;
            this.w = w;
            this.h = h;
            this.uploadFormat = precision;
            this.yFormat = yFormat;
            this.fast = fast;
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
                this.pass(this.prog('fast'), null, [['u_src', this.src, false]], (loc) => {
                    setDeband(loc, this, 0); // the frame is the plane; neutral is set in the shader
                    setOutput(loc);
                });
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
            panel.status.textContent = text;
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
        video = canvas = debander = null;
    }

    function createDebander() {
        try {
            debander = new Debander(canvas, settings.backend);
            setStatus('Ready: ' + debander.description);
        } catch (e) {
            debander = null;
            setStatus('Error: ' + e.message);
            console.error('[yt-deband]', e);
        }
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

    // Mirror the video element's box; YouTube positions it with inline styles.
    // The box has the aspect ratio of the video's top resolution and the
    // browser letterboxes each stream into it (object-fit: contain), so a
    // canvas stretched over the box (fill, a canvas's default) is scaled a
    // little differently: low resolutions, whose sizes are rounded further
    // from that ratio, shift visibly toward the edges.
    function syncBox() {
        if (!video || !canvas)
            return;
        const cs = getComputedStyle(video);
        Object.assign(canvas.style, {
            left: video.offsetLeft + 'px',
            top: video.offsetTop + 'px',
            width: video.offsetWidth + 'px',
            height: video.offsetHeight + 'px',
            objectFit: cs.objectFit,
            objectPosition: cs.objectPosition,
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
            return 'protected (DRM) video, which browsers do not let WebGL read.';
        if (video.videoWidth > debander.maxSize || video.videoHeight > debander.maxSize)
            return `${video.videoWidth}x${video.videoHeight} video exceeds this browser's ` +
                   `${debander.maxSize}px WebGL texture limit (fingerprinting protection). Use 1080p or lower.`;
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
        } else if (video && !debander && settings.enabled && !status.startsWith('Error')) {
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
        // A canvas keeps its first context type, so a backend switch needs a new one
        if ('backend' in values && video)
            attach(video);
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

    // Accepts mpv.conf lines or command line flags, e.g.
    // "deband-iterations=2" or "--deband-threshold=35 --deband-grain=16".
    // A line loading either CfL shader picks that chroma upscaling.
    function parseMpvOptions(text) {
        const re = /(?:--)?deband-(iterations|threshold|range|grain)\s*=\s*(-?[\d.]+)/g;
        let m, n = 0;
        while ((m = re.exec(text))) {
            const [lo, hi] = LIMITS[m[1]];
            let v = Math.min(hi, Math.max(lo, parseFloat(m[2])));
            if (m[1] === 'iterations')
                v = Math.round(v);
            settings[m[1]] = v;
            n++;
        }
        const shader = /(?:^|\s)(?:--)?glsl-shaders?(?:-append)?\s*=.*CfL_Prediction(_Lite)?\.glsl/i.exec(text);
        if (shader) {
            settings.chroma = shader[1] ? 'cfl-lite' : 'cfl';
            n++;
        }
        if (/(?:^|\s)(?:--)?deband\s*=\s*no\b/.test(text))
            settings.enabled = false;
        else if (/(?:^|\s)(?:--)?deband(?:\s*=\s*yes)?(?:\s|$)/.test(text))
            settings.enabled = true;
        saveSettings();
        refreshPanel();
        requestRender();
        return n;
    }

    function buildPanel() {
        const row = (label, input, hint) => el('label', {
            style: { display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: '8px', margin: '6px 0' },
            title: hint || '',
        }, el('span', null, label), input);

        const inputStyle = {
            background: '#222', color: '#eee', border: '1px solid #444', borderRadius: '4px',
            padding: '3px 6px', font: 'inherit', width: '100%', boxSizing: 'border-box',
        };
        const number = (key, step) => el('input', {
            type: 'number', step, min: LIMITS[key][0], max: LIMITS[key][1], style: inputStyle,
            onchange: (e) => {
                const [lo, hi] = LIMITS[key];
                let v = parseFloat(e.target.value);
                if (!isFinite(v)) v = DEFAULTS[key];
                v = Math.min(hi, Math.max(lo, key === 'iterations' ? Math.round(v) : v));
                applySetting(key, v);
            },
        });
        const check = (key) => el('input', {
            type: 'checkbox', style: { justifySelf: 'start' },
            onchange: (e) => applySetting(key, e.target.checked),
        });
        // Click, then press the combination; Escape cancels
        const hotkey = (key) => el('input', {
            type: 'text', readOnly: true, style: Object.assign({}, inputStyle, { cursor: 'pointer' }),
            onfocus: (e) => { e.target.value = 'Press keys… (Esc cancels)'; },
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
        const select = (key, options) => el('select', {
            style: inputStyle, onchange: (e) => applySetting(key, e.target.value),
        }, ...options.map(([v, t]) => el('option', { value: v, textContent: t })));
        // A button per option, the selected one highlighted, with what it
        // does written underneath
        const choice = (key, options) => {
            const buttons = options.map(([v, text, about]) => el('button', {
                type: 'button', textContent: text, title: about,
                style: { flex: '1', border: '1px solid #444', borderRadius: '4px', padding: '5px 4px', cursor: 'pointer', font: 'inherit' },
                onclick: () => applySetting(key, v),
            }));
            const about = el('div', { style: { opacity: '0.7', fontSize: '11px', marginTop: '4px', minHeight: '2.8em' } });
            const root = el('div', { role: 'radiogroup' },
                el('div', { style: { display: 'flex', gap: '4px' } }, ...buttons), about);
            root.refresh = (value) => options.forEach(([v, , text], i) => {
                const on = v === value;
                buttons[i].setAttribute('aria-checked', on);
                buttons[i].setAttribute('role', 'radio');
                Object.assign(buttons[i].style, on
                    ? { background: '#3ea6ff', color: '#0f0f0f', fontWeight: 'bold', borderColor: '#3ea6ff' }
                    : { background: '#222', color: '#eee', fontWeight: 'normal', borderColor: '#444' });
                if (on)
                    about.textContent = text;
            });
            return root;
        };
        const button = (text, onclick) => el('button', {
            textContent: text, onclick,
            style: { background: '#333', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', font: 'inherit' },
        });
        // The preset list, with Delete for the user's own presets and what the
        // picked one is for written underneath. Values that match no preset
        // show as Custom.
        const presetPicker = () => {
            const select = el('select', {
                style: Object.assign({}, inputStyle, { flex: '1', minWidth: '0' }),
                onchange: (e) => applyPreset(e.target.value),
            });
            const del = button('Delete', () => {
                const active = activePreset();
                if (customPresets.includes(active)) {
                    deletePreset(active.name);
                    setStatus(`Deleted preset ${active.name}`);
                }
            });
            del.title = 'Delete the selected preset (only your own)';
            const about = el('div', { style: { opacity: '0.7', fontSize: '11px', marginTop: '4px', minHeight: '2.8em' } });
            const root = el('div', null, el('div', { style: { display: 'flex', gap: '8px' } }, select, del), about);
            root.refresh = () => {
                const active = activePreset();
                const own = customPresets.includes(active);
                const option = (p) => el('option', { value: p.name, textContent: p.name });
                select.replaceChildren(
                    el('option', { value: '', textContent: 'Custom', hidden: true, disabled: true }),
                    el('optgroup', { label: 'Built-in' }, ...FACTORY_PRESETS.map(option)),
                    ...(customPresets.length ? [el('optgroup', { label: 'Yours' }, ...customPresets.map(option))] : []));
                select.value = active ? active.name : '';
                about.textContent = !active ? 'These values aren\'t a preset. Type a name below and click Save to keep them.'
                    : own ? 'One of your presets.' : active.about;
                del.disabled = !own;
                Object.assign(del.style, { opacity: own ? '' : '0.4', cursor: own ? 'pointer' : 'default' });
            };
            return root;
        };
        const section = (title, content) => el('div', { style: { margin: '10px 0 6px' } },
            el('div', { textContent: title, style: { marginBottom: '4px' } }), content);

        const inputs = {
            enabled: check('enabled'),
            algo: choice('algo', [
                ['gpu-next', 'gpu-next', 'mpv\'s default: vo=gpu-next debanding (libplacebo).'],
                ['gpu', 'gpu', 'mpv\'s older vo=gpu debanding shader.'],
                ['fast', 'Fast', 'For weak GPUs: gpu-next in a single pass, a fraction of the GPU work, nearly the same result.'],
            ]),
            preset: presetPicker(),
            chroma: choice('chroma', [
                ['browser', 'Browser', 'The browser\'s own chroma upscaling, usually bilinear: color bleeds a little over sharp edges.'],
                ['cfl', 'CfL', 'Chroma from Luma prediction: sharper color edges, as with mpv\'s CfL_Prediction.glsl. Not in Fast mode.'],
                ['cfl-lite', 'CfL Lite', 'CfL_Prediction_Lite.glsl: fewer samples and no smoothing pass. A bit cheaper. Not in Fast mode.'],
            ]),
            iterations: number('iterations', 1),
            threshold: number('threshold', 1),
            range: number('range', 1),
            grain: number('grain', 1),
            matrix: select('matrix', [['709', 'BT.709'], ['601', 'BT.601']]),
            snap: check('snap'),
            dither: check('dither'),
            precision: select('precision', [['half', 'Half float (RGBA16F)'], ['byte', '8-bit (RGBA8)']]),
            backend: select('backend', [['auto', 'Auto'], ['webgl2', 'WebGL2'], ['webgl1', 'WebGL1']]),
            split: check('split'),
            hotkeyToggle: hotkey('hotkeyToggle'),
            hotkeyPanel: hotkey('hotkeyPanel'),
        };

        const mpvText = el('textarea', {
            rows: 2, placeholder: 'Paste from mpv.conf, e.g.\ndeband-iterations=2', style: Object.assign({}, inputStyle, { resize: 'vertical' }),
        });
        const statusEl = el('div', { style: { opacity: '0.7', fontSize: '11px', marginTop: '8px' }, textContent: status });
        const presetName = el('input', {
            type: 'text', maxLength: 40, placeholder: 'Preset name',
            style: Object.assign({}, inputStyle, { flex: '1', minWidth: '0' }),
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

        const root = el('div', {
            className: 'yt-deband-panel',
            style: {
                position: 'fixed', top: '72px', right: '16px', zIndex: '2147483647', width: '320px',
                maxHeight: 'calc(100vh - 114px)', overflowY: 'auto', // ends 16px above the bottom
                background: 'rgba(20,20,20,0.96)', color: '#eee', border: '1px solid #444', borderRadius: '8px',
                padding: '12px 14px', font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                display: 'none',
            },
            // Keep YouTube's hotkeys from reacting while typing in the panel
            onkeydown: (e) => e.stopPropagation(),
        },
            el('div', {
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', cursor: 'move', userSelect: 'none', touchAction: 'none' },
                title: 'Drag to move the panel; double-click to put it back',
                onpointerdown: startPanelDrag,
                ondblclick: (e) => {
                    if (e.target.closest('button'))
                        return;
                    savePanelPos(null);
                    placePanel();
                },
            },
                el('span', null,
                    el('strong', { textContent: 'Deband' }),
                    el('span', { textContent: ' v' + VERSION, style: { opacity: '0.6', fontSize: '11px' } })),
                button('×', () => togglePanel(false))),
            row('Enabled', inputs.enabled),
            section('Mode', inputs.algo),
            section('Preset', inputs.preset),
            row('iterations', inputs.iterations, '--deband-iterations=<0..16> (default 1)'),
            row('threshold', inputs.threshold, '--deband-threshold=<0..4096> (default 48)'),
            row('range', inputs.range, '--deband-range=<1..64> (default 16)'),
            row('grain', inputs.grain, '--deband-grain=<0..4096> (default 32)'),
            el('div', { style: { display: 'flex', gap: '8px', margin: '6px 0 10px' } }, presetName, saveButton),
            row('mpv options', mpvText),
            el('div', { style: { display: 'flex', gap: '8px', margin: '6px 0 10px' } },
                button('Apply mpv options', () => {
                    const n = parseMpvOptions(mpvText.value);
                    setStatus(`Applied ${n} option${n === 1 ? '' : 's'}`);
                }),
                button('Reset', () => {
                    Object.assign(settings, DEFAULTS);
                    saveSettings();
                    refreshPanel();
                    requestRender();
                })),
            section('Chroma upscaling', inputs.chroma),
            row('Matrix', inputs.matrix, 'YCbCr matrix the browser used to convert the video to RGB'),
            row('Snap luma', inputs.snap, 'Round recovered luma to the 8-bit code grid, undoing the browser\'s RGB rounding (not in Fast)'),
            row('Dither', inputs.dither, 'Dither output to 8 bits (mpv dithers by default)'),
            row('Upload', inputs.precision, 'Format the video frame is uploaded into (WebGL2 only; Fast always uses 8-bit)'),
            row('Renderer', inputs.backend, 'Auto uses WebGL2 when available, otherwise WebGL1'),
            row('Split compare', inputs.split, 'Left half original, right half debanded'),
            row('Toggle key', inputs.hotkeyToggle, 'Click, then press the shortcut that turns debanding on and off'),
            row('Panel key', inputs.hotkeyPanel, 'Click, then press the shortcut that opens this panel'),
            statusEl,
        );
        document.body.append(root);
        return { root, inputs, status: statusEl };
    }

    function refreshPanel() {
        if (!panel)
            return;
        for (const [key, input] of Object.entries(panel.inputs)) {
            if (input.refresh)
                input.refresh(settings[key]);
            else if (input.type === 'checkbox')
                input.checked = !!settings[key];
            else
                input.value = settings[key];
        }
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
        panel.status.textContent = status;
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
