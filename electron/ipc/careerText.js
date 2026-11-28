/**
 * Career data as plain text.
 *
 * The app keeps the text of the career files exactly as it was read (after any
 * conversion to text) and never compiles it into a structured profile. A saved
 * set of files is a "career snapshot": one private JSON file named by the
 * SHA-256 of its file names and text.
 *
 * Everything that needs career data reads it through readPinnedCareerSnapshot:
 * - the answer writer gets `profile.otherEvidence`, one item per paragraph or
 *   list item, each carrying the headings it sits under so it reads on its own;
 * - practice interviewers get the whole text (careerDataFromCareerSnapshot);
 * - the practice call greets the candidate by `profile.identity.name`.
 *
 * Snapshots compiled by Infinite Canvas before the apps were split are still
 * readable from `career-snapshot-store/career-snapshots`, so an interview
 * prepared then keeps working.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomicWrite.js';
import { sha256Hex } from '../utils/sha256Hex.js';

export const CAREER_TEXT_DIR = 'career-text';
const LEGACY_SNAPSHOT_DIR = path.join('career-snapshot-store', 'career-snapshots');
const SNAPSHOT_ID = /^[a-f0-9]{64}$/u;
const SNAPSHOT_VERSION = 1;
export const CAREER_TEXT_MAX_FILES = 50;
export const CAREER_TEXT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;
const MAX_NAME_CHARS = 180;
// The answer writer accepts at most 600 evidence items; research facts need room too.
const MAX_ITEMS = 400;
const MAX_ITEM_CHARS = 2000;
const MAX_CONTEXT_CHARS = 300;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function careerSnapshotStorageRoot(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new TypeError('Career text storage needs the application data folder.');
  return path.join(userDataPath, CAREER_TEXT_DIR);
}

function cleanSources(sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > CAREER_TEXT_MAX_FILES) throw new TypeError(`Career data needs between 1 and ${CAREER_TEXT_MAX_FILES} files.`);
  return sources.map((source, index) => {
    const name = typeof source?.name === 'string' ? source.name.trim() : '';
    const text = typeof source?.text === 'string' ? source.text.replace(/\r\n?/gu, '\n') : '';
    if (!name || name.length > MAX_NAME_CHARS || /[\p{Cc}\p{Cf}]/u.test(name)) throw new TypeError(`Career file ${index + 1} needs a plain file name.`);
    if (!text.trim()) throw new TypeError(`${name} has no text.`);
    if (Buffer.byteLength(text, 'utf8') > CAREER_TEXT_MAX_FILE_BYTES) throw new TypeError(`${name} is larger than 2 MB of text.`);
    return { name, text };
  });
}

export function careerTextSnapshotId(sources) {
  return sha256Hex(JSON.stringify({ kind: 'career-text', version: SNAPSHOT_VERSION, sources: cleanSources(sources).map(({ name, text }) => [name, text]) }));
}

// ------------------------------------------------------------- evidence --

const stripMarks = line => line.replace(/\*\*|__/gu, '').replace(/`/gu, '').trim();
const HEADING = /^(#{1,6})\s+(.*\S)\s*#*$/u;
const BOLD_LINE = /^(?:\*\*|__)([^*_].*?)(?:\*\*|__):?$/u;
const LIST_ITEM = /^\s*(?:[-*+•‣◦▪]|\d{1,3}[.)])\s+(.*)$/u;
const RULE = /^\s*(?:[-*_=]\s*){3,}$/u;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/u;
const URL_ONLY = /^\s*(?:[\w ]{0,20}:\s*)?(?:https?:\/\/|www\.)\S+\s*$/iu;
// A line that only gives a way to reach the person is not something to say in an answer.
const isContactLine = line => EMAIL.test(line) || URL_ONLY.test(line) || (PHONE.test(line) && line.replace(/[^\p{L}]/gu, '').length < 24);
const safeText = value => value.replace(/[^\P{Cc}\t\n]/gu, ' ').replace(/\p{Cf}/gu, '');

/**
 * Splits career text into pieces a spoken answer can cite: one per list item or
 * paragraph. Each piece starts with the headings above it (for a job, usually
 * its title, employer and dates), so it names its own role without help.
 */
