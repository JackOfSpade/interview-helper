import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPkg from 'electron';
import { createCallStore, isPracticeCallId } from './callStore.js';
import { createPracticeCallService } from './callService.js';
import { createReplayHandler } from './replayProtocol.js';

// Same import as interviewWindow.js: works in the CommonJS main bundle (no import.meta) and under the test stub.
const electron = () => electronPkg;
const WINDOW_PREFIX = 'practice-call-window:';
const WINDOW_CHANNELS = Object.freeze([
  'get-state', 'agree-model-download', 'ready', 'answer', 'decline', 'call-back', 'cancel-call-back', 'hang-up', 'leave', 'choose-feedback', 'set-muted', 'send-chat',
  'set-typing', 'set-paused', 'update-pad', 'draft-answer', 'get-prepared-cards', 'get-replay', 'delete-recording', 'open-microphone-settings', 'close', 'log-event',
]);
// The call window's own event lines kept for bug reports (newest last), in memory only.
const WINDOW_EVENTS_KEPT = 300;

// While the service is in one of these phases a call is in progress or being wrapped up.
const RUNNING_PHASES = new Set(['consent', 'downloading', 'precheck', 'ringing', 'missed', 'calling', 'connecting', 'in-call', 'ended', 'analyzing']);
// A missed call nobody returned in time has let go of everything: the window only still says so.
const isRunning = state => RUNNING_PHASES.has(state?.phase) && !(state.phase === 'missed' && state.missed === 'expired');
// Phases a starting call passes through before it rings; the window opens at the first of them.
const SETUP_PHASES = new Set(['consent', 'downloading', 'precheck', 'ringing']);

function childUrl({ devServerUrl, distHtmlPath, replay = false, callId = null }) {
  const search = new URLSearchParams({ view: 'practice-call' });
  if (replay) search.set('replay', '1');
  if (callId) search.set('callId', callId);
  if (devServerUrl) return new URL(`?${search.toString()}`, new URL(devServerUrl)).toString();
  return `${pathToFileURL(distHtmlPath).toString()}?${search.toString()}`;
}

function trustedOwner(event, owner, authorized, nodeId) {
  try {
    if (typeof authorized !== 'function') return false;
    const sender = event?.senderFrame ?? event?.sender ?? null;
    if (!authorized(sender, nodeId)) return false;
    if (!owner) return true;
    if (owner.isDestroyed?.()) return false;
    return !event?.senderFrame || event.senderFrame === owner.webContents.mainFrame;
  } catch {
    return false;
  }
}

/**
 * One practice-call window per call plus the canvas- and window-facing IPC.
 * The window is sandboxed with the practice-call preload and the same URL
 * contract as interviewWindow (`?view=practice-call`).
 */
