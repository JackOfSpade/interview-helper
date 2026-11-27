import React, { useEffect, useState } from 'react';
import { TextSizeControl } from './TextSizeControl';

const VOICE_LABELS = { female: 'Female', male: 'Male' };

/**
 * App settings (sidebar button, or Settings… on the App menu, ⌘,). Holds the voice that speaks
 * the person's sent chat messages in a practice call, and the text size. Mounted only while open.
 */
export function SettingsDialog({ onClose, onError }) {
  const [voice, setVoice] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const api = window.interviewAppAPI;
    if (typeof api?.getPracticeVoice !== 'function') return undefined;
    let disposed = false;
    api.getPracticeVoice().then(state => { if (!disposed) setVoice(state); }).catch(() => { if (!disposed) onError?.('Your voice setting could not be read.'); });
    return () => { disposed = true; };
  }, [onError]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = async (gender) => {
    if (saving || voice?.gender === gender) return;
    setSaving(true);
    try { setVoice(await window.interviewAppAPI.setPracticeVoice({ gender })); }
    catch (error) { onError?.(error?.message || 'The voice could not be changed.'); }
    finally { setSaving(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="settings-title" className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-white/15 bg-[#1b1924] p-4 shadow-2xl">
      <h2 id="settings-title" className="text-sm font-semibold text-white">Settings</h2>
      <fieldset className="space-y-2" disabled={!voice || saving}>
        <legend className="text-xs font-medium text-white/80">Your voice in practice calls</legend>
        <p className="text-xs text-white/50">What you send in the call chat is spoken in this voice, and the interviewer hears it as your answer. A new voice of each kind is picked for every call.</p>
        <div role="radiogroup" aria-label="Your voice in practice calls" className="flex gap-2">
          {(voice?.choices || ['female', 'male']).map(gender => <label key={gender} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${voice?.gender === gender ? 'border-violet-400/60 bg-violet-500/20 text-white' : 'border-white/15 text-white/70 hover:bg-white/5'}`}>
            <input type="radio" name="practice-voice" value={gender} checked={voice?.gender === gender} onChange={() => choose(gender)} className="accent-violet-400" />
            {VOICE_LABELS[gender] || gender}
          </label>)}
        </div>
      </fieldset>
      <div className="rounded-md border border-white/10"><TextSizeControl onError={onError} /></div>
      <div className="flex justify-end">
        <button type="button" className="rounded-md bg-violet-500/20 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/30" onClick={onClose}>Done</button>
      </div>
    </section>
  </div>;
}
