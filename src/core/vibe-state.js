/**
 * vibe-state.js — Per-vibe state persistence using localStorage.
 * Ported from core/vibe_state.py — replaces Qt QStandardPaths + JSON file
 * with localStorage, which persists across PWA sessions.
 */

const STORAGE_KEY = 'flashback:vibe-state';
const SESSION_KEY = 'flashback:session';
const PRESETS_KEY = 'flashback:presets';

/**
 * List saved custom presets.
 * @returns {Array<{id:string,name:string,baseVibe:string,config:object,adjust:object}>}
 */
export function listPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Save (or replace by id) a custom preset. */
export function savePreset(preset) {
  const all = listPresets();
  const i = all.findIndex((p) => p.id === preset.id);
  if (i >= 0) all[i] = preset; else all.push(preset);
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(all)); }
  catch (e) { console.warn('[vibe-state] Could not save preset:', e); }
}

/** Delete a custom preset by id. */
export function deletePreset(id) {
  const all = listPresets().filter((p) => p.id !== id);
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(all)); }
  catch { /* ignore */ }
}

/**
 * Save the global session (last active vibe + core adjustments).
 * @param {object} obj
 */
export function saveSession(obj) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(obj)); }
  catch (e) { console.warn('[vibe-state] Could not save session:', e); }
}

/**
 * Load the global session, or null if none/invalid.
 * @returns {object|null}
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Load all saved vibe states.
 * @returns {{ [vibeId: string]: object }}
 */
export function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

/**
 * Save one vibe state, replacing any prior entry.
 * @param {string} vibeId
 * @param {object} state
 */
export function saveOne(vibeId, state) {
  const data = loadAll();
  // Strip preset-calibration fields — these come from factory defaults and must
  // not be frozen in localStorage, otherwise config changes never take effect.
  const { base_push_ev, b_push_boost, ...rest } = state;
  data[vibeId] = rest;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[vibe-state] Could not save:', e);
  }
}

/**
 * Remove saved state for a vibe. No-op if nothing was saved.
 * @param {string} vibeId
 */
export function clearOne(vibeId) {
  const data = loadAll();
  if (vibeId in data) {
    delete data[vibeId];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch { /* ignore */ }
  }
}

/**
 * Returns true if a saved state exists for vibeId.
 * @param {string} vibeId
 * @returns {boolean}
 */
export function hasSaved(vibeId) {
  return vibeId in loadAll();
}

/**
 * Load state for a single vibe.
 * @param {string} vibeId
 * @returns {object|null}
 */
export function loadOne(vibeId) {
  const all = loadAll();
  return all[vibeId] ?? null;
}
