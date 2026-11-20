// Text size: one zoom setting for every window, saved, with window sizes that keep up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_TEXT_SIZE, TEXT_SIZE_GET_CHANNEL, TEXT_SIZE_SET_CHANNEL, TEXT_SIZE_STEPS,
  createTextSizeController, createTextSizeStore, fitWindowToTextSize, normalizeTextSize, registerTextSizeHandlers, stepTextSize, textSizeMenuItems,
} from '../../electron/interviewApp/textSize.js';

class FakeWindow {
  constructor({ size = [1180, 860], minimum = [720, 520], position = [100, 100] } = {}) {
    this.size = size; this.minimum = minimum; this.position = position; this.centered = 0; this.zooms = [];
    this.webContents = Object.assign(new EventEmitter(), { setZoomFactor: (factor) => { this.zooms.push(factor); } });
  }
  isDestroyed() { return false; }
  getSize() { return [...this.size]; }
  setSize(width, height) { this.size = [width, height]; }
  getMinimumSize() { return [...this.minimum]; }
  setMinimumSize(width, height) { this.minimum = [width, height]; }
  getPosition() { return [...this.position]; }
  setPosition(x, y) { this.position = [x, y]; }
  getBounds() { return { x: this.position[0], y: this.position[1], width: this.size[0], height: this.size[1] }; }
  center() { this.centered += 1; }
}

function setup({ saved = DEFAULT_TEXT_SIZE, workArea = { x: 0, y: 25, width: 1728, height: 1050 } } = {}) {
  const writes = []; const changes = []; const windows = [];
  const controller = createTextSizeController({
    store: { read: () => saved, write: async (percent) => { writes.push(percent); } },
    getAllWindows: () => windows,
    screen: { getDisplayMatching: () => ({ workArea }) },
    onChange: state => changes.push(state.percent),
    defer: task => task(),
  });
  const open = (options) => { const win = new FakeWindow(options); windows.push(win); controller.adopt(win); return win; };
  return { controller, open, writes, changes };
}

