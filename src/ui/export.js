/**
 * export.js — Save the rendered image as JPEG (8-bit) or TIFF (16-bit RGB).
 *
 * JPEG goes through a canvas (browser-native encoder). The 16-bit TIFF is
 * written by a tiny self-contained encoder below — off-the-shelf JS TIFF
 * writers only emit 8-bit samples, which would throw away the extra precision
 * that makes a 16-bit export worthwhile, so we build the uncompressed RGB16
 * container by hand (no dependency needed).
 */

/** Trigger a browser download for a Blob/File (desktop path). */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Delivery ─────────────────────────────────────────────────────────────────
// In an iOS standalone (home-screen) PWA, a programmatic `<a download>` click
// on a blob: URL does NOT download — it NAVIGATES the standalone window to the
// blob, and with no browser chrome the app appears to "reload to the start
// screen". The correct way to hand files to the user there is the Web Share
// API: the share sheet offers "Save Image" / "Save to Files", and one sheet
// can carry a whole batch. Anchor downloads remain the desktop fallback.
//
// IMPORTANT: this is an iOS-only workaround. Desktop Chrome and Android Chrome
// now ALSO report `navigator.canShare({files}) === true`, so a capability-only
// check wrongly routed them to the OS share sheet — which on desktop has no
// "save to disk" target at all. On those platforms `<a download>` works and
// saves straight to disk, so we must keep them on the download path.

/** iOS / iPadOS (which reports as MacIntel with a touch screen). */
function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Whether the share-sheet path can deliver these files. */
export function canShareFiles(files) {
  try {
    return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files }));
  } catch {
    return false;
  }
}

/**
 * Whether to deliver via the OS share sheet rather than a download. Only iOS
 * needs this (see the note above); everywhere else we download.
 */
function shouldShareFiles(files) {
  return isIOS() && canShareFiles(files);
}

/**
 * Hand files to the user: share sheet where supported, downloads otherwise.
 * @param {File[]} files
 * @returns {Promise<'shared'|'cancelled'|'blocked'|'downloaded'>}
 *   'blocked' = share refused (usually expired user-activation after a long
 *   render) — the caller should retry from inside a fresh tap.
 */
export async function deliverFiles(files) {
  if (!shouldShareFiles(files)) {
    for (let i = 0; i < files.length; i++) {
      downloadBlob(files[i], files[i].name);
      // Small gap so multi-file downloads don't trample each other.
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 300));
    }
    return 'downloaded';
  }
  try {
    await navigator.share({ files });
    return 'shared';
  } catch (e) {
    return e?.name === 'AbortError' ? 'cancelled' : 'blocked';
  }
}

/** Replace a file's extension (or append one if absent). */
function withExt(name, ext) {
  return (name || 'flashback').replace(/\.[^.]+$/, '') + ext;
}

/**
 * Build a minimal Exif APP1 segment declaring ColorSpace = sRGB (1).
 * Our pipeline outputs display sRGB; tagging it makes that explicit so
 * iOS/macOS Photos (and other color-managed apps) don't second-guess the gamut.
 * @returns {Uint8Array} the full APP1 segment (marker + length + payload)
 */
