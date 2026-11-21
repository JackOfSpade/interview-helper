// Sizes the candidate drags in the call window: the side panel's width and the chat box's height.
// Each is remembered in this window's storage so the next call opens the same way. Storage can be
// missing or throw; the call then uses the defaults.

export const PANEL_DEFAULT_WIDTH = 340;
export const PANEL_MIN_WIDTH = 280;
// The call itself keeps at least this much width beside the panel.
export const STAGE_MIN_WIDTH = 360;
export const PANEL_KEY_STEP = 24;

export const BOX_MIN_HEIGHT = 36;
// Without a dragged height the box grows with the answer up to this, as before.
export const BOX_AUTO_MAX_HEIGHT = 112;
// The messages above the box keep at least this much height.
export const LIST_MIN_HEIGHT = 160;

const PANEL_STORE_KEY = 'practice-call:side-panel-width';
const BOX_STORE_KEY = 'practice-call:chat-box-height';

export function clampPanelWidth(width, rowWidth) {
  const max = Number.isFinite(rowWidth) && rowWidth > 0 ? Math.max(PANEL_MIN_WIDTH, rowWidth - STAGE_MIN_WIDTH) : Infinity;
  return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), max));
}

export function clampBoxHeight(height, panelHeight) {
  const max = Number.isFinite(panelHeight) && panelHeight > 0 ? Math.max(BOX_MIN_HEIGHT, panelHeight - LIST_MIN_HEIGHT - 120) : Infinity;
  return Math.round(Math.min(Math.max(height, BOX_MIN_HEIGHT), max));
}

function readNumber(key) {
  try {
    const value = Number(globalThis.localStorage?.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

function writeNumber(key, value) {
  try {
    if (value == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, String(Math.round(value)));
  } catch { /* storage unavailable: the size lasts for this call only */ }
}

export const readPanelWidth = () => readNumber(PANEL_STORE_KEY) ?? PANEL_DEFAULT_WIDTH;
export const savePanelWidth = width => writeNumber(PANEL_STORE_KEY, width);
// null means the box sizes itself to the answer.
export const readBoxHeight = () => readNumber(BOX_STORE_KEY);
export const saveBoxHeight = height => writeNumber(BOX_STORE_KEY, height);

// Pointer drag on a handle: calls onMove with how far the pointer has moved since the press,
// and onEnd once it is released. Text is not selected while dragging.
export function startDrag(event, { axis, onMove, onEnd }) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget;
  const start = axis === 'x' ? event.clientX : event.clientY;
  const pointerId = event.pointerId;
  try { handle.setPointerCapture?.(pointerId); } catch { /* capture is a nicety */ }
  const move = moveEvent => onMove((axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - start);
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    try { handle.releasePointerCapture?.(pointerId); } catch { /* already released */ }
    if (typeof onEnd === 'function') onEnd();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
