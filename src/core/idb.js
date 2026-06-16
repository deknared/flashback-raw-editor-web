/**
 * idb.js — minimal IndexedDB wrapper for the "resume last photo" feature.
 *
 * Stores the most recently opened RAW file (its bytes + name) under a single
 * key so it can be reopened on a later launch. IndexedDB is used because the
 * file is far too large for localStorage. All calls degrade gracefully: any
 * failure resolves to null / no-op rather than throwing, so the rest of the app
 * is never blocked by storage problems (private mode, quota, etc.).
 */

const DB_NAME    = 'flashback';
const STORE      = 'session';
const LUT_STORE  = 'luts';      // user-imported .cube LUTs (too big for localStorage)
const KEY        = 'last-photo';

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 2); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))     db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(LUT_STORE)) db.createObjectStore(LUT_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Persist the last opened photo.
 * @param {{ name: string, bytes: ArrayBuffer }} record
 */
export async function saveLastPhoto(record) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, KEY);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('[idb] saveLastPhoto failed:', e);
  }
}

/**
 * Load the last opened photo, or null if none / unavailable.
 * @returns {Promise<{ name: string, bytes: ArrayBuffer } | null>}
 */
export async function loadLastPhoto() {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror   = () => reject(r.error);
    });
    db.close();
    return rec;
  } catch (e) {
    console.warn('[idb] loadLastPhoto failed:', e);
    return null;
  }
}

// ─── Custom LUTs ──────────────────────────────────────────────────────────────
// A parsed 65³ .cube is ~3.3 MB of Float32 — IndexedDB stores typed arrays
// natively, so the parsed table is persisted directly (no re-parse on load).

/**
 * Persist a user-imported LUT.
 * @param {{ id:string, name:string, size:number, data:Float32Array }} rec
 */
export async function saveCustomLut(rec) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LUT_STORE, 'readwrite');
    tx.objectStore(LUT_STORE).put(rec);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
  db.close();
}

/** List custom LUTs (id + name + size only would need an index; small N, return all). */
export async function listCustomLuts() {
  try {
    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(LUT_STORE, 'readonly');
      const r = tx.objectStore(LUT_STORE).getAll();
      r.onsuccess = () => resolve(r.result ?? []);
      r.onerror   = () => reject(r.error);
    });
    db.close();
    return all;
  } catch (e) {
    console.warn('[idb] listCustomLuts failed:', e);
    return [];
  }
}

/** Fetch one custom LUT by id, or null. */
export async function getCustomLut(id) {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(LUT_STORE, 'readonly');
      const r = tx.objectStore(LUT_STORE).get(id);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror   = () => reject(r.error);
    });
    db.close();
    return rec;
  } catch {
    return null;
  }
}

/** Delete a custom LUT. */
export async function deleteCustomLut(id) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(LUT_STORE, 'readwrite');
      tx.objectStore(LUT_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
    db.close();
  } catch { /* ignore */ }
}

/**
 * Cheaply check the last-photo blob actually exists (without loading it).
 * The localStorage flag can outlive the IndexedDB blob after iOS evicts
 * storage, which left a "Resume" button that failed when tapped.
 * @returns {Promise<boolean>}
 */
export async function hasLastPhoto() {
  try {
    const db = await openDb();
    const present = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).getKey(KEY);
      r.onsuccess = () => resolve(r.result !== undefined);
      r.onerror   = () => reject(r.error);
    });
    db.close();
    return present;
  } catch {
    return false;
  }
}

/** Remove the stored photo. */
export async function clearLastPhoto() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
    db.close();
  } catch { /* ignore */ }
}
