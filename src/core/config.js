/**
 * config.js — Application-wide constants and effect defaults.
 * Ported from core/config.py.
 *
 * Matrices are stored row-major as flat arrays for easy matrix-vector multiply:
 *   out[i] = M[i*3+0]*v[0] + M[i*3+1]*v[1] + M[i*3+2]*v[2]
 */

// ─── Color Pipeline Constants (upstream v2: raw → FM1/ASN → XYZ → ACEScg) ────
// Port of the original's DNG-spec pipeline. The film LUTs are trained against
// the ACEScct encoding of THIS intermediate — feeding them anything else (like
// the pre-v2 CCM→Rec.2020 path) renders blown-out, washed colors.

/** Sensor black level for Flashback One35 v2. */
export const SENSOR_BLACK = 64;

/** AsShotNeutral from a real D50 grey-patch measurement (upstream ASN_D50). */
export const ASN_D50 = [0.541, 1.0, 0.597];

/** ForwardMatrix1: camera_wb_rgb (raw / ASN) → XYZ_D50, calibrated under D50. */
export const FM1 = [
  0.53086,  0.22116,  0.21219,
  0.08570,  0.98930, -0.07500,
  0.04526, -0.37228,  1.15192,
];

/** Bradford CAT D50 → D60 (ACES adopted white). */
export const BRADFORD_D50_TO_D60 = [
   0.98722400, -0.00611327, 0.01595330,
  -0.00759836,  1.00186000, 0.00533002,
   0.00307257, -0.00509595, 1.08168000,
];

/** XYZ_D60 → ACEScg (AP1). */
export const XYZ_D60_TO_ACESCG = [
   1.6410233797, -0.3248032942, -0.2364246952,
  -0.6636628587,  1.6153315917,  0.0167563477,
   0.0117218943, -0.0082844420,  0.9883948585,
];

/** ACEScg → linear sRGB (for the neutral tone-curve display path). */
export const ACESCG_TO_LINSRGB = [
   1.70505, -0.62179, -0.08326,
  -0.13026,  1.14080, -0.01055,
  -0.02400, -0.12897,  1.15297,
];

/**
 * ACEScg → ProPhoto RGB and ProPhoto → linear sRGB (both CAT02-adapted),
 * the exact pair the desktop derives at runtime via
 * colour.RGB_to_RGB(..., chromatic_adaptation_transform='CAT02'). The
 * Natural / no-LUT path runs the PROFILE_TONE_CURVE in ProPhoto space (not
 * linear sRGB) — ProPhoto's wide gamut rolls highlights off far more gently,
 * which is the desktop's "v2 profile" look. Row-major (out[i]=Σ M[i*3+j]·v[j]).
 */
export const ACESCG_TO_PROPHOTO = [
   0.854898,  0.033013,  0.112089,
   0.051821,  0.936875,  0.011304,
  -0.007081,  0.001819,  1.005262,
];
export const PROPHOTO_TO_LINSRGB = [
   2.036708, -0.737480, -0.299228,
  -0.225834,  1.223129,  0.002705,
  -0.010605, -0.134861,  1.145466,
];

/**
 * v2 profile tone curve (upstream config.PROFILE_TONE_CURVE) — the (input,
 * output) control points the no-LUT render path interpolates through in
 * ProPhoto space. A film-like toe (deeper shadows) and a soft highlight
 * shoulder (0.78→0.95, 1.0→1.0). Flattened to [x0,y0, x1,y1, …].
 */
export const PROFILE_TONE_CURVE = [
  0.0,  0.0,
  0.02, 0.02,
  0.06, 0.10,
  0.20, 0.42,
  0.40, 0.70,
  0.78, 0.95,
  1.0,  1.0,
];

/** Row-major 3×3 multiply: A·B. */
function m3mul(A, B) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  }
  return o;
}

/** Row-major 3×3 inverse (cofactor expansion). */
function m3inv(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det,  (b * f - c * e) / det,
    B / det,  (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det,  (a * e - b * d) / det,
  ];
}

// FM1 · diag(1/ASN): dividing each FM1 column by the matching ASN component
// folds the AsShotNeutral white balance into the matrix (upstream FM1_RAW_TO_XYZ_D50).
const FM1_OVER_ASN = FM1.map((v, idx) => v / ASN_D50[idx % 3]);

