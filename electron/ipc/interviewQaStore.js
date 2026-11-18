/**
 * Editable Interview Q&A: one General set (questions asked at every interview,
 * shared by every interview; its internal scope name is still `foundation`) and
 * one set per job posting (scope `company`). Two interviews for the same
 * company and posting share that set, its technical topics and its practice
 * state; see bindInterviewQaPosting.
 *
 * Cards keep the sealed answer-bank card shape (headline/bullets/example with
 * evidence IDs) plus `scope`, `origin`, `source`, `author` and `status`, so the
 * live window can match and display them like prepared cards.
 *
 * Preparation is FILL-ONLY: a card whose answer is not empty (generated or
 * written by the user) is never replaced; only empty or new questions receive
 * generated answers, and a deleted question (tombstone) never returns.
 *
 * Files are private main-process data (0600 under a 0700 directory, atomic
 * replace, no symlinks). User-authored text is trusted as the user's own words
 * and is only bounds-checked.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { INTERVIEW_FOUNDATION_QUESTIONS } from '../../src/utils/interviewAnswerQuestions.js';
import { interviewLastRole } from './interviewAnswerBank.js';

 const INTERVIEW_QA_DIRECTORY = 'interview-helper-qa';
const STORE_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_CARDS = 80;
const MAX_QUESTION = 300;
const MAX_LINE = 600;
const MAX_EXAMPLE = 1200;
const MAX_BULLETS = 6;
const MAX_EXTENSIONS = 6;
const MAX_VARIANTS = 8;
const MAX_APPROACH = 6;
const MAX_APPROACH_LINE = 200;
const MAX_TOMBSTONES = 200;
const MAX_LINKS = 40;
const SCOPES = new Set(['foundation', 'company']);
const ORIGINS = new Set(['catalog', 'disclosed', 'posting', 'research', 'user']);
// Control characters other than tab/newline/carriage return are refused.
const hasControl = value => [...value].some(character => { const code = character.codePointAt(0); return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127; });

export const normalizeQuestion = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const FOUNDATION_KEYS = new Set(INTERVIEW_FOUNDATION_QUESTIONS.map(item => normalizeQuestion(item.question)));
export const isFoundationQuestion = question => FOUNDATION_KEYS.has(normalizeQuestion(question));

const text = (value, max) => typeof value === 'string' && value.length <= max && !hasControl(value);
const statementText = statement => (typeof statement === 'string' ? statement : statement?.text || '').trim();

/** Stored approach reminders as `[{ text, example }]`; malformed entries are dropped. */
export function approachOf(card) {
  return (Array.isArray(card?.approach) ? card.approach : [])
    .map(item => ({ text: typeof item?.text === 'string' ? item.text.trim() : '', example: typeof item?.example === 'string' ? item.example.trim() : '' }))
    .filter(item => item.text && text(item.text, MAX_APPROACH_LINE) && text(item.example, MAX_EXAMPLE)).slice(0, MAX_APPROACH);
}
const recentEmployerOf = store => (typeof store?.recentEmployer === 'string' && text(store.recentEmployer, 200) ? store.recentEmployer.trim() : '');

/** A card is answered when its headline, any bullet or its example has text. */
export function isAnsweredCard(card) {
  return !!(statementText(card?.headline) || (card?.bullets || []).some(item => statementText(item)) || statementText(card?.example));
}

function cardStatus(card) {
  if (isAnsweredCard(card)) return 'ready';
  return card?.origin === 'disclosed' || card?.origin === 'posting' ? 'needs-prep' : 'empty';
}

// ---------------------------------------------------------------- storage --

async function storeRoot(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('Interview Q&A storage is unavailable.');
  const root = path.join(userDataPath, INTERVIEW_QA_DIRECTORY);
  await fs.promises.mkdir(path.join(root, 'company'), { recursive: true, mode: 0o700 });
  for (const directory of [root, path.join(root, 'company')]) {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Interview Q&A storage is unsafe.');
  }
  return root;
}

// Which posting each interview belongs to. An interview with no posting yet keeps a set of its own.
const ALIAS_FILE = 'aliases.json';
const MAX_ALIASES = 2000;
const POSTING_KEY = /^[a-f0-9]{64}$/u;
const aliasCaches = new Map();
function aliasesOf(userDataPath) {
  if (!aliasCaches.has(userDataPath)) {
    const loading = (async () => {
      const root = await storeRoot(userDataPath);
      const map = new Map();
      try {
        const file = path.join(root, 'company', ALIAS_FILE);
        const stat = await fs.promises.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_STORE_BYTES) {
          const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
          for (const [nodeId, key] of Object.entries(parsed?.aliases || {})) if (typeof key === 'string' && POSTING_KEY.test(key)) map.set(nodeId, key);
        }
      } catch { /* no alias file yet, or an unreadable one: every interview keeps its own set */ }
      return map;
    })();
    loading.catch(() => { if (aliasCaches.get(userDataPath) === loading) aliasCaches.delete(userDataPath); });
    aliasCaches.set(userDataPath, loading);
  }
  return aliasCaches.get(userDataPath);
}
const storeKeyOf = (aliases, nodeId) => (aliases?.has(String(nodeId)) ? `posting:${aliases.get(String(nodeId))}` : String(nodeId));

