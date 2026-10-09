/* Access policy: attribute-based rules, evaluated in order, first match wins.
 *
 * Rules are data with a test function, so the order is visible and each decision can cite the
 * rule that made it. The decision is one of:
 *   deny      never granted automatically
 *   approval  allowed, but only after a person signs off (high-risk data)
 *   allow     granted automatically
 */
(function (AT) {
  'use strict';

  const missingTraining = (u, d) => (d.training || []).filter((t) => !(u.training || []).includes(t));

  const RULES = [
    {
      id: 'R1-restricted', decision: 'deny', risk: 'high',
      test: (u, d) => d.classification === 'restricted',
      reason: (u, d) => `${d.name} is restricted. Automated grants are turned off; the ${d.steward} reviews these requests directly.`,
    },
    {
      id: 'R2-active-user', decision: 'deny', risk: 'medium',
      test: (u) => u.status !== 'active',
      reason: (u) => `${u.name}'s account isn't active yet (status: ${u.status}).`,
    },
    {
      id: 'R3-role', decision: 'deny', risk: 'medium',
      test: (u, d) => d.roles !== '*' && !d.roles.includes(u.role),
      reason: (u, d) => `The ${u.role.replace('_', ' ')} role isn't eligible for ${d.name} (${d.classification} data).`,
    },
    {
      id: 'R4-training', decision: 'deny', risk: 'medium',
      test: (u, d) => missingTraining(u, d).length > 0,
      reason: (u, d) => `Required training not complete: ${missingTraining(u, d).join(', ')}.`,
    },
    {
      id: 'R5-agreement', decision: 'deny', risk: 'high',
      test: (u, d) => d.requires?.agreement && !(u.agreements || []).length,
      reason: (u, d) => `${d.name} needs a signed data use agreement on file.`,
    },
    {
      id: 'R6-project', decision: 'deny', risk: 'high',
      test: (u, d) => d.requires?.project && !(u.projects || []).length,
      reason: (u, d) => `${d.name} needs an approved IRB project on file.`,
    },
    {
      id: 'R7-sensitive', decision: 'approval', risk: 'high',
      test: (u, d) => ['limited', 'identified'].includes(d.classification),
      reason: (u, d) => `Eligible, but ${d.classification} data needs a human sign-off before access is granted.`,
    },
    {
      id: 'R8-default-allow', decision: 'allow', risk: 'low',
      test: () => true,
      reason: (u, d) => `Role, training and classification (${d.classification}) all check out.`,
    },
  ];

  function evaluate(user, dataset) {
    if (!user) return { decision: 'deny', rule: 'R0-unknown', risk: 'medium', reason: 'Unknown requester.' };
    if (!dataset) return { decision: 'deny', rule: 'R0-unknown', risk: 'medium', reason: 'Unknown dataset.' };
    const rule = RULES.find((r) => r.test(user, dataset));
    return { decision: rule.decision, rule: rule.id, risk: rule.risk, reason: rule.reason(user, dataset) };
  }

  AT.policy = { evaluate, RULES };
})(globalThis.AT = globalThis.AT || {});
