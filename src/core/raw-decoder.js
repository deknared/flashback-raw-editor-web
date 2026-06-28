/**
 * raw-decoder.js — DNG/RAW decoding via libraw-wasm.
 *
 * libraw-wasm already runs LibRaw inside its own Web Worker, so we use the
 * `LibRaw` class directly — no extra worker wrapper needed. The UI thread stays
 * responsive because all heavy decoding happens in libraw's worker.
 *
 * decode() returns linear RGB float pixels in [0,1] (interleaved, stride 3),
 * ready to feed into FlashbackProcessor.preprocess().
 *
 * Two decode profiles (port of the dual pipeline in processor.py):
 *   - Flashback One35 (EXIF Make contains 'flashback'/'one35'):
 *       raw channels (no WB, black 64) → fused FM1/ASN → ACEScg matrices.
 *   - Any other camera:
 *       camera-WB linear-sRGB output from libraw → LINSRGB_TO_ACESCG.
 */

// LibRaw is imported lazily in freshDecoder() — only downloaded if the JS
// decoder path is skipped (non-One35 files or USE_JS_DECODER=false).
import {
  LINSRGB_TO_ACESCG, SENSOR_BLACK,
  FLASHBACK_EXPOSURE_COMP_EV, LIBRAW_PREMUL,
  ASN_D50, ASN_LIBRAW_CAL, FM1, FM1_WB_TO_ACESCG, computeFlashbackCCM,
  genericRawBoostEv, GENERIC_KELVIN_ACESCG_GAIN,
} from './config.js';
import { decodeOne35HalfSize, decodeOne35Full } from './one35-dng.js';

// Use the pure-JS Bayer decoder for Flashback half-size decodes.
// Set to false to fall back to libraw-wasm for comparison/debugging.
const USE_JS_DECODER = true;

/**
 * Highlight recovery (inpaint-opposed), port of processor.py _recover_highlights().
 * Runs on true raw sensor values (not WB'd) in [0,1]. Replaces clipped pixels with
 * a cube-root pair-average reconstruction in WB space, then returns WB-normalized
 * values (raw / asn) for every pixel. After calling this, the CCM must be
 * FM1_WB_TO_ACESCG (expects WB'd input) rather than RAW_TO_ACESCG.
 *
 * The near-clip scan (raw max ∈ [0.85, 0.93]) approximates cv2.dilate(mask, 15×15),
 * capturing bordering non-clipped pixels to compute a per-channel chrominance offset.
 *
 * @param {Float32Array} pixels  interleaved RGB raw values in [0,1], mutated in place
 * @param {number[]} asn  AsShotNeutral [R,1,B] e.g. [0.541, 1.0, 0.597]
 * @param {number} [threshold=0.95]  raw value at which a channel is considered clipped
 */
