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
