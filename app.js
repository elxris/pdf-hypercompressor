// mupdf is dynamically imported on first build so the initial page load stays
// light (its ~10 MB wasm doesn't download until you actually build).
let mupdf;

const $ = (id) => document.getElementById(id);
// log()    -> detailed technical lines, browser console only.
// status() -> short, plain-language line shown under the progress bar (+ console).
const log = (m) => console.log("%c[hypercompressor]", "color:#e11d48;font-weight:bold", m);
const status = (m) => { $("status").textContent = m; log(m); };
const setProgress = (d, t) => { $("fill").style.width = (t ? (100 * d / t) : 0) + "%"; };

const T = { workerPath: "./vendor/tesseract/worker.min.js", corePath: "./vendor/tesseract/core",
            langPath: "./vendor/tesseract/lang", gzip: true };

// Quality presets: render DPI (mask sharpness + OCR), and foreground/background
// downsample + JPEG quality. Higher = bigger/slower/more memory, better fidelity.
const QUALITY = {
  low:    { dpi: 200, fg_ds: 4, fg_q: 30, bg_ds: 4, bg_q: 35 },
  medium: { dpi: 300, fg_ds: 3, fg_q: 40, bg_ds: 3, bg_q: 45 },
  high:   { dpi: 400, fg_ds: 2, fg_q: 60, bg_ds: 2, bg_q: 55 },
};

// ---- Pyodide worker pool ----------------------------------------------------
class Pool {
  constructor(url, n) {
    this.idle = []; this.q = []; this.jobs = new Map(); this._id = 0; this._ready = [];
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(url, { type: "module" });
      let done; this._ready.push(new Promise((r) => (done = r)));
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "ready") { this.idle.push(w); done(); this._pump(); return; }
        if (m.type === "error" && m.id == null) { log("Pyodide init error: " + m.error); return; }
        const job = this.jobs.get(m.id); this.jobs.delete(m.id); this.idle.push(w);
        m.error ? job.rej(new Error(m.error)) : job.res(m.result);
        this._pump();
      };
      return w;
    });
  }
  ready() { return Promise.all(this._ready); }
  run(png, dpi, params) { return new Promise((res, rej) => { this.q.push({ png, dpi, params, res, rej }); this._pump(); }); }
  _pump() {
    while (this.idle.length && this.q.length) {
      const w = this.idle.pop(), job = this.q.shift(), id = ++this._id;
      this.jobs.set(id, job);
      w.postMessage({ id, png: job.png, dpi: job.dpi, params: job.params });
    }
  }
  terminate() { this.workers.forEach((w) => w.terminate()); this.idle = []; this.q = []; }
}

// ---- OCR: tesseract scheduler, returns word boxes from TSV -------------------
function parseTsv(tsv) {
  const lines = tsv.split("\n"); const hdr = lines[0].split("\t");
  const ci = (n) => hdr.indexOf(n); const words = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t"); if (c.length < hdr.length) continue;
    if (c[ci("level")] !== "5") continue;
    const t = (c[ci("text")] || "").trim(); if (!t || parseFloat(c[ci("conf")]) < 0) continue;
    const l = +c[ci("left")], tp = +c[ci("top")], w = +c[ci("width")], h = +c[ci("height")];
    words.push([t, l, tp, l + w, tp + h]);
  }
  return words;
}

// Fallback: parse word boxes from hOCR (ocrx_word spans with bbox in @title).
function parseHocr(hocr) {
  const dom = new DOMParser().parseFromString(hocr, "text/html");
  const words = [];
  for (const el of dom.querySelectorAll(".ocrx_word, .ocr_word")) {
    const t = el.textContent.trim(); if (!t) continue;
    const m = (el.getAttribute("title") || "").match(/bbox (\d+) (\d+) (\d+) (\d+)/);
    if (m) words.push([t, +m[1], +m[2], +m[3], +m[4]]);
  }
  return words;
}