/** Fused raw → ACEScg for Flashback DNGs (upstream RAW_TO_ACESCG). */
export const RAW_TO_ACESCG =
  m3mul(m3mul(XYZ_D60_TO_ACESCG, BRADFORD_D50_TO_D60), FM1_OVER_ASN);

/**
 * Fused wb-normalised camera RGB (= raw / ASN) → ACEScg (upstream
 * FM1_WB_TO_ACESCG). Used by the highlight-recovery path, which white-balances
 * on the CPU first (recovery estimates clipped channels in WB'd space).
 */
export const FM1_WB_TO_ACESCG =
  m3mul(m3mul(XYZ_D60_TO_ACESCG, BRADFORD_D50_TO_D60), FM1);

/** Linear sRGB → ACEScg, for generic (non-Flashback) raws that libraw develops. */
export const LINSRGB_TO_ACESCG = m3inv(ACESCG_TO_LINSRGB);

// NOTE: v1.13.0 removed the v1.12.0 "embedded ForwardMatrix + asn^0.75 residual
// WB" path (EMBEDDED_FM_TO_ACESCG / ASN_REF / WB_RESIDUAL / ccmForAsn). It was a
// reverse-engineered approximation that produced a magenta cast. The fixed
// ÷ASN_D50 → FM1 → D50→D60 → ACEScg transform (RAW_TO_ACESCG above) is the
// calibrated DEFAULT for every shot. Since v1.3.0 the per-photo "Auto WB"
// effect divides by the file's own AsShotNeutral instead — that's the CLEAN
// textbook DNG model (same FM1, different neutral), not the old residual hack.
// Do not reintroduce the ^0.75 residual approach.

/**
 * Render-time base exposure lift in EV — upstream's BASE_EXPOSURE_OFFSET_V2.
 * Applied identically on BOTH display paths and for ALL cameras, exactly like
 * upstream (its reverse-AE and post-AE boost are disabled by default, so the
 * net pre-LUT exposure there is also just `user EV + 2.0`). The film LUTs
 * were trained against this level (the upstream LUT-profiling TIFF exporter
 * bakes it in), and the profile tone curve is tuned for it.
 *
 * The old split constants (−0.5 EV for generic cameras) were calibrated
 * against STALE pre-v2 LUTs and are gone — recalibrating against the wrong
 * reference was what kept film looks dark/washed.
 */
export const RENDER_LIFT_EV = 2.0;

/**
 * Decode-level exposure compensation for Flashback files, in EV. EMPIRICAL:
 * libraw-wasm develops the One35 raw ~1.25 EV HOTTER than the desktop app's
 * LibRaw (rawpy) at identical postprocess settings — so our +2 EV base lift was
 * landing the LUT input ~1.25 EV too bright. That both washed the image out AND
 * overdrove the colour LUTs into their blown-highlight region (where film print
 * LUTs turn pink/magenta — the cast on the colour looks; Monochrome desaturates
 * it so it looked fine). Folded into the Flashback ccm (a pure linear scale), it
 * corrects EVERY look at once, so user exposure 0 now matches the desktop level.
 * Calibrated to the user's measured −1.25 EV on DNG 00100; retune if needed.
 */
export const FLASHBACK_EXPOSURE_COMP_EV = 0;

/**
 * libraw-wasm's baked-in partial white balance, MEASURED (not guessed).
 *
 * Despite userMul=[1,1,1,1] + output_color=raw, libraw-wasm applies a partial
 * camera WB during decode that the desktop's rawpy does NOT. Measured on DNG
 * 00100 by decoding in-browser and reading the grey concrete against the
 * camera's own embedded AsShotNeutral ([0.479,1,0.648]): a neutral surface came
 * out at raw R/G=0.610, B/G=0.714 instead of the true 0.479/0.648 — i.e. libraw
 * had multiplied R by ~1.272 and B by ~1.103. Our matrix then divides by ASN_D50
 * AGAIN, double-counting → the magenta cast (concrete at ACEScg [1.27,1,1.23]).
 *
 * Dividing this back out of the Flashback matrix's COLUMNS (input channels) feeds
 * the matrix rawpy-equivalent true raw, so a neutral renders neutral (verified:
 * concrete → ACEScg [0.958,1,0.985], matching the desktop's own transform). It's
 * a fixed camera-profile WB, so one correction holds for every One35 shot.
 */
