import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CANDIDATES, COMMONS_USER_AGENT, findWebImages, isWatermarkedSource, MAX_VISUALS, VISUAL_DIAGRAM_STAGE, VISUAL_PICK_STAGE, candidatesFromCommons, commonsSearchUrl,
  diagramPrompt, findCommonsImages, makeVisuals, pickPrompt, safeSvg,
} from '../../electron/practiceCall/visuals.js';
import { MAX_PLAN_VISUALS, PLAN_SCHEMA, buildPlanPrompt, validatePlan } from '../../electron/practiceCall/callPlanner.js';
import { parallelImageSearch } from '../../electron/ipc/parallelSearch.js';
import { careerWritingStageProfile } from '../../electron/ipc/careerWritingCore.js';
import { createReplayHandler } from '../../electron/practiceCall/replayProtocol.js';
import { draftAnswerPrompt, draftCandidateAnswer } from '../../electron/practiceCall/draftAnswer.js';
import { buildInterviewerInstructions } from '../../electron/interviewPracticeCallPrompt.js';
import { safeVisual } from '../../src/practice-call/screenMarkup.js';
import { flush, makeRig, greet } from './interview-practice-call-engine.js';

// Synthetic data only: every title, author and image below is invented for the tests.

const cases = [];
const test = (name, run) => cases.push({ name: `practice call visuals: ${name}`, run });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200"><defs><marker id="a"><path d="M0 0L5 5"/></marker></defs><line x1="0" y1="0" x2="10" y2="10" marker-end="url(#a)"/><text x="5" y="20">Egress</text></svg>';

const page = (index, overrides = {}) => ({
  index, title: `File:Moon ${index}.jpg`,
  imageinfo: [{
    thumburl: `https://upload.example/moon-${index}.jpg`, thumbwidth: 1024, thumbheight: 683, descriptionurl: `https://commons.example/File:Moon_${index}.jpg`,
    extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: '<a href="x">NASA</a>' }, ImageDescription: { value: 'Lunar <b>surface</b>' } },
    ...overrides,
  }],
});

test('the plan may ask for a visual on a screen part, checked and capped', () => {
  const voices = [{ key: 'V1', name: 'Alex', gender: 'female', age: '', accent: '', description: '' }];
  const pool = [{ number: 1, question: 'Could you live on the moon?', answer: '', timesAsked: 0 }];
  const plan = visual => ({
    interviewKind: 'A screen.', callMinutes: 10, wrapUpMinutes: 2, lead: { voice: 'V1', name: 'Ingrid Solberg', role: 'Manager', temperament: 'Even and plain.', stability: 0.3, room: 0.2, manner: 'Plain.', interrupting: 'Lets people finish and rarely cuts in.' }, panel: [],
    questions: [{ number: 1, askedBy: 'V1', minutes: 5, probes: [] }, { number: 0, text: 'What draws you to remote sites?', askedBy: 'V1', minutes: 5, probes: [] }],
    problems: [{ ref: 'p1', question: 1, language: '', parts: [{ title: 'Moon base', content: 'Could you live here for a year?', ...(visual ? { visual } : {}) }], solution: 'Open.', edgeCases: [], hints: [] }],
  });
  const ctx = { pool, voices };
  const good = validatePlan(plan({ kind: 'picture', search: '  lunar   surface ', shows: 'How desolate it is.' }), ctx);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.plan.problems[0].parts[0].visual, { kind: 'picture', search: 'lunar surface', shows: 'How desolate it is.' });
  assert.deepEqual(validatePlan(plan(null), ctx).plan.problems[0].parts[0], { title: 'Moon base', content: 'Could you live here for a year?' });
  assert.match(validatePlan(plan({ kind: 'picture', shows: 'x' }), ctx).problems.join(' '), /search must give/u);
  assert.match(validatePlan(plan({ kind: 'video', shows: 'x' }), ctx).problems.join(' '), /kind must be/u);
  const many = plan({ kind: 'diagram', shows: 'x' });
  many.problems[0].parts = Array.from({ length: 4 }, (_, at) => ({ title: `T${at}`, content: 'c', visual: { kind: 'diagram', shows: 'x' } }));
  many.problems.push({ ...many.problems[0], ref: 'p2', parts: [{ title: 'T', content: 'c', visual: { kind: 'diagram', shows: 'x' } }] });
  assert.match(validatePlan(many, ctx).problems.join(' '), new RegExp(`limit is ${MAX_PLAN_VISUALS}`, 'u'));
  const partSchema = PLAN_SCHEMA.properties.problems.items.properties.parts.items;
  assert(partSchema.properties.visual && !partSchema.required.includes('visual'), 'the visual is optional in the schema');
  const prompt = buildPlanPrompt({ brief: { role: 'r' }, application: {}, pool, voices });
  assert(prompt.includes('Setting the scene is a good reason on its own'), 'a scene-setting photo is still asked for');
  // Owner's decision, 2026-11-23: the planner prompt and schema quote no sample subject or search words to copy.
  assert(!/moon colony|lunar|filming a bird|remote river/u.test(prompt) && !/lunar|Apollo/u.test(JSON.stringify(PLAN_SCHEMA)), 'no sample picture subject in the prompt or the schema');
  assert(prompt.includes('never add a visual as decoration'), 'code and abstract questions still get none');
  const pick = pickPrompt({ screen: { title: 'The brief', content: 'Dippers on an upland river.' }, shows: 'a dipper', candidates: [{ title: 'Dipper' }] });
  assert(pick.includes('or to set its scene') && pick.includes('even when the text already describes it'), 'the picker keeps a scene-setting photo');
});

