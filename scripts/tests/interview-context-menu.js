// Right-click menu: spelling corrections for a misspelled word, then the usual edit items.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachContextMenu, contextMenuTemplate } from '../../electron/interviewApp/contextMenu.js';

const labels = items => items.map(item => item.label || item.role || item.type);

export default [
  {
    name: 'context menu: a misspelled word in a text box offers its corrections, then the edit items',
    run() {
      const replaced = []; const learned = [];
      const items = contextMenuTemplate(
        { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], selectionText: 'teh', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } },
        { replaceMisspelling: word => replaced.push(word), learnSpelling: word => learned.push(word) },
      );
      assert.deepEqual(labels(items), ['the', 'ten', 'separator', 'Learn Spelling', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
      items[0].click(); items[3].click();
      assert.deepEqual(replaced, ['the']);
      assert.deepEqual(learned, ['teh']);
    },
  },
  {
    name: 'context menu: a word with no corrections says so, and the list of corrections is kept short',
    run() {
      const none = contextMenuTemplate({ isEditable: true, misspelledWord: 'zxqv', dictionarySuggestions: [] });
      assert.deepEqual(none[0], { label: 'No Guesses Found', enabled: false });
      const many = contextMenuTemplate({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
      assert.equal(many.findIndex(item => item.type === 'separator'), 6);
    },
  },
  {
    name: 'context menu: correctly spelled text gets the edit items only; plain page text gets Copy only when selected',
    run() {
      const box = contextMenuTemplate({ isEditable: true, misspelledWord: '', selectionText: '', editFlags: { canPaste: true } });
      assert.deepEqual(labels(box), ['cut', 'copy', 'paste', 'separator', 'selectAll']);
      assert.equal(box[0].enabled, false);
      assert.equal(box[2].enabled, true);
      assert.deepEqual(labels(contextMenuTemplate({ isEditable: false, selectionText: 'hello' })), ['copy']);
      assert.deepEqual(contextMenuTemplate({ isEditable: false, selectionText: '', misspelledWord: 'teh' }), []);
    },
  },
  {
    name: 'context menu: a right-click pops the menu up in its own window and a correction replaces the word',
    run() {
      const replaced = []; const learned = []; const popups = [];
      const contents = Object.assign(new EventEmitter(), {
        replaceMisspelling: word => replaced.push(word),
        session: { addWordToSpellCheckerDictionary: word => learned.push(word) },
      });
      const win = {};
      let built = null;
      attachContextMenu(contents, {
        Menu: { buildFromTemplate: (template) => { built = template; return { popup: options => popups.push(options) }; } },
        BrowserWindow: { fromWebContents: () => win },
      });
      contents.emit('context-menu', {}, { isEditable: false, selectionText: '' });
      assert.equal(popups.length, 0);
      contents.emit('context-menu', {}, { isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive'] });
      assert.equal(popups.length, 1);
      assert.equal(popups[0].window, win);
      built[0].click(); built.find(item => item.label === 'Learn Spelling').click();
      assert.deepEqual(replaced, ['receive']);
      assert.deepEqual(learned, ['recieve']);
    },
  },
];
