import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import {
  answerBankRecordId,
  buildInterviewAnswerEvidence,
  interviewAnswerBankApplicationDigest,
  interviewAnswerBankPrompt,
  isInterviewAnswerBank,
  loadInterviewAnswerBank,
  publishInterviewAnswerBank,
  validateInterviewAnswerBank,
  inspectInterviewAnswerCards, mergeInterviewAnswerCardRepair, interviewAnswerRepairPrompt,
  validateInterviewAnswerDraft,
  INTERVIEW_ANSWER_BANK_SCHEMA, INTERVIEW_ANSWER_MIN_CARDS, interviewAnswerRepairSchema, interviewAnswerBankSchema, interviewAnswerSets,
} from '../../electron/ipc/interviewAnswerBank.js';
import crypto from 'node:crypto';
import { resumeCoverage } from '../../electron/ipc/interviewResumeCoverage.js';
import { INTERVIEW_LEGACY_QUESTION_CATALOG as CATALOG } from '../../src/utils/interviewAnswerQuestions.js';
import { cardKind } from '../../electron/ipc/interviewCardKinds.js';
import { validateResponseSchema } from '../../electron/ipc/schemaValidation.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const URL = 'https://jobs.example.test/role';
const STORE = 'interview-helper-answer-banks';
const MAIN_CLAIM = 'Led onboarding research and reduced setup time by 25%. Created a setup research guide for the onboarding project. Interviewed staff about the onboarding setup requirements. Reviewed onboarding feedback with staff about the setup guide.';
const SUPPORT_CLAIM = 'Created a setup research guide for the onboarding project.';
const EXTRA_TOPICS = ['deployment', 'documentation', 'reporting', 'validation', 'migration', 'integration', 'automation', 'delivery', 'planning', 'support', 'testing'];

function contextFixture() {
  const bundle = {
    digests: { applicationHtml: 'b'.repeat(64), originalJobListing: 'c'.repeat(64) },
    applicationPositioning: { resume: MAIN_CLAIM, coverLetter: 'I prefer clear product decisions.' },
  };
  const snapshot = { snapshotId: 'a'.repeat(64), profile: {
    roles: [{ id: 'role-1', title: 'Product Manager', employer: 'Aster Labs' }, { id: 'role-2', title: 'Analyst', employer: 'Birch Works' }],
    achievements: [
      { id: 'achievement-1', roleId: 'role-1', claim: MAIN_CLAIM, evidenceSegmentIds: ['segment-0001'] },
      { id: 'achievement-2', roleId: 'role-1', claim: 'The experiment did not improve conversion in 2024.', evidenceSegmentIds: ['segment-0002'] },
      { id: 'achievement-3', roleId: 'role-2', claim: 'Built a reporting dashboard at Birch Works for the support team.', evidenceSegmentIds: ['segment-0003'] },
      { id: 'achievement-passive', roleId: 'role-1', claim: 'Led by another manager, the project shipped in 2023.', evidenceSegmentIds: ['segment-0004'] },
    ],
    projects: [{ id: 'project-1', roleId: 'role-1', name: 'Setup research', description: SUPPORT_CLAIM, evidenceSegmentIds: ['segment-0001'] }],
    otherEvidence: [{ id: 'other-1', label: 'Support note', text: 'Helped a volunteer team maintain its records.', evidenceSegmentIds: ['segment-0005'] }],
  } };
  snapshot.profile.achievements.push(...EXTRA_TOPICS.map((topic, index) => ({ id: `synthetic-${index}`, roleId: 'role-1', claim: `I maintained the ${topic} system and created a ${topic} guide. I tested the ${topic} checklist. I reviewed the ${topic} guide with staff. I automated the ${topic} status reports for the ${topic} system.`, evidenceSegmentIds: ['segment-0001'] })));
  const brief = { briefId: 'd'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z', inputs: {
    careerSnapshotId: snapshot.snapshotId, jobUrlSha256: sha(URL), applicationArtifactId: 'e'.repeat(64), applicationArtifactDigest: interviewAnswerBankApplicationDigest(bundle),
  }, role: { title: 'Product Manager', company: 'Cedar', location: 'Remote', summary: '' },
  roleThemes: ['Onboarding discovery'], likelyQuestions: ['Tell me about onboarding research.'],
  companyFacts: [{ fact: 'Cedar serves research teams with a shared library of research tools.', sourceId: 'f'.repeat(16), sourceUrl: 'https://cedar.example.test/about', sourceDate: 'unknown' }], recentContext: [],
  };
  return { snapshot, brief, bundle, canonicalJobUrl: URL, bundleArtifactId: brief.inputs.applicationArtifactId };
}
function statement(evidence, firstPerson = false) {
  return { text: firstPerson ? `I ${evidence.text[0].toLowerCase()}${evidence.text.slice(1)}` : evidence.text,
    evidenceIds: [evidence.id], quotes: [{ evidenceId: evidence.id, quote: evidence.text }] };
}
function legacyResponseFixture(context) {
  const evidence = buildInterviewAnswerEvidence(context);
  const career = evidence.find(item => item.entityId === 'achievement-1');
  const claim = (source, value) => ({ ...statement(source), text: value });
  const cards = Array.from({ length: 12 }, (_, index) => {
    const source = index ? evidence.find(item => item.entityId === `synthetic-${index - 1}`) : career;
    const topic = EXTRA_TOPICS[index - 1];
    const headline = index ? source.text.split('. ')[0] + '.' : 'I led onboarding research and reduced setup time by 25%.';
    const bullets = index ? [
      `I tested the ${topic} checklist for the ${topic} system.`,
      `I reviewed the ${topic} guide with the staff.`,
    ] : ['I interviewed staff about the onboarding setup requirements.', 'I created a setup research guide for the onboarding project.'];
    return {
      id: `card-${index + 1}`, question: CATALOG[index || 23].question,
      variants: [...CATALOG[index || 23].variants], thinEvidence: true,
      headline: claim(source, headline), bullets: bullets.map(value => ({ stage: 'point', ...claim(source, value) })),
      example: claim(source, index ? `I automated the ${topic} status reports for the ${topic} system.` : 'I reviewed onboarding feedback with staff about the setup guide.'), consistency: index ? { consistentWithResume: false, resumeQuote: '' } : { consistentWithResume: true, resumeQuote: career.text },
    };
  });
  const research = evidence.find(item => item.kind === 'research');
  for (const index of [2, 3]) cards[index].headline = claim(research, `This ${index === 2 ? 'role' : 'company'} interests me because Cedar serves research teams with a shared library.`);
  const intro = cards[7];
  intro.question = CATALOG[0].question;
  intro.variants = [...CATALOG[0].variants];
  intro.bullets = [{ stage: 'point', ...claim(evidence.find(item => item.entityId === 'achievement-3'), 'I built a reporting dashboard at Birch Works for the support team.') },
    { stage: 'point', ...claim(research, 'This role interests me because Cedar serves research teams with a shared library.') }];
  return { cards };
}
// Questions in the writer's own words, one per fixture card: the set, the kind and the wording the
// current writer returns. The legacy fixture above is what earlier versions sealed.
const OWN_WORDING = [
  ['posting', 'other', 'What else would help us understand how you approach onboarding research?', ['Is there anything about your research work you want us to hear?', 'What should we know about how you work with research teams?']],
  ['posting', 'other', 'Which of your experiences fits this product manager role best?', ['What experience could you bring to this role?', 'Which parts of your background apply here?']],
  ['posting', 'motivation', 'What draws you to this role?', ['Why does this position appeal to you?', 'What made you apply for it?']],
  ['posting', 'motivation', 'Why would you like to join Cedar?', ['What interests you about Cedar as a company?', 'Why this company over others?']],
  ['general', 'other', 'Walk me through a piece of work you are proud of.', ['Pick one piece of work and tell me how it unfolded.', 'Describe one piece of work from start to finish.']],
  ['general', 'problem', 'Tell me about a time something got hard and how you handled it.', ['What is a difficult situation you worked through?', 'Describe a moment when a task became harder than expected.']],
  ['posting', 'priority', 'How do you decide what to do first when everything is urgent?', ['How do you handle competing demands on your time?', 'What does your process look like when priorities collide?']],
  ['general', 'intro', 'Can you give me a quick introduction to who you are professionally?', ['Tell us a little about your background.', 'How would you describe your career so far?']],
  ['general', 'disagreement', 'Describe a time you disagreed with someone you worked with.', ['What do you do when a colleague pushes back on your idea?', 'How do you handle a conflict with a teammate?']],
  ['posting', 'leadership', 'How do you help the people around you grow?', ['What does supporting teammates look like for you?', 'Tell me about a time you coached someone.']],
  ['posting', 'problem', 'Walk me through how you would approach a messy onboarding problem.', ['How do you break down a technical problem you have not seen before?', 'What steps do you take when a system misbehaves?']],
  ['posting', 'process', 'Tell me about a process you made better.', ['How do you improve the way a team works?', 'What does a good before-and-after process change look like to you?']],
];
function responseFixture(context) {
  const legacy = legacyResponseFixture(context);
  return { cards: legacy.cards.map((card, index) => {
    const [set, kind, question, variants] = OWN_WORDING[index];
    // The fields in the order the writer returns them.
    const { id, headline, bullets, example, extensions, consistency, thinEvidence } = card;
    return { id, set, kind, question, variants: [...variants], headline, bullets, example, ...(extensions ? { extensions } : {}), consistency, thinEvidence };
  }) };
}
function rejects(response, context, message) {
  let rejection;
  try { validateInterviewAnswerBank(response, context); } catch (error) { rejection = error; }
  assert(rejection && Array.isArray(rejection.correctionDetails) && rejection.correctionDetails.length > 0, message);
  assert(!JSON.stringify(rejection.correctionDetails).includes('Aster Labs'), 'diagnostics must not insert an employer from source labels into worker correction prose');
  return rejection;
}

