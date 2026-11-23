// Main process of the standalone Interview Helper app.
//
// Interview Helper began as a node inside Infinite Canvas and is now its own app
// and repository. Feature code lives under electron/ and src/.
import electronPkg from 'electron';
import path from 'path';
import fs from 'node:fs';
import { atomicWriteFile } from '../utils/atomicWrite.js';
import { getRecentLogs, logger } from '../logger.js';
import { pathToFileURL } from 'node:url';
import { registerCareerTextHandlers } from '../ipc/careerText.js';
import { registerInterviewHelperHandlers } from '../ipc/interviewHelper.js';
import { registerInterviewPreparationHandlers } from '../ipc/interviewPreparation.js';
import { createPracticeCallController, createReplayHandler } from '../practiceCall/callWindow.js';
import { createPracticeAudioHelper, practiceAudioHelperPath } from '../interviewPracticeAudio.js';
import { createMicrophoneAccess } from '../practiceCall/microphoneAccess.js';
import { getInterviewPracticeRegistry } from '../ipc/interviewPracticeRegistry.js';
import { createInterviewClaudeTransport } from '../ipc/interviewClaudeTransport.js';
import { claudeUsageLimit, recheckClaudeUsageAfterWake } from '../ipc/claudePause.js';
import { claudePauseDiagnosticsMarkdown, recordClaudePauseEvent } from '../ipc/claudePauseDiagnostics.js';
import { registerNetworkHandlers } from '../ipc/network.js';
import { flushNonApiAiPersistence, getNonApiAiHandoffLifecycleSnapshot, registerNonApiAiHandlers } from '../ipc/nonApiAi.js';
import { claudeTaskWorkerActivity, claudeTaskWorkerStatus, registerClaudePauseHandlers, registerClaudeTaskActivityHandler, registerClaudeTaskStatusHandler, startClaudeTaskWorker, wakeClaudeTaskWorker } from '../ipc/claudeTaskWorker.js';
import { isRendererSensitivePath, registerRendererPrivateAppRoot } from '../utils/pathSafety.js';
import { createInterviewSessionStore, decodeInterviewStateFile, encodeInterviewStateFile, saveWindowStateNow } from './sessionStore.js';
import { interviewAppDataRoots } from './dataRoots.js';
import { migrateInterviewDataFromCanvas } from './migrateFromCanvas.js';
import { createCareerFileConversionService, registerCareerConversionHandlers } from './careerFileConversion.js';
import { handleSafe, snapshotActiveNodeTasks } from '../ipc/ipcUtils.js';
import { BUG_REPORT_DIRECTORY, PROCESS_STARTED_AT, createBugReportService, createBugReportStore, listDataFolder, registerBugReportHandlers } from './bugReport.js';
import { createSaveLocationStore, saveDialogStartPath } from './saveLocation.js';
import { attachContextMenu } from './contextMenu.js';
import { TEXT_SIZE_CHANGED_CHANNEL, createTextSizeController, createTextSizeStore, registerTextSizeHandlers, textSizeMenuItems } from './textSize.js';
import { createPracticeVoiceStore, practiceVoiceState, registerPracticeVoiceHandlers } from './practiceVoiceSetting.js';
import { CANDIDATE_VOICE_GENDERS } from '../practiceCall/candidateVoice.js';
import { parallelImageSearch, readParallelKey } from '../ipc/parallelSearch.js';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell, systemPreferences } = electronPkg;

// The profile folder must be this app's own: two running Electron apps cannot
// share one. Set before `ready`, and before anything reads the path.
app.setName('Interview Helper');
const roots = interviewAppDataRoots({ appDataPath: app.getPath('appData'), env: process.env });
app.setPath('userData', roots.profile);

// Interview data (career text, prepared briefs, answer banks, Q&A, practice calls) lives in
// this app's own data folder. The shared stores take their root from `appInstance.getPath('userData')`.
const dataApp = Object.freeze({
  getPath: name => (name === 'userData' ? roots.data : app.getPath(name)),
  getAppPath: () => app.getAppPath(),
  get isPackaged() { return app.isPackaged; },
});

const RENDERER_DIR = path.join(__dirname, '../dist-interview');
const RENDERER_HTML = path.join(RENDERER_DIR, 'interview.html');
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;
const asarUnpacked = file => file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

function isOwnRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.search = ''; url.hash = '';
    const own = DEV_SERVER_URL ? new URL('interview.html', DEV_SERVER_URL).toString() : pathToFileURL(RENDERER_HTML).toString();
    return url.toString() === own;
  } catch { return false; }
}

let mainWindow = null;
let practiceCallController = null;
let quitting = false;
let sessionStore = null;

/** A File menu command for the main window, which owns the list and shows the result. */
// The menu bar's two faces: the app's own menu, and the short one shown while the call window is in front.
let appMenu = null;
let callMenu = null;

/** Opens the Settings dialog in the main window (App menu, ⌘,). */
function openSettings() {
  const win = createMainWindow();
  const send = () => { try { win.webContents.send('interview-app:open-settings'); } catch { /* the window is going away */ } };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
}

// The candidate's voice in practice calls (female or male), read by the call for every spoken line.
let practiceVoice = null;

function sendFileCommand(command) {
  const win = createMainWindow();
  const send = () => { try { win.webContents.send('interview-app:file-command', command); } catch { /* the window is going away */ } };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
}

/** The window's newest state, then every queued write, on disk. Never rejects: closing must go on. */
const saveEverythingNow = win => saveWindowStateNow({ win, ipcMain }).catch(() => false).then(() => sessionStore?.flush()).catch(() => {});

