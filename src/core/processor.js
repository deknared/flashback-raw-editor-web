/**
 * processor.js — Main image-processing pipeline (WebGPU).
 * Phase 2: full GPU color pipeline.
 *
 * Pipeline (port of FlashbackProcessor in processor.py):
 *
 *   preprocess(linearRGB)  →  ACEScct intermediate  (once per image, slow)
 *       to-ACEScg matrix (FM1/ASN for Flashback raws) → highlight-desat →
 *       ACEScct encode   (upstream v2 pipeline)
 *
 *   renderPreview()        →  ImageData             (per slider change, fast)
 *       decode → WB/exposure (+2 EV lift) → ACEScct→LUT (film) or
 *       tone-curve (neutral) → live effects → present
 *
 * All pixel data is a flat Float32Array, R G B interleaved, stride 3, in [0,1].
 * The ACEScct intermediate is kept on the GPU in a persistent storage buffer so
 * slider changes only re-run the cheap preview passes (Refinement F).
 */

import {
  isAvailable, loadShaderModule, createComputePipeline,
  createF32Buffer, createEmptyBuffer, createUniformBuffer, createU32Uniform,
  runCompute, readbackF32, dispatchSize, maxStorageBindingSize,
} from './gpu.js';

import {
  RAW_TO_ACESCG, RENDER_LIFT_EV, REVERSE_AE_T_REF, REVERSE_AE_STRENGTH,
} from './config.js';
import { RawDecoder } from './raw-decoder.js';
import { Effects } from './effects.js';

/** Grain tiles (Refinement B — tile, not noise). All four are packed into a
 *  2×2 atlas so grain uses every original tile and repeats far less visibly. */
const GRAIN_TILE_URLS = [
  '/assets/grain/grain_01.png',
  '/assets/grain/grain_02.png',
  '/assets/grain/grain_03.png',
  '/assets/grain/grain_04.png',
];

// Shader URLs (Vite resolves & copies these for dev + build).
import acescctUrl     from '../shaders/acescct.wgsl?url';
import adjustUrl      from '../shaders/adjust.wgsl?url';
import lutUrl         from '../shaders/lut.wgsl?url';
import colormatrixUrl from '../shaders/colormatrix.wgsl?url';
import tonecurveUrl   from '../shaders/tonecurve.wgsl?url';
import postgainUrl    from '../shaders/postgain.wgsl?url';
import saturationUrl  from '../shaders/saturation.wgsl?url';

const STORAGE_RW = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

export class FlashbackProcessor {
  constructor() {
    /** @type {Float32Array|null} CPU copy of the ACEScct intermediate (for export / rotation) */
    this.intermediateAcescct = null;
    /** @type {string|null} */
    this.currentFile = null;
    this.width  = 0;
    this.height = 0;

    /** @type {ArrayBuffer|null} Original file bytes, kept so export can re-decode full-size. */
    this._origBuffer = null;
    /** Whether the loaded image used the Flashback decode profile. */
    this._isFlashback = false;
    /** Whether the loaded image is a finished photo (JPEG/PNG) — effects-only. */
    this._isPhoto = false;
    /** Camera (per-file) white balance for One35 decodes; set from settings. */
    this.cameraWb = false;
    /** Current photo's crop+straighten {angle,x,y,w,h} (normalised) or null —
     *  the vignette follows it so the falloff lands on the final cropped frame. */
    this.cropRect = null;
    /** Reverse-AE gain (t_ref / exposure) for the loaded photo; 1 = none. */
    this._revGain = 1;
    /** EXIF capture date string of the loaded photo (for the date stamp). */
    this._dateTaken = null;
    /** Saturation (1 = none). */
    this.saturation = 1;
    /** Net 90° clockwise rotations the user applied (mod 4); replayed at export. */
    this._rotation = 0;
    /** Whether the most recent renderExportFull() actually produced full resolution. */
    this._lastExportFullRes = false;

    this.userSettings = {
      exposure_ev:  0.0,
      wb_temp:      0,
      tint:         0.0,
      push_pull_ev: 0.0,   // film push/pull: shifts pre-LUT density, undone post
    };

    /** Effect/vibe config (set by editor). */
    this.config = null;
    /** @type {import('./lut.js').GpuLut|null} */
    this.gpuLut = null;

    // GPU state
    this._ready     = false;
    this._pipelines = null;          // { decode, encode, adjust, lut, colormatrix }
    this._full      = null;          // { buf, w, h, count } persistent intermediate
    this._small     = null;          // { buf, w, h, count } downscaled intermediate
    this._scratch   = new Map();     // count -> { a, b } reusable working buffers
    this._pool      = new Map();      // "key:count" -> GPUBuffer (effect work buffers)
    this._decoder   = new RawDecoder();
    this._effects   = new Effects();

    /** Serializes every GPU buffer operation (render / preprocess / rotate /
     *  export). Without this, switching photo or profile could start a new
     *  render — or FREE the shared scratch/pool buffers (setIntermediate) —
     *  while a previous render's async readback was still reading them, reading
     *  half-overwritten memory. That surfaced as garbled (magenta/blue) blown
     *  highlights that only appeared after switching photos/profiles. */
    this._gpuChain = Promise.resolve();
  }

  /** Run `fn` after all previously-queued GPU work settles (never concurrently). */
  _locked(fn) {
    const run = this._gpuChain.then(fn, fn);
    this._gpuChain = run.then(() => {}, () => {});   // keep the chain alive on error
    return run;
  }

