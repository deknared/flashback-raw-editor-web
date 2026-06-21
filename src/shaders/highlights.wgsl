// Halation highlight extraction (one scale of the desktop 1.6.5 model).
//
// Runs PRE-LUT on linear ACEScg (values can exceed 1.0). Reads interleaved RGB
// stride-3, writes an RGB "glow source" = img × sigmoid-mask × tint, which the
// caller blurs and adds back. The tint carries the scale's chroma + weight +
// user strength, so summed scales redden outward and blend additively.

struct U {
    width:     f32,
    height:    f32,
    threshold: f32,   // ACEScct-encoded gate
    _pad:      f32,   // kept so `tint` stays 16-byte aligned
    tint:      vec3f, // per-scale tint (weight · warmth · strength baked in)
    k:         f32,   // sigmoid steepness
}

// ACEScct (log) encode — halation masks in this perceptual space so the sigmoid
// gate sits at a stable "stops above mid-grey" point across exposures.
fn acescct_encode(vin: f32) -> f32 {
    let v = max(vin, 1e-10);
    if (v <= 0.0078125) { return 10.5402377416545 * v + 0.0729055341958355; }
    return (log2(v) + 9.72) / 17.52;
}

@group(0) @binding(0) var<storage, read>       src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform>             u:   U;

@compute @workgroup_size(64)
fn main_halation(@builtin(global_invocation_id) id: vec3u) {
    let W = u32(u.width);
    let H = u32(u.height);
    let pixel = id.y * 4194240u + id.x;
    if pixel >= W * H { return; }

    let base = pixel * 3u;
    let r = src[base];
    let g = src[base + 1u];
    let b = src[base + 2u];

    // Sigmoid gate on the ACEScct-encoded max channel (matches the desktop's
    // 1.6.5 halation). One scale's highlight contribution: img × mask × tint.
    // The tint carries this scale's chroma (red dominant, green/blue falling off
    // with warmth) AND its weight + the user strength, so the caller can simply
    // sum the blurred scales additively onto the image.
    let maxc = max(r, max(g, b));
    let mask = 1.0 / (1.0 + exp(-u.k * (acescct_encode(maxc) - u.threshold)));

    dst[base]      = r * mask * u.tint.x;
    dst[base + 1u] = g * mask * u.tint.y;
    dst[base + 2u] = b * mask * u.tint.z;
}