export default [
  {
    name: 'text size: a saved value snaps to a step and the ends of the list hold',
    run() {
      assert.equal(normalizeTextSize(125), 125);
      assert.equal(normalizeTextSize(120), 125);
      assert.equal(normalizeTextSize(1000), 200);
      for (const bad of [undefined, null, '150', NaN, 0, -5]) assert.equal(normalizeTextSize(bad), DEFAULT_TEXT_SIZE);
      assert.equal(stepTextSize(100, 1), 110);
      assert.equal(stepTextSize(100, -1), 90);
      assert.equal(stepTextSize(TEXT_SIZE_STEPS.at(-1), 1), TEXT_SIZE_STEPS.at(-1));
      assert.equal(stepTextSize(TEXT_SIZE_STEPS[0], -1), TEXT_SIZE_STEPS[0]);
    },
  },
  {
    name: 'text size: the setting is kept in its own file and a damaged file is the default',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-text-size-'));
      try {
        const filePath = path.join(directory, 'nested', 'text-size.json');
        const store = createTextSizeStore({ filePath });
        assert.equal(store.read(), DEFAULT_TEXT_SIZE, 'no file yet');
        await store.write(150);
        assert.equal(createTextSizeStore({ filePath }).read(), 150);
        await store.write(125);
        assert.equal(store.read(), 125, 'a second write replaces the first');
        await fs.promises.writeFile(filePath, '{not json');
        assert.equal(store.read(), DEFAULT_TEXT_SIZE);
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'text size: a window keeps the room its words need, within the screen',
    run() {
      const base = { minimum: [720, 520], size: [1180, 860] };
      const workArea = { x: 0, y: 25, width: 1728, height: 1050 };
      assert.deepEqual(fitWindowToTextSize({ base, current: [1180, 860], percent: 150, workArea }), { minimum: [1080, 780], size: [1180, 860] }, 'a window that is large enough is left alone');
      assert.deepEqual(fitWindowToTextSize({ base, current: [1180, 860], percent: 200, workArea }), { minimum: [1440, 1040], size: [1440, 1040] }, 'a window that is now too small grows to the minimum');
      assert.deepEqual(fitWindowToTextSize({ base, current: [1180, 860], percent: 150, workArea, opening: true }), { minimum: [1080, 780], size: [1728, 1050] }, 'a new window opens larger, up to the screen');
      assert.deepEqual(fitWindowToTextSize({ base, current: [900, 700], percent: 200, workArea: { x: 0, y: 0, width: 1280, height: 720 } }), { minimum: [1280, 720], size: [1280, 720] }, 'never larger than the screen');
      assert.deepEqual(fitWindowToTextSize({ base, current: [1180, 860], percent: 80, workArea }), { minimum: [576, 416], size: [1180, 860] }, 'a smaller size never shrinks a window');
    },
  },
  {
    name: 'text size: one change reaches every open window and every window opened later',
    async run() {
      const { controller, open, writes, changes } = setup();
      const main = open();
      const second = open({ size: [380, 560], minimum: [320, 380], position: [1500, 600] });
      main.webContents.emit('dom-ready');
      assert.deepEqual(main.zooms, [1]);
      assert.deepEqual(main.size, [1180, 860], 'the default size changes nothing');
      assert.equal(main.centered, 0);

      const state = await controller.set(200);
      assert.equal(state.percent, 200);
      assert.equal(state.canGrow, false);
      assert.deepEqual([main.zooms.at(-1), second.zooms.at(-1)], [2, 2]);
      assert.deepEqual(main.minimum, [1440, 1040]);
      assert.deepEqual(main.size, [1440, 1040]);
      assert.deepEqual(second.minimum, [640, 760]);
      assert.deepEqual(second.size, [640, 760]);
      assert.deepEqual(second.position, [1088, 315], 'a window grown past the screen edge is brought back');
      assert.deepEqual(writes, [200]);
      assert.deepEqual(changes, [200]);

      const practice = open({ size: [960, 640], minimum: [760, 520] });
      assert.deepEqual(practice.size, [1728, 1050], 'opens larger, up to the screen');
      assert.deepEqual(practice.minimum, [1520, 1040]);
      assert.equal(practice.centered, 1);
      practice.webContents.emit('did-finish-load');
      assert.deepEqual(practice.zooms, [2], 'a page loaded later gets the setting');

      await controller.set(200);
      assert.deepEqual(writes, [200], 'the same value is not written again');
      await controller.step(-1);
      assert.equal(controller.state().percent, 175);
      assert.deepEqual(main.size, [1440, 1040], 'a smaller size leaves the window as it is');
      assert.deepEqual(main.minimum, [1260, 910]);
      await controller.reset();
      assert.deepEqual(main.minimum, [720, 520]);
      assert.equal(main.zooms.at(-1), 1);
    },
  },
  {
    name: 'text size: a saved size applies to the first window, and a failed save still changes the windows',
    async run() {
      const { open } = setup({ saved: 125 });
      const main = open();
      assert.deepEqual(main.size, [1475, 1050]);
      assert.deepEqual(main.minimum, [900, 650]);

      const windows = [];
      const controller = createTextSizeController({ store: { read: () => 100, write: async () => { throw new Error('disk full'); } }, getAllWindows: () => windows, defer: task => task() });
      const win = new FakeWindow(); windows.push(win); controller.adopt(win);
      assert.equal((await controller.set(150)).percent, 150);
      assert.equal(win.zooms.at(-1), 1.5);
    },
  },
  {
    name: 'text size: the menu steps the same setting and only a listed size is accepted from the window',
    async run() {
      const { controller } = setup();
      const items = textSizeMenuItems(controller);
      assert.deepEqual(items.filter(item => item.visible !== false).map(item => item.label), ['Bigger Text', 'Smaller Text', 'Default Text Size']);
      items[0].click(); await Promise.resolve();
      assert.equal(controller.state().percent, 110);
      items.at(-1).click(); await Promise.resolve();
      assert.equal(controller.state().percent, 100);

      const handlers = new Map();
      registerTextSizeHandlers({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guarded: handler => async (_event, ...args) => handler(...args), controller });
      assert.deepEqual([...handlers.keys()], [TEXT_SIZE_GET_CHANNEL, TEXT_SIZE_SET_CHANNEL]);
      assert.equal((await handlers.get(TEXT_SIZE_GET_CHANNEL)({})).percent, 100);
      assert.equal((await handlers.get(TEXT_SIZE_SET_CHANNEL)({}, { percent: 150 })).percent, 150);
      for (const bad of [undefined, 150, { percent: 120 }, { percent: '150' }, { percent: 150, extra: 1 }]) await assert.rejects(handlers.get(TEXT_SIZE_SET_CHANNEL)({}, bad), TypeError);
      assert.equal(controller.state().percent, 150);

      const main = fs.readFileSync('electron/interviewApp/main.js', 'utf8');
      assert.match(main, /app\.on\('browser-window-created', \(_event, win\) => textSize\.adopt\(win\)\)/u, 'every window the app opens is adopted');
      assert.match(main, /role: 'editMenu'/u, 'the custom menu keeps copy and paste');
    },
  },
];
