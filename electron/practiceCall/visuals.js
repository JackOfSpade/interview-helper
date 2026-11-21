/**
 * Pictures and diagrams on the interviewer's prepared screens, made during setup so every screen is
 * ready before the call rings, as a real interviewer's would be.
 *
 * The planner decides, per screen part, whether a visual would make the question clearer than text
 * alone (most get none) and asks for one of two kinds:
 * - picture: a photo found by Parallel's image search across the web (the owner's Parallel account,
 *   2026-11-21: the app is for personal use, so licences do not limit the choice), topped up from Wikimedia
 *   Commons when the web gives too few. Several candidates are downloaded and Claude looks at them with the
 *   question beside them, keeping one only if it really fits the question and helps.
 * - diagram: a chart or diagram Claude draws as SVG from the screen's own content. The SVG is checked
 *   against a short list of safe elements and shown as an image, so nothing in it can run.
 * A visual that cannot be made is simply left out: the screen still has its text.
 *
 * Stages (careerWritingCore.js): practice-call-visual-pick and practice-call-diagram, chosen by analogy
 * and not measured. Both run during setup, before the call rings.
 */

export const VISUAL_PICK_STAGE = 'practice-call-visual-pick';
export const VISUAL_DIAGRAM_STAGE = 'practice-call-diagram';
export const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
// Wikimedia asks automated clients to name themselves; no personal details are sent.
export const COMMONS_USER_AGENT = 'InterviewPracticeDesktop/1.0 (practice interview app; image search)';
export const MAX_VISUALS = 4;
export const CANDIDATES = 6;
export const THUMB_WIDTH = 1024;
// Web images are full size (no thumbnails); larger files are skipped.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SVG_CHARS = 60000;
export const VISUALS_BUDGET_MS = 90000;
const DESCRIPTION_MAX = 400;
// The sentence a chosen picture adds to the top of its screen's text.
const LEAD_MAX = 240;
const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
// Free licences found on Commons; anything else (an unusual or missing licence) is skipped.
const FREE_LICENCE = /public domain|^pd\b|cc0|cc[ -]?by|creative commons|gfdl|attribution/iu;

const stripHtml = value => String(value ?? '').replace(/<[^>]*>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&#0?39;/gu, "'").replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/\s+/gu, ' ').trim();
const clip = (value, max) => { const text = String(value ?? '').trim(); return text.length <= max ? text : `${text.slice(0, max - 1)}…`; };

/** The query URL for a Commons file search with image details (thumbnail, licence, author). */
export function commonsSearchUrl(query, { limit = 12, width = THUMB_WIDTH } = {}) {
  const url = new URL(COMMONS_API_URL);
  const params = {
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(limit),
    prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: String(width),
    iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription|ObjectName',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Commons search results as usable candidates, best match first: a free licence, a raster thumbnail, a sensible size. */
export function candidatesFromCommons(body) {
  const pages = Array.isArray(body?.query?.pages) ? body.query.pages : Object.values(body?.query?.pages ?? {});
  return pages
    .slice()
    .sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0))
    .map(page => {
      const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
      if (!info?.thumburl) return null;
      const meta = info.extmetadata || {};
      const licence = stripHtml(meta.LicenseShortName?.value);
      if (!licence || !FREE_LICENCE.test(licence)) return null;
      const width = Number(info.thumbwidth) || 0;
      const height = Number(info.thumbheight) || 0;
      if (width < 400 || height < 250 || width / height > 4 || height / width > 3) return null;
      const author = clip(stripHtml(meta.Artist?.value), 120);
      return {
        title: String(page.title ?? '').replace(/^File:/u, ''), url: info.thumburl, pageUrl: info.descriptionurl || '',
        width, height, licence, author, about: clip(stripHtml(meta.ImageDescription?.value || meta.ObjectName?.value), 300),
      };
    })
    .filter(Boolean);
}

/** Up to `count` candidate images for `query`, downloaded; [] when the search fails. Never throws. */
export async function findCommonsImages({ fetch: fetchImpl = globalThis.fetch, query, signal, count = CANDIDATES } = {}) {
  const words = String(query ?? '').trim();
  if (!words || typeof fetchImpl !== 'function') return [];
  let found = [];
  try {
    const response = await fetchImpl(commonsSearchUrl(words), { headers: { 'User-Agent': COMMONS_USER_AGENT, Accept: 'application/json' }, signal });
    if (!response?.ok) return [];
    found = candidatesFromCommons(await response.json()).slice(0, count);
  } catch { return []; }
  const loaded = await Promise.all(found.map(async item => {
    const image = await downloadImage(fetchImpl, item.url, signal);
    return image ? { ...item, source: 'commons', ...image } : null;
  }));
  return loaded.filter(Boolean);
}

/** Downloads one image: its bytes and type, or null when it is not a usable image. */
async function downloadImage(fetchImpl, url, signal) {
  try {
    const response = await fetchImpl(url, { headers: { 'User-Agent': COMMONS_USER_AGENT, Accept: 'image/*' }, signal });
    if (!response?.ok) return null;
    const mime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(mime)) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
    return { mime, data };
  } catch { return null; }
}