// tesseract.js 5.x doesn't populate TSV, so prefer hOCR (TSV kept as a fallback
// for other versions). No per-page logging — it's the normal path.
function wordsFromOcr(data) {
  if (data.hocr) { const w = parseHocr(data.hocr); if (w.length) return w; }
  return data.tsv ? parseTsv(data.tsv) : [];
}

// ---- per-page MRC assembly (ports spike_assemble.mjs) -----------------------
const pdfStr = (s) => {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (cp >= 32 && cp <= 126) out += ch;
    else if (cp <= 255) out += "\\" + cp.toString(8).padStart(3, "0");
    else out += "?";
  }
  return out;
};

function assemblePage(doc, L, words) {
  const name = (s) => doc.newName(s), int = (n) => doc.newInteger(n);
  const Wpt = (L.page_w * 72) / L.dpi, Hpt = (L.page_h * 72) / L.dpi;

  const md = doc.newDictionary();
  md.put("Type", name("XObject")); md.put("Subtype", name("Image"));
  md.put("Width", int(L.mask_w)); md.put("Height", int(L.mask_h));
  md.put("ImageMask", doc.newBoolean(true)); md.put("Filter", name("CCITTFaxDecode"));
  const p = doc.newDictionary();
  p.put("K", int(-1)); p.put("Columns", int(L.mask_w)); p.put("Rows", int(L.mask_h));
  md.put("DecodeParms", p);
  const dz = doc.newArray(2); dz.push(int(1)); dz.push(int(0)); md.put("Decode", dz);
  const maskRef = doc.addRawStream(L.mask, md);

  const img = (jpg, w, h, mask) => {
    const d = doc.newDictionary();
    d.put("Type", name("XObject")); d.put("Subtype", name("Image"));
    d.put("Width", int(w)); d.put("Height", int(h));
    d.put("ColorSpace", name("DeviceRGB")); d.put("BitsPerComponent", int(8));
    d.put("Filter", name("DCTDecode")); if (mask) d.put("Mask", mask);
    return doc.addRawStream(jpg, d);
  };
  const bgRef = img(L.bg, L.bg_w, L.bg_h, null);
  const fgRef = img(L.fg, L.fg_w, L.fg_h, maskRef);

  const sx = Wpt / L.page_w, sy = Hpt / L.page_h;
  let text = "BT 3 Tr\n";
  for (const [t, x0, y0, x1, y1] of words) {
    const fontPt = (y1 - y0) * sy; if (fontPt <= 0) continue;
    const tz = Math.max(10, Math.min(400, ((x1 - x0) * sx) / Math.max(1, t.length * 0.5 * fontPt) * 100));
    text += `/F0 ${fontPt.toFixed(2)} Tf ${tz.toFixed(1)} Tz 1 0 0 1 ${(x0 * sx).toFixed(2)} ${(Hpt - y1 * sy).toFixed(2)} Tm (${pdfStr(t)} ) Tj\n`;
  }
  text += "ET\n";

  const font = doc.newDictionary();
  font.put("Type", name("Font")); font.put("Subtype", name("Type1"));
  font.put("BaseFont", name("Helvetica")); font.put("Encoding", name("WinAnsiEncoding"));
  const xo = doc.newDictionary(); xo.put("Bg", bgRef); xo.put("Fg", fgRef);
  const fr = doc.newDictionary(); fr.put("F0", font);
  const res = doc.newDictionary(); res.put("XObject", xo); res.put("Font", fr);

  const content = `q ${Wpt} 0 0 ${Hpt} 0 0 cm /Bg Do Q\nq ${Wpt} 0 0 ${Hpt} 0 0 cm /Fg Do Q\n` + text;
  return doc.addPage([0, 0, Wpt, Hpt], 0, res, content);
}

