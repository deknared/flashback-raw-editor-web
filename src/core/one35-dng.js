/**
 * one35-dng.js — Pure JavaScript Bayer decoder for Flashback One35 DNGs.
 *
 * The One35 DNG stores raw sensor data as uncompressed, MSB-first packed
 * 10-bit integers (TIFF FillOrder=1 default, Compression=1). Verified from
 * the file header: StripOffset=2048, StripByteCounts=15995840, BitsPerSample=10.
 *
 * Half-size decode (2×2 Bayer averaging) exactly matches rawpy's output at
 * half_size=True, output_color=raw, no_auto_bright=True, gamma=(1,1),
 * user_wb=[1,1,1,1], black_level=64. No WASM or build step required.
 *
 * This eliminates:
 *   - LIBRAW_PREMUL [1.272, 1.0, 1.103] — no libraw scale_colors() applied
 *   - GREEN_SHADOW/GREEN_HL tonal curve — G channel is now linear
 *   - libraw-wasm's per-channel piecewise errors (source of green hue)
 */

const SENSOR_W     = 4144;
const SENSOR_H     = 3088;
const BITS         = 10;
const SENSOR_BLACK = 64;
const SENSOR_WHITE = (1 << BITS) - 1;  // 1023
const SCALE        = 1.0 / (SENSOR_WHITE - SENSOR_BLACK);  // ≈ 1/959
const BYTES_PER_ROW = (SENSOR_W * BITS) >> 3;  // 5180 bytes

/**
 * Decode a One35 DNG to half-size float32 RGB in [0, 1].
 *
 * The 2×2 RGGB averaging (rawpy's half_size=True algorithm):
 *   R  = Bayer[y,   x]
 *   G  = (Bayer[y, x+1] + Bayer[y+1, x]) / 2
 *   B  = Bayer[y+1, x+1]
 *
 * Returns an interleaved Float32 RGB array suitable for FlashbackProcessor.
 * @param {ArrayBuffer} buffer
 * @returns {{ pixels: Float32Array, width: number, height: number }}
 */
export function decodeOne35HalfSize(buffer) {
  const stripOffset = _readStripOffset(buffer);
  const raw  = new Uint8Array(buffer, stripOffset);

  const outW   = SENSOR_W >> 1;  // 2072
  const outH   = SENSOR_H >> 1;  // 1544
  const pixels = new Float32Array(outW * outH * 3);

  const rowEven = new Uint16Array(SENSOR_W);
  const rowOdd  = new Uint16Array(SENSOR_W);

  for (let y = 0; y < SENSOR_H; y += 2) {
    _readRow10MSB(raw, y       * BYTES_PER_ROW, rowEven);
    _readRow10MSB(raw, (y + 1) * BYTES_PER_ROW, rowOdd);

    const outY = y >> 1;
    for (let x = 0; x < SENSOR_W; x += 2) {
      const r  = (rowEven[x]     - SENSOR_BLACK) * SCALE;
      const g1 = (rowEven[x + 1] - SENSOR_BLACK) * SCALE;
      const g2 = (rowOdd[x]      - SENSOR_BLACK) * SCALE;
      const b  = (rowOdd[x + 1]  - SENSOR_BLACK) * SCALE;

      const di = (outY * outW + (x >> 1)) * 3;
      pixels[di]     = r  < 0 ? 0 : r  > 1 ? 1 : r;
      pixels[di + 1] = (g1 + g2) * 0.5;
      pixels[di + 2] = b  < 0 ? 0 : b  > 1 ? 1 : b;
    }
  }

  return { pixels, width: outW, height: outH };
}

/**
 * Decode a One35 DNG to FULL-resolution float32 RGB in [0, 1].
 *
 * Same calibration as decodeOne35HalfSize (black-subtract → scale → the exact
 * same downstream recoverHighlights + FM1_WB_TO_ACESCG pipeline), but instead of
 * 2×2 binning it demosaics the full 4144×3088 RGGB mosaic. This is what makes a
 * true full-resolution export possible WITHOUT libraw-wasm (whose different
 * calibration rendered exports brighter and colour-shifted than the preview).
 *
 * Demosaic: hue-preserving bilinear. Green is interpolated first; red and blue
 * are reconstructed as G + bilinear(colour − G) sampled at that colour's Bayer
 * sites. Interpolating the colour-difference (rather than the raw channels)
 * keeps edges neutral and avoids the zipper/colour-fringe of naïve per-channel
 * bilinear. Downscaled 2× it matches the half-size decode (same calibration),
 * which is how full-res stays consistent with the preview.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ pixels: Float32Array, width: number, height: number }}
 */
