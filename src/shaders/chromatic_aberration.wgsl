// Chromatic aberration — radial channel separation.
//
// Scales the R channel sample slightly outward from the image centre and the
// B channel slightly inward, leaving G in place. This reproduces the radial
// colour fringing of cheap lenses (the original did this with a warpAffine
// radial zoom; here it's a per-pixel bilinear resample offset).
//
// Operates on interleaved RGB float data, stride 3, in [0,1]. Per-pixel.

struct U {
    width:    f32,
    height:   f32,
    strength: f32,   // fractional radial scale (e.g. 0.01 = 1%)
    _pad:     f32,
}

@group(0) @binding(0) var<storage, read>       src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform>             u:   U;

// Bilinear sample of channel `c` at floating (x,y) with edge clamp.
fn sample_ch(x: f32, y: f32, c: u32, W: u32, H: u32) -> f32 {
    let wi = i32(W);
    let hi = i32(H);
    let x0 = clamp(i32(floor(x)), 0, wi - 1);
    let y0 = clamp(i32(floor(y)), 0, hi - 1);
    let x1 = clamp(x0 + 1, 0, wi - 1);
    let y1 = clamp(y0 + 1, 0, hi - 1);
    let fx = x - floor(x);
    let fy = y - floor(y);
    let i00 = (u32(y0) * W + u32(x0)) * 3u + c;
    let i10 = (u32(y0) * W + u32(x1)) * 3u + c;
    let i01 = (u32(y1) * W + u32(x0)) * 3u + c;
    let i11 = (u32(y1) * W + u32(x1)) * 3u + c;
    let top = mix(src[i00], src[i10], fx);
    let bot = mix(src[i01], src[i11], fx);
    return mix(top, bot, fy);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let W = u32(u.width);
    let H = u32(u.height);
    let pixel = id.y * 4194240u + id.x;
    if pixel >= W * H { return; }

    let x = f32(pixel % W);
    let y = f32(pixel / W);
    let cx = u.width  * 0.5;
    let cy = u.height * 0.5;
    let dx = x - cx;
    let dy = y - cy;

    let sR = 1.0 + u.strength;   // R sampled from further out
    let sB = 1.0 - u.strength;   // B sampled from closer in

    let base = pixel * 3u;
    dst[base]      = sample_ch(cx + dx * sR, cy + dy * sR, 0u, W, H);
    dst[base + 1u] = src[base + 1u];
    dst[base + 2u] = sample_ch(cx + dx * sB, cy + dy * sB, 2u, W, H);
}
