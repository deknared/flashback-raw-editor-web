/**
 * effects.js — GPU film-effect orchestrator (Phase 4, Refinement D).
 *
 * This is NOT a CPU math library. The target is iOS 26+ with WebGPU, so the
 * effects run as compute passes on the GPU. The `Effects` class owns the
 * effect pipelines and the grain tile, and exposes:
 *
 *   applyPreLut(srcBuf, w, h, count, config, getBuf)
 *       Pre-LUT, linear-ACEScg chain (halation → vignette → bloom). Run BEFORE
 *       the LUT so the LUT can desaturate/roll-off the glow (matches desktop).
 *
 *   applyLive(srcBuf, w, h, count, config, getBuf)
 *       Post-LUT, display-referred chain (CA → softness → sharpen → grain).
 *       Returns the GPUBuffer holding the result.
 *
 *   applyHighlightDesat(buf, count, config)
 *       Baked, in-place, linear-light highlight desaturation (Refinement E),
 *       called from the processor's preprocess() before the ACEScct encode.
 *
 * Buffers are supplied by the caller via `getBuf(key, count)` so we reuse a
 * small pool instead of allocating per frame (Refinement I). The grain tile is
 * uploaded once and cached.
 */

import {
  isAvailable, loadShaderModule, createComputePipeline,
  createF32Buffer, createUniformBuffer, createU32Uniform, runCompute, dispatchSize,
} from './gpu.js';

import {
  GRAIN_TILE_SCALE, GRAIN_HIGHLIGHT_BIAS, GRAIN_BLUR_SIGMA,
  CNR_SIGMA_SPACE, CNR_SIGMA_COLOR, CNR_RADIUS, CNR_THR_GREEN, CNR_THR_OTHER,
  HALATION_SCALES, HALATION_WARMTH_PCT,
} from './config.js';

import caUrl             from '../shaders/chromatic_aberration.wgsl?url';
import vignetteUrl       from '../shaders/vignette.wgsl?url';
import highlightsUrl     from '../shaders/highlights.wgsl?url';
import bloomSmallUrl     from '../shaders/bloom_small.wgsl?url';
import highlightDesatUrl from '../shaders/highlight_desat.wgsl?url';
import grainSampleUrl    from '../shaders/grain_sample.wgsl?url';
import blurUrl           from '../shaders/gaussian_blur.wgsl?url';
import blendUrl          from '../shaders/blend.wgsl?url';
import grainUrl          from '../shaders/grain.wgsl?url';
import cnrUrl            from '../shaders/cnr.wgsl?url';

const STORAGE_RW = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