export function decodeOne35Full(buffer) {
  const stripOffset = _readStripOffset(buffer);
  const raw = new Uint8Array(buffer, stripOffset);
  const W = SENSOR_W, H = SENSOR_H;

  // 1. Unpack the full 10-bit Bayer mosaic → normalized float plane [0,1].
  const bayer = new Float32Array(W * H);
  {
    const row = new Uint16Array(W);
    for (let y = 0; y < H; y++) {
      _readRow10MSB(raw, y * BYTES_PER_ROW, row);
      const o = y * W;
      for (let x = 0; x < W; x++) {
        const v = (row[x] - SENSOR_BLACK) * SCALE;
        bayer[o + x] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }

  // 2. Full green plane. RGGB: green sits where x,y parities differ. At red/blue
  //    sites green is interpolated EDGE-DIRECTED (Hamilton–Adams): take the
  //    horizontal or vertical green-neighbour pair along whichever direction has
  //    the smaller gradient, refined by the same-colour second derivative (the
  //    ±2 sample, same channel as the centre). This suppresses the zipper/maze
  //    artifacts that plain 4-neighbour averaging leaves on fine high-contrast
  //    detail (storefront lettering, railings) — only visible at heavy zoom in
  //    the full-res export. The correction term is a zero-sum Laplacian, so the
  //    green mean is preserved: the 2×-downscaled export still matches the
  //    half-size preview's calibration (export == preview).
  const G = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const o   = y * W;
    const oUp = (y > 0     ? y - 1 : 1)     * W;   // mirror at the borders
    const oDn = (y < H - 1 ? y + 1 : H - 2) * W;
    const oUU = (y >= 2     ? y - 2 : y + 2) * W;  // same-colour rows (±2)
    const oDD = (y <= H - 3 ? y + 2 : y - 2) * W;
    for (let x = 0; x < W; x++) {
      const i = o + x;
      if (((x ^ y) & 1) === 1) { G[i] = bayer[i]; continue; }  // green site
      const xL  = x > 0      ? x - 1 : 1;
      const xR  = x < W - 1  ? x + 1 : W - 2;
      const xLL = x >= 2     ? x - 2 : x + 2;       // same-colour columns (±2)
      const xRR = x <= W - 3 ? x + 2 : x - 2;
      const c   = bayer[i];
      const lapH = 2 * c - bayer[o + xLL]  - bayer[o + xRR];
      const lapV = 2 * c - bayer[oUU + x]  - bayer[oDD + x];
      const gH = 0.5 * (bayer[o + xL]  + bayer[o + xR])  + 0.25 * lapH;
      const gV = 0.5 * (bayer[oUp + x] + bayer[oDn + x]) + 0.25 * lapV;
      const dH = Math.abs(bayer[o + xL]  - bayer[o + xR])  + Math.abs(lapH);
      const dV = Math.abs(bayer[oUp + x] - bayer[oDn + x]) + Math.abs(lapV);
      G[i] = dH < dV ? gH : dV < dH ? gV : 0.5 * (gH + gV);
    }
  }

  // 3. Assemble interleaved RGB. The known channel comes straight from the
  //    mosaic; the two missing channels = G + bilinear(colour − G).
  const pixels = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const o   = y * W;
    const oUp = (y > 0     ? y - 1 : 1)     * W;
    const oDn = (y < H - 1 ? y + 1 : H - 2) * W;
    const rowEven = (y & 1) === 0;
    for (let x = 0; x < W; x++) {
      const i  = o + x;
      const di = i * 3;
      const xL = x > 0     ? x - 1 : 1;
      const xR = x < W - 1 ? x + 1 : W - 2;
      const g  = G[i];
      const colEven = (x & 1) === 0;
      let r, b;

      if (rowEven && colEven) {                 // R site → B from 4 diagonals
        r = bayer[i];
        b = g + 0.25 * (
          (bayer[oUp + xL] - G[oUp + xL]) + (bayer[oUp + xR] - G[oUp + xR]) +
          (bayer[oDn + xL] - G[oDn + xL]) + (bayer[oDn + xR] - G[oDn + xR]));
      } else if (rowEven) {                      // green on red row → R horiz, B vert
        r = g + 0.5 * ((bayer[o + xL] - G[o + xL]) + (bayer[o + xR] - G[o + xR]));
        b = g + 0.5 * ((bayer[oUp + x] - G[oUp + x]) + (bayer[oDn + x] - G[oDn + x]));
      } else if (colEven) {                      // green on blue row → R vert, B horiz
        r = g + 0.5 * ((bayer[oUp + x] - G[oUp + x]) + (bayer[oDn + x] - G[oDn + x]));
        b = g + 0.5 * ((bayer[o + xL] - G[o + xL]) + (bayer[o + xR] - G[o + xR]));
      } else {                                   // B site → R from 4 diagonals
        b = bayer[i];
        r = g + 0.25 * (
          (bayer[oUp + xL] - G[oUp + xL]) + (bayer[oUp + xR] - G[oUp + xR]) +
          (bayer[oDn + xL] - G[oDn + xL]) + (bayer[oDn + xR] - G[oDn + xR]));
      }

      pixels[di]     = r < 0 ? 0 : r > 1 ? 1 : r;
      pixels[di + 1] = g < 0 ? 0 : g > 1 ? 1 : g;
      pixels[di + 2] = b < 0 ? 0 : b > 1 ? 1 : b;
    }
  }

  return { pixels, width: W, height: H };
}

