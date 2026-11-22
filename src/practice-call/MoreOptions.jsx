import React, { useEffect, useRef, useState } from 'react';
import { Check, EllipsisVertical } from 'lucide-react';

const VOICE_LABELS = Object.freeze({ female: 'Female', male: 'Male' });

/**
 * The meeting-style "More options" menu in the call's control bar. It holds the candidate's own voice
 * (the one a suggested or sent line is said in): the same setting as the app's Settings, applied to the
 * next line said. Shown only when the window can read the setting.
 */
export default function MoreOptions({ api, buttonClass, initialOpen = false, initialVoice = null }) {
  const [open, setOpen] = useState(initialOpen);
  const [voice, setVoice] = useState(initialVoice);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef(null);
  const available = typeof api?.getVoice === 'function' && typeof api?.setVoice === 'function';

  // Read on mount and again each time the menu opens, so a change made in Settings mid-call shows here.
  useEffect(() => {
    if (!available) return undefined;
    let live = true;
    Promise.resolve(api.getVoice()).then(state => { if (live && state?.gender) setVoice(state); }).catch(() => {});
    return () => { live = false; };
  }, [available, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const onDown = event => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape') { setOpen(false); rootRef.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!available) return null;
  const choices = Array.isArray(voice?.choices) && voice.choices.length ? voice.choices : ['female', 'male'];
  const choose = async gender => {
    if (saving || gender === voice?.gender) return;
    setSaving(true);
    try {
      const state = await api.setVoice(gender);
      if (state?.gender) setVoice(state);
    } catch { /* the choice stays as it was */ } finally { setSaving(false); }
  };

  return <div ref={rootRef} className="relative">
    <button type="button" className={buttonClass(open)} aria-haspopup="menu" aria-expanded={open} aria-label="More options" title="More options"
      onClick={() => setOpen(value => !value)}><EllipsisVertical size={20} aria-hidden="true" /></button>
    {open && <div role="menu" aria-label="More options" data-testid="more-options"
      className="pc-rise absolute bottom-12 right-0 z-30 w-56 rounded-lg bg-[#2d2e31] py-2 text-sm text-[#e8eaed] shadow-xl ring-1 ring-white/10">
      <p className="px-4 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-[#9aa0a6]" id="pc-voice-heading">Your voice</p>
      <div role="group" aria-labelledby="pc-voice-heading">
        {choices.map(gender => {
          const checked = voice?.gender === gender;
          return <button key={gender} type="button" role="menuitemradio" aria-checked={checked} data-voice={gender} disabled={saving}
            onClick={() => choose(gender)}
            className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-white/10 disabled:cursor-wait">
            <span className="grid h-4 w-4 place-items-center">{checked && <Check size={16} aria-hidden="true" className="text-[#8ab4f8]" />}</span>
            {VOICE_LABELS[gender] ?? gender}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