function recoverHighlights(pixels, asn, threshold = 0.95) {
  const n = pixels.length / 3;
  const aInv = [1 / asn[0], 1 / asn[1], 1 / asn[2]];

  // First pass: detect clipped pixels and accumulate chrominance from near-clip region.
  const clipped = new Uint8Array(pixels.length);
  let anyClipped = false;
  const sums   = [0, 0, 0];
  const counts = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const b = i * 3;
    const r = pixels[b], g = pixels[b + 1], bv = pixels[b + 2];
    const cR = r  >= threshold ? 1 : 0;
    const cG = g  >= threshold ? 1 : 0;
    const cB = bv >= threshold ? 1 : 0;
    clipped[b] = cR; clipped[b + 1] = cG; clipped[b + 2] = cB;
    if (cR || cG || cB) anyClipped = true;

    // Near-clip (but not clipped) pixels → chrominance reference sample.
    const maxRaw = Math.max(r, g, bv);
    if (maxRaw >= 0.85 && maxRaw < threshold) {
      const rw = r * aInv[0], gw = g * aInv[1], bw = bv * aInv[2];
      const Rc = Math.cbrt(rw < 0 ? 0 : rw);
      const Gc = Math.cbrt(gw < 0 ? 0 : gw);
      const Bc = Math.cbrt(bw < 0 ? 0 : bw);
      const refR = Math.pow((Gc + Bc) * 0.5, 3);
      const refG = Math.pow((Rc + Bc) * 0.5, 3);
      const refB = Math.pow((Rc + Gc) * 0.5, 3);
      if (!cR) { sums[0] += rw - refR; counts[0]++; }
      if (!cG) { sums[1] += gw - refG; counts[1]++; }
      if (!cB) { sums[2] += bw - refB; counts[2]++; }
    }
  }

  // Per-channel chrominance offset (scalar — same as OP's global mean).
  const chroma = [
    counts[0] >= 30 ? sums[0] / counts[0] : 0,
    counts[1] >= 30 ? sums[1] / counts[1] : 0,
    counts[2] >= 30 ? sums[2] / counts[2] : 0,
  ];

  // Second pass: WB-normalise every pixel; reconstruct where clipped.
  if (!anyClipped) {
    for (let i = 0; i < pixels.length; i++) pixels[i] *= aInv[i % 3];
    return;
  }
  for (let i = 0; i < n; i++) {
    const b  = i * 3;
    const r  = pixels[b], g = pixels[b + 1], bv = pixels[b + 2];
    const rw = r  * aInv[0];
    const gw = g  * aInv[1];
    const bw = bv * aInv[2];
    const Rc = Math.cbrt(rw < 0 ? 0 : rw);
    const Gc = Math.cbrt(gw < 0 ? 0 : gw);
    const Bc = Math.cbrt(bw < 0 ? 0 : bw);
    const refR = Math.pow((Gc + Bc) * 0.5, 3) + chroma[0];
    const refG = Math.pow((Rc + Bc) * 0.5, 3) + chroma[1];
    const refB = Math.pow((Rc + Gc) * 0.5, 3) + chroma[2];
    // max() prevents reconstruction from darkening non-clipped bright areas.
    pixels[b]     = clipped[b]     ? Math.max(rw, refR) : rw;
    pixels[b + 1] = clipped[b + 1] ? Math.max(gw, refG) : gw;
    pixels[b + 2] = clipped[b + 2] ? Math.max(bw, refB) : bw;
  }
}

// The Flashback CCM (raw → ACEScg) is now computed per-shot via
// computeFlashbackCCM() in _decodeBody, using whichever FM1 is available:
//  - The DNG's own ForwardMatrix1 tag (0xC714) if present (A1).
//  - The hardcoded FM1 from config.js as fallback.
// LIBRAW_PREMUL and FLASHBACK_EXPOSURE_COMP_EV are folded in the same way as
// before; per-shot AsShotNeutral scales LIBRAW_PREMUL proportionally (A2).

// Per-channel raw corrections for libraw-wasm's systematic decode differences
// vs the desktop's rawpy/LibRaw. Fitted against 5 desktop reference exports
// (test-assets/reference/) via the verify.html side-by-side harness.
//
// All three channels use the same 3-point piecewise gain structure:
//   gain(X) = xS + (xM-xS)·2X           for X ≤ 0.5
//   gain(X) = xM + (xH-xM)·2(X−0.5)    for X > 0.5
// X' = X · gain(X), clamped to 1.0.
//
// GREEN: gS=0.89 pulls shadows down, gH=1.10 lifts highlights — corrects the
// libraw-wasm green tonal curve vs rawpy's output.
//
// RED/BLUE: libraw-wasm's highlight handling over-amplifies R and B in bright
// pixels relative to rawpy. This shows as +5–10 unit display-space excess in
// natural-look profiles (P&S, Rangefinder, FBV1) but is hidden in stylised
// profiles (Disposable, Monochrome) whose LUTs suppress highlights. Fixing it
// at the raw level with rH<1.0 / bH<1.0 selectively attenuates the highlights
// that expose the error, leaving shadows and midtones (Disposable range) intact.
//
// All constants live-tunable via globalThis in verify.html — no reload needed.
const GREEN_SHADOW = 0.89;  // G gain at G=0   (shadows)
const GREEN_MID    = 1.00;  // G gain at G=0.5 (crossover)
const GREEN_HL     = 1.10;  // G gain at G=1.0 (highlights)
// R and B piecewise corrections are ineffective here: after LIBRAW_PREMUL
// scaling (R÷1.272, B÷1.103), most raw pixels sit below the 0.5 midpoint,
// so any highlight knob barely fires. R/B calibration is now handled in
// display space via DISPLAY_CAL in config.js (post-LUT diagonal matrix).
const RED_SHADOW   = 1.00;
const RED_MID      = 1.00;
const RED_HL       = 1.00;
const BLUE_SHADOW  = 1.00;
const BLUE_MID     = 1.00;
const BLUE_HL      = 1.00;

