// Additive blend (halation/bloom) and unsharp mask.
// Entry points operating on flat f32 arrays.

struct UnsharpUniforms {
    strength: f32,
    _pad0:    f32,
    _pad1:    f32,
    _pad2:    f32,
}

@group(0) @binding(0) var<storage, read>       a:      array<f32>;
@group(0) @binding(1) var<storage, read>       b:      array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<uniform>             u:      UnsharpUniforms;

// Unsharp mask: image + (image - blurred) * strength
@compute @workgroup_size(256)
fn main_unsharp(@builtin(global_invocation_id) id: vec3u) {
    let i = id.y * 16776960u + id.x;
    if i >= arrayLength(&a) { return; }
    output[i] = a[i] + (a[i] - b[i]) * u.strength;
}

// Additive blend (used for bloom in linear-light/HDR space, where screen
// blend's (1-a)(1-b) form misbehaves for values >1). Clamped to >= 0.
@compute @workgroup_size(256)
fn main_add(@builtin(global_invocation_id) id: vec3u) {
    let i = id.y * 16776960u + id.x;
    if i >= arrayLength(&a) { return; }
    output[i] = max(0.0, a[i] + b[i]);
}
