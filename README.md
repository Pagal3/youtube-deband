# YouTube Deband

A userscript that debands YouTube video in the browser using WebGL ports of
[mpv](https://mpv.io/)'s deband shaders, with mpv's own parameters.

- **gpu-next**: [libplacebo](https://code.videolan.org/videolan/libplacebo)
  `pl_shader_deband()`
  ([`src/shaders/sampling.c`](https://code.videolan.org/videolan/libplacebo/-/blob/master/src/shaders/sampling.c)),
  with mpv's option mapping from
  [`video/out/vo_gpu_next.c`](https://github.com/mpv-player/mpv/blob/master/video/out/vo_gpu_next.c)
- **gpu**: mpv's legacy `pass_sample_deband()`
  ([`video/out/gpu/video_shaders.c`](https://github.com/mpv-player/mpv/blob/master/video/out/gpu/video_shaders.c))
- **Fast**: gpu-next cut down to a single pass for weak GPUs (see
  [Weak hardware](#weak-hardware))

Like mpv, it debands the Y and subsampled CbCr planes separately before color
conversion: the script undoes the browser's YCbCr→RGB conversion, rebuilds the
planes, debands each one, converts back and draws on a canvas laid over the
`<video>`. Runs on WebGL2, with a WebGL1 fallback (e.g. Tor/Mullvad Browser).

It can also replace the browser's chroma upscaling with a port of
[GLSL Chroma from Luma (CfL) Prediction](https://github.com/Artoriuz/glsl-chroma-from-luma-prediction)
(see [Chroma upscaling](#chroma-upscaling)).

## Comparison

YouTube's 720p stream of Sintel at 0:35, default settings. Left half is the
video as the browser shows it, right half is debanded:

![Original vs debanded, foggy sky](docs/sky.png)

Banding is easiest to see with the contrast boosted (both halves get the same
curve):

![Original vs debanded, contrast boosted](docs/sky-boosted.png)

![Original vs debanded, sunset at 5:10, contrast boosted](docs/sunset-boosted.png)

<sub>Sintel © Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), [durian.blender.org](https://durian.blender.org)</sub>

Near-black backgrounds band too. A talking-head video at 720p, 0:10:

![Original vs debanded, dark background](docs/dark.png)

With the darkest 8% stretched to full range, the original's background turns
out to be a few flat blocks of brightness:

![Original vs debanded, dark background, shadows lifted](docs/dark-boosted.png)

<sub>Frame from [the largest hack. ever.](https://www.youtube.com/watch?v=_HaySrzDyWU) by voidzilla</sub>

## Install

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/)
   or [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [raw script](https://raw.githubusercontent.com/Pagal3/youtube-deband/main/youtube-deband.user.js)
   and confirm the install. Your userscript manager will pick up updates from
   the same URL.

## Usage

- **Ctrl+Alt+D** toggles debanding
- **Ctrl+Alt+B** or the **DB** button in the player's control bar opens the
  settings panel

Both hotkeys can be re-recorded in the panel.

| Setting          | Default    | mpv option                           |
|------------------|------------|--------------------------------------|
| Mode             | `gpu-next` | `--vo`                               |
| Iterations       | 1          | `--deband-iterations`                |
| Threshold        | 48         | `--deband-threshold`                 |
| Range            | 16         | `--deband-range`                     |
| Grain            | 32         | `--deband-grain`                     |
| Chroma upscaling | Browser    | `--glsl-shaders=CfL_Prediction.glsl` |

The panel also has the YCbCr matrix (709/601), luma snapping, output dithering,
upload precision, WebGL backend and a split-screen comparison view.

### Presets

Pick a preset under **Preset** in the panel to set the four deband values at
once. The mode and the other settings stay as they are.

| Preset      | Iterations | Threshold | Range | Grain | For                                              |
|-------------|------------|-----------|-------|-------|--------------------------------------------------|
| Default     | 1          | 48        | 16    | 32    | mpv's defaults                                   |
| Subtle      | 1          | 32        | 16    | 16    | High bitrate 1080p and up                        |
| Animation   | 4          | 35        | 16    | 4     | Anime and cartoons, where grain shows on flat colors |
| Strong      | 4          | 64        | 20    | 32    | Broad bands in skies, fog and gradients          |
| Aggressive  | 4          | 100       | 8     | 32    | Hard, close-set steps like blocky dark scenes    |
| Low bitrate | 4          | 128       | 16    | 48    | 480p and below, heavily compressed uploads       |

To make your own, set the values (or paste them with **Apply mpv options**),
type a name under them and click **Save**. Saving under a name you already
used updates that preset, and **Delete** next to the list removes the selected
one. When the values match no preset, the list shows **Custom**. **Reset**
doesn't remove your presets.

### Chroma upscaling

YouTube video stores color (chroma) at half the resolution of brightness
(luma), and browsers upscale it bilinearly, so color bleeds a pixel or two
over sharp edges, most visibly red and blue on dark backgrounds. Under
**Chroma upscaling** in the panel, **CfL** and **CfL Lite** replace that with
ports of `CfL_Prediction.glsl` and `CfL_Prediction_Lite.glsl` from
[GLSL Chroma from Luma (CfL) Prediction](https://github.com/Artoriuz/glsl-chroma-from-luma-prediction)
by João Chrisóstomo, the shaders mpv users load with `--glsl-shaders`. They
predict each pixel's color from its full resolution luma with least squares
fits over the chroma pixels around it, and fall back to a plain interpolation
where luma and chroma don't correlate. CfL Lite takes fewer samples and skips
the final smoothing pass.

- They work with gpu-next and gpu, not Fast. On a GeForce RTX 3060 at 1080p,
  where gpu-next debanding takes about 0.16 ms of GPU time per frame, CfL
  adds about 0.5 ms and CfL Lite about 0.4 ms.
- They start from the chroma plane the script rebuilds from the browser's
  RGB, which has already been through the browser's bilinear upscaling, so
  edges come out sharper than the browser's but a little softer than mpv's
  on the original file.
- mpv runs CfL on the debanded planes. Here it runs on the planes before
  debanding and the deband change is added on top, which saves debanding luma
  into a render target first.
- Pasting an mpv.conf line that loads either shader into **mpv options**
  picks it.

## Weak hardware

If video stutters with debanding on, click **Fast** under **Mode** at the top
of the settings panel. It runs the gpu-next algorithm with the same
parameters, but in one pass straight from the video frame instead of four:

- no intermediate textures and no float textures or WebGL extensions
- always uploads the frame as 8-bit RGBA, the cheapest upload
- a cheap float hash instead of the pcg3d generator, which is slow on
  WebGL1, where it is emulated without integers
- shaders are only compiled for the mode in use

To keep it cheap, it debands chroma at full resolution with the same samples as
luma (gpu-next works on half-resolution chroma) and doesn't snap luma, so the
result is close to gpu-next but not identical.

On a GeForce RTX 3060 at 1080p, the debanding itself (without the frame upload
that every mode shares) takes about a third of the GPU time of gpu-next on
WebGL2, and a twentieth on WebGL1.

## Compatibility

**Browsers**

| Browser                         | Status                                                          |
|---------------------------------|-----------------------------------------------------------------|
| Chrome, Edge, Brave, Opera      | Full support                                                    |
| Firefox                         | Full support; before 132 it renders per display frame instead of per video frame |
| Safari 15.4+                    | Should work, less tested                                        |
| Tor / Mullvad Browser           | WebGL1 fallback; fingerprinting protection limits video to 1080p |
| WebGL disabled (NoScript, safest security level) | Not supported; the video plays normally        |

**Userscript managers:** Violentmonkey (recommended), Tampermonkey,
Greasemonkey, FireMonkey and Userscripts for Safari. The script uses no
`GM_*` APIs. Settings and your presets are kept in youtube.com's
`localStorage`, so clearing YouTube's site data resets them.

**Pages:** watch pages, theater mode, fullscreen and embeds (including
youtube-nocookie.com). YouTube Music is excluded. Shorts and m.youtube.com
are untested, and on mobile there is no DB button.

**Videos it skips** (it shows a notice, and the video plays undebanded):

- DRM protected video (purchased or rented movies, some Premium content).
  Browsers don't let WebGL read it.
- HDR (PQ/HLG, BT.2020). Browsers don't give scripts the full HDR signal:
  WebGL receives it cut to 8 bits, and WebGPU receives it already converted
  to SDR, so debanding it would look worse than the video it replaces.
  YouTube sends HDR only to HDR displays, so on an SDR display you get the SDR
  version, which is debanded as usual. Detecting HDR needs WebCodecs
  (`VideoFrame`).
- Resolutions above the browser's WebGL texture limit.

SD videos encoded as BT.601 need the matrix set to 601 in the panel for exact
colors. 4K and higher work, but the cost grows with resolution.

## License

LGPL-2.1-or-later, matching libplacebo and mpv, whose shaders this ports.
See [LICENSE](LICENSE). The CfL shaders are ported from MIT licensed code,
whose notice is kept with the port in the script.
