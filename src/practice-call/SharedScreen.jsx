import React, { useState } from 'react';
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
export default function SharedScreen({ title, content, presenterName = '', visual = null, className = '' }) {
  const blocks = parseScreenContent(content);
  const shown = safeVisual(visual);
  const [failed, setFailed] = useState(null);
  return <section aria-label="Shared screen" data-shared-screen="true" className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-white text-[#202124] ${className}`}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8eaed] px-4 py-2.5">
      <h2 className="cursor-text select-text truncate text-sm font-medium">{title || 'Shared screen'}</h2>
      {presenterName && <span className="shrink-0 rounded-full bg-[#202124]/80 px-2.5 py-1 text-xs text-white">{presenterName} (Presentation)</span>}
    </header>
    {/* The call window turns text selection off; a shared screen is read-only but can be selected and copied from, like the chat. */}
    <div data-screen-body="true" className="min-h-0 flex-1 cursor-text select-text space-y-3 overflow-y-auto px-5 py-4 text-[15px] leading-relaxed">
      {shown && failed !== shown.url && <figure data-screen-visual={shown.kind} className="m-0">
        <img src={shown.url} alt={shown.description} draggable={false} onError={() => setFailed(shown.url)}
          className={`mx-auto block max-h-[45vh] max-w-full rounded-md object-contain ${shown.kind === 'diagram' ? 'bg-white' : ''}`} />
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
