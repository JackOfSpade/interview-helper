import React from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { modelDownloadLabel } from './callModel.js';

// Shown once, before the first call: the files the call needs, and what happens to the recording.
export default function ConsentScreen({ onAgree, busy, sizes }) {
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-4 text-violet-50" aria-label="Call setup">
    <section className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-[#2d2e30] p-5 shadow-xl shadow-black/30">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-violet-50">Before your first call</h1>
        <p className="text-[13px] text-white/65">The call needs a one-time download of speech files so it can tell when you’ve finished speaking.</p>
      </header>
      <ul className="space-y-2 text-[12px] text-white/60">
        <li className="flex items-start gap-2"><Download size={13} className="mt-0.5 shrink-0" aria-hidden="true" />Download size: {modelDownloadLabel(sizes)}, once.</li>
        <li className="flex items-start gap-2"><ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />Calls are recorded so you can play them back. Recordings stay on this Mac; only your answers are sent out to be transcribed. The audio is deleted after the feedback unless you keep it.</li>
      </ul>
      <button type="button" className="w-full rounded-lg bg-violet-500/35 px-3 py-2.5 text-[14px] font-semibold text-violet-50 hover:bg-violet-500/45 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60" onClick={onAgree} disabled={!!busy} autoFocus>{busy ? 'Starting…' : 'Agree and download'}</button>
    </section>
  </main>;
}
