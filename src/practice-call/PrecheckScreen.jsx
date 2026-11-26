import React, { useEffect, useState } from 'react';
import { Check, Headphones, Keyboard, Mic, MicOff } from 'lucide-react';
import { elapsedLabel, HEARING_LEVEL, meterPercent, microphoneOn, setupProgress } from './callModel.js';

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

// The microphone check. It only shows once the microphone is on, and it is never a gate.
function MicrophoneMeter({ level, unavailable, onOpenSettings }) {
  // macOS refused the microphone or it is gone: the call would run unheard, so say so before it rings.
  if (unavailable) {
    return <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-100">
      <MicOff size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="space-y-1.5">
        <p>Your microphone isn’t available. Allow it in System Settings to speak your answers.</p>
        {typeof onOpenSettings === 'function' && <button type="button" onClick={onOpenSettings} className="rounded-md bg-white/90 px-2 py-1 text-[11px] font-medium text-[#202124] hover:bg-white">Open Microphone settings</button>}
      </div>
    </div>;
  }
  const percent = meterPercent(level);
  const hearing = Number(level) > HEARING_LEVEL;
  return <div className="space-y-1.5">
    <div className="flex items-center justify-between text-[12px]">
      <span className="flex items-center gap-1.5 text-white/75"><Mic size={13} aria-hidden="true" />Microphone</span>
      <span className={hearing ? 'text-emerald-200' : 'text-white/45'}>{hearing ? 'Hearing you' : 'Quiet'}</span>
    </div>
    <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full bg-emerald-300/80 transition-[width] duration-100" style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

// Setup can take minutes, so nothing rings by itself: once it finishes the candidate presses
// I'm ready, and the call comes a few seconds later.
export default function PrecheckScreen({ level, usageWarning, persona, setup, microphoneUnavailable = false, onReady, onCancel, onOpenMicrophoneSettings }) {
  const elapsed = useElapsed();
  // A second press before the service answers would do nothing; the button says it was heard.
  const [pressed, setPressed] = useState(false);
  const stages = setupProgress(setup);
  const isReady = setup?.step === 'ready';
  const calling = isReady && !!setup?.calling;
  // I'm ready was pressed: the setup card is gone and there is only the wait for the ring.
  if (calling) {
    return <main className="grid min-h-screen place-items-center bg-[#202124] p-4 text-violet-50" aria-label="Waiting for call">
      <div role="status"><h1 className="text-lg font-semibold text-violet-100">Waiting for call<span className="pc-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></h1></div>
    </main>;
  }
  const caller = persona?.name || 'Your interviewer';
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-4 text-violet-50" aria-label="Getting ready">
    <section className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-[#2d2e30] p-5 shadow-xl shadow-black/30">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold text-violet-50">{isReady ? 'Your interview is ready' : 'Getting your interview ready'}</h1>
          {!isReady && <span className="text-[12px] tabular-nums text-white/45" aria-label="Time so far">{elapsedLabel(elapsed)}</span>}
        </div>
        <p className="text-[13px] text-white/65" aria-live="polite">{isReady
          ? `${caller} will call a few seconds after you press I'm ready.`
          : 'This takes a minute or two. Nothing starts until you say you’re ready, so you can step away.'}</p>
      </header>
      {usageWarning ? <p role="note" aria-label="Usage warning" className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-100">{usageWarning}</p> : null}
      {!isReady && <ol aria-label="Setup progress" className="space-y-2">
        {stages.map(item => <li key={item.key} data-status={item.status} aria-current={item.status === 'active' ? 'step' : undefined}
          className={`flex items-center gap-2.5 text-[13px] ${item.status === 'active' ? 'text-violet-50' : item.status === 'done' ? 'text-white/55' : 'text-white/35'}`}>
          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${item.status === 'done' ? 'bg-emerald-400/15' : item.status === 'active' ? 'bg-violet-400/20' : 'bg-white/5'}`} aria-hidden="true">
            {item.status === 'done' ? <Check size={12} className="text-emerald-300" />
              : <span className={`h-1.5 w-1.5 rounded-full ${item.status === 'active' ? 'animate-pulse bg-violet-300' : 'bg-white/25'}`} />}
          </span>
          <span>{item.label}</span>
          {item.status === 'active' && item.hint && <span className="text-[12px] text-white/40">· {item.hint}</span>}
          <span className="sr-only">{item.status === 'done' ? '(done)' : item.status === 'active' ? '(in progress)' : '(waiting)'}</span>
        </li>)}
      </ol>}
      {microphoneOn(setup) && <MicrophoneMeter level={level} unavailable={microphoneUnavailable} onOpenSettings={onOpenMicrophoneSettings} />}
      <ul className="space-y-1.5 border-t border-white/10 pt-3 text-[12px] text-white/55" aria-label="Tips">
        <li className="flex items-start gap-2"><Headphones size={13} className="mt-0.5 shrink-0" aria-hidden="true" />Use headphones so your microphone doesn’t pick up the interviewer.</li>
        <li className="flex items-start gap-2"><Keyboard size={13} className="mt-0.5 shrink-0" aria-hidden="true" />You can also type your answers in the chat.</li>
      </ul>
      {isReady && <button type="button" onClick={() => { setPressed(true); onReady?.(); }} disabled={pressed} autoFocus
        className="w-full rounded-lg bg-emerald-500/30 px-3 py-2.5 text-[14px] font-semibold text-emerald-50 hover:bg-emerald-500/40 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60">I'm ready</button>}
      {typeof onCancel === 'function' && <button type="button" onClick={onCancel} className="block w-full text-center text-[12px] text-white/45 hover:text-white/70">Cancel</button>}
    </section>
  </main>;
}
