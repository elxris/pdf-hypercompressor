# Credits

This project's MRC (Mixed Raster Content) segmentation — the foreground /
background / mask decomposition in [`mrc_segment.py`](./mrc_segment.py) — is a
NumPy reimplementation derived from **[archive-pdf-tools](https://github.com/internetarchive/archive-pdf-tools)**
by the **Internet Archive** (primary author **Merlijn Wajer**, with fast
algorithm contributions by **Bas Weelinck**).

Specifically, the Sauvola thresholding, the foreground/background "optimise"
fill, and the noise/denoise steps follow the approach in their `mrc.py` and the
`optimiser`/`sauvola` Cython modules. Because that work is licensed under the
GNU AGPL-3.0, this project is distributed under the **same license** (see
[`LICENSE`](./LICENSE)).

## Third-party components (vendored at build time by `vendor.sh`)

- **[MuPDF / mupdf-wasm](https://mupdf.com/)** — PDF rendering + assembly (AGPL-3.0)
- **[Tesseract.js](https://github.com/naptha/tesseract.js)** + tessdata models — OCR (Apache-2.0 / models Apache-2.0)
- **[Pyodide](https://pyodide.org/)** with NumPy + Pillow — runs the Python segmentation in the browser (MPL-2.0 / various)
- **[franc](https://github.com/wooorm/franc)** — language detection (MIT)

Thank you to all of the above projects and their maintainers.
