import React from 'react';
import { Phone, PhoneMissed, X } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { firstNameOf, roleLine } from './persona.js';
import { missedCallView } from './callModel.js';

// The ring was declined or rang out. The caller stays on screen the way a missed call does in a
// call app, and can be called back for as long as they are still reachable.
export default function MissedCall({ persona, missed, onCallBack, onClose }) {
  const name = persona?.name || 'Unknown caller';
  const view = missedCallView(missed, firstNameOf(persona));
  return <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#202124] p-4 text-violet-50" aria-label={view.label}>
    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-red-300"><PhoneMissed size={12} aria-hidden="true" />{view.label}</p>
    <div className="pc-fade flex flex-col items-center gap-2">
      <Avatar person={persona} className="h-20 w-20 text-3xl opacity-70 ring-4 ring-white/5" />
      <h1 className="text-lg font-semibold text-violet-50">{name}</h1>
      {roleLine(persona) && <p className="text-[12px] text-white/60">{roleLine(persona)}</p>}
      <p role="status" className="mt-1 text-[12px] text-white/45">{view.detail}</p>
    </div>
    <div className="flex items-center gap-8">
      <button type="button" className="flex flex-col items-center gap-1 text-[10px] text-white/60" onClick={onClose} aria-label="Close">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-white/10 hover:bg-white/15"><X size={18} aria-hidden="true" /></span>Close
      </button>
      {view.canCallBack && <button type="button" autoFocus className="flex flex-col items-center gap-1 text-[10px] text-emerald-100" onClick={onCallBack} aria-label="Call back">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-emerald-500/25 hover:bg-emerald-500/35"><Phone size={18} aria-hidden="true" /></span>Call back
      </button>}
    </div>
  </main>;
}
