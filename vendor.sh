#!/usr/bin/env bash
#
# Vendor the browser prototype's wasm/JS dependencies into ./vendor so the page
# runs fully offline with no CDN. Re-run to update; bump the *_VERSION vars first.
#
#   ./vendor.sh
#
# Requires: npm (to fetch packages reproducibly via `npm pack`) and curl.
set -euo pipefail

MUPDF_VERSION="1.3.0"
TESSERACT_VERSION="5"             # npm dist-tag/range; resolved version is printed
TESSERACT_CORE_VERSION="5"
# Standard models (OCR quality priority — larger than the "fast" variants). The
# browser downloads only the single language the user selects; we vendor them all
# so any can be chosen.
TESSDATA_BASE="https://tessdata.projectnaptha.com/4.0.0"
LANGS=()   # empty -> every language in the tessdata repo

# Pyodide: empty -> use the version `npm` resolves. Packages whose dependency
# closure is vendored (everything mrc_segment.py needs):
PYODIDE_VERSION="${PYODIDE_VERSION:-}"
PYODIDE_PACKAGES=(numpy pillow)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$SCRIPT_DIR/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fetch an npm package tarball and extract it to $TMP/<destname>/package
fetch_npm() {
  local spec="$1" dest="$2"
  echo ">> npm pack $spec"
  ( cd "$TMP" && npm pack "$spec" --silent >/dev/null )
  local tgz; tgz="$(ls -t "$TMP"/*.tgz | head -1)"
  mkdir -p "$TMP/$dest"
  tar xzf "$tgz" -C "$TMP/$dest"
  rm -f "$tgz"
}

echo "Vendoring into $VENDOR"
rm -rf "$VENDOR"
mkdir -p "$VENDOR/mupdf" "$VENDOR/tesseract/core" "$VENDOR/tesseract/lang"

