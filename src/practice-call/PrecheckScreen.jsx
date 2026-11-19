import React, { useEffect, useState } from 'react';
import { Check, Headphones, Mic } from 'lucide-react';
import { USAGE_WARNING, elapsedLabel, levelPercent, setupProgress } from './callModel.js';

/** Milliseconds since this screen appeared, ticking once a second. */
function useElapsed() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, []);
  return elapsed;
}

// Nothing here is a gate: the call rings when setup finishes, whether or not the meter moved.
export default function PrecheckScreen({ level, usageWarning, persona, setup }) {
  const percent = levelPercent(level);
  const elapsed = useElapsed();
  const steps = setupProgress(setup);
  const micOn = steps.some(item => (item.step === 'audio' && item.status === 'done') || (item.step === 'sessions' && item.status !== 'pending'));
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-4 text-violet-50" aria-label="Microphone check">
    <section className="w-full max-w-md space-y-3 rounded-xl border border-white/10 bg-[#2d2e30] p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-base font-semibold text-violet-100">Getting your interview ready</h1>
        <span className="text-[11px] tabular-nums text-white/45" aria-label="Time so far">{elapsedLabel(elapsed)}</span>
      </div>
      <p className="text-[12px] text-white/70">{persona?.name ? `${persona.name} is about to call.` : 'The interviewer calls as soon as this finishes.'} There is nothing you need to do here.</p>
      <ol aria-label="Setup progress" className="space-y-1.5">
        {steps.map(item => <li key={item.step} data-status={item.status} aria-current={item.status === 'active' ? 'step' : undefined}
          className={`flex items-center gap-2 text-[12px] ${item.status === 'active' ? 'text-violet-100' : item.status === 'done' ? 'text-white/55' : 'text-white/30'}`}>
          <span className="grid h-3.5 w-3.5 shrink-0 place-items-center" aria-hidden="true">
            {item.status === 'done' ? <Check size={13} className="text-emerald-300/80" />
              : <span className={`h-1.5 w-1.5 rounded-full ${item.status === 'active' ? 'animate-pulse bg-violet-300' : 'bg-white/25'}`} />}
          </span>
          <span>{item.label}{item.status === 'active' ? '…' : ''}</span>
          {item.status === 'active' && (item.note || item.hint) && <span className="text-[11px] text-white/45">{item.note || item.hint}</span>}
          <span className="sr-only">{item.status === 'done' ? '(done)' : item.status === 'active' ? '(in progress)' : '(waiting)'}</span>
        </li>)}
      </ol>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] uppercase text-white/45"><span className="flex items-center gap-1"><Mic size={11} aria-hidden="true" />Microphone level</span><span>{micOn ? `${percent}%` : 'not on yet'}</span></div>
        <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-emerald-300/70" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-[11px] text-white/55">Speaking is optional: you can type every answer in the call's chat.</p>
      </div>
      <p className="flex items-start gap-1.5 text-[11px] text-white/70"><Headphones size={12} className="mt-0.5 shrink-0" aria-hidden="true" />Headphones recommended — the interviewer's voice can otherwise be picked up as if it were you.</p>
      <div role="note" aria-label="Usage warning" className="rounded-lg border border-amber-400/25 bg-amber-500/10 p-2 text-[11px] text-amber-100">{usageWarning || USAGE_WARNING}</div>
    </section>
  </main>;
}
