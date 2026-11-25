import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { assert } from './testHelpers.js';
import strict from 'node:assert/strict';

const ROOT = path.resolve('.');
const PRACTICE = path.join(ROOT, 'src/practice-call');

// One esbuild graph for every practice-call module plus react-dom/server, so a
// plain renderToStaticMarkup sees the same React the components import.
async function loadServerBundle() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'practice-call-render-'));
  const outfile = path.join(directory, 'bundle.mjs');
  const require = createRequire(import.meta.url);
  const react = require.resolve('react');
  const server = require.resolve('react-dom/server');
  const client = require.resolve('react-dom/client');
  const components = {
    PracticeCallApp: 'PracticeCallApp.jsx',
    ConsentScreen: 'ConsentScreen.jsx',
    DownloadingScreen: 'DownloadingScreen.jsx',
    PrecheckScreen: 'PrecheckScreen.jsx',
    IncomingCall: 'IncomingCall.jsx',
    MissedCall: 'MissedCall.jsx',
    OutgoingCall: 'OutgoingCall.jsx',
    ConnectingScreen: 'ConnectingScreen.jsx',
    InCall: 'InCall.jsx',
    ChatPanel: 'ChatPanel.jsx',
    EndedScreen: 'EndedScreen.jsx',
    Replay: 'Replay.jsx',
    ErrorScreen: 'ErrorScreen.jsx',
    SharedScreen: 'SharedScreen.jsx',
    CodingPad: 'CodingPad.jsx',
    MoreOptions: 'MoreOptions.jsx',
  };
  const namespaces = { callModel: 'callModel.js', replayModel: 'replayModel.js', ringtone: 'ringtone.js', persona: 'persona.js', screenMarkup: 'screenMarkup.js', panelSize: 'panelSize.js' };
  const lines = [
    `import React from ${JSON.stringify(react)};`,
    `import { renderToStaticMarkup } from ${JSON.stringify(server)};`,
    `import { createRoot } from ${JSON.stringify(client)};`,
    'export { React, renderToStaticMarkup, createRoot };',
    ...Object.entries(components).map(([name, file]) => `export { default as ${name} } from ${JSON.stringify(path.join(PRACTICE, file))};`),
    ...Object.entries(namespaces).map(([name, file]) => `export * as ${name} from ${JSON.stringify(path.join(PRACTICE, file))};`),
  ];
  await fs.writeFile(path.join(directory, 'entry.mjs'), `${lines.join('\n')}\n`);
  await build({
    entryPoints: [path.join(directory, 'entry.mjs')],
    bundle: true, platform: 'node', format: 'esm', outfile,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    nodePaths: [path.dirname(path.dirname(react))],
    logLevel: 'silent',
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { module: loaded, dispose: () => fs.rm(directory, { recursive: true, force: true }) };
}

const PERSONA = { name: 'Dana Whitfield', role: 'Hiring manager', team: 'Growth' };

const IN_CALL_STATE = {
  phase: 'in-call', persona: PERSONA, elapsedMs: 72_000, speaking: 'interviewer', muted: false, typing: true,
  captions: [{ speaker: 'candidate', text: 'I led the onboarding rewrite.', atMs: 60_000 }],
  chat: [{ from: 'candidate', text: 'One moment, checking my notes.', atMs: 62_000 }],
};

const REPLAY = {
  callId: 'call-dana-1',
  audioUrl: 'file:///tmp/practice-calls/call-dana-1.wav',
  durationMs: 600_000,
  chapters: [
    { title: 'Small talk', startMs: 0, endMs: 120_000, markers: [{ kind: 'pause', label: 'Long pause', atMs: 30_000 }] },
    { title: 'Onboarding story', startMs: 120_000, endMs: 420_000, markers: [{ kind: 'interruption', label: 'Talked over', atMs: 180_000 }] },
    { title: 'Your questions', startMs: 420_000, endMs: 600_000, markers: [] },
  ],
  transcript: [
    { role: 'interviewer', text: 'Tell me about onboarding.', startMs: 120_000, endMs: 135_000 },
    { role: 'candidate', text: 'We rewrote the first-run flow.', startMs: 135_000, endMs: 200_000 },
  ],
  feedback: { overall: { score: 7, summary: 'Clear story, tidy close.' }, delivery: { wpm: { cited: '168 words per minute' }, pauseCount: 3 } },
  analysis: { status: 'ready' },
};

// A call with feedback the matcher can place: one planned question asked in chapter 1, a small-talk moment in chapter 0.
const REPLAY_FEEDBACK = {
  ...REPLAY,
  persona: { name: 'Dana Whitfield', role: 'Hiring manager' },
  panel: [],
  transcript: [
    { role: 'interviewer', speakerId: 'A', text: 'Hi, how has your day been so far?', startMs: 2_000, endMs: 8_000 },
    { role: 'candidate', text: 'Good, thanks.', startMs: 10_000, endMs: 14_000 },
    { role: 'interviewer', speakerId: 'A', text: 'Tell me about onboarding.', startMs: 120_000, endMs: 135_000 },
    { role: 'candidate', text: 'We rewrote the first-run flow.', startMs: 135_000, endMs: 200_000 },
  ],
  chapters: [
    { title: 'Small talk', questionTurnIndex: 0, startMs: 0, endMs: 120_000, markers: [{ kind: 'pause', label: 'Long pause', atMs: 30_000 }] },
    { title: 'Onboarding story', questionTurnIndex: 2, startMs: 120_000, endMs: 420_000, markers: [{ kind: 'interruption', label: 'Talked over', atMs: 180_000 }] },
    { title: 'Your questions', questionTurnIndex: null, startMs: 420_000, endMs: 600_000, markers: [] },
  ],
  feedback: {
    overall: { score: 7, summary: 'Clear story. Tidy close. A third sentence that the overview cuts. A fourth one.' },
    priorities: ['Name the metric first.', 'Cut the preamble.', 'Close on the ask.', 'A fourth priority that stays out of the overview.'],
    planned: [
      { question: 'Tell me about a time you onboarded users.', asked: true, askedAs: 'Tell me about onboarding.', score: 9, covered: 'You named the first-run flow.', improve: 'Give the activation number.', adapted: 'You shortened it for the time left.', extension: 'Mention the pilot with two teams.' },
    ],
    moments: [{ kind: 'small-talk', prompt: 'Hi, how has your day been so far?', score: 4, note: 'Warm, but you left the plan unconfirmed.' }],
    delivery: { wpm: { cited: '168 words per minute' }, pauseCount: 3 },
  },
  analysis: { status: 'ready' },
};

const MARKERS_BY_KIND = ['data-marker-kind="pause"', 'data-marker-kind="interruption"'];

const PRESENT_STATE = {
  ...IN_CALL_STATE,
  participants: [{ id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' }, { id: 'B', name: 'John Park', role: 'Engineer', status: 'joined' }],
  speakingId: 'B',
};
const SCREEN = { title: 'Two sum', content: 'Given an array, return **two** indices.\n\n- Input: `[2, 7]`\n- Output: `[0, 1]`\n\n```js\nif (a < b && c > d) { return `x`; }\n```', speakerId: 'B', presenterName: 'John Park' };
const group = (n) => Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(65 + i), name: `Person ${String.fromCharCode(65 + i)}`, role: 'Panel', status: 'joined' }));

