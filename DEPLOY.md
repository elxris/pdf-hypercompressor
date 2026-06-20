# Deploy to Cloudflare R2 (pdf.xr.is)

Static, no Worker. A public R2 bucket holds the files; two dashboard
**Transform Rules** add the headers a raw bucket can't, and rewrite `/` to the
index document.

## 1. Build the assets

```sh
./vendor.sh          # downloads ~0.5 GB into ./vendor (one-time)
```

## 2. Create the bucket and upload

```sh
npx wrangler login                 # Cloudflare OAuth (no S3 keys needed)
npx wrangler r2 bucket create pdf-hypercompressor
./upload-r2.sh pdf-hypercompressor # ~153 files, 547 MB; sets Content-Type + Cache-Control
```

The script uploads only the runtime files (`index.html`, `app.js`,
`segment.worker.js`, `mrc_segment.py`, and `vendor/`). It deliberately does
**not** set `Content-Encoding: gzip` on the `.traineddata.gz` models — Tesseract
ungzips them itself.

## 3. Connect the custom domain

R2 → your bucket → **Settings → Custom Domains → Connect Domain** → `pdf.xr.is`.
This requires the `xr.is` zone to be on this Cloudflare account; it creates the
proxied DNS record automatically.

> Don't use the `r2.dev` public URL for production — Transform Rules and caching
> apply to your **custom domain**, not to `r2.dev`.

## 4. Transform Rule — root → index.html

R2 custom domains do **not** serve an index document automatically, so `/` 404s
without this.

Dashboard → your zone (`xr.is`) → **Rules → Transform Rules → Rewrite URL → Create**:

- **When incoming requests match:**
  `Hostname` `equals` `pdf.xr.is` `AND` `URI Path` `equals` `/`
- **Then rewrite path to** → *Static* → `/index.html`

(Optional, if you ever add sub-pages: also rewrite paths ending in `/` to
`…/index.html`. Not needed for this single-page app.)

## 5. Transform Rule — COOP/COEP headers

These enable `SharedArrayBuffer`, required by threaded Tesseract + Pyodide.

Dashboard → **Rules → Transform Rules → Modify Response Header → Create**:

- **When incoming requests match:** `Hostname` `equals` `pdf.xr.is`
- **Then:**
  - *Set static* — `Cross-Origin-Opener-Policy` = `same-origin`
  - *Set static* — `Cross-Origin-Embedder-Policy` = `credentialless`

(Applying to the whole host is fine — only the HTML document needs them, and all
assets are same-origin so the extra headers on sub-resources are harmless.)

## 6. Verify

```sh
curl -sI https://pdf.xr.is/ | grep -i -E 'cross-origin|content-type'
#   content-type: text/html; charset=utf-8
#   cross-origin-opener-policy: same-origin
#   cross-origin-embedder-policy: credentialless

curl -sI https://pdf.xr.is/vendor/mupdf/mupdf-wasm.wasm | grep -i -E 'content-type|cache-control'
#   content-type: application/wasm
#   cache-control: public, max-age=31536000, immutable

# .gz models must NOT carry Content-Encoding: gzip
curl -sI https://pdf.xr.is/vendor/tesseract/lang/eng.traineddata.gz | grep -i -E 'content-type|content-encoding'
#   content-type: application/octet-stream
#   (no content-encoding line)
```

Then open https://pdf.xr.is/ — the console should log `crossOriginIsolated: true`
(check with `window.crossOriginIsolated` in DevTools).

## Re-deploying

Re-run `./upload-r2.sh pdf-hypercompressor` after changing app files. The app
shell (`index.html`, `app.js`, …) uses a short, revalidated cache so updates
show quickly; `vendor/*` is immutable, so re-running only re-uploads it (cheap to
skip if unchanged — delete those lines or bump a path if you ever swap engines).
```
