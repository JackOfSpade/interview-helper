import { assert } from './testHelpers.js';
import { interviewQuestionFit, interviewEvidenceRank } from '../../electron/ipc/interviewQuestionFit.js';

const career = (id, text) => ({ id, kind: 'career', text });
const fits = (kind, speech, evidence = speech) => interviewQuestionFit(kind, speech, [career('evidence', evidence)]);

export default [
  {
    name: 'interview question fit: a decimal effect counts as an effect',
    run() {
      assert(fits('outcome', 'I saved 1.5 hours per week.'), 'a decimal effect is an effect');
      assert(fits('process', 'I moved deploys from manual scripts to a CI pipeline, which I built.'), 'a real from/to change still fits');
    },
  },
  {
    name: 'interview question fit: v3 deliverables do not establish behavioral shape',
    run() {
      assert(!fits('collaboration', 'We co-built integrations with another engineer.'), 'co-built label has no contribution split');
      assert(!fits('collaboration', 'Some integrations I built solo, others we co-built with another engineer.'), 'mixed ownership alone does not say who did what');
      assert(!fits('outcome', 'I implemented an algorithm that shipped in the planning app.'), 'shipment alone is not a result');
      assert(!fits('outcome', 'We migrated data over three months.'), 'duration is not an outcome');
      assert(!fits('outcome', 'I improved the inherited ticketing system.'), 'vague improvement is a deliverable without an effect');
      assert(!fits('outcome', 'I improved the system to reduce errors.'), 'a purpose clause does not establish an achieved effect');
      assert(!fits('outcome', 'I planned a migration without downtime.'), 'a planned availability target is not an achieved effect');
      assert(!fits('outcome', 'I eliminated ongoing costs.', 'We migrated the system to eliminate ongoing costs.'), 'an intended cost reduction is not an achieved result');
      assert(!fits('priority', 'In personal projects I delegate implementation across models by cost and quality.'), 'model allocation does not establish competing work priorities');
      assert(!fits('process', 'I maintained daily cron jobs that sync external data.'), 'deliverable has no before/after change');
      assert(!fits('customer-need', 'I built separate dashboards for users and management.'), 'audience names do not establish discovery');
      assert(!fits('customer-need', 'I built a customer feedback and requests dashboard.'), 'discovery nouns need an actual discovery action');
      assert(!fits('collaboration', 'I built a feedback dashboard for the engineering team.'), 'feedback noun does not establish reciprocal work');
      assert(!fits('decision', 'I supported evaluation of products, comparing cost and tradeoffs.'), 'evaluation support does not establish an actual decision');
    },
  },
  {
    name: 'interview question fit: speech and evidence must both supply the asked shape',
    run() {
      assert(fits('collaboration', 'I implemented APIs while another engineer built the interface.'), 'documented contribution split fits collaboration');
      assert(fits('collaboration', 'We reviewed API changes together with product designers.'), 'reciprocal review method fits collaboration');
      assert(fits('outcome', 'Daily operations continued without interruption during the migration.'), 'documented operational outcome fits result');
      assert(fits('outcome', 'I reduced the error rate in data imports.'), 'a stated effect fits without inventing a metric');
      assert(fits('priority', 'I prioritized urgent tickets by customer impact and dependencies.'), 'work priority with criteria fits');
      assert(fits('process', 'I replaced manual imports with scheduled data integrations.'), 'documented change fits process');
      assert(fits('customer-need', 'I interviewed users about their requirements before implementing the workflow.'), 'documented discovery action fits customer needs');
      assert(!fits('customer-need', 'I interviewed users about their requirements.', 'I built dashboards for users.'), 'speech cannot manufacture shape absent in evidence');
      assert(!fits('customer-need', 'I built dashboards for users.', 'I interviewed users about their requirements and built dashboards.'), 'unspoken evidence cannot establish spoken answer shape');
      assert(interviewQuestionFit('motivation', 'I am drawn to how the role involves interfaces.', [{ kind: 'research', text: 'The role involves interfaces.' }]), 'a why card fits when it cites research, in whatever words');
      assert(!interviewQuestionFit('motivation', 'I am drawn to this role.', [career('evidence', 'I built interfaces.')]), 'a why card with no research citation does not fit');
      assert(interviewQuestionFit('other', 'Anything at all.', [career('evidence', 'Something else.')]) && interviewQuestionFit('intro', 'I worked as an engineer.', [career('evidence', 'Engineer.')]), 'a kind with no shape of its own always fits');
    },
  },
  {
    name: 'interview question fit: ranking comes from the role itself, with no bonus for a skill and no penalty for a field',
    run() {
      const evidence = [
        career('medical', 'Built medical ETL pipelines and dashboards for therapists.'),
        career('flight', 'Implemented flight route optimization with external data integrations.'),
        career('frontend', 'Maintained React and TypeScript interfaces and client-server integrations.'),
      ];
      // The listing names flight work: the flight evidence leads, whatever the skill.
      const flightRole = interviewEvidenceRank('other', evidence, ['Flight route planning'], 'Plan flight routes with external data feeds.');
      assert(flightRole[0].evidenceId === 'flight', 'overlap with the role selects the evidence');
      // The same words, a different role: the order follows the role, not a fixed taste.
      const reactRole = interviewEvidenceRank('other', evidence, ['React interfaces'], 'Maintain React and TypeScript interfaces.');
      assert(reactRole[0].evidenceId === 'frontend', 'a role that names React and TypeScript selects that evidence');
      const medicalRole = interviewEvidenceRank('other', evidence, ['Medical data pipelines for therapists'], 'Medical ETL pipelines');
      assert(medicalRole[0].evidenceId === 'medical', 'a medical role selects medical evidence');
      // No term earns a bonus or a penalty by itself: with a role that names none of them, nothing outranks anything.
      const unrelated = interviewEvidenceRank('other', evidence, ['Quarterly budget planning'], 'Plan budgets for finance teams.');
      assert(unrelated.every(item => item.roleScore === 0 && item.score === 40), 'no fixed bonus for React, TypeScript, integrations or data, and no penalty for medical or flight words');
      assert(unrelated.map(item => item.evidenceId).join() === 'flight,frontend,medical', 'ties fall back to a stable order');
      const withoutTerms = interviewEvidenceRank('other', [career('plain', 'Built React TypeScript full-stack product integrations with data and performance tooling.')], ['Gardening'], 'Gardening work.');
      assert(withoutTerms[0].roleScore === 0, 'listing and theme words are the only source of a role score');
      const problemRank = interviewEvidenceRank('problem', [
        career('frontend', 'Built React TypeScript full-stack product integrations with data and performance tooling.'),
        career('actual-problem', 'Fixed patient query errors by testing the data imports.'),
      ], ['React TypeScript full-stack product integrations data performance tooling']);
      assert(problemRank[0].evidenceId === 'actual-problem', 'actual question shape ranks before keyword overlap');
    },
  },
  {
    name: 'interview question fit: related word forms meet through a generic key, with no role vocabulary named',
    run() {
      const score = (text, theme) => interviewEvidenceRank('other', [career('a', text)], [theme], '')[0].roleScore;
      assert(score('Built integrations between billing systems.', 'Integrate billing systems') > 0, 'integrate and integrations share a key');
      assert(score('Improved performance of the ingest job.', 'Performing ingest jobs') > 0, 'performance and performing share a key');
      assert(score('Ran prototypes with customers.', 'Prototyping with customers') > 0, 'prototypes and prototyping share a key');
      assert(score('Ran experiments on onboarding.', 'Experimentation on onboarding') > 0, 'experiments and experimentation share a key');
      assert(score('Cooked dinner for friends.', 'Integrate billing systems') === 0, 'unrelated words do not');
    },
  },
  {
    name: 'interview question fit: cached ranking context follows a changed item text and a changed listing',
    run() {
      const item = career('a', 'Built React TypeScript interfaces.');
      const first = interviewEvidenceRank('other', [item], ['React'], 'React TypeScript role');
      const again = interviewEvidenceRank('outcome', [item], ['React'], 'React TypeScript role');
      assert(first[0].roleScore === again[0].roleScore && first[0].roleScore > 0, 'the same context scores the same item the same');
      item.text = 'Planned quarterly budgets.';
      const changed = interviewEvidenceRank('other', [item], ['React'], 'React TypeScript role');
      assert(changed[0].roleScore === 0, 'an edited item is scored from its new text');
      const other = interviewEvidenceRank('other', [item], ['Budgets'], 'budget planning role');
      assert(other[0].roleScore > 0, 'a different listing is not served from the previous context');
    },
  },
];
