# MRC PDF — in-browser scanned-PDF compressor + OCR

Turn a big scanned PDF into a small, **searchable** one — entirely in your
browser. Nothing is uploaded; the file never leaves your machine.

It rebuilds each page as **MRC** (Mixed Raster Content): a sharp 1-bit text mask
over separately-compressed foreground (text colour) and background (paper)
layers, plus an invisible OCR text layer. On a 56-page 300-DPI deed this is
typically **~44 MB → ~12 MB**, fully searchable.

## How it works

Everything runs client-side on WebAssembly:

```
 per page ─┬─ render upright (mupdf-wasm)
           ├─ OCR → word boxes (Tesseract)
           └─ segment + encode layers (Pyodide / NumPy, in a worker pool)
                              │
            assemble MRC PDF + invisible text layer (mupdf-wasm) ─► download
```

- **mupdf-wasm** renders pages (rotation baked in) and assembles the final PDF.
- **Tesseract.js** does OCR (129 vendored languages; auto-detect via `franc`).
- **Pyodide** runs [`mrc_segment.py`](./mrc_segment.py) (NumPy + Pillow only) to
  segment and encode the layers, parallelised across a Web Worker pool.

## Run it

```sh
./vendor.sh        # one-time: download wasm/JS/models into ./vendor (~0.5 GB)
python3 serve.py   # http://localhost:8000
```

Open the page, pick a PDF, optionally **Detect** the language, choose a quality
preset, and **Build PDF**.

`serve.py` sets the `COOP`/`COEP` headers required for `SharedArrayBuffer`
(threaded OCR/Pyodide). Any static host works as long as it sends those headers.

## Features

- **Fully offline / private** — all assets vendored, no CDN, no upload.
- **Quality presets** — Low (200 DPI) / Medium (300) / High (400).
- **129 OCR languages**, defaulting to the browser language; one-click
  content-based auto-detect.
- **Lazy engine loading** — the page stays light and shows the exact MB to be
  downloaded before the first build; workers are freed afterward.
- **Adaptive memory** — the Pyodide worker pool is sized to device memory and
  auto-lowers (with a dismissable notice) if a build runs out of memory.

## Project layout

```
index.html          UI shell
app.js              orchestration: pool, OCR scheduler, assembly, language UI
segment.worker.js   one Pyodide pool worker
mrc_segment.py      MRC segmentation + layer encoding (runs in Pyodide)
vendor.sh           downloads/bundles all third-party assets into ./vendor
serve.py            dev server with COOP/COEP headers
vendor/             vendored assets (gitignored; regenerate with vendor.sh)
```

## License & credits

AGPL-3.0 (see [`LICENSE`](./LICENSE)). The MRC segmentation is derived from the
Internet Archive's **archive-pdf-tools**; see [`CREDITS.md`](./CREDITS.md).