/** Build a normalised 1D Gaussian kernel for the given sigma. */
function gaussianKernel(sigma) {
  const s = Math.max(0.05, sigma);
  const radius = Math.max(1, Math.ceil(s * 3));
  const size = radius * 2 + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    k[i] = Math.exp(-(x * x) / (2 * s * s));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

export class Effects {
  constructor() {
    this._ready = false;
    this._pipelines = null;
    /** @type {{buf:GPUBuffer,w:number,h:number}|null} */
    this._grainTile = null;
    /** sigma -> { buf, size } cached gaussian kernels */
    this._kernels = new Map();
  }

  async init() {
    if (this._ready) return true;
    if (!isAvailable()) return false;

    const [ca, vig, hi, bloomSm, hdesat, gsample, blur, blend, grain, cnr] = await Promise.all([
      loadShaderModule(caUrl),
      loadShaderModule(vignetteUrl),
      loadShaderModule(highlightsUrl),
      loadShaderModule(bloomSmallUrl),
      loadShaderModule(highlightDesatUrl),
      loadShaderModule(grainSampleUrl),
      loadShaderModule(blurUrl),
      loadShaderModule(blendUrl),
      loadShaderModule(grainUrl),
      loadShaderModule(cnrUrl),
    ]);

    this._pipelines = {
      ca:           createComputePipeline(ca,         'main',          'fx-ca'),
      vignette:     createComputePipeline(vig,        'main',          'fx-vignette'),
      halation:     createComputePipeline(hi,         'main_halation', 'fx-halation-mask'),
      bloomDown:    createComputePipeline(bloomSm,    'main_down',     'fx-bloom-down'),
      bloomUpadd:   createComputePipeline(bloomSm,    'main_upadd',    'fx-bloom-upadd'),
      desat:        createComputePipeline(hdesat,     'main',          'fx-highlight-desat'),
      gsample:      createComputePipeline(gsample,    'main',          'fx-grain-sample'),
      blurH:        createComputePipeline(blur,       'main_h',        'fx-blur-h'),
      blurV:        createComputePipeline(blur,       'main_v',        'fx-blur-v'),
      add:          createComputePipeline(blend,      'main_add',      'fx-add'),
      unsharp:      createComputePipeline(blend,      'main_unsharp',  'fx-unsharp'),
      grain:        createComputePipeline(grain,      'main',          'fx-grain'),
      cnrToLab:     createComputePipeline(cnr,        'main_to_lab',    'fx-cnr-tolab'),
      cnrDespike:   createComputePipeline(cnr,        'main_despike',   'fx-cnr-despike'),
      cnrBilateral: createComputePipeline(cnr,        'main_bilateral', 'fx-cnr-bilateral'),
      cnrToAcescg:  createComputePipeline(cnr,        'main_to_acescg', 'fx-cnr-toacescg'),
    };
    this._ready = true;
    return true;
  }

  /**
   * Decode a PNG URL to a flat grayscale Float32Array in [0,1].
   * @returns {Promise<{w:number,h:number,gray:Float32Array}|null>}
   */
  async _decodeGray(url) {
    const resp = await fetch(url);
    if (!resp.ok) { console.warn(`[effects] grain tile fetch failed: ${url}`); return null; }
    const blob = await resp.blob();

    // Decode → RGBA pixels. createImageBitmap can intermittently yield a 0×0
    // bitmap during a busy init in some Chromium builds, so fall back to an
    // <img>+canvas decode and retry until we get real dimensions.
    let w = 0, h = 0, data = null;
    for (let attempt = 0; attempt < 3 && !w; attempt++) {
      try {
        const bmp = await createImageBitmap(blob);
        if (bmp.width > 0) {
          w = bmp.width; h = bmp.height;
          const cvs = new OffscreenCanvas(w, h);
          const ctx = cvs.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          data = ctx.getImageData(0, 0, w, h).data;
        }
        bmp.close();
      } catch (e) { /* fall through to retry / <img> path */ }
    }
    if (!w) {
      // Fallback: HTMLImageElement decode (more robust than createImageBitmap).
      const objUrl = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = objUrl;
        await img.decode();
        w = img.naturalWidth; h = img.naturalHeight;
        const cvs = document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        const ctx = cvs.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        data = ctx.getImageData(0, 0, w, h).data;
      } finally { URL.revokeObjectURL(objUrl); }
    }
    if (!w || !data) { console.warn(`[effects] grain tile decode failed: ${url}`); return null; }

    const gray = new Float32Array(w * h);
    for (let p = 0, s = 0; p < gray.length; p++, s += 4) {
      gray[p] = (0.299 * data[s] + 0.587 * data[s + 1] + 0.114 * data[s + 2]) / 255;
    }
    return { w, h, gray };
  }

  /** Load and cache a single grayscale grain tile from a PNG URL. */
  async loadGrainTile(url) {
    const t = await this._decodeGray(url);
    if (!t) return;
    this._grainTile?.buf?.destroy();
    this._grainTile = { buf: createF32Buffer(t.gray, STORAGE_RW), w: t.w, h: t.h };
  }

  /**
   * Load several grain PNGs and pack them into one 2×2 atlas tile. This uses all
   * four of the original's grain characters and quadruples the tile period, so
   * the grain repeats far less visibly across a frame. The grain sampler reads
   * the tile dimensions from a uniform, so a larger tile needs no shader change.
   * Any seam between sub-tiles is invisible (grain is high-frequency noise).
   * Falls back to a single tile (or no grain) if decodes fail.
   * @param {string[]} urls
   */
  async loadGrainTiles(urls) {
    const tiles = (await Promise.all(urls.map((u) => this._decodeGray(u)))).filter(Boolean);
    if (!tiles.length) { console.warn('[effects] no grain tiles decoded'); return; }

    // Use the first tile's dimensions as the sub-tile size; keep only matches.
    const { w, h } = tiles[0];
    const same = tiles.filter((t) => t.w === w && t.h === h);
    if (same.length < 2) {
      // Not enough same-sized tiles to atlas — just use the first.
      this._grainTile?.buf?.destroy();
      this._grainTile = { buf: createF32Buffer(same[0].gray, STORAGE_RW), w, h };
      return;
    }

    // Fill the four quadrants, cycling through whatever tiles we have.
    const quad = [same[0], same[1 % same.length], same[2 % same.length], same[3 % same.length]];
    const AW = w * 2, AH = h * 2;
    const atlas = new Float32Array(AW * AH);
    for (let ay = 0; ay < AH; ay++) {
      const ty = ay < h ? 0 : 1;            // top / bottom row of quadrants
      const ly = ay - ty * h;
      for (let ax = 0; ax < AW; ax++) {
        const tx = ax < w ? 0 : 1;          // left / right column
        const lx = ax - tx * w;
        atlas[ay * AW + ax] = quad[ty * 2 + tx].gray[ly * w + lx];
      }
    }
    this._grainTile?.buf?.destroy();
    this._grainTile = { buf: createF32Buffer(atlas, STORAGE_RW), w: AW, h: AH };
  }

  _kernelFor(sigma) {
    const key = sigma.toFixed(3);
    let k = this._kernels.get(key);
    if (!k) {
      const data = gaussianKernel(sigma);
      k = { buf: createF32Buffer(data, GPUBufferUsage.STORAGE), size: data.length };
      this._kernels.set(key, k);
    }
    return k;
  }

  /** Separable Gaussian blur: src → dst, using `tmp` for the intermediate. */
  _blur(src, dst, tmp, w, h, count, sigma) {
    const k = this._kernelFor(sigma);
    const u = createU32Uniform([w, h, k.size, 3]);
    const px = dispatchSize(w * h, 64);
    runCompute(this._pipelines.blurH, [
      { binding: 0, resource: { buffer: src } },
      { binding: 1, resource: { buffer: k.buf } },
      { binding: 2, resource: { buffer: tmp } },
      { binding: 3, resource: { buffer: u } },
    ], px);
    runCompute(this._pipelines.blurV, [
      { binding: 0, resource: { buffer: tmp } },
      { binding: 1, resource: { buffer: k.buf } },
      { binding: 2, resource: { buffer: dst } },
      { binding: 3, resource: { buffer: u } },
    ], px);
    u.destroy();
  }

  // ── Baked: highlight desaturation (linear light, in place) ────────────────
  applyHighlightDesat(buf, count, config) {
    if (!this._ready || !(config?.enable_highlight_desat)) return;
    // threshold_L / rolloff are Lab L* (0..100); map roughly to a linear luma.
    const thr  = (config.highlight_desat_threshold_L ?? 58) / 100;
    const roll = (config.highlight_desat_rolloff_L ?? 10) / 100;
    const u = createUniformBuffer(new Float32Array([thr, roll, 0.85, 0]));
    runCompute(this._pipelines.desat, [
      { binding: 0, resource: { buffer: buf } },
      { binding: 1, resource: { buffer: u } },
    ], dispatchSize(count / 3, 64));
    u.destroy();
  }

  // ── Chroma noise reduction (Lab despike + bilateral on a*/b*) ─────────────
  /**
   * Port of the desktop's pre-LUT CNR. Four GPU passes on linear ACEScg:
   * to-Lab → despike (3×3 median clamp on chroma) → bilateral (chroma only, L*
   * preserved) → to-ACEScg. Removes chroma noise without touching luminance.
   * Returns the buffer holding the result (a pooled work buffer).
   * @returns {GPUBuffer}
   */
  applyCnr(src, w, h, count, getBuf) {
    if (!this._ready) return src;
    const px = dispatchSize(w * h, 64);
    const A = getBuf('cnrA', count);
    const B = getBuf('cnrB', count);

    // U struct: w:u32, h:u32, then 6×f32. Pack u32 + f32 into one buffer.
    const ub = new ArrayBuffer(32);
    new Uint32Array(ub, 0, 2).set([w, h]);
    new Float32Array(ub, 8, 6).set([
      CNR_SIGMA_SPACE, CNR_SIGMA_COLOR, CNR_RADIUS, CNR_THR_GREEN, CNR_THR_OTHER, 0,
    ]);
    const u = createUniformBuffer(new Float32Array(ub));

    const pass = (pipe, inBuf, outBuf) => runCompute(pipe, [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: outBuf } },
      { binding: 2, resource: { buffer: u } },
    ], px);

    pass(this._pipelines.cnrToLab,     src, A);   // ACEScg → Lab
    pass(this._pipelines.cnrDespike,   A,   B);   // median clamp a*/b*
    pass(this._pipelines.cnrBilateral, B,   A);   // bilateral a*/b*
    pass(this._pipelines.cnrToAcescg,  A,   B);   // Lab → ACEScg
    u.destroy();
    return B;
  }

  // ── Pre-LUT: linear-light effect chain (matches desktop) ──────────────────
  /**
   * Effects that the desktop runs BEFORE the LUT, on the linear ACEScg
   * intermediate: halation, vignette, bloom. Running them here (not post-LUT) is
   * what keeps a monochrome LUT neutral (the LUT desaturates the warm halation
   * glow) and stops bloom from washing the frame (the LUT's tone curve rolls off
   * the added highlights). Thresholds are LINEAR scene-referred values derived
   * from "stops above 18% mid-grey" (0.18·2^stops), like the desktop's
   * stops_above_mid_grey_to_acescct knobs. Halation and bloom use additive
   * blending (robust in HDR linear, unlike screen for values >1).
   *
   * @param {GPUBuffer} src     linear ACEScg buffer (will not be destroyed)
   * @param {number} w @param {number} h @param {number} count  w*h*3
   * @param {object} config     effect config (enable_* + params)
   * @param {(key:string,count:number)=>GPUBuffer} getBuf  work-buffer pool
   * @param {number} [scale]    resolution ratio vs the preview (blur radii scale)
   * @returns {GPUBuffer}       buffer holding the result (may be src)
   */
  applyPreLut(src, w, h, count, config, getBuf, scale = 1) {
    if (!this._ready) return src;
    const c = config ?? {};
    const s = scale > 0 ? scale : 1;
    const px = dispatchSize(w * h, 64);
    const el = dispatchSize(count, 256);
    // Convert linear stops to ACEScct: (log2(0.18·2^stops) + 9.72) / 17.52
    const acescctThr = (stops) => (Math.log2(0.18 * Math.pow(2, stops)) + 9.72) / 17.52;

    let cur = src;
    const A = getBuf('preA', count);
    const B = getBuf('preB', count);

    // 1. Halation — three-scale reddening glow (desktop 1.6.5), additive in
    //    linear light. Each scale gates highlights with a sigmoid on ACEScct-
    //    encoded luma, tints them (red dominant, green/blue falling off with
    //    warmth + the scale weight + user strength baked in), blurs at a growing
    //    radius, and is summed onto the image. Wider scales use a higher
    //    threshold so only the brightest sources feed the broad halo.
    if (c.enable_halation && (c.halation_strength ?? 0) > 0) {
      const strength  = c.halation_strength;
      const warmthExp = Math.max(0, c.halation_warmth_pct ?? HALATION_WARMTH_PCT) / 100;
      const baseThr   = acescctThr(c.halation_threshold_stops ?? 4.5);
      const baseR     = Math.max(1, c.halation_blur_radius ?? 8) * s;
      const K         = 20.0;
      const mask = getBuf('mask', count);
      const tmp  = getBuf('tmp',  count);
      const halSrc = cur;                       // all scales read the original image
      for (const [radMult, thrOff, weight, gf, bf] of HALATION_SCALES) {
        const ws = weight * strength;
        const u = createUniformBuffer(new Float32Array([
          w, h, Math.min(baseThr + thrOff, 0.98), 0,                         // width,height,threshold,(strength unused)
          ws, ws * Math.pow(gf, warmthExp), ws * Math.pow(bf, warmthExp), K,  // tint.rgb, sigmoid k
        ]));
        runCompute(this._pipelines.halation, [
          { binding: 0, resource: { buffer: halSrc } },
          { binding: 1, resource: { buffer: mask } },
          { binding: 2, resource: { buffer: u } },
        ], px);
        u.destroy();
        this._blur(mask, mask, tmp, w, h, count, baseR * radMult);
        const dst = (cur === A) ? B : A;        // accumulate onto the running image
        runCompute(this._pipelines.add, [
          { binding: 0, resource: { buffer: cur } },
          { binding: 1, resource: { buffer: mask } },
          { binding: 2, resource: { buffer: dst } },
        ], el);
        cur = dst;
      }
    }

    // 2. Vignette (in place, linear — cool periphery, no upper clamp)
    if (c.enable_vignette && (c.vignette_strength ?? 0) > 0) {
      const u = createUniformBuffer(new Float32Array([
        w, h, c.vignette_strength, c.vignette_feather ?? 1.0, c.vignette_color_shift ?? 0.05, 0, 0, 0,
      ]));
      runCompute(this._pipelines.vignette, [
        { binding: 0, resource: { buffer: cur } },
        { binding: 1, resource: { buffer: u } },
      ], px);
      u.destroy();
    }

    // 3. Bloom — 4× pyramid approach (port of OP's apply_bloom).
    //    Downsample + ACEScct mask at 1/4 res, Gaussian blur at adaptive sigma
    //    (sigma = max(2, max_dim/5) at small res ≈ 412px effective at full res),
    //    bilinear upsample + additive blend.
    if (c.enable_bloom && (c.bloom_strength ?? 0) > 0) {
      const smallW = Math.max(1, Math.ceil(w / 4));
      const smallH = Math.max(1, Math.ceil(h / 4));
      const smallCount = smallW * smallH * 3;
      const small = getBuf('bloomSmall', smallCount);
      const tmp   = getBuf('tmp', Math.max(count, smallCount));

      const bloomThr = acescctThr(c.bloom_threshold_stops ?? 3.0);
      const ud = new ArrayBuffer(32);
      new Uint32Array(ud).set([w, h, smallW, smallH]);
      new Float32Array(ud, 16).set([bloomThr, 0, 0, 0]);
      const uDown = createUniformBuffer(new Float32Array(ud));

      // Dispatch: one thread per output (small) pixel
      const downPx = dispatchSize(smallW * smallH, 64);
      runCompute(this._pipelines.bloomDown, [
        { binding: 0, resource: { buffer: cur } },
        { binding: 1, resource: { buffer: small } },
        { binding: 2, resource: { buffer: uDown } },
      ], downPx);
      uDown.destroy();

      // Blur at adaptive sigma on the SMALL buffer
      const sigma = Math.max(2, Math.max(smallW, smallH) / 5);
      this._blur(small, small, tmp, smallW, smallH, smallCount, sigma);

      // Upsample + additive blend back to full res
      const dst = (cur === A) ? B : A;
      const uup = new ArrayBuffer(32);
      new Uint32Array(uup).set([w, h, smallW, smallH]);
      new Float32Array(uup, 16).set([c.bloom_strength, 0, 0, 0]);
      const uUp = createUniformBuffer(new Float32Array(uup));
      runCompute(this._pipelines.bloomUpadd, [
        { binding: 0, resource: { buffer: cur } },
        { binding: 1, resource: { buffer: small } },
        { binding: 2, resource: { buffer: dst } },
        { binding: 3, resource: { buffer: uUp } },
      ], px);
      uUp.destroy();
      cur = dst;
    }

    // 4. Chroma noise reduction (Lab despike + bilateral) — LAST in the pre-LUT
    //    chain, matching the desktop's vignette → bloom → CNR order. Gated to
    //    enable_cnr (Natural has it off via all_off, so Natural stays un-CNR'd,
    //    like the desktop's lut-only gating).
    if (c.enable_cnr) {
      cur = this.applyCnr(cur, w, h, count, getBuf);
    }

    return cur;
  }

  // ── Live: post-LUT display-referred effect chain ──────────────────────────
  /**
   * @param {GPUBuffer} src     buffer holding display RGB (will not be destroyed)
   * @param {number} w @param {number} h @param {number} count  w*h*3
   * @param {object} config     effect config (enable_* + params)
   * @param {(key:string,count:number)=>GPUBuffer} getBuf  work-buffer pool
   * @param {number} [scale]    resolution ratio vs the preview (1 for preview,
   *   ~2 at full-res export). Blur radii scale up by it and the grain tile scale
   *   down by it, so spatial effects look the same as the preview did.
   * @returns {GPUBuffer}       buffer holding the final result (may be src)
   */
  applyLive(src, w, h, count, config, getBuf, scale = 1) {
    if (!this._ready) return src;
    const c = config ?? {};
    const s = scale > 0 ? scale : 1;
    const px = dispatchSize(w * h, 64);
    const el = dispatchSize(count, 256);

    // Two general work buffers + dedicated mask/tmp buffers from the pool.
    let cur = src;
    const A = getBuf('fxA', count);
    const B = getBuf('fxB', count);

    const swapInto = (target) => { cur = target; };

    // 1. Chromatic aberration
    if (c.enable_chromatic_aberration && (c.ca_strength ?? 0) > 0) {
      const u = createUniformBuffer(new Float32Array([w, h, c.ca_strength, 0]));
      runCompute(this._pipelines.ca, [
        { binding: 0, resource: { buffer: cur } },
        { binding: 1, resource: { buffer: A } },
        { binding: 2, resource: { buffer: u } },
      ], px);
      u.destroy();
      swapInto(A);
    }

    // (Halation and bloom moved to applyPreLut — they belong in linear ACEScg
    //  BEFORE the LUT so the LUT desaturates/rolls them off. See applyPreLut.)

    // 4. Softness — gentle full-frame blur
    if (c.enable_softness && (c.softness_sigma ?? 0) > 0.01) {
      const tmp = getBuf('tmp', count);
      const dst = (cur === A) ? B : A;
      this._blur(cur, dst, tmp, w, h, count, c.softness_sigma * s);
      swapInto(dst);
    }

    // 5. Sharpen (unsharp mask) — blur → image + (image-blur)*strength
    if (c.enable_sharpen && (c.sharpen_strength ?? 0) > 0) {
      const blur = getBuf('mask', count);
      const tmp  = getBuf('tmp', count);
      this._blur(cur, blur, tmp, w, h, count, Math.max(0.3, c.sharpen_radius ?? 1) * s);
      const u = createUniformBuffer(new Float32Array([c.sharpen_strength, 0, 0, 0]));
      const dst = (cur === A) ? B : A;
      runCompute(this._pipelines.unsharp, [
        { binding: 0, resource: { buffer: cur } },
        { binding: 1, resource: { buffer: blur } },
        { binding: 2, resource: { buffer: dst } },
        { binding: 3, resource: { buffer: u } },
      ], el);
      u.destroy();
      swapInto(dst);
    }

    // (Vignette moved to applyPreLut — linear, pre-LUT, cool periphery.)

    // 7. Grain — sample tile → blend
    if (c.enable_grain && (c.grain_strength ?? 0) > 0 && this._grainTile) {
      const gbuf = getBuf('mask', count);
      // Divide the tile scale by the resolution ratio so grain keeps the same
      // relative size at full-res export as it had in the preview.
      const us = createUniformBuffer(new Float32Array([
        w, h, this._grainTile.w, this._grainTile.h, GRAIN_TILE_SCALE / s, 0, 0, 0,
      ]));
      runCompute(this._pipelines.gsample, [
        { binding: 0, resource: { buffer: this._grainTile.buf } },
        { binding: 1, resource: { buffer: gbuf } },
        { binding: 2, resource: { buffer: us } },
      ], px);
      us.destroy();
      // Matches the original apply_grain(intensity=grain_strength, min_grain=0.2,
      // highlight_bias=GRAIN_HIGHLIGHT_BIAS) — grain_strength is passed straight
      // through as the blend intensity (preset values are ~0.5..1.5).
      const ub = createUniformBuffer(new Float32Array([
        c.grain_strength ?? 1, 0.2, GRAIN_HIGHLIGHT_BIAS, 0,
      ]));
      const dst = (cur === A) ? B : A;
      runCompute(this._pipelines.grain, [
        { binding: 0, resource: { buffer: cur } },
        { binding: 1, resource: { buffer: gbuf } },
        { binding: 2, resource: { buffer: dst } },
        { binding: 3, resource: { buffer: ub } },
      ], el);
      ub.destroy();
      swapInto(dst);
    }

    return cur;
  }

  dispose() {
    this._grainTile?.buf?.destroy();
    for (const k of this._kernels.values()) k.buf.destroy();
    this._kernels.clear();
    this._grainTile = null;
  }
}
