/**
 * settings.js — User preferences persisted in localStorage under
 * `flashback_settings`. Separate from the per-session image state.
 *
 * Exports:
 *   loadSettings()          → settings object (defaults merged in)
 *   saveSettings(s)         → writes to localStorage
 *   applyVibeOrder(strip, order) → reorders vibe pills in the DOM
 *   initSettings(state, cbs)     → wires up the settings overlay UI
 */

import { VIBE_PRESETS } from '../core/config.js';

const STORAGE_KEY = 'flashback_settings';
const VERSION = 1;

const ALL_VIBE_IDS = Object.keys(VIBE_PRESETS);

const DEFAULTS = {
  settings_version:  VERSION,
  defaultVibe:       'natural',
  vibeOrder:         ALL_VIBE_IDS,
  exportFormat:      'jpeg',
  batchExportFormat: 'jpeg',
  jpegQuality:       95,
  confirmRemove:     true,
  dateStamp:         false,
  frameStamp:        false,
  dateFormat:        'YYMMDD',
  autoDateFromFile:  true,
  customDate:        null,
  stampColor:        'amber',
  defaultCrop:       'free',
  fullResExport:     false,
  autoWbDefault:     false,
  reduceMotion:      false,
  theme:             'dark',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...saved };
    // Ensure every known vibe is in the order (handles new vibes added in updates)
    const missing = ALL_VIBE_IDS.filter(id => !merged.vibeOrder.includes(id));
    if (missing.length) merged.vibeOrder = [...merged.vibeOrder, ...missing];
    // Drop vibes that no longer exist
    merged.vibeOrder = merged.vibeOrder.filter(id => VIBE_PRESETS[id]);
    // One-time (1.3.1): force "Auto WB on new photos" OFF for everyone — including
    // users who got the v1.3.0 default of ON — to match the daylight-balanced
    // philosophy. Runs once; any later manual change is respected.
    const MIG_AUTOWB_OFF = `${STORAGE_KEY}:autowb-off-131`;
    if (!localStorage.getItem(MIG_AUTOWB_OFF)) {
      merged.autoWbDefault = false;
      try {
        localStorage.setItem(MIG_AUTOWB_OFF, '1');
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {}
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
}

export function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
}

/** Reorder the built-in vibe pills in the strip to match `vibeOrder`. */
export function applyVibeOrder(vibeStrip, vibeOrder) {
  if (!vibeStrip) return;
  const saveBtn = vibeStrip.querySelector('#save-preset-btn');
  vibeOrder.forEach(id => {
    const pill = vibeStrip.querySelector(`.vibe-pill[data-vibe="${id}"]`);
    if (pill && saveBtn) vibeStrip.insertBefore(pill, saveBtn);
  });
}

/**
 * Wire up the settings overlay. Must be called after DOMContentLoaded.
 * @param {object}   state       — app state (settings property read/written here)
 * @param {object}   callbacks
 *   .onSettingsChange(settings) — called after any setting changes
 *   .onVibeOrderChange(order)   — called after drag-reorder
 */
