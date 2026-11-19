// Bug reports for the standalone Interview Helper app.
//
// "Report a bug" in the main window writes one Markdown file describing what
// the app was doing: versions, the saved interviews as states and counts, the
// Claude worker, running tasks, what the window showed, and the recent event
// and log lines of both processes. It never contains career text, answers,
// questions, posting text or transcripts.
//
// "Copy to clipboard" saves the full report in `<profile>/bug-reports/` and
// puts a short pointer (the file path plus the typed description) on the
// clipboard, so an AI assistant reads the file from disk instead of receiving
// it pasted. "Save to file" writes the same report where the person chooses.
// Saved reports are pruned by age and count at start and on each write.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUG_REPORT_DIRECTORY = 'bug-reports';
export const BUG_REPORT_RETENTION = 20;
export const BUG_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const BUG_REPORT_DESCRIPTION_MAX = 20_000;
export const BUG_REPORT_COPY_CHANNEL = 'interview-app:copy-bug-report';
export const BUG_REPORT_SAVE_CHANNEL = 'interview-app:save-bug-report';

// Only files of the shape this module writes are ever pruned.
const REPORT_FILE_RE = /^bug-report-.*\.md$/u;
const MAX_EVENT_LINES = 400;
const MAX_SCREEN_MESSAGES = 30;
const MAX_LINE_CHARS = 600;
const PROCESS_STARTED_AT = Date.now();

// ── Redaction ────────────────────────────────────────────────────────────────
// A report is handed to someone else, so log and event lines lose what a
// reader does not need: URL queries and fragments, local paths, credentials
// and opaque ids.

// A path may contain spaces ("Application Support"), so it runs to the end of
// the line or to a quote, bracket or stack-frame arrow, whichever comes first.
const LOCAL_PATH_RE = /(^|[\s=:([`'"])(?:file:\/\/|~\/|\/(?:(?:System\/Volumes\/Data\/)?Users|private|tmp|Applications|opt|Volumes|Library|var|etc|usr|home)(?=\/|$))[^\r\n|`'"()←⏎]*/gimu;

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : '<redacted-url>';
  } catch { return '<redacted-url>'; }
}

export function redactReportText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s`<>"|]+/giu, (match) => {
      const suffix = match.match(/[)\]}.,;:]+$/u)?.[0] || '';
      return `${redactUrl(suffix ? match.slice(0, -suffix.length) : match)}${suffix}`;
    })
    .replace(LOCAL_PATH_RE, '$1<local-path>')
    .replace(/\b"?(?:cookie|set[-_ ]?cookie)"?\s*(?:=|:)\s*[^\r\n|]+/giu, 'credential=<redacted>')
    .replace(/\b"?(?:(?:proxy[-_ ]?)?authorization|password|passphrase|api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|session[-_ ]?(?:id|token|key)|token)"?\s*(?:=|:)\s*(?:(?:Bearer|Basic)\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;|]+)/giu, 'credential=<redacted>')
    .replace(/\bBearer\s+[^\s,;|]+/giu, 'Bearer <redacted>')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/gu, '<redacted-key>')
    .replace(/\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\b/gu, '<redacted-jwt>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<opaque-id>');
}

/** One redacted line of bounded length; line breaks become a visible mark. */
function reportLine(value, max = MAX_LINE_CHARS) {
  const text = redactReportText(value).replace(/\r?\n/gu, ' ⏎ ').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Indented code cannot be closed by its content, so log text stays literal.
const codeBlock = lines => lines.map(line => `    ${line}`).join('\n');
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const isoTime = (value) => {
  const date = new Date(value);
  return Number.isFinite(value) && !Number.isNaN(date.getTime()) ? date.toISOString() : 'unknown';
};
const seconds = ms => (Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 1000)}s` : 'unknown');
const code = (value, pattern = /^[A-Za-z0-9_.:-]{1,80}$/u) => (typeof value === 'string' && pattern.test(value) ? value : null);

// ── Input from the window ────────────────────────────────────────────────────

/** The description is the person's own words: kept whole, only bounded. */
export function validateBugReportDescription(value) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, error: 'The description must be text.' };
  if (value.length > BUG_REPORT_DESCRIPTION_MAX) {
    return { ok: false, error: `The description is too long (${value.length.toLocaleString('en-US')} characters; the limit is ${BUG_REPORT_DESCRIPTION_MAX.toLocaleString('en-US')}).` };
  }
  // eslint-disable-next-line no-control-regex
  return { ok: true, value: value.replace(/\r\n?/gu, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/gu, '').trim() };
}

