/**
 * sliders.js — Touch & mouse scrub sliders.
 *
 * Handles both `.slider-row` (full-width core sliders) and
 * `.slider-mini` (compact effect sliders).
 *
 * Each slider element carries data attributes:
 *   data-param  — name key (e.g. "exposure", "grain_strength")
 *   data-min    — minimum value
 *   data-max    — maximum value
 *   data-step   — step size (used for rounding display)
 *   data-value  — current value
 *
 * Fires a custom 'slider-change' event on the element with { detail: { param, value } }.
 */

const DRAG_PX_PER_UNIT = 160; // pixels of horizontal drag = full range sweep

/**
 * Attach scrub behaviour to all `.slider-row` and `.slider-mini` elements
 * found inside `container` (defaults to document).
 * @param {Element|Document} container
 * @param {(param: string, value: number) => void} onChange
 */
export function initSliders(container = document, onChange = () => {}) {
  const rows = container.querySelectorAll('.slider-row, .slider-mini');
  rows.forEach((row) => attachScrub(row, onChange));
}

function attachScrub(el, onChange) {
  const track = el.querySelector('.slider-track');
  const fill  = el.querySelector('.slider-fill');
  const thumb = el.querySelector('.slider-thumb');
  const valEl = el.querySelector('.slider-val');

  if (!track) return;

  const min   = parseFloat(el.dataset.min  ?? 0);
  const max   = parseFloat(el.dataset.max  ?? 1);
  const step  = parseFloat(el.dataset.step ?? 0.01);
  let   value = parseFloat(el.dataset.value ?? (min + max) / 2);

  // Remember the default (value at attach time) so reset-to-default keeps working
  // after drags overwrite data-value. Stored on the element so the programmatic
  // setSliderValue() can read it too.
  if (el.dataset.default === undefined) el.dataset.default = String(value);
  const defaultVal = parseFloat(el.dataset.default);

  // Per-slider "reset to default" button — core sliders only, shown only when the
  // slider has been moved off its default (e.g. an accidental nudge while flipping).
  let resetBtn = null;
  if (el.classList.contains('slider-row')) {
    resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'slider-reset';
    resetBtn.textContent = '↺';
    resetBtn.setAttribute('aria-label', 'Reset to default');
    resetBtn.title = 'Reset to default';
    resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());  // don't start a drag
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      value = defaultVal;
      render(value);
      el.dataset.value = value;
      onChange(el.dataset.param, value);
      el.dispatchEvent(new CustomEvent('slider-change', {
        bubbles: true, detail: { param: el.dataset.param, value },
      }));
    });
    el.appendChild(resetBtn);
  }

  // ── Initial render ─────────────────────────────────────────────────────────
  render(value);

  // ── Pointer events (works for mouse + touch + stylus) ──────────────────────
  let startX   = 0;
  let startVal = 0;
  let active   = false;
  let pointerId = null;

  el.addEventListener('pointerdown', (e) => {
    // Only main button / first touch
    if (e.button !== undefined && e.button !== 0) return;
    active    = true;
    pointerId = e.pointerId;
    startX    = e.clientX;
    startVal  = value;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    e.preventDefault();
  }, { passive: false });

  el.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== pointerId) return;
    const range   = max - min;
    const pxRange = track.getBoundingClientRect().width || DRAG_PX_PER_UNIT;
    const delta   = ((e.clientX - startX) / pxRange) * range;
    value = clamp(snap(startVal + delta, step, min), min, max);
    render(value);
    el.dataset.value = value;
    onChange(el.dataset.param, value);
    // Fire custom event for other listeners
    el.dispatchEvent(new CustomEvent('slider-change', {
      bubbles: true,
      detail: { param: el.dataset.param, value },
    }));
    e.preventDefault();
  }, { passive: false });

  const stopDrag = () => {
    if (!active) return;
    active = false;
    pointerId = null;
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup',     stopDrag);
  el.addEventListener('pointercancel', stopDrag);

  // ── Double-tap track/thumb to reset to default ─────────────────────────────
  let lastTap = 0;
  el.addEventListener('pointerup', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      value = clamp(snap(defaultVal, step, min), min, max);
      render(value);
      el.dataset.value = value;
      onChange(el.dataset.param, value);
      el.dispatchEvent(new CustomEvent('slider-change', {
        bubbles: true,
        detail: { param: el.dataset.param, value },
      }));
    }
    lastTap = now;
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function render(v) {
    const pct = ((v - min) / (max - min)) * 100;
    if (fill)  fill.style.width   = `${pct}%`;
    if (thumb) thumb.style.left   = `${pct}%`;
    if (valEl) valEl.textContent  = formatValue(v, step);
    if (resetBtn) resetBtn.classList.toggle('visible', Math.abs(v - defaultVal) > step / 2);
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function snap(v, step, min) {
  return Math.round((v - min) / step) * step + min;
}

function formatValue(v, step) {
  // Decide decimal places from step size
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return v.toFixed(decimals);
}

/**
 * Programmatically set a slider's value and re-render.
 * @param {Element} el    The .slider-row or .slider-mini element
 * @param {number}  value New value
 */
export function setSliderValue(el, value) {
  const min  = parseFloat(el.dataset.min  ?? 0);
  const max  = parseFloat(el.dataset.max  ?? 1);
  const step = parseFloat(el.dataset.step ?? 0.01);
  const v    = clamp(snap(value, step, min), min, max);

  el.dataset.value = v;

  const fill  = el.querySelector('.slider-fill');
  const thumb = el.querySelector('.slider-thumb');
  const valEl = el.querySelector('.slider-val');

  const pct = ((v - min) / (max - min)) * 100;
  if (fill)  fill.style.width  = `${pct}%`;
  if (thumb) thumb.style.left  = `${pct}%`;
  if (valEl) valEl.textContent = formatValue(v, step);

  const rb = el.querySelector('.slider-reset');
  if (rb) {
    const dv = parseFloat(el.dataset.default ?? '0');
    rb.classList.toggle('visible', Math.abs(v - dv) > step / 2);
  }
}