function storeFile(root, scope, nodeId, aliases = null) {
  if (scope === 'foundation') return path.join(root, 'foundation.json');
  const key = crypto.createHash('sha256').update(storeKeyOf(aliases, nodeId)).digest('hex');
  return path.join(root, 'company', `${key}.json`);
}

/** The key the posting set and its practice counts are filed under: the posting when bound, else the interview. */
export async function interviewQaStoreKey({ userDataPath, nodeId }) {
  return storeKeyOf(await aliasesOf(userDataPath), nodeId);
}

/**
 * The identity of a job posting for Q&A: the company, the posting link and the
 * role title. Two roles with the same title but different postings differ.
 */
export function interviewQaPostingKey({ company = '', jobUrl = '', title = '' } = {}) {
  const url = String(jobUrl || '').trim();
  if (!url) return null;
  return crypto.createHash('sha256').update(JSON.stringify(['interview-qa-posting', companyKey(company), url, normalizeQuestion(title)])).digest('hex');
}

/**
 * Points an interview at its posting's Q&A set. The first interview bound to a
 * posting brings the set it already had; later ones share the posting's set.
 * Resolves to false when nothing changed, else `{ adopted, storeKey }`.
 */
export async function bindInterviewQaPosting({ userDataPath, nodeId, postingKey }) {
  if (typeof postingKey !== 'string' || !POSTING_KEY.test(postingKey) || typeof nodeId !== 'string' || !nodeId) return false;
  const aliases = await aliasesOf(userDataPath);
  if (aliases.get(nodeId) === postingKey) return false;
  return serialized(`${userDataPath}\u0000aliases`, async () => {
    if (aliases.get(nodeId) === postingKey) return false;
    const root = await storeRoot(userDataPath);
    const target = storeFile(root, 'company', nodeId, new Map([[nodeId, postingKey]]));
    const own = storeFile(root, 'company', nodeId, null);
    const exists = async file => { try { const stat = await fs.promises.lstat(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };
    let adopted = false;
    if (!aliases.has(nodeId) && !(await exists(target)) && await exists(own)) {
      try { await fs.promises.copyFile(own, target, fs.constants.COPYFILE_EXCL); adopted = true; } catch { /* the posting's set appeared meanwhile: share it */ }
    }
    aliases.delete(nodeId); aliases.set(nodeId, postingKey);
    while (aliases.size > MAX_ALIASES) aliases.delete(aliases.keys().next().value);
    const file = path.join(root, 'company', ALIAS_FILE);
    const tmp = path.join(root, 'company', `.${ALIAS_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, aliases: Object.fromEntries(aliases) }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.promises.rename(tmp, file);
    } finally { await fs.promises.rm(tmp, { force: true }).catch(() => {}); }
    // `adopted`: the posting's set started as this interview's own set, so its practice counts belong to it too.
    return { adopted, storeKey: storeKeyOf(aliases, nodeId) };
  });
}

function emptyStore(scope) {
  return { version: STORE_VERSION, scope, company: '', cards: [], tombstones: [], foundationLinks: [] };
}

async function readStore(userDataPath, scope, nodeId) {
  const file = storeFile(await storeRoot(userDataPath), scope, nodeId, scope === 'company' ? await aliasesOf(userDataPath) : null);
  let stat;
  try { stat = await fs.promises.lstat(file); } catch { return emptyStore(scope); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw new Error('Interview Q&A storage is unsafe.');
  let parsed;
  try { parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { throw new Error('Interview Q&A storage is unreadable.'); }
  if (!parsed || parsed.version !== STORE_VERSION || parsed.scope !== scope || !Array.isArray(parsed.cards)) throw new Error('Interview Q&A storage is unreadable.');
  return {
    ...emptyStore(scope), ...parsed,
    cards: parsed.cards.filter(card => card && typeof card.id === 'string' && typeof card.question === 'string').slice(0, MAX_CARDS),
    tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones.filter(item => typeof item === 'string').slice(-MAX_TOMBSTONES) : [],
    foundationLinks: Array.isArray(parsed.foundationLinks) ? parsed.foundationLinks.slice(0, MAX_LINKS) : [],
  };
}

async function writeStore(userDataPath, scope, nodeId, store) {
  const root = await storeRoot(userDataPath);
  const file = storeFile(root, scope, nodeId, scope === 'company' ? await aliasesOf(userDataPath) : null);
  const encoded = JSON.stringify({ ...store, version: STORE_VERSION, scope });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) throw new Error('Interview Q&A is too large to save.');
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.promises.rename(tmp, file);
  } finally { await fs.promises.rm(tmp, { force: true }).catch(() => {}); }
}

// Every store write for one file is serialized so concurrent edits from two
// helpers (both editing the shared Foundation set) cannot lose an update.
const queues = new Map();
function serialized(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(task);
  // The queue tail never rejects: a failed edit is reported to its caller
  // through `next`, and must not become an unhandled rejection here.
  const tail = next.catch(() => {}).finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return next;
}
// Two interviews bound to one posting write the same file, so they share one queue.
async function locked(userDataPath, scope, nodeId, task) {
  const key = scope === 'company' ? storeKeyOf(await aliasesOf(userDataPath), nodeId) : '';
  return serialized(`${userDataPath}\u0000${scope}\u0000${key}`, task);
}

// ------------------------------------------------------------- projection --

/** Public, renderer-safe projection (no evidence IDs or private quotes). */
 function toQaCard(card, scope) {
  return {
    id: card.id, scope, question: card.question,
    variants: Array.isArray(card.variants) ? card.variants.filter(item => typeof item === 'string').slice(0, MAX_VARIANTS) : [],
    headline: statementText(card.headline),
    bullets: (card.bullets || []).map(item => ({ ...(typeof item?.stage === 'string' ? { stage: item.stage } : {}), text: statementText(item) })).filter(item => item.text),
    example: statementText(card.example),
    extensions: (card.extensions || []).map((item, index) => ({ id: typeof item?.id === 'string' ? item.id : `ext-${index + 1}`, text: statementText(item) })).filter(item => item.text),
    approach: approachOf(card),
    origin: ORIGINS.has(card.origin) ? card.origin : 'catalog',
    source: card.source && typeof card.source.url === 'string' ? { url: card.source.url, date: String(card.source.date || 'unknown'), quote: String(card.source.quote || '') } : null,
    author: card.author === 'user' ? 'user' : 'generated',
    status: cardStatus(card),
    thinEvidence: card.thinEvidence === true,
  };
}

function section(store, scope) {
  const recentEmployer = recentEmployerOf(store);
  const cards = store.cards.map(card => ({ ...toQaCard(card, scope), ...(recentEmployer ? { recentEmployer } : {}) }));
  const status = !cards.length ? 'missing' : cards.every(card => card.status === 'ready') ? 'ready' : 'partial';
  return scope === 'company'
    ? { status, company: store.company || '', cards, topics: topicsOf(store), foundationLinks: store.foundationLinks.map(link => ({ foundationQuestion: link.foundationQuestion, question: link.question, sourceUrl: link.sourceUrl })) }
    : { status, cards };
}

export async function loadInterviewQa({ userDataPath, nodeId }) {
  const [foundation, company] = await Promise.all([readStore(userDataPath, 'foundation', nodeId), readStore(userDataPath, 'company', nodeId)]);
  return { foundation: section(foundation, 'foundation'), company: section(company, 'company') };
}

// ------------------------------------------------------------- user edits --

function userStatement(value, max) {
  const value_ = typeof value === 'string' ? value.trim() : '';
  if (!text(value_, max)) throw new Error('This Q&A text is too long or contains unsupported characters.');
  return { text: value_, evidenceIds: [], quotes: [] };
}

/** Validate and normalize a user edit payload into the stored card shape. */
 function userCardFromPayload(payload, { id }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('This Q&A card is invalid.');
  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  if (!question || !text(question, MAX_QUESTION)) throw new Error('Write a question (up to 300 characters) before saving.');
  const variants = (Array.isArray(payload.variants) ? payload.variants : []).map(item => String(item || '').trim()).filter(Boolean);
  if (variants.length > MAX_VARIANTS || variants.some(item => !text(item, MAX_QUESTION))) throw new Error('Keep at most 8 short question variants.');
  const bullets = (Array.isArray(payload.bullets) ? payload.bullets : []).map(item => (typeof item === 'string' ? item : item?.text) || '').map(item => item.trim()).filter(Boolean);
  if (bullets.length > MAX_BULLETS) throw new Error('Keep at most 6 recall bullets.');
  const extensions = (Array.isArray(payload.extensions) ? payload.extensions : []).map(item => (typeof item === 'string' ? item : item?.text) || '').map(item => item.trim()).filter(Boolean);
  if (extensions.length > MAX_EXTENSIONS) throw new Error('Keep at most 6 extension points.');
  const approach = (Array.isArray(payload.approach) ? payload.approach : [])
    .map(item => ({ text: String((typeof item === 'string' ? item : item?.text) || '').trim(), example: String((typeof item === 'string' ? '' : item?.example) || '').trim() })).filter(item => item.text);
  if (approach.length > MAX_APPROACH || approach.some(item => !text(item.text, MAX_APPROACH_LINE) || !text(item.example, MAX_EXAMPLE))) throw new Error('Keep at most 6 short approach reminders.');
  return {
    id, question, variants,
    headline: userStatement(payload.headline || '', MAX_LINE),
    bullets: bullets.map(item => ({ stage: 'point', ...userStatement(item, MAX_LINE) })),
    example: userStatement(payload.example || '', MAX_EXAMPLE),
    extensions: extensions.map((item, index) => ({ id: `user-ext-${index + 1}`, ...userStatement(item, MAX_LINE) })),
    // Always present after an edit: an emptied list means "none", not "not yet written".
    approach,
    consistency: { consistentWithResume: false, resumeQuote: '' },
    thinEvidence: false,
    author: 'user', updatedAt: new Date().toISOString(),
  };
}

function assertScope(scope) { if (!SCOPES.has(scope)) throw new Error('This Q&A section is invalid.'); }

export async function saveInterviewQaCard({ userDataPath, nodeId, scope, card }) {
  assertScope(scope);
  return locked(userDataPath, scope, nodeId, async () => {
    const store = await readStore(userDataPath, scope, nodeId);
    const index = store.cards.findIndex(item => item.id === card?.id);
    if (index < 0) throw new Error('This Q&A card no longer exists. Reload Q&A and try again.');
    const previous = store.cards[index];
    const edited = userCardFromPayload(card, { id: previous.id });
    if (store.cards.some(item => item.id !== previous.id && normalizeQuestion(item.question) === normalizeQuestion(edited.question))) {
      throw new Error('That question is already in this section.');
    }
    // No reminders before and none now means "not written yet", so the next
    // Prepare may still write them; an emptied list stays empty.
    if (!edited.approach.length && !Array.isArray(previous.approach)) delete edited.approach;
    store.cards[index] = { ...edited, origin: previous.origin || 'catalog', source: previous.source || null };
    await writeStore(userDataPath, scope, nodeId, store);
    return section(store, scope);
  });
}

export async function addInterviewQaCard({ userDataPath, nodeId, scope, card }) {
  assertScope(scope);
  return locked(userDataPath, scope, nodeId, async () => {
    const store = await readStore(userDataPath, scope, nodeId);
    if (store.cards.length >= MAX_CARDS) throw new Error('This Q&A section is full. Delete a card first.');
    const added = userCardFromPayload(card, { id: `user-${crypto.randomBytes(6).toString('hex')}` });
    if (store.cards.some(item => normalizeQuestion(item.question) === normalizeQuestion(added.question))) throw new Error('That question is already in this section.');
    // A new question with no reminders is still open for the next Prepare to write them.
    if (!added.approach.length) delete added.approach;
    store.cards.push({ ...added, origin: 'user', source: null });
    store.tombstones = store.tombstones.filter(item => item !== normalizeQuestion(added.question));
    await writeStore(userDataPath, scope, nodeId, store);
    return section(store, scope);
  });
}

export async function deleteInterviewQaCard({ userDataPath, nodeId, scope, cardId }) {
  assertScope(scope);
  return locked(userDataPath, scope, nodeId, async () => {
    const store = await readStore(userDataPath, scope, nodeId);
    const card = store.cards.find(item => item.id === cardId);
    if (!card) throw new Error('This Q&A card no longer exists. Reload Q&A and try again.');
    store.cards = store.cards.filter(item => item !== card);
    // A deleted generated question must not come back on the next Prepare.
    store.tombstones = [...store.tombstones.filter(item => item !== normalizeQuestion(card.question)), normalizeQuestion(card.question)].slice(-MAX_TOMBSTONES);
    await writeStore(userDataPath, scope, nodeId, store);
    return section(store, scope);
  });
}

// ------------------------------------------------------------- fill-only --

function generatedCard(card, { origin = 'catalog', source = null } = {}) {
  return { ...structuredClone(card), origin, source, author: 'generated', updatedAt: new Date().toISOString() };
}

function companyKey(value) { return normalizeQuestion(String(value || '').replace(/\b(?:incorporated|inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc)\b\.?/giu, ' ')); }
const isCompanyPlaceholder = value => /^unknown(?: company)?$/iu.test(String(value || '').trim());

function uniqueCardId(store, id, key) {
  const taken = new Set(store.cards.map(item => item.id));
  if (!taken.has(id)) return id;
  for (let n = 1; ; n += 1) {
    const candidate = `g-${crypto.createHash('sha256').update(n === 1 ? key : `${key}#${n}`).digest('hex').slice(0, 12)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function fillCards(store, incoming) {
  const tombstoned = new Set(store.tombstones);
  for (const card of incoming) {
    const key = normalizeQuestion(card.question);
    if (tombstoned.has(key)) continue;
    const index = store.cards.findIndex(item => normalizeQuestion(item.question) === key);
    if (index < 0) {
      // Worker ids are only unique within one bank; another helper's fill may
      // already hold the same id for a different question.
      if (store.cards.length < MAX_CARDS) store.cards.push({ ...card, id: uniqueCardId(store, card.id, key) });
      continue;
    }
    const existing = store.cards[index];
    // FILL-ONLY: an answer that is not empty is kept, whoever wrote it.
    if (isAnsweredCard(existing)) {
      if (card.variants?.length) existing.variants = [...new Set([...(existing.variants || []), ...card.variants])].slice(0, MAX_VARIANTS);
      continue;
    }
    store.cards[index] = { ...card, ...(Array.isArray(existing.approach) ? { approach: existing.approach } : {}), id: existing.id, variants: [...new Set([...(existing.variants || []), ...(card.variants || [])])].slice(0, MAX_VARIANTS),
      origin: existing.origin || card.origin, source: existing.source || card.source };
  }
}

/**
 * Merge a freshly sealed answer bank and mapped disclosures into the stores.
 * `disclosureMapping` items: { question, sourceUrl, sourceDate, evidenceQuote,
 * target: 'foundation' | 'company' | 'none', cardQuestion }.
 */
export async function fillInterviewQaFromPreparation({ userDataPath, nodeId, bank, company = '', disclosureMapping = [] }) {
  const generated = (bank?.cards || []).filter(isAnsweredCard);
  const foundationIncoming = generated.filter(card => isFoundationQuestion(card.question)).map(card => generatedCard(card));
  const companyIncoming = generated.filter(card => !isFoundationQuestion(card.question)).map(card => generatedCard(card));
  // Remembered so the live card can leave the most recent employer unsaid.
  const recentEmployer = (interviewLastRole(bank?.evidence)?.employer || '').trim().slice(0, 200);
  const links = [];
  for (const item of disclosureMapping) {
    const source = { url: item.sourceUrl, date: item.sourceDate || 'unknown', quote: item.evidenceQuote || '' };
    // A company mapping whose card did not survive (e.g. emptied by the fact
    // check) falls through to a needs-prep disclosed card.
    const mapped = item.target === 'company' && item.cardQuestion
      ? companyIncoming.find(entry => normalizeQuestion(entry.question) === normalizeQuestion(item.cardQuestion))
      : null;
    if (item.target === 'foundation' && item.cardQuestion) {
      links.push({ foundationQuestion: item.cardQuestion, question: item.question, sourceUrl: item.sourceUrl });
    } else if (mapped) {
      mapped.variants = [...new Set([...(mapped.variants || []), item.question])].slice(0, MAX_VARIANTS);
      if (!mapped.source) { mapped.origin = 'disclosed'; mapped.source = source; }
    } else if (!companyIncoming.some(entry => normalizeQuestion(entry.question) === normalizeQuestion(item.question))) {
      companyIncoming.push({ id: `disclosed-${crypto.createHash('sha256').update(normalizeQuestion(item.question)).digest('hex').slice(0, 12)}`,
        question: item.question, variants: [], headline: { text: '', evidenceIds: [], quotes: [] }, bullets: [],
        example: { text: '', evidenceIds: [], quotes: [] }, extensions: [], consistency: { consistentWithResume: false, resumeQuote: '' },
        thinEvidence: false, origin: 'disclosed', source, author: 'generated', updatedAt: new Date().toISOString() });
    }
  }
  await locked(userDataPath, 'foundation', nodeId, async () => {
    const store = await readStore(userDataPath, 'foundation', nodeId);
    fillCards(store, foundationIncoming);
    if (recentEmployer) store.recentEmployer = recentEmployer;
    await writeStore(userDataPath, 'foundation', nodeId, store);
  });
  await locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const incomingCompany = String(company || '').trim().slice(0, 200);
    const priorCompany = String(store.company || '').trim();
    // A placeholder or a legal-suffix spelling ("Acme" vs "Acme, Inc.") is the same company.
    if (incomingCompany && priorCompany && !isCompanyPlaceholder(incomingCompany) && !isCompanyPlaceholder(priorCompany)
      && companyKey(incomingCompany) !== companyKey(priorCompany)) {
      // Re-pointed at another company: the old company's generated answers,
      // links and deletions do not apply. The person's own cards stay.
      store.cards = store.cards.filter(card => card.author === 'user');
      store.foundationLinks = [];
      store.tombstones = [];
    }
    fillCards(store, companyIncoming);
    if (recentEmployer) store.recentEmployer = recentEmployer;
    if (incomingCompany && !(isCompanyPlaceholder(incomingCompany) && priorCompany)) store.company = incomingCompany;
    const seen = new Set(store.foundationLinks.map(link => `${normalizeQuestion(link.foundationQuestion)}|${normalizeQuestion(link.question)}`));
    for (const link of links) {
      const key = `${normalizeQuestion(link.foundationQuestion)}|${normalizeQuestion(link.question)}`;
      if (!seen.has(key)) { seen.add(key); store.foundationLinks.push(link); }
    }
    store.foundationLinks = store.foundationLinks.slice(-MAX_LINKS);
    await writeStore(userDataPath, 'company', nodeId, store);
  });
  return loadInterviewQa({ userDataPath, nodeId });
}

// ------------------------------------------------------------ glance cues --

/** Every stored answer line as `{ field, index, statement }` (object statements only). */
function cardStatements(card) {
  const lines = [];
  const add = (field, index, statement) => { if (statement && typeof statement === 'object' && typeof statement.text === 'string' && statement.text.trim()) lines.push({ field, index, statement }); };
  add('headline', 0, card.headline);
  (Array.isArray(card.bullets) ? card.bullets : []).forEach((item, index) => add('bullets', index, item));
  add('example', 0, card.example);
  (Array.isArray(card.extensions) ? card.extensions : []).forEach((item, index) => add('extensions', index, item));
  return lines;
}
const hasCue = statement => typeof statement.cue === 'string' && !!statement.cue.trim();

/**
 * Add a short live-card reminder (`cue`) to stored answer lines that lack one.
 * `generate(units)` receives `[{ id, text }]` and resolves to a Map of id to
 * cue. A cue is saved only while its line still has the text it was written
 * for, so an edit made during the call is never paired with a stale cue.
 */
export async function fillInterviewQaCues({ userDataPath, nodeId, generate, wants = () => true }) {
  const scopes = ['foundation', 'company'];
  const units = [];
  for (const scope of scopes) {
    const store = await readStore(userDataPath, scope, nodeId);
    for (const card of store.cards) {
      for (const { field, index, statement } of cardStatements(card)) {
        if (!hasCue(statement) && wants(statement.text)) units.push({ id: `${scope}:${card.id}.${field}[${index}]`, scope, cardId: card.id, field, index, text: statement.text });
      }
    }
  }
  if (!units.length) return { requested: 0, saved: 0 };
  const cues = await generate(units.map(({ id, text }) => ({ id, text })));
  let saved = 0;
  for (const scope of scopes) {
    const mine = units.filter(unit => unit.scope === scope && typeof cues?.get?.(unit.id) === 'string');
    if (!mine.length) continue;
    await locked(userDataPath, scope, nodeId, async () => {
      const store = await readStore(userDataPath, scope, nodeId);
      let changed = 0;
      for (const unit of mine) {
        const card = store.cards.find(item => item.id === unit.cardId);
        const line = card && cardStatements(card).find(item => item.field === unit.field && item.index === unit.index);
        if (!line || line.statement.text !== unit.text || hasCue(line.statement)) continue;
        line.statement.cue = cues.get(unit.id);
        changed += 1;
      }
      if (changed) await writeStore(userDataPath, scope, nodeId, store);
      saved += changed;
    });
  }
  return { requested: units.length, saved };
}

// ------------------------------------------------------ approach reminders --

/**
 * Add approach reminders to stored cards that have never been considered for
 * them (no `approach` field). `generate(units)` receives
 * `[{ id, question, lines:[{ id, text }] }]` and resolves to a Map of id to
 * `[{ text, example }]`; an empty list is saved too, so a question that is not
 * a "how do you work" question is asked about only once. A card edited while
 * the request ran is left for the next Prepare.
 */
export async function fillInterviewQaApproaches({ userDataPath, nodeId, generate }) {
  const scopes = ['foundation', 'company'];
  const linesOf = card => cardStatements(card).filter(line => line.field !== 'extensions').map(line => ({ id: `${line.field}[${line.index}]`, text: line.statement.text }));
  const units = [];
  for (const scope of scopes) {
    const store = await readStore(userDataPath, scope, nodeId);
    for (const card of store.cards) {
      if (!Array.isArray(card.approach)) units.push({ id: `${scope}:${card.id}`, scope, cardId: card.id, question: card.question, lines: linesOf(card) });
    }
  }
  if (!units.length) return { requested: 0, saved: 0 };
  const approaches = await generate(units.map(({ id, question, lines }) => ({ id, question, lines })));
  let saved = 0;
  for (const scope of scopes) {
    const mine = units.filter(unit => unit.scope === scope && Array.isArray(approaches?.get?.(unit.id)));
    if (!mine.length) continue;
    await locked(userDataPath, scope, nodeId, async () => {
      const store = await readStore(userDataPath, scope, nodeId);
      let changed = 0;
      for (const unit of mine) {
        const card = store.cards.find(item => item.id === unit.cardId);
        if (!card || Array.isArray(card.approach) || card.question !== unit.question) continue;
        const current = new Set(linesOf(card).map(line => line.text));
        card.approach = approachOf({ approach: approaches.get(unit.id) }).map(item => ({ text: item.text, example: current.has(item.example) ? item.example : '' }));
        changed += 1;
      }
      if (changed) await writeStore(userDataPath, scope, nodeId, store);
      saved += changed;
    });
  }
  return { requested: units.length, saved };
}

/** Live-window cards: Foundation then Company, each tagged with its scope. */
export async function loadInterviewQaLiveCards({ userDataPath, nodeId }) {
  const [foundation, company] = await Promise.all([readStore(userDataPath, 'foundation', nodeId), readStore(userDataPath, 'company', nodeId)]);
  return [
    ...foundation.cards.map(card => ({ ...card, scope: 'foundation', recentEmployer: recentEmployerOf(foundation) })),
    ...company.cards.map(card => ({ ...card, scope: 'company', recentEmployer: recentEmployerOf(company) })),
  ];
}

// ------------------------------------------------------ technical topics --

// A technical question has no one prepared answer: how it is asked changes the
// answer. So a posting keeps only a list of technical TOPICS, and a practice
// interviewer makes up its own question on a topic each call.
const MAX_TOPICS = 40;
const MAX_TOPIC = 160;
const TOPIC_ID = /^topic-[a-f0-9]{12}$/u;
const topicKey = value => normalizeQuestion(value);
export const interviewQaTopicId = value => `topic-${crypto.createHash('sha256').update(topicKey(value)).digest('hex').slice(0, 12)}`;
function topicsOf(store) {
  const seen = new Set();
  return (Array.isArray(store?.topics) ? store.topics : []).filter(item => {
    if (!item || typeof item.id !== 'string' || !TOPIC_ID.test(item.id) || typeof item.text !== 'string' || !item.text.trim() || !text(item.text, MAX_TOPIC) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, MAX_TOPICS).map(item => ({ id: item.id, text: item.text.trim(), author: item.author === 'user' ? 'user' : 'generated' }));
}
const topicTombstonesOf = store => (Array.isArray(store?.topicTombstones) ? store.topicTombstones.filter(item => typeof item === 'string').slice(-MAX_TOMBSTONES) : []);
function cleanTopic(value) {
  const topic = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (!topic || !text(topic, MAX_TOPIC) || !topicKey(topic)) throw new Error('Write a topic of up to 160 characters.');
  return topic;
}

export async function loadInterviewQaTopics({ userDataPath, nodeId }) {
  return topicsOf(await readStore(userDataPath, 'company', nodeId));
}

export async function addInterviewQaTopic({ userDataPath, nodeId, text: value }) {
  const topic = cleanTopic(value);
  return locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const topics = topicsOf(store);
    const id = interviewQaTopicId(topic);
    if (topics.some(item => item.id === id)) throw new Error('That topic is already listed.');
    if (topics.length >= MAX_TOPICS) throw new Error('This list holds at most 40 topics. Delete one first.');
    store.topics = [...topics, { id, text: topic, author: 'user' }];
    // Adding a topic back by hand lifts an earlier deletion of it.
    store.topicTombstones = topicTombstonesOf(store).filter(item => item !== id);
    await writeStore(userDataPath, 'company', nodeId, store);
    return section(store, 'company');
  });
}

export async function deleteInterviewQaTopic({ userDataPath, nodeId, topicId }) {
  return locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const topics = topicsOf(store);
    if (!topics.some(item => item.id === topicId)) throw new Error('That topic is no longer listed.');
    store.topics = topics.filter(item => item.id !== topicId);
    store.topicTombstones = [...new Set([...topicTombstonesOf(store), topicId])].slice(-MAX_TOMBSTONES);
    await writeStore(userDataPath, 'company', nodeId, store);
    return section(store, 'company');
  });
}

/**
 * Keeps the posting's topics in step with a Prepare.
 *
 * The topic list itself is written once per posting: after that the person's
 * additions and deletions are never undone. On every Prepare, a question card
 * that has no answer and came from the posting or from reported past interviews
 * is offered to `generate` too; one it marks technical becomes a topic and its
 * card is removed (and stays removed), because a technical question has no one
 * prepared answer. A card the person wrote or answered is never touched.
 *
 * `generate({ needList, questions })` resolves to `{ topics, technical }`, where
 * `technical` is `[{ question, topic }]` for the offered questions that are
 * technical; an array is read as `topics` alone. It is not called when there
 * is nothing to do.
 */
export async function fillInterviewQaTopics({ userDataPath, nodeId, generate }) {
  const convertible = card => !isAnsweredCard(card) && card.author !== 'user' && (card.origin === 'disclosed' || card.origin === 'posting');
  const before = await readStore(userDataPath, 'company', nodeId);
  const needList = !before.topicsGeneratedAt;
  const questions = before.cards.filter(convertible).map(card => card.question);
  if (!needList && !questions.length) return { generated: false, converted: 0, topics: topicsOf(before) };
  const reply = await generate({ needList, questions });
  const proposed = Array.isArray(reply) ? reply : Array.isArray(reply?.topics) ? reply.topics : [];
  const technical = Array.isArray(reply?.technical) ? reply.technical : [];
  return locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const topics = topicsOf(store);
    const taken = new Set([...topics.map(item => item.id), ...topicTombstonesOf(store)]);
    const add = (value) => {
      let topic;
      try { topic = cleanTopic(value); } catch { return; }
      const id = interviewQaTopicId(topic);
      if (taken.has(id) || topics.length >= MAX_TOPICS) return;
      taken.add(id); topics.push({ id, text: topic, author: 'generated' });
    };
    const writeList = !store.topicsGeneratedAt;
    if (writeList) for (const value of proposed) add(value);
    let converted = 0;
    for (const item of technical) {
      const key = normalizeQuestion(item?.question);
      const index = key ? store.cards.findIndex(card => normalizeQuestion(card.question) === key) : -1;
      // Checked again inside the lock: an answer written meanwhile keeps its card.
      if (index < 0 || !convertible(store.cards[index])) continue;
      add(item.topic);
      store.cards.splice(index, 1);
      store.tombstones = [...new Set([...store.tombstones, key])].slice(-MAX_TOMBSTONES);
      converted += 1;
    }
    store.topics = topics;
    if (writeList) store.topicsGeneratedAt = new Date().toISOString();
    if (writeList || converted) await writeStore(userDataPath, 'company', nodeId, store);
    return { generated: writeList, converted, topics };
  });
}

// ---------------------------------------------------------------- practice --

const MAX_PRACTICE_HISTORY = 10;
const practiceOf = store => (store.practice && typeof store.practice === 'object' && !Array.isArray(store.practice) ? store.practice : {});
const validOrder = order => (Array.isArray(order) ? order : []).filter(item => typeof item === 'string' && text(item, MAX_QUESTION)).slice(0, MAX_CARDS);
const hasPractice = practice => !!(practice.order?.length || practice.session || practice.feedback || practice.history?.length);

/** Save the AI-planned practice order (the Claude interviewer gets it as a plan). */
export async function saveInterviewPractice({ userDataPath, nodeId, practice }) {
  const order = validOrder(practice?.order);
  return locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    store.practice = { ...practiceOf(store), order, plannedAt: new Date().toISOString() };
    await writeStore(userDataPath, 'company', nodeId, store);
    return store.practice;
  });
}