// ---- download-size warning (HEAD requests only; nothing heavy loads) --------
const MB = (b) => (b / 1048576).toFixed(1);
const manifest = (lang) => ({
  "PDF engine (mupdf)": ["vendor/mupdf/mupdf-wasm.wasm"],
  [`OCR (tesseract + ${lang})`]: [
    "vendor/tesseract/worker.min.js",
    "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js",
    `vendor/tesseract/lang/${lang}.traineddata.gz`,
  ],
  "Python (Pyodide + numpy + pillow)": [
    "vendor/pyodide/pyodide.asm.wasm", "vendor/pyodide/pyodide.asm.mjs",
    "vendor/pyodide/python_stdlib.zip",
    "vendor/pyodide/numpy-2.4.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
    "vendor/pyodide/pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  ],
});
async function headSize(url) {
  try { const r = await fetch(url, { method: "HEAD" }); return +(r.headers.get("content-length") || 0); }
  catch { return 0; }
}
async function showSizes() {
  if (building) return;                                  // #sizes is hidden while compressing
  if (enginesLoaded) { $("sizes").innerHTML = "✅ Ready to compress."; return; }
  const groups = manifest($("lang").value);
  let total = 0; const parts = [];
  for (const [g, files] of Object.entries(groups)) {
    const s = (await Promise.all(files.map(headSize))).reduce((a, b) => a + b, 0);
    total += s; parts.push(`${g.split(" (")[0]} ${MB(s)} MB`);
  }
  console.log("[hypercompressor] download breakdown:", parts.join(" · "));
  $("sizes").innerHTML = `The first time you compress, this page sets itself up by downloading ` +
    `about <b>${MB(total)} MB</b> — once. Your browser then remembers it, so it's quick after that and even works offline.`;
}

// ---- lazy engine lifecycle --------------------------------------------------
let pool, scheduler, ocrWorkers = [], enginesLoaded = false;
let detectionDone = false;                              // language detection runs once per file
let currentFile = null;                                 // chosen via picker or drag-and-drop
let building = false;                                   // true while a compression is running

function setFile(f) {
  if (!f || (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf"))) {
    status("That doesn't look like a PDF.");
    return;
  }
  currentFile = f;
  detectionDone = false;
  $("fname").textContent = f.name;
  $("dropEmpty").hidden = true; $("dropFile").hidden = false;   // show the selected-file view
  $("dl").hidden = true;
  status(`Ready to compress — ${f.name}`);
}

function clearFile() {
  currentFile = null;
  detectionDone = false;
  $("file").value = "";
  $("dropFile").hidden = true; $("dropEmpty").hidden = false;   // back to the drop prompt
  $("dl").hidden = true;
  status("Ready.");
}

const dz = $("drop");
// Click the (empty) zone to pick; once a file is set you remove it first to pick another.
dz.addEventListener("click", () => { if (!currentFile) $("file").click(); });
$("removeFile").addEventListener("click", (e) => { e.stopPropagation(); clearFile(); });
$("file").addEventListener("change", (e) => setFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "dragend"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("over")));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); setFile(e.dataTransfer.files[0]); });
// Don't let a stray drop outside the zone navigate away from the page.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
async function ensureEngines(lang) {
  if (enginesLoaded) return;
  const t0 = performance.now();
  log("Loading engines (downloading wasm/data, then caching)…");
  if (!mupdf) mupdf = await import("./vendor/mupdf/mupdf.js");
  const poolN = currentPool();
  scheduler = Tesseract.createScheduler();
  ocrWorkers = [];
  const n = Math.min(2, poolN);
  for (let i = 0; i < n; i++) {
    const w = await Tesseract.createWorker(lang, 1, T);  // keep refs so we can switch language
    ocrWorkers.push(w); scheduler.addWorker(w);
  }
  pool = new Pool("./segment.worker.js", poolN); await pool.ready();
  enginesLoaded = true;
  log(`Engines ready (${poolN} Pyodide + ${n} OCR) in ${Math.round(performance.now() - t0)} ms.`);
  showSizes();
}

