// Chroma noise reduction in CIE Lab — buffer-resident port of the desktop's
// cnr.wgsl (texture version). Runs PRE-LUT on linear ACEScg. Four passes:
//   main_to_lab    : linear ACEScg -> Lab (L,a,b) packed in the same RGB slots
//   main_despike   : 3x3-median outlier clamp on a*/b* (kills colour fireflies
//                    the edge-preserving bilateral would otherwise protect)
//   main_bilateral : edge-preserving bilateral on a*/b* only; L* passed through,
//                    so luminance is preserved by construction
//   main_to_acescg : Lab -> linear ACEScg
//
// Only a*/b* are filtered → removes colour noise without touching luma or
// bleeding across luma edges. Constants mirror the desktop effects.py exactly.
// Buffers are flat f32, R G B interleaved; pixel (x,y) at (y*W + x)*3.

struct U {
    w:           u32,
    h:           u32,
    sigma_space: f32,   // bilateral spatial sigma
    sigma_color: f32,   // bilateral range sigma
    radius:      f32,   // bilateral window radius
    thr_green:   f32,   // despike clamp limit for the green direction (-a*)
    thr_other:   f32,   // despike clamp limit for every other direction
    _pad:        f32,
}

@group(0) @binding(0) var<storage, read>       data_in:  array<f32>;
@group(0) @binding(1) var<storage, read_write> data_out: array<f32>;
@group(0) @binding(2) var<uniform>             u:        U;

// --- Lab <-> ACEScg constants (AP1 / D60 white) ---
const M_RGB2XYZ_0 = vec3f( 0.6624541811,  0.1340042065,  0.1561876744);
const M_RGB2XYZ_1 = vec3f( 0.2722287168,  0.6740817658,  0.0536895174);
const M_RGB2XYZ_2 = vec3f(-0.0055746495,  0.0040607335,  1.0103391685);
const M_XYZ2RGB_0 = vec3f( 1.6410233797, -0.3248032942, -0.2364246952);
const M_XYZ2RGB_1 = vec3f(-0.6636628587,  1.6153315917,  0.0167563477);
const M_XYZ2RGB_2 = vec3f( 0.0117218943, -0.0082844420,  0.9883948585);
const WHITE = vec3f(0.95265, 1.0, 1.00883);
const LAB_DELTA3: f32 = 0.00885645167;
const LAB_DELTA:  f32 = 0.20689655172;
const LAB_SLOPE:  f32 = 7.78703703704;
const LAB_OFFSET: f32 = 0.13793103448;