export function careerTextEvidence(sources) {
  const items = [];
  for (const [sourceIndex, source] of cleanSources(sources).entries()) {
    const headings = [];
    let paragraph = [];
    const context = () => headings.map(item => item.text).filter(Boolean).slice(-2);
    const push = (body) => {
      const text = stripMarks(body.join(' ').replace(/\s+/gu, ' '));
      if (text.length < 3 || isContactLine(text)) return;
      const above = context();
      let prefix = above.join('\n');
      if (prefix.length > MAX_CONTEXT_CHARS) prefix = above.at(-1).slice(0, MAX_CONTEXT_CHARS);
      items.push({ source: sourceIndex, name: source.name, context: prefix, body: text.slice(0, MAX_ITEM_CHARS) });
    };
    const flush = () => { if (paragraph.length) { push(paragraph); paragraph = []; } };
    for (const raw of safeText(source.text).split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim() || RULE.test(line)) { flush(); continue; }
      const heading = HEADING.exec(line.trim());
      const bold = heading ? null : BOLD_LINE.exec(line.trim());
      if (heading || (bold && !/:\s*\S/u.test(stripMarks(line)))) {
        flush();
        const level = heading ? heading[1].length : 7;
        while (headings.length && headings.at(-1).level >= level) headings.pop();
        const text = stripMarks(heading ? heading[2] : bold[1]);
        if (text && !isContactLine(text)) headings.push({ level, text });
        continue;
      }
      const listItem = LIST_ITEM.exec(line);
      if (listItem) { flush(); paragraph = [listItem[1]]; continue; }
      // An indented line continues the list item or paragraph above it.
      paragraph.push(line.trim());
    }
    flush();
  }
  // A very long document: join neighbours under the same headings until it fits.
  let packed = items;
  while (packed.length > MAX_ITEMS) {
    const next = [];
    for (const item of packed) {
      const last = next.at(-1);
      if (last && !last.joined && last.source === item.source && last.context === item.context && last.body.length + item.body.length + 1 <= MAX_ITEM_CHARS) {
        last.body = `${last.body}\n${item.body}`; last.joined = true;
      } else next.push({ ...item, joined: false });
    }
    if (next.length === packed.length) { packed = next.slice(0, MAX_ITEMS); break; }
    packed = next;
  }
  return packed.map((item, index) => ({
    id: `career-text-${String(index + 1).padStart(4, '0')}`,
    kind: 'career-text',
    label: (item.context.split('\n').at(-1) || item.name).slice(0, 200),
    text: item.context ? `${item.context}\n${item.body}` : item.body,
    evidenceSegmentIds: [],
  }));
}

/** The person's name when the text states it plainly near the top; otherwise ''. */
export function careerTextCandidateName(sources) {
  for (const source of Array.isArray(sources) ? sources : []) {
    const lines = String(source?.text || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean).slice(0, 12);
    for (const line of lines) {
      const labelled = /^(?:\*\*|__)?\s*(?:full\s+)?name\s*:?\s*(?:\*\*|__)?\s*:?\s*(.+)$/iu.exec(line);
      if (labelled) { const name = stripMarks(labelled[1]); if (looksLikeName(name)) return name; }
    }
    const first = stripMarks((lines[0] || '').replace(/^#{1,6}\s+/u, ''));
    if (looksLikeName(first)) return first;
  }
  return '';
}
function looksLikeName(value) {
  const words = value.split(/\s+/u).filter(Boolean);
  return words.length >= 2 && words.length <= 4 && value.length <= 60
    && words.every(word => /^\p{Lu}[\p{L}'’.-]*$/u.test(word))
    && !/\b(?:resume|résumé|curriculum|vitae|experience|summary|profile|education|skills|engineer|developer|manager)\b/iu.test(value);
}

function snapshotFrom(snapshotId, sources) {
  return {
    snapshotId, schemaVersion: SNAPSHOT_VERSION, status: 'approved', kind: 'career-text', sources,
    profile: {
      identity: { name: careerTextCandidateName(sources) },
      roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [],
      otherEvidence: careerTextEvidence(sources),
    },
  };
}

// --------------------------------------------------------------- storage --

async function privateDirectory(directory, { create }) {
  if (create) await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe career text folder.');
  return directory;
}

async function readPrivateJson(file, limit) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    return JSON.parse(await handle.readFile('utf8'));
  } catch { return null; } finally { await handle.close(); }
}

/** Saves the text of the career files and returns their snapshot. Saving the same files twice is a no-op. */
export async function storeCareerText({ userDataPath, sources } = {}) {
  const clean = cleanSources(sources);
  const snapshotId = careerTextSnapshotId(clean);
  const root = await privateDirectory(careerSnapshotStorageRoot(userDataPath), { create: true });
  const target = path.join(root, `${snapshotId}.json`);
  const body = JSON.stringify({ version: SNAPSHOT_VERSION, kind: 'career-text', snapshotId, sources: clean });
  await atomicWriteFile(target, body);
  return snapshotFrom(snapshotId, clean);
}

/** A snapshot compiled by Infinite Canvas before the split: kept readable, never written. */
function legacySnapshot(snapshotId, saved) {
  if (!isObject(saved) || saved.snapshotId !== snapshotId || saved.status !== 'approved' || !isObject(saved.profile) || !Array.isArray(saved.sources)) return null;
  const sources = saved.sources.filter(isObject).map(source => ({
    name: typeof source.name === 'string' ? source.name : 'career file',
    text: typeof source.legacyText === 'string' ? source.legacyText : typeof source.text === 'string' ? source.text : '',
  })).filter(source => source.text);
  return { ...saved, kind: 'compiled', sources };
}

/**
 * Reads one saved snapshot, or null when there is none. `root` is
 * careerSnapshotStorageRoot(userDataPath); the older compiled store beside it is the fallback.
 */
export async function readPinnedCareerSnapshot(root, snapshotId) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) return null;
  const saved = await readPrivateJson(path.join(root, `${snapshotId}.json`), MAX_SNAPSHOT_BYTES);
  if (isObject(saved) && saved.kind === 'career-text' && saved.snapshotId === snapshotId) {
    try {
      const sources = cleanSources(saved.sources);
      if (careerTextSnapshotId(sources) === snapshotId) return snapshotFrom(snapshotId, sources);
    } catch { /* an edited or damaged file is not a snapshot */ }
    return null;
  }
  const legacy = await readPrivateJson(path.join(path.dirname(root), LEGACY_SNAPSHOT_DIR, `${snapshotId}.json`), MAX_SNAPSHOT_BYTES);
  return legacySnapshot(snapshotId, legacy);
}