// Switch the OCR language in place (reinitialize the existing workers).
async function switchOcrLanguage(lang) {
  await Promise.all(ocrWorkers.map((w) => w.reinitialize(lang, 1)));
}
async function freeEngines() {
  if (pool) { pool.terminate(); pool = null; }
  if (scheduler) { try { await scheduler.terminate(); } catch {} scheduler = null; }
  ocrWorkers = [];
  enginesLoaded = false;
  log("Workers terminated — memory released.");
  showSizes();
}

// ---- language list: populate from vendored manifest, default to browser lang -
// Map common ISO 639-1 (navigator.language) -> Tesseract 639-2/T codes.
const ISO1to3 = { en: "eng", es: "spa", de: "deu", fr: "fra", pt: "por", it: "ita",
  nl: "nld", ru: "rus", zh: "chi_sim", ja: "jpn", ko: "kor", ar: "ara", hi: "hin",
  tr: "tur", pl: "pol", uk: "ukr", vi: "vie", th: "tha", el: "ell", he: "heb",
  sv: "swe", nb: "nor", no: "nor", da: "dan", fi: "fin", cs: "ces", ro: "ron",
  hu: "hun", id: "ind", fa: "fas", bn: "ben", ta: "tam", te: "tel", ms: "msa",
  bg: "bul", hr: "hrv", sr: "srp", sk: "slk", sl: "slv", lt: "lit", lv: "lav",
  et: "est", ca: "cat", eu: "eus", gl: "glg", af: "afr", sq: "sqi", hy: "hye" };

// Script-specific / special Tesseract codes that Intl.DisplayNames can't resolve.
const NAMES = {
  chi_sim: "Chinese, Simplified", chi_sim_vert: "Chinese, Simplified (vertical)",
  chi_tra: "Chinese, Traditional", chi_tra_vert: "Chinese, Traditional (vertical)",
  jpn_vert: "Japanese (vertical)", kor_vert: "Korean (vertical)",
  aze_cyrl: "Azerbaijani (Cyrillic)", srp_latn: "Serbian (Latin)", uzb_cyrl: "Uzbek (Cyrillic)",
  deu_frak: "German (Fraktur)", deu_latf: "German (Fraktur, latf)",
  dan_frak: "Danish (Fraktur)", slk_frak: "Slovak (Fraktur)",
  ita_old: "Italian (old)", spa_old: "Spanish (old)", kat_old: "Georgian (old)",
  lao: "Lao", equ: "Math / equations", osd: "Orientation & script detection",
};