export const LIBRAW_PREMUL = [1.272, 1.0, 1.103];

/**
 * AsShotNeutral of the calibration shot (DNG 00100) used when measuring
 * LIBRAW_PREMUL. Stored so per-shot premul can be scaled proportionally
 * for shots with different white balance.
 */
export const ASN_LIBRAW_CAL = [0.479, 1.0, 0.648];

// ─── Generic (non-Flashback) RAW exposure anchoring ──────────────────────────
// Faithful port of upstream's GENERIC_RAW_ANCHOR_EV + per-file residual.
// libraw's generic develop lands ~2 stops BELOW the FM1 intermediate the render
// expects, so every foreign RAW is re-anchored by this much; a per-file residual
// then nudges per camera. NOTE: these are upstream's MEASURED values; we have no
// foreign test files to re-verify, and foreign RAW is best-effort regardless
// (the film looks are One35-calibrated). Live-tunable for calibration via
// globalThis.__GENERIC_RAW_ANCHOR_EV.
export const GENERIC_RAW_ANCHOR_EV = 2.0;

// Tier 2: measured per-make residual (EV) on top of the anchor, for proprietary
// raws that carry no embedded BaselineExposure. Upstream-measured 2026-06-17.
export const GENERIC_BOOST_EV_BY_MAKE = {
  'sony':                        -1.00,   // ARW
  'fujifilm':                     0.00,   // RAF
  'fuji':                         0.00,
  'pentax':                       0.50,
  'ricoh':                        0.50,
  'ricoh imaging company, ltd.':  0.50,
  'apple':                       -0.50,   // non-ProRAW iPhone raw
};

/**
 * Total exposure boost (EV) for a generic RAW = anchor + per-file residual.
 * Tier 1: embedded DNG BaselineExposure (most trustworthy) → Tier 2: measured
 * per-make → Tier 3: 0 (lowest-risk default for unseen bodies). Mirrors
 * upstream `_read_generic_raw_boost_ev`.
 * @param {string|null} make  camera make
 * @param {number|null} baselineExposure  embedded DNG BaselineExposure EV, or null
 * @returns {number} EV to fold into the generic raw→ACEScg matrix
 */
export function genericRawBoostEv(make, baselineExposure) {
  const anchor = globalThis.__GENERIC_RAW_ANCHOR_EV ?? GENERIC_RAW_ANCHOR_EV;
  if (baselineExposure != null && Number.isFinite(baselineExposure)) {
    return anchor + baselineExposure;                                  // Tier 1
  }
  const m = (make ?? '').trim().toLowerCase();
  if (m && m in GENERIC_BOOST_EV_BY_MAKE) return anchor + GENERIC_BOOST_EV_BY_MAKE[m];  // Tier 2
  return anchor;                                                       // Tier 3 (residual 0)
}

// ─── Generic-RAW daylight white balance (replicates the desktop) ─────────────
// libraw develops a generic raw at the camera's DAYLIGHT white balance (its
// pre_mul) — daylight-balanced, NOT the as-shot/auto WB (which is wrong for the
// analog look). The desktop then nudges that daylight point from D65 to
// Flashback's BASE_KELVIN so foreign raws land at the same neutral as One35
// shots. Upstream shifts the Bayer WB before develop; we apply the equivalent
// fixed per-channel gain in ACEScg, which keeps it to a single decode.
export const BASE_KELVIN = 5500.0;          // Flashback neutral anchor
export const GENERIC_DAYLIGHT_K = 6504.0;   // CIE D65 — libraw's daylight ref

/** CIE daylight-series chromaticity for a CCT (4000–25000 K) → XYZ (Y=1). */
function _planckianXyz(cct) {
  const T = cct, T2 = T * T, T3 = T2 * T;
  const x = T <= 7000
    ? -4.6070e9 / T3 + 2.9678e6 / T2 + 0.09911e3 / T + 0.244063
    : -2.0064e9 / T3 + 1.9018e6 / T2 + 0.24748e3 / T + 0.237040;
  const y = -3.000 * x * x + 2.870 * x - 0.275;
  return [x / y, 1.0, (1 - x - y) / y];
}

