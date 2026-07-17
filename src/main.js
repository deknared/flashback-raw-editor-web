/**
 * main.js — Flashback RAW Editor PWA entry point.
 *
 * Responsibilities:
 *  - Register service worker
 *  - Wire up all UI interactions (file open, zen mode, vibe strip, sliders, effects panel)
 *  - Detect WebGPU support and show appropriate UI state
 *  - Delegate to processor (Phase 2+) when a file is loaded
 */

import { initSliders, setSliderValue } from './ui/sliders.js';
import { loadSettings, saveSettings, applyVibeOrder, initSettings, applyTheme } from './ui/settings.js';
import { encodeJpegFile, encodeTiffFile, deliverFiles } from './ui/export.js';
import { factoryStateFor, VIBE_PRESETS, DEFAULT_CONFIG } from './core/config.js';
import {
  loadOne, saveOne, hasSaved, clearOne, saveSession, loadSession,
  listPresets, savePreset, deletePreset,
} from './core/vibe-state.js';
import {
  saveLastPhoto, loadLastPhoto, clearLastPhoto, hasLastPhoto,
  saveCustomLut, listCustomLuts, getCustomLut, deleteCustomLut,
} from './core/idb.js';
import { RawDecoder } from './core/raw-decoder.js';
import { decodeImageFile } from './core/image-decoder.js';
import { init as initGPU, getInitError } from './core/gpu.js';
import { FlashbackProcessor } from './core/processor.js';
import { loadGpuLut, parseCube, uploadLut } from './core/lut.js';
import { generateLut } from './core/procedural-luts.js';
import { buildProfile, serializeProfile, parseProfile } from './core/profile-io.js';

// ─── State ────────────────────────────────────────────────────────────────────

// Per-photo default adjustments — all neutral. The One35's colour cast is now
// removed at its source by per-file Auto White Balance (from the DNG's own
// AsShotNeutral), so the sliders no longer need to be pre-loaded with a manual
// correction. The user fine-tunes from here.
function defaultAdjust() {
  return { exposure_ev: 0, wb_temp: 0, tint: 0, push_pull_ev: 0 };
}

const state = {
  settings:     loadSettings(),
  activeVibe:   'natural',
  activePresetId: null,   // id of the active custom preset, or null for a built-in vibe
  activeLutId:  null,     // id of an active user-imported LUT, or null for the vibe's own
  config:       { ...DEFAULT_CONFIG },
  adjust:       defaultAdjust(), // core sliders (persisted)
  autoWb:       true,    // per-photo Auto WB (camera as-shot WB); baked at decode
  jpegQuality:  0.95,  // runtime float 0-1; synced from state.settings.jpegQuality
  dateStamp:    false,    // burn the date into preview + JPEG (persisted)
  frameStamp:   false,    // burn the frame number (persisted)
  customDate:   null,     // 'YYYY-MM-DD' override, or null = EXIF/today (persisted)
  saturation:   1,        // global saturation (persisted)
  dateFormat:   'YYMMDD', // 'YYMMDD' | 'YYMM' (persisted)
  hasImage:     false,
  isZen:        false,
  effectsOpen:  false,
  histOpen:     false,
  crop:         { angle: 0, x: 0, y: 0, w: 1, h: 1 },  // straighten + crop (per-image)
  cropEditing:  false,    // crop editor open → preview shows the FULL frame
  _lastImageData: null,   // most recent preview ImageData (for the histogram)
  processorReady: false,
  _processor:   null,   // FlashbackProcessor instance
  _lutCache:    {},     // vibeId -> GpuLut (uploaded once per vibe)
  _queue:       [],     // all valid files from the last open (strip + batch)
  _current:     0,      // index into _queue of the photo on screen
  _perImage:    [],     // per-photo { adjust, rotation } (parallel to _queue)
  _excluded:    new Set(), // indices excluded from batch export
  _lookClipboard: null, // copied look { vibeId, adjust } — armed for paste (UI-2)
  _copySource:  -1,     // index the look was copied from (outlined; can't paste onto it)
  _selectMode:  false,  // filmstrip multi-select mode (UI-3)
  _selected:    new Set(), // selected photo indices while in select mode
  _history:     [],     // undo/redo snapshots of the current photo's edits
  _histIdx:     -1,     // pointer into _history
  _applyingHistory: false, // guard so applying a snapshot doesn't record one
};

// ─── DOM references ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const emptyState      = $('empty-state');
const loadingOverlay  = $('loading-overlay');
const loadingText     = $('loading-text');
const topBar          = $('top-bar');
const controls        = $('controls');
const filenameDisplay = $('filename-display');
const fileInput       = $('file-input');
const canvas          = $('preview-canvas');

const heroOpenBtn     = $('hero-open-btn');
const openBtn         = $('open-btn');
const rotateBtn       = $('rotate-btn');
const zenBtn          = $('zen-btn');
const histBtn         = $('hist-btn');
const histCanvas      = $('histogram');
const effectsBtn      = $('effects-btn');
const effectsPanel    = $('effects-panel');
const exportBtn       = $('export-btn');
const batchExportBtn  = $('batch-export-btn');
const formatPicker    = $('format-picker');
const resetBtn        = $('reset-btn');
const lutNameBadge    = $('lut-name-badge');

const infoBtn         = $('info-btn');
const infoBtnEmpty    = $('info-btn-empty');
const helpSheet       = $('help-sheet');
const resumeBtn       = $('resume-btn');
const vibeStrip       = $('vibe-strip');
const savePresetBtn   = $('save-preset-btn');
const progressOverlay = $('progress-overlay');
const progressFill    = $('progress-fill');
const progressTitle   = $('progress-title');
const progressSub     = $('progress-sub');
const progressCancel  = $('progress-cancel');

const vibePills = document.querySelectorAll('.vibe-pill[data-vibe]');

// ─── Service Worker Registration ─────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    // Production: register the offline cache.
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('[sw] Registered, scope:', reg.scope);

      // Update flow: a new worker installs but WAITS (sw.js no longer
      // skipWaiting's on install). Surface a banner so the user reloads when
      // they're ready, instead of swapping the bundle mid-edit. Only when a
      // controller already exists (i.e. this is an update, not first install).
      const offerUpdate = () => { if (navigator.serviceWorker.controller) showUpdateBanner(reg); };
      if (reg.waiting) offerUpdate();
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed') offerUpdate();
        });
      });
    }).catch((err) => {
      console.warn('[sw] Registration failed:', err);
    });

    // Auto-reload once when an UPDATED service worker takes control after a
    // deploy, so the page actually runs the new bundle instead of stale cached
    // code. This is what stops "I deployed but the installed PWA still shows the
    // old version" (the cause of seeing an old build's colours/bugs). We skip
    // the very first install (no prior controller) and guard against loops.
    const _hadController = !!navigator.serviceWorker.controller;
    let _swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swReloaded || !_hadController) return;
      _swReloaded = true;
      window.location.reload();
    });

    // Ask the browser to keep our cached app + LUTs from being evicted. iOS
    // otherwise clears unused PWA storage after ~7 days, which would break
    // offline launches. Best-effort — not guaranteed, but home-screen PWAs are
    // far more likely to be granted persistence.
    if (navigator.storage?.persist) {
      navigator.storage.persisted().then((already) => {
        if (already) return;
        navigator.storage.persist().then((granted) => {
          console.log(`[storage] Persistent storage ${granted ? 'granted' : 'denied'}`);
        }).catch(() => { /* unsupported — ignore */ });
      }).catch(() => { /* unsupported — ignore */ });
    }
  } else {
    // Dev: never run the SW — it caches source modules and serves stale code
    // (the cause of duplicated logs / "my edits aren't showing up"). Tear down
    // any SW + caches left over from a previous prod build or session.
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    });
    if (window.caches?.keys) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
  }
}

// Show the "update available" banner. Tapping Reload tells the waiting worker to
// activate; the controllerchange handler above then reloads into the new build.
let _updateBannerShown = false;
function showUpdateBanner(reg) {
  if (_updateBannerShown) return;
  _updateBannerShown = true;
  const activate = () => (reg.waiting ?? reg.installing)?.postMessage('skipWaiting');
  // Top banner.
  const banner = $('update-banner');
  if (banner) {
    banner.classList.remove('hidden');
    $('update-reload-btn')?.addEventListener('click', () => {
      $('update-reload-btn').textContent = 'Updating…';
      activate();
    }, { once: true });
    $('update-dismiss-btn')?.addEventListener('click', () => banner.classList.add('hidden'), { once: true });
  }
}

// ─── WebGPU Init ──────────────────────────────────────────────────────────────

(async () => {
  const device = await initGPU();
  if (!device) {
    const reason = getInitError() || 'WebGPU is unavailable on this browser/device.';
    console.warn('[app] WebGPU unavailable:', reason);
    showWebGpuHelp(reason);
    return;
  }
  console.log('[app] WebGPU available — initialising GPU pipeline.');

  state._processor = new FlashbackProcessor();
  state.processorReady = await state._processor.init();

  // Push current user settings + config into the processor.
  state._processor.setConfig(state.config);
  state.autoWb                   = defaultAutoWb();
  state._processor.cameraWb      = state.autoWb;
  state._processor.saturation    = state.saturation;
  syncUserSettingsToProcessor();

  // Upload the active vibe's LUT to the GPU.
  await ensureLutForVibe(state.activeVibe);
})();

// If the GPU device is lost (iOS can drop it after the app is backgrounded for
// a while), don't sit there dead — show a persistent one-tap reload bar. A
// dedicated element (not the shared toast) so later toasts can't inherit the
// reload click handler.
window.addEventListener('gpu-device-lost', () => {
  state.processorReady = false;
  if ($('gpu-lost-bar')) return;
  const bar = document.createElement('button');
  bar.id = 'gpu-lost-bar';
  bar.type = 'button';
  bar.textContent = 'Renderer was lost — tap to reload';
  bar.addEventListener('click', () => location.reload(), { once: true });
  document.body.appendChild(bar);
});

/**
 * Full-screen explainer when WebGPU isn't available — the app can't run without
 * it, so instead of a fleeting toast, tell the user WHY and exactly what to try
 * for their browser. (A WebGL/WASM fallback is a separate, larger effort.)
 */
function showWebGpuHelp(reason) {
  if ($('gpu-help')) return;
  const ua = navigator.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isFirefox = /Firefox/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|CriOS|FxiOS/.test(ua);
  let steps;
  if (isIOS) {
    steps = `<li>Update to <b>iOS&nbsp;17 or later</b> — WebGPU needs a recent Safari.</li>
      <li>Already on iOS&nbsp;18+? Fully close the app (swipe it away) and reopen it.</li>
      <li>Still stuck? Settings → Safari → Advanced → Feature Flags → enable <b>WebGPU</b>.</li>`;
  } else if (isFirefox) {
    steps = `<li>Open <b>about:config</b>, set <b>dom.webgpu.enabled</b> to <b>true</b>, then reload.</li>
      <li>Or open this page in <b>Chrome</b> or <b>Edge</b>, where WebGPU is on by default.</li>`;
  } else if (isSafari) {
    steps = `<li>Update to <b>macOS Sonoma or later</b> (WebGPU is on by default there).</li>
      <li>On older Safari: Develop → Feature Flags → enable <b>WebGPU</b>.</li>`;
  } else {
    steps = `<li>Turn on <b>Settings → System → "Use graphics acceleration when available"</b>, then relaunch the browser.</li>
      <li>Open <b>chrome://gpu</b> — "WebGPU" should read <i>Hardware accelerated</i>. If it's blocklisted, updating your graphics driver usually fixes it.</li>
      <li>Or try a different up-to-date Chromium browser.</li>`;
  }
  const el = document.createElement('div');
  el.id = 'gpu-help';
  el.innerHTML = `
    <div class="gpu-help-card">
      <h2>This editor needs WebGPU</h2>
      <p>Your browser couldn't start WebGPU, which the photo pipeline runs on. Here's how to enable it:</p>
      <ul>${steps}</ul>
      <p class="gpu-help-reason">Details: ${reason}</p>
      <button type="button" id="gpu-help-reload">Reload</button>
    </div>`;
  document.body.appendChild(el);
  $('gpu-help-reload')?.addEventListener('click', () => location.reload());
}

/** Mirror the slider-controlled user settings into the processor. */
function syncUserSettingsToProcessor() {
  if (!state._processor) return;
  state._processor.setSettings({ ...state.adjust });
}

// ─── Persistence ──────────────────────────────────────────────────────────────
// Remember the last vibe, its effect tweaks, and the core adjustments so the app
// reopens where you left off. Writes are debounced to avoid thrashing storage
// while dragging a slider.

let _persistTimer = null;
function persistState() {
  if (state.activePresetId) {
    // A custom preset is active — keep edits in the preset itself so the base
    // vibe's own saved tweaks are never clobbered by preset state.
    const p = listPresets().find((x) => x.id === state.activePresetId);
    if (p) {
      savePreset({ ...p, config: { ...state.config }, adjust: { ...state.adjust } });
    }
  } else {
    saveOne(state.activeVibe, state.config);
  }
  saveSession({
    v:              2,   // session schema (v2 = Natural-default era)
    activeVibe:     state.activeVibe,
    activePresetId: state.activePresetId,
    activeLutId:    state.activeLutId,
    adjust:         state.adjust,
    saturation:     state.saturation,
  });
}

/** Reset the active vibe's effects + core adjustments back to factory defaults. */
function resetCurrentVibe() {
  const vibe = state.activeVibe;
  clearOne(vibe);                                   // drop any saved tweaks
  state.config = factoryStateFor(vibe);
  state.adjust = defaultAdjust();

  syncEffectToggles();
  syncEffectSliders();
  // Re-enable push/sat bypasses in case they were disabled
  const pushCb = document.getElementById('fx-push');
  const satCb  = document.getElementById('fx-sat');
  if (pushCb) pushCb.checked = true;
  if (satCb)  satCb.checked  = true;
  syncFxBtnStates();
  const setCore = (p, v) => {
    const el = document.querySelector(`.slider-row[data-param="${p}"]`);
    if (el) setSliderValue(el, v);
  };
  setCore('exposure',  state.adjust.exposure_ev);
  setCore('wb_temp',   state.adjust.wb_temp);
  setCore('tint',      state.adjust.tint);
  setCore('push_pull', state.adjust.push_pull_ev);

  state._processor?.setConfig(state.config);
  syncUserSettingsToProcessor();
  if (state.hasImage) triggerRender(false);
  schedulePersist();
  showToast('Reset to defaults');
}
function schedulePersist() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(persistState, 400);
}

/**
 * Ensure the LUT at a path is uploaded to the GPU and attached to the
 * processor. Paths are either bundled asset URLs ("/assets/luts/x.cube") or
 * user imports ("custom:<id>", stored parsed in IndexedDB). Uploaded LUTs are
 * cached per path so switching back is instant (Refinement F).
 */
async function ensureLutByPath(path) {
  if (!state._processor || !state.processorReady || !path) return;
  let lut = state._lutCache[path];
  if (!lut) {
    try {
      if (path.startsWith('custom:')) {
        const rec = await getCustomLut(path.slice(7));
        if (!rec) throw new Error('imported LUT not found');
        // Imported LUTs are treated as display-referred sRGB/Rec.709 by default
        // (what ordinary "Photo LUTs" are authored for) so they just work; the
        // processor feeds them the Natural render instead of ACEScct. Records
        // saved before this flag existed are also creative LUTs → default 'srgb'.
        lut = uploadLut({ size: rec.size, data: rec.data }, path, rec.inputSpace ?? 'srgb');
      } else if (path.startsWith('proc:')) {
        lut = uploadLut(generateLut(path.slice(5)), path, 'native');   // generated in JS, ACEScct space
      } else {
        lut = await loadGpuLut(path, 'native');   // bundled LUTs are authored for ACEScct
      }
      state._lutCache[path] = lut;
      console.log(`[app] LUT uploaded: ${path} (size ${lut.size})`);
    } catch (err) {
      console.error(`[app] LUT load failed for ${path}:`, err);
      showToast('Could not load film LUT', 3000, true);
      return;
    }
  }
  state._processor.setLut(lut);
}

/** Ensure the LUT for the CURRENT config (vibe factory or custom override). */
async function ensureLutForVibe(vibeId) {
  const path = state.config?.lut_path ?? VIBE_PRESETS[vibeId]?.lut;
  return ensureLutByPath(path);
}

/** Human-readable LUT name for the badge, from any lut_path form. */
function lutDisplayName(path) {
  if (!path) return '—';
  if (path.startsWith('proc:'))   return path.slice(5);
  if (path.startsWith('custom:')) {
    return vibeStrip?.querySelector(`.vibe-pill.custom-lut[data-lut="${path.slice(7)}"]`)
      ?.textContent.replace(/^◆\s*/, '') ?? 'custom';
  }
  return path.split('/').pop().replace('.cube', '');
}

// ─── Vibe Selection ───────────────────────────────────────────────────────────

/**
 * Apply a vibe's config + LUT to the processor without triggering a render.
 * Used when switching photos that have a different saved vibe, so the config
 * is correct before openImage renders for the first time.
 */
async function _applyVibeConfig(vibeId) {
  if (!(vibeId in VIBE_PRESETS) || vibeId === state.activeVibe) return;
  state.activeVibe = vibeId;
  state.activePresetId = null;
  state.activeLutId = null;
  clearLutPillsActive();
  vibePills.forEach((pill) => {
    const active = pill.dataset.vibe === vibeId;
    pill.classList.toggle('active', active);
    pill.setAttribute('aria-selected', String(active));
  });
  clearCustomPillsActive();
  const factory = factoryStateFor(vibeId);
  const vibeState = hasSaved(vibeId) ? loadOne(vibeId) : null;
  state.config = vibeState
    ? { ...factory, ...vibeState, lut_path: factory.lut_path }
    : { ...factory };
  syncEffectToggles();
  syncEffectSliders();
  if (lutNameBadge) lutNameBadge.textContent = lutDisplayName(state.config.lut_path);
  state._processor?.setConfig(state.config);
  await ensureLutForVibe(vibeId);
}

