import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import { interviewRequiredFallbackCandidates, interviewWhyFallbackCandidates } from '../../electron/ipc/interviewRequiredFallback.js';
import { buildInterviewAnswerEvidence, inspectInterviewAnswerCards,
  interviewAnswerBankApplicationDigest } from '../../electron/ipc/interviewAnswerBank.js';
import { INTERVIEW_LEGACY_QUESTION_CATALOG } from '../../src/utils/interviewAnswerQuestions.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function contextFixture(text = 'I built an internal reporting hub. I tested the reporting workflow.') {
  const bundle = { digests: { applicationHtml: 'b'.repeat(64) }, applicationPositioning: { resume: '', coverLetter: '' } };
  const snapshot = { snapshotId: 'a'.repeat(64), profile: {
    roles: [{ id: 'role-main', title: 'Software Engineer', employer: 'Sample Works', endDate: 'June 2025' }],
    achievements: [{ id: 'achievement-main', roleId: 'role-main', claim: text, evidenceSegmentIds: ['segment-0001'] }],
    projects: [], otherEvidence: [],
  } };
  const canonicalJobUrl = 'https://jobs.example.test/role'; const bundleArtifactId = 'e'.repeat(64);
  const brief = { briefId: 'd'.repeat(64), inputs: { careerSnapshotId: snapshot.snapshotId, applicationArtifactId: bundleArtifactId,
    applicationArtifactDigest: interviewAnswerBankApplicationDigest(bundle), jobUrlSha256: sha(canonicalJobUrl) },
  role: { title: 'Engineer', company: 'Example Labs' }, roleThemes: [], companyFacts: [], recentContext: [] };
  return { snapshot, bundle, brief, canonicalJobUrl, bundleArtifactId };
}
function cardFixture(context, question = 'Walk me through a project.') {
  const source = buildInterviewAnswerEvidence(context).find(item => item.kind === 'career');
  const claim = text => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
  const catalog = INTERVIEW_LEGACY_QUESTION_CATALOG.find(item => item.question === question);
  return { id: 'required-answer', question, variants: [...catalog.variants], thinEvidence: false,
    headline: claim('I built 900 reporting hubs.'),
    bullets: [{ stage: 'point', ...claim('I tested the reporting workflow.') }],
    example: claim('I built 800 reporting hubs.'), consistency: { consistentWithResume: false, resumeQuote: '' } };
}