# --- mupdf: ESM entry + its wasm glue + the wasm binary -----------------------
fetch_npm "mupdf@$MUPDF_VERSION" mupdf
cp "$TMP"/mupdf/package/dist/*.js "$TMP"/mupdf/package/dist/*.wasm "$VENDOR/mupdf/"

# --- tesseract.js: main script + worker --------------------------------------
fetch_npm "tesseract.js@$TESSERACT_VERSION" tjs
cp "$TMP"/tjs/package/dist/tesseract.min.js "$VENDOR/tesseract/"
cp "$TMP"/tjs/package/dist/worker.min.js "$VENDOR/tesseract/"

# --- tesseract.js-core: all wasm core variants (page picks simd/lstm at run) --
fetch_npm "tesseract.js-core@$TESSERACT_CORE_VERSION" tcore
cp "$TMP"/tcore/package/*.wasm.js "$TMP"/tcore/package/*.wasm "$VENDOR/tesseract/core/"

# --- franc: language detector, bundled to one self-contained ESM via esbuild --
echo ">> bundling franc"
mkdir -p "$VENDOR/franc"
( cd "$TMP" && npm init -y >/dev/null 2>&1 && npm install franc >/dev/null 2>&1 \
  && printf "export { franc, francAll } from 'franc';\n" > franc-entry.mjs \
  && npx --yes esbuild franc-entry.mjs --bundle --format=esm --outfile="$VENDOR/franc/franc.mjs" >/dev/null 2>&1 )

# --- language data: all standard traineddata (parallel) + a manifest for UI ---
if [ ${#LANGS[@]} -eq 0 ]; then
  echo ">> enumerating all languages (tessdata)"
  mapfile -t LANGS < <(curl -fsSL "https://api.github.com/repos/tesseract-ocr/tessdata/git/trees/main" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=(JSON.parse(s).tree)||[];for(const x of t)if(x.path.endsWith(".traineddata")&&!x.path.includes("/"))console.log(x.path.replace(".traineddata",""))})')
fi
echo ">> downloading ${#LANGS[@]} traineddata (standard) in parallel"
# `|| true`: a few repo languages aren't on the CDN mirror (e.g. deu_latf) and
# 404; don't abort — the GitHub fallback below recovers any that are missing.
printf '%s\n' "${LANGS[@]}" | xargs -P 10 -I {} curl -fsSL --retry 3 \
  -o "$VENDOR/tesseract/lang/{}.traineddata.gz" "$TESSDATA_BASE/{}.traineddata.gz" || true

# Recover CDN-missing models from the GitHub repo (raw .traineddata) + gzip.
for lang in "${LANGS[@]}"; do
  [ -f "$VENDOR/tesseract/lang/$lang.traineddata.gz" ] && continue
  echo ">> $lang not on CDN; fetching raw from GitHub + gzip"
  if curl -fsSL "https://github.com/tesseract-ocr/tessdata/raw/main/$lang.traineddata" -o "$TMP/$lang.traineddata"; then
    gzip -c "$TMP/$lang.traineddata" > "$VENDOR/tesseract/lang/$lang.traineddata.gz"
    rm -f "$TMP/$lang.traineddata"
  fi
done
# manifest = languages actually present (so the UI never offers a missing one)
( cd "$VENDOR/tesseract/lang" && ls *.traineddata.gz 2>/dev/null | sed 's/\.traineddata\.gz$//' ) \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.trim()?s.trim().split("\n").sort():[])))' \
  > "$VENDOR/tesseract/lang/langs.json"
echo ">> vendored $(node -e "console.log(require('$VENDOR/tesseract/lang/langs.json').length)") languages"

# --- Pyodide core + only the wheels in our packages' dependency closure -------
# NB: the npm `pyodide` package version diverges from the real release version;
# take the release tag from GitHub (that's what the CDN path uses).
if [ -z "$PYODIDE_VERSION" ]; then
  PYODIDE_VERSION="$(curl -fsSL https://api.github.com/repos/pyodide/pyodide/releases/latest \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
fi
PYO_BASE="https://cdn.jsdelivr.net/pyodide/v$PYODIDE_VERSION/full"
PYO_DIR="$VENDOR/pyodide"
echo ">> pyodide v$PYODIDE_VERSION core"
mkdir -p "$PYO_DIR"
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  curl -fL --retry 3 -o "$PYO_DIR/$f" "$PYO_BASE/$f"
done

echo ">> resolving wheel closure for: ${PYODIDE_PACKAGES[*]}"
mapfile -t WHEELS < <(node -e '
  const lock = require(process.argv[1]);
  const pkgs = lock.packages, want = process.argv.slice(2);
  const seen = new Set(), files = new Set();
  const norm = (s) => s.toLowerCase().replace(/[-_.]+/g, "-");
  const byNorm = {}; for (const k in pkgs) byNorm[norm(k)] = pkgs[k];
  const visit = (name) => {
    const p = byNorm[norm(name)];
    if (!p || seen.has(p.name)) return;
    seen.add(p.name); files.add(p.file_name);
    (p.depends || []).forEach(visit);
  };
  want.forEach(visit);
  console.error(`   ${seen.size} packages -> ${files.size} wheels`);
  process.stdout.write([...files].join("\n"));
' "$PYO_DIR/pyodide-lock.json" "${PYODIDE_PACKAGES[@]}")

for whl in "${WHEELS[@]}"; do
  echo "   $whl"
  curl -fsL --retry 3 -o "$PYO_DIR/$whl" "$PYO_BASE/$whl"
done

echo
echo "Resolved versions:"
echo "  pyodide          $PYODIDE_VERSION"
echo "  mupdf            $(node -p "require('$TMP/mupdf/package/package.json').version")"
echo "  tesseract.js     $(node -p "require('$TMP/tjs/package/package.json').version")"
echo "  tesseract-core   $(node -p "require('$TMP/tcore/package/package.json').version")"
echo
echo "Done. Vendored tree:"
( cd "$VENDOR" && find . -type f | sort | sed 's/^/  /' )
du -sh "$VENDOR" | sed 's/^/Total: /'
