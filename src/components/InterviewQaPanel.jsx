import React, { useCallback, useEffect, useRef, useState } from 'react';
import { InterviewQaBadges } from './InterviewQaBadges';
import { InterviewCardPreview, InterviewQaMatchTester, inputClass } from './InterviewQaCardPreview';

const buttonClass = 'rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-blue-500/10 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-blue-400';
const emptyQa = () => ({ foundation: { status: 'missing', cards: [] }, company: { status: 'missing', company: '', cards: [], topics: [], foundationLinks: [] } });
/** How many practice calls asked this question or topic. */
function PractisedCount({ count }) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return <span data-practised={n} title={n ? `Asked in ${n} practice call${n === 1 ? '' : 's'}` : 'Not asked in a practice call yet'} className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${n ? 'bg-emerald-500/20 text-emerald-100' : 'bg-white/10 text-white/50'}`}>Practised ×{n}</span>;
}
const sameQuestion = (left, right) => String(left || '').trim().toLocaleLowerCase() === String(right || '').trim().toLocaleLowerCase();

function CardForm({ card, scope, onSave, onCancel, busy }) {
  const [draft, setDraft] = useState(() => ({ ...card, variants: [...(card.variants || [])], bullets: (card.bullets || []).map(item => ({ ...item })), extensions: (card.extensions || []).map(item => ({ ...item })), approach: (card.approach || []).map(item => ({ ...item })) }));
  const [error, setError] = useState('');
  const nextExtension = useRef(0);
  const field = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const save = async event => {
    event.preventDefault();
    if (!draft.question.trim()) { setError('Write a question before saving.'); return; }
    setError('');
    try { await onSave({ ...draft, scope, author: 'user' }); }
    catch (failure) { setError(failure?.message || 'Could not save this answer. Your text is still here; try again.'); }
  };
  return <form onSubmit={save} className="space-y-3 rounded-lg border border-blue-400/40 p-3" aria-label={card.id ? `Edit ${card.question}` : `Add ${scope} card`} aria-busy={busy}>
    {scope === 'foundation' && <p className="text-xs text-amber-500">General edits apply to every interview.</p>}
    <fieldset disabled={busy} className="space-y-3">
      <label className="block text-xs">Question<input autoFocus className={inputClass} value={draft.question} onChange={event => field('question', event.target.value)} /></label>
      <label className="block text-xs">Variants (one per line)<textarea className={inputClass} rows={2} value={draft.variants.join('\n')} onChange={event => field('variants', event.target.value.split('\n'))} /></label>
      <label className="block text-xs">Headline<textarea className={inputClass} rows={2} value={draft.headline || ''} onChange={event => field('headline', event.target.value)} /></label>
      <fieldset className="space-y-2"><legend className="text-xs font-medium">Recall bullets</legend>
        {draft.bullets.map((bullet, index) => <div key={index} className="flex items-start gap-2">
          <label className="min-w-0 flex-1 text-xs">Bullet {index + 1}<textarea className={inputClass} rows={2} value={bullet.text} onChange={event => field('bullets', draft.bullets.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /></label>
          <button type="button" className={buttonClass} aria-label={`Remove bullet ${index + 1}`} onClick={() => field('bullets', draft.bullets.filter((_, i) => i !== index))}>Remove</button>
        </div>)}
        <button type="button" className={buttonClass} onClick={() => field('bullets', [...draft.bullets, { text: '' }])}>Add bullet</button>
      </fieldset>
      <label className="block text-xs">Example<textarea className={inputClass} rows={3} value={draft.example || ''} onChange={event => field('example', event.target.value)} /></label>
      <fieldset className="space-y-2"><legend className="text-xs font-medium">Extension points (optional)</legend>
        {draft.extensions.map((extension, index) => <div key={extension.id || index} className="flex items-start gap-2">
          <label className="min-w-0 flex-1 text-xs">Extension {index + 1}<textarea className={inputClass} rows={2} value={extension.text} onChange={event => field('extensions', draft.extensions.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /></label>
          <button type="button" className={buttonClass} aria-label={`Remove extension ${index + 1}`} onClick={() => field('extensions', draft.extensions.filter((_, i) => i !== index))}>Remove</button>
        </div>)}
        <button type="button" className={buttonClass} onClick={() => field('extensions', [...draft.extensions, { id: `user-${Date.now()}-${++nextExtension.current}`, text: '' }])}>Add extension</button>
      </fieldset>
      <label className="block text-xs">Approach reminders (one per line, optional)<textarea className={inputClass} rows={3} placeholder="For how-do-you-work questions, e.g. Split work into small tasks" value={draft.approach.map(item => item.text).join('\n')} onChange={event => { const lines = event.target.value.split('\n'); const byPosition = lines.length === draft.approach.length; field('approach', lines.map((line, index) => ({ text: line, example: (byPosition ? draft.approach[index]?.example : draft.approach.find(item => item.text === line)?.example) || '' }))); }} /><span className="mt-1 block text-white/60">When a card has these, the cue card shows them instead of the lines above; you supply the real example as you speak.</span></label>
      {error && <p role="alert" className="text-xs text-amber-500">{error}</p>}
      <section aria-label="Interview card preview" className="space-y-2"><h4 className="text-xs font-medium">On the interview card</h4><InterviewCardPreview card={draft} scope={scope} /></section>
      <div className="flex gap-2"><button type="submit" className={buttonClass}>Save</button><button type="button" className={buttonClass} onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>;
}

function QaCard({ card, scope, company, links, mutate, busy, readOnly }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setError('');
    try { await mutate('delete', scope, card); setConfirmDelete(false); }
    catch (failure) { setError(failure?.message || 'Could not delete this card. Try again.'); }
  };
  return <article className="rounded-lg border border-white/15" aria-label={card.question}>
    <button type="button" className="flex w-full items-start gap-2 p-2 text-left hover:bg-white/5" aria-expanded={open || editing} onClick={() => setOpen(value => !value)}>
      <span className="min-w-0 flex-1 text-xs font-medium">{card.question}{(card.status === 'needs-prep' || card.status === 'empty') && <span className="ml-1 text-amber-500">· no answer yet</span>}</span>
      <PractisedCount count={card.practiced} />
    </button>
    {(open || editing) && <div className="space-y-2 border-t border-white/10 p-3">
    {editing ? <CardForm card={card} scope={scope} busy={busy || readOnly} onCancel={() => setEditing(false)} onSave={async draft => { await mutate('save', scope, draft); setEditing(false); }} /> : <>
      <InterviewQaBadges card={card} details />
      {card.variants?.length > 0 && <details className="text-xs text-white/60"><summary className="cursor-pointer">Question variants ({card.variants.length})</summary><ul className="list-disc pl-4">{card.variants.map((variant, index) => <li key={index}>{variant}</li>)}</ul></details>}
      {(card.status === 'needs-prep' || card.status === 'empty') && <p className="text-xs text-amber-500">No prepared answer yet. Write your own answer, or Prepare to fill empty answers.</p>}
      {card.approach?.length > 0 && <div className="text-xs"><p className="font-medium">Approach reminders (shown on the cue card)</p><ul className="list-disc pl-4">{card.approach.map((item, index) => <li key={index}>{item.text}{item.example && <ul className="list-[circle] pl-4 text-white/60"><li>{item.example}</li></ul>}</li>)}</ul></div>}
      {card.headline && <p className="whitespace-pre-wrap text-sm font-medium">{card.headline}</p>}
      {card.bullets?.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs">{card.bullets.map((bullet, index) => <li key={index}>{bullet.stage && <span className="text-white/60">{bullet.stage}: </span>}{bullet.text}</li>)}</ul>}
      {card.example && <div className="text-xs"><p className="font-medium">Example</p><p className="whitespace-pre-wrap">{card.example}</p></div>}
      {card.extensions?.length > 0 && <details className="text-xs"><summary className="cursor-pointer">Extension points (optional)</summary><ul className="list-disc pl-4">{card.extensions.map((item, index) => <li key={item.id || index}>{item.text}</li>)}</ul></details>}
      {card.thinEvidence && <p className="text-xs text-amber-500">Thin evidence — use only details you can support.</p>}
      <div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy || readOnly} onClick={() => { setEditing(true); setError(''); }}>Edit</button><button type="button" className={buttonClass} disabled={busy || readOnly} onClick={() => setConfirmDelete(true)}>Delete</button></div>
    </>}
    {links?.length > 0 && <ul className="space-y-1 border-t border-white/15 pt-2 text-xs text-white/60">{links.map((link, index) => <li key={index}>Also asked at {company || 'this company'}: “{link.question}”{(/^https?:\/\//i.test(link.sourceUrl || '')) && <> — <a className="underline" href={link.sourceUrl} target="_blank" rel="noreferrer">source</a></>}</li>)}</ul>}
    {confirmDelete && <div role="group" aria-label="Confirm card deletion" className="space-y-2 rounded-md border border-amber-500/40 p-2 text-xs">
      <p>Delete “{card.question}”?{scope === 'foundation' ? ' This applies to every interview.' : ''}</p>
      <div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy || readOnly} onClick={() => { void remove(); }}>Confirm delete</button><button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmDelete(false)}>Keep card</button></div>
    </div>}
    {error && <p role="alert" className="text-xs text-amber-500">{error}</p>}
    </div>}
  </article>;
}

function QaSection({ scope, section, company, foundationLinks, mutate, busy, readOnly }) {
  const [adding, setAdding] = useState(false);
  const title = scope === 'foundation' ? 'General Q&A · shared across all interviews' : `${company || 'This job'} Q&A · this company and posting`;
  return <section className="space-y-2" aria-label={title}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">{title}</h3><button type="button" className={buttonClass} disabled={busy || readOnly || adding} onClick={() => setAdding(true)}>Add card</button></div>
    {scope === 'foundation' && <p className="text-[11px] text-white/60">Editing this shared set applies to every interview.</p>}
    {scope === 'company' && <p className="text-[11px] text-white/60">Another interview for the same company and posting shows this same set.</p>}
    {!section.cards.length && <p className="text-xs text-white/60">No cards yet. Add your own question or Prepare to get started.</p>}
    {adding && <CardForm scope={scope} card={{ scope, question: '', variants: [], headline: '', bullets: [], example: '', extensions: [], approach: [], origin: 'user', source: null, author: 'user', status: 'empty', thinEvidence: false }} busy={busy || readOnly}
      onCancel={() => setAdding(false)} onSave={async draft => { await mutate('add', scope, draft); setAdding(false); }} />}
    {section.cards.map(card => <QaCard key={card.id} card={card} scope={scope} company={company} links={scope === 'foundation' ? foundationLinks.filter(link => sameQuestion(link.foundationQuestion, card.question)) : []} mutate={mutate} busy={busy} readOnly={readOnly} />)}
  </section>;
}

/** Technical topics: subjects only. A practice interviewer makes up its own question on a topic each call. */
function TopicsSection({ topics, company, mutateTopic, busy, readOnly }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const run = async (operation, value) => {
    setError('');
    try { await mutateTopic(operation, value); if (operation === 'add') setDraft(''); }
    catch (failure) { setError(failure?.message || 'Could not change the topics. Try again.'); }
  };
  return <section className="space-y-2" aria-label="Technical topics">
    <h3 className="text-xs font-semibold">Technical topics · {company || 'this job'}</h3>
    <p className="text-[11px] text-white/60">Topics only, with no prepared answers: the right answer depends on how the question is asked. A practice interviewer makes up its own question on a topic each call.</p>
    {!topics.length && <p className="text-xs text-white/60">No topics yet. Prepare lists them from the job posting, or add your own.</p>}
    <ul className="space-y-1">{topics.map(topic => <li key={topic.id} className="flex items-center gap-2 rounded-lg border border-white/15 p-2 text-xs">
      <span className="min-w-0 flex-1">{topic.text}{topic.author === 'user' && <span className="ml-1 text-[10px] text-white/45">· added by you</span>}</span>
      <PractisedCount count={topic.practiced} />
      <button type="button" className={buttonClass} aria-label={`Delete topic ${topic.text}`} disabled={busy || readOnly} onClick={() => { void run('delete', topic.id); }}>Delete</button>
    </li>)}</ul>
    <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); if (draft.trim()) void run('add', draft.trim()); }}>
      <label className="min-w-0 flex-1 text-xs">Add a topic<input className={inputClass} maxLength={160} value={draft} disabled={busy || readOnly} placeholder="e.g. SQL query tuning" onChange={event => setDraft(event.target.value)} /></label>
      <button type="submit" className={buttonClass} disabled={busy || readOnly || !draft.trim()}>Add</button>
    </form>
    {error && <p role="alert" className="text-xs text-amber-500">{error}</p>}
  </section>;
}

const TABS = ['foundation', 'company', 'topics'];

/**
 * The saved Q&A of one interview, always on screen beside its setup: the General
 * set, this company and posting's set, and its technical topics. Each question
 * shows how many practice calls asked it.
 */
export function InterviewQaPanel({ nodeId, snapshotId, jobUrl = null, bundleArtifactId = null, refreshKey, disabled = false }) {
  const [qa, setQa] = useState(emptyQa);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('foundation');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const mutating = useRef(false);
  const reload = useCallback(async () => {
    if (!window.electronAPI?.loadInterviewQa || mutating.current) return;
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {
      const reply = await window.electronAPI.loadInterviewQa({ nodeId, snapshotId: snapshotId || null, jobUrl: jobUrl || null, bundleArtifactId: bundleArtifactId || null });
      if (reply?.success === false) throw new Error(reply.error || 'Q&A response was invalid.');
      if (!Array.isArray(reply?.foundation?.cards) || !Array.isArray(reply?.company?.cards)) throw new Error('Q&A response was invalid.');
      if (request === sequence.current) setQa({ ...reply, company: { ...reply.company, topics: Array.isArray(reply.company.topics) ? reply.company.topics : [] } });
    } catch (failure) { if (request === sequence.current) setError(failure?.message || 'Could not load Q&A. Try again.'); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [bundleArtifactId, jobUrl, nodeId, snapshotId]);
  useEffect(() => {
    // First load runs after commit so the effect body itself never sets state.
    const initial = setTimeout(() => { void reload(); }, 0);
    const changed = event => { if (event.detail?.nodeId !== nodeId) void reload(); };
    window.addEventListener('interview-qa-changed', changed);
    window.addEventListener('focus', reload);
    return () => { clearTimeout(initial); sequence.current += 1; window.removeEventListener('interview-qa-changed', changed); window.removeEventListener('focus', reload); };
  }, [nodeId, reload, refreshKey]);
  const guarded = async (run) => {
    if (disabled || mutating.current) throw new Error('Q&A is busy. Try again in a moment.');
    mutating.current = true; sequence.current += 1; setLoading(false); setBusy(true);
    try { await run(); } finally { mutating.current = false; setBusy(false); }
  };
  const mutate = (operation, scope, card) => guarded(async () => {
    const method = { save: 'saveInterviewQaCard', add: 'addInterviewQaCard', delete: 'deleteInterviewQaCard' }[operation];
    if (!window.electronAPI?.[method]) throw new Error('Q&A editing is unavailable in this app version.');
    const reply = await window.electronAPI[method](operation === 'delete' ? { nodeId, scope, cardId: card.id } : { nodeId, scope, card });
    if (reply?.success === false) throw new Error(`${reply.error || 'Q&A update failed.'} Your text has been kept.`);
    if (!Array.isArray(reply?.cards)) throw new Error('Q&A update response was invalid. Your text has been kept.');
    // An edit reply carries no counts: keep the ones already shown.
    setQa(previous => {
      const counts = new Map(previous[scope].cards.map(item => [item.id, item.practiced]));
      return { ...previous, [scope]: { ...previous[scope], ...reply, cards: reply.cards.map(item => ({ ...item, practiced: counts.get(item.id) || 0 })), ...(scope === 'company' ? { topics: previous.company.topics } : {}) } };
    });
    // Other interviews reload the shared sets; local edits use the
    // authoritative returned section instead of a second, racing read.
    window.dispatchEvent(new window.CustomEvent('interview-qa-changed', { detail: { nodeId, scope } }));
  });
  const mutateTopic = (operation, value) => guarded(async () => {
    const method = operation === 'add' ? 'addInterviewQaTopic' : 'deleteInterviewQaTopic';
    if (!window.electronAPI?.[method]) throw new Error('Topic editing is unavailable in this app version.');
    const reply = await window.electronAPI[method](operation === 'add' ? { nodeId, text: value } : { nodeId, topicId: value });
    if (reply?.success === false) throw new Error(reply.error || 'The topics could not be changed.');
    if (!Array.isArray(reply?.topics)) throw new Error('The topics could not be changed.');
    setQa(previous => ({ ...previous, company: { ...previous.company, topics: reply.topics } }));
    window.dispatchEvent(new window.CustomEvent('interview-qa-changed', { detail: { nodeId, scope: 'company' } }));
  });
  const topics = qa.company.topics || [];
  const company = qa.company.company;
  const labels = { foundation: `General ${qa.foundation.cards.length}`, company: `${company || 'This job'} ${qa.company.cards.length}`, topics: `Technical topics ${topics.length}` };
  return <aside aria-label="Interview Q&A" data-testid="interview-qa-panel" className="flex min-h-0 flex-col border-t border-white/10 lg:h-full lg:w-[440px] lg:shrink-0 lg:border-l lg:border-t-0">
    <div role="tablist" aria-label="Saved Q&A" className="flex shrink-0 gap-1 border-b border-white/10 p-2">
      {TABS.map(key => <button key={key} type="button" role="tab" aria-selected={tab === key} className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-[11px] ${tab === key ? 'bg-violet-500/25 text-white' : 'text-white/60 hover:bg-white/5'}`} onClick={() => setTab(key)}>{labels[key]}</button>)}
    </div>
    <div role="tabpanel" className="min-h-0 flex-1 space-y-3 p-3 lg:overflow-y-auto">
      {disabled && <p className="text-xs text-white/60">Q&A editing is off while this interview is preparing.</p>}
      {loading && <p role="status" className="text-xs text-white/60">Loading Q&A…</p>}
      {error && <p role="alert" className="text-xs text-amber-200">{error} <button type="button" className="underline" disabled={loading || busy} onClick={() => { void reload(); }}>Retry loading Q&A</button></p>}
      {tab === 'foundation' && <QaSection scope="foundation" section={qa.foundation} company={company} foundationLinks={qa.company.foundationLinks || []} mutate={mutate} busy={busy} readOnly={disabled} />}
      {tab === 'company' && <QaSection scope="company" section={qa.company} company={company} foundationLinks={[]} mutate={mutate} busy={busy} readOnly={disabled} />}
      {tab === 'topics' && <TopicsSection topics={topics} company={company} mutateTopic={mutateTopic} busy={busy} readOnly={disabled} />}
      {tab !== 'topics' && <details className="rounded-lg border border-white/10 p-2 text-xs"><summary className="cursor-pointer text-white/70">Test which card a question matches</summary><div className="pt-2"><InterviewQaMatchTester foundationCards={qa.foundation.cards} companyCards={qa.company.cards} company={company} /></div></details>}
    </div>
  </aside>;
}
