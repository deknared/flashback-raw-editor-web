/**
 * profile-io.js — export / import a shareable "profile" (a saved look).
 *
 * A profile is the portable form of a preset: the base vibe, the full effect
 * config, the core adjustments, and — if the look uses an imported custom LUT —
 * the LUT itself bundled inline so the file is self-contained. Built-in and
 * procedural LUTs are referenced by path only (the recipient has the same ones).
 *
 * The container is plain JSON with a `format` tag and a `schema_version` so
 * future changes can migrate forward without breaking old files. The LUT table
 * (a Float32Array, ~3.3 MB for 65³) is base64-encoded rather than written as a
 * JSON number array, which would balloon to tens of MB of text.
 */

export const PROFILE_FORMAT = 'flashback-profile';
export const PROFILE_SCHEMA_VERSION = 1;

/** Float32Array → base64 (chunked to avoid blowing the call-stack on apply). */
function f32ToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → Float32Array. */
function base64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Build the serializable profile object for the current look.
 * @param {{ name:string, baseVibe:string, config:object, adjust:object,
 *           lut?: { name:string, size:number, data:Float32Array, inputSpace?:string }|null }} look
 * @param {string} [appVersion]
 * @returns {object}
 */
export function buildProfile(look, appVersion) {
  const { name, baseVibe, config, adjust, lut } = look;
  return {
    format: PROFILE_FORMAT,
    schema_version: PROFILE_SCHEMA_VERSION,
    app_version: appVersion ?? null,
    exported_at: new Date().toISOString(),
    name,
    baseVibe,
    config,
    adjust,
    lut: lut
      ? {
          name:       lut.name,
          size:       lut.size,
          inputSpace: lut.inputSpace ?? 'srgb',
          data:       f32ToBase64(lut.data),
        }
      : null,
  };
}

/** Serialize a profile object to a pretty JSON string. */
export function serializeProfile(obj) {
  return JSON.stringify(obj, null, 2);
}

/**
 * Parse + validate profile JSON. Throws a user-friendly Error on bad input.
 * The returned `lut` (if any) is decoded back to a Float32Array.
 * @param {string} text
 * @returns {{ name:string, baseVibe:string|null, config:object, adjust:object,
 *             lut: { name:string, size:number, data:Float32Array, inputSpace:'native'|'srgb' }|null }}
 */
export function parseProfile(text) {
  let obj;
  try { obj = JSON.parse(text); }
  catch { throw new Error('not a valid profile file'); }

  if (!obj || obj.format !== PROFILE_FORMAT) throw new Error('not a Flashback profile');
  if (typeof obj.schema_version !== 'number' || obj.schema_version > PROFILE_SCHEMA_VERSION) {
    throw new Error('this profile is from a newer app version');
  }
  if (!obj.config || typeof obj.config !== 'object') throw new Error('profile is missing its look');

  const out = {
    name:     typeof obj.name === 'string' && obj.name.trim() ? obj.name.slice(0, 24) : 'Imported',
    baseVibe: typeof obj.baseVibe === 'string' ? obj.baseVibe : null,
    config:   obj.config,
    adjust:   (obj.adjust && typeof obj.adjust === 'object' && !Array.isArray(obj.adjust)) ? obj.adjust : {},
    lut:      null,
  };

  if (obj.lut && typeof obj.lut === 'object' && typeof obj.lut.data === 'string') {
    const size = obj.lut.size | 0;
    let data;
    try { data = base64ToF32(obj.lut.data); }
    catch { throw new Error('bundled LUT is corrupt'); }
    if (size > 1 && data.length === size * size * size * 3) {
      out.lut = {
        name:       (typeof obj.lut.name === 'string' && obj.lut.name.trim() ? obj.lut.name : 'lut').slice(0, 24),
        size,
        data,
        inputSpace: obj.lut.inputSpace === 'native' ? 'native' : 'srgb',
      };
    } else {
      throw new Error('bundled LUT has an unexpected size');
    }
  }
  return out;
}
