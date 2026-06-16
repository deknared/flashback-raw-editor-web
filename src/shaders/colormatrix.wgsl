// Per-pixel 3x3 color matrix multiply followed by a scalar scale.
// Used in preprocess: combined (Rec2020_from_sRGB * CCM) matrix + base exposure.
// Operates on a flat f32 array of pixels (R G B interleaved, stride 3).
//
//   out = (M * vec3(r,g,b)) * scale
//
// The matrix rows are stored in row0/row1/row2 (xyz used, w ignored for alignment).

struct Uniforms {
    row0:  vec4f,
    row1:  vec4f,
    row2:  vec4f,
    scale: vec4f,   // .x = scalar scale, rest padding
}

@group(0) @binding(0) var<storage, read>       data_in:  array<f32>;
@group(0) @binding(1) var<storage, read_write> data_out: array<f32>;
@group(0) @binding(2) var<uniform>             u:        Uniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let pixel = id.y * 4194240u + id.x;
    let base  = pixel * 3u;
    if base + 2u >= arrayLength(&data_in) { return; }

    let v = vec3f(data_in[base], data_in[base + 1u], data_in[base + 2u]);
    let out = vec3f(
        dot(u.row0.xyz, v),
        dot(u.row1.xyz, v),
        dot(u.row2.xyz, v),
    ) * u.scale.x;

    data_out[base]      = out.x;
    data_out[base + 1u] = out.y;
    data_out[base + 2u] = out.z;
}
