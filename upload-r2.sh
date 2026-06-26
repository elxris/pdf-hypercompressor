#!/usr/bin/env bash
#
# Upload the app + vendored assets to a Cloudflare R2 bucket with correct
# Content-Type and Cache-Control per file.
#
# Auth: just `wrangler login` first (uses your Cloudflare OAuth; no S3 keys).
# Usage: ./upload-r2.sh <bucket-name>
#
# Speed:
#  - Unchanged files are skipped. A local manifest (.r2-state/<bucket>.manifest)
#    records the sha256 of every object this script has uploaded; on re-run only
#    files whose content changed (or new ones) are sent. The first run uploads
#    everything; later runs typically push just the edited app shell.
#  - Uploads run in parallel (R2_JOBS, default 8).
#  - R2_FORCE=1 re-uploads everything (ignore the manifest).
#
# Notes:
#  - The manifest tracks what THIS checkout uploaded; if the bucket may have
#    diverged (deployed elsewhere, manual edits), run once with R2_FORCE=1.
#  - Deleting a local file does not delete it from the bucket (remove manually).
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

FORCE="${R2_FORCE:-0}"
MAXJOBS="${R2_JOBS:-8}"
STATE_DIR=".r2-state"
STATE_FILE="$STATE_DIR/$BUCKET.manifest"

# sha256 helper (prefer coreutils, fall back to BSD/macOS shasum).
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "need sha256sum or shasum on PATH" >&2
  exit 1
fi

# Look up a key's previously-uploaded hash from the manifest (empty if unknown).
manifest_lookup() {
  [[ -f "$STATE_FILE" ]] || return 0
  awk -F'\t' -v k="$1" '$2==k{print $1; exit}' "$STATE_FILE"
}

content_type() {
  case "$1" in
    *.html)        echo "text/html; charset=utf-8" ;;
    *.js|*.mjs)    echo "text/javascript; charset=utf-8" ;;
    *.wasm)        echo "application/wasm" ;;
    *.json)        echo "application/json; charset=utf-8" ;;
    *.png)         echo "image/png" ;;
    *.jpg|*.jpeg)  echo "image/jpeg" ;;
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

# Runtime files only (skip serve.py, vendor.sh, *.md, LICENSE, .git, etc.)
ROOT_FILES=(
  index.html app.js segment.worker.js mrc_segment.py
  manifest.json
  favicon.png apple-touch-icon.png og-image.png
  screenshot-mobile.png screenshot-desktop.png
)

# Collect every key to consider (root files + vendor tree).
ALL_KEYS=()
for f in "${ROOT_FILES[@]}"; do ALL_KEYS+=("$f"); done
while IFS= read -r f; do ALL_KEYS+=("$f"); done < <(find vendor -type f ! -name '.DS_Store')

# Markers: one file per uploaded/unchanged key, holding "<hash>\t<key>". The new
# manifest is assembled from these at the end, so failed uploads simply aren't
# recorded and get retried next run.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MARKERS="$TMP/markers"
mkdir -p "$MARKERS"

# Decide what to upload. Skipped (unchanged) files carry their hash straight
# into the new manifest via a marker.
TKEY=(); THASH=(); TIDX=()
idx=0
skipped=0
for key in "${ALL_KEYS[@]}"; do
  idx=$((idx + 1))
  h="$(sha256 "$key")"
  if [[ "$FORCE" != "1" && "$h" == "$(manifest_lookup "$key")" ]]; then
    printf '%s\t%s\n' "$h" "$key" > "$MARKERS/$idx"
    skipped=$((skipped + 1))
    continue
  fi
  TKEY+=("$key"); THASH+=("$h"); TIDX+=("$idx")
done

total=${#TKEY[@]}
echo "Skipping $skipped unchanged; uploading $total changed/new (concurrency $MAXJOBS)…"

# Upload in parallel batches of MAXJOBS. Each job is a forked subshell, so it
# snapshots key/h/mk at fork time — reusing the loop vars below is safe.
i=0
FAILED=0
while (( i < total )); do
  pids=()
  for (( j = 0; j < MAXJOBS && i < total; j++ )); do
    key="${TKEY[i]}"; h="${THASH[i]}"; mk="$MARKERS/${TIDX[i]}"
    i=$((i + 1))
    ( put "$key" && printf '%s\t%s\n' "$h" "$key" > "$mk" ) &
    pids+=("$!")
  done
  for p in "${pids[@]}"; do
    if ! wait "$p"; then FAILED=$((FAILED + 1)); fi
  done
done

# Rebuild the manifest from the markers (uploaded + carried-forward unchanged).
mkdir -p "$STATE_DIR"
shopt -s nullglob
marks=("$MARKERS"/*)
shopt -u nullglob
if (( ${#marks[@]} )); then
  cat "${marks[@]}" | sort > "$STATE_FILE"
else
  : > "$STATE_FILE"
fi

if (( FAILED > 0 )); then
  echo "WARNING: $FAILED upload(s) failed — they'll retry on the next run." >&2
  exit 1
fi
echo "Done. $skipped unchanged, $total uploaded to r2://$BUCKET"
