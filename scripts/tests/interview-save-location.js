import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSaveLocationStore, saveDialogStartPath } from '../../electron/interviewApp/saveLocation.js';

async function temp(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-save-location-'));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

export default [
  {
    name: 'save location: the current save file is kept in its own file; a damaged or relative one is none',
    async run() {
      await temp(async (directory) => {
        const filePath = path.join(directory, 'nested', 'save-location.json');
        const store = createSaveLocationStore({ filePath });
        assert.equal(store.read(), null, 'no file yet');
        const saved = path.join(directory, 'My interviews.json');
        await store.write(saved);
        assert.equal(createSaveLocationStore({ filePath }).read(), saved);
        await store.write('relative.json');
        assert.equal(store.read(), saved, 'a path that is not absolute is not kept');
        await fs.promises.writeFile(filePath, JSON.stringify({ version: 1, path: 'relative.json' }));
        assert.equal(store.read(), null);
        await fs.promises.writeFile(filePath, '{not json');
        assert.equal(store.read(), null);
      });
    },
  },
  {
    name: 'save location: a dialog starts at the current save while its folder exists, else at the fallback',
    async run() {
      await temp(async (directory) => {
        const saved = path.join(directory, 'My interviews.json');
        assert.equal(saveDialogStartPath(saved, 'Dated.json'), saved, 'the file itself need not exist any more');
        assert.equal(saveDialogStartPath(path.join(directory, 'gone', 'My interviews.json'), 'Dated.json'), 'Dated.json');
        assert.equal(saveDialogStartPath(null, 'Dated.json'), 'Dated.json');
        assert.equal(saveDialogStartPath(null), null, 'Load has no fallback');
        assert.equal(saveDialogStartPath('relative.json'), null);
      });
    },
  },
  {
    name: 'save location: Save and Load both start at it and both record the file they used',
    async run() {
      const main = await fs.promises.readFile(new URL('../../electron/interviewApp/main.js', import.meta.url), 'utf8');
      assert.match(main, /showSaveDialog\(mainWindow, \{[^}]*defaultPath: saveDialogStartPath\(saveLocation\.read\(\), /su);
      assert.match(main, /const start = saveDialogStartPath\(saveLocation\.read\(\)\);\s+const result = await dialog\.showOpenDialog\(mainWindow, \{[^}]*defaultPath: start/su);
      assert.match(main, /await rememberSaveLocation\(result\.filePath\);/u);
      assert.match(main, /await rememberSaveLocation\(result\.filePaths\[0\]\);/u);
    },
  },
];