  /** Lazily get/create a named effect work buffer for an element count. */
  _poolBuf(key, count) {
    const id = `${key}:${count}`;
    let buf = this._pool.get(id);
    if (!buf) {
      buf = createEmptyBuffer(count * 4, STORAGE_RW);
      this._pool.set(id, buf);
    }
    return buf;
  }

  /** Update user-adjustable settings. Does not re-render. */
  setSettings(partial) { Object.assign(this.userSettings, partial); }

  /** Returns a copy of current settings. */
  getSettings() { return { ...this.userSettings }; }

  /** Set the effect/vibe config object (from config.factoryStateFor / vibe-state). */
  setConfig(config) { this.config = config; }

  /** Attach a GPU-resident LUT (from lut.uploadLut / loadGpuLut). */
  setLut(gpuLut) { this.gpuLut = gpuLut; }

  // ── GPU init ────────────────────────────────────────────────────────────

  /**
   * Compile shaders and build compute pipelines. Call once after gpu.init().
   * @returns {Promise<boolean>} true if ready
   */
  async init() {
    if (this._ready) return true;
    if (!isAvailable()) {
      console.warn('[processor] GPU not available — init skipped.');
      return false;
    }
    const [acescct, adjust, lut, colormatrix, tonecurve, postgain, saturation] = await Promise.all([
      loadShaderModule(acescctUrl),
      loadShaderModule(adjustUrl),
      loadShaderModule(lutUrl),
      loadShaderModule(colormatrixUrl),
      loadShaderModule(tonecurveUrl),
      loadShaderModule(postgainUrl),
      loadShaderModule(saturationUrl),
    ]);

    this._pipelines = {
      decode:      createComputePipeline(acescct,     'main_decode', 'acescct-decode'),
      encode:      createComputePipeline(acescct,     'main_encode', 'acescct-encode'),
      adjust:      createComputePipeline(adjust,      'main',        'wb-exposure'),
      lut:         createComputePipeline(lut,         'main',        'lut-3d'),
      colormatrix:   createComputePipeline(colormatrix, 'main',      'color-matrix'),
      // Only the ProPhoto tone-curve entry point is used (the desktop's no-LUT
      // display render); the module's `main`/`main_srgb` variants are legacy.
      tonecurveProphoto: createComputePipeline(tonecurve, 'main_prophoto', 'tone-curve-prophoto'),
      postgain:      createComputePipeline(postgain,    'main',      'post-gain'),
      saturation:    createComputePipeline(saturation,  'main',      'saturation'),
    };
    await this._effects.init();
    // Grain tiles are optional — a fetch failure just disables grain.
    try { await this._effects.loadGrainTiles(GRAIN_TILE_URLS); }
    catch (e) { console.warn('[processor] grain tile load failed:', e); }

    this._ready = true;
    console.log('[processor] Pipelines ready.');
    return true;
  }

  // ── Intermediate / scratch buffer management ──────────────────────────────

  /** Lazily get/create a pair of scratch buffers for an element count. */
  _scratchFor(count) {
    let s = this._scratch.get(count);
    if (!s) {
      const bytes = count * 4;
      s = { a: createEmptyBuffer(bytes, STORAGE_RW), b: createEmptyBuffer(bytes, STORAGE_RW) };
      this._scratch.set(count, s);
    }
    return s;
  }

  /**
   * Provide a finished ACEScct intermediate (full resolution).
   * Uploads it to a persistent GPU buffer and prepares a downscaled copy for
   * responsive slider previews.
   *
   * @param {Float32Array} acescct  Flat RGB, stride 3, length w*h*3
   * @param {number} width
   * @param {number} height
   */
  setIntermediate(acescct, width, height) {
    this._freeIntermediate();

    this.intermediateAcescct = acescct;
    this.width  = width;
    this.height = height;

    const count = width * height * 3;
    this._full = {
      buf:   createF32Buffer(acescct, STORAGE_RW),
      w: width, h: height, count,
    };

    // Downscaled intermediate (÷3 box filter) for fast scrubbing.
    const dw = Math.max(1, Math.floor(width / 3));
    const dh = Math.max(1, Math.floor(height / 3));
    const small = downsampleRGB(acescct, width, height, dw, dh);
    this._small = {
      buf:   createF32Buffer(small, STORAGE_RW),
      w: dw, h: dh, count: dw * dh * 3,
    };
  }

  _freeIntermediate() {
    this._full?.buf?.destroy();
    this._small?.buf?.destroy();
    this._full = this._small = null;
    for (const { a, b } of this._scratch.values()) { a.destroy(); b.destroy(); }
    this._scratch.clear();
    for (const buf of this._pool.values()) buf.destroy();
    this._pool.clear();
  }

  // ── Load: decoded image → intermediate → first preview ────────────────────
  // (All callers decode via main.js decodeSource() — which routes JPEG/PNG to
  //  the image decoder and passes the per-photo Auto WB — then hand the result
  //  to loadDecoded. The old loadImage(buffer) wrapper is gone.)