export function createPracticeCallController(deps = {}) {
  const runtime = deps.BrowserWindow && deps.ipcMain ? {} : electron();
  const BrowserWindow = deps.BrowserWindow ?? runtime.BrowserWindow;
  const ipcMain = deps.ipcMain ?? runtime.ipcMain;
  const appInstance = deps.appInstance ?? runtime.app;
  if (typeof BrowserWindow !== 'function' || !ipcMain || typeof deps.isAuthorizedOwner !== 'function') throw new TypeError('Practice call window dependencies are unavailable.');
  const userDataPath = deps.userDataPath ?? appInstance?.getPath?.('userData');
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('Practice call window requires the user data path.');
  const rootDir = deps.rootDir ?? path.join(userDataPath, 'practice-calls');
  const store = deps.store ?? createCallStore({ rootDir });
  const service = deps.service ?? createPracticeCallService({
    store, userDataPath,
    ...(deps.registry ? { registry: deps.registry } : {}),
    ...(typeof deps.callText === 'function' ? { callText: deps.callText } : {}),
    ...(typeof deps.transcribe === 'function' ? { transcribe: deps.transcribe } : {}),
    ...(deps.serviceOptions || {}),
  });
  const devServerUrl = deps.devServerUrl ?? null;
  const distHtmlPath = deps.distHtmlPath ?? path.join(process.cwd(), 'dist', 'index.html');
  const preloadPath = deps.preloadPath ?? path.join(process.cwd(), 'dist-electron', 'practiceCallPreload.js');
  const registerIpc = deps.registerIpc !== false;
  const getOwner = deps.getOwner ?? (() => null);
  let win = null;
  const windowEvents = [];
  let windowEventsDropped = 0;
  let current = null;
  // R10: the mode is read when the window closes, so it must follow window reuse.
  let winMode = null;
  // service.start() awaits several things before its first setup phase; until then there is no window
  // and the phase is not a running one, so this flag is what tells open-replay a call is on its way.
  let starting = false;
  const windowAlive = () => !!win && !win.isDestroyed?.();
  let callMenuShown = false;
  const showCallMenu = shown => {
    if (callMenuShown === shown) return;
    callMenuShown = shown;
    try { (shown ? deps.callMenu?.enter : deps.callMenu?.leave)?.(); } catch { /* the menu is cosmetic */ }
  };
  const alreadyRunning = () => ({
    ...(service.getState?.() ?? {}), phase: 'error',
    error: { code: 'already-running', message: 'A call is already running.' },
  });
  const send = (channel, payload) => { if (windowAlive()) { try { win.webContents.send(channel, payload); } catch { /* window is going away */ } } };
  service.onState?.(state => send(`${WINDOW_PREFIX}state`, state));
  service.onEvent?.(event => send(`${WINDOW_PREFIX}event`, event));
  service.onReplayUpdated?.(replay => send(`${WINDOW_PREFIX}replay-updated`, replay));

  // R10: a replay window is closed before a fresh call window replaces it.
  function closeReplayWindow() {
    const open = win;
    win = null;
    winMode = null;
    current = null;
    try { open?.close?.(); } catch { /* already closing */ }
  }

  function openWindow({ replay = false, callId = null } = {}) {
    if (windowAlive()) {
      winMode = replay ? 'replay' : 'call';
      try { win.show(); win.focus(); } catch { /* window is going away */ }
      return win;
    }
    const options = {
      // Below 760 by 520 the call tiles, names and the chat panel start to cover each other.
      // The text size setting scales this minimum, so it holds at every size.
      width: 960, height: 640, minWidth: 760, minHeight: 520, title: 'Virtual Call', backgroundColor: '#202124', show: false,
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    };
    winMode = replay ? 'replay' : 'call';
    win = new BrowserWindow(options);
    const created = win;
    created.once?.('ready-to-show', () => { try { created.show(); } catch { /* closed before show */ } });
    // Closing the window mid-call is the red button: the call ends and the window stays for the
    // question that follows it (feedback or not). Closing it again answers "no" and goes through.
    created.on?.('close', event => {
      if (win !== created || winMode !== 'call' || service.getState?.()?.phase !== 'in-call') return;
      try { event?.preventDefault?.(); } catch { return; }
      Promise.resolve(service.hangUp?.({ feedback: 'ask' })).catch(() => {});
      try { created.show(); created.focus(); } catch { /* window is going away */ }
    });
    // The menu bar follows the call window: a short call menu while it is in front, the app's own menu otherwise.
    // Off unless the app passes callMenu in, so a unit suite never touches the real menu.
    created.on?.('focus', () => { if (win === created && winMode === 'call') showCallMenu(true); });
    created.on?.('blur', () => { if (win === created) showCallMenu(false); });
    created.on?.('closed', () => {
      if (win === created) showCallMenu(false);
      if (win !== created) return;
      const mode = winMode;
      win = null;
      winMode = null;
      if (mode === 'call') Promise.resolve(service.abandon?.()).catch(() => {});
      else current = null;
    });
    if (devServerUrl) created.loadURL(childUrl({ devServerUrl, distHtmlPath, replay, callId }));
    else created.loadFile(distHtmlPath, { search: `view=practice-call${replay ? '&replay=1' : ''}${callId ? `&callId=${encodeURIComponent(callId)}` : ''}` });
    return created;
  }

  const guardCanvas = handler => async (event, args) => {
    if (!trustedOwner(event, getOwner(), deps.isAuthorizedOwner, args?.nodeId)) throw new Error('Practice call request was not authorized.');
    return handler(args);
  };
  const guardWindow = handler => async (event, ...args) => {
    if (!windowAlive() || !trustedOwner(event, win, deps.isAuthorizedOwner, current?.nodeId)) throw new Error('Practice call window request was not authorized.');
    return handler(...args);
  };

  const handlers = {
    async [WINDOW_PREFIX + 'get-state']() { return service.getState(); },
    async [WINDOW_PREFIX + 'agree-model-download']() { return service.agreeModelDownload(); },
    async [WINDOW_PREFIX + 'ready']() { return service.ready(); },
    async [WINDOW_PREFIX + 'answer']() { return service.answer(); },
    // Declining keeps the window: it shows the missed call, which can be returned.
    async [WINDOW_PREFIX + 'decline']() { return service.decline(); },
    async [WINDOW_PREFIX + 'call-back']() { return service.callBack(); },
    async [WINDOW_PREFIX + 'cancel-call-back']() { return service.cancelCallBack(); },
    // Leaving the call only ends it; whether to write feedback is asked on the screen that follows.
    async [WINDOW_PREFIX + 'leave']() { return service.hangUp({ feedback: 'ask' }); },
    async [WINDOW_PREFIX + 'choose-feedback'](wants) {
      const state = await service.chooseFeedback(wants === true);
      // Without feedback there is nothing more to show, so the window goes once the call is saved.
      if (wants !== true && windowAlive()) win.close();
      return state;
    },
    async [WINDOW_PREFIX + 'hang-up'](options) {
      const feedback = options?.feedback !== false;
      const state = await service.hangUp({ feedback });
      // Leaving without feedback has nothing more to show, so the window goes with the call.
      if (!feedback && windowAlive()) win.close();
      return state;
    },
    async [WINDOW_PREFIX + 'set-muted'](muted) { return service.setMuted(muted); },
    async [WINDOW_PREFIX + 'send-chat'](text) { return service.sendChat(text); },
    async [WINDOW_PREFIX + 'set-typing'](typing) { return service.setTyping(typing); },
    async [WINDOW_PREFIX + 'set-paused'](paused) { return service.setPaused(paused); },
    async [WINDOW_PREFIX + 'update-pad'](text) { return service.updatePad(text); },
    async [WINDOW_PREFIX + 'draft-answer']() { return typeof service.draftAnswer === 'function' ? service.draftAnswer() : { error: 'Suggestions are not available.' }; },
    async [WINDOW_PREFIX + 'get-prepared-cards']() { return service.getPreparedCards(); },
    async [WINDOW_PREFIX + 'get-replay']() { return service.getReplay(current?.callId ?? service.getState().callId); },
    async [WINDOW_PREFIX + 'delete-recording']() { return service.deleteRecording(current?.callId ?? service.getState().callId); },
    // Off unless the app passes it in: a unit suite must never open System Settings.
    async [WINDOW_PREFIX + 'open-microphone-settings']() { return typeof deps.openMicrophoneSettings === 'function' ? Boolean(await deps.openMicrophoneSettings()) : false; },
    async [WINDOW_PREFIX + 'close']() { if (windowAlive()) win.close(); return null; },
    async [WINDOW_PREFIX + 'log-event'](line) {
      if (typeof line !== 'string' || !line) return null;
      const text = line.slice(0, 600);
      windowEvents.push(text);
      if (windowEvents.length > WINDOW_EVENTS_KEPT) { windowEvents.shift(); windowEventsDropped += 1; }
      try { service.logWindowEvent?.(text); } catch { /* diagnostics only */ }
      return null;
    },
  };
  if (registerIpc) {
    ipcMain.handle('practice-call:start', guardCanvas(async args => {
      // A window whose call is still going wins with the already-running state. A replay window,
      // or an old call window that has already failed or finished, is replaced by a fresh one.
      if (windowAlive() && winMode === 'call' && isRunning(service.getState?.())) {
        try { win.show(); win.focus(); } catch { /* window is going away */ }
        return alreadyRunning();
      }
      if (windowAlive()) closeReplayWindow();
      // The setup before the call rings (voice, sessions, microphone) takes several seconds.
      // The window opens as soon as that setup begins, so the audio check is on screen while it
      // runs; a start refused outright (nothing prepared, a bad request) opens no window.
      let opened = false;
      const openFor = callId => {
        if (opened) return;
        opened = true;
        current = { callId: callId ?? null, nodeId: args?.nodeId ?? null, replay: false };
        openWindow({ callId: callId ?? null });
      };
      const stopWatching = service.onState?.(state => {
        if (state?.callId && SETUP_PHASES.has(state.phase)) openFor(state.callId);
      });
      let state;
      starting = true;
      try { state = await service.start(args); } finally { starting = false; if (typeof stopWatching === 'function') stopWatching(); }
      if (state?.phase !== 'error') openFor(state?.callId);
      return state;
    }));
    ipcMain.handle('practice-call:open-replay', guardCanvas(async args => {
      if (!args || !isPracticeCallId(args.callId) || typeof args.nodeId !== 'string') throw new TypeError('Practice call replay requires a valid call.');
      const record = await store.readRecord(args.callId);
      if (!record || record.nodeId !== args.nodeId) throw new Error('That practice call is not available.');
      if (starting) return { success: false, error: 'Finish the call in progress before opening a replay.' };
      // A call in progress keeps its window; opening a replay there would take it over.
      if (windowAlive() && winMode === 'call' && isRunning(service.getState?.())) {
        try { win.show(); win.focus(); } catch { /* window is going away */ }
        return { success: false, error: 'Finish the call in progress before opening a replay.' };
      }
      // Any other open window is closed so the replay always opens fresh on the chosen call.
      if (windowAlive()) closeReplayWindow();
      current = { callId: args.callId, nodeId: args.nodeId, replay: true };
      service.showReplay?.(args.callId);
      openWindow({ replay: true, callId: args.callId });
      return { callId: args.callId };
    }));
    ipcMain.handle('practice-call:list', guardCanvas(async args => {
      if (!args || typeof args.nodeId !== 'string' || !args.nodeId) throw new TypeError('Practice calls require a node id.');
      return service.list(args.nodeId);
    }));
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, guardWindow(handler));
  }
  /**
   * The app is quitting. A call in progress is ended first without a review, so its recording
   * and transcript are saved; without this the quit left only a half-written recording. The
   * wait is bounded so a stuck call can never hold the app open.
   */
  async function shutdown({ timeoutMs = 10000 } = {}) {
    try {
      if (isRunning(service.getState?.()) && typeof service.hangUp === 'function') {
        let timer = null;
        const waited = new Promise(resolveWaited => { timer = setTimeout(resolveWaited, timeoutMs); });
        await Promise.race([Promise.resolve(service.hangUp({ feedback: false })).catch(() => {}), waited]);
        clearTimeout(timer);
      }
    } catch { /* quitting anyway */ }
  }

  return Object.freeze({
    service, store, openWindow, shutdown,
    /** The call window's recent event lines (all windows since the app started), for bug reports. */
    windowEvents: () => ({ events: [...windowEvents], eventsDropped: windowEventsDropped }),
    getWindow: () => (windowAlive() ? win : null),
    dispose() {
      if (registerIpc) {
        for (const channel of ['practice-call:start', 'practice-call:open-replay', 'practice-call:list', ...Object.keys(handlers)]) {
          try { ipcMain.removeHandler(channel); } catch { /* not registered */ }
        }
      }
      if (windowAlive()) win.close();
      win = null;
    },
  });
}

export { WINDOW_CHANNELS, WINDOW_PREFIX, childUrl, createReplayHandler };
