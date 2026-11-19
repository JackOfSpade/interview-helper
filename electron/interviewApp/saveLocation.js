// The file File > Save Interviews… last wrote, or Load Interviews… last read.
// Both dialogs open on it, so the person does not browse to the same folder each time.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomicWrite.js';

const MAX_PATH = 4096;
const savedPath = value => (typeof value === 'string' && value.length <= MAX_PATH && path.isAbsolute(value) ? value : null);

/** Kept in its own file in the profile folder; a missing or damaged file means "none yet". */
export function createSaveLocationStore({ filePath, fsApi = fs } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('The save location needs a file path.');
  return Object.freeze({
    read() {
      try { return savedPath(JSON.parse(fsApi.readFileSync(filePath, 'utf8'))?.path); }
      catch { return null; }
    },
    async write(value) {
      if (!savedPath(value)) return;
      await atomicWriteFile(filePath, `${JSON.stringify({ version: 1, path: value })}\n`, { mkdir: true });
    },
  });
}

/**
 * Where a Save or Load dialog starts: the current save file while its folder still
 * exists, else `fallback` (a file name for Save, nothing for Load).
 */
export function saveDialogStartPath(current, fallback = null, { fsApi = fs } = {}) {
  const file = savedPath(current);
  if (file) {
    try { if (fsApi.statSync(path.dirname(file)).isDirectory()) return file; } catch { /* the folder is gone */ }
  }
  return fallback || null;
}
