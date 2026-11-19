import React, { useEffect, useState } from 'react';

/**
 * Text size of every window of this app (main window, cue card, practice call).
 * The setting lives in the main process; the View menu changes the same value.
 */
export function TextSizeControl({ onError }) {
  const [size, setSize] = useState(null);

  useEffect(() => {
    const api = window.interviewAppAPI;
    if (typeof api?.getTextSize !== 'function') return undefined;
    let disposed = false;
    api.getTextSize().then((state) => { if (!disposed) setSize(current => current || state); }).catch(() => {});
    const unsubscribe = api.onTextSizeChanged?.((state) => { if (!disposed) setSize(state); });
    return () => { disposed = true; unsubscribe?.(); };
  }, []);

  if (!size) return null;
  const index = size.steps.indexOf(size.percent);
  const change = async (percent) => {
    try { setSize(await window.interviewAppAPI.setTextSize({ percent })); }
    catch (error) { onError?.(error?.message || 'The text size could not be changed.'); }
  };
  const button = 'rounded-md border border-white/15 px-2 py-1 leading-none text-white/80 hover:bg-white/5 disabled:opacity-35';
  return <div role="group" aria-label="Text size" className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 text-xs text-white/60">
    <span className="mr-auto">Text size</span>
    <button type="button" className={`${button} text-[10px]`} aria-label="Smaller text" title="Smaller text (⌘−)" disabled={!size.canShrink} onClick={() => change(size.steps[index - 1])}>A</button>
    <button type="button" className="min-w-10 rounded-md px-1 py-1 text-center tabular-nums text-white/80 hover:bg-white/5 disabled:hover:bg-transparent" aria-label={`Text size ${size.percent}%. Back to ${size.default}%`} title={`Back to ${size.default}% (⌘0)`} disabled={size.percent === size.default} onClick={() => change(size.default)}>{size.percent}%</button>
    <button type="button" className={`${button} text-sm`} aria-label="Bigger text" title="Bigger text (⌘+)" disabled={!size.canGrow} onClick={() => change(size.steps[index + 1])}>A</button>
  </div>;
}