async function populateLangs() {
  let langs = ["eng"];
  try { langs = await (await fetch("./vendor/tesseract/lang/langs.json")).json(); } catch {}
  if (!langs.length) langs = ["eng"];
  let dn; try { dn = new Intl.DisplayNames([navigator.language || "en"], { type: "language" }); } catch {}
  const opts = langs.map((code) => {
    let nm = NAMES[code];                                 // hardcoded names win
    if (!nm) { try { const x = dn && dn.of(code); if (x && x.toLowerCase() !== code.toLowerCase()) nm = x; } catch {} }
    return { code, label: nm ? `${nm} (${code})` : code };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const sel = $("lang"); sel.innerHTML = "";
  for (const { code, label } of opts) {
    const o = document.createElement("option"); o.value = code; o.textContent = label; sel.appendChild(o);
  }
  const prim = (navigator.language || "en").toLowerCase().split("-")[0];
  const want = ISO1to3[prim];
  sel.value = (want && langs.includes(want)) ? want : (langs.includes("eng") ? "eng" : langs[0]);
  log(`${langs.length} languages available; default: ${sel.value} (browser: ${navigator.language || "?"}).`);
}

$("lang").addEventListener("change", showSizes);
populateLangs().then(showSizes);

// Pool default depends on device memory AND the quality preset (higher DPI =
// more memory per worker), and is capped if a previous build crashed. The cap
// persists until the user dismisses the warning.
// Pool size is managed internally (no UI knob): device memory ÷ a per-quality
// weight, clamped, then capped by the crash logic below.
const devMem = navigator.deviceMemory || 4;          // GB (capped at 8 by browsers)
const POOL_DIVISOR = { low: 3, medium: 4, high: 6 }; // ~GB of RAM per worker by quality
const nominalPool = (q) => Math.max(1, Math.min(Math.floor(devMem / (POOL_DIVISOR[q] || 4)), 4));
const poolCap = () => { const c = parseInt(localStorage.getItem("mrcPoolCap") || "", 10); return c >= 1 ? c : Infinity; };
const currentPool = () => Math.max(1, Math.min(nominalPool($("quality").value), poolCap()));

// A full-tab OOM ("Aw, Snap") runs no JS, so we leave a localStorage sentinel
// before each build and clear it on orderly exit (finally / pagehide). Finding
// it still set on load => the last build crashed: set a persistent pool cap.
try {
  const crashed = JSON.parse(localStorage.getItem("mrcBuilding") || "null");
  if (crashed && crashed.pool) {
    localStorage.setItem("mrcPoolCap", String(Math.max(1, crashed.pool - 1)));
    localStorage.removeItem("mrcBuilding");
  }
} catch {}

function showCrashBanner() {
  const cap = poolCap(), el = $("crash");
  if (cap === Infinity) { el.hidden = true; return; }
  el.innerHTML = `⚠️ Your last compression didn't finish — your device may have run low on memory, ` +
    `so we've eased off to stay safe. <button id="dismissCrash" type="button">Got it — restore full speed</button>`;
  el.hidden = false;
  $("dismissCrash").onclick = () => {
    try { localStorage.removeItem("mrcPoolCap"); } catch {}
    el.hidden = true;
    log("Full speed restored.");
  };
}

showCrashBanner();
// pagehide = orderly close/navigation -> clear sentinel so it isn't read as a crash.
window.addEventListener("pagehide", () => { try { localStorage.removeItem("mrcBuilding"); } catch {} });

// ---- build ------------------------------------------------------------------
$("go").addEventListener("click", async () => {
  const file = currentFile; if (!file) { status("Drop or choose a PDF first."); return; }
  building = true;
  $("go").disabled = true; $("go").textContent = "Compressing…";
  $("dl").hidden = true; $("sizes").hidden = true; $("bar").hidden = false; setProgress(0, 1);
  status("Getting ready…");
  const Q = QUALITY[$("quality").value] || QUALITY.medium;
  const dpi = Q.dpi;
  const poolN = currentPool();
  try { localStorage.setItem("mrcBuilding", JSON.stringify({ pool: poolN, ts: Date.now() })); } catch {}
  let inDoc, outDoc, results;
  try {
    await ensureEngines($("lang").value);
    log(`Quality ${$("quality").value} (${dpi} DPI), pool ${poolN}.`);
    const src = new Uint8Array(await file.arrayBuffer());
    inDoc = mupdf.Document.openDocument(src, "application/pdf");

    // First step: detect the language once per file. If it differs from the
    // selection, ask whether to use the detected one or keep the selected one.
    if (!detectionDone) {
      detectionDone = true;
      status("Checking the document's language…");
      const detected = await detectLanguage(inDoc);
      const selected = $("lang").value;
      const nm = (c) => { const o = [...$("lang").options].find((x) => x.value === c); return o ? o.textContent : c; };
      if (detected && detected !== selected) {
        if (confirm(`Detected language: ${nm(detected)}.\nCurrently selected: ${nm(selected)}.\n\nOK = use the detected language; Cancel = keep your selection.`)) {
          await switchOcrLanguage(detected);
          $("lang").value = detected; showSizes();
          log(`Using detected language: ${detected}.`);
        } else {
          log(`Keeping selected language: ${selected}.`);
        }
      } else {
        log(detected ? `Detected ${detected} (matches selection).` : "Language not detected; keeping selection.");
      }
    }

    const pages = Array.from({ length: inDoc.countPages() }, (_, i) => i);  // always all pages
    const concurrency = pool.workers.length;
    status(`Compressing ${pages.length} pages…`);
    log(`concurrency ${concurrency}, ${dpi} DPI, ${$("quality").value} quality`);

    results = new Array(pages.length);
    let done = 0; const tStart = performance.now();
    let cursor = 0;
    async function driver() {
      while (cursor < pages.length) {
        const k = cursor++; const pageIndex = pages[k];
        const page = inDoc.loadPage(pageIndex);
        const pix = mupdf.Page.prototype.toPixmap.call(
          page, mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
        const png = pix.asPNG(); pix.destroy(); page.destroy();
        const blob = new Blob([png], { type: "image/png" });
        const [ocr, layers] = await Promise.all([
          scheduler.addJob("recognize", blob, {}, { hocr: true }),
          pool.run(png, dpi, { fg_ds: Q.fg_ds, fg_q: Q.fg_q, bg_ds: Q.bg_ds, bg_q: Q.bg_q }),
        ]);
        results[k] = { layers, words: wordsFromOcr(ocr.data) };
        setProgress(++done, pages.length);
        status(`Compressing… page ${done} of ${pages.length}`);
        log(`page ${pageIndex + 1}: ${results[k].words.length} words, ${(layers.fg.length + layers.bg.length + layers.mask.length) / 1024 | 0} KB`);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, driver));

    status("Finishing up…");
    outDoc = new mupdf.PDFDocument();
    for (let k = 0; k < pages.length; k++)
      outDoc.insertPage(-1, assemblePage(outDoc, results[k].layers, results[k].words));
    const out = outDoc.saveToBuffer("compress").asUint8Array();

    const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
    const a = $("dl"); a.href = url; a.download = file.name.replace(/\.pdf$/i, "") + "-optimized.pdf"; a.hidden = false;
    const before = file.size / 1e6, after = out.length / 1e6, saved = Math.round((1 - after / before) * 100);
    status(`Done! ${before.toFixed(1)} MB → ${after.toFixed(1)} MB (${saved}% smaller). Your download is ready below.`);
    log(`${pages.length} pages in ${((performance.now() - tStart) / 1000).toFixed(1)} s`);
  } catch (e) {
    status("Something went wrong — open the browser console for details.");
    log("ERROR: " + (e.stack || e));
  } finally {
    // A caught error isn't a tab crash, so clear the sentinel either way; only a
    // real OOM crash (no finally runs) leaves it set for the next load to detect.
    try { localStorage.removeItem("mrcBuilding"); } catch {}
    // Release everything: terminate workers (the big win) + free mupdf objects.
    try { inDoc?.destroy?.(); } catch {}
    try { outDoc?.destroy?.(); } catch {}
    results = null;
    building = false; $("sizes").hidden = false;
    await freeEngines();
    $("go").disabled = false; $("go").textContent = "Compress";
  }
});

// ---- language auto-detect (franc) -------------------------------------------
// franc returns ISO 639-3, which mostly matches Tesseract codes; map the few
// that differ. Detection works best for Latin-script docs OCR'd with any Latin
// model (the recognised words still reveal the language).
const FRANC_TO_TESS = { cmn: "chi_sim", pes: "fas", nob: "nor", nno: "nor", zsm: "msa", arb: "ara" };

// Detect the document language: OCR page 1 with the current model, then franc.
// Returns a vendored Tesseract code, or null (no text / undetected / not vendored).
async function detectLanguage(inDoc) {
  const page = inDoc.loadPage(0);
  const pix = mupdf.Page.prototype.toPixmap.call(
    page, mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = pix.asPNG(); pix.destroy(); page.destroy();
  const ocr = await scheduler.addJob("recognize", new Blob([png], { type: "image/png" }), {}, { hocr: true });
  const text = parseHocr(ocr.data.hocr).map((w) => w[0]).join(" ");
  if (!text.trim()) return null;
  const { franc } = await import("./vendor/franc/franc.mjs");
  const iso3 = franc(text);
  if (!iso3 || iso3 === "und") return null;
  const code = FRANC_TO_TESS[iso3] || iso3;
  return [...$("lang").options].some((o) => o.value === code) ? code : null;
}