function selectVibe(vibeId) {
  if (!(vibeId in VIBE_PRESETS)) return;

  state.activeVibe = vibeId;
  state.activePresetId = null;   // a built-in vibe is active, not a custom preset
  state.activeLutId = null;      // …with its own factory LUT
  clearLutPillsActive();

  // Update pill UI
  vibePills.forEach((pill) => {
    const active = pill.dataset.vibe === vibeId;
    pill.classList.toggle('active', active);
    pill.setAttribute('aria-selected', String(active));
  });
  clearCustomPillsActive();   // a built-in vibe is now active, not a preset

  // Build config: factory state → overlay with any saved user state.
  // lut_path always comes from factory — saved sessions written before a LUT
  // file was renamed/re-trained would otherwise pin a dead path forever.
  const factory = factoryStateFor(vibeId);
  const saved   = hasSaved(vibeId) ? loadOne(vibeId) : null;
  state.config  = saved
    ? { ...factory, ...saved, lut_path: factory.lut_path }
    : { ...factory };

  // Sync effect checkboxes
  syncEffectToggles();

  // Sync effect sliders
  syncEffectSliders();

  // Show the LUT name in badge
  if (lutNameBadge) lutNameBadge.textContent = lutDisplayName(state.config.lut_path);

  // Tag the current photo with this vibe so strip badge + batch export know.
  if (state._perImage[state._current]) {
    state._perImage[state._current].vibeId = vibeId;
  } else {
    state._perImage[state._current] = { vibeId };
  }
  updateThumbBadge(state._current);

  // Push config to the processor and ensure the LUT is loaded, then re-render.
  state._processor?.setConfig(state.config);
  if (state.processorReady) {
    ensureLutForVibe(vibeId).then(() => {
      if (state.hasImage) triggerRender();
    });
  }
  // A profile change is an undoable edit (it's part of the look), so record it
  // rather than resetting history. Skipped while restoring a history snapshot.
  if (!state._applyingHistory) scheduleHistory();
}

vibePills.forEach((pill) => {
  pill.addEventListener('click', () => { selectVibe(pill.dataset.vibe); schedulePersist(); });
});

// ─── Help / About sheet ───────────────────────────────────────────────────────

function openHelp()  { helpSheet?.classList.add('open'); }
function closeHelp() { helpSheet?.classList.remove('open'); }
infoBtn?.addEventListener('click', openHelp);
infoBtnEmpty?.addEventListener('click', openHelp);
helpSheet?.querySelectorAll('[data-close="help-sheet"]').forEach((el) => el.addEventListener('click', closeHelp));

// ─── What's New (patch notes) ──────────────────────────────────────────────────
const whatsNewSheet = $('whatsnew-sheet');
function openWhatsNew()  { whatsNewSheet?.classList.add('open'); }
function closeWhatsNew() { whatsNewSheet?.classList.remove('open'); }
$('whatsnew-btn-empty')?.addEventListener('click', openWhatsNew);
$('settings-whatsnew-btn')?.addEventListener('click', () => {
  $('settings-overlay')?.classList.remove('open');   // get out from under the sheet
  openWhatsNew();
});
whatsNewSheet?.querySelectorAll('[data-close="whatsnew-sheet"]').forEach((el) => el.addEventListener('click', closeWhatsNew));

// ─── Photo info (EXIF) sheet ──────────────────────────────────────────────────
// Tap the filename to see the photo's camera metadata.
const metaSheet = $('meta-sheet');
function closeMetaSheet() { metaSheet?.classList.remove('open'); }
metaSheet?.querySelectorAll('[data-close="meta-sheet"]').forEach((el) => el.addEventListener('click', closeMetaSheet));
filenameDisplay?.addEventListener('click', () => {
  if (!state.hasImage || !state._currentMeta?.length) return;
  const dl = $('meta-list');
  if (dl) dl.innerHTML = state._currentMeta
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  metaSheet?.classList.add('open');
});