export default [
  {
    name: 'interview answer bank: the prompt says what a typed listing really is and leaves captured bundles unchanged',
    run: async () => {
      const context = contextFixture();
      const promptFor = status => interviewAnswerBankPrompt({ ...context, bundle: { ...context.bundle, ...(status ? { verification: { status, reason: 'x' } } : {}), listingText: 'Engineer at Acme.' }, evidence: buildInterviewAnswerEvidence(context) });
      const generated = promptFor('typed-generated'); const posting = promptFor('typed-posting'); const captured = promptFor('verified');
      assert(generated.includes("AI-generated stand-in listing, not the employer's text") && generated.includes('do not treat its specifics as facts about the employer'), 'a generated listing is disclosed');
      assert(posting.includes('read from the job posting page') && posting.includes('no application documents were submitted') && !posting.includes('AI-generated'), 'a typed posting says it came from the page');
      assert(!promptFor(null).includes('stand-in') && !captured.includes('stand-in') && !captured.includes('read from the job posting page'), 'a captured bundle prompt is unchanged');
    },
  },
  {
    name: 'interview answer bank: new handoffs require dedicated compact extensions while legacy sealed cards remain readable',
    run() {
      const context = contextFixture(); const value = responseFixture(context);
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(value, context)), 'legacy sealed shape remains readable without implicit example promotion');
      let rejected;
      try { validateInterviewAnswerDraft(value, undefined, { requireExtensions: true }); } catch (error) { rejected = error; }
      assert(rejected?.correctionRuleIds.includes('INTERVIEW_ANSWER_EXTENSIONS_REQUIRED'), 'a new worker omitting every extension field must receive an actionable structural correction');
      value.cards.forEach(card => { card.extensions = []; });
      assert(validateInterviewAnswerDraft(value, undefined, { requireExtensions: true }).cards.length === 12, 'an explicitly empty optional list stays sparse internal draft data');
      const schema = INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards.items;
      assert(schema.required.includes('extensions') && schema.properties.extensions.minItems === 0 && schema.properties.extensions.maxItems === 4,
        'the generation handoff keeps extensions explicit while allowing an honest sparse list');
      assert(!Object.hasOwn(schema.properties.extensions.items.properties, 'quotes'), 'extensions bind compact evidence IDs rather than duplicating large private source paragraphs in worker output');
    },
  },
  {
    name: 'interview answer bank: draft and repair response schemas accept empty or single extensions without relaxing their bounds',
    run() {
      const value = responseFixture(contextFixture());
      value.cards.forEach(card => { card.extensions = []; });
      value.cards[0].extensions = [{ id: 'additional', text: 'A separately cited additional point.', evidenceIds: ['career-additional'] }];
      for (const [schema, response] of [
        [INTERVIEW_ANSWER_BANK_SCHEMA, value],
        [interviewAnswerRepairSchema(value.cards.slice(0, 2)), { cards: value.cards.slice(0, 2) }],
      ]) {
        assert(validateResponseSchema(response, schema).length === 0,
          'the actual handoff validator must accept both an empty honest list and a single available point');
        const oversized = structuredClone(response);
        oversized.cards[0].extensions = Array.from({ length: 5 }, (_, index) => ({ ...value.cards[0].extensions[0], id: `point-${index}` }));
        assert(validateResponseSchema(oversized, schema).some(issue => issue.path === '$.cards[0].extensions'),
          'the four-point maximum remains enforced on both handoffs');
        const missing = structuredClone(response); delete missing.cards[0].extensions;
        assert(validateResponseSchema(missing, schema).length > 0,
          'empty must be explicit; the required extension field cannot be silently omitted');
      }
    },
  },
  {
    name: 'interview answer bank: dedicated extensions seal additional evidence and sparse drops cannot hide stored tampering',
    run() {
      const context = contextFixture(); const value = responseFixture(context);
      const evidence = buildInterviewAnswerEvidence(context);
      const dashboard = evidence.find(source => source.entityId === 'achievement-3');
      const volunteer = evidence.find(source => source.entityId === 'other-1');
      const point = (id, source, text) => ({ id, ...statement(source), text });
      const first = value.cards[0];
      first.extensions = [point('dashboard', dashboard, 'I built a reporting dashboard at Birch Works for the support team.'),
        point('invented', dashboard, 'I built a reporting dashboard with Salesforce.'),
        point('volunteer', volunteer, 'I helped a volunteer team maintain its records.'),
        { id: 'duplicate', ...structuredClone(first.bullets[0]) }];
      delete first.extensions[3].stage;
      const bank = validateInterviewAnswerBank(value, context);
      assert(bank.cards[0].extensions.map(item => item.id).join() === 'dashboard,volunteer', 'only failing optional points drop while both safe additional stories survive');
      assert(bank.evidence.some(source => source.id === volunteer.id) && isInterviewAnswerBank(bank, context), 'extension-only career evidence is sealed and revalidated against source authority');
      const recordId = answerBankRecordId(bank);
      const changed = structuredClone(bank); changed.cards[0].extensions[0].id = 'changed-id';
      assert(answerBankRecordId(changed) && answerBankRecordId(changed) !== recordId, 'point IDs participate in the bank content address');
      for (const mutate of [
        stored => { stored.cards[0].extensions[0].text += ' with Salesforce.'; },
        stored => { stored.cards[0].extensions[0].quotes[0].quote += ' Invented.'; },
        stored => { stored.cards[0].extensions.push({ id: 'duplicate', ...structuredClone(stored.cards[0].extensions[0]) }); },
        stored => { stored.evidence = stored.evidence.filter(source => source.id !== volunteer.id); },
      ]) {
        const stored = structuredClone(bank); mutate(stored);
        assert(!isInterviewAnswerBank(stored, context) && !answerBankRecordId(stored), 'sealed extension mutation must reject the bank rather than silently sanitize it');
      }
      assert(first.extensions.length === 4, 'sealing must not mutate the private draft');
    },
  },
  {
    name: 'interview answer bank: sanitized v4 repair replay accepts dated intro arcs but preserves number and why guards',
    run: () => {
      const replay = JSON.parse(fs.readFileSync(new globalThis.URL('../fixtures/interview-answer-v4-replay.json', import.meta.url), 'utf8'));
      const context = contextFixture();
      context.snapshot.profile.roles[0].endDate = 'June 2025';
      context.snapshot.profile.roles[1].endDate = 'January 2022';
      const evidence = buildInterviewAnswerEvidence(context);
      const recent = evidence.find(item => item.entityId === 'synthetic-0');
      const earlier = evidence.find(item => item.entityId === 'achievement-3');
      const research = evidence.find(item => item.kind === 'research');
      const cited = (source, text) => ({ ...statement(source), text });
      const card = { ...responseFixture(context).cards[7],
        headline: cited(recent, replay.initial.headline),
        bullets: [{ stage: 'point', ...cited(earlier, replay.initial.earlier) }, { stage: 'point', ...cited(research, replay.whyResearchHeadline) }],
        example: cited(recent, 'I automated the deployment status reports for the deployment system.'),
      };
      const initialFailures = inspectInterviewAnswerCards([card], context).failures;
      assert(!initialFailures.length, `initial dated chronology now passes without a repair: ${JSON.stringify(initialFailures)}`);
      card.headline.text = replay.finalRepair.headline;
      assert(!inspectInterviewAnswerCards([card], context).failures.length, 'the exhausted final v4 chronology shape now survives');
      card.headline.text = replay.dateRepair.headline;
      const rules = inspectInterviewAnswerCards([card], context).failures.map(issue => issue.rule);
      assert(replay.dateRepair.expectedRules.every(rule => rules.includes(rule)), 'role dates still cannot become achievement numbers');
      const why = structuredClone(responseFixture(context).cards[2]);
      why.headline = cited(recent, replay.whyCareerHeadline);
      assert(inspectInterviewAnswerCards([why], context).failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_RESEARCH'), 'a career headline fails even with thinEvidence:true');
      why.headline = cited(research, replay.whyResearchHeadline);
      assert(!inspectInterviewAnswerCards([why], context).failures.length, 'the research reason and independent career facts pass');
      const companyVoice = structuredClone(context);
      companyVoice.brief.companyFacts[0].fact = 'We build shared research tools for teams.';
      const voiceSource = buildInterviewAnswerEvidence(companyVoice).find(item => item.kind === 'research' && item.sourceField === 'companyFacts');
      const voicedIntro = structuredClone(card);
      voicedIntro.bullets[1] = { stage: 'point', ...cited(voiceSource, 'This role interests me because we built shared research tools for teams.') };
      assert(inspectInterviewAnswerCards([voicedIntro], companyVoice).failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_RESEARCH_AGENCY'),
        'an interest frame cannot turn a company speaker’s we into candidate agency in the introduction');
    },
  },
  {
    name: 'interview answer bank: first prompt teaches exact rules with synthetic examples and repairs omit the full brief',
    run: () => {
      const context = contextFixture(); const evidence = buildInterviewAnswerEvidence(context);
      const basePrompt = interviewAnswerBankPrompt({ ...context, evidence });
      const card = responseFixture(context).cards[0];
      card.headline.text += ' with 997 widgets.';
      const failures = inspectInterviewAnswerCards([card], context).failures.map(issue => ({ ...issue, cardId: card.id }));
      const repair = interviewAnswerRepairPrompt({ ...context, evidence, cards: [card], failures, basePrompt });
      assert(basePrompt.includes('INTERVIEW_ANSWER_CO_BUILT') && basePrompt.includes('INTERVIEW_ANSWER_INTRO_ROLE_SUMMARY')
        && basePrompt.includes('Toy:') && basePrompt.includes('Sample Works'), 'the first prompt names the exact gates and gives invented positive/negative examples');
      assert(repair.length < basePrompt.length / 2 && !repair.includes('interview-answer-sealed-brief')
        && !repair.includes('HOST RANKED SELECTION') && !repair.includes('interview-answer-original-listing'), 'sparse repairs omit full catalog, ranking, brief, original listing and synthetic teaching examples');
      assert(repair.includes('997') && repair.includes('INTERVIEW_ANSWER_NUMBER') && repair.includes('interview-answer-repair-evidence'), 'the minimal repair retains exact failures and bounded usable source data');
    },
  },
  {
    name: 'interview answer bank: missing behavioral shape requires thin evidence on the actual card',
    run: () => {
      const context = contextFixture();
      for (const kind of ['outcome', 'priority', 'process', 'customer-need']) {
        const card = structuredClone(responseFixture(context).cards[1]);
        card.kind = kind; card.thinEvidence = false;
        assert(inspectInterviewAnswerCards([card], context).failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_QUESTION_FIT'), 'a deliverable cannot pass as an outcome, priority, change or discovery action');
        card.thinEvidence = true;
        assert(!inspectInterviewAnswerCards([card], context).failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_QUESTION_FIT'), 'a narrow supported answer may retain a consistent thin-evidence warning');
      }
    },
  },
  {
    name: 'interview answer bank: multi-evidence intro arc names verified employers and binds why to research',
    run: () => {
      const context = contextFixture();
      context.snapshot.profile.roles[0].endDate = 'June 2025';
      context.snapshot.profile.roles[1].endDate = 'January 2022';
      const value = responseFixture(context);
      // The introduction moves from card 7 to card 0; card 7 becomes an ordinary posting card.
      const introWording = { set: value.cards[7].set, kind: value.cards[7].kind, question: value.cards[7].question, variants: value.cards[7].variants };
      Object.assign(value.cards[7], { set: 'posting', kind: 'other', question: 'What else should we know about your background in onboarding?', variants: ['Is there more you would like us to hear?'] });
      const original = buildInterviewAnswerEvidence(context).find(item => item.entityId === 'synthetic-6');
      value.cards[7].bullets = ['I tested the automation checklist for the automation system.', 'I reviewed the automation guide with the staff.']
        .map(text => ({ stage: 'point', ...statement(original), text }));
      const evidence = buildInterviewAnswerEvidence(context);
      const own = evidence.find(item => item.entityId === 'achievement-1');
      const earlier = evidence.find(item => item.entityId === 'achievement-3');
      const research = evidence.find(item => item.kind === 'research');
      const cited = (source, text) => ({ ...statement(source), text });
      value.cards[0] = { ...value.cards[0], ...introWording, thinEvidence: false,
        headline: cited(own, 'I led onboarding research at Aster Labs and reduced setup time by 25%.'),
        bullets: [{ stage: 'point', ...cited(earlier, 'I built a reporting dashboard at Birch Works for the support team.') },
          { stage: 'point', ...cited(research, 'This role interests me because Cedar serves research teams with a shared library.') }],
        example: cited(own, 'I reviewed onboarding feedback with staff about the setup guide.'),
        consistency: { consistentWithResume: false, resumeQuote: '' },
      };
      const bank = validateInterviewAnswerBank(value, context);
      assert(isInterviewAnswerBank(bank, context), 'a short arc may combine separately bound role and research evidence');
      const summary = structuredClone(value.cards[0]);
      summary.headline = { text: 'I worked as Product Manager at Aster Labs and Analyst at Birch Works.',
        evidenceIds: [own.id, earlier.id], quotes: [own, earlier].map(item => ({ evidenceId: item.id, quote: item.text })) };
      assert(!inspectInterviewAnswerCards([summary], context).failures.length, 'a multi-role employment summary may cite each exact paired role metadata item');
      summary.headline.text = 'I worked as Analyst at Birch Works and Product Manager at Aster Labs.';
      assert(inspectInterviewAnswerCards([summary], context).failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_INTRO_ORDER'),
        'intro order follows spoken employer/title order rather than the arbitrary order of citation IDs');
      const bad = structuredClone(value); bad.cards[0].headline.text = bad.cards[0].headline.text.replace('Aster Labs', 'Birch Works');
      rejects(bad, context, 'one citation cannot borrow another role employer');
      const reversed = structuredClone(value);
      reversed.cards[0].headline = cited(earlier, 'I built a reporting dashboard at Birch Works for the support team.');
      reversed.cards[0].bullets[0] = { stage: 'point', ...cited(own, 'I created a setup research guide for the onboarding project.') };
      assert(rejects(reversed, context, 'intro chronology').correctionRuleIds.includes('INTERVIEW_ANSWER_INTRO_ORDER'), 'last role precedes earlier roles when dates are documented');
      // The introduction is the one required card; a project walkthrough is not.
      const noProject = structuredClone(value); noProject.cards = noProject.cards.filter(card => card.question !== 'Walk me through a piece of work you are proud of.');
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(noProject, context), context), 'a set without a project walkthrough still seals');
      const noIntro = structuredClone(value); noIntro.cards[0].kind = 'other';
      noIntro.cards[0].set = 'posting';
      assert(rejects(noIntro, context, 'introduction is mandatory').correctionRuleIds.includes('INTERVIEW_ANSWER_INTRO_REQUIRED'), 'the introduction is enforced at sealing');
      let error; try { validateInterviewAnswerDraft(noIntro); } catch (caught) { error = caught; }
      assert(error?.correctionRuleIds.includes('INTERVIEW_ANSWER_INTRO_REQUIRED'), 'initial generation cannot omit the introduction');
    },
  },
  {
    name: 'interview answer bank: captured résumé sentences match wrapped PDF lines and flattened later sentences',
    run: () => {
      const evidence = [{ id: 'career-resume', text: 'I built Python data integrations and maintained scheduled jobs. I also tested the data pipelines.' }];
      const spoken = [{ text: 'I built Python data integrations and maintained scheduled jobs.', evidenceIds: ['career-resume'] }];
      const quote = 'Built Python data integrations and maintained scheduled jobs.';
      const wrapped = 'Experience\n• Built Python data integrations and\n  maintained scheduled jobs.\n• Tested the data pipelines.';
      assert(resumeCoverage(quote, evidence, wrapped, true, spoken), 'whitespace wrapping must not prevent genuine complete-sentence résumé coverage');
      const flattened = 'Experience Software Engineer at Aster Labs. Built Python data integrations and maintained scheduled jobs. Tested the data pipelines.';
      assert(resumeCoverage(quote, evidence, flattened, true, spoken), 'a later sentence in a flattened capture must not need a line-start boundary');
      assert(!resumeCoverage('Python data integrations and maintained scheduled jobs.', evidence, wrapped, true, spoken), 'a sentence fragment cannot become a complete captured quote');
    },
  },
  {
    name: 'interview answer bank: résumé consistency covers spoken claims without requiring unused source details',
    run: () => {
      const evidence = [{ id: 'career-resume', text: 'I built Python data integrations and maintained scheduled jobs. I also tested the data pipelines.' }];
      const quote = 'Built Python data integrations and maintained scheduled jobs.';
      const claims = [{ text: 'I built Python data integrations and maintained scheduled jobs.', evidenceIds: ['career-resume'] }];
      assert(resumeCoverage(quote, evidence, quote, true, claims), 'unused evidence-note details need not be repeated in the résumé');
      claims.push({ text: 'I tested the data pipelines and maintained the scheduled jobs.', evidenceIds: ['career-resume'] });
      assert(!resumeCoverage(quote, evidence, quote, true, claims), 'every spoken career claim still needs captured résumé support');
      for (const prefix of ['Observed: ', 'Did not perform: ', 'Partially ', 'Shadowed but did not perform, e.g. ', '• Shadowed but did not perform,\n  ']) {
        assert(!resumeCoverage(quote, evidence, prefix + quote, true, claims.slice(0, 1)), 'a quote must not drop a preceding qualifier even across PDF line wraps');
      }
      const observed = `Observed: ${quote}`;
      assert(!resumeCoverage(observed, evidence, observed, true, claims.slice(0, 1)), 'including an observation qualifier in the quote cannot support candidate agency');
    },
  },
  {
    name: 'interview answer bank: sparse merge preserves passing cards and rejects missing, duplicate, extra or rebound repairs',
    run: () => {
      const context = contextFixture(); const value = responseFixture(context);
      const targets = [value.cards[0], value.cards[3]];
      const replacement = structuredClone(targets);
      replacement[0].thinEvidence = true;
      const merged = mergeInterviewAnswerCardRepair(value.cards, { cards: replacement.reverse() }, targets);
      assert(JSON.stringify(merged[0]) === JSON.stringify(replacement[1]) && JSON.stringify(merged[1]) === JSON.stringify(value.cards[1]), 'merge by bound identity without rewriting passing cards');
      for (const cards of [targets.slice(1), [targets[0], targets[0]], [...targets, value.cards[4]],
        [{ ...targets[0], kind: 'outcome' }, targets[1]], [{ ...targets[0], set: 'general' }, targets[1]], [{ ...targets[0], id: 'wrong' }, targets[1]]]) {
        let error; try { mergeInterviewAnswerCardRepair(value.cards, { cards }, targets); } catch (caught) { error = caught; }
        assert(error?.correctionDetails?.length, 'every incomplete, unexpected or rebound (ID, set or kind) sparse patch must reject');
      }
      // A rejected question has to be rewritable, so the repair may change its words.
      const reworded = [{ ...targets[0], question: 'What would you like us to understand about your research approach?' }, targets[1]];
      assert(mergeInterviewAnswerCardRepair(value.cards, { cards: reworded }, targets)[0].question === reworded[0].question, 'a repair may rewrite its card question');
      const taken = mergeInterviewAnswerCardRepair(value.cards, { cards: [{ ...targets[0], question: value.cards[2].question }, targets[1]] }, targets);
      assert(inspectInterviewAnswerCards(taken, context, { lockedIds: new Set(value.cards.slice(1).map(card => card.id)) }).failures
        .some(issue => issue.rule === 'INTERVIEW_ANSWER_QUESTION' && issue.cardIndex === 0), 'a rewritten question that repeats another card is caught by inspection, on the repaired card');
      const duplicateQuestion = structuredClone(value); duplicateQuestion.cards[1].question = duplicateQuestion.cards[0].question;
      let duplicateError; try { validateInterviewAnswerDraft(duplicateQuestion); } catch (error) { duplicateError = error; }
      assert(duplicateError?.correctionDetails?.some(line => line.includes(duplicateQuestion.cards[0].question)), 'duplicate initial question identities must reject before becoming impossible immutable repairs');
      const collision = structuredClone(value);
      collision.cards[0].bullets[0] = structuredClone(collision.cards[1].bullets[0]);
      const failures = inspectInterviewAnswerCards(collision.cards, context, { lockedIds: new Set(value.cards.slice(1).map(card => card.id)) }).failures;
      assert(failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_BULLET_DUPLICATE' && issue.cardIndex === 0)
        && !failures.some(issue => issue.cardIndex === 1), 'a repaired early card must not displace the later locked card on deduplication');
      const primaryConflict = structuredClone(value);
      [primaryConflict.cards[0].question, primaryConflict.cards[2].question] = [primaryConflict.cards[2].question, primaryConflict.cards[0].question];
      [primaryConflict.cards[0].variants, primaryConflict.cards[2].variants] = [primaryConflict.cards[2].variants, primaryConflict.cards[0].variants];
      primaryConflict.cards[0].headline = structuredClone(primaryConflict.cards[1].headline);
      primaryConflict.cards[0].thinEvidence = true;
      const primaryIssues = inspectInterviewAnswerCards(primaryConflict.cards, context, { lockedIds: new Set(value.cards.slice(1).map(card => card.id)) }).failures;
      assert(!primaryIssues.some(issue => issue.rule === 'INTERVIEW_ANSWER_PRIMARY_REUSE'), 'evidence reuse is allowed even when unused alternatives exist');
      for (const field of ['evidenceIds', 'quotes']) {
        const malformed = structuredClone(value); malformed.cards[0].headline[field] = { invalid: true };
        assert(inspectInterviewAnswerCards(malformed.cards, context).failures.some(issue => issue.cardIndex === 0 && issue.rule === 'INTERVIEW_ANSWER_CITATION'), 'malformed nested fields must produce card repairs without crashing inspection');
      }
    },
  },
  {
    name: 'interview answer bank: citation, quote, stage and duplicate diagnostics name returned values and conflicts',
    run: () => {
      const context = contextFixture(); const value = responseFixture(context);
      const card = value.cards[0];
      card.headline.quotes[0].quote = 'My own wrong quotation.';
      card.bullets[0].stage = 'result';
      card.bullets[1].evidenceIds = ['career-' + '9'.repeat(64)];
      card.bullets[1].quotes = [{ evidenceId: card.bullets[1].evidenceIds[0], quote: 'My own other quotation.' }];
      let failures = inspectInterviewAnswerCards(value.cards, context).failures;
      assert(failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_QUOTE' && issue.instruction.includes('My own wrong quotation.'))
        && failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_STAGE' && issue.instruction.includes('"result"'))
        && failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_CITATION' && issue.instruction.includes('9'.repeat(64))), 'each binding or format error must expose the exact returned value to change');
      value.cards[0].bullets[0] = structuredClone(value.cards[1].bullets[0]);
      failures = inspectInterviewAnswerCards(value.cards, context).failures;
      assert(failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_BULLET_DUPLICATE' && issue.instruction.includes('cards[0].bullets[0]') && issue.instruction.includes('action')), 'a duplicate must identify the other claim path and repeated action');
    },
  },
  {
    name: 'interview answer bank: uncapped card diagnostics name all returned violations and repair prompts keep them scoped',
    run: () => {
      const context = contextFixture(); const value = responseFixture(context);
      value.cards.forEach(card => { card.headline.text += ' frobnicated 991 widgets.'; });
      const failures = inspectInterviewAnswerCards(value.cards, context).failures;
      assert(failures.length > 12 && new Set(failures.map(issue => issue.cardIndex)).size === 12, 'all failing cards remain visible beyond the generic 12-line correction cap');
      assert(failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_NEW_FACT' && issue.instruction.includes('frobnicated')), 'name the actual unsupported worker token');
      const selected = value.cards.slice(0, 1);
      const prompt = interviewAnswerRepairPrompt({ basePrompt: interviewAnswerBankPrompt({ ...context, evidence: buildInterviewAnswerEvidence(context) }), cards: selected,
        failures: failures.map(issue => ({ ...issue, cardId: value.cards[issue.cardIndex].id })) });
      const boundary = prompt.match(/<untrusted-interview-answer-failing-cards-[^>]+>\n([\s\S]*?)\n<\/untrusted-/u);
      const requested = JSON.parse(boundary[1]);
      assert(requested.length === 1 && requested[0].issues.every(issue => issue.path.startsWith('cards[0]'))
        && requested[0].issues.length === failures.filter(issue => issue.cardIndex === 0).length, 'each requested card receives every one of its own issues');
    },
  },
  {
    name: 'interview answer bank: eight-card degraded floor retains full binding and omission guards',
    run: () => {
      const context = contextFixture(); const value = responseFixture(context);
      const droppedQuestions = value.cards.slice(8).map(card => card.question);
      const bank = validateInterviewAnswerBank({ cards: value.cards.slice(0, 8) }, context, { droppedQuestions });
      assert(isInterviewAnswerBank(bank, context) && bank.cards.length === 8 && bank.droppedQuestions.length === 4, 'eight fully valid cards can seal with recorded omissions');
      rejects({ cards: value.cards.slice(0, 7) }, context, 'seven cards must never seal');
      for (const dropped of [[bank.cards[0].question], [droppedQuestions[0], droppedQuestions[0]], [7]]) {
        assert(!isInterviewAnswerBank({ ...bank, droppedQuestions: dropped }), 'omission metadata must be unique bounded text absent from the retained bank');
      }
      // The writer's own questions are the omissions now, so no catalog membership is asked of them.
      assert(isInterviewAnswerBank({ ...bank, droppedQuestions: ['A question that was written and dropped?'] }), 'an omitted question is any bounded text');
      assert(!isInterviewAnswerBank({ ...bank, inputs: { ...bank.inputs, careerSnapshotId: '9'.repeat(64) } }, context), 'degradation never relaxes the snapshot binding');
      // Cards dropped for failing a truth rule cannot also fail the writer for the split of its sets.
      const thinGeneral = responseFixture(context); const dropped = thinGeneral.cards.filter(card => [4, 5, 8].includes(Number(card.id.slice(5)) - 1));
      thinGeneral.cards = thinGeneral.cards.filter(card => !dropped.includes(card));
      assert(thinGeneral.cards.filter(card => card.set === 'general').length === 1, 'the survivors have one general card');
      assert(rejects(thinGeneral, context, 'no omissions recorded').correctionRuleIds.includes('INTERVIEW_ANSWER_SET_FLOOR'), 'a writer that returns a lopsided set is refused');
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(thinGeneral, context, { droppedQuestions: dropped.map(card => card.question) }), context), 'the survivors of dropped cards are sealed with their omissions recorded');
    },
  },
  {
    name: 'interview answer bank: selects stable complete approved evidence and keeps research separate',
    run: () => {
      const context = contextFixture();
      const evidence = buildInterviewAnswerEvidence(context);
      assert(evidence.length === 19 && JSON.stringify(evidence) === JSON.stringify(buildInterviewAnswerEvidence(context)), 'stable IDs should preserve complete career/research fields');
      const main = evidence.find(item => item.entityId === 'achievement-1');
      assert(main.sourceLabel.includes('Product Manager') && main.sourceLabel.includes('Aster Labs') && main.text === context.snapshot.profile.achievements[0].claim, 'source attribution and quote must stay exact');
      assert(evidence.find(item => item.entityType === 'research').sourceUrl === context.brief.companyFacts[0].sourceUrl, 'research should retain sealed quoted-source attribution');
      context.snapshot.profile.achievements.push({ id: 'large', roleId: 'role-1', claim: 'x'.repeat(6001), evidenceSegmentIds: ['segment-0001'] });
      context.snapshot.profile.achievements.push({ id: 'unknown-role', roleId: 'missing', claim: 'Built a system.', evidenceSegmentIds: ['segment-0001'] });
      assert(!buildInterviewAnswerEvidence(context).some(item => ['large', 'unknown-role'].includes(item.entityId)), 'oversized or unbound role fields cannot be truncated into purported evidence');
      const longFrontend = `I maintained React and TypeScript interfaces.\n${'The interface used a shared component library. '.repeat(18)}\nThe system was later retired.`;
      context.snapshot.profile.achievements.push({ id: 'long-frontend', roleId: 'role-1', claim: longFrontend, evidenceSegmentIds: ['segment-0001'] });
      const retained = buildInterviewAnswerEvidence(context).find(item => item.entityId === 'long-frontend');
      assert(retained?.text === longFrontend && retained.candorFlags.includes('retired'), 'long multiline role-relevant sources retain their entire text and trailing candor qualifiers');
      const oversized = contextFixture(); oversized.snapshot.profile.achievements = Array.from({ length: 700 }, (_, index) => ({
        id: `achievement-large-${index}`, roleId: 'role-1', claim: `Led project ${index}. ${'x'.repeat(600)}`, evidenceSegmentIds: ['segment-0001'],
      }));
      let refusedOversized = false;
      try { buildInterviewAnswerEvidence(oversized); } catch (error) { refusedOversized = error.message.includes('too large'); }
      assert(refusedOversized, 'a large projection must fail completely rather than arbitrarily omit late job-relevant evidence');
      const bank = validateInterviewAnswerBank(responseFixture(context), context);
      assert(isInterviewAnswerBank(bank, context) && /^[a-f0-9]{64}$/u.test(answerBankRecordId(bank)), 'valid complete bank must content-address successfully');
      const usedIds = new Set(bank.cards.flatMap(card => [card.headline, ...card.bullets, card.example].flatMap(item => item.evidenceIds)));
      assert(bank.evidence.length === usedIds.size && bank.evidence.every(item => usedIds.has(item.id)) && !Object.hasOwn(context.brief, 'cards'), 'only used evidence enters separate answer bank; research brief stays candidate-free');
      return { evidence: evidence.length, cards: bank.cards.length };
    },
  },
  {
    name: 'interview answer bank: rejects uncited, misquoted, invented-number and wrong-employer claims with delta corrections',
    run: () => {
      const context = contextFixture();
      for (const mutate of [
        response => { response.cards[0].headline.evidenceIds = []; },
        response => { response.cards[0].bullets[0].quotes[0].quote += ' Extra outcome.'; },
        response => { response.cards[0].headline.text = response.cards[0].headline.text.replace('25%', '90%'); },
        response => { response.cards[0].headline.text = 'I led onboarding research at Birch Works.'; },
        response => { response.cards[0].bullets.push({ stage: 'result', text: 'The team saved $2 million.', evidenceIds: [], quotes: [] }); },
        response => { response.cards[0].headline.text = 'I was promoted after this work.'; },
        response => { response.cards[0].question = 'Why did you increase Imaginary revenue by 500% in 2026?'; },
        response => { response.cards[0].variants = ['How did you become the CEO of Birch Works?']; },
        response => { response.cards[0].variants = [response.cards[0].question]; },
        response => { response.cards[1].question = response.cards[0].question; },
        response => { response.cards[0].kind = 'invented'; },
        response => { delete response.cards[0].kind; },
        response => { response.cards[7].set = 'posting'; },
        response => { response.cards[0].bullets[0].stage = 'result'; },
        response => { response.cards[0].bullets[0] = { stage: 'point', ...response.cards[0].headline }; },
        response => { response.cards[0].bullets[0].text = 'They interviewed staff about the onboarding setup requirements.'; },
        response => { response.cards[0].example = structuredClone(response.cards[0].headline); },
        response => { response.cards[0].headline.text = 'I ' + 'led onboarding research '.repeat(10); },
      ]) {
        const response = responseFixture(context); mutate(response);
        rejects(response, context, 'every unsupported factual change must reject the whole response before durable acceptance');
      }
      const labeledContext = contextFixture(); labeledContext.snapshot.profile.achievements[0].claim = `Result: ${MAIN_CLAIM}`;
      labeledContext.bundle.applicationPositioning.resume = labeledContext.snapshot.profile.achievements[0].claim;
      const labeledResponse = responseFixture(labeledContext); labeledResponse.cards[0].bullets[0].stage = 'result';
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(labeledResponse, labeledContext)), 'explicit source-authored STAR prefixes permit an accurately labeled paraphrase');
      const unrelatedProject = buildInterviewAnswerEvidence(labeledContext).find(item => item.entityType === 'project');
      labeledResponse.cards[0].bullets[1] = { stage: 'point', ...statement(unrelatedProject) };
      labeledResponse.cards[0].consistency = { consistentWithResume: false, resumeQuote: '' };
      const relationRejection = rejects(labeledResponse, labeledContext, 'same-role evidence does not prove that separate stories have a causal action/result relationship');
      assert(relationRejection.correctionRuleIds.includes('INTERVIEW_ANSWER_STAR_RELATION'), 'STAR relationship check must specifically reject mixed entities');
      return { rejected: 17 };
    },
  },
  {
    name: 'interview answer bank: relevant evidence may repeat across questions while duplicate bullets reject',
    run: () => {
      const context = contextFixture();
      const reused = responseFixture(context);
      reused.cards[1].headline = structuredClone(reused.cards[0].headline);
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(reused, context)), 'reusing strong evidence across distinct questions is allowed');
      const duplicate = responseFixture(context);
      duplicate.cards[1].bullets[0] = structuredClone(duplicate.cards[0].bullets[0]);
      const bullet = rejects(duplicate, context, 'the same evidence and action cannot be a repeated spoken bullet across cards');
      assert(bullet.correctionRuleIds.some(rule => /DUPLICATE|DEDUP|REUSE/u.test(rule)), 'the cross-card bullet rule must identify repeated evidence and action');
    },
  },
  {
    name: 'interview answer bank: preserves attribution and permits independently cited facts from multiple roles',
    run: () => {
      const context = contextFixture(); const evidence = buildInterviewAnswerEvidence(context);
      const negative = evidence.find(item => item.entityId === 'achievement-2');
      const passive = evidence.find(item => item.entityId === 'achievement-passive');
      const research = evidence.find(item => item.kind === 'research');
      const anotherRole = evidence.find(item => item.entityId === 'achievement-3');
      const clipped = responseFixture(context);
      clipped.cards[0].headline = { text: 'improve conversion in 2024.', evidenceIds: [negative.id], quotes: [{ evidenceId: negative.id, quote: 'improve conversion in 2024.' }] };
      rejects(clipped, context, 'a matching substring cannot detach negation');
      const attributed = responseFixture(context); attributed.cards[0].headline = statement(passive, true);
      rejects(attributed, context, 'a passive description must not turn into candidate first-person leadership');
      for (const passiveText of ['Built in 2022 by external contractors.', 'Led By Another Team.', 'Led delivery through a manager; I observed the work.']) {
        const passiveContext = contextFixture(); passiveContext.snapshot.profile.achievements[0].claim = passiveText;
        passiveContext.bundle.applicationPositioning.resume = passiveText;
        const response = responseFixture(passiveContext); const source = buildInterviewAnswerEvidence(passiveContext).find(item => item.entityId === 'achievement-1');
        response.cards[0].headline = statement(source, true); response.cards[0].consistency = { consistentWithResume: false, resumeQuote: '' };
        const rejection = rejects(response, passiveContext, 'delayed, capitalized or qualified passive attribution cannot be inferred as a candidate action');
        assert(rejection.correctionRuleIds.some(rule => /ATTRIBUTION|CANDOR/u.test(rule)), 'the attribution rule itself must reject each attribution attack');
      }
      const firstPersonContext = contextFixture(); firstPersonContext.snapshot.profile.achievements[0].claim = `I ${MAIN_CLAIM[0].toLowerCase()}${MAIN_CLAIM.slice(1)}`;
      firstPersonContext.bundle.applicationPositioning.resume = firstPersonContext.snapshot.profile.achievements[0].claim;
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(responseFixture(firstPersonContext), firstPersonContext)), 'already-first-person approved evidence remains an exact permitted spoken answer');
      const cross = responseFixture(context); cross.cards[0].example = statement(anotherRole); cross.cards[0].consistency = { consistentWithResume: false, resumeQuote: '' };
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(cross, context)), 'separately cited independent facts from multiple employers may accompany an answer');
      const wrongExample = responseFixture(context); wrongExample.cards[0].example = statement(research);
      rejects(wrongExample, context, 'company research cannot be presented as candidate experience');
      const valid = responseFixture(context); valid.cards[0].bullets[1] = { stage: 'point', ...statement(research) };
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(valid, context)), 'a separate correctly cited third-person research point may accompany candidate proof');
      return { rejected: 7 };
    },
  },
  {
    name: 'interview answer bank: résumé annotation failures stay unverified without rejecting factual cards',
    run: () => {
      const context = contextFixture(); const response = responseFixture(context);
      response.cards[0].consistency.resumeQuote = 'A fabricated résumé line.';
      const recovered = validateInterviewAnswerBank(response, context);
      assert(recovered.cards[0].consistency.consistentWithResume
        && recovered.cards[0].consistency.resumeQuote !== response.cards[0].consistency.resumeQuote
        && resumeCoverage(recovered.cards[0].consistency.resumeQuote, recovered.evidence.filter(item => item.kind === 'career'), MAIN_CLAIM, true,
          [response.cards[0].headline, ...response.cards[0].bullets, response.cards[0].example]),
        'a worker annotation cannot replace the genuine complete captured résumé evidence');
      assert(response.cards[0].consistency.resumeQuote === 'A fabricated résumé line.', 'host normalization does not mutate the draft');
      const partial = responseFixture(context); partial.cards[0].consistency.resumeQuote = 'Led onboarding research';
      assert(validateInterviewAnswerBank(partial, context).cards[0].consistency.resumeQuote !== partial.cards[0].consistency.resumeQuote,
        'an incomplete worker quote is replaced by complete host-verified coverage');
      const letterOnly = responseFixture(context); context.bundle.applicationPositioning.coverLetter = context.bundle.applicationPositioning.resume; context.bundle.applicationPositioning.resume = 'Product Manager';
      const letterBank = validateInterviewAnswerBank(letterOnly, context);
      assert(letterBank.cards.length === letterOnly.cards.length && !letterBank.cards[0].consistency.consistentWithResume
        && letterBank.cards[0].consistency.resumeQuote === '', 'letter coverage cannot certify résumé consistency or drop an otherwise factual card');
      for (const annotation of [null, {}, { consistentWithResume: 'true', resumeQuote: MAIN_CLAIM },
        { consistentWithResume: false, resumeQuote: 'unsupported' }, { consistentWithResume: true, resumeQuote: 'x'.repeat(2401) }]) {
        const malformed = responseFixture(context); malformed.cards[0].consistency = annotation;
        assert(!inspectInterviewAnswerCards(malformed.cards, context).failures.some(issue => issue.rule.startsWith('INTERVIEW_ANSWER_RESUME_')),
          'malformed résumé annotations never become a card repair request');
        const bank = validateInterviewAnswerBank(malformed, context);
        assert(!bank.cards[0].consistency.consistentWithResume && bank.cards[0].consistency.resumeQuote === '',
          'failed annotations normalize to false and an empty quote');
      }
      const forged = structuredClone(letterBank); forged.cards[0].consistency = { consistentWithResume: true, resumeQuote: 'A fabricated résumé line.' };
      assert(!isInterviewAnswerBank(forged, context), 'an already-sealed bank cannot load a tampered true consistency flag');
      const unverified = responseFixture(context); unverified.cards.forEach(card => { card.consistency = { consistentWithResume: false, resumeQuote: '' }; });
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(unverified, context)), 'unverified wording is valid when labeled honestly and empty-quoted');
      for (const prefix of ['Never ', 'Partially ', 'Observed: ', 'Planned: ', 'Did not ']) {
        const qualified = prefix + MAIN_CLAIM;
        const qualifiedContext = contextFixture();
        qualifiedContext.bundle.applicationPositioning.resume = qualified;
        const qualifiedResponse = responseFixture(qualifiedContext);
        qualifiedResponse.cards.forEach(card => { card.consistency = { consistentWithResume: false, resumeQuote: '' }; });
        qualifiedResponse.cards[0].consistency = { consistentWithResume: true, resumeQuote: qualified };
        const bank = validateInterviewAnswerBank(qualifiedResponse, qualifiedContext);
        assert(bank.cards.length === qualifiedResponse.cards.length && !bank.cards[0].consistency.consistentWithResume
          && bank.cards[0].consistency.resumeQuote === '', 'qualified or negated résumé wording keeps the claim unverified without dropping it');
      }
      const splitContext = contextFixture(); const project = buildInterviewAnswerEvidence(splitContext).find(item => item.entityType === 'project');
      splitContext.bundle.applicationPositioning.resume += ` ${project.text}`;
      const splitResponse = responseFixture(splitContext); splitResponse.cards[0].bullets[1] = { stage: 'point', ...statement(project), text: `I ${project.text[0].toLowerCase()}${project.text.slice(1)}` };
      splitResponse.cards[0].consistency.resumeQuote = splitContext.bundle.applicationPositioning.resume;
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(splitResponse, splitContext)), 'several complete independently matching résumé sentences may support a point card');
      return { annotationFailuresDowngraded: 11 };
    },
  },
  {
    name: 'interview answer bank: normal résumé bullet supports exact claim coverage',
    run: () => {
      const context = contextFixture();
      const claim = context.snapshot.profile.achievements[0].claim;
      context.bundle.applicationPositioning.resume = `Product Manager\n• ${claim}\n• Built a reporting guide.`;
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(responseFixture(context), context)), 'a complete exact claim after a normal résumé bullet marker must remain covered');
      context.bundle.applicationPositioning.resume = `Experience:\n• Achievement: ${claim}`;
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(responseFixture(context), context)), 'a neutral structural label must not prevent exact bullet coverage');
      return { covered: true };
    },
  },
  ...[
    ['e.g.', 'Shadowed but did not perform, e.g. '],
    ['i.e.', 'Shadowed but did not perform, i.e. '],
    ['Dr.', 'Observed work attributed to Dr. '],
    ['colon-newline', 'Shadowed but did not perform:\n'],
    ['wrapped-bullet', '• Shadowed but did not perform,\n  '],
  ].map(([name, prefix]) => ({
    name: `interview answer bank: résumé ${name} qualifier cannot be omitted from consistency coverage`,
    run: () => {
      const context = contextFixture();
      const claim = context.snapshot.profile.achievements[0].claim;
      context.bundle.applicationPositioning.resume = `${prefix}${claim}`;
      const response = responseFixture(context);
      const bank = validateInterviewAnswerBank(response, context);
      assert(!bank.cards[0].consistency.consistentWithResume && bank.cards[0].consistency.resumeQuote === '',
        `${name}: a sentence boundary cannot discard the résumé qualifier before the quoted claim`);
      if (!prefix.includes('\n')) {
        response.cards.forEach(card => { card.consistency.resumeQuote = context.bundle.applicationPositioning.resume; });
        const fullQuoteBank = validateInterviewAnswerBank(response, context);
        assert(!fullQuoteBank.cards[0].consistency.consistentWithResume && fullQuoteBank.cards[0].consistency.resumeQuote === '',
          `${name}: complete-quote coverage must retain attribution and qualification`);
      }
      return { rejected: true };
    },
  })),
  {
    name: 'interview answer bank: binds snapshot, brief, bundle, job and current evidence attribution',
    run: () => {
      const context = contextFixture(); const bank = validateInterviewAnswerBank(responseFixture(context), context);
      for (const changes of [
        { snapshotId: '0'.repeat(64) }, { briefId: '0'.repeat(64) }, { bundleArtifactId: '0'.repeat(64) },
        { bundleArtifactDigest: '0'.repeat(64) }, { canonicalJobUrl: 'https://jobs.example.test/other' },
      ]) assert(!isInterviewAnswerBank(bank, changes), 'each changed immutable input must invalidate the bank');
      const changedSnapshot = structuredClone(context); changedSnapshot.snapshot.profile.roles[0].employer = 'Wrong Employer';
      assert(!isInterviewAnswerBank(bank, changedSnapshot), 'same opaque role IDs do not authorize a changed employer attribution');
      const changedText = structuredClone(context); changedText.snapshot.profile.achievements[0].claim += ' Changed.';
      assert(!isInterviewAnswerBank(bank, changedText), 'source quote changes invalidate even with an unchanged synthetic snapshot address');
      const changedBundle = structuredClone(context); changedBundle.bundle.digests.applicationHtml = '0'.repeat(64);
      assert(!isInterviewAnswerBank(bank, changedBundle), 'changed document hashes invalidate the frozen bank');
      const prompt = interviewAnswerBankPrompt({ ...context, evidence: buildInterviewAnswerEvidence(context) });
      assert(!prompt.includes(context.brief.createdAt) && prompt.includes(context.brief.briefId), 'prompt carries stable semantic binding and omits wall-clock preparation time');
      assert(prompt.includes('PARAPHRASE') && prompt.includes('captured résumé text') && prompt.includes('untrusted-interview-answer-approved-evidence-'), 'prompt must expose job/application context behind an untrusted boundary and explain the grounded claim grammar');
      return { invalidations: 8 };
    },
  },
  {
    name: 'interview answer bank: the writer is offered no catalog and no fixed wording, only sets, kinds and descriptions',
    run: () => {
      const context = contextFixture(); const evidence = buildInterviewAnswerEvidence(context);
      const prompt = interviewAnswerBankPrompt({ ...context, evidence });
      const card = responseFixture(context).cards[1];
      const repair = interviewAnswerRepairPrompt({ ...context, evidence, cards: [card], failures: [{ rule: 'INTERVIEW_ANSWER_QUESTION', path: 'cards[0].question', instruction: 'x', cardId: card.id }] });
      for (const entry of CATALOG) for (const wording of [entry.question, ...entry.variants]) {
        assert(!prompt.includes(wording) && !repair.includes(wording), `the earlier fixed question ${JSON.stringify(wording)} is never offered to the writer`);
      }
      assert(!/interests me because/iu.test(prompt) && !/interests me because/iu.test(repair), 'no opening for an interest line is quoted to the writer');
      for (const word of ['"posting"', '"general"', 'KINDS:', 'motivation', 'customer-need', 'exactly one intro card']) assert(prompt.includes(word), `the prompt names ${word}`);
      assert(!prompt.includes('HOST QUESTION CATALOG') && !repair.includes('repair-catalog'), 'the catalog blocks are gone from both prompts');
      assert(prompt.includes('Shape: a sentence cited to research only') && !prompt.includes('research: Sample Co builds alert tools'), 'the interest rule is described, not shown as a sentence to copy');
      const ranked = JSON.parse(/HOST RANKED SELECTION[^\n]*\n(.+)/u.exec(prompt)[1]);
      assert(ranked.every(item => typeof item.kind === 'string' && !('question' in item)) && !ranked.some(item => ['intro', 'motivation'].includes(item.kind)), 'evidence is ranked per kind of answer, not per question');
      assert(!/React|TypeScript|full-stack|ETL/u.test(prompt.split('HOST RANKED SELECTION')[0]), 'no technology or field is named as preferred evidence');
    },
  },
  {
    name: 'interview answer bank: schema asks for a set and a kind, and a repair keeps them while freeing the wording',
    run: () => {
      const schema = INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards.items;
      assert(schema.required.includes('set') && schema.required.includes('kind') && schema.properties.set.enum.join() === 'general,posting'
        && schema.properties.kind.enum.includes('intro') && schema.properties.kind.enum.includes('other'), 'every card says its set and its kind');
      assert(schema.properties.question.maxLength === 200 && schema.properties.variants.maxItems === 4, 'a question is one line; variants are at most four');
      const value = responseFixture(contextFixture());
      value.cards.forEach(card => { card.extensions = []; });
      const targets = [value.cards[0], value.cards[8]];
      const repair = interviewAnswerRepairSchema(targets);
      const item = repair.properties.cards.items.properties;
      assert(item.set.enum.join() === 'posting,general' && item.kind.enum.join() === 'other,disagreement' && !item.question.enum, 'a repair is bound to its cards\' set and kind, not to their words');
      assert(validateResponseSchema({ cards: [{ ...targets[0], question: 'A different way to ask the same thing?' }, targets[1]] }, repair).length === 0, 'a reworded question satisfies the repair schema');
    },
  },
  {
    name: 'interview answer bank: a question and its variants must be plain questions a stranger could ask, when a set is written',
    run: () => {
      const context = contextFixture();
      const bad = {
        'a figure the listing does not state': 'How did you cut setup time by 40 percent?',
        'an employer from the career text': 'What did you build at Birch Works?',
        'a sum of money': 'How did you save $2 million on onboarding?',
        'a second sentence': 'Tell me about onboarding. Then tell me about research.',
        'too short': 'Why?',
      };
      for (const [reason, question] of Object.entries(bad)) {
        const value = responseFixture(context); value.cards[1].question = question;
        assert(rejects(value, context, reason).correctionRuleIds.includes('INTERVIEW_ANSWER_QUESTION'), `a question with ${reason} is rejected`);
        const variant = responseFixture(context); variant.cards[1].variants = [question];
        assert(rejects(variant, context, reason).correctionRuleIds.includes('INTERVIEW_ANSWER_VARIANTS'), `a variant with ${reason} is rejected`);
      }
      const posting = responseFixture(context); posting.cards[1].question = 'How would you run discovery for the onboarding research team at Cedar?';
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(posting, context), context), 'a posting question may name what the brief names (the company)');
      const general = responseFixture(context); general.cards[4].question = 'How would you run discovery for the onboarding research team at Birch Works?';
      assert(rejects(general, context, 'a general question names nothing').correctionRuleIds.includes('INTERVIEW_ANSWER_QUESTION'), 'a question shared by every interview may not name an employer from the career text');
      const repairInfo = inspectInterviewAnswerCards(responseFixture(Object.assign(contextFixture(), {})).cards.map((card, index) => (index === 1 ? { ...card, question: bad['a figure the listing does not state'] } : card)), context)
        .failures.find(issue => issue.rule === 'INTERVIEW_ANSWER_QUESTION');
      assert(repairInfo && repairInfo.cardIndex === 1 && /40/u.test(repairInfo.instruction) && /stranger could ask/u.test(repairInfo.instruction), 'the rejection names the words and reaches the repair rounds as a card failure');
    },
  },
  {
    name: 'interview answer bank: a stored bank is never re-judged by the question rule or the set floors, only a written one is',
    run: async () => {
      const context = contextFixture();
      const bank = validateInterviewAnswerBank(responseFixture(context), context);
      assert(bank.cards.every(card => ['general', 'posting'].includes(card.set) && typeof card.kind === 'string'), 'a sealed card keeps its set and kind');
      // The listing is not stored with the bank: a figure that only the listing could license must still load.
      const stored = structuredClone(bank); stored.cards[1].question = 'How would you handle 40 onboarding sessions at once?';
      assert(isInterviewAnswerBank(stored) && isInterviewAnswerBank(stored, context), 'reload checks structure and truth, never the writer-time wording rule');
      const written = responseFixture(context); written.cards[1].question = stored.cards[1].question;
      rejects(written, context, 'the same wording is refused when a set is written');
      const lopsided = responseFixture(context);
      for (const card of lopsided.cards) if (card.set === 'posting' && card.kind !== 'motivation') card.set = 'general';
      assert(rejects(lopsided, context, 'two posting cards').correctionRuleIds.includes('INTERVIEW_ANSWER_SET_FLOOR'), 'a written set keeps at least three cards in each tab');
      let draftRules; try { validateInterviewAnswerDraft(lopsided, undefined, { requireExtensions: false }); } catch (error) { draftRules = error.correctionRuleIds; }
      assert(draftRules?.includes('INTERVIEW_ANSWER_SET_FLOOR'), 'the writer is told at the draft stage');
      const sealedLopsided = structuredClone(bank); sealedLopsided.cards.forEach(card => { if (card.set === 'posting' && card.kind !== 'motivation') card.set = 'general'; });
      assert(isInterviewAnswerBank(sealedLopsided), 'a stored bank with an uneven split reloads');
      const wrongIntro = structuredClone(bank); wrongIntro.cards[7].set = 'posting';
      assert(!isInterviewAnswerBank(wrongIntro), 'the introduction cannot move out of the General set, stored or written');
      const twoIntros = structuredClone(bank); twoIntros.cards[8].kind = 'intro';
      assert(!isInterviewAnswerBank(twoIntros), 'one introduction only');
      const half = structuredClone(bank); delete half.cards[3].set;
      assert(!isInterviewAnswerBank(half), 'a card says both its set and kind or neither');
    },
  },
  {
    name: 'interview answer bank: a bank sealed by an earlier version (catalog wording, no set or kind) still seals, reloads and keeps its rules',
    run: async () => {
      const context = contextFixture(); const legacy = legacyResponseFixture(context);
      const bank = validateInterviewAnswerBank(legacy, context);
      assert(isInterviewAnswerBank(bank, context) && bank.cards.every(card => !('set' in card) && !('kind' in card)), 'a legacy bank validates as written');
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-bank-legacy-'));
      try {
        const sealed = await publishInterviewAnswerBank({ bank, userDataPath: root });
        assert((await loadInterviewAnswerBank({ ...sealed, userDataPath: root, ...context }))?.cards.length === 12, 'a legacy sealed set reloads against its sources');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
      for (const [reason, mutate] of [
        ['a question outside the catalog', value => { value.cards[0].question = 'What did you do at Imaginary Corp?'; }],
        ['variants of another question', value => { value.cards[0].variants = [...CATALOG[1].variants]; }],
        ['a repeated question', value => { value.cards[1].question = value.cards[0].question; }],
      ]) {
        const value = legacyResponseFixture(context); mutate(value);
        rejects(value, context, reason);
      }
      const noIntro = legacyResponseFixture(context); noIntro.cards = noIntro.cards.filter(card => card.question !== CATALOG[0].question);
      assert(rejects(noIntro, context, 'legacy intro').correctionRuleIds.includes('INTERVIEW_ANSWER_INTRO_REQUIRED'), 'a legacy set still needs its introduction');
      const lopsided = legacyResponseFixture(context);
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(lopsided, context)), 'no set floors apply to a legacy-shaped set');
      // The legacy project walkthrough keeps its narrow-required form; kinds read through the legacy table.
      assert(cardKind(bank.cards[4]) === 'other' && cardKind(bank.cards[7]) === 'intro' && cardKind(bank.cards[2]) === 'motivation', 'a legacy card is read through the legacy table');
      const narrowProject = structuredClone(legacyResponseFixture(context).cards[4]);
      narrowProject.thinEvidence = true; narrowProject.bullets = [narrowProject.bullets[0]]; narrowProject.headline.text = narrowProject.bullets[0].text;
      assert(!inspectInterviewAnswerCards([narrowProject], context).failures.some(issue => issue.rule === 'INTERVIEW_ANSWER_BULLETS'), 'a narrowed legacy project card keeps loading');
    },
  },
  {
    name: 'interview answer bank: private atomic content-addressed persistence revalidates bindings and rejects tampering',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-bank-'));
      try {
        const context = contextFixture(); const bank = validateInterviewAnswerBank(responseFixture(context), context);
        const missing = await loadInterviewAnswerBank({ answerBankRecordId: answerBankRecordId(bank), userDataPath: root });
        assert(missing === null && !fs.existsSync(path.join(root, STORE)), 'a missing-bank read must not create private storage');
        const sealed = await publishInterviewAnswerBank({ bank, userDataPath: root });
        assert(sealed.cardCount === 12 && sealed.answerBankRecordId === answerBankRecordId(bank), 'published receipt should expose opaque address and count only');
        const file = path.join(root, STORE, `${sealed.answerBankRecordId}.json`);
        assert((fs.statSync(file).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(file)).mode & 0o777) === 0o700, 'bank directory and file must stay private');
        assert((await loadInterviewAnswerBank({ ...sealed, userDataPath: root, ...context }))?.cards.length === 12, 'sealed full bank should reload against verified authorities');
        assert(await loadInterviewAnswerBank({ ...sealed, userDataPath: root, ...context, canonicalJobUrl: 'https://jobs.example.test/wrong' }) === null, 'changed job cannot reuse a sealed bank');
        const tampered = JSON.parse(fs.readFileSync(file, 'utf8')); tampered.bank.cards[0].headline.text = 'I made $8 million.';
        fs.writeFileSync(file, JSON.stringify(tampered));
        assert(await loadInterviewAnswerBank({ ...sealed, userDataPath: root }) === null, 'tampered text must fail content-address and truth validation');
        await fs.promises.unlink(file);
        const elsewhere = path.join(root, 'elsewhere.json'); fs.writeFileSync(elsewhere, JSON.stringify({ version: 1, recordId: sealed.answerBankRecordId, bank }), { mode: 0o600 });
        await fs.promises.symlink(elsewhere, file);
        assert(await loadInterviewAnswerBank({ ...sealed, userDataPath: root }) === null, 'a symlinked bank must never authorize a live answer');
        return { cards: 12, private: true };
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer bank: rejects an in-place growing read and publication replacement',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'interview-answer-bank-race-'));
      const originalOpen = fs.promises.open; const originalLink = fs.promises.link;
      try {
        const context = contextFixture(); const bank = validateInterviewAnswerBank(responseFixture(context), context);
        const sealed = await publishInterviewAnswerBank({ bank, userDataPath: root });
        const file = path.join(await fs.promises.realpath(root), STORE, `${sealed.answerBankRecordId}.json`);
        let grew = false;
        fs.promises.open = async (name, ...args) => {
          const handle = await originalOpen(name, ...args);
          if (name === file && !grew) {
            const read = handle.read.bind(handle);
            handle.read = async (...readArgs) => {
              if (!grew) { grew = true; await fs.promises.appendFile(file, Buffer.alloc(1024 * 1024 + 1)); }
              return read(...readArgs);
            };
          }
          return handle;
        };
        assert(await loadInterviewAnswerBank({ ...sealed, userDataPath: root }) === null && grew, 'bounded reads must reject files that grow after their metadata check');
        fs.promises.open = originalOpen;
        await fs.promises.unlink(file);
        let replaced = false;
        fs.promises.link = async (...args) => {
          const result = await originalLink(...args);
          if (!replaced && args[1] === file) { replaced = true; await fs.promises.unlink(file); await fs.promises.writeFile(file, '{}', { mode: 0o600 }); }
          return result;
        };
        assert(await publishInterviewAnswerBank({ bank, userDataPath: root }).then(() => false, () => true) && replaced, 'publication must independently reopen and verify its just-linked artifact');
        return { bounded: true, replaced: true };
      } finally { fs.promises.open = originalOpen; fs.promises.link = originalLink; await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview answer bank: the declared kind is not free: "other" cannot carry a question that asks for a shape the host checks',
    run: () => {
      const context = contextFixture();
      const ask = (kind, question, variants) => {
        const value = responseFixture(context); value.cards[1].kind = kind; value.cards[1].question = question;
        if (variants) value.cards[1].variants = variants;
        return value;
      };
      const conflict = 'Tell me about a conflict with a coworker that you worked through.';
      const stuck = rejects(ask('other', conflict), context, 'kind other on a conflict question');
      assert(stuck.correctionRuleIds.includes('INTERVIEW_ANSWER_CARD_KIND') && /disagreement/u.test(JSON.stringify(stuck.correctionDetails)), 'a conflict question declared as other is refused and the answer says which shape it asks for');
      for (const [question, shape] of [['How do you prioritize competing demands on a team?', 'priority'], ['Which tradeoff did you weigh when you chose a tool?', 'decision'], ['How do you respond to feedback on your drafts?', 'feedback']]) {
        assert(/(?:INTERVIEW_ANSWER_CARD_KIND)/u.test(rejects(ask('other', question), context, shape).correctionRuleIds.join()), `${shape} wording on an "other" card is refused`);
      }
      // The same wording in a variant is no way around it.
      assert(rejects(ask('other', 'Which of your experiences fits this role best?', ['Describe a conflict you resolved.']), context, 'variant').correctionRuleIds.includes('INTERVIEW_ANSWER_CARD_KIND'), 'a variant that asks for a shape is read too');
      // Declaring the real kind removes the refusal (the kind's own answer-shape check then applies as before).
      let rules = []; try { validateInterviewAnswerBank(ask('disagreement', conflict), context); } catch (error) { rules = error.correctionRuleIds || []; }
      assert(!rules.includes('INTERVIEW_ANSWER_CARD_KIND'), 'declaring the kind the question asks for is not refused for its kind');
      // A plain "other" question is untouched, and a stored card is never re-judged by wording.
      assert(isInterviewAnswerBank(validateInterviewAnswerBank(responseFixture(context), context), context), 'ordinary other cards pass');
      const bank = validateInterviewAnswerBank(responseFixture(context), context);
      const stored = structuredClone(bank); stored.cards[1].question = conflict;
      assert(isInterviewAnswerBank(stored) && isInterviewAnswerBank(stored, context), 'a sealed card keeps the kind it was sealed with');
      const fresh = inspectInterviewAnswerCards(ask('other', conflict).cards, context).failures;
      assert(fresh.some(issue => issue.rule === 'INTERVIEW_ANSWER_CARD_KIND' && issue.cardIndex === 1), 'the sparse repair loop sees it as a card failure');
    },
  },
  {
    name: 'interview answer bank: Prepare asks for the tabs it writes: no general cards, floor or introduction when General is already saved, and the reverse',
    run: () => {
      const context = contextFixture(); const evidence = buildInterviewAnswerEvidence(context);
      const promptFor = sets => interviewAnswerBankPrompt({ ...context, bundle: { ...context.bundle, listingText: 'Product Manager at Cedar.' }, evidence, ...(sets ? { sets } : {}) });
      const both = promptFor(); const posting = promptFor(['posting']); const general = promptFor(['general']);
      assert(interviewAnswerSets(['general', 'posting']).join() === 'general,posting' && interviewAnswerSets(undefined).join() === 'general,posting' && interviewAnswerSets([]).join() === 'general,posting' && interviewAnswerSets(['nope']).join() === 'general,posting', 'with no tab named both are written');
      assert(both.includes('ALWAYS include exactly one intro card') && both.includes('at least 3 in each set') && both.includes('Prepare 12–20'), 'the full prompt is unchanged in what it asks for');
      assert(!posting.includes('ALWAYS include exactly one intro card') && posting.includes('Write no introduction') && posting.includes('write no general card') && posting.includes('Prepare 12–20')
        && !posting.includes('intro (asks the person to introduce themselves') && !posting.includes('at least 3 in each set'), 'a posting-only prompt asks for posting cards and no introduction');
      assert(general.includes('ALWAYS include exactly one intro card') && general.includes('write no posting card') && general.includes('Prepare 12–16')
        && !general.includes('motivation (asks why') && !general.includes('at least 3 in each set'), 'a general-only prompt asks for general cards, with the introduction, and no why card');
      assert(interviewAnswerBankSchema() === INTERVIEW_ANSWER_BANK_SCHEMA, 'both tabs use the unchanged schema');
      const postingSchema = interviewAnswerBankSchema(['posting']).properties.cards; const generalSchema = interviewAnswerBankSchema(['general']).properties.cards;
      assert(postingSchema.items.properties.set.enum.join() === 'posting' && postingSchema.minItems === 12 && postingSchema.maxItems === 20, 'the writer may only return posting cards');
      assert(generalSchema.items.properties.set.enum.join() === 'general' && generalSchema.minItems === 12 && generalSchema.maxItems === 16, 'the General tab alone is a shorter list');
      assert(interviewAnswerRepairSchema([{ id: 'card-1', set: 'posting', kind: 'other', question: 'x' }]).properties.cards.items.properties.set.enum.join() === 'posting', 'a repair keeps its card set');
      const rulesOf = (run) => { try { run(); return []; } catch (error) { return error.correctionRuleIds || [error.message]; } };
      const asPosting = value => ({ cards: value.cards.map(card => ({ ...card, set: 'posting', ...(card.kind === 'intro' ? { kind: 'other' } : {}) })) });
      const onlyPosting = asPosting(responseFixture(context));
      assert(rulesOf(() => validateInterviewAnswerDraft(onlyPosting, undefined, { sets: ['posting'] })).length === 0, 'twelve posting cards with no introduction are a complete draft when only the posting tab is written');
      const draftRules = rulesOf(() => validateInterviewAnswerDraft(onlyPosting, undefined, {}));
      assert(draftRules.includes('INTERVIEW_ANSWER_INTRO_REQUIRED') && draftRules.includes('INTERVIEW_ANSWER_SET_FLOOR'), 'with both tabs written the same draft misses its introduction and its general cards');
      assert(rulesOf(() => validateInterviewAnswerDraft(responseFixture(context), undefined, { sets: ['posting'] })).includes('INTERVIEW_ANSWER_CARD_KIND'), 'a general card in a posting-only draft is refused');
      const onlyGeneral = { cards: responseFixture(context).cards.map(card => ({ ...card, set: 'general', ...(card.kind === 'motivation' ? { kind: 'other' } : {}) })) };
      assert(rulesOf(() => validateInterviewAnswerDraft(onlyGeneral, undefined, { sets: ['general'] })).length === 0, 'twelve general cards, one of them the introduction, are a complete General draft');
      assert(rulesOf(() => validateInterviewAnswerDraft({ cards: onlyGeneral.cards.slice(0, 7) }, undefined, { sets: ['general'] })).includes('INTERVIEW_ANSWER_CARD_COUNT'), 'a General draft below its range is refused');
      assert(rulesOf(() => validateInterviewAnswerDraft({ cards: onlyGeneral.cards.filter(card => card.kind !== 'intro').concat(onlyGeneral.cards.slice(0, 1).map(card => ({ ...card, id: 'extra-card' }))) }, undefined, { sets: ['general'] })).includes('INTERVIEW_ANSWER_INTRO_REQUIRED'), 'the General tab keeps its introduction');
      // The host's own checks read the same sets.
      const floors = (cards, sets) => inspectInterviewAnswerCards(cards, context, { floors: true, sets }).failures.map(issue => issue.rule);
      assert(!floors(onlyPosting.cards, ['posting']).some(rule => /INTRO_REQUIRED|SET_FLOOR/u.test(rule)), 'no introduction and no general floor for a posting-only write');
      assert(floors(onlyPosting.cards, undefined).includes('INTERVIEW_ANSWER_INTRO_REQUIRED') && floors(onlyPosting.cards, undefined).includes('INTERVIEW_ANSWER_SET_FLOOR'), 'with no tab named the same cards fail both');
      assert(floors(responseFixture(context).cards, ['posting']).includes('INTERVIEW_ANSWER_CARD_KIND'), 'a general card among posting-only cards is a card failure');
      const bank = validateInterviewAnswerBank(onlyPosting, context, { sets: ['posting'] });
      assert(isInterviewAnswerBank(bank, context) && bank.cards.every(card => card.set === 'posting'), 'a posting-only answer set seals and reloads without an introduction');
      assert(rulesOf(() => validateInterviewAnswerBank(onlyPosting, context)).includes('INTERVIEW_ANSWER_INTRO_REQUIRED'), 'a bank for both tabs still needs its introduction');
      const noIntro = structuredClone(validateInterviewAnswerBank(responseFixture(context), context));
      noIntro.cards = noIntro.cards.filter(card => card.kind !== 'intro');
      assert(!isInterviewAnswerBank(noIntro), 'a stored bank that holds general cards still needs its introduction');
    },
  },
  {
    name: 'interview answer bank: every write asks for more cards than the floor, and a posting-only write is told the General questions already saved',
    run: () => {
      const context = contextFixture(); const evidence = buildInterviewAnswerEvidence(context);
      for (const sets of [['general'], ['posting'], ['general', 'posting']]) {
        const range = interviewAnswerBankSchema(sets).properties.cards;
        assert(range.minItems - INTERVIEW_ANSWER_MIN_CARDS >= 4, `${sets.join('+')} asks for at least four more than the sealed-set floor, so a few dropped cards never fail the Prepare`);
      }
      const saved = ['What do you do when priorities collide?', 'How do you like to receive feedback?'];
      const promptFor = (sets, savedGeneral) => interviewAnswerBankPrompt({ ...context, bundle: { ...context.bundle, listingText: 'Product Manager at Cedar.' }, evidence, sets, savedGeneral });
      const posting = promptFor(['posting'], saved);
      assert(posting.includes('do not repeat or reword any of them') && saved.every(question => posting.includes(question)), 'the saved General questions are given as data');
      assert(posting.includes('interview-answer-saved-general-questions'), 'and wrapped as untrusted data');
      assert(!promptFor(['posting']).includes('saved-general-questions') && !promptFor(['posting'], []).includes('do not repeat or reword'), 'nothing to avoid, nothing said');
      assert(!promptFor(['general'], saved).includes('saved-general-questions') && !promptFor(undefined, saved).includes('saved-general-questions'), 'a write that includes General has no saved General questions to avoid');
      assert(/takes no particular job, manager, team, employer or field for granted/u.test(posting) && /length of time/u.test(posting), 'the rules the General check applies are stated in the prompt');
    },
  },
];