function correctChannels(px) {
  const gS = globalThis.__GREEN_SHADOW ?? GREEN_SHADOW;
  const gM = globalThis.__GREEN_MID    ?? GREEN_MID;
  const gH = globalThis.__GREEN_HL     ?? GREEN_HL;
  const rS = globalThis.__RED_SHADOW   ?? RED_SHADOW;
  const rM = globalThis.__RED_MID      ?? RED_MID;
  const rH = globalThis.__RED_HL       ?? RED_HL;
  const bS = globalThis.__BLUE_SHADOW  ?? BLUE_SHADOW;
  const bM = globalThis.__BLUE_MID     ?? BLUE_MID;
  const bH = globalThis.__BLUE_HL      ?? BLUE_HL;
  for (let i = 0; i < px.length; i += 3) {
    // Piecewise linear gain on each channel. Clamp to 1.0: overflow wraps the
    // Uint16 cache → magenta blobs on cached photos.
    const r = px[i];
    const rGain = r <= 0.5
      ? rS + (rM - rS) * (r * 2)
      : rM + (rH - rM) * ((r - 0.5) * 2);
    const nr = r * rGain;
    px[i] = nr > 1.0 ? 1.0 : nr;

    const g = px[i + 1];
    const gGain = g <= 0.5
      ? gS + (gM - gS) * (g * 2)
      : gM + (gH - gM) * ((g - 0.5) * 2);
    const ng = g * gGain;
    px[i + 1] = ng > 1.0 ? 1.0 : ng;

    const b = px[i + 2];
    const bGain = b <= 0.5
      ? bS + (bM - bS) * (b * 2)
      : bM + (bH - bM) * ((b - 0.5) * 2);
    const nb = b * bGain;
    px[i + 2] = nb > 1.0 ? 1.0 : nb;
  }
}

const FLASHBACK_RE = /flashback|one35/;

// The One35's DNG declares the FULL 4144×3088 sensor as the active area. The
// desktop exports at 2072×1544 (half-size). We crop 8 pixels from each edge of
// Previously 8 to crop green/magenta border rows introduced by libraw-wasm's
// Bayer fringing. The pure-JS decoder reads true sensor values and has no
// border artifacts, so 0 matches the desktop's rawpy output (2072×1544).
const FLASHBACK_EDGE_CROP = 0;

/**
 * Read EXIF fields straight from the DNG/TIFF header — no decoder needed.
 * DNG is TIFF, so this is a plain IFD scan: Make (0x010F) from IFD0, and
 * ExposureTime (0x829A, RATIONAL) from the Exif sub-IFD (pointer 0x8769).
 *
 * Make matters because libraw-wasm's metadata uses `camera_make` (a probe
 * reading `meta.make` silently routed EVERY file down the generic path).
 * ExposureTime drives the reverse auto-exposure: the One35 locks ISO and
 * aperture, so its AE decision is fully captured by this single tag.
 *
 * Also reads DateTimeOriginal (0x9003), AsShotNeutral (0xC628), and
 * ForwardMatrix1 (0xC714 — the camera's calibrated sensor-to-XYZ_D50 matrix,
 * used to build a per-shot CCM instead of the hardcoded FM1 in config.js).
 * @param {ArrayBuffer} buffer
 * @returns {{ make: string|null, exposureS: number|null, dateTaken: string|null,
 *             asn: number[]|null, fm1: number[]|null }}
 */
