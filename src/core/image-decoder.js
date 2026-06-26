/**
 * image-decoder.js — decode finished images (JPEG / PNG / WebP) for the
 * "effects-only" import path.
 *
 * Unlike a RAW file, a JPEG is already a developed, display-referred sRGB image.
 * It can't be re-developed through the film pipeline, so we treat it the way the
 * desktop app treats a finished frame: linearise it to scene-linear, hand it to
 * the processor with the generic linear-sRGB → ACEScg matrix (same as a foreign
 * RAW), and let the NO-film-LUT "Natural" render apply only the optical/film
 * effects (halation, bloom, grain, softness, CA, vignette). The processor flags
 * these via `isPhoto` so it skips the film LUT + base-exposure shaping.
 *
 * Large images are downscaled to `maxEdge` so interactive renders stay within a
 * bounded GPU-buffer budget (the same reason RAW previews are half-size). For a
 * typical 12 MP phone JPEG (4032 px long edge) nothing is lost.
 */

import { LINSRGB_TO_ACESCG } from './config.js';

// 8-bit sRGB → linear lookup (the standard sRGB EOTF).
const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/**
 * Decode a JPEG/PNG/WebP buffer to linear-sRGB float RGB in [0,1].
 * @param {ArrayBuffer|Blob} buffer
 * @param {{ maxEdge?: number }} [opts]
 * @returns {Promise<{pixels:Float32Array,width:number,height:number,ccm:number[],
 *   isFlashback:boolean,isPhoto:boolean,asn:null,exposureS:null,
 *   dateTaken:null,metadata:null}>}
 */
export async function decodeImageFile(buffer, opts = {}) {
  const maxEdge = opts.maxEdge ?? 4096;
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer]);

  let bmp;
  try {
    // `from-image` honours EXIF orientation so portrait phone shots aren't sideways.
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error('Unsupported or corrupt image file');
  }

  const srcW = bmp.width, srcH = bmp.height;
  const long = Math.max(srcW, srcH);
  const scale = long > maxEdge ? maxEdge / long : 1;
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  const { data } = ctx.getImageData(0, 0, w, h);   // sRGB8 RGBA
  const pixels = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    pixels[j]     = SRGB_TO_LINEAR[data[i]];
    pixels[j + 1] = SRGB_TO_LINEAR[data[i + 1]];
    pixels[j + 2] = SRGB_TO_LINEAR[data[i + 2]];
  }

  return {
    pixels, width: w, height: h,
    ccm: LINSRGB_TO_ACESCG,
    isFlashback: false,
    isPhoto: true,
    asn: null, exposureS: null, dateTaken: null, metadata: null,
  };
}