test('Commons results become candidates: free licence, raster thumbnail, sensible size, best match first', () => {
  const url = new URL(commonsSearchUrl('lunar surface'));
  assert.equal(url.hostname, 'commons.wikimedia.org');
  assert.equal(url.searchParams.get('gsrsearch'), 'lunar surface filetype:bitmap');
  assert.equal(url.searchParams.get('gsrnamespace'), '6');
  const body = { query: { pages: [
    page(3),
    page(1),
    page(2, { extmetadata: { LicenseShortName: { value: 'Fair use' } } }),
    page(4, { thumbwidth: 300 }),
    page(5, { thumbwidth: 4000, thumbheight: 500 }),
  ] } };
  const found = candidatesFromCommons(body);
  assert.deepEqual(found.map(item => item.title), ['Moon 1.jpg', 'Moon 3.jpg'], 'ordered by rank; non-free, tiny and odd shapes dropped');
  assert.equal(found[0].author, 'NASA', 'the author is plain text');
  assert.equal(found[0].about, 'Lunar surface');
});

test('candidate images are downloaded with a plain client name, and only real images of a sane size are kept', async () => {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, agent: options?.headers?.['User-Agent'] });
    if (url.includes('api.php')) return { ok: true, json: async () => ({ query: { pages: [page(1), page(2), page(3)] } }) };
    const type = url.includes('moon-2') ? 'text/html' : 'image/jpeg';
    return { ok: true, headers: { get: () => type }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const found = await findCommonsImages({ fetch, query: 'lunar surface' });
  assert.deepEqual(found.map(item => item.title), ['Moon 1.jpg', 'Moon 3.jpg'], 'a page served as HTML is not an image');
  assert(requests.every(item => item.agent === COMMONS_USER_AGENT), 'every request names the client, and nothing personal');
  assert.deepEqual(await findCommonsImages({ fetch: async () => { throw new Error('offline'); }, query: 'x' }), [], 'a failed search is no pictures, not an error');
});

