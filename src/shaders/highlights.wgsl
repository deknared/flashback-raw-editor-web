// Highlight extraction passes used by bloom and halation.
//
// These now run PRE-LUT, on the linear ACEScg intermediate (values can exceed
// 1.0), to match the desktop pipeline (vignette → bloom → CNR, then the LUT;
// halation baked into the intermediate). `u.threshold` is therefore a LINEAR
// scene-referred value (0.18 · 2^stops), NOT a display value. Both read
// interleaved RGB (stride 3) and write an RGB "glow source" that is blurred and
// then blended back over the image (bloom = additive, halation = screen).
//
//   main_bloom    — soft brightpass: keeps colour above a luma threshold.
//   main_halation — reddish highlight glow: the highlights' own colour with
//                   green attenuated and blue removed (R + G·0.2, B=0), the
//                   characteristic red-orange of real film halation. Because it
//                   runs before the LUT, a monochrome LUT desaturates it to a
//                   neutral luminance glow (no magenta), exactly like desktop.

struct U {
    width:     f32,
    height:    f32,
    threshold: f32,
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
    // Linear brightpass: ramp from threshold to 1.3× threshold.
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
    // Mask on the max channel (matches desktop's gray = max(img, axis=2)).
    let maxc = max(r, max(g, b));
    let mask = smoothstep(u.threshold, u.threshold * 1.4, maxc) * u.strength;

    // Red-orange glow built from the highlights' OWN colour: keep R, attenuate
    // G to 0.2, drop B entirely.
    dst[base]      = r * mask;
    dst[base + 1u] = g * mask * 0.2;
    dst[base + 2u] = 0.0;
}
