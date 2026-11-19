import React, { useEffect, useState } from 'react';
import { Check, Headphones, Mic, VideoOff } from 'lucide-react';
import { elapsedLabel, levelPercent, setupProgress } from './callModel.js';

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

// Setup can take minutes, so nothing rings by itself: once it finishes the candidate presses
// Ready, and the call comes a few seconds later. The meter is never a gate.
export default function PrecheckScreen({ level, usageWarning, persona, setup, onReady }) {
  const percent = levelPercent(level);
  const elapsed = useElapsed();
  const steps = setupProgress(setup);
  const isReady = setup?.step === 'ready';
  const calling = isReady && !!setup?.calling;
  // Ready was pressed: the setup card is gone and there is only the wait for the ring.
  if (calling) {
    return <main className="grid min-h-screen place-items-center bg-[#202124] p-4 text-violet-50" aria-label="Waiting for call">
      <h1 role="status" aria-label="Waiting for call" className="text-lg font-semibold text-violet-100">Waiting for call<span className="pc-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></h1>
    </main>;
  }
  const lead = isReady ? `Everything is set. Press Ready when you are, and ${persona?.name || 'the interviewer'} calls a few seconds later.`
      : 'This can take a couple of minutes. Nothing starts until you press Ready at the end, so you can step away.';
  const micOn = steps.some(item => (item.step === 'audio' && item.status === 'done') || (item.step === 'sessions' && item.status !== 'pending'));
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-4 text-violet-50" aria-label="Microphone check">
    <section className="w-full max-w-md space-y-3 rounded-xl border border-white/10 bg-[#2d2e30] p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-base font-semibold text-violet-100">{isReady ? 'Your interview is ready' : 'Getting your interview ready'}</h1>
        {!isReady && <span className="text-[11px] tabular-nums text-white/45" aria-label="Time so far">{elapsedLabel(elapsed)}</span>}
      </div>
      <p className="text-[12px] text-white/70" aria-live="polite">{lead}</p>
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
      <p className="flex items-start gap-1.5 text-[11px] text-white/70"><VideoOff size={12} className="mt-0.5 shrink-0" aria-hidden="true" />Your camera is optional. If you turn it on during the call, only you see it: video stays on this Mac and is never recorded or sent.</p>
      {isReady && <button type="button" onClick={onReady}
        className="w-full rounded-lg bg-emerald-500/25 px-3 py-2 text-[13px] font-semibold text-emerald-50 hover:bg-emerald-500/35">I'm ready</button>}
      {usageWarning ? <div role="note" aria-label="Usage warning" className="rounded-lg border border-amber-400/25 bg-amber-500/10 p-2 text-[11px] text-amber-100">{usageWarning}</div> : null}
    </section>
  </main>;
}