test('a picture is kept only when Claude, looking at the candidates, says one fits; a diagram only when its SVG is safe', async () => {
  const fetch = async url => (url.includes('api.php')
    ? { ok: true, json: async () => ({ query: { pages: [page(1), page(2)] } }) }
    : { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([9, 9]).buffer });
  const picks = [];
  const screen = { title: 'Moon base', content: 'Could you live here for a year?' };
  const parts = [
    { id: 'p1.1', kind: 'picture', search: 'lunar surface', shows: 'How desolate it is.', screen },
    { id: 'p2.1', kind: 'diagram', shows: 'The schedule.', screen: { title: 'Plan', content: 'A then B.' } },
    { id: 'p3.1', kind: 'diagram', shows: 'Unsafe.', screen: { title: 'Bad', content: 'x' } },
  ];
  const made = await makeVisuals({
    parts, fetch,
    pickText: async request => { picks.push(request); return { choice: 2, description: 'A grey, cratered plain under a black sky.', lead: '  The photo above shows the lunar surface\n near the south pole.  ' }; },
    diagramText: async request => (request.prompt.includes('Unsafe.') ? { svg: '<svg viewBox="0 0 1 1"><script>x()</script></svg>', description: 'd' } : { svg: SVG, description: 'Two bars.' }),
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].pageImages.length, 2, 'the candidates go to Claude as images');
  assert.deepEqual(picks[0].pageImages.map(item => item.label), ['Image 1', 'Image 2']);
  assert(picks[0].prompt.includes('Could you live here for a year?') && picks[0].prompt.includes('A screen without a picture is fine'));
  const picture = made.get('p1.1');
  assert.equal(picture.kind, 'picture');
  assert.equal(picture.description, 'A grey, cratered plain under a black sky.');
  assert.equal(picture.credit, 'NASA, Public domain, via Wikimedia Commons');
  assert.equal(picture.lead, 'The photo above shows the lunar surface near the south pole.', 'the sentence tying the screen to this picture, on one line');
  assert(picks[0].prompt.includes('ties the question to this particular picture') && picks[0].schema.properties.lead, 'the pick is asked for a lead');
  assert(!picks[0].schema.required.includes('lead'), 'a lead is optional');
  assert.equal(made.get('p2.1').svg, SVG);
  assert.equal(made.has('p3.1'), false, 'an unsafe drawing is left out');
  const none = await makeVisuals({ parts: [parts[0]], fetch, pickText: async () => ({ choice: 0, description: '' }) });
  assert.equal(none.size, 0, 'no fitting picture, no picture');
  assert.equal(CANDIDATES >= 2 && MAX_VISUALS >= 1, true);
});

test('visuals that run past the budget are dropped, and the screens are settled without them', async () => {
  let fire;
  const clock = { setTimeout: fn => { fire = fn; return 1; }, clearTimeout: () => {} };
  let release;
  const pending = makeVisuals({
    parts: [{ id: 'p1.1', kind: 'diagram', shows: 's', screen: { title: 't', content: 'c' } }], clock,
    diagramText: ({ signal }) => new Promise(resolve => { release = () => resolve({ svg: SVG, description: 'late' }); signal.addEventListener('abort', () => {}); }),
  });
  await flush();
  fire();
  const made = await pending;
  release();
  await flush();
  assert.equal(made.size, 0, 'a late diagram never lands on a screen');
});

test('only plain, self-contained SVG is accepted', () => {
  assert.equal(safeSvg(SVG), SVG);
  assert.equal(safeSvg(`<?xml version="1.0"?>${SVG}`), SVG, 'an XML declaration is dropped');
  for (const bad of [
    '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 1 1" onload="x()"></svg>',
    '<svg viewBox="0 0 1 1"><image href="https://x.example/a.png"/></svg>',
    '<svg viewBox="0 0 1 1"><a href="https://x.example">x</a></svg>',
    '<svg viewBox="0 0 1 1"><rect fill="url(https://x.example/#a)"/></svg>',
    '<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>',
    '<svg viewBox="0 0 1 1"><style>@import url(x)</style></svg>',
    '<!DOCTYPE svg><svg viewBox="0 0 1 1"></svg>',
    '<svg><rect/></svg>',
    'not svg',
  ]) assert.equal(safeSvg(bad), null, bad);
});

