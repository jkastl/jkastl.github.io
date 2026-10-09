/* Access policy: attribute-based rules, evaluated in order, first match wins.
 *
 * Rules are data with a test function, so the order is visible and each decision can cite the
 * rule that made it. The decision is one of:
 *   deny            never granted automatically
 *   owner_approval  restricted data: the dataset's named owner decides, and nobody else can
 *   approval        allowed, but only after a reviewer signs off (high-risk data)
 *   allow           granted automatically
 *
 * Restricted data skips the role check on purpose: whether this person should see it is
 * exactly the call the owner is there to make. The basics (an active account, the required
 * training) still apply first, so the owner only sees requests that could be granted.
 */
(function (AT) {
  'use strict';

  const missingTraining = (u, d) => (d.training || []).filter((t) => !(u.training || []).includes(t));
  const owner = (d) => d.owner && AT.data.people[d.owner];

  const RULES = [
    {
      id: 'R1-active-user', decision: 'deny', risk: 'medium',
      test: (u) => u.status !== 'active',
      reason: (u) => `${u.name}'s account isn't active yet (status: ${u.status}).`,
    },
    {
      id: 'R2-training', decision: 'deny', risk: 'medium',
      test: (u, d) => missingTraining(u, d).length > 0,
      reason: (u, d) => `Required training not complete: ${missingTraining(u, d).join(', ')}.`,
    },
    {
      // Fail closed: restricted data with nobody who can approve it is never granted. That covers
      // a missing owner, and an owner asking for their own access (they can't approve themselves).
      id: 'R3-restricted-no-approver', decision: 'deny', risk: 'high',
      test: (u, d) => d.classification === 'restricted' && (!owner(d) || owner(d).id === u.id),
      reason: (u, d) => !owner(d)
        ? `${d.name} is restricted and has no owner on record to approve access. The ${d.steward} has been notified.`
        : `${d.name} is restricted and you're its owner, so you can't approve your own access. The ${d.steward} reviews owner requests.`,
    },
    {
      id: 'R4-restricted-owner', decision: 'owner_approval', risk: 'high',
      test: (u, d) => d.classification === 'restricted',
      reason: (u, d) => `${d.name} is restricted. Only its owner, ${owner(d).name}, can approve access.`,
    },
    {
      id: 'R5-role', decision: 'deny', risk: 'medium',
      test: (u, d) => d.roles !== '*' && !d.roles.includes(u.role),
      reason: (u, d) => `The ${u.role.replace('_', ' ')} role isn't eligible for ${d.name} (${d.classification} data).`,
    },
    {
      id: 'R6-agreement-project', decision: 'deny', risk: 'high',
      test: (u, d) => (d.requires?.agreement && !(u.agreements || []).length) || (d.requires?.project && !(u.projects || []).length),
      reason: (u, d) => `${d.name} needs ${d.requires?.agreement && !(u.agreements || []).length ? 'a signed data use agreement' : 'an approved IRB project'} on file.`,
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
    const out = { decision: rule.decision, rule: rule.id, risk: rule.risk, reason: rule.reason(user, dataset) };
    if (rule.decision === 'owner_approval') {
      const o = owner(dataset);
      out.approver = { id: o.id, name: o.name, title: o.title };
    }
    return out;
  }

  AT.policy = { evaluate, RULES };
})(globalThis.AT = globalThis.AT || {});
