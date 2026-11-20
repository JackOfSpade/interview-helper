import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Send, WandSparkles, X } from 'lucide-react';

export const CHAT_MAX_LENGTH = 2000;
// The counter only appears when the end of the limit is near.
export const CHAT_COUNTER_FROM = 1800;

// The engine lets the typing flag lapse 6 s after the last report, so a long pause mid-message re-reports sooner.
export const TYPING_REFRESH_MS = 3000;

// The draft lives in the parent so closing the panel does not throw away an unsent answer.
// onSuggest (testing aid) asks for a reply to the latest question and resolves { text } or { error }.
// The text goes in the box and is never sent: the candidate reads it and presses Enter.
export default function ChatPanel({ chat, draft = '', onDraftChange, disabled = false, paused = false, interviewerName = '', onSend, onTyping, onSuggest, onClose }) {
  const setDraft = value => { if (typeof onDraftChange === 'function') onDraftChange(value); };
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState('');
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const listRef = useRef(null);
  const draftRef = useRef(null);
  // The box grows with a long answer (up to its max height) so the candidate can read what they typed.
  useEffect(() => {
    const box = draftRef.current;
    if (!box?.style) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);
  const typingRef = useRef(onTyping);
  useEffect(() => { typingRef.current = onTyping; });
  const notifyTyping = value => { if (typeof typingRef.current === 'function') typingRef.current(!!value); };
  const notifyTypingRef = useRef(notifyTyping);
  useEffect(() => { notifyTypingRef.current = notifyTyping; });
  // Closing the panel unmounts a focused box without a blur, so the end of typing is reported here.
  useEffect(() => () => { if (typeof typingRef.current === 'function') typingRef.current(false); }, []);
  const hasDraft = draft.length > 0;
  useEffect(() => {
    // A box that is disabled while focused gets no blur, so the disabled state ends the refresh itself.
    // While a suggestion is being written the candidate counts as typing, so the interviewer waits.
    if (!((focused && hasDraft) || suggesting) || disabled) return undefined;
    if (suggesting) notifyTypingRef.current(true);
    const timer = setInterval(() => notifyTypingRef.current(true), TYPING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [focused, hasDraft, disabled, suggesting]);
  // Once the interviewer has left nobody is waiting on the message, so typing is reported as over.
  useEffect(() => { if (disabled) notifyTypingRef.current(false); }, [disabled]);
  const messages = Array.isArray(chat) ? chat : [];
  // The newest message stays in view, as in any chat.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);
  const canSuggest = typeof onSuggest === 'function';
  const suggest = async () => {
    if (!canSuggest || suggesting || disabled || paused) return;
    setSuggesting(true);
    setSuggestError('');
    let result;
    try { result = await onSuggest(); } catch { result = { error: 'Could not suggest a reply. Try again.' }; }
    const text = typeof result?.text === 'string' ? result.text.slice(0, CHAT_MAX_LENGTH) : '';
    // The draft lives in the parent, so a reply that arrives after the panel was closed still lands in the box.
    if (!mountedRef.current) { if (text) setDraft(text); return; }
    setSuggesting(false);
    if (!text) {
      setSuggestError(typeof result?.error === 'string' && result.error ? result.error : 'Could not suggest a reply. Try again.');
      notifyTyping(false);
      return;
    }
    setDraft(text);
    // The box gets focus with the cursor at the end, ready to edit or press Enter.
    const box = draftRef.current;
    if (box && typeof box.focus === 'function') {
      box.focus();
      setTimeout(() => { try { box.setSelectionRange?.(text.length, text.length); } catch { /* box went away */ } }, 0);
    }
    notifyTyping(true);
  };
  const submit = () => {
    const text = draft.trim();
    // While paused the draft stays in the box: only the shortcut resumes, then the candidate sends it.
    if (!text || disabled || paused) return;
    // The window hears about a pause a moment after the shortcut is pressed. A message sent in
    // that moment is refused by the call, so it is put back in the box instead of being lost.
    if (typeof onSend === 'function') {
      Promise.resolve(onSend(text)).then(result => { if (result?.paused) setDraft(current => current || text); }, () => {});
    }
    setDraft('');
    setSuggestError('');
    notifyTyping(false);
  };
  return <section className="flex h-full min-h-0 flex-col rounded-2xl bg-white text-[#202124]" aria-label="Call chat">
    <header className="flex items-center justify-between px-5 pb-2 pt-4">
      <h2 className="text-lg font-normal">In-call messages</h2>
      {typeof onClose === 'function' && <button type="button" aria-label="Close chat" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-[#5f6368] hover:bg-black/5"><X size={18} aria-hidden="true" /></button>}
    </header>
    <p className="mx-4 rounded-lg bg-[#f1f3f4] px-3 py-2 text-center text-xs text-[#5f6368]">{disabled ? 'No one else is in the call.' : 'Messages can only be seen by people in the call.'}</p>
    {/* The call window turns text selection off; the messages are the one place it is wanted, to copy from. */}
    <ol ref={listRef} data-chat-messages="true" className="min-h-0 flex-1 cursor-text select-text space-y-3 overflow-y-auto px-5 py-3" aria-live="polite">
      {messages.map((message, index) => <li key={`${message.atMs ?? index}-${index}`} className="pc-fade">
        <span className="block text-[13px] font-medium">{message.from === 'candidate' ? 'You' : interviewerName || 'Interviewer'}</span>
        <span className="block whitespace-pre-wrap break-words text-[13px] leading-snug text-[#3c4043]">{message.text}</span>
      </li>)}
    </ol>
    {suggestError && <p role="status" className="mx-5 mb-2 text-xs text-[#d93025]">{suggestError}</p>}
    <form className="m-4 mt-0 flex items-end gap-1 rounded-3xl bg-[#f1f3f4] py-1 pl-4 pr-1" aria-label="Send a chat message" onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea
        ref={draftRef}
        aria-label="Chat message"
        rows={1}
        maxLength={CHAT_MAX_LENGTH}
        disabled={disabled}
        className="max-h-28 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-2 text-[13px] text-[#202124] outline-none placeholder:text-[#5f6368] disabled:cursor-not-allowed"
        value={draft}
        onChange={event => { setDraft(event.target.value); notifyTyping(event.target.value.length > 0); }}
        onFocus={() => { setFocused(true); if (draft) notifyTyping(true); }}
        onBlur={() => { setFocused(false); notifyTyping(false); }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || composing || event.nativeEvent?.isComposing) return;
          event.preventDefault();
          submit();
        }}
        placeholder={disabled ? 'No one else is here' : 'Send a message'}
      />
      {canSuggest && <button type="button" aria-label="Suggest a reply" title="Suggest a reply" onClick={suggest} aria-busy={suggesting} className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${suggesting ? 'cursor-wait text-[#1a73e8]' : 'text-[#5f6368] hover:bg-black/5 disabled:text-[#9aa0a6] disabled:hover:bg-transparent'}`} disabled={disabled || paused || suggesting}>{suggesting ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" data-testid="suggest-loading" /> : <WandSparkles size={18} aria-hidden="true" />}</button>}
      {draft.length >= CHAT_COUNTER_FROM && <span data-testid="chat-counter" className="self-center text-[11px] tabular-nums text-[#5f6368]">{draft.length}/{CHAT_MAX_LENGTH}</span>}
      <button type="submit" aria-label="Send chat message" className="grid h-9 w-9 place-items-center rounded-full text-[#1a73e8] hover:bg-black/5 disabled:text-[#9aa0a6] disabled:hover:bg-transparent" disabled={disabled || paused || !draft.trim()}><Send size={18} aria-hidden="true" /></button>
    </form>
  </section>;
}