// Stock libraries whose web copies are watermarked previews (the owner, 2026-11-21: a watermark looks
// unprofessional). An image hosted there, or found on one of their pages, is never downloaded; the pick step
// still rejects any watermark it sees on what is left.
export const WATERMARKED_HOSTS = Object.freeze([
  'alamy.com', 'shutterstock.com', 'gettyimages.com', 'gettyimages.co.uk', 'istockphoto.com', 'stock.adobe.com', 'ftcdn.net',
  'dreamstime.com', 'depositphotos.com', '123rf.com', 'bigstockphoto.com', 'canstockphoto.com', 'agefotostock.com',
  'superstock.com', 'pond5.com', 'vectorstock.com', 'stockfresh.com', 'featurepics.com', 'fotosearch.com', 'colourbox.com',
  'masterfile.com', 'photoshelter.com', 'science-photo-library.com', 'sciencephoto.com', 'mediastorehouse.com', 'granger.com',
  'bridgemanimages.com', 'pixtastock.com', 'eyeem.com', 'wallpaperflare.com',
]);
const hostOf = value => { try { return new URL(String(value ?? '')).hostname.toLowerCase(); } catch { return ''; } };
/** True when an image is hosted on, or found on a page of, a stock library that watermarks its previews. */
export const isWatermarkedSource = (...urls) => urls.map(hostOf).some(host => host && WATERMARKED_HOSTS.some(stock => host === stock || host.endsWith(`.${stock}`)));

const usableShape = (width, height) => (!width || !height) || (width >= 400 && height >= 250 && width / height <= 4 && height / width <= 3);

/**
 * Up to `count` web images for a picture, from `searchImages` (Parallel's image search, passed in), downloaded.
 * Sizes are checked when the search knows them. [] when there is no search or it finds nothing. Never throws.
 */
export async function findWebImages({ fetch: fetchImpl = globalThis.fetch, searchImages, query, shows, signal, count = CANDIDATES } = {}) {
  if (typeof searchImages !== 'function' || typeof fetchImpl !== 'function' || !String(query ?? '').trim()) return [];
  let found = [];
  try {
    found = await searchImages({ objective: `A clear, real photograph for a shared screen in a job interview: ${String(shows ?? '').trim()} It must have no watermark of any kind: not a stock-photo preview, no logo stamp, no text overlay, not a collage.`, queries: [String(query).trim()], signal });
  } catch { return []; }
  const usable = (Array.isArray(found) ? found : [])
    .filter(item => item?.imageUrl && usableShape(item.width, item.height) && !isWatermarkedSource(item.imageUrl, item.pageUrl))
    .slice(0, count + 2);
  const loaded = await Promise.all(usable.map(async item => {
    const image = await downloadImage(fetchImpl, item.imageUrl, signal);
    return image ? { title: item.title || '', url: item.imageUrl, pageUrl: item.pageUrl || '', width: item.width, height: item.height, about: '', source: 'web', ...image } : null;
  }));
  return loaded.filter(Boolean).slice(0, count);
}

export const PICK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['choice', 'description'],
  properties: {
    choice: { type: 'integer', minimum: 0, maximum: CANDIDATES, description: 'The number of the image to show, or 0 for none.' },
    description: { type: 'string', maxLength: DESCRIPTION_MAX, description: 'What the chosen image shows, for the interviewer; empty when none.' },
    lead: { type: 'string', maxLength: LEAD_MAX, description: 'One short sentence for the top of the screen text that ties the question to this exact image; empty when the text already fits it or for none.' },
  },
});

