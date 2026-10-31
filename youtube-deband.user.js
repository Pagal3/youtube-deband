// ==UserScript==
// @name         YouTube Deband (mpv / libplacebo)
// @namespace    youtube-deband
// @version      1.6.0
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
 *
 * Shaders:
 *   gpu-next: libplacebo src/shaders/sampling.c pl_shader_deband() with
 *             mpv's option mapping from video/out/vo_gpu_next.c
 *   gpu:      mpv video/out/gpu/video_shaders.c pass_sample_deband()
 *
 * Hotkeys (default): Ctrl+Alt+D toggles debanding, Ctrl+Alt+B opens the
 * settings panel; both can be re-recorded in the panel. The DB button in the
 * player's control bar also opens the panel.
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'yt-deband-settings';

    // Option ranges match mpv's deband_conf (video/out/gpu/video_shaders.c)
    const DEFAULTS = {
        enabled: true,
        algo: 'gpu-next',   // 'gpu-next' (libplacebo) | 'gpu' (legacy mpv shader)
        iterations: 1,      // --deband-iterations=<0..16>
        threshold: 48,      // --deband-threshold=<0..4096>
        range: 16,          // --deband-range=<1..64>
        grain: 32,          // --deband-grain=<0..4096>
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

    const settings = loadSettings();
    console.info(`[yt-deband] 1.6.0 running; ${settings.hotkeyPanel} or the DB player button opens the settings`);

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
    const FS_PREP_C = YCC + `
uniform sampler2D u_src;
uniform vec2 u_srcSize;
void main() {
    vec2 mid = floor(gl_FragCoord.xy) * 2.0 + 1.0;
    FRAG = storePlane(rgb2ycc(TEX(u_src, mid / u_srcSize).rgb).yz);
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
    const fsFinal = (deband, lumaDelta) => YCC + deband + `
uniform sampler2D u_c, u_src;
uniform vec2 u_size, u_csize;
uniform bool u_dither;
uniform float u_split;
void main() {
    vec2 p = vec2(floor(gl_FragCoord.x), u_size.y - 1.0 - floor(gl_FragCoord.y));
    vec2 uv = (p + 0.5) / u_size;
    vec3 rgb = TEX(u_src, uv).rgb;
    if (p.x >= u_split * u_size.x) {
        vec2 cuv = (p + 0.5) / (2.0 * u_csize);
        vec2 dc = loadPlaneLinear(u_c, cuv, u_csize) - DELTA_BIAS;
        rgb += dycc2rgb(vec3(${lumaDelta}, dc));
    }
    if (u_dither) {
        float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        rgb = floor(rgb * 255.0 + n) / 255.0;
    }
    FRAG = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

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

            const vs = webgl2 ? VS2 : VS1;
            const header = fsHeader(caps);
            this.progs = {
                prepY: this.program(vs, header + FS_PREP_Y),
                prepC: this.program(vs, header + FS_PREP_C),
                nextC: this.program(vs, header + fsChroma(debandNext(2))),
                nextFinal: this.program(vs, header + fsFinal(debandNext(1), 'deband(p)')),
                legacyC: this.program(vs, header + fsChroma(DEBAND_LEGACY)),
                legacyFinal: this.program(vs, header + fsFinal(DEBAND_LEGACY, 'deband(p).x')),
            };

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
            return `${this.webgl2 ? 'WebGL2' : 'WebGL1'}, ${this.packed ? 'packed 16-bit' : 'float'} planes, ` +
                   `${this.uploadFormat === 'half' ? 'RGBA16F' : 'RGBA8'} upload`;
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
            const precision = this.webgl2 ? s.precision : 'byte';
            // Snapped luma is exactly on the 8-bit grid, so an 8-bit plane
            // holds it losslessly with half the memory traffic. Not for the
            // legacy shader: it filters luma bilinearly, and 8-bit textures
            // aren't guaranteed to filter with more than 8 bits of precision.
            const yFormat = s.snap && s.algo !== 'gpu' ? gl.R8 : gl.R16F;
            if (w === this.w && h === this.h && precision === this.uploadFormat && yFormat === this.yFormat)
                return;
            for (const t of this.textures) gl.deleteTexture(t);
            for (const f of this.fbos) gl.deleteFramebuffer(f);
            this.textures = [];
            this.fbos = [];

            const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
            this.src = this.texture(w, h, precision === 'half' ? gl.RGBA16F : gl.RGBA8);
            this.srcAllocated = false;
            this.yPrep = this.target(w, h, yFormat);
            this.cPrep = this.target(cw, ch, gl.RG16F);
            this.cDelta = this.target(cw, ch, gl.RG16F);

            this.canvas.width = w;
            this.canvas.height = h;
            this.w = w;
            this.h = h;
            this.uploadFormat = precision;
            this.yFormat = yFormat;
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
            const setSrc = (loc) => {
                gl.uniform2f(loc.u_k, k[0], k[1]);
                gl.uniform2f(loc.u_srcSize, this.w, this.h);
            };
            this.pass(this.progs.prepY, this.yPrep, [['u_src', this.src, false]], (loc) => {
                setSrc(loc);
                gl.uniform1i(loc.u_snap, s.snap ? 1 : 0);
            });
            // The 2x2 average needs bilinear filtering of the source
            this.pass(this.progs.prepC, this.cPrep, [['u_src', this.src, true]], setSrc);

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

            this.pass(legacy ? this.progs.legacyC : this.progs.nextC, this.cDelta,
                      debandInputs(this.cPrep), (loc) => setDeband(loc, this.cPrep, 128 / 255));

            this.pass(legacy ? this.progs.legacyFinal : this.progs.nextFinal, null, [
                ...debandInputs(this.yPrep),
                ['u_c', this.cDelta.tex, linear],
                ['u_src', this.src, false],
            ], (loc) => {
                setDeband(loc, this.yPrep, 16 / 255);
                gl.uniform2f(loc.u_k, k[0], k[1]);
                gl.uniform2f(loc.u_size, this.w, this.h);
                gl.uniform2f(loc.u_csize, this.cDelta.w, this.cDelta.h);
                gl.uniform1i(loc.u_dither, s.dither ? 1 : 0);
                gl.uniform1f(loc.u_split, s.split ? 0.5 : -1.0);
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
    let recentSkips = []; // per callback: whether presentedFrames skipped ahead
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
        perDisplayFrame = !v.requestVideoFrameCallback || coarseTimers;
        lastPresented = -1;
        recentSkips = [];
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
    // timers, and as a fallback when frames are skipped often; then render
    // on every animation frame while playing instead (each
    // upload takes whatever frame is current). currentTime can't detect new
    // frames either, as it is rounded the same way.
    function schedule() {
        if (!video)
            return;
        if (!perDisplayFrame) {
            frameCallbackId = video.requestVideoFrameCallback((now, meta) => {
                frameCallbackId = null;
                if (lastPresented >= 0) {
                    recentSkips.push(meta.presentedFrames - lastPresented > 1);
                    if (recentSkips.length > 30)
                        recentSkips.shift();
                }
                lastPresented = meta.presentedFrames;
                // A seek skips once; 5 of the last 30 is a steady pattern
                if (recentSkips.filter(Boolean).length >= 5) {
                    perDisplayFrame = true;
                    console.info('[yt-deband] video frame callbacks are throttled; rendering per display frame');
                }
                draw();
                schedule();
            });
        } else {
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

    // Mirror the video element's box; YouTube positions it with inline styles
    function syncBox() {
        if (!video || !canvas)
            return;
        Object.assign(canvas.style, {
            left: video.offsetLeft + 'px',
            top: video.offsetTop + 'px',
            width: video.offsetWidth + 'px',
            height: video.offsetHeight + 'px',
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
        settings[key] = value;
        saveSettings();
        refreshPanel();
        // A canvas keeps its first context type, so a backend switch needs a new one
        if (key === 'backend' && video)
            attach(video);
        requestRender();
    }

    // Accepts mpv.conf lines or command line flags, e.g.
    // "deband-iterations=2" or "--deband-threshold=35 --deband-grain=16"
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

        const inputs = {
            enabled: check('enabled'),
            algo: select('algo', [['gpu-next', 'vo=gpu-next (libplacebo)'], ['gpu', 'vo=gpu (legacy)']]),
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
        const button = (text, onclick) => el('button', {
            textContent: text, onclick,
            style: { background: '#333', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', font: 'inherit' },
        });

        const root = el('div', {
            className: 'yt-deband-panel',
            style: {
                position: 'fixed', top: '72px', right: '16px', zIndex: '2147483647', width: '320px',
                background: 'rgba(20,20,20,0.96)', color: '#eee', border: '1px solid #444', borderRadius: '8px',
                padding: '12px 14px', font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                display: 'none',
            },
            // Keep YouTube's hotkeys from reacting while typing in the panel
            onkeydown: (e) => e.stopPropagation(),
        },
            el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
                el('strong', { textContent: 'Deband' }),
                button('×', () => togglePanel(false))),
            row('Enabled', inputs.enabled),
            row('Algorithm', inputs.algo),
            row('iterations', inputs.iterations, '--deband-iterations=<0..16> (default 1)'),
            row('threshold', inputs.threshold, '--deband-threshold=<0..4096> (default 48)'),
            row('range', inputs.range, '--deband-range=<1..64> (default 16)'),
            row('grain', inputs.grain, '--deband-grain=<0..4096> (default 32)'),
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
            row('Matrix', inputs.matrix, 'YCbCr matrix the browser used to convert the video to RGB'),
            row('Snap luma', inputs.snap, 'Round recovered luma to the 8-bit code grid, undoing the browser\'s RGB rounding'),
            row('Dither', inputs.dither, 'Dither output to 8 bits (mpv dithers by default)'),
            row('Upload', inputs.precision, 'Format the video frame is uploaded into (WebGL2 only)'),
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
            if (input.type === 'checkbox')
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
    }

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
