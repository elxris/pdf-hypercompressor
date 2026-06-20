// Pyodide segmentation worker (one per pool slot). Loads numpy + pillow + the
// numpy-only mrc_segment.py, then on each job segments a rendered page PNG and
// returns the three compressed MRC layers. Module worker (type:"module").
import { loadPyodide } from "./vendor/pyodide/pyodide.mjs";

let pyodide, encode;

async function init() {
  pyodide = await loadPyodide({ indexURL: "./vendor/pyodide/" });
  await pyodide.loadPackage(["numpy", "pillow"]);
  const src = await (await fetch("./mrc_segment.py")).text();
  pyodide.FS.writeFile("mrc_segment.py", src);
  encode = pyodide.pyimport("mrc_segment").encode_layers;
  postMessage({ type: "ready" });
}
const ready = init().catch((e) => postMessage({ type: "error", error: String(e && e.stack || e) }));

onmessage = async (ev) => {
  const { id, png, dpi, params } = ev.data;
  await ready;
  try {
    const res = encode.callKwargs({ png_bytes: png, dpi, ...(params || {}) });
    const obj = res.toJs({ dict_converter: Object.fromEntries });
    res.destroy();
    // transfer the byte buffers back (zero-copy)
    const transfer = ["mask", "fg", "bg"].map((k) => obj[k].buffer);
    postMessage({ id, result: obj }, transfer);
  } catch (e) {
    postMessage({ id, error: String(e && e.stack || e) });
  }
};
