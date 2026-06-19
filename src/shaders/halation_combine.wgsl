// Halation combine + screen blend.
// Combines two halation glow layers and screen-blends the result onto the base
// image. Port of OP's halation_combine.wgsl logic.
//
//   combined_glow = (glow1 + glow2 * 0.6) * strength
//   out = max(0, 1 - (1-base) * (1-combined_glow))   ← screen blend

struct U {
    strength: f32,
    _pad0:    f32,
    _pad1:    f32,
    _pad2:    f32,
}

@group(0) @binding(0) var<storage, read>       base:  array<f32>;
@group(0) @binding(1) var<storage, read>       glow1: array<f32>;
@group(0) @binding(2) var<storage, read>       glow2: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst:   array<f32>;
@group(0) @binding(4) var<uniform>             u:     U;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.y * 16776960u + id.x;
    if i >= arrayLength(&base) { return; }
    let g = (glow1[i] + glow2[i] * 0.6) * u.strength;
    dst[i] = max(0.0, 1.0 - (1.0 - base[i]) * (1.0 - g));
}
