/**
 * gpu.js — WebGPU device initialisation, shader loading, and compute helpers.
 * Phase 2: full GPU compute infrastructure.
 */

let _device  = null;
let _adapter = null;
let _initError = null;   // human-readable reason init() returned null (for the UI)

/** Cache of compiled shader modules, keyed by URL. */
const _moduleCache = new Map();

/** Why WebGPU init failed (null if it succeeded / hasn't run). */
export function getInitError() { return _initError; }

/**
 * Acquire an adapter, trying progressively less picky options. On hybrid-GPU or
 * driver-blocklisted machines, `powerPreference:'high-performance'` can return
 * null (the discrete GPU is unavailable) even though a default/integrated
 * adapter works — this is a common reason Chrome reports "WebGPU unavailable"
 * while Firefox/Floorp (different GPU selection) succeeds.
 * @returns {Promise<GPUAdapter|null>}
 */
async function acquireAdapter() {
  const tries = [
    { powerPreference: 'high-performance' },
    undefined,                                  // browser's default adapter
    { powerPreference: 'low-power' },
  ];
  for (const opts of tries) {
    try {
      const a = await navigator.gpu.requestAdapter(opts);
      if (a) return a;
    } catch (e) {
      console.warn('[gpu] requestAdapter threw for', opts, e);
    }
  }
  return null;
}

/**
 * Request a device with the adapter's max storage-buffer limits, falling back
 * to a default-limits device if that request is rejected (some Chrome builds
 * refuse raised limits). Never throws for the limits themselves — only a real
 * "no device" condition propagates.
 * @param {GPUAdapter} adapter
 * @returns {Promise<GPUDevice>}
 */
async function requestDeviceWithRaisedLimits(adapter) {
  const lim = adapter.limits;
  try {
    return await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
        maxBufferSize:               lim.maxBufferSize,
      },
    });
  } catch (e) {
    console.warn('[gpu] raised-limit device request failed; using default limits:', e);
    return adapter.requestDevice();
  }
}

/**
 * Initialise WebGPU. Returns the GPUDevice, or null if unsupported.
 * @returns {Promise<GPUDevice|null>}
 */
export async function init() {
  _initError = null;
  if (!navigator.gpu) {
    _initError = 'This browser has no WebGPU (navigator.gpu missing). Try Chrome/Edge 113+, or enable hardware acceleration.';
    console.warn('[gpu] WebGPU not available in this browser.');
    return null;
  }
  try {
    _adapter = await acquireAdapter();
    if (!_adapter) {
      _initError = 'No WebGPU adapter — the GPU may be blocklisted or hardware acceleration is off in the browser settings.';
      console.warn('[gpu] No WebGPU adapter found.');
      return null;
    }
    // Raise the storage-buffer limits to the adapter's max. The DEFAULT
    // maxStorageBufferBindingSize is only 128 MiB, but a non-Flashback full-res
    // export can exceed that → an oversize binding is a (non-throwing) validation
    // error that silently writes nothing (black). Requesting the hardware maximum
    // (typically ≥ 2 GiB) lets large buffers bind cleanly.
    //
    // CRITICAL: some Chrome configs REJECT requestDevice with raised limits, which
    // would otherwise take the whole app down with "WebGPU unavailable" (Firefox/
    // Floorp are more lenient). So fall back to a default-limits device on failure
    // — the app stays fully usable, and the export paths already guard against
    // buffers that exceed whatever limit we end up with (resident-size fallback).
    _device = await requestDeviceWithRaisedLimits(_adapter);
    _device.lost.then((info) => {
      console.error('[gpu] Device lost:', info.reason, info.message);
      _device = null;
      _moduleCache.clear();
      // Notify the app so it can prompt a reload instead of going silently dead.
      // (iOS can drop the GPU device when the app is backgrounded for a while.)
      // 'destroyed' is an intentional teardown (e.g. our own dispose) — skip it.
      if (info.reason !== 'destroyed' && typeof window !== 'undefined') {
        try { window.dispatchEvent(new CustomEvent('gpu-device-lost', { detail: { reason: info.reason } })); }
        catch { /* ignore */ }
      }
    });
    console.log('[gpu] WebGPU ready:', _adapter.info?.device ?? '(unknown device)');
    return _device;
  } catch (e) {
    _initError = `WebGPU init failed: ${e?.message ?? e}`;
    console.error('[gpu] Init failed:', e);
    return null;
  }
}

/** Returns the active GPUDevice, or null if not yet initialised. */
export function getDevice() { return _device; }

/** True if WebGPU is available AND the device is ready. */
export function isAvailable() { return _device !== null; }

/**
 * The largest single storage buffer (in bytes) this device can BIND in a
 * shader. Full-res export must keep each float buffer under this or the bind
 * group is invalid and the dispatch silently produces black. Returns 0 if the
 * device isn't ready yet.
 */
export function maxStorageBindingSize() {
  return _device?.limits?.maxStorageBufferBindingSize ?? 0;
}

/** Maximum workgroups dispatchable along a single dimension (WebGPU guarantee). */
export const MAX_WORKGROUPS_PER_DIM = 65535;

