#!/usr/bin/env bash
#
# Upload the app + vendored assets to a Cloudflare R2 bucket with correct
# Content-Type and Cache-Control per file.
#
# Auth: just `wrangler login` first (uses your Cloudflare OAuth; no S3 keys).
# Usage: ./upload-r2.sh <bucket-name>
#
# Notes:
#  - .traineddata.gz files are uploaded WITHOUT Content-Encoding on purpose:
#    Tesseract fetches them as raw bytes and ungzips itself. If we advertised
#    `Content-Encoding: gzip`, the browser would auto-inflate and Tesseract
#    would then fail to inflate again.
#  - .wasm is served as application/wasm so browsers can stream-compile it.
#  - COOP/COEP headers are NOT set here; add them as a Cloudflare Transform
#    Rule on the custom domain (see DEPLOY.md).

set -euo pipefail

# Use a local wrangler if present, otherwise fall back to npx.
WRANGLER=(wrangler)
command -v wrangler >/dev/null 2>&1 || WRANGLER=(npx wrangler)

BUCKET="${1:-}"
if [[ -z "$BUCKET" ]]; then
  echo "usage: $0 <bucket-name>" >&2
  exit 1
fi

# Runtime files only (skip serve.py, vendor.sh, *.md, LICENSE, .git, etc.)
ROOT_FILES=(index.html app.js segment.worker.js mrc_segment.py)

content_type() {
  case "$1" in
    *.html)        echo "text/html; charset=utf-8" ;;
    *.js|*.mjs)    echo "text/javascript; charset=utf-8" ;;
    *.wasm)        echo "application/wasm" ;;
    *.json)        echo "application/json; charset=utf-8" ;;
    *.py)          echo "text/plain; charset=utf-8" ;;
    *.whl|*.zip|*.gz) echo "application/octet-stream" ;;
    *)             echo "application/octet-stream" ;;
  esac
}

cache_control() {
  # Vendored engines/models never change for a given URL -> cache hard.
  # App shell can update -> short cache, always revalidated.
  case "$1" in
    vendor/*) echo "public, max-age=31536000, immutable" ;;
    *)        echo "public, max-age=600, must-revalidate" ;;
  esac
}

put() {
  local key="$1"
  local ct cc
  ct="$(content_type "$key")"
  cc="$(cache_control "$key")"
  echo "→ $key  [$ct]"
  "${WRANGLER[@]}" r2 object put "$BUCKET/$key" \
    --file="$key" \
    --content-type="$ct" \
    --cache-control="$cc" \
    --remote >/dev/null
}

for f in "${ROOT_FILES[@]}"; do
  put "$f"
done

while IFS= read -r f; do
  put "$f"
done < <(find vendor -type f ! -name '.DS_Store')

echo "Done. Uploaded app shell + vendor/ to r2://$BUCKET"
