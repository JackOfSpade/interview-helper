import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bug, Plus, Settings, Trash2 } from 'lucide-react';
import './interviewApp.css';
import { InterviewHelperPanel } from './InterviewHelperPanel';
import { BugReportDialog } from './BugReportDialog';
import { TextSizeControl } from './TextSizeControl';
import { SettingsDialog } from './SettingsDialog';
import { installEventCapture, logEvent } from '../utils/eventLog';
import { ClaudePauseNotice } from '../components/ClaudePauseNotice';
import { JobRunStatusSection } from '../components/ClaudeRunStatus';
import { generateId } from '../utils/idGenerator';
import { addInterview, interviewRunIds, interviewTitle, patchInterview, removeInterview, renameInterview } from './sessions';

const EMPTY_STATE = Object.freeze({ version: 1, sessions: [], selectedId: null, appliedJobsFolder: null });
// Every interview stays mounted (hidden when not selected) so one that is still
// preparing keeps its running state while another is on screen.
function InterviewHost({ session, visible, commit, appliedJobsFolder, onChooseAppliedJobsFolder }) {
  const { id } = session;
  const onPatch = useCallback((patch) => { commit(current => patchInterview(current, id, patch)); return true; }, [commit, id]);
  return <div hidden={!visible} className={visible ? 'lg:flex lg:h-full lg:min-h-0 lg:flex-col' : ''}>
    <div className="shrink-0 px-4 pt-4"><label className="block text-[10px] font-semibold uppercase text-white/45" htmlFor={`interview-name-${id}`}>Interview name</label>
      <input id={`interview-name-${id}`} className="mt-1 w-full max-w-md rounded-md border border-white/15 bg-[#0f0e14] px-2 py-1.5 text-sm text-white placeholder:text-white/40" value={session.title} placeholder={interviewTitle({ ...session, title: '' })} onChange={event => commit(current => renameInterview(current, id, event.target.value))} /></div>
    <div className="lg:min-h-0 lg:flex-1"><InterviewHelperPanel id={id} data={session.data} onPatch={onPatch} appliedJobsFolder={appliedJobsFolder} onChooseAppliedJobsFolder={onChooseAppliedJobsFolder} /></div>
  </div>;
}