const stringList = (value, max) => (Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-max) : []);

/** Keeps only the reviewed fields of what the window sent. */
export function normalizeBugReportPayload(payload) {
  const description = validateBugReportDescription(payload?.description);
  if (!description.ok) throw new TypeError(description.error);
  const renderer = payload?.renderer && typeof payload.renderer === 'object' ? payload.renderer : {};
  const size = value => (Number.isFinite(value) && value >= 0 && value < 100_000 ? Math.round(value) : null);
  return {
    description: description.value,
    renderer: {
      events: stringList(renderer.events, MAX_EVENT_LINES),
      eventsDropped: count(renderer.eventsDropped),
      screenMessages: stringList(renderer.screenMessages, MAX_SCREEN_MESSAGES),
      windowWidth: size(renderer.windowWidth),
      windowHeight: size(renderer.windowHeight),
      selectedIndex: Number.isSafeInteger(renderer.selectedIndex) && renderer.selectedIndex >= 0 ? renderer.selectedIndex : null,
      online: typeof renderer.online === 'boolean' ? renderer.online : null,
    },
  };
}

// ── Sections ─────────────────────────────────────────────────────────────────

function systemSection({ app, now }) {
  const safe = (read, fallback = 'unknown') => { try { return read() ?? fallback; } catch { return fallback; } };
  return [
    '## System',
    `- App: Interview Helper ${safe(() => app?.getVersion?.())} (${safe(() => app?.isPackaged, false) ? 'packaged' : 'from source'})`,
    `- Electron ${process.versions.electron || 'unknown'} · Chromium ${process.versions.chrome || 'unknown'} · Node ${process.versions.node}`,
    `- OS: ${process.platform} ${os.release()} · ${process.arch}`,
    `- Memory: ${Math.round(os.freemem() / 1048576)} MB free of ${Math.round(os.totalmem() / 1048576)} MB`,
    `- Generated: ${isoTime(now)} · time zone ${safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
    `- App running for ${seconds(now - PROCESS_STARTED_AT)}`,
  ].join('\n');
}

function windowSection({ renderer, windows }) {
  const lines = ['## Windows'];
  lines.push(`- Main window: ${renderer.windowWidth ?? '?'} × ${renderer.windowHeight ?? '?'} px${renderer.online === false ? ' · offline' : ''}`);
  for (const [label, open] of Object.entries(windows || {})) lines.push(`- ${label}: ${open ? 'open' : 'closed'}`);
  return lines.join('\n');
}

// States and counts only: a title, job link or file name never leaves the app.
export function interviewRows(state, selectedIndex = null) {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  return sessions.map((session, index) => {
    const data = session?.data && typeof session.data === 'object' ? session.data : {};
    const preparation = data.interviewHelperPreparation;
    const selected = selectedIndex === null ? session?.id === state?.selectedId : index === selectedIndex;
    return {
      index: index + 1,
      selected,
      named: typeof session?.title === 'string' && session.title.trim().length > 0,
      careerFiles: Array.isArray(data.interviewHelperCareerFilenames) ? data.interviewHelperCareerFilenames.length : 0,
      careerSnapshot: typeof data.interviewHelperCareerSnapshotId === 'string' && data.interviewHelperCareerSnapshotId.length > 0,
      job: data.interviewHelperTypedJob ? `typed (${code(data.interviewHelperTypedJobKind) || 'unknown kind'})`
        : data.interviewHelperApplicationBundle ? 'application folder'
          : data.interviewHelperJobUrl ? 'link only' : 'none',
      preparation: !preparation ? 'none' : code(preparation.status, /^[a-z-]{1,40}$/u) || 'saved',
      runPending: typeof data.interviewHelperPreparationRunId === 'string' && data.interviewHelperPreparationRunId.length > 0,
      step: count(data.interviewHelperCurrentStep),
    };
  });
}

function interviewsSection({ state, renderer }) {
  const rows = interviewRows(state, renderer.selectedIndex);
  const yes = value => (value ? 'yes' : 'no');
  return [
    '## Interviews',
    `- ${rows.length} saved · Applied Jobs folder ${state?.appliedJobsFolder ? 'chosen' : 'not chosen'}`,
    ...(rows.length ? [
      '',
      '| # | On screen | Named | Career files | Career text stored | Job | Preparation | Run id held | Step |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map(row => `| ${row.index} | ${yes(row.selected)} | ${yes(row.named)} | ${row.careerFiles} | ${yes(row.careerSnapshot)} | ${row.job} | ${row.preparation} | ${yes(row.runPending)} | ${row.step} |`),
    ] : []),
  ].join('\n');
}

function claudeSection({ status, activity, now }) {
  const lines = ['## Claude worker'];
  lines.push(`- ${status?.paused ? `Paused: ${code(status.pauseCode) || 'unknown reason'}` : 'Not paused'}`
    + `${status?.providerNotice ? ` · notice: ${reportLine(status.providerNotice, 200)}` : ''}`
    + `${status?.searchNotice ? ` · search notice: ${reportLine(status.searchNotice, 200)}` : ''}`);
  const tasks = Object.values(activity?.tasks || {});
  lines.push(`- Running ${count(activity?.running)} · waiting ${count(activity?.waiting)} · held keys ${Array.isArray(activity?.held) ? activity.held.length : 0} · accounts ${Array.isArray(activity?.claudeAccounts) ? activity.claudeAccounts.length : 'unknown'}`);
  for (const task of tasks.slice(0, 25)) {
    lines.push(`- ${code(task?.task) || 'task'} · ${code(task?.state) || 'unknown'} / ${code(task?.phase) || 'unknown'}`
      + ` · model ${code(task?.model) || 'default'}${code(task?.effort) ? ` (${task.effort})` : ''}`
      + ` · round ${count(task?.round)} · rejected ${count(task?.rejections)} · tool turns ${count(task?.toolTurns)}`
      + ` · started ${seconds(now - task?.firstStartedAt)} ago · in this phase ${seconds(now - task?.phaseStartedAt)}`
      + `${task?.failure?.code ? ` · last failure ${code(task.failure.code) || 'unknown'} (attempt ${count(task.failure.attempts)})` : ''}`);
    for (const step of (Array.isArray(task?.steps) ? task.steps : []).slice(-8)) {
      lines.push(`    - ${isoTime(step?.at)} ${reportLine(step?.label, 160)}`);
    }
  }
  if (tasks.length > 25) lines.push(`- ${tasks.length - 25} more task(s) not shown`);
  if (!tasks.length) lines.push('- No Claude task is queued or running.');
  return lines.join('\n');
}

function activeTasksSection({ tasks }) {
  const rows = Array.isArray(tasks) ? tasks : [];
  return [
    '## Requests still running in the app',
    ...(rows.length
      ? rows.slice(0, 40).map(row => `- ${count(row?.taskCount)} task(s) · oldest ${seconds(row?.oldestAgeMs)} · ${(Array.isArray(row?.channels) ? row.channels : []).map(channel => code(channel) || 'unknown').join(', ') || 'no channel recorded'}`)
      : ['- None.']),
  ].join('\n');
}

function handoffSection({ handoffs }) {
  const aggregate = handoffs?.aggregate && typeof handoffs.aggregate === 'object' ? handoffs.aggregate : null;
  if (!aggregate) return '## AI steps since the app started\n- Not recorded.';
  const numbers = Object.entries(aggregate).filter(([, value]) => Number.isFinite(value) && value !== 0);
  return [
    '## AI steps since the app started',
    numbers.length ? `- ${numbers.map(([key, value]) => `${key} ${value}`).join(' · ')}` : '- None issued.',
  ].join('\n');
}

function dataFolderSection({ entries }) {
  if (!Array.isArray(entries)) return '## Data folder\n- Could not be read.';
  return [
    '## Data folder',
    '> Names, kinds and sizes of the top level of the interview data folder. No file is opened.',
    ...(entries.length
      ? entries.slice(0, 60).map(entry => `- ${reportLine(entry.name, 120)} · ${entry.kind}${entry.kind === 'folder' ? ` · ${count(entry.children)} item(s)` : ` · ${count(entry.bytes).toLocaleString('en-US')} bytes`} · changed ${isoTime(entry.changedAt)}`)
      : ['- Empty.']),
  ].join('\n');
}

function screenSection({ renderer }) {
  return [
    '## Messages on screen',
    '> Status and error messages the main window showed when the report was made.',
    ...(renderer.screenMessages.length ? renderer.screenMessages.map(message => `- ${reportLine(message, 400)}`) : ['- None.']),
  ].join('\n');
}

function rendererEventsSection({ renderer }) {
  const lines = renderer.events.map(line => reportLine(line));
  return [
    `## Window events (${lines.length}${renderer.eventsDropped ? `, ${renderer.eventsDropped} older dropped` : ''})`,
    '> Oldest first: buttons pressed, errors and warnings in the main window since it opened.',
    lines.length ? codeBlock(lines) : '- None recorded.',
  ].join('\n');
}