export function sniffMeta(buffer) {
  const out = { make: null, model: null, exposureS: null, iso: null, fNumber: null,
                focalLength: null, dateTaken: null, asn: null, fm1: null, baselineExposure: null };
  try {
    const dv = new DataView(buffer);
    if (dv.byteLength < 16) return out;
    const order = dv.getUint16(0, false);
    let le;
    if (order === 0x4949) le = true;        // "II"
    else if (order === 0x4D4D) le = false;  // "MM"
    else return out;
    if (dv.getUint16(2, le) !== 42) return out;

    /** Scan one IFD; returns a map of wanted tag id → entry offset. */
    const scan = (ifd, wanted) => {
      const found = {};
      if (ifd <= 0 || ifd + 2 > dv.byteLength) return found;
      const n = dv.getUint16(ifd, le);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > dv.byteLength) break;
        const tag = dv.getUint16(e, le);
        if (wanted.includes(tag)) found[tag] = e;
      }
      return found;
    };

    /** Read an ASCII tag's string value from an entry offset. */
    const ascii = (e) => {
      const count = dv.getUint32(e + 4, le);
      const off = count <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      if (off + count > dv.byteLength) return null;
      let s = '';
      for (let k = 0; k < count - 1; k++) s += String.fromCharCode(dv.getUint8(off + k));
      return s.trim();
    };

    // DNG writers scatter these: DateTimeOriginal (0x9003) can live in IFD0
    // (Leica does this) or in the Exif sub-IFD; 0x0132 ModifyDate is the
    // last-ditch fallback. Scan both IFDs for everything.
    const ifd0 = scan(dv.getUint32(4, le), [0x010F, 0x0110, 0x0132, 0x8769, 0x9003, 0xC628, 0xC714, 0xC62A]);

    if (ifd0[0x010F] !== undefined) out.make = ascii(ifd0[0x010F]);
    if (ifd0[0x0110] !== undefined) out.model = ascii(ifd0[0x0110]);

    // BaselineExposure (0xC62A): one SRATIONAL (type 10) EV — the manufacturer/
    // ACR intended lift from raw mid-grey to display mid-grey. Tier-1 signal for
    // generic-RAW exposure anchoring (foreign DNGs / ProRAW). Mirrors upstream.
    if (ifd0[0xC62A] !== undefined) {
      const e = ifd0[0xC62A];
      const type = dv.getUint16(e + 2, le);
      if (type === 10 || type === 5) {
        const off = dv.getUint32(e + 8, le);   // SRATIONAL is 8 bytes → out-of-line
        if (off + 8 <= dv.byteLength) {
          const n = type === 10 ? dv.getInt32(off, le)     : dv.getUint32(off, le);
          const d = type === 10 ? dv.getInt32(off + 4, le) : dv.getUint32(off + 4, le);
          if (d) out.baselineExposure = n / d;
        }
      }
    }

    // AsShotNeutral (0xC628), 3 values — the One35 stores them as SHORT/LONG
    // integers (e.g. [480,1024,583]) rather than the usual RATIONALs, so read
    // by the entry's actual type and normalise to G=1.
    if (ifd0[0xC628] !== undefined) {
      const e = ifd0[0xC628];
      const type = dv.getUint16(e + 2, le);
      const count = dv.getUint32(e + 4, le);
      if (count === 3) {
        const sz = type === 5 ? 8 : (type === 3 ? 2 : 4);
        const off = sz * 3 <= 4 ? e + 8 : dv.getUint32(e + 8, le);
        if (off + sz * 3 <= dv.byteLength) {
          const v = [];
          for (let k = 0; k < 3; k++) {
            const p = off + k * sz;
            if (type === 5) { const n = dv.getUint32(p, le), d = dv.getUint32(p + 4, le); v.push(d ? n / d : 0); }
            else if (type === 3) v.push(dv.getUint16(p, le));
            else v.push(dv.getUint32(p, le));
          }
          if (v[0] > 0 && v[1] > 0 && v[2] > 0) out.asn = [v[0] / v[1], 1, v[2] / v[1]];
        }
      }
    }

    // ForwardMatrix1 (0xC714): 9 SRATIONAL (type 10) or RATIONAL (type 5) values,
    // row-major camera-sensor-RGB → XYZ_D50. rawpy reads this from the DNG directly;
    // we previously hardcoded it as FM1 in config.js. Reading it per-shot lets us
    // use the camera's own calibration matrix, matching rawpy's pipeline exactly.
    if (ifd0[0xC714] !== undefined) {
      const e     = ifd0[0xC714];
      const type  = dv.getUint16(e + 2, le);
      const count = dv.getUint32(e + 4, le);
      if (count === 9 && (type === 5 || type === 10)) {
        const off = dv.getUint32(e + 8, le);
        if (off + 72 <= dv.byteLength) {
          const fm = [];
          for (let k = 0; k < 9; k++) {
            const p = off + k * 8;
            // SRATIONAL uses signed int32, RATIONAL uses unsigned uint32.
            const n = type === 10 ? dv.getInt32(p, le)     : dv.getUint32(p, le);
            const d = type === 10 ? dv.getInt32(p + 4, le) : dv.getUint32(p + 4, le);
            fm.push(d ? n / d : 0);
          }
          out.fm1 = fm;
        }
      }
    }

    // Read a RATIONAL (8 bytes, out-of-line) at an entry offset → number | null.
    const ratAt = (e) => {
      const off = dv.getUint32(e + 8, le);
      if (off + 8 > dv.byteLength) return null;
      const num = dv.getUint32(off, le), den = dv.getUint32(off + 4, le);
      return den > 0 ? num / den : null;
    };
    // Read a SHORT/LONG (inline) at an entry offset → number.
    const intAt = (e) => (dv.getUint16(e + 2, le) === 3 ? dv.getUint16(e + 8, le) : dv.getUint32(e + 8, le));

    if (ifd0[0x8769] !== undefined) {
      const exifIfd = dv.getUint32(ifd0[0x8769] + 8, le);
      // ExposureTime, ISO, FNumber, FocalLength, DateTimeOriginal
      const exif = scan(exifIfd, [0x829A, 0x8827, 0x829D, 0x920A, 0x9003]);
      if (exif[0x829A] !== undefined) { const v = ratAt(exif[0x829A]); if (v) out.exposureS = v; }
      if (exif[0x8827] !== undefined) { const v = intAt(exif[0x8827]); if (v) out.iso = v; }
      if (exif[0x829D] !== undefined) { const v = ratAt(exif[0x829D]); if (v) out.fNumber = v; }
      if (exif[0x920A] !== undefined) { const v = ratAt(exif[0x920A]); if (v) out.focalLength = v; }
      if (exif[0x9003] !== undefined) out.dateTaken = ascii(exif[0x9003]);
    }
    if (!out.dateTaken && ifd0[0x9003] !== undefined) out.dateTaken = ascii(ifd0[0x9003]);
    if (!out.dateTaken && ifd0[0x0132] !== undefined) out.dateTaken = ascii(ifd0[0x0132]);
    return out;
  } catch {
    return out;
  }
}