test('the prompts keep a visual honest: no picture beats a poor one, and a diagram uses only the screen\'s own values', () => {
  const pick = pickPrompt({ screen: { title: 'T', content: 'C' }, shows: 'S', candidates: [{ title: 'A', about: 'about A' }] });
  assert(pick.includes('1. A (about A)') && pick.includes('Choose 0 when none fits'));
  const draw = diagramPrompt({ screen: { title: 'T', content: 'Egress 00:00' }, shows: 'S' });
  assert(draw.includes('must match the screen exactly') && draw.includes('No scripts'));
  assert(draw.includes('dimension line') && draw.includes('do not overlap each other'));
  assert.deepEqual({ ...careerWritingStageProfile(VISUAL_PICK_STAGE) }, { model: 'sonnet', effort: 'medium' });
  assert.deepEqual({ ...careerWritingStageProfile(VISUAL_DIAGRAM_STAGE) }, { model: 'opus', effort: 'low' });
});

test('the interviewer is told what a prepared screen shows, and a suggested reply sees the picture itself', async () => {
  const instructions = buildInterviewerInstructions({
    persona: { name: 'Alex Morgan', role: 'Manager', temperament: 'neutral' }, brief: { company: 'Acme', role: 'Engineer' }, cards: [], picked: [],
    callPlan: { interviewKind: 'A screen.', people: [{ id: 'A', name: 'Alex Morgan', role: 'Manager', temperament: 'neutral' }], questions: [{ number: 1, askedBy: 'A', minutes: 5, probes: [] }],
      problems: [{ ref: 'p1', question: 1, language: '', parts: [{ title: 'Moon base', content: 'Could you live here?', visual: { kind: 'picture', description: 'A grey, cratered plain.' } }], solution: 'Open.', edgeCases: [], hints: [] }] },
  });
  assert(instructions.includes('"pictureAboveTheText": "A grey, cratered plain."'), 'the plan says what the picture shows');
  assert(instructions.includes('never mention where it came from'));
  const prompt = draftAnswerPrompt({ screen: { title: 'Moon base', content: 'Could you live here?', current: true, visual: { kind: 'picture', description: 'A grey, cratered plain.' } } });
  assert(prompt.includes('Picture above the text (attached): A grey, cratered plain.'));
  const diagram = draftAnswerPrompt({ screen: { title: 'Plan', content: 'A then B.', current: true, visual: { kind: 'diagram', description: 'Two bars.', svg: SVG } } });
  assert(diagram.includes('The diagram itself (SVG):') && diagram.includes('<text x="5" y="20">Egress</text>'));
  const sent = [];
  await draftCandidateAnswer({ callText: async request => { sent.push(request); return 'I could.'; }, screen: { title: 'Moon base', content: 'Could you live here?', image: { label: 'Picture on the shared screen', mimeType: 'image/jpeg', data: 'AAAA' } } });
  assert.deepEqual(sent[0].pageImages, [{ label: 'Picture on the shared screen', mimeType: 'image/jpeg', data: 'AAAA' }]);
});

test('the engine shows a prepared visual with its screen, by id', async () => {
  const rig = makeRig({ prepared: { p1: { parts: [{ title: 'Moon base', content: 'Could you live here?', visual: { id: 'p1.1', kind: 'picture' } }] } } });
  await greet(rig);
  rig.engine.typed('Ready.');
  await flush();
  rig.sessions.opener.answer('');
  await flush();
  rig.sessions.main.answer('Have a look. <screen ref="p1"/> What do you think?');
  rig.streams.at(-1).audio(3200);
  await flush();
  const id = rig.streams.at(-1).utteranceId;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 3000);
  await rig.clock.advance(30000);
  const screen = rig.of('screen').at(-1);
  assert(screen, JSON.stringify(rig.events.map(event => event.type)));
  assert.equal(screen.visualId, 'p1.1');
  assert.equal(screen.title, 'Moon base');
});