function mainLogSection({ logs }) {
  const lines = (Array.isArray(logs) ? logs : [])
    .filter(entry => Number(entry?.ts) >= PROCESS_STARTED_AT - 60_000)
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .map(entry => `[${isoTime(Number(entry.ts))}] ${String(entry.level || '').toUpperCase().padEnd(5, ' ')} ${reportLine(entry.message, / failed: .* stack: /u.test(String(entry.message)) ? 1400 : MAX_LINE_CHARS)}`);
  return [
    `## App log (${lines.length} line${lines.length === 1 ? '' : 's'})`,
    '> Oldest first: the main process log of this run. Warnings and errors are kept longest.',
    lines.length ? codeBlock(lines) : '- Nothing logged.',
  ].join('\n');
}

/** Lists the top level of the data folder without opening any file. */
export async function listDataFolder(root) {
  const names = await fs.promises.readdir(root);
  const entries = await Promise.all(names.filter(name => !name.startsWith('.')).sort().map(async (name) => {
    try {
      const full = path.join(root, name);
      const stat = await fs.promises.stat(full);
      if (stat.isDirectory()) {
        let children = 0;
        try { children = (await fs.promises.readdir(full)).length; } catch { /* unreadable folder counts as empty */ }
        return { name, kind: 'folder', children, changedAt: stat.mtimeMs };
      }
      return { name, kind: 'file', bytes: stat.size, changedAt: stat.mtimeMs };
    } catch { return null; }
  }));
  return entries.filter(Boolean);
}

