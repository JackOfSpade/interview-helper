import React, { useEffect, useRef, useState } from 'react';
import { Clipboard, Save } from 'lucide-react';
import { eventLogSnapshot, logEvent, screenMessages } from '../utils/eventLog';

// Kept while the app is open, so closing the dialog does not lose what was typed.
const DRAFT_KEY = 'interview-helper-bug-report-draft';
const DESCRIPTION_MAX = 20_000;
const readDraft = () => { try { return sessionStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } };

/** What the window itself knows; the main process adds versions, states and logs. */
function rendererDetails(selectedIndex, dialogElement) {
  return {
    ...eventLogSnapshot(),
    screenMessages: screenMessages(document, dialogElement),
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    online: navigator.onLine,
  };
}

/** Mounted only while open, so each opening starts without the last result. */
export function BugReportDialog({ onClose, selectedIndex = -1 }) {
  const [description, setDescription] = useState(readDraft);
  const [busy, setBusy] = useState(null); // 'copy' | 'save'
  const [result, setResult] = useState(null); // { tone, text }
  const dialogRef = useRef(null);

  useEffect(() => { try { sessionStorage.setItem(DRAFT_KEY, description); } catch { /* storage unavailable */ } }, [description]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tooLong = description.length > DESCRIPTION_MAX;

  const submit = async (mode) => {
    if (busy || tooLong) return;
    setBusy(mode);
    setResult(null);
    try {
      const api = window.interviewAppAPI;
      const args = { description, renderer: rendererDetails(selectedIndex, dialogRef.current) };
      const response = await (mode === 'copy' ? api.copyBugReport(args) : api.saveBugReport(args));
      if (!response?.success) {
        setResult({ tone: 'error', text: response?.error || 'The report could not be made.' });
      } else if (mode === 'save') {
        if (!response.canceled) { setDescription(''); setResult({ tone: 'ok', text: `Saved to ${response.savedPath}.` }); }
      } else if (response.delivery === 'file-pointer') {
        setDescription('');
        setResult({ tone: 'ok', text: `Saved to ${response.savedPath}. Its path and your description are on the clipboard: paste them to your AI assistant, which reads the file from there.` });
      } else {
        setDescription('');
        setResult({ tone: 'warn', text: `The report file could not be saved (${response.saveError}), so the whole report was copied to the clipboard instead.` });
      }
    } catch (error) {
      logEvent('ERROR bug report:', error);
      setResult({ tone: 'error', text: error?.message || 'The report could not be made.' });
    } finally { setBusy(null); }
  };

  const tone = { ok: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100', warn: 'border-amber-400/30 bg-amber-500/10 text-amber-100', error: 'border-red-400/30 bg-red-500/10 text-red-100' };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="bug-report-title" className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-white/15 bg-[#1b1924] p-4 shadow-2xl" onSubmit={(event) => { event.preventDefault(); void submit('copy'); }}>
      <h2 id="bug-report-title" className="text-sm font-semibold text-white">Report a bug</h2>
      <div>
        <label htmlFor="bug-report-description" className="block text-[10px] font-semibold uppercase text-white/45">What went wrong? <span className="font-normal normal-case text-white/35">(optional)</span></label>
        <textarea id="bug-report-description" autoFocus className="mt-1 h-28 w-full resize-none rounded-md border border-white/15 bg-[#0f0e14] p-2 text-sm text-white placeholder:text-white/40 focus:border-violet-400/60 focus:outline-none" placeholder="What you did, what you expected, and what happened instead…" value={description} onChange={event => setDescription(event.target.value)} />
        {tooLong && <p className="mt-1 text-xs text-amber-300">The description is too long ({description.length.toLocaleString()} characters; the limit is {DESCRIPTION_MAX.toLocaleString()}).</p>}
      </div>
      <p className="text-[11px] leading-snug text-white/45">The report holds app versions, the state of each interview (no names, links or text), the Claude worker, messages on screen, buttons pressed, and recent errors and log lines. It does not hold your career text, questions, answers or recordings.</p>
      {result && <p role={result.tone === 'error' ? 'alert' : 'status'} className={`break-words rounded-md border px-2 py-1.5 text-xs ${tone[result.tone]}`}>{result.text}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="px-3 py-1.5 text-xs text-white/60 hover:text-white" onClick={onClose}>{result?.tone === 'ok' ? 'Done' : 'Cancel'}</button>
        <button type="button" disabled={Boolean(busy) || tooLong} className="flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 disabled:opacity-50" onClick={() => submit('save')}><Save size={13} />{busy === 'save' ? 'Saving…' : 'Save to file…'}</button>
        <button type="submit" disabled={Boolean(busy) || tooLong} title="Saves the full report to a file and copies its path, not the report text, to the clipboard." className="flex items-center gap-1.5 rounded-md bg-violet-500/30 px-3 py-1.5 text-xs text-violet-50 hover:bg-violet-500/40 disabled:opacity-50"><Clipboard size={13} />{busy === 'copy' ? 'Copying…' : 'Copy to clipboard'}</button>
      </div>
    </form>
  </div>;
}