export const presentingTests = [
  {
    name: 'practice call render: the grid is used until something is shared, then the presenting layout, then the grid again',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const html = state => renderToStaticMarkup(React.createElement(InCall, { state, api: {} }));
        assert(html(PRESENT_STATE).includes('data-layout="grid"') && !html(PRESENT_STATE).includes('data-strip'), 'no screen and no pad keeps the grid');
        const shared = html({ ...PRESENT_STATE, screen: SCREEN });
        assert(shared.includes('data-layout="presenting"') && shared.includes('data-stage="true"') && shared.includes('data-strip="true"'), 'a screen switches to the presenting layout');
        assert(shared.includes('data-presenting-banner="true"') && shared.includes('John Park is presenting') && !shared.includes('(Presentation)'), 'a bar across the top names the presenter, as Meet does');
        assert(/data-presenting="true"[^>]*>/.test(shared), 'the presenter tile is marked for the page, with no label of its own');
        assert(shared.indexOf('data-presenting="true"') > shared.indexOf('aria-label="John Park"') - 400, 'the marked tile is the presenter');
        assert(!shared.includes('data-coding-pad'), 'no pad unless it is open');
        const padOnly = html({ ...PRESENT_STATE, pad: { open: true, lang: 'python', text: 'print(1)' } });
        assert(padOnly.includes('data-layout="presenting"') && padOnly.includes('data-coding-pad="live"') && !padOnly.includes('data-shared-screen'), 'the pad alone fills the stage');
        assert(padOnly.includes('python') && padOnly.includes('print(1)'), 'the pad shows its language and seeded text');
        const closed = html({ ...PRESENT_STATE, screen: null, pad: { open: false, lang: '', text: 'old' } });
        assert(closed.includes('data-layout="grid"') && !closed.includes('data-coding-pad'), 'both ended restores the grid and hides the pad');
        const both = html({ ...PRESENT_STATE, screen: SCREEN, pad: { open: true, lang: 'js', text: '' } });
        assert(both.includes('data-shared-screen') && both.includes('data-coding-pad="live"'), 'screen and pad together');
        assert(both.indexOf('data-shared-screen') < both.indexOf('data-coding-pad'), 'the problem comes before the pad');
        const withChat = renderToStaticMarkup(React.createElement(InCall, { state: { ...PRESENT_STATE, screen: SCREEN }, api: {}, leaveRequest: 0 }));
        assert(withChat.includes('data-layout="presenting"'), 'presenting without a side panel');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: nothing shows while the interviewer is still setting a share up, then the content',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const html = state => renderToStaticMarkup(React.createElement(InCall, { state, api: {} }));
        const sharing = { speakerId: 'B', presenterName: 'John Park', title: null };
        const starting = html({ ...PRESENT_STATE, screen: null, sharing });
        // On a real call nothing appears while the other person is finding their window: the call stays on its tiles.
        assert(starting.includes('data-layout="grid"') && !starting.includes('data-layout="presenting"'), 'the call stays on the tile grid');
        assert(!starting.includes('data-share-placeholder') && !starting.includes('data-shared-screen') && !starting.includes('present'), 'no bar, no placeholder, no content yet');
        const shown = html({ ...PRESENT_STATE, screen: SCREEN, sharing: null });
        assert(shown.includes('John Park is presenting') && shown.includes('data-shared-screen') && !shown.includes('data-share-placeholder'), 'the content arrives with the presenting bar');
        const replacing = html({ ...PRESENT_STATE, screen: SCREEN, sharing });
        assert(replacing.includes('data-shared-screen') && replacing.includes('John Park is presenting') && !replacing.includes('data-share-placeholder'), 'the old content stays until the new arrives');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the voice choice sits in More options, and only when the window can set it',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall, MoreOptions } = bundle.module;
        const voiceApi = { getVoice: async () => ({ gender: 'male', choices: ['female', 'male'] }), setVoice: async gender => ({ gender }) };
        assert(!renderToStaticMarkup(React.createElement(InCall, { state: PRESENT_STATE, api: {} })).includes('aria-label="More options"'), 'no menu without the setting');
        const bar = renderToStaticMarkup(React.createElement(InCall, { state: PRESENT_STATE, api: voiceApi }));
        assert(bar.includes('aria-label="More options"') && !bar.includes('data-testid="more-options"'), 'the button shows, the menu starts closed');
        const menu = renderToStaticMarkup(React.createElement(MoreOptions, { api: voiceApi, buttonClass: () => '', initialOpen: true, initialVoice: { gender: 'male', choices: ['female', 'male'] } }));
        assert(menu.includes('Your voice') && menu.includes('data-voice="female"') && menu.includes('data-voice="male"'), menu);
        assert(menu.includes('aria-checked="true" data-voice="male"') && menu.includes('aria-checked="false" data-voice="female"'), 'the saved voice is the one ticked');
        assert(!/Interview Helper|practice|\bAI\b/iu.test(menu), 'the menu never names the app');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: a refused microphone is said on the call, with a way to the settings',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const html = (state, api = {}) => renderToStaticMarkup(React.createElement(InCall, { state, api }));
        assert(!html(PRESENT_STATE).includes('data-mic-unavailable'), 'nothing shows while the microphone is heard');
        const refused = html({ ...PRESENT_STATE, microphoneUnavailable: true }, { openMicrophoneSettings: () => true });
        assert(refused.includes('data-mic-unavailable') && refused.includes('no one can hear you') && refused.includes('Open settings'), refused);
        assert(!/Interview Helper|practice/iu.test(refused.match(/data-mic-unavailable[^]*?<\/div>/u)[0]), 'the notice never names the app');
        const api = { openMicrophoneSettings: () => true, reconnectMicrophone: () => true };
        const failed = html({ ...PRESENT_STATE, microphoneUnavailable: true, microphoneFailed: true }, api);
        assert(failed.includes('data-mic-unavailable="failed"') && failed.includes('stopped working') && failed.includes('>Reconnect<'), failed);
        assert(!failed.includes('Open settings'), 'a broken microphone is not a settings problem');
        const trying = html({ ...PRESENT_STATE, microphoneUnavailable: true, microphoneFailed: true, microphoneReconnecting: true }, api);
        assert(trying.includes('Reconnecting…') && /data-mic-reconnect="true" disabled=""/u.test(trying), trying);
        assert(html({ ...PRESENT_STATE, microphoneUnavailable: true }, api).includes('>Reconnect<'), 'a refused microphone can be reconnected once allowed');
        const rejoin = html({ ...PRESENT_STATE, microphoneUnavailable: true, microphoneNeedsRejoin: true }, api);
        assert(rejoin.includes('data-mic-unavailable="rejoin"') && rejoin.includes('rejoin to be heard') && !rejoin.includes('>Reconnect<') && !rejoin.includes('Open settings'), rejoin);
        const hinted = html({ ...PRESENT_STATE, muted: true, mutedHint: { id: 1, reason: 'speech' } });
        assert(hinted.includes('data-muted-hint="speech"') && hinted.includes('Your mic is off'), 'talking into a muted mic gets the hint');
        assert(html({ ...PRESENT_STATE, muted: true, mutedHint: { id: 2, reason: 'wand' } }).includes("You&#x27;re muted"), 'so does the wand pressed while muted');
        assert(!html({ ...PRESENT_STATE, muted: false, mutedHint: { id: 3, reason: 'wand' } }).includes('data-muted-hint'), 'never once unmuted');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the strip holds one to five interviewers',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        for (const count of [1, 5]) {
          const markup = renderToStaticMarkup(React.createElement(InCall, { state: { ...PRESENT_STATE, participants: group(count), speakingId: 'A', screen: { title: 'T', content: 'x', speakerId: 'A' } }, api: {} }));
          const strip = markup.slice(markup.indexOf('data-strip="true"'));
          assert(strip.includes(`data-tiles="${count}"`), `strip reports ${count} tiles`);
          assert((strip.match(/data-speaking=/g) || []).length === count, `strip has ${count} tiles`);
          assert(markup.includes('Person A is presenting'), 'the bar names the lead as presenter');
          // While something is shared the interviewers are chips in the bar, whatever their number, and the stage has the full width.
          assert((strip.match(/data-chip="true"/g) || []).length === count, `every interviewer is a chip (${count})`);
          assert(!strip.includes('data-chip-tight'), 'with the chat panel closed every chip keeps its name');
          assert(markup.includes('data-chip="you"') && /aria-label="Your camera"[^>]*class="[^"]*hidden/.test(markup), 'with the camera off the candidate is a chip too, not a floating picture');
        }
        // A presenter id that matches nobody falls back to the lead.
        const lone = renderToStaticMarkup(React.createElement(InCall, { state: { ...PRESENT_STATE, participants: group(2), screen: { title: 'T', content: 'x', speakerId: 'Z' } }, api: {} }));
        assert(lone.includes('Person A is presenting'), 'unknown presenter id uses the lead');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: screen markup parses to the contract format and shows code as plain text',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, SharedScreen, screenMarkup } = bundle.module;
        const blocks = screenMarkup.parseScreenContent(SCREEN.content);
        assert(JSON.stringify(blocks.map(block => block.type)) === JSON.stringify(['p', 'ul', 'code']), `block types ${JSON.stringify(blocks.map(block => block.type))}`);
        assert(blocks[1].items.length === 2 && blocks[2].lang === 'js', 'bullets and the code language label');
        assert(JSON.stringify(screenMarkup.parseInline('a **b** `c` **open')) === JSON.stringify([{ type: 'text', text: 'a ' }, { type: 'bold', text: 'b' }, { type: 'text', text: ' ' }, { type: 'code', text: 'c' }, { type: 'text', text: ' **open' }]), 'inline parsing keeps unclosed markers literal');
        assert(screenMarkup.parseScreenContent('```\nnever closed').at(0).text === 'never closed', 'an open fence runs to the end');
        assert(screenMarkup.parseScreenContent('x'.repeat(7000))[0].text.length === 6000, 'content is cut at the cap');
        const markup = renderToStaticMarkup(React.createElement(SharedScreen, { title: 'Two sum', content: SCREEN.content, presenterName: 'John Park' }));
        assert(markup.includes('if (a &lt; b &amp;&amp; c &gt; d) { return `x`; }'), 'angle brackets and backticks inside a code block are text');
        assert(markup.includes('<strong') && markup.includes('<ul') && markup.includes('<pre'), 'bold, bullets and code block are elements');
        // The call window turns selection off; a shared screen is read-only but can be selected and copied from.
        assert(/data-screen-body="true"[^>]*class="[^"]*\bselect-text\b/.test(markup), 'the shared screen text is selectable');
        assert(/<h2[^>]*class="[^"]*\bselect-text\b/.test(markup), 'the shared screen title is selectable');
        assert(!/contenteditable/i.test(markup), 'and it stays read-only');
        const pictured = renderToStaticMarkup(React.createElement(SharedScreen, { title: 'Moon base', content: 'Could you live here?', visual: { kind: 'picture', url: 'practice-call://call-1/visuals/p1.1.jpg', description: 'A grey, cratered plain.', credit: 'NASA, Public domain, via Wikimedia Commons' } }));
        assert(/<figure[^>]*data-screen-visual="picture"/.test(pictured) && pictured.includes('src="practice-call://call-1/visuals/p1.1.jpg"') && pictured.includes('alt="A grey, cratered plain."'), 'a prepared picture shows above the text');
        assert(pictured.includes('Photo: NASA, Public domain, via Wikimedia Commons'), 'with its credit');
        assert(pictured.indexOf('<figure') < pictured.indexOf('Could you live here?'), 'above the text');
        const outside = renderToStaticMarkup(React.createElement(SharedScreen, { title: 'T', content: 'x', visual: { kind: 'picture', url: 'https://example.com/a.jpg' } }));
        assert(!outside.includes('<img'), 'a picture from anywhere else is never shown');
        const hostile = renderToStaticMarkup(React.createElement(SharedScreen, { title: '<b>t</b>', content: '<script>alert(1)</script> <img src=x onerror=y>' }));
        assert(!hostile.includes('<script') && !hostile.includes('<img') && hostile.includes('&lt;script&gt;'), 'HTML in content is never interpreted');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the read-only replay pad lets Tab move focus on instead of swallowing it',
    async run() {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
      const saved = {};
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, CodingPad } = bundle.module;
        const root = createRoot(dom.window.document.getElementById('root'));
        await React.act(async () => root.render(React.createElement(CodingPad, { readOnly: true, value: 'print(1)' })));
        const area = dom.window.document.querySelector('textarea[aria-label="Coding pad contents"]');
        const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        await React.act(async () => { area.dispatchEvent(tab); });
        assert(tab.defaultPrevented === false, 'Tab in the replay pad must keep its default so focus can leave');
        await React.act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
  {
    name: 'practice call render: the pad is not overwritten by later state, Tab indents, and edits are sent debounced with a typing heartbeat',
    async run() {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
      const saved = {};
      // act() opens a MessageChannel per call and never closes it; they are closed here so the process can exit.
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      // react-dom reads window when it loads, so the bundle is imported after the globals exist.
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, InCall } = bundle.module;
        const calls = [];
        const api = { updatePad: text => calls.push(['pad', text]), setTyping: value => calls.push(['typing', value]) };
        const root = createRoot(dom.window.document.getElementById('root'));
        const render = state => root.render(React.createElement(InCall, { state, api }));
        const { act } = React;
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: 'python', text: 'seed' } }));
        const area = () => dom.window.document.querySelector('textarea[aria-label="Code"]');
        assert(area().value === 'seed', 'seeded once from state.pad.text');
        const setValue = value => { const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set; setter.call(area(), value); area().dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
        await act(async () => setValue('seed\nmore'));
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: 'python', text: 'from the service' } }));
        assert(area().value === 'seed\nmore', 'a later state.pad.text never overwrites what the user typed');
        // Writing in the pad sends no chat typing signal: the call sees the edits themselves as activity.
        assert(calls.filter(call => call[0] === 'typing').length === 0, 'the pad sends no typing signal');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
        assert(JSON.stringify(calls.filter(call => call[0] === 'pad')) === JSON.stringify([['pad', 'seed\nmore']]), `debounced send ${JSON.stringify(calls)}`);
        area().setSelectionRange(0, 0);
        await act(async () => { area().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
        assert(area().value === '  seed\nmore', 'Tab inserts two spaces');
        await act(async () => setValue('x'));
        assert(!dom.window.document.querySelector('button[aria-label="Ready"]'), 'the pad has no Ready button: the interviewer watches the pad');
        await act(async () => render({ ...PRESENT_STATE, pad: { open: false, lang: '', text: 'x' } }));
        assert(!area(), 'closing the pad removes it');
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: '', text: 'reopened' } }));
        assert(area().value === 'reopened', 'a reopened pad is seeded again');
        await act(async () => setValue('unsent'));
        calls.length = 0;
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: '', text: '', sheet: 1, seed: { id: 1, text: '' } } }));
        assert(area().value === '', 'another exercise turns the pad over to an empty one');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
        assert(calls.filter(call => call[0] === 'pad').length === 0, 'nothing unsent from the exercise before goes out');
        await act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
  {
    name: 'practice call render: the wand sends the first key of a typing run at once, not a second later',
    async run() {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
      const saved = {};
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, CodingPad } = bundle.module;
        const sent = [];
        const typerRef = { current: null };
        const root = createRoot(dom.window.document.getElementById('root'));
        await React.act(async () => root.render(React.createElement(CodingPad, { onChange: text => sent.push(text), typerRef })));
        let stop = false;
        let run = null;
        await React.act(async () => { run = typerRef.current.typeTo('abcdefghijklmnopqrstuvwxyz'.repeat(3), { stopped: () => stop }); });
        // The debounce is 400 ms and the periodic send 1000 ms; keys come about 150 to 400 ms apart.
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
        assert(sent.length === 1 && sent[0].length >= 1 && sent[0].length <= 5, `the first keys went out before the debounce or the periodic send: ${JSON.stringify(sent)}`);
        stop = true;
        await React.act(async () => { await run; });
        await React.act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
  {
    name: 'practice call render: a pad offers exactly the languages the exercise wrote and sends the pick; with none offered it names no language; a required one is a label',
    async run() {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
      const saved = {};
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, InCall } = bundle.module;
        const picks = [];
        const api = { updatePad: () => {}, setTyping: () => {}, setPadLanguage: async name => { picks.push(name); } };
        const root = createRoot(dom.window.document.getElementById('root'));
        const render = state => root.render(React.createElement(InCall, { state, api }));
        const { act } = React;
        const select = () => dom.window.document.querySelector('select[aria-label="Language"]');
        // Nothing offered: any language is fine, so the pad names none and keeps no list of its own.
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: '', choice: '', options: [], text: '' } }));
        assert(!select() && !dom.window.document.querySelector('[data-pad-lang]'), 'no dropdown and no label');
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: '', choice: '', text: '' } }));
        assert(!select(), 'nor for a state with no options at all');
        strict.deepEqual(picks, [], 'and the window picks nothing by itself');
        // The exercise offers languages in its own words: the dropdown lists exactly those.
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: '', choice: 'Eiffel', options: ['Eiffel', 'Ada 2012'], text: '' } }));
        assert(select(), 'the dropdown is beside the title');
        strict.deepEqual([...select().querySelectorAll('option')].map(option => option.value), ['Eiffel', 'Ada 2012'], 'only the offered languages, as written');
        strict.equal(select().value, 'Eiffel');
        await act(async () => { select().value = 'Ada 2012'; select().dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
        strict.deepEqual(picks, ['Ada 2012'], 'a pick is sent');
        strict.equal(dom.window.localStorage.getItem('practiceCall.padLanguage'), null, 'nothing is remembered in the window');
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: 'SQL', choice: 'Go', text: '' } }));
        assert(!select(), 'a required language has no dropdown');
        strict.equal(dom.window.document.querySelector('[data-pad-lang]')?.textContent, 'SQL', 'only its label');
        await act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
  {
    name: 'practice call render: the replay shows the screen and pad current at the playback time beside the feedback, and nothing without them',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay, screenMarkup } = bundle.module;
        const replay = {
          ...REPLAY, persona: { name: 'Dana Whitfield' }, panel: [{ id: 'B', name: 'John Park' }],
          screens: [{ atMs: 100_000, title: 'Problem one', content: 'Reverse a list', speakerId: 'B', endMs: 300_000 }, { atMs: 300_000, title: 'Problem two', content: 'Merge lists', speakerId: 'A', endMs: null }],
          pad: { lang: 'python', snapshots: [{ atMs: 150_000, text: 'def rev(xs):' }, { atMs: 400_000, text: 'def merge(a, b):' }] },
        };
        const at = ms => renderToStaticMarkup(React.createElement(Replay, { replay, api: {}, initialPositionMs: ms }));
        const early = at(50_000);
        assert(!early.includes('data-replay-share') && !early.includes('Problem one') && !early.includes('data-coding-pad'), 'before any screen or code nothing shared is shown');
        const mid = at(200_000);
        assert(mid.includes('data-replay-share="true"') && mid.includes('Problem one') && mid.includes('John Park (Presentation)') && mid.includes('def rev(xs):') && mid.includes('data-coding-pad="readonly"'), 'mid call shows the first screen and snapshot beside the feedback');
        assert(mid.includes('min-[1000px]:grid-cols-2'), 'wide windows put the share beside the feedback, narrow ones stack it');
        assert(!mid.includes('Problem two'), 'only the current screen');
        const late = at(500_000);
        assert(late.includes('Problem two') && late.includes('Dana Whitfield (Presentation)') && late.includes('def merge(a, b):') && !late.includes('def rev'), 'late call shows the second screen and the latest snapshot');
        const screenOnly = renderToStaticMarkup(React.createElement(Replay, { replay: { ...replay, pad: { lang: '', snapshots: [] } }, api: {}, initialPositionMs: 200_000 }));
        assert(screenOnly.includes('Problem one') && !screenOnly.includes('data-coding-pad'), 'the coding pad shows only when the call had pad snapshots');
        assert(screenMarkup.screenAt([{ atMs: 0, endMs: 10 }], 10) === null, 'a screen ended at the time is gone');
        // The pad's record marks its opening (empty) and its closing: nothing before the first, nothing from a close until it reopens.
        const marks = { snapshots: [{ atMs: 100, text: '' }, { atMs: 200, text: 'a' }, { atMs: 300, text: 'a', closed: true }, { atMs: 400, text: 'ab' }] };
        assert(screenMarkup.padSnapshotAt(marks, 50) === null && screenMarkup.padSnapshotAt(marks, 150).text === '' && screenMarkup.padSnapshotAt(marks, 250).text === 'a', 'shown from its opening');
        assert(screenMarkup.padSnapshotAt(marks, 350) === null && screenMarkup.padSnapshotAt(marks, 450).text === 'ab', 'gone once closed, back when reopened');
        // Pad keys: Tab writes two spaces, Enter keeps the indentation of the line it leaves.
        assert(screenMarkup.padKeyInsert('Tab', 'x') === '  ', 'tab is two spaces');
        assert(screenMarkup.padKeyInsert('Enter', 'def f():\n    if x:') === '\n    ', 'enter keeps four spaces');
        assert(screenMarkup.padKeyInsert('Enter', 'a\n\tb') === '\n\t' && screenMarkup.padKeyInsert('Enter', 'top') === '\n' && screenMarkup.padKeyInsert('Enter', '') === '\n', 'tabs kept, no indentation invented');
        const plain = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY, api: {}, initialPositionMs: 200_000 }));
        assert(!plain.includes('data-replay-share') && !plain.includes('Coding pad'), 'a replay without screens looks as before');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the replay\'s shared screen enlarges over the feedback, follows playback and shrinks with its button, Escape or a click outside',
    async run() {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
      const saved = {};
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, Replay } = bundle.module;
        const { act } = React;
        const replay = {
          ...REPLAY, persona: { name: 'Dana Whitfield' }, panel: [{ id: 'B', name: 'John Park' }],
          screens: [{ atMs: 100_000, title: 'Problem one', content: 'Reverse a list', speakerId: 'B', endMs: 300_000, visual: { kind: 'diagram', url: 'practice-call://call-1/visuals/p1.1.svg', description: 'A runway.' } }],
        };
        const doc = dom.window.document;
        const root = createRoot(doc.getElementById('root'));
        await act(async () => root.render(React.createElement(Replay, { replay, api: {}, initialPositionMs: 200_000 })));
        const enlarged = () => doc.querySelector('[data-replay-screen-enlarged]');
        const enlarge = doc.querySelector('[data-replay-share] button[aria-label="Enlarge shared screen"]');
        assert(enlarge && !enlarged(), 'the screen beside the feedback has an Enlarge button and starts small');
        await act(async () => { enlarge.click(); });
        assert(enlarged()?.getAttribute('role') === 'dialog' && enlarged().textContent.includes('Problem one') && enlarged().querySelector('img[src="practice-call://call-1/visuals/p1.1.svg"]'), 'Enlarge shows the same screen, diagram included, over the feedback');
        assert(enlarged().querySelector('img').className.includes('max-h-[70vh]') && enlarged().querySelector('[data-screen-body]').className.includes('text-[17px]'), 'the enlarged view has a taller diagram and bigger text');
        assert(doc.activeElement === enlarged().querySelector('button[aria-label="Shrink shared screen"]'), 'focus moves to Shrink');
        await act(async () => { enlarged().querySelector('button[aria-label="Shrink shared screen"]').click(); });
        assert(!enlarged(), 'Shrink closes it');
        await act(async () => { doc.querySelector('[data-replay-share] [data-screen-enlarge]').click(); });
        await act(async () => { enlarged().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        assert(!enlarged(), 'Escape closes it');
        await act(async () => { doc.querySelector('[data-replay-share] [data-screen-enlarge]').click(); });
        await act(async () => { enlarged().querySelector('[data-shared-screen]').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
        assert(enlarged(), 'a click on the screen itself keeps it open');
        await act(async () => { enlarged().dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
        assert(!enlarged(), 'a click outside the screen closes it');
        await act(async () => { doc.querySelector('[data-replay-share] img').click(); });
        assert(enlarged(), 'clicking the diagram enlarges too');
        await act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
];

export default [
  {
    name: 'practice call render: consent lists the model sizes before asking to agree',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ConsentScreen } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(ConsentScreen, { onAgree: () => {}, busy: false }));
        for (const fragment of ['aria-label="Model downloads"', '32 MB', '610 MB', 'Agree and download', 'Set up your call', 'AI voice']) {
          assert(markup.includes(fragment), `consent screen is missing ${fragment}`);
        }
        const busy = renderToStaticMarkup(React.createElement(ConsentScreen, { onAgree: () => {}, busy: true }));
        assert(busy.includes('Starting…') && busy.includes('disabled'), 'a busy consent screen must show progress and disable the agree button');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: downloading shows real progress and precheck shows the level meter, headphones and usage warning',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, DownloadingScreen, PrecheckScreen } = bundle.module;
        const downloading = renderToStaticMarkup(React.createElement(DownloadingScreen, { download: { receivedBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } }));
        for (const fragment of ['role="progressbar"', 'aria-valuenow="50"', '50%', 'Downloading call files']) {
          assert(downloading.includes(fragment), `downloading screen is missing ${fragment}`);
        }
        const precheck = renderToStaticMarkup(React.createElement(PrecheckScreen, { level: 0.42, usageWarning: 'Use real examples only.', persona: PERSONA, setup: { step: 'plan', attempt: 2 } }));
        assert(/data-status="done"[^>]*>(?:(?!<\/li>).)*Choosing the interviewer voices/.test(precheck), 'a finished setup step is marked done');
        assert(/data-status="active" aria-current="step"[^>]*>(?:(?!<\/li>).)*Planning the interview…(?:(?!<\/li>).)*attempt 2/.test(precheck), 'the running step is marked active and says when the plan is being written again');
        assert(/data-status="pending"[^>]*>(?:(?!<\/li>).)*Turning on your microphone/.test(precheck), 'a later setup step is still pending');
        assert(precheck.includes('not on yet'), 'the meter says the microphone is not on while the plan is written');
        assert(!/say something/i.test(precheck), 'the setup screen must not ask the candidate to speak: nothing waits on the microphone');
        for (const fragment of ['aria-label="Setup progress"', 'type every answer', 'role="meter"', 'aria-valuenow="42"', 'Headphones recommended', 'aria-label="Usage warning"', 'Use real examples only.', 'aria-label="Microphone check"']) {
          assert(precheck.includes(fragment), `precheck screen is missing ${fragment}`);
        }
        const quiet = renderToStaticMarkup(React.createElement(PrecheckScreen, { level: 0, usageWarning: null, persona: PERSONA, setup: { step: 'plan', attempt: 1 } }));
        assert(!quiet.includes('aria-label="Usage warning"'), 'the setup screen shows no notice when there is no usage warning');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: ringing shows the persona with answer and decline, and the ringtone is a Web Audio chime that stops',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, IncomingCall, ringtone } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(IncomingCall, { persona: PERSONA, onAnswer: () => {}, onDecline: () => {} }));
        for (const fragment of ['aria-label="Incoming call"', '>Incoming call<', 'Dana Whitfield', 'Hiring manager · Growth', 'aria-label="Answer call"', 'aria-label="Decline call"']) {
          assert(markup.includes(fragment), `incoming call screen is missing ${fragment}`);
        }
        const created = [];
        const context = { closed: false };
        class FakeAudioContext {
          constructor() { this.currentTime = 1; this.destination = { name: 'out' }; }
          createOscillator() {
            const oscillator = { type: 'sine', frequencies: [], frequency: { setValueAtTime: value => { oscillator.frequencies.push(value); } }, connect() {}, start() {}, stop() {} };
            created.push(oscillator);
            return oscillator;
          }
          createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
          resume() {}
          close() { context.closed = true; }
        }
        const stop = ringtone.startRingtone({ AudioContext: FakeAudioContext });
        // Two passes of four notes, each note with two overtones.
        assert(created.length === 24, `the ring must synthesise the chime twice, got ${created.length} tones`);
        const notes = created.filter((_, index) => index % 3 === 0).map(oscillator => oscillator.frequencies[0]);
        assert(JSON.stringify(notes) === JSON.stringify([...ringtone.RING_NOTES, ...ringtone.RING_NOTES]), 'the ring is the rising four-note chime, played twice');
        assert(notes.slice(0, 4).every((hertz, index) => index === 0 || hertz > notes[index - 1]), 'the chime rises');
        const before = created.length;
        const stopRingback = ringtone.startRingback({ AudioContext: FakeAudioContext });
        assert(JSON.stringify(created.slice(before).map(oscillator => oscillator.frequencies[0])) === '[440,480]', 'the outgoing tone is the phone network ring: 440 Hz and 480 Hz together');
        assert(ringtone.RINGBACK_ON_SECONDS === 2 && ringtone.RINGBACK_CYCLE_MS === 6000, 'two seconds on, four seconds off');
        stopRingback();
        context.closed = false;
        assert(context.closed === false, 'the ring keeps playing until it is stopped');
        stop();
        assert(context.closed === true, 'stopping the ring must close the audio context');
        const unhandled = [];
        const onUnhandled = reason => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        class RejectingAudioContext extends FakeAudioContext { resume() { return Promise.reject(new Error('autoplay blocked')); } }
        ringtone.startRingtone({ AudioContext: RejectingAudioContext })();
        ringtone.playJoinChime({ AudioContext: RejectingAudioContext });
        await new Promise(resolve => setTimeout(resolve, 20));
        process.off('unhandledRejection', onUnhandled);
        assert(unhandled.length === 0, 'a rejected AudioContext.resume() must not become an unhandled rejection');
        const noAudio = ringtone.startRingtone({});
        assert(typeof noAudio === 'function' && typeof noAudio() === 'undefined', 'a window without Web Audio must return a harmless stop function');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: connecting and error screens report the state without pretending the call is live',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ConnectingScreen, ErrorScreen } = bundle.module;
        const connecting = renderToStaticMarkup(React.createElement(ConnectingScreen, { persona: PERSONA }));
        for (const fragment of ['aria-label="Connecting call"', 'Connecting to Dana Whitfield', 'role="status"']) {
          assert(connecting.includes(fragment), `connecting screen is missing ${fragment}`);
        }
        const failed = renderToStaticMarkup(React.createElement(ErrorScreen, { error: { code: 'mic-denied', message: 'The microphone is not available.' }, onClose: () => {} }));
        for (const fragment of ['role="alert"', 'The microphone is not available.', 'mic-denied', 'Close window']) {
          assert(failed.includes(fragment), `error screen is missing ${fragment}`);
        }
        assert(!failed.includes('Open Microphone settings'), 'only a microphone denial offers the settings button');
        const denied = renderToStaticMarkup(React.createElement(ErrorScreen, { error: { code: 'permission-denied', message: 'The call needs your microphone.' }, onClose: () => {}, onOpenMicrophoneSettings: () => {} }));
        for (const fragment of ['Open Microphone settings', 'Close window']) {
          assert(denied.includes(fragment), `microphone denial screen is missing ${fragment}`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the candidate tile rings while they speak and its glow follows the sound level',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const render = extra => renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, speaking: 'interviewer', ...extra }, api: {} }));
        const self = markup => markup.slice(markup.indexOf('aria-label="Your camera"'), markup.indexOf('</section>', markup.indexOf('aria-label="Your camera"')));
        const quiet = self(render({ candidateSpeaking: false, level: 0.3 }));
        assert(quiet.includes('data-self-speaking="false"') && quiet.includes('outline-transparent') && !quiet.includes('box-shadow:'), 'no ring or glow while silent');
        const soft = self(render({ candidateSpeaking: true, level: 0.01 }));
        const loud = self(render({ candidateSpeaking: true, level: 0.2 }));
        for (const markup of [soft, loud]) assert(markup.includes('data-self-speaking="true"') && markup.includes('outline-[#8ab4f8]') && markup.includes(' speaking</span>'), 'a steady ring while speaking');
        const spread = markup => Number(/box-shadow:0 0 0 (\d+)px/.exec(markup)?.[1]);
        assert(spread(loud) > spread(soft), `the glow grows with the level (${spread(soft)} -> ${spread(loud)})`);
        assert(!loud.includes('pc-ring') && !loud.includes('pc-bars') && !loud.includes('pc-breathe'), 'no timed animation on the candidate tile');
        const chip = render({ candidateSpeaking: true, level: 0.1, screen: { title: 'Q', content: 'Body', speakerId: 'A' } });
        assert(/data-chip="you" data-self-speaking="true"/.test(chip), 'the presenting bar chip rings too');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: in-call shows the speaking interviewer, timer, call controls and keeps video, captions, cards and chat off by default',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(InCall, { state: IN_CALL_STATE, api: { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} } }));
        for (const fragment of [
          'aria-label="Call in progress"', 'aria-label="Dana Whitfield"', 'data-speaking="true"', '>D<',
          'role="timer"', '1:12', 'aria-label="Mute microphone"', 'aria-pressed="false"',
          'aria-label="Captions"', 'aria-label="Notes"', 'aria-label="Chat"', 'aria-label="Hang up"',
          'aria-label="Your camera"', 'data-camera="off"', 'aria-label="Turn on camera"', 'Camera off',
        ]) assert(markup.includes(fragment), `in-call view is missing ${fragment}`);
        for (const hidden of ['aria-label="Live captions"', 'aria-label="Call chat"', '<video', 'I led the onboarding rewrite.']) {
          assert(!markup.includes(hidden), `in-call view must keep ${hidden} hidden until the user asks for it`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: chat panel lists the turns, never labels the candidate typing as the interviewer and labels the message box',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ChatPanel } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(ChatPanel, { chat: IN_CALL_STATE.chat, typing: true, onSend: () => {}, onTyping: () => {} }));
        for (const fragment of ['aria-label="Call chat"', 'One moment, checking my notes.', 'aria-label="Chat message"', 'maxLength="2000"', '<textarea', 'aria-label="Send chat message"', 'aria-live="polite"']) {
          assert(markup.includes(fragment), `chat panel is missing ${fragment}`);
        }
        // The call window turns selection off on the body; the message list turns it back on so a message can be copied.
        assert(/<ol[^>]*data-chat-messages="true"[^>]*class="[^"]*\bselect-text\b/.test(markup), 'chat messages must be selectable');
        assert(!markup.includes('Interviewer is typing') && !markup.includes('chat-typing'), 'the candidate typing must not be shown as the interviewer typing');
        const left = renderToStaticMarkup(React.createElement(ChatPanel, { chat: [], disabled: true, onSend: () => {}, onTyping: () => {} }));
        assert(left.includes('disabled=""') && left.includes('No one else is in the call.'), 'the chat box is disabled once the interviewer left');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the side panel and the chat box each have a resize handle, and dragged sizes stay inside the window',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ChatPanel, panelSize } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(ChatPanel, { chat: [], onSend: () => {}, onTyping: () => {} }));
        assert(/role="separator"[^>]*aria-orientation="horizontal"[^>]*aria-label="Resize message box"/.test(markup), 'the chat box has a vertical resize grip');
        assert(!/<textarea[^>]*class="[^"]*\bmax-h-28\b/.test(markup), 'the box height cap comes from the dragged size, not a fixed class');
        const { clampPanelWidth, clampBoxHeight, PANEL_MIN_WIDTH, STAGE_MIN_WIDTH, BOX_MIN_HEIGHT } = panelSize;
        assert(clampPanelWidth(100, 1200) === PANEL_MIN_WIDTH, 'the panel never goes below its minimum width');
        assert(clampPanelWidth(2000, 1200) === 1200 - STAGE_MIN_WIDTH, 'the call keeps its minimum width beside the panel');
        assert(clampPanelWidth(500, 1200) === 500);
        assert(clampBoxHeight(10, 600) === BOX_MIN_HEIGHT && clampBoxHeight(5000, 600) < 600 && clampBoxHeight(200, 600) === 200, 'the box stays between one line and a height that leaves the messages visible');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: while paused the chat box stays editable, sending is blocked and a reminder shows; the pad has no Ready button or paused reminder',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ChatPanel, CodingPad } = bundle.module;
        const chat = paused => renderToStaticMarkup(React.createElement(ChatPanel, { chat: [], draft: 'kept', paused, onSend: () => {}, onTyping: () => {} }));
        const on = chat(true);
        const area = on.match(/<textarea[^>]*>/)[0];
        assert(!area.includes('disabled=""'), 'the textarea stays editable while paused');
        assert(/<button[^>]*aria-label="Send chat message"[^>]*disabled=""/.test(on) || /<button[^>]*disabled=""[^>]*aria-label="Send chat message"/.test(on), 'send is disabled while paused');
        assert(on.includes('kept') && !on.includes('Paused'), 'the draft is kept; the pause notice is the overlay on the call screen, not a line in the panel');
        const off = chat(false);
        assert(!off.includes('Press ⌘P') && !/<button[^>]*aria-label="Send chat message"[^>]*disabled=""/.test(off));
        const padOn = renderToStaticMarkup(React.createElement(CodingPad, { initialText: 'x', paused: true, onChange: () => {}, onTyping: () => {} }));
        assert(!padOn.includes('aria-label="Ready"') && !padOn.includes('Press ⌘P to resume'));
        assert(!padOn.match(/<textarea[^>]*>/)[0].includes('disabled=""'));
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: ended and analysing screens state the analysis status and call length',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, EndedScreen } = bundle.module;
        const analysing = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'analyzing', elapsedMs: 72_000, persona: PERSONA } }));
        for (const fragment of ['aria-label="Analysing the call"', 'role="status"', 'Analysing the recording', '1:12']) {
          assert(analysing.includes(fragment), `analysing screen is missing ${fragment}`);
        }
        // The processing steps tick off in order: earlier ones done, the reported one active, the rest pending.
        const reviewing = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'analyzing', analysisStage: 'review', elapsedMs: 72_000, persona: PERSONA } }));
        for (const fragment of ['aria-label="Processing steps"', 'data-stage="recording" data-status="done"', 'data-stage="transcribing" data-status="done"', 'data-stage="metrics" data-status="done"', 'data-stage="review" data-status="active" aria-current="step"', 'data-stage="saving" data-status="pending"', 'Writing the feedback']) {
          assert(reviewing.includes(fragment), `the processing screen is missing ${fragment}`);
        }
        assert(analysing.includes('data-stage="recording" data-status="active"'), 'an unreported stage reads as the first step in progress');
        assert(!analysing.includes('data-status="done"'), 'no step is shown finished before the service reports progress');
        const ended = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'ended', elapsedMs: 5_000 } }));
        for (const fragment of ['aria-label="Call ended"', 'The recording is being saved.', '0:05', 'You left the call']) {
          assert(ended.includes(fragment), `ended screen is missing ${fragment}`);
        }
        // The length shown is the active one: the call's time without its pauses.
        const withPauses = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'ended', elapsedMs: 90_000, pausedMs: 30_000, activeMs: 60_000 } }));
        assert(withPauses.includes('Call length 1:00') && !withPauses.includes('1:30'), 'the ended screen shows the active length');
        const choosing = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'ended', feedbackChoice: 'pending', interviewerLeft: true, elapsedMs: 5_000 } }));
        for (const fragment of ['aria-label="Feedback choice"', 'Want feedback on this call?', 'Get feedback', 'Skip feedback', '>Call ended<']) {
          assert(choosing.includes(fragment), `the feedback choice is missing ${fragment}`);
        }
        assert(!choosing.includes('aria-label="Processing steps"') && !choosing.includes('You left the call'), 'while choosing, no processing steps are shown, and a call the interviewer ended does not say the candidate left');
        // The interviewer is gone once the call ends: no photo, initials or name on any after-call screen.
        for (const [label, state] of [['left', { phase: 'ended', elapsedMs: 5_000 }], ['choosing', { phase: 'ended', feedbackChoice: 'pending', elapsedMs: 5_000 }], ['analysing', { phase: 'analyzing', analysisStage: 'review', elapsedMs: 5_000 }]]) {
          const markup = renderToStaticMarkup(React.createElement(EndedScreen, { state: { ...state, persona: PERSONA } }));
          assert(!markup.includes(PERSONA.name) && !markup.includes('Interviewer:'), `the ${label} screen does not name the interviewer`);
          assert(!markup.includes('data-avatar') && !markup.includes('pc-ring'), `the ${label} screen has no interviewer avatar`);
        }
        // No screen of the call window calls it practice, before or after the call.
        const { ConsentScreen, DownloadingScreen, PrecheckScreen, MissedCall, OutgoingCall, ErrorScreen } = bundle.module;
        const screens = {
          consent: React.createElement(ConsentScreen, { onAgree: () => {}, busy: false }),
          downloading: React.createElement(DownloadingScreen, { download: { receivedBytes: 1, totalBytes: 2 } }),
          precheck: React.createElement(PrecheckScreen, { level: 0, persona: PERSONA, setup: { step: 'ready', attempt: 1 } }),
          missed: React.createElement(MissedCall, { persona: PERSONA, missed: 'unanswered' }),
          calling: React.createElement(OutgoingCall, { persona: PERSONA }),
          ended: React.createElement(EndedScreen, { state: { phase: 'ended', elapsedMs: 1, persona: PERSONA } }),
          analysing: React.createElement(EndedScreen, { state: { phase: 'analyzing', analysisStage: 'saving', elapsedMs: 1, persona: PERSONA } }),
          error: React.createElement(ErrorScreen, { error: null }),
        };
        for (const [name, element] of Object.entries(screens)) {
          assert(!/practice/iu.test(renderToStaticMarkup(element).replace(/<[^>]*>/gu, ' ')), `the ${name} screen must not say practice`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: replay binds the recording, docks the player and puts the part under the playhead front and center',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY_FEEDBACK, api: { deleteRecording: async () => {} }, initialPositionMs: 140_000 }));
        for (const fragment of [
          'aria-label="Call replay"', '<audio', 'src="file:///tmp/practice-calls/call-dana-1.wav"', 'aria-label="Call recording"',
          'aria-label="Play recording"', 'aria-label="Back 10 seconds"', 'aria-label="Forward 10 seconds"', 'aria-label="Previous part"', 'aria-label="Next part"', 'aria-label="Speed 1.25x"', 'aria-label="Speed 2x"',
          'role="slider"', 'aria-valuemax="600000"', 'aria-valuenow="140000"', 'aria-valuetext="2:20 of 10:00, Onboarding story"',
          'data-chapter="0"', 'data-chapter="1"', 'data-chapter="2"', 'style="left:20%;width:max(2px, calc(50% - 2px))"',
          ...MARKERS_BY_KIND, 'aria-label="Delete recording"', 'aria-label="Overview"',
          'data-replay-focus="true"', 'data-focus-mode="part"', 'aria-live="polite"', 'data-focus-title="true"',
          'data-part-now="answer"', 'Asked by', 'Dana Whitfield', 'Hiring manager',
          'What worked', 'You named the first-run flow.', 'Work on', 'Give the activation number.', 'Adapting', 'You shortened it for the time left.', 'Optional extension', '9<span',
        ]) assert(markup.includes(fragment), `replay view is missing ${fragment}`);
        assert(markup.indexOf('data-replay-focus') < markup.indexOf('data-replay-player'), 'the player is docked below the focus area');
        assert(markup.includes('data-replay-announce="true"') && /data-replay-announce="true">Onboarding story</.test(markup), 'the live region announces the part title');
        assert(!/Transcript|Call transcript|data-current-turn|Chapters/.test(markup), 'no transcript and no chapter list');
        assert(!markup.includes('Clear story.') && !markup.includes('Work on first'), 'the overview is not shown while a part is in focus');
        assert(!markup.includes('role="alertdialog"'), 'delete must stay behind a confirm step');
        const moment = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY_FEEDBACK, api: {}, initialPositionMs: 5_000 }));
        assert(moment.includes('data-feedback-kind="moment"') && moment.includes('Small talk') && moment.includes('Warm, but you left the plan unconfirmed.') && moment.includes('data-score-badge="low"'), 'a moment shows its kind, score and note');
        assert(moment.includes('data-part-now="question"'), 'before the candidate answers the part is the question');
        const bare = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY_FEEDBACK, api: {}, initialPositionMs: 500_000 }));
        assert(bare.includes('data-feedback-empty="true"') && bare.includes('No notes for this part'), 'a part with no feedback says so');
        const noFeedback = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY_FEEDBACK, feedback: null }, api: {}, initialPositionMs: 140_000 }));
        assert(noFeedback.includes('Onboarding story') && !noFeedback.includes('No notes for this part') && !noFeedback.includes('What worked'), 'without feedback the focus shows just the part title');
        const noItem = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY_FEEDBACK, feedback: { ...REPLAY_FEEDBACK.feedback, planned: [{ ...REPLAY_FEEDBACK.feedback.planned[0], adapted: '' }] } }, api: {}, initialPositionMs: 140_000 }));
        assert(!noItem.includes('Adapting'), 'Adapting is only shown when present');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the replay is height-bounded with a slim header, one scrolling focus area and the player docked at the bottom',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const html = replay => renderToStaticMarkup(React.createElement(Replay, { replay, api: {} }));
        const withFeedback = html(REPLAY_FEEDBACK);
        const tag = (markup, marker) => { const at = markup.indexOf(marker); return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at) + 1); };
        const root = tag(withFeedback, 'data-replay-root');
        assert(root.includes('h-screen') && root.includes('overflow-hidden') && root.includes('flex-col') && !root.includes('min-h-screen'), 'the replay root is exactly one window tall and does not grow');
        const region = tag(withFeedback, 'data-replay-focus');
        assert(region.includes('overflow-y-auto') && region.includes('min-h-0') && region.includes('flex-1') && region.includes('pc-scroll-hidden') && region.includes('tabindex="0"') && region.includes('aria-label='), 'the focus area takes the height, scrolls on its own, has no scrollbar and is keyboard reachable');
        assert((withFeedback.match(/overflow-y-auto/g) || []).length === 1, 'only the focus area scrolls');
        assert(withFeedback.indexOf('<header') < withFeedback.indexOf('data-replay-focus') && withFeedback.indexOf('data-replay-focus') < withFeedback.indexOf('data-replay-player'), 'header, focus area, player: top to bottom');
        const player = tag(withFeedback, 'data-replay-player');
        assert(player.includes('shrink-0') && !player.includes('overflow'), 'the player strip never scrolls or shrinks');
        assert(/aria-label="Play recording"[^>]*data-play-button="true"[^>]*class="[^"]*h-14 w-14[^"]*rounded-full/.test(withFeedback), 'the play button is large and round');
        assert(/data-timeline="true"[^>]*class="[^"]*py-3/.test(withFeedback) && withFeedback.includes('relative h-12 w-full'), 'the timeline bar is a tall 48px target');
        const plain = html({ ...REPLAY, audioUrl: null, feedback: null, analysis: null });
        assert(plain.includes('data-replay-focus') && plain.includes('data-replay-player') && plain.includes('aria-disabled="true"'), 'with no recording the player still renders, its timeline disabled');
        const css = await fs.readFile(path.join(ROOT, 'src/index.css'), 'utf8');
        assert(/\.pc-scroll-hidden\s*\{[^}]*scrollbar-width:\s*none/.test(css) && /\.pc-scroll-hidden::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(css), 'the scrollbar is hidden by css');
        assert(/prefers-reduced-motion[\s\S]*?\.pc-fade[^{]*\{[^}]*animation:\s*none/u.test(css), 'the part transition respects reduced motion');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: replay reports analysing, failed analysis and a deleted recording and keeps the feedback overview',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const analysing = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, analysis: { status: 'analyzing' } }, api: {} }));
        assert(analysing.includes('aria-label="Analysis status"') && analysing.includes('Analysis is still running'), 'an analysing call must say the analysis is still running');
        const failed = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, analysis: { status: 'failed', error: 'Tone model unavailable' } }, api: {} }));
        assert(failed.includes('role="alert"') && failed.includes('aria-label="Analysis failed"') && failed.includes('Tone model unavailable'), 'a failed analysis must surface the error');
        const deleted = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY_FEEDBACK, audioUrl: null }, api: {} }));
        assert(deleted.includes('aria-label="Recording unavailable"') && deleted.includes('The recording for this call is not available.'), 'a missing recording must explain itself');
        assert(/aria-label="Play recording"[^>]*disabled/.test(deleted) && deleted.includes('aria-disabled="true"'), 'play and the timeline are disabled without a recording');
        assert(deleted.includes('data-focus-mode="overview"') && deleted.includes('Clear story.') && deleted.includes('Work on first'), 'the feedback overview stays visible without audio');
        const pruned = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, audioUrl: null, recordingPruned: true, recordingsKept: 10 }, api: {} }));
        assert(pruned.includes('Only the 10 most recent calls keep their recording.') && pruned.includes('feedback of this one is kept'), 'an aged-out recording says why it is gone');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: replay positioning helpers pick turns and format times',
    async run() {
      const model = await import(pathToFileURL(path.join(PRACTICE, 'replayModel.js')).href);
      const { turnAt, formatTime } = model;
      assert(turnAt(REPLAY.transcript, 120_000) === 0, 'the interviewer turn owns its start time');
      assert(turnAt(REPLAY.transcript, 140_000) === 1, 'the candidate turn owns its window');
      assert(turnAt(REPLAY.transcript, 10_000) === -1, 'a position before the transcript has no turn');
      assert(turnAt([], 10) === -1, 'an empty transcript has no turn');
      assert(formatTime(0) === '0:00', 'zero formats as 0:00');
      assert(formatTime(72_000) === '1:12', 'milliseconds format as m:ss');
      assert(formatTime(-5) === '0:00', 'negative times clamp at zero');
    },
  },
  // Replay: paused time, transcript highlight, follow playback, typed-only calls, unasked cards.
  {
    name: 'practice call render: replay highlight skips zero-length overlay turns and follows typed answers',
    async run() {
      const { turnAt } = await import(pathToFileURL(path.join(PRACTICE, 'replayModel.js')).href);
      const transcript = [
        { speaker: 'interviewer', speakerId: 'A', text: 'Intro.', startMs: 2000, endMs: 25_000 },
        { speaker: 'interviewer', speakerId: 'B', text: 'Hey.', overlay: true, startMs: 10_000, endMs: 10_000 },
        { speaker: 'candidate', channel: 'chat', text: 'Typed one.', startMs: 46_000, endMs: 46_000 },
        { speaker: 'interviewer', speakerId: 'A', text: 'Next.', startMs: 47_500, endMs: 57_000 },
        { speaker: 'candidate', channel: 'chat', text: 'Typed two.', startMs: 160_000, endMs: 160_000 },
        { speaker: 'interviewer', speakerId: 'A', text: 'Last.', startMs: 161_000, endMs: 170_000 },
      ];
      assert(turnAt(transcript, 9_999) === 0 && turnAt(transcript, 10_500) === 1, 'an overlay turn is current just after it starts');
      assert(turnAt(transcript, 11_600) === 0 && turnAt(transcript, 20_000) === 0, 'once its moment passes the highlight returns to the turn it was said over');
      assert(turnAt(transcript, 24_000) === 0, 'the interviewer turn is current until its end');
      assert(turnAt(transcript, 25_000) === 2 && turnAt(transcript, 46_500) === 2 && turnAt(transcript, 47_400) === 2, 'a typed answer is current from the end of the turn before it until the next turn starts');
      assert(turnAt(transcript, 47_500) === 3, 'the next turn takes over');
      assert(turnAt(transcript, 100_000) === 3 || turnAt(transcript, 100_000) === 4, 'between turns something stays current');
      assert(turnAt(transcript, 170_000) === 5, 'the last turn stays current to the end');
      assert(turnAt([{ speaker: 'interviewer', overlay: true, startMs: 5000, endMs: 5000 }], 20_000) === -1, 'an overlay alone is never current outside its window');
      // A chat line the voice spoke has a real span: it is current for that span only, not stretched back like a typed one.
      const voiced = [
        { speaker: 'interviewer', text: 'Q.', startMs: 0, endMs: 10_000 },
        { speaker: 'candidate', channel: 'chat', voiced: true, text: 'Spoken.', startMs: 14_000, endMs: 20_000 },
        { speaker: 'interviewer', text: 'Next.', startMs: 21_000, endMs: 25_000 },
      ];
      assert(turnAt(voiced, 11_000) === 0, 'the gap before a voiced line still belongs to the interviewer turn before it');
      assert(turnAt(voiced, 15_000) === 1 && turnAt(voiced, 20_500) === 1, 'the voiced line is current from its own start');
    },
  },
  {
    name: 'practice call render: paused time helpers merge spans, find them, skip them and take them out of the clock',
    async run() {
      const { normalizePauseSpans, pauseSpanAt, skipPausedMs, activeTimeMs, activeLengthMs } = await import(pathToFileURL(path.join(PRACTICE, 'replayModel.js')).href);
      const spans = normalizePauseSpans([{ startMs: 500_000, endMs: 800_000 }, { startMs: 100_000, endMs: 200_000 }, { startMs: 150_000, endMs: 250_000 }, { startMs: 9, endMs: 9 }, { startMs: 'x', endMs: 1 }, null, { startMs: 900_000, endMs: 2_000_000 }], 1_000_000);
      assert(JSON.stringify(spans) === JSON.stringify([{ startMs: 100_000, endMs: 250_000 }, { startMs: 500_000, endMs: 800_000 }, { startMs: 900_000, endMs: 1_000_000 }]), 'spans are sorted, merged, clipped to the recording and bad entries dropped');
      assert(normalizePauseSpans(undefined, 10).length === 0, 'old calls have no spans');
      assert(pauseSpanAt(spans, 100_000)?.endMs === 250_000 && pauseSpanAt(spans, 250_000) === null && pauseSpanAt(spans, 99_999) === null, 'a span owns its start and not its end');
      assert(skipPausedMs(spans, 120_000) === 250_000 && skipPausedMs(spans, 300_000) === 300_000, 'inside a span playback lands on its end');
      assert(activeTimeMs(spans, 90_000) === 90_000 && activeTimeMs(spans, 300_000) === 300_000 - 150_000 && activeTimeMs(spans, 1_000_000) === 1_000_000 - 550_000, 'paused time before a position is taken out of it');
      assert(activeLengthMs(1_000_000, spans, 123_000) === 123_000 && activeLengthMs(1_000_000, spans, undefined) === 450_000 && activeLengthMs(500, [], undefined) === 500, 'the active length is the payload figure, else the recording minus its spans');
    },
  },
  {
    name: 'practice call render: the replay lives in active time, with no pause on the timeline, and still works without spans',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const html = replay => renderToStaticMarkup(React.createElement(Replay, { replay, api: {}, initialPositionMs: 450_000 }));
        const paused = html({ ...REPLAY, pauseSpans: [{ startMs: 200_000, endMs: 440_000 }], pausedMs: 240_000, activeMs: 360_000 });
        assert(!paused.includes('data-pause-span') && !paused.includes('hatch') && !paused.includes('recording 10:00'), 'a pause is not drawn and the recording length is not shown');
        assert(paused.includes('aria-valuemax="360000"') && paused.includes('aria-valuenow="210000"'), 'the slider is in active time: 7:30 on the recording is 3:30');
        assert(paused.includes('>3:30 / 6:00<'), 'the clock reads active time over active length');
        assert(paused.includes('left:33.33') && paused.includes('width:max(2px, calc(22.22') && paused.includes('left:55.55'), 'the blocks are laid out in active time: the middle chapter loses the paused time');
        assert(paused.includes('Your questions') && paused.includes('aria-valuetext="3:30 of 6:00, Your questions"'), 'the part under the playhead is found on the active clock');
        const plain = html(REPLAY);
        assert(!plain.includes('data-pause-span') && plain.includes('>7:30 / 10:00<'), 'a call with no spans shows one length');
        const same = html({ ...REPLAY, pauseSpans: [], pausedMs: 0, activeMs: 600_000 });
        assert(same.includes('>7:30 / 10:00<') && !same.includes('· recording'), 'no pause, one clock');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: playback jumps over paused stretches, and the keys, buttons and timeline seek in active time',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/Replay.jsx'), {});
      try {
        await withDom(async window => {
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const key = (target, name, extra = {}) => act(() => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, ...extra })));
          try {
            const replay = { ...REPLAY, pauseSpans: [{ startMs: 200_000, endMs: 440_000 }], pausedMs: 240_000, activeMs: 360_000 };
            await act(() => root.render(bundle.module.React.createElement(bundle.module.Replay, { replay, api: {} })));
            const audio = window.document.querySelector('audio');
            let time = 0;
            let plays = 0;
            let pauses = 0;
            audio.play = () => { plays += 1; return Promise.resolve(); };
            audio.pause = () => { pauses += 1; };
            Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => time, set: value => { time = value; } });
            Object.defineProperty(audio, 'readyState', { configurable: true, get: () => 4 });
            Object.defineProperty(audio, 'duration', { configurable: true, get: () => 600 });
            time = 100;
            await act(() => audio.dispatchEvent(new window.Event('timeupdate')));
            assert(time === 100, 'outside a pause nothing moves');
            time = 250;
            await act(() => audio.dispatchEvent(new window.Event('timeupdate')));
            assert(time === 440, 'time passing into a pause jumps to its end');
            const slider = window.document.querySelector('[role="slider"]');
            assert(slider.getAttribute('aria-valuemax') === '360000', 'the slider runs on active time');
            time = 0;
            await key(slider, 'End');
            assert(time === 600, 'End seeks to the end of the call');
            await key(slider, 'Home');
            assert(time === 0, 'Home seeks to the start');
            await act(() => byLabel('Next part').click());
            assert(time === 120, 'Next part goes to the start of the following part');
            await act(() => byLabel('Next part').click());
            assert(time === 440, 'the third part starts after the pause, on the recording clock');
            await act(() => byLabel('Previous part').click());
            assert(time === 120, 'Previous part right at the start of a part goes back one');
            const chip = name => window.document.querySelector(`[data-part-chip="${name}"]`);
            assert(chip('question')?.tagName === 'BUTTON' && chip('answer')?.tagName === 'BUTTON', 'the Question and Your answer pills are buttons');
            await act(() => chip('answer').click());
            assert(time > 120 && time < 200 && chip('answer').getAttribute('aria-current') === 'true', `Your answer jumps to where the answer starts (${time})`);
            await act(() => chip('question').click());
            assert(time === 120 && chip('question').getAttribute('aria-current') === 'true', 'Question jumps back to the start of the part');
            await key(slider, 'ArrowDown');
            assert(time === 440, 'ArrowDown goes to the next part');
            await key(slider, 'ArrowUp');
            assert(time === 120, 'ArrowUp goes to the previous part');
            await key(slider, 'ArrowDown');
            await key(slider, 'ArrowLeft');
            assert(time === 195, 'ArrowLeft goes back five seconds of active time, which is before the pause on the recording');
            await key(slider, 'Home');
            await act(() => byLabel('Back 10 seconds').click());
            assert(time === 0, 'back 10 s clamps at the start');
            const seen = [];
            for (let step = 0; step < 80; step += 1) { await key(slider, 'ArrowRight'); seen.push(time); }
            assert(seen.every(at => at < 200 || at >= 440), 'seeking by key never rests inside the pause');
            assert(seen[seen.length - 1] === 600 && seen.includes(440), 'five-second steps cross the pause to the end of the recording');
            await key(slider, ' ');
            assert(plays === 1, 'Space starts playback');
            await key(slider, ' ');
            assert(pauses === 1, 'Space pauses it again');
            await act(() => byLabel('Speed 1.5x').click());
            assert(audio.playbackRate === 1.5 && byLabel('Speed 1.5x').getAttribute('aria-pressed') === 'true', 'the speed buttons set the playback rate');
            await key(window.document.querySelector('main'), 'x');
            assert(plays === 1 && pauses === 1, 'other keys do nothing');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the focus area shows the overview before playback and the part under the playhead after, with an Overview button back',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/Replay.jsx'), {});
      try {
        await withDom(async window => {
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const focus = () => window.document.querySelector('[data-replay-focus]');
          const button = text => [...window.document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.Replay, { replay: REPLAY_FEEDBACK, api: {} })));
            const audio = window.document.querySelector('audio');
            audio.play = () => Promise.resolve();
            let time = 0;
            Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => time, set: value => { time = value; } });
            Object.defineProperty(audio, 'readyState', { configurable: true, get: () => 4 });
            Object.defineProperty(audio, 'duration', { configurable: true, get: () => 600 });
            assert(focus().getAttribute('data-focus-mode') === 'overview', 'before playback the overview is shown');
            const overview = focus().textContent;
            assert(overview.includes('Clear story. Tidy close.') && !overview.includes('A third sentence'), 'the summary is cut to two sentences');
            assert(overview.includes('Name the metric first.') && overview.includes('Close on the ask.') && !overview.includes('A fourth priority'), 'only the top three priorities show');
            assert(overview.includes('Press play') && !overview.includes('What worked') && !overview.includes('Tell me about a time you onboarded users.'), 'a hint instead of the list');
            await act(() => button('More').click());
            assert(focus().textContent.includes('A third sentence that the overview cuts. A fourth one.'), 'More expands the summary');
            await act(() => button('Less').click());
            assert(!focus().textContent.includes('A third sentence'), 'Less folds it again');
            assert(!window.document.querySelector('[data-all-feedback]'), 'the long list is behind a toggle');
            await act(() => button('All feedback').click());
            const all = window.document.querySelector('[data-all-feedback]');
            assert(all && all.textContent.includes('Tell me about a time you onboarded users.') && all.textContent.includes('168 words per minute') && !/Transcript/.test(all.textContent), 'All feedback shows the compact list and the delivery, never a transcript');
            await act(() => button('Hide all feedback').click());
            assert(!window.document.querySelector('[data-all-feedback]'), 'hide folds the list');

            await act(() => audio.dispatchEvent(new window.Event('play')));
            assert(focus().getAttribute('data-focus-mode') === 'part', 'playing leaves the overview');
            time = 140;
            await act(() => audio.dispatchEvent(new window.Event('timeupdate')));
            assert(focus().querySelector('[data-focus-title]').textContent === 'Onboarding story' && focus().querySelector('[data-replay-announce]').textContent === 'Onboarding story', 'the part under the playhead is in focus and announced');
            assert(focus().querySelector('[data-part-now]').getAttribute('data-part-now') === 'answer', 'past the first candidate turn it is the answer');
            time = 125;
            await act(() => audio.dispatchEvent(new window.Event('timeupdate')));
            assert(focus().querySelector('[data-part-now]').getAttribute('data-part-now') === 'question', 'before it, the question');
            time = 450;
            await act(() => audio.dispatchEvent(new window.Event('timeupdate')));
            assert(focus().querySelector('[data-focus-title]').textContent === 'Your questions' && focus().textContent.includes('No notes for this part'), 'a later part with no feedback says so');
            await act(() => byLabel('Overview').click());
            assert(focus().getAttribute('data-focus-mode') === 'overview' && byLabel('Overview').getAttribute('aria-pressed') === 'true', 'the Overview button returns to the overview while the audio plays on');
            await act(() => byLabel('Next part').click());
            assert(focus().getAttribute('data-focus-mode') === 'part', 'picking a part leaves the overview again');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: a typed-only call shows one delivery line and no pace, confidence or filler rows; empty rows are hidden',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const feedback = {
          overall: { score: 5, summary: 'Fine.' },
          communication: { pace: 'Could not be measured.', clarity: 'Mostly clear.', structure: '', confidence: 'Could not be measured.', filler: 'Could not be measured.' },
          delivery: { summary: 'Every answer was typed, so only content was judged.', pace: 'Could not be measured.', fillers: 'Could not be measured.', interruptions: 'None recorded.', blank: '' },
        };
        const html = analysis => renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, feedback, analysis }, api: {}, initialShowAll: true }));
        const typed = html({ status: 'ready', metrics: { typedOnly: true } });
        assert(typed.includes('data-delivery-typed-only="true"') && typed.includes('Every answer was typed, so only content was judged.'), 'the review summary is the one delivery line');
        for (const gone of ['Could not be measured', 'None recorded', 'Pace', 'Confidence', 'Filler']) assert(!typed.includes(gone), `typed-only hides ${gone}`);
        assert(typed.includes('Mostly clear.') && !typed.includes('Structure'), 'other communication notes stay, and an empty one is hidden');
        const bare = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, feedback: { ...feedback, delivery: {} }, analysis: { status: 'ready', metrics: { typedOnly: true } } }, api: {}, initialShowAll: true }));
        assert(bare.includes('Delivery was not measured: every answer was typed.'), 'with no summary the fallback line is used');
        const chatTranscript = [{ speaker: 'interviewer', text: 'Hi', startMs: 0, endMs: 1000 }, { speaker: 'candidate', channel: 'chat', text: 'Hello', startMs: 5000, endMs: 5000 }];
        const inferred = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, transcript: chatTranscript, feedback, analysis: { status: 'ready' } }, api: {}, initialShowAll: true }));
        assert(inferred.includes('data-delivery-typed-only="true"'), 'without the analysis figure, an all-typed transcript is typed-only');
        // A chat line the call spoke in the candidate's voice is a spoken answer: not typed-only, whatever the figure is missing.
        const voicedTranscript = [{ speaker: 'interviewer', text: 'Hi', startMs: 0, endMs: 1000 }, { speaker: 'candidate', channel: 'chat', voiced: true, text: 'Hello', startMs: 5000, endMs: 8000 }];
        const voiced = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, transcript: voicedTranscript, feedback, analysis: { status: 'ready' } }, api: {}, initialShowAll: true }));
        assert(!voiced.includes('data-delivery-typed-only') && voiced.includes('Could not be measured'), 'a voiced answer keeps the measured delivery rows');
        assert(!voiced.includes('Delivery was not measured: every answer was typed.'));
        const spoken = html({ status: 'ready', metrics: { typedOnly: false } });
        assert(spoken.includes('Could not be measured') && spoken.includes('None recorded') && !spoken.includes('data-delivery-typed-only'), 'a spoken call keeps every measured row');
        assert(!spoken.includes('>blank<') && !/blank/i.test(spoken), 'a row with an empty value is hidden');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: planned questions that were not asked collapse into one line, and the past-calls length leaves paused time out',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const planned = [
          { question: 'Asked one', asked: true, score: 6, covered: 'Covered it.' },
          { question: 'Skipped alpha', asked: false },
          { question: 'Skipped beta', asked: false },
        ];
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, feedback: { overall: { score: 5, summary: 'Fine.' }, planned } }, api: {}, initialShowAll: true }));
        assert(markup.includes('2 prepared questions were not asked') && markup.includes('<details'), 'the unasked ones are one collapsed line');
        assert(!markup.includes('not asked ·') && !markup.includes('No notes.'), 'no empty not-asked cards remain');
        const details = markup.slice(markup.indexOf('data-testid="practice-unasked"'));
        assert(details.includes('Skipped alpha') && details.includes('Skipped beta') && !details.slice(0, details.indexOf('</details>')).includes('Asked one'), 'the titles sit inside the details');
        assert(markup.indexOf('Asked one') < markup.indexOf('practice-unasked') && !/<details[^>]*open/.test(markup), 'asked cards come first and the line starts collapsed');
        const one = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, feedback: { overall: { score: 5, summary: 'Fine.' }, planned: planned.slice(0, 2) } }, api: {}, initialShowAll: true }));
        assert(one.includes('1 prepared question was not asked'), 'singular wording for one');
        const { callLengthMs } = bundle.module.replayModel;
        assert(callLengthMs({ durationMs: 5_348_000, pausedMs: 4_767_000 }) === 581_000 && callLengthMs({ durationMs: 5_348_000, activeMs: 581_000 }) === 581_000 && callLengthMs({ durationMs: 60_000 }) === 60_000, 'past calls list the active length when a pause was recorded');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the practice call window follows every pushed phase from consent to replay',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
      try {
        await withDom(async window => {
          const listeners = [];
          const invoked = [];
          const hangUps = [];
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'consent' }),
            onState: listener => { listeners.push(listener); return () => { const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1); }; },
            onEvent: () => () => {},
            agreeModelDownload: async () => { invoked.push('agree'); },
            ready: async () => { invoked.push('ready'); },
            hangUp: async options => { hangUps.push(options); },
            leave: async () => { invoked.push('leave'); },
            decline: async () => { invoked.push('decline'); },
            callBack: async () => { invoked.push('callBack'); },
            cancelCallBack: async () => { invoked.push('cancelCallBack'); },
            chooseFeedback: async wants => { invoked.push(`feedback:${wants}`); },
            close: async () => { invoked.push('close'); },
            getReplay: async () => REPLAY,
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const push = patch => act(() => { listeners.forEach(listener => listener(patch)); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            assert(byLabel('Call setup'), 'the consent phase renders once getState resolves');
            await act(() => [...window.document.querySelectorAll('button')].find(node => node.textContent === 'Agree and download').click());
            assert(invoked.includes('agree'), 'agreeing must call agreeModelDownload');
            await push({ phase: 'downloading', modelDownload: { receivedBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } });
            assert(byLabel('Model download progress')?.getAttribute('aria-valuenow') === '25', 'downloading must follow the pushed progress');
            await push({ phase: 'precheck', level: 0, setup: { step: 'voices', attempt: 1 } });
            assert(window.document.querySelector('[aria-current="step"]')?.textContent.includes('Choosing the interviewer voices'), 'precheck must show the setup step in progress');
            await push({ phase: 'precheck', level: 0.5, persona: PERSONA, setup: { step: 'sessions', attempt: 1 } });
            assert(window.document.querySelector('[aria-current="step"]')?.textContent.includes('Bringing the interviewer in'), 'precheck must follow the pushed setup step');
            assert(byLabel('Microphone level')?.getAttribute('aria-valuenow') === '50', 'precheck must meter the live level');
            await push({ phase: 'precheck', level: 0.5, persona: PERSONA, setup: { step: 'ready', attempt: 1 } });
            assert(!window.document.querySelector('[aria-current="step"]'), 'ready: no step is still running');
            await act(() => [...window.document.querySelectorAll('button')].find(node => node.textContent === "I'm ready").click());
            assert(invoked.includes('ready'), 'pressing Ready must call ready');
            await push({ phase: 'precheck', level: 0.5, persona: PERSONA, setup: { step: 'ready', attempt: 1, calling: true } });
            assert(byLabel('Waiting for call')?.textContent.startsWith('Waiting for call'), 'after Ready only the wait is shown');
            assert(!byLabel('Setup progress') && !window.document.querySelector('button'), 'the setup card is gone while waiting');
            assert(window.document.title === 'Virtual Call', `before the ring the window is titled Virtual Call, not with the app's name, got ${window.document.title}`);
            await push({ phase: 'ringing', persona: PERSONA });
            assert(window.document.title === 'Virtual Call', `the ringing window keeps the call title, got ${window.document.title}`);
            assert(!/practice/iu.test(window.document.body.textContent), 'the ring screen never says practice');
            assert(byLabel('Answer call') && byLabel('Decline call'), 'ringing must offer Answer and Decline');
            // Declining, or letting it ring out, leaves a missed call that can be returned.
            await act(() => byLabel('Decline call').click());
            assert(invoked.includes('decline') && hangUps.length === 0, 'declining must not hang up: the window stays');
            await push({ phase: 'missed', missed: 'declined', persona: PERSONA });
            assert(byLabel('Call declined')?.textContent.includes('Dana Whitfield') , 'a declined ring stays on screen as a missed call');
            await push({ phase: 'missed', missed: 'unanswered', persona: PERSONA });
            assert(byLabel('Missed call')?.textContent.includes('Dana tried to reach you.'), 'a ring that rang out is a missed call');
            assert(!/practice/iu.test(window.document.body.textContent), 'the missed call screen never says practice');
            await act(() => byLabel('Call back').click());
            assert(invoked.includes('callBack'), 'Call back returns the call');
            await push({ phase: 'calling', persona: PERSONA });
            assert(byLabel('Calling')?.textContent.includes('Dana Whitfield') , 'the returned call rings out to the caller');
            await act(() => byLabel('End call').click());
            assert(invoked.includes('cancelCallBack'), 'ending the outgoing call cancels it');
            await push({ phase: 'missed', missed: 'expired', persona: PERSONA });
            assert(!byLabel('Call back') && byLabel('Missed call')?.textContent.includes('Dana is no longer available.'), 'a call nobody returned in time can no longer be returned');
            await act(() => byLabel('Close').click());
            assert(invoked.includes('close'), 'Close closes the window');
            await push({ phase: 'connecting', persona: PERSONA });
            assert(byLabel('Connecting call'), 'a picked-up call connects');
            await push({ phase: 'in-call', persona: PERSONA, elapsedMs: 65_000, speaking: 'interviewer' });
            assert(window.document.title === 'Virtual Call', `the call window keeps the call title, got ${window.document.title}`);
            assert(!/practice|\bAI\b/iu.test(window.document.body.textContent), 'the call screen never says practice or AI');
            assert(byLabel('Hang up') && byLabel('Mute microphone') && byLabel('Captions'), 'in-call must expose the control bar');
            assert(byLabel('Call timer')?.textContent === '1:05', 'the in-call timer must follow elapsedMs');
            // The interviewer leaving keeps the call screen up; the red button ends it.
            await push({ interviewerLeft: true, speaking: null });
            assert(byLabel('Dana Whitfield left')?.textContent.includes('Dana Whitfield left the call'), 'the call screen must say the interviewer left');
            assert(byLabel('Hang up') && !byLabel('Leave the call'), 'the call stays up with no dialog until Hang up is pressed');
            // A dropped connection reads as one, not as a goodbye.
            await push({ connectionLost: true });
            assert(byLabel('Dana Whitfield left')?.textContent.includes('Dana Whitfield lost their connection'), 'a dropped interviewer is shown as a lost connection');
            // The interviewer leaving does not end the call: the candidate stays until they press the red button.
            assert(!invoked.includes('leave') && byLabel('Hang up'), 'the candidate is still on the call');
            // The red button ends the call at once, with no dialog, whether or not the interviewer is still there.
            await push({ interviewerLeft: false, connectionLost: false });
            await act(() => byLabel('Hang up').click());
            assert(invoked.filter(name => name === 'leave').length === 1 && hangUps.length === 0, 'Hang up ends the call without choosing about feedback');
            assert(!window.document.querySelector('[role="dialog"]'), 'no confirmation is shown');
            // The choice about feedback comes after the call.
            await push({ phase: 'ended', feedbackChoice: null, feedbackRequested: true });
            assert(!byLabel('Feedback choice'), 'nothing is asked while the call is still being saved');
            await push({ phase: 'ended', feedbackChoice: 'pending' });
            const asked = byLabel('Feedback choice');
            assert(asked?.textContent.includes('uses AI to transcribe and review the recording'), 'the screen after the call says what feedback costs');
            await act(() => [...asked.querySelectorAll('button')].find(node => node.textContent === 'Skip feedback').click());
            await act(() => [...byLabel('Feedback choice').querySelectorAll('button')].find(node => node.textContent === 'Get feedback').click());
            assert(invoked.includes('feedback:false') && invoked.includes('feedback:true'), 'both answers reach the service');
            await push({ phase: 'replay' });
            assert(byLabel('Replay position')?.getAttribute('aria-valuemax') === '600000', 'replay must render the loaded replay payload');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the call screen shows a notice banner, an unread dot for interviewer chat, and a disabled chat after the interviewer left',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} };
        const render = state => renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, ...state }, api }));
        const plain = render({});
        assert(!plain.includes('call-notice') && !plain.includes('chat-unread'), 'no banner and no unread dot without a notice or an interviewer message');
        const noticed = render({ notice: { code: 'voice-failed', message: 'The interviewer voice stopped.' } });
        assert(noticed.includes('data-testid="call-notice"') && noticed.includes('The interviewer voice stopped.'), 'the notice message appears in the call screen');
        const unread = render({ chat: [{ from: 'candidate', text: 'hi', atMs: 1 }, { from: 'interviewer', text: 'Hello there', atMs: 2 }] });
        assert(unread.includes('data-testid="chat-unread"'), 'an interviewer message with the panel closed leaves a dot on the chat button');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: an unsent chat answer survives closing the panel and typing is re-reported every 3 s while the box has text and focus',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        const realSet = globalThis.setInterval;
        const realClear = globalThis.clearInterval;
        const timers = new Map();
        let nextId = 1000;
        const fakeSet = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
        const fakeClear = id => { timers.delete(id); };
        try {
          const listeners = [];
          const typing = [];
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'in-call', persona: PERSONA, chat: [] }),
            onState: listener => { listeners.push(listener); return () => {}; },
            onEvent: () => () => {},
            sendChat: async () => {},
            setTyping: async value => { typing.push(value); },
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const setValue = (node, value) => {
            node.focus();
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(node, value);
            node.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          };
          const refreshers = () => [...timers.values()].filter(timer => timer.ms === 3000);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => byLabel('Chat').click());
            globalThis.setInterval = fakeSet; window.setInterval = fakeSet;
            globalThis.clearInterval = fakeClear; window.clearInterval = fakeClear;
            await act(() => setValue(byLabel('Chat message'), 'half an answer'));
            assert(refreshers().length === 1, 'a focused box with text re-reports typing every 3 s');
            typing.length = 0;
            await act(() => { refreshers()[0].fn(); });
            assert(typing.join() === 'true', 'each tick re-sends typing true');
            await act(() => byLabel('Close chat').click());
            assert(refreshers().length === 0, 'closing the panel stops the refresh');
            await act(() => byLabel('Chat').click());
            assert(byLabel('Chat message').value === 'half an answer', 'the unsent answer is still there');
            assert(refreshers().length === 0, 'no refresh without focus');
            await act(() => { byLabel('Chat message').focus(); });
            assert(refreshers().length === 1, 'focusing a box with text starts the refresh');
            await act(() => { byLabel('Chat message').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
            assert(refreshers().length === 0, 'blur stops the refresh');
            await act(() => setValue(byLabel('Chat message'), ''));
            assert(refreshers().length === 0, 'an empty draft has no refresh');
          } finally { await act(() => root.unmount()); }
        } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: the wand in the call bar writes a reply and says it at once, never through the chat box, reports typing meanwhile, holds it through a pause and shows a failure',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const sent = [];
          const typing = [];
          let answer = null;
          let release;
          let pushState = null;
          const base = { phase: 'in-call', persona: PERSONA, chat: [{ from: 'interviewer', text: 'Why us?', atMs: 1000 }] };
          let paused = false;
          window.practiceCallAPI = {
            getState: async () => ({ ...base, paused }),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            sendChat: async (text, options) => { if (paused) return { ...base, paused: true }; sent.push({ text, options }); return { ...base }; },
            setTyping: async value => { typing.push(value); },
            draftAnswer: () => new Promise(resolve => { release = () => resolve(answer); }),
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 5)));
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            const button = byLabel('Suggest a reply');
            assert(button && button.closest('footer'), 'the wand sits in the call bar at the bottom');
            await act(() => byLabel('Chat').click());
            assert(window.document.querySelectorAll('[aria-label="Suggest a reply"]').length === 1, 'the chat panel has no wand of its own');
            await act(() => byLabel('Suggest a reply').click());
            assert(byLabel('Suggest a reply').disabled === true && byLabel('Suggest a reply').querySelector('[data-testid="suggest-loading"]'), 'the button shows a spinner while the reply is written');
            assert(typing.includes(true), 'the candidate counts as typing while the reply is written');
            answer = { text: 'Your fleet work matches what I did at Northwind.' };
            await act(() => release());
            await settle();
            assert(sent.length === 1 && sent[0].text === 'Your fleet work matches what I did at Northwind.' && sent[0].options?.generated === true, 'the reply is sent at once, marked generated');
            assert(byLabel('Chat message').value === '', 'the chat box is never filled');
            assert(typing.at(-1) === false, 'typing ends once the reply is ready');
            assert(byLabel('Suggest a reply').disabled === false && !byLabel('Suggest a reply').querySelector('[data-testid="suggest-loading"]'), 'the wand is back');
            assert(!/practice|\bAI\b/iu.test(window.document.body.textContent), 'the call screen never says practice or AI');
            // Ready while paused: held, and said on resume.
            paused = true;
            await act(() => pushState?.({ ...base, paused: true }));
            await act(() => byLabel('Suggest a reply').click());
            answer = { text: 'Held line.' };
            await act(() => release());
            await settle();
            assert(sent.length === 1, 'nothing is said while paused');
            paused = false;
            await act(() => pushState?.({ ...base, paused: false }));
            await settle();
            assert(sent.length === 2 && sent[1].text === 'Held line.' && sent[1].options?.generated === true, 'the held reply is said on resume');
            answer = { error: 'Could not suggest a reply. Try again.' };
            await act(() => byLabel('Suggest a reply').click());
            await act(() => release());
            assert(window.document.querySelector('[data-testid="suggest-error"]')?.textContent.includes('Could not suggest a reply. Try again.'), 'a failure is shown');
            assert(sent.length === 2, 'a failure says nothing');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
      const server = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = server.module;
        assert(!renderToStaticMarkup(React.createElement(InCall, { state: IN_CALL_STATE, api: { sendChat: () => {} } })).includes('Suggest a reply'), 'no wand without the bridge call');
        const left = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, interviewerLeft: true }, api: { sendChat: () => {}, draftAnswer: async () => ({}) } }));
        assert(/<button[^>]*aria-label="Suggest a reply"[^>]*disabled=""/.test(left), 'the wand is off once everyone left');
        const { ChatPanel } = server.module;
        const cut = renderToStaticMarkup(React.createElement(ChatPanel, { chat: [{ from: 'candidate', text: 'I rebuilt the billing —', cutOff: true, sent: 'I rebuilt the billing service in Go and cut costs.', atMs: 1 }, { from: 'candidate', text: 'Whole line.', atMs: 2 }] }));
        assert(cut.includes('I rebuilt the billing —') && cut.includes('Show full message') && cut.includes('I rebuilt the billing service in Go and cut costs.'), 'a cut-off line keeps its full text to copy');
        assert((cut.match(/data-chat-full="true"/g) || []).length === 1, 'only the cut-off line has it');
      } finally { await server.dispose(); }
    },
  },
  {
    // In the call of 2026-11-22 the window never passed setPadLanguage on to the call screen, so no dropdown showed.
    name: 'practice call render: the window passes the pad language choice through, so an open pad whose exercise offers languages has the Language dropdown',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const picks = [];
          let pad = { open: true, lang: '', text: '', choice: 'C', options: ['C', 'Go'] };
          let pushState = null;
          const current = () => ({ phase: 'in-call', persona: PERSONA, chat: [], pad });
          window.practiceCallAPI = {
            getState: async () => current(),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            setPadLanguage: async name => { picks.push(name); pad = { ...pad, choice: name }; pushState?.(current()); return current(); },
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => new Promise(resolve => setTimeout(resolve, 5)));
            const select = () => window.document.querySelector('[data-pad-language-choice="true"]');
            assert(select(), 'the open pad has the Language dropdown');
            await act(() => {
              select().value = 'Go';
              select().dispatchEvent(new window.Event('change', { bubbles: true }));
            });
            assert(picks.at(-1) === 'Go', 'a pick reaches the service');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: the wand keeps spinning until its line starts playing, through a pause that holds it, and stops when the line is given up on',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const sent = [];
          let answer = null;
          let release;
          let pushState = null;
          let chat = [{ from: 'interviewer', text: 'Why us?', atMs: 1000 }];
          let paused = false;
          const current = () => ({ phase: 'in-call', persona: PERSONA, chat, paused });
          window.practiceCallAPI = {
            getState: async () => current(),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            sendChat: async (text, options) => {
              if (paused) return { ...current(), paused: true };
              sent.push({ text, options });
              chat = [...chat, { id: `m${sent.length}`, from: 'candidate', text, atMs: 2000, voice: 'waiting' }];
              return current();
            },
            setTyping: async () => {},
            draftAnswer: () => new Promise(resolve => { release = () => resolve(answer); }),
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 5)));
          const spinning = () => !!byLabel('Suggest a reply').querySelector('[data-testid="suggest-loading"]') && byLabel('Suggest a reply').disabled === true;
          const setVoice = async (id, voice) => { chat = chat.map(item => (item.id === id ? { ...item, voice } : item)); await act(() => pushState?.(current())); await settle(); };
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => byLabel('Suggest a reply').click());
            answer = { text: 'A line in my voice.' };
            await act(() => release());
            await settle();
            assert(sent.length === 1, "the reply is sent");
            assert(spinning(), 'the reply is sent but not heard yet: still spinning');
            await act(() => pushState?.(current()));
            await settle();
            assert(spinning(), 'a state where the line still waits keeps it spinning');
            await setVoice('m1', 'playing');
            assert(!spinning(), 'the line started playing: the wand is back');
            // Ready during a pause: held, still spinning, sent on resume, and spinning until heard.
            paused = true;
            await act(() => pushState?.(current()));
            await act(() => byLabel('Suggest a reply').click());
            answer = { text: 'Held line.' };
            await act(() => release());
            await settle();
            assert(sent.length === 1 && spinning(), 'held through the pause, still spinning');
            paused = false;
            await act(() => pushState?.(current()));
            await settle();
            assert(sent.length === 2 && spinning(), 'sent on resume, still spinning until it is heard');
            await setVoice('m2', 'failed');
            assert(!spinning(), 'a line given up on stops the spinner');
            // No voice on the call: the entry never waits, so the wand is back as soon as it is sent.
            window.practiceCallAPI.sendChat = async text => { sent.push({ text }); chat = [...chat, { id: `m${sent.length}`, from: 'candidate', text, atMs: 3000 }]; return current(); };
            await act(() => byLabel('Suggest a reply').click());
            answer = { text: 'Typed only.' };
            await act(() => release());
            await settle();
            assert(sent.length === 3 && !spinning(), 'without a voice nothing is waited for');
            // Everyone leaving stops the wait.
            window.practiceCallAPI.sendChat = async text => { sent.push({ text }); chat = [...chat, { id: `m${sent.length}`, from: 'candidate', text, atMs: 4000, voice: 'waiting' }]; return current(); };
            await act(() => byLabel('Suggest a reply').click());
            answer = { text: 'Last words.' };
            await act(() => release());
            await settle();
            assert(spinning());
            await act(() => pushState?.({ ...current(), interviewerLeft: true }));
            await settle();
            assert(!byLabel('Suggest a reply').querySelector('[data-testid="suggest-loading"]'), 'nobody is left to hear it');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: a wand line accepted during a pause stops spinning once its voice is ready, before it plays',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const sent = [];
          let release;
          let pushState = null;
          let chat = [{ from: 'interviewer', text: 'Why us?', atMs: 1000 }];
          const current = () => ({ phase: 'in-call', persona: PERSONA, chat, paused: true });
          window.practiceCallAPI = {
            getState: async () => current(),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            // The voice can hold a line: it is accepted while paused (the state still says paused).
            sendChat: async (text, options) => { sent.push({ text, options }); chat = [...chat, { id: 'm1', from: 'candidate', text, atMs: 2000, voice: 'waiting' }]; return current(); },
            setTyping: async () => {},
            draftAnswer: () => new Promise(resolve => { release = () => resolve({ text: 'Held line.' }); }),
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 5)));
          const spinning = () => !!byLabel('Suggest a reply').querySelector('[data-testid="suggest-loading"]');
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => byLabel('Suggest a reply').click());
            await act(() => release());
            await settle();
            strict.equal(sent.length, 1, 'sent at once, though paused');
            assert(spinning(), 'its voice is still being made');
            chat = chat.map(item => (item.id === 'm1' ? { ...item, voice: 'ready' } : item));
            await act(() => pushState?.(current()));
            await settle();
            assert(!spinning(), 'ready while paused: the spinner stops, so the person knows to resume');
            await act(() => pushState?.({ ...current(), paused: false }));
            await settle();
            strict.equal(sent.length, 1, 'never sent a second time on the resume');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: with the pad open the wand says each step, types its code after the line is heard, gives way mid-piece when an interviewer speaks, and starts afresh when pressed again',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const sent = [];
          const padUpdates = [];
          let pushState = null;
          let chat = [{ from: 'interviewer', text: 'Write it in the pad.', atMs: 1000 }];
          let floor = null;
          let voicing = false;
          const current = () => ({ phase: 'in-call', persona: PERSONA, chat, floor, candidateVoicing: voicing, paused: false, pad: { open: true, lang: 'python', text: '' } });
          window.practiceCallAPI = {
            getState: async () => current(),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            // As the service does, the new state is also published, a moment after the send returns.
            sendChat: async (text, options) => { sent.push({ text, options }); chat = [...chat, { id: `m${sent.length}`, from: 'candidate', text, atMs: 2000, voice: 'waiting' }]; setTimeout(() => pushState?.(current()), 0); return current(); },
            updatePad: async text => { padUpdates.push(text); return current(); },
            setTyping: async () => {},
            draftAnswer: async () => ({ steps: [
              { say: 'I will start with the signature.', code: 'def f():\n' },
              { say: 'Then return one.', code: 'def f():\n    return 1\n' },
              { say: 'I think that is it.', code: null },
            ] }),
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const settle = (ms = 5) => act(() => new Promise(resolve => setTimeout(resolve, ms)));
          const pad = () => window.document.querySelector('textarea[aria-label="Code"]').value;
          const heard = async id => { chat = chat.map(item => (item.id === id ? { ...item, voice: 'heard' } : item)); await act(() => pushState?.(current())); };
          const until = async (check, label) => { for (let i = 0; i < 1000; i += 1) { if (check()) return; await settle(10); } strict.fail(`timed out: ${label} sent=${sent.length} pad=${JSON.stringify(pad())} chat=${JSON.stringify(chat.map(c => c.voice))}`); };
          const wand = () => byLabel('Suggest a reply');
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => byLabel('Suggest a reply').click());
            await until(() => sent.length === 1, 'first line sent');
            strict.equal(sent[0].text, 'I will start with the signature.');
            strict.equal(sent[0].options.generated, true);
            await settle(300);
            strict.equal(pad(), '', 'nothing is typed before the line has been heard');
            await heard('m1');
            await until(() => pad().length > 0, 'typing starts');
            assert(wand() && wand().disabled === false && !wand().querySelector('[data-testid="suggest-loading"]'), 'while it types the wand is still the wand, ready to press');
            await until(() => pad() === 'def f():\n', 'first piece typed');
            await until(() => sent.length === 2, 'second line after the typing');
            await heard('m2');
            await until(() => pad() === 'def f():\n    return 1\n', 'second piece typed key by key onto the first');
            await until(() => padUpdates.at(-1) === 'def f():\n    return 1\n', 'the typing reaches the call as pad edits');
            await until(() => sent.length === 3, 'the closing line');
            await heard('m3');
            await settle(50);
            // An interviewer who starts speaking while it types: after the reaction time it finishes the word it is on
            // and stops there, mid-piece. What it typed stays.
            const base = 'def f():\n    return 1\n';
            const long = `${base}\n# ${'word '.repeat(60)}\n`;
            window.practiceCallAPI.draftAnswer = async () => ({ steps: [{ say: 'A long comment.', code: long }, { say: 'Done.', code: null }] });
            await act(() => wand().click());
            await until(() => sent.length === 4, 'line sent');
            await heard('m4');
            await until(() => pad().length > base.length + 20, 'typing the comment');
            floor = { n: 1, yieldMs: 150, speakerId: 'A' };
            await act(() => pushState?.(current()));
            await settle(2000); // the word it is on takes about a second at a person's speed
            const gaveWayAt = pad();
            await settle(300);
            strict.equal(pad(), gaveWayAt, 'nothing more is typed once it has given way');
            assert(gaveWayAt.length < long.length, 'stopped part-way through the piece');
            assert(/(?:word|[\s.,;:()[\]{}#])$/u.test(gaveWayAt), `stopped at the end of a word, never inside one: ${JSON.stringify(gaveWayAt.slice(-12))}`);
            strict.equal(sent.length, 4, 'and says nothing more');
            // Pressed while its line is being said: nothing happens, and the line and its run go on.
            let ignored = 0;
            window.practiceCallAPI.draftAnswer = async () => { ignored += 1; return { text: 'Never.' }; };
            voicing = true;
            await act(() => pushState?.(current()));
            await act(() => wand().click());
            await settle(50);
            strict.equal(ignored, 0, 'no draft while the AI voice is speaking');
            strict.equal(sent.length, 4);
            voicing = false;
            await act(() => pushState?.(current()));
            // Pressed again while it works: that run ends and a fresh draft starts from the pad as it stands.
            let drafts = 0;
            window.practiceCallAPI.draftAnswer = async () => { drafts += 1; return { steps: [{ say: `Another go ${drafts}.`, code: `${gaveWayAt}${'z'.repeat(150)}\n` }] }; };
            await act(() => wand().click());
            await until(() => sent.length === 5, 'a fresh line');
            await heard('m5');
            await until(() => pad().length > gaveWayAt.length + 5, 'typing again');
            await act(() => wand().click());
            await until(() => drafts === 2, 'pressed mid-work: a fresh draft');
            const cutAt = pad();
            await settle(300);
            assert(pad() === cutAt || sent.length === 6, 'the earlier run stopped typing');
            assert(cutAt.startsWith(gaveWayAt), 'the code typed so far stays in the pad');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: new lines above a line that starts as they do are typed at the end of the line above, with nothing pushed along in front of the cursor',
    async run() {
      const { padEdit } = await import('../../src/practice-call/padTyping.js');
      // call-mwttebvu: an `ensure` clause typed above `end` kept the shared "en" and pushed the "d" along with every key.
      const before = 'do\n\t\t\tloop\n\t\t\tend\n\t\tend\n\nend';
      const after = 'do\n\t\t\tloop\n\t\t\tend\n\t\tensure\n\t\t\tin_array: a.has (Result)\n\t\tend\n\nend';
      const edit = padEdit(before, after);
      strict.equal(edit.remove, 0);
      strict.equal(edit.insert, '\n\t\tensure\n\t\t\tin_array: a.has (Result)');
      strict.equal(before.slice(0, edit.at), 'do\n\t\t\tloop\n\t\t\tend', 'the cursor goes to the end of the line above');
      strict.equal(`${before.slice(0, edit.at)}${edit.insert}${before.slice(edit.at)}`, after);
      // Every place tried gives the same text; an edit that has only one place is left where it is.
      const cases = [['', 'abc'], ['abc', 'abcd'], ['x = 1', 'x = 11'], ['foo\n', 'foo\nbar\n'], ['a\n\nend', 'a\n\tb\n\nend'], ['end', 'ensured'], ['one two', 'one three two'],
        ['if x:\n    pass\n', 'if x:\n    pass\nif y:\n    pass\n'], ['aaaa', 'aaaaaa'], ['abc', 'axc'], ['abcd', 'ab'], ['same', 'same']];
      for (const [from, to] of cases) {
        const { at, remove, insert } = padEdit(from, to);
        strict.equal(`${from.slice(0, at)}${insert}${from.slice(at + remove)}`, to, `${JSON.stringify(from)} to ${JSON.stringify(to)}`);
      }
      strict.deepEqual(padEdit('abc', 'abcd'), { at: 3, remove: 0, insert: 'd' }, 'text added at the end is typed at the end');
      strict.deepEqual(padEdit('x = 1', 'x = 11'), { at: 5, remove: 0, insert: '1' });
      strict.deepEqual(padEdit('one two', 'one three two'), { at: 4, remove: 0, insert: 'three ' }, 'a word goes in before the next word, not inside it ("one t|wo")');
      strict.deepEqual(padEdit('foo\nend', 'foo\nbar\nend'), { at: 3, remove: 0, insert: '\nbar' }, 'a new line is opened from the end of the line above');
      strict.deepEqual(padEdit('abc', 'axc'), { at: 1, remove: 1, insert: 'x' }, 'a replacement is left as it was');

      // Through the pad itself: at every key the rest of the cursor's line is empty, and the pad ends as the target.
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
      const saved = {};
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, CodingPad } = bundle.module;
        const typerRef = { current: null };
        const root = createRoot(dom.window.document.getElementById('root'));
        await React.act(async () => root.render(React.createElement(CodingPad, { initialText: before, typerRef })));
        const area = dom.window.document.querySelector('textarea');
        const seen = new Set();
        let done = false;
        let run = null;
        await React.act(async () => { run = typerRef.current.typeTo(after, { pace: 0.05 }).then(result => { done = true; return result; }); });
        while (!done) {
          await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
          seen.add(area.value);
        }
        strict.equal(await run, true);
        strict.equal(area.value, after);
        assert(seen.size > 10, `the keys were seen one by one: ${seen.size}`);
        const head = before.slice(0, edit.at);
        const tail = before.slice(edit.at);
        assert(tail.startsWith('\n'), 'the cursor sits at the end of a line');
        for (const text of seen) {
          assert(text.startsWith(head) && text.endsWith(tail), `only the new lines change: ${JSON.stringify(text)}`);
          const typed = text.slice(head.length, text.length - tail.length);
          assert(edit.insert.startsWith(typed), `the new lines are typed in order where the cursor is, nothing pushed along: ${JSON.stringify(typed)}`);
        }
        await React.act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
  {
    name: 'practice call render: the typing estimate counts deletions and keys, and is zero when the pad already reads the target',
    async run() {
      const { padTypingMs } = await import('../../src/practice-call/padTyping.js');
      strict.equal(padTypingMs('abc', 'abc'), 0);
      const typed = padTypingMs('', 'x = 1\n');
      assert(typed > 700 && typed < 2500, `six keys take about a second or two: ${typed}`);
      assert(padTypingMs('abcd', 'ab') > 0 && padTypingMs('abcd', 'ab') < typed, 'two deletions are quick');
    },
  },
  {
    name: 'practice call render: the hands write code at a person\'s speed, about five to seven characters a second, unevenly (call-mwttebvu)',
    async run() {
      const { keyDelayMs, padTypingMs } = await import('../../src/practice-call/padTyping.js');
      const code = 'def has(self, item):\n    for x in self.items:\n        if x == item:\n            return True\n    return False\n';
      const perSecond = code.length / (padTypingMs('', code) / 1000);
      assert(perSecond >= 4.5 && perSecond <= 7, `characters a second: ${perSecond.toFixed(2)}`);
      assert(keyDelayMs('x', '\n', () => 0.5) > keyDelayMs('x', 'x', () => 0.5), 'a beat before a new line\'s content');
      assert(keyDelayMs('x', ' ', () => 0.5) > keyDelayMs('y', 'x', () => 0.5), 'a smaller beat at the start of a word');
      assert(keyDelayMs('(', 'x', () => 0.5) > keyDelayMs('y', 'x', () => 0.5), 'brackets are a little slower');
      assert(keyDelayMs(' ', ' ', () => 0.5) < 50, 'indentation is quick');
      strict.equal(keyDelayMs('a', 'b', () => 0.3), keyDelayMs('a', 'b', () => 0.3), 'deterministic for a random');
    },
  },
  {
    name: 'practice call render: typing paced to a spoken line stays within what a person does',
    async run() {
      const { typingPace, SPEECH_MS_PER_WORD } = await import('../../src/practice-call/padTyping.js');
      strict.equal(typingPace('', 4000), 1, 'no line: the usual pace');
      strict.equal(typingPace('four words are said', 0), 1, 'nothing to type');
      strict.equal(typingPace('four words are said', 4 * SPEECH_MS_PER_WORD), 1, 'equal lengths need no change');
      strict.equal(typingPace('ten words take about four seconds to say out loud', 3200), 1.25, 'the hands slow to a longer line');
      strict.equal(typingPace('two words', 40000), 1, 'the hands are never hurried past a person\'s speed');
      strict.equal(typingPace('a very long line '.repeat(20), 500), 1.8, 'and never slowed to a crawl');
    },
  },
  {
    name: 'practice call render: a step explained after its code is typed in silence first, its line is sent only once the piece is in the pad, and a step explained during is paced to its line',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const sent = [];
          const logged = [];
          let pushState = null;
          let chat = [{ from: 'interviewer', text: 'Write it in the pad.', atMs: 1000 }];
          const current = () => ({ phase: 'in-call', persona: PERSONA, chat, floor: null, paused: false, pad: { open: true, lang: 'python', text: '' } });
          const first = 'x = 1\n';
          const second = `${first}y = 2\n`;
          const padAtSend = [];
          let padSent = ''; // the pad as the interviewers have it
          const pad = () => window.document.querySelector('textarea[aria-label="Code"]').value;
          window.practiceCallAPI = {
            getState: async () => current(),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            sendChat: async (text, options) => { padAtSend.push(padSent); sent.push({ text, options }); chat = [...chat, { id: `m${sent.length}`, from: 'candidate', text, atMs: 2000, voice: 'waiting' }]; setTimeout(() => pushState?.(current()), 0); return current(); },
            updatePad: async text => { padSent = text; return current(); },
            setTyping: async () => {},
            logEvent: async line => { logged.push(line); },
            draftAnswer: async () => ({ steps: [{ say: 'That is the first value set.', code: first, order: 'after' }, { say: 'And the second goes in beside it now.', code: second, order: 'during' }] }),
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const settle = (ms = 5) => act(() => new Promise(resolve => setTimeout(resolve, ms)));
          const voice = async (id, value) => { chat = chat.map(item => (item.id === id ? { ...item, voice: value } : item)); await act(() => pushState?.(current())); };
          const until = async (check, label) => { for (let i = 0; i < 600; i += 1) { if (check()) return; await settle(10); } strict.fail(`timed out: ${label} pad=${JSON.stringify(pad())}`); };
          const work = () => logged.filter(line => /\] work /u.test(line)).map(line => line.replace(/^\[[^\]]*\] work /u, ''));
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => window.document.querySelector('[aria-label="Suggest a reply"]').click());
            await until(() => sent.length === 1, 'the line that looks back');
            strict.equal(padAtSend[0], first, 'explained after: the whole piece was in the pad before its line was sent');
            await voice('m1', 'heard');
            await until(() => sent.length === 2, 'the next step waits for that line to be heard');
            strict.equal(padAtSend[1], first, 'explained during: nothing of the piece is typed before its line is sent');
            await settle(60);
            strict.equal(pad(), first, 'and the hands wait for the voice to start');
            await voice('m2', 'playing');
            await until(() => pad() === second, 'typed while the line plays');
            await voice('m2', 'heard');
            await until(() => work().some(line => line.startsWith('run end')), 'run ends');
            const lines = work();
            const at = pattern => lines.findIndex(line => pattern.test(line));
            assert(at(/^step 1\/2 begin explain=after /u) >= 0 && at(/^step 2\/2 begin explain=during .*paced x\d\.\d\d to the line$/u) >= 0, lines.join('\n'));
            assert(at(/^step 1\/2 type end after \d+ms completed$/u) < at(/^step 1\/2 line heard /u), `typed, then said: ${lines.join(' | ')}`);
            assert(at(/^step 1\/2 line heard /u) < at(/^step 2\/2 begin /u), 'a step starts only when the one before is typed and heard');
            strict.equal(lines.at(-1), 'run end: all steps done');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: the wand logs each step (sizes, timings, why a run stops) and sends the pad while it types and the moment typing ends',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const sent = [];
          const padUpdates = [];
          const logged = [];
          let pushState = null;
          let chat = [{ from: 'interviewer', text: 'Write it in the pad.', atMs: 1000 }];
          const current = () => ({ phase: 'in-call', persona: PERSONA, chat, floor: null, paused: false, pad: { open: true, lang: 'python', text: '' } });
          const code = `x = ${'1 + '.repeat(5)}1\n`;
          let plan = [{ say: 'First piece.', code, together: false }, { say: 'Second piece.', code: `${code}y = 2\n`, together: false }];
          window.practiceCallAPI = {
            getState: async () => current(),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            sendChat: async (text, options) => { sent.push({ text, options }); chat = [...chat, { id: `m${sent.length}`, from: 'candidate', text, atMs: 2000, voice: 'waiting' }]; setTimeout(() => pushState?.(current()), 0); return current(); },
            updatePad: async text => { padUpdates.push(text); return current(); },
            setTyping: async () => {},
            logEvent: async line => { logged.push(line); },
            draftAnswer: async () => ({ steps: plan }),
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const settle = (ms = 5) => act(() => new Promise(resolve => setTimeout(resolve, ms)));
          const pad = () => window.document.querySelector('textarea[aria-label="Code"]').value;
          const voice = async (id, value) => { chat = chat.map(item => (item.id === id ? { ...item, voice: value } : item)); await act(() => pushState?.(current())); };
          const until = async (check, label) => { for (let i = 0; i < 1500; i += 1) { if (check()) return; await settle(10); } strict.fail(`timed out: ${label} pad=${JSON.stringify(pad())}`); };
          const work = () => logged.filter(line => /\] work /u.test(line)).map(line => line.replace(/^\[[^\]]*\] work /u, ''));
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => byLabel('Suggest a reply').click());
            await until(() => sent.length === 1, 'first line');
            await voice('m1', 'heard');
            await until(() => pad().length > 5, 'typing');
            // While it types, the pad goes out about once a second, not only after the debounce that never fires mid-typing.
            await until(() => padUpdates.length > 0 && padUpdates.at(-1).length < code.length, 'an update before the piece is finished');
            await until(() => pad() === code, 'first piece typed');
            // The last keys of the piece are in the update at once, with no wait for the debounce.
            strict.equal(padUpdates.at(-1), code, 'the pad is sent when typing ends');
            await until(() => sent.length === 2, 'second line');
            await voice('m2', 'failed');
            await until(() => work().some(line => line.startsWith('run end')), 'run ends');
            const lines = work();
            assert(lines.includes('run begin 2 steps'), lines.join('\n'));
            assert(lines.some(line => /^step 1\/2 begin explain=before say 12 chars code \+\d+\/-0 chars, estimated typing \d+ms$/u.test(line)), lines.join('\n'));
            assert(lines.some(line => /^step 1\/2 type start$/u.test(line)) && lines.some(line => /^step 1\/2 type end after \d+ms completed$/u.test(line)), lines.join('\n'));
            assert(lines.some(line => /^step 1\/2 line heard after \d+ms completed$/u.test(line)), lines.join('\n'));
            assert(lines.some(line => /^step 2\/2 line heard after \d+ms not completed \(voice failed\)$/u.test(line)), lines.join('\n'));
            assert(lines.at(-1).startsWith('run end: step 2/2 line not completed'), `the reason a run stops is logged: ${lines.at(-1)}`);
            assert(logged.every(line => line.length < 600), 'each line fits the bridge cap');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: a step marked together types while its line is being said, and an interviewer starting to speak stops the talking and the typing together',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const sent = [];
          let pushState = null;
          let chat = [{ from: 'interviewer', text: 'Write it in the pad.', atMs: 1000 }];
          let floor = null;
          const current = () => ({ phase: 'in-call', persona: PERSONA, chat, floor, paused: false, pad: { open: true, lang: 'python', text: '' } });
          const code = `def f(x):\n    # ${'step '.repeat(60)}\n    return x\n`;
          window.practiceCallAPI = {
            getState: async () => current(),
            onState: listener => { pushState = listener; return () => {}; },
            onEvent: () => () => {},
            sendChat: async (text, options) => { sent.push({ text, options }); chat = [...chat, { id: `m${sent.length}`, from: 'candidate', text, atMs: 2000, voice: 'waiting' }]; setTimeout(() => pushState?.(current()), 0); return current(); },
            updatePad: async () => current(),
            setTyping: async () => {},
            draftAnswer: async () => ({ steps: [{ say: 'I will walk the input as I write it.', code, together: true }, { say: 'Done.', code: null, together: false }] }),
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const settle = (ms = 5) => act(() => new Promise(resolve => setTimeout(resolve, ms)));
          const pad = () => window.document.querySelector('textarea[aria-label="Code"]').value;
          const voice = async (id, value, extra = {}) => { chat = chat.map(item => (item.id === id ? { ...item, voice: value, ...extra } : item)); await act(() => pushState?.(current())); };
          const until = async (check, label) => { for (let i = 0; i < 400; i += 1) { if (check()) return; await settle(10); } strict.fail(`timed out: ${label} pad=${JSON.stringify(pad())}`); };
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => byLabel('Suggest a reply').click());
            await until(() => sent.length === 1, 'line sent');
            await settle(200);
            strict.equal(pad(), '', 'nothing typed before the voice starts');
            await voice('m1', 'playing');
            await until(() => pad().length > 15, 'typing while the line is still being said');
            strict.notEqual(chat.find(item => item.id === 'm1').voice, 'heard', 'the line is still playing');
            // An interviewer starts speaking: the engine cuts the line (after the reaction time) and the hands stop with it.
            floor = { n: 1, yieldMs: 120, speakerId: 'A' };
            await act(() => pushState?.(current()));
            await settle(450);
            await voice('m1', 'playing', { cutOff: true, text: 'I will walk the —' });
            const stoppedAt = pad();
            await settle(300);
            strict.equal(pad(), stoppedAt, 'the typing stopped with the voice');
            assert(stoppedAt.length < code.length, 'part-way');
            strict.equal(sent.length, 1, 'nothing more is said');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: chat sends on Enter, keeps Shift+Enter for new lines, reports typing only while the draft has text, and clears the unread dot when opened',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      // The bundle is built inside the DOM so React sees a browser and handles input events natively.
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const listeners = [];
          const sent = [];
          const typing = [];
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'in-call', persona: PERSONA, chat: [] }),
            onState: listener => { listeners.push(listener); return () => {}; },
            onEvent: () => () => {},
            sendChat: async text => { sent.push(text); },
            setTyping: async value => { typing.push(value); },
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const push = patch => act(() => { listeners.forEach(listener => listener(patch)); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const setValue = (node, value) => {
            node.focus();
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(node, value);
            node.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          };
          const key = (node, init) => node.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await push({ chat: [{ from: 'interviewer', text: 'Quick question', atMs: 1000 }] });
            assert(window.document.querySelector('[data-testid="chat-unread"]'), 'the unread dot shows while the panel is closed');
            await act(() => byLabel('Chat').click());
            assert(!window.document.querySelector('[data-testid="chat-unread"]'), 'opening the panel clears the dot');
            await push({ chat: [{ from: 'interviewer', text: 'Quick question', atMs: 1000 }, { from: 'interviewer', text: 'Another', atMs: 2000 }] });
            assert(!window.document.querySelector('[data-testid="chat-unread"]'), 'no dot while the panel is open');
            const box = byLabel('Chat message');
            assert(box.tagName === 'TEXTAREA' && box.maxLength === 2000, 'the message box is a textarea limited to 2000 characters');
            await act(() => setValue(box, 'x'.repeat(1799)));
            assert(!window.document.querySelector('[data-testid="chat-counter"]'), 'no counter below 1800 characters');
            await act(() => setValue(box, 'x'.repeat(1800)));
            assert(window.document.querySelector('[data-testid="chat-counter"]')?.textContent === '1800/2000', 'the counter shows from 1800 characters');
            await act(() => setValue(box, ''));
            assert(typing.join() === 'true,true,false', `typing follows the draft, got ${typing.join()}`);
            typing.length = 0;
            await act(() => setValue(box, 'line one'));
            await act(() => key(box, { key: 'Enter', shiftKey: true }));
            assert(sent.length === 0, 'Shift+Enter does not send');
            await act(() => key(box, { key: 'Enter' }));
            assert(sent.join('|') === 'line one', 'Enter sends the draft');
            assert(typing[typing.length - 1] === false && box.value === '', 'sending clears the draft and ends typing');
            typing.length = 0;
            await act(() => setValue(box, 'again'));
            await act(() => { box.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
            assert(typing[typing.length - 1] === false, 'leaving the box ends typing');
            typing.length = 0;
            await act(() => byLabel('Close chat').click());
            assert(typing[typing.length - 1] === false, 'closing the panel ends typing');
            await act(() => byLabel('Chat').click());
            await push({ interviewerLeft: true });
            assert(byLabel('Chat message').disabled === true, 'the chat box is disabled once the interviewer left');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: Decline keeps the window and a replay window shows the replay whatever the call state says',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
      try {
        for (const replayWindow of [false, true]) {
          await withDom(async window => {
            if (replayWindow) window.history.replaceState({}, '', '/?view=practice-call&replay=1&callId=call-dana-1');
            const hangUps = [];
            let replayLoads = 0;
            window.practiceCallAPI = {
              getState: async () => ({ phase: replayWindow ? 'precheck' : 'ringing', persona: PERSONA }),
              onState: () => () => {},
              onEvent: () => () => {},
              hangUp: async options => { hangUps.push(options); },
              getReplay: async () => { replayLoads += 1; return REPLAY; },
            };
            const root = bundle.module.createRoot(window.document.getElementById('root'));
            const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
            const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
            try {
              await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
              if (replayWindow) {
                assert(byLabel('Replay position') && replayLoads >= 1, 'a replay window loads and shows the replay instead of the precheck screen');
              } else {
                await act(() => byLabel('Decline call').click());
                assert(hangUps.length === 0, 'declining never hangs up: the missed call stays on screen');
              }
            } finally { await act(() => root.unmount()); }
          });
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: deleting a recording asks for confirmation before the audio source is removed',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/Replay.jsx'), {});
      try {
        await withDom(async window => {
          const deletedCalls = [];
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.Replay, {
              replay: REPLAY, api: { deleteRecording: async () => { deletedCalls.push(REPLAY.callId); } },
            })));
            assert(window.document.querySelector('audio')?.getAttribute('src') === REPLAY.audioUrl, 'the audio element is bound to the recording URL');
            assert(!window.document.querySelector('[role="alertdialog"]'), 'delete must not be armed before the first click');
            await act(() => byLabel('Delete recording').click());
            assert(window.document.querySelector('[role="alertdialog"]'), 'the first delete click must open the confirm step');
            assert(deletedCalls.length === 0, 'nothing is deleted before the user confirms');
            await act(() => byLabel('Confirm delete recording').click());
            assert(deletedCalls.length === 1, 'confirming must call deleteRecording');
            assert(!window.document.querySelector('audio')?.hasAttribute('src'), 'the audio source is removed after the delete');
            assert(byLabel('Recording unavailable')?.textContent.includes('Recording deleted'), 'the replay must say the recording was deleted');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: a failed analysis offers Try again, which asks for the review again and shows a refusal; a running retry names its step',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/Replay.jsx'), {});
      try {
        await withDom(async window => {
          const asked = [];
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const failed = { ...REPLAY, analysis: { status: 'failed', error: 'feedback: too long' } };
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.Replay, { replay: failed, api: {} })));
            assert(!byLabel('Try the feedback again'), 'without the bridge call there is no button');
            await act(() => root.render(bundle.module.React.createElement(bundle.module.Replay, { replay: failed, api: { retryAnalysis: async () => { asked.push('retry'); return { error: 'Another call is in progress.' }; } } })));
            assert(byLabel('Analysis failed').textContent.includes('Try again'), 'the failed notice carries the button');
            await act(() => byLabel('Try the feedback again').click());
            assert(asked.length === 1, 'the button asks the main process to run the review again');
            assert(byLabel('Analysis failed').textContent.includes('Another call is in progress.'), 'a refusal is shown in the notice');
            await act(() => root.render(bundle.module.React.createElement(bundle.module.Replay, { replay: { ...REPLAY, analysis: { status: 'analyzing', stage: 'review' } }, api: {} })));
            assert(byLabel('Analysis status').textContent.includes('writing the feedback'), 'the running notice names the step');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the extracted view-model helpers drive the screens and the replay delivery section',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay, callModel } = bundle.module;
        assert(callModel.formatBytes(100 * 1024 * 1024) === '100 MB', 'formatBytes rounds whole megabytes');
        assert(callModel.downloadPercent({ receivedBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 }) === 25, 'downloadPercent reports the received fraction');
        assert(callModel.levelPercent(0.426) === 43, 'levelPercent rounds the meter level');
        assert(callModel.humanizeKey('pauseCount') === 'pause count', 'humanizeKey splits camelCase keys');
        assert(callModel.setupProgress({ step: 'voice' }).map(item => item.status).join(',') === 'done,done,done,active,pending,pending,pending', 'setupProgress marks the steps before the running one as done');
        assert(callModel.setupProgress(null).every(item => item.status === 'pending'), 'setupProgress with no step leaves everything pending');
        assert(callModel.elapsedLabel(59999) === '59s' && callModel.elapsedLabel(65000) === '1m 05s', 'elapsedLabel counts seconds, then minutes');
        assert(JSON.stringify(callModel.mergeState({ phase: 'consent', level: 0 }, { phase: 'precheck' })) === JSON.stringify({ phase: 'precheck', level: 0 }), 'mergeState keeps the previous fields');
        const merged = callModel.mergeEvent({ phase: 'in-call', captions: [] }, { kind: 'caption', caption: { speaker: 'candidate', text: 'Hi', atMs: 1 } });
        assert(merged.captions.length === 1 && merged.phase === 'in-call', 'mergeEvent appends captions without dropping the phase');
        assert(callModel.MODEL_SIZES.length === 2, 'both model sizes are listed once, in the shared module');
        assert(callModel.describeDeliveryValue({ wpm: { cited: '168 words per minute' }, pauseCount: 3 }) === 'wpm: 168 words per minute; pause count: 3', 'describeDeliveryValue labels each metric and keeps cited text');
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY, initialShowAll: true }));
        for (const fragment of ['aria-label="Delivery"', '168 words per minute', 'pause count']) {
          assert(markup.includes(fragment), `the replay delivery section is missing ${fragment}`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: scrubber helpers clamp positions, chapters, fills, bubbles, markers and keys',
    async run() {
      const model = await import(pathToFileURL(path.join(PRACTICE, 'replayModel.js')).href);
      const { positionToMs, chapterIndexAt, segmentLayout, segmentFill, bubbleLeftPx, nearestMarker, prevChapterStart, nextChapterStart, scrubberKeyTarget } = model;
      const chapters = REPLAY.chapters;

      assert(positionToMs(0, 300, 600_000) === 0, 'the left edge of the bar is time zero');
      assert(positionToMs(150, 300, 600_000) === 300_000, 'the middle of the bar is half the duration');
      assert(positionToMs(300, 300, 600_000) === 600_000, 'the right edge of the bar is the duration');
      assert(positionToMs(-40, 300, 600_000) === 0, 'x left of the bar clamps to zero');
      assert(positionToMs(900, 300, 600_000) === 600_000, 'x right of the bar clamps to the duration');
      assert(positionToMs(150, 0, 600_000) === 0, 'a bar with no width has no position');
      assert(positionToMs(150, 300, 0) === 0, 'a recording with no duration has no position');

      assert(chapterIndexAt(chapters, 0) === 0, 'time zero is in the first chapter');
      assert(chapterIndexAt(chapters, 119_999) === 0, 'the last millisecond before a boundary stays in the earlier chapter');
      assert(chapterIndexAt(chapters, 120_000) === 1, 'a chapter start belongs to the new chapter');
      assert(chapterIndexAt(chapters, 419_999) === 1, 'the middle chapter owns its tail');
      assert(chapterIndexAt(chapters, 420_000) === 2, 'the final chapter starts at its own start');
      assert(chapterIndexAt(chapters, 599_999) === 2, 'the final millisecond of the call is in the last chapter');
      assert(chapterIndexAt(chapters, -1) === -1, 'nothing before the call has a chapter');
      assert(chapterIndexAt(chapters, 620_000) === -1, 'a position past the last chapter end has no chapter');
      assert(chapterIndexAt([], 10) === -1, 'an empty chapter list has no chapter');
      assert(chapterIndexAt([{ startMs: 0 }, { startMs: 100_000 }], 50_000) === 0, 'a chapter without an endMs runs to the next start');

      const layout = segmentLayout(chapters, 600_000);
      assert(layout.length === 3, 'every chapter becomes a segment');
      assert(layout[0].startMs === 0 && layout[0].endMs === 120_000 && layout[0].leftPct === 0 && layout[0].widthPct === 20, 'the first segment spans 0-20%');
      assert(layout[1].startMs === 120_000 && layout[1].endMs === 420_000 && layout[1].leftPct === 20 && layout[1].widthPct === 50, 'the middle segment spans 20-70%');
      assert(layout[2].startMs === 420_000 && layout[2].endMs === 600_000 && layout[2].leftPct === 70 && layout[2].widthPct === 30, 'the last segment spans 70-100%');
      assert(layout[1].title === 'Onboarding story', 'a segment keeps its chapter title');
      assert(segmentLayout([{ title: 'Solo', startMs: 0 }], 100_000)[0].endMs === 100_000, 'a chapter without an endMs fills to the end of the recording');
      assert(segmentLayout([], 600_000).length === 0, 'no chapters means no segments');
      assert(segmentLayout(chapters, 0).length === 0, 'no duration means no segments');

      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 120_000) === 0, 'a segment is empty at its start');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 270_000) === 0.5, 'a segment is half filled at its midpoint');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 420_000) === 1, 'a segment is full at its end');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 600_000) === 1, 'a segment stays full past its end');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 0) === 0, 'a segment is empty before it starts');
      assert(segmentFill({ startMs: 5_000, endMs: 5_000 }, 5_000) === 0, 'a zero-width segment never fills');

      assert(bubbleLeftPx(0, 300, 80) === 0, 'a bubble at the left edge is clamped to zero');
      assert(bubbleLeftPx(150, 300, 80) === 110, 'a centred bubble is offset by half its width');
      assert(bubbleLeftPx(300, 300, 80) === 220, 'a bubble at the right edge stays inside the bar');
      assert(bubbleLeftPx(-20, 300, 80) === 0, 'a bubble left of the bar clamps to zero');
      assert(bubbleLeftPx(150, 60, 80) === 0, 'a bubble wider than the bar sits at zero');
      assert(bubbleLeftPx(150, 0, 80) === 0, 'a bar with no width has no bubble offset');

      const pause = { kind: 'pause', label: 'Long pause', atMs: 30_000 };
      const talkOver = { kind: 'interruption', label: 'Talked over', atMs: 33_000 };
      assert(nearestMarker([pause], 30_600, 600_000, 600).label === 'Long pause', 'a marker within a pixel under the cursor is picked');
      assert(nearestMarker([pause], 36_000, 600_000, 600).label === 'Long pause', 'a marker exactly 6px away still counts');
      assert(nearestMarker([pause], 37_000, 600_000, 600) === null, 'a marker 7px away does not count');
      assert(nearestMarker([pause, talkOver], 32_000, 600_000, 600).label === 'Talked over', 'the closest of two markers wins');
      assert(nearestMarker([pause], 30_000, 600_000, 600).atMs === 30_000, 'the returned marker carries its clamped time');
      assert(nearestMarker([], 30_000, 600_000, 600) === null, 'no markers means no hint');
      assert(nearestMarker([pause], 0, 0, 600) === null, 'a recording with no duration has no marker hint');
      assert(nearestMarker([pause], 30_000, 600_000, 0) === null, 'a bar with no width has no marker hint');

      assert(prevChapterStart(chapters, 122_000) === 120_000, 'past the first second a previous jump restarts the chapter');
      assert(prevChapterStart(chapters, 120_500) === 0, 'inside the first second of a chapter a previous jump goes back one');
      assert(prevChapterStart(chapters, 0) === 0, 'the first chapter cannot go back further than zero');
      assert(prevChapterStart(chapters, 300_000) === 120_000, 'the middle of a chapter restarts at its own start');
      assert(prevChapterStart([], 50_000) === 0, 'no chapters means the previous jump is zero');
      assert(prevChapterStart(chapters, 1_000, 2_000) === 0, 'a longer grace still keeps the first chapter at zero');

      assert(nextChapterStart(chapters, 0, 600_000) === 120_000, 'the next chapter starts at 2:00');
      assert(nextChapterStart(chapters, 120_000, 600_000) === 420_000, 'the next jump from a chapter start is the following chapter');
      assert(nextChapterStart(chapters, 420_000, 600_000) === 600_000, 'past the last chapter the next jump is the end of the call');
      assert(nextChapterStart(chapters, 590_000, 600_000) === 600_000, 'the tail of the last chapter jumps to the end');
      assert(nextChapterStart([], 590_000, 600_000) === 600_000, 'no chapters means the next jump is the end of the call');

      assert(scrubberKeyTarget('ArrowRight', {}, 100_000, 600_000, chapters) === 105_000, 'ArrowRight moves five seconds');
      assert(scrubberKeyTarget('ArrowLeft', {}, 100_000, 600_000, chapters) === 95_000, 'ArrowLeft moves five seconds back');
      assert(scrubberKeyTarget('ArrowLeft', {}, 1_000, 600_000, chapters) === 0, 'ArrowLeft clamps at zero');
      assert(scrubberKeyTarget('ArrowRight', {}, 598_000, 600_000, chapters) === 600_000, 'ArrowRight clamps at the end');
      assert(scrubberKeyTarget('l', {}, 100_000, 600_000, chapters) === 110_000, 'L moves ten seconds forward');
      assert(scrubberKeyTarget('L', {}, 100_000, 600_000, chapters) === 110_000, 'shift+L moves ten seconds forward');
      assert(scrubberKeyTarget('j', {}, 100_000, 600_000, chapters) === 90_000, 'J moves ten seconds back');
      assert(scrubberKeyTarget('J', {}, 100_000, 600_000, chapters) === 90_000, 'shift+J moves ten seconds back');
      assert(scrubberKeyTarget('Home', {}, 300_000, 600_000, chapters) === 0, 'Home jumps to the start');
      assert(scrubberKeyTarget('End', {}, 300_000, 600_000, chapters) === 600_000, 'End jumps to the end');
      assert(scrubberKeyTarget('PageUp', {}, 300_000, 600_000, chapters) === 120_000, 'PageUp restarts the current chapter');
      assert(scrubberKeyTarget('PageUp', {}, 120_800, 600_000, chapters) === 0, 'PageUp inside the first second goes back one chapter');
      assert(scrubberKeyTarget('PageDown', {}, 120_000, 600_000, chapters) === 420_000, 'PageDown jumps to the next chapter');
      assert(scrubberKeyTarget('PageDown', {}, 420_000, 600_000, chapters) === 600_000, 'PageDown past the last chapter jumps to the end');
      assert(scrubberKeyTarget('ArrowRight', { altKey: true }, 300_000, 600_000, chapters) === 420_000, 'Alt+ArrowRight jumps to the next chapter');
      assert(scrubberKeyTarget('ArrowLeft', { altKey: true }, 300_000, 600_000, chapters) === 120_000, 'Alt+ArrowLeft restarts the current chapter');
      assert(scrubberKeyTarget('ArrowRight', {}, 0, 600_000, []) === 5_000, 'keys still work without chapters');
      assert(scrubberKeyTarget('Enter', {}, 300_000, 600_000, chapters) === null, 'unhandled keys return null');
      assert(scrubberKeyTarget(' ', { altKey: true }, 300_000, 600_000, chapters) === null, 'unhandled keys with Alt return null');
    },
  },
  {
    name: 'practice call render: the timeline draws a block per part split into question and answer, tinted by score, with a playhead and moment ticks',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY_FEEDBACK, api: {}, initialPositionMs: 270_000 }));
        const bar = markup.slice(markup.indexOf('data-timeline="true"'), markup.indexOf('data-replay-now-title'));
        assert(bar.length > 0, 'the timeline renders before the part title');
        assert((bar.match(/data-chapter="/g) || []).length === 3, 'one block per part');
        assert(bar.includes('data-chapter="0" data-band="low"') && bar.includes('data-chapter="1" data-band="good"') && bar.includes('data-chapter="2" data-band="none"'), 'blocks are tinted by score: red, green, neutral grey when there is none');
        assert(bar.includes('bg-red-500') && bar.includes('bg-emerald-500') && bar.includes('bg-slate-500'), 'the tints are red, green and grey');
        assert(bar.includes('data-chapter="1" data-band="good" data-current="true"') && bar.includes('ring-white/90'), 'the part under the playhead is marked');
        assert(bar.includes('data-part="question" class="absolute inset-y-0 left-0 bg-emerald-500 opacity-40" style="width:5%"') && bar.includes('data-part="answer" class="absolute inset-y-0 right-0 bg-emerald-500" style="width:95%"'), 'the middle part is a light question share (15 s of 300 s) and a solid answer');
        assert(bar.includes('style="left:0%;width:max(2px, calc(20% - 2px))"') && bar.includes('style="left:70%;width:max(2px, calc(30% - 2px))"'), 'blocks sit side by side with a thin gap');
        assert(bar.includes('data-playhead="true"') && bar.includes('left:45%') && bar.includes('data-timeline-knob="true"'), 'a playhead line with a knob at 4:30 of 10:00');
        assert(bar.includes('data-marker-kind="pause"') && bar.includes('data-marker-kind="interruption"'), 'moments are small ticks on the bar');
        assert(!bar.includes('title='), 'no native tooltips');
        assert(markup.includes('aria-valuetext="4:30 of 10:00, Onboarding story"'), 'aria-valuetext reports the time and part');
        assert(/data-replay-clock="true"[^>]*>4:30 \/ 10:00</.test(markup), 'the clock reads current / length');
        assert(/data-replay-now-title="true"[^>]*truncate[^>]*>Onboarding story</.test(markup), 'the current part title sits under the bar on one truncated line');
        const unchaptered = renderToStaticMarkup(React.createElement(Replay, { replay: { durationMs: 60_000, chapters: [], transcript: [], persona: { name: 'Sam' } }, api: {}, initialPositionMs: 1_000 }));
        assert((unchaptered.match(/data-chapter="/g) || []).length === 1 && unchaptered.includes('style="left:0%;width:max(2px, calc(100% - 2px))"'), 'a call without chapters is one block for the whole call');
        assert(/data-focus-title="true"[^>]*>Interview with Sam</.test(unchaptered) && !unchaptered.includes('data-part-chip'), 'its focus shows the call title and no question/answer chips');
        const empty = renderToStaticMarkup(React.createElement(Replay, { replay: null, api: {} }));
        assert(empty.includes('data-focus-mode="overview"') && empty.includes('Practice interview'), 'no replay at all still renders');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: avatarOf gives one upper-case letter of the first name and a stable colour per name, neutral without a name',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { avatarOf, AVATAR_PALETTE, NEUTRAL_AVATAR_COLOR } = bundle.module.persona;
        const dana = avatarOf({ name: 'dana whitfield' });
        assert(dana.letter === 'D', `one letter expected, got ${dana.letter}`);
        assert(avatarOf({ name: 'dana whitfield' }).color === dana.color, 'the same name always gets the same colour');
        assert(AVATAR_PALETTE.includes(dana.color), 'the colour comes from the palette');
        const colours = new Set(['Dana Whitfield', 'John Park', 'Priya Nair', 'Marcus Lee', 'Sofia Reyes', 'Tom Ide'].map(name => avatarOf({ name }).color));
        assert(colours.size > 1, 'different names do not all share one colour');
        const none = avatarOf({});
        assert(none.letter === '' && none.color === NEUTRAL_AVATAR_COLOR, 'no name gives a neutral colour and no letter');
        assert(avatarOf(null).letter === '', 'a missing person never throws');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: a panel call shows one tile per interviewer with letter, name and role, rings only the speaking one and says everyone left',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} };
        const participants = [
          { id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' },
          { id: 'B', name: 'John Park', role: 'Senior engineer', status: 'joined' },
          { id: 'C', name: 'Priya Nair', role: 'Designer', status: 'joined' },
        ];
        const render = state => renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants, ...state }, api }));
        const markup = render({ speakingId: 'B', captions: [{ speaker: 'interviewer', speakerId: 'B', text: 'Hello', atMs: 1 }, { speaker: 'interviewer', text: 'Hi', atMs: 2 }] });
        assert((markup.match(/data-avatar="true"/g) || []).length === 3, 'one avatar per interviewer');
        for (const fragment of ['aria-label="John Park"', 'Senior engineer', '>J<', '>P<', 'data-tiles="3"', 'grid-cols-3']) assert(markup.includes(fragment), `panel call is missing ${fragment}`);
        assert((markup.match(/data-speaking="true"/g) || []).length === 1 && /aria-label="John Park" data-speaking="true"/.test(markup), 'only the speakingId tile is ringed');
        assert(/aria-label="Dana Whitfield" data-speaking="false"/.test(markup), 'the lead is not ringed while a colleague speaks');
        assert(markup.includes('aria-label="Your camera"') && markup.includes('z-10'), 'the self-view stays on top of the tiles');
        const duo = render({ participants: participants.slice(0, 2), speakingId: null });
        assert(duo.includes('grid-cols-2') && !duo.includes('data-speaking="true"'), 'two tiles sit side by side and a null speakingId rings nobody');
        const withCaptions = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants, captions: [{ speaker: 'interviewer', speakerId: 'B', text: 'Hello', atMs: 1 }, { speaker: 'interviewer', text: 'Hi', atMs: 2 }, { speaker: 'interviewer', speakerId: 'Z', text: 'Yo', atMs: 3 }] }, api }));
        // Captions are hidden until switched on, so check the label rule through the DOM test below; here only the markup of tiles.
        assert(!withCaptions.includes('Live captions'), 'captions stay off by default');
        const wrapped = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants }, api, leaveRequest: 0 }));
        assert(!wrapped.includes('col-span-2'), 'three tiles stay in one row while no side panel is open');
        const left = render({ interviewerLeft: true, speaking: null });
        assert(left.includes('Everyone left the call') && !left.includes('Dana Whitfield left the call'), 'with several interviewers the notice says everyone left');
        assert(!left.includes('data-speaking') && !left.includes('data-avatar="true"') && !left.includes('data-left'), 'no interviewer tile is rendered once everyone left');
        assert(left.includes('data-tiles="0"') && left.includes('data-self="full"') && left.includes('pc-expand') && left.includes('inset-0'), 'the candidate tile fills the stage');
        assert(/data-self="corner"/.test(markup) && !markup.includes('pc-expand'), 'with interviewers present the candidate stays a corner preview');
        const some = render({ participants: participants.map((item, at) => (at === 1 ? { ...item, status: 'left' } : item)), speakingId: 'A' });
        assert(some.includes('data-tiles="2"') && !some.includes('John Park') && some.includes('Dana Whitfield') && some.includes('Priya Nair') && some.includes('data-self="corner"'), 'when one of a panel leaves the others stay and re-flow');
        const leftPresenting = render({ interviewerLeft: true, speaking: null, screen: { title: 'Question', content: 'Two sum' } });
        assert(leftPresenting.includes('data-layout="presenting"') && !leftPresenting.includes('data-chip="true"') && leftPresenting.includes('data-chip="you"'), 'the chips of people who left leave the presenting bar');
        const solo = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, interviewerLeft: true }, api }));
        assert(solo.includes('Dana Whitfield left the call'), 'a solo call keeps the named notice');
        assert(!solo.includes('data-avatar="true"') && solo.includes('data-self="full"'), 'a solo call shows only the candidate once the interviewer left');
        // Four and five interviewers (ids A to E), with obviously synthetic names.
        const crowd = ['Test Person One', 'Test Person Two', 'Test Person Three', 'Test Person Four', 'Test Person Five']
          .map((name, at) => ({ id: 'ABCDE'[at], name, role: `Role ${at + 1}`, status: 'joined' }));
        const four = render({ participants: crowd.slice(0, 4), speakingId: 'D' });
        assert(four.includes('data-tiles="4"') && four.includes('grid-cols-2') && four.includes('grid-rows-2'), 'four tiles form a 2 by 2 grid');
        assert(!four.includes('col-span-2') && !four.includes('grid-cols-3'), 'four tiles are all the same size');
        for (const person of crowd.slice(0, 4)) assert(four.includes(`aria-label="${person.name}"`) && four.includes(person.role), `four-tile call shows ${person.name}`);
        const five = render({ participants: crowd, speakingId: 'E' });
        assert(five.includes('data-tiles="5"') && five.includes('grid-cols-6') && five.includes('grid-rows-2'), 'five tiles use a six-column, two-row grid');
        assert((five.match(/col-span-2/g) || []).length === 5 && five.includes('col-start-2') && five.includes('col-start-4'), 'five tiles are equal and the bottom pair is centred');
        // The candidate's own picture floats over the bottom right, so only the last tile carries its name at the top.
        assert((five.match(/data-label-top="true"/g) || []).length === 1 && (four.match(/data-label-top="true"/g) || []).length === 1, 'one tile moves its name clear of the self view');
        assert(!render({ participants: crowd.slice(0, 2), speakingId: 'A' }).includes('data-label-top'), 'two tiles keep their names at the bottom');
        for (const person of crowd) assert(five.includes(`aria-label="${person.name}"`) && five.includes(person.role), `five-tile call shows ${person.name}`);
        assert((five.match(/data-avatar="true"/g) || []).length === 5 && /aria-label="Test Person Five" data-speaking="true"/.test(five), 'five avatars and the fifth speaker is ringed');
        const { avatarOf, replaySpeakerName } = await import('../../src/practice-call/persona.js');
        assert(new Set(crowd.map(person => avatarOf(person).letter)).size === 1 && crowd.every(person => avatarOf(person).color), 'avatars resolve for every colleague');
        const replay = { persona: { name: crowd[0].name }, panel: crowd.slice(1) };
        assert(['B', 'C', 'D', 'E'].every((id, at) => replaySpeakerName(replay, id) === crowd[at + 1].name) && replaySpeakerName(replay, 'A') === crowd[0].name, 'replay names every id A to E');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: a colleague who joins late rises in with a toast for 4 s and one chime, captions name the speaker, and three tiles wrap 2+1 beside a side panel',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        const realSet = globalThis.setTimeout;
        const realClear = globalThis.clearTimeout;
        const timers = new Map();
        let nextId = 5000;
        const fakeSet = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
        const fakeClear = id => { timers.delete(id); };
        const chimes = [];
        window.AudioContext = class { constructor() { chimes.push(this); this.currentTime = 0; this.destination = {}; } createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } resume() {} close() {} };
        try {
          const listeners = [];
          const lead = { id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' };
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'in-call', persona: PERSONA, participants: [lead], captions: [], chat: [] }),
            onState: listener => { listeners.push(listener); return () => {}; },
            onEvent: () => () => {},
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const push = patch => act(() => { listeners.forEach(listener => listener(patch)); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            assert(!byLabel('Participant joined') && chimes.length === 0, 'the opening cast makes no toast and no chime');
            globalThis.setTimeout = fakeSet; window.setTimeout = fakeSet;
            globalThis.clearTimeout = fakeClear; window.clearTimeout = fakeClear;
            const john = { id: 'B', name: 'John Park', role: 'Senior engineer', status: 'joined' };
            await push({ participants: [lead, john], speakingId: 'B', captions: [{ speaker: 'interviewer', speakerId: 'B', text: 'Welcome.', atMs: 1 }, { speaker: 'interviewer', text: 'Plain.', atMs: 2 }] });
            assert(byLabel('Participant joined')?.textContent === 'John Park joined', 'a toast names the colleague');
            assert(chimes.length === 1, 'one join chime plays');
            assert(byLabel('John Park')?.className.includes('pc-rise') && !byLabel('Dana Whitfield')?.className.includes('pc-rise'), 'only the newcomer rises in');
            const toastTimer = [...timers.values()].find(timer => timer.ms === 4000);
            assert(toastTimer, 'the toast is on a 4 s timer');
            await act(() => { toastTimer.fn(); });
            assert(!byLabel('Participant joined'), 'the toast goes away after 4 s');
            await push({ participants: [lead, john] });
            assert(chimes.length === 1 && !byLabel('Participant joined'), 'an unchanged list does not chime again');
            // Interviewers leave one at a time, each with one soft chime and a fading tile.
            await push({ participants: [lead, { ...john, status: 'left' }] });
            assert(chimes.length === 2, 'one leave chime when the first leaves');
            assert(byLabel('John Park')?.className.includes('pc-leave'), 'the tile that left fades out');
            await push({ participants: [lead, { ...john, status: 'left' }] });
            assert(chimes.length === 2, 'an unchanged list does not chime again');
            await push({ participants: [{ ...lead, status: 'left' }, { ...john, status: 'left' }], interviewerLeft: true });
            assert(chimes.length === 3, 'the last one leaving chimes once');
            await act(() => byLabel('Captions').click());
            const labels = [...window.document.querySelectorAll('[aria-label="Live captions"] p span')].map(node => node.textContent);
            assert(labels.join('|') === 'John:|Interviewer:', `captions are labelled by speaker, got ${labels.join('|')}`);
            const priya = { id: 'C', name: 'Priya Nair', role: 'Designer', status: 'joined' };
            await push({ participants: [lead, john, priya] });
            assert(byLabel('Participant joined')?.textContent === 'Priya Nair joined', 'a third interviewer gets a toast too');
            assert(!byLabel('Priya Nair').className.includes('col-span-2'), 'three tiles stay in one row without a side panel');
            await act(() => byLabel('Chat').click());
            assert(byLabel('Priya Nair').className.includes('col-span-2'), 'with a side panel open three tiles wrap 2+1');
            assert(byLabel('Your camera'), 'the self-view stays on the call');
          } finally { await act(() => root.unmount()); }
        } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: the join chime is two soft notes and never throws without audio; panel events reach the window state',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { ringtone, callModel } = bundle.module;
        const notes = [];
        class Fake {
          constructor() { this.currentTime = 2; this.destination = {}; }
          createOscillator() { const o = { frequency: { setValueAtTime: hz => notes.push(hz) }, connect() {}, start() {}, stop() {} }; return o; }
          createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
          resume() {}
          close() {}
        }
        ringtone.playJoinChime({ AudioContext: Fake });
        assert(JSON.stringify(notes) === '[660,880]', `two rising notes expected, got ${JSON.stringify(notes)}`);
        for (const win of [null, {}, { AudioContext: class { constructor() { throw new Error('blocked'); } } }]) ringtone.playJoinChime(win);
        // The leave chime is the falling pair and quieter than the join chime; it never throws either.
        const joinGains = [];
        const leaveGains = [];
        const gainsInto = list => class extends Fake { createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime: level => list.push(level) }, connect() {} }; } };
        notes.length = 0;
        ringtone.playLeaveChime({ AudioContext: gainsInto(leaveGains) });
        assert(JSON.stringify(notes) === '[784,523]', `two falling notes expected, got ${JSON.stringify(notes)}`);
        ringtone.playJoinChime({ AudioContext: gainsInto(joinGains) });
        assert(Math.max(...leaveGains) < Math.max(...joinGains), 'the leave chime is quieter than the join chime');
        for (const win of [null, {}, { AudioContext: class { constructor() { throw new Error('blocked'); } } }]) ringtone.playLeaveChime(win);
        const joined = callModel.mergeEvent({ phase: 'in-call', participants: [{ id: 'A', name: 'Dana' }] }, { type: 'participant-joined', id: 'B', name: 'John' });
        assert(joined.participants.length === 2 && joined.participants[1].name === 'John', 'a joined event adds the colleague');
        assert(callModel.mergeEvent(joined, { type: 'participant-joined', id: 'B', name: 'John' }).participants.length === 2, 'a repeated join is not duplicated');
        assert(callModel.mergeEvent(joined, { type: 'speaker', speakerId: 'B' }).speakingId === 'B', 'a speaker event moves the ring');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the focus names who asked from the panel, the persona or a multi-speaker turn',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const replay = {
          ...REPLAY_FEEDBACK,
          persona: { name: 'Dana Whitfield', role: 'Hiring manager' },
          panel: [{ id: 'B', name: 'John Park', role: 'Senior engineer' }],
          transcript: [
            { role: 'interviewer', speakerId: 'A', text: 'Hi, how has your day been so far?', startMs: 2_000, endMs: 8_000 },
            { role: 'candidate', text: 'Good, thanks.', startMs: 10_000, endMs: 14_000 },
            { role: 'interviewer', speakerId: 'B', text: 'Tell me about onboarding.', startMs: 120_000, endMs: 135_000 },
            { role: 'candidate', text: 'We rewrote the first-run flow.', startMs: 135_000, endMs: 200_000 },
            { role: 'interviewer', text: 'Mixed.', startMs: 420_000, endMs: 430_000, segments: [{ speakerId: 'A', text: 'Thanks.' }, { speakerId: 'B', text: 'Over to me.' }] },
          ],
          chapters: [...REPLAY_FEEDBACK.chapters.slice(0, 2), { title: 'Your questions', questionTurnIndex: 4, startMs: 420_000, endMs: 600_000, markers: [] }],
        };
        const at = (value, ms) => renderToStaticMarkup(React.createElement(Replay, { replay: value, api: {}, initialPositionMs: ms }));
        const asker = html => (/Asked by <span[^>]*>([^<]*)<\/span>(?:<span[^>]*> · ([^<]*)<\/span>)?/.exec(html) || []).slice(1, 3).filter(Boolean).join(' | ');
        assert(asker(at(replay, 125_000)) === 'John Park | Senior engineer', 'a part opened by a colleague names that colleague and role');
        assert(asker(at(replay, 5_000)) === 'Dana Whitfield | Hiring manager', 'the lead comes from the persona');
        assert(asker(at(replay, 430_000)) === 'John Park | Senior engineer', 'a turn several interviewers spoke in is credited to the last to speak when nobody asked anything (a hand-over, then the exercise)');
        const asked = { ...replay, transcript: replay.transcript.map((turn, index) => (index === 4 ? { ...turn, segments: [{ speakerId: 'B', text: 'I will leave it there.' }, { speakerId: 'A', text: 'Anything you would like to ask us?' }] } : turn)) };
        assert(asker(at(asked, 430_000)) === 'Dana Whitfield | Hiring manager', 'and to whoever put the question when one of them did');
        assert(asker(at({ ...replay, panel: undefined, persona: undefined }, 125_000)) === 'Interviewer', 'no panel on the replay falls back to a plain Interviewer');
      } finally { await bundle.dispose(); }
    },
  },
  ...presentingTests,
  {
    name: 'practice call render: a colleague heard over the speaker rings with them, captions as its own line, and the replay lists no transcript',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall, Replay } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} };
        const participants = [
          { id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' },
          { id: 'B', name: 'John Park', role: 'Senior engineer', status: 'joined' },
        ];
        const render = state => renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants, ...state }, api }));
        const both = render({ speakingId: 'A', overSpeakingId: 'B' });
        assert((both.match(/data-speaking="true"/g) || []).length === 2, 'the speaker and the overlaid colleague both ring');
        assert(/aria-label="John Park" data-speaking="true"/.test(both) && /aria-label="Dana Whitfield" data-speaking="true"/.test(both));
        assert((render({ speakingId: 'A', overSpeakingId: null }).match(/data-speaking="true"/g) || []).length === 1, 'no overlay rings only the speaker');
        const strip = render({ speakingId: 'A', overSpeakingId: 'B', screen: { title: 'Q', content: 'Body', speakerId: 'A' } });
        assert((strip.match(/data-speaking="true"/g) || []).length === 2, 'chips in the sharing bar ring too');
        const turns = [...REPLAY.transcript, { speaker: 'interviewer', speakerId: 'B', text: 'Over remark.', startMs: 1000, endMs: 1500, overlay: true }];
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, transcript: turns }, api: {}, initialPositionMs: 200_000 }));
        assert(!markup.includes('Over remark.'), 'the replay shows no transcript, so an overlay line is not listed');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the pause pill shows only while paused and the timer text stays on the published time',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {}, setPaused: () => {} };
        const running = renderToStaticMarkup(React.createElement(InCall, { state: IN_CALL_STATE, api }));
        assert(!/paused/iu.test(running), 'no pause notice while running');
        const paused = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, paused: true }, api }));
        const overlay = paused.match(/<p[^>]*data-paused="true"[^>]*>.*?<\/p>/u)?.[0] || '';
        assert(overlay.includes('PAUSED') && overlay.includes('Press P to resume (⌘P while typing)'), 'the overlay names the key');
        assert(overlay.includes('fixed') && overlay.includes('pointer-events-none') && overlay.includes('role="status"'), 'the overlay floats over the window and takes no clicks or layout room');
        assert(!/paused/iu.test(paused.match(/<footer.*?<\/footer>/su)?.[0] ?? 'paused'), 'nothing about the pause sits in the footer');
        assert(paused.includes('1:12'), 'the timer shows the frozen published time');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: shouldTogglePause toggles on bare P outside editable fields and on Command or Control P anywhere',
    async run() {
      const { default: strict } = await import('node:assert/strict');
      const { shouldTogglePause } = await import('../../src/practice-call/pauseKey.js');
      const assert = Object.assign((value, message) => strict.ok(value, message), strict);
      const div = { tagName: 'DIV' };
      assert.deepEqual(shouldTogglePause({ key: 'p', target: div }), { toggle: true, preventDefault: false });
      assert.deepEqual(shouldTogglePause({ key: 'P', target: div }), { toggle: true, preventDefault: false });
      for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
        assert.equal(shouldTogglePause({ key: 'p', target }).toggle, false, `${target.tagName} keeps typing`);
        assert.deepEqual(shouldTogglePause({ key: 'p', metaKey: true, target }), { toggle: true, preventDefault: true });
        assert.deepEqual(shouldTogglePause({ key: 'p', ctrlKey: true, target }), { toggle: true, preventDefault: true });
      }
      assert.equal(shouldTogglePause({ key: 'p', repeat: true, target: div }).toggle, false);
      assert.equal(shouldTogglePause({ key: 'p', repeat: true, metaKey: true, target: div }).toggle, false);
      assert.equal(shouldTogglePause({ key: 'p', altKey: true, target: div }).toggle, false);
      assert.equal(shouldTogglePause({ key: 'q', target: div }).toggle, false);
    },
  },
];