function srgbExifApp1() {
  const tiff = new ArrayBuffer(44);
  const dv = new DataView(tiff);
  const LE = true;
  // TIFF header (little-endian)
  dv.setUint16(0, 0x4949, LE);   // "II"
  dv.setUint16(2, 42, LE);       // magic
  dv.setUint32(4, 8, LE);        // offset to IFD0
  // IFD0: one entry → pointer to the Exif sub-IFD
  dv.setUint16(8, 1, LE);
  dv.setUint16(10, 0x8769, LE);  // ExifIFDPointer
  dv.setUint16(12, 4, LE);       // type LONG
  dv.setUint32(14, 1, LE);       // count
  dv.setUint32(18, 26, LE);      // value: byte offset of the Exif sub-IFD
  dv.setUint32(22, 0, LE);       // next-IFD = none
  // Exif sub-IFD at offset 26: one entry → ColorSpace = 1 (sRGB)
  dv.setUint16(26, 1, LE);
  dv.setUint16(28, 0xA001, LE);  // ColorSpace
  dv.setUint16(30, 3, LE);       // type SHORT
  dv.setUint32(32, 1, LE);       // count
  dv.setUint16(36, 1, LE);       // value (SHORT lives in the low 2 bytes)
  dv.setUint16(38, 0, LE);       // pad
  dv.setUint32(40, 0, LE);       // next-IFD = none
  const tiffBytes = new Uint8Array(tiff);

  const header = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  const segLen = 2 + header.length + tiffBytes.length; // length field counts itself
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xFF; seg[1] = 0xE1;                 // APP1 marker
  seg[2] = (segLen >> 8) & 0xFF;                // length is big-endian
  seg[3] = segLen & 0xFF;
  seg.set(header, 4);
  seg.set(tiffBytes, 4 + header.length);
  return seg;
}

/**
 * Insert the sRGB Exif segment into JPEG bytes, after any JFIF (APP0) segment.
 * Defensive: if the input doesn't look like a clean JPEG, the original bytes
 * are returned unchanged so an export can never be corrupted.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function tagJpegSrgb(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes; // not JPEG
  let insertAt = 2;
  if (bytes[2] === 0xFF && bytes[3] === 0xE0) {            // skip APP0 / JFIF
    const len = (bytes[4] << 8) | bytes[5];
    insertAt = 4 + len;
    if (insertAt > bytes.length) return bytes;             // malformed
  }
  if (bytes[insertAt] === 0xFF && bytes[insertAt + 1] === 0xE1) return bytes; // already tagged
  const app1 = srgbExifApp1();
  const out = new Uint8Array(bytes.length + app1.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(app1, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + app1.length);
  return out;
}

/**
 * Encode an ImageData as a JPEG File (sRGB-tagged). Delivery is separate —
 * see deliverFiles().
 * @param {ImageData} imageData
 * @param {string} filename  source name (extension is replaced)
 * @param {number} [quality] 0..1
 * @returns {Promise<File>}
 */
export async function encodeJpegFile(imageData, filename, quality = 0.95) {
  const cvs = document.createElement('canvas');
  cvs.width = imageData.width;
  cvs.height = imageData.height;
  cvs.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    cvs.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))),
      'image/jpeg',
      quality,
    );
  });
  // Release the encoder canvas backing store promptly (iOS canvas memory).
  cvs.width = 0; cvs.height = 0;
  const tagged = tagJpegSrgb(new Uint8Array(await blob.arrayBuffer()));
  return new File([tagged], withExt(filename, '.jpg'), { type: 'image/jpeg' });
}

/**
 * Encode interleaved float RGB (0..1) as a 16-bit uncompressed RGB TIFF.
 * Little-endian, single strip, chunky (RGBRGB…) layout.
 * @param {Float32Array} rgb  length w*h*3, values clamped to 0..1
 * @param {number} w
 * @param {number} h
 * @returns {Blob}
 */