export function initSettings(state, { onSettingsChange, onVibeOrderChange }) {
  const overlay    = document.getElementById('settings-overlay');
  const settingsBtn = document.getElementById('settings-btn');
  const closeBtn   = document.getElementById('settings-close');
  if (!overlay) return;

  settingsBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click',   close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });

  // ── Default vibe select ─────────────────────────────────────────────────────
  const defVibeSelect = document.getElementById('settings-default-vibe');
  if (defVibeSelect && !defVibeSelect.options.length) {
    ALL_VIBE_IDS.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = VIBE_PRESETS[id].label;
      defVibeSelect.appendChild(opt);
    });
  }
  defVibeSelect?.addEventListener('change', (e) => {
    state.settings.defaultVibe = e.target.value;
    saveSettings(state.settings);
  });

  // ── Seg-toggle buttons ──────────────────────────────────────────────────────
  function wireSegToggle(id, settingKey, getVal) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = getVal(btn);
        state.settings[settingKey] = val;
        saveSettings(state.settings);
        syncSeg(el, val);
        onSettingsChange(state.settings);
      });
    });
  }

  wireSegToggle('settings-export-format',       'exportFormat',      b => b.dataset.fmt);
  wireSegToggle('settings-batch-export-format', 'batchExportFormat', b => b.dataset.fmt);
  wireSegToggle('settings-stamp-color',         'stampColor',        b => b.dataset.color);
  wireSegToggle('settings-default-crop',        'defaultCrop',       b => b.dataset.crop);
  wireSegToggle('settings-theme',               'theme',             b => b.dataset.theme);

  // ── JPEG Quality range ──────────────────────────────────────────────────────
  const qualityRange = document.getElementById('settings-jpeg-quality');
  const qualityVal   = document.getElementById('settings-jpeg-quality-val');
  qualityRange?.addEventListener('input', () => {
    const v = parseInt(qualityRange.value, 10);
    state.settings.jpegQuality = v;
    if (qualityVal) qualityVal.textContent = String(v);
    saveSettings(state.settings);
    onSettingsChange(state.settings);
  });

  // ── Checkbox toggles ────────────────────────────────────────────────────────
  function wireCheck(id, settingKey) {
    document.getElementById(id)?.addEventListener('change', (e) => {
      state.settings[settingKey] = e.target.checked;
      saveSettings(state.settings);
      onSettingsChange(state.settings);
    });
  }

  wireCheck('settings-confirm-remove', 'confirmRemove');
  wireCheck('settings-auto-date',      'autoDateFromFile');
  wireCheck('settings-full-res-export', 'fullResExport');
  wireCheck('settings-auto-wb-default', 'autoWbDefault');
  wireCheck('settings-reduce-motion',  'reduceMotion');
  wireCheck('settings-date-stamp',     'dateStamp');
  wireCheck('settings-frame-stamp',    'frameStamp');

  // ── Date format seg-toggle ──────────────────────────────────────────────────
  const dfEl = document.getElementById('settings-date-format');
  dfEl?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.settings.dateFormat = btn.dataset.datefmt ?? 'YYMMDD';
      saveSettings(state.settings);
      syncDateFmt(dfEl, state.settings.dateFormat);
      onSettingsChange(state.settings);
    });
  });

  // ── Settings date input ─────────────────────────────────────────────────────
  const settingsDateInput = document.getElementById('settings-date-input');
  settingsDateInput?.addEventListener('change', () => {
    state.settings.customDate = settingsDateInput.value || null;
    saveSettings(state.settings);
    onSettingsChange(state.settings);
  });

  // ── Profile order collapsible ───────────────────────────────────────────────
  const vibeOrderToggle = document.getElementById('settings-vibe-order-toggle');
  const vibeOrderBody   = document.getElementById('settings-vibe-order-body');
  vibeOrderToggle?.addEventListener('click', () => {
    const expanded = vibeOrderToggle.getAttribute('aria-expanded') === 'true';
    vibeOrderToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    vibeOrderBody?.toggleAttribute('hidden', expanded);
  });

  document.getElementById('settings-reset-vibe-order')?.addEventListener('click', () => {
    state.settings.vibeOrder = [...ALL_VIBE_IDS];
    saveSettings(state.settings);
    renderVibeOrderList(state.settings.vibeOrder);
    onVibeOrderChange(state.settings.vibeOrder);
  });

  // ── Reset all settings ──────────────────────────────────────────────────────
  document.getElementById('settings-reset-all')?.addEventListener('click', () => {
    const freshDefaults = { ...DEFAULTS, settings_version: VERSION };
    state.settings = freshDefaults;
    saveSettings(state.settings);
    syncAll(state.settings);
    renderVibeOrderList(state.settings.vibeOrder);
    onVibeOrderChange(state.settings.vibeOrder);
    onSettingsChange(state.settings);
  });

  // ── Open / close (slide-up animation) ──────────────────────────────────────
  function open() {
    syncAll(state.settings);
    renderVibeOrderList(state.settings.vibeOrder);
    overlay.classList.add('open');
  }
  function close() {
    overlay.classList.remove('open');
  }

  function syncAll(s) {
    if (defVibeSelect) defVibeSelect.value = s.defaultVibe;
    syncSeg(document.getElementById('settings-export-format'),       s.exportFormat);
    syncSeg(document.getElementById('settings-batch-export-format'), s.batchExportFormat);
    syncSeg(document.getElementById('settings-stamp-color'),         s.stampColor);
    syncSeg(document.getElementById('settings-default-crop'),        s.defaultCrop);
    syncSeg(document.getElementById('settings-theme'),               s.theme ?? 'dark');
    applyTheme(s.theme ?? 'dark');
    syncCheck('settings-confirm-remove', s.confirmRemove);
    syncCheck('settings-auto-date',      s.autoDateFromFile);
  syncCheck('settings-full-res-export', s.fullResExport);
    syncCheck('settings-auto-wb-default', s.autoWbDefault);
    syncCheck('settings-reduce-motion',  s.reduceMotion);
    syncCheck('settings-date-stamp',     s.dateStamp);
    syncCheck('settings-frame-stamp',    s.frameStamp);
    syncDateFmt(dfEl, s.dateFormat ?? 'YYMMDD');
    const di = document.getElementById('settings-date-input');
    if (di && s.customDate) di.value = s.customDate;
    const q = s.jpegQuality ?? 95;
    if (qualityRange) qualityRange.value = String(q);
    if (qualityVal)   qualityVal.textContent = String(q);
  }

  function syncDateFmt(el, val) {
    if (!el) return;
    el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.datefmt === val));
  }

  function syncSeg(el, val) {
    if (!el) return;
    el.querySelectorAll('button').forEach(b => {
      const match = b.dataset.fmt === val || b.dataset.color === val || b.dataset.crop === val || b.dataset.theme === val;
      b.classList.toggle('active', match);
      b.setAttribute('aria-pressed', String(match));
    });
  }

  function syncCheck(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
  }

  // ── Vibe order drag-to-reorder ──────────────────────────────────────────────
  function renderVibeOrderList(vibeOrder) {
    const list = document.getElementById('settings-vibe-order');
    if (!list) return;
    list.innerHTML = '';
    vibeOrder.forEach(id => {
      const preset = VIBE_PRESETS[id];
      if (!preset) return;
      const item = document.createElement('div');
      item.className = 'settings-vibe-item';
      item.dataset.vibe = id;
      item.draggable = true;
      item.innerHTML =
        `<span class="settings-vibe-handle" aria-hidden="true">☰</span>` +
        `<span class="settings-vibe-label">${preset.label}</span>`;
      list.appendChild(item);
    });
    initDragReorder(list);
  }

  function initDragReorder(list) {
    let dragging = null;

    list.querySelectorAll('.settings-vibe-item').forEach(item => {
      // HTML5 drag (desktop)
      item.addEventListener('dragstart', (e) => {
        dragging = item;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => item.classList.add('dragging'), 0);
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        dragging = null;
        commitOrder(list);
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragging || dragging === item) return;
        const { top, height } = item.getBoundingClientRect();
        if (e.clientY < top + height / 2) list.insertBefore(dragging, item);
        else list.insertBefore(dragging, item.nextSibling);
      });

      // Touch drag (mobile)
      let touchDragging = null, touchClone = null, offsetX = 0, offsetY = 0;
      item.addEventListener('touchstart', (e) => {
        touchDragging = item;
        const t = e.touches[0];
        const rect = item.getBoundingClientRect();
        offsetX = t.clientX - rect.left;
        offsetY = t.clientY - rect.top;
        touchClone = item.cloneNode(true);
        touchClone.style.cssText =
          `position:fixed;pointer-events:none;opacity:0.8;z-index:9999;` +
          `width:${rect.width}px;left:${rect.left}px;top:${rect.top}px;`;
        document.body.appendChild(touchClone);
        item.classList.add('dragging');
        e.preventDefault();
      }, { passive: false });

      item.addEventListener('touchmove', (e) => {
        if (!touchDragging || !touchClone) return;
        const t = e.touches[0];
        touchClone.style.left = `${t.clientX - offsetX}px`;
        touchClone.style.top  = `${t.clientY - offsetY}px`;
        // Find target
        touchClone.style.display = 'none';
        const target = document.elementFromPoint(t.clientX, t.clientY)?.closest('.settings-vibe-item');
        touchClone.style.display = '';
        if (target && target !== touchDragging) {
          const { top, height } = target.getBoundingClientRect();
          if (t.clientY < top + height / 2) list.insertBefore(touchDragging, target);
          else list.insertBefore(touchDragging, target.nextSibling);
        }
        e.preventDefault();
      }, { passive: false });

      item.addEventListener('touchend', () => {
        touchClone?.remove();
        touchClone = null;
        touchDragging?.classList.remove('dragging');
        touchDragging = null;
        commitOrder(list);
      });
    });
  }

  function commitOrder(list) {
    const order = [...list.querySelectorAll('.settings-vibe-item')].map(i => i.dataset.vibe);
    state.settings.vibeOrder = order;
    saveSettings(state.settings);
    onVibeOrderChange(order);
  }
}