  /**
   * Load an already-decoded image (e.g. from the photo strip's pixel cache —
   * skips the slow libraw step entirely).
   * @param {{ pixels:Float32Array, width:number, height:number,
   *           ccm:number[], isFlashback:boolean, metadata?:object }} decoded
   * @param {string} filename
   * @param {ArrayBuffer|null} [origBuffer]  original file bytes (full-res export)
   * @returns {Promise<ImageData|null>}
   */
  async loadDecoded(decoded, filename, origBuffer = null) {
    if (!this._ready) throw new Error('[processor] loadDecoded() before init()');

    this.currentFile  = filename;
    this._origBuffer  = origBuffer;   // retained for full-resolution re-decode at export
    this._rotation    = 0;
    this._isFlashback = Boolean(decoded.isFlashback);
    // Finished images (JPEG/PNG): already developed + display-referred, so the
    // render skips the film LUT and base-exposure shaping (effects-only path).
    this._isPhoto = Boolean(decoded.isPhoto);
    // Reverse-AE: the One35's AE decision is its shutter time; t_ref/t is the
    // gain that undoes it. Flashback files only (matching upstream).
    this._revGain = (this._isFlashback && decoded.exposureS > 0)
      ? REVERSE_AE_T_REF / decoded.exposureS
      : 1;
    this._dateTaken = decoded.dateTaken ?? null;

    const { pixels, width, height, ccm, isFlashback, metadata } = decoded;
    console.log(
      `[processor] Loaded ${filename}: ${width}×${height}, ` +
      `${isFlashback ? 'Flashback' : (metadata?.camera_make ?? 'generic')} profile`
    );

    // One locked unit: preprocess (which frees + rebuilds buffers) then render,
    // so a render from the previous photo can't be reading buffers as we free them.
    return this._locked(async () => {
      await this.preprocess(pixels, width, height, this._ccmFor(ccm));
      return this._render(this._full, {});
    });
  }

  /**
   * The to-ACEScg matrix to use. Colour is now FIXED (matches the desktop app,
   * which applies one calibrated neutral + ForwardMatrix to every shot), so the
   * decoder's matrix is used as-is — RAW_TO_ACESCG for Flashback, LINSRGB for
   * generic. The Auto WB toggle no longer alters colour.
   */
  _ccmFor(perFileCcm) { return perFileCcm; }

  // ── Preprocess: linear sensor RGB → ACEScct intermediate ──────────────────

  /**
   * Convert decoded linear RGB to the ACEScct intermediate on the GPU.
   * Applies the to-ACEScg matrix → highlight desaturation → ACEScct encode.
   *
   * @param {Float32Array} linearRGB  Flat RGB, stride 3, length w*h*3, linear sensor space
   * @param {number} width
   * @param {number} height
   * @param {number[]} [ccm]  3×3 row-major CCM (defaults to FLASHBACK_CCM)
   * @returns {Promise<void>}  Result stored as the intermediate (see setIntermediate)
   */
  async preprocess(linearRGB, width, height, ccm = RAW_TO_ACESCG) {
    if (!this._ready) throw new Error('[processor] preprocess() before init()');
    const acescct = await this._encodeAcescct(linearRGB, width, height, ccm);
    this.setIntermediate(acescct, width, height);
  }

