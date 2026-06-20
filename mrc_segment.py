"""Standalone MRC segmentation — the array-only core of internetarchivepdf,
implemented with **numpy + Pillow only** (no scipy, no scikit-image, no Cython,
no fitz). Keeps the vendored Pyodide footprint tiny.

Reproduces internetarchivepdf.mrc.create_mrc_hocr_components:

  * mask:       Sauvola threshold        (inlined; replaces skimage.threshold_sauvola
                                           and the Cython sauvola.binarise_sauvola)
  * noise gate: Immerkaer Laplacian std  (replaces skimage.restoration.estimate_sigma)
  * denoise:    neighbour-count          (replaces Cython fast_mask_denoise)
  * fg/bg fill: box-filter "radiate masked pixels into non-masked" — a vectorised
                approximation of the Cython optimise_rgb2/optimise_gray2.

All windowed means use an O(1)/pixel integral image, so no scipy.ndimage.
hOCR mask is omitted here (additive upstream); threshold alone suffices to
derisk the segmentation.
"""
import numpy as np
from PIL import Image


def _window_mean(a, n, mode="reflect"):
    """Mean over a (2n+1)x(2n+1) window, via a summed-area table. O(1) per pixel."""
    H, W = a.shape
    k = 2 * n + 1
    ap = np.pad(a.astype(np.float64), n, mode=mode)
    S = np.cumsum(np.cumsum(ap, axis=0), axis=1)
    S = np.pad(S, ((1, 0), (1, 0)))  # leading zero row/col
    total = (S[k:k + H, k:k + W] - S[0:H, k:k + W]
             - S[k:k + H, 0:W] + S[0:H, 0:W])
    return total / (k * k)


def _gaussian_blur(a, sigma):
    """Small separable Gaussian (numpy-only)."""
    r = max(1, int(round(3 * sigma)))
    xs = np.arange(-r, r + 1)
    ker = np.exp(-(xs ** 2) / (2 * sigma * sigma))
    ker /= ker.sum()
    out = np.zeros_like(a, dtype=np.float64)
    ap = np.pad(a.astype(np.float64), ((0, 0), (r, r)), mode="reflect")
    for i, kk in enumerate(ker):
        out += kk * ap[:, i:i + a.shape[1]]
    ap = np.pad(out, ((r, r), (0, 0)), mode="reflect")
    res = np.zeros_like(a, dtype=np.float64)
    for i, kk in enumerate(ker):
        res += kk * ap[i:i + a.shape[0], :]
    return res


def _estimate_noise(grayf):
    """Immerkaer fast noise std on the central crop (matches the original's intent:
    a quick 'is this scan noisy?' gate before thresholding)."""
    h, w = grayf.shape
    hs, he = int(h / 2 - h / 4), int(h / 2 + h / 4)
    ws, we = int(w / 2 - w / 4), int(w / 2 + w / 4)
    if he == 0 or we == 0:
        hs, he, ws, we = 0, h, 0, w
    a = grayf[hs:he, ws:we].astype(np.float64)
    if a.shape[0] < 3 or a.shape[1] < 3:
        return 0.0
    conv = (a[:-2, :-2] - 2 * a[:-2, 1:-1] + a[:-2, 2:]
            - 2 * a[1:-1, :-2] + 4 * a[1:-1, 1:-1] - 2 * a[1:-1, 2:]
            + a[2:, :-2] - 2 * a[2:, 1:-1] + a[2:, 2:])
    H, W = a.shape
    return float(np.sum(np.abs(conv)) * np.sqrt(0.5 * np.pi) / (6.0 * (W - 2) * (H - 2)))


def _sauvola_mask(gray_u8, dpi=None, k=0.34, R=128.0):
    window = 51
    if dpi:
        window = int(dpi / 4)
        if window % 2 == 0:
            window += 1
        window = max(window, 3)
    n = window // 2
    g = gray_u8.astype(np.float64)
    mean = _window_mean(g, n, "reflect")
    sq = _window_mean(g * g, n, "reflect")
    std = np.sqrt(np.clip(sq - mean * mean, 0, None))
    thresh = mean * (1 + k * (std / R - 1))
    return gray_u8 <= thresh  # text = pixels darker than local threshold


def _denoise(mask, mincnt=4, n_size=2):
    """Drop isolated mask pixels: keep only those with >= mincnt mask neighbours."""
    size = 2 * n_size + 1
    cnt = _window_mean(mask.astype(np.float64), n_size, "constant") * (size * size)
    return mask & ((cnt - 1) >= mincnt)


