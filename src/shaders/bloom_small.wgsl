// Bloom pyramid — two passes matching OP's 4× downsample + upsample approach.
//
//   main_down   — 4× box downsample of the full-res src, then ACEScct luma mask.
//                 Output is the bloom source at 1/4 resolution; Gaussian blur is
//                 applied externally (sigma = max(2, max_dim/5) at small res).
//
//   main_upadd  — bilinear upsample the blurred small buffer back to full res
//                 and additively blend × strength onto the base image.
//
// Both shaders work on flat f32 RGB storage buffers (stride 3, interleaved).

// ── Down ──────────────────────────────────────────────────────────────────────

struct DownU {
    src_w:     u32,
    src_h:     u32,
    dst_w:     u32,
    dst_h:     u32,
    threshold: f32,   // ACEScct luma threshold (e.g. 0.585 for BLOOM_THRESHOLD_STOPS=3)
    _pad0:     f32,
    _pad1:     f32,
    _pad2:     f32,
}

@group(0) @binding(0) var<storage, read>       src_down: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst_down: array<f32>;
@group(0) @binding(2) var<uniform>             ud:       DownU;

fn luma_ap1(r: f32, g: f32, b: f32) -> f32 {
    return 0.2722 * r + 0.6741 * g + 0.0537 * b;
}

fn acescct_enc(v: f32) -> f32 {
    if v <= 0.0 { return 0.0; }
    return (log2(v) + 9.72) / 17.52;
}

@compute @workgroup_size(64)
fn main_down(@builtin(global_invocation_id) id: vec3u) {
    // Dispatched as dispatchSize(dst_w * dst_h, 64) — one thread per output pixel.
    let dpx = id.y * 4194240u + id.x;
    if dpx >= ud.dst_w * ud.dst_h { return; }
    let ox = dpx % ud.dst_w;
    let oy = dpx / ud.dst_w;

    // 4×4 box average from source (area downsample)
    var acc = vec3f(0.0);
    var cnt = 0.0;
    for (var dy: u32 = 0u; dy < 4u; dy++) {
        let sy = oy * 4u + dy;
        if sy >= ud.src_h { continue; }
        for (var dx: u32 = 0u; dx < 4u; dx++) {
            let sx = ox * 4u + dx;
            if sx >= ud.src_w { continue; }
            let si = (sy * ud.src_w + sx) * 3u;
            acc += vec3f(src_down[si], src_down[si+1u], src_down[si+2u]);
            cnt += 1.0;
        }
    }
    if cnt == 0.0 { return; }
    let px = acc / cnt;

    // ACEScct luma mask: linear ramp from threshold to 1.0.
    let lum_log = acescct_enc(luma_ap1(px.r, px.g, px.b));
    let denom   = max(0.001, 1.0 - ud.threshold);
    let mask    = clamp((lum_log - ud.threshold) / denom, 0.0, 1.0);

    let di = dpx * 3u;
    dst_down[di]      = px.r * mask;
    dst_down[di + 1u] = px.g * mask;
    dst_down[di + 2u] = px.b * mask;
}

// ── Up + Add ──────────────────────────────────────────────────────────────────

struct UpU {
    dst_w:    u32,
    dst_h:    u32,
    src_w:    u32,
    src_h:    u32,
    strength: f32,
    _pad0:    f32,
    _pad1:    f32,
    _pad2:    f32,
}

@group(0) @binding(0) var<storage, read>       base_up:  array<f32>;
@group(0) @binding(1) var<storage, read>       small_up: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst_up:   array<f32>;
@group(0) @binding(3) var<uniform>             uu:       UpU;

fn sample_small(sx: f32, sy: f32) -> vec3f {
    let W = i32(uu.src_w);
    let H = i32(uu.src_h);
    let x0 = clamp(i32(floor(sx)), 0, W - 1);
    let y0 = clamp(i32(floor(sy)), 0, H - 1);
    let x1 = clamp(x0 + 1, 0, W - 1);
    let y1 = clamp(y0 + 1, 0, H - 1);
    let fx = sx - floor(sx);
    let fy = sy - floor(sy);
    let i00 = (u32(y0) * uu.src_w + u32(x0)) * 3u;
    let i10 = (u32(y0) * uu.src_w + u32(x1)) * 3u;
    let i01 = (u32(y1) * uu.src_w + u32(x0)) * 3u;
    let i11 = (u32(y1) * uu.src_w + u32(x1)) * 3u;
    let top = mix(vec3f(small_up[i00], small_up[i00+1u], small_up[i00+2u]),
                  vec3f(small_up[i10], small_up[i10+1u], small_up[i10+2u]), fx);
    let bot = mix(vec3f(small_up[i01], small_up[i01+1u], small_up[i01+2u]),
                  vec3f(small_up[i11], small_up[i11+1u], small_up[i11+2u]), fx);
    return mix(top, bot, fy);
}

@compute @workgroup_size(64)
fn main_upadd(@builtin(global_invocation_id) id: vec3u) {
    let pixel = id.y * 4194240u + id.x;
    if pixel >= uu.dst_w * uu.dst_h { return; }

    let dx = f32(pixel % uu.dst_w);
    let dy = f32(pixel / uu.dst_w);
    // Map full-res pixel to small-buffer coordinate (bilinear).
    let sx = (dx + 0.5) * (f32(uu.src_w) / f32(uu.dst_w)) - 0.5;
    let sy = (dy + 0.5) * (f32(uu.src_h) / f32(uu.dst_h)) - 0.5;
    let bloom = sample_small(sx, sy) * uu.strength;

    let bi = pixel * 3u;
    dst_up[bi]      = max(0.0, base_up[bi]      + bloom.r);
    dst_up[bi + 1u] = max(0.0, base_up[bi + 1u] + bloom.g);
    dst_up[bi + 2u] = max(0.0, base_up[bi + 2u] + bloom.b);
}