/** The prompt for choosing a picture among numbered candidates (the images go with it). */
export function pickPrompt({ screen, shows, candidates }) {
  return [
    'An interviewer is preparing a screen to share during a job interview. It may include one picture, but only if a picture genuinely makes the question clearer or illustrates it better than the text alone. You are shown candidate images found by an image search, numbered in order.',
    '',
    '<screen>',
    `Title: ${screen.title}`,
    screen.content,
    '</screen>',
    '',
    `What the picture is meant to show: ${shows}`,
    '',
    'Candidates:',
    ...candidates.map((item, index) => `${index + 1}. ${item.title}${item.about ? ` (${item.about})` : ''}`),
    '',
    'First, rule out every image with ANY watermark: a stock-agency name or logo across or in a corner of the image, a repeated faint pattern, a "preview" or "sample" stamp, an image ID strip, or any text laid over the photo that is not part of the scene itself. Look closely: a faint or partly hidden watermark still rules the image out. A watermarked picture on an interviewer\'s screen looks unprofessional, so it is never acceptable, however well it fits.',
    'Then choose the one remaining image that best shows what is meant, if one really does. Choose 0 when none fits well: the wrong subject, misleading for the question, poor quality, mostly text, a logo or brand, people who could be identified in an unflattering way, or anything graphic or unsuitable for a professional interview. A screen without a picture is fine; a poor picture is worse than none.',
    'Reply with JSON: choice (the image number, or 0), description (one or two plain sentences on what the chosen image shows, which the interviewer will read so they can talk about it; empty for 0) and lead.',
    'lead: the screen text was written before any picture was found, so on its own it can read as if the picture were an afterthought. Write one short sentence, in the screen\'s own voice, that goes at the top of its text and ties the question to this particular picture, so the screen reads as if it was made around it ("The photo above shows a habitat module on a lunar analogue site in Hawaii; picture yourself living in one for a year."). State only what is plainly visible in the image or certain from its title and page, never a guess about where or what it is, and change nothing about the question itself. Leave it empty when the text already fits the picture, when you are not sure what exactly it shows, or for 0.',
  ].join('\n');
}

export const DIAGRAM_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['svg', 'description'],
  properties: {
    svg: { type: 'string', maxLength: MAX_SVG_CHARS, description: 'The whole SVG document, or empty when a diagram would not help.' },
    description: { type: 'string', maxLength: DESCRIPTION_MAX, description: 'What the diagram shows, for the interviewer.' },
  },
});

export function diagramPrompt({ screen, shows }) {
  return [
    'An interviewer is preparing a screen to share during a job interview. Draw one clear diagram or chart for it as SVG, to sit above the text.',
    '',
    '<screen>',
    `Title: ${screen.title}`,
    screen.content,
    '</screen>',
    '',
    `What the diagram should show: ${shows}`,
    '',
    'Rules:',
    '- Use only what the screen says: every number, name, label and time in the diagram must match the screen exactly. Check each one before you answer. Add nothing the candidate is meant to work out.',
    '- A clean, professional look like a slide: white background, dark text, two or three muted colours, sans-serif text (font-family="Helvetica, Arial, sans-serif") at 14 px or larger, labels that do not overlap.',
    '- One <svg> element with xmlns="http://www.w3.org/2000/svg" and a viewBox, about 800 wide and at most 500 tall.',
    '- Only these elements: svg, g, rect, circle, ellipse, line, polyline, polygon, path, text, tspan, defs, marker, linearGradient, stop, title, desc. No scripts, images, links, fonts, filters, foreignObject, CSS or external references. Markers are referenced as url(#id).',
    '- If a diagram would not make this screen clearer, return an empty svg.',
    'Reply with JSON: svg (the document) and description (one or two plain sentences on what the diagram shows, which the interviewer will read).',
  ].join('\n');
}

const SVG_ELEMENTS = new Set(['svg', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'defs', 'marker', 'lineargradient', 'stop', 'title', 'desc']);

/**
 * The SVG when it uses only the safe elements and attributes, else null. It is shown through an <img>,
 * where nothing could run anyway; this keeps out anything that loads or runs, in case that ever changes.
 */
