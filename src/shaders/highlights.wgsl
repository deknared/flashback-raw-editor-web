// Highlight extraction passes used by bloom and halation.
//
// Run PRE-LUT on linear ACEScg (values can exceed 1.0). Read interleaved RGB
// stride-3, write an RGB "glow source" that is blurred and blended back.
//
//   main_bloom    — soft brightpass for bloom (linear luma threshold).
//   main_halation — reddish highlight glow: linear max-channel smoothstep mask,
//                   glow colour (R, G·0.2, B=0) — the characteristic red-orange
//                   of real film halation. Blended additively by the caller.

struct U {
    width:     f32,
    height:    f32,
    threshold: f32,   // linear ACEScg value (0.18 · 2^stops)
    strength:  f32,
}

@group(0) @binding(0) var<storage, read>       src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform>             u:   U;

fn luma(r: f32, g: f32, b: f32) -> f32 {
    return 0.2722 * r + 0.6741 * g + 0.0537 * b;   // ACEScg (AP1) weights
}

@compute @workgroup_size(64)
fn main_bloom(@builtin(global_invocation_id) id: vec3u) {
    let W = u32(u.width);
    let H = u32(u.height);
    let pixel = id.y * 4194240u + id.x;
    if pixel >= W * H { return; }

    let base = pixel * 3u;
    let r = src[base];
    let g = src[base + 1u];
    let b = src[base + 2u];
    let mask = smoothstep(u.threshold, u.threshold * 1.3, luma(r, g, b)) * u.strength;

    dst[base]      = r * mask;
    dst[base + 1u] = g * mask;
    dst[base + 2u] = b * mask;
}

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

    // Mask on max channel — ramps from threshold to 1.4× threshold.
    let maxc = max(r, max(g, b));
    let mask = smoothstep(u.threshold, u.threshold * 1.4, maxc) * u.strength;

    // Red-orange glow: keep R, attenuate G to 20%, drop B.
    dst[base]      = r * mask;
    dst[base + 1u] = g * mask * 0.2;
    dst[base + 2u] = 0.0;
}
