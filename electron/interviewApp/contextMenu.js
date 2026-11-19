// Right-click menu for every window this app opens.
//
// Electron shows no menu on a right-click unless the app builds one, so the
// red underline under a misspelled word had no way to be acted on. This menu
// offers the spelling corrections for the word under the pointer, then the
// usual Cut, Copy and Paste. It names nothing about the app, so it reads the
// same in the call window as in any other.

const MAX_SUGGESTIONS = 6;

/**
 * The menu for one right-click, or an empty list when there is nothing to offer.
 * `params` is what Electron's `context-menu` event reports.
 */
export function contextMenuTemplate(params, { replaceMisspelling, learnSpelling } = {}) {
  const editable = !!params?.isEditable;
  const hasSelection = typeof params?.selectionText === 'string' && params.selectionText.trim().length > 0;
  const word = typeof params?.misspelledWord === 'string' ? params.misspelledWord : '';
  const items = [];
  if (editable && word) {
    const suggestions = (Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : []).slice(0, MAX_SUGGESTIONS);
    if (suggestions.length) for (const suggestion of suggestions) items.push({ label: suggestion, click: () => replaceMisspelling?.(suggestion) });
    else items.push({ label: 'No Guesses Found', enabled: false });
    items.push({ type: 'separator' }, { label: 'Learn Spelling', click: () => learnSpelling?.(word) }, { type: 'separator' });
  }
  if (editable) {
    const can = params.editFlags || {};
    items.push(
      { role: 'cut', enabled: can.canCut !== false && hasSelection },
      { role: 'copy', enabled: can.canCopy !== false && hasSelection },
      { role: 'paste', enabled: can.canPaste !== false },
      { type: 'separator' },
      { role: 'selectAll', enabled: can.canSelectAll !== false },
    );
  } else if (hasSelection) {
    items.push({ role: 'copy' });
  }
  return items;
}

/** Show the menu on right-click in `contents`. */
export function attachContextMenu(contents, { Menu, BrowserWindow, logger } = {}) {
  contents.on('context-menu', (_event, params) => {
    try {
      const template = contextMenuTemplate(params, {
        replaceMisspelling: suggestion => { try { contents.replaceMisspelling(suggestion); } catch { /* the page went away */ } },
        learnSpelling: word => { try { contents.session.addWordToSpellCheckerDictionary(word); } catch { /* the page went away */ } },
      });
      if (!template.length) return;
      Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) || undefined });
    } catch (error) { logger?.warn?.(`[InterviewApp] right-click menu was not shown: ${error?.message || error}`); }
  });
}
