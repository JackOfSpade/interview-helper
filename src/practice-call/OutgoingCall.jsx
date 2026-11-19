import React, { useEffect } from 'react';
import { PhoneOff } from 'lucide-react';
import { startRingback } from './ringtone.js';
import Avatar from './Avatar.jsx';
import { roleLine } from './persona.js';

// The candidate is returning a missed call: it rings on the other side until they pick up.
export default function OutgoingCall({ persona, onCancel }) {
  // The outgoing tone plays for as long as this screen is up (the cleanup covers the phase change).
  useEffect(() => {
    const stop = startRingback(typeof window === 'undefined' ? null : window);
    return stop;
  }, []);
  return <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#202124] p-4 text-violet-50" aria-label="Calling">
    <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300">Calling<span className="pc-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></p>
    <div className="flex flex-col items-center gap-2">
      <Avatar person={persona} className="h-20 w-20 animate-pulse text-3xl ring-4 ring-white/10" />
      <h1 className="text-lg font-semibold text-violet-50">{persona?.name || 'Unknown caller'}</h1>
      {roleLine(persona) && <p className="text-[12px] text-white/60">{roleLine(persona)}</p>}
      <p role="status" className="mt-1 text-[12px] text-white/45">Ringing</p>
    </div>
    <button type="button" className="flex flex-col items-center gap-1 text-[10px] text-red-200" onClick={onCancel} aria-label="End call">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-red-500/25 hover:bg-red-500/35"><PhoneOff size={18} aria-hidden="true" /></span>End
    </button>
  </main>;
}