const isMainWindow = owner => !!owner && owner === mainWindow && !owner.isDestroyed();
function ownerOf(sender) {
  try {
    const contents = sender?.webContents ?? electronPkg.webContents?.fromFrame?.(sender) ?? sender;
    return BrowserWindow.fromWebContents(contents) || null;
  } catch { return null; }
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return mainWindow; }
  const win = new BrowserWindow({
    width: 1180, height: 860, minWidth: 720, minHeight: 520,
    title: 'Interview Helper', backgroundColor: '#111018', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'interviewAppPreload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // Preparation keeps running while the window is behind a call app.
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  win.webContents.__isInterviewAppRenderer = true;
  win.once('ready-to-show', () => { try { win.show(); } catch { /* closed before show */ } });
  // Closing the window saves first. Quitting saves in before-quit, before any window closes.
  let savedForClose = false;
  win.on('close', (event) => {
    if (savedForClose || quitting) return;
    event.preventDefault();
    saveEverythingNow(win).finally(() => { savedForClose = true; try { if (!win.isDestroyed()) win.close(); } catch { /* already gone */ } });
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (DEV_SERVER_URL) win.loadURL(new URL('interview.html?view=interview-helper', DEV_SERVER_URL).toString());
  else win.loadFile(RENDERER_HTML, { search: 'view=interview-helper' });
  return win;
}

app.on('web-contents-created', (_event, contents) => {
  // Right-click: spelling corrections, then Cut, Copy and Paste, in every window.
  attachContextMenu(contents, { Menu, BrowserWindow, logger });
  contents.setWindowOpenHandler(({ url }) => {
    // Source links in the Q&A open in the default browser; nothing opens in-app.
    if (contents.__isInterviewAppRenderer) {
      try { if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* invalid link */ }
    }
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, navigationUrl) => {
    // Every window of this app shows one page of its own renderer bundle.
    if (!isOwnRendererUrl(navigationUrl)) event.preventDefault();
  });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([
    // Replay audio of practice calls; only known call ids are served.
    { scheme: 'practice-call', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
  app.on('second-instance', () => { if (app.isReady()) createMainWindow(); });

  app.whenReady().then(async () => {
    await roots.ensure();
    // First start as its own app: copy the interview data Infinite Canvas used to hold. Read-only on that folder.
    try {
      const moved = await migrateInterviewDataFromCanvas({ legacyRoot: roots.legacy, dataRoot: roots.data, logger });
      if (moved.copied.length) logger.info?.(`[InterviewApp] copied interview data from the Infinite Canvas folder: ${moved.copied.join(', ')}`);
    } catch (error) { logger.warn?.(`[InterviewApp] interview data was not copied: ${error?.message || error}`); }
    // The data folder holds private stores; no renderer may read it by path.
    try { registerRendererPrivateAppRoot(roots.data); registerRendererPrivateAppRoot(roots.profile); } catch { /* guard is advisory here */ }

    const sessions = createInterviewSessionStore({ filePath: path.join(roots.data, 'interview-helper-sessions.json') });
    sessionStore = sessions;
    const guarded = handler => async (event, ...args) => {
      // Only the top frame of this app's own window may read or change saved interviews.
      if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || (event.senderFrame && event.senderFrame.parent)) throw new Error('Interview Helper request was not authorized.');
      return handler(...args);
    };
    // Text size: one setting for the main window and the practice call.
    const textSize = createTextSizeController({
      store: createTextSizeStore({ filePath: path.join(roots.profile, 'text-size.json') }),
      getAllWindows: () => BrowserWindow.getAllWindows(),
      screen: electronPkg.screen, logger,
      onChange: (state) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(TEXT_SIZE_CHANGED_CHANNEL, state); },
    });
    app.on('browser-window-created', (_event, win) => textSize.adopt(win));
    registerTextSizeHandlers({ ipcMain, guarded, controller: textSize });
    practiceVoice = createPracticeVoiceStore({ filePath: path.join(roots.profile, 'practice-voice.json') });
    registerPracticeVoiceHandlers({ ipcMain, guarded, store: practiceVoice });
    // The app menu with Settings… in its usual place, after About.
    const appMenuWithSettings = { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => openSettings() },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] };
    appMenu = Menu.buildFromTemplate([
      appMenuWithSettings,
      // Save and Load act on the main window, whichever window is in front.
      { label: 'File', submenu: [
        { label: 'Save Interviews…', accelerator: 'CommandOrControl+S', click: () => sendFileCommand('save') },
        { label: 'Load Interviews…', accelerator: 'CommandOrControl+O', click: () => sendFileCommand('load') },
        { type: 'separator' }, { role: 'close' },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [...textSizeMenuItems(textSize), { type: 'separator' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
      { role: 'windowMenu' },
    ]);
    // What the menu bar shows while the call window is in front: a call has no interview list
    // to save or load and no page to reload, so only what a call window uses is left.
    callMenu = Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'Call', submenu: [{ role: 'close' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [...textSizeMenuItems(textSize), { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]);
    Menu.setApplicationMenu(appMenu);
    ipcMain.handle('interview-app:load-state', guarded(() => sessions.load()));
    ipcMain.handle('interview-app:save-state', guarded(state => sessions.save(state)));
    // The interview list as a file the person keeps. It holds the list only: career text, Q&A,
    // briefs and recordings stay in this app's data folder and are found again by interview id.
    // Both dialogs open on the file last saved or loaded. Remembering it is a convenience:
    // a failed write of the location never fails the save or load itself.
    const saveLocation = createSaveLocationStore({ filePath: path.join(roots.profile, 'save-location.json') });
    const rememberSaveLocation = async (filePath) => {
      try { await saveLocation.write(filePath); } catch (error) { logger.warn?.(`[InterviewApp] save location not remembered: ${error?.message || error}`); }
    };
    ipcMain.handle('interview-app:save-state-to-file', guarded(async () => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save interviews to a file',
        defaultPath: saveDialogStartPath(saveLocation.read(), `Interview Helper ${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'Interview Helper state', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      await sessions.flush();
      await atomicWriteFile(result.filePath, encodeInterviewStateFile(await sessions.load()));
      await rememberSaveLocation(result.filePath);
      return { saved: true, fileName: path.basename(result.filePath) };
    }));
    ipcMain.handle('interview-app:load-state-from-file', guarded(async () => {
      const start = saveDialogStartPath(saveLocation.read());
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Load interviews from a file', properties: ['openFile'],
        ...(start ? { defaultPath: start } : {}),
        filters: [{ name: 'Interview Helper state', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { cancelled: true };
      const stat = await fs.promises.stat(result.filePaths[0]);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('That file is too large to be a saved Interview Helper state.');
      const loaded = decodeInterviewStateFile(await fs.promises.readFile(result.filePaths[0], 'utf8'));
      await sessions.flush();
      const current = await sessions.load();
      const count = list => `${list.length} interview${list.length === 1 ? '' : 's'}`;
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `Replace the ${count(current.sessions)} in this window with the ${count(loaded.sessions)} in "${path.basename(result.filePaths[0])}"?`,
        detail: 'The list as it is now is kept as a backup file in the app\'s data folder. Saved Q&A, career data and recordings are not touched.',
      });
      if (answer.response !== 0) return { cancelled: true };
      // The replaced list is never lost: it is written beside the live one first.
      await atomicWriteFile(path.join(roots.data, `interview-helper-sessions.before-load-${Date.now()}.json`), encodeInterviewStateFile(current));
      // The loaded file is now the current save: the next Save or Load starts there.
      await rememberSaveLocation(result.filePaths[0]);
      // The folder is this machine's setting; a file from elsewhere must not point it at a missing path.
      return { state: await sessions.save({ ...loaded, appliedJobsFolder: current.appliedJobsFolder || loaded.appliedJobsFolder }) };
    }));
    ipcMain.handle('interview-app:choose-career-files', guarded(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose career files', properties: ['openFile', 'multiSelections'],
        // Any file type: each is converted to text before the text-only compile reads it.
        filters: [{ name: 'All files', extensions: ['*'] }],
      });
      return result.canceled ? [] : result.filePaths;
    }));
    ipcMain.handle('interview-app:choose-applied-jobs-folder', guarded(async () => {
      const current = (await sessions.load()).appliedJobsFolder;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose your Applied Jobs folder', properties: ['openDirectory'],
        ...(current ? { defaultPath: current } : {}),
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    }));

    // Career files of any type are converted to text in a private folder; that folder and
    // ordinary .txt/.md files are the only things the career import reads. No AI compiles them.
    let convertedRoot = null;
    const careerConversion = createCareerFileConversionService({
      dataRoot: roots.data,
      transport: createInterviewClaudeTransport(),
      registerInputRoot: root => { convertedRoot = root; },
      showItemInFolder: file => shell.showItemInFolder(file),
    });
    registerCareerConversionHandlers({ handleSafe, ipcMain, guarded, service: careerConversion });
    try { await careerConversion.conversionsRoot(); } catch (error) { logger.warn?.('[career conversion] folder unavailable:', error?.message || error); }
    registerCareerTextHandlers({
      handleSafe, userDataPath: () => roots.data,
      allowedPrivateRoots: () => (convertedRoot ? [convertedRoot] : []),
      isSensitivePath: isRendererSensitivePath,
    });
    registerInterviewHelperHandlers({ appInstance: dataApp });
    registerInterviewPreparationHandlers({
      appInstance: dataApp,
      // No canvas here: the list comes from the folder chosen in this app.
      resolveAppliedJobsRoot: async () => (await sessions.load()).appliedJobsFolder || null,
      onQaChanged: (change) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('interview-app:qa-changed', change); },
    });
    try {
      const reviewTransport = createInterviewClaudeTransport();
      const practiceCallText = ({ prompt, schema, signal } = {}) => reviewTransport.callText(prompt, {
        signal, task: 'practice-review', claudeStage: 'qa-practice-review', responseSchema: schema,
      });
      // The careful planning step before a practice call: its own stage, routed to DeepSeek Flash at high reasoning (aiCallProviders.js).
      const practicePlanText = ({ prompt, schema, signal } = {}) => reviewTransport.callText(prompt, {
        signal, task: 'practice-plan', claudeStage: 'practice-call-plan', responseSchema: schema,
      });
      // Testing aid: the candidate's reply to the latest question, for the call chat's "Suggest a reply" button. Plain text, no schema.
      const practiceDraftText = ({ prompt, signal, pageImages } = {}) => reviewTransport.callRaw(prompt, {
        signal, task: 'practice-draft-answer', claudeStage: 'practice-call-draft-answer',
        ...(Array.isArray(pageImages) && pageImages.length ? { pageImages } : {}),
      });
      // Testing aid: the wand working a coding-pad exercise, as steps of a spoken line and the pad after it (JSON).
      const practiceDraftWorkText = ({ prompt, schema, signal, pageImages } = {}) => reviewTransport.callText(prompt, {
        signal, task: 'practice-draft-work', claudeStage: 'practice-call-draft-work', responseSchema: schema,
        ...(Array.isArray(pageImages) && pageImages.length ? { pageImages } : {}),
      });
      // Shared-screen visuals, made during setup: choosing a Commons picture (it reads the candidates) and drawing a diagram.
      const practiceVisualPickText = ({ prompt, schema, signal, pageImages } = {}) => reviewTransport.callText(prompt, {
        signal, task: 'practice-visual-pick', claudeStage: 'practice-call-visual-pick', responseSchema: schema, pageImages,
      });
      const practiceDiagramText = ({ prompt, schema, signal } = {}) => reviewTransport.callText(prompt, {
        signal, task: 'practice-diagram', claudeStage: 'practice-call-diagram', responseSchema: schema,
      });
      // Delivery tags for the candidate's spoken line (a sent chat message spoken in the candidate's voice). Plain text, no schema.
      const practiceCandidateTagText = ({ prompt, signal } = {}) => reviewTransport.callRaw(prompt, {
        signal, task: 'practice-candidate-voice', claudeStage: 'practice-call-candidate-voice',
      });
      const helperPath = practiceAudioHelperPath({ packaged: app.isPackaged, projectDir: app.getAppPath() || process.cwd() });
      // An earlier "Don't Allow" is cleared only for the installed app and its helper; a
      // development run belongs to Electron's own bundle and is left alone.
      const microphoneAccess = createMicrophoneAccess({
        systemPreferences, shell,
        bundleIds: app.isPackaged ? ['com.antigravity.interviewhelper', 'com.antigravity.infinitecanvas.practice-audio'] : [],
      });
      practiceCallController = createPracticeCallController({
        BrowserWindow, ipcMain, appInstance: dataApp,
        openMicrophoneSettings: () => microphoneAccess.openSettings(),
        // The call window's own voice choice reads and writes the same setting as Settings; a change applies to the next line.
        getCandidateVoice: () => (practiceVoice ? practiceVoiceState(practiceVoice.read()) : null),
        setCandidateVoice: async gender => {
          if (!practiceVoice || !CANDIDATE_VOICE_GENDERS.includes(gender)) throw new TypeError('That voice is not one of the choices.');
          return practiceVoiceState(await practiceVoice.write(gender));
        },
        callMenu: {
          enter: () => { if (callMenu) Menu.setApplicationMenu(callMenu); },
          leave: () => { if (appMenu) Menu.setApplicationMenu(appMenu); },
        },
        isAuthorizedOwner: sender => { const owner = ownerOf(sender); return !!owner && !owner.isDestroyed() && (isMainWindow(owner) || owner === practiceCallController?.getWindow()); },
        preloadPath: path.join(__dirname, 'practiceCallPreload.js'),
        devServerUrl: DEV_SERVER_URL ? new URL('interview.html', DEV_SERVER_URL).toString() : null,
        distHtmlPath: RENDERER_HTML,
        callText: practiceCallText,
        registry: getInterviewPracticeRegistry(),
        serviceOptions: {
          planText: practicePlanText,
          draftText: practiceDraftText,
          draftWorkText: practiceDraftWorkText,
          // Sent chat messages are spoken in the candidate's own voice (off in the unit suites).
          candidateVoices: true,
          // A warm cut-in watcher session that decides, from the last seconds of an answer, whether the interviewer would cut in (off in the unit suites).
          watcher: true,
          candidateTagText: practiceCandidateTagText,
          candidateVoiceGender: () => practiceVoice?.read(),
          // Pictures and diagrams on the prepared shared screens (off in the unit suites).
          visualPickText: practiceVisualPickText,
          diagramText: practiceDiagramText,
          // Pictures are searched for on the web with Parallel's image search (the Keychain key signs it in).
          imageSearch: async ({ objective, queries, signal } = {}) => {
            return parallelImageSearch({ objective, queries, key: await readParallelKey(), signal });
          },
          logger,
          inferenceWorkerPath: asarUnpacked(path.join(__dirname, 'inferenceWorkerThread.js')),
          // The packaged helper lives in Resources; the default only knows the project folder.
          // The macOS microphone prompt is shown before the helper opens the microphone. A
          // refusal does not stop the call: the helper then runs without capture, so the
          // interviewer is heard, the candidate is not, and the chat still works.
          helperFactory: options => {
            const helper = createPracticeAudioHelper({ onStderr: line => logger.info(`[PracticeAudio stderr] ${line}`), ...options, helperPath });
            return Object.freeze({
              ...helper,
              start: async startOptions => {
                const access = await microphoneAccess.ensure();
                if (access !== 'granted') logger.warn(`[PracticeCall] microphone access is ${access}: the call runs without the candidate's voice`);
                return helper.start(startOptions);
              },
            });
          },
        },
      });
      protocol.handle('practice-call', createReplayHandler({ store: practiceCallController.store }));
    } catch (error) {
      logger.warn(`[PracticeCall] unavailable: ${error?.message || error}`);
    }

    registerNetworkHandlers();
    registerNonApiAiHandlers();
    // Preparation and the typed job are answered by the local Claude Code CLI through this worker.
    startClaudeTaskWorker({ userData: roots.profile, nativeImage: electronPkg.nativeImage, getAllWindows: () => BrowserWindow.getAllWindows() });
    registerClaudeTaskStatusHandler({ ipcMain });
    registerClaudeTaskActivityHandler({ ipcMain });
    registerClaudePauseHandlers({ ipcMain });
    try {
      electronPkg.powerMonitor.on('suspend', () => recordClaudePauseEvent({ kind: 'system-suspend' }));
      electronPkg.powerMonitor.on('resume', () => {
        try { recordClaudePauseEvent({ kind: 'system-resume' }); recheckClaudeUsageAfterWake(); wakeClaudeTaskWorker(); } catch { /* a wake re-check cannot affect the app */ }
      });
    } catch { /* no power monitor: timers alone still resume the work */ }
    // "Report a bug": states, counts and logs only; see bugReport.js for what a report holds.
    const bugReports = createBugReportStore({ directory: path.join(roots.profile, BUG_REPORT_DIRECTORY) });
    void bugReports.prune().then((result) => { if (result.error) logger.warn(`[BugReport] saved reports were not cleaned up: ${result.error}`); });
    registerBugReportHandlers({
      ipcMain, guarded,
      service: createBugReportService({
        store: bugReports, clipboard, dialog,
        getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
        desktopPath: () => app.getPath('desktop'),
        sources: {
          app: () => app,
          windows: () => ({ 'Practice call': Boolean(practiceCallController?.getWindow()) }),
          sessions: () => sessions.load(),
          claudeStatus: () => claudeTaskWorkerStatus(),
          claudeActivity: () => claudeTaskWorkerActivity(),
          claudePauses: () => claudePauseDiagnosticsMarkdown({ current: claudeUsageLimit() }),
          activeTasks: () => snapshotActiveNodeTasks(),
          handoffs: () => getNonApiAiHandoffLifecycleSnapshot(),
          dataFolder: () => listDataFolder(roots.data),
          // Every call of this run (else the newest) with its whole debug log and transcript, and the call window's events.
          practiceCalls: async () => {
            const store = practiceCallController?.store;
            if (!store) return { calls: [], windowEvents: practiceCallController?.windowEvents?.() ?? null, logStats: null };
            const [calls, logStats] = await Promise.all([
              store.recentDiagnostics?.({ since: PROCESS_STARTED_AT }) ?? [],
              store.debugLogStats?.().catch(() => null) ?? null,
            ]);
            return { calls, windowEvents: practiceCallController.windowEvents?.() ?? null, logStats };
          },
          logs: () => getRecentLogs(),
        },
      }),
    });
    createMainWindow();
    app.on('activate', () => createMainWindow());
  }).catch(error => {
    logger.error(`[InterviewApp] startup failed: ${error?.stack || error}`);
    dialog.showErrorBox('Interview Helper could not start', String(error?.message || error));
    app.exit(1);
  });

  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    Promise.resolve()
      // The interview list first: the window's newest change, then every queued write.
      .then(() => saveEverythingNow(mainWindow))
      .then(() => flushNonApiAiPersistence())
      .catch(() => {})
      // A practice call in progress is saved (recording and transcript, no review) before the app goes.
      .then(() => practiceCallController?.shutdown?.())
      .catch(() => {})
      .finally(() => { try { practiceCallController?.dispose(); } catch { /* already closed */ } app.exit(0); });
  });
}
