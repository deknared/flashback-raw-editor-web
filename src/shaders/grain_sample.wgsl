// Grain tile sampler — expands a small grayscale grain tile into a full-size
// per-pixel grain buffer by tiling it across the image (Refinement B: the
// original samples 512×512 grain PNGs rather than synthesising noise).
//
// Output is interleaved RGB (stride 3) so it can be fed straight into
// grain.wgsl, which expects a grain value per element. The same scalar grain
// value is written to all three channels (monochrome grain).
//
//   tile      flat grayscale tile, length tile_w * tile_h, values in [0,1]
//   scale     tile sampling scale (GRAIN_TILE_SCALE) — <1 enlarges the grain

struct U {
    width:  f32,
    height: f32,
    tile_w: f32,
    tile_h: f32,
    scale:  f32,
    // Tiled full-res export: dst may be a horizontal STRIP. y_offset is the
    // strip's first row in the full frame so the grain tile indexes by GLOBAL
    // position and the pattern is continuous across strips (no seam).
    // Default (y_offset=0) reproduces the untiled render.
    y_offset: f32,
    _p1:    f32,
    _p2:    f32,
}

@group(0) @binding(0) var<storage, read>       tile: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst:  array<f32>;
@group(0) @binding(2) var<uniform>             u:    U;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let W  = u32(u.width);
    let H  = u32(u.height);
    let pixel = id.y * 4194240u + id.x;
    if pixel >= W * H { return; }

    let x = pixel % W;
    let y = pixel / W;
    let gy = f32(y) + u.y_offset;          // global row → continuous grain across strips

    let tw = u32(u.tile_w);
    let th = u32(u.tile_h);
    let sx = u32(f32(x) * u.scale) % tw;
    let sy = u32(gy * u.scale) % th;
    let g  = tile[sy * tw + sx];

    let base = pixel * 3u;
    dst[base]      = g;
    dst[base + 1u] = g;
    dst[base + 2u] = g;
}
