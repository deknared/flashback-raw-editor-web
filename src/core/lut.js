/**
 * lut.js — .cube LUT file parsing and GPU buffer management.
 * Phase 2: full GPU upload will be implemented here.
 * Phase 1 stub: exports parseCube() for reading .cube files.
 */

/**
 * Parse an Adobe .cube LUT file into a flat Float32Array.
 *
 * Cube format (Adobe Cube LUT spec 1.0): table entries are listed with the
 * FIRST input component (red) varying fastest and blue slowest — the file
 * entry for input (r,g,b) sits at line index ((b*N + g)*N + r).
 *
 * Our lut.wgsl shader indexes the flat array R-slowest:
 *   index = ((r * N + g) * N + b) * 3 + channel
 * so the entries are reordered here at parse time. (Loading them straight
 * through transposes the R/B input axes — grays survive, every saturated
 * colour goes wrong, and the render looks desaturated/washed out.)
 *
 * @param {string} text   Raw text of the .cube file
 * @returns {{ size: number, data: Float32Array }}
 */
export function parseCube(text) {
  const lines = text.split('\n');
  let size  = 0;
  const entries = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    // Skip other keywords (TITLE, DOMAIN_MIN, etc.)
    if (/^[A-Z]/.test(line)) continue;

    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      entries.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
    }
  }

  if (!size) throw new Error('LUT_3D_SIZE not found in .cube file');
  const expected = size * size * size * 3;
  if (entries.length !== expected) {
    console.warn(`[lut] Expected ${expected} values, got ${entries.length}`);
  }

  // Reorder file order (R fastest) → shader order (R slowest).
  const data = new Float32Array(expected);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const src = ((b * size + g) * size + r) * 3;
        const dst = ((r * size + g) * size + b) * 3;
        data[dst]     = entries[src];
        data[dst + 1] = entries[src + 1];
        data[dst + 2] = entries[src + 2];
      }
    }
  }
  return { size, data };
}

/**
 * Load a .cube LUT file from a URL.
 * @param {string} url
 * @returns {Promise<{ size: number, data: Float32Array }>}
 */
export async function loadCube(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch LUT: ${url} (${resp.status})`);
  const text = await resp.text();
  return parseCube(text);
}

// ─── GPU LUT management ─────────────────────────────────────────────────────
// The LUT lives in a persistent storage buffer (Refinement F): uploaded once per
// vibe change, reused across every preview render. The lut.wgsl shader reads it
// as a flat `array<f32>` indexed ((r*N+g)*N+b)*3 + channel.

import { createF32Buffer } from './gpu.js';

/**
 * A GPU-resident LUT. Holds the storage buffer + size; can be destroyed to free VRAM.
 */
export class GpuLut {
  /**
   * @param {GPUBuffer} buffer  Storage buffer of LUT data (read-only in shader)
   * @param {number}    size    LUT_3D_SIZE (e.g. 65)
   * @param {string}    [url]   Source URL (for cache identity)
   * @param {'native'|'srgb'} [inputSpace]  What space the LUT expects as INPUT.
   *   'native' — ACEScct-encoded ACEScg (our built-in/procedural LUTs are
   *   authored for this). 'srgb' — a display-referred sRGB / Rec.709 image, as
   *   ordinary creative "Photo LUTs" expect; the processor feeds these the
   *   Natural display render instead of ACEScct so they "just work".
   */
  constructor(buffer, size, url, inputSpace = 'native') {
    this.buffer     = buffer;
    this.size       = size;
    this.url        = url ?? null;
    this.inputSpace = inputSpace;
  }
  destroy() { this.buffer?.destroy(); this.buffer = null; }
}

/**
 * Upload parsed LUT data to a persistent GPU storage buffer.
 * @param {{ size: number, data: Float32Array }} lut
 * @param {string} [url]
 * @param {'native'|'srgb'} [inputSpace]
 * @returns {GpuLut}
 */
export function uploadLut(lut, url, inputSpace = 'native') {
  const buffer = createF32Buffer(lut.data, GPUBufferUsage.STORAGE);
  return new GpuLut(buffer, lut.size, url, inputSpace);
}

/**
 * Fetch a .cube file and upload it to the GPU in one step.
 * @param {string} url
 * @param {'native'|'srgb'} [inputSpace]
 * @returns {Promise<GpuLut>}
 */
export async function loadGpuLut(url, inputSpace = 'native') {
  const parsed = await loadCube(url);
  return uploadLut(parsed, url, inputSpace);
}
