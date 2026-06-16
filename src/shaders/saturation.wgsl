// Saturation — display-space, per-pixel. Blends each pixel between its luma
// (sat 0 = greyscale) and itself (sat 1 = unchanged); sat > 1 boosts.
// Operates on interleaved RGB display data, stride 3.

@group(0) @binding(0) var<storage, read>       data_in:  array<f32>;
@group(0) @binding(1) var<storage, read_write> data_out: array<f32>;
struct P { sat: f32, _0: f32, _1: f32, _2: f32 }
@group(0) @binding(2) var<uniform> p: P;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let pixel = id.y * 4194240u + id.x;
    let base = pixel * 3u;
    if base + 2u >= arrayLength(&data_in) { return; }
    let rgb  = vec3f(data_in[base], data_in[base + 1u], data_in[base + 2u]);
    let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    let o = clamp(mix(vec3f(luma), rgb, p.sat), vec3f(0.0), vec3f(1.0));
    data_out[base]      = o.x;
    data_out[base + 1u] = o.y;
    data_out[base + 2u] = o.z;
}