// ─── Decoder worker lifecycle ─────────────────────────────────────────────────
// Every `new LibRaw()` spawns a dedicated Web Worker that reserves a 256 MB
// WebAssembly.Memory up front — and the class has NO terminate/dispose API, so
// per-decode instances leak whole workers. After two or three decodes iOS
// kills the page's workers, which surfaced as the forever-"Developing…" hang
// and "can't load more than one DNG".
//
// Reusing ONE instance across decodes doesn't work either: the wasm wrapper
// does not recycle libraw state between open() calls, so every decode after
// the first returns corrupted pixels (verified: tiled/striped output).
//
// So: a FRESH instance per decode, but the previous worker is explicitly
// terminated first via its (exposed) worker field — at most one decoder
// worker is ever alive. Worker + wasm spin-up is ~200 ms against multi-second
// decodes, and the heap goes back to zero between decodes.

let _current = null;               // the at-most-one live LibRaw instance
let _chain   = Promise.resolve();  // serializes ALL decodes module-wide

/** Kill the live decoder worker (frees its wasm heap immediately). */
export function resetDecoder() {
  try { _current?.worker?.terminate(); } catch { /* already dead */ }
  _current = null;
}

/** Terminate whatever came before and hand out a pristine instance. */
async function freshDecoder() {
  resetDecoder();
  const { default: LibRaw } = await import('libraw-wasm');
  _current = new LibRaw();
  return _current;
}

const DECODE_TIMEOUT_MS = 60000;

export class RawDecoder {
  /**
   * Decode a RAW/DNG file. All calls — from any RawDecoder instance — are
   * serialized through one module-level chain and one shared worker, with a
   * watchdog that terminates a hung worker instead of waiting forever.
   * @param {ArrayBuffer} buffer
   * @param {{ fast?: boolean, full?: boolean }} [opts]
   *   fast → LINEAR demosaic (thumbnails); full → full-resolution decode
   *   (default is half-size, which is plenty for the live preview and far
   *   lighter on mobile GPU memory — full is used only at export time).
   * @returns {Promise<{
   *   pixels: Float32Array, width: number, height: number,
   *   ccm: number[], isFlashback: boolean, metadata: object
   * }>}
   */
  decode(buffer, opts = {}) {
    const run = _chain.then(() => this._decodeLocked(buffer, opts));
    // Keep the chain alive whether this decode succeeds or fails.
    _chain = run.then(() => {}, () => {});
    return run;
  }