/** Minimal HTML escape for metadata values (filenames can contain anything). */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Build the photo-info rows from a decode result. Only includes fields we have. */
function buildCurrentMeta(decoded, name) {
  const rows = [];
  const fmtShutter = (s) => (s >= 1 ? `${(+s).toFixed(1)}s` : `1/${Math.round(1 / s)}s`);
  const make = (decoded.make ?? '').trim();
  const model = (decoded.model ?? '').trim();
  // Many cameras put the make in the model string too — don't repeat it.
  const cam = (make && model)
    ? (model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`)
    : (make || model);
  if (cam) rows.push(['Camera', cam]);
  if (decoded.iso) rows.push(['ISO', String(Math.round(decoded.iso))]);
  if (decoded.fNumber) rows.push(['Aperture', `ƒ/${(+decoded.fNumber).toFixed(1)}`]);
  if (decoded.exposureS) rows.push(['Shutter', fmtShutter(decoded.exposureS)]);
  if (decoded.focalLength) rows.push(['Focal length', `${Math.round(decoded.focalLength)} mm`]);
  if (decoded.dateTaken) {
    rows.push(['Date', String(decoded.dateTaken).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')]);
  }
  rows.push(['File', name]);
  rows.push(['Profile', decoded.isFlashback === false
    ? (decoded.isPhoto ? 'Imported image — effects best-effort' : 'Foreign RAW — experimental')
    : 'Flashback One35']);
  return rows;
}

// ─── Custom presets ("save your look as a profile") ───────────────────────────

function clearCustomPillsActive() {
  vibeStrip?.querySelectorAll('.vibe-pill.custom').forEach((p) => {
    p.classList.remove('active');
    p.setAttribute('aria-selected', 'false');
  });
}

function renderPresetPills() {
  if (!vibeStrip || !savePresetBtn) return;
  vibeStrip.querySelectorAll('.vibe-pill.custom').forEach((el) => el.remove());
  for (const p of listPresets()) {
    const btn = document.createElement('button');
    btn.className = 'vibe-pill custom';
    btn.dataset.preset = p.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = p.name;
    let timer = null, longPressed = false;
    btn.addEventListener('pointerdown', () => {
      longPressed = false;
      timer = setTimeout(() => { longPressed = true; deletePresetFlow(p); }, 600);
    });
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('click', () => { if (!longPressed) loadPreset(p); });
    if (p.id === state.activePresetId) {
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
    }
    vibeStrip.insertBefore(btn, savePresetBtn);
  }
}

function loadPreset(p) {
  state.activeVibe = (p.baseVibe && p.baseVibe in VIBE_PRESETS) ? p.baseVibe : state.activeVibe;
  state.activePresetId = p.id;
  // lut_path from the base vibe's CURRENT factory state, not the preset blob —
  // presets saved before a LUT rename would otherwise point at a dead file.
  // User-imported LUT refs ("custom:<id>") are kept: they don't go stale on
  // deploys, and ensureLutByPath surfaces a toast if the import was deleted.
  const presetLut = p.config?.lut_path;
  const keepCustom = typeof presetLut === 'string' && presetLut.startsWith('custom:');
  state.config = {
    ...p.config,
    lut_path: keepCustom ? presetLut : factoryStateFor(state.activeVibe).lut_path,
  };
  state.activeLutId = keepCustom ? presetLut.slice(7) : null;
  clearLutPillsActive();
  markActiveLutPill();
  state.adjust = { ...defaultAdjust(), ...(p.adjust || {}) };

  // Activate the preset pill, deactivate everything else.
  vibePills.forEach((pl) => { pl.classList.remove('active'); pl.setAttribute('aria-selected', 'false'); });
  clearCustomPillsActive();
  const pill = vibeStrip?.querySelector(`.vibe-pill.custom[data-preset="${p.id}"]`);
  if (pill) { pill.classList.add('active'); pill.setAttribute('aria-selected', 'true'); }

  syncEffectToggles();
  syncEffectSliders();
  const setCore = (k, v) => { const el = document.querySelector(`.slider-row[data-param="${k}"]`); if (el) setSliderValue(el, v); };
  setCore('exposure', state.adjust.exposure_ev);
  setCore('wb_temp',  state.adjust.wb_temp);
  setCore('tint',     state.adjust.tint);

  if (lutNameBadge) lutNameBadge.textContent = lutDisplayName(state.config.lut_path);
  state._processor?.setConfig(state.config);
  syncUserSettingsToProcessor();
  if (state.processorReady) ensureLutForVibe(state.activeVibe).then(() => { if (state.hasImage) triggerRender(); });
  schedulePersist();
  if (!state._applyingHistory) scheduleHistory();   // preset selection is undoable
}

/**
 * In-app modal sheet replacing window.prompt/confirm (those are unreliable in
 * iOS standalone PWAs). Resolves with the input string (input mode), true
 * (confirm mode), or null/false when cancelled.
 *
 * `onConfirm` (if given) runs SYNCHRONOUSLY inside the confirm button's click
 * handler — required for APIs that demand fresh user activation, like
 * navigator.share (awaiting the dialog's promise would land outside it).
 * @param {{ title:string, message?:string, input?:boolean, placeholder?:string,
 *           value?:string, confirmLabel?:string, danger?:boolean,
 *           onConfirm?:() => void }} opts
 */
function showDialog(opts) {
  return new Promise((resolve) => {
    const sheet     = $('dialog-sheet');
    const titleEl   = $('dialog-title');
    const messageEl = $('dialog-message');
    const inputEl   = $('dialog-input');
    const confirmEl = $('dialog-confirm');
    const cancelEl  = $('dialog-cancel');
    const altEl     = $('dialog-alt');
    if (!sheet) { resolve(null); return; }

    titleEl.textContent = opts.title;
    messageEl.textContent = opts.message ?? '';
    messageEl.classList.toggle('hidden', !opts.message);
    inputEl.classList.toggle('hidden', !opts.input);
    inputEl.value = opts.value ?? '';
    inputEl.placeholder = opts.placeholder ?? '';
    confirmEl.textContent = opts.confirmLabel ?? 'Save';
    confirmEl.classList.toggle('danger', Boolean(opts.danger));

    // Optional secondary action button (e.g. "Import LUT" alongside "Save preset")
    if (altEl) {
      if (opts.altLabel) {
        altEl.textContent = opts.altLabel;
        altEl.classList.remove('hidden');
      } else {
        altEl.classList.add('hidden');
      }
    }

    const done = (result) => {
      sheet.classList.remove('open');
      confirmEl.onclick = cancelEl.onclick = inputEl.onkeydown = null;
      if (altEl) altEl.onclick = null;
      sheet.querySelectorAll('[data-dialog-cancel]').forEach((el) => { el.onclick = null; });
      resolve(result);
    };
    confirmEl.onclick = () => {
      try { opts.onConfirm?.(); }       // inside the click = has user activation
      finally { done(opts.input ? inputEl.value.trim() : true); }
    };
    if (altEl && opts.altLabel) {
      altEl.onclick = () => {
        try { opts.onAlt?.(); }         // inside click = has user activation for file picker
        finally { done(null); }
      };
    }
    cancelEl.onclick  = () => done(opts.input ? null : false);
    sheet.querySelectorAll('[data-dialog-cancel]').forEach((el) => {
      el.onclick = () => done(opts.input ? null : false);
    });
    inputEl.onkeydown = (e) => { if (e.key === 'Enter') done(inputEl.value.trim()); };

    sheet.classList.add('open');
    // Focus shortly after the open transition starts; still within the user
    // gesture window, so iOS shows the keyboard.
    if (opts.input) setTimeout(() => inputEl.focus(), 120);
  });
}

async function deletePresetFlow(p) {
  const ok = await showDialog({
    title: 'Delete preset',
    message: `Delete “${p.name}”? This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  deletePreset(p.id);
  if (state.activePresetId === p.id) {
    // The active look was deleted — fall back to its base vibe.
    selectVibe(state.activeVibe);
    schedulePersist();
  }
  renderPresetPills();
  showToast('Preset deleted');
}

savePresetBtn?.addEventListener('click', async () => {
  const name = await showDialog({
    title: 'Add to strip',
    message: 'Save your current look as a preset, or import a .cube LUT.',
    input: true,
    placeholder: 'Preset name',
    confirmLabel: 'Save preset',
    altLabel: 'Import LUT',
    onAlt: () => lutInput?.click(),
  });
  if (!name) return;
  const preset = {
    id: 'p' + Date.now().toString(36),
    name: name.slice(0, 24),
    baseVibe: (state.activeVibe in VIBE_PRESETS) ? state.activeVibe : 'disposable',
    config: { ...state.config },
    adjust: { ...state.adjust },
  };
  savePreset(preset);
  renderPresetPills();
  loadPreset(preset);
  showToast(`Saved “${preset.name}”`);
});

// ─── Custom LUTs (user-imported .cube files) ──────────────────────────────────
// Imported LUTs are parsed once, persisted in IndexedDB, and shown as pills in
// the vibe strip (◆-prefixed). Selecting one swaps the CURRENT vibe's colour
// transform while keeping its effects; the vibe pills restore their factory
// LUT. Long-press a LUT pill to delete it.

function clearLutPillsActive() {
  vibeStrip?.querySelectorAll('.vibe-pill.custom-lut').forEach((p) => p.classList.remove('active'));
}
function markActiveLutPill() {
  vibeStrip?.querySelectorAll('.vibe-pill.custom-lut').forEach((p) => {
    p.classList.toggle('active', p.dataset.lut === state.activeLutId);
  });
}

async function renderLutPills() {
  if (!vibeStrip || !savePresetBtn) return;
  vibeStrip.querySelectorAll('.vibe-pill.custom-lut').forEach((el) => el.remove());
  for (const rec of await listCustomLuts()) {
    const btn = document.createElement('button');
    btn.className = 'vibe-pill custom-lut';
    btn.dataset.lut = rec.id;
    btn.textContent = `◆ ${rec.name}`;
    let timer = null, longPressed = false;
    btn.addEventListener('pointerdown', () => {
      longPressed = false;
      timer = setTimeout(() => { longPressed = true; deleteLutFlow(rec); }, 600);
    });
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('click', () => { if (!longPressed) applyCustomLut(rec); });
    vibeStrip.insertBefore(btn, savePresetBtn);
  }
  markActiveLutPill();
}

async function applyCustomLut(rec) {
  state.activeLutId = rec.id;
  state.config.lut_path = `custom:${rec.id}`;
  state.config.enable_lut = true;
  const lutToggle = document.querySelector('input[data-effect="lut"]');
  if (lutToggle) lutToggle.checked = true;
  if (lutNameBadge) lutNameBadge.textContent = rec.name;
  syncFxBtnStates();
  markActiveLutPill();
  state._processor?.setConfig(state.config);
  await ensureLutByPath(state.config.lut_path);
  if (state.hasImage) triggerRender();
  schedulePersist();
  if (!state._applyingHistory) scheduleHistory();   // applying an imported LUT is undoable
}

async function deleteLutFlow(rec) {
  const ok = await showDialog({
    title: 'Delete LUT',
    message: `Delete “${rec.name}”? Presets using it will fall back to their vibe's LUT.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await deleteCustomLut(rec.id);
  delete state._lutCache[`custom:${rec.id}`];
  if (state.activeLutId === rec.id) {
    state.activeLutId = null;
    selectVibe(state.activeVibe);   // restore the vibe's factory LUT
    schedulePersist();
  }
  renderLutPills();
  showToast('LUT deleted');
}

// Import flow: hidden .cube file input, triggered from the + (add to strip) button.
const lutInput = $('lut-input');
lutInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  lutInput.value = '';
  if (!file) return;
  try {
    showLoading(`Importing ${file.name}…`);
    const parsed = parseCube(await file.text());
    const rec = {
      id:   'l' + Date.now().toString(36),
      name: file.name.replace(/\.cube$/i, '').slice(0, 24),
      size: parsed.size,
      data: parsed.data,
      // Imported LUTs are display-referred sRGB/Rec.709 by default (standard
      // Photo LUTs) — the processor bridges our ACEScg render into that space.
      inputSpace: 'srgb',
    };
    await saveCustomLut(rec);
    hideLoading();
    await renderLutPills();
    await applyCustomLut(rec);
    showToast(`Imported “${rec.name}” (${rec.size}³)`);
  } catch (err) {
    hideLoading();
    console.error('[app] LUT import failed:', err);
    showToast(`LUT import failed — ${err.message ?? 'invalid .cube?'}`, 4000, true);
  }
});

// ─── Profile export / import (share looks) ────────────────────────────────────
// A "profile" is the portable form of a look: base vibe + effect config + core
// adjustments, with any custom LUT bundled inline so the file is self-contained.
// Export downloads (or shares, on iOS) a .flashback file; import creates a new
// preset and applies it. See core/profile-io.js for the container format.

async function exportCurrentProfile() {
  const activePreset = listPresets().find((p) => p.id === state.activePresetId);
  const defaultName = activePreset?.name
    ?? vibeStrip?.querySelector(`.vibe-pill[data-vibe="${state.activeVibe}"]`)?.textContent?.trim()
    ?? state.activeVibe;
  const name = await showDialog({
    title: 'Export look',
    message: 'Name this look — it downloads as a .flashback file you can share.',
    input: true,
    placeholder: 'Look name',
    value: defaultName,
    confirmLabel: 'Export',
  });
  if (!name) return;

  // Bundle the custom LUT (with its colour-space flag) if the look uses one.
  let lut = null;
  const lutPath = state.config?.lut_path;
  if (typeof lutPath === 'string' && lutPath.startsWith('custom:')) {
    const rec = await getCustomLut(lutPath.slice(7));
    if (rec) lut = { name: rec.name, size: rec.size, data: rec.data, inputSpace: rec.inputSpace ?? 'srgb' };
  }

  const profile = buildProfile({
    name: name.slice(0, 24),
    baseVibe: (state.activeVibe in VIBE_PRESETS) ? state.activeVibe : 'disposable',
    config: { ...state.config },
    adjust: { ...state.adjust },
    lut,
  }, buildId);

  // Plain `.json` so every OS/file-picker handles, previews, and opens it; the
  // `fbrewebapp_` prefix keeps it recognisably ours without a custom extension.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'look';
  const file = new File([serializeProfile(profile)], `fbrewebapp_${slug}.json`, { type: 'application/json' });
  await deliverFiles([file]);
  showToast(`Exported “${name.slice(0, 24)}”`);
}

async function importProfileFile(file) {
  try {
    showLoading(`Importing ${file.name}…`);
    const profile = parseProfile(await file.text());

    // Bundled custom LUT → save as a fresh import and point the look at it.
    let lutPath = profile.config?.lut_path;
    if (profile.lut) {
      const rec = {
        id:         'l' + Date.now().toString(36),
        name:       profile.lut.name,
        size:       profile.lut.size,
        data:       profile.lut.data,
        inputSpace: profile.lut.inputSpace,
      };
      await saveCustomLut(rec);
      lutPath = `custom:${rec.id}`;
      await renderLutPills();
    }

    const preset = {
      id: 'p' + Date.now().toString(36),
      name: profile.name,
      baseVibe: (profile.baseVibe && profile.baseVibe in VIBE_PRESETS) ? profile.baseVibe : 'disposable',
      config: { ...profile.config, ...(lutPath ? { lut_path: lutPath } : {}) },
      adjust: { ...profile.adjust },
    };
    savePreset(preset);
    renderPresetPills();
    hideLoading();
    loadPreset(preset);
    showToast(`Imported “${preset.name}”`);
  } catch (err) {
    hideLoading();
    console.error('[app] profile import failed:', err);
    showToast(`Import failed — ${err.message ?? 'invalid profile'}`, 4000, true);
  }
}

const profileInput = $('profile-input');
profileInput?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  profileInput.value = '';
  if (file) importProfileFile(file);
});
$('settings-export-profile')?.addEventListener('click', () => {
  // Close Settings first so its sheet doesn't cover the export name dialog / share sheet.
  $('settings-overlay')?.classList.remove('open');
  exportCurrentProfile();
});
$('settings-import-profile')?.addEventListener('click', () => {
  $('settings-overlay')?.classList.remove('open');
  profileInput?.click();
});

// ─── Effects Panel Toggle ─────────────────────────────────────────────────────
// The sheet slides up OVER the bottom edge of the photo (absolute above the
// controls block), so opening it never reflows the canvas.

function setEffectsOpen(open) {
  if (!open) closeFxSliderArea();
  state.effectsOpen = open;
  effectsPanel?.classList.toggle('open', open);
  effectsBtn?.classList.toggle('active', open);
  effectsBtn?.setAttribute('aria-expanded', String(open));
}

effectsBtn?.addEventListener('click', () => setEffectsOpen(!state.effectsOpen));

// ─── FX Strip ─────────────────────────────────────────────────────────────────

const LONG_PRESS_MS = 450;
let _fxSliderBtn = null;

function closeFxSliderArea() {
  if (_fxSliderBtn) { _fxSliderBtn.classList.remove('editing'); _fxSliderBtn = null; }
  $('fx-slider-area')?.classList.remove('open');
}

function openFxSlider(btn) {
  if (_fxSliderBtn === btn) { closeFxSliderArea(); return; }
  if (_fxSliderBtn) _fxSliderBtn.classList.remove('editing');
  _fxSliderBtn = btn;
  btn.classList.add('editing');
  $('fx-slider-area')?.classList.add('open');
  document.querySelectorAll('.fx-sa-slider').forEach(s => s.classList.remove('fx-sa-active'));

  const saLabel    = $('fx-sa-label');
  const saResetBtn = $('fx-sa-reset-val');
  const saToggle   = $('fx-sa-toggle');
  const saToggleCb = $('fx-sa-toggle-cb');

  if (saLabel) saLabel.textContent = btn.querySelector('.fx-btn-label')?.textContent ?? '';

  // Show the toggle switch only for effects that have a checkbox toggle
  const toggleId = btn.dataset.toggle;
  if (toggleId && saToggle && saToggleCb) {
    const cb = document.getElementById(toggleId);
    saToggleCb.checked = cb?.checked ?? false;
    saToggle.removeAttribute('hidden');
  } else if (saToggle) {
    saToggle.setAttribute('hidden', '');
  }

  // An effect may expose more than one slider (comma-separated ids, e.g.
  // Halation → strength + warmth). Activate each so they all show.
  const ids = (btn.dataset.slider ?? '').split(',').map(s => s.trim()).filter(Boolean);
  let anyShown = false;
  for (const id of ids) {
    const slider = document.getElementById(id);
    if (slider) { slider.classList.add('fx-sa-active'); anyShown = true; }
  }
  if (anyShown) saResetBtn?.removeAttribute('hidden');
  else          saResetBtn?.setAttribute('hidden', '');
}

function toggleFxEffect(btn) {
  const toggleId = btn.dataset.toggle;
  if (!toggleId) return;
  const cb = document.getElementById(toggleId);
  if (!cb) return;
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  btn.classList.toggle('on', cb.checked);
  // Keep the slider-area toggle in sync if this effect is currently open
  if (btn === _fxSliderBtn) {
    const saCb = $('fx-sa-toggle-cb');
    if (saCb) saCb.checked = cb.checked;
  }
}

// Slider-area toggle switch: mirrors the effect's on/off state
$('fx-sa-toggle-cb')?.addEventListener('change', (e) => {
  if (!_fxSliderBtn) return;
  const toggleId = _fxSliderBtn.dataset.toggle;
  if (!toggleId) return;
  const cb = document.getElementById(toggleId);
  if (!cb) return;
  cb.checked = e.target.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  _fxSliderBtn.classList.toggle('on', e.target.checked);
});

document.querySelectorAll('.fx-btn').forEach(btn => {
  let lpTimer = null, didLong = false, didMove = false, startX = 0, startY = 0;
  btn.addEventListener('pointerdown', (e) => {
    didLong = false; didMove = false;
    startX = e.clientX; startY = e.clientY;
    lpTimer = setTimeout(() => {
      if (didMove) return;
      didLong = true;
      // Long press: toggle on/off for effects that have a toggle
      if (btn.dataset.toggle) {
        toggleFxEffect(btn);
        if (navigator.vibrate) navigator.vibrate(30);
      }
    }, LONG_PRESS_MS);
  });
  btn.addEventListener('pointermove', (e) => {
    if (!didMove && (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8)) {
      didMove = true;
      clearTimeout(lpTimer);
    }
  });
  btn.addEventListener('pointerup', () => {
    clearTimeout(lpTimer);
    if (didLong || didMove) return;
    if (btn.dataset.slider || btn.dataset.toggle) openFxSlider(btn);
  });
  btn.addEventListener('pointercancel', () => { clearTimeout(lpTimer); didMove = true; });
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(lpTimer); });
});

// Reset-to-default value in slider area
$('fx-sa-reset-val')?.addEventListener('click', () => {
  // Reset every slider currently shown (an effect may expose several).
  document.querySelectorAll('.fx-sa-slider.fx-sa-active').forEach((slider) => {
    const def = parseFloat(slider.dataset.default ?? slider.dataset.value);
    setSliderValue(slider, def);
    handleSliderChange(slider.dataset.param, def);
  });
});


function syncFxBtnStates() {
  document.querySelectorAll('.fx-btn[data-toggle]').forEach(btn => {
    const cb = document.getElementById(btn.dataset.toggle ?? '');
    if (cb) btn.classList.toggle('on', cb.checked);
  });
}

// Initialise button .on states to match default checkbox state.
syncFxBtnStates();

// ─── Effect Checkboxes ────────────────────────────────────────────────────────

document.querySelectorAll('.fx-toggle input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener('change', () => {
    const effect = cb.dataset.effect;
    if (!effect) return;   // skip proxy inputs without data-effect
    const key    = `enable_${effect === 'ca' ? 'chromatic_aberration' : effect}`;
    state.config[key] = cb.checked;
    if (state.hasImage) triggerRender();
    schedulePersist();
    scheduleHistory();
  });
});

function syncEffectToggles() {
  document.querySelectorAll('.fx-toggle input[type="checkbox"]').forEach((cb) => {
    const effect = cb.dataset.effect;
    if (!effect) return;
    const key    = `enable_${effect === 'ca' ? 'chromatic_aberration' : effect}`;
    if (key in state.config) cb.checked = Boolean(state.config[key]);
  });
  syncFxBtnStates();
}

// Auto WB is per-photo and baked in at DECODE time, so toggling it RE-DECODES the
// current photo (unlike the instant render-time effects). It carries no
// data-effect, so the generic effect-checkbox loop above skips it and this
// dedicated handler runs instead. Fires for every toggle path (button tap →
// slider-area switch, long-press, programmatic).
$('fx-autowb')?.addEventListener('change', (e) => {
  state.autoWb = e.target.checked;
  syncFxBtnStates();
  if (state._processor) state._processor.cameraWb = state.autoWb;
  if (state.hasImage) reloadCurrentPhoto();
  schedulePersist();
});

/** Reflect the current photo's Auto WB state on its button + hidden checkbox. */
function syncAutoWbUI() {
  const cb = $('fx-autowb');
  if (cb) cb.checked = !!state.autoWb;
  syncFxBtnStates();
}

// Push bypass: toggle off → pass 0 to processor; toggle on → restore actual value.
// The slider always shows state.adjust.push_pull_ev (unchanged by bypass).
$('fx-push')?.addEventListener('change', (e) => {
  if (state._processor)
    state._processor.setSettings({ push_pull_ev: e.target.checked ? (state.adjust.push_pull_ev ?? 0) : 0 });
  syncFxBtnStates();
  if (state.hasImage) triggerRender();
});

// Saturation bypass: same pattern.
$('fx-sat')?.addEventListener('change', (e) => {
  if (state._processor) state._processor.saturation = e.target.checked ? state.saturation : 1.0;
  syncFxBtnStates();
  if (state.hasImage) triggerRender();
});

// ─── Sliders ──────────────────────────────────────────────────────────────────

function handleSliderChange(param, value) {
  const keyMap = {
    exposure:         '_exposure_ev',
    wb_temp:          '_wb_temp',
    tint:             '_tint',
    push_pull:        '_push_pull_ev',
    grain_strength:   'grain_strength',
    halation_strength:'halation_strength',
    ca_strength:      'ca_strength',
    softness_sigma:   'softness_sigma',
    sharpen_strength: 'sharpen_strength',
    vignette_strength:'vignette_strength',
    bloom_strength:   'bloom_strength',
    cnr_sigma:        'cnr_sigma',
  };
  if (param === 'saturation') {
    state.saturation = value;
    if (state._processor && document.getElementById('fx-sat')?.checked !== false)
      state._processor.saturation = value;
    if (state.hasImage) triggerRender();
    schedulePersist();
    scheduleHistory();
    return;
  }
  const key = keyMap[param] ?? param;
  if (key.startsWith('_')) {
    const userKey = key.slice(1);
    state.adjust[userKey] = value;
    if (state._processor) {
      const bypassed = userKey === 'push_pull_ev' && document.getElementById('fx-push')?.checked === false;
      if (!bypassed) state._processor.setSettings({ [userKey]: value });
    }
  } else {
    state.config[key] = value;
  }
  if (state.hasImage) triggerRender();
  schedulePersist();
  scheduleHistory();
}

initSliders(document, handleSliderChange);

applyVibeOrder(vibeStrip, state.settings.vibeOrder);

initSettings(state, {
  onSettingsChange(settings) {
    if (settings.reduceMotion) document.body.classList.add('reduce-motion');
    else document.body.classList.remove('reduce-motion');
    applyTheme(settings.theme ?? 'dark');
    if (typeof settings.jpegQuality === 'number') {
      state.jpegQuality = settings.jpegQuality / 100;
    }
    state.dateStamp  = !!settings.dateStamp;
    state.frameStamp = !!settings.frameStamp;
    state.dateFormat = settings.dateFormat  ?? 'YYMMDD';
    state.autoDateFromFile = settings.autoDateFromFile ?? true;
    state.customDate = settings.customDate  ?? null;
    if (state.hasImage) triggerRender(false);
  },
  onVibeOrderChange(order) {
    applyVibeOrder(vibeStrip, order);
  },
});
// Init jpegQuality and stamp state from settings
state.jpegQuality = (state.settings.jpegQuality ?? 95) / 100;
state.dateStamp  = !!state.settings.dateStamp;
state.frameStamp = !!state.settings.frameStamp;
state.dateFormat = state.settings.dateFormat ?? 'YYMMDD';
state.autoDateFromFile = state.settings.autoDateFromFile ?? true;
state.customDate = state.settings.customDate ?? null;

if (state.settings.reduceMotion) document.body.classList.add('reduce-motion');
applyTheme(state.settings.theme ?? 'dark');

function syncEffectSliders() {
  const paramToConfig = {
    grain_strength:    state.config.grain_strength,
    halation_strength: state.config.halation_strength,
    halation_warmth_pct: state.config.halation_warmth_pct,
    ca_strength:       state.config.ca_strength,
    softness_sigma:    state.config.softness_sigma,
    sharpen_strength:  state.config.sharpen_strength,
    vignette_strength: state.config.vignette_strength,
    bloom_strength:    state.config.bloom_strength,
  };
  document.querySelectorAll('.slider-mini, .slider-row').forEach((el) => {
    const param = el.dataset.param;
    if (param && param in paramToConfig) {
      const v = paramToConfig[param];
      setSliderValue(el, v);
      el.dataset.default = String(v);
    }
  });
  // Push/Pull lives in state.adjust, not config
  const pushEl = document.getElementById('fx-sm-push');
  if (pushEl) {
    const pv = state.adjust.push_pull_ev ?? 0;
    setSliderValue(pushEl, pv);
    pushEl.dataset.default = String(pv);
  }
}

// ─── Zen Mode ─────────────────────────────────────────────────────────────────

zenBtn?.addEventListener('click', toggleZen);

// Tap canvas to toggle zen when image is loaded. A press-and-hold (compare
// gesture) sets _suppressClick so the release doesn't also toggle zen.
canvas?.addEventListener('click', () => {
  if (_suppressClick) { _suppressClick = false; return; }
  if (zoom.scale > 1.01) return;                 // tapping while zoomed shouldn't toggle zen
  if (state.effectsOpen) { setEffectsOpen(false); return; }  // tap photo = dismiss sheet
  if (state.hasImage) toggleZen();
});

// ─── Before/after compare (press & hold) ──────────────────────────────────────
// Hold the photo to peek at the developed frame with no film LUT, effects, or
// adjustments; release to return to your edit.

let _compareTimer = null;
let _comparing    = false;
let _suppressClick = false;

// Zoom/pan state (managed by the pinch-zoom handlers below).
const zoom = { scale: 1, tx: 0, ty: 0 };

// (Compare works with the effects panel open too — the photo stays visible
// while adjusting, and checking against the original mid-tweak is the point.)
canvas?.addEventListener('pointerdown', (e) => {
  if (!state.hasImage || !state.processorReady) return;
  if (zoom.scale > 1.01) return;                 // zoomed → that's pan, not compare
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  clearTimeout(_compareTimer);
  _compareTimer = setTimeout(async () => {
    _comparing = true;
    try {
      const orig = await state._processor.renderPreview({ downscale: false, original: true });
      if (orig && _comparing) await drawToCanvas(orig);
    } catch (err) {
      console.error('[app] compare render error:', err);
    }
  }, 240);
});

function endCompare() {
  clearTimeout(_compareTimer);
  if (!_comparing) return;
  _comparing = false;
  _suppressClick = true;                         // swallow the release "click"
  setTimeout(() => { _suppressClick = false; }, 350); // …but don't get stuck
  triggerRender(false);                          // restore the edited view
}
canvas?.addEventListener('pointerup', endCompare);
canvas?.addEventListener('pointercancel', endCompare);
canvas?.addEventListener('pointerleave', endCompare);

// ─── Pinch-to-zoom + pan ──────────────────────────────────────────────────────
// Two fingers zoom (around centre); one finger pans when zoomed; double-tap
// while zoomed snaps back to fit. Applied as a CSS transform on the canvas, so
// it survives re-renders (which only repaint the canvas content).

let _pinchDist = 0, _pinchScale = 1;
let _panX = 0, _panY = 0, _panTx = 0, _panTy = 0;
let _lastTap = 0, _moved = false;

function applyZoom() {
  const maxX = (zoom.scale - 1) * canvas.clientWidth  / 2;
  const maxY = (zoom.scale - 1) * canvas.clientHeight / 2;
  zoom.tx = Math.max(-maxX, Math.min(maxX, zoom.tx));
  zoom.ty = Math.max(-maxY, Math.min(maxY, zoom.ty));
  canvas.style.transform = (zoom.scale === 1 && zoom.tx === 0 && zoom.ty === 0)
    ? ''
    : `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
}
function resetZoom() { zoom.scale = 1; zoom.tx = 0; zoom.ty = 0; applyZoom(); }
function touchDist(t) {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
}

canvas?.addEventListener('touchstart', (e) => {
  if (!state.hasImage) return;
  if (e.touches.length === 2) {
    clearTimeout(_compareTimer);
    if (_comparing) endCompare();
    _pinchDist  = touchDist(e.touches);
    _pinchScale = zoom.scale;
    _moved = true;
    e.preventDefault();
  } else if (e.touches.length === 1) {
    _moved = false;
    if (zoom.scale > 1) {
      _panX = e.touches[0].clientX; _panY = e.touches[0].clientY;
      _panTx = zoom.tx; _panTy = zoom.ty;
    }
  }
}, { passive: false });

canvas?.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && _pinchDist > 0) {
    zoom.scale = Math.min(6, Math.max(1, _pinchScale * (touchDist(e.touches) / _pinchDist)));
    if (zoom.scale === 1) { zoom.tx = 0; zoom.ty = 0; }
    _moved = true;
    applyZoom();
    // Pinch zooms within the photo region only — it no longer auto-enters zen
    // (fullscreen). Zen stays an explicit gesture (zen button, or tap at 1×).
    e.preventDefault();
  } else if (e.touches.length === 1 && zoom.scale > 1) {
    zoom.tx = _panTx + (e.touches[0].clientX - _panX);
    zoom.ty = _panTy + (e.touches[0].clientY - _panY);
    _moved = true;
    applyZoom();
    e.preventDefault();
  }
}, { passive: false });

canvas?.addEventListener('touchend', (e) => {
  if (e.touches.length > 0) return;              // wait for all fingers to lift
  _pinchDist = 0;
  if (zoom.scale <= 1.02) { resetZoom(); _moved = false; return; }
  // Zoomed: a double-tap (two quick taps, no pan) snaps back to fit.
  if (!_moved) {
    const now = Date.now();
    if (now - _lastTap < 300) { _lastTap = 0; resetZoom(); }
    else _lastTap = now;
  }
  _moved = false;
}, { passive: false });

// Belt-and-suspenders against iOS page zoom (Safari can ignore user-scalable):
// block multi-finger pinch-zoom of the PAGE and double-tap-zoom. The photo's
// own pinch/zoom is on the canvas via touch events and is unaffected.
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
let _lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - _lastTouchEnd < 300) e.preventDefault();   // double-tap → no page zoom
  _lastTouchEnd = now;
}, { passive: false });

function toggleZen() {
  state.isZen = !state.isZen;
  document.body.classList.toggle('zen', state.isZen);
  // Reading clientWidth below forces the relayout, then we redraw the cached
  // frame at the new size in the SAME step — no stretch/squash while resizing.
  relayoutCanvas();
  if (state.isZen) showToast('Full screen — tap photo to exit', 1600);
}

// ─── Histogram (opt-in) ───────────────────────────────────────────────────────

const clipBtn = $('clip-btn');

histBtn?.addEventListener('click', () => {
  state.histOpen = !state.histOpen;
  histCanvas?.classList.toggle('hidden', !state.histOpen);
  histBtn.classList.toggle('active', state.histOpen);
  histBtn.setAttribute('aria-pressed', String(state.histOpen));
  // The clipping toggle rides with the histogram. Closing the histogram also
  // turns clipping off so the overlay can't linger invisibly.
  clipBtn?.classList.toggle('hidden', !state.histOpen);
  if (!state.histOpen && state.clipWarn) {
    state.clipWarn = false;
    clipBtn?.classList.remove('active');
    clipBtn?.setAttribute('aria-pressed', 'false');
    if (state._lastImageData) drawToCanvas(state._lastImageData);
  }
  if (state.histOpen && state._lastImageData) drawHistogram(state._lastImageData);
});

