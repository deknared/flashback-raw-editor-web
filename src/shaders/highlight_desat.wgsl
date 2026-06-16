// Highlight desaturation (baked at load, in linear Rec.2020).
//
// The original baked this in CIE-Lab via OpenCV: above a lightness threshold,
// chroma is rolled off so blown highlights desaturate toward neutral (avoids
// neon-clipped highlights after the film LUT). OpenCV/Lab isn't available in
// the browser, so this approximates it directly in linear light: compute a
// luminance-weighted "gray", then blend each channel toward that gray by an
// amount that ramps in above the threshold (Refinement E).
//
// Operates in place on interleaved RGB (stride 3), values may exceed 1.0.

struct U {
    threshold: f32,   // luminance where desaturation starts (linear)
    rolloff:   f32,   // luminance range over which it ramps to full
    amount:    f32,   // max chroma pull (0..1)
    _pad:      f32,
}

@group(0) @binding(0) var<storage, read_write> img: array<f32>;
@group(0) @binding(1) var<uniform>             u:   U;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let n = arrayLength(&img) / 3u;
    let pixel = id.y * 4194240u + id.x;
    if pixel >= n { return; }

    let base = pixel * 3u;
    let r = img[base];
    let g = img[base + 1u];
    let b = img[base + 2u];

    let y = 0.2627 * r + 0.6780 * g + 0.0593 * b;   // Rec.2020 luma
    let t = smoothstep(u.threshold, u.threshold + max(u.rolloff, 1e-4), y) * u.amount;

    img[base]      = mix(r, y, t);
    img[base + 1u] = mix(g, y, t);
    img[base + 2u] = mix(b, y, t);
}