function _mat3vec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Per-channel ACEScg gain that shifts the white point from D65 (libraw's daylight)
 * to BASE_KELVIN. Computed once; multiplied into the generic raw→ACEScg matrix's
 * output rows. Mirrors upstream `_kelvin_to_acescg_gain(GENERIC_DAYLIGHT_K)`.
 */
export const GENERIC_KELVIN_ACESCG_GAIN = (() => {
  const base   = _mat3vec(XYZ_D60_TO_ACESCG, _planckianXyz(BASE_KELVIN));
  const target = _mat3vec(XYZ_D60_TO_ACESCG, _planckianXyz(GENERIC_DAYLIGHT_K));
  const g = [base[0] / target[0], base[1] / target[1], base[2] / target[2]];
  return [g[0] / g[1], 1.0, g[2] / g[1]];   // G normalized to 1
})();

/**
 * Compute the fused raw→ACEScg CCM for a Flashback DNG from any FM1 matrix.
 * Equivalent to the precomputed FLASHBACK_CCM constant but accepts a dynamic
 * FM1 — e.g. one read directly from the DNG's ForwardMatrix1 tag (0xC714).
 * @param {number[]} fm1 — 9-element row-major ForwardMatrix1 (camera→XYZ_D50)
 * @param {number} evComp — exposure compensation EV (e.g. FLASHBACK_EXPOSURE_COMP_EV)
 * @param {number[]} premul — per-channel partial-WB correction (e.g. LIBRAW_PREMUL)
 * @returns {number[]} 9-element row-major CCM (raw→ACEScg)
 */
/**
 * @param {number} aceR — scale applied to the ACEScg R output row (default 1)
 * @param {number} aceB — scale applied to the ACEScg B output row (default 1)
 *
 * The diagonal ACEScg scale (aceR, 1, aceB) is a post-FM1 correction for
 * systematic R/B excess vs the desktop reference that the FM1 matrix alone
 * can't capture. Live-tunable via globalThis.__ACE_R_SCALE / __ACE_B_SCALE.
 */
export function computeFlashbackCCM(fm1, evComp, premul, aceR = 1.0, aceB = 1.0) {
  const fm1OverAsn = fm1.map((v, idx) => v / ASN_D50[idx % 3]);
  const rawToAcescg = m3mul(m3mul(XYZ_D60_TO_ACESCG, BRADFORD_D50_TO_D60), fm1OverAsn);
  const k = Math.pow(2, evComp);
  return rawToAcescg.map((v, idx) => {
    const base = (v * k) / premul[idx % 3];
    const row = Math.floor(idx / 3);   // 0=R_out, 1=G_out, 2=B_out
    if (row === 0) return base * aceR;
    if (row === 2) return base * aceB;
    return base;
  });
}

/**
 * Reverse auto-exposure (upstream core/auto_exposure_reverse.py).
 *
 * The One35 locks ISO and aperture, so the camera's AE decision is entirely
 * the EXIF ExposureTime. Reversing part of it restores scene-referred film
 * density: a dim scene the camera brightened gets pushed back down BEFORE the
 * LUT (denser blacks, richer mids — the "film look" on night/indoor shots),
 * and the shift is undone AFTER the pipeline in display-linear space so the
 * average brightness stays close to camera-metered. Upstream applies strength
 * 0.3 of the full reversal at slider zero ("mild film character").
 *
 * Flashback files only — generic cameras don't get reverse-AE upstream either.
 */
export const REVERSE_AE_T_REF    = 1e-3;   // seconds — the reference shutter
export const REVERSE_AE_STRENGTH = 0.3;    // fraction applied at slider zero

// ─── Effect Defaults ─────────────────────────────────────────────────────────

export const CHROMATIC_ABERRATION_STRENGTH = 0.005;
export const CHROMATIC_ABERRATION_STEPS    = 4;
export const CHROMATIC_ABERRATION_BLUE_BLUR = 0.3;

export const HALATION_THRESHOLD       = 0.55;
export const HALATION_BLUR_RADIUS     = 8;     // base radius (desktop 1.6.5); scales multiply it
export const HALATION_STRENGTH        = 0.5;
export const HALATION_WARMTH_PCT      = 120;   // green/blue falloff exponent: 100 = physical, >100 = redder

// Three-scale halation model (desktop 1.6.5). A defined core plus two fainter,
// wider scatter tiers, each tinted so the halo reddens outward (back-reflected
// light is red-dominant after passing twice through the dye layers + base mask).
// Per scale: [radius_mult, threshold_offset, weight, green_frac, blue_frac].
// (We use a Gaussian blur for every scale; the desktop uses a defined disc for
// the core — a future refinement for a crisper CineStill edge.)
export const HALATION_SCALES = [
  [1.0, 0.00, 1.00, 0.45, 0.12],   // core — dominant
  [2.5, 0.10, 0.18, 0.28, 0.05],   // near scatter — fainter, brighter sources only
  [5.0, 0.20, 0.07, 0.16, 0.02],   // far scatter — faint wide pedestal
];

export const SOFTNESS_SIGMA           = 0.5;

export const GRAIN_STRENGTH           = 0.01;
export const GRAIN_BLUR_SIGMA         = 0.1;
export const GRAIN_TILE_SCALE         = 1.3;
export const GRAIN_HIGHLIGHT_BIAS     = 0.3;

export const SHARPEN_STRENGTH         = 0.5;
export const SHARPEN_RADIUS           = 1.0;

export const CNR_SIGMA                = 2.0;

// Chroma-noise-reduction (CNR) — Lab-space despike + bilateral on a*/b*, ported
// from the desktop's cnr.wgsl. Values are the desktop defaults (cnr_amount_pct
// 20, despike 60, bias 75) run through its conversion helpers:
//   sigma_space = pct(20)*20 = 4.0 ; sigma_color = max(15, 4*3) = 15
//   radius = round(sigma_space*1.5) = 6   (matches cv2.bilateralFilter d)
//   despike: thr_green = 40 - 0.2*(40-4) = 18.4 ; thr_other = 18.4/(1-0.75) = 73.6
export const CNR_SIGMA_SPACE          = 4.0;
export const CNR_SIGMA_COLOR          = 15.0;
export const CNR_RADIUS               = 6.0;
export const CNR_THR_GREEN            = 18.4;
export const CNR_THR_OTHER            = 73.6;

export const HIGHLIGHT_DESAT_THRESHOLD_L = 58.0;
export const HIGHLIGHT_DESAT_ROLLOFF_L   = 10.0;
export const HIGHLIGHT_DESAT_SIGMA       = 10.0;

export const DITHER_STRENGTH          = 0.005;

export const VIGNETTE_STRENGTH        = 0.5;
export const VIGNETTE_COLOR_SHIFT     = 0.05;  // vignette_color_pct=25 → pct(25)*0.2=0.05 (warm tint, desktop default)
export const VIGNETTE_FEATHER         = 1.0;

export const BLOOM_STRENGTH           = 0.3;

// Pre-LUT (linear ACEScg) highlight thresholds, in STOPS above 18% mid-grey.
// effects.applyPreLut converts these to a linear value (0.18·2^stops). They
// replace the old display-space halation/bloom thresholds now that halation and
// bloom run before the LUT (matching the desktop's stops-based knobs).
export const HALATION_THRESHOLD_STOPS = 4.5;   // desktop 1.6.5 (was 4.0)
export const BLOOM_THRESHOLD_STOPS    = 3.0;

/**
 * Post-LUT display-space R/G/B scale calibration per built-in profile.
 *
 * libraw-wasm's highlight decode differs from rawpy's in a way that natural-
 * look LUTs (P&S, Rangefinder, FBV1) amplify and stylised LUTs (Disposable,
 * Monochrome) absorb. No single pre-LUT correction can fix all profiles at
 * once, so each LUT that shows systematic error gets a small diagonal matrix
 * applied AFTER the LUT in display sRGB space.
 *
 * Values are empirically calibrated via verify.html against DNG 00100 desktop
 * reference exports (test-assets/reference/). They represent ref÷app means
 * in the centre-60% region of the frame and should be stable across scenes
 * because the error is a decode characteristic, not scene content.
 *
 * Pending: re-calibrate after Path A (LibRaw 0.22.0 WASM rebuild) — the root
 * cause fix should reduce or eliminate these corrections.
 */
export const DISPLAY_CAL = {
  natural:      [1.000, 1.000, 1.000],  // re-calibrate with JS decoder via verify.html
  disposable:   [1.000, 1.000, 1.000],
  point_shoot:  [1.000, 1.000, 1.000],
  rangefinder:  [1.000, 1.000, 1.000],
  monochrome:   [1.000, 1.000, 1.000],
  flashback_v1: [1.000, 1.000, 1.000],
};

// ─── Vibe Presets ─────────────────────────────────────────────────────────────
// Each vibe maps to a LUT file + per-vibe effect overrides.
// LUT paths are relative to /assets/luts/.

export const VIBE_PRESETS = {
  natural: {
    label:          'Natural',
    all_off:        true,      // no LUT, no effects — the camera-profile rendering
    enable_ca:      false,
    ca_strength:    0,
    softness:       0,
    sharpness:      0,
    sharpen_radius: 1.0,
    grain:          0,
    vignette:       0,
    vignette_feather: 1.0,
    bloom:          0,
    lut:            null,
  },
  disposable: {
    label:             'Disposable',
    enable_ca:         true,
    ca_strength:       0.0077,  // ca_pixels=8 @ half-size long_edge 2072: 8/(2072/2)=0.0077
    softness:          0.50,    // desktop-app parity (SOFTNESS-1)
    sharpness:         2.00,    // sharpness_pct=200 → 200/100=2.0
    sharpen_radius:    0.5,
    grain:             1.20,    // grain_pct=120 → 120/100=1.2
    vignette:          0.10,
    vignette_feather:  0.40,    // vignette_curve=66 → 2^(-66/50)=0.40
    bloom:             0.15,
    halation_strength: 0.40,
    lut:               '/assets/luts/disposable.cube',
    base_push_ev:      0,
    b_push_boost:      0,
  },
  point_shoot: {
    label:             'Point & Shoot',
    enable_ca:         true,
    ca_strength:       0.0019,  // ca_pixels=2 @ half-size long_edge 2072: 2/(2072/2)=0.0019
    softness:          0.30,
    sharpness:         0.50,    // sharpness_pct=50 → 50/100=0.5
    sharpen_radius:    1.0,
    grain:             0.80,    // grain_pct=80 → 80/100=0.8
    vignette:          0.10,
    vignette_feather:  1.00,    // vignette_curve=0 → neutral
    bloom:             0.10,
    halation_strength: 0.30,
    lut:               '/assets/luts/pointandshoot.cube',
    base_push_ev:      0,
    b_push_boost:      0,
  },
  rangefinder: {
    label:             'Rangefinder',
    enable_ca:         false,
    ca_strength:       0,
    softness:          0.10,
    sharpness:         0.80,    // sharpness_pct=80 → 80/100=0.8
    sharpen_radius:    1.0,
    grain:             0.50,    // grain_pct=50 → 50/100=0.5
    vignette:          0.050,   // vignette_pct=5 → 5/100=0.05
    vignette_feather:  1.00,
    bloom:             0.050,
    halation_strength: 0.20,
    lut:               '/assets/luts/rangefinder.cube',
    base_push_ev:      0,
    b_push_boost:      0,
  },
  monochrome: {
    label:             'Monochrome',
    enable_ca:         false,
    ca_strength:       0,
    softness:          0.10,
    sharpness:         0.80,
    sharpen_radius:    1.0,
    grain:             1.50,
    vignette:          0.20,
    vignette_feather:  1.00,
    bloom:             0.050,
    halation_strength: 0.15,
    lut:               '/assets/luts/monochrome.cube',
    base_push_ev:      0,
  },
  flashback_v1: {
    label:             'Flashback V1',
    enable_ca:         true,
    ca_strength:       0.0048,  // ca_pixels=5 @ half-size long_edge 2072: 5/(2072/2)=0.0048
    softness:          0.30,
    sharpness:         0.80,
    sharpen_radius:    0.5,
    grain:             2.00,    // grain_pct=200 → 200/100=2.0
    vignette:          0.10,
    vignette_feather:  0.40,    // vignette_curve=66 → 2^(-66/50)=0.40
    bloom:             0.030,
    halation_strength: 0.35,
    lut:               '/assets/luts/V1.cube',
    // The V1 look's LUT is trained WITHOUT the +2 EV lift the other looks use
    // (upstream flashback_classic_v1 sets base_exposure_offset_v2 = 0).
    base_lift_ev:      0,
    base_push_ev:      0,
    b_push_boost:      0,
  },

  // Procedural looks (generated in core/procedural-luts.js, not .cube files).
  // Run the full film pipeline so effects/grain apply like any other vibe.
  reddispo: {
    label:             'Gold',
    enable_ca:         true,
    ca_strength:       0.008,
    softness:          0.5,
    sharpness:         1.5,
    sharpen_radius:    0.5,
    grain:             1.1,
    vignette:          0.12,
    vignette_feather:  0.4,
    bloom:             0.10,
    halation_strength: 0.30,
    lut:               'proc:reddispo',
  },
  superia: {
    label:             'Expired Superia',
    enable_ca:         true,
    ca_strength:       0.002,
    softness:          0.35,
    sharpness:         1.45,
    sharpen_radius:    1.0,
    grain:             1.5,
    vignette:          0.45,
    vignette_feather:  1.0,
    bloom:             0.10,
    halation_strength: 0.25,
    base_push_ev:      -1,
    lut:               'proc:superia',
  },
};

// ─── Vibe Fields Schema ───────────────────────────────────────────────────────
// Ordered list of {name, type} for every field that participates in vibe state.
// Mirrors VIBE_FIELDS in config.py. Used for serialization & UI sync.

export const VIBE_FIELDS = [
  { name: 'enable_halation',          type: 'bool'  },
  { name: 'enable_chromatic_aberration', type: 'bool' },
  { name: 'enable_softness',          type: 'bool'  },
  { name: 'enable_grain',             type: 'bool'  },
  { name: 'enable_sharpen',           type: 'bool'  },
  { name: 'enable_cnr',               type: 'bool'  },
  { name: 'enable_lut',               type: 'bool'  },
  { name: 'enable_pre_lut_dither',    type: 'bool'  },
  { name: 'enable_highlight_desat',   type: 'bool'  },
  { name: 'enable_vignette',          type: 'bool'  },
  { name: 'enable_bloom',             type: 'bool'  },
  { name: 'halation_threshold',       type: 'float' },
  { name: 'halation_blur_radius',     type: 'float' },
  { name: 'halation_strength',        type: 'float' },
  { name: 'ca_strength',              type: 'float' },
  { name: 'ca_steps',                 type: 'int'   },
  { name: 'ca_blue_blur',             type: 'float' },
  { name: 'softness_sigma',           type: 'float' },
  { name: 'grain_strength',           type: 'float' },
  { name: 'sharpen_strength',         type: 'float' },
  { name: 'sharpen_radius',           type: 'float' },
  { name: 'cnr_sigma',                type: 'float' },
  { name: 'highlight_desat_threshold_L', type: 'float' },
  { name: 'highlight_desat_rolloff_L',   type: 'float' },
  { name: 'highlight_desat_sigma',       type: 'float' },
  { name: 'pre_lut_dither_strength',  type: 'float' },
  { name: 'vignette_strength',        type: 'float' },
  { name: 'vignette_color_shift',     type: 'float' },
  { name: 'vignette_feather',         type: 'float' },
  { name: 'bloom_strength',           type: 'float' },
  { name: 'bloom_threshold',          type: 'float' },
  { name: 'lut_path',                 type: 'string'},
];

// ─── Default DebugConfig (mirrors DebugConfig class defaults) ─────────────────

export const DEFAULT_CONFIG = {
  enable_halation:               true,
  enable_chromatic_aberration:   true,
  enable_softness:               true,
  enable_grain:                  true,
  enable_sharpen:                true,
  enable_cnr:                    true,
  enable_lut:                    true,
  enable_pre_lut_dither:         true,
  enable_highlight_desat:        true,
  enable_vignette:               true,
  enable_bloom:                  true,
  // Reverse auto-exposure is an ADVANCED opt-in upstream (VibeConfig
  // enable_reverse_autoexposure defaults False), so it's off here too. When
  // off the render applies no reverse-AE density shift — matching the desktop
  // reference exports, which is what we calibrate the looks against.
  enable_reverse_autoexposure:   false,

  halation_threshold:        HALATION_THRESHOLD,
  halation_blur_radius:      HALATION_BLUR_RADIUS,
  halation_strength:         HALATION_STRENGTH,
  halation_warmth_pct:       HALATION_WARMTH_PCT,
  ca_strength:               CHROMATIC_ABERRATION_STRENGTH,
  ca_steps:                  CHROMATIC_ABERRATION_STEPS,
  ca_blue_blur:              CHROMATIC_ABERRATION_BLUE_BLUR,
  softness_sigma:            SOFTNESS_SIGMA,
  grain_strength:            GRAIN_STRENGTH,
  sharpen_strength:          SHARPEN_STRENGTH,
  sharpen_radius:            SHARPEN_RADIUS,
  cnr_sigma:                 CNR_SIGMA_SPACE,  // cnr_amount_pct=20 → pct(20)*20=4.0 (desktop default)
  highlight_desat_threshold_L: HIGHLIGHT_DESAT_THRESHOLD_L,
  highlight_desat_rolloff_L:   HIGHLIGHT_DESAT_ROLLOFF_L,
  highlight_desat_sigma:       HIGHLIGHT_DESAT_SIGMA,
  pre_lut_dither_strength:   DITHER_STRENGTH,
  vignette_strength:         VIGNETTE_STRENGTH,
  vignette_color_shift:      VIGNETTE_COLOR_SHIFT,
  vignette_feather:          VIGNETTE_FEATHER,
  bloom_strength:            BLOOM_STRENGTH,
  halation_threshold_stops:  HALATION_THRESHOLD_STOPS,
  bloom_threshold_stops:     BLOOM_THRESHOLD_STOPS,
  base_lift_ev:              RENDER_LIFT_EV,   // upstream base_exposure_offset_v2
  lut_path:                  '',

  dng_profile_name: 'Flashback Standard',
};

/**
 * Build the factory state for a given vibe ID.
 * Merges DEFAULT_CONFIG with vibe-specific overrides.
 * Mirrors factory_state_for() in config.py.
 * @param {string} vibeId
 * @returns {object}
 */
export function factoryStateFor(vibeId) {
  const preset = VIBE_PRESETS[vibeId];
  if (!preset) throw new Error(`Unknown vibe: ${vibeId}`);

  const cal = DISPLAY_CAL[vibeId] ?? [1, 1, 1];
  const state = {
    ...DEFAULT_CONFIG,
    enable_chromatic_aberration: preset.enable_ca,
    ca_strength:       preset.ca_strength,
    softness_sigma:    preset.softness,
    sharpen_strength:  preset.sharpness,
    sharpen_radius:    preset.sharpen_radius,
    grain_strength:    preset.grain,
    vignette_strength: preset.vignette,
    vignette_feather:  preset.vignette_feather ?? 1.0,
    vignette_color_shift: preset.vignette_color_shift ?? VIGNETTE_COLOR_SHIFT,
    bloom_strength:    preset.bloom,
    halation_strength: preset.halation_strength ?? HALATION_STRENGTH,
    base_lift_ev:      preset.base_lift_ev ?? RENDER_LIFT_EV,
    base_push_ev:      preset.base_push_ev ?? 0,
    b_push_boost:      preset.b_push_boost ?? 0,
    lut_path:          preset.lut,
    // Post-LUT display calibration (not user-adjustable; see DISPLAY_CAL).
    display_cal_r:    cal[0],
    display_cal_g:    cal[1],
    display_cal_b:    cal[2],
  };

  // "Natural" starts as the plain camera rendering: no LUT and every film
  // effect off (each is still individually toggleable from the panel).
  if (preset.all_off) {
    for (const key of Object.keys(state)) {
      if (key.startsWith('enable_')) state[key] = false;
    }
  }
  return state;
}