// Clipping warnings: paint blown highlights red and crushed shadows blue on the
// preview, so over/under-exposure is obvious. Toggled with the histogram open.
clipBtn?.addEventListener('click', () => {
  state.clipWarn = !state.clipWarn;
  clipBtn.classList.toggle('active', state.clipWarn);
  clipBtn.setAttribute('aria-pressed', String(state.clipWarn));
  if (state._lastImageData) drawToCanvas(state._lastImageData);
});

/** Return a copy of `img` with clipped pixels painted: blown highlights red,
 *  crushed shadows blue. Used only when the clipping warning is on. */
function paintClipping(img) {
  const src = img.data;
  const out = new Uint8ClampedArray(src);   // clone — never touch the source/histogram data
  for (let i = 0; i < out.length; i += 4) {
    const mx = Math.max(out[i], out[i + 1], out[i + 2]);
    if (mx >= 250)      { out[i] = 255; out[i + 1] = 45;  out[i + 2] = 45;  }  // blown highlight
    else if (mx <= 4)   { out[i] = 60;  out[i + 1] = 120; out[i + 2] = 255; }  // crushed shadow
  }
  return new ImageData(out, img.width, img.height);
}

/** Draw an RGB histogram from an ImageData onto the small overlay canvas. */
function drawHistogram(imageData) {
  if (!histCanvas) return;
  const W = histCanvas.width, H = histCanvas.height;   // 256 × 128 backing store
  const ctx = histCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const d = imageData.data;
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
  // Subsample large previews so this stays cheap (only runs when the panel is open).
  const pxCount = imageData.width * imageData.height;
  const step = pxCount > 400000 ? 4 : 1;
  const stride = 4 * step;
  for (let i = 0; i < d.length; i += stride) { r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++; }

  let max = 1;
  for (let i = 0; i < 256; i++) { if (r[i] > max) max = r[i]; if (g[i] > max) max = g[i]; if (b[i] > max) max = b[i]; }
  const y = (v) => H - H * Math.sqrt(v / max);   // sqrt scale reads better than linear

  ctx.globalCompositeOperation = 'lighter';      // additive so overlaps go white
  const channel = (arr, color) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo(i * (W / 256), y(arr[i]));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  channel(r, 'rgba(255,70,70,0.55)');
  channel(g, 'rgba(70,230,90,0.55)');
  channel(b, 'rgba(90,130,255,0.6)');
  ctx.globalCompositeOperation = 'source-over';
}

// ─── Rotate ───────────────────────────────────────────────────────────────────

rotateBtn?.addEventListener('click', () => {
  if (!state.hasImage || !state.processorReady) return;
  state._processor.rotateClockwise();
  resetZoom();
  triggerRender(false);
});

$('rotate-left-btn')?.addEventListener('click', () => {
  if (!state.hasImage || !state.processorReady) return;
  state._processor.rotateCounterClockwise();
  resetZoom();
  triggerRender(false);
});

// Date stamp toggle + frame-number toggle (burn into preview + JPEG exports).
const dateInput = $('settings-date-input');
function refreshStampBadges() {
  // The date chip is a real <input type="date"> — show the effective date so
  // tapping it opens the native picker pre-filled.
  if (dateInput && !dateInput.value) {
    const [y, mo, da] = effectiveDateParts();
    dateInput.value = `${y}-${mo}-${da}`;
  }
  const fb = $('frame-badge'); if (fb) fb.textContent = state.hasImage ? frameStampText() : '—';
}

// The date chip opens the native iOS picker on tap (a visible date input, not
// a hidden one + showPicker() — that silently no-ops in a standalone PWA).
dateInput?.addEventListener('change', () => {
  state.customDate = dateInput.value || null;
  state.settings.customDate = state.customDate;
  saveSettings(state.settings);
  if (state.hasImage) triggerRender(false);
});

// ─── File Open ────────────────────────────────────────────────────────────────

/**
 * Open the file picker. On desktop Chromium the File System Access API
 * (showOpenFilePicker) remembers the last-used folder automatically when given
 * a stable `id`, so the dialog re-opens where the user last browsed. iOS Safari
 * lacks the API → fall back to the <input>, where the OS sandbox makes path
 * persistence impossible anyway. Must run inside the click gesture, so the
 * picker call is the first statement (no await before it).
 */
async function openFiles() {
  if (window.showOpenFilePicker) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        id: 'flashback-dng',          // browser persists THIS id's directory
        multiple: true,
        types: [{
          description: 'RAW photo (DNG, CR2/CR3, NEF, ARW, RAF, …)',
          // One MIME bucket carrying every RAW extension — keeps the picker's
          // file filter in sync with RAW_RE without enumerating per-vendor MIMEs.
          accept: { 'image/x-dcraw': RAW_EXTS.map((e) => '.' + e) },
        }],
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;          // user cancelled
      console.warn('[open] showOpenFilePicker unavailable, using input:', err);
      fileInput.click();
      return;
    }
    const files = await Promise.all(handles.map((h) => h.getFile()));
    if (files.length) await handleFiles(files);
    return;
  }
  fileInput.click();
}

heroOpenBtn?.addEventListener('click', openFiles);
openBtn?.addEventListener('click',     openFiles);

fileInput?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files ?? []);
  if (!files.length) return;
  await handleFiles(files);
  fileInput.value = ''; // allow selecting the same file again
});

// Drag-and-drop on the canvas (works on iPad / desktop)
canvas?.addEventListener('dragover', (e) => { e.preventDefault(); });
canvas?.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) await handleFiles(files);
});

// Foreign RAW formats LibRaw can decode, beyond the native One35 DNG. The film
// looks are calibrated for the One35 sensor, so these are BEST-EFFORT — an
// experimental notice fires the first time a non-One35 file is opened.
const RAW_EXTS = [
  'dng', 'tif', 'tiff',                               // native + TIFF
  'cr2', 'cr3', 'crw',                                // Canon
  'nef', 'nrw',                                       // Nikon
  'arw', 'sr2', 'srf',                                // Sony
  'raf',                                              // Fujifilm
  'rw2',                                              // Panasonic
  'orf',                                              // Olympus / OM
  'pef',                                              // Pentax
  'srw',                                              // Samsung
  'dcr', 'kdc',                                       // Kodak
  'mrw',                                              // Minolta
  'mos', 'iiq',                                       // Leaf / Phase One
  '3fr', 'fff',                                       // Hasselblad
  'erf',                                              // Epson
  'rwl',                                              // Leica
  'gpr',                                              // GoPro
  'raw',                                              // generic
];
const RAW_RE = new RegExp('\\.(' + RAW_EXTS.join('|') + ')$', 'i');

// Finished images: developed, display-referred. No film development possible —
// they get the "effects-only" path (linearise → Natural render → optical effects).
const PHOTO_EXTS = ['jpg', 'jpeg', 'jpe', 'png', 'webp'];
const PHOTO_RE = new RegExp('\\.(' + PHOTO_EXTS.join('|') + ')$', 'i');

/** True if `name` is a finished image (JPEG/PNG/WebP), not a RAW. */
function isPhotoFile(name) { return PHOTO_RE.test(name); }

/** Decode either a RAW (LibRaw) or a finished image (effects-only), by name. */
async function decodeSource(buffer, name, decoder, cameraWb = false) {
  if (isPhotoFile(name)) {
    return decodeImageFile(buffer, { maxEdge: IS_IOS ? 2048 : 4096 });
  }
  return (decoder ?? new RawDecoder()).decode(buffer, { cameraWb: !!cameraWb });
}

/** Default Auto WB state for a freshly-opened photo (global setting, default on). */
function defaultAutoWb() { return state.settings?.autoWbDefault ?? true; }

/** The Auto WB choice for queue slot `i`: the live value for the current photo,
 *  else that photo's saved per-image value (falling back to the global default). */
function autoWbFor(i) {
  if (typeof i !== 'number' || i === state._current) return state.autoWb;
  return state._perImage?.[i]?.autoWb ?? defaultAutoWb();
}

async function handleFiles(files) {
  // Accept any LibRaw-decodable RAW (native One35 DNG + foreign formats) plus
  // finished images (JPEG/PNG/WebP) for the effects-only path.
  const valid = files.filter((f) => RAW_RE.test(f.name) || PHOTO_RE.test(f.name));
  if (!valid.length) {
    showToast('Please open a RAW photo (DNG, CR2/CR3, NEF, ARW, RAF …) or a JPEG', 3500, true);
    return;
  }

  // Remember the whole selection: the first file opens in the editor, the rest
  // are reachable from the photo strip and included in batch export.
  valid.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  state._queue = valid;
  state._current = 0;
  state._perImage = valid.map(() => ({ vibeId: state.activeVibe }));
  _pixelCache.clear();
  _previewCache.clear();
  updateBatchButton();
  renderPhotoStrip();

  // Fresh photos start with fresh adjustments — sliders centred on 0 (the
  // per-image model: adjustments belong to a photo, not to the session).
  state.adjust = defaultAdjust();
  state.crop = defaultCropRect();
  state.autoWb = defaultAutoWb();      // Auto WB default for new photos (global setting)
  if (state._processor) state._processor.cameraWb = state.autoWb;
  syncAutoWbUI();
  _syncCoreSliders();
  syncUserSettingsToProcessor();

  await openImage(valid[0], valid[0].name, { queueIndex: 0 });
  resetHistory();     // fresh undo history for the just-opened photo
  generateThumbs();   // background — decodes the rest once, thumbs + cache
}

/**
 * Re-decode + redraw the photo on screen. Used when a setting that's baked in at
 * DECODE time changes (e.g. Camera WB), where a plain re-render isn't enough.
 * Clears the decoded-pixel caches so the new setting actually takes effect.
 */
async function reloadCurrentPhoto() {
  if (!state.hasImage || !state._processor) return;
  const files = state._queue ?? [];
  const i = state._current ?? 0;
  // Invalidate only THIS photo's caches so the re-decode picks up the new
  // decode-time setting (others keep their cached decodes).
  _pixelCache.delete(i);
  _previewCache.delete(i);
  if (files[i]) {
    await openImage(files[i], files[i].name, { queueIndex: i });
  } else if (state._processor._origBuffer) {
    // Resumed single photo (no queue File) — re-decode from the retained bytes.
    await openImage(state._processor._origBuffer, state._processor.currentFile ?? 'photo', {});
  }
}

// ─── Photo strip (multi-file navigation) ──────────────────────────────────────
// Mirrors the original desktop app's filmstrip: thumbnails of every loaded
// photo, tap to switch. Exposure/WB/tint and rotation are remembered per photo
// (the original's ImageAdjustments travel with the image the same way).

const photoStrip = $('photo-strip');

const VIBE_ABBR = {
  natural: 'NT', disposable: 'DP', point_shoot: 'PS',
  rangefinder: 'RF', monochrome: 'MN', flashback_v1: 'V1',
};

function renderPhotoStrip() {
  if (!photoStrip) return;
  photoStrip.innerHTML = '';
  const files = state._queue ?? [];
  if (files.length < 2) { photoStrip.classList.add('hidden'); return; }
  files.forEach((f, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const excludedClass = state._excluded.has(i) ? ' excluded' : '';
    const selectedClass = state._selected.has(i) ? ' selected' : '';
    const sourceClass   = (i === state._copySource) ? ' copy-source' : '';
    btn.className = 'strip-thumb' + (i === state._current ? ' active' : '') + excludedClass + selectedClass + sourceClass;
    btn.title = f.name;
    btn.setAttribute('aria-label', `Photo ${i + 1}: ${f.name}`);
    const cvs = document.createElement('canvas');
    cvs.width = 88; cvs.height = 60;
    btn.appendChild(cvs);
    const idx = document.createElement('span');
    idx.className = 'strip-idx';
    idx.textContent = String(i + 1);
    btn.appendChild(idx);
    const badge = document.createElement('span');
    badge.className = 'strip-vibe';
    const vid = state._perImage[i]?.vibeId ?? state.activeVibe;
    badge.textContent = VIBE_ABBR[vid] ?? vid.slice(0, 2).toUpperCase();
    btn.appendChild(badge);
    let _suppressSelect = false;
    btn.addEventListener('click', () => {
      if (_suppressSelect) { _suppressSelect = false; return; }
      if (state._selectMode) { toggleSelected(i); return; }   // select instead of navigate
      selectPhoto(i);
    });
    // Long-press → toggle exclude/include from batch
    // Swipe up → drag animation + floating confirmation dialog to remove
    let _pressTimer = null, _tStartX = 0, _tStartY = 0, _tMoved = false, _tDragging = false;
    const _resetBtnTransform = () => {
      btn.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
      btn.style.transform = '';
      btn.style.opacity = '';
      _tDragging = false;
    };
    btn.addEventListener('touchstart', (e) => {
      _tStartX = e.touches[0].clientX;
      _tStartY = e.touches[0].clientY;
      _tMoved = false; _tDragging = false;
      btn.style.transition = 'none';
      _pressTimer = setTimeout(() => {
        if (state._selectMode) return;   // long-press exclude is disabled while selecting
        if (!_tMoved) { _suppressSelect = true; toggleExcluded(i); if (navigator.vibrate) navigator.vibrate(8); }
      }, 600);
    }, { passive: true });
    btn.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - _tStartX);
      const dy = _tStartY - e.touches[0].clientY;
      if (!_tMoved && (dx > 8 || Math.abs(dy) > 8)) { _tMoved = true; clearTimeout(_pressTimer); }
      if (_tMoved && dy > 0 && dy > dx) {
        _tDragging = true;
        btn.style.transform = `translateY(${-(dy * 0.65).toFixed(1)}px)`;
        btn.style.opacity = String((1 - Math.min(1, dy / 90) * 0.45).toFixed(2));
      }
    }, { passive: true });
    btn.addEventListener('touchend', async (e) => {
      clearTimeout(_pressTimer);
      const dy = _tStartY - e.changedTouches[0].clientY;
      const dx = Math.abs(e.changedTouches[0].clientX - _tStartX);
      _resetBtnTransform();
      if (state._selectMode) return;   // swipe-to-remove disabled while selecting
      if (dy > 44 && dy > dx) {
        const fname = state._queue[i]?.name ?? `Photo ${i + 1}`;
        const ok = await showDialog({
          title: 'Remove from queue',
          message: fname.length > 50 ? '…' + fname.slice(-48) : fname,
          confirmLabel: 'Remove',
          danger: true,
        });
        if (ok) removeFromQueue(i);
      }
    }, { passive: true });
    btn.addEventListener('touchcancel', () => { clearTimeout(_pressTimer); _resetBtnTransform(); }, { passive: true });
    btn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const fname = state._queue[i]?.name ?? `Photo ${i + 1}`;
      const ok = await showDialog({
        title: 'Remove from queue',
        message: fname.length > 50 ? '…' + fname.slice(-48) : fname,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (ok) removeFromQueue(i);
    });
    photoStrip.appendChild(btn);
  });
  photoStrip.classList.remove('hidden');
}

/** Update just the vibe badge on one strip thumbnail without re-rendering the strip. */
function updateThumbBadge(i) {
  const thumbs = photoStrip?.querySelectorAll('.strip-thumb');
  const badge = thumbs?.[i]?.querySelector('.strip-vibe');
  if (!badge) return;
  const vid = state._perImage[i]?.vibeId ?? state.activeVibe;
  badge.textContent = VIBE_ABBR[vid] ?? vid.slice(0, 2).toUpperCase();
}

/** Remove a photo from the queue by index. Navigates to the nearest photo if it was current. */
async function removeFromQueue(idx) {
  if (_exporting || !state._queue?.length) return;
  const removed = state._queue[idx]?.name ?? 'photo';
  const wasCurrent = (idx === state._current);
  // Abort the background thumbnail decoder — it holds old queue indices and
  // would call drawThumbAt(i, …) with stale i values after the splice, overwriting
  // the freshly re-indexed thumbnails with data from the wrong slot.
  _thumbToken++;
  // Re-index excluded set: drop removed index, shift indices above it down.
  state._excluded.delete(idx);
  const shiftedEx = new Set();
  state._excluded.forEach((v) => { shiftedEx.add(v > idx ? v - 1 : v); });
  state._excluded = shiftedEx;
  // Re-index the selection the same way; drop the removed photo.
  state._selected.delete(idx);
  const shiftedSel = new Set();
  state._selected.forEach((v) => { shiftedSel.add(v > idx ? v - 1 : v); });
  state._selected = shiftedSel;
  // Copy source: disarm if it was removed, else shift its index to stay correct.
  if (state._copySource === idx) disarmCopy();
  else if (state._copySource > idx) state._copySource--;
  // Re-index pixel + preview caches: drop removed entry, shift keys above it down.
  const newCache = new Map();
  _pixelCache.forEach((v, k) => { if (k !== idx) newCache.set(k > idx ? k - 1 : k, v); });
  _pixelCache.clear();
  newCache.forEach((v, k) => _pixelCache.set(k, v));
  const newPrev = new Map();
  _previewCache.forEach((v, k) => { if (k !== idx) newPrev.set(k > idx ? k - 1 : k, v); });
  _previewCache.clear();
  newPrev.forEach((v, k) => _previewCache.set(k, v));
  state._queue.splice(idx, 1);
  state._perImage.splice(idx, 1);
  if (!wasCurrent && idx < state._current) state._current--;
  else if (wasCurrent) state._current = Math.min(state._current, state._queue.length - 1);
  updateBatchButton();
  updateFilePos();       // refresh the "n / N" counter (and hide it when 1 left)
  renderPhotoStrip();
  redrawAllThumbs();     // restore canvas thumbnails from re-indexed cache
  generateThumbs();      // restart background decoder with correct new indices
  showToast(`Removed ${removed}`);
  if (state._queue.length > 0 && wasCurrent) {
    const f = state._queue[state._current];
    if (f) await openImage(f, f.name, { fromStrip: true, queueIndex: state._current });
  }
}

/** Toggle a photo's excluded-from-batch state by index. */
function toggleExcluded(idx) {
  if (state._excluded.has(idx)) {
    state._excluded.delete(idx);
  } else {
    state._excluded.add(idx);
  }
  // Update the thumbnail's visual state
  const thumbs = photoStrip?.querySelectorAll('.strip-thumb');
  if (thumbs?.[idx]) thumbs[idx].classList.toggle('excluded', state._excluded.has(idx));
  updateBatchButton();
}


function markActiveThumb() {
  photoStrip?.querySelectorAll('.strip-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === state._current);
  });
  updateFilePos();
}

