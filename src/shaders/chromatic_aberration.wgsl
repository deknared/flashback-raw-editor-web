// Spectral chromatic aberration — 8-sample integration across the visible spectrum.
//
// Port of OP's ca_tex.wgsl, adapted for storage-buffer format. Models lens
// dispersion: red is anchored, blue is displaced outward from centre. Each
// spectral sample uses sc = 1/(1+strength*t), t in [0,1] (0=red, 1=blue).
// RGB band weights are Gaussians with σ=0.25. Result: smooth purple→cyan fringe
// at light/dark edges, matching real lens CA — vs the old hard 3-channel split.

struct U {
    width:    f32,
    height:   f32,
    strength: f32,   // = ca_pixels / (long_edge/2), e.g. 0.0077 for Disposable
    // Tiled full-res export: src/dst may be a horizontal STRIP. y_offset is the
    // strip's first row in the full frame; full_height is the full frame height,
    // so the radial centre is the WHOLE image. The radial math runs in GLOBAL
    // coords; buffer reads convert back to the strip's local rows.
    // Defaults (y_offset=0, full_height=height) reproduce the untiled render.
    y_offset:    f32,
    full_height: f32,
    _p0:         f32,
    _p1:         f32,
    _p2:         f32,
}

@group(0) @binding(0) var<storage, read>       src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform>             u:   U;

fn sample_rgb(x: f32, y: f32, W: u32, H: u32) -> vec3f {
    let wi = i32(W);
    let hi = i32(H);
    let x0 = clamp(i32(floor(x)), 0, wi - 1);
    let y0 = clamp(i32(floor(y)), 0, hi - 1);
    let x1 = clamp(x0 + 1, 0, wi - 1);
    let y1 = clamp(y0 + 1, 0, hi - 1);
    let fx = x - floor(x);
    let fy = y - floor(y);
    let i00 = (u32(y0) * W + u32(x0)) * 3u;
    let i10 = (u32(y0) * W + u32(x1)) * 3u;
    let i01 = (u32(y1) * W + u32(x0)) * 3u;
    let i11 = (u32(y1) * W + u32(x1)) * 3u;
    let top = mix(vec3f(src[i00], src[i00+1u], src[i00+2u]),
                  vec3f(src[i10], src[i10+1u], src[i10+2u]), fx);
    let bot = mix(vec3f(src[i01], src[i01+1u], src[i01+2u]),
                  vec3f(src[i11], src[i11+1u], src[i11+2u]), fx);
    return mix(top, bot, fy);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let W = u32(u.width);
    let H = u32(u.height);
    let pixel = id.y * 4194240u + id.x;
    if pixel >= W * H { return; }

    let x  = f32(pixel % W);              // local x == global x (full width)
    let ly = f32(pixel / W);             // local row within this strip buffer
    let fullH = max(u.full_height, u.height);
    let gy = ly + u.y_offset;            // global row in the full frame
    let cx = u.width * 0.5;
    let cy = fullH   * 0.5;              // radial centre of the WHOLE frame
    let dx = x  - cx;
    let dy = gy - cy;

    // 8 spectral samples across t ∈ [0,1]. Band weight σ=0.25 → 1/(2σ²)=8.
    var acc  = vec3f(0.0);
    var wsum = vec3f(0.0);
    for (var i: u32 = 0u; i < 8u; i++) {
        let t  = f32(i) / 7.0;
        let wR = exp(-t * t * 8.0);
        let wG = exp(-(t - 0.5) * (t - 0.5) * 8.0);
        let wB = exp(-(t - 1.0) * (t - 1.0) * 8.0);
        let w  = vec3f(wR, wG, wB);
        // Reciprocal magnification: t=0 red stays fixed, t=1 blue shrinks
        // inward at source → content displaced outward (blue fringe on periphery).
        let sc = 1.0 / (1.0 + u.strength * t);
        // Sample at the GLOBAL position, then convert the row back to this
        // strip's local space (subtract y_offset) for the buffer read.
        let s  = sample_rgb(cx + dx * sc, (cy + dy * sc) - u.y_offset, W, H);
        acc  += s * w;
        wsum += w;
    }

    let base   = pixel * 3u;
    let result = acc / wsum;
    dst[base]      = result.r;
    dst[base + 1u] = result.g;
    dst[base + 2u] = result.b;
}