export async function loadInterviewPractice({ userDataPath, nodeId }) {
  const practice = practiceOf(await readStore(userDataPath, 'company', nodeId));
  return hasPractice(practice) ? { order: validOrder(practice.order), plannedAt: practice.plannedAt || null, session: practice.session || null, feedback: practice.feedback || null, history: Array.isArray(practice.history) ? practice.history : [] } : null;
}

/** Arm (or replace) the one practice session of this helper; the code itself is never stored. */
export async function saveInterviewPracticeSession({ userDataPath, nodeId, session }) {
  if (!session || typeof session.codeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(session.codeHash)) throw new Error('A practice session needs a code hash.');
  return locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    store.practice = { ...practiceOf(store), session: { ...session, nodeId: String(nodeId) } };
    await writeStore(userDataPath, 'company', nodeId, store);
    return store.practice.session;
  });
}

export async function updateInterviewPracticeSession({ userDataPath, nodeId, patch, when = null }) {
  return locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const practice = practiceOf(store);
    if (!practice.session) return null;
    // Checked inside the queue so a racing finish cannot be overwritten.
    if (typeof when === 'function' && !when(practice.session)) return null;
    store.practice = { ...practice, session: { ...practice.session, ...patch } };
    await writeStore(userDataPath, 'company', nodeId, store);
    return store.practice.session;
  });
}