/**
 * Fetch, compile, and cache a WGSL shader module.
 * @param {string} url   Path to the .wgsl file (e.g. '/src/shaders/lut.wgsl')
 * @returns {Promise<GPUShaderModule>}
 */
export async function loadShaderModule(url) {
  if (!_device) throw new Error('[gpu] loadShaderModule called before init()');
  if (_moduleCache.has(url)) return _moduleCache.get(url);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[gpu] Failed to fetch shader: ${url} (${resp.status})`);
  const code = await resp.text();
  const module = _device.createShaderModule({ code, label: url });
  _moduleCache.set(url, module);
  return module;
}

/**
 * Compute dispatch dimensions for a flat array of `n` elements,
 * given a workgroup size. Respects the 65535 workgroups-per-dimension limit
 * by spilling into a second (Y) dimension. The shaders reconstruct the flat
 * index as `id.y * (MAX_WORKGROUPS_PER_DIM * wgSize) + id.x`.
 *
 * @param {number} n        Total number of elements (or pixels) to cover
 * @param {number} wgSize   Workgroup size (threads per group)
 * @returns {{ x: number, y: number }}
 */
export function dispatchSize(n, wgSize) {
  const perRowX = MAX_WORKGROUPS_PER_DIM * wgSize;     // elements covered by one Y row
  const x = Math.min(Math.ceil(n / wgSize), MAX_WORKGROUPS_PER_DIM);
  const y = Math.ceil(n / perRowX);
  return { x, y: Math.max(1, y) };
}

/**
 * Create a GPU buffer filled with a Float32Array.
 * @param {Float32Array} data
 * @param {number}       [usage]  GPUBufferUsage flags (COPY_DST is always added)
 * @returns {GPUBuffer}
 */
export function createF32Buffer(data, usage = GPUBufferUsage.STORAGE) {
  const buf = _device.createBuffer({
    size:             Math.max(4, data.byteLength),
    usage:            usage | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(buf.getMappedRange()).set(data);
  buf.unmap();
  return buf;
}

/**
 * Create an empty GPU storage buffer of `byteLength` bytes.
 * @param {number} byteLength
 * @param {number} [usage]
 * @returns {GPUBuffer}
 */
export function createEmptyBuffer(byteLength, usage = GPUBufferUsage.STORAGE) {
  return _device.createBuffer({ size: Math.max(4, byteLength), usage });
}

/**
 * Create a uniform buffer from a Float32Array (or build one from numbers).
 * Uniform buffers must be 16-byte aligned; the size is rounded up.
 * @param {Float32Array|number[]} data
 * @returns {GPUBuffer}
 */
export function createUniformBuffer(data) {
  const arr  = data instanceof Float32Array ? data : new Float32Array(data);
  const size = Math.ceil(arr.byteLength / 16) * 16;
  const buf  = _device.createBuffer({
    size,
    usage:            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(buf.getMappedRange(), 0, arr.length).set(arr);
  buf.unmap();
  return buf;
}

/** Create a uniform buffer from raw u32 values (e.g. width/height/lut_size). */
export function createU32Uniform(values) {
  const arr  = values instanceof Uint32Array ? values : new Uint32Array(values);
  const size = Math.ceil(arr.byteLength / 16) * 16;
  const buf  = _device.createBuffer({
    size,
    usage:            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint32Array(buf.getMappedRange(), 0, arr.length).set(arr);
  buf.unmap();
  return buf;
}

/**
 * Build (and cache nothing — caller caches) a compute pipeline.
 * @param {GPUShaderModule} module
 * @param {string}          entryPoint
 * @param {string}          [label]
 * @returns {GPUComputePipeline}
 */
export function createComputePipeline(module, entryPoint, label) {
  return _device.createComputePipeline({
    label,
    layout:  'auto',
    compute: { module, entryPoint },
  });
}

/**
 * Encode and submit a single compute pass.
 *
 * @param {GPUComputePipeline} pipeline
 * @param {GPUBindGroupEntry[]} entries   Bind group entries (binding + resource)
 * @param {{x:number,y:number}} dispatch  Workgroup counts
 * @param {GPUCommandEncoder}  [encoder]  Optional existing encoder (for batching).
 *                                        If omitted, a new encoder is created & submitted.
 */
export function runCompute(pipeline, entries, dispatch, encoder) {
  const ownEncoder = !encoder;
  const enc = encoder ?? _device.createCommandEncoder();
  const bindGroup = _device.createBindGroup({
    layout:  pipeline.getBindGroupLayout(0),
    entries,
  });
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(dispatch.x, dispatch.y, 1);
  pass.end();
  if (ownEncoder) _device.queue.submit([enc.finish()]);
}

/**
 * Read a GPU storage buffer back to a Float32Array on the CPU.
 * Allocates a temporary MAP_READ staging buffer, copies, and maps it.
 *
 * @param {GPUBuffer} buffer       Source buffer (must have COPY_SRC usage)
 * @param {number}    floatCount   Number of f32 values to read
 * @returns {Promise<Float32Array>}
 */
export async function readbackF32(buffer, floatCount) {
  const byteLength = floatCount * 4;
  const staging = _device.createBuffer({
    size:  byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = _device.createCommandEncoder();
  enc.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
  _device.queue.submit([enc.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const copy = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return copy;
}