export default [
  {
    name: 'interview why fallback: a pooled reason must itself be a plain statement of interest or fact, and the card\'s own reason leads',
    run() {
      const context = contextFixture();
      context.brief.companyFacts = [{ sourceId: 'synthetic-research', sourceUrl: 'https://example.test/about',
        fact: 'Example Labs builds internal reporting tools for support teams.' }];
      const evidence = buildInterviewAnswerEvidence(context);
      const research = evidence.find(source => source.kind === 'research');
      const career = evidence.find(source => source.kind === 'career');
      const claim = (source, text) => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
      for (const shape of ['legacy', 'current']) {
        const card = cardFixture(context, 'Why are you interested in this role?');
        if (shape === 'current') Object.assign(card, { set: 'posting', kind: 'motivation', question: 'What draws you to this role?', variants: ['Why does this position appeal to you?'] });
        const connection = claim(career, 'I tested the reporting workflow.');
        card.bullets = []; card.example = connection;
        // A reason that speaks of the candidate's past, or as the company, is never pooled.
        const unsafe = [claim(research, `I built ${research.text}`), claim(research, `This role interests me because we build ${research.text}`)];
        assert(interviewWhyFallbackCandidates(card, context, [...unsafe, connection]).length === 0, `${shape}: a reason that fails the interest rule cannot answer the question`);
        const ownReason = claim(research, `I am drawn to this role because ${research.text}`);
        card.bullets = [{ stage: 'point', ...ownReason }];
        const candidates = interviewWhyFallbackCandidates(card, context, [...unsafe, connection, claim(research, research.text)]);
        assert(candidates.length && candidates[0].bullets[0].text === ownReason.text, `${shape}: the card's own safe research reason precedes a pooled third-person fact`);
        assert(candidates.every(candidate => inspectInterviewAnswerCards([candidate], context).failures.length === 0
          && candidate.question === card.question && JSON.stringify(candidate.variants) === JSON.stringify(card.variants)
          && (shape === 'legacy' ? !('kind' in candidate) : candidate.kind === 'motivation' && candidate.set === 'posting')),
        `${shape}: every candidate keeps the card's identity and passes every factual guard`);
      }
    },
  },
  {
    name: 'interview why fallback: both questions retain separately cited research without unsafe rejected headlines',
    run() {
      const context = contextFixture();
      context.brief.companyFacts = [{ sourceId: 'synthetic-research', sourceUrl: 'https://example.test/about',
        fact: 'Example Labs builds internal reporting tools for support teams.' }];
      const evidence = buildInterviewAnswerEvidence(context);
      const research = evidence.find(source => source.kind === 'research');
      const career = evidence.find(source => source.kind === 'career');
      const claim = (source, text) => ({ text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] });
      const cards = ['Why are you interested in this role?', 'Why are you interested in this company?'].map((question, index) => {
        const original = cardFixture(context, question); original.id = `why-${index}`;
        original.bullets = [{ stage: 'point', ...claim(research, research.text) }];
        original.example = claim(career, 'I tested the reporting workflow.');
        const candidates = interviewWhyFallbackCandidates(original, context);
        assert(candidates.length && candidates.every(card => !JSON.stringify(card).includes('900 reporting')), 'unsafe headline quantities cannot survive narrowing');
        return candidates[0];
      });
      assert(cards.every(card => card.thinEvidence && card.bullets.length === 1 && card.bullets[0].evidenceIds[0] === research.id),
        'each fallback keeps a separate research citation and explicit warning');
      assert(inspectInterviewAnswerCards(cards, context).failures.length === 0,
        'the same verified research reason may preserve both warned why questions');
    },
  },
  {
    name: 'interview required fallback: retains a narrower verified worker bullet without unsupported numbers',
    run() {
      const context = contextFixture(); const card = cardFixture(context);
      const candidates = interviewRequiredFallbackCandidates(card, context);
      assert(candidates.length > 0 && candidates.length <= 8, 'fallback candidates are bounded and available');
      assert(candidates[0].headline.text === card.bullets[0].text, 'prefer the worker claim that already passes all factual guards');
      for (const candidate of candidates) {
        assert(candidate.id === card.id && candidate.question === card.question, 'required identity remains bound');
        assert(candidate.thinEvidence && candidate.bullets.length === 0 && JSON.stringify(candidate.headline) === JSON.stringify(candidate.example), 'narrow candidate contains one claim and an explicit evidence warning');
        assert(!/\b(?:800|900)\b/u.test(candidate.headline.text), 'malicious unsupported quantities never survive narrowing');
        assert(inspectInterviewAnswerCards([candidate], context).failures.length === 0, 'every returned candidate passes the complete mechanical validator');
      }
      assert(card.bullets.length === 1 && !card.thinEvidence, 'candidate construction does not mutate the failed draft');
    },
  },
  {
    name: 'interview required fallback: intro employment metadata remains safe with inherited shared project evidence',
    run() {
      const context = contextFixture('Maintained the inherited reporting system with the other engineer. The system was later retired.');
      const card = cardFixture(context, 'Tell me about yourself.');
      const candidates = interviewRequiredFallbackCandidates(card, context);
      const summary = candidates.find(candidate => candidate.headline.text === 'I worked as Software Engineer at Sample Works.');
      assert(summary && summary.thinEvidence, 'verified employment metadata can preserve an intro without claiming project creation or solo agency');
      assert(candidates.every(candidate => inspectInterviewAnswerCards([candidate], context).failures.length === 0), 'metadata fallback does not bypass the bank validator');
      assert(!candidates.some(candidate => /\bI built\b/u.test(candidate.headline.text)), 'the inherited project cannot become original construction');
    },
  },
  {
    name: 'interview required fallback: project literal source fallback retains whole safe sentences and exact quotes',
    run() {
      const context = contextFixture('I built an internal reporting hub. I tested the reporting workflow.');
      const card = cardFixture(context); card.bullets = [];
      const candidates = interviewRequiredFallbackCandidates(card, context);
      assert(candidates.some(candidate => candidate.headline.text === 'I built an internal reporting hub.'), 'an exact complete source sentence can retain a required project');
      const source = buildInterviewAnswerEvidence(context)[0];
      assert(candidates.every(candidate => candidate.headline.quotes[0].quote === source.text), 'source sentence extraction preserves the complete quoted evidence separately');
      const unsafe = contextFixture('I built a reporting hub (inherited from another engineer). Tech used: ExampleDB.');
      assert(interviewRequiredFallbackCandidates(cardFixture(unsafe), unsafe).length === 0, 'a source note or inherited creation claim cannot be salvaged by dropping qualifiers');
    },
  },
  {
    name: 'interview required fallback: genuine captured résumé coverage survives narrowing and optional questions do not use fallback',
    run() {
      const context = contextFixture(); context.bundle.applicationPositioning.resume = 'Experience\u2029Software Engineer · Sample Works\u2029Tested the reporting workflow.';
      const candidates = interviewRequiredFallbackCandidates(cardFixture(context), context);
      assert(candidates[0].consistency.consistentWithResume && candidates[0].consistency.resumeQuote.includes('Tested the reporting workflow.'), 'host recovers genuine complete captured résumé support for the surviving claim');
      const optional = cardFixture(context, 'Describe a challenge you faced.');
      assert(interviewRequiredFallbackCandidates(optional, context).length === 0, 'optional questions never acquire the required-card format exception');
    },
  },
  {
    name: 'interview required fallback: a current intro keeps its set and kind, and a question that fails the question rule is replaced by a variant that passes',
    run() {
      const context = contextFixture();
      const card = cardFixture(context, 'Tell me about yourself.');
      Object.assign(card, { set: 'general', kind: 'intro', question: 'Which employers have you worked for in 2019?', variants: ['How did you save $2 million at work?', 'Can you give me a short introduction to your background?', 'Tell me about your journey.'] });
      const candidates = interviewRequiredFallbackCandidates(card, context);
      assert(candidates.length > 0 && candidates.every(candidate => candidate.kind === 'intro' && candidate.set === 'general'), 'the candidate carries the writer\'s set and kind');
      assert(candidates.every(candidate => candidate.question === 'Can you give me a short introduction to your background?'
        && JSON.stringify(candidate.variants) === JSON.stringify(['Tell me about your journey.'])), 'the first wording that passes becomes the question; wording that failed is not kept as a variant');
      assert(candidates.every(candidate => inspectInterviewAnswerCards([candidate], context).failures.length === 0), 'every candidate passes the validator, question rule included');
      const noneUsable = { ...card, question: 'How did you cut costs by 40 percent?', variants: ['How did you save $2 million at work?'] };
      assert(interviewRequiredFallbackCandidates(noneUsable, context).length === 0, 'with no wording that passes there is no fallback, and the required-answer failure applies');
      const other = { ...card, kind: 'other', set: 'posting' };
      assert(interviewRequiredFallbackCandidates(other, context).length === 0, 'only the introduction is required of a current card');
    },
  },
  {
    name: 'interview required fallback: a card with no set or kind keeps its catalog wording and its two required questions',
    run() {
      const context = contextFixture();
      for (const question of ['Tell me about yourself.', 'Walk me through a project.']) {
        const card = cardFixture(context, question);
        const candidates = interviewRequiredFallbackCandidates(card, context);
        assert(candidates.length > 0 && candidates.every(candidate => candidate.question === question && !('set' in candidate)
          && JSON.stringify(candidate.variants) === JSON.stringify(card.variants)), `${question} falls back with the words it was saved with`);
      }
    },
  },
];
