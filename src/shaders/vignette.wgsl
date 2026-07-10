// Vignette — radial darkening toward the corners, with a subtle COOL shift.
//
// Runs PRE-LUT on the linear ACEScg intermediate (values may exceed 1), so it
// clamps only to >= 0 — never to 1 (an upper clamp here would crush highlights
// and wash the image). Per-pixel, interleaved RGB, stride 3.
//   d        normalised radius from centre (0 at centre, 1 at corner)
//   start    where the falloff begins (driven by `feather`)
//   v        brightness multiplier (1 → strength at the corner)
// `color_shift` cools the darkened region (red darkens a touch more, blue a
// touch less) for the mild blue periphery of real lenses — matches the desktop
// apply_vignette. NOT warm: a warm vignette tints a monochrome frame magenta.

struct U {
    width:       f32,
    height:      f32,
    strength:    f32,
    feather:     f32,
    color_shift: f32,
    // Tiled full-res export: this buffer may be a horizontal STRIP. y_offset is
    // the strip's first row in the full frame and full_height is the full frame
    // height, so the vignette centres on the WHOLE image, not the strip.
    // Defaults (y_offset=0, full_height=height) reproduce the untiled render.
    y_offset:    f32,
    full_height: f32,
    // The user's crop + straighten, so the vignette follows the FINAL frame,
    // not the uncropped sensor frame. The crop model (see main.js): rotate the
    // frame by `angle` about its centre, scale by the "cover" factor, then cut
    // the normalised rect. Mapping a source pixel through that transform gives
    // its position in the output; the vignette is computed THERE. Defaults
    // (cos=1, sin=0, cov=1, centre 0.5/0.5, half-extent 0.5/0.5) = full frame.
    crop_cos:    f32,
    crop_sin:    f32,   // sin of the straighten angle
    crop_cov:    f32,   // cover scale for that angle
    crop_cx:     f32,   // crop-centre x, fraction of frame width
    crop_cy:     f32,   // crop-centre y, fraction of frame height
    crop_hw:     f32,   // crop half-width, fraction of frame width
    crop_hh:     f32,   // crop half-height, fraction of frame height
    _p0:         f32,
    _p1:         f32,
}

@group(0) @binding(0) var<storage, read_write> img: array<f32>;
@group(0) @binding(1) var<uniform>             u:   U;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let W = u32(u.width);
    let H = u32(u.height);
    let pixel = id.y * 4194240u + id.x;
    if pixel >= W * H { return; }

    let x = f32(pixel % W);
    let y = f32(pixel / W) + u.y_offset;            // global row in the full frame
    let fullH = max(u.full_height, u.height);        // full frame height (>= strip)

    // Map this source pixel into the straightened frame (rotate about the frame
    // centre by the straighten angle, scaled by the cover factor)…
    let qx = x - u.width * 0.5;
    let qy = y - fullH   * 0.5;
    let sx = (qx * u.crop_cos - qy * u.crop_sin) * u.crop_cov + u.width * 0.5;
    let sy = (qx * u.crop_sin + qy * u.crop_cos) * u.crop_cov + fullH   * 0.5;
    // …then normalise against the CROP rect, so d=0 at the crop's centre and
    // d=1 at its corners — the vignette lands on the final frame the user sees.
    let nx = (sx - u.crop_cx * u.width) / max(u.crop_hw * u.width, 1.0);
    let ny = (sy - u.crop_cy * fullH)   / max(u.crop_hh * fullH,   1.0);
    let d  = sqrt(nx * nx + ny * ny) / 1.41421356;

    let start = 1.0 - clamp(u.feather, 0.0, 1.0);
    let fall  = smoothstep(start, 1.0, d);     // 0 at centre → 1 at corner (= edge)
    let v     = 1.0 - u.strength * fall;       // shared darkening
    let cs    = u.color_shift;

    // Cool periphery: red darkens a touch more, blue a touch less (matches the
    // desktop apply_vignette). No upper clamp — this runs in linear HDR.
    let base = pixel * 3u;
    img[base]      = max(img[base]      * (v - cs * fall),       0.0);
    img[base + 1u] = max(img[base + 1u] *  v,                    0.0);
    img[base + 2u] = max(img[base + 2u] * (v + cs * 0.4 * fall), 0.0);
}