  /**
   * Linear sensor RGB → ACEScct (CCM → Rec.2020 → base exposure → desat →
   * encode), returned as a CPU Float32Array. Shared by preprocess() (which then
   * stores it as the interactive intermediate) and the full-res export path
   * (which renders it once and throws it away). All GPU scratch is freed here.
   * @returns {Promise<Float32Array>}
   */
  async _encodeAcescct(linearRGB, width, height, ccm = RAW_TO_ACESCG) {
    const count = width * height * 3;
    const inBuf  = createF32Buffer(linearRGB, STORAGE_RW);
    const tmpBuf = createEmptyBuffer(count * 4, STORAGE_RW);
    const outBuf = createEmptyBuffer(count * 4, STORAGE_RW);

    // The decoder hands us the full to-ACEScg matrix (RAW_TO_ACESCG for
    // Flashback raws, LINSRGB_TO_ACESCG for generic ones). Scale is 1 — the
    // exposure lift happens at render time, like upstream.
    const M = ccm;
    const mtxUniform = createUniformBuffer(new Float32Array([
      M[0], M[1], M[2], 0,
      M[3], M[4], M[5], 0,
      M[6], M[7], M[8], 0,
      1, 0, 0, 0,
    ]));

    // colormatrix is per-pixel (wgSize 64); encode is per-element (wgSize 256).
    const pxDispatch  = dispatchSize(width * height, 64);
    const elDispatch  = dispatchSize(count, 256);

    runCompute(this._pipelines.colormatrix, [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: tmpBuf } },
      { binding: 2, resource: { buffer: mtxUniform } },
    ], pxDispatch);

    // No highlight desaturation here: upstream v2 dropped that pass (its
    // pre-v2 Lab desat was replaced by raw-domain highlight recovery), and
    // baking it in muted highlight colour through BOTH display paths.

    runCompute(this._pipelines.encode, [
      { binding: 0, resource: { buffer: tmpBuf } },
      { binding: 1, resource: { buffer: outBuf } },
    ], elDispatch);

    const acescct = await readbackF32(outBuf, count);

    inBuf.destroy(); tmpBuf.destroy(); outBuf.destroy(); mtxUniform.destroy();
    return acescct;
  }

  // ── Render: ACEScct intermediate → ImageData ─────────────────────────────

  /**
   * Render a preview from the cached intermediate.
   * @param {{ downscale?: boolean }} [opts]
   * @returns {Promise<ImageData|null>}
   */
  async renderPreview(opts = {}) {
    const src = opts.downscale ? this._small : this._full;
    // The downscaled scrub intermediate is ÷3 the full size, so spatial effects
    // (halation/bloom/grain/CA blur radii are in PIXELS) must be scaled by the
    // same ratio or they render ~3× too large during a drag and then snap to the
    // correct size on the full idle pass — most visible on halation's wide radii.
    const scale = (opts.downscale && this.width && src) ? (src.w / this.width) : 1;
    return this._locked(() => this._render(src, { original: Boolean(opts.original), scale }));
  }

  /**
   * Render the cached (preview-size) intermediate at quality settings.
   * @param {{ raw?: boolean }} [opts]  raw:true → { rgb:Float32Array, width, height }
   *   (linear-display floats in 0..1, for 16-bit TIFF); otherwise ImageData.
   */
  async renderExport(opts = {}) {
    return this._locked(() => this._render(this._full, { raw: Boolean(opts.raw) }));
  }

  /**
   * Full-resolution export. Re-decodes the original file at full size, replays
   * the user's rotations, runs the pipeline once, then frees the (large) full-res
   * buffers. On any failure it transparently falls back to the preview-size
   * render — so an export can never crash or hang the app.
   *
   * Sets `this._lastExportFullRes` so the caller can tell the user which they got.
   * @param {{ raw?: boolean }} [opts]
   * @returns {Promise<ImageData | {rgb:Float32Array,width:number,height:number} | null>}
   */
  async renderExportFull(opts = {}) {
    this._lastExportFullRes = false;
    if (!this._ready || !this._origBuffer) return this.renderExport(opts);
    // Finished images: the resident intermediate already IS the full decode
    // (the image decoder doesn't half-size), and LibRaw can't re-decode a JPEG.
    // Render the resident buffer directly.
    if (this._isPhoto) { this._lastExportFullRes = true; return this.renderExport(opts); }

    return this._locked(async () => {
      let buf = null;
      let count = 0;
      try {
        // 1. Decode the original at full resolution.
        const dec = await this._decoder.decode(this._origBuffer, { full: true, cameraWb: this.cameraWb });
        let px = dec.pixels, w = dec.width, h = dec.height;

        // Guard: if a full-res float buffer would exceed what this GPU can BIND,
        // the pipeline's storage bindings are invalid and the render comes back
        // BLACK (a non-throwing validation error — it won't hit the catch below).
        // Bail to the resident-size render instead of producing a black export.
        const fullResBytes = w * h * 3 * 4;
        const bindLimit = maxStorageBindingSize();
        if (bindLimit && fullResBytes > bindLimit) {
          console.warn(
            `[processor] full-res buffer ${(fullResBytes / 1048576) | 0} MiB exceeds GPU bind limit ` +
            `${(bindLimit / 1048576) | 0} MiB — exporting at resident size.`,
          );
          return this._render(this._full, { raw: Boolean(opts.raw) });
        }

        // 2. Replay the user's 90° rotations onto the fresh full-res pixels.
        const turns = ((this._rotation % 4) + 4) % 4;
        for (let i = 0; i < turns; i++) {
          px = rotate90RGB(px, w, h, true);
          const t = w; w = h; h = t;
        }

        // 3. Colour pipeline → ACEScct (temporary — does NOT touch interactive state).
        let acescct = await this._encodeAcescct(px, w, h, this._ccmFor(dec.ccm));
        px = null; // allow the full-res linear buffer to be reclaimed

        // 4. Upload + run the render passes at full resolution. `scale` keeps the
        //    spatial effects (blur radii, grain) visually matched to the preview.
        count = w * h * 3;
        buf = createF32Buffer(acescct, STORAGE_RW);
        acescct = null;
        const scale = this.width ? w / this.width : 1;
        const result = await this._render({ buf, w, h, count }, { raw: Boolean(opts.raw), scale });

        this._lastExportFullRes = true;
        return result;
      } catch (err) {
        console.warn('[processor] full-res export failed — using preview size:', err);
        return this._render(this._full, { raw: Boolean(opts.raw) });   // unlocked fallback (already inside the lock)
      } finally {
        // Reclaim the large full-res GPU buffers so the next action doesn't OOM.
        buf?.destroy();
        if (count) this._freeBuffersForCount(count);
      }
    });
  }

  /**
   * Tiled full-resolution export — bounds peak GPU memory by processing the
   * frame in horizontal strips instead of one ~1.4 GB allocation (which crashes
   * iOS Safari's per-tab budget). Each strip is rendered with a vertical apron
   * so blur-based effects (halation, softness, sharpen, CA, CNR) have the context
   * they need, then the apron is cropped and the core rows are stitched into a
   * full CPU output. Bloom — whose blur spans the whole frame — is computed once
   * as a global low-res buffer and added per strip. Falls back to the resident
   * render on any failure, so an export can never crash.
   * @param {{ raw?: boolean }} [opts]
   * @returns {Promise<ImageData | {rgb:Float32Array,width:number,height:number} | null>}
   */
  async renderExportTiled(opts = {}) {
    this._lastExportFullRes = false;
    if (!this._ready || !this._origBuffer || this._isPhoto) return this.renderExportFull(opts);

    return this._locked(async () => {
      const raw = Boolean(opts.raw);
      let glowBuf = null;
      let halGlowBuf = null;
      let prevCount = null;
      try {
        // 1. Decode the original at full resolution + replay rotations (CPU).
        const dec = await this._decoder.decode(this._origBuffer, { full: true, cameraWb: this.cameraWb });
        let px = dec.pixels, w = dec.width, h = dec.height;
        const turns = ((this._rotation % 4) + 4) % 4;
        for (let i = 0; i < turns; i++) { px = rotate90RGB(px, w, h, true); const t = w; w = h; h = t; }
        const ccm = this._ccmFor(dec.ccm);
        const scale = this.width ? (w / this.width) : 1;
        const cfg = this.config ?? {};

        // 2. Render params for the global bloom source (must match _render's
        //    adjust so the tiled bloom lands where the untiled bloom would).
        const lutEnabled = (cfg.enable_lut ?? true) && this.gpuLut &&
          !(this._isPhoto && this.gpuLut?.inputSpace !== 'srgb');
        const filmLook = lutEnabled && this.gpuLut?.inputSpace !== 'srgb';
        const us = this.userSettings;
        const baseLift = filmLook ? (cfg.base_lift_ev ?? RENDER_LIFT_EV) : 0;
        const revEv = (filmLook && (cfg.enable_reverse_autoexposure ?? false) &&
          this._revGain > 0 && this._revGain !== 1)
          ? REVERSE_AE_STRENGTH * Math.log2(this._revGain) : 0;
        const tempFactor = (us.wb_temp ?? 0) / 1000;

        // 3. Global low-res pre-passes for the two whole-frame-reach effects:
        //    halation (~240px blur) and bloom (~frame/20 blur). Both are computed
        //    ONCE on a 1/4-res adjusted-linear frame and added per strip, so
        //    neither needs a per-strip apron — that's what keeps the export fast
        //    (the apron below covers only the small-radius effects). Heavily
        //    blurred, so low-res is visually identical (verified vs single-pass).
        const bloomOn = cfg.enable_bloom && (cfg.bloom_strength ?? 0) > 0;
        const halOn   = cfg.enable_halation && (cfg.halation_strength ?? 0) > 0;
        let bloomGlowSmall = null, halationGlowSmall = null;
        if (bloomOn || halOn) {
          const sw = Math.max(1, Math.ceil(w / 4));
          const sh = Math.max(1, Math.ceil(h / 4));
          const sCount = sw * sh * 3;
          const smallLinear = downsampleRGB(px, w, h, sw, sh);
          const smallAcescct = await this._encodeAcescct(smallLinear, sw, sh, ccm);
          const sAce = createF32Buffer(smallAcescct, STORAGE_RW);
          const sA = createEmptyBuffer(sCount * 4, STORAGE_RW);
          const sB = createEmptyBuffer(sCount * 4, STORAGE_RW);
          const elS = dispatchSize(sCount, 256);
          runCompute(this._pipelines.decode, [
            { binding: 0, resource: { buffer: sAce } },
            { binding: 1, resource: { buffer: sA } },
          ], elS);
          const adjU = createUniformBuffer(new Float32Array([
            1.0 + tempFactor * 0.15, 1.0 - (us.tint ?? 0) * 0.015, 1.0 - tempFactor * 0.15,
            Math.pow(2, (us.exposure_ev ?? 0) + baseLift + revEv),
          ]));
          runCompute(this._pipelines.adjust, [
            { binding: 0, resource: { buffer: sA } },
            { binding: 1, resource: { buffer: sB } },
            { binding: 2, resource: { buffer: adjU } },
          ], elS);
          adjU.destroy();

          if (halOn) {
            // Same total EV the per-strip render applies, so the scene-referred
            // threshold matches; ÷4 because the glow is built at 1/4 res.
            const appliedEv = (us.exposure_ev ?? 0) + baseLift + revEv;
            halGlowBuf = this._effects.buildHalationGlowSmall(sB, sw, sh, cfg, appliedEv, scale / 4);
            if (halGlowBuf) halationGlowSmall = { buf: halGlowBuf, w: sw, h: sh };
          }
          if (bloomOn) {
            glowBuf = createEmptyBuffer(sCount * 4, STORAGE_RW);
            const glowTmp = createEmptyBuffer(sCount * 4, STORAGE_RW);
            this._effects.buildBloomGlowSmall(sB, sw, sh, cfg, glowBuf, glowTmp);
            glowTmp.destroy();
            bloomGlowSmall = { buf: glowBuf, w: sw, h: sh };
          }
          sAce.destroy(); sA.destroy(); sB.destroy();
        }

        // 4. Apron = the largest vertical reach of the remaining per-strip blur
        //    effects (halation + bloom are global now, so they're excluded).
        const softR = Math.ceil((cfg.softness_sigma ?? 0) * scale * 3);
        const shpR  = Math.ceil(Math.max(0.3, cfg.sharpen_radius ?? 1) * scale * 3);
        const caR   = Math.ceil((h * 0.5) * (cfg.ca_strength ?? 0)) + 2;
        const APRON = Math.max(softR, shpR, caR, 4) + 8;

        // 5. Strip height from a peak-memory budget (~10 strip-size buffers live).
        const TARGET = 384 * 1024 * 1024, BUFS = 10;
        const maxRows = Math.floor(TARGET / (BUFS * w * 12));
        const STRIP_H = Math.max(32, maxRows - 2 * APRON);

        // 6. CPU output (interleaved). raw → float RGB; else RGBA8.
        const out = raw ? new Float32Array(w * h * 3) : new Uint8ClampedArray(w * h * 4);

        for (let y0 = 0; y0 < h; y0 += STRIP_H) {
          const y1 = Math.min(h, y0 + STRIP_H);
          const a0 = Math.max(0, y0 - APRON);
          const a1 = Math.min(h, y1 + APRON);
          const rows = a1 - a0;
          const count = rows * w * 3;
          if (prevCount !== null && prevCount !== count) {
            this._freeBuffersForCount(prevCount);   // keep only one strip-count's buffers alive
          }

          // Strip linear rows are contiguous in the interleaved buffer.
          const stripLinear = px.subarray(a0 * w * 3, a1 * w * 3);
          const stripAcescct = await this._encodeAcescct(stripLinear, w, rows, ccm);
          const srcBuf = createF32Buffer(stripAcescct, STORAGE_RW);
          const region = { yOffset: a0, fullH: h };
          const result = await this._render(
            { buf: srcBuf, w, h: rows, count },
            { raw, scale, region, bloomGlowSmall, halationGlowSmall },
          );
          srcBuf.destroy();

          // Crop the apron; copy the core rows [y0,y1) into the full output.
          const coreStart = y0 - a0;
          if (raw) {
            out.set(result.rgb.subarray(coreStart * w * 3, (coreStart + (y1 - y0)) * w * 3), y0 * w * 3);
          } else {
            out.set(result.data.subarray(coreStart * w * 4, (coreStart + (y1 - y0)) * w * 4), y0 * w * 4);
          }
          prevCount = count;
        }
        if (prevCount !== null) this._freeBuffersForCount(prevCount);

        this._lastExportFullRes = true;
        return raw ? { rgb: out, width: w, height: h } : new ImageData(out, w, h);
      } catch (err) {
        console.warn('[processor] tiled export failed — using preview size:', err);
        return this._render(this._full, { raw: Boolean(opts.raw) });
      } finally {
        glowBuf?.destroy();
        halGlowBuf?.destroy();
        if (prevCount) this._freeBuffersForCount(prevCount);
      }
    });
  }

  /** Destroy + drop cached scratch/pool buffers for a given element count. */
  _freeBuffersForCount(count) {
    const s = this._scratch.get(count);
    if (s) { s.a.destroy(); s.b.destroy(); this._scratch.delete(count); }
    for (const [id, buf] of this._pool) {
      if (id.endsWith(`:${count}`)) { buf.destroy(); this._pool.delete(id); }
    }
  }

  /**
   * Core render: decode → WB/exposure → encode → LUT → effects → output.
   * @param {{buf:GPUBuffer,w:number,h:number,count:number}|null} src
   * @param {{ raw?: boolean }} [opts]
   * @returns {Promise<ImageData | {rgb:Float32Array,width:number,height:number} | null>}
   */
  async _render(src, opts = {}) {
    if (!this._ready || !src) return null;
    const { buf: srcBuf, w, h, count } = src;
    const { a, b } = this._scratchFor(count);

    const elDispatch = dispatchSize(count, 256);
    const pxDispatch = dispatchSize(w * h, 64);

    // 1. ACEScct → linear ACEScg
    runCompute(this._pipelines.decode, [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: a } },
    ], elDispatch);

    // "Before" view (press-and-hold compare): the neutral camera rendering —
    // no film LUT, no effects, no user adjustments. Same tone-curve path as
    // the Natural vibe, just with everything zeroed.
    const original = Boolean(opts.original);
    const lutEnabled = !original && (this.config?.enable_lut ?? true) && this.gpuLut;
    // Finished images (JPEG/PNG) go through the SAME pipeline as a generic RAW:
    // the linearised image is treated as scene-referred so the film looks (LUT +
    // base lift + optical effects) grade it best-effort, which is what users
    // expect when applying a "look" to a photo. (_isPhoto still routes export to
    // the resident render, since LibRaw can't re-decode a JPEG at full size.)
    // Imported "Photo LUTs" are authored for a display-referred sRGB/Rec.709
    // image, not our ACEScct intermediate. They get the Natural display render
    // as input (see the display branch below) and NONE of the film-LUT exposure
    // shaping (base lift / reverse-AE / push) — the LUT grades a finished image.
    const srgbLut = lutEnabled && this.gpuLut.inputSpace === 'srgb';

    // 2. White balance + exposure in linear ACEScg.
    //
    //    The +2 EV base lift, reverse-AE, and push/pull are all part of the
    //    FILM rendering — the LUTs were trained against the lifted level and
    //    these shape film density. The NATURAL path (no LUT) gets NONE of
    //    them: it shows the developed raw at its metered exposure with only
    //    the user's own EXP/WB/tint, so "Natural" is literally the developed
    //    DNG. (Before, the unconditional +2 EV blew Natural out and the extra
    //    clipping is what tinted highlights magenta.)
    const { exposure_ev, wb_temp, tint, push_pull_ev = 0 } = original
      ? { exposure_ev: 0, wb_temp: 0, tint: 0, push_pull_ev: 0 }
      : this.userSettings;
    const filmLook = lutEnabled && !srgbLut;
    // Per-vibe base exposure lift (upstream base_exposure_offset_v2). Most looks
    // use +2 EV; the Flashback V1 look uses 0 (its LUT is trained for that).
    const baseLift = filmLook ? (this.config?.base_lift_ev ?? RENDER_LIFT_EV) : 0;
    // Pre-pipeline EV shift (film only) = partial reverse-AE, undone post so it
    // changes film density, not brightness. ADVANCED + off by default upstream
    // (enable_reverse_autoexposure=False), so it stays gated — the desktop
    // reference exports we calibrate against have no reverse-AE applied.
    const revEv = (filmLook && (this.config?.enable_reverse_autoexposure ?? false)
                   && this._revGain > 0 && this._revGain !== 1)
      ? REVERSE_AE_STRENGTH * Math.log2(this._revGain)
      : 0;
    const preLutEv = revEv;
    // Push/Pull → display-space S-curve (push) / fade (pull) in the final pass,
    // on every look. push_pull_ev ∈ [-2,2] → k ∈ [-1,1].
    // base_push_ev: per-preset default contrast offset (compensates libraw-wasm
    // lighter shadow decode vs rawpy). Additive with the user's push_pull slider.
    const basePushEv = (filmLook && !original) ? (this.config?.base_push_ev ?? 0) : 0;
    const pushK = (push_pull_ev + basePushEv) / 2;
    const kBBoost = (filmLook && !original) ? (this.config?.b_push_boost ?? 0) : 0;
    const tempFactor = wb_temp / 1000.0;
    const adjUniform = createUniformBuffer(new Float32Array([
      1.0 + tempFactor * 0.15,                            // r_mult
      1.0 - tint * 0.015,                                 // g_mult
      1.0 - tempFactor * 0.15,                            // b_mult
      Math.pow(2, exposure_ev + baseLift + preLutEv),     // exposure
    ]));
    runCompute(this._pipelines.adjust, [
      { binding: 0, resource: { buffer: a } },
      { binding: 1, resource: { buffer: b } },
      { binding: 2, resource: { buffer: adjUniform } },
    ], elDispatch);

    // 2b. Pre-LUT linear effects (halation → vignette → bloom), in ACEScg —
    //     matches the desktop, which runs these BEFORE the LUT. Doing so is what
    //     keeps Monochrome neutral (the LUT desaturates the warm halation glow)
    //     and stops bloom from washing the frame (the tone curve rolls it off).
    //     Skipped for the "before" compare view.
    let lit = b;
    if (!original) {
      lit = this._effects.applyPreLut(
        b, w, h, count, this.config,
        (key, cnt) => this._poolBuf(key, cnt),
        opts.scale ?? 1,
        // Total EV already applied to this buffer (base lift + user exposure +
        // reverse-AE) so halation's threshold can stay scene-referred like desktop.
        exposure_ev + baseLift + preLutEv,
        // Tiled full-res export passes the strip's region + pre-built global
        // bloom/halation buffers; all null for the normal single-pass render.
        opts.region ?? null,
        opts.bloomGlowSmall ?? null,
        opts.halationGlowSmall ?? null,
        // The user's crop, so the vignette follows the final frame.
        this.cropRect,
      );
    }

    // 3+4. Display rendering. Film look: re-encode to ACEScct (the LUT's input
    // space) → 3D LUT → display RGB. Neutral (no LUT): the profile tone curve
    // maps linear → display directly — never show raw ACEScct log data, which
    // looks washed-out and flat.
    let finalBuf;
    if (lutEnabled) {
      // LUT input space: native LUTs read ACEScct-encoded ACEScg; imported sRGB
      // "Photo LUTs" read the Natural display render (linear ACEScg → ProPhoto →
      // tone curve → sRGB) so a standard creative LUT grades a finished image and
      // behaves as the user expects. Both then feed the display-referred chain.
      if (srgbLut) {
        runCompute(this._pipelines.tonecurveProphoto, [
          { binding: 0, resource: { buffer: lit } },
          { binding: 1, resource: { buffer: a } },
        ], pxDispatch);
      } else {
        runCompute(this._pipelines.encode, [
          { binding: 0, resource: { buffer: lit } },
          { binding: 1, resource: { buffer: a } },
        ], elDispatch);
      }
      const lutUniform = createU32Uniform([w, h, this.gpuLut.size, 0]);
      runCompute(this._pipelines.lut, [
        { binding: 0, resource: { buffer: a } },
        { binding: 1, resource: { buffer: this.gpuLut.buffer } },
        { binding: 2, resource: { buffer: b } },
        { binding: 3, resource: { buffer: lutUniform } },
      ], pxDispatch);
      finalBuf = b;
      lutUniform.destroy();
    } else {
      // Neutral path (Natural / compare): the desktop's no-LUT render — ACEScg
      // → ProPhoto → v2 PROFILE_TONE_CURVE → linear sRGB → sRGB OETF. The tone
      // curve runs in ProPhoto's wide gamut so highlights roll off gently. This
      // is the "v2 profile" look; matching the 5 LUT looks pins down the shared
      // base, and Natural is that base through this known curve.
      runCompute(this._pipelines.tonecurveProphoto, [
        { binding: 0, resource: { buffer: lit } },
        { binding: 1, resource: { buffer: a } },
      ], pxDispatch);
      finalBuf = a;
    }
    adjUniform.destroy();

    // 4b. Post-LUT display calibration — small per-profile diagonal matrix that
    //     corrects for the systematic libraw-wasm vs rawpy R/B excess. Each LUT
    //     amplifies the error differently; the Natural path also needs correction
    //     since DISPLAY_CAL is now calibrated for it too (natural:[0.965,1,0.96]).
    //     Skipped for the "before" view and when all scales are ~1.0.
    if (!original) {
      const calR = this.config?.display_cal_r ?? 1;
      const calG = this.config?.display_cal_g ?? 1;
      const calB = this.config?.display_cal_b ?? 1;
      if (Math.abs(calR - 1) > 0.001 || Math.abs(calG - 1) > 0.001 || Math.abs(calB - 1) > 0.001) {
        const calUniform = createUniformBuffer(new Float32Array([
          calR, 0, 0, 0,
          0, calG, 0, 0,
          0, 0, calB, 0,
          1, 0, 0, 0,   // scalar scale = 1 (the matrix already carries the scale)
        ]));
        const calOut = finalBuf === a ? b : a;
        runCompute(this._pipelines.colormatrix, [
          { binding: 0, resource: { buffer: finalBuf } },
          { binding: 1, resource: { buffer: calOut } },
          { binding: 2, resource: { buffer: calUniform } },
        ], pxDispatch);
        calUniform.destroy();
        finalBuf = calOut;
      }
    }

    // 5. Live film effects (display-referred): CA → halation → bloom →
    //    softness → sharpen → vignette → grain. Returns the buffer holding
    //    the final result (reuses pooled work buffers). `scale` (>1 at full-res
    //    export) keeps spatial effects matched to what the preview showed.
    //    Skipped for the "before" compare view.
    if (!original) {
      finalBuf = this._effects.applyLive(
        finalBuf, w, h, count, this.config,
        (key, cnt) => this._poolBuf(key, cnt),
        opts.scale ?? 1,
        opts.region ?? null,
      );
    }

    // 6. Final display-space pass: undo the reverse-AE shift (film) AND apply
    //    the Push/Pull contrast. Runs whenever either is active.
    if (preLutEv !== 0 || Math.abs(pushK) > 1e-4) {
      const pgUniform = createUniformBuffer(new Float32Array([
        Math.pow(2, -preLutEv), pushK, kBBoost, 0,
      ]));
      const pgOut = finalBuf === a ? b : a;
      runCompute(this._pipelines.postgain, [
        { binding: 0, resource: { buffer: finalBuf } },
        { binding: 1, resource: { buffer: pgOut } },
        { binding: 2, resource: { buffer: pgUniform } },
      ], elDispatch);
      pgUniform.destroy();
      finalBuf = pgOut;
    }

    // 6b. Saturation (display space, per-pixel) when not neutral.
    if (!original && Math.abs(this.saturation - 1) > 1e-3) {
      const satUniform = createUniformBuffer(new Float32Array([this.saturation, 0, 0, 0]));
      const satOut = finalBuf === a ? b : a;
      runCompute(this._pipelines.saturation, [
        { binding: 0, resource: { buffer: finalBuf } },
        { binding: 1, resource: { buffer: satOut } },
        { binding: 2, resource: { buffer: satUniform } },
      ], pxDispatch);
      satUniform.destroy();
      finalBuf = satOut;
    }

    // 7. Readback → float RGB (raw, for 16-bit export) or RGBA8 ImageData.
    const rgb = await readbackF32(finalBuf, count);
    if (opts.raw) return { rgb, width: w, height: h };
    return rgbToImageData(rgb, w, h);
  }

  // ── Rotation (operates on the CPU intermediate, then re-uploads) ──────────

  /** Rotate the intermediate 90° clockwise and re-upload. */
  rotateClockwise()        { return this._locked(async () => this._rotate(true)); }
  /** Rotate the intermediate 90° counter-clockwise and re-upload. */
  rotateCounterClockwise() { return this._locked(async () => this._rotate(false)); }

  _rotate(clockwise) {
    if (!this.intermediateAcescct) return;
    const rotated = rotate90RGB(this.intermediateAcescct, this.width, this.height, clockwise);
    this.setIntermediate(rotated, this.height, this.width);
    // Track net rotation so a full-res export reproduces the same orientation.
    this._rotation = (this._rotation + (clockwise ? 1 : -1)) % 4;
  }

  /** Release all GPU resources held by this processor. */
  dispose() {
    this._freeIntermediate();
    this._effects?.dispose();
    this.intermediateAcescct = null;
    this._origBuffer = null;
  }
}

