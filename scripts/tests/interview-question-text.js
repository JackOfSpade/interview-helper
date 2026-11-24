import { assert } from './testHelpers.js';
import { interviewQuestionFailure, interviewQuestionContext, interviewQuestionCareerText } from '../../electron/ipc/interviewQuestionText.js';
import { INTERVIEW_LEGACY_QUESTION_CATALOG } from '../../src/utils/interviewAnswerQuestions.js';

const CAREER = 'Registered Nurse at Mercy Hospital. Skills: Patient Education, Leadership, Communication, Time Management. Defined KPIs and OKRs; partnered with HR; improved ROI of the CRM rollout; ran QA with the ER staff. Bachelor of Science in Education, Ohio State University. Built dashboards in PostgreSQL and Epic.';
const general = text => interviewQuestionFailure(text, { set: 'general', careerText: CAREER });
const RESEARCH = 'Product Manager at Cedar, a team that builds a shared library of research tools. 5+ years of experience with SQL and Figma.';
const posting = (text, careerText = '') => interviewQuestionFailure(text, { set: 'posting', researchText: RESEARCH, careerText });

// The check only catches a figure that could be a result, a name from the career text and a malformed
// shape. It does not read grammar, so a question that assumes a past ("Why did you leave the team?")
// passes; the writer's prompt asks for questions a stranger could ask.
export default [
  {
    name: 'interview question text: every question and variant of the earlier fixed list passes',
    run() {
      const failing = [];
      for (const item of INTERVIEW_LEGACY_QUESTION_CATALOG) for (const wording of [item.question, ...item.variants]) {
        if (interviewQuestionFailure(wording, { set: item.set })) failing.push(wording);
      }
      assert(failing.length === 0, `no catalog wording is refused: ${JSON.stringify(failing)}`);
    },
  },
  {
    name: 'interview question text: ordinary questions pass in the shared set, whatever the career text holds',
    run() {
      for (const question of [
        'How do you decide what to build first when you have limited resources?', 'Have you ever had to work with a difficult person, and how did you handle it?',
        'What is the hardest feedback you have ever received, and how did you respond?', 'Describe a time you received difficult feedback; how did you respond?',
        'What would you do if your team missed a deadline?', 'Describe your ideal manager and your ideal team.', 'How would your colleagues describe you?',
        'How do you choose which KPIs to track for a new team?', 'How do you work with HR when a team member is struggling?', 'What does good QA look like to you?',
        'Where do you see yourself in 3 to 5 years?', 'What are your top 3 strengths?', 'Why did you choose this career?', 'Tell me about a time you were wrong and what you learned.',
        'Walk me through your background and how you ended up here.', 'What did you enjoy most about your last job?', 'Tell me about a time you had to deliver difficult news to a family.',
        'What does good communication look like on a team?', 'How do you stay current in education?',
      ]) assert(general(question) === null, `passes: ${question} (${general(question)})`);
    },
  },
  {
    name: 'interview question text: a figure that could be a result, a name from the career text and a malformed question are refused',
    run() {
      for (const question of ['Why did you increase revenue by 40 percent?', 'How did you save $2 million?', 'Tell me about cutting costs for 250 customers.']) {
        assert(/figure/u.test(general(question)), `a result figure is refused: ${question}`);
      }
      for (const [question, name] of [['What did you build at Mercy Hospital?', 'Mercy'], ['How did you use Epic there?', 'Epic'], ['How do you tune PostgreSQL?', 'PostgreSQL'], ['how do you tune postgresql?', 'postgresql']]) {
        assert(general(question)?.includes(`names "${name}"`), `a name from the career text is refused: ${question} (${general(question)})`);
      }
      assert(/line break/u.test(general('Tell me about\nyourself please.')), 'one line only');
      assert(/characters/u.test(general('')) && /characters/u.test(general('Why?')) && /characters/u.test(general(`${'x'.repeat(201)}?`)), 'bounded length, empty included');
      assert(/more than one sentence/u.test(general('Tell me about onboarding. Then tell me about research.')), 'one question only');
      assert(/not text/u.test(interviewQuestionFailure(7)), 'a non-string is not a question');
      assert(/does not end/u.test(general('Tell me about yourself')), 'it ends as a sentence');
    },
  },
  {
    name: 'interview question text: a span of time, a count of ten or less and 1-on-1 are not result figures; any other figure is',
    run() {
      for (const question of [
        'What would your first ninety days look like as a sales lead for the enterprise segment?', 'What would your first 90 days look like in a new role?', 'Where do you want to be in 5 years?',
        'How would you plan a 90-day onboarding for a new hire?', 'How would you spend your first twenty five weeks?', 'What would you do in your first two quarters?',
        'What would your 12 to 18 month plan be?', 'Where do you see yourself in 3 to 5 years?', 'What should happen by month 3?', 'How do you run a good 1-on-1?',
        'What are your top 3 strengths?', 'How would you handle 2 urgent tasks at once?', 'Name three things you look for in a manager.',
      ]) assert(general(question) === null, `passes: ${question} (${general(question)})`);
      for (const question of [
        'How would you cut 40 percent of costs in 90 days?', 'How would you grow a team to fifty people?', 'How would you handle 25 projects at once?', 'How would you earn a million dollars in five years?',
        'How would you save 40% in a year?', 'How would you raise £5 for each team?', 'How would you handle 40k users?',
      ]) assert(/figure/u.test(general(question)), `another figure is refused: ${question} (${general(question)})`);
    },
  },
  {
    name: 'interview question text: a name is taken from the career text only by strong signals; plain capitals and initialisms are not names',
    run() {
      const career = 'Senior Engineer, Acme Bank\nBuilt services in C++ and S3 on the .NET stack with PostgreSQL. Led AWS and SaaS work.\nSkills: Terraform, Leadership.\nEDUCATION\nHistory';
      const shared = text => interviewQuestionFailure(text, { set: 'general', careerText: career });
      for (const [question, name] of [['How do you debug C++ builds?', 'C++'], ['How do you design for S3 failures?', 'S3'], ['How do you migrate .NET services?', '.NET'],
        ['How do you tune PostgreSQL queries?', 'PostgreSQL'], ['How do you tune postgresql queries?', 'postgresql'], ['How do you manage Terraform modules?', 'Terraform'], ['Why did Acme appeal to you?', 'Acme']]) {
        assert(shared(question)?.includes(`names "${name}"`), `${name} is a name: ${question} (${shared(question)})`);
      }
      for (const question of ['How do you design for AWS failures?', 'How do you keep up with SaaS trends?', 'How do you manage terraform modules?', 'What does leadership mean to you?',
        'How do you learn from Salesforce rollouts?', 'Tell me about a time you studied history.']) assert(shared(question) === null, `not a name: ${question} (${shared(question)})`);
      assert(interviewQuestionFailure('How do you tune PostgreSQL queries?', { set: 'general' }) === null, 'with no career text nothing is a name');
      assert(interviewQuestionCareerText([{ kind: 'career', text: 'a' }, { kind: 'research', text: 'b' }, { kind: 'career', text: 'c' }]) === 'a\nc' && interviewQuestionCareerText(null) === '', 'the career text is the career evidence only');
    },
  },
  {
    name: 'interview question text: a posting question may use what the listing and brief state, and the shared set gets no such grant',
    run() {
      const career = 'Built reports in Python at Birch Works, with SQL and 5+ projects.';
      assert(posting('How would you work with the team at Cedar to improve a shared research library?', career) === null, 'the company and role words from the brief are allowed');
      assert(posting('How do you use SQL and Figma together in a design review?', career) === null, 'tools the listing names are allowed');
      assert(/names "Python"/u.test(posting('How do you use Python to automate reports?', career)), 'a tool only the career text names is refused');
      assert(/names "Birch", "Works"/u.test(posting('How did Birch Works change how you plan?', career)), 'an employer from the career text is refused');
      assert(/figure "40"/u.test(posting('How would you run 40 interviews in a month?', career)), 'a figure the listing does not state is refused');
      assert(posting('Tell me about a time you worked with 40+ stakeholders on a research library.') !== null, 'a figure above ten is refused unless the listing states it');
      assert(interviewQuestionFailure('How would you manage a budget of 40+ projects?', { set: 'posting', researchText: '40+ projects' }) === null, 'a figure the listing states is allowed');
      assert(interviewQuestionFailure('How do you use SQL in a report?', { set: 'general', careerText: 'Wrote SQL reports in S3.' }) === null, 'SQL is an initialism, not a name');
      assert(general('How do you plan around the Cedar roadmap?') === null, 'the research text grants and refuses nothing in the shared set');
    },
  },
  {
    name: 'interview question text: the context a posting question may name is the brief role, themes, likely questions, facts and the listing',
    run() {
      const context = interviewQuestionContext({
        brief: { role: { title: 'Staff Engineer', company: 'Acme', location: 'Oslo', summary: 'Runs the ingest platform.' },
          roleThemes: ['Reliability'], likelyQuestions: ['Tell me about an outage.'],
          companyFacts: [{ fact: 'Acme ships weekly.' }], recentContext: [{ fact: 'Acme raised a round.' }] },
        bundle: { listingText: 'Experience with Kafka required.' },
      });
      for (const word of ['Staff Engineer', 'Acme', 'Oslo', 'ingest platform', 'Reliability', 'outage', 'ships weekly', 'raised a round', 'Kafka']) assert(context.researchText.includes(word), `${word} may be named`);
      assert(interviewQuestionContext({}).researchText === '', 'nothing known allows no name');
      assert(interviewQuestionFailure('How do you run Kafka consumers at Acme?', { set: 'posting', researchText: context.researchText, careerText: 'Ran Kafka at Acme.' }) === null, 'a posting question may name Kafka and Acme');
      assert(interviewQuestionFailure('How do you run Kafka consumers at Acme?', { set: 'general', researchText: context.researchText, careerText: 'Ran Kafka at Acme.' }) !== null, 'the shared set may not');
    },
  },
];
