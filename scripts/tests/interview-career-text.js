import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import {
  careerDataFromCareerSnapshot, careerSnapshotStorageRoot, careerTextCandidateName, careerTextEvidence,
  careerTextSnapshotId, importCareerTextFiles, readPinnedCareerSnapshot, storeCareerText,
} from '../../electron/ipc/careerText.js';

const P = 'interview career text: ';
async function rejects(promise, pattern) {
  let error = null;
  try { await promise; } catch (caught) { error = caught; }
  assert(error && pattern.test(error.message), `expected a rejection matching ${pattern}, got ${error?.message}`);
}
const one = text => [{ name: 'career.md', text }];
async function temp(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-career-text-'));
  try { return await fn(await fs.promises.realpath(directory)); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}
const SAMPLE = [
  { name: 'resume.md', text: '# Sample Person\n\n## Experience\n\n### Platform Engineer, Acme Widgets (2020-2023)\n\n- Built the release tooling for internal teams.\n- Wrote the migration guide.\n\n**Projects**\n\nRan the weekly planning review.\n' },
  { name: 'notes.txt', text: 'I like small teams.' },
];

export default [
  { name: `${P}markdown headings become context and list items split into pieces`, run() {
    const items = careerTextEvidence(SAMPLE);
    const texts = items.map(item => item.text);
    assert(texts.includes('Experience\nPlatform Engineer, Acme Widgets (2020-2023)\nBuilt the release tooling for internal teams.'), 'a list item carries the two nearest headings above it, not the title');
    assert(!texts.some(text => text.includes('Sample Person\n')), 'only the two nearest headings are kept');
    assert(texts.some(text => text.endsWith('Wrote the migration guide.')), 'each list item is its own piece');
    assert(!texts.some(text => text.includes('Built the release tooling') && text.includes('Wrote the migration guide')), 'list items are not merged');
    assert(items.every((item, index) => item.id === `career-text-${String(index + 1).padStart(4, '0')}` && item.kind === 'career-text' && Array.isArray(item.evidenceSegmentIds)), 'ids are sequential');
    assert(items.find(item => item.text.endsWith('Built the release tooling for internal teams.')).label.startsWith('Platform Engineer'), 'the label is the nearest heading');
    assert(texts.includes('I like small teams.'), 'plain text without headings is one piece');
  } },
  { name: `${P}contact lines with an email, phone or URL are skipped and bold-only lines act as headings`, run() {
    const items = careerTextEvidence(one('Reach me at sample.person@example.test\n\n+1 (555) 010-0199\n\nhttps://example.test/sample\n\nLinkedIn: https://example.test/in/sample\n\n**Highlights**\n\nLed the quarterly audit.\n'));
    const texts = items.map(item => item.text);
    assert(texts.length === 1, `only the real sentence remains: ${JSON.stringify(texts)}`);
    assert(texts[0] === 'Highlights\nLed the quarterly audit.', 'a bold-only line is a heading of the paragraph after it');
  } },
  { name: `${P}very long input is packed under the 400-item cap`, run() {
    const lines = Array.from({ length: 900 }, (_, index) => `- Item number ${index + 1} describes a distinct task.`).join('\n');
    const items = careerTextEvidence(one(`## Long List\n\n${lines}\n`));
    assert(items.length <= 400 && items.length > 0, `got ${items.length}`);
    const joined = items.map(item => item.text).join('\n');
    assert(joined.includes('Item number 1 ') && joined.includes('Item number 900 '), 'packing keeps the first and last items');
    assert(items.every(item => item.text.length <= 300 + 2000 + 2), 'a packed piece stays within the item length bound');
  } },
  { name: `${P}candidate name: labelled, first line, and a role title yields nothing`, run() {
    assert(careerTextCandidateName(one('**Name:** Sample Person\n\nSenior Software Engineer')) === 'Sample Person', 'bold label');
    assert(careerTextCandidateName(one('Name: Sample Person\nOther')) === 'Sample Person', 'plain label');
    assert(careerTextCandidateName(one('# Sample Q. Person\n\nBuilder of things.')) === 'Sample Q. Person', 'first line heading');
    assert(careerTextCandidateName(one('Sample Person\nsample@example.test')) === 'Sample Person', 'first line');
    assert(careerTextCandidateName(one('Senior Software Engineer\n\nBuilt things.')) === '', 'a job title is not a name');
    assert(careerTextCandidateName(one('I like small teams.')) === '', 'a sentence is not a name');
    assert(careerTextCandidateName([]) === '' && careerTextCandidateName(undefined) === '', 'no sources give no name');
  } },
  { name: `${P}store and read round trip: same files give the same id and an edited file is refused`, async run() {
    await temp(async dir => {
      const first = await storeCareerText({ userDataPath: dir, sources: SAMPLE });
      const second = await storeCareerText({ userDataPath: dir, sources: structuredClone(SAMPLE) });
      assert(first.snapshotId === second.snapshotId && first.snapshotId === careerTextSnapshotId(SAMPLE), 'same files, same id');
      assert(first.snapshotId !== careerTextSnapshotId([SAMPLE[0]]), 'different files, different id');
      const root = careerSnapshotStorageRoot(dir);
      const loaded = await readPinnedCareerSnapshot(root, first.snapshotId);
      assert(loaded?.snapshotId === first.snapshotId && loaded.status === 'approved' && loaded.profile.identity.name === 'Sample Person', 'round trip');
      assert(JSON.stringify(loaded.profile.otherEvidence) === JSON.stringify(first.profile.otherEvidence), 'evidence is rebuilt identically');
      assert(JSON.stringify(loaded.sources) === JSON.stringify(SAMPLE), 'raw text is kept');
      const file = path.join(root, `${first.snapshotId}.json`);
      assert(((await fs.promises.stat(file)).mode & 0o077) === 0, 'private file');
      const saved = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      saved.sources[1].text = 'Edited after saving.';
      await fs.promises.writeFile(file, JSON.stringify(saved));
      assert(await readPinnedCareerSnapshot(root, first.snapshotId) === null, 'an edited stored file is not a snapshot');
      assert(await readPinnedCareerSnapshot(root, 'b'.repeat(64)) === null && await readPinnedCareerSnapshot(root, 'nope') === null, 'unknown or malformed ids read as null');
      assert(await readPinnedCareerSnapshot('relative/path', first.snapshotId) === null, 'a relative root reads as null');
    });
  } },
  { name: `${P}a compiled snapshot from before the split is still readable`, async run() {
    await temp(async dir => {
      const id = 'c'.repeat(64);
      const legacyDir = path.join(dir, 'career-snapshot-store', 'career-snapshots');
      await fs.promises.mkdir(legacyDir, { recursive: true });
      const profile = { identity: { name: 'Legacy Person' }, roles: [], achievements: [], projects: [], skills: [{ name: 'Welding' }], otherEvidence: [] };
      await fs.promises.writeFile(path.join(legacyDir, `${id}.json`), JSON.stringify({ snapshotId: id, status: 'approved', profile, sources: [{ name: 'old.md', text: 'Old career text.' }] }));
      const loaded = await readPinnedCareerSnapshot(careerSnapshotStorageRoot(dir), id);
      assert(loaded?.snapshotId === id && loaded.profile.identity.name === 'Legacy Person' && loaded.sources[0].text === 'Old career text.', 'the legacy file is returned');
      await fs.promises.writeFile(path.join(legacyDir, `${id}.json`), JSON.stringify({ snapshotId: id, status: 'draft', profile, sources: [] }));
      assert(await readPinnedCareerSnapshot(careerSnapshotStorageRoot(dir), id) === null, 'an unapproved legacy file is refused');
    });
  } },
  { name: `${P}career data text uses the FILE header per source`, run() {
    const text = careerDataFromCareerSnapshot({ sources: SAMPLE });
    assert(text.startsWith('===== FILE: resume.md =====\n# Sample Person') && text.includes('\n\n===== FILE: notes.txt =====\nI like small teams.'), text);
    let thrown = false; try { careerDataFromCareerSnapshot({}); } catch { thrown = true; }
    assert(thrown, 'a snapshot without sources is refused');
  } },
  { name: `${P}import accepts text files, refuses other types, symlinks, empty and non-UTF-8 files`, async run() {
    await temp(async dir => {
      const files = path.join(dir, 'files'); await fs.promises.mkdir(files);
      const write = (name, content) => { const file = path.join(files, name); return fs.promises.writeFile(file, content).then(() => file); };
      const md = await write('resume.md', '# Sample Person\n\n- Built the release tooling.\n');
      const txt = await write('notes.TXT', 'I like small teams.');
      const result = await importCareerTextFiles({ filePaths: [md, txt], userDataPath: dir });
      assert(result.fileCount === 2 && result.careerSnapshotId === result.fingerprint && result.pieceCount >= 2, JSON.stringify(result));
      const loaded = await readPinnedCareerSnapshot(careerSnapshotStorageRoot(dir), result.careerSnapshotId);
      assert(loaded.sources.map(source => source.name).join() === 'resume.md,notes.TXT', 'file names are kept');
      const pdf = await write('resume.pdf', 'text');
      await rejects(importCareerTextFiles({ filePaths: [pdf], userDataPath: dir }), /not a text file/u);
      const link = path.join(files, 'link.md'); await fs.promises.symlink(md, link);
      await rejects(importCareerTextFiles({ filePaths: [link], userDataPath: dir }), /plain file/u);
      await rejects(importCareerTextFiles({ filePaths: [await write('empty.md', '  \n')], userDataPath: dir }), /empty/u);
      await rejects(importCareerTextFiles({ filePaths: [await write('binary.md', Buffer.from([0xff, 0xfe, 0x41, 0xc3, 0x28]))], userDataPath: dir }), /not readable text/u);
      await rejects(importCareerTextFiles({ filePaths: [path.join(files, 'missing.md')], userDataPath: dir }), /could not be found/u);
      await rejects(importCareerTextFiles({ filePaths: ['relative.md'], userDataPath: dir }), /absolute path/u);
      await rejects(importCareerTextFiles({ filePaths: [], userDataPath: dir }), /Choose between/u);
      await rejects(importCareerTextFiles({ filePaths: [md], userDataPath: dir, isSensitivePath: () => true }), /cannot be used/u);
    });
  } },
  { name: `${P}import takes any extension inside an allowed private root and strips the converted .txt suffix`, async run() {
    await temp(async dir => {
      const converted = path.join(dir, 'conversions'); await fs.promises.mkdir(converted);
      const file = path.join(converted, 'resume.pdf.txt');
      await fs.promises.writeFile(file, 'Converted text from a document.');
      const other = path.join(converted, 'scan.docx');
      await fs.promises.writeFile(other, 'Allowed because it is inside the private root.');
      const result = await importCareerTextFiles({ filePaths: [file, other], userDataPath: dir, allowedPrivateRoots: [converted], isSensitivePath: () => true });
      const loaded = await readPinnedCareerSnapshot(careerSnapshotStorageRoot(dir), result.careerSnapshotId);
      assert(loaded.sources.map(source => source.name).join() === 'resume.pdf,scan.docx', JSON.stringify(loaded.sources.map(source => source.name)));
      await rejects(importCareerTextFiles({ filePaths: [file], userDataPath: dir, allowedPrivateRoots: [path.join(dir, 'elsewhere')], isSensitivePath: () => true }), /cannot be used/u);
    });
  } },
];
