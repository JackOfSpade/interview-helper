import React from 'react';
import { AlertTriangle } from 'lucide-react';

export default function ErrorScreen({ error, onClose, onOpenMicrophoneSettings }) {
  const microphone = error?.code === 'permission-denied' && typeof onOpenMicrophoneSettings === 'function';
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-4 text-violet-50" aria-label="Call error">
    <section role="alert" data-code={error?.code || undefined} className="w-full max-w-md space-y-2 rounded-xl border border-red-400/30 bg-red-500/10 p-4">
      <h1 className="flex items-center gap-1.5 text-base font-semibold text-red-100"><AlertTriangle size={14} aria-hidden="true" />The call stopped</h1>
      <p className="text-[12px] text-red-100/90">{error?.message || 'The connection was lost.'}</p>
      <div className="flex flex-wrap gap-2">
        {microphone && <button type="button" onClick={onOpenMicrophoneSettings} className="rounded-md bg-white/90 px-2 py-1 text-[11px] font-medium text-[#202124] hover:bg-white">Open Microphone settings</button>}
        {typeof onClose === 'function' && <button type="button" onClick={onClose} className="rounded-md border border-white/15 px-2 py-1 text-[11px] text-white/75 hover:bg-white/5">Close window</button>}
      </div>
    </section>
  </main>;
}