/** Stash the on-screen photo's adjustments + rotation before switching away. */
function saveCurrentImageState() {
  if (!state._queue?.length) return;
  state._perImage[state._current] = {
    adjust:   { ...state.adjust },
    rotation: state._processor?._rotation ?? 0,
    crop:     { ...state.crop },
    vibeId:   state.activeVibe,
    autoWb:   state.autoWb,
  };
}

const _syncCoreSliders = () => {
  const setCore = (p, v) => {
    const el = document.querySelector(`.slider-row[data-param="${p}"]`);
    if (el) setSliderValue(el, v);
  };
  setCore('exposure',  state.adjust.exposure_ev);
  setCore('wb_temp',   state.adjust.wb_temp);
  setCore('tint',      state.adjust.tint);
  setCore('push_pull', state.adjust.push_pull_ev ?? 0);
};

async function selectPhoto(i) {
  const files = state._queue ?? [];
  if (i === state._current || !files[i] || _exporting) return;

  saveCurrentImageState();
  state._current = i;
  markActiveThumb();
  updateLookToolsUI();   // Apply visibility depends on whether current ≠ copy source

  // New photo identity → bump the render generation and cancel any pending idle
  // render, so a render/cache-write started for the previous photo can't land on
  // (or corrupt the preview cache of) this one. Fixes grey/black flashes and the
  // back-and-forth when a profile change or rotation follows a switch.
  _renderGen++;
  clearTimeout(_idleTimer);

  // Stamp a token so background loads from a previous navigation are discarded
  // if the user taps another photo before they finish.
  const navToken = ++_navToken;

  const saved = state._perImage[i];
  state.adjust = saved?.adjust ? { ...saved.adjust } : defaultAdjust();
  state.crop = saved?.crop ? { ...saved.crop } : defaultCropRect();
  state.autoWb = saved?.autoWb ?? defaultAutoWb();
  if (state._processor) state._processor.cameraWb = state.autoWb;
  syncAutoWbUI();
  _syncCoreSliders();

  // Restore this photo's vibe BEFORE checking the cache so the key is correct.
  const targetVibeId = saved?.vibeId ?? state.activeVibe;
  await _applyVibeConfig(targetVibeId);
  syncUserSettingsToProcessor();
  resetHistory();   // each photo has its own fresh undo history

  // Fast path: preview cache hit → show photo instantly, reload GPU state quietly.
  const preview = _previewCache.get(i);
  if (preview && preview.key === _previewKey()) {
    transitionToEditor(files[i].name);
    await drawToCanvas(preview.data);
    state.hasImage = true;
    resetZoom();
    const turns = (((saved?.rotation ?? 0) % 4) + 4) % 4;
    // Reload GPU state in background; re-apply rotation and refresh once done.
    // Guard with navToken: if the user navigates again before this finishes,
    // skip the triggerRender so we don't paint a stale photo over the new one.
    openImage(files[i], files[i].name, {
      fromStrip: true, queueIndex: i, cached: cacheGet(i), quiet: true,
    }).then(() => {
      if (_navToken !== navToken) return;
      for (let t = 0; t < turns; t++) state._processor?.rotateClockwise();
      triggerRender(false);
    }).catch(console.warn);
    schedulePersist();
    return;
  }

  // Normal path (first visit or settings changed since last render).
  await openImage(files[i], files[i].name, {
    fromStrip: true, queueIndex: i, cached: cacheGet(i),
  });
  const turns = (((saved?.rotation ?? 0) % 4) + 4) % 4;
  for (let t = 0; t < turns; t++) state._processor?.rotateClockwise();
  if (turns) triggerRender(false);
  schedulePersist();
}

// Background decode queue: every selected file is decoded ONCE (full preview
// quality), which fills both its strip thumbnail and the pixel cache — so
// already-decoded photos switch instantly. A token aborts the loop when a new
// selection (or a batch run) replaces the queue mid-run.
let _thumbToken = 0;
let _navToken   = 0;   // incremented on every selectPhoto; guards stale async draws

async function generateThumbs() {
  const files = state._queue ?? [];
  if (files.length < 2) return;
  const token = ++_thumbToken;
  const dec = new RawDecoder();
  for (let i = 0; i < files.length; i++) {
    if (token !== _thumbToken) return;
    if (_pixelCache.has(i)) continue;        // already decoded (e.g. the open photo)
    try {
      const buf = await files[i].arrayBuffer();
      // Decodes serialize through the decoder's own shared-worker queue; a
      // hung decode is killed by its watchdog and skips this file only.
      // Finished images bypass LibRaw via the effects-only image decoder.
      const decoded = await decodeSource(buf, files[i].name, dec, autoWbFor(i));
      if (token !== _thumbToken) return;
      cachePut(i, decoded);
      drawThumbAt(i, decoded);
    } catch (e) {
      console.warn('[strip] thumbnail failed:', files[i].name, e);
    }
  }
}

/** Draw the strip thumbnail for queue slot `i` from a decode result. */
function drawThumbAt(i, decoded) {
  const cvs = photoStrip?.querySelectorAll('.strip-thumb canvas')[i];
  if (cvs) drawThumb(cvs, decoded);
}

/** Re-draw all strip thumbnails from the pixel cache (called after index shifts). */
function redrawAllThumbs() {
  _pixelCache.forEach((c, i) => {
    const pixels = new Float32Array(c.u16.length);
    for (let k = 0; k < pixels.length; k++) pixels[k] = c.u16[k] / 65535;
    drawThumbAt(i, { pixels, width: c.width, height: c.height, ccm: c.ccm, isFlashback: c.isFlashback });
  });
}

