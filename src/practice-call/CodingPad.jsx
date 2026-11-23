import React, { useEffect, useRef, useState } from 'react';
import { PAD_TEXT_MAX, padKeyInsert } from './screenMarkup.js';
import { DELETE_DELAY_MS, keyDelayMs, padEdit } from './padTyping.js';
import { PAD_LANGUAGES } from './padLanguages.js';

// Matches the chat box: the engine lets the typing flag lapse after about 6 s.
export const PAD_TYPING_REFRESH_MS = 3000;
export const PAD_TYPING_IDLE_MS = 4000;
export const PAD_SEND_DEBOUNCE_MS = 400;
// While the wand types, the debounce never fires (keys come faster than it), so the pad is sent at least this often: the
// interviewers and the record see it a second behind at most. Each send is a pad update the engine treats as activity.
export const PAD_TYPING_FLUSH_MS = 1000;
const NEAR_CAP = 18000;
// Where a word ends: the wand giving way stops here, never in the middle of a name.
const WORD_END = /[\s.,;:()[\]{}]/u;

// The candidate's editor. The window owns the text: it is seeded once from
// initialText when the pad mounts and later state updates never overwrite it.
// readOnly shows `value` instead (the replay) and sends nothing.
// typerRef (optional) is given { typeTo(target, { stopped, paused, yielding }) }: the wand types the pad into `target` key
// by key through the same edits a person makes, so it is sent and seen exactly as typing is. It resolves true when the
// pad reads `target`, false when stopped first; while paused() it waits. Once yielding() is true (someone started
// speaking and the reaction time is over) it stops at the end of the word being typed, as a person gives way.
// lang is the language the exercise requires, shown as a label. With none required and onChooseLanguage given, the
// header has a dropdown instead: `choice` is the candidate's pick, and picking another calls onChooseLanguage(name).
// `options` limits the dropdown to the languages the exercise allows (a role hired for several); empty lists them all.
export default function CodingPad({ lang = '', choice = '', options, onChooseLanguage, initialText = '', value = '', readOnly = false, disabled = false, onChange, onTyping, typerRef, className = '' }) {
  const [own, setOwn] = useState(() => String(initialText || '').slice(0, PAD_TEXT_MAX));
  const text = readOnly ? String(value || '') : own;
  const textRef = useRef(own);
  const dirtyRef = useRef(false);
  const sendTimerRef = useRef(null);
  const idleTimerRef = useRef(null);
  const typingRef = useRef({ on: false, at: 0 });
  const cursorRef = useRef(null);
  const areaRef = useRef(null);
  const gutterRef = useRef(null);
  const callbacks = useRef({});
  useEffect(() => { callbacks.current = { onChange, onTyping }; });

  const flush = () => {
    clearTimeout(sendTimerRef.current);
    sendTimerRef.current = null;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    if (typeof callbacks.current.onChange === 'function') callbacks.current.onChange(textRef.current);
  };
  const stopTyping = () => {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
    if (!typingRef.current.on) return;
    typingRef.current.on = false;
    if (typeof callbacks.current.onTyping === 'function') callbacks.current.onTyping(false);
  };
  const beat = () => {
    const now = Date.now();
    if (!typingRef.current.on || now - typingRef.current.at >= PAD_TYPING_REFRESH_MS) {
      typingRef.current = { on: true, at: now };
      if (typeof callbacks.current.onTyping === 'function') callbacks.current.onTyping(true);
    }
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(stopTyping, PAD_TYPING_IDLE_MS);
  };
  // Closing the pad unmounts it: the last text still goes out and typing ends.
  useEffect(() => () => { if (!readOnly) { flush(); stopTyping(); } }, [readOnly]);
  useEffect(() => { if (disabled) stopTyping(); }, [disabled]);
  useEffect(() => {
    const at = cursorRef.current;
    if (at === null || !areaRef.current) return;
    cursorRef.current = null;
    try { areaRef.current.setSelectionRange(at, at); } catch { /* element detached */ }
  }, [own]);

  const edit = next => {
    textRef.current = next;
    dirtyRef.current = true;
    setOwn(next);
    clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(flush, PAD_SEND_DEBOUNCE_MS);
    beat();
  };
  const editRef = useRef(edit);
  const flushRef = useRef(flush);
  useEffect(() => { editRef.current = edit; flushRef.current = flush; });
  useEffect(() => {
    if (!typerRef || readOnly) return undefined;
    let alive = true;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    typerRef.current = {
      async typeTo(target, options = {}) {
        // Whatever way typing ends (done, stopped, given way), the last keys go out at once, not after the debounce.
        try { return await typeKeys(target, options); } finally { flushRef.current(); }
      },
    };
    // `pace` stretches (above 1) or tightens (below 1) every key's delay: hands that keep with a line being said.
    const typeKeys = async (target, { stopped = () => false, paused = () => false, yielding = () => false, pace = 1 } = {}) => {
        const rate = Number.isFinite(pace) && pace > 0 ? pace : 1;
        let flushedAt = Date.now();
        const goal = String(target ?? '').slice(0, PAD_TEXT_MAX);
        const step = async ms => {
          await sleep(ms);
          while (alive && paused() && !stopped()) await sleep(200);
          return alive && !stopped();
        };
        // Worked out again before every key, so an edit by the person in between is respected, not overwritten blindly.
        let previous = '';
        for (;;) {
          if (Date.now() - flushedAt >= PAD_TYPING_FLUSH_MS) { flushRef.current(); flushedAt = Date.now(); }
          const { at, remove, insert } = padEdit(textRef.current, goal);
          if (!remove && !insert) return true;
          if (remove) {
            if (yielding()) return false;
            if (!(await step(DELETE_DELAY_MS))) return false;
            const now = textRef.current;
            const cut = at + remove;
            cursorRef.current = cut - 1;
            editRef.current(`${now.slice(0, cut - 1)}${now.slice(cut)}`);
            continue;
          }
          const char = insert[0];
          // Giving way: the word being typed is finished, then the hands stop.
          if (yielding() && (!previous || WORD_END.test(previous) || WORD_END.test(char))) return false;
          if (!(await step(keyDelayMs(char, previous) * rate))) return false;
          previous = char;
          const now = textRef.current;
          cursorRef.current = at + 1;
          editRef.current(`${now.slice(0, at)}${char}${now.slice(at)}`);
        }
    };
    return () => { alive = false; if (typerRef.current) typerRef.current = null; };
  }, [typerRef, readOnly]);
  const onKeyDown = event => {
    if (readOnly) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key !== 'Tab' && event.key !== 'Enter') return;
    event.preventDefault();
    const area = event.currentTarget;
    const start = area.selectionStart ?? own.length;
    const end = area.selectionEnd ?? start;
    const insert = padKeyInsert(event.key, own.slice(0, start));
    const next = `${own.slice(0, start)}${insert}${own.slice(end)}`;
    if (next.length > PAD_TEXT_MAX) return;
    cursorRef.current = start + insert.length;
    edit(next);
  };
  const lineCount = text.split('\n').length;
  const numbers = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
  // The gutter follows the textarea scroll directly so numbers never lag a frame.
  const syncGutter = event => {
    const inner = gutterRef.current;
    if (inner) inner.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`;
  };
  return <section aria-label="Coding pad" data-coding-pad={readOnly ? 'readonly' : 'live'} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-[#1e1f22] text-[#e8eaed] ${className}`}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
      <h2 className="flex items-center text-sm font-medium">Coding pad{lang && <span data-pad-lang="true" className="ml-2 rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs font-normal text-[#9aa0a6]">{lang}</span>}
        {!lang && !readOnly && typeof onChooseLanguage === 'function' && <select aria-label="Language" data-pad-language-choice="true" value={choice} disabled={disabled}
          onChange={event => onChooseLanguage(event.target.value)}
          className="ml-2 rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs font-normal text-[#e8eaed] outline-none focus:ring-1 focus:ring-[#8ab4f8] disabled:opacity-50">
          {!choice && <option value="" disabled>Language</option>}
          {(Array.isArray(options) && options.length ? options : PAD_LANGUAGES).map(name => <option key={name} value={name} className="bg-[#1e1f22]">{name}</option>)}
        </select>}
      </h2>
      {!readOnly && <div className="flex items-center gap-3">
        {text.length >= NEAR_CAP && <span data-testid="pad-counter" className="text-[11px] tabular-nums text-[#9aa0a6]">{text.length}/{PAD_TEXT_MAX}</span>}
      </div>}
    </header>
    <div className="relative flex min-h-0 flex-1">
      <div aria-hidden="true" data-pad-gutter="true" className="w-12 shrink-0 select-none overflow-hidden bg-black/20 py-3 pr-2 text-right font-mono text-[13px] leading-5 text-[#6b7075]">
        <pre ref={gutterRef} className="font-[inherit]">{numbers}</pre>
      </div>
      <textarea ref={areaRef} aria-label={readOnly ? 'Coding pad contents' : 'Code'} wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        readOnly={readOnly} maxLength={PAD_TEXT_MAX} value={text}
        onChange={readOnly ? undefined : event => edit(event.target.value.slice(0, PAD_TEXT_MAX))}
        onKeyDown={onKeyDown} onScroll={syncGutter} onBlur={readOnly ? undefined : () => { flush(); stopTyping(); }}
        placeholder={readOnly ? undefined : 'Write your code here'}
        className="min-h-0 min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent py-3 pl-3 pr-3 font-mono text-[13px] leading-5 text-[#e8eaed] outline-none placeholder:text-[#6b7075]" />
    </div>
  </section>;
}