/**
 * The report text. `sources` holds one reader per section; a reader that
 * throws costs its own section only, since a report is usually made while
 * something is already wrong.
 */
export async function buildBugReportMarkdown({ payload, sources = {}, now = Date.now() } = {}) {
  const { description, renderer } = normalizeBugReportPayload(payload);
  const read = async (name) => (typeof sources[name] === 'function' ? sources[name]() : undefined);
  const section = async (title, build) => {
    try { return await build(); }
    catch (error) { return `## ${title}\n- This section could not be written: ${reportLine(error?.message || error, 200)}`; }
  };
  const parts = [
    '# Interview Helper bug report',
    `## Issue description\n${description || '_No description was given._'}`,
    await section('System', async () => systemSection({ app: await read('app'), now })),
    await section('Windows', async () => windowSection({ renderer, windows: await read('windows') })),
    await section('Interviews', async () => interviewsSection({ state: await read('sessions'), renderer })),
    await section('Claude worker', async () => claudeSection({ status: await read('claudeStatus'), activity: await read('claudeActivity'), now })),
    await section('Claude usage pauses', async () => String((await read('claudePauses')) || '').trim() || '## Claude usage pauses\n- Not recorded.'),
    await section('Requests still running in the app', async () => activeTasksSection({ tasks: await read('activeTasks') })),
    await section('AI steps since the app started', async () => handoffSection({ handoffs: await read('handoffs') })),
    await section('Data folder', async () => dataFolderSection({ entries: await read('dataFolder') })),
    await section('Messages on screen', async () => screenSection({ renderer })),
    await section('Window events', async () => rendererEventsSection({ renderer })),
    await section('App log', async () => mainLogSection({ logs: await read('logs') })),
  ];
  return `${parts.join('\n\n')}\n`;
}

// ── Saved reports ────────────────────────────────────────────────────────────

/** What goes on the clipboard: where the report is, and the typed description. */
export function buildBugReportPointer({ filePath, chars, lines, generatedAt, description } = {}) {
  const number = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : String(value));
  return `# Interview Helper bug report — saved to a file (not pasted inline)

Read the full report from this path:

\`${filePath}\`

- Size: ${number(chars)} chars · ${number(lines)} lines
- Generated: ${generatedAt}
- Kept across restarts; reports older than 7 days or beyond the ${BUG_REPORT_RETENTION} newest are removed.${description ? `\n\n## Issue description\n${description}` : ''}`;
}

