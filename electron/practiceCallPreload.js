// CommonJS preload for the sandboxed practice-call window.
const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = 'practice-call-window:';
const MAX_CHAT = 2000;
const MAX_PAD = 20000;
const MAX_EVENT_LINE = 600;

function fail(message) { throw new TypeError(`practiceCallAPI: ${message}`); }
function booleanArg(value, name) { if (typeof value !== 'boolean') fail(`${name} expects a boolean`); return value; }
function chatText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_CHAT) fail(`sendChat expects 1-${MAX_CHAT} characters`);
  return value;
}
function padText(value) {
  if (typeof value !== 'string') fail('updatePad expects a string');
  return value.slice(0, MAX_PAD);
}
function subscribe(channel, cb) {
  if (typeof cb !== 'function') fail('subscription expects a function');
  const listener = (_event, payload) => { try { cb(payload); } catch { /* renderer callback errors stay in the renderer */ } };
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => { if (!active) return; active = false; ipcRenderer.removeListener(channel, listener); };
}
const invoke = (name, ...args) => ipcRenderer.invoke(`${PREFIX}${name}`, ...args);

const practiceCallAPI = Object.freeze({
  getState: () => invoke('get-state'),
  onState: cb => subscribe(`${PREFIX}state`, cb),
  onEvent: cb => subscribe(`${PREFIX}event`, cb),
  agreeModelDownload: () => invoke('agree-model-download'),
  ready: () => invoke('ready'),
  answer: () => invoke('answer'),
  decline: () => invoke('decline'),
  callBack: () => invoke('call-back'),
  cancelCallBack: () => invoke('cancel-call-back'),
  leave: () => invoke('leave'),
  chooseFeedback: wants => invoke('choose-feedback', booleanArg(wants, 'chooseFeedback')),
  hangUp: options => invoke('hang-up', { feedback: options?.feedback !== false }),
  setMuted: muted => invoke('set-muted', booleanArg(muted, 'setMuted')),
  // generated: the text came from Suggest a reply (it does not count as practising a question).
  sendChat: (text, options) => invoke('send-chat', chatText(text), { generated: options?.generated === true }),
  setTyping: typing => invoke('set-typing', booleanArg(typing, 'setTyping')),
  setPaused: paused => invoke('set-paused', booleanArg(paused, 'setPaused')),
  updatePad: text => invoke('update-pad', padText(text)),
  // The language the candidate picked for the pad when the exercise leaves it open; the main process checks the name.
  setPadLanguage: name => invoke('set-pad-language', typeof name === 'string' ? name.slice(0, 40) : ''),
  draftAnswer: () => invoke('draft-answer'),
  getPreparedCards: () => invoke('get-prepared-cards'),
  getReplay: () => invoke('get-replay'),
  onReplayUpdated: cb => subscribe(`${PREFIX}replay-updated`, cb),
  deleteRecording: () => invoke('delete-recording'),
  openMicrophoneSettings: () => invoke('open-microphone-settings'),
  close: () => invoke('close'),
  // One line of the window's own event log (clicks, errors, console warnings) for the call's debug log.
  logEvent: line => invoke('log-event', typeof line === 'string' ? line.slice(0, MAX_EVENT_LINE) : ''),
});

contextBridge.exposeInMainWorld('practiceCallAPI', practiceCallAPI);