  async _decodeLocked(buffer, opts) {
    let watchdog;
    const timedOut = new Promise((_, reject) => {
      watchdog = setTimeout(() => {
        // The worker is hung — kill it so the NEXT decode gets a fresh one.
        resetDecoder();
        reject(new Error('Decoding timed out — try reopening the photo'));
      }, DECODE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this._decodeBody(buffer, opts), timedOut]);
    } finally {
      clearTimeout(watchdog);
      // Always release the worker between decodes: its wasm heap (256 MB
      // reserved, more after a decode — full-res especially) never shrinks,
      // and iOS shouldn't carry that while the app idles.
      resetDecoder();
    }
  }

  async _decodeBody(buffer, opts) {
    const halfSize = !opts.full;
    const bytes = new Uint8Array(buffer);

    {
      // Identify the camera + shutter time from the TIFF header — cheap, and
      // skips a whole extra libraw open. Falls back to a probe for odd files.
      const sniffed = sniffMeta(buffer);
      let make = sniffed.make;

      // Need libraw only for the probe (unknown make) or the non-JS path below.
      // Defer freshDecoder() until we know we actually need it.
      let raw = null;
      const ensureRaw = async () => { if (!raw) raw = await freshDecoder(); return raw; };

      if (make === null) {
        await (await ensureRaw()).open(bytes.slice(), { halfSize: true, useCameraWb: true });
        const probe = await raw.metadata(true);
        make = String(probe?.camera_make ?? probe?.make ?? '').trim();
        // A second open() on the same wasm instance returns corrupted pixels
        // (libraw state isn't recycled between opens) — decode on a fresh one.
        raw = await freshDecoder();
      }
      const isFlashback = FLASHBACK_RE.test(make.toLowerCase());

      // ── Pure-JS Bayer decoder path (Flashback) ─────────────────────────────
      // Decodes the One35's uncompressed 10-bit Bayer directly. Half-size matches
      // rawpy half_size=True pixel-for-pixel; full-size demosaics the same mosaic
      // (decodeOne35Full) with identical calibration, so a full-res export matches
      // the preview. Both eliminate LIBRAW_PREMUL and GREEN_SHADOW/GREEN_HL —
      // corrections that only existed to patch up libraw-wasm's decode errors.
      if (isFlashback && USE_JS_DECODER) {
        let { pixels, width, height } = halfSize
          ? decodeOne35HalfSize(buffer)
          : decodeOne35Full(buffer);

        const margin = FLASHBACK_EDGE_CROP;
        if (width > margin * 4 && height > margin * 4)
          ({ pixels, width, height } = cropBorder(pixels, width, height, margin));

        // Highlight recovery white-balances on the CPU (returns raw / neutral).
        // Default: the fixed ASN_D50 daylight neutral — one calibrated WB for
        // every shot. Camera WB (opt-in): use THIS file's AsShotNeutral so warm/
        // cool scenes self-correct like the desktop's per-file WB. Either way the
        // result is WB-normalised (neutral → [1,1,1]), so FM1_WB_TO_ACESCG stays
        // the correct matrix. evComp=0 so no extra CCM scaling.
        const wbAsn = (opts.cameraWb && sniffed.asn) ? sniffed.asn : ASN_D50;
        recoverHighlights(pixels, wbAsn);
        const k = Math.pow(2, FLASHBACK_EXPOSURE_COMP_EV);
        const ccm = k === 1 ? FM1_WB_TO_ACESCG : FM1_WB_TO_ACESCG.map(v => v * k);

        return {
          pixels, width, height, ccm, isFlashback: true,
          asn:       sniffed.asn,
          exposureS: sniffed.exposureS,
          dateTaken: sniffed.dateTaken,
          make:      sniffed.make,  model: sniffed.model,
          iso:       sniffed.iso,   fNumber: sniffed.fNumber, focalLength: sniffed.focalLength,
          metadata:  null,
        };
      }

      await ensureRaw();
      const settings = isFlashback
        ? {
            // Upstream v2: develop the raw WITHOUT white balance or brightness
            // scaling — the ASN/FM1 matrices (folded into RAW_TO_ACESCG) do the
            // calibrated WB + color, and the render applies the exposure lift.
            userQual:     opts.fast ? 0 : 3,     // 0=LINEAR, 3=AHD
            userMul:      [1, 1, 1, 1],          // raw channels, pre-WB
            userBlack:    SENSOR_BLACK,
            halfSize,
            noAutoBright: true,
            bright:       1,
            highlight:    1,                     // clip
            gamm:         [1, 1],                // linear
            outputBps:    16,
            outputColor:  0,                     // raw → matrices applied by us
            useCameraMatrix: 0,
          }
        : {
            // Faster linear demosaic for the half-size preview (generic raws are
            // big and AHD is slow); full-quality AHD only at full-res export.
            userQual:     (opts.fast || halfSize) ? 0 : 3,
            // DAYLIGHT white balance (libraw's pre_mul), NOT camera/auto WB — a
            // daylight-balanced feel is part of the analog look. The D65 →
            // BASE_KELVIN nudge to Flashback's neutral is folded into the matrix.
            useCameraWb:  false,
            useAutoWb:    false,
            halfSize,
            noAutoBright: true,
            bright:       1,
            highlight:    1,
            gamm:         [1, 1],                // linear
            outputBps:    16,
            outputColor:  1,                     // sRGB-linear (libraw does color)
            useCameraMatrix: 1,
          };

      // Re-open with the chosen processing settings, then pull pixels.
      await raw.open(bytes.slice(), settings);
      const meta = await raw.metadata(true);
      const img  = await raw.imageData();

      let { pixels, width, height } = normalizePixels(img, meta);

      // Trim the One35's masked sensor border (see FLASHBACK_EDGE_CROP).
      if (isFlashback) {
        const margin = halfSize ? FLASHBACK_EDGE_CROP : FLASHBACK_EDGE_CROP * 2;
        if (width > margin * 4 && height > margin * 4) {
          ({ pixels, width, height } = cropBorder(pixels, width, height, margin));
        }
      }

      // Per-channel correction (Flashback only) — kills magenta-highlight cast
      // and corrects residual B excess from libraw-wasm's partial white balance.
      if (isFlashback) correctChannels(pixels);

      // Build the per-shot raw→ACEScg CCM.
      //
      // A1 FINDING: the Flashback DNG's 0xC714 (ForwardMatrix1) tag contains a
      // matrix that maps [1,1,1] to equal-energy white [1,1,1] rather than D50
      // white [0.9642,1,0.8249]. The hardcoded FM1 in config.js is the correct
      // calibrated matrix (derived externally, matching the desktop pipeline).
      // The embedded tag is NOT used — sniffMeta still reads it for diagnostics.
      //
      // A2: scale LIBRAW_PREMUL by the ratio of this shot's AsShotNeutral to
      // that of the calibration shot (DNG 00100, ASN_LIBRAW_CAL). libraw-wasm's
      // partial WB scales with the shot ASN, so shots with non-standard WB would
      // otherwise carry a residual colour error. Has zero effect when the shot
      // ASN equals ASN_LIBRAW_CAL (i.e. for DNG 00100 itself).
      let ccm;
      if (isFlashback) {
        const shotAsn = sniffed.asn;   // null if tag absent

        // A2: per-shot premul (identity when shot ASN matches calibration shot).
        const premul = shotAsn
          ? [
              LIBRAW_PREMUL[0] * (shotAsn[0] / ASN_LIBRAW_CAL[0]),
              1.0,
              LIBRAW_PREMUL[2] * (shotAsn[2] / ASN_LIBRAW_CAL[2]),
            ]
          : LIBRAW_PREMUL;

        // Diagonal ACEScg correction: scale R/B output rows of the CCM to
        // remove systematic display-space excess vs desktop reference.
        // Live-tunable via globalThis.__ACE_R_SCALE / __ACE_B_SCALE.
        const aceR = globalThis.__ACE_R_SCALE ?? 1.0;
        const aceB = globalThis.__ACE_B_SCALE ?? 1.0;

        // Always use the hardcoded calibrated FM1 (see A1 finding above).
        ccm = computeFlashbackCCM(FM1, FLASHBACK_EXPOSURE_COMP_EV, premul, aceR, aceB);
      } else {
        // Generic (foreign) RAW: the image is developed at the camera's daylight
        // WB. Fold into the raw→ACEScg matrix: (1) the D65→BASE_KELVIN per-channel
        // gain so it lands at Flashback's neutral, and (2) the exposure anchor
        // (re-anchor libraw's level + per-file BaselineExposure / per-make boost).
        const make = sniffed.make ?? meta?.camera_make ?? meta?.make ?? null;
        const gk = Math.pow(2, genericRawBoostEv(make, sniffed.baselineExposure));
        const kg = GENERIC_KELVIN_ACESCG_GAIN;
        ccm = LINSRGB_TO_ACESCG.map((v, idx) => v * gk * kg[Math.floor(idx / 3)]);
      }

      const asn = isFlashback ? sniffed.asn : null;   // metadata only; not used for colour

      return {
        pixels,
        width,
        height,
        ccm,
        isFlashback,
        // The file's AsShotNeutral — kept so the Auto WB toggle can re-balance
        // to a fixed reference without re-decoding.
        asn,
        // EXIF shutter time (seconds) — drives reverse auto-exposure. EXIF
        // sniff first, libraw's shutter field as fallback.
        exposureS:   sniffed.exposureS ?? (meta?.shutter > 0 ? meta.shutter : null),
        // EXIF capture date ("YYYY:MM:DD HH:MM:SS") — for the date stamp.
        dateTaken:   sniffed.dateTaken,
        // Camera info for the metadata panel — sniffed first, libraw as fallback.
        make:        sniffed.make ?? meta?.camera_make ?? meta?.make ?? null,
        model:       sniffed.model ?? meta?.camera_model ?? meta?.model ?? null,
        iso:         sniffed.iso ?? (meta?.iso_speed > 0 ? meta.iso_speed : null),
        fNumber:     sniffed.fNumber ?? (meta?.aperture > 0 ? meta.aperture : null),
        focalLength: sniffed.focalLength ?? (meta?.focal_len > 0 ? meta.focal_len : null),
        metadata:    meta,
      };
    }
  }
}