def _fill(fill_where_not, img, n_size):
    """Replace pixels NOT in `fill_where_not` with the local mean of pixels that
    ARE — i.e. radiate the masked region outward (optimise_*2 approximation)."""
    m = fill_where_not.astype(np.float64)
    den = _window_mean(m, n_size, "constant")
    den_safe = np.maximum(den, 1e-12)
    target = ~fill_where_not
    out = img.astype(np.float32).copy()
    if img.ndim == 2:
        num = _window_mean(img.astype(np.float64) * m, n_size, "constant")
        filled = np.where(den > 0, num / den_safe, 0)
        out[target] = filled[target]
    else:
        for c in range(img.shape[2]):
            num = _window_mean(img[..., c].astype(np.float64) * m, n_size, "constant")
            filled = np.where(den > 0, num / den_safe, 0)
            out[..., c][target] = filled[target]
    return out.astype(np.uint8)


def _dilate(mask, r):
    """Binary dilation by radius r (any mask pixel within the window)."""
    return _window_mean(mask.astype(np.float64), r, "constant") > 0


def _inpaint(hole_mask, img, n_size=16, max_iter=24):
    """Fill `hole_mask` (True = text pixels) with surrounding background by
    propagating known pixels inward, ring by ring, until the holes close. Unlike
    a single-pass box fill this reaches the interior of thick strokes, so no
    text ghost survives in the background layer. The window mean is integral-image
    based (O(1)/pixel regardless of n_size), so a large window converges fast."""
    known = ~hole_mask
    out = img.astype(np.float64).copy()
    if img.ndim == 2:
        out[hole_mask] = 0
    else:
        out[hole_mask] = 0
    for _ in range(max_iter):
        unknown = ~known
        if not unknown.any():
            break
        kf = known.astype(np.float64)
        den = _window_mean(kf, n_size, "constant")
        fillable = (den > 0) & unknown
        if not fillable.any():
            break
        den_safe = np.maximum(den, 1e-12)
        if img.ndim == 2:
            num = _window_mean(out * kf, n_size, "constant")
            vals = num / den_safe
            out[fillable] = vals[fillable]
        else:
            for c in range(img.shape[2]):
                num = _window_mean(out[..., c] * kf, n_size, "constant")
                vals = num / den_safe
                out[..., c][fillable] = vals[fillable]
        known = known | fillable
    return out.astype(np.uint8)