/**
 * Read W 10-bit pixels from one raw row into a Uint16Array.
 * MSB-first packing: 4 pixels per 5 bytes.
 *   pix[0] = (byte[0] << 2) | (byte[1] >> 6)
 *   pix[1] = ((byte[1] & 0x3F) << 4) | (byte[2] >> 4)
 *   pix[2] = ((byte[2] & 0x0F) << 6) | (byte[3] >> 2)
 *   pix[3] = ((byte[3] & 0x03) << 8) | byte[4]
 */
function _readRow10MSB(raw, rowByteStart, out) {
  const groups = SENSOR_W >> 2;  // 1036 (SENSOR_W is divisible by 4)
  for (let g = 0, b = rowByteStart; g < groups; g++, b += 5) {
    const b0 = raw[b], b1 = raw[b+1], b2 = raw[b+2], b3 = raw[b+3], b4 = raw[b+4];
    out[g * 4]     = (b0 << 2)         | (b1 >> 6);
    out[g * 4 + 1] = ((b1 & 0x3F) << 4) | (b2 >> 4);
    out[g * 4 + 2] = ((b2 & 0x0F) << 6) | (b3 >> 2);
    out[g * 4 + 3] = ((b3 & 0x03) << 8) | b4;
  }
}

/** Parse IFD0 to find the raw strip byte offset. Falls back to 2048 (confirmed One35 default). */
function _readStripOffset(buffer) {
  try {
    const dv   = new DataView(buffer);
    const le   = dv.getUint16(0) === 0x4949;
    const ifd0 = dv.getUint32(4, le);
    const n    = dv.getUint16(ifd0, le);
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + i * 12;
      if (dv.getUint16(e, le) !== 0x0111) continue;  // StripOffsets
      const type  = dv.getUint16(e + 2, le);
      const count = dv.getUint32(e + 4, le);
      if (count === 1) {
        return type === 3 ? dv.getUint16(e + 8, le) : dv.getUint32(e + 8, le);
      }
      // Multiple strips: read offset of first strip
      const off = dv.getUint32(e + 8, le);
      return type === 3 ? dv.getUint16(off, le) : dv.getUint32(off, le);
    }
  } catch { /* fall through */ }
  return 2048;
}
