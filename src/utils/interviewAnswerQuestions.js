// The wording of the 24 questions earlier versions of Prepare wrote verbatim
// from a fixed list. The answer writer now writes its own questions for each
// role and is never shown this table. It is read only so data saved by earlier
// versions keeps its meaning: a saved answer set, saved Q&A or a question typed
// by hand in these exact words is still recognised as the kind of question it
// was (`kind`), whether it belongs to the General tab (`set: 'general'`) and
// whether it was one of the two answers every set had to hold (`required`).
const LEGACY = [
  ['Tell me about yourself.', ['Walk me through your background.', 'Can you introduce yourself?'], 'intro', 'general', true],
  ['Tell me about your relevant experience.', ['Which experience is most relevant to this role?', 'What experience would you bring?'], 'other', 'posting'],
  ['Why are you interested in this role?', ['What interests you about this position?', 'Why this role?'], 'motivation', 'posting'],
  ['Why are you interested in this company?', ['Why do you want to work here?', 'What interests you about our company?'], 'motivation', 'posting'],
  ['Walk me through a project.', ['Tell me about a project you worked on.', 'Describe a relevant project.'], 'other', 'general', true],
  ['Describe a challenge you faced.', ['Tell me about a challenging situation.', 'Describe a difficult problem.'], 'problem', 'general'],
  ['How do you prioritize your work?', ['How do you decide what to work on first?', 'Tell me about competing priorities.'], 'priority', 'posting'],
  ['How do you collaborate with others?', ['Tell me about working with stakeholders.', 'Describe your approach to teamwork.'], 'collaboration', 'general'],
  ['How do you handle disagreement?', ['Tell me about a conflict.', 'Describe a time you faced pushback.'], 'disagreement', 'general'],
  ['Describe your approach to leadership.', ['Tell me about leading a team.', 'How do you support other people?'], 'leadership', 'posting'],
  ['Walk me through a technical problem.', ['How do you approach technical challenges?', 'Tell me about a systems problem.'], 'problem', 'posting'],
  ['Tell me about improving a process.', ['Describe a process improvement.', 'How do you make work more effective?'], 'process', 'posting'],
  ['How do you work under pressure?', ['Tell me about a tight deadline.', 'How do you approach urgent work?'], 'problem', 'posting'],
  ['Walk me through a decision.', ['How do you make decisions?', 'Describe a tradeoff you considered.'], 'decision', 'posting'],
  ['Tell me about a result from your work.', ['What outcome can you describe?', 'Describe the impact of a project.'], 'outcome', 'posting'],
  ['Tell me about something you learned.', ['What did you learn from that experience?', 'How has your experience shaped your approach?'], 'learning', 'posting'],
  ['How do you understand customer needs?', ['Tell me about customer research.', 'How do you approach discovery?'], 'customer-need', 'posting'],
  ['What strengths would you bring?', ['What do you do well?', 'Which strengths are relevant to this role?'], 'other', 'general'],
  ['Tell me about something that did not go as planned.', ['Describe a setback.', 'Tell me about a mistake or failure.'], 'problem', 'general'],
  ['How do you adapt to change?', ['Tell me about a change in direction.', 'How do you handle changing requirements?'], 'change', 'posting'],
  ['How do you approach ambiguity?', ['Tell me about an unclear problem.', 'How do you get started without complete information?'], 'problem', 'posting'],
  ['How do you respond to feedback?', ['Tell me about receiving feedback.', 'How has feedback changed your work?'], 'feedback', 'posting'],
  ['How do you approach planning and delivery?', ['Tell me about bringing work to completion.', 'How do you organize delivery?'], 'delivery', 'posting'],
  ['What would you like us to know about your experience?', ['Is there another example you would like to discuss?', 'What else is relevant to this conversation?'], 'other', 'posting'],
];

export const INTERVIEW_LEGACY_QUESTION_CATALOG = Object.freeze(LEGACY.map(([question, variants, kind, set, required = false]) =>
  Object.freeze({ question, variants: Object.freeze(variants), kind, set, required })));
