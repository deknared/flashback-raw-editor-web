// Neutral display transform — the upstream project's PROFILE_TONE_CURVE,
// used when no film LUT is active. The working space is linear ACEScg, so
// each pixel is first taken to linear sRGB (ACESCG_TO_LINSRGB), then the
// profile curve maps linear → display per channel: a film-like toe (deeper
// shadows than sRGB) with a soft highlight shoulder.
//
// Per-pixel (vec3), workgroup_size 64 with the standard 2D-dispatch stride
// (65535 * 64 = 4194240).

@group(0) @binding(0) var<storage, read>       data_in:  array<f32>;
@group(0) @binding(1) var<storage, read_write> data_out: array<f32>;

// ACEScg → linear sRGB (column-major constructor).
const ACESCG_TO_LINSRGB = mat3x3f(
    vec3f( 1.70505, -0.13026, -0.02400),
    vec3f(-0.62179,  1.14080, -0.12897),
    vec3f(-0.08326, -0.01055,  1.15297),
);

fn tone_curve(x: f32) -> f32 {
    var xs = array<f32, 7>(0.0, 0.02, 0.06, 0.20, 0.40, 0.78, 1.0);
    var ys = array<f32, 7>(0.0, 0.02, 0.10, 0.42, 0.70, 0.95, 1.0);
    let v = clamp(x, 0.0, 1.0);
    for (var i = 1; i < 7; i++) {
        if v <= xs[i] {
            let t = (v - xs[i - 1]) / (xs[i] - xs[i - 1]);
            return mix(ys[i - 1], ys[i], t);
        }
    }
    return 1.0;
}

// Standard sRGB OETF — the "developed raw" display transform for Natural.
fn srgb_oetf(x: f32) -> f32 {
    let v = clamp(x, 0.0, 1.0);
    if v <= 0.0031308 { return 12.92 * v; }
    return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let pixel = id.y * 4194240u + id.x;
    let base  = pixel * 3u;
    if base + 2u >= arrayLength(&data_in) { return; }

    let acescg = vec3f(data_in[base], data_in[base + 1u], data_in[base + 2u]);
    let lin    = max(ACESCG_TO_LINSRGB * acescg, vec3f(0.0));

    data_out[base]      = tone_curve(lin.x);
    data_out[base + 1u] = tone_curve(lin.y);
    data_out[base + 2u] = tone_curve(lin.z);
}

// Natural: ACEScg → linear sRGB → sRGB gamma, NO creative tone curve. This is
// the faithful developed-raw rendering the user asked "Natural" to be.
@compute @workgroup_size(64)
fn main_srgb(@builtin(global_invocation_id) id: vec3u) {
    let pixel = id.y * 4194240u + id.x;
    let base  = pixel * 3u;
    if base + 2u >= arrayLength(&data_in) { return; }

    let acescg = vec3f(data_in[base], data_in[base + 1u], data_in[base + 2u]);
    let lin    = max(ACESCG_TO_LINSRGB * acescg, vec3f(0.0));

    data_out[base]      = srgb_oetf(lin.x);
    data_out[base + 1u] = srgb_oetf(lin.y);
    data_out[base + 2u] = srgb_oetf(lin.z);
}

// ── Natural / no-LUT path (faithful desktop port) ─────────────────────────────
// The desktop's no-LUT render maps ACEScg → ProPhoto RGB, applies the v2
// PROFILE_TONE_CURVE per channel in ProPhoto's wide gamut (so highlights
// desaturate/roll off gently instead of clipping to a flat colour), then
// ProPhoto → linear sRGB → sRGB OETF. Both matrices are CAT02-adapted, matching
// colour.RGB_to_RGB(...). Column-major constructors (cols are M[*][j]).
const ACESCG_TO_PROPHOTO = mat3x3f(
    vec3f( 0.854898,  0.051821, -0.007081),
    vec3f( 0.033013,  0.936875,  0.001819),
    vec3f( 0.112089,  0.011304,  1.005262),
);
const PROPHOTO_TO_LINSRGB = mat3x3f(
    vec3f( 2.036708, -0.225834, -0.010605),
    vec3f(-0.737480,  1.223129, -0.134861),
    vec3f(-0.299228,  0.002705,  1.145466),
);

@compute @workgroup_size(64)
fn main_prophoto(@builtin(global_invocation_id) id: vec3u) {
    let pixel = id.y * 4194240u + id.x;
    let base  = pixel * 3u;
    if base + 2u >= arrayLength(&data_in) { return; }

    let acescg  = vec3f(data_in[base], data_in[base + 1u], data_in[base + 2u]);
    let prophoto = clamp(ACESCG_TO_PROPHOTO * acescg, vec3f(0.0), vec3f(1.0));
    let toned   = vec3f(tone_curve(prophoto.x), tone_curve(prophoto.y), tone_curve(prophoto.z));
    let lin     = clamp(PROPHOTO_TO_LINSRGB * toned, vec3f(0.0), vec3f(1.0));

    data_out[base]      = srgb_oetf(lin.x);
    data_out[base + 1u] = srgb_oetf(lin.y);
    data_out[base + 2u] = srgb_oetf(lin.z);
}
