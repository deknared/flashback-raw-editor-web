// Post-pipeline exposure compensation (upstream's `post_gain` step).
//
// The reverse-AE shift is applied to linear data BEFORE the LUT (changing the
// film density the LUT sees) and must be undone at the very END, in
// display-linear space: decode the sRGB transfer, multiply, re-encode. This
// keeps average brightness near camera-metered while retaining the LUT's
// denser rendering. Per-element, workgroup_size 256.

@group(0) @binding(0) var<storage, read>       data_in:  array<f32>;
@group(0) @binding(1) var<storage, read_write> data_out: array<f32>;
// gain: undoes the reverse-AE pre-shift (film only). k: the Push/Pull slider
// in [-1,1]. k>0 pushes — an endpoint-preserving S-curve (more contrast/punch
// without crushing blacks or clipping whites). k<0 pulls — fades toward grey
// (the flat, matte, low-contrast film-pull look). k=0 = no change.
// k_b_boost: extra B-only S-curve applied after the main S-curve, to compensate
// for the B channel having lower LUT contrast than the desktop reference (blue sky
// is systematically ~9 units low, blue shadows ~10 units high vs rawpy). Positive
// values add contrast to B only (lifts highlights, deepens shadows). 0 = no effect.
struct Params { gain: f32, k: f32, k_b_boost: f32, _pad1: f32 }
@group(0) @binding(2) var<uniform> params: Params;

fn srgb_eotf(x: f32) -> f32 {
    let v = clamp(x, 0.0, 1.0);
    if v <= 0.04045 { return v / 12.92; }
    return pow((v + 0.055) / 1.055, 2.4);
}

fn srgb_oetf(x: f32) -> f32 {
    let v = clamp(x, 0.0, 1.0);
    if v <= 0.0031308 { return 12.92 * v; }
    return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.y * 16776960u + id.x;
    if i >= arrayLength(&data_in) { return; }
    var d = srgb_oetf(srgb_eotf(data_in[i]) * params.gain);
    if params.k >= 0.0 {
        let s = d * d * (3.0 - 2.0 * d);   // smoothstep S-curve, preserves 0 & 1
        d = mix(d, s, params.k);
    } else {
        d = mix(d, 0.5, -params.k * 0.4);  // pull → faded matte
    }
    // B-only contrast boost (i%3==2 is blue in the RGB-interleaved flat array).
    // Adds a second independent S-curve to the blue channel only, compensating
    // for the blue channel having less contrast in our LUTs than the desktop ref.
    if (i % 3u == 2u) && (params.k_b_boost > 0.0) {
        let s_b = d * d * (3.0 - 2.0 * d);
        d = mix(d, s_b, params.k_b_boost);
    }
    data_out[i] = clamp(d, 0.0, 1.0);
}