export default function InterviewHelperApp() {
  const [state, setState] = useState(EMPTY_STATE);
  const [status, setStatus] = useState(() => (typeof window.interviewAppAPI?.loadState === 'function' ? 'loading' : 'error'));
  const [notice, setNotice] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [reportingBug, setReportingBug] = useState(false);
  const closeBugReport = useCallback(() => setReportingBug(false), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  // Settings… on the App menu (⌘,) opens the same dialog.
  useEffect(() => window.interviewAppAPI?.onOpenSettings?.(() => setSettingsOpen(true)), []);
  const stateRef = useRef(EMPTY_STATE);
  const writeQueue = useRef(Promise.resolve());

  // Bug reports include what happened in this window; see utils/eventLog.js.
  useEffect(() => installEventCapture(window), []);
  useEffect(() => { if (notice) logEvent('notice shown:', notice); }, [notice]);

  useEffect(() => {
    let disposed = false;
    const api = window.interviewAppAPI;
    if (typeof api?.loadState !== 'function') return undefined;
    api.loadState().then((loaded) => {
      if (disposed) return;
      stateRef.current = { ...EMPTY_STATE, ...loaded };
      setState(stateRef.current);
      setStatus('ready');
    }).catch((error) => { if (!disposed) { setNotice(error?.message || 'Your saved interviews could not be read.'); setStatus('error'); } });
    return () => { disposed = true; };
  }, []);

  // Every change is written in order; there is no separate Save. A queued write sends the newest
  // state, so a burst of keystrokes ends in the last text rather than replaying every step.
  const commit = useCallback((update) => {
    const next = update(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    writeQueue.current = writeQueue.current.then(() => window.interviewAppAPI.saveState(stateRef.current)).catch(() => {
      setNotice('The last change could not be saved to disk. It is kept in this window; change something again to retry.');
    });
  }, []);

  // Closing the window or quitting the app: the main process asks for the newest state and waits.
  // A field that saves when it loses focus is given the chance first, and the write skips the queue,
  // which may still be waiting on an earlier one.
  useEffect(() => {
    const api = window.interviewAppAPI;
    if (typeof api?.onSaveStateNow !== 'function') return undefined;
    return api.onSaveStateNow(async () => {
      try {
        window.document.activeElement?.blur?.();
        await new Promise(resolve => setTimeout(resolve, 0));
        await api.saveState(stateRef.current);
      } catch { /* the main process still writes what it already has */ }
      finally { api.stateSavedNow?.(); }
    });
  }, []);

  // The interview list as a file the person keeps, and back from one.
  const saveToFile = async () => {
    setNotice(null);
    try {
      await writeQueue.current;
      const result = await window.interviewAppAPI.saveStateToFile();
      if (result?.saved) setNotice(`Saved your interviews to "${result.fileName}". Q&A, career data and recordings stay in the app.`);
    } catch (error) { setNotice(error?.message || 'Your interviews could not be saved to that file.'); }
  };
  const loadFromFile = async () => {
    setNotice(null);
    try {
      await writeQueue.current;
      const result = await window.interviewAppAPI.loadStateFromFile();
      if (!result?.state) return;
      stateRef.current = { ...EMPTY_STATE, ...result.state };
      setState(stateRef.current);
      setNotice(`Loaded ${result.state.sessions.length} interview${result.state.sessions.length === 1 ? '' : 's'} from the file. The list from before is kept as a backup in the app's data folder.`);
    } catch (error) { setNotice(error?.message || 'That file could not be loaded.'); }
  };

  // Save and Load live in the File menu. The newest handlers are reached through a ref, so the
  // menu listener is attached once.
  const fileCommands = useRef({});
  useEffect(() => { fileCommands.current = { save: saveToFile, load: loadFromFile }; });
  useEffect(() => window.interviewAppAPI?.onFileCommand?.((command) => { if (status === 'ready') void fileCommands.current[command]?.(); }), [status]);

  // A step that Claude could not finish on its own would wait here for a
  // pasted answer; this app has no paste box, so end it and let Retry restart it.
  useEffect(() => {
    const api = window.electronAPI;
    if (typeof api?.onNonApiAiRequest !== 'function') return undefined;
    const unsubscribe = api.onNonApiAiRequest((request) => {
      if (!request?.requestId || (request.workerOwned && !request.workerEscalation)) return;
      void api.cancelNonApiAiRequest?.(request.requestId);
      setNotice('Claude could not finish that step after several tries, so it was stopped. Use Retry in the interview to run it again.');
    });
    void api.replayPendingNonApiAiRequests?.();
    return unsubscribe;
  }, []);

  const selected = state.sessions.find(session => session.id === state.selectedId) || null;
  const selectedId = selected?.id || null;

  const newInterview = () => commit(current => addInterview(current, { id: generateId() }));
  const chooseFolder = useCallback(async () => {
    try {
      const folder = await window.interviewAppAPI.chooseAppliedJobsFolder();
      if (folder) commit(current => ({ ...current, appliedJobsFolder: folder }));
    } catch (error) { setNotice(error?.message || 'The Applied Jobs folder could not be chosen.'); }
  }, [commit]);
  const deleteInterview = async (session) => {
    if (deleting) return;
    if (!window.confirm(`Delete "${interviewTitle(session)}" from this list? Its saved Q&A and practice recordings stay on disk.`)) return;
    setDeleting(session.id);
    try {
      // Stop anything still running for it before it leaves the list.
      const runIds = interviewRunIds(session.data);
      await window.electronAPI?.cancelNodeTaskAndWait?.(session.id, 'node-deleted', runIds);
      window.electronAPI?.cancelNodeTask?.(session.id, 'node-deleted', runIds);
      if (runIds.length) await window.electronAPI?.completeNonApiAiRuns?.(runIds);
      commit(current => removeInterview(current, session.id));
    } catch { setNotice('That interview is still finishing a task. Try deleting it again in a moment.'); }
    finally { setDeleting(null); }
  };

  if (status === 'loading') return <main role="status" className="min-h-screen bg-[#111018] p-4 text-sm text-violet-100">Loading your interviews…</main>;
  if (status === 'error') return <main role="alert" className="min-h-screen bg-[#111018] p-4 text-sm text-red-200">{notice || 'Interview Helper could not start in this window.'}</main>;

  return <div className="flex h-full bg-[#111018] text-white">
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-[#16141c]" aria-label="Interviews">
      {/* The window's title bar already names the app, so the heading is for screen readers only. */}<h1 className="sr-only">Interview Helper</h1>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2" role="listbox" aria-label="Interviews">
        {state.sessions.map(session => <li key={session.id} role="option" aria-selected={session.id === selectedId} className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs ${session.id === selectedId ? 'bg-violet-500/20 text-white' : 'text-white/70 hover:bg-white/5'}`}>
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => commit(current => ({ ...current, selectedId: session.id }))}>{interviewTitle(session)}</button>
          <button type="button" aria-label={`Delete ${interviewTitle(session)}`} className="shrink-0 text-white/30 hover:text-red-300 disabled:opacity-40" onClick={() => deleteInterview(session)} disabled={deleting === session.id}><Trash2 size={13} /></button>
        </li>)}
        {!state.sessions.length && <li className="p-2 text-xs text-white/50">No interviews yet.</li>}
      </ul>
      <div className="space-y-1 border-t border-white/10 p-2">
        <button type="button" className="flex w-full items-center gap-1.5 rounded-md bg-violet-500/20 px-2 py-1.5 text-xs text-violet-100 hover:bg-violet-500/30" onClick={newInterview}><Plus size={13} />New interview</button>
        <button type="button" className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-white/60 hover:bg-white/5" onClick={() => setReportingBug(true)}><Bug size={13} />Report a bug…</button>
        <button type="button" className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-white/60 hover:bg-white/5" onClick={() => setSettingsOpen(true)}><Settings size={13} />Settings…</button>
        <TextSizeControl onError={setNotice} />
      </div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      {(notice) && <p role="status" className="flex items-start gap-2 border-b border-amber-400/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-100"><span className="flex-1">{notice}</span><button type="button" className="underline" onClick={() => setNotice(null)}>Dismiss</button></p>}
      <div className="space-y-2 px-4 pt-3 empty:hidden"><ClaudePauseNotice /><JobRunStatusSection /></div>
      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        {state.sessions.map(session => <InterviewHost key={session.id} session={session} visible={session.id === selectedId} commit={commit} appliedJobsFolder={state.appliedJobsFolder} onChooseAppliedJobsFolder={chooseFolder} />)}
        {!selected && <div className="p-6 text-sm text-white/60"><p>Create an interview to get started, or import one you set up in Infinite Canvas.</p></div>}
      </div>
    </main>
    {settingsOpen && <SettingsDialog onClose={closeSettings} onError={setNotice} />}
    {reportingBug && <BugReportDialog onClose={closeBugReport} selectedIndex={state.sessions.findIndex(session => session.id === selectedId)} />}
  </div>;
}
