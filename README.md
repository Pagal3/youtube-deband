# YouTube Deband

A userscript that debands YouTube video in the browser using WebGL ports of
mpv's deband shaders, with mpv's own parameters.

- **gpu-next**: libplacebo `pl_shader_deband()` (`src/shaders/sampling.c`),
  with mpv's option mapping from `video/out/vo_gpu_next.c`
- **gpu**: mpv's legacy `pass_sample_deband()` (`video/out/gpu/video_shaders.c`)

Like mpv, it debands the Y and subsampled CbCr planes separately before color
conversion: the script undoes the browser's YCbCr→RGB conversion, rebuilds the
planes, debands each one, converts back and draws on a canvas laid over the
`<video>`. Runs on WebGL2, with a WebGL1 fallback (e.g. Tor/Mullvad Browser).

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

| Setting    | Default    | mpv option            |
|------------|------------|-----------------------|
| Algorithm  | `gpu-next` | `--vo`                |
| Iterations | 1          | `--deband-iterations` |
| Threshold  | 48         | `--deband-threshold`  |
| Range      | 16         | `--deband-range`      |
| Grain      | 32         | `--deband-grain`      |

The panel also has the YCbCr matrix (709/601), luma snapping, output dithering,
upload precision, WebGL backend and a split-screen comparison view.

## License

LGPL-2.1-or-later, matching libplacebo and mpv, whose shaders this ports.
See [LICENSE](LICENSE).
