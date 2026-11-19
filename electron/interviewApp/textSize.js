// Text size: one setting for every window this app opens.
//
// The setting is a page zoom, not a font size. Zoom scales the text together
// with the boxes, icons and spacing around it, so a larger size cannot push
// words out of a box that stayed small. What zoom does take away is room: at
// 150% a window holds two thirds of what it held. So each window's minimum
// size grows with the setting, a window opens larger by the same factor, and a
// window that is now too small is grown, all within the screen it is on.
import fs from 'node:fs';
import { atomicWriteFile } from '../utils/atomicWrite.js';

export const TEXT_SIZE_STEPS = Object.freeze([80, 90, 100, 110, 125, 150, 175, 200]);
export const DEFAULT_TEXT_SIZE = 100;
export const TEXT_SIZE_GET_CHANNEL = 'interview-app:get-text-size';
export const TEXT_SIZE_SET_CHANNEL = 'interview-app:set-text-size';
export const TEXT_SIZE_CHANGED_CHANNEL = 'interview-app:text-size-changed';

/** The step nearest to `value`; anything that is not a usable number is the default. */
export function normalizeTextSize(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TEXT_SIZE;
  return TEXT_SIZE_STEPS.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), DEFAULT_TEXT_SIZE);
}

/** One step larger (`direction` > 0) or smaller; stays at the end of the list. */
export function stepTextSize(current, direction) {
  const index = TEXT_SIZE_STEPS.indexOf(normalizeTextSize(current));
  const next = Math.min(TEXT_SIZE_STEPS.length - 1, Math.max(0, index + (direction > 0 ? 1 : -1)));
  return TEXT_SIZE_STEPS[next];
}

export function textSizeState(percent) {
  const value = normalizeTextSize(percent);
  return { percent: value, steps: [...TEXT_SIZE_STEPS], default: DEFAULT_TEXT_SIZE, canGrow: value < TEXT_SIZE_STEPS.at(-1), canShrink: value > TEXT_SIZE_STEPS[0] };
}

/** The saved setting. A missing or damaged file is the default size; it is rewritten on the next change. */
export function createTextSizeStore({ filePath, fsApi = fs } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('The text size setting needs a file path.');
  return Object.freeze({
    read() {
      try { return normalizeTextSize(JSON.parse(fsApi.readFileSync(filePath, 'utf8'))?.percent); }
      catch { return DEFAULT_TEXT_SIZE; }
    },
    write: percent => atomicWriteFile(filePath, `${JSON.stringify({ version: 1, percent: normalizeTextSize(percent) })}\n`, { mkdir: true }),
  });
}

/**
 * A window's size and minimum size at one text size, within the work area of its screen.
 * `base` is what the window was created with at 100%. `current` is its size now; pass
 * `opening: true` for a window that has not been shown, which opens at its scaled base size.
 */
export function fitWindowToTextSize({ base, current, percent, workArea, opening = false }) {
  const factor = normalizeTextSize(percent) / 100;
  const cap = (value, limit) => (Number.isFinite(limit) && limit > 0 ? Math.min(value, Math.floor(limit)) : value);
  const scaled = (value, limit) => cap(Math.round(value * factor), limit);
  const minimum = [scaled(base.minimum[0], workArea?.width), scaled(base.minimum[1], workArea?.height)];
  const wanted = opening ? [scaled(base.size[0], workArea?.width), scaled(base.size[1], workArea?.height)] : current;
  const size = [Math.max(wanted[0], minimum[0]), Math.max(wanted[1], minimum[1])];
  return { minimum, size };
}

/**
 * Applies the setting to every window and keeps it. `adopt(window)` is called once per new
 * window, before it loads; `set`, `step` and `reset` change the setting for all of them.
 */