export function safeSvg(value) {
  const svg = String(value ?? '').trim().replace(/^<\?xml[^>]*\?>\s*/u, '');
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>') || svg.length > MAX_SVG_CHARS) return null;
  if (/<!|<\?|\bon[a-z]+\s*=|javascript:|data:|@import|<style/iu.test(svg)) return null;
  for (const match of svg.matchAll(/<\/?\s*([a-zA-Z][\w:-]*)/gu)) if (!SVG_ELEMENTS.has(match[1].toLowerCase())) return null;
  for (const match of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/giu)) if (!match[1].startsWith('#')) return null;
  for (const match of svg.matchAll(/url\(\s*([^)]*)\)/giu)) if (!match[1].replace(/["'\s]/gu, '').startsWith('#')) return null;
  if (!/viewBox\s*=/u.test(svg)) return null;
  return svg;
}

/**
 * Every visual the plan asks for, made at once within the budget. `parts` is [{ id, kind, search, shows,
 * screen: { title, content } }]. Returns a Map id → { kind, mime, data, description, credit?, source? } of
 * the visuals that were made; the rest are dropped. Never throws.
 */
export async function makeVisuals({ parts = [], fetch: fetchImpl, searchImages = null, pickText, diagramText, signal, onEvent = () => {}, clock = globalThis, budgetMs = VISUALS_BUDGET_MS } = {}) {
  const made = new Map();
  const wanted = (Array.isArray(parts) ? parts : []).slice(0, MAX_VISUALS);
  if (!wanted.length) return made;
  const controller = new AbortController();
  const stop = () => { try { controller.abort(); } catch { /* stopped */ } };
  signal?.addEventListener?.('abort', stop, { once: true });
  let timer = null;
  const over = new Promise(resolve => { timer = clock.setTimeout(() => { stop(); resolve(); }, budgetMs); });
  const note = fields => { try { onEvent(fields); } catch { /* logging is best effort */ } };
  const one = async part => {
    const started = Date.now();
    try {
      if (part.kind === 'picture') {
        if (typeof pickText !== 'function') return;
        // The web first; Commons fills up the choice when the web gives fewer than two usable images.
        const web = await findWebImages({ fetch: fetchImpl, searchImages, query: part.search, shows: part.shows, signal: controller.signal });
        const commons = web.length >= 2 ? [] : await findCommonsImages({ fetch: fetchImpl, query: part.search, signal: controller.signal, count: CANDIDATES - web.length });
        const candidates = [...web, ...commons];
        if (!candidates.length) { note({ id: part.id, kind: part.kind, outcome: 'no-candidates' }); return; }
        const reply = await pickText({
          prompt: pickPrompt({ screen: part.screen, shows: part.shows, candidates }), schema: PICK_SCHEMA, signal: controller.signal,
          pageImages: candidates.map((item, index) => ({ label: `Image ${index + 1}`, mimeType: item.mime, data: item.data.toString('base64') })),
        });
        const choice = Number(reply?.choice);
        const chosen = Number.isInteger(choice) && choice >= 1 ? candidates[choice - 1] : null;
        if (!chosen) { note({ id: part.id, kind: part.kind, outcome: 'none-fit', candidates: candidates.length, ms: Date.now() - started }); return; }
        made.set(part.id, {
          kind: 'picture', mime: chosen.mime, data: chosen.data, width: chosen.width, height: chosen.height,
          description: clip(reply.description || chosen.about || chosen.title, DESCRIPTION_MAX),
          // The sentence that makes the screen read as written around this picture; it goes above the text.
          ...(typeof reply.lead === 'string' && reply.lead.trim() ? { lead: clip(reply.lead.replace(/\s+/gu, ' '), LEAD_MAX) } : {}),
          // A Commons file is credited as its licence asks; a web image carries no credit line, like a presenter's own slide.
          ...(chosen.source === 'commons' ? { credit: `${chosen.author ? `${chosen.author}, ` : ''}${chosen.licence}, via Wikimedia Commons` } : {}),
          source: chosen.pageUrl,
        });
        note({ id: part.id, kind: part.kind, outcome: 'chosen', choice, from: chosen.source, web: web.length, commons: commons.length, ms: Date.now() - started });
        return;
      }
      if (part.kind === 'diagram') {
        if (typeof diagramText !== 'function') return;
        const reply = await diagramText({ prompt: diagramPrompt({ screen: part.screen, shows: part.shows }), schema: DIAGRAM_SCHEMA, signal: controller.signal });
        const svg = safeSvg(reply?.svg);
        if (!svg) { note({ id: part.id, kind: part.kind, outcome: reply?.svg ? 'unsafe' : 'none', ms: Date.now() - started }); return; }
        made.set(part.id, { kind: 'diagram', mime: 'image/svg+xml', data: Buffer.from(svg, 'utf8'), svg, description: clip(reply.description, DESCRIPTION_MAX) });
        note({ id: part.id, kind: part.kind, outcome: 'drawn', chars: svg.length, ms: Date.now() - started });
      }
    } catch (error) {
      note({ id: part.id, kind: part.kind, outcome: 'failed', error: error?.code || error?.name || 'error', ms: Date.now() - started });
    }
  };
  try {
    await Promise.race([Promise.all(wanted.map(one)), over]);
  } finally {
    try { if (timer !== null) clock.clearTimeout(timer); } catch { /* fired */ }
    signal?.removeEventListener?.('abort', stop);
  }
  // A visual finishing after the budget is not added: the screens are settled from here.
  return new Map(made);
}

/** A visual as the window gets it: a data URL, read once per screen. */
export const visualDataUrl = visual => `data:${visual.mime};base64,${Buffer.from(visual.data).toString('base64')}`;