def _downsample(arr, ds, nearest=False):
    """Downscale an array by integer factor ds (NEAREST for masks, BILINEAR else)."""
    if ds <= 1:
        return arr
    im = Image.fromarray(arr)
    w, h = im.size
    im = im.resize((max(1, w // ds), max(1, h // ds)),
                   Image.NEAREST if nearest else Image.BILINEAR)
    return np.array(im)


def _segment_mask(image, dpi=None, denoise=True):
    """The full-resolution heavy step: returns (mask bool, rgb uint8)."""
    pil = image if isinstance(image, Image.Image) else Image.fromarray(image)
    arr = np.array(pil)
    grayf = np.array(pil.convert("L"), dtype=np.float64)

    sigma = _estimate_noise(grayf)
    if sigma > 1.0:
        grayf = _gaussian_blur(grayf, sigma * 0.1)

    mask = _sauvola_mask(np.clip(grayf, 0, 255).astype(np.uint8), dpi=dpi)
    del grayf
    if denoise:
        mask = _denoise(mask)
    rgb = arr if arr.ndim == 3 else np.stack([arr] * 3, axis=-1)
    return mask, rgb


def segment(image, dpi=None, denoise=True):
    """image: PIL.Image or HxW(x3) uint8 ndarray. Returns (mask, fg, bg) at full
    resolution. The browser path uses encode_layers (fg/bg at encode resolution)."""
    mask, rgb = _segment_mask(image, dpi=dpi, denoise=denoise)
    fg = _fill(mask, rgb, 3)        # bleed text outward      -> foreground layer
    # Dilate the mask before inpainting so the anti-aliased glyph fringe (not
    # caught by Sauvola) is also removed, otherwise it ghosts in the background.
    # Fringe width scales with resolution, so scale the dilation with DPI
    # (~3 px at 300 DPI) rather than hard-coding it.
    dilate_r = max(1, round((dpi or 300) / 100))
    bg = _inpaint(_dilate(mask, dilate_r), rgb)
    return mask, fg, bg


def encode_ccitt_g4(mask_bool):
    """Encode a boolean text mask (True=text) as a single-strip CCITT Group 4
    (T.6) stream, ready to embed in a PDF with /Filter /CCITTFaxDecode.

    Pillow/libtiff does the G4 coding; we force one strip (STRIP_SIZE) so the
    whole image is one continuous stream (PDF needs /Rows = height), then slice
    the strip bytes straight out of the TIFF. text -> black(0), bg -> white(255).
    Returns (data: bytes, width, height).
    """
    import io
    from PIL import TiffImagePlugin
    TiffImagePlugin.STRIP_SIZE = 1 << 24  # 16 MB -> single strip
    h, w = mask_bool.shape
    pil1 = Image.fromarray(np.where(mask_bool, 0, 255).astype(np.uint8)).convert("1")
    buf = io.BytesIO()
    pil1.save(buf, format="TIFF", compression="group4")
    data = buf.getvalue()
    tags = Image.open(io.BytesIO(data)).tag_v2
    offs, counts = tags.get(273), tags.get(279)
    if len(counts) != 1:
        raise RuntimeError(f"expected single G4 strip, got {len(counts)}")
    return data[offs[0]:offs[0] + counts[0]], w, h


def encode_layers(png_bytes, dpi=300, fg_ds=3, fg_q=40, bg_ds=3, bg_q=45):
    """Full per-page MRC encode for the browser pipeline: segment a rendered page
    and return the three *compressed* layers (CCITT mask + JPEG fg/bg) plus dims,
    so only small byte buffers cross the worker boundary (not raw arrays).
    """
    import io
    img = Image.open(io.BytesIO(bytes(png_bytes))).convert("RGB")
    W, H = img.size
    # Full-res only for the mask (needs sharp edges); fg/bg are computed at the
    # encode (downsampled) resolution so the heavy fill/inpaint run on ~1/ds^2 the
    # pixels — big peak-memory + speed win, and fg/bg are lossy/small anyway.
    mask, rgb = _segment_mask(img, dpi=dpi)
    ccitt, mw, mh = encode_ccitt_g4(mask)

    dilate_r = max(1, round((dpi or 300) / 100))
    holes = _dilate(mask, dilate_r)

    fg_rgb = _downsample(rgb, fg_ds)
    fg_mask = _downsample(mask.astype(np.uint8), fg_ds, nearest=True).astype(bool)
    fg_arr = _fill(fg_mask, fg_rgb, max(1, round(3 / fg_ds)))

    bg_rgb = _downsample(rgb, bg_ds)
    bg_holes = _downsample(holes.astype(np.uint8), bg_ds, nearest=True).astype(bool)
    bg_arr = _inpaint(bg_holes, bg_rgb, n_size=max(4, round(16 / bg_ds)))

    def jpg(arr, q):
        b = io.BytesIO()
        Image.fromarray(arr).save(b, format="JPEG", quality=q)
        return b.getvalue()

    return {
        "page_w": W, "page_h": H, "dpi": dpi,
        "mask": ccitt, "mask_w": mw, "mask_h": mh,
        "fg": jpg(fg_arr, fg_q), "fg_w": fg_arr.shape[1], "fg_h": fg_arr.shape[0],
        "bg": jpg(bg_arr, bg_q), "bg_w": bg_arr.shape[1], "bg_h": bg_arr.shape[0],
    }


def segment_png(png_bytes, dpi=None):
    """Browser entry point: PNG bytes in -> (mask_png, fg_png, bg_png) bytes out.

    The PNGs are encoded for *intuitive display*, not as the raw layers:
      * mask -> black text on white (the raw mask has text=1=white)
      * fg   -> the ink layer shown over white through the mask (the raw fg is
                near-black everywhere, since non-text is filled with ink colour)
    The actual MRC encoding uses the raw arrays + encode_ccitt_g4(), not these.
    """
    import io
    img = Image.open(io.BytesIO(bytes(png_bytes))).convert("RGB")
    mask, fg, bg = segment(img, dpi=dpi)

    def enc(a):
        b = io.BytesIO()
        Image.fromarray(a).save(b, format="PNG")
        return b.getvalue()

    mask_disp = np.where(mask, 0, 255).astype(np.uint8)  # text black, paper white
    fg_disp = np.full_like(fg, 255)
    fg_disp[mask] = fg[mask]                              # ink on white
    return enc(mask_disp), enc(fg_disp), enc(bg)


if __name__ == "__main__":
    import sys, time
    src = sys.argv[1]
    dpi = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    img = Image.open(src)
    t = time.time()
    mask, fg, bg = segment(img, dpi=dpi)
    dt = time.time() - t
    print(f"segmented {img.size} in {dt:.2f}s  mask_coverage={mask.mean()*100:.1f}%")
    Image.fromarray((mask * 255).astype(np.uint8)).save("/tmp/seg_mask.png")
    Image.fromarray(fg).save("/tmp/seg_fg.png")
    Image.fromarray(bg).save("/tmp/seg_bg.png")
    print("wrote /tmp/seg_mask.png /tmp/seg_fg.png /tmp/seg_bg.png")
