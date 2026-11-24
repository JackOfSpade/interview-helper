import { assert } from './testHelpers.js';
import { interviewInterestFailures, interviewInterestReason, interviewWhyCardFailures } from '../../electron/ipc/interviewInterest.js';
import { interviewQuestionFit } from '../../electron/ipc/interviewQuestionFit.js';

const career = (id, text) => ({ id, kind: 'career', text });
const research = (id, text) => ({ id, kind: 'research', text });
const RESEARCH = [research('r', 'Cedar serves research teams with a shared library of research tools and builds search infrastructure for 500 customers.')];
const line = (text, ...evidenceIds) => ({ text, evidenceIds });

export default [
  {
    name: 'interview interest: the opening earlier versions required still passes, and its reason is what remains for the claim guards',
    run() {
      for (const text of [
        'This role interests me because Cedar serves research teams with a shared library.',
        'This company interests me because its core product is free to use.',
        'This role interests me because of end-to-end delivery with Product and Design.',
      ]) assert(interviewInterestFailures(text, RESEARCH, { requireInterest: true }).length === 0, `${text} satisfies every rule`);
      assert(interviewInterestReason('This role interests me because Cedar serves research teams with a shared library.') === 'Cedar serves research teams with a shared library.',
        'the research reason is what remains for the claim guards');
      assert(interviewInterestReason('I am drawn to how Cedar serves subscription tools.') === 'Cedar serves subscription tools.',
        'when the whole line is spoken as "I", the words that are not interest wording are the reason');
      assert(interviewInterestReason('Cedar serves teams.') === 'Cedar serves teams.', 'with nothing to separate, the text is its own reason');
      assert(interviewInterestReason('I love it.') === 'I love it.', 'with no content word left, the text is its own reason');
      assert(interviewInterestFailures('I want this role because I have built apps.', RESEARCH).length > 0, 'a personal assertion fails');
    },
  },
  {
    name: 'interview interest: ordinary statements of interest pass, whatever they say they are interested in',
    run() {
      const facts = [research('r', 'Mercy Hospital is recognized as a Magnet organization for nursing excellence. The school emphasizes project-based learning and serves as a hub for science education. Acme builds payment software and its mission is that we put customers first. Cedar runs a mentorship program.')];
      for (const text of [
        'This role interests me because Mercy Hospital is recognized as a Magnet organization for nursing excellence.',
        "I'd love to work in a hospital recognized as a Magnet organization.", 'I admire Mercy as a leader in cardiac care.', "I'm drawn to Mercy's reputation as a leader in cardiac care.",
        "I'm a big fan of how Acme builds payment software.", "I'm a firm believer in mentorship.", 'I can see myself teaching here because the school emphasizes project-based science.',
        "I'd like to put my energy into a school that emphasizes project-based science.", "I'm looking for a role where I can teach science, because the school emphasizes it.",
        'I see a lot of promise in Acme because it builds payment software.', "I'm sold on the idea of project-based learning.", "I'm drawn to Acme because its mission is that we put customers first.",
        'What draws me to this school is its focus on project-based science teaching.', 'It is the Magnet-recognized cardiac unit that makes me want to work at Mercy Hospital.',
        'I care about mentorship, and Cedar runs a mentorship program.', 'I want to be a teacher at a school like this.',
        'I was always drawn to schools that emphasize project-based learning.', "I've always admired how Acme builds payment software.", "I'm a little curious about how Cedar runs a mentorship program.",
        'After reading about it, I am drawn to the way Cedar runs a mentorship program.', 'Having a mentorship program is what draws me to Cedar.',
      ]) assert(interviewInterestFailures(text, facts, { requireInterest: true }).length === 0, `passes: ${text} (${interviewInterestFailures(text, facts).join(' | ')})`);
      assert(interviewInterestFailures('Cedar runs a mentorship program.', facts).length === 0, 'a bare third-person research fact passes');
      assert(interviewInterestFailures('After leading the district for years, the school emphasizes project-based learning.', facts).length === 0, 'a research fact that happens to open "After ..." says nothing about the person');
      assert(interviewInterestFailures('Cedar serves the US market.', facts).length === 0, '"US" in capitals is a place, not a first-person word');
      assert(interviewInterestFailures('Cedar runs a mentorship program.', facts, { requireInterest: true }).length > 0, 'when interest must be stated, a bare fact is not enough');
    },
  },
  {
    name: 'interview interest: a past, a standing, an experience or a figure the research does not state is refused',
    run() {
      const facts = [research('r', 'Mercy Hospital is recognized as a Magnet organization for nursing excellence. Acme builds payment software. Cedar runs a mentorship program.')];
      const refused = [
        "Having worked in payments, I'm drawn to Acme because it builds payment software.", 'After leading teams for years, I\'m drawn to Cedar because of its mentorship program.',
        "As a nurse I'm drawn to Mercy because of its nursing excellence.", "As a nurse, I'm drawn to Mercy because of its nursing excellence.",
        "I'm drawn to Mercy because of its nursing excellence, as a nurse of ten years.", "I'm drawn to Acme because I am passionate about payments, having shipped three products.",
        'I have built payment systems and want to do it at Acme.', "I've led teams, which is why Acme appeals to me.", 'I led a mentorship program, so Cedar appeals to me.', 'I was a nurse at Mercy.',
        'We shipped payment software, so Acme appeals to me.', 'I spent years in payments and love that Acme builds payment software.', 'My experience in nursing makes Mercy a natural fit.',
        "I'm a senior engineer drawn to Acme.", 'I am a nurse, so Mercy appeals to me.', 'Coming from payments, I am drawn to Acme.', 'With my nursing background, Mercy appeals to me.',
        'Acme interests me because it serves 500 banks.', 'I am drawn to Cedar because I led a team of 12 engineers.',
      ];
      for (const text of refused) assert(interviewInterestFailures(text, facts).length > 0, `refused: ${text}`);
      assert(interviewInterestFailures('I am drawn to this role because Cedar serves research teams.', [career('c', 'Cedar research teams.')]).length > 0, 'a line citing career evidence is not a research-only statement');
      assert(interviewInterestFailures('I am drawn to this role because Cedar serves research teams.', []).length > 0, 'a line citing nothing fails');
      assert(interviewInterestFailures('Acme interests me because it serves 500 banks.', [research('r', 'Acme serves 500 banks.')]).length === 0, 'a figure the research states is allowed');
      assert(interviewInterestFailures('', facts).length > 0, 'an empty line fails');
      // What the check does not catch, by design: it does not read what a first-person clause claims beyond its shapes.
      assert(interviewInterestFailures("I'm good with people, which is why Acme appeals to me.", facts).length === 0, 'soft self-assessment passes');
    },
  },
  {
    name: 'interview interest: two differently worded headlines both pass the why card, and a claim behind an opening still fails',
    run() {
      const evidence = [
        career('career-web', 'Built a full-stack intranet portal for back-office utilities.'),
        career('career-api', 'Built APIs for controlled access to a records database.'),
        research('research-role', 'End-to-end delivery with Product and Design.'),
        research('research-company', 'Example Company keeps its core product free to use.'),
      ];
      const base = { kind: 'motivation', thinEvidence: false,
        bullets: [line('I built a full-stack intranet portal for back-office utilities.', 'career-web'), line('I built APIs for controlled access to a records database.', 'career-api')] };
      for (const headline of [
        line('This role interests me because of end-to-end delivery with Product and Design.', 'research-role'),
        line('I am drawn to end-to-end delivery with Product and Design.', 'research-role'),
        line('End-to-end delivery with Product and Design is what appeals to me here.', 'research-role'),
      ]) assert(interviewWhyCardFailures({ ...base, headline }, evidence).length === 0, `passes: ${headline.text}`);
      const company = { ...base, headline: line('Example Company keeps its core product free for everyone to use.', 'research-company') };
      assert(interviewWhyCardFailures(company, evidence).length === 0, 'a third-person researched fact can be the reason');
      const mixed = { ...base, headline: { ...line('I am drawn to its free core product.', 'research-company', 'career-web') } };
      assert(interviewWhyCardFailures(mixed, evidence).some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_RESEARCH'), 'mixed citations cannot smuggle candidate facts into the reason');
      const claim = { ...base, headline: line('This role interests me because I have led Product and Design.', 'research-role') };
      assert(interviewWhyCardFailures(claim, evidence).some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_REASON'), 'the same prefix carrying a candidate claim fails');
      const career_ = { ...base, headline: line('I built a full-stack intranet portal for the back-office utilities team.', 'career-web') };
      const failures = interviewWhyCardFailures(career_, evidence).map(item => item.rule);
      assert(failures.includes('INTERVIEW_ANSWER_WHY_HEADLINE_RESEARCH') && failures.includes('INTERVIEW_ANSWER_WHY_HEADLINE_REASON'), 'a career headline fails both rules');
      assert(interviewWhyCardFailures({ ...base, headline: line('I am drawn to this role.', 'research-role') }, evidence).length === 0, 'interest with no stated reason is not judged: the check does not read for a reason');
      assert(interviewWhyCardFailures({ ...base, bullets: [line('This role interests me because of delivery.', 'research-role')], headline: line('End-to-end delivery with Product and Design.', 'research-role') }, evidence)
        .some(item => item.rule === 'INTERVIEW_ANSWER_WHY_CAREER_CONNECTION'), 'the bullets after a reason are career facts');
    },
  },
  {
    name: 'interview interest: a why card is recognised by its kind, or by its legacy wording when it has none, never by free wording',
    run() {
      const evidence = [career('c', 'Built APIs.'), research('r', 'Cedar builds tools.')];
      const card = { question: 'What brings you here?', headline: line('I built APIs.', 'c'), bullets: [] };
      assert(interviewWhyCardFailures(card, evidence).length === 0, 'free wording with no kind is not a why card');
      assert(interviewWhyCardFailures({ ...card, kind: 'motivation', set: 'posting' }, evidence).length > 0, 'the writer\'s kind makes it one');
      assert(interviewWhyCardFailures({ ...card, question: 'Why are you interested in this company?' }, evidence).length > 0, 'a card saved with the old wording is still one');
    },
  },
  {
    name: 'interview interest: thin fallbacks keep their separately cited research bullet; malformed citations collect failures',
    run() {
      const evidence = [career('c', 'Built APIs.'), research('r', 'Cedar builds tools.')];
      const thin = { kind: 'motivation', set: 'posting', thinEvidence: true, headline: line('I built APIs.', 'c'), bullets: [line('Cedar builds tools.', 'r')] };
      assert(interviewWhyCardFailures(thin, evidence).length === 0, 'a thin why fallback may keep safe career speech plus a research reason bullet');
      const malformed = { kind: 'motivation', thinEvidence: false, headline: { text: 'I am drawn to this role.', evidenceIds: 'r' }, bullets: [{ evidenceIds: null }] };
      assert(interviewWhyCardFailures(malformed, evidence).some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_RESEARCH'), 'malformed citation fields collect failures');
      assert(interviewWhyCardFailures({ kind: 'motivation', headline: { text: 7, evidenceIds: ['r'] }, bullets: [] }, evidence).some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_REASON'), 'a non-string headline collects a reason failure');
      assert(interviewQuestionFit('motivation', 'I am drawn to this role.', [research('r', 'Cedar builds tools.')]), 'fit needs a research citation, not words');
    },
  },
  {
    name: 'interview interest: a saved why card whose research reason says "as a ..." still passes the why card rules',
    run() {
      const evidence = [career('c1', 'Built APIs for a records database.'), career('c2', 'Built a portal for utilities.'),
        research('r', 'Mercy Hospital is recognized as a Magnet organization for nursing excellence.')];
      const card = { kind: 'motivation', thinEvidence: false, headline: line('This role interests me because Mercy Hospital is recognized as a Magnet organization for nursing excellence.', 'r'),
        bullets: [line('I built APIs for a records database.', 'c1'), line('I built a portal for utilities.', 'c2')] };
      assert(interviewWhyCardFailures(card, evidence).length === 0, `an earlier sealed answer is not refused for its research reason (${JSON.stringify(interviewWhyCardFailures(card, evidence))})`);
    },
  },
];