fn f_lab(t: f32) -> f32 {
    if t > LAB_DELTA3 { return pow(max(t, 0.0), 0.3333333333); }
    return LAB_SLOPE * t + LAB_OFFSET;
}
fn f_lab_inv(t: f32) -> f32 {
    if t > LAB_DELTA { return t * t * t; }
    return (t - LAB_OFFSET) / LAB_SLOPE;
}
fn to_lab(rgb: vec3f) -> vec3f {
    var xyz = vec3f(dot(M_RGB2XYZ_0, rgb), dot(M_RGB2XYZ_1, rgb), dot(M_RGB2XYZ_2, rgb));
    xyz = max(xyz, vec3f(0.0)) / WHITE;
    let fx = f_lab(xyz.x); let fy = f_lab(xyz.y); let fz = f_lab(xyz.z);
    return vec3f(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
fn to_acescg(lab: vec3f) -> vec3f {
    let fy = (lab.x + 16.0) / 116.0;
    let xyz = vec3f(f_lab_inv(lab.y / 500.0 + fy), f_lab_inv(fy), f_lab_inv(fy - lab.z / 200.0)) * WHITE;
    return vec3f(dot(M_XYZ2RGB_0, xyz), dot(M_XYZ2RGB_1, xyz), dot(M_XYZ2RGB_2, xyz));
}

fn px_index(x: i32, y: i32) -> u32 {
    let cx = clamp(x, 0, i32(u.w) - 1);
    let cy = clamp(y, 0, i32(u.h) - 1);
    return (u32(cy) * u.w + u32(cx)) * 3u;
}
fn load3(x: i32, y: i32) -> vec3f {
    let b = px_index(x, y);
    return vec3f(data_in[b], data_in[b + 1u], data_in[b + 2u]);
}

// 2D dispatch stride: caller dispatches ceil(w*h/64) x ceil(w*h/4194240).
fn pixel_xy(id: vec3u) -> vec2i {
    let pixel = id.y * 4194240u + id.x;
    return vec2i(i32(pixel % u.w), i32(pixel / u.w));
}
fn in_bounds(p: vec2i) -> bool { return p.x < i32(u.w) && p.y < i32(u.h) && (u32(p.y) * u.w + u32(p.x)) < (u.w * u.h); }

@compute @workgroup_size(64)
fn main_to_lab(@builtin(global_invocation_id) id: vec3u) {
    let p = pixel_xy(id);
    if !in_bounds(p) { return; }
    let lab = to_lab(load3(p.x, p.y));
    let o = (u32(p.y) * u.w + u32(p.x)) * 3u;
    data_out[o] = lab.x; data_out[o + 1u] = lab.y; data_out[o + 2u] = lab.z;
}

@compute @workgroup_size(64)
fn main_to_acescg(@builtin(global_invocation_id) id: vec3u) {
    let p = pixel_xy(id);
    if !in_bounds(p) { return; }
    let rgb = to_acescg(load3(p.x, p.y));
    let o = (u32(p.y) * u.w + u32(p.x)) * 3u;
    data_out[o] = rgb.x; data_out[o + 1u] = rgb.y; data_out[o + 2u] = rgb.z;
}

// median-of-9 selection network (value-returning swap, Naga-safe)
fn so(a: f32, b: f32) -> vec2f { return vec2f(min(a, b), max(a, b)); }
fn med9(v: array<f32, 9>) -> f32 {
    var p = v; var s: vec2f;
    s = so(p[1],p[2]); p[1]=s.x; p[2]=s.y;  s = so(p[4],p[5]); p[4]=s.x; p[5]=s.y;  s = so(p[7],p[8]); p[7]=s.x; p[8]=s.y;
    s = so(p[0],p[1]); p[0]=s.x; p[1]=s.y;  s = so(p[3],p[4]); p[3]=s.x; p[4]=s.y;  s = so(p[6],p[7]); p[6]=s.x; p[7]=s.y;
    s = so(p[1],p[2]); p[1]=s.x; p[2]=s.y;  s = so(p[4],p[5]); p[4]=s.x; p[5]=s.y;  s = so(p[7],p[8]); p[7]=s.x; p[8]=s.y;
    s = so(p[0],p[3]); p[0]=s.x; p[3]=s.y;  s = so(p[5],p[8]); p[5]=s.x; p[8]=s.y;  s = so(p[4],p[7]); p[4]=s.x; p[7]=s.y;
    s = so(p[3],p[6]); p[3]=s.x; p[6]=s.y;  s = so(p[1],p[4]); p[1]=s.x; p[4]=s.y;  s = so(p[2],p[5]); p[2]=s.x; p[5]=s.y;
    s = so(p[4],p[7]); p[4]=s.x; p[7]=s.y;  s = so(p[4],p[2]); p[4]=s.x; p[2]=s.y;  s = so(p[6],p[4]); p[6]=s.x; p[4]=s.y;
    s = so(p[4],p[2]); p[4]=s.x; p[2]=s.y;
    return p[4];
}

@compute @workgroup_size(64)
fn main_despike(@builtin(global_invocation_id) id: vec3u) {
    let p = pixel_xy(id);
    if !in_bounds(p) { return; }
    let center = load3(p.x, p.y);   // (L, a, b)
    var va: array<f32, 9>; var vb: array<f32, 9>; var idx = 0;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let s = load3(p.x + dx, p.y + dy);
            va[idx] = s.y; vb[idx] = s.z; idx++;
        }
    }
    let ma = med9(va); let mb = med9(vb);
    let a = clamp(center.y, ma - u.thr_green, ma + u.thr_other);
    let b = clamp(center.z, mb - u.thr_other, mb + u.thr_other);
    let o = (u32(p.y) * u.w + u32(p.x)) * 3u;
    data_out[o] = center.x; data_out[o + 1u] = a; data_out[o + 2u] = b;
}

@compute @workgroup_size(64)
fn main_bilateral(@builtin(global_invocation_id) id: vec3u) {
    let p = pixel_xy(id);
    if !in_bounds(p) { return; }
    let center = load3(p.x, p.y);
    let rad = i32(u.radius);
    let r2 = rad * rad;
    let cs = -0.5 / (u.sigma_space * u.sigma_space);
    let cr = -0.5 / (u.sigma_color * u.sigma_color);
    var acc = vec2f(0.0); var wsum = vec2f(0.0);
    for (var dy = -rad; dy <= rad; dy++) {
        for (var dx = -rad; dx <= rad; dx++) {
            if dx * dx + dy * dy > r2 { continue; }
            let s = load3(p.x + dx, p.y + dy);
            let ws = exp(f32(dx * dx + dy * dy) * cs);
            let da = s.y - center.y; let db = s.z - center.z;
            let wa = ws * exp(da * da * cr); let wb = ws * exp(db * db * cr);
            acc += vec2f(s.y * wa, s.z * wb); wsum += vec2f(wa, wb);
        }
    }
    let ab = acc / max(wsum, vec2f(1e-12));
    let o = (u32(p.y) * u.w + u32(p.x)) * 3u;
    data_out[o] = center.x; data_out[o + 1u] = ab.x; data_out[o + 2u] = ab.y;
}
