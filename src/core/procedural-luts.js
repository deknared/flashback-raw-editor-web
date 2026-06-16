/**
 * procedural-luts.js — film-look LUT generated in JS instead of shipped as a
 * .cube file. It plugs into the exact same GPU LUT path the real film LUTs
 * use: input is an ACEScct-encoded coordinate, output is display-referred RGB.
 *
 * This is an ORIGINAL interpretation of a warm red-disposable film look — not
 * a copy of the official Flashback app's LUTs. For an exact match, import the
 * real .cube via Effects → Import LUT.
 *
 * Authoring works in display space: decode ACEScct → linear ACEScg → linear
 * sRGB → sRGB gamma → a grade (white balance, contrast, saturation).
 */

import { ACESCG_TO_LINSRGB, RENDER_LIFT_EV } from './config.js';

// ACEScct decode (matches acescct.wgsl).
const CUT_DECODE = 0.155251141552511;
const AA = 10.5402377416545;
const BB = 0.0729055341958355;
function acescctDecode(v) {
  return v < CUT_DECODE ? (v - BB) / AA : Math.pow(2, v * 17.52 - 9.72);
}

// The film path bakes the +2 EV render lift into the ACEScct the LUT sees.
// The real .cube LUTs map that down internally; ours undo it here so the
// looks render at metered brightness instead of blown out.
const LIFT_COMP = Math.pow(2, -RENDER_LIFT_EV);

function srgbOetf(x) {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const M = ACESCG_TO_LINSRGB;
function acescgToLinSrgb(r, g, b) {
  return [
    Math.max(0, M[0] * r + M[1] * g + M[2] * b),
    Math.max(0, M[3] * r + M[4] * g + M[5] * b),
    Math.max(0, M[6] * r + M[7] * g + M[8] * b),
  ];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
// Smooth S-curve around 0.5 in display space; `s` = strength (0 = none).
function scurve(x, s) {
  const e = x * x * (3 - 2 * x);     // smoothstep(0,1,x)
  return lerp(x, e, s);
}

// ── Grade definitions ─────────────────────────────────────────────────────
// Each grade takes display-sRGB [r,g,b] in 0..1 and returns the graded triple.

const GRADES = {
  // Warm red disposable: punchy red/orange, deeper blacks, higher contrast.
  // Labelled "Gold" in the UI.
  reddispo(r, g, b) {
    r *= 1.11; g *= 1.00; b *= 0.90;            // warm-red WB
    r = scurve(clamp01(r), 0.30);
    g = scurve(clamp01(g), 0.30);
    b = scurve(clamp01(b), 0.30);
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const sh = 1 - l;
    r = clamp01(r + 0.06 * sh);                  // red push into shadows
    b = clamp01(b - 0.04 * sh);                  // crush blue lows (deeper blacks)
    const sat = 1.22;
    r = clamp01(lerp(l, r, sat)); g = clamp01(lerp(l, g, sat)); b = clamp01(lerp(l, b, sat));
    return [r, g, b];
  },
};

/**
 * Generate a film-look LUT.
 * @param {string} id  one of: reddispo
 * @param {number} [size]  cube size (default 33)
 * @returns {{ size:number, data:Float32Array }}  shader order: ((r*N+g)*N+b)*3
 */
export function generateLut(id, size = 33) {
  const grade = GRADES[id];
  if (!grade) throw new Error(`unknown procedural LUT: ${id}`);

  const data = new Float32Array(size * size * size * 3);
  const N1 = size - 1;
  for (let ri = 0; ri < size; ri++) {
    for (let gi = 0; gi < size; gi++) {
      for (let bi = 0; bi < size; bi++) {
        // Decode the ACEScct grid coordinate → linear ACEScg → display sRGB.
        // Undo the render lift so the grade sees metered-brightness scene data.
        const cr = acescctDecode(ri / N1) * LIFT_COMP;
        const cg = acescctDecode(gi / N1) * LIFT_COMP;
        const cb = acescctDecode(bi / N1) * LIFT_COMP;
        const [lr, lg, lb] = acescgToLinSrgb(cr, cg, cb);
        let r = srgbOetf(lr), g = srgbOetf(lg), b = srgbOetf(lb);
        const out = grade(r, g, b);
        const idx = ((ri * size + gi) * size + bi) * 3;
        data[idx]     = clamp01(out[0]);
        data[idx + 1] = clamp01(out[1]);
        data[idx + 2] = clamp01(out[2]);
      }
    }
  }
  return { size, data };
}