function encodeTiff16(rgb, w, h) {
  const samples   = w * h * 3;
  const dataBytes = samples * 2;            // 16 bits per sample
  const NUM_TAGS  = 13;
  const ifdBytes  = 2 + NUM_TAGS * 12 + 4;  // tag-count + entries + next-IFD ptr

  // File layout: [header 8] [BitsPerSample 6] [WhitePoint 16] [Primaries 48]
  //              [pixel data] [IFD]
  const bpsOffset  = 8;
  const wpOffset   = bpsOffset + 6;         // WhitePoint: 2 rationals = 16 bytes
  const pcOffset   = wpOffset + 16;         // PrimaryChromaticities: 6 rationals = 48
  const dataOffset = pcOffset + 48;
  const ifdOffset  = dataOffset + dataBytes;

  const buf = new ArrayBuffer(ifdOffset + ifdBytes);
  const dv  = new DataView(buf);
  const LE  = true;

  // ── Header ──
  dv.setUint16(0, 0x4949, LE);   // "II" little-endian
  dv.setUint16(2, 42, LE);       // TIFF magic
  dv.setUint32(4, ifdOffset, LE);

  // ── BitsPerSample = [16,16,16] (referenced by tag 258) ──
  dv.setUint16(bpsOffset,     16, LE);
  dv.setUint16(bpsOffset + 2, 16, LE);
  dv.setUint16(bpsOffset + 4, 16, LE);

  // ── Colour space = sRGB / Rec.709 gamut (WhitePoint D65 + primaries) ──
  // Declares the gamut without needing an embedded ICC profile; viewers treat
  // these tags (plus the implicit sRGB transfer) as sRGB.
  const rat = (off, num, den) => { dv.setUint32(off, num, LE); dv.setUint32(off + 4, den, LE); };
  rat(wpOffset,      3127, 10000); rat(wpOffset + 8, 3290, 10000);       // D65
  rat(pcOffset,       640, 1000);  rat(pcOffset + 8,  330, 1000);        // R x,y
  rat(pcOffset + 16,  300, 1000);  rat(pcOffset + 24, 600, 1000);        // G x,y
  rat(pcOffset + 32,  150, 1000);  rat(pcOffset + 40,  60, 1000);        // B x,y

  // ── Pixel data (clamp float → uint16) ──
  let p = dataOffset;
  for (let i = 0; i < samples; i++, p += 2) {
    let v = rgb[i];
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    dv.setUint16(p, Math.round(v * 65535), LE);
  }

  // ── IFD (entries MUST be sorted by ascending tag id) ──
  let o = ifdOffset;
  dv.setUint16(o, NUM_TAGS, LE); o += 2;
  const tag = (id, type, count, value) => {
    dv.setUint16(o, id, LE);
    dv.setUint16(o + 2, type, LE);     // 3 = SHORT, 4 = LONG, 5 = RATIONAL
    dv.setUint32(o + 4, count, LE);
    dv.setUint32(o + 8, value, LE);    // inline value or offset
    o += 12;
  };
  tag(256, 4, 1, w);            // ImageWidth
  tag(257, 4, 1, h);            // ImageLength
  tag(258, 3, 3, bpsOffset);    // BitsPerSample → offset of [16,16,16]
  tag(259, 3, 1, 1);            // Compression = none
  tag(262, 3, 1, 2);            // PhotometricInterpretation = RGB
  tag(273, 4, 1, dataOffset);   // StripOffsets
  tag(277, 3, 1, 3);            // SamplesPerPixel
  tag(278, 4, 1, h);            // RowsPerStrip (one strip = full image)
  tag(279, 4, 1, dataBytes);    // StripByteCounts
  tag(284, 3, 1, 1);            // PlanarConfiguration = chunky
  tag(318, 5, 2, wpOffset);     // WhitePoint (D65)
  tag(319, 5, 6, pcOffset);     // PrimaryChromaticities (sRGB)
  tag(339, 3, 1, 1);            // SampleFormat = unsigned integer
  dv.setUint32(o, 0, LE);       // next IFD = none

  return new Blob([buf], { type: 'image/tiff' });
}

/**
 * Encode raw float RGB as a 16-bit TIFF File. Delivery is separate —
 * see deliverFiles().
 * @param {Float32Array} rgb
 * @param {number} w
 * @param {number} h
 * @param {string} filename
 * @returns {File}
 */
export function encodeTiffFile(rgb, w, h, filename) {
  return new File([encodeTiff16(rgb, w, h)], withExt(filename, '.tiff'), { type: 'image/tiff' });
}