// ─── Helpers (CPU) ────────────────────────────────────────────────────────

/** Box-downsample interleaved RGB from (sw×sh) to (dw×dh). */
function downsampleRGB(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh * 3);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.min(sh, Math.floor((dy + 1) * yRatio));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.min(sw, Math.floor((dx + 1) * xRatio));
      let r = 0, g = 0, bb = 0, n = 0;
      for (let sy = sy0; sy < Math.max(sy0 + 1, sy1); sy++) {
        for (let sx = sx0; sx < Math.max(sx0 + 1, sx1); sx++) {
          const si = (sy * sw + sx) * 3;
          r += src[si]; g += src[si + 1]; bb += src[si + 2]; n++;
        }
      }
      const di = (dy * dw + dx) * 3;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = bb / n;
    }
  }
  return out;
}

/** Rotate interleaved RGB 90°. Returns a new array; dims swap (w↔h). */
function rotate90RGB(src, w, h, clockwise) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 3;
      let nx, ny;
      if (clockwise) { nx = h - 1 - y; ny = x; }
      else           { nx = y;         ny = w - 1 - x; }
      const di = (ny * h + nx) * 3;   // new width = h
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2];
    }
  }
  return out;
}

// Ordered Bayer 8×8 dither offsets, in units of one 8-bit step, range ≈ ±0.5.
// Quantising float→8-bit with a ±0.5-LSB ordered offset is the correct way to
// round and removes visible banding in smooth gradients (skies). Deterministic
// per pixel position, so it doesn't shimmer between renders.
const BAYER8 = (() => {
  const M = [
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const out = new Float32Array(64);
  for (let i = 0; i < 64; i++) out[i] = (M[i] + 0.5) / 64 - 0.5;
  return out;
})();

/** Convert interleaved float RGB [0,1] to an RGBA8 ImageData (ordered dither). */
function rgbToImageData(rgb, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, s = 0, d = 0; y < h; y++) {
    const row = (y & 7) * 8;
    for (let x = 0; x < w; x++, s += 3, d += 4) {
      const dither = BAYER8[row + (x & 7)];
      // Uint8ClampedArray rounds-to-nearest and clamps on assignment.
      rgba[d]     = rgb[s]     * 255 + dither;
      rgba[d + 1] = rgb[s + 1] * 255 + dither;
      rgba[d + 2] = rgb[s + 2] * 255 + dither;
      rgba[d + 3] = 255;
    }
  }
  return new ImageData(rgba, w, h);
}