export function createBugReportStore({ directory, now = () => Date.now() } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Bug reports need an absolute folder.');
  let pruning = Promise.resolve();

  async function pruneNow(keep = null) {
    let removed = 0;
    try {
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const stated = await Promise.all((await fs.promises.readdir(directory)).filter(name => REPORT_FILE_RE.test(name)).map(async (name) => {
        const filePath = path.join(directory, name);
        try { const stat = await fs.promises.stat(filePath); return stat.isFile() ? { filePath, changedAt: stat.mtimeMs } : null; }
        catch { return null; }
      }));
      const reports = stated.filter(Boolean).sort((a, b) => a.changedAt - b.changedAt || a.filePath.localeCompare(b.filePath));
      const at = now();
      const expired = reports.filter(report => at - report.changedAt > BUG_REPORT_MAX_AGE_MS);
      const fresh = reports.filter(report => at - report.changedAt <= BUG_REPORT_MAX_AGE_MS);
      // The report just written is never removed, even if its time ties with older ones.
      const extra = fresh.filter(report => report.filePath !== keep).slice(0, Math.max(0, fresh.length - BUG_REPORT_RETENTION));
      for (const { filePath } of [...expired, ...extra]) {
        if (filePath === keep) continue;
        try { await fs.promises.unlink(filePath); removed += 1; } catch { /* one stuck file does not stop the rest */ }
      }
      return { removed, error: null };
    } catch (error) { return { removed, error: error?.message || String(error) }; }
  }

  return Object.freeze({
    directory,
    /** Never rejects: a failed clean-up is reported, not thrown. */
    prune() { pruning = pruning.then(() => pruneNow()); return pruning; },
    async write(markdown) {
      await pruning;
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const base = `bug-report-${new Date(now()).toISOString().replace(/[:.]/gu, '-')}`;
      let filePath = null;
      for (let suffix = 1; !filePath; suffix += 1) {
        const candidate = path.join(directory, suffix === 1 ? `${base}.md` : `${base}-${suffix}.md`);
        // `wx` claims the name in one step, so two reports in one millisecond cannot overwrite each other.
        try { await fs.promises.writeFile(candidate, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); filePath = candidate; }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
      }
      await pruneNow(filePath);
      return { filePath, chars: markdown.length, lines: markdown.split('\n').length };
    },
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export function createBugReportService({ store, sources, clipboard, dialog, getWindow = () => null, desktopPath = () => os.homedir(), now = () => Date.now() } = {}) {
  const build = payload => buildBugReportMarkdown({ payload, sources, now: now() });
  return Object.freeze({
    /** Saves the report in the app's own folder and copies a pointer to it. */
    async copy(payload) {
      const markdown = await build(payload);
      const { description } = normalizeBugReportPayload(payload);
      try {
        const saved = await store.write(markdown);
        clipboard.writeText(buildBugReportPointer({ ...saved, generatedAt: new Date(now()).toISOString(), description }));
        return { delivery: 'file-pointer', savedPath: saved.filePath, chars: saved.chars, lines: saved.lines };
      } catch (error) {
        // The file could not be written: the person still gets the whole report to paste.
        clipboard.writeText(markdown);
        return { delivery: 'inline', saveError: error?.message || String(error), chars: markdown.length };
      }
    },
    /** Writes the report where the person chooses. */
    async save(payload) {
      const markdown = await build(payload);
      const stamp = new Date(now()).toISOString().replace(/[:.]/gu, '-');
      const options = {
        title: 'Save bug report',
        defaultPath: path.join(desktopPath(), `interview-helper-bug-report-${stamp}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      };
      const owner = getWindow();
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.promises.writeFile(result.filePath, markdown, 'utf8');
      return { canceled: false, savedPath: result.filePath, chars: markdown.length };
    },
  });
}

export function registerBugReportHandlers({ ipcMain, guarded, service } = {}) {
  const answer = run => async (payload) => {
    try { return { success: true, ...(await run(payload)) }; }
    catch (error) { return { success: false, error: error?.message || String(error) }; }
  };
  ipcMain.handle(BUG_REPORT_COPY_CHANNEL, guarded(answer(payload => service.copy(payload))));
  ipcMain.handle(BUG_REPORT_SAVE_CHANNEL, guarded(answer(payload => service.save(payload))));
}