test('the window shows only a visual served from the call\'s own folder', () => {
  assert.deepEqual(safeVisual({ kind: 'picture', url: 'practice-call://call-1/visuals/p1.1.jpg', description: 'd', credit: 'c' }), { kind: 'picture', url: 'practice-call://call-1/visuals/p1.1.jpg', description: 'd', credit: 'c' });
  for (const url of ['https://example.com/a.jpg', 'practice-call://call-1/call.m4a', 'practice-call://call-1/visuals/../call.json', 'data:image/png;base64,AA', 'file:///etc/passwd']) {
    assert.equal(safeVisual({ kind: 'picture', url }), null, url);
  }
  assert.equal(safeVisual({ kind: 'video', url: 'practice-call://call-1/visuals/a.jpg' }), null);
});

test('the protocol serves a call\'s visuals folder only: plain files, known types, SVG locked down', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'practice-call-visuals-'));
  const dir = path.join(root, 'call-1');
  await mkdir(path.join(dir, 'visuals'), { recursive: true });
  await writeFile(path.join(dir, 'visuals', 'p1.1.svg'), SVG);
  await writeFile(path.join(dir, 'secret.txt'), 'no');
  await symlink(path.join(dir, 'secret.txt'), path.join(dir, 'visuals', 'p2.1.jpg'));
  const store = {
    audioPath: async () => null,
    visualPath: async (callId, name) => (callId === 'call-1' && /^[\w.-]+\.(?:jpg|png|webp|svg)$/u.test(name) ? path.join(dir, 'visuals', name) : null),
  };
  const handler = createReplayHandler({ store });
  const get = url => handler({ url, method: 'GET', headers: { get: () => null } });
  const ok = await get('practice-call://call-1/visuals/p1.1.svg');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
  assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/u);
  assert.equal(await ok.text(), SVG);
  for (const url of ['practice-call://call-1/visuals/p2.1.jpg', 'practice-call://call-1/visuals/secret.txt', 'practice-call://call-2/visuals/p1.1.svg', 'practice-call://call-1/visuals/p1.1.svg?x=1']) {
    assert.equal((await get(url)).status, 404, url);
  }
});

test('Parallel image search is signed in with the key, and only https image links come back', async () => {
  const sent = [];
  const fetch = async (url, options) => {
    sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const payload = { results: [
      { title: 'Lunar surface', image_url: 'https://images.example/moon.jpg', source_page_url: 'https://pages.example/moon', width: 1600, height: 1000 },
      { title: 'Plain http', image_url: 'http://images.example/moon.jpg' },
      { title: 'Broken', image_url: 'not a url' },
    ] };
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) };
  };
  const key = 'pk_live_0123456789abcdef';
  const found = await parallelImageSearch({ objective: 'The lunar surface.', queries: ['lunar surface', '', 'moon craters'], key, fetch });
  assert.deepEqual(found, [{ title: 'Lunar surface', imageUrl: 'https://images.example/moon.jpg', pageUrl: 'https://pages.example/moon', width: 1600, height: 1000 }]);
  assert.equal(sent[0].url, 'https://mcp.parallel.ai/mcp');
  assert.equal(sent[0].headers.Authorization, `Bearer ${key}`, 'the key goes in the header');
  assert(!sent[0].url.includes(key) && !JSON.stringify(sent[0].body).includes(key), 'never in the URL or body');
  assert.equal(sent[0].body.params.name, 'image_search');
  assert.deepEqual(sent[0].body.params.arguments.search_queries, ['lunar surface', 'moon craters']);
  await parallelImageSearch({ objective: 'x', queries: ['moon'], key: '', fetch });
  assert.equal(sent[1].headers.Authorization, undefined, 'no key, the free search');
  assert.deepEqual(await parallelImageSearch({ queries: [], fetch }), [], 'nothing to search, no call');
  assert.equal(sent.length, 2);
});

