// White-balance + exposure adjustment in linear light.
// Operates element-wise on a flat f32 array (R G B interleaved, stride 3).
// Channel index c = i % 3 selects the per-channel multiplier; exposure scales all.
//
//   r_mult = 1 + (temp/1000)*0.15
//   b_mult = 1 - (temp/1000)*0.15
//   g_mult = 1 - tint*0.015
//   out = in * chMult[c] * exposure
//
// Matches FlashbackProcessor._apply_white_balance + exposure_mult.

struct Uniforms {
    r_mult:   f32,
    g_mult:   f32,
    b_mult:   f32,
    exposure: f32,
}

@group(0) @binding(0) var<storage, read>       data_in:  array<f32>;
@group(0) @binding(1) var<storage, read_write> data_out: array<f32>;
@group(0) @binding(2) var<uniform>             u:        Uniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.y * 16776960u + id.x;
    if i >= arrayLength(&data_in) { return; }

    let c    = i % 3u;
    var mult = u.r_mult;
    if c == 1u { mult = u.g_mult; }
    else if c == 2u { mult = u.b_mult; }

    data_out[i] = data_in[i] * mult * u.exposure;
}