function drawThumb(cvs, decoded) {
  const { pixels, width: w, height: h, ccm, isFlashback } = decoded;
  const tw = cvs.width, th = cvs.height;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(tw, th);
  const scale = Math.max(tw / w, th / h);          // cover-fit
  const sw = tw / scale, sh = th / scale;
  const ox = (w - sw) / 2, oy = (h - sh) / 2;
  // Flashback pixels are pre-matrix raw — apply the calibration + the render
  // lift (×4 = +2 EV) so thumbs aren't dark green. Generic pixels are already
  // linear sRGB. Both get display gamma.
  const lift = isFlashback ? 4 : 1;
  const gamma = (v) => Math.pow(v < 0 ? 0 : v > 1 ? 1 : v, 1 / 2.2) * 255;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor(oy + y / scale));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor(ox + x / scale));
      const s = (sy * w + sx) * 3, d = (y * tw + x) * 4;
      let r = pixels[s], g = pixels[s + 1], b = pixels[s + 2];
      if (isFlashback) {
        const r2 = ccm[0] * r + ccm[1] * g + ccm[2] * b;
        const g2 = ccm[3] * r + ccm[4] * g + ccm[5] * b;
        const b2 = ccm[6] * r + ccm[7] * g + ccm[8] * b;
        r = r2; g = g2; b = b2;
      }
      img.data[d]     = gamma(r * lift);
      img.data[d + 1] = gamma(g * lift);
      img.data[d + 2] = gamma(b * lift);
      img.data[d + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ─── Decode serialization ─────────────────────────────────────────────────────
// All raw decodes are serialized inside raw-decoder.js: one shared libraw
// worker (a single 256 MB wasm heap instead of one leaked per decode — the
// iOS "stuck Developing…" killer), one module-wide queue, and a watchdog that
// terminates a hung worker so the next decode starts fresh.

// ─── Pixel cache (decode-once) ────────────────────────────────────────────────
// Each selected file is decoded exactly once by the background queue; the
// result feeds the thumbnail AND this cache, so tapping a thumb of an
// already-decoded photo switches instantly (GPU preprocess only — no libraw).
// Stored as Uint16 (the source bit depth) to halve memory; capped LRU.

const _pixelCache = new Map();   // queue index -> { u16, width, height, ccm, isFlashback }
const PIXEL_CACHE_MAX = 4;       // ≈ 62 MB at half-size — safe on iPhone

// Preview render cache: per-photo ImageData snapshot from the last full-res render,
// tagged with the settings that produced it. Lets strip navigation show the photo
// instantly while the GPU pipeline reloads silently in the background.
const _previewCache = new Map();   // queue index -> { data: ImageData, key: string }
const PREVIEW_CACHE_MAX = 3;       // ≈ 38 MB of ImageData — safe alongside pixel cache

function _previewKey() {
  const a = state.adjust;
  // Crop is part of the key: the vignette is rendered against it, so a cached
  // preview from a different crop would carry the wrong falloff.
  const c = state.crop ?? {};
  return `${state.activeVibe}|${(a.exposure_ev ?? 0).toFixed(3)}|${(a.wb_temp ?? 0).toFixed(0)}|${(a.tint ?? 0).toFixed(0)}|${(a.push_pull_ev ?? 0).toFixed(3)}` +
         `|${c.angle ?? 0}|${(c.x ?? 0).toFixed(4)}|${(c.y ?? 0).toFixed(4)}|${(c.w ?? 1).toFixed(4)}|${(c.h ?? 1).toFixed(4)}`;
}
function _previewCachePut(i, imageData) {
  if (typeof i !== 'number' || !imageData) return;
  _previewCache.delete(i);
  _previewCache.set(i, { data: imageData, key: _previewKey() });
  while (_previewCache.size > PREVIEW_CACHE_MAX) {
    _previewCache.delete(_previewCache.keys().next().value);
  }
}

function cachePut(i, dec) {
  const u16 = new Uint16Array(dec.pixels.length);
  // Clamp to [0,1] before quantising: a value >1.0 (e.g. a highlight-lifted
  // channel) would overflow Uint16 and WRAP to a tiny value — corrupting the
  // brightest pixels when the cached photo is reloaded. Clamp, don't wrap.
  for (let k = 0; k < u16.length; k++) {
    const v = dec.pixels[k];
    u16[k] = v <= 0 ? 0 : v >= 1 ? 65535 : v * 65535;
  }
  _pixelCache.delete(i);
  _pixelCache.set(i, {
    u16, width: dec.width, height: dec.height,
    ccm: dec.ccm, isFlashback: dec.isFlashback,
    isPhoto: dec.isPhoto ?? false,      // effects-only flag must survive the cache
    exposureS: dec.exposureS ?? null,   // reverse-AE must survive the cache
    dateTaken: dec.dateTaken ?? null,   // …and so must the date stamp
    asn: dec.asn ?? null,               // …and the white-balance neutral
  });
  while (_pixelCache.size > PIXEL_CACHE_MAX) {
    _pixelCache.delete(_pixelCache.keys().next().value);
  }
}

function cacheGet(i) {
  const c = _pixelCache.get(i);
  if (!c) return null;
  _pixelCache.delete(i); _pixelCache.set(i, c);   // LRU bump
  const pixels = new Float32Array(c.u16.length);
  for (let k = 0; k < pixels.length; k++) pixels[k] = c.u16[k] / 65535;
  return {
    pixels, width: c.width, height: c.height,
    ccm: c.ccm, isFlashback: c.isFlashback, isPhoto: c.isPhoto ?? false,
    exposureS: c.exposureS, dateTaken: c.dateTaken, asn: c.asn,
  };
}

/**
 * Decode + display one image. Source may be a File or an ArrayBuffer.
 * @param {File|ArrayBuffer} source
 * @param {string} name
 * @param {{ fromResume?: boolean, fromStrip?: boolean,
 *           queueIndex?: number, cached?: object|null,
 *           quiet?: boolean }} [opts]
 *   quiet: skip loading overlay + drawToCanvas (used when a preview cache hit
 *   already drew the frame — this call only restores GPU state for editing).
 */
// Shown once per session when the first foreign (non-One35) RAW is opened.
let _foreignNoticeShown = false;

async function openImage(source, name, opts = {}) {
  if (!opts.quiet) showLoading(`Reading ${name}…`);
  try {
    const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
    if (!opts.quiet) transitionToEditor(name);

    if (!state.processorReady) {
      if (!opts.quiet) { hideLoading(); drawPlaceholder(name); state.hasImage = true; }
      if (!opts.quiet) showToast('WebGPU unavailable — cannot process image', 4000, true);
      return;
    }

    if (!opts.quiet) showLoading(`Developing ${name}…`);
    let decoded = opts.cached ?? null;
    if (!decoded) {
      decoded = await decodeSource(buffer, name, null, autoWbFor(opts.queueIndex));
      if (typeof opts.queueIndex === 'number') {
        cachePut(opts.queueIndex, decoded);
        drawThumbAt(opts.queueIndex, decoded);
      }
    }
    const result = await state._processor.loadDecoded(decoded, name, buffer);

    // Persistent "EXP" marker: anything that isn't a calibrated One35 decode
    // (foreign RAW or JPEG) is best-effort.
    updateExpBadge(decoded && decoded.isFlashback === false);
    state._currentMeta = buildCurrentMeta(decoded, name);   // for the photo-info sheet

    // First-time, once-per-session notices for the non-native import paths.
    if (!opts.quiet && decoded && !_foreignNoticeShown) {
      if (decoded.isPhoto) {
        // JPEG/PNG: finished image graded best-effort through the film pipeline.
        _foreignNoticeShown = true;
        showToast('Experimental: JPEG/PNG — film looks applied best-effort to a finished image', 6000);
      } else if (decoded.isFlashback === false) {
        // Foreign RAW: decoded by LibRaw but film looks are One35-calibrated.
        _foreignNoticeShown = true;
        showToast('Experimental: non-One35 RAW — film looks are best-effort, exposure may need adjusting', 6000);
      }
    }

    if (!opts.quiet) {
      hideLoading();
      // Stale guard: user navigated away while this was loading — discard the draw
      // so we don't paint an old photo over whichever photo is now on screen.
      const isStale = typeof opts.queueIndex === 'number' && opts.queueIndex !== state._current;
      if (result && !isStale) {
        _previewCachePut(opts.queueIndex, result);
        await drawToCanvas(result);
        state.hasImage = true;
        resetZoom();
        // Enable Resume next launch. Skipped for strip switches — re-writing a
        // 10–20 MB blob to IndexedDB on every thumbnail tap would make switching
        // sluggish; Resume keeps pointing at the first-opened photo instead.
        if (!opts.fromResume && !opts.fromStrip) rememberLastPhoto(buffer, name);
      } else if (!result && !isStale) {
        drawPlaceholder(name);
        showToast('Could not decode image', 4000, true);
      }
      // isStale: user navigated away — silently discard, the new photo's load handles display
    }
  } catch (err) {
    if (!opts.quiet) {
      hideLoading();
      console.error('[app] File load error:', err);
      showToast(`Failed to decode — ${err.message ?? 'invalid RAW?'}`, 5000, true);
    }
  }
}

// ─── Resume last photo ────────────────────────────────────────────────────────
// The bytes live in IndexedDB; a small localStorage flag lets us show the Resume
// button on launch without loading the (large) buffer until the user taps it.

const LAST_META_KEY = 'flashback:last-photo-meta';

async function rememberLastPhoto(buffer, name) {
  try {
    await saveLastPhoto({ name, bytes: buffer });
    localStorage.setItem(LAST_META_KEY, JSON.stringify({ name }));
  } catch { /* non-fatal */ }
}

async function showResumeIfAvailable() {
  if (!resumeBtn) return;
  try {
    const raw = localStorage.getItem(LAST_META_KEY);
    const meta = raw ? JSON.parse(raw) : null;
    if (!meta?.name) return;
    // The flag can outlive the actual blob (iOS evicts IndexedDB but keeps
    // localStorage), which left a stale "Resume" button that failed on tap.
    // Verify the blob is really there; if not, clear the flag and stay hidden.
    if (!(await hasLastPhoto())) {
      localStorage.removeItem(LAST_META_KEY);
      resumeBtn.classList.add('hidden');
      return;
    }
    const label = $('resume-label');
    if (label) label.textContent = `Resume ${meta.name}`;
    resumeBtn.classList.remove('hidden');
  } catch { /* ignore */ }
}

resumeBtn?.addEventListener('click', async () => {
  if (!state.processorReady) { showToast('WebGPU unavailable', 3000, true); return; }
  showLoading('Loading last photo…');
  try {
    const rec = await loadLastPhoto();
    if (!rec?.bytes) {
      hideLoading();
      localStorage.removeItem(LAST_META_KEY);
      clearLastPhoto();   // drop any orphaned record so the blob isn't stranded
      resumeBtn.classList.add('hidden');
      showToast('No saved photo found', 3000, true);
      return;
    }
    state._queue = []; state._perImage = []; state._current = 0;
    state.autoWb = defaultAutoWb();
    if (state._processor) state._processor.cameraWb = state.autoWb;
    syncAutoWbUI();
    _pixelCache.clear();
    updateBatchButton(); renderPhotoStrip();
    await openImage(rec.bytes, rec.name, { fromResume: true });
    resetHistory();
  } catch (err) {
    hideLoading();
    console.error('[app] resume failed:', err);
    showToast('Could not resume', 3000, true);
  }
});

/** Show the FULL filename in the file-info row (it wraps rather than cuts). */
function setFilename(name) {
  filenameDisplay.title = name;
  filenameDisplay.textContent = name;
}

/** Show/hide the "EXP" experimental badge for non-One35 (foreign RAW / JPEG) files. */
function updateExpBadge(experimental) {
  const b = $('exp-badge');
  if (b) b.hidden = !experimental;
}

/** Update the "n / N" photo-position indicator next to the filename. */
function updateFilePos() {
  const el = $('file-pos');
  if (!el) return;
  const n = state._queue?.length ?? 0;
  el.textContent = n > 1 ? `${state._current + 1} / ${n}` : '';
  el.classList.toggle('hidden', n < 2);
}

function transitionToEditor(filename) {
  emptyState.classList.add('hidden');
  topBar.classList.remove('hidden');
  $('file-info')?.classList.remove('hidden');
  controls.classList.remove('hidden');
  setFilename(filename);
  updateFilePos();
  refreshStampBadges();
  if (exportBtn) exportBtn.disabled = false;
}

// ─── Placeholder canvas draw (Phase 1) ───────────────────────────────────────

function drawPlaceholder(filename) {
  const ctx  = canvas.getContext('2d');
  const dpr  = window.devicePixelRatio || 1;
  const w    = canvas.clientWidth  || window.innerWidth;
  const h    = canvas.clientHeight || window.innerHeight;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  // Dark gradient background
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1a1410');
  grad.addColorStop(1, '#0d0d0d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Amber center dot (lens simulation)
  const cx = w / 2, cy = h / 2;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.35);
  glow.addColorStop(0, 'rgba(237,124,57,0.08)');
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Filename label
  ctx.fillStyle = 'rgba(210,110,55,0.4)';
  ctx.font      = `${13 * dpr / dpr}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(filename, cx, cy);

  ctx.fillStyle = 'rgba(150,80,40,0.3)';
  ctx.font      = `${11 * dpr / dpr}px -apple-system, sans-serif`;
  ctx.fillText('Processing pipeline — Phase 2', cx, cy + 22);
}

// ─── Export ───────────────────────────────────────────────────────────────────

let _exporting = false; // guard against double-tap while a render/encode runs

// A 12.8 MP One35 full-res export needs several full-size float GPU buffers
// (~150 MB each through the effects chain) plus a grown wasm decode heap —
// iOS kills the tab for it (the page "restarting to the menu" on export).
// On iOS, exports render from the RESIDENT preview-quality intermediate
// instead: half-size decode (2072×1544), zero extra decode, tiny buffers.
// Desktop keeps true full-resolution.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Render for export, honoring the "Full-resolution export" setting.
 *
 * Desktop/Android full-res: the single-pass renderExportFull (one big render).
 * iOS full-res: renderExportTiled — a 12.8 MP single-pass render needs ~1.4 GB of
 * GPU buffers and gets the tab KILLED by iOS Safari's per-tab budget, so the tiled
 * path processes the frame in horizontal strips (bounded peak memory) instead.
 * Both fall back to the resident render on failure.
 */
function renderForExport(opts = {}) {
  if (state._processor) {
    state._processor.cameraWb = state.autoWb;   // export this photo's WB
    // …and this photo's crop, so the exported vignette matches the preview.
    state._processor.cropRect = isCropDefault(state.crop) ? null : { ...state.crop };
  }
  const wantFull = state.settings?.fullResExport ?? false;
  if (!wantFull) return state._processor.renderExport(opts);
  return IS_IOS
    ? state._processor.renderExportTiled(opts)
    : state._processor.renderExportFull(opts);
}

/** The look's name for export filenames: active preset name, else the vibe id. */
function exportLabel() {
  if (state.activePresetId) {
    const p = listPresets().find((x) => x.id === state.activePresetId);
    const slug = (p?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) return slug;
  }
  return state.activeVibe;
}

/** Compose an export base name like "shot1_disposable" (extension added later). */
function withVibe(name) {
  return `${(name || 'flashback').replace(/\.[^.]+$/, '')}_${exportLabel()}`;
}

/** Compose the post-export toast. */
function exportSavedToast(kind, w, h) {
  const dims = `${w}×${h}`;
  // Only flag a size caveat when the user WANTED full-res but the device couldn't
  // fit it (a real fallback). If they turned full-res off, resident size is expected.
  const wantedFull = state.settings?.fullResExport ?? false;
  if (!wantedFull || state._processor?._lastExportFullRes) {
    showToast(`${kind} saved · ${dims}`);
  } else {
    showToast(`${kind} saved · ${dims} (full resolution didn't fit in memory — saved at preview size)`, 5000);
  }
}

/**
 * Hand finished files to the user. On iOS this is the share sheet ("Save
 * Image" / "Save to Files"); on desktop it downloads. If the share is refused
 * because the user-activation expired during the (long) render, re-ask with a
 * one-tap in-app dialog and call share from inside that tap.
 * @param {File[]} files
 * @returns {Promise<boolean>} true if delivered (or downloads started)
 */
async function saveFiles(files) {
  const r = await deliverFiles(files);
  if (r === 'shared' || r === 'downloaded') return true;
  if (r === 'cancelled') return false;
  // 'blocked' — activation expired; one explicit tap re-arms it.
  const ok = await showDialog({
    title: files.length > 1 ? `Save ${files.length} photos` : 'Save photo',
    message: files.length > 1
      ? 'All photos are developed and ready.'
      : 'Your photo is developed and ready.',
    confirmLabel: 'Save',
    onConfirm: () => { deliverFiles(files); },   // sync inside the tap
  });
  return Boolean(ok);
}

// ── Format picker (long-press Export / Batch Export) ─────────────────────────
// One-shot: picks a format and fires the export immediately, no settings change.
let _formatPickerTarget = null;

function showFormatPicker(target) {
  _formatPickerTarget = target;
  formatPicker?.classList.add('open');
}
function hideFormatPicker() {
  formatPicker?.classList.remove('open');
  _formatPickerTarget = null;
}

formatPicker?.addEventListener('click', e => {
  const btn = e.target.closest('button[data-fmt]');
  if (!btn) return;
  const fmt    = btn.dataset.fmt;
  const target = _formatPickerTarget;
  hideFormatPicker();
  if (target === 'batch') runBatch(fmt);
  else                    doExport(fmt);
});

document.addEventListener('pointerdown', e => {
  if (formatPicker?.classList.contains('open') &&
      !formatPicker.contains(e.target) &&
      e.target !== exportBtn && e.target !== batchExportBtn) {
    hideFormatPicker();
  }
}, true);

// ── Unified export function ───────────────────────────────────────────────────
async function doExport(format) {
  if (!state.hasImage || !state.processorReady || _exporting) return;
  _exporting = true;
  if (format === 'tiff') {
    try {
      showLoading('Developing 16-bit TIFF…');
      let out = await renderForExport({ raw: true });
      if (!out) { hideLoading(); showToast('Export failed', 3000, true); return; }
      out = applyCropStraightenFloat(out);
      const file = encodeTiffFile(out.rgb, out.width, out.height, withVibe(filenameDisplay.title));
      hideLoading();
      if (await saveFiles([file])) exportSavedToast('TIFF (16-bit)', out.width, out.height);
    } catch (err) {
      hideLoading();
      console.error('[app] TIFF export error:', err);
      showToast(`Export failed — ${err.message ?? 'unknown error'}`, 4000, true);
    } finally { _exporting = false; }
  } else {
    try {
      showLoading('Developing JPEG…');
      const img = await renderForExport();
      if (!img) { hideLoading(); showToast('Export failed', 3000, true); return; }
      const cropped = applyCropStraighten(img);
      const file = await encodeJpegFile(stampImageData(cropped), withVibe(filenameDisplay.title), state.jpegQuality);
      hideLoading();
      if (await saveFiles([file])) exportSavedToast('JPEG', cropped.width, cropped.height);
    } catch (err) {
      hideLoading();
      console.error('[app] JPEG export error:', err);
      showToast(`Export failed — ${err.message ?? 'unknown error'}`, 4000, true);
    } finally { _exporting = false; }
  }
}

// ── Long-press helper ─────────────────────────────────────────────────────────
function addLongPress(el, onLong, onClick) {
  if (!el) return;
  let timer = null, fired = false;
  el.addEventListener('pointerdown', () => {
    fired = false;
    timer = setTimeout(() => { fired = true; onLong(); }, 500);
  });
  el.addEventListener('pointerup',     () => clearTimeout(timer));
  el.addEventListener('pointercancel', () => clearTimeout(timer));
  el.addEventListener('click', () => { if (!fired) onClick(); fired = false; });
}

addLongPress(exportBtn,      () => showFormatPicker('single'), () => doExport(state.settings.exportFormat));
addLongPress(batchExportBtn, () => showFormatPicker('batch'),  () => runBatch());

// ─── Batch Export ───────────────────────────────────────────────────────────
// Develops every file in the current selection through the active vibe/settings
// and downloads each as a full-resolution JPEG. Each file reuses the exact
// single-file path (load → full-res render), so batch output matches what you'd
// get exporting each one by hand. Per-file errors are skipped, not fatal.

/** Show/hide the multi-photo controls (batch export, select) per queue size. */
function updateBatchButton() {
  const n = state._queue?.length ?? 0;
  if (batchExportBtn) {
    const excl = state._excluded?.size ?? 0;
    batchExportBtn.textContent = excl > 0 ? `Batch ${n - excl}/${n}` : `Batch ×${n}`;
    batchExportBtn.classList.toggle('hidden', n < 2);
  }
  // Select (multi-photo) only makes sense with 2+ photos; leaving select mode
  // when the queue drops below 2 keeps the UI consistent.
  if (n < 2 && state._selectMode) exitSelectMode();
  updateLookToolsUI();
}

// ── Copy / Paste look (UI-2) + multi-select (UI-3) ───────────────────────────
// A "look" = the profile (vibe) + core adjustments (EXP/WB/tint/push). The flow
// is an ARMED model: Copy snapshots the on-screen photo's look and outlines it as
// the source; you then navigate to another photo (or pick several via Select) and
// Paste. Paste targets the current selection, never the source, and disarms after
// — so a look can't be pasted twice or onto itself. Rotation/crop stay per-photo.

/** Reflect copy/select state across the look-tool buttons. */
function updateLookToolsUI() {
  const n = state._queue?.length ?? 0;
  const armed = !!state._lookClipboard;
  const sel = state._selectMode;
  const multi = n >= 2;                          // copy/paste/select need 2+ photos
  const canUndo = state._histIdx > 0;
  const canRedo = state._histIdx >= 0 && state._histIdx < state._history.length - 1;
  const show = (id, on) => $(id)?.classList.toggle('hidden', !on);
  // Undo/Redo placement: with 2+ photos they sit on the look-tools row beside
  // Copy/Select; with a single photo that row would be a thick empty bar, so put
  // them on the filename row instead (right side, where the photo count would be).
  const right = $('look-tools-right');
  if (right) {
    const target = multi ? $('look-tools-row') : $('file-info');
    if (target && right.parentElement !== target) target.appendChild(right);
  }
  // The look-tools row only appears with 2+ photos now (single-photo undo lives
  // on the filename row).
  $('look-tools-row')?.classList.toggle('hidden', !multi);
  // Apply only shows when there's a real target that ISN'T the source: in select
  // mode, a selected non-source photo; otherwise the current photo ≠ source. When
  // you're sitting on the source, only "Apply all" shows — nudging you to pick
  // another photo (or apply to the whole roll).
  const hasApplyTarget = sel
    ? [...state._selected].some((i) => i !== state._copySource)
    : (state._current !== state._copySource);
  show('copy-look-btn', !sel && multi);         // Copy hidden while selecting / single photo
  show('paste-look-btn', armed && hasApplyTarget && multi);
  show('paste-all-btn', armed && !sel && multi); // quick apply-to-all when armed (no Select needed)
  show('select-btn', multi);
  show('select-all-btn', sel);
  show('exclude-sel-btn', sel);
  show('remove-sel-btn', sel);
  // Undo/Redo (right side): hidden while copying (armed) or selecting, per spec.
  show('undo-btn', canUndo && !sel && !armed);
  show('redo-btn', canRedo && !sel && !armed);
  $('copy-look-btn')?.classList.toggle('active', armed);   // outline the armed Copy
  const selBtn = $('select-btn');
  if (selBtn) {
    selBtn.textContent = sel ? (state._selected.size ? `Done (${state._selected.size})` : 'Done') : 'Select';
    selBtn.classList.toggle('active', sel);
  }
  // Exclude ↔ Include: if any selected photo is already excluded, offer to re-include.
  const exBtn = $('exclude-sel-btn');
  if (exBtn && sel) {
    const anyExcluded = [...state._selected].some((i) => state._excluded.has(i));
    exBtn.textContent = anyExcluded ? 'Include' : 'Exclude';
  }
  // Select All ↔ Deselect All: the button toggles, so label it for what it'll do.
  const allBtn = $('select-all-btn');
  if (allBtn && sel) allBtn.textContent = (state._selected.size === n && n > 0) ? 'Deselect All' : 'Select All';
}

// ─── Undo / Redo ──────────────────────────────────────────────────────────────
// History of the CURRENT photo's adjustment + effect edits (sliders, toggles,
// push bypass, saturation). Scoped to the current vibe: switching vibes or photos
// starts a fresh history (vibe/LUT changes aren't on the stack — they're discrete
// and easy to redo by hand). Rotation/crop/Auto WB have their own controls.

const HISTORY_MAX = 60;
let _histTimer = null;

/** Snapshot the editable state that undo/redo restores — the full look:
 *  adjustments, effect config, saturation, AND the active profile (vibe / custom
 *  preset / imported LUT) so a profile change can be undone too. */
function snapshotEditState() {
  return {
    adjust: { ...state.adjust },
    config: { ...state.config },
    saturation: state.saturation,
    activeVibe: state.activeVibe,
    activePresetId: state.activePresetId,
    activeLutId: state.activeLutId,
  };
}

/** Reflect the active profile (vibe / preset / imported LUT) on the pill strip. */
function syncLookPillsUI() {
  const plainVibe = !state.activePresetId && !state.activeLutId;
  vibePills.forEach((pill) => {
    const on = plainVibe && pill.dataset.vibe === state.activeVibe;
    pill.classList.toggle('active', on);
    pill.setAttribute('aria-selected', String(on));
  });
  renderPresetPills();   // re-renders custom-preset pills with active = activePresetId
  renderLutPills();      // re-renders imported-LUT pills with active = activeLutId
  if (lutNameBadge) lutNameBadge.textContent = lutDisplayName(state.config?.lut_path);
}

/** Start a fresh history with the current state as the baseline (index 0). */
function resetHistory() {
  clearTimeout(_histTimer);
  state._history = [snapshotEditState()];
  state._histIdx = 0;
  updateLookToolsUI();
}

/** Record an edit (debounced, so a slider drag becomes one undo step). */
function scheduleHistory() {
  if (state._applyingHistory || !state.hasImage) return;
  clearTimeout(_histTimer);
  _histTimer = setTimeout(() => {
    const snap = snapshotEditState();
    const cur = state._history[state._histIdx];
    if (cur && JSON.stringify(cur) === JSON.stringify(snap)) return;   // no real change
    state._history = state._history.slice(0, state._histIdx + 1);      // drop any redo branch
    state._history.push(snap);
    if (state._history.length > HISTORY_MAX) state._history.shift();
    state._histIdx = state._history.length - 1;
    updateLookToolsUI();
  }, 350);
}

async function applyHistory(idx) {
  const snap = state._history[idx];
  if (!snap) return;
  clearTimeout(_histTimer);          // cancel any pending capture
  state._histIdx = idx;
  state._applyingHistory = true;
  try {
    const lutChanged = snap.config?.lut_path !== state.config?.lut_path;
    state.adjust = { ...snap.adjust };
    state.config = { ...snap.config };
    state.saturation = snap.saturation;
    state.activeVibe = snap.activeVibe ?? state.activeVibe;
    state.activePresetId = snap.activePresetId ?? null;
    state.activeLutId = snap.activeLutId ?? null;
    state._processor?.setConfig(state.config);
    if (state._processor) state._processor.saturation = state.saturation;
    syncUserSettingsToProcessor();
    _syncCoreSliders();
    syncEffectSliders();
    syncEffectToggles();
    syncLookPillsUI();              // restore the highlighted profile + LUT badge
    if (lutChanged && state.processorReady) {
      await ensureLutByPath(state.config?.lut_path);   // re-upload the snapshot's LUT
    }
    if (state.hasImage) triggerRender();
    if (state._current >= 0 && state._perImage?.[state._current]) {
      state._perImage[state._current].vibeId = state.activeVibe;   // keep strip badge in sync
      updateThumbBadge(state._current);
    }
    schedulePersist();
  } finally {
    state._applyingHistory = false;
    updateLookToolsUI();
  }
}

function undo() { if (state._histIdx > 0) applyHistory(state._histIdx - 1); }
function redo() { if (state._histIdx < state._history.length - 1) applyHistory(state._histIdx + 1); }

$('undo-btn')?.addEventListener('click', undo);
$('redo-btn')?.addEventListener('click', redo);

/** Outline the photo a look was copied from (distinct from active/selected). */
function markCopySource() {
  photoStrip?.querySelectorAll('.strip-thumb.copy-source').forEach((el) => el.classList.remove('copy-source'));
  if (state._copySource >= 0) {
    photoStrip?.querySelectorAll('.strip-thumb')[state._copySource]?.classList.add('copy-source');
  }
}

function armCopy() {
  if (!state.hasImage) return;
  saveCurrentImageState();
  state._lookClipboard = { vibeId: state.activeVibe, adjust: { ...state.adjust } };
  state._copySource = state._current;
  markCopySource();
  updateLookToolsUI();
  showToast('Look copied — pick photos and apply');
}
function disarmCopy() {
  state._lookClipboard = null;
  state._copySource = -1;
  markCopySource();
  updateLookToolsUI();
}

/** Write a copied look onto one photo's per-image state + badge. */
function pasteLookTo(i) {
  const look = state._lookClipboard;
  if (!look) return;
  state._perImage[i] = {
    adjust:   { ...look.adjust },
    rotation: state._perImage[i]?.rotation ?? 0,
    crop:     state._perImage[i]?.crop ?? { angle: 0, x: 0, y: 0, w: 1, h: 1 },
    vibeId:   look.vibeId,
  };
  updateThumbBadge(i);
}

/** Apply the clipboard look to a set of indices, refreshing the live view too. */
async function applyLookToIndices(indices) {
  const look = state._lookClipboard;
  if (!look) return;
  const targets = indices.filter((i) => i !== state._copySource);   // never the source
  if (!targets.length) { showToast('Pick a different photo to apply to'); return; }
  saveCurrentImageState();
  for (const i of targets) pasteLookTo(i);
  if (targets.includes(state._current)) {
    state.adjust = { ...look.adjust };
    _syncCoreSliders();
    await _applyVibeConfig(look.vibeId);
    syncUserSettingsToProcessor();
    if (state.hasImage) triggerRender(false);
  }
  showToast(targets.length === 1 ? 'Look applied' : `Look applied to ${targets.length} photos`);
  if (state._selectMode) exitSelectMode();
  disarmCopy();   // one paste per copy — resets the armed state
}

$('copy-look-btn')?.addEventListener('click', () => {
  if (state._lookClipboard) disarmCopy();   // tap again to cancel
  else armCopy();
});

$('paste-look-btn')?.addEventListener('click', () => {
  if (!state._lookClipboard) return;
  const targets = state._selectMode ? [...state._selected] : [state._current];
  applyLookToIndices(targets);
});
$('paste-all-btn')?.addEventListener('click', () => {
  if (!state._lookClipboard) return;
  const n = state._queue?.length ?? 0;
  applyLookToIndices([...Array(n).keys()]);   // applyLookToIndices excludes the source
});

// ── Multi-select mode (UI-3) ─────────────────────────────────────────────────
function enterSelectMode() {
  state._selectMode = true;
  state._selected.clear();
  document.body.classList.add('select-mode');
  updateLookToolsUI();
}
function exitSelectMode() {
  state._selectMode = false;
  state._selected.clear();
  document.body.classList.remove('select-mode');
  photoStrip?.querySelectorAll('.strip-thumb.selected').forEach((el) => el.classList.remove('selected'));
  updateLookToolsUI();
}
function toggleSelected(i) {
  if (state._selected.has(i)) state._selected.delete(i); else state._selected.add(i);
  photoStrip?.querySelectorAll('.strip-thumb')[i]?.classList.toggle('selected', state._selected.has(i));
  updateLookToolsUI();
}
$('select-btn')?.addEventListener('click', () => {
  if (state._selectMode) exitSelectMode(); else enterSelectMode();
});
$('select-all-btn')?.addEventListener('click', () => {
  const n = state._queue?.length ?? 0;
  const all = state._selected.size === n;   // toggle: select-all ↔ clear
  state._selected = all ? new Set() : new Set([...Array(n).keys()]);
  photoStrip?.querySelectorAll('.strip-thumb').forEach((el, i) => el.classList.toggle('selected', state._selected.has(i)));
  updateLookToolsUI();
});
$('exclude-sel-btn')?.addEventListener('click', () => {
  if (!state._selected.size) { showToast('Select photos first'); return; }
  // Label is "Include" when any selected photo is already excluded → re-include all;
  // otherwise "Exclude" → exclude all. (Matches updateLookToolsUI's dynamic label.)
  const anyExcluded = [...state._selected].some((i) => state._excluded.has(i));
  for (const i of state._selected) {
    if (anyExcluded) state._excluded.delete(i); else state._excluded.add(i);
    photoStrip?.querySelectorAll('.strip-thumb')[i]?.classList.toggle('excluded', state._excluded.has(i));
  }
  updateBatchButton();
  showToast(anyExcluded ? `Included ${state._selected.size}` : `Excluded ${state._selected.size} from export`);
});
$('remove-sel-btn')?.addEventListener('click', async () => {
  // Protect the copy source so you don't delete what you're pasting from.
  const victims = [...state._selected].filter((i) => i !== state._copySource).sort((a, b) => b - a);
  if (!victims.length) { showToast('Select photos to remove'); return; }
  const ok = await showDialog({
    title: `Remove ${victims.length} photo${victims.length > 1 ? 's' : ''}`,
    message: 'Remove the selected photos from the queue? This can’t be undone.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  for (const i of victims) removeFromQueue(i);   // descending order keeps indices valid
  exitSelectMode();
});


// Export progress overlay (used by batch). Cancellable between files.
let _cancelBatch = false;
function showProgress(title) {
  if (!progressOverlay) return;
  progressTitle.textContent = title;
  progressFill.style.width = '0%';
  progressSub.textContent = '';
  progressCancel.textContent = 'Cancel';
  progressOverlay.classList.remove('hidden');
}
function setProgress(done, total, sub) {
  if (!progressOverlay) return;
  progressFill.style.width = `${Math.round((100 * done) / total)}%`;
  progressSub.textContent = sub ?? `${done} / ${total}`;
}
function hideProgress() { progressOverlay?.classList.add('hidden'); }
progressCancel?.addEventListener('click', () => { _cancelBatch = true; progressCancel.textContent = 'Cancelling…'; });

async function runBatch(overrideFormat) {
  if (_exporting) return;
  const files = state._queue ?? [];
  if (files.length < 2) return;
  if (!state.processorReady) { showToast('WebGPU unavailable — cannot export', 3000, true); return; }

  _exporting = true; _cancelBatch = false;
  _thumbToken++;   // stop the background decode queue — batch owns the decoder now
  resetZoom();   // a stale pinch-zoom shouldn't carry over onto batch images
  saveCurrentImageState();   // capture the on-screen photo's latest tweaks
  showProgress('Developing batch…');
  const batchTotal = files.length - (state._excluded?.size ?? 0);
  let failed = 0, lastDone = state._current, batchDone = 0;
  let _batchVibe = null;   // track LUT state to avoid redundant switches
  const outFiles = [];   // everything is delivered at once at the end
  try {
    for (let i = 0; i < files.length; i++) {
      if (_cancelBatch) break;
      if (state._excluded?.has(i)) continue;
      const f = files[i];
      setProgress(batchDone, batchTotal, `Developing ${batchDone + 1} / ${batchTotal}: ${f.name}`);
      try {
        const buf = await f.arrayBuffer();
        // Each photo uses ITS OWN vibe + adjustments + rotation + Auto WB. Decode
        // via decodeSource so per-photo Auto WB is honoured AND JPEG/PNG imports
        // work (a raw decode alone would be RAW-only and ignore the photo's WB).
        const per = state._perImage[i];
        const photoAutoWb = per?.autoWb ?? defaultAutoWb();
        state.autoWb = photoAutoWb;
        state._processor.cameraWb = photoAutoWb;
        const decoded = await decodeSource(buf, f.name, null, photoAutoWb);
        await state._processor.loadDecoded(decoded, f.name, buf);
        setFilename(f.name);
        state.hasImage = true;
        const photoVibeId = per?.vibeId ?? state.activeVibe;
        if (photoVibeId !== _batchVibe) {
          const factory = factoryStateFor(photoVibeId);
          const savedVibeConfig = hasSaved(photoVibeId) ? loadOne(photoVibeId) : null;
          state.config = savedVibeConfig
            ? { ...factory, ...savedVibeConfig, lut_path: factory.lut_path, base_push_ev: factory.base_push_ev, b_push_boost: factory.b_push_boost }
            : { ...factory };
          state.activeVibe = photoVibeId;
          state._processor.setConfig(state.config);
          await ensureLutForVibe(photoVibeId);
          _batchVibe = photoVibeId;
        }
        state._processor.setSettings(per?.adjust ?? defaultAdjust());
        _stampDateOverrideMs = f?.lastModified ?? null;   // this file's date for its stamp
        state.crop = per?.crop ? { ...per.crop } : defaultCropRect();
        const turns = (((per?.rotation ?? 0) % 4) + 4) % 4;
        for (let t = 0; t < turns; t++) state._processor.rotateClockwise();
        lastDone = i;
        const batchFmt = overrideFormat ?? state.settings.batchExportFormat;
        if (batchFmt === 'tiff') {
          let out = await renderForExport({ raw: true });
          if (!out) throw new Error('render returned null');
          out = applyCropStraightenFloat(out);
          outFiles.push(encodeTiffFile(out.rgb, out.width, out.height, withVibe(f.name)));
        } else {
          const img = await renderForExport();
          if (!img) throw new Error('render returned null');
          outFiles.push(await encodeJpegFile(stampImageData(applyCropStraighten(img)), withVibe(f.name), state.jpegQuality));
        }
        batchDone++;
        setProgress(batchDone, batchTotal, `${batchDone} / ${batchTotal} developed`);
      } catch (err) {
        failed++;
        console.error('[app] batch item failed:', f?.name, err);
      }
    }
    _stampDateOverrideMs = null;   // back to the on-screen photo's own file date
    // Leave the canvas (and the strip/sliders) on the last image we processed.
    state._current = lastDone;
    markActiveThumb();
    state.adjust = state._perImage[lastDone]?.adjust ?? defaultAdjust();
    state.autoWb = state._perImage[lastDone]?.autoWb ?? defaultAutoWb();
    if (state._processor) state._processor.cameraWb = state.autoWb;
    syncAutoWbUI();
    _syncCoreSliders();
    const lastVibeId = state._perImage[lastDone]?.vibeId ?? state.activeVibe;
    if (lastVibeId !== state.activeVibe) selectVibe(lastVibeId);
    else syncUserSettingsToProcessor();
    try {
      const last = await state._processor.renderPreview({ downscale: false });
      if (last) await drawToCanvas(last);
    } catch { /* ignore */ }
  } finally {
    hideProgress();
  }

  // One save interaction for the whole batch: a single share sheet carrying
  // every developed photo (Save to Files / Save N Images), instead of the old
  // one-download-per-file drip.
  let saved = false;
  try {
    if (outFiles.length) saved = await saveFiles(outFiles);
  } finally {
    _exporting = false;
  }
  const cancelled = _cancelBatch;
  const fmt = (overrideFormat ?? state.settings.batchExportFormat) === 'tiff' ? 'TIFF' : 'JPEG';
  const n = outFiles.length;
  showToast(
    !n               ? 'Batch produced no files'
    : !saved         ? 'Batch save cancelled'
    : cancelled      ? `Batch stopped · ${n} ${fmt}${n === 1 ? '' : 's'} saved`
    : failed         ? `Batch: ${n} saved, ${failed} skipped`
    :                  `Batch: ${n} ${fmt}${n === 1 ? '' : 's'} saved`,
    4000,
    (failed > 0 || !n) && !cancelled,
  );
}

resetBtn?.addEventListener('click', resetCurrentVibe);

// ─── Loading Helpers ──────────────────────────────────────────────────────────

function showLoading(msg = 'Loading…') {
  loadingText.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

let _toastTimeout = null;

export function showToast(msg, duration = 2500, isError = false) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');

  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => toast.classList.remove('show'), duration);
}

// ─── Render Trigger ────────────────────────────────────────────────────────────
// Coalesce rapid updates to one in-flight GPU frame (Refinement H): render a
// downscaled preview during interaction, then a crisp full-res pass once idle.

let _renderQueued  = false;
let _renderInFlight = false;
let _idleTimer     = null;
let _renderGen     = 0;   // bumped on photo switch; stale renders/cache-writes are dropped

function triggerRender(interactive = true) {
  if (!state._processor || !state.processorReady || !state.hasImage) return;

  // Vignette follows the committed crop — keep the processor's copy current
  // (triggerRender is the single gateway for every preview render).
  state._processor.cropRect = isCropDefault(state.crop) ? null : { ...state.crop };

  const gen = _renderGen;   // snapshot: discard this frame if the photo changes

  if (!_renderQueued && !_renderInFlight) {
    _renderQueued = true;
    requestAnimationFrame(async () => {
      _renderQueued = false;
      _renderInFlight = true;
      try {
        const img = await state._processor.renderPreview({ downscale: interactive });
        if (img && gen === _renderGen) await drawToCanvas(img, { interactive });
      } catch (err) {
        console.error('[app] render error:', err);
      } finally {
        _renderInFlight = false;
      }
    });
  }

  // Crisp, full-resolution pass after the user stops adjusting.
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    if (!state.hasImage) return;
    const idleGen = _renderGen;
    // Self-heal: if rAF never fired (tab backgrounded/throttled), the queued
    // flag would otherwise stay stuck and block all future interactive renders.
    _renderQueued = false;
    try {
      const img = await state._processor.renderPreview({ downscale: false });
      // Only draw/cache if we're still on the same photo — otherwise a late
      // render for the previous photo would flash or poison its preview cache.
      if (img && idleGen === _renderGen) {
        await drawToCanvas(img);
        _previewCachePut(state._current, img);  // cache after every idle full-res render
      }
    } catch (err) {
      console.error('[app] full-res render error:', err);
    }
  }, 220);
}