export function createTextSizeController({ store, getAllWindows, screen = null, logger = null, onChange = null, defer = setImmediate } = {}) {
  if (!store || typeof getAllWindows !== 'function') throw new TypeError('The text size controller needs a store and the window list.');
  let percent = store.read();
  const bases = new WeakMap();
  const adopted = new WeakSet();
  const alive = win => !!win && !win.isDestroyed?.();

  function workAreaOf(win) {
    try { return screen?.getDisplayMatching?.(win.getBounds())?.workArea ?? null; } catch { return null; }
  }

  function zoom(win) {
    if (!alive(win)) return;
    try { win.webContents?.setZoomFactor?.(percent / 100); } catch { /* the page is going away */ }
  }

  function fit(win, opening) {
    const base = bases.get(win);
    if (!base || !alive(win)) return;
    try {
      const workArea = workAreaOf(win);
      const current = win.getSize();
      const { minimum, size } = fitWindowToTextSize({ base, current, percent, workArea, opening });
      win.setMinimumSize(minimum[0], minimum[1]);
      if (size[0] === current[0] && size[1] === current[1]) return;
      win.setSize(size[0], size[1]);
      if (opening) { win.center?.(); return; }
      // A window grown in place may now reach past the screen edge: bring it back.
      if (!workArea) return;
      const [x, y] = win.getPosition();
      const nextX = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size[0]));
      const nextY = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size[1]));
      if (nextX !== x || nextY !== y) win.setPosition(nextX, nextY);
    } catch (error) { logger?.warn?.(`[TextSize] window was not resized: ${error?.message || error}`); }
  }

  function adopt(win) {
    if (!alive(win) || adopted.has(win)) return;
    adopted.add(win);
    // Zoom belongs to the loaded page, so it is set again whenever a page loads.
    win.webContents?.on?.('dom-ready', () => zoom(win));
    win.webContents?.on?.('did-finish-load', () => zoom(win));
    // Electron announces a window from inside its constructor, before the constructor has
    // applied the minimum size it was given. Its own sizes are read once it has returned,
    // which is still long before the page has loaded and the window is shown.
    defer(() => {
      if (!alive(win)) return;
      try { bases.set(win, { minimum: win.getMinimumSize(), size: win.getSize() }); }
      catch { return; }
      if (percent !== DEFAULT_TEXT_SIZE) fit(win, true);
    });
  }

  async function set(value) {
    const next = normalizeTextSize(value);
    if (next !== percent) {
      percent = next;
      for (const win of getAllWindows()) { zoom(win); fit(win, false); }
      try { onChange?.(textSizeState(percent)); } catch { /* a listener cannot undo the change */ }
      try { await store.write(percent); }
      catch (error) { logger?.warn?.(`[TextSize] the setting was not saved: ${error?.message || error}`); }
    }
    return textSizeState(percent);
  }

  return Object.freeze({
    adopt,
    state: () => textSizeState(percent),
    set,
    step: direction => set(stepTextSize(percent, direction)),
    reset: () => set(DEFAULT_TEXT_SIZE),
  });
}

/** The three View menu entries. They act on every window, whichever one is in front. */
export function textSizeMenuItems(controller) {
  return [
    { label: 'Bigger Text', accelerator: 'CommandOrControl+Plus', click: () => { void controller.step(1); } },
    // The same key without Shift, which is how most people press it.
    { label: 'Bigger Text', accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => { void controller.step(1); } },
    { label: 'Smaller Text', accelerator: 'CommandOrControl+-', click: () => { void controller.step(-1); } },
    { label: 'Default Text Size', accelerator: 'CommandOrControl+0', click: () => { void controller.reset(); } },
  ];
}

/** Only the main window has the control; the menu serves the other windows. */
export function registerTextSizeHandlers({ ipcMain, guarded, controller }) {
  ipcMain.handle(TEXT_SIZE_GET_CHANNEL, guarded(() => controller.state()));
  ipcMain.handle(TEXT_SIZE_SET_CHANNEL, guarded((args) => {
    const keys = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : null;
    if (!keys || keys.length !== 1 || keys[0] !== 'percent' || !TEXT_SIZE_STEPS.includes(args.percent)) throw new TypeError('That text size is not one of the choices.');
    return controller.set(args.percent);
  }));
}