test('pictures come from the web first, Commons only tops up, and a web picture carries no credit line', async () => {
  const image = { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([7, 7]).buffer };
  const commonsCalls = [];
  const fetch = async url => {
    if (url.includes('api.php')) { commonsCalls.push(url); return { ok: true, json: async () => ({ query: { pages: [page(1)] } }) }; }
    return image;
  };
  const screen = { title: 'Moon base', content: 'Could you live here for a year?' };
  const part = { id: 'p1.1', kind: 'picture', search: 'lunar surface', shows: 'How desolate it is.', screen };
  const searches = [];
  const web = count => async request => { searches.push(request); return Array.from({ length: count }, (_, at) => ({ title: `Web ${at + 1}`, imageUrl: `https://images.example/${at}.jpg`, pageUrl: `https://pages.example/${at}`, width: 1600, height: 1000 })); };
  let seen = null;
  const made = await makeVisuals({ parts: [part], fetch, searchImages: web(3), pickText: async request => { seen = request; return { choice: 1, description: 'Grey plain.' }; } });
  assert.equal(seen.pageImages.length, 3, 'three web images');
  assert.equal(commonsCalls.length, 0, 'enough from the web: Commons is not asked');
  assert(searches[0].objective.includes('How desolate it is.') && searches[0].queries[0] === 'lunar surface');
  assert.equal(made.get('p1.1').credit, undefined, 'a web picture has no credit line');
  assert.equal(made.get('p1.1').source, 'https://pages.example/0');
  const topped = await makeVisuals({ parts: [part], fetch, searchImages: web(1), pickText: async request => { seen = request; return { choice: 2, description: 'Grey plain.' }; } });
  assert.equal(seen.pageImages.length, 2, 'one from the web, one from Commons');
  assert.equal(commonsCalls.length, 1);
  assert.equal(topped.get('p1.1').credit, 'NASA, Public domain, via Wikimedia Commons', 'a Commons picture keeps its credit');
});

test('images from stock libraries that watermark their previews are never downloaded, and the pick rules out any watermark', async () => {
  assert.equal(isWatermarkedSource('https://c8.alamy.com/comp/3AJREGR/moon.jpg'), true);
  assert.equal(isWatermarkedSource('https://t3.ftcdn.net/jpg/01/moon.jpg'), true, 'Adobe Stock serves its previews from ftcdn.net');
  assert.equal(isWatermarkedSource('https://cdn.example.org/moon.jpg', 'https://www.shutterstock.com/image-photo/moon'), true, 'found on a stock page counts too');
  assert.equal(isWatermarkedSource('https://www.nasa.gov/moon.jpg', 'https://www.nasa.gov/moon'), false);
  assert.equal(isWatermarkedSource('https://notalamy.com/moon.jpg'), false, 'a name that only ends the same is not the stock site');
  const downloaded = [];
  const fetch = async url => { downloaded.push(url); return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1]).buffer }; };
  const searchImages = async request => {
    assert(request.objective.includes('no watermark of any kind'), 'the search asks for clean photos');
    return [
      { title: 'Stock', imageUrl: 'https://c8.alamy.com/comp/x/moon.jpg', pageUrl: 'https://www.alamy.com/moon', width: 1600, height: 1000 },
      { title: 'Adobe', imageUrl: 'https://as1.ftcdn.net/v2/jpg/moon.jpg', pageUrl: 'https://stock.adobe.com/moon', width: 1600, height: 1000 },
      { title: 'NASA', imageUrl: 'https://images.nasa.example/moon.jpg', pageUrl: 'https://www.nasa.gov/moon', width: 1600, height: 1000 },
    ];
  };
  const found = await findWebImages({ fetch, searchImages, query: 'lunar surface', shows: 'How desolate it is.' });
  assert.deepEqual(found.map(item => item.title), ['NASA']);
  assert.deepEqual(downloaded, ['https://images.nasa.example/moon.jpg'], 'nothing from a stock library is even fetched');
  const prompt = pickPrompt({ screen: { title: 'T', content: 'C' }, shows: 'S', candidates: [{ title: 'A' }] });
  assert(prompt.includes('rule out every image with ANY watermark') && prompt.includes('never acceptable, however well it fits'));
});

export default cases;