/** The whole career text, each file under a `===== FILE: name =====` line. */
export function careerDataFromCareerSnapshot(snapshot) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.sources)) throw new TypeError('A career snapshot with its files is required.');
  return snapshot.sources.map(source => `===== FILE: ${source.name} =====\n${source.text}`).join('\n\n');
}

/** Skills of an older compiled snapshot that it marked safe to name; plain text has none. */
export function vettedCareerSkillInventory(profile) {
  const seen = new Set();
  return (Array.isArray(profile?.skills) ? profile.skills : []).filter(skill => {
    const key = typeof skill?.name === 'string' ? skill.name.trim().toLowerCase() : '';
    if (!key || seen.has(key) || skill.indexEligible === false) return false;
    seen.add(key);
    return true;
  });
}

// ----------------------------------------------------------------- import --

/**
 * Reads the chosen text files and saves them as one snapshot.
 * `allowedPrivateRoots` are folders of this app whose files may be named (the
 * converted-text folder); `isSensitivePath` refuses anything else that is private.
 */
export async function importCareerTextFiles({ filePaths, userDataPath, allowedPrivateRoots = [], isSensitivePath = () => false, signal } = {}) {
  if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > CAREER_TEXT_MAX_FILES) throw new Error(`Choose between 1 and ${CAREER_TEXT_MAX_FILES} career files.`);
  const sources = [];
  for (const filePath of filePaths) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Career import was cancelled.');
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('Each career file needs an absolute path.');
    const resolved = path.resolve(filePath);
    const name = path.basename(resolved);
    const allowed = allowedPrivateRoots.some(root => typeof root === 'string' && resolved.startsWith(`${path.resolve(root)}${path.sep}`));
    if (!allowed && isSensitivePath(resolved)) throw new Error(`${name} cannot be used as career data.`);
    if (!allowed && !/\.(?:txt|md)$/iu.test(name)) throw new Error(`${name} is not a text file. Drop it on the window so it is converted first.`);
    let stat;
    try { stat = await fs.promises.lstat(resolved); } catch { throw new Error(`${name} could not be found.`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} is not a plain file.`);
    if (stat.size > CAREER_TEXT_MAX_FILE_BYTES) throw new Error(`${name} is larger than 2 MB.`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.promises.readFile(resolved)); } catch { throw new Error(`${name} is not readable text.`); }
    if (!text.trim()) throw new Error(`${name} is empty.`);
    // A converted file is stored as `resume.pdf.txt`; show the name the person chose.
    sources.push({ name: (allowed ? name.replace(/\.txt$/iu, '') : name).slice(0, MAX_NAME_CHARS), text: (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text) });
  }
  const snapshot = await storeCareerText({ userDataPath, sources });
  return { careerSnapshotId: snapshot.snapshotId, fingerprint: snapshot.snapshotId, fileCount: sources.length, pieceCount: snapshot.profile.otherEvidence.length };
}

/** Registers `parse-career-data`: the renderer's "use these career files" call. It involves no AI. */
export function registerCareerTextHandlers({ handleSafe, userDataPath, allowedPrivateRoots = () => [], isSensitivePath } = {}) {
  if (typeof handleSafe !== 'function' || typeof userDataPath !== 'function') throw new TypeError('Career text IPC registration is unavailable.');
  handleSafe('parse-career-data', async (_event, args, signal) => {
    const result = await importCareerTextFiles({ filePaths: args?.filePaths, userDataPath: userDataPath(), allowedPrivateRoots: allowedPrivateRoots(), isSensitivePath, signal });
    return { success: true, ...result };
  });
}