/**
 * Draw an ImageData onto the preview canvas, letterboxed (contain-fit).
 * @param {{ interactive?: boolean }} [opts]  interactive: mid-drag frame —
 *   skip the histogram so the drag stays smooth (idle pass updates it).
 */
// ─── Stamps (2000s film-camera style) ─────────────────────────────────────────
// Amber glowing digits, like the optical date back of a 2000s point-and-shoot:
// the date in the lower-right, an optional frame number in the lower-left.
// Drawn on the preview and baked into JPEG exports (TIFF stays clean — it's
// the "negative" for further editing).

// Batch export sets this to the file being developed so each stamp gets its own
// file date (state._current doesn't move during a batch). Null = use current photo.
let _stampDateOverrideMs = null;

const _ymd = (d) => [String(d.getFullYear()),
                     String(d.getMonth() + 1).padStart(2, '0'),
                     String(d.getDate()).padStart(2, '0')];

/**
 * Effective [YYYY, MM, DD]. One35 DNGs carry NO capture date (verified — only
 * Make/Model/colour-calibration tags), so "auto" uses the file's modification
 * time (File.lastModified) per photo. With auto off, the fixed custom date is
 * used; failing everything, today.
 */
function effectiveDateParts() {
  if (state.autoDateFromFile) {
    const ms = _stampDateOverrideMs ?? state._queue?.[state._current]?.lastModified;
    if (ms) return _ymd(new Date(ms));
  }
  if (state.customDate) {
    const m = state.customDate.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return [m[1], m[2], m[3]];
  }
  const exif = state._processor?._dateTaken;   // none on One35, kept for other cameras
  const me = typeof exif === 'string' ? exif.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/) : null;
  if (me) return [me[1], me[2], me[3]];
  return _ymd(new Date());
}

/** Date text "'YY MM DD" or "'YY MM" — the classic film date-back order. */
function dateStampText() {
  const [y, mo, da] = effectiveDateParts();
  return state.dateFormat === 'YYMM'
    ? `'${y.slice(2)} ${mo}`
    : `'${y.slice(2)} ${mo} ${da}`;
}

// ── 7-segment LED renderer (the orange film date-back look) ───────────────────
// Drawn as canvas segments so it's crisp at any resolution (incl. full-res
// export) with no bundled font. Segments per digit: a b c d e f g.
const SEVEN_SEG = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
  '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};

/** Advance width of a char cell of digit-height H. */
function segCharWidth(ch, H) {
  const cw = H * 0.62, t = H * 0.15;
  if (ch === ' ') return cw * 0.55;
  if (ch === "'") return t * 2.2;
  return cw + t * 1.3;            // digit + inter-digit gap
}

/** Draw one 7-seg char at cell origin (ox, top). */
function drawSegChar(ctx, ch, ox, top, H) {
  const cw = H * 0.62, t = H * 0.15, mid = top + H / 2;
  if (ch === "'") { ctx.fillRect(ox, top, t, H * 0.28); return; }
  if (ch === ' ') return;
  const segs = SEVEN_SEG[ch];
  if (!segs) return;
  const hx = ox + t * 0.6, hw = cw - t * 1.2;     // horizontal seg x/width
  const vh = H / 2 - t * 1.1;                       // vertical seg height
  const rects = {
    a: [hx, top, hw, t],
    g: [hx, mid - t / 2, hw, t],
    d: [hx, top + H - t, hw, t],
    f: [ox, top + t * 0.6, t, vh],
    b: [ox + cw - t, top + t * 0.6, t, vh],
    e: [ox, mid + t * 0.5, t, vh],
    c: [ox + cw - t, mid + t * 0.5, t, vh],
  };
  for (const s of segs) { const r = rects[s]; ctx.fillRect(r[0], r[1], r[2], r[3]); }
}

/** Render a 7-seg string; align 'left'|'right' to (anchorX, top). */
function drawSevenSeg(ctx, text, align, anchorX, top, H) {
  let total = 0;
  for (const ch of text) total += segCharWidth(ch, H);
  const startX = align === 'right' ? anchorX - total : anchorX;
  ctx.save();
  // Slight italic lean (shear about the glyph top), like a real LED date back.
  ctx.translate(0, top);
  ctx.transform(1, 0, -0.16, 1, 0, 0);
  ctx.translate(0, -top);
  // On the Monochrome look the stamp should read neutral, not amber.
  const mono = state.activeVibe === 'monochrome';
  const _stampColorMap = { amber: '#c8823c', silver: '#9e9e9e', white: '#ebebeb', black: '#1a1a1a' };
  ctx.fillStyle = mono ? '#dcdcdc' : (_stampColorMap[state.settings.stampColor] ?? '#c8823c');
  ctx.shadowColor = mono ? 'rgba(120,120,120,0.25)' : 'rgba(210, 130, 60, 0.28)';
  ctx.shadowBlur = H * 0.14;               // softer glow
  let x = startX;
  for (const ch of text) { drawSegChar(ctx, ch, x, top, H); x += segCharWidth(ch, H); }
  ctx.restore();
}

/** Frame number = position in the current roll (1-based). Using the queue
 *  order, not the filename — One35 filenames keep counting up across rolls. */
function frameStampText() {
  return String((state._current ?? 0) + 1);
}

/** Draw one amber 7-segment stamp anchored bottom-left or bottom-right. */
function drawStamp(ctx, text, align, x, y, w, h) {
  const H = Math.max(4, Math.round(Math.min(w, h) * 0.018));   // digit height
  const pad = H * 1.8;                                          // inset further from the corner
  const top = y + h - pad - H;
  const anchorX = align === 'right' ? x + w - pad : x + pad;
  drawSevenSeg(ctx, text, align, anchorX, top, H);
}

/** Draw whichever stamps are enabled over the image rect. */
function drawStamps(ctx, x, y, w, h) {
  if (state.dateStamp)  drawStamp(ctx, dateStampText(),  'right', x, y, w, h);
  if (state.frameStamp) drawStamp(ctx, frameStampText(), 'left',  x, y, w, h);
}

/** Bake the enabled stamps into an ImageData (for export). No-op when off. */
function stampImageData(img) {
  if (!state.dateStamp && !state.frameStamp) return img;
  const cvs = document.createElement('canvas');
  cvs.width = img.width; cvs.height = img.height;
  const ctx = cvs.getContext('2d');
  ctx.putImageData(img, 0, 0);
  drawStamps(ctx, 0, 0, img.width, img.height);
  const out = ctx.getImageData(0, 0, img.width, img.height);
  cvs.width = 0; cvs.height = 0;
  return out;
}

// ─── Crop & straighten ────────────────────────────────────────────────────────
// Model: `state.crop = { angle, x, y, w, h }`. Straighten rotates the frame by
// `angle` and scales it up by the exact "cover" factor so the rotated image
// still fills the W×H frame (never any empty corners); then x/y/w/h crop a
// sub-rectangle of that straightened frame (all normalised 0..1). Applied to
// the preview AND both export formats, so what you see is what you save.

function isCropDefault(c) {
  return !c || (c.angle === 0 && c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1);
}

/** Cover scale that keeps a W×H frame filled after rotating by `rad`. */
function coverScale(rad, W, H) {
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  return c + Math.max(H / W, W / H) * s;
}

