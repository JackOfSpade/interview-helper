import React from 'react';
import { AudioLines, Check, Clock, Loader2, PhoneOff } from 'lucide-react';
import { ANALYSIS_STAGES, analysisStageIndex } from './callModel.js';
import { formatTime } from './replayModel.js';

export const ANALYSING_MESSAGE = 'Analysing the recording. Your feedback opens in this window as soon as it is ready.';

// Shown from hang-up until the review is written: the call UI is gone and the
// steps of the post-call processing tick off in place. The interviewer is gone, so the screen is
// about the call itself (how it ended, how long it ran, what happens to it next), not about them.
export default function EndedScreen({ state, onChooseFeedback }) {
  // Leaving without feedback only saves the recording: one step, no review.
  const skipped = state?.feedbackRequested === false;
  // The call is saved and the candidate has not yet said whether they want feedback on it.
  const choosing = state?.feedbackChoice === 'pending' && state?.phase === 'ended';
  const analysing = state?.phase === 'analyzing' && !skipped;
  const stages = skipped ? ANALYSIS_STAGES.slice(0, 1) : ANALYSIS_STAGES;
  const title = analysing ? 'Analysing the call' : 'Call ended';
  const active = analysing ? analysisStageIndex(state?.analysisStage) : -1;
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-6 text-[#e8eaed]" aria-label={title}>
    <section className="pc-rise w-full max-w-md space-y-5">
      <header className="flex flex-col items-center gap-3 text-center">
        <span aria-hidden="true" className={`grid h-14 w-14 place-items-center rounded-full transition-colors duration-300 ${analysing ? 'bg-[#8ab4f8]/15 text-[#8ab4f8]' : 'bg-[#3c4043] text-[#e8eaed]'}`}>
          {analysing ? <AudioLines size={26} className="pc-breathe" /> : <PhoneOff size={24} />}
        </span>
        <h1 className="text-2xl font-normal text-white">{analysing ? 'Preparing your feedback' : state?.interviewerLeft ? 'Call ended' : 'You left the call'}</h1>
        <p className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs text-[#9aa0a6]"><Clock size={12} aria-hidden="true" />Call length {formatTime(state?.activeMs ?? state?.elapsedMs)}</p>
      </header>
      {choosing ? <section aria-label="Feedback choice" className="pc-fade space-y-4">
        <div className="text-center">
          <h2 className="text-base font-medium text-white">Want feedback on this call?</h2>
          <p className="mt-1 text-sm leading-snug text-[#9aa0a6]">Feedback uses AI to transcribe and review the recording. Skipping it keeps the recording and transcript only.</p>
        </div>
        <div className="flex flex-col gap-2">
          <button type="button" autoFocus onClick={() => onChooseFeedback?.(true)} className="rounded-full bg-[#1a73e8] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#1b66c9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8]">Get feedback</button>
          <button type="button" onClick={() => onChooseFeedback?.(false)} className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-[#8ab4f8] hover:bg-white/5">Skip feedback</button>
        </div>
      </section> : <>
      <div className="relative h-1 overflow-hidden rounded-full bg-white/10" aria-hidden="true"><span className="pc-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-[#8ab4f8]" /></div>
      <ol aria-label="Processing steps" className="space-y-2.5">
        {stages.map((stage, index) => {
          const status = index < active ? 'done' : index === active || (active < 0 && index === 0) ? 'active' : 'pending';
          return <li key={stage.key} data-stage={stage.key} data-status={status} aria-current={status === 'active' ? 'step' : undefined}
            className={`flex items-center gap-3 text-sm transition-colors duration-300 ${status === 'pending' ? 'text-[#5f6368]' : status === 'done' ? 'text-[#9aa0a6]' : 'text-white'}`}>
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full transition-colors duration-300 ${status === 'done' ? 'bg-[#81c995] text-[#202124]' : status === 'active' ? 'bg-[#8ab4f8]/20 text-[#8ab4f8]' : 'border border-[#5f6368]'}`} aria-hidden="true">
              {status === 'done' ? <Check size={14} className="pc-pop" /> : status === 'active' ? <Loader2 size={14} className="animate-spin" /> : null}
            </span>
            {stage.label}
          </li>;
        })}
      </ol>
      <p role="status" className="text-sm text-[#9aa0a6]">{analysing ? ANALYSING_MESSAGE : skipped ? 'Call ended. The recording is being saved; no feedback is generated.' : 'Call ended. The recording is being saved.'}</p>
      </>}
      {state?.error && <p role="alert" className="pc-fade rounded-lg bg-[#3c4043] px-3 py-2 text-sm text-[#f28b82]">{state.error.message}</p>}
    </section>
  </main>;
}
