# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An entirely client-side scanned-PDF compressor + OCR. A big scanned PDF is
rebuilt page-by-page as **MRC** (Mixed Raster Content) — a 1-bit text mask over
separately-compressed foreground (ink) and background (paper) JPEG layers, plus
an invisible OCR text layer that makes the result searchable. Nothing is
uploaded; everything runs in the browser on WebAssembly. There is no build step
and no backend.

## Commands

```sh
./vendor.sh        # one-time: download all wasm/JS/models into ./vendor (~0.5 GB)
python3 serve.py   # dev server at http://localhost:8000 (defaults; pass a port to override)
```

`serve.py` exists specifically to send `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy` headers — these are **required** for
`SharedArrayBuffer`, which threaded Tesseract and Pyodide need. Opening
`index.html` via `file://` or any host lacking those headers will break the app
(`window.crossOriginIsolated` must be `true`). The same headers are why
production (R2) needs Transform Rules — see `DEPLOY.md`.

There is no test suite, linter, or bundler. `mrc_segment.py` can be run as a CLI
for ad-hoc segmentation debugging: `python3 mrc_segment.py <image> [dpi]` writes
`/tmp/seg_{mask,fg,bg}.png` (needs local numpy + Pillow).

To update third-party engines, bump the `*_VERSION` vars at the top of
`vendor.sh` and re-run it. `vendor/` is gitignored and regenerated, never edited.

## Architecture

The pipeline, per page (orchestrated in `app.js`):

1. **Render** — `mupdf-wasm` rasterizes the page upright (rotation baked in) to a
   PNG at the preset DPI.
2. **OCR** (parallel with step 3) — `tesseract.js` recognizes the PNG, returning
   word boxes parsed from hOCR (`wordsFromOcr` → `parseHocr`; TSV is a fallback).
3. **Segment + encode** (parallel with step 2) — the PNG is sent to a Pyodide
   worker pool. Each worker runs `mrc_segment.py`'s `encode_layers`, returning
   the three *already-compressed* layers (CCITT-G4 mask + two JPEGs) as byte
   buffers, transferred zero-copy back across the worker boundary.
4. **Assemble** — after all pages finish, `assemblePage` builds each PDF page by
   hand via the mupdf object API: background JPEG, foreground JPEG stenciled
   through the CCITT mask, then an invisible text-render-mode-3 layer positioned
   from the OCR word boxes.

### Key files

- `app.js` — all orchestration: the `Pool` class (Pyodide workers), the
  Tesseract scheduler, lazy engine load/free lifecycle, language UI + detection,
  per-page PDF assembly (`assemblePage`), and the build button handler.
- `segment.worker.js` — one Pyodide pool worker. Loads numpy + pillow +
  `mrc_segment.py`, then calls `encode_layers` per job. (`type: "module"`.)
- `mrc_segment.py` — the MRC segmentation core, **numpy + Pillow only** (no
  scipy/skimage/Cython/fitz, to keep the Pyodide footprint small). A from-scratch
  reimplementation of the Internet Archive's `internetarchivepdf.mrc`: Sauvola
  threshold for the mask, Immerkaer noise gate, neighbour-count denoise,
  box-filter fg fill, ring-by-ring inpaint for bg. All windowed means use an
  integral image (`_window_mean`) for O(1)/pixel. The browser path is
  `encode_layers`; `segment`/`segment_png` are for the CLI/debug.
- `index.html` — UI shell. Loads `tesseract.min.js` as a global script (exposes
  `Tesseract`) and `app.js` as a module. mupdf, Pyodide, and franc are
  `import()`ed lazily so the initial page load stays light.

### Cross-cutting behaviors to preserve when editing `app.js`

- **Lazy engine lifecycle.** Engines aren't loaded until the first build
  (`ensureEngines`) and are fully torn down after each build (`freeEngines`,
  in the `finally`). Before the first build, `showSizes` does HEAD requests to
  tell the user the exact MB to download. The vendored-file `manifest` here must
  stay in sync with the paths actually fetched.
- **Adaptive pool sizing + crash safety.** Pool size = `navigator.deviceMemory ÷
  per-quality divisor`, clamped to ≤4. A `localStorage` sentinel (`mrcBuilding`)
  is set before each build and cleared on orderly exit; finding it still set on
  next load means the last build OOM-crashed the tab (which runs no JS), so the
  pool is pinned to 1 (`mrcPoolCap`) until the user dismisses the crash banner. A
  caught (non-crash) error also pins the pool and forces the `low` preset.
- **Quality presets** (`QUALITY`) drive render DPI plus fg/bg downsample factors
  and JPEG quality — they're the main fidelity/size/memory lever.
- **Language flow.** `populateLangs` builds the dropdown from
  `vendor/.../langs.json`, defaulting to the browser language via `ISO1to3`. On
  build, `detectLanguage` OCRs page 1 and runs `franc`; if the detected language
  differs from the selection the user is asked which to use.

## Deployment

Static hosting on Cloudflare R2 (no Worker). Full procedure — bucket, custom
domain, the two required Transform Rules (root→index.html, and the COOP/COEP
headers), and verification curls — is in `DEPLOY.md`. Upload with
`./upload-r2.sh <bucket>`. Critical gotcha: do **not** set `Content-Encoding:
gzip` on the `.traineddata.gz` models — Tesseract ungzips them itself.

`terraform/` holds personal infra for the `xr.is` zone and is gitignored; it is
not part of the shippable app.

## License

AGPL-3.0. The MRC segmentation is derived from the Internet Archive's
archive-pdf-tools; see `CREDITS.md`.