/** Store the feedback of a finished practice interview, keeping earlier ones as history. */
export async function recordInterviewPracticeFeedback({ userDataPath, nodeId, feedback, receivedAt = new Date().toISOString(), codeHash = null }) {
  return locked(userDataPath, 'company', nodeId, async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const practice = practiceOf(store);
    // The one-shot decision is made here, inside the file's queue: two finish
    // calls racing on the same code cannot both pass a check made outside it.
    if (codeHash && (practice.session?.status !== 'armed' || practice.session.codeHash !== codeHash)) return null;
    const history = Array.isArray(practice.history) ? practice.history : [];
    const entry = { ...feedback, receivedAt, session: practice.session ? { armedAt: practice.session.armedAt || null, company: practice.session.company || '', role: practice.session.role || '' } : null };
    store.practice = {
      ...practice, feedback: entry,
      history: [...(practice.feedback ? [practice.feedback] : []), ...history].slice(0, MAX_PRACTICE_HISTORY),
      session: practice.session ? { ...practice.session, status: 'finished', finishedAt: receivedAt } : null,
    };
    await writeStore(userDataPath, 'company', nodeId, store);
    return entry;
  });
}

/** Every helper's practice session (for the registry's in-memory index). */
export async function listInterviewPracticeSessions({ userDataPath }) {
  const root = await storeRoot(userDataPath);
  let names = [];
  try { names = await fs.promises.readdir(path.join(root, 'company')); } catch { return []; }
  const sessions = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    let parsed;
    try {
      const file = path.join(root, 'company', name);
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) continue;
      parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch { continue; }
    const session = parsed?.practice?.session;
    if (session && typeof session.codeHash === 'string' && typeof session.nodeId === 'string') sessions.push({ nodeId: session.nodeId, session });
  }
  return sessions;
}
