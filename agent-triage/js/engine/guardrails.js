/* Guardrails: the checks that sit outside the agents and don't trust them.
 *
 *   redactPII        runs on the raw ticket before any agent (or model) sees it
 *   detectInjection  screens ticket text for attempts to override the agents' instructions
 *   writeGate        runs before every write tool, re-checking policy on its own
 *
 * In ADK terms these are callbacks: the first two a before_model_callback, the gate a
 * before_tool_callback that can refuse a call. They are deterministic code, not prompts, on
 * purpose: a guardrail that an LLM can be talked out of isn't one.
 */
(function (AT) {
  'use strict';

  // Order matters: SSN before phone, so 000-12-3456 isn't half-matched as a phone number.
  const PII = [
    { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
    { type: 'MRN', re: /\bMRN[\s:#-]*\d{6,10}\b/gi },
    { type: 'DOB', re: /\b(?:DOB|date of birth)[\s:]*\d{1,2}\/\d{1,2}\/\d{2,4}\b/gi },
    { type: 'EMAIL', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { type: 'PHONE', re: /(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g },
  ];

  function redactPII(text) {
    let out = String(text);
    const found = {};
    for (const { type, re } of PII) {
      out = out.replace(re, () => {
        found[type] = (found[type] || 0) + 1;
        return `[${type}]`;
      });
    }
    const count = Object.values(found).reduce((a, b) => a + b, 0);
    return { text: out, found, count };
  }

  // Weighted patterns. A strong signal alone blocks the request; weaker ones add up. Patterns
  // look for instruction-override language, not just scary words, so "please ignore my previous
  // ticket" or "I need admin approval" stays clean.
  const INJECTION = [
    { id: 'override-instructions', weight: 1, re: /\b(ignore|disregard|forget|override)\b[^.?!\n]{0,30}\b(previous|prior|above|earlier|all|your|the)\b[^.?!\n]{0,20}\b(instructions?|rules|prompts?|polic(y|ies)|guardrails?)\b/i },
    { id: 'reveal-system-prompt', weight: 1, re: /\b(reveal|print|show|repeat|output)\b[^.?!\n]{0,30}\bsystem prompt\b/i },
    { id: 'role-hijack', weight: 0.6, re: /\b(you are now|act as|pretend to be|from now on you)\b[^.?!\n]{0,30}\b(admin|administrator|root|superuser|unrestricted|developer)\b/i },
    { id: 'privilege-grab', weight: 0.6, re: /\bgrant\b[^.?!\n]{0,25}\b(admin|root|superuser|owner|full)\b[^.?!\n]{0,20}\b(access|rights|privileges|role)\b/i },
    { id: 'skip-approval', weight: 0.5, re: /\b(skip|bypass|without)\b[^.?!\n]{0,20}\b(approval|review|policy|checks?)\b/i },
    { id: 'hidden-text', weight: 0.5, re: /[​-‏⁠﻿]|<!--[\s\S]*?-->/ },
  ];
  const BLOCK_AT = 1;
  const FLAG_AT = 0.5;

  function detectInjection(text) {
    const hits = [];
    for (const p of INJECTION) {
      const m = String(text).match(p.re);
      if (m) hits.push({ rule: p.id, weight: p.weight, excerpt: m[0].slice(0, 80) });
    }
    const score = Math.round(hits.reduce((a, h) => a + h.weight, 0) * 100) / 100;
    const verdict = score >= BLOCK_AT ? 'block' : score >= FLAG_AT ? 'flag' : 'clean';
    return { verdict, score, hits };
  }

  /* The write gate. Agents call write tools through this, and it decides on its own evidence:
   * for an access grant it re-runs the policy engine rather than trusting the agent's reading of
   * check_policy. Returns { allow, needsApproval, risk, reason, checks }.
   */
  function writeGate({ tool, args, requester, suspect }) {
    const D = AT.data;
    const checks = [];
    let allow = true;
    let needsApproval = false;
    let risk = 'low';
    const fail = (msg) => { allow = false; checks.push({ check: msg, pass: false }); };
    const pass = (msg) => checks.push({ check: msg, pass: true });

    if (!requester || requester.status !== 'active') fail('requester is an active user');
    else pass('requester is an active user');

    if (tool === 'create_ticket' && args.type === 'access_grant') {
      const p = AT.policy.evaluate(D.people[args.user_id], D.datasets[args.dataset_id]);
      if (p.decision === 'deny') fail(`policy re-check (${p.rule})`);
      else pass(`policy re-check (${p.rule})`);
      if (p.decision === 'approval') needsApproval = true;
      risk = p.risk;
      if (args.access !== 'read') { fail('access level is read-only'); } else pass('access level is read-only');
      if (!(args.expires_in_days > 0 && args.expires_in_days <= 365)) fail('grant expires within a year');
      else pass('grant expires within a year');
    } else if (tool === 'provision_workspace') {
      const hire = D.people[args.user_id];
      if (hire && hire.manager === requester.id) pass("requester is the new hire's manager");
      else { needsApproval = true; risk = 'medium'; checks.push({ check: "requester is the new hire's manager", pass: false, note: 'needs approval' }); }
      const wide = (args.datasets || []).filter((id) => !['deidentified', 'internal'].includes(D.datasets[id]?.classification));
      if (wide.length) fail('starter datasets are de-identified or internal only');
      else pass('starter datasets are de-identified or internal only');
    } else if (tool === 'assign_training' || tool === 'escalate') {
      pass('low-risk write');
    } else {
      fail(`"${tool}" is not on the write allowlist`);
    }

    // Anything that looked a bit like an injection attempt never writes without a person.
    if (suspect) {
      needsApproval = true;
      risk = 'high';
      checks.push({ check: 'request text passed injection screening', pass: false, note: 'flagged; needs approval' });
    }

    const reason = !allow
      ? 'Blocked: ' + checks.filter((c) => !c.pass && !c.note).map((c) => c.check).join('; ') + ' failed.'
      : needsApproval ? 'Allowed only with human approval.' : 'All checks passed.';
    return { allow, needsApproval: allow && needsApproval, risk, reason, checks };
  }

  AT.guardrails = { redactPII, detectInjection, writeGate, PII_TYPES: PII.map((p) => p.type) };
})(globalThis.AT = globalThis.AT || {});