/** Crop `m` pixels from every edge of an interleaved RGB float image. */
function cropBorder(pixels, w, h, m) {
  const nw = w - 2 * m, nh = h - 2 * m;
  const out = new Float32Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    const src = ((y + m) * w + m) * 3;
    out.set(pixels.subarray(src, src + nw * 3), y * nw * 3);
  }
  return { pixels: out, width: nw, height: nh };
}

/**
 * Normalize libraw imageData() output into an interleaved Float32 RGB array
 * in [0,1]. Handles both typed-array and {data,width,height,...} shapes, and
 * both 8- and 16-bit samples. Drops a 4th (alpha) channel if present.
 */
function normalizePixels(img, meta) {
  // Resolve the raw sample buffer + descriptor fields from whatever shape we got.
  let data, width, height, bits, colors;

  if (ArrayBuffer.isView(img)) {
    data = img;
    width  = meta?.iwidth  ?? meta?.width;
    height = meta?.iheight ?? meta?.height;
    bits   = img instanceof Uint16Array ? 16 : 8;
    colors = 3;
  } else if (img && typeof img === 'object') {
    data   = img.data ?? img.pixels ?? img.image;
    width  = img.width  ?? meta?.iwidth  ?? meta?.width;
    height = img.height ?? meta?.iheight ?? meta?.height;
    bits   = img.bits   ?? (data instanceof Uint16Array ? 16 : 8);
    colors = img.colors ?? 3;
  } else {
    throw new Error('[raw-decoder] Unexpected imageData() return type');
  }
  if (!data) throw new Error('[raw-decoder] No pixel data in imageData() result');

  // If we received raw bytes but expect 16-bit, reinterpret as Uint16 (LE).
  if (data instanceof Uint8Array && bits === 16) {
    data = new Uint16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
  }

  const maxVal = bits === 16 ? 65535 : 255;
  const total  = width * height;

  // Derive channel count from the buffer if the descriptor disagrees.
  const perPixel = Math.round(data.length / total);
  if (perPixel === 3 || perPixel === 4) colors = perPixel;

  const out = new Float32Array(total * 3);
  if (colors === 3) {
    for (let i = 0; i < out.length; i++) out[i] = data[i] / maxVal;
  } else {
    // Interleaved RGBA (or RGBG) → take first 3 channels.
    for (let p = 0, s = 0, d = 0; p < total; p++, s += colors, d += 3) {
      out[d]     = data[s]     / maxVal;
      out[d + 1] = data[s + 1] / maxVal;
      out[d + 2] = data[s + 2] / maxVal;
    }
  }

  if (!width || !height) {
    throw new Error(`[raw-decoder] Could not determine dimensions (w=${width}, h=${height})`);
  }
  return { pixels: out, width, height };
}
