/* Story prompts: "tell me about a time..." practice for your own past work. Plain data, loaded by the page and the tests. */
(function () {
  'use strict';
  var list = (globalThis.TT_STORIES = globalThis.TT_STORIES || []);

  list.push({
    id: 'st-01',
    theme: 'Competing priorities',
    prompt: "Tell me about a time you were juggling several projects at once and they all wanted your attention. How did you decide what came first?",
    variants: [
      "Describe a week when two urgent requests collided. What did you do, and what did you drop?",
      "Walk me through how you keep several data projects moving when people each say theirs is the priority."
    ],
    listenFor: [
      "A concrete method for ranking work (impact, deadline, who is blocked), not just extra hours.",
      "Talking to the people affected early, with a clear message about what would slip.",
      "A real trade-off: something deliberately delayed or declined, and the reason.",
      "How the work was made visible (a shared list, an agreed order, a regular check-in).",
      "What happened afterward and what changed in how you plan."
    ],
    pitfalls: [
      "Claiming you did everything at once, which hides the decision.",
      "Describing the stress but not the criteria you used.",
      "Leaving out the people who were waiting and how you told them."
    ]
  });

  list.push({
    id: 'st-02',
    theme: 'Owning a pipeline failure',
    prompt: "Tell me about a time a data pipeline you were responsible for failed in production. Take me from the first sign of trouble through to the fix and what you changed afterward.",
    variants: [
      "Describe an incident where bad or missing data reached users. How did you find out, and what did you do in the first hour?",
      "Tell me about a failure that was partly your own mistake. How did you handle it?"
    ],
    listenFor: [
      "How it was detected, and honesty if users noticed before the team did.",
      "Clear ownership: you took charge of coordination, not just the code.",
      "Triage in order: stop the damage, tell affected people, restore, then find the root cause.",
      "A root cause explained plainly, with evidence rather than a guess.",
      "Durable fixes (a test, an alert, a runbook, a design change) and a blameless tone about people."
    ],
    pitfalls: [
      "Blaming another team or a vendor without saying what you controlled.",
      "Only describing the heroic fix, with no prevention.",
      "Skipping communication to the people who relied on the data."
    ]
  });

  list.push({
    id: 'st-03',
    theme: 'Explaining a trade-off to a non-technical stakeholder',
    prompt: "Tell me about a time you had to explain a technical trade-off to someone who was not technical, such as a lab manager or a clinician, so that they could make a decision.",
    variants: [
      "Describe how you explained why something could not be both fast and perfectly accurate (or cheap and complete) to a person who needed an answer.",
      "Tell me about a time you used a comparison, a picture or an example to make a technical choice clear."
    ],
    listenFor: [
      "Starting from what the other person cared about, not from the technology.",
      "Options laid out with their costs and risks in the listener's terms (time, money, errors, effort).",
      "A clear recommendation, not just a menu.",
      "Checking that they understood, and adjusting when they did not.",
      "The decision they made and how it turned out."
    ],
    pitfalls: [
      "Using jargon and then saying the stakeholder 'did not get it'.",
      "Presenting the decision as already made, so there was no real trade-off.",
      "Never saying what the outcome was."
    ]
  });

  list.push({
    id: 'st-04',
    theme: 'Working across teams',
    prompt: "Tell me about a time you worked across groups with different priorities, such as lab staff, researchers and IT or security, to get something delivered.",
    variants: [
      "Describe a project where you needed something from a team that did not report to you. How did you get it?",
      "Tell me about a time two groups wanted opposite things from the same data system. What did you do?"
    ],
    listenFor: [
      "Understanding each group's constraints and what they were measured on.",
      "Translating between groups instead of passing messages along.",
      "Building trust before asking for anything: small wins, being reliable, being on site or in their meetings.",
      "How conflicts were resolved: shared goals, a written agreement, or an escalation done respectfully.",
      "A shipped result and a relationship that was better afterward."
    ],
    pitfalls: [
      "Telling it as 'they were difficult' with no curiosity about why.",
      "Describing meetings rather than outcomes.",
      "Implying you won by going around someone."
    ]
  });

  list.push({
    id: 'st-05',
    theme: 'Disagreeing with a decision',
    prompt: "Tell me about a time you disagreed with a technical or priority decision. What did you do, and what happened?",
    variants: [
      "Describe a time you thought the team was heading toward a mistake. How did you raise it?",
      "Tell me about a decision you disagreed with but ended up supporting. How did you handle that?"
    ],
    listenFor: [
      "Raising the concern early, with data or a concrete example instead of opinion.",
      "Respect for the person making the call and for what they knew that you did not.",
      "Offering an alternative or a small experiment to settle it.",
      "Committing fully once a decision was made, or escalating appropriately if the risk was serious.",
      "Honesty about who turned out to be right, including when it was not you."
    ],
    pitfalls: [
      "A story where you were simply right and everyone else was not.",
      "Complaining after the decision instead of before it.",
      "No resolution: the story ends at the disagreement."
    ]
  });

  list.push({
    id: 'st-06',
    theme: 'Learning a technology fast',
    prompt: "Tell me about a time you had to learn a new technology quickly to deliver something. How did you get up to speed, and how did you know you were doing it right?",
    variants: [
      "Describe a time you inherited a system built with tools you did not know.",
      "Tell me about a tool you picked up under time pressure and what you got wrong along the way."
    ],
    listenFor: [
      "A deliberate learning plan: documentation first, a small prototype, an expert to ask, reading real code.",
      "Narrowing scope to what the task needed, not trying to learn everything.",
      "Ways of checking correctness: tests, comparing to known results, review by someone experienced.",
      "Mistakes named honestly, and what they taught you.",
      "Passing the knowledge on afterward (notes, a short walkthrough)."
    ],
    pitfalls: [
      "Saying you picked it up quickly with no account of how you did it.",
      "Describing a tutorial rather than delivering something real.",
      "Not mentioning how you verified the work."
    ]
  });

  list.push({
    id: 'st-07',
    theme: 'Improving data quality at the source',
    prompt: "Tell me about a time you found a recurring data quality problem and fixed it at its source instead of cleaning it up downstream.",
    variants: [
      "Describe a time you traced bad data back to a person, a form or a system upstream. What did you change?",
      "Tell me about a clean-up script you stopped writing because you fixed the cause."
    ],
    listenFor: [
      "How the problem was measured (counts, rates, examples), not just noticed.",
      "Tracing it to the root: the system, the process or the missing validation.",
      "Working with the owners of the source and explaining the benefit to them.",
      "A control that kept it fixed (validation, a contract, a test, an alert).",
      "Results shown as a number that improved."
    ],
    pitfalls: [
      "Only describing downstream clean-up logic.",
      "Treating upstream owners as the problem.",
      "No evidence that the quality actually improved."
    ]
  });

  list.push({
    id: 'st-08',
    theme: 'An unhappy stakeholder',
    prompt: "Tell me about a time someone who depended on your work was unhappy with it. How did you respond, and what was the result?",
    variants: [
      "Describe a time a user complained about a report, dashboard or data delivery. What did you do first?",
      "Tell me about a time you had to rebuild trust after a mistake or a missed date."
    ],
    listenFor: [
      "Listening before defending: asking what they were trying to do and what went wrong for them.",
      "Acknowledging the impact plainly, without excuses.",
      "A quick fix for the immediate pain and a lasting fix for the cause.",
      "Keeping the person informed until it was resolved.",
      "A changed relationship, such as a regular check-in or a better request process."
    ],
    pitfalls: [
      "Defending the work and explaining why the user was wrong.",
      "Fixing the symptom and never asking what they needed.",
      "Skipping what you learned about how to serve that group."
    ]
  });

  list.push({
    id: 'st-09',
    theme: 'Simplifying something',
    prompt: "Tell me about a time you simplified something that had become complicated, such as a pipeline, a process or a report. What did you remove, and how did you know it was safe?",
    variants: [
      "Describe a system you made easier to run or understand. What was the cost of the old complexity?",
      "Tell me about a time you deleted code, a step or a report and nobody missed it."
    ],
    listenFor: [
      "A clear description of the original complexity and who it hurt (time, errors, onboarding).",
      "Evidence that guided what to remove, such as usage data or tracing dependencies.",
      "A safe way to change it: tests, a parallel run, a staged rollout, a way to revert.",
      "Communication with people who might depend on the old way.",
      "A measurable benefit, such as fewer steps, shorter runtime or fewer incidents."
    ],
    pitfalls: [
      "Replacing a complicated thing with a different complicated thing.",
      "Removing something without checking who used it.",
      "No before and after comparison."
    ]
  });

  list.push({
    id: 'st-10',
    theme: 'A document that changed a decision',
    prompt: "Tell me about a time a written document you wrote, such as a design note, a proposal or a runbook, changed what your team decided or did.",
    variants: [
      "Describe a design write-up that you circulated for feedback. What changed because of it?",
      "Tell me about a time putting something in writing exposed a problem you had not seen."
    ],
    listenFor: [
      "A document aimed at a decision: the problem, options considered, the recommendation and the risks.",
      "Numbers or a small experiment in the write-up rather than only opinion.",
      "Inviting criticism, and a real change made in response to feedback.",
      "How the document was kept alive afterward, or why it was retired.",
      "A concrete decision that was different because the document existed."
    ],
    pitfalls: [
      "Describing documentation as an afterthought written once the work was done.",
      "A document nobody read or acted on.",
      "Not saying what the decision would have been without it."
    ]
  });

  list.push({
    id: 'st-11',
    theme: 'Attention to detail',
    prompt: "Tell me about a time your attention to detail caught an error that would have been costly if it had gone further.",
    variants: [
      "Describe a number that looked slightly wrong to you. What made you check it, and what did you find?",
      "Tell me about a mistake you caught in someone else's work, or your own, before it reached users."
    ],
    listenFor: [
      "What triggered the suspicion: a sanity check, a comparison, an unusual count, a gut feeling backed by a test.",
      "A systematic investigation instead of luck.",
      "The cost avoided, stated in concrete terms (money, rework, a wrong clinical or business decision).",
      "Raising it tactfully and fixing it without blame.",
      "A check added afterward so the next person does not depend on luck."
    ],
    pitfalls: [
      "Making it a story about being careful rather than a specific catch.",
      "Not being able to say what the error would have cost.",
      "Taking credit in a way that shames the person who made the error."
    ]
  });

  list.push({
    id: 'st-12',
    theme: 'Staying current and bringing in a new practice',
    prompt: "Tell me about a time you learned about a better practice or tool outside your team and brought it in. How did you keep up with it, and how did you get others on board?",
    variants: [
      "Describe a practice you introduced, such as automated tests, code review or a CI check. What resistance did you meet?",
      "Tell me how you stay current in data engineering, and about one thing you adopted because of it."
    ],
    listenFor: [
      "Specific sources of learning (conferences, papers, open source, peers), not a generic claim.",
      "Matching the new idea to a real problem the team had.",
      "A small pilot to show value before asking for a wider change.",
      "Handling skepticism with evidence and patience, and adapting the idea to the team.",
      "Lasting adoption: it was still in use months later."
    ],
    pitfalls: [
      "Adopting a tool because it was new, with no problem to solve.",
      "Pushing a practice on a team without understanding why they resisted.",
      "No sign it stuck."
    ]
  });

  list.push({
    id: 'st-13',
    theme: 'A project that slipped',
    prompt: "Tell me about a project that fell behind schedule. When did you realize, what did you do, and how did you handle the people waiting on it?",
    variants: [
      "Describe a delivery date you missed or nearly missed. What would you do differently now?",
      "Tell me about a time you had to cut scope to ship something. How did you decide what to cut?"
    ],
    listenFor: [
      "Noticing the slip early through evidence such as estimates, blockers or progress against milestones.",
      "Telling stakeholders promptly, with options rather than only bad news.",
      "A real recovery plan: reduce scope, add help, change the order or move the date.",
      "Honesty about causes, including your own estimating or planning errors.",
      "A lesson applied later, such as smaller milestones or earlier demos."
    ],
    pitfalls: [
      "Hiding the delay until the due date.",
      "Blaming changing requirements with no part for yourself.",
      "No lesson, or a lesson that is a slogan."
    ]
  });

  list.push({
    id: 'st-14',
    theme: 'Mentoring and raising the bar',
    prompt: "Tell me about a time you helped someone else get better at their work or raised the standard of how your team did something.",
    variants: [
      "Describe how you helped a newer teammate become independent. What did you do and what did you hold back from doing?",
      "Tell me about a time you improved a team habit, such as how code is reviewed, how data is checked or how incidents are discussed."
    ],
    listenFor: [
      "Adapting the help to the person: what they already knew and how they preferred to learn.",
      "Teaching through real work (pairing, review, small stretch tasks), not only explaining.",
      "Letting the other person struggle appropriately and make decisions.",
      "A change that outlasted your involvement, such as a checklist, a template or a norm.",
      "The other person's growth described in specific terms."
    ],
    pitfalls: [
      "A story where you did the work and called it help.",
      "Vague claims about 'sharing knowledge' with no example.",
      "Taking all of the credit for someone else's progress."
    ]
  });
})();
