import React, { useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { parseInline, parseScreenContent, safeVisual } from './screenMarkup.js';

function Inline({ text }) {
  return parseInline(text).map((part, index) => {
    if (part.type === 'code') return <code key={index} className="rounded bg-[#f1f3f4] px-1 py-0.5 font-mono text-[0.9em] text-[#202124]">{part.text}</code>;
    if (part.type === 'bold') return <strong key={index} className="font-semibold">{part.text}</strong>;
    return <React.Fragment key={index}>{part.text}</React.Fragment>;
  });
}

// What the interviewer is presenting, drawn as a light "window" on the dark stage.
// Every value is a React child, never markup, so content cannot inject anything.
// `visual` (optional): a picture or diagram prepared for this screen, shown above the text.
// `onEnlarge` (optional) adds an Enlarge button and makes the visual clickable; `onClose` adds a Shrink button,
// and `large` sets bigger text and a taller visual for the enlarged view (the replay uses these).
export default function SharedScreen({ title, content, presenterName = '', visual = null, className = '', onEnlarge = null, onClose = null, closeRef = null, large = false }) {
  const blocks = parseScreenContent(content);
  const shown = safeVisual(visual);
  const [failed, setFailed] = useState(null);
  return <section aria-label="Shared screen" data-shared-screen="true" className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-white text-[#202124] ${className}`}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8eaed] px-4 py-2.5">
      <h2 className="cursor-text select-text truncate text-sm font-medium">{title || 'Shared screen'}</h2>
      <div className="flex shrink-0 items-center gap-2">
        {presenterName && <span className="shrink-0 rounded-full bg-[#202124]/80 px-2.5 py-1 text-xs text-white">{presenterName} (Presentation)</span>}
        {onEnlarge && <button type="button" onClick={onEnlarge} aria-label="Enlarge shared screen" title="Enlarge" data-screen-enlarge="true"
          className="grid h-7 w-7 place-items-center rounded-md text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8]">
          <Maximize2 size={15} aria-hidden="true" /></button>}
        {onClose && <button type="button" ref={closeRef} onClick={onClose} aria-label="Shrink shared screen" title="Shrink (Esc)" data-screen-shrink="true"
          className="grid h-7 w-7 place-items-center rounded-md text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a73e8]">
          <Minimize2 size={15} aria-hidden="true" /></button>}
      </div>
    </header>
    {/* The call window turns text selection off; a shared screen is read-only but can be selected and copied from, like the chat. */}
    <div data-screen-body="true" className={`min-h-0 flex-1 cursor-text select-text space-y-3 overflow-y-auto leading-relaxed ${large ? 'px-8 py-6 text-[17px]' : 'px-5 py-4 text-[15px]'}`}>
      {shown && failed !== shown.url && <figure data-screen-visual={shown.kind} className="m-0">
        <img src={shown.url} alt={shown.description} draggable={false} onError={() => setFailed(shown.url)} onClick={onEnlarge || undefined}
          className={`mx-auto block max-w-full rounded-md object-contain ${large ? 'max-h-[70vh] w-full' : 'max-h-[45vh]'} ${onEnlarge ? 'cursor-zoom-in' : ''} ${shown.kind === 'diagram' ? 'bg-white' : ''}`} />
        {shown.credit && <figcaption className="mt-1 text-center text-[11px] text-[#5f6368]">{shown.kind === 'picture' ? `Photo: ${shown.credit}` : shown.credit}</figcaption>}
      </figure>}
      {blocks.length === 0 && !shown && <p className="text-[#5f6368]">Nothing on the screen yet.</p>}
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return <pre key={index} data-code-lang={block.lang || undefined} className="overflow-x-auto rounded-lg bg-[#1e1f22] p-3 font-mono text-[13px] leading-5 text-[#e8eaed]"><code>{block.text}</code></pre>;
        }
        if (block.type === 'ul') {
          return <ul key={index} className="list-disc space-y-1 pl-5">{block.items.map((item, at) => <li key={at}><Inline text={item} /></li>)}</ul>;
        }
        return <p key={index} className="whitespace-pre-line break-words"><Inline text={block.text} /></p>;
      })}
    </div>
  </section>;
}