// Default crop (Settings → Default Crop) applied to freshly opened photos that
// have no saved crop. The One35 sensor aspect is constant, so a fixed-aspect
// crop rect is the same for every frame; use the decoded dims when available,
// else the native sensor ratio (so it's correct even before the first decode).
const ONE35_ASPECT = 4144 / 3088;
// Aspect (w/h) for each default-crop option. Mirrors the crop editor's ratios so
// the two pickers match. defaultCropRect() handles both landscape and portrait.
const DEFAULT_CROP_ASPECTS = {
  '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '3:2': 1.5, '2:3': 2 / 3, '16:9': 16 / 9,
};
function defaultCropRect() {
  const A = DEFAULT_CROP_ASPECTS[state.settings?.defaultCrop];
  if (!A) return { angle: 0, x: 0, y: 0, w: 1, h: 1 };   // 'free' / unset → full frame
  const imgW = state._processor?.width || 4144;
  const imgH = state._processor?.height || 3088;
  let w = 1, h = imgW / (A * imgH);
  if (h > 1) { h = 1; w = (A * imgH) / imgW; }
  return { angle: 0, x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Bake crop+straighten into an ImageData (preview + JPEG). */
function applyCropStraighten(img) {
  const c = state.crop;
  if (isCropDefault(c)) return img;
  const W = img.width, H = img.height;
  const src = document.createElement('canvas'); src.width = W; src.height = H;
  src.getContext('2d').putImageData(img, 0, 0);
  const st = document.createElement('canvas'); st.width = W; st.height = H;
  const sctx = st.getContext('2d');
  const rad = c.angle * Math.PI / 180;
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, W, H);
  sctx.translate(W / 2, H / 2);
  sctx.rotate(rad);
  sctx.scale(coverScale(rad, W, H), coverScale(rad, W, H));
  sctx.drawImage(src, -W / 2, -H / 2);
  const cx = Math.round(c.x * W), cy = Math.round(c.y * H);
  const cw = Math.max(1, Math.round(c.w * W)), ch = Math.max(1, Math.round(c.h * H));
  const out = document.createElement('canvas'); out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(st, cx, cy, cw, ch, 0, 0, cw, ch);
  const res = out.getContext('2d').getImageData(0, 0, cw, ch);
  src.width = src.height = st.width = st.height = out.width = out.height = 0;
  return res;
}

/** Bake crop+straighten into a raw float RGB export ({rgb,width,height}). */
function applyCropStraightenFloat(out) {
  const c = state.crop;
  if (isCropDefault(c)) return out;
  const { rgb, width: W, height: H } = out;
  const rad = c.angle * Math.PI / 180;
  const cov = coverScale(rad, W, H);
  const cosA = Math.cos(rad), sinA = Math.sin(rad);
  const ox = c.x * W, oy = c.y * H;
  const cw = Math.max(1, Math.round(c.w * W)), ch = Math.max(1, Math.round(c.h * H));
  const res = new Float32Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      // straightened-frame coord → invert (rotate+coverscale about centre) → source
      let px = (ox + x + 0.5 - W / 2) / cov;
      let py = (oy + y + 0.5 - H / 2) / cov;
      const fx = ( px * cosA + py * sinA) + W / 2;
      const fy = (-px * sinA + py * cosA) + H / 2;
      const di = (y * cw + x) * 3;
      if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) continue;   // black outside
      const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
      const i00 = (y0 * W + x0) * 3, i10 = i00 + 3, i01 = i00 + W * 3, i11 = i01 + 3;
      for (let ch3 = 0; ch3 < 3; ch3++) {
        const top = rgb[i00 + ch3] * (1 - tx) + rgb[i10 + ch3] * tx;
        const bot = rgb[i01 + ch3] * (1 - tx) + rgb[i11 + ch3] * tx;
        res[di + ch3] = top * (1 - ty) + bot * ty;
      }
    }
  }
  return { rgb: res, width: cw, height: ch };
}

// ── Crop editor (interactive overlay) ─────────────────────────────────────────
const cropSheet  = $('crop-sheet');
const cropCanvas = $('crop-canvas');
let _cropWork = null;          // working copy of {angle,x,y,w,h} while editing
let _cropAspect = null;        // locked aspect (w:h in pixels), or null = free
let _cropImgRect = null;       // {dx,dy,dw,dh} where the straightened image draws

function openCropEditor() {
  if (!state.hasImage || !cropSheet || !state._lastImageData) return;
  _cropWork = { ...state.crop };
  _cropAspect = null;
  state.cropEditing = true;
  triggerRender(false);        // repaint the main canvas with the FULL frame
  cropSheet.classList.remove('hidden');
  $('straighten-range').value = _cropWork.angle;
  $('straighten-val').textContent = `${_cropWork.angle}°`;
  $('crop-aspects').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.aspect === 'free'));
  requestAnimationFrame(drawCropEditor);
}

function closeCropEditor(commit) {
  if (commit && _cropWork) {
    state.crop = { ..._cropWork };
    saveCurrentImageState();
    schedulePersist();
  }
  state.cropEditing = false;
  cropSheet.classList.add('hidden');
  if (state.hasImage) triggerRender(false);
}

/** Draw the straightened image + dimmed mask + crop rect with corner handles. */
function drawCropEditor() {
  if (!state.cropEditing || !state._lastImageData) return;
  const img = state._lastImageData;
  const stage = $('crop-stage');
  const dpr = window.devicePixelRatio || 1;
  const availW = stage.clientWidth, availH = stage.clientHeight;
  cropCanvas.width = Math.round(availW * dpr);
  cropCanvas.height = Math.round(availH * dpr);
  cropCanvas.style.width = availW + 'px';
  cropCanvas.style.height = availH + 'px';
  const ctx = cropCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, availW, availH);

  // Fit the W×H frame into the stage (the straightened frame is the same size).
  const W = img.width, H = img.height;
  const scale = Math.min(availW / W, availH / H) * 0.92;
  const dw = W * scale, dh = H * scale;
  const dx = (availW - dw) / 2, dy = (availH - dh) / 2;
  _cropImgRect = { dx, dy, dw, dh };

  // Render the straightened image into an offscreen and draw it.
  const rad = _cropWork.angle * Math.PI / 180;
  const src = document.createElement('canvas'); src.width = W; src.height = H;
  src.getContext('2d').putImageData(img, 0, 0);
  ctx.save();
  ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
  ctx.translate(dx + dw / 2, dy + dh / 2);
  ctx.rotate(rad);
  const cov = coverScale(rad, W, H) * scale;
  ctx.scale(cov, cov);
  ctx.drawImage(src, -W / 2, -H / 2, W, H);
  ctx.restore();
  src.width = src.height = 0;

  // Crop rect in screen coords.
  const c = _cropWork;
  const rx = dx + c.x * dw, ry = dy + c.y * dh, rw = c.w * dw, rh = c.h * dh;

  // Dim everything outside the crop rect.
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.rect(rx, ry, rw, rh);
  ctx.fill('evenodd');

  // Crop border + rule-of-thirds + corner handles.
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  for (let k = 1; k <= 2; k++) {
    ctx.beginPath();
    ctx.moveTo(rx + rw * k / 3, ry); ctx.lineTo(rx + rw * k / 3, ry + rh);
    ctx.moveTo(rx, ry + rh * k / 3); ctx.lineTo(rx + rw, ry + rh * k / 3);
    ctx.stroke();
  }
  ctx.fillStyle = '#ed7c39';   // accent (canvas can't read CSS vars)
  const hs = 10;
  for (const [hx, hy] of [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]]) {
    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
  }
}

// Pointer drag: corners resize, body moves. Coords normalised to the frame rect.
let _cropDrag = null;   // { corner | 'body', startX, startY, start:{...crop} }
cropCanvas?.addEventListener('pointerdown', (e) => {
  if (!_cropImgRect) return;
  const r = cropCanvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const { dx, dy, dw, dh } = _cropImgRect;
  const c = _cropWork;
  const rx = dx + c.x * dw, ry = dy + c.y * dh, rw = c.w * dw, rh = c.h * dh;
  const near = (a, b) => Math.abs(px - a) < 28 && Math.abs(py - b) < 28;
  let corner = null;
  if (near(rx, ry)) corner = 'tl';
  else if (near(rx + rw, ry)) corner = 'tr';
  else if (near(rx, ry + rh)) corner = 'bl';
  else if (near(rx + rw, ry + rh)) corner = 'br';
  else if (px > rx && px < rx + rw && py > ry && py < ry + rh) corner = 'body';
  if (!corner) return;
  _cropDrag = { corner, startX: px, startY: py, start: { ...c } };
  cropCanvas.setPointerCapture(e.pointerId);
  e.preventDefault();
});
cropCanvas?.addEventListener('pointermove', (e) => {
  if (!_cropDrag || !_cropImgRect) return;
  const r = cropCanvas.getBoundingClientRect();
  const { dx, dy, dw, dh } = _cropImgRect;
  const dxn = (e.clientX - r.left - _cropDrag.startX) / dw;
  const dyn = (e.clientY - r.top  - _cropDrag.startY) / dh;
  const s = _cropDrag.start;
  let { x, y, w, h } = s;
  const MIN = 0.1;
  if (_cropDrag.corner === 'body') {
    x = Math.max(0, Math.min(1 - w, s.x + dxn));
    y = Math.max(0, Math.min(1 - h, s.y + dyn));
  } else {
    let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
    if (_cropDrag.corner.includes('l')) x0 = Math.max(0, Math.min(x1 - MIN, s.x + dxn));
    if (_cropDrag.corner.includes('r')) x1 = Math.min(1, Math.max(x0 + MIN, s.x + s.w + dxn));
    if (_cropDrag.corner.includes('t')) y0 = Math.max(0, Math.min(y1 - MIN, s.y + dyn));
    if (_cropDrag.corner.includes('b')) y1 = Math.min(1, Math.max(y0 + MIN, s.y + s.h + dyn));
    x = x0; y = y0; w = x1 - x0; h = y1 - y0;
    if (_cropAspect) {
      // Keep pixel aspect = _cropAspect (w*W)/(h*H); adjust height from width.
      const img = state._lastImageData;
      const targetH = (w * img.width) / (_cropAspect * img.height);
      if (_cropDrag.corner.includes('t')) y = (s.y + s.h) - targetH;
      h = targetH;
      if (y < 0) { y = 0; } if (y + h > 1) h = 1 - y;
    }
  }
  _cropWork = { ..._cropWork, x, y, w, h };
  drawCropEditor();
  e.preventDefault();
});
const _endCropDrag = (e) => { if (_cropDrag) { _cropDrag = null; if (e) e.preventDefault(); } };
cropCanvas?.addEventListener('pointerup', _endCropDrag);
cropCanvas?.addEventListener('pointercancel', _endCropDrag);

$('straighten-range')?.addEventListener('input', (e) => {
  _cropWork.angle = parseFloat(e.target.value);
  $('straighten-val').textContent = `${_cropWork.angle}°`;
  drawCropEditor();
});
$('crop-aspects')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-aspect]');
  if (!btn) return;
  $('crop-aspects').querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  // "Original" = revert to the full, uncropped frame (keeps the straighten angle).
  if (btn.dataset.aspect === 'original') {
    _cropAspect = null;
    _cropWork = { ..._cropWork, x: 0, y: 0, w: 1, h: 1 };
    drawCropEditor();
    return;
  }
  _cropAspect = btn.dataset.aspect === 'free' ? null : parseFloat(btn.dataset.aspect);
  if (_cropAspect && state._lastImageData) {
    // Re-fit a centred crop of the chosen aspect inside the frame.
    const img = state._lastImageData, A = _cropAspect;   // A = w:h in pixels
    let w = 1, h = (w * img.width) / (A * img.height);
    if (h > 1) { h = 1; w = (A * img.height * h) / img.width; }
    _cropWork = { ..._cropWork, x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  drawCropEditor();
});
$('crop-cancel')?.addEventListener('click', () => closeCropEditor(false));
$('crop-done')?.addEventListener('click', () => closeCropEditor(true));
$('crop-reset')?.addEventListener('click', () => {
  _cropWork = { angle: 0, x: 0, y: 0, w: 1, h: 1 };
  _cropAspect = null;
  $('straighten-range').value = 0;
  $('straighten-val').textContent = '0°';
  $('crop-aspects').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.aspect === 'free'));
  drawCropEditor();
});
$('crop-btn')?.addEventListener('click', openCropEditor);
// Manual reload — handy for grabbing the latest deployed version on demand.
$('refresh-btn')?.addEventListener('click', () => window.location.reload());

async function drawToCanvas(imageData, opts = {}) {
  state._lastImageData = imageData;            // keep for the histogram (full frame)
  if (state.histOpen && !opts.interactive) drawHistogram(imageData);
  // While the crop editor is open it draws the full frame itself; otherwise the
  // committed crop is baked into what's shown.
  if (!state.cropEditing) imageData = applyCropStraighten(imageData);
  // Clipping warnings paint onto a copy so the histogram's source stays clean.
  if (state.clipWarn && !opts.interactive) imageData = paintClipping(imageData);

  const dpr = window.devicePixelRatio || 1;
  // Size from the canvas's own flex region (the area between the top bar and
  // the controls), NOT the window — the photo letterboxes into the visible
  // space and is never hidden under the UI.
  const W = Math.round(canvas.clientWidth  * dpr);
  const H = Math.round(canvas.clientHeight * dpr);
  // Reallocating the backing store is expensive; only do it when the size
  // actually changed (the background fill below clears the previous frame).
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const bmp = await createImageBitmap(imageData);
  const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
  const dw = bmp.width * scale, dh = bmp.height * scale;
  const dx = (canvas.width - dw) / 2, dy = (canvas.height - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, dx, dy, dw, dh);
  // Cache the drawn frame so a SIZE-only change (zen toggle, resize) can be
  // re-letterboxed synchronously — no stale-bitmap stretch while the GPU
  // re-renders. (Replaces the previous bmp.close().)
  state._lastBmp?.close();
  state._lastBmp = bmp;
  drawStamps(ctx, dx, dy, dw, dh);
}

/**
 * Re-letterbox the last drawn frame at the canvas's CURRENT size, synchronously.
 * Used when only the display size changed (entering/leaving full screen): the
 * content is identical, so a GPU re-render is wasteful AND too slow — it lets the
 * old backing store stretch/squash for a frame. Drawing the cached bitmap in the
 * same synchronous step as the relayout keeps the photo crisp and steady.
 */
function relayoutCanvas() {
  const bmp = state._lastBmp;
  if (!bmp || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(canvas.clientWidth * dpr);
  const H = Math.round(canvas.clientHeight * dpr);
  if (!W || !H) return;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);
  const scale = Math.min(W / bmp.width, H / bmp.height);
  const dw = bmp.width * scale, dh = bmp.height * scale;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, dx, dy, dw, dh);
  drawStamps(ctx, dx, dy, dw, dh);
}

// ─── Resize Handler ───────────────────────────────────────────────────────────

let _lastViewportW = window.innerWidth;
window.addEventListener('resize', () => {
  // Pan bounds depend on viewport size, so reset zoom on real resizes — but
  // only when the WIDTH changed. The iOS keyboard (e.g. the preset-name input)
  // fires a height-only resize and shouldn't throw away the user's zoom.
  if (window.innerWidth !== _lastViewportW) {
    _lastViewportW = window.innerWidth;
    resetZoom();
  }
  if (filenameDisplay.title) setFilename(filenameDisplay.title);  // re-fit truncation
  if (state.hasImage && state.processorReady) triggerRender(false);
  else if (state.hasImage) drawPlaceholder(filenameDisplay.textContent);
});

// The canvas's flex region also changes without a window resize — the photo
// strip appearing, zen toggling, orientation chrome. Repaint whenever its CSS
// box actually changes (debounced; backing-store writes don't affect the box).
if (window.ResizeObserver) {
  let _roTimer = null;
  new ResizeObserver(() => {
    clearTimeout(_roTimer);
    _roTimer = setTimeout(() => {
      if (state.hasImage && state.processorReady) triggerRender(false);
    }, 80);
  }).observe(canvas);
}

// ─── Initial State ────────────────────────────────────────────────────────────

// Restore the last session (active vibe + core adjustments), else default vibe.
const _session = loadSession();
if (_session?.adjust && typeof _session.adjust === 'object') {
  state.adjust.exposure_ev = Number(_session.adjust.exposure_ev) || 0;
  state.adjust.wb_temp     = Number(_session.adjust.wb_temp)     || 0;
  state.adjust.tint        = Number(_session.adjust.tint)        || 0;
  const setCore = (p, v) => {
    const el = document.querySelector(`.slider-row[data-param="${p}"]`);
    if (el) setSliderValue(el, v);
  };
  setCore('exposure', state.adjust.exposure_ev);
  setCore('wb_temp',  state.adjust.wb_temp);
  setCore('tint',     state.adjust.tint);
}
if (typeof _session?.saturation === 'number') {
  state.saturation = Math.min(2, Math.max(0, _session.saturation));
  const satEl = document.querySelector('.slider-mini[data-param="saturation"]');
  if (satEl) setSliderValue(satEl, state.saturation);
}
syncFxBtnStates();

// Build the custom preset pills first so a restored preset can be re-activated.
renderPresetPills();

// Restore the last look: active custom preset if one was in use, else the vibe.
// Sessions from before the Natural-default era (no v:2 stamp) are migrated to
// Natural once, so the corrected default rendering actually reaches updated
// installs; their other settings (adjustments, quality, presets) are kept.
const _sessionCurrent = _session?.v === 2;
const _startPreset = (_sessionCurrent && _session?.activePresetId)
  ? listPresets().find((p) => p.id === _session.activePresetId)
  : null;
if (_startPreset) {
  loadPreset(_startPreset);
} else {
  const _startVibe = (_sessionCurrent && _session?.activeVibe && _session.activeVibe in VIBE_PRESETS)
    ? _session.activeVibe
    : 'natural';
  selectVibe(_startVibe);
}

// Custom LUT pills load async from IndexedDB; re-apply a restored LUT override
// once they exist (falls back to the vibe's factory LUT if it was deleted).
renderLutPills().then(async () => {
  if (_sessionCurrent && _session?.activeLutId && !_startPreset) {
    const rec = await getCustomLut(_session.activeLutId);
    if (rec) applyCustomLut(rec);
  }
});

// Disable export button until image loaded
if (exportBtn) exportBtn.disabled = true;

showResumeIfAvailable();

// Show the build stamp on the empty state so a deploy can be confirmed synced.
const buildId = (typeof __BUILD_ID__ !== 'undefined') ? __BUILD_ID__ : 'dev';

// Staging identifier: the staging Worker serves byte-identical code to
// production, so mark it visibly (green logo + "Beta" title + version suffix)
// to avoid confusing the two when testing. Detected from the hostname so no
// build flag is needed — production ('flashback-raw-editor-web.…') is untouched.
const IS_STAGING = /staging/i.test(location.hostname);
if (IS_STAGING) {
  document.body.classList.add('staging');
  document.title = 'Flashback Editor — Beta';
}
const versionLabel = IS_STAGING ? `${buildId} Beta` : buildId;

const versionTag = $('version-tag');
if (versionTag) versionTag.textContent = versionLabel;
const helpVersion = $('help-version');
if (helpVersion) helpVersion.textContent = versionLabel;
const settingsVersion = $('settings-version');
if (settingsVersion) settingsVersion.textContent = versionLabel;
const whatsNewVersion = $('whatsnew-version');
if (whatsNewVersion) whatsNewVersion.textContent = buildId;

// Auto-show the patch notes once after an update (version string changed since
// last launch). Skipped on a first-ever install (no prior version stored).
try {
  const KEY = 'flashback:lastSeenVersion';
  const seen = localStorage.getItem(KEY);
  if (seen && seen !== buildId) setTimeout(() => openWhatsNew(), 600);
  localStorage.setItem(KEY, buildId);
} catch { /* storage unavailable — skip */ }

console.log(`[app] Flashback RAW Editor ready — ${versionLabel}`);

// Dev-only debug handle (never shipped): lets the dev console / test harness
// poke app state and the processor directly.
if (import.meta.env.DEV) window.__fb = { state, triggerRender: (i) => triggerRender(i) };
